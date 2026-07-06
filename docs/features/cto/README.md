# CTO

The CTO is ADE's persistent, project-level operator identity — one per project, not a family of rotating chats or a background daemon. It is a single long-living chat thread that behaves as if it remembers everything discussed about the project, plus a small settings surface. There are no workers, no hiring, and no Linear workflow engine: those subsystems were removed. What remains is a durable thread with a smart memory system, first-class mid-thread model switching, and a light Linear read/write surface.

The whole surface is built around one contract: the CTO is a daily chat you can open and use immediately, and its identity, memory, and context survive across sessions, context compaction, and model switches.

## Source file map

### Main services (`apps/desktop/src/main/services/cto/`)

- `ctoStateService.ts` — identity (name, personality, work style, model preferences), session logs, onboarding state, and the system-prompt preview. Owns the immutable doctrine, personality overlays, continuity model, memory-system guidance, environment knowledge, and capability manifest constants. `buildReconstructionContext()` assembles the memory-enriched context injected on session start, compaction, and model switch; `previewSystemPrompt()` returns the same layered prompt the settings UI renders verbatim.
- `ctoMemoryService.ts` — the smart-memory file store under `.ade/cto/`. Reads/writes `MEMORY.md` and `thread-state.md` (atomic writes), appends per-turn lines to `daily/<YYYY-MM-DD>.md`, exposes `searchMemory(query)` (bounded, file-based, most-recent-first), `getSnapshot()`, and `buildMemoryContextSections()` (the capped copies used for injection). No new database or vector dependency.
- `ctoPromptContent.ts` — `buildCtoCapabilityManifest()`, the operator-tool manifest injected into the prompt. Kept in sync with `ctoOperatorTools.ts` by hand, not auto-generated.
- `linearClient.ts` — Linear GraphQL client (shared by desktop and the headless ADE CLI). Reads: `fetchIssueById`, `listProjects`, `searchIssues`, `getQuickView`, `fetchIssueComments`, `listLabels`, `listUsers`. Writes: `updateIssueState`, `updateIssueAssignee`, `createComment`, `addIssueLabel` / `removeIssueLabel`.
- `linearIssueTracker.ts` / `issueTracker.ts` — issue cache, change detection, and the `getQuickView` / `searchIssues` / `fetchIssueComments` read shims plus the `updateIssueState` / `updateIssueAssignee` / `createComment` / `addLabel` write surface renderer surfaces call through.
- `linearGraphQLInput.ts` — GraphQL input builders shared by the client and tracker.
- `linearCredentialService.ts` — personal API key + OAuth client + auth-mode storage, backed by the active project's `.ade/secrets`, with `ensureFreshToken()` for automatic OAuth refresh.
- `linearOAuthService.ts` / `linearOAuthRefreshLock.ts` / `linearTokenRefresh.ts` — PKCE loopback OAuth flow (port 19836), a cross-process refresh lock, and the token-refresh exchange.
- `linearLaneCardService.ts` — builds the "Open in ADE" Linear attachments for lanes, PRs, issue quick-view links, and chat sessions.
- `linearLiveStatusService.ts` — optional live-status round-trip that reflects an ADE agent's progress (launch → In Progress + self-assign + branch comment; PR open → PR-link comment; merge → Done) back into Linear. Gated OFF unless `ADE_LINEAR_LIVE_STATUS_ROUNDTRIP=1`.

The Linear services above are shared plumbing, not CTO-owned workflow machinery. See [Linear integration](../linear-integration/README.md) for the canonical description; this doc only covers what the CTO thread itself uses.

### Renderer (`apps/desktop/src/renderer/components/cto/`)

