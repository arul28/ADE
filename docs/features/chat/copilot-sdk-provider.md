# GitHub Copilot SDK provider

Copilot chats run on the official `@github/copilot-sdk`, driving the Copilot
runtime that SDK ships (pinned and downloaded by DAEX). It is an SDK provider
like Droid and Cursor, not an ACP provider: DAEX never starts `copilot --acp`.
The provider id is `copilot`. Terminals run the separate pinned `copilot-cli`.

Read before changing the Copilot branch of `agentChatService.ts`,
`services/chat/copilotSdk*`, or Copilot permission/model mappings in the
renderer or iOS.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/chat/copilotSdkWorker.ts` | Forked worker (`copilotSdkWorker.cjs`): one `CopilotClient` and its SDK sessions. |
| `apps/desktop/src/main/services/chat/copilotSdkPool.ts` | Worker lifecycle, keyed by CLI path, config home and env fingerprint; ref-counted. |
| `apps/desktop/src/main/services/chat/copilotSdkProtocol.ts` | App ↔ worker messages. |
| `apps/desktop/src/main/services/chat/copilotSdkEventMapper.ts` | SDK events → DAEX chat events. |
| `apps/desktop/src/main/services/chat/copilotSdkPermissions.ts` | "Allow for this session" rules (`copilotSessionApproval`, `copilotSessionApprovalLabel`). |
| `apps/desktop/src/main/services/chat/copilotSlashCommands.ts` | Copilot's slash commands: menu rows, DAEX-owned commands, command answers. |
| `apps/desktop/src/main/services/chat/copilotSentry.ts` | Which failures become Sentry issues vs Logs. |
| `apps/desktop/src/main/services/chat/copilotModelsDiscovery.ts` | Model rows, Auto-only fallback, saved catalog. |
| `apps/desktop/src/main/services/chat/sdkWorkerProcess.ts` | Hidden worker commands for the SEA runtime (`__ade-copilot-sdk-worker`, also Cursor, Droid, Pi). |
| `apps/desktop/src/main/services/ai/acpExecutables.ts` | `resolveCopilotSdkRuntime` (chat runtime) and `resolveCopilotExecutable` (terminal `copilot-cli`). |
| `apps/desktop/src/main/services/ai/copilotSdkLoader.ts` | Loads the SDK inside the worker only. |
| `apps/desktop/src/main/services/ai/providerConnectionStatus.ts` (`buildCopilotConnection`) | Settings/availability status from the SDK's live sign-in check. |
| `apps/desktop/src/main/services/ai/providerTaskRunner.ts` | One-shot tasks (titles, summaries) on a utility session. |
| `apps/desktop/src/main/services/usage/extraProviderQuota.ts`, `providerQuotaParsers.ts` | Premium-request quota. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` (Copilot branch) | Open, send, steer, queue, interrupt, resume, close, permissions, goals, MCP, rewind, fork. |

## Gotchas

- **Old chats resume by id.** `copilotSdkSessionId`, or an older chat's
  `acpSessionId`, is the SDK session id. If Copilot lost the session, DAEX opens
  a new one and says so; earlier messages stay visible but Copilot cannot see
  them.
- **Background tasks never start user MCP servers** (below); they fail closed.
- **The CTO's MCP header must be a plain record** (`leaseHeaderRecord`); an
  array made Copilot drop the whole config and the turn silently.
- **Every turn must consume the staged context**
  (`consumePendingTurnContextPrefix`), or a CTO on Copilot runs with no memory.
- **No fall-forward.** The runtime is version-paired with the SDK. An org policy
  floor above the pin (`managed_client_update_required`) fails with "Your
  organization's GitHub Copilot policy requires Copilot X or newer…"; only a DAEX
  update fixes it. Log: `agent_chat.copilot_client_update_required`.
- **A token variable beats `copilot login`.** A classic `ghp_` token in
  `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` is rejected; Settings
  names the variable.

## Runtime and pins

