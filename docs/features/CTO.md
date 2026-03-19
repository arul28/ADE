# CTO

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-16

The CTO is ADE's always-on, project-aware agent. It is one persistent ADE project operator, not a family of interchangeable chats. It owns persistent identity, shared project understanding, worker management, Linear workflow coordination, and the operator-facing chat surface for project-level requests.

The current runtime is optimized around a simple rule: **make the CTO usable before every optional subsystem is fully hydrated**.

2026-03-15 portability clarification:

- the CTO is not only a live-brain runtime concept
- a normal clone/pull should recover the shared CTO identity/config layer
- raw runtime/session logs, generated docs, and CTO runtime memory remain local or ADE-sync-only in this W3 pass

---

## What the CTO owns

The CTO combines several responsibilities:

- persistent project-facing chat
- worker/team management
- Linear workflow sync and dispatch
- optional OpenClaw bridge configuration
- budget and runtime visibility for the CTO org

The CTO is still a persistent agent, but the UI and runtime no longer assume that every one of those subsystems must fully boot the moment the tab opens.

---

## First-run setup

CTO onboarding now focuses on:

1. model selection
2. personality selection
3. project context
4. optional Linear connection

Important current behavior:

- ADE owns the immutable CTO doctrine in code
- the editable identity UI is now only personality presets plus one custom overlay option
- onboarding shows the effective prompt as three sections: doctrine, personality overlay, and memory model
- setup can finish without Linear
- the UI recommends a personal Linear API key as the fastest path
- OAuth stays available when configured
- OpenClaw is intentionally left out of first-run setup

This keeps CTO onboarding short and removes the earlier failure mode where disconnected integrations made the setup feel broken or blocked completion.

---

## Current tab behavior

### Chat-first entry

The default CTO entry path is optimized for the chat surface.

Current behavior:

- chat session boot is lighter in locked single-session mode
- the page avoids unnecessary rediscovery when the CTO session is already known
- renderer-side session/chat hydration is reduced on first entry

### Lazy team/settings work

The CTO page now splits heavy state into smaller loads:

- summary loads immediately
- history loads only when Team or Settings needs it
- budget snapshot loads later and is freshness-guarded
- external MCP registry loads only when Settings or worker editors need it
- worker revisions/details load only on Team

That keeps the default chat entry path from paying for every management surface up front.

### Sidebar behavior

The sidebar is now treated like a stable renderer leaf:

- the worker tree is precomputed instead of re-filtered on every render
- the sidebar is memoized
- the budget footer is isolated so budget refreshes do not rerender the full tree

---

## Linear integration model

ADE now treats Linear as two related but distinct capabilities:

1. **sync and dispatch** — the core workflow engine
2. **optional realtime ingress** — lower-latency webhook delivery

### Connection model

The connection panel supports:

- personal API key connection (recommended first path)
- OAuth connection when `.ade/secrets/linear-oauth.v1.json` is configured

### Workflow engine

The Linear workflow engine is now a full-featured dispatch and execution system. Workflows are defined visually or as YAML and fire when **both** an assignee match AND a workflow label match occur on a Linear issue.

Supported workflow targets:

- **employee_session** — direct CTO or mapped employee chat with issue context
- **worker_run** — delegated isolated worker in a fresh lane
- **mission** — broader multi-step ADE mission
- **pr_resolution** — PR-focused automation
- **review_gate** — manual approval-only gate

Each workflow supports:

- configurable trigger conditions (assignee + label, project slugs, team keys)
- execution plan steps (state transitions, launch, wait, PR linking, notification)
- supervisor review paths (after work, before PR, after PR)
- reject behaviors (loop back, reopen issue, cancel)
- closeout with configurable success/failure Linear states
- proof attachment from repo-local artifacts or absolute local files such as temporary screenshots
- simulation for testing before going live

### Employee and team routing

Workflows can route to any configured ADE employee, not just the CTO. The Team panel maps ADE workers to Linear identities (user IDs, display names, aliases) so assignee-based workflows can match the right person. This enables:

- direct CTO sessions for CTO-assigned issues
- fresh-lane supervised worker runs for delegated implementation
- arbitrary employee routing based on Linear assignee matching
- dynamic delegation via the LinearSyncPanel when no employee match is found (runs enter `awaiting_delegation` status with a dropdown for manual assignment before any invalid launch is attempted)

### Supervisor review

The supervisor path is a first-class workflow behavior. A workflow can insert a `request_human_review` step after work, before PR, or after PR. The run pauses in `awaiting_human_review` and exposes approve/reject actions. Reject can loop back to rework, reopen the Linear issue, or cancel the workflow. The renderer surfaces review context and action buttons in the Run Timeline panel.

### Run observability

Each workflow run is observable through:

