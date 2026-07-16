# Terminal and Session UI Surfaces

The renderer surfaces that expose session data to the user. All paths
are under `apps/desktop/src/renderer/components/terminals/` unless
noted otherwise.

## Entry page: `TerminalsPage.tsx`

Top-level page for the Work tab. Wraps two panes with `PaneTilingLayout`:

- `sessions` pane (default 24%, min 15%) → `SessionListPane`
- `view` pane (default 76%, min 40%) → `WorkViewArea` plus the right-edge
  `WorkSidebar` when `workSidebarOpen` is true.
  The view + sidebar share the row via a flex container with a draggable
  column separator; the sidebar width is persisted as
  `workSidebarWidthPct` (clamped 26–55%).
  The sidebar includes the Terminal tab, which renders the same
  attached-terminal surface for chat sessions and running tracked agent CLI
  sessions.

Pulls all session state through `useWorkSessions()` and renders two
globally-positioned overlays:

- `SessionContextMenu` — right-click actions on session cards and tabs.
- `SessionInfoPopover` — hover/click info panel showing tool type,
  lane, transcript path, exit code, and management actions.

The page handles session navigation (selection, tab open, "go to lane")
and invalidates the shared session list cache before pushing a
freshly-opened chat into the Work tab. It also computes a
`draftContextTargetId` (formatted as `work:draft:<laneId>:<draftKind>`)
and a `contextTarget` that includes a `"draft"` kind when no active
Work session is selected but a draft composer is mounted, so the Work
sidebar can insert context (attachments, iOS/App Control/browser
selections) into the draft composer before a chat session exists.
Context insertion is enabled for draft targets — the "no session open"
disabled message no longer appears when a draft is active. The page
also determines PTY context insertability through
`isPtyContextInsertableToolType`, which covers all tracked agent CLI
tool types: `claude`, `codex`, `cursor-cli`, `droid`, and `opencode`.
The Terminal tab uses the same active `contextTarget` owner id, so `chat`
targets attach to the chat session and `pty` targets attach to the running
CLI session id.

The same page is the subscriber for `ade:work:select-session`, the
renderer event dispatched by orchestration "Open chat" buttons. The
handler accepts `{ sessionId, laneId? }`, selects the lane when present,
focuses the target chat, opens its Work tab, and stores it as the active
selected session.

`useWorkLaneDeleteProgress` also makes this page the Work-owned consumer of
lane deletion state. While Work is active it subscribes to streamed delete
progress and lane lifecycle events, and it hydrates `lanes.listDeleteProgress`
so a delete started on another tab remains visible after returning to Work.
When teardown finishes, it invalidates the session-list cache and refreshes
both Work sessions and lightweight lane metadata. The active lane's content
and tools are covered by a blocking status overlay until refresh succeeds;
refresh failures retry twice with bounded backoff, then clear the stale
progress and surface a sticky error toast rather than leaving Work disabled.

It also owns the sidebar's multi-select state:

- `selectedSessionIds: Set<string>` with a `selectionAnchorId` tracker.
- `handleSelectSession(id, event, visibleSessionIds)` — plain click
  clears the multi-selection and opens the tab; shift-click selects the
  range from the anchor; meta/ctrl-click toggles the id in/out of the
  set; any of the three refresh the active single-selected item.
- `handleBulkStopSelected` runs on selected running PTY sessions,
  confirming before calling `stopRuntime(ptyId, sessionId)`; failures
  are counted and surfaced through `sessionActionError`. Chat rows stay
  durable and are continued by sending a message instead of exposing a
  separate lifecycle action.
- `handleBulkDeleteSelected` runs on selected non-running sessions
  with a similar confirm + promise-all-settled loop, wired to
  `ade.agentChat.delete` for chat rows and `ade.sessions.delete` for
  PTY rows. Succeeded ids are removed from the cache and the open-tabs
  list.
- `handleBulkArchiveSelected` / `handleBulkRestoreSelected` operate on
  the chat subset of the selection (`isChatToolType` + `archivedAt`
  state), calling `ade.agentChat.archive` / `ade.agentChat.unarchive`.
  Terminal sessions in the selection are skipped silently — only chats
  have an archived flag.
- `handleBulkExportSelected` builds a markdown bundle through
  `formatSessionBundleMarkdown` (in `renderer/lib/transcriptExport.ts`)
  and triggers a browser download via `triggerBrowserDownload`. The
  bundle is metadata-only (title, lane, status, started/ended, goal);
  full transcript bodies are not embedded.

Any selection-entry that is no longer present in the rendered session
list is pruned from `selectedSessionIds` automatically so stale ids
don't leak across filter changes.

## Session sidebar: `SessionListPane.tsx`

Lists sessions grouped by one of three modes (controlled by
`sessionListOrganization` in the work view state):

- `by-lane` — one group per active lane
- `by-status` — running / waiting-input / idle / ended
- `by-time` — today / yesterday / older

Each group uses a `StickyGroupHeader` with collapsed-state persistence
via `workCollapsedLaneIds` / `workCollapsedSectionIds`.

Lane group headers also wire into `useWorkLaneContextMenu`, so right-click
actions are available from the session sidebar. Color changes and copy/reveal
run inline. **Manage lane** opens the shared `ManageLaneDialog` in a portal over
Work, leaving the route, selected session, and Work layout unchanged when the
dialog closes; direct adopt, batch, and split actions continue through Lanes-tab
deeplinks.

The pane reads `laneDeleteProgressByLaneId` from the shared app store. In
`by-lane` mode the matching lane header becomes non-interactive and shows a
spinner with `Deleting`, `Deleted`, or `Deleted with warnings`. Every matching
`SessionCard` receives a `disabledReason`, so the lane's chats and CLI sessions
are dimmed and blocked in all three organization modes, not only beneath the
lane-group header.

