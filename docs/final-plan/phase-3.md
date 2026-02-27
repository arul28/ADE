# Phase 3: AI Orchestrator + Missions Overhaul

**Status**: In Progress
**Dependencies**: Phases 1-2 complete (Agent SDKs, AgentExecutor, MCP server)
**Last updated**: 2026-02-27

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

---

## What's Shipped

Phase 3 has already delivered 20 workstreams across two waves. The orchestrator is operational — it plans, spawns workers, executes multi-lane missions, recovers from failures, and provides real-time observability. What's missing is the autonomy to make strategic decisions (re-plan, validate, manage budget) and the user-facing missions overhaul (configurable phases, pre-flight, tiered validation).

### Wave 1: Core Orchestrator (W1-W12)

AI orchestrator service with Claude leader session and MCP tools. Fail-hard planner (300s timeout, no deterministic fallback). PR strategies replacing the old merge phase (`integration` | `per-lane` | `queue` | `manual`). Multi-agent team synthesis with parallel lane provisioning. Recovery loops with heartbeat monitoring and stale attempt detection. Gate evaluator for step/mission completion. Execution plan preview with approval gates. Inter-agent messaging (`sendAgentMessage` IPC). Activity feed with category dropdown. Mission workspace with missionId-filtered queries. Per-mission model selection with thinking budgets. Context packs for progressive orchestrator memory.

### Wave 2: Project Hivemind (HW1-HW8, shipped 2026-02-25)

Evolved the orchestrator into an intelligent multi-agent system. Slack-like mission chat (`MissionChatV2.tsx`) with sidebar channels, @mentions, real-time updates. Inter-agent message delivery to PTY and SDK agents. Shared facts, project memories, and run narrative injected into agent prompts. Smart fan-out via meta-reasoner with dynamic step injection. Context compaction engine (70% threshold, pre-compaction writeback, transcript JSONL, attempt resume). Memory architecture with promotion flow (candidate/promoted/archived), agent identities table, Context Budget Panel. Activity narrative in mission detail.

### What's Still Missing

1. **Strategic autonomy**: Workers can't report status structurally; coordinator can't revise plans; no validation contracts or validator loop.
2. **Team model**: No role definitions, no policy flags, no structured escalation chain.
3. **Budget awareness**: Budget pressure doesn't influence orchestration decisions.
4. **Configurable phases**: Missions use a fixed internal pipeline — users can't customize the workflow.
5. **Mission UI**: No Plan tab (hierarchical task list), no Work tab (follow worker output), no home dashboard.
6. **Pre-flight validation**: No pre-launch checklist for models, permissions, worktrees, or phase config.
7. **Tiered validation**: No self-check / spot-check / dedicated validator system.
8. **Granular intervention**: A stuck worker halts the entire mission instead of just that worker.
9. **Subscription tracking**: No accurate usage data from local CLI session files.
10. **Reflection protocol**: Agents don't capture observations for system self-improvement.

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
  name: string;                     // e.g., "Planning", "Development", "Testing"
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
    mustBeFirst?: boolean;          // e.g., Planning
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
    tier: 'none' | 'self' | 'spot-check' | 'dedicated';
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

### Built-In Phases

These ship with ADE. Users can configure but not delete them.

| Phase | Description | Constraints | Default Model | Default Validation |
|---|---|---|---|---|
| **Planning** | Analyze prompt, decompose into milestones/tasks/subtasks, produce structured plan | Must be first | Claude Sonnet | Self |
| **Development** | Execute the plan — spawn workers, write code, run tools | Must follow Planning | Claude Sonnet | Spot-check |
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

**Built-in profiles**: Default (Planning → Development → Testing → Validation → PR), TDD (Planning → Testing → Development → Validation → PR).

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

Validation is configurable per phase card. Three tiers, increasing in cost and thoroughness:

### Tier 1 — Self-Validation (Free)
Workers self-validate against embedded checklists in their phase instructions. The phase card's `instructions` can include validation criteria the worker checks before marking a task complete. Example: "Before completing, verify: (1) all new functions have JSDoc comments, (2) no `any` types remain, (3) all imports are used." No additional AI calls.

