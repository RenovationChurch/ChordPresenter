// ── ChordPro slide editor model ──────────────────────────────────────────────
//
// Planning Center stores chord charts as ChordPro: chords sit INLINE, in
// brackets, right before the syllable they belong to:
//
//     [G]Amazing [G7]grace, how [C]sweet the [G]sound
//
// That's why it lines up perfectly: the chord's position is "the character
// after the bracket", not a column count that breaks when fonts or spacing
// change. We keep that format all the way to the .pro file.
//
// Editor text format (what the user edits):
//
//     [Verse 1]                         ← section header (a bracket that isn't a chord)
//     [G]Amazing [G7]grace, how [C]sweet
//     the [G]sound                      ← consecutive lines = ONE slide
//                                       ← blank line = next slide
//     That [G]saved a wretch like [D]me
//
// ─────────────────────────────────────────────────────────────────────────────

import { isChordLine, isChordName, transposeChord } from "./music";

export interface ChordAt { pos: number; chord: string }

export interface EditorLine {
  /** The line exactly as typed, with inline [chords]. */
  raw: string;
  /** Lyric text with the chords removed. */
  text: string;
  /** Each chord and the index of the lyric character it sits over. */
  chords: ChordAt[];
  /** A line of chords with no words (intro, turnaround). */
  chordOnly: boolean;
}

export interface EditorSlide { lines: EditorLine[] }
export interface EditorSection { name: string; slides: EditorSlide[] }

/** Width at which the default theme starts wrapping a line on its own. */
export const WRAP_WARN_CHARS = 32;

// ── Inline chord lines ───────────────────────────────────────────────────────

export function parseInline(raw: string): EditorLine {
  const chords: ChordAt[] = [];
  let text = "";
  let last = 0;
  for (const m of raw.matchAll(/\[([^\]]*)\]/g)) {
    text += raw.slice(last, m.index);
    last = m.index! + m[0].length;
    const chord = m[1].trim();
    if (chord) chords.push({ pos: text.length, chord });
  }
  text += raw.slice(last);
  const chordOnly = chords.length > 0 && !text.trim();
  if (chordOnly) {
    // "[G] [C] [D]" has chords 1 character apart, which would print on top of
    // each other. Re-space them so each chord has room: G   C   D
    let pos = 0;
    for (const c of chords) { c.pos = pos; pos += c.chord.length + 2; }
    text = " ".repeat(Math.max(1, pos - 2));
  }
  return { raw, text: chordOnly ? text : text.replace(/\s+$/, ""), chords, chordOnly };
}

/** Rebuild an inline line from lyric text + chord positions. */
export function toInline(text: string, chords: ChordAt[]): string {
  const sorted = [...chords].sort((a, b) => a.pos - b.pos);
  let out = "", last = 0;
  for (const c of sorted) {
    const at = Math.max(last, Math.min(c.pos, text.length));
    out += text.slice(last, at) + `[${c.chord}]`;
    last = at;
  }
  return (out + text.slice(last)).replace(/\s+$/, "");
}

/** Convert a chord line + the lyric line under it into one inline line.
 *  Columns are measured on the raw (unstripped) lines: the chord line's
 *  leading spaces are what put the first chord over the right word. */
export function chordOverLyricToInline(chordLine: string, lyricLine: string): string {
  const indent = lyricLine.length - lyricLine.trimStart().length;
  const text = lyricLine.trim();
  const chords: ChordAt[] = [];
  for (const m of chordLine.matchAll(/\S+/g)) {
    if (!isChordName(m[0])) continue;
    chords.push({ pos: Math.max(0, m.index! - indent), chord: m[0] });
  }
  const collapsed = collapseSpaces(text, chords);
  // Chords that run past the end of the lyric get trailing spaces to sit on.
  const end = collapsed.chords.reduce((n, c) => Math.max(n, c.pos + 1), 0);
  return toInline(collapsed.text.padEnd(end), collapsed.chords);
}

