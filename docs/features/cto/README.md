# CTO

The CTO is ADE's persistent, project-level operator identity — one per project, not a family of rotating chats or a background daemon. It is a single long-living chat thread that behaves as if it remembers everything discussed about the project, plus a small settings surface. There are no workers, no hiring, and no Linear workflow engine: those subsystems were removed. What remains is a durable thread with a smart memory system, first-class mid-thread model switching, and a light Linear read/write surface.

The whole surface is built around one contract: the CTO is a daily chat you can open and use immediately, and its identity, memory, and context survive across sessions, context compaction, and model switches.

## Source file map

### Main services (`apps/desktop/src/main/services/cto/`)

- `ctoStateService.ts` — identity (name, persona, model preferences), session logs, onboarding state, and the system-prompt preview. Owns the immutable doctrine, continuity model, memory-system guidance, environment knowledge, and capability manifest constants. `buildReconstructionContext()` assembles the memory-enriched context injected on session start, compaction, and model switch (deliberately without the environment-knowledge document, which the system prompt it is concatenated to already carries); `previewSystemPrompt()` returns the same layered prompt the settings UI renders verbatim. It also owns the live state block: `refreshLiveState()` / `getLiveStateSnapshot()`, the `CtoLiveStateSnapshot` shape, the exported pure renderer `renderCtoLiveStateBlock()`, and `CTO_LIVE_STATE_MAX_CHARS`. Its `getLiveStateSources` constructor argument is a thunk returning `CtoLiveStateSources` (a `Pick` of `CtoOperatorToolDeps`) because the state service is constructed at boot, long before the chat, PR, and automation services exist. `normalizeModelPreferences` is what makes `modelPreferences` nullable — see [Only providers that can redirect a live turn](#only-providers-that-can-redirect-a-live-turn).
- `ctoMemoryService.ts` — the smart-memory file store under `.ade/cto/`, plus the project context store in `projectContextStore.ts` (`.ade/cto/context-store.json`). Reads/writes `MEMORY.md` and `thread-state.md` (atomic writes), appends per-turn lines to `daily/<YYYY-MM-DD>.md`, exposes `searchMemory(query, { limit?, tags? })` (bounded, file-based, tag hits before text hits, with context-store hits that are not already in those files), `getSnapshot()` (including `projectBrief`, `projectThreads`, and `projectItems`), and `buildMemoryContextSections()` (the capped copies used for injection, brief and ranked facts first). It also owns the fact-tag vocabulary (`CTO_MEMORY_TAG_KEYS`, `CtoMemoryTags`, `formatMemoryTagSuffix()`, `parseMemoryTags()`), the per-lane read `listFactsForLane()` and its injectable wrapper `buildLaneMemoryContextSection()`, and the worker discovery queue (`recordDiscovery()`, `readNewDiscoveries()`). No embedding model. When the repo has a git remote, `ctx.*` rows mirror through the existing account settings store.
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

- `CtoPage.tsx` — the `/cto` shell. A single full-bleed chat thread (`AgentChatPane` with a locked session), not tabs. The slim header shows only the CTO name/avatar and Settings gear; model controls stay in settings. The CTO composer also hides lane, permission, model, reasoning, and fast-mode controls because the session is project-level, always full-access, and settings-owned. There is no setup wizard and no first-run card — a project that has never picked a model opens on `ModelPickCard`, which is the CTO's welcome screen. The primary session is cached module-side so it stays warm across tab switches, and is obtained via `window.ade.cto.ensureSession()`. When the wake retries are exhausted the thread is replaced by a failure pane rather than a raw error line: it says the CTO didn't answer and that the thread is still there, puts the underlying error in a `TechnicalDetailsFold`, and offers **Try again**, which resets the retry budget and re-runs the wake effect — a failure pane with no way out is a dead end. Voice comes from the chat composer's own Codex voice button, the same one every chat has; the CTO page adds nothing of its own for it. It also owns `ModelPickCard` (`data-testid="cto-model-pick"`), which takes the thread's place while `modelPreferences` is null; the wake effect is gated on the same condition **and** on the identity snapshot having landed, so nothing materializes a session before the pick is known or on a provider the user has not chosen.
- `CtoSettingsPage.tsx` — settings as a page, not a sheet. A left rail of five sections — Identity, Model, Memory, Prompt, Past threads — and one topic per pane at a readable width. The last one is called **Past threads**, not History, and says why it exists in two sentences (`CTO_PAST_THREADS_DESCRIPTION`): the CTO is one assistant with one memory, running on a conversation thread that is retired when it fills up or the owner starts fresh, and its memory, identity and daily log carry over into the next one. The section id stays `history` because that is what the rail routes on; only the words changed, after an owner read the old ones as a list of different CTOs. The page opens on Model, because the model pick is the setting users change most; that pane pairs the picker with a `ModelFactsCard` whose every line comes from the descriptor through `modelFacts.ts`, so the card and the picker row cannot describe one model two ways. It replaced a 440px drawer that stacked a model picker, a raw markdown editor, a 4.5k-token prompt and a history list in one column, where the things you change sat above two blocks you only read. Memory and Prompt now open on request. Identity carries the name and standing instructions only: the CTO's *voice* is still the doctrine's, and `IMMUTABLE_CTO_DOCTRINE` is not editable from here.
- `ctoSettingsUi.tsx` — the settings page's visual vocabulary: `CTO_SECTION_COLORS` (one accent per section, the way each Settings section has a brand colour), `CtoCard`, and the rest of the type ramp. It imports `SettingsSectionShell` directly rather than copying it, and hand-builds only what is not shareable — two settings surfaces sitting side by side in one app must not read as two products.
- `CtoHistoryList.tsx` — every thread the CTO has retired in this project, as a list you can scan. `sessionTitle` strips the "Session closed: " prefix the log writer put there, because the row should lead with the work rather than with the machine's sentence, and the rows carry no raw tool-tier enum. Each row carries one note under the title from `sessionRetirementNote` — "Retired after 12 turns · memory carried over", or "Still running · this is the live thread" for one that has not ended — which is where the list answers the question the old columns raised: nothing the CTO knows went with the thread. The turn count is no longer a separate column, because the note already says it.
- `CtoMemoryPanel.tsx` — "what the CTO remembers": the project brief as labeled fields, ranked facts as rows with a status, and directed threads as titles (read-only; the CTO writes them), an editable notes textarea (save via `window.ade.cto.updateMemory`), a read-only current thread-state, and today's daily log. Loads via `window.ade.cto.getMemory`.
- `CtoPromptPreview.tsx` — renders the effective, layered system prompt (doctrine, continuity, memory guidance, environment knowledge, capabilities).
- `useCtoModelOptions.ts` — loads the user's configured model IDs for the settings Model section, and owns `ctoModelSupportsLiveRedirect(descriptor)`, the `ModelPicker` filter both CTO pickers pass. It resolves eligibility through `resolveChatProviderForDescriptor` — the provider the model would actually launch on, never its registry family, because an OpenAI model that is not CLI-wrapped runs under OpenCode, which stages everything. `ctoSessionViewState.ts` — view-state helpers. `shared/designTokens.ts` + `shared/TimelineEntry.tsx` — shared class tokens and the session-history timeline row.

### Shared and tools

- `apps/desktop/src/shared/types/chat.ts` — `AgentChatIdentityKey`, now just the literal `"cto"`. The old `agent:<id>` worker identity keys are gone. It also owns `CTO_LIVE_REDIRECT_PROVIDERS` + `providerSupportsLiveRedirect()`, the CTO's provider-eligibility contract.
- `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` — the operator tool surface. `createCtoOperatorTools()` is the single factory behind the tools a running CTO session can actually call (see [Operator tools on a live session](#operator-tools-on-a-live-session)). It includes the memory tools `saveMemory`, `searchMemory`, `readMemory`, and `readDiscoveries`, the pack loader `loadCtoTools`, the session-lifecycle tools described in [Session lifecycle tools](#session-lifecycle-tools), and the git tools whose mutating half refuses to default a lane (`resolveReadLaneId` vs `requireMutationLaneId`). It also owns `CtoOperatorTool` / `CtoOperatorToolMap` (a `Tool` plus its `pack` and derived `alwaysLoad`), `applyCtoToolPackVisibility()`, the `confirmDestructive` gate behind the optional `requestApproval` dep, and `redactConfigValues` — the redaction the `getProjectConfig` tool applies.
- `apps/desktop/src/main/services/ai/tools/ctoCrossMachine.ts` and
  `ctoCrossMachineTools.ts` — the CTO tool contract and implementation for
  machine discovery, action discovery, and policy-checked action execution.
- `apps/ade-cli/src/services/account/ctoCrossMachineBridge.ts` — the runtime
  bridge that pools paired machine connections under the separate
  `ade-cto-remote` caller identity.
- `apps/desktop/src/renderer/components/cto/ctoHomeMachine.ts` and
  `useCtoHome.tsx` — the selected CTO home machine and the account-setting
  fallback used to persist it.
- `apps/desktop/src/main/services/ai/tools/ctoToolPacks.ts` — the closed list of tool packs and nothing else: `CTO_TOOL_PACK_NAMES`, `CtoToolPack`, `CTO_TOOL_PACK_SCOPES` (one line per pack, reused verbatim by the capability manifest), `isCtoToolPack()`. It has **zero imports** on purpose, so the prompt builder can read pack names without dragging zod, the model registry, and the service graph in behind them — the same split as `domains.ts` versus the action registry.
- `apps/desktop/src/main/services/chat/agentChatService.ts` — owns the CTO session lifecycle: single-session reuse/rebind (`listIdentitySessions` / `ensureIdentitySession`), the memory flush hooks, the reconstruction-context injection, `refreshCtoLiveStateForTurn`, `seedCtoIntroTurn` (the opening turn), `ensureCtoMemoryGardenerJob` (the nightly gardening job), `resolveCtoExecutionLane` (where CTO-launched work runs), `buildCtoOperatorToolDeps` / `createCtoRuntimeToolMap` / `createCtoAdvertisedToolMap` plus the per-provider transports that register them, the per-session loaded-pack set `managed.ctoToolPacks`, and the canonical `getCtoAttention` probe (all detailed below).
- `apps/desktop/src/main/services/chat/ctoTurnContext.ts` — the pure pieces of a CTO turn, out of `agentChatService` so they are testable without standing up the provider graph: `truncateTailToLineBoundary()` (tail-truncation that never keeps a partial line), `shouldInjectLaneMemoryContext()`, `readChildPullRequestNumber()`, and `formatCtoChildReportLine()`.
- `apps/desktop/src/main/services/chat/providerThreadContinuity.ts` — which provider-side thread a chat is talking to, and whether it has moved. `persistedPointerState()` (the one complete pointer mapping, shared with the thread-pointer ledger) behind `providerThreadRef()`, the `ProviderThreadRef` record, `providerThreadContinuityChanged()` — where `none` means unknown and the live runtime handle is the thread's identity of last resort — plus the `StagedSection` record and its four operations: `newStagedSection()`, `armIfStale()`, `resetStagedSection()` (the thread is gone; re-stage) and `suppressStagedSection()`. This is what decides whether the ~21 KB static block and the conversation tail ride a turn at all.
- `apps/desktop/src/main/services/chat/sessionTurnHealth.ts` — a session's durable turn health as pure functions over plain records: `normalizeLastTurnFailure()`, `normalizeSessionContextHealth()`, `shouldAdviseSessionRotation()`, and the `nextSessionTurnHealth()` reducer `recordSettledTurnHealth` spends on every `done`. It reports whether the record actually moved, compared field by field rather than by `JSON.stringify`, because a false "changed" costs a disk write on every settled turn of every chat.
- `apps/desktop/src/main/services/chat/identityThreadRotation.ts` — the way out of a thread that is finished, over an injected deps bag (the same shape `claudeReplayOverflowRecovery.ts` uses): `getSessionTurnHealth()`, `getCtoThreadHealth()`, `distilIdentityHandoff()` and `startFreshIdentitySession()`. `agentChatService` keeps thin closures that give it this service's world. See [One thread, and the way out of one that is finished](#one-thread-and-the-way-out-of-one-that-is-finished).
- `apps/desktop/src/main/services/chat/codexCtoToolDeferral.ts` — Codex's dynamic-tool wire shape and the two pure functions that build it: `CodexDynamicToolSpec`, `jsonSchemaForExecutableTool()`, `buildCodexDynamicToolSpecs()`, and the CTO defer predicate `codexDeferCtoTool()`. Service-side types are imported `type`-only, so a unit test for the defer rule costs a zod import rather than the Cursor SDK pool, the Droid worker, and the whole chat graph.
- `apps/desktop/src/main/services/ai/tools/universalTools.ts` — carries `recordDiscovery`, the append-only tool every agent gets (see [Worker discoveries](#worker-discoveries)).
- `apps/desktop/src/shared/types/cto.ts` — the discriminated `CtoAttentionState` (`idle`, `awaiting-input`, or `unknown`), the shape every attention transport returns. `unknown` means inspection failed and clients must retain their last known badge state. It also splits `CtoModelPreferences` out as its own type, because `CtoIdentity.modelPreferences` is now `CtoModelPreferences | null`.
- `apps/desktop/src/renderer/components/shared/ModelPicker/modelFacts.ts` — what a model *is*, in the words a person would use, as pure functions with nothing rendered: `providerLabel` / `PROVIDER_LABELS`, `isPiRoutedModel`, `isLocalModel`, `runsOnLabel`, `subProviderLabel` / `subProviderKey`, `formatTokenCount`, `reasoningEffortLabel`, and `modelDetailLine`. Every fact appears on at least two surfaces — the picker row's detail line and the CTO's model card — so it is formatted once here rather than twice.

### Attention surfaces (renderer)

- `apps/desktop/src/renderer/hooks/useCtoAttention.ts` — the probe loop behind the CTO tab dot. Mounted once in `AppShell.tsx`.
- `apps/desktop/src/renderer/state/appStore.ts` — `ctoAttention` + `setCtoAttention`, reset to idle on every project switch/close alongside `terminalAttention`.
- `apps/desktop/src/renderer/components/app/projectSidebar/ProjectSidebar.tsx` — renders the warning dot on the CTO entry in the sidebar footer.
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

The iOS CTO tab icon is the bundled template asset `CtoMark` (`apps/ios/ADE/App/ContentView.swift`), not an SF Symbol. On desktop, the CTO entry in the project sidebar footer uses the Phosphor `Robot` glyph (`projectSidebar/projectSidebarTabs.ts`).

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

- `identity.yaml` — name, persona, `systemPromptExtension`, `modelPreferences` (provider, model, modelId, reasoningEffort — **nullable**), onboarding state, version. There is no personality preset, no work style and no call voice; `normalizeIdentity` silently drops those keys (including the legacy `voiceName` / `voiceBackchannels`) when an older build wrote them, so an existing file still loads.
- `CURRENT.md` — ADE-generated working context (recent CTO sessions), refreshed on identity and session-log changes.
- `sessions.jsonl` — hash-chained session log, reconciled with the `cto_session_logs` table.

The entire `cto/` directory is local runtime state by default (git-ignored unless force-added).

### Smart memory system

Files under `.ade/cto/`, owned by `ctoMemoryService`:

| File | Role | Written by | Injected |
| --- | --- | --- | --- |
| `context-store.json` | The one project brief, ranked facts, and threads the CTO has directed. Atomic, mode `0600`, gitignored. This is the durable copy: it is not tied to a chat id, so a restart, a crash, and a cleared CTO session leave it in place. When the repo has a git remote, the same rows mirror through the existing account settings store as `ctx.brief`, `ctx.item.<id>`, `ctx.thread.<id>`, and `ctx.meta` (about 120 live facts per repo, so many repos fit the account's shared key budget). `setProjectBrief` keeps any field the caller omits. Rows the cap drops are deleted from the account instead of being pulled back on the next reconcile. | `saveMemory`, `setProjectBrief`, `spawnChat` (thread row), one-time import of `MEMORY.md` bullets | Brief (1.2k), ranked facts (1.8k), threads (800), ahead of the files below |
| `MEMORY.md` | Local notes. Still written by `saveMemory` and the memory panel. New `- ` bullets are copied into the context store; the rest of the file is not stored as one fact. | `saveMemory` tool, `CtoMemoryPanel` edits | Always (tail-capped at 4k chars for injection; disk copy never truncated, hard byte cap 64 KiB drops oldest facts into `memory-archive.md`) |
| `thread-state.md` | Rolling summary of the current goal, recent decisions, open loops | Deterministic + best-effort LLM flush | Always (head-capped 3k chars) |
| `daily/<date>.md` | Per-turn journal: `HH:MM — intent → outcome` | Turn-end append (no LLM) | The two most recent daily files that exist (tail-capped 3k chars) |
| `discoveries.md` / `discoveries-archive.md` / `discoveries.cursor` | The unreviewed worker-discovery queue and its read cursor | The `recordDiscovery` tool, from any agent | Never directly — drained into the CTO's turn (see [Worker discoveries](#worker-discoveries)) |

`buildMemoryContextSections()` returns the capped, labeled copies, with the project brief, ranked facts, and directed threads ahead of the file sections. `ctoStateService.buildReconstructionContext()` appends them after the identity/doctrine/environment sections and still appends the live state block last. Only the injected copies are truncated. The file sections stay inside their 4k/3k/3k caps; the context-store prefix is capped at 1.2k + 1.8k + 800 on top of that.

#### Fact tags

Every durable fact may carry a trailing `[lane:… pr:… path:… topic:…]` suffix. The vocabulary is closed (`CTO_MEMORY_TAG_KEYS`), values are normalized on write — whitespace and `]` runs collapse to `-`, clipped at 120 chars — so the suffix stays parseable by one end-anchored regex, and the suffix is appended **after** the fact is clipped so a long fact can never truncate away its own tags. `parseMemoryTags` is first-wins on a repeated key.

Tags are what make memory addressable rather than merely searchable: `searchMemory(query, { tags })` accepts an empty query when tags are present ("everything about lane X"), and collects into two buckets — facts whose *tag values* matched, then plain substring hits — returning tag hits first so they win the result budget. Untagged facts still match by text. Context-store hits that are not already in those files take up to a quarter of the page, so a fact that exists only in the store still shows up when the files would otherwise fill it.

#### Per-lane memory in project chats

`buildLaneMemoryContextSection(laneId)` returns a "Project memory (ADE, read-only context)" section holding the facts tagged for that lane (newest last, 1.5k chars) plus the rolling thread state (1.2k chars), or `null` when there is nothing lane-scoped — so a worker never receives an empty heading. Lane-tagged facts that exist only in the context store are included and deduped against `MEMORY.md`. `listFactsForLane` deliberately excludes untagged facts: an untagged fact is not a claim about this lane.

The delivery rule is the pure `shouldInjectLaneMemoryContext` (`ctoTurnContext.ts`): never for the CTO (it already has all of memory) or a personal chat (no project lane), otherwise once per lane change, keyed on the same `lastLaneDirectiveKey` the lane execution directive uses. The section therefore arrives beside the directive that explains the lane, and a worker that stays put never pays for it again.

#### Worker discoveries

`recordDiscovery` is a **universal** tool — every agent has it, not just the CTO. It appends one timestamped, secret-redacted, tag-suffixed line to `<adeDir>/cto/discoveries.md`. There is deliberately no matching read tool on the worker side: a worker can hand a finding up without gaining any view of what the CTO knows. `agentChatService` stamps the worker's own lane when the caller did not tag one. The same action is reachable as `ade actions run cto_memory.recordDiscovery` and from automation `ade-action` steps.

The file is capped at 128 KiB — larger than `MEMORY.md`'s 64 KiB because it is a drain queue, not a standing document, with a much wider writer set. Over the cap, the **oldest** entries shift into append-only `discoveries-archive.md` (marked with the eviction instant) rather than being destroyed, and the read cursor rewinds by exactly the bytes removed, clamped at zero: eviction can re-deliver a discovery, never skip one.

`readNewDiscoveries()` drains from a **byte offset** held in `discoveries.cursor`, not a line count, so a concurrent append between read and write can only be re-read. It reads at most a 64 KiB unread window per call, rewinds to the last newline so no discovery is handed out in halves, and treats its char budget as a *drain* budget — the oldest lines that fit are returned and the cursor advances over exactly those, so a backlog drains across several reports instead of being thrown away. At least one line is always handed out even if it alone blows the budget.

Two consumers: the CTO's own `readDiscoveries` core tool (which returns the drained `text`, not `lines`, so one oversized entry cannot carry the whole window into a tool result), and the child-completion wake — when a finished child wakes the CTO, fresh discoveries ride the wake text, never the one-line system notice.

#### Nightly memory gardening

`ensureCtoMemoryGardenerJob` schedules one durable ADE-owned cron job on the CTO session (id `cto-memory-gardener:<sessionId>`, `CTO_MEMORY_GARDENER_CRON` = `30 3 * * *` local to the brain machine, no `expiresAt` — the recurring-cron TTL exists to bound Claude-mirrored rows, and this row has a stable ADE-owned id). The prompt runs in quiet mode — no questions, no lane work, no spawned chats — and distills recent daily logs and the discovery queue into tagged facts with `saveMemory`. Exact duplicate text is ignored, so a merge is a new sentence, not a delete. The job does not call `updateMemory` and it does not remove facts.

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

`CtoIdentity.name` survives as a field rather than a question. It defaults to `"CTO"`, seeds the system prompt (`You are ${identity.name}`), the header, and the avatar initial. The Identity section of `CtoSettingsPage` edits the name and the standing instructions. That form writes through `ctoUpdateIdentity`, and the iOS identity editor writes the same fields through the `cto.updateIdentity` sync command.

### Flush and injection lifecycle

The guarantee is that a deterministic flush always runs before anything can be lost; an LLM upgrade of the summary is best-effort on top. All flush paths live in `agentChatService.ts` and no-op for non-CTO sessions.

- **Turn-end journal (deterministic, cheap).** After each completed or failed CTO turn, `appendCtoTurnJournal` appends one `HH:MM — intent → outcome` line to today's daily log. No LLM call.
- **Pre-compaction flush.** On the runtime's `compacting` / compaction-boundary signal, `maybeRefreshIdentityContinuitySummary(managed, "compaction")` runs `flushIdentityContinuityDeterministic` first (writes the tail-based snapshot to the session and to `thread-state.md`), then kicks off a best-effort LLM summary that overwrites `thread-state.md` when it returns. `refreshReconstructionContext` re-injects afterward.
- **Pre-model/provider-switch flush.** The model-switch path calls the same flush before `teardownRuntime`, so nothing in the old provider window is lost, then rebinds. Both the synchronous switch and the deferred (cursor-busy) switch take this path.
- **Injection** happens by staging `pendingReconstructionContext` and delivering it on the next turn after session start, compaction, and model/provider switch.

#### What the per-turn prefix does and does not repeat

The prefix is the one thing that rides every CTO turn, so anything duplicated inside it is paid for again on every single send — and on a long thread that is what walks the provider window into auto-compaction. The owner's thread went 46k → 237k input tokens in 18 turns and Codex auto-compacted mid-turn, for 27 seconds.

- **The prefix is split by lifetime, and only the perishable half repeats.** `ctoStateService` exposes the two halves as two functions, and `refreshReconstructionContext` stages them on two different clocks:
  - **Static** — `buildStaticContextSection()`: doctrine, continuity model, memory guidance, the ADE environment knowledge document and the capability manifest, i.e. `previewSystemPrompt().prompt` whole. ~21 KB, byte-identical on turn 2 and turn 200, and a live provider thread holds it from the first send. It is staged **once per provider thread** — same `providerThreadContinuityKey` the conversation tail uses — and re-staged when that key moves (rotation, handoff, resume onto a new thread, provider/model switch, fresh session) or when the section's own content `key` moves. The content key is the second trigger on purpose: an identity rename or an edited prompt extension changes the prompt under a live thread and must reach it on the next turn, not at the next rotation. Staging is sticky: the flag clears only when the section actually survived the prefix's character budget. Survival is decided by OFFSET, not by searching the rendered prefix for the section's heading — a conversation tail can quote a heading, and the CTO reads its own prefix back, so the substring test could clear a flag for a section that was cut. `refreshReconstructionContext` records where each attributable section starts (`pendingReconstructionSections`), `truncateTailToLineBoundary` keeps the END of the prefix, and a section counts as delivered exactly when it begins at or after the cut. The static block is first in the prefix, so it is the first thing a tight budget drops — and a thread must never be left believing it was told its own doctrine.
  - **Volatile** — `buildReconstructionContext()`: identity line, current working context, memory sections, the live project-state block. Perishable by construction, so it rides every single send.
  On the synthetic fixture the steady-state turn is 24,269 → 2,651 bytes; turn 1, which has to carry everything, is unchanged at 24,506. Keep the two disjoint. The knowledge document is in the static half and **nowhere else** — `buildReconstructionContext()` deliberately does not emit it, because the two strings are concatenated and a second copy was pure duplication.
- **Codex gets it the same way everyone else does.** It is tempting to assume the doctrine already rides codex's `developerInstructions` at `thread/start` and skip the thread item there. It does not: `buildCodexDeveloperInstructions` builds the generic coding-agent prompt, and the CTO doctrine and capability manifest exist in exactly one place in the codebase — `ctoStateService`. Dropping the static block for codex would quietly take the CTO's whole role away on that provider, so every provider takes the once-per-thread staging. A test pins this.
- **The thread's identity is one mapping, and it lives in `providerThreadContinuity.ts`.** `providerThreadRef()` feeds the live pointers to `persistedPointerState()` — the same complete provider mapping the thread-pointer ledger is keyed on — and returns a `{ provider, ref }` record rather than a packed `provider:ref` string. A second, hand-rolled switch inside `agentChatService` had already drifted: it omitted codex and pi entirely, never read `cursorCloudAgentId`, and missed the `unified` → opencode fold, so those chats sat on a permanent `<provider>:none` and never re-staged anything. `armIfStale(staged, threadKey, contentKey?)` is the one arming routine, and the conversation tail and the static block are now one `StagedSection` record each (`{ threadKey, contentKey, pending }`) rather than two triples of loose fields kept in step by hand across three construction sites.
- **`none` means unknown, not "a different thread".** The send path builds the turn prefix *before* it ensures the runtime, so the ref reads as `none` while a thread is being opened — and that same send delivers the prefix into the thread it opens. Most providers also keep their pointer only in the runtime, so it reads as `none` again whenever the prefix is rebuilt with the runtime down. `providerThreadContinuityChanged` therefore treats a transition involving `none` on the same provider as continuity in **both** directions, and `armIfStale` never overwrites a real ref with `none` — forgetting the thread a section was staged for would make the next real thread look like the same one. Without the first rule every fresh thread paid the whole prefix twice; without the second, a key pinned at `none` compares every future thread against `none` and a rotation never registers at all.
- **A reset forgets the thread, explicitly.** Because the runtime handle survives them, the paths that throw a conversation away — Claude's `conversation_reset` message (`adoptClaudeConversationReset`) and a `resetClaudeQuerySession` that clears the SDK session id — read as continuity to everything above. They call `restageSectionsForNewProviderThread`, which clears both staged keys and arms them. Three more paths belong to the same class and each one is a thread the doctrine would otherwise never reach: Claude's **thread-missing recovery** (a resume onto a conversation the provider no longer has — it clears `sdkSessionId`, so the next send opens a new thread), the **handoff/resume** paths, and **Droid re-readying onto a different `sessionId`** on a pooled connection that otherwise survived (`applyDroidSdkReadyState` compares the id before and after and re-stages when it moved; nothing else watches that id). Without it a brand-new provider session was never told the CTO's doctrine and went on answering as a generic coding agent, with nothing in the product saying so. The replay-overflow recovery is the one caller that then stands the *tail* back down (`suppressStagedSection`): it re-sends the whole transcript, so the tail on top of it would be the same conversation twice — which is what overflowed that chat in the first place. The static block stays armed there, because the replay is the conversation, not the doctrine.
- **The live runtime object is the thread; its name is not.** A thread renames itself once on Claude — ADE mints the SDK session id before the first query and adopts whatever the provider reports back — so the ref alone cannot tell "one thread learning its name" from "a second thread". The key carries the runtime handle and compares it by identity: while it is the same object, nothing has changed. A provider change is always a change, `none` or not.
- **The conversation tail rides only a thread it has not been said to.** `Recent Conversation Tail` (40 turns for the CTO, 20 elsewhere) is re-orientation for a model that cannot see those turns, not context. `providerThreadContinuityKey` identifies the provider-side thread the next send lands on; the tail is pushed only when that key has changed since it was last delivered — a rotated Cursor agent, a model or provider switch, a fresh resume, or a thread that has not opened yet. A live, intact codex/Claude thread already holds the conversation verbatim and gets nothing. The flag is sticky until a send actually consumes it, because the context is rebuilt several times per turn — which is why a brand-new thread's tail, armed while the thread had no name and with no conversation to put in it yet, lands on the *second* send and then never again. Tests pin the rule per adapter (codex, claude, cursor SDK, cursor cloud, pi, opencode/unified, droid, ACP) in `providerThreadContinuity.test.ts`, and end to end on a live codex thread.
- **The headless path refreshes too.** `runSessionTurn` — the headless way a turn reaches the thread — calls the same `refreshCtoLiveStateForTurn` the interactive send does, so a headless turn sees current lanes, PRs, dirty flags and scheduled work instead of whatever the last typed message left behind. It runs on the way into the dispatch rather than before `prepareSendMessage`, because `runSessionTurn` has to register its turn collector synchronously: a `forceDisposeAll` racing a just-started headless turn can only reject a collector that already exists. The prefix is consumed further downstream, so that is early enough.
- **Tool results are bounded at the tool.** `listScheduledWork` returns a compact record per job (id, chat, kind, status, cron/next run, prompt truncated to 120 characters), at most 50 of them, plus `count` and `truncated`. A project-wide call with full prompts once came back at 50 KB and was the single result that tipped a live CTO thread into auto-compaction mid-call. `getScheduledWorkState` is still the full picture for one chat.

### Model switching is first-class

- Changing the model from the Settings Model section routes through `agentChatService.updateSession` for a live session, moving the same ADE session and transcript to the new provider/model.
- **`identity.modelPreferences` is written on every pick, session or no session.** `handleModelChange` writes the preference *first* and then moves the live session, so a failure between the two leaves the durable record holding what the user picked rather than what they replaced. It used to be written only when no session existed, on the theory that `updateSession` would persist it on the way through — and when it did not, the page showed the new model (`currentModelId` prefers the live session's) while the preference silently stayed on `codex/gpt-5.6-luna` at low effort. The next `startFreshSession` then created the thread from that stale preference: a smaller model at a lower reasoning tier than the one on screen, which is why the CTO read as vague for reasons nothing in the UI could explain. Reasoning-tier changes take the same path, because the picker routes them through the same callback.
- Fast mode does not travel onto a model that has no fast tier: the pick sends `currentFastMode && selection.supportsFastMode`.
- The live selection is *also* persisted back into `identity.modelPreferences` by the chat service (`persistCtoModelPreference`) so the identity file stays the single source of truth in both directions. Two writers of the same fact is deliberate belt-and-braces here: the renderer's write is the one the user's click guarantees.
- Switch order: flush durable memory → `refreshReconstructionContext` (now memory-rich) → `teardownRuntime` → rebind. Claude→Claude keeps the fast `setModel` path.

### Single session, project-level

`AgentChatIdentityKey` is just `"cto"`. `ensureIdentitySession` reuses the newest CTO session regardless of which lane it was last active on: if nothing lives on the canonical lane but a CTO session exists elsewhere, it reuses that session and rebinds it to the canonical lane instead of forking a parallel thread. There is only ever one CTO thread per project.

### One thread, and the way out of one that is finished

A single project-level thread is the right default and it has one failure mode: it fills up. The owner's CTO thread crossed its context window by ordinary accumulation across twenty sessions of real work — 3,376 events, ~1.2M tokens against a 1M window — and then every turn failed with `Prompt is too long` while the fallback compaction answered *"conversation could not be reduced below the context limit"*. Nothing in the product said so, and nothing offered a way out.

**Turn health is durable, and it is one field.** Every `done` event passes through `recordSettledTurnHealth` — the one place all providers agree a turn is over. It spends the error text the turn streamed past (from an `error` event or a failed `status`) and writes two things onto the session's persisted state. The decision itself is the pure reducer `nextSessionTurnHealth()` in `chat/sessionTurnHealth.ts`, alongside `normalizeLastTurnFailure`, `normalizeSessionContextHealth` and `shouldAdviseSessionRotation`; the service keeps only the read of the live session, the log line and the write. It also reports whether anything actually moved, compared field by field rather than by `JSON.stringify` — both records are rehydrated, and a false "changed" costs a disk write on every settled turn of every chat:

- `lastTurnFailure` — `{ kind: "context_overflow" | "error", message, at, turnId }`. The `context_overflow` verdict is the only failure that describes the *conversation* rather than the turn, and it is classified by `isContextOverflowFailureText` (which also matches the compaction refusal, because that is the second half of the same event). A completed turn clears it; an interrupted turn leaves it alone, because the user stopping a turn says nothing about the thread.
- `contextHealth` — `{ occupancyPct, aboveHighWaterTurns, compactionSeen, updatedAt }`. Occupancy comes from Claude's own context guardrail where there is one, and otherwise from the settled turn's usage against the context window it reported, so Codex and the rest are covered too.

`getSessionTurnHealth({ sessionId })` reads that record and nothing else — no provider round-trip, no query started — which is what makes it cheap enough to call before drawing a banner. `getCtoThreadHealth()` is the CTO-facing wrapper and is strictly read-only, like `getCtoAttention`: it resolves the thread through `listIdentitySessions` and must never call `ensureIdentitySession`, because materializing a lane and a session as a side effect of drawing a banner is not a thing a banner may do.

**Rotation is offered, never taken.** `shouldAdviseSessionRotation` says yes when the thread has already failed on overflow (past advice — it is broken), or when occupancy has sat at or above `AGENT_CHAT_CONTEXT_ROTATION_PCT` (80%) for `AGENT_CHAT_CONTEXT_ROTATION_TURNS` (2) consecutive settled turns **and** a compaction has already run. The compaction condition matters: before compaction the occupancy number is not the thread's floor, so advising then would be advising for nothing. When it says yes, `CtoPage` shows a quiet, dismissible prompt above the thread. ADE never rotates on its own.

**`startFreshIdentitySession` is the escape hatch, and it is not amnesia.** In order: distil the outgoing thread, flush continuity, write it to durable memory, retire the thread, create a new one. It, `getSessionTurnHealth`, `getCtoThreadHealth` and `distilIdentityHandoff` live in `chat/identityThreadRotation.ts` over an injected deps bag — the same shape `claudeReplayOverflowRecovery.ts` uses — so the policy is readable without the provider graph around it; `agentChatService` keeps thin closures that give it this service's world.

- The distillation prefers **asking the CTO** to write its own hand-off note — but only when there is something to summarize *and* `getSessionTurnHealth` says the thread can still take a turn. The case this whole routine exists for can do neither, so the **deterministic** path is not an apology: it builds the note from the session summary, the last eight user messages, and the titles of any scheduled work, all read from disk. If that comes back empty it says so in the entry — "could not be summarized… its full transcript is still on disk under the retired session" — rather than writing nothing.
- The note goes through the routines a normal turn already uses: `flushIdentityContinuityDeterministic(managed, "session_rotation")`, then the note itself into `continuitySummary` and `thread-state.md` (`writeCtoThreadStateFromSummary`), a dated fact into `memory.md` (`appendMemoryFact`), and one line into the daily log (`appendDailyEntry`).
- Then the old session is **ended**, which is what puts it under Past threads with its turn count and leaves its transcript on disk, and `ensureIdentitySession({ reuseExisting: false })` creates the replacement. Identity, memory, daily log and project state are untouched; only the conversation restarts. `listIdentitySessions` sorts by `lastActivityAt`, so the next `ensureIdentitySession` resolves to the new thread.

**Where it is reachable.** The `cto_state.startFreshSession` action (plus `IPC.ctoStartFreshSession` as the desktop's own fallback) and `window.ade.cto.startFreshSession()`. It is **CTO-only** in `ADE_ACTION_CTO_ONLY.cto_state`: nothing it touches is destructive, but deciding a thread is finished is the operator's call, and an agent that could make it could quietly drop the context it is being supervised with. `cto_state.getThreadHealth` stays open to every role, like `getAttention` — it creates nothing and returns no content. In the UI it is the "Start a fresh session" card under Settings → Model (confirm-before-act, with the plain sentence *"Everything the CTO remembers is kept, and this conversation moves to Past threads. Only the live thread starts over."*), and the rotation prompt on the CTO page.

### Hidden from rosters, but never silent

The CTO thread is pinned to the project's **primary lane** (it needs a lane for its cwd), but it is filtered out of every session roster so it never reads as a chat you started: `agentChatService.listSessions` drops identity sessions unless `includeIdentity` is set, and `chatSessionProjection.projectChatSummariesOntoSessions` plus `laneListSnapshotService` drop the backing terminal row before the Work tab, Lanes tab, and TopBar ever see it. `sessions:get` still resolves the id, so deeplinks and `CtoPage` keep working. Universal search deliberately *does* index the thread — it is your own conversation, and it should be findable in ⌘K.

Hiding the row removes it from `terminalAttention`, which is what the Work dot and the dock badge summarize. A hidden thread that asks a question would otherwise surface nowhere, so attention gets its own path:

- `agentChatService.getCtoAttention()` is the single implementation. All three transports — `IPC.ctoGetAttention` (plain IPC), the `cto_state.getAttention` action (daemon-routed), and the `cto.getAttention` sync command (mobile and hosted web) — delegate to it, so a remote runtime, local Electron window, browser client, and phone cannot derive "needs you" differently. It returns a discriminated `CtoAttentionState`: `idle`, `awaiting-input` with an optional tooltip timestamp, or `unknown` when inspection failed.
- It is **read-only**. It resolves the thread through the same `listIdentitySessions` helper `ensureIdentitySession` uses, but never calls `ensureIdentitySession` itself: rendering a badge must not materialize a primary lane and a chat session as a side effect. The predicate is `awaitingInput || pendingInputItemId || attentionRequestedAt` (the last being an explicit `ade chat ask` hand-raise) rather than `canonicalStatusBucket`, whose awaiting-input bucket folds in `idle` and `ready` and would light the dot whenever the CTO is merely sitting there. A probe failure logs and returns `unknown`, never a false `idle`.
- `useCtoAttention` (mounted once in `AppShell`) keeps `appStore.ctoAttention` fresh from chat events, focus, and a 15 s visible-tab interval; the project sidebar footer renders the dot on the CTO entry. It filters chat events through `shouldRefreshSessionListForChatEvent` so a streaming turn does not re-run a full identity scan per delta, debounces to 1.5 s (0 on focus), ignores `unknown` so the last known state survives a failed host scan, and clears to idle on project switch so the previous project's state cannot linger. The hosted web adapter now exposes `getAttention` over `cto.getAttention`, so this same renderer hook works in paired-browser mode.
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
every turn is its own context cost. `ctoToolPacks.ts` splits it into eleven
packs — `core`, `linear`, `files`, `tests`, `conflicts`, `scheduling`, `proof`,
`search`, `insights`, `config`, `devices` — each with
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
| Claude | `buildClaudeSdkMcpServer(managed, "cto")` returns an SDK MCP server named `ade-cto`, merged into `opts.mcpServers`. It is injected **without** `allowManagedMcpServersOnly` — the CTO is a daily-driver chat and must keep the user's own MCP servers. |
| Codex | `refreshCodexDynamicTools` walks the table and registers each set as dynamic tools under its own namespace — `ade_cto`. Dispatch falls back by bare name across namespaces when a call arrives un-namespaced. |
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

The CTO also has a home machine, stored in account settings for this repository.
Its machine chip opens the home-machine chooser, and all CTO calls stay pinned
to that machine. When the runtime there predates cross-machine tools, the page
shows an update hint. Settings exposes the user's cross-machine access switch;
only the desktop user client can change it, and the phone sync command removes
that field from incoming identity patches.

The runtime bridge in `apps/ade-cli/src/services/account/ctoCrossMachineBridge.ts`
reuses the paired-runtime connector with the distinct `ade-cto-remote` caller
identity. It pools one connection per target, confirms mutating actions, refuses
secret-bearing results on both the caller and target dispatch paths, and closes
idle connections only when no action is in flight. The CTO's `listMachines`,
`listMachineActions`, and `runMachineAction` tools can inspect its home machine
or another account machine. The target runtime applies its own action policy;
unknown actions are not forwarded around that gate.

The CTO session is pinned to the project's **primary lane**, so a tool that
silently defaults its lane would act on the primary worktree. Nothing the CTO
does may land there by omission.

For spawned work:

- **The prompt.** `buildCtoCapabilityManifest`'s operating rules tell the CTO to leave `laneId` off for new work and reserve the lane its session is pinned to for read-only inspection. `ctoState.test.ts` pins the wording.
- **The code.** `resolveCtoExecutionLane` creates a dedicated lane when no `laneId` is requested, honoring the `freshLaneName` / `freshLaneDescription` contract that `CtoOperatorToolDeps` always declared. It never falls back to the CTO session's lane; if lane creation fails the error surfaces (`spawnChat` reports it) rather than quietly re-targeting primary.

For git tools the rule is split by whether the call mutates:

- **Reads default.** `resolveReadLaneId` falls back to `deps.defaultLaneId` — inspecting the primary lane is normal supervision. `gitStatus`, `gitFetch`, `gitListRecentCommits`, `gitListBranches`, `gitStashList`, `gitGetConflictState`, and `getConflictStatus` take this path.
- **Repository writes are refused.** `requireMutationLaneId` still throws when `laneId` is missing, so an omitted lane cannot fall through to the primary worktree. When the lane is named, `assertCtoMayNotWriteRepository` refuses before any git or conflict write: the CTO does not commit, push, pull, rebase, stash, check out, or apply a conflict patch. Those tools answer `{ success: false, error }` and tell the model to `spawnChat` without a `laneId`. `createTerminal` stays, for a command that directs agents.

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

## Tab model

The CTO tab is a single persistent thread plus a settings page — there is no Chat/Team/Workflows/Settings tab bar. The header exposes the mark, the name, and a gear that swaps the thread for `CtoSettingsPage`; **Back to the thread** returns. Model, reasoning, and Fast mode live there. A project with no model picked yet shows `ModelPickCard` across the whole surface instead of the thread.

## IPC surface

Registered in `apps/desktop/src/main/services/ipc/registerIpc.ts`, named in `apps/desktop/src/shared/ipc.ts`, reached from the renderer via `window.ade.cto.*`:

- Thread + identity: `ctoEnsureSession`, `ctoGetState`, `ctoGetAttention`, `ctoUpdateIdentity`, `ctoListSessionLogs`, `ctoPreviewSystemPrompt`, `ctoRunProjectScan`.
- Onboarding: `ctoGetOnboardingState`, `ctoCompleteOnboardingStep`. Those two are the only onboarding channels.
- Memory: `ctoGetMemory`, `ctoUpdateMemory`, `ctoSearchMemory`.
- Linear read + credentials/OAuth: `ctoGetLinearConnectionStatus`, `ctoGetLinearProjects`, `ctoGetLinearQuickView`, `ctoGetLinearIssuePickerData`, `ctoSearchLinearIssues`, `ctoGetLinearIssueComments`, `ctoSetLinearToken`, `ctoClearLinearToken`, `ctoStartLinearOAuth`, `ctoGetLinearOAuthSession`, `ctoSetLinearOAuthClient`, `ctoClearLinearOAuthClient`.

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

First run is the model picker. A project whose `modelPreferences` is null opens on `ModelPickCard` instead of the thread, the user picks a model that can steer a live turn, and the CTO is ready to chat. That pick is the entire setup: there is no wizard, no personality question, and nothing to re-run. Reasoning effort, Fast mode, and Linear all layer in afterward from Settings.

`CtoOnboardingState` survives as an internal marker list only. `intro` records that the opening turn was sent and `memory_gardener` records the nightly job; neither is ever shown to the user, and the only surviving operations are `getOnboardingState` and `completeOnboardingStep`.

## Gotchas and fragile areas

- **The deterministic flush is the guarantee.** `flushIdentityContinuityDeterministic` runs synchronously and unconditionally before teardown and after compaction; the LLM summary upgrade is best-effort and may be skipped or fail without affecting correctness. Never make the durable write depend on the LLM path.
- **Cursor and Droid emit no compaction signal.** For those runtimes there is no pre-compaction flush hook, so the turn-end daily journal plus the switch-time flush are what make any provider reset recoverable. Treat the daily log as the safety net there.
- **Injected memory is authoritative.** The prompt tells the CTO never to claim memory it does not have injected — changes to injection caps or ordering in `ctoMemoryService`/`ctoStateService` directly change what the CTO "knows."
- **Capability knowledge has two live sources.** `ctoPromptContent.buildCtoCapabilityManifest()` is generated from `createCtoOperatorTools()`. For service actions outside that curated tool set, the CTO prompt directs the model to the installed runtime's `ade actions list --text` catalog and bundled `ade-*` skills instead of a stale hard-coded inventory.
- **One CTO session.** Do not create a second CTO session on a foreign lane; `ensureIdentitySession` rebinds the existing one. Session-creation paths that bypass it would fork the thread.
- **The CTO does not write the repository.** A new git or file-changing tool on the CTO pack has to refuse in code, the way `assertCtoMayNotWriteRepository` does. A prompt line is not the gate. The work goes to `spawnChat`.
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
- [`../capture-gesture/README.md`](../capture-gesture/README.md) — the global screenshot chord, whose target is always the CTO composer.
