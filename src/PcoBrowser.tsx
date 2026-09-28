import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";

// Shapes returned by scripts/pco.py
interface PcoSong { id: string; title: string; author: string }
interface PcoArrangement {
  id: string; name: string; chord_chart: string; chord_chart_key: string;
  has_chord_chart: boolean; lyrics: string; sequence: string[];
}
interface PcoServiceType { id: string; name: string }
interface PcoPlan { id: string; dates: string; title: string; series_title: string }
interface PcoPlanSong { item_id: string; title: string; song_id: string; arrangement_id: string | null; key: string }

export interface PcoLoadedSong {
  title: string;
  artist: string;
  arrangementName: string;
  /** ChordPro chart (falls back to plain lyrics when there's no chart). */
  chart: string;
  /** Key the chart is written in, per Planning Center. */
  chartKey: string;
  /** Key the song is scheduled in for the chosen plan ("" from search). */
  planKey: string;
  /** Arrangement sequence, e.g. ["Verse 1", "Chorus", …]. */
  sequence: string[];
}

async function pco<T>(command: string, args: Record<string, string> = {}): Promise<T> {
  const raw = await invoke<string>("pco", { command, ...args });
  const data = JSON.parse(raw);
  if (data.error) throw new Error(data.error);
  return data as T;
}

