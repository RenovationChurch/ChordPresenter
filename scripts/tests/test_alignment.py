"""
Chord-alignment tests: build real .pro bytes, decode them with parse_pro.py,
and check every chord is anchored to the character it was written over.

Run from the repo root:
    python3 -m unittest discover -s scripts/tests
"""

import os
import sys
import tempfile
import textwrap
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from create_pro_song import build_slide                      # noqa: E402
from md_to_pro import parse_md_song, _squeeze_spaces         # noqa: E402
from parse_pro import (_parse_slide_chords, _slide_lyric_lines,  # noqa: E402
                       parse_pro_file)
from song_to_pro import build_from_song, layout_slide         # noqa: E402


def decode(slide_blob):
    """(slide text as ProPresenter sees it, {pos: chord}) for one slide blob."""
    # build_slide returns the slide message itself; parse_pro expects it
    # wrapped the way it sits inside the file (field 13 payload) — same bytes.
    return '\n'.join(_slide_lyric_lines(slide_blob)), _parse_slide_chords(slide_blob)


def chord_targets(text, positions):
    """{chord: the 4 characters it sits on} — easy to eyeball in failures."""
    return {c: text[p:p + 4] for p, c in sorted(positions.items())}


class ChordOverLyricMapping(unittest.TestCase):
    """The .md / URL path: chord lines above lyric lines."""

    def parse(self, body):
        with tempfile.NamedTemporaryFile('w', suffix='.md', delete=False) as f:
            f.write('---\ntitle: "Test"\n---\n```\n' + textwrap.dedent(body) + '\n```\n')
        try:
            _, _, _, chord_map = parse_md_song(f.name)
        finally:
            os.unlink(f.name)
        return [(lyric, pos) for _, pairs in chord_map for lyric, pos in pairs]

    def test_leading_spaces_on_chord_line_are_kept(self):
        [(lyric, pos)] = self.parse("""
            [Verse 1]
                    G         C
            Amazing grace how sweet
        """)
        self.assertEqual(chord_targets(lyric, pos), {'G': 'grac', 'C': 'swee'})

    def test_collapsed_spaces_move_chords_with_their_words(self):
        [(lyric, pos)] = self.parse("""
            [Verse 1]
            D      Em       G
            That   saved a  wretch
        """)
        self.assertEqual(lyric, 'That saved a wretch')
        self.assertEqual(chord_targets(lyric, pos), {'D': 'That', 'Em': 'save', 'G': 'wret'})

    def test_chord_inside_a_gap_lands_on_next_word(self):
        text, pos = _squeeze_spaces('gave    me', {6: 'Dm'})
        self.assertEqual(text, 'gave me')
        self.assertEqual(chord_targets(text, pos), {'Dm': 'me'})


class SlideLayout(unittest.TestCase):
    """The slide-editor path: exact positions, any number of lines per slide."""

    def test_positions_on_later_lines_are_offset_by_earlier_lines(self):
        texts, pos = layout_slide([
            {'text': 'Amazing grace', 'chords': [{'pos': 8, 'chord': 'G'}]},
            {'text': 'how sweet the sound', 'chords': [{'pos': 4, 'chord': 'C'}]},
            {'text': 'that saved', 'chords': [{'pos': 0, 'chord': 'D'}]},
        ], with_chords=True)
        joined = '\n'.join(texts)
        self.assertEqual(chord_targets(joined, pos), {'G': 'grac', 'C': 'swee', 'D': 'that'})

    def test_chord_after_last_word_gets_a_space_to_sit_on(self):
        texts, pos = layout_slide([{'text': 'Oh', 'chords': [
            {'pos': 0, 'chord': 'C'}, {'pos': 2, 'chord': 'G'}]}], with_chords=True)
        self.assertEqual(texts, ('Oh ',))
        self.assertEqual(pos, {0: 'C', 2: 'G'})

    def test_two_chords_on_one_spot_are_both_kept(self):
        _, pos = layout_slide([{'text': 'Holy', 'chords': [
            {'pos': 0, 'chord': 'G'}, {'pos': 0, 'chord': 'D/F#'}]}], with_chords=True)
        self.assertEqual(pos, {0: 'G', 1: 'D/F#'})

    def test_lyrics_only_drops_chords(self):
        _, pos = layout_slide([{'text': 'Holy', 'chords': [{'pos': 0, 'chord': 'G'}]}],
                              with_chords=False)
        self.assertEqual(pos, {})


class RoundTripThroughProBytes(unittest.TestCase):
    """What ProPresenter would actually read back out of the file."""

    def test_three_line_slide_round_trips(self):
        texts, pos = layout_slide([
            {'text': 'Amazing grace', 'chords': [{'pos': 8, 'chord': 'G'}]},
            {'text': 'how sweet the sound', 'chords': [{'pos': 4, 'chord': 'C'}]},
            {'text': 'that saved a wretch', 'chords': [{'pos': 13, 'chord': 'D7'}]},
        ], with_chords=True)
        blob, _ = build_slide(*texts, chord_positions=pos)
        text, decoded = decode(blob)
        self.assertEqual(text, 'AMAZING GRACE\nHOW SWEET THE SOUND\nTHAT SAVED A WRETCH')
        self.assertEqual(chord_targets(text, decoded), {'G': 'GRAC', 'C': 'SWEE', 'D7': 'WRET'})

    def test_whole_song_with_repeated_chorus_in_arrangement(self):
        song = {
            'title': 'Test Song', 'key': 'G',
            'sections': [
                {'name': 'Verse 1', 'slides': [{'lines': [
                    {'text': 'Line one', 'chords': [{'pos': 5, 'chord': 'G'}]},
                    {'text': 'Line two', 'chords': []}]}]},
                {'name': 'Chorus', 'slides': [{'lines': [
                    {'text': 'Sing it', 'chords': [{'pos': 5, 'chord': 'C'}]}]}]},
            ],
            'arrangement': [0, 1, 0, 1],
        }
        with tempfile.NamedTemporaryFile(suffix='.pro', delete=False) as f:
            f.write(build_from_song(song))
        try:
            parsed = parse_pro_file(f.name)
        finally:
            os.unlink(f.name)
        # Opening spacer is skipped; the repeated Chorus is listed once.
        self.assertEqual([(s['group'], s['lines']) for s in parsed['slides']], [
            ('Verse 1', ['LINE ONE', 'LINE TWO']),
            ('Chorus', ['SING IT']),
        ])

    def test_characters_outside_latin1_do_not_crash_or_shift_chords(self):
        texts, pos = layout_slide([{'text': 'Ōsanna straße Jesus',
                                    'chords': [{'pos': 15, 'chord': 'A'}]}], with_chords=True)
        blob, _ = build_slide(*texts, chord_positions=pos)
        self.assertEqual(pos, {15: 'A'})        # 'ß' did not become 'SS'
        self.assertIn(b'\\u332?', blob)          # Ō written as an RTF unicode escape


if __name__ == '__main__':
    unittest.main()
