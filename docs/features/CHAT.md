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
| `claude` | Claude Agent SDK V2 (`@anthropic-ai/claude-agent-sdk`) | Persistent session via `unstable_v2_createSession` — subprocess + MCP servers stay alive between turns. Supports inline image content blocks (base64) for image attachments. The Claude Code executable path is resolved via `claudeCodeExecutable.ts` and passed to the SDK at session creation. |
| `codex` | OpenAI Codex CLI | Persistent subprocess (`codex app-server`), communicates over JSON-RPC. Spawn failures are caught and surfaced as error events to the user, with the session ended gracefully rather than left in a broken state. |
| `unified` | Vercel AI SDK (`ai` package) | Covers OpenRouter, local models, any provider with an `ai`-compatible adapter |

Model selection is driven by `modelRegistry.ts`. The user picks a model
from the model picker; the service resolves a `ModelDescriptor` and
creates the right backend.

## Session Model

Every chat creates an `AgentChatSession`:

- **id** -- UUID, unique per session.
- **laneId** -- The lane the session belongs to. Lane context (branch,
  working directory) is injected into the agent's system prompt.
- **provider / model / modelId** -- What is powering the session. `model` stores the runtime-facing model token (for example `sonnet`, `gpt-5.4-codex`, or a direct API model id); `modelId` is the registry ID when ADE can resolve one.
- **status** -- `active | idle | ended`.
- **Permission controls** -- Provider-native fields control what the agent may do autonomously: `claudePermissionMode` (Claude), `codexApprovalPolicy`/`codexSandbox`/`codexConfigSource` (Codex), `unifiedPermissionMode` (unified/API). A session-level `permissionMode` field stores the abstract mode independently from the provider-native mapping.
- **identityKey** -- Optional. `"cto"` for the CTO agent, `"agent:<id>"`
  for named employees.
- **executionMode** -- `focused | parallel | subagents | teams`.
- **interactionMode** -- `default | plan`. When `plan`, the agent operates in a read-only planning mode where it proposes changes without executing them. Plan approval flows through a dedicated `plan_approval` pending input kind. When the user approves a plan, the session automatically transitions from `plan` to `edit` permission mode so the agent can begin implementing the approved plan. In `bypassPermissions` or `full-auto` permission modes, plan approval is auto-granted without showing the approval UI since the user has opted out of all permission gates.

Sessions persist their transcript and metadata to disk so they survive
app restarts. The `AgentChatSessionSummary` exposes title, goal,
cost/token usage, and a preview of the last output for the session list.

Individual agent turns are subject to a 5-minute timeout enforced via
the abort infrastructure. When a turn exceeds this limit, an error event
is emitted and the turn is terminated, preventing a single stalled
provider call from blocking the session indefinitely.

## Turn Interruption

Users can interrupt an in-flight turn via `interrupt()`. The behavior
is provider-specific:

- **Claude**: The runtime's `interrupted` flag is set, the warmup is
  cancelled, the active query is interrupted, and the V2 session is
  closed (it will be recreated on the next turn). The streaming loop
  checks the `interrupted` flag on each iteration and breaks cleanly
  rather than throwing from a closed session. All active subagents are
  transitioned from "running" to "stopped" by emitting a
  `subagent_result` event with `status: "stopped"` for each one,
  matching Claude Code CLI behaviour. The `activeSubagents` map is
  then cleared.
- **Codex**: The interrupt is forwarded to the app-server via the
  `turn/interrupt` JSON-RPC method. The turn completes with
  `status: "interrupted"`.
- **Unified**: The abort controller is signalled and all pending
  approval promises are auto-declined to prevent orphaned
  human-in-the-loop requests.

All providers implement an **idempotency guard**: if the runtime is
already interrupted, a second `interrupt()` call is a no-op. This
prevents duplicate side-effects from rapid cancel clicks.

### Text Batching

