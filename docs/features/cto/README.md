# CTO

The CTO is ADE's persistent, project-level operator identity — one per project, not a family of rotating chats or a background daemon. It is a single long-living chat thread that behaves as if it remembers everything discussed about the project, plus a small settings surface. There are no workers, no hiring, and no Linear workflow engine: those subsystems were removed. What remains is a durable thread with a smart memory system, first-class mid-thread model switching, and a light Linear read/write surface.

The whole surface is built around one contract: the CTO is a daily chat you can open and use immediately, and its identity, memory, and context survive across sessions, context compaction, and model switches.

## Source file map

### Main services (`apps/desktop/src/main/services/cto/`)

- `ctoStateService.ts` — identity (name, personality, work style, model preferences), session logs, onboarding state, and the system-prompt preview. Owns the immutable doctrine, personality overlays, continuity model, memory-system guidance, environment knowledge, and capability manifest constants. `buildReconstructionContext()` assembles the memory-enriched context injected on session start, compaction, and model switch; `previewSystemPrompt()` returns the same layered prompt the settings UI renders verbatim.
- `ctoMemoryService.ts` — the smart-memory file store under `.ade/cto/`. Reads/writes `MEMORY.md` and `thread-state.md` (atomic writes), appends per-turn lines to `daily/<YYYY-MM-DD>.md`, exposes `searchMemory(query)` (bounded, file-based, most-recent-first), `getSnapshot()`, and `buildMemoryContextSections()` (the capped copies used for injection). No new database or vector dependency.
- `ctoPromptContent.ts` — `buildCtoCapabilityManifest()`, the operator-tool operating rules injected into the prompt. Registered tool schemas are the authoritative capability reference; the prompt does not repeat their descriptions. The retained operating rules are what keep CTO-launched work off the primary lane. Also owns `CTO_INTRO_PROMPT` and `CTO_INTRO_ONBOARDING_STEP` — the opening turn and the once-only marker described in [The opening turn](#the-opening-turn).
- `linearClient.ts` — Linear GraphQL client (shared by desktop and the headless ADE CLI). Reads: `fetchIssueById`, `listProjects`, `searchIssues`, `getQuickView`, `fetchIssueComments`, `listLabels`, `listUsers`. Writes: `updateIssueState`, `updateIssueAssignee`, `createComment`, `addIssueLabel` / `removeIssueLabel`.
- `linearIssueTracker.ts` / `issueTracker.ts` — issue cache, change detection, and the `getQuickView` / `searchIssues` / `fetchIssueComments` read shims plus the `updateIssueState` / `updateIssueAssignee` / `createComment` / `addLabel` write surface renderer surfaces call through.
- `linearGraphQLInput.ts` — GraphQL input builders shared by the client and tracker.
- `linearCredentialService.ts` — personal API key + OAuth client + auth-mode storage, backed by the active project's `.ade/secrets`, with `ensureFreshToken()` for automatic OAuth refresh.
- `linearOAuthService.ts` / `linearOAuthRefreshLock.ts` / `linearTokenRefresh.ts` — PKCE loopback OAuth flow (port 19836), a cross-process refresh lock, and the token-refresh exchange.
- `linearLaneCardService.ts` — builds the "Open in ADE" Linear attachments for lanes, PRs, issue quick-view links, and chat sessions.
- `linearLiveStatusService.ts` — optional live-status round-trip that reflects an ADE agent's progress (launch → In Progress + self-assign + branch comment; PR open → PR-link comment; merge → Done) back into Linear. Gated OFF unless `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`.

The Linear services above are shared plumbing, not CTO-owned workflow machinery. See [Linear integration](../linear-integration/README.md) for the canonical description; this doc only covers what the CTO thread itself uses.

### Renderer (`apps/desktop/src/renderer/components/cto/`)

- `CtoPage.tsx` — the `/cto` shell. A single full-bleed chat thread (`AgentChatPane` with a locked session), not tabs. The slim header shows only the CTO name/avatar and Settings gear; personality and model controls stay in settings. The CTO composer also hides lane, permission, model, reasoning, and fast-mode controls because the session is project-level, always full-access, and settings-owned. When onboarding is incomplete the thread is replaced by a single `CtoOnboardingCard`. The primary session is cached module-side so it stays warm across tab switches, and is obtained via `window.ade.cto.ensureSession()`.
- `CtoSettingsPanel.tsx` — the right-side settings sheet. Sections, in order: Identity (`IdentityEditor`), Model (`ModelPicker` + reasoning-effort + supported Fast toggle), Memory (`CtoMemoryPanel`), Prompt (collapsible `CtoPromptPreview`), and Setup (re-run setup + collapsible session history).
- `CtoMemoryPanel.tsx` — "what the CTO remembers": an editable `MEMORY.md` textarea (save via `window.ade.cto.updateMemory`), a read-only current thread-state, and a collapsible today's daily log. Loads via `window.ade.cto.getMemory`.
- `CtoOnboardingCard.tsx` — the one-card first-run setup: personality preset (with a custom-overlay textarea for `custom`), work style (verbosity / proactivity / escalation via `Segmented`), and an optional name. Completing it saves identity and marks the `identity` onboarding step done.
- `IdentityEditor.tsx` — edits name, personality preset, custom overlay, and work style. It does not edit the model (that lives in the Model section).
- `CtoPromptPreview.tsx` — renders the effective, layered system prompt (doctrine, personality overlay, continuity, memory guidance, environment knowledge, capabilities).
- `personalityTheme.ts` — maps each personality preset to a hue/icon used across the avatar, chip, and selected tiles; also owns `DEFAULT_COMMUNICATION_STYLE`, `WORK_STYLE_ROWS`, and `normalizeCommunicationStyle`.
- `Segmented.tsx` — the compact three-option control used for work-style rows. `useCtoModelOptions.ts` — loads the user's configured model IDs for the settings Model section. `ctoSessionViewState.ts` — view-state helpers. `identityPresets.ts` — re-export of `shared/ctoPersonalityPresets`. `shared/designTokens.ts` + `shared/TimelineEntry.tsx` — shared class tokens and the session-history timeline row.

### Shared and tools

- `apps/desktop/src/shared/ctoPersonalityPresets.ts` — `CTO_PERSONALITY_PRESETS` (`strategic`, `professional`, `hands_on`, `casual`, `minimal`, `custom`) with label, description, and `systemOverlay`.
- `apps/desktop/src/shared/types/chat.ts` — `AgentChatIdentityKey`, now just the literal `"cto"`. The old `agent:<id>` worker identity keys are gone.
- `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` — the operator tool surface. `createCtoOperatorTools()` is the single factory behind the tools a running CTO session can actually call (see [Operator tools on a live session](#operator-tools-on-a-live-session)). It includes the memory tools `saveMemory`, `searchMemory`, and `readMemory`, the session-lifecycle tools described in [Session lifecycle tools](#session-lifecycle-tools), and the git tools whose mutating half refuses to default a lane (`resolveReadLaneId` vs `requireMutationLaneId`).
- `apps/desktop/src/main/services/chat/agentChatService.ts` — owns the CTO session lifecycle: single-session reuse/rebind (`listIdentitySessions` / `ensureIdentitySession`), the memory flush hooks, the reconstruction-context injection, `seedCtoIntroTurn` (the opening turn), `resolveCtoExecutionLane` (where CTO-launched work runs), `buildCtoOperatorToolDeps` / `createCtoRuntimeToolMap` plus the per-provider transports that register them, and the canonical `getCtoAttention` probe (all detailed below).
- `apps/desktop/src/shared/types/cto.ts` — the discriminated `CtoAttentionState` (`idle`, `awaiting-input`, or `unknown`), the shape every attention transport returns. `unknown` means inspection failed and clients must retain their last known badge state.

### Attention surfaces (renderer)

- `apps/desktop/src/renderer/hooks/useCtoAttention.ts` — the probe loop behind the CTO tab dot. Mounted once in `AppShell.tsx`.
- `apps/desktop/src/renderer/state/appStore.ts` — `ctoAttention` + `setCtoAttention`, reset to idle on every project switch/close alongside `terminalAttention`.
- `apps/desktop/src/renderer/components/app/TabNav.tsx` — renders the warning dot on the `/cto` tab with a "waiting since" tooltip.
- `apps/desktop/src/renderer/hooks/useAppWideSessionAttention.ts` — folds `ctoAttention.awaitingInput` into the dock badge count while remaining the only writer of `setDockBadgeCount`.
- `apps/desktop/src/renderer/webclient/adapter/misc.ts` — forwards `getAttention` through the paired runtime's `cto.getAttention` command, so the hosted web `/cto` tab uses the same probe and retention semantics as Electron.

### iOS companion (`apps/ios/ADE/Views/Cto/`)

- `CtoRootScreen.swift` — renders the CTO chat inline as the tab body (single thread, kind `.cto`) with a top-bar gear that opens settings as a sheet. No Team/Workflows navigation.
- `CtoSessionDestinationView.swift` — resolves the always-on CTO session (`ensureCtoSession()`) and reuses the Work chat pipeline with a compact one-line voice/send composer.
- `CtoSetup.swift` — the first-run card (name, personality preset, work-style rows) shown when onboarding is incomplete.
- `CtoSettingsScreen.swift` — sections: Identity (including personality/work style via `CtoIdentityEditor`), Model (live model/reasoning/Fast selection), Integrations (read-only Linear connection status), Memory (durable facts + thread summary via `cto.getMemory`), and Advanced (re-run setup).
- `CtoIdentityEditor.swift` / `CtoReloadHelpers.swift` — the identity edit sheet and reload plumbing.
- `apps/ios/ADE/Models/RemoteModels.swift` — `CtoAttention` (`status`, `awaitingInput`, optional `since`, plus effective-status compatibility for older hosts), the Codable mirror of `CtoAttentionState`.
- `apps/ios/ADE/Services/SyncService.swift` — `fetchCtoAttention()` (the `cto.getAttention` call), the `@Published ctoAttention`, and `refreshCtoAttentionIfNeeded()`, called from `refreshActiveSessionsAndSnapshot()` above its roster-signature early return and from `saveRemoteCommandDescriptors` with `force: true`.

The CTO tab icon is the SF Symbol `brain` (`apps/ios/ADE/App/ContentView.swift`), matching the desktop Phosphor Brain glyph; the same tab carries the attention badge described in [Hidden from rosters, but never silent](#hidden-from-rosters-but-never-silent).

## Domain model

### Identity layers

The system prompt is assembled from layered sections (`ctoStateService.previewSystemPrompt`), immutable first:

1. **Immutable doctrine** (`IMMUTABLE_CTO_DOCTRINE`) — the CTO role, the ADE environment description, and precision rules. Always injected, never user-editable, never compacted away.
2. **Personality overlay** — one of six presets. Only `custom` reads `customPersonality` from the identity record.
3. **Continuity model** (`CTO_CONTINUITY_OPERATING_MODEL`) — how ADE re-grounds the CTO across compaction and resumes.
4. **Persistent memory guidance** (`CTO_MEMORY_SYSTEM_GUIDANCE`) — teaches the CTO that it has durable, model-agnostic memory and how to use the `saveMemory` / `searchMemory` / `readMemory` tools proactively.
5. **Environment knowledge** — a glossary of ADE entities (lanes, chats vs terminals, PRs, conflicts, automations, Linear reads) plus intent-to-tool routing, including the live model registry.
6. **Capability rules** — cross-tool operating rules that are not expressed by any one schema. The registered tool schemas already describe the full tool surface.

### Identity record and work style

Persisted under `.ade/cto/` and mirrored into the `cto_identity_state` DB row (newest wins on reconcile):

- `identity.yaml` — name, personality preset, `customPersonality`, `communicationStyle` (verbosity / proactivity / escalationThreshold — the "work style"), `modelPreferences` (provider, model, modelId, reasoningEffort), constraints, onboarding state, version.
- `CURRENT.md` — ADE-generated working context (recent CTO sessions), refreshed on identity and session-log changes.
- `sessions.jsonl` — hash-chained session log, reconciled with the `cto_session_logs` table.

The entire `cto/` directory is local runtime state by default (git-ignored unless force-added).

### Smart memory system

Files under `.ade/cto/`, owned by `ctoMemoryService`:

| File | Role | Written by | Injected |
| --- | --- | --- | --- |
| `MEMORY.md` | Curated durable facts (decisions, preferences, standing context) under a `## Facts` list | `saveMemory` tool, `CtoMemoryPanel` edits | Always (tail-capped at ~8k chars for injection; disk copy never truncated, hard byte cap 64 KiB drops oldest facts) |
| `thread-state.md` | Rolling summary of the current goal, recent decisions, open loops | Deterministic + best-effort LLM flush | Always (head-capped ~4k chars) |
| `daily/<date>.md` | Per-turn journal: `HH:MM — intent → outcome` | Turn-end append (no LLM) | Today + yesterday (tail-capped ~4k chars) |

`buildMemoryContextSections()` returns the capped, labeled copies; `ctoStateService.buildReconstructionContext()` appends them after the identity/doctrine/environment sections. Only the injected copies are truncated.

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

It is deliberately not a hidden or canned message: ADE has no hidden-turn mechanism, and a fabricated assistant message would feed back into the model's context on every later turn. The `intro` marker lives in `onboardingState.completedSteps` — not a user-facing setup step, but kept in that list so it is persisted and so `ctoResetOnboarding` clears it with the rest — so it survives restarts and fires once; it is written only *after* the send succeeds, so an unauthenticated first run retries instead of burning the one shot. The send is fire-and-forget with `awaitDispatch` so a dispatch failure is logged rather than escaping as an unhandled rejection.

### Operator tools on a live session

The CTO's operator tools are registered on the running session, not merely
advertised in its prompt. `createCtoRuntimeToolMap(managed)` in
`agentChatService.ts` builds the executable map and returns `null` for anything
whose `identityKey` is not `"cto"`, so no other chat can reach these tools.

`buildCtoOperatorToolDeps` builds the dependency set for both the runtime map
and `previewSessionToolNames`. Registered schemas are always loaded for CTO
sessions and are the authoritative capability reference. A live measurement
found that repeating the generated inventory in the prompt added about 11.8k
characters (roughly 2,945 estimated tokens) on top of about 28.8k tokens of MCP
tool schemas, so `buildCtoCapabilityManifest` now carries only cross-tool
operating rules. Tool search remains disabled and `alwaysLoad` remains enabled;
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
a partial session service (the prompt-manifest preview and older harnesses do).

See [Terminals and sessions › Session lifecycle](../terminals-and-sessions/README.md#session-lifecycle)
for the canonical derivation and the full cross-surface matrix.

## Tab model

The CTO tab is a single persistent thread plus a settings sheet — there is no Chat/Team/Workflows/Settings tab bar. The header exposes only the name/avatar and a gear that slides in `CtoSettingsPanel` from the right. Personality, model, reasoning, and Fast mode live in settings. Onboarding, when incomplete, takes over the whole surface as one card.

## IPC surface

Registered in `apps/desktop/src/main/services/ipc/registerIpc.ts`, named in `apps/desktop/src/shared/ipc.ts`, reached from the renderer via `window.ade.cto.*`:

- Thread + identity: `ctoEnsureSession`, `ctoGetState`, `ctoGetAttention`, `ctoUpdateIdentity`, `ctoListSessionLogs`, `ctoPreviewSystemPrompt`, `ctoRunProjectScan`.
- Onboarding: `ctoGetOnboardingState`, `ctoCompleteOnboardingStep`, `ctoDismissOnboarding`, `ctoResetOnboarding`.
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

First run is one card. The user picks a personality preset, optionally adjusts the work-style rows and a name, and the CTO is ready to chat. Only the `identity` step is required (`CTO_REQUIRED_ONBOARDING_STEPS`). Model, reasoning effort, and Linear all layer in afterward from Settings; nothing else is required to start. Setup can be re-run any time from Settings → Setup → Re-run setup.

## Gotchas and fragile areas

- **The deterministic flush is the guarantee.** `flushIdentityContinuityDeterministic` runs synchronously and unconditionally before teardown and after compaction; the LLM summary upgrade is best-effort and may be skipped or fail without affecting correctness. Never make the durable write depend on the LLM path.
- **Cursor and Droid emit no compaction signal.** For those runtimes there is no pre-compaction flush hook, so the turn-end daily journal plus the switch-time flush are what make any provider reset recoverable. Treat the daily log as the safety net there.
- **Injected memory is authoritative.** The prompt tells the CTO never to claim memory it does not have injected — changes to injection caps or ordering in `ctoMemoryService`/`ctoStateService` directly change what the CTO "knows."
- **Capability knowledge has two live sources.** `ctoPromptContent.buildCtoCapabilityManifest()` is generated from `createCtoOperatorTools()`. For service actions outside that curated tool set, the CTO prompt directs the model to the installed runtime's `ade actions list --text` catalog and bundled `ade-*` skills instead of a stale hard-coded inventory.
- **One CTO session.** Do not create a second CTO session on a foreign lane; `ensureIdentitySession` rebinds the existing one. Session-creation paths that bypass it would fork the thread.
- **Never add a defaulting lane to a mutating tool.** The CTO session's lane *is* the primary lane. A convenience default on a new write tool means "act on the primary worktree" — follow `requireMutationLaneId`, not `resolveReadLaneId`.
- **Codex tool sets share one refresher.** Adding a third dynamic tool set means extending `refreshCodexDynamicTools`, not writing a second refresher: it clears the runtime's dynamic-tool map first, so a parallel refresher silently deletes the other set's tools.

## Cross-links

- [`../agents/identity-and-personas.md`](../agents/identity-and-personas.md) — the persistent-identity model, personality presets, and memory-backed reconstruction.
- [`../linear-integration/README.md`](../linear-integration/README.md) — the canonical Linear doc: connection model, read surface, developer lane/PR flow, live-status round-trip, and the `ade linear` bridge.
- [`../chat/README.md`](../chat/README.md) — the underlying agent-chat session the CTO thread is built on.
- [`../automations/README.md`](../automations/README.md) — event-driven automation rules (independent of the CTO; the CTO no longer owns any intake).
