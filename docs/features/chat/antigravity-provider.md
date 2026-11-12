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
- `ask_question` ends the turn and shows the question and its options as
  text; the next message is the answer.

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

### Gaps

- **No rewind or edit of earlier turns.** Continue with a follow-up or start a
  new chat.
- **Subagents run in the background.** `invoke_subagent` returns at once and
  the turn ends; the subagent writes its own session log, and its result
  reaches agy, not ACP. agy's reply to it waits for the next message.
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
login there is that file.

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
