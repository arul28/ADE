# Phase 4: Agents Hub

## Phase 4 -- Agents Hub (5-6 weeks)

Goal: Rebrand Automations into a unified **Agents** tab and make ADE **agent-first** for all non-interactive AI execution. Users create, configure, and monitor agents that perform work on their behalf: running automations, executing Night Shift tasks, watching repos, handling PR/conflict workflows, and more.

### Core Concept: What Is an Agent?

An **Agent** in ADE is not just a prompt preset. It is a durable unit with explicit definition, runtime, and memory boundaries:

```
Agent System = AgentDefinition + AgentRuntime + AgentMemory + Guardrails
```

- **AgentDefinition**: Identity, policy, trigger, behavior template, profile files, and default memory policy.
- **AgentRuntime**: A concrete execution instance bound to mission/run/thread/session IDs, compute backend, and lane scope.
- **AgentMemory**: Scoped persistence (runtime-thread, run, project, identity) with explicit promotion and provenance.
- **Guardrails**: Budget caps (time, tokens, steps, USD), stop conditions, tool restrictions, and approval requirements.

### Phase 4 Foundational Decision — Agent-First AI Runtime

From Phase 4 forward, ADE routes AI execution as follows:

- **All non-interactive AI calls run via agent runtimes** (missions, PR AI actions, conflict AI actions, night shift, watcher/review checks, background task execution, and future mobile-triggered runs).
- **Interactive development remains direct** in Lanes Work (`Terminal` + `Chat`) for normal day-to-day coding.
- Legacy one-shot AI call paths must be wrapped by a compatibility adapter that creates an ephemeral task-agent runtime and writes standard runtime records.

This keeps observability, memory, and policy enforcement consistent across every AI surface.

### Execution Classes

ADE supports two execution classes:

- **Resident agents**: Triggered by schedule/event/poll; always available as durable definitions with persistent memory namespaces.
- **Task agents**: On-demand, short-lived runtimes created from a definition/template for one job.

Resident agents are "always-on" at the infrastructure/scheduler level, not a continuously thinking model process.

### Chat and Thread Topology

Agent communication is explicitly split:

- **Agent Home Thread** (Agents tab): trains/configures the agent identity and long-term behavior.
- **Runtime Threads** (missions/tasks): execution-local chat tied to run/step/attempt/session IDs.

Memory promotion across these thread types is policy-driven, not automatic transcript merging.

### Context and Memory Architecture (OpenClaw-Inspired, ADE-Owned)

ADE adopts the useful OpenClaw-style ideas while keeping local deterministic control:

- Each run assembles context from bounded layers, not full transcript dumps.
- Agent profile/context files are injected per runtime (identity, tools, user prefs, heartbeat, memory summary).
- Long-term memory stays outside model sessions in ADE-managed storage, with retrieval tools and writeback policy.
- Compaction writes durable facts before replacing large conversation state.
- "Always-on continuity" is achieved by state reconstruction, not immortal model processes.

### Agent Types

| Agent Type | Description | Trigger | Example |
|---|---|---|---|
| **Automation Agent** | Wraps the existing trigger-action automation engine. Runs pipelines of actions (update packs, predict conflicts, run tests, run commands). | Event-driven (commit, session-end, schedule, manual) | "On commit, run lint and unit tests" |
| **Night Shift Agent** | Queued tasks that run unattended during off-hours. Stricter guardrails, budget caps, and stop conditions. Produces a morning digest for review. | Scheduled (time-based, e.g., "run at 2am") | "Refactor auth module overnight, park on failure" |
| **Watcher Agent** | Monitors external resources (upstream repos, APIs, logs, dependency feeds) and surfaces findings. Does not modify code — observation only. | Polling (interval-based) or webhook | "Watch react repo for deprecation notices affecting our codebase" |
| **Review Agent** | Watches the team's PR feed and pre-reviews PRs assigned to the user. Summarizes changes, flags concerns, and provides a morning briefing card. | Polling (GitHub API interval) or webhook | "Pre-review my assigned PRs overnight, summarize in morning briefing" |
| **Task Agent** | One-off background task with custom instructions. Fire-and-forget: define what to do, where to run, and what to produce when done. | Manual or programmatic (launched from Agents tab, command palette, or API) | "Refactor auth module, take screenshots to verify, open a PR" |
| **Concierge** | Entry point for external agent systems. Routes incoming requests from external agents (OpenClaw, Claude Code, etc.) to the appropriate ADE surface. | MCP request | "Route incoming dev tasks from OpenClaw or other external agents" |

All agent types share the same underlying schema, identity system, and guardrail infrastructure. The type determines default behavior templates and UI affordances.

### Reference docs

