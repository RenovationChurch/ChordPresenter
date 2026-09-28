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
// Editor text format (what the user edits) — the same syntax as PCO:
//
//     [Verse 2] <i>(slash chords bass only)</i>   ← section header (+ optional note)
//     You've been [|B]faithful through every [|]storm
//     You'll be [|B]faithful forever[|  /    /]more   ← consecutive lines = ONE slide
//                                                   ← blank line = next slide
//     | B / / / | / / C#m7 / | B (let ring)         ← instrumental (bar) line
//
// What goes INSIDE a chord bracket is kept as tokens — bar lines "|", beat
// slashes "/", chord names, and <i>notes</i> — so each can be shown, hidden,
// or transposed on its own when the slides are rendered.
// ─────────────────────────────────────────────────────────────────────────────

import { isChordLine, isChordName, transposeChord } from "./music.ts";

export type Tok =
  | { kind: "bar"; text: string }        // "|"
  | { kind: "beat"; text: string }       // "/" — another beat of the same chord
  | { kind: "chord"; name: string }      // "B", "F#/A#", "/C#" (bass only)
  | { kind: "note"; text: string };      // "(dropout)", "(let ring)"

/** A chord bracket in the editor text, parsed. */
export interface ChordMark { pos: number; raw: string; tokens: Tok[] }

/** A rendered chord, ready for ProPresenter: text anchored at a character. */
export interface ChordAt { pos: number; chord: string }

export interface EditorLine {
  /** The line exactly as typed. */
  raw: string;
  /** "lyric": words (with chords); "instrumental": bars/chords only; "note": only <i>notes</i>. */
  kind: "lyric" | "instrumental" | "note";
  /** Lyric text with chords and notes removed, spacing tidied. */
  text: string;
  /** Chords, each at the index of the lyric character it sits over. */
  chords: ChordMark[];
  /** Instrumental line tokens, in order. */
  bars: Tok[];
  /** <i>notes</i> written in the lyric itself (not inside a chord). */
  notes: string[];
}

export interface EditorSlide { lines: EditorLine[] }
export interface EditorSection { name: string; notes: string[]; slides: EditorSlide[] }

/** Width at which the default theme starts wrapping a line on its own. */
export const WRAP_WARN_CHARS = 32;

// ── Notes (<i>…</i>) ─────────────────────────────────────────────────────────

const NOTE_RE = /<(i|em)>([\s\S]*?)<\/\1>/gi;
const OTHER_TAG_RE = /<\/?[a-z][^>]*>/gi;

/** Pull <i>notes</i> out of a string; other tags (<b>, <u>…) are dropped. */
export function splitNotes(s: string): { text: string; notes: string[] } {
  const notes: string[] = [];
  const text = s.replace(NOTE_RE, (_, _t, n: string) => {
    if (n.trim()) notes.push(n.trim());
    return "";
  }).replace(OTHER_TAG_RE, "");
  return { text, notes };
}

// ── Chord tokens ─────────────────────────────────────────────────────────────

