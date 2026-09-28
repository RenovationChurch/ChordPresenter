import { useRef, useState } from "react";
import { EditorSection, resolveArrangement } from "./chordpro";

/**
 * The song's play order as chips: drag to reorder, × to remove, and click a
 * section below to add it (again) — a section can be played any number of
 * times; ProPresenter reuses the same group, so its slides exist only once.
 *
 * `order` is the comma-separated list stored on the song ("" = play every
 * section once, as written). Dragging uses pointer events rather than HTML5
 * drag-and-drop, which the app window's file-drop handling can swallow.
 */
export default function ArrangementEditor({ sections, order, onChange }: {
  sections: EditorSection[];
  order: string;
  onChange: (order: string) => void;
}) {
  const asWritten = !order.trim();
  const names = asWritten ? sections.map(s => s.name) : order.split(",").map(s => s.trim()).filter(Boolean);
  const known = new Set(sections.map(s => s.name));
  const unknown = new Set(resolveArrangement(names, sections).unknown);

  const chipRefs = useRef<(HTMLElement | null)[]>([]);
  const [drag, setDrag] = useState<{ from: number; to: number; rects: DOMRect[] } | null>(null);

  const commit = (next: string[]) => onChange(next.join(", "));
  const move = (list: string[], from: number, to: number) => {
    const next = [...list];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    return next;
  };
  const shown = drag ? move(names, drag.from, drag.to) : names;
  // Which original chip a shown chip is, so the dragged one can be highlighted.
  const draggedAt = drag ? drag.to : -1;

  /** The slot nearest the pointer, measured on the chips' positions when the drag began. */
  const slotAt = (x: number, y: number, rects: DOMRect[]) => {
    let best = 0, bestDist = Infinity;
    rects.forEach((r, i) => {
      const dx = x - (r.left + r.width / 2), dy = (y - (r.top + r.height / 2)) * 2;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = i; }
    });
    return best;
  };

  const count = (name: string) => names.filter(n => n === name).length;

  return (
    <div className="arr">
      <div className="arr-head">
        <span className="field-label">Order</span>
        <span className="arr-hint">
          {asWritten ? "As written — drag to change" : "Drag to reorder · × removes · add sections below"}
        </span>
        {!asWritten && (
          <button className="link-btn" onClick={() => onChange("")} title="Play every section once, top to bottom">
            Reset to as written
          </button>
        )}
      </div>

      <div className="arr-chips" role="list">
        {shown.map((name, i) => (
          <span
            key={`${i}-${name}`}
            ref={el => { chipRefs.current[i] = el; }}
            role="listitem"
            tabIndex={0}
            className={`arr-chip${i === draggedAt ? " arr-chip--dragging" : ""}${unknown.has(name) || !known.has(name) ? " arr-chip--unknown" : ""}`}
            title={unknown.has(name) ? `No section named "${name}"` : "Drag to move · ← → with the keyboard"}
            onPointerDown={e => {
              if ((e.target as HTMLElement).closest("button")) return;
              e.currentTarget.setPointerCapture(e.pointerId);
              const rects = names.map((_, j) => chipRefs.current[j]?.getBoundingClientRect() ?? new DOMRect());
              setDrag({ from: i, to: i, rects });
            }}
            onPointerMove={e => {
              if (!drag) return;
              const to = slotAt(e.clientX, e.clientY, drag.rects);
              if (to !== drag.to) setDrag({ ...drag, to });
            }}
            onPointerUp={() => {
              if (drag && drag.to !== drag.from) commit(move(names, drag.from, drag.to));
              setDrag(null);
            }}
            onPointerCancel={() => setDrag(null)}
            onKeyDown={e => {
              const to = e.key === "ArrowLeft" ? i - 1 : e.key === "ArrowRight" ? i + 1 : -1;
              if (to >= 0 && to < names.length) {
                e.preventDefault();
                commit(move(names, i, to));
                requestAnimationFrame(() => chipRefs.current[to]?.focus());
              }
            }}
          >
            <span className="arr-num">{i + 1}</span>
            {name}
            <button className="arr-x" aria-label={`Remove ${name}`}
                    onClick={() => commit(names.filter((_, j) => j !== i))}>×</button>
          </span>
        ))}
        {!shown.length && <span className="arr-empty">No sections — add some below</span>}
      </div>

      <div className="arr-palette">
        <span className="arr-hint">Add:</span>
        {sections.map((s, i) => (
          <button key={`${i}-${s.name}`} className="arr-add" onClick={() => commit([...names, s.name])}
                  title={`Add ${s.name} to the end${count(s.name) ? " (plays it again — same slides)" : ""}`}>
            + {s.name}
            {count(s.name) > 1 && <span className="arr-count">×{count(s.name)}</span>}
            {count(s.name) === 0 && <span className="arr-count arr-count--none">not played</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
