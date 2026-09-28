#!/usr/bin/env python3
"""
pro_key.py — Read or change the song key stored in a ProPresenter .pro file.

A .pro keeps two keys (Presentation.Music): the ORIGINAL key the chords are
written in, and the USER key to show them in. When they differ, ProPresenter
transposes the stage-display chords by itself. ProPresenter only offers a key
picker for MultiTracks songs, so this sets the user key directly in the file.
Only that part of the file changes; lyrics and chords are left as they are.

Usage:
  python3 pro_key.py PATH                     # {"original": "G", "user": "G"}
  python3 pro_key.py PATH --user A            # show the chords in A
  python3 pro_key.py PATH --user A --original G   # also (re)state the original key

Prints one JSON object ({"error": ...} on failure).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from create_pro_song import build_music, encode_lv, read_music, _set_field   # noqa: E402


def set_key(path: str, user: str, original: str | None = None) -> dict:
    with open(path, 'rb') as f:
        data = f.read()
    current_original, _ = read_music(data)
    original = original or current_original
    if not original:
        raise ValueError('This file has no original key yet — choose the key its chords are written in.')
    music = build_music(original, user)
    if not music:
        raise ValueError(f'Not a key ProPresenter can store: {original!r} / {user!r}')
    data = _set_field(data, 23, encode_lv(23, music))
    # Write a sibling temp file, then swap it in, so a failure can't leave a half-written .pro.
    fd, tmp = tempfile.mkstemp(suffix='.pro', dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    new_original, new_user = read_music(data)
    return {'original': new_original, 'user': new_user}


def main() -> int:
    ap = argparse.ArgumentParser(description='Read or change the key stored in a .pro file')
    ap.add_argument('path')
    ap.add_argument('--user', help='Key ProPresenter should show the chords in')
    ap.add_argument('--original', help='Key the chords are written in')
    args = ap.parse_args()
    try:
        if not args.path.lower().endswith('.pro'):
            raise ValueError('Not a .pro file')
        if args.user:
            result = set_key(args.path, args.user, args.original)
        else:
            with open(args.path, 'rb') as f:
                original, user = read_music(f.read())
            result = {'original': original, 'user': user}
    except Exception as e:
        result = {'error': str(e)}
    print(json.dumps(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
