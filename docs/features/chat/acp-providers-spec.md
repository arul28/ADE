# ACP providers (Qwen, Kimi, Grok, Devin)

Qwen, Kimi, Grok and Devin chats run over one shared ACP host. Antigravity uses
the same host and has its own doc ([antigravity-provider.md](antigravity-provider.md)).
Copilot is an SDK provider ([copilot-sdk-provider.md](copilot-sdk-provider.md)),
not ACP. This page holds the verified per-provider facts; re-verify against the
pinned CLI when a pin moves.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/chat/acpHost/acpConnection.ts` | Spawn, process-tree kill, NDJSON JSON-RPC over stdio (stdout decoded across chunks; last unterminated line handled on exit). |
| `…/acpHost/acpSession.ts`, `acpSessionPool.ts` | Session lifecycle; pooling keyed `{provider, cwd, env}` with idle TTL and a generation counter. |
| `…/acpHost/acpEventTranslator.ts` | `session/update` → `AgentChatEvent`. |
| `…/acpHost/acpPermissionBridge.ts` | `session/request_permission` → DAEX approval cards. |
| `…/acpHost/acpRuntimeCoordinator.ts` | Mode/model/effort after every session entry. |
| `…/acpHost/acpTurnTelemetry.ts`, `acpTelemetryReaders.ts` | Turn usage, context samples, compaction, served model. |
| `…/acpHost/acpModelDiscovery.ts` | Background model-list warm and cache. |
| `…/acpHost/acpSupervisionGuard.ts` | Runtime invariant: writes with no permission request in an ask-style mode. |
| `…/acpHost/acpMcpServers.ts`, `acpPromptBlocks.ts`, `acpOneShotPrompt.ts`, `acpScratchDirs.ts` | MCP config, prompt blocks, one-shot tasks, temp dirs. |
| `…/acpHost/acpProtocolTypes.ts` | ACP v1 types mirrored from `@agentclientprotocol/sdk` (not a dependency). Do not target the v2 draft. |
| `…/acpHost/acpDialects/` | One dialect per provider: `qwen.ts` (+ `qwenSkillDefaults.ts`, `qwenUsageLedger.ts`), `kimi.ts`, `grok.ts` (+ `grokTelemetry.ts`), `devin.ts`, `devinCloud.ts`, Antigravity files, `acpAccounts.ts`, `shared.ts`. |
| `…/acpHost/mockAcpAgent.ts`, `fixtures/` | Mock agent and captured handshakes for tests. |
| `apps/desktop/src/main/services/ai/acpExecutables.ts` | Pinned-binary resolution. |
| `apps/desktop/src/main/services/ai/acpAuthProbe.ts` | Auth probe (`initialize` + `session/new`). |
| `apps/desktop/src/main/services/ai/grokPermissionPreflight.ts` | Grok supervision self-attestation. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Host wiring (`commitChatEvent`, launch, resume, Stop). |

## Gotchas

- **Capabilities come from `initialize`, not versions.** Unknown update kinds,
  blocks, tool kinds, stop reasons and methods are ignored or answered
  unsupported. An unsupported protocol version fails at the handshake with
  "update DAEX".
- **Live events are not slimmed.** Live IPC publishes the uncompacted
  `liveEnvelope`.
- **Stable row ids:** `messageId` for text/thought, `toolCallId` for tools;
  synthesize when missing.
- **Suppress `session/load` replay** when DAEX has the transcript; prefer
  `session/resume` when advertised.
- **Cancel is decided once, client-side,** when the `session/prompt` result
  arrives (DAEX's cancel, a `cancelled` stopReason, or `isInterrupted()`). A Stop
  during turn-end telemetry finds `AcpSession.turnAnswered` true and sends no
  `session/cancel`.
- **`session/cancel` is a notification** on every one of these CLIs; the request
  form answers `-32601`.
- **Never inject the Codex-signed computer-use MCP** into ACP providers; MCP at
  `session/new` is capability-gated per dialect.
- **Grok's supervision hatch is undocumented** (below). The runtime invariant is
  the net, not the preflight.
- **Devin's `session/new` succeeds without a login,** so the `session/new` auth
  proof does not hold for Devin; only a prompt reveals the auth error.
- Preview labels appear only in Settings; pickers show every provider the same.

## Last verified versions

Pins: `apps/ade-cli/scripts/pins/<tool>.json`.

| Provider | Pin | Verified scope |
|---|---|---|
| grok | 1.0.46 | Handshake, live turn, cancel, permissions (write and execute), close, resume |
| qwen | 0.25.0 | Handshake, config options, cancel, close; no live turn |
| kimi | 2.3.1 | Handshake and unauthenticated methods only |
| devin | 3000.15.14 | Handshake, `session/new`, set mode, unauthenticated prompt (auth error); no login |

## Architecture

The host owns spawn and kill, JSON-RPC, `initialize`, session lifecycle
(`session/new|load|resume|prompt|cancel|close`), permission round-trips, the
event mapper and telemetry. Dialects own argv, env, auth probe, capability
quirks, cancel/close/usage behavior and the slash-command allowlist.

## Qwen (`qwen --acp`)

- Spawn: the pinned bundle's own Node runs its script
  (`<root>/node/bin/node <root>/lib/cli-entry.js --acp`; the script rides
  `binaryArgs`). Never a `.cmd` shim or Electron-as-Node.
- Caps: loadSession, list/resume, image **and audio**, MCP http/sse, slash via
  `available_commands_update`. **No `session/close`** (`-32601`): DAEX ends the
  process (one process per session).
- Auth: `openai` method (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, or a custom
  provider in `~/.qwen/settings.json`). DAEX never writes that file. The probe
  uses `session/new` as proof (`authenticate` with no key errors even when the
  key is in settings). Unauthenticated `session/new` → `-32000`.
- Config home `QWEN_HOME`; runtime state `QWEN_RUNTIME_DIR`.
- Config options: `mode`, `model`, `reasoning_effort`. Approval modes
  plan|default|auto-edit|auto|yolo. 0.25.0 efforts: none|low|medium|high|xhigh
  (default marked in `_meta.qwenCode/reasoning.defaultEffort`); `default` is
  still accepted to clear. ACP model ids carry an auth-type suffix
  (`gpt-5.5(openai)`) that DAEX strips to match.
- Usage: `usage_update { used, size }` is the context meter. Token totals come
  from Qwen's ledger `<runtime dir>/usage/token-usage-YYYY-MM.jsonl`: DAEX reads
  rows appended during the turn (size mark at start, bounded tail, both month
  files across a boundary) → `usageConfidence: "derived"`, `requestCount`,
  `servedModel`, and `subagentUsage` per non-`main` source. Ledger
  `inputTokens` includes cached tokens. `qwen/notify/session/model-update`
  (both spellings registered) names the model after a switch.
- Account: `qwen-oauth` = subscription; a loopback `baseUrl` = `local` (origin
  only); else API key.
- Tracked CLI: `qwen -i "<prompt>" -m <model> --approval-mode=<m> --session-id
  <uuid>`; resume `--resume <id>` / `--continue`. Never `--yolo` with
  `--approval-mode` (use `--approval-mode=yolo`); never `--session-id` with
  resume flags. `--append-system-prompt` carries DAEX guidance. On Windows the
  prompt rides the PTY, not argv.

## Kimi (`kimi acp`, MoonshotAI/kimi-code)

- Spawn: `--model <alias>` and `--plan` / `--auto` / `--yolo` go before `acp`.
  DAEX's `auto-edit` is refused (no Kimi equivalent).
- Caps: loadSession, list, resume, `session/close`, delete, fork,
  additionalDirectories; images, no audio; MCP http/sse. Stdio MCP entries get
  `runtime_id: "local"` (`acpMcpServersToConfigRecord`).
- Fork: `session/fork` copies the whole session, refuses mid-turn, takes no cut
  point. Side chats use it between turns. Sessions are locked to their process
  (since 2.3.0), so DAEX closes the fork in the main process before the side
  chat resumes it.
- Config options: `mode`, `model` (catalog aliases like `kimi-code/k3`, equal to
  DAEX's `providerModelId`), `thinking` (`off` plus the model's levels; sent only
  when offered).
- Usage: `usage_update` arrives **after** the prompt result, so the host waits
  up to 250 ms (`ACP_SETTLED_USAGE_WAIT_MS`). The prompt result may carry the
  ACP `usage` block. Not live-verified (no login on the test machine).
- Auth: `kimi login --region <mainland-cn|global>` in-app
  (`agentCliLoginRunner.ts`); method `login`, type `terminal`. DAEX never writes
  `~/.kimi-code/config.toml`. Config home `KIMI_CODE_HOME`. A
  `credentials/kimi-code.json` login = subscription; `MOONSHOT_API_KEY` alone =
  API key.
- Tracked CLI: no argv prompt for the TUI → `initialInput` with a 750 ms delay.
  `-p` cannot combine with `--yolo`/`--auto`/`--plan`; `--yolo` XOR `--auto`.
  Resume `-S [<id>]` / `-c`. Session id is not assignable at launch (ULID,
  captured afterwards).
- Title tasks use `--prompt` with a temporary `--agent-file` whose `tools` list
  is empty.
- Windows needs Git for Windows (Git Bash is its shell): preflight and a clear
  error.

## Grok (`grok agent stdio`; there is no `grok acp`)

- Spawn: `grok --no-auto-update --no-plan --permission-mode <mode> agent
  --no-leader stdio` with `_GROK_CLAUDE_MARKER_OVERRIDE=1` in the env, plus
  `-m <model>` (process default only) and `--reasoning-effort` (`spawnFlag`, for
  builds whose session lacks the option). Auto-update swaps binaries, native plan
  mode hangs hosts, leader mode mixes sessions. DAEX plan maps to
  `--permission-mode default`.
- Caps: loadSession, list/resume/close; no image or audio; MCP http/sse. Never
  advertise client `fs` (Grok corrupts binary reads through it). Slash commands
  are re-emitted repeatedly → dedupe.
- Config options: `model`, `reasoning_effort`; no `mode`, so full-auto
  auto-approves permission cards on the DAEX side. Resume brings back the last
  model and effort and ignores `-m`; the coordinator sets both after every
  entry. Grok serves models under build names (`grok-4.7` as `grok-4.7-build`).
- Usage rides xAI extension notifications (`x.ai/` and `_x.ai/` both
  registered): `response_completed` per request (`input_tokens` excludes cache
  reads), `turn_completed` totals (camelCase, `inputTokens` includes cache
  reads, `costUsdTicks` in nano-dollars, `modelUsage` keyed by served model),
  `x.ai/models/update` (current model and `totalContextTokens` per model),
  `subagent_spawned`/`_finished` → subagent events, `auto_compact_*` →
  provider `context_compact`. `pending_interaction{kind:"permission"}` is a
  spinner hint, never answered.
- Stamp `_meta.clientIdentifier: "ade"` at `initialize`.
- Config home `GROK_HOME` (default `~/.grok`); DAEX never writes it. Auth:
  `grok login` (device flow, in-app) outranks `XAI_API_KEY`.
- Tracked CLI: positional prompt, `-s <uuid>`, `-r <id>` / `-c`,
  `--permission-mode`, `--reasoning-effort`, `--rules`, `--no-alt-screen`. Never
  `-w/--worktree` (collides with lanes).
- Self-update off: `--no-auto-update` plus `GROK_DISABLE_AUTOUPDATER=1`.

### Grok supervision

Grok merges permission rules from several sources, including the user's
`~/.claude/settings.json`, and evaluates mode flags after them. A Claude
`permissions.defaultMode: "auto"` silently seeds Grok's auto-classifier. Two
halves are both required:

1. `--permission-mode default` overrides `~/.grok/config.toml [ui]
   permission_mode`.
2. `_GROK_CLAUDE_MARKER_OVERRIDE=1` (an undocumented vendor hatch) disables the
   Claude import.

Checks:

- **Preflight** (`grokPermissionPreflight.ts`): one handshake-only spawn
  (`initialize` + `session/new`, no prompt) with the session's argv and env plus
  `--debug --debug-file`, then looks for "Claude compat disabled" and the absence
  of "auto permission mode seeded". A missing line, empty log, crash or timeout
  reads as failed. The log goes to OS temp and is deleted. Do not gate on
  `grok inspect`: it cannot see `defaultMode`. Each probe leaves a small session
  dir under `$GROK_HOME/sessions/` (empty `events.jsonl`); any future Grok
  session import must skip those.
- **Runtime invariant** (`acpSupervisionGuard.ts`, the real net): writes or
  executes with zero permission requests in an ask-style mode mark the session
  unsupervised and post one dismissible notice. It reports the observation, not
  a cause: per-project remembered approvals ("always allow", maybe from Grok's
  own TUI) are also silent.
- Permission option ids vary by tool (write: `allow-edits-session`,
  `allow-once`, `reject-once`; execute: `always-allow`, `allow-once`,
  `reject-once`, `reject-always`). The bridge derives a kind from the id, so an
  unknown id lands on a safe kind.
- Fallback if the hatch disappears: a DAEX-owned `GROK_HOME` with
  `[claude_compat] imported = true` (copy `auth.json`, never symlink). Not the
  default: it drops Claude-derived skills, agents and MCP.

## Devin (`devin acp`, preview)

- Spawn: `devin acp [--model <name>]` (`--model` is the server-wide default;
  the session `model` option overrides). `devin acp --cloud` is the separate
  `devinCloud.ts` dialect (options `repos`, `devin_version`, `platform`;
  load-only rejoin; unverified here).
- Caps: loadSession, images, MCP http/sse, session list/delete/
  additionalDirectories. **No close, resume or fork.** Rejoin is `session/load`;
  without close the host releases the pooled process instead of evicting.
- Config options: `mode` (`accept-edits`, `smart`, `ask`, `plan`, `bypass`) and
  `model` (empty choices before login).
- Auth: `devin auth login --force-manual-token-flow` in-app (link, then pasted
  code). Unauthenticated prompts answer "Please log in to use Devin…", which
  `isAcpAuthError` reads as auth. Config in `~/.config/devin`
  (`%APPDATA%\devin`); no override env.
- No self-update switch found.

## Shared telemetry

`acpTurnTelemetry.ts` owns it; dialects translate their payloads
(`extensionNotifications`), read ledgers (`localUsage`) and the account
(`readAccount`).

- `done` fields: `usage` is the turn total (`inputTokens` uncached, cache in its
  own fields), `usage.contextTokens` the latest sample, `contextWindow`,
  `requestCount`. Trust order: provider turn report (Grok `turn_completed`),
  local ledger (`derived`), prompt result, sum of per-request reports
  (`derived`). A dialect with a ledger that returned nothing reports the prompt
  result as `estimated`. `costUsd` only from the provider.
- **Served model.** The requested model is kept; `isServedModelMismatch`
  (`chat/servedModelMismatch.ts`) treats spellings, build/effort variants and
  router picks as the same model. A real mismatch sets `done.servedModel`, logs
  `agent_chat.served_model_mismatch` once per turn, and posts one warning notice
  per served model per session.
- `account` is `{ provider, kind, upstream?, endpoint? }` from non-secret local
  config. `subagentUsage` (ledger helpers) is usage only, never a transcript
  card; Grok's `subagent_finished` is real work and stays `subagent_result`.
- Compaction: `compaction_update` → `context_compact { detection: "provider" }`
  (DAEX does not advertise `clientCapabilities.session.compaction`). Grok's own
  `auto_compact_*` is provider-detected. Otherwise a `usage_update.used` drop of
  > 40% **and** > 20k tokens (same window, no model switch, no provider
  compaction) publishes one inferred `context_compact`
  (`ACP_INFERRED_COMPACTION_MIN_DROP_RATIO`, `ACP_INFERRED_COMPACTION_MIN_DROP_TOKENS`).
- The prompt-result `tokens` fallback is published only for a turn with no
  context sample. Ledger reads and the post-turn wait are bounded at 250 ms and
  never fail a turn; a throw while building telemetry ends with a plain `done`
  and one warning per session.

## Model and effort selection

`acpRuntimeCoordinator.ts` owns this; the chat service passes the model token and
effort.

- **Picker list.** `acpModelDiscovery.ts` warms each downloaded, signed-in
  provider in the background (`initialize`, `session/new`, `session/close`, no
  prompt; `devin models list` for Devin), one at a time, cached in
  `userData/acp-model-catalog-cache.json` for 6 h; failures retry after 5 min.
  It probes only pins already on disk. With a live list, `modelRegistry.ts`
  serves exactly it (curated rows keep their metadata; unnamed curated rows are
  hidden).
- **After every entry** (`new`, `resume`, `load`): mode (only if the dialect's
  `configOptionIds` lists it), then model, then effort. A model change tears the
  runtime down; the next send rejoins.
- **Model** is always the `model` config option (no dialect uses
  `session/set_model`). `resolveAcpConfigValue`: exact choice wins, else the
  dialect's `modelIdFromAgent` mapping (current value wins ties, so Qwen never
  changes auth type). Already-current values are not resent. A model not offered
  is not sent (`agent_chat.acp_model_not_offered`); the turn runs on the
  session's model and the served-model notice explains. No advertised choices →
  sent as is. Failures log `agent_chat.acp_set_model_failed` and never fail the
  turn. An accepted model is recorded with `AcpSession.noteCurrentModel`.
- **Effort** (`reasoningEffortOption`): Qwen and Grok use `reasoning_effort`,
  Kimi `thinking`. `null` / `default` = no effort: Qwen sends `resetValue`
  `default`; Grok and Kimi restore the session's initial value if still offered.
  Grok maps `max`/`ultracode` to `xhigh`. Values not offered are logged
  (`agent_chat.acp_reasoning_effort_not_offered`) and skipped. Invalid-params /
  method-not-found is a non-fatal rejection. Other failures (incl. the 60 s
  request deadline) are fatal only for Qwen (`failClosed`). Live changes
  (`setAcpReasoningEffort`) answer `applied`, `unchanged`, `rejected` or
  `transient_failure`.
- **Snapshot.** `set_config_option` replies carry the whole option set; the
  coordinator publishes the latest one.

## Pinned CLIs and self-update

DAEX runs its own pinned, checksum-verified copy from the machine tools cache
([agent-tools-cache.md](../onboarding-and-settings/agent-tools-cache.md)); never
the user's install.

- **Resolution** (`acpExecutables.ts`): dev env override
  (`ACP_EXECUTABLE_ENV_KEYS`, e.g. `GROK_EXECUTABLE`) → current pin → previous
  pin → missing (`source: "fallback-command"`, empty path; nothing spawns a bare
  command). `AcpExecutableResolution` carries `args` and `files`; callers pass
  `binaryArgs` to the dialect (Qwen uses them).
- **Download before use.** Chat start, auth probe and diagnostics await the
  download and report its state ("DAEX is downloading <Tool>…", "Couldn't
  download…", "not available on this machine"). Settings and the chat card use
  `ai.pinnedToolStatus` / `ai.pinnedToolDownload` against the row's or chat's
  machine. Sign-in is read from disk even before the download.
- **Self-update off** (`pinnedToolSelfUpdateEnv`, `shared/pinnedToolSpawnEnv.ts`):
  qwen `QWEN_CODE_SKIP_UPDATE_CHECK_ONCE=true` plus a system-defaults file
  (`QWEN_CODE_SYSTEM_DEFAULTS_PATH`, `qwenSkillDefaults.ts`) with
  `general.enableAutoUpdate: false`; kimi `KIMI_CODE_NO_AUTO_UPDATE=1`; grok
  `GROK_DISABLE_AUTOUPDATER=1` + `--no-auto-update`; devin none.
- **Logins** stay in the default homes, shared with the user's CLI. Login
  terminals run the pinned binary (`acpProviderMetadata.ts`).
- **Bumping:** `npm run tools:pin -- <tool>`, then a live check (handshake,
  turn, cancel, close, resume, permissions) and update
  [Last verified versions](#last-verified-versions).
