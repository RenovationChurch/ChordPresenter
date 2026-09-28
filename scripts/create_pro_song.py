#!/usr/bin/env python3
"""
create_pro_song.py — ProPresenter .pro song file creator
DoubleThickTheme standard: TungstenNarrow-Bold font, white text,
two thick black lines from theme.

Usage:
    python3 create_pro_song.py

Edit the SONG definition at the bottom of this file with your lyrics,
then run. The .pro file will be saved to SONGS_OUTPUT_DIR.

Lyrics format per section:
    A list where each entry is ONE SLIDE:
      "Single line"           → one-line slide
      ("Line 1", "Line 2")   → two-line slide with explicit hard line break
                                (use for short paired phrases like "Oh hallelujah / I'm clean")

    Keep individual lines to roughly 25 chars or fewer for the DoubleThickTheme text box.
    Lines longer than ~28 chars will auto-wrap in ProPresenter — split them
    into a tuple with a natural breath break instead.
"""

from __future__ import annotations

import os
import re
import struct
import uuid

# ────────────────────────────────────────────────────────────────
# CONFIGURATION
# ────────────────────────────────────────────────────────────────

SONGS_OUTPUT_DIR = ""  # Always overridden by --out from the app; do not hardcode

# ────────────────────────────────────────────────────────────────
# PROTOBUF UTILITIES
# ────────────────────────────────────────────────────────────────

def encode_varint(n):
    out = []
    while n > 127:
        out.append((n & 0x7F) | 0x80)
        n >>= 7
    out.append(n)
    return bytes(out)

def decode_varint(data, pos):
    val, consumed = 0, 0
    for j in range(5):
        b = data[pos + j]
        val |= (b & 0x7F) << (7 * j)
        consumed += 1
        if not (b & 0x80):
            break
    return val, consumed

def encode_lv(field_num, content_bytes):
    """Encode a length-delimited protobuf field."""
    tag = encode_varint((field_num << 3) | 2)
    return tag + encode_varint(len(content_bytes)) + content_bytes

def new_uuid():
    return str(uuid.uuid4()).upper()

# ────────────────────────────────────────────────────────────────
# RTF BUILDER
# ────────────────────────────────────────────────────────────────

# Slide look. The template was designed for TungstenNarrow-Bold at 253 pt;
# line spacing, character tracking and the black line bars scale with size.
DEFAULT_STYLE = {
    'font_name': 'TungstenNarrow-Bold',   # PostScript name (what ProPresenter looks up)
    'font_family': 'Tungsten Narrow',
    'font_size': 253,                     # points, on a 1920x1080 slide
    'line_bars': True,                    # black bar behind each line of text
    'shrink_to_fit': False,               # let ProPresenter shrink text that overflows
    # ALL CAPS on the main (audience) output only: ProPresenter's display-time
    # capitalization, so the text itself -- what the stage display shows --
    # keeps the case chosen by `case`. None = follow `case` ('upper' -> on).
    'audience_caps': None,
}
_TEMPLATE_FONT_SIZE = 253


def _style(style=None):
    st = {**DEFAULT_STYLE, **{k: v for k, v in (style or {}).items() if v not in (None, '')}}
    st['font_size'] = max(8.0, min(400.0, float(st['font_size'])))
    st['line_bars'] = bool(st['line_bars'])
    st['shrink_to_fit'] = bool(st['shrink_to_fit'])
    if st['audience_caps'] is not None:
        st['audience_caps'] = bool(st['audience_caps'])
    # Font names go into RTF and protobuf strings -- keep them to safe characters.
    for key in ('font_name', 'font_family'):
        st[key] = re.sub(r'[^A-Za-z0-9 ._-]', '', str(st[key])) or DEFAULT_STYLE[key]
    return st