Streaming assistant text events from Codex and unified providers are
batched before emission to the renderer. The `chatTextBatching` module
accumulates text fragments for up to 100ms before flushing them as a
single assistant-text event. This reduces renderer re-render frequency
during fast streaming without introducing perceptible latency. The
buffer is also flushed immediately on non-text events (tool calls, turn
boundaries, errors) to preserve event ordering. When transcript entries
are read via `getRecentEntries`, any pending buffered text is flushed
first so the transcript always reflects the latest content.

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
| `memorySearch` | Semantic search over the project's episodic memory store. Also satisfies the turn-level memory guard. |
| `memoryAdd` | Persist a new memory (fact, decision, context). Returns `durability` (`candidate`, `promoted`, or `rejected`), tier, and dedup metadata. Emits `MemoryWriteEvent` callbacks for telemetry. |
| `memoryPin` | Pin a memory so it is always included in future context |

CTO and named-employee sessions additionally receive:

| Tool | Purpose |
|---|---|
| `memoryUpdateCore` | Overwrite the agent's core identity memory block (CTO writes to `ctoStateService`; workers write to their own core memory) |

Memory tool names are detected during system-prompt composition so the
prompt can include usage guidance only when the tools are actually present.

### Turn-Level Memory Guard

The chat service classifies each user turn by intent (required, soft, none) and when the turn is classified as `"required"` (mutating work like fix, debug, implement, refactor), mutating tools (bash, writeFile, editFile) are blocked until the agent has called `memorySearch`. This ensures agents consult project knowledge before making changes. The guard state is tracked via `TurnMemoryPolicyState` and resets per turn. See the [Memory Architecture doc](../architecture/MEMORY.md) for details.

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
| `prRefreshIssueInventory` | Fetch the latest checks, review threads, and comments for a PR so the agent can re-evaluate what still needs fixing |
| `prRerunFailedChecks` | Re-trigger failed GitHub Actions check runs after applying fixes |
| `prReplyToReviewThread` | Post a reply on a GitHub review thread |
| `prResolveReviewThread` | Mark a GitHub review thread as resolved |

These tools form the `workflowTools` tier, sitting between
`universalTools` (available to all agents) and `coordinatorTools`
(restricted to the mission orchestrator). The system prompt tells agents
what tools they have and guides them on when to use each capability.

The four PR issue resolution tools (`prRefreshIssueInventory`, `prRerunFailedChecks`, `prReplyToReviewThread`, `prResolveReviewThread`) are specifically designed for the PR issue resolution workflow, where an agent is launched to fix failing CI checks and/or address unresolved review threads on a pull request.

## Permission Modes

Permission controls are now provider-native rather than using a single unified enum. Each provider has its own control surface:

### Claude

`AgentChatClaudePermissionMode` controls Claude Agent SDK behavior:

