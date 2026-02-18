# ADE Final Plan (Canonical Roadmap)

Last updated: 2026-02-18  
Owner: ADE  
Status: Active

---

## 1. Purpose

This file is the canonical implementation roadmap for future ADE work.

- `docs/PRD.md` remains the product behavior/scope reference.
- This plan defines execution order, dependencies, and delivery gates.
- Feature and architecture docs should align to this file for forward-looking sequencing.

---

## 2. Code-Backed Baseline (Current State)

Baseline derived from code in `apps/desktop`, `apps/web`, and `infra`.

### 2.1 Shipped surfaces

- Play (`/project`)
- Lanes (`/lanes`)
- Files (`/files`)
- Terminals (`/terminals`)
- Conflicts (`/conflicts`)
- Context (`/context`)
- Graph (`/graph`)
- PRs (`/prs`)
- History (`/history`)
- Automations (`/automations`)
- Settings (`/settings`)

### 2.2 Shipped capabilities

- Lane/worktree lifecycle with stacks, restack suggestions, auto-rebase status
- PTY sessions with transcripts, summaries, deltas, and lane-scoped quick launch profiles
- File explorer/editor with watch/search/quick-open and atomic writes
- Full git workflow coverage for day-to-day branch operations
- Conflict prediction, risk matrix, merge simulation, proposal apply/undo, external resolver runs
- PR workflows (including stacked and integration PR paths)
- Packs/checkpoints/version/event pipeline with bounded exports
- Automations engine + natural-language planner
- Hosted/BYOK/CLI provider modes, onboarding, CI import, project switching

### 2.3 Architectural leverage and constraints

- Main process is already service-oriented and extraction-friendly.
- IPC surface is broad (`225` channels in `apps/desktop/src/shared/ipc.ts`).
- `registerIpc.ts` concentration remains a known extraction bottleneck.
- Core product behavior is local-first and must stay operational without hosted AI.

### 2.4 Confirmed gaps

Not implemented yet:

- Missions runtime + mission persistence lifecycle
- Orchestrator runtime + step queue/retry model
- Agent identities (persona/policy bundles)
- Night Shift automation family
- Play runtime isolation stack (ports/routing/preview/profile isolation)
- Integration sandbox for lane-set verification
- MCP server app
- `packages/core` extraction
- Relay and machine registry/routing
- iOS control app
- Monetization/provider routing policies

---

## 3. North Star

ADE becomes the execution control plane for parallel agentic development:

1. Users execute via existing CLI subscriptions where policy allows.
2. ADE hosted AI is additive, not mandatory.
3. BYOK and CLI-only execution remain first-class.
4. Missions, lanes, packs, conflicts, and PRs share one coherent execution model.
5. Desktop, relay machines, and iOS share one mission/audit state model.

---

## 4. Feature Coverage Matrix

Every planned feature in this roadmap is assigned to exactly one primary build phase.

| Feature | Primary Phase | Depends On |
|---|---|---|
| Missions (model + UI) | Phase 1 | Current baseline |
| Orchestrator runtime | Phase 2 | Phase 1 |
| Agent identities | Phase 3 | Phase 2 |
| Night Shift | Phase 4 | Phases 2-3 |
| Play runtime isolation | Phase 5 | Phase 2 |
| Integration sandbox + readiness gates | Phase 6 | Phase 5 |
| MCP server | Phase 7 | Phase 2 (Phase 8 optional) |
| Core extraction (`packages/core`) | Phase 8 | Phases 2,5,6 |
| Relay + Machines | Phase 9 | Phase 8 |
| iOS app | Phase 10 | Phase 9 |
| Monetization + provider strategy | Phase 11 | Phases 1-10 stabilization |

---

## 5. Delivery Rules (All Phases)

- No phase ships with undocumented safety bypass defaults.
- Every new execution path emits durable event/audit records.
- Every phase includes migration notes for existing local state.
- Every phase includes automated test coverage additions.
- Every phase updates impacted docs in the same delivery window.

