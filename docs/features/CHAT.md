# Agent Chat

Agent Chat provides interactive AI coding sessions directly inside ADE.
Each chat is a first-class object: it belongs to a lane, records a full
transcript, and exposes the same tool surface the agent would get in a
headless run. Users can talk to an agent the same way they would use an
IDE-integrated copilot, but with ADE's lane/session tracking layered on top.

## Supported Providers and Runtimes

Chat sessions are provider-agnostic. The `AgentChatProvider` type accepts:

| Provider key | Runtime | Notes |
|---|---|---|
| `claude` | Claude Agent SDK V2 (`@anthropic-ai/claude-agent-sdk`) | Persistent session via `unstable_v2_createSession` — subprocess + MCP servers stay alive between turns |
| `codex` | OpenAI Codex CLI | Persistent subprocess, communicates over JSON-RPC |
| `unified` | Vercel AI SDK (`ai` package) | Covers OpenRouter, local models, any provider with an `ai`-compatible adapter |

Model selection is driven by `modelRegistry.ts`. The user picks a model
from the model picker; the service resolves a `ModelDescriptor` and
creates the right backend.

## Session Model

Every chat creates an `AgentChatSession`:

- **id** -- UUID, unique per session.
- **laneId** -- The lane the session belongs to. Lane context (branch,
  working directory) is injected into the agent's system prompt.
- **provider / model / modelId** -- What is powering the session.
- **status** -- `active | idle | ended`.
- **permissionMode** -- Controls what the agent may do autonomously.
- **identityKey** -- Optional. `"cto"` for the CTO agent, `"agent:<id>"`
  for named employees.
- **executionMode** -- `focused | parallel | subagents | teams`.

Sessions persist their transcript and metadata to disk so they survive
app restarts. The `AgentChatSessionSummary` exposes title, goal,
cost/token usage, and a preview of the last output for the session list.

Individual agent turns are subject to a 5-minute timeout enforced via
the abort infrastructure. When a turn exceeds this limit, an error event
is emitted and the turn is terminated, preventing a single stalled
provider call from blocking the session indefinitely.

## CTO Chat vs. Regular Chat

A regular chat is an ephemeral coding assistant scoped to a lane.
The CTO chat is different in several ways:

1. **Persistent identity** -- The CTO session carries
   `identityKey: "cto"` and `sessionProfile: "persistent_identity"`.
   It is presented with a distinct `ChatSurfaceProfile` so the UI can
   render it differently (accent color, chips, title).
2. **Core memory reconstruction** -- When a CTO session starts (or
   resumes), the service pulls the CTO's core memory from
   `ctoStateService` and injects it into the system prompt. This gives
   the CTO continuity across sessions.
3. **Extra tooling** -- CTO sessions receive the `memoryUpdateCore` tool
   in addition to the standard memory tools, allowing the CTO to update
   its own persistent identity notes.
4. **Guarded permission mode** -- For the Claude provider the CTO
   defaults to `"default"` (ask before dangerous ops); for unified
   providers it defaults to `"edit"`. `full-auto` is only applied when
   explicitly requested.

## Memory Integration

All chat agents -- not just the CTO -- have access to memory tools when
a `memoryService` is available:

| Tool | Purpose |
|---|---|
| `memorySearch` | Semantic search over the project's episodic memory store |
| `memoryAdd` | Persist a new memory (fact, decision, context) |
| `memoryPin` | Pin a memory so it is always included in future context |

CTO and named-employee sessions additionally receive:

| Tool | Purpose |
|---|---|
| `memoryUpdateCore` | Overwrite the agent's core identity memory block (CTO writes to `ctoStateService`; workers write to their own core memory) |

Memory tool names are detected during system-prompt composition so the
prompt can include usage guidance only when the tools are actually present.

### Compaction Flush

When a chat session approaches its context window limit, the compaction
flush service injects a hidden system message prompting the agent to
persist important observations via `memoryAdd` before context is
compacted. This ensures durable discoveries are not lost to compaction.
The flush prompt includes explicit SAVE/DO-NOT-SAVE guidance to keep
memory quality high.

## Workflow Tools

Chat agents (CTO, employees, and regular chat sessions) have access to
workflow tools that enable them to take actions beyond conversation:

| Tool | Purpose |
|---|---|
| `createLane` | Create a new lane with a worktree for implementation work |
| `createPR` | Create a pull request from a lane's changes |
| `captureScreenshot` | Capture a screenshot of the current environment (when runtime supports it) |
| `reportCompletion` | Persist a structured closeout report for the chat session, including status, summary, and produced artifacts |

These tools form the `workflowTools` tier, sitting between
`universalTools` (available to all agents) and `coordinatorTools`
(restricted to the mission orchestrator). The system prompt tells agents
what tools they have and guides them on when to use each capability.

## Permission Modes

The `AgentChatPermissionMode` controls human-in-the-loop gating:

| Mode | Behavior |
|---|---|
| `plan` | Agent may only read/inspect. Writing or executing is blocked. Used for planning-only workers. |
| `edit` | Agent may read and write files but must ask before running shell commands. |
| `full-auto` | Agent proceeds without asking. Approval requests are auto-accepted. |
| `default` | Provider-native behavior (Claude CLI's built-in permission flow). |
| `config-toml` | Defers to the project's `.claude/config.toml` settings. |

The mode can be changed mid-session via `updateSession`.

## Approval Flow (Human-in-the-Loop)

When an agent operating below `full-auto` wants to perform a gated
action, the service emits an `approval_request` event containing:

- `itemId` -- opaque identifier the agent is waiting on.
- `kind` -- `"command" | "file_change" | "tool_call"`.
- `description` -- human-readable explanation of what the agent wants.

The renderer shows an **AgentQuestionModal** with Accept / Accept for
Session / Decline / Cancel buttons. The user's decision is sent back as
an `AgentChatApprovalDecision`, and the agent resumes or aborts
accordingly.

For `structured_question` events (the agent needs clarification, not
permission), the same modal is reused with free-text input or
predefined option buttons.

## Where Chat Lives in the UI

- **Run tab sidebar** -- Each lane can have one or more chat sessions.
  The `AgentChatPane` component renders the message list, composer, and
  approval modal. Users create sessions from the lane's chat panel.
- **CTO tab** -- The CTO's persistent chat session is embedded in the
  CTO surface. It uses the same `AgentChatPane` with a
  `persistent_identity` profile, giving it a distinct visual treatment.
- **Mission threads** -- Mission-scoped views adapt chat events through
  `missionThreadEventAdapter` so they render in the mission feed format.

The composer (`AgentChatComposer`) supports file/image attachments,
model switching, reasoning-effort control, context-pack injection, and
slash commands sourced from the active SDK session.