- `@github/copilot-sdk` 1.0.28 (`apps/desktop/package.json`) ships runtime
  1.0.105 in `@github/copilot-sdk-<platform>`. DAEX pins it as tool `copilot`
  (from `package-lock.json`) and downloads it to `~/.ade/tools`; the installer
  does not carry it. The worker starts it via `RuntimeConnection.forStdio`.
- The terminal pin `copilot-cli` (`apps/ade-cli/scripts/pins/copilot-cli.json`)
  is the same 1.0.105, so chat and terminal run the same Copilot. A bump moves
  all three: `npm install @github/copilot-sdk@<v>` in `apps/desktop`, then
  `npm run tools:manifest` and `npm run tools:pin -- copilot-cli <runtime>` in
  `apps/ade-cli` (the SDK's `package.json` names `copilotCliVersion`).
- Download happens at launch / `daex serve` when the machine shows signs of
  Copilot (CLI, token env, `~/.copilot`, `gh auth`), else on first status hit or
  first chat/task. See
  [agent-tools-cache.md](../onboarding-and-settings/agent-tools-cache.md#which-tools-a-machine-fetches).
- `resolveCopilotSdkRuntime` order: `COPILOT_EXECUTABLE` /
  `GITHUB_COPILOT_EXECUTABLE`, pinned download, SDK platform package in
  `node_modules` (source checkout), previous pin, else missing. A candidate needs
  its `runtime.node`. The machine's own `copilot` is never used.
- Self-update is off (`--no-auto-update`, `COPILOT_AUTO_UPDATE=false`).
- Unpinned hosts (Windows on Arm) read "not available on this machine".

## How it runs

- **One worker per chat** (the chat id is in its env). Account reads (models,
  sign-in, quota, utility tasks) share one worker per environment. Workers are
  disposed after a short grace once unheld.
- **Crash recovery.** A dead worker marks the turn interrupted and cancels open
  questions and approvals; the next message starts a worker and resumes the
  session by id.
- **Remote machines.** The worker runs on the lane's machine; actions on a
  Copilot chat take the chat's pin.

## Auth and plan

- The runtime uses the machine's login in CLI order: `COPILOT_GITHUB_TOKEN`,
  `GH_TOKEN`, `GITHUB_TOKEN`, stored `copilot login`, then `gh auth`.
- Sign-in runs the pinned CLI's `copilot login --device-code` in a private PTY
  (`agentCliLoginRunner.ts`) and shows GitHub's code. Only the exit after
  approval counts (Copilot rewrites `config.json` when login starts).
  `config.json` is JSONC (`parseCopilotLoggedInUsers`).
- Status is `client.getAuthStatus()` on every refresh (no session, no MCP). The
  disk check is a fallback only when the probe fails.
- **Auto-only plans** get an empty model list; DAEX offers `github-copilot/auto`
  ("Auto").

## Models

- `client.listModels()` in the worker, saved to
  `copilot-model-catalog-cache.json` in the DAEX data folder, TTL 6 h
  (`COPILOT_MODELS_TTL_MS`). No saved list → Auto only.
- Rows keep id (`github-copilot/<model>`), window, output limit, vision,
  reasoning efforts, context tiers, billing multiplier. Disabled-policy rows are
  hidden.
- Window = prompt budget per tier from `billing.tokenPrices` (long tier from
  `longContext`), else `capabilities.limits`.
- Effort comes only from the model's `supportedReasoningEfforts`. Model, effort
  and context tier change live via `session.setModel(...)`; no restart.
- **Served-model notice.** When the reply's model differs from the picked one,
  one notice per served model ("Copilot used <served>, not <picked>…"), or the
  switch reason from `session.model_change.cause`. Never for Auto.
- **Context tier** (`copilotContextTier`: `default` | `long_context`) is kept
  only on rows listing `long_context`. The chip toggles it.
- **Auto profile** (`copilotAutoTier`: Efficiency, Balance, Intelligence)
  replaces the effort picker on Auto. Sent as `capi: { autoTier }` on
  create/resume; live via `session.setAutoTier`. A `pending` answer shows
  "Applies from the next message"; `session.auto_tier_switch_failed` restores
  the last confirmed profile.

## Permission levels

| DAEX level | Copilot behavior |
|---|---|
| Plan | Session mode `plan`, approvals manual. Leaving plan shows DAEX's plan-approval card; approving picks Copilot's recommended action (never Autopilot) and moves the chat to Ask. |
| Ask (default) | Every request → approval card: Allow once / Allow for this session / Deny. |
| Assisted | Copilot's safety model attaches a recommendation; DAEX auto-approves only `approve`, everything else goes to the card. Unavailable plan → Ask, with a notice. |
| Auto-edit | Reads and writes inside the lane worktree approved; everything else asks. |
| Full-auto | Approved once each; `managedApprovalRequired` still asks. |

Shared ladder: Plan → `plan`, Ask → `default`, Assisted and Auto-edit → `edit`,
Full-auto → `full-auto`.

- **Allow for this session** appears only when Copilot can remember it
  (`canOfferSessionApproval` plus a `promptRequest` to scope the rule). The
  label names the scope, since `read`/`write`/`memory` rules cover the whole
  kind.
- Questions → `onUserInputRequest` → question card. MCP elicitation →
  `onElicitationRequest` → question card (form fields, or URL with
  Accept/Decline).
- **Rate limits.** `onAutoModeSwitchRequest` asks "Switch to Auto", "Always
  switch to Auto" or "Wait for the limit"; the error (and usage-limit resume)
  shows only if the user waits.
- A live setting change Copilot refuses closes the session (conversation kept);
  the next message reopens it. A change to a stricter level stops a running turn
  at once.

## Goals (`/goal`)

Shared goal state with Claude's `/goal`. `/goal <objective>` sends the turn in
Autopilot (`agentMode: "autopilot"`); `/goal` shows it; `/goal clear` clears it
and interrupts. Plan and Ask refuse ("Copilot goals need Auto-edit or
higher…"). `session.task_complete` posts "Goal reached" or "Goal blocked" (also
on abort `autopilot_credit_limit`), with an OS notification and phone push.

## Turns and events

- Send `session.send`; steer `mode: "immediate"`; queue `mode: "enqueue"`;
  interrupt `session.abort()` (message not resent); turn end `session.idle`;
  close `session.disconnect()` (data kept; DAEX never deletes a chat's SDK
  session).
- Mapping lives in `copilotSdkEventMapper.ts`. Notable rules:
  - A full `assistant.message` is skipped when its deltas streamed.
  - `tool.execution_complete` `fileEdits` → file-change rows with diffs from
    `result.detailedContent`; write approvals also carry a `diff`.
  - `session.todos_changed` → re-read via `rpc.plan.readSqlTodos()`.
  - `session.usage_info` drives the context meter.
  - `session.error` is classed by `errorType`, then `errorCode`, then HTTP
    status (401 auth, 429 rate limit, 408/5xx network with retry). Details carry
    remediation and request ids (`providerCallId`, `serviceRequestId`). Logged
    as `agent_chat.copilot_session_error`.
  - `session.mcp_server_status_changed` failure → one notice per server per
    chat. `model.call_failure` is not shown (per-attempt retries).
  - Subagent events carry an envelope `agentId`; only their start/result cards
    and tool calls reach the transcript, but their tokens count.

## Attachments

Images → `{ type: "blob", … }`, other files → `{ type: "file", path }`. Images
are fitted by `fitImageForProviderInline` (Claude behind Copilot rejects > 5 MB
base64) and sent only to `vision` models; a skipped image becomes a note in the
prompt.

## MCP servers

- DAEX's servers and the MCP registry's go as `mcpServers` (stdio, HTTP, SSE;
  `registryMcpSupport` has a Copilot row), with `Authorization` headers for
  signed-in registry servers.
- Interactive chats keep Copilot's own discovery (workspace `.mcp.json`,
  `COPILOT_HOME/mcp-config.json`).
- `onMcpAuthRequest`: if DAEX already sends a header for that URL, cancel
  quietly; if the registry holds a sign-in for that URL (`sameMcpServerUrl`),
  return that token; otherwise cancel and post one notice per chat and server
  telling the user to add or sign in to the server in Settings → MCP servers.
  DAEX never starts a browser OAuth flow for these.

## Background tasks never start user MCP servers

Titles and summaries use a utility session: `disabledMcpServers` lists every
server in the user's Copilot config (fail closed if unlistable),
`availableTools: []`, no custom instructions, no infinite sessions, text only
(images refused), one `sendAndWait` with a 120 s timeout, then deleted.

## Skills and slash commands

- `skillDirectories` = DAEX's bundled skill roots; personal chats get none.
- Copilot's slash commands run through `session.rpc.commands.invoke` (sent as a
  message they would spend a request). The menu lists `commands.list`; before
  the runtime opens, a built-in list plus project prompt/skill files stand in.
  Output commands (`/context`, `/usage`, …) show as the reply with no model
  request; prompt-building commands (`/review`, `/plan`, a skill) send that
  prompt.
