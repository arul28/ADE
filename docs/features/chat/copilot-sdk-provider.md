# GitHub Copilot SDK provider

How ADE runs a GitHub Copilot chat. Copilot is no longer an ACP provider. It is
an SDK provider, like Droid and Cursor: ADE drives the official
`@github/copilot-sdk` against the Copilot CLI already installed on the machine.
The provider id stays `copilot`, so saved chats, the CLI, iOS and analytics keep
the same name.

Read this before changing the Copilot branch of `agentChatService.ts`, anything
under `apps/desktop/src/main/services/chat/copilotSdk*`, or the Copilot
permission and model mappings in the renderer, the TUI, or iOS.

The other ACP providers (Qwen Code, Kimi Code, Grok, Devin) still run over the
shared ACP host. Their spec is `acp-providers-spec.md`.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/chat/copilotSdkWorker.ts` | Forked Node child. Owns one `CopilotClient` and multiplexes every Copilot chat on the machine over it. |
| `apps/desktop/src/main/services/chat/copilotSdkPool.ts` | Worker lifecycle. Keys a worker by runtime environment: CLI binary path, `COPILOT_HOME`, and the token environment. |
| `apps/desktop/src/main/services/chat/copilotSdkProtocol.ts` | Messages between the app and the worker. |
| `apps/desktop/src/main/services/chat/copilotSdkEventMapper.ts` | SDK session events to ADE chat events. |
| `apps/desktop/src/main/services/chat/copilotModelsDiscovery.ts` | Model catalog from `client.listModels()`. |
| `apps/desktop/src/main/services/ai/copilotSdkLoader.ts` | Loads `@github/copilot-sdk` the same way the Droid loader does. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` (Copilot branch) | Create, send, steer, queue, interrupt, resume, close, permissions, MCP. |

## What changed from ACP

- ADE no longer starts `copilot --acp`. There is no Copilot dialect in the ACP
  host and no Copilot entry in the ACP provider list.
- Existing Copilot chats keep working. The `acpSessionId` a chat saved is read
  as the SDK session id, so the chat resumes its history by id. Nothing is
  migrated.
- Copilot's tool, slash-command and model behavior now comes from the SDK
  events and the SDK's model list, not from ACP `session/update` messages.

## Requirements

- The Copilot CLI installed on the machine (npm package `@github/copilot`). ADE
  does not ship the SDK's runtime packages. It starts the installed `copilot`
  binary over stdio, through `RuntimeConnection.forStdio({ path })`.
- A Copilot CLI that speaks SDK protocol 3. If the CLI is older, the chat fails
  with a message to run `copilot update`.
- A missing CLI shows the same "install Copilot CLI" empty state as before.

## How it runs

- **One worker per machine.** The SDK runtime handles many sessions in one
  process, so one forked worker serves every Copilot chat on the machine. The
  worker is keyed by the CLI path, `COPILOT_HOME` and the token environment.
  Changing any of them starts a new worker.
- **Crash recovery.** If the worker dies, each affected chat resumes its SDK
  session by id. Pending approvals are not resumed. They show as interrupted,
  as they do for the other providers.
- **Config home.** ADE reads Copilot's configuration home the way it always has
  (`COPILOT_HOME`, passed as the SDK `baseDirectory`). ADE never writes Copilot
  config.
- **Remote machines.** The worker runs on the lane's machine, like every other
  chat. Actions that act on a Copilot chat take the chat's machine pin.

## Auth and plan

- Sign-in is the Copilot CLI's own login (`copilot login`). Settings keeps that
  terminal flow and its copy.
- ADE reads the signed-in state with `client.getAuthStatus()`. This needs no
  session, so checking auth never starts a session or an MCP server.
- The plan and quota come from the session's `rpc.quota.get()` once a session
  exists. The header shows premium interactions.
- **Auto-only plans.** Some accounts get an empty model list. ADE then offers a
  single `auto` model named "Auto", and Copilot picks the model on each turn.

## Models

- The catalog is `client.listModels()`. It is cached for 6 hours and persisted,
  like the old ACP catalog, and it is never read on the UI path.
- Each row keeps its context window, prompt and output limits, vision support,
  `supportedReasoningEfforts`, `defaultReasoningEffort`, billing multiplier and
  policy state. Rows with a disabled policy are hidden.
- Reasoning effort is chosen only from the model's own
  `supportedReasoningEfforts` (the SDK ladder: low, medium, high, xhigh, max).
  Changing it calls `session.setModel(current, { reasoningEffort })` on the live
  session. No process restarts.
- Model switches are live. The served model comes from `session.model_change`,
  `session.auto_mode_resolved.chosenModel` and `assistant.usage.model`. When the
  served model differs from the chosen one, ADE shows the served-model notice
  once per model. It never shows that notice for `auto`.

## Permission modes

ADE's five levels map onto Copilot's permission model:

| ADE level | Copilot behavior |
|---|---|
| Plan | Session mode `plan` (`rpc.mode.set`). When the agent asks to leave plan mode, the request goes through `onExitPlanModeRequest` to ADE's plan-approval prompt. |
| Ask (default) | `onPermissionRequest` goes to ADE's approval prompt. The prompt shows the write diff and the full shell command. Approve once, approve for the session, or deny. |
| Assisted | Session mode `assisted`. Permission requests the runtime resolves itself (`decisionSource: "assisted_approval"`) raise no ADE prompt. A request that still reaches ADE's handler shows the normal approval prompt. |
| Auto-edit | Reads and writes inside the lane worktree are approved. Everything else asks. |
| Full-auto | Each request is approved once. A request that managed policy marks `managedApprovalRequired` still asks. |

Questions from the agent go to ADE's ask-user UI through `onUserInputRequest`.
The legacy `ask_user` form is used. Elicitation is not enabled.

## Context tier and Auto profile

- **Context tier.** `copilotContextTier` is `default` or `long_context`. A missing
  or invalid value means `default`. The toggle appears only for models whose
  catalog row lists `long_context` in `supportedContextTiers`. It is labeled with
  the catalog's window size, for example `300k` or `1M`, or `Long` when that size
  cannot be determined. Its tooltip says long context costs more. A change calls
  `session.setModel(current, { contextTier })` on the live session.
- **Auto profile.** On an Auto model, `copilotAutoTier` is `efficiency`,
  `balance` or `intelligence`. Unset means the SDK's default routing. The profile
  goes out on session create and resume as `capi: { autoTier }`. A profile-only
  change calls `session.setAutoTier(tier)`.
- **Pending.** The runtime can answer a profile change with `status: "pending"`.
  ADE keeps `copilotAutoTierPending` true and labels the choice "applies from the
  next message". `session.model_change` with the new `autoTier` confirms it.
  `session.auto_tier_switch_failed` rejects it and restores the last confirmed
  profile.

## Goals (`/goal`)

`/goal` is a desktop chat command. `/goal <objective>` stores `copilotGoal` and
sends the turn with `agentMode: "autopilot"`. `/goal` alone shows the current
goal. `/goal clear` clears it and interrupts a running turn.

Plan and Ask refuse a goal with "Copilot goals need Auto-edit or higher."
Assisted, Auto-edit and Full-auto accept one.

A goal ends when `session.task_complete` arrives, which posts `goal_reached` if
the task succeeded and `goal_blocked` if it did not. A run that aborts with
`autopilot_credit_limit` posts `goal_blocked`. `/goal clear` ends it without a
notice. The CLI TUI has no `/goal` command, and the phone shows no goal state yet.

## Turns, steering and queueing

- **Send** calls `session.send({ prompt, attachments })`.
- **Steer** sends `mode: "immediate"`. The message joins the running turn before
  the next model call.
- **Queue** sends `mode: "enqueue"`. The message runs after the current turn.
- **Interrupt** calls `session.abort()` and marks the turn interrupted. There is
  no cancel-and-resend. The session stays usable.
- **Turn end** is `session.idle`.
- **Close** calls `session.disconnect()`, which keeps the data so the chat can
  resume. ADE never calls `deleteSession` on a user chat.

Steer and queue are both available. Interrupt does not resend the message.

## Events

| SDK event | ADE |
|---|---|
| `assistant.message_delta` / `assistant.message` | Assistant text. |
| `assistant.reasoning_delta` / `assistant.reasoning` | Reasoning. |
| `tool.execution_start`, `partial_result`, `progress`, `complete` | Tool cards with the MCP server and tool name, shell output, exit code and `fileEdits` paths. |
| `session.todos_changed` | Triggers a re-read of the todos through `rpc.plan.readSqlTodos()`. |
| `subagent.started`, `completed`, `failed` | Subagent cards, attributed by the event's `agentId`. |
| `session.compaction_start` / `complete` | Compaction events. |
| `session.error`, `model.call_failure`, `session.warning` | Errors and notices, with retry classification. |
| `abort` | The turn is marked interrupted. |
| `session.model_change` | Confirms the served model and any Auto profile change. |
| `session.auto_tier_switch_failed` | Rejects a pending Auto profile change and restores the last confirmed one. |
| `session.task_complete` | Ends the active goal, with `goal_reached` or `goal_blocked`. |

File diffs come from the write permission's `diff`, or from `rpc.workspaces.diff`
when the diff view needs them. The `fileEdits` on a tool event carry paths only.

## MCP servers

- **ADE's own servers** and the **MCP registry** servers go to `mcpServers`.
  Registry servers keep their `Authorization` headers. stdio servers use the
  `workingDirectory` field of the SDK type.
- **The user's own servers.** Servers the user configured in their Copilot
  config (`mcp-config.json` under `COPILOT_HOME`) still run in chats.
