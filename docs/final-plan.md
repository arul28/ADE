# ADE Final Plan (Canonical Roadmap)

Last updated: 2026-02-18
Owner: ADE
Status: Active (replaces prior planning docs)

---

## 1. Purpose

This file is the single source of truth for all future ADE work.

It **supersedes**:
- `docs/IMPLEMENTATION_PLAN.md`
- `docs/future_plan.md`

All PRD, feature, and architecture docs should reference this file for roadmap sequencing and future-state decisions.

---

## 2. Code-Backed Baseline (What Exists Today)

This baseline is derived from current code in `apps/desktop`.

### 2.1 Current navigation and product surfaces

ADE currently ships 11 nav tabs:
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

### 2.2 Local core capabilities already present

- Lane/worktree orchestration and stacking
- Terminal PTY sessions and transcripts
- File explorer/editor with watchers/search
- Git operations, conflict state handling, merge/rebase continue/abort
- Conflict prediction and merge simulation
- Integration-lane flows in conflicts and PR orchestration
- PR workflows including stacked and integration PR grouping
- Pack pipeline, bounded exports, and orchestrator-oriented summaries
- Automation engine + NL planner (Codex/Claude based)
- Auto-rebase service wiring in IPC

### 2.3 Current architectural reality

- Electron main process is already service-oriented and mostly transport-agnostic.
- IPC contract is broad (`~225` channels in `shared/ipc.ts`), which is strong leverage for relay/MCP work.
- `registerIpc.ts` is large and concentrated; this is a refactor hotspot for relay/core extraction.

### 2.4 Confirmed gaps

Not present yet:
- Dedicated mission runtime (`missionService`)
- Dedicated orchestrator runtime (`orchestratorService`)
- MCP server process
- `packages/core` extraction
- `apps/relay`
- `apps/ios`
- Device/machine registry and routing
- Lane runtime isolation services (`laneRuntimeService`, `laneProxyService`, `browserProfileService`, `previewLaunchService`)

---

## 3. Product North Star

ADE becomes a **state-of-the-art agentic development control plane** that:

1. Uses existing CLI subscriptions (Claude/Codex/etc.) for execution.
2. Uses ADE AI (hosted model layer) as optional interpretation/planning glue.
3. Preserves full BYOK paths so paid ADE AI is optional.
4. Supports desktop + remote machine + mobile control with one consistent model.
5. Treats context continuity (packs, checkpoints, lane memory) as a first-class primitive.

---

## 4. Core Concept Model (Resolve Existing Ambiguity)

### 4.1 Mission vs Orchestrator vs Agent Identity

#### Mission
A **Mission** is a user-facing goal object.
- Input: plain-English intent (e.g., "fix flaky test and open PR").
- Stores: goal, constraints, target repo/lanes, progress, outputs, audit trail.
- Lifecycle: queued -> planned -> running -> blocked -> completed/failed.

#### Orchestrator
The **Orchestrator** is the execution engine.
- Turns a mission plan into concrete operations.
- Spawns/controls CLI sessions, lane actions, tests, PR operations, and pack updates.
- Handles retries, conflict branches, and escalation.

#### Agent Identity
An **Agent Identity** is reusable behavior config.
- Persona + tool policy + risk policy + default workflows.
- Examples: `bug-hunter`, `refactorer`, `docs-writer`, `release-captain`.

### 4.2 Relationship

- Missions call Orchestrator.
- Orchestrator executes via one or more Agent Identities.
- Agent Identities can be used by missions, night-shift jobs, or direct manual launch.

**Short answer to “does one use the other?”**
- Yes: **Mission is the request container, Orchestrator is the runtime that executes it.**

---

## 5. UX Information Architecture (Tabs and Ownership)

### 5.1 Keep current tabs; add two strategic tabs

Keep all 11 existing tabs. Add:
- `Missions` tab
- `Machines` tab

### 5.2 Tab ownership matrix

