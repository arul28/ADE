# Terminals and sessions

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-13

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

The Work tab renders active sessions in a responsive card grid (`WorkViewArea`). The grid uses CSS `auto-fill` with `minmax(min(100%, 360px), 1fr)` columns and `minmax(240px, 33vh)` row heights, so card count per row adjusts fluidly to the viewport width without fixed breakpoints. Each card wraps a `SessionSurface` (live terminal via xterm.js or agent chat pane) and supports right-click context menus for session-level actions.

The grid view and a single-session focused view are toggled via a view mode selector in the Work tab header.

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

## Current product contract

The current terminals and sessions feature follows these rules:

- keep session tracking comprehensive
- keep transcript and delta capture authoritative
- let multiple renderer surfaces reuse session-list results
- avoid perpetual idle polling when there are no live sessions to watch

That preserves ADE's session-awareness while making the session system a lighter dependency for the rest of the UI.
