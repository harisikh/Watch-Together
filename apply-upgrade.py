#!/usr/bin/env python3
"""Insert the Same Room upgrade script tag into index.html safely."""
from __future__ import annotations

import argparse
from pathlib import Path
import shutil
import sys

TAG = '<script src="./sameroom-upgrade.js"></script>'


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("index", nargs="?", default="index.html", help="Path to index.html")
    args = parser.parse_args()

    path = Path(args.index)
    if not path.is_file():
        print(f"Error: {path} does not exist.", file=sys.stderr)
        return 1

    text = path.read_text(encoding="utf-8")
    if TAG in text:
        print(f"Already installed in {path}.")
        return 0
    marker = "</body>"
    if marker not in text:
        print(f"Error: {path} has no </body> tag.", file=sys.stderr)
        return 1

    backup = path.with_suffix(path.suffix + ".backup")
    shutil.copy2(path, backup)
    text = text.replace(marker, f"{TAG}\n{marker}", 1)
    path.write_text(text, encoding="utf-8")
    print(f"Installed upgrade in {path}. Backup written to {backup}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
