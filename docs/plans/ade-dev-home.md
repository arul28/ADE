# DAEX as the dev home: chats without a project, Browser and Music tabs, a widget home

Status: built. This file keeps the design of the widget home page (§4) and
points to the feature docs for the rest. Desktop app only; the web client and
iOS keep working without these surfaces.

## 1. Chats without a project

Built. A chat without a project uses the same `AgentChatPane` as a work chat,
with the `assistant` profile (`embedded` stays unchanged for SDK hosts). See
`docs/features/personal-chats/README.md`.

## 2. Browser top tab

Built: the `/browser` top tab, `Mod+Shift+B`, and the Ask agent dock (a normal
chat without a project, with the current tab attached and leased). See "The
Browser top tab" in `docs/features/chat/README.md`.

Open: the dock chat follows the window's machine binding, so a remote project
tab gets a remote chat beside this computer's browser.

## 3. Music tab and widget

Built: Apple Music and Spotify in DAEX's own UI, plus the Now Playing widget.
See `docs/features/music/README.md`.

## 4. Widget home page

- **Code:** `apps/desktop/src/renderer/components/home/` (layout store
  `homeLayout.ts`, packer `homeGridPack.ts`, grid, picker, headline, widgets
  in `widgets/`) and `apps/desktop/src/main/services/home/` (clipboard,
  machine health, weather, Now Playing).
- **Layout:** per computer, in localStorage. Named presets live in
  `ade.home.layouts.v2`; the active preset is mirrored to `ade.home.layout.v1`
  for older builds, and this build falls back to it when v2 is missing or
  unusable (kept as a "Previous layout" preset). `home.layout.next`
  (`Mod+Shift+L`, rebindable) cycles presets.
- **Shipped stack:** `HOME_DEFAULT_STACK_VERSION` marks the store. A store
  that has not seen the current version gets the shipped stack as its active
  "Default" preset on the next launch, once; the user's saved layouts stay.
  A store holds `HOME_LAYOUT_PRESETS_STORED_MAX` presets (one more than the
  user may save), so adding the shipped stack never drops one of theirs. Bump
  the version when the stack changes and every user should see it.
- **Auto-layout, no scrolling:** the user picks widgets, a size class for each
  (Compact, Regular, Large; each widget declares its shape per class and its
  minimum, ideal and maximum height) and an order (order is priority). A drop
  takes the place in the order that packs the card onto the pointer's spot
  (`dropLanding`). `homeGridPack.ts` packs in order, tries smaller classes
  before hiding a widget ("N hidden"), then hands empty cells to neighbours
  that grow well, within their maximum. It tries every column count from the
  page's maximum down to 3 and keeps the one with the fewest hidden, shrunk,
  gaps and stretched cells, then the fullest last row. The grid renders the
  column count the packer chose, top-aligned; the rest is wallpaper. Every
  row shares one height: the tallest ideal of its cards, held under the
  smallest maximum. No corner resize.
- **Narrower:** widths pack in half columns. Edit mode's Narrower toggle
  stores `narrow: true`: the card is at most 1.5 columns wide and the
  neighbour placed before it grows into the freed half column.
- **Lists never scroll:** `HomeFitList.tsx` shows the rows that fit and an
  "N more" line that opens the full view or a dialog.
- **Contributions:** `ui/ContributionSkyline.tsx`, heat map or 3D skyline on
  a canvas that draws only while something moves. A day counts the larger of
  GitHub's contribution calendar (one cached `gh api graphql` read in main)
  and DAEX's commits and PRs, plus DAEX chats.
- **Picker:** categories, search, live previews (the real widget, inert),
  size classes, and a fit check (the same packer) that offers to make room or
  replace.
- **Feed:** Activity, the open project's PRs, DAEX releases, assigned Linear
  issues (when connected) and machine transitions, grouped Today / Yesterday
  / This week, with "While you were away" after four hours.
- **Now Playing:** one merged source in `home/nowPlayingService.ts`, best
  first: a playing DAEX music player, a playing built-in browser tab, a
  playing app, DAEX's paused player, then the most recent paused. A pick in
  the widget's switcher holds until that source goes away or something else
  plays.
  - DAEX music: `music/musicNowPlayingBridge.ts`.
  - Browser tabs (`home/browserMediaSessions.ts`): event-driven; only the
    shown playing tab is re-read, once a second, while a widget is on screen.
    Next and previous press the page's own media session handlers, recorded
    by `preload/browserMedia.ts`. A tab whose media started while on screen
    keeps its sound when hidden; other hidden tabs stay muted.
  - Other apps on Windows: `ade-now-playing.exe` (`native/ADENowPlayingWin`,
    built by `npm run build:now-playing:win`) lists SMTC sessions, skipping
    DAEX's own. On macOS: Music.app over AppleScript, asked only while Music
    runs; its icon comes from `services/apps/macAppIconFile.ts`, not
    `app.getFileIcon` (which kills the main process at `size: "large"` on
    macOS 27). Playback with Music.app is not yet checked on a Mac.
- **Clipboard:** main watches the clipboard only while a Clipboard widget is
  in the active layout and some window shows it; `useHomeAppEffects` turns it
  off when the layout has none. Copies a password manager marks
  (nspasteboard.org markers on macOS; `ExcludeClipboardContentFromMonitorProcessing`,
  "Clipboard Viewer Ignore" or `CanIncludeInClipboardHistory` = 0 on Windows)
  and copies that look like secrets are never kept. "Keep after restart"
  writes `<userData>/home-widgets/`; turning it off, Clear and removing an
  entry reach the disk at once.
- **Shipped share:** a canvas-drawn PNG, copied or saved by main; no upload.
- **Appearance:** card opacity and blur sliders write the `--kit-card-bg` mix
  and `--kit-card-blur` (`styles/surfaceKit.css`) for this page only.
- **Headline** (`homeHeadline.ts`): built from real data, in priority order:
  blocked, momentum, milestone, welcome back, capacity, all clear. Limits
  speak only when they would stop you: a provider used in the last 7 days at
  5% or less, or two thirds of providers out at once.
- **Widgets** (`homeWidgetCatalog.ts`): tips, feed, clock and weather,
  Pomodoro, clipboard, machine health, contributions, shipped, Now Playing,
  plus the original cards (projects, activity, pull requests, working now).