- `CtoPage.tsx` — the `/cto` shell. A single full-bleed chat thread (`AgentChatPane` with a locked session), not tabs. Slim header: name, personality chip, an interactive model badge (a `ModelPicker` that live-switches the running thread), and a Settings gear. When onboarding is incomplete the thread is replaced by a single `CtoOnboardingCard`. The primary session is cached module-side so it stays warm across tab switches, and is obtained via `window.ade.cto.ensureSession()`.
- `CtoSettingsPanel.tsx` — the right-side settings sheet. Sections, in order: Identity (`IdentityEditor`), Model (`ModelPicker` + reasoning-effort picker), Memory (`CtoMemoryPanel`), Prompt (collapsible `CtoPromptPreview`), and Setup (re-run setup + collapsible session history).
- `CtoMemoryPanel.tsx` — "what the CTO remembers": an editable `MEMORY.md` textarea (save via `window.ade.cto.updateMemory`), a read-only current thread-state, and a collapsible today's daily log. Loads via `window.ade.cto.getMemory`.
- `CtoOnboardingCard.tsx` — the one-card first-run setup: personality preset (with a custom-overlay textarea for `custom`), work style (verbosity / proactivity / escalation via `Segmented`), and an optional name. Completing it saves identity and marks the `identity` onboarding step done.
- `IdentityEditor.tsx` — edits name, personality preset, custom overlay, and work style. It does not edit the model (that lives in the Model section).
- `CtoPromptPreview.tsx` — renders the effective, layered system prompt (doctrine, personality overlay, continuity, memory guidance, environment knowledge, capabilities).
- `personalityTheme.ts` — maps each personality preset to a hue/icon used across the avatar, chip, and selected tiles; also owns `DEFAULT_COMMUNICATION_STYLE`, `WORK_STYLE_ROWS`, and `normalizeCommunicationStyle`.
- `Segmented.tsx` — the compact three-option control used for work-style rows. `useCtoModelOptions.ts` — loads the user's configured model IDs so the header badge and Model section share the composer's catalog. `ctoSessionViewState.ts` — view-state helpers. `identityPresets.ts` — re-export of `shared/ctoPersonalityPresets`. `shared/designTokens.ts` + `shared/TimelineEntry.tsx` — shared class tokens and the session-history timeline row.

### Shared and tools

- `apps/desktop/src/shared/ctoPersonalityPresets.ts` — `CTO_PERSONALITY_PRESETS` (`strategic`, `professional`, `hands_on`, `casual`, `minimal`, `custom`) with label, description, and `systemOverlay`.
- `apps/desktop/src/shared/types/chat.ts` — `AgentChatIdentityKey`, now just the literal `"cto"`. The old `agent:<id>` worker identity keys are gone.
- `apps/desktop/src/main/services/ai/tools/ctoOperatorTools.ts` — the operator tool surface registered for the CTO session, including the memory tools `saveMemory`, `searchMemory`, and `readMemory`.
- `apps/desktop/src/main/services/chat/agentChatService.ts` — owns the CTO session lifecycle: single-session reuse/rebind, the memory flush hooks, and the reconstruction-context injection (all detailed below).

### iOS companion (`apps/ios/ADE/Views/Cto/`)

- `CtoRootScreen.swift` — renders the CTO chat inline as the tab body (single thread, kind `.cto`) with a top-bar gear that opens settings as a sheet. No Team/Workflows navigation.
- `CtoSessionDestinationView.swift` — resolves the always-on CTO session (`ensureCtoSession()`) and reuses the Work chat pipeline to render it.
- `CtoSetup.swift` — the first-run card (name, personality preset, work-style rows) shown when onboarding is incomplete.
- `CtoSettingsScreen.swift` — sections: Identity (edit via `CtoIdentityEditor`), Integrations (read-only Linear connection status), Memory (durable facts + thread summary via `cto.getMemory`), and Advanced (re-run setup).
- `CtoIdentityEditor.swift` / `CtoReloadHelpers.swift` — the identity edit sheet and reload plumbing.

The CTO tab icon is the SF Symbol `brain` (`apps/ios/ADE/App/ContentView.swift`), matching the desktop Phosphor Brain glyph.

## Domain model

### Identity layers

The system prompt is assembled from layered sections (`ctoStateService.previewSystemPrompt`), immutable first:

1. **Immutable doctrine** (`IMMUTABLE_CTO_DOCTRINE`) — the CTO role, the ADE environment description, and precision rules. Always injected, never user-editable, never compacted away.
2. **Personality overlay** — one of six presets. Only `custom` reads `customPersonality` from the identity record.
3. **Continuity model** (`CTO_CONTINUITY_OPERATING_MODEL`) — how ADE re-grounds the CTO across compaction and resumes.
4. **Persistent memory guidance** (`CTO_MEMORY_SYSTEM_GUIDANCE`) — teaches the CTO that it has durable, model-agnostic memory and how to use the `saveMemory` / `searchMemory` / `readMemory` tools proactively.
5. **Environment knowledge** — a glossary of ADE entities (lanes, chats vs terminals, PRs, conflicts, automations, Linear reads) plus intent-to-tool routing, including the live model registry.
6. **Capability manifest** — the full operator tool surface, injected verbatim so the CTO can pick the right tool.

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

- Changing the model from the header badge or the Settings Model section routes through `agentChatService.updateSession` for a live session, moving the same ADE session and transcript to the new provider/model. Before a session exists, the picker writes `identity.modelPreferences` so `ensureSession` reconciles to it.
- The live selection is persisted back into `identity.modelPreferences` (`persistCtoModelPreference`) so the identity file stays the single source of truth in both directions.
- Switch order: flush durable memory → `refreshReconstructionContext` (now memory-rich) → `teardownRuntime` → rebind. Claude→Claude keeps the fast `setModel` path.

