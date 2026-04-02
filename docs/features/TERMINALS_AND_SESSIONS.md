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

The Work tab supports two grid modes, toggled via a view mode selector in the Work tab header:

- **Standard grid** (`WorkViewArea`): CSS Grid with `auto-fill` and `minmax(min(100%, 360px), 1fr)` columns and `minmax(240px, 33vh)` row heights. Cards adjust fluidly to the viewport width without fixed breakpoints. Each card wraps a `SessionSurface` (live terminal via xterm.js or agent chat pane) and supports right-click context menus.
- **Packed grid** (`PackedSessionGrid`): A resizable tile layout where each tile has an independent column/row span. Tiles can be resized via drag handles on all edges and corners. The grid uses a bin-packing algorithm (`packGridItems` in `packedSessionGridMath.ts`) to arrange tiles compactly, minimizing wasted space. Layout spans are persisted per session via `readPackedGridSpan` / `reconcilePackedGridLayout` and survive session switches. Minimum tile dimensions (`MIN_VALID_COLS`, `MIN_VALID_ROWS`) are enforced to prevent degenerate sizes.

Both modes also support a single-session focused view.

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

`TerminalView` initializes xterm.js with a **WebGL-first renderer** and falls back to the DOM renderer if WebGL initialization fails (e.g. GPU driver issues, WebGL context loss). The previous three-tier strategy (WebGL -> canvas -> DOM) was simplified to two tiers since the canvas renderer offered no meaningful advantage over the DOM fallback.

When a terminal is resized or re-parented (e.g. moved between grid tiles), the fit addon computes new column/row dimensions from the host container. If the computed dimensions are invalid (below `MIN_VALID_COLS` / `MIN_VALID_ROWS`, or the host is too small), the fit is retried after a short delay (`INVALID_FIT_RETRY_MS = 90ms`). Successful retries after an initial invalid fit are counted as `fitRecoveries` in the `TerminalHealthCounters`. The `measureHost` helper uses the maximum of `getBoundingClientRect`, `clientWidth`/`clientHeight`, and `offsetWidth`/`offsetHeight` to handle edge cases where one measurement API returns zero during layout transitions. A `fitWarningLogged` flag prevents log spam when a host remains too small across multiple retry cycles.

## Terminal status indicators

Terminal session status dots use distinct visual treatments per state:

- **Running (active)**: Spinning emerald ring (border spinner animation). Used in the tab nav, top bar, and terminal panel tabs.
- **Running (needs attention)**: Solid amber dot (no animation). Indicates the terminal is awaiting user input. The top bar variant pulses; the tab nav variant does not animate.
- **Ended**: Solid red dot (no animation).

The `sessionStatusDot()` helper in `terminalAttention.ts` and `sessionIndicatorState()` produce the dot class and spinning flag. The chat status glyph for "waiting" state renders a static check-circle icon rather than a spinner, distinguishing idle-waiting from active-working.
