# Composer and Chat UI

The chat UI lives under `apps/desktop/src/renderer/components/chat/`.
It is composed of a pane (`AgentChatPane`), a message list
(`AgentChatMessageList`), a composer (`AgentChatComposer`), and a
constellation of side panels (tasks, file changes, subagents, computer
use). The pane derives all visible state from the `AgentChatEventEnvelope`
stream plus session metadata.

## Source file map

| Path | Role |
|---|---|
| `AgentChatPane.tsx` | Top-level pane; IPC wiring, session state, presentation profile resolution, lane navigation, parallel launch orchestration, mounting of sub-panels and composer. Visible Work grid tiles flush user/lifecycle/live events immediately and poll-recover active transcripts so inactive-but-visible tiles stay current. Draft chats preserve user-touched model/reasoning/permission controls across late lane-session hydration, and composer text is keyed by session id or lane draft key so switching draft lanes does not reuse another draft's text. Accepts an optional `draftContextTargetId` prop so the Work sidebar can target an unsaved draft composer for context insertions (attachments, iOS/App Control/browser selections, draft text) even before a chat session exists; window event handlers match on either `sessionId` or `draftTargetId`. When auto-creating a lane the draft resolves the primary lane for the `onLaneChange` callback so the sidebar lane context stays in sync. Composer draft state (text, model, reasoning, attachments, context items) is persisted to `localStorage` under the `ade.chat.composerDraft.v1` key family and restored on scope change through `ComposerDraftStorageSnapshot`. Draft launches are tracked through **root**-store-backed `DraftLaunchJob` state machines with multi-step progress (`creating-lane` -> `starting-session` -> `sending-prompt` -> `ready` / `failed`; auto-create names the lane deterministically up front and renames to the AI name in the background, so there is no blocking `naming-lane` phase); jobs live in the root store (not the per-project store) so an in-flight launch survives a remote project switch that tears down the originating project surface. The detached launch chain captures the originating `OpenProjectBinding`, passes it as a `pin` to branch/lane/chat/orchestration/PTY calls so a mid-launch project switch keeps targeting the originating runtime, pins rollback to that binding, and caps each step at 90 s (`withDraftLaunchTimeout`). The composer is cleared optimistically at job start, stale active rows gain a hide-status escape hatch, failed jobs expose Restore in the job strip and matching error banner, and the `DraftLaunchSnapshot` captures the full control state so the async launch uses frozen settings. |
| `apps/desktop/src/renderer/lib/draftLaunchJobs.ts` | Pure helper for Work draft-launch job DTOs, terminal/stale-state detection, and pruning. The list keeps active rows ahead of terminal rows, fills remaining retained slots with terminal rows, and keeps at least one terminal row alongside active jobs. Also owns the durability constants/helpers: `DRAFT_LAUNCH_TIMEOUT_MS` (90 s) + `withDraftLaunchTimeout` (fails a step whose runtime call never settles; the underlying IPC is not cancellable, so it keeps running detached and the timeout only unwedges the renderer-side job) and `LAUNCH_PROJECT_CHANGED_MESSAGE` (the legacy/unpinned abort error used only when no originating project binding is available and the active project drifts mid-launch). |
| `apps/desktop/src/renderer/lib/handoffLaunchJobs.ts` | Pure helper for handoff placeholder DTOs, scope keys, stable placeholder ids, status labels, and search matching. `AgentChatPane` writes these jobs into the root store while `TerminalsPage` passes matching jobs into the Work session sidebar. |
| `AgentChatMessageList.tsx` | Virtualized message list (`@tanstack/react-virtual`). Renders transcript rows and turn dividers, and keeps sticky-bottom sessions pinned across streamed row growth and late virtual-height measurements. Plan-approval rows with non-empty body text render a scrollable markdown block (capped at `360px`) beneath the header so the user can review plan content inline. Codex goal lifecycle rows use user-facing text such as `Goal set`, `Goal paused`, and `Goal cleared`. User messages marked `metadata.hideFullPrompt` render and copy only their `displayText`, keeping internal handoff briefs out of the visible transcript details. |
| `AgentChatComposer.tsx` | Text input, attachments, model selector, permission controls, slash commands, pending-input answering, voice-dictation target registration, and parallel model-slot controls. Launch-prompt clipboard reminder text is controlled by `launchPromptClipboardNoticeEnabled`, separate from the `launchPromptClipboardEnabled` copy behavior. For orchestration model-selection pending inputs it decodes the agent briefing metadata (`workDescription`, `filesHint`, `dependsOn`) before rendering the selection card. |
| `VoiceDictationButton.tsx`, `apps/desktop/src/renderer/services/globalVoiceRecorder.ts`, `apps/desktop/src/renderer/components/voice/*` | Desktop dictation UI and recorder. The module-level recorder owns mic capture across navigation, writes live state to the root app store, transcribes via `window.ade.transcription`, inserts cleaned text into the registered composer, and always copies the cleaned transcript to the clipboard. The header indicator and composer pill render the same recording state. |
| `apps/desktop/src/main/services/transcription/*` | Electron main-process transcription service. Writes captured 16 kHz mono PCM to WAV, runs bundled whisper.cpp `base.en`, parses the JSON sidecar, and applies deterministic glossary cleanup. |
| `apps/desktop/resources/voice/voice-glossary.json`, `apps/desktop/resources/whisper/README.md` | Shared dictation glossary and release notes for materialized whisper resources. The large model and binary are generated by `materialize-whisper-resources.mjs` and ignored by git. |
| `ChatSurfaceShell.tsx` | Floating chat header, body, footer layout. Backdrop-blur glass-morphism styling. |
| `ChatComposerShell.tsx` | Input container chrome reused by the composer. |
| `ChatAttachmentTray.tsx` | Inline file/image attachment tray inside the composer. Image attachments render an inline thumbnail, open a full-size lightbox on click, and expose a copy-to-clipboard button that ships the image bytes via `window.ade.app.writeClipboardImage` so the user can paste them into another app. Pasted images can pass a seeded preview URL from the composer while the temp file is being saved; tray-only image refs fall back to `window.ade.app.getImageDataUrl`. Non-image attachments fall back to the file glyph. |
| `ChatCommandMenu.tsx` | Popover for slash commands and `@`-prefixed file search. Consumes a `ComposerTrigger` from `shared/composerTriggers.ts` (so the menu opens for a mid-draft trigger, not just a leading one), debounces file search at 40 ms, and keeps a per-menu-session query cache (`QUERY_CACHE_MAX = 40`) so cached queries render same-frame while a background revalidation still runs; the cache clears when the menu closes. |
| `apps/desktop/src/shared/composerTriggers.ts` | Cursor-relative typed-trigger detection shared by the desktop chat composer (rich + textarea), the `WorkViewArea` continue composer, and the ade-code TUI (iOS mirrors the same regexes in Swift). `detectComposerTrigger(text, cursorPos)` finds an in-progress `/command` / `@file` token ending at the cursor at any position; `replaceComposerTriggerSpan` splices exactly that span; `findConfirmedComposerTokens` locates confirmed chip tokens for overlay/prompt styling; `composerTriggerSpansWholeDraft` distinguishes a lone leading command from a mid-sentence one. |
| `ChatTasksPanel.tsx` | Todo list rendered from `todo_update` events. |
| `ChatFileChangesPanel.tsx` | Turn-level file change summary with lazy diff expansion. |
| `RewindFilesConfirmDialog.tsx`, `rewindFilesPreview.ts` | Claude-only undo confirmation. Builds a message-scoped file list from SDK dry-run output plus turn diff summaries, then renders per-file expandable diffs before applying `rewindFiles`. |
| `ChatSubagentsPanel.tsx`, `ChatSubagentStrip.tsx` | Subagent panels. For Codex sessions the panel also hosts the chat goal card above plan/subagent progress so the current objective stays visible without crowding the chat header. |
| `ChatComputerUsePanel.tsx` | Computer-use backend status. |
| `ChatAppControlPanel.tsx` | App Control panel for Electron apps. Two mount points: under the chat composer (chat-scoped, `sessionId` set) and inside the Work right-edge sidebar (lane-scoped, `sessionId={null}`). Two modes: **Control** (live screencast frames + launch/connect form + click/type input + quick `terminal write` / `terminal signal` actions) and **Inspect** (hit-test crosshair on the screenshot; commits selections as `AppControlContextItem`s with screenshot, DOM packet, and source-file candidates). Persists panel state under `sessionStorage["ade.chat.appControlPanel.<key>"]`, where the key is `chat:<sessionId>` for the chat mount and `lane:<laneId>:<projectRoot>` for the sidebar mount. Connect/launch calls forward `laneId` so the resulting `AppControlSession` records its launching lane. See [App Control](../computer-use/app-control.md). |
| `ChatIosSimulatorPanel.tsx` | macOS-only iOS Simulator drawer. Two mount points: under the chat composer and inside the Work right-edge sidebar. Tool-readiness checklist, device + target pickers, three-backend live preview, `interact` vs `inspect` mode, hit-test overlay, and selection emission as `IosElementContextItem`. Accepts an optional `laneId` prop, forwarded into `iosSimulator.launch` so the resulting `IosSimulatorSession` records its launching lane. Simulator controls are not blocked when another chat session owns the simulator — ownership only affects which session receives context insertions, not whether the user can interact with the device. See [iOS Simulator feature](../ios-simulator/README.md). |
| `ChatBuiltInBrowserPanel.tsx` | In-app browser panel mounted under the Work right-edge sidebar's `browser` tab. Renders the address bar, navigation/tab strip, inspect toolbar, screenshot capture, and an empty/error state derived from `BuiltInBrowserStatus`; the actual page content is painted by a main-process `WebContentsView` whose bounds the panel reports back to the broker via `ade.builtInBrowser.setBounds`. Inspect-mode hit-tests emit `BuiltInBrowserContextItem` payloads through `onAddContext`; the sidebar then dispatches `ade:agent-chat:add-builtin-browser-context` to the active chat. The panel does not run inside `AgentChatPane` directly — instead, anywhere in the renderer that wants to open a URL calls `openUrlInAdeBrowser()` (in `apps/desktop/src/renderer/lib/openExternal.ts`), which fires `ADE_OPEN_BUILT_IN_BROWSER_EVENT` and asks the broker to open a new tab. |
| `ChatTerminalDrawer.tsx` | Collapsible terminal drawer at the bottom of the chat. |
| `ChatGitToolbar.tsx` | Git status and quick-action toolbar above the composer. The PR action opens or toggles a linked PR when one exists, otherwise opens the PR creation handoff for the current lane targeting the primary branch. Opening the chat PR pane or compact PR menu performs a targeted, cooldown-bound refresh for that single linked PR. |
| `ChatPrPane.tsx` | Left floating PR pane for Work chat. Shows cached lane PR details immediately, then refreshes the linked PR row with the same targeted refresh path so pane toggles surface current merged/closed/check state without a broad PR sync. |
| `ChatProposedPlanCard.tsx` | Composer-level plan approval card shown while input is locked. Renders the plan description or question text as rich markdown (`ChatMarkdown`) inside a scrollable container (capped at `min(34vh, 360px)`). Transcript plan events render through `AgentChatMessageList` / `CodexPlanCard`. |
| `apps/ios/ADE/Views/Work/WorkPlanComposerViews.swift` | iOS composer-level plan approval strip. The live `plan_approval` gate renders as a compact full-width strip above the prompt box, opens a large markdown sheet for review, and sends Approve/Reject decisions through `chat.approve` with optional rejection feedback as `responseText`. It is one body of the consolidated pending-input strip (see [Cross-surface parity](#cross-surface-parity)) — the strip in `WorkChatSessionView+Timeline.swift` renders the current request (plan / approval / permission / question / model-selection), a "Request 1 of N" header, and an "Accept all" sweep when more than one gate is queued. |
| `ChatModelSelectionPendingCard.tsx` | Full agent-briefing model picker for orchestration pending inputs. Shows description, touched files, run-after dependencies, provider/model controls, and submitting/cancel states without a recommended default model. |
| `codex/CodexPlanCard.tsx` | Codex plan card rendered inline in the transcript for `plan` events. Shows plan state (Planning / Plan ready), step progress with status glyphs, and streaming plan text as rich markdown via `ChatMarkdown`. Completed plans with no discrete steps render the full markdown body inline; plans with steps offer a toggle to expand the raw markdown details (labelled "details" when complete, "live" while streaming). Handles missing `steps` arrays gracefully. |
| `codex/CodexGoalCard.tsx`, `codex/CodexGoalBanner.tsx` | Codex goal surfaces. The card is the active desktop surface and routes edits/clears through typed ADE APIs (`ade.agentChat.codex.*`) rather than prompt text. It shows objective, status, token count, and elapsed time, while hiding provider budgets because ADE keeps goals unlimited. The banner remains available for compact surfaces that need a horizontal goal strip. |
| `ChatWorkLogBlock.tsx` | Collapsible work-log group (see `chatTranscriptRows.ts`). Accepts `animate` so completed groups render a static glyph while in-flight ones pulse; prefers `waiting` over `working` when any entry is `interrupted`. Also renders a `LocalhostServersStrip` above the panels when any work-log entry produced a `localhost`/`127.0.0.1`/`0.0.0.0`/`[::1]` URL: a sky-toned chip per detected URL routes through `openUrlInAdeBrowser()` (so the click opens the Work sidebar Browser tab in a new tab), and a sibling Logs button either reveals the chat's currently active terminal (via `onRevealChatTerminal`) or — when no terminal exists — drafts a "please move this server into the ADE chat terminal" prompt for the agent through `onInsertDraft`. |
| `AgentChatMessageList.tsx` → `InlineQuestionRequestCard` | Inline question / structured-question card (provider logo + verb header, dedup body, monospace/markdown previews, per-provider accent, keyboard-first answering, A/B compare). See [Pending input card](#pending-input-card). |
| `CodeHighlighter.tsx`, `chatStatusVisuals.tsx`, `chatSurfaceTheme.ts`, `chatToolAppearance.tsx` | Supporting visuals. `chatStatusVisuals.ChatStatusGlyph` takes an `animate` prop so non-active rows skip the ping/spin animation; `AgentChatMessageList.ActivityIndicator` mirrors this and switches to a dimmed static tone plus a non-looping thinking lottie once the turn ends. |
| `pendingInput.ts`, `chatExecutionSummary.ts`, `chatNavigation.ts`, `chatTranscriptRows.ts` | Pure state derivations consumed by the UI. |
| `apps/desktop/src/renderer/lib/visualContextFormatting.ts` | Prompt formatting for visual/tool context from attachments, iOS Simulator, App Control, and built-in browser selections. |
| `apps/desktop/src/shared/types/chat.ts` | Shared composer/session DTOs, including `PARALLEL_CHAT_MAX_ATTACHMENTS`, parallel launch state types, the `AgentChatModelCatalog*` set, `AgentChatModelCatalogRefreshProvider` (`opencode` / `cursor` / `droid` / `lmstudio` / `ollama`), and `AgentChatModelCatalogArgs` (`mode`, `refreshProvider`). |
| `apps/desktop/src/renderer/components/shared/ModelPicker/` | Modular ModelPicker (see [ModelPicker structure](#modelpicker-structure)): `ModelPicker.tsx`, `ModelPickerContent.tsx`, `ModelPickerRail.tsx`, `ModelListRow.tsx`, `ReasoningEffortPicker.tsx`, `modelCatalog.ts`, `modelOrdering.ts`, `modelPickerSearch.ts`, `providerEmptyState.tsx`, `runtimeCatalogCache.ts`, plus the `useProviderAuthStatus` / `useAuthOnlyFilter` / `useModelFavorites` / `useModelRecents` / `usePerSurfaceModelDefaults` / `useReasoningByFamily` hooks. |

## Pane layout

`AgentChatPane` is the mount point. It:

1. Subscribes to `ade.agentChat.event` for the current session and
   accumulates envelopes into local state.
2. Derives:
   - Message rows via `chatTranscriptRows.ts`.
   - Pending inputs via `pendingInput.ts`.
   - Todo items via `deriveTodoItems()` in `chatExecutionSummary.ts`.
   - Subagent snapshots via `deriveChatSubagentSnapshots()`.
   - Turn diff summaries via `deriveTurnDiffSummaries()`.
3. Resolves a `ChatSurfacePresentation` (standard, resolver, worker
   thread, activity feed) to drive header title, accent color, chips.
4. Mounts the header, message list, composer, and the appropriate
   side panels based on the session's `executionMode` and
   capabilities.

The `ChatSurfaceShell` wraps everything with a floating header (backdrop
blur + subtle glass-morphism), a body region using the theme `--color-bg`,
and a footer that contains the composer.

### Header

- Session title from `chatSessionTitle()`; falls back to "New chat".
- When the session is attached to a lane, a lane navigation button
  renders the lane's label with a branch icon. Clicking navigates to
  the lane in the Lanes tab via the app store.
- CTO and resolver surfaces override the title and chips through
  `ChatSurfacePresentation` (`assistantLabel`, `accentColor`, `chips`).

## Composer

`AgentChatComposer` supports:

- **Text input** with auto-grow up to `composerMaxHeightPx`. Grid tiles
  pass a fixed 144 px ceiling (computed statically from `layoutVariant`)
  rather than the old `ResizeObserver`-based 28 %-of-height formula;
  that eliminated the observer churn without changing the visible
  ceiling for normal tile sizes.
- **Focus-on-active.** The composer receives focus whenever the
  enclosing `AgentChatPane` reports `isTileActive: true` (for packed
  grid tiles) or any equivalent active state — typing in the grid
  immediately targets the focused tile's composer.
- **Attachments** via drag-drop, paste, and an inline picker. Pasted and
  dropped image files show a pending thumbnail while ADE writes the
  temp attachment. Electron clipboard images use
  `ade.app.saveClipboardImageAttachment` when available so the main
  process can save the PNG and return a small preview without sending
  the full base64 payload through the renderer; the legacy
  `ade.agentChat.saveTempAttachment` path remains as the fallback.
  Temp images keep the 10 MB cap and provider-specific MIME validation.
- **Linear issue context.** A Linear-branded chip in the composer
  opens `LinearIssueContextDialog`, which mounts the shared
  `LinearIssueBrowser` so the user can attach a Linear issue as
  chat context. Each attachment is an
  `AgentChatLinearIssueContextAttachment` (`type: "linear_issue"`)
  built by `makeLinearIssueContextAttachment(issue, source)` from
  `shared/chatContextAttachments.ts`. When the chat opens on a
  lane that already has a connected Linear issue, `AgentChatPane`
  automatically attaches the lane's issue with
  `source: "lane_link"` and pins it inside the dialog so the user
  can see what's already linked. The dialog also exposes a deep
  link to Settings > Integrations > Linear when the workspace
  isn't connected. When a turn is dispatched, `agentChatService`
  records every attached Linear issue back onto the lane through
  `laneService.linkLinearIssues({ role: "worked", source:
  "chat_attach", includeInPr: true, evidence: { chatSessionId } })`
  so the issue appears in the next PR body's "Linked Linear issues"
  block — see [features/linear-integration/README.md](../linear-integration/README.md).
- **Typed triggers anywhere.** `detectComposerTrigger(text, cursorPos)`
  (`shared/composerTriggers.ts`) finds an in-progress `/command` or
  `@file` token that ends at the cursor — at any position in the draft,
  not just position 0 (`fix @src/foo.ts then run /test`). Both the rich
  contenteditable and the plain textarea consume it (as do the
  `WorkViewArea` continue-composer and the ade-code TUI, which import
  the same module). Selecting a suggestion replaces exactly the trigger
  span (`replaceComposerTriggerSpan`); a lone leading command keeps the
  legacy fill-the-draft path so the local `/clear` intercept and
  argument-hint scaffold still work. Confirmed tokens render as chips:
  the rich editor inserts non-editable chip nodes
  (`data-composer-chip-text`, serialized back to their literal text),
  and the textarea renders a backdrop overlay that styles confirmed
  `@path`/`/command` tokens while the textarea text goes transparent
  (overlay only mounts when at least one confirmed token exists). IME
  composition freezes trigger re-evaluation until `compositionend`.
- **File attach picker** opened with the `@` key. Runs
  `ade.agentChat.fileSearch` with a 40 ms debounce, a per-menu-session
  query cache (cache hits render same-frame and revalidate silently),
  and a sequence guard that discards stale results. The spinner only
  shows when there is nothing cached to display. The composer fires an
  empty-query `fileSearch` when it binds to a session, which the action
  bridge treats as a warm ping (`fileService.warmQuickOpenIndex`) so
  the lane's name index is built before the first real query.
- **Slash commands.** Local commands (`/clear`, `/login`) are available
  where the current provider owns them and are resolved renderer-side.
  SDK commands, Codex prompt files (`.codex/prompts/**/*.md`), Claude
  command files (`.claude/commands/**/*.md`), and Agent Skill entries
  from `.claude/skills`, `.agents/skills`, `.ade/skills`,
  `.codex/skills`, inherited `ADE_AGENT_SKILLS_DIRS`, and bundled ADE
  skill roots merge in through `ade.agentChat.slashCommands`.
  Claude sessions use Claude SDK/runtime commands plus Claude-compatible
  command/skill files; Codex, Droid, Cursor, and OpenCode also expose
  the filesystem-backed prompt/skill list when their native runtimes do
  not auto-list it. Only `/clear` with `source: "local"` is intercepted
  client-side — every other command is sent to the agent verbatim so
  provider-native commands still flow. The composer also
  decides whether a leading-slash draft is a command or just a sentence
  via `isProviderSlashCommandInput` (heuristics in
  `shared/chatSlashCommands.ts`): `"/rebase the lane?"` is treated as
  chat text, `"/plan"` is treated as a command.
- **Model selection.** `ProviderModelSelector` is embedded and filters
  the registry via `filterChatModelIdsForSession`. Switching within the
  allowed family is a normal update; crossing families triggers a
  handoff. Backed by the modular `ModelPicker` under
  `renderer/components/shared/ModelPicker/` (see
  [ModelPicker structure](#modelpicker-structure)). Dynamic-runtime
  inventories (Cursor / Droid / OpenCode / Ollama / LM Studio) are no
  longer fetched on chat boot — the picker calls
  `window.ade.agentChat.modelCatalog({ mode: "cached" | "refresh-stale" |
  "force", refreshProvider? })` and only triggers a runtime probe when
  the user actually opens the corresponding rail and the per-provider
  freshness TTL has lapsed (`runtimeCatalogCache.ts`: 30 min for
  Cursor / Droid / OpenCode, 30 s for `lmstudio` / `ollama`). Cursor
  runtime rows carry `cursorAvailability`, so chat surfaces hide
  CLI-only models while Work CLI setup includes them and hides
  SDK-only/chat-only rows. When a
  caller passes `availableModelIdsOverride`, `AgentChatPane` constrains
  selection to exactly those ids: `filterChatModelIdsForSession({
  includeActiveSessionModel: false })` skips the usual "preserve the
  active model even if it's not in the list" rule, the runtime-catalog
  merge is bypassed, and `AgentChatComposer` is rendered with
  `constrainModelSelection={true}` so the `ModelPicker` opens with
  `constrainToAvailableModelIds`. The picker drops registry expansion
  (no "Show all models" suggestion) and the picker rail and the
  composer both refuse to commit a value outside the allowlist. A
  matching `constrainedModelSelectionError` blocks submit, draft
  auto-create, and parallel launches if the current model or any
  parallel-slot model fell off the allowlist — main and slot setters
  also no-op on out-of-list ids instead of silently bouncing.
  Handoffs create a root-store `HandoffLaunchJob` before the IPC call
  starts, advance it through summary/chat/send labels while the old
  drawer closes, and remove it once the new chat is created or the
  handoff fails. The Work sidebar renders that job as a non-selectable
  placeholder in the same lane/status/time groups as real sessions.
  Orchestration model-selection requests use
  `ChatModelSelectionPendingCard` instead of the inline selector: the
  card is an agent briefing first (role/tag, description, files,
  dependencies) and a model choice second. It intentionally starts with
  no recommended model so the user makes the routing decision explicitly.
- **Reasoning effort.** A standalone `ReasoningEffortPicker` (extracted
  from the model row) is rendered next to the model trigger when the
  active descriptor exposes `reasoningTiers`. The picker remembers the
  last-used effort per model family via the `useReasoningByFamily`
  hook.
- **Voice dictation.** When voice input is enabled and the bundled
  model is installed, a mic button appears beside Send. Capture is
  owned by the app-global `globalVoiceRecorder`, so recording survives
  composer unmounts and tab/pane navigation. The recorder down-samples
  mic input to 16 kHz mono PCM, calls the main-process transcription
  service, runs deterministic glossary cleanup, inserts the cleaned
  transcript at the registered composer's cursor, and copies the same
  text to the clipboard as a recovery path. The composer pill and top
  bar pill both observe the root-store dictation slice, so their timer
  and waveform stay in sync.
- **Fast mode.** A yellow Lightning chip next to the model selector
  toggles the legacy-named `codexFastMode` bit for the selected
  session. It renders whenever the selected descriptor advertises
  `serviceTiers: ["fast"]`, including dynamic Cursor SDK/CLI rows and
  the Codex GPT 5.4 / 5.5 entries. Codex state flows into the next
  `thread/start` / `turn/start` as `serviceTier: "fast"`; Cursor SDK
  state flows through the discovered model-parameter selection, and
  Work CLI launches resolve fast Cursor rows to the matching `*-fast`
  alias. The toggle is also exposed per-slot in parallel mode through
  `onParallelSlotCodexFastModeChange`.
- **Attachments.** Allows the user to attach files and artifacts to
  the next turn.
- **Permission controls.** Inline with the composer:
  - Interaction mode selector (`default` / `plan`).
  - Claude permission mode — a trigger button that opens a popover
    picker with four tone-coded options: **Ask permissions** (default,
    green), **Accept edits** (blue), **Plan mode** (purple, read-only
    turns), **Bypass permissions** (red). Tone styles live in
    `CLAUDE_MODE_TONE_STYLES`.
  - Codex preset modes (Plan / Guarded Edit / Full Auto) — trigger
    button + popover list. Custom and `config-toml` configurations
    appear as a non-selectable "Custom" row with the active summary
    tooltip, so the trigger can always show the effective preset.
  - OpenCode permission mode selector.
  - Cursor mode snapshot + config options when on Cursor.

  Both the Claude and Codex popovers render via `createPortal` into
  `document.body` and are positioned with `getBoundingClientRect` +
  `window.innerHeight`. That keeps them visible when the composer is
  inside an overflow-hidden container (grid tiles, shells). Clicking
  outside or pressing Escape closes them; the outside-click handler
  checks both the anchor ref and a `data-*-picker-dropdown` attribute
  on the portalized list so clicks inside the popover don't self-close.

- **Parallel launch controls.** When the Work pane mounts an empty,
  embedded draft composer with no locked or initial session, the
  composer can switch into parallel mode. Parallel mode shows a slot
  list instead of the single-session model selector; each slot captures
  the model, reasoning effort, execution mode, and provider-specific
  permission controls that will be copied into that child session.
  The first two slots are cloned from the current composer defaults.
  Users can add/remove slots and open one slot at a time for detailed
  controls. Send is enabled only when the draft is non-empty and at
  least two model slots are configured.

  Attachments in parallel mode are capped by
  `PARALLEL_CHAT_MAX_ATTACHMENTS = 12`. The same attachment list is
  sent to every child lane, so the cap is enforced both when toggling
  parallel mode and when adding files.

- **Work auto-create launch behavior.** Auto-created lanes are named
  deterministically from the prompt (`createDeterministicAutoLaneName`)
  and created **immediately** — naming never sits on the critical path,
  so there is no 10 s suggest race anymore. When AI titles are enabled,
  `startBackgroundLaneNaming` then asks the main process for a name in the
  background (the backend has its own timeout and returns the
  deterministic fallback on failure, so a no-op result is skipped) and,
  if the suggestion differs, applies it via `lanes.rename` and refreshes
  the lane store. The renderer retries the background naming pass once
  (750 ms apart) before keeping the deterministic slug. Branch uniqueness
  is handled by the lane id suffix added by the lane service. Each launch creates a `DraftLaunchJob` that
  tracks progress through `creating-lane` / `starting-session` /
  `sending-prompt` / `ready` / `failed` states (auto-create no longer has
  a distinct `naming-lane` phase — it goes straight to `creating-lane`).
  While the background pass runs, affected lanes are flagged in
  `laneNamingStore` so session cards show "Auto-naming lane underway…".
  The composer is
  cleared optimistically when the job starts so the user can begin
  composing the next prompt immediately; the `DraftLaunchSnapshot`
  freezes the model, reasoning effort, execution mode, and native
  controls at capture time so the async create/send flow uses the
  settings the user had when they pressed Send. Jobs are stored in
  `appStore.draftLaunchJobsByScope`, scoped by project, lane, surface
  profile, and Work draft kind, so loading/error strips survive a new
  chat pane or remount without leaking into another lane pane.
  Foreground launches auto-open the result only if the job is still the
  latest foreground job (tracked by
  `latestForegroundDraftLaunchJobIdRef`); background launches keep the
  current Work focus and render a job strip with an Open action once
  ready. Failed jobs offer a Restore button that merges the snapshot
  back into the composer, and the top error banner mirrors Restore when
  its message matches that failed job. Active jobs remain visible, and
  stale active jobs can be hidden if the backing async never settles;
  terminal rows are pruned per scope.

- **Border beam.** On standard (non-grid-tile) layout the composer
  shell is wrapped in `BorderBeam` (`colorVariant="colorful"` at rest,
  `"ocean"` with a slower duration while a turn is active). `active`
  toggles off for quiet, mid-conversation states.
- **Pending steers.** When steers are queued during an active turn, the
  composer renders a pending-steers section above the input area with
  per-message controls. Each `PendingSteerItem` displays a "Sends after
  turn" badge plus the message text. Hover-revealed actions per
  entry: edit (inline textarea → `ade.agentChat.editSteer`), cancel
  (`ade.agentChat.cancelSteer`), and — for Claude SDK sessions only —
  **send now** (`ArrowBendDownRight`) and **send & interrupt**
  (`Lightning`). **Send now** dispatches the queued message into the
  active turn via `ade.agentChat.dispatchSteer({ mode: "inline" })`;
  the user message then appears in-transcript with
  `deliveryState: "inline"` and the model picks it up at its next
  thinking step. **Send & interrupt** calls
  `dispatchSteer({ mode: "interrupt" })`, which interrupts the current
  turn so the queued message runs as the next turn. Both buttons are
  hidden for non-Claude providers (Codex, OpenCode, Cursor) which only
  support post-turn delivery.
- **Question answering.** When a question-type pending input is active,
  the user answers (or declines) it through the inline question card.
  Multi-select questions render a toggle list plus a preview pane
  (sanitised via `ReactMarkdown` + `rehype-raw` + `rehype-sanitize` +
  `remark-gfm`). The per-question draft state (`QuestionDraft`) tracks
  `text`, `selectedValues`, and `activePreviewValue` independently.
- **Composer lock while pending input is unresolved.** When
  `pendingInput.blocking` is set, the composer hard-locks: the textarea
  / rich editor are disabled, attachment, slash-command, and edit
  affordances are gated, the placeholder switches to a "resolve the
  pending request above" hint, and Enter is a no-op (Escape cancels
  the request). The same gate runs server-side: `agentChatService`
  refuses `sendMessage`, queued steers, and `dispatchSteer` while a
  live pending input exists, throwing
  `"Answer or decline the pending request before sending another
  message."`. `AgentChatPane.submit` mirrors the message into the
  composer's error banner so a fast double-Enter doesn't silently
  drop the second send.

### Layout variants

`AgentChatComposer` accepts a `layoutVariant` prop:

- `"standard"` -- full-width composer (default).
- `"grid-tile"` -- constrained for packed grid tiles; `composerMaxHeightPx`
  limits auto-grow.

### ModelPicker structure

The desktop ModelPicker under
`apps/desktop/src/renderer/components/shared/ModelPicker/` is split into
focused modules. Each piece is independently testable; the same modules
power the TUI picker (`apps/ade-cli/src/tuiClient/components/ModelPicker/`).

| Module | Role |
|---|---|
| `ModelPicker.tsx` | Trigger + popover entry point. Owns runtime-catalog loading via `runtimeCatalogCache`, fast-mode chip, and the favorites/recents fan-out. |
| `ModelPickerContent.tsx` | The popover body: search bar, rail, virtualized list (`@tanstack/react-virtual`), empty state. Props include `hidePermissionRail` (forward-compat hook for orchestrated surfaces that suppress permission-related affordances), `allowCliOnlyModels` (switch Cursor filtering from SDK chat models to CLI launch models), `allowRegistryExpansion` (when false, skip merging `MODEL_REGISTRY` entries into the runtime catalog — useful for constrained surfaces). Estimated row height `MODEL_ROW_ESTIMATED_HEIGHT = 44`. |
| `ModelPickerRail.tsx` | Left-rail tabs (Favorites / Recents / per-provider groups). Reads `AuthStatus` per family to render auth gates and the OpenCode "Install OpenCode" CTA from `providerEmptyState`. |
| `ModelListRow.tsx` | A single model row (favorite star, brand logo, display name, sub-provider chip, availability tone). |
| `ReasoningEffortPicker.tsx` | Standalone reasoning-effort dropdown, mounted next to the model trigger and inside per-slot parallel-launch controls. |
| `modelCatalog.ts` | `descriptorsFromAgentChatModelCatalog`, `mergeSelectorModels`, `resolveModelDescriptorWithRuntimeCatalog`, `createUnknownModelPlaceholder` — pure helpers that flatten the IPC catalog into a `ModelDescriptor[]` and reconcile it with the static registry while preserving runtime metadata such as `serviceTiers` and Cursor `cursorAvailability`. |
| `modelOrdering.ts` | `sortModelItems` — provider/group ordering and intra-group ranking (favorites first, then recents, then default registry order). |
| `modelPickerSearch.ts` | `scoreModelPickerSearch` — fuzzy search across display name, family, provider, and ids; ranks favorites/recents above strict matches. |
| `providerEmptyState.tsx` | Per-provider empty/auth/install CTA copy. Surfaces "Install OpenCode" when the binary is missing, "Sign in to Cursor" when auth is missing, etc. |
| `runtimeCatalogCache.ts` | Renderer-side shared catalog cache. Tracks per-provider freshness (30 min for `opencode`/`cursor`/`droid`, 30 s for `lmstudio`/`ollama`) and dedupes concurrent `modelCatalog` requests by `${mode}:${refreshProvider}` keys. |
| `useProviderAuthStatus.ts` | Resolves `AuthStatus` (`authenticated` / `missing` / `unknown`) per `ProviderFamily` from the AI integration status. |
| `useAuthOnlyFilter.ts` | Hides models whose provider is not authenticated, with a toggle for the catalog browse mode. |
| `useModelFavorites.ts` / `useModelRecents.ts` | Cross-surface favorites and recents persisted to the per-project `ade.db` tables `model_picker_favorites` and `model_picker_recents` via the `modelPicker.*` JSON-RPC methods on `adeRpcServer`. Desktop, TUI, and iOS share the CRR-backed store; the legacy `~/.ade/modelPicker.json` file is only a one-time migration source. |
| `usePerSurfaceModelDefaults.ts` | Per-surface default-model resolver (Settings, parallel slots, CTO, etc.) — keyed by surface so each call site can have its own remembered default. |
| `useReasoningByFamily.ts` | Last-used reasoning effort per model family. |

Renderer state and the TUI share descriptors and ordering: the TUI
`ModelPicker/modelPickerLayout.ts` imports
`modelPickerSearch`/`modelOrdering` from the desktop package directly,
so behaviour stays in lockstep. The TUI layout also preserves
`serviceTiers` and Cursor `cursorAvailability` from the same catalog so
Fast Mode and chat-vs-CLI model availability do not drift between
desktop and `ade code`. Its provider rail stays stable across auth and
runtime-loading states, always shows the full provider catalog with
unavailable rows dimmed, and uses separate rail/list focus so arrow-key
navigation matches the rendered two-column picker.

### Attachment handling

- Pasted and dropped images are written to a temp location. File-backed
  renderer payloads use `ade.agentChat.saveTempAttachment`; native
  clipboard images prefer `ade.app.saveClipboardImageAttachment`, which
  reads the Electron clipboard, writes the PNG beside other chat
  attachments, and returns a downsized preview data URL. While either
  save is in flight, the composer disables send and shows a cancellable
  pending thumbnail in `ChatAttachmentTray`.
- iOS Simulator selections add `IosElementContextItem` chips to the
  composer instead of plain attachments. Each chip is a `data-ios-context`
  node in a contenteditable rich-input variant; submission serialises
  the chips back into the prompt via `formatIosElementContextForPrompt`
  so the model sees a structured tag with `componentId`, source
  file/line, and any metadata. When the same selection produced a
  paired screenshot within 10 s, the chip carries an
  `attachmentPath` so the chip and image stay linked. See the
  [iOS Simulator feature](../ios-simulator/README.md) for the upstream
  flow.
- `inferAttachmentType` and `mergeAttachments` in `shared/types/chat.ts`
  dedupe attachments by path (last-write wins).
- MIME-type validation happens per provider. Claude enforces
  `image/jpeg | image/png | image/gif | image/webp`; Codex uses local
  path references; OpenCode uses runtime content blocks.
- Parallel launches reuse this same attachment path after the renderer
  validates the 12-file cap. Every child session receives identical
  attachment refs; provider-specific handling still happens inside
  `agentChatService.sendMessage`.

## Message list

`AgentChatMessageList` uses `@tanstack/react-virtual` for windowed
rendering. Key rules:

- Assistant message cards constrain to `max-w-[78ch]` for readability
  (recent bump from `72ch` to `78ch` on large screens).
- User messages animate in with a `motion/react` spring transition.
- Code blocks render through `HighlightedCode`.
- Tables get rounded borders, separated spacing, and a subtle inset
  shadow.
- System notices render compact inline (no pill badges).
- Turn dividers (`ChatTurnDivider`) separate turns.
- Plan approval cards display the plan body as rich markdown inside a
  scrollable container (capped at `360px`). When a plan-approval event
  carries non-empty body text, it is rendered as a `MarkdownBlock`
  beneath the header.

Row derivation uses `chatTranscriptRows.ts` (see
[transcript-and-turns](transcript-and-turns.md)).

## Mosaic cards

A Claude-family agent can emit a fenced ` ```mosaic ` code block whose body
is strict versioned JSON (`{"v":1,...}`) describing a small form — text /
select / multiselect / number-or-slider / input / approve-deny / key-value
table elements. `MarkdownBlock`'s code-fence handler renders it as an
interactive `MosaicCard` (`MosaicCard.tsx`) when the pane passes a
Claude-gated `mosaic` context prop (`AgentChatPane`); non-Claude sessions,
and any card that fails the strict parse in `chatMosaic.ts`
(`parseMosaicCard`: unknown version/element type, duplicate id, or malformed
JSON → null), fall back to rendering the plain code fence unchanged. The
artifact is data only — no expressions, no eval, no host actions.

Submitting serializes the selections through `serializeMosaicSubmission`
(readable `- Field: value` lines the user bubble shows, plus a machine
`json` fence keyed by element id) and sends them through the normal
`agentChat.send` path with a `displayText`, so the answer reads as an
ordinary user turn. Answered state is latched for the session in a
`cardKey`-keyed map (`<sessionId>:<row-scope>:<djb2(source)>`) so a card
that unmounts while scrolled out of the virtualized list restores its
"Answered" state on remount; a send failure rolls the latch back so the
user can retry. The TUI collapses the fence to a one-line summary
(`summarizeMosaicCard`) and iOS shows the raw fence. The schema is
documented for agents in the `ade-mosaic` Agent Skill
(`apps/desktop/resources/agent-skills/ade-mosaic/SKILL.md`).

## Tasks panel

`ChatTasksPanel` renders todos from `deriveTodoItems()`. Items carry
status (`pending | in_progress | completed`). The panel:

- Groups with in-progress first, then pending, then completed.
- Renders status glyphs (filled check, spinning arc, empty circle).
- Supports collapse/expand with a count badge in the header.

Wrapped in `BottomDrawerSection` for consistent collapse semantics with
other bottom drawer panels.

## File changes panel

`ChatFileChangesPanel` aggregates `turn_diff_summary` events across the
session using `aggregateFiles(summaries)`:

- Advances `afterSha` and stats as later turns amend the same file.
- Renders a compact list with status badges (`A`, `D`, `M`, `R`, `C`)
  and basename.
- Clicking a file lazily fetches the diff via
  `ade.agentChat.getTurnFileDiff` and shows it in `AdeDiffViewer`
  (compact toolbar hidden).

## Rewind files confirmation

Claude user messages expose an undo affordance when the SDK provides a
file checkpoint. The pane first calls
`ade.agentChat.rewindFiles({ dryRun: true })`; if the checkpoint can be
restored, `rewindFilesPreview.ts` filters turn diff summaries after the
selected user message and pairs each reported file with the earliest
`beforeSha` and latest `afterSha` it can prove. The confirmation dialog
then shows:

- The user message being rewound to and its sent time.
- Aggregate insertion/deletion counts from the SDK dry run.
- One expandable row per file, including status and per-file stats when
  a turn diff summary is available.
- Lazy `AdeDiffViewer` previews via `ade.agentChat.getTurnFileDiff`.

Confirming calls `rewindFiles` without `dryRun`. Conversation history is
left untouched; only files are restored.

## Subagents panel

When the Claude Agent SDK spawns background subagents, the service
emits `subagent_started`, `subagent_progress`, and `subagent_result`
events. `ChatSubagentsPanel` renders running/completed/failed/stopped
subagents with usage metrics. `ChatSubagentStrip` is the compact header
strip showing running subagent count.

Interrupt transitions all running subagents to `stopped` by emitting a
`subagent_result` with `status: "stopped"` for each, matching the
Claude Code CLI behavior.

Claude Workflow runs (the SDK's multi-agent orchestration tool) render in
the same panel with zero new chrome: `claudeWorkflowProgress.ts` normalizes
the undocumented `workflow_progress` snapshot and fans each workflow agent
out as its own subagent row (phase in the summary line, tokens/duration
from the snapshot, `workflowName` chip), while the parent workflow task row
falls back to a phase/count rollup summary. Child chat sessions spawned
with a parent lineage (`ade chat create` from a tracked agent shell,
`--parent`) also list here via synthetic `subagent_*` events keyed
`chat:<childSessionId>`; the parent transcript additionally shows a quiet
"Subagent spawned" chip (a `status:"subagent_spawned"` system_notice) that
deep-links to the child chat.

Codex parallel agent failures emit a system-notice plus `failed` /
`stopped` `subagent_result` rows. The agentChatService maps
`failed | errored | rejected | refused | denied` Codex status values
to `failed` and `stopped | interrupted | shutdown | notfound |
cancelled | canceled` to `stopped`; `readCodexCollabFailureSummary`
pulls the human-readable rejection out of `item.error` /
`item.result` / `item.contentItems[*].text` so the chat surface shows
a useful reason instead of a bare "Agent spawn failed".

`deriveChatSubagentSnapshots` (in `chatExecutionSummary.ts`) keeps
sibling Codex subagents distinct when they share a `parentToolUseId`:
it pre-scans every envelope to count the resolved subagent ids per
parent, only adopts the placeholder parent row when exactly one
sibling resolves under that parent, and otherwise creates separate
snapshots keyed by `agentId ?? taskId`. The TUI now imports the same
pure helpers from `apps/desktop/src/shared/chatSubagents.ts`
(`buildSubagentPaneRows`, `selectedSubagentSnapshot`,
`subagentIndexForPaneLine`, `subagentPaneSelectableLineOffsets`,
`buildSubagentTranscriptEvents`, `isLifecycleEventForSnapshot`,
`latestPlan`) — `apps/ade-cli/src/tuiClient/subagentPane.ts` and
`chatInfo.ts` re-export them so desktop and TUI never drift.

Subagent envelopes carry both an `agentId` (raw runtime id) and an
`agentType` label that's used as the row title when present. The label
sources differ per runtime:

- **Claude / ade-code.** `agentType` comes from the Task tool's
  `input.subagent_type` (e.g. `code-reviewer`, `Explore`). The service
  stashes that input at the assistant `tool_use` boundary
  (`runtime.taskToolInputByToolUseId`, keyed by `tool_use_id`) and
  joins it onto the later `system:task_started` / `task_progress` /
  `task_completed` envelopes via `parentToolUseId`. Stale entries are
  cleared at turn boundaries and on subagent completion.
- **Codex parallel agents.** The Codex wire format has no
  human-friendly name for collab agents, so the service assigns
  `Agent #N` labels via `assignCodexAgentLabel`: 1-based, per-turn,
  remembered in `runtime.codexAgentIndexByTurn` (a
  `Map<turnId, Map<threadId, index>>`), and cleared when the turn
  ends. The raw threadId is kept on the snapshot as `agentId`.
- **OpenCode subagents.** OpenCode encodes the agent's identity in
  `session.title`, which already flows through as `description`; the
  service intentionally does NOT set `agentType` so the renderer falls
  back to that description for the row label.

## Terminal drawer

`ChatTerminalDrawer` is a collapsible drawer at the bottom of the chat
surface. Each drawer tab creates an untracked shell PTY in the current
lane, reusing the shared `TerminalView` component (with global
terminal preferences) rather than managing raw xterm instances
directly. Tabs track PTY exit state and auto-close the drawer when the
last tab is removed. When a new chat-owned terminal is created from a
non-drawer source (e.g. an in-chat agent calling
`ade --socket app-control launch`, the localhost-strip "Logs" button,
or another chat surface) the pane subscribes to
`window.ade.sessions.onChanged` and dedupes the new terminal into the
drawer instead of opening a duplicate tab — `ChatTerminalDrawer.openTab`
checks the existing tab list by `sessionId` / `ptyId` before pushing a
new entry, and the `AgentChatPane` `revealCreatedTerminal` effect calls
the same drawer with the recovered `{ terminalId, ptyId, label }`.

`ChatTerminalToggle` is the header button that shows the active tab
count. The drawer is mounted only when lane tool drawers are visible on
the chat surface. Work-grid tiles pass `hideLaneToolDrawers` because the
Work sidebar owns lane-scoped tools there; in that mode the header
toggle is absent and the pane does not call `ade.terminal.list` just to
hydrate a hidden drawer.

## Pending input card

`InlineQuestionRequestCard` (in `AgentChatMessageList.tsx`) renders the
first question / structured-question pending input inline in the chat
transcript. (There is no longer a separate `AgentQuestionModal`.)

Anatomy:

- **Header** — the provider logo (`ProviderLogo(source)`) plus a
  kind-derived verb from `pendingInputHeaderLabel(source, kind)`:
  `{Provider} asks` for questions, `{Provider} · Plan ready` for plan
  approvals. No clock icon and no generic "Question from {provider}"
  title — those were the repetition that made the old card noisy. A
  `N of M answered` counter sits on the right for paged sets.
- **Body** — the question's short `header` renders as a kicker, then the
  question text exactly **once**, then the options. A request-level
  `description` only renders when it differs from the question text
  (`extraContext`), so it never duplicates the question.
- **Options** — carry `role="radio"`/`"checkbox"` (in a `radiogroup`/
  `group` container) for accessibility, support multi-select, and show a
  `(Recommended)` badge. The recommended option auto-focuses so its
  preview shows first.
- **Previews** — `QuestionOptionPreview` is format-aware: wireframe/ASCII
  content (detected by `looksLikeWireframe`, or `previewFormat: "html"`)
  renders in a column-preserving monospace `<pre>` (`white-space: pre`,
  horizontal scroll), and prose markdown routes through the shared
  code-fence-aware `ChatMarkdown`. This replaced a bare `ReactMarkdown`
  that collapsed ASCII alignment. When ≥2 options carry previews, a
  `⇄ Compare` toggle shows two previews side by side.
- **Keyboard-first** — digits toggle the active question's options, ↑↓
  move the highlight (and its preview), ←→ page between questions, and
  Enter advances or sends. The card focuses itself once on first
  appearance (guarded so the virtualized list doesn't re-steal focus).
- **Accent** — all chrome uses `var(--chat-accent)`, which the chat
  surface sets per provider, so the card is amber for Claude, warm-white
  for Codex, violet for Cursor/Droid, blue for OpenCode (and honours the
  neutral-chrome preference). The same treatment is applied to
  `ChatProposedPlanCard`.

Responses are sent back via `ade.agentChat.respondToInput` (accepts
`AgentChatRespondToInputArgs` with structured `answers`; values may be
`string` or `string[]` for multi-select, plus an optional `decision`).
Legacy `ade.agentChat.approve` is still supported. Plan approval cards
receive the plan text from the `ExitPlanMode` tool input so the UI shows
meaningful content rather than a generic label.

### Cross-surface parity

The card's data contract (`PendingInputRequest` / `PendingInputQuestion`
/ `PendingInputOption` in `shared/types/chat.ts`) is the single source of
truth: the TUI (`apps/ade-cli/src/tuiClient/components/ApprovalPrompt.tsx`)
and iOS (`WorkStructuredQuestionCard` / `WorkPlanComposerStrip`) render the
same header verb, dedup, monospace preview, and per-provider accent.

On iOS the pending inputs collapse into a **single consolidated strip**
pinned above the composer (`consolidatedPendingStripSection` in
`WorkChatSessionView+Timeline.swift`), replacing the previous split of
plan/approval composer strips plus inline question/permission/model-selection
transcript cards. It renders the current (primary) request, shows a
"Request 1 of N" header once more than one gate is queued, and advances to
the next request as each is answered. Answers use an **optimistic-removal**
path (`dispatchPendingInputAnswer` / `optimisticallyAnsweredInputIds`): the
answered item is hidden the instant its decision is dispatched so the strip
advances without waiting on the host round-trip, then reconciled out of the
set once it leaves the host-derived queue (`canonicalPendingInputSignature`
change) or rolled back if the command errored. An **"Accept all"** affordance
appears when the current gate is an approval/permission kind (never question,
plan-approval, or model-selection): it flips `acceptForSession` on the current
gate, then accepts each remaining sweepable gate sequentially (stale itemIds
no-op on the host, so re-sends after auto-resolution are safe). The
verb/name helpers live in `shared/pendingInputLabels.ts` so desktop and
TUI share them; iOS mirrors them in Swift. A blocking pending input also
surfaces an "Awaiting you" badge on the Lanes row and the Work grid tile
(derived from exact pending-input counts, not idle CLI attention heuristics),
and iOS fires a light haptic when a new blocking gate arrives.

### Per-runtime question richness (ceilings)

Each runtime populates as much of the schema as its SDK exposes; the card
renders whatever is present:

- **Claude** — full: `header`, options `description`/`preview`/
  `previewFormat`/`recommended`, `multiSelect` (from the `AskUserQuestion`
  tool).
- **Codex** — full via the app-server `item/tool/requestUserInput`
  payload (header, multiSelect, isSecret, per-option description/preview).
- **Cursor** — full via `normalizeCursorControlQuestions` (incl.
  `defaultAssumption`, `impact`, `isSecret`).
- **OpenCode** — `header`, `multiSelect` (from `multiple`),
  `allowsFreeform` (from `custom`), per-option `description`. **Ceiling:**
  no `recommended`/`preview`/`isSecret`.
- **Droid** — `topic` → `header` and bare-string `options` only.
  **Ceiling:** the `@factory/droid-sdk` ask-user schema
  (`AskUserQuestionSchema`) exposes no per-option description, no
  `multiSelect`, and no preview, so those fields stay empty for Droid.

## Presentation profiles

`ChatSurfacePresentation` (in `shared/types/chat.ts`) drives the
surface's visual treatment:

| Field | Effect |
|---|---|
| `mode` | `standard | resolver | worker-thread | activity-feed`. |
| `profile` | `standard | persistent_identity` -- persistent identity adjusts accent color, chips, title, and some layouts. |
| `modelSwitchPolicy` | Overrides the default switch policy for the session. |
| `title`, `subtitle`, `assistantLabel`, `messagePlaceholder` | Text overrides. |
| `accentColor` | Accent color used in header, chips, and active-turn indicators. |
| `chips` | List of `{ label, tone }` chips shown in the header. |
| `showMcpStatus` | Whether to render the ADE CLI status indicator. |

CTO and resolver surfaces set `profile: "persistent_identity"` and
override the chips.

## State derivation helpers

These modules are pure and unit-testable:

- `chatTranscriptRows.ts` -- event-to-row pipeline (hidden/visible,
  work-log grouping, tool-use summary absorption).
- `pendingInput.ts` -- event-to-pending-input derivation (including
  `pending_input_resolved`, `done`-status-based clearing).
- `chatExecutionSummary.ts` -- todos, subagent snapshots, turn diff
  summaries.
- `chatNavigation.ts` -- keyboard navigation between transcript rows.
- `chatToolAppearance.tsx` -- tool-specific visuals (icons, tone, label
  formatting).
- `pendingInput.ts` exports `getPendingInputQuestionCount()` and
  `hasPendingInputOptions()` for introspection inside the composer.

## Fragile and tricky wiring

- **Draft launch job lifecycle.** `DraftLaunchJob` tracks multi-step
  async launches and is stored in the **root** store's
  `draftLaunchJobsByScope` (read/written via `useRootAppStore` /
  `rootAppStoreApi.getState().setDraftLaunchJobs`) rather than the
  per-project store or local pane state. This is load-bearing: a launch
  routinely outlives the pane that started it, and switching to another
  remote project tears down the originating project's scoped store
  entirely — keeping the job in the root store is what lets it re-surface
  (and ready jobs auto-open / failures show Restore) when the user
  returns. The composer is cleared immediately when the job starts, not
  when it finishes. Auto-created lanes start at `creating-lane` (named
  deterministically up front), then move through session start and prompt
  send; any AI rename happens in the background after the lane exists and
  is surfaced via the "Auto-naming…" card status, not a launch-job phase.
  If the launch fails, the Restore action
  merges the snapshot back via `restoreDraftLaunchSnapshot`, which appends
  rather than replaces existing draft text and merges context items by id.
  `isDraftLaunchJobStale` makes an active row hideable after the stale
  threshold so a hung IPC call cannot leave a permanent status strip.
  `latestForegroundDraftLaunchJobIdRef` prevents stale foreground jobs
  from auto-opening when a newer foreground launch superseded them. The
  `DraftLaunchSnapshot` captures the full composer control state
  (model, reasoning, execution mode, native controls) so
  `createSessionForLane` receives a `launchState` that overrides the
  live composer state during the async gap.
- **Draft launch project-switch safety.** Because the launch chain is
  detached from the pane lifecycle, it must never act on the wrong
  project. It captures the originating project's `OpenProjectBinding`
  (`launchBinding`) at the start and passes it as the optional `pin` arg
  to project config reads, branch discovery, lane create/rename,
  background lane-name suggestions, session create/send/delete,
  orchestration bundle allocation, and CLI PTY create/dispose. The
  preload routes a `pin` through `callPinnedRuntimeAction` — see
  [Remote runtime internal architecture](../remote-runtime/internal-architecture.md#local-runtime-routing)
  — so a mid-launch project switch keeps the detached work targeting the
  project that started it instead of the now-active project. Rollback of
  a partially-created launch is pinned to the same binding:
  `window.ade.lanes.delete(..., launchBinding)` and
  `window.ade.agentChat.delete(..., pin)` delete the lane/session they
  created even after the active project changed. The legacy fallback
  where no binding is available still aborts on project-root drift with
  `LAUNCH_PROJECT_CHANGED_MESSAGE`. Each step is also wrapped in
  `withDraftLaunchTimeout` so a runtime call that neither resolves nor
  rejects (`DRAFT_LAUNCH_TIMEOUT_MS = 90 s`) fails the job instead of
  wedging it in a non-terminal state and blocking re-submission.
- **Composer draft persistence.** `ComposerDraftStorageSnapshot` is
  persisted to `localStorage` on every draft/model/attachment change
  and restored on scope switch. `composerDraftHydratingRef` suppresses
  the first write-back after hydration so the restore does not
  immediately re-persist with a new timestamp. Normalization
  (`normalizeStoredComposerDraft`) validates every field defensively
  so corrupt stored data degrades gracefully instead of crashing.
- **Session creation and first turn race.** When a new session is
  created from the composer, the pane awaits the `onSessionCreated`
  callback and the session-list refresh before sending the first agent
  turn. Skipping this wait renders a blank "new chat" screen because
  the parent surface has not yet navigated to the chat tab.
- **Model warmup on selection.** Selecting a Claude model triggers
  `ade.agentChat.warmupModel` to preload a V2 session. If the warmup
  promise is never awaited, the first turn incurs a 20 s latency.
- **Stale slash commands.** SDK-provided slash commands are fetched once
  per session initialisation. If the user switches model mid-session,
  the pane re-fetches. Missing the refetch surfaces slash commands
  from the previous provider.
- **File-search debounce.** The `@` picker debounces input (40 ms in
  `ChatCommandMenu`) and stamps each request with a sequence number to
  discard stale results; cached queries re-render immediately and
  revalidate in the background. Stale-result handling is easy to
  regress when adjusting the debounce.
- **Trigger detection is cursor-relative.** Both composer inputs and
  the TUI share `shared/composerTriggers.ts`. Slash tokens require a
  word boundary before `/` and allow no whitespace or `/` inside, so
  paths (`/usr/bin`), URLs, and fractions never open the menu. Don't
  reintroduce `startsWith("/")` gates — that regresses mid-sentence
  commands. In the rich editor, detection runs on the DOM text run
  around the caret (`getRichTriggerContext`), NOT on serialized-draft
  offsets: serialization collapses whitespace and flattens chips, so
  serialized indices cannot be mapped back onto DOM positions.
- **Question drafts persistence.** Question answer state (selected
  options + freeform drafts) is local to `InlineQuestionRequestCard`. If
  the user navigates away and back, drafts reset. This is intentional to
  avoid stale answers leaking across sessions. The card's one-time focus
  and entrance animation are guarded by module-level sets
  (`focusedQuestionCardKeys` / `enteredQuestionCardKeys`) so the
  virtualized list re-mounting the row mid-scroll doesn't re-steal focus
  or replay the fade.
- **Terminal drawer tab lifecycle.** PTY exit must trigger tab removal,
  and the last-tab-removed condition must collapse the drawer; the
  `ChatTerminalDrawer` state machine is the canonical source.
- **Virtual-scroll offset drift.** `@tanstack/react-virtual` is
  sensitive to changing row heights (plan approval cards, work-log
  expansion). Measurement caching uses stable keys; rolling back to an
  unstable key causes the list to "jump" on updates. Sticky-bottom
  recovery intentionally follows for a few animation frames after row
  measurement changes; removing that follow-up can make active streams
  appear to stop short of the newest output.
- **Native permission picker updates serialize before submit.**
  `AgentChatPane` tracks the in-flight native-control update through
  `pendingNativeControlUpdateRef` (sessionId + monotonic `updateId` +
  promise). Every `updateSession` dispatched from the permission
  popovers chains onto the previous promise so the backend always sees
  the final picker state, and `submit()` awaits that chain for the
  active session before dispatching the turn. The handler also
  optimistically patches the renderer session summary with the fields
  returned from `updateSession` (`permissionMode`,
  `interactionMode`, `claudePermissionMode`, `codexApprovalPolicy`,
  `codexSandbox`, `codexConfigSource`, `opencodePermissionMode`,
  `cursorModeId`, `cursorModeSnapshot`) so the chip state reflects the
  server's normalized values before the list refresh lands.
- **Inbound mode changes re-seed composer state.** When another client
  changes a session's mode, the service emits a `session_meta_updated`
  event carrying the mode fields (see
  [transcript-and-turns](transcript-and-turns.md)). `AgentChatPane`'s
  event handler patches the session summary with any mode fields present
  and — because the composer seeds its local mode state from the session
  scope, not from summary content — also applies the authoritative fields
  directly to composer state (`setInteractionMode`,
  `setClaudePermissionMode`, `setCodexApprovalPolicy`/`setCodexSandbox`/
  `setCodexConfigSource`, `setOpenCodePermissionMode`,
  `setDroidPermissionMode`, and the Cursor mode/config setters derived
  from `cursorModeSnapshot`) when the event targets the selected session,
  mirroring the plan-mode transition special-case. A title-only emit
  changes no mode key and is a no-op for composer state.

## Related docs

- [Chat README](README.md) -- service overview and IPC surface.
- [Transcript and Turns](transcript-and-turns.md) -- the data the UI
  renders.
- [Tool System](tool-system.md) -- tool tiers surfaced in the composer.
