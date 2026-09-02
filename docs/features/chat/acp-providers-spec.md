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
  turn as `interrupted` regardless of the provider's stopReason.
- MCP injection at `session/new` is capability-gated per dialect; never inject
  the Codex-signed computer-use MCP into ACP providers.
- Connection/process pooling keyed `{provider, cwd, env}` with idle TTL and a
  generation counter (pattern: Emdash `connection/source.ts`).

## 2. Tier policy

| Provider | Tier | Notes |
|---|---|---|
| qwen | first-class | cleanest surface |
| kimi | first-class | two holes, absorbed (below) |
| grok | preview (Settings-only label) | **blocker CLEARED 2026-08-31, tier decision pending.** A real `session/request_permission` was observed in a host-driven ACP session on 1.0.13 once both halves of §3's neutralization were applied. Graduating to first-class is a product call, not a technical one; the remaining caveat is that the kill switch is an undocumented vendor hatch (§3 rule 3) |
| copilot | preview (Settings-only label) | graduates when GitHub fixes cancel + drops preview |

Preview labels appear ONLY in Settings (tile + detail page). Pickers render all
providers identically.

## 3. Per-provider dialects (verified facts — do not re-derive)

### Qwen (`qwen --acp`, npm `@qwen-code/qwen-code` **0.22.3**)
- Caps: loadSession, session list/resume, image **and audio** prompts, MCP
  http/sse. Slash via `available_commands_update`. **`session/close` is not
  advertised and answers -32601.** ADE ends the process (one process per
  session). Default `qwen --help` hides `--acp`, `--approval-mode`,
  `--session-id`, `--yolo`, and `--append-system-prompt`; they exist (error-path
  help lists them).
