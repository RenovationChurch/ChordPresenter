// Slide editor model tests. Run: pnpm test   (Node's built-in runner, no deps)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as cp from "./chordpro.ts";

const CHART = readFileSync(new URL("./__fixtures__/great-things.chordpro", import.meta.url), "utf8");

const OPTS: cp.RenderOpts = {
  semitones: 0, preferFlat: false, rhythm: "instrumental", notes: "beside", lyricsOnly: false,
};
const load = (chart = CHART, n = 2) => cp.parseEditorText(cp.importToEditorText(cp.parsePcoChart(chart), n));
const section = (secs: cp.EditorSection[], name: string) => secs.find(s => s.name === name)!;
/** "chord@word" pairs for the first line of a section's first slide. */
function chordsOn(secs: cp.EditorSection[], name: string, o: Partial<cp.RenderOpts> = {}, line = 0) {
  const l = cp.renderSection(section(secs, name), { ...OPTS, ...o })[0].lines[line];
  return l.chords.map(c => `${c.chord}@${l.text.slice(c.pos).split(" ")[0] || "_"}`);
}

// ── Planning Center chart (real-world sample) ────────────────────────────────

test("headers with <i>notes</i> still start a section; the note is kept apart", () => {
  const imp = cp.parsePcoChart(CHART);
  assert.deepEqual(imp.sections.map(s => s.name), [
    "Intro", "Verse 1", "Chorus", "Turnaround", "Verse 2", "Interlude", "Bridge", "Chorus (2)", "Tag", "Outro"]);
  assert.deepEqual(section(load(), "Verse 2").notes, ["(slash chords bass only)"]);
});

test("identical repeats merge into one section played again; a changed repeat stays separate", () => {
  const imp = cp.parsePcoChart(CHART);
  assert.deepEqual(imp.order.map(i => imp.sections[i].name), [
    "Intro", "Verse 1", "Chorus", "Turnaround", "Verse 2", "Chorus", "Interlude", "Bridge", "Chorus (2)", "Tag", "Outro"]);
});

test("bar lines are instrumental slides, including a trailing (note)", () => {
  const secs = load();
  const outro = section(secs, "Outro").slides[0].lines[0];
  assert.equal(outro.kind, "instrumental");
  const r = cp.renderSection(section(secs, "Outro"), OPTS)[0].lines[0];
  assert.equal(r.text.trim(), "");                      // blank for the audience
  assert.deepEqual(r.chords.map(c => c.chord).join(" "),
    "| B / / / | / / C#m7 / | G#m7 / / / | / / E / | B (let ring)");
});

test("rhythm marks: instrumental lines only (default), everywhere, or hidden", () => {
  const secs = load();
  // "[|B]Come, … our [|]King": the bare bar "[|]" disappears unless rhythm shows everywhere
  assert.deepEqual(chordsOn(secs, "Verse 1"), ["B@Come,"]);
  assert.deepEqual(chordsOn(secs, "Verse 1", { rhythm: "all" }), ["|B@Come,", "|@King"]);
  const intro = (rhythm: cp.RhythmMode) =>
    cp.renderSection(section(secs, "Intro"), { ...OPTS, rhythm })[0].lines[0].chords.map(c => c.chord).join(" ");
  assert.equal(intro("instrumental"), "| B / / / | / / C#m7 / | G#m7 / / / | / / E /");
  assert.equal(intro("none"), "B C#m7 G#m7 E");
});

test("chords with bars and bass-only slashes transpose", () => {
  const secs = load();
  assert.deepEqual(chordsOn(secs, "Verse 1", { semitones: 2, rhythm: "all" }), ["|C#@Come,", "|@King"]);
  // "[/C#]You [/D#]have done" — bass-only notes move too
  const v2 = cp.renderSection(section(secs, "Verse 2"), { ...OPTS, semitones: 2 })[1].lines[0];
  assert.deepEqual(v2.chords.map(c => c.chord), ["/D#", "/F", "F#5"]);
  assert.equal(cp.transposeName("F#/A#", 1, true), "G/B");
});

test("performance notes: beside the chord, in slide notes, or hidden", () => {
  const secs = load();
  assert.deepEqual(chordsOn(secs, "Chorus (2)"), ["B (dropout)@Hero"]);
  const slide = cp.renderSection(section(secs, "Chorus (2)"), { ...OPTS, notes: "slide" })[0];
  assert.deepEqual(slide.lines[0].chords.map(c => c.chord), ["B"]);
  assert.deepEqual(slide.notes, ["Hero: (dropout)"]);
  assert.deepEqual(cp.renderSection(section(secs, "Verse 2"), { ...OPTS, notes: "slide" })[0].notes,
                   ["(slash chords bass only)"]);
  assert.deepEqual(cp.renderSection(section(secs, "Chorus (2)"), { ...OPTS, notes: "hide" })[0].notes, []);
});

test("padding spaces in lyrics are tidied and chords move with their words", () => {
  const tag = section(load(), "Tag").slides[0].lines[0];
  assert.equal(tag.text, "God You do great things");
  assert.deepEqual(chordsOn(load(), "Tag"), ["F#sus@God", "E2@great"]);
});

