# AI Integration Architecture

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-19

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

The AI Orchestrator is the intelligent coordination layer that plans and executes multi-step missions. It is implemented as a Claude session with the MCP server connected, running on top of the deterministic orchestrator service state machine.

#### Architecture

```
Mission prompt + context packs
        │
        ▼
┌─────────────────────────────┐
│  AI Orchestrator            │
│  (Claude session + MCP)     │
│                             │
│  ┌────────────┐             │
│  │  Planner   │ ──> step plan (JSON schema-enforced)
│  └────────────┘             │
│        │                    │
│        ▼                    │
│  ┌────────────┐             │
│  │  Scheduler │ ──> dispatches steps via AgentExecutor interface
│  └────────────┘             │
│        │                    │
│  ┌─────┴─────┐              │
│  ▼           ▼              │
│ Step A     Step B           │ (parallel in separate lanes)
│  │           │              │
│  ▼           ▼              │
│ ┌─────────────────────────┐ │
│ │    AgentExecutor        │ │  <── ADE's abstraction layer
│ │  ┌─────────┬──────────┐ │ │
│ │  │ Claude  │  Codex   │ │ │
│ │  │Executor │ Executor │ │ │
│ │  └────┬────┴────┬─────┘ │ │
│ │       │         │       │ │
│ │       ▼         ▼       │ │
│ │  ai-sdk-   @openai/    │ │
│ │  provider  codex-sdk   │ │
│ │  -claude-  (official)  │ │
│ │  code                  │ │
│ │  (community)           │ │
│ └─────────────────────────┘ │
│        │                    │
│  ┌─────┴─────┐              │
│  ▼           ▼              │
│ claude     codex            │  (CLI subprocesses)
│  CLI        CLI             │
│  │           │              │
│  ▼           ▼              │
│  ┌────────────┐             │
│  │  Monitor   │ ──> gate reports, claim heartbeats
│  └────────────┘             │
│        │                    │
│        ▼                    │
│  Results / Interventions    │
└─────────────────────────────┘
        │
        ▼
Orchestrator service (durable state machine)
        │
        ▼
Mission service (user-facing lifecycle)
```

#### Planning Phase

When a mission is created, the orchestrator's planning phase:

1. Receives the mission prompt, title, and any attached context.
2. Assembles a context bundle: project pack digest, docs digest, operation summary, constraints.
3. Builds a structured planner prompt and invokes the configured planning executor (`ClaudeExecutor` or `CodexExecutor`).
4. The planner returns a JSON plan conforming to the mission plan schema, including:
   - Mission summary (domain, complexity, strategy, parallelism cap)
   - Assumptions and risks
   - Ordered steps with dependencies, executor hints, claim policies, and output contracts
   - Handoff policy for conflict resolution
5. The plan is validated, normalized, and converted into orchestrator run steps.

If the AI planner fails (CLI unavailable, timeout, invalid output), the system falls back to a deterministic planner that uses keyword classification to generate a reasonable step plan.

#### Step Execution

For each step in the plan, the orchestrator:

1. Checks dependency satisfaction (all predecessor steps completed successfully, or join policy allows continuation).
2. Acquires claims on the required scopes (lane, file patterns, environment keys).
3. Creates a context snapshot with the appropriate export level for the step.
4. Dispatches the step to the appropriate `AgentExecutor` implementation matching the step's `executorKind`:
   - `claude`: `ClaudeExecutor` spawns a Claude CLI process via `ai-sdk-provider-claude-code` with the step's prompt and context.
   - `codex`: `CodexExecutor` spawns a Codex CLI process via `@openai/codex-sdk` with the step's prompt and context in a sandboxed lane worktree.
   - `shell`: Runs a shell command (for deterministic steps like test execution).
   - `manual`: Waits for user action (for steps requiring human judgment).
5. Monitors the attempt via session tracking and claim heartbeats.
6. On completion, records the result envelope and releases claims.

#### Context Window Management

The orchestrator manages AI context budgets through ADE's pack export system:

- **Lite exports** (~2K tokens): Lane metadata, file list, recent commits. Used for quick status checks.
- **Standard exports** (~8K tokens): Lite content plus file-level diffs, test results, and conflict state. Used for most planning and review tasks.
- **Deep exports** (~32K tokens): Standard content plus full file contents for key files, detailed transcript excerpts, and narrative history. Used for complex implementation steps.

Each step in a plan specifies its `requiresContextProfiles` field, and the orchestrator assembles the appropriate export before dispatching the step.

#### Intervention Routing

When an AI agent encounters a situation requiring human input, it invokes the `ask_user` MCP tool. The orchestrator:

1. Pauses the current step's attempt.
2. Creates an intervention record in the mission service.
3. Broadcasts an intervention event to the renderer via IPC.
4. The UI displays the intervention in the mission detail view with the agent's question and context.
5. When the user responds, the intervention is resolved and the orchestrator resumes the step.

Interventions can also be triggered automatically when:
- A step fails and exceeds its retry limit.
- A conflict is detected between agent lanes.
- A gate report indicates a blocking condition (e.g., failing tests).

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

---

## Integration Points

### Desktop Application

- **AI integration service**: `apps/desktop/src/main/services/ai/aiIntegrationService.ts` -- provider detection, task routing, executor dispatch via `AgentExecutor`, streaming response handling.
- **Mission planning service**: `apps/desktop/src/main/services/missions/missionPlanningService.ts` -- builds planner prompts, dispatches to `ClaudeExecutor` or `CodexExecutor` for AI planning, normalizes plan output.
- **Orchestrator service**: `apps/desktop/src/main/services/orchestrator/orchestratorService.ts` -- run/step/attempt state machine, claim management, context snapshots, gate reports.
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
| AgentExecutor interface | Planned | Thin abstraction over both executor SDKs (`ClaudeExecutor`, `CodexExecutor`) |
| Agent SDK integration (dual-SDK) | Planned | Claude via `ai-sdk-provider-claude-code`; Codex via `@openai/codex-sdk` |
| MCP server (`apps/mcp-server`) | Planned | stdio transport, tool definitions, resource providers |
| AI orchestrator (Claude + MCP) | Planned | Claude session coordinating multi-step mission execution |
| AI integration service | Planned | Unified service replacing hosted/BYOK services |
| Per-task-type configuration | Planned | `.ade/local.yaml` task-type routing settings |
| Call audit logging | Planned | MCP tool call logging to orchestrator timeline |
| Permission/policy layer | Planned | Claim-based mutation authorization for MCP tools |
| Streaming AI responses to UI | Planned | IPC push events for real-time token delivery |

**Overall status**: Core mission planning and orchestrator infrastructure are complete. The dual-SDK agent integration (`AgentExecutor` interface, `ClaudeExecutor`, `CodexExecutor`), MCP server, and AI orchestrator represent the next implementation phase that will connect the planning layer to live agent execution.