### Tier 2 — Orchestrator Spot-Check (Cheap)
The orchestrator reviews worker output selectively. It uses heuristics (task complexity, worker error rate, importance) to decide what to spot-check. Configurable probability per phase (e.g., 30% of Development tasks, 100% of Validation tasks). One additional orchestrator turn per spot-check.

### Tier 3 — Dedicated Validator (Expensive)
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

The remaining work is organized into 8 tasks. Each task is self-contained — an agent given this document and the codebase should be able to implement any individual task. Tasks are ordered by dependency (earlier tasks should be completed first, though some can be parallelized).

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

#### 1E: Partial Completion & Recovery

- Add `partially_completed` mission outcome with structured "done vs remaining" report.
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
  tier: 'self' | 'spot-check' | 'dedicated';
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
| ┌─ 1. Planning ─────────────────────────────────────────────────┐ |
| │  Model: Claude Sonnet  │  Validation: Self  │  Budget: auto   │ |
| │  [Configure]                                                   │ |
| └────────────────────────────────────────────────────────────────┘ |
|   ↕ drag to reorder                                                |
| ┌─ 2. Development ──────────────────────────────────────────────┐ |
| │  Model: Claude Opus   │  Validation: Spot-check │  Budget: auto│ |
| │  [Configure]                                                   │ |
| └────────────────────────────────────────────────────────────────┘ |
|   ↕ drag to reorder                                                |
| ┌─ 3. Testing ──────────────────────────────────────────────────┐ |
| │  Model: Claude Sonnet  │  Validation: Dedicated │  Budget: auto│ |
| │  [Configure]                                                   │ |
| └────────────────────────────────────────────────────────────────┘ |
|   ↕ drag to reorder                                                |
| ┌─ 4. Validation ───────────────────────────────────────────────┐ |
| │  Model: Claude Sonnet  │  Validation: Dedicated │  Budget: auto│ |
| │  [Configure]                                                   │ |
| └────────────────────────────────────────────────────────────────┘ |
|   ↕ drag to reorder                                                |
| ┌─ 5. PR & Conflict Resolution ─────────────────────────────────┐ |
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
- **Drag-and-drop reordering**: cards can be dragged to new positions. Invalid positions (violating ordering constraints) show a red indicator with tooltip ("Planning must be first", "Validation must follow Development").
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
| ● Default (5 phases)                              [Edit] [Clone] |
|   Planning → Development → Testing → Validation → PR              |
|                                                                    |
|   TDD (5 phases)                                  [Edit] [Clone] |
|   Planning → Testing → Development → Validation → PR              |
|                                                                    |
|   Security-Focused (6 phases)          [Edit] [Clone] [Delete]   |
|   Planning → Development → Security Audit → Testing → Val → PR   |
|                                                                    |
| [Import Profile]                        [Export Selected]         |
+------------------------------------------------------------------+
```

- Built-in profiles (Default, TDD) show ● indicator, can't be deleted but can be edited.
- Clone creates a copy with "(Copy)" suffix.
- Import/export as JSON files. Also stores in `.ade/profiles/` for version control.

---

### Task 4: Mission UI Overhaul

**Combines**: Plan tab, Work tab, DAG tab updates, Activity/Details tab fixes, Home Dashboard.

**Why this is one task**: These are all renderer components within the mission detail view. They share the same IPC event stream and mission state model.

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
| ~  Migrate legacy endpoints    45 min · $2.10   [View] [Resume]|
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

---

### Task 5: Pre-Flight, Intervention & Human-in-Loop

**Combines**: Pre-flight checklist, intervention overhaul, human-in-loop upgrade.

**Why this is one task**: These all govern what happens at mission boundaries — before launch, during stuck states, and when human input is needed. They share the permission model and escalation chain.

#### 5A: Pre-Flight Checklist

Shown in the mission launch flow after phase configuration, before the Launch button:

```
+------------------------------------------------------------------+
| PRE-FLIGHT CHECKLIST                                               |
+------------------------------------------------------------------+
| ✓ Models detected & authenticated                                 |
|   Claude Sonnet (Planning, Testing, Validation) — authenticated   |
|   Claude Opus (Development, Orchestrator) — authenticated         |
|                                                                    |
| ✓ Permissions                                                      |
|   Mode: Full Auto (bypass permissions)                             |
|                                                                    |
| ✓ Git worktrees available                                          |
|   3 lanes available for worker assignment                          |
|                                                                    |
| ✓ Phase configuration valid                                        |
|   Profile: Default (5 phases)                                      |
|   Ordering constraints: satisfied                                  |
|   Custom phases: 0                                                 |
|                                                                    |
| ⚠ Budget estimation                                                |
|   Estimated: ~$4.20 / ~45 min                                     |
|   Per-phase: Planning $0.30, Dev $2.80, Test $0.60, Val $0.30,    |
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