def _rtf_header(st):
    r = st['font_size'] / _TEMPLATE_FONT_SIZE
    return (
        '{\\rtf1\\ansi\\ansicpg1252\\cocoartf2870\n'
        '\\cocoatextscaling0\\cocoaplatform0'
        '{\\fonttbl\\f0\\fnil\\fcharset0 ' + st['font_name'] + ';}\n'
        '{\\colortbl;\\red255\\green255\\blue255;\\red255\\green255\\blue255;}\n'
        '{\\*\\expandedcolortbl;;\\cssrgb\\c100000\\c100000\\c100000;}\n'
        f'\\pard\\sl20\\slleading{round(882 * r)}\\pardirnatural\\qc\\partightenfactor0\n'
        '\n'
        f'\\f0\\fs{round(st["font_size"] * 2)} \\cf2 \\kerning1\\expnd{round(16 * r)}'
        f'\\expndtw{round(80 * r)}\n'
    )


RTF_HEADER = _rtf_header(DEFAULT_STYLE)

_UNICODE_MAP = str.maketrans({
    '‘': "'",  '’': "'",   # curly single quotes → straight
    '“': '"',  '”': '"',   # curly double quotes → straight
    '–': '-',  '—': '--',  # en/em dash → hyphen
    '…': '...', ' ': ' ',  # ellipsis, non-breaking space
})

def _upper_same_length(text):
    """Upper-case without changing length ('ß'.upper() is 'SS'), so chord
    character positions computed on the original text still line up."""
    return ''.join(u if len(u := ch.upper()) == 1 else ch for ch in text)


TEXT_CASES = ('upper', 'asis', 'line')


def apply_case(text, case='upper'):
    """Lyric capitalization, never changing the text's length:
    'upper' = ALL CAPS, 'asis' = as written, 'line' = first letter of the line
    capitalized. Mirrors applyCase in src/chordpro.ts."""
    if case == 'upper':
        return _upper_same_length(text)
    if case == 'line':
        for i, ch in enumerate(text):
            if ch.isalpha():
                up = ch.upper()
                return text[:i] + (up if len(up) == 1 else ch) + text[i + 1:]
    return text


def _slide_lines(lines, case='upper'):
    """The lines as they'll appear on the slide: first line always kept, later
    empty ones dropped, unicode tidied, capitalization applied."""
    kept = [lines[0] or ''] + [l for l in lines[1:] if l]
    return [apply_case(l.translate(_UNICODE_MAP), case) for l in kept]


def _text_length(lines):
    """Length of the slide text as ProPresenter counts it: lines joined by one
    newline, in UTF-16 units (what attribute ranges and chord positions use)."""
    text = '\n'.join(lines)
    return len(text) + sum(1 for ch in text if ord(ch) > 0xFFFF)


def build_rtf(*lines, case='upper', style=None):
    """Build RTF-encoded lyric bytes for one or more lines.

    Lines after the first are dropped when empty/None, so build_rtf(l1, None)
    keeps its old one-line behaviour. Each line break is ONE character in the
    text ProPresenter sees, which is what chord positions are counted against.
    """
    text = '\\\n'.join(_rtf_escape(l) for l in _slide_lines(lines, case))
    return (_rtf_header(_style(style)) + text + '}').encode('latin-1')

# ────────────────────────────────────────────────────────────────
# SLIDE BUILDER  (binary template — DoubleThickTheme format,
#                 confirmed working in ProPresenter)
# ────────────────────────────────────────────────────────────────

# Source UUIDs present in the template (each appears exactly once; all replaced per slide)
# Template slide: "oh hallelujah" from Example Song2ndedit.pro (slide 14)
TMPL_SLIDE_UUID  = b'546EA798-D078-41FF-8774-D30592A1E681'  # slide UUID  [4:40]
TMPL_ELEM_UUID1  = b'4266A8FE-54E5-483C-85E1-91E8331F5AD9'  # elem UUID1  [51:87]
TMPL_UUID_MID    = b'1820E643-4883-44BA-9F11-F3BFACACDEC4'  # mid UUID    [111:147]
TMPL_SUFFIX_UUID = b'F6936DDB-D9D7-4C01-ACF9-CBCE247FD559'  # suffix UUID [1170:1206]

# Where things live inside the template slide (Cue > action > slide >
# presentation slide > base slide > element > ...). Edits go through _edit(),
# which re-encodes every enclosing length, so nothing depends on byte offsets.
PRESENTATION_SLIDE = [10, 23, 2]
ELEMENT = PRESENTATION_SLIDE + [1, 1, 1]    # the lyric text box (Graphics.Element)
TEXT = ELEMENT + [13]                       # Graphics.Text: 3 attributes, 5 RTF, 7 scale behavior