In `by-lane` mode, any session whose `laneId` is not in the current
lanes list is still rendered under its own sticky "orphan lane" group
below the active lane groups. The list is built from
`missingLaneSessionGroups`: every `laneId` from `sessionsGroupedByLane`
that's absent from the `lanes` set becomes a group, labelled with the
session's `laneName` (falling back to the raw `laneId`) and sorted by
most-recent `startedAt`, with ties broken alphabetically. These groups
reuse the same `workCollapsedLaneIds` persistence, so a user who
collapses an orphan group sees it stay collapsed on reload. This keeps
sessions reachable when their lane has been archived, deleted, or not
yet loaded, instead of quietly dropping them from the sidebar.

In-flight chat handoffs are rendered as temporary placeholder cards in
the same sidebar. `TerminalsPage` pulls matching `HandoffLaunchJob`
rows from the root store and passes them into `SessionListPane`, which
lets them participate in the current lane, status, time, and search
filters. Placeholder rows are non-selectable, show the target model and
current handoff phase, and disappear when the new chat is created or
the handoff fails.

Also renders:

- draft-kind switcher (chat vs terminal) at the top
- lane filter (`LaneCombobox`) and status filter
- search input
- the actual list of `SessionCard` rows (memoized)
- an "Open new" button that sets `draftKind` and routes to
  `WorkStartSurface`
- an Add Lane button that opens `CreateLaneDialogHost` in-place. The
  Work flow uses the host's `close-on-create` behavior: it closes as
  soon as the lane row is created, then runs lane environment setup
  detached from the sidebar component and leaves a sticky retry toast if
  setup fails.
- a bulk-action footer that appears when `selectedSessionIds` is
  non-empty: "Close N running", "Archive N" (chats only), "Restore N"
  (archived chats), "Export" (any selection, opens a markdown bundle
  download), "Delete N ended", and a clear-selection X. The footer
  totals only count sessions that are still visible in the current
  filter; callers are `TerminalsPage`'s bulk handlers.

`onSelectSession(id, event, visibleSessionIds)` is forwarded verbatim
from `TerminalsPage`. The pane passes its own ordered id list (derived
from the active organization mode and uncollapsed groups) as the third
argument so shift-range selection follows the visual order the user
sees, not the underlying data order.

### `SessionCard.tsx`

Three rows:

1. **Status dot + title + relative time** — `sessionStatusDot()` and
   `primarySessionLabel()` drive these. The relative time comes from
   `relativeTimeCompact`. Disposed CLI rows render a small inline
   "Stopped" label immediately before the red status dot rather than an
   attention capsule.
2. **Preview line** (conditional) — when the card's lane is mid
   background AI auto-naming (`useLaneNaming(lane.id)` from
   `renderer/state/laneNamingStore.ts` is true), this row instead shows an
   italic "Auto-naming lane underway…" status. Otherwise it shows
   `session.summary` first; running sessions may then show sanitized
   `session.lastOutputPreview`; completed, failed, disposed, and detached
   sessions fall back to `session.goal` instead of raw last output.
   Sanitization strips ANSI and control chars via
   `sanitizeTerminalInlineText`. The title (row 1) gets a brief warm
   accent-tinted highlight whenever its displayed text changes — e.g. when
   the deterministic/seed name is replaced by the background AI name —
   skipped on first mount.
3. **Tool type + lane + badges** — `ToolLogo`, `shortToolTypeLabel`,
   lane icon/name, `ClaudeCacheTtlBadge` (Claude chat only), delta chips
   from `useSessionDelta`, exit code badge.

Hover actions include the info button. Ended agent CLI sessions are
continued from the transcript surface by typing into the lightweight
composer; the card itself does not expose a separate continuation action.

When `disabledReason` is set, the card disables selection, dragging, and its
context menu, lowers opacity, and renders a centered spinner/status overlay.
This is used while the card's owning lane is being deleted.

The selected card adds a left accent border and elevated background.
Cards in the multi-selection set (`isMultiSelected`) reuse the same
accent and add a subtle ring so shift / meta click selection reads
clearly even when the primary single-selection points elsewhere.

A small amber warning pip with a tooltip appears next to the title
when `getStaleRunningCliSessionAgeHours(session)` returns a value —
i.e. the session is still `running`, is not chat-typed, is not a
run-owned shell, and has been *idle* (no new output) for at least 24
hours. Idleness is measured from the session's last activity
(`lastActivityAt`, sourced from `terminal_sessions.last_output_at`),
falling back to `startedAt` when no output has been recorded — so an
old session that is still actively producing output is never flagged,
only genuinely untouched ones are. The tooltip reports the rounded
idle age so the user can decide whether to close it.

## Work view: `WorkViewArea.tsx`

Owns the render target for open sessions. Supports three modes tied to
`viewMode`:

- `tabs` — tab-strip + single `SessionSurface` for the active tab, plus
  a "New Chat" button in the tab strip. A second sub-mode (`hasGroupedTabs`)
  renders lane-grouped tab chips with per-group collapse. Lane group chips use
  `useWorkLaneContextMenu` for the same color/manage/split/batch actions as
  the Lanes tab.
- `grid` — tiled pane layout. Each session becomes a `PaneConfig` that
  mounts a `SessionSurface` in `grid-tile` variant. The tiling tree is
  rendered by `PaneTilingLayout`, seeded by
  `buildWorkSessionTilingTree(visibleSessionIds, tilingPreset)`. Grid
  mode renders an inline arrange menu (Auto / Rows / Columns) next to
  the visible-session count when more than one session is open;
  switching presets rewrites the persisted tiling tree
  (`window.ade.tilingTree.set(gridLayoutId, …)`) and resets pane sizes
  via `window.ade.layout.set(gridLayoutId, {})` so the new preset
  starts from `defaultSize` rather than inherited percentages.
