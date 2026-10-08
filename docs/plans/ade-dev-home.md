# ADE as the dev home: one chat system, a top-level browser, Apple Music, a widget home

Status: spec, not started (2026-10-07). Scope: desktop app first. Web client,
iOS and TUI keep working, and are not redesigned here.

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

### What is true today (audited 2026-10-07)

Project-less ("personal") chats run in a hidden personal runtime with a hidden
internal lane (`docs/features/personal-chats/README.md`). They were built as a
*general assistant* surface, and the same surface backs the embeddable SDK
(`ade runtime run --profile embedded`). That design is why they feel weak in ADE.

**Agent side** (`apps/desktop/src/main/services/chat/agentChatService.ts`,
`personalSession.ts`):

- **System prompt:** `PERSONAL_CHAT_SYSTEM_PROMPT` tells the agent not to assume
  coding work, not to inspect files, and to stay inside its scratch directory.
- **ADE skills:** stripped for every provider. That covers Claude plugin paths,
  the Codex skill roots and slash commands, OpenCode skill paths, the Cursor
  workspace dirs, Qwen and the Pi extensions. So the agent is never taught
  `ade browser`, `ade screen`, `ade app-control`, Linear, scene or mosaic, even
  though `ADE_CLI_PATH` and a browser actor token *are* in its environment.
- **User settings:** Claude `settingSources` defaults to `"none"`, so there is
  no user CLAUDE.md, no user MCP servers and no user skills.
- **ADE guidance:** none. Lane guidance and lane memory are skipped.
- **Work-row status reporting:** off (`resolveSessionActivityReporting`).
- **Planning mode:** off. This is **intended and stays**: project-less chats
  are ask mode or full permission only.

**Backend actions:** `PERSONAL_CHAT_ACTIONS`
(`apps/desktop/src/shared/types/personalChats.ts`) already covers send, the
whole steer and queue family, interrupt, recoverTurn, approve and respondToInput,
scheduled work, usage-limit continue, updateSession, rerunLastTurn, archive and
delete, history paging, terminals and attachments. Missing compared with work
chats: fork from turn, rewind, compact, goals, handoff and import, title
generation, and anything lane-based.

**UI:** `PersonalChatsPage` renders `AgentChatMessageList` plus its own
160-line `ProjectlessComposer`. That composer offers only the model, reasoning
effort, permission mode, fast mode, send and interrupt. The real
`AgentChatComposer` is about 7,700 lines and `AgentChatPane` about 17,000.
Missing from the project-less UI: attachments, paste and drop, slash commands,
@mentions, queue and steer editing, fork, rewind, compact, goals, retry after
a provider failure, and import. `ProjectlessSidebar` offers only select,
archive and delete: no rename, pin, auto-title, or move to project.

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

**D. T3-style extras** (seen in pingdotgg/t3code `docs/user/thread-sidebar.md`).
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

### What is true today

- **Profile:** one global persistent partition, `persist:ade-browser`, so
  logins and cookies are already shared everywhere.
- **Collections:** tabs are grouped per collection: project, `personal` and
  `window` (`collectionForProjectRoot`, `builtInBrowserService.ts`).
- **Where it appears:** inside Work's tool panel and as a split on the Chats page.
- **Non-project top tabs** (New Tab, Chats, Account, Settings) are each
  hand-wired: a store flag, a route, a `ShellNavTab` in `TopBar.tsx`, and a
  branch in `App.tsx`.

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
  MusicKit authorization and is stored in ADE's credential store.

### Apple Music research (2026-10-07)

- **Stock Electron cannot play Apple Music.** It has no Widevine CDM. Sign-in,
  search and `setQueue` work, but `play()` stalls at 0 seconds
  (developer.apple.com/forums/thread/825925). Plain HTTP origins fall back to
  30-second previews.
- **castLabs Electron for Content Security (ECS)** is a Chromium fork of Electron
  with Widevine. It is free, tracks upstream closely (v44.x), and supports about
  the three latest majors. Older builds can lose CDM downloads without notice.
  - Production Widevine needs **VMP signing through castLabs EVS** (free account)
    on macOS and Windows. Sidra, an Apple Music desktop app on ECS, confirms full
    and lossless playback this way.
  - Signing order: on macOS, VMP before codesign and notarize; on Windows,
    codesign before VMP. This means electron-builder hooks.
