# Tool System

Agents exposed through chat get three tiers of tools: **universal**,
**workflow**, and **coordinator**. Each tier is scoped to a role so a
regular chat session cannot, for example, start a run or force a
worker to respawn.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/ai/tools/executableTool.ts` | Thin wrapper around Zod + a handler function. Produces the common tool interface the Claude/Codex/OpenCode adapters consume. |
| `apps/desktop/src/main/services/ai/tools/universalTools.ts` | Read, write, bash, todo, web fetch/search, ask-user. Available to every agent. |
| `apps/desktop/src/main/services/ai/tools/workflowTools.ts` | `createLane`, `createPrFromLane`, `captureScreenshot`, `reportCompletion`, and the four PR issue-resolution tools. |
| `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` | CTO-only: `spawnChat`, lanes/PRs/git/tests, Linear reads and lightweight updates, and the `saveMemory` / `searchMemory` / `readMemory` memory tools. Git reads default their lane (`resolveReadLaneId`); git mutations require an explicit one (`requireMutationLaneId`). |
| `apps/desktop/src/main/services/ai/tools/linearTools.ts` | Linear-only tools for CTO when Linear is connected. |
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | `buildCodingAgentSystemPrompt` -- renders the top-of-context system prompt; adapts wording based on which tool names are present. |
| `apps/desktop/src/main/services/ai/toolExposurePolicy.ts` | Filters tools by context (e.g., frontend-repo discovery tools). |
| `apps/desktop/src/main/services/ai/tools/readFileRange.ts` / `grepSearch.ts` / `globSearch.ts` / `editFile.ts` | Primitive file/search tools used by every agent. |
| `apps/desktop/src/main/services/ai/tools/webFetch.ts` / `webSearch.ts` | Web access tools. |
| `apps/desktop/src/main/services/chat/piSdkUiBridge.ts` | Pi's custom-tool surface: ADE's `ask_user` tool definition (`createPiAskUserTool`), the per-tool-call approval gate (`createPiApprovalGate`), and the `withPiApproval` wrapper that rebuilds a Pi built-in behind that gate. |
| `apps/desktop/src/shared/cliLaunch.ts` | `piToolsForPermissionMode` (tracked Pi CLI, allowlist only) and `piSdkToolPolicyForPermissionMode` (Pi chat: allowlist + approval-tool list + an explicit `readOnly` flag). |

## Tier 1: universal tools

Available to every agent (CTO, regular chat, coordinator).
Built by `createUniversalToolSet()` in `universalTools.ts`.

| Tool | Purpose | Gate |
|---|---|---|
| `readFile` | Range-aware file reader built on `readFileRange.ts`. | Read-only; allowed in every permission mode. |
| `editFile` | Single-file editor; produces a `file_change` event. | Blocked in `plan` mode. |
| `writeFile` | Create or replace a file. | Blocked in `plan` mode. |
| `bash` | Shell command with configurable sandbox. Emits `command` events. | Blocked in `plan`; sandboxed per `WorkerSandboxConfig` for API/local models; CLI-wrapped models delegate to the CLI's own gating. |
| `grep`, `glob` | Search tools backed by `grepSearch.ts` / `globSearch.ts`. | Read-only. |
| `webFetch`, `webSearch` | Web tools; backed by `webFetch.ts` and `webSearch.ts`. | Always allowed. |
| `askUser` (universal form) | Legacy ask-user helper. Claude SDK sessions use their native `AskUserQuestion` tool instead; see [ask-user](#ask-user-handling). | Always allowed. |
| `TodoWrite`, `TodoRead` | Session-state todo list. Writes emit `todo_update` events. | Always allowed. |

### Structured SDK tool results

Claude user/replay messages may carry the full SDK `tool_use_result`. ADE
preserves that value as `tool_result.structured` and also extracts narrow
fields for thin clients: Bash exposes `timedOutAfterMs` and
`backgroundCwdHint`, while Grep exposes `grepTotals.files` and
`grepTotals.lines`.

Completed Agent/Task results use the SDK's enriched
`AgentToolCompletedOutput` when present. Their `subagent_result` rows can carry
`worktreePath`, `worktreeBranch`, `totalTokens`, and `toolUseCount`; clients do
not need to parse the raw structured object to show those values.

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

Claude SDK sessions use the native `AskUserQuestion` SDK tool, which is plumbed
through the same pending-input abstraction (see
[transcript-and-turns](transcript-and-turns.md)).

Pi sessions get an ADE-supplied `ask_user` custom tool (`piSdkUiBridge.ts`),
injected into every Pi chat including personal chats. It takes a question, an
optional short header, and optional labelled choices, and resolves through the
same pending-input path with `source: "pi"`. Declining is a valid outcome, not a
failure: the tool returns a note telling the model to continue with its best
judgement and state the assumption it made.

### Pi per-call approval gating

Pi's built-in registry is only `read`, `bash`, `edit`, and `write`, and its
`tools` option is a flat allowlist. In chat, ADE rebuilds `bash`, `edit`, and
`write` from Pi's own root-exported definition factories and re-registers them
through `customTools` under the same names — a custom tool whose name matches a
built-in replaces it, so the rebuilt tool keeps Pi's schema, prompt text, and
rendering while gaining an approval card in front of `execute`. A gated `bash`
still honours the user's configured shell path and command prefix.

Consequences worth knowing:

- ADE's `default` permission mode in a Pi chat means "ask before anything that
  changes the workspace", not read-only.
- Only a tool the session actually grants is gated; relying on Pi's allowlist to
  drop an unrequested wrapper would make the gate depend on resolution order.
- A Pi build that does not export a tool's factory cannot have it gated, so the
  tool is **withheld** and reported as `ungateableTools` on the ready payload —
  never granted ungated.
- "Allow for this chat" is remembered per tool name for the session's life.
- A denial throws, because Pi marks a tool call failed only when `execute`
  throws.
- Extension-registered tools are outside this gate entirely; see
  [Chat › Pi UI bridge](README.md#pi-ui-bridge-ask_user-and-extensions).

The full mode-to-policy table lives in
[Agent Routing › Pi](agent-routing.md#pi).

## Tier 2: workflow tools

Available to chat agents (CTO, named employees, regular chat sessions).
Not exposed to headless run workers. Built by `createWorkflowTools()`
in `workflowTools.ts`.

| Tool | Purpose |
|---|---|
| `createLane({ name, description?, parentLaneId? })` | Creates a new lane (git worktree + branch). Returns lane id, branch ref, worktree path. |
| `createPrFromLane({ laneId, title?, body? })` | Creates a pull request from the lane's changes. |
| `captureScreenshot()` | Screenshots the current environment and files the result through the proof broker. macOS-only (backed by `screencapture`); returns `blocked_by_capability` on other platforms. No policy gate. |
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

### Proof capture

`captureScreenshot` files the resulting image through
`computerUseArtifactBrokerService.ingest()`. It is not gated by
a policy — the proof-observer model (and `ComputerUsePolicy`) was
removed. The tool still reports `blocked_by_capability` when it runs on
a platform without a supported capture backend (Linux/Windows); the
agent can fall back to `ade proof attach <path>` with a headless-browser
or Playwright-produced PNG in that case.

## CTO operator tools

Sessions with `identityKey: "cto"` additionally receive the CTO operator
tools from `ctoOperatorTools.ts`. These are the control plane the CTO
uses to act on ADE itself:

| Tool family | Purpose |
|---|---|
| `spawnChat` | Spawn a new chat session with an explicit model, reasoning effort, and initial prompt. Lane resolution goes through `resolveExecutionLane`: an explicit `laneId` wins, and omitting it creates a **fresh** lane (`freshLaneName` / `freshLaneDescription`) rather than reusing the caller's. For the CTO that is load-bearing — its session is pinned to the project's primary lane, so a fallback would run spawned agents against the primary worktree. |
| `interruptChat`, `steerChat`, `cancelSteer`, `listSubagents`, `approveToolUse` | Mid-session control over other chat sessions: interrupt a turn, inject a steer instruction, cancel a pending steer by its `steerId`, enumerate spawned sub-agents, and answer a pending permission prompt. Each is a **required** dep on `CtoOperatorToolDeps` and maps onto the corresponding `agentChatService` method (`approveToolUse` translates the tool's `toolUseId` to the service's `itemId`), so none of them can be advertised without an implementation behind it. |
| `createTerminal`, `runCommand` | Create untracked shells or run fire-and-forget commands. `createTerminal` passes explicit `cols: 100`, `rows: 30`, and a title, rather than relying on the pty service's default clamp. |
| `listLanes`, `createLane`, `renameLane`, `archiveLane`, `inspectLane` | Lane management. |
| `saveMemory`, `searchMemory`, `readMemory` | Durable CTO memory: save facts, search prior context, review what it knows. |
| Linear tools (when connected) | Read and lightly update issues: list/inspect, comment, state, assignee, label. |
| `listLinearIssues`, `getLinearIssue` | Issue reads. |
| `listTestSuites`, `runTestSuite`, `stopTestSuite`, `listTestRuns` | Test orchestration. |
| `gitStatus`, `gitFetch`, `gitListRecentCommits`, `gitListBranches`, `gitStashList`, `gitGetConflictState` | Git reads. `laneId` is optional and defaults to the CTO session's lane. |
| `gitCommit`, `gitPush`, `gitPull`, `gitUndoLastHeadChange`, `gitRedoLastHeadChange`, `gitCheckoutBranch`, `gitStashPush`, `gitStashPop`, `gitRebaseContinue`, `gitRebaseAbort`, `gitMergeAbort` | Git mutations. `laneId` is **required** — see [Lane defaulting is read-only](#lane-defaulting-is-read-only). |

The system prompt's capability manifest is driven by which tool names
are actually present; `systemPrompt.ts` inspects `toolNames` and
renders only the sections the agent can act on.

### Registration on a live session

The CTO tool set is a second consumer of the same per-provider tool
transports the orchestration tool set uses, gated on `identityKey === "cto"`
via `createCtoRuntimeToolMap(managed)` in `agentChatService.ts`.

A single descriptor table, `HTTP_MCP_TOOL_SETS`, names the tool sets ADE can
register on a session. Each entry carries a `serverName`, a `codexNamespace`,
and a `buildTools(managed)` factory, so every transport below reads its
identifiers from one place instead of restating them:

| Tool set | `serverName` | `codexNamespace` | `buildTools` |
| --- | --- | --- | --- |
| `orchestration` | `ade-orchestration` | `ade_orchestration` | `createOrchestrationRuntimeToolMap` |
| `cto` | `ade-cto` | `ade_cto` | `createCtoRuntimeToolMap` |

- **Claude** — `buildClaudeSdkMcpServer(managed, "cto")` produces an SDK MCP
  server named `ade-cto`, merged into `opts.mcpServers`. It is deliberately
  injected *without* the orchestration lead's `allowManagedMcpServersOnly`
  lockdown, because the CTO is a daily-driver chat that must keep the user's
  own MCP servers. (When a session ever carries both sets, the orchestration
  path adds `ade-cto` to `allowedMcpServers` too, so the lockdown cannot
  silently drop it.)
- **Codex** — `refreshCodexDynamicTools` walks the whole table and registers
  each set as dynamic tools under its own namespace (`ade_cto` next to
  `ade_orchestration`). Both sets must register in that one function: it clears
  the runtime's dynamic-tool map before rebuilding, so a second refresher would
  clobber the first. Dispatch falls back by bare name across both namespaces
  when a call arrives un-namespaced.
- **Cursor, Droid, OpenCode** — HTTP MCP leases. `ensureHttpMcpServer(managed,
  toolSet)` starts one server per tool set and caches it in
  `managed.httpMcpServers`, a `Partial<Record<HttpMcpToolSet, HttpMcpLease>>`
  keyed by the same table. Each lease carries exactly one tool set, so the CTO
  and orchestration servers stay distinct rather than merging into one.
  Transports call `ensureHttpMcpLeases(managed)`, which resolves every live
  lease in table order and returns `{ serverName, url, config }` for each — the
  per-SDK config shapes differ (record-of-http, record-of-remote, array), so
  each call site does its own one-line shaping over that list.
  `closeHttpMcpServers(managed)` drops every lease, and all teardown paths use
  it.

`buildCtoOperatorToolDeps` builds the dependency set for both the runtime map
and `previewSessionToolNames` (which enumerates the same names for the prompt),
so the advertised surface and the callable surface cannot drift.

### Lane defaulting is read-only

The CTO session is pinned to the project's **primary lane**, so `defaultLaneId`
means "the primary worktree". `ctoOperatorTools.ts` therefore splits lane
resolution in two: `resolveReadLaneId` keeps the default (inspecting primary is
normal supervision), while `requireMutationLaneId` has no default and throws
when `laneId` is missing. The mutating tools' zod schemas mark `laneId` required
so the model sees the requirement up front, and `gitGuard` / `conflictGuard`
convert the throw into a recoverable `{ success: false, error }` that names
`listLanes` rather than failing the turn.

## Standalone-chat restrictions

Chat sessions connected to the ADE CLI with a `chatSessionId` but
no worker context are classified as "standalone". The
ADE action bridge hides `spawn_agent` from both the action-list
response and the execution path. This prevents an interactive chat
user from invoking elevated primitives reserved for managed sessions.

## Tool exposure policy

`apps/desktop/src/main/services/ai/toolExposurePolicy.ts` implements
runtime-specific filtering:

- `decideFrontendRepoToolExposure(opts)` decides whether a frontend-repo
  discovery tool should be exposed for the current session.
- `filterFrontendRepoDiscoveryTools(tools, decision)` strips tools the
  policy rejects before handing the set to the provider adapter.

Additional exposure rules:

- `captureScreenshot` is hidden entirely when computer use is disabled.
- Linear tools are hidden when the Linear integration is not connected.

## Fragile and tricky wiring

- **System-prompt name-detection.** `buildCodingAgentSystemPrompt` branches on
  exact tool-name matches (including `createLane`, `createPrFromLane`,
  `captureScreenshot`, `reportCompletion`, `TodoWrite`, `TodoRead`, and
  the four `pr*` tools). Renaming any of
  these tools silently strips the corresponding prompt guidance. Keep
  name changes synchronized.
- **Tool name normalisation.** ADE CLI-exposed tools appear as
  `ade.<server>__<tool>`. `normalizeToolName` in `systemPrompt.ts`
  unwraps that form; new tools that should appear in the prompt must be
  detectable after normalisation.
- **Approval callback and UI wiring.** `onApprovalRequest` is provided
  by `agentChatService` and funnels into the pending-input system.
  Unwired callbacks default to "approve" on `full-auto`, "decline"
  otherwise; unexpected defaults happen when the session's permission
  mode is `default` (Claude-native behavior) and the callback is
  omitted.
- **Ask-user input schema.** Claude SDK `AskUserQuestion` inputs are
  coerced to `AskUserToolInput` shape inside `agentChatService`. Codex
  elicitations arrive through the `codex app-server` JSON-RPC stream
  and are normalized inline in the Codex adapter -- do not assume a
  common shape across providers.

## Related docs

- [Chat README](README.md) -- the service that provisions tools.
- [Agents Tool Registration](../agents/tool-registration.md) -- ADE CLI
  action registration and the private ADE RPC bridge used by the desktop app.
</content>
</invoke>
