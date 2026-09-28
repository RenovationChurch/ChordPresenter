"""
Slide settings: opening slides, capitalization, slide notes.

Run from the repo root:
    python3 -m unittest discover -s scripts/tests
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from create_pro_song import apply_case                       # noqa: E402
from parse_pro import (_parse_arrangement_order, _parse_groups,  # noqa: E402
                       parse_pro_file, read_proto_fields)
from song_to_pro import build_from_song                      # noqa: E402

SONG = {
    'title': 'Great Things', 'key': 'B',
    'sections': [
        {'name': 'Verse 1', 'slides': [
            {'lines': [{'text': 'Come, let us worship our King', 'chords': [{'pos': 0, 'chord': 'B'}]}],
             'notes': 'Hero: (dropout)'}]},
        {'name': 'Chorus', 'slides': [{'lines': [{'text': 'O Hero of Heaven', 'chords': []}]}]},
    ],
    'arrangement': [0, 1, 1],
}


def build(**overrides):
    song = {**SONG, **overrides}
    with tempfile.NamedTemporaryFile(suffix='.pro', delete=False) as f:
        f.write(build_from_song(song))
    return f.name


def groups_in_order(path):
    with open(path, 'rb') as f:
        top = read_proto_fields(f.read())
    groups = {gu: (name, len(slides)) for gu, name, slides in _parse_groups(top)}
    return [groups[g] for g in _parse_arrangement_order(top)]


class OpeningSlides(unittest.TestCase):
    def tearDown(self):
        os.unlink(self.path)

    def test_default_is_two_blank_slides_named_opening(self):
        self.path = build()
        self.assertEqual(groups_in_order(self.path),
                         [('Opening', 2), ('Verse 1', 1), ('Chorus', 1), ('Chorus', 1)])

    def test_custom_name_and_count(self):
        self.path = build(opening={'name': 'Walk-in', 'count': 3})
        self.assertEqual(groups_in_order(self.path)[0], ('Walk-in', 3))
        # Edit .pro mode skips it when told the same settings
        parsed = parse_pro_file(self.path, opening_name='Walk-in', opening_count=3)
        self.assertEqual(parsed['slides'][0]['group'], 'Verse 1')

    def test_turned_off(self):
        self.path = build(opening={'name': 'Opening', 'count': 0})
        self.assertEqual(groups_in_order(self.path),
                         [('Verse 1', 1), ('Chorus', 1), ('Chorus', 1)])


class Capitalization(unittest.TestCase):
    def test_modes(self):
        self.assertEqual(apply_case('Come, let us worship', 'upper'), 'COME, LET US WORSHIP')
        self.assertEqual(apply_case('Come, let us worship', 'asis'), 'Come, let us worship')
        self.assertEqual(apply_case("'twas grace", 'line'), "'Twas grace")

    def test_as_written_reaches_the_file(self):
        path = build(text_case='asis')
        try:
            lines = [s['lines'] for s in parse_pro_file(path)['slides']]
        finally:
            os.unlink(path)
        self.assertEqual(lines[0], ['Come, let us worship our King'])


class SlideNotes(unittest.TestCase):
    def test_per_slide_notes_and_capo_note_share_the_first_slide_without_opening(self):
        path = build(opening={'count': 0}, notes='CAPO 4 - chords are G shapes')
        try:
            with open(path, 'rb') as f:
                data = f.read()
        finally:
            os.unlink(path)
        self.assertIn(b'CAPO 4 - chords are G shapes\\\n\\\nHero: (dropout)', data)


if __name__ == '__main__':
    unittest.main()