# --- Template slide bytes (embedded — no external file dependency) ---
# Extracted from: Example Song2ndedit.pro, slide 14 ("oh hallelujah")
# DoubleThickTheme format: TungstenNarrow-Bold, fs502, slleading862, Outdoor position data
_TEMPLATE_HEX = (
    '0a260a2435343645413739382d443037382d343146462d383737342d44333035393241314536'
    '383128014200528b090a260a2434323636413846452d353445352d343833432d383545312d39'
    '31453833333146354144393001480bba01db0812d8080ad1080a8b080af0070a260a24313832'
    '30453634332d343838332d343442412d394631312d463342464143414344454334120d4c696e'
    '652031204c696e6520321a280a1209f85937988854324011602663c7670f4b4012120930453e'
    'bb5b8d9d4011cec2b7fccc90884029000000000000f03f429201080112060a0012001a001221'
    '0a0909000000000000f03f120909000000000000f03f1a0909000000000000f03f123c0a1209'
    '000000000000f03f11000000000000f03f121209000000000000f03f11000000000000f03f1a'
    '1209000000000000f03f11000000000000f03f12210a0911000000000000f03f120911000000'
    '000000f03f1a0911000000000000f03f1a0208014a090a05250000803f2001521f1100000000'
    '000008401a140d0000803f150000803f1d0000803f250000803f5a2b110000000000b0734019'
    '00000000000014402100000000000014402a05250000803f31000000000000e83f620911e3ba'
    '5a102bd4e13f6af4041ab6010a2f0a1354756e677374656e4e6172726f772d426f6c64110000'
    '000000606f404a0f54756e677374656e204e6172726f7710011a140d0000803f15ffff7f3f1d'
    'ffff7f3f250000803f2200321f080229000000000000f03f39000000000000f03f41cdcccccc'
    'cc8c45406a003900000000000010404a006a060a02100d10016a350a02100d622f0a1354756e'
    '677374656e4e6172726f772d426f6c64110000000000606f404a0f54756e677374656e204e61'
    '72726f77222b110000000000b07340190000000000002e402100000000000024402a05250000'
    '803f31000000000000e83f2ae4027b5c727466315c616e73695c616e7369637067313235325c'
    '636f636f61727466323837300a5c636f636f61746578747363616c696e67305c636f636f6170'
    '6c6174666f726d307b5c666f6e7474626c5c66305c666e696c5c666368617273657430205475'
    '6e677374656e4e6172726f772d426f6c643b7d0a7b5c636f6c6f7274626c3b5c726564323535'
    '5c677265656e3235355c626c75653235353b5c7265643235355c677265656e3235355c626c75'
    '653235353b7d0a7b5c2a5c657870616e646564636f6c6f7274626c3b3b5c6373737267625c63'
    '3130303030305c633130303030305c633130303030303b7d0a5c706172645c736c32305c736c'
    '6c656164696e673836325c7061726469726e61747572616c5c71635c7061727469676874656e'
    '666163746f72300a0a5c66305c6673353032205c636632205c6b65726e696e67315c6578706e'
    '6431365c6578706e64747738300a6f682068616c6c656c756a61687d3001420048015a072020'
    'e280a2202062161a140d3f357e3f155c8f423f1d6f12033d250000803f721408011100000000'
    '000020c01900000000008040c020034a1411000000000000e03f1801214281cb541d12ab3f2a'
    '05250000803f3212090000000000009e40110000000000e090403a260a244636393336444442'
    '2d443944372d344330312d414346392d434243453234374644353539220218016001'
)

LYRIC_TEMPLATE = bytes.fromhex(_TEMPLATE_HEX.replace(' ', '').replace('\n', ''))
assert len(LYRIC_TEMPLATE) == 1212, f'Template size={len(LYRIC_TEMPLATE)}, expected 1212'


