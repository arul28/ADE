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
| `apps/desktop/src/main/utils/codexComputerUse.ts` | macOS-only signed Codex Computer Use MCP resolver. Requires explicit Codex config opt-in and verifies the standalone OpenAI client before it can be injected into a chat or CLI runtime. |
| `apps/desktop/src/shared/cliLaunch.ts` | Tracked provider CLI start/resume builders, including model/reasoning/permission flags and the canonical `computer_use` MCP overrides for Codex. |
| `apps/desktop/src/main/services/ai/providerRuntimeHealth.ts` | Tracks provider readiness/auth/network failures so the UI can surface degraded states. |
| `apps/desktop/src/main/services/ai/providerOptions.ts` | Normalises provider-native options (Claude permission mode, Codex approval + sandbox, OpenCode permission). |
| `apps/desktop/src/main/services/ai/authDetector.ts` | Discovers available credentials (CLI, API key, OAuth) and reports auth status. |
| `apps/desktop/src/main/services/ai/codexExecutable.ts` / `droidExecutable.ts` | CLI resolution for runtimes that still need an external binary (looks on PATH, in the app bundle, then in configured install paths where supported). Claude uses the bundled Claude Agent SDK binary; Cursor and Droid run through embedded SDKs (`@cursor/sdk`, `@factory/droid-sdk`). |
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | Adjusts the system prompt per mode (`chat`, `coding`, `planning`) and permission mode. |
| `apps/desktop/src/main/services/chat/droidSdkPool.ts`, `droidSdkWorker.ts`, `droidSdkProtocol.ts`, `droidSdkEventMapper.ts` | Droid SDK adapter. `droidSdkPool` forks `droidSdkWorker.cjs` (one per session), brokers prompt sends, permission requests, ask-user prompts, and settings updates via the JSON-line protocol in `droidSdkProtocol`. `droidSdkEventMapper` translates Droid SDK events into the canonical `AgentChatEventEnvelope` shape; the per-session mapper state (`createDroidSdkEventMapperState`) tracks streaming text/thinking item ids, in-flight tool-use names, and the latest usage breakdown. |
| `apps/desktop/src/main/services/chat/droidModelsDiscovery.ts` | Droid model discovery: probes the live SDK via `createSession({ execPath })` to read `initResult.availableModels`, normalizes `supportedReasoningEfforts` into `reasoningTiers`, and emits `droid/<id>` descriptors via `createDynamicDroidCliModelDescriptor`. Droid fast choices are distinct model IDs, not ADE `serviceTiers`; custom (`~/.factory/config.json`) models are merged in. The legacy `DROID_DEFAULT_MODEL_IDS` constant has been removed — the SDK is the only source. Like Cursor, the cache is stale-while-revalidate: `markDroidModelCachesStale` ages it without dropping last-known-good rows, which are served past the 120s window (up to ~6h) while one background warm per freshness window refreshes them, so an unauthenticated/mid-reauth droid isn't handed a session per passive read. |

## Supported providers

`AgentChatProvider` is `"codex" | "claude" | "cursor" | "droid" | "opencode" | (string & {})`.
The final branch exists so local discovery can populate provider keys
for vendored runtimes without changing the union.

