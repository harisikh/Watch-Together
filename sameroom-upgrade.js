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

  const SAME_PAGE_GAME = 'same-page';
  const SAME_PAGE_BANK_VERSION = 1;
  const SAME_PAGE_PHASES = new Set(['answering', 'revealing', 'revealed', 'complete']);
  const SAME_PAGE_INPUT_ACTIONS = new Set(['answer-commit', 'answer-reveal', 'next', 'restart']);
  const samePage = {
    state: null,
    local: null,
    commitSentFor: '',
    revealSentFor: '',
    seenEvents: new Set(),
    seenOrder: []
  };

  /* SAME PAGE QUESTION BANK
   * Add a question as: { q: 'Question text', a: ['Option 1', 'Option 2'] }
   * Use {host} and {guest} inside an option when the two names should appear.
   * Keep 2 to 4 short options so every answer remains easy to tap on a phone.
   */
  const SAME_PAGE_QUESTIONS = Object.freeze([
    { q: 'What sounds best for a relaxed evening?', a: ['A film and snacks', 'Music and talking', 'A simple game', 'An early night'] },
    { q: 'Pick a comfort food for us to share.', a: ['Pizza', 'Noodles', 'Biryani', 'Dessert first'] },
    { q: 'Which little plan sounds nicest?', a: ['Sunset walk', 'Late breakfast', 'Bookshop visit', 'Cook together'] },
    { q: 'Choose our ideal call background.', a: ['Rain outside', 'City lights', 'Quiet room', 'Balcony breeze'] },
    { q: 'What should a surprise parcel contain?', a: ['Favourite snacks', 'A handwritten note', 'Something useful', 'A silly gift'] },
    { q: 'Which trip pace suits us best?', a: ['Plan every stop', 'One plan a day', 'Mostly spontaneous', 'Stay and unwind'] },
    { q: 'Pick a late-night craving.', a: ['Something sweet', 'Something spicy', 'Something crunchy', 'Just tea or coffee'] },
    { q: 'Which weather makes a date feel best?', a: ['Soft rain', 'Cool sunshine', 'Winter evening', 'Warm night'] },
    { q: 'What should we watch after a tiring day?', a: ['Comedy', 'Comfort rewatch', 'Short episodes', 'Something new'] },
    { q: 'Choose a tiny everyday luxury.', a: ['Fresh sheets', 'Good coffee', 'A long shower', 'No alarms'] },
    { q: 'Which shared habit would be fun?', a: ['Photo of the day', 'Weekly playlist', 'Sunday call ritual', 'Tiny surprise notes'] },
    { q: 'Pick a place for a slow afternoon.', a: ['Cosy café', 'Quiet park', 'Home sofa', 'Near the water'] },
    { q: 'What makes a video call feel extra nice?', a: ['Eating together', 'Doing separate things', 'Playing a game', 'Talking with no plan'] },
    { q: 'Which snack belongs at movie night?', a: ['Popcorn', 'Chips', 'Chocolate', 'Fruit'] },
    { q: 'Choose a dream weekend morning.', a: ['Sleep in', 'Breakfast outside', 'A small adventure', 'Stay in pyjamas'] },
    { q: 'Which kind of message brightens the day most?', a: ['A voice note', 'A funny photo', 'A sweet sentence', 'A random update'] },
    { q: 'Pick one thing to learn together.', a: ['A new recipe', 'A language', 'Photography', 'A dance'] },
    { q: 'Which souvenir would we actually keep?', a: ['A postcard', 'A small magnet', 'A photo strip', 'A local snack'] },
    { q: 'What should our imaginary café serve best?', a: ['Coffee', 'Desserts', 'Breakfast', 'Comfort food'] },
    { q: 'Choose a no-pressure date idea.', a: ['People watching', 'Grocery shopping', 'A long drive', 'Board games'] },
    { q: 'Which room would we make cosiest first?', a: ['Bedroom', 'Living room', 'Balcony', 'Kitchen'] },
    { q: 'Pick a sound for falling asleep.', a: ['Rain', 'A fan', 'Soft music', 'Complete quiet'] },
    { q: 'Which photo should we recreate someday?', a: ['Childhood pose', 'Film poster', 'Travel postcard', 'Funny selfie'] },
    { q: 'Choose a small celebration.', a: ['Favourite meal', 'Cake at midnight', 'A day out', 'A thoughtful gift'] },
    { q: 'What should we always keep in the fridge?', a: ['Cold drinks', 'Fruit', 'Dessert', 'Leftovers'] },
    { q: 'Pick a harmless debate for tonight.', a: ['Tea or coffee', 'Sweet or salty', 'Morning or night', 'Beach or hills'] },
    { q: 'Which of us would pack earlier?', a: ['{host}', '{guest}', 'Both of us', 'Neither of us'] },
    { q: 'Which of us would notice a new café first?', a: ['{host}', '{guest}', 'Both together'] },
    { q: 'Who would choose the playlist fastest?', a: ['{host}', '{guest}', 'We would take turns'] },
    { q: 'Who is more likely to bring extra snacks?', a: ['{host}', '{guest}', 'Both of us'] },
    { q: 'Who would remember the tiny details?', a: ['{host}', '{guest}', 'Different details'] },
    { q: 'Who would suggest one more episode?', a: ['{host}', '{guest}', 'Both at once'] },
    { q: 'Would you rather plan a sunrise or sunset date?', a: ['Sunrise', 'Sunset'] },
    { q: 'Would you rather revisit a favourite place or try a new one?', a: ['Favourite place', 'Somewhere new'] },
    { q: 'Would you rather share one dessert or order two?', a: ['Share one', 'Order two'] },
    { q: 'Would you rather have a perfect photo or a funny memory?', a: ['Perfect photo', 'Funny memory'] },
    { q: 'Would you rather cook slowly or order quickly?', a: ['Cook slowly', 'Order quickly'] },
    { q: 'What should our next small countdown be for?', a: ['Next visit', 'A film night', 'A shared goal', 'A surprise'] },
    { q: 'Choose a future home detail.', a: ['A reading corner', 'A big dining table', 'Lots of plants', 'A cosy balcony'] },
    { q: 'What should we do when we finally have a full free day?', a: ['Go somewhere', 'Stay home', 'Mix both', 'Decide that morning'] }
  ]);

  const DRAW_GAME = 'draw-and-guess';
  const DRAW_BANK_VERSION = 1;
  const DRAW_PHASES = new Set(['drawing', 'ended']);
  const DRAW_INPUT_ACTIONS = new Set(['draw-batch', 'history-sync', 'undo', 'clear', 'guess', 'reveal-word', 'skip-word', 'next-round']);
  const DRAW_STATE_ACTIONS = new Set(['snapshot', 'draw-batch']);
  const DRAW_COLORS = new Set(['#202028', '#D34A4A', '#3478C5', '#348A57']);
  const DRAW_SIZES = new Set([8, 20]);
  const AVAILABLE_GAMES = new Set([SAME_PAGE_GAME, DRAW_GAME]);
  const DRAW_BATCH_INTERVAL_MS = 50;
  const MAX_DRAW_BATCH_POINTS = 80;
  const MAX_DRAW_POINTS = 2500;
  const MAX_DRAW_STROKES = 160;

  /* DRAWING WORD BANK
   * Add short, familiar words or phrases inside this array.
   * Keep each entry under 32 characters so it stays readable on a phone.
   */
  const DRAW_WORDS = Object.freeze([
    'apple', 'banana', 'pizza', 'burger', 'ice cream', 'cake', 'coffee', 'tea', 'noodles', 'popcorn',
    'umbrella', 'suitcase', 'toothbrush', 'pillow', 'lamp', 'key', 'phone', 'laptop', 'headphones', 'camera',
    'bicycle', 'car', 'train', 'airplane', 'boat', 'house', 'bridge', 'clock', 'book', 'pencil',
    'scissors', 'balloon', 'candle', 'gift', 'flower', 'tree', 'sun', 'moon', 'star', 'cloud',
    'rain', 'snowman', 'cat', 'dog', 'elephant', 'giraffe', 'penguin', 'fish', 'butterfly', 'turtle',
    'rabbit', 'dancing', 'sleeping', 'running', 'cooking', 'singing', 'waving', 'laughing', 'sneezing', 'hugging',
    'selfie', 'movie night', 'video call', 'long distance', 'heart', 'crown', 'robot', 'ghost', 'dinosaur', 'superhero',
    'treasure', 'rainbow', 'mountain', 'beach', 'picnic', 'shopping cart', 'alarm clock', 'traffic light', 'frying pan', 'socks'
  ]);

  const drawing = {
    state: null,
    color: '#202028',
    size: 8,
    pointerId: null,
    activeStrokeId: '',
    buffer: [],
    batchSeq: 0,
    flushTimer: null,
    historyLimitReached: false,
    seenEvents: new Set(),
    seenOrder: [],
    syncAfterSnapshot: false
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


  function hasOnlyObjectKeys(value, allowed, required = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const keys = Object.keys(value);
    return required.every(key => keys.includes(key)) && keys.every(key => allowed.includes(key));
  }

  function safeQuestionIndex(value, allowComplete = false) {
    const index = Number(value);
    const minimum = allowComplete ? -1 : 0;
    return Number.isSafeInteger(index) && index >= minimum && index < SAME_PAGE_QUESTIONS.length ? index : null;
  }

  function safeAnswerIndex(value, questionIndex) {
    const answer = Number(value);
    const question = SAME_PAGE_QUESTIONS[questionIndex];
    return question && Number.isSafeInteger(answer) && answer >= 0 && answer < question.a.length ? answer : null;
  }

  function safeSamePageCommit(value) {
    const commit = safeProtocolToken(value, 60);
    return commit && commit.length === 43 ? commit : null;
  }

  function validateSamePageReveal(value, questionIndex) {
    if (value === null) return null;
    if (!hasOnlyObjectKeys(value, ['answer', 'nonce'], ['answer', 'nonce'])) return false;
    const answer = safeAnswerIndex(value.answer, questionIndex);
    const nonce = safeProtocolToken(value.nonce, 40);
    return answer === null || !nonce ? false : { answer, nonce };
  }

  function validateSamePageSnapshot(payload) {
    const keys = ['bankVersion', 'gameSessionId', 'phase', 'questionIndex', 'roundNumber', 'matchCount', 'used', 'commits', 'reveals'];
    if (!hasOnlyObjectKeys(payload, keys, keys)) return null;
    if (payload.bankVersion !== SAME_PAGE_BANK_VERSION) return null;
    const gameSessionId = safeProtocolToken(payload.gameSessionId, 80);
    const phase = String(payload.phase || '');
    const questionIndex = safeQuestionIndex(payload.questionIndex, phase === 'complete');
    const roundNumber = Number(payload.roundNumber);
    const matchCount = Number(payload.matchCount);
    if (!gameSessionId || !SAME_PAGE_PHASES.has(phase) || questionIndex === null) return null;
    if (!Number.isSafeInteger(roundNumber) || roundNumber < 0 || roundNumber > SAME_PAGE_QUESTIONS.length) return null;
    if (!Number.isSafeInteger(matchCount) || matchCount < 0 || matchCount > roundNumber) return null;
    if (!Array.isArray(payload.used) || payload.used.length > SAME_PAGE_QUESTIONS.length) return null;
    const used = payload.used.map(value => Number(value));
    if (used.some(value => !Number.isSafeInteger(value) || value < 0 || value >= SAME_PAGE_QUESTIONS.length)) return null;
    if (new Set(used).size !== used.length || roundNumber !== used.length) return null;
    if (phase === 'complete' && (used.length !== SAME_PAGE_QUESTIONS.length || questionIndex !== -1)) return null;
    if (phase !== 'complete' && (questionIndex < 0 || !used.includes(questionIndex))) return null;
    if (!hasOnlyObjectKeys(payload.commits, ['host', 'guest'], ['host', 'guest'])) return null;
    const hostCommit = payload.commits.host === '' ? '' : safeSamePageCommit(payload.commits.host);
    const guestCommit = payload.commits.guest === '' ? '' : safeSamePageCommit(payload.commits.guest);
    if (hostCommit === null || guestCommit === null) return null;
    if (!hasOnlyObjectKeys(payload.reveals, ['host', 'guest'], ['host', 'guest'])) return null;
    const hostReveal = validateSamePageReveal(payload.reveals.host, questionIndex);
    const guestReveal = validateSamePageReveal(payload.reveals.guest, questionIndex);
    if (hostReveal === false || guestReveal === false) return null;
    if (phase === 'answering' && (hostReveal || guestReveal)) return null;
    if (phase === 'revealing' && (!hostCommit || !guestCommit || !hostReveal || guestReveal)) return null;
    if (phase === 'revealed' && (!hostCommit || !guestCommit || !hostReveal || !guestReveal)) return null;
    if (phase === 'complete' && (hostCommit || guestCommit || hostReveal || guestReveal)) return null;
    return {
      bankVersion: SAME_PAGE_BANK_VERSION,
      gameSessionId,
      phase,
      questionIndex,
      roundNumber,
      matchCount,
      used,
      commits: { host: hostCommit || '', guest: guestCommit || '' },
      reveals: { host: hostReveal || null, guest: guestReveal || null }
    };
  }

  function validateSamePageInput(action, payload, roundId) {
    if (!SAME_PAGE_INPUT_ACTIONS.has(action)) return null;
    if (action === 'answer-commit') {
      if (!roundId || !hasOnlyObjectKeys(payload, ['commit'], ['commit'])) return null;
      const commit = safeSamePageCommit(payload.commit);
      return commit ? { commit } : null;
    }
    if (action === 'answer-reveal') {
      if (!roundId || !hasOnlyObjectKeys(payload, ['answer', 'nonce'], ['answer', 'nonce'])) return null;
      const answer = Number(payload.answer);
      const nonce = safeProtocolToken(payload.nonce, 40);
      if (!Number.isSafeInteger(answer) || answer < 0 || answer > 3 || !nonce) return null;
      return { answer, nonce };
    }
    return hasOnlyObjectKeys(payload, []) ? {} : null;
  }

  function safeDrawPoint(value) {
    if (!Array.isArray(value) || value.length !== 2) return null;
    const x = Number(value[0]);
    const y = Number(value[1]);
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) || x < 0 || x > 1000 || y < 0 || y > 1000) return null;
    return [x, y];
  }

  function validateDrawBatch(payload) {
    const keys = ['strokeId', 'seq', 'color', 'size', 'start', 'points'];
    if (!hasOnlyObjectKeys(payload, keys, keys)) return null;
    const strokeId = safeProtocolToken(payload.strokeId, 80);
    const seq = Number(payload.seq);
    const color = String(payload.color || '');
    const size = Number(payload.size);
    if (!strokeId || !Number.isSafeInteger(seq) || seq < 0 || seq > 1000000 || !DRAW_COLORS.has(color) || !DRAW_SIZES.has(size)) return null;
    if (!Array.isArray(payload.points) || payload.points.length < 1 || payload.points.length > MAX_DRAW_BATCH_POINTS) return null;
    const points = payload.points.map(safeDrawPoint);
    if (points.some(point => point === null)) return null;
    return { strokeId, seq, color, size, start: Boolean(payload.start), points };
  }

  function validateDrawStrokes(value) {
    if (!Array.isArray(value) || value.length > MAX_DRAW_STROKES) return null;
    let total = 0;
    const strokes = [];
    for (const raw of value) {
      if (!hasOnlyObjectKeys(raw, ['id', 'color', 'size', 'points'], ['id', 'color', 'size', 'points'])) return null;
      const id = safeProtocolToken(raw.id, 80);
      const color = String(raw.color || '');
      const size = Number(raw.size);
      if (!id || !DRAW_COLORS.has(color) || !DRAW_SIZES.has(size) || !Array.isArray(raw.points) || raw.points.length < 1) return null;
      total += raw.points.length;
      if (total > MAX_DRAW_POINTS) return null;
      const points = raw.points.map(safeDrawPoint);
      if (points.some(point => point === null)) return null;
      strokes.push({ id, color, size, points });
    }
    return strokes;
  }

  function validateDrawSnapshot(payload) {
    const keys = ['bankVersion', 'gameSessionId', 'phase', 'roundNumber', 'guessedCount', 'drawer', 'word', 'endReason', 'lastGuess', 'strokes'];
    if (!hasOnlyObjectKeys(payload, keys, keys) || payload.bankVersion !== DRAW_BANK_VERSION) return null;
    const gameSessionId = safeProtocolToken(payload.gameSessionId, 80);
    const phase = String(payload.phase || '');
    const roundNumber = Number(payload.roundNumber);
    const guessedCount = Number(payload.guessedCount);
    const drawer = String(payload.drawer || '');
    const word = String(payload.word || '').trim().slice(0, 32);
    const endReason = String(payload.endReason || '');
    const lastGuess = String(payload.lastGuess || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const strokes = validateDrawStrokes(payload.strokes);
    if (!gameSessionId || !DRAW_PHASES.has(phase) || !['host', 'guest'].includes(drawer) || strokes === null) return null;
    if (!Number.isSafeInteger(roundNumber) || roundNumber < 1 || roundNumber > 10000) return null;
    if (!Number.isSafeInteger(guessedCount) || guessedCount < 0 || guessedCount > roundNumber) return null;
    if (word && !DRAW_WORDS.includes(word)) return null;
    if (phase === 'drawing' && endReason) return null;
    if (phase === 'drawing' && drawer === 'guest' && !word) return null;
    if (phase === 'drawing' && drawer === 'host' && word) return null;
    if (phase === 'ended' && !['guessed', 'revealed'].includes(endReason)) return null;
    if (phase === 'ended' && !word) return null;
    return { bankVersion: DRAW_BANK_VERSION, gameSessionId, phase, roundNumber, guessedCount, drawer, word, endReason, lastGuess, strokes };
  }

  function validateDrawInput(action, payload, roundId) {
    if (!DRAW_INPUT_ACTIONS.has(action) || !roundId) return null;
    if (action === 'draw-batch') return validateDrawBatch(payload);
    if (action === 'history-sync') {
      if (!hasOnlyObjectKeys(payload, ['strokes'], ['strokes'])) return null;
      const strokes = validateDrawStrokes(payload.strokes);
      return strokes === null ? null : { strokes };
    }
    if (action === 'guess') {
      if (!hasOnlyObjectKeys(payload, ['text'], ['text'])) return null;
      const text = String(payload.text || '').replace(/\s+/g, ' ').trim().slice(0, 60);
      return text ? { text } : null;
    }
    return hasOnlyObjectKeys(payload, []) ? {} : null;
  }

  function validateDrawState(action, payload, roundId) {
    if (!DRAW_STATE_ACTIONS.has(action) || !roundId) return null;
    if (action === 'snapshot') return validateDrawSnapshot(payload);
    if (action === 'draw-batch') return validateDrawBatch(payload);
    return null;
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
      if (game === null || (game && !AVAILABLE_GAMES.has(game)) || version === null || !session || (request && !requestId)) return null;
      return { t: type, game, version, session, request, requestId: requestId || '' };
    }

    if (type === 'game-state' || type === 'game-input') {
      const game = safeProtocolToken(message.game, 50);
      const action = safeProtocolToken(message.action, 50);
      const roundId = safeProtocolToken(message.roundId, 80, true);
      const eventId = safeProtocolToken(message.eventId, 80);
      const version = safeVersion(message.version);
      const session = safeProtocolToken(message.session, 80);
      const genericPayload = validatedGamePayload(message.payload);
      if (!game || !AVAILABLE_GAMES.has(game) || !action || roundId === null || !eventId || version === null || !session || genericPayload === null) return null;
      let payload = null;
      if (game === SAME_PAGE_GAME && type === 'game-state' && action === 'snapshot') payload = validateSamePageSnapshot(genericPayload);
      if (game === SAME_PAGE_GAME && type === 'game-input') payload = validateSamePageInput(action, genericPayload, roundId);
      if (game === DRAW_GAME && type === 'game-state') payload = validateDrawState(action, genericPayload, roundId);
      if (game === DRAW_GAME && type === 'game-input') payload = validateDrawInput(action, genericPayload, roundId);
      if (payload === null) return null;
      return { t: type, game, action, roundId, eventId, version, session, payload };
    }

    if (type === 'game-reset') {
      const game = safeProtocolToken(message.game, 50);
      const resetId = safeProtocolToken(message.resetId, 80);
      const version = safeVersion(message.version);
      const session = safeProtocolToken(message.session, 80);
      if (!game || !AVAILABLE_GAMES.has(game) || !resetId || version === null || !session) return null;
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

  function localSamePageRole() {
    return state.isHost ? 'host' : 'guest';
  }

  function otherSamePageRole() {
    return state.isHost ? 'guest' : 'host';
  }

  function samePageName(role) {
    if (role === localSamePageRole()) return state.myName || (role === 'host' ? 'Host' : 'Guest');
    return state.theirName || (role === 'host' ? 'Host' : 'Guest');
  }

  function formatSamePageText(value) {
    return String(value || '')
      .replaceAll('{host}', samePageName('host'))
      .replaceAll('{guest}', samePageName('guest'));
  }

  function setModeControlsEnabled(enabled) {
    ['#sr-choose-watch', '#sr-choose-games', '#sr-games-home', '#sr-watch-home', '#sr-game-same-page', '#sr-game-draw-and-guess', '#sr-sp-back-games', '#sr-sp-home', '#sr-dg-back-games', '#sr-dg-home'].forEach(selector => {
      const control = document.querySelector(selector);
      if (control) control.disabled = !enabled;
    });
    const status = document.querySelector('#sr-home-status');
    if (status) status.textContent = enabled
      ? 'You are connected. Choose together.'
      : (navigator.onLine ? 'Waiting for the secure connection.' : 'Offline. Reconnect to choose an activity.');
    renderSamePage();
    renderDrawing();
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
    applySelectedGameUI();
  }

  function rememberGameEvent(eventId) {
    if (samePage.seenEvents.has(eventId)) return false;
    samePage.seenEvents.add(eventId);
    samePage.seenOrder.push(eventId);
    while (samePage.seenOrder.length > 500) samePage.seenEvents.delete(samePage.seenOrder.shift());
    return true;
  }

  function samePageStorageKey(gameSessionId, roundId) {
    return `sameroom-same-page:${state.room}:${gameSessionId}:${roundId}:${localSamePageRole()}`;
  }

  function saveLocalSamePageAnswer() {
    if (!samePage.state || !samePage.local) return;
    try {
      sessionStorage.setItem(samePageStorageKey(samePage.state.gameSessionId, samePage.state.roundId), JSON.stringify(samePage.local));
    } catch (error) {}
  }

  function clearLocalSamePageAnswer(gameSessionId = samePage.state && samePage.state.gameSessionId, roundId = samePage.state && samePage.state.roundId) {
    if (gameSessionId && roundId) {
      try { sessionStorage.removeItem(samePageStorageKey(gameSessionId, roundId)); } catch (error) {}
    }
    samePage.local = null;
    samePage.commitSentFor = '';
    samePage.revealSentFor = '';
  }

  function restoreLocalSamePageAnswer() {
    if (!samePage.state || samePage.local) return;
    try {
      const raw = sessionStorage.getItem(samePageStorageKey(samePage.state.gameSessionId, samePage.state.roundId));
      if (!raw) return;
      const value = JSON.parse(raw);
      if (!value || !Number.isSafeInteger(value.answer) || value.answer < 0 || value.answer > 3) return;
      if (!safeProtocolToken(value.nonce, 100) || !safeProtocolToken(value.commit, 100)) return;
      samePage.local = { answer: value.answer, nonce: value.nonce, commit: value.commit };
    } catch (error) {}
  }

  async function samePageCommitment(roundId, role, answer, nonce, gameSessionId) {
    const digest = await sha256(`same-room:same-page:v1:${upgrade.roomViewSession}:${gameSessionId}:${roundId}:${role}:${answer}:${nonce}`);
    return bytesToBase64Url(digest);
  }

  function cryptoRandomIndex(length) {
    if (length < 2) return 0;
    const limit = Math.floor(0x100000000 / length) * length;
    const value = new Uint32Array(1);
    do { crypto.getRandomValues(value); } while (value[0] >= limit);
    return value[0] % length;
  }

  function newSamePageRound(previous = null) {
    const used = previous ? [...previous.used] : [];
    const remaining = SAME_PAGE_QUESTIONS.map((_, index) => index).filter(index => !used.includes(index));
    if (!remaining.length) {
      return {
        bankVersion: SAME_PAGE_BANK_VERSION,
        gameSessionId: previous.gameSessionId,
        version: previous.version + 1,
        roundId: randomId(12),
        phase: 'complete',
        questionIndex: -1,
        roundNumber: SAME_PAGE_QUESTIONS.length,
        matchCount: previous.matchCount,
        used,
        commits: { host: '', guest: '' },
        reveals: { host: null, guest: null }
      };
    }
    const questionIndex = remaining[cryptoRandomIndex(remaining.length)];
    used.push(questionIndex);
    return {
      bankVersion: SAME_PAGE_BANK_VERSION,
      gameSessionId: previous ? previous.gameSessionId : randomId(12),
      version: previous ? previous.version + 1 : 1,
      roundId: randomId(12),
      phase: 'answering',
      questionIndex,
      roundNumber: used.length,
      matchCount: previous ? previous.matchCount : 0,
      used,
      commits: { host: '', guest: '' },
      reveals: { host: null, guest: null }
    };
  }

  function resetSamePageLocalState(clearStored = true) {
    if (clearStored && samePage.state) clearLocalSamePageAnswer(samePage.state.gameSessionId, samePage.state.roundId);
    else {
      samePage.local = null;
      samePage.commitSentFor = '';
      samePage.revealSentFor = '';
    }
    samePage.state = null;
    samePage.seenEvents.clear();
    samePage.seenOrder.length = 0;
    renderSamePage();
  }

  function startSamePageSession() {
    resetSamePageLocalState();
    samePage.state = newSamePageRound();
    renderSamePage();
  }

  function serializableSamePageState() {
    if (!samePage.state) return null;
    const value = samePage.state;
    return {
      bankVersion: SAME_PAGE_BANK_VERSION,
      gameSessionId: value.gameSessionId,
      phase: value.phase,
      questionIndex: value.questionIndex,
      roundNumber: value.roundNumber,
      matchCount: value.matchCount,
      used: [...value.used],
      commits: { host: value.commits.host, guest: value.commits.guest },
      reveals: {
        host: value.reveals.host ? { ...value.reveals.host } : null,
        guest: value.reveals.guest ? { ...value.reveals.guest } : null
      }
    };
  }

  function sendSamePageSnapshot() {
    if (!state.isHost || upgrade.selectedGame !== SAME_PAGE_GAME || !samePage.state || !connectedSecurely()) return;
    send({
      t: 'game-state', game: SAME_PAGE_GAME, action: 'snapshot', roundId: samePage.state.roundId,
      eventId: randomId(12), version: samePage.state.version, session: upgrade.roomViewSession,
      payload: serializableSamePageState()
    });
  }

  function sendCurrentRoomView() {
    if (!state.isHost || !connectedSecurely()) return;
    send({ t: 'mode', mode: upgrade.roomView, version: upgrade.roomViewVersion, session: upgrade.roomViewSession, request: false, requestId: '' });
    send({ t: 'game-select', game: upgrade.selectedGame, version: upgrade.gameVersion, session: upgrade.roomViewSession, request: false, requestId: '' });
    if (upgrade.selectedGame === SAME_PAGE_GAME) sendSamePageSnapshot();
    if (upgrade.selectedGame === DRAW_GAME) sendDrawingSnapshot();
  }

  function leaveCurrentGame(clearSelection = true) {
    if (!upgrade.selectedGame) return;
    if (state.isHost && connectedSecurely()) {
      const resetVersion = samePage.state ? samePage.state.version + 1 : 1;
      send({ t: 'game-reset', game: upgrade.selectedGame, resetId: randomId(12), version: resetVersion, session: upgrade.roomViewSession });
    }
    if (upgrade.selectedGame === SAME_PAGE_GAME) resetSamePageLocalState();
    if (upgrade.selectedGame === DRAW_GAME) resetDrawingState();
    if (clearSelection) {
      upgrade.selectedGame = '';
      upgrade.gameVersion += 1;
      window.dispatchEvent(new CustomEvent('same-room-game-select', { detail: { game: '', version: upgrade.gameVersion } }));
      applySelectedGameUI();
    }
  }

  function commitRoomView(mode) {
    if (!state.isHost || !ROOM_VIEWS.has(mode)) return;
    if (mode !== 'games' && upgrade.selectedGame) leaveCurrentGame();
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
      resetSamePageLocalState(false);
      resetDrawingState();
      upgrade.roomViewSession = message.session;
      upgrade.roomViewVersion = 0;
      upgrade.gameVersion = 0;
      upgrade.selectedGame = '';
    }
    applyRoomView(message.mode, message.version);
    setModeControlsEnabled(true);
  }

  function commitGameSelect(game) {
    if (!state.isHost || (game && !AVAILABLE_GAMES.has(game))) return;
    if (upgrade.selectedGame === game) {
      sendCurrentRoomView();
      return;
    }
    if (upgrade.selectedGame) leaveCurrentGame(false);
    upgrade.selectedGame = game;
    upgrade.gameVersion += 1;
    if (game === SAME_PAGE_GAME) startSamePageSession();
    if (game === DRAW_GAME) startDrawingSession();
    window.dispatchEvent(new CustomEvent('same-room-game-select', { detail: { game, version: upgrade.gameVersion } }));
    applySelectedGameUI();
    sendCurrentRoomView();
  }

  function requestGameSelect(game) {
    if (game && !AVAILABLE_GAMES.has(game)) return;
    if (!connectedSecurely()) {
      toast('Reconnect before changing the game.');
      return;
    }
    if (upgrade.roomView !== 'games') return;
    if (!game && upgrade.selectedGame) {
      const leaveGame = window.confirm('Leave this game and return to the game list?');
      if (!leaveGame) return;
    }
    if (state.isHost) commitGameSelect(game);
    else send({
      t: 'game-select', game, version: upgrade.gameVersion, session: upgrade.roomViewSession,
      request: true, requestId: randomId(10)
    });
  }

  function handleGameSelectMessage(message) {
    if (state.isHost) {
      if (!message.request || message.session !== upgrade.roomViewSession) return;
      commitGameSelect(message.game);
      return;
    }
    if (message.request || message.session !== upgrade.roomViewSession || message.version < upgrade.gameVersion) return;
    if (message.version === upgrade.gameVersion && message.game === upgrade.selectedGame) return;
    if (upgrade.selectedGame && upgrade.selectedGame !== message.game) {
      if (upgrade.selectedGame === SAME_PAGE_GAME) resetSamePageLocalState();
      if (upgrade.selectedGame === DRAW_GAME) resetDrawingState();
    }
    upgrade.selectedGame = message.game;
    upgrade.gameVersion = message.version;
    window.dispatchEvent(new CustomEvent('same-room-game-select', { detail: { game: message.game, version: message.version } }));
    applySelectedGameUI();
  }

  function currentQuestion() {
    return samePage.state && samePage.state.questionIndex >= 0 ? SAME_PAGE_QUESTIONS[samePage.state.questionIndex] : null;
  }

  function setSamePageStateFromSnapshot(message) {
    const payload = message.payload;
    const previous = samePage.state;
    const newSession = !previous || previous.gameSessionId !== payload.gameSessionId;
    if (!newSession && message.version < previous.version) return;
    if (newSession && previous) clearLocalSamePageAnswer(previous.gameSessionId, previous.roundId);
    if (previous && previous.roundId !== message.roundId) clearLocalSamePageAnswer(previous.gameSessionId, previous.roundId);
    samePage.state = {
      ...payload,
      version: message.version,
      roundId: message.roundId,
      used: [...payload.used],
      commits: { ...payload.commits },
      reveals: {
        host: payload.reveals.host ? { ...payload.reveals.host } : null,
        guest: payload.reveals.guest ? { ...payload.reveals.guest } : null
      }
    };
    restoreLocalSamePageAnswer();
    if (samePage.state.commits.guest) samePage.commitSentFor = samePage.state.roundId;
    renderSamePage();
    if (!state.isHost && samePage.state.phase === 'answering') sendGuestSamePageCommit();
    if (!state.isHost && samePage.state.phase === 'revealing') maybeSendGuestReveal();
    if (samePage.state.phase === 'revealed') clearLocalSamePageAnswer(samePage.state.gameSessionId, samePage.state.roundId);
  }

  async function verifySamePageReveal(role, reveal) {
    if (!samePage.state || !reveal) return false;
    const expected = samePage.state.commits[role];
    if (!expected) return false;
    const actual = await samePageCommitment(samePage.state.roundId, role, reveal.answer, reveal.nonce, samePage.state.gameSessionId);
    return actual === expected;
  }

  async function maybeStartSamePageReveal() {
    const game = samePage.state;
    if (!state.isHost || !game || game.phase !== 'answering' || !game.commits.host || !game.commits.guest) return;
    restoreLocalSamePageAnswer();
    if (!samePage.local || samePage.local.commit !== game.commits.host) return;
    const valid = await verifySamePageReveal('host', { answer: samePage.local.answer, nonce: samePage.local.nonce });
    if (!valid || !samePage.state || samePage.state.roundId !== game.roundId || samePage.state.phase !== 'answering') return;
    samePage.state.phase = 'revealing';
    samePage.state.reveals.host = { answer: samePage.local.answer, nonce: samePage.local.nonce };
    samePage.state.version += 1;
    renderSamePage();
    sendSamePageSnapshot();
  }

  async function processSamePageCommit(role, commit, roundId) {
    const game = samePage.state;
    if (!state.isHost || !game || game.phase !== 'answering' || game.roundId !== roundId) return;
    if (game.commits[role]) return;
    game.commits[role] = commit;
    game.version += 1;
    renderSamePage();
    await maybeStartSamePageReveal();
    if (samePage.state && samePage.state.phase === 'answering') sendSamePageSnapshot();
  }

  async function processSamePageReveal(role, reveal, roundId) {
    const game = samePage.state;
    if (!state.isHost || role !== 'guest' || !game || game.phase !== 'revealing' || game.roundId !== roundId || game.reveals.guest) return;
    if (safeAnswerIndex(reveal.answer, game.questionIndex) === null) return;
    const valid = await verifySamePageReveal(role, reveal);
    if (!valid || !samePage.state || samePage.state.roundId !== roundId || samePage.state.phase !== 'revealing') return;
    samePage.state.reveals.guest = { answer: reveal.answer, nonce: reveal.nonce };
    samePage.state.phase = 'revealed';
    if (samePage.state.reveals.host.answer === samePage.state.reveals.guest.answer) samePage.state.matchCount += 1;
    samePage.state.version += 1;
    clearLocalSamePageAnswer(samePage.state.gameSessionId, samePage.state.roundId);
    renderSamePage();
    sendSamePageSnapshot();
  }

  function advanceSamePageRound() {
    if (!state.isHost || !samePage.state || samePage.state.phase !== 'revealed') return;
    clearLocalSamePageAnswer(samePage.state.gameSessionId, samePage.state.roundId);
    samePage.state = newSamePageRound(samePage.state);
    renderSamePage();
    sendSamePageSnapshot();
  }

  function restartSamePageSession() {
    if (!state.isHost || !samePage.state || samePage.state.phase !== 'complete') return;
    clearLocalSamePageAnswer(samePage.state.gameSessionId, samePage.state.roundId);
    samePage.state = newSamePageRound();
    renderSamePage();
    sendSamePageSnapshot();
  }

  async function handleSamePageInput(message) {
    if (!state.isHost || upgrade.selectedGame !== SAME_PAGE_GAME || !rememberGameEvent(message.eventId)) return;
    if (!samePage.state || message.roundId !== samePage.state.roundId) return;
    if (message.action === 'answer-commit') await processSamePageCommit('guest', message.payload.commit, message.roundId);
    else if (message.action === 'answer-reveal') await processSamePageReveal('guest', message.payload, message.roundId);
    else if (message.action === 'next') advanceSamePageRound();
    else if (message.action === 'restart') restartSamePageSession();
  }

  function handleGameProtocolMessage(message) {
    if (message.session !== upgrade.roomViewSession) return;
    if (message.t === 'game-reset') {
      if (!state.isHost) {
        if (message.game === SAME_PAGE_GAME) resetSamePageLocalState();
        if (message.game === DRAW_GAME) resetDrawingState();
      }
      return;
    }
    if (message.game === SAME_PAGE_GAME) {
      if (message.t === 'game-state') {
        if (state.isHost || message.action !== 'snapshot' || !rememberGameEvent(message.eventId)) return;
        setSamePageStateFromSnapshot(message);
      } else if (message.t === 'game-input') handleSamePageInput(message);
    } else if (message.game === DRAW_GAME) {
      if (message.t === 'game-state') handleDrawingState(message);
      else if (message.t === 'game-input') handleDrawingInput(message);
    }
    window.dispatchEvent(new CustomEvent('same-room-game-message', { detail: message }));
  }

  function sendGuestSamePageCommit() {
    const game = samePage.state;
    if (state.isHost || !game || game.phase !== 'answering' || !samePage.local || game.commits.guest || !connectedSecurely()) return;
    if (samePage.commitSentFor === game.roundId) return;
    samePage.commitSentFor = game.roundId;
    send({
      t: 'game-input', game: SAME_PAGE_GAME, action: 'answer-commit', roundId: game.roundId,
      eventId: randomId(12), version: game.version, session: upgrade.roomViewSession,
      payload: { commit: samePage.local.commit }
    });
  }

  async function chooseSamePageAnswer(answer) {
    const game = samePage.state;
    const question = currentQuestion();
    if (!game || !question || game.phase !== 'answering' || samePage.local || !connectedSecurely()) return;
    if (!Number.isSafeInteger(answer) || answer < 0 || answer >= question.a.length) return;
    const nonce = randomId(18);
    const role = localSamePageRole();
    const commit = await samePageCommitment(game.roundId, role, answer, nonce, game.gameSessionId);
    if (!samePage.state || samePage.state.roundId !== game.roundId || samePage.state.phase !== 'answering') return;
    samePage.local = { answer, nonce, commit };
    saveLocalSamePageAnswer();
    renderSamePage();
    if (state.isHost) await processSamePageCommit('host', commit, game.roundId);
    else sendGuestSamePageCommit();
  }

  async function maybeSendGuestReveal() {
    const game = samePage.state;
    if (state.isHost || !game || game.phase !== 'revealing' || samePage.revealSentFor === game.roundId || !connectedSecurely()) return;
    const hostValid = await verifySamePageReveal('host', game.reveals.host);
    if (!hostValid) {
      const status = document.querySelector('#sr-sp-status');
      if (status) status.textContent = 'The reveal could not be verified. Return to the game list and start again.';
      return;
    }
    restoreLocalSamePageAnswer();
    if (!samePage.local || samePage.local.commit !== game.commits.guest) {
      const status = document.querySelector('#sr-sp-status');
      if (status) status.textContent = 'Your locked answer could not be restored. Return to the game list and start again.';
      return;
    }
    const guestValid = await verifySamePageReveal('guest', { answer: samePage.local.answer, nonce: samePage.local.nonce });
    if (!guestValid || !samePage.state || samePage.state.roundId !== game.roundId || samePage.state.phase !== 'revealing') return;
    samePage.revealSentFor = game.roundId;
    send({
      t: 'game-input', game: SAME_PAGE_GAME, action: 'answer-reveal', roundId: game.roundId,
      eventId: randomId(12), version: game.version, session: upgrade.roomViewSession,
      payload: { answer: samePage.local.answer, nonce: samePage.local.nonce }
    });
  }

  function requestSamePageAdvance() {
    const game = samePage.state;
    if (!game || !connectedSecurely()) return;
    if (state.isHost) {
      if (game.phase === 'revealed') advanceSamePageRound();
      else if (game.phase === 'complete') restartSamePageSession();
      return;
    }
    const action = game.phase === 'complete' ? 'restart' : 'next';
    send({
      t: 'game-input', game: SAME_PAGE_GAME, action, roundId: game.roundId,
      eventId: randomId(12), version: game.version, session: upgrade.roomViewSession, payload: {}
    });
  }

  function renderSamePageReveal(container, game, question) {
    container.replaceChildren();
    if (game.phase === 'revealed') {
      const hostAnswer = formatSamePageText(question.a[game.reveals.host.answer]);
      const guestAnswer = formatSamePageText(question.a[game.reveals.guest.answer]);
      if (game.reveals.host.answer === game.reveals.guest.answer) {
        const match = document.createElement('div');
        match.className = 'sr-sp-match';
        const answer = document.createElement('strong');
        answer.textContent = hostAnswer;
        const line = document.createElement('span');
        const lines = ['You found the same page.', 'Same answer, lovely timing.', 'A little match for the two of you.', 'You both picked this one.'];
        line.textContent = lines[(game.roundNumber - 1) % lines.length];
        match.append(answer, line);
        container.append(match);
      } else {
        const different = document.createElement('div');
        different.className = 'sr-sp-different';
        [['host', hostAnswer], ['guest', guestAnswer]].forEach(([role, text]) => {
          const card = document.createElement('div');
          card.className = 'sr-sp-answer';
          const name = document.createElement('small');
          name.textContent = samePageName(role);
          const answer = document.createElement('strong');
          answer.textContent = text;
          card.append(name, answer);
          different.append(card);
        });
        container.append(different);
      }
    } else if (game.phase === 'complete') {
      const complete = document.createElement('p');
      complete.className = 'sr-sp-complete';
      complete.textContent = `You answered all ${SAME_PAGE_QUESTIONS.length} questions without repeats. Start a new set whenever you are ready.`;
      container.append(complete);
    }
  }

  function renderSamePage() {
    const questionElement = document.querySelector('#sr-sp-question');
    const options = document.querySelector('#sr-sp-options');
    const status = document.querySelector('#sr-sp-status');
    const progress = document.querySelector('#sr-sp-progress');
    const matchCount = document.querySelector('#sr-sp-match-count');
    const reveal = document.querySelector('#sr-sp-reveal');
    const next = document.querySelector('#sr-sp-next');
    if (!questionElement || !options || !status || !progress || !matchCount || !reveal || !next) return;
    const focusedOption = document.activeElement && document.activeElement.classList.contains('sr-sp-option')
      ? Array.from(options.children).indexOf(document.activeElement)
      : -1;
    options.replaceChildren();
    reveal.replaceChildren();
    reveal.hidden = true;
    next.hidden = true;
    const game = samePage.state;
    if (!game) {
      questionElement.textContent = 'Waiting for the first question';
      progress.textContent = `Question 1 of ${SAME_PAGE_QUESTIONS.length}`;
      matchCount.textContent = 'Matches: 0';
      status.textContent = connectedSecurely() ? 'Starting the game together.' : 'The game will begin when both people are connected.';
      return;
    }
    progress.textContent = game.phase === 'complete' ? 'Set complete' : `Question ${game.roundNumber} of ${SAME_PAGE_QUESTIONS.length}`;
    matchCount.textContent = `Matches: ${game.matchCount}`;
    if (game.phase === 'complete') {
      questionElement.textContent = 'You made it through the whole set';
      status.textContent = 'No question repeated in this session.';
      reveal.hidden = false;
      renderSamePageReveal(reveal, game, null);
      next.textContent = 'Start a new set';
      next.hidden = false;
      next.disabled = !connectedSecurely();
      return;
    }
    const question = currentQuestion();
    if (!question) return;
    questionElement.textContent = question.q;
    question.a.forEach((rawOption, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sr-sp-option';
      button.textContent = formatSamePageText(rawOption);
      const selected = Boolean(samePage.local && samePage.local.answer === index);
      button.setAttribute('aria-pressed', String(selected));
      button.disabled = game.phase !== 'answering' || Boolean(samePage.local) || !connectedSecurely();
      button.addEventListener('click', () => chooseSamePageAnswer(index));
      options.append(button);
    });
    if (focusedOption >= 0 && focusedOption < options.children.length && game.phase === 'answering' && !samePage.local) {
      options.children[focusedOption].focus({ preventScroll: true });
    }
    if (game.phase === 'answering') {
      const localRole = localSamePageRole();
      const otherRole = otherSamePageRole();
      const localLocked = Boolean(samePage.local || game.commits[localRole]);
      const otherLocked = Boolean(game.commits[otherRole]);
      if (!connectedSecurely()) status.textContent = 'Reconnecting. Your locked answer will be restored.';
      else if (localLocked && !otherLocked) status.textContent = `Waiting for ${samePageName(otherRole)} to choose.`;
      else if (!localLocked && otherLocked) status.textContent = `${samePageName(otherRole)} has chosen. Your answer stays private until you choose.`;
      else if (localLocked && otherLocked) status.textContent = 'Both answers are locked. Revealing together.';
      else status.textContent = 'Choose privately. Your answer is revealed only after both of you answer.';
    } else if (game.phase === 'revealing') {
      status.textContent = 'Both answers are locked. Revealing together.';
    } else if (game.phase === 'revealed') {
      status.textContent = game.reveals.host.answer === game.reveals.guest.answer ? 'You matched on this one.' : 'Two different answers, both now on the table.';
      reveal.hidden = false;
      renderSamePageReveal(reveal, game, question);
      next.textContent = 'Next question';
      next.hidden = false;
      next.disabled = !connectedSecurely();
    }
  }

  function openPrivateChat() {
    const toggle = document.querySelector('#sr-chat-toggle');
    if (!toggle) return;
    if (!upgrade.chatOpen) toggle.click();
    else {
      const input = document.querySelector('#sr-chat-input');
      if (input) input.focus();
    }
  }

  function drawingName(role) {
    return samePageName(role);
  }

  function drawingPointCount(strokes = drawing.state && drawing.state.strokes) {
    return Array.isArray(strokes) ? strokes.reduce((total, stroke) => total + stroke.points.length, 0) : 0;
  }

  function rememberDrawingEvent(eventId) {
    if (drawing.seenEvents.has(eventId)) return false;
    drawing.seenEvents.add(eventId);
    drawing.seenOrder.push(eventId);
    while (drawing.seenOrder.length > 800) drawing.seenEvents.delete(drawing.seenOrder.shift());
    return true;
  }

  function clearDrawingPointer() {
    clearInterval(drawing.flushTimer);
    drawing.flushTimer = null;
    drawing.pointerId = null;
    drawing.activeStrokeId = '';
    drawing.buffer.length = 0;
    drawing.batchSeq = 0;
  }

  function resetDrawingState() {
    clearDrawingPointer();
    drawing.state = null;
    drawing.historyLimitReached = false;
    drawing.syncAfterSnapshot = false;
    drawing.seenEvents.clear();
    drawing.seenOrder.length = 0;
    renderDrawing();
  }

  function chooseDrawingWord(used) {
    let available = DRAW_WORDS.map((_, index) => index).filter(index => !used.includes(index));
    if (!available.length) {
      used.length = 0;
      available = DRAW_WORDS.map((_, index) => index);
    }
    const index = available[cryptoRandomIndex(available.length)];
    used.push(index);
    return index;
  }

  function newDrawingRound(previous = null, keepDrawer = false) {
    const used = previous ? [...previous.usedWordIndices] : [];
    const wordIndex = chooseDrawingWord(used);
    const drawer = previous ? (keepDrawer ? previous.drawer : (previous.drawer === 'host' ? 'guest' : 'host')) : 'host';
    return {
      bankVersion: DRAW_BANK_VERSION,
      gameSessionId: previous ? previous.gameSessionId : randomId(12),
      version: previous ? previous.version + 1 : 1,
      roundId: randomId(12),
      phase: 'drawing',
      roundNumber: previous ? (keepDrawer ? previous.roundNumber : previous.roundNumber + 1) : 1,
      guessedCount: previous ? previous.guessedCount : 0,
      drawer,
      wordIndex,
      word: DRAW_WORDS[wordIndex],
      usedWordIndices: used,
      endReason: '',
      lastGuess: '',
      strokes: []
    };
  }

  function startDrawingSession() {
    resetDrawingState();
    drawing.state = newDrawingRound();
    renderDrawing();
  }

  function serializableDrawingStrokes(strokes = drawing.state && drawing.state.strokes) {
    return Array.isArray(strokes) ? strokes.map(stroke => ({
      id: stroke.id,
      color: stroke.color,
      size: stroke.size,
      points: stroke.points.map(point => [point[0], point[1]])
    })) : [];
  }

  function serializableDrawingState() {
    if (!drawing.state) return null;
    const game = drawing.state;
    const remoteIsDrawer = game.drawer === 'guest';
    return {
      bankVersion: DRAW_BANK_VERSION,
      gameSessionId: game.gameSessionId,
      phase: game.phase,
      roundNumber: game.roundNumber,
      guessedCount: game.guessedCount,
      drawer: game.drawer,
      word: game.phase === 'ended' || remoteIsDrawer ? game.word : '',
      endReason: game.endReason,
      lastGuess: game.lastGuess,
      strokes: serializableDrawingStrokes(game.strokes)
    };
  }

  function sendDrawingSnapshot() {
    if (!state.isHost || upgrade.selectedGame !== DRAW_GAME || !drawing.state || !connectedSecurely()) return;
    send({
      t: 'game-state', game: DRAW_GAME, action: 'snapshot', roundId: drawing.state.roundId,
      eventId: randomId(12), version: drawing.state.version, session: upgrade.roomViewSession,
      payload: serializableDrawingState()
    });
  }

  function sendDrawingBatchState(batch) {
    if (!state.isHost || !drawing.state || !connectedSecurely()) return;
    send({
      t: 'game-state', game: DRAW_GAME, action: 'draw-batch', roundId: drawing.state.roundId,
      eventId: randomId(12), version: drawing.state.version, session: upgrade.roomViewSession,
      payload: batch
    });
  }

  function sendDrawingInput(action, payload = {}) {
    if (state.isHost || !drawing.state || !connectedSecurely()) return;
    send({
      t: 'game-input', game: DRAW_GAME, action, roundId: drawing.state.roundId,
      eventId: randomId(12), version: drawing.state.version, session: upgrade.roomViewSession,
      payload
    });
  }

  function strokeById(id) {
    return drawing.state && drawing.state.strokes.find(stroke => stroke.id === id);
  }

  function applyDrawingBatch(batch) {
    const game = drawing.state;
    if (!game || game.phase !== 'drawing') return false;
    let stroke = strokeById(batch.strokeId);
    if (!stroke) {
      if (!batch.start || game.strokes.length >= MAX_DRAW_STROKES) return false;
      stroke = { id: batch.strokeId, color: batch.color, size: batch.size, points: [], lastSeq: -1 };
      game.strokes.push(stroke);
    }
    if (stroke.color !== batch.color || stroke.size !== batch.size || batch.seq <= (stroke.lastSeq ?? -1)) return false;
    if (drawingPointCount() + batch.points.length > MAX_DRAW_POINTS) {
      drawing.historyLimitReached = true;
      renderDrawing();
      return false;
    }
    stroke.points.push(...batch.points.map(point => [point[0], point[1]]));
    stroke.lastSeq = batch.seq;
    redrawDrawingCanvas();
    return true;
  }

  function sendDrawingHistorySync() {
    const game = drawing.state;
    if (state.isHost || !game || game.phase !== 'drawing' || game.drawer !== 'guest' || !connectedSecurely()) return;
    drawing.syncAfterSnapshot = false;
    sendDrawingInput('history-sync', { strokes: serializableDrawingStrokes(game.strokes) });
  }

  function setDrawingStateFromSnapshot(message) {
    const payload = message.payload;
    const previous = drawing.state;
    const preserveLocalHistory = Boolean(
      drawing.syncAfterSnapshot && previous && previous.roundId === message.roundId && previous.phase === 'drawing' &&
      previous.drawer === 'guest' && payload.phase === 'drawing' && payload.drawer === 'guest' &&
      drawingPointCount(previous.strokes) >= drawingPointCount(payload.strokes)
    );
    const localStrokes = preserveLocalHistory ? serializableDrawingStrokes(previous.strokes) : null;
    if (previous && previous.gameSessionId === payload.gameSessionId && message.version < previous.version && !preserveLocalHistory) return;
    drawing.state = {
      ...payload,
      version: message.version,
      roundId: message.roundId,
      wordIndex: payload.word ? DRAW_WORDS.indexOf(payload.word) : -1,
      usedWordIndices: previous && previous.gameSessionId === payload.gameSessionId ? [...(previous.usedWordIndices || [])] : [],
      strokes: (localStrokes || payload.strokes).map(stroke => ({ ...stroke, points: stroke.points.map(point => [...point]), lastSeq: -1 }))
    };
    drawing.historyLimitReached = false;
    renderDrawing();
    if (preserveLocalHistory) sendDrawingHistorySync();
    else drawing.syncAfterSnapshot = false;
  }

  function normalizeGuess(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function simpleSingular(value) {
    const words = normalizeGuess(value).split(' ');
    const last = words.pop() || '';
    let singular = last;
    if (last.endsWith('ies') && last.length > 3) singular = `${last.slice(0, -3)}y`;
    else if (last.endsWith('es') && last.length > 3) singular = last.slice(0, -2);
    else if (last.endsWith('s') && !last.endsWith('ss') && last.length > 2) singular = last.slice(0, -1);
    words.push(singular);
    return words.join(' ');
  }

  function drawingGuessMatches(guess, word) {
    const a = normalizeGuess(guess);
    const b = normalizeGuess(word);
    return Boolean(a && b && (a === b || simpleSingular(a) === simpleSingular(b)));
  }

  function finishDrawingRound(reason, lastGuess = '') {
    if (!drawing.state || drawing.state.phase !== 'drawing') return;
    drawing.state.phase = 'ended';
    drawing.state.endReason = reason;
    drawing.state.lastGuess = lastGuess;
    if (reason === 'guessed') drawing.state.guessedCount += 1;
    drawing.state.version += 1;
    clearDrawingPointer();
    renderDrawing();
    sendDrawingSnapshot();
  }

  function processDrawingAction(action, payload, actorRole) {
    const game = drawing.state;
    if (!state.isHost || !game) return;
    const drawer = game.drawer;
    const guesser = drawer === 'host' ? 'guest' : 'host';
    if (action === 'draw-batch') {
      if (game.phase !== 'drawing' || actorRole !== drawer || !applyDrawingBatch(payload)) return;
      game.version += 1;
      sendDrawingBatchState(payload);
      return;
    }
    if (action === 'history-sync') {
      if (game.phase !== 'drawing' || actorRole !== 'guest' || drawer !== 'guest') return;
      game.strokes = payload.strokes.map(stroke => ({ ...stroke, points: stroke.points.map(point => [...point]), lastSeq: -1 }));
      game.version += 1;
      renderDrawing();
      sendDrawingSnapshot();
      return;
    }
    if (action === 'undo') {
      if (game.phase !== 'drawing' || actorRole !== drawer || !game.strokes.length) return;
      game.strokes.pop();
      game.version += 1;
      drawing.historyLimitReached = false;
      renderDrawing();
      sendDrawingSnapshot();
      return;
    }
    if (action === 'clear') {
      if (game.phase !== 'drawing' || actorRole !== drawer || !game.strokes.length) return;
      game.strokes = [];
      game.version += 1;
      drawing.historyLimitReached = false;
      renderDrawing();
      sendDrawingSnapshot();
      return;
    }
    if (action === 'guess') {
      if (game.phase !== 'drawing' || actorRole !== guesser) return;
      const text = payload.text;
      if (drawingGuessMatches(text, game.word)) finishDrawingRound('guessed', text);
      else {
        game.lastGuess = `${drawingName(actorRole)} guessed “${text}”`;
        game.version += 1;
        renderDrawing();
        sendDrawingSnapshot();
      }
      return;
    }
    if (action === 'reveal-word') {
      if (game.phase !== 'drawing' || actorRole !== guesser) return;
      finishDrawingRound('revealed');
      return;
    }
    if (action === 'skip-word') {
      if (game.phase !== 'drawing' || actorRole !== drawer) return;
      clearDrawingPointer();
      drawing.state = newDrawingRound(game, true);
      drawing.historyLimitReached = false;
      renderDrawing();
      sendDrawingSnapshot();
      return;
    }
    if (action === 'next-round') {
      if (game.phase !== 'ended') return;
      drawing.state = newDrawingRound(game, false);
      drawing.historyLimitReached = false;
      renderDrawing();
      sendDrawingSnapshot();
    }
  }

  function requestDrawingAction(action, payload = {}) {
    if (!drawing.state || !connectedSecurely()) return;
    if (state.isHost) processDrawingAction(action, payload, 'host');
    else sendDrawingInput(action, payload);
  }

  function handleDrawingInput(message) {
    if (!state.isHost || upgrade.selectedGame !== DRAW_GAME || !rememberDrawingEvent(message.eventId)) return;
    if (!drawing.state || message.roundId !== drawing.state.roundId) return;
    processDrawingAction(message.action, message.payload, 'guest');
  }

  function handleDrawingState(message) {
    if (state.isHost || upgrade.selectedGame !== DRAW_GAME || !rememberDrawingEvent(message.eventId)) return;
    if (message.action === 'snapshot') {
      setDrawingStateFromSnapshot(message);
      return;
    }
    if (!drawing.state || message.roundId !== drawing.state.roundId || message.action !== 'draw-batch') return;
    if (message.version < drawing.state.version) return;
    applyDrawingBatch(message.payload);
    drawing.state.version = Math.max(drawing.state.version, message.version);
    renderDrawingStatusOnly();
  }

  function canvasPoint(event) {
    const canvas = document.querySelector('#sr-dg-canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return [
      Math.max(0, Math.min(1000, Math.round(((event.clientX - rect.left) / rect.width) * 1000))),
      Math.max(0, Math.min(1000, Math.round(((event.clientY - rect.top) / rect.height) * 1000)))
    ];
  }

  function drawStrokeOnContext(ctx, stroke) {
    if (!stroke.points.length) return;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    ctx.lineWidth = stroke.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (stroke.points.length === 1) {
      const [x, y] = stroke.points[0];
      ctx.beginPath();
      ctx.arc(x, y, stroke.size / 2, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
    for (let index = 1; index < stroke.points.length; index += 1) ctx.lineTo(stroke.points[index][0], stroke.points[index][1]);
    ctx.stroke();
  }

  function redrawDrawingCanvas() {
    const canvas = document.querySelector('#sr-dg-canvas');
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#F5F1EA';
    ctx.fillRect(0, 0, width, height);
    ctx.setTransform(width / 1000, 0, 0, height / 1000, 0, 0);
    if (drawing.state) drawing.state.strokes.forEach(stroke => drawStrokeOnContext(ctx, stroke));
  }

  function flushDrawingPoints() {
    const game = drawing.state;
    const stroke = drawing.activeStrokeId && strokeById(drawing.activeStrokeId);
    if (!game || !stroke || !drawing.buffer.length || game.phase !== 'drawing') return;
    while (drawing.buffer.length) {
      const points = drawing.buffer.splice(0, MAX_DRAW_BATCH_POINTS);
      const batch = {
        strokeId: stroke.id,
        seq: drawing.batchSeq,
        color: stroke.color,
        size: stroke.size,
        start: drawing.batchSeq === 0,
        points
      };
      stroke.lastSeq = drawing.batchSeq;
      drawing.batchSeq += 1;
      if (state.isHost) {
        drawing.state.version += 1;
        sendDrawingBatchState(batch);
      } else sendDrawingInput('draw-batch', batch);
    }
  }

  function localCanDraw() {
    return Boolean(drawing.state && drawing.state.phase === 'drawing' && drawing.state.drawer === localSamePageRole() && connectedSecurely() && !drawing.historyLimitReached);
  }

  function beginDrawing(event) {
    if (!localCanDraw() || event.button > 0) return;
    const point = canvasPoint(event);
    if (!point || drawingPointCount() >= MAX_DRAW_POINTS || drawing.state.strokes.length >= MAX_DRAW_STROKES) {
      drawing.historyLimitReached = true;
      renderDrawing();
      return;
    }
    const canvas = event.currentTarget;
    drawing.pointerId = event.pointerId;
    drawing.activeStrokeId = randomId(10);
    drawing.batchSeq = 0;
    drawing.buffer = [point];
    drawing.state.strokes.push({ id: drawing.activeStrokeId, color: drawing.color, size: drawing.size, points: [point], lastSeq: -1 });
    try { canvas.setPointerCapture(event.pointerId); } catch (error) {}
    redrawDrawingCanvas();
    clearInterval(drawing.flushTimer);
    drawing.flushTimer = setInterval(flushDrawingPoints, DRAW_BATCH_INTERVAL_MS);
    event.preventDefault();
  }

  function continueDrawing(event) {
    if (drawing.pointerId !== event.pointerId || !localCanDraw()) return;
    const point = canvasPoint(event);
    const stroke = strokeById(drawing.activeStrokeId);
    if (!point || !stroke) return;
    const previous = stroke.points[stroke.points.length - 1];
    if (previous && Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 2) return;
    if (drawingPointCount() >= MAX_DRAW_POINTS) {
      drawing.historyLimitReached = true;
      endDrawing(event);
      renderDrawing();
      return;
    }
    stroke.points.push(point);
    drawing.buffer.push(point);
    redrawDrawingCanvas();
    event.preventDefault();
  }

  function endDrawing(event) {
    if (drawing.pointerId !== event.pointerId) return;
    flushDrawingPoints();
    clearInterval(drawing.flushTimer);
    drawing.flushTimer = null;
    drawing.pointerId = null;
    drawing.activeStrokeId = '';
    drawing.buffer.length = 0;
    drawing.batchSeq = 0;
    try { event.currentTarget.releasePointerCapture(event.pointerId); } catch (error) {}
    event.preventDefault();
  }

  function renderDrawingStatusOnly() {
    const status = document.querySelector('#sr-dg-status');
    if (!status || !drawing.state) return;
    const game = drawing.state;
    if (!connectedSecurely()) status.textContent = 'Reconnecting. The current drawing will be restored.';
    else if (drawing.historyLimitReached) status.textContent = 'This drawing reached its safe history limit. Use undo, clear, or move to the next word.';
    else if (game.phase === 'ended') status.textContent = game.endReason === 'guessed' ? 'The word was guessed.' : 'The word was revealed.';
    else if (game.lastGuess) status.textContent = `${game.lastGuess}. Keep going.`;
    else if (game.drawer === localSamePageRole()) status.textContent = `Draw for ${drawingName(otherSamePageRole())}. Strokes sync in small batches.`;
    else status.textContent = `Watch ${drawingName(otherSamePageRole())} draw and type your guess.`;
  }

  function renderDrawing() {
    const title = document.querySelector('#sr-dg-title');
    const instruction = document.querySelector('#sr-dg-instruction');
    const word = document.querySelector('#sr-dg-word');
    const round = document.querySelector('#sr-dg-round');
    const count = document.querySelector('#sr-dg-count');
    const tools = document.querySelector('#sr-dg-tools');
    const guessForm = document.querySelector('#sr-dg-guess-form');
    const guessInput = document.querySelector('#sr-dg-guess');
    const result = document.querySelector('#sr-dg-result');
    const next = document.querySelector('#sr-dg-next');
    const canvas = document.querySelector('#sr-dg-canvas');
    const limit = document.querySelector('#sr-dg-limit');
    if (!title || !instruction || !word || !round || !count || !tools || !guessForm || !result || !next || !canvas || !limit) return;
    const game = drawing.state;
    result.hidden = true;
    next.hidden = true;
    limit.hidden = !drawing.historyLimitReached;
    if (drawing.historyLimitReached) limit.textContent = 'Drawing history limit reached. Existing strokes are safe.';
    if (!game) {
      title.textContent = 'Waiting for the round';
      instruction.textContent = connectedSecurely() ? 'Starting the drawing game together.' : 'The game will begin when both people are connected.';
      word.hidden = true;
      tools.hidden = true;
      guessForm.hidden = true;
      round.textContent = 'Round 1';
      count.textContent = 'Words guessed: 0';
      canvas.setAttribute('aria-disabled', 'true');
      redrawDrawingCanvas();
      return;
    }
    const localRole = localSamePageRole();
    const isDrawer = game.drawer === localRole;
    round.textContent = `Round ${game.roundNumber}`;
    count.textContent = `Words guessed: ${game.guessedCount}`;
    title.textContent = game.phase === 'ended' ? 'Round complete' : (isDrawer ? 'You draw' : `${drawingName(game.drawer)} is drawing`);
    instruction.textContent = game.phase === 'ended'
      ? 'Start the next round when you are both ready. The drawing role will swap.'
      : (isDrawer ? `Draw the word without saying it. ${drawingName(otherSamePageRole())} will guess.` : 'Type guesses as the picture takes shape.');
    word.hidden = !(game.word && (isDrawer || game.phase === 'ended'));
    word.textContent = game.word ? `Word: ${game.word}` : '';
    const canDraw = isDrawer && game.phase === 'drawing';
    const canGuess = !isDrawer && game.phase === 'drawing';
    tools.hidden = !canDraw;
    guessForm.hidden = !canGuess;
    canvas.setAttribute('aria-disabled', String(!canDraw || !connectedSecurely()));
    canvas.setAttribute('aria-label', canDraw ? 'Shared drawing canvas. Draw with a finger, pen, or mouse.' : 'Shared drawing canvas. The current picture appears here.');
    document.querySelectorAll('.sr-dg-color').forEach(button => {
      button.disabled = !connectedSecurely();
      button.setAttribute('aria-pressed', String(button.dataset.color === drawing.color));
    });
    document.querySelectorAll('.sr-dg-size').forEach(button => {
      button.disabled = !connectedSecurely();
      button.setAttribute('aria-pressed', String(Number(button.dataset.size) === drawing.size));
    });
    ['#sr-dg-undo', '#sr-dg-clear'].forEach(selector => {
      const button = document.querySelector(selector);
      if (button) button.disabled = !connectedSecurely() || !game.strokes.length;
    });
    const skip = document.querySelector('#sr-dg-skip');
    if (skip) skip.disabled = !connectedSecurely();
    const reveal = document.querySelector('#sr-dg-reveal');
    const submit = document.querySelector('#sr-dg-submit');
    if (guessInput) guessInput.disabled = !connectedSecurely();
    if (submit) submit.disabled = !connectedSecurely();
    if (reveal) reveal.disabled = !connectedSecurely();
    if (game.phase === 'ended') {
      result.hidden = false;
      result.replaceChildren();
      const strong = document.createElement('strong');
      strong.textContent = game.word;
      const line = document.createElement('span');
      line.textContent = game.endReason === 'guessed'
        ? `${drawingName(game.drawer === 'host' ? 'guest' : 'host')} guessed it. Roles swap next round.`
        : 'The word was revealed. Roles swap next round.';
      result.append(strong, line);
      next.hidden = false;
      next.disabled = !connectedSecurely();
    }
    renderDrawingStatusOnly();
    requestAnimationFrame(redrawDrawingCanvas);
  }

  function installDrawingInterface() {
    const button = document.querySelector('#sr-game-draw-and-guess');
    const back = document.querySelector('#sr-dg-back-games');
    const home = document.querySelector('#sr-dg-home');
    const chat = document.querySelector('#sr-dg-chat');
    const gamesChat = document.querySelector('#sr-games-chat');
    const samePageChat = document.querySelector('#sr-sp-chat');
    const canvas = document.querySelector('#sr-dg-canvas');
    const form = document.querySelector('#sr-dg-guess-form');
    if (!button || !back || !home || !chat || !gamesChat || !samePageChat || !canvas || !form) return;
    button.addEventListener('click', () => requestGameSelect(DRAW_GAME));
    back.addEventListener('click', () => requestGameSelect(''));
    home.addEventListener('click', () => requestRoomView('home'));
    [chat, gamesChat, samePageChat].forEach(control => control.addEventListener('click', openPrivateChat));
    document.querySelectorAll('.sr-dg-color').forEach(control => control.addEventListener('click', () => {
      if (DRAW_COLORS.has(control.dataset.color)) drawing.color = control.dataset.color;
      renderDrawing();
    }));
    document.querySelectorAll('.sr-dg-size').forEach(control => control.addEventListener('click', () => {
      const size = Number(control.dataset.size);
      if (DRAW_SIZES.has(size)) drawing.size = size;
      renderDrawing();
    }));
    document.querySelector('#sr-dg-undo').addEventListener('click', () => requestDrawingAction('undo'));
    document.querySelector('#sr-dg-clear').addEventListener('click', () => requestDrawingAction('clear'));
    document.querySelector('#sr-dg-skip').addEventListener('click', () => requestDrawingAction('skip-word'));
    document.querySelector('#sr-dg-reveal').addEventListener('click', () => requestDrawingAction('reveal-word'));
    document.querySelector('#sr-dg-next').addEventListener('click', () => requestDrawingAction('next-round'));
    form.addEventListener('submit', event => {
      event.preventDefault();
      const input = document.querySelector('#sr-dg-guess');
      const text = input.value.replace(/\s+/g, ' ').trim().slice(0, 60);
      if (!text) return;
      requestDrawingAction('guess', { text });
      input.value = '';
    });
    canvas.addEventListener('pointerdown', beginDrawing);
    canvas.addEventListener('pointermove', continueDrawing);
    canvas.addEventListener('pointerup', endDrawing);
    canvas.addEventListener('pointercancel', endDrawing);
    window.addEventListener('resize', () => requestAnimationFrame(redrawDrawingCanvas));
    window.addEventListener('orientationchange', () => setTimeout(redrawDrawingCanvas, 120));
    if ('ResizeObserver' in window) new ResizeObserver(() => redrawDrawingCanvas()).observe(canvas);
    window.SameRoomDrawing = Object.freeze({
      words: () => [...DRAW_WORDS],
      state: () => drawing.state ? JSON.parse(JSON.stringify(drawing.state)) : null,
      batchingInterval: DRAW_BATCH_INTERVAL_MS,
      maximumBatchPoints: MAX_DRAW_BATCH_POINTS,
      maximumHistoryPoints: MAX_DRAW_POINTS
    });
  }

  function applySelectedGameUI() {
    document.body.classList.toggle('sr-game-same-page', upgrade.roomView === 'games' && upgrade.selectedGame === SAME_PAGE_GAME);
    document.body.classList.toggle('sr-game-draw-and-guess', upgrade.roomView === 'games' && upgrade.selectedGame === DRAW_GAME);
    renderSamePage();
    renderDrawing();
  }

  function installModeInterface() {
    const watch = document.querySelector('#sr-choose-watch');
    const games = document.querySelector('#sr-choose-games');
    const watchHome = document.querySelector('#sr-watch-home');
    const gamesHome = document.querySelector('#sr-games-home');
    const samePageButton = document.querySelector('#sr-game-same-page');
    const samePageBack = document.querySelector('#sr-sp-back-games');
    const samePageHome = document.querySelector('#sr-sp-home');
    const samePageNext = document.querySelector('#sr-sp-next');
    if (!watch || !games || !watchHome || !gamesHome || !samePageButton || !samePageBack || !samePageHome || !samePageNext) return;
    watch.addEventListener('click', () => requestRoomView('watch'));
    games.addEventListener('click', () => requestRoomView('games'));
    watchHome.addEventListener('click', () => requestRoomView('home'));
    gamesHome.addEventListener('click', () => requestRoomView('home'));
    samePageButton.addEventListener('click', () => requestGameSelect(SAME_PAGE_GAME));
    samePageBack.addEventListener('click', () => requestGameSelect(''));
    samePageHome.addEventListener('click', () => requestRoomView('home'));
    samePageNext.addEventListener('click', requestSamePageAdvance);
    installDrawingInterface();
    applyRoomView('home', upgrade.roomViewVersion);
    setModeControlsEnabled(false);
    window.SameRoomModes = Object.freeze({
      current: () => upgrade.roomView,
      request: requestRoomView,
      selectedGame: () => upgrade.selectedGame
    });
    window.SameRoomSamePage = Object.freeze({
      questions: () => SAME_PAGE_QUESTIONS.map(question => ({ q: question.q, a: [...question.a] })),
      state: () => samePage.state ? JSON.parse(JSON.stringify(samePage.state)) : null
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
        renderSamePage();
        renderDrawing();
      }
      send({ t: 'name', name: state.myName });
      broadcastState();
      if (state.isHost) sendCurrentRoomView();
    }
    else if (message.t === 'name') {
      state.theirName = sanitizeName(message.name);
      updateNameLabels();
      renderSamePage();
      renderDrawing();
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
    if (!state.isHost && samePage.state) {
      samePage.commitSentFor = '';
      if (samePage.state.phase === 'revealing') samePage.revealSentFor = '';
    }
    if (!state.isHost && drawing.state && drawing.state.phase === 'drawing' && drawing.state.drawer === 'guest') {
      drawing.syncAfterSnapshot = true;
    }
    renderSamePage();
    renderDrawing();
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
      if (!state.isHost) {
        samePage.commitSentFor = '';
        samePage.revealSentFor = '';
      }
      renderSamePage();
      renderDrawing();
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
    document.body.classList.add('sr-room-active');
    state.onStage = true;
    upgrade.roomView = 'home';
    upgrade.roomViewVersion = 1;
    upgrade.roomViewSession = asHost ? randomId(12) : '';
    upgrade.selectedGame = '';
    upgrade.gameVersion = 0;
    resetSamePageLocalState(false);
    resetDrawingState();
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
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && upgrade.chatOpen) {
        event.preventDefault();
        closeChat();
      }
    });

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
      body:not(.sr-room-active) #sr-chat-toggle,body:not(.sr-room-active) #sr-chat-panel{display:none!important}
      #sr-chat-toggle{position:fixed;right:14px;bottom:calc(78px + var(--safe-b));z-index:24;display:flex;align-items:center;gap:7px;min-width:44px;min-height:44px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:#22202B;color:var(--dust);box-shadow:0 10px 28px rgba(0,0,0,.38);font:600 13px/1 ui-sans-serif,-apple-system,"Segoe UI",Roboto,sans-serif}
      #sr-chat-toggle:hover{border-color:#4A4657}
      #sr-chat-toggle:focus-visible,#sr-chat-close:focus-visible,#sr-chat-send:focus-visible{outline:2px solid var(--amber);outline-offset:3px}
      #sr-chat-badge{display:grid;place-items:center;min-width:19px;height:19px;padding:0 5px;border-radius:999px;background:var(--rose);color:#180C0C;font-size:10px}
      #sr-chat-badge[hidden]{display:none}
      #sr-chat-panel{position:fixed;right:12px;top:12px;bottom:calc(76px + var(--safe-b));z-index:26;width:min(360px,calc(100vw - 24px));border:1px solid var(--line);border-radius:16px;background:rgba(22,21,28,.98);box-shadow:0 24px 70px rgba(0,0,0,.55);overflow:hidden}
      #sr-chat-panel[hidden]{display:none}
      #sr-chat-panel{grid-template-rows:auto minmax(0,1fr) auto auto}
      #sr-chat-panel:not([hidden]){display:grid}
      .sr-chat-header{display:flex;align-items:center;justify-content:space-between;padding:13px 14px;border-bottom:1px solid var(--line)}
      .sr-chat-header>div{display:grid;gap:2px}.sr-chat-header strong{font-size:14px}.sr-chat-header span{font-size:11px;color:var(--dust-dim)}
      #sr-chat-close{width:44px;height:44px;border:0;border-radius:9px;background:transparent;color:var(--dust);font-size:25px;line-height:1}
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
      #sr-chat-send{min-height:44px;padding:0 14px;border:1px solid var(--amber);border-radius:11px;background:var(--amber);color:#1A1206;font-weight:700}
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
        if (state.isHost) sendCurrentRoomView();
      }
    }
  });

  injectStyles();
  injectEntrySecurity();
  installModeInterface();
  injectChat();
  installLeaveProtection();
})();
