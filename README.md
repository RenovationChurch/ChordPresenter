# ChordPresenter

ChordPresenter was created to streamline the process of creating ProPresenter files that have embedded chord charts in them. While there are many online resources for finding chord charts for popular songs, there is no easy way to get those into your Stage Monitor on ProPresenter.

I have spent years in tech and was not able to find a solution, so I decided to make one. This is a simple app built on [Tauri](https://tauri.app) for macOS. I may later add Windows support if there is interest.

There are two ways of creating the `.pro` files. The first is through the [Obsidian Clipper](https://obsidian.md/clipper) browser extension, which creates Markdown files of pages with chords and lyrics. Simply navigate to the page your song is on, clip the file to a folder, then drag and drop it into ChordPresenter. It will give a preview of what will be imported into ProPresenter. The second method is to copy and paste the link to the song into the URL Fetch tab. It will parse the information, give a preview, and output it to your desired directory.

You can also **paste** a chart directly (the 📋 Paste tab) — from a site's print view, a PDF, an email, anywhere you can copy chords-above-lyrics text. See **[Preparing a chart](docs/CHART_FORMAT.md)** for what the app expects (section names, chord lines, `Key:`/`Capo:` lines) and how to tidy a chart before generating.

ChordPresenter can also transpose keys — it auto-detects the source key and lets you target any key you need. Charts written for a capo come in at their real (concert) key, and you can add a capo on output: the stage monitor then shows capo shapes, and the first slide gets a stage-only note saying which capo to use. There's a Print button for rehearsal charts, and an Edit .pro tab for adding or fixing chords in files you've already made.

There is only one built-in theme, but once inside ProPresenter you can change it to your preferred look.

This is a work in progress, so there may be some reflowing that needs to be done for the slides. This is just a fun side project for me — I first love the Church and also have an affinity for tech. It is free to use and always will be. Please feel free to let me know if you have issues; there is a logging system built in as well.

*#forthekingdom*

---

## Planning Center

The **Planning Center** tab pulls chord charts straight from Planning Center Services, so the charts you already maintain there (ChordPro, e.g. `[G]Amazing [C]grace`) become ProPresenter slides without re-typing.

1. **Connect once:** create a Personal Access Token at `api.planningcenteronline.com/oauth/applications`, then paste the Application ID and Secret into **Preferences → Planning Center** and click **Test connection**. ChordPresenter only reads songs and plans. The token is stored in `~/.config/chordpresenter/config.json` (readable only by you).
2. **Find a song:** search your song library, or pick **Upcoming plans** to see what's scheduled. Songs picked from a plan default to the key they're scheduled in.
3. **Edit the slides** before exporting (see *Slide editor* below).
4. **Key / Capo / Lyrics Only / Print** work the same as for the other tabs.

## Slide editor

Every song — from a File, a URL, or Planning Center — opens in the same editor before it's exported, with a live preview of each slide as the stage display will show it (in the export key, with your display settings).

- **Reflow view** (like ProPresenter's reflow editor): just the words. A blank line is a slide break; press Enter to split a line or a slide, delete a line break to join. Chords stay attached to their words.
- **Chords view**: the full chart, to change chords themselves. It uses the same syntax as Planning Center:
  - `[G]` goes right before the syllable it's played on; `[|B]` / `[|]` bar lines, `[|  /  /]` beats, `[/C#]` bass-only
  - `| B / / / | / / C#m7 / |` on its own line is an instrumental line (intro, turnaround…) and gets its own slide with the chords shown
  - `<i>(dropout)</i>` is a performance note — inside a chord, on a lyric line, or after a section heading
  - `[Verse 1]` or `VERSE 1` starts a section
- **Lines per slide:** 1–4 for the whole song, or per section from the dropdown in the preview. The first split respects the stanza breaks (blank lines) in the chart.
- **Order** becomes the ProPresenter arrangement. Drag the section chips to reorder, × to remove, and click a section underneath to add it — as many times as it's played. A repeated section is one ProPresenter group used several times, so its slides exist once and an edit applies everywhere; the ×N badge shows how often each is played, and "not played" flags a section left out. The order is prefilled from Planning Center's sequence, or from the chart itself when it writes a section out more than once (a repeat with different notes or words is kept as its own section, e.g. "Chorus (2)"). "Reset to as written" plays every section once, top to bottom.
- **Lead-in chords:** `[G]    Amazing grace` — spaces after a chord at the start of a line are kept, so the chord sits ahead of the first word.

## Exporting

**Export .pro File…** opens a dialog to name the file, choose the folder, and choose whether the key goes in the file name (e.g. `Great Things - Phil Wickham - B.pro`). The key choice is remembered. If a file with that name already exists, the dialog says so and the button changes to **Replace**.

## Changing the key in ProPresenter

A .pro file stores two keys: the **original** key its chords are written in, and the key ProPresenter should **show** them in. When they differ, ProPresenter transposes the stage-display chords itself. ProPresenter only offers a key picker for MultiTracks songs, so ChordPresenter sets it for you:

- Every export records its key as both.
- To change it later, open the file in the **Edit .pro** tab, pick the key under "ProPresenter shows", and click **Save key to file**. Only the key changes — lyrics and chords are untouched. Reopen the song in ProPresenter.
- Or re-export from ChordPresenter in the new key.

## Slide settings (Preferences → Slides)

| Setting | Options |
|---|---|
| Lyrics font and size | A font from the list (all come with macOS) or any installed font by PostScript name; size in points on a 1920×1080 slide (default Helvetica Neue Bold, 90 pt). The app shows whether the font is installed. |
| Shrink lines that don't fit | On (default): ProPresenter scales the font down for long lines instead of overflowing |
| Black bar behind each line | On (default) / off. The bars scale with the font size |
| Blank slides at the start | On/off, how many, and the group's name (default: 2 slides named "Opening") |
| Lyric text (stage display) | ALL CAPS (default) · As written · First letter of each line — how the lyrics are saved |
| Main output (audience) | ALL CAPS (default) · Same as the lyric text — uses ProPresenter's display-only capitalization, so the text itself keeps its case |
| Bar lines and beat slashes | Only on instrumental lines (default) · Also on lyric lines where there's no chord (`[\|]`) · Hide |
| Performance notes | In the slide notes (default) · Next to the chord, e.g. `B (dropout)` · Hide |

Each chord label is always just the chord name, never combined with a bar line or beat mark, so ProPresenter can transpose it and show it as a number or numeral on the stage display. A note placed "next to the chord" does make that one chord unreadable to ProPresenter. The lyric box is centered on the slide.

The computer that runs ProPresenter needs the font installed too, or it will substitute another one. "As written" keeps normal case on the stage display; turn on All Caps in your ProPresenter theme to still show capitals to the audience. Slide notes only appear on stage layouts that include a Slide Notes object. Notes on section headings are left off unless "slide notes" is chosen.

### How chords line up in ProPresenter

ProPresenter anchors each chord to a *character* of the slide's text, not to a column. ChordPresenter always works in those character positions: ChordPro charts already give them exactly, and chords-over-lyrics charts are converted by lining up columns (keeping the chord line's leading spaces) and then moving each chord with its word when extra spaces are removed. The editor preview shows chords over the same characters the stage display will use.

---

## Supported Sites

| Site | Output |
|---|---|
| EssentialWorship.com | Chords + Lyrics |
| WorshipTogether.com | Chords + Lyrics |
| WorshipChords.com | Chords + Lyrics |
| WorshipChords.net | Chords + Lyrics |
| Ultimate Guitar | Chords + Lyrics |
| Genius.com | Lyrics Only |
| AllChristianSongsLyrics.com | Lyrics Only |
| AZLyrics, LyricsFreak, SongLyrics | Lyrics Only |

---

## Notes

This is a work in progress — some reflowing of slides may be needed depending on lyric line length. There is a logging system built in, so if you run into issues please feel free to report them.

This is a free side project and always will be. First love the Church, second love tech.

*#forthekingdom*

---

## Install

Download the latest `ChordPresenter_<version>_universal.dmg` from [Releases](https://github.com/Anagaion/ChordPresenter/releases/latest), open it, and drag ChordPresenter into Applications. It runs natively on Apple Silicon and Intel Macs, and **nothing else needs to be installed** — Python is built in.

The app isn't notarized by Apple yet, so the first time you open it:
- **macOS 15 Sequoia or newer:** open it once, click **Done**, then go to **System Settings → Privacy & Security** and click **Open Anyway**.
- **Older macOS:** right-click the app, choose **Open**, then click **Open**.

### Installing a test build of this fork

Every pull request is built automatically by GitHub Actions (`.github/workflows/build.yml`) — no Rust or Xcode setup needed on your Mac.

1. **Download:** open the pull request → **Checks** tab → **Build** → scroll to **Artifacts** → `ChordPresenter-macOS-<commit>`. It downloads as a `.zip`; double-click it to get the `.dmg`. (You can also run a build any time from **Actions → Build → Run workflow**.)
2. **Install:** open the `.dmg` and drag ChordPresenter to Applications (replace the old copy). Python is bundled, as in the releases.
3. **First launch:** as above. If macOS instead says the app **"is damaged and can't be opened"**, run this once in Terminal and open it again:
   ```bash
   xattr -dr com.apple.quarantine /Applications/ChordPresenter.app
   ```

Test builds are "universal" (Apple Silicon and Intel) and kept for 14 days.

---

## Build From Source

Requires: Rust (via rustup), Node + pnpm, Xcode Command Line Tools, Python 3 (for development and tests). macOS only.

```bash
cd ChordPresenter
pnpm tauri dev                         # dev mode with hot reload (uses your system python3)
scripts/build/release_mac.sh           # tests → bundled Python → universal build → sign → .dmg
```

`release_mac.sh` runs `scripts/build/bundle_python.sh`, which downloads a checksum-verified standalone Python from [python-build-standalone](https://github.com/astral-sh/python-build-standalone) and trims it into `src-tauri/python-runtime/` (git-ignored). If Homebrew's Rust is installed, the script puts rustup's toolchain first on `PATH`, since only that one has the Apple Silicon target.

---

## Python Scripts

The `.pro` generation pipeline:

| File | Role |
|---|---|
| `ew_fetch.py` | Fetches URLs, dispatches the site-specific parser, calls md_to_pro |
| `md_to_pro.py` | Parses chord charts → sections, slides and chord positions; key/capo/transpose; writes the `.pro` |
| `create_pro_song.py` | Low-level protobuf builder (RTF text, chord attributes, slide notes) |
| `parse_pro.py` | Reads an existing `.pro` back into slides + chords (Edit .pro tab) |
| `chord_grammar.json` | Chord-name grammar shared by the Python scripts and the app (`src/music.ts`) |
| `pco.py` | Reads songs, arrangements (chord charts) and plans from Planning Center Services |
| `song_to_pro.py` | Builds a `.pro` from the slide editor's JSON (File, URL, Paste and Planning Center tabs) |
| `pro_key.py` | Reads or changes the key stored in a `.pro` (Edit .pro tab) |

---

## Tests

```bash
python3 -m unittest discover tests            # chart rules, Python/app parity, saved song pages
python3 -m unittest discover -s scripts/tests # .pro output: alignment, settings, Planning Center
pnpm test                                     # slide editor (src/chordpro.ts)
```

- `tests/test_chart_rules.py` and `tests/test_chord_parity.py` use made-up lines only and run anywhere. The parity test checks that the Python scripts and the app read chords identically.
- `tests/test_url_fixtures.py` runs saved song pages through the full URL pipeline and compares against recorded snapshots. Pages are stored locally in `tests/fixtures/local/` (git-ignored, since they contain copyrighted lyrics); add one with `python3 tests/tools/add_fixture.py <song URL>`.

---

## Planned development

### Version 2.0 (in progress)
- **Built on Tauri 2**, with every change automatically built and tested on **macOS and Windows**.
- **Rewrite the chart engine in Rust**, inside the app itself: smaller, faster, and one implementation instead of two. The song-page test suite makes sure every step produces the same `.pro` files as today.
- **No Python at all.** The app gets smaller, with nothing extra bundled or installed.
- **Windows version.** Beta testers wanted: if your church runs ProPresenter on Windows, keep an eye on the Releases page for a beta.
- **ChordPro support**: work internally in the standard ChordPro format (`[G]Amazing [D]grace`), edit chords inline, and export `.cho` files for apps like OnSong.

### Also planned
- **Formatting guide built into the app**, so it works offline.
- **Notarized releases**, so there's no more "Open Anyway" step.
- **More sites:** better testing for the lyrics-only sites (Genius, AllChristianSongsLyrics).

### Ideas being considered
- **Planning Center Services import:** pull songs straight from a service plan. A community fork is experimenting with this already.

---

## Contributing

Bug reports, song links that don't convert well, and pull requests are all welcome. Please open an [issue](https://github.com/Anagaion/ChordPresenter/issues). For conversion problems, include the song link and the log file (**ChordPresenter → Open Log File**).