def _build_chord_attr_bytes(chord_positions, text_len=0):
    """
    Encode chord CustomAttribute protobuf entries for Text.Attributes (field 13).

    chord_positions : dict {char_pos: chord_name}  (from _map_chord_positions)
    text_len        : length of the slide text -- the last chord's range runs
                      to the end of it, like chords written by ProPresenter
                      and Pro7ChordEditor (each range ends where the next begins).
    Returns bytes to append inside the Attributes message.

    Structure per chord:
      Attributes.CustomAttributes (field 13, LV) {
          CustomAttribute.Range (field 1, LV) {
              IntRange.Start (field 1, varint)
              IntRange.End   (field 2, varint)
          }
          CustomAttribute.Chord (field 7, LV string)
      }
    """
    if not chord_positions:
        return b''
    items = sorted(chord_positions.items())
    result = b''
    for i, (start_pos, chord_name) in enumerate(items):
        end_pos = items[i + 1][0] if i + 1 < len(items) else max(text_len, start_pos + 1)
        int_range = (encode_varint((1 << 3) | 0) + encode_varint(start_pos) +
                     encode_varint((2 << 3) | 0) + encode_varint(end_pos))
        ca = encode_lv(1, int_range) + encode_lv(7, chord_name.encode('utf-8'))
        result += encode_lv(13, ca)
    return result


def _iter_fields(buf):
    """Yield (field_number, raw_field_bytes) for each top-level protobuf field."""
    pos = 0
    while pos < len(buf):
        start = pos
        tag, n = decode_varint(buf, pos)
        pos += n
        wire = tag & 7
        if wire == 0:
            _, n = decode_varint(buf, pos)
            pos += n
        elif wire == 1:
            pos += 8
        elif wire == 5:
            pos += 4
        elif wire == 2:
            length, n = decode_varint(buf, pos)
            pos += n + length
        else:
            raise ValueError(f'unexpected wire type {wire}')
        yield tag >> 3, buf[start:pos]


def _payload(raw):
    """The contents of a length-delimited field, given its raw bytes."""
    _, n = decode_varint(raw, 0)
    length, m = decode_varint(raw, n)
    return raw[n + m:n + m + length]


def _get(msg, path):
    """The message at `path` (first match at each level)."""
    for field in path:
        msg = next(_payload(raw) for f, raw in _iter_fields(msg) if f == field)
    return msg


def _set_field(msg, field, raw):
    """Replace the first `field` in msg with `raw` (tagged bytes), remove it
    (raw=None), or insert it before the first higher-numbered field."""
    out, done = b'', False
    for f, old in _iter_fields(msg):
        if not done and f == field:
            out += raw or b''
            done = True
        elif not done and f > field and raw:
            out += raw + old
            done = True
        else:
            out += old
    return out if done or not raw else out + raw


def _edit(msg, path, fn):
    """Apply fn to the message at `path` (first match at each level) and
    rebuild every enclosing length."""
    if not path:
        return fn(msg)
    out, done = b'', False
    for f, raw in _iter_fields(msg):
        if not done and f == path[0]:
            out += encode_lv(f, _edit(_payload(raw), path[1:], fn))
            done = True
        else:
            out += raw
    if not done:
        raise KeyError(path)
    return out


def _varint_field(field, value):
    return encode_varint(field << 3) + encode_varint(value)


def _double_field(field, value):
    return encode_varint((field << 3) | 1) + struct.pack('<d', float(value))


def _font(st):
    """rv.data.Font { name = 1; size = 2; family = 9; }"""
    return (encode_lv(1, st['font_name'].encode()) + _double_field(2, st['font_size'])
            + encode_lv(9, st['font_family'].encode()))


