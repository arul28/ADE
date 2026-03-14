# Missions

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-13

Missions are ADE's structured execution system for multi-step work. A mission creates durable run, step, attempt, intervention, and artifact state, while the orchestrator coordinates workers across the configured provider/runtime mix.

The mission runtime is feature-rich, but the launcher and page shell now follow a lighter loading model so the feature stays responsive.

---

## Runtime contract

### Planning is still mandatory

Planning remains the first-class initial phase. If a profile omits a planning phase, ADE injects one automatically before execution begins.

The coordinator is responsible for:

- gathering context
- optionally asking clarifying questions
- delegating to a planning worker
- explicitly advancing phases

The coordinator now emits structured lifecycle status updates at each stage:

- `booting` — coordinator is initializing
- `analyzing_prompt` — parsing the user's mission prompt
- `fetching_project_context` — loading project state and context
- `launching_planner` — spawning the planning worker
- `waiting_on_planner` — planner is running
- `planner_launch_failed` — planner spawn failed (triggers retry or intervention)
- `stopped` — coordinator has shut down

A planning-startup guard prevents non-ADE/native tool drift during the prep phase. If the coordinator detects tool calls that don't belong to the planning setup (e.g., arbitrary external MCP calls during context fetch), it traps them and routes into explicit recovery rather than allowing silent fallback.

### Planner launch reliability

The planner launch path now tracks attempts, categorizes failures (transient vs. permanent), and retries on transient errors. When a planner launch fails:

- transient failures (network, timeout, resource contention) trigger automatic retry with structured intervention logging
- permanent failures (config errors, missing capabilities) create an explicit intervention for the operator
- all failure categories are tracked in the run timeline for observability

### Root propagation

Worker tools now correctly resolve DB state from the canonical repo root while file access still happens in the lane workspace. This applies to both desktop-launched and headless-launched workers, ensuring that:

- tool calls that query project state (mission status, artifacts, etc.) read from the correct database
- file operations (reads, writes, diffs) operate within the lane's workspace boundary
- headless workers launched via the MCP server get the same root propagation as desktop workers

### Coordinator finalization awareness

The coordinator can now check the finalization state of a mission via the `check_finalization_status` tool, which reads the mission state doc and returns the current state of contract satisfaction, execution completeness, and queue landing. Additionally, queue landing completion events are routed to the coordinator's event loop so it observes downstream completion signals.

This is awareness, not automation: the coordinator uses finalization status to make informed decisions, but completion still routes through runtime validation gates.

### Step execution resilience

Several step-level safeguards ensure the runtime does not silently stall or lose work:

- **PR merge fallback** — PR merge steps use a 3-tier retry strategy: attempt merge, retry on transient failure, fall back to opening a draft PR, then request user intervention. A failed merge returns `blocked` status rather than `failed`, keeping the run recoverable.
- **Stagnation detection** — Agents that produce no output are tracked as potentially stagnant. The runtime reports elapsed silence duration so the coordinator can intervene before a run goes permanently idle.
- **Review wait timeout** — Human review steps time out after 48 hours. When the timeout fires, the step is marked failed with a `review_timeout` reason rather than hanging indefinitely.
- **Turn-level timeout** — Individual agent turns are capped at 5 minutes using the abort infrastructure. When a turn exceeds this limit, an error event is emitted and the turn is terminated.
- **Autopilot timeout** — The autopilot polling interval is 15 seconds (single configurable constant), up from the earlier 5-second default.

### Mission step bidirectional sync

`syncRunStepsFromMission()` synchronizes user-initiated step mutations (cancel, skip) from the mission state back into the orchestrator's run state. This ensures that when a user cancels or skips a step in the UI, the orchestrator picks up the change on its next cycle rather than continuing to execute the outdated step.

### Cascade cleanup

When a mission reaches a terminal state (finalization or cancellation), the runtime calls `cleanupTeamResources()` on a best-effort basis. This tears down worker sessions, temporary worktrees, and other team-scoped resources so they do not leak across runs.

The runtime is responsible for:

- durable run/step state
- dependency and validation gates
- intervention creation
- artifact persistence
- budget and permission enforcement

### Mission detail surface

Mission detail remains organized around:

- **Plan**
- **Chat**
- **Artifacts**
- **History**

The chat surface still distinguishes:

- a global summary thread
- worker/orchestrator detail threads

---

## Mission page loading model

The mission page no longer front-loads every piece of supporting state on mount.

Current loading behavior:

- mission list refreshes immediately
- dashboard load is delayed slightly
- mission settings load is delayed further
- model capability fetch is delayed further still
- create-dialog caches are prewarmed in the background

Live refresh behavior is also narrower now:

- mission events refresh list/dashboard on a short coalesced debounce
- orchestrator events refresh only the selected mission view on a longer debounce
- backgrounded mission tabs skip most of this work until the renderer is visible again

This staged approach keeps the missions tab interactive while slower metadata and summary queries warm up behind it.

---

## Mission creation flow

The mission launcher is now built around cached and conditional loading.

### Prewarmed data

The create dialog prewarms:

- phase profiles
- phase items
- AI auth/model availability

That reduces the "open dialog and wait for everything" feeling.

### Conditional budget telemetry

The launcher no longer fetches mission budget telemetry just because the dialog opened.

Current behavior:

- smart budget telemetry only loads when Smart Budget is enabled
- subscription budget telemetry only loads when relevant providers are selected
- API usage aggregation only loads when API-model budgeting is actually in play

This removes one of the biggest unnecessary launch-time stalls.

### Lazy advanced UI

Heavy sections such as budget, team runtime, permissions, and computer-use controls are mounted after the dialog settles instead of all at once on first paint.

### On-demand settings dialog

`MissionSettingsDialog` is only mounted when open, and the create-dialog host unmounts closed dialog content instead of leaving heavy hidden trees in the DOM.

---

## Mission preflight and knowledge sync

Mission preflight still checks the current project and runtime state before launch, including knowledge-sync concerns. Human work digest data is used to warn when human-authored code changed since the last digest.

That keeps missions aware of stale project knowledge without forcing the entire digest system into the critical path for normal page load.

---

## Context and persistence

Mission persistence still includes:

- run/step/attempt state
- interventions and approvals
- worker session lineage
- artifacts and outcomes
- mission-pack updates

Mission context remains task-centric rather than identity-centric:

- mission state is durable runtime state
- project memory is shared background knowledge
- worker context is assembled per run/attempt from the current frontier

Mission-scoped memory exists in the backend: workers write discoveries to the `mission` scope via `memoryAdd` during execution. On mission success, high-value mission memories are promoted to the `project` scope. The mission detail view does not have its own memory browsing surface — all memory browsing is consolidated in Settings > Memory tab.

---

## Current product contract

The current missions experience is built around these rules:

- keep the mission list usable immediately
- do not fetch launch-only metadata until the user is actually launching
- do not compute budget telemetry unless budget controls are active
- mount advanced launcher/settings UI only when needed
- keep live mission updates focused on the selected mission instead of the whole dashboard
- preserve the same durable run/step/artifact model underneath the lighter UI shell

This lets the missions feature stay orchestration-heavy without feeling like the whole page must cold-boot the orchestrator before the user can click anything.
