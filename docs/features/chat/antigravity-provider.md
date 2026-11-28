# Antigravity provider

DAEX runs Google's Antigravity CLI, `agy`, two ways: chats run `agy acp` on the
shared ACP host ([acp-providers-spec.md](acp-providers-spec.md)); terminals run
the `agy` TUI. ACP lives in the CLI since 1.5.0 (the old standalone
`agy_acp_server` is gone), so DAEX pins the CLI (tool `antigravity`, currently
1.5.6). Facts below were verified on 1.5.6; re-verify when the pin moves.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/chat/acpHost/acpDialects/antigravity.ts` | Dialect: spawn plan, capabilities, mode mapping, system prompt meta, account tier, usage fix. |
| `…/acpDialects/antigravityTurnOutcome.ts` | A turn's real outcome (quota and API errors) from the session log. |
| `…/acpDialects/antigravitySessionUpdates.ts` | Tool-call fixes: edit paths and hunks, new-file text, command output. |
| `…/acpDialects/antigravitySessionLog.ts` | Read-only, bounded reader of the SQLite session log. |
| `…/acpDialects/antigravityChildWork.ts` | Background subagents read from the logs. |
| `apps/desktop/src/main/services/chat/acpHost/fixtures/antigravity.initialize.json` | Captured `initialize`. |
| `apps/desktop/src/main/services/chat/acpHost/acpScratchDirs.ts` | Per-launch temp dirs. |
| `apps/desktop/src/main/services/externalSessions/discoverAntigravity.ts`, `externalSessions/events/antigravity.ts` | Import of past agy conversations. |
| `apps/desktop/src/main/services/ai/antigravityAuth.ts` | Signed-in check, credential env, DAEX's own settings. |
| `apps/desktop/src/main/services/ai/antigravitySignIn.ts` | Sign-in runner. |
| `apps/desktop/src/renderer/components/settings/providers/bodies/AntigravitySignIn.tsx` | Settings sign-in panel. |
| `apps/desktop/src/shared/cliLaunch.ts` (`antigravity`), `apps/desktop/src/main/services/pty/pinnedProviderCli.ts` | Terminal launch lines. |
| `apps/ade-cli/scripts/pins/antigravity.json` | The pin. |

## Gotchas

- **The login is the user's own.** DAEX never passes `--gemini-dir` or
  `--app-data-dir`; sign-in and conversations are shared with `agy` in a
  terminal.
- **Ambient Google keys never pick the account.** Google credential variables
  are stripped; only the recorded method's come back
  (`antigravityCredentialEnv`).
- **MCP is stdio only** (no `mcpCapabilities`; `REGISTRY_ONLY_MCP_SUPPORT` in
  `callerMcpServers.ts`). Servers in agy's own `mcp_config.json` also load, and a
  same-named one there wins.
- **PDF resources never reach the model**; binary attachments go by path
  (`readsBinaryAttachments`), which agy's `read_file` can read.
- **Failed turns look like answers** over ACP; the session log is the truth
  (below).
- **The status check never reads the secret or prompts**, and the ACP auth probe
  never sends `authenticate`.
- `/logout` is hidden from the slash picker: it signs out every client on the
  machine.

## Pinned copy and spawn

- From GitHub releases of `google-antigravity/antigravity-cli`; one binary per
  archive. Resolution: `ANTIGRAVITY_CLI_EXECUTABLE` (or old
  `ANTIGRAVITY_ACP_EXECUTABLE`), then current pin, then previous pin; a miss
  downloads. Status and Download/Retry use `ai.pinnedToolStatus` /
  `ai.pinnedToolDownload`.
- Every spawn gets `AGY_CLI_DISABLE_AUTO_UPDATE=1` (`pinnedToolSpawnEnv.ts`).
- Chat command: `acp --disable-telemetry`. `TMPDIR`/`TEMP`/`TMP` point at a
  per-launch dir removed on exit. `BROWSER` is a no-op command.

## Capabilities

- `authMethods`: `oauth-personal`, `oauth-business`, `gemini-api-key`,
  `agent-platform`. Unauthenticated `session/new` → `-32000`.
- `loadSession`; session `resume`, `close`, `load`, `list`,
  `additionalDirectories`. With close, chats in one lane share a process.
- Images and embedded context; no audio.
- `_meta.antigravity.systemPrompt.append` carries DAEX's lane guidance on every
  `session/new`, `resume` and `load` (`systemPromptMeta`).
- Models are the `model` config option; `thought_level` carries effort. A chat
  started without a model takes agy's current one from `session/new`.
- `session/new` returns `_meta.antigravity.tier` (`{ name, id, upgradeUri }`);
  its name is the turn account's plan.
- Usage arrives on the prompt result. agy's `inputTokens` excludes cached
  tokens, so `antigravityUsage` adds them back. No `usage_update`.
- Gaps: no rewind or edit of earlier turns; no usage-limit meter (the quota API
  needs the OAuth token, which DAEX does not read in the background).

### Failed turns

agy reports quota, rate-limit and API errors as a chat message plus `end_turn`
(an exhausted quota can also be `stopReason: "refusal"`). Every session is a
SQLite file, `~/.gemini/antigravity-cli/conversations/<sessionId>.db`; a failed
turn ends with an error step (`step_type` 17). DAEX notes the last step before
each prompt and reads only the newest new step after it (`dialect.turnOutcome`).
Quota / 429 → usage-limit card, and the named reset time arms auto-resume. Other
API errors fail the turn with the agent's message. An unreadable log leaves the
turn as answered.

### Tool calls

- Permission options are only `allow_once` and `reject_once`.
- Edit paths like `/C:/Users/…` lose the leading slash. A snippet edit is placed
  on its real lines when the snippet occurs once (files ≤ 512 KB).
- `write_file`: new-file text comes from the `Content` argument (the diff has an
  extra newline).
- `run_command`: agy's header is stripped; `rawOutput.exit_code` goes on the row.
- `ask_question` ends the turn; DAEX raises a question card from the tool call
  (`dialect.asyncQuestions`) and sends the answer as the next message.

### Modes

| DAEX permission | `agy acp` mode |
|---|---|
| Plan | `plan` |
| Ask | `default` |
| Accept edits | `accept-edits` |
| Auto | `auto` (not for Gemini Enterprise accounts, which stay `default`) |
| Full access | `default`, with DAEX answering every request (`hostAnswersFullAccess`) |

### Subagents

`invoke_subagent` returns at once; the child runs on in agy's process with its
own log, and its result and agy's reply never come over ACP. DAEX reads them
from the logs (`dialect.backgroundWork`, `antigravityChildWork.ts`):

- At turn end, each launch in the new steps becomes a subagent card (child id in
  the launch's result).
- While a child is open, a 2 s poll reads the child's and parent's logs,
  skipping unchanged files. agy's follow-up shows as its own turn, or inside the
  running turn if the user already sent another message.
- A tool needing approval is held: agy sends nothing until the next
  `session/prompt`. DAEX shows "Antigravity is waiting to run …"; the approval
  card arrives with the user's next message.
- Open children, running background tools and held tools keep the chat from
  idling out (held tool: max 30 min). A child silent for 30 min, or every open
  child when agy exits, is reported stopped.
- `steps.status`: 3 done, 6 cancelled, 7 failed/denied, 9 awaiting approval,
  else running.

### Session log

`antigravitySessionLog.ts` reads the `.db` read-only (`busy_timeout` 50 ms,
payloads ≤ 256 KB) and never throws. The protobuf fields it reads are listed in
its header; `trajectory_metadata_blob` holds the workspace, creation time and an
ACP client's system prompt.

### Import

The importer lists conversations as "Antigravity" by recorded workspace (none →
only in an unscoped import). It skips subagents and conversations a DAEX chat
opened (DAEX system prompt, or a live chat's `acpSessionId`). CLI continue runs
`agy --conversation <id>`; agy has no fork, so no CLI copy. Chat copy replays
into a new DAEX chat; chat continue is off, as for other ACP providers.

## Terminals

The `antigravity` profile runs the TUI from the same pin. Permission →
`--mode plan|accept-edits|auto` or `--dangerously-skip-permissions`; model and
effort → `--model`, `--effort`; prompt → `-i`. Resume is `--conversation <id>`
when known (read from the TUI's exit line by `terminalSessionSignals.ts`), else
`--continue`. There is no default resume line (`agy -c` may pick a chat's
conversation). The TUI rejects `--disable-telemetry`. In a plain shell only
`agy` is swapped for the pinned binary (`antigravity` is also the editor's
launcher).

## Sign-in

Settings › Providers › Antigravity (also the chat sign-in card and first-run
rail), on the machine the page shows. Actions `ai.antigravitySignInStatus`,
`…Start`, `…Complete`, `…Cancel` are remote-reachable; preload takes `pin` via
`callPinnedOrBoundRuntimeActionOr`; the panel passes
`useSettingsMachineScope().pin`. Every method ends with a `session/new` that
proves the login; a flow times out after 5 min.

| Method | What DAEX does |
|---|---|
| Google account (`oauth-personal`, default) | Runs `agy acp --login`. The link's redirect is `https://antigravity.google/oauth-callback`, which shows a code; the user pastes the code (or that page's address). Nothing listens locally, so it works from any machine, phone, web or DAEX Cloud. DAEX validates the link and pasted value before writing to stdin. |
| Gemini Enterprise (`oauth-business`) | ACP `authenticate`. agy opens the OS browser itself and waits on a `localhost` listener, so it completes only in a browser on the agent's machine. Licence errors become guidance (`enterpriseFailureSentence`); DAEX does not write agy's `gcp` settings block. Not yet run against a real Enterprise account. |
| Gemini API key (`gemini-api-key`) | `GEMINI_API_KEY` from DAEX's key store (slot `antigravity-gemini`), passed only for this method. agy's `modelProvider: "gemini"` setting outranks `auth.type`, so DAEX reads it as this method. |
| Agent Platform (`agent-platform`) | `GOOGLE_API_KEY` (slot `antigravity-agent-platform`), or ADC variables plus a project and location kept in `<ADE home>/providers/antigravity.json`. |

