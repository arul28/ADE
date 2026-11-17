# ADE as the dev home: one chat system, a top-level browser, Apple Music, a widget home

Status: built. The Browser top tab (§2), the Music tab (§3; see
`docs/features/music/README.md`) and the widget home page (§4) ship. This file
keeps their design; code and the feature docs hold the details. Scope: desktop
app first; web client, iOS and TUI keep working.

## Goal

ADE is where a developer spends the whole working session. They can go
full-screen and never leave: agents do the project work, and the rest of the
day (browsing, music, quick notes, the clipboard) happens inside ADE too.

Four pieces, in build order:

1. **One chat system.** A chat without a project is a normal ADE chat with the
   same pane, actions and tools. It is just not tied to a git project.
2. **Browser as a top-level tab.** It uses ADE's shared login profile and has
   an "Ask agent" button that opens a normal chat attached to that tab.
3. **Apple Music tab and widget.** ADE's own UI for Apple Music, matching ADE's
   theme.
4. **A widget home page.** The current home cards become widgets in a
   customizable grid, and new widgets are added.

---

## 1. One chat system

### Design

**A. Two profiles for the personal surface.**
- **`assistant`** is the new default for chats created from ADE's own UI.
- **`embedded`** is today's behavior, kept byte-for-byte for SDK hosts.
- The profile is stored on the session (`personalProfile`), so a chat keeps its
  profile across restarts and machines.

Under the `assistant` profile:
- **System prompt:** a real one. The agent is on the user's machine and not in
  a project. It can use the shell, files anywhere the user allows, the ADE
  browser, computer use, and app control. With the ADE CLI it can start or
  message chats in any project (this already works, see the README's cross-scope
  section). It works in its own scratch folder unless the user points it
  elsewhere.
- **ADE skills:** delivered through the same per-provider paths as work chats,
  minus the lane-only skills (`ade-lanes-git`, `ade-pr-workflows`).
- **User settings:** `settingSources` defaults to user (and project when a cwd
  is attached), so the user's own CLAUDE.md and MCP servers load.
- **Status reporting:** on, so the chat shows real activity and hand-raises.
- **Permission modes:** still ask mode or full permission only.

Every `isPersonalSession(...)` gate in `agentChatService.ts` falls into one of
two kinds:
- **Project-only by nature:** lane id, worktree, git, lane memory. These stay.
- **Assistant-surface choices:** skills, prompt, settings, activity. These
  switch on the profile.

The gate list is at about 30 call sites; see the audit in this file's history.

**B. One chat pane.** `PersonalChatsPage` renders `AgentChatPane`, not
`AgentChatMessageList` plus `ProjectlessComposer`. `AgentChatPane` already
accepts `laneId: null` and the hide flags (`hideLaneToolDrawers`,
`hideWorkspaceChrome`, `hideSurfaceHeader`…). The work:
1. Add a `scope: "project" | "personal"` input that routes the pane's IPC calls
   to the `personalChats.*` actions in place of the project chat domain. Build
   it as one adapter object, not if-branches through 17,000 lines.
2. Hide what needs a lane: lane picker, git, PR, diff and worktree tools, and
   planning mode in the mode picker.
3. Add the backend actions the pane needs that personal does not have yet: fork,
   compact, title generation, and import. Rewind and goals follow if their
   providers support them without a git tree.
4. Delete `ProjectlessComposer` once the pane is in place. The hero empty state
   can stay as the pane's empty-state slot.

The first task before any of this: list every place `AgentChatPane` and
`AgentChatComposer` assume a lane or project (IPC calls, `laneId!`, the project
store) and classify each one as hide, route or n/a.

**C. One chat list.**
- Personal chats show in the Chats sidebar with the same row actions as work
  chats: rename, pin, auto-title, archive, delete, and undo.
- `ade search` and the command palette cover them.

**D. Extras.**
- **Per-chat scratch folder:** each chat gets
  `$ADE_HOME/personal-chats/workspaces/<yyyy-mm-dd>-<slug-of-first-message>-<id8>`.
  It is kept when the chat is deleted, so whatever the agent made stays findable.
- **Files panel** for that folder, or for any attached folder.
- **Move to project:** a project picker in the chat header. It re-homes the
  session onto a lane of the chosen project (it changes `surface` from personal
  to work, picks or creates a lane, and copies scratch files over if the user
  asks). This is the one place a session crosses surfaces. It is a deliberate
  user action, recorded as an event in the transcript.
- **Shortcut:** `Ctrl/Cmd+Alt+N` starts a new chat without a project, and
  "No project" appears in every new-chat picker.

### Failure modes to watch

- An SDK host chat silently gains ADE skills or user MCP servers. The
  `embedded` profile must stay unchanged.
- A personal-scope pane call goes to the active project's runtime and creates
  a chat in the wrong place.