export default function PcoBrowser({
  connected, onLoad, onOpenPrefs, onError,
}: {
  connected: boolean;
  onLoad: (song: PcoLoadedSong) => void;
  onOpenPrefs: () => void;
  onError: (message: string) => void;
}) {
  const [view, setView]         = useState<"search" | "plans">("search");
  const [busy, setBusy]         = useState(false);
  const [query, setQuery]       = useState("");
  const [songs, setSongs]       = useState<PcoSong[] | null>(null);
  const [song, setSong]         = useState<PcoSong | null>(null);
  const [arrangements, setArrangements] = useState<PcoArrangement[] | null>(null);
  const [planKey, setPlanKey]   = useState("");

  const [serviceTypes, setServiceTypes] = useState<PcoServiceType[] | null>(null);
  const [serviceType, setServiceType]   = useState("");
  const [plans, setPlans]       = useState<PcoPlan[] | null>(null);
  const [plan, setPlan]         = useState("");
  const [planSongs, setPlanSongs] = useState<PcoPlanSong[] | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const load = (s: { title: string; author: string }, a: PcoArrangement, key: string) => {
    const chart = a.chord_chart.trim() ? a.chord_chart : a.lyrics;
    if (!chart.trim()) {
      onError(`"${a.name}" has no chord chart or lyrics in Planning Center.`);
      return;
    }
    onLoad({
      title: s.title, artist: s.author, arrangementName: a.name, chart,
      chartKey: a.chord_chart_key, planKey: key, sequence: a.sequence || [],
    });
  };

  const openSong = (s: PcoSong, key = "", preferArrangement: string | null = null) => run(async () => {
    setSong(s); setPlanKey(key); setArrangements(null);
    const data = await pco<{ song: PcoSong; arrangements: PcoArrangement[] }>("arrangements", { song: s.id });
    const full = { ...s, title: data.song.title || s.title, author: data.song.author || s.author };
    setSong(full);
    const pick = data.arrangements.find(a => a.id === preferArrangement)
      ?? (data.arrangements.length === 1 ? data.arrangements[0] : null);
    if (pick) load(full, pick, key);
    setArrangements(data.arrangements);
  });

  // A song opened in one view shouldn't cover the other view's list.
  const switchView = (v: "search" | "plans") => {
    setView(v); setSong(null); setArrangements(null); setPlanKey("");
  };

  const search = () => run(async () => {
    setSong(null); setArrangements(null);
    setSongs((await pco<{ songs: PcoSong[] }>("songs", { query })).songs);
  });

  // Plans view: service types load once, the first time the view is opened.
  useEffect(() => {
    if (view !== "plans" || serviceTypes || !connected) return;
    run(async () => {
      const t = (await pco<{ service_types: PcoServiceType[] }>("service-types")).service_types;
      setServiceTypes(t);
      if (t.length === 1) setServiceType(t[0].id);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, connected]);

  useEffect(() => {
    setPlans(null); setPlan(""); setPlanSongs(null);
    if (!serviceType) return;
    run(async () => {
      const p = (await pco<{ plans: PcoPlan[] }>("plans", { serviceType })).plans;
      setPlans(p);
      if (p.length) setPlan(p[0].id);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceType]);

  useEffect(() => {
    setPlanSongs(null);
    if (!plan || !serviceType) return;
    run(async () => {
      setPlanSongs((await pco<{ songs: PcoPlanSong[] }>("plan-songs", { serviceType, plan })).songs);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan]);

  if (!connected) {
    return (
      <div className="pco-connect">
        <div className="drop-icon">📋</div>
        <div className="drop-label">Connect Planning Center</div>
        <div className="drop-sub">Add your Personal Access Token in Preferences to pull chord charts from Services.</div>
        <button className="fetch-btn" onClick={onOpenPrefs}>Open Preferences</button>
      </div>
    );
  }

  return (
    <div className="pco-browser">
      <div className="mode-toggle pco-view-toggle" role="group" aria-label="Find songs by">
        <button className={`toggle-btn${view === "search" ? " active" : ""}`} onClick={() => switchView("search")}>
          Search songs
        </button>
        <button className={`toggle-btn${view === "plans" ? " active" : ""}`} onClick={() => switchView("plans")}>
          Upcoming plans
        </button>
      </div>

      {view === "search" && (
        <>
          <div className="url-row">
            <input className="url-input" placeholder="Song title…" value={query}
                   onChange={e => setQuery(e.target.value)}
                   onKeyDown={e => { if (e.key === "Enter") search(); }} />
            <button className={`fetch-btn${busy ? " disabled" : ""}`} onClick={search} disabled={busy}>
              {busy ? "⏳" : "Search"}
            </button>
          </div>
          {songs && !song && (
            <div className="pco-list">
              {songs.length === 0 && <div className="pco-empty">No songs found.</div>}
              {songs.map(s => (
                <button className="pco-item" key={s.id} onClick={() => openSong(s)}>
                  <span className="pco-item-title">{s.title}</span>
                  {s.author && <span className="pco-item-sub">{s.author}</span>}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {view === "plans" && (
        <>
          <div className="pco-plan-row">
            <select className="key-select" value={serviceType} onChange={e => setServiceType(e.target.value)}>
              <option value="">Service type…</option>
              {serviceTypes?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <select className="key-select" value={plan} onChange={e => setPlan(e.target.value)} disabled={!plans?.length}>
              {!plans?.length && <option value="">{plans ? "No upcoming plans" : "Plan…"}</option>}
              {plans?.map(p => (
                <option key={p.id} value={p.id}>{p.dates}{p.title ? ` — ${p.title}` : ""}</option>
              ))}
            </select>
            {busy && <span className="key-hint">⏳</span>}
          </div>
          {planSongs && !song && (
            <div className="pco-list">
              {planSongs.length === 0 && <div className="pco-empty">No songs in this plan.</div>}
              {planSongs.map(s => (
                <button className="pco-item" key={s.item_id}
                        onClick={() => openSong({ id: s.song_id, title: s.title, author: "" }, s.key, s.arrangement_id)}>
                  <span className="pco-item-title">{s.title}</span>
                  {s.key && <span className="pco-item-key">{s.key}</span>}
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {song && (
        <div className="pco-list">
          <div className="pco-list-head">
            <span><strong>{song.title}</strong>{song.author ? ` · ${song.author}` : ""} — arrangements</span>
            <button className="link-btn" onClick={() => { setSong(null); setArrangements(null); }}>← back</button>
          </div>
          {!arrangements && <div className="pco-empty">Loading…</div>}
          {arrangements?.length === 0 && <div className="pco-empty">This song has no arrangements.</div>}
          {arrangements?.map(a => (
            <button className="pco-item" key={a.id} onClick={() => load(song, a, planKey)}>
              <span className="pco-item-title">{a.name}</span>
              {a.chord_chart_key && <span className="pco-item-key">{a.chord_chart_key}</span>}
              {!a.has_chord_chart && <span className="pco-item-sub">{a.lyrics ? "lyrics only" : "no chart"}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