---

## 6. Program Roadmap (Detailed Phases)

## Phase 1 — Missions v1 (3-4 weeks)

Goal: Introduce a first-class mission object and mission-facing UI.

### Dependencies

- None beyond current baseline.

### Workstreams

- Data/contracts:
  - Add `missions`, `mission_steps`, `mission_events`, `mission_artifacts`, `mission_interventions` tables.
  - Define mission lifecycle states and transition validation.
- Main process:
  - Add `missionService` with CRUD + lifecycle transitions.
  - Add mission IPC endpoints and event broadcasts.
- Renderer:
  - Add `Missions` tab for intake, queue, details, and outcomes.
  - Add intervention cards and artifact views.
- Validation:
  - Migration tests for mission schema.
  - Lifecycle transition tests for invalid/valid state moves.

### Exit criteria

- Plain-English mission creation works end-to-end.
- Mission status and artifacts persist across restart.
- Mission interventions are visible and actionable from UI.

---

## Phase 2 — Orchestrator Runtime v1 (4-5 weeks)

Goal: Deterministic execution engine for missions.

### Dependencies

- Phase 1.

### Workstreams

- Data/contracts:
  - Add orchestrator run/step state model linked to missions.
  - Define failure categories and retry metadata.
- Main process:
  - Add `orchestratorService`, executor queue, retry/backoff engine.
  - Implement step adapters for lanes/git/terminals/tests/PRs/packs.
  - Enforce policy checks on every command-executing step.
- Renderer:
  - Mission detail view shows step timeline and live execution state.
  - History overlays show orchestrator-originated events.
- Validation:
  - Step idempotency tests.
  - Resume/retry tests from partial failures.

### Exit criteria

- Missions can execute multi-step workflows with retries.
- Failures are classified and recoverable without state corruption.
- Execution audit trail is queryable in Missions and History surfaces.

---

## Phase 3 — Agent Identities (2-3 weeks)

Goal: Reusable persona/policy profiles for mission execution.

### Dependencies

- Phase 2.

### Workstreams

- Data/contracts:
  - Add identity schema: persona, toolchain defaults, risk/permission policies.
- Main process:
  - Add `agentIdentityService` (CRUD + validation + default preset library).
  - Bind identity policy enforcement into orchestrator execution gates.
- Renderer:
  - Identity management UI in Settings.
  - Mission-level identity selector + effective-policy preview.
- Validation:
  - Policy application tests (identity override precedence).
  - Backward compatibility tests for missions with no explicit identity.

### Exit criteria

- Missions can run with selected identities.
- Identity policy is consistently enforced by orchestrator.
- Identity changes are versioned and auditable.

---

## Phase 4 — Night Shift (2-3 weeks)

Goal: Safe unattended scheduled mission batches.

### Dependencies

- Phases 2 and 3.

### Workstreams

- Data/contracts:
  - Extend automation run model for mission-batch metadata and budget outcomes.
- Main process:
  - Add `nightShiftService` on top of automations.
  - Implement budget caps (time/cost/step count) and stop conditions.
  - Add morning digest artifact generator.
- Renderer:
  - Night Shift preset builder in Automations.
  - Morning digest and intervention queue surfaces.
- Validation:
  - Budget enforcement tests.
  - Unattended failure and stop-condition simulations.

### Exit criteria

- Scheduled mission batches execute unattended with hard guardrails.
- Morning digest consistently summarizes outcomes and pending reviews.
- Night Shift runs can be inspected and audited like manual missions.

---

## Phase 5 — Play Runtime Isolation (5-6 weeks)

Goal: Concurrent lane runtimes without collisions.

### Dependencies

- Phase 2.

### Workstreams

- Data/contracts:
  - Define runtime lease model (port/host/profile allocation and ownership).