- Auth: `qwen auth` is **removed**. Advertised ACP method is `openai`
  (`OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, `--auth-type=openai`, or a
  custom provider already saved in `~/.qwen/settings.json`). ADE does **not**
  write that file — it reuses the Qwen CLI the user already configured, including
  a local OpenAI-compatible proxy. Unauthenticated `session/new` is
  `-32000 Authentication required: Use Qwen Code CLI to authenticate first.`
  `authenticate` with `openai` and no key is `-32603 Internal error` whose
  `data.details` say "Missing API key" even when the key already lives in
  settings.json, so ADE's auth probe uses `session/new` as the proof. Free OAuth
  tier is dead (2026-04). Live model ids come from `settings.json`
  `modelProviders` plus anything a session later reports.
- Config home: `QWEN_HOME` names the config dir (CODEX_HOME shape). Runtime
  state axis: `QWEN_RUNTIME_DIR`. Live probe: `QWEN_HOME` relocates
  `installation_id`, extensions, `output-language.md`.
- Session config via `session/set_config_option` (mode/model/thinking).
  Approval modes: plan|default|auto-edit|auto|yolo.
- Tracked CLI: `qwen -i "<prompt>" -m <model> --approval-mode=<m> --session-id
  <uuid>`; resume `--resume <id>` / `--continue`; NEVER pass `--yolo` together
  with `--approval-mode` (parse error: use `--approval-mode=yolo`). NEVER pass
  `--session-id` with `--resume`/`--continue`. `--append-system-prompt` carries
  ADE guidance.
- Windows: npm `.cmd` shim → prompt rides PTY (`promptRidesInArgv = platform
  !== "win32"`), same rule as Claude.

### Kimi (`kimi acp`, native binary **0.39.1**, repo MoonshotAI/kimi-code — NOT the
deprecated Python kimi-cli)
- Caps: loadSession, list, resume, **`session/close` (implemented; dummy id
  returns `{}`)**, plus delete/fork/additionalDirectories. Image prompts yes,
  audio no. MCP http/sse. `agentCapabilities.auth.logout` is advertised; ADE
  has no ACP logout yet. **Usage on the wire still unverified** (hidden meter
  + degradation note until an authenticated turn proves otherwise).
- Auth: `kimi login` / `kimi acp --login` device-code; region
  `mainland-cn` (kimi.com) or `global` (kimi.ai). ADE does **not** write
  `~/.kimi-code/config.toml`. `authenticate` method id
  `login`, type `terminal`. Unauthenticated `session/new` is `-32000
  Authentication required`.
- Config home: `KIMI_CODE_HOME` (dir itself, default `~/.kimi-code`),
  `config.toml`. Live probe: `kimi doctor` and ACP both honour it. Installer
  default bin is `$HOME/.kimi-code/bin` — ADE's known-dir lookup includes that
  path because `KIMI_NO_MODIFY_PATH` skips rc edits. Model flag takes an ALIAS,
  not a raw model id.
- Tracked CLI: NO argv prompt for interactive TUI → use
  `{ initialInput: prompt, initialInputDelayMs: 750 }` (Cursor-branch shape).
  Non-interactive `-p/--prompt` exists and **cannot** combine with `--yolo` or
  `--auto`. Resume `-S <id>` / `-c` (lowercase c). Permission: `--yolo` XOR
  `--auto` (parse error: "Cannot combine --yolo with --auto"); `--plan`. Vendor
  docs say permission flags ARE allowed on resume (Emdash's omit-on-resume is
  stale) — verify with one live probe after login.
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
     spinner hint, NOT a permission request. Never answer it.
  6. Read/Grep/WebSearch never prompt (SAFE_COMMAND) — absence of prompts for
     reads is normal.
  7. Real option ids offered are `allow-edits-session`, `allow-once`,
     `reject-once` — NOT `enable-always-approve`. The bridge derives a kind
     from the id, so an unrecognized id still lands on a safe kind.
- Cancel: send `session/cancel` as a JSON-RPC NOTIFICATION (request → -32601).
  Result arrives as `stopReason:"cancelled"`.
- Usage: no standard `usage_update`; read usage+cost from the `session/prompt`
  RESULT `_meta`. On 1.0.13 `costUsdTicks` and `modelUsage` sit under
  `_meta.usage`, with token totals also at the top level. ADE accepts both
  shapes (`costUsdTicks`, `modelUsage`, `cachedReadTokens`, plus nested
  `usage`). `costUsdTicks` are nano-dollars (1_000_000_000 = $1.00). A
  captured 30k-token ping at 86_649_000 ticks is $0.0866, not $86.65.
- `session/set_config_option` is non-standard (`configId`, undocumented value
  enum) → set model/effort via spawn flags (`-m`, `--reasoning-effort`).
- NEVER advertise client `fs` capability (Grok proxies binary reads through
  text fs and corrupts assets). `terminal` capability optional.
- Slash: `available_commands_update`, re-emitted repeatedly → dedupe.
- Config home: `GROK_HOME` IS a valid env override (`xai-dirs` reads it;
  earlier "no override" text was wrong). ADE still sets nothing and reuses the
  user's `~/.grok`, because a private home would hide their `grok login`
  credential and rules. That is a choice, not a limitation.
- Tracked CLI: positional prompt `grok "<p>"`, `-s <uuid>` assign, `-r <id>` /
  `-c` resume, `--permission-mode {default,acceptEdits,auto,dontAsk,
  bypassPermissions,plan}`, `--reasoning-effort`, `--rules` (append guidance),
  `--no-alt-screen`. NEVER pass `-w/--worktree` (collides with lanes).
- Auth: reuse `grok login` (`~/.grok/auth.json`) or `XAI_API_KEY`; stored
  session token outranks env key. No free tier.
- Version churn ~daily; record binary version in diagnostics; floor ≥1.0.13.

### Copilot (`copilot --acp`, npm `@github/copilot`, PREVIEW)
- Caps on 1.0.82 (ACP agent 1.0.4): `loadSession`, image prompts, session
  list. `session/resume` and `session/close` are **not** advertised and
  answer -32601. Slash as ordinary prompts + `available_commands_update`;
  TUI-only commands (`/diff`, `/resume`, `/login`, `/undo`…) must be filtered
  from the picker or they hit the model.
- KNOWN BUG: `session/cancel` as a REQUEST answers -32601. Send it as a
  notification. Live 1.0.82 cancel mid-count returned `stopReason:"end_turn"`
  with partial text `"1\n2\n3\n4\n5"` (github/copilot-cli #4561) → client-side
  cancel accounting is mandatory. ADE still attempts `session/close` and
  degrades, keeping the process for pooling. Real `session/prompt` turns work
  (`"ping"`, usage on the prompt result + `usage_update`). `copilot -p --model
  gpt-5.4` errors "not available"; the same flag on `--acp` is ignored and the
  default model still answers. Config options use `currentValue` and nested
  `value`, which ADE canonicalizes onto `value` / `options[].id`.
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
  `copilotConfigHome` (COPILOT_HOME), `kimiCodeConfigHome` (KIMI_CODE_HOME) —
  CODEX_HOME shape. Grok: none (use `~/.grok`).
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
  them (hidden for kimi).
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
   (e.g. "Kimi doesn't report token usage — usage meter hidden for this chat").

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