- **The native macOS MusicKit (Swift) player APIs are not available on macOS.**
  A helper app gets catalog and auth only, with no playback.
- **The Windows Apple Music app has no scripting, URI or SDK.** The only route on
  Windows is MusicKit JS with Widevine.
- **Music.app AppleScript (macOS)** gives reliable transport control of what is
  already playing. Catalog playback needs library IDs, so it is a fallback only.
- **Developer token:** an ES256 JWT that lasts at most 6 months. The token is
  public by design; the `.p8` key is not. Mint it in a Worker with a short TTL.
  Per-token rate limits exist, so cache results and back off on errors.
- **Terms:** third-party players are allowed for subscribers when the user starts
  playback with standard controls. Apple's attribution guidelines apply. No
  downloading and no monetizing.

### Playback architecture: decision needed

| Option | How | Pros | Cons |
|---|---|---|---|
| **A. Switch ADE to ECS** | ADE's `electron` dependency becomes castLabs ECS. A hidden player view loads MusicKit JS from a secure `app://` origin, and the React UI drives it over IPC. | One runtime and the smallest install. Drop-in, since ECS keeps the same Electron API. | The whole app follows castLabs' release schedule. A castLabs/EVS outage or lag blocks every ADE release. VMP signing is added to every build. |
| **B. Separate ECS player helper** | A small bundled ECS app, launched on demand, runs MusicKit JS headless. ADE talks to it over a local pipe. | ADE stays on stock Electron. Music problems can never block an ADE release or break the IDE. | A second Chromium (about 100 MB more install, or a download on first use). Two processes and two signing flows. |
| **C. Control only** | Now Playing from the OS (macOS MediaRemote adapter, Windows SMTC), plus Music.app AppleScript on macOS for library playlists. | No DRM or forked Electron. Works for any player. | Not a real Music tab: on Windows you can't start music from ADE. |

### OS web engines: spike result (2026-10-07)

The table above was superseded by a lighter option: host the music page in
the web engine the OS already ships, not in Chromium.

- **ADE's browser today:** stock Electron 41 reports `com.widevine.alpha`,
  PlayReady and FairPlay as all `null`; only clearkey works. The user confirmed
  that previews play and library tracks don't.
- **Windows WebView2 (runtime 154): PASS.**
  - **Spike:** `tmp/spike-webview2-music/`, a C# WinForms host built with the
    in-box `csc.exe` and the Microsoft.Web.WebView2 NuGet package.
  - **DRM:** Widevine (SW_SECURE_CRYPTO) and PlayReady both work in the default
    configuration.
  - **Playback:** the user signed in and a **library track played for about
    15 minutes without a fault**.
  - **Startup:** first paint about 0.8 s after launch.
  - **Memory:** about 660 MB working set with the full music.apple.com site
    open. Most of that is Apple's web app, not WebView2.
  - **Now playing:** `navigator.mediaSession.metadata` gives title, artist,
    album and artwork. Play state must come from MusicKit, because
    `playbackState` stays `"none"`.
  - **Fragility:**
    - Never pass `--disable-component-update`; it removes the Widevine CDM.
    - PlayReady rides on the undocumented `msPlayReadyWin10` feature.
    - The Evergreen runtime updates on Edge's schedule.
    - Apple's sign-in dialog has a dark-mode contrast bug that makes its buttons
      nearly invisible. Our UI should front it, or force a light color scheme
      for the auth step.
- **macOS WKWebView (FairPlay): not yet tested.** It needs a run on the
  user's Mac Studio.

**Decision:**
- **Windows:** a WebView2 player host. ADE stays on stock Electron, and castLabs
  is not needed on Windows.
- **macOS:** a WKWebView player host, pending the spike.
- **Both platforms:** the host loads only MusicKit JS on a minimal page from a
  secure origin, not the full music.apple.com site. The Music tab, widget and
  mini-player are ADE's own React UI that drives the host over IPC. This should
  cut the memory and the slowness of Apple's web app.
- **Fallback:** castLabs ECS (option B), only if a platform spike fails.
- **Also:** ship C's Now Playing widget early.

Next spike: the Windows host loads a blank secure-origin page with only MusicKit
JS. It authorizes and plays a library track while driven from a test
controller. Measure memory against the 150 MB target.

### Status (2026-10-08): Music tab built on Windows