const TOKEN_RE = /\([^)]*\)|\|+|[^\s|]+/g;
const BASS_ONLY_RE = /^\/[A-G][#b]?$/;
const REPEAT_MARK_RE = /^(%|x\d+|\d+x)$/i;

/** Tokens inside a chord bracket: "|B <i>(dropout)</i>" → bar, B, note. */
export function tokenizeChord(inner: string): Tok[] {
  const { text, notes } = splitNotes(inner);
  const toks: Tok[] = [];
  for (const [t] of text.matchAll(TOKEN_RE)) {
    if (t.startsWith("|")) toks.push({ kind: "bar", text: t });
    else if (/^\/+$/.test(t)) toks.push({ kind: "beat", text: t });
    else if (t.startsWith("(") && !isChordName(t)) toks.push({ kind: "note", text: t });
    // Anything else in brackets is a chord, even if we can't parse the name —
    // it's shown as written (and simply not transposed).
    else toks.push({ kind: "chord", name: t });
  }
  for (const n of notes) toks.push({ kind: "note", text: n });
  return toks;
}

/** A line of bars and chords with no brackets ("| B / / / | / / C#m7 /"),
 *  or null if it has anything that isn't a chord, bar, beat, or (note). */
export function tokenizeBarLine(line: string): Tok[] | null {
  if (line.includes("[")) return null;
  const { text, notes } = splitNotes(line);
  const toks: Tok[] = [];
  let chords = 0, bars = 0;
  for (const [t] of text.matchAll(TOKEN_RE)) {
    if (t.startsWith("|")) { toks.push({ kind: "bar", text: t }); bars++; }
    else if (/^\/+$/.test(t) || t === "%") toks.push({ kind: "beat", text: t });
    else if (isChordName(t) || BASS_ONLY_RE.test(t)) { toks.push({ kind: "chord", name: t }); chords++; }
    else if (t.startsWith("(") || REPEAT_MARK_RE.test(t)) toks.push({ kind: "note", text: t });
    else if (/^-+$/.test(t)) continue;
    else return null;
  }
  if (!chords && !bars) return null;
  for (const n of notes) toks.push({ kind: "note", text: n });
  return toks;
}

/** Transpose a chord name, including "(G)" and bass-only "/C#". */
export function transposeName(name: string, semitones: number, preferFlat: boolean): string {
  if (!semitones) return name;
  const m = name.match(/^(\(?)(.*?)(\)?\*?)$/)!;
  const [, pre, core, post] = m;
  let moved = core;
  try {
    if (BASS_ONLY_RE.test(core)) moved = "/" + transposeChord(core.slice(1), semitones, preferFlat);
    else moved = transposeChord(core, semitones, preferFlat);
  } catch { /* not a chord we understand — leave it as written */ }
  return pre + moved + post;
}

function barsText(toks: Tok[]): string {
  return toks.map(t => t.kind === "chord" ? t.name
    : t.kind === "note" ? (t.text.startsWith("(") ? t.text : `<i>${t.text}</i>`)
    : t.text).join(" ");
}

// ── Text edits that carry chords along ───────────────────────────────────────

/**
 * Replace every match of `re` in `text`, returning the new text and a map from
 * each old character index to its new index. A position inside a replaced
 * span maps to just after the replacement — i.e. onto the next surviving
 * character — so a chord that sat in a removed gap lands on the next word.
 */
function replaceWithMap(text: string, re: RegExp, repl: string): { text: string; map: number[] } {
  let out = "";
  const map: number[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    for (let i = last; i < m.index!; i++) { map.push(out.length); out += text[i]; }
    out += repl;
    for (let i = 0; i < m[0].length; i++) map.push(out.length);
    last = m.index! + m[0].length;
  }
  for (let i = last; i < text.length; i++) { map.push(out.length); out += text[i]; }
  map.push(out.length);                                  // end of text
  return { text: out, map };
}

function moveChords<T extends { pos: number }>(chords: T[], map: number[], oldLen: number): T[] {
  const taken = new Set<number>();
  return [...chords].sort((a, b) => a.pos - b.pos).map(c => {
    // Past the end: keep the same distance from the end of the text.
    let pos = c.pos <= oldLen ? map[c.pos] : map[oldLen] + (c.pos - oldLen);
    while (taken.has(pos)) pos++;                          // never stack two chords
    taken.add(pos);
    return { ...c, pos };
  });
}

/** Apply a regex replacement to lyric text, moving chords with their words. */
export function editText<T extends { pos: number }>(text: string, chords: T[], re: RegExp, repl: string):
    { text: string; chords: T[] } {
  const r = replaceWithMap(text, re, repl);
  return { text: r.text, chords: moveChords(chords, r.map, text.length) };
}

/** Collapse the extra spaces charts put in lyrics to make room for chord
 *  names ("Oh   I'm clean" → "Oh I'm clean") and trim the ends, moving each
 *  chord with the text under it. Mirrors _collapse_spaces in md_to_pro.py. */
export function tidySpaces<T extends { pos: number }>(text: string, chords: T[]): { text: string; chords: T[] } {
  // "[|Ebm]      I believe": a chord followed by spaces is a lead-in played
  // before the words start — keep that gap so it sits ahead of the lyric.
  const lead = chords.some(c => c.pos === 0) ? (text.match(/^ +/)?.[0].length ?? 0) : 0;
  if (lead) {
    const rest = tidySpaces(text.slice(lead), chords.filter(c => c.pos >= lead)
      .map(c => ({ ...c, pos: c.pos - lead })));
    return {
      text: " ".repeat(lead) + rest.text,
      chords: [...chords.filter(c => c.pos < lead), ...rest.chords.map(c => ({ ...c, pos: c.pos + lead }))],
    };
  }
  let r = editText(text, chords, / {2,}/g, " ");
  r = editText(r.text, r.chords, /^ +/g, "");
  return { text: r.text.replace(/ +$/, ""), chords: r.chords };
}

// ── Lines ────────────────────────────────────────────────────────────────────

const LINE_RE = /\[([^\]]*)\]|<(i|em)>([\s\S]*?)<\/\2>|<\/?[a-z][^>]*>/gi;