- DAEX-owned commands answer with where DAEX does it and are not in the menu:
  `/model`, `/permissions`, `/allow-all`, `/autopilot`, `/cwd`, `/rename`,
  `/every`, `/loop`, `/after`, `/remote`. Mid-turn, only commands Copilot
  allows then run (as a notice).
- Compaction: Compact and `/compact` run Copilot's own; Settings › Compaction
  "Compact at" sets `backgroundCompactionThreshold` (10–90%, default 80%) for
  the next session open (Auto keeps the default).

## Usage and quota

- Per turn: `assistant.usage` tokens; premium requests = account usage delta
  across the turn (or a higher count from an event), recorded as a
  `premium_request` unit.
- Quota: the usage poll reads GitHub's `copilot_internal/user`; missing counts
  or plan fall back to the SDK quota (cached 15 min).
- The account history scanner still reads the CLI's `session-store.db`. See
  [usage tracking](../onboarding-and-settings/usage-tracking.md).

## Fork and rewind

- **Rewind** points are root user turns, keyed by each turn's `user.message`
  event id recorded at turn start (`copilotRewindEventIds`); older chats match
  by text suffix. Preview shows files to restore; apply restores conversation
  and files and is refused mid-turn.
- **Fork** (Copilot → Copilot) uses the SDK's session fork, cut at the next
  top-level user message after the chosen turn; refused mid-turn. Same-machine
  handoff fork is offered; cross-machine fork is not.

