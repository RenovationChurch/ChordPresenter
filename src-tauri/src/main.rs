// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::Write;
use std::path::PathBuf;
use std::process::Command;
use chrono::Local;
use tauri::{CustomMenuItem, Manager, Menu, MenuItem, Submenu};

// ── Logging ───────────────────────────────────────────────────────────────────

fn log_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path_resolver().app_log_dir()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn log_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    log_dir(app).map(|d| d.join("chordpresenter.log"))
}

fn log(app: &tauri::AppHandle, tag: &str, message: &str) {
    let timestamp = Local::now().format("%Y-%m-%d %H:%M:%S");
    let line = format!("[{}] [{}] {}\n", timestamp, tag, message);

    // Always print to stderr in dev mode for quick feedback
    eprint!("{}", line);

    if let Some(path) = log_path(app) {
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }
}

#[tauri::command]
fn get_log_path(app: tauri::AppHandle) -> String {
    log_path(&app)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

#[tauri::command]
fn get_recent_logs(app: tauri::AppHandle) -> String {
    if let Some(path) = log_path(&app) {
        std::fs::read_to_string(&path).unwrap_or_default()
    } else {
        String::new()
    }
}

#[tauri::command]
fn clear_log(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(path) = log_path(&app) {
        std::fs::write(&path, "").map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ── Config ────────────────────────────────────────────────────────────────────

// Every field has a default so config files written by older versions
// (output_dir only) still load, with the new settings at their defaults.
#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Config {
    #[serde(default)]
    output_dir: String,
    // Planning Center Personal Access Token.
    #[serde(default)]
    pco_app_id: String,
    #[serde(default)]
    pco_secret: String,
    // Blank slides added at the start of every song for the operator.
    #[serde(default = "default_true")]
    opening_enabled: bool,
    #[serde(default = "default_opening_name")]
    opening_name: String,
    #[serde(default = "default_opening_count")]
    opening_count: u32,
    // Lyric capitalization: "upper" (ALL CAPS), "asis", "line" (first letter).
    #[serde(default = "default_text_case")]
    text_case: String,
    // Bar lines / beat slashes: "instrumental" (only on chord-only lines), "all", "none".
    #[serde(default = "default_rhythm_marks")]
    rhythm_marks: String,
    // <i>notes</i> in charts: "beside" the chord, in "slide" notes, or "hide".
    #[serde(default = "default_chord_notes")]
    chord_notes: String,
    // Lyric text style. font_name is the PostScript name ProPresenter looks up.
    #[serde(default = "default_font_name")]
    font_name: String,
    #[serde(default = "default_font_family")]
    font_family: String,
    #[serde(default = "default_font_size")]
    font_size: f64,
    // Black bar behind each line of lyrics.
    #[serde(default = "default_true")]
    line_bars: bool,
    // Let ProPresenter shrink text that doesn't fit the box.
    #[serde(default = "default_true")]
    shrink_to_fit: bool,
    // ALL CAPS on the main (audience) output only, whatever case the text
    // itself is in (the stage display shows the text as stored).
    #[serde(default = "default_true")]
    audience_caps: bool,
    // Export dialog: add " - Key" to the suggested file name.
    #[serde(default = "default_true")]
    filename_include_key: bool,
}

fn default_true() -> bool { true }
fn default_opening_name() -> String { "Opening".into() }
fn default_opening_count() -> u32 { 2 }
fn default_text_case() -> String { "upper".into() }
fn default_rhythm_marks() -> String { "instrumental".into() }
fn default_chord_notes() -> String { "slide".into() }
fn default_font_name() -> String { "HelveticaNeue-Bold".into() }
fn default_font_family() -> String { "Helvetica Neue".into() }
fn default_font_size() -> f64 { 90.0 }

impl Default for Config {
    fn default() -> Self {
        // Same values as the serde defaults above.
        serde_json::from_str("{}").expect("all Config fields have defaults")
    }
}

impl Config {
    /// Blank opening slides to add (0 when turned off).
    fn opening_slides(&self) -> u32 {
        if self.opening_enabled { self.opening_count.min(20) } else { 0 }
    }

    /// Slide settings as md_to_pro.py / ew_fetch.py / parse_pro.py flags.
    fn slide_args(&self, cmd: &mut Command, with_case: bool) {
        cmd.arg("--opening-count").arg(self.opening_slides().to_string());
        cmd.arg("--opening-name").arg(&self.opening_name);
        if with_case && ["upper", "asis", "line"].contains(&self.text_case.as_str()) {
            cmd.arg("--case").arg(&self.text_case);
            cmd.arg("--style").arg(self.style_json());
        }
    }

    /// Font / size / bars as the JSON the Python builders take.
    fn style_json(&self) -> String {
        serde_json::json!({
            "font_name": self.font_name,
            "font_family": self.font_family,
            "font_size": self.font_size,
            "line_bars": self.line_bars,
            "shrink_to_fit": self.shrink_to_fit,
            "audience_caps": self.audience_caps,
        })
        .to_string()
    }
}

fn config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join(".config")
        .join("chordpresenter")
        .join("config.json")
}

fn load_config() -> Config {
    let path = config_path();
    if path.exists() {
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&text).unwrap_or_default()
    } else {
        Config::default()
    }
}