---

### Task 6: Budget & Usage Tracking

**Combines**: Budget-aware orchestration decisions, budget management service, subscription usage tracking.

**Why this is one task**: The budget service, usage tracking, and orchestration pressure logic are a single data pipeline. Usage data feeds into budget state, which feeds into orchestration decisions.

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
| `critical` | > 85% budget consumed | Single worker only, skip spot-checks, finish current milestone then stop |

Budget pressure is an input to coordinator decisions, not a hard override — the AI decides what to do with the information.

#### 6D: Budget Display

- **Pre-flight**: estimated cost/time based on similar past missions and selected models. Visual budget bar showing allocation across phases.
- **Mission Details tab**: real-time per-phase and per-worker usage breakdown. Budget consumption chart. Rate limit state indicator.
- **Home Dashboard**: per-mission cost in recent missions list. Weekly cost aggregate.

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
- **Partial completion tests**: `partially_completed` outcome, recovery handoff artifact structure.
- **Long-horizon soak tests**: multi-hour simulated missions covering replans, retries, budget pressure, and validation loops.
- **Provider parity tests**: normalized permission/tool error behavior across Claude and Codex.

#### 8B: Missions Overhaul Tests

- **Phase engine tests**: card CRUD, ordering constraint enforcement (Planning first, Validation after Dev, PR last, Testing flexible), drag-and-drop position updates, phase transition execution, validation gate invocation.
- **Profile tests**: CRUD, built-in integrity, custom creation with constraint validation, per-mission override, import/export roundtrip, `.ade/profiles/` YAML serialization.
- **Plan tab tests**: hierarchical rendering (milestones → tasks → subtasks), real-time update handling, status indicator accuracy.
- **Work tab tests**: worker selector, live output streaming, file list updates, tool call tracking.
- **Pre-flight tests**: model detection per phase (multiple providers), permission validation, structural/ordering/semantic validation, budget check, UI rendering (pass/warning/fail).
- **Tiered validation tests**: self-validation (checklist), spot-check (configurable probability), dedicated validator (spawn, review, report), QA Loop (loop back, max iterations).
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

**Recommended sequence:**

1. **Task 1** (Orchestrator Autonomy Core) — foundational, everything else builds on it
2. **Task 2** (Validation & Lane Continuity) — depends on Task 1 worker tools
3. **Task 3** (Phases Engine & Profiles) — can start in parallel with Tasks 1-2 (data model is independent)
4. **Task 6** (Budget & Usage Tracking) — depends on Task 1 for `get_budget_status` tool
5. **Task 5** (Pre-Flight, Intervention & HITL) — depends on Tasks 2, 3 (needs phase config and validation)
6. **Task 4** (Mission UI Overhaul) — depends on Tasks 1-3 (needs data from phases, worker reporting, plan structure)
7. **Task 7** (Reflection Protocol) — independent, can start anytime but lower priority
8. **Task 8** (Integration Testing) — last, covers everything

**Parallelization opportunities:**
- Tasks 1 + 3 can run in parallel (different system layers)
- Tasks 4 + 7 can run in parallel after their dependencies are met
- Task 6 can start once Task 1 is partially complete (budget service is independent of replanning)

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
- Missions can complete with `partially_completed` outcome and structured recovery handoff
- Provider differences are normalized behind one runtime error/approval contract

**Missions Overhaul:**
- Missions use configurable phase pipelines with drag-and-drop ordering
- Built-in phases ship as defaults; custom phases are validated structurally and semantically
- Phase profiles are configurable in Settings and selectable per-mission with optional overrides
- Pre-flight checklist validates models, permissions, worktrees, phase config, and budget — all checks required
- Plan tab shows hierarchical task list with real-time updates
- Work tab shows live worker output with follow mode
- Tiered validation operates at self-check, spot-check, and dedicated levels per phase card
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