- Play: process/test execution, runtime isolation, preview launching, integration-sandbox test runs.
- Lanes: branch/worktree structure, stack operations, lane metadata.
- Files: editing and code navigation.
- Terminals: raw/interactive session visibility.
- Conflicts: pre-merge risk, merge simulation, resolver workflows.
- Context: packs, export views, doc generation, handoff artifacts.
- Graph: topology + relation visualization.
- PRs: PR lifecycle and stack/integration landing.
- History: audit trail, mission timeline overlays.
- Automations: rule-based recurring flows, including Night Shift scheduling.
- Missions (new): plain-English mission intake, progress, intervention prompts, outcomes.
- Machines (new): local vs relay machines, health, assignment, sync/routing.
- Settings: providers, safety, billing, policy, identity presets.

### 5.3 Specific resolution of current overlap questions

- Runtime isolation belongs in **Play** (execution surface), not in Lanes.
- Night Shift belongs in **Automations** as a first-class preset/workflow family.
- Stacked PR and integration-lane flows stay in **PRs + Conflicts**, with launch points from Play and Missions.
- Missions are not a replacement for Automations: Missions are ad-hoc goal execution; Automations are recurring triggers.

---

## 6. Competitive Strategy (OpenClaw and Similar Tools)

ADE’s wedge:
- Execution on users’ existing CLI subscriptions where policy allows.
- Stronger local context memory and lane-aware tracking than stateless API wrappers.
- Deep integration with lane/stack/conflict/PR graph already in product.

### 6.1 “Always-running agents” strategy

Implement practical persistence, not fake persistence:
- Mission and agent state persisted in SQLite + packs + events.
- Resume execution from checkpoints.
- Event-trigger wakeups (commit/schedule/manual/webhook).
- Optional long-running worker mode when connected to relay.

This reproduces “always-on” behavior without requiring continuously burning API calls.

---

## 7. Program Roadmap (Detailed)

## Phase A — Foundation Alignment (2 weeks)

Goal: remove roadmap ambiguity and prepare code boundaries.

### Tasks
- A-001: Adopt this file as canonical roadmap reference in PRD/architecture/features.
- A-002: Replace old plan docs with deprecation pointers.
- A-003: Create `roadmapAlignment` section in key feature docs (Run, Automations, PRs, Conflicts).
- A-004: Add architecture “transport boundary” docs for future relay/MCP extraction.
- A-005: Add instrumentation plan for mission/orchestrator metrics.

### Exit criteria
- No conflicting plan sources remain.
- All primary docs point to this plan.

---

## Phase B — Mission System v1 (3-4 weeks)

Goal: plain-English task launch with structured lifecycle tracking.

### New services
- `missionService`
- `missionStore` (SQLite tables)
- `missionEventService`

### Data model
- `missions`
- `mission_steps`
- `mission_events`
- `mission_artifacts`
- `mission_interventions`

### Tasks
- B-001: Mission schema + migrations.
- B-002: Mission CRUD API + IPC channels.
- B-003: Mission planner adapter (ADE AI optional, BYOK fallback).
- B-004: Mission view in new Missions tab.
- B-005: Mission linkage to lane IDs, session IDs, PR IDs, pack keys.
- B-006: Intervention state machine (needs user input / approval).

### Exit criteria
- User can submit plain-English mission, observe status, and view outputs/end state.

---

## Phase C — Orchestrator Runtime v1 (4-5 weeks)

Goal: deterministic execution engine for missions.

### New services
- `orchestratorService`
- `orchestratorQueue`
- `orchestratorPolicyService`

### Tasks
- C-001: Step executor framework (lane ops, git ops, terminal ops, tests, PR ops).
- C-002: Policy-aware command execution (permissions, bypass guardrails).
- C-003: Retry/backoff model and failure classification.
- C-004: Checkpoint + pack update hooks after each meaningful step.
- C-005: Mission-to-orchestrator binding (one mission can spawn N sessions).
- C-006: Orchestrator status events to History and Missions tabs.