| Mode | Behavior |
|---|---|
| `default` | Provider-native behavior (Claude CLI's built-in permission flow). |
| `plan` | Agent may only read/inspect. Writing or executing is blocked. |
| `acceptEdits` | Agent may read and write files but must ask before running shell commands. |
| `bypassPermissions` | Agent proceeds without asking. |

### Codex

Codex sessions have two independent controls:

- `AgentChatCodexApprovalPolicy`: `untrusted | on-request | on-failure | never`
- `AgentChatCodexSandbox`: `read-only | workspace-write | danger-full-access`
- `AgentChatCodexConfigSource`: `flags | config-toml` -- when `config-toml`, the approval policy and sandbox are deferred to the project's `.codex/config.toml`.

### Unified (API models)

`AgentChatUnifiedPermissionMode` maps to the in-process tool permission system:

| Mode | Behavior |
|---|---|
| `plan` | Agent may only read/inspect. |
| `edit` | Agent may read and write files. Bash commands are gated. |
| `full-auto` | Agent proceeds without asking. |

### Orchestrator Permission Mapping

The unified orchestrator adapter translates abstract permission modes (`plan`, `edit`, `full-auto`) into the correct provider-native fields via `mapPermissionModeToNativeFields()`. For Claude this maps to `claudePermissionMode`, for Codex to `codexApprovalPolicy`/`codexSandbox`, and for unified to `unifiedPermissionMode`. Chat sessions still persist an abstract `permissionMode` field alongside the provider-native controls so the UI can summarize session state and legacy flows can be normalized consistently.

All controls can be changed mid-session via `updateSession`.

## Pending Input System (Human-in-the-Loop)

When an agent needs human input -- either permission to proceed or answers to questions -- the service emits events that the renderer derives into `PendingInputRequest` objects. These are a unified abstraction across all providers:

- `requestId` -- unique identifier for the request.
- `source` -- `"claude" | "codex" | "unified" | "mission" | "ade"`.
- `kind` -- `"approval" | "question" | "structured_question" | "permissions" | "plan_approval"`.
- `questions` -- array of `PendingInputQuestion` with optional predefined options, freeform input, and impact descriptions.
- `blocking` / `canProceedWithoutAnswer` -- whether the agent is blocked or can continue with a default assumption.

The renderer derives pending inputs from the event stream via `derivePendingInputRequests()` (in `pendingInput.ts`), which replaces the previous `PendingApproval` model. The derivation function processes `approval_request` events (including embedded `PendingInputRequest` payloads in the detail field and legacy `askUser` tool calls) and `structured_question` events. A `done` event clears all pending inputs for that session. Tool results, command completions, and file changes auto-resolve their corresponding pending items.

The `AgentQuestionModal` renders the first pending input with Accept / Accept for Session / Decline / Cancel buttons and optional freeform text. User responses are sent back via the `respondToInput` IPC channel (which accepts `AgentChatRespondToInputArgs` with structured `answers` and optional `decision`), or the legacy `approve` channel for backward compatibility.

Plan approval requests carry the actual plan description text (extracted from the `ExitPlanMode` tool input) as the event description, so the UI can display meaningful content rather than a generic label. The message list renders plan approval cards in a scrollable container (max 288px) with pre-wrapped text to handle long multi-step plans.

If a Claude approval is resolved more than once (e.g., due to a UI double-click, an interrupted turn, or stale state), the service logs a warning and returns silently instead of throwing. This prevents spurious errors from surfacing to the user when approvals have already been consumed.

Codex `permissions` requests and Claude `structured_question` events both flow through the same pending input abstraction.

## Chat Transcript and Work Log

The chat message list renders events through a two-layer pipeline defined in `chatTranscriptRows.ts`:

1. **Render events** -- Raw `AgentChatEventEnvelope` events are mapped to `ChatTranscriptRenderEvent` values. Tool calls, commands, file changes, and web searches are collapsed into `ChatWorkLogEntry` objects (with status, label, diff stats, and output). Text, reasoning, plans, user messages, status updates, and other visible events pass through directly.

2. **Grouped envelopes** -- Adjacent work log entries in the same turn are grouped into `work_log_group` blocks so the message list can render them as a single collapsible card (`ChatWorkLogBlock`) rather than individual rows. This keeps the transcript compact when the agent performs many tool operations in a single turn.

Each work log entry carries a `collapseKey` derived from the turn, logical item identity (`logicalItemId` when present, otherwise `itemId`), and tool/command identity. Streaming updates for the same tool call or command merge into the existing entry rather than appending new rows.

Adjacent assistant text events are merged using `shouldMergeTextRows()`, which compares `messageId`, `turnId`, and `itemId` fields to decide whether two text fragments belong to the same logical message. Events with matching `messageId` values always merge; events without `messageId` fall back to turn/item identity. This prevents duplicate text rows when the streaming backend emits fragmented text events.

The `ChatWorkLogBlock` component renders grouped entries with:

- Collapsible header showing entry count and a summary of operations
- Per-entry rows with tool/command icons, labels, status indicators, and expandable detail sections
- File change summaries with addition/deletion counts
- Operator navigation suggestions extracted from tool results (linking to Work, Missions, Lanes, or CTO surfaces)

## Model Handoff

When a user switches model families mid-session (e.g., from Claude to Codex), the chat service performs a session handoff via `handoffSession`. The current session is summarized, ended gracefully, and a new session is created with the target model. The handoff preserves context by injecting the summarized transcript into the new session. The `AgentChatHandoffResult` reports whether a fallback summary was used.

## Where Chat Lives in the UI

- **Run tab sidebar** -- Each lane can have one or more chat sessions.
  The `AgentChatPane` component renders the message list, composer, and
  approval modal. Users create sessions from the lane's chat panel.
  When a new session is created, the pane awaits the `onSessionCreated`
  callback and the session-list refresh before sending the first agent
  turn. This ensures the parent surface has navigated to the chat tab
  before the turn starts, preventing a blank "new chat" screen.
- **CTO tab** -- The CTO's persistent chat session is embedded in the
  CTO surface. It uses the same `AgentChatPane` with a
  `persistent_identity` profile, giving it a distinct visual treatment.
- **Mission threads** -- Mission-scoped views adapt chat events through
  `missionThreadEventAdapter` so they render in the mission feed format.

### Chat Header

The chat header title is derived from the active session. When a session
is selected, the title is the session's own title (via
`chatSessionTitle()`). When no session exists yet, the header shows
"New chat". CTO and resolver surfaces override the title via
`ChatSurfacePresentation`.

