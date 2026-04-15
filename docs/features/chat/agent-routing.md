# Agent Routing, Permissions, and Model Registry

Every chat resolves to a provider, a model, and a permission mode before
a turn runs. This document describes how those choices are made and
where the machinery lives.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/shared/modelRegistry.ts` | Single source of truth for model descriptors. Defines `MODEL_REGISTRY`, `ModelDescriptor`, resolution helpers. |
| `apps/desktop/src/shared/modelProfiles.ts` | Curated selection helpers (task routing, default pickers). |
| `apps/desktop/src/shared/chatModelSwitching.ts` | `canSwitchChatSessionModel` / `filterChatModelIdsForSession` -- rules for mid-session model changes. |
| `apps/desktop/src/main/services/chat/agentChatService.ts` | `handoffSession`, permission translation, per-provider adapter. |
| `apps/desktop/src/main/services/ai/providerRuntimeHealth.ts` | Tracks provider readiness/auth/network failures so the UI can surface degraded states. |
| `apps/desktop/src/main/services/ai/providerOptions.ts` | Normalises provider-native options (Claude permission mode, Codex approval + sandbox, OpenCode permission). |
| `apps/desktop/src/main/services/ai/authDetector.ts` | Discovers available credentials (CLI, API key, OAuth) and reports auth status. |
| `apps/desktop/src/main/services/ai/claudeCodeExecutable.ts` / `codexExecutable.ts` / `cursorAgentExecutable.ts` | CLI resolution (looks on PATH, in the app bundle, then in configured install paths). |
| `apps/desktop/src/main/services/ai/tools/systemPrompt.ts` | Adjusts the system prompt per mode (`chat`, `coding`, `planning`) and permission mode. |

## Supported providers

`AgentChatProvider` is `"codex" | "claude" | "cursor" | "opencode" | (string & {})`.
The final branch exists so local discovery can populate provider keys
for vendored runtimes without changing the union.

| Provider | Runtime | Adapter location |
|---|---|---|
| `claude` | `@anthropic-ai/claude-agent-sdk` V2 (`unstable_v2_createSession`). Persistent subprocess + MCP servers stay alive between turns. Resolves `claude` executable via `claudeCodeExecutable.ts`. | `agentChatService.ts` (inline; the file carries the full Claude adapter). |
| `codex` | `codex app-server` subprocess, JSON-RPC protocol. Spawn failures surface as error events. | `agentChatService.ts` (Codex adapter); config via `codexAppServerConfig.ts`. |
| `opencode` | OpenCode server runtime: Anthropic/OpenAI/Google/Mistral/DeepSeek/xAI/Groq/Together AI API keys, OpenRouter, and local (Ollama, LM Studio, vLLM). | `agentChatService.ts` (OpenCode adapter); model discovery in `localModelDiscovery.ts` and `modelsDevService.ts`. |
| `cursor` | Cursor CLI via ACP (Agent Client Protocol). | `cursorAcpPool.ts`, `cursorAcpEventMapper.ts`, `cursorAcpConfigState.ts`, `cursorAcpMcp.ts`. |

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

Claude's reasoning-tier vocabulary is `low | medium | high | max`
(`CLAUDE_THINKING_LEVELS` in `shared/modelProfiles.ts`). `max` was added
alongside the Claude Opus 4.6 1M entry (`anthropic/claude-opus-4-6-1m`,
aliases `opus[1m]` / `claude-opus-4-6[1m]`, 1,000,000-token context,
32 k output, tier `very_high`) — it's the first registry entry that
advertises the full `low|medium|high|max` tier set. Passthrough to the
provider config is unchanged (the tier string is forwarded directly to
the CLI / SDK — no synthesized token budgets).

## Auth and credentials

`authDetector.ts` (`detectAllAuth`) probes every provider:

- CLI-wrapped providers (`claude`, `codex`, `cursor`) check for the
  binary on PATH and then for the app's auth token cache.
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
options.

### Abstract-to-native mapping

`AgentChatPermissionMode` is `default | plan | edit | full-auto | config-toml`.
`providerOptions.ts` exposes `mapPermissionModeToNativeFields()`, which
translates the abstract value into the correct provider-native fields:

- `claude`: `claudePermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions"`.
- `codex`: `codexApprovalPolicy` + `codexSandbox` pair.
- `opencode`: `opencodePermissionMode = "plan" | "edit" | "full-auto"`.

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
the CLI's expected model token. For Codex, `codexAppServerConfig.ts`
builds the app-server startup options.

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

