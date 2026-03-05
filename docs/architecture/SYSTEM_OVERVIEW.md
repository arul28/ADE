# ADE System Architecture Overview

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-04
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

ADE (Agentic Development Environment) is a desktop application designed to augment the developer workflow by providing deep integration between terminal sessions, git operations, and context-aware tooling. The system is built around two main components -- the Desktop UI and the Local Core Engine -- with an integrated AI layer that connects to configured providers (CLI subscriptions, API-key/OpenRouter, and local OpenAI-compatible endpoints) via native agent SDKs and an MCP server. Strict boundaries govern which layer is permitted to perform mutations on the repository and filesystem.

The core insight behind ADE's architecture is that developer context -- the state of code changes, terminal output, test results, process health, and git history -- is fragmented across tools. ADE unifies this context into structured artifacts called "packs" that serve both humans and AI agents.

The AI integration layer replaces the previous hosted cloud backend with a local-first, provider-flexible approach. ADE can run with CLI subscriptions (`claude`/`codex`), API-key/OpenRouter providers, and local model endpoints (LM Studio/Ollama/vLLM). An MCP server exposes ADE's internal tools to these AI processes, and an AI orchestrator coordinates multi-step mission execution.

The current baseline is no-legacy at runtime: provider mode is resolved from current `ai.mode` config, threaded mission chat is persisted in dedicated chat tables (no metadata backfill job), and git conflict simulation uses the current merge-tree path.

---

## Design Decisions

### Local-First, Local-Only

ADE's core product features operate fully offline. The Local Core Engine handles all repository mutations, file I/O, and process management without requiring network connectivity. AI functionality remains local-first and can execute through CLI subscriptions, API-key/OpenRouter providers, or local endpoints -- no ADE-hosted cloud backend is required.

### Provider-Flexible AI

ADE supports multiple provider modes from one model registry. Developers can use existing CLI subscriptions (`claude`, `codex`), API-key/OpenRouter providers, or local model endpoints (LM Studio/Ollama/vLLM). The chat model selector surfaces only configured/detected models, and switching model families in lane chat forks a new chat session to preserve thread/runtime invariants. Core SDK executors remain `ai-sdk-provider-claude-code` (community Vercel provider) for Claude and `@openai/codex-sdk` (official) for Codex.

### MCP for AI Tool Access

ADE exposes its internal capabilities to AI processes through a Model Context Protocol (MCP) server operating in dual mode. This provides a standardized, auditable interface for AI agents to interact with ADE's lane system, conflict detection, test execution, and other services. The MCP server uses a `JsonRpcTransport` abstraction supporting both stdio (headless) and Unix socket (embedded at `.ade/mcp.sock`) transports, ensuring that all AI tool invocations pass through a permission and policy layer with full call audit logging. A smart entry point auto-detects the desktop's presence to choose embedded proxy vs headless mode.

### Trust Boundary at the Process Level

Electron's process model provides a natural trust boundary. The main process (Node.js) is trusted and has full filesystem and process access. The renderer process (Chromium) is untrusted and communicates exclusively through a typed IPC bridge. This prevents any renderer-side vulnerability from directly accessing the filesystem or spawning processes.

### Pluggable Compute Backends

ADE supports pluggable compute backends for lane and mission execution. The `ComputeBackend` interface abstracts environment lifecycle (create, destroy, exec, preview URL) across Local (default), VPS (remote relay), and Daytona (opt-in cloud sandbox) backends. This allows agents to execute in isolated environments without changing orchestration logic.

### Git Worktrees as the Isolation Primitive

Rather than using branches alone, ADE maps each lane (unit of work) to a dedicated git worktree. This enables true parallel development: multiple lanes can have different working trees checked out simultaneously without interference. The worktree model also provides a clean filesystem boundary for process execution and test isolation.

### Deterministic Packs Over Live Queries

ADE materializes context into markdown pack files rather than relying on live queries. This decision ensures reproducibility (packs are snapshots), enables offline consumption, and provides a natural serialization format for AI context delivery. Packs are rebuilt on deterministic triggers (session end, HEAD change) rather than polled.

### Event-Driven Job Engine

Background work is triggered by events (session end, HEAD change) rather than periodic polling. This reduces unnecessary computation while ensuring that packs and deltas are always current when needed. The job engine coalesces duplicate requests to avoid redundant work.

