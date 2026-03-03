# Agents — Autonomous Work Units

> **DEPRECATED**: The Agents Hub concept has been eliminated. This document is retained for historical reference only. See `CTO.md` for the CTO agent, `MISSIONS.md` for configurable mission phases, and the Automations section in `ONBOARDING_AND_SETTINGS.md` for Night Shift mode. Last updated: 2026-02-27.

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-02

---

## Table of Contents

- [Overview](#overview)
  - [Two Ways to Use the Agents Tab](#two-ways-to-use-the-agents-tab)
  - [Agent-First Execution Contract](#agent-first-execution-contract)
  - [Definition Runtime and Memory Model](#definition-runtime-and-memory-model)
  - [Agent Home vs Runtime Threads](#agent-home-vs-runtime-threads)
  - [Injected Runtime Profile Files](#injected-runtime-profile-files)
- [Core Concepts](#core-concepts)
  - [Agent Types](#agent-types)
  - [Agent Identity](#agent-identity)
  - [Inter-Agent Messaging](#inter-agent-messaging)
  - [Agent Memory and Shared Facts](#agent-memory-and-shared-facts)
  - [Context Compaction](#context-compaction)
  - [Agent Triggers](#agent-triggers)
  - [Agent Actions](#agent-actions)
  - [Agent Guardrails](#agent-guardrails)
  - [Morning Briefing](#morning-briefing)
  - [Morning Digest](#morning-digest)
  - [Pipelines](#pipelines)
- [User Experience](#user-experience)
  - [Configuration in YAML](#configuration-in-yaml)
  - [Agents Tab Card-Based UI](#agents-tab-card-based-ui)
    - [Task Agent Card States](#task-agent-card-states)
  - [Custom Agent Builder](#custom-agent-builder)
  - [Task Agent Launch Workflow](#task-agent-launch-workflow)
  - [Morning Briefing UI](#morning-briefing-ui)
  - [Built-in Pipelines](#built-in-pipelines)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
  - [Component Architecture](#component-architecture)
  - [Data Flow](#data-flow)
  - [Execution Model](#execution-model)
  - [Condition Types](#condition-types)
- [Data Model](#data-model)
  - [Database Tables](#database-tables)
  - [Configuration Schema](#configuration-schema)
  - [TypeScript Interfaces](#typescript-interfaces)
- [Concierge Agent](#concierge-agent)
  - [Purpose](#purpose)
  - [Request Routing](#request-routing)
  - [Identity and Learning](#identity-and-learning)
- [Memory Architecture](#memory-architecture)
  - [Three-Tier Memory Model](#three-tier-memory-model)
  - [Memory Scopes](#memory-scopes)
  - [Memory Operations](#memory-operations)
  - [Pre-Compaction Flush](#pre-compaction-flush)
  - [Temporal Decay](#temporal-decay)
  - [Memory Tools Available to Agents](#memory-tools-available-to-agents)
  - [Episodic and Procedural Memory](#episodic-and-procedural-memory)
- [Portable State (.ade/ Directory)](#portable-state-ade-directory)
- [External Agent Integration](#external-agent-integration)
- [Agent Identity Persistence](#agent-identity-persistence)
- [Implementation Tracking](#implementation-tracking)
  - [Foundation (Former Automations)](#foundation-former-automations)
  - [Phase 4: Agents Hub](#phase-4-agents-hub)
  - [Dependency Notes](#dependency-notes)
  - [Compute Backend in Agents](#compute-backend-in-agents-planned)
- [Roadmap Alignment](#roadmap-alignment)

---

## Overview

Agents is the unified control center for all autonomous ADE behavior. In **Phase 4** of the ADE roadmap, the Automations feature is rebranded and expanded into Agents — transforming the original trigger-action automation engine into a comprehensive agent hub where users create, configure, and monitor autonomous units that perform work on their behalf.

The rebrand reflects a fundamental shift in scope. Automations provided trigger-action pipelines (on commit, run tests; on session end, update packs). Agents subsume that capability and add three new agent types: Night Shift agents that execute missions unattended overnight, Watcher agents that monitor external resources and surface findings, and Review agents that pre-review PRs and summarize changes for morning review.

Every agent in ADE follows a unified schema:

```
Agent System = AgentDefinition + AgentRuntime + AgentMemory + Guardrails
```

- **AgentDefinition**: Identity, trigger, behavior template, tool policy, and default memory policy.
- **AgentRuntime**: A concrete execution instance with mission/run/step/thread/session bindings.
- **AgentMemory**: Durable scoped memory with explicit promotion and provenance.
- **Guardrails**: Budget caps (time, tokens, steps, USD), stop conditions, and approval requirements.

The five agent types are:

| Agent Type | Description |
|---|---|
| **Automation** | Wraps the existing trigger-action automation engine. Runs pipelines of actions (update packs, predict conflicts, run tests, run commands). |
| **Night Shift** | Queued tasks that run unattended during off-hours. Core value prop: **maximize subscription utilization while the user sleeps** — Claude/Codex subscriptions have 5-hour rate limit reset windows, and Night Shift ensures idle tokens don't go to waste. Stricter guardrails, subscription-aware budget caps, and stop conditions. Produces a morning digest for review. |
| **Watcher** | Monitors external resources (upstream repos, APIs, logs, dependency feeds) and surfaces findings. Observation only — does not modify code. |
| **Review** | Watches the team's PR feed and pre-reviews PRs assigned to the user. Summarizes changes, flags concerns, and provides morning briefing cards. |
| **Task Agent** | One-off background task with custom instructions. Fire-and-forget: users define what to do, where to run (local/VPS/Daytona/E2B), and what to produce when done (PR, screenshots, video, test results). The general-purpose agent for any background work that isn't active development. | Manual or programmatic (Agents tab, command palette, API) | "Refactor auth module, take screenshots, open a PR when done" |

The automation system builds on the existing job engine, which already implements the core session-end pipeline (session end, checkpoint creation, pack refresh). The original automation rules, triggers, actions, NL-to-rule planner, trust enforcement, and UI management from Phase 8 form the foundation that Agents extends.

Missions are ad-hoc goal objects documented in [features/MISSIONS.md](features/MISSIONS.md). Agents is not replaced by Missions; it remains the recurring trigger layer that can launch mission/orchestrator work. Night Shift agents specifically use the mission system to execute complex tasks overnight.

### Two Ways to Use the Agents Tab

**Configure Once, Runs Automatically** — Automation, Night Shift, Watcher, and Review agents are configured once and then run on their triggers (events, schedules, polls). They appear as persistent cards in the Agents tab and execute repeatedly without user intervention.

**Prompt Now, Runs Once** — Task Agents are launched on-demand with a real-time prompt. Users describe what they want done, configure where and how it runs, and the agent executes immediately as a background task. Task Agents are the general-purpose "just do this thing" entry point — any work that doesn't require the user to be actively involved can be launched as a Task Agent.

### Agent-First Execution Contract

Starting in Phase 4, ADE treats agents as the execution substrate for all **non-interactive** AI behavior.

- Non-interactive AI paths (missions, PR AI actions, conflict AI actions, night shift, watcher/review checks, background tasks) execute as agent runtimes.
- Interactive day-to-day coding in lane Work (`Terminal` + `Chat`) stays direct and user-driven.
- Legacy one-shot AI paths are allowed only behind compatibility wrappers that emit standard agent runtime records.

This keeps policy enforcement, context assembly, memory tracking, and observability consistent across every AI surface.

### Definition Runtime and Memory Model

Agent behavior is split into three explicit layers:

- **Definition layer**: Stable identity and operating policy (persona, allowed/denied tools, default model, guardrails, trigger/behavior template).
- **Runtime layer**: Invocation-specific state (`sourceSurface`, `missionId`, `runId`, `stepId`, `attemptId`, `threadId`, `sessionId`, `laneId`, backend/environment).
- **Memory scopes**: Scoped persistence that survives beyond a runtime (runtime-thread, run, project, identity).

Resident agents (schedule/poll/event driven) and task agents (on-demand one-shot) both use this same model.

### Agent Home vs Runtime Threads

ADE intentionally separates chat/thread topology:

- **Agent Home thread**: persistent thread in the Agents tab for configuring/training the agent identity.
- **Runtime threads**: execution-scoped mission/task threads attached to run/step/attempt/session state.

Promotion from runtime thread state into long-term agent memory is policy-driven and auditable; raw transcript merging is not the default.

### Injected Runtime Profile Files

ADE uses OpenClaw-inspired runtime profile injection, but keeps source-of-truth in ADE-managed storage. At runtime, the context assembler materializes bounded profile blocks/files such as:

- `IDENTITY` (role/persona/policy summary)
- `TOOLS` (effective tool allow/deny policy)
- `USER_PREFS` (project/user preferences relevant to this run)
- `HEARTBEAT` (current status and active constraints)
- `MEMORY_SUMMARY` (retrieved scoped memory snippets)

These are rebuilt per run from durable state; they are not treated as an immortal model session.

---

## Core Concepts

### Agent Types

| Type | Trigger Pattern | Modifies Code | Produces Findings | Example |
|---|---|---|---|---|
| `automation` | Event-driven (commit, session-end, schedule, manual) | Yes (via actions) | No | "On commit, run lint and unit tests" |
| `night-shift` | Scheduled (time-based, e.g., "run at 2am") | Yes (via missions) | Yes (morning digest) | "Refactor auth module overnight, park on failure" |
| `watcher` | Polling (interval-based) or webhook | No (observation only) | Yes | "Watch react repo for deprecation notices affecting our codebase" |
| `review` | Polling (GitHub API interval) or webhook | No (observation only) | Yes | "Pre-review my assigned PRs overnight, summarize in morning briefing" |
| `task` | Manual or programmatic (Agents tab, command palette, API) | Yes (via task execution) | Yes (completion artifacts) | "Refactor auth module, take screenshots, open a PR when done" |

All agent types share the same underlying schema, identity system, and guardrail infrastructure. The type determines default behavior templates and UI affordances.

### Agent Identity

An **Agent Identity** is a reusable persona and policy profile that constrains how an agent behaves. Identities encapsulate:

- **Persona name**: Human-readable label (e.g., "Careful Reviewer", "Fast Implementer").
- **System prompt overlay**: Additional system prompt text injected into AI sessions run by this agent.
- **Model preferences**: Provider (Claude/Codex), model, and reasoning effort level.
- **Risk policies**: Allowed/denied MCP tools, auto-merge permission, max file/line change limits.
- **Permission constraints**: Claude permission mode (plan, acceptEdits, bypassPermissions), Codex sandbox level, Codex approval mode.
- **Version history**: Every edit increments the version number and snapshots the previous config for audit.

ADE ships with a preset identity library:

| Preset | Description |
|---|---|
| **Careful Reviewer** | Plan-only permission mode, read-only sandbox, low risk tolerance, security-focused review depth. |
| **Fast Implementer** | Accept-edits permission, workspace-write sandbox, higher file/line limits. |
| **Night Owl** | Designed for Night Shift — conservative guardrails, parks on first failure, generates morning digest. |
| **Code Health Inspector** | Read-only, observation-focused, no code modification allowed, reports findings only. |

Identity policy enforcement works as follows:
- When an agent runs, its identity's permission constraints are applied to the AI orchestrator and agent executor.
- `riskPolicies.allowedTools` filters the MCP tool set available to the orchestrator for that run.
- `riskPolicies.deniedTools` takes precedence over allowed tools (deny wins).
- Budget caps from identity guardrails are enforced alongside project-level budget limits (lower of the two wins).

**Database schema (Hivemind)**: The `agent_identities` table provides identity/profile storage in the database (`kvDb.ts`). It is used by Phase 4+ definition/runtime mapping and identity CRUD operations. The table includes `id`, `project_id`, `name`, `config` (JSON), `version`, `created_at`, and `updated_at` columns with a project index.

### Inter-Agent Messaging

**Inter-agent messaging** enables real-time communication between agents during mission execution. This is a foundational capability for multi-agent coordination, implemented in the Hivemind workstreams.

#### Team Message Tool

The `teamMessageTool` (`apps/desktop/src/main/services/ai/tools/teamMessageTool.ts`) is a Vercel AI SDK tool that agents can invoke to send messages to other participants:

- **`@step-key`**: Target a specific worker agent by its step key.
- **`@orchestrator`**: Target the orchestrator agent directly.
- **`@all`**: Broadcast to all active agents in the mission.

The tool is created with a `sendCallback` and the current attempt ID, ensuring message provenance is always tracked.

#### Message Delivery

Messages are delivered through the `workerDeliveryService` (`apps/desktop/src/main/services/orchestrator/workerDeliveryService.ts`, 1,329 lines), which handles routing to agents of different types:

| Agent Type | Delivery Mechanism |
|---|---|
| **SDK agents** (Vercel AI SDK) | Messages delivered as tool results or injected into the conversation context |
| **PTY agents** (CLI-based) | Messages delivered via PTY stdin injection with structured formatting |

The delivery service is a focused module extracted from the AI orchestrator during the service decomposition, centralizing all message delivery logic that was previously spread across the monolithic `aiOrchestratorService`.

#### @Mention System

Messages support `@mention` syntax for targeting and notification:

- Users and agents type `@` followed by a participant name.
- An autocomplete dropdown (`MentionInput` component) shows available participants.
- Mentions are parsed from message content, highlighted in the UI, and used for routing.
- The `MissionChatV2` component renders mentions with accent-colored highlighting.

#### IPC and Backend Routing

- `sendAgentMessage()` IPC handler receives messages from the renderer or from agents.
- Backend routing logic in `workerDeliveryService` delivers messages to the correct agent based on target parsing.
- Chat message threading and reconciliation is managed by `chatMessageService` (`apps/desktop/src/main/services/orchestrator/chatMessageService.ts`, 1,849 lines).
- Messages are persisted in the chat transcript (JSONL files) for durability.

#### Message Schema

Each inter-agent message includes:

| Field | Description |
|---|---|
| `target` | Recipient: step-key, `orchestrator`, or `all` |
| `message` | The message content |
| `fromAttemptId` | Source attempt ID for provenance tracking |

### Agent Memory and Shared Facts

Agents within a mission share knowledge through scoped memory namespaces and shared facts.

#### Memory Namespaces

| Namespace | Scope | Lifetime | Description |
|---|---|---|---|
| `runtime-thread` | One thread/session | Ephemeral | Working context inside a single runtime thread |
| `run` | One mission run | Run lifetime | Facts discovered during this run and visible to participating agents |
| `project` | Project-wide | Persistent | Promoted knowledge reused across missions/runs |
| `identity` | One agent definition | Persistent | Agent-specific preferences/procedures that should not leak to other identities |
| `daily-log` | Date-scoped | Rolling | Operational notes and checkpoints used for digesting/compaction |

#### Memory Item Types

| Type | Description |
|---|---|
| `fact` | Verified information about the codebase/project |
| `preference` | User or team preference |
| `pattern` | Reusable implementation or architecture pattern |
| `decision` | Decision + rationale |
| `procedure` | Repeatable runbook/step sequence |
| `gotcha` | Pitfall, edge case, or workaround |

#### Retrieval and Writeback Policy

ADE does not inject full memory dumps by default.

1. Context assembler retrieves bounded memory snippets by scope/tag/relevance.
2. Runtime receives summarized memory blocks (`MEMORY_SUMMARY`) plus optional detail retrieval tools.
3. On runtime completion (or pre-compaction), candidate memories are extracted with confidence and provenance.
4. Promotion to persistent scopes is policy-driven (auto-promote threshold + user controls).

#### Shared Facts in Prompts

During a run, agents can emit shared facts that become immediately available to other run participants:

| Fact Type | Description |
|---|---|
| `api_pattern` | API usage patterns discovered during execution |
| `schema_change` | Database or API schema updates |
| `config` | Configuration requirements or changes |
| `architectural` | Architecture constraints or decisions |
| `gotcha` | Runtime pitfalls that impact downstream steps |

Shared facts are stored per-run/per-step and included in subsequent runtime context assembly.

### Context Compaction

**Context compaction** manages the limited context window of AI agents during long-running missions, implemented in the Hivemind workstreams.

#### Compaction Engine

The compaction engine (`apps/desktop/src/main/services/ai/compactionEngine.ts`) provides:

- **Compaction monitor**: Tracks cumulative token usage against the model's context window. When usage exceeds 70% of the context window, compaction is triggered.
- **Pre-compaction fact writeback**: Before compacting, the engine extracts important facts from the conversation and persists them to the memory service. This ensures knowledge is not lost during compaction.
- **Compaction summary**: The full transcript is replaced with a concise summary that preserves key decisions, facts, and current task state.
- **Compaction hints for CLI agents**: PTY-based agents receive hints about context limits so they can manage their own context.

#### Transcript Persistence

Agent session transcripts are persisted to the `attempt_transcripts` database table:

- Each transcript entry includes role, content, timestamp, and estimated token count.
- Transcripts support append-only writes during execution.
- When compaction occurs, the `compacted_at` timestamp and `compaction_summary` are recorded.
- JSONL chat transcript files provide additional durability for the MissionChatV2 message history.

#### Session Resume

SDK agents support session resume from compacted context:

- When an agent session is interrupted and resumed, the compaction summary bootstraps the new session.
- Shared facts from the run are included in the resumed session's prompt.

### Agent Triggers

A **Trigger** defines when an agent activates.

| Type | Source | Description |
|---|---|---|
| `session-end` | Session service | Fires when a terminal session completes |
| `commit` | Git file watcher | Fires when a new commit is detected on any lane's active branch |
| `schedule` | Node.js timer | Fires on a cron-like schedule (e.g., hourly, or at a specific time) |
| `manual` | User action | Fires when the user clicks "Run Now" in the UI |
| `poll` | Polling loop | Fires on an interval, checking an external resource for changes (GitHub PRs, npm registry, URLs) |
| `webhook` | Incoming HTTP | Fires when an external system sends a webhook event |

Trigger-specific configuration:
- **`commit`**: Optional `branch` filter to limit which branches trigger the agent.
- **`schedule`**: `cron` expression for recurring schedules, or `scheduleTime` (HH:MM local) with `scheduleDays` for Night Shift agents.
- **`poll`**: `pollIntervalMs` (default: 300,000ms = 5min) and `pollTarget` describing what to poll (GitHub PRs, releases, npm packages, custom URLs).

### Agent Actions

An **Action** is an operation performed when an automation agent's trigger fires. Actions are specific to the `automation` agent type.

| Type | Target Service | Description |
|---|---|---|
| `update-packs` | Pack service | Regenerates the pack snapshot for the affected lane |
| `sync-to-mirror` | Hosted agent | Pushes pack and metadata to the ADE hosted mirror |
| `predict-conflicts` | Conflict service | Runs pairwise conflict prediction across active lanes |
| `run-tests` | Test runner | Executes a test suite by ID (e.g., "unit") |
| `run-command` | PTY service | Executes an arbitrary shell command in the lane's worktree |

Actions support a `condition` field for conditional execution, `continueOnFailure` for pipeline resilience, `timeoutMs` for per-action timeouts (default: 300,000ms = 5 min), and `retry` for failure retry with exponential backoff (400ms * 2^attempt).

### Agent Guardrails

**Guardrails** constrain agent behavior to keep autonomous execution safe and predictable.

| Guardrail | Description |
|---|---|
| `timeLimitMs` | Max wall-clock time per run |
| `tokenBudget` | Max tokens per run |
| `stepLimit` | Max mission steps per run |
| `budgetUsd` | Max USD spend per run |
| `dailyRunLimit` | Max runs per 24-hour period |
| `stopConditions` | Array of conditions that halt the agent (see below) |
| `requireApprovalFor` | Actions requiring user approval before execution |
| `subscriptionAware` | Subscription utilization settings for Night Shift agents (see below) |

**Stop Conditions**:

| Condition | Behavior |
|---|---|
| `first-failure` | Halt on first action/step failure; park the run for review |
| `budget-exhaustion` | Halt when any budget cap (time, tokens, steps, USD) is reached |
| `rate-limited` | Halt because subscription rate limit was hit and no reset within the Night Shift window |
| `reserve-protected` | Halt to protect the weekly reserve threshold for daytime use |
| `intervention-threshold` | Halt when the agent hits N intervention requests (critical for unattended Night Shift — nobody is there to respond) |
| `error-rate` | Halt when error percentage exceeds a threshold |
| `time-exceeded` | Halt when wall-clock time exceeds the limit |

Budget enforcement is hard — when a cap is hit, the agent stops immediately with a structured budget-exhaustion record.

#### Subscription-Aware Scheduling (Night Shift)

The core value proposition of Night Shift is **maximizing subscription utilization during idle hours**. Claude and Codex subscriptions have 5-hour rate limit reset windows. Most developers sleep for 6-8 hours. Night Shift ensures those tokens don't go to waste by scheduling productive AI work while the user sleeps.

**Utilization modes** (user-selectable per agent or globally in Night Shift settings):

| Mode | Behavior | Use Case |
|---|---|---|
| `maximize` | Use all available capacity before the next reset window. Schedule work to fill the gap between sleep time and rate limit resets. | Users who want to squeeze every token out of their subscription overnight. |
| `conservative` | Use up to a configurable percentage of remaining capacity (default: 60%). Leave headroom for next-day manual work. | Default mode. Balanced approach that respects weekly/monthly limits. |
| `fixed` | Ignore subscription utilization — run queued tasks with fixed per-agent budgets only. | Users who prefer explicit control over token spend. |

**Rate limit awareness**:
- Before starting each Night Shift agent, the service checks current rate limit state via headers from recent CLI responses.
- If a rate limit reset is due at 3am and the user queued work at 11pm, Night Shift schedules a second batch after the 3am reset to use refreshed capacity.
- If remaining capacity is below a configurable threshold (e.g., 10%), Night Shift skips lower-priority agents and logs the skip reason.

**Weekly reserve protection**:
- Users set a weekly reserve: "always keep at least N% of my weekly budget for daytime use" (default: 20%).
- Night Shift respects this reserve — it will not consume tokens that would drop the user below their reserve threshold.
- The reserve is calculated from AI usage dashboard data (`ai_usage_log` table).

**Existing infrastructure**: The `ai_usage_log` table, `logUsage()` function, daily budget enforcement (`checkBudget()`), aggregated usage queries, and token cost estimation are already implemented in `aiIntegrationService`. Night Shift extends this foundation with rate limit header parsing, subscription tier detection, weekly aggregation, and multi-batch scheduling — these are the new components Phase 4 must build.

### Morning Briefing

The **Morning Briefing** is a swipeable card interface for reviewing overnight agent results. It is shown automatically when the user opens ADE after Night Shift agents have completed, and is also accessible on-demand from the Agents tab header.

Morning Briefing aggregates results from all overnight agent runs into reviewable cards. Each card type corresponds to an agent type:

| Card Type | Source | Content | Actions |
|---|---|---|---|
| Succeeded Mission | Night Shift | What changed, diff stats, PR link, confidence score, test results | Approve (merge PR) / Dismiss (close PR) / Investigate Later |
| Failed/Parked Mission | Night Shift | Failure reason, last step, partial changes, error context | Retry / Dismiss / Investigate Later |
| Watcher Finding | Watcher | What was detected, affected files, suggested action | Create Task / Dismiss / Investigate Later |
| PR Review Summary | Review | PR summary, flagged concerns, suggested comments | Approve PR / Request Changes / Investigate Later |

### Morning Digest

The **Morning Digest** is a structured artifact generated after all Night Shift agents complete (or at a configured morning time). It aggregates outcomes from all overnight agent runs into a single summary including:

- Per-agent status (succeeded, failed, parked, budget-exhausted, rate-limited, skipped)
- AI-generated summary of what each agent accomplished
- Findings from watcher and review agents
- Changes proposed by night-shift agents (with PR links)
- Failure context for parked runs
- Total budget consumption across all overnight runs
- **Subscription utilization summary**: tokens used overnight per provider, capacity utilized percentage, rate limit resets hit, agents skipped due to limits, weekly reserve remaining
- Counts of pending reviews and items requiring attention

### Pipelines

A **Pipeline** is a chain of actions within an automation agent that execute in strict sequence. If an action fails, subsequent actions are skipped unless `continueOnFailure` is set on the failed action.

The existing job engine implements the core pipeline (session end to checkpoint to pack refresh), which is always active and not user-configurable. User-defined automation agent pipelines run after this core pipeline.

---

## User Experience

### Configuration in YAML

Agents are configured under the `agents:` key in `.ade/ade.yaml` (shared) or `.ade/local.yaml` (personal). The key replaces the former `automations:` key (existing `automations:` configs are auto-migrated on first load).

```yaml
agents:
  # Automation agent — wraps existing trigger-action pipeline
  - id: "session-end-pipeline"
    name: "Session End Pipeline"
    type: "automation"
    identity: "fast-implementer"
    trigger:
      type: "session-end"
    behavior:
      actions:
        - type: "update-packs"
        - type: "predict-conflicts"
        - type: "sync-to-mirror"
          condition: "hosted-enabled"
    guardrails:
      timeLimitMs: 300000
      stopConditions:
        - type: "first-failure"
    enabled: true

  # Automation agent — commit-triggered tests
  - id: "commit-tests"
    name: "Run Tests on Commit"
    type: "automation"
    identity: "fast-implementer"
    trigger:
      type: "commit"
    behavior:
      actions:
        - type: "run-tests"
          suiteId: "unit"
    guardrails:
      timeLimitMs: 600000
      stopConditions:
        - type: "first-failure"
    enabled: true

  # Night Shift agent — overnight refactoring mission
  - id: "overnight-refactor"
    name: "Refactor Auth Module"
    type: "night-shift"
    identity: "night-owl"
    trigger:
      type: "schedule"
      scheduleTime: "02:00"
      scheduleDays: ["mon", "tue", "wed", "thu", "fri"]
    behavior:
      missionPrompt: "Refactor the auth middleware into a dedicated module. Extract token validation, add refresh token rotation, update all tests."
      missionLaneId: "auth-refactor"
      prStrategy: "per-lane"
    guardrails:
      timeLimitMs: 7200000
      tokenBudget: 500000
      stepLimit: 50
      budgetUsd: 5.00
      subscriptionAware:
        utilizationMode: "conservative"
        conservativePercent: 60         # Use up to 60% of available overnight capacity
        weeklyReservePercent: 20        # Always keep 20% of weekly budget for daytime use
        respectRateLimits: true         # Pause and wait for reset instead of failing
        allowMultipleBatches: true      # Schedule work across rate limit reset windows
        priority: 1                     # Highest priority in Night Shift queue
      stopConditions:
        - type: "first-failure"
        - type: "budget-exhaustion"
        - type: "rate-limited"
        - type: "reserve-protected"
        - type: "intervention-threshold"
          maxInterventions: 2
    enabled: true

  # Watcher agent — monitor upstream dependency
  - id: "watch-react-releases"
    name: "Watch React Releases"
    type: "watcher"
    identity: "code-health-inspector"
    trigger:
      type: "poll"
      pollIntervalMs: 3600000
      pollTarget:
        type: "github-releases"
        repo: "facebook/react"
    behavior:
      watchTargets:
        - type: "github-releases"
          repo: "facebook/react"
          filter: "breaking-changes"
      reportFormat: "card"
    guardrails:
      dailyRunLimit: 24
      stopConditions:
        - type: "error-rate"
          maxErrorPercent: 50
    enabled: true

  # Review agent — pre-review assigned PRs
  - id: "pr-review-agent"
    name: "PR Review Agent"
    type: "review"
    identity: "careful-reviewer"
    trigger:
      type: "poll"
      pollIntervalMs: 1800000
      pollTarget:
        type: "github-prs"
        repo: "myorg/myrepo"
        filter: "assigned-to-me"
    behavior:
      reviewScope: "assigned-to-me"
      reviewDepth: "detailed"
    guardrails:
      dailyRunLimit: 48
      tokenBudget: 100000
      stopConditions:
        - type: "budget-exhaustion"
    enabled: true

  # Automation agent — scheduled sync
  - id: "scheduled-sync"
    name: "Hourly Mirror Sync"
    type: "automation"
    identity: "fast-implementer"
    trigger:
      type: "schedule"
      cron: "0 * * * *"
    behavior:
      actions:
        - type: "sync-to-mirror"
    guardrails:
      timeLimitMs: 300000
      stopConditions:
        - type: "first-failure"
    enabled: false

  # Automation agent — lint on commit
  - id: "post-commit-lint"
    name: "Lint on Commit"
    type: "automation"
    identity: "fast-implementer"
    trigger:
      type: "commit"
    behavior:
      actions:
        - type: "run-command"
          command: "npm run lint -- --fix"
          cwd: "."
    guardrails:
      timeLimitMs: 120000
      stopConditions:
        - type: "first-failure"
    enabled: true
```

### Agents Tab Card-Based UI

The Agents tab replaces the old Automations list view with a card-based agent grid following the ADE design system (`docs/design-template.md`).

**Page Layout**:

```
+------------------------------------------------------------------+
| AGENTS                     [+ NEW TASK]  [+ NEW AGENT]     |
| [All] [Task] [Automation] [Night Shift] [Watcher] [Review]   [Search] |
+------------------------------------------------------------------+
| +--------------+ +--------------+ +--------------+               |
| | Lint on      | | Refactor     | | Watch        |               |
| |    Commit    | |    Auth      | |    React     |               |
| |              | |              | |    Releases  |               |
| | AUTOMATION   | | NIGHT SHIFT  | | WATCHER      |               |
| | * Active     | | ~ 2:00 AM   | | * Polling    |               |
| | Last: 2m ago | | Next: tonight| | Last: 1h ago |               |
| | 47 runs      | | 12 runs      | | 3 findings   |               |
| |         [ON] | |         [ON] | |         [ON] |               |
| +--------------+ +--------------+ +--------------+               |
| +--------------+ +--------------+                                 |
| | PR Review    | | Code         |                                 |
| |    Agent     | |    Health    |                                 |
| |              | |              |                                 |
| | REVIEW       | | WATCHER      |                                 |
| | ~ Overnight  | | * Weekly     |                                 |
| | 5 PRs queued | | Last: Mon    |                                 |
| | 2 flagged    | | 14 findings  |                                 |
| |         [ON] | |         [ON] |                                 |
| +--------------+ +--------------+                                 |
+------------------------------------------------------------------+
```

**Agent Card** (standard card from design system: `bg-secondary`, `border-default`, `0px` radius):
- Top: Icon + name (heading-sm, JetBrains Mono 12px/600).
- Type badge (label-sm, ALL-CAPS, 9px): `AUTOMATION` / `NIGHT SHIFT` / `WATCHER` / `REVIEW` / `TASK` with type-specific accent colors.
- Status line: active/idle/sleeping/error with colored dot indicator.
- Stats: last run timestamp, total run count, findings count (for watchers/reviewers).
- Enable/disable toggle in bottom-right corner.
- Click opens the Agent Detail panel.

**Agent Detail Panel** (split-pane or modal):
- **Overview tab**: Agent name, description, type, identity selector, trigger config, behavior config, guardrails config. Supports inline editing with save/cancel.
- **Runs tab**: Execution history with per-run expandable detail (reuses existing automation run history UI).
- **Findings tab** (watchers/reviewers only): List of surfaced findings with approve/dismiss/investigate actions.
- **"Run Now" button**: Manual trigger for any agent type.
- **Delete button** (danger styling from design system).

#### Task Agent Card States

Task Agent cards have unique visual states reflecting their one-off nature:

**Idle / Template** (saved but not running):
```
┌──────────────┐
│ ⚡ Deploy &   │
│    Verify     │
│               │
│ TASK          │
│ ○ On-demand   │
│ Last: 2d ago  │
│ ✓ 8 runs      │
│      [RUN NOW]│
└──────────────┘
```

**Running** (actively executing):
```
┌──────────────┐
│ ⚡ Refactor   │
│    Payments   │
│               │
│ TASK          │
│ ● Running     │
│ Step 4/7      │
│ ~3 min left   │
│      [CANCEL] │
└──────────────┘
```

**Completed** (just finished, not yet dismissed):
```
┌──────────────┐
│ ⚡ Refactor   │
│    Payments   │
│               │
│ TASK          │
│ ✓ Completed   │
│ PR #42 opened │
│ 3 screenshots │
│  [SAVE] [RERUN]│
└──────────────┘
```

**Failed** (stopped with error):
```
┌──────────────┐
│ ⚡ Refactor   │
│    Payments   │
│               │
│ TASK          │
│ ✗ Failed      │
│ Step 3/7      │
│ Budget limit  │
│  [LOGS] [RETRY]│
└──────────────┘
```

- **[RUN NOW]**: Primary action for idle/template task agents. Opens a confirmation with option to edit prompt before running.
- **[CANCEL]**: Stops a running task agent. Partial work is preserved in the lane.
- **[SAVE]**: Saves a one-off completed task as a reusable template.
- **[RERUN]**: Re-launches with the same configuration. Optionally edit prompt first.
- **[LOGS]**: Opens the agent's execution log and transcript.
- **[RETRY]**: Re-launches from the point of failure (if possible) or from scratch.

**Type filter tabs**: Segmented control at top to filter by agent type (All / Task / Automation / Night Shift / Watcher / Review).

**Search**: Filter agents by name or description.

### Custom Agent Builder

A guided wizard for creating new agents, accessible via the "+ NEW AGENT" button.

**Step 1 — Choose Type**:
- Five type cards with icon, name, and short description.
- Each card shows example use cases.
- Selecting a type loads appropriate defaults for the remaining steps.

**Step 2 — Configure Identity**:
- Select an existing identity from the preset library or create a new one inline.
- Identity picker shows name, model preference, and risk level summary.
- "Create New Identity" expands an inline form with all identity fields.

**Step 3 — Set Trigger**:
- Trigger type selector (visual, not dropdown — each trigger type is a card).
- Type-specific config:
  - **Event-driven**: Event type dropdown (commit, session-end) + optional branch filter.
  - **Schedule**: Time picker + day selector (weekdays, daily, custom cron).
  - **Poll**: Interval slider + target config (GitHub repo, URL, npm package).
  - **Manual**: No config needed — runs on demand.

**Step 4 — Define Behavior**:
- **Automation agents**: Action pipeline builder (add/remove/reorder actions, same as existing automation rule editor).
- **Night Shift agents**: Mission prompt textarea + lane selector + PR strategy picker.
- **Watcher agents**: Watch target list + report format selector.
- **Review agents**: Scope selector + depth selector.
- **Task agents**: Task prompt + compute backend + compute environment + completion behaviors (see below).

**Task Agent configuration** (in Agent Builder Step 4 and Agent Detail):
- Task prompt: Multi-line textarea for natural language task description
- Compute backend selector: Local / VPS / Daytona / E2B (with availability indicators)
- Compute environment: Terminal-only / Browser / Desktop (with descriptions of what each provides)
- Completion behaviors checklist:
  - [ ] Open PR (with base branch and draft options)
  - [ ] Take screenshots (with page/route list)
  - [ ] Record video of work
  - [ ] Attach artifacts to lane
  - [ ] Run tests
  - [ ] Notify on completion

**Step 5 — Set Guardrails**:
- Budget controls: time limit, token budget, step limit, USD cap.
- Stop conditions: checkboxes for first-failure, budget-exhaustion, intervention-threshold.
- Daily run limit input.
- Approval requirements: checkboxes for which actions need user approval.

**Step 6 — Review & Create**:
- Full summary of the configured agent.
- Effective policy preview (what the agent can and cannot do).
- Simulation preview (human-readable description of what will happen when the agent triggers).
- "Create Agent" button.

**Natural Language Creation** (alternative to wizard):
- "Describe what you want" textarea at the top of the wizard.
- Reuses the existing `automationPlannerService` NL-to-rule planner, extended for all agent types via the new `agentPlannerService`.
- AI generates a full agent config from the description.
- User reviews and edits before saving.

### Task Agent Launch Workflow

Task Agents are fundamentally different from other agent types: they have **no persistent trigger**. While Automation agents fire on events, Night Shift agents fire on schedule, and Watchers poll continuously, Task Agents are launched **on-demand with a real-time prompt**. They are the "just do this thing" entry point for any background work.

#### One-Time Launch (Most Common)

The primary workflow — user describes a task, agent runs it immediately:

1. User clicks **[+ NEW TASK]** button in the Agents tab (prominent, separate from [+ NEW AGENT])
2. **Quick Launch modal** opens (streamlined, not the full 6-step wizard):
   - **Task prompt**: Multi-line textarea — "What do you want the agent to do?"
   - **Identity**: Dropdown (default: Fast Implementer) — persona and model selection
   - **Compute**: Backend (Local / VPS / Daytona / E2B) + Environment (Terminal / Browser / Desktop)
   - **When done**: Completion behavior checklist (Open PR, Screenshot, Video, Run Tests, Notify)
   - **Guardrails**: Expandable section with time limit, token budget, stop conditions
3. User clicks **[RUN NOW]** — agent launches immediately
4. A **running Task Agent card** appears in the Agents tab grid showing live progress
5. On completion, artifacts attach to the target lane and user is notified
6. Optionally: user clicks **[SAVE AS TEMPLATE]** on the completed card to reuse the configuration later

#### Reusable Task Template

For tasks you run repeatedly (e.g., "deploy to staging and verify"):

1. Use the full 6-step Agent Builder wizard (click [+ NEW AGENT], select Task type)
2. Configure identity, behavior, guardrails in detail
3. In Step 6, click **[CREATE & SAVE]** — template appears as a persistent card in Agents tab
4. Card shows "Manual (on-demand)" trigger — click **[RUN NOW]** anytime to launch with saved config
5. Before running, user can optionally **edit the prompt** for this specific run without changing the template

#### Command Palette Launch

For power users:

- `Cmd+K` → type "Run Task Agent" or "Launch Agent"
- Inline prompt input appears with identity/backend quick-selectors
- Press Enter to launch — no navigation away from current view
- Agent runs in background; notification appears on completion

#### Quick Launch from Other Tabs

Task Agents can be launched contextually from anywhere in ADE:

- **Lanes tab**: Right-click a lane → "Launch Task Agent in this lane" — pre-fills lane target
- **Missions tab**: "Launch as background task" option for simple tasks that don't need full mission orchestration
- **PRs tab**: "Launch review agent for this PR" — pre-fills review scope
- **Command palette**: Global access from any tab

### Morning Briefing UI

A distinctive, swipeable card interface for reviewing Night Shift results — inspired by rapid-decision card interfaces for quick triage.

```
+------------------------------------------------------------------+
| MORNING BRIEFING                    * * * o o  (3/5 reviewed)     |
+------------------------------------------------------------------+
|                                                                    |
|  +------------------------------------------------------------+  |
|  |                                                            |  |
|  |  NIGHT SHIFT -- Refactor Auth Module                       |  |
|  |                                                            |  |
|  |  STATUS: SUCCEEDED                                         |  |
|  |  Agent: Night Owl / Claude Sonnet / 12 steps               |  |
|  |                                                            |  |
|  |  WHAT HAPPENED:                                            |  |
|  |  Extracted auth middleware into dedicated module,           |  |
|  |  added refresh token rotation, updated 8 test files.       |  |
|  |  All 142 tests passing.                                    |  |
|  |                                                            |  |
|  |  CHANGES:                                                  |  |
|  |  +347 -128 across 12 files                                 |  |
|  |  [View Diff]  [View PR #47]                                |  |
|  |                                                            |  |
|  |  CONFIDENCE: ========--  82%                               |  |
|  |                                                            |  |
|  |  +---------+  +----------+  +---------------------+       |  |
|  |  | APPROVE |  | DISMISS  |  | INVESTIGATE LATER   |       |  |
|  |  +---------+  +----------+  +---------------------+       |  |
|  |                                                            |  |
|  +------------------------------------------------------------+  |
|                                                                    |
|  <-- Swipe left: Dismiss    Swipe right: Approve -->              |
|                                                                    |
+------------------------------------------------------------------+
| [BULK APPROVE ALL (3)]                    [SKIP TO SUMMARY]       |
+------------------------------------------------------------------+
```

**Interaction Model**:
- **Swipe right** (or click Approve): Executes the approval action (merge PR, create task, approve review).
- **Swipe left** (or click Dismiss): Dismisses the finding, logs the decision.
- **Swipe up** (or click Investigate Later): Moves to an "investigate" queue for later review.
- **Keyboard shortcuts**: Right arrow = approve, Left arrow = dismiss, Up arrow = investigate, Space = expand details.
- **Progress indicator**: Dots at top showing total items and how many reviewed.
- **Bulk actions**: "Approve All" for high-confidence items, "Dismiss All Low-Confidence" quick action.

**Trigger**: Automatically shown when user opens ADE after Night Shift agents have completed. Also accessible on-demand from the Agents tab header. Badge count on the Agents tab icon shows pending briefing items.

### Built-in Pipelines

Always active, managed by the job engine, not user-configurable:

| Pipeline | Trigger | Actions |
|----------|---------|---------|
| Core session cleanup | Session end | Create checkpoint, Refresh lane pack |

Built-in pipelines run before user-configurable agent automation pipelines, ensuring core functionality is always maintained.

### Development Modes

ADE distinguishes between active development and background work:

**Active Development** (interactive, user-in-the-loop):
- Work Tab / Lane Chat: Direct conversation with Claude or Codex
- Terminals: Interactive CLI sessions
- Missions: Orchestrated multi-agent workflows with monitoring and approval

**Background Work** (fire-and-forget, Agents tab):
- Task Agents: One-off background tasks with custom instructions
- Automation Agents: Trigger-action pipelines
- Night Shift Agents: Scheduled overnight execution
- Watcher Agents: External resource monitoring
- Review Agents: PR pre-review

The Agents tab is the unified launch pad for all background work. Task Agents serve as the general-purpose entry point — any work that doesn't require active user participation can be launched as a Task Agent.

---

## Technical Implementation

### Services

| Service | Status | Role |
|---------|--------|------|
| `jobEngine` | Exists | Core pipeline, job queuing, deduplication, coalescing |
| `agentService` | Planned | Parses agents from config, registers trigger listeners, evaluates conditions, dispatches behavior (action chains for automation agents, missions for night-shift, polling for watchers/reviewers), persists run/action records to SQLite. Renamed and extended from `automationService`. |
| `agentPlannerService` | Planned | NL-to-agent planner. Accepts natural language intent, generates structured agent drafts for all four types using Codex CLI or Claude CLI. Extended from `automationPlannerService`. |
| `agentIdentityService` | Planned | CRUD operations for agent identities. Manages preset library, version history, identity validation, policy enforcement integration. |
| `nightShiftService` | Planned | Manages the Night Shift queue. Enforces strict guardrails (time limits, step caps, token budgets, USD limits). Handles stop conditions, failure parking, and morning digest generation. |
| `projectConfigService` | Exists | Provides agent definitions from YAML (reads `agents:` key, with fallback to `automations:` for migration) |
| `sessionService` | Exists | Fires `session-end` events |
| `gitOperationsService` | Exists | Emits head-change events when ADE performs git operations |
| `packService` | Exists | Implements `update-packs` action |
| `conflictService` | Exists | Implements `predict-conflicts` action |
| `aiIntegrationService` | Exists | Routes AI tasks via AgentExecutor interface. Also provides: `logUsage()` for recording every AI call to `ai_usage_log` table, daily budget enforcement via `checkBudget()`, feature flags, and subscription mode detection (guest/subscription). |
| `memoryService` | Exists | Scoped memory namespaces (runtime-thread/run/project/identity/daily-log). Manages candidate promotion, shared facts, and memory queries for agent prompt injection. |
| `compactionEngine` | Exists | SDK agent context compaction at 70% threshold, pre-compaction fact writeback, transcript persistence, session resume support. |
| `workerTracking` | Exists | Worker state management and event handling. Extracted from `aiOrchestratorService` into `apps/desktop/src/main/services/orchestrator/workerTracking.ts` (1,087 lines). Tracks worker lifecycle, heartbeats, and status transitions. |
| `workerDeliveryService` | Exists | Inter-agent message delivery to SDK and PTY agents. Extracted from `aiOrchestratorService` into `apps/desktop/src/main/services/orchestrator/workerDeliveryService.ts` (1,329 lines). Centralizes all message routing logic. |
| `chatMessageService` | Exists | Chat/messaging, threading, and message reconciliation. Extracted from `aiOrchestratorService` into `apps/desktop/src/main/services/orchestrator/chatMessageService.ts` (1,849 lines). Manages all chat-related operations for missions. |
| `missionLifecycle` | Exists | Mission run management and hook dispatch. Extracted from `aiOrchestratorService` into `apps/desktop/src/main/services/orchestrator/missionLifecycle.ts` (1,045 lines). |
| `recoveryService` | Exists | Failure recovery, health sweep, and hydration. Extracted from `aiOrchestratorService` into `apps/desktop/src/main/services/orchestrator/recoveryService.ts` (412 lines). |
| `metaReasoner` | Exists | AI meta-reasoner for dynamic fan-out decisions. Analyzes agent output and recommends parallelization strategies. |
| `testService` | Exists | Implements `run-tests` action |
| `ptyService` | Exists | Provides `session-end` events via terminal session lifecycle |

### IPC Channels

All channels are prefixed `ade.agents.*`. During transition, `ade.automations.*` aliases are maintained for backward compatibility.

| Channel | Status | Payload |
|---------|--------|---------|
| `ade.agents.list()` | Planned | Returns `Agent[]` with status and last run info |
| `ade.agents.get(id)` | Planned | Returns single agent with full config |
| `ade.agents.create(agent)` | Planned | Creates a new agent, returns created agent |
| `ade.agents.update(id, agent)` | Planned | Updates agent config, returns updated agent |
| `ade.agents.delete(id)` | Planned | Deletes an agent |
| `ade.agents.toggle(id, enabled)` | Planned | Enable/disable agent by ID |
| `ade.agents.triggerManually(id)` | Planned | Fires agent immediately, returns async |
| `ade.agents.getHistory(id)` | Planned | Returns `AgentRun[]` ordered by most recent |
| `ade.agents.getRunDetail(runId)` | Planned | Returns detailed run with per-action status |
| `ade.agents.getFindings(id)` | Planned | Returns findings for watcher/review agents |
| `ade.agents.dismissFinding(findingId)` | Planned | Dismiss a finding |
| `ade.agents.parseNaturalLanguage(args)` | Planned | NL-to-agent planner draft from intent text |
| `ade.agents.validateDraft(args)` | Planned | Validates + normalizes draft, returns required confirmations |
| `ade.agents.simulate(args)` | Planned | Human-readable preview of agent behavior |
| `ade.agents.event` | Planned | Push updates for agent state changes |
| `ade.agents.identities.list()` | Planned | Returns all agent identities |
| `ade.agents.identities.get(id)` | Planned | Returns single identity with full config |
| `ade.agents.identities.create(identity)` | Planned | Creates a new identity |
| `ade.agents.identities.update(id, identity)` | Planned | Updates identity config |
| `ade.agents.identities.delete(id)` | Planned | Deletes an identity |
| `ade.agents.nightShift.getDigest()` | Planned | Returns latest morning digest |
| `ade.agents.nightShift.getQueue()` | Planned | Returns queued Night Shift agents |
| `ade.agents.briefing.getItems()` | Planned | Returns pending morning briefing items |
| `ade.agents.briefing.respond(itemId, action)` | Planned | Approve/dismiss/investigate a briefing item |
| `ade.agents.briefing.bulkRespond(actions)` | Planned | Bulk approve/dismiss briefing items |

### Component Architecture

```
AgentsPage (route: /agents)
  +-- Type filter tabs (All / Automation / Night Shift / Watcher / Review / Task)
  +-- Search input
  +-- Agent card grid
  |    +-- Per-agent card: icon, name, type badge, status, stats, enable toggle
  +-- AgentDetailPanel (split-pane or modal, opened on card click)
  |    +-- Overview tab: name, description, type, identity, trigger, behavior, guardrails
  |    +-- Runs tab: execution history with per-run expandable detail
  |    +-- Findings tab (watchers/reviewers): findings list with actions
  |    +-- "Run Now" button, "Delete" button
  |    +-- Edit mode: inline editing with save/cancel
  +-- AgentBuilderWizard (modal, opened via "+ NEW AGENT" button)
  |    +-- Step 1: Choose Type (five type cards)
  |    +-- Step 2: Configure Identity (preset picker or inline create)
  |    +-- Step 3: Set Trigger (visual trigger type selector + type-specific config)
  |    +-- Step 4: Define Behavior (type-specific: pipeline builder / mission config / watch config / review config / task config)
  |    +-- Step 5: Set Guardrails (budget controls, stop conditions, approval requirements)
  |    +-- Step 6: Review & Create (summary, effective policy preview, simulation preview)
  |    +-- NL Creation alternative ("Describe what you want" textarea at top)
  +-- MorningBriefingView (modal or full-page, shown on app launch after Night Shift)
  |    +-- Swipeable card stack
  |    +-- Progress indicator (dots)
  |    +-- Per-card action buttons (approve / dismiss / investigate)
  |    +-- Bulk action bar (approve all, skip to summary)
  +-- Trust CTA banner (shown when shared config is untrusted)

SettingsPage > IdentityManager (Agent Identities section)
  +-- Identity list with name, type badge, preset indicator, version number
  +-- Create / edit / clone / delete operations
  +-- Effective-policy preview before saving
  +-- Diff view between identity versions for audit

SettingsPage > AgentsSection (replaces Automations section)
  +-- Per-agent summary with enable/disable, run-now, history links
  +-- Night Shift global settings (time window, compute backend, digest delivery time, global budget cap)
  +-- Watcher agent global settings (default poll interval, GitHub API rate limit awareness)
```

### Data Flow

**Startup**: Main process loads config. `agentService` reads the `agents` array (with fallback to `automations` for migration) and registers trigger listeners: `session-end` subscribes to session events, `commit` fires from head-change detection (ADE git operations + lane head watcher), `schedule` creates cron timers, `poll` creates polling loops, `manual` needs no listener. Agent identities are loaded and validated. Night Shift agents are registered with `nightShiftService` for queue management.

**Trigger Firing**: Event occurs. Service evaluates matching enabled agents. For automation agents: creates an `AgentRun` record (status: running), executes actions sequentially (evaluate condition, dispatch to service, wait for completion, record result). If an action fails and `continueOnFailure` is not set, the pipeline stops. For night-shift agents: launches a mission via the orchestrator with identity constraints. For watcher/review agents: polls the target, compares against previous state, emits findings on change. Final status is written and an IPC event notifies the renderer.

**Manual Trigger**: User clicks "Run Now". Renderer calls `ade.agents.triggerManually(id)`. Main creates a synthetic trigger event dispatched through normal execution flow.

### Execution Model

- **Sequential within an agent**: Actions (automation agents) or steps (night-shift missions) execute one at a time, in order.
- **Parallel across agents**: Multiple agents matching the same trigger run in parallel.
- **Deduplication**: Re-triggered agents coalesce with running executions.
- **Timeout**: Default 5 minutes (300,000ms) per action for automation agents; configurable via `timeoutMs` field. Night Shift agents use `guardrails.timeLimitMs` for overall run timeout.
- **Retry**: Failed actions can retry with exponential backoff (400ms * 2^attempt); configurable via `retry` field (integer, number of retries).
- **Error handling**: Failed action stops pipeline unless `continueOnFailure: true`. Night Shift agents park on failure with structured failure context.
- **Trust enforcement**: Agents refuse to execute when shared config is untrusted (requires `projectConfigService.confirmTrust()` first).
- **Safety checks**: `run-command` actions validate `cwd` is within the project root (`isWithinDir` check) before execution.

### Condition Types

Actions support a `condition` field. The following condition strings are evaluated at runtime:

| Condition | Evaluates to `true` when |
|-----------|-------------------------|
| `subscription-enabled` | At least one AI provider (Claude or Codex CLI) is detected and authenticated |
| `byok-enabled` | Provider mode is `byok` and an API key is configured |
| `provider-enabled` | Any AI provider (hosted or BYOK) is active |
| `hosted-enabled` | Hosted agent mode is active and authenticated |
| `lane-present` | A lane ID is available in the trigger context |
| `true` | Always (unconditional) |
| `false` | Never (effectively disables the action) |

---

## Data Model

### Database Tables

```sql
-- New: Agents table (stores full agent configuration)
CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,              -- 'automation' | 'night-shift' | 'watcher' | 'review' | 'task'
    config TEXT NOT NULL,            -- JSON: full Agent schema
    identity_id TEXT,                -- FK to agent_identities table
    enabled INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,        -- ISO 8601
    updated_at TEXT NOT NULL         -- ISO 8601
);

CREATE INDEX idx_agents_project ON agents(project_id);
CREATE INDEX idx_agents_type ON agents(type);

-- New: Agent identities table (reusable persona + policy profiles)
CREATE TABLE agent_identities (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL,            -- JSON: AgentIdentity schema
    version INTEGER DEFAULT 1,
    created_at TEXT NOT NULL,        -- ISO 8601
    updated_at TEXT NOT NULL         -- ISO 8601
);

CREATE INDEX idx_identities_project ON agent_identities(project_id);

-- New: Agent identity version history (audit trail)
CREATE TABLE agent_identity_versions (
    id TEXT PRIMARY KEY,
    identity_id TEXT NOT NULL REFERENCES agent_identities(id),
    version INTEGER NOT NULL,
    config TEXT NOT NULL,            -- JSON: snapshot of identity at this version
    changed_by TEXT,                 -- 'user' | 'migration'
    created_at TEXT NOT NULL         -- ISO 8601
);

CREATE INDEX idx_identity_versions ON agent_identity_versions(identity_id, version);

-- Existing: Automation runs (reused for agent run tracking)
-- Added agent_id column to link runs to agents
CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,         -- FK to projects table
    automation_id TEXT NOT NULL,       -- Legacy: automation rule ID
    agent_id TEXT,                     -- NEW: FK to agents table (nullable for legacy runs)
    trigger_type TEXT NOT NULL,       -- 'session-end' | 'commit' | 'schedule' | 'manual' | 'poll' | 'webhook'
    started_at TEXT NOT NULL,         -- ISO 8601
    ended_at TEXT,                    -- NULL while running
    status TEXT NOT NULL,             -- 'running' | 'succeeded' | 'failed' | 'cancelled' | 'parked'
    actions_completed INTEGER DEFAULT 0,
    actions_total INTEGER NOT NULL,
    error_message TEXT,
    trigger_metadata TEXT             -- JSON: session/commit/schedule/poll context
);

CREATE INDEX idx_runs_automation ON automation_runs(automation_id);
CREATE INDEX idx_runs_agent ON automation_runs(agent_id);
CREATE INDEX idx_runs_started ON automation_runs(started_at);

-- Existing: Automation action results (reused for agent action tracking)
-- Added agent_id column for direct agent linkage
CREATE TABLE automation_action_results (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES automation_runs(id),
    agent_id TEXT,                     -- NEW: FK to agents table (nullable for legacy results)
    action_index INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL,             -- 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled'
    error_message TEXT,
    output TEXT                       -- Captured stdout/stderr (truncated)
);

CREATE INDEX idx_results_run ON automation_action_results(run_id);
```

**`trigger_metadata` examples**: session-end includes `sessionId` and `laneId`; commit includes `commitHash` and `branch`; schedule includes `scheduledAt`; manual includes `triggeredBy: "user"`; poll includes `pollTarget`, `changeDetected`, and `previousState`.

### Configuration Schema

The `agents` key in `.ade/ade.yaml` or `.ade/local.yaml` accepts an array of agent objects. Each agent requires:

- `id` (string, lowercase with hyphens): Unique identifier.
- `name` (string): Human-readable name.
- `type` (string): One of `automation`, `night-shift`, `watcher`, `review`, `task`.
- `identity` (string): Reference to an agent identity ID, or inline identity config.
- `trigger` (object): Trigger configuration with `type` and type-specific fields (`cron`, `branch`, `scheduleTime`, `scheduleDays`, `pollIntervalMs`, `pollTarget`).
- `behavior` (object): Type-specific behavior configuration:
  - Automation: `actions` array.
  - Night Shift: `missionPrompt`, optional `missionLaneId`, optional `prStrategy`.
  - Watcher: `watchTargets` array, optional `reportFormat`.
  - Review: `reviewScope`, optional `reviewDepth`.
  - Task: `taskPrompt`, optional `taskLaneId`, optional `computeBackend`, optional `computeEnvironment`, optional `completionBehaviors`.
- `guardrails` (object): Budget caps, stop conditions, approval requirements.
- `enabled` (boolean): Whether the agent is active.

For backward compatibility, the `automations` key is still read on startup and auto-migrated to `agents` with `type: 'automation'`.

### TypeScript Interfaces

```typescript
interface Agent {
  id: string;
  name: string;
  type: 'automation' | 'night-shift' | 'watcher' | 'review' | 'task';
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

interface AgentIdentityVersion {
  id: string;
  identityId: string;
  version: number;
  config: Omit<AgentIdentity, 'versionHistory'>; // Snapshot of identity at this version
  changedBy: 'user' | 'migration';
  createdAt: string;                // ISO 8601
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
  taskLaneId?: string;              // Target lane (optional, agent creates one if not specified)
  computeBackend?: 'local' | 'vps' | 'daytona' | 'e2b';
  computeEnvironment?: 'terminal-only' | 'browser' | 'desktop';
  completionBehaviors?: CompletionBehavior[];
}

interface AgentAction {
  type: 'update-packs' | 'sync-to-mirror' | 'predict-conflicts'
      | 'run-tests' | 'run-command';
  suiteId?: string;                 // For run-tests
  command?: string;                 // For run-command
  cwd?: string;                     // For run-command (validated to be within project root)
  condition?: string;               // Evaluated at runtime (see Condition Types)
  continueOnFailure?: boolean;      // If true, pipeline continues even if this action fails
  timeoutMs?: number;               // Per-action timeout in milliseconds (default: 300000 = 5 min)
  retry?: number;                   // Number of retries on failure (exponential backoff: 400ms * 2^attempt)
}

interface AgentGuardrails {
  timeLimitMs?: number;             // Max wall-clock time per run
  tokenBudget?: number;             // Max tokens per run
  stepLimit?: number;               // Max mission steps per run
  budgetUsd?: number;               // Max USD spend per run
  dailyRunLimit?: number;           // Max runs per 24h period
  stopConditions: StopCondition[];  // When to halt
  requireApprovalFor?: string[];    // Actions requiring user approval before execution
}

type CompletionBehavior =
  | { type: 'open-pr'; baseBranch?: string; draft?: boolean }
  | { type: 'screenshot'; pages?: string[] }
  | { type: 'record-video'; durationLimitMs?: number }
  | { type: 'attach-artifacts-to-lane' }
  | { type: 'run-tests'; command?: string }
  | { type: 'notify'; channel?: 'ui' | 'push' }
  | { type: 'custom-command'; command: string };

type StopCondition =
  | { type: 'first-failure' }
  | { type: 'budget-exhaustion' }
  | { type: 'intervention-threshold'; maxInterventions: number }
  | { type: 'error-rate'; maxErrorPercent: number }
  | { type: 'time-exceeded' };

interface AgentRun {
  id: string;
  agentId: string;
  automationId?: string;            // Legacy: automation rule ID (for migrated runs)
  triggerType: string;
  startedAt: string;
  endedAt?: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'parked';
  actionsCompleted: number;
  actionsTotal: number;
  errorMessage?: string;
  triggerMetadata?: Record<string, unknown>;
}

// Extended type returned by agentService.list()
interface AgentRuleSummary extends Agent {
  lastRunAt: string | null;
  lastRunStatus: string | null;
  running: boolean;
  findingsCount?: number;           // For watcher/review agents
}

interface MorningDigest {
  id: string;
  generatedAt: string;              // ISO 8601
  nightShiftSessionId: string;
  agents: AgentDigestEntry[];
  totalBudgetUsed: BudgetSummary;
  pendingReviews: number;
  requiresAttention: number;
}

interface AgentDigestEntry {
  agentId: string;
  agentName: string;
  status: 'succeeded' | 'failed' | 'parked' | 'budget-exhausted';
  summary: string;                  // AI-generated summary of what happened
  findings?: Finding[];             // For watchers/reviewers
  changesProposed?: ChangeSet[];    // For night-shift agents
  prCreated?: string;               // PR URL if created
  failureContext?: FailureContext;
  budgetUsed: BudgetSummary;
}

interface Finding {
  id: string;
  agentId: string;
  type: 'deprecation' | 'vulnerability' | 'breaking-change' | 'upstream-update'
      | 'pr-concern' | 'code-health' | 'custom';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  affectedFiles?: string[];
  suggestedAction?: string;
  sourceUrl?: string;               // Link to the source (PR, release, CVE, etc.)
  detectedAt: string;               // ISO 8601
  dismissedAt?: string;             // ISO 8601, set when user dismisses
  dismissedBy?: string;
}

interface StopCondition {
  type: 'first-failure' | 'budget-exhaustion' | 'intervention-threshold'
      | 'error-rate' | 'time-exceeded';
  maxInterventions?: number;        // For intervention-threshold
  maxErrorPercent?: number;         // For error-rate
}

interface WatchTarget {
  type: 'github-releases' | 'github-prs' | 'npm-registry' | 'url' | 'custom';
  repo?: string;                    // GitHub owner/repo
  url?: string;                     // For URL targets
  package?: string;                 // For npm-registry targets
  filter?: string;                  // Optional filter expression (e.g., "breaking-changes")
}

interface BudgetSummary {
  timeMs: number;
  tokens: number;
  steps: number;
  usd: number;
}

interface FailureContext {
  error: string;
  lastStep: string;
  filesChanged: string[];
  diffSnapshot?: string;            // Truncated diff of changes before failure
}

interface ChangeSet {
  additions: number;
  deletions: number;
  filesChanged: number;
  files: string[];
}
```

---

## Implementation Tracking

### Foundation (Former Automations)

All original automation tracking items are complete and form the foundation that Agents extends.

#### Core Pipeline

| ID | Task | Description | Status |
|----|------|-------------|--------|
| AUTO-001 | Core pipeline | Job engine handles session end, checkpoint, pack refresh | DONE |
| AUTO-002 | Job deduplication | Prevents duplicate jobs, coalesces rapid-fire triggers | DONE |

#### Automation Engine (Phase 8)

| ID | Task | Description | Status |
|----|------|-------------|--------|
| AUTO-003 | Automation rule schema | Define and validate `automations` section in config | DONE |
| AUTO-004 | Automation service | Parse rules, register trigger listeners | DONE |
| AUTO-005 | Session-end trigger | Subscribe to session events, dispatch rules | DONE |
| AUTO-006 | Commit trigger | Poll lane HEAD SHAs, dispatch rules | DONE |
| AUTO-007 | Schedule trigger | Cron-based timer using `node-cron` | DONE |
| AUTO-008 | Update-packs action | Wire to pack service | DONE |
| AUTO-009 | Predict-conflicts action | Wire to conflict service | DONE |
| AUTO-010 | AI augmentation action | Wire to AI integration service via AgentExecutor | DONE |
| AUTO-011 | Run-tests action | Execute test suite by ID | DONE |
| AUTO-012 | Run-command action | Execute shell command via `child_process` (non-interactive) | DONE |
| AUTO-013 | Action chaining | Sequential execution with failure handling | DONE |
| AUTO-014 | Conditional execution | Evaluate conditions, skip when false | DONE |
| AUTO-015 | Automation management UI | List view with status and toggles | DONE |
| AUTO-016 | Enable/disable toggle | IPC + UI control, persisted to config | DONE |
| AUTO-017 | Manual trigger button | "Run Now" for immediate execution | DONE |
| AUTO-018 | Execution history display | Recent runs with expandable details | DONE |
| AUTO-019 | Automation run logging | Write run/action records to SQLite | DONE |
| AUTO-020 | Error handling and retry | Configurable retry and backoff with history surfaced in UI | DONE |

#### NL-to-Rule Planner (Phase 8)

| ID | Task | Description | Status |
|----|------|-------------|--------|
| AUTO-021 | NL planner service | `automationPlannerService` accepts natural language intent and generates structured automation drafts | DONE |
| AUTO-022 | Codex CLI provider | Planner uses `codex exec -` to generate automation JSON from intent text | DONE |
| AUTO-023 | Claude CLI provider | Planner uses `claude --print` (headless) as alternative generation backend | DONE |
| AUTO-024 | Draft normalization | Normalizes generated drafts: lowercases IDs, validates trigger/action types, fuzzy-matches test suite IDs | DONE |
| AUTO-025 | Confirmation requirements | Flags dangerous actions (sync-to-mirror, run-command, certain permission flags) for explicit user confirmation | DONE |
| AUTO-026 | Simulation preview | `ade.automations.simulate(args)` renders a human-readable preview of what an automation would do | DONE |
| AUTO-027 | NL creation UI | `CreateWithNaturalLanguageDialog` with intent input, provider selector, draft preview, and confirmation checklist | DONE |

#### Trust Model Enforcement (Phase 8)

| ID | Task | Description | Status |
|----|------|-------------|--------|
| AUTO-028 | Trust gate for automation execution | Automations refuse to run when shared config is untrusted; UI shows trust CTA banner | DONE |
| AUTO-029 | Safety checks for run-command | `run-command` validates `cwd` is within project root via `isWithinDir` before execution | DONE |

### Phase 4: Agents Hub

| ID | Task | Description | Status |
|----|------|-------------|--------|
| AGENT-001 | Automations to Agents rebrand | Rename route `/automations` to `/agents`, update tab label to "AGENTS", change icon from `zap` to `bot`, update tab numbering, rename `AutomationsPage.tsx` to `AgentsPage.tsx`, migrate config key `automations:` to `agents:` | TODO |
| AGENT-002 | Agent schema and data model | Create `agents` table, `agent_identities` table, `agent_identity_versions` table in SQLite. Add `agent_id` column to existing `automation_runs` and `automation_action_results` tables. Define full Agent TypeScript schema. | TODO |
| AGENT-003 | Agent identity service | `agentIdentityService` with CRUD operations, preset library (Careful Reviewer, Fast Implementer, Night Owl, Code Health Inspector), version history (auto-increment + snapshot), identity validation against project-level AI permission settings, policy enforcement integration. | TODO |
| AGENT-004 | Agent identity management UI in Settings | Identity list with name, type badge, preset indicator, version number. Create/edit/clone/delete operations. Effective-policy preview before saving. Diff view between identity versions for audit. | TODO |
| AGENT-005 | Agents tab card-based UI | Replace list view with card grid following ADE design system. Agent cards with icon, name, type badge, status line, stats, enable/disable toggle. Type filter tabs (All / Automation / Night Shift / Watcher / Review). Search by name or description. | TODO |
| AGENT-006 | Agent detail panel | Overview tab (name, description, type, identity, trigger, behavior, guardrails with inline editing). Runs tab (execution history). Findings tab (watchers/reviewers only). "Run Now" and "Delete" buttons. | TODO |
| AGENT-007 | Custom Agent Builder wizard | 6-step guided wizard: Choose Type, Configure Identity, Set Trigger, Define Behavior, Set Guardrails, Review & Create. Plus NL creation alternative ("Describe what you want" textarea) reusing extended planner. | TODO |
| AGENT-008 | Night Shift service | `nightShiftService` built on agent/automation engine. Manages Night Shift queue, enforces strict guardrails (time limits, step caps, token budgets, USD limits), handles stop conditions (`first-failure` parking, `intervention-threshold` parking, `budget-exhaustion`), parks failed runs with structured failure context. | TODO |
| AGENT-009 | Night Shift budget infrastructure | Extend existing per-feature budget infrastructure (`ai_usage_log` table, `logUsage()`, `checkBudget()` daily enforcement — all already implemented in `aiIntegrationService`). New for Phase 4: subscription-aware scheduling (rate limit header parsing from Claude/Codex CLI responses, utilization mode selection, weekly reserve calculations, multi-batch scheduling across rate limit reset windows), subscription tier detection (Pro/Max/Plus), and Night Shift-specific budget caps (per-run session-level time/token/step/USD limits on top of existing daily limits). | TODO |
| AGENT-010 | Morning digest generator | Runs after all Night Shift agents complete (or at configured morning time). Aggregates outcomes from all overnight agent runs. Produces structured `MorningDigest` artifact with per-agent summaries, findings, changes proposed, budget consumption, pending review counts. | TODO |
| AGENT-011 | Morning Briefing UI | Swipeable card interface for reviewing overnight results. Card types for succeeded missions, failed/parked missions, watcher findings, PR review summaries. Actions: approve/dismiss/investigate. Keyboard shortcuts (arrows + space). Progress indicator (dots). Bulk actions (approve all, dismiss low-confidence). Auto-shown on app launch after Night Shift; also accessible from Agents tab header. Badge count on tab icon. | TODO |
| AGENT-012 | Watcher agent type | Polling loop implementation, change detection against previous state, finding emission on change, finding deduplication, `watchTargets` config support (GitHub releases, PRs, npm registry, URLs, custom), report format options (card, summary, diff). | TODO |
| AGENT-013 | Review agent type | GitHub API polling for assigned PRs, AI-powered review generation on new/updated PRs, review scope filtering (assigned-to-me, team, all-open), review depth options (summary, detailed, security-focused), finding emission for PR concerns. | TODO |
| AGENT-014 | Agent service refactor | Rename and extend `automationService` to `agentService`. Preserve all existing automation functionality. Register new agent types (night-shift, watcher, review) as behavior executors. Agent lifecycle: created, idle, triggered, running, completed/failed/parked. | TODO |
| AGENT-015 | Agent planner service refactor | Rename and extend `automationPlannerService` to `agentPlannerService`. Accept NL intent and generate full `Agent` config (not just automation rules). Support all four agent types. Validate generated configs against identity constraints. | TODO |
| AGENT-016 | IPC channel migration | Migrate all `ade.automations.*` channels to `ade.agents.*`. Add new channels for identities, Night Shift, and briefing. Maintain backward-compatible `ade.automations.*` aliases for one version cycle. | TODO |
| AGENT-017 | Config migration | Auto-migrate `automations:` key to `agents:` key in `.ade/ade.yaml` and `.ade/local.yaml` on first load. Each migrated rule becomes an agent with `type: 'automation'` and default identity. Preserve old `automations:` key for one version cycle (deprecated, read-only). | TODO |
| AGENT-018 | Settings integration | Agent Identities section in Settings (CRUD, presets, version history). Agents section replaces Automations section. Night Shift global settings (time window, compute backend, digest delivery time, global budget cap). Watcher global settings (default poll interval, GitHub API rate limit). Compute Backends section update (Night Shift default toggles on VPS/Daytona cards). | TODO |
| AGENT-019 | Backward compatibility | Old `ade.automations.*` IPC channels aliased to `ade.agents.*`. Old `automations:` config key still read and auto-migrated. Existing `automation_runs` records queryable via new agent run history UI. Missions without explicit identity get default identity applied. | TODO |
| AGENT-020 | Validation suite | Agent schema validation tests (all four types, all trigger types, all behavior configs). Identity policy application tests. Identity version history tests. Backward compatibility tests for existing automations. Budget enforcement tests. Night Shift stop-condition simulations. Morning digest generation tests. Morning briefing UI interaction tests. Watcher/review agent polling tests. Agent builder wizard flow tests. IPC backward compatibility tests. Config migration round-trip tests. | TODO |

### Dependency Notes

**Foundation dependencies** (all satisfied — AUTO items are DONE):
- AUTO-003 is prerequisite for AUTO-004.
- AUTO-004 is prerequisite for AUTO-005 through AUTO-007.
- AUTO-005/006/007 (triggers) can be developed in parallel.
- AUTO-008 through AUTO-012 (actions) can be developed in parallel.
- AUTO-013 depends on at least one action type being implemented.
- AUTO-014 depends on AUTO-013 (conditions evaluated during chain execution).
- AUTO-015 through AUTO-018 (UI) can be developed independently but need AUTO-004 for real data.
- AUTO-019 depends on AUTO-004 and AUTO-013.
- AUTO-020 depends on AUTO-013.
- AUTO-009 can use the existing `conflictService` implemented in Phase 5 (no additional dependency).
- AUTO-010 depends on the AI integration service from Phase 1 (Agent SDK Integration).
- AUTO-021 through AUTO-027 (NL planner) depend on AUTO-004 for rule schema and AUTO-015 for UI integration.

**Phase 4 dependencies**:
- AGENT-001 (rebrand) is the prerequisite for all other AGENT items (establishes new naming and routing).
- AGENT-002 (schema + data model) is prerequisite for AGENT-003, AGENT-005, AGENT-008, AGENT-012, AGENT-013, AGENT-014.
- AGENT-003 (identity service) is prerequisite for AGENT-004 (identity UI) and AGENT-007 (builder wizard step 2).
- AGENT-005 (card UI) and AGENT-006 (detail panel) can be developed in parallel once AGENT-002 is done.
- AGENT-007 (builder wizard) depends on AGENT-003 (identities), AGENT-005 (page to host the wizard), and AGENT-015 (planner for NL creation).
- AGENT-008 (Night Shift service) depends on AGENT-002 (data model) and AGENT-003 (identity enforcement).
- AGENT-009 (Night Shift budget) depends on AGENT-008.
- AGENT-010 (morning digest) depends on AGENT-008.
- AGENT-011 (Morning Briefing UI) depends on AGENT-010 (digest data to display).
- AGENT-012 (watcher type) and AGENT-013 (review type) depend on AGENT-002 and AGENT-014 (agent service).
- AGENT-014 (agent service refactor) depends on AGENT-002.
- AGENT-015 (planner refactor) depends on AGENT-002 and AGENT-014.
- AGENT-016 (IPC migration) depends on AGENT-014 (agent service must exist before channels are migrated).
- AGENT-017 (config migration) can start once AGENT-002 defines the new schema.
- AGENT-018 (settings) depends on AGENT-003 (identities) and AGENT-008 (Night Shift settings).
- AGENT-019 (backward compat) depends on AGENT-016 and AGENT-017.
- AGENT-020 (validation) depends on all other AGENT items being at least partially implemented.

### Compute Backend in Agents (Planned)

Agent configurations will support a `computeBackend` field:

- **Field**: `computeBackend: 'local' | 'vps' | 'daytona' | 'e2b'` (optional, defaults to project setting)
- **Use Case**: Route specific agents to specific backends
- **Night Shift Integration**: When Night Shift agents trigger after-hours, they can be automatically routed to VPS or Daytona backends to avoid consuming local machine resources
- **Example**: CI-like automation agents (lint, test, build) routed to Daytona for isolated execution; deployment agents routed to VPS for network access; Night Shift agents default to VPS for overnight runs
- **Settings Integration**: Night Shift default backend toggle on VPS/Daytona cards in Settings > Compute Backends

Note: Daytona routing is only available when Daytona is configured (opt-in) in Settings > Compute Backends.

### Headless Agent Execution via MCP Dual-Mode

Agents can run outside the desktop app via the MCP server's dual-mode architecture:

- **Headless mode** (stdio transport): The MCP server runs standalone with full AI capabilities. `aiIntegrationService` is wired in during bootstrap, auto-detecting `ANTHROPIC_API_KEY`, `claude` CLI, or other available providers. All 35 MCP tools are available.
- **Embedded mode** (socket transport): When the desktop is running, it serves `.ade/mcp.sock`. External agents connect via the socket and proxy through the desktop, getting live UI updates and shared service instances.
- **Smart entry point**: The MCP server auto-detects whether `.ade/mcp.sock` exists. If present, it connects as an embedded proxy; otherwise it starts in headless mode with its own AI backend.
- **Transport abstraction**: A `JsonRpcTransport` interface supports both stdio (for headless/CI usage) and Unix socket (for desktop embedding), allowing the same tool surface to work in both contexts.

This enables CI/CD pipelines, evaluation harnesses, and external tools (e.g., Claude Code) to drive agent workflows without requiring the desktop app to be running.

---

## Concierge Agent

### Purpose

The **Concierge Agent** is ADE's single entry point for external agent systems. When an external agent (OpenClaw, Claude Code, Codex CLI, or any MCP-connected tool) wants to interact with ADE, it does not need to understand which internal surface to target. Instead, it sends its request to the Concierge, which classifies the intent and routes it to the appropriate ADE capability.

The Concierge acts as a receptionist and dispatcher: it receives unstructured or semi-structured requests, understands what the caller is trying to accomplish, and delegates to the right subsystem. This eliminates the need for external agents to know ADE's internal architecture or tool surface.

Users who interact with ADE directly through the desktop UI never need the Concierge. It exists solely for the programmatic/external agent integration path.

### Request Routing

When the Concierge receives a request, it classifies the intent and routes accordingly:

| Intent Classification | Routed To | Example Request |
|---|---|---|
| **Development task** (large) | Mission system with phased plan | "Refactor the auth module to use JWT refresh tokens" |
| **Development task** (small) | Task Agent (one-off) | "Add a loading spinner to the login page" |
| **Status query** | MCP read tools (mission/lane/agent state) | "What's the status of the auth refactor mission?" |
| **Simple code change** | Task Agent with minimal guardrails | "Fix the typo in README.md line 42" |
| **PR review request** | Review Agent | "Review PR #87 before I merge" |
| **Code question** | Context pack reader, returns answer | "How does the auth middleware handle expired tokens?" |
| **Agent management** | Agent service IPC | "List all running agents" or "Stop the overnight refactor" |

The Concierge uses an LLM call to classify ambiguous requests. For well-structured requests (e.g., those that arrive with explicit `intent` metadata from the MCP tool call), classification is deterministic and skips the LLM step.

**Large vs. small task distinction**: The Concierge estimates task complexity based on the request description. Tasks that involve multiple files, architectural changes, or multi-step workflows are routed to the full mission system with an AI-generated phased plan. Tasks that are scoped to a single file or a straightforward change are routed to a Task Agent for immediate execution.

### Identity and Learning

The Concierge has its own agent identity, stored at `.ade/agents/concierge.yaml` with project-level memory at `.ade/memory/agents/concierge.json`. This gives it:

- **Persistent context**: The Concierge remembers previous routing decisions, project-specific patterns, and user preferences across sessions.
- **Learned routing patterns**: Over time, the Concierge learns which routing paths work best for specific request types. For example, it may learn that "the user always wants TypeScript refactoring tasks routed to the Fast Implementer agent" or "PRs from the `infra` team should use security-focused review depth."
- **Project awareness**: The Concierge reads project-level memory to understand codebase structure, conventions, and team preferences, enabling more accurate intent classification.

Learned routing patterns are stored in the Concierge's identity memory and can be reviewed/edited by the user in the Agent Identity management UI.

---

## Memory Architecture

ADE agents operate with a structured, multi-tier memory system designed to balance context window efficiency with long-term knowledge retention. Memory is scoped, searchable, and portable across machines.

### Three-Tier Memory Model

| Tier | Name | Size in Context | Storage | Description |
|---|---|---|---|---|
| **Tier 1** | Core Memory | ~2-4K tokens (always loaded) | In-memory + `.ade/memory/` | The agent's essential working context. Includes persona definition, current task context, and critical project facts. Self-editable by the agent via the `memoryUpdateCore` tool. |
| **Tier 2** | Hot Memory | Retrieved on demand | SQLite + sqlite-vec | Recent episodic memories, relevant facts, mission shared data. Retrieved via hybrid search when the agent needs additional context. Uses composite scoring: `semantic(0.5) + recency(0.2) + importance(0.2) + access(0.1)`. |
| **Tier 3** | Cold Memory | Never in context (archival) | `.ade/memory/archive/` | Old memories, low-importance facts, and historical records. Moved here after an inactivity period. Can be promoted back to Tier 2 if accessed. |

**Why three tiers?** AI context windows are finite and expensive. Tier 1 ensures the agent always has its essential identity and task context without retrieval latency. Tier 2 provides rich supplementary knowledge via fast hybrid search. Tier 3 keeps historical data available without polluting search results or consuming storage in the active database.

### Memory Scopes

Memory is partitioned into scopes that control visibility and lifetime:

| Scope | Visibility | Lifetime | Purpose |
|---|---|---|---|
| **Identity** | Per-agent only | Persistent (forever) | Agent-specific learned behaviors, preferences, and procedures. Never leaks to other agents. Stored per-agent in `.ade/memory/agents/{agent-name}.json`. |
| **Project** | All agents in the project | Persistent | Codebase patterns, conventions, architectural decisions, known gotchas. Shared knowledge that benefits every agent working on the project. Stored in `.ade/memory/project.json`. |
| **Mission** | All agents in a mission run | Mission lifetime (temporary) | Facts discovered during a specific mission. Visible to all participating agents. Can be promoted to project scope after mission completion (policy-driven, user-reviewable). |
| **Session** | Single agent session | Ephemeral | Conversation context, intermediate reasoning, scratch notes. Dies when the session ends. Not persisted to disk. |

**Scope isolation is strict**: An agent's identity memory never leaks to other agents. Project memory is readable by all agents but writeable only through explicit `memoryAdd` calls with `scope: 'project'`. Mission memory is automatically cleaned up after mission completion unless promoted.

### Memory Operations

#### Search

Memory search uses a hybrid approach combining keyword and semantic matching:

- **BM25 keyword search** (30% weight): Fast, precise matching for exact terms and identifiers. Handles code-specific queries well (function names, variable names, error messages).
- **Vector similarity search** (70% weight): Semantic matching via embeddings stored in sqlite-vec. Finds conceptually related memories even when exact terms differ.
- **Composite scoring**: Final relevance score = `semantic(0.5) + recency(0.2) + importance(0.2) + access_frequency(0.1)`. This ensures recent, important, frequently-accessed memories surface first, while still allowing old but semantically relevant memories to appear.

#### Add

When a new memory is added, the system performs an automatic **consolidation check**:

1. Compute cosine similarity between the new memory and existing memories in the same scope.
2. If similarity exceeds **0.85** threshold, invoke an LLM to decide the consolidation action:
   - **PASS**: New memory is sufficiently distinct; add it as a new entry.
   - **REPLACE**: New memory supersedes the existing one; replace the old entry.
   - **APPEND**: New memory adds detail to the existing one; merge them into a single enriched entry.
   - **DELETE**: The new memory contradicts or invalidates the existing one; remove the old entry and add the new one.

This prevents memory bloat from near-duplicate entries while preserving genuinely distinct knowledge.

#### Promote

Memories can be promoted from a narrower scope to a broader one:

- **Mission to Project**: Facts discovered during a mission that are generally useful (e.g., "this project uses Vitest, not Jest" or "the API always returns snake_case").
- Promotion is policy-driven: auto-promote when confidence exceeds a threshold, or queue for user review.
- Promoted memories retain provenance metadata (source mission, original agent, timestamp).

#### Archive

Memories are moved to cold storage (Tier 3) after an inactivity period:

- Memories not accessed for a configurable period (default: 90 days) are candidates for archival.
- Archived memories are moved to `.ade/memory/archive/` as compressed JSON.
- Archived memories can still be found via explicit deep searches but are excluded from standard retrieval.

### Pre-Compaction Flush

Before context compaction occurs (triggered at 70% of the model's context window), the memory system executes a **pre-compaction flush**:

1. The compaction engine detects the 70% threshold is approaching.
2. A **silent agentic turn** is injected: the agent is prompted with "Write any important memories to disk before context is compacted."
3. The agent uses its own intelligence to decide what matters — which facts, decisions, patterns, and gotchas from the current conversation should be persisted.
4. The agent calls `memoryAdd` for each item it wants to preserve.
5. Only after the flush completes does the compaction engine proceed to summarize and truncate the context.

This approach is superior to rule-based extraction because the agent understands the semantic importance of its own conversation context. A mechanical extractor would miss nuance; the agent knows which offhand comment was actually a critical architectural decision.

### Temporal Decay

Memory relevance decays over time using a **30-day half-life** for the recency component of composite scoring:

| Time Since Creation | Recency Score |
|---|---|
| Today | 100% |
| Yesterday | ~84% |
| 1 week ago | ~73% |
| 1 month ago | 50% |
| 3 months ago | ~12.5% |
| 6 months ago | ~1.6% |

**Exceptions to decay**:
- **Core Memory (Tier 1)** never decays — it is always at full relevance.
- **Promoted facts** (memories explicitly promoted to project scope) never decay.
- **Pinned memories** (via `memoryPin`) never decay.
- Decay only affects the recency component (20% of composite score). A 6-month-old memory with high semantic relevance and high importance still scores well: `semantic(0.5) * 0.9 + recency(0.2) * 0.016 + importance(0.2) * 1.0 + access(0.1) * 0.5 = 0.753`.

### Memory Tools Available to Agents

Agents have access to the following memory tools during execution:

| Tool | Signature | Description |
|---|---|---|
| `memorySearch` | `memorySearch(query, scope?, limit?)` | Hybrid BM25 + vector search with composite scoring. Returns ranked results from the specified scope (or all accessible scopes if omitted). Default limit: 10. |
| `memoryAdd` | `memoryAdd(content, category, scope, importance?)` | Add a new memory with automatic consolidation check. `category` is one of: `fact`, `preference`, `pattern`, `decision`, `procedure`, `gotcha`. `importance` is 0.0-1.0 (default: 0.5). |
| `memoryUpdateCore` | `memoryUpdateCore(content)` | Self-edit the agent's Tier 1 working context. Used to update current task state, active constraints, or critical notes that should always be in context. |
| `memoryPin` | `memoryPin(memoryId)` | Pin a Tier 2 memory to Tier 1 (always in context). Pinned memories bypass temporal decay and are included in every context assembly. Use sparingly — each pin consumes context window budget. |
| `memoryPromote` | `memoryPromote(memoryId, targetScope)` | Promote a memory from a narrower scope to a broader one (e.g., mission to project). Respects promotion policies and may queue for user review depending on project settings. |

### Episodic and Procedural Memory

Beyond the standard fact/preference/pattern categories, ADE supports two advanced memory types that enable agents to learn from experience:

#### Episodic Memory

After each session or mission, the system extracts a structured **episodic summary**:

| Field | Description |
|---|---|
| `task` | What the agent was asked to do |
| `approach` | Strategy the agent chose and why |
| `outcome` | Success, partial success, or failure with details |
| `toolsUsed` | Which tools were invoked and how often |
| `patternsDiscovered` | New code patterns, API patterns, or architectural insights found during execution |
| `gotchas` | Pitfalls encountered, workarounds applied, edge cases hit |
| `decisionsMade` | Key decisions and their rationale |
| `duration` | Wall-clock time and token consumption |

Episodic memories are stored in Tier 2 (hot memory) and are retrieved when the agent faces similar tasks in the future. For example, if an agent previously refactored the auth module and encountered a circular dependency, that episodic memory surfaces when a future task involves the same module.

#### Procedural Memory

Procedural memory captures **learned workflows and tool-usage patterns** — the "how to" knowledge that agents accumulate through repeated execution:

| Field | Description |
|---|---|
| `procedure` | Step-by-step workflow (e.g., "When running tests in this project: 1) Run `tsc --noEmit` first, 2) Then run `vitest`, 3) If type errors, fix those before re-running tests") |
| `confidence` | 0.0-1.0 score, reinforced by success/failure counts |
| `successCount` | Number of times this procedure led to a successful outcome |
| `failureCount` | Number of times this procedure was followed but the task still failed |
| `lastUsed` | Timestamp of most recent invocation |
| `applicableWhen` | Conditions under which this procedure applies (e.g., "TypeScript project", "React component tests") |

Procedural memories are **confidence-scored and self-reinforcing**:
- Each successful use increments `successCount` and increases `confidence`.
- Each failure increments `failureCount` and decreases `confidence`.
- Procedures with confidence below 0.3 are flagged for review or archival.
- High-confidence procedures (> 0.8) are prioritized in retrieval and may be auto-applied.

Both episodic and procedural memories feed into Tier 2 hot memory and are retrieved during future agent execution via the standard `memorySearch` tool.

### Prior Art & Design References

ADE's memory architecture draws on research and production systems across the agent memory ecosystem. This section documents the external work that informed design decisions and the specific adaptations ADE makes.

| Concept | Source | ADE Adaptation |
|---|---|---|
| Three-tier memory (core blocks / archival / recall) | **MemGPT / Letta** — treats LLM context as "main memory" with explicit agent-managed read/write to "disk" | Tier 1/2/3 with composite scoring and `.ade/` file portability. Letta benchmarks (74% accuracy with file operations) validated our file-backed approach. |
| PASS/REPLACE/APPEND/DELETE consolidation | **Mem0** — real-time deduplication on every write with LLM-decided merge operations | Adopted with 0.85 cosine threshold and scope-aware matching. Mem0's benchmarks (68.5%) informed our conservative threshold choice. |
| Composite scoring formula (semantic + recency + importance + access) | **CrewAI RecallFlow** — multi-signal retrieval combining semantic similarity with temporal and frequency signals | Simplified weights for predictability: `0.5/0.2/0.2/0.1`. Added explicit importance tags (vs. CrewAI's inferred importance). |
| Pre-compaction memory flush (agent-driven persistence before eviction) | **OpenClaw** — Markdown-based memory (MEMORY.md + daily logs) with agent self-save before context loss | Formalized with flush counter, compaction engine hook, and tool-based persistence. |
| Hybrid BM25 + vector search | **OpenClaw / RAG literature** — keyword + semantic search with configurable weights | 30/70 BM25/vector split with MMR re-ranking (lambda=0.7) to reduce redundancy. |
| Episodic and procedural memory taxonomy | **LangMem (LangChain)** — structured post-session summaries and learned tool-usage patterns | Adapted with confidence scoring, success/failure self-reinforcement, and cross-episode pattern extraction for procedural entries. |
| Zettelkasten-inspired memory linking | **A-MEM** — automatic linking between related memory entries creating a knowledge graph | Implicit via APPEND consolidation and composite scoring co-retrieval. Full graph navigation deferred to a future phase. |
| Observation masking over LLM summarization | **JetBrains (NeurIPS 2025)** — replacing old tool outputs with placeholders outperforms LLM summarization, is cheaper | Applied in context assembly for resumed sessions: old tool outputs beyond recent N are masked, not summarized. |
| Context window separation (business vs. code) | **Elvis Sun's ZOE/CODEX architecture** — orchestrator and workers in separate context windows because context is zero-sum | ADE's leader/worker model: orchestrator holds mission context, workers hold code context. Mixing degrades both. |
| Identity persistence via versioned Markdown | **SOUL.md / CLAUDE.md / OpenClaw MEMORY.md** — community practice of defining agent persona in versionable files | Formalized as `.ade/identities/*.yaml` with version history, audit trail, and policy enforcement. |

---

## Portable State (.ade/ Directory)

ADE stores all agent-related state in the `.ade/` directory at the project root. This directory is designed to be **committed to the repository**, making ADE's entire agent configuration and knowledge base portable across machines.

### Directory Structure

```
.ade/
├── memory/
│   ├── project.json          # Project-level facts (shared across all agents)
│   ├── learning-pack.json    # Auto-curated knowledge extracted from agent runs
│   ├── archive/              # Cold storage (Tier 3 archived memories)
│   └── agents/
│       ├── concierge.json    # Concierge agent identity memory
│       ├── night-owl.json    # Night Owl agent identity memory
│       └── reviewer.json     # Reviewer agent identity memory
├── agents/
│   ├── concierge.yaml        # Concierge agent definition
│   ├── night-owl.yaml        # Night Owl agent definition
│   └── reviewer.yaml         # Reviewer agent definition
├── identities/
│   ├── careful-reviewer.yaml # Identity preset definition
│   └── fast-implementer.yaml # Identity preset definition
├── history/
│   └── missions.jsonl        # Mission run log (append-only)
└── config.yaml               # ADE project configuration
```

### Portability Principles

- **Committable to repo**: Any machine with the repo clone has the full ADE agent state — definitions, identities, project memory, and learned knowledge.
- **Git IS the sync layer**: There is no separate hub, cloud service, or sync mechanism. Git push/pull propagates agent state to all team members.
- **Embeddings are local**: The embeddings cache (`.ade/embeddings.db`) is listed in `.gitignore` because embeddings are model-specific and regenerated locally on first use. The source data (JSON memory files) is what gets committed.
- **Merge-friendly format**: Memory files use JSON with sorted keys for clean diffs. Agent definitions use YAML for readability. The mission history log uses append-only JSONL for conflict-free concurrent appends.

---

## External Agent Integration

ADE is designed to be both a standalone development environment and a programmable backend that external agents can drive.

### MCP Tool Surface

The ADE MCP server exposes 35 tools for external consumption, covering the full range of ADE capabilities:

- **Mission tools**: `create_mission`, `get_mission`, `start_mission`, `pause_mission`, `cancel_mission`, `steer_mission`
- **Lane tools**: `create_lane`, `get_lane_status`, `merge_lane`, `rebase_lane`
- **Agent tools**: `spawn_agent`, `get_worker_states`, `resolve_intervention`
- **Evaluation tools**: `run_tests`, `evaluate_run`, `list_evaluations`, `get_evaluation_report`
- **Context tools**: `read_context`, `check_conflicts`, `get_timeline`
- **Integration tools**: `create_integration`, `simulate_integration`, `commit_changes`, `get_final_diff`, `get_pr_health`

### External Agent Workflow

External agents connect to ADE through the MCP protocol. The typical flow:

1. **External agent connects**: An agent (OpenClaw, Claude Code, Codex CLI) establishes an MCP connection — either via stdio (headless mode) or Unix socket (embedded mode when the desktop app is running).
2. **Request arrives at Concierge**: The external agent's request is received by the Concierge Agent, which classifies intent and routes accordingly.
3. **ADE executes**: The routed subsystem (mission orchestrator, task agent, review agent, etc.) performs the work.
4. **Results return via MCP**: Execution results, status updates, and artifacts are returned through the MCP tool response.

### Example: OpenClaw-to-ADE Delegation

A concrete example of external agent integration:

```
OpenClaw agent receives user request:
  "Add a dark mode toggle to the settings page"
    │
    ▼
OpenClaw connects to ADE MCP server
    │
    ▼
Calls create_mission tool with task description
    │
    ▼
Concierge classifies: medium development task → Mission system
    │
    ▼
Orchestrator generates phased plan:
  Step 1: Add theme context provider
  Step 2: Create toggle component
  Step 3: Wire into settings page
  Step 4: Update tests
    │
    ▼
Mission executes (agents work in lanes)
    │
    ▼
Results pushed to git, PR opened
    │
    ▼
MCP returns: { status: "completed", pr: "#52", branch: "dark-mode-toggle" }
    │
    ▼
OpenClaw reports back to user: "Done. PR #52 is ready for review."
```

### Bidirectional Integration

ADE agents can also **consume external MCP servers** for extended capabilities. An ADE agent executing a mission step can call tools from external MCP servers registered in the project configuration. This enables workflows like:

- An ADE agent calling a Figma MCP server to fetch design specs before implementing a UI component.
- An ADE agent calling a PostHog MCP server to check feature flag status before making changes.
- An ADE agent calling a Linear MCP server to update issue status after completing a task.

---

## Agent Identity Persistence

Agent identities are versioned, auditable, and portable files that define how an agent behaves across all its executions.

### Storage and Format

Identities are stored as YAML files in `.ade/identities/`:

```yaml
# .ade/identities/careful-reviewer.yaml
name: "Careful Reviewer"
version: 3
persona: |
  You are a meticulous code reviewer focused on correctness, security,
  and maintainability. You read every line carefully and flag potential
  issues even if they seem minor. You never approve a PR without at
  least one suggestion for improvement.
modelPreferences:
  provider: claude
  model: sonnet
  reasoningEffort: high
riskPolicies:
  allowedTools: []           # Empty = all tools allowed
  deniedTools:
    - run-command             # Reviewers should not execute commands
    - commit-changes          # Reviewers should not commit
  autoMerge: false
  maxFileChanges: 0           # Read-only: cannot modify files
  maxLinesChanged: 0
permissionConstraints:
  claudePermissionMode: plan
  codexSandboxLevel: read-only
  codexApprovalMode: untrusted
```

### Design Principles

Identity design is inspired by the **SOUL.md pattern**: the core identity (persona, fundamental constraints) is stable across versions, while preferences and policies evolve over time.

Each identity file includes:

| Field | Description |
|---|---|
| `name` | Human-readable persona name |
| `version` | Monotonically increasing version number (auto-incremented on save) |
| `persona` | System prompt overlay — the agent's personality and behavioral guidelines |
| `modelPreferences` | Provider, model, and reasoning effort preferences |
| `riskPolicies` | Tool allow/deny lists, merge permissions, file/line change limits |
| `permissionConstraints` | Claude permission mode, Codex sandbox level, approval mode |

### Version History

Every edit to an identity increments its version number and creates a snapshot in the `agent_identity_versions` database table. This provides:

- **Audit trail**: See exactly what changed between versions and when.
- **Rollback capability**: Restore a previous version if a policy change causes problems.
- **Diff view**: Compare any two versions side-by-side in the Settings > Agent Identities UI.

### Built-in Presets

ADE ships with four identity presets, each optimized for a specific use case:

| Preset | Model | Risk Level | Key Behaviors |
|---|---|---|---|
| **Careful Reviewer** | Claude Sonnet, high reasoning | Low risk | Plan-only permissions, read-only sandbox, no code modification, security-focused review depth |
| **Fast Implementer** | Claude Sonnet, medium reasoning | Medium risk | Accept-edits permissions, workspace-write sandbox, higher file/line limits, speed-optimized |
| **Night Owl** | Claude Sonnet, medium reasoning | Low-medium risk | Conservative guardrails, parks on first failure, generates morning digest, subscription-aware budgets |
| **Code Health Inspector** | Claude Haiku, low reasoning | Minimal risk | Read-only, observation-focused, no code modification, reports findings only, cost-efficient |

### Custom Identities

Users can create custom identities through two paths:

1. **Agent Builder Wizard** (Step 2): Interactive form with all identity fields, effective-policy preview, and validation against project-level AI settings.
2. **Natural Language**: Describe the identity in plain language (e.g., "An agent that focuses on performance optimization, uses Claude Opus for complex analysis, and never modifies test files"). The `agentPlannerService` generates the structured identity definition.

Custom identities are saved to `.ade/identities/` and are immediately available to all agents in the project.

---

## Roadmap Alignment

Per `docs/final-plan.md`, Phase 4 (Agents Hub, 5-6 weeks) is the rebrand of the Automations feature into a unified Agents tab. The phase depends on Phase 3 (AI Orchestrator) being complete.

Phase 4 delivers:
- **Agents Hub**: Rebrand Automations tab into Agents with card-based UI.
- **Agent Identities**: Reusable persona + policy profiles with version history and enforcement. Database identity schema already created and used for runtime profile assembly.
- **Night Shift Agents**: Unattended overnight mission execution with strict guardrails and morning digest.
- **Watcher and Review Agents**: External resource monitoring and PR pre-review capabilities.
- **Morning Briefing UI**: Swipeable card interface for rapid review of overnight results.

The existing Automations engine (trigger-action pipelines, NL-to-rule planner, trust enforcement, job engine) forms the complete foundation. All AUTO-001 through AUTO-029 items are implemented and become the `automation` agent type within the new Agents system.

**Hivemind contributions to Phase 4 readiness**: The Orchestrator Evolution (Hivemind) workstreams delivered several capabilities that directly support Phase 4:
- **Inter-agent messaging** (`teamMessageTool`, `sendAgentMessage()` IPC, @mention system) provides the communication infrastructure agents need. Message delivery is now centralized in `workerDeliveryService` (1,329 lines) and chat threading in `chatMessageService` (1,849 lines), both extracted from the AI orchestrator during the service decomposition.
- **Worker tracking** (`workerTracking`, 1,087 lines) provides dedicated worker state management and event handling, extracted from the AI orchestrator.
- **Memory service** with candidate promotion and shared facts gives agents persistent knowledge across runs.
- **Context compaction engine** ensures long-running agent sessions (critical for Night Shift) can operate within context window limits.
- **Agent identity schema** (`agent_identities` table) provides the storage foundation for identity CRUD.
- **Dynamic fan-out** via meta-reasoner enables the parallelized execution model that Task Agents and Night Shift agents will rely on.

Missions remain separate ad-hoc goal objects (documented in [features/MISSIONS.md](features/MISSIONS.md)). Agents is the recurring trigger layer that can launch missions — Night Shift agents specifically use the mission system to execute complex tasks overnight via the orchestrator.

---

*This document describes the Agents feature for ADE. The foundation automation engine (AUTO-001 through AUTO-029) is fully implemented from Phase 8. The Hivemind workstreams (Orchestrator Evolution) added inter-agent messaging, memory architecture, context compaction, dynamic fan-out, and agent identity schema. Phase 4 extends this into a unified agent hub with five agent types (automation, night-shift, watcher, review, task), agent identities, Night Shift mode, Morning Briefing, and a card-based management UI.*