# The template's Text.Attributes. Its per-character rules (ALL CAPS + font)
# only covered the template's own 13-character text ("oh hallelujah"), which
# left the rest of every slide un-capitalized in ProPresenter -- so they're
# rebuilt per slide to cover the whole text (_build_attributes).
def _build_attributes(text_len, case, chord_positions, st):
    """Text.Attributes for one slide: the template's base style with the
    chosen font, and per-character rules that cover the whole text.

    The capitalization rule is ProPresenter's display-time ALL CAPS: it
    changes how the text is drawn, not the text itself. It's on when
    st['audience_caps'] says so (default: when the text is ALL CAPS anyway),
    so lyrics can be stored as written for the stage display and still be
    capitals on the main output."""
    caps = (case == 'upper') if st['audience_caps'] is None else st['audience_caps']
    whole = encode_lv(1, _varint_field(2, text_len))           # IntRange 0..len
    out = b''
    for f, raw in _iter_fields(_get(LYRIC_TEMPLATE, TEXT + [3])):
        if f == 1:
            out += encode_lv(1, _font(st))                     # font
        elif f == 13 or (f == 2 and not caps):
            continue                                           # per-character rules / caps
        else:
            out += raw
    if caps:
        out += encode_lv(13, whole + _varint_field(2, 1))     # capitalization = ALL CAPS
    out += encode_lv(13, whole + encode_lv(12, _font(st)))    # original_font
    return out + _build_chord_attr_bytes(chord_positions or {}, text_len)


SLIDE_SIZE = (1920.0, 1080.0)


def _template_box_size():
    """(width, height) of the template's text box (Element.bounds.size)."""
    size = _get(LYRIC_TEMPLATE, ELEMENT + [3, 2])
    w = h = 0.0
    for f, raw in _iter_fields(size):
        value = struct.unpack('<d', raw[1:9])[0]
        if f == 1:
            w = value
        elif f == 2:
            h = value
    return w, h


def _centered_bounds():
    """Graphics.Rect for the text box, centered on the slide. (The template's
    box sat high: y 54-840 on a 1080-high slide.)"""
    w, h = _template_box_size()
    origin = _double_field(1, (SLIDE_SIZE[0] - w) / 2) + _double_field(2, (SLIDE_SIZE[1] - h) / 2)
    size = _double_field(1, w) + _double_field(2, h)
    return encode_lv(1, origin) + encode_lv(2, size)


def _style_element(element, st):
    """The text box: centered on the slide, with a black bar behind each line
    (Element.text_line_mask, painted with the box's fill) -- or no bars and
    no fill at all."""
    element = _set_field(element, 3, encode_lv(3, _centered_bounds()))
    if not st['line_bars']:
        return _set_field(_set_field(element, 14, None), 9, None)
    r = st['font_size'] / _TEMPLATE_FONT_SIZE
    mask = _varint_field(1, 1) + _double_field(2, -8 * r) + _double_field(3, -33 * r)
    return _set_field(element, 14, encode_lv(14, mask))


# Slide notes (PresentationSlide.notes, field 2) — shown on any stage layout
# that includes a "Slide Notes" object, never on the audience output.
# Layout matches notes written by ProPresenter itself:
#   PresentationSlide { base_slide=1, notes=2 { rtf_data=1, attributes=2 }, transition=4 }
# The template has no notes; they're set as PresentationSlide field 2.

_NOTES_RTF_HEADER = (
    '{\\rtf1\\ansi\\ansicpg1252\\cocoartf2870\n'
    '\\cocoatextscaling0\\cocoaplatform0{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;}\n'
    '{\\colortbl;\\red255\\green255\\blue255;}\n'
    '{\\*\\expandedcolortbl;;}\n'
    '\\pard\\pardirnatural\\partightenfactor0\n\n'
    '\\f0\\fs48 \\cf1 '
)


def _rtf_escape(text):
    out = []
    for ch in text:
        if ch in '\\{}':
            out.append('\\' + ch)
        elif ch == '\n':
            out.append('\\\n')
        elif ord(ch) > 127:
            out.append(f'\\u{ord(ch) if ord(ch) < 32768 else ord(ch) - 65536}?')
        else:
            out.append(ch)
    return ''.join(out)


def _build_notes_bytes(text):
    rtf = (_NOTES_RTF_HEADER + _rtf_escape(text) + '}').encode('latin-1')
    return encode_lv(2, encode_lv(1, rtf) + encode_lv(2, b''))


