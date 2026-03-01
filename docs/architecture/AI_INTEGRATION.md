# AI Integration Architecture

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-27

The AI integration layer replaces the previous hosted agent with a local-first, subscription-powered approach. Instead of a cloud backend with API keys and remote job queues, ADE spawns `claude` and `codex` CLI processes that inherit the user's existing subscriptions, coordinates them through an MCP server, and manages multi-step workflows via an AI orchestrator.

---

## Table of Contents

- [Overview](#overview)
- [Agent-First Execution Contract](#agent-first-execution-contract)
- [Design Decisions](#design-decisions)
  - [Why Subscription-Powered?](#why-subscription-powered)
  - [SDK Strategy](#sdk-strategy)
  - [Why MCP for Tool Access?](#why-mcp-for-tool-access)
  - [Why AI Orchestrator?](#why-ai-orchestrator)
- [Technical Details](#technical-details)
  - [AgentExecutor Interface](#agentexecutor-interface)
  - [Claude Executor](#claude-executor)
  - [Codex Executor](#codex-executor)
  - [AI Integration Service](#ai-integration-service)
  - [MCP Server](#mcp-server)
  - [Computer Use MCP Tools](#computer-use-mcp-tools)
  - [AI Orchestrator](#ai-orchestrator)
  - [Meta-Reasoner and Smart Fan-Out](#meta-reasoner-and-smart-fan-out)
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

1. **No credential management**: Users should never paste API keys into ADE. If `claude` or `codex` is installed and authenticated, AI features work automatically.
2. **Local execution**: All AI processing happens on the developer's machine. No data leaves the local environment except through the CLI processes' own authenticated connections to their respective providers.
3. **Auditable tool access**: AI agents interact with ADE exclusively through an MCP server that enforces permissions, logs every call, and provides a clear boundary between what the AI can read versus what it can mutate.

The AI integration layer consists of four subsystems:

- **Agent SDKs** -- the execution layer that spawns and manages CLI processes via the `AgentExecutor` interface.
- **AI Integration Service** -- the main-process service that routes tasks to the appropriate provider and model.
- **MCP Server** -- the tool exposure layer that gives AI agents controlled access to ADE's capabilities.
- **AI Orchestrator** -- the coordination layer that plans and executes multi-step missions.

## Agent-First Execution Contract

From Phase 4 onward, ADE treats agent runtimes as the mandatory substrate for all non-interactive AI execution:

- Mission planning and step execution
- Conflict and PR AI actions
- Narrative generation and background summaries
- Night Shift, watcher, and review workflows
- Future mobile-triggered/background runs

All of those paths are normalized into a runtime record (`agentDefinitionId` + run/step/session lineage + memory policy + guardrails), even when the UX appears "one-shot".

Interactive lane development (`Terminals`, `Work` chat) remains direct user sessions and is not forced through mission runtime semantics.

### Key Contract

AI agents **NEVER** directly mutate the repository. All filesystem writes, git commands, and process execution flow through ADE's Local Core Engine services. The MCP server provides tools that invoke these services on the agent's behalf, but every invocation passes through ADE's permission and policy layer. This preserves the same trust boundary that governed the previous hosted agent architecture: ADE is the single source of truth for repository state.

---

## Design Decisions

### Why Subscription-Powered?

The previous architecture required users to either sign up for a hosted service (with OAuth, cloud sync, and remote job processing) or configure bring-your-own-key (BYOK) credentials with raw API keys. Both approaches created friction:

- Hosted service: required account creation, network connectivity for AI features, and a separate billing relationship.
- BYOK: required users to obtain, paste, and rotate API keys -- a credential management burden that is error-prone and creates security surface area.

The subscription-powered approach eliminates both problems. Developers who use Claude or Codex already have authenticated CLI tools on their machines. ADE spawns these CLIs as child processes, and they authenticate using whatever mechanism the user already set up (browser sign-in, token file, environment variable). ADE never sees or stores the credentials.

This also aligns AI cost with tools developers already budget for. There is no separate ADE subscription tier for AI features -- the user's existing CLI subscription covers it.

### SDK Strategy

ADE uses the best available SDK for each agent rather than forcing both through a single unified layer. The unification point is ADE's own `AgentExecutor` interface -- a thin abstraction that the orchestrator works against, ensuring the orchestration and UI layers never couple to a specific SDK.

#### Claude: Community Vercel AI SDK Provider (Workaround)

Anthropic's official Agent SDK (`@anthropic-ai/claude-agent-sdk`) currently restricts subscription/OAuth usage in third-party applications (as of Feb 19, 2026 -- this policy is contested and may change). To work around this, ADE uses `ai-sdk-provider-claude-code`, a community-maintained Vercel AI SDK provider by Ben Vargas. This provider wraps `@anthropic-ai/claude-agent-sdk`, which in turn spawns the Claude Code CLI as a subprocess. Authentication flows through `claude login` (the user's existing Anthropic subscription).

The Vercel AI SDK is therefore still present in the stack, but only on the Claude path -- it is not the "unified layer" for both agents.

#### Codex: Official OpenAI SDK (Direct)

OpenAI's official `@openai/codex-sdk` is well-maintained and supports subscription auth (ChatGPT Plus/Pro) natively. It directly spawns the Codex CLI as a subprocess via JSONL over stdin/stdout. There is no need for a Vercel AI SDK wrapper -- the official SDK provides everything ADE needs: thread management, streaming, structured output, and sandbox controls.

#### The AgentExecutor Interface

ADE owns a thin `AgentExecutor` interface that abstracts over both SDK paths. The orchestrator, AI integration service, and mission planner all work against this interface. This means:

- **Provider abstraction**: The orchestrator dispatches steps to an executor without knowing which SDK runs underneath.
- **Streaming**: Both executors surface `AsyncIterable<AgentEvent>` streams, providing a uniform streaming contract for the UI layer.
- **Structured output**: JSON schema enforcement is handled by each executor's underlying SDK, but the result contract is identical.
- **Tool interception**: Each executor implements its own tool interception mechanism (Vercel's `canUseTool` callback for Claude, Codex SDK's approval hooks for Codex), but the orchestrator sees a uniform permission interface.
- **Session management**: Session state is managed per-executor, but the `resume()` contract is the same.

```typescript
interface AgentExecutor {
  execute(prompt: string, opts: ExecutorOpts): AsyncIterable<AgentEvent>;
  resume(sessionId: string): AsyncIterable<AgentEvent>;
}

class ClaudeExecutor implements AgentExecutor { /* wraps ai-sdk-provider-claude-code */ }
class CodexExecutor implements AgentExecutor { /* wraps @openai/codex-sdk */ }
```

#### Migration Path

- If Anthropic opens subscription access for the Agent SDK: switch `ClaudeExecutor` to use `@anthropic-ai/claude-agent-sdk` directly and drop the Vercel provider wrapper. No orchestrator or UI changes required.
- If a new agent CLI appears (e.g., Gemini): add a new executor implementing the same `AgentExecutor` interface. The orchestrator and UI code do not change.
- The `AgentExecutor` interface is the stable contract; the SDKs underneath are implementation details that can be swapped without ripple effects.

### Why MCP for Tool Access?

AI agents need to interact with ADE's internal systems (lanes, packs, conflicts, tests) to be useful. There are several ways to expose these capabilities:

- **Direct function calls**: Tight coupling, no audit trail, no permission boundary.
- **Custom API**: Works but requires ADE to invent and maintain a bespoke protocol.
- **Model Context Protocol (MCP)**: Standardized protocol with built-in support in Claude and other AI tools, providing tool discovery, structured invocation, and resource access.

ADE chose MCP because:

- It provides a **natural permission boundary**: the MCP server is a separate process communicating via stdio, so AI agents cannot bypass the tool interface to access the filesystem directly.
- It enables **call audit logging**: every tool invocation is a JSON-RPC message that can be logged, replayed, and analyzed.
- It supports **resource providers**: AI agents can read ADE state (pack exports, lane status, conflict predictions) through a structured interface rather than parsing raw files.
- It is **protocol-native** to Claude: the `claude` CLI has built-in MCP client support, so connecting to ADE's MCP server requires no custom integration code.

### Why AI Orchestrator?

Simple AI tasks (generate a narrative, draft a PR description) still execute in a single pass, but are wrapped as **ephemeral task-agent runtimes**. Missions add orchestration on top of the same runtime substrate:

- **Step sequencing**: Some steps depend on others (tests must run after implementation).
- **Parallel execution**: Independent steps should run concurrently in separate lanes.
- **Context management**: Each step needs relevant context without exceeding token budgets.
- **Failure handling**: Failed steps need retry logic, intervention routing, or graceful degradation.
- **Conflict prevention**: Agents working in parallel must not create merge conflicts.

The AI Orchestrator is a Claude session using **in-process Vercel AI SDK coordinator tools** (defined in `coordinatorTools.ts`) that handles this coordination. It receives a mission prompt, plans the execution strategy, spawns agents for each step, monitors progress through structured worker reports, and routes interventions to the user when human input is required. The orchestrator does **not** use the MCP server — its tools are registered directly with the Vercel AI SDK `streamText()` call. The MCP server (`apps/mcp-server`) serves a different role: it is the **external tool interface** for spawned worker agents and external observers/evaluators.

Autonomy boundary: the coordinator owns strategic decisions (spawn, replan, validation routing, lane transfer, escalation). The deterministic runtime only enforces state integrity and policy constraints. For example, `revise_plan` requires explicit dependency patches from the coordinator; runtime validation does not auto-rewire dependencies. If the coordinator is unavailable, runs pause/escalate instead of falling back to deterministic strategy handlers.

This is distinct from the orchestrator service (`orchestratorService.ts`), which is the deterministic state machine that tracks runs, steps, attempts, and claims. The AI Orchestrator is the intelligent layer on top that decides *what* to do next; the orchestrator service is the durable layer underneath that records *what happened*.

---

## Technical Details

### AgentExecutor Interface

The `AgentExecutor` interface is ADE's central abstraction over agent SDKs. All AI task dispatching flows through this interface, ensuring the orchestrator and UI layers remain SDK-agnostic.

```typescript
interface AgentExecutor {
  execute(prompt: string, opts: ExecutorOpts): AsyncIterable<AgentEvent>;
  resume(sessionId: string): AsyncIterable<AgentEvent>;
}

interface ExecutorOpts {
  cwd: string;                              // Working directory (lane worktree path)
  contextPack: PackExport;                  // Token-budgeted context bundle
  systemPrompt?: string;                    // Task-specific system prompt
  jsonSchema?: object;                      // Structured output enforcement
  model?: string;                           // Model override (resolved from Settings)
  timeoutMs: number;                        // Hard timeout for the execution
  maxBudgetUsd?: number;                    // Budget cap (Claude only, currently)
  oneShot?: boolean;                        // If true, use codex exec / non-streaming mode

  // Permission and sandbox configuration (mapped to provider-specific options)
  permissions: {
    mode: "read-only" | "edit" | "full-auto";  // ADE's unified permission model
    allowedTools?: string[];                    // Tool whitelist
    disallowedTools?: string[];                 // Tool blacklist
    canUseTool?: (invocation: ToolInvocation) => boolean;  // Runtime hook
    sandboxLevel?: "strict" | "workspace" | "unrestricted"; // Filesystem access
  };

  // Provider-specific overrides (passed through to underlying SDK)
  providerConfig?: {
    claude?: {
      permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan";
      settingSources?: ("user" | "project" | "local")[];
      hooks?: Record<string, unknown>;
    };
    codex?: {
      approval_mode?: "untrusted" | "on-request" | "never";
      sandbox_permissions?: "read-only" | "workspace-write" | "danger-full-access";
      writable_paths?: string[];
      command_allowlist?: string[];
    };
  };
}

type AgentEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; args: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "structured_output"; data: unknown }
  | { type: "error"; message: string }
  | { type: "done"; sessionId: string };
```

The orchestrator service, AI integration service, and mission planner all depend on `AgentExecutor` rather than on any specific SDK. This makes executor swaps a one-file change with zero impact on upstream consumers.

### Claude Executor

`ClaudeExecutor` wraps `ai-sdk-provider-claude-code` (community Vercel AI SDK provider by Ben Vargas), which in turn wraps `@anthropic-ai/claude-agent-sdk`, which spawns the Claude Code CLI as a subprocess.

**SDK chain**: `ClaudeExecutor` -> `ai-sdk-provider-claude-code` -> `@anthropic-ai/claude-agent-sdk` -> `claude` CLI process

**Authentication**: Inherits the user's Anthropic subscription via `claude login`. ADE never sees or stores credentials.

**CLI invocation** (spawned by the underlying SDK):

```
claude -p --output-format json --permission-mode plan --no-session-persistence <prompt>
```

- Used for planning, review, conflict resolution, and narrative generation.
- Supports `--json-schema` for structured output enforcement.
- Permission mode is set per task: `plan` for read-only analysis, `full` for implementation steps.

**Tool interception**: The Vercel AI SDK's `canUseTool` callback is wired through the executor:

```typescript
canUseTool({ toolName, args, context }) => {
  // Check against ADE's permission policy
  // Log the tool invocation attempt
  // Return allow/deny decision
}
```

This callback is the enforcement point for ADE's trust boundary. Even if a model attempts to use a tool it should not have access to, ADE can deny the request and log the attempt.

**SDK Configuration Options** (via `ai-sdk-provider-claude-code`):

The community Vercel provider exposes nearly all options from `@anthropic-ai/claude-agent-sdk`:

| Option | Type | Description |
|--------|------|-------------|
| `permissionMode` | `"default"` \| `"acceptEdits"` \| `"bypassPermissions"` \| `"plan"` | Controls what Claude can do without asking. `plan` = read-only analysis; `acceptEdits` = auto-approve file edits; `bypassPermissions` = full autonomy. |
| `allowedTools` | `string[]` | Whitelist of tools Claude may use (e.g., `["Read", "Grep", "Glob"]`). |
| `disallowedTools` | `string[]` | Blacklist of tools Claude may not use. |
| `canUseTool` | `(invocation) => boolean` | Runtime callback for per-invocation tool approval -- ADE's enforcement point. |
| `mcpServers` | `McpServerConfig[]` | MCP servers to connect (ADE passes its own MCP server here). |
| `systemPrompt` | `string` | System prompt prepended to every conversation. Used by ADE for task-specific instructions. |
| `settingSources` | `("user" \| "project" \| "local")[]` | Which `.claude/settings.json` files to load. **Not loaded by default** -- ADE must opt in via `settingSources: ["project"]` to honor project-level settings. |
| `maxBudgetUsd` | `number` | Hard budget cap for the session. Claude stops when budget is reached. |
| `hooks` | `HookConfig` | 12 hook event types (PreToolUse, PostToolUse, Stop, SessionStart, etc.) for lifecycle interception. |
| `sandbox` | `boolean` | Enable sandbox mode for filesystem isolation. |

**Important: Settings Loading Behavior**

By default, the Claude Agent SDK does **NOT** load `.claude/settings.json` or `CLAUDE.md` files from the project. ADE must explicitly opt in:

- To honor project settings: set `settingSources: ["project"]`
- To load CLAUDE.md: requires `settingSources: ["project"]` AND the preset system prompt must reference it
- ADE controls what settings are loaded -- this is a feature, not a bug. It means ADE can enforce its own permission policies without interference from project-level Claude settings.

**Available Models** (via `supportedModels()` method):

| Alias | Full Model ID | Use Case |
|-------|---------------|----------|
| `opus` | `claude-opus-4-6` | Complex reasoning, mission planning |
| `sonnet` | `claude-sonnet-4-6` | Balanced -- review, conflict analysis, narratives |
| `haiku` | `claude-haiku-4-5-20251001` | Fast, cheap -- terminal summaries, PR descriptions |

Users select models by alias in Settings; ADE resolves to full IDs internally. The `supportedModels()` SDK method can be called at startup to populate the model picker with the latest available models.

**Migration note**: If Anthropic opens subscription access for the Agent SDK, `ClaudeExecutor` will switch to using `@anthropic-ai/claude-agent-sdk` directly, dropping the Vercel provider wrapper. The `AgentExecutor` interface contract does not change.

### Codex Executor

`CodexExecutor` wraps `@openai/codex-sdk` (official OpenAI SDK) directly. No Vercel AI SDK involvement.

**SDK chain**: `CodexExecutor` -> `@openai/codex-sdk` -> `codex` CLI process (JSONL over stdin/stdout)

**Authentication**: Inherits the user's OpenAI subscription (ChatGPT Plus/Pro) natively. The official SDK supports subscription auth out of the box.

**SDK API usage**:

```typescript
import Codex from "@openai/codex-sdk";

const codex = new Codex();
const thread = codex.startThread();

// One-shot execution
const result = await thread.run("Implement auth middleware", {
  cwd: laneWorktreePath,
  sandbox: "read-only",
});

// Streaming execution
for await (const event of thread.runStreamed("Implement auth middleware", {
  cwd: laneWorktreePath,
  sandbox: "read-only",
})) {
  // event: text chunk, tool call, tool result, or done
}
```

- Used for implementation, code generation, and structured analysis.
- Sandbox mode (`read-only` or `network-off`) provides filesystem isolation.
- Thread management (`startThread()`, `run()`, `runStreamed()`) handles session state natively.
- The Codex SDK handles JSONL serialization over stdin/stdout internally.

**Thread API (for complex, multi-turn tasks)**:

The Codex SDK uses a thread-based API for managing conversational sessions:

```typescript
import Codex from "@openai/codex-sdk";

const codex = new Codex();

// Start a new thread (creates a new Codex CLI subprocess)
const thread = codex.startThread({
  workingDirectory: laneWorktreePath,
  config: {
    // SDK config is flattened to TOML and passed to the CLI
    model: "gpt-5.3-codex",
    approval_mode: "on-request",    // untrusted | on-request | never
    sandbox_permissions: "workspace-write", // read-only | workspace-write | danger-full-access
  }
});

// One-shot execution (waits for full result)
const result = await thread.run("Implement auth middleware");

// Streaming execution (yields events as they happen)
for await (const event of thread.runStreamed("Implement auth middleware")) {
  // event types: text chunk, tool call, tool result, done
}

// Resume an existing thread (for multi-turn)
const resumed = codex.resumeThread(threadId);
```

**Non-Interactive Mode (`codex exec`) for one-shot tasks**:

For simple, one-shot AI tasks (narrative generation, PR descriptions, terminal summaries), ADE uses `codex exec` -- Codex's non-interactive mode designed for scripts and automation:

```typescript
// Via child_process (not the SDK — codex exec is a CLI command)
const result = await execAsync(
  `codex exec --full-auto --sandbox read-only --json "Generate a narrative summary for this lane" < context.json`,
  { cwd: laneWorktreePath }
);
```

- `--full-auto`: No approval prompts, runs to completion
- `--sandbox read-only`: Filesystem isolation (can read but not write)
- `--json`: Output as structured JSON
- `--output-schema <file>`: Enforce structured output via JSON schema
- `--ephemeral`: No session persistence (clean state each time)
- Streams progress to stderr, final result to stdout

**When to use Thread API vs `codex exec`**:

| Scenario | API | Rationale |
|----------|-----|-----------|
| Mission planning | Thread API | Multi-step reasoning, may need follow-up |
| Implementation steps | Thread API | Complex, multi-file changes with tool use |
| Narrative generation | `codex exec` | One-shot, no follow-up needed |
| PR description drafting | `codex exec` | One-shot, structured output |
| Terminal summaries | `codex exec` | One-shot, fast turnaround |
| Conflict proposals | Thread API | Needs detailed context analysis, may produce complex diffs |

**SDK Configuration** (via `config` option):

The Codex SDK accepts a `config` object that is flattened to TOML format and passed to the underlying CLI process. This config merges with (and overrides) any `codex.toml` files:

| Option | Type | Description |
|--------|------|-------------|
| `model` | `string` | Model to use. Available: `gpt-5.3-codex`, `gpt-5.2-codex`, `gpt-5.1-codex-max`, `codex-mini-latest`, `o4-mini`, `o3` |
| `approval_mode` | `"untrusted"` \| `"on-request"` \| `"never"` | How tool use is approved. `never` = full autonomy. `on-request` = approve mutations. `untrusted` = approve everything. |
| `sandbox_permissions` | `"read-only"` \| `"workspace-write"` \| `"danger-full-access"` | Filesystem sandbox level. `read-only` = safest. `workspace-write` = can write within cwd. `danger-full-access` = no restrictions. |
| `writable_paths` | `string[]` | Additional paths allowed when using `workspace-write` sandbox. |
| `command_allowlist` | `string[]` | Shell commands the agent is allowed to run (prefix matching). |
| `disable_tools` | `string[]` | Tools to disable (e.g., `["shell"]` to prevent command execution). |
| `mcp_servers` | `object` | MCP server definitions (ADE passes its MCP server here). |

**`codex.toml` Honoring Behavior**:

The Codex SDK loads config from multiple layers (lowest to highest priority):
1. System-level `codex.toml` (`~/.config/codex/codex.toml`)
2. Project-level `codex.toml` (in repo root)
3. SDK `config` option (highest priority -- what ADE passes)

ADE always passes its own config via the SDK, which overrides project-level codex.toml. This ensures ADE controls the agent's behavior regardless of what the project's codex.toml says. Users can configure these overrides in ADE Settings.

**Available Models**:

| Model ID | Description | Use Case |
|----------|-------------|----------|
| `gpt-5.3-codex` | Latest, most capable | Complex implementation, mission execution |
| `gpt-5.2-codex` | Previous generation | Balanced performance/cost |
| `gpt-5.1-codex-max` | Extended context | Large codebase tasks |
| `codex-mini-latest` | Fast, lightweight | One-shot tasks, summaries |
| `o4-mini` | Reasoning model | Planning, analysis |
| `o3` | Advanced reasoning | Complex multi-step reasoning |

**Tool interception**: The Codex SDK's approval hooks are mapped to the same `canUseTool` contract via the executor adapter, maintaining a uniform permission interface for the orchestrator.

#### Streaming Support

All AI responses stream back to the renderer process via IPC push events (`webContents.send`). Both executors produce `AsyncIterable<AgentEvent>` streams, which the AI integration service consumes uniformly. The UI renders streaming tokens in real time, providing immediate feedback during:

- Mission planning (showing the planner's reasoning as it builds a step plan)
- Narrative generation (showing the narrative as it is written)
- Conflict resolution (showing the analysis and proposed diff as they are generated)

#### Session Management

For multi-turn interactions (such as the orchestrator's planning loop), each executor manages session state through its underlying SDK:

- **Claude**: The Vercel AI SDK provider manages conversational context across multi-turn interactions.
- **Codex**: The official SDK's thread API (`codex.startThread()`) maintains session state natively.

Session data includes:

- Conversation history (bounded by token budget)
- Tool-use history (which tools were called and their results)
- Context window contents (pack exports, lane state snapshots)

Sessions are ephemeral and scoped to a single orchestrator run. They are not persisted to disk.

### AI Integration Service

The AI integration service (`aiIntegrationService.ts`) is the main-process service that replaces the previous `hostedAgentService` and `byokLlmService`. It provides a unified interface for all AI operations:

#### Task-Type Routing

The service routes each AI task to the appropriate provider based on task type and configuration:

| Task Type | Default Provider | CLI Command | Rationale |
|-----------|-----------------|-------------|-----------|
| `planning` | Claude CLI | `claude -p` | Strong multi-step reasoning for mission decomposition |
| `implementation` | Codex CLI | `codex exec` | Optimized code generation with sandbox isolation |
| `review` | Claude CLI | `claude -p` | Detailed analysis with explanation capabilities |
| `conflict_resolution` | Claude CLI | `claude -p` | Reasoning over overlapping changes with full context |
| `narrative` | Claude CLI | `claude -p` | Concise, developer-facing markdown summaries |
| `pr_description` | Claude CLI | `claude -p` | Factual, structured markdown for GitHub |

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

On startup and project switch, the AI integration service probes for available CLI tools:

```typescript
function detectAvailableProviders(): ProviderAvailability {
  return {
    claude: commandExists("claude"),
    codex: commandExists("codex"),
  };
}
```

If no CLI tools are detected, ADE operates in guest mode: all deterministic features (packs, diffs, conflict detection) work normally, but AI-generated content (narratives, proposals, PR descriptions) is unavailable. The UI clearly indicates which features require a CLI subscription.

#### Configuration

Provider preferences are configured in `.ade/local.yaml`:

```yaml
ai:
  # Global defaults
  default_provider: auto        # auto | claude | codex
  planning_timeout_ms: 45000
  allow_planning_questions: false

  # Per-task-type overrides
  tasks:
    planning:
      provider: claude
      model: sonnet              # Model alias — resolved to full ID internally
      timeout_ms: 45000
    implementation:
      provider: codex
      model: gpt-5.3-codex
      timeout_ms: 120000
    review:
      provider: claude
      model: sonnet
      timeout_ms: 30000
    conflict_resolution:
      provider: claude
      model: sonnet
      timeout_ms: 60000
    narrative:
      provider: claude
      model: haiku               # Fast, cheap model for one-shot summaries
      timeout_ms: 15000
      max_output_tokens: 900
      temperature: 0.2
    pr_description:
      provider: claude
      model: haiku
      timeout_ms: 15000
      max_output_tokens: 1200
      temperature: 0.2
    terminal_summary:
      provider: claude
      model: haiku
      timeout_ms: 10000
      max_output_tokens: 500
      temperature: 0.1

  # Permission and sandbox configuration
  permissions:
    claude:
      permission_mode: plan          # default | acceptEdits | bypassPermissions | plan
      settings_sources: []           # Empty = ADE controls everything. ["project"] = honor .claude/settings.json
      max_budget_usd: 5.00           # Per-session budget cap
      sandbox: true                  # Enable sandbox mode
    codex:
      approval_mode: on-request      # untrusted | on-request | never
      sandbox_permissions: workspace-write  # read-only | workspace-write | danger-full-access
      writable_paths: []             # Additional writable paths beyond cwd
      command_allowlist: []          # Allowed shell commands (empty = default set)

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
    narratives: { daily_limit: 50 }
    conflict_proposals: { daily_limit: 20 }
    pr_descriptions: { daily_limit: 30 }
    terminal_summaries: { daily_limit: 100 }
    mission_planning: { daily_limit: 10 }
    orchestrator: { daily_limit: 5 }
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

**Artifact production**: Screenshots and video recordings produced by computer use tools are automatically attached as artifacts to the owning lane, mission, or agent run. Artifact types: `screenshot` (PNG), `video` (MP4).

**Permission control**: Computer use tools require `full-auto` / `bypassPermissions` permission level. Agents in `read-only` or `edit` modes cannot use GUI interaction tools (screenshot capture is allowed in all modes).

### AI Orchestrator

The AI Orchestrator is the intelligent coordination layer that plans and executes multi-step missions. It uses a **leader/worker agent team architecture** inspired by Claude Code's agent teams model: one leader session (the orchestrator itself) coordinates multiple worker agents, each operating in its own context window and lane worktree. The orchestrator runs on top of the deterministic orchestrator service state machine, issuing commands through it rather than replacing it.

#### Design Principles (Informed by Claude Code Agent Teams)

The orchestrator adopts key patterns proven in Claude Code's multi-agent coordination:

1. **Leader/Worker Separation**: The orchestrator session acts as the team leader — it plans, assigns, monitors, and synthesizes. Worker agents execute implementation, review, and testing tasks independently. Workers never coordinate directly with each other; all coordination flows through the orchestrator or the shared task infrastructure.

2. **Shared Task List as Coordination Backbone**: All steps in a mission are materialized as a structured task list that both the orchestrator and the deterministic runtime can inspect. Steps have states (`pending`, `claimed`, `in_progress`, `completed`, `failed`), dependencies (a step blocked by another cannot start), and owners (the agent assigned to execute it). This mirrors Claude Code's team task list with file-lock-based claim safety.

3. **Context Isolation via Lane Worktrees**: Each worker agent operates in its own lane worktree — an isolated copy of the repository. This prevents file conflicts between parallel agents (a critical lesson from agent teams: "two teammates editing the same file leads to overwrites"). The orchestrator assigns file/lane ownership at the step level to guarantee isolation.

4. **Scoped Agent Profiles**: Each worker receives a focused system prompt, restricted tool access, and a bounded context pack — not the orchestrator's full conversation history. This matches Claude Code's subagent pattern: workers load project context independently and receive only task-specific instructions from the leader.

5. **Plan Approval Gates**: For complex or risky steps, the orchestrator can require plan approval before a worker begins implementation. The worker researches and plans in read-only mode, submits a plan to the orchestrator, and the orchestrator approves or rejects with feedback. This mirrors the `plan_mode_required` pattern in agent teams.

6. **Inter-Agent Messaging via Structured Events**: All communication between the orchestrator and workers flows through structured `OrchestratorEvent` records — not free-form text. Event types include: `step_assigned`, `step_started`, `step_completed`, `step_failed`, `intervention_requested`, `context_loaded`, `agent_spawned`, `plan_submitted`, `plan_approved`, `plan_rejected`. Each event is durable and queryable from History.

7. **Graceful Lifecycle Management**: Workers go idle between tasks. The orchestrator detects idle workers, assigns new tasks or requests shutdown. Workers can reject shutdown if they have in-progress work. All shutdown is graceful — forced termination is a last resort after timeout.

#### Architecture

```
Mission prompt + context packs
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
│ │      AgentExecutor           │                   │
│ │  ┌──────────┬──────────┐     │                   │
│ │  │  Claude  │  Codex   │     │                   │
│ │  │ Executor │ Executor │     │                   │
│ │  └──────────┴──────────┘     │                   │
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
│  │  Result Merger   │ ──> merge worker lanes back  │
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

#### Planning Phase

When a mission is created, the orchestrator's planning phase:

1. Receives the mission prompt, title, and any attached context.
2. Assembles a context bundle: project pack (Standard), docs digest, active lane summaries, operation history, and any user-attached files.
3. Builds a structured planner prompt and invokes the configured planning executor (`ClaudeExecutor` or `CodexExecutor`).
4. The planner returns a JSON plan conforming to the mission plan schema:
   ```typescript
   interface MissionPlan {
     summary: {
       domain: string;
       complexity: "trivial" | "moderate" | "complex" | "very_complex";
       strategy: "sequential" | "parallel-lite" | "parallel-first";
       parallelismCap: number;          // max concurrent worker agents
     };
     assumptions: string[];
     risks: Array<{ description: string; mitigation: string }>;
     steps: MissionStep[];
     mergePolicy: "sequential" | "batch-at-end" | "per-step";
     conflictHandoff: "auto-resolve" | "ask-user" | "orchestrator-decides";
   }

   interface MissionStep {
     id: string;
     title: string;
     description: string;
     dependsOn: string[];               // step IDs
     executorKind: "claude" | "codex" | "shell" | "manual";
     executorHint?: string;             // model preference
     requiresPlanApproval: boolean;     // worker must plan before implementing
     claimPolicy: {
       lanes: string[];                 // lane IDs or "new"
       filePatterns: string[];          // glob patterns for file ownership
       envKeys: string[];               // environment scope keys
     };
     contextProfiles: string[];         // "lite" | "standard" | "deep"
     outputContract: {
       type: "code_changes" | "test_results" | "review" | "artifact";
       schema?: object;                 // JSON schema for structured output
     };
     timeoutMs: number;
     maxRetries: number;
     joinPolicy: "all-succeed" | "any-succeed" | "majority"; // for steps with multiple dependencies
   }
   ```
5. The plan is validated against claim collision rules (no two steps claim overlapping file patterns in the same phase), normalized, and converted into orchestrator run steps.
6. Optionally: the plan is presented to the user for review before execution begins (configurable via `ai.orchestrator.require_plan_review` in `.ade/local.yaml`).

If the AI planner fails (CLI unavailable, timeout, invalid output), planning fails fast with structured `MissionPlanningError` output and mission launch does not silently switch to deterministic strategy handlers.

#### Worker Agent Spawning

For each step that enters the `claimed` state, the orchestrator spawns a worker agent:

1. **Lane Assignment**: Each worker operates in a dedicated lane worktree. If the step specifies `lanes: ["new"]`, a new lane is created via the `create_lane` MCP tool. If it references an existing lane, the worker is assigned to that lane.

2. **Agent Profile Construction**: The worker receives:
   - A **system prompt** built from the step's description, the mission context, and any identity policy (Phase 4).
   - A **context pack** at the tier specified by `contextProfiles` (Lite/Standard/Deep).
   - A **tool whitelist** — the worker's MCP tools are restricted to those appropriate for its step type. Implementation workers get `commit_changes`, `run_tests`; review workers get `read_context`, `check_conflicts`.
   - A **permission mode** — read-only for review/planning steps, edit for implementation steps, configurable per step.

3. **MCP Server Connection**: Each worker agent connects to the same ADE MCP server instance. The MCP permission layer enforces that workers can only access resources within their claimed scope (lane + file patterns). A worker cannot `commit_changes` in a lane it doesn't hold a claim on.

4. **Session Tracking**: The worker's CLI process is registered as a tracked session (`terminal_sessions` row with `tool_type: "codex-orchestrated"` or `"claude-orchestrated"`). This enables transcript capture, delta computation, and pack integration — the same lifecycle as interactive chat sessions.

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
   a. Dispatches the worker in read-only mode (`permissionMode: "plan"`).
   b. Worker researches the codebase and submits a plan via structured output.
   c. Orchestrator evaluates the plan (checks for scope creep, file ownership violations, test coverage).
   d. If approved, re-dispatches the worker with edit permissions.
   e. If rejected, provides feedback and re-dispatches in plan mode for revision.
5. Dispatches the step to the appropriate `AgentExecutor` implementation matching the step's `executorKind`:
   - `claude`: `ClaudeExecutor` spawns a Claude CLI process via `ai-sdk-provider-claude-code` with the step's prompt and context.
   - `codex`: `CodexExecutor` spawns a Codex CLI process via `@openai/codex-sdk` with the step's prompt and context in a sandboxed lane worktree.
   - `shell`: Runs a shell command (for deterministic steps like test execution).
   - `manual`: Waits for user action (for steps requiring human judgment).
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

#### Orchestrator Configuration

The orchestrator is configurable in `.ade/local.yaml`:

```yaml
ai:
  orchestrator:
    # Planning
    require_plan_review: false        # Show plan to user before execution
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

### Context Compaction Engine

The compaction engine (`compactionEngine.ts`, integrated via `unifiedExecutor.ts`) prevents SDK agent sessions from exceeding context window limits during long-running orchestrated work.

**Token Monitoring**: The engine tracks token consumption for each active agent session. When utilization reaches 70% of the model's context window, compaction is triggered.

**Compaction Flow**:

1. **Pre-compaction writeback**: Before compacting, the engine extracts durable facts (shared facts, discovered patterns, key decisions) from the conversation and writes them to the `orchestrator_shared_facts` table.
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

A structured messaging system enables communication between the orchestrator, agents, and the user during mission execution.

**Message Delivery** (`deliverMessageToAgent()` in `aiOrchestratorService.ts`):
- Delivers messages to both PTY-based agents (via terminal write) and SDK-based agents (via conversation injection).
- Messages can originate from the orchestrator, other agents, or the user.

**@Mention Routing**:
- `parseMentions()` extracts @-mentions from message text, identifying target agents by name or role.
- `routeMessage()` determines which agents should receive a message based on mentions, channel context, and routing rules.

**Team Message Tool** (`teamMessageTool.ts`): An MCP tool available to agents that allows them to send messages to other agents or the orchestrator. This enables agent-initiated communication (e.g., "I found a dependency issue that affects @testing-agent's work").

**New IPC Endpoints**:
- `getGlobalChat`: Retrieves the global mission chat channel messages.
- `deliverMessage`: Sends a message from the UI to a specific agent or channel.
- `getActiveAgents`: Lists currently active agents in a mission run with their status.

### Memory Tool Wiring

Memory tools are now wired into the agent coding tool set via `createCodingToolSet()`, giving agents the ability to:

- **Search scoped memories**: Query relevant memory namespaces (`runtime-thread`, `run`, `project`, `identity`, `daily-log`).
- **Create candidate memories**: Record new facts discovered during work with explicit scope + provenance.
- **Promote memories**: Mark high-confidence memories for promotion to project/identity durable scopes.

Memory tools follow the same MCP permission model as other agent tools. Read operations are always allowed; write operations require an active claim.

### Shared Facts and Run Narrative

**Shared Facts**: The `orchestrator_shared_facts` table stores facts discovered by agents during a mission run. Facts are typed (`discovery`, `decision`, `blocker`, `dependency`) and scoped to a run and optionally a step. Shared facts and retrieved scoped memories are injected into prompts via `buildFullPrompt()`.

**Run Narrative**: `appendRunNarrative()` in `orchestratorService.ts` generates a rolling narrative after each step completion. The narrative summarizes what has been accomplished, what is in progress, and what remains. It is stored as `runNarrative` metadata on the orchestrator run and displayed in the Activity tab.

**Compaction Hints**: A compaction hints section is added to agent prompts, providing the agent with guidance on what information to prioritize preserving if context compaction is triggered.

### Memory Architecture

The memory system provides agents with durable, searchable long-term memory that persists across sessions, runs, and machines. It upgrades the existing scoped-namespace memory (candidate/promoted lifecycle) with vector search, composite scoring, and pre-compaction integration.

#### Storage Layer

- **Primary store**: SQLite (existing) with a new `memory_vectors` table via the `sqlite-vec` extension
- **Embedding model**: Local GGUF (all-MiniLM-L6-v2, ~25MB) for offline use; OpenAI `text-embedding-3-small` as API fallback when network is available
- **Vector dimensions**: 384 (MiniLM) or 1536 (OpenAI) — the retrieval pipeline normalizes across both
- **Hybrid search**: BM25 keyword relevance (30% weight) + vector cosine similarity (70% weight)
- **MMR re-ranking**: Maximal Marginal Relevance with lambda=0.7 to reduce redundant results in retrieval

#### Retrieval Pipeline

```
Query → Embed query → Parallel: [Vector search, BM25 search] →
  Merge with weights → Composite scoring (semantic + recency + importance + access) →
  MMR re-rank → Budget filter (lite: 3, standard: 8, deep: 20) → Return
```

The composite score combines four signals:
- **Semantic relevance** (cosine similarity or BM25 match)
- **Recency** (decay function on `updatedAt` timestamp)
- **Importance** (user-confirmed entries score highest, auto-promoted next, candidates lowest)
- **Access frequency** (frequently retrieved memories rank higher)

Budget tiers control how many memories are injected into agent context:
- **Lite** (3 entries): Quick tasks, terminal summaries, one-shot generation
- **Standard** (8 entries): Normal agent work, implementation steps
- **Deep** (20 entries): Mission planning, complex multi-file reasoning

#### Write Pipeline

```
New memory → Embed → Find similar (cosine > 0.85) →
  If similar found: LLM decides PASS/REPLACE/APPEND/DELETE →
  Store in SQLite + memory_vectors → Emit to .ade/memory/ for git sync
```

The consolidation step prevents memory bloat:
- **PASS**: New memory is redundant; discard it
- **REPLACE**: New memory supersedes existing; update in place
- **APPEND**: New memory extends existing; merge content
- **DELETE**: Existing memory is outdated; remove it

All write operations emit a corresponding JSON file to `.ade/memory/` for cross-machine sync via git.

#### Pre-Compaction Integration

The memory system hooks into the existing `compactionEngine.ts` (Hivemind HW6) to ensure durable state is saved before context is compacted:

1. At 70% context threshold, before compaction triggers:
   - A silent agentic turn prompts the agent to save important memories
   - The agent uses `memoryAdd` to persist key facts, decisions, and patterns discovered during work
   - A flush counter prevents double-flushing within the same compaction cycle
2. Compaction proceeds normally, knowing durable state is safely persisted in the memory store
3. After compaction, the agent's context includes a summary but can retrieve full memories on demand

This integration ensures that long-running agent sessions do not lose important discoveries when their context window is compacted.

#### Context Assembly Per Runtime

Every agent runtime assembles its context window from a layered budget:

```
System prompt + tools definition                    (~5-10K tokens)
+ Tier 1 core memory (persona + working context)    (~2-4K tokens)
+ Tier 2 retrieved memories (budget-dependent)       (~1-3K tokens)
+ Mission shared facts (if in mission)               (~0.5-1K tokens)
+ Conversation history                               (remaining budget)
+ Response reserve                                   (~4K tokens)
```

The memory retrieval tier is scoped to the runtime's namespace hierarchy:
- `runtime-thread`: Ephemeral, current session only
- `run`: Shared across all agents in a mission run
- `project`: Persistent project-level knowledge
- `identity`: Agent-specific learned behaviors
- `daily-log`: Time-scoped operational notes

Each tier is populated by `buildFullPrompt()` in the unified executor, which queries the memory service with the appropriate scope and budget before assembling the final prompt.

#### Prior Art & Design References

The memory architecture is informed by production systems and academic research across the agent memory landscape:

- **MemGPT / Letta**: Pioneered the tiered memory model treating LLM context as "main memory" with agent-managed read/write to "disk" storage. ADE's Tier 1/2/3 maps to MemGPT's core memory blocks / recall memory / archival memory. Letta's benchmarks (74% accuracy with simple file operations vs. Mem0's 68.5%) validated our choice of file-backed portable storage over database-only approaches.

- **Mem0**: Source of the PASS/REPLACE/APPEND/DELETE consolidation model. Mem0 performs real-time deduplication on every write using cosine similarity to detect overlap, then delegates merge decisions to an LLM. ADE adopts this with a conservative 0.85 similarity threshold and adds scope-aware matching (only compare within the same memory scope to prevent false merges across agent boundaries).

- **CrewAI**: The composite scoring formula (`semantic + recency + importance + access`) is adapted from CrewAI's `RecallFlow` retrieval system. CrewAI combines multiple signals for memory ranking; ADE simplifies the weights (`0.5/0.2/0.2/0.1`) for predictability and adds explicit user-settable importance tags.

- **OpenClaw**: Two direct influences — (1) the pre-compaction flush pattern, where the agent is prompted to save important memories before context eviction, using the agent's own judgment rather than mechanical extraction; (2) hybrid BM25 + vector search with configurable weights for memory retrieval. ADE formalizes the flush with a monotonic counter and compaction engine hook.

- **LangMem (LangChain)**: The episodic/procedural memory taxonomy — structured post-session summaries and learned tool-usage patterns. LangMem's key insight that procedural memories should be extracted from recurring episodic patterns (not single sessions) informed ADE's requirement for multi-episode pattern observation before procedural entry creation.

- **A-MEM**: Zettelkasten-inspired automatic linking between memory entries. While ADE does not implement full graph-based navigation in Phase 4, the consolidation APPEND operation creates implicit links and composite scoring ensures related memories co-retrieve.

- **JetBrains (NeurIPS 2025)**: Research finding that **observation masking** (replacing old tool outputs with `[output omitted]` placeholders) outperforms LLM-based summarization for context management while being significantly cheaper. ADE applies this in context assembly for resumed sessions.

- **Elvis Sun's ZOE/CODEX**: Demonstrated the context window separation principle — business/orchestration context and code context should not share the same window because context is zero-sum. Directly informed ADE's leader/worker architecture where the orchestrator holds mission context while workers hold code context.

### External MCP Consumption

ADE agents can connect to external MCP servers during execution, extending their capabilities beyond ADE's built-in tool set.

**Configuration**: External MCP servers are declared in `.ade/local.yaml` under the `externalMcp` key:

```yaml
externalMcp:
  servers:
    - name: github
      command: npx
      args: ["-y", "@modelcontextprotocol/server-github"]
      env:
        GITHUB_TOKEN: "${env:GITHUB_TOKEN}"
    - name: postgres
      command: npx
      args: ["-y", "@modelcontextprotocol/server-postgres"]
      env:
        DATABASE_URL: "${env:DATABASE_URL}"
```

**Connection management**: External MCP connections are lazy — they are established on first tool use and disconnected when the agent session ends. This avoids unnecessary process spawning for tools that may not be needed.

**Security**: External MCP tools pass through the same permission and policy layer as ADE's internal tools:
- Agent identity `allowedTools` / `deniedTools` lists apply to external tool names (prefixed with the server name, e.g., `github:create_pull_request`)
- Mutation tools from external servers require the same claim-based authorization as internal mutation tools
- All external tool invocations are logged to the call audit trail

**Tool discovery**: When an agent session starts, ADE queries all configured external MCP servers for their tool manifests. These tools are merged with ADE's internal tool set and presented to the agent as a unified tool list. The agent does not need to know whether a tool is internal or external.

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
- The CTO can proactively create missions, spin up lanes, and orchestrate work based on project context without explicit user direction
- It maintains awareness of all active missions, lane states, and recent agent outputs

**CTO State**: The CTO maintains its state in `.ade/cto/`, separate from worker agent memory in `.ade/memory/agents/`. This includes persistent project context, learned routing patterns, decision history, and user corrections. Over time, the CTO becomes more effective at anticipating project needs and dispatching work autonomously.

**Use Cases**:
- Primary interface for project-level AI interactions via the CTO tab
- CI/CD pipelines invoking ADE missions via MCP
- External AI agents (Claude Code, Cursor, etc.) requesting ADE to perform work
- Slack/Discord bots routing developer requests to ADE
- Monitoring systems triggering automated review or testing
- Proactive project management: detecting issues, suggesting next steps, coordinating agents

### Cross-Machine Portability

ADE stores all portable state in the `.ade/` directory at the project root, enabling cross-machine synchronization via git without any cloud backend or hub.

**Portable state** (committed to git):
- `memory/project.json` — project-level memories
- `memory/agents/<agentId>.json` — per-agent identity memories
- `agents/` — agent definition YAML files
- `identities/` — agent identity YAML files
- `missions/history.jsonl` — mission execution history
- `learning/` — learning pack JSON files
- `local.yaml` — project-level configuration (shared settings)

**Non-portable state** (`.gitignore`d):
- `mcp.sock` — Unix socket for embedded MCP (runtime artifact)
- `cache/embeddings/` — sqlite-vec embedding cache (regenerated locally on each machine)
- `transcripts/` — raw session transcripts (large, ephemeral)
- `local.private.yaml` — machine-specific overrides (API keys, paths)

**Sync workflow**:
```
Machine A: Agent discovers pattern → memoryAdd → .ade/memory/project.json updated → git commit + push
Machine B: git pull → .ade/memory/project.json updated → memory service reloads → agent benefits from learned pattern
```

**Embedding regeneration**: When `.ade/` is cloned on a new machine, the `memory_vectors` SQLite table is empty. On first startup, the memory service detects the mismatch (JSON files present but no vectors) and triggers a background re-embedding job using the local GGUF model. This is a one-time operation (~30s for a typical project's memory corpus).

**No cloud dependency**: State sync is entirely git-based. There is no central hub, relay, or cloud service involved in state portability. The Phase 8 relay is for real-time remote control of a running ADE instance — not for state synchronization.

### Phase 3 Implementation Status

**Shipped (~90%)**:
- AI orchestrator service with mission lifecycle management
- Fail-hard planner (300s timeout, `MissionPlanningError`, no coordinator-strategy deterministic fallback)
- PR strategies (integration/per-lane/queue/manual) replacing merge phase
- Team synthesis and recovery loops
- Execution plan preview with approval gates
- Inter-agent messaging (sendAgentMessage IPC, deliverMessageToAgent, parseMentions, routeMessage)
- Slack-style chat system (MissionChatV2, MentionInput, sidebar + main area layout)
- Model selection per-mission with per-model thinking budgets
- Activity feed with category dropdown and run narrative
- missionId-filtered queries across all views
- Meta-reasoner with AI-driven fan-out dispatch (external_parallel, internal_parallel, hybrid)
- Context compaction engine (70% threshold, self-summarization, pre-compaction writeback)
- Session persistence via attempt_transcripts table and JSONL files
- Session resume via resumeUnified()
- Shared facts injection and run narrative generation
- Memory tool wiring into agent coding tool set
- Memory architecture (scoped namespaces, candidate/promoted/archived lifecycle, auto-promotion, context budget panel)
- Mission phase engine + profiles (Task 3): phase storage, profile CRUD/import/export, mission overrides, phase transition telemetry
- Mission UI overhaul (Task 4): Plan/Work tabs, missions home dashboard, phase-aware details and launch/settings profile management

**Remaining (~10%)**:
- Next execution focus: Task 5 (pre-flight/intervention/HITL) and Task 6 (budget/usage), then Tasks 7-8.
- Live multi-agent orchestration (concurrent agent coordination)
- Real-time coordination patterns
- File conflict prevention at merge time
- Pre-flight checks, tiered validation, and intervention granularity (Task 5)
- Budget pressure orchestration and subscription usage accounting (Task 6)
- Reflection protocol and deeper integration soak coverage (Tasks 7-8)

### Compute Backends for Agent Execution

Agent execution can target different compute backends via the `ComputeBackend` interface:

```typescript
interface ComputeBackend {
  type: 'local' | 'vps' | 'daytona' | 'e2b';
  create(config: WorkspaceConfig): Promise<WorkspaceHandle>;
  destroy(handle: WorkspaceHandle): Promise<void>;
  exec(handle: WorkspaceHandle, command: string): Promise<ExecResult>;
  getPreviewUrl(handle: WorkspaceHandle, port: number): string;
}
```

**Local Backend** (Default): Executes agents as local processes. No additional setup required.

**VPS Backend**: Routes agent execution to remote machines via the ADE relay. Useful for Night Shift (after-hours autonomous work) and capacity scaling.

**Daytona Backend** (Opt-in): Creates isolated cloud sandbox workspaces via the Daytona SDK. Each workspace gets its own filesystem, ports, and environment. Requires API key configuration.

**E2B Backend** (Opt-in): Creates Firecracker microVM-based sandboxes via the E2B SDK. Sub-150ms cold start. Supports full desktop environments (Xfce desktop + Chromium browser) via E2B Desktop Sandbox. Per-second billing. Configured in Settings → Compute Backends with API key. E2B is always opt-in and provides an alternative to Daytona for teams that prefer managed cloud sandboxes over BYOC infrastructure.

The orchestrator selects backends based on mission configuration, falling back to Local if no preference is set.

### Compute Environment Types

Each compute backend supports multiple environment types that determine what level of interaction an agent has with the running environment:

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

**Terminal-only** (default): Agent gets a shell in a worktree or sandbox. No GUI rendering. Suitable for code changes, test execution, and CLI operations. All backends support this.

**Browser**: Headless browser (Playwright/Puppeteer) available. Agent can launch web applications, navigate pages, interact with UI elements, and capture screenshots. Suitable for web application testing and visual verification. Implementation: Playwright is launched in the compute environment with the dev server URL.

**Desktop**: Full virtual desktop via Xvfb (X Virtual Framebuffer) + window manager. Agent gets programmatic mouse/keyboard control and screenshot/video capture. Suitable for desktop applications (Electron, native), mobile emulators (Android via docker-android), and any GUI application.

Implementation stack for desktop environments:
1. **Xvfb**: Virtual X11 display (e.g., `:99 -screen 0 1920x1080x24`)
2. **Window manager**: Fluxbox (lightweight) or Mutter (full-featured)
3. **VNC server**: x11vnc or TigerVNC for remote viewing
4. **noVNC + websockify**: Browser-based VNC client for web/mobile access
5. **xdotool**: Mouse/keyboard simulation for agent actions
6. **scrot/ImageMagick**: Screenshot capture
7. **ffmpeg**: Video recording via x11grab

Backend capability matrix:
| Backend | terminal-only | browser | desktop |
|---------|:---:|:---:|:---:|
| Local | Yes | Yes (local Playwright) | Yes (local Xvfb) |
| VPS | Yes | Yes | Yes |
| Daytona | Yes | Yes | Yes (native Computer Use API) |
| E2B | Yes | Yes | Yes (Desktop Sandbox API) |

### Per-Task-Type Configuration

ADE supports fine-grained control over which provider and model handles each type of AI task.

#### Task Types

| Task Type | Description | Default Provider |
|-----------|-------------|-----------------|
| `planning` | Mission decomposition into steps | Claude CLI |
| `implementation` | Code generation and modification | Codex CLI |
| `review` | Code review and analysis | Claude CLI |
| `conflict_resolution` | Merge conflict analysis and resolution | Claude CLI |
| `narrative` | Lane narrative generation | Claude CLI |
| `pr_description` | Pull request description drafting | Claude CLI |

#### Configuration Schema

Per-task-type settings are stored in `.ade/local.yaml`:

```yaml
ai:
  # Global defaults
  default_provider: auto        # auto | claude | codex
  planning_timeout_ms: 45000
  allow_planning_questions: false

  # Per-task-type overrides
  tasks:
    planning:
      provider: claude
      timeout_ms: 45000
    implementation:
      provider: codex
      sandbox: read-only        # read-only | network-off
      timeout_ms: 120000
    review:
      provider: claude
      timeout_ms: 30000
    conflict_resolution:
      provider: claude
      timeout_ms: 60000
    narrative:
      provider: claude
      timeout_ms: 15000
      max_output_tokens: 900
      temperature: 0.2
    pr_description:
      provider: claude
      timeout_ms: 15000
      max_output_tokens: 1200
      temperature: 0.2
```

#### Resolution Order

When determining which provider to use for a task:

1. Explicit per-step `executorHint` from the mission planner (highest priority).
2. Per-task-type `provider` setting in `.ade/local.yaml`.
3. Mission-level `executorPolicy` (`codex`, `claude`, or `both`).
4. Global `default_provider` setting.
5. Built-in default for the task type (as listed in the table above).
6. First available CLI tool on the system (fallback).

If no CLI tool is available, the runtime cannot start; ADE surfaces a clear failure and recommended setup action instead of silently substituting strategy logic.

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

The Agent Chat Service provides a native, interactive chat interface inside ADE — an alternative to using CLI terminals for working with Codex and Claude. It is a **provider-agnostic abstraction** that lets users chat with either agent using the same UI.

> **External reference**: The Codex App Server protocol specification is at https://developers.openai.com/codex/app-server — this is the canonical reference for the CodexChatBackend implementation.

#### Why Agent Chat?

CLI terminals are powerful but opaque. The chat interface provides:

- **Structured item display**: File changes as inline diffs, command execution with live output, plans with step status — not raw terminal output.
- **Approval flow**: Accept/decline tool use with full context, not a yes/no prompt in a terminal.
- **Steering**: Inject instructions into an active turn without starting a new conversation.
- **Session persistence**: Resume conversations with full context, not just a command string.
- **Provider switching**: Same UI for both Codex and Claude — switch in the composer dropdown.

#### AgentChatService Interface

```typescript
interface AgentChatService {
  createSession(laneId: string, provider: "codex" | "claude", model: string): Promise<ChatSession>;
  sendMessage(sessionId: string, text: string, attachments?: FileRef[]): AsyncIterable<ChatEvent>;
  steer(sessionId: string, text: string): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  resumeSession(sessionId: string): Promise<ChatSession>;
  listSessions(laneId?: string): Promise<ChatSessionSummary[]>;
  approveToolUse(sessionId: string, itemId: string, decision: ApprovalDecision): Promise<void>;
  getAvailableModels(provider: "codex" | "claude"): Promise<ModelInfo[]>;
  dispose(sessionId: string): Promise<void>;
}

interface ChatSession {
  id: string;
  laneId: string;
  provider: "codex" | "claude";
  model: string;
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
      permissionMode: "acceptEdits",
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

**Session persistence**: Claude sessions are stored at `.ade/chat-sessions/<sessionId>.json` containing the `messages[]` array. This enables resume after app restart. Messages are bounded by token budget — when approaching the limit, older messages are summarized and rotated.

**Limitations**: The Claude backend may not support all UI features that Codex provides (plans, reasoning blocks). The chat UI gracefully handles missing features — items that Claude doesn't produce simply don't appear in the UI.

#### Phase 2 Chat Improvements

Phase 2 completed the outstanding chat debt from Phase 1.5:

- **UI polish shipped**: The Work Pane chat surface (`AgentChatMessageList.tsx`, `AgentChatComposer.tsx`, `AgentChatPane.tsx`) now uses richer bubble styling, inline diff emphasis, cleaner command blocks, improved streaming indicators, and clearer approval presentation.
- **Claude provider selection fixed**: Provider selection no longer resets unexpectedly; Claude and Codex remain selectable based on detected model availability.
- **Reasoning effort selector shipped**: Codex reasoning effort (`low`, `medium`, `high`, `extra_high`) is surfaced in the composer and passed to both `thread/start` and `turn/start`. Last-used effort is persisted per lane/model. Claude model variants are shown with descriptive labels from `supportedModels()`.

#### Chat Session Lifecycle

Agent chat sessions integrate into ADE's existing session tracking infrastructure:

```
1. User opens Chat view in Work Pane
   → agentChatService.createSession(laneId, provider, model)
   → Creates terminal_sessions row (tool_type: "codex-chat" or "claude-chat")
   → Codex: spawns app-server + thread/start
   → Claude: initializes messages[] + session state
   → Captures head_sha_start

2. User sends messages, agent works
   → agentChatService.sendMessage() yields ChatEvent stream
   → Events rendered in AgentChatMessageList
   → Chat events logged to .ade/transcripts/<session-id>.chat.jsonl
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
```

This lifecycle mirrors the PTY session lifecycle exactly, ensuring that chat sessions produce the same context artifacts (deltas, packs, checkpoints) as terminal sessions.

---

## Integration Points

### Desktop Application

- **AI integration service**: `apps/desktop/src/main/services/ai/aiIntegrationService.ts` -- provider detection, task routing, executor dispatch via `AgentExecutor`, streaming response handling.
- **Mission planning service**: `apps/desktop/src/main/services/missions/missionPlanningService.ts` -- builds planner prompts, dispatches to `ClaudeExecutor` or `CodexExecutor` for AI planning, normalizes plan output.
- **Orchestrator service**: `apps/desktop/src/main/services/orchestrator/orchestratorService.ts` -- run/step/attempt state machine, claim management, context snapshots, gate reports.
- **Agent chat service**: `apps/desktop/src/main/services/chat/agentChatService.ts` -- manages chat session lifecycle, spawns Codex app-server processes and Claude multi-turn sessions, maps provider events to ChatEvent streams, integrates with session tracking.
- **Bounded context exports**: `apps/desktop/src/main/services/packs/packExports.ts` -- builds Lite/Standard/Deep exports used as AI context inputs.
- **Configuration**: Provider settings read from `projectConfigService.ts` (merged shared + local config).
- **IPC channels**: `ade.ai.*` for AI streaming, `ade.missions.*` for mission lifecycle, `ade.orchestrator.*` for run management.

### Job Engine

The job engine handles background AI tasks that are triggered by system events:

- **Auto-narrative generation**: After a lane pack refresh, the job engine optionally triggers narrative generation via the AI integration service if a CLI subscription is available. This is a non-blocking async flow that does not interfere with the user's interactive workflow.
- **Conflict proposal generation**: When conflict prediction detects new or changed conflicts, the job engine can trigger AI-powered conflict resolution proposals.

The job engine does **not** coordinate orchestrator step transitions. The orchestrator service has its own tick-based scheduler for mission execution.

### Mission Service

The mission service (`missionService.ts`) provides the user-facing lifecycle for AI-driven work:

- **Mission creation**: Accepts a plain-English prompt, title, lane assignment, planner engine preference, and executor policy.
- **Planning dispatch**: Delegates to `missionPlanningService` which dispatches to the configured executor (`ClaudeExecutor` or `CodexExecutor`) for AI planning and surfaces structured planning failures instead of silently replacing strategy.
- **Step tracking**: Converts planner output into mission steps with independent status transitions.
- **Phase pipeline contracts (Task 3)**: Resolves mission phase profile/override, persists phase configuration, and annotates mission steps with phase identity metadata.
- **Phase transition audit (Task 3)**: Runtime phase changes emit durable `phase_transition` mission/timeline events and update run metadata (`phaseRuntime`) for operator inspection.
- **Profile lifecycle APIs (Task 3)**: list/save/delete/clone/import/export/getPhaseConfiguration/getDashboard contracts are exposed to renderer and automation surfaces.
- **Intervention management**: Creates, resolves, and dismisses intervention records when AI agents or the orchestrator need human input.
- **Artifact collection**: Links mission outcomes (PR URLs, generated files, test results) as artifacts.

### Pack Service

The pack service provides the context backbone for all AI operations:

- **Lane packs**: Deterministic snapshots of lane state (files changed, commits, diffs, test results) that serve as primary AI context.
- **Project packs**: Cross-lane summaries that give AI agents a view of the full workspace.
- **Token-budgeted exports**: Lite/Standard/Deep export tiers that bound context size for different AI task types.
- **Pack events**: Every AI-generated artifact (narrative, proposal, PR description) is recorded as a pack event for audit and versioning.

### Learning Packs

A new context pack type that automatically accumulates project-specific knowledge from agent interactions. Unlike static project packs, learning packs grow over time as agents work and users provide feedback.

**Knowledge sources** (automatic ingestion):
- Agent run failures: when an agent fails and is manually corrected, the correction is recorded as a learning entry
- User interventions: when a user interrupts an agent to correct its approach, the correction is inferred
- Repeated errors: when the same error pattern appears across 3+ separate agent sessions
- PR review patterns: when reviewers consistently request the same type of change

**Entry schema**:
```typescript
interface LearningEntry {
  id: string;
  category: 'mistake-pattern' | 'preference' | 'flaky-test' | 'tool-usage' | 'architecture-rule';
  scope: 'global' | 'directory' | 'file-pattern';
  scopePattern?: string;              // e.g., "src/auth/**"
  content: string;                    // Human-readable rule
  confidence: number;                 // 0-1, increases with observations
  observationCount: number;
  sources: string[];                  // Contributing mission/session IDs
  createdAt: string;
  updatedAt: string;
}
```

**Context injection**: Learning entries are included in the orchestrator and agent context window alongside project packs:
- Entries with confidence > 0.7: always included
- Entries with confidence 0.3-0.7: included when scope matches current task
- Entries with confidence < 0.3: excluded (still accumulating evidence)

**User controls**: Settings → Learning provides a review interface where users can confirm (boost confidence), edit, or delete entries. Confirmed entries immediately reach confidence 1.0.

**Export/Import**: Learning packs can be exported to CLAUDE.md or agents.md format, and rules from those files can be imported as high-confidence learning entries. This provides interoperability with standard agent configuration.

**Storage**: `learning_entries` SQLite table with full-text search index on `content` and `scopePattern` fields.

**Privacy**: Learning packs are local-only, stored in the project's `.ade/` directory, and never transmitted to any external service.

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Architecture design | Complete | Documented in this file |
| Mission planning via Claude CLI | Complete | `missionPlanningService.ts` -- spawns `claude -p` with JSON schema |
| Mission planning via Codex CLI | Complete | `missionPlanningService.ts` -- spawns `codex exec` with output schema |
| Coordinator-strategy deterministic fallback (runtime) | Removed | Coordinator owns strategy; unavailable coordinator pauses/escalates instead of deterministic replacement |
| Orchestrator state machine | Complete | `orchestratorService.ts` -- runs, steps, attempts, claims, gates, timeline |
| Executor adapter interface | Complete | `OrchestratorExecutorAdapter` type for pluggable step execution |
| Context snapshot system | Complete | Profile-based export assembly (deterministic, narrative-opt-in) |
| Bounded pack exports | Complete | Lite/Standard/Deep export tiers in `packExports.ts` |
| AgentExecutor interface | Complete | `apps/desktop/src/main/services/ai/agentExecutor.ts` |
| Agent SDK integration (dual-SDK) | Complete | `ClaudeExecutor` + `CodexExecutor` implemented |
| AI integration service | Complete | `apps/desktop/src/main/services/ai/aiIntegrationService.ts` |
| Per-task-type configuration | Complete | Configurable in `.ade/local.yaml` |
| Streaming AI responses to UI | Complete | IPC push events via `webContents.send` |
| AgentChatService interface | Complete | `apps/desktop/src/main/services/chat/agentChatService.ts` |
| CodexChatBackend (App Server) | Complete | JSON-RPC 2.0 client in `agentChatService.ts` |
| ClaudeChatBackend (community provider) | Complete | Multi-turn `streamText()` in `agentChatService.ts` |
| Chat UI components | Complete | AgentChatPane, AgentChatMessageList, AgentChatComposer |
| Chat session integration | Complete | `codex-chat` and `claude-chat` tool types in `terminal_sessions` |
| MCP server (`apps/mcp-server`) | Complete | JSON-RPC 2.0 server with 35 tools, dual-mode architecture (headless + embedded) |
| MCP dual-mode architecture | Complete | Transport abstraction (stdio/socket), headless AI via aiIntegrationService, desktop socket embedding (.ade/mcp.sock), smart entry point auto-detection |
| AI orchestrator (Claude + MCP) | In Progress | Tasks 1-6 shipped; remaining Phase 3 scope is Tasks 7-8 (reflection + integration soak) |
| Mission phase engine + profiles (Task 3) | Complete | `phase_cards`/`phase_profiles`/`mission_phase_overrides`, profile CRUD/import/export, phase transition telemetry |
| Mission UI overhaul (Task 4) | Complete | Plan/Work tabs, mission home dashboard, phase-aware details, launch/settings profile workflows |
| Pre-flight + intervention/HITL (Task 5) | Complete | Launch-gate checklist, granular worker-level interventions, coordinator `ask_user`/`request_user_input` escalation wiring |
| Budget + usage tracking (Task 6) | Complete | Mission budget service, subscription/API-key accounting, coordinator `get_budget_status`, details-tab budget telemetry |
| Agent-first runtime migration | In Progress | Non-interactive AI call paths are being normalized through runtime creation and policy enforcement |
| Call audit logging | Complete | Every MCP tool invocation writes durable `mcp_tool_call` history records |
| Permission/policy layer | Complete | Mutation tools enforce claim/identity policy; spawn and ask_user guards applied |
| Chat reasoning effort (Claude) | Complete | Reasoning effort forwarded to Claude provider when supported; validated for Codex |
| Compute backends (Local, VPS, Daytona) | Complete | `ComputeBackend` interface with pluggable backends |
| E2B compute backend | Planned | Phase 4 -- Firecracker microVM sandboxes via E2B SDK |
| Compute environment types | Planned | Phase 4 -- terminal-only, browser, and desktop environment support |
| Computer use MCP tools | Planned | Phase 4 -- `screenshot_environment`, `interact_gui`, `record_environment`, `launch_app`, `get_environment_info` |
| Learning packs | Planned | Phase 4 -- auto-accumulating project knowledge from agent interactions, failures, and PR review patterns |
| Memory architecture upgrade (sqlite-vec, hybrid search, composite scoring) | Planned | Phase 4 -- three-tier memory with vector search, pre-compaction flush, consolidation |
| CTO Agent | Planned | Phase 4 -- persistent project-aware agent, mission/lane orchestration, MCP entry point, intent classification, autonomous project management |
| External MCP consumption | Planned | Phase 4 -- agents connect to external MCP servers for extended capabilities |
| `.ade/` portable state | Planned | Phase 4 -- git-based cross-machine state sync, embedding regeneration on clone |
| Task agents (lane artifacts) | Planned | Phase 4 -- specialized agents for artifact production within lanes |
| Chat-to-mission escalation | Planned | Phase 4 -- promote a chat conversation into a full mission with pre-filled context |

**Overall status**: Phases 1, 1.5, and 2 are complete. Phase 3 orchestration Tasks 1-6 are shipped; remaining Phase 3 work is reflection protocol + integration soak coverage. MCP dual-mode architecture (WS8-WS11) shipped, enabling headless operation with full AI via `aiIntegrationService` and embedded proxy mode through the desktop socket at `.ade/mcp.sock`. Phase 4 focuses on agent-first runtime unification: all non-interactive AI surfaces execute through standardized agent runtimes with consistent memory policy, context assembly, and audit lineage.

---

## MCP Server as External Orchestration API

The MCP server (`apps/mcp-server`) has been overhauled from a 16-tool agent interface into a full **headless orchestration API** with 35 tools. This enables external consumers -- Claude Code, CI/CD pipelines, evaluation harnesses, and custom scripts -- to create, drive, observe, and evaluate missions without the desktop UI.

**Important architectural distinction**: The AI orchestrator does **not** use the MCP server. The orchestrator uses in-process Vercel AI SDK coordinator tools (in `coordinatorTools.ts`) registered directly with `streamText()`. The MCP server is the external-facing tool surface for:

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

#### Mission Lifecycle Tools (8)

| Tool | Description |
|------|-------------|
| `create_mission` | Create a new mission from a prompt |
| `start_mission` | Start planning and execution of a mission |
| `pause_mission` | Pause a running mission |
| `resume_mission` | Resume a paused mission |
| `cancel_mission` | Cancel a mission |
| `steer_mission` | Send a steering message to adjust mission direction |
| `approve_plan` | Approve a mission execution plan |
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
   Returns events like `step_started`, `step_completed`, `agent_spawned`, `intervention_requested`, etc. The cursor advances with each poll.

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
claude --dangerously-skip-permissions
```

The `--dangerously-skip-permissions` flag is required because ADE's MCP tools perform filesystem mutations (creating lanes, committing changes, writing files) that Claude Code's default permission model would block.

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

ADE uses SQLite (via sql.js WASM) with a single-writer model. If the desktop app and MCP server run simultaneously against the same project database, **SQLite write conflicts** will occur. To avoid this:

- Stop the desktop app before running the MCP server standalone in headless mode, or
- Use the MCP server in embedded mode (via `.ade/mcp.sock`), which shares the same database connection as the desktop app.