export function parseLine(raw: string): EditorLine {
  const bars = tokenizeBarLine(raw.trim());
  if (bars) return { raw, kind: "instrumental", text: "", chords: [], bars, notes: [] };

  let text = "";
  const chords: ChordMark[] = [];
  const notes: string[] = [];
  let last = 0;
  for (const m of raw.matchAll(LINE_RE)) {
    text += raw.slice(last, m.index);
    last = m.index! + m[0].length;
    if (m[1] !== undefined) {
      const tokens = tokenizeChord(m[1]);
      if (tokens.length) chords.push({ pos: text.length, raw: m[1], tokens });
    } else if (m[3] !== undefined && m[3].trim()) {
      notes.push(m[3].trim());
    }
  }
  text += raw.slice(last);
  const tidy = tidySpaces(text.replace(/\t/g, " "), chords);

  if (!tidy.text.trim()) {
    // "[G] [C] [D]" — chords with no words is an instrumental line.
    if (chords.length) {
      return { raw, kind: "instrumental", text: "", chords: [], notes,
               bars: chords.flatMap(c => c.tokens) };
    }
    return { raw, kind: "note", text: "", chords: [], bars: [], notes };
  }
  return { raw, kind: "lyric", text: tidy.text, chords: tidy.chords, bars: [], notes };
}

/** Rebuild an inline line from lyric text + chord marks. */
function toInline(text: string, chords: { pos: number; raw: string }[]): string {
  const sorted = [...chords].sort((a, b) => a.pos - b.pos);
  let out = "", last = 0;
  for (const c of sorted) {
    const at = Math.max(last, c.pos);
    out += text.slice(last, at).padEnd(at - last) + `[${c.raw}]`;
    last = Math.max(last, Math.min(at, text.length));
  }
  return (out + text.slice(last)).replace(/\s+$/, "");
}

/** Convert a chord line + the lyric line under it into one inline line.
 *  Columns are measured on the raw (unstripped) lines: the chord line's
 *  leading spaces are what put the first chord over the right word. */
export function chordOverLyricToInline(chordLine: string, lyricLine: string): string {
  const indent = lyricLine.length - lyricLine.trimStart().length;
  const chords: { pos: number; raw: string }[] = [];
  for (const m of chordLine.matchAll(/\S+/g)) {
    if (isChordName(m[0])) chords.push({ pos: Math.max(0, m.index! - indent), raw: m[0] });
  }
  let r = { text: lyricLine.trim(), chords };
  // "An - other" → "Another": charts split syllables with " - ".
  r = editText(r.text, r.chords, /\s+-\s+/g, "");
  r = tidySpaces(r.text, r.chords);
  return toInline(r.text, r.chords);
}

// ── Section headers ──────────────────────────────────────────────────────────

const SECTION_WORDS =
  "intro|verse|chorus|pre[\\s-]?chorus|post[\\s-]?chorus|bridge|tag|outro|interlude|" +
  "instrumental|ending|coda|hook|turn|turnaround|transition|vamp|breakdown|refrain|" +
  "channel|solo|misc|spontaneous";