- `single` — a single focused session with no tab chrome.

### `SessionSurface` (internal component)

Branches on `session.toolType`:

- chat tool types → `AgentChatPane` for the matching chat session
- PTY sessions → `TerminalView` wired to the session's `ptyId`
- lane-scoped terminal tools are opened from the Work sidebar's
  Terminal tab; tracked agent CLI sessions no longer add a separate
  Terminal shortcut in their work header

When a tile is suspended (grid layout where the tile is not visible),
it renders a static preview card instead of mounting the terminal.

Props that matter:

- `isActive` — whether this surface is the focused tab; terminals use
  this to gate input.
- `terminalVisible` — whether the surface is currently on screen; false
  disables xterm fit operations and PTY-resize broadcasts. Used by
  hidden grid tiles.
- `layoutVariant` — `"standard"` (single tab) vs `"grid-tile"`
  (compact chrome, smaller fonts).

Grid mode keeps running PTY sessions mounted so multiple terminals can
stay live at once; `isActive` only controls focus/input, not whether the
terminal renderer exists.

For tracked agent CLI sessions that have already exited, `WorkViewArea`
renders `ClosedCliSessionSurface` instead of `TerminalView`. The surface
fetches `ade.terminal.preview` and decides between a serialized snapshot
preview and the plain transcript text via `snapshotLooksLikeTui(rows)`:
when the snapshot contains TUI frame characters (`╭`, `─`, etc.) or
enough styled cells to be obviously a TUI redraw, the snapshot wins so
the user sees the Claude/Codex final screen instead of a flattened
transcript with the alt-screen escape codes visible. Ended tracked CLI
surfaces keep the same `WorkSurfaceHeader` controls as live CLI and chat
surfaces, including the far-left sessions-pane toggle and the far-right
Tools toggle, so a collapsed session sidebar is always recoverable. They
also expose two relaunch paths: **Resume** calls
`ade.pty.resumeSession` and opens the provider TUI without sending a
prompt, while the continuation composer calls `ade.pty.sendToSession`
and sends the follow-up as part of the first resume launch when
structured resume metadata is present.

Claude CLI surfaces whose recent preview/transcript reports `Please run
/login` or a 401 invalid-credentials error show the same dismissible
`Login to Claude` CTA used by Claude chat headers. It creates a tracked
shell PTY in the session's lane and runs `claude auth login`; the Work
tab selects that PTY so the user can finish the interactive login.

Constants:

- `CHAT_TILE_MIN_WIDTH = 440`, `CHAT_TILE_MIN_HEIGHT = 340`
- `TERMINAL_TILE_MIN_WIDTH = 320`, `TERMINAL_TILE_MIN_HEIGHT = 220`

## Grid mode: `PaneTilingLayout` + `workSessionTiling.ts`

The Work grid is a standard `PaneTilingLayout` instance with one leaf
per visible session. Two helpers build the inputs:

- `buildWorkSessionTilingTree(sessionIds, preset = "auto")` (in
  `workSessionTiling.ts`) returns the seed `PaneSplit` used when
  nothing has been persisted for the current `gridLayoutId`, and is
  also called by the arrange menu when the user requests a specific
  preset. `auto` biases toward near-square layouts:
  `columnCount = ceil(sqrt(n))`, `rowCount = ceil(n / columnCount)`,
  then `rowSizes(n, rowCount)` spreads sessions across rows so
  earlier rows absorb the remainder. `rows` produces one full-width
  vertical split per session; `columns` produces one full-height
  horizontal split per session. `minSize: 8%` (MIN_PANE_SIZE) /
  `12%` (MIN_ROW_SIZE) floors protect against accidentally collapsing
  a row.
- `WorkViewArea` builds one `PaneConfig` per visible session (keyed by
  `session.id`) with title, status dot, close button, mouse/context
  handlers that forward to `onSelectItem` / `onContextMenu`, and a
  `SessionSurface` child in `grid-tile` variant.

The actual split tree, resize state, and pane origin are owned by
`PaneTilingLayout`. See the next section for invariants the layout
enforces.

## Pane tiling layout primitives

`PaneTilingLayout` (`apps/desktop/src/renderer/components/ui/PaneTilingLayout.tsx`)
and its pure operations (`paneTreeOps.ts`) are shared across the Work
grid, `LanesPage`, `TerminalsPage` itself, and history detail views.
Reconciliation invariants the layout guarantees:

- **Seed tree.** Consumers pass a `tree: PaneSplit` prop that describes
  the default layout for the current set of pane IDs. `collectLeafIds(tree)`
  is the canonical `expectedPaneIds` list.
- **Persistence.** On mount the layout reads a persisted tree from
  `window.ade.tilingTree.get(layoutId)`. Every user-driven change
  (drop-edge split, swap, reconciliation) is written back with a 300 ms
  debounce. Panel sizes use a separate `DockLayoutState` store keyed by
  `layoutId` + positional path; any tree mutation resets that panel-size
  store so newly-split panels start from their `defaultSize` instead of
  inheriting a stale saved percentage.
- **Tree reconciliation.** `reconcilePaneTree(candidate, expectedPaneIds,
  fallback)` is called both on load (against the persisted tree) and on
  prop-tree changes. It drops leaves that are no longer expected,
  flattens any single-child splits produced by that removal, and
  inserts missing pane IDs by splitting the leaf with the largest
  computed weight (direction alternates: a missing pane added to a
  horizontal parent becomes a vertical split, and vice versa).
  Duplicate leaves or unknown IDs surviving the cleanup pass cause the
  whole tree to be replaced with the fallback.
