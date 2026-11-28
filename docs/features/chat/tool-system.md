# Tool system

What tools DAEX itself gives a chat agent, on top of the provider's own tools
(Claude's, Codex's, Pi's built-ins, and so on). Regular chats get no DAEX tool
tier in-process; they reach DAEX through the `daex` CLI (`ade` also works) and
its RPC actions. CTO sessions also get the CTO operator tools. Pi chats get
DAEX's `ask_user` and approval-gated built-ins.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` | CTO operator tools: spawn and steer chats, lanes, PRs, git, tests, Linear, memory, scheduling. `resolveReadLaneId` / `requireMutationLaneId`. |
| `apps/desktop/src/main/services/ai/tools/ctoToolPacks.ts` | `CTO_TOOL_PACK_NAMES` (11 packs) and pack visibility. |
| `apps/desktop/src/main/services/ai/tools/toolDeadline.ts` | Tool budgets and timeouts (`runAdeToolWithDeadline`, the `*_MS` constants). |
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | `buildCodingAgentSystemPrompt`: the harness prompt; `normalizeToolName`; `PR_ISSUE_TOOL_NAMES`. |
| `apps/desktop/src/main/services/ai/tools/macDesktopPrompt.ts` | `buildMacDesktopDirective` and the per-OS screen lines. |
| `apps/desktop/src/main/services/ai/tools/universalTools.ts` | `createUniversalToolSet` (read/edit/write/bash/grep/glob/web/todo/askUser) and shared types (`PermissionMode`, `AskUserToolInput`). No production chat path calls `createUniversalToolSet` today; only the types are used. |
| `apps/desktop/src/main/services/chat/piSdkUiBridge.ts` | Pi's `ask_user` (`createPiAskUserTool`), the approval gate (`createPiApprovalGate`), `withPiApproval`. |
| `apps/desktop/src/shared/cliLaunch.ts` | `piToolsForPermissionMode` (Pi CLI allowlist) and `piSdkToolPolicyForPermissionMode` (Pi chat policy). |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | `createCtoRuntimeToolMap`, `createCtoAdvertisedToolMap`, `HTTP_MCP_TOOL_SETS`, `buildClaudeSdkMcpServer`, `refreshCodexDynamicTools`, `ensureHttpMcpLeases`, `executeAdeTool`. |
| `apps/ade-cli/src/adeRpcServer.ts` | RPC tools for agents, including the `pr_*` tools and the standalone-chat `spawn_agent` refusal. |

## Gotchas

- **Prompt name detection.** `buildCodingAgentSystemPrompt` branches on exact
  tool names (`createLane`, `createPrFromLane`, `TodoWrite`, `TodoRead`,
  `PR_ISSUE_TOOL_NAMES`). Renaming a tool silently drops its guidance. An
  `includes(X)` gate that advertises a capability is the risky shape (it once
  advertised tools that did not exist). Today no chat caller passes
  `toolNames`, so these branches only fire where a caller supplies the list.
- **Tool name normalisation.** DAEX CLI tools appear as `ade.<server>__<tool>`;
  `normalizeToolName` unwraps that form.
- **camelCase vs snake_case PR tools.** The camelCase `pr*` names
  (`prGetChecks`, …) are not tools. Do not "fix" a snake_case name.
- **Ask-user shapes differ per provider.** Claude's `AskUserQuestion` input is
  coerced to `AskUserToolInput` in `agentChatService`. Codex and Claude MCP
  elicitations (`buildClaudeElicitationHandler`) share
  `codexMcpElicitation.ts` for questions and answers; the request shapes differ.

## Structured SDK tool results

Claude tool results may carry the SDK's `tool_use_result`. DAEX keeps it as
`tool_result.structured` and projects what it uses into typed fields (Bash
`timedOutAfterMs`, `backgroundCwdHint`; Grep `grepTotals`; Agent results'
`worktreePath`, `worktreeBranch`, `totalTokens`, `toolUseCount`). `structured`
is debug material: capped at 8 KB on disk (`shared/chatEventCompaction.ts`) and
dropped from the sync wire. Clients read typed fields.

## Pi tools

- Pi chats get DAEX's `ask_user` custom tool (including personal chats). It
  resolves through the pending-input path with `source: "pi"`. Declining is a
  valid answer: the model is told to continue and state its assumption.
- Pi's built-ins are `read`, `bash`, `edit`, `write`, and `tools` is a flat
  allowlist. DAEX rebuilds `bash`, `edit` and `write` from Pi's exported
  factories and re-registers them via `customTools` under the same names, with
  an approval card before `execute` (a gated `bash` keeps the user's shell and
  prefix).
- DAEX's `default` mode in Pi means "ask before changing the workspace", not
  read-only.
- A tool whose factory a Pi build does not export is withheld and reported as
  `ungateableTools`, never granted ungated.
- "Allow for this chat" is remembered per tool name. A denial throws (Pi marks a
  call failed only on throw).
- Extension tools are outside this gate; see
  [Chat › Pi UI bridge](README.md#pi-ui-bridge-ask_user-and-extensions). The
  mode-to-policy table is in [Agent routing › Pi](agent-routing.md#pi).

## PR and lane tools

| Tool | Status |
|---|---|
| `createLane`, `createPrFromLane` | CTO operator tools. |
| `pr_get_checks`, `pr_get_review_comments`, `pr_rerun_failed_checks`, `pr_reply_to_review_thread`, `pr_resolve_review_thread` | Live RPC tools in `adeRpcServer.ts`. `pr_get_checks` prefers the persisted checks verdict over a row tally (which cannot see required checks that never reported). |
| `pr_get_check_log`, `pr_refresh_issue_inventory` | Not callable (no handler). Listed in `PR_ISSUE_TOOL_NAMES`, which only filters names a caller passed. |
| `captureScreenshot`, `reportCompletion`, camelCase `pr*` | Not tools. Use `daex proof capture --caption "…"` or `screenshot_environment`. |

### PR issue resolution

Agents drive a PR through the five live `pr_*` tools. There is no one-click
"resolve this PR's issues" launcher; `getPrIssueResolutionAvailability()` in
`apps/desktop/src/shared/prIssueResolution.ts` has no caller.

### Proof capture

Proof is explicit: `daex proof capture --caption "…"`, or
`daex proof attach <path> --caption "…"` for a file from
`screenshot_environment` (which reports `blocked_by_capability` where no
capture backend exists). See [Proof](../proof.md).

## CTO operator tools

Sessions with `identityKey: "cto"` get the tools in `ctoOperatorTools.ts`. Read
the file for the full list; the families are: chat control (`spawnChat`,
`interruptChat`, `steerChat`, `cancelSteer`, `listSubagents`,
`approveToolUse`), terminals (`createTerminal`, `runCommand`), lanes, memory
(`remember`, `forget`, `trackWork`, `finishWork`, `readHistory`, …), scheduling
(`scheduleWork`, `cancelScheduledWork`, `setScheduledWorkPaused`), tests, Linear,
git reads and git mutations, plus packs for files, conflicts, proof, search,
insights, config and devices.

- `spawnChat` defaults `spawnKind` to `subagent` (the child reports back) and
  forwards `permissionMode` / `droidPermissionMode` only when given. Omitting
  `laneId` creates a **fresh** lane (`resolveExecutionLane`); the CTO's own lane
  is the main checkout, so falling back to it would run children there.
- `loadCtoTools` lists the 11 packs and loads full descriptions. Every CTO tool
  is registered and callable whether or not its pack is loaded; unloaded packs
  advertise a one-line summary (`createCtoAdvertisedToolMap`).
- Linear tools are registered even when Linear is not connected and answer
  "Linear issue tracker is not available." at call time.
- Destructive tools (replace/delete an automation rule, cancel scheduled work)
  raise an approval card. `getProjectConfig` redacts env bags and
  credential-shaped values.
- See [CTO](../cto/README.md).

### Lane defaulting is read-only

The CTO session sits on the main checkout. `resolveReadLaneId` defaults reads to
it; `requireMutationLaneId` has no default and throws. Git mutations mark
`laneId` required in their schema and are refused for the CTO (repository writes
belong to an agent it starts). `gitGuard` / `conflictGuard` turn the throw into
`{ success: false, error }` that names `listLanes`.

### Registration on a live session

`createCtoRuntimeToolMap(managed)` returns null for non-CTO sessions.
`HTTP_MCP_TOOL_SETS` is the one descriptor table (today one set, `cto`:
`serverName` `daex-cto`, `codexNamespace` `daex_cto`, `buildTools` →
`createCtoAdvertisedToolMap`).

- **Claude:** `buildClaudeSdkMcpServer(managed, "cto")`, merged into
  `mcpServers` without `allowManagedMcpServersOnly` (the CTO keeps the user's
  MCP servers).
- **Codex:** `refreshCodexDynamicTools` registers every set as dynamic tools
  under its namespace. It clears the map before rebuilding, so every set must
  register in that one function. Un-namespaced calls fall back by bare name.
- **Cursor, Droid, OpenCode, Pi, Muse, Copilot:** HTTP MCP leases.
  `ensureHttpMcpLeases(managed)` returns `{ serverName, url, config }` per lease
  (one server per tool set, cached in `managed.httpMcpServers`); each call site
  shapes its SDK's config. `closeHttpMcpServers` drops them all.
- ACP providers (Qwen, Kimi, Grok, Devin, Antigravity) get no CTO tool set.
- Old transcripts use `ade-cto` / `ade_cto`: renderers take the last namespace
  segment, Codex falls back by bare name, and `mcpServerNameAliases` treats
  `ade-cto` as an alias.

#### Who decides when a tool call has waited long enough

DAEX does. Every transport runs tools through `executeAdeTool` →
`runAdeToolWithDeadline` (`toolDeadline.ts`):

- Budget `DEFAULT_ADE_TOOL_BUDGET_MS` (120 s) unless the tool declares
  `budgetMs`; calls to another machine add `REMOTE_CALL_ALLOWANCE_MS`.
- Time on an approval card does not count (`pauseAdeToolDeadline`); the card's
  own cap is `ADE_TOOL_APPROVAL_TIMEOUT_MS` (60 min).
- When the budget runs out, the model is told the work may still finish and to
  check before retrying. The work keeps running.
- Transport cap `ADE_MCP_TRANSPORT_TIMEOUT_MS` (65 min) is set on the Claude SDK
  server and OpenCode's `remote` entry. Codex dynamic tools have no cap.
  Cursor's and Droid's MCP configs have no timeout field, so their client
  defaults can end a call first.

## Standalone-chat restriction

A chat connected to the DAEX CLI with a `chatSessionId` but no worker context is
"standalone": the RPC bridge hides `spawn_agent` from the action list and
refuses it on execution.

## Mac Desktop tool and its prompt line

`mac-desktop` is a Work tools pane tool (`WORK_TOOL_IDS` in
`shared/types/workTools.ts`), not a model tool; agents use `daex mac-desktop`
and the `mac_desktop` action domain.

- Shown only when the lane's runtime host is macOS (otherwise
  `MAC_DESKTOP_UNSUPPORTED_PLATFORM` and hidden); any client may view a
  Mac-hosted lane's screen read-only.
- `buildMacDesktopDirective` returns one line only when the lane has a display
  (null otherwise, so the prompt is unchanged). The line follows the brain's OS
  (`seatHostPlatform`): `MAC_DESKTOP_PROMPT_LINE`,
  `WINDOWS_DESKTOP_PROMPT_LINE` or `LINUX_DESKTOP_PROMPT_LINE` (DAEX Cloud
  computers included). Sent once per epoch (`deliveredDirectiveKeys.laneScreen`),
  never to personal chats.

See [Mac Desktop](../mac-desktop/README.md) and
[Agents tool registration](../agents/tool-registration.md).