## CLI

`daex chat create` / `daex new chat`: `--copilot-permission-mode`
(`plan|ask|assisted|auto-edit|full-auto`), `--copilot-context-tier`
(`default|long_context`), `--copilot-auto-tier`
(`efficiency|balance|intelligence`). Errors with another provider.

## Session import

DAEX chats and the user's CLI share `COPILOT_HOME`. The worker creates sessions
with `clientName: "ade"` (written as `client_name`); discovery skips those and
old `client_name: sdk` sessions carrying DAEX's prompt. A live chat's session id
marks a session "already in DAEX". Continue seeds `copilotSdkSessionId` and
resumes in the lane root, on the recorded model when known, in the new-chat
permission mode. See
[external session import](../terminals-and-sessions/external-session-import.md).

## Not built

Per-chat credit budget (`sessionLimits`), citations/canvases/workflows, a custom
agent as main agent, remote/cloud sessions, BYOK through Copilot, session-fetched
org managed settings.

## Sentry

Failures are brain log lines (warn → Sentry Logs). Possible DAEX bugs are also
issues tagged `provider: copilot`, `copilot.kind`, `copilot.model`:
`session_error` (unclassified errors), `turn_failed`, `worker_exited`,
`commands_list_failed`, `command_failed`, `setting_failed`, `handler_failed`.
Worker uncaught exceptions are issues (`process: worker:copilot`). Each turn
leaves a `copilot` breadcrumb. See `copilotSentry.ts`.

## Related

[acp-providers-spec.md](acp-providers-spec.md) (Qwen, Kimi, Grok, Devin,
Antigravity), [agent-routing.md](agent-routing.md), [README.md](README.md).
