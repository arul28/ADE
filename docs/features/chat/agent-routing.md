# Agent routing, permissions and model registry

Every chat resolves to a provider, a model and a permission mode before a turn
runs. This doc covers how, and where the code lives.

## Source file map

Paths are under `apps/desktop/src/`.

| Path | Role |
|---|---|
| `shared/modelRegistry.ts` | `MODEL_REGISTRY` (`ModelDescriptor` rows), aliases, defaults, resolution helpers, `selectSupportedReasoningEffort`, `shorthandModelNameRefusal`. The model tables live here, not in docs. |
| `shared/model-manifest.json`, `shared/modelManifest.ts`, `main/services/ai/modelManifestService.ts` | Model changes without a release. |
| `shared/chatModelSwitching.ts` | Mid-session model list rules. |
| `shared/permissionLadder.ts` | The four autonomy levels mapped onto every family. |
| `main/services/chat/permissionMapping.ts` | Abstract `AgentChatPermissionMode` → native fields (one way only). |
| `shared/codexApprovalPolicy.ts` | Which approval policies each Codex interface accepts. |
| `main/services/chat/identitySessionPolicy.ts` | CTO permission pin and lane resolution. |
| `main/services/chat/crossProviderReplayFork.ts`, `claudeReplayOverflowRecovery.ts` | Replay budget for cross-provider forks; Claude overflow retry. |
| `main/services/chat/providerThreadContinuity.ts` | Which provider thread a chat talks to; staged prompt sections. |
| `main/services/chat/sessionTurnHealth.ts` | Durable turn health reducers. |
| `main/services/chat/servedModelMismatch.ts` | `isServedModelMismatch`, `isServedRouteMismatch`. |
| `main/services/shared/providerConfigHomes.ts` | Provider config homes and the config-ownership rule. |
| `main/services/ai/authDetector.ts`, `providerConnectionStatus.ts`, `providerRuntimeHealth.ts` | Credential discovery, connection status, degraded states. |
| `main/services/ai/apiKeyStore.ts`, `main/services/account/accountVaultBridge.ts` | DAEX provider keys, account vault mirror, purge on account change. |
| `main/services/ai/codexExecutable.ts`, `droidExecutable.ts`, `claudeCodeExecutable.ts` | Pinned CLI resolution (never PATH). See [agent tools cache](../onboarding-and-settings/agent-tools-cache.md#resolution-order). |
| `main/services/chat/codexAppServerPool.ts` | Shared `codex app-server` processes. |
| `main/services/chat/cursorSdk*.ts`, `cursorModelSelection.ts`, `cursorModelsDiscovery.ts`, `shared/cursorModes.ts` | Cursor adapter, model params, catalog, modes. |
| `main/services/chat/droidSdk*.ts`, `droidModelsDiscovery.ts` | Droid adapter (forked worker per session) and models. |
| `main/services/chat/piSdk*.ts`, `piSession*.ts`, `main/services/ai/piInstallation.ts`, `piAuthService.ts` | Pi adapter, session store/lease/ownership, install resolution, sign-in. |
| `main/services/chat/museSdkHost.ts`, `museSdkEventMapper.ts`, `museSessionSupport.ts` | Muse adapter. |
| `main/services/chat/openCodeTurnUsage.ts`, `claudeTurnUsage.ts`, `codexSubagentUsage.ts`, `providerUsageAccount.ts` | Turn telemetry per provider. |
| `main/services/ai/providerTaskRunner.ts`, `pinnedCliTaskRunners.ts`, `providerTaskCommon.ts` | One-shot tasks (titles, summaries). |
| `shared/cliLaunch.ts` | Tracked CLI start/resume builders; `LAUNCH_PROFILE_TOOL_TYPE`; Pi tool policies. |

## Gotchas

- **Model discovery changes the registry.** `localModelDiscovery.ts` adds and
  removes descriptors; anything caching the registry must re-read.
- **Cursor discovery is per surface** (`cursorSource`: `"sdk" | "cli" | "all"`).
  Chat uses the SDK (fast); Work CLI drafts use `cursor-agent` (slow). The other
  source is served from last-known-good (`runtimeCatalogCache.ts`).
- **Claude runtime probe** (`claudeRuntimeProbe.ts`) is fully isolated
  (`settingSources: []`, no MCP, `persistSession: false`); a new probe option
  must not be able to fail the health answer.
- **Claude account skills download first.** A claude.ai account syncs skills and
  plugins into `<config>/skills/synced` on its first session, which changes the
  skill list (and prompt cache) of a chat started meanwhile.
  `claudeAccountSkillSync.ts` starts one prompt-less session (max 15 s) when the
  base home has no `.last-complete-round`; chat starts wait at most 5 s
  (`waitForClaudeAccountSkillSync`).
- **Permission mapping is one way.** Changing a native field without the
  abstract one desyncs them.
- **CTO compaction** must re-inject identity and memory
  (`refreshReconstructionContext`).
- **OAuth redirect ports** (`oauthRedirectService.ts`) are ephemeral; a port
  stolen before the callback fails the flow silently.

## Supported providers

`AgentChatProvider` (`shared/types/chat.ts`) lists 13 providers plus an open
string branch for discovered runtimes. Each has two surfaces: **chat** (DAEX
drives an SDK or protocol and gets typed events) and **CLI** (the provider's own
program in a DAEX terminal; profile in `LAUNCH_PROFILE_TOOL_TYPE`). CLI turn
status comes from `main/services/pty/cliTurnSignals.ts`: Claude Code hooks
(`claude-hooks`) and Codex OSC 7501 (`codex-osc`) are exact; every other CLI is
`heuristic` (output and quiet time).

| Provider | Chat runtime | Adapter |
|---|---|---|
| `claude` | `@anthropic-ai/claude-agent-sdk` `query()` on DAEX's pinned Claude Code (with [fall-forward](../onboarding-and-settings/agent-tools-cache.md#claude-fall-forward)) | `agentChatService.ts` (inline) |
| `codex` | Pinned `@openai/codex` `codex app-server` (JSON-RPC), shared per launch shape | `agentChatService.ts`, `codexAppServerPool.ts` |
| `cursor` | `@cursor/sdk` in a worker pool; DAEX owns permissions, hooks, system prompt | `cursorSdk*.ts` |
| `droid` | `@factory/droid-sdk` in a forked worker | `droidSdk*.ts` |
| `opencode` | Pinned OpenCode server ([opencode-integration.md](opencode-integration.md)) | `services/opencode/*`, `agentChatService.ts` |
| `pi` | Pinned Pi package loaded as a library in a forked worker | `piSdk*.ts` |
| `muse` | `muse serve` over the Muse Session Protocol (`@muse-code/sdk` framing) | `museSdkHost.ts` |
| `copilot` | `@github/copilot-sdk` on the pinned Copilot runtime ([copilot-sdk-provider.md](copilot-sdk-provider.md)) | `copilotSdk*.ts` |
| `qwen`, `kimi`, `grok`, `devin` | Pinned CLIs on the shared ACP host ([acp-providers-spec.md](acp-providers-spec.md)); Devin Cloud via `devin acp --cloud` | `acpHost/`, `acpHost/acpDialects/` |
| `antigravity` | `agy acp` on the ACP host ([antigravity-provider.md](antigravity-provider.md)) | `acpDialects/antigravity*.ts` |

## Model registry

`MODEL_REGISTRY` rows carry id, aliases, family, auth types, window, efforts,
`serviceTiers` (`"fast"`; `"ultrafast"` from Codex), route and prices. Read
`shared/modelRegistry.ts` for the current Claude and Codex rows and aliases.

- `shorthandModelNameRefusal`: `run_ade_action`, `start_cli_session` and
  `spawn_agent` must name a model by full name, registry id or wire id; short
  and retired names are refused with the name to use. Saved chats, presets and
  automations still resolve aliases.
- `selectSupportedReasoningEffort`: keep a valid explicit effort, then the
  model's default, then a surface fallback, then Medium or the first tier. Every
  launch surface and handoff uses it; iOS mirrors it.
- Picker order is registry order; defaults are not hoisted.
- Codex pickers show only rows the app server's `model/list` reports for the
  account. Deprecated rows resolve for saved chats but are not offered.
- `localModelDiscovery.ts` adds LM Studio and Ollama models with
  `harnessProfile: "guarded"` unless whitelisted.

### Model manifest (models without a release)

`shared/model-manifest.json` is bundled and also fetched from GitHub `main` by
`modelManifestService.ts` (URL in `shared/modelManifest.ts`), so a merge reaches
running installs within minutes.

- It can add a model, patch whitelisted fields (price, window, aliases,
  efforts, `deprecated`), and set `defaults.app`, `defaults.providers` and
  `defaults.free` (see [Free models](composer-and-ui.md#free-models)). One
  invalid field rejects the file; a collision rolls back.
- **Trust boundary:** unsigned, so only allowlisted routes
  (`MODEL_MANIFEST_ROUTE_CLI`), families, auth types, efforts and tiers; routing
  fields only on models it adds.
- `minAdeVersion` / `maxAdeVersionExclusive` gate entries.
- Freshness: GitHub copy, then `~/.ade/model-manifest.json`, then bundled; older
  than bundled is ignored (bump `updatedAt`). Polls every 10 min, re-checks on a
  catalog read after 3 min, backs off 5 min. Nothing waits on the network.
- Catalog responses carry `modelManifest`; pickers adopt newer ones
  (`adoptHostModelManifest`).
- Add a model to the manifest first, to `MODEL_REGISTRY` later if code depends on
  it. Check the wire id against the real runtime.

### Codex thread behavior

- A resumed thread's `collaborationMode` becomes the chat's mode unless
  `codexPendingCollaborationMode` holds one not yet run.
- DAEX always enables `tools.update_plan`, copies the thread's model and effort
  into the session, and treats non-blocking `item/tool/requestUserInput` as live
  steering.
- Computer Use MCP is added on macOS only, unless a host `permissionPolicy`
  refuses it.
- Plus/Team chats get one quiet `Approaching Codex plan limit` notice at 50% of
  the five-hour window.

## Auth and credentials

`detectAllAuth` (`authDetector.ts`):

- `installed` / `path` come from the pinned resolvers, never PATH. Disk-only
  sign-ins (Copilot, ACP) are read before the download. Cache keyed on
  `pinnedToolInstallGeneration()`.
- Cursor chat signs in via the SDK; the pinned `cursor-cli` is probed for CLI
  models once downloaded.
- API-key providers check `apiKeyStore.ts`, then env. DAEX keys are
  account-owned (`provider_api_key` in the account vault) or device-only.
- OpenCode's catalog comes from the live server; DAEX passes only credential
  env-var names and a source marker, never a key.
- The account vault is not a provider config home: env vars, provider CLI stores
  and Pi's `auth.json` stay local.

### Pi sign-in

`piAuthService.ts` drives Pi's `ModelRuntime.login` on an inventory-only worker;
Settings renders what Pi asks for (URL, device code, text/secret, choice).

- DAEX never holds the credential: the worker relays prompts, Pi's
  `AuthStorage` writes `auth.json`, and `registerIpc.ts` redacts
  `ade.ai.piLoginSubmit` values.
- One flow per provider; a new start supersedes. Ten-minute bound; Cancel waits
  `PI_LOGIN_CANCEL_GRACE_MS`.
- A loopback `baseUrl` makes a provider `local`, not a sign-in.

### Session store

SDK chat, tracked Pi CLI and discovery share one store
(`piSessionStoreForEnvironment`): `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`,
the profile's `sessionDir`, then `<agentDir>/sessions`.

- A checkout's `.pi/settings.json` is never read (a cloned repo cannot redirect
  sessions); `repositoryOverridesPiSessionDir` warns when Pi's CLI would.
- Pi writes a session file only at the first assistant message;
  `classifyPiSessionFile` answers `pending` and the chat leases that path at
  once.
- `<session>.ade-lease` (`piSessionLease.ts`): who writes now (pid + start time,
  reclaimable). `<session>.ade-owner` (`piSessionOwnership.ts`): durable owner
  claim. A CLI launch holds `piSessionCreationLeaseTarget(sessionRoot, cwd)`
  before Pi writes.

## Provider config ownership

DAEX's settings land at the highest precedence tier each SDK offers, so:

> Name a config key only when DAEX owns it (DAEX UI exists and DAEX's value is
> the truth). Otherwise leave it absent and let the provider resolve it.

A substituted default is a real value that wins. The rule lives in
`main/services/shared/providerConfigHomes.ts`. **A new provider starts here.**

| Provider | Where DAEX's settings land | Omitted key | Explicit `null` / `false` |
|---|---|---|---|
| Claude | Agent SDK `settings` (flag tier) | user's settings chain | `"Default"` is a real output style |
| Codex | `thread/start` + `turn/start` args | `config.toml` | `null` reports `"default"`, a downgrade |
| Droid | `createSession` / `updateSettings` | `~/.factory/settings.json` | `null` wedges Droid RPC for 30 s; never send |
| Cursor | `local.sandboxOptions` | `~/.cursor/sandbox.json` | DAEX always sends `false` |
| OpenCode | `OPENCODE_CONFIG` (generated) | user's `opencode.json` | a project `opencode.json` can override |

### Provider config homes

| Helper | Env override | Shape | Default |
|---|---|---|---|
| `claudeConfigHome()` | `CLAUDE_CONFIG_DIR` | directory | `~/.claude` |
| `codexConfigHome()` | `CODEX_HOME` | directory | `~/.codex` |
| `factoryConfigHome()` | `FACTORY_HOME_OVERRIDE` | HOME (`.factory` appended) | `~/.factory` |

Every path into a config home goes through these helpers; a hardcoded path reads
a different folder than the spawned process.

### What each adapter states

- **Claude:** `enabledPlugins`, `fastMode`; `outputStyle` only when a settings
  file names one; `workflowSizeGuideline: "medium"` only when none does
  (`claudeOutputStyles.ts` resolves keys in the SDK's order and honours
  `CLAUDE_CONFIG_DIR`). A per-account prompt-cache TTL setting becomes
  `CLAUDE_CODE_PROMPT_CACHE_TTL` env (`claudeAccountPromptCacheEnv`) unless the
  env or a preset already states one.
- **Codex:** service tier only when Fast is on. Effort, compaction point and
  chat identity go **per thread** (`codexThreadConfigArgs`), never as process
  `-c` flags.
- **Droid:** `resolveSessionDroidPermissionModeOrNull` returns `null` to omit
  autonomy and let `settings.json` decide (Droid's own default is read-only).
  Spec pairs with `autonomyLevel: "off"`; the worker exits Spec once
  (`enteredSpecMode`). `reasoningEffort` is not nullable, so clearing restates
  the model's catalog default (`resolveDroidReasoningEffortUpdate`).
- **Cursor:** local workers always get `sandboxOptions: { enabled: false }`;
  DAEX's hook denials are the guard.
- **OpenCode:** `share: "disabled"`, `update: "disable"`,
  `OPENCODE_DISABLE_AUTOUPDATE=1`; local provider blocks only when configured or
  discovered; DAEX agents are `hidden: true`. Only a confirmed 404 on
  `session.get` makes a new session.

#### One app-server for many Codex chats

Chats share one `codex app-server` when it would launch the same way (build,
account, preset, skill roots, env). `codexAppServerPool.ts` owns the process;
each chat keeps its own `CodexRuntime`. Costs:
[macOS baseline](../../perf/macos-baseline.md#codex-chats-app-server-processes).

- Per-chat env (`ADE_CHAT_SESSION_ID`, `ADE_LANE_ID`, `ADE_WORKSPACE_ROOT`,
  `ADE_PARENT_CHAT_SESSION_ID`, `ADE_SPAWN_KIND`, `ADE_PARENT_MACHINE`, Linear
  vars, `PWD`) goes as `shell_environment_policy.set` on thread
  start/resume/fork; native subagents inherit it.
- The pool routes by `threadId`; lines for a new thread wait up to 10 s for its
  owner. Process-wide notices go to every chat; startup warnings replay to late
  joiners.
- Leaving: interrupt, `thread/unsubscribe`, wait for `thread/closed`
  (`thread_unload_delay_secs=0`). The last chat stops the process.
- A crash hits every chat; each resumes on a new process with its next message.
- Off switch: `ADE_CODEX_SHARED_APP_SERVER=0`. One-off processes are never
  shared.

## Compaction per provider

Every harness compacts by itself. DAEX sets its compaction config, renders one
`context_compact` lifecycle, and adds a guarded Claude fallback at 97%.

| Provider | DAEX setting applied as | `/compact` in DAEX |
|---|---|---|
| Claude | SDK `settings.autoCompactWindow`; subagents per `agents` entry | SDK slash command |
| Codex | `model_auto_compact_token_limit` in thread config | `thread/compact/start` |
| OpenCode | `compaction: { buffer, keep }` | `session.command` when listed |
| Pi | `settingsManager.applyOverrides({ compaction })` | `sdk.compact()` |
| Cursor | Compact first only | local `agent.summarize()`; Cloud refuses |
| Copilot | `backgroundCompactionThreshold` | Copilot's own compaction |
| Droid, Muse, ACP | none | sent as a prompt where accepted |

Settings: `ai.compaction.<provider>` (`shared/compactionSettings.ts`):
`atTokens` (`null` = Auto), `subagentAtTokens` (Claude), `reserveTokens`,
`keepRecentTokens`, `idleMode`.

- **Compact first** (`idleMode`) waits out the prompt-cache window
  (`compactFirstIdleMs`) and offers to compact before the next send. Claude
  defaults to `ask`, others to `never`.
- Compaction has no off switch.
- `subagentAtTokens` can only lower a window. Unreplaced built-in subagents get
  DAEX's copy of their definition (`withClaudeSubagentCompactWindow`,
  `shared/claudeBuiltinAgentPrompts.ts`).
- Claude and Codex accounts can override fields (`ProviderInstance.compaction`).
- DAEX never writes `~/.claude/settings.json` and never sets
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.

## Permission modes

Controls are provider-native; the session also carries an abstract
`permissionMode`.

### One source for a configured default

`ai.permissions.providers.*` (`AiProviderPermissions`) is the only per-provider
default (plus `codexSandbox`). `resolveChatConfig` always ends in a concrete
mode, since launches that send nothing (automations, CLI) depend on it.

### Claude

`AgentChatClaudePermissionMode`: `default | auto | plan | acceptEdits |
bypassPermissions`; `auto` uses the SDK's automatic gate. Changes mid-session via
`query.setPermissionMode`.

- Turn telemetry (`claudeTurnUsage.ts`, `extractClaudeResultMetadata`): turn
  total usage plus `cacheWrite1hTokens`, `requestCount` from main-thread
  `message_start`s, `servedModel` from `modelUsage`, `costUsd` list price.
- `done.account.kind` from `system/init.apiKeySource`; cloud routes, keyed
  presets and custom endpoints are `unknown` with `routedAway`.

### Codex

- Approval policy `untrusted | on-request | on-failure | never` (type);
  sandbox `read-only | workspace-write | danger-full-access`;
  `config-toml` defers both to `.codex/config.toml`. Each Codex interface
  accepts a different policy set (`shared/codexApprovalPolicy.ts`); the
  app-server refuses `on-failure`, so it becomes `on-request`.
- **Network** is on in every chat mode (`sandboxPolicy.networkAccess: true`,
  `codexTurnSandboxPolicy`) and in terminal Default/Edit; terminal Plan stays
  offline.
- Kebab-case values are camel-cased at the JSON-RPC boundary.
  `applyCodexEffectiveThreadState` copies what the runtime applied into the
  session; in flag modes the sent policy stays authoritative.
- A chat with no controls and no project setting runs `never` +
  `danger-full-access`.
- **Plan mode** uses the native planning flow; completed `plan` items become
  plan-approval cards. Accepting moves to full access
  (`stageCodexPlanApprovalFollowup`) and emits `session_meta_updated`.
- Server requests: `mcpServer/elicitation/request` → pending input;
  `serverRequest/resolved` clears a card answered elsewhere; full-auto never
  approves an elicitation.
- Telemetry: tokens from `thread/tokenUsage/updated` per thread
  (`codex_token_usage` ledger); subagent usage stays on the subagent card, with
  a rollout read-back when no live counter exists (`codexSubagentUsage.ts`).
  `model/rerouted` sets `servedModel` and posts a notice. `account/read` once
  after `initialized` gives `done.account`.

#### Codex rewind and 0.145 readiness

- Servers ≥ 0.145.0 with a turn id: `thread/fork { threadId, beforeTurnId }`
  (`codexServerSupportsForkBeforeTurn`).
- Older servers or no turn id: `thread/rollback { numTurns: 1 }` (latest only);
  from 0.156 `codexServerSupportsThreadRollback` is false and such a target fails
  clearly.
- File restore uses `git restore --source=<beforeSha> --staged --worktree`;
  created files are removed. Unsafe files go to `skippedFiles` ("Left as they
  are"): `dirty_before_turn`, `other_chat`, `unknown_start_state`. Refused while
  another chat in the worktree is mid-turn.

#### Provider service tiers (Fast Mode)

**Fast is account-gated and off by default:** account setting
`chat.fastModeEnabled` (scope `all`), read by the brain on every create, update,
`/fast` and turn start.

- Every new chat starts Standard; Fast is per chat and never remembered.
- Clients get `fastModeAllowed` (session summary, `chat.getLaunchDefaults`);
  with `false` they hide Fast and point to Settings → Chat → Fast mode.
- Refused, not downgraded: `daex chat create --fast` answers
  `FAST_MODE_DISABLED_MESSAGE` (automations run Standard); a live chat loses
  Fast at its next turn start.
- The chip shows when `modelSupportsFastMode(descriptor)`. A model switch keeps
  Fast only if the new model has a tier (`sessionModelSupportsFastMode`).

| Provider | How Fast is sent |
|---|---|
| Codex | `serviceTier: "fast"` / `"ultrafast"` on every turn and thread start; explicit `null` when off (beats `config.toml`). `/fast` handled inline. |
| Cursor | `fastMode: false` whenever off (the catalog default can be Fast); CLI uses `*-fast` aliases. |
| Claude | `settings.fastMode`; CLI `--settings '{"fastMode":…}'`. Only models advertising `["fast"]`. |
| OpenCode | A models.dev fast mode becomes a `<id>-fast` sibling (`resolveOpenCodeFastEffortSelection`); if no route keeps both effort and Fast, effort wins and the chip says why. |
| Droid | Factory's fast model ids; fast-capable Anthropic rows get the toggle. |

**Ultrafast** (Codex only, per account) rides `fastTier: "ultrafast"` beside
`fastMode`; only Codex `model/list` can grant it. The chip cycles Off → Fast →
Ultrafast where offered. CLI: `-c service_tier="ultrafast"` with
`-c features.fast_mode=true`.

### OpenCode

Agents `ade-plan`, `ade-edit`, `ade-full-auto` and the one-shot `ade-helper`
(`openCodeConfig.ts`); see
[OpenCode integration › Permissions and questions](./opencode-integration.md#permissions-and-questions).
Telemetry: step sums from `step-finish` parts (`openCodeTurnUsage.ts`), cost from
the provider, `servedModel` when the fast sibling served, account upstream from
DAEX's `opencode.db`.

### Pi

Built-ins: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` (and
`powershell` on Windows, granted like `bash`). Chat uses
`piSdkToolPolicyForPermissionMode`; terminals `piToolsForPermissionMode`
(`shared/cliLaunch.ts`).

| Mode | `tools` | Behind an approval card | MCP | `readOnly` |
|---|---|---|---|:-:|
| `plan` | `read`, `grep`, `find`, `ls` | — | off | yes |
| `edit` | + `edit`, `write` | MCP tools | ask | no |
| `full-auto` | + `bash`, `edit`, `write` | — | allow | no |
| `default` (also `auto`, `config-toml`) | + `bash`, `edit`, `write` | `bash`, `edit`, `write`, MCP | ask | no |

- The gate rebuilds `bash`/`edit`/`write` from Pi's factories; a missing factory
  withholds the tool (`ungateableTools`). See [tool-system](tool-system.md#pi-tools).
- `resolvePiExactModel` (`piSdkSelection.ts`) matches provider and id exactly.
  Thinking levels per model (`piSupportedThinkingLevels`); none means Pi's
  default.
- DAEX never writes Pi's settings (`createPiReadOnlySettingsStorage`), except
  letting Pi create its `deviceId` for ChatGPT sign-in.
- `grep`/`find` need `rg`/`fd`; the chat worker drops a tool whose binary is
  missing (`withoutMissingSearchBinaries`).
- `toolPolicyKey` changes restart the worker; MCP servers are not in the key.
- Fork: `SessionManager.createBranchedSession` from a private snapshot of the
  source; the source is never written.
- Account: `createPiAccountReader` (`"turn"` rules in `piSdkAuth.ts`).

#### Pi MCP servers

With `mcp` on, the worker adds `createMcpExtension()`,
`createCodemodeExtension({ models: false })` and `createToolSearchExtension()`.

- Servers: the agent dir's `mcp.json`, a project's `.pi/mcp.json` only when the
  folder is trusted in Pi, and the MCP registry's servers
  (`registryMcpServersForLaunch`, values escaped).
- `piMcpModeFor`: none in plan mode, side chats, strict-MCP chats, the light
  profile or an SDK host's personal chat. Registry read only at worker start.
- When the mode asks, the `ade-mcp-approval` extension routes every `mcp__*` and
  resource call through the `bash` gate; if it fails to load, the chat start
  fails.
- Worker env is an allowlist (`buildPiWorkerEnvironment`). Pi's `/mcp login` is
  not reachable from chat; registry sign-ins bring their header.

### Cursor

- Modes in `shared/cursorModes.ts`; the session keeps a `cursorModeSnapshot`.
- `cursorAvailability`: SDK rows serve chat, CLI rows Work CLI. Before the SDK
  list loads, a start waits up to 3 s then lets the model through (Auto is never
  refused).
- `resolveCursorSdkPolicy` (`cursorSdkPolicy.ts`): hard guards refuse paths
  outside the lane, with read-only exceptions for this lane's
  `~/.cursor/projects/<slug>/` folders and the project's `.ade/attachments`.
  `fullAuto` only partitions the pool; it is not the SDK's `local.force`.
- Hook timeout: the gate entry states `timeout: 86400`, the script denies 15 s
  earlier; an abandoned hook retires the card
  (`agent_chat.cursor_permission_hook_abandoned`).
- **Fork is a replay** (no SDK fork); `providerForkReplaysTranscript` marks it
  and cross-machine fork excludes it.
- **Sending during a turn:** inline via `Run.steer`, local only (Cursor Cloud
  refuses steers; `cursorSessionRunsInCloud`). Interrupt stops, settles and
  sends the message as the next turn ("Interrupt & continue"). Refused steers
  never throw (`tryCursorInlineSteer`): the row moves to queued or is sent as
  its own turn.
- Telemetry: `turnEnded` usage (no per-request figure); a `preCompact` hook in
  `~/.cursor/hooks.json` (`ensureCursorSdkUserHook`, scripts always answer `{}`)
  plus summary messages give compaction; `scheduleCursorDashboardReconcile`
  fills served model and charge later for turns without a hook payload.

#### Model params: local, cloud, and model options

`ModelSelection { id, params }` from `cursorModelSelection.ts`.

- Local sends are best-effort: load the catalog once if needed; without it, run
  without params and post one notice.
- Cloud create accepts only a fully verified selection
  (`verifyExplicitCursorModelSelection`); follow-ups refuse only an unlisted
  model and note what was not applied.
- Model options (`cursorConfigValues`) send only user-set keys the model
  declares; they never override effort or Fast.

### Muse

Muse approval modes map from the ladder (`MUSE_BY_LEVEL`): plan →
`denyUnmatched` (plus DAEX plan guidance), ask → `promptUnmatched`, auto-edit →
`onRequest`, full-auto → `allowAll`.

### The permission ladder

`shared/permissionLadder.ts` maps four levels onto every family so a family
switch keeps the user's level.

| Level | Claude | Codex | OpenCode | Droid | ACP | Cursor | Muse | Copilot |
|---|---|---|---|---|---|---|---|---|
| `plan` | `plan` | `untrusted` + `read-only` | `plan` | `read-only` | `plan` | `ask` | `denyUnmatched` | `plan` |
| `ask` | `default` | `on-request` + `workspace-write` | `edit` | `auto-low` | `default` | `agent` | `promptUnmatched` | `ask` |
| `auto-edit` | `acceptEdits` | — | — | `auto-medium` | `auto-edit` | — | `onRequest` | `auto-edit` |
| `full-auto` | `bypassPermissions` | `never` + `danger-full-access` | `full-auto` | `auto-high` | `yolo` | `full-auto` | `allowAll` | `full-auto` |

- A miss resolves to the nearest **lower** rung (`downgraded: true`). Codex has
  no auto-edit rung (`on-failure` was removed by Codex).
- The ladder only picks where an **unvisited** family starts; exact per-family
  choices are remembered (Droid restores `agi`). Copilot `assisted` reads as
  `auto-edit`.
- New chats: the desktop composer and batch/Linear launchers start on
  `full-auto` (`defaultNativeControls`) unless the lane remembers a config;
  ask-first launches use `askFirstNativeControls`; chats with no controls take
  `resolveChatConfig` (full access when the project sets nothing; Droid lets
  `settings.json` decide). A subagent with no mode inherits its parent.
- **Keep the ladder separate from `AgentChatPermissionMode`** (`plan | default |
  edit | full-auto`, what `daex --permission-mode` and saved sessions speak).
  There `edit` is the cautious tier (Droid `auto-low`). Do not "fix" it; the
  ceiling (`clampGenericPermissionMode`) reads `edit` as `auto-edit`.

### Permission ceiling for agents and spawned chats

An agent never gives a chat more freedom than its own, and a spawned chat
(`orchestrationParentSessionId`) is capped at its parent, in any provider.
`sessionPermissionLevel` reads, `permissionCeilingClamp` /
`permissionFieldsForLevel` write. Unreadable parent/caller = `ask`; unreadable
child (Codex `config-toml`) = above any ceiling.

- `runtimeActor` is stamped by `adeRpcServer` (`stampChatRuntimeActor`) on
  create/update/handoff/headless/launch calls from any non-user caller
  (`{ kind: "cto" }` or `{ kind: "agent", chatSessionId }`); a sent value is
  dropped first.
- Create clamps with one info notice; updates that would exceed the ceiling are
  refused; CLI children (`start_cli_session`, `spawn_agent`, `chat.launchCli`)
  clamp with `clampGenericPermissionMode`.
- Not capped: the CTO (`callerIsTrustedCto`), a person, a caller with no
  `runtimeActor`. A tracked CLI caller takes its terminal's launch permission.
  Callers from another project or machine use `externalChatContext`
  (unrecorded = `ask`).

### Abstract-to-native mapping

`AgentChatPermissionMode` (`default | auto | plan | edit | full-auto |
config-toml`) → native via `permissionMapping.ts`: Claude
`claudePermissionMode`; Codex policy + sandbox; OpenCode
`opencodePermissionMode`; Cursor `cursorModeId` (derived only for `full-auto` and
`plan`, so a derived `agent` is never saved); Droid `droidPermissionMode` or
absent; Pi uses the abstract field directly. The abstract field is saved beside
the native ones.

### Interaction mode

`AgentChatInteractionMode` `default | plan`. Claude plan mode
(`applyClaudePlanModeTransition`, `claudePlanMode.ts`) sets
`claudePermissionMode = "plan"` and saves the old mode in
`claudePrePlanAccessMode`. While in plan, `canUseTool` refuses anything not in
`CLAUDE_PLAN_MODE_ALLOWED_TOOLS` (`claudeToolGate.ts`, a literal allowlist;
unknown and MCP tools refused), except a `Bash` or `PowerShell` call whose
command only reads (`claudeToolCallAllowedInPlanMode`). An approved `ExitPlanMode` returns
`{ behavior: "allow", updatedInput }` and DAEX also calls `setPermissionMode`.
The stale-session auto-approve branch must not be widened.

**Plan still reads, on every provider.** One check, `shellCommandIsReadOnly`
(`readOnlyShellCommand.ts`), decides whether a shell command only reads: known
readers, git and `gh` reads, and DAEX's own reads (`daex linear issue`, `daex prs
show`, `daex help`, any `--help`; the `ade` alias too), joined by pipes or `&&`,
with output only to the null device. Anything else is refused, so a wrong
answer refuses a read rather than letting a write through. Claude applies it in
the `canUseTool` fence; Codex's plan guard accepts a read once when its
programs are only the CLI, `gh` and `cd` (on Windows the sandbox user cannot
open the brain's pipe, so every CLI command must leave the sandbox); Cursor's
plan/ask gets `shell` behind the read-only hook; Pi gets `bash` (and
`powershell` on Windows) behind `withPiReadOnlyShell`; OpenCode and Copilot
answer a plan's shell ask `once` when it reads; Grok, Kimi, Qwen, Devin and
Antigravity allow an `execute` request once when it reads. Droid and Muse keep
their own read-only modes. On Windows a Cursor or OpenCode command must read
under both PowerShell and a POSIX shell (`shellCommandIsReadOnlyOnPlatform`).


## Model selection flow

The renderer resolves a `ModelDescriptor`; `createSession` stores `shortId` as
`model` and the canonical id as `modelId`.

| Provider | Start | Mid-chat switch | Effort |
|---|---|---|---|
| Claude | `buildClaudeQueryOptions` (`resolveClaudeCliModel`) | teardown + new query (`setModel` on a live one) | change resets the query |
| Codex | thread start/resume send model + effort | `thread/settings/update`; `turn/start` sends both every turn | every turn |
| Cursor | `{ id, params }` in the pool key | teardown, deferred to turn end while busy | params every turn |
| OpenCode | model + `variant` every prompt | fresh session with reconstruction context | reported variants only |
| Droid | `modelId` + `reasoningEffort` every turn | teardown | `ultracode` → `xhigh` |
| Pi | exact model, then `setThinkingLevel` | teardown (restart waits for the old worker, `piWorkerExits.ts`) | Pi's levels |
| Copilot | `session.setModel` live | live | live |
| ACP | coordinator after every entry ([acp spec](acp-providers-spec.md#model-and-effort-selection)) | teardown + rejoin | config option |

- Live ACP model reports merge into curated rows
  (`replaceDynamicAcpModelDescriptors`, `resolveAcpModelDescriptor`).
- **Served-model mismatch** (`servedModelMismatch.ts`): spellings, context tiers,
  snapshots and effort variants are the same model; `auto` never counts. Logged
  once per chat and model pair as `agent_chat.served_model_mismatch`.

## Fork from an earlier turn

`handoffSession({ mode: "fork", throughTurnId })` ("Fork from here";
`daex chat fork --through-turn <id>`). `sliceTranscriptThroughTurn` refuses a
turn without `done`. Native cuts: Codex → Codex (`beforeTurnId`), Copilot, Pi →
Pi (`piForkCutBeforePrompt`). Elsewhere (Kimi included) the kept turns replay.
The source chat never changes.

## Machine launch defaults

The model and settings a person last launched are kept per machine in
`<ADE_HOME>/chat-launch-defaults.json` (`chatLaunchDefaults.ts`). Written by a
person's top-level chat creation or settings change; never by `runtimeActor`
calls, subagents, identity chats or automations. Clients read
`chat.getLaunchDefaults` (desktop draft composer, iOS new chat).

## Model switching mid-session

Another model means a handoff: **fork** (Claude → Claude, `forkSession`
through `forkFromSdkSessionId`) or **brief** (any other pair:
`generateHandoffBrief()` over the last 12 messages, fallback
`buildDeterministicHandoffBrief()`).

### Replay budget and the handoff notice

`crossProviderReplayFork.ts`: 3 chars per token, hold back max(32k tokens, 15%
of window), cap at 60%. Dropped turns produce a notice. Claude-only overflow
recovery (`claudeReplayOverflowRecovery.ts`): "prompt is too long" halves the
budget (floor 2,000 chars) and re-sends once on a fresh provider session.

## Auto-title generation

Titles and lane names use one helper model per vendor, so content never crosses
vendors (`shared/backgroundUtilityModel.ts`, `sessionNaming.ts`):

| Chat provider | Model | Runs via |
|---|---|---|
| Claude | `BACKGROUND_UTILITY_CLAUDE_CLI_MODEL` (low) | pinned `claude -p` |
| Codex | `BACKGROUND_UTILITY_CODEX_CLI_MODEL` (low) | pinned `codex exec` |
| Cursor | `BACKGROUND_UTILITY_CURSOR_MODEL_ID` | Cursor SDK pool |
| Copilot, Muse, Qwen, Kimi, Grok, Antigravity | chat's model | each runtime's one-shot mode |
| Droid, Devin, Pi | chat's model | pinned CLI print mode, read-only/no tools |
| OpenCode, API-key, OpenRouter, local | chat's model | `runOpenCodeTextPrompt` |

- `providerTaskRunner.ts` dispatches on `resolveCliProviderForModel`; runners in
  `pinnedCliTaskRunners.ts`. Timeouts SIGTERM then SIGKILL after 1.5 s
  (`taskkill /T /F` on Windows). No runner starts user MCP servers.
- One-shots for Qwen, Kimi, Grok, Droid, Devin, Pi, Antigravity and Copilot are
  text only.
- Helpers run as the chat's own provider account.
- DAEX chats wait ~8 s for a native title, then name a still-default one. Cursor
  Cloud names stay Cursor's. `manuallyNamed: true` stops auto-titles.
  `daex chat generate-names` regenerates.

## One-shot utility tasks

DAEX does not write commit messages, PR text or issues. Every one-off goes
through `runProviderTask`. Cursor one-offs run on the pooled worker
(`runCursorSdkLocalPrompt`) under `CURSOR_SDK_ONESHOT_POLICY` (denies every
tool), capped at `CURSOR_SDK_LOCAL_ONESHOT_MAX_WORKERS`; never `Agent.create` in
the host process.

## CTO vs. regular chat routing

CTO sessions (`identityKey: "cto"`):

1. Identity, notes, open work and project state are rebuilt into the volatile
   turn prefix each send; the static prompt is staged once per provider thread.
2. CTO tools reach the session through `createCtoRuntimeToolMap` (see
   [tool-system](tool-system.md#registration-on-a-live-session)).
3. `normalizeIdentityPermissionMode` pins `full-auto`.
4. The provider thread is disposable: `refreshCtoProviderThread` opens a new
   one at 55% occupancy (`CTO_REFRESH_OCCUPANCY_PCT`), after compaction or
   overflow, on model fallback, or on request.
5. CTO-launched work never runs on the main checkout
   (`resolveCtoExecutionLane`). See
   [CTO](../cto/README.md#where-cto-launched-work-runs).

## Related docs

[Chat README](README.md), [Composer and UI](composer-and-ui.md),
[CTO](../cto/README.md).