- A legacy personal session with no `personalProfile` must default to
  `embedded` semantics on the SDK path and `assistant` in ADE's UI. Decided:
  ADE's Chats surfaces send an assistant claim when they use a chat, and a
  claimed row with no profile is upgraded and persisted; see "Legacy rows are
  upgraded by use" in `docs/features/personal-chats/README.md`.
- Move to project half-completes and leaves the chat in both lists, or in neither.
- Cross-machine: a personal chat on machine B opened from machine A.

---

## 2. Browser as a top-level tab

**Status: built (2026-10-07).** `/browser` top tab, home-page button,
`Mod+Shift+B`, Ask agent dock with the tab attached and leased, Chats ⇄ Browser
jumps. Details: "The Browser top tab" in `docs/features/chat/README.md`.
Open: the dock chat follows the window's machine binding (remote project tab
means a remote chat beside this computer's browser).
Fixed (2026-10-07): an agent's `click` on a Wikipedia link did not navigate.
CDP reads `Input.dispatchMouseEvent` in the page's drawn space, and an
agent-held tab is drawn at the 1280x800 agent viewport scaled to fit the pane,
so a click aimed at an element's CSS centre landed at centre ÷ scale. Mouse
input now goes through `dispatchPageMouseEvent`, which maps CSS points to the
drawn scale. A tab nobody was looking at had no compositor surface and dropped
input outright; agent actions now hold the tab parked for their duration
(`withCaptureSurface` in `runTracedAgentAction`). The attached-tab badge now
tells the agent to read the live tab with `ade browser observe` instead of
fetching the URL.
Fixed (2026-10-09): the page is edge to edge; a tab on screen is never laid out
at the agent viewport (only a parked one is), so the dock opening, closing or
an agent's claim no longer shrinks or letterboxes it; the dock sends hidden
context naming the tab in front instead of a chip, and its empty state is a
small page card with no suggestion chips; a personal chat's `ade browser` calls
no longer fail on "Refusing to register the user home directory".
Fixed (2026-10-13): the 2026-10-09 note above did not hold in the code: a tab
an agent owned was still laid out at 1280x800 while on screen, so every claim,
release and lease expiry resized the page in front of the person. Ownership no
longer selects the fixed viewport at all; only a recording does
(`tabUsesRecordingViewport`), and main centres that view itself
(`recordingViewportViewRect`). A pane measuring 0×0 sent a fit scale of 0, which the
IPC check rejected, dropping the whole bounds update ("scale is below the
minimum"); the check now accepts 0–1 and the service clamps. A tab also keeps
the pane's size while parked, however narrow (it used to park at 960x600 under
640 wide and resize the page on every close and open); an agent that needs a
desktop layout is told how to ask for one (`narrowPageHint`).

### Design

- **New Browser top tab.** Add `browserTabOpen` to `appStore`, a `/browser`
  route and a `ShellNavTab` beside Chats. The page mounts
  `ChatBuiltInBrowserPanel` full-size with `projectRootOverride={null}`.
- **Collection:** it uses the existing `personal` collection, so the tabs a
  personal chat sees are the tabs the user sees.
- **Entry points:** a Browser button on the home page, `Ctrl/Cmd+Shift+B`, and
  links from any chat or widget.
- **"Ask agent" button** in the browser toolbar:
  - It docks a chat on the right using the one chat pane from piece 1.
  - The chat is a normal personal chat with the current tab attached as context
    (URL and title, and the tab is leased to that chat for agent driving).
  - It shows in the normal Chats list.
- **Things to check:**
  - The panel's handling of a null `sessionId`.
  - Keeping the native `WebContentsView` alive and positioned correctly across
    top-tab switches (`useNativeBrowserViewBounds`).
  - `ade ui show browser` mount registration.

---

## 3. Apple Music tab and widget

_Spotify sits beside Apple Music as a second home-page app, playing inside ADE
through the same player host; see `docs/features/music/README.md` ("Spotify")._

_Playback architecture: filled in from the research pass. See the
"Apple Music research" section below._

### Product

- **A full Music tab** with ADE's own UI, theming and density. It has:
  - a search bar over the Apple Music catalog and the user's library,
  - Library (playlists, albums, songs) and Recently played,
  - an Up next queue,
  - a now-playing bar with play/pause, skip, seek, volume, like, shuffle and
    repeat.

  It drops everything else Apple Music has: editorial, radio shows, social
  features and video.
- **A Now Playing widget** on the home page and a slim mini-player in the top
  bar while music plays.
