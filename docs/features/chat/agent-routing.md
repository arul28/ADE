# Agent Routing, Permissions, and Model Registry

Every chat resolves to a provider, a model, and a permission mode before
a turn runs. This document describes how those choices are made and
where the machinery lives.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/shared/modelRegistry.ts` | Single source of truth for model descriptors. Defines `MODEL_REGISTRY`, `ModelDescriptor`, model defaults (`defaultReasoningEffort`), and shared reasoning fallback/model-resolution helpers. |
| `apps/desktop/src/shared/modelProfiles.ts` | Curated selection helpers (task routing, default pickers). |
| `apps/desktop/src/shared/chatModelSwitching.ts` | `canSwitchChatSessionModel` / `filterChatModelIdsForSession` -- rules for mid-session model changes. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | `handoffSession`, permission translation, per-provider adapter. |
| `apps/desktop/src/shared/cursorModes.ts` | Canonical Cursor mode vocabulary and compatibility mapping from the legacy ADE permission field; permission-only full-auto/plan launches persist the native mode that the UI and later clients read. |
| `apps/desktop/src/main/utils/codexComputerUse.ts` | macOS-only signed Codex Computer Use MCP resolver. Requires explicit Codex config opt-in and verifies the standalone OpenAI client before it can be injected into a chat or CLI runtime. |
| `apps/desktop/src/shared/cliLaunch.ts` | Tracked provider CLI start/resume builders, including model/reasoning/permission flags and the canonical `computer_use` MCP overrides for Codex. Reasoning/fast variants are per-provider: Claude/Codex/Droid/Pi keep their flags, but tracked OpenCode launches always run the root TUI (`opencode [-m model] [--agent plan] [--prompt …]`) — no `run --interactive` branch and no `--variant`, because the root command silently drops unknown args; variants remain a chat-runtime feature. |
| `apps/desktop/src/main/services/ai/providerRuntimeHealth.ts` | Tracks provider readiness/auth/network failures so the UI can surface degraded states. |
| `apps/desktop/src/main/services/ai/providerOptions.ts` | Normalises provider-native options (Claude permission mode, Codex approval + sandbox, OpenCode permission). |
| `apps/desktop/src/main/services/shared/providerConfigHomes.ts` | Where each provider CLI keeps its user-level config (`claudeConfigHome`, `codexConfigHome`, `factoryConfigHome`), and the canonical statement of the config-ownership rule below. Every adapter that reads or writes a provider config path goes through it. |
| `apps/desktop/src/main/services/ai/authDetector.ts` | Discovers available credentials (CLI, API key, OAuth) and reports auth status. |
| `apps/desktop/src/main/services/ai/codexExecutable.ts` / `droidExecutable.ts` | CLI resolution for runtimes that still need an external binary (looks on PATH, in the app bundle, then in configured install paths where supported). Claude uses the bundled Claude Agent SDK binary; Cursor and Droid run through embedded SDKs (`@cursor/sdk`, `@factory/droid-sdk`). |
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | Adjusts the system prompt per mode (`chat`, `coding`, `planning`) and permission mode, and injects runtime-specific native-subagent versus ADE-child routing guidance. |
| `apps/desktop/src/main/services/chat/droidSdkPool.ts`, `droidSdkWorker.ts`, `droidSdkProtocol.ts`, `droidSdkEventMapper.ts` | Droid SDK adapter. `droidSdkPool` forks `droidSdkWorker.cjs` (one per session), brokers prompt sends, permission requests, ask-user prompts, and settings updates via the JSON-line protocol in `droidSdkProtocol`. Send payloads carry screenshot paths (`DroidSdkUserImage`), and the worker materializes bytes locally through `workerAttachmentImages.ts`. `droidSdkEventMapper` translates Droid SDK events into the canonical `AgentChatEventEnvelope` shape; the per-session mapper state (`createDroidSdkEventMapperState`) tracks streaming text/thinking item ids, in-flight tool-use names, and the latest usage breakdown. |
| `apps/desktop/src/main/services/chat/piSdkPool.ts`, `piSdkWorker.ts`, `piSdkProtocol.ts`, `piSdkEventMapper.ts` | Pi adapter. `piSdkPool` forks the worker (one per session key) and brokers prompts, model/thinking changes, compaction, inventory reads, sign-in, and the reverse-RPC UI channel described below. `piSdkProtocol` is protocol version 2 and carries the `ui_request` / `ui_notice` / `ui_cancel` / `ui_response` frames plus `login` / `login_cancel`, and validates every frame in both directions. `piSdkEventMapper` translates Pi SDK events into `AgentChatEvent`s and owns the card translation helpers (`piUiRequestToPendingInput`, `piUiResponseFromAnswer`, `piUiNoticeToChatEvents`, `piExtensionLoadNotice`). |
| `apps/desktop/src/main/services/chat/piSdkUiBridge.ts` | Worker-side half of the UI channel, deliberately free of Pi imports. Funnels Pi's three unrelated callback APIs — `AuthInteraction`, custom-tool `execute`, and an extension's `ExtensionUIContext` — into one never-rejecting `request()` that resolves to `null` when a card is dismissed, a turn aborts, or the worker is disposed. Also builds ADE's `ask_user` tool, the per-tool-call approval gate, and the extension UI context. |
| `apps/desktop/src/main/services/ai/piInstallation.ts` | Resolves the user's Pi installation: CLI path, SDK package root/entry, agent dir, `auth.json` / models / settings paths, provider inventory, and a `blocker` string when the SDK cannot be used (missing package, or a Node older than `PI_SDK_MIN_NODE`). `sdkAvailable` and `cliAvailable` are independent — the CLI can be present while the SDK path is blocked. |
| `apps/desktop/src/main/services/ai/piAuthService.ts` | In-app Pi sign-in. Enumerates the providers that can actually be signed into (`listPiLoginProviders`), runs one `startPiLogin` per provider on a dedicated inventory-only worker, relays Pi's prompts/notices through `addPiAuthStatusListener`, and answers them with `submitPiLoginPrompt`. Bounded at 10 minutes; `cancelPiLogin` stops a flow and releases its worker. Never reads, stores, or logs a credential. |
| `apps/desktop/src/main/services/chat/droidModelsDiscovery.ts` | Droid model discovery: probes the live SDK via `createSession({ execPath })` to read `initResult.availableModels`, normalizes `supportedReasoningEfforts` into `reasoningTiers`, and emits `droid/<id>` descriptors via `createDynamicDroidCliModelDescriptor`. Droid fast choices are distinct model IDs, not ADE `serviceTiers`; custom models from `<factoryConfigHome>/config.json` (`~/.factory` unless `FACTORY_HOME_OVERRIDE` is set) are merged in. The legacy `DROID_DEFAULT_MODEL_IDS` constant has been removed — the SDK is the only source. Like Cursor, the cache is stale-while-revalidate: `markDroidModelCachesStale` ages it without dropping last-known-good rows, which are served past the 120s window (up to ~6h) while one background warm per freshness window refreshes them, so an unauthenticated/mid-reauth droid isn't handed a session per passive read. |

## Supported providers

`AgentChatProvider` is `"codex" | "claude" | "cursor" | "droid" | "opencode" | "pi" | (string & {})`.
The final branch exists so local discovery can populate provider keys
for vendored runtimes without changing the union.

| Provider | Runtime | Adapter location |
|---|---|---|
| `claude` | `@anthropic-ai/claude-agent-sdk` `query()` stream with an ADE async input pump, `startup()` warmup, bundled Claude Code binary, SDK sessions, hooks, output styles, plugins, context usage, rewind, and slash-command dispatch. | `agentChatService.ts` (inline; the file carries the full Claude adapter). |
| `codex` | Pinned `@openai/codex` 0.144.5 `codex app-server` subprocess, JSON-RPC protocol. Spawn failures surface as error events. | `agentChatService.ts` (Codex adapter and thread config); executable resolution via `services/ai/codexExecutable.ts`. |
| `opencode` | OpenCode server runtime: Anthropic/OpenAI/Google/Mistral/DeepSeek/xAI/Groq/Together AI API keys, OpenRouter, and local (Ollama, LM Studio, vLLM). | `agentChatService.ts` (OpenCode adapter); model discovery in `localModelDiscovery.ts` and `modelsDevService.ts`. |
| `cursor` | Official `@cursor/sdk` running in a Node worker pool. ADE owns permissions, hooks, and the system prompt; the SDK owns the model + tool execution. Slash commands are discovered from `.cursor/commands/`, `.cursor/agents/`, built-in subagents, and Agent Skill roots via `cursorSlashCommandDiscovery.ts`. A transport failure can wedge the server-side agent thread while the worker process stays alive, so every local turn carries a 90 s first-event watchdog and one automatic recycle-and-resend — see [Cursor thread recycling and the first-event watchdog](README.md#cursor-thread-recycling-and-the-first-event-watchdog). | `cursorSdkPool.ts`, `cursorSdkWorker.ts`, `cursorSdkProtocol.ts`, `cursorSdkPolicy.ts`, `cursorSdkSystemPrompt.ts`, `cursorSdkEventMapper.ts`, `cursorSdkErrors.ts`, `cursorSlashCommandDiscovery.ts`. |
| `droid` | Factory Droid models exposed as dynamic `droid/<modelId>` descriptors and driven through the official `@factory/droid-sdk` running in a forked Node worker pool. The legacy ACP bridge (`droidAcpPool.ts`) has been retired. | `droidSdkPool.ts`, `droidSdkWorker.ts`, `droidSdkProtocol.ts`, `droidSdkEventMapper.ts`, `droidModelsDiscovery.ts`; model helpers in `modelRegistry.ts`. |
| `pi` | The user's own Pi installation, loaded as a library inside a forked Node worker (never a static import — the worker resolves the installation only after init validation). The worker owns the Pi agent session, its model runtime, its tool registry, and its sign-in; ADE owns the cards the session blocks on. | `piSdkPool.ts`, `piSdkWorker.ts`, `piSdkProtocol.ts`, `piSdkEventMapper.ts`, `piSdkUiBridge.ts`, `piSdkEnvironment.ts`; the shared native session store in `piSessionStore.ts` (resolving the tree, reading headers, authorizing files), `piSessionLease.ts` (the live-writer lock), and `piSessionOwnership.ts` (the durable ownership claim); installation and sign-in in `services/ai/piInstallation.ts` and `services/ai/piAuthService.ts`. |

## Model registry

`MODEL_REGISTRY` is a static catalogue of `ModelDescriptor` records:

```ts
type ModelDescriptor = {
  id: string;             // stable ADE id
  shortId: string;        // CLI-facing token
  aliases?: string[];     // user-facing aliases (e.g. "sonnet", "opus")
  displayName: string;
  family: ProviderFamily; // anthropic | openai | opencode | google | ...
  authTypes: AuthType[];  // cli-subscription | api-key | oauth | openrouter | local
  contextWindow: number;
  maxOutputTokens: number;
  capabilities: { tools, vision, reasoning, streaming };
  reasoningTiers?: string[];
  defaultReasoningEffort?: string; // runtime-recommended initial tier
  serviceTiers?: string[]; // optional provider service tiers, currently "fast"
  color: string;
  providerRoute: string;
  providerModelId: string;
  cliCommand?: string;
  isCliWrapped: boolean;
  deprecated?: boolean;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  costTier?: "low" | "medium" | "high" | "very_high";
  harnessProfile?: "verified" | "guarded" | "read_only"; // local models
  discoverySource?: "lmstudio-rest" | "lmstudio-openai" | "ollama";
  openCodeProviderId?: string;
  openCodeModelId?: string;
};
```

Helpers (also re-exported through `shared/modelRegistry.ts`):

- `getModelById(id)` -- exact id match.
- `resolveModelAlias(alias)` -- resolves user-facing aliases.
- `getDefaultModelDescriptor()` -- default model.
- `resolveModelDescriptorForProvider(provider, modelId?)` -- fallback
  resolution when an agent requests a model not available under a
  specific provider.
- `resolveChatProviderForDescriptor(descriptor)` -- chooses the
  appropriate provider for a given model.
- `resolveProviderGroupForModel(modelId)` -- groups models by
  family/provider-group for handoff decisions.
- `getAvailableModels(opts)` -- filters by auth, discovery, and feature
  flags.
- `getDynamicOpenCodeModelDescriptors()` / `listModelDescriptorsForProvider` -- discovery-aware lists.

Dynamic local-model discovery (`localModelDiscovery.ts`) mutates the
registry at runtime when LM Studio or Ollama report available models.
These descriptors carry `discoverySource` and a `harnessProfile` that
defaults to `guarded` unless explicitly whitelisted.

### Reasoning tiers (Claude)

Claude's global quick-pick vocabulary is `low | medium | high | max`
(`CLAUDE_THINKING_LEVELS` in `shared/modelProfiles.ts`), while model
descriptors advertise their provider-native ladders to model-specific
pickers. Opus 5 exposes `low|medium|high|xhigh|max`; Fable 5.1
and Opus 4.8 add `ultracode`; Sonnet 5 exposes
`low|medium|high|max`; Haiku 4.5 has no reasoning control. The Claude
registry is ordered as
Fable 5.1, Opus 5, Sonnet 5, Haiku 4.5, then Opus 4.8.
Opus 5 selects provider model `claude-opus-5`, defaults to `high`
effort, and exposes `low|medium|high|xhigh|max` plus Fast Mode.
Fable 5.1 selects provider model `claude-fable-5-1`, defaults to `high`
effort, and exposes `low|medium|high|xhigh|max|ultracode` plus Fast Mode.
Sonnet 5 selects provider model `claude-sonnet-5`; retired Sonnet 4.6
ids resolve forward for compatibility and no longer appear as picker
rows. The basic Opus 4.7 row and the Opus 4.7 1M row are both removed;
their old aliases, including `opus[1m]` / `opus-1m`, resolve to Opus 4.8.
The generic `opus` alias selects Opus 5. Retired Fable 5 ids resolve to
Fable 5.1. Opus 4.8 is labelled without a 1M suffix.
Passthrough to the provider config is unchanged (the tier string is
forwarded directly to the CLI / SDK, with no synthesized token budgets).

### GPT-5.6 Codex models

The OpenAI section is pinned in this order on every ADE model surface:

1. `openai/gpt-5.6-sol` (`gpt-5.6-sol`) — default Codex model; 372k context; default effort `low`.
2. `openai/gpt-5.6-terra` (`gpt-5.6-terra`) — 372k context; default effort `medium`.
3. `openai/gpt-5.6-luna` (`gpt-5.6-luna`) — 372k context; default effort `medium`.

GPT-5.5 remains selectable below them. Sol and Terra expose `low | medium |
high | xhigh | max | ultra`; Luna exposes `low | medium | high | xhigh | max`.
Desktop, ADE Code, and iOS label those values Light, Medium, High, Extra High,
Max, and (for Sol/Terra) Ultra. Runtime app-server ladders retain their
advertised order. `ultra` is the multi-agent tier and carries a usage warning.

`selectSupportedReasoningEffort()` centralizes fallback order: keep a valid
explicit selection, then use the model's advertised default, then a valid
surface fallback, then Medium/first tier. All desktop launch surfaces and
handoffs use that helper; ADE Code and iOS mirror the same rule and prefer
host-advertised model metadata over their static compatibility catalogs.

## Auth and credentials

`authDetector.ts` (`detectAllAuth`) probes every provider:

- CLI-wrapped providers (`claude`, `codex`) check for the binary on PATH
  and then for the app's auth token cache.
- Cursor chat authenticates through the SDK (API key / managed
  credential). The Cursor CLI is still not the chat credential source,
  but ADE now probes `cursor-agent` for CLI-launch model inventory and
  merges those rows with the SDK registry so the picker can distinguish
  SDK chat models from Cursor CLI-only models.
- API-key providers check the keychain via `apiKeyStore.ts` and then
  the `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / etc. env vars.
