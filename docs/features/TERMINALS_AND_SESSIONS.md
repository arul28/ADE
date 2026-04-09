# Terminals and sessions

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

ADE treats PTY sessions and agent chat sessions as tracked execution surfaces with shared session metadata, delta computation, transcript persistence, and lane associations.

The session model is still foundational to ADE, but the renderer now handles session-derived UI state more carefully to avoid turning "watch sessions" into a constant source of idle polling.

---

## Session model

ADE still tracks:

- PTY-backed terminal sessions
- agent chat sessions
- transcript and transcript-tail data
- lane association
- start/end timestamps
- head SHA anchors
- delta and summary information
- `manuallyNamed` flag (suppresses auto-title generation when set by user rename)
- resume metadata for CLI-backed chat sessions (provider, target kind/ID, launch config)

Tracked sessions still feed history, lane refresh, conflict follow-up, and mission/worker visibility.

---

## Current renderer behavior

### Work view session grid

The Work tab's multi-session grid mode uses `PackedSessionGrid` — a resizable tile layout where each tile has an independent column/row span. The grid uses a bin-packing algorithm (`packGridItems` in `packedSessionGridMath.ts`) to arrange tiles compactly, minimizing wasted space. Layout spans are persisted per session via `readPackedGridSpan` / `reconcilePackedGridLayout` and survive session switches.

The grid math module (`packedSessionGridMath.ts`) provides:

- `computeGridColumnCount()` -- determines optimal column count from container width, tile count, and minimum tile width
- `computeMinimumRowSpan()` / `computeMinimumColSpan()` -- convert pixel minimums to grid span units
- `clampPackedGridSpan()` -- enforces minimum/maximum span constraints per tile
- `packGridItems()` -- bin-packing placement algorithm that iterates rows/columns to find the first available slot for each tile
- `computePackedGridRowHeight()` -- distributes container height evenly across rows, respecting a minimum base row height (`GRID_BASE_ROW_PX = 120`)
- `reconcilePackedGridLayout()` -- reconciles persisted layout spans with active tile IDs, preserving spans for inactive tiles

Each `SessionSurface` receives a `layoutVariant` prop (`"standard"` or `"grid-tile"`) and a `terminalVisible` flag so that terminals in non-visible tiles can skip fit operations. Chat tiles use minimum dimensions of 440x340px; terminal tiles use 320x220px.

The Work tab also supports a single-session focused view and a tab-bar mode with a "New Chat" button in the tab strip for quick session creation. The tab bar and grid view share a segmented view-mode toggle (`ViewModeToggle`) with labeled "Tabs" and "Grid" buttons in a pill-shaped container. Grid groups use rounded styling with an active-tab highlight and per-group count badges.

### Shared session-list cache

The renderer deduplicates repeated `ade.sessions.list` calls through a small shared cache layer. The cache key includes the current project root (from `useAppStore`), lane ID, and status filter, so switching projects invalidates stale entries. This cache is used by multiple surfaces that previously issued overlapping requests independently.

Current users include:

- app-shell terminal attention
- workspace/work views
- graph activity scoring
- lane surfaces

This reduces the "same list request from three places at once" problem without changing the session data contract.

### Route-scoped terminal attention

Global terminal-attention state is no longer treated as an always-on cross-app poller.

Current behavior:

- attention tracking only runs on `/work` and `/lanes`
- the session list used for attention is bounded
- agent chat events no longer force a terminal-attention refresh
- hidden or unrelated routes do not keep polling just to maintain a badge

### Lane terminal polling

Lane-scoped terminal panels still refresh while live work is active, but they no longer poll forever when nothing is happening.

Current behavior:

- initial lane session fetch is forced when the panel opens
- background polling only continues while the lane still has live running sessions
- the interval is slower than the previous unconditional loop

This keeps session visibility current without leaving zero-row polling loops running in idle file or lane views.

---

## AI-Generated Session Titles

PTY sessions support automatic AI-generated titles when an AI provider
is available (any mode other than `guest`). Title generation happens at
two points:

1. **Shortly after launch** -- After a 6-second delay, the service
   collects up to 800 characters of initial terminal output, strips ANSI
   escape sequences, and sends the cleaned text to the AI integration
   service with a prompt requesting a concise title (max 80 characters).
   This gives non-shell sessions (build commands, test runs, dev
   servers) a descriptive name based on their early output.

2. **On session completion** -- When a PTY session exits and
   `refreshOnComplete` is enabled (default: `true`), the service
   generates a final title from the transcript tail (last 2000
   characters). The prompt includes the session type, initial title,
   current goal, and exit code, producing a title that reflects the
   outcome of the completed session.

