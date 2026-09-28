# ChordPresenter

ChordPresenter was created to streamline the process of creating ProPresenter files that have embedded chord charts in them. While there are many online resources for finding chord charts for popular songs, there is no easy way to get those into your Stage Monitor on ProPresenter.

I have spent years in tech and was not able to find a solution, so I decided to make one. This is a simple app built on [Tauri](https://tauri.app) for macOS. I may later add Windows support if there is interest.

There are two ways of creating the `.pro` files. The first is through the [Obsidian Clipper](https://obsidian.md/clipper) browser extension, which creates Markdown files of pages with chords and lyrics. Simply navigate to the page your song is on, clip the file to a folder, then drag and drop it into ChordPresenter. It will give a preview of what will be imported into ProPresenter. The second method is to copy and paste the link to the song into the URL Fetch tab. It will parse the information, give a preview, and output it to your desired directory.

ChordPresenter can also transpose keys — it auto-detects the source key and lets you target any key you need.

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
- **Order** becomes the ProPresenter arrangement. It's prefilled from Planning Center's sequence, or from the chart itself when it repeats a section — a Chorus written out three times becomes one group played three times (a repeat with different notes or words is kept as "Chorus (2)").

## Exporting

**Export .pro File…** opens a dialog to name the file, choose the folder, and choose whether the key goes in the file name (e.g. `Great Things - Phil Wickham - B.pro`). The key choice is remembered. If a file with that name already exists, the dialog says so and the button changes to **Replace**.

## Changing the key in ProPresenter

Each exported file records the key its chords are written in (ProPresenter's "original key" — after any capo). In ProPresenter, set the key on the song in your playlist; ProPresenter uses the original key to transpose the chords on the stage display. You can also re-export from ChordPresenter in another key at any time.

## Slide settings (Preferences → Slides)

| Setting | Options |
|---|---|
| Lyrics font and size | A font from the list (all come with macOS) or any installed font by PostScript name; size in points on a 1920×1080 slide (default Helvetica Neue Bold, 90 pt). The app shows whether the font is installed. |
| Shrink lines that don't fit | On (default): ProPresenter scales the font down for long lines instead of overflowing |
| Black bar behind each line | On (default) / off. The bars scale with the font size |
| Blank slides at the start | On/off, how many, and the group's name (default: 2 slides named "Opening") |
| Lyric capitalization | ALL CAPS (default) · As written · First letter of each line |
| Bar lines and beat slashes | Only on instrumental lines (default) · Everywhere · Hide |
| Performance notes | Next to the chord, e.g. `B (dropout)` (default) · In the slide notes · Hide |

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
| E-Chords.com | Chords + Lyrics |
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

## Installing a test build

Every pull request is built automatically by GitHub Actions (`.github/workflows/build.yml`) — no Rust or Xcode setup needed on your Mac.

1. **Download:** open the pull request → **Checks** tab → **Build** → scroll to **Artifacts** → `ChordPresenter-macOS-<commit>`. It downloads as a `.zip`; double-click it to get the `.dmg`. (You can also run a build any time from **Actions → Build → Run workflow**.)
2. **Install:** open the `.dmg` and drag ChordPresenter to Applications (replace the old copy).
3. **First launch:** the app isn't code-signed with an Apple Developer ID, so macOS blocks it the first time:
   - Try to open it once, then go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway**.
   - If macOS instead says the app **"is damaged and can't be opened"**, run this once in Terminal and open it again:
     ```bash
     xattr -dr com.apple.quarantine /Applications/ChordPresenter.app
     ```
4. **Python 3** must be available: `python3 --version` in Terminal. If macOS offers to install the Command Line Developer Tools, accept — that provides it.

The build is "universal", so it runs on both Apple Silicon and Intel Macs. Artifacts are kept for 14 days.

---

## Build From Source

Requires: Rust toolchain, Node + pnpm, Xcode CLI tools, Python 3. macOS only — cannot cross-compile.

```bash
cd ChordPresenter
pnpm tauri dev       # dev mode with hot reload
pnpm tauri build     # production .dmg
```

---

## Python Scripts

The `.pro` generation pipeline:

| Script | Role |
|---|---|
| `md_to_pro.py` | Parses `.md` chord charts → ProPresenter `.pro` binary |
| `ew_fetch.py` | Fetches URLs, dispatches site-specific parser, calls md_to_pro |
| `create_pro_song.py` | Low-level protobuf builder (RTF + chord attributes) |
| `pco.py` | Reads songs, arrangements (chord charts) and plans from Planning Center Services |
| `song_to_pro.py` | Builds a `.pro` from the slide editor's JSON (Planning Center tab) |
| `parse_pro.py` | Reads an existing `.pro` back into slides (Edit .pro tab) |

Tests (no dependencies): `python3 -m unittest discover -s scripts/tests` and `pnpm test` (slide editor).

---

## Pending / Future

- **Windows support**: Handle cross-platform temp paths and Python command name
- **Paste mode**: Paste raw lyrics/chord text directly without a URL or file
- **Upload to Planning Center**: Attach the finished `.pro` back to the song's arrangement
- **Additional site parsers**: Genius and AllChristianSongsLyrics need further testing