- Main process:
  - Add `laneRuntimeService` (lease allocator + lease lifecycle).
  - Add `laneProxyService` (host-to-port routing).
  - Add `previewLaunchService` + optional `browserProfileService`.
  - Add runtime diagnostics + fallback mode.
- Renderer:
  - Add Play controls for isolated preview launch/stop and diagnostics.
- Validation:
  - Multi-lane collision tests.
  - Lease recovery tests on crash/restart.

### Exit criteria

- Multiple lanes run simultaneously with deterministic routing.
- Isolation state is visible and manageable from Play.
- Failures provide actionable fallback paths.

---

## Phase 6 — Integration Sandbox + Merge Readiness (3-4 weeks)

Goal: Validate lane combinations before merge/land.

### Dependencies

- Phase 5.

### Workstreams

- Data/contracts:
  - Define integration sandbox run records and PR gate signals.
- Main process:
  - Add `integrationSandboxService` for ephemeral lane-set composition.
  - Wire conflict merge plans to sandbox execution hooks.
  - Wire PR readiness/landing gates to sandbox results.
- Renderer:
  - Lane-set selection and sandbox run UX in Play/Conflicts.
  - Merge-readiness overlays in PRs and Graph.
- Validation:
  - Lane-set compose/teardown reliability tests.
  - Gate enforcement tests for PR landing flows.

### Exit criteria

- Users can run pre-merge lane-set verification flows.
- PR and conflict readiness signal one shared truth.
- Optional gate enforcement blocks unsafe land operations.

---

## Phase 7 — MCP Server (3-4 weeks)

Goal: Expose ADE capabilities to MCP-compatible clients.

### Dependencies

- Phase 2 minimum (Phase 8 optional but not required).

### Workstreams

- Data/contracts:
  - Define ADE MCP tool contracts and permission envelopes.
- Main/apps:
  - Add `apps/mcp-server` with stdio transport first.
  - Implement tool adapter layer for lanes/sessions/packs/conflicts/PRs/missions.
  - Add request auth + permission checks + call audit logs.
- Docs:
  - Publish setup docs for Codex/Claude/Cursor MCP clients.
- Validation:
  - Tool contract tests + permission denial tests.

### Exit criteria

- External MCP clients can safely query and invoke approved ADE tools.
- Tool calls honor same policy constraints as desktop flows.

---

## Phase 8 — Core Extraction (`packages/core`) (5-7 weeks)

Goal: Decouple core runtime from Electron transport.

### Dependencies

- Phases 2, 5, and 6.

### Workstreams

- Data/contracts:
  - Stabilize transport-neutral service contracts.
- Refactor:
  - Extract core services to `packages/core`.
  - Break `registerIpc.ts` into domain adapters over shared core APIs.
- Validation:
  - Parity tests for desktop adapter vs core behaviors.
  - Regression coverage for hot paths (lanes/pty/git/conflicts/packs).

### Exit criteria

- Core workflows run through transport-agnostic core package.
- Desktop behavior remains functionally equivalent.
- Domain adapters replace monolithic IPC registration structure.

---

## Phase 9 — Relay + Machines (6-8 weeks)

Goal: Remote machine execution with explicit routing and ownership.

### Dependencies

- Phase 8.

### Workstreams

- Data/contracts:
  - Machine identity/capability/heartbeat model.
  - Routing/ownership semantics for mission execution.
- Apps/services:
  - Add `apps/relay` (WS request/response + event streaming).
  - Add machine registry and reconnect semantics.
- Renderer:
  - Add `Machines` tab (health, assignment, sync diagnostics).
  - Add local vs relay execution mode controls.
- Validation:
  - Reconnect and failover tests.
  - Ownership/race-condition tests.

### Exit criteria

- Desktop can target local or relay machines predictably.
- Machine health and assignment are visible and actionable.
- Cross-machine mission state remains consistent under reconnect/failure.

---

