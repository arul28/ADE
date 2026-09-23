# ACP Provider Expansion — Build Spec (locked 2026-08-30)

Locked by /plan deliberation in ADE session `1504018b-e2c5-4fd4-a954-f86c9f9c67e7`.
Four new Work providers over one shared ACP host: **qwen**, **kimi**, **grok**, **copilot**.
Full Settings → Models redesign for all providers. Research record lives in that chat.

## 1. Architecture

One shared ACP host module + four thin dialects. The host owns: process spawn +
process-tree kill, NDJSON JSON-RPC over stdio, `initialize`, session lifecycle
(`session/new|load|resume|prompt|cancel|close`), permission round-trips
(`session/request_permission` → ADE `approval_request`/`PendingInputRequest`),
and the event mapper `session/update` → `AgentChatEvent`. Dialects own: spawn
argv, env, auth probe, capability quirks, cancel/close/usage behavior, and the
slash-command allowlist.

- New host code lives in `apps/desktop/src/main/services/chat/acpHost/`.
- Dependency: `@agentclientprotocol/sdk` (protocol v1; do NOT target v2 draft).
- Do NOT restore `droidAcpPool.ts` / `acpEventMapper.ts` patterns from git
  history; this is a fresh design informed by their failure modes.
- Live IPC publishes uncompacted `liveEnvelope` — the mapper must not slim live
  events (see `commitChatEvent` in `agentChatService.ts`).
- Stable row identity: `messageId` (text/thought) and `toolCallId` (tool rows).
  Synthesize stable ids when a chunk has none.
- `session/load` replay must be suppressed when ADE already has a transcript;
  prefer `session/resume` when advertised.
- Cancel is tracked client-side: ADE records that it cancelled and treats the
  turn as `interrupted` regardless of the provider's stopReason. The verdict
  is taken once, when the `session/prompt` result arrives: ADE's own cancel,
  a `cancelled` stopReason, or the caller's `isInterrupted()` flag, a pure
  read taken at that moment. A Stop pressed during the turn-end telemetry
  reads finds a finished turn: it neither changes the verdict nor sends
  `session/cancel` to the idle agent. `AcpSession.turnAnswered` is true in
  exactly that window (from the prompt result until `prompt()` exits), and
  the host's Stop reads it instead of keeping its own answered-turn record.
- MCP injection at `session/new` is capability-gated per dialect; never inject
  the Codex-signed computer-use MCP into ACP providers.
- Connection/process pooling keyed `{provider, cwd, env}` with idle TTL and a
  generation counter (pattern: Emdash `connection/source.ts`).
- Telemetry is host-owned (§3.5): one `AcpTurnTelemetry` per ACP session
  folds context samples, dialect extension notifications, and the provider's
  own local usage ledger into the turn's `done` fields (`outcome.done`).

## 2. Tier policy

| Provider | Tier | Notes |
|---|---|---|
| qwen | first-class | cleanest surface |
| kimi | first-class | two holes, absorbed (below) |
| grok | first-class | **Graduated 2026-09-18.** A real `session/request_permission` was observed in a host-driven ACP session on 1.0.13 once both halves of §3's neutralization were applied. The undocumented vendor hatch remains a compatibility risk, so the preflight and runtime supervision invariant stay load-bearing. |
| copilot | preview (Settings-only label) | graduates when GitHub fixes cancel + drops preview |

Preview labels appear ONLY in Settings (tile + detail page). Pickers render all
providers identically.

## 3. Per-provider dialects (verified facts — do not re-derive)

### Qwen (`qwen --acp`, npm `@qwen-code/qwen-code` **0.24.0**)
- Caps: loadSession, session list/resume, image **and audio** prompts, MCP
  http/sse. Slash via `available_commands_update`. **`session/close` is not
  advertised and answers -32601.** ADE ends the process (one process per
  session). Default `qwen --help` hides `--acp`, `--approval-mode`,
  `--session-id`, `--yolo`, and `--append-system-prompt`; they exist (error-path
  help lists them).
- Auth: `qwen auth` is **removed**. Advertised ACP methods are `openai` and
  `openai-responses` (both use `OPENAI_API_KEY`; `OPENAI_BASE_URL` and a custom
  provider in `~/.qwen/settings.json` remain supported). ADE does **not** write
  that file — it reuses the Qwen CLI the user already configured, including a
  local OpenAI-compatible proxy. Unauthenticated `session/new` is
  `-32000 Authentication required: Use Qwen Code CLI to authenticate first.`
  `authenticate` with `openai` and no key is `-32603 Internal error` whose
  `data.details` say "Missing API key" even when the key already lives in
  settings.json, so ADE's auth probe uses `session/new` as the proof. Free OAuth
  tier is dead (2026-04). Live model ids come from `settings.json`
  `modelProviders` plus anything a session later reports.
- Config home: `QWEN_HOME` names the config dir (CODEX_HOME shape). Runtime
  state axis: `QWEN_RUNTIME_DIR`. Live probe: `QWEN_HOME` relocates
  `installation_id`, extensions, `output-language.md`.
- Usage: `usage_update { used, size }` after each main request is the context
  meter. Token totals are not on the wire; Qwen appends one row per model
  request to `<runtime dir>/usage/token-usage-YYYY-MM.jsonl` (local month;
  runtime dir = `QWEN_RUNTIME_DIR`, else the Qwen home) with `sessionId` = the
  ACP session id, `source` = `main` or a helper/subagent name, and an
  `inputTokens` that counts `cachedTokens`. ADE reads the rows appended during
  the turn (file-size mark at turn start, bounded tail read, both month files
  across a month boundary) → `done` totals marked `usageConfidence: "derived"`,
  `requestCount`, `servedModel` (row `model`), and one derived
  `done.subagentUsage` entry per non-`main` source (usage, not a transcript
  card). `qwen/notify/session/model-update
  { currentModelId }` (sent without an underscore by 0.24's ACP SDK; both
  spellings are registered) names the model after a switch; ACP model ids
  carry an auth-type suffix (`gpt-5.5(openai)`) that ADE strips. Account: the
  row's `authType` is the upstream; `qwen-oauth` is a subscription. Any other
  type whose `settings.json` `model.baseUrl` (or `OPENAI_BASE_URL`) is
  loopback is a `local` account, with only the URL's origin
  (`scheme://host:port`, never userinfo, path, or query) as the endpoint;
  every other type is an API key with no endpoint.
- Session config via `session/set_config_option` (mode/model/reasoning_effort).
  Qwen 0.24.0 also advertises `openai-responses` alongside `openai`; both
  use `OPENAI_API_KEY`, and ADE keeps `openai` as its non-interactive probe.
  Approval modes: plan|default|auto-edit|auto|yolo.
