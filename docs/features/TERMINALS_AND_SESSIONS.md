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

The important change is that UI observers now subscribe more selectively and reuse cached list results where possible.

---

## Current product contract

The current terminals and sessions feature follows these rules:

- keep session tracking comprehensive
- keep transcript and delta capture authoritative
- let multiple renderer surfaces reuse session-list results
- avoid perpetual idle polling when there are no live sessions to watch

That preserves ADE's session-awareness while making the session system a lighter dependency for the rest of the UI.