See [docs/features/music/README.md](../features/music/README.md).

- **Built:** the WebView2 player host (`ade-music-host.exe`, built by
  `build:music-host:win` with the in-box csc and a hash-pinned WebView2 NuGet
  package, shipped through `extraResources`); the main-process music service
  (on-demand start, 5-minute idle unload, resume at the same song and second);
  the `/music` top tab, the top-bar mini player, `Mod+Shift+M`; the Worker route
  `GET /music/developer-token`; the renderer store the Now Playing widget reads.
- **Verified:** catalog search, artwork and album pages with a locally minted
  developer token; Connect opens Apple's sign-in popup, light and legible;
  closing it cancels cleanly; the idle unload ends the whole host tree. The
  Worker's token signing was checked against Apple (HTTP 200).
- **Not yet verified (needs a signed-in person):** playback, library, queue,
  unload/resume of a playing queue, likes.
- **Memory:** the host tree idles at about 370 MB working set (190 MB private)
  with MusicKit loaded, against the 150 MB target; Apple's sign-in popup adds
  about 180 MB while open. The tree is gone 5 minutes after playback stops.
- **macOS:** not started; the tab says Music on Mac is coming.
- **Not deployed:** the Worker route needs `MUSICKIT_PRIVATE_KEY` set and a deploy.

---

## 4. Widget home page

**Status: built (2026-10-08). Lock in mode is dropped (the user does not
want it).**
- **Code:** `renderer/components/home/` (layout store, packer, grid, picker,
  card look, headline, widgets) and `main/services/home/` (clipboard, machine
  health, weather, Now Playing, share images).
- **Layout:** per computer, in localStorage, like Appearance. Named presets
  live in `ade.home.layouts.v2`; a v1 layout (`ade.home.layout.v1`) loads as
  "Default", and the active preset is still mirrored there for older builds.
  `home.layout.next` (Mod+Shift+L, rebindable) cycles presets.
- **Auto-layout, no scrolling, no gaps:** the user picks widgets, a size class
  for each (Compact, Regular, Large; each widget declares the shape of each
  class it offers, its content's minimum height, and whether it uses extra
  room well) and an order (drag or arrow keys; order is priority). The grid
  takes columns from the page width (3 keep the shipped width; 4+ stretch to
  fill a wide window) and rows from its height. `homeGridPack.ts` packs in
  order, tries a widget's smaller classes before hiding it ("N hidden"), then
  hands every empty cell to a neighbour (widgets that grow well first), and
  keeps the row count with the fewest hidden, shrunk, gaps, then rows. Every
  row shares one height; cells glide to new places (motion layout, off under
  reduced motion). No corner resize.
- **Lists never scroll:** `HomeFitList.tsx` shows the rows that fit and a
  "N more" line that opens the full view (PRs tab, Activity, machines) or the
  whole list in a dialog (projects, feed, clipboard, ports).
- **Contributions:** the shared `ui/ContributionSkyline.tsx` (ported from the
  user's 21st.dev pick): heat map ⇄ 3D skyline on a canvas that draws only
  while something moves and stops off screen. Day = chats + commits + PRs.
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
    Music host) are skipped. macOS: mediaremote-adapter via /usr/bin/perl when
    bundled, else Music.app over AppleScript, with the app icon from its
    bundle (not yet run on a Mac). Runs only while the widget is on screen.
- **Shipped share:** a canvas-drawn PNG, copied or saved by main; no upload.
- **Clipboard:** main watches the clipboard only while the widget is on the
  page. Optional history file: `<userData>/home-widgets/`.

- **Grid:** the current cards (Projects, Activity & usage, Limits & machines,
  Pull requests, Working now) become widgets in a grid. The current layout is
  the default preset, so nothing the user likes moves unless they move it.
- **Editing:** drag to reorder, small, medium, large and wide sizes, remove,
  and an "Add widget" gallery. Saved layouts can be switched by hotkey.
- **Appearance controls** (no theme or wallpaper changes): sliders for card
  opacity and blur on the home page. They write the existing
  `--kit-card-bg` mix and `--kit-card-blur` tokens (`styles/surfaceKit.css`)
  for this page only.
- **Headline:** built from real data, in priority order:
  blocked → momentum → milestone → welcome back → capacity → all clear.
  No canned quotes.
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