The link, `state`, code and tokens are never logged.

### Where the login lives

- State is in `~/.gemini/antigravity-cli/`. The sign-in is one JSON value in the
  OS keyring (go-keyring service `gemini`, user `antigravity`; macOS stores
  `go-keyring-base64:<base64>`). Without a working keyring (containers, WSL,
  DAEX Cloud computers) it is the file
  `~/.gemini/antigravity-cli/antigravity-oauth-token`, which agy rewrites on
  refresh.
- agy records the method in `settings.json` `auth.type` and in
  `cache/acp-auth-state.json`; the setting wins, and a stale key method makes a
  Google login fail. So a Google sign-in sets `auth.type` to `oauth-personal`
  (`pointAntigravitySettingsAtGoogle`), the only write DAEX makes to agy's
  settings. Both read `settings.json` as strict JSON.

### Status without a spawn

`inspectAntigravityCredentials` reads `settings.json` (mtime-cached), then:
Google/Enterprise → the token file, else keyring presence by attributes only
(`security find-generic-password` without `-w`, `cmdkey /list:gemini:antigravity`,
Secret Service via `gdbus`), async, cached 30 s (10 min after a timeout). Key
methods → a key in DAEX's store or env; Agent Platform → a key or a
project/location. The ACP auth probe runs only when the pin is on disk.

## Surfaces

Settings descriptor and logo, model picker, `daex chat models --provider
antigravity`, terminals and CLI sessions (`start_cli_session` provider
`antigravity`), web client, iOS (`WorkModelCatalog.swift`, provider
label/color, CLI launches).