- Model selection (verified 2026-09-23 with no-prompt sessions on 0.22.3).
  `session/new` advertises the `model` option. Its values are the suffixed
  ids of the models in `settings.json` (`gpt-5.5(openai)`). Qwen accepts the
  suffixed id and the bare id (`gpt-5.5`). A model that is not configured for
  the auth type fails with `-32603` `Model '<id>' not found for authType
  'openai'`, and the session stays on its model. An unknown
  `reasoning_effort` value fails with `-32602`. ADE matches its id against
  the advertised ids through the suffix strip and sends the advertised id.
  ADE sends nothing for a model that Qwen does not offer (see 3.6).
- Tracked CLI: `qwen -i "<prompt>" -m <model> --approval-mode=<m> --session-id
  <uuid>`; resume `--resume <id>` / `--continue`; NEVER pass `--yolo` together
  with `--approval-mode` (parse error: use `--approval-mode=yolo`). NEVER pass
  `--session-id` with `--resume`/`--continue`. `--append-system-prompt` carries
  ADE guidance.
- Windows: npm `.cmd` shim → prompt rides PTY (`promptRidesInArgv = platform
  !== "win32"`), same rule as Claude.

### Kimi (`kimi acp`, compatibility target **2.0.0**, captured baseline **0.39.1**,
repo MoonshotAI/kimi-code — NOT the deprecated Python kimi-cli)
- Caps: loadSession, list, resume, **`session/close` (implemented; dummy id
  returns `{}`)**, plus delete/fork/additionalDirectories. Image prompts yes,
  audio no. MCP http/sse. `agentCapabilities.auth.logout` is advertised; ADE
  has no ACP logout yet.
