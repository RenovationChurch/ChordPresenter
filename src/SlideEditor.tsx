import { useMemo } from "react";
import {
  EditorLine, EditorSection, WRAP_WARN_CHARS,
  parseEditorText, rechunk, resolveArrangement, serializeEditor,
} from "./chordpro";

const LINE_CHOICES = [1, 2, 3, 4];

/** One lyric line, chords stacked over the exact character they belong to —
 *  the same anchoring ProPresenter uses on the stage display. */
function PreviewLine({ line, showChordRow }: { line: EditorLine; showChordRow: boolean }) {
  const segs: { chord: string | null; text: string }[] = [];
  const chords = [...line.chords].sort((a, b) => a.pos - b.pos);
  const first = chords.length ? Math.min(chords[0].pos, line.text.length) : line.text.length;
  if (first > 0 || !chords.length) segs.push({ chord: null, text: line.text.slice(0, first) });
  chords.forEach((c, i) => {
    const end = i + 1 < chords.length ? chords[i + 1].pos : line.text.length;
    segs.push({ chord: c.chord, text: line.text.slice(Math.min(c.pos, line.text.length), Math.max(end, c.pos)) });
  });
  const long = !line.chordOnly && line.text.length > WRAP_WARN_CHARS;
  return (
    <div className={`pv-line${long ? " pv-line--long" : ""}`}
         title={long ? `${line.text.length} characters — may wrap on screen` : undefined}>
      {segs.map((s, i) => (
        <span className="pv-seg" key={i}>
          {showChordRow && <span className="pv-chord">{s.chord ?? ""}</span>}
          <span className="pv-text">{s.text || " "}</span>
        </span>
      ))}
    </div>
  );
}

export default function SlideEditor({
  text, onChange, arrangement, onArrangementChange, linesPerSlide, onLinesPerSlideChange,
}: {
  text: string;
  onChange: (text: string) => void;
  arrangement: string;
  onArrangementChange: (value: string) => void;
  linesPerSlide: number;
  onLinesPerSlideChange: (n: number) => void;
}) {
  const sections = useMemo(() => parseEditorText(text), [text]);
  const slideCount = sections.reduce((n, s) => n + s.slides.length, 0);
  const unknown = useMemo(() => resolveArrangement(
    arrangement.split(",").filter(s => s.trim()), sections).unknown, [arrangement, sections]);

  const rewrite = (fn: (s: EditorSection, i: number) => EditorSection) =>
    onChange(serializeEditor(sections.map(fn)));

  let slideNo = 0;
  return (
    <div className="slide-editor">
      <div className="se-toolbar">
        <span className="se-toolbar-label">Lines per slide</span>
        <div className="mode-toggle" role="group" aria-label="Lines per slide for the whole song">
          {LINE_CHOICES.map(n => (
            <button key={n}
              className={`toggle-btn${linesPerSlide === n ? " active" : ""}`}
              onClick={() => { onLinesPerSlideChange(n); rewrite(s => rechunk(s, n)); }}
              title={`Re-split every section into ${n}-line slides`}>
              {n}
            </button>
          ))}
        </div>
        <span className="se-count">{slideCount} slides</span>
      </div>

      <div className="chart-section">
        <div className="chart-label">
          Chart — [Section] headers · blank line = new slide · [G] chords go right before the syllable
        </div>
        <textarea className="chart-textarea se-textarea" value={text}
                  onChange={e => onChange(e.target.value)} spellCheck={false} />
      </div>

      <div className="field-row">
        <label className="field-label">Order</label>
        <div className="field-body se-arrangement">
          <input className="url-input" value={arrangement}
                 placeholder="Verse 1, Chorus, Verse 2, Chorus, Bridge, Chorus"
                 onChange={e => onArrangementChange(e.target.value)} />
          {unknown.length > 0 && (
            <span className="se-warn">No section named: {unknown.join(", ")}</span>
          )}
        </div>
      </div>

      <div className="chart-label">Preview — as it will appear on the stage display · dashed outline = long line, may wrap</div>
      <div className="se-preview">
        {sections.map((sec, si) => {
          const lineCounts = sec.slides.map(s => s.lines.length);
          const uniform = lineCounts.every(n => n === lineCounts[0]) ? lineCounts[0] : 0;
          return (
            <div className="se-section" key={si}>
              <div className="se-section-head">
                <span className="se-section-name">{sec.name}</span>
                <select className="key-select se-lines-select"
                        value={LINE_CHOICES.includes(uniform) ? uniform : 0}
                        onChange={e => {
                          const n = Number(e.target.value);
                          if (n) rewrite((s, i) => (i === si ? rechunk(s, n) : s));
                        }}
                        title="Lines per slide for this section">
                  <option value={0} disabled>custom</option>
                  {LINE_CHOICES.map(n => <option key={n} value={n}>{n} line{n > 1 ? "s" : ""} / slide</option>)}
                </select>
              </div>
              {sec.slides.length === 0 && <div className="se-empty">No lines — this section will be skipped</div>}
              {sec.slides.map((slide, i) => {
                slideNo++;
                const hasChords = slide.lines.some(l => l.chords.length > 0);
                return (
                  <div className="pv-slide" key={i}>
                    <span className="pv-num">{slideNo}</span>
                    {slide.lines.map((line, j) => (
                      <PreviewLine line={line} showChordRow={hasChords} key={j} />
                    ))}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}
