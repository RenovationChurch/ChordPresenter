import { useState, useEffect, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import {
  MAJOR_KEYS, MINOR_KEYS, analyzeKey, canonicalKey, prefersFlats,
  semitonesBetween, shiftKey, toConcert,
} from "./music";
import { buildPrintHtml } from "./print";
import {
  NotesMode, RenderOpts, RhythmMode, TextCase, chordNames, importToEditorText,
  parseEditorText, parsePcoChart, resolveArrangement, toChordOverLyric, toSongJson,
} from "./chordpro";
import PcoBrowser, { PcoLoadedSong } from "./PcoBrowser";
import SlideEditor from "./SlideEditor";

// Sentinel used to join a slide's lyric lines into one exportable chart line
// when a slide has 2+ lines (Edit .pro mode). U+E000 (Private Use Area) never
// appears in real lyric/chord text and — unlike U+2028/U+2029 — is NOT
// treated as a line break by Python's str.splitlines(), so it survives the
// splitlines() calls in ew_fetch.py/md_to_pro.py intact and lets md_to_pro.py
// rebuild an explicit multi-line slide instead of splitting the lines into
// separate 1-line slides. Must match SLIDE_LINE_SEP in md_to_pro.py.
const SLIDE_LINE_SEP = "\ue000";

function parseSongMeta(mdContent: string): { title: string; artist: string } {
  const m = mdContent.match(/^title:\s*"([^"]+)"/m);
  if (!m) return { title: "", artist: "" };
  const parts = m[1].split("|").map(p => p.trim());
  const title = parts[0].replace(/\s*\|\s*chords.*/i, "").trim();
  const artist = parts[1] && !/^chords/i.test(parts[1]) ? parts[1] : "";
  return { title, artist };
}

/** Extract the chart body from an MD file for preview/editing.
 *  Tries the ``` code block first, then falls back to stripping frontmatter. */
function extractChartBody(mdContent: string): string {
  const codeMatch = mdContent.match(/```[^\n]*\n([\s\S]*?)```/);
  if (codeMatch) return codeMatch[1].trim();
  // Fallback: strip YAML frontmatter and leading blank lines
  return mdContent.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "").trim();
}

/**
 * Normalise section headers in a chart body so the preview shows what
 * ProPresenter will actually receive, matching the Python parser's output.
 *
 * Rules (applied per line, non-indented lines only):
 *  [VERSE 1] / [chorus]     → [Verse 1] / [Chorus]   (bracket + title-case)
 *  First Verse / Second Chorus → [Verse 1] / [Chorus 2]  (ordinal words)
 *  Verse 1: / CHORUS        → [Verse 1] / [Chorus]   (named without brackets)
 */
function normalizeChartHeaders(chart: string): string {
  const ORDINAL_MAP: Record<string, string> = {
    first:'1', second:'2', third:'3', fourth:'4', fifth:'5',
    sixth:'6', seventh:'7', eighth:'8', ninth:'9', tenth:'10',
  };
  const SECTION_WORDS =
    'intro|verse|chorus|pre[\\s\\-]?chorus|bridge|tag|outro|interlude|' +
    'instrumental|ending|coda|hook|turn|turnaround|transition|vamp|breakdown|refrain';
  const ORDINAL_RE = new RegExp(
    `^(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\\s+(${SECTION_WORDS})\\s*:?\\s*$`,
    'i'
  );
  const NAMED_RE = new RegExp(
    `^(${SECTION_WORDS})\\s*(\\d*)\\s*:?\\s*$`,
    'i'
  );

  return chart.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Already bracketed: normalise capitalisation of first word, preserve number.
    // [VERSE 1] → [Verse 1],  [chorus] → [Chorus],  [Pre-Chorus] → [Pre-Chorus]
    const bracketM = trimmed.match(/^\[([^\]]+)\](.*)/);
    if (bracketM) {
      const parts = bracketM[1].trim().split(/\s+/);
      const label = parts[0].charAt(0).toUpperCase() + parts[0].slice(1).toLowerCase();
      const rest  = parts.slice(1).join(' ');
      return `[${rest ? `${label} ${rest}` : label}]${bracketM[2]}`;
    }

    // Section headers are never indented — skip indented lines.
    if (line[0] === ' ' || line[0] === '\t') return line;

    // Ordinal: "First Verse" → "[Verse 1]"
    const ordM = trimmed.match(ORDINAL_RE);
    if (ordM) {
      const num = ORDINAL_MAP[ordM[1].toLowerCase()];
      const sec = ordM[2].charAt(0).toUpperCase() + ordM[2].slice(1).toLowerCase();
      return `[${sec} ${num}]`;
    }

    // Named without brackets: "Verse 1:" / "CHORUS" → "[Verse 1]" / "[Chorus]"
    const namedM = trimmed.match(NAMED_RE);
    if (namedM) {
      const sec = namedM[1].charAt(0).toUpperCase() + namedM[1].slice(1).toLowerCase();
      const num = namedM[2] ? ` ${namedM[2]}` : '';
      return `[${sec}${num}]`;
    }

    return line;
  }).join('\n');
}

// ── Types ─────────────────────────────────────────────────────────────────────
type Status     = "idle" | "running" | "ok" | "err";
type Mode       = "file" | "url" | "pro" | "pco";
type PrefsTab   = "folders" | "slides" | "pco" | "log";
type OutputMode = "both" | "lyrics";

interface AppConfig {
  output_dir: string;
  pco_app_id: string;
  pco_secret: string;
  /** Blank slides at the start of every song, for the operator. */
  opening_enabled: boolean;
  opening_name: string;
  opening_count: number;
  text_case: TextCase;
  rhythm_marks: RhythmMode;
  chord_notes: NotesMode;
}