- **Sign-in handoff.** When a server asks for OAuth, `onMcpAuthRequest` runs:
  - If the MCP registry already holds a sign-in for that server URL, ADE returns
    `{ kind: "token", accessToken, expiresIn }`.
  - Otherwise ADE returns `{ kind: "cancelled" }` and posts one chat notice for
    the pair (chat, server). The text depends on the registry. A server that is
    not in ADE's MCP registry gets: "<server> needs a sign-in. Add it to ADE's MCP
    servers (Settings → MCP servers → Import) and sign in once — every agent will
    use it." A server in the registry but signed out gets: "Sign in from Settings →
    MCP servers". The notice has an action that opens the MCP servers in Settings.
  - ADE never opens a browser on its own. Repeated requests for the same pair
    are de-duplicated.

## Background tasks never start user MCP servers

Titles, summaries and commit messages run on a utility session, not on a chat:

- `disabledMcpServers` lists every configured server name, so none of them
  start or authenticate.
- No tools (`availableTools: []`), no custom instructions, and infinite sessions
  off.
- The session runs one `sendAndWait`, then it is deleted.
- It uses the shared worker. A background task never starts a user MCP server.

## Skills, instructions and commands

- `skillDirectories` is ADE's bundled skill roots, the same ones Qwen gets,
  unless the chat is a personal session.
- Copilot's own TUI slash commands are not exposed by the SDK, so none appear
  for Copilot. ADE's own commands still work.

## Attachments

- Images go as `{ type: "blob", data, mimeType }`. Files go as
  `{ type: "file", path }`.
- ADE respects `capabilities.limits.vision` for the selected model. A model
  without vision gets no image attachment.

## Usage, context and quota

- Each model call reports `assistant.usage`: input, output, cache and reasoning
  tokens, `copilotUsage.totalNanoAiu`, and the model. ADE records these as turn
  usage.
- `session.usage_info` (`currentTokens`, `tokenLimit`) drives the context meter.
- `usage.getMetrics().totalPremiumRequestCost` gives premium requests.
- The usage projection carries used and entitlement counts, plan tier, reset date
  and unlimited status when the runtime reports them. A turn's premium cost is part
  of that turn's usage record, and the account history scanner does not count it
  again.
- The account-level history scanner still reads Copilot's session store for
  account totals. Per-turn usage comes from the SDK events, so totals are not
  counted twice.

## Fork and rewind

Native fork and rewind use the SDK's session and event IDs. A forked chat keeps
the Copilot session ID the SDK returns in its existing Copilot session pointer,
so no new field is stored. Native forks stay on the machine that owns the SDK
session, so cross-machine fork is not offered for Copilot. Same-machine handoff
fork is offered.

## CLI and TUI

`ade chat create` and `ade new chat` take three Copilot flags. Passing one with
another provider is an error.

- `--copilot-permission-mode`: `plan`, `ask`, `assisted`, `auto-edit` or `full-auto`.
- `--copilot-context-tier`: `default` or `long_context`.
- `--copilot-auto-tier`: `efficiency`, `balance` or `intelligence`.

The TUI setup pane shows the same five permission modes, the context-tier toggle
and the Auto profile row.

## Legacy chats

A Copilot chat created before this change has a saved `acpSessionId`. That id is
the SDK session id. Opening the chat calls `resumeSession` with it, and the full
history comes back. If the SDK no longer has the session, the chat reports the
error, and the user can start a new Copilot chat.

## What stays the same

- **The terminal Copilot CLI.** Launching the native `copilot` in a terminal,
  its model flag and its terminal signals are unchanged. See
  `terminals-and-sessions/`.
- **Usage history import.** The local usage ledgers and the account scanners are
  unchanged. See `onboarding-and-settings/usage-tracking.md`.
- **External session import.** Discovery of the CLI's own sessions and the
  transcript conversion are unchanged. See
  `terminals-and-sessions/external-session-import.md`.

## Not in this build

These are deliberately not built yet. The data is kept so they are cheap to add:

- Per-chat AI-credit budget (`sessionLimits`).
- Fleet (sub-agent fleet), memory, citations, canvases and workflows.
- Remote and cloud sessions.
- BYOK providers through Copilot.

## Troubleshooting

- **"Update Copilot CLI."** The installed CLI speaks an older SDK protocol. Run
  `copilot update`, then retry.
- **Only "Auto" in the model list.** Expected on an Auto-only plan.
- **"<server> needs a sign-in."** If the notice asks you to add the server, add it
  to ADE's MCP servers and sign in once. Otherwise open the server's sign-in from
  Settings → MCP servers. Then retry the chat.
- **"Copilot goals need Auto-edit or higher."** Change the permission mode, then
  set the goal again.
- **A chat cannot resume.** Its Copilot session is gone. Start a new Copilot chat.

## Related

- `acp-providers-spec.md`: the ACP providers that remain (Qwen, Kimi, Grok, Devin).
- `agent-routing.md`: the runtime table and how a chat picks its provider.
- `README.md`: the chat runtime overview.