| Provider | Runtime | Adapter location |
|---|---|---|
| `claude` | `@anthropic-ai/claude-agent-sdk` `query()` stream with an ADE async input pump, `startup()` warmup, bundled Claude Code binary, SDK sessions, hooks, output styles, plugins, context usage, rewind, and slash-command dispatch. | `agentChatService.ts` (inline; the file carries the full Claude adapter). |
| `codex` | Pinned `@openai/codex` 0.144.5 `codex app-server` subprocess, JSON-RPC protocol. Spawn failures surface as error events. | `agentChatService.ts` (Codex adapter and thread config); executable resolution via `services/ai/codexExecutable.ts`. |
| `opencode` | OpenCode server runtime: Anthropic/OpenAI/Google/Mistral/DeepSeek/xAI/Groq/Together AI API keys, OpenRouter, and local (Ollama, LM Studio, vLLM). | `agentChatService.ts` (OpenCode adapter); model discovery in `localModelDiscovery.ts` and `modelsDevService.ts`. |
| `cursor` | Official `@cursor/sdk` running in a Node worker pool. ADE owns permissions, hooks, and the system prompt; the SDK owns the model + tool execution. Slash commands are discovered from `.cursor/commands/`, `.cursor/agents/`, built-in subagents, and Agent Skill roots via `cursorSlashCommandDiscovery.ts`. | `cursorSdkPool.ts`, `cursorSdkWorker.ts`, `cursorSdkProtocol.ts`, `cursorSdkPolicy.ts`, `cursorSdkSystemPrompt.ts`, `cursorSdkEventMapper.ts`, `cursorSlashCommandDiscovery.ts`. |
| `droid` | Factory Droid models exposed as dynamic `droid/<modelId>` descriptors and driven through the official `@factory/droid-sdk` running in a forked Node worker pool. The legacy ACP bridge (`droidAcpPool.ts`) has been retired. | `droidSdkPool.ts`, `droidSdkWorker.ts`, `droidSdkProtocol.ts`, `droidSdkEventMapper.ts`, `droidModelsDiscovery.ts`; model helpers in `modelRegistry.ts`. |

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
pickers. Opus 5 and Opus 4.7 expose `low|medium|high|xhigh|max`; Fable
and Opus 4.8 add `ultracode`; Sonnet 5 exposes
`low|medium|high|max`; Haiku 4.5 has no reasoning control. The Claude
registry is ordered as
Fable 5, Opus 5, Sonnet 5, Haiku 4.5, Opus 4.8 1M, then Opus 4.7 1M.
Opus 5 selects provider model `claude-opus-5`, defaults to `high`
effort, and exposes `low|medium|high|xhigh|max` plus Fast Mode.
Sonnet 5 selects provider model `claude-sonnet-5`; retired Sonnet 4.6
ids resolve forward for compatibility and no longer appear as picker
rows. The basic Opus 4.7 row is also removed; its old aliases resolve
to Opus 4.8, while the generic `opus` alias selects Opus 5 and
`opus[1m]` / `opus-1m` still target Opus 4.7 1M.
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

Codex forwards Fast as `serviceTier: "fast" | null` on every
`turn/start` and `thread/start` JSON-RPC call (an explicit `null` clears
any app-server default). Claude Fable and Opus descriptors advertise
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
to the provider variant `fast` for both chat and Work CLI launches.
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

### Cursor

Cursor modes (`apps/desktop/src/shared/cursorModes.ts`) are a list of
configurable mode IDs; ADE stores a `cursorModeSnapshot` on the session
carrying the current mode, available mode IDs, and selected config
options. Cursor model descriptors also carry `cursorAvailability`:
SDK-capable rows are eligible for chat sessions, CLI-capable rows are
eligible for Work CLI launches, and rows with both flags appear in both
surfaces.

### Abstract-to-native mapping

`AgentChatPermissionMode` is `default | plan | edit | full-auto | config-toml`.
`providerOptions.ts` exposes `mapPermissionModeToNativeFields()`, which
translates the abstract value into the correct provider-native fields:

- `claude`: `claudePermissionMode = "default" | "auto" | "plan" | "acceptEdits" | "bypassPermissions"`. The `auto` mode hands permission decisions to the SDK's automatic gate and surfaces in the desktop and `ade code` permission pickers alongside the existing modes.
- `codex`: `codexApprovalPolicy` + `codexSandbox` pair.
- `opencode`: `opencodePermissionMode = "plan" | "edit" | "full-auto"`.
- `droid`: `droidPermissionMode = "read-only" | "auto-low" | "auto-medium" | "auto-high"`.

The abstract field is persisted alongside the native fields so the UI
can summarize session state consistently, and so legacy flows that only
know about the abstract mode still work.

### Interaction mode

`AgentChatInteractionMode` is `default | plan`. When `plan`, the agent
operates in read-only planning mode and proposes changes via
`ExitPlanMode`. Approving the plan transitions the session to `edit`
permission mode automatically. In `bypassPermissions` or `full-auto`
permission modes, plan approval auto-grants (no UI), since the user has
opted out of permission gates.

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
   fallback when the LLM summarization call fails or no eligible
   summarizer is available; `AgentChatHandoffResult.usedFallbackSummary`
   surfaces which path was taken.

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

Manual renaming sets `manuallyNamed: true`, which permanently
suppresses further auto-title generation.

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
   tools when connected.
5. Guarded permission defaults: Claude defaults to `"default"` (ask
   before dangerous ops); OpenCode defaults to `"edit"`. `full-auto`
   is only applied when explicitly requested.

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
</content>
</invoke>
