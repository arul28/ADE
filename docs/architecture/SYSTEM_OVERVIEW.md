# ADE System Architecture Overview

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-09
>
> Roadmap note: future sequencing and planned architecture expansion (orchestrator, MCP, relay, iOS, machine hub) are maintained in `docs/final-plan/README.md`.

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Technical Details](#technical-details)
   - [Desktop UI](#1-desktop-ui)
   - [Local Core Engine](#2-local-core-engine)
   - [AI Integration Layer](#3-ai-integration-layer)
4. [Integration Points](#integration-points)
   - [Data Flow](#data-flow)
   - [IPC Architecture](#ipc-architecture)
   - [Event Propagation](#event-propagation)
   - [Cross-Machine Architecture](#cross-machine-architecture)
5. [Implementation Status](#implementation-status)

---

## Overview

ADE (Agentic Development Environment) is a desktop application designed to augment the developer workflow by providing deep integration between terminal sessions, git operations, and context-aware tooling. The system is built around two main components -- the Desktop UI and the Local Core Engine -- with an integrated AI layer that connects to configured providers (CLI subscriptions, API-key/OpenRouter, and local OpenAI-compatible endpoints) via native agent SDKs and an MCP server. The renderer remains untrusted; repository mutations occur either through main-process services or through AI runtimes operating inside controlled lane/worktree boundaries under the current permission model.

The core insight behind ADE's architecture is that developer context -- the state of code changes, terminal output, test results, process health, and git history -- is fragmented across tools. ADE is moving that context toward a persistent memory system (three scopes: project, agent, mission; three tiers: pinned, hot, cold) that serves both humans and AI agents. Today that memory system is the canonical durable memory backend, while pack-based compatibility paths still remain for some orchestrator/MCP/context-doc flows.

The AI integration layer replaces the previous hosted cloud backend with a local-first, provider-flexible approach. ADE can run with CLI subscriptions (`claude`/`codex`), API-key/OpenRouter providers, and local model endpoints (LM Studio/Ollama/vLLM). An MCP server exposes ADE's internal tools to these AI processes, and an AI orchestrator coordinates multi-step mission execution.

The current baseline is no-legacy at runtime: provider mode is resolved from current `ai.mode` config, threaded mission chat is persisted in dedicated chat tables (no metadata backfill job), and git conflict simulation uses the current merge-tree path.

---

## Design Decisions

### Local-First, Local-Only

ADE's core product features operate fully offline. The Local Core Engine owns the trusted local services for file I/O, git, PTYs, process management, and mission state without requiring network connectivity. AI functionality remains local-first and can execute through CLI subscriptions, API-key/OpenRouter providers, or local endpoints -- no ADE-hosted cloud backend is required.

### Provider-Flexible AI

ADE supports multiple provider modes from one model registry. Developers can use existing CLI subscriptions (`claude`, `codex`), API-key/OpenRouter providers, or local model endpoints (LM Studio/Ollama/vLLM). The chat model selector surfaces only configured/detected models, and switching model families in lane chat forks a new chat session to preserve thread/runtime invariants. Core SDK executors remain `ai-sdk-provider-claude-code` (community Vercel provider) for Claude and `@openai/codex-sdk` (official) for Codex.

### MCP for AI Tool Access

ADE exposes its internal capabilities to AI processes through a Model Context Protocol (MCP) server operating in dual mode. This provides a standardized, auditable interface for AI agents to interact with ADE's lane system, conflict detection, test execution, and other services. The MCP server uses a `JsonRpcTransport` abstraction supporting both stdio (headless) and Unix socket (embedded at `.ade/mcp.sock`) transports, ensuring that all AI tool invocations pass through a permission and policy layer with full call audit logging. A smart entry point auto-detects the desktop's presence to choose embedded proxy vs headless mode.

### Trust Boundary at the Process Level

Electron's process model provides a natural trust boundary. The main process (Node.js) is trusted and has full filesystem and process access. The renderer process (Chromium) is untrusted and communicates exclusively through a typed IPC bridge. This prevents any renderer-side vulnerability from directly accessing the filesystem or spawning processes.

### Pluggable Compute Backends (Dropped)

> **Note**: Phase 5.5 (Compute Backend Abstraction) was dropped. VPS is just another machine running ADE; sandboxing was removed from scope. This section is retained for historical context.

ADE originally planned pluggable compute backends for lane and mission execution. The `ComputeBackend` interface would have abstracted environment lifecycle (create, destroy, exec, preview URL) across Local (default), VPS (remote relay), and Daytona (opt-in cloud sandbox) backends.

### Git Worktrees as the Isolation Primitive

Rather than using branches alone, ADE maps each lane (unit of work) to a dedicated git worktree. This enables true parallel development: multiple lanes can have different working trees checked out simultaneously without interference. The worktree model also provides a clean filesystem boundary for process execution and test isolation.

### Deterministic Context Exports + Unified Memory

W6 is now complete as a runtime migration: unified memory is the canonical durable memory backend and renderer inspection surface, and runtime context assembly no longer depends on persisted `.ade/artifacts/packs/...` files.

ADE still keeps deterministic markdown context exports as explicit compatibility and audit surfaces for:
- MCP `read_context` resources and `ade://pack/...` URIs
- Agent chat context-export selection
- Optional persisted pack refresh/version history for users or integrations that still inspect `.ade/artifacts/packs/...`

This keeps prompts reproducible and auditable without leaving persisted pack artifacts on the critical runtime path.

### Event-Driven Job Engine

Background work is triggered by events (session end, HEAD change) rather than periodic polling. This reduces unnecessary computation while ensuring memory and delta signals stay current. The job engine coalesces duplicate requests to avoid redundant work.

### SQLite for Structured State

All structured data lives in a single SQLite database (via sql.js WASM). This eliminates the need for a separate database server, keeps all state local, and provides ACID guarantees for concurrent reads and writes within the single main process.

---

## Technical Details

ADE is composed of two main components with an integrated AI layer, each with distinct responsibilities and trust levels.

### 1. Desktop UI

**Technology**: Electron 40.x (Chromium + Node.js), React 18.3, TypeScript, Vite, TailwindCSS 4.x

The Desktop UI is the user-facing application. It renders lanes, terminals (via xterm.js), file diffs (via Monaco Editor), process status panels, test result views, memory inspectors, and operation history. The UI is split into two Electron processes:

- **Main Process (trusted)**: Full Node.js access. This is where all services live. It handles file I/O, PTY spawning via node-pty, git operations, SQLite database access, process management, test execution, and AI integration. Entry point is `main.ts`, which initializes an `AppContext` containing all service instances.

- **Renderer Process (untrusted)**: A React single-page application. It has no direct file or process access. All communication with the main process goes through Electron's IPC mechanism via a typed preload bridge that exposes the `window.ade` API.

Key UI subsystems:

| Subsystem | Purpose |
|-----------|---------|
| Play | Run processes/tests, lane-scoped execution controls, CI import, agent tool launch points |
| Lanes | Create, rename, archive, delete, and stack worktree-backed development lanes |
| Files | IDE-style workspace browser/editor with search and quick-open |
| Terminals | Embedded terminal sessions (PTY via node-pty) and agent chat sessions (Codex App Server, Claude multi-turn, and unified API/local runtimes) with unified session tracking |
| Conflicts | Risk matrix, merge simulation, proposal/reconciliation workflows |
| Context/Memory | Unified memory inspection, candidate promotion, and docs-generation actions |
| Graph | Workspace topology and risk overlays |
| PRs | PR creation/linking, checks/reviews, stacked + integration flows |
| History | Operation/checkpoint/event timeline |
| Agents | Autonomous agent system: automation, Night Shift, watcher, and review agents with identity/policy profiles |
| Missions | AI orchestrator control center: mission intake, lifecycle board, phase-aware mission detail tabs (Plan, Work, DAG, Chat, Activity, Details), global summary chat, detailed worker/orchestrator threads, interventions (including `phase_approval`), artifacts, outcomes, usage meters (`CompactUsageMeter`), intervention panel, consolidated IPC (`getFullMissionView`) |
| Settings | Provider config (CLI/API/local/OpenRouter), trust levels, keybindings, terminal profiles, and data controls |

### 2. Local Core Engine

**Technology**: Node.js (Electron main process), sql.js (SQLite WASM), node-pty, child_process

The Local Core Engine is the brain of ADE. It runs exclusively in Electron's main process and is the trusted owner of repository access, filesystem services, process orchestration, and durable state. CLI-backed mission/chat workers may also mutate files inside their assigned worktrees when the selected provider permission mode allows it, but they do so within ADE-managed runtime boundaries rather than through the renderer. The engine is organized as a set of services, each created via a factory function pattern. Large services have been decomposed into focused modules while preserving a single entry point per service boundary.

#### Type System

Shared types live in `src/shared/types/`, a directory of 19 domain-scoped modules re-exported through a barrel `index.ts`. Each module owns the types for one domain:

| Module | Domain |
|--------|--------|
| `core.ts` | Foundational enums, base interfaces, common utility types |
| `lanes.ts` | Lane state, worktree metadata, stacking |
| `conflicts.ts` | Conflict predictions, risk matrix, resolution proposals |
| `prs.ts` | Pull request state, checks, reviews, stacked/integration flows |
| `git.ts` | Git operation results, ref metadata, diff structures |
| `files.ts` | File tree, workspace entries, search results |
| `sessions.ts` | Terminal/chat session lifecycle, transcript metadata |
| `chat.ts` | ChatEvent union, chat session state, approval types |
| `missions.ts` | Mission lifecycle, step plans, interventions, artifacts |
| `orchestrator.ts` | Run/step/attempt state, claims, gate reports, worker state |
| `config.ts` | Project config schema, trust model, provider settings |
| `automations.ts` | Agent definitions, identity profiles, automation rules |
| `packs.ts` | Pack structures, export tiers, delta formats |
| `budget.ts` | Budget caps, usage accounting, subscription tracking |
| `models.ts` | Model descriptors, provider families, pricing, registry types |
| `usage.ts` | Token usage, cost aggregation, billing events |
| `agents.ts` | Agent identity, capability, and worker org chart types |
| `cto.ts` | CTO agent state, config, and org management types |
| `linearSync.ts` | Linear sync state, issue mapping, dispatch types |

Runtime constants (status maps and default isolation rules) live in `src/main/services/orchestrator/orchestratorConstants.ts`, separate from the type definitions.

#### Shared Utilities

Common utility code is consolidated into shared modules to eliminate duplication:

| Module | Location | Purpose |
|--------|----------|---------|
| `utils.ts` | `src/main/services/shared/` | Backend utilities: `isRecord`, `nowIso`, `asString`, `asNumber`, `uniqueSorted`, `parseDiffNameOnly`, `getErrorMessage`, `safeJsonParse` -- replaces 60+ scattered duplicates |
| `format.ts` | `src/renderer/lib/` | Frontend formatting: `relativeWhen`, `formatDate`, `formatTime`, `formatDurationMs`, `formatTokens`, `formatCost`, `statusTone` |
| `shell.ts` | `src/renderer/lib/` | Shell utilities for renderer |
| `sessions.ts` | `src/renderer/lib/` | Session display helpers |
| `useClickOutside.ts` | `src/renderer/hooks/` | Shared React hook for click-outside detection |
| `useThreadEventRefresh.ts` | `src/renderer/hooks/` | Shared React hook for thread event refresh |

#### Service Table

| Service | Module(s) | Responsibility |
|---------|-----------|----------------|
| `laneService` | `laneService.ts` | Lane CRUD, worktree creation/removal, status computation |
| `sessionService` | `sessionService.ts` | Terminal session lifecycle (create, end, query) |
| `ptyService` | `ptyService.ts` | PTY spawning via node-pty, transcript capture, data broadcast |
| `diffService` | `diffService.ts` | Git diff computation (staged, unstaged, file-level) |
| `fileService` | `fileService.ts` | Full file operations: workspace listing, tree browsing (with gitignore), read, write, create, rename, delete, watch (chokidar), quick-open (fuzzy), text search |
| `gitService` | `gitOperationsService.ts` | All git operations (stage, commit, stash, sync, push, etc.) |
| `operationService` | `operationService.ts` | Operation history tracking with pre/post HEAD SHAs |
| `packService` | `packService.ts` + builders/utils | Deterministic context-export compatibility layer. Still live for orchestrator context snapshots, MCP `read_context`, and remaining pack-based compatibility paths such as conflict resolution. |
| `contextDocService` | `contextDocService.ts` | Runtime owner for context-doc status/generate/open flows and auto-refresh preferences. |
| `sessionDeltaService` | `sessionDeltaService.ts` | Runtime owner for session delta computation and `ade.sessions.getDelta` reads. |
| `jobEngine` | `jobEngine.ts` | Async job scheduling with deduplication |
| `processService` | `processService.ts` | Dev process lifecycle management |
| `testService` | `testService.ts` | Test suite execution and result tracking |
| `projectConfigService` | `projectConfigService.ts` | YAML config loading, validation, trust model |
| `aiIntegrationService` | `aiIntegrationService.ts` | AI provider routing, CLI spawning, narrative/proposal generation |
| `missionService` | `missionService.ts` | Mission lifecycle, step tracking, intervention management |
| `phaseEngine` | `phaseEngine.ts` | Built-in/custom phase cards + profiles; planning phase defaults and ordering constraints |
| `orchestratorService` | `orchestratorService.ts` (~8.3K lines) + `orchestratorQueries.ts`, `stepPolicyResolver.ts` | Run/step/attempt state machine, claim management, context snapshots. DB row types, normalizers, and parse helpers extracted to `orchestratorQueries.ts` (~760 lines). Step policy resolution and file claim helpers extracted to `stepPolicyResolver.ts` (~340 lines). |
| `aiOrchestratorService` | `aiOrchestratorService.ts` (~7.7K lines) + 8 extracted modules (see below) | AI orchestrator coordination layer. Decomposed from a 13.2K-line monolith into a focused core plus domain-specific modules. |
| `agentChatService` | `agentChatService.ts` | Agent chat session lifecycle, Codex App Server JSON-RPC client, Claude multi-turn backend, unified API/local backend, ChatEvent streaming |
| `metaReasoner` | `metaReasoner.ts` | AI-driven fan-out dispatch analysis, dynamic step injection, fan-out strategy selection |
| `compactionEngine` | `compactionEngine.ts` | Token monitoring, self-summarization at 70% threshold, shared-fact/summarization writeback, conversation replacement. Pre-compaction memory flush (W6½) injects a silent agentic turn before compaction to persist in-context discoveries. |
| `memoryService` | `memoryService.ts` | Unified durable memory backend backed by `unified_memories`: project/agent/mission scopes, pinned/hot/cold tiers, hybrid retrieval (FTS4 BM25 + cosine similarity + MMR re-ranking), pin/promote/archive flows, lifecycle sweeps (temporal decay, tier demotion, hard limits, orphan cleanup), batch consolidation (Jaccard trigram clustering + LLM merge), and DB-backed persistence in `.ade/ade.db`. Local embeddings via `@huggingface/transformers` (all-MiniLM-L6-v2) with background worker and graceful lexical fallback. |
| `ctoAgent` | `ctoStateService.ts` | CTO/employee subsystem — persistent identities, layered memory (CTO core memory, employee core memory, shared project memory, subordinate activity feed), org chart, heartbeat, Linear sync, budget enforcement |
| `externalMcpClient` | *Planned* | Connects to external MCP servers for extended agent capabilities — lazy connect, permission integration, tool manifest merging |
| `adeProjectService` + `configReloadService` | `adeProjectService.ts`, `configReloadService.ts` | Canonical `.ade` structure repair, tracked-vs-ignored path snapshotting, health validation, JSONL normalization, config reload, and renderer project-state events |
| `laneEnvironmentService` | `laneEnvironmentService.ts` | Lane environment initialization (env files, ports, Docker, deps) |
| `laneProxyService` | `laneProxyService.ts` | Per-lane hostname proxy (*.localhost routing); preview launch is embedded here (not a standalone service) |
| `browserProfileService` | *Planned* | Chrome profile isolation per lane |
| `computeBackendService` | *Dropped* | Compute backend abstraction — dropped with Phase 5.5 (VPS is just another machine running ADE) |
| `daytonaService` | *Dropped* | Daytona SDK integration — dropped with Phase 5.5 |

#### AI Orchestrator Module Decomposition

The AI orchestrator (`aiOrchestratorService.ts`) was decomposed from a 13.2K-line monolith into a 7.7K-line core plus eight extracted modules. All modules receive an `OrchestratorContext` object (defined in `orchestratorContext.ts`) that holds the 22+ mutable `Map` objects constituting orchestrator state. Extracted functions follow the pattern `fooCtx(ctx: OrchestratorContext, ...args)`, with thin wrappers in the main file: `const foo = (...args) => fooCtx(ctx, ...args)`. Cross-module dependencies are passed via typed deps objects.

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `orchestratorContext.ts` | ~1,330 | `OrchestratorContext` type definition -- all 22+ Map objects as mutable state |
| `chatMessageService.ts` | ~1,850 | All chat/messaging: `appendChatMessage`, `listChatThreads`, `getThreadMessages`, `sendThreadMessage`, `sendChat`, `getChat`, `sendAgentMessage`, `parseMentions`, `routeMessage`, `deliverMessageToAgent`, `getGlobalChat`, `getActiveAgents`, reconciliation functions |
| `workerDeliveryService.ts` | ~1,330 | Inter-agent message delivery: `resolveWorkerDeliveryContext`, `deliverWorkerMessage`, `replayQueuedWorkerMessages`, `routeMessageToWorker`, `routeMessageToCoordinator` |
| `workerTracking.ts` | ~1,090 | Worker state management + `updateWorkerStateFromEvent` (457-line event handler) |
| `missionLifecycle.ts` | ~1,050 | Mission run management, hook dispatch (`dispatchOrchestratorHook`, `maybeDispatchTeammateIdleHook`) |
| `orchestratorQueries.ts` | ~760 | DB row types, constants, normalizer functions, parse helpers, row-to-domain mappers (shared with `orchestratorService.ts`) |
| `recoveryService.ts` | ~410 | Failure recovery, health sweep, hydration |
| `stepPolicyResolver.ts` | ~340 | Step policy resolution, file claim helpers, `readDocPaths` cache (shared with `orchestratorService.ts`) |
| `modelConfigResolver.ts` | ~180 | Model config resolution with 30s TTL cache: `resolveCallTypeConfig`, `resolveOrchestratorModelConfig`, `resolveMissionLaunchPlannerModel` |
| `orchestratorConstants.ts` | ~115 | Runtime constants: `LEGACY_STEP_TO_TASK_STATUS`, `DEFAULT_ROLE_ISOLATION_RULES`, etc. |

#### Model System

The model registry and profiles are unified in two shared modules:

| Module | Location | Purpose |
|--------|----------|---------|
| `modelRegistry.ts` | `src/shared/` | Canonical registry of 40+ models across 8 provider families. `ModelDescriptor` includes pricing fields and `getModelPricing()` accessor. Provider-to-CLI mapping uses a flat `FAMILY_TO_CLI` lookup map instead of nested ternaries. |
| `modelProfiles.ts` | `src/shared/` | Model profiles derived from `MODEL_REGISTRY` instead of maintaining parallel lists. Ensures profiles stay in sync with the registry automatically. |

All services are instantiated in `main.ts` and wired together through dependency injection. The `AppContext` type aggregates all service instances and is passed to the IPC registration layer.

### 3. AI Integration Layer

**Technology**: Agent SDKs (`ai-sdk-provider-claude-code`, `@openai/codex-sdk`, Vercel AI SDK providers), AgentExecutor interface, MCP server (dual-mode: stdio + socket/JSON-RPC 2.0), CLI + API/local model runtimes

The AI Integration Layer is a local-first subsystem that provides AI capabilities via both CLI-backed and non-CLI runtimes. It replaces the previous hosted cloud backend entirely.

#### Dual-SDK Architecture and AgentExecutor Interface

ADE uses each agent's native SDK rather than a single unified execution layer:

- **Claude via `ai-sdk-provider-claude-code`**: A community Vercel AI SDK provider that wraps `@anthropic-ai/claude-agent-sdk` and spawns the `claude` CLI process, inheriting the user's Anthropic subscription. Used for planning, review, conflict resolution, and narrative generation tasks.
- **Codex via `@openai/codex-sdk`**: The official OpenAI SDK that spawns the `codex` CLI process directly, inheriting the user's OpenAI subscription. Used for implementation, code generation, and structured output tasks.
- **`AgentExecutor` interface**: ADE's own thin abstraction that unifies both SDKs behind a common contract for spawning, streaming, session management, and tool-use interception.
- **`canUseTool` callback**: Intercepts ADE-owned tool-use requests from AI models, routing them through ADE's permission layer before execution.
- **Streaming support**: All AI responses stream back to the UI in real time, providing immediate feedback during long-running operations.
- **Session management**: Maintains conversational context across multi-turn interactions within a mission.

#### Agent Chat Service

The Agent Chat Service provides a native interactive chat interface inside ADE, complementing the programmatic `AgentExecutor` for one-shot tasks. It uses the Codex App Server protocol (JSON-RPC 2.0 over stdio, documented at https://developers.openai.com/codex/app-server) for Codex and the community Vercel provider's multi-turn `streamText()` for Claude. A provider-agnostic `AgentChatService` interface unifies both backends behind a common `ChatEvent` stream. Chat sessions integrate as first-class `terminal_sessions` with delta computation, context-export compatibility hooks, and full session lifecycle callbacks. A **unified runtime** extends chat to API-key and local models (not just CLI-wrapped), with permission modes (plan/edit/full-auto) and universal tools.

#### Model Registry & Dynamic Pricing

The model registry (`modelRegistry.ts`) catalogs 40+ models across 8 provider families, classified by auth type (`cli-subscription`, `api-key`, `openrouter`, `local`). Each `ModelDescriptor` includes pricing fields directly, with a `getModelPricing()` accessor and a flat `FAMILY_TO_CLI` lookup map for provider-to-CLI resolution. Model profiles (`modelProfiles.ts`) are derived from `MODEL_REGISTRY` rather than maintained as parallel lists, ensuring they stay in sync automatically.

At startup, `modelsDevService` fetches live pricing and capabilities from `models.dev`, caching locally with 6-hour refresh. `enrichModelRegistry()` updates context windows and capabilities; `updateModelPricing()` merges pricing via a Proxy-based `MODEL_PRICING` object. Provider options use pure tier-string passthrough (`providerOptions.ts`) -- no invented token budgets. A middleware layer (`middleware.ts`) handles logging, retry, cost guards, and reasoning extraction.

#### MCP Server

The MCP server (`apps/mcp-server`) exposes ADE's internal tools to AI processes through a standardized protocol:

- **Transport**: stdio (JSON-RPC 2.0) -- AI processes communicate with ADE through stdin/stdout pipes.
- **Available tools**: `spawn_agent`, `read_context`, `create_lane`, `check_conflicts`, `merge_lane`, `ask_user`, `run_tests`, `get_lane_status`, `list_lanes`, `commit_changes`.
- **Resource providers**: Pack exports, lane status, conflict predictions -- AI processes can read ADE state without direct filesystem access.
- **Permission layer**: All tool invocations pass through a policy engine that enforces trust boundaries and operation limits.
- **Call audit logging**: Every MCP tool call is logged with timestamp, caller, arguments, and result for full traceability.

#### AI Orchestrator

The AI Orchestrator coordinates multi-step mission execution through a phase-aware coordinator runtime plus spawned workers. Provider-native permission modes govern native behavior for CLI-backed models, while ADE separately controls its own coordinator/MCP tool exposure. The orchestrator codebase has been decomposed into a modular architecture: the core `aiOrchestratorService.ts` (~7.7K lines) delegates to domain-specific modules for chat messaging, worker delivery, worker tracking, mission lifecycle, recovery, model config resolution, and query/persistence. All modules share state through an `OrchestratorContext` object holding 22+ mutable Maps, with cross-module dependencies passed via typed deps objects.

Key orchestrator responsibilities:

- Receives mission prompt and context packs from the mission service.
- Enters the built-in planning phase, hands planning work to a read-only planner when enabled, and transitions explicitly into downstream execution phases.
- Plans execution strategy (sequential, parallel-lite, parallel-first) based on mission complexity.
- Spawns agents in separate lanes via the orchestrator service's run/step/attempt state machine.
- Manages context windows through token-budgeted pack exports (Lite/Standard/Deep).
- Routes interventions back to the ADE UI when human input is required.
- Tracks claims, heartbeats, and gate reports for coordinating concurrent agent work.
- Delivers inter-agent messages via `workerDeliveryService.ts` (PTY write for terminal agents, conversation injection for SDK agents).
- Routes @mention-based messaging through `chatMessageService.ts` with `parseMentions()` and `routeMessage()`.
- Resolves model configuration per call type with 30s TTL caching via `modelConfigResolver.ts`.
- **Adaptive runtime**: `classifyTaskComplexity` evaluates task characteristics to select appropriate model tier. Model downgrade automatically falls back to cheaper/faster models for routine sub-tasks while preserving high-capability models for complex reasoning.
- **Approval gates**: Phase transitions can require explicit human approval via `phase_approval` intervention events, preventing the orchestrator from advancing past critical checkpoints without user sign-off.
- **Multi-round deliberation**: The orchestrator supports iterative refinement cycles where planning and validation phases can loop multiple rounds before proceeding, improving output quality for complex missions.
- **Completion gates**: Structured criteria that must be satisfied before a phase or mission can be marked complete, preventing premature advancement.
- Stays mostly event-driven after delegation, waking back up for actionable worker/runtime signals rather than continuous idle reasoning.

#### Per-Task-Type Routing

Each task type maps to a preferred provider and model:

| Task Type | Default Provider | Rationale |
|-----------|-----------------|-----------|
| Planning | Claude CLI | Strong reasoning for decomposing complex goals into steps |
| Implementation | Codex CLI | Optimized for code generation with sandbox support |
| Review | Claude CLI | Detailed analysis and explanation capabilities |
| Conflict resolution | Claude CLI | Reasoning over overlapping changes with context |
| Narrative generation | Claude CLI | Concise developer-facing summaries |
| PR description drafting | Claude CLI | Factual, structured markdown generation |

Routing is configurable in `.ade/local.yaml` under per-task-type settings. Runtime step metadata is stamped from the current phase so coordinator/worker routing stays phase-consistent.

---

## Integration Points

### Data Flow

The primary data flow through ADE follows this pipeline:

```
User creates mission (plain-English prompt)
  --> AI orchestrator starts run and enters planning phase (default profile)
    --> Meta-reasoner analyzes for fan-out opportunities (external/internal/hybrid parallel)
      --> Orchestrator hands planning to a read-only planner and waits for a usable plan/result
        --> Orchestrator transitions to development/validation phases as required
          --> Agents work in separate lane worktrees using provider-native permissions plus ADE-owned tools
          --> Shared facts + project memories injected into agent prompts via buildFullPrompt()
            --> Compaction engine monitors token usage, self-summarizes at 70% threshold
              --> Run narrative appended after each step completion
                --> Inter-agent messaging via @mentions and teamMessageTool
                  --> Context snapshots + export cursors track progress; attempt transcripts persisted for resume
                    --> Orchestrator monitors via gate reports and claim heartbeats
                      --> Interventions route to ADE UI when human input needed
                        --> PR strategy (integration/per-lane/manual) replaces merge phase
                          --> Results (artifacts, PRs, outcomes) presented to user
```

For non-mission workflows, the standard context pipeline continues:

```
User creates lane
  --> Runs terminal session in lane worktree
    --> Session end triggers checkpoint computation
      --> Job engine queues lane refresh hook + conflict prediction
        --> Context exports and docs refresh on demand (orchestrator/MCP/settings flows)
          --> AI generates narratives/proposals via configured providers (CLI/API/local)
            --> Results displayed in desktop UI
```

For external agent integration via the CTO Agent:

```
External agent → MCP Server (stdio/socket)
  → CTO Agent (intent classification)
    → Route to handler: Mission launcher | Task agent | Review agent | State reader
      → Execute via ADE internal services
        → Result assembled
          → MCP response returned to external agent
```

For memory persistence and cross-machine sync:

```
Agent execution → Memory write (memoryAdd)
  → Embed via local GGUF or OpenAI fallback
    → Consolidation check (cosine > 0.85 similarity)
      → Store in `.ade/ade.db` (`unified_memories` + `unified_memory_embeddings`)
        → optional git commit + push
          → Other machines: git pull → memory retrieval reflects new entries
```

Each step in these pipelines is triggered by events rather than polling. The job engine coalesces rapid successive updates into a single lane-refresh/conflict-prediction pass.

### IPC Architecture

Communication between the renderer and main process is organized into a broad typed IPC contract (`apps/desktop/src/shared/ipc.ts`). Major domains include:

| Domain | Prefix examples | Pattern |
|-----------|---------------|---------|
| App / Project / Onboarding / CI | `ade.app.*`, `ade.project.*`, `ade.onboarding.*`, `ade.ci.*` | invoke/handle + selected events |
| Lanes / Git / Conflicts / PRs | `ade.lanes.*`, `ade.git.*`, `ade.conflicts.*`, `ade.prs.*` | invoke/handle + selected events |
| Terminals / Sessions / Files | `ade.pty.*`, `ade.sessions.*`, `ade.files.*` | invoke/handle + high-frequency stream events |
| Context / History / Graph | `ade.context.*`, `ade.history.*`, `ade.graph.*` | invoke/handle + context events |
| Processes / Tests / Agents | `ade.processes.*`, `ade.tests.*`, `ade.agents.*` | invoke/handle + runtime events |
| Missions / Orchestrator | `ade.missions.*`, `ade.orchestrator.*` | invoke/handle + lifecycle events |
| AI Integration | `ade.ai.*` | invoke/handle + streaming events |
| Agent Chat | `ade.agentChat.*` | invoke/handle + ChatEvent stream |
| Memory | `ade.memory.*` | invoke/handle (getBudget, getCandidates, promote, archive, search, scoped retrieval) |
| Mission Chat | `ade.missions.getGlobalChat`, `ade.missions.deliverMessage`, `ade.missions.getActiveAgents` | invoke/handle + real-time message events |
| Config / Settings | `ade.projectConfig.*`, `ade.keybindings.*`, `ade.terminalProfiles.*`, `ade.agentTools.*`, `ade.github.*` | invoke/handle + provider/state events |

These per-subsystem counts are illustrative and can drift; `apps/desktop/src/shared/ipc.ts` is the canonical live channel inventory.

All channels use the `ipcMain.handle` / `ipcRenderer.invoke` request-response pattern except for real-time data streams (PTY output, process logs, test logs, AI streaming responses), which use `webContents.send` for push-based delivery.

The IPC layer is defined in three files:
- `shared/ipc.ts` -- Channel name constants
- `preload/preload.ts` -- Typed renderer-side API (`window.ade`)
- `main/services/ipc/registerIpc.ts` -- Main process handler registration

### Event Propagation

ADE uses a callback-based event propagation model between services:

```
PTY exit --> ptyService.closeEntry()
  --> sessionService.end()
  --> onSessionEnded callback
    --> jobEngine.onSessionEnded()
      --> enqueue lane refresh hook (memory/context maintenance)
      --> queue conflict prediction

Git operation completes --> gitService (any mutation)
  --> operationService.finish()
  --> onHeadChanged callback (if SHA changed)
    --> jobEngine.onHeadChanged()
      --> queue conflict prediction (debounced)

Context-doc auto-refresh trigger --> IPC workflows (mission/PR/lane refresh)
  --> contextDocService.maybeAutoRefreshDocs()
    --> context docs status/inventory update

Mission created --> missionService
  --> orchestratorService.startRun()
    --> phaseRuntime seeds to first enabled phase (planning by default)
    --> coordinator plans/clarifies and transitions via set_current_phase()
      --> metaReasoner.analyzeForFanOut() injects parallel steps dynamically
      --> spawns agents per step via executor adapters
        --> agents use MCP tools to interact with ADE services
          --> compactionEngine monitors token usage per session
            --> appendRunNarrative() generates rolling narrative after step completion
              --> deliverMessageToAgent() routes inter-agent @mention messages

Phase transition with approval gate --> orchestratorService
  --> phase_approval intervention created
    --> ade.missions.event broadcast to renderer
      --> InterventionPanel surfaces approval request to user
        --> User approves/rejects via IPC
          --> orchestratorService advances or halts phase transition

Agent step completed --> orchestratorService
  --> appendRunNarrative() updates run narrative
  --> shared facts extracted and stored in orchestrator_shared_facts
  --> attempt transcript persisted to attempt_transcripts table
  --> memory candidates promoted if high-confidence on run completion
```

Real-time events (PTY data, process status changes, test run updates, AI streaming tokens) are broadcast to all renderer windows via a `broadcast()` utility that iterates over `BrowserWindow.getAllWindows()`.

### External Dependencies

| Dependency | Usage | Required |
|------------|-------|----------|
| Daytona SDK | Dropped with Phase 5.5 | No (removed) |
| Docker | Lane environment initialization (optional containerized deps) | No (optional) |

### Cross-Machine Architecture

ADE is designed to be fully portable across developer machines without requiring a central hub, cloud backend, or relay for state synchronization.

**Git-based state sync**: ADE now uses a canonical `.ade` contract with tracked/shareable roots plus a tracked `.ade/.gitignore` for machine-local runtime state:

| State Category | Location | Git-tracked | Notes |
|----------------|----------|:-----------:|-------|
| Unified memory tables | `.ade/ade.db` (`unified_memories`, `unified_memory_embeddings`) | No | Primary runtime memory store |
| Agent definitions + worker state | `.ade/agents/**` | Yes | Worker identity, core memory, session logs |
| CTO state | `.ade/cto/**` | Yes | CTO identity, core memory, session logs |
| Mission history | `.ade/history/**` | Yes | Mission JSONL history and related tracked logs |
| Deterministic context exports | `.ade/artifacts/packs/**` | No | Compatibility artifacts used by orchestrator/MCP/context-doc tooling |
| Shared config | `.ade/ade.yaml` | Yes | Project-level defaults |
| Local config | `.ade/local.yaml` | No | Machine-local override config |
| MCP socket | `.ade/mcp.sock` | No | Runtime artifact |
| Session transcripts | `.ade/transcripts/` | No | Large, ephemeral |
| Secret config + secret stores | `.ade/local.secret.yaml`, `.ade/secrets/**` | No | Machine-specific secrets/paths |

**No hub needed**: Unlike systems that require a central server for state sync, ADE relies entirely on git. When a developer pushes their `.ade/` changes, other machines receive the state on the next pull. This is intentionally simple and works with any git hosting provider.

**Embedding storage**: Memory embeddings are generated locally by `@huggingface/transformers` (all-MiniLM-L6-v2, 384-dim) and stored in `unified_memory_embeddings` inside `.ade/ade.db`. Hybrid retrieval (FTS4 BM25 30% + cosine similarity 70% + MMR re-ranking) is the active search path, with graceful fallback to lexical/composite scoring when embeddings are unavailable.

**Phase 8 relay is NOT state sync**: The planned Phase 8 relay server enables real-time remote control of a running ADE instance (e.g., from an iOS app). This is an operational bridge — it streams live events and accepts commands from a remote client to a running desktop instance. It does not participate in state synchronization, which remains purely git-based.

**iOS app as remote control**: The planned iOS companion app connects to a running ADE instance via the Phase 8 relay. It provides mission monitoring, intervention handling, and agent steering from mobile. The iOS app does not store or sync ADE state — it is a thin remote control for an active desktop session.

---

## Implementation Status

Current codebase status is feature-rich across lanes, files, terminals, conflicts, unified memory/docs context, PRs, agents, missions, orchestrator runtime, and phase-based planning via configured providers (CLI/API/local).

| Component | Status |
|-----------|--------|
| Desktop UI (all subsystems) | Complete |
| Local Core Engine (all services) | Complete |
| Mission service + phase configuration | Complete |
| Orchestrator service (run/step/attempt/claim state machine) | Complete |
| Planning phase (default built-in) | Complete |
| Pre-mission planner fallback path | Removed (coordinator-owned phase runtime) |
| Agent SDK integration (dual-SDK) | Complete |
| AgentExecutor interface | Complete |
| AI integration service | Complete |
| Per-task-type routing configuration | Complete |
| Agent Chat Service (Phase 1.5) | Complete |
| Streaming AI responses to UI | Complete |
| MCP server (`apps/mcp-server`) — dual-mode (headless + embedded) | Complete |
| MCP permission/policy layer | Complete |
| MCP call audit logging | Complete |
| AI orchestrator (Claude session + MCP) | Complete (Phase 3–5) — orchestrator evolution, adaptive runtime, approval gates, multi-round deliberation shipped |
| Meta-reasoner + smart fan-out | Complete |
| Context compaction engine | Complete |
| Session persistence + resume | Complete |
| Inter-agent messaging | Complete |
| Memory architecture (scoped namespaces + candidate/promoted lifecycle) | Complete |
| Shared facts + run narrative | Complete |
| Unified Memory System (W6) — replaces pack-first renderer surfaces and unifies retrieval | Complete (Phase 4) |
| Memory Engine Hardening (W6½) — lifecycle sweeps, batch consolidation, pre-compaction flush | Complete (Phase 4) |
| Embeddings Pipeline (W7a) — local all-MiniLM-L6-v2, hybrid FTS+cosine retrieval, MMR re-ranking | Complete (Phase 4) |
| Skills + Learning Pipeline (W7) — procedural extraction, skill materialization to `.ade/skills/` | Core implemented (Phase 4); advanced capture still pending |
| CTO Agent — core identity, memory, persistent chat (W1) | Complete (Phase 4) |
| Worker Agents — org chart, multi-adapter, config versioning, budget, task sessions (W2) | Complete (Phase 4) |
| Heartbeat & Activation — timer pool, two-tier execution, coalescing, orphan reaping (W3) | Complete (Phase 4) |
| Bidirectional Linear Sync (W4) | Complete (Phase 4) |
| External MCP consumption (agents connect to external MCP servers) | Planned (Phase 4) |
| `.ade/` portable state (canonical tracked/shareable contract) | Complete (Phase 4) |
| Play Runtime Isolation (Phase 5) — laneEnvironmentService, laneProxyService, portAllocationService, laneTemplateService, oauthRedirectService, runtimeDiagnosticsService | Complete |
| Compute backend abstraction (Phase 5.5) | Dropped (VPS is just another machine running ADE) |

Phases 1 (Agent SDK Integration), 1.5 (Agent Chat Integration), and 2 (MCP Server) are complete. Phase 3 (AI Orchestrator) is complete — orchestrator evolution shipped (meta-reasoner, compaction engine, session persistence, inter-agent messaging, mission chat workspace, scoped memory architecture, shared facts, run narrative, phase-based planning runtime, PR strategies, adaptive runtime with `classifyTaskComplexity` and model downgrade, approval gates with `phase_approval` events, multi-round deliberation, completion gates). MCP dual-mode architecture shipped: transport abstraction (stdio/socket), headless AI via aiIntegrationService, desktop socket embedding at `.ade/mcp.sock`, smart entry point auto-detection, 35 tools available in both modes. Phase 4 W1-W4, W6, W6½, W7a, W7b, and W10 are complete. Memory engine now includes lifecycle sweeps (temporal decay, tier demotion, hard limits, orphan cleanup), batch consolidation (Jaccard trigram clustering + LLM merge), pre-compaction flush, local embedding pipeline (`@huggingface/transformers` all-MiniLM-L6-v2), and hybrid retrieval (FTS4 BM25 + cosine similarity + MMR re-ranking) with graceful lexical fallback. Memory Health dashboard in Settings provides visibility into entry counts, sweep/consolidation logs, embedding progress, and hard limit usage. Remaining major Phase 4 workstreams: W5b, W8, W9, and W-UX/W7c follow-through. Phase 5 (Play Runtime Isolation) is complete. Phase 5.5 (Compute Backend Abstraction) was dropped — VPS is just another machine running ADE. For authoritative phase sequencing, dependencies, and next implementation tasks, see:

- `docs/final-plan/README.md`