### SQLite for Structured State

All structured data lives in a single SQLite database (via sql.js WASM). This eliminates the need for a separate database server, keeps all state local, and provides ACID guarantees for concurrent reads and writes within the single main process.

---

## Technical Details

ADE is composed of two main components with an integrated AI layer, each with distinct responsibilities and trust levels.

### 1. Desktop UI

**Technology**: Electron 40.x (Chromium + Node.js), React 18.3, TypeScript, Vite, TailwindCSS 4.x

The Desktop UI is the user-facing application. It renders lanes, terminals (via xterm.js), file diffs (via Monaco Editor), process status panels, test result views, pack viewers, and operation history. The UI is split into two Electron processes:

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
| Context/Packs | Deterministic pack views, exports, and docs-generation actions |
| Graph | Workspace topology and risk overlays |
| PRs | PR creation/linking, checks/reviews, stacked + integration flows |
| History | Operation/checkpoint/pack event timeline |
| Agents | Autonomous agent system: automation, Night Shift, watcher, and review agents with identity/policy profiles |
| Missions | AI orchestrator control center: mission intake, lifecycle board, Slack-style chat (MissionChatV2 + MentionInput), Details tab, run narrative, interventions, artifacts, outcomes |
| Settings | Provider config (CLI/API/local/OpenRouter), trust levels, keybindings, terminal profiles, and data controls |

### 2. Local Core Engine

**Technology**: Node.js (Electron main process), sql.js (SQLite WASM), node-pty, child_process

The Local Core Engine is the brain of ADE. It runs exclusively in Electron's main process and is the only component permitted to mutate the repository, filesystem, or spawn processes. It is organized as a set of services, each created via a factory function pattern. Large services have been decomposed into focused modules while preserving a single entry point per service boundary.

#### Type System

Shared types live in `src/shared/types/`, a directory of 17 domain-scoped modules re-exported through a barrel `index.ts`. Each module owns the types for one domain:

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
| `packService` | `packService.ts` + `packUtils.ts`, `projectPackBuilder.ts`, `missionPackBuilder.ts`, `conflictPackBuilder.ts` | Pack materialization and assembly. Core orchestration in `packService.ts` (3.2K lines); domain-specific assembly decomposed into builders for project packs (~1K), mission packs (~1K), and conflict packs (~330). Shared helpers in `packUtils.ts` (~550). |
| `jobEngine` | `jobEngine.ts` | Async job scheduling with deduplication |
| `processService` | `processService.ts` | Dev process lifecycle management |
| `testService` | `testService.ts` | Test suite execution and result tracking |
| `projectConfigService` | `projectConfigService.ts` | YAML config loading, validation, trust model |
| `aiIntegrationService` | `aiIntegrationService.ts` | AI provider routing, CLI spawning, narrative/proposal generation |
| `missionService` | `missionService.ts` | Mission lifecycle, step tracking, intervention management |
| `missionPlanningService` | `missionPlanningService.ts` | AI-powered mission planning (fail-hard, no deterministic fallback) |
| `orchestratorService` | `orchestratorService.ts` (~8.3K lines) + `orchestratorQueries.ts`, `stepPolicyResolver.ts` | Run/step/attempt state machine, claim management, context snapshots. DB row types, normalizers, and parse helpers extracted to `orchestratorQueries.ts` (~760 lines). Step policy resolution and file claim helpers extracted to `stepPolicyResolver.ts` (~340 lines). |
| `aiOrchestratorService` | `aiOrchestratorService.ts` (~7.7K lines) + 8 extracted modules (see below) | AI orchestrator coordination layer. Decomposed from a 13.2K-line monolith into a focused core plus domain-specific modules. |
| `agentChatService` | `agentChatService.ts` | Agent chat session lifecycle, Codex App Server JSON-RPC client, Claude multi-turn backend, unified API/local backend, ChatEvent streaming |
| `metaReasoner` | `metaReasoner.ts` | AI-driven fan-out dispatch analysis, dynamic step injection, fan-out strategy selection |
| `compactionEngine` | `compactionEngine.ts` | Token monitoring, self-summarization at 70% threshold, pre-compaction writeback, conversation replacement |
| `memoryService` | `memoryService.ts` | Three-tier memory with sqlite-vec vector search, composite scoring, pre-compaction flush, consolidation, and `.ade/memory/` git sync |
| `ctoAgent` | *Planned* | MCP entry point for external agent systems — intent classification, routing to mission/task/review/query handlers, identity-based learned routing |
| `externalMcpClient` | *Planned* | Connects to external MCP servers for extended agent capabilities — lazy connect, permission integration, tool manifest merging |
| `adeStateManager` | *Planned* | Manages `.ade/` portable state directory — cross-machine sync via git, embedding regeneration on clone, state integrity checks |
| `laneEnvironmentService` | *Planned* | Lane environment initialization (env files, ports, Docker, deps) |
| `laneProxyService` | *Planned* | Per-lane hostname proxy (*.localhost routing) |
| `previewLaunchService` | *Planned* | Preview URL generation and browser launch |
| `browserProfileService` | *Planned* | Chrome profile isolation per lane |
| `computeBackendService` | *Planned* | Compute backend abstraction and selection |
| `daytonaService` | *Planned* | Daytona SDK integration (opt-in cloud sandbox) |

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
- **`canUseTool` callback**: Intercepts tool-use requests from AI models, routing them through ADE's permission layer before execution.
- **Streaming support**: All AI responses stream back to the UI in real time, providing immediate feedback during long-running operations.
- **Session management**: Maintains conversational context across multi-turn interactions within a mission.

