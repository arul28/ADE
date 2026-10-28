# GitHub Copilot SDK provider

How ADE runs a GitHub Copilot chat. Copilot is no longer an ACP provider. It is
an SDK provider, like Droid and Cursor: ADE drives the official
`@github/copilot-sdk` on the Copilot runtime that SDK ships, which ADE pins and
downloads like Claude's binary.
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
| `apps/desktop/src/main/services/chat/copilotSdkPermissions.ts` | The "Allow for this session" rule Copilot can remember for a permission prompt. |
| `apps/desktop/src/main/services/ai/acpExecutables.ts` (`resolveCopilotSdkRuntime`) | Picks the runtime chats run on: a dev/test override, ADE's pinned download, the SDK's own package (a source checkout), the previous pinned version. Never the machine's `copilot`. `resolveCopilotExecutable` in the same file resolves the separate `copilot-cli` pin that terminals run. |
| `apps/desktop/src/main/services/ai/providerConnectionStatus.ts` (`buildCopilotConnection`) | Copilot's Settings and availability status, from the SDK's live sign-in check. |
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

- **No Copilot CLI install.** `@github/copilot-sdk` ships its runtime in a
  per-platform package (`@github/copilot-sdk-<platform>`, about 125 MB). ADE
  pins it in the tools manifest (`copilot`, from `apps/desktop/package-lock.json`,
  so the worker's SDK and the runtime it spawns cannot drift) and downloads it to
  `~/.ade/tools` like Claude's binary; the installer and the brain archive no
  longer carry it. ADE starts that `copilot-runtime` over stdio through
  `RuntimeConnection.forStdio({ path })`. It is the version the SDK was built
  against, so it always speaks the SDK's protocol.
- **When it downloads.** At launch and `ade serve` when the machine shows signs
  of Copilot (a `copilot` CLI, a token in the environment, `~/.copilot`, or a
  `gh auth login`); otherwise when a status refresh first finds one of those, or
  when a Copilot chat or task starts. A chat says "ADE is downloading the
  Copilot runtime for this machine" while it waits. See
  [agent-tools-cache.md](../onboarding-and-settings/agent-tools-cache.md#which-tools-a-machine-fetches).
- **Runtime order** (`resolveCopilotSdkRuntime`): `COPILOT_EXECUTABLE` or
  `GITHUB_COPILOT_EXECUTABLE` when set, then the pinned download, then the SDK's
  own platform package in `node_modules` (a source checkout, which
  `require.resolve` also finds through the brain's `NODE_PATH`), then the
  previous pinned version while a new one downloads, else missing (the chat
  waits for the download). A candidate counts only with its `runtime.node`
  beside it. The machine's own `copilot` is never used. An override that does
  not match the SDK fails with the SDK's protocol message plus
  "COPILOT_EXECUTABLE names a Copilot that does not match ADE's Copilot SDK."
- **Self-update off.** The SDK passes `--no-auto-update` to its runtime, and ADE
  also sets `COPILOT_AUTO_UPDATE=false` on the runtime and the terminal CLI.
- **No fall-forward.** The runtime is version-paired with the SDK, so ADE never
  swaps in a newer one on its own. When an organisation policy requires a newer
  client (`managed_client_update_required`, or "your organization's managed
  settings require version X or newer"), the failed request and the chat's
  `session.error` read "Your organization's GitHub Copilot policy requires
  Copilot X or newer. ADE runs its own tested copy (Y) and does not update it on
  its own, so Copilot cannot run until ADE is updated." The stderr line logs as
  `agent_chat.copilot_client_update_required`.
- **Other machines.** Every brain downloads the same pinned runtime for itself;
  a host the manifest does not pin (Windows on Arm) reads "not available on
  this machine". Target detection does not tell musl Linux from glibc, so an
  Alpine host gets the glibc `linux-x64` pin, as it already does for Claude and
  Codex. The standalone `ade` runtime (`install.sh`, the SSH
  bootstrap) is one Node SEA executable with no `copilotSdkWorker.cjs` beside
  it, and `fork()` from it re-enters the CLI, so there the pool runs the worker
  through the executable's hidden `__ade-copilot-sdk-worker` command
  (`chat/sdkWorkerProcess.ts`). Cursor, Droid and Pi do the same with
  `__ade-cursor-sdk-worker`, `__ade-droid-sdk-worker` and `__ade-pi-sdk-worker`.
- **The terminal Copilot CLI** is a separate pin, `copilot-cli` (npm
  `@github/copilot-<platform>`, 1.0.98), because the SDK runtime is not an
  interactive CLI. Terminals and sign-in run it by absolute path
  (`resolveCopilotExecutable`, `pty/pinnedProviderCli.ts`) and wait for its
  download. Logins stay in `~/.copilot` (`COPILOT_HOME`), shared with the
  user's own CLI.

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

- ADE signs no one in. The runtime reuses the login the machine already has, in
  the CLI's order: `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, then the
  stored `copilot login` (keychain), then `gh auth login`. ADE's runtime is
  headless and has no `login` command, so Settings shows `copilot login` and the
  empty state names `gh auth login` too.
- ADE reads the signed-in state with `client.getAuthStatus()` on every status
  refresh. This needs no session, so checking auth never starts a session or an
  MCP server. Its answer is the truth for Copilot's Settings tile and
  availability (`providerConnections.copilot`): the disk check (a token variable
  or `logged_in_users` in `$COPILOT_HOME/config.json`) is used only when the
  probe fails, because it misses keychain and `gh` logins and keeps stale ones.
- **A token variable wins over `copilot login`.** When the SDK says signed out
  and one of the token variables is set, Settings names it: a classic `ghp_`
  token is not accepted by Copilot, so unset it or replace it with a
  fine-grained token that has the Copilot Requests permission.
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
  context tiers, long-context window, and billing multiplier. Rows with a
  disabled policy are hidden (an `unconfigured` policy only means none is set).
  Duplicate ids are dropped.
- **Windows are prompt budgets per tier**, as the Copilot CLI's picker shows
  them: `billing.tokenPrices.maxPromptTokens` for the default tier and
  `billing.tokenPrices.longContext.maxPromptTokens` for the long tier (each
  falling back to its deprecated `contextMax`). Without tier prices the window is
  `capabilities.limits.max_prompt_tokens`, then `max_context_window_tokens`.
- Reasoning effort comes only from the model's own `supportedReasoningEfforts`
  (the SDK ladder: low, medium, high, xhigh, max). Changing it calls
  `session.setModel(model, { reasoningEffort })` on the live session. No process
  restarts.
- Model switches are live. The served model comes from `session.model_change`,
  `session.auto_mode_resolved.chosenModel`, and the `model` on `assistant.message`
  and `assistant.usage`.
- **Served-model notice.** When the model that writes a reply is not the one the
  chat picked, ADE shows one notice per served model:
  "Copilot used <served>, not <picked> (your plan may not include it)". When
  Copilot switched on its own (`session.model_change.cause`), the notice says
  why instead: "Copilot switched to <served> after a rate limit" or "… because
  <picked> declined the request". It is never shown for Auto, and it stays
  visible outside the turn's fold.

## Context tier

- `copilotContextTier` is `default` or `long_context`. A missing or invalid value
  means `default`. A tier is only kept on a model whose row lists
  `long_context` in `supportedContextTiers`. Otherwise it is `default`.
- **Where the tiers come from.** Copilot's own models carry them in
  `billing.tokenPrices`: a model with a `longContext` price offers the long tier,
  and the row lists `default` and `long_context`. The SDK's
  `Model.supportedContextTiers` is only filled by providers with no pricing to
  publish, so it is merged in but never relied on.
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
| Assisted | Copilot's assisted mode. A safety model attaches a recommendation to each request (`promptRequest.assistedApproval.recommendation`). SDK 1.0.22 does not pass `promptRequest` to the permission handler, so the worker reads it from the `permission.requested` event the SDK dispatches with the same request object, and attaches it. ADE approves a request only when it says `approve`. Every other answer (`requireApproval`, `excluded`, a judge error) goes to ADE's approval card. If the plan does not allow Assisted, the chat drops to Ask and shows a notice: "Assisted isn't available on this Copilot plan; using Ask". This happens on open and when the level is changed. |
| Auto-edit | Reads and writes inside the lane worktree are approved. Everything else asks. |
| Full-auto | Each request is approved once. A request that managed policy marks `managedApprovalRequired` still asks. |

Shared permission ladder: Plan maps to `plan`, Ask to `default`, Assisted and
Auto-edit to `edit`, and Full-auto to `full-auto`.

**Allow for this session** is offered only when Copilot can remember it
(`copilotSessionApproval`): shell and write prompts must say
`canOfferSessionApproval`, and the answer carries the rule Copilot matches later
requests against (the command identifiers, the MCP server and tool, the URL's
domain, the workflow's approval key). Path grants, hook prompts and extension
environment access offer Allow once and Deny only, and so does any prompt that
arrives without Copilot's `promptRequest`, since there is nothing to scope the
rule to. The option names its scope (`copilotSessionApprovalLabel`), because
Copilot's `read`, `write` and `memory` rules cover every request of that kind
for the rest of the session: "Allow all file reads for this session", "Allow
these commands for this session", "Allow example.com for this session".

Questions from the agent go to ADE's question card through `onUserInputRequest`.
Free-form answers are allowed unless the request forbids them.

MCP elicitation (`onElicitationRequest`) uses the same question card: a form
becomes one question per schema field, as for Codex, and a URL request shows the
link with Accept and Decline.

**Rate limits and Auto.** When a rate limit is eligible for it, Copilot asks
through `onAutoModeSwitchRequest` whether to continue on Auto. ADE asks "Switch
to Auto", "Always switch to Auto" or "Wait for the limit". The rate-limit error
is held back while it asks; it is shown (and the usage-limit resume armed) only
when the user chooses to wait.

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
| `session.compaction_start` / `complete` | Context compaction events, with `preCompactionTokens` and `postCompactionTokens`. A failed compaction's `error` becomes a warning notice. |
| `session.usage_info` | The context meter (`currentTokens` over `tokenLimit`), broken down into system, tools and conversation tokens. |
| `session.error` | The turn's error, classed by `errorType` (authentication and authorization → auth, rate_limit → rate limit, quota → budget). Its `remediation` and `url` become the detail. A root `session.error` ends the turn as failed. |
| `session.warning` | A warning notice. |
| `model.call_failure` | Not shown: it is per-attempt telemetry and fires for retries that recover. |
| `abort` | "Copilot turn was interrupted." |
| `session.model_change`, `session.auto_mode_resolved` | Served-model notice and Auto profile confirmation. |
| `session.auto_tier_switch_failed` | Restores the last confirmed Auto profile. |
| `session.task_complete` | Ends the active goal, with "Goal reached" or "Goal blocked". |

**Sub-agent events.** Sub-agents stream on the parent session with an envelope
`agentId`; the root agent's events omit it. Only the sub-agent's start and result
cards and its tool calls reach the transcript. Its text, reasoning, model
changes, context usage, errors, idle and abort do not touch the turn, the
served-model notice or the context meter. Its token usage still counts toward the
turn's totals.

Diffs for file writes come from the write approval's `diff`, when ADE asks for
one. The file change rows that follow a tool call carry paths only.

## Attachments

- Images go as `{ type: "blob", data, mimeType, displayName }`. Other files go
  as `{ type: "file", path }`.
- The Copilot send path does not check the selected model's vision support.
  Images are sent as they are.

## MCP servers

- **ADE's own servers** go to the session as `mcpServers`. The MCP
  registry's servers are not delivered to Copilot yet (`registryMcpSupport`
  has no Copilot row); its sign-ins are, through the handoff below.
- **The user's own servers.** Interactive chats keep Copilot's config discovery
  on, so servers from the workspace `.mcp.json` and from the user's Copilot
  config (`mcp-config.json` under `COPILOT_HOME`) run in chats. ADE shows no
  notice about them.
- **Sign-in handoff.** When a server asks for OAuth, `onMcpAuthRequest` runs:
  - If ADE already sends an `Authorization` header for that server URL, the
    request is cancelled and no notice is shown.
  - If the MCP registry holds a sign-in for that server URL, ADE returns that
    token to Copilot. URLs match ignoring host case, a default port, a
    fragment and a trailing slash (`sameMcpServerUrl`).
  - Otherwise the request is cancelled and one warning notice is posted per chat
    and server. A server that is not in ADE's MCP registry gets: "<server> needs
    a sign-in. Add it to ADE's MCP servers (Settings → MCP servers: Import, or
    Add with <origin and path of its URL>) and sign in once — every agent will
    use it." Import lists it because the scan reads Copilot's
    `mcp-config.json`. A registry server that is signed out names the registry
    entry and asks for a sign-in, then a new chat; one switched off here says
    it is off.
  - ADE does not start the OAuth browser flow for these requests. Copilot no
    longer opens browser tabs for ADE's servers.

## Background tasks never start user MCP servers

Titles and summaries run on a utility session, not on a chat:

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

- **The terminal Copilot CLI.** Its session id flag and its terminal signals
  are unchanged; the terminal now runs ADE's pinned `copilot-cli` instead of the
  `copilot` on the PATH. See `terminals-and-sessions/`.
- **Usage history import.** The local usage ledgers and the account scanners are
  unchanged. See `onboarding-and-settings/usage-tracking.md`.
- **External session import.** Discovery still reads the CLI's own store
  (`session-state/<id>/workspace.yaml` and `events.jsonl`), and the transcript
  conversion is unchanged. See
  `terminals-and-sessions/external-session-import.md`.

## Session import

ADE's chats and the user's Copilot CLI share one session store
(`COPILOT_HOME`, default `~/.copilot`), so the import box has to tell them apart.

- **Marking.** The worker creates every session with `clientName: "ade"`, which
  Copilot writes to `workspace.yaml` as `client_name`. A resume does not
  rewrite it. Discovery leaves out `client_name` values that start with `ade`,
  and `client_name: sdk` sessions whose first system message carries ADE's
  coding-agent prompt (ADE's chats from before the marking).
- **Claiming.** A live chat's `copilotSdkSessionId` (or an older chat's
  `acpSessionId`) marks that session "already in ADE" in the import box.
- **Continue.** Continuing a CLI session as a chat seeds it as the chat's
  `copilotSdkSessionId`. The first message opens it with `resumeSession`, in
  the lane root (the importer refuses a session from another folder), on the
  session's recorded model when ADE knows it, else the Copilot default, and in
  the permission mode a new Copilot chat gets (Ask unless a default level maps
  to another). The CLI session's own mode is not carried over. The events the resume returns are not
  replayed; the chat already shows the imported history.

## Not in this build

These are deliberately not built yet:

- Per-chat AI-credit budget (`sessionLimits`).
- Fleet (sub-agent fleet), memory, citations, canvases and workflows.
- Remote and cloud sessions.
- BYOK providers through Copilot.

## Troubleshooting

- **"Your organization's GitHub Copilot policy requires Copilot X or newer."**
  The organisation's floor is above ADE's pinned runtime. A newer ADE release
  with a newer pin fixes it; ADE does not update Copilot on its own.
- **"ADE is downloading the Copilot runtime" / "Couldn't download …".** Wait, or
  press Retry in Settings > Providers > GitHub Copilot on the machine that runs
  the chat.
- **Copilot shows as signed out but `copilot login` worked.** A token variable
  (`COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`) overrides it; Settings
  names the variable to fix or unset.
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