### Exit criteria
- Missions can execute end-to-end across multiple ADE subsystems with recoverable failures.

---

## Phase D — Agent Identities + Night Shift (3 weeks)

Goal: reusable “agent personas” and scheduled off-hours execution.

### New services
- `agentIdentityService`
- `nightShiftService` (built on automation engine)

### Tasks
- D-001: Agent Identity schema (persona, policies, default toolchain).
- D-002: Identity assignment per mission and per automation rule.
- D-003: Night Shift preset builder in Automations tab.
- D-004: Budget guardrails (credit/time caps, stop conditions).
- D-005: Morning digest generation (what was done, what needs review).
- D-006: Swipe queue concept prototype (mobile-friendly triage feed).

### Exit criteria
- User can schedule nightly mission batches with explicit budget and wake up to a reviewable summary.

---

## Phase E — Runtime Isolation + Integration Sandbox (Play Tab) (5-6 weeks)

Goal: run many lanes simultaneously and test pre-merge combinations safely.

### New services
- `laneRuntimeService`
- `laneProxyService`
- `browserProfileService`
- `previewLaunchService`
- `integrationSandboxService`

### Tasks
- E-001: Deterministic port allocator with lane/process leases.
- E-002: Lane hostname strategy (stable hostnames per lane).
- E-003: Local reverse proxy with host-to-port routing.
- E-004: Preview launcher API and Play tab controls.
- E-005: Optional lane-bound browser profiles.
- E-006: Integration Sandbox: compose selected lanes into ephemeral integration lane.
- E-007: “Test lane set” workflow (e.g., 4 lanes -> integration workspace -> run test matrix).
- E-008: SST-specific helpers for stage safety and environment diff checks.
- E-009: Failure diagnostics + one-click fallback mode when isolation fails.

### Exit criteria
- 3+ lanes can run concurrent services without collisions.
- User can test combined lane sets pre-merge from Play.

---

## Phase F — PR/Conflict Integration Maturity (2-3 weeks)

Goal: unify stacked PR, integration lane, and testing handoff.

### Tasks
- F-001: PR creation wizard supports "stacked" and "integration" flows with explicit test gates.
- F-002: Conflict merge-plan links directly to Integration Sandbox test runs.
- F-003: Land-stack enhanced flow requires optional integration-sandbox pass.
- F-004: Graph overlays for merge readiness + unresolved integration blockers.

### Exit criteria
- Stack + integration workflows are coherent and test-gated before merge.

---

## Phase G — MCP Server (3-4 weeks)

Goal: make ADE consumable as infrastructure by any MCP-compatible agent.

### New services/apps
- `apps/mcp-server`
- `mcpToolAdapter`

### Tasks
- G-001: Define ADE MCP tool spec from existing service capabilities.
- G-002: Implement stdio transport first; SSE/WebSocket second.
- G-003: Tool categories: lanes, packs, conflicts, sessions, PRs, missions.
- G-004: Auth and local permission model for MCP calls.
- G-005: Packaging and configuration docs for Claude/Codex/Cursor clients.

### Exit criteria
- External agents can reliably call ADE tools against live project state.

---

## Phase H — Core/Relay Extraction + Device Connectivity (6-8 weeks)

Goal: run ADE brain remotely and control from desktop/mobile.

### New packages/apps
- `packages/core`
- `apps/relay`

### Tasks
- H-001: Extract main services into `packages/core` with no Electron dependency.
- H-002: Replace giant IPC registration with modular transport adapters.
- H-003: WebSocket relay protocol (request/response + event streaming).
- H-004: Token auth, machine heartbeat, reconnect semantics.
- H-005: Desktop remote-mode switch (local/relay).
- H-006: Device sync diagnostics and out-of-sync warnings.

### Exit criteria
- Desktop can fully operate against remote relay with equivalent behavior.

---

## Phase I — iOS App (4-6 weeks initial)

Goal: mission control + terminal interaction from phone without terminal-heavy UX.