- **Sign-in:** a one-time "Connect Apple Music". The developer token is minted
  by an ADE Cloudflare worker from a MusicKit key in the existing Apple
  Developer account; the key never ships in the app. The user token comes from
  MusicKit authorization and is stored in the Music service's own
  safeStorage-encrypted file (`musicTokenStore.ts`, in the app's user data),
  never in the player's WebView2 profile.

## 4. Widget home page

**Status: built (2026-10-08). Lock in mode is dropped (the user does not
want it).**
- **Code:** `renderer/components/home/` (layout store, packer, grid, picker,
  card look, headline, widgets) and `main/services/home/` (clipboard, machine
  health, weather, Now Playing, share images).
- **Layout:** per computer, in localStorage, like Appearance. Named presets
  live in `ade.home.layouts.v2`, and the active preset is still mirrored to
  `ade.home.layout.v1`: older builds read it, and this build falls back to it
  when version 2 is missing or unusable, keeping that layout as a "Previous
  layout" preset beside the shipped stack.
  `home.layout.next` (Mod+Shift+L, rebindable) cycles presets.
- **The shipped stack (2026-10-15):** Projects with Working now stacked under
  it, Pull requests (Compact) with Contributions under it and Clock & weather
  beside them, three columns. `HOME_DEFAULT_STACK_VERSION` marks the store:
  a store that has not seen the current version gets the shipped stack as its
  "Default" preset, active, on the next launch, and the version is written then
  — once, for every computer, whatever the user had (the layouts they saved
  themselves stay in the switcher; everything is editable again from there).
  A store holds `HOME_LAYOUT_PRESETS_STORED_MAX` presets — one more than the
  user may save — so putting the shipped stack in never drops one of theirs.
  Bump the version when the stack changes and every user should see it.
- **Auto-layout, no scrolling, compact cards:** the user picks widgets, a
  size class for each (Compact, Regular, Large; each widget declares the
  shape of each class it offers, its content's minimum, ideal and maximum
  card height, and whether it uses extra room well) and an order (drag or
  arrow keys; order is priority). Any card drags, a stacked one leaving its
  stack; a drop takes the place in the order that packs the card onto the
  pointer's spot (`dropLanding`), not just "before the card under it". The page width offers up to N columns (3
  keep the shipped width; 4+ are wider) and its height up to M rows.
  `homeGridPack.ts` packs in order, tries a widget's smaller classes before
  hiding it ("N hidden"), then hands empty cells to a neighbour (widgets that
  grow well first) only while the card stays within its maximum. On the last
  row, a Compact card keeps its one column and the room past it stays
  wallpaper; a wider card stretches across that room, so the page ends on a
  full row instead of a ragged one. It tries
  every column count from N down to 3 and keeps the one with the fewest
  hidden, shrunk, gaps, stretched cells (grown, or spanning extra rows), the
  fullest last row, then rows, so a few widgets on a
  wide window stay at the shipped width, centred. The grid renders the column
  count and width the packer chose (not the page's maximum), and the hero's
  actions are held to that width, so they end where the cards end. A cell
  holding a widget and the cards stacked under it, one row per card, splits on
  the grid's row lines when every card fits the drawn row height, so a stack
  lines up with the cards beside it. Every row shares one
  height: the tallest ideal of its cards, held under the smallest maximum
  and the page, never under a card's minimum. The grid is top-aligned and
  only as tall as its rows; the rest of the page is wallpaper. More room
  means room for more widgets, not bigger cards. Cells glide to new places
  (motion layout, off under reduced motion). No corner resize.
- **Narrower:** widths are packed in half columns (two tracks per column;
  classes still span whole columns). Edit mode's Narrower toggle (offered
  while a card shows wider than a column and a half) stores `narrow: true`
  on the item: the card is at most a column and a half wide (a two-column
  class shows at 1.5; a one-column class the page would stretch stops at
  1.5), sits so the half column it frees is beside the widget placed before
  it, and that neighbour grows into it. It only goes wider when nothing else
  can fill the room, so narrow never leaves a hole. Leftover room is handed
  out half a column at a time, so two neighbours share a free column.
- **Lists never scroll:** `HomeFitList.tsx` shows the rows that fit and a
  "N more" line that opens the full view (PRs tab, Activity, machines) or the
  whole list in a dialog (projects, feed, clipboard, ports).