const SECTION_RE = new RegExp(
  `^(${SECTION_WORDS})\\b\\s*(\\d*[a-z]?)\\s*(?:\\([^)]*\\)|x\\s*\\d+)?\\s*:?$`, "i");

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
  if (!m || isChordName(m[1]) || m[1].trim().startsWith("|")) return null;
  return m[1].trim();
}

/** A header line, with any <i>notes</i> split off — or null. */
function parseHeader(line: string): { name: string; notes: string[] } | null {
  const { text, notes } = splitNotes(line);
  const name = bracketHeader(text) ?? sectionName(text);
  return name ? { name, notes } : null;
}

function headerLine(name: string, notes: string[]): string {
  return `[${name}]` + notes.map(n => ` <i>${n}</i>`).join("");
}

// ── Planning Center (or any) chord chart → sections of editor lines ──────────

/** `lines` uses "" to mark a stanza break (a blank line in the chart). */
export interface ImportedSection { name: string; notes: string[]; lines: string[] }
export interface ImportedChart {
  /** Unique sections — a repeated identical Chorus appears once. */
  sections: ImportedSection[];
  /** Section indices in the order the chart plays them (repeats included). */
  order: number[];
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
 * lyrics, or a chords-over-lyrics chart — into sections of editor lines.
 * Stanza breaks (blank lines) are kept as "" so the first slide split never
 * runs a slide across two stanzas.
 */
export function parsePcoChart(chart: string): ImportedChart {
  const found: ImportedSection[] = [];
  let key = "";
  let current: ImportedSection | null = null;
  let skipping = false;                      // {sot}…{eot} or a [Tab] section
  const open = (name: string, notes: string[] = []) => {
    skipping = /^tab$/i.test(name);
    current = { name, notes, lines: [] };
    if (!skipping) found.push(current);
  };
  const add = (line: string) => {
    if (skipping) return;
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
      if (name === "sot" || name === "start_of_tab") skipping = true;
      else if (name === "eot" || name === "end_of_tab") skipping = false;
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
    if (!t) {
      const cur = current as ImportedSection | null;
      if (cur && !skipping && cur.lines.length && cur.lines[cur.lines.length - 1] !== "") cur.lines.push("");
      continue;
    }
    if (t.startsWith("#") || SKIP_LINE_RE.test(t) || REPEAT_RE.test(splitNotes(t).text.trim())) continue;

    const header = parseHeader(t);
    if (header) { open(header.name, header.notes); continue; }
    if (skipping) continue;

    // A bar line ("| B / / / |") or chords with nothing under them.
    const bars = tokenizeBarLine(t);
    if (bars && (t.startsWith("|") || !isLyricLine(lines[i + 1]))) { add(barsText(bars)); continue; }

    // Chords-over-lyrics (charts pasted that way): merge the pair.
    if (isChordLine(t) && !t.includes("[")) {
      add(chordOverLyricToInline(raw, (lines[i + 1] ?? "").replace(/\t/g, "    ").replace(/\s+$/, "")));
      i++;
      continue;
    }
    add(t);
  }
  for (const sec of found) while (sec.lines[sec.lines.length - 1] === "") sec.lines.pop();
  return mergeRepeats(found.filter(s => s.lines.length), key);
}

function isLyricLine(line: string | undefined): boolean {
  const t = line?.trim() ?? "";
  return Boolean(t) && !isChordLine(t) && !t.startsWith("|") && !parseHeader(t)
    && !t.startsWith("{") && !SKIP_LINE_RE.test(t);
}

/** A Chorus written out three times becomes one section played three times.
 *  A repeat that differs (new notes, changed words) stays separate as "Chorus (2)". */
function mergeRepeats(found: ImportedSection[], key: string): ImportedChart {
  const sections: ImportedSection[] = [];
  const order: number[] = [];
  for (const sec of found) {
    const same = sections.findIndex(s =>
      s.name.replace(/ \(\d+\)$/, "") === sec.name && s.lines.join("\n") === sec.lines.join("\n"));
    if (same >= 0) { order.push(same); continue; }
    const taken = sections.filter(s => s.name.replace(/ \(\d+\)$/, "") === sec.name).length;
    sections.push(taken ? { ...sec, name: `${sec.name} (${taken + 1})` } : sec);
    order.push(sections.length - 1);
  }
  return { sections, order, key };
}

// ── Editor text ⇄ sections/slides ────────────────────────────────────────────

export function parseEditorText(text: string): EditorSection[] {
  const sections: EditorSection[] = [];
  let slide: EditorSlide | null = null;
  const section = () => {
    if (!sections.length) sections.push({ name: "Song", notes: [], slides: [] });
    return sections[sections.length - 1];
  };
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim()) { slide = null; continue; }
    const header = parseHeader(line);
    if (header) { sections.push({ ...header, slides: [] }); slide = null; continue; }
    if (!slide) { slide = { lines: [] }; section().slides.push(slide); }
    slide.lines.push(parseLine(line.trim()));
  }
  return sections;
}

