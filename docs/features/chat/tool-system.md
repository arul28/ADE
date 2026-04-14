# Tool System

Agents exposed through chat get three tiers of tools: **universal**,
**workflow**, and **coordinator**. Each tier is scoped to a role so a
regular chat session cannot, for example, start a mission or force a
worker to respawn.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/ai/tools/executableTool.ts` | Thin wrapper around Zod + a handler function. Produces the common tool interface the Claude/Codex/OpenCode adapters consume. |
| `apps/desktop/src/main/services/ai/tools/universalTools.ts` | Read, write, bash, memory search/add/pin/updateCore, todo, web fetch/search, ask-user. Available to every agent. |
| `apps/desktop/src/main/services/ai/tools/memoryTools.ts` | `memorySearch`, `memoryAdd`, `memoryPin` builders. Imported by `universalTools.ts`. |
| `apps/desktop/src/main/services/ai/tools/workflowTools.ts` | `createLane`, `createPrFromLane`, `captureScreenshot`, `reportCompletion`, and the four PR issue-resolution tools. |
| `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` | CTO-only: `spawnChat`, worker management, Linear dispatch, pipeline settings, issue inventory. |
| `apps/desktop/src/main/services/ai/tools/linearTools.ts` | Linear-only tools for CTO when Linear is connected. |
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | `buildCodingAgentSystemPrompt` -- renders the top-of-context system prompt; adapts wording based on which tool names are present. |
| `apps/desktop/src/main/services/ai/toolExposurePolicy.ts` | Filters tools by context (e.g., frontend-repo discovery tools). |
| `apps/desktop/src/main/services/ai/tools/readFileRange.ts` / `grepSearch.ts` / `globSearch.ts` / `editFile.ts` | Primitive file/search tools used by every agent. |
| `apps/desktop/src/main/services/ai/tools/webFetch.ts` / `webSearch.ts` | Web access tools. |

## Tier 1: universal tools

Available to every agent (CTO, workers, regular chat, coordinator).
Built by `createUniversalToolSet()` in `universalTools.ts`.

| Tool | Purpose | Gate |
|---|---|---|
| `readFile` | Range-aware file reader built on `readFileRange.ts`. | Read-only; allowed in every permission mode. |
| `editFile` | Single-file editor; produces a `file_change` event. | Blocked in `plan` mode. |
| `writeFile` | Create or replace a file. | Blocked in `plan` mode. |
| `bash` | Shell command with configurable sandbox. Emits `command` events. | Blocked in `plan`; sandboxed per `WorkerSandboxConfig` for API/local models; CLI-wrapped models delegate to the CLI's own gating. |
| `grep`, `glob` | Search tools backed by `grepSearch.ts` / `globSearch.ts`. | Read-only. |
| `memorySearch`, `memoryAdd`, `memoryPin`, `memoryUpdateCore` | Memory tools. See [Memory tools](#memory-tools). | Always allowed; `memoryUpdateCore` only exposed to CTO/worker identity sessions. |
| `webFetch`, `webSearch` | Web tools; backed by `webFetch.ts` and `webSearch.ts`. | Always allowed. |
| `askUser` (universal form) | Legacy ask-user helper. Claude V2 uses its native `AskUserQuestion` tool instead; see [ask-user](#ask-user-handling). | Always allowed. |
| `TodoWrite`, `TodoRead` | Session-state todo list. Writes emit `todo_update` events. | Always allowed. |

### Memory tools

`memoryTools.ts` defines:

- `memorySearch({ query, scope?, scopeOwnerId?, limit? })` -- Queries the
  unified memory store. Satisfies the turn-level memory guard
  (`TurnMemoryPolicyState.explicitSearchPerformed = true`).
- `memoryAdd({ content, category, scope?, scopeOwnerId?, importance?,
  pin?, writeMode? })` -- Writes a new memory. Returns `durability`
  (`candidate | promoted | rejected`), `tier`, and dedup metadata.
  Emits a `MemoryWriteEvent` callback so `agentChatService` can surface
  write status in the UI.
- `memoryPin({ id })` -- Pin to Tier 1.

`memoryUpdateCore` is a variant built from `UniversalToolSetOptions.onMemoryUpdateCore`; it
lets CTO and worker identity sessions rewrite their `CtoCoreMemory` /
`AgentCoreMemory` block.

The system prompt inspects tool names at build time; if memory tools are
present, the prompt includes usage guidance (when to search, when to
add, what not to add).

### Turn-level memory guard

`universalTools.ts` accepts `turnMemoryPolicyState`:

```ts
type TurnMemoryPolicyState = {
  classification: "none" | "soft" | "required";
  orientationSatisfied: boolean;
  explicitSearchPerformed: boolean;
};
```

`agentChatService` classifies each user turn by intent and, when the
turn is `required`, blocks `bash`, `writeFile`, and `editFile` until
`memorySearch` has been called. The gate reads
`explicitSearchPerformed` (set by `memorySearch`). See the [Memory
README](../memory/README.md) for the policy itself.

### Permission gate

`PermissionMode` (`plan | edit | full-auto`) maps to tool categories
(`read`, `write`, `bash`). The gate rejects writes and bash in `plan`
mode. `edit` requires `onApprovalRequest` to return `{ approved: true }`
for bash (or for writes on hosted workers without the session-level
approval flag set).

`full-auto` proceeds without asking, but writes and bash still emit
`approval_request` events for post-hoc user review when the session is
interactive.

### Ask-user handling

The universal `askUser` tool hands control to the `onAskUser`
callback. `agentChatService` implements it by:

1. Translating the input into a `PendingInputRequest`.
2. Emitting `approval_request` / `structured_question` events so the
   renderer surfaces the question inline.
3. Pausing the idle watchdog.
4. Awaiting the user's response via `ade.agentChat.respondToInput`.
5. Returning the answer string to the tool caller.

Claude V2 uses its native `AskUserQuestion` SDK tool, which is plumbed
through the same pending-input abstraction (see
[transcript-and-turns](transcript-and-turns.md)).

## Tier 2: workflow tools

Available to chat agents (CTO, named employees, regular chat sessions).
Not exposed to headless mission workers. Built by `createWorkflowTools()`
in `workflowTools.ts`.

| Tool | Purpose |
|---|---|
| `createLane({ name, description?, parentLaneId? })` | Creates a new lane (git worktree + branch). Returns lane id, branch ref, worktree path. |
| `createPrFromLane({ laneId, title?, body? })` | Creates a pull request from the lane's changes. |
| `captureScreenshot()` | Screenshots the current environment. Gated by `ComputerUsePolicy` (must be enabled + allow local fallback, unless a remote backend is wired). |
| `reportCompletion({ status, summary, artifacts, blockerDescription? })` | Persists an `AgentChatCompletionReport` on the session. Renders a closeout card in the transcript. |
| `prRefreshIssueInventory({ prNumber })` | Refreshes checks, review threads, and comments for a PR. |
| `prRerunFailedChecks({ prNumber })` | Re-triggers failed GitHub Actions check runs. |
| `prReplyToReviewThread({ threadId, body })` | Posts a reply on a GitHub review thread. |
| `prResolveReviewThread({ threadId })` | Marks a review thread as resolved. |

### PR issue resolution

The four `pr*` tools are specifically designed for the PR issue
resolution workflow, where a chat is launched to fix failing CI checks
and unresolved review threads. Availability is checked via
`getPrIssueResolutionAvailability()` in
`apps/desktop/src/shared/prIssueResolution.ts`.

When a CTO spawns a chat via `launchPrIssueResolutionChat` (see
`apps/desktop/src/main/services/prs/prIssueResolver.ts`), the spawned
chat gets these four tools in its palette.

### Computer-use gate

`captureScreenshot` consults `WorkflowToolDeps.computerUsePolicy`:

- `isComputerUseModeEnabled(policy.mode)` must be true.
- `policy.allowLocalFallback` controls whether the local screenshot
  path is allowed; otherwise the tool errors and defers to the remote
  artifact broker.

## Tier 3: coordinator tools

Available only to the mission orchestrator agent. Not covered in this
doc; see the missions area. Chat agents do not receive these, and
`agentChatService` filters them out when provisioning a chat session
that happens to share a provider runtime with orchestrator code.

## CTO operator tools

Sessions with `identityKey: "cto"` additionally receive the CTO operator
tools from `ctoOperatorTools.ts`. These are the control plane the CTO
uses to act on ADE itself:

| Tool family | Purpose |
|---|---|
| `spawnChat` | Spawn a new chat session in a specified lane with an explicit model, reasoning effort, and initial prompt. |
| `interruptChat`, `handoffChat` | Mid-session control over other chat sessions. |
| `createTerminal`, `runCommand` | Create untracked shells or run fire-and-forget commands. |
| `listLanes`, `createLane`, `renameLane`, `archiveLane`, `inspectLane` | Lane management. |
| `listWorkers`, `createAgent`, `updateAgent`, `triggerAgentWakeup` | Worker agent management. |
| `listMissions`, `startMission`, `pauseMission`, `resumeMission`, `cancelMission` | Mission control. |
| Linear tools (when connected) | Intake, dispatch, reply, close. |
| `getPipelineSettings`, `updatePipelineSettings` | Pipeline/flow policy. |
| `getIssueInventory`, `refreshIssueInventory` | Issue tracking. |
| `listTestSuites`, `runTestSuite`, `stopTestSuite`, `listTestRuns` | Test orchestration. |

The system prompt's capability manifest is driven by which tool names
are actually present; `systemPrompt.ts` inspects `toolNames` and
renders only the sections the agent can act on.

## Standalone-chat restrictions

Chat sessions connected to the ADE MCP server with a `chatSessionId` but
no mission/run/step/attempt context are classified as "standalone". The
MCP proxy hides `spawn_agent` and all coordinator tools from both the
tool-list response and the execution path. This prevents an interactive
chat user from invoking orchestration primitives that only function
inside a mission.

See `apps/desktop/src/main/adeMcpProxy.ts` and
`adeMcpProxyUtils.ts` for the filter.

## Tool exposure policy

`apps/desktop/src/main/services/ai/toolExposurePolicy.ts` implements
runtime-specific filtering:

- `decideFrontendRepoToolExposure(opts)` decides whether a frontend-repo
  discovery tool should be exposed for the current session.
- `filterFrontendRepoDiscoveryTools(tools, decision)` strips tools the
  policy rejects before handing the set to the provider adapter.

Additional exposure rules:

- `memoryUpdateCore` is only present when the session has an
  `identityKey` and the runtime passes an `onMemoryUpdateCore` callback.
- `captureScreenshot` is hidden entirely when computer use is disabled.
- Linear tools are hidden when the Linear integration is not connected.

## Fragile and tricky wiring

- **System-prompt name-detection.** `buildCodingAgentSystemPrompt` branches on
  exact tool-name matches (including `memoryUpdateCore`, `createLane`,
  `createPrFromLane`, `captureScreenshot`, `reportCompletion`,
  `TodoWrite`, `TodoRead`, and the four `pr*` tools). Renaming any of
  these tools silently strips the corresponding prompt guidance. Keep
  name changes synchronized.
- **Tool name normalisation.** MCP-exposed tools appear as
  `mcp__<server>__<tool>`. `normalizeToolName` in `systemPrompt.ts`
  unwraps that form; new tools that should appear in the prompt must be
  detectable after normalisation.
- **Approval callback and UI wiring.** `onApprovalRequest` is provided
  by `agentChatService` and funnels into the pending-input system.
  Unwired callbacks default to "approve" on `full-auto`, "decline"
  otherwise; unexpected defaults happen when the session's permission
  mode is `default` (Claude-native behavior) and the callback is
  omitted.
- **Write-gate ordering.** `memoryAdd` with `writeMode: "strict"` filters
  through `STRICT_WRITE_CATEGORIES` (`convention`, `pattern`, `gotcha`,
  `decision`) at write time. Agents that request strict writes for
  other categories silently fall back to `default`.
- **Ask-user input schema.** Claude V2 `AskUserQuestion` inputs are
  coerced to `AskUserToolInput` shape inside `agentChatService`. Codex
  MCP elicitation uses a different schema and runs through
  `coerceCodexMcpElicitationContent()` -- do not assume a common shape.

## Related docs

- [Chat README](README.md) -- the service that provisions tools.
- [Memory README](../memory/README.md) -- the memory store behind
  `memorySearch`/`memoryAdd`.
- [Agents Tool Registration](../agents/tool-registration.md) -- MCP
  server registration and the ADE MCP proxy that bridges agent tools
  across processes.
</content>
</invoke>