test("lyrics-only drops chords and instrumental slides", () => {
  const secs = load();
  assert.equal(cp.renderSection(section(secs, "Intro"), { ...OPTS, lyricsOnly: true }).length, 0);
  assert.deepEqual(cp.renderSection(section(secs, "Tag"), { ...OPTS, lyricsOnly: true })[0].lines[0].chords, []);
});

// ── General parsing ──────────────────────────────────────────────────────────

test("ChordPro directives, codes and repeat markers", () => {
  const imp = cp.parsePcoChart(`{title: X}\n{key: G}\nVERSE 1\n[G]Line one\nCOLUMN_BREAK\n(Repeat Chorus)\nx2\n` +
    `Repeat the sounding joy\n{soc}\n[C]Sing\n{eot}\nPre-chorus\n     D          Em\nOh   I'm clean`);
  assert.equal(imp.key, "G");
  assert.deepEqual(imp.sections.map(s => [s.name, s.lines]), [
    ["Verse 1", ["[G]Line one", "Repeat the sounding joy"]],
    ["Chorus", ["[C]Sing"]],
    ["Pre-Chorus", ["Oh [D]I'm clean  [Em]"]],
  ]);
});

test("chords-over-lyrics keeps leading spaces and joins split syllables", () => {
  assert.equal(cp.chordOverLyricToInline("        G         C", "Amazing grace how sweet"),
               "Amazing [G]grace how [C]sweet");
  // "An - other day": D is at column 11, over "day"
  assert.equal(cp.chordOverLyricToInline("G          D", "An - other day"), "[G]Another [D]day");
});

test("the first split respects stanza breaks; re-splitting evens out the section", () => {
  const bridge = section(load(), "Bridge");
  assert.deepEqual(bridge.slides.map(s => s.lines.length), [2, 1, 2, 2]);
  assert.deepEqual(cp.rechunk(bridge, 2).slides.map(s => s.lines.length), [2, 2, 2, 1]);
});

test("rechunk: n lyric lines per slide, instrumental lines alone", () => {
  const v1 = section(load(), "Verse 1");
  assert.deepEqual(cp.rechunk(v1, 3).slides.map(s => s.lines.length), [3, 3, 1]);
  const text = "[Intro]\n| G / / / |\n[Verse]\na\nb\nc";
  const secs = cp.parseEditorText(text);
  assert.deepEqual(cp.rechunk(secs[1], 2).slides.map(s => s.lines.length), [2, 1]);
  assert.equal(cp.serializeEditor(cp.parseEditorText(cp.serializeEditor(secs))), cp.serializeEditor(secs));
});

test("arrangement labels match sections (abbreviations, numbering)", () => {
  const secs = cp.parseEditorText("[Verse 1]\na\n[Chorus 1]\nb\n[Bridge]\nc");
  assert.deepEqual(cp.resolveArrangement(["V1", "Chorus", "Verse 2", "C", "Bridge", "Tag"], secs),
                   { order: [0, 1, 1, 2], unknown: ["Verse 2", "Tag"] });
});

// ── Reflow editor ────────────────────────────────────────────────────────────

const V = "[Verse 1]\n[G]Amazing grace how [C]sweet the [G]sound\nThat saved a [D]wretch like me\n";

test("reflow shows only words and round-trips exactly", () => {
  const r = cp.toReflow(V);
  assert.equal(r.plain, "[Verse 1]\nAmazing grace how sweet the sound\nThat saved a wretch like me\n");
  assert.equal(cp.fromReflow(r), V);
  assert.equal(cp.fromReflow(cp.toReflow(CHART)), CHART);
});

test("reflow: pressing Enter twice splits a slide; chords stay on their words", () => {
  const plain = cp.toReflow(V).plain.replace("how sweet", "how\n\nsweet");
  assert.equal(cp.editReflow(V, plain),
    "[Verse 1]\n[G]Amazing grace how\n\n[C]sweet the [G]sound\nThat saved a [D]wretch like me\n");
});

test("reflow: joining two lines and fixing a typo keep every chord", () => {
  let text = cp.editReflow(V, cp.toReflow(V).plain.replace("sound\nThat", "sound That"));
  assert.equal(text, "[Verse 1]\n[G]Amazing grace how [C]sweet the [G]sound That saved a [D]wretch like me\n");
  text = cp.editReflow(text, cp.toReflow(text).plain.replace("wretch", "soul"));
  assert.match(text, /a \[D\]soul like me/);
});

test("reflow: instrumental lines show as bars, not blank lines", () => {
  const t = "[Intro]\n[G] [C]\n";
  assert.equal(cp.toReflow(t).plain, "[Intro]\nG C\n");
  assert.equal(cp.parseEditorText(cp.editReflow(t, "[Intro]\nG C\n"))[0].slides[0].lines[0].kind, "instrumental");
});

test("capitalization options", () => {
  assert.equal(cp.applyCase("oh hallelujah", "upper"), "OH HALLELUJAH");
  assert.equal(cp.applyCase("oh hallelujah", "asis"), "oh hallelujah");
  assert.equal(cp.applyCase("'oh hallelujah", "line"), "'Oh hallelujah");
});
