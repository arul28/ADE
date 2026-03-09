# Missions — Current Runtime

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.
>
> Last updated: 2026-03-09

## Overview

Missions are ADE's structured execution flow for multi-step work. A mission enters a phase-aware orchestrator run and executes through durable run/step/attempt state, timeline events, interventions, worker sessions, and artifacts.

Current baseline:

- planning is a built-in mission phase, not a hidden pre-pass,
- mission detail uses Plan, Chat, Artifacts, and History sub-tabs,
- mission chat persists first-class thread/message records only,
- legacy metadata-only chat backfill is not active behavior.

## Runtime Contract

### Planning

When planning is enabled, the run starts in `planning`. The coordinator should gather context, hand off quickly to a read-only planning worker, require a usable planner result, and then transition explicitly to `development`.

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

- **Plan**: phase cards with step overview, active phase panel showing phase-gate status and advancement reasoning.
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