def build_slide(*lines, chord_positions=None, notes=None, case='upper', style=None):
    """
    Build a binary slide blob for one or more lyric lines.
    chord_positions : optional dict {char_pos: chord_name} for Vocals+Chords version.
    notes           : optional slide-notes text (stage display only).
    case            : lyric capitalization -- see apply_case().
    style           : font / size / bars -- see DEFAULT_STYLE.
    Returns (slide_bytes, slide_uuid_str).
    """
    st = _style(style)
    new_slide_uid = new_uuid().encode('ascii')

    # Fresh UUIDs (each template UUID appears exactly once)
    sb = (LYRIC_TEMPLATE
          .replace(TMPL_SLIDE_UUID, new_slide_uid)
          .replace(TMPL_ELEM_UUID1, new_uuid().encode('ascii'))
          .replace(TMPL_UUID_MID, new_uuid().encode('ascii'))
          .replace(TMPL_SUFFIX_UUID, new_uuid().encode('ascii')))

    attrs = _build_attributes(_text_length(_slide_lines(lines, case)), case, chord_positions, st)
    rtf = build_rtf(*lines, case=case, style=st)

    def text(t):
        t = _set_field(t, 3, encode_lv(3, attrs))
        t = _set_field(t, 5, encode_lv(5, rtf))
        # Graphics.Text.scale_behavior: 2 = shrink the font down to fit the box
        return _set_field(t, 7, _varint_field(7, 2) if st['shrink_to_fit'] else None)

    sb = _edit(sb, TEXT, text)
    sb = _edit(sb, ELEMENT, lambda e: _style_element(e, st))
    if notes:
        sb = _edit(sb, PRESENTATION_SLIDE, lambda ps: _set_field(ps, 2, _build_notes_bytes(notes)))
    return sb, new_slide_uid.decode('ascii')


# ────────────────────────────────────────────────────────────────
# GROUP / ARRANGEMENT BUILDERS
# ────────────────────────────────────────────────────────────────

def build_group(group_uuid, group_name, slide_uuids):
    """
    Build a field-12 group blob.
      group_uuid  : str UUID for this section
      group_name  : str label shown in ProPresenter ("Verse 1", "Chorus", …)
      slide_uuids : list of str UUIDs of the slides in this section
    """
    inner  = encode_lv(1, encode_lv(1, group_uuid.encode('ascii')))
    if group_name:
        inner += encode_lv(2, group_name.encode('utf-8'))
    inner += encode_lv(4, b'')        # empty field4 (required marker)
    field1 = encode_lv(1, inner)

    slide_refs = b''.join(
        encode_lv(2, encode_lv(1, uid.encode('ascii')))
        for uid in slide_uuids
    )
    return field1 + slide_refs


def build_arrangement(arr_uuid, arr_name, group_uuids):
    """Build a field-11 arrangement blob."""
    c  = encode_lv(1, encode_lv(1, arr_uuid.encode('ascii')))
    c += encode_lv(2, arr_name.encode('utf-8'))
    for g in group_uuids:
        c += encode_lv(3, encode_lv(1, g.encode('ascii')))
    return c


# ────────────────────────────────────────────────────────────────
# STATIC FILE METADATA  (copied from working songs)
# ────────────────────────────────────────────────────────────────

# ProPresenter file version/platform header (field 1)
FILE_META_HEX      = '08011206081a100518011801220f081510032209333532353138313738'
# Audio settings (field 8)
AUDIO_SETTINGS_HEX = '0a001801'
# Presentation flag (field 9)
FLAG9_HEX          = '1801'


# ────────────────────────────────────────────────────────────────
# .PRO FILE BUILDER
# ────────────────────────────────────────────────────────────────

def lines_to_slides(lines):
    """
    Convert a section's slide list into (line1, line2?) tuples for build_slide().

    Each entry in `lines` is ONE slide:
      "A single line"         → (line,)         — one-line slide
      ("Line 1", "Line 2", …) → (line1, line2, …) — multi-line slide, hard breaks
    """
    slides = []
    for entry in lines:
        if isinstance(entry, tuple):
            slides.append(entry)          # explicit multi-line slide
        else:
            slides.append((entry,))       # single-line slide
    return slides


