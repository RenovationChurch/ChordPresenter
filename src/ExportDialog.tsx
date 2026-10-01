import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/tauri";
import { open } from "@tauri-apps/api/dialog";

/** Characters that can't go in a file name (mirrors md_to_pro._safe_filename). */
const safeName = (s: string) => s.replace(/[/\\:*?"<>|]/g, "-").replace(/^[\s.-]+|[\s.]+$/g, "");

export default function ExportDialog({
  baseName, keyLabel, folder: initialFolder, includeKey: initialIncludeKey, onCancel, onExport,
}: {
  /** Suggested name without the key, e.g. "Great Things - Phil Wickham". */
  baseName: string;
  /** "B" or "B (Capo 4)" — added to the name when "include key" is on. */
  keyLabel: string;
  folder: string;
  includeKey: boolean;
  onCancel: () => void;
  onExport: (choice: { fileName: string; folder: string; includeKey: boolean }) => void;
}) {
  const [name, setName] = useState(baseName);
  const [folder, setFolder] = useState(initialFolder);
  const [includeKey, setIncludeKey] = useState(initialIncludeKey);
  const [exists, setExists] = useState(false);

  const fileName = safeName(`${name.trim()}${includeKey && keyLabel ? ` - ${keyLabel}` : ""}`);
  const fullPath = folder ? `${folder.replace(/\/+$/, "")}/${fileName}.pro` : "";

  // Warn before replacing a file that's already there.
  useEffect(() => {
    let live = true;
    if (!fullPath || !fileName) { setExists(false); return; }
    invoke<boolean>("path_exists", { path: fullPath })
      .then(e => { if (live) setExists(e); })
      .catch(() => { if (live) setExists(false); });
    return () => { live = false; };
  }, [fullPath, fileName]);

  const browse = async () => {
    const sel = await open({ directory: true, multiple: false, defaultPath: folder || undefined });
    if (typeof sel === "string") setFolder(sel);
  };

  const canExport = Boolean(fileName && folder);
  const submit = () => { if (canExport) onExport({ fileName, folder, includeKey }); };

  return (
    <div className="prefs-backdrop" onClick={onCancel}>
      <div className="prefs-panel export-panel" onClick={e => e.stopPropagation()}
           onKeyDown={e => { if (e.key === "Escape") onCancel(); }}>
        <div className="prefs-header">
          <h2 className="prefs-title">Export .pro file</h2>
          <button className="prefs-close" onClick={onCancel}>✕</button>
        </div>

        <div className="prefs-body">
          <div className="prefs-row">
            <label className="prefs-label" htmlFor="export-name">File name</label>
            <div className="export-name-row">
              <input id="export-name" className="url-input" value={name} autoFocus spellCheck={false}
                     onChange={e => setName(e.target.value)}
                     onKeyDown={e => { if (e.key === "Enter") submit(); }} />
              {includeKey && keyLabel && <span className="export-suffix">- {keyLabel}</span>}
              <span className="export-suffix">.pro</span>
            </div>
          </div>

          <label className="prefs-check">
            <input type="checkbox" checked={includeKey} onChange={e => setIncludeKey(e.target.checked)}
                   disabled={!keyLabel} />
            <span className="prefs-label">Include the key in the file name</span>
          </label>

          <div className="prefs-row">
            <div className="prefs-row-top">
              <span className="prefs-label">Save to</span>
              <button className="prefs-browse" onClick={browse}>Change…</button>
            </div>
            <div className={`prefs-path${folder ? "" : " prefs-path--empty"}`} title={folder}>
              {folder || "No folder chosen — click Change…"}
            </div>
          </div>

          {exists && (
            <div className="export-warn">⚠️ “{fileName}.pro” is already in this folder — exporting will replace it.</div>
          )}
        </div>

        <div className="prefs-footer">
          <button className="prefs-cancel" onClick={onCancel}>Cancel</button>
          <button className={`prefs-save${canExport ? "" : " disabled"}`} onClick={submit} disabled={!canExport}>
            {exists ? "Replace" : "Export"}
          </button>
        </div>
      </div>
    </div>
  );
}
