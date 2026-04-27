# Terminal and Session UI Surfaces

The renderer surfaces that expose session data to the user. All paths
are under `apps/desktop/src/renderer/components/terminals/` unless
noted otherwise.

## Entry page: `TerminalsPage.tsx`

Top-level page for the Work tab. Wraps two panes with `PaneTilingLayout`:

- `sessions` pane (default 24%, min 15%) → `SessionListPane`
- `view` pane (default 76%, min 40%) → `WorkViewArea`

Pulls all session state through `useWorkSessions()` and renders two
globally-positioned overlays:

- `SessionContextMenu` — right-click actions on session cards and tabs.
- `SessionInfoPopover` — hover/click info panel showing tool type,
  resume command, lane, transcript path, exit code.

The page handles session navigation (selection, tab open, "go to lane")
and invalidates the shared session list cache before pushing a
freshly-opened chat into the Work tab.

It also owns the sidebar's multi-select state:

- `selectedSessionIds: Set<string>` with a `selectionAnchorId` tracker.
- `handleSelectSession(id, event, visibleSessionIds)` — plain click
  clears the multi-selection and opens the tab; shift-click selects the
  range from the anchor; meta/ctrl-click toggles the id in/out of the
  set; any of the three refresh the active single-selected item.
- `handleBulkCloseSelected` runs on selected `running` sessions,
  confirming before calling `closeChatSession` for chat rows or
  `closeSession(ptyId, sessionId)` for PTY rows; failures are counted
  and surfaced through `sessionActionError`.
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

Also renders:

- draft-kind switcher (chat vs terminal) at the top
- lane filter (`LaneCombobox`) and status filter
- search input
- the actual list of `SessionCard` rows (memoized)
- an "Open new" button that sets `draftKind` and routes to
  `WorkStartSurface`
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
   `relativeTimeCompact`.
2. **Preview line** (conditional) — `session.summary`, then sanitized
   `session.lastOutputPreview`, then `session.goal`, whichever differs
   from the title. Sanitization strips ANSI and control chars via
   `sanitizeTerminalInlineText`.
3. **Tool type + lane + badges** — `ToolLogo`, `shortToolTypeLabel`,
   lane icon/name, `ClaudeCacheTtlBadge` (Claude chat only), delta chips
   from `useSessionDelta`, exit code badge.

Hover actions include an info button and a resume button. Resume is
enabled only when the session has ended and has a resolvable CLI
resume command.

The selected card adds a left accent border and elevated background.
Cards in the multi-selection set (`isMultiSelected`) reuse the same
accent and add a subtle ring so shift / meta click selection reads
clearly even when the primary single-selection points elsewhere.

A small amber warning pip with a tooltip appears next to the title
when `getStaleRunningCliSessionAgeHours(session)` returns a value —
i.e. the session is still `running`, is not chat-typed, is not a
run-owned shell, and has been running for at least 12 hours. The
tooltip reports the rounded age so the user can decide whether to
close it.

## Work view: `WorkViewArea.tsx`

Owns the render target for open sessions. Supports three modes tied to
`viewMode`:

- `tabs` — tab-strip + single `SessionSurface` for the active tab, plus
  a "New Chat" button in the tab strip. A second sub-mode (`hasGroupedTabs`)
  renders lane-grouped tab chips with per-group collapse.
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

## Terminal renderer: `TerminalView.tsx`

Thin wrapper over xterm.js + `FitAddon`. Caches `Terminal` instances in
a module-level map keyed by `(ptyId, sessionId)` so a remount does not
rebuild the emulator. Each cached entry also records the
`(projectRoot, projectRevision)` it was created under; on mount,
`disposeStaleRuntimes(activeProjectRoot, activeProjectRevision)` tears
down any entries whose project context no longer matches, which is how
terminal cache state gets cleared on project switch or close without
ever leaking PTYs between projects. The `projectRevision` counter
lives in `useAppStore` and is bumped on every real project change.

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

Font stack defaults: `ui-monospace`, `SFMono-Regular`, `Menlo`,
`Monaco`, `Cascadia Mono`, `JetBrains Mono`, `Geist Mono`, `monospace`.

## Empty state: `WorkStartSurface.tsx`

Rendered when the Work view has no open sessions. Contains:

- `draftKind` switch between chat and terminal
- lane selector (`LaneCombobox`) synced to the global `selectedLaneId`
- for chat drafts: `AgentChatPane` in draft mode with provider-specific
  permission controls (`getPermissionOptions`, `safetyColors`)
- for terminal drafts: provider picker (Claude / Codex / Shell),
  permission mode dropdown, and a "Launch" button that calls
  `onLaunchPtySession` with the built startup command from
  `buildTrackedCliStartupCommand`

Launch commands are built by `cliLaunch.ts`:

- `buildTrackedCliStartupCommand({ provider, permissionMode, ... })`
- `resolveTrackedCliResumeCommand(session)` — used for the resume
  action on the session card

## Context menu: `SessionContextMenu.tsx`

Right-click menu with branches per session type:

- Chat: Rename (inline text input, sets `manuallyNamed: true`), Stop,
  Resume, Go to lane, Copy session ID.
- PTY: Stop (dispatches `ptyDispose`), Go to lane, Copy session ID,
  Copy resume command (when available).

The rename input uses a local state and submits via
`sessions.updateMeta({ title, manuallyNamed: true })`. Errors bubble
up to `renameError` in `TerminalsPage`.

## Work view hook: `useWorkSessions.ts`

A single hook that owns a lot of state:

- session lists, deduped via `listSessionsCached()` with project-root +
  lane + status keying
- per-project work view state (open items, active/selected, view mode,
  draft kind, filters, organization, collapsed IDs, focus-hidden flag)
- lane-scoped work view state keyed as `projectRoot::laneId`
- persistence to `localStorage` under `ade.workViewState.v1`, written on
  every mutation
- `refresh({ showLoading, force })` — forces a cache bust and reloads

The hook exposes `openSessionTab`, `focusSession`, `selectLane`,
`upsertOptimisticChatSession` (so new chats appear in the tab strip
before the IPC round-trip completes), and `refresh`.

`useLaneWorkSessions` (same file) wraps the same state but scopes to a
single lane for the Lanes tab.

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
  `sessionStatusDot`, `sessionIndicatorState`, `sanitizeTerminalInlineText`.
- `apps/desktop/src/renderer/lib/sessionListCache.ts` —
  `listSessionsCached`, `invalidateSessionListCache`.
- `apps/desktop/src/renderer/lib/chatSessionEvents.ts` —
  `shouldRefreshSessionListForChatEvent` gates refreshes on chat IPC
  events so the session list does not thrash on every message.

## Gotchas

- Mount stability matters. Do not unmount a `SessionSurface` just
  because a tab is hidden; use `terminalVisible={false}` instead so the
  PTY stays attached. The cached runtime has a 400 ms dispose timer
  that fires only when refs hit zero and stay there.
- The session list cache is per `projectRoot + laneId + statusFilter`.
  Events that should update all views (e.g. a new chat session) should
  call `invalidateSessionListCache()` before the first `refresh()`.
- Refresh ordering — `openSessionTab` must run *after* `refresh` resolves,
  otherwise `sessionsById.get(activeItemId)` returns undefined on first
  paint and the view silently falls back to the most recent session.
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