# ProPresenter's key names (rv.data.MusicKeyScale.MusicKey)
_MUSIC_KEYS = ['Ab', 'A', 'A#', 'Bb', 'B', 'B#', 'Cb', 'C', 'C#', 'Db', 'D',
               'D#', 'Eb', 'E', 'E#', 'Fb', 'F', 'F#', 'Gb', 'G', 'G#']


def _key_scale(key):
    """rv.data.MusicKeyScale for a key name ("G", "F#m"), or b'' if unknown."""
    m = re.match(r'^([A-G][#b]?)(m(?!aj))?', (key or '').strip())
    if not m or m.group(1) not in _MUSIC_KEYS:
        return b''
    return (_varint_field(1, _MUSIC_KEYS.index(m.group(1)))     # music_key
            + _varint_field(2, 1 if m.group(2) else 0))         # music_scale: major / minor


def build_music(original, user=None):
    """Presentation.Music: the key the chords are written in (original) and
    the key ProPresenter should show them in (user; defaults to the same).
    When they differ, ProPresenter transposes the chords itself.
    Returns b'' for a key it can't name."""
    orig = _key_scale(original)
    if not orig:
        return b''
    return encode_lv(3, orig) + encode_lv(4, _key_scale(user) or orig)   # Music.original / .user


def read_music(presentation):
    """(original, user) key names from a .pro file's bytes (None if unset)."""
    names = {}
    for f, raw in _iter_fields(presentation):
        if f != 23:
            continue
        for sf, sraw in _iter_fields(_payload(raw)):
            if sf in (3, 4):
                key, scale = 0, 0
                for kf, kraw in _iter_fields(_payload(sraw)):
                    value, _ = decode_varint(kraw, 1)
                    key, scale = (value, scale) if kf == 1 else (key, value)
                if key < len(_MUSIC_KEYS):
                    names[sf] = _MUSIC_KEYS[key] + ('m' if scale == 1 else '')
    return names.get(3), names.get(4)


def build_pro_file(title, sections, arrangement_name="DoubleThickTheme", chord_data=None,
                   slide_notes=None, arrangement_order=None, case='upper', style=None,
                   music_key=None):
    """
    Build the complete binary content of a .pro file.

    title        : str — song title (shown in ProPresenter)
    sections     : list of (section_name, [slide_entry, …])
                   Each slide_entry is a str (1-line) or tuple (2-line).
    arrangement_name : str — shown in ProPresenter arrangement picker
    chord_data   : optional list parallel to sections:
                   [(section_name, [{char_pos: chord_name}, …]), …]
                   One chord dict per slide; pass None or {} for slides with no chords.
    slide_notes  : optional {slide_index: notes_text}, indexed across all sections.
    arrangement_order : optional list of indices into `sections` giving the
                   arrangement's play order; an index may repeat (Chorus twice)
                   and the group's slides are reused, not duplicated.
                   Default: every section once, in order.
    case         : lyric capitalization — 'upper' (default), 'asis', 'line'.
    style        : font / size / line bars — see DEFAULT_STYLE.
    music_key    : key the chords are written in ("G", "F#m") — lets
                   ProPresenter know the song's key and transpose from it.
    """
    song_uuid = new_uuid()
    arr_uuid  = new_uuid()

    # ── Top-level header fields ──────────────────────────────────
    out = b''
    out += encode_lv(1, bytes.fromhex(FILE_META_HEX))
    out += encode_lv(2, b'\x0a\x24' + song_uuid.encode('ascii'))
    out += encode_lv(3, title.encode('utf-8'))
    out += encode_lv(8, bytes.fromhex(AUDIO_SETTINGS_HEX))
    out += encode_lv(9, bytes.fromhex(FLAG9_HEX))

    # Build a flat list of chord dicts aligned to each section's slides
    chord_lookup = []  # list of {char_pos: chord} per slide, in section order
    if chord_data:
        for _, slide_chord_dicts in chord_data:
            chord_lookup.extend(slide_chord_dicts)

    # ── Build slides per section ─────────────────────────────────
    groups      = []   # (group_uuid, group_name, [slide_uuids])
    all_slides  = {}   # slide_uuid → slide_bytes
    slide_index = 0    # index into chord_lookup

    for section_name, lyric_lines in sections:
        group_uuid  = new_uuid()
        slide_uuids = []
        for slide_lines in lines_to_slides(lyric_lines):
            chord_pos = chord_lookup[slide_index] if chord_lookup else None
            notes = slide_notes.get(slide_index) if slide_notes else None
            slide_bytes, slide_uid = build_slide(*slide_lines, chord_positions=chord_pos,
                                                 notes=notes, case=case, style=style)
            slide_uuids.append(slide_uid)
            all_slides[slide_uid] = slide_bytes
            slide_index += 1
        groups.append((group_uuid, section_name, slide_uuids))

    # ── field 11 : arrangement ───────────────────────────────────
    order = arrangement_order if arrangement_order else range(len(groups))
    group_uuids = [groups[i][0] for i in order]
    out += encode_lv(11, build_arrangement(arr_uuid, arrangement_name, group_uuids))

    # ── field 12 : groups ────────────────────────────────────────
    for gid, gname, slide_uids in groups:
        out += encode_lv(12, build_group(gid, gname, slide_uids))

    # ── field 13 : slides ────────────────────────────────────────
    for _, _, slide_uids in groups:
        for uid in slide_uids:
            out += encode_lv(13, all_slides[uid])

    # ── field 23 : music key ─────────────────────────────────────
    music = build_music(music_key)
    if music:
        out += encode_lv(23, music)

    return out


