/*
 * Same Room security, reliability and chat upgrade
 * Load this as a normal script AFTER the existing inline Same Room script:
 *   <script src="./sameroom-upgrade.js"></script>
 *
 * This file intentionally reuses Same Room's existing global functions and state.
 */
(() => {
  'use strict';

  if (typeof state === 'undefined' || typeof Peer === 'undefined' || typeof $ === 'undefined') {
    console.error('Same Room upgrade must load after the original Same Room script and PeerJS.');
    return;
  }

  const VERSION = 2;
  const ROOM_PREFIX = 'sameroom-v2-';
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const upgrade = {
    aesKey: null,
    hostId: '',
    myId: '',
    authorizedPeer: null,
    pendingCall: null,
    pendingConnections: new Set(),
    reconnectTimer: null,
    peerRestartTimer: null,
    reconnectAttempt: 0,
    peerRestartAttempt: 0,
    restartingPeer: false,
    connecting: false,
    healthTimer: null,
    playbackTimer: null,
    lastPong: 0,
    pingSentAt: 0,
    rtt: null,
    seenPackets: new Set(),
    seenOrder: [],
    outbox: [],
    sending: Promise.resolve(),
    intentionallyLeaving: false,
    chatOpen: false,
    unread: 0,
    typingTimer: null,
    remoteTypingTimer: null,
    pendingChats: new Map(),
    seenChatIds: new Set(),
    seenChatOrder: [],
    roomView: 'home',
    roomViewVersion: 1,
    roomViewSession: '',
    selectedGame: '',
    gameVersion: 0
  };

  const MAX_PACKET_BYTES = 64 * 1024;
  const MAX_CHAT_CHARS = 2000;
  const MAX_CHAT_MESSAGES = 250;
  const MAX_GAME_PAYLOAD_BYTES = 48 * 1024;
  const MAX_GAME_STRING_CHARS = 2000;
  const ROOM_VIEWS = new Set(['home', 'watch', 'games']);
  const GAME_MESSAGE_TYPES = new Set(['game-select', 'game-state', 'game-input', 'game-reset']);
  const RECONNECT_DELAYS = [1000, 1800, 3000, 5000, 8000, 12000];

  function bytesToBase64Url(bytes) {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBytes(value) {
    const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function randomId(length = 16) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytesToBase64Url(bytes);
  }

  function normalizeRoom(raw) {
    return String(raw || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
  }

  async function sha256(value) {
    return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
  }

  async function deriveSession(room, password) {
    const saltDigest = await sha256(`same-room:v2:salt:${room}`);
    const material = await crypto.subtle.importKey(
      'raw',
      encoder.encode(password),
      'PBKDF2',
      false,
      ['deriveBits']
    );
    const bits = new Uint8Array(await crypto.subtle.deriveBits({
      name: 'PBKDF2',
      salt: saltDigest.slice(0, 16),
      iterations: 180000,
      hash: 'SHA-256'
    }, material, 512));

    const aesBytes = bits.slice(0, 32);
    const idBytes = bits.slice(32, 64);
    const aesKey = await crypto.subtle.importKey('raw', aesBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
    const roomHash = await sha256(`same-room:v2:id:${room}:${bytesToBase64Url(idBytes)}`);
    return {
      aesKey,
      peerToken: bytesToBase64Url(roomHash).slice(0, 36)
    };
  }

  async function encryptMessage(message) {
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const packet = {
      v: VERSION,
      id: randomId(12),
      ts: Date.now(),
      body: message
    };
    const plaintext = encoder.encode(JSON.stringify(packet));
    const ciphertext = await crypto.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode('same-room-v2')
    }, upgrade.aesKey, plaintext);
    return {
      sr: VERSION,
      iv: bytesToBase64Url(iv),
      c: bytesToBase64Url(new Uint8Array(ciphertext))
    };
  }

  async function decryptMessage(envelope) {
    if (!envelope || envelope.sr !== VERSION || typeof envelope.iv !== 'string' || typeof envelope.c !== 'string') {
      throw new Error('Unsupported packet');
    }
    if (envelope.c.length > MAX_PACKET_BYTES * 2) throw new Error('Packet too large');
    const iv = base64UrlToBytes(envelope.iv);
    if (iv.byteLength !== 12) throw new Error('Invalid IV');
    const plaintext = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv,
      additionalData: encoder.encode('same-room-v2')
    }, upgrade.aesKey, base64UrlToBytes(envelope.c));
    if (plaintext.byteLength > MAX_PACKET_BYTES) throw new Error('Packet too large');
    const packet = JSON.parse(decoder.decode(plaintext));
    if (!packet || packet.v !== VERSION || typeof packet.id !== 'string' || !packet.body) throw new Error('Invalid packet');
    if (Math.abs(Date.now() - Number(packet.ts || 0)) > 30 * 60 * 1000) throw new Error('Expired packet');
    if (upgrade.seenPackets.has(packet.id)) throw new Error('Replay packet');
    upgrade.seenPackets.add(packet.id);
    upgrade.seenOrder.push(packet.id);
    while (upgrade.seenOrder.length > 600) upgrade.seenPackets.delete(upgrade.seenOrder.shift());
    return packet.body;
  }

  function safeNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function safeTimestamp(value, maxPastMs = 30 * 60 * 1000, maxFutureMs = 5 * 60 * 1000) {
    const now = Date.now();
    const timestamp = safeNumber(value, now);
    if (timestamp < now - maxPastMs || timestamp > now + maxFutureMs) return now;
    return timestamp;
  }

  function isSafeRemoteSource(value) {
    if (typeof value !== 'string' || value.length > 4096) return false;
    try {
      const url = new URL(value, window.location.href);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch (error) {
      return false;
    }
  }

  function safeVersion(value) {
    const version = Number(value);
    return Number.isSafeInteger(version) && version >= 0 && version <= 1000000000 ? version : null;
  }

  function safeProtocolToken(value, maxLength = 80, allowEmpty = false) {
    const token = String(value || '');
    if (token.length > maxLength) return null;
    if (!token && allowEmpty) return '';
    return /^[A-Za-z0-9_-]+$/.test(token) ? token : null;
  }

  function cloneSafeGamePayload(value, depth = 0, budget = { nodes: 0 }) {
    budget.nodes += 1;
    if (budget.nodes > 12000 || depth > 6) throw new Error('Game payload is too complex');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Invalid game number');
      return value;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_GAME_STRING_CHARS) throw new Error('Game string is too large');
      return value;
    }
    if (Array.isArray(value)) {
      if (value.length > 5000) throw new Error('Game array is too large');
      return value.map(item => cloneSafeGamePayload(item, depth + 1, budget));
    }
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error('Invalid game payload');
    }
    const entries = Object.entries(value);
    if (entries.length > 120) throw new Error('Game object has too many fields');
    const clean = {};
    for (const [rawKey, item] of entries) {
      const key = String(rawKey).slice(0, 60);
      if (!/^[A-Za-z0-9_-]+$/.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key)) {
        throw new Error('Invalid game field');
      }
      clean[key] = cloneSafeGamePayload(item, depth + 1, budget);
    }
    return clean;
  }

  function validatedGamePayload(value) {
    let clean;
    try {
      clean = cloneSafeGamePayload(value == null ? {} : value);
      if (encoder.encode(JSON.stringify(clean)).byteLength > MAX_GAME_PAYLOAD_BYTES) return null;
    } catch (error) {
      return null;
    }
    return clean;
  }

  function validateMessage(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
    const type = String(message.t || '');
    const allowed = new Set([
      'load', 'state', 'countin', 'hello', 'name', 'brb',
      'ping', 'pong', 'chat', 'chat-ack', 'chat-typing',
      'mode', 'game-select', 'game-state', 'game-input', 'game-reset'
    ]);
    if (!allowed.has(type)) return null;

    if (type === 'mode') {
      const mode = String(message.mode || '');
      const version = safeVersion(message.version);
      const session = safeProtocolToken(message.session, 80);
      const request = Boolean(message.request);
      const requestId = safeProtocolToken(message.requestId, 80, !request);
      if (!ROOM_VIEWS.has(mode) || version === null || !session || (request && !requestId)) return null;
      return { t: type, mode, version, session, request, requestId: requestId || '' };
    }

    if (type === 'game-select') {
      const game = safeProtocolToken(message.game, 50, true);
      const version = safeVersion(message.version);
      const session = safeProtocolToken(message.session, 80);
      const request = Boolean(message.request);
      const requestId = safeProtocolToken(message.requestId, 80, !request);
      if (game === null || version === null || !session || (request && !requestId)) return null;
      return { t: type, game, version, session, request, requestId: requestId || '' };
    }

    if (type === 'game-state' || type === 'game-input') {
      const game = safeProtocolToken(message.game, 50);
      const action = safeProtocolToken(message.action, 50);
      const roundId = safeProtocolToken(message.roundId, 80, true);
      const eventId = safeProtocolToken(message.eventId, 80);
      const version = safeVersion(message.version);
      const session = safeProtocolToken(message.session, 80);
      const payload = validatedGamePayload(message.payload);
      if (!game || !action || roundId === null || !eventId || version === null || !session || payload === null) return null;
      return { t: type, game, action, roundId, eventId, version, session, payload };
    }

    if (type === 'game-reset') {
      const game = safeProtocolToken(message.game, 50);
      const resetId = safeProtocolToken(message.resetId, 80);
      const version = safeVersion(message.version);
      const session = safeProtocolToken(message.session, 80);
      if (!game || !resetId || version === null || !session) return null;
      return { t: type, game, resetId, version, session };
    }

    if (type === 'chat') {
      const text = String(message.text || '').replace(/\r\n?/g, '\n').trim().slice(0, MAX_CHAT_CHARS);
      if (!text) return null;
      return {
        t: 'chat',
        id: String(message.id || '').slice(0, 80),
        text,
        sentAt: safeTimestamp(message.sentAt, 7 * 24 * 60 * 60 * 1000, 5 * 60 * 1000),
        sender: sanitizeName(message.sender)
      };
    }
    if (type === 'chat-ack') return { t: type, id: String(message.id || '').slice(0, 80) };
    if (type === 'chat-typing') return { t: type, on: Boolean(message.on) };
    if (type === 'ping' || type === 'pong') return { t: type, id: String(message.id || '').slice(0, 80), at: safeTimestamp(message.at, 60 * 1000, 60 * 1000) };
    if (type === 'name') return { t: type, name: sanitizeName(message.name) };
    if (type === 'hello') return { t: type, protocol: VERSION, name: sanitizeName(message.name) };
    if (type === 'brb') return { t: type, on: Boolean(message.on), name: sanitizeName(message.name) };
    if (type === 'countin') return { t: type };
    if (type === 'state') {
      return {
        ...message,
        t: type,
        time: Math.max(0, safeNumber(message.time, 0)),
        at: safeTimestamp(message.at, 60 * 1000, 60 * 1000),
        playing: Boolean(message.playing)
      };
    }
    if (type === 'load') {
      const kind = String(message.kind || '').toLowerCase();
      const allowedKinds = new Set(['youtube', 'vimeo', 'dailymotion', 'hls', 'file', 'unknown', 'localfile']);
      if (!allowedKinds.has(kind)) return null;

      const clone = { ...message, t: type, kind };
      if (typeof clone.src === 'string') {
        clone.src = clone.src.slice(0, 4096);
        if (['hls', 'file', 'unknown'].includes(kind) && !isSafeRemoteSource(clone.src)) return null;
      }
      if (typeof clone.id === 'string') clone.id = clone.id.slice(0, 128);
      if (kind === 'youtube' && !/^[A-Za-z0-9_-]{11}$/.test(String(clone.id || ''))) return null;
      if (kind === 'vimeo' && !/^\d{1,20}$/.test(String(clone.id || ''))) return null;
      if (kind === 'dailymotion' && !/^[A-Za-z0-9]+$/.test(String(clone.id || ''))) return null;
      if (typeof clone.hash === 'string') clone.hash = clone.hash.slice(0, 256);
      if (typeof clone.label === 'string') clone.label = clone.label.slice(0, 120);
      if (typeof clone.name === 'string') clone.name = clone.name.slice(0, 180);
      return clone;
    }
    return null;
  }

  function setConnectionStatus(text, mode = 'wait') {
    setStatus(text, mode);
  }

  function updateChatConnectionState() {
    const status = document.querySelector('#sr-chat-state');
    const sendButton = document.querySelector('#sr-chat-send');
    const connected = Boolean(state.conn && state.conn.open && upgrade.authorizedPeer);
    if (status) status.textContent = connected ? 'Private connection' : (navigator.onLine ? 'Reconnecting…' : 'Offline');
    if (sendButton) sendButton.disabled = false;
  }

  function queueAllowed(message) {
    return message && (message.t === 'chat' || message.t === 'name' || message.t === 'hello');
  }

  async function sendNow(message) {
    const conn = state.conn;
    if (!conn || !conn.open || !upgrade.aesKey) return false;
    const envelope = await encryptMessage(message);
    if (!state.conn || state.conn !== conn || !conn.open) return false;
    conn.send(envelope);
    return true;
  }

  function enqueueMessage(message) {
    if (!queueAllowed(message)) return;
    if (message.t === 'chat' && upgrade.outbox.some(item => item.t === 'chat' && item.id === message.id)) return;
    if (upgrade.outbox.length >= 100) upgrade.outbox.shift();
    upgrade.outbox.push(message);
  }

  function queueUndeliveredChats() {
    for (const message of upgrade.pendingChats.values()) enqueueMessage(message);
  }

  async function flushOutbox() {
    if (!state.conn || !state.conn.open) return;
    const pending = upgrade.outbox.splice(0);
    for (let index = 0; index < pending.length; index += 1) {
      const message = pending[index];
      try {
        const sent = await sendNow(message);
        if (!sent) {
          pending.slice(index).forEach(enqueueMessage);
          return;
        }
      } catch (error) {
        pending.slice(index).forEach(enqueueMessage);
        return;
      }
    }
  }

  // Replace Same Room's plain data-channel sender with authenticated encryption.
  send = function secureSend(message) {
    const valid = validateMessage(message);
    if (!valid) return;
    if (!state.conn || !state.conn.open) {
      enqueueMessage(valid);
      return;
    }
    upgrade.sending = upgrade.sending
      .then(() => sendNow(valid))
      .then(sent => { if (!sent) enqueueMessage(valid); })
      .catch(() => enqueueMessage(valid));
  };

  function connectedSecurely() {
    return Boolean(state.conn && state.conn.open && upgrade.authorizedPeer);
  }

  function setModeControlsEnabled(enabled) {
    ['#sr-choose-watch', '#sr-choose-games', '#sr-games-home', '#sr-watch-home'].forEach(selector => {
      const control = document.querySelector(selector);
      if (control) control.disabled = !enabled;
    });
    const status = document.querySelector('#sr-home-status');
    if (status) status.textContent = enabled
      ? 'You are connected. Choose together.'
      : (navigator.onLine ? 'Waiting for the secure connection.' : 'Offline. Reconnect to choose an activity.');
  }

  function applyRoomView(mode, version = upgrade.roomViewVersion) {
    if (!ROOM_VIEWS.has(mode)) return;
    upgrade.roomView = mode;
    upgrade.roomViewVersion = Math.max(upgrade.roomViewVersion, safeVersion(version) ?? 0);
    document.body.classList.remove('sr-mode-home', 'sr-mode-watch', 'sr-mode-games', 'controls-idle');
    document.body.classList.add(`sr-mode-${mode}`);
    if (mode !== 'watch') {
      if (state.fs) exitFullscreen();
      if (state.counting) {
        clearTimeout(state.countTimer);
        state.counting = false;
        hideCount();
      }
      if (state.brb.active) clearBrb(false);
      if (state.driver && player.playing()) player.pause();
    }
    const menu = document.querySelector('#more-menu');
    if (menu && menu.open) menu.close();
    const homeStatus = document.querySelector('#sr-home-status');
    if (homeStatus && connectedSecurely()) homeStatus.textContent = 'You are connected. Choose together.';
    window.dispatchEvent(new CustomEvent('same-room-mode-change', { detail: { mode, version: upgrade.roomViewVersion } }));
  }

  function sendCurrentRoomView() {
    if (!state.isHost || !connectedSecurely()) return;
    send({ t: 'mode', mode: upgrade.roomView, version: upgrade.roomViewVersion, session: upgrade.roomViewSession, request: false, requestId: '' });
    send({ t: 'game-select', game: upgrade.selectedGame, version: upgrade.gameVersion, session: upgrade.roomViewSession, request: false, requestId: '' });
  }

  function commitRoomView(mode) {
    if (!state.isHost || !ROOM_VIEWS.has(mode)) return;
    if (mode !== 'games' && upgrade.selectedGame) {
      upgrade.selectedGame = '';
      upgrade.gameVersion += 1;
      window.dispatchEvent(new CustomEvent('same-room-game-select', { detail: { game: '', version: upgrade.gameVersion } }));
    }
    upgrade.roomViewVersion += 1;
    applyRoomView(mode, upgrade.roomViewVersion);
    sendCurrentRoomView();
  }

  function requestRoomView(mode) {
    if (!ROOM_VIEWS.has(mode)) return;
    if (!connectedSecurely()) {
      toast('Reconnect before changing the activity.');
      return;
    }
    if (mode === 'home' && upgrade.selectedGame) {
      const leaveGame = window.confirm('Leave the current game and return home?');
      if (!leaveGame) return;
    }
    if (state.isHost) commitRoomView(mode);
    else send({
      t: 'mode', mode, version: upgrade.roomViewVersion, session: upgrade.roomViewSession, request: true, requestId: randomId(10)
    });
  }

  function handleModeMessage(message) {
    if (state.isHost) {
      if (message.request && message.session === upgrade.roomViewSession) commitRoomView(message.mode);
      return;
    }
    if (message.request) return;
    const newHostSession = message.session !== upgrade.roomViewSession;
    if (!newHostSession && message.version <= upgrade.roomViewVersion) return;
    if (newHostSession) {
      upgrade.roomViewSession = message.session;
      upgrade.roomViewVersion = 0;
      upgrade.gameVersion = 0;
      upgrade.selectedGame = '';
    }
    applyRoomView(message.mode, message.version);
    setModeControlsEnabled(true);
  }

  function handleGameSelectMessage(message) {
    if (state.isHost) {
      if (!message.request || message.session !== upgrade.roomViewSession) return;
      upgrade.selectedGame = message.game;
      upgrade.gameVersion += 1;
      sendCurrentRoomView();
      return;
    }
    if (message.request || message.session !== upgrade.roomViewSession || message.version <= upgrade.gameVersion) return;
    upgrade.selectedGame = message.game;
    upgrade.gameVersion = message.version;
    window.dispatchEvent(new CustomEvent('same-room-game-select', { detail: { game: message.game, version: message.version } }));
  }

  function handleGameProtocolMessage(message) {
    if (message.session !== upgrade.roomViewSession) return;
    window.dispatchEvent(new CustomEvent('same-room-game-message', { detail: message }));
  }

  function installModeInterface() {
    const watch = document.querySelector('#sr-choose-watch');
    const games = document.querySelector('#sr-choose-games');
    const watchHome = document.querySelector('#sr-watch-home');
    const gamesHome = document.querySelector('#sr-games-home');
    if (!watch || !games || !watchHome || !gamesHome) return;
    watch.addEventListener('click', () => requestRoomView('watch'));
    games.addEventListener('click', () => requestRoomView('games'));
    watchHome.addEventListener('click', () => requestRoomView('home'));
    gamesHome.addEventListener('click', () => requestRoomView('home'));
    applyRoomView('home', upgrade.roomViewVersion);
    setModeControlsEnabled(false);
    window.SameRoomModes = Object.freeze({
      current: () => upgrade.roomView,
      request: requestRoomView,
      selectedGame: () => upgrade.selectedGame
    });
  }

  function handleCoreMessage(message) {
    if (message.t === 'mode') handleModeMessage(message);
    else if (message.t === 'game-select') handleGameSelectMessage(message);
    else if (GAME_MESSAGE_TYPES.has(message.t)) handleGameProtocolMessage(message);
    else if (message.t === 'load') applyRemoteLoad(message);
    else if (message.t === 'state') applyState(message);
    else if (message.t === 'countin') runCountIn();
    else if (message.t === 'hello') {
      if (message.name) {
        state.theirName = sanitizeName(message.name);
        updateNameLabels();
      }
      send({ t: 'name', name: state.myName });
      broadcastState();
      if (state.isHost) sendCurrentRoomView();
    }
    else if (message.t === 'name') {
      state.theirName = sanitizeName(message.name);
      updateNameLabels();
    }
    else if (message.t === 'brb') {
      if (message.on) applyRemoteBrb(message.name);
      else clearBrb(false);
    }
  }

  function markAuthorized(conn) {
    if (upgrade.authorizedPeer && upgrade.authorizedPeer !== conn.peer) {
      try { conn.close(); } catch (error) {}
      return false;
    }

    const firstAuthorization = upgrade.authorizedPeer !== conn.peer || state.conn !== conn;
    clearTimeout(conn._sameRoomAuthTimeout);
    upgrade.pendingConnections.delete(conn);
    upgrade.authorizedPeer = conn.peer;
    upgrade.reconnectAttempt = 0;
    upgrade.lastPong = Date.now();
    state.conn = conn;

    if (state.isHost && firstAuthorization) {
      for (const pending of upgrade.pendingConnections) {
        if (pending !== conn) {
          try { pending.close(); } catch (error) {}
        }
      }
      upgrade.pendingConnections.clear();
      startConnectionTimers();
      send({ t: 'hello', protocol: VERSION, name: state.myName });
      send({ t: 'name', name: state.myName });
      queueUndeliveredChats();
      upgrade.sending = upgrade.sending.then(flushOutbox).catch(() => {});
      upgrade.sending = upgrade.sending.then(() => sendCurrentRoomView()).catch(() => {});
    }

    if (state.isHost) setModeControlsEnabled(true);
    setConnectionStatus(upgrade.rtt == null ? 'connected securely' : `connected • ${upgrade.rtt} ms`, 'live');
    updateChatConnectionState();
    answerPendingCall();
    return true;
  }

  function answerPendingCall() {
    const call = upgrade.pendingCall;
    if (!call || !upgrade.authorizedPeer || call.peer !== upgrade.authorizedPeer) return;
    clearTimeout(call._sameRoomTimeout);
    upgrade.pendingCall = null;
    try {
      if (state.stream) call.answer(state.stream);
      else call.answer();
      wireCall(call);
    } catch (error) {
      try { call.close(); } catch (closeError) {}
    }
  }

  function receiveCall(call) {
    if (!call) return;
    if (upgrade.authorizedPeer && call.peer !== upgrade.authorizedPeer) {
      try { call.close(); } catch (error) {}
      return;
    }
    if (upgrade.authorizedPeer === call.peer) {
      upgrade.pendingCall = call;
      answerPendingCall();
      return;
    }
    if (upgrade.pendingCall && upgrade.pendingCall !== call) {
      try { upgrade.pendingCall.close(); } catch (error) {}
    }
    upgrade.pendingCall = call;
    call._sameRoomTimeout = setTimeout(() => {
      if (upgrade.pendingCall === call) upgrade.pendingCall = null;
      try { call.close(); } catch (error) {}
    }, 12000);
  }

  function clearConnectionTimers() {
    clearInterval(upgrade.healthTimer);
    clearInterval(upgrade.playbackTimer);
    upgrade.healthTimer = null;
    upgrade.playbackTimer = null;
  }

  function startConnectionTimers() {
    clearConnectionTimers();
    upgrade.lastPong = Date.now();

    upgrade.playbackTimer = setInterval(() => {
      if (state.driver && player.playing() && state.conn && state.conn.open) broadcastState();
    }, 4000);

    upgrade.healthTimer = setInterval(() => {
      const conn = state.conn;
      if (!conn || !conn.open) return;
      if (Date.now() - upgrade.lastPong > 18000) {
        setConnectionStatus('connection stalled, reconnecting…', 'wait');
        try { conn.close(); } catch (error) {}
        return;
      }
      const id = randomId(8);
      upgrade.pingSentAt = Date.now();
      send({ t: 'ping', id, at: upgrade.pingSentAt });
    }, 6000);
  }

  function closeActiveMediaCall() {
    if (state.mediaCall) {
      try { state.mediaCall.close(); } catch (error) {}
      state.mediaCall = null;
    }
  }

  function startGuestMediaCall() {
    if (state.isHost || !state.peer || state.peer.destroyed || !upgrade.hostId || !state.stream) return;
    closeActiveMediaCall();
    try {
      wireCall(state.peer.call(upgrade.hostId, state.stream, { metadata: { v: VERSION } }));
    } catch (error) {}
  }

  function scheduleReconnect(reason = 'reconnecting…') {
    if (upgrade.intentionallyLeaving || state.isHost) return;
    if (!state.peer || state.peer.destroyed) {
      schedulePeerRestart(reason);
      return;
    }
    clearTimeout(upgrade.reconnectTimer);
    const delay = RECONNECT_DELAYS[Math.min(upgrade.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    upgrade.reconnectAttempt += 1;
    setConnectionStatus(reason, 'wait');
    updateChatConnectionState();
    upgrade.reconnectTimer = setTimeout(connectGuest, delay);
  }

  function schedulePeerRestart(reason = 'restarting secure connection…') {
    if (upgrade.intentionallyLeaving || !state.onStage || upgrade.restartingPeer) return;
    clearTimeout(upgrade.peerRestartTimer);
    setConnectionStatus(reason, 'wait');
    updateChatConnectionState();
    const delay = Math.min(1500 + upgrade.peerRestartAttempt * 700, 6000);
    upgrade.peerRestartAttempt += 1;
    upgrade.peerRestartTimer = setTimeout(() => {
      if (upgrade.intentionallyLeaving || !state.onStage) return;
      upgrade.restartingPeer = true;
      try {
        if (state.peer && !state.peer.destroyed) state.peer.destroy();
      } catch (error) {}
      if (!state.isHost) upgrade.myId = `${ROOM_PREFIX}guest-${randomId(15)}`;
      state.peer = createPeer(state.isHost);
      upgrade.restartingPeer = false;
    }, delay);
  }

  function connectGuest() {
    if (upgrade.intentionallyLeaving || state.isHost || upgrade.connecting || !state.peer || state.peer.destroyed || !upgrade.hostId) return;
    if (state.conn && state.conn.open) return;
    if (!navigator.onLine) {
      scheduleReconnect('offline, waiting for network…');
      return;
    }
    if (state.peer.disconnected) {
      try { state.peer.reconnect(); } catch (error) {}
    }
    try {
      upgrade.connecting = true;
      const conn = state.peer.connect(upgrade.hostId, {
        reliable: true,
        serialization: 'json',
        metadata: { v: VERSION }
      });
      wireConn(conn);
    } catch (error) {
      upgrade.connecting = false;
      scheduleReconnect();
    }
  }

  // Replace the original connection wiring with encrypted messages, health checks and recovery.
  wireConn = function secureWireConn(conn) {
    if (!conn) return;
    if (state.isHost && upgrade.authorizedPeer && upgrade.authorizedPeer !== conn.peer) {
      try { conn.close(); } catch (error) {}
      toast('This room already has two people.');
      return;
    }
    if (state.isHost && !upgrade.authorizedPeer && upgrade.pendingConnections.size >= 3) {
      try { conn.close(); } catch (error) {}
      return;
    }

    if (state.isHost) upgrade.pendingConnections.add(conn);
    else state.conn = conn;
    setConnectionStatus(state.isHost ? 'verifying private connection…' : 'securing connection…', 'wait');
    updateChatConnectionState();

    conn.on('open', () => {
      upgrade.connecting = false;
      upgrade.lastPong = Date.now();
      conn._sameRoomAuthTimeout = setTimeout(() => {
        if (upgrade.authorizedPeer !== conn.peer) {
          try { conn.close(); } catch (error) {}
        }
      }, 12000);

      if (!state.isHost) {
        state.conn = conn;
        startConnectionTimers();
        send({ t: 'hello', protocol: VERSION, name: state.myName });
        send({ t: 'name', name: state.myName });
        queueUndeliveredChats();
        upgrade.sending = upgrade.sending.then(flushOutbox).catch(() => {});
        startGuestMediaCall();
      }
    });

    conn.on('data', async envelope => {
      let message;
      try {
        message = validateMessage(await decryptMessage(envelope));
      } catch (error) {
        return;
      }
      if (!message || !markAuthorized(conn)) return;

      if (message.t === 'ping') {
        send({ t: 'pong', id: message.id, at: message.at });
        return;
      }
      if (message.t === 'pong') {
        upgrade.lastPong = Date.now();
        upgrade.rtt = Math.max(0, Math.min(9999, Date.now() - safeNumber(message.at, Date.now())));
        setConnectionStatus(`connected • ${upgrade.rtt} ms`, 'live');
        return;
      }
      if (message.t === 'chat') {
        receiveChat(message);
        send({ t: 'chat-ack', id: message.id });
        return;
      }
      if (message.t === 'chat-ack') {
        markChatDelivered(message.id);
        return;
      }
      if (message.t === 'chat-typing') {
        showRemoteTyping(message.on);
        return;
      }
      handleCoreMessage(message);
    });

    conn.on('close', () => {
      upgrade.connecting = false;
      clearTimeout(conn._sameRoomAuthTimeout);
      upgrade.pendingConnections.delete(conn);
      const wasActive = state.conn === conn || upgrade.authorizedPeer === conn.peer;
      if (!wasActive) {
        if (state.isHost && !upgrade.authorizedPeer) setConnectionStatus('secure room open, waiting for the correct password…', 'wait');
        return;
      }

      if (state.conn === conn) state.conn = null;
      if (upgrade.authorizedPeer === conn.peer) upgrade.authorizedPeer = null;
      clearConnectionTimers();
      abortBrb();
      closeActiveMediaCall();
      updateChatConnectionState();
      setModeControlsEnabled(false);
      if (state.isHost) setConnectionStatus(`${otherSubject()} disconnected, waiting…`, 'wait');
      else if (!state.peer || state.peer.destroyed) schedulePeerRestart(`${otherSubject()} disconnected, restarting…`);
      else scheduleReconnect(`${otherSubject()} disconnected, reconnecting…`);
    });

    conn.on('error', () => {
      upgrade.connecting = false;
      if (state.conn === conn) setConnectionStatus('connection error, recovering…', 'wait');
    });
  };

  function peerIceServers() {
    const builtIn = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
      { urls: 'stun:stun.cloudflare.com:3478' }
    ];
    const custom = Array.isArray(window.SAME_ROOM_TURN_SERVERS) ? window.SAME_ROOM_TURN_SERVERS : [];
    return builtIn.concat(custom.filter(server => server && server.urls));
  }

  function createPeer(asHost) {
    const customOptions = window.SAME_ROOM_PEER_OPTIONS && typeof window.SAME_ROOM_PEER_OPTIONS === 'object'
      ? window.SAME_ROOM_PEER_OPTIONS
      : {};
    const customConfig = customOptions.config && typeof customOptions.config === 'object' ? customOptions.config : {};
    const peer = new Peer(upgrade.myId, {
      ...customOptions,
      debug: 0,
      config: {
        ...customConfig,
        iceServers: peerIceServers(),
        iceCandidatePoolSize: 4
      }
    });

    peer.on('open', () => {
      upgrade.reconnectAttempt = 0;
      upgrade.peerRestartAttempt = 0;
      if (asHost) setConnectionStatus('secure room open, share the room and password', 'wait');
      else connectGuest();
    });

    peer.on('connection', conn => wireConn(conn));
    peer.on('call', call => receiveCall(call));

    peer.on('disconnected', () => {
      if (upgrade.intentionallyLeaving || peer.destroyed) return;
      setConnectionStatus('signalling interrupted, recovering…', 'wait');
      setTimeout(() => {
        if (peer.disconnected && !peer.destroyed) {
          try { peer.reconnect(); } catch (error) {}
        }
      }, 1200);
      setTimeout(() => {
        if (peer.disconnected && !peer.destroyed) schedulePeerRestart('signalling did not recover, restarting…');
      }, 5000);
    });

    peer.on('close', () => {
      if (!upgrade.intentionallyLeaving && !upgrade.restartingPeer) {
        schedulePeerRestart('secure connection closed, restarting…');
      }
    });

    peer.on('error', error => {
      const type = error && error.type ? error.type : '';
      if (type === 'unavailable-id') {
        if (asHost && upgrade.peerRestartAttempt > 0) {
          schedulePeerRestart('room address is still releasing, retrying…');
        } else {
          setConnectionStatus('room already open, press Join instead', 'wait');
          toast('That secure room is already open. Use Join.');
        }
      } else if (type === 'peer-unavailable') {
        scheduleReconnect('room not open yet, or the password differs…');
      } else if (type === 'webrtc') {
        setConnectionStatus('direct connection failed, retrying…', 'wait');
        toast('Direct connection failed. Reload both devices or try switching Wi-Fi and mobile data.', 5200);
        schedulePeerRestart('direct connection failed, retrying securely…');
      } else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(type)) {
        schedulePeerRestart('network problem, restarting securely…');
      } else if (['browser-incompatible', 'invalid-id', 'invalid-key', 'ssl-unavailable'].includes(type)) {
        setConnectionStatus('this browser or signalling setup is not supported', 'wait');
        toast('Secure connection setup failed in this browser.');
      } else {
        setConnectionStatus('connection problem', 'wait');
        console.warn('PeerJS error:', error);
      }
    });

    return peer;
  }

  // Replace the predictable room ID with a password-derived ID and encryption key.
  start = async function secureStart(asHost) {
    const myName = sanitizeName($('#your-name').value);
    const room = normalizeRoom($('#room').value);
    const passwordInput = document.querySelector('#sr-room-password');
    const password = passwordInput ? passwordInput.value : '';

    if (!myName) {
      toast('Enter your name first.');
      $('#your-name').focus();
      return;
    }
    if (!room) {
      toast('Pick a room name first.');
      $('#room').focus();
      return;
    }
    if (password.length < 10) {
      toast('Use a room password with at least 10 characters.');
      if (passwordInput) passwordInput.focus();
      return;
    }
    if (!window.crypto || !window.crypto.subtle) {
      toast('This browser cannot create a secure room. Try a current browser.');
      return;
    }

    const openButton = $('#btn-open');
    const joinButton = $('#btn-join');
    openButton.disabled = true;
    joinButton.disabled = true;
    setEntrySecurityStatus('Creating private room keys…');

    try {
      const session = await deriveSession(room, password);
      upgrade.aesKey = session.aesKey;
      upgrade.hostId = ROOM_PREFIX + session.peerToken;
      upgrade.myId = asHost ? upgrade.hostId : `${ROOM_PREFIX}guest-${randomId(15)}`;
    } catch (error) {
      console.error(error);
      setEntrySecurityStatus('Could not create the secure room keys.');
      openButton.disabled = false;
      joinButton.disabled = false;
      return;
    }

    // Never persist the room password.
    passwordInput.value = '';
    state.myName = myName;
    state.room = room;
    state.isHost = asHost;
    upgrade.intentionallyLeaving = false;
    try { localStorage.setItem(NAME_KEY, myName); } catch (error) {}

    $('#entry').style.display = 'none';
    $('#stage').style.display = 'flex';
    state.onStage = true;
    upgrade.roomView = 'home';
    upgrade.roomViewVersion = 1;
    upgrade.roomViewSession = asHost ? randomId(12) : '';
    upgrade.selectedGame = '';
    upgrade.gameVersion = 0;
    applyRoomView('home', upgrade.roomViewVersion);
    setModeControlsEnabled(false);
    updateNameLabels();
    setConnectionStatus(asHost ? `waiting for ${otherLabel()}…` : 'connecting securely…', 'wait');
    initTiles();

    await getMedia();
    state.peer = createPeer(asHost);
  };

  function injectEntrySecurity() {
    const roomInput = document.querySelector('#room');
    if (!roomInput || document.querySelector('#sr-room-password')) return;

    const wrapper = document.createElement('div');
    wrapper.id = 'sr-security-fields';

    const label = document.createElement('label');
    label.htmlFor = 'sr-room-password';
    label.style.marginTop = '14px';
    label.textContent = 'Room password';

    const passwordRow = document.createElement('div');
    passwordRow.className = 'sr-password-row';

    const password = document.createElement('input');
    password.id = 'sr-room-password';
    password.type = 'password';
    password.placeholder = 'share this privately with your partner';
    password.autocomplete = 'new-password';
    password.maxLength = 100;
    password.setAttribute('aria-describedby', 'sr-security-status');

    const generate = document.createElement('button');
    generate.type = 'button';
    generate.className = 'btn sr-generate';
    generate.textContent = 'Generate';
    generate.addEventListener('click', () => {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
      const bytes = new Uint8Array(18);
      crypto.getRandomValues(bytes);
      password.value = Array.from(bytes, value => alphabet[value % alphabet.length]).join('');
      password.type = 'text';
      setTimeout(() => { password.type = 'password'; }, 5000);
      password.dispatchEvent(new Event('input', { bubbles: true }));
      password.focus();
      password.select();
      setEntrySecurityStatus('Strong password generated. Copy it and share it privately.');
    });

    const status = document.createElement('p');
    status.id = 'sr-security-status';
    status.className = 'sr-security-status';
    status.textContent = 'The room name and password create a private room. The password is never saved.';

    passwordRow.append(password, generate);
    wrapper.append(label, passwordRow, status);
    roomInput.insertAdjacentElement('afterend', wrapper);

    const updateButtons = () => {
      const ready = sanitizeName($('#your-name').value).length > 0 && normalizeRoom(roomInput.value).length > 0 && password.value.length >= 10;
      $('#btn-open').disabled = !ready;
      $('#btn-join').disabled = !ready;
    };
    ['input', 'change'].forEach(eventName => {
      $('#your-name').addEventListener(eventName, updateButtons);
      roomInput.addEventListener(eventName, updateButtons);
      password.addEventListener(eventName, updateButtons);
    });
    updateButtons();
  }

  function setEntrySecurityStatus(text) {
    const status = document.querySelector('#sr-security-status');
    if (status) status.textContent = text;
  }

  function injectChat() {
    if (document.querySelector('#sr-chat-panel')) return;

    const toggle = document.createElement('button');
    toggle.id = 'sr-chat-toggle';
    toggle.type = 'button';
    toggle.setAttribute('aria-controls', 'sr-chat-panel');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open chat');
    toggle.innerHTML = '<span aria-hidden="true">✦</span><span class="sr-chat-toggle-label">Chat</span><span id="sr-chat-badge" hidden></span>';

    const panel = document.createElement('section');
    panel.id = 'sr-chat-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Private chat');
    panel.innerHTML = `
      <header class="sr-chat-header">
        <div><strong>Private chat</strong><span id="sr-chat-state">Reconnecting…</span></div>
        <button type="button" id="sr-chat-close" aria-label="Close chat">×</button>
      </header>
      <div id="sr-chat-messages" role="log" aria-live="polite" aria-relevant="additions"></div>
      <div id="sr-chat-typing" aria-live="polite"></div>
      <form id="sr-chat-form">
        <textarea id="sr-chat-input" rows="1" maxlength="${MAX_CHAT_CHARS}" placeholder="Write a message" aria-label="Message"></textarea>
        <button type="submit" id="sr-chat-send">Send</button>
      </form>`;

    document.body.append(toggle, panel);

    const openChat = () => {
      upgrade.chatOpen = true;
      upgrade.unread = 0;
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      toggle.setAttribute('aria-label', 'Close chat');
      updateUnreadBadge();
      setTimeout(() => document.querySelector('#sr-chat-input').focus(), 0);
      const messages = document.querySelector('#sr-chat-messages');
      messages.scrollTop = messages.scrollHeight;
    };
    const closeChat = () => {
      upgrade.chatOpen = false;
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      toggle.setAttribute('aria-label', 'Open chat');
      toggle.focus();
      send({ t: 'chat-typing', on: false });
    };

    toggle.addEventListener('click', () => upgrade.chatOpen ? closeChat() : openChat());
    document.querySelector('#sr-chat-close').addEventListener('click', closeChat);

    const input = document.querySelector('#sr-chat-input');
    const form = document.querySelector('#sr-chat-form');
    form.addEventListener('submit', event => {
      event.preventDefault();
      const text = input.value.replace(/\r\n?/g, '\n').trim().slice(0, MAX_CHAT_CHARS);
      if (!text) return;
      const message = {
        t: 'chat',
        id: randomId(12),
        text,
        sentAt: Date.now(),
        sender: state.myName
      };
      appendChat(message, true, state.conn && state.conn.open ? 'Sending…' : 'Queued');
      upgrade.pendingChats.set(message.id, message);
      while (upgrade.pendingChats.size > MAX_CHAT_MESSAGES) {
        upgrade.pendingChats.delete(upgrade.pendingChats.keys().next().value);
      }
      send(message);
      input.value = '';
      autoSizeChatInput(input);
      send({ t: 'chat-typing', on: false });
    });

    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    input.addEventListener('input', () => {
      autoSizeChatInput(input);
      send({ t: 'chat-typing', on: true });
      clearTimeout(upgrade.typingTimer);
      upgrade.typingTimer = setTimeout(() => send({ t: 'chat-typing', on: false }), 1200);
    });

    updateChatConnectionState();
  }

  function autoSizeChatInput(input) {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
  }

  function updateUnreadBadge() {
    const badge = document.querySelector('#sr-chat-badge');
    if (!badge) return;
    badge.hidden = upgrade.unread < 1;
    badge.textContent = upgrade.unread > 99 ? '99+' : String(upgrade.unread);
  }

  function formatChatTime(timestamp) {
    try {
      return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(timestamp));
    } catch (error) {
      return '';
    }
  }

  function appendChat(message, mine, deliveryText = '') {
    const list = document.querySelector('#sr-chat-messages');
    if (!list) return;
    const item = document.createElement('article');
    item.className = `sr-chat-message ${mine ? 'mine' : 'theirs'}`;
    item.dataset.messageId = message.id;

    const meta = document.createElement('div');
    meta.className = 'sr-chat-meta';
    const author = document.createElement('span');
    author.textContent = mine ? 'You' : (message.sender || otherLabel());
    const time = document.createElement('time');
    time.dateTime = new Date(message.sentAt).toISOString();
    time.textContent = formatChatTime(message.sentAt);
    meta.append(author, time);

    const bubble = document.createElement('p');
    bubble.textContent = message.text;

    const delivery = document.createElement('span');
    delivery.className = 'sr-chat-delivery';
    delivery.textContent = deliveryText;

    item.append(meta, bubble, delivery);
    list.append(item);
    while (list.children.length > MAX_CHAT_MESSAGES) list.firstElementChild.remove();
    list.scrollTop = list.scrollHeight;
  }

  function receiveChat(message) {
    if (upgrade.seenChatIds.has(message.id)) return;
    upgrade.seenChatIds.add(message.id);
    upgrade.seenChatOrder.push(message.id);
    while (upgrade.seenChatOrder.length > MAX_CHAT_MESSAGES * 2) {
      upgrade.seenChatIds.delete(upgrade.seenChatOrder.shift());
    }

    appendChat(message, false);
    showRemoteTyping(false);
    if (!upgrade.chatOpen) {
      upgrade.unread += 1;
      updateUnreadBadge();
      toast(`${message.sender || otherLabel()} sent a message.`);
    }
  }

  function markChatDelivered(id) {
    upgrade.pendingChats.delete(id);
    const messages = document.querySelectorAll('.sr-chat-message[data-message-id]');
    for (const message of messages) {
      if (message.dataset.messageId === id) {
        const delivery = message.querySelector('.sr-chat-delivery');
        if (delivery) delivery.textContent = 'Delivered';
        break;
      }
    }
  }

  function showRemoteTyping(on) {
    const element = document.querySelector('#sr-chat-typing');
    if (!element) return;
    clearTimeout(upgrade.remoteTypingTimer);
    element.textContent = on ? `${otherLabel()} is typing…` : '';
    if (on) upgrade.remoteTypingTimer = setTimeout(() => { element.textContent = ''; }, 2200);
  }

  function injectStyles() {
    if (document.querySelector('#sr-upgrade-styles')) return;
    const style = document.createElement('style');
    style.id = 'sr-upgrade-styles';
    style.textContent = `
      #sr-security-fields input[type=password],#sr-security-fields input[type=text]{width:100%;padding:13px 14px;background:var(--ink-2);border:1px solid var(--line);border-radius:var(--r);outline:none}
      #sr-security-fields input:focus{border-color:var(--amber);box-shadow:0 0 0 3px rgba(224,162,75,.15)}
      .sr-password-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px}
      .sr-password-row .sr-generate{min-height:46px;padding:0 14px;flex:none}
      .sr-security-status{margin:7px 2px 0;color:var(--dust-dim);font-size:12px;line-height:1.45}
      #sr-chat-toggle{position:fixed;right:14px;bottom:calc(78px + var(--safe-b));z-index:24;display:flex;align-items:center;gap:7px;min-height:44px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:#22202B;color:var(--dust);box-shadow:0 10px 28px rgba(0,0,0,.38);font:600 13px/1 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
      #sr-chat-toggle:hover{border-color:#4A4657}
      #sr-chat-badge{display:grid;place-items:center;min-width:19px;height:19px;padding:0 5px;border-radius:999px;background:var(--rose);color:#180C0C;font-size:10px}
      #sr-chat-badge[hidden]{display:none}
      #sr-chat-panel{position:fixed;right:12px;top:12px;bottom:calc(76px + var(--safe-b));z-index:26;width:min(360px,calc(100vw - 24px));border:1px solid var(--line);border-radius:16px;background:rgba(22,21,28,.98);box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden}
      #sr-chat-panel[hidden]{display:none}
      #sr-chat-panel{grid-template-rows:auto minmax(0,1fr) auto auto}
      #sr-chat-panel:not([hidden]){display:grid}
      .sr-chat-header{display:flex;align-items:center;justify-content:space-between;padding:13px 14px;border-bottom:1px solid var(--line)}
      .sr-chat-header>div{display:grid;gap:2px}.sr-chat-header strong{font-size:14px}.sr-chat-header span{font-size:11px;color:var(--dust-dim)}
      #sr-chat-close{width:36px;height:36px;border:0;border-radius:9px;background:transparent;color:var(--dust);font-size:25px;line-height:1}
      #sr-chat-messages{min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:12px;overscroll-behavior:contain}
      .sr-chat-message{max-width:86%}.sr-chat-message.mine{align-self:flex-end}.sr-chat-message.theirs{align-self:flex-start}
      .sr-chat-meta{display:flex;gap:8px;align-items:baseline;margin:0 5px 4px;color:var(--dust-dim);font-size:10.5px}.sr-chat-meta time{margin-left:auto}
      .sr-chat-message p{white-space:pre-wrap;overflow-wrap:anywhere;margin:0;padding:10px 12px;border:1px solid var(--line);border-radius:14px;background:#201F28;font-size:13.5px;line-height:1.45}
      .sr-chat-message.mine p{background:rgba(224,162,75,.14);border-color:rgba(224,162,75,.42)}
      .sr-chat-delivery{display:block;min-height:14px;margin:3px 6px 0;text-align:right;color:var(--dust-dim);font-size:10px}
      #sr-chat-typing{min-height:24px;padding:2px 16px 5px;color:var(--dust-dim);font-size:11px}
      #sr-chat-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:8px;align-items:end;padding:10px;border-top:1px solid var(--line)}
      #sr-chat-input{width:100%;max-height:120px;resize:none;padding:10px 11px;border:1px solid var(--line);border-radius:11px;background:#101017;color:var(--dust);font:13.5px/1.4 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif;outline:none}
      #sr-chat-input:focus{border-color:var(--amber);box-shadow:0 0 0 3px rgba(224,162,75,.13)}
      #sr-chat-send{min-height:42px;padding:0 14px;border:1px solid var(--amber);border-radius:11px;background:var(--amber);color:#1A1206;font-weight:700}
      @media(max-width:600px){
        #sr-chat-toggle{right:10px;bottom:calc(58px + var(--safe-b));padding:0 12px}.sr-chat-toggle-label{display:none}
        #sr-chat-panel{left:0;right:0;top:auto;bottom:0;width:100%;height:min(72vh,620px);border-radius:18px 18px 0 0;border-left:0;border-right:0;border-bottom:0;padding-bottom:var(--safe-b)}
      }
    `;
    document.head.appendChild(style);
  }

  function installLeaveProtection() {
    const leave = document.querySelector('#btn-leave');
    if (!leave) return;
    leave.addEventListener('click', () => {
      upgrade.intentionallyLeaving = true;
      upgrade.connecting = false;
      clearTimeout(upgrade.reconnectTimer);
      clearTimeout(upgrade.peerRestartTimer);
      clearConnectionTimers();
    }, true);
    window.addEventListener('pagehide', () => {
      upgrade.intentionallyLeaving = true;
      upgrade.connecting = false;
      clearTimeout(upgrade.reconnectTimer);
      clearTimeout(upgrade.peerRestartTimer);
      clearConnectionTimers();
    });
  }

  window.addEventListener('online', () => {
    setModeControlsEnabled(connectedSecurely());
    if (!state.isHost && state.onStage && (!state.conn || !state.conn.open)) scheduleReconnect('network restored, reconnecting…');
  });
  window.addEventListener('offline', () => {
    if (state.onStage) {
      setConnectionStatus('offline, messages will send when reconnected', 'wait');
      updateChatConnectionState();
      setModeControlsEnabled(false);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.onStage) {
      if (state.peer && state.peer.disconnected && !state.peer.destroyed) {
        try { state.peer.reconnect(); } catch (error) {}
      }
      if (!state.isHost && (!state.conn || !state.conn.open)) scheduleReconnect();
      else if (state.conn && state.conn.open) {
        send({ t: 'ping', id: randomId(8), at: Date.now() });
        broadcastState();
      }
    }
  });

  injectStyles();
  injectEntrySecurity();
  installModeInterface();
  injectChat();
  installLeaveProtection();
})();