export function serializeEditor(sections: EditorSection[]): string {
  return sections.map(sec =>
    headerLine(sec.name, sec.notes) + "\n" +
    sec.slides.map(s => s.lines.map(l => l.raw).join("\n")).join("\n\n")
  ).join("\n\n") + "\n";
}

/** Regroup a section's lines into slides of `n` lyric lines. An instrumental
 *  line always gets a slide of its own; a note-only line rides along with
 *  the lyrics that follow it. */
export function rechunk(section: EditorSection, n: number): EditorSection {
  const slides: EditorSlide[] = [];
  let cur: EditorLine[] = [];
  let count = 0;
  const flush = () => { if (cur.length) slides.push({ lines: cur }); cur = []; count = 0; };
  for (const line of section.slides.flatMap(s => s.lines)) {
    if (line.kind === "instrumental") { flush(); slides.push({ lines: [line] }); continue; }
    cur.push(line);
    if (line.kind === "lyric" && ++count >= n) flush();
  }
  flush();
  return { ...section, slides };
}

/** Editor text for an imported chart, split into slides of `n` lines,
 *  each stanza split on its own. */
export function importToEditorText(chart: ImportedChart, n: number): string {
  return serializeEditor(chart.sections.map(s => {
    const stanzas = s.lines.join("\n").split(/\n\n+/).map(st => st.split("\n"));
    const slides = stanzas.flatMap(st => rechunk(
      { name: s.name, notes: s.notes, slides: [{ lines: st.map(parseLine) }] }, n).slides);
    return { name: s.name, notes: s.notes, slides };
  }));
}

// ── Reflow view: lyrics only, chords carried along invisibly ─────────────────
//
// Like ProPresenter's reflow editor: the text shows just the words, and
// blank lines are slide breaks. Chord brackets are lifted out as "anchors"
// at character offsets; after each edit they're put back at the same place
// relative to the text around them.

export interface Reflow { plain: string; anchors: { at: number; raw: string }[] }

export function toReflow(editorText: string): Reflow {
  const anchors: { at: number; raw: string }[] = [];
  const out: string[] = [];
  let offset = 0;
  for (const line of editorText.split("\n")) {
    let plain = line;
    const parsed = line.trim() && !parseHeader(line) ? parseLine(line.trim()) : null;
    if (parsed?.kind === "instrumental") {
      plain = barsText(parsed.bars);            // "[G] [C]" shows as "G C"
    } else if (!parseHeader(line)) {
      plain = "";
      let last = 0;
      for (const m of line.matchAll(/\[([^\]]*)\]/g)) {
        plain += line.slice(last, m.index);
        anchors.push({ at: offset + plain.length, raw: m[1] });
        last = m.index! + m[0].length;
      }
      plain += line.slice(last);
    }
    out.push(plain);
    offset += plain.length + 1;
  }
  return { plain: out.join("\n"), anchors };
}

export function fromReflow(r: Reflow): string {
  let out = "", last = 0;
  for (const a of [...r.anchors].sort((x, y) => x.at - y.at)) {
    out += r.plain.slice(last, a.at) + `[${a.raw}]`;
    last = a.at;
  }
  return out + r.plain.slice(last);
}

/** Apply an edit made in the reflow view. The edit is found as the part that
 *  changed between the common prefix and suffix; chords before it stay put,
 *  chords after it shift, chords inside replaced text move to its start. */
