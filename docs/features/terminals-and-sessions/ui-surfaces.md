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

## Session sidebar: `SessionListPane.tsx`

Lists sessions grouped by one of three modes (controlled by
`sessionListOrganization` in the work view state):

- `by-lane` — one group per active lane
- `by-status` — running / waiting-input / idle / ended
- `by-time` — today / yesterday / older

Each group uses a `StickyGroupHeader` with collapsed-state persistence
via `workCollapsedLaneIds` / `workCollapsedSectionIds`.

Also renders:

- draft-kind switcher (chat vs terminal) at the top
- lane filter (`LaneCombobox`) and status filter
- search input
- the actual list of `SessionCard` rows (memoized)
- an "Open new" button that sets `draftKind` and routes to
  `WorkStartSurface`

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

## Work view: `WorkViewArea.tsx`

Owns the render target for open sessions. Supports three modes tied to
`viewMode`:

- `tabs` — tab-strip + single `SessionSurface` for the active tab, plus
  a "New Chat" button in the tab strip.
- `grid` — packed grid layout, each tile is a `SessionSurface` in
  `grid-tile` variant.
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

Constants:

- `CHAT_TILE_MIN_WIDTH = 440`, `CHAT_TILE_MIN_HEIGHT = 340`
- `TERMINAL_TILE_MIN_WIDTH = 320`, `TERMINAL_TILE_MIN_HEIGHT = 220`

## Packed grid: `PackedSessionGrid.tsx` + `packedSessionGridMath.ts`

Resizable tile layout. Each tile has an independent `colSpan` and
`rowSpan`; the math module bin-packs tiles into rows/columns to minimize
gaps:

- `computeGridColumnCount(containerWidth, tileCount, minTileWidth)`
- `computeMinimumRowSpan()` / `computeMinimumColSpan()`
- `clampPackedGridSpan()` — enforces per-tile min/max spans
- `packGridItems(items)` — places each tile in the first available
  slot scanning rows then columns
- `computePackedGridRowHeight(containerHeight, rowCount)` — distributes
  height evenly, min `GRID_BASE_ROW_PX = 120`
- `reconcilePackedGridLayout(persistedLayout, activeIds)` — preserves
  spans for tiles that come back later

Spans are persisted per session via `readPackedGridSpan` /
`reconcilePackedGridLayout` and survive session switches.

## Terminal renderer: `TerminalView.tsx`

Thin wrapper over xterm.js + `FitAddon`. Caches `Terminal` instances in
a module-level map keyed by `(ptyId, sessionId)` so a remount does not
rebuild the emulator.

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
- `PackedSessionGrid` renders all tiles; only suspended tiles become
  preview cards. The decision is driven by `terminalVisible` via
  `IntersectionObserver` wiring inside the grid component.

## Cross-links

- Main-process services feeding these surfaces:
  [pty-and-processes.md](./pty-and-processes.md)
- Lane gating and worktree isolation:
  [runtime-isolation.md](./runtime-isolation.md)
- Agent chat pane lives under
  `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` and is
  shared with this feature when the session is chat-typed.