- the "Watch It Live" monitor (4-stage story)
- per-run timeline with ingress events, step execution, and review decisions
- queue dashboard with status counts
- run detail with lane/session/PR/supervisor state

The LinearSyncPanel now stages hydration and debounces follow-up refreshes so active sync stays observable without forcing the whole CTO tab to churn on every queue event.

### Sync loop

Linear sync starts as a normal background service, but it now short-circuits aggressively when the project is effectively idle:

- if no workflows are enabled and there are no active runs, the sync cycle is skipped
- if no credentials exist and there are no active runs, the sync cycle is skipped
- new runs are only dispatched when workflows are enabled and credentials exist
- issue updates also short-circuit when credentials are missing and nothing active needs reconciliation

This means disconnected Linear no longer burns CPU just because the feature exists.

### Realtime ingress

Linear ingress is the optional realtime path that can accept relay or webhook events and feed them back into sync processing.

Current behavior:

- ingress only auto-starts when realtime configuration is actually present
- unconfigured ingress stays dormant
- realtime is optional; polling/sync is the baseline path

This is closer to a "boring first, advanced later" model and avoids surprise background startup work in unconfigured projects.

---

## OpenClaw integration

OpenClaw is still supported as an external bridge, but it is now explicitly an advanced configuration surface rather than part of first-run CTO setup.

That reduces setup complexity and keeps the core CTO workflow independent of external agent routing.

---

## Memory and identity

The CTO still owns persistent identity and long-lived project knowledge. The important runtime distinction is that this memory persists even when the UI is not keeping every supporting panel warm.

Current system behavior separates:

- CTO identity and core memory (CtoCoreMemory), managed in CTO Settings
- shared project knowledge (unified memory with project/agent/mission scopes)
- worker-specific core memory
- recent subordinate activity and session logs
- daily logs (append-only per-day markdown logs under `.ade/cto/daily/`)

For desktop portability, treat these differently:

- CTO identity is part of the shared Git-tracked ADE scaffold
- CTO core memory and generated context docs remain local/generated in this W3 pass
- recent subordinate activity and live session state are ADE-sync/runtime concerns
- raw daily logs remain operational history unless promoted into portable summaries or memory

### Identity system prompt

The CTO prompt model is now explicit and split into three layers:

- **Immutable ADE doctrine** -- defines who the CTO is, what ADE is, how memory/compaction work, and that the CTO is the project's technical/operator lead. This layer is ADE-owned, always present, and not compacted away.
- **Personality overlay** -- selected from presets or one custom personality field. This is the only user-editable identity layer.
- **Memory and continuity model** -- explains the long-term CTO brief, current working context, and durable searchable memory.

Project-specific summary, conventions, focus, and recent continuity live in memory layers, not inside the immutable doctrine.

The prompt preview in onboarding and settings reflects those same three sections so the UI now matches the actual runtime model.

### Daily logs

The CTO state service supports append-only daily logs:

- `appendDailyLog(entry, date?)` -- appends a timestamped line to that day's log file
- `readDailyLog(date?)` -- reads the full log for a given day
- `listDailyLogs(limit?)` -- lists available daily log dates (most recent first)

Daily logs are stored as markdown files under `.ade/cto/daily/<YYYY-MM-DD>.md`. They are part of the CTO continuity layer, not part of the immutable doctrine.

### Post-compaction identity re-injection

When a CTO or worker identity session undergoes context compaction, the service automatically re-injects the identity context via `refreshReconstructionContext()`. This prevents identity loss after compaction. The CTO keeps its ADE doctrine and personality overlay even when the working context is compressed.

Memory browsing and management are consolidated in Settings > Memory tab. The CTO tab no longer has its own Memory surface. CTO core memory and personality configuration are edited in CTO Settings; all other memory scopes are managed through the unified Settings > Memory tab.

---

## CTO operator surface

The CTO is a persistent ADE operator with a broad internal tool surface in chat. It can inspect and act across:

- work chats
- lanes
- missions
- managed processes
- pull requests
- files and context exports
- worker agents
- Linear workflow state

Important boundary:

- the CTO operates through stable ADE services, not raw Electron IPC
- mission coordinator internals remain mission-run specific and separate from the CTO chat tool surface
- when the CTO wants to open something in the UI, it returns explicit navigation suggestions instead of silently switching tabs

This is intentionally "full internal" in the ADE-service sense: the CTO can create and supervise ADE objects directly, while the renderer remains suggestion-driven.

---

## Current product contract

The current CTO experience is built around these rules:

- the default chat path should be light
- setup should not require optional integrations
- Linear should be useful in polling mode before realtime ingress is configured
- idle/disconnected integrations should stay quiet
- management surfaces can hydrate lazily without weakening the CTO's persistent identity model

That contract is what makes the CTO tab usable as a daily control surface rather than a heavy admin screen that happens to contain a chat box.
