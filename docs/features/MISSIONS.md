# Missions — Current Runtime

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-10

## Overview

Missions are ADE's structured execution flow for multi-step work. A mission enters a phase-aware orchestrator run and executes through durable run/step/attempt state, timeline events, interventions, worker sessions, and artifacts.

Current baseline:

- planning is a built-in mission phase, not a hidden pre-pass,
- mission detail uses Plan, Chat, Artifacts, and History sub-tabs,
- mission chat persists first-class thread/message records only,
- legacy metadata-only chat backfill is not active behavior.

## Runtime Contract

### Planning (Mandatory)

Planning is a mandatory phase that cannot be disabled. If a mission's phase configuration omits a planning phase, the coordinator agent automatically injects a built-in planning card at position 0 with `requiresApproval: true`, `mustBeFirst: true`, and `askQuestions: { enabled: true, mode: "auto_if_uncertain" }`. This injection is logged as `coordinator_agent.mandatory_planning_injected`.

When the run starts, the coordinator enters the `planning` phase. It should gather context via `get_project_context`, hand off quickly to a single read-only planning worker, require a usable planner result, and then transition explicitly to `development` via `set_current_phase`.

The planning worker must stay read-only — it researches the codebase and produces a plan. It must not write code, run write operations, or use provider-native plan approval flows. If the planning phase has `askQuestions` enabled, the coordinator must use `ask_user` to gather clarifying questions before spawning the planning worker.

A first-turn watchdog (`enforcePlanningFirstTurnDelegation`) ensures the coordinator spawns the planner on its first turn. If the coordinator's first turn fails to create a planning worker, the watchdog force-spawns a recovery planning worker to prevent the mission from stalling.

Configured phase transitions are explicit coordinator actions. The runtime may summarize phase progress, but it should not silently advance the configured current phase on the coordinator's behalf.

After delegation, the coordinator should stay mostly quiet and wake back up for meaningful runtime events, steering input, or blocked/error conditions.

### Execution

The coordinator owns strategy: delegation, retry, replan, and escalation. The runtime owns state, dependency, claim, budget, and validation enforcement. Low-signal churn should not keep waking the coordinator into idle reasoning turns.

### Validation

Validation is strict runtime behavior:

- required validation cannot be skipped,
- dedicated validation can auto-spawn validator work,
- completion requests do not bypass runtime completion gates,
- required predecessor phases must actually succeed before later required phases unlock,
- missing required validation blocks downstream progress and emits explicit runtime/timeline signals.

## Mission Detail Tabs

- **Plan**: phase cards with step overview, active phase panel showing phase-gate status and advancement reasoning. Phase cards support `requiresApproval` (boolean toggle that blocks phase transition until user approves) and an optional `capabilities` field (e.g., `"agent-browser"`) to enable per-phase tooling.
- **Chat**: Global summary thread plus detailed worker/orchestrator threads.
- **Artifacts**: mission artifacts and evidence closeout items.
- **History**: activity timeline for runtime transitions, interventions, and worker lifecycle events.

### Chat Split

- **Global** is the high-signal summary/broadcast channel.
- **Worker and orchestrator threads** are the detailed inspection surface and reuse the shared agent chat renderer patterns used by normal chat sessions.

## Permissions and Tools

ADE uses two layers:

- **Provider-native permissions**: Claude CLI and Codex CLI native behavior is governed by the provider runtime's permission mode (`plan`/read-only vs edit/full execution).
- **ADE-owned tools**: ADE separately controls coordinator tools, worker reporting/status tools, and the planning/coding tool profiles used by API-key and local models.

For API-key and local models, ADE's planning/coding profiles are the primary tool surface because ADE is the runtime there.

## Context and Persistence

Mission context is sourced from the current `.ade` context docs, prioritized repo docs, pack exports, and mission/runtime state where relevant.

Mission persistence includes:

- run/step/attempt state,
- timeline and intervention records,
- worker session lineage and transcripts,
- mission artifacts,
- mission-pack updates under `.ade/packs/missions/<missionId>/mission_pack.md`.

## Chat Signal Filtering (2026-03-09)

Mission chat applies multi-layer noise filtering to keep the user-facing chat surface high-signal:

- **Structured signal classification**: messages with structured metadata (`kind` field) are classified by type. Only `plan`, `approval_request`, `user_message`, substantive `text`/`reasoning`, actionable `status` (failed/interrupted), and non-trivial `error` messages are surfaced.
- **Low-signal noise detection**: short identifier-like tokens, streaming status lines, MCP prefixes, directory listings, and all-caps metadata strings are filtered. Short messages with sentence-ending punctuation ("Done.", "Error!") are preserved as genuine assistant responses.
- **askUser detection**: case-insensitive detection of `askUser`/`ask_user` tool invocations promotes messages to user-visible interventions regardless of other filtering.
- **Reasoning text joining**: consecutive reasoning blocks from the same turn/item are joined for display, with null-safe matching to prevent unrelated blocks from merging.

### Architecture Decision

Signal filtering exists because mission workers produce high volumes of low-signal streaming output (tool invocations, MCP metadata, intermediate status updates) that would overwhelm the chat surface. The filter is intentionally conservative — it's better to show a borderline message than to suppress a genuine assistant response.

## Workers Tab Removal (2026-03-09)

The previous `Workers` / `Ops` tab was removed from the mission detail view. Worker state inspection is now accessed through:

- **Chat threads**: each worker thread shows the worker's conversation and can be opened from the plan/step detail.
- **Step detail panel**: clicking a step shows its worker assignment, status, and provides a "Jump to worker" action.
- **Activity feed**: worker lifecycle events (spawn, complete, fail) appear in the activity timeline.

### Architecture Decision

The Workers tab duplicated information available through chat threads and step detail. Removing it reduces the tab count and eliminates a maintenance surface that was frequently out of sync with the canonical chat-based worker view.

## Planning Prompt Preview (2026-03-09)

The mission creation dialog now includes a live planning prompt preview:

- **PhaseCardEditor**: when the planning phase card is expanded, it fetches a preview of the exact prompt that will be sent to the planning worker via the `getPlanningPromptPreview` IPC channel.
- **PromptInspectorCard**: renders the preview with token count, model info, and a copy-to-clipboard action.
- **Debouncing**: the preview fetch is debounced (500ms) and uses a stable fingerprint memo to avoid redundant IPC calls when the phase configuration hasn't meaningfully changed.

### Architecture Decision

Live prompt preview gives users visibility into what the planner will actually receive before the mission starts. This replaces the previous pattern of launching the mission and then discovering the prompt was misconfigured.

## Worker Message Recovery UX (2026-03-09)

Worker message delivery uses a durable retry pipeline:

- Messages targeting a worker are delivered via the agent chat service (`sendMessage` or `steer` fallback).
- When a worker session can't be resolved (ambiguous lane fallback, no live session), the message stays queued with a descriptive error.
- Retry budget with exponential backoff prevents infinite loops. Exhausted retries open a `manual_input` intervention for the user.
- On startup, queued messages are replayed via reconciliation. Turn-completion signals from agent chat also trigger replay.
- The `ManualInputResponseModal` surfaces delivery failures and lets the user provide recovery instructions.

## Adaptive Execution (2026-03-10)

The adaptive runtime (`adaptiveRuntime.ts`) scales mission execution based on task complexity and budget pressure.

### Task Complexity Classification

`classifyTaskComplexity(description)` buckets a task description into one of four complexity tiers:

- **trivial** — typo fixes, comment edits, formatting, version bumps. Single-file, zero-risk.
- **simple** — bug fixes, renames, field additions, small patches. Few files, low coordination.
- **moderate** — feature work, service integrations, endpoint additions, test suites. Multiple files, some dependencies.
- **complex** — cross-cutting rewrites, architecture overhauls, multi-service migrations, distributed system changes. High file count, significant coordination.

