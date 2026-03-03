# Missions — AI Orchestrator Control Center

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-02
>
> **Phase 4 Status: Agent-First Runtime Migration In Progress**

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
  - [Mission](#mission)
  - [Mission Step](#mission-step)
  - [Intervention](#intervention)
  - [Artifact](#artifact)
  - [Mission Pack](#mission-pack)
  - [Step Handoff](#step-handoff)
  - [Execution Target](#execution-target)
  - [Agent Runtime Chain](#agent-runtime-chain)
- [User Experience](#user-experience)
  - [Phase 1 Surface](#phase-1-surface)
  - [Launch Flow](#launch-flow)
  - [Mission Board](#mission-board)
  - [Mission Detail](#mission-detail)
  - [Mission Chat (Slack-Style)](#mission-chat-slack-style)
  - [Dynamic Fan-Out](#dynamic-fan-out)
  - [Run Narrative](#run-narrative)
  - [Mobile-First Behavior](#mobile-first-behavior)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
  - [Renderer Components](#renderer-components)
  - [Event Flow](#event-flow)
- [Data Model](#data-model)
- [Implementation Tracking](#implementation-tracking)
  - [Phase 1 (Implemented)](#phase-1-implemented)
  - [Phase 1.5 (Context Hardening Gate, Implemented)](#phase-15-context-hardening-gate-implemented)
  - [Phase 2 Runtime v2 (Implemented)](#phase-2-runtime-v2-implemented)
  - [Phase 3 AI Orchestrator Integration (Implemented)](#phase-3-ai-orchestrator-integration-implemented)
  - [Phase 4 Agent-First Runtime Migration (In Progress)](#phase-4-agent-first-runtime-migration-in-progress)
  - [Mission Memory Integration](#mission-memory-integration)
  - [Mission History Portability](#mission-history-portability)
  - [Cross-Machine Mission Execution](#cross-machine-mission-execution)
  - [CTO to Mission Flow](#cto-to-mission-flow)

---

## Overview

The **Missions tab** is ADE's mission orchestration surface for plain-English task intake, chain-based execution, and runtime tracking.

From Phase 4 onward, mission execution is **agent-first**: each mission step is executed by an agent runtime created from an agent definition (resident or task class), with standard runtime IDs, memory policy, and guardrails applied uniformly.

It gives users a fast way to:

- launch a mission from a prompt,
- assign lane/priority/execution target metadata,
- let ADE plan and execute mission steps through chained agent runtimes,
- track status in queue-style lanes,
- manage interventions when human input is required,
- capture outcomes and link artifacts (including PR URLs).

Phase 1.5 context hardening adds durable mission packs, step handoffs, and orchestrator runtime persistence. Phase 2 runtime expansion connects orchestrator controls to the mission detail surface. Phase 3 delivers orchestrator-driven execution. Phase 4 migrates mission AI execution to the unified agent runtime contract used across ADE.

---

## Core Concepts

### Mission

A **Mission** is a user-defined goal object with lifecycle state:

- `queued`
- `planning`
- `plan_review`
- `in_progress`
- `intervention_required`
- `completed`
- `partially_completed`
- `failed`
- `canceled`

Missions are durable records, persisted locally and visible in a board + detail experience.

### Mission Step

A **Mission Step** is an ordered subtask row attached to a mission.

- Step plans are coordinator-authored in team-runtime mode.
- Planner metadata includes dependency indices, join policy, done criteria, and context policy hints.
- Steps have independent status transitions (`pending`, `ready`, `running`, `succeeded`, `failed`, `blocked`, `skipped`, `superseded`, `canceled`).
- Plan revisions preserve audit history by superseding steps instead of deleting them.
- Runtime enforces graph/state integrity, but strategy decisions (replan, retry, replacement, escalation) remain coordinator-owned; when coordinator is unavailable, runs pause/escalate rather than falling back to deterministic strategy handlers.
- A failed step can automatically open an intervention and move the mission into `intervention_required`.

### Intervention

An **Intervention** is a human-in-the-loop checkpoint.

- Open interventions block forward mission flow.
- Interventions can be resolved or dismissed.
- Resolving all open interventions can auto-resume mission progress when appropriate.

### Artifact

An **Artifact** is a mission outcome reference.

Supported artifact types:

- `summary`
- `pr`
- `link`
- `note`
- `patch`
- `screenshot`: PNG/JPEG image captured from agent environment
- `video`: Screen recording of agent work (MP4)
- `test-result`: Structured test output (pass/fail counts, log)

Artifacts support PR handoff, traceability, and post-mission review.

**Lane artifact sharing**: When a mission step produces artifacts while working in a lane, the artifacts are attached to both the mission (for mission-level tracking) and the lane (for lane-level visibility and PR integration). This dual-attachment ensures artifacts are accessible from both the Missions tab and the Lanes tab.

### Mission Pack

A **Mission Pack** is a deterministic mission-level context artifact (`mission:<missionId>`) with immutable versioning and pack events. It snapshots:

- mission metadata and prompt,
- mission step status progression,
- artifacts/interventions counts,
- linked orchestrator runs,
- recent structured step handoffs.

Mission packs are refreshed on mission mutations and orchestrator run starts to keep mission context resumable and auditable.

### Step Handoff

A **Step Handoff** is a structured record emitted per orchestrated step attempt (`mission_step_handoffs`):

- `attempt_started`
- `attempt_succeeded`
- `attempt_failed`
- `attempt_blocked`
- `attempt_canceled`
- `attempt_recovered_after_restart`

Handoffs are machine-readable payloads used for deterministic resume, history replay, and context provenance.

### Execution Target

Mission execution target metadata includes:

- `executionMode`: `local`
- optional `targetMachineId`

All execution is local, powered by ADE's AgentExecutor interface which spawns Claude Code and Codex CLIs via their respective native SDKs using existing user subscriptions. No API keys or remote relay required.

### Agent Runtime Chain

An **Agent Runtime Chain** is the ordered set of mission runtimes that execute the plan. The orchestrator:

- receives the mission prompt and project context,
- generates or refines the mission step plan,
- resolves each step to an agent definition plus runtime policy,
- creates runtime threads bound to run/step/attempt/session IDs,
- injects bounded profile files (`IDENTITY`, `TOOLS`, `USER_PREFS`, `HEARTBEAT`, `MEMORY_SUMMARY`),
- streams progress events to the renderer and handles failure/intervention transitions.

This model separates long-lived identity/home threads from mission runtime threads while preserving deterministic auditability.

### Computer Use in Mission Steps

Mission steps can optionally use computer use capabilities for tasks that require visual interaction with running applications. The mission planner or user can specify a compute environment type per step:

- Steps with `computeEnvironment: 'browser'` or `computeEnvironment: 'desktop'` gain access to computer use MCP tools (screenshot_environment, interact_gui, record_environment, launch_app)
- The orchestrator selects the appropriate compute backend based on mission configuration and available infrastructure
- Visual artifacts (screenshots, videos) produced during step execution are attached to both the mission and the target lane
- Computer use is opt-in per step — most steps use terminal-only by default

---

## User Experience

### Phase 1 Surface

Missions is exposed as a first-class tab (`/missions`) in the left rail.

The page includes:

- summary/status cards,
- mission launch form,
- mission board lanes (by status),
- detail panel with actions, steps, interventions, artifacts, and timeline.

### Launch Flow

Users launch a mission with:

- plain-English prompt (required),
- optional title,
- optional lane,
- priority,
- execution mode (`local`),
- executor policy selection (`both` / `codex` / `claude`),
- optional target machine ID.

Before launch, the dialog runs an explicit **pre-flight checklist** gate (models, permissions, worktrees, phase config validity, semantic checks for custom phases, and budget envelope/estimate). Hard failures block launch; warnings are advisory.

The AI orchestrator receives the prompt and plans execution steps. Users can choose between autopilot mode (orchestrator drives execution end-to-end) or manual mode (user advances steps).

### Chat-to-Mission Escalation

When a task started in agent chat grows beyond single-agent scope, it can be escalated to a full mission:

1. In agent chat, user says "this needs a full mission" or the agent suggests escalation when it recognizes multi-lane/multi-agent complexity
2. Chat context (conversation history, files changed, current state) is packaged as mission input
3. Mission launcher opens pre-filled with the chat context as the prompt
4. User confirms → mission created with a reference link back to the originating chat session
5. Mission results can be summarized back into the originating chat session for continuity

**IPC**: `ade.agentChat.escalateToMission(sessionId)` packages the chat session context and opens the mission launcher.

### Mission Board

The board is lane-oriented by mission status and optimized for quick scan:

- queued
- running
- action needed
- completed
- failed
- canceled

Each card shows priority, lane, last update time, step progress, and open intervention count.

Board layout note:

- status lanes render in one horizontal track above detail,
- each status column has fixed width and horizontal overflow for small screens.

### Mission Detail

The detail surface is organized into six workspace tabs:

| Tab | Key | Description |
|-----|-----|-------------|
| **Plan** | `plan` | Hierarchical phase -> milestone -> task view with runtime statuses and expected-signal visibility |
| **Work** | `work` | Follow-mode worker monitor with transcript tails, files touched, and tool usage |
| **DAG** | `dag` | Step dependency graph with animated edge transitions and single progress bar |
| **Chat** | `chat` | Slack-style chat interface (MissionChatV2) with sidebar channels |
| **Activity** | `activity` | Filtered activity feed with category dropdown |
| **Details** | `details` | Usage dashboard, mission metadata, phase profile summary, and configuration |

The detail surface includes:

- mission summary metadata,
- status actions (pause/resume/cancel/rerun, requeue for terminal missions),
- editable outcome summary,
- planner step timeline (read-only runtime status),
- intervention list + resolve/dismiss actions,
- artifact list with open-link/open-PR actions,
- event timeline.

Runtime detail additions:

- Mission Control summary includes planner strategy/version and run mode (`autopilot` or `manual`).
- Mission Plan Steps surface planner-derived done criteria and dependency/join hints.
- Orchestrator Runtime auto-advances in autopilot mode when tracked executor sessions end and on resume.
- AI orchestrator activity feed shows real-time agent output streaming from running executor sessions.
- Mission Control includes live per-attempt session transcript tails for running executor sessions.
- **Run narrative**: Rolling progress display showing what agents are actively working on, updated in real time from orchestrator events.
- **Single progress bar**: Replaced per-step progress indicators with a unified mission progress bar.
- **DAG animation fix**: Step dependency graph now uses smooth animated edge transitions instead of static rendering.
- **Mission home dashboard**: when no mission is selected, the page shows active/recent mission cards and weekly mission stats from persisted mission/runtime state.

### Mission Chat (Slack-Style)

The Chat tab (`MissionChatV2`) replaces the previous separate chat and transcript tabs with a unified Slack-style interface. The old `MissionChat` component is replaced by `MissionChatV2`.

**Sidebar Channels**: A left sidebar shows available channels, each representing a communication scope:

| Channel Kind | Description |
|---|---|
| **Global** | All mission-wide messages aggregated into a single feed |
| **Orchestrator** | Direct communication with the orchestrator agent |
| **Worker** | Per-agent channels, one for each spawned worker (labeled by step key) |

Each channel shows:
- Status dot (active = green, closed = gray, failed = red)
- Unread message count badge
- Agent type icon (crown for orchestrator, wrench for workers, globe for global)

**@Mention System**: The chat input supports `@mention` autocomplete for targeting messages to specific agents. Users type `@` followed by a step key or agent name, and an autocomplete dropdown appears with available participants. Mentions are parsed, highlighted in the message body, and routed to the target agent.

**Real-Time Updates**: Messages stream in real time from the orchestrator and worker agents. Each message displays sender identity, role badge, relative timestamp, and content. System messages (status changes, errors) are rendered with distinct styling.

**Steering Bar Integration**: The chat tab includes an integrated steering bar at the bottom for direct mission control (pause/resume/cancel) without switching tabs.

### Dynamic Fan-Out

The orchestrator includes a **meta-reasoner** (`metaReasoner.ts`) that analyzes agent output and dynamically creates subtasks when parallelizable work is detected.

**Process**:
1. After a step completes, its output is passed to the meta-reasoner.
2. The meta-reasoner uses an AI call (Claude, read-only, low reasoning effort, 30s timeout) to analyze the output.
3. Based on the analysis, it returns a `FanOutDecision` with one of four strategies:

| Strategy | Description |
|---|---|
| `inline` | No fan-out; continue sequentially (default/fallback) |
| `internal_parallel` | Create parallel subtasks within the same lane |
| `external_parallel` | Create subtasks on separate lanes for file-level isolation |
| `hybrid` | Mix of inline and parallel subtasks |

**Safety**: Subtask count is capped at 8. File ownership is tracked to prevent conflicts between parallel agents. If the AI call fails or produces unparseable output, the meta-reasoner falls back to `inline` (no fan-out).

### Run Narrative

The mission workspace displays a rolling **run narrative** that shows real-time progress updates from active agents. This provides a human-readable summary of what is happening across all running steps, updated live from orchestrator events.

### Mobile-First Behavior

Phase 1 UI choices are built for constrained widths:

- compact card density and small action surfaces,
- horizontal mission-lane board for swipe/scroll scanning,
- form and detail layout that collapse into single-column sections.

This keeps launch and status updates fast on small screens while preserving full desktop functionality.

---

## Technical Implementation

### Services

Main-process mission logic lives in:

- `apps/desktop/src/main/services/missions/missionService.ts`

**Orchestrator service** (run lifecycle and step management):

- `apps/desktop/src/main/services/orchestrator/orchestratorService.ts` (8,313 lines) — orchestrator run lifecycle, step/attempt management, claims, and timeline
- `apps/desktop/src/main/services/orchestrator/orchestratorQueries.ts` (757 lines) — DB queries and row-to-domain mappers, extracted from orchestratorService
- `apps/desktop/src/main/services/orchestrator/stepPolicyResolver.ts` (338 lines) — step policy resolution and file claim logic, extracted from orchestratorService

**AI orchestrator service** (coordinator session and agent management), decomposed from a 13,210-line monolith into focused modules (42% reduction):

- `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.ts` (7,677 lines) — AI orchestrator session management, MCP server coordination, streaming output relay
- `apps/desktop/src/main/services/orchestrator/chatMessageService.ts` (1,849 lines) — all chat/messaging, threading, and message reconciliation
- `apps/desktop/src/main/services/orchestrator/workerDeliveryService.ts` (1,329 lines) — inter-agent message delivery to SDK and PTY agents
- `apps/desktop/src/main/services/orchestrator/workerTracking.ts` (1,087 lines) — worker state management and event handling
- `apps/desktop/src/main/services/orchestrator/missionLifecycle.ts` (1,045 lines) — mission run management and hook dispatch
- `apps/desktop/src/main/services/orchestrator/recoveryService.ts` (412 lines) — failure recovery, health sweep, and hydration
- `apps/desktop/src/main/services/orchestrator/modelConfigResolver.ts` (181 lines) — model config resolution with 30-second TTL cache
- `apps/desktop/src/main/services/orchestrator/orchestratorContext.ts` (1,334 lines) — OrchestratorContext type definition (22+ Map objects for runtime state)
- `apps/desktop/src/main/services/orchestrator/orchestratorConstants.ts` (115 lines) — runtime constants shared across orchestrator modules

**Other orchestrator modules**:

- `apps/desktop/src/main/services/orchestrator/metaReasoner.ts` — AI meta-reasoner for dynamic fan-out decisions
- `apps/desktop/src/main/services/orchestrator/budgetPressureService.ts` — budget pressure analysis
- `apps/desktop/src/main/services/orchestrator/missionBudgetService.ts` — mission-level budget enforcement and tracking
- `apps/desktop/src/main/services/orchestrator/coordinatorAgent.ts` — coordinator agent session setup and tool registration
- `apps/desktop/src/main/services/orchestrator/coordinatorTools.ts` — Vercel AI SDK coordinator tools
- `apps/desktop/src/main/services/orchestrator/executionPolicy.ts` — execution policy resolution
- `apps/desktop/src/main/services/orchestrator/planningPipeline.ts` — mission planning pipeline
- `apps/desktop/src/main/services/orchestrator/teamRuntimeConfig.ts` — team runtime template configuration
- `apps/desktop/src/main/services/orchestrator/teamRuntimeState.ts` — team runtime state management
- `apps/desktop/src/main/services/orchestrator/runtimeEventRouter.ts` — runtime event routing and dispatch
- `apps/desktop/src/main/services/orchestrator/metricsAndUsage.ts` — metrics collection and usage tracking

**Supporting services**:

- `aiIntegrationService` — AgentExecutor interface, Claude/Codex SDK integration, CLI spawning, model/provider settings
- `apps/desktop/src/main/services/memory/memoryService.ts` — scoped memory namespaces (runtime-thread, run, project, identity, daily-log) with candidate promotion flow
- `apps/desktop/src/main/services/ai/compactionEngine.ts` — SDK agent context compaction, transcript persistence, session resume
- `apps/desktop/src/main/services/ai/tools/teamMessageTool.ts` — Vercel AI SDK tool for agent-initiated inter-agent messaging

**Shared utilities**:

- `apps/desktop/src/main/services/shared/utils.ts` — backend utility functions replacing 60+ duplicates across services
- `apps/desktop/src/renderer/lib/format.ts` — frontend formatting helpers

Responsibilities:

- mission CRUD/list/detail,
- lifecycle transition validation,
- step status updates,
- intervention and artifact creation/resolution,
- event recording + broadcast,
- AI orchestrator session lifecycle and streaming,
- chat/messaging threading and reconciliation,
- worker delivery and state tracking,
- mission run management and hook dispatch,
- failure recovery, health sweeps, and hydration,
- Vercel AI SDK streaming relay to renderer.

### IPC Channels

Mission IPC contract lives in:

- `apps/desktop/src/shared/ipc.ts`

Channels:

- `ade.missions.list`
- `ade.missions.get`
- `ade.missions.create`
- `ade.missions.update`
- `ade.missions.delete`
- `ade.missions.updateStep`
- `ade.missions.addArtifact`
- `ade.missions.addIntervention`
- `ade.missions.resolveIntervention`
- `ade.missions.listPhaseProfiles`
- `ade.missions.savePhaseProfile`
- `ade.missions.deletePhaseProfile`
- `ade.missions.clonePhaseProfile`
- `ade.missions.exportPhaseProfile`
- `ade.missions.importPhaseProfile`
- `ade.missions.getPhaseConfiguration`
- `ade.missions.getDashboard`
- `ade.missions.event`

Runtime channels used by Missions detail:

- `ade.orchestrator.listRuns`
- `ade.orchestrator.getRunGraph`
- `ade.orchestrator.startRunFromMission`
- `ade.orchestrator.startAttempt`
- `ade.orchestrator.completeAttempt`
- `ade.orchestrator.tickRun`
- `ade.orchestrator.resumeRun`
- `ade.orchestrator.cancelRun`
- `ade.orchestrator.heartbeatClaims`
- `ade.orchestrator.listTimeline`
- `ade.orchestrator.getGateReport`
- `ade.orchestrator.event`

Main-process handlers are registered in:

- `apps/desktop/src/main/services/ipc/registerIpc.ts`

Preload bridge and renderer typings are defined in:

- `apps/desktop/src/preload/preload.ts`
- `apps/desktop/src/preload/global.d.ts`
- `apps/desktop/src/shared/types/` (17 domain files with barrel re-export via `index.ts`: `core.ts`, `models.ts`, `git.ts`, `lanes.ts`, `conflicts.ts`, `prs.ts`, `files.ts`, `sessions.ts`, `chat.ts`, `missions.ts`, `orchestrator.ts`, `config.ts`, `automations.ts`, `packs.ts`, `budget.ts`, `usage.ts`)

Vercel AI SDK streaming is relayed from main process to renderer via IPC event channels, enabling real-time agent output display in the mission detail surface.

### Renderer Components

Missions renderer entrypoint, decomposed from a 5,637-line monolith into focused modules (60% reduction):

- `apps/desktop/src/renderer/components/missions/MissionsPage.tsx` (2,226 lines) — workspace tab shell and mission routing
- `apps/desktop/src/renderer/components/missions/missionHelpers.ts` (519 lines) — shared mission utility functions, formatters, and status logic
- `apps/desktop/src/renderer/components/missions/CreateMissionDialog.tsx` (1,610 lines) — mission creation wizard with pre-flight checks and phase configuration
- `apps/desktop/src/renderer/components/missions/MissionSettingsDialog.tsx` (589 lines) — mission settings and phase profile management
- `apps/desktop/src/renderer/components/missions/PlanTab.tsx` (194 lines) — hierarchical phase/milestone/task plan view with runtime statuses
- `apps/desktop/src/renderer/components/missions/WorkTab.tsx` (209 lines) — follow-mode worker monitor with transcript tails and tool usage
- `apps/desktop/src/renderer/components/missions/StepDetailPanel.tsx` (271 lines) — step inspector with lane assignment, status, heartbeat, dependencies, and completion criteria
- `apps/desktop/src/renderer/components/missions/ActivityNarrativeHeader.tsx` (154 lines) — rolling run narrative header display
- `apps/desktop/src/renderer/components/missions/MissionsHomeDashboard.tsx` (101 lines) — no-selection dashboard with active/recent mission cards and weekly stats

Mission chat (Slack-style):

- `apps/desktop/src/renderer/components/missions/MissionChatV2.tsx` — Slack-style chat with sidebar channels, @mention autocomplete, and real-time message streaming
- `apps/desktop/src/renderer/components/missions/AgentChannels.tsx` — Slack-style agent channel list for MissionChatV2 sidebar
- `apps/desktop/src/renderer/components/shared/MentionInput.tsx` — @mention autocomplete input component shared across chat surfaces

Usage, DAG, and details:

- `apps/desktop/src/renderer/components/missions/UsageDashboard.tsx` — context budget panel and usage visualization in the Details tab
- `apps/desktop/src/renderer/components/missions/SmartBudgetPanel.tsx` — smart budget management panel
- `apps/desktop/src/renderer/components/missions/OrchestratorActivityFeed.tsx` — real-time orchestrator activity feed
- `apps/desktop/src/renderer/components/missions/OrchestratorDAG.tsx` — step dependency graph with animated edge transitions
- `apps/desktop/src/renderer/components/missions/ModelProfileSelector.tsx` — orchestrator model and profile selection
- `apps/desktop/src/renderer/components/missions/ModelSelector.tsx` — model picker for mission configuration

Route and navigation wiring:

- `apps/desktop/src/renderer/components/app/App.tsx`
- `apps/desktop/src/renderer/components/app/TabNav.tsx`
- `apps/desktop/src/renderer/components/app/CommandPalette.tsx`

### Event Flow

Mission updates are event-driven:

1. Main process writes mission/step/artifact/intervention state.
2. Service emits `ade.missions.event`.
3. Renderer subscriptions refresh list and selected mission detail.

This pattern keeps UI reactive while preserving local-first durability.

Mission updates now also trigger mission pack refreshes so mission-level context stays current across sessions.

AI orchestrator streaming events follow the same pattern — the orchestrator service emits incremental output events that the renderer consumes for real-time activity feed display.

---

## Data Model

Phase 1 + Phase 1.5 mission/orchestrator persistence adds:

- `missions`
- `mission_steps`
- `mission_events`
- `mission_artifacts`
- `mission_interventions`
- `mission_step_handoffs`
- `orchestrator_runs`
- `orchestrator_steps`
- `orchestrator_attempts`
- `orchestrator_claims`
- `orchestrator_context_snapshots`

Task 3 phase engine persistence adds:

- `phase_cards`
- `phase_profiles`
- `mission_phase_overrides`

Hivemind additions (memory, compaction, agent identity):

- `memories` — scoped memory store with candidate/promoted status, per-agent attribution, confidence scoring, and access tracking
- `attempt_transcripts` — Session transcript persistence for SDK agent sessions, supports compaction summaries
- `agent_identities` — identity profile storage used by Phase 4 agent definition/runtime mapping

Migration is implemented in:

- `apps/desktop/src/main/services/state/kvDb.ts`

Migration coverage:

- `apps/desktop/src/main/services/state/kvDb.missionsMigration.test.ts`

Lifecycle/transition coverage:

- `apps/desktop/src/main/services/missions/missionService.test.ts`

---

## Implementation Tracking

### Phase 1 (Implemented)

- Mission schema and indexes are persisted locally.
- Mission service lifecycle and transition validation is implemented.
- Missions tab UI is implemented for launch, board tracking, detail control, interventions, and artifacts.
- Mission event broadcasting and renderer subscriptions are implemented.
- Migration and lifecycle tests are passing.

### Phase 1.5 (Context Hardening Gate, Implemented)

- Mission-level pack type (`mission`) is implemented with deterministic version/event/index semantics.
- Structured mission step handoffs are durable and queryable for every orchestrator step attempt.
- Orchestrator runtime state tables are implemented (runs, steps, attempts, claims, context snapshots).
- Claim/lease model, resume recovery path, and tracked-session enforcement are implemented in runtime service/tests.

### Phase 2 Runtime v2 (Implemented)

- Missions detail now includes orchestrator runtime controls:
  - start run from mission steps,
  - tick/resume/cancel run,
  - start step attempts,
  - complete running attempts.
- Mission launch flow now supports direct `Launch + Start mission` autopilot mode with executor selection.
- Run metadata now persists run mode/autopilot config and deterministic planner metadata.
- Mission detail now shows:
  - step DAG runtime status,
  - attempt history per step,
  - recent run timeline events,
  - planner strategy and done criteria for each planned step.
- IPC coverage now includes orchestrator runtime endpoints for runs/graph/attempt lifecycle/claims heartbeat/timeline/gate report.
- Orchestrator runtime events are broadcast and mission UI refreshes on mission + orchestrator event streams.
- Tracked session exits now reconcile running attempts deterministically and can auto-advance next ready steps in autopilot mode.
- Runtime phase is transitioning from deterministic-only execution to AI orchestrator-driven execution.

### Phase 2 Runtime Notes (Shipped vs Scaffolded)

- Shipped:
  - deterministic run lifecycle controls from mission UI,
  - durable timeline and context provenance visibility.
- Scaffolded:
  - executor deep integration for Claude Code/Codex remains in production-safe tracked-session scaffold mode with explicit adapter state markers.

### Phase 3 AI Orchestrator Integration (Implemented)

- AI orchestrator session wiring via AgentExecutor interface and **Vercel AI SDK coordinator tools** (in-process, not MCP).
- Claude session plans and coordinates mission step execution using in-process coordinator tools registered via Vercel AI SDK.
- Executor agents spawned via AgentExecutor interface (Claude via community Vercel provider, Codex via official OpenAI SDK).
- Per-task-type model/provider settings for fine-grained executor control.
- Real-time agent output streaming from main process to renderer via IPC.
- AI-planned steps replace or augment deterministic planner for intelligent mission decomposition.
- MCP server exposes lane, git, pack, conflict, and session tools to spawned worker agents and external observers (not the orchestrator itself).
- Planner normalization now rejects generic step labels/descriptions (for example `Step 1`) and fails fast for invalid plans rather than injecting deterministic strategy fallback.
- Mission-step dependency resolution preserves explicit empty dependency sets to allow true fan-out execution instead of implicit sequential fallback.
- Parallel lane auto-provisioning now creates child lanes for independent root workstreams and reuses pre-assigned non-base lanes to avoid duplicate lane creation on reruns.
- Codex worker sessions use non-interactive `codex exec` startup semantics to prevent idle interactive shells from masquerading as active mission work.
- A deterministic health sweep loop runs in main process to:
  - tick active runs,
  - heartbeat active claims,
  - detect stale running attempts by timeout policy,
  - reconcile attempts when tracked sessions already ended but callbacks were missed,
  - fail/retry stuck attempts and trigger autopilot reassignment.
- Status/progress chat prompts now trigger deterministic run telemetry replies (progress, active steps, blockers, recovered stale attempts) in addition to AI chat responses when available.
- Mission detail step-inspector now surfaces lane assignment, current step status, worker heartbeat age, dependency names, completion criteria, and expected signals for clearer operator visibility.
- A dedicated no-UI orchestrator smoke harness is available at:
  - `apps/desktop/src/main/services/orchestrator/orchestratorSmoke.test.ts`
  - run with `npm --prefix apps/desktop run test:orchestrator-smoke`
  - complex observer-mode prompt run: `npm --prefix apps/desktop run test:orchestrator-complex-mock`
  - complex run report path: `/tmp/ade-orchestrator-complex-mock-report.json`

### Phase 3 Missions Overhaul Tasks 3/4 (Implemented 2026-02-27)

- Mission phase engine is live with built-in phase/profile seeding and per-mission phase overrides.
- Mission creation now stores phase profile selection/override metadata and annotates persisted step metadata with phase keys/names.
- Profile lifecycle is exposed through mission APIs and settings UI: list/save/delete/clone/import/export.
- Profile export/import uses JSON and project-local storage under `.ade/profiles/`.
- Runtime phase progression emits durable `phase_transition` mission events and timeline entries; run metadata stores transition history and phase-runtime state.
- Mission workspace now includes dedicated Plan and Work tabs, plus no-selection Missions home dashboard.
- UI renders runtime truth from mission/orchestrator APIs/events and keeps superseded steps, lane transfers, and validation outcomes visible for auditability.

### Shipped Features (Phase 3)

#### Planner Overhaul
- Fail-hard planner with 300-second timeout.
- `MissionPlanningError` class for structured error handling.
- No deterministic fallback — planner failure = mission failure (forces quality planning).

#### PR Strategy (Replaces Merge Phase)
- Merge phase completely removed from mission lifecycle.
- Replaced with `PrStrategy` enum: `integration` | `per-lane` | `queue` | `manual`.
- Strategy selected pre-mission in launch configuration.
- Integration: single PR from integration branch; Per-lane: one PR per lane; Queue: sequential merge queue; Manual: user handles PRs.

#### UI Redesign (Hivemind)
- **MissionChatV2** (Slack-style) replaces separate chat + transcript tabs with sidebar channels (Global, Orchestrator, per-worker), @mention autocomplete, and real-time message streaming.
- Mission workspace tabs now expose Plan, Work, DAG, Chat, Activity, and Details views.
- Tab model now reflects runtime intent directly (plan/work) rather than board-centric mission detail tabs.
- Activity feed: category dropdown replaces 12+ filter buttons.
- Mission workspace: all queries filtered by missionId.
- **ExecutionPlanPreview removed** — replaced by DAG visualization and chat-based plan review.
- DAG animation fixed: smooth animated edge transitions.
- Single progress bar replaces per-step progress indicators.
- Run narrative display showing rolling agent progress.

#### Pre-Mission Configuration
- Orchestrator model selector (choose AI model per mission).
- Per-model thinking budgets.
- PR strategy selector.

#### Inter-Agent Messaging (Hivemind)
- `sendAgentMessage()` IPC handler for agent-to-agent communication.
- Backend message routing between agents.
- UI rendering of inter-agent messages in MissionChatV2 channels.
- `teamMessageTool` — Vercel AI SDK tool that allows agents to send messages to other agents, the orchestrator, or broadcast to all. Agents use `@step-key`, `@orchestrator`, or `@all` targeting.
- @mention parsing and routing: mentions in messages are parsed, highlighted, and delivered to target agents.
- Message delivery to both PTY-based (CLI) agents and SDK-based agents.

#### Dynamic Fan-Out (Hivemind)
- AI meta-reasoner (`metaReasoner.ts`) analyzes agent output and decides fan-out strategy.
- Four strategies: `inline` (sequential), `internal_parallel` (same lane), `external_parallel` (separate lanes), `hybrid`.
- Safety cap of 8 subtasks per fan-out decision.
- File ownership tracking prevents conflicts between parallel agents.
- Graceful fallback to inline on AI failure or unparseable output.

#### Memory Architecture (Hivemind)
- Scoped memory namespaces: runtime-thread (ephemeral), run (mission-scoped), project (promoted long-term), identity (agent-owned), and daily-log (operational continuity).
- Memory categories: fact, preference, pattern, decision, procedure, gotcha.
- Candidate promotion flow: memories start as candidates with confidence scores and can be promoted to project/identity scopes.
- Auto-promotion on run completion.
- Shared facts: per-run, per-step facts (api_pattern, schema_change, config, architectural, gotcha) included in agent prompts.
- Context Budget Panel in the Details tab for monitoring memory and context usage.

#### Context Compaction (Hivemind)
- SDK agent context compaction triggers at 70% context window threshold.
- Pre-compaction fact writeback: facts are extracted and stored before context is compacted.
- Compaction produces a summary that replaces the full transcript.
- Compaction hints provided to CLI-based agents.
- Token tracking via `CompactionMonitor` with configurable threshold.

#### Session Persistence (Hivemind)
- Attempt transcript persistence to `attempt_transcripts` DB table.
- JSONL-based chat transcript files for durable message storage.
- Session resume for SDK agents: compacted context can bootstrap a resumed session.

#### MCP Dual-Mode Architecture
- Desktop embeds MCP socket server at `.ade/mcp.sock`, enabling external agents to proxy through the desktop for live UI updates.
- Headless mode provides full AI capabilities via `aiIntegrationService` (auto-detects `ANTHROPIC_API_KEY`, `claude` CLI, etc.).
- Transport abstraction layer (`JsonRpcTransport`) supports both stdio (headless) and Unix socket (embedded) transports.
- Smart entry point auto-detects desktop presence via `.ade/mcp.sock`.
- Same 35 MCP tools available in both modes.

#### Operational Improvements
- missionId filter applied to all queries (previously only breakdown).
- Role isolation between orchestrator and worker agents.
- Team synthesis for multi-agent coordination.
- Recovery loops for handling agent failures.
- AI decision service for budget pressure and wave scheduling.

#### Agent Identity Schema (Hivemind)
- `agent_identities` table created in the database schema.
- Foundation now used by Phase 4 definition/runtime split and identity-bound runtime policy.

### Phase 4 Agent-First Runtime Migration (In Progress)

- Non-interactive mission execution is being routed through `agentRuntimeService`-style runtime creation semantics.
- Mission steps map to explicit agent definitions and execution classes (`resident` or `task`) with auditable runtime source metadata.
- Runtime threads stay mission-local; CTO maintains its own persistent conversation thread in the CTO tab.
- Memory writeback and retrieval are policy-bound by scope instead of transcript merge.

### Mission Memory Integration

When a mission starts, the orchestrator receives a rich memory context to inform planning and execution:

- **Project memory (Tier 2)**: Relevant facts for this specific project — architectural decisions, known patterns, API conventions, gotchas. Retrieved from `.ade/memory/` project-scope namespace.
- **Episodic memories**: Structured summaries of similar past missions — what approaches worked, what failed, which steps caused interventions, and how they were resolved. Enables the orchestrator to avoid repeating past mistakes.
- **Procedural memories**: Learned workflows for this type of task. For example, if past "add authentication" missions always required a migration step, the planner includes it proactively.
- **Learning pack entries**: Auto-curated patterns from across missions. These are distilled, high-confidence patterns that have been validated across multiple runs (e.g., "always run lint before test in this repo").

**During mission execution**:
- Agents emit shared facts (already shipped in Hivemind HW4) that are scoped per-run and per-step. Categories include `api_pattern`, `schema_change`, `config`, `architectural`, and `gotcha`.
- Shared facts are included in subsequent agent prompts within the same mission, enabling knowledge transfer between steps without explicit message passing.

**After mission completes**:
- **Episodic memory extraction**: A structured summary of the mission is generated — prompt, plan, step outcomes, duration, key decisions, failure modes, and resolution paths. Written to the episodic memory namespace for future retrieval.
- **Memory promotion review**: Mission-scoped facts (run namespace) that proved accurate and useful are eligible for promotion to project scope. Promotion is automatic on run completion for facts above the confidence threshold.
- **Learning pack update**: Patterns observed in this mission are added to or update existing learning pack entries. Duplicate patterns increase confidence; contradictory patterns trigger review.
- All memory artifacts are written to `.ade/memory/` for git sync across machines.

### Mission History Portability

- Mission run logs are stored in `.ade/history/missions.jsonl` (append-only format).
- Each entry includes: mission ID, prompt, plan summary, step outcomes (pass/fail/skip), total duration, artifact references, intervention count, and final status.
- The JSONL format is portable across machines via git — clone the repo and the full mission history is available.
- Queryable by ADE for episodic memory retrieval: the orchestrator can search history for "last time we did X..." patterns to inform planning.
- History entries are immutable once written. Corrections or annotations are appended as separate entries referencing the original mission ID.

### Cross-Machine Mission Execution

- Phase 8 enables launching missions on remote machines (VPS, cloud, teammate workstations).
- Mission results are pushed to git, including both code changes and `.ade/` state (memory, history, artifacts metadata).
- Real-time progress is visible via relay WebSocket connection — the desktop UI shows live step status, agent output, and narrative updates regardless of where execution occurs.
- Interventions are routable to any connected device (laptop, phone via mobile-first UI, or another desktop instance). The first device to resolve an intervention wins; others see the resolution.
- Mission history is accessible from any machine with the repo, enabling seamless context continuity when switching between devices.

### CTO to Mission Flow

External agents can launch missions via the CTO, ADE's persistent project-aware agent that routes requests, creates missions, and monitors progress:

- **Flow**: External agent → MCP tool call → CTO → classifies request as dev task → launches mission with prompt + context.
- **Context enrichment**: The CTO adds context from its own memory before launching — user preferences (preferred PR strategy, default lane assignments), past routing patterns (similar requests and their outcomes), and project-specific conventions.
- **Mission lifecycle**: The launched mission follows the standard mission lifecycle (planning → execution → PR). The CTO monitors progress and can relay status back to the external agent.
- **Result delivery**: Mission results (PR URLs, summaries, artifacts) are returned via MCP response to the external agent that initiated the request.
- **Example flow**: An external agent (e.g., OpenClaw) says "Add authentication to the API" → CTO receives via MCP → classifies as multi-step dev task → launches mission with phased plan → workers execute across lanes → PR opened → result summary returned to OpenClaw via MCP response.

### Remaining Work

- Task 5 (pre-flight + intervention/HITL) and Task 6 (budget + usage) are shipped.
- End-to-end live multi-agent orchestration stress testing.
- Reflection/retrospective protocol and integration soak expansion (Tasks 7-8).

### Compute Backend Integration (Future)

Mission launch will support compute backend selection, allowing missions to target Local, VPS, or Daytona (opt-in) execution environments.