// Defaults match the Rust Config defaults (src-tauri/src/main.rs).
const EMPTY_CONFIG: AppConfig = {
  output_dir: "", pco_app_id: "", pco_secret: "",
  opening_enabled: true, opening_name: "Opening", opening_count: 2,
  text_case: "upper", rhythm_marks: "instrumental", chord_notes: "beside",
};

/** A song loaded into the slide editor, from any source. */
interface SongDoc {
  source: "file" | "url" | "pco";
  title: string;
  artist: string;
  /** Arrangement name (PCO) — shown under the title. */
  subtitle: string;
  /** Slide editor text (ChordPro, blank line = new slide). */
  text: string;
  /** Arrangement order, comma-separated section names ("" = as written). */
  order: string;
}

/** Stage-display note for the first slide (same text as md_to_pro.capo_note). */
function capoNote(capo: number, concertKey: string, shapesKey: string): string {
  return `CAPO ${capo} - chords are ${shapesKey} shapes (sounds in ${concertKey}).\n` +
         `No capo / electric / keys: play in ${concertKey}.`;
}

interface EwData {
  title: string;
  artist: string;
  key: string;
  capo?: number;
  chart_text: string;
  lyrics_only?: boolean;
  error?: string;
}

interface ProSlide {
  index: number;
  group: string;
  lines: string[];
  chords: string;
}

