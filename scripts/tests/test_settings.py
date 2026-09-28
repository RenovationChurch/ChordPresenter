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

from create_pro_song import apply_case, build_slide          # noqa: E402
from parse_pro import (_parse_arrangement_order, _parse_groups,  # noqa: E402
                       _parse_slide_chords, parse_pro_file, read_proto_fields)
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


def _fields(buf):
    """Minimal protobuf walk: [(field, wire_type, value_or_bytes)]."""
    from parse_pro import decode_varint
    out, pos = [], 0
    while pos < len(buf):
        tag, pos = decode_varint(buf, pos)
        f, wire = tag >> 3, tag & 7
        if wire == 0:
            v, pos = decode_varint(buf, pos)
        elif wire == 2:
            n, pos = decode_varint(buf, pos)
            v, pos = buf[pos:pos + n], pos + n
        else:
            size = 8 if wire == 1 else 4
            v, pos = buf[pos:pos + size], pos + size
        out.append((f, wire, v))
    return out


def text_rules(slide_blob):
    """[(kind, range_end, value)] for each per-character rule on the slide text:
    kind 2 = capitalization, 7 = chord, 12 = font."""
    from parse_pro import _decode_range, _get_path
    rules = []
    for f, _, entry in _fields(_get_path(slide_blob, [10, 23, 2, 1, 1, 1, 13, 3])):
        if f != 13:
            continue
        parts = {sf: v for sf, _, v in _fields(entry)}
        kind = next(k for k in parts if k != 1)
        rules.append((kind, _decode_range(parts[1])[1], parts[kind] if kind == 2 else None))
    return rules


class TextRulesCoverWholeSlide(unittest.TestCase):
    """The template's ALL CAPS rule used to cover only its first 13 characters,
    so ProPresenter showed "HE HAS DONE Great things" in "as written" mode."""

    LINES = ('He has done great things', 'See what our Savior has done')

    def test_all_caps_covers_every_character(self):
        blob, _ = build_slide(*self.LINES, case='upper')
        total = len(self.LINES[0]) + 1 + len(self.LINES[1])
        self.assertEqual(text_rules(blob), [(2, total, 1), (12, total, None)])

    def test_as_written_has_no_caps_rule(self):
        blob, _ = build_slide(*self.LINES, chord_positions={0: 'B'}, case='asis')
        total = len(self.LINES[0]) + 1 + len(self.LINES[1])
        self.assertEqual(text_rules(blob)[0], (12, total, None))
        self.assertNotIn(2, [kind for kind, _, _ in text_rules(blob)])
        self.assertEqual(_parse_slide_chords(blob), {0: 'B'})


class SlideStyle(unittest.TestCase):
    """Font, size, black line bars and shrink-to-fit on the lyric text box."""

    def element(self, **style):
        from create_pro_song import ELEMENT, _get
        blob, _ = build_slide('Great things', style=style or None)
        return blob, _get(blob, ELEMENT)

    def test_default_keeps_the_bars(self):
        _, el = self.element()
        self.assertEqual([f for f, _, _ in _fields(el)].count(14), 1)   # text_line_mask
        self.assertIn(9, [f for f, _, _ in _fields(el)])                # black fill

    def test_bars_off_removes_mask_and_fill(self):
        _, el = self.element(line_bars=False)
        self.assertNotIn(14, [f for f, _, _ in _fields(el)])
        self.assertNotIn(9, [f for f, _, _ in _fields(el)])

    def test_font_and_size_reach_rtf_and_attributes(self):
        blob, _ = self.element(font_name='HelveticaNeue-Bold', font_family='Helvetica Neue', font_size=110)
        self.assertIn(b'\\fcharset0 HelveticaNeue-Bold;}', blob)
        self.assertIn(b'\\fs220 ', blob)
        self.assertIn(b'Helvetica Neue', blob)
        self.assertNotIn(b'Tungsten', blob)

    def test_shrink_to_fit(self):
        from create_pro_song import TEXT, _get
        blob, _ = self.element(shrink_to_fit=True)
        self.assertIn((7, 0, 2), _fields(_get(blob, TEXT)))            # scale_behavior = shrink

    def test_font_names_are_sanitized(self):
        blob, _ = self.element(font_name='Evil;}{\\rtf')
        self.assertIn(b'\\fcharset0 Evilrtf;}', blob)


class SongKey(unittest.TestCase):
    def test_key_written_as_original_and_user_key(self):
        from create_pro_song import build_music
        # MusicKeyScale { music_key = 4 (B), music_scale = 0 (major) }
        self.assertEqual(build_music('B'), b'\x1a\x04\x08\x04\x10\x00' + b'\x22\x04\x08\x04\x10\x00')
        self.assertEqual(build_music('F#m')[2:6], b'\x08\x11\x10\x01')   # F# = 17, minor
        self.assertEqual(build_music(''), b'')

    def test_in_the_file(self):
        path = build(chord_key='G')
        try:
            with open(path, 'rb') as f:
                top = read_proto_fields(f.read())
        finally:
            os.unlink(path)
        self.assertEqual(top[23], [b'\x1a\x04\x08\x13\x10\x00\x22\x04\x08\x13\x10\x00'])  # G = 19


class FileName(unittest.TestCase):
    def test_chosen_name_is_used_and_cannot_escape_the_folder(self):
        from song_to_pro import output_name
        self.assertEqual(output_name({**SONG, 'file_name': 'Great Things'}), 'Great Things.pro')
        self.assertEqual(output_name({**SONG, 'file_name': '../../etc/x.pro'}), '-..-etc-x.pro')
        self.assertEqual(output_name(SONG), 'Great Things - B.pro')


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