### Single session, project-level

`AgentChatIdentityKey` is just `"cto"`. `ensureIdentitySession` reuses the newest CTO session regardless of which lane it was last active on: if nothing lives on the canonical lane but a CTO session exists elsewhere, it reuses that session and rebinds it to the canonical lane instead of forking a parallel thread. There is only ever one CTO thread per project.

## Tab model

The CTO tab is a single persistent thread plus a settings sheet — there is no Chat/Team/Workflows/Settings tab bar. The header exposes the name, personality, live model badge, and a gear that slides in `CtoSettingsPanel` from the right. Onboarding, when incomplete, takes over the whole surface as one card.

## IPC surface

Registered in `apps/desktop/src/main/services/ipc/registerIpc.ts`, named in `apps/desktop/src/shared/ipc.ts`, reached from the renderer via `window.ade.cto.*`:

- Thread + identity: `ctoEnsureSession`, `ctoGetState`, `ctoUpdateIdentity`, `ctoListSessionLogs`, `ctoPreviewSystemPrompt`, `ctoRunProjectScan`.
- Onboarding: `ctoGetOnboardingState`, `ctoCompleteOnboardingStep`, `ctoDismissOnboarding`, `ctoResetOnboarding`.
- Memory: `ctoGetMemory`, `ctoUpdateMemory`, `ctoSearchMemory`.
- Linear read + credentials/OAuth: `ctoGetLinearConnectionStatus`, `ctoGetLinearProjects`, `ctoGetLinearQuickView`, `ctoGetLinearIssuePickerData`, `ctoSearchLinearIssues`, `ctoGetLinearIssueComments`, `ctoSetLinearToken`, `ctoClearLinearToken`, `ctoStartLinearOAuth`, `ctoGetLinearOAuthSession`, `ctoSetLinearOAuthClient`, `ctoClearLinearOAuthClient`.

There are no worker, workflow, flow-policy, sync, or ingress IPC channels — they were removed with those subsystems.

## Sync command surface

Registered by `registerCtoRemoteCommands` in `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` and consumed by the iOS client's `SyncService`:

- `cto.ensureSession`, `cto.getState`, `cto.updateIdentity`.
- `cto.getMemory` — returns the `CtoMemorySnapshot` (durable memory + thread state + today's daily log) the iOS Memory card decodes.
- `cto.getLinearConnectionStatus`, `cto.getLinearQuickView`, `cto.getLinearIssuePickerData`, `cto.searchLinearIssues`, `cto.getLinearIssueComments`.

The legacy `cto.getBudgetSnapshot` and `cto.runLinearSyncNow` commands were removed.

## Setup

First run is one card. The user picks a personality preset, optionally adjusts the work-style rows and a name, and the CTO is ready to chat. Only the `identity` step is required (`CTO_REQUIRED_ONBOARDING_STEPS`). Model, reasoning effort, and Linear all layer in afterward from Settings; nothing else is required to start. Setup can be re-run any time from Settings → Setup → Re-run setup.

## Gotchas and fragile areas

- **The deterministic flush is the guarantee.** `flushIdentityContinuityDeterministic` runs synchronously and unconditionally before teardown and after compaction; the LLM summary upgrade is best-effort and may be skipped or fail without affecting correctness. Never make the durable write depend on the LLM path.
- **Cursor and Droid emit no compaction signal.** For those runtimes there is no pre-compaction flush hook, so the turn-end daily journal plus the switch-time flush are what make any provider reset recoverable. Treat the daily log as the safety net there.
- **Injected memory is authoritative.** The prompt tells the CTO never to claim memory it does not have injected — changes to injection caps or ordering in `ctoMemoryService`/`ctoStateService` directly change what the CTO "knows."
- **Capability manifest stays hand-synced.** `ctoPromptContent.buildCtoCapabilityManifest()` must be kept aligned with `ctoOperatorTools.ts` registrations; it is injected in full and is not generated from the tool list.
- **One CTO session.** Do not create a second CTO session on a foreign lane; `ensureIdentitySession` rebinds the existing one. Session-creation paths that bypass it would fork the thread.

## Cross-links

- [`../agents/identity-and-personas.md`](../agents/identity-and-personas.md) — the persistent-identity model, personality presets, and memory-backed reconstruction.
- [`../linear-integration/README.md`](../linear-integration/README.md) — the canonical Linear doc: connection model, read surface, developer lane/PR flow, live-status round-trip, and the `ade linear` bridge.
- [`../chat/README.md`](../chat/README.md) — the underlying agent-chat session the CTO thread is built on.
- [`../automations/README.md`](../automations/README.md) — event-driven automation rules (independent of the CTO; the CTO no longer owns any intake).
