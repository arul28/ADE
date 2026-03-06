# Phase 3: AI Orchestrator + Missions Overhaul

> **SUPERSEDED** — For all current and remaining Phase 3 work, see **`docs/ORCHESTRATOR_OVERHAUL.md`** (2026-03-04).
>
> This file contains historical planning context and design rationale. It is **not authoritative** for:
> - Executor/provider implementation (now unified, legacy adapters deleted)
> - Orchestrator runtime contracts (now `modelId`-first, class-based permissions)
> - Remaining work items (Phases 4-7 in ORCHESTRATOR_OVERHAUL.md supersede Tasks 7-8 here)
> - Legacy status semantics (`partially_completed`, `succeeded_with_risk`) that were removed in ORCHESTRATOR_OVERHAUL Phases 5-6
>
> Tasks 1-6 below accurately reflect what shipped. Tasks 7-8 are superseded by ORCHESTRATOR_OVERHAUL.md Phases 4-7.

**Status**: Tasks 1-6 Complete, Tasks 7-8 superseded by ORCHESTRATOR_OVERHAUL.md
**Dependencies**: Phases 1-2 complete (Agent SDKs, AgentExecutor, MCP server)
**Last updated**: 2026-03-04

## Overview

Phase 3 delivers two things: (1) autonomous orchestration foundations that make missions truly self-directed, and (2) a missions overhaul that externalizes the fixed internal pipeline into user-configurable phase cards. When complete, ADE missions will behave like a real engineering lead — planning, delegating, validating, re-planning, and escalating — with the human pulled in only for high-risk actions or unresolved ambiguity.

### External References

