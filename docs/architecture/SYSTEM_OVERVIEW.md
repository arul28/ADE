# ADE System Architecture Overview

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-23
>
> Roadmap note: future sequencing and planned architecture expansion (orchestrator, MCP, relay, iOS, machine hub) are maintained in `docs/final-plan.md`.

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
5. [Implementation Status](#implementation-status)

---

## Overview

ADE (Agentic Development Environment) is a desktop application designed to augment the developer workflow by providing deep integration between terminal sessions, git operations, and context-aware tooling. The system is built around two main components -- the Desktop UI and the Local Core Engine -- with an integrated AI layer that connects to existing CLI subscriptions via native agent SDKs (unified behind an AgentExecutor interface) and an MCP server. Strict boundaries govern which layer is permitted to perform mutations on the repository and filesystem.

The core insight behind ADE's architecture is that developer context -- the state of code changes, terminal output, test results, process health, and git history -- is fragmented across tools. ADE unifies this context into structured artifacts called "packs" that serve both humans and AI agents.

The AI integration layer replaces the previous hosted cloud backend with a fully local, subscription-powered approach. Instead of managing API keys or relying on a remote gateway, ADE spawns `claude` and `codex` CLI processes that inherit the user's existing subscriptions. An MCP server exposes ADE's internal tools to these AI processes, and an AI orchestrator coordinates multi-step mission execution.

---

## Design Decisions

### Local-First, Local-Only

ADE operates fully offline. The Local Core Engine handles all repository mutations, file I/O, and process management without requiring network connectivity. AI functionality runs locally by spawning CLI processes that use the developer's existing subscriptions -- no cloud backend, no API keys, no remote gateway required.

### Subscription-Powered AI

Rather than requiring users to manage API keys, configure cloud endpoints, or pay for a hosted service, ADE leverages existing CLI subscriptions. Developers who have `claude` or `codex` installed and authenticated get AI capabilities automatically. This decision eliminates credential management, reduces configuration surface, and aligns cost with tools developers already pay for. Each agent uses its native SDK — `ai-sdk-provider-claude-code` (community Vercel provider) for Claude and `@openai/codex-sdk` (official) for Codex. ADE's `AgentExecutor` interface unifies both behind a common contract.

### MCP for AI Tool Access

ADE exposes its internal capabilities to AI processes through a Model Context Protocol (MCP) server. This provides a standardized, auditable interface for AI agents to interact with ADE's lane system, conflict detection, test execution, and other services. The MCP server uses stdio transport with JSON-RPC 2.0, ensuring that all AI tool invocations pass through a permission and policy layer with full call audit logging.

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
| Terminals | Embedded terminal sessions (PTY via node-pty) and agent chat sessions (Codex App Server + Claude multi-turn) with unified session tracking |
| Conflicts | Risk matrix, merge simulation, proposal/reconciliation workflows |
| Context/Packs | Deterministic pack views, exports, and docs-generation actions |
| Graph | Workspace topology and risk overlays |
| PRs | PR creation/linking, checks/reviews, stacked + integration flows |
| History | Operation/checkpoint/pack event timeline |
| Automations | Trigger-action workflows and planner-driven draft flows |
| Missions | AI orchestrator control center: mission intake, lifecycle board, interventions, artifacts, outcomes |
| Settings | Subscription provider config, trust levels, keybindings, terminal profiles, and data controls |

### 2. Local Core Engine

**Technology**: Node.js (Electron main process), sql.js (SQLite WASM), node-pty, child_process

The Local Core Engine is the brain of ADE. It runs exclusively in Electron's main process and is the only component permitted to mutate the repository, filesystem, or spawn processes. It is organized as a set of services, each created via a factory function pattern:

| Service | Module | Responsibility |
|---------|--------|----------------|
| `laneService` | `laneService.ts` | Lane CRUD, worktree creation/removal, status computation |
| `sessionService` | `sessionService.ts` | Terminal session lifecycle (create, end, query) |
| `ptyService` | `ptyService.ts` | PTY spawning via node-pty, transcript capture, data broadcast |
| `diffService` | `diffService.ts` | Git diff computation (staged, unstaged, file-level) |
| `fileService` | `fileService.ts` | Full file operations: workspace listing, tree browsing (with gitignore), read, write, create, rename, delete, watch (chokidar), quick-open (fuzzy), text search |
| `gitService` | `gitOperationsService.ts` | All git operations (stage, commit, stash, sync, push, etc.) |
| `operationService` | `operationService.ts` | Operation history tracking with pre/post HEAD SHAs |
| `packService` | `packService.ts` | Pack materialization (lane packs, project packs, session deltas) |
| `jobEngine` | `jobEngine.ts` | Async job scheduling with deduplication |
| `processService` | `processService.ts` | Dev process lifecycle management |
| `testService` | `testService.ts` | Test suite execution and result tracking |
| `projectConfigService` | `projectConfigService.ts` | YAML config loading, validation, trust model |
| `aiIntegrationService` | `aiIntegrationService.ts` | AI provider routing, CLI spawning, narrative/proposal generation |
| `missionService` | `missionService.ts` | Mission lifecycle, step tracking, intervention management |
| `missionPlanningService` | `missionPlanningService.ts` | AI-powered and deterministic mission planning |
| `orchestratorService` | `orchestratorService.ts` | Run/step/attempt state machine, claim management, context snapshots |
| `agentChatService` | `agentChatService.ts` | Agent chat session lifecycle, Codex App Server JSON-RPC client, Claude multi-turn backend, ChatEvent streaming |
| `laneEnvironmentService` | *Planned* | Lane environment initialization (env files, ports, Docker, deps) |
| `laneProxyService` | *Planned* | Per-lane hostname proxy (*.localhost routing) |
| `previewLaunchService` | *Planned* | Preview URL generation and browser launch |
| `browserProfileService` | *Planned* | Chrome profile isolation per lane |
| `computeBackendService` | *Planned* | Compute backend abstraction and selection |
| `daytonaService` | *Planned* | Daytona SDK integration (opt-in cloud sandbox) |

All services are instantiated in `main.ts` and wired together through dependency injection. The `AppContext` type aggregates all service instances and is passed to the IPC registration layer.

### 3. AI Integration Layer

**Technology**: Agent SDKs (`ai-sdk-provider-claude-code`, `@openai/codex-sdk`), AgentExecutor interface, MCP server (stdio/JSON-RPC 2.0), `claude` and `codex` CLI processes

The AI Integration Layer is a local-only subsystem that provides AI capabilities by spawning CLI processes that use the developer's existing subscriptions. It replaces the previous hosted cloud backend entirely.

#### Dual-SDK Architecture and AgentExecutor Interface

ADE uses each agent's native SDK rather than a single unified execution layer:

- **Claude via `ai-sdk-provider-claude-code`**: A community Vercel AI SDK provider that wraps `@anthropic-ai/claude-agent-sdk` and spawns the `claude` CLI process, inheriting the user's Anthropic subscription. Used for planning, review, conflict resolution, and narrative generation tasks.
- **Codex via `@openai/codex-sdk`**: The official OpenAI SDK that spawns the `codex` CLI process directly, inheriting the user's OpenAI subscription. Used for implementation, code generation, and structured output tasks.
- **`AgentExecutor` interface**: ADE's own thin abstraction that unifies both SDKs behind a common contract for spawning, streaming, session management, and tool-use interception.
- **`canUseTool` callback**: Intercepts tool-use requests from AI models, routing them through ADE's permission layer before execution.
- **Streaming support**: All AI responses stream back to the UI in real time, providing immediate feedback during long-running operations.
- **Session management**: Maintains conversational context across multi-turn interactions within a mission.

#### Agent Chat Service

The Agent Chat Service provides a native interactive chat interface inside ADE, complementing the programmatic `AgentExecutor` for one-shot tasks. It uses the Codex App Server protocol (JSON-RPC 2.0 over stdio, documented at https://developers.openai.com/codex/app-server) for Codex and the community Vercel provider's multi-turn `streamText()` for Claude. A provider-agnostic `AgentChatService` interface unifies both backends behind a common `ChatEvent` stream. Chat sessions integrate as first-class `terminal_sessions` with delta computation, pack integration, and full session lifecycle callbacks.

#### MCP Server

The MCP server (`apps/mcp-server`) exposes ADE's internal tools to AI processes through a standardized protocol:

- **Transport**: stdio (JSON-RPC 2.0) -- AI processes communicate with ADE through stdin/stdout pipes.
- **Available tools**: `spawn_agent`, `read_context`, `create_lane`, `check_conflicts`, `merge_lane`, `ask_user`, `run_tests`, `get_lane_status`, `list_lanes`, `commit_changes`.
- **Resource providers**: Pack exports, lane status, conflict predictions -- AI processes can read ADE state without direct filesystem access.
- **Permission layer**: All tool invocations pass through a policy engine that enforces trust boundaries and operation limits.
- **Call audit logging**: Every MCP tool call is logged with timestamp, caller, arguments, and result for full traceability.

#### AI Orchestrator

The AI Orchestrator coordinates multi-step mission execution using a Claude session connected to the MCP server:

- Receives mission prompt and context packs from the mission service.
- Plans execution strategy (sequential, parallel-lite, parallel-first) based on mission complexity.
- Spawns agents in separate lanes via the orchestrator service's run/step/attempt state machine.
- Manages context windows through token-budgeted pack exports (Lite/Standard/Deep).
- Routes interventions back to the ADE UI when human input is required.
- Tracks claims, heartbeats, and gate reports for coordinating concurrent agent work.

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
  --> AI orchestrator plans execution via claude/codex CLI
    --> Orchestrator spawns agents in separate lane worktrees
      --> Agents work in lanes using MCP tools (read context, run tests, commit)
        --> Context packs track progress at each step
          --> Orchestrator monitors via gate reports and claim heartbeats
            --> Interventions route to ADE UI when human input needed
              --> Results (artifacts, PRs, outcomes) presented to user
```

For non-mission workflows, the standard context pipeline continues:

```
User creates lane
  --> Runs terminal session in lane worktree
    --> Session end triggers checkpoint computation
      --> Checkpoint triggers pack update (lane pack + project pack)
        --> Pack triggers conflict prediction
          --> AI generates narratives/proposals locally via CLI subscriptions
            --> Results displayed in desktop UI
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
| Processes / Tests / Automations | `ade.processes.*`, `ade.tests.*`, `ade.automations.*` | invoke/handle + runtime events |
| Missions / Orchestrator | `ade.missions.*`, `ade.orchestrator.*` | invoke/handle + lifecycle events |
| AI Integration | `ade.ai.*` | invoke/handle + streaming events |
| Agent Chat | `ade.agentChat.*` | invoke/handle + ChatEvent stream |
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
    --> spawns claude/codex CLI for AI planning (or deterministic fallback)
    --> orchestratorService.startRun()
      --> orchestrator tick loop begins
        --> spawns agents per step via executor adapters
          --> agents use MCP tools to interact with ADE services
```

Real-time events (PTY data, process status changes, test run updates, AI streaming tokens) are broadcast to all renderer windows via a `broadcast()` utility that iterates over `BrowserWindow.getAllWindows()`.

### External Dependencies

| Dependency | Usage | Required |
|------------|-------|----------|
| Daytona SDK | Opt-in cloud sandbox compute for lane/mission execution | No (opt-in) |
| Docker | Lane environment initialization (optional containerized deps) | No (optional) |

---

## Implementation Status

Current codebase status is feature-rich across lanes, files, terminals, conflicts, packs/context, PRs, automations, missions, orchestrator runtime, and AI-powered planning via CLI subscriptions.

| Component | Status |
|-----------|--------|
| Desktop UI (all subsystems) | Complete |
| Local Core Engine (all services) | Complete |
| Mission service + planning | Complete |
| Orchestrator service (run/step/attempt/claim state machine) | Complete |
| Mission planning via claude/codex CLI | Complete |
| Deterministic mission planner (fallback) | Complete |
| Agent SDK integration (dual-SDK) | Complete |
| AgentExecutor interface | Complete |
| AI integration service | Complete |
| Per-task-type routing configuration | Complete |
| Agent Chat Service (Phase 1.5) | Complete |
| Streaming AI responses to UI | Complete |
| MCP server (`apps/mcp-server`) | Complete |
| MCP permission/policy layer | Complete |
| MCP call audit logging | Complete |
| AI orchestrator (Claude session + MCP) | ~70% Complete (Phase 3) — missions overhaul shipped |
| Compute backend abstraction (Phase 5.5) | Planned |

Phases 1 (Agent SDK Integration), 1.5 (Agent Chat Integration), and 2 (MCP Server) are complete. Phase 3 (AI Orchestrator) is ~70% complete — missions overhaul shipped (fail-hard planner, PR strategies, inter-agent messaging, AgentChannels UI). Phase 5.5 (Compute Backend Abstraction) is planned. For authoritative phase sequencing, dependencies, and next implementation tasks, see:

- `docs/final-plan.md`