// ── Preferences panel ─────────────────────────────────────────────────────────
function PreferencesPanel({
  config,
  initialTab,
  onSave,
  onClose,
}: {
  config: AppConfig;
  initialTab: PrefsTab;
  onSave: (c: AppConfig) => void;
  onClose: () => void;
}) {
  const [local, setLocal]     = useState<AppConfig>({ ...config });
  const [logPath, setLogPath] = useState("");
  const [logs, setLogs]       = useState("");
  const [tab, setTab]         = useState<PrefsTab>(initialTab);
  const [pcoTest, setPcoTest] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    invoke<string>("get_log_path").then(setLogPath);
    if (tab === "log") invoke<string>("get_recent_logs").then(setLogs);
  }, [tab]);

  const browse = async () => {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setLocal(prev => ({ ...prev, output_dir: sel }));
  };

  const persist = () => invoke("save_config", { config: local });
  const set = <K extends keyof AppConfig>(k: K, v: AppConfig[K]) =>
    setLocal(prev => ({ ...prev, [k]: v }));

  const save = async () => {
    await persist();
    onSave(local);
    onClose();
  };

  // pco.py reads the token from the config file, so save before testing.
  const testPco = async () => {
    setPcoTest({ ok: true, text: "Testing…" });
    try {
      await persist();
      onSave(local);
      const data = JSON.parse(await invoke<string>("pco", { command: "test" }));
      setPcoTest(data.error
        ? { ok: false, text: data.error }
        : { ok: true, text: `Connected to ${data.organization || "Planning Center"}` });
    } catch (err) {
      setPcoTest({ ok: false, text: String(err) });
    }
  };

  const clearLog = async () => {
    await invoke("clear_log");
    setLogs("");
  };

  const shortPath = (p: string) =>
    p ? `…/${p.split("/").slice(-2).join("/")}` : "";

  const FIELDS: { key: "output_dir"; label: string; hint: string }[] = [
    { key: "output_dir", label: "Output Folder", hint: "ProPresenter-watched folder where .pro files are saved" },
  ];

  return (
    <div className="prefs-backdrop" onClick={onClose}>
      <div className="prefs-panel" onClick={e => e.stopPropagation()}>

        <div className="prefs-header">
          <h2 className="prefs-title">Preferences</h2>
          <button className="prefs-close" onClick={onClose}>✕</button>
        </div>

        {/* Tab bar */}
        <div className="prefs-tabs">
          <button className={`prefs-tab${tab === "folders" ? " active" : ""}`} onClick={() => setTab("folders")}>Folders</button>
          <button className={`prefs-tab${tab === "slides"  ? " active" : ""}`} onClick={() => setTab("slides")}>Slides</button>
          <button className={`prefs-tab${tab === "pco"     ? " active" : ""}`} onClick={() => setTab("pco")}>Planning Center</button>
          <button className={`prefs-tab${tab === "log"     ? " active" : ""}`} onClick={() => setTab("log")}>Log</button>
        </div>

        {/* Folders tab */}
        {tab === "folders" && (
          <div className="prefs-body">
            {FIELDS.map(({ key, label, hint }) => (
              <div className="prefs-row" key={key}>
                <div className="prefs-row-top">
                  <span className="prefs-label">{label}</span>
                  <button className="prefs-browse" onClick={browse}>Browse…</button>
                </div>
                <div
                  className={`prefs-path${!local[key] ? " prefs-path--empty" : ""}`}
                  title={local[key] || ""}
                >
                  {local[key] ? shortPath(local[key]) : "Not set — click Browse"}
                </div>
                <div className="prefs-hint">{hint}</div>
              </div>
            ))}
            <div className="prefs-note">
              ℹ️ Python scripts are bundled inside the app — no configuration needed.
            </div>
          </div>
        )}

        {/* Slides tab */}
        {tab === "slides" && (
          <div className="prefs-body">
            <div className="prefs-row">
              <label className="prefs-check">
                <input type="checkbox" checked={local.opening_enabled}
                       onChange={e => set("opening_enabled", e.target.checked)} />
                <span className="prefs-label">Add blank slides at the start of each song</span>
              </label>
              <div className={`prefs-inline${local.opening_enabled ? "" : " prefs-inline--off"}`}>
                <input className="url-input prefs-num" type="number" min={1} max={20}
                       value={local.opening_count} disabled={!local.opening_enabled}
                       onChange={e => set("opening_count", Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
                <span className="prefs-hint">slide(s) in a group named</span>
                <input className="url-input" value={local.opening_name} disabled={!local.opening_enabled}
                       onChange={e => set("opening_name", e.target.value)} placeholder="Opening" />
              </div>
              <div className="prefs-hint">Room for backgrounds, walk-in media or an audience look before the first lyric.</div>
            </div>

            <div className="prefs-row">
              <span className="prefs-label">Lyric capitalization</span>
              <select className="key-select prefs-select" value={local.text_case}
                      onChange={e => set("text_case", e.target.value as TextCase)}>
                <option value="upper">ALL CAPS</option>
                <option value="asis">As written</option>
                <option value="line">Capitalize the first letter of each line</option>
              </select>
              <div className="prefs-hint">
                "As written" keeps normal case on the stage display — turn on your ProPresenter
                theme's All Caps to still show capitals to the audience.
              </div>
            </div>

            <div className="prefs-row">
              <span className="prefs-label">Bar lines ( | ) and beat slashes ( / )</span>
              <select className="key-select prefs-select" value={local.rhythm_marks}
                      onChange={e => set("rhythm_marks", e.target.value as RhythmMode)}>
                <option value="instrumental">Only on instrumental lines (intro, turnaround…)</option>
                <option value="all">Everywhere</option>
                <option value="none">Hide — chord names only</option>
              </select>
            </div>

            <div className="prefs-row">
              <span className="prefs-label">Performance notes — <i>(italic)</i> text in charts</span>
              <select className="key-select prefs-select" value={local.chord_notes}
                      onChange={e => set("chord_notes", e.target.value as NotesMode)}>
                <option value="beside">Next to the chord — "B (dropout)"</option>
                <option value="slide">In the slide notes (stage display only)</option>
                <option value="hide">Hide</option>
              </select>
              <div className="prefs-hint">
                Notes on section headings are left off the slides unless "slide notes" is chosen.
                To show slide notes, add a Slide Notes object to your stage layout.
              </div>
            </div>
          </div>
        )}

        {/* Planning Center tab */}
        {tab === "pco" && (
          <div className="prefs-body">
            <div className="prefs-note">
              Create a <strong>Personal Access Token</strong> at{" "}
              <code>api.planningcenteronline.com/oauth/applications</code> (signed in to your
              church's account), then paste its Application ID and Secret here.
              ChordPresenter only reads songs and plans.
            </div>
            <div className="prefs-row">
              <span className="prefs-label">Application ID</span>
              <input className="url-input" value={local.pco_app_id} spellCheck={false}
                     onChange={e => set("pco_app_id", e.target.value)} />
            </div>
            <div className="prefs-row">
              <span className="prefs-label">Secret</span>
              <input className="url-input" type="password" value={local.pco_secret} spellCheck={false}
                     onChange={e => set("pco_secret", e.target.value)} />
              <div className="prefs-hint">Stored in ~/.config/chordpresenter/config.json, readable only by you.</div>
            </div>
            <div className="prefs-row-top">
              <button className="prefs-browse" onClick={testPco}
                      disabled={!local.pco_app_id.trim() || !local.pco_secret.trim()}>
                Test connection
              </button>
              {pcoTest && (
                <span className={`pco-test ${pcoTest.ok ? "ok" : "err"}`}>{pcoTest.text}</span>
              )}
            </div>
          </div>
        )}

        {/* Log tab */}
        {tab === "log" && (
          <div className="prefs-body prefs-body--log">
            <div className="log-path" title={logPath}>Log file: {logPath || "—"}</div>
            <textarea
              className="log-textarea"
              readOnly
              value={logs || "(no log entries yet)"}
              spellCheck={false}
            />
            <button className="log-clear-btn" onClick={clearLog}>Clear Log</button>
          </div>
        )}

        <div className="prefs-footer">
          {tab !== "log" && <>
            <button className="prefs-cancel" onClick={onClose}>Cancel</button>
            <button className="prefs-save" onClick={save}>Save</button>
          </>}
          {tab === "log" && (
            <button className="prefs-cancel" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  // ── Config / prefs ────────────────────────────────────────────
  const [config, setConfig]       = useState<AppConfig>(EMPTY_CONFIG);
  const [showPrefs, setShowPrefs] = useState(false);
  const [prefsTab, setPrefsTab]   = useState<PrefsTab>("folders");
  const openPrefs = useCallback((tab: PrefsTab = "folders") => {
    setPrefsTab(tab); setShowPrefs(true);
  }, []);

  // Load config on startup; open prefs automatically if output folder not set
  useEffect(() => {
    invoke<AppConfig>("get_config").then(cfg => {
      setConfig({ ...EMPTY_CONFIG, ...cfg });
      if (cfg.output_dir) setOutputDir(cfg.output_dir);
      else setShowPrefs(true);  // first run — prompt user to set output folder
    });
  }, []);

  // Listen for Preferences… menu item
  useEffect(() => {
    const unsub = listen("open-preferences", () => openPrefs());
    return () => { unsub.then(f => f()); };
  }, [openPrefs]);

  const handleConfigSave = (cfg: AppConfig) => {
    setConfig(cfg);
    if (cfg.output_dir) setOutputDir(cfg.output_dir);
  };

  // ── Shared state ──────────────────────────────────────────────
  const [mode, setMode]             = useState<Mode>("file");
  const [outputMode, setOutputMode] = useState<OutputMode>("both");
  const [detectedKey, setDetectedKey] = useState("");
  const [targetKey, setTargetKey]     = useState("");
  // Capo the SOURCE chart was written for. The chart is converted to concert
  // pitch on load, so this is informational (and offered as an output capo).
  const [sourceCapo, setSourceCapo]   = useState(0);
  const [sourceShapes, setSourceShapes] = useState("");
  // Capo for the OUTPUT: chords are written as shapes for (key − capo).
  const [outputCapo, setOutputCapo]   = useState(0);
  const [outputDir, setOutputDir]     = useState("");
  const [status, setStatus]           = useState<Status>("idle");
  const [message, setMessage]         = useState("");

  // ── The song in the slide editor (from File, URL or Planning Center) ──
  const [doc, setDoc]                 = useState<SongDoc | null>(null);
  const [linesPerSlide, setLinesPerSlide] = useState(2);
  const sections = useMemo(() => parseEditorText(doc?.text ?? ""), [doc?.text]);
  const editDoc = useCallback((patch: Partial<SongDoc>) =>
    setDoc(d => (d ? { ...d, ...patch } : d)), []);

  // ── File mode state ────────────────────────────────────────────
  const [mdPath, setMdPath]           = useState("");
  const [isDragging, setIsDragging]   = useState(false);

  // ── URL mode state ─────────────────────────────────────────────
  const [urlInput, setUrlInput]     = useState("");
  const [isFetching, setIsFetching] = useState(false);
  const [ewData, setEwData]         = useState<EwData | null>(null);

  // ── Pro edit mode state ────────────────────────────────────────
  const [proPath, setProPath]     = useState("");
  const [proTitle, setProTitle]   = useState("");
  const [proSlides, setProSlides] = useState<ProSlide[]>([]);
  const [proLoading, setProLoading] = useState(false);

  // ── Planning Center mode state ─────────────────────────────────
  const pcoConnected = Boolean(config.pco_app_id && config.pco_secret);

  // ── Switch mode ────────────────────────────────────────────────
  const switchMode = useCallback((m: Mode) => {
    setMode(m); setStatus("idle"); setMessage("");
  }, []);

  // ── Shared: key/capo from a freshly loaded chart ───────────────
  // Charts written for a capo are converted to concert pitch on load, so the
  // preview, the Key picker, and what Python receives as --source-key all
  // describe the same chords. Output capo starts at 0 (concert chords, which
  // electric/keys need); the source capo is offered as a one-click option.
  const applyKeyInfo = useCallback((info: ReturnType<typeof analyzeKey>) => {
    setDetectedKey(info.concertKey); setTargetKey(info.concertKey);
    setSourceCapo(info.capo); setSourceShapes(info.capo ? info.chartKey : "");
    setOutputCapo(0);
  }, []);

  // ── Any source → slide editor ──────────────────────────────────
  // Parses the chart into sections, splits them into slides, and fills in
  // the arrangement: the PCO sequence if it matches the chart, otherwise the
  // chart's own order when it repeats a section (Chorus written 3 times).
  const openInEditor = useCallback((
    source: SongDoc["source"], meta: { title: string; artist: string; subtitle?: string },
    chart: string, sequence: string[] = [],
  ) => {
    const imported = parsePcoChart(chart);
    const text = importToEditorText(imported, linesPerSlide);
    const secs = parseEditorText(text);
    const seq = resolveArrangement(sequence, secs);
    const repeats = new Set(imported.order).size !== imported.order.length;
    const order = seq.order.length && !seq.unknown.length ? seq.order
      : repeats ? imported.order : seq.order;
    setDoc({ source, title: meta.title, artist: meta.artist, subtitle: meta.subtitle ?? "",
             text, order: order.map(i => secs[i].name).join(", ") });
    setStatus("idle"); setMessage("");
    return { imported, sections: secs };
  }, [linesPerSlide]);

  // ── File mode: load ────────────────────────────────────────────
  const loadFile = useCallback((path: string) => {
    setMdPath(path); setStatus("idle"); setMessage("");
    invoke<string>("read_file", { path })
      .then(content => {
        const meta = parseSongMeta(content);
        const body = extractChartBody(content);
        const info = analyzeKey(content, body);
        applyKeyInfo(info);
        openInEditor("file", {
          title: meta.title || path.split("/").pop()?.replace(/\.md$/, "") || "",
          artist: meta.artist,
        }, normalizeChartHeaders(toConcert(body, info)));
      })
      .catch(err => { setStatus("err"); setMessage(String(err)); });
  }, [applyKeyInfo, openInEditor]);

  // ── Pro edit mode: load .pro file ──────────────────────────────
  const loadProFile = useCallback(async (path: string) => {
    setProPath(path);
    setProLoading(true);
    setStatus("idle");
    setMessage("");
    setMode("pro");
    try {
      const jsonStr = await invoke<string>("parse_pro", { proPath: path });
      const data = JSON.parse(jsonStr);
      if (data.error) {
        setStatus("err");
        setMessage(`Parse error: ${data.error}`);
        setProLoading(false);
        return;
      }
      setProTitle(
        data.title || path.split("/").pop()?.replace(/\.pro$/, "") || ""
      );
      // group + chords come straight from parse_pro.py — chords are
      // pre-filled from whatever's already embedded on the source .pro so
      // untouched slides keep their existing chords instead of losing them
      // on export.
      setProSlides(
        (data.slides as { index: number; group: string; lines: string[]; chords: string }[]).map(s => ({
          index: s.index,
          group: s.group || "Slide",
          lines: s.lines,
          chords: s.chords || "",
        }))
      );
    } catch (err) {
      setStatus("err");
      setMessage(String(err));
    } finally {
      setProLoading(false);
    }
  }, []);

  // Tauri file-drop events — handles both .md and .pro
  useEffect(() => {
    const p1 = listen<string[]>("tauri://file-drop", e => {
      const pro = e.payload.find(f => f.endsWith(".pro"));
      const md  = e.payload.find(f => f.endsWith(".md"));
      setIsDragging(false);
      if (pro) {
        loadProFile(pro);
      } else if (md) {
        loadFile(md);
        setMode("file");
      }
    });
    const p2 = listen("tauri://file-drop-hover",     () => setIsDragging(true));
    const p3 = listen("tauri://file-drop-cancelled", () => setIsDragging(false));
    return () => { p1.then(f=>f()); p2.then(f=>f()); p3.then(f=>f()); };
  }, [loadFile, loadProFile]);

  const browseFile = useCallback(async () => {
    const sel = await open({ filters: [{ name: "Markdown", extensions: ["md"] }], multiple: false });
    if (typeof sel === "string") loadFile(sel);
  }, [loadFile]);

  const browseProFile = useCallback(async () => {
    const sel = await open({
      filters: [{ name: "ProPresenter", extensions: ["pro"] }],
      multiple: false,
    });
    if (typeof sel === "string") loadProFile(sel);
  }, [loadProFile]);

  const resetKeys = useCallback(() => {
    setDetectedKey(""); setTargetKey("");
    setSourceCapo(0); setSourceShapes(""); setOutputCapo(0);
    setStatus("idle"); setMessage("");
  }, []);

  const clearFile = useCallback(() => {
    setMdPath(""); setDoc(null); resetKeys();
  }, [resetKeys]);

  const clearPro = useCallback(() => {
    setProPath(""); setProTitle(""); setProSlides([]);
    setStatus("idle"); setMessage("");
  }, []);

  const clearUrl = useCallback(() => {
    setUrlInput(""); setEwData(null); setDoc(null); resetKeys();
  }, [resetKeys]);

  const clearPco = useCallback(() => { setDoc(null); resetKeys(); }, [resetKeys]);

  // ── Planning Center: song picked → slide editor ────────────────
  const loadPcoSong = useCallback((song: PcoLoadedSong) => {
    const { imported, sections: secs } = openInEditor("pco",
      { title: song.title, artist: song.artist, subtitle: song.arrangementName },
      song.chart, song.sequence);
    // Key the chart is written in: PCO's chord_chart_key, then a {key:} line,
    // then detection from the chords themselves.
    const info = analyzeKey("", chordNames(secs).join(" "),
                            canonicalKey(song.chartKey) || canonicalKey(imported.key), 0);
    applyKeyInfo(info);
    // Coming from a plan: default to the key the song is scheduled in.
    const planKey = canonicalKey(song.planKey);
    if (planKey && info.chartKey) setTargetKey(planKey);
    setOutputMode("both");
    if (!info.chartKey) setMessage("No chords found — this will export as lyrics only.");
  }, [openInEditor, applyKeyInfo]);

  // ── Pro edit mode: update chords for a slide ───────────────────
  const updateSlideChords = useCallback((index: number, chords: string) => {
    setProSlides(prev =>
      prev.map(s => s.index === index ? { ...s, chords } : s)
    );
  }, []);

  // ── Pro edit mode: export to .pro ─────────────────────────────
  const exportProChart = useCallback(async () => {
    if (!proSlides.length) return;

    // Build chord chart text.
    // A [GroupName] section header is emitted only when the group changes
    // from the previous slide, so consecutive slides that came from the same
    // original group (Verse 1, Chorus, etc.) stay together as one group on
    // export instead of every slide becoming its own "Slide N" group.
    // Re-emitting the header when a group name repeats later in the song
    // (e.g. a second "Chorus") correctly starts a new, separate group there
    // too — matching how the original file was structured.
    //
    // Slides with 2+ lyric lines are joined with SLIDE_LINE_SEP so md_to_pro.py
    // reconstructs a single multi-line slide instead of splitting them into
    // separate 1-line slides (see matching constant there).
    const chartLines: string[] = [];
    let prevGroup: string | null = null;
    for (const slide of proSlides) {
      const groupName = slide.group || "Slide";
      if (groupName !== prevGroup) {
        chartLines.push(`[${groupName}]`);
        prevGroup = groupName;
      }
      if (slide.chords.trim()) {
        chartLines.push(slide.chords.trim());
      }
      if (slide.lines.length > 1) {
        chartLines.push(slide.lines.join(SLIDE_LINE_SEP));
      } else {
        slide.lines.forEach(l => chartLines.push(l));
      }
      chartLines.push("");
    }
    const chartText = chartLines.join("\n").trimEnd();

    setStatus("running"); setMessage("Generating…");
    try {
      const out = await invoke<string>("generate_from_url", {
        title: proTitle,
        artist: "",
        chartText,
        targetKey: null,
        outputDir,
        lyricsOnly: false,
      });
      setStatus("ok");
      const match = out.match(/→\s+(.+\.pro)/);
      setMessage(match ? `Saved: ${match[1]}` : (out.trim() || "Done!"));
    } catch (err) {
      setStatus("err"); setMessage(String(err));
    }
  }, [proSlides, proTitle, outputDir]);

  // ── Key / capo / settings → how chords are rendered ────────────
  const lyricsOnly = outputMode === "lyrics";
  const exportKey = targetKey || detectedKey;
  const exportCapo = lyricsOnly ? 0 : outputCapo;
  const renderOpts = useMemo<RenderOpts & { shapesKey: string }>(() => {
    let shapesKey = exportKey, semitones = 0;
    try {
      if (exportKey && exportCapo) shapesKey = shiftKey(exportKey, -exportCapo);
      if (detectedKey && shapesKey) semitones = semitonesBetween(detectedKey, shapesKey);
    } catch { /* unknown key label — chords as written */ }
    return {
      shapesKey, semitones, preferFlat: prefersFlats(shapesKey), lyricsOnly,
      rhythm: config.rhythm_marks, notes: config.chord_notes,
    };
  }, [exportKey, exportCapo, detectedKey, lyricsOnly, config.rhythm_marks, config.chord_notes]);

  // ── Export the edited slides (all sources) ─────────────────────
  const generateFromEditor = useCallback(async () => {
    if (!doc) return;
    const order = resolveArrangement(doc.order.split(",").filter(s => s.trim()), sections).order;
    const song = toSongJson(sections, renderOpts, {
      title: doc.title, artist: doc.artist, key: exportKey, capo: exportCapo,
      notes: exportCapo ? capoNote(exportCapo, exportKey, renderOpts.shapesKey) : undefined,
      textCase: config.text_case,
      opening: { name: config.opening_name.trim() || "Opening",
                 count: config.opening_enabled ? config.opening_count : 0 },
      arrangement: order.length ? order : undefined,
    });
    setStatus("running"); setMessage("Generating…");
    try {
      const out = await invoke<string>("generate_from_song", { songJson: JSON.stringify(song), outputDir });
      setStatus("ok");
      const match = out.match(/→\s+(.+\.pro)/);
      setMessage(match ? `Saved: ${match[1]}` : (out.trim() || "Done!"));
    } catch (err) {
      setStatus("err"); setMessage(String(err));
    }
  }, [doc, sections, renderOpts, exportKey, exportCapo, config, outputDir]);

  // ── URL mode: fetch ────────────────────────────────────────────
  const fetchEW = useCallback(async () => {
    const url = urlInput.trim();
    if (!url) return;
    setIsFetching(true); setEwData(null); setStatus("idle"); setMessage("");
    try {
      const jsonStr = await invoke<string>("fetch_ew_preview", { url });
      const data: EwData = JSON.parse(jsonStr);
      if (data.error) {
        setStatus("err"); setMessage(`Fetch error: ${data.error}`);
      } else {
        // Site key/capo win over what's written in the chart; chords fill in.
        const chart = data.chart_text || "";
        const info = analyzeKey(chart, chart, data.key || "", data.capo || 0);
        setEwData(data);
        applyKeyInfo(info);
        openInEditor("url", { title: data.title || "", artist: data.artist || "" },
                     normalizeChartHeaders(toConcert(chart, info)));
        if (data.lyrics_only) setOutputMode("lyrics");
      }
    } catch (err) {
      setStatus("err"); setMessage(String(err));
    } finally {
      setIsFetching(false);
    }
  }, [urlInput, applyKeyInfo, openInEditor]);

  // ── Shared: print chart (current key + capo, as the stage monitor shows) ─
  const printChart = useCallback(async () => {
    if (!doc) return;
    const chart = toChordOverLyric(sections, renderOpts);     // already in the export key
    try {
      await invoke("open_print_view", {
        title: `${doc.title || "Chart"}${exportKey ? ` - ${exportKey}` : ""}${exportCapo ? ` (Capo ${exportCapo})` : ""}`,
        html: buildPrintHtml({ title: doc.title, artist: doc.artist, key: exportKey, capo: exportCapo,
                               shapesKey: renderOpts.shapesKey, chart }),
      });
    } catch (err) {
      setStatus("err"); setMessage(`Print failed: ${err}`);
    }
  }, [doc, sections, renderOpts, exportKey, exportCapo]);

  // ── Shared: output folder ──────────────────────────────────────
  const browseOutput = useCallback(async () => {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") setOutputDir(sel);
  }, []);

  // ── Derived ───────────────────────────────────────────────────
  const hasFile     = Boolean(mdPath);
  const fileName    = mdPath.split("/").pop() ?? "";
  const hasOutputDir = Boolean(outputDir);
  // The editor belongs to the tab its song came from.
  const docHere     = doc && doc.source === mode ? doc : null;
  const hasSlides   = sections.some(s => s.slides.length > 0);
  const canGenerate = hasOutputDir && status !== "running" && Boolean(docHere) && hasSlides && !isFetching;
  const canPrint    = Boolean(docHere) && hasSlides;

  // Key of the chord shapes written out for the current key + capo.
  let outputShapes = "";
  try {
    const k = targetKey || detectedKey;
    if (k && outputCapo) outputShapes = shiftKey(k, -outputCapo);
  } catch { /* unknown key label */ }

  const showSharedControls = Boolean(docHere);

  const editor = docHere && (
    <SlideEditor
      text={docHere.text}
      onChange={text => editDoc({ text })}
      arrangement={docHere.order}
      onArrangementChange={order => editDoc({ order })}
      linesPerSlide={linesPerSlide}
      onLinesPerSlideChange={setLinesPerSlide}
      render={renderOpts}
      textCase={config.text_case}
    />
  );

  return (
    <div className="app">
      {/* ── Preferences overlay ── */}
      {showPrefs && (
        <PreferencesPanel
          config={config}
          initialTab={prefsTab}
          onSave={handleConfigSave}
          onClose={() => setShowPrefs(false)}
        />
      )}

      {/* ── Header ── */}
      <header className="header">
        <div className="header-icon">🎵</div>
        <div>
          <h1 className="header-title">ChordPresenter</h1>
          <p className="header-sub">Chord charts → ProPresenter .pro files</p>
        </div>
      </header>

      {/* ── Mode tabs ── */}
      <div className="tabs">
        <button className={`tab${mode === "file" ? " active" : ""}`} onClick={() => switchMode("file")}>
          📄 File
        </button>
        <button className={`tab${mode === "url" ? " active" : ""}`} onClick={() => switchMode("url")}>
          🔗 URL
        </button>
        <button className={`tab${mode === "pco" ? " active" : ""}`} onClick={() => switchMode("pco")}>
          📋 Planning Center
        </button>
        <button className={`tab${mode === "pro" ? " active" : ""}`} onClick={() => switchMode("pro")}>
          ✏️ Edit .pro
        </button>
      </div>

      {/* ══ FILE MODE ══════════════════════════════════════════════ */}
      {mode === "file" && (
        <>
          <div
            className={`drop-zone${isDragging ? " dragging" : ""}${hasFile ? " loaded" : ""}`}
            onClick={!hasFile ? browseFile : undefined}
          >
            {hasFile ? (
              <div className="file-card">
                <div className="file-icon">📄</div>
                <div className="file-meta">
                  <div className="file-song">{docHere?.title || fileName}</div>
                  {docHere?.artist && <div className="file-artist">{docHere.artist}</div>}
                  <div className="file-name">{fileName}</div>
                </div>
                <button className="clear-btn" title="Remove" onClick={e => { e.stopPropagation(); clearFile(); }}>✕</button>
              </div>
            ) : (
              <div className="drop-prompt">
                <div className="drop-icon">{isDragging ? "⬇️" : "📂"}</div>
                <div className="drop-label">{isDragging ? "Drop to load" : "Drop an .md file here"}</div>
                <div className="drop-sub">or click to browse</div>
              </div>
            )}
          </div>

          {hasFile && editor}
        </>
      )}

      {/* ══ URL MODE ═══════════════════════════════════════════════ */}
      {mode === "url" && (
        <>
          <div className="url-row">
            <input
              className="url-input"
              type="url"
              placeholder="Paste a URL (EssentialWorship, WorshipTogether, Ultimate Guitar, WorshipChords, E-Chords…)"
              value={urlInput}
              onChange={e => setUrlInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") fetchEW(); }}
            />
            <button
              className={`fetch-btn${isFetching || !urlInput.trim() ? " disabled" : ""}`}
              onClick={fetchEW}
              disabled={isFetching || !urlInput.trim()}
            >
              {isFetching ? "⏳" : "Fetch"}
            </button>
          </div>

          {ewData && !ewData.error && (
            <div className="ew-card">
              <div className="ew-card-icon">🎵</div>
              <div className="ew-card-meta">
                <div className="ew-title">{ewData.title || "Unknown Title"}</div>
                {ewData.artist && <div className="ew-artist">{ewData.artist}</div>}
              </div>
              <button className="clear-btn" title="Clear and start over" onClick={clearUrl}>✕</button>
            </div>
          )}

          {ewData && !ewData.error && editor}
        </>
      )}

      {/* ══ PLANNING CENTER MODE ═══════════════════════════════════ */}
      {mode === "pco" && (
        <>
          <PcoBrowser
            connected={pcoConnected}
            onLoad={loadPcoSong}
            onOpenPrefs={() => openPrefs("pco")}
            onError={msg => { setStatus("err"); setMessage(msg); }}
          />

          {docHere && (
            <div className="ew-card">
              <div className="ew-card-icon">🎵</div>
              <div className="ew-card-meta">
                <div className="ew-title">{docHere.title}</div>
                <div className="ew-artist">
                  {[docHere.artist, docHere.subtitle].filter(Boolean).join(" · ")}
                </div>
              </div>
              <button className="clear-btn" title="Clear" onClick={clearPco}>✕</button>
            </div>
          )}

          {editor}
        </>
      )}

      {/* ══ EDIT .pro MODE ═════════════════════════════════════════ */}
      {mode === "pro" && (
        <>
          {/* Drop / browse zone */}
          <div
            className={`drop-zone${isDragging ? " dragging" : ""}${proPath ? " loaded" : ""}`}
            onClick={!proPath ? browseProFile : undefined}
          >
            {proLoading ? (
              <div className="drop-prompt">
                <div className="drop-icon">⏳</div>
                <div className="drop-label">Reading file…</div>
                <div className="drop-sub">extracting slides from .pro</div>
              </div>
            ) : proPath ? (
              <div className="file-card">
                <div className="file-icon">🎼</div>
                <div className="file-meta">
                  <div className="file-song">{proTitle}</div>
                  <div className="file-name">{proPath.split("/").pop()}</div>
                </div>
                <button
                  className="clear-btn"
                  title="Remove"
                  onClick={e => { e.stopPropagation(); clearPro(); }}
                >✕</button>
              </div>
            ) : (
              <div className="drop-prompt">
                <div className="drop-icon">{isDragging ? "⬇️" : "🎼"}</div>
                <div className="drop-label">
                  {isDragging ? "Drop to load" : "Drop a .pro file here"}
                </div>
                <div className="drop-sub">or click to browse — add or edit chords per slide</div>
              </div>
            )}
          </div>

          {/* Slide editor */}
          {proSlides.length > 0 && (
            <>
              <div className="slide-list-header">
                <span className="slide-list-count">{proSlides.length} slides</span>
                <span className="slide-list-hint">Type chords above each lyric line</span>
              </div>
              <div className="slide-list">
                {proSlides.map((slide, i) => (
                  <div key={slide.index}>
                    {(i === 0 || proSlides[i - 1].group !== slide.group) && (
                      <div className="slide-group-header">{slide.group}</div>
                    )}
                    <div className="slide-card">
                      <div className="slide-num">Slide {i + 1}</div>
                      <div className="chord-row">
                        <input
                          className="chord-input"
                          type="text"
                          placeholder="A   E   F#m   D"
                          value={slide.chords}
                          onChange={e => updateSlideChords(slide.index, e.target.value)}
                          spellCheck={false}
                        />
                      </div>
                      <div className="lyric-lines">
                        {slide.lines.map((line, j) => (
                          <div className="lyric-line" key={j}>{line}</div>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Output folder */}
              <div className="field-row">
                <label className="field-label">Output</label>
                <div className="field-body output-body">
                  <span className="output-path" title={outputDir}>
                    {outputDir
                      ? `…/${outputDir.split("/").slice(-2).join("/")}`
                      : <span className="output-unset">Not set — open Preferences</span>}
                  </span>
                  <button className="change-btn" onClick={browseOutput}>Change…</button>
                </div>
              </div>

              {!hasOutputDir && (
                <p className="no-output-warning">
                  ⚠️ No output folder set.{" "}
                  <button className="link-btn" onClick={() => openPrefs()}>
                    Open Preferences
                  </button>{" "}
                  to choose where .pro files are saved.
                </p>
              )}

              <button
                className={`generate-btn${(!hasOutputDir || status === "running") ? " disabled" : ""}`}
                onClick={exportProChart}
                disabled={!hasOutputDir || status === "running"}
              >
                {status === "running" ? "⏳  Generating…" : "Export .pro File →"}
              </button>
            </>
          )}
        </>
      )}

      {/* ══ SHARED: KEY · SLIDES · OUTPUT · GENERATE ══════════════ */}
      {showSharedControls && (
        <>
          {/* Key */}
          <div className="field-row">
            <label className="field-label">Key</label>
            <div className="field-body">
              <select
                className="key-select"
                value={targetKey}
                onChange={e => setTargetKey(e.target.value)}
              >
                <option value="">-- auto-detect --</option>
                <optgroup label="Major">
                  {MAJOR_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
                </optgroup>
                <optgroup label="Minor">
                  {MINOR_KEYS.map(k => <option key={k} value={k}>{k}</option>)}
                </optgroup>
              </select>
              {detectedKey && (
                <span className="key-hint">
                  {targetKey && targetKey !== detectedKey
                    ? <>original <strong>{detectedKey}</strong> → transposing to <strong>{targetKey}</strong></>
                    : <>original key: <strong>{detectedKey}</strong></>}
                </span>
              )}
            </div>
          </div>
          {sourceCapo > 0 && (
            <p className="capo-source-note">
              Source chart was written for <strong>capo {sourceCapo}</strong> ({sourceShapes} shapes) —
              converted to concert pitch (<strong>{detectedKey}</strong>) so electric and keys can read it.
            </p>
          )}

          {/* Capo */}
          <div className={`field-row${outputMode === "lyrics" ? " field-disabled" : ""}`}>
            <label className="field-label">Capo</label>
            <div className="field-body">
              <select
                className="key-select capo-select"
                value={outputCapo}
                onChange={e => setOutputCapo(Number(e.target.value))}
                disabled={outputMode === "lyrics"}
              >
                <option value={0}>No capo</option>
                {Array.from({ length: 9 }, (_, i) => i + 1).map(n => (
                  <option key={n} value={n}>Capo {n}</option>
                ))}
              </select>
              {outputCapo > 0 && outputShapes ? (
                <span className="key-hint">
                  chords shown as <strong>{outputShapes}</strong> shapes · first slide gets a capo note
                </span>
              ) : sourceCapo > 0 && outputMode !== "lyrics" ? (
                <button className="link-btn" onClick={() => setOutputCapo(sourceCapo)}>
                  Use original capo {sourceCapo}
                </button>
              ) : null}
            </div>
          </div>

          {/* Slides mode */}
          <div className="field-row">
            <label className="field-label">Slides</label>
            <div className="field-body">
              <div className="mode-toggle" role="group" aria-label="Slide output mode">
                <button
                  className={`toggle-btn${outputMode === "both" ? " active" : ""}`}
                  onClick={() => setOutputMode("both")}
                  disabled={status === "running"}
                  title="Include chord charts on stage monitor slides"
                >
                  Chords + Lyrics
                </button>
                <button
                  className={`toggle-btn${outputMode === "lyrics" ? " active" : ""}`}
                  onClick={() => setOutputMode("lyrics")}
                  disabled={status === "running"}
                  title="Lyrics-only slides"
                >
                  Lyrics Only
                </button>
              </div>
            </div>
          </div>

          {/* Output folder */}
          <div className="field-row">
            <label className="field-label">Output</label>
            <div className="field-body output-body">
              <span className="output-path" title={outputDir}>
                {outputDir
                  ? `…/${outputDir.split("/").slice(-2).join("/")}`
                  : <span className="output-unset">Not set — open Preferences</span>}
              </span>
              <button className="change-btn" onClick={browseOutput}>Change…</button>
            </div>
          </div>

          {/* Generate */}
          {!hasOutputDir && (
            <p className="no-output-warning">
              ⚠️ No output folder set.{" "}
              <button className="link-btn" onClick={() => openPrefs()}>
                Open Preferences
              </button>{" "}
              to choose where .pro files are saved.
            </p>
          )}
          <div className="action-row">
            <button
              className={`generate-btn${!canGenerate ? " disabled" : ""}`}
              onClick={generateFromEditor}
              disabled={!canGenerate}
              title={!hasOutputDir ? "Set an output folder in Preferences first" : undefined}
            >
              {status === "running" ? "⏳  Generating…" : "Generate .pro File →"}
            </button>
            <button
              className={`print-btn${!canPrint ? " disabled" : ""}`}
              onClick={printChart}
              disabled={!canPrint}
              title="Print the chart in the selected key and capo for rehearsal"
            >
              🖨 Print
            </button>
          </div>
        </>
      )}

      {/* ══ STATUS ═════════════════════════════════════════════════ */}
      {message && (
        <div className={`status ${status}`}>
          {status === "ok"  && <span className="status-icon">✅</span>}
          {status === "err" && <span className="status-icon">❌</span>}
          <span className="status-text">{message}</span>
        </div>
      )}
    </div>
  );
}
