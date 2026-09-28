#!/usr/bin/env python3
"""
song_to_pro.py — Build a .pro file from ChordPresenter's slide editor.

The slide editor has already decided everything: which lines
go on which slide, and which chord sits over which character. This script only
lays that out as ProPresenter slides — no heuristics, so what you see in the
editor preview is what lands on the stage display.

Usage:
  python3 song_to_pro.py --song-json PATH --out DIR

Song JSON:
{
  "title": "Amazing Grace", "artist": "", "key": "G", "capo": 0,
  "notes": "optional stage-display note for the first slide",
  "text_case": "upper",                      // or "asis", "line"
  "opening": {"name": "Opening", "count": 2}, // count 0 = no blank slides
  "style": {"font_name": "HelveticaNeue-Bold", "font_family": "Helvetica Neue",
            "font_size": 110, "line_bars": true, "shrink_to_fit": true},
  "chord_key": "G",                          // key the chords are written in
  "file_name": "Amazing Grace - G",          // optional; ".pro" is added
  "sections": [
    {"name": "Verse 1", "slides": [
      {"lines": [{"text": "Amazing grace how sweet the sound",
                  "chords": [{"pos": 8, "chord": "G"}]}],
       "notes": "optional slide notes (stage display only)"}
    ]}
  ],
  "arrangement": [0, 1, 2, 1]          // optional: section indices, repeats allowed
}

How chords line up in ProPresenter: every chord is a text attribute anchored to
a character index in the slide's text, where the lines are joined with ONE
newline character. So a chord at position 3 of line 2 is stored at
len(line 1) + 1 + 3. Chords past the end of a line get spaces added so they
still have a character to sit on.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from create_pro_song import build_pro_file          # noqa: E402
from md_to_pro import _safe_filename                # noqa: E402


def layout_slide(lines: list[dict], with_chords: bool) -> tuple[tuple, dict]:
    """Turn editor lines into (line texts, {slide_char_pos: chord})."""
    texts: list[str] = []
    positions: dict[int, str] = {}
    offset = 0
    for line in lines:
        text = str(line.get('text', ''))
        chords = (line.get('chords') or []) if with_chords else []
        taken: set[int] = set()
        for c in sorted(chords, key=lambda c: int(c.get('pos', 0))):
            name = str(c.get('chord', '')).strip()
            if not name:
                continue
            pos = max(0, int(c.get('pos', 0)))
            while pos in taken:          # "[G][D]" — two chords, same spot
                pos += 1
            taken.add(pos)
            if pos >= len(text):         # chord after the last word
                text = text.ljust(pos + 1)
            positions[offset + pos] = name
        if not text:
            text = ' '                   # keep the line (and every offset) intact
        texts.append(text)
        offset += len(text) + 1          # +1 for the line break
    return tuple(texts) or ('',), positions


def build_from_song(song: dict) -> bytes:
    with_chords = not song.get('lyrics_only', False)
    case = song.get('text_case') or 'upper'
    opening = song.get('opening') or {'name': 'Opening', 'count': 2}
    n_open = max(0, min(20, int(opening.get('count', 2) or 0)))

    sections, chord_data = [], []
    slide_notes: dict[int, str] = {}
    if n_open:                                       # blank slides for the operator
        name = str(opening.get('name') or 'Opening')
        sections.append((name, [''] * n_open))
        chord_data.append((name, [{}] * n_open))
    slide_index = n_open
    for sec in song.get('sections', []):
        name = str(sec.get('name') or 'Slide')
        slide_entries, slide_chords = [], []
        for slide in sec.get('slides', []):
            lines = slide.get('lines') or []
            if not lines:
                continue
            texts, positions = layout_slide(lines, with_chords)
            slide_entries.append(texts)
            slide_chords.append(positions)
            if slide.get('notes'):
                slide_notes[slide_index] = str(slide['notes'])
            slide_index += 1
        if slide_entries:
            sections.append((name, slide_entries))
            chord_data.append((name, slide_chords))

    # The capo note goes on the first slide — an opening slide if there is
    # one, otherwise ahead of the first song slide's own notes.
    if song.get('notes'):
        first = slide_notes.get(0)
        slide_notes[0] = song['notes'] + (f'\n\n{first}' if first else '')

    # Arrangement indices refer to song["sections"]; shift past the opening
    # group and drop any that point at a section that ended up empty.
    order = None
    arrangement = song.get('arrangement') or []
    if arrangement:
        index_of = {}
        built = 1 if n_open else 0
        for i, sec in enumerate(song.get('sections', [])):
            if any(sl.get('lines') for sl in sec.get('slides', [])):
                index_of[i] = built
                built += 1
        order = ([0] if n_open else []) + [
            index_of[i] for i in arrangement if isinstance(i, int) and i in index_of]

    return build_pro_file(display_name(song),
                          sections, arrangement_name='DoubleThickTheme',
                          chord_data=chord_data,
                          slide_notes=slide_notes or None,
                          arrangement_order=order or None,
                          case=case if case in ('upper', 'asis', 'line') else 'upper',
                          style=song.get('style') or None,
                          music_key=None if song.get('lyrics_only') else song.get('chord_key'))


def display_name(song: dict) -> str:
    title, artist = song.get('title') or 'Untitled', song.get('artist') or ''
    return _safe_filename(f'{title} - {artist}' if artist else title)


def output_name(song: dict) -> str:
    """The .pro file name: the one chosen in the export dialog, or
    "Title - Artist - Key (Capo N).pro". Never a path — separators are removed."""
    chosen = _safe_filename(str(song.get('file_name') or '')).strip(' .')
    if chosen:
        return chosen if chosen.lower().endswith('.pro') else chosen + '.pro'
    display = display_name(song)
    key = _safe_filename(song.get('key') or '')
    capo = int(song.get('capo') or 0)
    return f"{display}{f' - {key}' if key else ''}{f' (Capo {capo})' if capo else ''}.pro"


def main() -> int:
    ap = argparse.ArgumentParser(description='Slide-editor JSON → ProPresenter .pro')
    ap.add_argument('--song-json', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()

    with open(args.song_json, 'r', encoding='utf-8') as f:
        song = json.load(f)
    if not args.out.strip():
        print('No output folder configured.', file=sys.stderr)
        return 1
    os.makedirs(args.out, exist_ok=True)

    data = build_from_song(song)
    name = output_name(song)
    with open(os.path.join(args.out, name), 'wb') as f:
        f.write(data)

    total = sum(len(s.get('slides', [])) for s in song.get('sections', []))
    print(f"Title: {song.get('title', '')}")
    print(f'  → {name}')
    print(f'     {total} slides, {len(data):,} bytes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