#[tauri::command]
fn get_config() -> Config {
    load_config()
}

#[tauri::command]
fn save_config(config: Config) -> Result<(), String> {
    let config = Config {
        pco_app_id: config.pco_app_id.trim().to_string(),
        pco_secret: config.pco_secret.trim().to_string(),
        ..config
    };
    let path = config_path();
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let text = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    // The file holds the Planning Center secret: readable by this user only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

// ── Bundled script resolution ──────────────────────────────────────────────────

/// Resolve the path to a Python script.
///
/// Dev mode  (`pnpm tauri dev`):
///   Uses CARGO_MANIFEST_DIR (src-tauri/) → ../scripts/<name>
///   i.e. the live source files in ChordPresenter/scripts/ — no copy needed.
///
/// Production (`pnpm tauri build`):
///   Uses app.path_resolver().resolve_resource() which maps to
///   <App>.app/Contents/Resources/<name> — the bundled copies.
fn script_path(app: &tauri::AppHandle, name: &str) -> Result<String, String> {
    #[cfg(debug_assertions)]
    {
        // CARGO_MANIFEST_DIR = .../ChordPresenter/src-tauri
        // parent()           = .../ChordPresenter
        // join("scripts")    = .../ChordPresenter/scripts
        let manifest = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let path = manifest
            .parent()
            .unwrap_or(manifest)
            .join("scripts")
            .join(name);

        if path.exists() {
            return Ok(path.to_string_lossy().to_string());
        }
        // Fall through to resource resolver if scripts/ not found
    }

    // In the production bundle, resources declared as "../scripts/foo.py" are stored
    // under Contents/Resources/_up_/scripts/foo.py (Tauri maps ".." → "_up_").
    let bundled = format!("_up_/scripts/{}", name);
    app.path_resolver()
        .resolve_resource(&bundled)
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| format!("Bundled script not found: {}", bundled))
}

// ── Python interpreter ────────────────────────────────────────────────────────

/// The Python to run the scripts with: the one bundled in the app for this
/// Mac's chip (src-tauri/python-runtime/<arch>/, made by
/// scripts/build/bundle_python.sh), else the system `python3` — so dev mode
/// works before the runtime has been bundled.
fn python_command(app: &tauri::AppHandle) -> Command {
    let rel = format!("python-runtime/{}/bin/python3.13", std::env::consts::ARCH);

    #[cfg(debug_assertions)]
    let bundled = {
        let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(&rel);
        Some(p).filter(|p| p.exists())
    };
    #[cfg(not(debug_assertions))]
    let bundled = app.path_resolver().resolve_resource(&rel).filter(|p| p.exists());

    match bundled {
        Some(python) => {
            log(app, "PYTHON", &format!("bundled: {}", python.display()));
            let mut cmd = Command::new(python);
            // Keep the bundled interpreter self-contained: ignore the user's
            // Python settings and packages, and don't write .pyc files into
            // the (signed) app bundle.
            cmd.env_remove("PYTHONHOME")
                .env_remove("PYTHONPATH")
                .env("PYTHONNOUSERSITE", "1")
                .env("PYTHONDONTWRITEBYTECODE", "1");
            cmd
        }
        None => {
            log(app, "PYTHON", "bundled runtime not found — using system python3");
            Command::new("python3")
        }
    }
}