- **Drop-edge detection.** `detectDropEdge(rect, clientX, clientY)`
  maps a pointer position to `top | bottom | left | right | center`
  using a 25 % edge threshold. The center zone triggers a swap
  (`swapPanes`); the four edges trigger `splitPaneAtEdge(tree, targetId,
  draggedId, edge)`, which prunes the dragged leaf, coerces the
  remaining tree to a split in the correct orientation, and replaces
  the target leaf with a two-child split whose child order follows the
  edge (`right`/`bottom` keep the target first; `left`/`top` put the
  dragged pane first).
- **Minimization.** Each leaf can minimize via its `FloatingPane`
  header. `PaneTilingLayout` runs two compaction passes off the
  `minimized` map: an individual-leaf pass that shrinks the leaf's
  containing panel to `LEAF_MINIMIZED_{HEIGHT,WIDTH}_PX`, and a
  split-level pass that compacts an entire subtree when every
  descendant leaf is minimized (`COMPACTED_WIDTH_PX` for horizontal
  parents, `COMPACTED_HEIGHT_PER_LEAF_PX × leafCount` for vertical
  parents). Both paths restore the previous panel size on un-minimize
  via `PanelImperativeHandle.resize`.

`FloatingPane` now also accepts `onPaneMouseDown` / `onPaneContextMenu`
so consumers (like the Work grid) can run selection / context-menu
logic on the wrapper without subscribing through drag handlers.
`PaneConfig` exposes a `className` pass-through so callers can apply
their own tile chrome classes (e.g. `ade-work-glass-tile`) alongside
the floating-pane defaults.

## Right-edge Work sidebar: `WorkSidebar.tsx`

A persistent right-edge pane that follows the active lane (and active
Work session when one is selected). It is rendered next to
`WorkViewArea` whenever `workSidebarOpen` is true and the view mode is
not `grid` — the grid layout owns the full row, so the sidebar is
suppressed there. `TerminalsPage` wraps the view + sidebar in a flex
container with a 5 px draggable column separator; the sidebar width is
persisted as `workSidebarWidthPct` (26–55%).

Tabs:

- `git` — `LaneGitActionsPane` on top, `LaneDiffPane` underneath
  whenever a file or commit is selected. The two share the row via
  the same min-height-aware flex layout as the lane detail view.
- `files` — `FilesTab` mounted with `preferredLaneId={laneId}` and
  `embedded={true}`. The `embedded` prop drops the desktop title block,
  the `View lane` button, the editor theme toggle, the `Open In` menu,
  and the file count, and shrinks the workspace selector so the file
  tree fits a narrow column.
- `ios` — `ChatIosSimulatorPanel` for the active lane (no chat scope).
- `app-control` — `ChatAppControlPanel` for the active lane.
- `browser` — `ChatBuiltInBrowserPanel` over the built-in browser's
  `WebContentsView` tabs for the current ADE window. Unlike the other
  tabs the browser is not lane-scoped; each ADE window owns its own tab
  set, active tab, bounds, and inspect state while all windows share the
  same `persist:ade-browser` partition for authentication. Browser
  selections flow back to the active chat through the same dispatch
  path. Switching off the tab and closing the sidebar both run
  `hideBuiltInBrowserView()`, which calls
  `window.ade.builtInBrowser.stopInspect()` and zeros the bounds with
  `visible: false` so the underlying `WebContentsView` is detached
  from the layout (otherwise it would float over neighbouring panes
  because `WebContentsView` paints above DOM siblings).

The sidebar picks a single insertion target per active Work session via
`WorkSidebarContextTarget`: a chat (`kind: "chat"`) when the focused
Work session is chat-typed, a draft composer (`kind: "draft"`, carrying
`draftTargetId`, `laneId`, and `draftKind`) when no session is active
but a draft composer is mounted, or a tracked agent CLI PTY
(`kind: "pty"`, carrying `sessionId`, `ptyId`, and `toolType`) when the
focused Work session is Claude / Codex / Cursor / OpenCode / Droid.
Chat and draft targets receive selections through window events
(`ade:agent-chat:add-attachment`, `add-ios-context`,
`add-app-control-context`, `add-builtin-browser-context`,
`insert-draft`); draft events carry `draftTargetId` instead of
`sessionId` so the matching `AgentChatPane` can identify the correct
draft composer. PTY targets get the same
selections formatted into prompt text by
`apps/desktop/src/renderer/lib/visualContextFormatting.ts`
(`formatIosElementContextForPrompt`,
`formatAppControlContextForPrompt`,
`formatBuiltInBrowserContextForPrompt`) and written into the PTY as a
bracketed-paste payload (`\x1b[200~…\x1b[201~`) through
`window.ade.pty.write`. After the write succeeds the sidebar dispatches
`ADE_WORK_PTY_CONTEXT_INSERTED_EVENT`
(`apps/desktop/src/renderer/lib/workPtyContextEvents.ts`) so the active
`TerminalView` can show a brief "context inserted" affordance. When no
chat, draft, or tracked agent CLI session is open in the active Work
lane, attachment is disabled with the banner "Open a chat, draft, or
agent CLI session in this lane before inserting tool context." The
sidebar also owns its own `AppControlSession` / `IosSimulatorSession`
subscriptions so it can detect lane mismatches (e.g. App Control was
launched from a different lane); lane mismatches are surfaced as an
informational warning banner but no longer block context insertion —
controls affect the running tool while inserted context goes to the
current chat, draft, or CLI target.