- OAuth providers trigger the OAuth redirect flow in
  `services/lanes/oauthRedirectService.ts`.
- Local providers (`ollama`, `lmstudio`) probe the configured endpoint
  for model availability.

Results feed into the UI's `AiProviderConnectionStatus` /
`AiRuntimeConnectionStatus` (see `providerConnectionStatus.ts`).

### Pi sign-in

Pi is signed into from inside ADE. `piAuthService.ts` drives Pi's own
`ModelRuntime.login(providerId, authType, interaction)` on a dedicated
inventory-only worker, and Settings → Providers renders whatever Pi asks for:
an auth URL, a device code, a text or secret field, or a choice list. Pi has
exactly two login types (`oauth` and `api_key`); a device code is an event
inside an OAuth flow, not a third type.

**ADE never holds the credential.** The worker hands ADE prompt text only, the
user's answer travels straight back through `respondToUi`, and Pi's own
`AuthStorage` writes `auth.json` under its cross-process lock. Nothing that
could be a token is stored, logged, or attached to a status event, and
`registerIpc.ts` redacts the `value` argument of `ade.ai.piLoginSubmit` so an
API key typed into a prompt cannot reach a verbose IPC trace.

Providers are filtered to the ones a sign-in can actually do something with: a
provider whose API key resolves ambiently (env var, cloud profile) has no
interactive `login`, so ADE does not offer to sign into it. One flow runs per
provider at a time — starting another supersedes the first, including a start
that is still acquiring its worker.