// ── Subprocess helper ─────────────────────────────────────────────────────────

struct RunResult {
    stdout: String,
    stderr: String,
    success: bool,
}

fn run_python(app: &tauri::AppHandle, mut cmd: Command, label: &str) -> Result<String, String> {
    log(app, "RUN", &format!("{}: {:?}", label, cmd));
    let output = cmd.output().map_err(|e| {
        let msg = format!("Could not launch Python: {}", e);
        log(app, "ERROR", &msg);
        msg
    })?;

    let result = RunResult {
        stdout:  String::from_utf8_lossy(&output.stdout).to_string(),
        stderr:  String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    };

    if !result.stdout.trim().is_empty() {
        log(app, "OUT", result.stdout.trim());
    }
    if !result.stderr.trim().is_empty() {
        log(app, if result.success { "WARN" } else { "ERROR" }, result.stderr.trim());
    }

    if result.success {
        Ok(result.stdout)
    } else {
        Err(format!("{}\n{}", result.stderr.trim(), result.stdout.trim()))
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn run_conversion(
    app: tauri::AppHandle,
    md_path: String,
    target_key: Option<String>,
    output_dir: String,
    lyrics_only: Option<bool>,
) -> Result<String, String> {
    let script = script_path(&app, "md_to_pro.py")?;
    let mut cmd = python_command(&app);
    cmd.arg(&script).arg(&md_path);

    if let Some(ref key) = target_key {
        let k = key.trim();
        if !k.is_empty() { cmd.arg("--key").arg(k); }
    }
    if !output_dir.trim().is_empty() {
        cmd.arg("--out").arg(output_dir.trim());
    }
    if lyrics_only.unwrap_or(false) {
        cmd.arg("--lyrics-only");
    }
    load_config().slide_args(&mut cmd, true);

    run_python(&app, cmd, "run_conversion")
}

/// Read — or, with `user_key`, change — the key stored in a .pro file
/// (scripts/pro_key.py). ProPresenter transposes the stage chords when the
/// "user" key differs from the "original" key the chords are written in.
#[tauri::command]
fn pro_key(
    app: tauri::AppHandle,
    pro_path: String,
    user_key: Option<String>,
    original_key: Option<String>,
) -> Result<String, String> {
    let p = std::path::Path::new(&pro_path);
    if !p.is_absolute() || p.extension().and_then(|e| e.to_str()) != Some("pro") {
        return Err("Expected the full path of a .pro file".into());
    }
    let canonical = p.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
    let script = script_path(&app, "pro_key.py")?;
    let mut cmd = python_command(&app);
    cmd.arg(&script).arg(canonical.to_string_lossy().to_string());
    for (flag, value) in [("--user", user_key), ("--original", original_key)] {
        if let Some(v) = value.filter(|v| !v.trim().is_empty()) {
            cmd.arg(flag).arg(v.trim());
        }
    }
    run_python(&app, cmd, "pro_key").map(|s| s.trim().to_string())
}

/// For the export dialog's "replace existing file?" warning.
#[tauri::command]
fn path_exists(path: String) -> bool {
    std::path::Path::new(&path).exists()
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    let p = std::path::Path::new(&path);
    if !p.is_absolute() {
        return Err("Path must be absolute".into());
    }
    let canonical = p.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
    let home = std::env::var("HOME").unwrap_or_default();
    if home.is_empty() || !canonical.starts_with(&home) {
        return Err("Path is outside the home directory".into());
    }
    std::fs::read_to_string(&canonical).map_err(|e| format!("Could not read file: {}", e))
}

#[tauri::command]
fn fetch_ew_preview(app: tauri::AppHandle, url: String) -> Result<String, String> {
    let u = url.trim();
    if !u.starts_with("http://") && !u.starts_with("https://") {
        return Err("URL must start with http:// or https://".into());
    }
    let script = script_path(&app, "ew_fetch.py")?;
    let mut cmd = python_command(&app);
    cmd.arg(&script).arg("--url").arg(u).arg("--preview");
    run_python(&app, cmd, "fetch_ew_preview")
        .map(|s| s.trim().to_string())
}

#[tauri::command]
fn generate_from_url(
    app: tauri::AppHandle,
    title: String,
    artist: String,
    chart_text: String,
    target_key: Option<String>,
    source_key: Option<String>,
    capo: Option<u8>,
    output_dir: String,
    lyrics_only: Option<bool>,
) -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let tmp_path = format!("/tmp/chordpresenter_ew_{}.txt", ts);

    std::fs::write(&tmp_path, &chart_text)
        .map_err(|e| format!("Could not write temp file: {}", e))?;

    let script = script_path(&app, "ew_fetch.py")?;
    let mut cmd = python_command(&app);
    cmd.arg(&script)
        .arg("--chart-file").arg(&tmp_path)
        .arg("--title").arg(&title)
        .arg("--artist").arg(&artist);

    if let Some(ref key) = target_key {
        let k = key.trim();
        if !k.is_empty() { cmd.arg("--key").arg(k); }
    }
    if let Some(ref key) = source_key {
        let k = key.trim();
        if !k.is_empty() { cmd.arg("--source-key").arg(k); }
    }
    if let Some(c) = capo {
        if c > 0 && c < 12 { cmd.arg("--capo").arg(c.to_string()); }
    }
    if !output_dir.trim().is_empty() {
        cmd.arg("--out").arg(output_dir.trim());
    }
    if lyrics_only.unwrap_or(false) {
        cmd.arg("--lyrics-only");
    }
    load_config().slide_args(&mut cmd, true);

    let result = run_python(&app, cmd, "generate_from_url");
    let _ = std::fs::remove_file(&tmp_path);
    result
}

/// Write a printable chart to a temp HTML file and open it in the default
/// browser, which auto-opens its print dialog (WKWebView in Tauri 1 has no
/// working window.print()). Print → "Save as PDF" also works from there.
#[tauri::command]
fn open_print_view(app: tauri::AppHandle, title: String, html: String) -> Result<(), String> {
    let dir = std::env::temp_dir().join("ChordPresenter-print");
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create print folder: {}", e))?;
    let safe: String = title
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_()#".contains(c) { c } else { '-' })
        .collect();
    let name = if safe.trim().is_empty() { "Chart".to_string() } else { safe.trim().to_string() };
    let path = dir.join(format!("{}.html", name));
    std::fs::write(&path, html).map_err(|e| format!("Could not write print file: {}", e))?;
    log(&app, "print", &format!("Opening print view: {}", path.display()));
    Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("Could not open print view: {}", e))?;
    Ok(())
}

