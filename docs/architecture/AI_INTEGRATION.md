# AI Integration Architecture

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-20

The AI integration layer replaces the previous hosted agent with a local-first, subscription-powered approach. Instead of a cloud backend with API keys and remote job queues, ADE spawns `claude` and `codex` CLI processes that inherit the user's existing subscriptions, coordinates them through an MCP server, and manages multi-step workflows via an AI orchestrator.

---

## Table of Contents

- [Overview](#overview)
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
  - [AI Orchestrator](#ai-orchestrator)
  - [Per-Task-Type Configuration](#per-task-type-configuration)
  - [One-Shot AI Task Patterns](#one-shot-ai-task-patterns)
  - [Agent Chat Service (Phase 1.5)](#agent-chat-service-phase-15)
- [Integration Points](#integration-points)
  - [Desktop Application](#desktop-application)
  - [Job Engine](#job-engine)
  - [Mission Service](#mission-service)
  - [Pack Service](#pack-service)
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

Simple AI tasks (generate a narrative, draft a PR description) can be handled as one-shot requests. But missions -- multi-step workflows that span planning, implementation, testing, and integration -- require coordination:

- **Step sequencing**: Some steps depend on others (tests must run after implementation).
- **Parallel execution**: Independent steps should run concurrently in separate lanes.
- **Context management**: Each step needs relevant context without exceeding token budgets.
- **Failure handling**: Failed steps need retry logic, intervention routing, or graceful degradation.
- **Conflict prevention**: Agents working in parallel must not create merge conflicts.

The AI Orchestrator is a Claude session connected to the MCP server that handles this coordination. It receives a mission prompt, plans the execution strategy, spawns agents for each step, monitors progress through gate reports and claim heartbeats, and routes interventions to the user when human input is required.

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

- **Protocol**: JSON-RPC 2.0 over stdio
- **Lifecycle**: Spawned as a child process by the AI integration service, one instance per orchestrator run
- **Communication**: AI processes connect to the MCP server's stdin/stdout pipes

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

If the AI planner fails (CLI unavailable, timeout, invalid output), the system falls back to a deterministic planner that uses keyword classification to generate a reasonable step plan.

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

If no CLI tool is available, the task either falls back to deterministic processing (for planning) or is skipped with a clear message to the user (for generation tasks).

### One-Shot AI Task Patterns

Most Phase 1 AI tasks are one-shot: send a prompt with context, receive a result, done. No multi-turn conversation is needed.

#### Pattern: One-Shot via AgentExecutor

```typescript
// Narrative generation — one-shot, no follow-up
async function generateNarrative(lanePack: LaneExportStandard): Promise<string> {
  const executor = this.getExecutor("narrative"); // resolves to ClaudeExecutor or CodexExecutor
  const events = executor.execute(
    buildNarrativePrompt(lanePack),
    {
      cwd: lanePack.worktreePath,
      contextPack: lanePack,
      oneShot: true,
      timeoutMs: 15000,
      permissions: { mode: "read-only" },
      jsonSchema: narrativeOutputSchema,
    }
  );

  let result = "";
  for await (const event of events) {
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
| Mission planning | Mission prompt + project context | Step plan JSON | One-shot (may become multi-turn in Phase 3) |

None of these tasks require a conversational back-and-forth. The AI receives context, produces a result, and the session ends. Multi-turn orchestration is deferred to Phase 3 (AI Orchestrator).

#### CLI vs SDK Boundary

**SDK (programmatic, invisible to user)**: All one-shot AI tasks listed above. The user never sees a terminal or CLI output -- results are processed by ADE services and displayed in the appropriate UI surface.

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
   → onSessionEnded callback fires → job engine, pack refresh, automations

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
- **Planning dispatch**: Delegates to `missionPlanningService` which dispatches to the configured executor (`ClaudeExecutor` or `CodexExecutor`) for AI planning or falls back to the deterministic planner.
- **Step tracking**: Converts planner output into mission steps with independent status transitions.
- **Intervention management**: Creates, resolves, and dismisses intervention records when AI agents or the orchestrator need human input.
- **Artifact collection**: Links mission outcomes (PR URLs, generated files, test results) as artifacts.

### Pack Service

The pack service provides the context backbone for all AI operations:

- **Lane packs**: Deterministic snapshots of lane state (files changed, commits, diffs, test results) that serve as primary AI context.
- **Project packs**: Cross-lane summaries that give AI agents a view of the full workspace.
- **Token-budgeted exports**: Lite/Standard/Deep export tiers that bound context size for different AI task types.
- **Pack events**: Every AI-generated artifact (narrative, proposal, PR description) is recorded as a pack event for audit and versioning.

---

## Implementation Status

| Component | Status | Notes |
|-----------|--------|-------|
| Architecture design | Complete | Documented in this file |
| Mission planning via Claude CLI | Complete | `missionPlanningService.ts` -- spawns `claude -p` with JSON schema |
| Mission planning via Codex CLI | Complete | `missionPlanningService.ts` -- spawns `codex exec` with output schema |
| Deterministic planner fallback | Complete | `missionPlanner.ts` -- keyword classification when no CLI available |
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
| MCP server (`apps/mcp-server`) | Complete | JSON-RPC 2.0 stdio server with Phase 2 tool/resource surface |
| AI orchestrator (Claude + MCP) | Planned | Phase 3 -- leader/worker agent team architecture with shared task list, plan approval gates, file conflict prevention, lane merging, and six coordination patterns |
| Call audit logging | Complete | Every MCP tool invocation writes durable `mcp_tool_call` history records |
| Permission/policy layer | Complete | Mutation tools enforce claim/identity policy; spawn and ask_user guards applied |
| Chat reasoning effort (Claude) | Complete | Reasoning effort forwarded to Claude provider when supported; validated for Codex |

**Overall status**: Phases 1, 1.5, and 2 are complete. ADE now ships dual-SDK execution, native chat integration, and a production MCP bridge (`apps/mcp-server`) with policy enforcement and durable audit logging. Phase 3 (AI orchestrator with leader/worker agent team architecture) is the next implementation target. The orchestrator specification has been enriched with concrete team coordination patterns (shared task lists, plan approval gates, file conflict prevention, worker lifecycle management) informed by Claude Code's agent teams model.