Toggling and tab selection go through `useWorkSessions` setters
(`setWorkSidebarOpen`, `setWorkSidebarTab`, `setWorkSidebarWidthPct`).
`setWorkSidebarTab` also opens the sidebar so clicking a tab from a
closed state acts as a one-click reveal. The toggle button itself
lives in the `WorkViewArea` tab-strip header (`WorkSidebarToggle`,
`SidebarSimple` glyph) so users can flip the sidebar on/off without
reaching across the screen.

Drawers in `AgentChatPane` accept `hideLaneToolDrawers={true}` when the
pane is mounted as a Work tile (`SessionSurface`), so the chat header
no longer shows the iOS / App Control toggles inside Work — those
drawers now live on the lane-scoped `WorkSidebar`. Proof remains
chat-scoped and stays on the chat header.

## Terminal renderer: `TerminalView.tsx`

Thin wrapper over xterm.js + `FitAddon`. Caches `Terminal` instances in
a module-level map keyed by `(projectRoot, sessionId, ptyId)` (via
`terminalRuntimeKey`) so a remount does not rebuild the emulator and so
two different project tabs can each cache their own runtime against the
same chat session id without colliding. Each cached entry also records
the `(projectRoot, projectRevision)` it was created under; on mount,
`disposeStaleRuntimes(activeProjectRoot, activeProjectRevision)` clears
out-of-date entries. With multi-project tab hosting in `App.tsx`,
project switching no longer evicts another project's terminals: an
entry is only torn down (or scheduled for keepalive teardown) when its
own project context has aged out, **not** when a different project
becomes active. The `projectRevision` counter lives in `useAppStore`
and is bumped on every real project change.

Renderer strategy: WebGL-first, fall back to the DOM renderer on any
init failure or context loss. Canvas renderer is intentionally skipped
(simplified from the earlier three-tier approach).

Exposes `TerminalHealthCounters`:

- `fitFailures`, `zeroDimFits`, `rendererFallbacks`, `droppedChunks`,
  `fitRecoveries`

Key behaviors:

- **Fit recovery** — if a fit computes invalid dims (`cols < 20`,
  `rows < 6`, or host width/height below `MIN_HOST_WIDTH_PX = 120` /
  `MIN_HOST_HEIGHT_PX = 48`), the last valid dims are restored, a retry
  is scheduled (`INVALID_FIT_RETRY_MS = 90 ms`), and the terminal
  content is refreshed. Successful recoveries bump `fitRecoveries`.
- **Measure host** — uses the max of `getBoundingClientRect`,
  `client*`, and `offset*` to handle zero-reported measurements during
  layout transitions.
- **Visibility gating** — `isActive` controls input; `isVisible`
  controls whether fit/resize runs (hidden tiles skip layout work).
- **Preferences reactivity** — watches `useAppStore` for
  `terminalPreferences` changes and applies font family, font size,
  line height, and scrollback to the live terminal, clearing the
  texture atlas to force glyph re-rasterization for WebGL.
- **Frame-write scheduling** — pending frame writes are coalesced on
  `requestAnimationFrame` when the runtime is visible and the page is
  foregrounded; a 16 ms `setTimeout` fallback takes over whenever the
  runtime is parked (no refs), hidden, or the document is
  backgrounded, so background terminals don't stall on `rAF` ticks
  that the browser suppresses. `flushPendingFrameWrites` / `clearFrameWriteSchedule`
  own both code paths.
- **Work-surface reveal redraw** — `TerminalView` listens for the
  `WORK_SURFACE_REVEALED_EVENT` window event (dispatched from
  `PersistentWorkSurface` whenever it returns to the foreground). On
  reveal, the view clears the WebGL texture atlas, flushes any
  pending frame writes, schedules a forced refit on the next animation
  frame, and re-runs `term.refresh(0, rows-1)` plus a focus +
  `scrollToBottom()` when the tile is the active one. This is the only
  reliable signal that "the surface is back on screen at its new
  size" since hidden surfaces no longer fire layout/resize events;
  without it, terminals come back blank after a tab swap.