/// Planning Center Services reader (scripts/pco.py). Credentials are read by
/// the script from the config file, so they never appear in the command line
/// (which is written to the log).
#[tauri::command]
fn pco(
    app: tauri::AppHandle,
    command: String,
    query: Option<String>,
    song: Option<String>,
    service_type: Option<String>,
    plan: Option<String>,
) -> Result<String, String> {
    const COMMANDS: [&str; 6] = ["test", "songs", "arrangements", "service-types", "plans", "plan-songs"];
    if !COMMANDS.contains(&command.as_str()) {
        return Err(format!("Unknown Planning Center command: {}", command));
    }
    let script = script_path(&app, "pco.py")?;
    let mut cmd = python_command(&app);
    cmd.arg(&script).arg(&command);
    for (flag, value) in [("--query", query), ("--song", song),
                          ("--service-type", service_type), ("--plan", plan)] {
        if let Some(v) = value {
            cmd.arg(flag).arg(v);
        }
    }
    run_python(&app, cmd, "pco").map(|s| s.trim().to_string())
}

/// Build a .pro from the slide editor's JSON (scripts/song_to_pro.py).
#[tauri::command]
fn generate_from_song(
    app: tauri::AppHandle,
    song_json: String,
    output_dir: String,
) -> Result<String, String> {
    if output_dir.trim().is_empty() {
        return Err("No output folder set — open Preferences.".into());
    }
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let tmp_path = std::env::temp_dir().join(format!("chordpresenter_song_{}.json", ts));
    std::fs::write(&tmp_path, &song_json)
        .map_err(|e| format!("Could not write temp file: {}", e))?;

    let script = script_path(&app, "song_to_pro.py")?;
    let mut cmd = python_command(&app);
    cmd.arg(&script)
        .arg("--song-json").arg(&tmp_path)
        .arg("--out").arg(output_dir.trim());
    let result = run_python(&app, cmd, "generate_from_song");
    let _ = std::fs::remove_file(&tmp_path);
    result
}