- **Contributions:** the shared `ui/ContributionSkyline.tsx` (ported from the
  user's 21st.dev pick): heat map ⇄ 3D skyline on a canvas that draws only
  while something moves and stops off screen. Day = the larger of GitHub's
  contribution calendar (one cached `gh api graphql` read in main, every
  repository) and ADE's commits + PRs, plus ADE chats.
  The 3D view fits its box: it picks the turn (8°–45°) at which the risen
  skyline draws biggest, and in a short wide card lowers the bars (to 60% at
  least) until the skyline spans the width. The gallery preview always shows
  the skyline rising; the page's card keeps the user's view.
- **Picker:** categories, search, live previews (the real widget, inert),
  size classes, and a fit check (the same engine) that offers to make room
  (others to Compact) or replace.
- **Feed:** Activity stream + the open project's PRs + ADE releases + Linear
  assigned issues (when connected) + machine transitions, Today / Yesterday
  / This week, "While you were away" after four hours, all or pinned
  projects (the recents pin).
- **Now Playing:** one merged source in `home/nowPlayingService.ts`, best
  first: a playing ADE Apple Music player, a playing built-in browser tab, a
  playing app, ADE's paused player, then the most recent paused. A pick in
  the widget's corner switcher (or pressing a control) holds until that source
  goes away or something else starts playing.
  - ADE Apple Music: `musicNowPlayingBridge.ts` through `setOverride`.
  - Browser tabs (`home/browserMediaSessions.ts`): event-driven
    (`media-started-playing`, `media-paused`, `audio-state-changed`, title and
    navigation); a tab is read only when one fires, and only the shown playing
    tab is re-read, once a second, while a widget is on screen. Title, artist
    and artwork from `navigator.mediaSession`, else the tab title; the icon is
    the site's largest favicon. Play and pause go to the media element; next
    and previous press the page's own media session handlers, which the
    session preload `preload/browserMedia.ts` records (shown only where the
    page registered them). The cover jumps to the tab in the Browser top tab.
    A tab whose media started while it was on screen (or that was played from
    the widget) keeps its sound when hidden; other hidden tabs stay muted.
  - Other apps: Windows `ade-now-playing.exe` (`native/ADENowPlayingWin`,
    C++/WinRT, built by `build:now-playing:win`) lists every SMTC session with
    the app's shell icon and name; ADE's own sessions (`com.ade.desktop*`, the
    Music host) are skipped. If the helper exits on its own the widget clears
    its sessions and the next subscribe starts a new one. macOS: Music.app over AppleScript, asked only while Music is
    already running, with Music's icon read from the bundle's own `.icns`
    by `macAppIconDataUrl` (`services/apps/macAppIconFile.ts`), not
    `app.getFileIcon`, which kills the main process at `size: "large"` on
    macOS 27; other Mac apps are not
    listed. Opening the gallery with this preview is checked on a Mac;
    playback with Music.app is not yet. Runs
    only while the widget is on screen.
- **Shipped share:** a canvas-drawn PNG, copied or saved by main; no upload.
- **Clipboard:** main watches the clipboard while a Clipboard widget is in
  the active layout and has room to show (not paused, not hidden by the
  packer), whether or not the home page is open. The watch resumes a few
  seconds after launch when it was on; the app (`useHomeAppEffects`) turns it
  off when the layout has no Clipboard widget. Each window's grid tells main
  whether it shows the widget or hides it for lack of room; main pauses the
  watch while some window hides it and no window shows it, and a window that
  closes or reloads drops its say. Copies a password manager marks (nspasteboard.org
  markers on macOS; `ExcludeClipboardContentFromMonitorProcessing`, KeePass'
  "Clipboard Viewer Ignore", or `CanIncludeInClipboardHistory` = 0 on
  Windows) and copies that look like secrets are never kept. "Keep after
  restart" writes `<userData>/home-widgets/`; turning it off, Clear and
  removing an entry reach the disk at once, and a launch with it off removes
  any leftover history. Removing the widget stops the watch but keeps the
  in-memory history (and the file, when kept); Clear empties it.

- **Grid:** the current cards (Projects, Activity & usage, Limits & machines,
  Pull requests, Working now) become widgets in a grid. The shipped stack is
  the default preset (see the Layout bullet above); a build that changes it
  puts the new one in once, and layouts the user saved themselves stay.
- **Editing:** drag to reorder, small, medium, large and wide sizes, remove,
  and an "Add widget" gallery. Saved layouts can be switched by hotkey.
- **Appearance controls** (no theme or wallpaper changes): sliders for card
  opacity and blur on the home page. They write the existing
  `--kit-card-bg` mix and `--kit-card-blur` tokens (`styles/surfaceKit.css`)
  for this page only.
- **Headline:** built from real data, in priority order:
  blocked → momentum → milestone → welcome back → capacity → all clear.
  No canned quotes. A blocked sentence with room left takes a momentum
  clause (chats working, merges, a streak). Limits only speak when they
  would stop you: a provider used in the last 7 days (per-provider daily
  tokens), at its best account, at 5% or less; or most providers (two
  thirds or more) out at once. Capacity (20% or less) also only names a
  provider you use. One idle provider at 0% is not news.
- **New widgets:**
  - Now Playing (piece 3)
  - Pomodoro / session timer, which ties into the streak
  - Clipboard history
  - Machine health: CPU, RAM, disk, dev servers and ports, with a kill button
  - Clock and weather
  - Contribution heatmap and streak
  - Weekly "Shipped" card
  - A feed of merged PRs, finished chats, releases and Linear issues
- ~~"Lock in" mode~~: dropped.
