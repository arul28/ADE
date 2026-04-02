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

The Work tab also supports a single-session focused view and a tab-bar mode with a "New Chat" button in the tab strip for quick session creation.

### Shared session-list cache

The renderer now deduplicates repeated `ade.sessions.list` calls through a small shared cache layer. This cache is used by multiple surfaces that previously issued overlapping requests independently.

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

## Terminal status indicators

Terminal session status dots use distinct visual treatments per state:

- **Running (active)**: Spinning emerald ring (border spinner animation). Used in the tab nav, top bar, and terminal panel tabs.
- **Running (needs attention)**: Solid amber dot (no animation). Indicates the terminal is awaiting user input. The top bar variant pulses; the tab nav variant does not animate.
- **Ended**: Solid red dot (no animation).

The `sessionStatusDot()` helper in `terminalAttention.ts` and `sessionIndicatorState()` produce the dot class and spinning flag. The chat status glyph for "waiting" state renders a static check-circle icon rather than a spinner, distinguishing idle-waiting from active-working.