- [Factory.ai Missions](https://factory.ai/news/missions) — milestone validation, targeted parallelism, planning clarifications, role-specialized execution, skill-based learning
- [Claud-ometer](https://github.com/deshraj/Claud-ometer) — subscription usage tracking via local `~/.claude/` session data

### Reference Docs

- [AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — orchestrator architecture, planning, execution, context management
- [MISSIONS.md](../features/MISSIONS.md) — mission lifecycle, step DAG, interventions, artifacts
- [CONTEXT_CONTRACT.md](../architecture/CONTEXT_CONTRACT.md) — context delivery, export tiers
- [AUTOMATIONS.md](../features/AUTOMATIONS.md) — automation rules (Night Shift absorbed here in Phase 4)
- [ONBOARDING_AND_SETTINGS.md](../features/ONBOARDING_AND_SETTINGS.md) — phase profile management, AI usage dashboard
- [SECURITY_AND_PRIVACY.md](../architecture/SECURITY_AND_PRIVACY.md) — trust model for unattended execution
- [SYSTEM_OVERVIEW.md](../architecture/SYSTEM_OVERVIEW.md) — type system architecture, shared utilities, orchestrator decomposition
- [DATA_MODEL.md](../architecture/DATA_MODEL.md) — TypeScript types architecture
- [UI_FRAMEWORK.md](../architecture/UI_FRAMEWORK.md) — component decomposition tables
- [DESKTOP_APP.md](../architecture/DESKTOP_APP.md) — updated service graph

---

## What's Shipped

Phase 3 has already delivered 20+ workstreams across four waves. The orchestrator is operational — it plans, spawns workers, executes multi-lane missions, recovers from failures, and provides real-time observability. A major codebase refactoring (Wave 4) decomposed the orchestrator, pack service, type system, and frontend into modular architectures. Tasks 1-6 are now in baseline; remaining work is focused on reflection protocol and full integration soak coverage.

### Wave 1: Core Orchestrator (W1-W12)

AI orchestrator service with Claude leader session and MCP tools. Historical pre-mission planner references in this section are superseded by the current built-in planning phase runtime. PR strategies replacing the old merge phase (`integration` | `per-lane` | `queue` | `manual`). Multi-agent team synthesis with parallel lane provisioning. Recovery loops with heartbeat monitoring and stale attempt detection. Gate evaluator for step/mission completion. Execution plan preview with approval gates. Inter-agent messaging (`sendAgentMessage` IPC). Activity feed with category dropdown. Mission workspace with missionId-filtered queries. Per-mission model selection with thinking budgets. Context packs for progressive orchestrator memory.

### Wave 2: Project Hivemind (HW1-HW8, shipped 2026-02-25)

Evolved the orchestrator into an intelligent multi-agent system. Slack-like mission chat (`MissionChatV2.tsx`) with sidebar channels, @mentions, real-time updates. Inter-agent message delivery to PTY and SDK agents. Shared facts, project memories, and run narrative injected into agent prompts. Smart fan-out via meta-reasoner with dynamic step injection. Context compaction engine (70% threshold, pre-compaction writeback, transcript JSONL, attempt resume). Memory architecture with promotion flow (candidate/promoted/archived), agent identities table, Context Budget Panel. Activity narrative in mission detail.

### Wave 3: Model System & Dynamic Pricing (shipped 2026-03-01)

Model registry expansion to 40+ models across 8 provider families with auth-type classification (`cli-subscription`, `api-key`, `openrouter`, `local`). Runtime enrichment via `enrichModelRegistry()` with models.dev API integration (`modelsDevService.ts`: fetch, 6h cache, fallback to hardcoded pricing). Provider options rewrite to pure tier-string passthrough (`providerOptions.ts`) -- no more invented token budgets. Reasoning tiers standardized per provider (Claude CLI: low/medium/high; Claude API: low/medium/high/max; Codex: minimal/low/medium/high/xhigh). UnifiedModelSelector redesigned to group by auth type, hide unavailable models, and link to Settings. Universal tools (`universalTools.ts`) for API-key and local models with permission modes (plan/edit/full-auto). Middleware layer (`middleware.ts`) for logging, retry, cost guard, and reasoning extraction. GPT-5.3 Codex Spark model support. Orchestrator call types simplified from 6 to 2 (coordinator, chat_response).

### Wave 4: Codebase Refactoring & Modularization (shipped 2026-03-02)

Major structural cleanup targeting long-term maintainability and extraction readiness (Phase 7). Net result: 27 files changed, -14,370 lines, 0 TypeScript errors.

**AI Orchestrator decomposition**: `aiOrchestratorService.ts` reduced from 13,210 to 7,677 lines (42% reduction) by extracting 9 domain-specific modules: `chatMessageService.ts` (1,849 lines, chat/messaging), `workerDeliveryService.ts` (1,329 lines, inter-agent delivery), `workerTracking.ts` (1,087 lines, worker state management), `missionLifecycle.ts` (1,045 lines, mission run management), `recoveryService.ts` (412 lines, failure recovery), `modelConfigResolver.ts` (181 lines, model resolution), `orchestratorQueries.ts` (757 lines, DB queries/normalizers), `stepPolicyResolver.ts` (338 lines, step policy resolution), `orchestratorConstants.ts` (115 lines, runtime constants). All modules share state through an `OrchestratorContext` object. The deterministic `orchestratorService.ts` was also reduced from 9,285 to 8,313 lines.

**Pack service decomposition**: `packService.ts` reduced from 5,728 to 3,176 lines (45% reduction) by extracting `packUtils.ts`, `projectPackBuilder.ts`, `missionPackBuilder.ts`, and `conflictPackBuilder.ts`.

**Type system modernization**: The monolithic `src/shared/types.ts` (5,740 lines) was replaced by `src/shared/types/` directory with 17 domain-scoped modules (`core.ts`, `missions.ts`, `orchestrator.ts`, `models.ts`, `lanes.ts`, `git.ts`, `prs.ts`, `conflicts.ts`, `packs.ts`, `sessions.ts`, `chat.ts`, `config.ts`, `files.ts`, `automations.ts`, `budget.ts`, `usage.ts`) plus a barrel `index.ts`. Existing imports continue to work unchanged. 16 dead types were deleted.

**Frontend decomposition**: `MissionsPage.tsx` reduced from 5,637 to 2,225 lines (60% reduction, 8 extracted components). `WorkspaceGraphPage.tsx` reduced from 4,830 to 4,139 lines (11 extracted files).

**Shared utilities**: Backend `src/main/services/shared/utils.ts` replaced 60+ duplicate utility functions. Frontend `src/renderer/lib/format.ts`, `shell.ts`, `sessions.ts` consolidated common renderer utilities. Model system unified around `modelRegistry.ts` as single source of truth with pricing fields, with `modelProfiles.ts` deriving from registry instead of maintaining parallel lists.

### What's Still Missing

1. **Strategic autonomy hardening**: Coordinator autonomy primitives are in place, but broader multi-hour soak coverage and regression gates are still pending.
2. **Tiered validation**: Superseded by `docs/ORCHESTRATOR_OVERHAUL.md` — Phase 5 shipped strict runtime-enforced validation (`self` + `dedicated`, no sampled `spot-check`, no risk-bypass completion).
3. **Reflection protocol**: Agents do not yet capture structured observations for system self-improvement (Task 7).
4. **Full integration soak coverage**: Task 8 multi-hour autonomy/overhaul validation is not complete yet.

---

## Design Principles

These principles govern all remaining Phase 3 work.

1. **AI decides strategy, runtime enforces boundaries.** The orchestrator decides planning, delegation, re-planning, validation loops, and role assignment. The runtime enforces permissions, budgets, state integrity, lane ownership, and audit trails. No deterministic if/else logic should decide strategy in place of AI reasoning.

2. **Milestone validation before moving forward** (Factory.ai). Every milestone boundary requires validation. No skipping ahead just because the worker says it's done.

3. **Fresh worker contexts scoped to features** (Factory.ai). Workers get focused contexts, not one giant long-running session. Milestone completion triggers context compaction.

4. **Targeted parallelism, not broad fan-out** (Factory.ai). Parallel where coordination overhead is low. The meta-reasoner already handles this.

5. **Planning as a conversation** (Factory.ai). Clarifying questions before execution approval. The orchestrator asks before committing to expensive work.

6. **Role-specialized execution** (Factory.ai). Orchestrator, implementers, validators, researchers — each with appropriate model routing.

7. **Phases are guides, not hard-coded types.** A phase card's `instructions` field tells the orchestrator what to do. The orchestrator reads the instructions and decides how to act. Phase names like "Planning" or "Testing" are conventions — any phase can use any orchestrator capability.

8. **One orchestrator, no sub-orchestrators.** Workers can spawn sub-workers internally if needed, but there's only one coordinator. Workers that need specialization use `request_specialist` and let the coordinator decide.

9. **Per-phase model selection applies to workers only.** The orchestrator stays on one pre-selected model for the entire mission. Each phase card specifies which model its workers use.

---

## Task 1-2 Implementation Snapshot (2026-02-27)

Task 1 and Task 2 are implemented in the runtime baseline. This section records the contract so later phases do not regress autonomy.

### Delivered in Task 1 (Orchestrator Autonomy Core)

- **Team runtime foundations**:
  - Team template and role definition schema is live in `src/shared/types/` domain modules and runtime config.
  - Required role-capability enforcement is active at run boot (coordinator/planner/validator capabilities must exist).
  - Role-aware specialist spawning is available through `request_specialist`.
- **Structured worker reporting**:
  - `report_status`, `report_result`, `report_validation`, `read_mission_status`, and `message_worker` are live coordinator tools.
  - Mission status reads include active/completed steps, per-worker report snapshots, staleness signals, and open validation obligations.
- **Autonomous replanning**:
  - `revise_plan` supports partial/full replans with supersede semantics (`superseded`, not delete).
  - Replan changes are emitted to timeline/runtime events for DAG + audit visibility.
  - **Important autonomy boundary**: runtime does not auto-infer dependency rewires; coordinator must provide explicit `dependencyPatches`.
- **Tool profile runtime**:
  - Role-scoped tool profiles are mutable mid-run via `update_tool_profiles`.
- **Partial completion and recovery (historical design; superseded)**:
  - Mission status `partially_completed` was proposed in this phase plan but is now removed from active runtime contracts.
  - Recovery handoff artifacts remain relevant; status semantics were simplified in ORCHESTRATOR_OVERHAUL.

### Delivered in Task 2 (Validation & Lane Continuity)

- **Validation contracts**:
  - `ValidationContract` is represented at step metadata level and surfaced via mission status reads.
  - Validation outcomes are persisted through `report_validation`.
- **Validator loop primitives**:
  - Validators publish structured pass/fail findings and remediation through runtime tools.
  - Runtime tracks open obligations; coordinator owns routing/retry/escalation decisions.
- **Lane continuity**:
  - Replacement workers can inherit lane ownership plus structured handoff package.
  - Explicit lane transfer is available only through coordinator `transfer_lane`, with timeline + handoff audit trail.
  - Supersede/rework flows preserve step history rather than mutating history in place.

---

## Key Decisions

These decisions were made during product discussions and are binding for implementation.

### Team Model

- Team = role blueprint (capabilities and policy defaults, not fixed worker count).
- Workers = runtime instances of roles. Multiple workers can be spawned from one role.
- Roles are bound to phases at runtime: a phase card declares which roles participate and what validation gates apply.
- Required system roles: **Coordinator**, **Planner** (capability), **Validator** (capability).
- Optional roles: Implementer, Tester, Reviewer, Researcher, Security Specialist.

### Mission Policy Flags

Precedence order (highest wins):
1. Workspace/org hard policy (non-overridable)
2. Team template defaults
3. Mission launch overrides

These are configurable per-phase-card — different phases can enforce different policies.

| Flag | Values | Default |
|---|---|---|
| `clarification_mode` | `always`, `auto_if_uncertain`, `off` | `auto_if_uncertain` |
| `max_clarification_questions` | number | 5 |
| `strict_tdd` | boolean | false |
| `require_validator_pass` | boolean | true |
| `max_parallel_workers` | number | 4 |
| `risk_approval_mode` | `auto`, `confirm_high_risk`, `confirm_all` | `confirm_high_risk` |

### Worker Autonomy ("Employee Asks Boss")

Workers should not spawn unlimited sub-workers directly. They request specialization via `request_specialist` and the coordinator approves/rejects/spawns based on mission context and budget. Request payload must include why the current worker should not continue alone.

### Validator Behavior

Validator is a mission role, not an always-running process. Validator workers are spawned at gates:
- Step gate (optional by step type)
- Milestone gate (required)
- Mission gate (required)

Validator returns structured pass/fail + remediation instructions. Coordinator decides rework routing.

### Lane Continuity

- A step owns a lane. Rework remains on the same lane by default.
- Worker replacement inherits lane + prior context.
- Lane transfer is an explicit coordinator action only, logged in the timeline.

### Product Surface

- **Agents tab is removed.** Missions tab is the sole surface for development orchestration.
- **CTO tab** provides persistent project-aware assistance (Phase 4).
- **Night Shift** is absorbed into Automations as a scheduling mode (Phase 4).

---

## Core Concept: Configurable Mission Phases

Missions in earlier waves use a fixed internal pipeline (plan → implement → test → validate → PR). Phase 3 externalizes this into user-visible, configurable **phase cards** that define what the mission does, in what order, with what models, and under what budget.

```
Mission Pipeline = PhaseCard[] + Profile + ValidationGates + BudgetEnvelope
```

### Phase Card Data Model

```typescript
interface PhaseCard {
  id: string;
  name: string;                     // e.g., "Development", "Testing", "Validation"
  description: string;              // Human-readable description
  instructions: string;             // Prompt instructions injected into agent context
  model: {
    provider: 'claude' | 'codex';
    model: string;                  // e.g., "opus", "sonnet", "gpt-5.3-codex"
    reasoningEffort?: string;       // "low" | "medium" | "high"
  };
  budget: {
    maxTokens?: number;             // Token budget for this phase
    maxTimeMs?: number;             // Wall-clock time limit
    maxSteps?: number;              // Max mission steps in this phase
  };
  orderingConstraints: {
    mustBeFirst?: boolean;          // e.g., Development
    mustFollow?: string[];          // Phase IDs that must precede this
    mustPrecede?: string[];         // Phase IDs that must follow this
    canLoop?: boolean;              // Can loop back to a previous phase
    loopTarget?: string;            // Phase ID to loop back to
  };
  askQuestions: {
    enabled: boolean;
    mode: 'always' | 'auto_if_uncertain' | 'never';
    maxQuestions?: number;
  };
  validationGate: {
    tier: 'none' | 'self' | 'dedicated';
    required: boolean;              // Must pass to proceed
    criteria?: string;              // Custom validation criteria
  };
  isBuiltIn: boolean;               // Non-deletable but configurable
  isCustom: boolean;
  position: number;                  // For drag-and-drop ordering
  createdAt: string;
  updatedAt: string;
}
```

### Pre-Mission Planning

Historical note (superseded): this document originally described a dedicated pre-mission planner. The active runtime model now treats planning as a built-in mission phase (`planning`) that runs inside orchestrator execution and transitions explicitly to `development`.

### Built-In Phases

These ship with ADE. Users can configure but not delete them.

| Phase | Description | Constraints | Default Model | Default Validation |
|---|---|---|---|---|
| **Development** | Execute the plan — spawn workers, write code, run tools | Must be first | Codex | Spot-check |
| **Testing** | Run test suites, validate code quality | Flexible (before or after Dev) | Claude Sonnet | Dedicated |
| **Validation** | Review completed work against original requirements and plan | Must follow Development | Claude Sonnet | Dedicated |
| **PR & Conflict Resolution** | Create PRs, handle merge conflicts, rebase | Must be last | Claude Sonnet | Self |

### Flexible Ordering

- Testing can be placed **before** Development (TDD workflow) or **after** (traditional).
- Custom phases can be inserted at any position that satisfies their ordering constraints.
- The UI enforces constraints in real-time during drag-and-drop: invalid positions are visually disabled with tooltip explaining why.

### Phase Profiles

Reusable configurations defining which phases run in what order.

```typescript
interface PhaseProfile {
  id: string;
  name: string;                     // "Default", "TDD", "Security-Focused"
  description: string;
  phases: PhaseCard[];              // Ordered list
  isBuiltIn: boolean;
  isDefault: boolean;               // Used when no override specified at launch
  createdAt: string;
  updatedAt: string;
}
```

**Built-in profiles**: Default (Development → Testing → Validation → PR), TDD (Testing → Development → Validation → PR).

**Profile management** lives in Settings → Missions → Phase Profiles. Create/edit/clone/delete. Set default. Import/export as JSON. Profiles can also be stored in `.ade/profiles/` for version-controlled sharing.

**Per-mission override**: At mission launch, select a profile. Then optionally add/remove/reorder phases for this specific mission without changing the saved profile. Overrides are stored with the mission record.

### Phase Execution

The orchestrator reads the phase card sequence and executes each phase in order:

1. Read the current phase card's instructions and inject them into worker prompts
2. Select the model specified by the phase card for spawning workers
3. Execute work within the phase's budget constraints
4. When the phase completes, run its validation gate
5. If validation passes, transition to the next phase (logged as a mission event)
6. If validation fails: retry the phase, loop back (if `canLoop`), or pause for human intervention

Transitions are automatic — no human approval needed between phases unless a validation gate fails.

### Custom Phases

Users can create custom phases with arbitrary instructions. Examples:
- "Security Audit: Review all changes for SQL injection, XSS, authentication bypasses"
- "UI Planning: Generate wireframe descriptions and component hierarchy before Development"
- "Documentation Update: Update README, API docs, and changelog"

Custom phases use the same template as built-in phases. Before launch, the pre-flight system validates custom phase instructions semantically (lightweight Haiku call to confirm they're understandable and actionable).

---

## Tiered Validation System

Validation is configurable per phase card. Current authoritative tiers are in `docs/ORCHESTRATOR_OVERHAUL.md`:
- `self` (coordinator must validate and report)
- `dedicated` (runtime auto-spawns validator)
- `none` (no contract)

### Tier 1 — Self-Validation (Free)
Workers self-validate against embedded checklists in their phase instructions. The phase card's `instructions` can include validation criteria the worker checks before marking a task complete. Example: "Before completing, verify: (1) all new functions have JSDoc comments, (2) no `any` types remain, (3) all imports are used." No additional AI calls.

### Tier 2 — Dedicated Validator (Expensive)
A lightweight validator agent is spawned at milestone boundaries or phase transitions. The validator receives the original requirements, the plan, and the worker's output. It produces a structured pass/fail report with specific findings. If it fails a milestone, the mission can retry, loop back, or pause for human intervention. Validator agents use a separate model context to avoid confirmation bias.

### QA Loop Phase
An optional custom phase (placed after Development) with `canLoop: true` and `loopTarget` pointing to Development. If its validation fails, the mission loops back to Development for rework. Loop counter prevents infinite loops (configurable max iterations, default 3).

---

## Budget Management

Dual-mode budget tracking that handles subscription and API key users differently.

### Subscription Mode (Best-Effort Estimation)

Subscription providers (Claude Pro/Max, ChatGPT Plus) don't expose precise billing APIs. ADE tracks usage by reading local CLI session data — the same approach used by [Claud-ometer](https://github.com/deshraj/Claud-ometer).

**How it works — Claude subscription tracking:**

1. **Session logs** at `~/.claude/projects/<project-hash>/<session-id>.jsonl`:
   - Each line is a JSON object representing a conversation turn
   - Contains: `role`, `content`, `model`, `timestamp`, `usage` (input/output token counts when available)
   - ADE reads these files to compute per-session and per-mission token usage
   - Files are append-only JSONL, so ADE can `tail` for new entries during a running mission

2. **Stats cache** at `~/.claude/stats-cache.json`:
   - Pre-computed daily usage statistics
   - Contains: daily token counts, model usage breakdown, session counts
   - ADE reads this as a starting point and supplements with real-time session log parsing

3. **Rate limit headers** from Claude CLI responses:
   - `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-tokens`
   - Captured by the `ClaudeExecutor` and forwarded to the budget service
   - Provides the most accurate real-time picture of remaining capacity

4. **Known subscription limits**:
   - Claude Pro: 5-hour rolling usage window
   - Claude Max (5x): 5x the Pro limits
   - Claude Max (20x): 20x the Pro limits
   - ADE displays remaining capacity as informational guidance (not hard caps, since exact limits aren't publicly documented in token terms)

5. **Usage display**:
   - Pre-flight checklist shows "~X remaining of 5hr window" based on recent usage rate
   - Mission Details tab shows per-phase and per-worker usage breakdown
   - Weekly aggregation chart for subscription utilization trends
   - Rate limit state indicator (green/yellow/red)

**Codex subscription tracking:**
- Track tokens sent/received through the `CodexExecutor`
- Monitor local Codex CLI logs if available at `~/.codex/`
- Fallback: internal tracking only (log what we send/receive through the executor)

### API Key Mode (Exact Budget Tracking)

- Hard budget caps enforced per-mission and per-phase
- Each phase card has a `budget` field with `maxTokens`, `maxTimeMs`, `maxSteps`
- Mission-level budget: sum of per-phase budgets, with optional mission-level cap (lower wins)
- Budget enforcement is hard — when any cap is hit, the phase stops immediately with a structured `budget-exhaustion` record
- Real-time spend tracking with configurable alerts at 50%, 80%, 95% thresholds
- Direct billing API queries for exact balance (Anthropic/OpenAI billing endpoints)

### Rate Limit Handling (Both Modes)

- When a worker hits a rate limit, it automatically pauses with a `rate-limited` status
- The mission continues executing other workers that are not rate-limited
- The rate-limited worker waits for reset (using known reset window from headers) and auto-retries
- If all workers for a provider are rate-limited, the mission enters "waiting for rate limit reset" with a countdown timer
- No human intervention required — fully automatic

---

## Remaining Work

The Phase 3 plan is organized into 8 tasks total. Tasks 1-6 are now complete; active remaining execution is Tasks 7-8. Each task is self-contained — an agent given this document and the codebase should be able to implement any individual task. Tasks remain dependency-ordered, with limited parallelization opportunities where noted.

---

### Task 1: Orchestrator Autonomy Core

**Combines**: Team runtime foundations, structured worker reporting, autonomous replanning, tool profiles, partial completion.

**Why this is one task**: These are all coordinator/worker communication primitives. They share the same runtime surface (coordinator tools, worker tools, mission state) and should be designed together to ensure a coherent protocol.

#### 1A: Team Runtime Foundations

Add a team template schema that defines roles, constraints, and default model routing for missions.

```typescript
interface TeamTemplate {
  id: string;
  name: string;
  roles: RoleDefinition[];
  policyDefaults: MissionPolicyFlags;
  constraints: {
    maxWorkers: number;
    requiredRoles: string[];  // Must include coordinator, planner, validator
  };
}

interface RoleDefinition {
  name: string;               // "coordinator", "implementer", "validator", etc.
  description: string;
  capabilities: string[];     // What this role can do
  defaultModel: ModelConfig;
  maxInstances?: number;      // How many workers can be spawned from this role
}
```

- Required-role enforcement: missions cannot start without coordinator, planner, and validator capabilities.
- Runtime role binding: when the coordinator spawns a worker, it assigns a role from the template. The worker's tool set and permissions are scoped by its role.
- Role-aware spawn rules: the coordinator uses `request_specialist` to spawn workers with specific roles.

#### 1B: Structured Worker Reporting

Add four new worker tools to replace unstructured transcript scraping:

| Tool | Direction | Purpose |
|---|---|---|
| `report_status` | Worker → Coordinator | Structured progress update (% complete, blockers, confidence, next action) |
| `report_result` | Worker → Coordinator | Structured task completion report (outcome, artifacts, files changed, tests run) |
| `read_mission_status` | Worker → Runtime | Read current mission state (active steps, completed steps, other workers' status) |
| `message_worker` | Worker → Worker (via Coordinator) | Send a message to another worker (routed through coordinator for visibility) |

Show structured reports inline in Mission Chat and Activity — not just raw transcript text.

#### 1C: Autonomous Replanning

Add coordinator tool `revise_plan` for full or partial plan replacement:

- **Supersede semantics**: replaced steps are marked `superseded` (not deleted) with a reference to the replacement step. This preserves audit trail.
- **Triggers**: The runtime surfaces staleness signals (repeated failures, stuck workers, timeout thresholds) that recommend replanning. The coordinator makes the final decision.
- **Audit**: Every replan is logged in the timeline and visible in the DAG (superseded steps shown with strikethrough).

#### 1D: Tool Profile Runtime

- Mission tool-profile schema: which tools are available to which roles.
- Worker spawn includes role/tool profile binding.
- Optional mission-level MCP profile injection: specify which external MCP servers (Phase 4) are available to workers.
- Mid-run updates: coordinator can update tool profiles if mission conditions change.

#### 1E: Partial Completion & Recovery (historical design; superseded)

- Historical note: `partially_completed` mission outcome was proposed here and is now removed from active runtime contracts.
- On coordinator unrecoverable failure, persist a recovery handoff artifact: last stable plan, completed validations, open work, lane map.
- Recovery handoff enables a new mission to pick up where the failed one left off.

---

### Task 2: Validation & Lane Continuity

**Combines**: Validation contracts, validator loop, lane affinity, rework continuity.

**Why this is one task**: Validation gates and rework routing are tightly coupled — a validation failure triggers rework, which needs lane continuity. These must be designed as one coherent flow.

#### 2A: Validation Contracts

Introduce `ValidationContract` at step/milestone/mission levels:

```typescript
interface ValidationContract {
  level: 'step' | 'milestone' | 'mission';
  tier: 'self' | 'dedicated';
  required: boolean;
  criteria: string;           // What must be true for validation to pass
  evidence: string[];         // What artifacts the validator should examine
  maxRetries: number;         // How many rework cycles before escalating
}
```

- Step validation: optional, configured per phase card.
- Milestone validation: required. A dedicated validator worker is spawned.
- Mission validation: required. Final gate before mission completion.

#### 2B: Validator Loop

The rework cycle when validation fails:

1. Validator produces structured pass/fail report with specific findings and remediation instructions
2. Coordinator receives the report and decides: rework with same worker, rework with replacement worker, or escalate to human
3. Rework worker receives: the original task, the validator's findings, and the remediation instructions
4. Rework worker executes fixes on the **same lane** (lane continuity preserved)
5. Validator re-checks. Loop continues until pass or max retries exceeded.
6. If max retries exceeded, coordinator pauses the mission and escalates to human.

#### 2C: Lane Affinity & Rework Continuity

- **Step-lane ownership contract**: a step owns a lane. Enforce across retries and worker replacement.
- **Replacement worker inheritance**: when a worker is replaced (failed, timed out, or rework reassignment), the new worker inherits the same lane and receives a handoff package:
  - Summary of what the previous worker did
  - Changed files list
  - Failed check results
  - Prior validator feedback (if rework)
- **Explicit lane transfer**: only through coordinator action, logged in the timeline with reason.

---

### Task 3: Mission Phases Engine & Profiles

**Combines**: Phase card data model, phase engine execution, phase profiles, Settings UI.

**Why this is one task**: The data model, execution engine, and profile system are one feature. They share types, storage, and UI components.

**Implementation status (2026-02-27): Implemented**

- Upstream prerequisites are in place from Task 1/2:
  - Coordinator-owned runtime contracts and structured reporting events are live.
  - Validation contracts exist and can be consumed by phase gates.
  - Lane continuity and partial completion semantics are available for phase-loop recovery.
- Development guardrails for Task 3:
  - Keep orchestration strategy AI-owned; phase engine should provide context/gates, not hard-coded strategy.
  - Treat phase cards as declarative constraints/config, not imperative workflow code.
  - Keep metadata evolution additive and auditable without introducing legacy runtime execution branches.

#### 3A: Phase Engine Data Model & Storage

- Implement `PhaseCard` and `PhaseProfile` TypeScript interfaces (defined above in Core Concepts).
- SQLite tables: `phase_cards`, `phase_profiles`, `mission_phase_overrides`.
- Phase card CRUD operations with ordering constraint enforcement.
- Profile CRUD with constraint validation on save (no cycles, hard constraints respected).
- Built-in phases and profiles are seeded on first launch and non-deletable.

#### 3B: Phase Engine Execution Runtime

- The orchestrator reads the phase card sequence from the mission's selected profile.
- Phase transitions are sequential: current phase must complete + validation gate must pass before next phase starts.
- On each phase transition:
  1. Log a `phase_transition` mission event
  2. Update the orchestrator's context with the new phase's instructions and model config
  3. Spawn new workers using the new phase's model selection (orchestrator stays on its pre-selected model)
  4. Reset per-phase budget counters
- If a validation gate fails, the engine handles: retry (re-run phase), loop (if `canLoop`, go back to `loopTarget`), or pause (escalate to human).

#### 3C: Phase Card UI — Launch Flow

The mission launch flow includes a phase configuration step:

```
+------------------------------------------------------------------+
| NEW MISSION                                                        |
+------------------------------------------------------------------+
| Prompt: [Refactor the auth module to use JWT refresh tokens...   ]|
|                                                                    |
| PHASE CONFIGURATION                      Profile: [Default  v]   |
|                                                                    |
| ┌─ 1. Development ──────────────────────────────────────────────┐ |
| │  Model: Codex          │  Validation: Spot-check │  Budget: auto│ |
| │  [Configure]                                                   │ |
| └────────────────────────────────────────────────────────────────┘ |
|   ↕ drag to reorder                                                |
| ┌─ 2. Testing ──────────────────────────────────────────────────┐ |
| │  Model: Claude Sonnet  │  Validation: Dedicated │  Budget: auto│ |
| │  [Configure]                                                   │ |
| └────────────────────────────────────────────────────────────────┘ |
|   ↕ drag to reorder                                                |
| ┌─ 3. Validation ───────────────────────────────────────────────┐ |
| │  Model: Claude Sonnet  │  Validation: Dedicated │  Budget: auto│ |
| │  [Configure]                                                   │ |
| └────────────────────────────────────────────────────────────────┘ |
|   ↕ drag to reorder                                                |
| ┌─ 4. PR & Conflict Resolution ─────────────────────────────────┐ |
| │  Model: Claude Sonnet  │  Validation: Self  │  Budget: auto   │ |
| │  [Configure]                                                   │ |
| └────────────────────────────────────────────────────────────────┘ |
|                                                                    |
| [+ Add Custom Phase]                [Save as Profile]             |
|                                                                    |
| Orchestrator Model: [Claude Opus  v]                               |
| PR Strategy: [Per-Lane  v]                                         |
|                                                                    |
| [NEXT: PRE-FLIGHT CHECK →]                                        |
+------------------------------------------------------------------+
```

- Each phase card is a collapsible/expandable row showing model, validation tier, and budget at a glance.
- Click **[Configure]** to expand inline: edit instructions, model, budget caps, validation criteria, ask-questions settings.
- **Drag-and-drop reordering**: cards can be dragged to new positions. Invalid positions (violating ordering constraints) show a red indicator with tooltip ("Development must be first", "Validation must follow Development").
- **Profile selector**: dropdown at top. Changing profile reloads the phase card list. Modifications create a per-mission override (don't change the saved profile).
- **[+ Add Custom Phase]**: opens an inline form with the same fields as a built-in phase. Custom phases are validated before save.
- **Orchestrator Model**: separate selector for the coordinator model (stays constant across all phases).

#### 3D: Phase Profile Settings UI

In Settings → Missions → Phase Profiles:

```
+------------------------------------------------------------------+
| SETTINGS > MISSIONS > PHASE PROFILES                               |
+------------------------------------------------------------------+
| Profile List                                          [+ CREATE]  |
|                                                                    |
| ● Default (4 phases)                              [Edit] [Clone] |
|   Development → Testing → Validation → PR                         |
|                                                                    |
|   TDD (4 phases)                                  [Edit] [Clone] |
|   Testing → Development → Validation → PR                         |
|                                                                    |
|   Security-Focused (5 phases)          [Edit] [Clone] [Delete]   |
|   Development → Security Audit → Testing → Val → PR               |
|                                                                    |
| [Import Profile]                        [Export Selected]         |
+------------------------------------------------------------------+
```

- Built-in profiles (Default, TDD) show ● indicator, can't be deleted but can be edited.
- Clone creates a copy with "(Copy)" suffix.
- Import/export as JSON files. Also stores in `.ade/profiles/` for version control.

#### 3E: Task 3 Shipped Scope (2026-02-27)

- Migration-safe storage is live with `phase_cards`, `phase_profiles`, and `mission_phase_overrides` plus seed-on-read for built-in cards/profiles.
- Mission creation accepts `phaseProfileId` + optional `phaseOverride`, validates ordering constraints, and applies phase metadata to persisted mission steps.
- Mission-level phase configuration is persisted and queryable via mission detail (`getPhaseConfiguration`) and home aggregate (`getDashboard`) APIs.
- Profile lifecycle APIs are live: list/save/delete/clone/import/export, with built-in profile deletion protection and unique-name enforcement.
- Profile export writes JSON snapshots into `.ade/profiles/` when a project root is available.
- Runtime phase telemetry is wired: orchestrator phase changes emit durable `phase_transition` events and maintain run metadata transition history + per-phase budget reset markers.
- Autonomy boundary is preserved: phase engine provides declarative constraints/instructions, and does not inject deterministic strategy decisions in place of coordinator choices.

---

### Task 4: Mission UI Overhaul

**Combines**: Plan tab, Work tab, DAG tab updates, Activity/Details tab fixes, Home Dashboard.

**Why this is one task**: These are all renderer components within the mission detail view. They share the same IPC event stream and mission state model.

**Implementation status (2026-02-27): Implemented**

- Data signals required by Task 4 are available:
  - Structured worker reports (`report_status`, `report_result`, `report_validation`) are persisted.
  - Replan/supersede/lane-transfer timeline events are emitted and queryable.
  - `read_mission_status` exposes active/completed work, staleness, and open obligations.
- Development guardrails for Task 4:
  - Render runtime truth directly; do not infer hidden deterministic state in the UI.
  - Preserve auditability (superseded edges/nodes and validation outcomes must remain visible).
  - Keep tabs resilient to long-running missions and high event volume.

#### 4A: Plan Tab (NEW)

Hierarchical task list view showing the mission plan in real-time:

```
+------------------------------------------------------------------+
| MISSION: Refactor Auth Module                                      |
| [Plan] [Work] [DAG] [Chat] [Activity] [Details]                  |
+------------------------------------------------------------------+
| PLAN                                                    [REFRESH] |
|                                                                    |
|  Phase: Development (2/3 milestones)                    ██████░░  |
|                                                                    |
|  ▼ Milestone 1: Extract auth middleware          [3/5 tasks] ✓    |
|    ✓ Task 1.1: Create auth middleware module                      |
|      ✓ Subtask: Extract JWT validation logic                      |
|      ✓ Subtask: Extract session management                        |
|    ✓ Task 1.2: Update imports across codebase                     |
|    ● Task 1.3: Add refresh token rotation        [IN PROGRESS]    |
|      ● Subtask: Implement token rotation logic   [Worker: w-1]    |
|      ○ Subtask: Add rotation tests                                |
|    ○ Task 1.4: Update error handling                              |
|    ○ Task 1.5: Add integration tests                              |
|                                                                    |
|  ▶ Milestone 2: Session management overhaul      [0/4 tasks]      |
|  ▶ Milestone 3: Update documentation             [0/2 tasks]      |
+------------------------------------------------------------------+
```

- **Hierarchy**: Phase → Milestones → Tasks → Subtasks
- **Status indicators**: ✓ completed, ● in progress, ○ pending, ✗ failed
- **Real-time updates**: as the orchestrator modifies the plan (adds tasks, marks complete, reorders, supersedes), the tree updates live via IPC events
- **Worker assignment**: shown on in-progress tasks with worker ID
- **Click to expand**: task details panel showing description, assigned worker, time spent, output summary, validator feedback
- **Expand/collapse**: milestones collapsible for overview vs detail
- **Phase indicator**: top bar shows current phase with progress

#### 4B: Work Tab (NEW)

"Follow mode" for observing individual workers in real-time:

```
+------------------------------------------------------------------+
| WORK                                                               |
| Follow: [Worker w-1 ▼]  ● ACTIVE    Phase: Development           |
+------------------------------------------------------------------+
| LIVE OUTPUT                                           [Auto-scroll]|
|                                                                    |
| 14:32:01 > Reading file: src/auth/middleware.ts                    |
| 14:32:03 > Analyzing JWT validation patterns...                    |
| 14:32:05 > Tool call: edit_file(src/auth/middleware.ts, ...)       |
| 14:32:06 > Applied changes: +12 -4 lines                          |
| 14:32:08 > Tool call: run_command(npm test -- auth)                |
| 14:32:15 > Test output:                                            |
|   PASS src/auth/__tests__/middleware.test.ts (2.3s)                |
|   14 tests passed                                                  |
| 14:32:16 > Moving to next subtask: Add rotation tests              |
|                                                                    |
+------------------------------------------------------------------+
| FILES MODIFIED                        TOOLS CALLED                 |
| src/auth/middleware.ts    [+12 -4]    edit_file (3 calls)         |
| src/auth/jwt.ts           [+8 -2]    run_command (1 call)         |
| src/auth/session.ts       [pending]   read_file (5 calls)         |
+------------------------------------------------------------------+
```

- **Worker selector dropdown**: choose which running worker to follow. Shows all active workers with role and current task.
- **Live terminal output**: streaming view of the worker's tool calls, file edits, and command output. Timestamps on each entry.
- **Files panel**: files the worker has modified or is actively editing, with diff summary (+/- lines).
- **Tools panel**: tools called with invocation counts.
- **Auto-follow**: when a worker completes, automatically switch to the next active worker.
- **Scroll lock toggle**: pin output at bottom (auto-scroll) or allow manual scrolling.
- **Phase indicator**: shows which phase the worker is operating in.

#### 4C: Existing Tab Fixes

- **DAG tab**: update for real-time plan changes. Superseded steps shown with strikethrough. Status coloring: green (complete), blue (in progress), gray (pending), red (failed). Phase boundaries shown as visual separators.
- **Activity tab**: fix timeline rendering with long-running missions. Ensure phase transitions, worker spawns, validation results, and interventions all appear. Verify category dropdown works with phase transition events.
- **Details tab**: fix token usage aggregation across workers. Fix budget display for subscription vs API key modes. Add per-phase usage breakdown. Show phase profile used for this mission.

#### 4D: Missions Home Dashboard

When no mission is selected, the Missions tab shows a home screen:

```
+------------------------------------------------------------------+
| MISSIONS                                          [+ New Mission] |
+------------------------------------------------------------------+
| ACTIVE MISSIONS                                                    |
|                                                                    |
| ┌─ Refactor Auth Module ──────────────────────────────────────┐  |
| │  Phase: Development (2/3 milestones)  │  3 workers active   │  |
| │  Started: 14 min ago                  │  Est. remaining: 8m │  |
| │  ████████████░░░░░░░░ 60%                                   │  |
| └─────────────────────────────────────────────────────────────┘  |
|                                                                    |
| RECENT MISSIONS                                                    |
|                                                                    |
| ✓  Add user preferences API    23 min · $1.20   [View] [Rerun] |
| ✗  Fix flaky CI tests          8 min · $0.40    [View] [Retry] |
| ✓  Update dependencies         12 min · $0.80   [View] [Rerun] |
| ~  Stabilize API endpoints     45 min · $2.10   [View] [Resume]|
|                                                                    |
| STATS (This Week)                                                  |
| Missions: 12  │  Success: 83%  │  Avg Duration: 18 min           |
| Total Cost: $14.20 (subscription estimate)                        |
+------------------------------------------------------------------+
```

- **Active missions**: real-time status, phase progress, worker count, elapsed time, estimated remaining.
- **Recent missions**: last N completed with outcome (✓ succeeded, ✗ failed, ~ partially completed), duration, cost.
- **Quick actions**: View (open detail), Rerun (same prompt + profile), Retry (failed missions), Resume (partially completed).
- **Weekly stats**: mission count, success rate, avg duration, total cost.
- **[+ New Mission]**: opens mission launch flow.

#### 4E: Task 4 Shipped Scope (2026-02-27)

- Mission workspace tabs now expose: `Plan`, `Work`, `DAG`, `Chat`, `Activity`, `Details`.
- `Plan` tab renders phase -> milestone -> task hierarchy from runtime graph metadata, including superseded/audit-visible step statuses and expected-signal detail rows.
- `Work` tab provides follow-mode worker monitoring: live transcript tails, active worker selector, auto-follow behavior, and runtime-derived files/tools side panels.
- No-selection missions view now renders a real dashboard (`active`, `recent`, `weekly stats`) from persisted mission/runtime state.
- Launch flow includes phase profile selection and override editing (configure cards, reorder, add custom phases, save as profile) with client-side ordering validation.
- Mission settings include phase profile management (create/import/clone/export/delete where allowed) against the same main-process profile APIs.
- `Details` tab now surfaces phase profile and per-phase completion summary alongside usage/budget telemetry.
- UI contract remains autonomy-first: all state is rendered from mission/orchestrator runtime events and persisted rows, not inferred deterministic hidden state.

#### 4F: Operator Notes

- Existing missions remain valid with no backfill requirement; phase config defaults resolve from seeded built-ins when no mission override exists.
- Operators can inspect phase progression via durable `phase_transition` events in mission timeline/activity.
- Profile JSON exports under `.ade/profiles/` are intended for versioning/review and can be re-imported across machines/projects.

---

### Task 5: Pre-Flight, Intervention & Human-in-Loop

**Combines**: Pre-flight checklist, intervention overhaul, human-in-loop upgrade.

**Why this is one task**: These all govern what happens at mission boundaries — before launch, during stuck states, and when human input is needed. They share the permission model and escalation chain.

**Readiness (2026-02-28): Shipped**

- Upstream prerequisites are now in place from Tasks 1-4:
  - Task 1/2 provide structured worker reporting, validation outcomes, lane transfer auditability, and intervention primitives.
  - Task 3 provides mission phase/profile configuration that pre-flight must validate.
  - Task 4 provides launch/details/dashboard UI surfaces to host pre-flight and intervention UX upgrades.
- Development guardrails for Task 5:
  - Keep coordinator-owned strategy intact; intervention logic must expose state and controls, not inject deterministic decision-making.
  - Preserve granular audit visibility (worker-level pause/retry/escalation lineage in activity/timeline).
  - Pre-flight must be an explicit launch gate with explainable pass/fail reasons (no hidden heuristics).

#### 5A: Pre-Flight Checklist

Shown in the mission launch flow after phase configuration, before the Launch button:

```
+------------------------------------------------------------------+
| PRE-FLIGHT CHECKLIST                                               |
+------------------------------------------------------------------+
| ✓ Models detected & authenticated                                 |
|   Claude Sonnet (Testing, Validation, Orchestrator) — authenticated|
|   Codex (Development) — authenticated                              |
|                                                                    |
| ✓ Permissions                                                      |
|   Mode: Full Auto (bypass permissions)                             |
|                                                                    |
| ✓ Git worktrees available                                          |
|   3 lanes available for worker assignment                          |
|                                                                    |
| ✓ Phase configuration valid                                        |
|   Profile: Default (4 phases)                                      |
|   Ordering constraints: satisfied                                  |
|   Custom phases: 0                                                 |
|                                                                    |
| ⚠ Budget estimation                                                |
|   Estimated: ~$4.20 / ~45 min                                     |
|   Per-phase: Dev $2.80, Test $0.60, Val $0.30,                     |
|              PR $0.20                                               |
|   Mode: Subscription (best-effort estimate)                        |
|                                                                    |
| [← BACK]                    [LAUNCH MISSION]     [EDIT CONFIG]    |
+------------------------------------------------------------------+
```

**Validation checks (all required, nothing optional):**

| Check | Logic | Fail Behavior |
|---|---|---|
| **Model detection** | Every model selected in any phase card + orchestrator must be detected and authenticated. If Claude Opus is selected for Development, Claude CLI must be present and authenticated. | Block launch. Show which model failed and how to fix. |
| **Permissions** | Full-auto mode required for unattended execution. | Block launch with one-click fix to enable full-auto. |
| **Worktrees** | Sufficient lanes/worktrees available for expected worker count. | Warning if tight, block if zero available. |
| **Phase config — structural** | All required fields present on every phase card. | Block launch. Highlight missing fields. |
| **Phase config — ordering** | Constraint graph is satisfiable (no cycles, hard constraints respected). | Block launch. Show constraint violation. |
| **Phase config — semantic** | For custom phases, lightweight Haiku call confirms instructions are understandable and actionable. | Warning. Show AI feedback on unclear instructions. |
| **Budget** | Per-phase budgets sum to ≤ available mission budget (API key mode) or show estimate (subscription). | Block if over budget (API key). Warning with estimate (subscription). |

#### 5B: Granular Intervention

- When a worker gets stuck (error, intervention request, timeout), **only that worker pauses** — the mission continues.
- Other workers continue independently unless they depend on the stuck worker's output (dependency-based cascading pause).
- Mission-level pause remains available as an explicit user action.
- Rate limit handling: worker auto-pauses with `rate-limited` status, waits for reset, auto-retries. No human needed.
- If all workers for a provider are rate-limited: mission enters "waiting for rate limit reset" with countdown timer.

#### 5C: Escalation Chain

Formalized escalation:

```
Worker encounters issue
    ↓
Worker reports to Coordinator (via report_status)
    ↓
Coordinator attempts resolution:
  - Reassign task to different worker
  - Retry with different approach
  - Skip non-critical task
    ↓
If Coordinator cannot resolve:
    ↓
Coordinator escalates to Human (intervention request in Chat/Activity tab)
    ↓
Human provides guidance → Coordinator resumes affected worker
```

#### 5D: Human-in-Loop Upgrade

- **Clarifying-question phase**: before plan approval, orchestrator can ask the user clarifying questions. Controlled by `clarification_mode` policy flag (`always`, `auto_if_uncertain`, `off`).
- **Risk-based approval**: high-impact actions (destructive git operations, mass file deletion, external API calls) trigger approval dialogs. Controlled by `risk_approval_mode` policy flag.
- **Worker `request_user_input`**: workers can request human input, routed through the coordinator. Coordinator decides whether to relay, answer from context, or skip.
- **Pause/resume parity**: consistent pause/resume controls across UI and runtime. Pause applies at worker or mission level.

#### 5E: Task 5 Shipped Scope (2026-02-28)

- Mission launch now has an explicit pre-flight gate in the create flow (`RUN PRE-FLIGHT` → `LAUNCH MISSION`) with pass/warning/fail checklist rendering and hard-fail launch blocking.
- Pre-flight checks now validate model authentication, full-auto permissions, worktree capacity, phase structural/ordering constraints, custom-phase semantic clarity, and budget envelope compatibility.
- Manual-input escalation is now granular: coordinator and worker delivery interventions can open without forcing mission-wide pause (`pauseMission: false`), preserving worker/dependency-level autonomy.
- Human escalation tooling now supports both `ask_user` and `request_user_input` with dedupe-aware intervention creation and timeline/runtime audit events.

---

### Task 6: Budget & Usage Tracking

**Combines**: Budget-aware orchestration decisions, budget management service, subscription usage tracking.

**Why this is one task**: The budget service, usage tracking, and orchestration pressure logic are a single data pipeline. Usage data feeds into budget state, which feeds into orchestration decisions.

**Readiness (2026-02-28): Shipped**

- Upstream prerequisites are now in place from Tasks 1-4:
  - Coordinator tooling/telemetry (Task 1/2) can consume budget status as decision input.
  - Phase-aware mission model (Task 3) enables per-phase budget accounting.
  - Task 4 details/dashboard surfaces can display per-phase/weekly budget and cost telemetry.
- Development guardrails for Task 6:
  - Budget pressure informs coordinator decisions via explicit tools/contracts; runtime must not hard-code strategy overrides.
  - Distinguish hard limits (API-key mode) vs advisory estimates (subscription mode) in both runtime behavior and UI.
  - Keep accounting auditable and reproducible (durable budget snapshots/events, reproducible aggregations) without legacy compatibility branches in runtime decision flow.

#### 6A: Budget Service

Central service that maintains real-time budget state for each mission:

```typescript
interface MissionBudget {
  mode: 'subscription' | 'api-key';
  mission: {
    maxTokens?: number;         // API key: hard cap. Subscription: informational.
    maxTimeMs?: number;
    maxCostUsd?: number;        // API key only
    usedTokens: number;
    usedTimeMs: number;
    usedCostUsd: number;
  };
  perPhase: Map<string, PhaseBudget>;
  perWorker: Map<string, WorkerBudget>;
  pressure: 'normal' | 'warning' | 'critical';  // Drives orchestration decisions
}
```

#### 6B: Subscription Usage Tracking Implementation

**Claude — read local `~/.claude/` files:**

```typescript
// 1. Find all session files for the current project
const projectDir = path.join(os.homedir(), '.claude', 'projects', projectHash);
const sessionFiles = glob.sync('*.jsonl', { cwd: projectDir });

// 2. Parse session JSONL for token usage
for (const file of sessionFiles) {
  const lines = fs.readFileSync(path.join(projectDir, file), 'utf8').split('\n');
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.usage) {
      totalInputTokens += entry.usage.input_tokens || 0;
      totalOutputTokens += entry.usage.output_tokens || 0;
    }
  }
}

// 3. Read stats cache for daily aggregates
const statsCache = JSON.parse(
  fs.readFileSync(path.join(os.homedir(), '.claude', 'stats-cache.json'), 'utf8')
);
// statsCache contains: { daily: { [date]: { tokens, sessions, models } } }

// 4. Correlate with mission IDs via timestamp ranges
// Each mission has a startedAt/completedAt — match session entries that fall within that range
```

**Rate limit integration:**
- `ClaudeExecutor` captures `x-ratelimit-*` headers from every API response
- Headers forwarded to budget service → updates `remainingTokens` and `resetAt`
- Budget service computes: `estimatedRemainingCapacity = remainingTokens / avgTokensPerStep * avgStepDuration`

**Codex:**
- Track via `CodexExecutor` — log input/output tokens for every call
- Read `~/.codex/` logs if available
- Fallback: internal tracking only

#### 6C: Budget-Aware Orchestration Decisions

Expose budget state to the coordinator via `get_budget_status` tool:

```typescript
// Coordinator tool response
{
  pressure: 'warning',          // normal | warning | critical
  mission: { used: 45000, limit: 100000, remaining: 55000 },
  currentPhase: { used: 12000, limit: 30000, remaining: 18000 },
  activeWorkers: 3,
  recommendation: 'Reduce parallelism to 2 workers'
}
```

**Orchestration behavior under pressure:**

| Pressure Level | Trigger | Orchestration Effect |
|---|---|---|
| `normal` | < 60% budget consumed | No restrictions |
| `warning` | 60-85% budget consumed | Reduce parallelism, defer optional validation, prefer cheaper models for remaining work |
| `critical` | > 85% budget consumed | Single worker only, finish required validation for active milestone, then stop |

Budget pressure is an input to coordinator decisions, not a hard override — the AI decides what to do with the information.

#### 6D: Budget Display

- **Pre-flight**: estimated cost/time based on similar past missions and selected models. Visual budget bar showing allocation across phases.
- **Mission Details tab**: real-time per-phase and per-worker usage breakdown. Budget consumption chart. Rate limit state indicator.
- **Home Dashboard**: per-mission cost in recent missions list. Weekly cost aggregate.

#### 6E: Task 6 Shipped Scope (2026-02-28)

- Added `missionBudgetService` with launch estimation, mission/per-phase/per-worker budget snapshots, pressure classification (`normal`/`warning`/`critical`), and recommendation synthesis.
- Subscription estimation now ingests local Claude session JSONL telemetry under `~/.claude/projects/*/*.jsonl` for best-effort usage/cost correlation.
- Budget state is now exposed to the coordinator via `get_budget_status`, so budget pressure informs coordinator strategy without deterministic runtime overrides.
- Mission Details now renders mission budget summary, token/cost/time progress bars, per-phase and per-worker breakdowns, and a rate-limit indicator row.

---

### Task 7: Reflection Protocol

**Self-contained**: Mission introspection and system self-improvement through structured agent reflections.

#### 7A: Reflection Log

Every agent (orchestrator, workers, validators) writes structured reflections during execution:

```typescript
interface ReflectionEntry {
  id: string;
  missionId: string;
  agentRole: string;              // "coordinator", "implementer", "validator"
  phase: string;                  // Which mission phase
  type: 'wish' | 'frustration' | 'idea' | 'pattern' | 'limitation';
  description: string;            // What was attempted, what blocked, what would help
  context: string;                // What the agent was doing when it had this observation
  timestamp: string;
}
```

- Storage: `.ade/reflections/<mission-id>.jsonl` (append-only)
- Reflections are written alongside normal work — agents note observations as they encounter them, they don't stop to reflect.
- Reflection types:
  - `wish`: capability gap ("I wish I could run the debugger")
  - `frustration`: workflow friction ("The test suite takes 3 minutes, slowing iteration")
  - `idea`: improvement suggestion ("Could pre-generate type stubs to avoid repeated type errors")
  - `pattern`: reusable technique discovered ("This codebase uses barrel exports — always check index.ts")
  - `limitation`: context/tool constraint hit ("Ran out of context before finishing the large file")

#### 7B: Post-Mission Retrospective

After each mission completes, a lightweight AI pass reads the reflection log and produces a retrospective:

```typescript
interface MissionRetrospective {
  missionId: string;
  generatedAt: string;
  topPainPoints: string[];        // Ranked by frequency/impact
  topImprovements: string[];      // Actionable suggestions
  patternsToCapture: string[];    // Candidates for learning pack entries
  estimatedImpact: string;        // "If addressed, X would improve by Y"
  changelog: ChangelogEntry[];    // What changed since last retrospective
}

interface ChangelogEntry {
  previousPainPoint: string;
  status: 'resolved' | 'still-open' | 'worsened';
  fixApplied?: string;
  currentState: string;
}
```

- Retrospectives accumulate in `.ade/reflections/retrospectives/`
- **Changelog**: each retrospective references previous ones — "Previous pain point: X. Fix applied: Y. Status: resolved/still-open." This shows the system's improvement trajectory over time.

#### 7C: Integration with Learning Packs

- Patterns discovered via reflection that are **codebase-specific** get promoted to learning pack entries (Phase 4).
- **System-level observations** (orchestrator workflow improvements, prompt improvements) stay in the reflection system.
- Clear separation: learning packs = "how to work in this codebase", reflections = "how to improve the mission system itself."

#### 7D: Future: Closed-Loop Self-Improvement (Deferred)

Not in Phase 3, but the architecture supports it:
- CTO reads reflection retrospectives → identifies high-impact improvements → creates improvement mission → mission modifies orchestrator prompts/config → next mission runs better.
- Human stays in the loop as approval gate: CTO suggests, user approves, mission implements.

---

### Task 8: Integration Testing

**Combines**: Orchestrator soak testing (autonomy features) and missions overhaul testing.

**Why this is one task**: All testing should be planned and executed together to ensure cross-cutting coverage and avoid gaps.

#### 8A: Orchestrator Autonomy Tests

- **Team template tests**: role enforcement, spawn rules, policy precedence (workspace → team → mission).
- **Worker reporting tests**: `report_status`, `report_result`, `read_mission_status` tool invocation and payload validation.
- **Replanning tests**: `revise_plan` with supersede semantics, audit trail verification.
- **Validation loop tests**: pass/fail cycle, rework routing, max retries, human escalation.
- **Lane continuity tests**: step-lane ownership, worker replacement inheritance, explicit transfer.
- **Budget pressure tests**: normal → warning → critical behavior changes, parallelism reduction.
- **Historical partial-completion tests (superseded)**: `partially_completed` outcome, recovery handoff artifact structure.
- **Long-horizon soak tests**: multi-hour simulated missions covering replans, retries, budget pressure, and validation loops.
- **Provider parity tests**: normalized permission/tool error behavior across Claude and Codex.

#### 8B: Missions Overhaul Tests

- **Phase engine tests**: card CRUD, ordering constraint enforcement (Development first, Validation after Dev, PR last, Testing flexible), drag-and-drop position updates, phase transition execution, validation gate invocation.
- **Profile tests**: CRUD, built-in integrity, custom creation with constraint validation, per-mission override, import/export roundtrip, `.ade/profiles/` JSON serialization.
- **Plan tab tests**: hierarchical rendering (milestones → tasks → subtasks), real-time update handling, status indicator accuracy.
- **Work tab tests**: worker selector, live output streaming, file list updates, tool call tracking.
- **Pre-flight tests**: model detection per phase (multiple providers), permission validation, structural/ordering/semantic validation, budget check, UI rendering (pass/warning/fail).
- **Tiered validation tests**: self-validation (checklist), dedicated validator (spawn, review, report), required gate blocking, QA Loop (loop back, max iterations).
- **Intervention tests**: single worker pause (mission continues), dependency cascade, mission-level pause, rate limit auto-recovery.
- **Budget tests**: subscription mode (estimation, weekly aggregation), API key mode (hard caps, immediate stop), rate limit accounting.
- **Reflection tests**: log write/read, retrospective synthesis, changelog tracking.
- **Usage tracking tests**: local file parsing accuracy, per-mission cost correlation.
- **Dashboard tests**: active/recent missions rendering, quick-launch, stats aggregation.

---

## Delivery Order

Tasks are ordered by dependency. Some can be parallelized.

```
Task 1: Orchestrator Autonomy Core ──────────────┐
Task 2: Validation & Lane Continuity ─────────────┤
                                                   ├── Task 8: Integration Testing
Task 3: Mission Phases Engine & Profiles ──────────┤
Task 4: Mission UI Overhaul ──────────────────────┤
Task 5: Pre-Flight, Intervention & Human-in-Loop ─┤
Task 6: Budget & Usage Tracking ──────────────────┤
Task 7: Reflection Protocol ──────────────────────┘
```

**Execution state (2026-03-02):**

1. **Task 1** (Orchestrator Autonomy Core) — complete
2. **Task 2** (Validation & Lane Continuity) — complete
3. **Task 3** (Phases Engine & Profiles) — complete
4. **Task 4** (Mission UI Overhaul) — complete
5. **Task 5** (Pre-Flight, Intervention & HITL) — complete
6. **Task 6** (Budget & Usage Tracking) — complete
7. **Task 7** (Reflection Protocol) — next
8. **Task 8** (Integration Testing) — final broad soak/coverage pass

**Parallelization opportunities:**
- Task 7 can run in parallel with early Task 8 harness scaffolding
- Task 8 should remain last to validate full cross-task behavior end-to-end

---

## Exit Criteria

Phase 3 is complete when:

**Orchestrator Autonomy:**
- Team templates and mission policy flags drive orchestration behavior with clear precedence
- Workers report status/results structurally via dedicated tools
- Coordinator can autonomously revise plans with auditable supersede behavior
- Every milestone and final mission gate passes validator contracts
- Rework routing preserves lane continuity by default
- Budget pressure actively changes orchestration behavior (reduced parallelism, deferred optional work)
- Historical/superseded: mission `partially_completed` outcome proposal (removed in ORCHESTRATOR_OVERHAUL Phases 5-6); recovery handoff remains part of historical design context.
- Provider differences are normalized behind one runtime error/approval contract

**Missions Overhaul:**
- Missions use configurable phase pipelines with drag-and-drop ordering
- Built-in phases ship as defaults; custom phases are validated structurally and semantically
- Phase profiles are configurable in Settings and selectable per-mission with optional overrides
- Pre-flight checklist validates models, permissions, worktrees, phase config, and budget — all checks required
- Plan tab shows hierarchical task list with real-time updates
- Work tab shows live worker output with follow mode
- Tiered validation operates at `self` and `dedicated` levels per phase card, enforced by runtime contracts
- Intervention pauses only stuck workers, not entire missions (unless blocking dependency)
- Escalation chain is formalized: worker → orchestrator → human
- Rate limits are handled automatically (pause → wait → retry)
- Budget management handles subscription (best-effort via local CLI data) and API key (hard caps) modes
- Reflection protocol captures agent observations and produces retrospectives with improvement changelog
- Missions Home Dashboard provides at-a-glance overview with active/recent missions and stats

---

## What Moves to Phase 4

After Phase 3 is complete, Phase 4 focuses on:
- CTO agent (persistent project-aware assistant with three-tier memory model)
- Night Shift mode in Automations (overnight execution, morning briefing)
- Memory architecture upgrade (vector search, composite scoring, consolidation, episodic/procedural memory)
- Learning packs (auto-curated project knowledge from agent interactions)
- External MCP consumption (agents consume external MCP servers)