## Phase 10 — iOS Control App (4-6 weeks initial)

Goal: Mobile mission control and intervention handling.

### Dependencies

- Phase 9.

### Workstreams

- App:
  - Add SwiftUI shell + relay auth/session handling.
  - Add mission inbox, intervention cards, and outcome summary views.
  - Add pack/PR/conflict summary surfaces.
  - Add push notifications for intervention-required/completed runs.
- Validation:
  - Mobile intervention flow tests.
  - Relay event sync latency and consistency checks.

### Exit criteria

- Users can monitor missions and resolve interventions from iOS.
- Mobile actions are reflected in desktop/relay state in near real time.

---

## Phase 11 — Monetization + Provider Strategy (2-3 weeks)

Goal: Monetize hosted AI while preserving BYOK/CLI-first product value.

### Dependencies

- Stable outputs from phases 1-10.

### Workstreams

- Product/policy:
  - Provider routing policy (Hosted vs BYOK vs CLI fallback).
  - Usage metering and feature-level spend visibility.
  - Free/paid tier limits.
  - Hard-disable hosted mode while keeping mission/orchestrator via BYOK/CLI.
- Validation:
  - Billing policy correctness tests.
  - Fallback parity tests in hosted-disabled mode.

### Exit criteria

- Billing behavior is explicit and user-controllable.
- Core mission value remains accessible without hosted spend.

---

## 7. Sequence and Pull-Forward Rules

Base build order:

1. Phase 1
2. Phase 2
3. Phase 3
4. Phase 4
5. Phase 5
6. Phase 6
7. Phase 7
8. Phase 8
9. Phase 9
10. Phase 10
11. Phase 11

Pull-forward rule:

- Phase 7 (MCP) may be moved earlier (after Phase 2) for integration demand, provided policy/audit requirements are met.

---

## 8. Phase Gate Checklist (Before Next Phase)

Each phase must satisfy:

- Feature behavior validated by automated tests and manual smoke checks.
- No unresolved P0/P1 regressions in lanes/terminals/git/conflicts paths.
- Docs updated: affected feature docs + affected architecture docs + plan references.
- Migration path documented for local DB/state changes.
- Telemetry/audit events emitted for newly introduced execution surfaces.

---

## 9. Primary Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Monolithic IPC concentration | Slows core extraction and relay work | Domain adapter split in Phase 8 with parity test gates |
| Unsafe unattended execution | High blast radius in Night Shift | Hard budgets, explicit policy gates, intervention states |
| Runtime isolation brittleness | Play instability | Deterministic lease model + diagnostics + fallback mode |
| Cross-device race conditions | Inconsistent mission outcomes | Ownership model + optimistic locking + event sequencing |
| Monetization trust erosion | Adoption risk | Keep BYOK/CLI parity and hosted-as-additive policy |

---

## 10. KPI Framework

### Product KPIs

- Mission prompt -> first meaningful action latency
- Mission completion rate without manual recovery
- Pre-merge issue discovery rate before merge attempt
- Integration sandbox pass rate before land
- Mobile intervention completion rate

### Reliability KPIs

- Orchestrator failure classification coverage
- Runtime isolation collision rate
- Relay reconnect success rate
- Conflict prediction false-positive/false-negative trend

### Business KPIs

- Hosted conversion (free -> paid)
- BYOK-only retention
- Mission weekly active users

---

## 11. Program Definition of Done

The program is complete when:

- Missions launch complex workflows from plain language with auditable outcomes.
- Orchestrator executes across lanes/processes/tests/PRs with robust recovery.
- Play supports deterministic lane isolation and integration sandbox verification.
- Automations includes Night Shift with guardrails and reliable morning digests.
- Desktop and iOS can operate against local and relay machine targets.
- MCP safely exposes ADE capabilities to external agent ecosystems.
- Hosted monetization remains optional and BYOK/CLI parity is maintained.