Title generation is gated by the `sessionIntelligence.titles.enabled`
config (falling back to `ai.chat.autoTitleEnabled`, default `true`).
The model used for title generation can be overridden via
`sessionIntelligence.titles.modelId`. The refresh-on-complete behavior
is controlled by `sessionIntelligence.titles.refreshOnComplete` (falling
back to `ai.chat.autoTitleRefreshOnComplete`, default `true`).

Title generation failures are logged as warnings and do not affect
session lifecycle.

---

## Session lifecycle

The lifecycle model remains the same:

1. create PTY or chat session
2. capture transcript and metadata
3. update previews while active
4. finalize end state and deltas
5. notify downstream systems such as history, lane refresh, and memory hooks

UI observers subscribe selectively and reuse cached list results where possible.

### Work view state persistence

The Work tab's per-project view state (open items, active/selected item, view mode, draft kind, filters, organization mode, collapsed lane/section/tab-group IDs, focus-hidden flag) is persisted to `localStorage` under `ade.workViewState.v1`. Lane-scoped view state is stored under the same key with a `projectRoot::laneId` composite key. State is read on app startup and written on every mutation, so the user's sidebar organization, collapsed groups, and active session survive page reloads and app restarts.

### Session resume and reattach

PTY sessions track structured resume metadata via `TerminalResumeMetadata`, which includes the provider (`claude` or `codex`), target kind (`session` or `thread`), target ID, and launch configuration (permission modes for each provider). This metadata enables the "resume" action in the session context menu and the `resumeCommand` field to reconstruct the appropriate CLI invocation for continuing a chat session.

When a user resumes a session, the renderer passes the existing `sessionId` to `pty.create`. The PTY service validates that the session exists, belongs to the requested lane, is tracked, and is not already attached to a live PTY. Instead of creating a new session row, the service calls `sessionService.reattach()` to reset the existing session's status to `running`, clear its end state, and bind it to the new PTY. The transcript file is reopened in append mode so the resumed session's output continues in the same transcript. This keeps the session's identity, lane association, and history intact across resume cycles.

If the resume target ID is missing from the session's metadata at close time, the PTY service performs a best-effort backfill by scanning the transcript tail for provider-specific session/thread identifiers. The backfill runs after the transcript stream is flushed and finalized, ensuring it reads complete output.

The resume command is always constructed with the `--resume` (Claude) or `resume` (Codex) flag, even when no target ID is available yet. This allows the CLI to prompt for session selection interactively when the target is unknown.

### Stale session reconciliation

On startup, the session service reconciles stale running sessions via `reconcileStaleRunningSessions()`. This marks orphaned sessions (those still in `running` status from a previous app lifecycle) as `disposed`. The method now accepts an `excludeToolTypes` parameter to skip specific tool types during reconciliation — for example, chat sessions may be excluded so they can be resumed rather than force-closed. The exclusion uses normalized tool types and generates a dynamic SQL `NOT IN` clause.

### Refresh-before-activate ordering

When a new session is created or an existing session is opened, the renderer refreshes the session list *before* activating the session tab. This ensures the new session exists in `sessionsById` when the UI resolves `activeSession` for the tab. Without this ordering, the active item ID would point to an unknown session and the view would fall back to the most recent session or display a blank pane until the next refresh cycle.

This pattern applies across all session-creation and session-opening paths:

- `useWorkSessions` and `useLaneWorkSessions`: `refresh()` is called and awaited before `focusSession()` and `openSessionTab()`.
- `TerminalsPage`: `work.refresh()` is awaited before `work.openSessionTab()`.
- `AgentChatPane`: The `onSessionCreated` and `refreshSessions` callbacks are awaited (not fire-and-forget) so that the parent surface navigates the user to the chat tab before the first agent turn begins.

---

## Session context menu

Right-clicking a session card in the Work view opens a context menu with
actions appropriate to the session type and state:

- **Chat sessions**: Rename (inline text input), stop, resume, go to
  lane, copy session ID.
- **PTY sessions**: Stop (sends SIGHUP), go to lane, copy session ID,
  copy resume command (when available).

The context menu is available on both the expanded session cards and the
compact tab bar at the bottom of the Work view. Renaming a chat session
through the context menu marks it as manually named, preventing
auto-title from overwriting the user's choice.

---

## Current product contract

The current terminals and sessions feature follows these rules:

- keep session tracking comprehensive
- keep transcript and delta capture authoritative
- let multiple renderer surfaces reuse session-list results
- avoid perpetual idle polling when there are no live sessions to watch

That preserves ADE's session-awareness while making the session system a lighter dependency for the rest of the UI.

---

## Terminal renderer and fit recovery