When the chat pane is associated with a lane, the header displays a lane
navigation button showing the lane's label with a branch icon. Clicking
it selects the lane in the app store and navigates to the Lanes tab.
The lane label is passed into `AgentChatPane` via the `laneLabel` prop
from `TilingLayout` and `WorkViewArea`.

The composer (`AgentChatComposer`) supports file/image attachments,
model switching, reasoning-effort control, context-pack injection, and
slash commands sourced from the active SDK session. The `@` key opens
an inline file attachment picker with debounced search and stale-result
discarding. Permission controls are rendered inline with an interaction
mode selector (`default` / `plan`) and provider-native controls: Claude
permission mode, Codex preset modes (Plan / Guarded Edit / Full Auto,
with custom/config-toml state surfaced as a summary row rather than raw
inline dropdowns), and unified permission mode. Before a Claude SDK
session is initialized, ADE exposes local slash commands such as
`/clear` and `/login`; once the SDK is ready, its slash commands are
merged into the picker.

## Image Attachments

Image attachments are supported across all providers, with
provider-specific handling:

- **Claude V2**: Images are sent as inline base64 content blocks
  directly to the Anthropic API via `buildClaudeV2Message()`. Supported
  MIME types: `image/jpeg`, `image/png`, `image/gif`, `image/webp`.
- **Codex**: Images are sent via `localImage` path references.
- **Unified**: Images are sent as Vercel AI SDK `ImagePart` content
  blocks.

The composer saves pasted or dropped images to a temporary location via
the `saveTempAttachment` IPC handler. Temporary attachments are capped
at 10 MB, and the service validates MIME types before sending to each
provider.

## Session Identity Propagation

Each chat session propagates a `chatSessionId` to the MCP server via
the `ADE_CHAT_SESSION_ID` environment variable. This links MCP tool
calls (especially computer use artifact ingestion) back to the
originating chat session. The MCP server resolves the chat session
owner through a cascade: explicit tool argument, session identity
field, and finally an implicit fallback for standalone chat sessions
(no mission/run/step context) using the caller ID.

## Session Continuity

Chat sessions persist their state to disk so they survive app restarts.
The persisted state (version 2) includes recent conversation entries,
a continuity summary, preferred/selected execution lane IDs, and the
full provider runtime state. When a session resumes, the service
reconstructs context from persisted entries and injects the continuity
summary so the agent retains awareness of prior turns.

Codex sessions deduplicate runtime notifications to prevent duplicate
event processing when the subprocess emits repeated item/turn lifecycle
events.

## Virtual Scrolling

The message list (`AgentChatMessageList`) uses `@tanstack/react-virtual`
for virtualized rendering of long transcripts. This keeps render cost
proportional to the visible viewport rather than the total message count.
Turn dividers (`ChatTurnDivider`) separate consecutive turns with
contextual labels. Code blocks in assistant messages use a dedicated
`HighlightedCode` component.

## Diagnostic Logging

Chat runtime startup emits structured diagnostic logs that include MCP
launch mode, resolved entry path, socket path, packaged-build status,
and the Claude executable path. Codex runtime startup logs include the
working directory and shell environment. Claude V2 prewarm failures
include MCP launch details for troubleshooting. These diagnostics make
it possible to isolate packaging or PATH-related failures without
attaching a debugger.

## Identity Session Filtering

CTO and worker identity sessions (those with an `identityKey`) are
excluded from the Work tab session list. These sessions are managed
through their own dedicated surfaces (CTO tab, worker detail views)
and do not appear alongside regular lane chat sessions.