### Tasks
- I-001: SwiftUI shell + relay connection/auth.
- I-002: Missions inbox and intervention cards.
- I-003: Session views: conversation mode first, raw mode second.
- I-004: Pack + PR + conflict summary views.
- I-005: Push notifications for intervention-required and completion events.

### Exit criteria
- User can launch/monitor missions, respond to prompts, and approve operations from iOS.

---

## Phase J — Monetization + Provider Strategy (2-3 weeks)

Goal: monetize ADE AI while preserving BYOK and local execution value.

### Principles
- ADE AI should be optional, never hard-required for core workflows.
- BYOK must remain first-class.
- Existing CLI-subscription execution remains a product differentiator.

### Tasks
- J-001: Provider routing policy (ADE AI vs BYOK vs CLI-only fallback).
- J-002: Free tier meter for ADE AI (monthly message/task budget).
- J-003: Paid tiers (higher limits, priority, team features).
- J-004: Cost controls and per-feature usage visibility.
- J-005: Hard-disable ADE AI mode while preserving mission/orchestrator flow via BYOK/CLI.

### Exit criteria
- Billing is understandable, optional, and does not lock users out of core product value.

---

## 8. Blockers and Risks (From Current Code Reality)

### BKR-1: Monolithic IPC registration
- Current state: `registerIpc.ts` is large and high-coupling.
- Risk: slows extraction to `packages/core` and relay transport.
- Mitigation: split by subsystem + auto-registration map.

### BKR-2: Permission bypass surface
- Current state: planner and some flows expose bypass modes.
- Risk: unsafe defaults if orchestration is automated at scale.
- Mitigation: strict policy layer, environment checks, approval gates.

### BKR-3: Docs drift vs shipped behavior
- Current state: PRD and architecture counts/scopes are stale.
- Risk: roadmap confusion and wrong implementation assumptions.
- Mitigation: this plan as canonical + alignment tasks in Phase A.

### BKR-4: Runtime isolation complexity
- Current state: no port/host lease manager yet.
- Risk: non-deterministic collisions and brittle preview UX.
- Mitigation: deterministic allocator + proxy + diagnostics first.

### BKR-5: Multi-device consistency
- Current state: no relay/machine graph yet.
- Risk: conflicting actions from phone/desktop/remote workers.
- Mitigation: machine ownership, optimistic locking, event-sourced mission state.

---

## 9. KPI Framework

### Product KPIs
- Time from mission prompt to first meaningful action.
- Mission completion rate without manual recovery.
- Pre-merge conflict discovery rate (before PR merge attempt).
- Multi-lane integration test pass rate before main merge.
- Mobile intervention success rate (user resolves prompt from phone).

### Reliability KPIs
- Orchestrator step failure classification coverage.
- Relay reconnect success rate.
- Runtime isolation collision rate.
- False positive rate in conflict/risk predictions.

### Business KPIs
- ADE AI conversion (free -> paid).
- BYOK retention (users active without ADE AI spend).
- Mission weekly active users.

---

## 10. Execution Order Recommendation

If only a subset can be built now, prioritize:

1. Phase A (alignment)
2. Phase B + C (missions + orchestrator runtime)
3. Phase E (runtime isolation + integration sandbox)
4. Phase D (night shift + identities)
5. Phase H + I (relay + iOS)
6. Phase G (MCP server) can be pulled earlier if partner/integration demand is high.

---

## 11. Definition of Done (Program)

ADE is considered complete for this plan when:
- Missions can launch complex workflows from plain language and complete with audit trails.
- Orchestrator reliably executes across lanes/processes/tests/PRs with recovery.
- Play tab supports deterministic lane runtime isolation and integration-sandbox testing.
- Automations provides Night Shift with clear budget and digest behavior.
- Desktop and iOS can operate against local or relay machine targets.
- MCP allows external agent ecosystems to consume ADE tools safely.
- ADE AI monetization is optional and BYOK parity is maintained.

