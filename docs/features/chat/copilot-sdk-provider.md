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
| `apps/desktop/src/main/services/chat/copilotSdkWorker.ts` | Forked Node child, built as `copilotSdkWorker.cjs`. Owns one `CopilotClient` and the SDK sessions for the chats that use it. |
| `apps/desktop/src/main/services/chat/copilotSdkPool.ts` | Worker lifecycle. Keys a worker by CLI path, config home and environment. Reference-counted. |
| `apps/desktop/src/main/services/chat/copilotSdkProtocol.ts` | Messages between the app and the worker. |
| `apps/desktop/src/main/services/chat/copilotSdkEventMapper.ts` | SDK session events to ADE chat events. |
| `apps/desktop/src/main/services/chat/copilotModelsDiscovery.ts` | Model rows, the Auto-only fallback, and the saved model catalog. |
| `apps/desktop/src/main/services/ai/copilotSdkLoader.ts` | Loads `@github/copilot-sdk` inside the worker only. |
| `apps/desktop/src/main/services/ai/providerTaskRunner.ts` | Copilot one-shot tasks (titles, summaries) through a utility session. |
| `apps/desktop/src/main/services/ai/aiIntegrationService.ts` | Provider status and the model list used by the picker. |
| `apps/desktop/src/main/services/usage/extraProviderQuota.ts`, `providerQuotaParsers.ts` | Premium-request quota. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` (Copilot branch) | Open, send, steer, queue, interrupt, resume, close, permissions, goals, MCP, rewind and fork. |

## What changed from ACP

- ADE no longer starts `copilot --acp`. There is no Copilot dialect in the ACP
  host, and Copilot is not in the ACP provider list.
- Existing Copilot chats keep working. When a chat opens, ADE reads its saved
  `copilotSdkSessionId`, or the older `acpSessionId`, as the SDK session id and
  resumes that session. Nothing on disk is migrated.
- Model list, events, usage and quota now come from the SDK and its account
  calls, not from ACP `session/update` messages or the CLI's session store.

## Requirements

- The Copilot CLI installed on the machine (npm package `@github/copilot`). The
  SDK JavaScript ships with ADE. The Copilot runtime does not. ADE starts the
  installed `copilot` binary over stdio, through `RuntimeConnection.forStdio({ path })`.
  On Windows an npm install puts a `copilot.cmd` shim on PATH, which the SDK
  cannot spawn (it uses no shell). ADE follows the shim to the native
  `copilot.exe` in the `@github/copilot-win32-<arch>` package beside it.
- A Copilot CLI that speaks SDK protocol 3. If the CLI is older, the chat fails
  with "Update Copilot CLI with copilot update."
- A missing CLI shows the "install Copilot CLI" empty state, with the sign-in
  steps. ADE reuses that login and does not write `~/.copilot`.

## How it runs

- **One worker per chat.** Each chat's environment carries its ADE chat id, so
  each chat gets its own forked worker. The pool keys a worker by the CLI path,
  the config home (`COPILOT_HOME`, passed as the SDK `baseDirectory`) and a
  fingerprint of the environment. Chats never share a worker.
- **Account reads share a worker.** The model list, the sign-in check, the quota
  read and utility tasks run without a chat id. They share one worker per
  environment.
- **Stop.** A worker is released when nothing holds it. It is disposed after a
  short grace period.
- **Crash recovery.** If a chat's worker dies, including from a signal such as
  an out-of-memory kill, the running turn is marked interrupted and its open
  questions and approvals are cancelled. The next
  message starts a new worker and opens the chat's SDK session again by its saved
  id, so the history comes back. Pending approvals are not resumed.
- **Remote machines.** The worker runs on the lane's machine, like every other
  chat. Actions that act on a Copilot chat take the chat's machine pin.

## Auth and plan

- Sign-in is the Copilot CLI's own login (`copilot login`). Settings keeps that
  terminal flow and its copy.
- ADE reads the signed-in state with `client.getAuthStatus()`. This needs no
  session, so checking auth never starts a session or an MCP server.
- The plan and premium-request quota come from the usage poll. See
  [Usage, context and quota](#usage-context-and-quota).
- **Auto-only plans.** Some accounts get an empty model list. ADE then offers a
  single `github-copilot/auto` model named "Auto", and Copilot picks the model on
  each turn.

## Models

- The catalog is `client.listModels()`, run in the worker. ADE saves the list to
  `copilot-model-catalog-cache.json` in the machine's ADE data folder (Electron's
  `userData` in the desktop app, else `ADE_HOME`, else `~/.ade`), with a 6-hour TTL.
- The picker serves the saved list. A live list is fetched when a catalog
  refresh is asked for, and during provider availability checks when the saved
  list is older than 6 hours. With no saved list and no refresh yet, the picker
  offers Auto.
- Each row keeps its id (`github-copilot/<model>`), name, context window, output
  limit, vision support, `supportedReasoningEfforts`, `defaultReasoningEffort`,
  `supportedContextTiers`, long-context window, and billing multiplier. Rows with
  a disabled policy are hidden. Duplicate ids are dropped.
- Reasoning effort comes only from the model's own `supportedReasoningEfforts`
  (the SDK ladder: low, medium, high, xhigh, max). Changing it calls
  `session.setModel(model, { reasoningEffort })` on the live session. No process
  restarts.
- Model switches are live. The served model comes from `session.model_change`,
  `session.auto_mode_resolved.chosenModel`, and the `model` on `assistant.message`
  and `assistant.usage`.
- **Served-model notice.** When the model that writes a reply is not the one the
  chat picked, ADE shows one notice per served model:
  "Copilot used <served>, not <picked> (your plan may not include it)". It is
  never shown for Auto, and it stays visible outside the turn's fold.

## Context tier

- `copilotContextTier` is `default` or `long_context`. A missing or invalid value
  means `default`. A tier is only kept on a model whose row lists
  `long_context` in `supportedContextTiers`. Otherwise it is `default`.
- The chip appears only on those rows. On the default tier it shows the model's
  window size. On the long tier it shows the long-context window size, or "Long"
  when that size is unknown. Its tooltip says long context costs more.
- Pressing the chip on the selected row toggles the tier. Pressing it on another
  row selects that model at the tier the chip shows.
- A change mid-chat calls `session.setModel(model, { contextTier })` on the live
  session.

## Auto profile

- On the Auto model, the effort picker is replaced by three profiles:
  Efficiency, Balance and Intelligence. `copilotAutoTier` stores the choice.
- An unset profile is sent to the SDK as no profile, so the SDK's default routing
  applies. The profile goes out on session create and resume as `capi: { autoTier }`.
  A profile-only change on a live session calls `session.setAutoTier(tier)`.
- **Pending.** The runtime can answer a change with `status: "pending"`. ADE then
  shows "Applies from the next message". `session.model_change` with the new
  `autoTier` confirms it.
- **Failure.** `session.auto_tier_switch_failed` clears the pending choice,
  restores the last confirmed profile, and shows a warning notice.

## Permission levels

ADE's five levels map onto Copilot's session mode and permission mode:

| ADE level | Copilot behavior |
|---|---|
| Plan | Session mode `plan`, with approvals set to manual so a chat that was at Full-auto cannot plan under allow-all. When the agent asks to leave plan mode, ADE's plan-approval card shows the plan with "Approve and continue" and "Reject". Approving picks Copilot's recommended action, never Autopilot, and the chat moves to Ask. |
| Ask (default) | Every request goes to ADE's approval card: "Allow once", "Allow for this session" or "Deny". The card shows the write diff or the full shell command. |
| Assisted | Copilot's assisted mode. A safety model attaches a recommendation to each request (`assistedApproval.recommendation`). ADE approves a request only when it says `approve`. Every other answer (`requireApproval`, `excluded`, a judge error) goes to ADE's approval card. If the plan does not allow Assisted, the chat drops to Ask and shows a notice: "Assisted isn't available on this Copilot plan; using Ask". This happens on open and when the level is changed. |
| Auto-edit | Reads and writes inside the lane worktree are approved. Everything else asks. |
| Full-auto | Each request is approved once. A request that managed policy marks `managedApprovalRequired` still asks. |

Shared permission ladder: Plan maps to `plan`, Ask to `default`, Assisted and
Auto-edit to `edit`, and Full-auto to `full-auto`.

Questions from the agent go to ADE's question card through `onUserInputRequest`.
Free-form answers are allowed unless the request forbids them. The SDK's
elicitation requests are not handled.

## Goals (`/goal`)

`/goal` is a desktop chat command, and the goal state is shared with Claude's
`/goal`.

- `/goal <objective>` stores the goal on the chat and sends the turn in Copilot's
  Autopilot mode (`agentMode: "autopilot"`). `/goal` alone shows the current
  goal. `/goal clear` clears it and interrupts a running turn.
- Plan and Ask refuse a goal with "Copilot goals need Auto-edit or higher. Change
  the permission mode before setting a goal." Assisted, Auto-edit and Full-auto
  accept one.
- A goal ends when `session.task_complete` arrives. A successful task posts
  "Goal reached: <objective>". An unsuccessful one posts "Goal blocked:
  <objective>". The desktop also raises an OS notification, and the phone gets a
  push. An abort with reason `autopilot_credit_limit` posts "Goal blocked".
- `/goal clear` ends the goal without a reached or blocked notice.

## Turns, steering and queueing

- **Send** calls `session.send({ prompt, attachments })`.
- **Steer** (sent while a turn runs, inline) uses `mode: "immediate"`. The
  message joins the running turn.
- **Queue** uses `mode: "enqueue"`. The message runs after the current turn.
- **Interrupt** calls `session.abort()` and marks the turn interrupted. The
  message is not sent again. The session stays usable.
- **Turn end** is `session.idle`. An aborted idle marks the turn interrupted.
- **Close** calls `session.disconnect()`, which keeps the data so the chat can
  resume. ADE never deletes a user chat's SDK session.

## Events

| SDK event | ADE |
|---|---|
| `assistant.message_delta` / `assistant.message` | Assistant text. A full message is skipped when its deltas already streamed. |
| `assistant.reasoning_delta` / `assistant.reasoning` | Reasoning. |
| `tool.execution_start`, `tool.execution_progress`, `tool.shell_output`, `tool.execution_partial_result`, `tool.execution_complete` | Tool cards with the MCP server and tool name, shell output, and the result status. |
| `tool.execution_complete` `fileEdits` | File change rows with the path and the create, modify or delete kind. The diff is not carried here. |
| `session.todos_changed` | Triggers a re-read of the todos through `rpc.plan.readSqlTodos()`. |
| `subagent.started`, `completed`, `failed` | Subagent cards, attributed by the event's `agentId`. |
| `session.compaction_start` / `complete` | Context compaction events. |
| `session.usage_info` | The context meter (`currentTokens` over `tokenLimit`). |
| `session.error`, `model.call_failure`, `session.warning` | Errors and notices. Errors are classed as auth, rate limit, network or unknown. |
| `abort` | "Copilot turn was interrupted." |
| `session.model_change`, `session.auto_mode_resolved` | Served-model notice and Auto profile confirmation. |
| `session.auto_tier_switch_failed` | Restores the last confirmed Auto profile. |
| `session.task_complete` | Ends the active goal, with "Goal reached" or "Goal blocked". |

Diffs for file writes come from the write approval's `diff`, when ADE asks for
one. The file change rows that follow a tool call carry paths only.

## Attachments

- Images go as `{ type: "blob", data, mimeType, displayName }`. Other files go
  as `{ type: "file", path }`.
- The Copilot send path does not check the selected model's vision support.
  Images are sent as they are.

## MCP servers

- **ADE's own servers** and the **MCP registry** servers go to the session as
  `mcpServers`. Registry servers keep their `Authorization` headers.
- **The user's own servers.** Interactive chats keep Copilot's config discovery
  on, so servers from the workspace `.mcp.json` and from the user's Copilot
  config (`mcp-config.json` under `COPILOT_HOME`) run in chats. ADE shows no
  notice about them.
- **Sign-in handoff.** When a server asks for OAuth, `onMcpAuthRequest` runs:
  - If ADE already sends an `Authorization` header for that server URL, the
    request is cancelled and no notice is shown.
  - If the MCP registry holds a sign-in for that server URL, ADE returns that
    token to Copilot.
  - Otherwise the request is cancelled and one warning notice is posted per chat
    and server. A server that is not in ADE's MCP registry gets: "<server> needs
    a sign-in. Add it to ADE's MCP servers (Settings → MCP servers → Import) and
    sign in once — every agent will use it." A server in the registry but signed
    out gets: "<server> needs a sign-in. Sign in from Settings → MCP servers."
  - ADE does not start the OAuth browser flow for these requests. Copilot no
    longer opens browser tabs for ADE's servers.

## Background tasks never start user MCP servers

Titles, summaries and commit messages run on a utility session, not on a chat:

- `disabledMcpServers` lists every server name in the user's Copilot config, so
  none of them start or authenticate. If ADE cannot list them, the task fails
  closed.
- No tools (`availableTools: []`), no custom instructions, and infinite sessions
  off.
- The prompt is text. A task with images is refused, as for Qwen, Kimi and Grok.
- The session runs one `sendAndWait` with a 120-second timeout, then it is
  deleted.

## Skills, instructions and commands

- `skillDirectories` is ADE's bundled agent skill roots. Personal chats get none.
- Copilot's own CLI slash commands are not listed in the composer. ADE's own
  commands still work.

## Usage, context and quota

- **Per turn.** Each `assistant.usage` event adds input, output, cache read and
  cache write tokens, and reasoning tokens. These fill the turn's usage record.
  The context meter comes from `session.usage_info`.
- **Premium requests per turn.** ADE reads the account's usage metrics before
  and after each turn. The change is that turn's premium-request count, unless a
  premium count on an `assistant.usage` event is higher. The turn's record carries
  it as a `premium_request` plan-usage unit.
- **Quota.** The usage poll reads GitHub's `copilot_internal/user` endpoint for
  the premium-interaction counts, the plan and the reset date. When that response
  has no counts or no plan, ADE reads the SDK's account quota instead. That read
  is cached for 15 minutes unless the user asks for a refresh. The SDK windows
  replace the GitHub ones when they have any. The windows show used and
  entitlement counts, percent, the reset date, and an unlimited flag.
- **History.** The account-level history scanner still reads Copilot CLI's
  `session-store.db` (`assistant_usage_events`), as it did before. Per-turn usage
  for SDK chats comes from the SDK events. See
  `onboarding-and-settings/usage-tracking.md`.

## Fork and rewind

- **Rewind.** The rewind points are the root user turns Copilot captured, keyed
  by the id of each turn's `user.message` event. When a turn starts, ADE records
  that id against its own message id (`copilotRewindEventIds` in the chat state),
  so a rewind finds the exact turn even when two messages read the same. Chats
  from before that match on text: Copilot's recorded prompt can carry ADE's
  context ahead of what the user typed, so both sides match by suffix. ADE
  lists them, previews the files a rewind would restore, and then applies the
  rewind to the conversation and the files. File changes are tracked for
  interactive chats, so a turn can be undone with its files. Applying a rewind is
  refused while a turn is running. Previewing is not. If Copilot has no rewind
  point for a message, or did not capture file changes for it, ADE says so.
- **Native fork.** A fork of a Copilot chat into a Copilot chat uses the SDK's
  session fork. A fork from an earlier turn keeps that turn and everything it
  produced: the boundary is the next top-level user message. The turn is found
  by the Copilot event id ADE recorded for it (see Rewind); older chats fall back
  to its text and order. The new session id is stored as the new chat's `copilotSdkSessionId`.
  A fork is refused while a turn is running.
- **Cross-machine.** Cross-machine fork is not offered for Copilot. The fork
  belongs to the source machine's Copilot CLI and cannot be resumed by another
  machine's install. Same-machine handoff fork is offered.

## CLI and TUI

`ade chat create` and `ade new chat` take three Copilot flags. Passing one with
another provider is an error.

- `--copilot-permission-mode`: `plan`, `ask`, `assisted`, `auto-edit` or `full-auto`.
- `--copilot-context-tier`: `default` or `long_context`.
- `--copilot-auto-tier`: `efficiency`, `balance` or `intelligence`.

The TUI setup pane shows the same five permission modes, the context-tier toggle
and the Auto profile row.

## Legacy chats

A Copilot chat created before this change has a saved `acpSessionId`. ADE reads
it as the SDK session id. Opening the chat calls `resumeSession` with it, and the
full history comes back. If Copilot no longer has the session, ADE opens a new
one and says so in the chat; the earlier messages stay visible but Copilot cannot
see them.

## What stays the same

- **The terminal Copilot CLI.** Launching the native `copilot` in a terminal,
  its session id flag and its terminal signals are unchanged. See
  `terminals-and-sessions/`.
- **Usage history import.** The local usage ledgers and the account scanners are
  unchanged. See `onboarding-and-settings/usage-tracking.md`.
- **External session import.** Discovery of the CLI's own sessions and the
  transcript conversion are unchanged. See
  `terminals-and-sessions/external-session-import.md`.

## Not in this build

These are deliberately not built yet:

- Per-chat AI-credit budget (`sessionLimits`).
- Fleet (sub-agent fleet), memory, citations, canvases and workflows.
- Remote and cloud sessions.
- BYOK providers through Copilot.

## Troubleshooting

- **"Update Copilot CLI."** The installed CLI speaks an older SDK protocol. Run
  `copilot update`, then retry.
- **Only "Auto" in the model list.** Expected on an Auto-only plan, or before the
  first live model list is saved.
- **"<server> needs a sign-in."** If the notice asks you to add the server, add it
  to ADE's MCP servers and sign in once. Otherwise open the server's sign-in from
  Settings → MCP servers. Then retry the chat.
- **"Assisted isn't available on this Copilot plan; using Ask."** The plan does
  not allow Assisted. Choose another level if you need one.
- **"Copilot goals need Auto-edit or higher."** Change the permission mode, then
  set the goal again.
- **"Copilot no longer has this conversation, so it started a new one."** The
  chat's saved Copilot session is gone (Copilot's session store was cleared, or
  the chat came from another machine). ADE opens a new session; the earlier
  messages stay in the chat, but Copilot cannot see them.
- **"Copilot could not switch to the new model / permission level."** Copilot
  refused a live change. ADE closes the session (the conversation is kept) and
  the next message reopens it with the new setting. If a turn is running it
  finishes first, unless the change was to a stricter permission level: then
  the turn stops at once, so tools do not keep running under the looser level.

## Related

- `acp-providers-spec.md`: the ACP providers that remain (Qwen, Kimi, Grok, Devin).
- `agent-routing.md`: the runtime table and how a chat picks its provider.
- `README.md`: the chat runtime overview.
