# Antigravity provider

ADE runs Google's Antigravity CLI, `agy`, in two ways: chats run `agy acp` on
the shared ACP host ([acp-providers-spec.md](acp-providers-spec.md)), and
terminals run the `agy` TUI. Google stopped the standalone ACP server
(`agy_acp_server`, ACP registry id `antigravity-acp`) at 1.4.5 and moved ACP
into the CLI at 1.5.0, so ADE pins the CLI.

## Where things live

| Piece | File |
|---|---|
| Dialect (spawn plan, capabilities, mode mapping, system prompt, account tier) | `apps/desktop/src/main/services/chat/acpHost/acpDialects/antigravity.ts` |
| A turn's real outcome (quota and API errors from the session log) | `apps/desktop/src/main/services/chat/acpHost/acpDialects/antigravityTurnOutcome.ts` |
| Tool-call fixes (edit paths and hunks, new-file text, command output) | `apps/desktop/src/main/services/chat/acpHost/acpDialects/antigravitySessionUpdates.ts` |
| Read-only session-log reader (steps, conversation metadata) | `apps/desktop/src/main/services/chat/acpHost/acpDialects/antigravitySessionLog.ts` |
| Background subagents (cards, progress, results, agy's reply) | `apps/desktop/src/main/services/chat/acpHost/acpDialects/antigravityChildWork.ts` |
| Import of past agy conversations | `apps/desktop/src/main/services/externalSessions/discoverAntigravity.ts`, `externalSessions/events/antigravity.ts` |
| Captured `initialize` (1.5.6) | `apps/desktop/src/main/services/chat/acpHost/fixtures/antigravity.initialize.json` |
| Per-launch temp directories | `apps/desktop/src/main/services/chat/acpHost/acpScratchDirs.ts` |
| Signed-in check, credential environment, ADE's own settings | `apps/desktop/src/main/services/ai/antigravityAuth.ts` |
| Sign-in runner (`agy acp --login`, paste-back code, `authenticate` for the other methods) | `apps/desktop/src/main/services/ai/antigravitySignIn.ts` |
| Settings sign-in panel | `apps/desktop/src/renderer/components/settings/providers/bodies/AntigravitySignIn.tsx` |
| Terminal launch lines | `apps/desktop/src/shared/cliLaunch.ts` (`antigravity` profile), `apps/desktop/src/main/services/pty/pinnedProviderCli.ts` |
| Pin (tool `antigravity`) | `apps/ade-cli/scripts/pins/antigravity.json`, tools manifest |

## The pinned copy

The tools cache entry `antigravity` is the CLI from GitHub releases of
`google-antigravity/antigravity-cli` (`agy_cli_<os>_<arch>.tar.gz`, a zip on
Windows). Each archive holds one binary, `antigravity` (`antigravity.exe`).
`tools:pin` takes GitHub's sha256 digest for each asset and checks it against a
full download. Resolution is the same as every ACP provider (env override
`ANTIGRAVITY_CLI_EXECUTABLE`, or the old `ANTIGRAVITY_ACP_EXECUTABLE`, for
development, then the current pin, then the previous pin); a miss starts the
download and shows "Downloading Antigravity for this machine…". The status row
and Download/Retry come from the generic pinned-tool actions
(`ai.pinnedToolStatus` / `ai.pinnedToolDownload`).

The CLI updates itself unless told not to. Every spawn, chat and terminal,
gets `AGY_CLI_DISABLE_AUTO_UPDATE=1` (`pinnedToolSpawnEnv.ts`), so ADE's pinned
bytes are the ones that run.

## Chat spawn

- Command: the pin's binary with `acp --disable-telemetry`.
- `TMPDIR` (`TEMP` and `TMP` on Windows) = `<os temp>/ade-agent-tmp/<ADE pid>-antigravity-<random>`,
  created before the spawn and removed when the process exits (a force-killed
  ADE's leftovers are swept later).
- `BROWSER` = a command that exits 0 and opens nothing (`/usr/bin/true`;
  `cmd.exe /d /c exit 0` on Windows).
- Google credential variables (`GEMINI_API_KEY`, `GOOGLE_API_KEY`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`/`LOCATION`, …) are
  removed, and only the recorded method gets its variables back
  (`antigravityCredentialEnv`). An ambient key cannot decide which account a
  chat bills.
- ADE never passes `--gemini-dir` or `--app-data-dir`: the login and the
  conversations are the user's own, the same as `agy` in their terminal.

## Capabilities (verified 2026-11-11, 1.5.6, Windows x64)

- ACP v1. `authMethods`: `oauth-personal`, `oauth-business`, `gemini-api-key`,
  `agent-platform`. Unauthenticated `session/new` is `-32000 Authentication
  required`.
- `loadSession`, and `sessionCapabilities` `resume`, `close`, `load`, `list`,
  `additionalDirectories`. With `session/close`, chats in one lane share one
  process (`close_request`); rejoin is resume-preferred.
- Image prompts and embedded context; no audio.
- No `mcpCapabilities`: MCP servers reach it over stdio only. ADE hands it the
  registry's stdio servers (`REGISTRY_ONLY_MCP_SUPPORT` in
  `callerMcpServers.ts`); its own `~/.gemini/config/mcp_config.json` also
  loads, and a same-named server there wins.
- `_meta.antigravity.systemPrompt.append`: ADE's lane guidance goes into the
  system prompt on `session/new`, `session/resume` and `session/load` (the
  agent keeps none of it, so it is sent on each), instead of riding the first
  user turn (`systemPromptMeta` on the dialect).
- `auth.logout` is advertised; ADE hides the agent's `/logout` from the slash
  picker because it signs out every client on the machine.
- Models are the `model` config option (signed in on a Google account:
  Gemini, Claude and GPT-OSS models); `thought_level` (low, medium, high)
  carries reasoning effort. From 1.5.1 every model on the account is offered
  to every ACP client.
- `session/new` names the account tier in `_meta.antigravity.tier`
  (`{ name, id, upgradeUri }`; "Antigravity Starter Quota" on a Google
  account). Its name is the turn account's plan.
- Usage comes on the prompt result. agy's `inputTokens` leaves out the cached
  tokens (`totalTokens` = input + cachedRead + output), so the dialect adds
  them back before ADE's reader splits them off (`antigravityUsage`). There is
  no `usage_update`.

### Failed turns

agy reports a quota, a rate limit or a Google API error as a chat message and
`end_turn`. Its session log says otherwise: every session is a SQLite file,
`~/.gemini/antigravity-cli/conversations/<sessionId>.db`, and a failed turn
ends with an error step (`step_type` 17) whose text is the API error
(`Error 429, Message: …, Status: RESOURCE_EXHAUSTED`, plus `quotaResetDelay`,
`quotaResetTimeStamp` or `retryDelay`). An exhausted quota can also come back
as `stopReason: "refusal"`. Before each prompt ADE notes the log's last step;
after it, it reads only the newest new step, read-only, and a bounded prefix of
its text (`dialect.turnOutcome`). A quota or a 429 fails the turn with a
usage-limit card, and the reset time it names arms auto-resume; any other API
error fails the turn with the agent's message. A log that is missing,
unreadable or not a plain file leaves the turn as the agent answered it.

### Tool calls (verified 1.5.6, Windows)

- Permission requests offer only `allow` (`allow_once`) and `deny`
  (`reject_once`).
- An edit's finished update names its file `/C:/Users/…`; ADE drops the
  slash before a drive letter. A finished snippet edit is placed on its real
  lines when the new snippet occurs once in the file (512 KB or less).
- `write_file`'s finished diff has one newline more than the file; the new
  file's text comes from its `Content` argument.
- `run_command` output loses agy's "Created At / Completed At / Command
  exited" header, and the exit code (`rawOutput.exit_code`) goes on the row.
- A PDF sent as a resource (link or blob) never reaches the model, but agy's
  `read_file` reads one from a path, so binary attachments are handed over by
  path (`readsBinaryAttachments`).
- `ask_question` (`{ questions: [{ question, options, is_multi_select }] }`,
  an option may start "(Recommended) ") ends the turn and writes the question
  as text. ADE raises a question card from the tool call
  (`dialect.asyncQuestions`); the answer goes back as the next message.

### Modes

| ADE permission | `agy acp` mode |
|---|---|
| Plan | `plan` |
| Ask | `default` |
| Accept edits | `accept-edits` |
| Auto | `auto` (1.5.4+; not for Gemini Enterprise accounts, which then stay in `default`) |
| Full access | `default`, and ADE answers every permission request (`hostAnswersFullAccess`) |

The CLI has no full-access mode over ACP, so Full access is ADE approving each
request and recording it in the transcript.

### Subagents

`invoke_subagent` (`{ Prompt, Role, TypeName, Model, Workspace }`) returns at
once, and the turn ends while the subagent runs on in agy's process with its
own conversation log. Its result goes to agy as a message, and agy writes a
reply, but none of that comes over ACP. ADE reads it from the logs instead
(`dialect.backgroundWork`, `antigravityChildWork.ts`):

- When a turn ends, each launch in the steps it added becomes a subagent card.
  The child's conversation id is in the launch's result.
- While a child is open, a 2-second poll reads the child's log for progress
  and the parent's for the result and what agy did next. It runs only then,
  and skips a log whose size and time have not changed. agy's thinking, text
  and finished tool calls (with their output) show as a turn of their own, or
  in the running turn when the user has already sent another message. A tool
  still running is read again until it finishes.
- A tool that needs approval is held, not asked for: agy sends nothing until
  the next `session/prompt`, which opens with that tool call and its
  `session/request_permission`. ADE shows a note ("Antigravity is waiting to
  run …") and the approval card comes with the user's next message.
- A chat with an open subagent, a running background tool, or a held tool is
  not closed for idling. Closing agy's process cancels a held tool (verified).
  A held tool keeps the chat open for at most 30 minutes. A child that writes
  nothing for 30 minutes is reported stopped, and so is every open child when
  the chat's agy process exits.

A step's status is in the `steps.status` column: 3 done, 6 cancelled, 7 failed
or denied, 9 waiting for approval, anything else running.

Cost (measured on Windows against real agy logs, 1.5.6): an idle tick is two
`stat` calls (about 25 µs); a tick after a change, and the read at each turn's
end, open the SQLite log and read the new steps (1–3 ms, mostly the open;
each payload is capped at 256 KB).

A chat started without a model (from the CLI, say) takes agy's current model
from `session/new`'s config options, so the composer shows the real model.

### Session log

Every agy conversation, from the TUI or ACP, is
`~/.gemini/antigravity-cli/conversations/<id>.db` (SQLite, with a WAL while
agy has it open). `antigravitySessionLog.ts` reads it read-only and bounded
(`busy_timeout` 50 ms, payloads capped), and never throws: a field it cannot
read is left out. The `steps` table holds protobuf payloads. The fields ADE
reads (1.5.6) are listed in the file's header: the user's text, the reply's
text, thinking and tool calls, a tool's result (`140.2.1`), a message from
another conversation, and the step's time. `trajectory_metadata_blob` holds
the workspace (`file://` URL), the creation time, and the system prompt an
ACP client opened the conversation with.

### Import

Past agy conversations list in the session importer as "Antigravity". A
conversation's folder is its recorded workspace; one with none (a TUI started
outside a workspace) lists only when the import is not scoped to a project.
Left out: subagents (their log opens with the parent's message), and
conversations an ADE chat opened (their system prompt is ADE's `## ADE`
guidance; a live ADE chat is also matched by its `acpSessionId`).

- CLI continue runs `agy --conversation <id>` in the conversation's folder.
  agy has no fork, so there is no CLI copy.
- Chat copy replays the conversation into a new ADE chat. The preview and the
  copy page backwards through the steps (user messages, replies, thinking,
  tool calls and their results). Chat continue is off, as for the other ACP
  providers.

### Gaps

- **No rewind or edit of earlier turns.** Continue with a follow-up or start a
  new chat.
- **No usage limits.** Google's quota API needs the account's OAuth token,
  which ADE does not read in the background.

## Terminals

The `antigravity` terminal profile runs the TUI from the same pin. ADE's
permission maps to `--mode plan`, `--mode accept-edits`, `--mode auto` or
`--dangerously-skip-permissions` (Full access); the model and effort go in
`--model` and `--effort`; a prompt goes in `-i`. Resume is `--conversation
<id>` when ADE knows the id, else `--continue`. The TUI prints
`agy --conversation=<id>` when it exits, and ADE reads the id from the
terminal's output (`terminalSessionSignals.ts`), so a closed Antigravity
terminal resumes its own conversation on every OS. ADE has no default resume
line for it: `agy -c` is the latest conversation on the machine, which can be
a chat's. The TUI has no telemetry flag (it exits on `--disable-telemetry`;
only `agy acp` takes one). In a plain shell only `agy` is
swapped for the pinned binary; `antigravity` is left alone because it is also
the Antigravity editor's launcher.

## Sign-in

Sign-in is an explicit action in Settings > Providers > Antigravity (also the
chat's sign-in card and the first-run rail) and runs on the machine the page
shows. The runtime actions `ai.antigravitySignInStatus`,
`ai.antigravitySignInStart`, `ai.antigravitySignInComplete` and
`ai.antigravitySignInCancel` are reachable remotely (action domain `ai`,
`actionPolicy` remote list, `adeActionAccess` tiers); preload methods take
`pin` and go through `callPinnedOrBoundRuntimeActionOr`; the panel passes
`useSettingsMachineScope().pin`. Start, status reads, the pasted code and
cancel all go to that one machine. Every method ends with one `session/new`
that proves the login. A flow times out after five minutes; Cancel ends it
and the process.

| Method | What ADE does |
|---|---|
| Google account (`oauth-personal`, default) | Runs `agy acp --login`. The CLI prints a Google link whose `redirect_uri` is `https://antigravity.google/oauth-callback`, a page that shows a code once the person approves, and reads the code (or that page's full address) from stdin. Nothing listens on the machine, so the same paste works from any computer, the phone, the web client and ADE Cloud. ADE checks the link (Google's auth endpoint, that redirect, one `state`, `response_type=code`) and the pasted value (a bare code, or a landing address with the same `state` and one `code`) before writing it to the CLI's stdin. |
| Gemini Enterprise (`oauth-business`) | The ACP `authenticate` request. The CLI opens the OS browser itself (it ignores `BROWSER`) and waits on a `localhost` listener without printing the link, so this finishes only in a browser on the machine that runs the agent. |
| Gemini API key (`gemini-api-key`) | `GEMINI_API_KEY` from ADE's key store (the key sheet on the Antigravity page, slot `antigravity-gemini`), passed only for this method. |
| Agent Platform (`agent-platform`) | `GOOGLE_API_KEY` from ADE's key store (slot `antigravity-agent-platform`), or the machine's ADC variables plus a project and location ADE keeps in `<ADE home>/providers/antigravity.json`. |

The link, `state`, code and tokens are never logged.

## Where the login lives

The CLI keeps its state in `~/.gemini/antigravity-cli/` (GEMINI_HOME does not
move it), and a sign-in writes no `settings.json`. The stored sign-in is one
JSON value, `{ token: { access_token, refresh_token, expiry, … }, auth_method,
id_token_email }` (`auth_method` is `consumer` for a Google account). It is in the OS keyring (go-keyring service `gemini`,
user `antigravity`: the Keychain on macOS, the generic credential
`gemini:antigravity` in Windows Credential Manager, Secret Service on Linux).
Where no keyring works, a slow one times out, or the CLI runs in a container or
WSL, it uses the file `~/.gemini/antigravity-cli/antigravity-oauth-token`
instead (verified on Linux 1.5.6). ADE Cloud computers are containers, so a
login there is that file. Verified 2026-11-12 on a real ADE Cloud computer
(Debian 12 container): the pinned 1.5.6 refused `session/new` signed out, and
with the carried login (the Windows keyring item, written as that file) it
opened a session in 1.9 s and finished a turn in 3.3 s. agy rewrites the file
as it refreshes the access token.

Users of the old standalone server sign in again: its
`~/.gemini/antigravity-acp/` login is neither read nor migrated.

## Signed-in status without a spawn

`inspectAntigravityCredentials` reads the CLI's `settings.json`
(mtime-cached), then:

- Google account / Gemini Enterprise: the token file, else whether the OS
  keyring has the item. The check reads attributes only, never the secret, and
  never prompts: `security find-generic-password` without `-w` on macOS,
  `cmdkey /list:gemini:antigravity` on Windows, Secret Service `SearchItems`
  through `gdbus` on Linux. It runs asynchronously and is cached for 30
  seconds (10 minutes after a timeout, which means an unlock dialog).
- Gemini API key: a key in ADE's store or the environment.
- Agent Platform: a key, or a project and location from any source.

The ACP auth probe runs only when the pin is on disk. It checks `session/new`
and never sends `authenticate`.

## Surfaces

Settings descriptor and logo (LobeHub's Antigravity mark), model picker rail,
`ade chat models --provider antigravity`, terminals and `ade` CLI sessions
(`start_cli_session` provider `antigravity`), the web client (through the same
actions), and iOS (`WorkModelCatalog.swift` group and label, provider
label/color, CLI launches).