#### Agent Chat Service

The Agent Chat Service provides a native interactive chat interface inside ADE, complementing the programmatic `AgentExecutor` for one-shot tasks. It uses the Codex App Server protocol (JSON-RPC 2.0 over stdio, documented at https://developers.openai.com/codex/app-server) for Codex and the community Vercel provider's multi-turn `streamText()` for Claude. A provider-agnostic `AgentChatService` interface unifies both backends behind a common `ChatEvent` stream. Chat sessions integrate as first-class `terminal_sessions` with delta computation, pack integration, and full session lifecycle callbacks. A **unified runtime** extends chat to API-key and local models (not just CLI-wrapped), with permission modes (plan/edit/full-auto) and universal tools.

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

The AI Orchestrator coordinates multi-step mission execution using a Claude session with **in-process Vercel AI SDK coordinator tools** (13 tools in `coordinatorTools.ts`), not the MCP server. The orchestrator codebase has been decomposed into a modular architecture: the core `aiOrchestratorService.ts` (~7.7K lines) delegates to domain-specific modules for chat messaging, worker delivery, worker tracking, mission lifecycle, recovery, model config resolution, and query/persistence. All modules share state through an `OrchestratorContext` object holding 22+ mutable Maps, with cross-module dependencies passed via typed deps objects.

Key orchestrator responsibilities:

- Receives mission prompt and context packs from the mission service.
- Plans execution strategy (sequential, parallel-lite, parallel-first) based on mission complexity.
- Spawns agents in separate lanes via the orchestrator service's run/step/attempt state machine.
- Manages context windows through token-budgeted pack exports (Lite/Standard/Deep).
- Routes interventions back to the ADE UI when human input is required.
- Tracks claims, heartbeats, and gate reports for coordinating concurrent agent work.
- Delivers inter-agent messages via `workerDeliveryService.ts` (PTY write for terminal agents, conversation injection for SDK agents).
- Routes @mention-based messaging through `chatMessageService.ts` with `parseMentions()` and `routeMessage()`.
- Resolves model configuration per call type with 30s TTL caching via `modelConfigResolver.ts`.

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

Routing is configurable in `.ade/local.yaml` under per-task-type settings. The `executorHint` field on each mission step allows the planner to override defaults based on task characteristics.

---

## Integration Points

### Data Flow

The primary data flow through ADE follows this pipeline:

```
User creates mission (plain-English prompt)
  --> AI orchestrator plans execution via claude/codex CLI (fail-hard planner, 300s timeout)
    --> Meta-reasoner analyzes for fan-out opportunities (external/internal/hybrid parallel)
      --> Orchestrator spawns agents in separate lane worktrees
        --> Agents work in lanes using MCP tools (read context, run tests, commit, memory tools)
          --> Shared facts + project memories injected into agent prompts via buildFullPrompt()
            --> Compaction engine monitors token usage, self-summarizes at 70% threshold
              --> Run narrative appended after each step completion
                --> Inter-agent messaging via @mentions and teamMessageTool
                  --> Context packs track progress; attempt transcripts persisted for resume
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
      --> Checkpoint triggers pack update (lane pack + project pack)
        --> Pack triggers conflict prediction
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
      → Store in SQLite + memory_vectors
        → Emit to .ade/memory/ JSON files
          → git commit + push (user-initiated or automated)
            → Other machines: git pull → memory service reload → re-embed if needed
```

Each step in these pipelines is triggered by events rather than polling. The job engine ensures that rapid successive events (multiple sessions ending quickly) are coalesced into a single pack refresh.

### IPC Architecture

Communication between the renderer and main process is organized into a broad typed IPC contract (`apps/desktop/src/shared/ipc.ts`). Major domains include:

| Domain | Prefix examples | Pattern |
|-----------|---------------|---------|
| App / Project / Onboarding / CI | `ade.app.*`, `ade.project.*`, `ade.onboarding.*`, `ade.ci.*` | invoke/handle + selected events |
| Lanes / Git / Conflicts / PRs | `ade.lanes.*`, `ade.git.*`, `ade.conflicts.*`, `ade.prs.*` | invoke/handle + selected events |
| Terminals / Sessions / Files | `ade.pty.*`, `ade.sessions.*`, `ade.files.*` | invoke/handle + high-frequency stream events |
| Context / Packs / History / Graph | `ade.context.*`, `ade.packs.*`, `ade.history.*`, `ade.graph.*` | invoke/handle + pack events |
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
      --> packService.refreshLanePack()
      --> packService.refreshProjectPack()

Git operation completes --> gitService (any mutation)
  --> operationService.finish()
  --> onHeadChanged callback (if SHA changed)
    --> jobEngine.onHeadChanged()
      --> packService.refreshLanePack()
      --> packService.refreshProjectPack()

Pack refresh completes --> packService
  --> onPackRefreshed callback
    --> aiIntegrationService.generateNarrative() (if subscriptions available)
    --> conflictService.predictConflicts()

Mission created --> missionService
  --> missionPlanningService.planMission()
    --> spawns claude/codex CLI for AI planning (fail-hard, no deterministic fallback)
    --> orchestratorService.startRun()
      --> orchestrator tick loop begins
        --> metaReasoner.analyzeForFanOut() injects parallel steps dynamically
        --> spawns agents per step via executor adapters
          --> agents use MCP tools to interact with ADE services
            --> compactionEngine monitors token usage per session
              --> appendRunNarrative() generates rolling narrative after step completion
                --> deliverMessageToAgent() routes inter-agent @mention messages

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
| Daytona SDK | Opt-in cloud sandbox compute for lane/mission execution | No (opt-in) |
| Docker | Lane environment initialization (optional containerized deps) | No (optional) |

### Cross-Machine Architecture

ADE is designed to be fully portable across developer machines without requiring a central hub, cloud backend, or relay for state synchronization.

**Git-based state sync**: All durable ADE state lives in the `.ade/` directory at the project root. This directory is committed to git alongside the codebase, enabling state to travel with the repository:

| State Category | Location | Git-tracked | Notes |
|----------------|----------|:-----------:|-------|
| Project memories | `.ade/memory/project.json` | Yes | Shared project knowledge |
| Agent memories | `.ade/memory/agents/<id>.json` | Yes | Per-agent learned behaviors |
| Agent definitions | `.ade/agents/*.yaml` | Yes | Agent role and capability configs |
| Agent identities | `.ade/identities/*.yaml` | Yes | Agent persona and policy profiles |
| Mission history | `.ade/missions/history.jsonl` | Yes | Completed mission records |
| Learning packs | `.ade/learning/*.json` | Yes | Auto-accumulated project rules |
| Shared config | `.ade/local.yaml` | Yes | Project-level settings |
| MCP socket | `.ade/mcp.sock` | No | Runtime artifact |
| Embedding cache | `.ade/cache/embeddings/` | No | Regenerated locally per machine |
| Session transcripts | `.ade/transcripts/` | No | Large, ephemeral |
| Private config | `.ade/local.private.yaml` | No | Machine-specific secrets/paths |

**No hub needed**: Unlike systems that require a central server for state sync, ADE relies entirely on git. When a developer pushes their `.ade/` changes, other machines receive the state on the next pull. This is intentionally simple and works with any git hosting provider.

**Embedding regeneration**: The `memory_vectors` SQLite table (sqlite-vec data) is not portable — it is `.gitignore`d because binary embedding data is machine-specific. On first startup after cloning or pulling new memory files, the memory service detects the mismatch and triggers a background re-embedding job using the local GGUF model (~30s for typical projects).

**Phase 8 relay is NOT state sync**: The planned Phase 8 relay server enables real-time remote control of a running ADE instance (e.g., from an iOS app). This is an operational bridge — it streams live events and accepts commands from a remote client to a running desktop instance. It does not participate in state synchronization, which remains purely git-based.

**iOS app as remote control**: The planned iOS companion app connects to a running ADE instance via the Phase 8 relay. It provides mission monitoring, intervention handling, and agent steering from mobile. The iOS app does not store or sync ADE state — it is a thin remote control for an active desktop session.

---

## Implementation Status

Current codebase status is feature-rich across lanes, files, terminals, conflicts, packs/context, PRs, agents, missions, orchestrator runtime, and AI-powered planning via configured providers (CLI/API/local).

| Component | Status |
|-----------|--------|
| Desktop UI (all subsystems) | Complete |
| Local Core Engine (all services) | Complete |
| Mission service + planning | Complete |
| Orchestrator service (run/step/attempt/claim state machine) | Complete |
| Mission planning via claude/codex CLI | Complete |
| Deterministic mission planner fallback | Removed (fail-hard planning path) |
| Agent SDK integration (dual-SDK) | Complete |
| AgentExecutor interface | Complete |
| AI integration service | Complete |
| Per-task-type routing configuration | Complete |
| Agent Chat Service (Phase 1.5) | Complete |
| Streaming AI responses to UI | Complete |
| MCP server (`apps/mcp-server`) — dual-mode (headless + embedded) | Complete |
| MCP permission/policy layer | Complete |
| MCP call audit logging | Complete |
| AI orchestrator (Claude session + MCP) | ~90% Complete (Phase 3) — orchestrator evolution shipped |
| Meta-reasoner + smart fan-out | Complete |
| Context compaction engine | Complete |
| Session persistence + resume | Complete |
| Inter-agent messaging | Complete |
| Memory architecture (scoped namespaces + candidate/promoted lifecycle) | Complete |
| Shared facts + run narrative | Complete |
| Memory architecture upgrade (sqlite-vec, hybrid search, composite scoring, pre-compaction flush) | Planned (Phase 4) |
| CTO Agent — core identity, memory, persistent chat (W1) | Complete (Phase 4) |
| Worker Agents — org chart, multi-adapter, config versioning, budget, task sessions (W2) | Complete (Phase 4) |
| Heartbeat & Activation — timer pool, two-tier execution, coalescing, orphan reaping (W3) | Complete (Phase 4) |
| Bidirectional Linear Sync (W4) | In Progress (Phase 4) |
| External MCP consumption (agents connect to external MCP servers) | Planned (Phase 4) |
| `.ade/` portable state (cross-machine git sync) | Planned (Phase 4) |
| Compute backend abstraction (Phase 5.5) | Planned |

Phases 1 (Agent SDK Integration), 1.5 (Agent Chat Integration), and 2 (MCP Server) are complete. Phase 3 (AI Orchestrator) is ~90% complete — orchestrator evolution shipped (meta-reasoner, compaction engine, session persistence, inter-agent messaging, Slack-style chat, scoped memory architecture, shared facts, run narrative, fail-hard planner, PR strategies). MCP dual-mode architecture shipped: transport abstraction (stdio/socket), headless AI via aiIntegrationService, desktop socket embedding at `.ade/mcp.sock`, smart entry point auto-detection, 35 tools available in both modes. Phase 4 focuses on agent-first runtime unification plus four new architectural capabilities: memory architecture upgrade (sqlite-vec vector search, hybrid retrieval, pre-compaction flush), CTO Agent (external system bridge via MCP), external MCP consumption (agents connecting to third-party MCP servers), and `.ade/` portable state (git-based cross-machine sync). Phase 5.5 (Compute Backend Abstraction) is planned. For authoritative phase sequencing, dependencies, and next implementation tasks, see:

- `docs/final-plan/README.md`