/** Collapse the extra spaces charts put in lyrics to make room for chord
 *  names ("Oh   I'm clean" → "Oh I'm clean"), moving each chord with the text
 *  under it. A chord inside a collapsed gap moves onto the next word.
 *  Mirrors _collapse_spaces in scripts/md_to_pro.py. */
export function collapseSpaces(text: string, chords: ChordAt[]): { text: string; chords: ChordAt[] } {
  let out = "";
  const newIdx: number[] = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === " " && text[i + 1] === " ") {
      let j = i;
      while (text[j] === " ") j++;
      out += " ";
      for (let k = i; k < j; k++) newIdx.push(out.length);
      i = j;
    } else {
      newIdx.push(out.length);
      out += text[i++];
    }
  }
  const taken = new Set<number>();
  const moved = [...chords].sort((a, b) => a.pos - b.pos).map(c => {
    // Past the end: keep the same distance from the last character.
    let pos = c.pos < newIdx.length ? newIdx[c.pos] : out.length + (c.pos - text.length);
    while (taken.has(pos)) pos++;
    taken.add(pos);
    return { pos, chord: c.chord };
  });
  return { text: out, chords: moved };
}

// ── Section headers ──────────────────────────────────────────────────────────

const SECTION_WORDS =
  "intro|verse|chorus|pre[\\s-]?chorus|post[\\s-]?chorus|bridge|tag|outro|interlude|" +
  "instrumental|ending|coda|hook|turn|turnaround|transition|vamp|breakdown|refrain|" +
  "channel|solo|misc|spontaneous";
const SECTION_RE = new RegExp(
  `^(${SECTION_WORDS})\\b\\s*(\\d*[a-z]?)\\s*(?:\\((?:x\\s*)?\\d+x?\\)|x\\s*\\d+)?\\s*:?$`, "i");

function titleCase(s: string): string {
  return s.toLowerCase().replace(/(^|[\s-])([a-z])/g, (_, p, c) => p + c.toUpperCase());
}

/** "VERSE 1:" / "Pre-chorus" / "CHORUS (x2)" → "Verse 1" / "Pre-Chorus" / "Chorus". */
export function sectionName(line: string): string | null {
  const m = line.trim().match(SECTION_RE);
  if (!m) return null;
  return titleCase(m[1].replace(/\s+/, "-").replace(/^pre-?chorus$/i, "pre-chorus")
    .replace(/^post-?chorus$/i, "post-chorus")) + (m[2] ? ` ${m[2].toUpperCase()}` : "");
}

/** "[Verse 1]" on its own line (and not a chord like "[G]") → "Verse 1". */
function bracketHeader(line: string): string | null {
  const m = line.trim().match(/^\[([^\]]+)\]$/);
  if (!m || isChordName(m[1])) return null;
  return m[1].trim();
}

// ── Planning Center chord chart → sections of inline lines ───────────────────

export interface ImportedChart {
  sections: { name: string; lines: string[] }[];
  /** {key: X} directive, if the chart has one. */
  key: string;
}

const SKIP_LINE_RE = /^(COLUMN_BREAK|PAGE_BREAK|\{(column_break|colb|new_page|np|new_physical_page|npp)\})$/i;
// "REPEAT CHORUS", "(Repeat last line)", "x2", "(2x)" — but not a lyric that
// starts with the word ("Repeat the sounding joy").
const REPEAT_RE = new RegExp(
  `^\\(?\\s*(repeat(\\s+(${SECTION_WORDS}|last|all|x\\s*\\d|\\d)\\b.*)?|x\\s*\\d+|\\d+\\s*x)\\s*\\)?$`, "i");

/**
 * Parse a Planning Center chord chart (ChordPro + Services codes) — or plain
 * lyrics, or a chords-over-lyrics chart — into sections of inline lines.
 * Stanza breaks (blank lines) are dropped; slides are decided later.
 */