export function editReflow(editorText: string, newPlain: string): string {
  const old = toReflow(editorText);
  const a = old.plain, b = newPlain;
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const oldEnd = a.length - s, delta = b.length - a.length;
  const anchors = old.anchors.map(x => ({
    raw: x.raw,
    at: x.at < p ? x.at : x.at >= oldEnd ? x.at + delta : p,
  }));
  return fromReflow({ plain: b, anchors });
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

// ── Rendering (preview + export) ─────────────────────────────────────────────

export type RhythmMode = "instrumental" | "all" | "none";
export type NotesMode = "beside" | "slide" | "hide";
export type TextCase = "upper" | "asis" | "line";

export interface RenderOpts {
  semitones: number;
  preferFlat: boolean;
  /** Where bar lines "|" and beat slashes "/" are shown. */
  rhythm: RhythmMode;
  /** Where <i>notes</i> go: next to the chord, in the slide notes, or nowhere. */
  notes: NotesMode;
  lyricsOnly: boolean;
}

export interface RenderedSlide { lines: { text: string; chords: ChordAt[] }[]; notes: string[] }

/**
 * The label ProPresenter gets for one chord bracket. A label with a chord
 * name in it stays JUST the chord name (plus a note, if notes go "beside"),
 * because ProPresenter can only transpose a chord or show it as a number /
 * numeral when the label is a chord it can read — "|Ebm" defeats that.
 * Bar lines and beat slashes are shown only in brackets that have no chord
 * ("[|]", "[|  /  /]") and only when rhythm marks are on for lyric lines.
 */
function chordText(toks: Tok[], o: RenderOpts, showRhythm: boolean, noteSink: string[], word: string): string {
  let s = "";
  const add = (piece: string) => { s += (s && !s.endsWith("|") ? " " : "") + piece; };
  const marks = showRhythm && !toks.some(t => t.kind === "chord");
  for (const t of toks) {
    if (t.kind === "bar") { if (marks) s += (s ? " " : "") + t.text; }
    else if (t.kind === "beat") { if (marks) add(t.text); }
    else if (t.kind === "chord") add(transposeName(t.name, o.semitones, o.preferFlat));
    else if (o.notes === "beside") add(t.text);
    else if (o.notes === "slide") noteSink.push(word ? `${word}: ${t.text}` : t.text);
  }
  return s.trim();
}

/** An instrumental line: blank lyric text with the chords spread over it. */
function renderBars(toks: Tok[], o: RenderOpts, noteSink: string[]): { text: string; chords: ChordAt[] } {
  const showRhythm = o.rhythm !== "none";
  const atoms: string[] = [];
  for (const t of toks) {
    if (t.kind === "bar" || t.kind === "beat") { if (showRhythm) atoms.push(t.text); }
    else if (t.kind === "chord") atoms.push(transposeName(t.name, o.semitones, o.preferFlat));
    else if (o.notes === "beside") atoms.push(t.text);
    else if (o.notes === "slide") noteSink.push(t.text);
  }
  const gap = showRhythm ? 1 : 2;                // chords alone get a little more air
  const chords: ChordAt[] = [];
  let pos = 0;
  for (const a of atoms) { chords.push({ pos, chord: a }); pos += a.length + gap; }
  return { text: " ".repeat(Math.max(1, pos - gap)), chords };
}

function wordAt(text: string, pos: number): string {
  const start = text.lastIndexOf(" ", pos - 1) + 1;
  const end = text.indexOf(" ", pos);
  return text.slice(start, end < 0 ? undefined : end).replace(/[^\p{L}\p{N}']/gu, "");
}

/** Turn a section into the slides ProPresenter will get. */
export function renderSection(sec: EditorSection, o: RenderOpts): RenderedSlide[] {
  const out: RenderedSlide[] = [];
  let carry: string[] = o.notes === "slide" ? [...sec.notes] : [];
  for (const slide of sec.slides) {
    const notes = carry;
    carry = [];
    const lines: RenderedSlide["lines"] = [];
    for (const line of slide.lines) {
      if (o.notes !== "hide") notes.push(...line.notes);
      if (line.kind === "instrumental") {
        if (!o.lyricsOnly) lines.push(renderBars(line.bars, o, notes));
      } else if (line.kind === "lyric") {
        const chords: ChordAt[] = [];
        if (!o.lyricsOnly) {
          for (const c of line.chords) {
            const chord = chordText(c.tokens, o, o.rhythm === "all", notes, wordAt(line.text, c.pos));
            if (chord) chords.push({ pos: c.pos, chord });
          }
        }
        lines.push({ text: line.text, chords });
      }
    }
    // A slide with nothing to show hands its notes to the next one.
    if (lines.length) out.push({ lines, notes: o.lyricsOnly ? [] : notes });
    else carry = notes;
  }
  if (carry.length && out.length) out[out.length - 1].notes.push(...carry);
  return out;
}

/** Apply the capitalization setting (mirrors create_pro_song.apply_case). */
export function applyCase(text: string, mode: TextCase): string {
  if (mode === "upper") return text.toUpperCase();
  if (mode === "line") return text.replace(/\p{L}/u, c => c.toUpperCase());
  return text;
}

// ── Export ───────────────────────────────────────────────────────────────────

/** Lyric text box look (see DEFAULT_STYLE in scripts/create_pro_song.py). */
export interface SlideStyle {
  font_name: string; font_family: string; font_size: number;
  line_bars: boolean; shrink_to_fit: boolean;
  /** ALL CAPS on the main output only (display-time, text keeps its case). */
  audience_caps: boolean;
}

export interface SongJson {
  title: string; artist: string; key: string; capo: number;
  notes?: string; text_case: TextCase;
  opening: { name: string; count: number };
  style: SlideStyle;
  /** Key the chords are written in (after capo) — ProPresenter's original key. */
  chord_key: string;
  file_name?: string;
  sections: { name: string; slides: { lines: { text: string; chords: ChordAt[] }[]; notes?: string }[] }[];
  arrangement?: number[];
}

export function toSongJson(
  sections: EditorSection[], render: RenderOpts,
  meta: { title: string; artist: string; key: string; capo: number; notes?: string;
          textCase: TextCase; opening: { name: string; count: number }; arrangement?: number[];
          style: SlideStyle; chordKey: string; fileName?: string },
): SongJson {
  return {
    title: meta.title, artist: meta.artist, key: meta.key, capo: meta.capo, notes: meta.notes,
    text_case: meta.textCase, opening: meta.opening, arrangement: meta.arrangement,
    style: meta.style, chord_key: render.lyricsOnly ? "" : meta.chordKey, file_name: meta.fileName,
    sections: sections.map(sec => ({
      name: sec.name,
      slides: renderSection(sec, render).map(s => ({
        lines: s.lines,
        ...(s.notes.length ? { notes: s.notes.join("\n") } : {}),
      })),
    })),
  };
}

/** Classic chords-over-lyrics text, in the export key (for printing). */
export function toChordOverLyric(sections: EditorSection[], o: RenderOpts): string {
  const out: string[] = [];
  for (const sec of sections) {
    out.push(`[${sec.name}]`);
    for (const slide of renderSection(sec, o)) {
      for (const line of slide.lines) {
        if (line.chords.length) {
          let chordLine = "";
          for (const c of line.chords) {
            const col = chordLine ? Math.max(c.pos, chordLine.length + 1) : c.pos;
            chordLine = chordLine.padEnd(col) + c.chord;
          }
          out.push(chordLine);
        }
        if (line.text.trim()) out.push(line.text);
      }
      out.push("");
    }
  }
  return out.join("\n").trimEnd();
}

/** Chord names only, for key detection. */
export function chordNames(sections: EditorSection[]): string[] {
  const names: string[] = [];
  for (const sec of sections) for (const sl of sec.slides) for (const l of sl.lines) {
    const toks = l.kind === "instrumental" ? l.bars : l.chords.flatMap(c => c.tokens);
    for (const t of toks) if (t.kind === "chord" && isChordName(t.name)) names.push(t.name);
  }
  return names;
}
