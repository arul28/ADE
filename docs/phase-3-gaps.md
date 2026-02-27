# Phase 3 Completion Blueprint: Autonomous Orchestrator + Team Foundations

Last updated: 2026-02-27

This document replaces the old "gap list" with an execution blueprint for finishing Phase 3.

Goal: make Missions truly autonomous while keeping deterministic code limited to safety, durability, and auditability.

## 1) Product Positioning (Decision)

ADE orchestrator should behave like a real engineering lead:

- AI decides planning, delegation, re-planning, validation loops, and role assignment.
- Runtime enforces only hard boundaries: permissions, budgets, state integrity, lane ownership, and audit trails.
- Human is pulled in for high-risk actions or unresolved ambiguity.

Non-goal: deterministic if/else logic deciding strategy in place of AI reasoning.

## 2) Best Practices Adopted from Factory Missions

Primary reference: https://factory.ai/news/missions

The following patterns from Factory Missions should be adopted in ADE:

1. Milestone checkpoints with mandatory validation before moving forward.
2. Fresh worker contexts scoped to features, instead of one giant long-running worker context.
3. Targeted parallelism (parallel where coordination overhead is low), not broad parallel fan-out everywhere.
4. Planning as a conversation with clarifying questions before execution approval.
5. Role-specialized execution (orchestrator, implementers, validators, research), with model-per-role routing.
6. Risk-classified command execution with clear audit logs.

## 3) Verified Current State vs Remaining Gaps

This section reflects the real implementation status in ADE as of 2026-02-27.

### 3.1 Mostly Implemented

- Dynamic worker spawning exists and is coordinator-driven.
- Inter-agent message routing and MissionChatV2 are shipped.
- Smart fan-out/meta-reasoner exists.
- Worker/file claim checks and conflict prevention foundations exist.
- Retry/recovery and compaction-based resume exist.
- Concurrency and token guardrails exist at runtime.

### 3.2 Still Missing for True Autonomy

1. Worker-to-coordinator structured reporting and mission-status read tools.
2. Explicit autonomous `revise_plan` with supersede semantics.
3. Validation contracts and validator loop as first-class runtime concept.
4. Mission team model (roles + policy) that constrains orchestration behavior.
5. Budget pressure as an active decision input for coordinator tools.
6. Standardized partial completion semantics (`partially_completed`).
7. Mission-level tool profile + MCP profile selection per worker.
8. Provider-neutral permission/error normalization (Claude/Codex differences hidden from mission logic).

## 4) Decisions from Current Product Discussion

### 4.1 Worker autonomy without chaos ("employee asks boss")

Workers should not spawn unlimited sub-workers directly. They should request specialization and let the coordinator decide.

Decision:

- Add worker request tool: `request_specialist`.
- Coordinator approves/rejects/spawns based on mission context and budget.
- Request payload must include why current worker should not continue alone.

### 4.2 Validator role behavior

Validator is a mission role, not an always-running process.

Decision:

- Validator workers are spawned at gates:
  - step gate (optional by step type),
  - milestone gate (required),
  - mission gate (required).
- Validator returns structured pass/fail + remediation instructions.
- Coordinator decides rework routing.

### 4.3 Team model framing

Team should describe role capabilities and policy defaults, not fixed worker count.

Decision:

- Team = role blueprint.
- Workers = runtime instances of roles.
- Multiple workers can be spawned from one role (for example, multiple implementers).

Required system roles for autonomous coding missions:

1. Coordinator
2. Planner capability
3. Validator capability

Optional roles:

- Implementer
- Tester
- Reviewer
- Researcher
- Security specialist

### 4.4 Mission policy flags

Policy belongs to mission execution, with team defaults.

Decision: precedence order

1. Workspace/org hard policy (non-overridable)
2. Team template defaults
3. Mission launch overrides

Required first policy flags:

- `clarification_mode` (`always`, `auto_if_uncertain`, `off`)
- `max_clarification_questions`
- `strict_tdd`
- `require_validator_pass`
- `max_parallel_workers`
- `risk_approval_mode`

### 4.5 Agents tab vs Missions tab

Decision:

- Agents tab remains a reusable capability surface (identities, resident agents, presets).
- Missions tab remains runtime orchestration and team assembly for a specific mission.
- They are linked, not merged.

### 4.6 Lane continuity for rework

Decision:

- A step owns a lane.
- Rework remains on same lane by default.
- Worker replacement inherits lane + prior context.
- Lane transfer is explicit coordinator action only.

### 4.7 Human-in-loop and provider parity

Decision:

- Keep clarifying questions before plan approval as first-class behavior.
- Normalize provider-specific tool/permission errors into one internal error schema.
- Interventions and approvals should use one UI contract regardless of provider.

## 5) Phase 3 Completion Workstreams

These workstreams define how to finish Phase 3 before broad Phase 4 expansion.

### P3-W13: Mission Team Runtime Foundations

Deliverables:

1. Team template schema (roles + defaults + constraints)
2. Required-role enforcement (coordinator/planner/validator)
3. Runtime role binding and role-aware spawn rules

### P3-W14: Worker Reporting + Shared Mission Visibility

Deliverables:

1. Worker tool: `report_status`
2. Worker tool: `report_result`
3. Worker tool: `read_mission_status`
4. Worker tool: `message_worker`
5. Structured chat events in Missions UI

### P3-W15: Autonomous Replanning Contract

Deliverables:

1. Coordinator tool: `revise_plan`
2. Supersede semantics for replaced steps
3. Replan triggers based on repeated failures/staleness
4. Replan audit trail in timeline and DAG

### P3-W16: Validation Contracts + Validator Loop

Deliverables:

1. Step/milestone validation contract schema
2. Validator role runtime + validation outputs
3. Rework loop protocol (same worker vs replacement worker)
4. Mission-complete gate requiring validator pass

### P3-W17: Lane Affinity + Rework Continuity

Deliverables:

1. Step-lane ownership contract
2. Replacement worker lane inheritance
3. Conflict-safe handoff artifacts (summary, changed files, failed checks)

### P3-W18: Budget-Aware Orchestration Decisions

Deliverables:

1. Coordinator tool: `get_budget_status`
2. Spawn gating under budget pressure
3. Dynamic parallelism reduction under pressure
4. Per-worker token/cost visibility in coordinator context

### P3-W19: Tool Profile Runtime + Mission-Level MCP Selection

Deliverables:

1. Mission tool profile schema
2. Worker spawn with role/tool profile binding
3. Optional mission-level MCP profile injection
4. Mid-run tool profile update support for coordinator

### P3-W20: Human-in-Loop Upgrade

Deliverables:

1. Clarifying-question phase before plan approval
2. Risk-based approval dialogs for high-impact actions
3. Worker `request_user_input` routed through coordinator
4. Explicit pause/resume control parity across UI + runtime

### P3-W21: Partial Completion and Recovery Handoff

Deliverables:

1. `partially_completed` mission status
2. Structured "what is done vs pending" artifact
3. Recovery handoff when coordinator fails permanently

### P3-W22: Validation and Soak Testing

Deliverables:

1. Long-horizon mission soak tests (multi-hour, multi-day simulation)
2. Validation-loop correctness tests
3. Team-policy precedence tests
4. Provider parity tests for permission/tool error normalization

## 6) Delivery Order

Recommended order:

1. P3-W14 (worker reporting)
2. P3-W13 (team runtime foundations)
3. P3-W16 (validation contracts/validator loop)
4. P3-W15 (autonomous replanning)
5. P3-W17 (lane continuity)
6. P3-W18 (budget-aware decisions)
7. P3-W19 (tool profiles)
8. P3-W20 (HITL upgrade)
9. P3-W21 (partial completion)
10. P3-W22 (soak + parity validation)

## 7) Exit Criteria for "Phase 3 Complete"

Phase 3 is only complete when:

1. Workers can report status/results structurally and read mission status.
2. Coordinator can autonomously revise plan with auditable supersede behavior.
3. Every milestone and final mission stage passes validator contracts.
4. Team template + mission policy model governs orchestration behavior.
5. Rework routing preserves lane continuity by default.
6. Budget pressure actively changes orchestration behavior.
7. Mission outcomes include `partially_completed` where appropriate.
8. Provider differences are normalized behind one runtime error/approval contract.

## 8) What Moves to Phase 4 After This

After these foundations are complete in Phase 3, Phase 4 focuses on:

- Agents tab productization and builder UX
- Night Shift, Watcher, Review, Concierge flows
- Memory system expansion and learning-pack product features
- Cross-surface agent management and external ecosystem integration