export function parsePcoChart(chart: string): ImportedChart {
  const sections: { name: string; lines: string[] }[] = [];
  let key = "";
  let current: { name: string; lines: string[] } | null = null;
  let inTab = false;
  const open = (name: string) => { current = { name, lines: [] }; sections.push(current); };
  const add = (line: string) => {
    if (!current) open("Song");
    current!.lines.push(line);
  };

  const lines = chart.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\t/g, "    ").replace(/\s+$/, "");
    const t = raw.trim();

    // {directive: value}
    const dir = t.match(/^\{\s*([a-z_]+)\s*(?::\s*(.*?))?\s*\}$/i);
    if (dir) {
      const name = dir[1].toLowerCase(), value = (dir[2] || "").trim();
      if (name === "sot" || name === "start_of_tab") inTab = true;
      else if (name === "eot" || name === "end_of_tab") inTab = false;
      else if (name === "key") key = value;
      else if (/^(soc|start_of_chorus)$/.test(name)) open(value || "Chorus");
      else if (/^(sov|start_of_verse)$/.test(name)) open(value || "Verse");
      else if (/^(sob|start_of_bridge)$/.test(name)) open(value || "Bridge");
      else if (/^(c|comment|ci|comment_italic|cb|comment_box)$/.test(name)) {
        const sec = sectionName(value);
        if (sec) open(sec);
      }
      continue;
    }
    if (inTab || !t || t.startsWith("#") || SKIP_LINE_RE.test(t) || REPEAT_RE.test(t)) continue;

    const header = bracketHeader(t) ?? sectionName(t);
    if (header) { open(header); continue; }

    // Chords-over-lyrics (charts pasted into PCO that way): merge the pair.
    if (isChordLine(t) && !t.includes("[")) {
      const next = lines[i + 1]?.replace(/\t/g, "    ").replace(/\s+$/, "") ?? "";
      const nt = next.trim();
      if (nt && !isChordLine(nt) && !sectionName(nt) && !bracketHeader(nt) && !nt.startsWith("{")) {
        add(chordOverLyricToInline(raw, next));
        i++;
      } else {
        add(chordOverLyricToInline(raw, ""));
      }
      continue;
    }
    add(t);
  }
  return { sections: sections.filter(s => s.lines.length), key };
}

// ── Editor text ⇄ sections/slides ────────────────────────────────────────────

export function parseEditorText(text: string): EditorSection[] {
  const sections: EditorSection[] = [];
  let slide: EditorSlide | null = null;
  const section = () => {
    if (!sections.length) sections.push({ name: "Song", slides: [] });
    return sections[sections.length - 1];
  };
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) { slide = null; continue; }
    const header = bracketHeader(line) ?? sectionName(line);
    if (header) { sections.push({ name: header, slides: [] }); slide = null; continue; }
    if (!slide) { slide = { lines: [] }; section().slides.push(slide); }
    slide.lines.push(parseInline(line.trim()));
  }
  return sections;
}

export function serializeEditor(sections: EditorSection[]): string {
  return sections.map(sec =>
    `[${sec.name}]\n` + sec.slides.map(s => s.lines.map(l => l.raw).join("\n")).join("\n\n")
  ).join("\n\n") + "\n";
}

/** Regroup a section's lines into slides of `n` lines. A chord-only line
 *  (intro, turnaround) always gets a slide of its own. */
export function rechunk(section: EditorSection, n: number): EditorSection {
  const slides: EditorSlide[] = [];
  let cur: EditorLine[] = [];
  const flush = () => { if (cur.length) slides.push({ lines: cur }); cur = []; };
  for (const line of section.slides.flatMap(s => s.lines)) {
    if (line.chordOnly) { flush(); slides.push({ lines: [line] }); continue; }
    cur.push(line);
    if (cur.length >= n) flush();
  }
  flush();
  return { ...section, slides };
}