- [features/AGENTS.md](../features/AGENTS.md) — Agents tab feature doc (renamed from AUTOMATIONS.md)
- [features/MISSIONS.md](../features/MISSIONS.md) — mission launch flow (identity selector), executor policy, autopilot mode
- [features/ONBOARDING_AND_SETTINGS.md](../features/ONBOARDING_AND_SETTINGS.md) — AI usage dashboard and budget controls (agents reuse this infrastructure), identity management UI in Settings
- [architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — per-task-type configuration (identities override these defaults), MCP permission/policy layer (identities constrain tool access)
- [architecture/SECURITY_AND_PRIVACY.md](../architecture/SECURITY_AND_PRIVACY.md) — trust model for unattended execution

### Dependencies

- Phase 3 completion package complete (W13-W22 in `phases-1-3.md`).
- **Hivemind infrastructure available**: `agent_identities` table (HW7), inter-agent messaging (HW3), shared facts/memories (HW4), Slack-like chat (HW2), context compaction (HW6), smart fan-out (HW5). Phase 4 should build on these rather than re-implementing.
- AI call-site inventory complete: every non-interactive AI path has a migration target into `agentRuntimeService`.

### Scope Update from Phase 3 Completion Package

Phase 3 now owns the foundational orchestration runtime upgrades:

1. Mission team templates and required role enforcement
2. Mission policy flags and precedence
3. Structured worker reporting tools
4. Validation contracts and validator loop
5. Lane-affinity rework continuity

Phase 4 should consume these foundations and focus on:

- productizing agent management UX,
- reusable agent identity/policy experiences,
- resident agent categories (Night Shift, Watcher, Review, Concierge),
- memory and ecosystem expansion.

### Workstreams

#### W0: Agent-First Migration Gate

- Inventory and classify all current AI entry points as `interactive` or `non-interactive`.
- Migrate non-interactive call paths to `agentRuntimeService.invoke(...)`.
- Add enforcement checks so new non-interactive AI code paths cannot bypass runtime tracking/policy layers.
- Preserve current UX with compatibility wrappers during migration.

#### W1: Rebrand Automations → Agents

- Rename route: `/automations` → `/agents`.
- Update tab label: "AUTOMATIONS" → "AGENTS" (follows ALL-CAPS label convention from design system).
- Update tab icon: from `zap` (automations) to `bot` (agents) — Lucide icon.
- Update tab numbering in sidebar navigation.
- Rename `AutomationsPage.tsx` → `AgentsPage.tsx`.
- Update all IPC channel references: `ade.automations.*` → `ade.agents.*` (maintain backward-compatible aliases during transition).
- Update config key: `automations:` → `agents:` in `.ade/ade.yaml` and `.ade/local.yaml` (with migration for existing configs).
- Rename feature doc: `features/AUTOMATIONS.md` → `features/AGENTS.md`.

#### W2: Agent Schema + Data Model

- Extend the existing `AutomationRule` schema into a unified `Agent` schema:
- Add explicit separation between definition and runtime records.
- Add `executionClass` (`resident` | `task`) and `runtimeSource` metadata to support consistent tracking across all AI surfaces.
- Add memory policy config (`readScopes`, `writeScopes`, promotion rules, compaction behavior).
- Add runtime profile file definitions for context assembly (`IDENTITY`, `TOOLS`, `USER_PREFS`, `HEARTBEAT`, `MEMORY_SUMMARY`).

```typescript
interface Agent {
  id: string;
  name: string;
  type: 'automation' | 'night-shift' | 'watcher' | 'review' | 'task' | 'concierge';
  description?: string;
  icon?: string;                    // Lucide icon name or emoji
  identity: AgentIdentity;          // Persona + policy profile
  trigger: AgentTrigger;            // When to activate
  behavior: AgentBehavior;          // What to do
  guardrails: AgentGuardrails;      // Budget + stop conditions
  enabled: boolean;
  createdAt: string;                // ISO 8601
  updatedAt: string;                // ISO 8601
}

interface AgentIdentity {
  id: string;
  name: string;                     // e.g., "Careful Reviewer", "Fast Implementer"
  systemPromptOverlay?: string;     // Additional system prompt injected into AI sessions
  modelPreferences: {
    provider: 'claude' | 'codex';
    model: string;                  // e.g., "sonnet", "gpt-5.3-codex"
    reasoningEffort?: string;       // e.g., "low", "medium", "high"
  };
  riskPolicies: {
    allowedTools: string[];         // MCP tools this identity may invoke (empty = all)
    deniedTools: string[];          // MCP tools explicitly denied
    autoMerge: boolean;             // Whether the agent can merge without approval
    maxFileChanges: number;         // Max files the agent can modify per run
    maxLinesChanged: number;        // Max lines changed per run
  };
  permissionConstraints: {
    claudePermissionMode: 'plan' | 'acceptEdits' | 'bypassPermissions';
    codexSandboxLevel: 'read-only' | 'workspace-write' | 'danger-full-access';
    codexApprovalMode: 'untrusted' | 'on-request' | 'never';
  };
  version: number;                  // Incremented on every edit for auditability
  versionHistory: AgentIdentityVersion[];
}

interface AgentTrigger {
  type: 'session-end' | 'commit' | 'schedule' | 'manual' | 'poll' | 'webhook';
  cron?: string;                    // For schedule triggers
  branch?: string;                  // Branch filter for commit triggers
  pollIntervalMs?: number;          // For poll triggers (default: 300000 = 5min)
  pollTarget?: {                    // What to poll
    type: 'github-prs' | 'github-releases' | 'npm-registry' | 'url' | 'custom';
    url?: string;
    repo?: string;                  // GitHub owner/repo
    filter?: string;                // Optional filter expression
  };
  scheduleTime?: string;            // HH:MM for Night Shift (local timezone)
  scheduleDays?: string[];          // ['mon','tue','wed','thu','fri'] for weekday-only
}

interface AgentBehavior {
  // For automation agents: action pipeline
  actions?: AgentAction[];

  // For night-shift agents: mission template
  missionPrompt?: string;           // Natural language mission description
  missionLaneId?: string;           // Target lane (optional, agent can create one)
  prStrategy?: 'integration' | 'per-lane' | 'queue' | 'manual';

  // For watcher agents: observation config
  watchTargets?: WatchTarget[];
  reportFormat?: 'card' | 'summary' | 'diff';

  // For review agents: review config
  reviewScope?: 'assigned-to-me' | 'team' | 'all-open';
  reviewDepth?: 'summary' | 'detailed' | 'security-focused';

  // For task agents: one-off background task
  taskPrompt?: string;              // Natural language task description
  taskLaneId?: string;              // Target lane (optional, agent can create one)
  computeBackend?: 'local' | 'vps' | 'daytona' | 'e2b';
  computeEnvironment?: 'terminal-only' | 'browser' | 'desktop';
  completionBehaviors?: CompletionBehavior[];
}

interface AgentGuardrails {
  timeLimitMs?: number;             // Max wall-clock time per run
  tokenBudget?: number;             // Max tokens per run
  stepLimit?: number;               // Max mission steps per run
  budgetUsd?: number;               // Max USD spend per run
  dailyRunLimit?: number;           // Max runs per 24h period
  stopConditions: StopCondition[];  // When to halt
  requireApprovalFor?: string[];    // Actions requiring user approval before execution
  subscriptionAware?: {             // Night Shift subscription utilization settings
    utilizationMode: 'maximize' | 'conservative' | 'fixed'; // How aggressively to use sub capacity
    conservativePercent?: number;   // For 'conservative' mode: max % of available capacity (default: 60)
    weeklyReservePercent?: number;  // % of weekly budget to always keep for daytime use (default: 20)
    respectRateLimits: boolean;     // Pause/reschedule when rate-limited instead of failing (default: true)
    allowMultipleBatches: boolean;  // Schedule work across rate limit resets (default: true)
    priority?: number;              // Agent priority within Night Shift queue (lower = higher priority)
  };
}

type StopCondition =
  | { type: 'first-failure' }
  | { type: 'budget-exhaustion' }
  | { type: 'rate-limited' }       // Stopped because subscription rate limit hit and no reset within window
  | { type: 'reserve-protected' }  // Stopped to protect weekly reserve threshold
  | { type: 'intervention-threshold'; maxInterventions: number }
  | { type: 'error-rate'; maxErrorPercent: number }
  | { type: 'time-exceeded' };

type CompletionBehavior =
  | { type: 'open-pr'; baseBranch?: string; draft?: boolean }
  | { type: 'screenshot'; pages?: string[] }           // Screenshot specified pages/routes
  | { type: 'record-video'; durationLimitMs?: number }  // Record agent interaction
  | { type: 'attach-artifacts-to-lane' }                // Attach all artifacts to the target lane
  | { type: 'run-tests'; command?: string }             // Run tests and attach results
  | { type: 'notify'; channel?: 'ui' | 'push' }        // Notify user on completion
  | { type: 'custom-command'; command: string };         // Run arbitrary command on completion
```

- Add `agents` table to SQLite (extends existing `automation_runs` schema):

```sql
CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,              -- 'automation' | 'night-shift' | 'watcher' | 'review' | 'task' | 'concierge'
    config TEXT NOT NULL,            -- JSON: full Agent schema
    identity_id TEXT,                -- FK to agent_identities table
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE agent_identities (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,            -- JSON: AgentIdentity schema
    version INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE agent_identity_versions (
    id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES agent_identities(id),
    version INTEGER NOT NULL,
    config TEXT NOT NULL,            -- JSON: snapshot of identity at this version
    changed_by TEXT,                 -- 'user' | 'migration'
    created_at TEXT NOT NULL
);
```

- Existing `automation_runs` and `automation_action_results` tables are preserved and reused for agent run tracking. Add `agent_id` column to `automation_runs` to link runs to agents.

#### W3: Agent Identity System

- **`agentIdentityService`** (main process):
  - CRUD operations for identities.
  - Default preset library shipped with ADE:
    - **Careful Reviewer**: Plan-only permission mode, read-only sandbox, low risk tolerance, security-focused review depth.
    - **Fast Implementer**: Accept-edits permission, workspace-write sandbox, higher file/line limits.
    - **Night Owl**: Designed for Night Shift — conservative guardrails, parks on first failure, generates morning digest.
    - **Code Health Inspector**: Read-only, observation-focused, no code modification allowed, reports findings only.
  - Identity version history: every edit increments version and snapshots the previous config.
  - Identity validation: ensures permission constraints don't exceed project-level AI permission settings.

- **Identity policy enforcement**:
  - When an agent runs, its identity's permission constraints are applied to the AI orchestrator and agent executor.
  - Identity `riskPolicies.allowedTools` filters the MCP tool set available to the orchestrator for that run.
  - Identity `riskPolicies.deniedTools` takes precedence over allowed tools (deny wins).
  - Budget caps from identity guardrails are enforced alongside project-level budget limits (lower of the two wins).

- **Identity management UI** in Settings:
  - Identity list with name, type badge, preset indicator, and version number.
  - Create/edit/clone/delete operations.
  - Effective-policy preview: before saving, show exactly what the identity allows and restricts.
  - Diff view between identity versions for audit.

#### W4: Agents Tab — Card-Based UI

The Agents tab replaces the old Automations list view with a card-based agent grid following the ADE design system (`docs/design-template.md`).

- **Page Layout**:
  ```
  +------------------------------------------------------------------+
  | AGENTS                                          [+ NEW AGENT]     |
  | [All] [Automation] [Night Shift] [Watcher] [Review] [Task] [Search]|
  +------------------------------------------------------------------+
  | ┌──────────────┐ ┌──────────────┐ ┌──────────────┐              |
  | │ 🔧 Lint on   │ │ 🌙 Refactor │ │ 👁 Watch     │              |
  | │    Commit     │ │    Auth      │ │    React     │              |
  | │              │ │              │ │    Releases   │              |
  | │ AUTOMATION   │ │ NIGHT SHIFT  │ │ WATCHER      │              |
  | │ ● Active     │ │ ◐ 2:00 AM   │ │ ● Polling    │              |
  | │ Last: 2m ago │ │ Next: tonight│ │ Last: 1h ago │              |
  | │ ✓ 47 runs    │ │ ✓ 12 runs   │ │ 3 findings   │              |
  | │         [ON] │ │         [ON] │ │         [ON] │              |
  | └──────────────┘ └──────────────┘ └──────────────┘              |
  | ┌──────────────┐ ┌──────────────┐ ┌──────────────┐              |
  | │ 📋 PR Review │ │ 🧹 Code     │ │ ⚡ Refactor  │              |
  | │    Agent      │ │    Health    │ │    Payments  │              |
  | │              │ │              │ │              │              |
  | │ REVIEW       │ │ WATCHER      │ │ TASK         │              |
  | │ ◐ Overnight  │ │ ● Weekly     │ │ ● Running    │              |
  | │ 5 PRs queued │ │ Last: Mon    │ │ Step 4/7     │              |
  | │ 2 flagged    │ │ 14 findings  │ │ PR + tests   │              |
  | │         [ON] │ │         [ON] │ │    [CANCEL]  │              |
  | └──────────────┘ └──────────────┘ └──────────────┘              |
  +------------------------------------------------------------------+
  ```

- **Agent Card** (standard card from design system: `bg-secondary`, `border-default`, `0px` radius):
  - Top: Icon + name (heading-sm, JetBrains Mono 12px/600).
  - Type badge (label-sm, ALL-CAPS, 9px): `AUTOMATION` / `NIGHT SHIFT` / `WATCHER` / `REVIEW` / `TASK` with type-specific accent colors.
  - Status line: active/idle/sleeping/error with colored dot indicator.
  - Stats: last run timestamp, total run count, findings count (for watchers/reviewers).
  - Enable/disable toggle in bottom-right corner.
  - Click opens the Agent Detail panel (right pane or modal).

- **Agent Detail Panel** (split-pane or modal):
  - **Overview tab**: Agent name, description, type, identity selector, trigger config, behavior config, guardrails config.
  - **Runs tab**: Execution history with per-run expandable detail (reuses existing automation run history UI).
  - **Findings tab** (watchers/reviewers only): List of surfaced findings with approve/dismiss/investigate actions.
  - **Edit mode**: Inline editing of all agent fields with save/cancel.
  - **"Run Now" button**: Manual trigger for any agent type.
  - **Delete button** (danger styling from design system).

- **Type filter tabs**: Segmented control at top to filter by agent type (All / Automation / Night Shift / Watcher / Review / Task).
- **Search**: Filter agents by name or description.

#### W5: Custom Agent Builder

A guided wizard for creating new agents, accessible via the "+ NEW AGENT" button.

- **Step 1 — Choose Type**:
  - Five type cards with icon, name, and short description.
  - Each card shows example use cases.
  - Selecting a type loads appropriate defaults for the remaining steps.

- **Step 2 — Configure Identity**:
  - Select an existing identity from the preset library or create a new one inline.
  - Identity picker shows name, model preference, and risk level summary.
  - "Create New Identity" expands an inline form with all identity fields.

- **Step 3 — Set Trigger**:
  - Trigger type selector (visual, not dropdown — each trigger type is a card).
  - Type-specific config:
    - **Event-driven**: Event type dropdown (commit, session-end) + optional branch filter.
    - **Schedule**: Time picker + day selector (weekdays, daily, custom cron).
    - **Poll**: Interval slider + target config (GitHub repo, URL, npm package).
    - **Manual**: No config needed — runs on demand.

- **Step 4 — Define Behavior**:
  - **Automation agents**: Action pipeline builder (add/remove/reorder actions, same as existing automation rule editor).
  - **Night Shift agents**: Mission prompt textarea + lane selector + PR strategy picker.
  - **Watcher agents**: Watch target list + report format selector.
  - **Review agents**: Scope selector + depth selector.
  - **Task agents**: Task prompt textarea + compute backend selector + compute environment selector + completion behavior checklist (screenshot, video, PR, tests, notify).

- **Step 5 — Set Guardrails**:
  - Budget controls: time limit, token budget, step limit, USD cap.
  - Stop conditions: checkboxes for first-failure, budget-exhaustion, intervention-threshold.
  - Daily run limit input.
  - Approval requirements: checkboxes for which actions need user approval.

- **Step 6 — Review & Create**:
  - Full summary of the configured agent.
  - Effective policy preview (what the agent can and cannot do).
  - Simulation preview (human-readable description of what will happen when the agent triggers).
  - "Create Agent" button.

- **Natural Language Creation** (alternative to wizard):
  - "Describe what you want" textarea at the top of the wizard.
  - Reuses the existing `automationPlannerService` NL-to-rule planner, extended for new agent types.
  - AI generates a full agent config from the description.
  - User reviews and edits before saving.

#### W5A: Mission Team Builder Integration (Consumes Phase 3 Foundations)

The mission team builder should be explicit about the difference between reusable agents and mission runtime roles.

- **Framing**:
  - Agents tab manages reusable identities/definitions.
  - Missions tab assembles a mission team from those building blocks.
  - A team role is a capability pool; coordinator may spawn multiple workers from one role.

- **Required system roles for autonomous coding missions**:
  - Coordinator (always on, not removable).
  - Planner capability (required; can run in "light" mode when user provides a plan).
  - Validator capability (required for milestone/mission validation gates).

- **Optional mission roles**:
  - Implementer, tester, reviewer, researcher, security specialist.

- **Policy controls in team builder**:
  - Team defaults for mission policy flags: clarification mode, strict TDD, required validator pass, and risk approval behavior.
  - Policy precedence remains: workspace hard policy -> team defaults -> mission launch overrides.

- **Clarification behavior**:
  - Planner follow-up questions are configured in mission policy (`always`, `auto_if_uncertain`, `off`) with a question cap.
  - This behavior is visible in mission launch and auditable in mission events.

#### W6: Night Shift Mode

Night Shift is not a separate system — it's an agent type with specific UX affordances for unattended overnight execution. The core value proposition is **maximizing subscription utilization during idle hours** — Claude and Codex subscriptions have 5-hour rate limit reset windows, and most developers are asleep for 6-8 hours. Night Shift ensures those tokens don't go to waste by scheduling productive AI work while the user sleeps.

- **Night Shift Service** (`nightShiftService`):
  - Built on top of the agent/automation engine.
  - Manages the Night Shift queue: users queue agents with `schedule` triggers for after-hours execution.
  - Enforces strict guardrails: time limits, step caps, token budgets, USD limits.
  - Stop conditions: `first-failure` (park the mission, don't retry), `budget-exhaustion`, `intervention-threshold` (if an agent hits N intervention requests, park it — unattended means nobody is there to respond).
  - Failed runs are parked with structured failure context (error, last step, files changed, diff snapshot) for morning review.
  - Generates a **Morning Digest** artifact at the end of each Night Shift session.

- **Subscription-Aware Scheduling** (core differentiator):
  - Night Shift monitors the user's subscription utilization via rate limit headers and usage tracking:
    - **Claude**: Tracks rate limit headers (`x-ratelimit-*`) from CLI responses. Detects current usage tier (Pro = lower limits, Max = higher limits). Knows the 5-hour rolling window reset.
    - **Codex**: Tracks rate limit responses from the App Server. Detects subscription tier (Plus = lower, Pro = higher).
  - **Utilization modes** (user-selectable):
    - `maximize`: Use all available capacity before the next reset window. Ideal for users who want to squeeze every token out of their subscription overnight. Night Shift schedules work to fill the gap between when the user sleeps and when rate limits reset.
    - `conservative`: Use up to a user-defined percentage of remaining capacity (e.g., 60%). Leaves headroom for the next day's manual work and respects weekly/monthly aggregate limits. This is the default.
    - `fixed`: Ignore subscription utilization — just run the queued tasks with fixed per-agent budgets. For users who prefer explicit control.
  - **Rate limit awareness**:
    - Before starting each Night Shift agent, the service checks current rate limit state.
    - If a rate limit reset is due at 3am and the user queued work at 11pm, Night Shift can schedule a second batch after the 3am reset to use the refreshed capacity.
    - If remaining capacity is below a configurable threshold (e.g., 10%), Night Shift skips lower-priority agents and logs the skip reason.
  - **Weekly/monthly budget protection**:
    - Users set a weekly token/USD reserve: "always keep at least 20% of my weekly budget for daytime use."
    - Night Shift respects this reserve — it will not consume tokens that would drop the user below their reserve threshold.
    - The reserve is calculated from the AI usage dashboard data (`ai_usage_log` table).
  - **Subscription status display**:
    - Night Shift settings show current subscription tier, current rate limit state, estimated available overnight capacity, and projected utilization based on queued agents.
    - A simple bar visualization: `[████████░░░░] 65% of tonight's capacity will be used by queued agents`.
  - **Existing foundation**: `ai_usage_log` table, `logUsage()`, daily `checkBudget()`, aggregated usage queries, and cost estimation are already implemented. The usage dashboard component (`UsageDashboard.tsx`) exists in the Missions tab. Night Shift subscription-aware scheduling builds on this by adding rate limit header capture, tier detection, weekly aggregation, and the subscription status panel.

- **Night Shift Budget Infrastructure**:
  - Extends the existing per-feature budget infrastructure already implemented in `aiIntegrationService`: `ai_usage_log` SQLite table, `logUsage()` recording, daily `checkBudget()` enforcement, aggregated usage queries, and token cost estimation are all shipped.
  - **New for Phase 4**: subscription-aware scheduling layer — rate limit header parsing from Claude/Codex CLI responses, subscription tier detection (Pro/Max for Claude, Plus/Pro for Codex), weekly usage aggregation for reserve calculations, and multi-batch scheduling across rate limit reset windows.
  - Night Shift runs are constrained by: (1) per-agent guardrails, (2) global Night Shift budget cap, (3) subscription rate limits, and (4) weekly reserve protection. The most restrictive limit wins.
  - Budget enforcement is hard — when any cap is hit, the agent stops immediately with a structured budget-exhaustion record.

- **Morning Digest Generator**:
  - Runs after all Night Shift agents complete (or at a configured morning time, e.g., 7am).
  - Aggregates outcomes from all overnight agent runs.
  - Includes subscription utilization summary: how much capacity was used, how much remains, whether any agents were skipped due to rate limits.
  - Produces a structured digest artifact:
    ```typescript
    interface MorningDigest {
      id: string;
      generatedAt: string;
      nightShiftSessionId: string;
      agents: AgentDigestEntry[];
      totalBudgetUsed: BudgetSummary;
      subscriptionUtilization: SubscriptionUtilizationSummary;
      pendingReviews: number;
      requiresAttention: number;
    }

    interface SubscriptionUtilizationSummary {
      claude?: {
        tier: string;               // e.g., "Pro", "Max"
        tokensUsedOvernight: number;
        tokensAvailableAtStart: number;
        rateLimitResetsHit: number; // How many 5h resets occurred during the session
        capacityUtilized: number;   // 0.0-1.0 percentage of available overnight capacity used
        agentsSkippedDueToLimits: number;
      };
      codex?: {
        tier: string;
        tokensUsedOvernight: number;
        tokensAvailableAtStart: number;
        capacityUtilized: number;
        agentsSkippedDueToLimits: number;
      };
      weeklyReserveRemaining: number; // Percentage of weekly reserve still intact
    }

    interface AgentDigestEntry {
      agentId: string;
      agentName: string;
      status: 'succeeded' | 'failed' | 'parked' | 'budget-exhausted' | 'rate-limited' | 'skipped';
      summary: string;              // AI-generated summary of what happened
      findings?: Finding[];          // For watchers/reviewers
      changesProposed?: ChangeSet[]; // For night-shift agents
      prCreated?: string;            // PR URL if created
      failureContext?: FailureContext;
      budgetUsed: BudgetSummary;
      skipReason?: string;           // Why the agent was skipped (rate limit, reserve protection, etc.)
    }
    ```

#### W7: Morning Briefing UI

A distinctive, swipeable card interface for reviewing Night Shift results — inspired by Tinder/TikTok for rapid decision-making.

- **Morning Briefing View** (accessible from Agents tab or as a modal on app launch after Night Shift runs):
  ```
  +------------------------------------------------------------------+
  | MORNING BRIEFING                    ● ● ● ○ ○  (3/5 reviewed)   |
  +------------------------------------------------------------------+
  |                                                                    |
  |  ┌────────────────────────────────────────────────────────────┐  |
  |  │                                                            │  |
  |  │  🌙 NIGHT SHIFT — Refactor Auth Module                    │  |
  |  │                                                            │  |
  |  │  STATUS: SUCCEEDED                                         │  |
  |  │  Agent: Night Owl · Claude Sonnet · 12 steps               │  |
  |  │                                                            │  |
  |  │  WHAT HAPPENED:                                            │  |
  |  │  Extracted auth middleware into dedicated module,           │  |
  |  │  added refresh token rotation, updated 8 test files.       │  |
  |  │  All 142 tests passing.                                    │  |
  |  │                                                            │  |
  |  │  CHANGES:                                                  │  |
  |  │  +347 -128 across 12 files                                 │  |
  |  │  [View Diff]  [View PR #47]                                │  |
  |  │                                                            │  |
  |  │  CONFIDENCE: ████████░░ 82%                                │  |
  |  │                                                            │  |
  |  │  ┌─────────┐  ┌──────────┐  ┌─────────────────────┐      │  |
  |  │  │ APPROVE │  │ DISMISS  │  │ INVESTIGATE LATER   │      │  |
  |  │  │    ✓    │  │    ✗     │  │         ◷           │      │  |
  |  │  └─────────┘  └──────────┘  └─────────────────────┘      │  |
  |  │                                                            │  |
  |  └────────────────────────────────────────────────────────────┘  |
  |                                                                    |
  |  ← Swipe left: Dismiss    Swipe right: Approve →                 |
  |                                                                    |
  +------------------------------------------------------------------+
  | [BULK APPROVE ALL (3)]                    [SKIP TO SUMMARY]       |
  +------------------------------------------------------------------+
  ```

- **Card Types** in Morning Briefing:
  - **Succeeded Mission**: Shows what changed, diff stats, PR link, confidence score, test results. Actions: Approve (merge PR) / Dismiss (close PR) / Investigate Later.
  - **Failed/Parked Mission**: Shows failure reason, last step, partial changes, error context. Actions: Retry / Dismiss / Investigate Later.
  - **Watcher Finding**: Shows what was detected (deprecation, vulnerability, upstream change), affected files, suggested action. Actions: Create Task / Dismiss / Investigate Later.
  - **PR Review Summary**: Shows PR summary, flagged concerns, suggested comments. Actions: Approve PR / Request Changes / Investigate Later.

- **Interaction Model**:
  - **Swipe right** (or click Approve): Executes the approval action (merge PR, create task, approve review).
  - **Swipe left** (or click Dismiss): Dismisses the finding, logs the decision.
  - **Swipe up** (or click Investigate Later): Moves to an "investigate" queue for later review.
  - **Keyboard shortcuts**: Right arrow = approve, Left arrow = dismiss, Up arrow = investigate, Space = expand details.
  - **Progress indicator**: Dots at top showing total items and how many reviewed.
  - **Bulk actions**: "Approve All" for high-confidence items, "Dismiss All Low-Confidence" quick action.

- **Morning Briefing Trigger**:
  - Automatically shown when user opens ADE after Night Shift agents have completed.
  - Also accessible on-demand from the Agents tab header.
  - Badge count on the Agents tab icon shows pending briefing items.

#### W8: Agent Service Refactor

- Rename and extend `automationService` → `agentService`:
  - All existing automation functionality preserved.
  - New agent types (night-shift, watcher, review) registered as additional behavior executors.
  - Agent lifecycle: `created → idle → triggered → running → completed/failed/parked`.
  - Watcher agents: run a polling loop, compare results against previous state, emit findings on change.
  - Review agents: poll GitHub API for assigned PRs, run AI review on new/updated PRs, emit findings.
  - Night Shift agents: execute missions via the orchestrator with identity constraints and guardrails.

- Rename and extend `automationPlannerService` → `agentPlannerService`:
  - Accepts natural language intent and generates full `Agent` config (not just automation rules).
  - Supports all four agent types.
  - Validates generated configs against identity constraints.

- **IPC Channels** (all prefixed `ade.agents.*`):
  - `ade.agents.list()` → Returns `Agent[]` with status and last run info.
  - `ade.agents.get(id)` → Returns single agent with full config.
  - `ade.agents.create(agent)` → Creates a new agent.
  - `ade.agents.update(id, agent)` → Updates agent config.
  - `ade.agents.delete(id)` → Deletes an agent.
  - `ade.agents.toggle(id, enabled)` → Enable/disable.
  - `ade.agents.triggerManually(id)` → Fire agent immediately.
  - `ade.agents.getHistory(id)` → Returns run history.
  - `ade.agents.getRunDetail(runId)` → Returns detailed run.
  - `ade.agents.getFindings(id)` → Returns findings for watcher/review agents.
  - `ade.agents.dismissFinding(findingId)` → Dismiss a finding.
  - `ade.agents.parseNaturalLanguage(args)` → NL-to-agent planner.
  - `ade.agents.validateDraft(args)` → Validate + normalize draft.
  - `ade.agents.simulate(args)` → Human-readable preview.
  - `ade.agents.event` → Push updates for agent state changes.
  - `ade.agents.identities.list()` → Returns all identities.
  - `ade.agents.identities.get(id)` → Returns single identity.
  - `ade.agents.identities.create(identity)` → Creates identity.
  - `ade.agents.identities.update(id, identity)` → Updates identity.
  - `ade.agents.identities.delete(id)` → Deletes identity.
  - `ade.agents.nightShift.getDigest()` → Returns latest morning digest.
  - `ade.agents.nightShift.getQueue()` → Returns queued Night Shift agents.
  - `ade.agents.briefing.getItems()` → Returns pending morning briefing items.
  - `ade.agents.briefing.respond(itemId, action)` → Approve/dismiss/investigate.
  - `ade.agents.briefing.bulkRespond(actions)` → Bulk approve/dismiss.

#### W9: Settings Integration

- **Settings → Agent Identities section**:
  - Identity list with CRUD operations.
  - Preset library (read-only presets shipped with ADE, user presets editable).
  - Version history viewer per identity.

- **Settings → Agents section** (replaces Automations section):
  - Per-agent summary with enable/disable, run-now, and history links.
  - Night Shift global settings:
    - Default Night Shift time window (e.g., 11pm–6am).
    - Default compute backend for Night Shift agents (local/VPS/Daytona).
    - Morning digest delivery time.
    - Global Night Shift budget cap (applies on top of per-agent caps).
    - **Subscription utilization mode**: `maximize` / `conservative` / `fixed` (default: `conservative`).
    - **Conservative mode percentage**: Slider for max % of available overnight capacity to use (default: 60%).
    - **Weekly reserve**: Slider for % of weekly budget to always protect for daytime use (default: 20%).
    - **Multi-batch scheduling**: Toggle to allow Night Shift to schedule work across rate limit reset windows (default: on).
    - **Subscription status panel**: Live display of current subscription tier per provider, current rate limit state, estimated available overnight capacity, and projected utilization bar based on queued agents.
  - Watcher agent global settings:
    - Default poll interval.
    - GitHub API rate limit awareness.

- **Settings → Compute Backends section** update:
  - "Night Shift default" toggle on VPS backend card: route Night Shift agents to VPS automatically.
  - "Night Shift default" toggle on Daytona backend card: route to Daytona instead.

#### W10: Migration & Backward Compatibility

- Existing automation rules are automatically migrated to agents of type `automation`.
- Migration runs on first load after upgrade:
  1. Read existing `automations:` config key.
  2. For each rule, create an `Agent` with `type: 'automation'`, the same trigger/actions, and a default identity.
  3. Write migrated agents to `agents:` config key.
  4. Preserve the old `automations:` key for one version cycle (deprecated, read-only).
- Existing `automation_runs` records remain queryable via the new agent run history UI.
- IPC backward compatibility: old `ade.automations.*` channels are aliased to `ade.agents.*` for one version cycle.

#### W11: Lane-Level Artifacts

Artifacts become a first-class concept on lanes, not just missions. This enables agents (task agents, chat sessions, mission workers) to attach visual proof, test results, and other outputs directly to the lane where work happened.

- Extend the `mission_artifacts` table into a shared `artifacts` table with polymorphic ownership:
  - `owner_type`: 'mission' | 'lane' | 'agent-run'
  - `owner_id`: mission ID, lane ID, or agent run ID
- New artifact types beyond existing (summary, pr, link, note, patch):
  - `screenshot`: PNG/JPEG image captured from agent environment
  - `video`: Screen recording of agent work (MP4)
  - `test-result`: Structured test output (pass/fail counts, log)
- Lane detail view: new "Artifacts" sub-pane showing attached artifacts with thumbnails
- PR description generator (Phase 1 W8) updated to auto-include lane artifacts in PR body (embedded images, video links)
- Agent chat sessions can produce artifacts: agent takes screenshot → attaches to lane as artifact
- IPC channels: `ade.artifacts.list`, `ade.artifacts.get`, `ade.artifacts.attach`, `ade.artifacts.delete`

#### W12: Learning Packs (Auto-Curated Project Knowledge)

A new context pack type that automatically accumulates project-specific knowledge from agent interactions, building a persistent memory that improves agent performance over time.

- New pack type: `LearningPack` alongside existing Lane/Project/Mission/Feature packs.
- **Knowledge sources** (automatic):
  - Mission/agent run failures and their resolutions (what went wrong, how it was fixed)
  - User interventions during agent work (what the user corrected → inferred rule)
  - Repeated issues across agent chat sessions (same error 3+ times → recorded pattern)
  - PR review feedback patterns (reviewer consistently requests X → recorded preference)
- **Knowledge entries**:
  ```typescript
  interface LearningEntry {
    id: string;
    category: 'mistake-pattern' | 'preference' | 'flaky-test' | 'tool-usage' | 'architecture-rule';
    scope: 'global' | 'directory' | 'file-pattern';  // How broadly it applies
    scopePattern?: string;                              // e.g., "src/auth/**" for directory scope
    content: string;                                    // The actual learning (human-readable rule)
    confidence: number;                                 // 0-1, increases with repeated observations
    observationCount: number;                           // How many times this was observed
    sources: string[];                                  // IDs of missions/sessions that contributed
    createdAt: string;
    updatedAt: string;
  }
  ```
- **Injection**: Learning pack contents are injected into orchestrator context alongside project packs. High-confidence entries (confidence > 0.7) are always included; low-confidence entries are included when scope matches the current task.
- **User review**: Entries are visible and editable in Settings → Learning. Users can confirm, edit, or delete entries. Confirmed entries get confidence boost.
- **Export/import**: Learning packs can be exported to/from CLAUDE.md or agents.md format for interoperability with standard agent config files.
- **Storage**: New `learning_entries` SQLite table with full-text search for efficient retrieval.
- **Privacy**: Learning packs are local-only (never transmitted). They travel with the project directory.

#### W13: Chat-to-Mission Escalation

Bridge between the interactive agent chat (Work Tab) and the mission system. When a chat task grows beyond a single-agent scope, the system can escalate to full mission orchestration.

- **Escalation trigger**: Agent or user recognizes the task needs multiple lanes/agents.
- **Escalation flow**:
  1. In agent chat, user says "this needs a full mission" or agent suggests escalation
  2. Chat context (conversation history, files changed, current state) is packaged as mission input
  3. Mission launcher opens pre-filled with the chat context as the prompt
  4. User confirms → mission created, chat session linked as source
- **Reverse flow**: Mission results can be summarized back into the originating chat session.
- **IPC**: `ade.agentChat.escalateToMission(sessionId)` → opens mission launcher with context.

#### W13A: Agent Chain Missions and Surface Unification

- Mission launcher supports a chain of agent definitions instead of only fixed Planning/Implementation/Test toggles.
- Default mission templates still ship as presets, but resolve to explicit agent-chain configs.
- PR/Conflict "Resolve with AI" flows become named task-agent invocations with standard runtime/memory records.
- Runtime thread links are preserved so agent output remains traceable across missions, PRs, conflicts, and Agents tab history.

#### W14: Validation

- Agent schema validation tests (all six types, all trigger types, all behavior configs).
- Identity policy application tests (identity override precedence, denial enforcement, tool filtering).
- Identity version history tests (version increment, snapshot accuracy, diff correctness).
- Backward compatibility tests for missions with no explicit identity (default identity applied).
- Backward compatibility tests for existing automations (migration preserves behavior exactly).
- Budget enforcement tests (agents stop at budget boundaries — time, tokens, steps, USD).
- Night Shift stop-condition simulations (first-failure parking, intervention-threshold parking, budget-exhaustion).
- Morning digest generation tests (aggregation accuracy, finding deduplication).
- Morning briefing UI interaction tests (approve/dismiss/investigate actions, bulk actions, keyboard shortcuts).
- Watcher agent polling tests (change detection, finding emission, deduplication).
- Review agent PR detection tests (new PR detection, review generation, finding accuracy).
- Agent builder wizard flow tests (all steps, NL creation, validation on create).
- Task agent lifecycle tests (create, run, complete with completion behaviors).
- Completion behavior execution tests (screenshot, video, PR, tests, notify, custom-command).
- IPC backward compatibility tests (old `ade.automations.*` channels still work).
- Config migration tests (existing automations → agents, round-trip correctness).
- Lane-level artifact CRUD tests (attach, list, get, delete across owner types).
- Artifact polymorphic ownership tests (mission, lane, agent-run owners).
- Learning pack entry accumulation tests (auto-capture from failures, interventions, repeated issues).
- Learning pack confidence scoring tests (observation count → confidence increase, user confirmation boost).
- Learning pack injection tests (high-confidence always included, scope-matched low-confidence included).
- Learning pack export/import roundtrip tests (CLAUDE.md format, agents.md format).
- Chat-to-mission escalation flow tests (context packaging, pre-filled launcher, session linking).
- Reverse escalation tests (mission results summarized back into originating chat session).
- Concierge agent routing tests (dev task → mission launch, status query → read state, simple change → task agent, PR review → review agent).
- Concierge learning tests (routing pattern accumulation over time, source-specific defaults).
- Concierge audit trail tests (source identity, request content, routing decision, outcome logged).
- Vector search accuracy tests (hybrid BM25+vector vs keyword-only retrieval quality).
- Pre-compaction flush tests (memories persisted before compaction, flush counter prevents double-flush).
- Memory consolidation tests (PASS/REPLACE/APPEND/DELETE operations with cosine similarity threshold).
- Episodic memory extraction tests (post-session and post-mission summaries generated with correct structure).
- Procedural memory extraction tests (pattern detection from repeated episodic memories).
- Composite scoring tests (recency decay with 30-day half-life, importance weighting, access boost capping).
- Memory tier promotion/demotion tests (Tier 2 → Tier 3 decay, Tier 2 → Tier 1 pinning).
- `.ade/` portability tests (state round-trip across machines, git-based sync, local.yaml isolation).
- External MCP consumption tests (tool discovery, namespace prefixing, lifecycle management, reconnection).
- External MCP permission tests (identity allowedTools/deniedTools enforcement on external tools).
- External MCP configuration tests (.ade/local.yaml parsing, stdio and SSE transport support).

#### W15: Concierge Agent

The Concierge Agent is a special agent type that serves as ADE's **single entry point for external systems**. External agents (OpenClaw, Claude Code, etc.) connect via MCP and talk to the Concierge, which understands all of ADE's capabilities and routes requests to the appropriate surface.

- **Request routing**: The Concierge receives incoming requests and classifies them:
  - Development tasks (e.g., "implement feature X") → launches missions via the mission planner
  - Status queries (e.g., "what's the state of the auth refactor?") → reads mission/lane state and returns structured status
  - Simple code changes (e.g., "fix the typo in README") → creates task agents for lightweight execution
  - PR reviews (e.g., "review PR #42") → routes to review agents
- **Concierge identity and memory**: The Concierge has its own persistent identity and memory namespace. It learns routing patterns over time — e.g., if OpenClaw consistently sends tasks that require multi-lane missions, the Concierge learns to default to mission planning for that source.
- **Optional**: The Concierge is not required for normal ADE usage. Users can still interact with ADE directly via the UI, CLI, or MCP server. The Concierge is specifically for external agent-to-ADE communication.
- **MCP exposure**: The Concierge registers as an MCP tool (`ade.concierge.request`) that external agents can invoke. The request schema accepts a natural language intent plus optional structured hints (target repo, urgency, preferred strategy).
- **Response protocol**: The Concierge returns structured responses to external agents: acknowledgment with a tracking ID, status updates via polling or callback, and final results when the routed work completes.
- **Audit trail**: All Concierge-routed requests are logged with source agent identity, request content, routing decision, and outcome. This provides full traceability for externally-initiated work.

#### W16: Memory Architecture Upgrade

A comprehensive upgrade to ADE's agent memory system, introducing tiered storage, vector search, composite scoring, pre-compaction flushing, memory consolidation, episodic memory, procedural memory, and portable `.ade/` directory storage.

##### Three-Tier Memory

```
Tier 1: Core Memory (always in context, ~2-4K tokens)
  - Agent persona block (identity, role)
  - Current task context (what am I working on)
  - Critical project conventions
  - Self-editable via memoryUpdateCore tool

Tier 2: Hot Memory (retrieved on demand via hybrid search)
  - Recent episodic memories
  - Relevant semantic memories (facts, patterns, decisions)
  - Mission shared facts
  - Retrieved via composite scoring

Tier 3: Cold Memory (archival, searched rarely)
  - Old episodic memories
  - Low-importance facts
  - Archived/superseded memories
  - Stored in .ade/memory/archive/
```

##### Vector Search with sqlite-vec

- Add `sqlite-vec` extension to the existing SQLite database (works with `better-sqlite3` in Electron).
- Store embeddings alongside memory records in a `memory_vectors` table.
- Hybrid search: BM25 keyword (30% weight) + vector similarity (70% weight).
- **MMR re-ranking**: Maximal Marginal Relevance with lambda=0.7 to reduce redundant results in retrieval.
- Embedding strategy: local GGUF model (`all-MiniLM-L6-v2`, ~25MB, 384 dimensions) for offline operation, OpenAI `text-embedding-3-small` (1536 dimensions) as fallback when online. Retrieval pipeline normalizes across both dimension sizes.
- **Scalability**: sqlite-vec uses brute-force KNN — performant up to ~100K vectors, which is more than sufficient for per-project memory (typical project accumulates hundreds to low thousands of memories). If a project exceeds this threshold, cold archival (Tier 3) keeps the active vector count manageable.
- Cache embeddings to avoid recomputation — embeddings are stored in `.ade/embeddings.db` (gitignored, regenerated on new machine in ~30s background job on first startup).
- Budget tiers control how many memories are injected into agent context: **Lite (3 entries)** for quick tasks, **Standard (8 entries)** for normal agent work, **Deep (20 entries)** for mission planning and complex reasoning.

##### Composite Scoring for Retrieval

```typescript
function computeMemoryScore(memory: Memory, semanticSimilarity: number): number {
  const ageDays = daysSince(memory.lastAccessedAt);
  const recencyScore = Math.pow(0.5, ageDays / 30); // 30-day half-life
  const importanceScore = { high: 1.0, medium: 0.6, low: 0.3 }[memory.importance];
  const accessBoost = Math.min(memory.accessCount / 10, 1.0);

  return (0.5 * semanticSimilarity) +
         (0.2 * recencyScore) +
         (0.2 * importanceScore) +
         (0.1 * accessBoost);
}
```

Memories are ranked by this composite score during retrieval. The weights ensure that semantically relevant memories dominate, but frequently accessed and recent memories get a meaningful boost.

##### Pre-Compaction Memory Flush

- Before context compaction (at 70% threshold, already shipped in Hivemind HW6), trigger a silent agentic turn.
- The agent is prompted to persist important memories to disk before context is lost.
- Uses the agent's own intelligence to decide what matters — the agent reviews its current context and calls memory tools to save anything it deems important.
- Flush counter prevents double-flushing: each compaction event is assigned a monotonic ID, and the flush is skipped if the current ID has already been flushed.
- Integrates with existing `compactionEngine.ts` via a pre-compaction hook.

##### Memory Consolidation

- When a new memory is saved, compare against existing memories using cosine similarity (threshold > 0.85).
- If a similar memory is found, invoke an LLM to decide the consolidation action:
  - **PASS**: New memory is redundant — discard it silently.
  - **REPLACE**: New memory supersedes the existing one — update the existing record with new content.
  - **APPEND**: Both contain unique information — merge them into a single, richer memory.
  - **DELETE**: Existing memory is obsolete in light of new information — remove the old one and save the new one.
- Runs on save, not as a batch job — keeps memory clean in real-time.
- Prevents unbounded growth by ensuring the memory store does not accumulate near-duplicate entries.

##### Episodic Memory

After each session or mission completes, generate a structured summary capturing what happened, what was learned, and what to remember for next time.

```typescript
interface EpisodicMemory {
  id: string;
  sessionId?: string;
  missionId?: string;
  taskDescription: string;
  approachTaken: string;
  outcome: 'success' | 'partial' | 'failure';
  toolsUsed: string[];
  patternsDiscovered: string[];
  gotchas: string[];
  decisionsMade: string[];
  duration: number;
  createdAt: string;
}
```

Episodic memories are generated by prompting the agent to reflect on the completed work. They are stored as Tier 2 (hot) memories initially and decay to Tier 3 (cold) over time based on access patterns.

##### Procedural Memory

```typescript
interface ProceduralMemory {
  id: string;
  trigger: string;       // When to apply (e.g., "when running tests in the auth module")
  procedure: string;     // What to do (e.g., "always run migrations first, then seed, then test")
  confidence: number;    // 0-1, increases with successful applications
  successCount: number;  // How many times this procedure led to success
  failureCount: number;  // How many times this procedure led to failure
  lastUsed: string;      // ISO 8601 timestamp
}
```

Procedural memories are extracted from episodic memories when a pattern is observed multiple times. They encode learned workflows that agents can apply automatically when the trigger condition matches.

##### New Memory Tools for Agents

- **`memorySearch`** — Upgraded with hybrid BM25+vector search. Agents call this to retrieve relevant memories during execution. Returns results ranked by composite score.
- **`memoryAdd`** — Upgraded with consolidation check. When an agent saves a new memory, the system automatically checks for near-duplicates and consolidates as needed.
- **`memoryUpdateCore`** — Self-edit Tier 1 working context. Agents can update their own core memory block (persona, current task context, critical conventions) without a full memory save cycle.
- **`memoryPin`** — Pin a critical memory to Tier 1. Ensures the memory is always included in context, bypassing the retrieval scoring system.

##### Prior Art & Design References

ADE's memory architecture is informed by research across the agent memory landscape. This section documents the external systems and academic findings that shaped our design decisions.

**Tiered Memory Hierarchy — MemGPT / Letta**
The three-tier model (Core / Hot / Cold) is directly inspired by MemGPT (now Letta). MemGPT introduced the idea of treating LLM context as "main memory" and external storage as "disk", with the agent managing its own memory via explicit read/write operations. Their architecture uses core memory blocks (always in context, self-editable), archival memory (vector-searched cold storage), and recall memory (conversation history). ADE adapts this into Tier 1/2/3 with the addition of composite scoring and cross-machine portability via `.ade/`. Letta's benchmark found that simple file operations achieved 74% accuracy on memory tasks — validating our choice of file-based portable storage over complex database replication.

**Memory Consolidation — Mem0**
The PASS/REPLACE/APPEND/DELETE consolidation model is adapted from Mem0's memory management system. Mem0 performs real-time deduplication on every write by comparing new memories against existing entries using cosine similarity. When overlap is detected, an LLM decides whether to keep both (PASS), replace the old (REPLACE), merge them (APPEND), or remove the old one (DELETE). ADE uses Mem0's approach with a conservative 0.85 similarity threshold and extends it with scope-aware matching (only compare within the same memory scope). Mem0's benchmark (68.5% accuracy) and Letta's (74%) both informed our decision to keep the consolidation model simple and file-backed.

**Composite Scoring — CrewAI**
The weighted composite score formula (`semantic(0.5) + recency(0.2) + importance(0.2) + access(0.1)`) is adapted from CrewAI's memory retrieval system. CrewAI's `RecallFlow` uses a similar multi-signal approach combining semantic similarity with temporal decay and access frequency. ADE simplifies the weights for predictability and adds the explicit importance dimension (user-set tags rather than inferred importance).

**Pre-Compaction Flush — OpenClaw**
The silent agentic turn before context compaction is inspired by OpenClaw's memory management. OpenClaw uses Markdown-based memory files (MEMORY.md + daily logs) that the agent reads and writes as part of its workflow. Before context is evicted, the agent is prompted to persist anything important — using the agent's own intelligence rather than a mechanical extractor. ADE formalizes this with a flush counter (prevent double-flush) and integration with the compaction engine's threshold system.

**Hybrid BM25 + Vector Search — OpenClaw / RAG Literature**
OpenClaw's memory search combines keyword (BM25) and semantic (vector) search with configurable weights. This hybrid approach is well-established in RAG literature — BM25 excels at exact identifier matching (function names, error codes) while vector search finds conceptually related content. ADE adopts the 30/70 BM25/vector split with MMR re-ranking to reduce result redundancy.

**Episodic & Procedural Memory — LangMem / LangChain**
LangMem (LangChain's memory research project) introduced the taxonomy of episodic memory (structured post-session summaries) and procedural memory (learned tool-usage patterns) for LLM agents. ADE's `EpisodicMemory` and `ProceduralMemory` interfaces are informed by LangMem's approach, adapted with confidence scoring and self-reinforcement (success/failure counts). LangMem's key insight: procedural memories should be extracted from recurring episodic patterns, not from individual sessions — ADE follows this by requiring pattern observation across multiple episodes before creating a procedural entry.

**Zettelkasten-Inspired Linking — A-MEM**
A-MEM's research applies Zettelkasten (networked note-taking) principles to LLM memory. Each memory entry is enriched with automatic links to related entries, creating a knowledge graph rather than a flat list. While ADE does not implement full Zettelkasten linking in Phase 4, the consolidation system's APPEND operation creates implicit links, and the composite scoring formula ensures related memories surface together. Full graph-based memory navigation is a candidate for a future phase.

**Observation Masking — JetBrains NeurIPS 2025**
JetBrains' research (presented at NeurIPS 2025 Agentic AI workshop) found that **observation masking** — replacing old tool outputs with simple placeholders — outperforms LLM-based summarization for context management while being significantly cheaper. Their finding: replacing `<tool_output>full output here</tool_output>` with `<tool_output>[output omitted]</tool_output>` preserves agent performance better than asking an LLM to summarize the output. ADE applies this in context assembly: when building prompts for resumed sessions, old tool outputs beyond the most recent N are masked rather than summarized.

**Context Window Separation — Elvis Sun (ZOE/CODEX)**
Elvis Sun's ZOE/CODEX architecture (documented in his X thread and community discussions) demonstrates the principle of separating business context from code context. His setup uses ZOE as an orchestrator managing business logic and decision-making in one context window, while CODEX workers handle pure code generation in separate windows. This informed ADE's leader/worker separation: the orchestrator maintains mission context (planning, coordination, decisions) while workers maintain code context (file contents, test results, implementation details). Context windows are zero-sum — mixing both degrades both.

**SOUL.md Pattern — Community Practice**
The identity persistence pattern using versioned Markdown files to define agent persona, voice, constraints, and behavioral rules emerged from community practice around Claude Code's `CLAUDE.md` and OpenClaw's `MEMORY.md`. ADE formalizes this as `.ade/identities/*.yaml` with explicit version history and audit trail, extending the informal pattern into a structured, policy-enforced system.

##### Storage: .ade/ Directory for Portability

```
.ade/
├── memory/
│   ├── project.json          # Project-level facts (Tier 2/3)
│   ├── learning-pack.json    # Auto-curated knowledge
│   ├── archive/              # Cold storage (Tier 3)
│   └── agents/
│       ├── night-owl.json    # Agent identity memory
│       └── reviewer.json     # Agent identity memory
├── agents/
│   ├── night-owl.yaml        # Agent definition
│   └── reviewer.yaml         # Agent definition
├── history/
│   └── missions.jsonl        # Mission run log (append-only)
└── embeddings.db             # sqlite-vec embeddings cache
```

- Committable to the repo for cross-machine sync.
- **Git IS the sync layer** — no hub, no cloud sync service needed. Any machine with the repo has full ADE state.
- `.ade/local.yaml` (gitignored) holds machine-specific overrides (API keys, local paths, external MCP server configs).
- Agent definitions in `.ade/agents/` are YAML files that can be hand-edited, shared across teams, and version-controlled alongside the code they operate on.

#### W17: External MCP Consumption

ADE agents can consume external MCP servers, not just expose one. This is how ADE agents reach beyond the codebase without ADE having to build every integration natively.

- **Configuration**: External MCP servers are declared in `.ade/local.yaml` under an `externalMcp` key:
  ```yaml
  externalMcp:
    - name: web-browser
      transport: stdio
      command: npx
      args: ["-y", "@anthropic/mcp-web-browser"]
    - name: notion
      transport: sse
      url: https://mcp.notion.so/sse
      headers:
        Authorization: "Bearer ${NOTION_TOKEN}"
    - name: linear
      transport: stdio
      command: npx
      args: ["-y", "@anthropic/mcp-linear"]
  ```
- **Tool discovery**: On startup, ADE connects to declared external MCP servers, discovers their available tools, and registers them in the agent tool namespace with a prefix (e.g., `ext.web-browser.navigate`, `ext.notion.search`).
- **Agent access**: During execution, agents gain access to external tools based on their identity's `allowedTools` / `deniedTools` policy. External tools follow the same permission model as built-in tools.
- **Use cases**:
  - Agent needs to browse the web → connects to an MCP server that provides web browsing tools
  - Agent needs to read Notion documentation → connects to Notion MCP server
  - Agent needs to create Linear issues → connects to Linear MCP server
  - Agent needs to query a database → connects to a database MCP server
- **Lifecycle management**: ADE manages the lifecycle of external MCP server connections — starting them on demand, health-checking, reconnecting on failure, and shutting down when no agents need them.
- **Security**: External MCP tools are subject to the same guardrail enforcement as built-in tools. Identity `deniedTools` can block specific external tools. Budget enforcement applies to external tool invocations that incur costs.

### Phase 4 / Phase 5.5 Bridge Notes

Phase 4 introduces Task Agents with `computeBackend`, `computeEnvironment`, and completion behavior fields (screenshot, video) that reference infrastructure built in Phase 5.5. This is intentional — Phase 4 establishes the schema and UI; Phase 5.5 activates the full capabilities.

**Task Agents in Phase 4** (before Phase 5.5 is built):
- `computeBackend` field is present in the schema but defaults to `'local'`. UI shows the selector with Daytona/E2B options grayed out as "Available after Phase 5.5."
- `computeEnvironment` field defaults to `'terminal-only'`. Browser and desktop options are grayed out as "Available after Phase 5.5."
- Completion behaviors `screenshot` and `record-video` are configurable but display a note: "Requires computer use backend (Phase 5.5)." If selected, they are stored in config but skipped during execution until Phase 5.5 MCP tools are available.
- Task Agents **fully function** in Phase 4 for terminal-only local execution: custom prompts, lane creation, PR opening, test running, and notification all work without Phase 5.5.

**Phase 5.5 activation**:
- When Phase 5.5 ships, the grayed-out options in the Task Agent builder activate automatically — no schema migration needed.
- Computer Use MCP tools (`screenshot_environment`, `record_environment`, etc.) become available to all agent types, not just Task Agents.
- Daytona and E2B backends become selectable for any agent type that declares a compute backend preference.
- All compute backends mount runtime profile/context files consistently so behavior is portable across local/VPS/Daytona/E2B.

### Exit criteria

- Automations tab is fully rebranded as Agents with card-based UI following the ADE design system.
- All non-interactive AI surfaces execute through agent runtimes with unified audit and policy enforcement.
- Users can create agents of all six types via the guided wizard or natural language.
- Agent identities provide reusable persona/policy profiles that constrain agent behavior.
- Agent runtime records preserve source surface (`mission`, `pr`, `conflict`, `agents`, `mobile`) and thread lineage.
- Identity policy is consistently enforced by both AI orchestrator and deterministic runtime.
- Identity changes are versioned and auditable.
- Night Shift agents execute unattended with hard guardrails (budget caps, stop conditions).
- Morning Briefing UI provides a swipeable card interface for rapid review of overnight results.
- Morning digest consistently summarizes outcomes, findings, and pending reviews.
- Watcher and Review agents surface actionable findings via the Morning Briefing.
- Existing automations are seamlessly migrated to automation agents with no behavior change.
- Night Shift runs can be inspected and audited like manual missions.
- Agent builder supports both guided wizard creation and natural language description.
- Task agents execute one-off background tasks with configurable completion behaviors (screenshot, video, PR, tests, notify).
- Lane-level artifacts support polymorphic ownership (mission, lane, agent-run) with screenshot, video, and test-result types.
- Lane detail view shows attached artifacts with thumbnails; PR descriptions auto-include lane artifacts.
- Learning packs accumulate project knowledge from agent interactions with confidence scoring and scope matching.
- Learning pack entries are visible and editable in Settings; export/import to CLAUDE.md format is supported.
- Chat-to-mission escalation packages chat context into a pre-filled mission launcher; mission results can be summarized back into the originating chat.
- Agent Home threads and Runtime threads are distinct with explicit memory promotion policy between them.
- Task Agents execute successfully with local/terminal-only defaults. Compute backend and environment selectors display Phase 5.5 options as "coming soon" with graceful fallback.
- Concierge Agent routes external requests to appropriate ADE surfaces (missions, task agents, review agents, state queries).
- Concierge learns routing patterns over time and maintains its own identity and memory.
- Memory retrieval uses hybrid BM25+vector search with composite scoring (semantic similarity, recency, importance, access frequency).
- Pre-compaction flush prevents memory loss during context compaction by triggering agent-driven memory persistence.
- Memory consolidation prevents unbounded growth via real-time deduplication on save (PASS/REPLACE/APPEND/DELETE).
- Episodic memories are generated after session/mission completion with structured summaries of approach, outcome, and learnings.
- Procedural memories are extracted from recurring episodic patterns and applied automatically when trigger conditions match.
- `.ade/` directory provides portable state across machines — git is the sync layer, no external service required.
- ADE agents can consume external MCP servers for extended capabilities (web browsing, Notion, Linear, databases, etc.).
- External MCP tools are subject to the same identity-based permission model and guardrail enforcement as built-in tools.
