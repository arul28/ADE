# AI Integration Architecture

> Roadmap reference: `docs/final-plan/README.md` is the canonical future plan and sequencing source.

> Last updated: 2026-03-24

The AI integration layer replaces the previous hosted agent with a local-first, provider-flexible approach. Instead of a cloud backend with remote job queues, ADE routes work to configured runtimes (CLI subscriptions, API-key/OpenRouter providers, and local endpoints such as LM Studio/Ollama/vLLM), coordinates tooling through MCP, and manages multi-step workflows via an AI orchestrator.

---

## Table of Contents

- [Overview](#overview)
- [Agent-First Execution Contract](#agent-first-execution-contract)
- [Design Decisions](#design-decisions)
  - [Why Subscription-Powered First?](#why-subscription-powered-first)
  - [SDK Strategy](#sdk-strategy)
  - [Why MCP for Tool Access?](#why-mcp-for-tool-access)
  - [Why AI Orchestrator?](#why-ai-orchestrator)
- [Technical Details](#technical-details)
  - [Unified Executor Interface](#unified-executor-interface)
  - [Agent Execution (Unified Runtime)](#agent-execution-unified-runtime)
  - [AI Integration Service](#ai-integration-service)
  - [MCP Server](#mcp-server)
  - [Computer Use MCP Tools](#computer-use-mcp-tools)
  - [AI Orchestrator](#ai-orchestrator)
  - [Meta-Reasoner and Smart Fan-Out](#meta-reasoner-and-smart-fan-out)
  - [Adaptive Runtime](#adaptive-runtime)
  - [Context Compaction Engine](#context-compaction-engine)
  - [Session Persistence and Resume](#session-persistence-and-resume)
  - [Inter-Agent Messaging](#inter-agent-messaging)
  - [Memory Tool Wiring](#memory-tool-wiring)
  - [Shared Facts and Run Narrative](#shared-facts-and-run-narrative)
  - [Memory Architecture](#memory-architecture)
  - [External MCP Consumption](#external-mcp-consumption)
  - [CTO Agent Architecture](#cto-agent-architecture)
  - [Cross-Machine Portability](#cross-machine-portability)
  - [Compute Backends for Agent Execution](#compute-backends-for-agent-execution)
  - [Compute Environment Types](#compute-environment-types)
  - [Per-Task-Type Configuration](#per-task-type-configuration)
  - [One-Shot AI Task Patterns](#one-shot-ai-task-patterns)
  - [Agent Chat Service (Phase 1.5)](#agent-chat-service-phase-15)
- [Integration Points](#integration-points)
  - [Desktop Application](#desktop-application)
  - [Job Engine](#job-engine)
  - [Mission Service](#mission-service)
  - [Pack Service](#pack-service)
  - [Learning Packs](#learning-packs)
- [Implementation Status](#implementation-status)

---

## Overview

ADE's AI integration is designed around three principles:

1. **No mandatory credential management**: CLI users do not need to paste keys; `claude`/`codex` authentication is inherited. API-key/local provider configuration is optional for broader model access.
2. **Local-first execution**: ADE runs AI flows from the local desktop process and supports CLI runtimes plus direct API/local endpoints, with no ADE-hosted backend.
3. **Auditable ADE tool access**: ADE-owned tools are exposed through controlled runtime surfaces (MCP and coordinator tools), with durable logging and explicit permission profiles layered on top of provider-native model permissions.

The AI integration layer consists of four subsystems:

- **Agent SDKs** -- the execution layer that handles both CLI-backed and non-CLI model runtimes via shared execution contracts.
- **AI Integration Service** -- the main-process service that routes tasks to the appropriate provider and model.
- **MCP Server** -- the tool exposure layer that gives AI agents controlled access to ADE's capabilities.
- **AI Orchestrator** -- the coordination layer that plans and executes multi-step missions.

## Agent-First Execution Contract

From Phase 4 onward, ADE treats agent runtimes as the mandatory substrate for all non-interactive AI execution:

- Mission planning and step execution
- Conflict and PR AI actions
- Narrative generation and background summaries
- Automations (time-based and action-based), watcher, and review workflows
- Future mobile-triggered/background runs

All of those paths are normalized into a runtime record (`agentDefinitionId` + run/step/session lineage + memory policy + guardrails), even when the UX appears "one-shot".

Interactive lane development (`Terminals`, `Work` chat) remains direct user sessions and is not forced through mission runtime semantics.

Persistent identities (for example CTO-style or worker identity chat sessions) are resumable runtime surfaces, not business-completion signals. A session ending, being replaced, or resuming later does not by itself mean a workflow target completed successfully. Workflow completion must come from an explicit workflow gate such as launch completion, PR/review-ready milestones, mission completion, or an ADE-managed explicit completion action.

### Key Contract

The renderer never mutates the repository directly. Repository changes happen either through ADE's trusted main-process services or through CLI-backed model runtimes operating inside ADE-managed worktrees under the selected provider permission mode. ADE-owned capabilities still flow through ADE's own permission and policy layers, preserving an auditable boundary around mission state, orchestration, and local services.

---

## Design Decisions

### Why Subscription-Powered First?

The previous architecture required users to either sign up for a hosted service (with OAuth, cloud sync, and remote job processing) or configure bring-your-own-key (BYOK) credentials with raw API keys. Both approaches created friction:

- Hosted service: required account creation, network connectivity for AI features, and a separate billing relationship.
- BYOK: required users to obtain, paste, and rotate API keys -- a credential management burden that is error-prone and creates security surface area.

The subscription-powered approach eliminated most onboarding friction for core users. Developers who use Claude or Codex already have authenticated CLI tools on their machines. ADE spawns these CLIs as child processes, and they authenticate using whatever mechanism the user already set up (browser sign-in, token file, environment variable). ADE never sees or stores the credentials.

This also aligns AI cost with tools developers already budget for. There is no separate ADE subscription tier for AI features. API-key/OpenRouter/local runtime paths are available alongside this CLI-first path when users want broader model coverage.

### SDK Strategy

ADE uses a unified executor runtime that routes work based on model class rather than provider-specific executor implementations. The unification point is the `unified` executor kind — a single execution path that classifies models as CLI-wrapped (subprocess) or API/local (in-process) and routes accordingly.

**Key SDKs**:
- `ai-sdk-provider-claude-code` — Community Vercel AI SDK provider (Ben Vargas) wrapping Claude CLI. Authentication flows through `claude login`.
- `@openai/codex-sdk` — Official OpenAI SDK for Codex CLI. Supports subscription auth natively.
- `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, etc. — Vercel AI SDK providers for API-key models.

**Model resolution**: `modelId` → registry lookup → `isCliWrapped` classification → subprocess or in-process path. See `docs/ORCHESTRATOR_OVERHAUL.md` for the full runtime contract.

> **Historical note**: The original architecture used separate `ClaudeExecutor` and `CodexExecutor` classes with per-provider `AgentExecutor` interface implementations. These were deleted during the Phase 2-3 orchestrator overhaul (2026-03-04) in favor of the unified runtime.

### Why MCP for Tool Access?

AI agents need to interact with ADE's internal systems (lanes, packs, conflicts, tests) to be useful. There are several ways to expose these capabilities:

- **Direct function calls**: Tight coupling, no audit trail, no permission boundary.
- **Custom API**: Works but requires ADE to invent and maintain a bespoke protocol.
- **Model Context Protocol (MCP)**: Standardized protocol with built-in support in Claude and other AI tools, providing tool discovery, structured invocation, and resource access.

ADE chose MCP because:

- It provides a **natural boundary for ADE-owned capabilities**: lane operations, mission control, context export, and related ADE services remain behind one structured tool surface.
- It enables **call audit logging**: every tool invocation is a JSON-RPC message that can be logged, replayed, and analyzed.
- It supports **resource providers**: AI agents can read ADE state (pack exports, lane status, conflict predictions) through a structured interface rather than parsing raw files.
- It is **protocol-native** to Claude: the `claude` CLI has built-in MCP client support, so connecting to ADE's MCP server requires no custom integration code.

Important nuance:

- For **CLI-backed models** (Claude CLI, Codex CLI), native file/tool behavior is governed primarily by the provider runtime's own permission mode.
- For **API-key and local models**, ADE's planning/coding tool profiles are the actual tool surface.
- In both cases, ADE separately controls which ADE-owned tools are exposed.

### Why AI Orchestrator?

Simple AI tasks (generate a narrative, draft a PR description) still execute in a single pass, but are wrapped as **ephemeral task-agent runtimes**. Missions add orchestration on top of the same runtime substrate:

- **Step sequencing**: Some steps depend on others (tests must run after implementation).
- **Parallel execution**: Independent steps should run concurrently in separate lanes.
- **Context management**: Each step needs relevant context without exceeding token budgets.
- **Failure handling**: Failed steps need retry logic, intervention routing, or graceful degradation.
- **Conflict prevention**: Agents working in parallel must not create merge conflicts.

The AI Orchestrator is a coordinator agent that plans execution strategy, spawns workers for each step, monitors progress through structured reports, and routes interventions to the user. CLI-backed coordinators/workers use provider-native permission modes for native behavior, while ADE separately scopes coordinator/MCP tool exposure by role and phase.

Autonomy boundary: the coordinator owns strategic decisions (spawn, replan, validation routing, lane transfer, escalation). The deterministic runtime only enforces state integrity and policy constraints.

Validation baseline (strict, runtime-enforced):
- Required validation contracts are enforced by runtime, not prompt advice.
- Dedicated required validation auto-spawns validator steps per completed target step.
- Missing required validation blocks downstream phase transitions and emits explicit runtime/timeline signals.
- Validation signal vocabulary:
  - `validation_contract_unfulfilled`
  - `validation_self_check_reminder`
  - `validation_auto_spawned`
  - `validation_gate_blocked`
- Validation chat system messages are emitted with normalized `metadata.systemSignal = \"validation_*\"`.
- Runtime live-update reasons include `validation_contract_unfulfilled`, `validation_self_check_reminder`, and `validation_gate_blocked`.
- Status model is strict:
  - Run status `succeeded_with_risk` is removed.
  - Mission status `partially_completed` is removed.
- No sampled `spot-check` tier and no `allowCompletionWithRisk` bypass in active orchestrator behavior.

This is distinct from the orchestrator service (`orchestratorService.ts`), which is the deterministic state machine that tracks runs, steps, attempts, and claims. The AI Orchestrator is the intelligent layer on top that decides *what* to do next; the orchestrator service is the durable layer underneath that records *what happened*.

> For current orchestrator runtime contracts, execution architecture, and remaining work, see `docs/ORCHESTRATOR_OVERHAUL.md`.

---

## Technical Details

### Unified Executor Interface

All AI task dispatching flows through the unified executor (`unifiedExecutor.ts`). The executor resolves models via the registry, classifies by model class (CLI-wrapped vs API/local), and routes accordingly. Permission schema is class-based: `permissionConfig.cli` for CLI-wrapped models, `permissionConfig.inProcess` for API/local models.

### Agent Execution (Unified Runtime)

> **Note**: The legacy `ClaudeExecutor` and `CodexExecutor` classes have been deleted. All AI worker execution now routes through a single `unified` executor kind. See `docs/ORCHESTRATOR_OVERHAUL.md` for the current runtime contract.

The unified runtime supports three model classes:
- **CLI-wrapped** (Claude CLI, Codex CLI): Spawned as subprocesses. Authentication inherits from user's existing CLI login (`claude login`, Codex subscription). MCP server injected via `--mcp-config` flag, with worker-local MCP config mirrored into each worker CWD to support native teammate inheritance paths. In packaged builds, the MCP connection uses a bundled proxy binary (`adeMcpProxy.cjs`) that relays stdio over the desktop's Unix socket, avoiding the need for a separate headless MCP server process.
- **API/key models** (Anthropic API, OpenAI, Google, Mistral, DeepSeek, xAI, OpenRouter): In-process execution via Vercel AI SDK `streamText()`. Authentication via configured API keys.
- **Local models** (Ollama, LM Studio, vLLM): In-process execution via OpenAI-compatible endpoints.

Model resolution is `modelId`-first: the registry (`modelRegistry.ts`) resolves model descriptors with `isCliWrapped` classification, and the runtime routes accordingly. Permission schema is class-based (`cli` + `inProcess`) rather than provider-bucketed.

Coordinator runtime routing is strict phase-authoritative for worker spawning/delegation:
- Resolution order: `explicit model override -> current phase model`.
- Role-level default model fallback is removed from active orchestrator routing behavior.

**Key SDK dependencies**:
- `ai-sdk-provider-claude-code` — Vercel AI SDK provider wrapping Claude CLI (community, Ben Vargas)
- `@openai/codex-sdk` — Official OpenAI SDK for Codex CLI
- `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google`, etc. — Vercel AI SDK providers for API models
#### Streaming Support

All AI responses stream back to the renderer process via IPC push events (`webContents.send`). Executors produce `AsyncIterable<AgentEvent>` streams, which the AI integration service consumes uniformly. The UI renders streaming tokens in real time.

#### Session Management

Mission worker/coordinator sessions are scoped to run/step/attempt lineage. Session data includes conversation history (bounded by token budget), tool-use history, context window contents, and transcript/state records used by Missions UI thread inspection.

### AI Integration Service

The AI integration service (`aiIntegrationService.ts`) is the main-process service that replaces the previous `hostedAgentService` and `byokLlmService`. It provides a unified interface for all AI operations:

#### Task-Type Routing

The service routes each AI task to the appropriate provider based on task type and configuration:

| Task Type | Default Model | Rationale |
|-----------|--------------|-----------|
| `planning` | `anthropic/claude-sonnet-4-6` | Strong multi-step reasoning for mission decomposition |
| `implementation` | `openai/gpt-5.4-codex` | Optimized code generation with sandbox isolation |
| `review` | `anthropic/claude-sonnet-4-6` | Detailed analysis with explanation capabilities |
| `conflict_resolution` | `anthropic/claude-sonnet-4-6` | Reasoning over overlapping changes with full context |
| `commit_message` | `anthropic/claude-haiku-4-5` | Short-form generation, low latency |
| `memory_consolidation` | `anthropic/claude-haiku-4-5` | Batch memory lifecycle processing |
| `narrative` | `anthropic/claude-haiku-4-5` | Concise, developer-facing markdown summaries |
| `pr_description` | `anthropic/claude-haiku-4-5` | Factual, structured markdown for GitHub |
| `terminal_summary` | `anthropic/claude-haiku-4-5` | Structured terminal session summaries |
| `mission_planning` | `anthropic/claude-sonnet-4-6` | Multi-turn mission decomposition with tool use |
| `initial_context` | `anthropic/claude-sonnet-4-6` | Repository scan and context doc generation |

All task types route through the unified executor. Model resolution follows: explicit per-call hint > `taskRouting.<task>.model` in config > built-in default. CLI-wrapped models spawn as subprocesses; API/local models execute in-process via Vercel AI SDK.

#### Narrative Generation

Generates human-readable lane narratives from bounded pack exports:

- **Input**: `LaneExportStandard` (token-budgeted, deterministic)
- **Output**: Structured markdown narrative summarizing what changed, why, and what to do next
- **Application**: Applied locally via marker-based replacement (`ADE_NARRATIVE_START/END`) and recorded as a pack event

#### Conflict Proposal Generation

Analyzes conflict pack data to generate resolution proposals:

- **Input**: `LaneExportLite` (lane) + `LaneExportLite` (peer, optional) + `ConflictExportStandard`
- **Output**: Resolution diff + natural-language explanation + confidence score
- **Confidence scoring**: `high` (isolated change), `medium` (overlapping but non-contradictory), `low` (semantic conflict, needs human review)

#### PR Description Drafting

Generates pull request content from lane history:

- **Input**: `LaneExportStandard` with commit history
- **Output**: PR title + body markdown + suggested reviewers
- **Template**: Configurable in `.ade/ade.yaml`

#### Provider Detection

On startup and project switch, the AI integration service probes for available providers through a multi-module detection pipeline:

- **`authDetector.ts`**: Detects CLI subscriptions (`claude`, `codex`), configured API keys, OpenRouter keys, and local model endpoints. Returns a `DetectedAuth[]` array used for mode derivation and model availability filtering.
- **`providerCredentialSources.ts`**: Reads local credential files (Claude OAuth credentials, Codex auth tokens, macOS Keychain) and checks token freshness.
- **`providerConnectionStatus.ts`**: Builds a structured `AiProviderConnections` object with per-provider `authAvailable`, `runtimeDetected`, `runtimeAvailable`, `usageAvailable`, `blocker`, and `sources` fields. Both `auth-failed` and `runtime-failed` health states now mark a provider as not runtime-available, with distinct blocker messages for each failure mode.
- **`providerRuntimeHealth.ts`**: Tracks runtime health state (`ready`, `auth-failed`, `runtime-failed`) per provider. Health version increments on state changes, invalidating the status cache.
- **`claudeRuntimeProbe.ts`**: On forced refresh, performs a lightweight Claude Agent SDK query to confirm the Claude runtime can authenticate and start from the current app session. The probe resolves the Claude Code executable path via `claudeCodeExecutable.ts` and uses the centralized `resolveDesktopAdeMcpLaunch()` from `adeMcpLaunch.ts` to inject a minimal ADE MCP server configuration so the probe runs under conditions closer to real session startup.
- **`claudeCodeExecutable.ts`**: Resolves the Claude Code CLI binary path, consulting detected auth sources for known installation locations. Used by both the runtime probe and the provider resolver to ensure consistent executable discovery.

If no usable provider is detected, ADE operates in guest mode: all deterministic features (packs, diffs, conflict detection) work normally, but AI-generated content (narratives, proposals, PR descriptions) is unavailable. The UI clearly indicates which features require a CLI subscription.

#### Model Registry & Dynamic Pricing

At startup, the AI integration service also initializes the models.dev integration (non-blocking):

1. **Fetch**: `modelsDevService.initialize()` fetches the models.dev API with a 10s timeout.
2. **Parse**: Scans all providers, builds a map of model metadata (pricing, context windows, capabilities).
3. **Cache**: Persists to a local cache file; falls back to cache on network failure.
4. **Enrich**: Calls `updateModelPricing()` to merge live pricing into the `MODEL_PRICING` Proxy object, and `enrichModelRegistry()` to update context windows and capabilities in the registry.
5. **Refresh**: Repeats every 6 hours (non-blocking).

The model registry (`modelRegistry.ts`) contains 50+ models across 10 provider families (Anthropic, OpenAI, Google, DeepSeek, Mistral, xAI, OpenRouter, and local providers: Ollama, LM Studio, vLLM), classified by auth type (`cli-subscription`, `api-key`, `openrouter`, `local`). Each `ModelDescriptor` includes pricing fields directly, with a `getModelPricing()` accessor for cost lookups. Provider-to-CLI resolution uses a flat `FAMILY_TO_CLI` lookup map instead of nested ternaries. `resolveProviderGroupForModel()` maps any descriptor to its provider group (`"claude"` | `"codex"` | `"unified"`), and `isModelProviderGroup()` provides a type guard for the group union. `resolveModelDescriptorForProvider()` resolves a model reference (ID, shortId, alias, or sdkModelId) with an optional provider-group hint, preferring non-deprecated descriptors that match the hint. `getRuntimeModelRefForDescriptor()` returns the correct model reference string for a given provider group (shortId for Claude, sdkModelId for Codex, full ID for unified). Model profiles (`modelProfiles.ts`) are derived from `MODEL_REGISTRY` rather than maintained as parallel lists, ensuring profiles stay in sync with the registry automatically. The `UnifiedModelSelector` groups models by auth type and shows unavailable models as disabled with an explanatory label (e.g., "API only - not configured").

#### Provider Options (Reasoning Tier Passthrough)

Provider-specific reasoning configuration is handled by `buildProviderOptions()` in `providerOptions.ts`. Instead of inventing arbitrary token budgets, it passes the tier string directly to each provider's native configuration:

- **Anthropic** (adaptive): `{ thinking: { type: "adaptive" }, effort: tier }`
- **OpenAI/Codex**: `{ reasoningEffort: tier }`
- **Google** (3.x): `{ thinkingConfig: { thinkingLevel: tier, includeThoughts: true } }`
- **DeepSeek**: `{}` (always-on, handled by `extractReasoningMiddleware`)
- **xAI**: `{ reasoningEffort: tier }`
- **Others (Ollama, Mistral)**: `{}` (no reasoning config needed)

Each model declares its own `reasoningTiers` array in the registry, and the UI only shows tiers that the selected model supports.

#### Configuration

Provider preferences are configured in `.ade/local.yaml`:

```yaml
ai:
  # Provider mode and defaults
  mode: "subscription"               # "guest" | "subscription"
  defaultProvider: "auto"            # "auto" | "claude" | "codex"

  # Per-task-type overrides
  taskRouting:
    planning:
      provider: "claude"
      model: "anthropic/claude-sonnet-4-6-api"
      timeoutMs: 45000
    implementation:
      provider: "codex"
      model: "openai/gpt-5.4-codex"
      timeoutMs: 120000
    review:
      provider: "claude"
      model: "anthropic/claude-sonnet-4-6-api"
      timeoutMs: 30000
    conflict_resolution:
      provider: "claude"
      model: "anthropic/claude-sonnet-4-6-api"
      timeoutMs: 60000
    narrative:
      provider: "claude"
      model: "anthropic/claude-haiku-4-5-api"
      timeoutMs: 15000
      maxOutputTokens: 900
      temperature: 0.2
    pr_description:
      provider: "claude"
      model: "anthropic/claude-haiku-4-5-api"
      timeoutMs: 15000
      maxOutputTokens: 1200
      temperature: 0.2
    terminal_summary:
      provider: "claude"
      model: "anthropic/claude-haiku-4-5-api"
      timeoutMs: 10000
      maxOutputTokens: 500
      temperature: 0.1

  # Permission and sandbox configuration
  permissions:
    claude:
      claudePermissionMode: "plan"   # "default" | "acceptEdits" | "bypassPermissions" | "plan"
      settingsSources: []            # [] = ADE-controlled; ["project"] = honor .claude/settings.json
      maxBudgetUsd: 5.0              # Per-session budget cap
      sandbox: true                  # Enable sandbox mode
    codex:
      approvalMode: "on-request"     # "untrusted" | "on-request" | "on-failure" | "never"
      sandboxPermissions: "workspace-write"  # "read-only" | "workspace-write" | "danger-full-access"
      writablePaths: []              # Additional writable paths beyond cwd
      commandAllowlist: []           # Allowed shell commands (empty = default set)

  # Feature toggles
  features:
    narratives: true
    conflict_proposals: true
    pr_descriptions: true
    terminal_summaries: true
    mission_planning: true
    orchestrator: true

  # Budget controls
  budgets:
    narratives: { dailyLimit: 50 }
    conflict_proposals: { dailyLimit: 20 }
    pr_descriptions: { dailyLimit: 30 }
    terminal_summaries: { dailyLimit: 100 }
    mission_planning: { dailyLimit: 10 }
    orchestrator: { dailyLimit: 5 }
```

When `provider` is set to `auto`, the service selects the best available provider based on task type defaults and CLI availability.

### MCP Server

The MCP server is a standalone package (`apps/mcp-server`) that exposes ADE's internal tools and resources to AI processes.

#### Transport

- **Protocol**: JSON-RPC 2.0 over a `JsonRpcTransport` abstraction layer
- **Stdio transport**: Used in headless mode -- AI processes connect to the MCP server's stdin/stdout pipes
- **Socket transport**: Used in embedded mode -- the desktop app serves `.ade/mcp.sock` and external agents connect via Unix socket
- **Lifecycle**: Headless mode runs standalone with its own AI backend; embedded mode shares the desktop app's service instances
- **Smart entry point**: Auto-detects `.ade/mcp.sock` to choose proxy (embedded) vs headless mode
- **Session identity**: The MCP server propagates a `chatSessionId` field through `SessionIdentity`, resolved from the `ADE_CHAT_SESSION_ID` environment variable or the `initialize` handshake params. This links MCP tool calls back to their originating chat session for artifact ownership, computer use proof association, and audit logging. For standalone chat sessions (no mission/run/step context), the server infers the chat session from the caller ID when not explicitly provided.

#### MCP Launch Resolution

Worker and chat processes connect to ADE's MCP server through one of three launch modes, resolved by `resolveDesktopAdeMcpLaunch()` in `adeMcpLaunch.ts`:

| Mode | Binary | When used |
|------|--------|-----------|
| `bundled_proxy` | `adeMcpProxy.cjs` run via Electron's Node | Packaged desktop builds where the proxy binary exists alongside the app bundle. The proxy connects to the desktop's `.ade/mcp.sock` Unix socket and relays stdio, injecting worker identity (mission/run/step/attempt) into the MCP `initialize` handshake. |
| `headless_built` | `apps/mcp-server/dist/index.cjs` via `node` | Development or CI environments where the MCP server has been pre-built but no bundled proxy is available. |
| `headless_source` | `apps/mcp-server/src/index.ts` via `npx tsx` | Development environments where only TypeScript source is available. |

The launch resolver checks candidates in order: bundled proxy path (from `process.resourcesPath`, `__dirname`, or CWD), then the built MCP entry, then the source entry. Both `unifiedOrchestratorAdapter.ts` (worker spawning) and `claudeRuntimeProbe.ts` (provider health probing) delegate to this centralized resolver to ensure consistent MCP launch behavior across all call sites. The probe also supports a `--probe` flag that returns a JSON diagnostic without establishing a full connection.

#### Available Tools

| Tool | Description | Mutation |
|------|-------------|----------|
| `spawn_agent` | Launch a new AI agent in a specified lane | No (delegates to orchestrator) |
| `read_context` | Read pack exports, lane state, or project context | No |
| `create_lane` | Create a new lane with a worktree for agent work | Yes |
| `check_conflicts` | Run conflict prediction against other active lanes | No |
| `merge_lane` | Merge a lane back to its parent | Yes |
| `ask_user` | Route an intervention to the ADE UI for human input | No |
| `run_tests` | Execute test suites in a lane's worktree | No (reads only) |
| `get_lane_status` | Get current status of a specific lane | No |
| `list_lanes` | List all active lanes with summary status | No |
| `commit_changes` | Stage and commit changes in a lane | Yes |

#### Resource Providers

AI processes can read ADE state through structured resource endpoints:

| Resource | Format | Description |
|----------|--------|-------------|
| Pack exports | Markdown (Lite/Standard/Deep) | Token-budgeted lane and project context |
| Lane status | JSON | Current lane state including dirty/ahead/behind counts |
| Conflict predictions | JSON | Predicted merge conflicts with affected files and severity |

#### Permission and Policy Layer

Every MCP tool invocation passes through a policy engine before execution:

- **Read-only tools** (`read_context`, `check_conflicts`, `get_lane_status`, `list_lanes`, `run_tests`): Allowed by default for all authenticated sessions.
- **Mutation tools** (`create_lane`, `merge_lane`, `commit_changes`): Require explicit grant from the orchestrator's claim system. An agent must hold an active claim on the relevant lane/scope before a mutation tool will execute.
- **Intervention tools** (`ask_user`): Always allowed but rate-limited to prevent intervention flooding.
- **Agent tools** (`spawn_agent`): Restricted to the orchestrator session; individual agents cannot spawn sub-agents without orchestrator approval.

#### Call Audit Logging

Every MCP tool invocation is logged to the orchestrator's timeline:

```json
{
  "event_type": "mcp_tool_call",
  "tool": "commit_changes",
  "caller": "agent_step_003",
  "args": { "lane_id": "lane_abc", "message": "Implement auth middleware" },
  "result": "success",
  "duration_ms": 1200,
  "created_at": "2026-02-19T14:30:00.000Z"
}
```

This provides full traceability of what AI agents did during a mission run.

### Computer Use MCP Tools

Additional MCP tools available when the compute environment supports GUI interaction (browser or desktop mode). These tools enable agents to interact with running applications visually.

Status note (2026-03-12): this section describes the target computer-use architecture. ADE already models screenshot/browser-verification/video evidence in mission validation and closeout, but the local runtime does not yet expose the full `screenshot_environment` / `interact_gui` / `record_environment` tool loop end-to-end.

| Tool | Description | Environment | Returns |
|---|---|---|---|
| `screenshot_environment` | Capture current screen state | browser, desktop | Base64-encoded PNG image |
| `interact_gui` | Execute mouse/keyboard actions (click, type, scroll, key press, drag) | browser, desktop | Action confirmation + optional screenshot |
| `record_environment` | Start/stop video recording of the environment | desktop | MP4 artifact reference |
| `launch_app` | Start an application in the environment | browser, desktop | Process handle + initial screenshot |
| `get_environment_info` | Current environment type, resolution, running processes | all | Environment metadata |

**Computer use loop** (for agents interacting with GUIs):
1. Agent calls `screenshot_environment` to see current screen state
2. Screenshot sent to the model as part of the conversation
3. Model reasons about what it sees and returns structured actions
4. Agent calls `interact_gui` to execute actions (click, type, etc.)
5. Repeat until task is complete

**Provider integration**:
- **Claude agents**: Uses Anthropic's Computer Use Tool (`computer_20250124`) natively. The screenshot/action loop is built into Claude's tool use protocol. Actions: `mouse_move`, `left_click`, `right_click`, `double_click`, `type`, `key`, `screenshot`, `scroll`, `hold_key`, `triple_click`, `wait`.
- **Codex agents**: Uses OpenAI's CUA (Computer-Using Agent) API via the Responses API. Actions: `click(x,y)`, `type(text)`, `scroll`, `key`, `screenshot`, `wait`, `drag`.

**Artifact production**: Target behavior is for screenshots and video recordings produced by computer use tools to attach to the owning lane, mission, or agent run as `screenshot` (PNG) and `video` (MP4) artifacts.

Current implementation note: orchestrator closeout can reason about screenshot/browser-verification/video evidence from declared or discovered artifacts, and Linear closeout can publish artifact links, but automatic ADE-managed screenshot/video capture and PR-body embedding are not shipped end-to-end yet.

**Permission control**: Computer use tools require `full-auto` / `bypassPermissions` permission level. Agents in `read-only` or `edit` modes cannot use GUI interaction tools (screenshot capture is allowed in all modes).

**Computer use policy**: The `ComputerUsePolicy` mode is either `"auto"` (default) or `"enabled"`. The former `"off"` mode has been removed -- computer use is always available. Agents are directed to prefer Ghost OS (`ghost mcp`) for desktop or browser control when available, then other approved external backends, and only fall back to ADE-local computer use when explicitly allowed. When a task needs verification or proof, agents capture screenshots, videos, traces, or console logs and call `ingest_computer_use_artifacts` to file evidence in ADE's proof drawer.

### AI Orchestrator

The AI Orchestrator is the intelligent coordination layer that plans and executes multi-step missions. It uses a **leader/worker agent team architecture** inspired by Claude Code's agent teams model: one leader session (the orchestrator itself) coordinates multiple worker agents, each operating in its own context window and lane worktree. The orchestrator runs on top of the deterministic orchestrator service state machine, issuing commands through it rather than replacing it.

#### Module Decomposition

The AI orchestrator codebase (`aiOrchestratorService.ts`) has been decomposed from a 13.2K-line monolith into a ~9.9K-line core plus eight domain-specific modules. All modules share state through an `OrchestratorContext` object (defined in `orchestratorContext.ts`) that holds 22+ mutable `Map` objects. Extracted functions follow the pattern `fooCtx(ctx: OrchestratorContext, ...args)`, with thin wrappers in the main file: `const foo = (...args) => fooCtx(ctx, ...args)`. Cross-module dependencies are passed via typed deps objects rather than direct imports.

| Module | Lines | Responsibility |
|--------|-------|----------------|
| `aiOrchestratorService.ts` | ~9,900 | Core orchestration: autopilot tick loop, coordinator session management, step dispatch, event handling |
| `orchestratorContext.ts` | ~1,380 | `OrchestratorContext` type definition holding all mutable state Maps |
| `chatMessageService.ts` | ~2,060 | All chat/messaging: thread CRUD, message send/get, @mention parsing, agent message routing, global chat, reconciliation |
| `workerDeliveryService.ts` | ~1,650 | Inter-agent message delivery: worker delivery context resolution, PTY write / SDK injection, queued message replay, worker-to-coordinator routing |
| `workerTracking.ts` | ~1,680 | Worker state management + `updateWorkerStateFromEvent` event handler mapping orchestrator events to worker state transitions |
| `missionLifecycle.ts` | ~600 | Mission run management, hook dispatch (`dispatchOrchestratorHook`, `maybeDispatchTeammateIdleHook`) |
| `recoveryService.ts` | ~400 | Failure recovery, health sweep, hydration on startup |
| `modelConfigResolver.ts` | ~150 | Model config resolution with 30s TTL cache: `resolveCallTypeConfig`, `resolveOrchestratorModelConfig`, `resolveMissionLaunchPlannerModel` |
| `orchestratorConstants.ts` | ~170 | Runtime constants: `LEGACY_STEP_TO_TASK_STATUS`, `DEFAULT_ROLE_ISOLATION_RULES`, etc. |

The deterministic orchestrator service (`orchestratorService.ts`, ~11K lines) has also been decomposed, with `orchestratorQueries.ts` (~840 lines) extracting DB row types, normalizers, and parse helpers, and `stepPolicyResolver.ts` (~390 lines) extracting step policy resolution and file claim helpers. Both modules are shared between `orchestratorService.ts` and `aiOrchestratorService.ts`.

#### Design Principles (Informed by Claude Code Agent Teams)

The orchestrator adopts key patterns proven in Claude Code's multi-agent coordination:

1. **Leader/Worker Separation**: The orchestrator session acts as the team leader — it plans, assigns, monitors, and synthesizes. Worker agents execute implementation, review, and testing tasks independently. Workers never coordinate directly with each other; all coordination flows through the orchestrator or the shared task infrastructure.

2. **Shared Task List as Coordination Backbone**: All steps in a mission are materialized as a structured task list that both the orchestrator and the deterministic runtime can inspect. Steps have states (`pending`, `claimed`, `in_progress`, `completed`, `failed`), dependencies (a step blocked by another cannot start), and owners (the agent assigned to execute it). This mirrors Claude Code's team task list with file-lock-based claim safety.

3. **Context Isolation via Lane Worktrees**: Each worker agent operates in its own lane worktree — an isolated copy of the repository. This prevents file conflicts between parallel agents (a critical lesson from agent teams: "two teammates editing the same file leads to overwrites"). The orchestrator assigns file/lane ownership at the step level to guarantee isolation.

4. **Scoped Agent Profiles**: Each worker receives a focused system prompt, restricted tool access, and a scoped memory briefing — not the orchestrator's full conversation history. This matches Claude Code's subagent pattern: workers load project context independently and receive only task-specific instructions from the leader.

5. **Plan Approval Gates**: For complex or risky steps, the orchestrator can require plan approval before a worker begins implementation. The worker researches and plans in read-only mode, submits a plan to the orchestrator, and the orchestrator approves or rejects with feedback. This mirrors the `plan_mode_required` pattern in agent teams.

6. **Inter-Agent Messaging via Structured Events**: All communication between the orchestrator and workers flows through structured `OrchestratorEvent` records — not free-form text. Event types include: `step_assigned`, `step_started`, `step_completed`, `step_failed`, `intervention_requested`, `context_loaded`, `agent_spawned`, `plan_submitted`, `plan_approved`, `plan_rejected`. Each event is durable and queryable from History.

7. **Graceful Lifecycle Management**: Workers go idle between tasks. The orchestrator detects idle workers, assigns new tasks or requests shutdown. Workers can reject shutdown if they have in-progress work. All shutdown is graceful — forced termination is a last resort after timeout.

#### Architecture

```
Mission prompt + memory briefings
        │
        ▼
┌──────────────────────────────────────────────────┐
│  AI Orchestrator (Leader Session)                 │
│  Claude session + ADE MCP server connected        │
│                                                    │
│  ┌────────────┐                                    │
│  │  Planner   │ ──> step plan (JSON schema)        │
│  └────────────┘                                    │
│        │                                           │
│        ▼                                           │
│  ┌──────────────────┐                              │
│  │  Task Dispatcher  │ ──> shared task list         │
│  └──────────────────┘     (pending → claimed →     │
│        │                   in_progress → done)      │
│        │                                           │
│  ┌─────┼──────────┐                                │
│  ▼     ▼          ▼                                │
│ Worker Worker   Worker   (each in own lane)        │
│  A      B        C                                 │
│  │      │        │                                 │
│  ▼      ▼        ▼                                 │
│ ┌──────────────────────────────┐                   │
│ │    Unified Executor          │                   │
│ │  (CLI-wrapped or in-process  │                   │
│ │   based on model class)      │                   │
│ └──────────────────────────────┘                   │
│        │                                           │
│  ┌─────┼──────────┐                                │
│  ▼     ▼          ▼                                │
│ Lane  Lane      Lane     (isolated worktrees)      │
│  W1    W2        W3                                │
│  │     │         │                                 │
│  ▼     ▼         ▼                                 │
│  ┌──────────────────┐                              │
│  │     Monitor      │ ──> heartbeats, gate reports │
│  └──────────────────┘                              │
│        │                                           │
│        ▼                                           │
│  ┌──────────────────┐                              │
│  │   PR Strategy    │ ──> integration/per-lane/    │
│  │                  │     queue/manual PR flow      │
│  └──────────────────┘                              │
│        │                                           │
│        ▼                                           │
│  Orchestrator Events (durable audit trail)         │
└──────────────────────────────────────────────────┘
        │
        ▼
Orchestrator service (deterministic state machine)
        │
        ▼
Mission service (user-facing lifecycle)
```

#### Planning Phase (Built-In, Default On)

Planning is a first-class mission phase (`planning`) inside the orchestrator run. As of the current runtime, planning enforcement is mandatory — if the coordinator receives a `phases` array that lacks a planning phase, the `CoordinatorAgent` constructor injects a synthetic `builtin:planning` PhaseCard at position 0 with `mustBeFirst: true`, `requiresApproval: false`, and `askQuestions: { enabled: true, maxQuestions: 5 }`, shifting all other phase positions down. This guarantees that every phased mission begins with a research-and-plan pass before any code-changing workers are spawned.

Runtime flow with planning enabled:

1. Mission run starts with `phaseRuntime.currentPhaseKey = "planning"`.
2. Coordinator enters planning mode, gathers mission context, and should hand planning work off quickly.
3. If planning clarifications are enabled (`askQuestions.enabled === true`), the coordinator must issue at least one `ask_user` clarification or confirmation round before finalizing the plan. The `PhaseCardAskQuestions` type supports multi-round deliberation: when `orderingConstraints.canLoop` is true on the planning phase, the coordinator may loop back to gather additional clarifications before finalizing the plan. A `loopTarget` field optionally names the phase to loop back to (e.g., looping from a review phase back to planning). The `maxQuestions` field (clamped to 1–10) bounds how many questions the coordinator can ask per phase iteration, preventing unbounded clarification cycles.
4. While a planning quiz intervention is open, coordinator task/delegation tools are runtime-blocked.
5. Planning work runs in read-only mode.
6. Coordinator requires a usable planner result before downstream development unlocks.
7. When the planning phase has `requiresApproval: true`, the coordinator's call to `set_current_phase({ phaseKey: "development" })` triggers an approval gate. The runtime creates a `phase_approval` intervention that pauses the mission until the user reviews the planning output and explicitly approves the transition. See [Intervention Routing](#intervention-routing) for details on the `phase_approval` intervention type.
8. Once approval is granted (or if `requiresApproval` is false, which is the built-in default), the coordinator transitions to development.
9. After delegation, coordinator should stay mostly event-driven until workers report actionable progress, failure, or escalation.

**Mandatory planning enforcement** (VAL-PLAN-005): The `CoordinatorAgent` constructor enforces that a planning phase exists. If the caller-provided `phases` array omits planning, the constructor injects one with `mustBeFirst: true`, `askQuestions: { enabled: true, maxQuestions: 5 }`, and `requiresApproval: false`. Additionally, on the first coordinator turn, a planning watchdog (`enforcePlanningFirstTurnDelegation`) checks whether the coordinator actually spawned a planning worker; if it did not (and no planning execution record exists), the watchdog force-spawns a read-only planning worker via `buildPlanningRecoveryPrompt()` to prevent the coordinator from bypassing the planning phase.

Runtime flow with planning disabled:

1. Run seeds `phaseRuntime` from the first enabled phase (typically `development`).
2. Coordinator skips planning protocol and proceeds directly to DAG orchestration.

Legacy note:
- Older persisted rows may still contain `plan_review`; runtime normalizes those to `in_progress` for read compatibility.

#### Worker Agent Spawning

For each step that enters the `claimed` state, the orchestrator spawns a worker agent. As of M4/M5, worker spawning is gated by three additional runtime checks: adaptive complexity classification, budget hard caps, and phase-authoritative model resolution.

**Pre-spawn gates** (evaluated in `authorizeWorkerSpawnPolicy` and `checkBudgetHardCaps`):

- **Budget hard cap check**: Before spawning, the runtime queries `getMissionBudgetStatus()` for the current mission. If any hard cap is triggered (5-hour usage, weekly usage, or API key spend limit), the spawn is rejected and the coordinator receives a structured error explaining which budget limit was hit. The `onHardCapTriggered` callback creates a blocking intervention so the user can decide whether to raise the cap or finalize the mission.
- **Phase ordering validation**: The runtime validates that spawning a worker in the current phase respects `mustBeFirst`, `mustBeLast`, `mustFollow`, and `mustPrecede` ordering constraints on PhaseCards. Validation gates on prior phases must also have completed before a worker in a downstream phase can start.
- **Adaptive parallelism**: The `scaleParallelismCap()` function in `adaptiveRuntime.ts` determines how many workers can run concurrently based on the mission's `TeamComplexityAssessment.estimatedScope`. Small missions get a cap of 1 (serial execution), medium missions 2, large missions 4, and very large missions 6.
- **Model downgrade evaluation**: Before resolving the worker's model, `evaluateModelDowngrade()` checks whether the current provider usage percentage exceeds the configured `downgradeThresholdPct`. If so, the runtime substitutes a cheaper model (e.g., Opus → Sonnet → Haiku, or GPT-5 → GPT-4o → GPT-4o-mini) and logs the downgrade reason. This allows long-running missions to stay within budget by progressively reducing per-token cost.

**Spawn sequence**:

1. **Lane Assignment**: Each worker operates in a dedicated lane worktree. If the step specifies `lanes: ["new"]`, a new lane is created via the `create_lane` MCP tool. If it references an existing lane, the worker is assigned to that lane.

2. **Agent Profile Construction**: The worker receives:
   - A **system prompt** built from the step's description, the mission context, and any identity policy (Phase 4).
   - A **memory briefing** scoped to the mission and agent context.
   - An **ADE tool profile** — coordinator/MCP/reporting tools are restricted to those appropriate for the worker role and phase.
   - A **permission mode** — for CLI-backed models this governs native behavior (`plan`/read-only vs edit/full execution); for API-key/local models it selects ADE's planning/coding tool profiles.

3. **ADE Tool Connection**: Workers receive ADE-owned tools through the current runtime surface. CLI-backed workers commonly connect through the ADE MCP server (via the bundled proxy in packaged builds or the headless MCP server in development), while API/local models use ADE's in-process planning/coding tools. In both cases, ADE enforces claimed scope (lane + file patterns) for ADE-owned actions.

4. **Session Tracking**: Worker execution attempts are registered as tracked sessions/attempts for transcript capture, delta computation, and pack integration — the same lifecycle guarantees as interactive chat sessions.

**Phase-authoritative model resolution**: Worker model selection follows a strict resolution order: explicit model override (if the coordinator specifies `modelId` in `spawn_worker`) → current phase model (from `phaseRuntime.currentPhaseModel.modelId`). If the coordinator requests a model that differs from the current phase's configured model, the spawn is rejected with a descriptive error directing the coordinator to either omit `modelId` or call `set_current_phase` first. Role-level default model fallback has been removed from active orchestrator routing.

#### Worker Coordination Patterns

The orchestrator manages workers through several coordination patterns:

| Pattern | Description | When Used |
|---------|-------------|-----------|
| **Sequential Chain** | Worker A completes, Worker B starts with A's output as context | Steps with hard dependencies (implement → test → review) |
| **Parallel Fan-Out** | Multiple workers start simultaneously in separate lanes | Independent implementation steps (feature A in lane-1, feature B in lane-2) |
| **Fan-In Merge** | Orchestrator waits for all parallel workers, then merges lanes | After parallel implementation, before integration testing |
| **Plan-Then-Implement** | Worker plans in read-only mode, orchestrator approves, worker implements | Complex/risky steps where the approach should be validated first |
| **Review-and-Revise** | One worker implements, another reviews, orchestrator decides on revision | Quality-critical code paths |
| **Speculative Parallel** | Multiple workers attempt the same step with different approaches, best result wins | Ambiguous tasks where the optimal approach is unclear |
| **Atomic Batch Delegation** | Coordinator delegates N children in one validated transaction via `delegate_parallel` | When a parent worker needs multiple independent sub-tasks launched together |
| **Approval-Gated Phase Transition** | Coordinator completes phase work, runtime blocks transition until user approves via `phase_approval` intervention | Phases with `requiresApproval: true` (e.g., planning → development) |

**Approval gates** (M4/M5): The `PhaseCard` type includes a `requiresApproval` boolean field. When a phase has `requiresApproval: true`, the coordinator's call to `set_current_phase` to leave that phase is intercepted by the approval gate logic in `coordinatorTools.ts`. The runtime checks whether a resolved `phase_approval` intervention exists for the current phase. If no resolved approval is found, the runtime creates a new `phase_approval` intervention (with `pauseMission: true`) and returns a blocking error to the coordinator. The coordinator must then wait for the user to review the phase output and resolve the intervention before retrying the phase transition. This pattern is primarily used for the planning → development transition, ensuring that the user has an opportunity to review and approve the plan before implementation begins, but it applies to any phase with `requiresApproval: true`.

**Phase 4 runtime delegation contract**:
- Parent awareness is push-based: terminal child completions auto-roll up to parent pending messages, and `report_status` updates are forwarded with `[sub-agent:<name>]` context.
- `stream_events` now includes normalized `worker_status_reported` payloads for forwarded child progress.
- `get_worker_output` remains the detailed artifact path; parent rollups intentionally stay concise.
- Native (Claude-side) teammates are auto-registered as `source: "claude-native"` when they report from a valid run/worker context, and are bounded by parent allocation caps.

### Coordinator-owned delegation contracts

Coordinator-spawned workers now run under an explicit runtime delegation contract. This preserves the coordinator's strategic autonomy while making delegated-scope ownership deterministic. The coordinator still decides when to delegate, how to decompose work, whether to retry, and how to replan. The runtime owns the contract that says what the coordinator may or may not do while a delegated scope is active.

This keeps three layers separate:

1. **Strategic autonomy**: the coordinator chooses plans, worker types, decomposition, recovery paths, and replanning.
2. **Delegated-scope ownership**: once a scope is delegated, the coordinator must not silently do that same scoped work itself.
3. **Runtime enforcement**: deterministic code enforces permissions, launch failure handling, terminal-state behavior, and auditability independent of prompt wording or UI copy.

Universal delegation invariants:

- Every coordinator-spawned worker gets a `DelegationContract` before launch.
- Active delegated scopes are explicitly owned; there is no silent "unowned" delegated period.
- Launch failures are classified and routed through recovery policy rather than letting the coordinator drift into the delegated job.
- Cancellation supersedes delegation and activates late-write suppression.
- Lifecycle/UI should derive from structured delegation state (`delegation_state` events and persisted coordinator availability), not only from coordinator prose.

Delegation modes:

- `exclusive`: one worker owns the delegated scope. Use for planner startup and similar "do not overlap reasoning" windows. Coordinator may observe, fetch approved startup context, launch the delegated worker, wait, message the worker, and handle run control; it may not continue the delegated repo exploration or planning itself.
- `bounded_parallel`: the coordinator may launch multiple independent workers up to a runtime cap, but scopes must stay non-overlapping and explicitly owned. Coordinator may still decompose, observe, aggregate, and schedule next-wave work.
- `recovery`: a failed or blocked delegated scope is handed to an explicit recovery contract rather than silently resuming the failed scope directly. Coordinator may classify, intervene, or launch authorized recovery work, but must not quietly "become" the failed worker.

Planner startup gating is now modeled as the strictest `exclusive` delegation case rather than a permanent one-off rule. Other worker types can use looser modes without weakening the core invariant that the coordinator must not silently cross delegated scope boundaries.

Primary enforcement points:

- `coordinatorTools.ts` creates delegation contracts, enforces phase-specific launch policy, and persists worker-linked contract metadata.
- `coordinatorAgent.ts` applies active-contract tool-permission checks so the coordinator cannot drift into delegated work mid-turn.
- `aiOrchestratorService.ts` projects structured delegation state into lifecycle/status UI while keeping cancellation and late-write suppression outside prompt logic.

#### File Conflict Prevention

The orchestrator prevents file conflicts between parallel workers through:

1. **Claim-Based File Ownership**: Each step declares `filePatterns` in its claim policy. The orchestrator validates at planning time that no two parallel steps claim overlapping patterns. If overlap is detected, the planner re-sequences those steps.

2. **Pre-Merge Conflict Check**: Before merging a worker's lane back, the orchestrator calls `check_conflicts` to detect any conflicts with other active worker lanes. If conflicts are found, the orchestrator decides whether to auto-resolve (using the conflict resolution AI), ask the user, or re-sequence.

3. **Merge Sequencing**: The `mergePolicy` field in the plan determines when worker lanes are merged back:
   - `sequential`: Each worker's lane is merged immediately after the step completes.
   - `batch-at-end`: All worker lanes are merged in dependency order after the entire mission completes.
   - `per-step`: The orchestrator decides per-step based on downstream dependencies.

#### Step Execution

For each step in the plan, the orchestrator:

1. Checks dependency satisfaction (all predecessor steps completed successfully, or join policy allows continuation).
2. Acquires claims on the required scopes (lane, file patterns, environment keys) via the deterministic runtime's claim system.
3. Creates a context snapshot with the appropriate export level for the step.
4. If `requiresPlanApproval` is true:
   a. Dispatches the worker in read-only mode (provider-native plan permission).
   b. Worker researches the codebase and submits a plan via structured output.
   c. Orchestrator evaluates the plan (checks for scope creep, file ownership violations, test coverage).
   d. If approved, re-dispatches the worker with edit permissions.
   e. If rejected, provides feedback and re-dispatches in plan mode for revision.
5. Dispatches the step by `executorKind`:
   - `unified`: resolve descriptor from `modelId`, then route by execution class (CLI descriptor -> subprocess adapter, non-CLI descriptor -> in-process unified path).
   - `shell`: runs a shell command (for deterministic steps like test execution).
   - `manual`: waits for user action (for steps requiring human judgment).
6. Monitors the attempt via session tracking and claim heartbeats.
7. On completion, records the result envelope, releases claims, and optionally triggers merge.

#### Worker Lifecycle

Workers follow a predictable lifecycle:

```
spawned → initializing → working → idle/completed/failed
                                        │
                                   (if more tasks)
                                        ▼
                                     working → ...
                                        │
                                   (if shutdown)
                                        ▼
                                    disposed
```

- **Idle Detection**: When a worker completes a step, it enters `idle` state. The orchestrator detects this via the session tracking system and either assigns the next step or requests shutdown.
- **Heartbeat Monitoring**: Workers emit claim heartbeats at regular intervals. If heartbeats stop (agent crash, timeout), the orchestrator marks the step as `failed` and handles retry/escalation.
- **Graceful Shutdown**: When the mission completes, the orchestrator sends shutdown requests to all idle workers. Workers acknowledge and exit. Workers with in-progress work can reject shutdown; the orchestrator waits for completion before re-requesting.

#### Context Window Management

The orchestrator manages AI context budgets through ADE's pack export system:

- **Lite exports** (~2K tokens): Lane metadata, file list, recent commits. Used for quick status checks and worker heartbeat context.
- **Standard exports** (~8K tokens): Lite content plus file-level diffs, test results, and conflict state. Used for most planning and review tasks.
- **Deep exports** (~32K tokens): Standard content plus full file contents for key files, detailed transcript excerpts, and narrative history. Used for complex implementation steps.

Each step in a plan specifies its `contextProfiles` field, and the orchestrator assembles the appropriate export before dispatching the step.

**Progressive Context Loading**: The orchestrator session itself starts with the mission pack + project pack. As workers complete steps and produce results, the orchestrator loads result summaries on demand rather than accumulating all worker output. This prevents the orchestrator's context window from filling under large missions.

**Context Pressure Management**: When the orchestrator's context utilization exceeds 80%, it triggers a summarization pass — older step results and intermediate context are compressed into summary blocks. The deterministic runtime's durable state serves as the ground truth; the orchestrator can always re-read step results from the runtime if needed.

#### Intervention Routing

When an AI agent encounters a situation requiring human input, it invokes the `ask_user` MCP tool. The orchestrator:

1. Pauses the current step's attempt.
2. Creates an intervention record in the mission service with structured context (what the agent was doing, what it needs, what options exist).
3. Broadcasts an intervention event to the renderer via IPC.
4. The UI displays the intervention in the mission detail view with the agent's question and context.
5. When the user responds, the intervention is resolved and the orchestrator resumes the step with the user's input.

Interventions can also be triggered automatically when:
- A step fails and exceeds its retry limit.
- A conflict is detected between worker lanes that cannot be auto-resolved.
- A gate report indicates a blocking condition (e.g., failing tests after implementation).
- A worker's plan is rejected by the orchestrator and the orchestrator cannot provide adequate feedback (escalates to user).
- Budget or time limits are approaching.
- A phase transition is attempted on a phase with `requiresApproval: true` (triggers a `phase_approval` intervention).

**Intervention types**: The `MissionInterventionType` union includes the following values:

| Type | Trigger | Blocking Semantics |
|------|---------|-------------------|
| `manual_input` | Agent calls `ask_user` or `request_user_input` | Pauses the requesting step; other steps may continue |
| `ask_user` | Coordinator needs clarification during planning | Blocks coordinator task/delegation tools while open |
| `failed_step` | Step exhausts retry budget | Blocks the failed step; coordinator decides next action |
| `orchestrator_escalation` | Coordinator cannot resolve an issue autonomously | Mission-level pause until user responds |
| `budget_limit_reached` | Hard budget cap triggered during spawn or execution | Blocks all further spawns; mission pauses |
| `provider_unreachable` | CLI or API provider is unavailable | Blocks steps targeting that provider |
| `unrecoverable_error` | Fatal runtime error with no retry path | Mission-level pause |
| `phase_approval` | `set_current_phase` called on a phase with `requiresApproval: true` | **Blocks the entire phase transition.** The coordinator cannot proceed to the next phase until the user resolves this intervention. Created with `pauseMission: true`, which suspends the orchestrator autopilot loop. The intervention metadata includes `phaseKey`, `phaseName`, `targetPhaseKey`, `targetPhaseName`, and `source: "phase_approval_gate"`. Once the user resolves the intervention (via the mission detail UI), the coordinator retries `set_current_phase` and the transition succeeds. |

The `phase_approval` intervention type was introduced in M4/M5 to support the approval gate pattern. It differs from other intervention types in that it blocks at the phase-transition level rather than the step level — no work in the target phase can begin until approval is granted, regardless of how many steps are ready to execute.

#### Error Classification and Benign Failure Handling

The orchestrator classifies worker errors and warnings to distinguish genuinely blocking failures from benign noise that should not trigger retries or mission-level escalation.

**`classifyBlockingWarnings()`** (in `orchestratorQueries.ts`) scans all warnings and the attempt summary for patterns that indicate real failures versus expected noise:

- **External MCP noise**: Warnings matching `EXTERNAL_MCP_NOISE_PATTERNS` (e.g., Slack/claude.ai connection chatter) are silently skipped — they originate from external MCP servers and do not reflect worker failure.
- **Benign sandbox blocks** (`BENIGN_SANDBOX_BLOCK_PATTERNS`): Provider-native planning features sometimes attempt writes that the sandbox intentionally blocks. Two categories are treated as benign:
  1. **`.claude/plans/` path blocks**: The planning worker prompt directs plan artifacts to `.ade/plans/`, so sandbox blocks on the provider-native `~/.claude/plans/` path are expected and intentional.
  2. **ExitPlanMode Zod/validation errors**: Workers are instructed not to use `ExitPlanMode` (the provider-native plan approval flow), but if a worker attempts it anyway, the resulting Zod schema mismatch or validation error is classified as benign. The patterns `ExitPlanMode.*(?:Zod|validation|schema|parse)` and the reverse match order both suppress these errors from triggering step failure or retry.
- **Blocking patterns**: Warnings that survive the noise and benign filters are matched against `BLOCKING_WARNING_PATTERNS` which categorize genuine failures (sandbox blocks on disallowed paths, permission violations, tool crashes, etc.).

This classification is critical for planning workers: without benign pattern filtering, ExitPlanMode errors would cause spurious retry loops, wasting budget on repeated planning attempts that were actually successful.

#### Orchestrator Configuration

The orchestrator is configurable in `.ade/local.yaml`:

```yaml
ai:
  orchestrator:
    # Planning phase behavior is controlled by mission phase profiles.
    # Built-in profiles include `planning` as phase 1 by default.
    max_parallel_workers: 4           # Max concurrent worker agents
    default_merge_policy: sequential  # sequential | batch-at-end | per-step
    default_conflict_handoff: auto-resolve  # auto-resolve | ask-user | orchestrator-decides

    # Worker management
    worker_heartbeat_interval_ms: 30000
    worker_heartbeat_timeout_ms: 90000
    worker_idle_timeout_ms: 300000    # Shut down idle workers after 5 min
    step_timeout_default_ms: 300000   # Default per-step timeout
    max_retries_per_step: 2

    # Context management
    context_pressure_threshold: 0.8   # Trigger summarization at 80% capacity
    progressive_loading: true         # Load worker results on demand

    # Budget
    max_total_budget_usd: 50.0        # Hard budget cap for entire mission
    max_per_step_budget_usd: 10.0     # Per-step budget cap
```

### Meta-Reasoner and Smart Fan-Out

The meta-reasoner (`metaReasoner.ts`) adds AI-driven dispatch intelligence to the orchestrator's autopilot loop. Rather than relying solely on the static step plan, the meta-reasoner analyzes in-flight mission state and dynamically injects or restructures steps.

**`analyzeForFanOut()`**: The core entry point. Given the current run state, active steps, and completed results, the meta-reasoner:

1. Evaluates whether remaining work can be parallelized.
2. Selects a fan-out strategy: `external_parallel` (multiple agents in separate lanes), `internal_parallel` (single agent handling sub-tasks), or `hybrid` (combination).
3. Dynamically injects new steps into the orchestrator's step DAG with appropriate dependency edges.
4. Tracks fan-out completion via a fan-in pattern — the orchestrator waits for all fan-out steps to complete before proceeding to dependent steps.

**Integration**: The meta-reasoner is invoked within the autopilot tick loop (`aiOrchestratorService.ts`). When the autopilot detects that multiple steps could run concurrently but are currently sequenced, it consults the meta-reasoner before dispatching.

**Configuration**: The meta-reasoner model and fan-out limits are configurable in `.ade/local.yaml` under `ai.orchestrator.metaReasoner`.

### Adaptive Runtime

The adaptive runtime module (`adaptiveRuntime.ts`, introduced in M5) provides heuristic-driven scaling of parallelism and model cost based on mission complexity and budget utilization. It operates as a pure-function layer consumed by the coordinator tools and orchestrator service — it does not maintain state itself.

#### Task Complexity Classification

`classifyTaskComplexity(description: string): TaskComplexity` analyzes a mission or step description and returns one of four complexity buckets: `trivial`, `simple`, `moderate`, or `complex`. Classification uses a multi-signal heuristic:

- **Word count**: Short descriptions (< 20 words with trivial indicators) are classified as trivial; long descriptions (> 120 words) as complex.
- **Complexity indicators**: Keywords like "parallel", "distributed", "migration", "architecture", "overhaul", "cross-cutting", and "end-to-end" push toward `complex`.
- **Moderate indicators**: Keywords like "integrate", "service", "endpoint", "feature", "module", "refactor", and "ci/cd" push toward `moderate`.
- **Simple/trivial indicators**: Keywords like "fix bug", "rename", "typo", "formatting", and "docs" push toward simpler buckets.
- **File reference density**: More than 10 file references in the description suggests complex scope; more than 4 suggests moderate.

The complexity classification feeds into parallelism scaling and is also available for coordinator prompt construction.

#### Parallelism Cap Scaling

`scaleParallelismCap(estimatedScope: TeamComplexityAssessment["estimatedScope"]): number` maps the mission's estimated scope to a concrete worker concurrency limit:

| Estimated Scope | Parallelism Cap | Rationale |
|----------------|----------------|-----------|
| `small` | 1 | Serial execution; coordination overhead exceeds parallelism benefit |
| `medium` | 2 | Modest parallelism for moderately scoped work |
| `large` | 4 | Full parallel fan-out for multi-workstream missions |
| `very_large` | 6 | Maximum parallelism for large-scale refactors and multi-service work |

The parallelism cap is enforced at spawn time — the coordinator's `spawn_worker` and `delegate_parallel` tools check the current active worker count against the scaled cap before proceeding.

#### Model Downgrade at Usage Thresholds

`evaluateModelDowngrade(args)` checks whether current provider usage exceeds a configurable threshold and, if so, substitutes a cheaper model for subsequent worker spawns:

- **Inputs**: `currentModelId`, `downgradeThresholdPct` (e.g., 70%), `currentUsagePct` (from budget telemetry), and an optional `cheaperModelId` override.
- **Downgrade heuristic** (`resolveCheaperModel`): Anthropic models downgrade along the Opus → Sonnet → Haiku chain; OpenAI models downgrade along GPT-5 → GPT-4o → GPT-4o-mini. If no cheaper model is available (already at the cheapest tier), the original model is retained with a logged warning.
- **Output**: A `ModelDowngradeResult` struct indicating whether a downgrade occurred, the original and resolved model IDs, and a human-readable reason string that is injected into the coordinator's event stream.

Model downgrade is evaluated inside the worker spawn authorization flow (`authorizeWorkerSpawnPolicy`) so that the coordinator receives the downgraded model transparently — it does not need to implement its own cost-optimization logic.

#### Budget Enforcement Gates

Budget enforcement operates at two levels:

1. **Soft pressure signals**: The `onBudgetWarning` callback emits `"warning"` or `"critical"` signals to the coordinator's event stream, guiding it to reduce parallelism or finalize early. These are advisory — the coordinator can choose how to respond.
2. **Hard cap blocks**: The `checkBudgetHardCaps()` function in `coordinatorTools.ts` queries `getMissionBudgetStatus()` and rejects spawns if any hard cap is triggered (5-hour rolling window, weekly rolling window, or absolute API key spend). Hard cap violations create a `budget_limit_reached` intervention with `pauseMission: true`.

This layered approach allows missions to gracefully degrade under budget pressure (using cheaper models, reducing parallelism) before hitting the hard stop that pauses execution entirely.

### Context Compaction Engine

The compaction engine (`compactionEngine.ts`, integrated via `unifiedExecutor.ts`) prevents SDK agent sessions from exceeding context window limits during long-running orchestrated work.

**Token Monitoring**: The engine tracks token consumption for each active agent session. When utilization reaches 70% of the model's context window, compaction is triggered.

**Compaction Flow**:

1. **Pre-compaction writeback**: Before compacting, the engine extracts durable facts (discovered patterns, key decisions, gotchas, configuration notes) from the conversation and writes them to mission-scoped entries in `unified_memories` using strict write-gate rules and `sourceRunId` lineage.
2. **Self-summarization**: The agent generates a summary of the conversation so far, preserving key context, decisions, and current task state.
3. **Conversation replacement**: The full conversation history is replaced with the summary, dramatically reducing token count while preserving essential context.
4. **Post-compaction**: The compacted summary is written to the `attempt_transcripts` table with `compacted_at` and `compaction_summary` fields.

**Threshold Configuration**: The 70% threshold is configurable via `ai.orchestrator.compaction_threshold` in `.ade/local.yaml`. The engine also respects per-model token limits from the model registry.

### Session Persistence and Resume

Agent sessions are now durable across interruptions and application restarts.

**Transcript Persistence**: The `attempt_transcripts` DB table stores the full conversation history (as JSON message arrays) for each orchestrator attempt. Transcripts are written on every significant event (tool call, agent response, compaction) via JSONL-style append.

**`resumeUnified()`**: When an orchestrator run is resumed after interruption, `resumeUnified()` in the unified executor:

1. Loads the last `attempt_transcripts` row for the attempt.
2. Reconstructs the conversation state from the stored messages.
3. If a compaction summary exists, uses it as the conversation seed.
4. Resumes the SDK agent session with the restored context.

**Chat Transcript JSONL**: In addition to the DB-backed transcript, a JSONL file is written to `.ade/transcripts/` for each attempt, providing a human-readable audit trail of the conversation.

### Inter-Agent Messaging

A structured messaging system enables communication between the orchestrator, agents, and the user during mission execution. The messaging subsystem is decomposed into two extracted modules:

- **`chatMessageService.ts`** (~1,850 lines): All chat and thread operations -- `appendChatMessage`, `listChatThreads`, `getThreadMessages`, `sendThreadMessage`, `sendChat`, `getChat`, `sendAgentMessage`, `parseMentions`, `routeMessage`, `deliverMessageToAgent`, `getGlobalChat`, `getActiveAgents`, and reconciliation functions.
- **`workerDeliveryService.ts`** (~1,330 lines): Low-level message delivery to worker agents -- `resolveWorkerDeliveryContext`, `deliverWorkerMessage`, `replayQueuedWorkerMessages`, `routeMessageToWorker`, `routeMessageToCoordinator`.

**Message Delivery** (`deliverMessageToAgent()` in `chatMessageService.ts`, with delivery mechanics in `workerDeliveryService.ts`):
- Delivers messages to both PTY-based agents (via terminal write) and SDK-based agents (via conversation injection).
- Messages can originate from the orchestrator, other agents, or the user.
- Worker delivery context is resolved per-agent to determine the appropriate delivery mechanism.

**@Mention Routing**:
- `parseMentions()` extracts @-mentions from message text, identifying target agents by name or role.
- `routeMessage()` determines which agents should receive a message based on mentions, channel context, and routing rules.

**Team Message Tool** (`teamMessageTool.ts`): An MCP tool available to agents that allows them to send messages to other agents or the orchestrator. This enables agent-initiated communication (e.g., "I found a dependency issue that affects @testing-agent's work").

**Phase 4 push rollups and native teammate guardrails**:
- Sub-agent completion summaries are delivered automatically to parent pending messages (no polling loop required for awareness).
- Sub-agent `report_status` updates are forwarded to parent threads with a normalized prefix and emitted to the runtime event buffer.
- Unknown native callers in `report_status`/`report_result` are auto-registered as team members with `source: "claude-native"` and surfaced lineage (`parentWorkerId`) when context is resolvable.
- Native auto-registration enforces parent allocation caps (derived from run parallelism; fallback `4`) before accepting updates.

**IPC Endpoints**:
- `getGlobalChat`: Retrieves the global mission chat channel messages.
- `deliverMessage`: Sends a message from the UI to a specific agent or channel.
- `getActiveAgents`: Lists currently active agents in a mission run with their status.

Threaded chat persistence is DB-first (`orchestrator_chat_threads` and `orchestrator_chat_messages`). Startup reconciliation normalizes thread/message linkage but does not run a legacy mission-metadata backfill job.

### Memory Tool Wiring

Memory tools are wired into the agent tool surfaces via `createCodingToolSet()` / `createUniversalToolSet()`, giving agents the ability to:

- **Search scoped memories**: Query `project`, `mission`, and `agent` scopes through `memorySearch`.
- **Persist durable discoveries**: Record facts/patterns/decisions/gotchas with `memoryAdd`.
- **Pin always-on context**: Promote an existing entry to Tier 1 with `memoryPin`.
- **Update CTO core memory**: Unified/CTO sessions can also call `memoryUpdateCore`.

Memory tools follow the same MCP permission model as other agent tools. Read operations are always allowed; write operations require an active claim.

### Shared Facts and Run Narrative

**Shared Team Knowledge**: Durable cross-worker coordination now lives in mission-scoped `unified_memories`, not in a separate `orchestrator_shared_facts` table. Prompt-time `sharedFacts` sections are a derived view over mission memories, giving workers the same stable prompt section without maintaining a second storage path.

**Run Narrative**: `appendRunNarrative()` in `orchestratorService.ts` generates a rolling narrative after each step completion. The narrative summarizes what has been accomplished, what is in progress, and what remains. It is stored as `runNarrative` metadata on the orchestrator run and displayed in the Activity tab.

**Compaction Hints**: A compaction hints section is added to agent prompts, providing the agent with guidance on what information to prioritize preserving if context compaction is triggered.

**Agent Memory Instructions**: All agent types (coordinator, worker, CTO, chat) now receive improved memory instructions in their system prompts with concrete examples and quality criteria. The standard quality bar is: "Would a developer joining this project find this useful on their first day?" Instructions include explicit SAVE guidance (non-obvious conventions, decisions with reasoning, pitfalls, patterns that contradict expectations) and DO-NOT-SAVE guidance (file paths, session progress, task status, code already committed, raw error messages without lessons, anything discoverable via search or git log).

### Memory Architecture

> **Full spec**: `docs/final-plan/phase-4.md` W6 (Unified Memory System) contains the comprehensive implementation plan including schema, write gate, scoring formula, lifecycle algorithms, and pack removal strategy.

The memory system provides agents with durable, searchable long-term memory that persists across sessions and runs. Phase 4 W6, W6½, W7a, and W7b are complete: `unifiedMemoryService.ts` is the canonical durable memory backend with 3 scopes (`project`, `agent`, `mission`) and 3 tiers (Tier 1 pinned, Tier 2 active, Tier 3 aging), plus hybrid retrieval (FTS4 BM25 + cosine similarity via local Xenova/all-MiniLM-L6-v2 + MMR re-ranking), lifecycle sweeps, batch consolidation, pre-compaction flush with quality criteria, and orchestrator mission-memory wiring. Persisted `.ade/artifacts/packs/...` artifacts are no longer required for runtime context assembly. Deterministic context exports (`packService`) and CTO identity state (`ctoStateService`) remain as explicit compatibility and audit surfaces.

#### Storage Layer

- **Primary store**: SQLite (node:sqlite + cr-sqlite) with `unified_memories` as the active memory table and `unified_memory_embeddings` storing 384-dim vectors from local Xenova/all-MiniLM-L6-v2
- **Embedding model**: `@huggingface/transformers` running `Xenova/all-MiniLM-L6-v2` locally — no API calls, fully offline
- **Background embedding**: `embeddingWorkerService.ts` processes new entries asynchronously and backfills existing ones without blocking
- **Active retrieval path**: Hybrid FTS4 BM25 (30%) + cosine similarity (70%) + MMR re-ranking (λ=0.7), with graceful fallback to lexical/composite scoring when embeddings are unavailable

#### Retrieval Pipeline

```
Query → Embed query via Xenova/all-MiniLM-L6-v2 → FTS4 BM25 keyword scoring + cosine similarity →
  Hybrid score (0.30 BM25 + 0.70 cosine) → Composite scoring (hybrid + recency + importance + confidence + access) →
  MMR re-ranking (λ=0.7, reduces redundancy) → Budget filter (lite: 3, standard: 8, deep: 20) → Return
```

The composite score combines these live signals:
- **Hybrid query relevance (40%)**: Blended BM25 keyword + cosine semantic similarity (replaces lexical-only)
- **Recency (20%)**: Exponential decay with 30-day half-life on `lastAccessedAt`
- **Importance (15%)**: High=1.0, Medium=0.6, Low=0.3
- **Confidence (15%)**: Entry confidence field (0-1), grows with observations
- **Access frequency (10%)**: `min(accessCount / 10, 1.0)`, capped at 10 accesses

Budget tiers control how many memories are injected into agent context:
- **Lite** (3 entries): Quick tasks, terminal summaries, one-shot generation
- **Standard** (8 entries): Normal agent work, implementation steps
- **Deep** (20 entries): Mission planning, complex multi-file reasoning

#### Write Pipeline

```
New memory → Category/strict-mode gate →
  Lexical duplicate check in same scope →
  Merge or insert into `unified_memories` →
  Queue for background embedding (async)
```

Memory writes are persisted directly in the local project database (`.ade/ade.db`) and consumed immediately by retrieval paths. Embeddings are generated asynchronously by the background worker and never block writes or reads.

#### Memory Lifecycle (W6½)

- **Pre-compaction flush**: Before context compaction, a silent agentic turn is injected so the agent can persist in-context discoveries via `memoryAdd`. The flush prompt now includes explicit quality criteria and SAVE/DO-NOT-SAVE guidance (e.g., save non-obvious conventions and pitfalls; do not save file paths, session progress, or raw error messages). Flush counter prevents double-flush; configurable `reserveTokensFloor` (default: 40K tokens).
- **Lifecycle sweeps**: Run on configurable interval (default: daily at 3am or on startup if >24h since last sweep). Operations in order: temporal decay (30-day half-life, Tier 1 and evergreen categories exempt), tier demotion (Tier 2→3 at 90 days, Tier 3→archived at 180 days), candidate promotion (confidence ≥ 0.7 + observationCount ≥ 2), hard limit enforcement (project: 2K, agent: 500, mission: 200), orphan cleanup (mission-scoped entries for deleted missions).
- **Batch consolidation**: Weekly (or when scope exceeds 80% of hard limit). Clusters entries by Jaccard trigram similarity > 0.7 within (scope, category) groups, then merges clusters of 3+ via LLM. Tier 1 (pinned) entries are never consolidated. Original entries archived, not deleted.
- **Memory Health dashboard**: The only memory UI surface is **Settings > Memory** (Health tab). It shows entry counts by scope/tier, last sweep and consolidation timestamps and stats, embedding progress (polled at 10s intervals), hard limit usage bars, and manual "Run Sweep Now" / "Run Consolidation Now" buttons. There are no other memory surfaces in the renderer.

#### Context Assembly Per Runtime

Every agent runtime assembles its context window from a layered budget:

```
System prompt + tools definition                    (~5-10K tokens)
+ Tier 1 pinned memory (persona + working context)   (~2-4K tokens)
+ Tier 2/3 retrieved memories (budget-dependent)     (~1-3K tokens)
+ Mission shared team knowledge (derived from mission memory) (~0.5-1K tokens)
+ Conversation history                               (remaining budget)
+ Response reserve                                   (~4K tokens)
```

The 3 live memory scopes (matching `MemoryScope` in `src/shared/types/memory.ts`) are:
- `project`: Persistent project-level knowledge
- `mission`: Shared across a mission run
- `agent`: Agent-specific durable memory

`buildFullPrompt()` currently injects mission-derived shared team knowledge, mission-memory highlights, project-memory highlights, and explicit agent-memory highlights when the run carries an exact `employeeAgentId`. Structured lane/project context still comes from pack exports.

#### Prior Art & Design References

The memory architecture is informed by production systems and academic research across the agent memory landscape:

- **MemGPT / Letta**: Pioneered the tiered memory model treating LLM context as "main memory" with agent-managed read/write to "disk" storage. ADE's Tier 1 (pinned) / Tier 2 (active) / Tier 3 (aging) maps to MemGPT's core memory blocks / recall memory / archival memory. Letta's benchmarks (74% accuracy with simple file operations vs. Mem0's 68.5%) validated our choice of file-backed portable storage over database-only approaches.

- **Mem0**: Source of the PASS/REPLACE/APPEND/DELETE consolidation model. Mem0 performs real-time deduplication on every write using cosine similarity to detect overlap, then delegates merge decisions to an LLM. ADE adopts this with a conservative 0.85 similarity threshold and adds scope-aware matching (only compare within the same memory scope to prevent false merges across agent boundaries).

- **CrewAI**: The composite scoring formula (`semantic + recency + importance + access`) is adapted from CrewAI's `RecallFlow` retrieval system. CrewAI combines multiple signals for memory ranking; ADE simplifies the weights (`0.5/0.2/0.2/0.1`) for predictability and adds explicit user-settable importance tags.

- **OpenClaw**: Two direct influences — (1) the pre-compaction flush pattern, where the agent is prompted to save important memories before context eviction, using the agent's own judgment rather than mechanical extraction; (2) hybrid BM25 + vector search with configurable weights for memory retrieval. ADE formalizes the flush with a monotonic counter and compaction engine hook.

- **LangMem (LangChain)**: The episodic/procedural memory taxonomy — structured post-session summaries and learned tool-usage patterns. LangMem's key insight that procedural memories should be extracted from recurring episodic patterns (not single sessions) informed ADE's requirement for multi-episode pattern observation before procedural entry creation.

- **A-MEM**: Zettelkasten-inspired automatic linking between memory entries. While ADE does not implement full graph-based navigation in Phase 4, the consolidation APPEND operation creates implicit links and composite scoring ensures related memories co-retrieve.

- **JetBrains (NeurIPS 2025)**: Research finding that **observation masking** (replacing old tool outputs with `[output omitted]` placeholders) outperforms LLM-based summarization for context management while being significantly cheaper. ADE applies this in context assembly for resumed sessions.

- **Elvis Sun's ZOE/CODEX**: Demonstrated the context window separation principle — business/orchestration context and code context should not share the same window because context is zero-sum. Directly informed ADE's leader/worker architecture where the orchestrator holds mission context while workers hold code context.

### External MCP Consumption

`W8` shipped the baseline ADE-managed external MCP substrate. ADE now acts as the single source of truth for external MCP configuration, connection lifecycle, discovery, permissioning, and audit for ADE-managed sessions.

**Configuration**: external MCP servers are declared in `.ade/local.secret.yaml` under the `externalMcp` key:

```yaml
externalMcp:
  - name: github
    transport: stdio
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    autoStart: true
  - name: notion
    transport: http
    url: https://mcp.notion.so/mcp
    headers:
      Authorization: "Bearer ${NOTION_TOKEN}"
  - name: legacy-browser
    transport: sse
    url: https://example.com/sse
```

`externalMcpService.ts` supports `stdio` and modern remote HTTP transport, while accepting `sse` as a compatibility alias. Connections are lazy by default, with optional auto-start, ping-based health checks, reconnect backoff, graceful drain-on-remove behavior, and manifest refresh on reconnect.

**Runtime model**: Claude Code and Codex workers still receive only ADE's MCP server at launch time. ADE does not inject third-party MCP servers directly into provider-global config. Instead:

1. ADE connects to configured external servers.
2. ADE discovers their tools and stores them as namespaced identifiers such as `ext.github.create_pull_request`.
3. ADE's own MCP server exposes the filtered `ext.*` tool surface to ADE-managed workers, the CTO, and automations.

That proxy model keeps policy, mission scoping, budgeting, and audit centralized inside ADE instead of distributing it across provider runtimes.

**Security and permission model**: external MCP tools pass through ADE's existing policy layers:
- Server-level config can `allow` or `block` specific tools.
- CTO identities and worker identities can define `externalMcpAccess`.
- Mission `permissionConfig.externalMcp` can disable external MCP entirely or narrow the allowed servers/tools per mission.
- Read-only planning workers only receive read-safe external tools in their launch allowlist.
- Mutation-classified external tools still use ADE's existing approval and guardrail path.
- External invocations are logged with server, tool, safety, and usage metadata.

**Tool discovery and exposure**: ADE queries configured external MCP servers for manifests, refreshes them on reconnect and `tools/list_changed`, and merges approved tools into the ADE-visible tool surface with namespaced identifiers. Structured MCP results are preserved when those tools are called through ADE MCP.

### CTO Agent Architecture

The CTO Agent is a persistent, always-on, project-aware agent that serves as ADE's Chief Technical Officer. Unlike a simple router, the CTO maintains full memory and context about the project, can create missions, spin up lanes, check project state, and make autonomous decisions. It bridges external systems to ADE's internal surfaces while also acting as the primary interface for high-level project orchestration.

**Architecture**:

```
External MCP Request           User (CTO Tab)
        │                           │
        ▼                           ▼
┌─────────────────────────┐  ┌──────────────┐
│   MCP Server (incoming)  │  │  CTO Chat UI  │
│   (stdio or socket)      │  │  (always-on)  │
└─────────┬───────────────┘  └──────┬───────┘
          │                         │
          └────────────┬────────────┘
                       ▼
┌──────────────────────────────────┐
│   CTO Agent                       │
│   (persistent agent runtime)      │
│                                   │
│   Project Context & Memory        │
│   ┌────────────────────────────┐  │
│   │ Mission creation & mgmt   │  │
│   │ Lane orchestration        │  │
│   │ Project state queries     │  │
│   │ Intent classification     │  │
│   │ Code review coordination  │  │
│   │ Chat relay                │  │
│   └────────────────────────────┘  │
│                                   │
│   CTO State (.ade/cto/)           │
│   (persistent memory & context)   │
└─────────┬────────────────────────┘
          │
          ▼
  ADE Internal Surface
  (mission, lane, agent, query)
          │
          ▼
  Result → MCP Response / UI Update
```

**Capabilities**:
- The CTO classifies incoming requests into intents: `create_mission`, `run_task`, `review_code`, `query_state`, `relay_chat`
- Routing decisions are informed by the CTO's persistent memory — it learns which request patterns map to which handlers over time
- Complex requests that span multiple surfaces are decomposed into sub-requests and coordinated by the CTO
- The CTO can proactively create work chats, missions, lanes, PR actions, file/context reads, and managed-process actions through stable ADE services without explicit renderer clicks
- It maintains awareness of active missions, lane states, chat sessions, worker outputs, and workflow runs
- UI navigation remains suggestion-only: tool results can include explicit ADE deeplinks like Work, Missions, Lanes, or CTO, but they do not silently switch tabs

**CTO Identity and System Prompt**: The CTO system prompt is now assembled as four explicit sections by `previewSystemPrompt()` in `ctoStateService.ts`:
- **Immutable ADE doctrine**: ADE-owned identity and operating rules for the persistent CTO project operator. This is not user-editable.
- **Personality overlay**: selected from presets or one custom personality field. This only changes the behavioral overlay.
- **Memory and continuity model**: explains the long-term CTO brief, current working context, durable searchable memory, and compaction behavior.
- **ADE operator capability manifest**: enumerates the stable ADE surfaces the CTO can operate internally and clarifies that UI navigation is returned as suggestions rather than implicit tab switches.

Project-specific summary, conventions, active focus, session continuity, subordinate activity, and today's daily log are carried by the memory/continuity layers rather than by the immutable doctrine.

**CTO Daily Logs**: The CTO state service supports append-only daily logs stored as markdown files under `.ade/cto/daily/<YYYY-MM-DD>.md`. The `appendDailyLog`, `readDailyLog`, and `listDailyLogs` methods manage these logs. Today's daily log is automatically included in the CTO continuity context, providing within-day continuity.

**Post-Compaction Identity Re-injection**: When a CTO or worker identity session undergoes SDK-level context compaction, the agent chat service detects the compaction event and calls `refreshReconstructionContext()` to re-inject the full identity context (persona, core memory, memory protocol, decision framework). This prevents identity loss after compaction.

**CTO State**: The CTO maintains its state in `.ade/cto/` (core memory files, daily logs), separate from unified memory tables in `.ade/ade.db`. This includes persistent project context, learned routing patterns, decision history, and user corrections. Both systems are visible in **Settings > Memory**. Over time, the CTO becomes more effective at anticipating project needs and dispatching work autonomously.

**Approval gate interaction** (M4/M5): When a mission phase has `requiresApproval: true`, the CTO is notified of pending `phase_approval` interventions through the same mission event stream it uses for general mission awareness. The CTO can surface these approval requests to the user in the CTO chat interface, providing context about the planning output and recommending whether to approve or request revisions. The CTO does not resolve approval gates autonomously — it always routes them to the human user for final decision.

**Retrospective patterns → CTO memory**: The reflection protocol that workers and the coordinator use during mission execution (via `reflection_add`) produces structured observations about friction points, reusable patterns, and improvement recommendations. These reflections are persisted as episodic memory entries. When the same pattern appears across multiple missions, the CTO's memory system promotes them into project-level procedural knowledge. This creates a feedback loop: the CTO learns from mission retrospectives and incorporates those lessons into future mission planning guidance, routing decisions, and proactive project recommendations.

**Use Cases**:
- Primary interface for project-level AI interactions via the CTO tab
- CI/CD pipelines invoking ADE missions via MCP
- External AI agents (Claude Code, Cursor, etc.) requesting ADE to perform work
- Slack/Discord bots routing developer requests to ADE
- Monitoring systems triggering automated review or testing
- Proactive project management: detecting issues, suggesting next steps, coordinating agents

### Cross-Machine Portability

ADE now ships a canonical `.ade` contract. The tracked/shareable subset lives alongside a tracked `.ade/.gitignore` that ignores machine-local runtime state.

**Tracked/shareable state**:
- `ade.yaml` — shared baseline config
- `cto/` — CTO identity/core-memory/session-log/daily-log files
- `agents/` — worker identity/core-memory/session-log files
- `templates/`, `context/`, `memory/`, `history/`, `reflections/`, `skills/`

**Machine-local state**:
- `local.yaml`, `local.secret.yaml`
- `ade.db`, `embeddings.db`
- `mcp.sock`
- `artifacts/`, `transcripts/`, `cache/`, `worktrees/`, `secrets/`

**Repair and integrity baseline**:
- startup repair creates the canonical tree, rewrites `.ade/.gitignore`, and removes stale `.git/info/exclude` rules for `.ade`
- legacy runtime folders are moved into `artifacts/`, `transcripts/`, `cache/`, and `secrets/`
- tracked JSONL files under `history/`, `cto/`, and `agents/` are normalized and hash-chained with `prevHash`

**Embedding behavior**: Embeddings are generated locally by `@huggingface/transformers` (`Xenova/all-MiniLM-L6-v2`, 384-dim) and stored in `unified_memory_embeddings` within `.ade/ade.db`. Hybrid retrieval (FTS4 BM25 + cosine similarity + MMR re-ranking) is the active search path. The background embedding worker backfills missing embeddings automatically from the DB-backed memory store.

**No cloud dependency**: ADE's local filesystem contract is git-friendly, but real-time multi-device sync is still Phase 6 work. The Phase 8 relay is for real-time remote control of a running ADE instance, not for state synchronization.

### Shipped Implementation Summary

Phases 1, 1.5, 2, 3, 4, and 5 are complete. The v1 closeout (2026-03-13) addressed remaining integration gaps. The sections below summarize the major shipped components across all phases.

**Orchestrator and mission runtime**:
- AI orchestrator service with mission lifecycle management, decomposed into modular architecture (core + 8 extracted modules)
- Orchestrator service decomposed (`orchestratorQueries.ts`, `stepPolicyResolver.ts` extracted)
- Built-in planning phase runtime (default-on profiles), clarification gating, and explicit coordinator phase transitions
- PR strategies (integration/per-lane/queue/manual) replacing merge phase
- Team synthesis and recovery loops
- Execution plan preview with approval gates
- Inter-agent messaging decomposed into `chatMessageService.ts` and `workerDeliveryService.ts`
- Mission chat workspace (`MissionChatV2`) with global summary, worker/orchestrator threads, mentions, and shared-renderer-backed detailed thread views
- Meta-reasoner with AI-driven fan-out dispatch (external_parallel, internal_parallel, hybrid)
- Context compaction engine (70% threshold, self-summarization, pre-compaction writeback)
- Session persistence via attempt_transcripts table and JSONL files
- Session resume via resumeUnified()
- Shared facts injection and run narrative generation
- Orchestrator Overhaul Phases 1-9 complete (reflection protocol, cross-mission trends, pattern-candidate promotion, adaptive runtime, UI overhaul)
- Coordinator finalization awareness: `check_finalization_status` tool + queue landing event routing
- Approval gates (`phase_approval` intervention type), mandatory planning enforcement, multi-round deliberation
- Adaptive runtime (`classifyTaskComplexity`, `scaleParallelismCap`, `evaluateModelDowngrade`)
- Budget-gated spawns (hard cap checks before every worker spawn)
- Benign error classification (`BENIGN_SANDBOX_BLOCK_PATTERNS` for ExitPlanMode/Zod noise)
- Phase 4 delegation contract: `delegate_parallel`, push sub-agent rollups, native teammate auto-registration + allocation caps

**Model and provider infrastructure**:
- Model registry unified: pricing fields in `ModelDescriptor`, `getModelPricing()`, `FAMILY_TO_CLI` map, `modelProfiles.ts` derived from registry
- Model registry expansion (50+ models across 10 provider families, auth-type classification, runtime enrichment via `enrichModelRegistry()`)
- Dynamic pricing via models.dev integration (`modelsDevService.ts`: fetch, 6h cache, fallback to hardcoded)
- Provider detection pipeline: `authDetector.ts` + `providerCredentialSources.ts` + `providerConnectionStatus.ts` + `providerRuntimeHealth.ts` + `claudeRuntimeProbe.ts` (structured per-provider connection status with auth, runtime, and usage availability)
- Provider options simplification (`providerOptions.ts`: pure tier-string passthrough, no invented token budgets)
- Reasoning tier standardization: Claude CLI low/medium/high, Claude API low/medium/high/max, Codex minimal/low/medium/high/xhigh
- UnifiedModelSelector redesign (auth-type grouping, hide unavailable models, "Configure more..." settings link)
- Universal tools for API-key and local models (`universalTools.ts`: permission modes plan/edit/full-auto)
- Workflow tools for chat agents (`workflowTools.ts`: lane creation, PR creation, screenshot capture, completion reporting, PR issue resolution tools)
- Three-tier tool architecture: universalTools (all agents) -> workflowTools (chat agents) -> coordinatorTools (orchestrator only)
- System prompt agent capability boundaries (tool tier guidance in agent prompts)
- Middleware layer (`middleware.ts`: logging, retry, cost guard, reasoning extraction)

**Memory and knowledge**:
- Unified memory system (W6): 3 scopes (project/agent/mission), 3 tiers (Tier 1 pinned / Tier 2 active / Tier 3 aging), candidate/promoted/archived lifecycle, auto-promotion, Settings > Memory tab
- Memory engine hardening (W6-half): lifecycle sweeps, batch consolidation, pre-compaction flush with quality criteria, Memory Health dashboard
- Embeddings pipeline (W7a): local Xenova/all-MiniLM-L6-v2, FTS4 BM25 + cosine similarity + MMR re-ranking
- Orchestrator memory wiring (W7b): mission-memory SSoT, exact employee L2 injection
- Skills and learning pipeline (W7c): episodic-to-procedural extraction, `.ade/skills/SKILL.md` materialization, skill ingestion from legacy sources, knowledge capture from failures/interventions/repeated errors/PR feedback, CTO memory review surfaces with provenance, confidence history, and re-index actions
- Memory tool wiring into agent coding tool set
- Memory pipeline fully wired: compaction flush into agentChatService, human work digest connected to git head watcher, failure knowledge capture on mission/agent errors, procedural learning export to `.ade/skills/`
- Embedding health monitoring with structured logging

**CTO and worker infrastructure** (Phase 4):
- CTO core identity (W1), worker org chart (W2), heartbeat and activation (W3)
- Bidirectional Linear sync (W4): `linearClient.ts`, `linearSyncService.ts`, `linearOutboundService.ts`, `linearRoutingService.ts`, `linearTemplateService.ts`, `linearCredentialService.ts`, `flowPolicyService.ts`, `linearCloseoutService.ts`, `linearDispatcherService.ts`, `linearIntakeService.ts`, `linearOAuthService.ts`, `linearWorkflowFileService.ts`, `issueTracker.ts` abstraction
- Linear dispatcher hardening (v1 closeout): snapshot refresh before step execution, employee fallback to `awaiting_delegation`, PR null-check for manual mode, closure notifications to agent chat sessions, dynamic delegation UI
- Automations platform (W5): `automationService.ts`, `automationPlannerService.ts`, `automationIngressService.ts`, `automationSecretService.ts`
- CTO + Org Experience Overhaul (W-UX): onboarding, activity, memory browser, and polish surfaces
- External MCP consumption (W8): ADE-managed external MCP registry/service, namespaced `ext.*` tool exposure
- OpenClaw bridge (W9)
- Portable `.ade/` state (W10): canonical tracked/shareable layout, startup repair, integrity normalization

**Mission UI and UX**:
- Mission phase engine + profiles: phase storage, profile CRUD/import/export, mission overrides, phase transition telemetry
- Mission UI overhaul: Plan/Work tabs, missions home dashboard, phase-aware details and launch/settings profile management
- Model selection per-mission with per-model thinking budgets
- Activity feed with category dropdown and run narrative
- missionId-filtered queries across all views

**Usage and budget**:
- Subscription usage tracking (`usageTrackingService.ts`): local CLI data analysis and cost scanning
- Budget cap service (`budgetCapService.ts`): mission and global budget enforcement
- Mission budget service with coordinator `get_budget_status`

**Codebase structure**:
- Orchestrator call types simplified from 6 to 2 (coordinator, chat_response)
- Type system modularized: `src/shared/types/` with 23 domain modules replacing monolithic `types.ts`
- Pack service decomposed: `projectPackBuilder.ts`, `missionPackBuilder.ts`, `conflictPackBuilder.ts`, `packUtils.ts` extracted
- Shared utilities consolidated: backend `utils.ts` (60+ duplicate removals), renderer `format.ts`/`shell.ts`/`sessions.ts`, shared React hooks

**Not yet shipped (v1 known limitations)**:
- Computer use runtime: The `localComputerUse.ts` capability detection module exists, screenshot capture is available as a workflow tool (depends on agent runtime support), and mission validation models screenshot/browser-verification/video evidence requirements, but the full `screenshot_environment` / `interact_gui` / `record_environment` MCP tool loop is not exposed end-to-end. Automatic PR proof embedding from computer-use artifacts is not shipped.
- Multi-device sync (cr-sqlite + WebSocket real-time replication) is Phase 6 work.
- Remote host deployment (user-owned VPS) is Phase 6 work.
- iOS companion app (core functionality) is Phase 6 work; advanced mobile features are Phase 7.
- Mission orchestration works end-to-end but complex multi-phase flows may benefit from human guidance via interventions.

### Compute Backends for Agent Execution

The older pluggable `ComputeBackend` abstraction is no longer part of the active ADE architecture. The current runtime model is:

- **Local host/runtime** (current baseline): agents execute as local subprocesses/worktree tasks on the active ADE machine.
- **User-owned VPS host** (planned Phase 6): ADE itself runs on a remote machine the user controls, and other devices connect to that host.
- **Dropped managed backend direction**: Daytona, E2B, and similar ADE-managed cloud backends are not part of the active roadmap.

### Compute Environment Types

ADE still distinguishes environment capabilities, but they are layered onto the runtime placement above rather than selected from a backend matrix:

```typescript
type ComputeEnvironmentType = 'terminal-only' | 'browser' | 'desktop';

interface ComputeEnvironment {
  type: ComputeEnvironmentType;
  display?: {                          // For browser and desktop environments
    width: number;                     // Default: 1920
    height: number;                    // Default: 1080
    colorDepth: number;                // Default: 24
  };
  browserConfig?: {                    // For browser environments
    headless: boolean;                 // Default: true
    browser: 'chromium' | 'firefox';   // Default: 'chromium'
  };
  desktopConfig?: {                    // For desktop environments
    windowManager: 'fluxbox' | 'xfce' | 'mutter';  // Default: 'fluxbox'
    vncEnabled: boolean;               // Enable VNC for remote viewing. Default: true
    vncPort: number;                   // Default: 5901
    noVncPort: number;                 // Default: 6080 (browser-based VNC client)
  };
}
```

**Terminal-only** (default): Agent gets a shell in a worktree/runtime sandbox. No GUI rendering. Suitable for code changes, test execution, and CLI operations.

**Browser**: Headless browser (Playwright/Puppeteer) available. Agent can launch web applications, navigate pages, interact with UI elements, and capture screenshots. Suitable for web application testing and visual verification.

**Desktop**: Full virtual desktop via Xvfb (X Virtual Framebuffer) + window manager. Agent gets programmatic mouse/keyboard control and screenshot/video capture. Suitable for desktop applications (Electron, native), mobile emulators, and GUI-heavy verification.

Implementation stack for desktop environments:
1. **Xvfb**: Virtual X11 display (e.g., `:99 -screen 0 1920x1080x24`)
2. **Window manager**: Fluxbox (lightweight) or Mutter (full-featured)
3. **VNC server**: x11vnc or TigerVNC for remote viewing
4. **noVNC + websockify**: Browser-based VNC client for web/mobile access
5. **xdotool**: Mouse/keyboard simulation for agent actions
6. **scrot/ImageMagick**: Screenshot capture
7. **ffmpeg**: Video recording via x11grab

Runtime capability notes:
| Runtime placement | terminal-only | browser | desktop |
|-------------------|:-------------:|:-------:|:-------:|
| Local host (current) | Yes | Yes (local Playwright) | Yes (local Xvfb) |
| User-owned VPS host (planned) | Planned | Planned | Planned |

### Per-Task-Type Configuration

ADE supports fine-grained control over which `modelId` handles each type of AI task.

#### Task Types

| Task Type | Description | Default Model ID |
|-----------|-------------|-----------------|
| `planning` | Mission decomposition into steps | `anthropic/claude-sonnet-4-6` |
| `implementation` | Code generation and modification | `openai/gpt-5.4-codex` |
| `review` | Code review and analysis | `anthropic/claude-sonnet-4-6` |
| `conflict_resolution` | Merge conflict analysis and resolution | `anthropic/claude-sonnet-4-6` |
| `narrative` | Lane narrative generation | `anthropic/claude-haiku-4-5` |
| `pr_description` | Pull request description drafting | `anthropic/claude-haiku-4-5` |

#### Configuration Schema

Per-task-type settings are stored in `.ade/local.yaml`:

```yaml
ai:
  # Per-task-type overrides
  taskRouting:
    planning:
      model: "anthropic/claude-sonnet-4-6"
      timeoutMs: 45000
    implementation:
      model: "openai/gpt-5.4-codex"
      timeoutMs: 120000
    review:
      model: "anthropic/claude-sonnet-4-6"
      timeoutMs: 30000
    conflict_resolution:
      model: "anthropic/claude-sonnet-4-6"
      timeoutMs: 60000
    narrative:
      model: "anthropic/claude-haiku-4-5"
      timeoutMs: 15000
      maxOutputTokens: 900
      temperature: 0.2
    pr_description:
      model: "anthropic/claude-haiku-4-5"
      timeoutMs: 15000
      maxOutputTokens: 1200
      temperature: 0.2
```

#### Resolution Order

When determining which model to use for a task:

1. Explicit per-call or per-step `modelId` hint (highest priority).
2. Per-task-type `taskRouting.<task>.model` setting in `.ade/local.yaml`.
3. Mission-level model policy/overrides.
4. Built-in default model for the task type (as listed in the table above).

If the resolved `modelId` is missing or unknown, runtime startup fails with an explicit error instead of silently substituting a provider/model fallback.

### One-Shot AI Task Patterns

Most Phase 1-style tasks still appear one-shot to users, but now run through ephemeral task-agent runtimes so memory/guardrails/audit stay consistent.

#### Pattern: Ephemeral Task-Agent Runtime

```typescript
// Narrative generation — one execution pass via an ephemeral task-agent runtime
async function generateNarrative(lanePack: LaneExportStandard): Promise<string> {
  const runtime = await agentRuntimeService.invoke({
    source: "narrative",
    executionClass: "task",
    agentDefinitionId: "ade.system.narrative",
    prompt: buildNarrativePrompt(lanePack),
    contextPack: lanePack,
    oneShot: true,
  });

  let result = "";
  for await (const event of runtime.events) {
    if (event.type === "structured_output") return event.data as string;
    if (event.type === "text") result += event.content;
  }
  return result;
}
```

#### One-Shot Tasks in Phase 1

| Task | Input | Output | Interaction |
|------|-------|--------|-------------|
| Narrative generation | `LaneExportStandard` | Markdown narrative | One-shot, no follow-up |
| Conflict proposals | `LaneExportLite` x 2 + `ConflictExportStandard` + user config | Resolution diff + explanation + confidence | One-shot, detailed context |
| PR descriptions | `LaneExportStandard` with commit history | PR title + body markdown | One-shot, no follow-up |
| Terminal summaries | Session transcript + metadata | Structured summary (intent, outcome, findings, next steps) | One-shot, no follow-up |
| Initial context generation | Repository scan results | PRD/architecture doc drafts | One-shot, no follow-up |
| Mission planning | Mission prompt + project context | Step plan JSON | Runtime-backed execution (planner may use multi-turn) |

These tasks can complete in one pass, but are still tracked as runtimes so they share the same policy and memory surface as missions.

#### CLI vs SDK Boundary

**SDK runtime path (programmatic, invisible to user)**: All non-interactive AI tasks listed above. The user never sees raw CLI output -- results are processed by ADE services and displayed in the appropriate UI surface.

**CLI (interactive, visible in Terminals tab)**: Only used when the user explicitly launches an AI terminal session from the Terminals tab or the Work Pane in the Lanes tab. The CLI runs in a PTY with full terminal interaction. This is the user's direct conversation with Claude/Codex, not ADE-orchestrated work.

This boundary is critical: SDK calls are ADE's internal tool; CLI sessions are the user's tool.

### Agent Chat Service (Phase 1.5)

The Agent Chat Service provides a native, interactive chat interface inside ADE — an alternative to using CLI terminals for working with Codex, Claude, and unified API/local model runtimes. It is a **provider-agnostic abstraction** that lets users chat with CLI or non-CLI models using the same UI.

> **External reference**: The Codex App Server protocol specification is at https://developers.openai.com/codex/app-server — this is the canonical reference for the CodexChatBackend implementation.

#### Why Agent Chat?

CLI terminals are powerful but opaque. The chat interface provides:

- **Structured item display**: File changes as inline diffs, command execution with live output, plans with step status — not raw terminal output.
- **Approval flow**: Accept/decline tool use with full context, not a yes/no prompt in a terminal.
- **Steering**: Inject instructions into an active turn without starting a new conversation.
- **Session persistence**: Resume conversations with full context, not just a command string.
- **Provider switching**: Same UI across providers/models. When switching model families mid-session, ADE forks a new chat session under the selected runtime/provider.

#### AgentChatService Interface

```typescript
interface AgentChatService {
  createSession(laneId: string, provider: "codex" | "claude" | "unified", model: string, modelId: string, opts?: CreateSessionOpts): Promise<ChatSession>;
  sendMessage(sessionId: string, text: string, attachments?: FileRef[]): AsyncIterable<ChatEvent>;
  steer(sessionId: string, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<ChatSession>;
  listSessions(laneId?: string): Promise<ChatSessionSummary[]>;
  approveToolUse(sessionId: string, itemId: string, decision: ApprovalDecision): Promise<void>;
  getAvailableModels(provider: "codex" | "claude" | "unified"): Promise<ModelInfo[]>;
  dispose(sessionId: string): Promise<void>;
}

interface ChatSession {
  id: string;
  laneId: string;
  provider: "codex" | "claude" | "unified";
  model: string;              // Human-readable display name
  modelId: string;            // Registry model ID (required)
  // Provider-native permission controls (no unified permissionMode)
  claudePermissionMode?: "default" | "plan" | "acceptEdits" | "bypassPermissions";
  codexApprovalPolicy?: "untrusted" | "on-request" | "on-failure" | "never";
  codexSandbox?: "read-only" | "workspace-write" | "danger-full-access";
  codexConfigSource?: "flags" | "config-toml";
  unifiedPermissionMode?: "plan" | "edit" | "full-auto";
  status: "active" | "idle" | "ended";
  threadId?: string;           // Codex: app-server thread ID
  createdAt: string;
  lastActivityAt: string;
}

type ChatEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; tool: string; args: unknown; itemId: string }
  | { type: "tool_result"; tool: string; result: unknown }
  | { type: "file_change"; path: string; diff: string; kind: "create" | "modify" | "delete" }
  | { type: "command"; cmd: string; cwd: string; output: string; exitCode?: number; status: "running" | "completed" | "failed" }
  | { type: "plan"; steps: Array<{ text: string; status: "pending" | "in_progress" | "completed" | "failed" }> }
  | { type: "reasoning"; summary: string; isCollapsed: boolean }
  | { type: "approval_request"; itemId: string; kind: "command" | "file_change"; description: string; detail: unknown }
  | { type: "system_notice"; noticeKind: "auth" | "rate_limit" | "hook" | "file_persist" | "info" | "memory" | "provider_health" | "thread_error"; message: string; detail?: string | AgentChatNoticeDetail }
  | { type: "status"; turnStatus: "started" | "completed" | "interrupted" | "failed"; error?: string }
  | { type: "error"; message: string; errorInfo?: string }
  | { type: "done"; turnId: string };

type ApprovalDecision = "accept" | "accept_for_session" | "decline" | "cancel";

interface FileRef {
  path: string;
  type: "file" | "image";
}

interface ModelInfo {
  id: string;
  displayName: string;
  isDefault: boolean;
  reasoningEfforts?: Array<{ effort: string; description: string }>;
}
```

#### CodexChatBackend

The Codex backend uses the **Codex App Server** — a JSON-RPC 2.0 protocol designed for building custom Codex frontends. ADE spawns `codex app-server` as a child process and communicates via JSONL over stdin/stdout.

> **Protocol reference**: https://developers.openai.com/codex/app-server
> **Schema generation**: `codex app-server generate-ts --out ./schemas` produces TypeScript types matching the installed Codex version.

**Process lifecycle**:

```typescript
import { spawn } from "node:child_process";
import readline from "node:readline";

// Spawn app-server as child process
const proc = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "inherit"],  // stdin: pipe, stdout: pipe, stderr: inherit
});

// JSONL reader
const rl = readline.createInterface({ input: proc.stdout });

// Send JSON-RPC messages
const send = (msg: object) => proc.stdin.write(JSON.stringify(msg) + "\n");

// Initialize handshake (required before any other messages)
send({ method: "initialize", id: 0, params: {
  clientInfo: { name: "ade", title: "ADE", version: ADE_VERSION },
  capabilities: { experimentalApi: true }
}});
send({ method: "initialized", params: {} });
```

**Protocol mapping to AgentChatService**:

| AgentChatService method | Codex App Server JSON-RPC | Notes |
|---|---|---|
| `createSession()` | `thread/start` | Params: `model`, `cwd` (lane worktree), `approvalPolicy`, `sandbox` |
| `sendMessage()` | `turn/start` | Input array: `[{ type: "text", text }, ...attachments]` |
| `steer()` | `turn/steer` | Appends to in-flight turn; cannot change model/sandbox |
| `interrupt()` | `turn/interrupt` | Turn completes with `status: "interrupted"` |
| `resumeSession()` | `thread/resume` | Params: `threadId`, optional `personality` |
| `listSessions()` | `thread/list` | Filter by `cwd` to scope to lane |
| `approveToolUse()` | Response to `requestApproval` | Payload: `accept`/`acceptForSession`/`decline`/`cancel` |
| `getAvailableModels()` | `model/list` | Returns models with `displayName`, `isDefault`, `reasoningEffort` |
| `dispose()` | Process cleanup | Close stdin, terminate child process |

**Notification → ChatEvent mapping**:

| Codex Notification | ChatEvent Type | Notes |
|---|---|---|
| `item/agentMessage/delta` | `text` | Append delta to current message |
| `item/started` (commandExecution) | `command` | Start tracking command output |
| `item/commandExecution/outputDelta` | `command` | Append to command output |
| `item/completed` (commandExecution) | `command` | Set exit code and status |
| `item/started` (fileChange) | `file_change` | File path, kind, diff |
| `item/commandExecution/requestApproval` | `approval_request` | Kind: "command" |
| `item/fileChange/requestApproval` | `approval_request` | Kind: "file_change" |
| `turn/plan/updated` | `plan` | Steps with status |
| `item/reasoning/summaryTextDelta` | `reasoning` | Append to summary |
| `turn/started` | `status` | `turnStatus: "started"` |
| `turn/completed` | `done` or `status` | Map `status` field |

**Sandbox policies** (configurable per session):

| Policy | JSON-RPC Value | Description |
|---|---|---|
| Read-only | `{ type: "readOnly" }` | Agent can read but not modify files |
| Workspace write | `{ type: "workspaceWrite", writableRoots: [cwd] }` | Agent can write within lane worktree |
| Full access | `{ type: "externalSandbox" }` | No restrictions |

**Error handling**: Codex errors include `codexErrorInfo` values (`ContextWindowExceeded`, `UsageLimitExceeded`, `HttpConnectionFailed`, etc.) which are mapped to user-facing messages in the chat UI.

#### ClaudeChatBackend

The Claude backend uses `ai-sdk-provider-claude-code` (the same community Vercel provider from Phase 1) in **multi-turn mode**. Instead of one-shot `execute()` calls, the Claude backend maintains a `messages[]` array and calls `streamText()` for each turn.

**Multi-turn conversation flow**:

```typescript
import { streamText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";

// Session state (maintained per chat session)
const messages: CoreMessage[] = [];

// Each turn appends a user message and streams the response
async function* sendMessage(text: string): AsyncIterable<ChatEvent> {
  messages.push({ role: "user", content: text });

  const stream = streamText({
    model: claudeCode("sonnet", {
      claudePermissionMode: "acceptEdits",
      maxBudgetUsd: 5.0,
      systemPrompt: "You are working in an ADE lane...",
      canUseTool: async (invocation) => {
        // Emit approval_request ChatEvent
        // Wait for user decision
        // Return allow/deny
      },
    }),
    messages,
  });

  for await (const chunk of stream) {
    if (chunk.type === "text-delta") {
      yield { type: "text", content: chunk.textDelta };
    }
    // Map other chunk types to ChatEvent...
  }

  // Append assistant response to messages for context continuity
  messages.push({ role: "assistant", content: stream.text });
}
```

**Key differences from CodexChatBackend**:

| Capability | Codex (App Server) | Claude (Community Provider) |
|---|---|---|
| Protocol | JSON-RPC 2.0 over stdio | Vercel AI SDK `streamText()` |
| Multi-turn | Native thread management | ADE manages `messages[]` |
| Steering | `turn/steer` (native) | Queue text, inject on next turn |
| Approval flow | `requestApproval` notifications | `canUseTool` callback |
| File changes | `fileChange` items with diffs | Tool call events (Write, Edit) |
| Command execution | `commandExecution` items with live output | Tool call events (Bash) |
| Plans | `turn/plan/updated` | Not natively supported |
| Reasoning | `reasoning` items | Not exposed by community provider |
| Session persistence | App server manages on disk | ADE persists `messages[]` to JSON |
| Resume | `thread/resume` (native) | Reload `messages[]` and continue |

**Session persistence**: Chat session metadata is stored at `.ade/cache/chat-sessions/<sessionId>.json`, and structured chat events are logged to `.ade/transcripts/<session-id>.chat.jsonl` with a mirrored JSONL copy under `.ade/transcripts/chat/<session-id>.jsonl`. This enables resume after app restart while keeping chat-specific runtime files in the canonical W10 layout.

**Image attachments**: Claude V2 sessions now support inline image content blocks. The `buildClaudeV2Message()` helper checks attached files against the Anthropic-accepted MIME types (`image/jpeg`, `image/png`, `image/gif`, `image/webp`), reads them as base64, and builds an `SDKUserMessage` with interleaved text and image content blocks. When no image attachments are present, the message is sent as a plain string. Images are saved to a temporary location via the `saveTempAttachment` IPC handler before being read by the service.

**Limitations**: The Claude backend may not support all UI features that Codex provides (plans, reasoning blocks). The chat UI gracefully handles missing features — items that Claude doesn't produce simply don't appear in the UI.

#### Phase 2 Chat Improvements

Phase 2 completed the outstanding chat debt from Phase 1.5:

- **UI polish shipped**: The Work Pane chat surface (`AgentChatMessageList.tsx`, `AgentChatComposer.tsx`, `AgentChatPane.tsx`) now uses richer bubble styling, inline diff emphasis, cleaner command blocks, improved streaming indicators, and clearer approval presentation.
- **Claude provider selection fixed**: Provider selection no longer resets unexpectedly; Claude and Codex remain selectable based on detected model availability.
- **Reasoning effort selector shipped**: Codex reasoning effort (`minimal`, `low`, `medium`, `high`, `xhigh`) is surfaced in the composer and passed to both `thread/start` and `turn/start`. Last-used effort is persisted per lane/model. Claude model variants are shown with descriptive labels from `supportedModels()`.

#### Chat Session Lifecycle

Agent chat sessions integrate into ADE's existing session tracking infrastructure:

```
1. User opens Chat view in Work Pane
   → agentChatService.createSession(laneId, provider, model)
   → Creates terminal_sessions row (tool_type: "codex-chat", "claude-chat", or "ai-chat")
   → Codex: spawns app-server + thread/start
   → Claude: initializes messages[] + session state
   → Unified: resolves configured API/local model via provider resolver + initializes universal tool runtime
   → Captures head_sha_start

2. User sends messages, agent works
   → agentChatService.sendMessage() yields ChatEvent stream
   → Events rendered in AgentChatMessageList
   → Chat events logged to `.ade/transcripts/<session-id>.chat.jsonl` and mirrored to `.ade/transcripts/chat/<session-id>.jsonl`
   → File changes update the lane worktree (visible in git actions)

3. Approvals
   → ChatEvent.approval_request rendered as overlay
   → User decision sent back via agentChatService.approveToolUse()

4. Session end (user closes chat or navigates away)
   → agentChatService.dispose()
   → Codex: thread remains on disk (can resume)
   → Claude: messages[] persisted to JSON (can resume)
   → Captures head_sha_end
   → Session delta computed (same as terminal sessions)
   → onSessionEnded callback fires → job engine, pack refresh, agents

5. Resume
   → User clicks resume in Terminals tab or reopens Chat view
   → agentChatService.resumeSession()
   → Codex: thread/resume with stored threadId
   → Claude: reload messages[] from JSON
   → Unified: re-resolve model + reload persisted message history + permission mode
```

This lifecycle mirrors the PTY session lifecycle exactly, ensuring that chat sessions produce the same context artifacts (deltas, memory updates, checkpoints) as terminal sessions.

---

## Integration Points

### Desktop Application

- **AI integration service**: `apps/desktop/src/main/services/ai/aiIntegrationService.ts` -- provider detection, task routing, executor dispatch via `AgentExecutor`, streaming response handling.
- **Orchestrator service**: `apps/desktop/src/main/services/orchestrator/orchestratorService.ts` (~11K lines) + `orchestratorQueries.ts`, `stepPolicyResolver.ts` -- run/step/attempt state machine, claim management, context snapshots, gate reports.
- **AI orchestrator service**: `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.ts` (~9.9K lines) + 8 extracted modules (`chatMessageService.ts`, `workerDeliveryService.ts`, `workerTracking.ts`, `missionLifecycle.ts`, `recoveryService.ts`, `modelConfigResolver.ts`, `orchestratorContext.ts`, `orchestratorConstants.ts`) -- AI coordination layer: autopilot, worker management, messaging, recovery.
- **Agent chat service**: `apps/desktop/src/main/services/chat/agentChatService.ts` -- manages chat session lifecycle, spawns Codex app-server processes and Claude multi-turn sessions, maps provider events to ChatEvent streams, integrates with session tracking.
- **Unified memory service**: `apps/desktop/src/main/services/memory/memoryService.ts` -- memory retrieval, candidate/promoted lifecycle, and budgeted context assembly.
- **Bounded memory budgets**: `memoryGetBudget` (`lite`/`standard`/`deep`) controls AI context size in runtime prompt assembly.
- **Model system**: `apps/desktop/src/shared/modelRegistry.ts` (pricing-aware descriptors, `FAMILY_TO_CLI` map) + `modelProfiles.ts` (derived from registry).
- **Shared types**: `apps/desktop/src/shared/types/` -- 23 domain-scoped type modules (core, lanes, conflicts, prs, git, files, sessions, chat, missions, orchestrator, config, automations, packs, budget, models, usage) with barrel `index.ts`.
- **Configuration**: Provider settings read from `projectConfigService.ts` (merged shared + local config).
- **IPC channels**: `ade.ai.*` for AI streaming, `ade.missions.*` for mission lifecycle, `ade.orchestrator.*` for run management.

### Job Engine

The job engine handles background AI tasks that are triggered by system events:

- **Auto-narrative generation**: After lane/session context updates, the job engine optionally triggers narrative generation via the AI integration service if a CLI subscription is available. This is a non-blocking async flow that does not interfere with the user's interactive workflow.
- **Conflict proposal generation**: When conflict prediction detects new or changed conflicts, the job engine can trigger AI-powered conflict resolution proposals.

The job engine does **not** coordinate orchestrator step transitions. The orchestrator service has its own tick-based scheduler for mission execution.

### Mission Service

The mission service (`missionService.ts`) provides the user-facing lifecycle for AI-driven work:

- **Mission creation**: Accepts a plain-English prompt, title, lane assignment, phase profile/override, and execution policy.
- **Phase selection**: Resolves selected phases per mission/profile; built-ins include planning first by default.
- **Step tracking**: Tracks mission steps and interventions while run-time orchestration remains coordinator-owned.
- **Phase pipeline contracts (Task 3)**: Resolves mission phase profile/override, persists phase configuration, and annotates mission steps with phase identity metadata.
- **Phase transition audit (Task 3)**: Runtime phase changes emit durable `phase_transition` mission/timeline events and update run metadata (`phaseRuntime`) for operator inspection.
- **Profile lifecycle APIs (Task 3)**: list/save/delete/clone/import/export/getPhaseConfiguration/getDashboard contracts are exposed to renderer and automation surfaces.
- **Intervention management**: Creates, resolves, and dismisses intervention records when AI agents or the orchestrator need human input.
- **Artifact collection**: Links mission outcomes (PR URLs, generated files, test results) as artifacts.

### Memory Service

W6 is complete with unified memory as the primary AI context backbone in renderer/main flows. Pack-first renderer surfaces have been cut over to memory-first equivalents, and the remaining pack-shaped APIs are compatibility veneers over live exports rather than runtime prerequisites.

- **Budgeted retrieval**: `lite` / `standard` / `deep` memory budgets bound context size for each AI task type.
- **Candidate workflow**: Discoveries enter as candidates and can be promoted or archived via memory APIs.
- **Promoted retrieval**: Prompt assembly consumes promoted entries by ranking and budget.
- **Auditability**: Entries preserve confidence, recency, and access metadata for deterministic ranking.
- **Compatibility inventory**: Remaining pack internals are kept only where they still provide explicit compatibility or audit value.

### Skills + Learning Pipeline

> **Replaces**: The earlier "Learning Packs" concept (separate pack type with `LearningEntry` schema). Now unified into W7 as procedural memory extraction on top of W6's unified memory. See `docs/final-plan/phase-4.md` W7 for full spec.

W7 builds an extraction and materialization layer on top of the Unified Memory System (W6). It turns accumulated mission experience into reusable skills that any agent (Claude, Codex, or any future adapter) can consume.

**Procedural extraction**: When the same pattern appears across 3+ episodic summaries (from different missions/sessions), the system extracts it as a `ProceduralMemory` entry (trigger, procedure, confidence, success/failure counts). Stored in project memory with `category: "procedure"`.

**Knowledge sources** (automatic capture into project memory, feeding the episodic → procedural pipeline):
- Mission failures and resolutions (captured as gotcha/pattern entries)
- User interventions during missions (inferred as candidate conventions)
- Repeated errors across 3+ sessions (recorded as gotcha patterns with file scope)
- PR review feedback patterns

**Skill materialization**: Confirmed procedural memories are exported as `.ade/skills/<name>/SKILL.md` — universal markdown format consumable by any agent. Skills are also indexed back into project memory.

**Skill ingestion**: On startup/file change, ADE scans `.ade/skills/` plus legacy external sources (`.claude/skills/`, `.claude/commands/`, `CLAUDE.md`, `agents.md`) and indexes them into project memory as Tier 2 procedure entries.

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Architecture design | Complete | Documented in this file |
| Planning phase (coordinator-owned) | Complete | Built-in `planning` phase is default-on and transitions via `set_current_phase` |
| Coordinator-strategy deterministic fallback (runtime) | Removed | Coordinator owns strategy; unavailable coordinator pauses/escalates instead of deterministic replacement |
| Orchestrator state machine | Complete | `orchestratorService.ts` (~11K lines) + `orchestratorQueries.ts`, `stepPolicyResolver.ts` -- runs, steps, attempts, claims, gates, timeline |
| Executor adapter interface | Complete | `OrchestratorExecutorAdapter` type for pluggable step execution |
| Context snapshot system | Complete | Profile-based export assembly (deterministic, narrative-opt-in) |
| Bounded memory budgets | Complete | Lite/Standard/Deep retrieval tiers via memory APIs |
| AgentExecutor interface | Complete | `apps/desktop/src/main/services/ai/agentExecutor.ts` |
| Agent SDK integration (dual-SDK) | Complete | Unified executor runtime (formerly `ClaudeExecutor` + `CodexExecutor`) |
| AI integration service | Complete | `apps/desktop/src/main/services/ai/aiIntegrationService.ts` |
| Per-task-type configuration | Complete | Configurable in `.ade/local.yaml` |
| Streaming AI responses to UI | Complete | IPC push events via `webContents.send` |
| AgentChatService interface | Complete | `apps/desktop/src/main/services/chat/agentChatService.ts` |
| CodexChatBackend (App Server) | Complete | JSON-RPC 2.0 client in `agentChatService.ts` |
| ClaudeChatBackend (community provider) | Complete | Multi-turn `streamText()` in `agentChatService.ts` |
| Chat UI components | Complete | AgentChatPane, AgentChatMessageList, AgentChatComposer |
| Chat session integration | Complete | `codex-chat`, `claude-chat`, and `ai-chat` tool types in `terminal_sessions` |
| MCP server (`apps/mcp-server`) | Complete | JSON-RPC 2.0 server with 35 tools, dual-mode architecture (headless + embedded) |
| MCP dual-mode architecture | Complete | Transport abstraction (stdio/socket), headless AI via aiIntegrationService, desktop socket embedding (.ade/mcp.sock), smart entry point auto-detection. Centralized launch resolution (`adeMcpLaunch.ts`) with bundled proxy mode for packaged builds. |
| AI orchestrator (Claude + MCP) | Complete | Tasks 1-7 shipped; Orchestrator Overhaul Phases 1-9 complete (reflection protocol, adaptive runtime, UI overhaul). V1 closeout: coordinator finalization awareness. M4/M5 additions: approval gates, mandatory planning enforcement, multi-round deliberation, adaptive runtime, model downgrade, budget-gated spawns, benign error classification. |
| Phase 4 orchestrator delegation/team runtime | Complete | `delegate_parallel`, push sub-agent progress/completion rollups, native teammate auto-registration + allocation cap guardrails, single team-member data path |
| Adaptive Runtime (M5) | Complete | `adaptiveRuntime.ts` — `classifyTaskComplexity`, `scaleParallelismCap`, `evaluateModelDowngrade`; budget hard cap enforcement in coordinator tools |
| Approval Gates (M4/M5) | Complete | `phase_approval` intervention type, `requiresApproval` on PhaseCard, blocking phase transitions until user approval |
| Mandatory Planning Enforcement (M4/M5) | Complete | `CoordinatorAgent` constructor injects planning phase if missing; first-turn planning watchdog force-spawns planner |
| Multi-Round Deliberation (M4/M5) | Complete | `canLoop`/`loopTarget` on PhaseCardOrderingConstraints, `maxQuestions` bounds per phase |
| Error Classification Hardening (M4/M5) | Complete | `BENIGN_SANDBOX_BLOCK_PATTERNS` for ExitPlanMode/Zod errors, `classifyBlockingWarnings` in `orchestratorQueries.ts` |
| Mission phase engine + profiles (Task 3) | Complete | `phase_cards`/`phase_profiles`/`mission_phase_overrides`, profile CRUD/import/export, phase transition telemetry |
| Mission UI overhaul (Task 4) | Complete | Plan/Work tabs, mission home dashboard, phase-aware details, launch/settings profile workflows |
| Pre-flight + intervention/HITL (Task 5) | Complete | Launch-gate checklist, granular worker-level interventions, coordinator `ask_user`/`request_user_input` escalation wiring |
| Budget + usage tracking (Task 6) | Complete | Mission budget service, subscription/API-key accounting, coordinator `get_budget_status`, details-tab budget telemetry |
| Model registry (50+ models, runtime enrichment) | Complete | `modelRegistry.ts` -- 10 provider families, auth-type classification, pricing in `ModelDescriptor`, `getModelPricing()`, `FAMILY_TO_CLI` map, `enrichModelRegistry()` for models.dev data, `resolveModelDescriptorForProvider()`, `getRuntimeModelRefForDescriptor()`. `modelProfiles.ts` derived from registry. |
| Dynamic pricing (models.dev) | Complete | `modelsDevService.ts` -- fetch/cache/fallback, 6h refresh, Proxy-based `MODEL_PRICING` |
| Provider options (tier passthrough) | Complete | `providerOptions.ts` -- pure tier-string passthrough per provider family, no arbitrary token budgets |
| Middleware layer | Complete | `middleware.ts` -- logging, retry, cost guard, reasoning extraction |
| Universal tools (API-key/local) | Complete | `universalTools.ts` -- permission modes (plan/edit/full-auto), approval hooks |
| Type system modularization | Complete | `src/shared/types/` -- 23 domain modules replacing monolithic `types.ts` |
| Pack service decomposition | Complete | `packService.ts` + `projectPackBuilder.ts`, `missionPackBuilder.ts`, `conflictPackBuilder.ts`, `packUtils.ts` |
| Shared utilities consolidation | Complete | Backend `utils.ts` (60+ duplicates removed), renderer `format.ts`/`shell.ts`/`sessions.ts`, shared React hooks (`useClickOutside`, `useThreadEventRefresh`) |
| Agent-first runtime baseline | Complete | Non-interactive AI call paths execute on runtime records with no legacy compatibility migration path |
| Call audit logging | Complete | Every MCP tool invocation writes durable `mcp_tool_call` history records |
| Permission/policy layer | Complete | Mutation tools enforce claim/identity policy; spawn and ask_user guards applied |
| Chat reasoning effort (Claude) | Complete | Reasoning effort forwarded to Claude provider when supported; validated for Codex |
| Local runtime placement | Complete | Agents run on local runtime records/worktrees on the active ADE machine |
| Remote host deployment | Planned | Phase 6 -- user-owned VPS host + device routing |
| Managed cloud compute backends (Daytona/E2B) | Dropped | Not on active roadmap |
| Compute environment types | Partially implemented | terminal-only is active; browser and desktop environment types are defined but the full runtime loop is not shipped |
| Computer use MCP tools | Partially implemented | Capability detection exists (`localComputerUse.ts`); mission validation models evidence requirements; full MCP tool loop (`screenshot_environment`, `interact_gui`, `record_environment`, `launch_app`, `get_environment_info`) and automatic PR proof embedding are not shipped end-to-end |
| Unified Memory System (W6) | Complete | Unified memory retrieval and renderer cutover are active |
| Memory Engine Hardening (W6½) — lifecycle sweeps, batch consolidation, pre-compaction flush | Complete | Temporal decay, tier demotion, hard limits, orphan cleanup, Jaccard+LLM consolidation, pre-compaction flush, Memory Health dashboard |
| Embeddings Pipeline (W7a) — local embedding + hybrid retrieval | Complete | Local Xenova/all-MiniLM-L6-v2 via @huggingface/transformers, FTS4 BM25 + cosine similarity + MMR re-ranking, graceful lexical fallback |
| Orchestrator Memory Wiring (W7b) — mission-memory SSoT + exact employee L2 injection | Complete | Retired `orchestrator_shared_facts`, compaction writes back to mission memory, worker briefings derive shared team knowledge from mission memory, exact `employeeAgentId` launch metadata controls agent-memory injection |
| Skills + Learning Pipeline (W7) — procedural extraction + skill materialization | Complete | Phase 4 — episodic-to-procedural extraction, `.ade/skills/SKILL.md` materialization, skill ingestion from legacy sources, and knowledge capture from failures/interventions/repeated errors/PR feedback are shipped (`knowledgeCaptureService.ts`, `proceduralLearningService.ts`, `skillRegistryService.ts`) |
| CTO Agent — core identity, persistent chat, core memory (W1) | Complete | Phase 4 -- `ctoStateService.ts`, dual-canonical persistence (DB + file), session reconstruction, CtoPage with chat |
| Worker Agents — org chart, multi-adapter, config versioning, budget (W2) | Complete | Phase 4 -- `workerAgentService.ts`, `workerRevisionService.ts`, `workerBudgetService.ts`, `workerTaskSessionService.ts`, `workerAdapterRuntimeService.ts` |
| Heartbeat & Activation — timer pool, coalescing, orphan reaping (W3) | Complete | Phase 4 -- `workerHeartbeatService.ts` (789 lines), two-tier execution, deferred promotion, issue locking |
| Bidirectional Linear Sync (W4) | Complete | Phase 4 -- `linearClient.ts`, `linearSyncService.ts`, `linearOutboundService.ts`, `linearRoutingService.ts`, `linearTemplateService.ts`, `linearCredentialService.ts`, `flowPolicyService.ts`, `linearCloseoutService.ts`, `linearDispatcherService.ts`, `linearIntakeService.ts`, `linearOAuthService.ts`, `linearWorkflowFileService.ts`, `issueTracker.ts` abstraction, `LinearSyncPanel.tsx` UI with 6-step flow composer |
| External MCP consumption | Complete | Phase 4 -- ADE-managed external MCP registry/service, namespaced `ext.*` tool exposure through ADE MCP, mission/worker/CTO policy integration |
| `.ade/` portable state | Complete | Phase 4 -- canonical tracked/shareable layout, startup repair, integrity normalization, config reload, Settings > Project health surface |
| Task agents (lane artifacts) | Planned | Phase 4 -- specialized agents for artifact production within lanes |
| Chat-to-mission escalation | Planned | Phase 4 -- promote a chat conversation into a full mission with pre-filled context |

**Overall status**: Phases 1, 1.5, 2, 3, 4, and 5 are complete. All Phase 4 workstreams (W1-W10, W-UX, W6-half, W7a-c) are shipped at baseline or better. The remaining unshipped work is concentrated in computer-use runtime follow-through (the MCP tool loop for `screenshot_environment`/`interact_gui`/`record_environment` and automatic PR proof embedding) and future-phase items (multi-device sync, remote host deployment, iOS companion). MCP dual-mode architecture is shipped, enabling headless operation with full AI via `aiIntegrationService` and embedded proxy mode through the desktop socket at `.ade/mcp.sock`. Packaged macOS builds use a bundled MCP proxy (`adeMcpProxy.cjs`) that connects to the desktop socket, with a runtime smoke test (`packagedRuntimeSmoke.ts`) that validates PTY, Claude SDK, and MCP proxy availability at build time.

---

## MCP Server as External Orchestration API

The MCP server (`apps/mcp-server`) has been overhauled from a 16-tool agent interface into a full **headless orchestration API** with 35 tools. This enables external consumers -- Claude Code, CI/CD pipelines, evaluation harnesses, and custom scripts -- to create, drive, observe, and evaluate missions without the desktop UI.

**Important architectural distinction**: The MCP server is the external/headless ADE tool surface and the common ADE tool bridge for spawned workers. The coordinator runtime itself is phase-aware and provider-routed; regardless of provider, it is constrained to the ADE coordinator tool surface rather than unconstrained repo exploration. The MCP server is the external-facing tool surface for:

1. **Spawned worker agents** -- agents launched by the orchestrator that need to interact with ADE's lane, git, and context systems.
2. **External observers** -- tools like Claude Code that want to monitor mission progress without participating.
3. **Evaluators** -- automated or human evaluation workflows that score completed mission runs.

### Tool Categories (35 Total)

#### Existing Tools (16)

| Tool | Description |
|------|-------------|
| `spawn_agent` | Launch a new AI agent in a specified lane |
| `read_context` | Read pack exports, lane state, or project context |
| `create_lane` | Create a new lane with a worktree for agent work |
| `check_conflicts` | Run conflict prediction against other active lanes |
| `merge_lane` | Merge a lane back to its parent |
| `ask_user` | Route an intervention to the ADE UI for human input |
| `run_tests` | Execute test suites in a lane's worktree |
| `get_lane_status` | Get current status of a specific lane |
| `list_lanes` | List all active lanes with summary status |
| `commit_changes` | Stage and commit changes in a lane |
| `get_project_info` | Get project metadata and configuration |
| `list_files` | List files in a lane or project directory |
| `read_file` | Read file contents |
| `write_file` | Write file contents |
| `search_code` | Search code across the project |
| `get_git_log` | Get git log for a lane or branch |

#### Mission Lifecycle Tools (7)

| Tool | Description |
|------|-------------|
| `create_mission` | Create a new mission from a prompt |
| `start_mission` | Start planning and execution of a mission |
| `pause_mission` | Pause a running mission |
| `resume_mission` | Resume a paused mission |
| `cancel_mission` | Cancel a mission |
| `steer_mission` | Send a steering message to adjust mission direction |
| `resolve_intervention` | Resolve a pending intervention |

#### Observation Tools (8)

| Tool | Description |
|------|-------------|
| `get_mission` | Get full mission state including steps, artifacts, and interventions |
| `get_run_graph` | Get the DAG visualization data for a mission run |
| `stream_events` | Poll for new mission/orchestrator events since a cursor |
| `get_step_output` | Get the output/transcript of a specific step attempt |
| `get_worker_states` | Get current state of all worker agents in a mission |
| `get_timeline` | Get the full timeline of events for a mission run |
| `get_mission_metrics` | Get usage metrics (tokens, cost, duration) for a mission |
| `get_final_diff` | Get the combined diff of all changes made during a mission |

#### Evaluation Tools (3)

| Tool | Description |
|------|-------------|
| `evaluate_run` | Score a completed mission run with structured evaluation criteria |
| `list_evaluations` | List all evaluations for a mission |
| `get_evaluation_report` | Get a detailed evaluation report with scores and commentary |

---

## Evaluator Workflow

The MCP server supports a complete **create, start, stream, evaluate** loop for automated mission evaluation. This enables external tools (Claude Code, CI pipelines, test harnesses) to drive missions end-to-end and score the results.

### Workflow Steps

1. **Connect as evaluator role**: Connect to the MCP server via stdio. The connecting process acts as an external observer.

2. **Create mission**: Use `create_mission` with a prompt describing the desired work.
   ```
   create_mission({ prompt: "Implement rate limiting middleware for the API", title: "Rate Limiter" })
   ```

3. **Start mission**: Trigger planning and execution.
   ```
   start_mission({ missionId: "<id>" })
   ```

4. **Poll for progress**: Use `stream_events` with a cursor to receive incremental updates.
   ```
   stream_events({ missionId: "<id>", cursor: 0 })
   ```
   Returns events like `step_started`, `step_completed`, `agent_spawned`, `worker_status_reported`, `intervention_requested`, etc. The cursor advances with each poll.

5. **Inspect with observation tools**: Use `get_worker_states`, `get_step_output`, `get_timeline`, and `get_mission_metrics` to inspect mission state at any point.

6. **Evaluate the run**: After the mission completes (or fails), use `evaluate_run` to score the result.
   ```
   evaluate_run({
     missionId: "<id>",
     scores: { correctness: 0.9, completeness: 0.8, code_quality: 0.85 },
     commentary: "Rate limiter implementation is correct but missing Redis backend support.",
     verdict: "pass"
   })
   ```

7. **Retrieve evaluation reports**: Use `get_evaluation_report` for detailed scoring breakdowns.

---

## Claude Code Integration

The MCP server can be used directly from Claude Code as an MCP tool provider, enabling Claude Code to create and manage ADE missions conversationally.

### MCP Configuration

Add to your Claude Code MCP configuration (`~/.claude/mcp.json` or project-level):

```json
{
  "mcpServers": {
    "ade": {
      "command": "npx",
      "args": [
        "tsx",
        "/path/to/ADE/apps/mcp-server/src/index.ts",
        "--project-root", "/path/to/target-repo"
      ]
    }
  }
}
```

### Launch

```bash
claude --permission-mode plan
```

Use a permission mode that matches the ADE workflow you are exposing. Read-only observation and planning flows can stay in `plan`; mutating ADE tool workflows may require a less restrictive mode depending on the exact ADE tool surface you enable.

### Usage

Once configured, Claude Code can use ADE tools naturally:

- "Create a mission to refactor the authentication module"
- "Show me the current mission status"
- "What are the worker agents doing?"
- "Evaluate the last mission run"

Claude Code will invoke the appropriate MCP tools (`create_mission`, `get_mission`, `get_worker_states`, `evaluate_run`) based on the conversational context.

---

## Known Limitations

### 1. ~~No AI Planning in MCP Mode~~ (Resolved — Dual-Mode Architecture)

The MCP server now operates in **dual mode**:

- **Headless mode** (stdio transport): The MCP server runs standalone with full AI capabilities. `aiIntegrationService` is wired in during bootstrap, auto-detecting `ANTHROPIC_API_KEY`, `claude` CLI, or other providers. AI-powered planning, the meta-reasoner, and all 35 tools are available.
- **Embedded mode** (socket transport): The desktop app embeds the MCP server at `.ade/mcp.sock`, sharing the same service instances. External agents connect via the socket and proxy through the desktop for live UI updates.

A `JsonRpcTransport` abstraction layer supports both stdio and Unix socket transports. The smart entry point auto-detects whether `.ade/mcp.sock` exists: if the desktop is running, the server connects as an embedded proxy; otherwise it starts in headless mode with its own AI backend.

### 2. No Agent Chat Participation

`agentChatService` is null in MCP mode. External consumers cannot participate in agent chat sessions. Mission progress can only be observed via:

- `stream_events` (event polling)
- `get_worker_states` (agent state snapshots)
- `get_step_output` (step transcripts)
- `get_timeline` (full event timeline)

### 3. Event Buffer is In-Memory (Headless Mode)

The `stream_events` tool uses an in-memory event buffer with a **10,000 event cap**. Events are lost on process restart. For durable event history, use `get_timeline` which reads from the SQLite database. The in-memory buffer is designed for real-time polling during active mission execution, not long-term storage.

### 3. Single Process Database Access

ADE uses SQLite (via node:sqlite) with a single-writer model. If the desktop app and MCP server run simultaneously against the same project database, **SQLite write conflicts** will occur. To avoid this:

- Stop the desktop app before running the MCP server standalone in headless mode, or
- Use the MCP server in embedded mode (via `.ade/mcp.sock`), which shares the same database connection as the desktop app.