/** Editor text for an imported chart, split into slides of `n` lines. */
export function importToEditorText(chart: ImportedChart, n: number): string {
  return serializeEditor(chart.sections.map(s => rechunk(
    { name: s.name, slides: [{ lines: s.lines.map(parseInline) }] }, n)));
}

// ── Arrangement (PCO "sequence") ─────────────────────────────────────────────

const ABBREV: Record<string, string> = {
  i: "intro", v: "verse", c: "chorus", pc: "prechorus", pre: "prechorus", b: "bridge",
  t: "tag", o: "outro", e: "ending", int: "interlude", inst: "instrumental", ta: "turnaround",
};

function normName(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const m = s.match(/^([a-z]+)(\d*)$/);
  return m && ABBREV[m[1]] ? ABBREV[m[1]] + m[2] : s;
}

/**
 * Match arrangement labels ("Verse 1", "C", "Chorus") to editor sections.
 * Returns section indices (repeats allowed) and the labels that matched nothing.
 */
export function resolveArrangement(labels: string[], sections: EditorSection[]):
    { order: number[]; unknown: string[] } {
  const norms = sections.map(s => normName(s.name));
  const order: number[] = [], unknown: string[] = [];
  for (const label of labels) {
    const n = normName(label);
    if (!n) continue;
    let idx = norms.indexOf(n);
    if (idx < 0) {
      const base = n.replace(/\d+$/, "");
      idx = n === base
        // "Chorus" → the first "Chorus N"
        ? norms.findIndex(x => x.replace(/\d+$/, "") === base)
        // "Chorus 1" → an unnumbered "Chorus" (but never "Verse 2" → "Verse 1")
        : norms.indexOf(base);
    }
    if (idx >= 0) order.push(idx); else unknown.push(label.trim());
  }
  return { order, unknown };
}

// ── Export helpers ───────────────────────────────────────────────────────────

export interface SongJson {
  title: string; artist: string; key: string; capo: number;
  notes?: string; lyrics_only: boolean;
  sections: { name: string; slides: { lines: { text: string; chords: ChordAt[] }[] }[] }[];
  arrangement?: number[];
}

export function toSongJson(
  sections: EditorSection[],
  opts: { title: string; artist: string; key: string; capo: number; notes?: string;
          lyricsOnly: boolean; semitones: number; preferFlat: boolean; arrangement?: number[] },
): SongJson {
  return {
    title: opts.title, artist: opts.artist, key: opts.key, capo: opts.capo,
    notes: opts.notes, lyrics_only: opts.lyricsOnly, arrangement: opts.arrangement,
    sections: sections.map(sec => ({
      name: sec.name,
      slides: sec.slides
        // A chord-only slide is just blank space on a lyrics-only export.
        .filter(sl => !(opts.lyricsOnly && sl.lines.every(l => l.chordOnly)))
        .map(sl => ({
          lines: sl.lines.map(l => ({
            text: l.text,
            chords: opts.lyricsOnly ? [] : l.chords.map(c => ({
              pos: c.pos, chord: transposeChord(c.chord, opts.semitones, opts.preferFlat),
            })),
          })),
        })),
    })),
  };
}

/** Classic chords-over-lyrics text (for printing / the existing transposer). */
export function toChordOverLyric(sections: EditorSection[]): string {
  const out: string[] = [];
  for (const sec of sections) {
    out.push(`[${sec.name}]`);
    for (const slide of sec.slides) {
      for (const line of slide.lines) {
        if (line.chords.length) {
          let chordLine = "";
          for (const c of line.chords) {
            const col = chordLine ? Math.max(c.pos, chordLine.length + 1) : c.pos;
            chordLine = chordLine.padEnd(col) + c.chord;
          }
          out.push(chordLine);
        }
        if (!line.chordOnly) out.push(line.text);
      }
      out.push("");
    }
  }
  return out.join("\n").trimEnd();
}
