# CTO — Persistent Project-Aware Agent

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-12
>
> **Status: W1-W4, W6, W6½, W7a, W7b, W8, W9, and W10 complete at baseline or better; W5b/W-UX/W7c remain in follow-through** — CTO core identity, worker org chart, heartbeat/activation, bidirectional Linear sync, onboarding/memory/worker UI surfaces, the native memory upgrade, the ADE-managed external MCP substrate, the OpenClaw bridge, and portable `.ade/` state are in the codebase. Remaining Phase 4 work is concentrated in automations polish, UX polish, and advanced knowledge capture validation.

---

## Table of Contents

- [Overview](#overview)
  - [Why a CTO Agent](#why-a-cto-agent)
  - [Design Philosophy](#design-philosophy)
- [Org Chart & Worker Agents](#org-chart--worker-agents)
  - [The Org Model](#the-org-model)
  - [Agent Identity Schema](#agent-identity-schema)
  - [Worker Lifecycle](#worker-lifecycle)
  - [Multi-Adapter Pattern](#multi-adapter-pattern)
  - [Config Versioning](#config-versioning)
- [Heartbeat & Activation](#heartbeat--activation)
  - [Heartbeat Policy](#heartbeat-policy)
  - [Two-Tier Execution](#two-tier-execution)
  - [Wakeup Coalescing & Deferred Promotion](#wakeup-coalescing--deferred-promotion)
  - [Issue Execution Locking](#issue-execution-locking)
- [Bidirectional Linear Sync](#bidirectional-linear-sync)
  - [Inbound: Linear to ADE](#inbound-linear-to-ade)
  - [Outbound: ADE to Linear](#outbound-ade-to-linear)
  - [Reconciliation](#reconciliation)
  - [Auto-Dispatch Policies](#auto-dispatch-policies)
  - [Mission Templates](#mission-templates)
- [Per-Agent Budget Management](#per-agent-budget-management)
- [Core Capabilities](#core-capabilities)
  - [Mission Creation & Management](#mission-creation--management)
  - [Lane Management](#lane-management)
  - [Project State Awareness](#project-state-awareness)
  - [Question Answering](#question-answering)
  - [Request Routing](#request-routing)
  - [Automation Ownership & Execution](#automation-ownership--execution)
- [Memory Architecture](#memory-architecture)
  - [Three-Tier Memory Integration](#three-tier-memory-integration)
  - [Auto-Compaction](#auto-compaction)
  - [Temporal Decay & Composite Scoring](#temporal-decay--composite-scoring)
  - [Knowledge Accumulation](#knowledge-accumulation)
- [Identity & State](#identity--state)
  - [.ade/ Agent Directories](#ade-agent-directories)
  - [Identity Persistence](#identity-persistence)
  - [State Portability](#state-portability)
- [Interaction Model](#interaction-model)
  - [Persistent Chat Interface](#persistent-chat-interface)
  - [Conversation Patterns](#conversation-patterns)
  - [Always-On Availability](#always-on-availability)
- [External Integration](#external-integration)
  - [MCP Tool Surface](#mcp-tool-surface)
  - [External Agent Workflow](#external-agent-workflow)
  - [OpenClaw & Other Agents](#openclaw--other-agents)
- [Relationship to Missions](#relationship-to-missions)
  - [Strategic vs Tactical](#strategic-vs-tactical)
  - [CTO to Mission Flow](#cto-to-mission-flow)
- [Multi-Device Reachability](#multi-device-reachability)
- [Prior Art](#prior-art)
- [Deferred Design](#deferred-design)

---

## Overview

The **CTO** (Chief Technical Officer) is ADE's always-on, persistent, project-aware AI agent. It occupies its own tab in the ADE desktop app and serves as the single point of contact for all project-level questions, decisions, and actions. The CTO replaces the former Concierge Agent concept with a broader mandate: rather than simply routing requests, the CTO is a persistent agent that accumulates deep knowledge about the entire project and uses that knowledge to make informed decisions, create missions, manage lanes, answer questions, and supervise persistent employees that can be assigned automations from the Automations tab.

The CTO is the answer to a fundamental problem with current AI coding tools: every conversation starts from scratch. Context is expensive to rebuild, and even the best retrieval systems lose nuance. The CTO solves this by maintaining a persistent identity with three-tier memory (core/hot/cold) and auto-compacting context that ensures it never truly forgets. Facts, decisions, architectural patterns, team preferences, and project history accumulate over time and are always available.

### Why a CTO Agent

Traditional AI assistants are **session-scoped** — they know nothing before the conversation starts and forget everything when it ends. Project-level knowledge (architecture decisions, coding conventions, dependency choices, past failures, team preferences) must be re-explained every session. This is wasteful and error-prone.

The CTO agent is **identity-scoped** — it persists across all sessions, accumulates project knowledge over time, and brings that knowledge to every interaction. After a few weeks of use, the CTO knows the project as well as a senior team member who has been on the project from day one.

Key differentiators from session-scoped assistants:

| Aspect | Session-Scoped Assistant | CTO Agent |
|---|---|---|
| **Knowledge lifetime** | Dies with the session | Persists forever (three-tier memory) |
| **Project awareness** | Must be told every time | Accumulates automatically |
| **Decision context** | Isolated to current conversation | Full history of past decisions |
| **Routing intelligence** | Requires explicit instructions | Learns preferences over time |
| **Cross-session continuity** | None | Seamless — picks up where it left off |

### Design Philosophy

The CTO is modeled after a real-world Chief Technical Officer — someone who:

- **Knows the entire codebase** and its history, not just the file currently open.
- **Remembers past decisions** and their rationale, so the team does not repeat mistakes.
- **Makes autonomous decisions** when the path is clear and escalates when it is not.
- **Delegates effectively** — creates missions and spins up lanes for tactical work rather than doing everything inline.
- **Communicates proactively** — surfaces issues, progress, and recommendations without being asked.
- **Learns continuously** — every interaction makes it more effective.

---

## Org Chart & Worker Agents

The CTO is not a solo agent — it's the head of a configurable **technical org chart**. Users create specialized worker agents (Backend Dev, Mobile Dev, QA Engineer, etc.) that report to the CTO. All agents have full ADE knowledge via MCP tools and can be talked to directly, but their memory is intentionally layered rather than fully merged.

> **Prior art**: Org model from [Paperclip](https://github.com/paperclipai/paperclip). Heartbeat from Paperclip + [OpenClaw](https://github.com/openclaw/openclaw). Linear integration from [Symphony](https://github.com/openai/symphony).

### The Org Model

```
User (Board of Directors)
 │
 ├── talks to ──→ CTO Agent (persistent, memory tiers, project-aware)
 │                   │
 │                   ├── manages ──→ Worker: "Backend Dev"
 │                   │                 ├── adapterType: claude-local
 │                   │                 ├── heartbeat: wakeOnDemand
 │                   │                 ├── budget: $50/mo
 │                   │                 └── capabilities: ["api", "db", "tests"]
 │                   │
 │                   ├── manages ──→ Worker: "Mobile Dev"
 │                   │                 ├── adapterType: openclaw-webhook
 │                   │                 ├── heartbeat: wakeOnDemand
 │                   │                 ├── budget: $30/mo
 │                   │                 └── capabilities: ["react-native", "ios"]
 │                   │
 │                   └── manages ──→ Worker: "QA Engineer"
 │                                    ├── adapterType: claude-local
 │                                    ├── heartbeat: 600s (slow check)
 │                                    └── capabilities: ["testing", "e2e", "accessibility"]
 │
 └── talks to ──→ Any Worker directly (bypass CTO for quick asks)
```

- The CTO is always the root node (`reportsTo: null`). Workers report to CTO by default.
- Users can create sub-hierarchies (e.g., a "Lead Backend Dev" with junior workers under it).
- Cycle detection prevents circular reporting chains (max 50 hops).
- Chain-of-command traversal: any worker can escalate to its manager, up to CTO.
- When an agent is removed, its direct reports are unlinked (set to `reportsTo: null`), not deleted.

### Agent Identity Schema

Every agent (CTO and workers) has a persistent identity record:

```typescript
interface AgentIdentity {
  id: string;                    // UUID
  name: string;                  // "Backend Dev", "Mobile Dev", "QA Engineer"
  role: AgentRole;               // 'cto' | 'engineer' | 'qa' | 'designer' | 'devops' | 'researcher' | 'general'
  title?: string;                // Optional display title
  reportsTo: string | null;      // Parent agent ID (null = root CTO)
  capabilities: string[];        // ["api", "db", "tests", "react-native", "ios"]
  status: AgentStatus;           // 'idle' | 'active' | 'paused' | 'running'

  // Adapter: how the agent executes
  adapterType: AdapterType;      // 'claude-local' | 'codex-local' | 'openclaw-webhook' | 'process'
  adapterConfig: Record<string, unknown>;

  // Runtime
  runtimeConfig: {
    heartbeat?: HeartbeatPolicy;
    maxConcurrentRuns?: number;  // 1-10, default 1
  };

  // Budget
  budgetMonthlyCents: number;    // 0 = unlimited
  spentMonthlyCents: number;     // Auto-tracked, resets monthly

  // Metadata
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

### Worker Lifecycle

1. **Creation**: User creates a worker via CTO tab → "Add Worker" button, or CTO proposes hiring a worker (with user approval).
2. **Configuration**: Set name, role, capabilities, adapter type, heartbeat policy, budget.
3. **Activation**: Worker becomes `idle` and listens for wakeups (heartbeat timer or on-demand).
4. **Execution**: When woken (by CTO dispatch, user message, or heartbeat), worker activates and processes work.
5. **Pausing**: Manual pause, budget exhaustion, or CTO decision. Worker stops accepting new work.
6. **Termination**: Worker is deactivated. Identity and memory are preserved for audit but agent no longer runs.

### Multi-Adapter Pattern

Same agent interface, different execution backends:

| Adapter | Use Case | Execution Model |
|---------|----------|-----------------|
| `claude-local` | Code-focused workers | Spawns Claude Code CLI with model/cwd/instructions |
| `codex-local` | OpenAI-native workflows | Spawns Codex CLI via app-server protocol |
| `openclaw-webhook` | Remote workers on external infrastructure | HTTP POST to OpenClaw agent endpoint |
| `process` | Specialized tools, custom scripts | Generic subprocess with custom command |

Workers are hot-swappable — change adapter type without losing identity or memory. Adapter config holds backend-specific settings (model, CLI args, webhook URL, timeout, etc.).

### Config Versioning

Every change to an agent's config creates a revision with before/after snapshots:

- **Tracked fields**: name, role, title, reportsTo, capabilities, adapterType, adapterConfig, runtimeConfig, budgetMonthlyCents.
- **Changed-keys detection**: Only records which fields actually changed.
- **Rollback**: Revert to any previous revision. Redacted-secret protection prevents rollback to revisions where secrets were scrubbed.
- **Audit trail**: "Changed QA Engineer's prompt on March 3 to include accessibility checks → test pass rate improved 15%."

---

## Heartbeat & Activation

The heartbeat system determines when and how agents wake up. It combines scheduled activation (checking for work), event-driven triggers (task assigned), and intelligent deduplication.

### Heartbeat Policy

```typescript
interface HeartbeatPolicy {
  enabled: boolean;              // Whether timer-based wakeups fire
  intervalSec: number;           // Seconds between automatic checks (0 = no timer)
  wakeOnDemand: boolean;         // Allow event-driven wakeups
  activeHours?: {                // Optional time window
    start: string;               // "09:00"
    end: string;                 // "22:00"
    timezone: string;            // IANA timezone or "local"
  };
}
```

| Agent | Default intervalSec | wakeOnDemand | Notes |
|-------|-------------------|--------------|-------|
| CTO | 300 (5 min) | yes | Periodic Linear check + mission monitoring |
| Workers | 0 (no timer) | yes | Wake only when CTO assigns work or user messages |

### Two-Tier Execution

On each heartbeat activation, the system avoids unnecessary LLM calls:

1. **Cheap deterministic checks** (zero tokens): Query Linear for new issues, check mission status changes, scan for pending interventions. If nothing changed → skip.
2. **LLM escalation** (only when needed): If there's meaningful new work, invoke the agent's model. CTO classifies issues, decides dispatch strategy.
3. **HEARTBEAT_OK suppression**: If the agent determines nothing needs attention, it returns `HEARTBEAT_OK`. No notification to the user.

### Wakeup Coalescing & Deferred Promotion

- **Coalescing**: If a wakeup arrives while the agent is already running on the same task, merge the new context into the active run instead of spawning a duplicate. Example: 3 Linear updates to the same issue → 1 agent invocation with all 3 updates merged.
- **Deferred promotion**: If the agent is busy on a different task, the wakeup is queued as `deferred`. When the current run finishes, the oldest deferred wakeup auto-promotes.
- **Orphan reaping**: On app restart, detect runs that are "queued" or "running" but have no process. Mark failed, release locks, promote deferred wakeups.

### Issue Execution Locking

Only one agent run per issue at a time:

- **Atomic lock**: When a worker claims an issue, it sets `executionRunId` + `executionLockedAt`. No other agent can work on it simultaneously.
- **Stale adoption**: If a run crashes, a new run can adopt the orphaned issue instead of it being stuck.
- **Lock release**: On run completion, the lock is released and deferred wakeups are promoted within a single transaction.

---

## Bidirectional Linear Sync

The CTO agent watches a Linear project board and autonomously dispatches missions from issues. Results flow back to Linear as state updates, comments, and proof of work.

### Inbound: Linear to ADE

```
Linear Board                    CTO Agent                      ADE Missions
┌─────────────┐   heartbeat     ┌──────────────┐  creates     ┌──────────────┐
│ Todo        │ ──────────────> │              │ ──────────> │ Mission A    │
│ In Progress │ <────────────── │  Classifies  │             │  └─ Lane 1   │
│ Done        │   updates state │  Routes      │  creates    │ Mission B    │
│             │                 │  Dispatches  │ ──────────> │  └─ Lane 1   │
│ New Issue!  │ ──────────────> │              │             │  └─ Lane 2   │
└─────────────┘                 │  "Smart PM"  │  escalates  ┌──────────────┐
                                └──────────────┘ ──────────> │ User Review  │
```

1. **CTO heartbeat fires** → cheap check: query Linear for issues in active states.
2. **Candidate filtering**: Sort by priority → created_at → identifier. Skip blocked issues.
3. **Classification**: CTO uses memory + project knowledge to classify: bug? feature? refactor? Which worker?
4. **Concurrency check**: Respect per-state limits.
5. **Auto-dispatch or escalate**: Based on policy, create mission automatically or surface for approval.
6. **Atomic checkout**: Lock the issue, move to `In Progress` in Linear.

### Outbound: ADE to Linear

- Mission starts → move issue to `In Progress`, post workpad comment with planned approach.
- During execution → update workpad comment with progress checklist (single persistent comment, not multiple).
- PR created → post PR link, add `ade` label.
- Mission completes → move to `Done` or `In Review`, post summary with diff stats + test results.
- Mission fails → post failure context, move to `Blocked` or keep `In Progress` for retry.

### Reconciliation

On every CTO heartbeat, validate running missions against Linear state:

| Linear Change | ADE Action |
|--------------|------------|
| Issue moved to `Done` externally | Cancel ADE mission, clean up |
| Issue moved to `Cancelled` | Cancel mission, clean up workspace |
| Issue reassigned to someone else | Release worker, update mission |
| Issue still active | Refresh snapshot, continue |

### Auto-Dispatch Policies

User-configurable rules in `.ade/local.yaml`:

```yaml
linearSync:
  enabled: true
  projectSlug: my-project
  pollingIntervalSec: 300
  autoDispatch:
    rules:
      - match: { labels: ["bug"], priority: ["urgent", "high"] }
        action: auto
        worker: backend-dev
        template: bug-fix
      - match: { labels: ["feature"] }
        action: escalate
      - match: { labels: ["refactor"] }
        action: queue-night-shift
    default: escalate
  concurrency:
    global: 5
    byState:
      todo: 3
      in_progress: 5
```

### Mission Templates

Reusable mission archetypes in `.ade/templates/`:

```yaml
# .ade/templates/bug-fix.yaml
name: Bug Fix
phases: [development, testing, validation, pr]
prStrategy: per-lane
defaultWorker: backend-dev
budgetCents: 500
promptTemplate: |
  Fix the following bug:
  Title: {{ issue.title }}
  Description: {{ issue.description }}
```

CTO selects template based on issue classification. Users create custom templates in Automations, with Settings only supplying shared defaults and connector policy.

---

## Per-Agent Budget Management

Each agent has a monthly token/cost budget that is enforced automatically:

- **Per-agent budget**: `budgetMonthlyCents` ceiling. When `spentMonthlyCents >= budget`, agent auto-pauses.
- **Company-level cap**: Total monthly spend across all agents.
- **Cost event recording**: Every run records provider, model, input/output tokens, cost in cents.
- **Auto-pause**: When budget is hit, agent status → `paused`. New wakeups are rejected.
- **CTO notification**: CTO proactively tells user: "QA Engineer hit its $30 budget. Paused. Increase?"
- **Monthly reset**: `spentMonthlyCents` resets to 0 on the 1st of each month.
- **Billing type awareness**: Distinguishes `api` (pay-per-token) from `subscription` (flat rate). Subscription runs show usage but not dollar costs.

---

## Core Capabilities

### Mission Creation & Management

The CTO can create and manage missions on behalf of the user, leveraging the decomposed orchestrator modules for efficient delegation:

- **Create missions from conversation**: "We need to refactor the auth module to use JWT refresh tokens" triggers mission creation with an AI-generated phased plan. The `missionLifecycle` module handles run management and hook dispatch.
- **Estimate complexity**: Before creating a mission, the CTO assesses task complexity based on project knowledge — file count, architectural impact, dependency chains, and past experience with similar tasks.
- **Select execution strategy**: Based on complexity and user preferences, the CTO decides whether to launch a full multi-step mission, a single-step task agent, or handle the request inline.
- **Monitor active missions**: The CTO tracks all running missions via `workerTracking` (worker state and events) and can relay status, surface interventions, and provide progress summaries.
- **Steer missions**: When a mission encounters problems or the user changes requirements, the CTO can steer the mission with updated instructions. Messages are delivered through the `workerDeliveryService` and `chatMessageService`.

### Lane Management

The CTO has full awareness of the project's lane topology:

- **Create lanes**: Spin up new worktree lanes for development work.
- **Check lane status**: Report on active lanes, their branches, and current state.
- **Coordinate lane usage**: Suggest which lane to use for new work based on current lane state and active missions.

### Project State Awareness

The CTO maintains a continuously updated mental model of the project:

- **Codebase structure**: Module boundaries, key files, dependency graph, build system configuration.
- **Active work**: Running missions, open lanes, pending interventions, recent commits.
- **Historical context**: Past missions and their outcomes, architectural decisions and their rationale, recurring issues and their resolutions.
- **Team patterns**: Preferred coding conventions, PR strategy, testing approach, model preferences.

### Question Answering

The CTO can answer questions about the project without requiring the user to provide context:

- "How does the auth middleware handle expired tokens?" — answers from project knowledge.
- "What was the rationale for switching from Jest to Vitest?" — answers from decision history.
- "Which lanes are currently active and what's running on them?" — answers from live state.
- "What happened with last night's Night Shift run?" — answers from mission history and memory.

### Request Routing

When the CTO receives a request it cannot or should not handle inline, it routes to the appropriate subsystem:

| Request Type | Routed To | Example |
|---|---|---|
| Large development task | Mission system (phased plan) | "Refactor the auth module to use JWT refresh tokens" |
| Small code change | Task agent (one-off) | "Fix the typo in README.md line 42" |
| Status query | Inline answer from memory + MCP tools | "What's the status of the auth refactor?" |
| PR review request | Review pipeline | "Review PR #87 before I merge" |
| Code question | Inline answer from project knowledge | "How does the rate limiter work?" |
| External agent request | Appropriate subsystem via intent classification | Any request arriving via MCP from an external agent |

### Automation Ownership & Execution

Automations are authored in the Automations tab, but the CTO org is a primary execution target for those rules.

- Automations can run as a disposable automation bot, route through the CTO, target a specific persistent employee, or enter the Night Shift queue.
- Persistent employees bring long-lived identity, memory, budgets, and active-hours policy to recurring automations.
- Automation-scoped memory stays attached to the rule, while employee memory remains attached to the person. When a persistent employee executes a rule, both scopes are available, and employee memory is injected only when the mission/run was launched with that exact employee's `employeeAgentId`.
- The CTO can supervise org-wide automations, re-route work to a better employee, or review Night Shift results and follow up the next morning.

---

## Memory Architecture

The CTO is the primary consumer of ADE's identity-scoped memory system. The implementation is intentionally split across four layers:

- **CTO core memory**: the CTO's stable strategic memory (`projectSummary`, conventions, preferences, active focus, notes).
- **Employee core memory**: each employee's own role-specific long-lived memory.
- **Project memory**: shared durable knowledge reusable by CTO, employees, automations, coordinator, and mission workers.
- **CTO subordinate activity feed**: a rolling manager-facing digest of what employees have been doing recently.

This means the CTO does not literally share one mutable "brain file" with every employee. Employees keep their own identity memory, but the CTO now receives upward-propagated activity summaries so it stays informed without being flooded by raw worker transcripts.

### Three-Tier Memory Integration

| Tier | CTO Usage |
|---|---|
| **Tier 1 — Core Memory** (~2-4K tokens, always loaded) | The CTO's essential working context: current project state summary, active missions, recent decisions, and critical constraints. Self-edited by the CTO via `memoryUpdateCore` as the project evolves. |
| **Tier 2 — Hot Memory** (retrieved on demand) | The bulk of the CTO's accumulated project knowledge: architectural decisions, coding conventions, past mission outcomes, user preferences, and episodic/project facts. Retrieval uses `unifiedMemoryService.ts`; when local embeddings are available it upgrades to hybrid lexical + vector search, otherwise it falls back to lexical/composite ranking. |
| **Tier 3 — Cold Memory** (archival, never in context) | Historical records, old mission summaries, superseded decisions, and low-importance observations. Accessible via deep search but excluded from standard retrieval. |

For employees, the same *categories* exist, but not as one globally shared tier file:

- employee core memory is identity-local,
- project memory is shared,
- employee chat turns and employee background work can propagate upward into the CTO subordinate activity feed,
- durable cross-agent facts should be promoted into project memory rather than copied into every identity memory file.

For mission workers, the situation is different again: they use a generated `l0/l1/l2` run-scoped context hierarchy plus mission state and shared project memory. That hierarchy is part of the mission orchestrator runtime, not the CTO employee identity system.

### Auto-Compaction

The CTO's conversations can be long-running. The current compaction flow still preserves summaries/shared facts, but the full documented silent pre-compaction `memoryAdd` flush is not yet shipped. Treat that flush behavior as planned work rather than current behavior.

### Temporal Decay & Composite Scoring

Memory retrieval uses composite scoring to surface the most relevant knowledge:

```
relevance = semantic(0.5) + recency(0.2) + importance(0.2) + access_frequency(0.1)
```

- **Recency** uses a 30-day half-life: today's memories score 100%, one-month-old memories score 50%, six-month-old memories score ~1.6%.
- **Exceptions**: Core memory (Tier 1), promoted facts, and pinned memories never decay.
- **Effect**: Recent decisions and active project context naturally surface first, while old but semantically relevant knowledge (e.g., a critical architectural decision from three months ago) still scores well if its semantic and importance signals are strong.

### Knowledge Accumulation

Over time, the CTO's memory naturally stratifies:

- **First week**: Basic project structure, build system, key files, user preferences.
- **First month**: Coding conventions, testing patterns, common failure modes, dependency quirks.
- **Ongoing**: Architectural decision history, mission outcome patterns, team workflow preferences, learned routing patterns, procedural knowledge about what works and what does not.

This accumulation is what makes the CTO fundamentally different from a session-scoped assistant. Each interaction adds to a growing knowledge base that makes every future interaction more informed.

### Upward and Downward Propagation

To preserve the "persistent department" feel without creating a noisy shared notebook, ADE uses directional propagation:

- **Downward propagation**: when the CTO routes work to an employee, the employee receives its own reconstruction context plus relevant shared project memory and task/session state.
- **Upward propagation**: when an employee completes meaningful chat turns or background work, ADE appends a compact manager-facing summary into the CTO subordinate activity feed.
- **Promotion to shared memory**: durable, reusable discoveries should be written into project memory so other employees, missions, and the CTO can reuse them later.

The CTO reconstruction context now includes recent employee activity summaries, which keeps the CTO aware of subordinate work even when the user talks directly to an employee.

---

## Identity & State

### .ade/ Agent Directories

All agent state lives under the `.ade/` directory at the project root:

```
.ade/
├── cto/
│   ├── identity.yaml        # CTO persona, model preferences, heartbeat policy
│   ├── core-memory.json     # Tier 1 core memory (always loaded into context)
│   ├── memory/
│   │   ├── hot.json         # Tier 2 hot memory entries
│   │   └── archive/         # Tier 3 cold storage
│   ├── state.json           # Current operational state
│   └── sessions.jsonl       # Session history log (append-only)
├── agents/
│   ├── backend-dev/
│   │   ├── identity.yaml    # Worker persona, adapter config, heartbeat policy
│   │   ├── core-memory.json # Worker's Tier 1 core memory
│   │   ├── memory/          # Worker's Tier 2 + archive
│   │   └── sessions.jsonl   # Worker session log
│   ├── mobile-dev/
│   │   └── ...
│   └── qa-engineer/
│       └── ...
├── templates/
│   ├── bug-fix.yaml         # Mission template: bug fixes
│   ├── feature.yaml         # Mission template: features
│   └── refactor.yaml        # Mission template: refactors
└── ...
```

### Identity Persistence

The CTO's identity file defines its persona and operating parameters:

```yaml
# .ade/cto/identity.yaml
name: "CTO"
version: 1
persona: |
  You are the CTO of this project. You have deep knowledge of the entire
  codebase, its history, and the team's preferences. You make informed
  decisions, delegate effectively, and communicate proactively. You
  remember everything important about this project.
modelPreferences:
  provider: claude
  model: opus
  reasoningEffort: high
memoryPolicy:
  autoCompact: true
  compactionThreshold: 0.7
  preCompactionFlush: true
  temporalDecayHalfLife: 30
```

The identity file is versioned. Each edit increments the version number, and previous versions are retained for audit.

### State Portability

The `.ade/cto/` directory follows the same portability principles as the rest of `.ade/`:

- **Committable to the repository**: Any machine with the repo clone has the CTO's full state.
- **Git is the sync layer**: No separate cloud sync needed.
- **Memory DB is local**: durable memory lives in the local ADE database. If embedding-backed retrieval is added later, any embedding cache/regeneration strategy should be treated as an implementation detail rather than today's portability contract.
- **Merge-friendly**: JSON with sorted keys for clean diffs, YAML for human readability.

---

## Interaction Model

### Persistent Chat Interface

The CTO tab in the ADE desktop app provides a persistent chat interface:

- **Single thread**: Unlike mission chat (which has per-mission threads), the CTO has one continuous conversation thread per project.
- **Context carries over**: The CTO remembers previous conversations through its memory system. Even after compaction, it can retrieve relevant context from past sessions.
- **Rich responses**: The CTO can render code blocks, file references, mission status cards, lane summaries, and other structured content inline in the conversation.

### Conversation Patterns

The CTO supports several interaction modes:

- **Direct question**: "How does the payment flow work?" — the CTO answers from project knowledge.
- **Task delegation**: "We need to add dark mode support" — the CTO creates a mission, explains the plan, and monitors execution.
- **Status check**: "What's going on right now?" — the CTO summarizes active missions, recent commits, and pending items.
- **Decision discussion**: "Should we use Redis or Memcached for the session store?" — the CTO provides informed analysis based on project context, past decisions, and technical trade-offs.
- **Review request**: "Take a look at PR #42" — the CTO reviews the PR and provides feedback.

### Always-On Availability

The CTO is available whenever the ADE desktop app is running. It does not require explicit activation or session creation — the user opens the CTO tab and starts talking. The CTO's memory ensures continuity even across app restarts.

---

## External Integration

### MCP Tool Surface

External agents interact with the CTO through the ADE MCP server. The CTO acts as the intelligent front door for all external requests, replacing the need for external agents to understand ADE's internal tool surface.

Key MCP tools available to external agents:

- **Mission tools**: `create_mission`, `get_mission`, `start_mission`, `pause_mission`, `cancel_mission`, `steer_mission`
- **Lane tools**: `create_lane`, `get_lane_status`, `merge_lane`, `rebase_lane`
- **Agent tools**: `spawn_agent`, `get_worker_states`, `resolve_intervention`
- **Context tools**: `read_context`, `check_conflicts`, `get_timeline`
- **Integration tools**: `create_integration`, `simulate_integration`, `commit_changes`, `get_final_diff`, `get_pr_health`

### External Agent Workflow

When an external agent connects to ADE via MCP:

1. **Connection**: The external agent establishes an MCP connection (stdio for headless, Unix socket for embedded mode).
2. **Request arrives at CTO**: The request is received by the CTO, which classifies intent using its project knowledge and learned routing patterns.
3. **Context enrichment**: The CTO adds context from its own memory — user preferences, past routing outcomes, project conventions — before delegating.
4. **Delegation**: The CTO routes to the appropriate subsystem (mission orchestrator, task agent, review pipeline, or answers inline).
5. **Execution**: The routed subsystem performs the work.
6. **Result return**: Results, status updates, and artifacts are returned via MCP to the external agent.

### OpenClaw & Other Agents

The CTO is designed as a drop-in backend for persistent agent systems like OpenClaw. The typical integration pattern:

```
External agent (OpenClaw, Claude Code, Codex CLI) receives user request
    |
    v
Connects to ADE MCP server
    |
    v
CTO receives request, classifies intent
    |
    v
CTO enriches with project context from memory
    |
    v
Routes to appropriate subsystem:
  - Large task → Mission system (phased plan)
  - Small task → Task agent (one-off)
  - Question  → Inline answer from CTO knowledge
  - Review    → Review pipeline
    |
    v
Work executes (agents work in lanes)
    |
    v
Results returned via MCP
    |
    v
External agent reports back to user
```

The CTO's persistent memory means routing improves over time. If a user consistently wants TypeScript refactoring routed to a specific agent identity or prefers a particular PR strategy, the CTO learns these patterns and applies them automatically.

#### OpenClaw Integration Architecture

OpenClaw (https://github.com/openclaw/openclaw) is a self-hosted personal AI assistant that runs as a local-first gateway daemon connecting to messaging platforms (WhatsApp, Telegram, Slack, Discord, iMessage, etc.). It supports multiple isolated agents, each with their own workspace, persona, and memory. The CTO agent is designed to integrate with OpenClaw as a specialized "tech department" — one of several agents in the user's personal agent network.

**Conceptual relationship:**
- OpenClaw = personal life gateway. Multiple agents handle different domains (virtual self, CFO, marketing lead, etc.).
- ADE CTO = the entire tech department. One persistent agent with deep project knowledge, mission orchestration, and memory.
- They are complementary, not competing. OpenClaw is the outer shell (your life); CTO is a specialized department within that shell.

**How CTO appears in OpenClaw:**
CTO is not a native OpenClaw agent (those run inside OpenClaw's own runtime). Instead, CTO is exposed to OpenClaw via a bridge — either as a custom skill, a webhook endpoint, or a Gateway WebSocket operator client. From the user's perspective, messaging "CTO" through OpenClaw feels native, but under the hood OpenClaw forwards to ADE.

##### Bridge Architecture

The bridge service runs inside ADE's Electron main process and provides bidirectional communication:

```
┌─────────────────────────────────────┐
│         ADE Electron App            │
│                                     │
│  ┌──────────────┐  ┌─────────────┐  │
│  │  CTO Agent   │  │  OpenClaw   │  │
│  │  (Vercel AI) │◄─┤  Bridge     │  │
│  └──────────────┘  │  Service    │  │
│                    │             │  │
│                    │ HTTP :18791 │  │
│                    │ WS client   │  │
│                    └──────┬──────┘  │
└───────────────────────────┼─────────┘
                            │
                    localhost network
                            │
┌───────────────────────────┼─────────┐
│     OpenClaw Gateway                │
│   ws://127.0.0.1:18789              │
│                           │         │
│  ┌────────────────────────▼──────┐  │
│  │  Gateway WS API (operator)   │  │
│  │  + hook/skill ingress        │  │
│  └──────────────┬────────────────┘  │
│                 │                   │
│  ┌──────────────▼──────────────┐    │
│  │  Multi-Agent Router         │    │
│  │  ┌─────────┐ ┌───────────┐  │    │
│  │  │  main   │ │ cfo, etc. │  │    │
│  │  │  agent  │ │           │  │    │
│  │  └────┬────┘ └───────────┘  │    │
│  └───────┼──────────────────────┘   │
│          │ sessions_send            │
│          └──────────────────────    │
└─────────────────────────────────────┘
```

##### OpenClaw → CTO Flow (Inbound)

1. An OpenClaw agent, hook, or skill calls ADE's bridge entrypoint at `POST http://127.0.0.1:18791/openclaw/hook` for async delivery or `POST http://127.0.0.1:18791/openclaw/query` for synchronous fallback.
2. The bridge validates the shared hook token, checks idempotency, and resolves the ADE target through one stable contract: the message plus optional `targetHint` (`cto` or `agent:<worker-slug>`).
3. ADE forwards the request into the correct identity session via `agentChatService.ensureIdentitySession()`, injecting OpenClaw metadata as turn-scoped bridge context rather than durable memory.
4. If the target worker is missing or unavailable, the bridge falls back to CTO and records that fallback in bridge history.
5. Hook requests return `202` immediately. When the ADE turn completes, the bridge uses the OpenClaw Gateway WebSocket operator session to deliver the reply back to the original OpenClaw conversation.

##### CTO → OpenClaw Flow (Proactive Outbound)

1. CTO (or the ADE mission orchestrator) wants to proactively message an OpenClaw agent (e.g., notify the user's virtual self about a completed mission).
2. ADE's bridge service, connected as a WebSocket `operator` client to OpenClaw's Gateway, sends over the paired operator socket.
3. When a remembered `sessionKey` is available, the bridge uses `chat.send` to reply inside the active OpenClaw conversation. When only agent routing is known, it uses the Gateway `agent` method.
4. Notification routes are configured per event type (`mission_complete`, `ci_broken`, `blocked_run`), and offline sends are queued locally until the operator socket reconnects.

##### OpenClaw Configuration

The OpenClaw side requires:

```json5
// ~/.openclaw/openclaw.json
{
  agents: {
    defaults: {
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["main", "cfo", "marketing"]
        }
      }
    }
  },
  hooks: {
    token: "<ade-bridge-secret>",
    allowRequestSessionKey: true,
    allowedAgentIds: ["main"]
  }
}
```

And a custom skill at `~/.openclaw/workspace/skills/ade-cto/SKILL.md` that teaches OpenClaw agents when and how to invoke CTO through the bridge HTTP entrypoint. The recommended contract is one ADE router alias plus optional `targetHint`, not a separate low-level endpoint per ADE employee.

##### Alternative: Simpler Skill-Only Bridge

For a minimal integration without the full WebSocket bridge, a custom OpenClaw skill can use the `exec` tool to `curl` ADE's HTTP endpoint directly:

```markdown
---
name: ade-cto
description: Consult the ADE CTO agent for technical decisions and code questions
---
# ADE CTO Agent
Use the exec tool to consult the ADE CTO:
curl -s -X POST "http://127.0.0.1:18791/openclaw/query" \
  -H "Authorization: Bearer $ADE_OPENCLAW_HOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"<question>","targetHint":"cto","context":{"source":"openclaw-skill"}}'
```

This approach is one-directional (OpenClaw → CTO only) but requires no WebSocket integration. The full bidirectional bridge is recommended for production use.

##### Key Technical Constraints

- OpenClaw's `sessions_send` is blocked via the HTTP `/tools/invoke` endpoint (hardcoded deny list). Must use the WebSocket API or gateway hooks instead.
- OpenClaw has no native MCP client — it cannot connect to ADE's MCP server directly. The bridge must translate between OpenClaw's protocol and ADE's MCP/IPC surface.
- OpenClaw's `agentToAgent` tool is disabled by default and must be explicitly enabled with an allow-list.
- Sub-agents spawned via `sessions_spawn` do not get session tools — only depth-1 orchestrators can use `sessions_send`.
- The ADE bridge must handle OpenClaw's device pairing protocol (challenge-nonce, `connect` handshake, `deviceToken` persistence) for WebSocket operator connections.
- OpenClaw webhook handlers must be non-blocking (fire-and-forget). The bridge HTTP server should acknowledge immediately and process asynchronously.
- Inbound OpenClaw context should remain turn-scoped bridge metadata by default. ADE should only promote it into durable project memory through normal CTO workflows, not on receipt.

---

## Relationship to Missions

### Strategic vs Tactical

The CTO and the mission system operate at different levels of abstraction:

| Aspect | CTO | Missions |
|---|---|---|
| **Level** | Strategic / project-level | Tactical / task-level |
| **Lifetime** | Persistent (lives as long as the project) | Temporary (created, executed, completed) |
| **Scope** | Entire project knowledge and history | Single goal with a phased plan |
| **Role** | Decides what work to do and how | Executes the work |
| **Memory** | Accumulates project-level knowledge | Accumulates task-level facts (promoted to project after completion) |

The CTO **creates** missions. Missions **execute** work. The CTO monitors mission progress, surfaces interventions, and incorporates outcomes into its project knowledge after missions complete.

### CTO to Mission Flow

When the CTO determines that a request requires a mission:

1. **Complexity assessment**: The CTO estimates task complexity from project knowledge — file count, architectural impact, dependency chains, similar past missions.
2. **Mission creation**: The CTO calls `create_mission` with the task description, enriched with relevant project context.
3. **Planning phase oversight**: The mission starts in the built-in planning phase (default). The CTO can steer during planning or later execution as needed.
4. **Execution monitoring**: While the mission executes, the CTO tracks progress and can relay status to the user or external agent.
5. **Outcome integration**: After the mission completes, the CTO absorbs the outcome into its memory — what worked, what failed, what was learned.

---

## Multi-Device Reachability

The CTO and all workers must be reachable from any device in the ADE ecosystem (Phase 6+):

- **Brain model**: CTO and workers run only on the brain machine. All other devices are viewers/controllers.
- **State sync**: Agent identity, memory, config, and run state sync via cr-sqlite. Any device sees the full org chart and agent status in real-time.
- **Command routing**: When a user talks to the CTO or a worker from a non-brain device, the message routes over WebSocket to the brain, the agent processes it, and state changes sync back via cr-sqlite.
- **iOS access** (Phase 7): Full CTO chat from the iOS companion app. View org chart, worker status, send messages, approve interventions. Push notifications for mission completion, budget alerts, and CTO escalations.
- **VPS brain** (Phase 6 W9): CTO runs headlessly on a VPS brain via `xvfb-run electron .`. Heartbeats fire on schedule, Linear sync runs continuously, workers process issues — all without a desktop being open.
- **Linear sync portability**: the current implementation stores the Linear token in encrypted local storage under `.ade/secrets/`, with a one-time import path from legacy `.ade/local.secret.yaml`. Other devices do not need the token; they only need synced state from the brain machine.

---

## Prior Art

This design draws from three open-source projects:

| System | What We Adopted | What We Skipped |
|--------|----------------|-----------------|
| **[Paperclip](https://github.com/paperclipai/paperclip)** | Org chart with reportsTo hierarchy, heartbeat system (coalescing, deferred promotion, issue execution locking), multi-adapter pattern, config versioning with rollback, budget auto-pause, task session persistence, agent identity schema | Multi-company isolation (ADE is single-user), approval gates for hiring (too heavy), PostgreSQL dependency |
| **[Symphony](https://github.com/openai/symphony)** | Linear polling loop, per-state concurrency limits, reconciliation against tracker state, stall detection, workpad comment pattern, dependency resolution (blocked-by checks), issue re-validation before dispatch, tracker abstraction interface | WORKFLOW.md (CTO memory is richer), no-DB state recovery (ADE has persistence), dumb dispatch (CTO classifies intelligently), workspace isolation per issue (ADE has lanes) |
| **[OpenClaw](https://github.com/openclaw/openclaw)** | Three-tier memory (MEMORY.md + daily logs), pre-compaction flush (silent agentic turn), two-tier heartbeat execution (cheap checks first), HEARTBEAT_OK suppression, SOUL.md identity separation, hybrid BM25+vector search, temporal decay with evergreen exemptions | Channel adapters (ADE is desktop-native), Docker sandboxing (not needed for local), node device system (ADE has its own multi-device sync) |

---

## Deferred Design

W1-W4 are **Complete** as of 2026-03-05. The following areas remain open for future workstreams:

- **Proactive behavior**: When and how the CTO should surface information without being asked (e.g., morning briefing, mission completion notifications). Partially addressed by heartbeat system (W3) but proactive chat messages not yet implemented.
- **Multi-project support**: How the CTO handles users working across multiple projects. Current implementation is single-project.
- **Learning rate and accuracy**: How quickly the CTO should adopt new patterns vs. maintaining stable behavior. Three-tier memory model (W6) will address this.
- **Trust and permissions**: What the CTO can do autonomously vs. what requires user approval. Currently governed by adapter capability mode (`full_mcp` vs `fallback`).

These design questions will be addressed in W5+ (Night Shift, Memory Architecture, OpenClaw Bridge).