- Usage (code-verified in the 0.39.1 binary; **not live-verified**, Kimi login
  is not active on the capture Mac): after every settled turn Kimi's
  `emitUsageUpdate()` pushes one `usage_update { used, size }` (context token
  count against the bound model's catalog window), skipped while the bound
  model is not in Kimi's catalog. It arrives AFTER the `session/prompt`
  result, so the host waits up to 250 ms for it (and stops waiting in a
  session where it never came). The prompt result may carry the ACP `usage`
  block (`inputTokens`, `outputTokens`, `cachedReadTokens`,
  `cachedWriteTokens`, `thoughtTokens`, `totalTokens`). ADE reads both when
  present; absent stays absent, with no degradation note. The `model` config
  option's `currentValue` names the served model. Account: a
  `$KIMI_CODE_HOME/credentials/kimi-code.json` login is a subscription,
  `MOONSHOT_API_KEY` alone an API key.
- ACP v1 config: Kimi Code 2.0.0 documents `session/set_config_option` for the
  `mode`, `model`, and `thinking` options. ADE forwards those options to the
  native ACP session and surfaces the agent's returned values in the generic
  ACP composer controls. The captured 0.39.1 fixture remains the compatibility
  baseline; a live authenticated 2.0.0 turn is still required to validate
  usage and cancellation behavior end to end.
- Model and thinking (code review of the 0.39.1 binary, 2026-09-23; this
  machine has no Kimi account). `set_config_option` `model` and
  `session/set_model` run the same `setModel`. The `model` values are the
  catalog aliases (`kimi-code/k3`), which match ADE's `providerModelId`. The
  `thinking` option lists `off` and the model's declared effort levels. Kimi
  shows it only for a model with thinking control. ADE sends the chat's
  effort as `thinking` only when the session offers that level. With no
  effort picked, ADE sends nothing.
- Vendor references: [Kimi ACP reference](https://moonshotai.github.io/kimi-code/en/reference/kimi-acp) and
  [Kimi Code 2.0.0 release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai%2Fkimi-code%402.0.0).
- Auth: `kimi login` / `kimi acp --login` device-code; region
  `mainland-cn` (kimi.com) or `global` (kimi.ai). ADE does **not** write
  `~/.kimi-code/config.toml`. `authenticate` method id
  `login`, type `terminal`. Unauthenticated `session/new` is `-32000
  Authentication required`.
- Config home: `KIMI_CODE_HOME` (dir itself, default `~/.kimi-code`),
  `config.toml`. Live probe: `kimi doctor` and ACP both honour it. Installer
  default bin is `$HOME/.kimi-code/bin` — ADE's known-dir lookup includes that
  path because `KIMI_NO_MODIFY_PATH` skips rc edits. Model flag takes an ALIAS,
  not a raw model id. ADE forwards the selected model alias and supported
  abstract permission mode before the `acp` subcommand (`--model <alias>`,
  `--plan`, `--auto`, or `--yolo`); ADE rejects `auto-edit` because Kimi has no
  equivalent mode. Kimi has no ACP session config setter.
- Tracked CLI: NO argv prompt for interactive TUI → use
  `{ initialInput: prompt, initialInputDelayMs: 750 }` (Cursor-branch shape).
  Non-interactive `-p/--prompt` exists and **cannot** combine with `--yolo`,
  `--auto`, or `--plan`. Resume `-S [<id>]` / `-c` (lowercase c). Permission:
  `--yolo` XOR
  `--auto` (parse error: "Cannot combine --yolo with --auto"); `--plan`. Vendor
  docs say permission flags ARE allowed on resume (Emdash's omit-on-resume is
  stale) — verify with one live probe after login.
- Metadata/title tasks use Kimi's native `--prompt` route with a temporary
  `--agent-file` whose `tools` list is empty; they never receive project tools.
  Kimi has no accept-edits equivalent, so ADE's generic accept-edits selection
  keeps Kimi at its normal approval posture. An explicit native `auto-edit`
  request remains rejected rather than being silently broadened to `--auto`.
- Session id: NOT assignable at launch. Capture via sessions-dir disk-adopt
  (pattern: `scheduleCodexSessionIdCaptureBestEffort` in `ptyService.ts`) or a
  `SessionStart` hook. IDs are ULID-shaped.
- Windows: native binary; REQUIRES Git for Windows (bundled Git Bash is its
  shell) → preflight check + clear error.

### Grok (`grok agent stdio` — there is NO `grok acp`; npm `@xai-official/grok`,
Rust, Apache-2.0)
- Spawn: `_GROK_CLAUDE_MARKER_OVERRIDE=1 grok --no-auto-update --no-plan
  --permission-mode <mode> agent --no-leader stdio` (flags between `agent` and
  `stdio` are agent-scoped). `--permission-mode` is global and comes before
  `agent`; it defaults to `default`. It is one HALF of the approval
  neutralization — see the permission rules below; the environment variable is
  the other half and neither works alone. Reasons for the other flags:
  auto-update swaps the binary under the host; native plan mode hangs external
  hosts; leader mode cross-contaminates sessions. ADE owns plan UX. The same
  pair rides the tracked-CLI launch and resume commands.
- Caps: loadSession, list/resume/close all advertised and verified across host
  restart. NO image/audio. MCP http/sse.
- Permissions ARE standard `session/request_permission`. Critical rules
  (rewritten 2026-08-31 after a live 6-arm experiment on 1.0.13):
  1. Grok merges permission RULES from several sources and evaluates MODE
     flags only AFTER those rules. No CLI flag, `startupHints` value, or ACP
     `_meta` field can force ask-always on its own. `x.ai/yolo_mode_changed`
     is method-not-found on 1.0.13. `_meta.autoMode:false` at `session/new`
     does nothing.
  2. ROOT CAUSE of the silent auto-approval is the user's
     `~/.claude/settings.json` `permissions.defaultMode: "auto"` — that value
     seeds Grok's auto-classifier (`permission/manager/mod.rs:1487`, logs
     "auto permission mode seeded from Claude defaultMode"). The 3 allow rules
     `grok inspect` also reports from `settings.local.json` are near-harmless
     by comparison. `GROK_HOME` does not scope the Claude read. Rules and mode
     are steps 2 and 5 of the same pipeline, which is why removing the source
     is the only lever.
  3. KILL SWITCH: `_GROK_CLAUDE_MARKER_OVERRIDE=1` in the child environment
     (Grok source: `permission/claude_settings.rs::is_claude_import_marked`,
     gating `resolve_permissions_with_provenance` +
     `load_claude_env_with_project`). With it set, `grok inspect` reports
     `Permissions └ Source: (none) └ 0 loaded`, and a cwd write raises a real
     `session/request_permission`; rejecting it prevents the write.
     **BOTH HALVES ARE MANDATORY**: `--permission-mode default` cancels the
     user's own `~/.grok/config.toml [ui] permission_mode`, and the env var
     cancels the Claude inheritance. Arm E proved dropping the mode flag
     re-breaks approvals even with the env var set.
     RISK: the underscore prefix marks a vendor-internal hatch. It is
     undocumented and Grok ships ~daily, so ADE verifies the effect with a
     cached, offline `grok inspect` preflight
     (`main/services/ai/grokPermissionPreflight.ts`) and backs it with a
     provider-agnostic runtime invariant
     (`acpHost/acpSupervisionGuard.ts`): writes with zero
     `session/request_permission` in an ask-style mode mark the session
     unsupervised and emit one dismissible `system_notice`.
     **THE RUNTIME INVARIANT IS THE LOAD-BEARING NET, NOT THE PREFLIGHT.** It
     observes what the agent actually did. Every static pre-check attempted
     here has been wrong three times running (single-source parse,
     print-order dependence, and `defaultMode` invisibility — GATE GOTCHA A),
     each time failing OPEN. Treat the preflight as an early warning and never
     describe it, in code or in UI, as proof of supervision.
     GATE GOTCHA A — **`grok inspect` CANNOT SEE `permissions.defaultMode`,
     so DO NOT build the gate on it.** Its `Permissions` rows come from
     per-rule provenance (`tag_with_source` over `config.rules`), so a
     `settings.json` holding only `{"permissions":{"defaultMode":"auto"}}`
     contributes zero rules and prints zero rows — byte-identical to a clean
     machine — while still setting `prompt_policy: Auto`. Measured live
     (fake HOMEs, /tmp): `defaultMode only → Source: (none), 0 loaded`;
     `defaultMode + 1 rule → settings.json, 1 loaded`; `rule only →
     settings.json, 1 loaded`. Same file, real ACP session,
     `--permission-mode default`: no marker → 0 permission requests, write
     COMPLETED; marker → 1 request, write prevented. An inspect-parsing gate
     fails OPEN on exactly the documented root cause. (It also lists one
     `Source:` row PER CONTRIBUTOR with a combined count, so a single-row
     parse is additionally print-order dependent — a second, smaller trap.)
     THE GATE ADE SHIPS instead is self-attestation: one throwaway
     handshake-only agent spawn (`initialize` + `session/new`, never a prompt,
     so zero spend and no user content in the log) using the session's exact
     argv and env plus `--debug --debug-file`, then two tracing lines.
     Verified on the defaultMode-only machine: no marker → `Claude compat
     disabled` ×0, `auto permission mode seeded` ×1; marker → ×1, ×0.
     `auto permission mode seeded from Claude defaultMode / prompt_policy`
     reports actual manager state, so it sees what inspect cannot. `Claude
     compat disabled (marker set in config.toml)` is positive proof the hatch
     fired on THIS build — measured ×1 on every marker run even with no Claude
     settings present — which makes this signal a LIVE REGRESSION DETECTOR: if
     xAI renames or drops `_GROK_CLAUDE_MARKER_OVERRIDE`, the attestation
     vanishes and ADE degrades loudly instead of silently losing supervision.
     Renamed string, empty log, crash, and timeout all read as FAILED. Note
     `inspect` does not honor `--debug-file` (no logger init), so this signal
     exists only on the `agent stdio` path — the path sessions actually use.
     Debug log is written to OS temp, size-capped, and deleted on every exit
     path; `--debug` is deliberately NOT put on the user's real session, whose
     logs would carry prompts and file contents.
     PROBE RESIDUE (low, accepted) — `session/new` materializes a real session
     directory that `session/close` does NOT remove, so each probe leaves
     ~13.7 KB in `$GROK_HOME/sessions/<urlencoded-cwd>/<uuid>/`. Accepted
     rather than fixed: containing it would mean pointing the probe at a
     private `GROK_HOME`, which would stop it exercising the user's real
     `~/.grok/config.toml` — including `[ui] permission_mode`, one of the two
     halves under test — and fidelity to the session's real environment is the
     probe's entire value. ADE also must not delete from `~/.grok`. Bounded by
     the cache to roughly once per lane per Grok version. It is invisible in
     Grok's own UI (`grok sessions list` reports "No sessions found").
     **If Grok session disk-adopt or session import is ever built, that code
     MUST skip probe sessions**, or phantom entries will surface in ADE that
     the user never created. They sit in the same `sessions/<encoded-cwd>/`
     directory as real ones and are NOT filtered by whatever makes `sessions
     list` skip them. Discriminator, measured: `events.jsonl` is exactly 0
     bytes and `chat_history.jsonl` contains only the system entry — no user
     turns.
     GATE GOTCHA B — silence has TWO causes. Step 3 of Grok's pipeline is
     per-project remembered approvals (`CachedStateStore` /
     `remember_tool_approvals`), evaluated BEFORE prompt policy, so a user who
     once chose "always allow" — possibly in Grok's own TUI, outside ADE —
     legitimately gets edits with zero RPCs. ADE cannot tell the two apart, so
     the notice reports the OBSERVATION ("changed files here without asking
     ADE to approve") and never attributes the decision; the detail body names
     both causes. A banner that misfires is a banner users learn to ignore.
     FALLBACK if the hatch disappears: point `GROK_HOME` at an ADE-owned dir
     whose `config.toml` sets `[claude_compat] imported = true`. Documented
     and verified working, but NOT the default: it strips Claude-derived
     skills 50→47, agents 11→3, and MCP 4→2, and it moves `auth.json` and
     the sessions dir. COPY `auth.json`, never symlink — Grok's token refresh
     is rename-based and a symlink silently forks the credential. The env var
     is surgical by comparison (skills/agents/MCP/`Claude.md` unaffected) and
     writes nothing to the user's machine.
  4. Stamp `_meta.clientIdentifier: "ade"` at `initialize`.
  5. `x.ai/session_notification` `pending_interaction{kind:"permission"}` is a
     spinner hint, NOT a permission request. Never answer it. The same method
     carries usage (below); its reader maps the hint to nothing.
  6. Read/Grep/WebSearch never prompt (SAFE_COMMAND) — absence of prompts for
     reads is normal.
  7. Real option ids offered are `allow-edits-session`, `allow-once`,
     `reject-once` — NOT `enable-always-approve`. The bridge derives a kind
     from the id, so an unrecognized id still lands on a safe kind.
- Cancel: send `session/cancel` as a JSON-RPC NOTIFICATION (request → -32601).
  Result arrives as `stopReason:"cancelled"`.
- Usage: no standard `usage_update`. Verified live on 1.0.40, it rides xAI
  extension notifications (1.0.40 prefixes them `_x.ai/`, 1.0.13 sent
  `x.ai/`; both spellings are registered):
  - `x.ai/session_notification` `response_completed` per model response, with
    snake_case `usage { input_tokens, output_tokens, cache_read_input_tokens,
    cache_creation_input_tokens, reasoning_tokens }`; `input_tokens` EXCLUDES
    the cache read (18962 + 3456 = 22418 in the capture). Each one is a live
    `context_usage` (its input side against the current model's
    `totalContextTokens`) and one request.
  - `turn_completed` with camelCase turn totals whose `inputTokens` INCLUDES
    the cache read, `modelCalls`, `costUsdTicks`, and `modelUsage` keyed by the
    SERVED model (a `grok-4.5` request served by `grok-4.5-build`). The
    `session/prompt` result `_meta` repeats these (on 1.0.13 under
    `_meta.usage`, with totals also at the top level); ADE reads both.
    `costUsdTicks` are nano-dollars (1_000_000_000 = $1.00): a captured
    30k-token ping at 86_649_000 ticks is $0.0866, not $86.65.
  - `x.ai/models/update { currentModelId, availableModels[{ modelId,
    _meta.totalContextTokens }] }` — the requested model and every window
    (500000 for grok-4.x in the capture).
  - `x.ai/session/update` `subagent_spawned` / `subagent_finished`
    (`tokens_used`, `tool_calls`, `duration_ms`, `output`) → `subagent_started`
    / `subagent_result`; `auto_compact_started` / `_completed`
    (`tokens_before`, `tokens_after`) / `_failed` / `_cancelled` → provider
    `context_compact` (strings in the 1.0.40 binary, not yet seen live).
  - Account: a `grok login` entry in `$GROK_HOME/auth.json` (`auth_mode`) is a
    subscription and outranks `XAI_API_KEY`, which alone is an API key.
- Model and effort ride `session/set_config_option` (verified live
  2026-09-23 on 1.0.40). The `session/new` and `session/resume` results
  advertise `model` (grok-4.7, grok-4.7-build-fast, grok-4.6, grok-4.5) and
  `reasoning_effort` (xhigh, high, medium, low). There is no `mode` option.
  `session/set_config_option { configId, value }` moves the session and
  answers with the whole option set. An unknown value fails with `-32602`.
  The spawn flags do not hold:
  - `-m grok-4.6` opened on grok-4.6, but `-m grok-4.7-build-fast` opened on
    grok-4.7 and served `grok-4.7-build`.
  - `--reasoning-effort low` opened the session at `medium`.
  - `session/resume` brings back the model and effort that the session last
    ran with. It ignores `-m`.
  ADE keeps `-m` as the process default. ADE also keeps
  `--reasoning-effort` on the spawn for builds before 1.0.40: their session
  advertises no `reasoning_effort` option, so the flag is the only way to set
  the effort. The dialect names the flag (`spawnFlag`). When the open session
  advertises the option, a change to this flag alone does not restart the
  runtime, because the config option already moved the effort. After every
  entry, the coordinator sets the model and the effort through the config
  option (see 3.6). Live proof through ADE's coordinator: a session
  opened on grok-4.6, then rejoined in a process spawned with `-m grok-4.7`.
  The resume reported grok-4.6/medium. ADE set grok-4.7/low, and the turn
  served `grok-4.7-build` at `reasoning_effort: low` (Grok's own
  `chat_history.jsonl`), for $0.157. Grok serves a model under its build name
  (`grok-4.7` as `grok-4.7-build`); `grok-4.7-build-fast` keeps its own id.
- NEVER advertise client `fs` capability (Grok proxies binary reads through
  text fs and corrupts assets). `terminal` capability optional.
- Slash: `available_commands_update`, re-emitted repeatedly → dedupe.
- Config home: `GROK_HOME` IS a valid env override (`xai-dirs` reads it;
  earlier "no override" text was wrong). ADE passes the resolved value to the
  ACP child and auth probe, defaulting to the user's `~/.grok`; it never writes
  the directory. This keeps custom credential homes first-class without
  changing the default login path.
- Tracked CLI: positional prompt `grok "<p>"`, `-s <uuid>` assign, `-r <id>` /
  `-c` resume, `--permission-mode {default,acceptEdits,auto,dontAsk,
  bypassPermissions,plan}`, `--reasoning-effort`, `--rules` (append guidance),
  `--no-alt-screen`. NEVER pass `-w/--worktree` (collides with lanes).
- Auth: reuse `grok login` (`~/.grok/auth.json`) or `XAI_API_KEY`; stored
  session token outranks env key. No free tier.
- Version churn ~daily; record the binary version in diagnostics; compatibility
  baseline remains ≥1.0.13. The npm `latest` release is 1.0.34, published
  2026-09-16 04:15:07 UTC; its release notes add generally available Memory and
  Markdown heading theme colors without changing the ACP launch contract. ADE's
  setup/error copy recommends `@xai-official/grok@1.0.34` for this baseline.

### Copilot (`copilot --acp`, npm `@github/copilot@1.0.86`, PREVIEW)
- The 1.0.86 compatibility baseline (ACP agent 1.0.86, captured
  2026-09-18) advertises `loadSession`, image prompts, HTTP/SSE MCP, and
  session list/close. It does not advertise `session/resume`. ADE checks the
  handshake before sending lifecycle methods, and older 1.0.x binaries that
  omit close release a shared lease without killing other chats.
- ACP mode controls are live: `agent`, `plan`, and `autopilot`, plus the
  `allow_all` option. ADE maps its abstract permission ladder to those native
  mode ids and normalizes Copilot's `currentValue` / nested `value` shape.
  Copilot has no intermediate auto-edit mode, so ADE deliberately maps
  `auto-edit` and `auto` down to approval-gated Agent mode and tells the user
  about that downgrade.
- Slash commands arrive as ordinary prompts plus `available_commands_update`;
  TUI-only commands (`/diff`, `/resume`, `/login`, `/undo`…) are filtered from
  the picker or they hit the model.
- KNOWN BUG: `session/cancel` as a REQUEST answers -32601 on the observed
  compatibility path. Send it as a notification. Historical live 1.0.82
  cancellation returned `stopReason:"end_turn"` with partial text
  `"1\n2\n3\n4\n5"` (github/copilot-cli #4561), so client-side cancel accounting
  remains mandatory until GitHub documents a fix.
- `--model` and `--effort` are process-global ACP launch flags. ADE passes the
  selected model and effort at launch and folds both into the pool identity.
  `session/new` takes no model parameter; the `--model` value seeds the
  session's model state.
- Usage: `usage_update { used, size }` is the context meter and the prompt
  result `usage { inputTokens, outputTokens, totalTokens, thoughtTokens,
  cachedReadTokens, cachedWriteTokens }` is the turn's tokens, with an
  `inputTokens` that counts the cache (14160 = 13008 uncached + 1152 read in
  the capture). Everything else is only in Copilot's own
  `$COPILOT_HOME/session-store.db`, table `assistant_usage_events`, written as
  each request completes (`session_id` = the ACP session id, `agent_id`,
  `parent_tool_call_id`, `model`, token columns, `total_nano_aiu`,
  `request_multiplier`, `initiator`, `created_at`). The store is in WAL mode
  (`PRAGMA journal_mode` = `wal`, read 2026-09-23 on 1.0.88), so a reader never
  waits on Copilot's writer. ADE opens it read-only (`node:sqlite`) and keeps
  every read off the prompt path: the turn start is a timestamp (no read in
  front of `session/prompt`), and at turn end the turn's rows are the
  session's rows whose `created_at` (Copilot writes ISO 8601 UTC with
  milliseconds; the column default's `datetime('now')` shape is normalized
  too) is at or after it. The read runs on a later tick than the call, with
  `busy_timeout = 0`; a busy store is retried on a 40 ms timer, three reads at
  most, inside the 250 ms turn-end deadline, and anything else resolves
  `null`. That gives
  `servedModel` (the model Copilot picked: `mai-code-1.1-flash` for a session
  with no model set), `requestCount`, `planUsage` = premium requests (sum of
  `request_multiplier` over rows the user initiated; `initiator = "agent"`
  follow-ups are not billed as premium requests) and `nano_aiu` (sum of
  `total_nano_aiu`), and one derived `done.subagentUsage` entry per
  `agent_id`. Account: always the Copilot subscription.
- Model selection. ADE passes `--model` at launch and calls
  `session/set_model` after every entry. In 1.0.88, `session/set_model` and
  `session/set_config_option { configId: "model" }` run the same code
  (`validateSelection`, then `model.switchTo`). The `session/new` result lists
  a `model` option only when Copilot's model state projects one. When it
  does, ADE sends only a model from that list (see 3.6). Config options use
  `currentValue` and nested `value`, which ADE canonicalizes onto `value` /
  `options[].id`.
- **On a plan that includes only Auto, no ACP mechanism selects the model**
  (verified 2026-09-23 on 1.0.88, this machine's account):
  - The CAPI `/models` list (logged with `--log-level all`) marks all 53
    models `model_picker_enabled: false`.
  - `session/new` lists no `model` option.
  - `session/set_model` answers `{}` and writes `session.model_change`. Then
    `session.auto_mode_resolved` (`routingMethod: auto_v2`) picks the model
    from a one-model pool. `claude-haiku-4.5` and `mai-code-1.1-flash` were
    asked for; `gpt-5.6-luna` served both (`assistant_usage_events.model`).
    Auto also replaced the effort (`low` asked, `medium` served).
  - Every earlier session in `session-state/` shows the same Auto routing.
    With no model, a stale `settings.json` model (`gpt-5.2`) became `auto`
    at startup.
  - The binary names the rule: "only Auto mode is available on your plan",
    "The --model argument will be overridden", and "The COPILOT_MODEL
    environment variable will be overridden".
  - `session/new` reads no model from `_meta`. `--auto-tier` and
    `COPILOT_AUTO_TIER` choose only the Auto routing profile.
  ADE shows the truth instead. It reads the served model from
  `session-store.db`, reports it as `done.servedModel` (the chat service logs
  `agent_chat.served_model_mismatch`), and posts one notice per served model
  (see 3.5). No new live turn was spent; the two probe turns above are
  the live evidence.
- Server-start flags (`--effort`, `--available-tools`, `--excluded-tools`) are
  process-global; `session/new` cannot override.
- **Trust pre-seed: REMOVED. ADE does not write Copilot's config.** There was
  once an `ensureCopilotFolderIsTrusted` helper that added the lane worktree to
  `$COPILOT_HOME/config.json` before `session/new`. The helper, its call site in
  `agentChatService.ts`, and its tests are deleted, and nothing on the Copilot
  path may write the provider's config home again.
  - **It bought nothing.** A three-arm live experiment on 1.0.82 opened
    headless `session/new` with no trust key and no `--add-dir`, in a throwaway
    git cwd and in a nested independent git repo. No arm deadlocked on a "do you
    trust this folder" gate. Cwd writes completed in every arm with
    `allow_all: "off"`, no `permissions-config.json`, a `tool_call` of kind
    `edit`, and **0** `session/request_permission` RPCs. The write did not
    enable permission prompts — Copilot ACP cannot be interactively gated
    headless on this version, seed or no seed.
  - **It cost something real.** `config.json` is JSONC (leading `//` comment
    header). `JSON.parse` throws on that header, and the recover path rewrote a
    user's live `~/.copilot/config.json` as a stub, dropping the comment header
    and sibling keys; every later `session/prompt` answered "No model
    available" until the file was restored. A no-overwrite guard was added
    afterwards, but the correct fix is to not write user state at all.
  - **Key name, for the record** (moot now that ADE writes neither, recorded so
    nobody re-adds the wrong one): live 1.0.82 persists `trustedFolders`
    (camelCase). Earlier research notes and older GitHub docs claimed
    `trusted_folders` (snake_case); that spelling is wrong. Which key the binary
    **reads** was never isolated, because ACP `session/new` opened with neither.
  - `--add-dir` **stays** on the spawn plan. It is argv, not a rewrite of user
    state, and it does not touch `config.json`. The experiment showed it is not
    load-bearing for opening a session or for writes either, but it is the
    cheapest available session path gate, so removing it needs its own decision.
- Auth: `copilot login` (browser local / device remote); free plan includes
  the CLI. `authenticate` succeeds only after login.
- Config home: `COPILOT_HOME` + `--config-dir` flag. Sessions at
  `~/.copilot/session-state/<uuid>/`.
- Tracked CLI: `copilot -i "<prompt>" --model <enum> --reasoning-effort
  <low|medium|high|xhigh>`; `--resume=<new-uuid>` doubles as assign-at-launch;
  `--continue`. `--model` is a FIXED enum — map or reject. No plan mode → map
  ADE plan to `--deny-tool write,shell` or reject the mode. `--no-alt-screen`.
- Windows: npm `.cmd` shim → prompt rides PTY.

### 3.5 Shared telemetry (all four dialects)

`acpTurnTelemetry.ts` owns it; dialects only translate their payloads into
`AcpTelemetrySignal`s (`extensionNotifications`), read their ledgers
(`localUsage`), and read the account (`readAccount`).

- `done` fields (`outcome.done`, spread into the turn's `done` event):
  `usage` token fields are the TURN TOTAL, and `inputTokens` is uncached input
  with cache reads/writes in their own fields; `usage.contextTokens` is the
  latest context sample of the turn (`usage_update.used`, or the last Grok
  response's input side); `contextWindow`; `requestCount`. Totals come, in
  order of trust, from the provider's turn report (Grok `turn_completed`), the
  local ledger (`usageConfidence: "derived"`), the prompt result, and last the
  sum of per-request reports (`derived`). The ledger outranks the prompt result
  because Copilot 1.0.88 answers a slash command such as `/compact` with the
  PREVIOUS turn's usage verbatim (verified live), while the ledger holds the
  turn's real rows; for the same reason a dialect that has a ledger but got
  nothing back from it reports the prompt result as `usageConfidence:
  "estimated"`. `costUsd` is only the provider's own
  figure (`costSource: "provider"`). `servedModel` is set when the provider
  names the model that answered and it differs from the requested one. The
  requested model is the launch model token the session opened with (in the
  agent's plain naming, so Qwen's `(authType)` suffix is stripped), replaced
  by Grok's `x.ai/models/update` `currentModelId` when that arrives.
  **Served-model mismatch.** The telemetry also keeps the model that ADE asked
  for, and no agent report replaces it. The shared `isServedModelMismatch`
  (`chat/servedModelMismatch.ts`) decides whether the model that answered is
  another model. Another spelling, a build or effort variant
  (`grok-4.7-build` for `grok-4.7`), or a router pick (a chat that asked
  Copilot for `auto`) is the same model. For another model, `done.servedModel`
  always carries it, also when the agent's own catalog named it as current.
  The chat service then logs the one warning for the turn,
  `agent_chat.served_model_mismatch { provider, requestedModel, servedModel }`.
  The host logs no ACP-specific warning. The host returns one
  `system_notice` (`noticeKind: "warning"`), for example "GitHub Copilot
  answered with gpt-5.6-luna, not claude-haiku-4.5." It does this once per
  served model per session. A dialect can add one line of detail (Copilot
  names the Auto rule). When the provider names no served model, the
  fallback is the session's current model: the model that ADE set on the
  session after the entry call, not the model that the entry call reported.
  `account` is `{ provider, kind, upstream?, endpoint? }` from local non-secret
  config (`endpoint` is an origin only); the email is the quota service's job.
  `planUsage` carries Copilot's premium requests and AI units.
  `subagentUsage` carries helper agents' usage from a ledger (`agentId`,
  `label`, `model`, `parentToolUseId`, token split, `usageConfidence:
  "derived"`); it is usage, so it never becomes a `subagent_result` event,
  which would draw a transcript card. Grok's live `subagent_finished` is real
  work and stays a `subagent_result`.
- Compaction: the session-compaction RFD's `compaction_update`
  (`in_progress` / `completed` / `failed` / `cancelled`, by `compactionId`)
  maps to `context_compact { detection: "provider" }`; unknown statuses and
  `compaction_summary_chunk` map to nothing. The translator reads
  `compaction_update` whether or not the client advertised
  `clientCapabilities.session.compaction`, and ADE does NOT advertise it:
  telemetry must not change what an agent does, and no dialect's agent has
  been seen to use it. The `initialize` handshake is the same as before
  telemetry, and no dialect switch exists to change it.
  Copilot runs its compaction as a model request that the ledger records with
  `initiator = "compaction"` (verified live with `/compact` on 1.0.88; no ACP
  update is sent), so ADE reports each such row as `context_compact { state:
  "completed", detection: "provider", preTokens: input }`. There is no
  `postTokens`: the row's output is the summary alone, not the context that
  follows. When the same turn's context drop already published an inferred
  compaction, the ledger row confirms that one and is not published again, so
  the session's compaction count rises once.
  Grok sends its own compaction on `_x.ai/session_notification`
  (`auto_compact_completed` with `tokens_before`/`tokens_after`, verified live
  with `/compact`). Both accepted `clientCapabilities.session.compaction` without
  error, and neither was seen to send `compaction_update`. Qwen and Kimi never
  report a compaction, and Copilot's ledger can be unreadable, so a
  `usage_update.used`
  that falls by more than 40% AND more than 20k tokens against the previous
  sample in the same session — same window, no model switch, no provider
  compaction in between or still open — publishes one `context_compact { state:
  "completed", detection: "inferred", trigger: "auto", preTokens, postTokens }`.
- The `tokens` fallback row from the prompt result is published only for a
  turn that produced no context sample, so an exact sample keeps the meter.
- Ledger reads and the post-turn `usage_update` wait are each bounded to
  250 ms and can never fail a turn; the ledger deadline is armed before the
  reader is called. A throw while building the turn's telemetry ends the turn
  with a plain `done` and one warning per session.
- Live context samples go through the shared `liveContextUsageEvent` builder,
  so the meter's percentage rounds to two decimals like every other runtime.

### 3.6 Model and effort selection (all four dialects)

`acpRuntimeCoordinator.ts` owns these rules. The chat service only passes the
chat's model token and effort.

- **Order after every entry** (`session/new`, `session/resume`,
  `session/load`): mode, then model, then effort. A resumed session comes
  back on the model and effort that it last ran with (Grok 1.0.40), so a
  mid-chat model change reaches the agent here. The chat service tears the
  runtime down on a model change, and the next send rejoins the session.
- **Mode** is set only when the dialect lists `mode` in `configOptionIds`
  (Qwen, Kimi, Copilot). Grok has no `mode` option. For the same reason, the
  chat service auto-approves permission cards in full auto for any dialect
  without `mode`, Grok included.
- **Model.** Copilot uses `session/set_model`. Grok, Qwen, and Kimi use the
  `model` config option. Before it sends, the coordinator checks the value
  against the choices that the session advertised
  (`resolveAcpConfigValue`):
  - An exact choice wins. Otherwise the dialect's `modelIdFromAgent` maps
    each choice to a plain id (Qwen's suffix). When two choices share the
    plain id, the current value wins, so a model pick never changes Qwen's
    auth type.
  - A value that the session already has is not sent again.
  - A model that the session does not offer is not sent. The coordinator
    logs `agent_chat.acp_model_not_offered { model, offered }`, keeps the
    session's model, and runs the turn. The served-model notice then tells
    the user which model answered.
  - An option with no advertised choices is sent as is, and the agent
    judges it. A failure is logged as `agent_chat.acp_set_model_failed` and
    never fails the turn.
  - A model that the agent accepts becomes the session's current model
    (`AcpSession.noteCurrentModel`), and the runtime's local `model` option
    takes the value. Copilot's `session/set_model` answers `{}`, and Kimi can
    answer `session/set_config_option` with no option set, so nothing else
    records the change.
- **Effort.** A dialect declares `reasoningEffortOption { configId,
  toAgentValue, resetValue?, sendWhenUnadvertised?, failClosed?, spawnFlag? }`.
  Qwen and Grok use `reasoning_effort`; Kimi uses `thinking`; Copilot has
  none (its effort rides `--effort`). `null` and the chat service's `default`
  both mean "no effort picked". That clears the effort that ADE set:
  - Qwen sends its `resetValue`, `default`, for every clear. It sends
    `default` also when the session does not list it, because Qwen accepts
    it. Qwen also sends a picked value when the session advertises no
    choices.
  - Grok and Kimi send the effort that the session reported when it opened
    (`initialConfigOptions`), if the session still offers it. If the session
    reported no effort, they send nothing.
  - Grok maps ADE's ladder onto its own (`max` and `ultracode` become
    `xhigh`). Kimi sends the level as is, and only when the session offers
    it.
  - A picked value that the session does not offer is logged as
    `agent_chat.acp_reasoning_effort_not_offered` and not sent.
  - An invalid params or method-not-found reply is always a non-fatal
    rejection (`rejected`).
  - Any other failure (transport, server, the 60 s request deadline) is fatal
    only for Qwen (`failClosed`): at startup it tears the runtime down, so a
    resumed session cannot keep a stale effort. For Grok and Kimi it is
    logged as `agent_chat.acp_set_reasoning_effort_failed { result:
    "rejected" }`, and the session starts and keeps its own effort.
  - An agent that accepts the value with no option set in its reply still
    runs that value, so the runtime's local option takes it. A later call
    then does not skip a value as current when it is not.
  - A live effort change (`setAcpReasoningEffort`) follows the same rules on
    the open session. It answers `applied`, `unchanged`, `rejected`, or
    `transient_failure` (Qwen only).
  - `spawnFlag` (Grok's `--reasoning-effort`): see §3 Grok. A runtime whose
    spawn plan differs only in this flag is reused when its session
    advertises the effort option, and restarted when it does not.
- **Snapshot.** `session/set_config_option` replies carry the whole option
  set. The coordinator keeps the latest set on the runtime and publishes it
  after the calls, not the entry call's older snapshot.

## 4. ADE contract extensions (all move together, one PR-layer)

From the internal audit (all file:line refs verified 2026-08-30):
- `shared/types/chat.ts`: `AgentChatProvider` + `"qwen"|"kimi"|"grok"|"copilot"`,
  `AgentChatModelCatalogRefreshProvider`, `PendingInputSource` + `"acp"`,
  session fields → ONE generic `acpConfigSnapshot`/`acpPermissionMode` shape
  (mirroring `cursorModeSnapshot`/`cursorConfigValues`), NOT four bespoke
  field families. `ACTIVE_TURN_DISPATCH_MODES`: all four queue-only.
  `HANDOFF_FORK_PROVIDERS`: exclude all four (brief-only handoff).
- `shared/modelRegistry.ts`: `ProviderFamily` + `"qwen"|"moonshot"|"xai"|
  "github"` (or equivalent), `ModelProviderGroup` + four, curated descriptors
  per provider (small set: the models users actually pick), helpers.
- `shared/modelCatalog.ts`: `ProviderGroupKey`, `PROVIDER_ORDER`,
  `PROVIDER_GROUP_ORDER/COLORS`, `classifyProviderGroup` — replace silent
  `default → "opencode"` with exhaustive `Record` tables.
- `shared/types/config.ts`: `AiProviderConnections` + four keys;
  `AiSettingsStatus.availableProviders/models` records extended.
- `main/services/ai/authDetector.ts` (+ `CliName`), `providerConnectionStatus`,
  `providerRuntimeHealth`: arms for four providers (binary detect + protocol
  auth probe; Jean pattern: spawn, `initialize`+`authenticate`, map JSON-RPC
  error to "Run `<cli> login` first").
- `main/services/shared/providerConfigHomes.ts`: `qwenConfigHome` (QWEN_HOME),
  `copilotConfigHome` (COPILOT_HOME), `kimiCodeConfigHome` (KIMI_CODE_HOME),
  and `grokConfigHome` (GROK_HOME) — config-directory env overrides. Grok
  defaults to `~/.grok`.
- `shared/cliLaunch.ts`: `CliProvider` + four; launch/resume builders. Template:
  claude branch for qwen/grok/copilot, cursor branch (initialInput) for kimi.
- `renderer/lib/sessions.ts`: `KnownChatProvider` + four; both maps + tool types.
- `agentChatService.ts`: `catalogProviders` + `loadAvailableModels` arms
  (cached-or-fallback fast tier — NEVER probe synchronously on catalog read);
  cross-machine preflight `activateRuntime` list + four (agentChatService.ts
  ~:33921); fork capability → generic brief fallback.
- Catalog sync: connected-only filter + size cap (4.85 MB incident guard).
- Picker greying: `useProviderAuthStatus.familiesFromStatus` + four arms;
  `providerEmptyState.PROVIDER_COPY` + four; `runtimeCatalogCache`
  `REFRESH_PROVIDERS` + four and `refreshProviderForFamily` (qwen / moonshot→kimi
  / xai→grok / github-copilot→copilot); `pickerFamilyForCatalogGroup` exhaustive.
  Desktop `ALL_PROVIDER_FAMILIES` includes the four ACP families so the Work
  picker rail always has Qwen / Kimi / Grok / GitHub Copilot tabs (Favorites
  is a starred subset and will not list them until starred).
- TUI: `AdeCodeProvider`, `TUI_PROVIDER_OPTIONS`, `PROVIDER_FAMILY_LABELS`,
  `PROVIDER_ORDER`, `modelPickerProviderAuthStatus`, `providerFromCatalogGroup`
  (exhaustive, no codex fallback), icons (qwen + copilot marks needed; grok +
  kimi exist), peripheral lists (`adeRpcServer` enum, `remoteLauncher`,
  `agentRegistry`, login commands).
- iOS: `workModelGroupOrder` (+4 or the phone silently drops the groups),
  label/icon/tint/asset/family switch tables, `ProviderGitHub` asset reusable
  for copilot; qwen/kimi/grok assets needed. Ship in the same release train.
- Preload/IPC: extend generic `ade.ai.*` surfaces; keep preload/shared/renderer
  types in sync (runtime-backed null services rule).

## 5. Settings → Models redesign (all 9-10 providers)

- Routing: single settings route stays; sub-view via `?tab=agents&provider=
  <id>`. ~10 new `SETTINGS_ENTRIES` (one per provider) so ⌘K + deeplinks work;
  `#ai-providers` and legacy aliases keep resolving (settingsManifest.test.ts
  invariants).
- Grid: responsive `repeat(auto-fit, minmax(280px, 1fr))`. Reuse/extend
  `providerSectionPrimitives.tsx` (`ProviderGrid`/`ProviderTile`).
- Tile (labeled): logo · name · status dot + word (Connected / Sign in /
  Needs attention / Not installed / Checking / Disabled) · model count ·
  version · Preview chip (grok/copilot) · one-line error when unhealthy.
  "Checking" is a first-class state distinct from "Not detected".
- Detail page: two-column. Left rail: identity, status, version (pinned — NO
  update-available surface), auth actions (sign in/out), diagnostics entry,
  disable toggle. Right: models (curated ★default + discovered, search),
  permission defaults, default model, usage bars where the provider reports
  them (Kimi's appear once Kimi reports usage).
- Architecture: descriptor-driven. One `ProviderCard`/`ProviderDetailPage`
  parameterized by a per-provider descriptor + an auth-body slot for the
  genuinely bespoke flows (Pi catalog, OpenCode catalog, Cursor OAuth). Do not
  copy-paste per-provider JSX (the disease being cured).
- Permission defaults move here; keep the composer tables as the write path is
  one-way abstract→native — the detail page writes the ABSTRACT mode only.
- The model-list call IS the health check: a failed enumerate renders as an
  error row under that provider (VS Code pattern); no Verify button.

## 6. Extras (locked)

1. Embedded terminal sign-in modal: real PTY running the provider login
   command; auto-open OAuth URL; auto-close when auth probe flips green;
   reachable from Settings AND the chat auth_required error card.
2. Settings search aliases: brand keywords (qwen, moonshot, kimi, copilot,
   github, grok, xai, acp…) route settings search/⌘K to provider pages.
3. Vendor doctor in diagnostics: run `grok doctor` / `kimi doctor` where
   available; fold output into the copyable diagnostic report.
4. Honest-degradation first-use notes: one dismissible line per known hole
   (e.g. "Copilot sometimes reports a stopped turn as finished. ADE marks it
   stopped.").

Rejected: env-var provenance surfacing, authenticating pulse animation,
update-available UI, picker overhaul beyond greying.

## 7. Test contract

- `run | degrade` conformance matrix (AgentConnect pattern): every
  (feature × provider) cell asserts either works, or gracefully absent —
  never throws, never hangs. Features: capabilities, lifecycle, prompt/stream,
  permission round-trip, cancel, close/eviction, resume, slash advertise,
  usage fold, MCP injection.
- Scripted mock ACP agent + recorded fixture replay for CI (no credentials).
- Capability declarations use a `requiresBehavior`-style invariant: a dialect
  that declares a capability must supply the behavior (compile-time where
  possible).
- Exhaustive `Record` tables + `AssertNever` replace switch-defaults.
- Windows parity is default-required: hidden console, process-tree kill
  (`taskkill /T /F`), `.cmd` shim prompt rule, Kimi Git-Bash preflight.

## 8. Work-unit ownership (build order)

- **W1-contracts**: §4 sweep (types, registry, plumbing, cliLaunch, cross-
  machine, picker greying, TUI lists). Owner boundary: everything in §4.
- **W2-host**: `acpHost/` module + mock-agent test harness. New files only;
  integration seam documented, not wired.
- **W3-settings-ui**: §5 redesign against existing six providers with the
  descriptor architecture; four ACP descriptors plug in later.
- **W4-wire**: agentChatService integration (runtime adapter per provider using
  W2 host + W1 contracts), auth probes, catalog arms live.
- **W5-dialect-verify**: live smoke per provider + preview graduation probes
  (grok permission prompt, kimi resume-permission-flag).
- **W6-extras**: §6 items.
- **W7-parity**: TUI + iOS surfaces, sync allowlists.
- **W8-tests**: §7 harness + regression suites; then /quality → /test → /ship
  as stacked PRs.
