# CTO

The CTO is ADE's persistent, project-level operator identity — one per project, not a family of rotating chats or a background daemon. It is a single long-living chat thread that behaves as if it remembers everything discussed about the project, plus a small settings surface. There are no workers, no hiring, and no Linear workflow engine: those subsystems were removed. What remains is a durable thread with a smart memory system, first-class mid-thread model switching, and a light Linear read/write surface.

The whole surface is built around one contract: the CTO is a daily chat you can open and use immediately, and its identity, memory, and context survive across sessions, context compaction, and model switches.

## Source file map

### Main services (`apps/desktop/src/main/services/cto/`)

- `ctoStateService.ts` — identity (name, persona, model preferences), session logs, onboarding state, and the system-prompt preview. Owns the immutable doctrine, continuity model, memory-system guidance, environment knowledge, and capability manifest constants. `buildReconstructionContext()` assembles the memory-enriched context injected on session start, compaction, and model switch; `previewSystemPrompt()` returns the same layered prompt the settings UI renders verbatim. It also owns the live state block: `refreshLiveState()` / `getLiveStateSnapshot()`, the `CtoLiveStateSnapshot` shape, the exported pure renderer `renderCtoLiveStateBlock()`, and `CTO_LIVE_STATE_MAX_CHARS`. Its `getLiveStateSources` constructor argument is a thunk returning `CtoLiveStateSources` (a `Pick` of `CtoOperatorToolDeps`) because the state service is constructed at boot, long before the chat, PR, and automation services exist. `normalizeModelPreferences` is what makes `modelPreferences` nullable — see [Only providers that can redirect a live turn](#only-providers-that-can-redirect-a-live-turn).
- `ctoMemoryService.ts` — the smart-memory file store under `.ade/cto/`. Reads/writes `MEMORY.md` and `thread-state.md` (atomic writes), appends per-turn lines to `daily/<YYYY-MM-DD>.md`, exposes `searchMemory(query, { limit?, tags? })` (bounded, file-based, tag hits before text hits), `getSnapshot()`, and `buildMemoryContextSections()` (the capped copies used for injection). It also owns the fact-tag vocabulary (`CTO_MEMORY_TAG_KEYS`, `CtoMemoryTags`, `formatMemoryTagSuffix()`, `parseMemoryTags()`), the per-lane read `listFactsForLane()` and its injectable wrapper `buildLaneMemoryContextSection()`, and the worker discovery queue (`recordDiscovery()`, `readNewDiscoveries()`). No new database or vector dependency.
- `ctoPromptContent.ts` — `buildCtoCapabilityManifest()`, the operator-tool operating rules injected into the prompt, plus the `# Tool packs` section rendered from `CTO_TOOL_PACK_NAMES` / `CTO_TOOL_PACK_SCOPES`. Registered tool schemas are the authoritative capability reference; the prompt does not repeat their descriptions. The retained operating rules are what keep CTO-launched work off the primary lane. Also owns `CTO_INTRO_PROMPT` and `CTO_INTRO_ONBOARDING_STEP` — the opening turn and the once-only marker described in [The opening turn](#the-opening-turn) — and the nightly gardener constants `CTO_MEMORY_GARDENER_ONBOARDING_STEP`, `CTO_MEMORY_GARDENER_TITLE`, `CTO_MEMORY_GARDENER_CRON`, `CTO_MEMORY_GARDENER_PROMPT`.
- `linearClient.ts` — Linear GraphQL client (shared by desktop and the headless ADE CLI). Reads: `fetchIssueById`, `listProjects`, `searchIssues`, `getQuickView`, `fetchIssueComments`, `listLabels`, `listUsers`. Writes: `updateIssueState`, `updateIssueAssignee`, `createComment`, `addIssueLabel` / `removeIssueLabel`.
- `linearIssueTracker.ts` / `issueTracker.ts` — issue cache, change detection, and the `getQuickView` / `searchIssues` / `fetchIssueComments` read shims plus the `updateIssueState` / `updateIssueAssignee` / `createComment` / `addLabel` write surface renderer surfaces call through.
- `linearGraphQLInput.ts` — GraphQL input builders shared by the client and tracker.
- `linearCredentialService.ts` — personal API key + OAuth client + auth-mode storage, backed by the active project's `.ade/secrets`, with `ensureFreshToken()` for automatic OAuth refresh.
- `linearOAuthService.ts` / `linearOAuthRefreshLock.ts` / `linearTokenRefresh.ts` — PKCE loopback OAuth flow (port 19836), a cross-process refresh lock, and the token-refresh exchange.
- `linearLaneCardService.ts` — builds the "Open in ADE" Linear attachments for lanes, PRs, issue quick-view links, and chat sessions.
- `linearLiveStatusService.ts` — optional live-status round-trip that reflects an ADE agent's progress (launch → In Progress + self-assign + branch comment; PR open → PR-link comment; merge → Done) back into Linear. Gated OFF unless `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`.

The Linear services above are shared plumbing, not CTO-owned workflow machinery. See [Linear integration](../linear-integration/README.md) for the canonical description; this doc only covers what the CTO thread itself uses.

### Renderer (`apps/desktop/src/renderer/components/cto/`)

- `CtoPage.tsx` — the `/cto` shell. A single full-bleed chat thread (`AgentChatPane` with a locked session), not tabs. The slim header shows only the CTO name/avatar and Settings gear; model controls stay in settings. The CTO composer also hides lane, permission, model, reasoning, and fast-mode controls because the session is project-level, always full-access, and settings-owned. There is no setup wizard and no first-run card — a project that has never picked a model opens on `ModelPickCard`, which is the CTO's welcome screen. The primary session is cached module-side so it stays warm across tab switches, and is obtained via `window.ade.cto.ensureSession()`. When the wake retries are exhausted the thread is replaced by a failure pane rather than a raw error line: it says the CTO didn't answer and that the thread is still there, puts the underlying error in a `TechnicalDetailsFold`, and offers **Try again**, which resets the retry budget and re-runs the wake effect — a failure pane with no way out is a dead end. It also owns `ModelPickCard` (`data-testid="cto-model-pick"`), which takes the thread's place while `modelPreferences` is null; the wake effect is gated on the same condition **and** on the identity snapshot having landed, so nothing materializes a session before the pick is known or on a provider the user has not chosen.
- `CtoSettingsPage.tsx` — settings as a page, not a sheet. A left rail of six sections — Identity, Model, Voice, Memory, Prompt, History — and one topic per pane at a readable width. The page opens on Model, because the model pick is the setting users change most; that pane pairs the picker with a `ModelFactsCard` whose every line comes from the descriptor through `modelFacts.ts`, so the card and the picker row cannot describe one model two ways. The Voice pane renders `OpenAiKeySection` above a two-column grid of the ten `CTO_VOICE_VOICES` — two columns because ten divides evenly and no tile is left alone on a line — and the backchannel toggle. It replaced a 440px drawer that stacked a model picker, a raw markdown editor, a 4.5k-token prompt and a history list in one column, where the things you change sat above two blocks you only read. Memory and Prompt now open on request. Identity carries the name and standing instructions only: the CTO's *voice* is still the doctrine's, and `IMMUTABLE_CTO_DOCTRINE` is not editable from here.
- `CtoMemoryPanel.tsx` — "what the CTO remembers": an editable `MEMORY.md` textarea (save via `window.ade.cto.updateMemory`), a read-only current thread-state, and a collapsible today's daily log. Loads via `window.ade.cto.getMemory`.
- `CtoPromptPreview.tsx` — renders the effective, layered system prompt (doctrine, continuity, memory guidance, environment knowledge, capabilities).
- `useCtoModelOptions.ts` — loads the user's configured model IDs for the settings Model section, and owns `ctoModelSupportsLiveRedirect(descriptor)`, the `ModelPicker` filter both CTO pickers pass. It resolves eligibility through `resolveChatProviderForDescriptor` — the provider the model would actually launch on, never its registry family, because an OpenAI model that is not CLI-wrapped runs under OpenCode, which stages everything. `ctoSessionViewState.ts` — view-state helpers. `shared/designTokens.ts` + `shared/TimelineEntry.tsx` — shared class tokens and the session-history timeline row.
- `CtoTalkButton.tsx` — **Talk**, in the `CtoPage` header. Always rendered, even with no OpenAI key stored: a feature nobody can find is a feature nobody enables, so pressing it with no key opens `OpenAiKeySheet` in a modal rather than reporting an error. `missing-key` is the one `start()` failure that gets a sheet instead of a message; everything else falls through to the HUD's failure pill.
- `useCtoVoiceCall.ts` — the renderer half of a call, and a module-level store read through `useSyncExternalStore` so the HUD, the Talk button, and the capture host all see one call. It owns the microphone and the speaker and nothing else: `startCapture()` pulls PCM16 mono at `CTO_VOICE_SAMPLE_RATE` through a `ScriptProcessorNode` (deprecated, but the only node that works without shipping a separate worklet file) and `playVoiceChunk` queues output so consecutive deltas play gaplessly. `flushVoicePlayback()` closes the playback context outright, because a barge-in has to silence the speaker rather than relabel the pill. It reads `window.ade.ctoVoice` optionally at every call site and degrades to "voice unavailable" instead of throwing, the same shape `SceneFrame` uses for its own optional bridge. It also owns `CTO_VOICE_CAPTURE_EVENT` (`ade:cto-voice:attach-capture`) and the listener that turns a capture into a call attachment.
- `CtoVoiceHud.tsx` — the pill that grows a canvas, driven entirely by `CtoVoiceState` and fetching nothing. `PHASE_LABEL` maps every `CtoVoicePhase` to its word ("Working" for `thinking`, "Waiting on you" for `confirming`), `LevelMeter` breaks to a flat line and an accent flash on barge-in so an interrupt is something you *see* land, and `ConfirmationStrip` renders a destructive question in the danger colour with "tap to confirm" instead of "or just say yes".
- `CtoVoiceHudHost.tsx` — mounts the HUD once and owns the visible timer. The main process owns the call, but the elapsed counter ticks locally so it counts smoothly between state pushes instead of jumping a second at a time. When the call has drawn something it wraps `state.sceneSource` in a `SceneFrame` with `live` set — the same component the transcript uses, so a view drawn during a call and a view drawn in a turn are the same sandbox (see [Chat › Scenes](../chat/README.md#scenes)).

### Shared and tools

- `apps/desktop/src/shared/types/chat.ts` — `AgentChatIdentityKey`, now just the literal `"cto"`. The old `agent:<id>` worker identity keys are gone. It also owns `CTO_LIVE_REDIRECT_PROVIDERS` + `providerSupportsLiveRedirect()`, the CTO's provider-eligibility contract.
- `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` — the operator tool surface. `createCtoOperatorTools()` is the single factory behind the tools a running CTO session can actually call (see [Operator tools on a live session](#operator-tools-on-a-live-session)). It includes the memory tools `saveMemory`, `searchMemory`, `readMemory`, and `readDiscoveries`, the pack loader `loadCtoTools`, the session-lifecycle tools described in [Session lifecycle tools](#session-lifecycle-tools), and the git tools whose mutating half refuses to default a lane (`resolveReadLaneId` vs `requireMutationLaneId`). It also owns `CtoOperatorTool` / `CtoOperatorToolMap` (a `Tool` plus its `pack` and derived `alwaysLoad`), `applyCtoToolPackVisibility()`, the `confirmDestructive` gate behind the optional `requestApproval` dep, and `redactConfigValues` — the redaction the `getProjectConfig` tool applies.
- `apps/desktop/src/main/services/ai/tools/ctoToolPacks.ts` — the closed list of tool packs and nothing else: `CTO_TOOL_PACK_NAMES`, `CtoToolPack`, `CTO_TOOL_PACK_SCOPES` (one line per pack, reused verbatim by the capability manifest), `isCtoToolPack()`. It has **zero imports** on purpose, so the prompt builder can read pack names without dragging zod, the model registry, and the service graph in behind them — the same split as `domains.ts` versus the action registry.
- `apps/desktop/src/main/services/chat/agentChatService.ts` — owns the CTO session lifecycle: single-session reuse/rebind (`listIdentitySessions` / `ensureIdentitySession`), the memory flush hooks, the reconstruction-context injection, `refreshCtoLiveStateForTurn`, `seedCtoIntroTurn` (the opening turn), `ensureCtoMemoryGardenerJob` (the nightly gardening job), `resolveCtoExecutionLane` (where CTO-launched work runs), `buildCtoOperatorToolDeps` / `createCtoRuntimeToolMap` / `createCtoAdvertisedToolMap` plus the per-provider transports that register them, the per-session loaded-pack set `managed.ctoToolPacks`, and the canonical `getCtoAttention` probe (all detailed below).
- `apps/desktop/src/main/services/chat/ctoTurnContext.ts` — the pure pieces of a CTO turn, out of `agentChatService` so they are testable without standing up the provider graph: `truncateTailToLineBoundary()` (tail-truncation that never keeps a partial line), `shouldInjectLaneMemoryContext()`, `readChildPullRequestNumber()`, and `formatCtoChildReportLine()`.
- `apps/desktop/src/main/services/chat/codexCtoToolDeferral.ts` — Codex's dynamic-tool wire shape and the two pure functions that build it: `CodexDynamicToolSpec`, `jsonSchemaForExecutableTool()`, `buildCodexDynamicToolSpecs()`, and the CTO defer predicate `codexDeferCtoTool()`. Service-side types are imported `type`-only, so a unit test for the defer rule costs a zod import rather than the Cursor SDK pool, the Droid worker, and the whole chat graph.
- `apps/desktop/src/main/services/ai/tools/universalTools.ts` — carries `recordDiscovery`, the append-only tool every agent gets (see [Worker discoveries](#worker-discoveries)).
- `apps/desktop/src/shared/types/cto.ts` — the discriminated `CtoAttentionState` (`idle`, `awaiting-input`, or `unknown`), the shape every attention transport returns. `unknown` means inspection failed and clients must retain their last known badge state. It also splits `CtoModelPreferences` out as its own type, because `CtoIdentity.modelPreferences` is now `CtoModelPreferences | null`.
- `apps/desktop/src/shared/types/ctoVoice.ts` — the cross-surface voice contract, and the one place the policy is written. It imports nothing, which is what lets the action policy tables and the approval gate read it without dragging `ws`, the API key store and the chat service graph in behind them: `CTO_VOICE_MODEL` (`gpt-live-1`), `CTO_VOICE_ENDPOINT`, `CTO_VOICE_USD_PER_MINUTE` (0.05), `CTO_VOICE_SAMPLE_RATE` (24,000), `CTO_VOICE_AUDIO_POLL_INTERVAL_MS` (100 ms), `CTO_VOICE_OWNER_IDLE_TIMEOUT_MS` (15 s), `CTO_VOICE_PREOPEN_AUDIO_LIMIT` (50 frames) and `CTO_VOICE_OUTPUT_AUDIO_QUEUE_LIMIT` (200 chunks), the `CTO_VOICE_ACTIONS` list and its `CtoVoiceAction` type, the `CTO_VOICE_VOICES` list and `CTO_VOICE_DEFAULT` (`marin`), the `CtoVoicePhase` union with `isVoiceCallLive()` / `isVoiceCallVisible()`, `CtoVoiceState` + `CTO_VOICE_INITIAL_STATE`, `CtoVoiceBridge`, `CtoVoiceConfirmation`, `CTO_VOICE_SPOKEN_CONFIRM_WINDOW_MS` (20 s), `CTO_VOICE_DESTRUCTIVE_TOOLS` + `isDestructiveVoiceTool()`, `isDestructiveVoiceCommand()` and `describeVoiceApproval()`, `ctoVoiceMicrophoneUnavailableMessage()`, `CTO_VOICE_CAPTURE_DEFAULT_NOTE`, the `voiceCostUsd` / `formatVoiceElapsed` / `formatVoiceCost` formatters, and `buildCtoVoiceInstructions()` — the spoken persona plus the backchannel, interruption, and delegation policy blocks. Detailed procedure deliberately stays with the backend; the live model only needs to know how to talk and when to hand off.
- `apps/desktop/src/main/services/cto/ctoVoiceCallService.ts` — `createCtoVoiceCallService(deps)`: the WebSocket, the delegation loop, the keep-alive, and `endCall`'s durable `persistCall` write. Every dependency is injected (`getApiKey`, `runBackendTurn`, `persistCall`, `createWebSocket`), so the service never imports the chat service and the delegation loop is testable without a model.
- `apps/desktop/src/main/services/cto/ctoVoiceRuntimeService.ts` — `createCtoVoiceRuntimeService(host)`: the runtime-hosted owner of a call. It builds the call service's deps out of an `AdeRuntime` (chat, CTO identity, durable memory, lanes), holds the confirm-first hold and the `ownerToken`, publishes state on the `cto_voice` event category, and keeps the output-audio queue that `pullAudio` drains. Constructed in `apps/ade-cli/src/bootstrap.ts` and exposed as `AdeRuntime.ctoVoiceCallService`. See [The call brain lives in the runtime](#the-call-brain-lives-in-the-runtime-and-the-desktop-is-a-router).
- `apps/desktop/src/main/services/cto/ctoVoiceWiring.ts` — the desktop router: the nine `CTO_VOICE_ACTIONS` behind one transport interface (`resolveTransport` returns the runtime pool's when a pool exists, the in-process service otherwise, or the sentence explaining why there is neither), the owner window and `isCallOwner` broadcast, the 100 ms audio pump, the per-call `CallSlot`, and the close/reload watchers. It owns no call state of its own.
- `apps/desktop/src/main/services/cto/ctoVoiceTestDoubles.ts` — the fake socket and fake `CtoVoiceRuntimeHost` every voice suite drives, typed against the real host rather than `any`, so a change to what the service needs breaks them once rather than in each suite.
- `apps/desktop/src/renderer/components/shared/ModelPicker/modelFacts.ts` — what a model *is*, in the words a person would use, as pure functions with nothing rendered: `providerLabel` / `PROVIDER_LABELS`, `isPiRoutedModel`, `isLocalModel`, `runsOnLabel`, `subProviderLabel` / `subProviderKey`, `formatTokenCount`, `reasoningEffortLabel`, and `modelDetailLine`. Every fact appears on at least two surfaces — the picker row's detail line and the CTO's model card — so it is formatted once here rather than twice.
- `apps/desktop/src/main/services/cto/ctoVoiceConfirmation.ts` — the spoken-yes rules as pure functions: `classifySpokenReply()` (negatives checked first, because "no, don't do it" contains "do it"), `resolveSpokenConfirmation()`, and `buildConfirmation()`, which stamps `destructive` from `isDestructiveVoiceTool` and `expiresAtMs` from the window.

### Attention surfaces (renderer)

- `apps/desktop/src/renderer/hooks/useCtoAttention.ts` — the probe loop behind the CTO tab dot. Mounted once in `AppShell.tsx`.
- `apps/desktop/src/renderer/state/appStore.ts` — `ctoAttention` + `setCtoAttention`, reset to idle on every project switch/close alongside `terminalAttention`.
- `apps/desktop/src/renderer/components/app/TabNav.tsx` — renders the warning dot on the `/cto` tab with a "waiting since" tooltip.
- `apps/desktop/src/renderer/hooks/useAppWideSessionAttention.ts` — folds `ctoAttention.awaitingInput` into the dock badge count while remaining the only writer of `setDockBadgeCount`.
- `apps/desktop/src/renderer/webclient/adapter/misc.ts` — forwards `getAttention` through the paired runtime's `cto.getAttention` command, so the hosted web `/cto` tab uses the same probe and retention semantics as Electron.

### iOS companion (`apps/ios/ADE/Views/Cto/`)

- `CtoRootScreen.swift` — renders the CTO chat inline as the tab body (single thread, kind `.cto`) with a top-bar gear that opens settings as a sheet. No Team/Workflows navigation. It routes on the pure `ctoRootContent(identity:loadError:hostUnreachable:) -> CtoRootContent` (`.loading`, `.loadError`, `.modelPick`, `.thread`), mirroring desktop `CtoPage`'s order — `modelPick` sits *before* `thread`, and in that state the view deliberately does not build `CtoSessionDestinationView`, so nothing ensures a session on a provider the user has not chosen. `applyModelPick` writes identity preferences first, then `ensureCtoSession()`, then pins the exact model through `updateChatSession`, and only publishes the refreshed snapshot last so the picker cannot drop out mid-flight and let a second ensure run.
- `CtoSessionDestinationView.swift` — resolves the always-on CTO session (`ensureCtoSession()`) and reuses the Work chat pipeline with a compact one-line voice/send composer. It passes `liveRedirectOnlySends: true` so the composer never offers *Send after turn* on the CTO thread.
- `CtoSettingsScreen.swift` — sections: Identity (name and standing instructions, edited in a sheet), Model (live model/reasoning/Fast selection), Integrations (read-only Linear connection status), and Memory (durable facts + thread summary via `cto.getMemory`). It has no Voice section, because iOS has no call surface. With no stored preference the identity row reads "No model picked yet" rather than inventing a default.
- `apps/ios/ADE/Views/Work/WorkModelPickerSheet.swift` — gained an optional `modelFilter`; both CTO surfaces pass `{ providerSupportsLiveRedirect($0.provider) }`. `applyModelFilter` prunes providers and groups that empty out, so the provider rail never shows a tab with nothing behind it. Every other caller passes nothing and is unchanged.
- `apps/ios/ADE/Views/Work/WorkModels.swift` — `ctoLiveRedirectProviders` / `providerSupportsLiveRedirect(_:)`, the hand mirror of `CTO_LIVE_REDIRECT_PROVIDERS` (iOS cannot import TS), pinned by `testCtoLiveRedirectProvidersMirrorDesktopContract`. Deliberately a separate list from `WorkActiveSendCapability`: Cursor has no inline channel at all and still qualifies, through interrupt-and-resend.
- `CtoReloadHelpers.swift` — reload plumbing for the CTO screens.
- `apps/ios/ADE/Models/RemoteModels.swift` — `CtoAttention` (`status`, `awaitingInput`, optional `since`, plus effective-status compatibility for older hosts), the Codable mirror of `CtoAttentionState`. It also carries `CtoIdentity.modelPreferences` as an optional with a `needsModelPick` read — null is a real state on a healthy install, not just decode tolerance, because the host normalizes an ineligible stored preference back to null.
- `apps/ios/ADE/Services/SyncService.swift` — `fetchCtoAttention()` (the `cto.getAttention` call), the `@Published ctoAttention`, and `refreshCtoAttentionIfNeeded()`, called from `refreshActiveSessionsAndSnapshot()` above its roster-signature early return and from `saveRemoteCommandDescriptors` with `force: true`.

The iOS CTO tab icon is the bundled template asset `CtoMark` (`apps/ios/ADE/App/ContentView.swift`), not an SF Symbol. It is the same drawing the desktop rail uses, where `TabNav.tsx` renders the Phosphor `Robot` glyph.

That same tab carries the attention badge described in [Hidden from rosters, but never silent](#hidden-from-rosters-but-never-silent).

## Domain model

### Identity layers

The system prompt is assembled from layered sections (`ctoStateService.previewSystemPrompt`), immutable first:

1. **Immutable doctrine** (`IMMUTABLE_CTO_DOCTRINE`) — the CTO role, the ADE environment description, precision rules, how the CTO speaks, and how it helps with ADE itself. Always injected, never user-editable, never compacted away. It is the only place the CTO's voice is set: lead with the state of things, then the read, then the recommendation; stay level, with no exclamation marks and no "great question"; say plainly when you do not know, say what you would check, then check it; disagree once with the reason and then drop it; never call something done before verifying it. The same block tells the CTO it knows the ADE application and not only the repository — a user lost in ADE gets a product answer, grounded in ADE's own documentation rather than a guess, and a deeplink to the place instead of navigation directions.
2. **Continuity model** (`CTO_CONTINUITY_OPERATING_MODEL`) — how ADE re-grounds the CTO across compaction and resumes.
3. **Persistent memory guidance** (`CTO_MEMORY_SYSTEM_GUIDANCE`) — teaches the CTO that it has durable, model-agnostic memory and how to use the `saveMemory` / `searchMemory` / `readMemory` tools proactively.
4. **Environment knowledge** — a glossary of ADE entities (lanes, chats vs terminals, PRs, conflicts, automations, Linear reads) plus intent-to-tool routing, including the live model registry.
5. **Capability rules** — cross-tool operating rules that are not expressed by any one schema. The registered tool schemas already describe the full tool surface.

### Identity record

Persisted under `.ade/cto/` and mirrored into the `cto_identity_state` DB row (newest wins on reconcile):

- `identity.yaml` — name, persona, `systemPromptExtension`, `modelPreferences` (provider, model, modelId, reasoningEffort — **nullable**), `voiceName`, `voiceBackchannels`, onboarding state, version. There is no personality preset and no work style; `normalizeIdentity` silently drops those keys when an older build wrote them, so an existing file still loads.
- `CURRENT.md` — ADE-generated working context (recent CTO sessions), refreshed on identity and session-log changes.
- `sessions.jsonl` — hash-chained session log, reconciled with the `cto_session_logs` table.

The entire `cto/` directory is local runtime state by default (git-ignored unless force-added).

### Smart memory system

Files under `.ade/cto/`, owned by `ctoMemoryService`:

| File | Role | Written by | Injected |
| --- | --- | --- | --- |
| `MEMORY.md` | Curated durable facts (decisions, preferences, standing context) under a `## Facts` list | `saveMemory` tool, `CtoMemoryPanel` edits | Always (tail-capped at 4k chars for injection; disk copy never truncated, hard byte cap 64 KiB drops oldest facts into `memory-archive.md`) |
| `thread-state.md` | Rolling summary of the current goal, recent decisions, open loops | Deterministic + best-effort LLM flush | Always (head-capped 3k chars) |
| `daily/<date>.md` | Per-turn journal: `HH:MM — intent → outcome` | Turn-end append (no LLM) | The two most recent daily files that exist (tail-capped 3k chars) |
| `discoveries.md` / `discoveries-archive.md` / `discoveries.cursor` | The unreviewed worker-discovery queue and its read cursor | The `recordDiscovery` tool, from any agent | Never directly — drained into the CTO's turn (see [Worker discoveries](#worker-discoveries)) |

`buildMemoryContextSections()` returns the capped, labeled copies; `ctoStateService.buildReconstructionContext()` appends them after the identity/doctrine/environment sections. Only the injected copies are truncated. The three injection caps total 10k chars, cut from 16k to fund the live state block below without changing the per-turn prefix budget; the measured sizes of this project's own memory files are well under the new caps, so nothing that used to be injected stopped being injected.

#### Fact tags

Every durable fact may carry a trailing `[lane:… pr:… path:… topic:…]` suffix. The vocabulary is closed (`CTO_MEMORY_TAG_KEYS`), values are normalized on write — whitespace and `]` runs collapse to `-`, clipped at 120 chars — so the suffix stays parseable by one end-anchored regex, and the suffix is appended **after** the fact is clipped so a long fact can never truncate away its own tags. `parseMemoryTags` is first-wins on a repeated key.

Tags are what make memory addressable rather than merely searchable: `searchMemory(query, { tags })` accepts an empty query when tags are present ("everything about lane X"), and collects into two buckets — facts whose *tag values* matched, then plain substring hits — returning tag hits first so they win the result budget. Untagged facts still match by text.

#### Per-lane memory in project chats

`buildLaneMemoryContextSection(laneId)` returns a "Project memory (ADE, read-only context)" section holding the facts tagged for that lane (newest last, 1.5k chars) plus the rolling thread state (1.2k chars), or `null` when there is nothing lane-scoped — so a worker never receives an empty heading. `listFactsForLane` deliberately excludes untagged facts: an untagged fact is not a claim about this lane.

The delivery rule is the pure `shouldInjectLaneMemoryContext` (`ctoTurnContext.ts`): never for the CTO (it already has all of memory) or a personal chat (no project lane), otherwise once per lane change, keyed on the same `lastLaneDirectiveKey` the lane execution directive uses. The section therefore arrives beside the directive that explains the lane, and a worker that stays put never pays for it again.

#### Worker discoveries

`recordDiscovery` is a **universal** tool — every agent has it, not just the CTO. It appends one timestamped, secret-redacted, tag-suffixed line to `<adeDir>/cto/discoveries.md`. There is deliberately no matching read tool on the worker side: a worker can hand a finding up without gaining any view of what the CTO knows. `agentChatService` stamps the worker's own lane when the caller did not tag one. The same action is reachable as `ade actions run cto_memory.recordDiscovery` and from automation `ade-action` steps.

The file is capped at 128 KiB — larger than `MEMORY.md`'s 64 KiB because it is a drain queue, not a standing document, with a much wider writer set. Over the cap, the **oldest** entries shift into append-only `discoveries-archive.md` (marked with the eviction instant) rather than being destroyed, and the read cursor rewinds by exactly the bytes removed, clamped at zero: eviction can re-deliver a discovery, never skip one.

`readNewDiscoveries()` drains from a **byte offset** held in `discoveries.cursor`, not a line count, so a concurrent append between read and write can only be re-read. It reads at most a 64 KiB unread window per call, rewinds to the last newline so no discovery is handed out in halves, and treats its char budget as a *drain* budget — the oldest lines that fit are returned and the cursor advances over exactly those, so a backlog drains across several reports instead of being thrown away. At least one line is always handed out even if it alone blows the budget.

Two consumers: the CTO's own `readDiscoveries` core tool (which returns the drained `text`, not `lines`, so one oversized entry cannot carry the whole window into a tool result), and the child-completion wake — when a finished child wakes the CTO, fresh discoveries ride the wake text, never the one-line system notice.

#### Nightly memory gardening

`ensureCtoMemoryGardenerJob` schedules one durable ADE-owned cron job on the CTO session (id `cto-memory-gardener:<sessionId>`, `CTO_MEMORY_GARDENER_CRON` = `30 3 * * *` local to the brain machine, no `expiresAt` — the recurring-cron TTL exists to bound Claude-mirrored rows, and this row has a stable ADE-owned id). The prompt runs in quiet mode — no questions, no lane work, no spawned chats — and does four things: distill recent daily logs and the discovery queue into tagged durable facts, merge duplicates, archive facts whose PR merged more than 30 days ago, and leave anything uncertain alone, because losing a fact is worse than keeping a redundant one. It closes with one line counting added / merged / archived.

Idempotency keys on the `memory_gardener` onboarding step, **not** on whether the row exists: a presence check would re-create a job the user deleted and re-arm one they paused. The step is written only after a successful upsert, so a runtime with no scheduler retries later. Success posts a `system_notice` naming where to pause or remove it.

### Live project state

The CTO is told what is happening rather than asked to go find out. Each CTO turn, `refreshCtoLiveStateForTurn` captures a `CtoLiveStateSnapshot` and `buildReconstructionContext` appends `renderCtoLiveStateBlock(...)` **last**, after every identity and memory section.

Last is deliberate. The turn-context prefix truncates by keeping its tail, so the freshest and most perishable section is placed where a budgeted send cannot cut it.

The snapshot reads six things through `CtoLiveStateSources` — a `Pick` of the operator tools' own dependency surface, so the block and the tools see one project through one set of shapes: open lanes (with dirty/ahead/behind), active chats (title, lane, status, note, lineage), open PRs (checks + review), pending approvals, scheduled work, and recent automation runs. Approvals and scheduled work are derived from the same chat summaries rather than a second round-trip. Rendering runs most- to least-urgent — "Waiting on you" first, automation runs last — and empty sections say `- none`.

Every source is read in its own `try`/`catch`; a throw names the source in an `Unavailable this turn:` line rather than blanking the block, and a service that simply is not wired is skipped silently (not the same thing as unavailable). A refresh failure is swallowed and logged — a slow PR refresh must not block the user's turn. Refresh is per-send rather than on a timer, because the block tells the model not to re-derive it, and a stale block is worse than no block.

Caps are layered: per-section row caps with an explicit `…and N more` overflow line, per-field clips, then a whole-block cap of `CTO_LIVE_STATE_MAX_CHARS` (6,000) applied as **line-aligned head truncation** — lines are kept from the top until the next would overflow, then `…(live state truncated)`. A half-rendered row is never emitted, and what goes is the tail. The 6,000 is measured, not guessed: this project's real state renders ~4.6k chars, and the absolute worst case the row caps permit is ~12.6k.

### Only providers that can redirect a live turn

`CtoIdentity.modelPreferences` is `CtoModelPreferences | null`, and the CTO may only run on a provider in `CTO_LIVE_REDIRECT_PROVIDERS` — Claude, Codex, Cursor. The CTO is interrupted constantly (child reports, scheduled wakes, peer notes), and a provider that can only stage the next turn would hold every one of them until the current turn ends. Cursor qualifies through interrupt-and-resend: the live run is cancelled and the message continues on the same agent thread, which is still a redirect of work in flight.

The list is deliberately **not** derived from `ACTIVE_TURN_DISPATCH_MODES`. That table governs the composer's staged-message promotion menu; this is the CTO's own eligibility contract, and reading one off the other would let a composer-menu change silently decide who is allowed to be the CTO.

`makeDefaultIdentity` — the seed a project with no identity file and no DB row reconciles to — carries `modelPreferences: null`. That is load-bearing rather than incidental: the seed is the one identity path that never passes through `normalizeModelPreferences`, so a provider hard-coded there could not be validated away and would become the user's pick without the user picking.

`normalizeModelPreferences` keeps a stored preference only when it is complete *and* its resolved chat provider supports live redirect; otherwise it is set to null. The provider is resolved from `modelId` through the model registry, with a family fold (`anthropic`/`claude*` → `claude`, `openai`/`codex*` → `codex`, `cursor*` → `cursor`) only for records written before `modelId` existed. `updateIdentity` treats an explicit `null` as "clear the pick" and an absent key as "leave alone", and the reconstruction context prints `- Preferred model: not picked yet`.

Both clients then put a picker in front of the thread rather than starting one: desktop's `ModelPickCard` and iOS's `.modelPick` content state, each gating session creation so nothing materializes a CTO session on an ineligible provider. Both model pickers narrow their catalog by the same predicate, and the "nothing configured" copy names Claude, Codex, and Cursor specifically.

The composer follows: the CTO session's steer queue cap is zero — a delivery that would queue becomes a live redirect instead — so desktop (`surfaceProfile: "persistent_identity"`) and iOS (`liveRedirectOnlySends`) both drop *Send after turn* from the active-turn menu. Both filters are presentation catching up with the host, not a second policy; the per-provider table itself is untouched.

### The welcome screen

There is no setup wizard, no personality question, and no first-run card. A project that has never picked a model opens on `ModelPickCard` (`data-testid="cto-model-pick"`), and that card **is** the welcome screen: the CTO introduces itself in its own voice — "I run point on this project" — explains why it can only run on a model that accepts a message into a turn already underway, and the `ModelPicker` underneath is the reply affordance. A first turn, not a form. iOS renders the same state as `.modelPick` in `ctoRootContent`, ordered ahead of `.thread` for the same reason.

What is gone from it is the point. Personality, work style, and tone are not choices: the voice is `IMMUTABLE_CTO_DOCTRINE`'s, and the Identity section in `CtoSettingsPage` cannot override it — it holds the name and the user's own standing instructions, which are added to the doctrine rather than replacing any of it. The only thing ADE genuinely cannot infer is which model should do the thinking, so that is the only thing first run asks. See [Only providers that can redirect a live turn](#only-providers-that-can-redirect-a-live-turn) for why the catalog is narrowed to Claude, Codex, and Cursor, and why picking here moves the existing thread rather than starting a second one.

`CtoIdentity.name` survives as a field rather than a question. It defaults to `"CTO"`, seeds the system prompt (`You are ${identity.name}`), the header, the avatar initial, and `buildCtoVoiceInstructions`'s `ctoName` — The Identity section of `CtoSettingsPage` edits the name and the standing instructions. That form writes through `ctoUpdateIdentity`, and the iOS identity editor writes the same fields through the `cto.updateIdentity` sync command.

### Flush and injection lifecycle

The guarantee is that a deterministic flush always runs before anything can be lost; an LLM upgrade of the summary is best-effort on top. All flush paths live in `agentChatService.ts` and no-op for non-CTO sessions.

- **Turn-end journal (deterministic, cheap).** After each completed or failed CTO turn, `appendCtoTurnJournal` appends one `HH:MM — intent → outcome` line to today's daily log. No LLM call.
- **Pre-compaction flush.** On the runtime's `compacting` / compaction-boundary signal, `maybeRefreshIdentityContinuitySummary(managed, "compaction")` runs `flushIdentityContinuityDeterministic` first (writes the tail-based snapshot to the session and to `thread-state.md`), then kicks off a best-effort LLM summary that overwrites `thread-state.md` when it returns. `refreshReconstructionContext` re-injects afterward.
- **Pre-model/provider-switch flush.** The model-switch path calls the same flush before `teardownRuntime`, so nothing in the old provider window is lost, then rebinds. Both the synchronous switch and the deferred (cursor-busy) switch take this path.
- **Injection** happens by staging `pendingReconstructionContext` and delivering it on the next turn after session start, compaction, and model/provider switch.

### Model switching is first-class

- Changing the model from the Settings Model section routes through `agentChatService.updateSession` for a live session, moving the same ADE session and transcript to the new provider/model. Before a session exists, the picker writes `identity.modelPreferences` so `ensureSession` reconciles to it.
- The live selection is persisted back into `identity.modelPreferences` (`persistCtoModelPreference`) so the identity file stays the single source of truth in both directions.
- Switch order: flush durable memory → `refreshReconstructionContext` (now memory-rich) → `teardownRuntime` → rebind. Claude→Claude keeps the fast `setModel` path.

### Single session, project-level

`AgentChatIdentityKey` is just `"cto"`. `ensureIdentitySession` reuses the newest CTO session regardless of which lane it was last active on: if nothing lives on the canonical lane but a CTO session exists elsewhere, it reuses that session and rebinds it to the canonical lane instead of forking a parallel thread. There is only ever one CTO thread per project.

### Hidden from rosters, but never silent

The CTO thread is pinned to the project's **primary lane** (it needs a lane for its cwd), but it is filtered out of every session roster so it never reads as a chat you started: `agentChatService.listSessions` drops identity sessions unless `includeIdentity` is set, and `chatSessionProjection.projectChatSummariesOntoSessions` plus `laneListSnapshotService` drop the backing terminal row before the Work tab, Lanes tab, workspace graph, and TopBar ever see it. `sessions:get` still resolves the id, so deeplinks and `CtoPage` keep working. Universal search deliberately *does* index the thread — it is your own conversation, and it should be findable in ⌘K.

Hiding the row removes it from `terminalAttention`, which is what the Work dot and the dock badge summarize. A hidden thread that asks a question would otherwise surface nowhere, so attention gets its own path:

- `agentChatService.getCtoAttention()` is the single implementation. All three transports — `IPC.ctoGetAttention` (plain IPC), the `cto_state.getAttention` action (daemon-routed), and the `cto.getAttention` sync command (mobile and hosted web) — delegate to it, so a remote runtime, local Electron window, browser client, and phone cannot derive "needs you" differently. It returns a discriminated `CtoAttentionState`: `idle`, `awaiting-input` with an optional tooltip timestamp, or `unknown` when inspection failed.
- It is **read-only**. It resolves the thread through the same `listIdentitySessions` helper `ensureIdentitySession` uses, but never calls `ensureIdentitySession` itself: rendering a badge must not materialize a primary lane and a chat session as a side effect. The predicate is `awaitingInput || pendingInputItemId || attentionRequestedAt` (the last being an explicit `ade chat ask` hand-raise) rather than `canonicalStatusBucket`, whose awaiting-input bucket folds in `idle` and `ready` and would light the dot whenever the CTO is merely sitting there. A probe failure logs and returns `unknown`, never a false `idle`.
- `useCtoAttention` (mounted once in `AppShell`) keeps `appStore.ctoAttention` fresh from chat events, focus, and a 15 s visible-tab interval; `TabNav` renders the dot on `/cto`. It filters chat events through `shouldRefreshSessionListForChatEvent` so a streaming turn does not re-run a full identity scan per delta, debounces to 1.5 s (0 on focus), ignores `unknown` so the last known state survives a failed host scan, and clears to idle on project switch so the previous project's state cannot linger. The hosted web adapter now exposes `getAttention` over `cto.getAttention`, so this same renderer hook works in paired-browser mode.
- `useAppWideSessionAttention` adds the CTO to the dock badge count so a question reaches a minimized window. It stays the single writer of `setDockBadgeCount`.
- **iOS** takes the same path. `SyncService.fetchCtoAttention()` calls `cto.getAttention` and publishes `ctoAttention`; `ContentView` badges the CTO tab (a string badge, so it renders as a dot-sized marker and disappears when idle) with a matching accessibility label. `refreshCtoAttentionIfNeeded()` rides the same "something changed" pulse that rebuilds the session roster — the CTO is not *in* that roster, so it needs its own read. It is called from `refreshActiveSessionsAndSnapshot()` **above** the roster-signature early return, not below it: since the CTO is excluded from `allAgents`, a turn where only the CTO changed leaves the signature identical, so a probe hanging below the guard would fire only when some unrelated session happened to change — and, once lit, would never clear. It is also called with `force: true` from `saveRemoteCommandDescriptors`, because the probe no-ops until it knows the host advertises the command, so the first read after a (re)connect has to happen when the descriptors land and must skip the debounce a reconnect could land inside. Otherwise it is debounced to 5 s. It is gated on `supportsRemoteAction("cto.getAttention")`: an older brain never lights the dot, and a value left over from a newer host is cleared. A transport error or explicit `unknown` result keeps the last known value rather than clearing, because falsely dropping a pending question is worse than a slightly stale dot. The wire `status` remains optional when decoding so iOS infers `idle`/`awaiting-input` from `awaitingInput` against older hosts.

### The opening turn

A brand-new CTO thread used to open on a blank screen. `ensureIdentitySession` now seeds one real, **visible** first user turn when it *creates* the session (`seedCtoIntroTurn`), asking the CTO to introduce itself and give a read on the project. Because `ensureSession` is gated behind onboarding in `CtoPage`, session creation is exactly the blank-thread moment, and seeding there covers desktop, iOS, and the CLI in one place.

It is deliberately not a hidden or canned message: ADE has no hidden-turn mechanism, and a fabricated assistant message would feed back into the model's context on every later turn. The `intro` marker lives in `onboardingState.completedSteps` — not a user-facing setup step, but kept in that list so it is persisted — so it survives restarts and fires once. The marker is write-once, and nothing clears it; it is written only *after* the send succeeds, so an unauthenticated first run retries instead of burning the one shot. The send is fire-and-forget with `awaitDispatch` so a dispatch failure is logged rather than escaping as an unhandled rejection.

### Operator tools on a live session

The CTO's operator tools are registered on the running session, not merely
advertised in its prompt. `createCtoRuntimeToolMap(managed)` in
`agentChatService.ts` builds the executable map and returns `null` for anything
whose `identityKey` is not `"cto"`, so no other chat can reach these tools.

`buildCtoOperatorToolDeps` builds the dependency set for the runtime map. It
was also shared with `previewSessionToolNames`, a name-enumeration helper that
has since been removed because it had no non-test caller — there is no separate
prompt manifest today. Registered schemas are always loaded for CTO sessions and
are the authoritative capability reference. A live measurement
found that repeating the generated inventory in the prompt added about 11.8k
characters (roughly 2,945 estimated tokens) on top of about 28.8k tokens of MCP
tool schemas, so `buildCtoCapabilityManifest` now carries only cross-tool
operating rules. Tool search is now `auto` for CTO sessions, and `alwaysLoad` remains enabled;
removing the duplicate prose reduces context without making tools undiscoverable.

Every chat-control dep — `steerChat`, `cancelSteer`, `listSubagents`,
`approveToolUse` — is **required** on `CtoOperatorToolDeps` and wired to the
matching `agentChatService` method (`steer`, `cancelSteer`, `listSubagents`,
`approveToolUse`, the last translating the tool's `toolUseId` into the
service's `itemId`). Making them required is the guard: an optional dep left
unset advertises a tool whose only possible answer is "not available", which is
worse than not offering it. `cancelSteer` takes the `steerId` that `steerChat`
returned, so cancelling is unambiguous when several steers are pending. There
is no `handoffChat`: it targeted "a different agent identity" and
`AgentChatIdentityKey` is just `"cto"`.

### Tool packs

The curated tool surface is large enough that advertising every description on
every turn is its own context cost. `ctoToolPacks.ts` splits it into thirteen
packs — `core`, `linear`, `files`, `tests`, `conflicts`, `scheduling`, `proof`,
`review`, `search`, `insights`, `config`, `devices`, `orchestration` — each with
a one-line scope string the capability manifest reuses verbatim.

`core` is the standing surface and is always loaded **by construction**:
`alwaysLoad` is derived from the pack inside `createCtoOperatorTools`, never set
per tool, so a core tool cannot ship un-loaded because someone forgot a flag.
The stamper is applied at each tool's definition site rather than by a mutable
"current pack" variable reassigned between sections, because moving a definition
across a section boundary used to silently re-pack it.

Every other pack is an **extension, not a gate**: its tools stay registered and
callable on every transport at all times. Only the advertised *description* is
trimmed. `applyCtoToolPackVisibility(tools, loadedPacks)` produces the advertised
map — it never adds or drops a key — replacing an unloaded extension tool's
description with a one-sentence summary plus a pointer to `loadCtoTools`, and
only when that stub is genuinely shorter than the original, because most ADE
descriptions are already one line and the naive version measured *larger* than
the full catalog.

`loadCtoTools` lives in `core` (the loader can never itself be the thing waiting
to be revealed). With no argument it lists every pack with its scope and load
state without loading anything; with a pack name it records the load and returns
that pack's full descriptions. Loaded packs live in the per-session, in-memory
`managed.ctoToolPacks` and are deliberately never persisted: a pack loaded for
one investigation must not widen every later thread's prompt.

Three deferral mechanisms layer on top of the same map:

| Provider | Mechanism |
| --- | --- |
| Claude | ToolSearch. The CTO's `ENABLE_TOOL_SEARCH` pin was removed and is now `"auto"` for every session. It was previously pinned off because deferring one flat catalog risked a CTO that could not find `spawnChat`; packs removed that risk, and the parity gate is `ctoToolPacks.test.ts`, which asserts the three properties the flip depends on — derived `alwaysLoad`, registration identical regardless of which optional services are wired, and a visibility pass that never adds or drops a key. |
| Codex | `deferLoading` per tool, built by `buildCodexDynamicToolSpecs` with the `codexDeferCtoTool` predicate: a tool with no pack metadata is never deferred, a core/`alwaysLoad` tool is never deferred, and an extension tool stops being deferred once its pack is loaded. |
| Cursor / Droid / OpenCode | No native mechanism, so the trimmed descriptions *are* the deferral. The HTTP MCP lease and the SDK MCP server both build from `createCtoAdvertisedToolMap`. |

`buildCtoCapabilityManifest` renders the pack list from the same two constants
and adds eleven operating rules. Three of them matter most here: never claim something cannot be done for lack of
a tool before checking `loadCtoTools` for the owning pack; secret *values* are
unreadable by any tool by design (names are listable, values are the user's to
read in Settings); destructive tools pause for confirmation, so expect it.

### Confirmation and redaction

Two guards sit on the wider tool surface.

**Destructive tools ask.** An optional `requestApproval` dep raises the same
approval card an agent tool call raises (`requestChatInput` with
`providerMetadata.toolApproval`, answered through `approveToolUse`), and
`confirmDestructive` turns a decline into `{ success: false, error }` rather
than a thrown turn. It gates replacing an existing automation rule, deleting
one, and cancelling scheduled work. With no `requestApproval` wired — the
headless `ade` RPC, tests — the call proceeds, because the caller there is
already the operator.

**`getProjectConfig` redacts values, never shape.** `redactConfigValues` walks
the config and replaces: an env bag object with `{ __redacted, names: [...] }`;
a credential-map object (`apiKeys`, `secrets`, `tokens`, …) the same way; a
credential-shaped string with `"[redacted]"`; and a credential/env container
that is an *array* with a count. Arrays carry the parent key down so
`{ apiToken: ["ghp_…"] }` is still redacted. Key matching normalizes camelCase
and is word-bounded, so `tokenizer` survives, and an explicit allow-list of
pointer keys (`secret_ref`, `secret_name`, `api_key_ref`, `credential_ref`) is
checked first — hiding the *name* of a secret protects nothing while costing the
CTO the ability to say which secret a webhook trigger depends on. Every key
stays visible; only values change. `listProjectSecretNames` re-maps rows to
exactly `{ name, updatedAt, scope }` as defence in depth.

Registration then goes through whichever transport the session's provider
speaks. All three read their identifiers from one descriptor table,
`HTTP_MCP_TOOL_SETS`, whose `cto` entry names the `ade-cto` server, the
`ade_cto` Codex namespace, and `createCtoRuntimeToolMap` as its factory:

| Provider | Transport |
| --- | --- |
| Claude | `buildClaudeSdkMcpServer(managed, "cto")` returns an SDK MCP server named `ade-cto`, merged into `opts.mcpServers`. Unlike the orchestration lead's server it is injected **without** `allowManagedMcpServersOnly` — the CTO is a daily-driver chat and must keep the user's own MCP servers. |
| Codex | `refreshCodexDynamicTools` walks the table and registers each set as dynamic tools under its own namespace — `ade_cto` alongside orchestration's `ade_orchestration`. Dispatch falls back by bare name across both namespaces when a call arrives un-namespaced. |
| Cursor / Droid / OpenCode | An HTTP MCP lease from `ensureHttpMcpServer(managed, "cto")`, cached in `managed.httpMcpServers.cto` and advertised under the `ade-cto` server name. Transports resolve every live lease at once via `ensureHttpMcpLeases(managed)`. |

Two invariants keep this from breaking quietly:

- **One refresher per Codex runtime.** `refreshCodexDynamicTools` clears the
  dynamic-tool map before rebuilding it, so both tool sets must register inside
  that one function. A second refresher would clobber the first.
- **One tool set per HTTP MCP lease.** `managed.httpMcpServers` is a map keyed
  by tool set rather than a single shared server carrying both, and
  `ensureHttpMcpServer` starts one server per key. `closeHttpMcpServers(managed)`
  drops every lease in the map, so every teardown path releases the CTO one too.

### Where CTO-launched work runs

The CTO session is pinned to the project's **primary lane**, so a tool that
silently defaults its lane would act on the primary worktree. Nothing the CTO
does may land there by omission.

For spawned work:

- **The prompt.** `buildCtoCapabilityManifest`'s operating rules tell the CTO to leave `laneId` off for new work and reserve the lane its session is pinned to for read-only inspection. `ctoState.test.ts` pins the wording.
- **The code.** `resolveCtoExecutionLane` creates a dedicated lane when no `laneId` is requested, honoring the `freshLaneName` / `freshLaneDescription` contract that `CtoOperatorToolDeps` always declared. It never falls back to the CTO session's lane; if lane creation fails the error surfaces (`spawnChat` reports it) rather than quietly re-targeting primary.

For git tools the rule is split by whether the call mutates:

- **Reads default.** `resolveReadLaneId` falls back to `deps.defaultLaneId` — inspecting the primary lane is normal supervision. `gitStatus`, `gitFetch`, `gitListRecentCommits`, `gitListBranches`, `gitStashList`, `gitGetConflictState`, and `getConflictStatus` take this path.
- **Mutations require an explicit lane.** `requireMutationLaneId` has no default and throws when `laneId` is missing; the zod schemas mark it required (`z.string().min(1)`) so the model sees the requirement before it calls. It covers `gitCommit`, `gitPush`, `gitPull`, `gitUndoLastHeadChange`, `gitRedoLastHeadChange`, `gitCheckoutBranch`, `gitStashPush`, `gitStashPop`, `gitRebaseContinue`, `gitRebaseAbort`, and `gitMergeAbort`. `gitGuard` / `conflictGuard` turn the throw into a `{ success: false, error }` naming `listLanes`, so the CTO recovers by retrying with a lane instead of failing the turn.

### Children report back

The CTO is a director, not a dispatcher: work it starts returns to it without
being polled for.

`spawnChat` sets `orchestrationParentSessionId` to the calling CTO session
unconditionally, and `spawnKind` defaults to `"subagent"` — twice, once in the
zod schema and once in the tool body, because the host rejects a parented chat
with no spawn kind and `execute` is reachable without schema parsing. A
`subagent` wakes the CTO when it finishes; a `peer` is fire-and-forget and
leaves a quiet note. The tool result echoes the resolved `spawnKind` back.

A finished child renders in the CTO thread as **one `system_notice` line**, not
a `subagent_result` card. The card restates the child's whole closing summary,
and the CTO runs dozens of chats at once, so a report that pasted a transcript
into the thread would bury everything else it is holding. The line is built by
`formatCtoChildReportLine` and reads `"<child title>" · <provider> · finished |
was stopped | failed`, with `· PR #<n>` appended when
`readChildPullRequestNumber` finds one — from the completion report's artifacts
first, falling back to the closing summary, because plenty of agents write the
number in prose and never file an artifact. The notice is `warning` for a
failure and `info` otherwise, and carries the same `spawnCompletion` payload so
delivery dedupe still anchors on it.

For a subagent the CTO is then woken with the same line as the wake text, plus
any fresh worker discoveries. The wake deliberately carries no `spawnCompletion`
metadata — the notice owns that row, and a second copy would draw the wake
divider header over it.

Because the CTO's steer queue cap is zero, that wake never stages: it is
delivered into the running turn, or starts one.

### Session lifecycle tools

Session lifecycle is not desktop-only and settle is not the only quiet tier. A
session carries a canonical phase plus two independent controls, and both are
reachable from every surface — desktop, iOS, `ade code`, hosted web, the `ade`
CLI, and the CTO's own tools:

- **Settle override** — the tri-state `null | "settled" | "active"` pin. It is
  consulted at the declared-settle tier, *before* the derived exit-0 rule:
  `"active"` is a keep-active pin that suppresses settle entirely, and
  `"settled"` counts as a declared settle alongside `settledAt`.
- **Snooze** — a synced **visibility overlay** that never touches the canonical
  phase. It is stored as `snoozedUntil` / `snoozedAt`, expiry is *derived* by
  comparing the deadline to now, and no scheduler exists anywhere.

The CTO reaches both through `ctoOperatorTools.ts`:

| Tool | Purpose |
| --- | --- |
| `getSessionLifecycle` | Read the settle/snooze slice for any ADE session (chat or tracked CLI). |
| `settleSession` / `unsettleSession` | Declare a session done (optionally with a one-line `outcome`) or return it to the active lifecycle. These write `settle_source = "operator"`. The CTO is the one agent that retains this, as a user-configured operator acting on *other* rows; ordinary worker agents lost self-settlement in 2026-07 (see [terminals-and-sessions](../terminals-and-sessions/README.md)). |
| `setSessionSettleOverride` | Pin the tri-state override; `"active"` is the keep-active pin that suppresses a declared settle. |
| `snoozeSession` | Hide a row until a deadline (`untilIso` or `durationMinutes`). The session keeps running. |
| `wakeSession` | "Clear a snooze on an ADE session so it resurfaces now. No-op when the session was not snoozed." Records `wokeReason` (default `manual`). |

`listChats` and `getChatStatus` carry the same lifecycle block, including
`wokeReason` (`timer | needs_you | error | turn_complete | manual`), so the CTO
can reason about **why** a row resurfaced instead of only that it did. The
lifecycle read degrades to "unknown" rather than failing when a host wires only
a partial session service, which older harnesses do.

See [Terminals and sessions › Session lifecycle](../terminals-and-sessions/README.md#session-lifecycle)
for the canonical derivation and the full cross-surface matrix.

## Voice calls

**Talk** in the CTO header opens a spoken call with the CTO. It runs on GPT Live (`CTO_VOICE_MODEL` = `gpt-live-1`) against `CTO_VOICE_ENDPOINT`, opened with `delegation: { type: "client" }`.

That flag is the whole architecture. The voice model owns *the conversation* — turn-taking, barge-in, prosody, when to hand off — and ADE owns *the reasoning*, which it routes to the CTO thread through the injected `runBackendTurn`. Two things follow, and both are the reason the split is worth the extra moving parts:

- **The CTO's thinking does not move.** It stays on whatever provider and plan `modelPreferences` already names — the same Claude/Codex/Cursor session, the same memory, the same tools. A call is a new mouth on the existing thread, not a second CTO.
- **Only the voice minutes bill to the user.** The key is the user's own OpenAI key, `CTO_VOICE_USD_PER_MINUTE` is `$0.05`, and it bills by the second. The cost sentence is stated before the field rather than discovered on an invoice — see [Onboarding and settings › The OpenAI key follows the machine](../onboarding-and-settings/README.md#the-openai-key-follows-the-machine).

It also means permissions live in ADE's code rather than in a prompt the model is free to reinterpret. `buildCtoVoiceInstructions` tells the live model how to speak and when to delegate; it is told nothing about what it is allowed to do, because it decides none of that.

### The call brain lives in the runtime, and the desktop is a router

This is the second architectural split, and it is the one that decides whether
Talk works at all. The call needs the chat service, the CTO identity and durable
memory — and in a real build those are the **project runtime's** instances, not
the desktop's. `ctx.agentChatService` and `ctx.ctoStateService` on the desktop
`AppContext` are non-null only under `shouldUseInProcessProjectRuntime()`
(`NODE_ENV=test`), so wiring a call to them meant Talk answered
"chat + cto-state service not ready for this project" in every shipped build.

So the brain is `ctoVoiceRuntimeService.ts`, constructed in
`apps/ade-cli/src/bootstrap.ts` and exposed as `AdeRuntime.ctoVoiceCallService`.
It owns the socket, the confirm-first hold, the transcript and the audio queues;
`ctoVoiceCallService.ts` is unchanged underneath it, still taking every
dependency by injection. The desktop's own in-process `AdeRuntime` exposes the
same field, so the test path keeps one shared instance rather than two brains.

What the desktop keeps is what only it can own: the window holding the
microphone (`isCallOwner`), the audio graph, the HUD, and the watchers that hang
a call up when that window closes or reloads. `ctoVoiceWiring.ts` is now a
router with two transports behind one nine-action interface — an in-process
method call when this desktop *is* the runtime, and
`localRuntimePool.callActionForRoot(root, { domain: "cto_voice", … })` otherwise.
The runtime wins whenever there is one. A local pool exists exactly when this
desktop is not itself the project runtime, so reaching for an in-process service
while a pool is present would open a second call brain for a project whose
daemon already owns one — which `ensureProjectContextForMobileSync` makes
reachable in production, because it builds a full project context for any
project a phone touches. In-process is the fallback for the no-pool case, and
`main.ts` builds that service only under `shouldUseInProcessProjectRuntime()`
for the same reason.

**The `cto_voice` action domain** carries `getState`, `hasKey`, `start`, `end`,
`setMuted`, `pushAudio`, `pullAudio`, `resolveApproval` and `sendCapture`. The
list itself is `CTO_VOICE_ACTIONS` in `shared/types/ctoVoice.ts`, not beside the
service that implements them, because the policy tables and the input contracts
consume it: an action list is a contract, and the gate that reads one must not
have to load a WebSocket client to do so. `ADE_ACTION_ALLOWLIST.cto_voice` is
that list sorted, not a second copy of it, so an action added to the contract
cannot leave the allowlist behind. The router dispatches through an
explicit table keyed by that type rather than by string lookup, so `subscribeState`
and `dispose` — in-process only — can never be reached by an action name. Its
rule in `ADE_ACTION_CTO_ONLY` is `{ allExcept: [] }` — fail-closed with no
exceptions, so every action needs `cto` role and one added later is operator-only
by omission. Desktop main qualifies because it launches the project runtime with
`ADE_DEFAULT_ROLE=cto` and refuses to connect to a runtime that answers with any
other default role; an agent-role caller is denied the whole domain. A call is a
billed socket, a live microphone and the CTO's write permissions all at once, and
none of that is an agent's to start, drive, or listen to.

**The `cto_voice` event category** carries call *state* — phase, captions,
pending confirmation — and nothing else. The desktop subscribes with
`subscribeEventsForRoot(root, { category: "cto_voice", replay: false })` and
re-broadcasts each state to every window with its own `isCallOwner` flag.
`replay: false` because a finished call's phases replayed into a fresh
subscription would put a dead HUD back on screen. Because that state carries the
running transcript, both `runtimeEvents.subscribe` and the `stream_events` tool
gate the category on `cto` role too — refused when asked for by name, filtered
out of an uncategorised drain — so an agent that cannot drive a call cannot sit
and listen to one either.

No **renderer** sees the category at all, and that exclusion is written in four
places rather than one. `isRendererRuntimeEventCategory` in `runtimeBridge.ts`
refuses it as a subscription name; `shouldForwardRuntimeEvent` drops it on the
pushed path, because an uncategorised subscription receives every category and
would otherwise carry a call's captions to any window watching runtime events at
all; `withRendererVisibleEvents` strips it out of a **polled** batch, which the
preload casts rather than normalizes; and the preload's own copy of the predicate
drops it again on both paths inbound. The doors are in series and each is written
to stand alone rather than trust the one before it. Nothing on that side consumes
the category — the voice router subscribes in the main process and pushes
`IPC.ctoVoiceState` to the windows that should see it.

**Audio never touches the event buffer.** That buffer is a bounded, replayable
log (capacity 10,000 with a byte cap); ten chunks a second of PCM16 would evict
every orchestrator and runtime event inside seconds. Microphone frames are
batched by the desktop and pushed as `pushAudio` arguments every
`CTO_VOICE_AUDIO_POLL_INTERVAL_MS` (100 ms), and the same interval drains output
with `pullAudio`. Draining is also the call's heartbeat: the runtime hangs up a
call whose owner has said nothing for `CTO_VOICE_OWNER_IDLE_TIMEOUT_MS` (15 s),
which is what stops a crashed window leaving a billed socket and a stranded
confirm-first hold inside a process the user cannot see. An owner that stops
draining loses the oldest chunks past `CTO_VOICE_OUTPUT_AUDIO_QUEUE_LIMIT`
(200, about twenty seconds) rather than growing the process without bound, and
the drop count travels with the drain.

An `ownerToken` minted per call by the desktop is presented on every later voice
action. One window holds the microphone and the speaker, so a second one must not
be able to drain the audio out from under it or hang up its call.

**A microphone that will not open says so.** The renderer owns the microphone,
so when it cannot open one it is the renderer that hangs up — and the main
process has nothing to blame, correctly. That is why this failure shipped
silent: the HUD vanished and nothing said why. `end(reason?)` now carries a
sentence from the bridge through `IPC.ctoVoiceEnd` to the router, which prefers
it whenever the runtime's own terminal state carries no error, and publishes a
corrected terminal even when the runtime's landed first. The End button passes
no reason and stays `ended` with `error: null` — a notice on a hang-up you
performed is noise — and the router has no blanket "The call ended." default:
every involuntary teardown passes its own sentence at its call site.

Before `getUserMedia`, `useCtoVoiceAudioOwner` goes through the OS gate
dictation already owns (`ade.transcription.requestMicAccess` →
`askForMediaAccess`) rather than growing a second one, because on macOS Electron
hands back a live, all-zero track instead of throwing when access is missing —
so `getUserMedia` succeeding proves nothing. A stream that arrives with no audio
track, or one already `ended`, is treated the same way (`muted` deliberately is
not: a track can start muted for a frame, and hanging up on that would refuse
calls on working microphones). The sentence is
`ctoVoiceMicrophoneUnavailableMessage(platform)`, chosen from the preload
platform bridge rather than `navigator.platform`, and names the pane the user
has to open — System Settings › Privacy & Security › Microphone, or Windows
Settings › Privacy › Microphone.

An agent-launched dev Electron is unsigned and macOS refuses it a TCC identity,
so this is every call there; a user-launched or packaged app has a real
microphone. See `reference_dev_electron_mic_tcc`.

**Every teardown names itself.** A call that dies in 150 ms looks identical
whether OpenAI refused it or something inside ADE hung up — `ws` reports a close
of a still-connecting socket as "WebSocket was closed before the connection was
established", which reads exactly like a connection that failed on its own. So
three lines carry the trace permanently: `cto_voice.call_end` (runtime, with
`reason` ∈ owner_end / start_rejected / watchdog / socket_close / socket_error /
socket_rejected / confirm_mode_failed / dispose / replaced, plus `callId`,
`phase` and whether the socket had opened), `cto_voice.router_end` (desktop,
with `reason` ∈ pump_push / pump_pull / stream_ended / owner_navigated /
owner_destroyed / runtime_terminal / start_rejected / user_end / replaced), and
`cto_voice.router_state` for every state the router publishes or drops. Both
end lines are written *before* their re-entry guards, because "end was called
and there was nothing to end" is the answer that was missing.

And a close ADE asked for is no longer described as a failure at all: `endCall`
raises a `deliberateClose` flag before closing, so the error `ws` raises in the
same tick is logged with `deliberate: true` and never becomes a `failed` phase.
A hang-up during `connecting` now ends as `ended` with no error, instead of
blaming OpenAI for it.

**`failed` is terminal, but it is not finished.** The HUD stays on screen for a
`failed` phase on purpose — that state is what the user reads — and the `ended`
that follows is what takes it back off and lets the page notice appear. So a
call that fails publishes exactly two terminal states, in order: `failed`
carrying the sentence, then `ended` carrying it too. Suppressing the second one
left the pill showing "OpenAI rejected this key" forever, with no way out and no
notice.

That is why the runtime's publish suppression is keyed on the teardown REASON
and never on "the phase is already terminal". Only `replaced` (a new call
sweeping a dead one aside) and `dispose` (the project closing) are silent; every
other reason — `socket_rejected`, `socket_error`, `socket_close`, `owner_end`,
`watchdog` — is this call's own ending and must be heard. The router adds the
belt and braces: if the `end` round trip completes and the last phase it
published is still `failed`, it publishes the `ended` itself, carrying the same
error rather than inventing a new one.

**A slot only listens to its own call.** The subscription has to be opened
before `start` is called — otherwise `connecting` is missed — so the first
states down the wire can belong to the call *before* this one. The runtime
clears a dead service on its way into a new call, and that teardown's `ended`
was the first thing every second-and-later call's slot saw: it hung up a call
that was 120 ms old and still connecting, and the socket's "closed before the
connection was established" became the sentence the user read instead of
"OpenAI rejected this key". Two guards, one per side. The router's slot is
claimed by the first **live** state it sees and records that state's `callId`;
anything terminal arriving before the claim is dropped unpublished and unacted
on, and once claimed a state naming a different call is ignored (the
synthesized `ended` carries the slot's own id for the same reason). The runtime
suppresses the broadcast while clearing an already-terminal service — its
`getState` still moves, but a call that is over does not get to speak twice,
and the new call's first published word is its own `connecting` under a fresh
`callId`.

**The HUD learns a call ended from a pushed state and from nothing else.**
There is no poll, and the pill's timer and cost tick locally between pushes — so
a teardown that delivers no terminal state leaves the HUD counting time and
money against a call the runtime hung up seconds ago. That is what a rejected
key did: the microphone starts the instant Talk is pressed, `ws` throws on any
send before the handshake completes, the throw rejected the `pushAudio` action,
the desktop pump read that as "the runtime is gone" and ended the call locally —
dropping the event subscription a moment before the runtime's `failed` arrived.

Three rules close it. The runtime never sends on a socket that is not open
(pre-open microphone frames are buffered to `CTO_VOICE_PREOPEN_AUDIO_LIMIT` and
flushed after `session.start`, and `pushAudio` cannot throw at all). The router
holds one `CallSlot` per call instead of six module-level variables, and its
teardown keeps the state subscription attached across the `end` round trip — so
the runtime's own terminal state still wins if it lands, and only when it has
not does the router synthesize `ended` (carrying the runtime's error if
`getState` can still be reached, else "The call ended."). Every exit broadcasts
exactly one terminal state to every window: a pump failure, a closed owner
window, a dead event stream, an explicit hang-up. The router never invents a
*live* phase — the only state it authors is that one `ended` — and once the
subscription is released a late event cannot put the HUD back on screen.

**A connection that fails says which way it failed.**
`describeCtoVoiceSocketFailure` is a pure mapping from what the failed upgrade
told us to one sentence: 401/403 is "OpenAI rejected this key. Check it under
CTO settings, Voice.", 429 is "OpenAI is rate limiting this key. Try again in a
minute.", and a transport-level error code with no HTTP response at all is "ADE
could not reach OpenAI. Check your internet connection." Anything else keeps
"The voice connection failed." A 500 deliberately does NOT read as a network
problem — OpenAI answered, and sending the user to check their wifi would be
sending them to fix something that is not broken. The status and code travel in
the structured log line beside the sentence.

The order inside that listener is load bearing, and got this wrong once.
Releasing the request is what makes `ws` emit "WebSocket was closed before the
connection was established" — synchronously, in the same tick — and that error
knows nothing about the 401 that caused it. Releasing first therefore let the
generic sentence win the race and latch, and a plainly refused key came back as
"The voice connection failed." So `forwardUnexpectedResponse` reports the
status, describes it and latches it **before** anything is destroyed, and the
teardown's own error is logged with `suppressed: true` and then does nothing.

Getting the status at all takes a listener: `ws` only emits
`unexpected-response` (which carries the HTTP response) when something is
listening, and otherwise collapses it into `Error: Unexpected server response:
401`. `defaultSocket` takes that listener and forwards the status; the mapping
also recovers a status out of that collapsed message, so the two paths agree. A
rejected upgrade can arrive twice — once as the response, once as a later,
emptier error — so the first explanation wins and the generic line cannot
overwrite it.

**The key has to live where the call does.** Moving the brain moved the key
read with it, which exposed a second store split: the machine-scoped API key
trio (`getMachineApiKeyStatus`, `storeMachineApiKey`, `deleteMachineApiKey`) was
desktop-main IPC only, and desktop main writes through
`createDesktopCredentialStore` — whose primary is Electron `safeStorage` —
while the runtime reads through `EncryptedFileCredentialStore`. Settings
answered `configured: true` and Talk answered "no OpenAI key on this machine",
both honestly, about two different stores. The trio is now on the `ai` action
domain and the renderer routes it to the **local** runtime
(`callLocalProjectActionStrictIfBound`), never a remote one — the key follows
this machine's ADE home — with desktop IPC as the fallback for an unbound
window, a remote-bound window, and the in-process runtime mode. The writes are
CTO-only like their project-scoped counterparts; the status read is not, and
never returns the key.

On top of that, the machine scope of `apiKeyStore` now re-reads when the store
changed on disk. Three processes share `~/.ade/secrets` — the desktop app, the
`ade` CLI and the project runtime — and whichever read first used to cache the
store for its whole life. A cheap `statSync` fingerprint (size and mtime of the
two key files and the two credential files, never contents) is compared before
the cache is trusted, and re-stamped after this process's own writes so a write
does not invalidate the writer.

**When there is no call to be had, the refusal says why.** "No project is open",
"not connected to this project's runtime", "no OpenAI key on this machine", "the
CTO chat session is not ready on this machine" — never "service not ready", which
told the user nothing and told the next engineer nothing either.

### The two things a call lets you change

`voiceName` and `voiceBackchannels` live on `CtoIdentity`, not in machine settings:
a voice is a property of *this* CTO, and a different project may want a different
one. Both are optional and additive, so an identity written before voice existed
falls back to `CTO_VOICE_DEFAULT` and backchannels on. `normalizeIdentity`
checks the stored name against `CTO_VOICE_VOICES` rather than trusting it — a
hand-edited `identity.yaml` naming a voice OpenAI does not have would otherwise
fail at connect time, long after the mistake was made. The runtime service reads both per
call, so a change in Settings → Voice applies to the next call with no restart.

### Two measured facts the loop is built around

Both are load bearing and neither is obvious from the API shape.

- **A real microphone never stops.** If the client stops sending input audio the session stalls mid-sentence. So `pushAudio` keeps the stream fed from the renderer's capture node, and a 100 ms `keepAlive` interval sends a buffer of PCM silence for as long as the user is muted. Mute is not "stop sending"; it is "send nothing, continuously."
- **`session.delegation.created` carries an id and no task text.** The event names the delegation and says nothing about what was asked, so the intent has to be rebuilt on ADE's side: the service accumulates `session.input_transcript.delta` into `utterance.text` and hands *that* to `runBackendTurn` when the delegation arrives, rather than waiting for a turn object that never comes.

  The utterance is one record — `{ id, text, open, consumed }` — because the two events are independent on the wire and either can arrive first. So the id turns over when a *new* utterance opens rather than when one finishes, the text survives `done` (a delegation for it may still be in flight) and is consumed exactly once. Rotating on `done` bound a confirmation to the id the user's *next* reply would carry, which made a spoken "yes" impossible to honour; reading a consumed utterance asked the CTO the question it had just answered.

The filler goes out before any backend work starts — `speak(delegationId, "Let me check that.")` on the first line of `handleDelegation`, then `think(...)` with the reconstructed intent as silent context — because the entire point of the `thinking` phase is that the user does not hear silence while ADE works. `speak` posts `session.commentary.append` (paraphrased aloud); `think` posts `session.thinking.append` (usable, never read out).

### A call can do anything the chat can — it just has to ask

A call is not read-only. It runs every tool the CTO runs; what changes is that the ones which write stop and ask you out loud first.

`setCallConfirmMode(true)` takes a hold from `beginIdentityConfirmHold()` before the socket opens, and `normalizeIdentityPermissionMode` answers `default` instead of `full-auto` for as long as any hold is up. `default` is exactly the mode that gate wants: `claudeToolNeedsApproval` lets reads through untouched and raises an approval for anything that writes. Not `plan`, which refuses writes outright — that made the call read-only and left this whole confirmation system unreachable. Not `full-auto` either: an open microphone is an open door, and a misheard sentence must not reach a tool that writes unasked.

The hold lives in the policy rather than on the session because a session-level change cannot hold. The CTO is pinned to `full-auto` by that same function, and `ensureIdentitySession` re-normalizes before every turn, so a mode written once is snapped back before the first word reaches a tool. Leaving plan mode goes through `exitPlanModeForSession`, so no approval path can hand full access back mid-call.

It is a counter, not a flag, so two overlapping calls cannot release each other early, and each call owns its own `releaseConfirmHold`. A call that fails on the way in gives its hold back; a call whose window closes or reloads is ended by `watchOwner`, which is what stops a hold outliving the call that took it.

The hold is also keyed by **session**, because one brain process hosts every open project's scopes and this module is a singleton across all of them — an unkeyed hold put every project's CTO into confirm-first mode, not just the one on the call. `setCallConfirmMode` still takes an unscoped hold first, before resolving the lane, because resolution can fail and a call must never reach the socket with the CTO still on full-auto. The moment the session id is known it takes a scoped hold and releases the unscoped one, in that order, so the gate is never open between them. An unscoped hold still answers for every session while it is up: a caller that could not name its session cannot be narrowed after the fact, and over-applying the gate is the safe direction.

### How a blocked turn reaches your ears

The gate is a promise parked inside `canUseTool`, so a turn waiting on it has not returned — nothing comes back through `runBackendTurn` to say the CTO is stuck. Without a second channel the call simply goes quiet mid-sentence and you have to go find the chat to unblock it, which is the one thing a call exists to avoid.

So for the life of a call the runtime service subscribes to the CTO thread's own events (`watchApprovals`). An `approval_request` on that session becomes a `CtoVoiceConfirmation`, the HUD moves to `confirming`, and the question is spoken with no `delegation_id` — this is ADE asking, not an answer to something the voice model delegated. Your answer goes back through `approveToolUse`, the same call the approval card in the chat makes: a spoken yes and a tap land on one code path, because the call is a second mouth on the CTO thread and not a second permission system.

`describeVoiceApproval` bridges the two vocabularies, and it takes two
independent readings because no provider carries both. The NAME comes out of the
structured detail, in order: `detail.tool` (Claude), `detail.hook.toolName`
(Droid), `detail.request.tool` (Cursor), `detail.request.providerMetadata.tool`,
and finally `event.kind` — which is what the card itself shows when a provider
tells us nothing better. `detail` is always an object, never a string.

The VERDICT comes from the command text, because that is the only place a
force-push is visible at all: a bash approval arrives as `kind: "command"` with
"Run command: git push --force origin main" in its description, and the tool name
(`Bash`) says nothing about blast radius.

Each provider puts that command somewhere else, so all six places are read and
joined: the description (Claude's only copy), `detail.command` and
`request.providerMetadata.command` (Codex, whose description is the model's own
`reason` whenever it gave one), `detail.input.command`, `hook.toolInput.command`
(Droid, Cursor), and `request.providerMetadata.input.command`.

Four ways in, any one of them enough: an ADE operation named outright, a command
whose shape is destructive, a tool already refused by name, or an approval that
cannot be read at all.

**ACP is the one shape that cannot be read, and it fails closed.** A Qwen, Kimi
or Copilot approval carries `detail: { acp: true, provider }`, a description
that is the tool's *title* rather than the command, and provider metadata
holding only ids and option kinds — there is nothing to judge by. An ACP host
only asks at all when it needs permission to change something, so an unreadable
approval is treated as destructive and needs a tap. The cost is one extra tap on
those three providers; the alternative is a misheard "yes" approving something
nobody could see. `isDestructiveVoiceCommand` holds the
conservative pattern list — force-push, `reset --hard`, `branch -D`, `clean -fd`,
`checkout --`, `restore`, `stash drop`, `rm -rf`, `gh pr merge`, `gh release`,
`npm publish`, and ADE actions whose verb is a delete/archive/merge — alongside
`CTO_VOICE_DESTRUCTIVE_TOOLS` for the cases where an operation IS named.

Matching only the ADE names, which is what the first version did, made every
confirmation `destructive: false`: the gate was dead and a misheard "yes" could
force-push. A false positive here costs one tap; a false negative costs history,
so the list errs wide on purpose.

### Confirmation is code, not prompt

Reads narrate freely: a turn that only looked something up comes back as `spoken` text and is said. A mutation stops and asks — but not through the turn's return value. The turn is parked inside `canUseTool` and has not returned at all, so the confirmation is raised from the CTO thread's own `approval_request` event (see above), the service builds a `CtoVoiceConfirmation`, and the HUD moves to the `confirming` phase with a strip the user can tap.

A spoken "yes" is honoured only when `resolveSpokenConfirmation` can show it is genuinely an answer to a question the CTO actually asked. An open microphone is an open door — the CTO's own audio comes back through the speakers, a podcast says "yeah do it", someone walks past — so all four of these must hold:

1. A confirmation is pending.
2. The reply arrived inside `CTO_VOICE_SPOKEN_CONFIRM_WINDOW_MS` (20 s) of the question.
3. It belongs to a **different** `utteranceId` than the one that raised the question. Without this, "force-push it" would both raise the confirmation and approve it.
4. The tool is not in `CTO_VOICE_DESTRUCTIVE_TOOLS`.

That last list — `gitPush`, `gitForcePush`, `gitUndoLastHeadChange`, `gitCheckoutBranch`, `gitStashPop`, `deleteLane`, `archiveLane`, `mergePr`, `publishRelease`, `gitResetHard`, `discardChanges` — is refused by `resolveSpokenConfirmation` before it even looks at the words. A misheard syllable must not be able to publish something or destroy history, so anything whose blast radius is other people's work needs a tap, always. `classifySpokenReply` checks negatives before affirmatives for the same reason: reading "no, don't do it" as approval is the worst available failure.

On approval the service speaks the commitment back before acting (`Doing that now — …`), which gives the user a beat to say no.

### A call can draw

The prompt allows the CTO exactly one ```scene fence after its sentences, and
never instead of them. `splitSpokenSceneAnswer` lifts that fence out of the
answer before it reaches the voice model — leaving it in would have the model
read HTML aloud — validates it through `parseSceneFence` (which owns the byte
cap and what counts as a scene at all), and returns the prose as `spoken` and
the markup as `sceneSource`. `CtoVoiceHudHost` renders it in the same
`SceneFrame` sandbox the transcript uses, so a view drawn during a call and a
view drawn in a chat turn are the same component with the same policy.

A malformed or empty fence is deliberately left in the prose rather than
silently dropped: the user hears something odd, which is a better failure than a
picture that never appears and text that never mentions it.

### The HUD lives at the shell

`CtoVoiceHudHost` is mounted in `AppShell.tsx` beside `ActivityPane` and `CommandPalette`, not inside `CtoPage`. A call you can only see on the CTO tab is a call you have to stop working to have, so mounting it at shell level is what lets it survive route changes and project-tab switches. `GlobalCaptureGestureHost` sits next to it for a stronger version of the same reason (see [Capture gesture](../capture-gesture/README.md)).

The HUD renders nothing in the `idle` and `ended` phases, and the pill shows the phase word, the level meter, the running timer, and `formatVoiceCost(elapsedMs)` — the cost is on screen while the call is happening, not after.

### Scope and limits

- **Desktop only in this release.** There is no iOS voice-call surface and no hosted-web one; `window.ade.ctoVoice` is read optionally everywhere precisely so those clients degrade instead of throwing.
- **A call asks before it writes.** See above. Reads run and narrate; anything that writes stops for a spoken yes, and the eleven operations whose blast radius is other people's work stop for a tap no matter what you say.
- **One window owns the microphone.** Every window shows the pill, so a call stays visible wherever you are working, but only the window that started it captures and plays audio — `isCallOwner` is decided per window by the main process. Two capturing windows would put two interleaved PCM streams into one socket.
- **Local runtimes only.** A remote-bound window refuses with "a voice call runs on the machine that hosts the project, not over a remote runtime" — a deliberate exclusion, not a missing wire. A call would push PCM in both directions across the remote transport at ten chunks a second, which is the thing that transport handles worst, and the microphone is on the wrong machine anyway.
- **No TUI surface.** `ade code` has no audio device to own, so the `cto_voice` domain exists for it as an action surface (`ade --role cto actions run cto_voice.getState` reads a call in progress) without a call UI.

## Tab model

The CTO tab is a single persistent thread plus a settings page — there is no Chat/Team/Workflows/Settings tab bar. The header exposes the mark, the name, **Talk**, and a gear that swaps the thread for `CtoSettingsPage`; **Back to the thread** returns. Model, reasoning, Fast mode, and everything voice live there. A project with no model picked yet shows `ModelPickCard` across the whole surface instead of the thread.

## IPC surface

Registered in `apps/desktop/src/main/services/ipc/registerIpc.ts`, named in `apps/desktop/src/shared/ipc.ts`, reached from the renderer via `window.ade.cto.*`:

- Thread + identity: `ctoEnsureSession`, `ctoGetState`, `ctoGetAttention`, `ctoUpdateIdentity`, `ctoListSessionLogs`, `ctoPreviewSystemPrompt`, `ctoRunProjectScan`.
- Onboarding: `ctoGetOnboardingState`, `ctoCompleteOnboardingStep`. Those two are the only onboarding channels.
- Memory: `ctoGetMemory`, `ctoUpdateMemory`, `ctoSearchMemory`.
- Linear read + credentials/OAuth: `ctoGetLinearConnectionStatus`, `ctoGetLinearProjects`, `ctoGetLinearQuickView`, `ctoGetLinearIssuePickerData`, `ctoSearchLinearIssues`, `ctoGetLinearIssueComments`, `ctoSetLinearToken`, `ctoClearLinearToken`, `ctoStartLinearOAuth`, `ctoGetLinearOAuthSession`, `ctoSetLinearOAuthClient`, `ctoClearLinearOAuthClient`.

Voice calls use a separate bridge, `window.ade.ctoVoice.*`, whose channels are named with the `cto-voice:` prefix rather than `ade.cto.`:

- Renderer to main: `ctoVoiceStart`, `ctoVoiceEnd`, `ctoVoicePushAudio`, `ctoVoiceSetMuted`, `ctoVoiceApprove`, `ctoVoiceDeny`, `ctoVoiceAttachImage`, `ctoVoiceHasKey`.
- Main to renderer: `ctoVoiceState` (the whole call state on every change) and `ctoVoiceAudio` (one base64 PCM16 output chunk).

Those channels are routed by `ctoVoiceWiring.ts`, not handled in `registerIpc.ts` itself.

There are no worker, workflow, flow-policy, sync, or ingress IPC channels — they were removed with those subsystems.

## Sync command surface

Registered by `registerCtoRemoteCommands` in `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` and consumed by the iOS client's `SyncService`:

- `cto.ensureSession`, `cto.getState`, `cto.updateIdentity`.
- `cto.getMemory` — returns the `CtoMemorySnapshot` (durable memory + thread state + today's daily log) the iOS Memory card decodes.
- `cto.getAttention` — the mobile transport for the attention probe. `viewerAllowed`, strictly read-only (it delegates to `agentChatService.getCtoAttention()`, which never calls `ensureIdentitySession`, so a phone drawing a badge cannot materialize a primary lane and a chat session as a side effect), and advertised as an **optional** mobile capability so an older brain omitting it never flips a phone into `limited` mode.
- `cto.getLinearConnectionStatus`, `cto.getLinearQuickView`, `cto.getLinearIssuePickerData`, `cto.searchLinearIssues`, `cto.getLinearIssueComments` — the Linear read surface.
- `cto.startLinearMobileOAuth`, `cto.completeLinearMobileOAuth`, `cto.setLinearToken`, `cto.clearLinearToken` — the Linear **connection-management** surface the iOS Linear pane uses to connect (worker-bounce OAuth or API key), reconnect, and disconnect. All four are `viewerAllowed` and advertised as **optional** mobile capabilities (`MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS` in `syncMobileCompatibility.ts`), so older brains omit them and the phone gates the affordances locally. See [Linear integration](../linear-integration/README.md#connecting-and-managing-from-mobile).

The legacy `cto.getBudgetSnapshot` and `cto.runLinearSyncNow` commands were removed.

## Setup

First run is the model picker. A project whose `modelPreferences` is null opens on `ModelPickCard` instead of the thread, the user picks a model that can steer a live turn, and the CTO is ready to chat. That pick is the entire setup: there is no wizard, no personality question, and nothing to re-run. Reasoning effort, Fast mode, and Linear all layer in afterward from Settings. Voice calls need one more step: a machine-scoped OpenAI key, stored from Settings → Voice or from the sheet **Talk** opens.

`CtoOnboardingState` survives as an internal marker list only. `intro` records that the opening turn was sent and `memory_gardener` records the nightly job; neither is ever shown to the user, and the only surviving operations are `getOnboardingState` and `completeOnboardingStep`.

## Gotchas and fragile areas

- **Dev Electron has no microphone.** An Electron started from an agent or CI shell has no macOS TCC identity, so `getUserMedia` is denied and a call ends with the microphone notice. Start the dev app with `ADE_DEV_FAKE_MEDIA=1 npm run dev:desktop` to get a synthetic microphone and no permission prompt. Use this only for testing the call path.

- **The deterministic flush is the guarantee.** `flushIdentityContinuityDeterministic` runs synchronously and unconditionally before teardown and after compaction; the LLM summary upgrade is best-effort and may be skipped or fail without affecting correctness. Never make the durable write depend on the LLM path.
- **Cursor and Droid emit no compaction signal.** For those runtimes there is no pre-compaction flush hook, so the turn-end daily journal plus the switch-time flush are what make any provider reset recoverable. Treat the daily log as the safety net there.
- **Injected memory is authoritative.** The prompt tells the CTO never to claim memory it does not have injected — changes to injection caps or ordering in `ctoMemoryService`/`ctoStateService` directly change what the CTO "knows."
- **Capability knowledge has two live sources.** `ctoPromptContent.buildCtoCapabilityManifest()` is generated from `createCtoOperatorTools()`. For service actions outside that curated tool set, the CTO prompt directs the model to the installed runtime's `ade actions list --text` catalog and bundled `ade-*` skills instead of a stale hard-coded inventory.
- **One CTO session.** Do not create a second CTO session on a foreign lane; `ensureIdentitySession` rebinds the existing one. Session-creation paths that bypass it would fork the thread.
- **Never add a defaulting lane to a mutating tool.** The CTO session's lane *is* the primary lane. A convenience default on a new write tool means "act on the primary worktree" — follow `requireMutationLaneId`, not `resolveReadLaneId`.
- **Codex tool sets share one refresher.** Adding a third dynamic tool set means extending `refreshCodexDynamicTools`, not writing a second refresher: it clears the runtime's dynamic-tool map first, so a parallel refresher silently deletes the other set's tools.
- **A pack defers a description, never a capability.** `applyCtoToolPackVisibility` must keep every key and every schema. If a change makes an unloaded pack's tools uncallable, the CTO stops being able to do things it is told it can do — and `loadCtoTools` becomes a gate rather than a hint. `ctoToolPacks.test.ts` asserts the no-add/no-drop property, and it is the gate the Claude ToolSearch flip rests on.
- **`loadCtoTools` needs a live session to record anything.** `onToolPackLoaded` / `loadedToolPacks` are wired only when a `managed` session exists; the prompt-manifest preview has neither, so there `loadCtoTools` lists packs but has nowhere to record a load. That is correct — the preview runs no turns.
- **The live state block must stay last.** The turn-context prefix truncates by keeping the tail. Anything appended after the live state block pushes the freshest, most perishable section into the part a budgeted send can cut.
- **Never make the CTO's provider list a read of the composer's table.** `CTO_LIVE_REDIRECT_PROVIDERS` and `ACTIVE_TURN_DISPATCH_MODES` answer different questions. Deriving one from the other means a change to a send menu decides who may be the CTO.
- **`recordDiscovery` is append-only on purpose.** There is no worker-side read tool, and the action policy inverts for `cto_memory` (`allExcept`) so a method added there later is CTO-only by omission. Adding a read tool beside it would hand every agent a view of the CTO's memory as a side effect of letting it contribute.
- **The discovery cursor is a byte offset, not a line count.** Eviction rewinds it by exactly the bytes removed and clamps at zero, and a partial read window rewinds to the last newline. Both rules exist so the queue can re-deliver but never skip; a line-counting cursor breaks both.

## Cross-links

- [`../agents/identity-and-personas.md`](../agents/identity-and-personas.md) — the persistent-identity model, the immutable doctrine, and memory-backed reconstruction.
- [`../linear-integration/README.md`](../linear-integration/README.md) — the canonical Linear doc: connection model, read surface, developer lane/PR flow, live-status round-trip, and the `ade linear` bridge.
- [`../chat/README.md`](../chat/README.md) — the underlying agent-chat session the CTO thread is built on.
- [`../automations/README.md`](../automations/README.md) — event-driven automation rules (independent of the CTO; the CTO no longer owns any intake).
- [`../capture-gesture/README.md`](../capture-gesture/README.md) — the global screenshot chord, whose target is always the CTO: into a live call when one is on air, onto the CTO composer otherwise.
