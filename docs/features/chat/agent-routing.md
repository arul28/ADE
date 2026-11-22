# Agent Routing, Permissions, and Model Registry

Every chat resolves to a provider, a model, and a permission mode before
a turn runs. This document describes how those choices are made and
where the machinery lives.

## Source file map

Paths are under `apps/desktop/src/`.

| Path | Role |
|---|---|
| `shared/modelRegistry.ts` | `MODEL_REGISTRY`, `ModelDescriptor`, model defaults and resolution helpers. |
| `shared/modelProfiles.ts` | Curated selection helpers (task routing, default pickers). |
| `shared/chatModelSwitching.ts` | Rules for mid-session model changes. |
| `main/services/chat/agentChatService.ts` | `handoffSession`, permission translation, the inline adapters. |
| `shared/permissionLadder.ts` | The four autonomy levels and their mapping onto every provider; see [The permission ladder](#the-permission-ladder). |
| `main/services/chat/identitySessionPolicy.ts` | The CTO permission pin (`normalizeIdentityPermissionMode`), `isPrimaryPinnedIdentity`, `resolveIdentityExecutionLane`. |
| `main/services/chat/crossProviderReplayFork.ts` | The replay budget constants and derivations, `CODEX_REPLAY_MAX_CHARS`, `CODEX_APP_SERVER_INPUT_MAX_CHARS`, and the fitters (`fitTranscriptReplayToBudget`, `buildFittedTranscriptReplay`). |
| `main/services/chat/claudeReplayOverflowRecovery.ts` | Claude-only replay overflow repair (`createClaudeReplayOverflowRecovery`): `TranscriptReplayOrigin`, `ReplayForkProvenance`, the 2,000-character floor, and `noteConsumedReplay` / `forgetConsumedReplay`, `recoverFromOverflow`, `noteRetrySucceeded`, `reportRetryFailed`. State lives in `WeakMap`s keyed by the runtime. |
| `main/services/chat/providerThreadContinuity.ts` | Which provider thread a chat talks to: `persistedPointerState()` (every provider's thread field, shared with the pointer ledger), `providerThreadRef()` (`"none"` = unknown), `providerThreadContinuityChanged()`, and the `StagedSection` operations that decide whether a static block or the tail rides a turn. See [CTO](../cto/README.md). |
| `main/services/chat/sessionTurnHealth.ts` | Durable turn health as pure functions: `normalizeLastTurnFailure()`, `normalizeSessionContextHealth()`, `shouldAdviseSessionRotation()`, and the `nextSessionTurnHealth()` reducer, which reports a change field by field to avoid needless disk writes. |
| `shared/cursorModes.ts` | Cursor mode vocabulary and the mapping from the legacy permission field. |
| `main/services/chat/cursorModelSelection.ts` | A chat's Cursor effort, Fast/tier and model options as `ModelSelection.params`; see "Model params". |
| `main/services/chat/servedModelMismatch.ts` | `isServedModelMismatch` and `isServedRouteMismatch`. |
| `main/utils/codexComputerUse.ts` | macOS-only signed Codex Computer Use MCP resolver (explicit opt-in, verified client). |
| `shared/cliLaunch.ts` | Tracked CLI start/resume builders (model, reasoning, permission flags, Codex `computer_use` overrides). Tracked OpenCode always runs the root TUI with no `--variant`. |
| `main/services/ai/providerRuntimeHealth.ts` | Provider readiness, auth and network failures for degraded states. |
| `main/services/chat/permissionMapping.ts` | Abstract permission mode to native options (`mapPermissionToClaude`, `mapPermissionToCodex` …). |
| `main/services/ai/apiKeyStore.ts`, `main/services/account/accountVaultBridge.ts` | Encrypted ADE provider keys, account/device provenance, the vault mirror, and the purge on sign-out or account switch. |
| `main/services/shared/providerConfigHomes.ts` | Provider config homes and the config-ownership rule. |
| `main/services/ai/authDetector.ts` | Credential discovery and auth status. |
| `main/services/ai/codexExecutable.ts` / `droidExecutable.ts` | Resolve the pinned Codex and Droid CLIs: env override, (Codex) [fall-forward](../onboarding-and-settings/agent-tools-cache.md#codex-fall-forward), the tools-cache pin, (Codex) a checkout's `node_modules`, the previous pin. Never PATH. Claude uses `claudeCodeExecutable.ts`. See [agent tools cache](../onboarding-and-settings/agent-tools-cache.md#resolution-order). |
| `main/services/ai/tools/systemPrompt.ts` | The system prompt per mode and permission mode, with native-subagent versus ADE-child guidance. |
| `main/services/chat/openCodeTurnUsage.ts`, `codexSubagentUsage.ts`, `providerUsageAccount.ts` | Turn telemetry for OpenCode (step sums, live samples, account), Codex subagents (usage split, rollout read-back), and the Claude and Codex account kind. |
| `main/services/chat/droidSdkPool.ts`, `droidSdkWorker.ts`, `droidSdkProtocol.ts`, `droidSdkEventMapper.ts` | Droid adapter: one forked worker per session over a JSON-line protocol; screenshots as paths (`workerAttachmentImages.ts`); the mapper keeps streaming ids, tool names, usage, live context, compaction and mission-worker usage. |
| `main/services/chat/piSdkPool.ts`, `piSdkWorker.ts`, `piSdkProtocol.ts`, `piSdkEventMapper.ts`, `piSdkSelection.ts` | Pi adapter: the pool forks a worker per session key; protocol version 2 carries the `ui_*` and `login` frames, validated both ways; the mapper owns the card helpers (`piUiRequestToPendingInput`, `piUiResponseFromAnswer`, `piUiNoticeToChatEvents`, `piExtensionLoadNotice`); `piSdkSelection` applies model and thinking level exactly. |
| `main/services/chat/piSdkUiBridge.ts` | Worker-side UI channel with no Pi imports: one never-rejecting `request()` for `AuthInteraction`, tool `execute` and `ExtensionUIContext` (`null` on dismiss, abort or dispose); `ask_user`, the approval gate and the extension UI context. |
| `main/services/ai/piInstallation.ts` | Resolves the pinned Pi (`ADE_PI_PACKAGE_ROOT` override): CLI path (Node >= 22.19), SDK entry, agent dir, profile files, inventory, and a `blocker` (`PI_SDK_MIN_NODE`). `sdkAvailable` and `cliAvailable` are independent. |
| `main/services/ai/piAuthService.ts` | In-app Pi sign-in: `listPiLoginProviders`, `startPiLogin`, `addPiAuthStatusListener`, `submitPiLoginPrompt`, `cancelPiLogin`; 10-minute bound; never touches a credential. |
| `main/services/chat/droidModelsDiscovery.ts` | Droid models from the pinned `droid` CLI once downloaded, plus custom models from `<factoryConfigHome>/config.json`, as `droid/<id>` descriptors. Fast choices are separate ids. Stale-while-revalidate: `markDroidModelCachesStale` ages rows, served up to ~6 h while one background warm per window refreshes them. |

## Supported providers

`AgentChatProvider` is `"codex" | "claude" | "cursor" | "droid" | "opencode" | "pi" | (string & {})`.
The open branch lets local discovery add provider keys for vendored runtimes.
The ACP providers (Muse, Qwen, Kimi, Grok, Antigravity) are described in
[acp-providers-spec.md](acp-providers-spec.md) and
[antigravity-provider.md](antigravity-provider.md).

| Provider | Runtime | Adapter location |
|---|---|---|
| `claude` | `@anthropic-ai/claude-agent-sdk` `query()` stream with an ADE input pump, `startup()` warmup, ADE's pinned Claude Code binary (with the [fall-forward](../onboarding-and-settings/agent-tools-cache.md#claude-fall-forward) override when Anthropic refuses the pin), SDK sessions, hooks, output styles, plugins, context usage, rewind and slash commands. | `agentChatService.ts` (inline). |
| `codex` | Pinned `@openai/codex` 0.167.0 `codex app-server`, JSON-RPC, shared by every chat whose process would launch the same way (see [One app-server for many Codex chats](#one-app-server-for-many-codex-chats)). Spawn failures are error events. | `agentChatService.ts`; `codexAppServerPool.ts`; `services/ai/codexExecutable.ts`. |
| `opencode` | OpenCode server runtime; catalog from OpenCode/Models.dev, with OAuth, API-key, custom and local-server paths. | `agentChatService.ts`; `openCodeInventory.ts`; `openCodeAuthService.ts`. |
| `cursor` | `@cursor/sdk` in a Node worker pool. ADE owns permissions, hooks and the system prompt; the SDK owns model and tools. Slash commands from `.cursor/commands/`, `.cursor/agents/`, built-in subagents and Agent Skill roots. A local turn silent for 90 s raises "Cursor hasn't answered" (Restart / Keep waiting), and a transport error before any event recycles and re-sends once — see [Cursor thread recycling](README.md#cursor-thread-recycling-and-the-first-event-watchdog). | `cursorSdkPool.ts`, `cursorSdkWorker.ts`, `cursorSdkProtocol.ts`, `cursorSdkPolicy.ts`, `cursorSdkSystemPrompt.ts`, `cursorSdkEventMapper.ts`, `cursorSdkErrors.ts`, `cursorSlashCommandDiscovery.ts`. |
| `copilot` | ADE's pinned Copilot runtime through `@github/copilot-sdk` over stdio, one forked worker per chat (keyed by CLI path, `COPILOT_HOME` and env). Models from `client.listModels()`. Five permission levels. Utility tasks never start a user MCP server. | `copilotSdkPool.ts`, `copilotSdkWorker.ts`, `copilotSdkProtocol.ts`, `copilotSdkEventMapper.ts`, `copilotModelsDiscovery.ts`, `ai/copilotSdkLoader.ts`. See [copilot-sdk-provider.md](copilot-sdk-provider.md). |
| `devin` | ADE's pinned `devin` CLI as `devin acp` over the ACP host; Devin Cloud uses `devin acp --cloud` through the cloud agents service. The same id covers the tracked `devin` CLI. | `acpHost/acpDialects/devin.ts`, `devinCloud.ts`; `cloudAgentsService.ts`, `devinCloudDirectory.ts`. |
| `droid` | Factory Droid models as `droid/<modelId>` descriptors through `@factory/droid-sdk` in a forked worker pool. Reports turn tokens, live context, compaction and Factory account; mission-worker usage comes from the worker's settings file. | `droidSdkPool.ts`, `droidSdkWorker.ts`, `droidSdkProtocol.ts`, `droidSdkEventMapper.ts`, `droidModelsDiscovery.ts`. |
| `pi` | ADE's pinned Pi package, loaded as a library in a forked worker (never a static import). The worker owns the session, model runtime, tools and sign-in; ADE owns the cards. | `piSdkPool.ts`, `piSdkWorker.ts`, `piSdkProtocol.ts`, `piSdkEventMapper.ts`, `piSdkUiBridge.ts`, `piSdkEnvironment.ts`; `piSessionStore.ts`, `piSessionLease.ts`, `piSessionOwnership.ts`; `ai/piInstallation.ts`, `ai/piAuthService.ts`. |

## Model registry

`MODEL_REGISTRY` (`shared/modelRegistry.ts`) is a static list of
`ModelDescriptor` records: `id`, `shortId`, `aliases`, `displayName`,
`family`, `authTypes`, `contextWindow`, `maxOutputTokens`, `capabilities`,
`reasoningTiers`, `defaultReasoningEffort`, `serviceTiers` (`"fast"`, and
`"ultrafast"` from a Codex catalog), `color`, `providerRoute`,
`providerModelId`, `cliCommand`, `isCliWrapped`, `deprecated`, prices,
`costTier`, and for local models `harnessProfile`, `discoverySource`,
`openCodeProviderId`, `openCodeModelId`.

Helpers:

- `getModelById(id)`, `resolveModelAlias(alias)` (aliases and retired ids).
- `shorthandModelNameRefusal(ref)`: requests through `run_ade_action`,
  `start_cli_session` and `spawn_agent` must name a model by its full name,
  registry id or wire id. Short names, old spellings and retired ids are
  refused with the full name to use. Saved chats, presets and automation
  rules still resolve aliases.
- `getDefaultModelDescriptor()`, `resolveModelDescriptorForProvider`,
  `resolveChatProviderForDescriptor`, `resolveProviderGroupForModel`
  (handoff groups), `getAvailableModels(opts)`,
  `getDynamicOpenCodeModelDescriptors()` / `listModelDescriptorsForProvider`.
- `selectSupportedReasoningEffort()`: keep a valid explicit effort, then the
  model's default, then a valid surface fallback, then Medium or the first
  tier. Every launch surface and handoff uses it; iOS mirrors it.

`localModelDiscovery.ts` adds LM Studio and Ollama models at runtime with
`discoverySource` and `harnessProfile: "guarded"` unless whitelisted.

### Model manifest (models without a release)

`shared/model-manifest.json` changes the model list without a build. It is
bundled and applied when the registry loads, then
`main/services/ai/modelManifestService.ts` fetches it from
`raw.githubusercontent.com/arul28/ADE/main/apps/desktop/src/shared/model-manifest.json`,
so a merge to `main` reaches running installs in minutes.

- **What it can do** (`shared/modelManifest.ts`): add a model (all required
  fields, optional `after` anchor), patch whitelisted fields of a row (price,
  context, aliases, efforts, `deprecated: true`), and set the app default
  (`defaults.app`), provider defaults (`defaults.providers`) and the free
  models a computer with nothing signed in starts on, in order
  (`defaults.free`, see [Free models](composer-and-ui.md#free-models)). One invalid
  field rejects the file; an id or alias collision rolls back to the previous
  manifest.
- **Trust boundary.** The file is unsigned, so it can use only values ADE
  already runs: routes are an allowlist (`MODEL_MANIFEST_ROUTE_CLI`, each
  launching only its own CLI), and so are families, auth types, efforts and
  service tiers; ids match a strict pattern; colors are `#RRGGBB`. Routing
  fields can be set only on a model the manifest adds.
- **Version gating:** `minAdeVersion` / `maxAdeVersionExclusive` per entry,
  for a model that needs new code. Dev, prerelease and unknown versions see
  every entry.
- **Freshness:** the GitHub copy, then the last good copy in
  `~/.ade/model-manifest.json`, then the bundled copy; a copy older than the
  bundled one is ignored, so bump `updatedAt`. It polls every 10 minutes with
  `If-None-Match`, re-checks on a catalog read after 3 minutes, and backs off
  5 minutes on failure. Nothing waits on the network.
- **Who runs it:** desktop main and the agent brain. One-shot CLI commands use
  the bundled or disk copy.
- **Propagation:** an applied manifest marks the catalog stale. Every catalog
  response carries `modelManifest`, which pickers adopt when newer
  (`adoptHostModelManifest`). iOS reads the host catalog.
- **Defaults:** `getAppDefaultModelDescriptor()` when nothing names a provider;
  `getDefaultModelDescriptor(provider)` checks the manifest first. Both read
  on use.
- **Adding a model:** add it to the manifest first, then to `MODEL_REGISTRY`
  in a later release if code depends on it. Check the wire id against the
  real runtime (`codex exec -m <id>` / `claude -p --model <id>`).

### Reasoning tiers (Claude)

The quick-pick vocabulary is `low | medium | high | max`
(`CLAUDE_THINKING_LEVELS`); each descriptor advertises its own ladder, and the
tier string goes to the CLI or SDK as is.

| Model | Provider id | Default effort | Efforts | Fast |
|---|---|---|---|---|
| Fable 5.2 | `claude-fable-5-2` | `medium` | low, medium, high, xhigh, max, ultracode | yes |
| Opus 5.5 (Claude and app default) | `claude-opus-5-5` | `medium` | low, medium, high, xhigh, max | yes |
| Sonnet 5.5 | `claude-sonnet-5-5` | `high` | low, medium, high, xhigh, max | no |
| Haiku 5.5 | | `medium` | low, medium, high, xhigh, max | |
| Fable 5.1 | `claude-fable-5-1` | `high` | low, medium, high, xhigh, max, ultracode | yes |
| Sonnet 5 | `claude-sonnet-5` | | low, medium, high, max | |
| Opus 5 | `claude-opus-5` | `high` | low, medium, high, xhigh, max | yes |

- The picker order is the table order. Claude and Codex do not hoist their
  default to the front of `listModelDescriptorsForProvider`.
- Fable 5.2 costs $8 / $40 per million input / output tokens and has no short
  aliases. Mythos 5.2 is not listed.
- `opus` selects Opus 5.5; `sonnet` selects Sonnet 5.5.
- Retired ids resolve forward: Haiku 4.5 on the Claude route → Haiku 5.5
  (OpenCode, Droid and Copilot keep their own Haiku rows); Sonnet 4.6 →
  Sonnet 5; Opus 4.8, Opus 4.7 and `opus[1m]` / `opus-1m` → Opus 5; Fable 5 →
  Fable 5.1.

### Codex models

The OpenAI section follows the Codex catalog's order:

| Model | Context | Default effort | Price | Alias |
|---|---|---|---|---|
| `gpt-6.1-sol` (default) | 1,050,000 | `low` | $2/$10 | `sol` |
| `gpt-6-astra` | 1,050,000 | `low` | | |
| `gpt-6.1-terra` | 1,050,000 | `low` | $1/$5 | `terra` |
| `gpt-6-sol` | 1,050,000 | `medium` | $2/$10 | |
| `gpt-6-luna` | 1,050,000 | `medium` | $0.10/$0.50 | `luna` |
| `gpt-5.6-sol` | 372k | `low` | | |
| `gpt-5.6-luna` | 372k | `medium` | | |
| `gpt-5.5` (legacy) | | | | |

- The Lunas expose `low`–`max`; Astra, the Sols and Terra add `ultra`, the
  multi-agent tier, with a usage warning. Labels: Light, Medium, High, Extra
  High, Max, Ultra.
- The picker shows only rows the app server's `model/list` reports for the
  signed-in account, so a new model appears on the next catalog refresh.
- GPT-5.4, GPT-5.4-Mini, GPT-5.3-Codex, GPT-5.3-Codex-Spark, GPT-5.2 and
  GPT-5.6 Terra are `deprecated`: saved chats resolve, no picker offers them.

**Codex thread behavior.**

- A resumed thread reports its `collaborationMode`, which ADE adopts as the
  chat's mode, except while `codexPendingCollaborationMode` (saved) holds a
  mode the thread has not run under yet; the first `turn/start` with that mode
  clears it.
- `/personality` is not offered for Codex.
- ADE always enables `tools.update_plan` on `thread/start` and
  `thread/resume`, copies the thread's `model` / `reasoningEffort` into the
  session, and treats `item/tool/requestUserInput` with `isBlocking: false` as
  live steering.
- The Computer Use MCP server is added on macOS only, and not when a host
  `permissionPolicy` refuses it without naming one of its tools. A failed
  start shows in `turn_diagnostics`.
- Plus/Team chats get one quiet `Approaching Codex plan limit` notice per
  runtime at 50% of the five-hour window.
- Settings lists installed Codex plugins (`plugin/reconcile` +
  `plugin/list`), read-only. `plugin/list` fails open only for `-32601`.

## Auth and credentials

`authDetector.ts` (`detectAllAuth`) probes every provider:

- `installed` / `path` come from each provider's pinned resolver, never PATH.
  Sign-in comes from the provider's own files, keychain or a probe. Disk-only
  sign-ins (Copilot, ACP) are read before the download. The cache is keyed on
  `pinnedToolInstallGeneration()`.
- Cursor chat signs in through the SDK. ADE also probes its pinned Cursor CLI
  (`cursor-cli`, with `--disable-auto-update` and
  `CURSOR_INVOKED_AS=cursor-agent`) for CLI-launch models once it is
  downloaded, and merges them with the SDK registry. Discovery accepts JSON
  arrays, `{ models: [...] }` and the CLI table.
- API-key providers check `apiKeyStore.ts`, then the env vars. ADE keys are
  account-owned (`provider_api_key` in the account vault) or device-only;
  provenance decides what hydrates and what is purged on an account change.
- OAuth providers use `services/lanes/oauthRedirectService.ts`. Local
  providers (`ollama`, `lmstudio`) probe their endpoint.

OpenCode's Settings catalog comes from the live server's `provider.list()`.
ADE passes on only each provider's credential env-var names and a non-secret
source marker, never its `key`. An env-backed credential gets an API-key
editor but no disconnect. OAuth goes through `integration.list` / `.get` /
`.oauth.*`; API keys through `integration.connect.key` and
`credential.remove`, then ADE's key store. Verify shows only for providers
with a native verifier.

Results feed `AiProviderConnectionStatus` / `AiRuntimeConnectionStatus`
(`providerConnectionStatus.ts`). The account vault is not a provider config
home: the brain owns the account refresh, and env vars, provider CLI stores
and Pi's `auth.json` stay local.

### Pi sign-in

`piAuthService.ts` drives Pi's `ModelRuntime.login(providerId, authType,
interaction)` on an inventory-only worker; Settings → Providers renders what
Pi asks for (an auth URL, a device code, a text or secret field, a choice).
Pi has two login types, `oauth` and `api_key`.

- **ADE never holds the credential.** The worker sends prompt text only, the
  answer goes back through `respondToUi`, and Pi's `AuthStorage` writes
  `auth.json`. `registerIpc.ts` redacts the `value` of `ade.ai.piLoginSubmit`.
- Only providers with an interactive login are offered. One flow runs per
  provider; a new start supersedes the old one.
- A loopback `baseUrl` makes a provider `local`, not a sign-in
  (`piInstallation.ts`, `AiPiProviderStatus.baseUrl`), because LM Studio ships
  a placeholder `apiKey`. A stored auth entry still wins.
- A success invalidates the readiness caches (logs
  `ai.pi_auth_cache_invalidation_failed` on failure).
- The outcome travels on the `piAuthStatus` `success` / `error` event. Leaving
  Settings cancels nothing; the ten-minute bound reclaims an abandoned flow.
  **Cancel** waits `PI_LOGIN_CANCEL_GRACE_MS` for a login that already
  finished. Auth URLs open automatically, with the URL and code on screen.
- ADE does not drive Pi's terminal `/login`; with `sdkAvailable` false the
  card gives the instruction.

### Session store

SDK chat, tracked Pi CLI terminals and external-session discovery share one
native store (`piSessionStoreForEnvironment`): `--session-dir`, then
`PI_CODING_AGENT_SESSION_DIR`, then the profile's `settings.json`
`sessionDir`, then `<agentDir>/sessions`.

- A checkout's `.pi/settings.json` is never read, so a cloned repository
  cannot redirect where ADE authorizes sessions. Pi's own CLI does read it;
  `repositoryOverridesPiSessionDir` makes the launch say so.
- The worker gets the root as `sessionRoot` (an authorization boundary) and
  `sessionStorageDir` only when the user set one, because Pi nests one folder
  per working directory only when told nothing.
- Pi writes a new session's JSONL only at the first assistant message.
  `classifyPiSessionFile` answers `pending` for such a path in the store, and
  the chat leases that exact path at once. Discovery scopes by containment;
  ownership needs the header cwd to match exactly
  (`selectPiStorageSessionCandidate`).
- **`<session>.ade-lease`** (`piSessionLease.ts`): who is writing now. A lock
  keyed to the writer's pid and start time, `owner: "sdk" | "cli"`, removed on
  release, reclaimable when the process is gone. `piSessionLeaseIsHeld` lets a
  launch skip a held session.
- **`<session>.ade-owner`** (`piSessionOwnership.ts`): whose session it is. A
  durable `{ owner, ownerSessionId }` claim, never removed. An unclaimed
  session stays adoptable. `ownerSessionId` is the ADE chat or terminal id.
- Before Pi writes, a tracked CLI launch holds
  `piSessionCreationLeaseTarget(sessionRoot, cwd)`, a token per working
  directory, so one lane's starting chat never blocks another's.

## Provider config ownership

ADE hands its settings to every provider SDK at the **highest precedence tier
that SDK offers**, above the user's own config. So every adapter follows one
rule:

> Name a config key only when ADE owns it: there is ADE UI for it and ADE's
> value is the truth. Otherwise leave the key absent and let the provider's
> own precedence resolve it.

Absence is the only way to say nothing; a substituted default is a real value
that wins. The rule and its probe results live in
`main/services/shared/providerConfigHomes.ts`. **A new provider starts here.**
Each row was checked against a live runtime:

| Provider | Where ADE's settings land | Omitting a key | Explicit `null` / `false` |
|---|---|---|---|
| Claude | Agent SDK `settings` (flag tier, above every `settings.json`) | the user's settings chain applies | `"Default"` is a real output style |
| Codex | `thread/start` + `turn/start` args | `config.toml`'s value applies | `null` reports `"default"`, a real downgrade |
| Droid | `createSession` / `updateSettings` options | `~/.factory/settings.json` applies, per key | `null` wedges the Droid RPC for 30 s; never send it |
| Cursor | `local.sandboxOptions` | `~/.cursor/sandbox.json` decides | `false` gives `insecure_none` without reading that file; ADE always sends `false` |
| OpenCode | `OPENCODE_CONFIG` (a generated, hot-reloaded file) | the user's `opencode.json` loads underneath | n/a: a project's own `opencode.json` can override any key ADE names |

### Provider config homes

Each CLI has an env override for its config home, and the shapes differ:

| Helper | Env override | Shape | Default |
|---|---|---|---|
| `claudeConfigHome()` | `CLAUDE_CONFIG_DIR` | the config **directory** | `~/.claude` |
| `codexConfigHome()` | `CODEX_HOME` | the config **directory** | `~/.codex` |
| `factoryConfigHome()` | `FACTORY_HOME_OVERRIDE` | the **HOME** `.factory` is appended to | `~/.factory` |

Every path into a provider config home goes through these helpers (chat
adapters, `droidModelsDiscovery.ts`, `ptyService.ts` recovery,
`providerSessionHandles.ts`, `discoverDroid.ts`); a hardcoded path makes ADE
read a different folder than the process it spawns.

### What each adapter states

**Claude.**

- ADE sends `enabledPlugins` (merged per key) and `fastMode` (the Fast chip).
  `outputStyle` only when a settings file names one; `workflowSizeGuideline:
  "medium"` only when none states one.
- `readClaudeOutputStyleSelection` / `readClaudeWorkflowSizeGuideline`
  (`claudeOutputStyles.ts`) resolve a key in the SDK's own order
  (`settingSources: ["user", "project", "local"]`: lane `settings.local.json`,
  lane `settings.json`, each ancestor root, the user root) and return `null`
  when no file declares it. The session's cached value is read after the
  files, so a fallback never becomes a saved choice.
- The walk honours `CLAUDE_CONFIG_DIR`, as does the plugin registry. When it
  moved the user tier, the real `~/.claude` is skipped from the ancestor walk.
  Roots compare through `pathKey` / `pathsEqual` (Windows spellings).
- ADE states no prompt cache TTL of its own. An account's Settings choice sets
  `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` / `CLAUDE_CODE_PROMPT_CACHE_TTL`
  (`claudeAccountPromptCacheEnv`) for its SDK chats and terminal `claude`
  sessions (`ptyService.create`), except where the env already states one or
  the launch uses a preset or stored credential.

**Codex.**

- Service tier only when Fast is on (`"fast"`, or `"ultrafast"`; see Fast
  Mode). `fastMode` is saved only when true.
- Reasoning effort goes **per thread** (`codexThreadConfigArgs`), never as
  `-c model_reasoning_effort=…` on the process, which would outrank
  `config.toml` and apply to every thread. The same holds for the compaction
  point and the chat identity.

#### One app-server for many Codex chats

Chats share one `codex app-server` when it would launch the same way (build,
account, preset, skill roots, notification opt-outs, env).
`codexAppServerPool.ts` owns the process and transport; each chat keeps its own
`CodexRuntime`. An extra process costs ~90 MB plus a code-mode host; an extra
thread ~10 MB
([numbers](../../perf/macos-baseline.md#codex-chats-app-server-processes)).

- **Identity per thread.** The chat's env (`ADE_CHAT_SESSION_ID`,
  `ADE_LANE_ID`, `ADE_WORKSPACE_ROOT`, `ADE_PARENT_CHAT_SESSION_ID`,
  `ADE_SPAWN_KIND`, `ADE_PARENT_MACHINE`, the Linear vars, `PWD`) leaves the
  process env and goes as `shell_environment_policy.set` on `thread/start`,
  `thread/resume` and `thread/fork`. Native subagents inherit it. Each
  thread's `cwd` decides where commands run and which project config applies.
- **Routing.** The pool delivers each notification and request by `threadId`.
  Lines for a new thread wait up to 10 s for its owner to record the id.
  Process-wide notifications go to every chat; startup `configWarning` /
  `deprecationNotice` replay to a chat that joins later.
- **Leaving.** A chat that tears down interrupts its turn and
  `thread/unsubscribe`s its threads; with `thread_unload_delay_secs=0` Codex
  unloads at once and says `thread/closed`, which the next runtime waits for.
  The last chat stops the process. No unsubscribe answer in 10 s stops it.
- **Crashes.** Every chat on the process gets the exit and resumes on a new
  process with its next message.
- **Off switch:** `ADE_CODEX_SHARED_APP_SERVER=0`. One-off processes (model
  list, import cleanup, `codexEphemeralFork.ts`) are never shared.

**Droid.**

- `resolveSessionDroidPermissionModeOrNull` returns the chosen mode or `null`;
  with `null`, `autonomyLevel` / `interactionMode` are omitted and resolve
  from `~/.factory/settings.json`. Droid's own default is read-only, so a
  substituted fallback would grant write access.
  `normalizeSessionNativePermissionControls` deletes the field. `cliLaunch`
  rejects `config-toml` for Droid.
- Spec pairs with `autonomyLevel: "off"`, as `droidSettingsJson` does for
  terminals. The worker tracks whether ADE entered Spec (`enteredSpecMode`)
  and calls `exitSpecMode()` once to leave.
- **Effort.** `reasoningEffort` is not nullable in `update_session_settings`,
  so an update without it keeps the last effort. The worker tracks what it
  stated (`statedEffort`); when the chat clears it, the next update restates
  the model's catalog `defaultReasoningEffort`
  (`resolveDroidReasoningEffortUpdate`), retrying on the next update when that
  cannot be read. A model switch passes the stated effort to the next worker
  (`statedReasoningEffort`); after an app restart a resumed session keeps its
  effort until the chat states one.
- `buildReady` reads `session.settings.modelId` and `session.id`;
  `DroidSdkReady.availableModels` stays empty (`droidModelsDiscovery` owns the
  list).
- **Usage.** `token_usage_update` is cumulative for the turn, so ADE keeps the
  latest; `thinkingTokens` becomes `reasoningTokens`. After each turn and
  around `compacting_conversation`, the worker reads `getContextStats()`
  without waiting; each sample posts later as `context_stats` →
  `context_usage` (`origin: "live"`) stamped with its `turnId`. So `done`
  carries no context figures, a sample is never the next turn's dispatch
  acknowledgement, and the compaction-start sample gives `preTokens`. A
  mission worker's usage comes from its `<workerSessionId>.settings.json`
  within 500 ms, marked derived.

**Cursor.** Local workers always get `sandboxOptions: { enabled: false }`
(`cursorSdkWorker.ts`); ADE's hook denials are the permission guard.

**OpenCode.**

- `buildOpenCodeConfig` writes `OPENCODE_CONFIG`, over the global
  `opencode.json` and under project files. ADE states `share: "disabled"` and
  `update: "disable"` (ADE pins the binary); the env also sets
  `OPENCODE_DISABLE_AUTOUPDATE=1`.
- Local blocks (`ollama`, `lmstudio`) only when the user set an endpoint or ADE
  found models; an invented `baseURL` would override the user's own. Only
  `ollama` needs `npm` stated.
- ADE's four agent profiles are `hidden: true`, so they never appear in
  Tab-cycle or `@`. `ade-helper` uses `steps: 1`.
- ADE's system prompt rides the request's `system` field every turn, never a
  `synthetic`/`ignored` part (OpenCode drops `ignored` parts).
- Re-attach: only a confirmed 404 on `session.get` (`isOpenCodeNotFoundError`)
  makes a new session; other errors show.

## Compaction per provider

Every harness compacts by itself. ADE sets each harness's own compaction
config, renders one `context_compact` lifecycle, and adds a guarded Claude
fallback at 97%.

| Provider | Compacts by itself | ADE setting applied as | `/compact` in ADE | Context window source |
|---|---|---|---|---|
| Claude | Yes (per-model `auto` window) | SDK `settings.autoCompactWindow` (100k–1M); subagents get it on each `agents` entry | Passed to the SDK as a slash command | `modelUsage[].contextWindow`, else the registry; `getContextUsage().raw_max_tokens` is the window and `autoCompactThreshold` the point (33,000 below) |
| Codex | Yes | `model_auto_compact_token_limit=<n>` in the thread config, capped at the window | `thread/compact/start`; no custom instructions, and ADE says so | `thread/tokenUsage/updated` `modelContextWindow`; occupancy is `last` only |
| OpenCode | Yes | `compaction: { buffer, keep: { tokens } }` | `session.command` when the server lists `compact` | `min(models.dev limit.context, ADE registry)` |
| Pi | Yes | `settingsManager.applyOverrides({ compaction: { reserveTokens, keepRecentTokens } })` | `sdk.compact()` | SDK `context_usage` |
| Cursor | Yes | Compact first only | Local: `agent.summarize()` as a normal turn; custom instructions ignored with a notice. Cursor Cloud refuses it. | The SDK's window or the preCompact hook's `context_window_size` |
| Droid, ACP agents | Varies | None | Sent as a prompt where accepted | `contextStats.limit` / `usage_update` |

Settings live in `ai.compaction.<provider>` (`shared/compactionSettings.ts`):
`atTokens` (`null` = Auto), `subagentAtTokens` (Claude), `reserveTokens`,
`keepRecentTokens`, `idleMode`.

- **Compact first** (`idleMode`): Claude, Codex, Pi, OpenCode and local Cursor
  wait out their prompt-cache window (`compactFirstIdleMs`: Claude's measured
  5m/1h, OpenAI's 30m, or the model vendor's) and then offer to compact
  before the next send. Claude defaults to `ask`, the others to `never`. Only
  Claude has the warm timer.
- Compaction has no off switch; a saved `enabled: false` is dropped on read.
- `subagentAtTokens` can only lower a subagent's window, so Settings says "No
  effect" at or above `atTokens`. Built-ins the chat does not replace
  (Explore, Plan, general-purpose) get ADE's copy of their definition
  (`withClaudeSubagentCompactWindow`, `shared/claudeBuiltinAgentPrompts.ts`):
  the main model for Explore and Plan (Explore capped at Opus under Fable or
  Mythos), the default subagent model for general-purpose, no CLAUDE.md for
  Explore and Plan. On Windows before Claude reports its shell, the built-ins
  are left to Claude.
- Claude and Codex accounts can override fields
  (`ProviderInstance.compaction`). A change restarts an idle Claude or Codex
  runtime.
- ADE never writes `~/.claude/settings.json` and never sets
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.

## Permission modes

Permission controls are provider-native. The session carries an abstract
`permissionMode` beside the native fields.

### One source for a configured default

`ai.permissions.providers.*` (`AiProviderPermissions`) is the only
per-provider permission source: one `AgentChatPermissionMode` per provider key
(and per ACP provider), plus `codexSandbox`. `resolveChatConfig` reads it per
provider, and every branch ends in a concrete mode, because a launch that
sends nothing (an automation, a CLI start) depends on it. The `ai.chat.*`
permission keys have no writer and are not read.

### Claude

`AgentChatClaudePermissionMode`:

| Mode | Behavior |
|---|---|
| `default` | Claude CLI built-in permission flow. |
| `plan` | Read-only. |
| `acceptEdits` | Writes allowed; shell needs approval. |
| `bypassPermissions` | Proceeds without asking. |

The mode changes mid-session through `query.setPermissionMode(...)`.

#### Claude turn telemetry

- `done.usage` is the SDK result's turn-total `usage`, plus
  `cacheWrite1hTokens` (`extractClaudeResultMetadata`). At turn end it sets
  the session's `promptCache` (`claudePromptCacheTtlOfWrites`), which times
  the cache countdown and Compact first.
- `done.servedModel` is set when `modelUsage` names another model than asked
  (its only key, or the key with the most output tokens; a tie names none).
  Aliases resolve first.
- `claudeTurnUsage.ts` counts each main-thread `message_start` as a request
  (subagent events have `parent_tool_use_id`): `requestCount`,
  `contextTokens` (the last request's input side), `contextWindow` (from
  `modelUsage`). `costUsd` is `total_cost_usd` with `costSource:
  "list_price"`. The idle reader clears these after each idle `done`.
- `done.account` is `{ provider: "claude", kind, instanceId, email?, plan? }`.
  `kind` from `system/init.apiKeySource`: `ANTHROPIC_API_KEY`, `apiKeyHelper`
  or `/login managed key` is `api_key`; `none` on the first-party route is
  `subscription`. A cloud route, a keyed preset or endpoint, or
  `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` is `unknown`, with
  `routedAway` `"cloud"`, `"preset"` or `"endpoint"`; the router's burn-rate
  learner skips such turns. Codex keyed presets carry `routedAway: "preset"`
  unless the ChatGPT login paid. Before `init`, a signed-in instance counts as
  `subscription`. Email and plan come from `ProviderInstance.account` on a
  subscription turn only, cached for a minute.

### Codex

- `AgentChatCodexApprovalPolicy`: `untrusted | on-request | on-failure | never`.
- `AgentChatCodexSandbox`: `read-only | workspace-write | danger-full-access`.
- `AgentChatCodexConfigSource`: `flags | config-toml` (`config-toml` defers
  both to `.codex/config.toml`).

**Network.** Codex commands reach the network in every chat mode and in a
terminal's Default and Edit. Each chat turn sends `sandboxPolicy: { type,
networkAccess: true }` (`codexTurnSandboxPolicy`). A terminal gets
`-c sandbox_workspace_write.network_access=true` for `workspace-write`
(`codexSandboxCliArgs`). Plan in a terminal stays offline `--sandbox
read-only`, because its only network switch is a custom profile that a
managed Codex policy may replace with a writable default. `config-toml` leaves
both to the person's config.

**Wire format.** ADE's kebab-case values become `onRequest`, `unlessTrusted`,
`onFailure`, `workspaceWrite` at the JSON-RPC boundary. `thread/start` and
`thread/resume` pass `{ model, cwd, config: { model_reasoning_effort,
mcp_servers? }, ...codexPolicyArgs, ...codexServiceTierArgs(session) }`.

- `applyCodexEffectiveThreadState` normalizes the returned `approvalPolicy`,
  `sandbox` (with the camel-case aliases) and `reasoningEffort` into the
  session, so the chips show what the runtime applied.
- In flag modes, the policy sent with `thread/resume` stays authoritative when
  the response echoes an older one. With `config-toml`, ADE sends no policy.
- Turns use `effort` (`turn/start({ threadId, input, effort?, serviceTier? })`).

**Server requests.** `currentTime/read` answers `{ currentTimeAt: <Unix
seconds> }`. `mcpServer/elicitation/request` becomes the pending-input UI (form
and URL modes, values coerced to the schema). `serverRequest/resolved` clears
a card resolved elsewhere. Full-auto never approves a Codex elicitation, and
`Always allow` is sent only when `_meta` permits it. Decoding tolerates the
`emittedAtMs` field.

**Versions.** `parseCodexServerVersion` reads the `initialize` `userAgent`
into `runtime.serverVersion`. `normalizeCodexTokenBreakdown` maps
`cacheWriteInputTokens` / `reasoningOutputTokens` (and the older
`cacheCreationTokens`) to ADE's fields. `normalizeCodexRateLimits` carries
`spendControlReached` on `account/rateLimits/read` and `…/updated`.

**Defaults.** A Codex chat launched with no controls and no project setting
runs `never` + `danger-full-access`. A project CLI mode of `edit` maps to
"Default permissions" (`workspace-write` + `on-request`).

**Plan mode** uses the native app-server planning flow. ADE's guidance goes as
a system-context input item (`collaborationMode.settings.developer_instructions`
stays null). Completed `plan` items (and `<proposed_plan>` wrappers) become
plan-approval requests. Accepting moves the session to full access
(`stageCodexPlanApprovalFollowup`) and starts the implementation turn, and
emits `session_meta_updated` so every composer leaves Plan at once. Claude
plan entry/exit and Cursor plan approval emit the same patch.

**Worktree guidance.** For Codex and the other coding agents, the lane
worktree is the only place to edit files or run mutating commands; read-only
inspection elsewhere is allowed. The system prompt and the first-turn launch
directive both say so.

**Computer Use (macOS).** An enabled Codex Computer Use plugin/config adds the
verified `SkyComputerUseClient` as `config.mcp_servers.computer_use` on every
thread start and resume; tracked CLI launches get matching `-c` overrides. See
[Computer-Use Backends](../computer-use/backends.md#codex-computer-use-current).

#### Codex turn telemetry

- Codex counts cached input inside `input_tokens` and reasoning inside
  `output_tokens`. The parent thread's `thread/tokenUsage/updated` feeds
  `session.codexTokenUsage` and the context meter.
- The turn's tokens come from the ledger: each `thread/tokenUsage/updated` for
  the chat's thread becomes a `codex_token_usage` event (turn id, running
  `total`, `last`). The ledger subtracts the total before the turn;
  `contextTokens` is the last request's input. `turn/completed` has no usage.
- **Subagents.** A notification for another thread goes to
  `handleCodexSubagentNotification`, which keeps the thread's total on
  `CodexSubagentThreadState.tokenUsage` and emits `subagent_progress` with the
  usage, without touching the parent or reopening a settled card. The one
  `subagent_result` carries the same usage (`emitCodexSubagentResult`). With
  no live counter, the result waits for a read of the subagent's rollout
  (`<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<threadId>.jsonl`; UUIDv7
  gives the day; skipped over 200 MB), summing `token_usage_record` lines with
  `usageConfidence: "derived"`.
- `model/rerouted` (also `model/reroute`) records the served model on
  `runtime.servedModelByTurnId`, posts "Codex rerouted this turn from X to Y.",
  and `done` carries it as `servedModel`.
- `done.account`: `startCodexRuntime` sends one `account/read { refreshToken:
  false }` after `initialized` (the app-server sends `account/updated` only on
  a change, which then wins). `codexAuthModeFromAccountRead` maps `apikey` →
  `api_key`; `chatgpt` / `chatgptAuthTokens` → `subscription`; Bedrock →
  `unknown` with `routedAway: "cloud"`; others → `unknown`. Without a mode, a
  keyed preset is `unknown` and a signed-in instance `subscription`. Email and
  plan come from the cached instance record (plan from `account/read` when the
  record has none), on subscription turns only.

#### Codex rewind and 0.145 readiness

File-rewind selects a user message, rebuilds its turn from the transcript and
resolves its `targetTurnId`:

- **Servers ≥ 0.145.0 with a turn id** use `thread/fork` with `{ threadId,
  beforeTurnId }` (`codexServerSupportsForkBeforeTurn`). `beforeTurnId` is
  never sent to an older server.
- **Older servers, or no usable turn id,** use `thread/rollback` with
  `{ threadId, numTurns: 1 }` (latest message only). From 0.156
  `codexServerSupportsThreadRollback` is false, so such a target fails with a
  clear error.
- Either response feeds `applyCodexEffectiveThreadState` and re-pins the
  resume command to the resulting thread.

The per-file restore writes each file back from the turn's starting commit
(`git restore --source=<beforeSha> --staged --worktree`), index included. A
file the turn created is deleted and unstaged (`git rm --cached`). Files it
cannot safely restore go to `skippedFiles`, listed under **Left as they are**:

- `dirty_before_turn`: uncommitted changes at turn start (`dirtyAtStart` on
  `turn_diff_summary`, from the pre-turn snapshot).
- `other_chat`: another chat in the worktree touched it after the message.
- `unknown_start_state`: no `dirtyAtStart` record.

While another chat in the worktree has a running turn, the rewind refuses with
that chat's name. A rewind that skipped files adds a notice naming them.
`mcpToolCall` `appContext.templateId` stays optional so old transcripts
decode. Paginated `thread/resume` is not used, because it needs
`excludeTurns` and gives up full-history resume.

#### Provider service tiers (Fast Mode)

**Fast is account-gated, off by default.** The account settings row
`chat.fastModeEnabled` (scope `all`) says whether the account may use a faster
tier. Absent or unreadable is **off**. The brain reads the account settings
cache on every create, update, `/fast` and turn start (behind a one-second
cache), so the Settings toggle applies with no restart.

- **A permission, not a default.** Every new chat starts **Standard**; Fast is
  per chat and never remembered (machine launch defaults write `fastMode:
  false`, drafts and iOS drop it, a handoff does not inherit it). A restored
  draft or failed launch keeps its own choice.
- **Clients are told.** The session summary and `chat.getLaunchDefaults`
  carry `fastModeAllowed` (absent: an older host, treated as allowed). With
  `false`, desktop and web show no Fast control, and a Fast chip in the model
  picker opens a dialog whose Continue opens Settings → Chat → Fast mode. The
  phone draws a muted bolt and disables its switch. The hosted web reaches the
  row through `chat.getFastModeEnabled` / `chat.setFastModeEnabled`. Only the
  Settings row explains the cost.
- **Refused, not downgraded.** `ade chat create --fast` / `handoff --fast`
  answer `FAST_MODE_DISABLED_MESSAGE`, except for an automation, which runs
  Standard. `updateSession` drops a forbidden Fast. A live chat with Fast
  loses it, and the stored bit, at its next turn start.

`ModelDescriptor.serviceTiers` lists a model's tiers (`"fast"` from every
catalog, `"ultrafast"` only from Codex). The **Fast** chip on the model's row
shows when `modelSupportsFastMode(descriptor)` is true. `AgentChatSession`
carries `fastMode?: boolean` (`codexFastMode` is still accepted at
boundaries).

| Provider | How Fast is sent |
|---|---|
| Codex | `serviceTier: "fast"` (or `"ultrafast"`) on every `turn/start` and `thread/start`, and an **explicit `null`** when off, which forces standard over a `config.toml` `service_tier = "fast"`. ADE handles `/fast` inline. |
| Cursor | `fastMode: false` whenever off, because Cursor's catalog default can be Fast. `cursorModelSelection` maps the flag; Work CLI launches use the `*-fast` alias. |
| Claude | Fable and Opus advertise `["fast"]`. Chat sends `settings.fastMode`; CLI launches pass `--settings '{"fastMode":true|false}'`. Sonnet and Haiku have no Fast; Claude's own `/fast` is left to the runtime. |
| OpenCode | A models.dev fast mode becomes a sibling model `<id>-fast` (calls `<id>` with the same effort variants), folded into its base row; combined keys (`high-fast`, `fast_high`) read as Fast routes. `resolveOpenCodeFastEffortSelection` sends the sibling with the effort, else the combined key, else a plain `fast` variant. If no route keeps both, the effort wins, the prompt logs `agent_chat.opencode_fast_not_applied` once, and the chip is disabled with the reason. Work CLI launches carry no variant. |
| Droid | Factory's concrete fast model ids launch as chosen; fast-capable Anthropic rows (Opus 5) also get `["fast"]` and the Fast toggle. |

- The flag persists with the session (`PersistedChatState`) and syncs to remote
  devices.
- **Fast belongs to one model.** A model switch keeps `fastMode` only when the
  new model has a fast tier (`sessionModelSupportsFastMode`); otherwise it is
  cleared and saved. A Cursor tier comes from the in-memory catalog only
  (`cursorModelFastTierFromCache`); unknown keeps the flag, and the send-time
  resolver applies it only where Cursor has a tier.
- **Ultrafast** (Codex, per account) rides `fastTier?: "ultrafast" | null`
  beside `fastMode` on the session, summary, create/update/handoff args, the
  cross-machine capsule and tracked-CLI metadata. Only Codex `model/list` can
  grant it; the runtime caches each model's advertised `serviceTiers` by
  app-server id and descriptor id. The chip cycles Off → Fast → Ultrafast
  only on such models and only where the surface passes `fastTier` (the
  composer and the handoff modal). At send time Codex asks for `"ultrafast"`
  unless the cache says the model lacks it. `updateSession` changes the tier
  only when the update names `fastTier` (Fast-only clients resend `fastMode:
  true`). Fast off clears it; a model switch keeps it only when named or known
  offered; never stored for non-Codex. The CLI passes `-c
  service_tier="ultrafast"` with `-c features.fast_mode=true`.
- Parallel-model rows track Fast per slot (`ParallelModelRowState.fastMode`).
  Codex discovery fills `serviceTiers` from `additionalSpeedTiers` /
  `serviceTiers`; Cursor discovery from SDK/CLI parameters, folding `*-fast`
  rows into aliases.

### OpenCode

Four `OpenCodeAgentProfile` agents in the generated config
(`openCodeConfig.ts`):

| Mode | Agent | Behavior |
|---|---|---|
| `plan` | `ade-plan` | Denies edits, subagents, web search and skills; asks for shell. |
| `edit` | `ade-edit` | Asks for edits and shell. |
| `full-auto` | `ade-full-auto` | `*` allow. |
| (one-shot helper) | `ade-helper` | Denies every action with a side effect. |

`buildOpenCodePermissions` builds each agent's rules, evaluated
last-match-wins after OpenCode's base policy. See
[OpenCode integration › Permissions and questions](./opencode-integration.md#permissions-and-questions).

#### OpenCode turn telemetry

OpenCode reports usage per model request as a `step-finish` part (`input` is
uncached). `openCodeTurnUsage.ts` records each parent-session step by part id
(a re-sent part replaces), and `done` reports:

- token fields summed over the steps, `reasoningTokens` included;
- `contextTokens`: the last step's `input + cache.read + cache.write`;
- `requestCount`: the number of steps;
- `contextWindow`: the descriptor's limit;
- `costUsd`: the sum of the steps' `cost`, `costSource: "provider"`.

A step inside a compaction summary counts toward totals and cost but never the
context figure. Other steps each emit a live `context_usage`.

- `done.servedModel` names the latest non-summary assistant message's model in
  registry form (`openCodeRegistryIdFor`), only when it differs from the asked
  model (the fast sibling).
- `done.account` names the `upstream`: `lmstudio` / `ollama` are `local`;
  `opencode` / `opencode-go` are `subscription` (email from the `account`
  table of ADE's `opencode.db`); others from the `credential` table
  (`readOpenCodeCredentials`: `key` → `api_key`, `oauth` → `subscription`
  with `accountId`); none → `unknown`. Only `type` and `accountId` are read.
  Both lookups cache for five minutes.

### Pi

Pi's built-in tools are `read`, `bash`, `edit`, `write`, the read-only `grep`,
`find`, `ls`, and on Windows `powershell` (run through `pwsh.exe`, else
Windows PowerShell; granted in the same modes as `bash`). The SDK's `tools` is
one flat allowlist. With extensions on, the worker passes `excludeTools` for
every built-in it did not grant and `+name` for the ones it did, because the
session starts on Pi's `defaultTools` setting.

Chat and tracked-CLI Pi use two mappings in `shared/cliLaunch.ts`:
`piToolsForPermissionMode` (terminals; allowlist only) and
`piSdkToolPolicyForPermissionMode` (chat; with approval cards).

| Mode | `tools` | Gated behind an approval card | MCP | `readOnly` |
|---|---|---|---|:-:|
| `plan` | `read`, `grep`, `find`, `ls` | — | off | yes |
| `edit` | `read`, `edit`, `write`, `grep`, `find`, `ls` | MCP tools | ask | no |
| `full-auto` | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | — | allow | no |
| `default` (also `auto`, `config-toml`) | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` | `bash`, `edit`, `write`, MCP tools | ask | no |

- On Windows `powershell` joins `bash` in `default` (gated) and `full-auto`.
  `grep`, `find`, `ls` never ask. The CLI mapping includes them in every mode;
  a read-only list also passes `--no-mcp`.
- `default` means **ask before anything that changes the workspace**.
  `readOnly` is stated on the policy, not inferred.
- **The gate is real.** `bash`, `edit` and `write` are rebuilt from Pi's
  exported factories (`createBashToolDefinition` …) and re-registered through
  `customTools` under the same names, keeping Pi's schema, prompt and the
  user's shell settings. A tool whose factory is missing is **withheld** and
  reported as `ungateableTools` (a chat notice).
- "Allow for this chat" is remembered per tool name. A dismissed card or
  aborted turn denies, as a thrown error.
- **Model.** `resolvePiExactModel` (`piSdkSelection.ts`) looks up provider and
  id exactly; Pi's typed-input resolver would pick near matches or another
  provider. A missing model fails the launch or switch with the reason.
- **Thinking level** applies once the session exists. No effort means Pi's
  default (`defaultThinkingLevel`, else `medium`), also for a resumed file;
  clearing mid-chat sends `set_thinking` with `null`. The picker offers
  `piSupportedThinkingLevels` per model (carried as `modelThinkingLevels`); a
  model that cannot think gets no picker.
- **ADE never writes Pi's settings.** The settings manager uses
  `createPiReadOnlySettingsStorage`. One exception: Pi's "Sign in with
  ChatGPT" needs an installation id, so `login` passes
  `LoginOptions.getDeviceId`, reading `deviceId` from the global
  `settings.json` and letting Pi create it when missing.
- A `readOnly: true` worker runs on `PI_READ_ONLY_TOOLS` plus `ask_user`;
  `tools` may only narrow it, `approvalTools` is empty, extensions are off.
  `ready.activeTools` reports what the model sees.
- `grep` and `find` need `rg` and `fd` in `<agentDir>/bin` or on `PATH`; the
  chat worker leaves a tool out when its binary is missing
  (`withoutMissingSearchBinaries`), so Pi never downloads one. A tracked Pi
  terminal still fetches both at startup.
- `startPiRuntime` records a `toolPolicyKey` (tools, approval tools,
  extensions, MCP mode) and restarts the worker when it changes; MCP servers
  are not in the key.
- **Fork.** The worker's `fork` copies one native session into a new file with
  `SessionManager.createBranchedSession`: the source's active branch up to the
  cut, labels kept, a new id, `parentSession` set. The source is never
  written; the worker opens a private snapshot of its complete lines, so a
  live source is fine. Without `entryId` the cut is the last point with no
  turn in flight. Any initialized worker can serve it.
- **Usage.** Assistant-message usage is summed per turn (input, output, cache,
  reasoning, list-price cost), keeping the latest model on a reroute. After
  each turn the worker reads `getContextUsage()`; a reading with no data
  (after a compaction, or no known window) is "no sample". Compactions report
  before/after estimates.
- **Account.** Settings → Providers uses the frozen `"settings"` rules of
  `piSdkAuth.ts`; the worker's `createPiAccountReader` uses `"turn"`: a stored
  `auth.json` entry wins; a loopback base URL is `local`; a key in
  `models.json` or the provider's variable (`PI_PROVIDER_ENV_KEYS`) is
  `api_key`; another `models.json` base URL is `local`. A built-in provider's
  registry URL counts only when loopback, so cloud providers never read as
  local.

#### Pi MCP servers

Pi's SDK loads no built-in extension, so with `mcp` in the init the worker
adds inline factories: `createMcpExtension()`, `createCodemodeExtension({
models: false })` (no paid model handle in scripts) and
`createToolSearchExtension()`. All are `hidden` and `replaceable`, load
whatever `noExtensions` says, and need the `projectTrusted: false` settings
manager.

- **Which servers.** The agent directory's `mcp.json`, and a project's
  `.pi/mcp.json` only when the user trusted that folder in Pi
  (`ProjectTrustStore`, `trust.json`), loaded with Pi's `loadMcpConfig`. The
  MCP registry's servers (`registryMcpServersForLaunch`) are added with
  `pi.registerMcpServer`, each `env` and header value escaped (`$` → `$$`, a
  leading `!` → `$!`). A failed registration is a load notice; other servers
  still start.
- **Who** (`piMcpModeFor`): none in `plan` mode, plan interaction mode or a
  side chat. Strict MCP chats, the light profile and an SDK host's personal
  chat get none. An assistant chat gets `mcp.json` but not the registry. The
  registry is read only at worker start (`piMcpInitWithRegistry`).
- **Allowlist.** The worker adds `codemode`, `tool_search`, `mcp__*` and the
  three resource tools, so a `direct` server's tools are declared.
- **Approval.** When the mode asks, an `ade-mcp-approval` extension's
  `tool_call` hook sends every `mcp__*` and resource call (codemode calls
  too) through the `bash` gate; a denial returns `{ block: true }`. If it
  fails to load, the chat start fails.
- **Environment.** The worker env is an allowlist
  (`buildPiWorkerEnvironment`); `$NAME` references in the agent directory's
  `mcp.json` (`env`, `headers`, `oauth.clientSecret`) are added, a project
  file's are not.
- Pi's MCP OAuth (`/mcp login`) is not reachable from a chat; a registry
  server signed in through Settings brings its `Authorization` header.

### Cursor

- **Modes.** `shared/cursorModes.ts` lists configurable mode ids; the session
  keeps a `cursorModeSnapshot` (current mode, available ids, selected config
  options).
- **Availability.** Descriptors carry `cursorAvailability`: SDK rows serve
  chat, CLI rows serve Work CLI launches. Until this key's SDK list loads,
  availability is unknown: a chat start waits up to 3 s for a list already
  loading (`resolveCursorModelAvailability`), then lets the model through, so
  Auto is never refused. Once loaded, a CLI-only model is refused. An empty
  list stays unknown.
- Cursor Cloud ids keep their namespace: `cursor/grok-4.6` (the SDK gets
  `grok-4.6`), not ACP's `xai/grok-4-6`.
- **Policy.** `resolveCursorSdkPolicy` (`cursorSdkPolicy.ts`) turns the mode
  into chat mode, approval policy, hard guards and a `fullAuto` marker. Hard
  guards refuse paths outside the lane. Read-only exceptions: this lane's
  Cursor `terminals`, `agent-transcripts` and `assets` under
  `~/.cursor/projects/<slug>/`, and the project's `.ade/attachments` when
  worker init supplies the project root (never inferred; the realpath
  basename must be `attachments`). Writes, shell, other projects' Cursor
  folders, `.ade/secrets` and junctions onto `.ade` stay denied.
  `buildCursorSdkLocalRunOptions` reduces the policy to run options.
- `fullAuto` only partitions the pool and labels logs. It is **not** the SDK's
  `local.force`, which expires the active run; that is reachable only through
  `CursorSdkSendPrompt.forceExpireActiveRun` on ADE's recovery re-send.
- **Hook timeout.** Cursor kills a `preToolUse` hook at its `timeout` (60 s
  unset), so ADE's gate entry states `timeout: 86400` and the script denies
  15 s earlier with a reason. If the script gives up or is killed, the worker
  posts `hook_abandoned` and the card is retired as cancelled
  (`agent_chat.cursor_permission_hook_abandoned`).
- **Fork is a replay.** `@cursor/sdk` has no fork and a thread cannot resume
  twice, so a fork opens a fresh agent and replays the source transcript
  (bounded by the context window). `providerForkReplaysTranscript` marks it;
  cross-machine fork excludes it.

**Sending during a turn.** Codex (`turn/steer`), Cursor (`Run.steer`) and
OpenCode (`session.prompt` with `delivery: "steer"`) take a message during a
live turn. `ACTIVE_TURN_DISPATCH_MODES` gives Codex and OpenCode `inline` and
`queue`, and Cursor every mode Claude has.

- Cursor's interrupt stops the run, waits for it to settle and sends the
  message as the next turn on the same agent (`activeTurnInterruptContinues`;
  labelled "Interrupt & continue"). It runs `stop_only` with
  `preserveQueuedSteersOnInterrupt`, so staged messages ride through.
  `interrupt-replace` on OpenCode, Pi and Droid stays `stop_and_clear`. A
  subagent result waiting in the cleared queue goes out inside the redirect
  message on Pi, Droid and ACP; a plain Stop clears it.
- **Inline is local only.** A Cursor Cloud run refuses every `Run.steer`.
  `cursorSessionRunsInCloud(session)` (iOS:
  `workChatCursorSessionRunsInCloud`) is the one check; it reads
  `cursorRuntime` and `cursorCloudAgentId`, and `cursorRuntime: "local"` wins.
  A cloud chat's default is **Send after turn**; an unwired inline pick falls
  back to queue, never interrupt. `chat.messageSession` kind `auto` on a cloud
  Cursor chat routes to `interrupt`.
- **Refused steers never throw.** `tryCursorInlineSteer` declines up front
  (attachments, per-message overrides, cloud, dead runtime) with no row.
  Otherwise it writes the row as `accepted` and asks the worker. Only
  `complete_delivered` moves it to `inline` (`CursorSdkSteerOutcome`;
  `revert_to_followup` and `unsupported` are refusals). A refusal moves the
  row to `queued`, sends it as its own turn when nothing runs (`delivered`,
  same `steerId`, `sendRefusedSteerAsOwnTurn`), or marks it `failed`. It posts
  one notice and runs `drainCursorQueueHeadIfIdle`. Drained Cursor and
  OpenCode rows carry their `steerId`. OpenCode and Pi also write `accepted`
  first; a Pi steer has no queue fallback, so a throw marks it `failed`.

#### Cursor turn telemetry

- **Tokens.** The stream's `usage` message is one `turnEnded` report per agent
  turn; `RunResult.usage` sums them. `tokens` and `done.usage` read input,
  output, cache read, cache write and `reasoningTokens`. No per-request figure
  exists, so `done.usage` has no `contextTokens` or `requestCount`.
- **Compaction hook.** `ensureCursorSdkUserHook` registers a `preCompact`
  entry beside the `preToolUse` gate in `~/.cursor/hooks.json` (the user's
  global file; ADE edits only its own entries). It runs its own
  `~/.cursor/hooks/ade-precompact.{sh,cjs,cmd}` with `failClosed: false`,
  never the gate scripts, which an older ADE build may rewrite. The scripts
  answer `{}` on every path, so they cannot block a compaction. They connect
  only when `ADE_CURSOR_SDK_PRECOMPACT=1` (`buildCursorSdkWorkerEnv`). If the
  scripts cannot be written, no entry is added and the gate still installs.
- The worker posts `ade_cursor_compaction` (`trigger`, `context_tokens`,
  `context_window_size`, `context_usage_percent`, `model`);
  `cursorSdkEventMapper` makes a live `context_usage` and `context_compact`
  `started` (`detection: "provider"`, `preTokens`).
- **Summary messages** (`running`, `completed`, `error`, `fallback: true`) are
  the real start and end, local and cloud. `createCursorSdkRunTelemetry`
  merges them with the hook into one compaction; `error` ends it as
  `failed`/`provider_error`. Without a summary, the next generation message
  or the run end closes it. Ids: the turn id, then `<turnId>:compact-<n>`.
  Once either signal arrives, `detectCompactionSignalText` stays quiet.
- `ADE_CURSOR_PRECOMPACT_HOOK=0` or `CursorSdkWorkerInit.preCompactHook:
  false` removes the entry. The hook is undocumented; if an SDK drops it,
  the status-text match takes over.
- **Account.** `done.account` is `{ provider: "cursor", kind: "subscription" }`
  plus `email` (a hook payload's `user_email`, else one unawaited
  `Cursor.me()` per worker), attached as `adeTurnTelemetry`. For `auto`, the
  hook payload's `model` becomes `done.servedModel`.
- A turn with no hook payload (text-only `auto`, every cloud turn) has no
  served model at `done`. `scheduleCursorDashboardReconcile` later amends the
  row's `servedModel`, charge and request count from Cursor's dashboard,
  keyed by the agent the turn ran on (`recordTurnUsage` takes the cloud agent
  when `done` says `runtime: "cloud"`).

#### Model params: local, cloud, and model options

Every run carries `ModelSelection { id, params }`. `cursorModelSelection.ts`
builds params from effort, Fast/tier and `cursorConfigValues`;
`cursorModelsDiscovery.ts` owns the catalog.

- **Local sends: best-effort, never blind.** Resolved params go on `ok` and
  `partial`. When the catalog in memory cannot answer and the chat names a
  control, `resolveCursorSdkLocalSelection` loads it first (one bounded fetch;
  a recent failure answers at once). If it still cannot load, the turn runs
  without those params and shows one `system_notice`.
- **Cloud create: verified or refused.** `verifyExplicitCursorModelSelection`
  accepts only `ok`, because Cursor Cloud substitutes defaults for missing
  params.
- **Cloud follow-up refuses only an unlisted model**
  (`resolveCursorSdkFollowUpSelection`). Otherwise it sends what resolved and
  shows one notice naming what was not applied
  (`describeUnappliedCursorSelection`), again only after a full run.
- Cloud paths fetch only when the key's cache is cold.
- **Adopted model.** When a cloud run started elsewhere uses another model,
  `syncCursorSessionDescriptor(..., { adopted: true })` drops each choice the
  model cannot meet (`unsupportedCursorSelection`), and Fast without a tier. An
  undeclared control stays. An unknown catalog drops nothing.
- **Model options (`cursorConfigValues`)** are the model's catalog parameters
  other than effort and tier (`listCursorSdkModelConfigParameters`),
  published by `cursorSdkConfigOptions`. An unset option is `currentValue:
  null`. A select starts on "Default"; a boolean cycles Default, On, Off. The
  renderer sends only keys the user set (`userSetCursorConfigValues`). A
  value rides as a param when the model declares it and the value matches;
  an undeclared key is dropped; an unmatched value is `unmet: ["config"]`. A
  config value never overrides effort or Fast set by their own controls.

### The permission ladder

Each CLI names autonomy differently. `shared/permissionLadder.ts` states what
the user means (how much the agent may do without asking) as four levels and
maps each onto every vocabulary, so a family switch keeps the user's level.

| Level | Claude | Codex (policy + sandbox) | OpenCode | Droid | ACP | Cursor |
|---|---|---|---|---|---|---|
| `plan` | `plan` | `untrusted` + `read-only` | `plan` | `read-only` | `plan` | `ask` |
| `ask` | `default` | `on-request` + `workspace-write` | `edit` | `auto-low` | `default` | `agent` |
| `auto-edit` | `acceptEdits` | `on-failure` + `workspace-write` | — | `auto-medium` | `auto-edit` | — |
| `full-auto` | `bypassPermissions` | `never` + `danger-full-access` | `full-auto` | `auto-high` | `yolo` | `full-auto` |

- **Nearest LOWER on a miss.** OpenCode and Cursor resolve `auto-edit` to
  their `ask` rung and report `downgraded: true`.
- **The ladder only picks where an UNVISITED family starts.** The exact
  per-family choice is remembered, so Droid restores `agi`.
- **Reading back** (`permissionLevelFor*`): Codex needs both axes for
  `full-auto`; `never` + `workspace-write` is not full-auto. OpenCode
  `config-toml` reads as `ask`.

**Where a new chat starts.**

- The desktop composer and the batch and Linear launchers start every family
  on `full-auto` (`defaultNativeControls`, `renderer/lib/nativeLaunchControls.ts`)
  unless the lane remembers a launch config, which marks its family visited.
- Launches that promise to ask first (Settings health fixes, the project-move
  check) use `askFirstNativeControls`.
- Chats with no controls (CLI, phone, automations) take `resolveChatConfig`,
  also full access when the project sets nothing (Copilot and Muse fall back
  to `full-auto` / `allowAll`). Droid has no fallback, so `settings.json`
  decides.
- The `ade` CLI's terminal launches and the phone's composer
  (`workDefaultRuntimeMode`) start on full access. A subagent with no mode
  inherits its parent.

**Keep the ladder separate from `AgentChatPermissionMode`.** The generic
`plan | default | edit | full-auto` is what `ade --permission-mode`, CLI
launches and saved sessions speak, and `droidPermissionModeFromLegacyPermissionMode`
maps it. There `edit` is the cautious tier (Droid `auto-low`), so the middle
rungs look inverted. Do not "fix" it: that would shift every saved session.
The permission ceiling (`clampGenericPermissionMode`) reads `edit` as
`auto-edit`, so it can only clamp more.

### Permission ceiling for agents and spawned chats

An agent can never give a chat more freedom than its own chat has, and a
spawned chat (`orchestrationParentSessionId`) is capped at its parent, in any
provider. `sessionPermissionLevel` reads a session onto the ladder;
`permissionCeilingClamp` and `permissionFieldsForLevel` write a level back.
An unreadable parent or caller counts as `ask`; an unreadable child (Codex
`config-toml`) counts as above any ceiling. Cursor `agent` reads as `ask`.

**Who is calling** is `runtimeActor`, stamped by `adeRpcServer`
(`stampChatRuntimeActor`) on `chat.createSession`, `chat.updateSession`,
`chat.handoffSession`, `chat.launchHeadless`, `chat.startLaunch` and
`chat.launchCli` from any caller that is not the user's own client: `{ kind:
"cto" }` or `{ kind: "agent", chatSessionId }`. A sent value is dropped first,
and a non-user caller must pass one object. The CTO tools stamp the same way.

- **Create** (`createSessionInternal`): the ceiling is the lower of the
  parent's level and the agent's own (`resolvePermissionCeiling`). A chat above
  it is clamped with one info notice. Identity-pinned sessions keep their mode.
  A fork or brief handoff passes the caller through.
- **Update**: an agent's update touching a permission field, the interaction
  mode or `modelId` is refused when the result would exceed the ceiling,
  checked on the fields the update will leave after normalization.
- **CLI children**: `start_cli_session`, `spawn_agent` and `chat.launchCli`
  clamp the requested mode (full-auto when omitted, and
  `droidPermissionMode`) with `clampGenericPermissionMode`.
- **Not capped:** the CTO and a person. A caller with no `runtimeActor`
  (including an `ade` CLI with no chat identity) is not capped. An agent with
  no chat (an orchestrator run, step or attempt) is capped only by the
  parent. The CTO counts as the CTO only from its own thread or as a CTO-role
  caller with no chat and no run (`callerIsTrustedCto`).
- **A tracked CLI caller** takes the permission its terminal was launched with
  (`resumeMetadata.launch`, `trackedCliLevel`); a failed read is `ask`.
- **Another project or machine**: the level comes from `externalChatContext`
  (unrecorded = `ask`). A remote machine sends it on every call;
  `multiProjectRpcServer` records a local caller
  (`crossScopeChats.rememberLocalCaller`) before every chat start and
  `chat.updateSession`.
- Claude plan mode reads at the access level behind it.
- Trade-off: an `ask` agent may start a Cursor child in `agent`, which can
  also auto-edit; `CURSOR_BY_LEVEL` has no rung between.

### Abstract-to-native mapping

`AgentChatPermissionMode` is `default | auto | plan | edit | full-auto |
config-toml`. `chat/permissionMapping.ts` maps it to native fields:

- `claude`: `claudePermissionMode` (`default | auto | plan | acceptEdits |
  bypassPermissions`); `auto` hands decisions to the SDK's automatic gate.
- `codex`: `codexApprovalPolicy` + `codexSandbox`.
- `opencode`: `opencodePermissionMode` (`plan | edit | full-auto`).
- `cursor`: `opencodePermissionMode` holds the level and `cursorModeId` the
  native mode. `legacyPermissionModeToCursorModeId` maps `full-auto` and
  `plan` and returns **null** otherwise, so a derived `agent` is never saved.
  The derivation fills only when no mode was named
  (`applyCursorModeIdFromLegacyPermissionMode`); an explicit `permissionMode`
  update overwrites through `applyLegacyPermissionModeToNativeControls`.
- `droid`: `droidPermissionMode` (`read-only | auto-low | auto-medium |
  auto-high | agi`), or **absent** so `~/.factory/settings.json` decides. See
  [Provider config ownership](#provider-config-ownership).
- `pi`: the abstract `permissionMode` is Pi's native field
  (`piSdkToolPolicyForPermissionMode` / `piToolsForPermissionMode`). The
  renderer's `summarizeNativeControls` writes back only `permissionMode` for
  Pi, because the main process deletes `opencodePermissionMode` from a Pi
  session.

The abstract field is saved beside the native fields for summaries and older
flows.

### Interaction mode

`AgentChatInteractionMode` is `default | plan`. In `plan` the agent plans
read-only and proposes changes through `ExitPlanMode`.

- **Plan moves the access mode.** `applyClaudePlanModeTransition`
  (`claudePlanMode.ts`) sets `claudePermissionMode = "plan"` and saves the
  old mode in `claudePrePlanAccessMode` (persisted), restoring it on exit. A
  chat in plan mode never reads as bypass or full-auto and always gets an
  approval card.
- The auto-approve branch in the `ExitPlanMode` interception is only for
  stale saved sessions (logs `agent_chat.plan_auto_approved_stale_session`).
  Do not widen it.
- **The fence.** While `isSessionInPlanMode`, `canUseTool` refuses any tool not
  on `CLAUDE_PLAN_MODE_ALLOWED_TOOLS` (`claudeToolGate.ts`): the CLI's own
  plan-mode list (read-only built-ins, `NotebookRead`, `Agent`/`Task`,
  `Skill`, task bookkeeping, `AskUserQuestion`) plus ADE's plan-flow and
  question tools. It is a literal allowlist, so unknown and MCP tools are
  refused. A refusal logs `agent_chat.plan_mode_tool_denied`.
- **Approval.** An approved `ExitPlanMode` returns `{ behavior: "allow",
  updatedInput: input }`, so the SDK's handler restores `prePlanMode` and
  answers the model. ADE also calls `setPermissionMode` so both agree.

## Model selection flow

1. The user picks a model in `ProviderModelSelector`
   (`renderer/components/shared/`).
2. The renderer resolves a `ModelDescriptor` (`getModelById` /
   `resolveModelDescriptorForProvider`), which gives the provider, routing and
   default tier.
3. `createSession(args)` stores the `shortId` as `model` and the canonical id
   as `modelId`, and the service starts the adapter.

`resolveClaudeCliModel()` gives Claude's CLI model token; for Codex,
`agentChatService.ts` builds the app-server and thread config and
`codexExecutable.ts` resolves the binary.

### What each SDK provider receives

The model and effort the chat shows must be the ones the provider runs.

| Provider | Start | Mid-chat switch | Effort |
|---|---|---|---|
| Claude | `buildClaudeQueryOptions` sends `model` (`resolveClaudeCliModel`, or a preset's own id) and `effort` | Teardown, then a new query; a live query also gets `setModel` | A change resets the query |
| Codex | `thread/start` and `thread/resume` send `model` and the effort config | `thread/settings/update` on a live thread; `turn/start` sends `model` and `effort` every turn | Sent every turn |
| Cursor | `ensureCursorSdkRuntime` sends `{ id, params }`; the pool key holds both | Teardown, or deferred to turn end while busy (`pendingModelSwitchReset`) | Params recomputed every turn (see Model params) |
| OpenCode | `session.prompt` sends `model` and `variant` every prompt (`resolveOpenCodeFastEffortSelection`) | Teardown; a fresh session opens with ADE's reconstruction context | `variant` (`openCodeVariantKeys`); only the variants OpenCode reported; the no-inventory fallback keeps the Anthropic tiers, never Fast |
| Droid | `createSession` / `updateSettings` send `modelId` and `reasoningEffort` every turn | Teardown | `ultracode` is sent as `xhigh`; a cleared stated effort resets to Droid's default |
| Pi | `createAgentSession({ model })` with the exact model, then `setThinkingLevel`; an explicit model wins over the session file | Teardown | Pi's levels per model (`piThinkingLevel`); none means Pi's default |

Guards that keep an old model from coming back:

- `onRunStarted` does not copy a Cursor run's echoed model while a switch
  waits for turn end.
- The Cursor Cloud mirror adopts a run's model once, when the run is new.
- A Pi switch with no live runtime saves the new `piProviderId` /
  `piModelId`.
- A Pi restart on the same file waits for the old worker to exit
  (`piWorkerExits.ts`, at most 5 s), because it holds the lease.

**Live ACP models** (Grok's `grok-4.7`, `grok-4.7-build-fast`) take tiers from
the session's `reasoning_effort` option; a non-current model keeps the tiers
it had. A live report of a curated model is not a second row:
`replaceDynamicAcpModelDescriptors` matches it by id or `providerModelId`
within the route and keeps it in `liveAcpReportsByProvider`. The picker shows
the curated row with the live efforts; the live id resolves to it
(`resolveAcpModelDescriptor`).

**Served-model mismatch.** When a served model is not a spelling, context
tier, dated snapshot or effort variant of the requested one
(`servedModelMismatch.ts`), ADE logs `agent_chat.served_model_mismatch` once
per chat and model pair; `auto` never counts. `isServedRouteMismatch`
compares routes: differing known upstreams always count, else
`isServedModelMismatch` compares names. It runs on every `done`, ACP
included. Sources: Droid's assistant `message.modelId`; Pi's provider and
model (`provider/model` when the provider differs); Claude's
`claudeTurnUsage.ts` (`pickClaudeLeadingModelUsage`,
`resolveClaudeServedModel`).

## Fork from an earlier turn

`handoffSession({ mode: "fork", throughTurnId })` forks the conversation
through one finished turn ("Fork from here"; `ade chat fork --through-turn
<turn-id>`). `sliceTranscriptThroughTurn` cuts after that turn and refuses a
turn that is missing or has no `done`.

- The latest turn is a full fork.
- An earlier turn forks natively only where the provider can cut: Codex to
  Codex with `thread/fork beforeTurnId`, Copilot, and Pi to Pi (`entryId`
  from `piForkCutBeforePrompt`). Elsewhere, including Kimi, the kept turns go
  as a transcript replay.
- The source chat does not change. The desktop fork form shows the point
  ("From the turn that ended at …") with a **Whole chat** escape.

## Machine launch defaults

The model and settings a person last launched or switched to are kept per
machine in `<ADE home>/chat-launch-defaults.json`
(`createChatLaunchDefaultsStore`, `chatLaunchDefaults.ts`).

- A person's top-level Work chat creation writes it, as does a person's
  `updateSession` that changes the model, effort, Fast or a permission field.
- Calls with a `runtimeActor`, subagents, identity chats and automation runs
  never move it.
- Clients read `chat.getLaunchDefaults` before their own memory: the desktop
  draft composer (refetched on machine change, chat create and window focus)
  and the iOS new-chat screen. An older brain answers nothing.
- Without `machineAdeHome` the record stays in memory.

## Model switching mid-session

`chatModelSwitching.ts`:

- `ChatModelSwitchPolicy` is `"same-family-after-launch"` (regular chats) or
  `"any-after-launch"` (CTO and persistent-identity sessions).
- `canSwitchChatSessionModel(session, target)` applies it;
  `filterChatModelIdsForSession` limits the picker to switches without a
  handoff.

Another model means a **handoff** (`handoffSession`):

1. **Fork (Claude → Claude).** The new session's `forkFromSdkSessionId` is
   the source `sdkSessionId`, and the next `query()` runs with
   `options.forkSession = true`, keeping full history. It is saved in
   `PersistedChatState` for resume.
2. **Brief (any other pair).** `generateHandoffBrief()` summarizes the last 12
   messages, ends the source and injects the brief into the new session. The
   message keeps the full prompt but shows a short `displayText` with
   `metadata.hideFullPrompt`. `buildDeterministicHandoffBrief()` is the
   fallback when no summarizer works or the list is empty;
   `AgentChatHandoffResult.usedFallbackSummary` says which ran.

### Replay budget and the handoff notice

`crossProviderReplayFork.ts` budgets a replay at three characters per token,
holds back the larger of 32,000 tokens or 15% of the window, and caps the
replay at 60% of the window. When older turns drop, the new chat opens with a
notice: how many turns it carried, their rough share of context, and that the
rest is in the source chat.

**Overflow recovery (Claude only)** (`claudeReplayOverflowRecovery.ts`). Other
providers' replays are capped by a wire limit (`CODEX_REPLAY_MAX_CHARS` …).

- `transcriptReplayOrigin` records the source chat, budget, turn counts and
  window. A "prompt is too long" halves the budget (floor 2,000 characters),
  re-fits the transcript and re-sends once, on a **fresh** provider session,
  clearing the continuity tail.
- This covers a refused carrying turn and a later overflow alike. ADE never
  asks Claude to compact a one-exchange chat.
- One retry per message. `noteRetrySucceeded` drops the staged replay;
  `reportRetryFailed` (idempotent) restores it and says so. An interrupted
  turn is neither.
- Older forks are found by `handoff_fork` provenance, only when `replayFork`
  says replay (or, without the flag, a non-Claude source). A native fork is
  never re-seeded.

## Auto-title generation

ADE names chats and auto-created lanes with one model per provider, from the
vendor the chat already uses, so content never goes to another vendor:

| Chat provider | Model | How it runs |
|---|---|---|
| Claude | Haiku 5.5 (`low`) | pinned `claude -p` |
| Codex | GPT-6 Luna (`low`) | pinned `codex exec` |
| Cursor | Composer 2.5 (standard speed) | Cursor SDK worker pool |
| Copilot, Muse, Qwen, Kimi, Grok | the chat's own model | pinned runtime (Copilot SDK utility session, `muse serve`, each ACP CLI's one-shot mode) |
| Droid | the chat's own model | pinned `droid exec -o text`, read-only |
| Devin | the chat's own model | pinned `devin -p --prompt-file`, stdin closed |
| Pi | the chat's own model | pinned `pi -p --mode text --no-session --no-tools` |
| Antigravity | the chat's own model | one ACP prompt on `agy acp`; signed out fails before any spawn |
| OpenCode, API-key, OpenRouter, local | the chat's own model | `runOpenCodeTextPrompt` on the pinned OpenCode |

- **Dispatch.** `providerTaskRunner.ts` routes on
  `resolveCliProviderForModel`; OpenCode gets only models with no CLI
  provider, and an unknown provider throws. Pinned-CLI runners live in
  `pinnedCliTaskRunners.ts`, their spawn in `providerTaskCommon.ts`. Each runs
  in its own process group; a timeout sends SIGTERM, then SIGKILL after 1.5 s
  (Windows: `taskkill /T /F`). None starts the user's MCP servers (see
  [MCP servers](../onboarding-and-settings/mcp-servers.md#background-jobs-start-no-mcp-servers)).
- **Background utility.** `summarizeTerminal` runs as a background utility
  task: Claude with no tools and no MCP (`--tools= --strict-mcp-config`,
  default permission mode, JSON asked in the prompt); Codex and Cursor at
  standard speed. Settings live in `shared/backgroundUtilityModel.ts`.
- **Images.** Qwen, Kimi, Grok, Droid, Devin, Pi, Antigravity and Copilot
  one-shots are text only; a request with images is refused and the
  deterministic name stays.
- **Account.** Each helper call runs as the chat's own provider account (the
  same `CLAUDE_CONFIG_DIR` / `CODEX_HOME`: preset home first, then the
  chat's account). With no chat yet (a new lane's name), it uses smart
  balance's pick; other one-shots use the default account.
- **Claude failures** read Claude's own reason from JSON stdout (`Claude
  failed: <result> (HTTP 429)`). A usage limit or 429 is not retried on the
  same account.

**Rules.**

- ADE chats wait about 8 s for a native title, then ADE-name a still-default
  title. CLI sessions are always ADE-named (the cheap helper for Claude, Codex
  or Cursor, else the launch model; see
  [AI-driven titles](../terminals-and-sessions/pty-and-sessions.md#ai-driven-titles)).
- Cursor Cloud names stay Cursor's: `updateSession`,
  `regenerateSessionMetadata`, auto-title and the meta writers refuse to
  overlay them.
- `ai.sessionIntelligence.titles.enabled` is not a gate.
- Six words is a guideline: a longer title is cut on a word boundary. If
  every candidate fails, a title derived from the seed prompt (as for lanes)
  replaces a still-default title when it has at least two words. Explicit
  regeneration and idle status lines get no deterministic fallback.
- `manuallyNamed: true` stops auto-titles for good; the check runs before the
  title write.
- `buildSessionIntelligenceModelCandidates` (`sessionNaming.ts`) gives the one
  model for titles, status lines, regeneration, lane names, handoff briefs
  and identity summaries. `ade chat generate-names` regenerates title, lane
  name and status line.
- `regenerateSessionMetadata` returns `generationError` (from
  `runNamingAcrossProviders`' `lastFailure`, passed through
  `presentChatFailure`) with `usedDeterministicFallback`, which the Work tab
  shows.

## One-shot utility tasks

ADE does not write commit messages, PR titles or descriptions, PR summaries or
GitHub issues; the person or agent doing it writes them. Graph and iOS PR
create is a title (from the lane name) plus optional markdown. Graph edge
clicks run merge simulation only. Conflict proposals throw `Choose a … model
in Settings`. Live chat compaction always uses the chat's own provider.

Every one-off call goes through `runProviderTask`. Every Cursor one-off runs on
the pooled worker through `runCursorSdkLocalPrompt` (`cursorSdkPool.ts`):
agent retries, trimmed setting sources, a throwaway state root,
`sandboxOptions: { enabled: false }`, and a closed agent. Never call
`Agent.create` in the host process. The pool keeps one worker per workspace
and key for a short idle window, capped at
`CURSOR_SDK_LOCAL_ONESHOT_MAX_WORKERS` (least-recently-used released). Each
send carries `resetConversation`. One-shots run under
`CURSOR_SDK_ONESHOT_POLICY`, which denies every tool.

## CTO vs. regular chat routing

CTO sessions (`identityKey: "cto"`, the only identity session):

1. `sessionProfile: "persistent_identity"` gives a distinct
   `ChatSurfaceProfile`.
2. Identity, notes, open work and live project state are rebuilt from
   `ctoStateService` into the volatile turn prefix every send; the static
   prompt block is staged once per provider thread.
3. The system prompt is one immutable doctrine plus environment knowledge;
   the `focused`, `friendly` and `playful` personalities change only tone
   (`ctoStateService.ts`).
4. `ctoOperatorTools` (with the `remember` / `forget` / `trackWork` /
   `finishWork` / `readHistory` memory tools) and Linear tools reach the live
   session through `createCtoRuntimeToolMap`: an `ade-cto` SDK MCP server
   (Claude), the `ade_cto` dynamic-tool namespace (Codex), or an HTTP MCP
   lease (Cursor / Droid / OpenCode). See
   [tool-system](tool-system.md#registration-on-a-live-session).
5. `normalizeIdentityPermissionMode` (`identitySessionPolicy.ts`) pins the
   CTO to `full-auto`; `ensureIdentitySession` re-normalizes before every turn.
6. The provider thread is disposable. `refreshCtoProviderThread` tears down
   the runtime, forgets provider pointers, re-stages the prompt and tail, and
   lets the next send open a new thread on the same ADE session. It runs at
   55% occupancy after a turn, after a compaction or overflow, on a model
   fallback, or on request.
7. CTO-launched work never runs on the main checkout.
   `resolveCtoExecutionLane` honors an explicit `laneId` or creates a lane;
   mutating git tools use `requireMutationLaneId`. See
   [CTO](../cto/README.md#where-cto-launched-work-runs).
8. A new CTO thread gets one visible opening user turn (`seedCtoIntroTurn`),
   once per project.
9. Its "needs you" state comes from the read-only `getCtoAttention` probe.

## Fragile and tricky wiring

- **Model discovery changes the registry.** `localModelDiscovery.ts` adds and
  removes descriptors; a cache of the registry must subscribe or re-read.
- **Cursor discovery is surface-scoped (`cursorSource`).** Chat surfaces use
  the SDK (~300 ms); Work CLI drafts use the `cursor-agent` CLI (seconds).
  `loadAvailableModels` / `getModelCatalog` probe only the requested source
  (`"sdk" | "cli" | "all"`) and serve the other from last-known-good. Mobile
  and the desktop ModelPicker pass `"sdk"`. Staleness checks
  `cursorAvailability[source]`, mirrored in `runtimeCatalogCache.ts`.
- **Claude runtime readiness.** `claudeRuntimeProbe.ts` checks the binary and
  auth before launch (`CLAUDE_RUNTIME_AUTH_ERROR`).
  `probeClaudeRuntimeHealth` is fully isolated (`settingSources: []`,
  `mcpServers: {}`, `strictMcpConfig: true`, `persistSession: false`); keep
  any new probe option unable to fail the health answer.
- **Claude account skills download first.** Claude Code downloads a claude.ai
  account's skills and plugins into `<config>/skills/synced` and
  `<config>/plugins/synced` when a session first starts in a Claude home. A
  chat that starts during that download lists a different skill set, so its
  cached prefix is of no use to the next chat. `claudeAccountSkillSync.ts`
  starts one Claude session with no prompt when the AI status reports an
  account sign-in and the base home has no completed skills round
  (`.last-complete-round`). It runs in the temp folder, loads user settings
  only (empty setting sources skip the download), no MCP servers and no hooks,
  and stops when both rounds complete (2 s after the skills round when no
  plugins round follows) or after 15 s. Claude chat starts (warm and cold)
  call `waitForClaudeAccountSkillSync`, which waits at most 5 s. Other Claude
  accounts (their own `CLAUDE_CONFIG_DIR`) download on their first chat.
- **Permission mapping is one way.** `permissionMapping.ts`
  (`mapPermissionToClaude`, `mapPermissionToCodex`) maps abstract to native
  only. Changing a native field without the abstract one leaves them out of
  sync.
- **CTO compaction.** After a CTO compaction, `refreshReconstructionContext`
  must re-inject identity and memory, or the agent forgets it is the CTO.
- **OAuth redirect ports.** `oauthRedirectService.ts` binds an ephemeral port;
  if another process takes it before the callback, the flow fails silently.

## Related docs

- [Chat README](README.md): session lifecycle.
- [Composer and UI](composer-and-ui.md): model selection and permission
  controls in the UI.
- [Agents identity and personas](../agents/identity-and-personas.md): the CTO
  identity and memory.