Changing families triggers a **handoff** (`handoffSession`):

1. Summarize the current session.
2. End it gracefully.
3. Create a new session with the target model.
4. Inject the summary as a continuity message.

The `AgentChatHandoffResult` reports whether a fallback summary was used
(in case the summarization call failed).

## Auto-title generation

Sessions auto-title through two stages when
`ai.chat.autoTitleEnabled` is true and the runtime is not `guest`:

- **Initial** -- generated early in the conversation from the first
  user message, providing an immediate label while the session is still
  brief.
- **Final** -- generated once enough transcript has accumulated,
  producing a more accurate title.

`ai.chat.autoTitleRefreshOnComplete` (default true) triggers a final
refresh after a turn completes.

Manual renaming sets `manuallyNamed: true`, which permanently
suppresses further auto-title generation.

## CTO vs. regular chat routing

CTO sessions (`identityKey: "cto"`) are routed differently:

1. `sessionProfile: "persistent_identity"` drives a distinct
   `ChatSurfaceProfile` in the UI.
2. Core memory is reconstructed from `ctoStateService` on session start
   and re-injected via `buildReconstructionContext()`.
3. The CTO system prompt includes the immutable CTO doctrine, memory
   operating model, environment knowledge, and active personality
   overlay (`CtoPersonalityPreset`). See `ctoStateService.ts`.
4. Extra tooling: CTO sessions receive `ctoOperatorTools`, Linear
   tools (if connected), and `memoryUpdateCore`.
5. Guarded permission defaults: Claude defaults to `"default"` (ask
   before dangerous ops); OpenCode defaults to `"edit"`. `full-auto`
   is only applied when explicitly requested.

Worker sessions (`identityKey: "agent:<id>"`) follow a similar pattern
through `AgentCoreMemory` (same five fields) and the
`workerAgentService`.

## Fragile and tricky wiring

- **Dynamic model discovery mutates the registry.** Local-model probes
  in `localModelDiscovery.ts` can add and remove descriptors. Callers
  that cache the registry must subscribe to the discovery emitter or
  re-read on each use.
- **Handoff requires context contract.** `handoffSession` calls the
  summarizer with the current transcript plus the context contract
  from `contextContract.ts`. If the contract can't be resolved (e.g.
  missing lane context), the handoff falls back to a minimal summary
  and sets `fallbackUsed: true`.
- **CLI resolution fallback chain.** `claudeCodeExecutable.ts` looks in
  (1) a configured path, (2) the app bundle, (3) PATH. Packaged
  releases may bundle the CLI; dev builds rely on PATH. Missing this
  chain surfaces as `CLAUDE_RUNTIME_AUTH_ERROR` after the SDK fails
  spawn.
- **Permission mapping is asymmetric.** `mapPermissionModeToNativeFields`
  only handles the abstract-to-native direction. The reverse
  (native-to-abstract) requires provider-specific logic; switching a
  provider-native field without also updating the abstract field
  leaves them out of sync.
- **Claude post-compaction re-injection.** When a CTO or worker session
  undergoes context compaction, the service must call
  `refreshReconstructionContext()` to re-inject identity. Losing this
  strips persona mid-session and results in the agent forgetting it is
  the CTO.
- **OAuth redirect ports.** `oauthRedirectService.ts` binds to an
  ephemeral port and writes the URI into the provider config. If
  another process grabs that port between detection and callback, the
  OAuth flow fails silently from the user's perspective.

## Related docs

- [Chat README](README.md) -- session lifecycle overview.
- [Composer and UI](composer-and-ui.md) -- where model selection and
  permission controls surface in the UI.
- [Agents identity and personas](../agents/identity-and-personas.md) --
  how CTO and worker identities feed into routing.
</content>
</invoke>