A **local model server** is not a sign-in either. `piInstallation.ts` classifies
a provider as `local` from a loopback `baseUrl` rather than from the absence of
a key, and carries that endpoint through on `AiPiProviderStatus.baseUrl`.
Host-based is the point: LM Studio ships `apiKey: "lmstudio"` in `models.json` —
a placeholder its OpenAI-compatible endpoint requires and ignores — so keying
off a key classified a server the user runs as an API provider, offered to sign
into it, and called it connected on the strength of a config file rather than a
reachable server. A stored auth entry still wins, so a provider behind a local
gateway keeps its sign-in.

Signing in unlocks models, so both the IPC handler and the ADE action path
invalidate the provider-readiness caches on success and log
`ai.pi_auth_cache_invalidation_failed` if that fails.

A sign-in settles in the main process, so its outcome travels on the
`piAuthStatus` `success` / `error` event rather than only on the resolution of
the `piLoginStart` call. Settings is destroyed by any navigation, so binding
the result to that one promise — and cancelling the flow when the card
unmounted — meant a sign-in the user completed in their browser could report
nothing, then land as "Sign-in cancelled" over a provider that was in fact
connected. Leaving Settings no longer cancels anything; an abandoned flow is
reclaimed by the ten-minute bound. A user-pressed **Cancel** gives Pi a short
grace window (`PI_LOGIN_CANCEL_GRACE_MS`) to report a login it had already
completed, so a cancel that lost the race is reported as the success it was; a
supersede skips that window. Auth URLs open automatically, with the URL and
device code left on screen for a blocked browser.

ADE does not drive Pi's terminal `/login`. That path typed `/login` into Pi's
TUI after a fixed delay, which raced Pi's startup and usually submitted empty
lines; when `sdkAvailable` is false the card states the instruction instead.

### Session store

SDK chat, tracked Pi CLI terminals, and external-session discovery share **one**
native store, resolved by `piSessionStoreForEnvironment` with Pi's own
precedence: `--session-dir`, then `PI_CODING_AGENT_SESSION_DIR`, then the
profile's global `settings.json` `sessionDir`, then `<agentDir>/sessions`. ADE
never passes `--session-dir`, so the environment variable is effectively the top
of the list. A checkout's `.pi/settings.json` is deliberately not read — it
would let any cloned repository redirect where ADE authorizes and leases
sessions. Pi's own CLI does merge project settings, so a tracked `pi` terminal
launched in such a repository writes somewhere ADE does not authorize;
`repositoryOverridesPiSessionDir` detects that and the launch says so instead of
failing with a generic "could not be verified".

The store **root** and the directory Pi writes into are different things. Pi
nests one directory per working directory (`<agentDir>/sessions/<encoded-cwd>/`)
only when it is told nothing; an explicit directory is used flat and verbatim.
So the worker receives the root as `sessionRoot` (an authorization boundary) and
`sessionStorageDir` only when the user configured one. Handing Pi the root
would scatter files directly into `<agentDir>/sessions`, where Pi's own
subdirectory-only discovery could never read them back.

Pi buffers a new session in memory and writes its JSONL only at the first
assistant message, so a fresh chat names a path that does not exist yet.
`classifyPiSessionFile` answers `pending` for such a path once it is confined to
the store, and the chat leases that exact path straight away — Pi fixes a
session's file name when it creates the session, so no directory-wide token is
needed and two chats in one lane never contend. Only the header check waits for
the flush. The tracked CLI still holds a per-cwd creation lease, because it has
to discover which session Pi made. Discovery scopes by
containment so a project's whole tree stays browsable, but ownership is exact —
`selectPiStorageSessionCandidate` requires the header cwd to match, since a lane
worktree sits inside the primary lane's root.

Two sidecars sit next to each session's JSONL, and they answer different
questions:

- **`<session>.ade-lease`** (`piSessionLease.ts`) — "is someone writing this
  right now". A cross-process lock keyed to the writer's pid and process start
  time, `owner: "sdk" | "cli"`, removed on release and reclaimable once the
  owning process is gone. `piSessionLeaseIsHeld` lets a launch skip a session
  another live writer already holds instead of discovering it by failing to
  acquire the lease after the launch has committed.
- **`<session>.ade-owner`** (`piSessionOwnership.ts`) — "whose session is this".
  A durable `{ owner, ownerSessionId }` claim that is **never** removed, because
  chat and the tracked CLI share one store and time proximity cannot tell a
  chat's session from a terminal's created minutes apart. An unclaimed session
  stays adoptable, so a `pi` run started outside ADE can still be picked up.
  `ownerSessionId` is the ADE chat or terminal session id, deliberately not the
  lease's `ownerId` (a live PTY handle), because it has to survive relaunches.

Before Pi writes anything there is no JSONL to lock, so a tracked CLI launch
holds `piSessionCreationLeaseTarget(sessionRoot, cwd)` — a synthetic token
hashed **per working directory**, since the store root is shared by every
project on the machine and a root-wide token would make one lane's starting Pi
chat block every other lane's. Pi ignores the file; all of its own scans filter
on `.jsonl`.

## Provider config ownership

ADE hands its settings to every provider SDK at the **highest precedence tier
that SDK offers** — above the user's own `settings.json` / `config.toml` /
`opencode.json`, and in some cases above their per-project config too. So the
rule for every adapter is:

> Name a config key only when ADE genuinely owns it — there is ADE UI for it and
> ADE's value is the truth. Otherwise leave the key absent and let the
> provider's own precedence resolve it.

Absence is the only way to say nothing. A substituted default is a real value
that wins, and a value ADE never surfaced is one the user cannot notice or undo.
The rule and the probe results behind it live in
`apps/desktop/src/main/services/shared/providerConfigHomes.ts`; each adapter
states only its own non-derivable fact and points there. **Provider #6 starts
here.**

What "absent" means differs per provider, and each row was verified against a
live runtime rather than read off a schema:

| Provider | Where ADE's settings land | Omitting a key | Explicit `null` / `false` |
|---|---|---|---|
| Claude | Agent SDK `settings` — flag tier, above every `settings.json` the SDK reads | the user's settings chain applies | `"Default"` is a real output style, not "no style" |
| Codex | `thread/start` + `turn/start` JSON-RPC args | `config.toml`'s `service_tier` applies | `null` reports `"default"` — a real downgrade |
| Droid | `createSession` / `updateSettings` SDK options | `~/.factory/settings.json` applies, resolved **per key** | `null` wedges the Droid RPC for 30 s — never send it |
| Cursor | `local.sandboxOptions` on the SDK agent options | `~/.cursor/sandbox.json` decides | `false` returns `insecure_none` without ever reading that file |
| OpenCode | `OPENCODE_CONFIG_CONTENT` | the user's `opencode.json` applies | n/a — this env var deep-merges **last**, so any key ADE names wins |

### Provider config homes

`providerConfigHomes.ts` also resolves where each CLI keeps its user-level
config, because every one has an env override the provider's own binary honours
and **the overrides do not share a shape**:

| Helper | Env override | Shape | Default |
|---|---|---|---|
| `claudeConfigHome()` | `CLAUDE_CONFIG_DIR` | names the config **directory** | `~/.claude` |
| `codexConfigHome()` | `CODEX_HOME` | names the config **directory** | `~/.codex` |
| `factoryConfigHome()` | `FACTORY_HOME_OVERRIDE` | replaces the **HOME** that `.factory` is appended to | `~/.factory` |

Hardcoding `~/.codex` or `~/.factory` makes ADE read a different directory than
the process it spawns, so ADE and the CLI disagree about the user's
configuration inside a single session. Every path into a provider config home
goes through these helpers: chat adapters, the Droid custom-model merge in
`droidModelsDiscovery.ts`, PTY session recovery in `ptyService.ts`, and
external-session discovery (`providerSessionHandles.ts`, `discoverDroid.ts`).
`homeDir` is passed explicitly by callers that already resolved a home of their
own; everything else resolves `homedir()` inside the helper.