`TerminalView` initializes xterm.js with a **WebGL-first renderer** and falls back to the DOM renderer if WebGL initialization fails (e.g. GPU driver issues, WebGL context loss). The previous three-tier strategy (WebGL -> canvas -> DOM) was simplified to two tiers since the canvas renderer offered no meaningful advantage over the DOM fallback. On WebGL context loss, the runtime clears the texture atlas, increments the `rendererFallbacks` health counter, falls back to the DOM renderer, and re-triggers a fit cycle.

The `TerminalView` component accepts `isActive` and `isVisible` props that control runtime interaction and visibility state. The runtime tracks these via `active` and `visible` fields on the cached runtime. When a terminal is not visible, fit operations are skipped (unless it has never been fitted), and forced PTY resize requests are suppressed. This prevents unnecessary layout work for terminals in background tiles. The `documentOverride` option is set to `document` at creation time to support proper rendering when terminals are mounted in packed grid tiles.

When a terminal is resized or re-parented (e.g. moved between grid tiles), the fit addon computes new column/row dimensions from the host container. If the computed dimensions are invalid (below `MIN_VALID_COLS = 20` / `MIN_VALID_ROWS = 6`, or the host is smaller than `MIN_HOST_WIDTH_PX = 120` / `MIN_HOST_HEIGHT_PX = 48`), the previous valid dimensions are restored, the fit is retried after a short delay (`INVALID_FIT_RETRY_MS = 90ms`), and the terminal content is refreshed to prevent visual artifacts. Successful retries after an initial invalid fit are counted as `fitRecoveries` in the `TerminalHealthCounters`. The `measureHost` helper uses the maximum of `getBoundingClientRect`, `clientWidth`/`clientHeight`, and `offsetWidth`/`offsetHeight` to handle edge cases where one measurement API returns zero during layout transitions. A `fitWarningLogged` flag prevents log spam when a host remains too small across multiple retry cycles.

## Terminal preferences

Terminal font size, line height, and scrollback depth are configurable via Settings > General > Terminal. Preferences are persisted to `localStorage` under `ade.terminalPreferences.v1` and applied globally across all terminal surfaces: work terminals, lane shells, resolver terminals, and the chat drawer.

| Setting | Range | Default |
|---------|-------|---------|
| Font size | 10 -- 18 px (0.5 increments) | 12.5 |
| Line height | 1.0 -- 1.6 | 1.25 |
| Scrollback | 2,000 -- 100,000 lines | 10,000 |

`TerminalView` reads preferences from `useAppStore` and applies them at runtime creation and on preference change. When preferences change, the runtime updates font family, font size, line height, and scrollback on the xterm instance, clears the texture atlas (to force glyph re-rasterization for WebGL), and re-triggers a fit cycle. The terminal font stack prioritizes platform-native monospace fonts (`ui-monospace`, `SFMono-Regular`, `Menlo`, `Monaco`, `Cascadia Mono`, `JetBrains Mono`, `Geist Mono`, `monospace`).

## Session card design

Each session card in the sidebar renders three rows:

1. **Status dot + title + relative time** -- The status dot indicates session state (see below). The title uses `primarySessionLabel()`. A compact relative timestamp (`relativeTimeCompact` -- "now", "2m", "1h", "3d") is right-aligned.
2. **Preview line** (conditional) -- Shows the session summary, last output preview (sanitized via `sanitizeTerminalInlineText`), or goal, whichever is available and different from the title.
3. **Tool type + lane + badges** -- A short tool type label (`shortToolTypeLabel` -- "Claude", "Shell", "Codex", etc.), lane marker with name, cache timer badge (Claude sessions), delta chips, and exit code badge.

The selected card has a left accent border and elevated background. Hover actions (info button, resume button) appear on mouse-over.

## Session list organization

The sidebar session list supports three organization modes: **by lane**, **by status** (running / awaiting / ended), and **by time** (today / yesterday / older). Each group uses a collapsible sticky header (`StickyGroupHeader`) with a caret toggle, icon, label, and count badge. Collapsed state is persisted per section ID in `workCollapsedSectionIds` (status/time groups) and `workCollapsedLaneIds` (lane groups) within the work view state.

## Terminal status indicators

Terminal session status dots use distinct visual treatments per state:

- **Running (active)**: Spinning emerald ring (border spinner animation). Used in the tab nav, top bar, and terminal panel tabs.
- **Running (needs attention)**: Solid amber dot (no animation). Indicates the terminal is awaiting user input. The top bar variant pulses; the tab nav variant does not animate.
- **Ended**: Solid red dot (no animation).

The `sessionStatusDot()` helper in `terminalAttention.ts` and `sessionIndicatorState()` produce the dot class and spinning flag. The chat status glyph for "waiting" state renders a static check-circle icon rather than a spinner, distinguishing idle-waiting from active-working.