#[tauri::command]
fn parse_pro(app: tauri::AppHandle, pro_path: String) -> Result<String, String> {
    let p = std::path::Path::new(&pro_path);
    if !p.is_absolute() {
        return Err("Path must be absolute".into());
    }
    let canonical = p.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
    if !canonical.exists() {
        return Err(format!("File not found: {}", pro_path));
    }
    let script = script_path(&app, "parse_pro.py")?;
    let mut cmd = python_command(&app);
    cmd.arg(&script).arg(canonical.to_string_lossy().to_string());
    load_config().slide_args(&mut cmd, false);
    run_python(&app, cmd, "parse_pro")
        .map(|s| s.trim().to_string())
}

// ── Menu ──────────────────────────────────────────────────────────────────────

fn create_menu() -> Menu {
    let preferences = CustomMenuItem::new("preferences", "Preferences…")
        .accelerator("CmdOrCtrl+,");
    let open_log = CustomMenuItem::new("open_log", "Open Log File");

    let app_menu = Submenu::new(
        "ChordPresenter",
        Menu::new()
            .add_item(preferences)
            .add_native_item(MenuItem::Separator)
            .add_item(open_log)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Hide)
            .add_native_item(MenuItem::HideOthers)
            .add_native_item(MenuItem::ShowAll)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Quit),
    );

    let edit_menu = Submenu::new(
        "Edit",
        Menu::new()
            .add_native_item(MenuItem::Undo)
            .add_native_item(MenuItem::Redo)
            .add_native_item(MenuItem::Separator)
            .add_native_item(MenuItem::Cut)
            .add_native_item(MenuItem::Copy)
            .add_native_item(MenuItem::Paste)
            .add_native_item(MenuItem::SelectAll),
    );

    Menu::new()
        .add_submenu(app_menu)
        .add_submenu(edit_menu)
}

fn main() {
    tauri::Builder::default()
        .menu(create_menu())
        .on_menu_event(|event| {
            match event.menu_item_id() {
                "preferences" => {
                    event.window().emit("open-preferences", ()).unwrap();
                }
                "open_log" => {
                    let app = event.window().app_handle();
                    if let Some(path) = log_path(&app) {
                        // Create the file if it doesn't exist yet
                        if !path.exists() {
                            let _ = std::fs::write(&path, "");
                        }
                        tauri::api::shell::open(
                            &app.shell_scope(),
                            path.to_string_lossy().to_string(),
                            None,
                        ).ok();
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            run_conversion,
            read_file,
            fetch_ew_preview,
            generate_from_url,
            parse_pro,
            pco,
            generate_from_song,
            path_exists,
            pro_key,
            open_print_view,
            get_config,
            save_config,
            get_log_path,
            get_recent_logs,
            clear_log,
        ])
        .setup(|app| {
            // Log startup
            let handle = app.handle();
            log(&handle, "START", &format!(
                "ChordPresenter started — log: {}",
                log_path(&handle).map(|p| p.to_string_lossy().to_string()).unwrap_or_default()
            ));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