### What each adapter states

**Claude.** ADE sends `enabledPlugins` (the CLI merges it per plugin key rather
than replacing the map) and `fastMode` (the composer's Fast chip owns it).
`outputStyle` is sent only when a settings file actually names one, and
`workflowSizeGuideline: "medium"` only when no settings file states one — ADE's
preferred default, supplied rather than imposed.
`readClaudeOutputStyleSelection` and `readClaudeWorkflowSizeGuideline`
(`claudeOutputStyles.ts`) resolve a key across the same files, in the same
order, that the SDK itself resolves with `settingSources: ["user", "project",
"local"]` — lane `settings.local.json`, lane `settings.json`, each ancestor
root, then the user root — and return `null` when no file declares it.
Two traps this closes: substituting `"Default"` suppresses a globally
configured style, and materialising a fallback onto the session record makes it
read back as a real choice on the next launch, pinning it forever. The session's
own cached value is therefore consulted *after* the settings files, not before.

The precedence walk honours `CLAUDE_CONFIG_DIR` as well, and so does the plugin
registry (`<claudeConfigHome>/plugins/installed_plugins.json`). A lane normally
sits under `$HOME`, so the ancestor walk would reach the real `~/.claude` and
rank it as a *project* tier above the user tier; when `CLAUDE_CONFIG_DIR` has
moved the user tier elsewhere, that stale directory would outrank the one the
CLI actually reads, so the real `~/.claude` is skipped from the ancestor walk in
that case. Root de-duplication and the project/user source labelling both
compare through `pathKey` / `pathsEqual` rather than raw strings, because
Windows reaches the same directory through more than one spelling and a
duplicate root would shadow the tier below it.

**Codex.** Service tier is stated only when the Fast chip is on
(`serviceTier: "fast"`); otherwise the key is omitted so `config.toml`'s
`service_tier` resolves. Fast-off cannot mean "force default" either: `fastMode`
is persisted only when true and rehydrated as `persisted?.fastMode === true`, so
`false` is indistinguishable from never-set. The app-server re-resolves per
request, so a turn sent after the toggle goes off inherits the config again.

Reasoning effort travels **per thread** (`codexThreadConfigArgs`), never as a
`-c model_reasoning_effort=…` flag on the `codex app-server` process. That flag
outranks the user's `config.toml` and applies to every thread on that
app-server, not just the chat that set it.

**Droid.** `resolveSessionDroidPermissionModeOrNull` returns the mode the user
actually chose, or `null`. Droid has no "use my config" mode — `cliLaunch`
rejects `config-toml` for it — so `null` is the only way ADE can say nothing,
and `autonomyLevel` / `interactionMode` are then both omitted from the SDK
options, each resolving independently from `~/.factory/settings.json`. This
matters because Droid's own documented default is `autonomyLevel: "off"`
(read-only): a substituted `auto-low` fallback would hand out write access the
CLI would not. `normalizeSessionNativePermissionControls` deletes the field
rather than materialising a fallback, for the same reason as Claude's output
style.

When ADE does state a mode, Spec pairs with `autonomyLevel: "off"` — Droid
collapses its compound autonomy mode to `spec` and reads it back as level `off`,
so anything else is a claim Droid discards — which matches what
`droidSettingsJson` already sends on the terminal path.

Spec is the one place ADE has to speak up to stay quiet. The SDK exposes no
`exitSpecMode`, so the only way out is to state a mode, and a plan session that
later turns plan off states nothing. The worker therefore tracks whether ADE
itself entered Spec (`enteredSpecMode` in `droidSdkWorker.ts`) and states `Auto`
exactly once to leave, then goes back to saying nothing. The flag is reset on
init and on dispose.

`buildReady` reads the resolved model from `initResult.settings.modelId`.
`initResult.currentModelId` does not exist in `@factory/droid-sdk`; reading it
always yielded `null`.

**Cursor.** The sandbox is a three-state directive, not a boolean:
`CursorSdkSandboxDirective = "enable" | "disable" | "inherit"`
(`cursorSdkPolicy.ts`). `inherit` omits `local.sandboxOptions` entirely so
`~/.cursor/sandbox.json` decides. `disable` sends `{ enabled: false }`, which
returns `insecure_none` without reading that file at all — which is exactly what
ADE's full-access mode means, and what the retry after a `ConfigurationError`
needs when the environment cannot sandbox and the alternative is a hard failure.
`enable` asks for a sandbox, and a user policy still wins over ADE's: the SDK
falls back to its own `workspace_readwrite` default only when the user has
written no policy at all. The directive, not a boolean, is what the local
permission fingerprint and the worker's ready payload carry, so a change between
the three states restarts the agent options.

**OpenCode.** `OPENCODE_CONFIG_CONTENT` deep-merges last, so anything
`buildOpenCodeConfig` names outranks the user's `opencode.json` and only
managed/MDM config beats it. `share` and `snapshot` are therefore omitted —
neither has ADE UI, and forcing `snapshot: false` silently disabled OpenCode's
own `/undo` and `/revert`, whose documented default is `true`. `autoupdate`
moved out of config into `OPENCODE_DISABLE_AUTOUPDATE=1` on the server env: ADE
does pin the binary, but that does not need the highest-precedence config slot.
Both env builders set it — `buildIsolatedOpenCodeEnv` rebuilds the env from
scratch and drops every inherited `OPENCODE_*` var, so an orchestration lead's
isolated server would otherwise self-update the binary ADE pinned.

Local provider blocks (`ollama`, `lmstudio`) are emitted only when the user
configured an endpoint or ADE discovered models for that family. An
ADE-invented `baseURL` merges over the endpoint in the user's own
`opencode.json`, repointing a configured remote host back at localhost.
`lmstudio` ships in OpenCode's provider catalog with its own npm package and
baseURL, so only `ollama` needs `npm` stated.

ADE's four agent profiles are `hidden: true`. They are ADE's permission modes,
not agents the user should meet in Tab-cycle or `@`-autocomplete; without a
`mode` they default to `"all"` and show up in the picker. `ade-helper` uses
`steps: 1` (`maxSteps` is the deprecated spelling).

ADE's system prompt is neither config nor a message part: every turn carries it
on the chat request body's first-class `system` field. It must never be injected
as a `synthetic`/`ignored` text part — OpenCode drops `ignored` parts from model
context entirely, so a part-shaped injection silently never reaches the model.
Session re-attach follows the same fail-loud spirit: when a persisted session id
fails `session.get`, only a confirmed 404 (`isOpenCodeNotFoundError`) falls
through to fresh-session creation; any other error surfaces rather than
silently resetting the thread into a new empty session.

## Permission modes

Permission controls are provider-native. The session carries an abstract
`permissionMode` alongside provider-native fields.

### Claude

`AgentChatClaudePermissionMode`:

| Mode | Behavior |
|---|---|
| `default` | Claude CLI built-in permission flow. |
| `plan` | Read-only; writing/executing blocked. |
| `acceptEdits` | Writes allowed; shell commands require approval. |
| `bypassPermissions` | Proceed without asking. |

Claude permission mode can be changed mid-session via the SDK
(`query.setPermissionMode(...)`).

### Codex

Two independent controls:

- `AgentChatCodexApprovalPolicy` -- `untrusted | on-request | on-failure | never`.
- `AgentChatCodexSandbox` -- `read-only | workspace-write | danger-full-access`.
- `AgentChatCodexConfigSource` -- `flags | config-toml`. When
  `config-toml`, ADE defers both controls to the project's
  `.codex/config.toml`.

The chat adapter translates ADE's persisted kebab-case approval/sandbox
values into the Codex app-server wire format at the JSON-RPC boundary:
`on-request` -> `onRequest`, `untrusted` -> `unlessTrusted`,
`on-failure` -> `onFailure`, and `workspace-write` -> `workspaceWrite`.
Every `thread/start` and `thread/resume` call passes `{ model, cwd,
config: { model_reasoning_effort, mcp_servers? },
...codexPolicyArgs, ...codexServiceTierArgs(session) }`. The return envelope is consumed by
`applyCodexEffectiveThreadState`, which normalizes `approvalPolicy`,
`sandbox` (including the camel-case aliases `readOnly` /
`workspaceWrite` / `dangerFullAccess` that the server emits), and
`reasoningEffort`. That snapshot becomes the session state, so the
picker chips always show what the runtime actually applied. On resume,
the persisted chat state is re-written after normalization instead of
being re-copied from the on-disk file. For ADE-controlled flag modes,
the explicit policy sent with `thread/resume` remains authoritative when
the lifecycle response echoes an older thread policy; this keeps a
manual picker switch from snapping back to Plan before the next
`turn/start`. When `codexConfigSource` is `config-toml`, ADE sends no
policy override and the server's reading of `.codex/config.toml` wins
over a stale persisted pair. Turns use the Codex-native `effort` key
(`turn/start({ threadId, input, effort?, serviceTier? })`) instead of
the lifecycle `reasoningEffort` name.

The 0.144.5 server-request surface is handled in the same adapter. ADE answers
`currentTime/read` with `{ currentTimeAt: <whole Unix seconds> }`.
`mcpServer/elicitation/request` becomes the unified pending-input UI for form
and URL modes; primitive/enum/multiselect fields are coerced back into the
requested schema. `serverRequest/resolved` clears a pending card when the
server resolves it elsewhere. Elicitations are never silently approved by
full-auto mode, and `Always allow` is sent only when the request `_meta`
explicitly permits persistent consent. JSON-RPC envelope decoding tolerates the
`emittedAtMs` field that 0.145 adds to notifications, so a newer server's
timestamp envelope never fails a decode.

The adapter records the server's version so behavior can be gated per build.
The `initialize` response's `userAgent` is parsed by `parseCodexServerVersion`
into `runtime.serverVersion` (`{ major, minor, patch }`, or `null` when the
string is unrecognized). Two adapter helpers normalize the shapes that shifted
across 0.144→0.145: `normalizeCodexTokenBreakdown` folds the upstream
`cacheWriteInputTokens` / `reasoningOutputTokens` fields into ADE's
`cacheWriteTokens` / `reasoningTokens` (older `cacheCreationTokens` aliases still
resolve), and `normalizeCodexRateLimits` carries `spendControlReached` (the
account-level spending-cap flag) alongside `remaining` / `limit` / `resetAt` on
both the initial `account/rateLimits/read` and the streamed
`account/rateLimits/updated` notification.

#### Codex rewind and 0.145 readiness

Chat file-rewind selects a user message, reconstructs its turn from the durable
transcript, and asks the app-server to move the thread back. The rewind plan now
also resolves the message's `targetTurnId` from the transcript envelopes so the
adapter can pick the right server call:

- **Servers ≥ 0.145.0 with a resolvable turn id** use `thread/fork` with
  `{ threadId, beforeTurnId }`, forking the thread immediately before the target
  turn.
- **Older servers, or a target without a usable turn id,** fall back to the
  deprecated `thread/rollback` with `{ threadId, numTurns: 1 }`, which only
  rewinds the latest user message.

`codexServerSupportsForkBeforeTurn(runtime.serverVersion)` (true for
`major > 0` or `minor >= 145`) gates the choice. Invariant: `beforeTurnId` is
never sent to a `< 0.145` server — the fork path is taken only when both the
version check passes and a `targetTurnId` is present. Either response feeds
`applyCodexEffectiveThreadState` and re-pins the resume command to the resulting
thread id; ADE's git-backed per-file restore plan runs the same way in both
cases.

What is version-gated today is exactly this fork-before-turn rewind. `thread/rollback`
is deprecated upstream but retained for `<= 0.144` servers and for turns without
a usable id, so it is not removed. Separately, 0.145 removes `mcpToolCall`
`appContext.templateId` from the upstream schema; ADE keeps the field optional
so historical transcripts that recorded it still decode. Finally, 0.145's
paginated resume (`thread/resume` with backwards cursors and a paginated
`historyMode`) is a future opt-in worth evaluating for faster resume on large
threads — it is not adopted today because it requires `excludeTurns` and gives
up full-history resume, so the current adapter continues to resume whole threads.

On macOS, an explicitly enabled Codex Computer Use plugin/config adds the
verified standalone `SkyComputerUseClient` under
`config.mcp_servers.computer_use`. The merge is applied on fresh thread start,
thread resume, recovery resume, and goal-control thread resume. Tracked Codex
CLI launches/resumes receive equivalent `-c mcp_servers.computer_use.*`
overrides. This bypasses host-process signing problems without weakening the
MCP elicitation boundary; see [Computer-Use Backends](../computer-use/backends.md#codex-computer-use-current).

For Codex and the other coding-agent paths, ADE's worktree guidance is
write-scoped rather than read-scoped: the launched lane worktree is the
only place the agent should edit files or run mutating commands, while
read-only inspection outside that path is allowed when it needs context.
This wording appears in both the system prompt and the first-turn launch
directive so resumed/continued sessions keep the same boundary.

#### Provider service tiers (Fast Mode)

`ModelDescriptor.serviceTiers?: string[]` advertises the optional
service tiers a model accepts (today only `"fast"`). The composer's
**Fast** toggle (a yellow Lightning chip next to the model picker)
shows whenever `modelSupportsFastMode(descriptor)` is true for the
selected model, independent of provider. `AgentChatSession` carries
`fastMode?: boolean`; the deprecated persisted/input alias
`codexFastMode` is still accepted at boundaries for old rows and remote
clients.

Codex forwards Fast as `serviceTier: "fast"` on every `turn/start` and
`thread/start` JSON-RPC call, and **omits the key entirely** when Fast is off so
the user's `config.toml` `service_tier` resolves — an explicit `null` reports
`"default"`, which is a real downgrade ADE has no UI for. See
[Provider config ownership](#provider-config-ownership). Claude Fable and Opus descriptors advertise
`serviceTiers: ["fast"]`; Claude chat sends the effective flag through
the Agent SDK `settings.fastMode` layer, and Claude CLI launches/resumes
pass `--settings '{"fastMode":true|false}'` so ADE can explicitly
override user/project Claude settings when the chip is on or off. Claude
Sonnet and Haiku rows do not advertise Fast, and ADE leaves Claude's native
`/fast` slash command to the runtime instead of intercepting it.

Cursor SDK sessions resolve the flag through `cursorModelsDiscovery`
into the matching model parameter. Work CLI launches use the Cursor
descriptor's fast alias (`*-fast`) when the same flag is enabled. The
flag persists with the session, survives reload through
`PersistedChatState`, and is forwarded to remote devices through the
sync command service.
Parallel-model rows track Fast mode per slot
(`ParallelModelRowState.fastMode`) so launching multiple
fast-capable runs side-by-side can mix Fast and Standard turns. Codex
discovery populates `serviceTiers` from app-server-reported
`additionalSpeedTiers` / `serviceTiers` rows; the static registry
pre-marks GPT-5.6 and older fast-capable Codex CLI entries. Cursor discovery
populates `serviceTiers` from SDK/CLI parameters and folds CLI
`*-fast` rows into their base descriptors as aliases. OpenCode maps Fast
to the provider variant `fast` in chat prompt bodies; Work CLI launches
carry no variant at all — the root TUI has no `--variant` flag, so tracked
launches keep only the permission agent and model.
Droid preserves Factory's concrete fast model IDs when they are reported,
and its canonical Anthropic normalization also publishes `serviceTiers:
["fast"]` for fast-capable rows such as Opus 5. The former launch as the
selected concrete model; the latter use the same independent Fast toggle as
the other provider surfaces.

Codex plan mode uses the native app-server planning flow. ADE passes its
runtime guidance as an ordinary system-context input item and keeps
`collaborationMode.settings.developer_instructions` null, then turns
completed Codex `plan` items (including `<proposed_plan>` wrappers) into
ADE plan-approval requests. Accepting that request moves the session to
`full-auto`/default mode and starts the implementation turn — the user
already reviewed exactly what the plan will do, so `stageCodexPlanApprovalFollowup`
hands the session straight to full access rather than dropping to `edit`
and gating every file change behind another approval round that would just
relitigate the plan.

Default Codex chats map to the "Default permissions" preset
(`workspace-write` + `on-request`). The older implicit fallback that
mapped CLI `edit` mode to `untrusted` was removed so the first-turn
picker state matches the documented default; the explicit Codex
`edit` preset still resolves through the picker path.

### OpenCode

`AgentChatOpenCodePermissionMode`:

| Mode | Behavior |
|---|---|
| `plan` | Read-only. |
| `edit` | Read/write allowed; bash gated. |
| `full-auto` | Proceed without asking. |

Each mode is an `agent` entry in the config ADE ships through
`OPENCODE_CONFIG_CONTENT`, carrying an explicit `permission` block.
`OpenCodePermissionKey` in `openCodeRuntime.ts` names the keys ADE sets; the
OpenCode SDK's own type declares only five of them and absorbs the rest through
an index signature, so a misspelled key compiles and silently fails to apply
(`websearch` vs `web_search` is a pair this codebase has already been bitten by).

- **`plan` denies `task`, not just `edit`.** A spawned subagent runs under its
  own ruleset — OpenCode's `general` agent is `merge(base, todowrite: deny)`,
  i.e. edit *allowed* — so leaving `task` open let a plan-mode session write
  files through a child session. Plan has to mean plan. Plan also denies
  `websearch` and `skill`; that is the supported spelling of what the deprecated
  agent-level `tools` map used to express, since OpenCode desugars that map into
  exactly these permission entries and an explicit `permission` block wins over
  it.
- **`full-auto` states `read: "allow"` and `task: "allow"`.** Most ungated keys
  resolve to `allow` from OpenCode's base `*` rule, but `read` does not: the base
  ruleset asks before reading `*.env` / `*.env.*`, so full access still prompted.
- **No ADE ruleset states `external_directory` at all.** The boundary itself
  still holds — it is ADE's lane worktree, not a permission tier the user picked,
  the same reason the system prompt confines edits to the lane — but omitting the
  key is how ADE gets it. OpenCode's own default for the key is
  `{"*": "ask", <tmp>: "allow", <skill dirs>: "allow", <reference dirs>: "allow"}`.
  A bare string expands to a single `{pattern: "*"}` rule, an agent block's rules
  are appended *after* the defaults, and lookup is a `findLast` over the merged
  list — so a bare value wins for every path and silently revokes OpenCode's
  access to its own temp, skill, and reference directories. That is true of
  `"deny"` as much as `"ask"`, which is why `ade-plan` and `ade-helper` drop the
  key too. That does loosen them: both used to hard-deny every outside-worktree
  path and now ask for one. Each ask has an answer, which is what makes it
  acceptable — plan raises an approval card the user decides, and a helper ask is
  rejected on arrival by the `permission.asked` responder in
  `runOpenCodeTextPrompt`, because a one-shot prompt has no UI and an unanswered
  ask would hang it until the caller aborts. The rule binds all four rulesets and
  is pinned by the test "never states external_directory on any ADE ruleset".

### Pi

Pi's built-in tool registry contains only `read`, `bash`, `edit`, and `write`,
and its `tools` option is one flat allowlist — anything unlisted is dropped.
Passing ADE's generic `grep`/`find`/`ls` names would make the SDK launch fail.

Chat and tracked-CLI Pi sessions therefore use **two different mappings**, both
in `shared/cliLaunch.ts`:

- `piToolsForPermissionMode` — the allowlist-only mapping used for tracked
  terminals, where ADE has no gate of its own.
- `piSdkToolPolicyForPermissionMode` — the chat mapping, where ADE can hold each
  call behind an approval card.

| Mode | `tools` | Gated behind an approval card | `readOnly` |
|---|---|---|:-:|
| `plan` | `read` | — | yes |
| `edit` | `read`, `edit`, `write` | — | no |
| `full-auto` | `read`, `bash`, `edit`, `write` | — | no |
| `default` (also `auto`, `config-toml`) | `read`, `bash`, `edit`, `write` | `bash`, `edit`, `write` | no |

`default` in a Pi chat therefore means **ask before anything that changes the
workspace**, not read-only. Every workspace-changing capability is offered
rather than silently allowed or silently withheld. `readOnly` is stated on the
policy rather than inferred from the tool list, because callers gate real
capabilities on it.

The gate is not advisory. `bash`, `edit`, and `write` are rebuilt from Pi's own
root-exported definition factories (`createBashToolDefinition` and friends) and
re-registered through `customTools` under the same names, so they keep Pi's
schema, prompt text, and rendering while acquiring the gate; a gated `bash`
still honours the user's configured shell path and command prefix. If a Pi build
does not export the factory for a tool, that tool is **withheld** rather than
granted ungated — granting it would silently downgrade the permission mode —
and its name comes back on the ready payload as `ungateableTools`, which the
chat surfaces as a notice.

An approval answered "allow for this chat" is remembered per tool name for the
life of the session. A dismissed card or an aborted turn denies the call, and a
denial is raised as a thrown error because Pi marks a tool call failed only when
`execute` throws.

Pi's tool allowlist and extension binding are fixed when the worker is created,
so `startPiRuntime` records a `toolPolicyKey` (tools + approval tools +
extensions on/off) on the runtime and restarts the worker whenever it changes.
Without that, a session switched from `default` to `plan` would keep its write
tools until something else happened to restart it.

### Cursor

Cursor modes (`apps/desktop/src/shared/cursorModes.ts`) are a list of
configurable mode IDs; ADE stores a `cursorModeSnapshot` on the session
carrying the current mode, available mode IDs, and selected config
options. Cursor model descriptors also carry `cursorAvailability`:
SDK-capable rows are eligible for chat sessions, CLI-capable rows are
eligible for Work CLI launches, and rows with both flags appear in both
surfaces.

`resolveCursorSdkPolicy` (`services/chat/cursorSdkPolicy.ts`) turns the ADE
permission mode into a `CursorSdkPermissionPolicy`: chat mode, approval policy,
sandbox mode, hard guards, orchestration-lead flag, and a `fullAuto` marker.
`buildCursorSdkLocalRunOptions` then reduces that policy to the SDK's local run
options, where the sandbox is a three-state `CursorSdkSandboxDirective`
(`enable` / `disable` / `inherit`) rather than a boolean — see
[Provider config ownership](#provider-config-ownership) for why absent and
`false` are not the same thing to `@cursor/sdk`.
`fullAuto` is only the name of ADE's full-auto permission mode — it partitions
the worker pool and labels logs. It is deliberately not wired to the Cursor
SDK's `local.force` send option, which expires the currently active persisted
run: that is a recovery action, not a permission level, and it is reachable
only through `CursorSdkSendPrompt.forceExpireActiveRun` on ADE's automatic
recovery re-send. Conflating the two would let a full-auto session silently
discard a turn that was still working.

Cursor is also the one provider whose local fork is not a provider fork.
`@cursor/sdk` exposes no fork/clone/branch operation and a Cursor thread cannot
be resumed twice, so ADE's fork opens a fresh Cursor agent and replays the
whole source transcript into it verbatim (bounded by the target model's context
window) — the same replay staged when a wedged thread is recycled.
`providerForkReplaysTranscript` marks it so the handoff UI describes what
actually happens, and so cross-machine fork excludes it (there is no provider
artifact to transport).

Cursor is likewise the one non-Claude provider that can take a message *during*
a live turn, and it takes it differently. The SDK has no mid-run message API, so
`ACTIVE_TURN_DISPATCH_MODES` (`shared/types/chat.ts`) gives Cursor `interrupt`
and `queue` but no `inline`: the redirect stops the run, waits for the turn to
settle, and sends the message as the next turn on the same agent, which keeps
the thread because the SDK's local agent store holds it. That is what
`activeTurnInterruptContinues` records, and why every surface labels Cursor's
affordance "Interrupt & continue" rather than "Interrupt & send". Because that
stop exists only to resend, it runs in `stop_only` mode with
`preserveQueuedSteersOnInterrupt` armed on the Cursor runtime until the
interrupted turn's own tail consumes it, so messages the user had already staged
ride through the redirect instead of being cleared. `interrupt-replace` on
OpenCode, Pi and Droid keeps its `stop_and_clear` contract.

### Abstract-to-native mapping

`AgentChatPermissionMode` is `default | auto | plan | edit | full-auto | config-toml`.
`providerOptions.ts` exposes `mapPermissionModeToNativeFields()`, which
translates the abstract value into the correct provider-native fields:

- `claude`: `claudePermissionMode = "default" | "auto" | "plan" | "acceptEdits" | "bypassPermissions"`. The `auto` mode hands permission decisions to the SDK's automatic gate and surfaces in the desktop and `ade code` permission pickers alongside the existing modes.
- `codex`: `codexApprovalPolicy` + `codexSandbox` pair.
- `opencode`: `opencodePermissionMode = "plan" | "edit" | "full-auto"`.
- `cursor`: `opencodePermissionMode` carries the collapsed level, and
  `cursorModeId` carries the native mode Cursor itself names.
  `legacyPermissionModeToCursorModeId` (`shared/cursorModes.ts`) maps
  `full-auto` -> `"full-auto"` and `plan` -> `"plan"`, and returns **null** for
  everything else: `default` and `edit` both run as Cursor `agent`, and `ask` is
  a deliberate user choice with no legacy spelling. Returning null keeps absence
  absent for the same reason Droid does — a materialised `agent` is read back as
  a real selection on the next launch and pins the chat to it. The derivation
  fills only when the caller named no mode
  (`applyCursorModeIdFromLegacyPermissionMode`, run from both
  `normalizeSessionNativePermissionControls` and
  `hydrateNativePermissionControls`), so an explicit `cursorModeId` always wins;
  an explicit `permissionMode` **update** overwrites through
  `applyLegacyPermissionModeToNativeControls`, so lowering the level clears a
  derived `full-auto` instead of leaving it pinned. Without this a
  `permissionMode`-only create — `ade new chat --provider cursor --permissions
  full-auto`, `chat.createSession`, mobile/web `chat.create`, the `@ade-dev`
  SDK — ran full-auto while every mode-reading surface reported `agent`.
- `droid`: `droidPermissionMode = "read-only" | "auto-low" | "auto-medium" | "auto-high" | "agi"`, or **absent** when the user has picked nothing. Absent is meaningful: it lets `~/.factory/settings.json` resolve autonomy, so nothing materialises a fallback onto the session. See [Provider config ownership](#provider-config-ownership).
- `pi`: no provider-specific permission field — the abstract `permissionMode`
  *is* Pi's native field. It is read directly by
  `piSdkToolPolicyForPermissionMode` (chat) or `piToolsForPermissionMode`
  (tracked CLI) and becomes a tool allowlist plus an approval-tool list. Chat
  reads the session's own mode rather than the collapsed harness mode, because
  the approval gate makes `default` meaningfully different from `edit` there.
  The renderer's `summarizeNativeControls` therefore branches on `pi` and
  writes back only `permissionMode`: the main process deletes
  `opencodePermissionMode` from a Pi session, so falling through to the
  OpenCode tail reported whatever that absent field defaulted to and silently
  downgraded a full-auto Pi chat to edit on the first composer interaction.

The abstract field is persisted alongside the native fields so the UI
can summarize session state consistently, and so legacy flows that only
know about the abstract mode still work.

### Interaction mode

`AgentChatInteractionMode` is `default | plan`. When `plan`, the agent
operates in read-only planning mode and proposes changes via
`ExitPlanMode`.

Entering plan mode moves the **access** mode too, not just the interaction
mode: `applyClaudePlanModeTransition` (`services/chat/claudePlanMode.ts`) sets
`claudePermissionMode = "plan"` and stashes the suspended access mode in
`claudePrePlanAccessMode`, restoring it on exit. That field is persisted and
rehydrated with the rest of the session, so a restart mid-plan does not lose it.

This matters because `claudePermissionMode` is both what the composer's mode
chip renders and what the `ExitPlanMode` gate reads. While it stayed on the
pre-plan value, a `bypassPermissions` session entering plan mode kept reading
as bypass: the chip never left Bypass, nothing was actually restricted, and the
gate auto-approved the plan without rendering an approval card. Plan mode was
cosmetic in exactly the sessions where review matters most.

A session that is genuinely in plan mode therefore never reads as
`bypassPermissions` or `full-auto`, and always gets an approval card. The
auto-approve branch in the `ExitPlanMode` interception remains only as a
safety net for sessions persisted before this behavior existed, which can
resume with `interactionMode: "plan"` and a stale access mode; it logs
`agent_chat.plan_auto_approved_stale_session` when it fires. Do not widen it —
entering plan mode is a request for review.

When the user approves an `ExitPlanMode` call, the canUseTool handler
returns `{ behavior: "allow", updatedInput: input }` so the SDK's native
`ExitPlanMode` handler runs, restores the pre-plan permission mode from
its `toolPermissionContext.prePlanMode`, and emits a normal
`tool_result` back to the model. ADE additionally calls
`setPermissionMode` defensively so the SDK and ADE agree on the target
mode even if the SDK's restore path no-ops, but the SDK is still the
source of truth. (Previously we returned `behavior: "deny"` to dodge a
ZodError in the SDK's input schema; that is no longer necessary and the
deny path made the model hesitate after a "denied" tool call.)

## Model selection flow

1. User picks a model in `ProviderModelSelector` (under
   `renderer/components/shared/`).
2. Renderer resolves a `ModelDescriptor` via `getModelById` /
   `resolveModelDescriptorForProvider`.
3. The descriptor determines the provider (`providerRoute`), routing
   module, and default reasoning tier.
4. `createSession(args)` creates the session with both the descriptor's
   `shortId` as `model` and its canonical id as `modelId`.
5. The service resolves the correct adapter and spawns the runtime.

For Claude, `resolveClaudeCliModel()` translates the descriptor into
the CLI's expected model token. For Codex, `agentChatService.ts` builds the
app-server startup and thread configuration while `codexExecutable.ts` resolves
the packaged/PATH binary.

## Model switching mid-session

`chatModelSwitching.ts` rules:

- `ChatModelSwitchPolicy` is either `"same-family-after-launch"` or
  `"any-after-launch"`.
- `canSwitchChatSessionModel(session, targetDescriptor)` returns true
  only when the policy permits. CTO and persistent-identity sessions
  default to `"any-after-launch"`; regular chat defaults to
  `"same-family-after-launch"` to avoid spurious handoffs.
- `filterChatModelIdsForSession(ids, session)` filters the model picker
  to the models the user may switch to without triggering a handoff.

Changing models triggers a **handoff** (`handoffSession`), which splits
into two strategies depending on whether the source and target both run
on the Claude Agent SDK:

1. **Fork (Claude → Claude).** When both ends are Claude runtimes, the
   service pins the source `sdkSessionId` as the new session's
   `forkFromSdkSessionId` and starts the next `query()` with
   `options.forkSession = true`. The SDK forks the SDK session graph
   server-side so the new chat keeps the full conversation and tool history
   without a summary round-trip. `forkFromSdkSessionId`
   is persisted through `PersistedChatState` and re-applied on resume so
   forked descendants survive app restart.
2. **Brief (cross-runtime).** When the target leaves the Claude family
   (or the source is non-Claude), the service falls back to a
   12-message handoff brief built by `generateHandoffBrief()`:
   summarize the current session, end it gracefully, create a new
   session with the target model, and inject the brief as a continuity
   message. The injected user message stores the full continuity prompt
   internally while exposing a short `displayText` breadcrumb with
   `metadata.hideFullPrompt`, so desktop transcripts do not show or copy
   the internal brief body as ordinary user-authored text.
   `buildDeterministicHandoffBrief()` provides a deterministic
   fallback when the session-intelligence chain is empty, the LLM
   summarization call fails, or no eligible summarizer is available;
   `AgentChatHandoffResult.usedFallbackSummary` surfaces which path was
   taken. An empty candidate list still returns that brief — it does
   not throw or skip the handoff.

## Auto-title generation

Sessions auto-title through two stages when
`ai.sessionIntelligence.titles.enabled` is true and the runtime is not `guest`:

- **Initial** -- generated early in the conversation from the first
  user message, providing an immediate label while the session is still
  brief.
- **Final** -- generated once enough transcript has accumulated,
  producing a more accurate title.

`ai.sessionIntelligence.titles.refreshOnComplete` (default true) triggers a final
refresh after a turn completes.

Both stages walk the shared naming chain built by `buildSessionIntelligenceModelCandidates`
in `sessionNaming.ts` — the configured `titleModelId` when set, then this
chat's model — and run it through `runNamingAcrossProviders`. There is no
hardcoded Haiku or "first available" namer. A provider-level failure
condemns every remaining model behind that provider. An empty candidate
list is a no-op walk and still uses the deterministic title; naming does
not throw or skip just because no model is configured.

Six words is the guideline the prompt gives the model, not a rejection rule: a
seven-word title is clamped to the first six rather than discarded, and an
over-long title is cut on a word boundary so it never stops mid-word. If every
candidate fails (or none exist), the chat falls back to a title derived
deterministically from the seed prompt — the same derivation an automatically
created lane uses — so a chat with a real prompt never sits on its provider
default title. The fallback only rescues a still-default title, and only when
it produces at least two words.

Manual renaming sets `manuallyNamed: true`, which permanently
suppresses further auto-title generation. The manual-rename check runs *before*
the title write, not after, because adopting a title has side effects (session
meta, runtime push) that a rename landing mid-request must stop.

The same chain — Settings title/summary model, then this session's model,
then deterministic — covers chat titles, end-of-session summaries, explicit
session-metadata regeneration, automatic lane names, handoff briefs, and
identity-continuity summaries. CLI titles and terminal summaries are
separate: they try the title/summary setting, then the stored launch model,
and skip the AI call when both are missing. See
[AI-driven titles](../terminals-and-sessions/pty-and-sessions.md#ai-driven-titles).

## One-shot utility tasks

Commit messages, PR drafts/summaries, and conflict proposals pick a
model once: the caller argument, else the feature picker in Settings,
else skip or throw a Settings prompt. Review start requires an explicit
run `modelId` (not a Settings feature picker). There is no hardcoded
Haiku / Sonnet / "first available" namer.

- Commit messages and conflict proposals throw `Choose a … model in Settings`.
- PR drafts and PR AI summaries use the deterministic template when the
  picker is empty; `requireAi` callers throw the Settings prompt instead
  of a stub.
- Review start requires an explicit `modelId` on the run. Empty throws
  `Choose a review model before starting a review.` Launch context may
  advertise a Codex catalog `recommendedModelId` as a picker hint; the
  service never fills a model if the caller omits one.
- Live chat compaction is unchanged — it always uses the chat's own
  provider.

Every one-off call — the session-intelligence chain above and the utility
tasks here — reaches its provider through `runProviderTask`. Every Cursor
one-off runs on the pooled worker, through `runCursorSdkLocalPrompt` in
`cursorSdkPool.ts`: it gets the sandbox-unsupported fallback, agent retries,
trimmed setting sources, a throwaway state root, and an agent that is closed
instead of leaked. Never call `Agent.create` in the host process.

The pool keeps one worker per workspace path and API key for a short idle
window, so a three-model naming chain forks Node once, and it caps the warm
one-shot workers at `CURSOR_SDK_LOCAL_ONESHOT_MAX_WORKERS`, releasing the idle
least-recently-used one to make room. Every send carries `resetConversation`,
so no one-shot inherits the previous one-shot's conversation. A one-shot is a
tool-less text task: it always runs under the fixed `CURSOR_SDK_ONESHOT_POLICY`
and every tool call it makes is denied, so the caller's permission mode decides
nothing here.

`regenerateSessionMetadata` reports why a chain produced nothing.
`runNamingAcrossProviders` returns `lastFailure`, and the result carries it as
`generationError` alongside `usedDeterministicFallback`. When nothing was
applied the Work tab states that reason instead of always blaming a concurrent
rename. Cursor Cloud chats skip that chain: Cursor owns the agent name, so
`updateSession`, `regenerateSessionMetadata` (title), auto-title, and the
user-facing meta writers refuse the write instead of overlaying an ADE title.

## CTO vs. regular chat routing

CTO sessions (`identityKey: "cto"`) are routed differently:

1. `sessionProfile: "persistent_identity"` drives a distinct
   `ChatSurfaceProfile` in the UI.
2. Identity and recent context are reconstructed from `ctoStateService`
   on session start and re-injected via `buildReconstructionContext()`.
3. The CTO system prompt includes the immutable CTO doctrine,
   environment knowledge, and active personality overlay
   (`CtoPersonalityPreset`). See `ctoStateService.ts`.
4. Extra tooling: CTO sessions receive `ctoOperatorTools` (including the
   `saveMemory` / `searchMemory` / `readMemory` memory tools) and Linear
   tools when connected. `createCtoRuntimeToolMap` registers them on the
   live session through each provider's tool transport — an `ade-cto` SDK
   MCP server (Claude), the `ade_cto` dynamic-tool namespace (Codex), or a
   dedicated HTTP MCP lease (Cursor / Droid / OpenCode). See
   [tool-system](tool-system.md#registration-on-a-live-session).
5. Guarded permission defaults: Claude defaults to `"default"` (ask
   before dangerous ops); OpenCode defaults to `"edit"`. `full-auto`
   is only applied when explicitly requested.
6. Work the CTO launches never lands on the primary lane.
   `resolveCtoExecutionLane` honors an explicit `laneId` and otherwise
   creates a dedicated lane; it has no fallback to the CTO session's
   lane, because that lane is the project's primary lane. The capability
   manifest carries the matching rule so the model asks for the right
   thing in the first place. Mutating git tools follow the same rule
   through `requireMutationLaneId`, which refuses to default at all. See
   [CTO](../cto/README.md#where-cto-launched-work-runs).
7. Creating the CTO thread seeds one real, visible opening user turn
   (`seedCtoIntroTurn`) so a first-run thread is not blank. It fires only
   on creation, once per project, and is recorded in CTO onboarding
   state.
8. Because the thread is hidden from every session roster, its
   "needs you" state is read through the dedicated read-only
   `getCtoAttention` probe rather than the shared attention summary.

`AgentChatIdentityKey` is now just `"cto"` — the `"cto"` thread is the
only identity session. The former `"agent:<id>"` worker sessions were
removed.

## Fragile and tricky wiring

- **Dynamic model discovery mutates the registry.** Local-model probes
  in `localModelDiscovery.ts` can add and remove descriptors. Callers
  that cache the registry must subscribe to the discovery emitter or
  re-read on each use.
- **Cursor discovery is surface-scoped (`cursorSource`).** Chat surfaces
  run Cursor models through the SDK (~300ms); Work-tab CLI lane drafts run
  the `cursor-agent` CLI (a process spawn that can take seconds).
  `loadAvailableModels` / `getModelCatalog` accept a `cursorSource`
  (`"sdk" | "cli" | "all"`, default `"all"`) and probe only the requested
  source synchronously — the other source serves last-known-good rows and
  revalidates in the background, so a chat picker refresh never waits on a
  CLI spawn. The TUI (`adeApi.ts`), mobile (`SyncService.swift`), and the
  desktop ModelPicker all pass `cursorSource: "sdk"`. Catalog staleness is
  flavor-aware: an SDK-only refresh does **not** satisfy a CLI-surface
  staleness check (it gates on `cursorAvailability[source]`, not just
  `modelCount > 0`), mirrored on the renderer in `runtimeCatalogCache.ts`.
- **Handoff requires context contract.** `handoffSession` calls the
  summarizer with the current transcript plus the context contract
  from `contextContract.ts`. If the contract can't be resolved (e.g.
  missing lane context), the handoff falls back to a minimal summary
  and sets `fallbackUsed: true`.
- **Claude runtime readiness.** `claudeRuntimeProbe.ts` verifies the
  bundled Claude Agent SDK binary and auth state before chat launch.
  Missing binary/auth readiness surfaces as `CLAUDE_RUNTIME_AUTH_ERROR`
  before the SDK `query()` stream is allowed to start.
  `probeClaudeRuntimeHealth` answers exactly one question — can the runtime
  start and authenticate — so its query is fully isolated: `settingSources: []`,
  `mcpServers: {}`, `strictMcpConfig: true`, `persistSession: false`. Left
  unisolated the probe booted the user's entire MCP fleet and wrote a session
  file on every cache miss, which was slow and made a broken MCP server look
  like a broken Claude runtime. It needs no filesystem settings because slash
  commands are discovered separately by `claudeSlashCommandDiscovery`. Keep any
  new probe option on the same footing: nothing the probe loads should be able
  to fail the health answer.
- **Permission mapping is asymmetric.** `mapPermissionModeToNativeFields`
  only handles the abstract-to-native direction. The reverse
  (native-to-abstract) requires provider-specific logic; switching a
  provider-native field without also updating the abstract field
  leaves them out of sync.
- **Claude post-compaction re-injection.** When the CTO session
  undergoes context compaction, the service must call
  `refreshReconstructionContext()` to re-inject identity and durable
  memory. Losing this strips persona and memory mid-session and results
  in the agent forgetting it is the CTO.
- **OAuth redirect ports.** `oauthRedirectService.ts` binds to an
  ephemeral port and writes the URI into the provider config. If
  another process grabs that port between detection and callback, the
  OAuth flow fails silently from the user's perspective.

## Related docs

- [Chat README](README.md) -- session lifecycle overview.
- [Composer and UI](composer-and-ui.md) -- where model selection and
  permission controls surface in the UI.
- [Agents identity and personas](../agents/identity-and-personas.md) --
  how the CTO identity and its memory system feed into routing.
