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
| `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` | CTO-only: `spawnChat`, lanes/PRs/git/tests, Linear reads and lightweight updates, and the `saveMemory` / `searchMemory` / `readMemory` memory tools. |
| `apps/desktop/src/main/services/ai/tools/linearTools.ts` | Linear-only tools for CTO when Linear is connected. |
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | `buildCodingAgentSystemPrompt` -- renders the top-of-context system prompt; adapts wording based on which tool names are present. |
| `apps/desktop/src/main/services/ai/toolExposurePolicy.ts` | Filters tools by context (e.g., frontend-repo discovery tools). |
| `apps/desktop/src/main/services/ai/tools/readFileRange.ts` / `grepSearch.ts` / `globSearch.ts` / `editFile.ts` | Primitive file/search tools used by every agent. |
| `apps/desktop/src/main/services/ai/tools/webFetch.ts` / `webSearch.ts` | Web access tools. |

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
| `spawnChat` | Spawn a new chat session with an explicit model, reasoning effort, and initial prompt. Lane resolution goes through `resolveExecutionLane`: an explicit `laneId` wins, and omitting it creates a **fresh** lane (`freshLaneName` / `freshLaneDescription`) rather than reusing the caller's. For the CTO that is load-bearing — its own lane is the project's primary lane, so a fallback would run spawned agents against the primary worktree. |
| `interruptChat`, `handoffChat` | Mid-session control over other chat sessions. |
| `createTerminal`, `runCommand` | Create untracked shells or run fire-and-forget commands. |
| `listLanes`, `createLane`, `renameLane`, `archiveLane`, `inspectLane` | Lane management. |
| `saveMemory`, `searchMemory`, `readMemory` | Durable CTO memory: save facts, search prior context, review what it knows. |
| Linear tools (when connected) | Read and lightly update issues: list/inspect, comment, state, assignee, label. |
| `listLinearIssues`, `getLinearIssue` | Issue reads. |
| `listTestSuites`, `runTestSuite`, `stopTestSuite`, `listTestRuns` | Test orchestration. |

The system prompt's capability manifest is driven by which tool names
are actually present; `systemPrompt.ts` inspects `toolNames` and
renders only the sections the agent can act on.

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