# ════════════════════════════════════════════════════════════════
# ██  SONG DEFINITION  ██  ← EDIT THIS SECTION WITH YOUR LYRICS
# ════════════════════════════════════════════════════════════════
#
# Each section is:  ("Section Label", [slide, slide, ...])
#
# Each slide is either:
#   "A single line"           — one line fills the slide
#   ("Line 1", "Line 2")     — two lines with a hard break between them
#                               Use for short paired phrases that belong together.
#
# DoubleThickTheme guideline: keep each line under ~28 characters.
# Longer lines will auto-wrap in ProPresenter at an uncontrolled point.
# If a line is long, split it into a tuple at the natural breath/phrase break.
#
# ────────────────────────────────────────────────────────────────

SONG_TITLE = "Example Song"

SONG_SECTIONS = [
    ("Chorus", [
        "I've been washed in the water,",  # ~30 chars — may wrap; split if needed
        "washed in the blood",
        "I'm as good as new,",
        "oh hallelujah",
        "I've been washed in the water,",
        "washed in the blood",
        "All because of You,",
        "oh hallelujah",
    ]),
    ("Verse 1", [
        "And I'm clean",
        "Sin was stained on me",
        "And shame was running deep",
        "Your love was spilled on Calvary",
        ("Oh hallelujah", "I'm clean"),    # ← hard break: short paired phrases
        "And God, how can it be?",
        "I'm ransomed and redeemed",
        "I'm standing in Your victory",
        "Oh hallelujah",
    ]),
    ("Verse 2", [
        "I'm clean",
        "It's not what I have done",
        "But what You've done for me",
        "You paid it all upon that tree",
        ("Oh hallelujah", "I'm clean"),    # ← hard break: short paired phrases
        "Your love has overcome",          # ← separate slides: too long together
        "And Your mercy is supreme",
        "I'm dancing in Your victory",
        "Oh hallelujah",
    ]),
    ("Bridge", [
        "'Cause You took away my shame",
        "And You nailed it to the cross",
        "You got me running out the grave",
        "Oh hallelujah, here I come",
    ]),
]

# ════════════════════════════════════════════════════════════════


def main():
    os.makedirs(SONGS_OUTPUT_DIR, exist_ok=True)
    out_path = os.path.join(SONGS_OUTPUT_DIR, f"{SONG_TITLE}.pro")

    print(f"Building '{SONG_TITLE}'...")
    data = build_pro_file(SONG_TITLE, SONG_SECTIONS)

    with open(out_path, 'wb') as f:
        f.write(data)

    total_slides = sum(len(lines) for _, lines in SONG_SECTIONS)
    print(f"  {total_slides} slides across {len(SONG_SECTIONS)} sections")
    print(f"  {len(data):,} bytes saved → {out_path}")


if __name__ == '__main__':
    main()
