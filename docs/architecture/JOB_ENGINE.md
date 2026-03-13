# Job engine architecture

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-13

The job engine is ADE's event-driven background scheduler for lane refreshes and conflict prediction. It is intentionally separate from the main-process startup scheduler in `main.ts`: startup bootstraps services, while the job engine reacts to lane and session events after the app is already running.

---

## Overview

The job engine keeps background work off the user's critical interaction path.

Its current responsibilities are:

- refresh lane/project artifacts after meaningful lane activity
- coalesce duplicate refresh requests per lane
- run conflict prediction on debounced lane/head changes
- run periodic conflict prediction when enabled
- trigger optional follow-on AI work only after deterministic work is done

The engine is built to be:

- **event-driven** instead of constantly polling
- **coalesced** so repeated triggers collapse into one useful run
- **failure-isolated** so background jobs do not break the user action that triggered them

---

## What the job engine owns now

### Lane refresh

Lane refresh is triggered by events such as:

- tracked session end
- lane head change
- dirty-state transitions

The engine refreshes lane/project artifacts asynchronously and never blocks the triggering user action.

### Conflict prediction

Conflict prediction is now the main long-lived queue the engine manages.

Important current behavior:

- per-lane requests are debounced
- duplicate requests collapse into one run
- periodic prediction is enabled through runtime policy instead of always-on startup sweeps
- dev stability mode can keep periodic conflict prediction disabled unless it is explicitly re-enabled

This matters because earlier startup-wide conflict work created unnecessary pressure even when the user had not touched anything yet.

### Optional AI follow-up

The engine can still trigger AI follow-on work, but that work is advisory and detached from the scheduler's correctness:

- deterministic refresh work completes first
- AI tasks run only if the feature is enabled and the provider path is available
- AI failure logs a warning but does not invalidate the deterministic result

---

## What the job engine does not own

The job engine is no longer treated as the owner of every background task in the app.

It does **not** own:

- config reload startup
- Linear sync/ingress startup
- memory startup sweep boot
- embedding worker boot
- usage tracking boot
- external MCP boot

Those tasks are now started by the explicit project startup scheduler in `main.ts`, which gives each task its own logs, delays, and env gate.

---

## Queue model

### Per-lane coalescing

Each lane has queue state that tracks:

- whether a job is running
- whether a new request arrived while it was running
- the latest request payload to run next

If five events arrive for the same lane in a short burst, the engine does not run five full refreshes. It keeps only the newest useful request and processes that after the in-flight run completes.

### Debounced conflict queue

Conflict prediction uses a separate debounced queue so rapid git activity does not trigger a prediction storm. The engine can either:

- run targeted prediction for specific lanes
- promote to a full project-wide prediction when the event pattern warrants it

### Fire-and-forget callers

Callers enqueue work and return immediately. Session end, git, and lane services do not wait for the job engine to finish before responding to the renderer.

---

## Failure model

The engine is intentionally pessimistic about background work and optimistic about user experience.

That means:

- background job failures are logged, not surfaced as retroactive user-action failures
- one job failure does not poison the queue
- deterministic refresh work is still considered authoritative even if any follow-on AI task fails

This is part of ADE's broader stability model: background automation should never make the app feel broken.

---

## Integration points

The job engine integrates most directly with:

- PTY/session lifecycle services
- lane and git services
- conflict service
- project config service
- AI integration service

It also participates in the memory/conflict ecosystem indirectly by making sure downstream services see fresh lane state after meaningful activity.

---

## Current performance contract

The job engine now follows these rules:

- no startup-wide full conflict sweep in normal dev stability mode
- no blocking user actions on background refresh completion
- no duplicate per-lane refresh storms
- no hidden AI dependency for scheduler correctness

Those rules are what keep the engine useful without turning it into another source of app-wide lag.

---

## Current status

The job engine is stable and focused. It is no longer overloaded with unrelated startup concerns, and its conflict/lane refresh work is bounded enough to leave enabled in the normal dev runtime.

Future work should stay within that contract:

- keep triggers explicit
- keep expensive work debounced or coalesced
- keep user actions independent of background completion