- **Hydration backfill** — initial hydration prefers
  `ade.terminal.preview` (serialized snapshot of the visible rows
  rebuilt as SGR-bracketed ANSI through `serializeSnapshotVisibleRows`,
  falling back to the snapshot's `serialized` scrollback) and only uses
  the transcript tail when no snapshot is available. Before either path
  runs, the runtime calls `sessions.get(sessionId)` to find out whether
  the session is disposed; for any disposed session that hasn't
  displayed live data yet, hydration first tries **replay mode** via
  `sessions.readTranscriptTail({ raw: true })` (capped at
  `REPLAY_TRANSCRIPT_MAX_BYTES = 8 MB`) and feeds the result through
  `stripFullScreenRedrawSequences()` before writing. The strip removes
  alt-screen enter/leave (`?1049h/l`, `?47h/l`), hard resets (`\x1bc`),
  and full-screen erases (`\x1b[2J`, `\x1b[3J`, `\x1b[H\x1b[2J`) so each
  TUI redraw appends to the main buffer's scrollback instead of
  clobbering it. Replay-mode runtimes set `replayMode: true`, get
  `REPLAY_SCROLLBACK_LINES = 100_000` scrollback regardless of user
  preference, and skip the usual `trimToLikelyTerminalFrameBoundary`
  hydration trim so the whole transcript stays scrollable. This is
  what makes a disposed Claude / Codex chat session render as a
  scrollable transcript instead of "the last alt-screen frame" or
  "ANSI escape soup". The runtime tracks `hasAppliedTerminalContent`
  and `displayedLiveDataBeforeHydration`; if hydration returns nothing
  renderable while live PTY data is already on screen,
  `scheduleHydrationBackfill` retries the preview every ~100 ms (up to
  120 attempts) until the DOM reports renderable text. The backfill
  also re-arms whenever the tile becomes visible but the xterm rows
  are empty (e.g. after a webgl→dom fallback).
- **Mouse tracking and forced selection** — `TerminalView` tracks DECSET 1000 /
  1002 / 1003 mouse modes by scanning every PTY data chunk via
  `updateTerminalInputModes`, alongside xterm's own mouse-tracking state.
  xterm continues to forward ordinary mouse input to the embedded TUI. On
  macOS, `terminalMacShiftSelection.ts` converts left-button Shift+mousedown
  to xterm's Option-based force-selection gesture only while mouse tracking is
  active, so local text selection and copy remain available without sending
  that gesture to the CLI.
- **Cmd+C → SIGINT on macOS** — when the terminal is focused on macOS,
  ⌘C with no current selection sends `\x03` to the PTY (matches the
  Terminal.app behaviour TUI users expect). Selection-aware copy is
  handled by xterm's own selection plus the runtime's clipboard hook.

Font stack defaults: `ui-monospace`, `SFMono-Regular`, `Menlo`,
`Monaco`, `Cascadia Mono`, `JetBrains Mono`, `Geist Mono`, `monospace`.

## Empty state: `WorkStartSurface.tsx`

Rendered when the Work view has no open sessions. Accepts a
`draftContextTargetId` prop that is forwarded to the embedded
`AgentChatPane` so the Work sidebar can target the draft composer
for context insertions. Contains:

- A three-mode liquid-glass pill (`ModeSwitcherPills` in
  `WorkViewArea.tsx`) toggling `draftKind` between **Chat** (compose a
  new ADE chat in the lane), **CLI** (spawn a tracked agent CLI
  session), and **Shell** (plain shell terminal in the lane's
  worktree). `draftKind` is `WorkDraftKind = "chat" | "cli" | "shell"`
  in `appStore`.
- A sessions-pane expand affordance (`SessionsPaneExpandAffordance`)
  on the toolbar when the sidebar is collapsed: a sidebar glyph plus
  a count chip ("N in list, M running"). Clicking it expands the
  session sidebar without leaving the Work view.
- lane selector (`LaneCombobox`) synced to the global `selectedLaneId`
- for chat drafts: `AgentChatPane` in draft mode with provider-specific
  permission controls (`getPermissionOptions`, `safetyColors`)
- for cli drafts: a five-tile provider grid (Claude Code, Codex CLI,
  Cursor Agent CLI, Factory Droid CLI, OpenCode CLI) with logos sourced
  from `ToolLogos.tsx` / `ProviderLogos.tsx`. Selecting a provider
  resets the permission picker to that provider's documented default
  (`getPermissionOptions` keyed by `family`); Droid and OpenCode default
  to `edit`, the rest default to `default`. The "Launch" button calls
  `onLaunchPtySession` (typed as `(args: WorkPtyLaunchArgs) =>
  Promise<WorkPtyLaunchResult>`) with the payload from
  `buildTrackedCliLaunchCommand` (`{ command?, args, startupCommand,
  env? }`). `onLaunchPtySession` forwards `command` + `args` for direct
  argv spawn (Claude / Codex), passes `env` through to the PTY when set
  (OpenCode's `OPENCODE_CONFIG_CONTENT`), and ships `startupCommand` as
  the shell fallback the multi-line Cursor / Droid / OpenCode preambles
  always rely on. The recorded `toolType` and tab title come from the
  shared `LAUNCH_PROFILE_TOOL_TYPE` / `LAUNCH_PROFILE_TITLE` maps in
  `apps/desktop/src/shared/cliLaunch.ts` (the renderer
  `components/terminals/cliLaunch.ts` is now a thin re-export), so
  adding a new provider only requires extending the shared registry
  plus the `WorkStartSurface` option list — the same module also
  powers the iOS `work.startCliSession` mobile launcher.
- for shell drafts: a "Launch" button that opens an untracked shell PTY
  in the lane's worktree (`profile = "shell"`).

Launch commands are built by `apps/desktop/src/shared/cliLaunch.ts`:

- `buildTrackedCliLaunchCommand({ provider, permissionMode, ... })`
  returns the canonical `{ command?, args, startupCommand, env? }`
  shape used for fresh launches and internal provider continuation.
  Permission mode
  choices map onto provider-native flags / configs:
  - **Claude** → `--permission-mode` flag (CLI default plus
    plan/acceptEdits/bypassPermissions).
  - **Codex** → `--ask-for-approval` + `--sandbox` pair. `default`
    maps to `--sandbox workspace-write --ask-for-approval on-request`
    (Codex's documented Guarded Edit semantics; the older `--full-auto`
    alias caused the TUI to drop straight into auto-approval and was
    surprising in the Work tab). `full-auto` keeps the explicit
    `--dangerously-bypass-approvals-and-sandbox` flag, and `config-toml`
    mode defers to `.codex/config.toml`. ADE does not rewrite
    `mcp_servers` for Codex CLI launches; Codex config remains
    host-owned so ADE does not synthesize partial MCP tables that the
    CLI rejects during config validation.
  - **Cursor** → `--mode plan|ask` for read-only modes and `--force`
    for full-auto. Fresh launches start interactive `cursor-agent`
    directly; initial user prompts are submitted through PTY input after
    Cursor readiness, and empty launches do not submit ADE guidance as a
    first turn.
  - **Droid** → an autonomy-tiered settings JSON written to a temp file
    that `droid --settings $ADE_DROID_SETTINGS` consumes; `spec`
    autonomy is the plan/read-only fallback.
  - **OpenCode** → an inline JSON permission policy passed via the
    `OPENCODE_CONFIG_CONTENT` env var (`config-toml` mode skips the env
    so OpenCode reads `opencode.json` instead). Plan mode adds `--agent
    plan`.
  Every provider also receives ADE CLI guidance — Claude through
  `--append-system-prompt`, Codex/Droid/OpenCode as a leading prompt
  argument, and Cursor through PTY `initialInput` only when there is an
  initial user prompt.
- `buildTrackedCliStartupCommand({ provider, permissionMode, ... })`
  thin wrapper that returns just the shell-typed `startupCommand`.
- `resolveTrackedCliResumeCommand(session)` — internal runtime helper
  for rebuilding the command used behind the continuation composer.
  It calls `buildTrackedCliResumeCommand(metadata, overrides)`, which knows how
  to format Claude (`claude --resume <uuid>`), Codex (`codex resume
  <thread>`), Cursor (`cursor-agent --resume <chatId>` / `--continue`),
  Droid (the same `--settings` preamble plus `droid --resume <id>`),
  and OpenCode (`opencode --session <id>` / `--continue`). The
  `prompt` override is used by `sendToSession` for the first
  ended-session follow-up; `resumeSession` rebuilds the same command
  without a prompt.

## Context menu: `SessionContextMenu.tsx`

Right-click menu with branches per session type:

- Chat: Rename (inline text input, sets `manuallyNamed: true`), Set tag…
  (Claude only), Delete, archive/restore, Go to lane, Copy session ID.
- PTY: Stop runtime (dispatches `ptyDispose`), Go to lane, Copy
  session ID.

The rename input uses a local state and submits via
`sessions.updateMeta({ title, manuallyNamed: true })`. Errors bubble
up to `renameError` in `TerminalsPage`.

`Set tag…` is a second inline editor that reuses the same input chrome.
It appears only for running `claude-chat` sessions (writing a tag needs a
live Claude SDK runtime — `updateSession` throws for ended sessions),
submits `agentChat.updateSession({ sessionId, tag })` where an empty
value clears the tag, and the resolved `claudeTag` renders as a small
mono pill on the session card.

## Work view hook: `useWorkSessions.ts`

A single hook that owns a lot of state:

- session lists, deduped via `listSessionsCached()` with project-root +
  lane + status keying. When the IPC refresh returns a persisted row
  that already has a pending optimistic session for the same id, the
  hook calls `mergePendingOptimisticSession(persisted, optimistic)` to
  keep the optimistic `ptyId` on the row until the persisted view
  reflects it. The helper only merges when the persisted row is still
  `running`, the optimistic session carries a non-empty `ptyId`, and
  the persisted `ptyId` does not already match — that case returns the
  persisted row untouched and drops the pending entry. When merged,
  the row keeps the persisted fields but inherits the optimistic
  `ptyId` (plus `toolType` / `runtimeState` as gap-fillers when the
  persisted row hasn't backfilled them yet), and `keepPending: true`
  leaves the pending entry in place so the next refresh can re-merge
  if the persisted row still hasn't caught up. This closes a race
  where the persisted row landed before its `ptyId` was written and
  would otherwise clobber the optimistic attachment, leaving the new
  `TerminalView` unable to subscribe to live PTY data
- per-project work view state (open items, active/selected, view mode,
  draft kind, filters, organization, collapsed IDs, focus-hidden flag)
- lane-scoped work view state keyed as `projectRoot::laneId`
- persistence to `localStorage` under `ade.workViewState.v1`, written on
  every mutation
- `refresh({ showLoading, force })` — forces a cache bust and reloads
- project-switch hydration guards: cached destination rows can render
  immediately, but they are not treated as authoritative until the
  active project's refresh applies. While that guard is set,
  `useWorkSessions` does not mirror the current `sessions` array back
  into `sessionsCacheByProject` and does not prune persisted open tabs,
  because React can briefly render the previous project's session list
  after `projectRoot` changes.

`useWorkSessions({ active })` accepts an optional `active` flag (default
`true`). When `active` is false, the hook stops scheduling background
refreshes, defers the initial `refresh` until the route flips back to
`/work`, and cancels any pending refresh timer on transition. Callers
that mount the hook on tabs other than Work pass `active: false` to
avoid scanning sessions while the user can't see them.

The hook exposes `openSessionTab`, `focusSession`, `selectLane`,
`upsertOptimisticChatSession` (so new chats appear in the tab strip
before the IPC round-trip completes), `refresh`, and the right-sidebar
setters `setWorkSidebarOpen`, `setWorkSidebarTab` (also forces the
sidebar open), and `setWorkSidebarWidthPct` (clamped 26–55%).
`chatSessionEvents.ts` uses that optimistic path for durable chats created by
headless/batch launch, then schedules a short background refresh.

`launchPtySession` accepts `WorkPtyLaunchArgs` and returns
`Promise<WorkPtyLaunchResult>`. The args carry `disposition?:
WorkPtyLaunchDisposition` (`"foreground" | "background"`). When
disposition is `"background"`, the hook inserts the optimistic session
and invalidates the cache but skips `selectLane`, `focusSession`, and
`openSessionTab` so the launch happens without stealing the user's
current focus. When disposition is `"foreground"` (or unset), the hook
opens the tab off the synchronous `ptyCreate` result before kicking off
the background refresh: it focuses the session, calls `openSessionTab`,
and only then fires `refresh({ showLoading: false, force: true })`.
This is what makes the Work tab's optimistic terminal visible the
moment the PTY exists, which is the window in which the new
`TerminalView` runtime needs to attach so it can subscribe to live PTY
data before fast TUIs like Codex or Claude paint their first frame.
Waiting on the refresh round-trip first used to lose the initial paint
and leave the terminal blank. The `WorkPtyLaunchArgs` type (defined in
`apps/desktop/src/renderer/components/terminals/cliLaunch.ts`) carries
`laneId`, `profile`, and optional `command`, `args`, `startupCommand`,
`startupDelayMs`, `env`, `title`, `tracked`, and `disposition`. The
helper (and its lane-scoped twin in `useLaneWorkSessions`) builds a
default launch payload with `buildTrackedCliLaunchCommand` when the
caller didn't override `command`/`args`/`env`, so every entry point —
chat composer launch button, TopBar work controls, lane Work pane —
produces the same argv-based spawn with ADE CLI guidance baked in.
`profile` is a `LaunchProfile` (`"claude" | "codex" | "cursor" |
"droid" | "opencode" | "shell"`); the matching tab title and recorded
`TerminalToolType` come from the shared `LAUNCH_PROFILE_TITLE` /
`LAUNCH_PROFILE_TOOL_TYPE` maps in
`apps/desktop/src/shared/cliLaunch.ts`.
The runtime strips leading `ENV=value` assignments before sniffing the
provider, so continuation commands the OpenCode preamble emits
(`OPENCODE_CONFIG_CONTENT=… opencode --session …`) round-trip
correctly. `startupDelayMs` is forwarded into the `ade.pty.create`
payload only when the caller passes it (so non-Work callers don't
inherit a non-zero default); the Work CLI launch path in
`AgentChatPane` passes `workCliStartupDelayMs = 180` and
intentionally omits `command` / `args` so every Work CLI launch
goes through the shell + `startupCommand` path (see
[pty-and-processes.md](./pty-and-processes.md#create-flow-createargs)
for how the PTY service consumes the delay).

`useLaneWorkSessions` (in
`apps/desktop/src/renderer/components/lanes/useLaneWorkSessions.ts`)
wraps the same state but scopes to a single lane for the Lanes tab.
It consumes the same renderer-local chat-session creation announcement as
Work, filters it to the active project/lane, inserts the optimistic chat row,
and schedules a short background refresh.
Its `launchPtySession` also accepts `WorkPtyLaunchArgs` and returns
`WorkPtyLaunchResult`, forwarding `startupDelayMs` and respecting
`disposition` the same way. The lane-scoped launcher builds an
optimistic `TerminalSessionSummary` from the `ptyCreate` result and
upserts it into the session list immediately, then fires the forced
session-list refresh as fire-and-forget so the tab opens without
blocking on the IPC round-trip.

## Session delta hook: `useSessionDelta.ts`

Lightweight fetcher for `SessionDeltaSummary` keyed by session ID.
Called by `SessionCard` with `{ enabled: true }` and returns the
delta with `filesChanged`, `insertions`, `deletions`, `touchedFiles`,
`failureLines`, `computedAt`. Failures return null; the card renders
nothing when no delta is available.

## Shared helpers

- `apps/desktop/src/renderer/lib/sessions.ts` — `primarySessionLabel`,
  `preferredSessionLabel`, `shortToolTypeLabel`, `isChatToolType`,
  `isRunOwnedSession`, `buildOptimisticChatSessionSummary`.
- `apps/desktop/src/renderer/lib/terminalAttention.ts` —
  `sessionStatusDot`, `sessionIndicatorState`, `sessionCapsuleBadge`,
  `sessionInlineStatusLabel`, `sanitizeTerminalInlineText`.
- `apps/desktop/src/renderer/lib/sessionListCache.ts` —
  `listSessionsCached`, `invalidateSessionListCache`. Normal reads coalesce;
  forced reads and mutation invalidation bypass stale in-flight snapshots,
  with promise identity preventing late responses from replacing fresh cache.
- `apps/desktop/src/renderer/lib/chatSessionEvents.ts` —
  `announceWorkChatSessionCreated` invalidates both renderer list caches and
  publishes a durable chat session for optimistic Work/Lanes insertion;
  `shouldRefreshSessionListForChatEvent` gates refreshes on streamed chat IPC
  events so the session list does not thrash on every message.

## Gotchas

- Mount stability matters. Do not unmount a `SessionSurface` just
  because a tab is hidden; use `terminalVisible={false}` instead so the
  PTY stays attached. The cached runtime has a 400 ms dispose timer
  that fires only when refs hit zero and stay there.
- The session list cache is per `projectRoot + laneId + statusFilter`.
  Events that should update all views (e.g. a new chat session) should
  call `invalidateSessionListCache()` before the first `refresh()`.
- Refresh ordering for launches — use the synchronous `ptyCreate` /
  chat-create result to `openSessionTab` before the background forced
  refresh, then merge any stale persisted row with the optimistic row.
  Do not prune open tabs until an authoritative refresh for the current
  project has applied.
- The Work tab and the Lanes tab share the hook; changes to
  `useWorkSessions` ripple. Keep lane-scoped persistence keyed by
  `projectRoot::laneId` or the Lanes tab state leaks across projects.
- The Work grid is `PaneTilingLayout` — every visible session has a
  leaf and stays mounted. Grid tiles pass `terminalVisible={true}`;
  `isActive` controls input but not mount state, so multiple PTYs can
  stay live at once. The gridLayoutId is namespaced
  (`work:grid:tiling:v1:<projectRoot>[::<laneId>]`) so a persisted
  layout travels with the project/lane pair.

## Cross-links

- Main-process services feeding these surfaces:
  [pty-and-processes.md](./pty-and-processes.md)
- Lane gating and worktree isolation:
  [runtime-isolation.md](./runtime-isolation.md)
- Agent chat pane lives under
  `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` and is
  shared with this feature when the session is chat-typed.