Classification uses word count, complexity-indicator keyword matching, and file-reference density as heuristics.

### Parallelism Scaling

`scaleParallelismCap(estimatedScope)` maps the planner's `TeamComplexityAssessment.estimatedScope` to a parallelism cap:

| Scope       | Cap |
|-------------|-----|
| `small`     | 1   |
| `medium`    | 2   |
| `large`     | 4   |
| `very_large`| 6   |

Parallel workers use separate lanes (git worktrees) to avoid file conflicts. Same-lane parallelism is only safe when workers touch non-overlapping files.

### Budget-Gated Spawns

Before spawning any worker, the coordinator calls `checkBudgetHardCaps()`. If 5-hour, weekly, or API-key hard caps are triggered, spawning is blocked and a `budget_hard_cap_triggered` event fires. The budget service also emits soft warnings at configurable pressure levels (`warning`, `critical`) to let the coordinator throttle parallelism before hitting the hard stop.

### Model Downgrade

`evaluateModelDowngrade()` checks whether current usage exceeds a configurable threshold percentage. When triggered, it downgrades to a cheaper model tier automatically (e.g., opus → sonnet, sonnet → haiku, gpt-5 → gpt-4o). The downgrade is transparent — the coordinator receives the `ModelDowngradeResult` with the original and resolved model IDs plus the reason.

## Approval Gates (2026-03-10)

Phase cards support a `requiresApproval` boolean toggle. When set to `true`, the coordinator cannot transition away from that phase without explicit user approval.

### Mechanism

When the coordinator calls `set_current_phase` to leave a phase with `requiresApproval: true`:

1. The tool checks for existing `phase_approval` interventions on the mission.
2. If no resolved approval exists, a new `phase_approval` intervention is created with `pauseMission: true`.
3. The intervention includes context about the current phase, the target phase, and a prompt asking the user to review the phase output.
4. The `set_current_phase` call returns `{ ok: false, pendingApproval: true }` and the coordinator must wait.
5. Once the user resolves the intervention, the coordinator can retry the phase transition.

### Planning Has Approval Locked On

The built-in planning phase card always sets `requiresApproval: true`. This means every mission pauses after planning for the user to review and approve the plan before development begins. This is enforced by the mandatory planning injection in `coordinatorAgent.ts`.

## Multi-Round Deliberation (2026-03-10)

Planning supports unbounded ask/re-plan cycles through the `canLoop` and `loopTarget` ordering constraints on phase cards.

### How It Works

- A phase with `orderingConstraints.canLoop = true` bypasses the normal `maxQuestions` ceiling on `ask_user` calls.
- The coordinator can call `ask_user` repeatedly, incorporating user answers, refining the plan, and asking follow-up questions in an iterative loop.
- `loopTarget` optionally names a phase to loop back to (e.g., loop from validation back to development).
- The coordinator loops until it is satisfied with the plan quality, not until a fixed question count is reached.

### Implementation Detail

In `coordinatorTools.ts`, the `ask_user` tool checks `policy.phase?.orderingConstraints?.canLoop`. When `true`, the `maxQuestions` guard is skipped entirely:

```
const phaseCanLoop = policy.phase?.orderingConstraints?.canLoop === true;
if (!phaseCanLoop && priorInterventions.length >= policy.maxQuestions) { ... }
```

This allows the planning phase to support genuine multi-round deliberation where the coordinator and user collaborate on requirements before any code is written.

## Error Classification (2026-03-10)

`classifyErrorSource(message)` in `missionHelpers.ts` categorizes error messages into four source buckets:

| Source       | Description                                          | Examples                                    |
|--------------|------------------------------------------------------|---------------------------------------------|
| **ADE**      | Orchestrator / internal bugs                         | Default for unmatched errors                |
| **Provider** | AI API, rate-limit, quota, authentication            | `rate_limit`, `429`, `quota`, `overloaded`  |
| **Executor** | CLI process spawn, session, timeout                  | `spawn`, `exit code`, `timed out`           |
| **Runtime**  | Environment, config, MCP, sandbox, worktree          | `mcp`, `sandbox`, `permission`, `worktree`  |

Each source has a dedicated color in `ERROR_SOURCE_COLORS` (red/amber/blue/gray respectively). Error source badges appear in the activity feed alongside timeline events.

### Noise Filtering

`NOISY_EVENT_TYPES` is a set of low-signal event types that are filtered from the activity feed to keep it readable:

```
scheduler_tick, claim_heartbeat, autopilot_parallelism_cap_adjusted,
context_snapshot_created, context_pack_v2_metrics, executor_session_attached,
startup_verification_warning, step_metadata_updated, step_dependencies_resolved,
tick, dynamic_cap
```

The `collapseFeedMessages()` function further reduces noise by collapsing consecutive duplicate feed events (same `eventType` and `stepId`) into a single entry with a repeat count.

## Usage & Budget UI (2026-03-10)

### CompactUsageMeter

The `CompactUsageMeter` component in `MissionHeader.tsx` provides at-a-glance usage visibility:

- Displays 5-hour and weekly usage windows for both Claude and Codex providers.
- Each window shows `{Provider initial}/{window} {percent}%` (e.g., `C/5h 42%`, `C/wk 18%`).
- Color coding via `usagePercentColor()`: green below 60%, amber 60–80%, red above 80%.
- Reset countdown shown inline via `formatResetCountdown()` (e.g., `resets in 2h 15m`).
- Per-mission cost sourced from `missionBudgetService` via `getMissionBudgetStatus()` IPC, displayed as `$X.XX`.
- Refreshes every 2 minutes and subscribes to live `onUpdate` events.

### SmartBudgetPanel

`SmartBudgetPanel` in the mission settings dialog exposes configurable budget controls:

- `enabled` toggle to activate smart budget constraints.
- `fiveHourThresholdUsd` — dollar threshold for the 5-hour usage window.
- `weeklyThresholdUsd` — dollar threshold for the weekly usage window.

These thresholds feed into the `checkBudgetHardCaps()` logic that gates worker spawning.

## UI Architecture (2026-03-10)

### Component Decomposition

The missions UI is decomposed into focused, single-responsibility components:

- `MissionsPage` — top-level layout: sidebar list + detail area, loads dashboard on mount.
- `MissionTabContainer` — tab switcher (Plan / Chat / Artifacts / History) + content renderer.
- `MissionHeader` — status badge, progress bar, usage meter, lifecycle action buttons.
- `MissionDetailView` — selected mission detail wrapper, orchestrates graph/detail loading.
- `MissionChatV2` — chat tab with global summary thread and per-worker thread navigation.
- `ChatMessageArea` — virtualized message list for individual chat threads.
- `MissionThreadMessageList` — thread-aware message rendering with reasoning block joining.
- `InterventionPanel` — surfaces `phase_approval`, `manual_input`, and other intervention types for user action.

### Zustand Store

`useMissionsStore` is the single zustand store for all missions UI state. It holds:

- Mission list, selected mission, run graph, dashboard snapshot.
- Active tab, loading/error/busy flags, checkpoint status.
- Actions for loading, refreshing, and mutating missions (all via IPC).

Fine-grained selectors (e.g., `selectHeaderData`, `selectHeaderMissionSummary`) prevent unnecessary re-renders.

### Consolidated IPC

`getFullMissionView` is the primary IPC channel for loading mission detail. It returns the mission record, run graph, phase configuration, and intervention state in a single round-trip, avoiding waterfall IPC calls.

### Virtualized Lists

Chat message lists use virtualization to handle large worker transcripts without DOM pressure. The `ChatMessageArea` component renders only visible messages and recycles DOM nodes as the user scrolls.
