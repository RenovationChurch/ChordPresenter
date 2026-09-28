import { useMemo, useState } from "react";
import ArrangementEditor from "./ArrangementEditor";
import {
  ChordAt, EditorSection, RenderOpts, SlideStyle, TextCase, WRAP_WARN_CHARS, applyCase, editReflow,
  parseEditorText, rechunk, renderSection, serializeEditor, toReflow,
} from "./chordpro";

const LINE_CHOICES = [1, 2, 3, 4];

type View = "reflow" | "chords";

/** One line, chords stacked over the exact character they belong to — the
 *  same anchoring ProPresenter uses on the stage display. */
function PreviewLine({ text, chords, showChordRow, textCase }: {
  text: string; chords: ChordAt[]; showChordRow: boolean; textCase: TextCase;
}) {
  const shown = applyCase(text, textCase);
  const segs: { chord: string | null; text: string }[] = [];
  const sorted = [...chords].sort((a, b) => a.pos - b.pos);
  const first = sorted.length ? Math.min(sorted[0].pos, shown.length) : shown.length;
  if (first > 0 || !sorted.length) segs.push({ chord: null, text: shown.slice(0, first) });
  sorted.forEach((c, i) => {
    const end = i + 1 < sorted.length ? sorted[i + 1].pos : shown.length;
    segs.push({ chord: c.chord, text: shown.slice(Math.min(c.pos, shown.length), Math.max(end, c.pos)) });
  });
  const instrumental = !text.trim();
  const long = !instrumental && text.length > WRAP_WARN_CHARS;
  return (
    <div className={`pv-line${long ? " pv-line--long" : ""}${instrumental ? " pv-line--inst" : ""}${showChordRow ? " pv-line--chords" : ""}`}
         title={long ? `${text.length} characters — may wrap on screen` : undefined}>
      {segs.map((s, i) => (
        <span className="pv-seg" key={i}>
          {showChordRow && s.chord && <span className="pv-chord">{s.chord}</span>}
          <span className="pv-text">{s.text || " "}</span>
        </span>
      ))}
    </div>
  );
}

export default function SlideEditor({
  text, onChange, arrangement, onArrangementChange, linesPerSlide, onLinesPerSlideChange,
  render, textCase, slideStyle,
}: {
  text: string;
  onChange: (text: string) => void;
  arrangement: string;
  onArrangementChange: (value: string) => void;
  linesPerSlide: number;
  onLinesPerSlideChange: (n: number) => void;
  /** Key, capo and display settings — the preview shows exactly what exports. */
  render: RenderOpts;
  textCase: TextCase;
  /** Font and bars, so the preview looks like the exported slides. */
  slideStyle: SlideStyle;
}) {
  const [view, setView] = useState<View>("reflow");
  const sections = useMemo(() => parseEditorText(text), [text]);
  const reflow = useMemo(() => toReflow(text).plain, [text]);
  const rendered = useMemo(() => sections.map(s => renderSection(s, render)), [sections, render]);
  const slideCount = rendered.reduce((n, s) => n + s.length, 0);

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

      <div className="se-panes">
        <div className="chart-section se-text-pane">
          <div className="se-view-row">
            <div className="mode-toggle" role="group" aria-label="Editor view">
              <button className={`toggle-btn${view === "reflow" ? " active" : ""}`} onClick={() => setView("reflow")}
                      title="Just the words — like ProPresenter's reflow editor. Chords follow their words.">
                Reflow
              </button>
              <button className={`toggle-btn${view === "chords" ? " active" : ""}`} onClick={() => setView("chords")}
                      title="The full chart with [chords], to change chords themselves">
                Chords
              </button>
            </div>
            <span className="chart-label">
              {view === "reflow"
                ? "Blank line = new slide · Enter splits a line · chords stay with their words"
                : "[G] goes right before the syllable · <i>notes</i> · [Section] headers"}
            </span>
          </div>
          {view === "reflow" ? (
            <textarea className="chart-textarea se-textarea" value={reflow} spellCheck={false}
                      onChange={e => onChange(editReflow(text, e.target.value))} />
          ) : (
            <textarea className="chart-textarea se-textarea" value={text} spellCheck={false}
                      onChange={e => onChange(e.target.value)} />
          )}
          <ArrangementEditor sections={sections} order={arrangement} onChange={onArrangementChange} />
        </div>

        <div className="se-preview-pane">
          <div className="chart-label">Preview — stage display · dashed outline = long line, may wrap</div>
          <div className="se-preview">
            {sections.map((sec, si) => {
              const lineCounts = sec.slides.map(s => s.lines.filter(l => l.kind === "lyric").length);
              const uniform = lineCounts.every(n => n === lineCounts.find(x => x > 0))
                ? (lineCounts.find(x => x > 0) ?? 0) : 0;
              return (
                <div className="se-section" key={si}>
                  <div className="se-section-head">
                    <span className="se-section-name">{sec.name}</span>
                    {lineCounts.some(n => n > 0) && (
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
                    )}
                  </div>
                  {rendered[si].length === 0 && <div className="se-empty">Nothing to show — this section will be skipped</div>}
                  {rendered[si].map((slide, i) => {
                    slideNo++;
                    const hasChords = slide.lines.some(l => l.chords.length > 0);
                    return (
                      <div className={`pv-slide${slideStyle.line_bars ? " pv-slide--bars" : ""}`} key={i}
                           style={{ fontFamily: `"${slideStyle.font_family}", "Helvetica Neue", sans-serif` }}>
                        <span className="pv-num">{slideNo}</span>
                        {slide.lines.map((line, j) => (
                          <PreviewLine key={j} text={line.text} chords={line.chords}
                                       showChordRow={hasChords} textCase={textCase} />
                        ))}
                        {slide.notes.length > 0 && (
                          <div className="pv-notes">📝 {slide.notes.join(" · ")}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
