# Composer and Chat UI

The chat UI lives under `apps/desktop/src/renderer/components/chat/`.
It is composed of a pane (`AgentChatPane`), a message list
(`AgentChatMessageList`), a composer (`AgentChatComposer`), and a
constellation of side panels (tasks, scheduled work, file changes,
subagents, computer use). The pane derives all visible state from the
`AgentChatEventEnvelope` stream plus session metadata.

## Source file map

| Path | Role |
|---|---|
| `AgentChatPane.tsx` | Top-level pane; IPC wiring, session state, presentation profile resolution, lane navigation, parallel launch orchestration, mounting of sub-panels and composer. It persists a per-session `ade.chat.lastViewed.v1:<sessionId>` timestamp in renderer `localStorage`; scheduled turns that fired since that timestamp produce a dismissible while-you-were-away strip above the composer, with the latest outcome preview and jump requests for up to three wake dividers. Visible Work grid tiles flush user/lifecycle/live events immediately and poll-recover active transcripts so inactive-but-visible tiles stay current. Draft chats preserve user-touched model/reasoning/permission controls across late lane-session hydration, and composer text is keyed by session id or lane draft key so switching draft lanes does not reuse another draft's text. Accepts an optional `draftContextTargetId` prop so the Work sidebar can target an unsaved draft composer for context insertions (attachments, iOS/App Control/browser selections, draft text) even before a chat session exists; window event handlers match on either `sessionId` or `draftTargetId`. When auto-creating a lane the draft resolves the primary lane for the `onLaneChange` callback so the sidebar lane context stays in sync. Composer draft state (text, model, reasoning, attachments, context items) is persisted to `localStorage` under the `ade.chat.composerDraft.v1` key family and restored on scope change through `ComposerDraftStorageSnapshot`. Pending-steer Edit uses `cancelSteer({ requireQueued: true })`, then merges the queued text, file attachments, and context attachments into the captured composer draft; if the message already left the queue, the cancel fails and the draft is left unchanged. Draft launches are tracked through **root**-store-backed `DraftLaunchJob` state machines with multi-step progress (`creating-lane` -> `starting-session` -> `sending-prompt` -> `ready` / `failed`; auto-create names the lane deterministically up front and renames to the AI name in the background, so there is no blocking `naming-lane` phase); jobs live in the root store (not the per-project store) so an in-flight launch survives a remote project switch that tears down the originating project surface. The detached launch chain captures the originating `OpenProjectBinding`, passes it as a `pin` to branch/lane/chat/orchestration/PTY calls so a mid-launch project switch keeps targeting the originating runtime, pins rollback to that binding, and caps each step at 90 s (`withDraftLaunchTimeout`). The composer is cleared optimistically at job start, stale active rows gain a hide-status escape hatch, failed jobs expose Restore in the job strip and matching error banner, and the `DraftLaunchSnapshot` captures the full control state so the async launch uses frozen settings. It also owns the transcript-resilience rules described in [Transcript and turns](transcript-and-turns.md#history-snapshots-scroll-back-and-misses): `resolveChatHistoryMissAction` (a history miss never blanks a rendered transcript), `resolveSnapshotHistoryCursor` (`hasOlderHistory` is authoritative over `tailStartOffset`), the bounded silent retry ladder `OLDER_HISTORY_RETRY_DELAYS_MS = [800, 2400]`, the `syncPendingBySession` flag that surfaces as `data-chat-sync-pending` + a 2 px catch-up hairline under the header (a fading static rule, never a continuous animation; the fade is `motion-safe:`), and a minimal static cold-chat skeleton (`data-chat-cold-skeleton`) so a chat with no cached view reads as loading rather than empty. `resolveRenderedChatSessionId` picks the session to paint from the incoming props rather than the effect-synced `selectedSessionId`, which otherwise paints the outgoing chat's transcript for one frame after the pane is pointed elsewhere. The module-level view cache holds 8 entries / 128 MB total (32 MB per session, matching the resident ceiling) and stores a reference to the array the pane already holds; a **detached** view — an older transcript prefix whose live tail was dropped to stay under the resident cap after paging back — is skipped rather than evicted, so a later restore can never render an old slice as if it were current. The active-turn recovery loop is a **stall detector**, not the transport: it re-reads the transcript on a jittered `ACTIVE_TURN_RECOVERY_INTERVAL_MS` (10 s) tick and skips entirely when the live subscription delivered anything inside that window. Subscription ownership is handed to `chatSessionRetention.ts` when the pane hides. Left/right floating-pane reserve is applied only while a selected session surface renders those panes; an empty draft never reserves a hidden PR or Chat Actions pane, so its hero composer remains centered. |
| `useDraftMachineRouting.ts`, `draftAttachmentTransfer.ts` | Draft machine selection and machine-safe attachment movement. Routing reconciles the machine restored by the current project/tab before the composer becomes sendable, resolves its `OpenProjectBinding`, and keeps lane selection scoped to that machine. On a user-requested machine change within one composer scope, `useDraftAttachmentTransfer` preserves portable image URLs and copies local/pasted image bytes from the attachment-owning runtime to the target runtime via pinned `getImageDataUrl` and `saveTempAttachment` calls. It removes non-image files and linked iOS/App Control/built-in-browser context because those machine-owned references are not portable. Pending transfer disables send. If copying fails, the source image references remain visible and sending stays blocked until the user returns to the source machine or removes the images. A project/tab scope change resets ownership only after machine selection has reconciled, so restoring a remote draft cannot be mistaken for an explicit local-to-remote switch. |
| `apps/desktop/src/renderer/components/usage/ActivityModule.tsx`, `ActivityHeatmap.tsx`, `activityIntensity.ts` | Tabbed cross-client activity/tokens/code/clients module. `AgentChatPane` mounts the self-fetching `WorkActivityModule` (compact variant) beneath the empty Work draft composer when no app panel is open; the component persists the chosen tab and day/week/month/year range under `ade.activity.module.v1`. `ActivityHeatmap` owns the responsive seven-row grid and viewport fitting, while `activityIntensity` provides the shared daily activity score, non-zero quartile buckets, and leading-inactive-day trimming used by the grid and summary counts. |
| `apps/desktop/src/renderer/lib/draftLaunchJobs.ts` | Pure helper for Work draft-launch job DTOs, terminal/stale-state detection, and pruning. The list keeps active rows ahead of terminal rows, fills remaining retained slots with terminal rows, and keeps at least one terminal row alongside active jobs. Also owns the durability constants/helpers: `DRAFT_LAUNCH_TIMEOUT_MS` (90 s) + `withDraftLaunchTimeout` (fails a step whose runtime call never settles; the underlying IPC is not cancellable, so it keeps running detached and the timeout only unwedges the renderer-side job) and `LAUNCH_PROJECT_CHANGED_MESSAGE` (the legacy/unpinned abort error used only when no originating project binding is available and the active project drifts mid-launch). |
| `apps/desktop/src/renderer/lib/handoffLaunchJobs.ts` | Pure helper for handoff placeholder DTOs, scope keys, stable placeholder ids, status labels, and search matching. `AgentChatPane` writes these jobs into the root store while `TerminalsPage` passes matching jobs into the Work session sidebar. The local handoff surface offers a brief summarized handoff or a full-history fork whenever the source provider is fork-capable (`providerSupportsHandoffFork`: Claude, Codex, OpenCode, Droid); Cursor is brief-only. Fork keeps the new chat on the same provider and lane while allowing the target model to change; Claude forks the SDK session pointer, Codex the app-server thread (`thread/fork`), OpenCode `session.fork`, and Droid `forkSession()`. |
| `apps/desktop/src/renderer/lib/aiDiscoveryCache.ts` | Runtime-binding-scoped AI integration-status and provider-model cache shared across renderer surfaces. Local and remote checkouts with the same project identity cannot share model/auth state. `getAiStatusCached` uses a 10-second freshness window and deduplicates concurrent `ade.ai.getStatus` requests; cache update/invalidation events let open ModelPickers react without polling or mounting their own background refresh loops. |
| `CrossMachineHandoffModal.tsx`, `crossMachineHandoffPresentation.tsx` | Modal state and user flow for **Send to machine**. It verifies a local source lane, follows live remote connection snapshots, lets the user pick brief or full-history fork (fork defaults on for fork-capable providers and constrains the model picker to the same provider), lets the user set the destination chat's model, reasoning effort, fast mode, and permission mode with the same shared pills the composer uses, handles existing-project versus confirmed-clone setup, offers a destination-run fast-forward when the target lane is clean and strictly behind the source commit, decodes destination responses at the renderer boundary, pins acceptance to the reviewed route kind, and exposes retryable source-marker failures after destination success. Source blockers render through `BlockedReasons` / `BlockedActionButton` instead of silently disabling Continue. The pure half — stage/mode types, `SourceCheck`, branch/route/repo-readiness copy, permission tone and icon maps, send-step labels, `CheckRow` — lives in `crossMachineHandoffPresentation.tsx` so it is assertable without mounting the stateful modal. Once destination acceptance is dispatched, a runtime timeout or connection interruption produces an amber unknown-outcome notice: the destination chat may still appear, the user should check that machine before retrying, and the modal never reports a truthful cancellation that the runtime did not perform. A fork that the destination can't accept (older ADE with no `forkHandoffSupport`, oversize history, or an unforkable provider file) surfaces a plain reason and a one-click **send as brief** that re-runs prepare + preflight; the insecure-route consent line is fork-aware (a fork discloses that the full history is sent exactly as recorded, a brief that only the summary is sent). |
| `AgentChatMessageList.tsx` | Virtualized message list. The virtualizer is **hand-rolled**, not `@tanstack/react-virtual`: a `measuredHeights` row-key → height `Map` feeds top/bottom spacer divs around the rendered window, and each rendered row is wrapped in `MeasuredEventRow`, whose `ResizeObserver` reports its real height through `handleMeasure` → `reconcileMeasuredScrollTop` so a height correction above the viewport does not shift what the reader is looking at. Renders transcript rows and turn dividers, including a `Woke on schedule` divider before every synthetic scheduled turn and inline `SubagentSpawnCard` / `SubagentResultCard` / `BackgroundFinishChip` rows (from `SubagentActivityCards.tsx`) for real subagents and backgrounded shell commands, and accepts stable row-key jump requests from the while-you-were-away strip and the spawn/result jump affordances. Keeps sticky-bottom sessions pinned across streamed row growth and late virtual-height measurements. A Claude `queue_recovery: available` row renders one eight-second Undo card; later `restored`/`expired` rows settle the same recovery id so history replay cannot show a stale action. The last text block of a multi-block assistant turn exposes Copy turn, which joins only that turn's assistant text blocks with blank lines; legacy rows without a turn id and single-block turns keep only the normal block copy. Plan-approval rows with non-empty body text render a scrollable markdown block (capped at `360px`) beneath the header so the user can review plan content inline. Codex goal lifecycle rows use user-facing text such as `Goal set`, `Goal paused`, and `Goal cleared`. A stalled Codex turn renders a clickable Wait / Nudge / Retry / Resume recovery card wired to `agentChat.recoverCodexTurn`; terminal provider capacity/usage-limit errors render `ProviderFailureRecoveryCard` with same-thread retry and model-selection actions. User messages marked `metadata.hideFullPrompt` render and copy only their `displayText`, keeping internal handoff briefs out of the visible transcript details, and a handoff-brief user row shows a small brief chip. When a fork seeds pre-fork history into the new chat, the envelopes carry the `handoff_fork` provider origin and the list draws a single `Forked from the previous chat — full history above` divider (`computeForkHistoryDividerRowKey` pins it to the first live row after the seeded history) instead of one marker per seeded row. |
| `AgentChatComposer.tsx`, `ComposerPromptStash.tsx`, `ComposerSmartLinkMenu.tsx`, `smartLinkChipMark.ts` | Text input, attachments, model selector, compact title-only permission controls (per-provider `PermissionModePickerOption` tables fed into the shared `components/shared/PermissionModePicker`, which the composer owns the option data for but not the control), slash commands, desktop prompt stashes, smart-link chips (`smartLinkChipMark.ts` returns the inline `currentColor` SVG brand mark each chip renders), pending-input answering (including Codex MCP form/URL elicitations), voice-dictation target registration, and parallel model-slot controls. A running chat's toolbar also shows a read-only amber tower plus the owning machine name beside the model and thinking controls; it identifies where the chat executes and directs moves to Chat actions → Handoff → Continue on another machine. A draft omits that label because its launch shelf owns the machine choice. `ComposerPromptStash` keeps its command surface mounted when the Appearance preference hides the bookmark, so Cmd/Ctrl+S remains available, but the visible bookmark stays out of the toolbar while both the composer and stash list are empty. Its menu is rendered in a viewport-clamped body portal with a bounded, scrolling list so composer overflow and short windows cannot crop it. A save first copies up to ten attached images into the owning project runtime, commits the text plus image references, then clears only the unchanged composer snapshot; restore reapplies both text and images before consuming the stash. The list renders an image thumbnail when the active runtime owns the bytes. On another synced runtime, the row retains its text and image count, labels the images as living on another machine, and refuses restore until the composer is connected to the origin runtime. Machine-bound context and non-image files are not stashed. Completed URLs are non-editable inline chips whose `data-composer-chip-text` preserves the literal URL during serialization; clicking or keyboard-activating a chip opens the Copy link / Remove link menu, and character deletion removes the whole URL token. Every chip also carries a kind-naming `data-composer-chip` attribute, and a scoped `selectionchange` effect marks intersecting chips with `data-composer-chip-selected` so the native selection paints continuously across them (overlay styling lives in `apps/desktop/src/renderer/index.css`). During an active Claude turn, its split Send control selects without dispatching among inline, after-turn, and interrupt delivery; the primary button and Enter execute the selected mode. A separate Claude split Stop control selects **Stop & clear queue** or **Stop only**, persists that choice per chat, and dismisses its custom popover immediately after selection. Staged rows expose send-during-turn, interrupt, cancel, and Edit-back-to-composer actions. It forwards one-shot open requests to the shared ModelPicker so transcript recovery cards can open model selection without synthetic DOM events; the picker acknowledges each request so remounts do not reopen it. Launch-prompt clipboard reminder text is controlled by `launchPromptClipboardNoticeEnabled`, separate from the `launchPromptClipboardEnabled` copy behavior. For orchestration model-selection pending inputs it decodes the agent briefing metadata (`workDescription`, `filesHint`, `dependsOn`) before rendering the selection card. |
| `apps/desktop/src/main/services/chat/promptStashService.ts` | Runtime-backed prompt-stash persistence. Exact prompt text, up to ten image references, their origin sync-site id, provider/model labels, and creation time are stored in the PK-only, CRR-compatible `prompt_stashes` table; newest-first retention is capped at 20 entries. Text and metadata converge across runtimes. HTTP(S) image references remain portable, while local-image bytes stay on the originating runtime: off-origin readers receive the image count but no absolute paths and cannot consume the stash. Origin-owned image files referenced by live stashes are protected from the normal seven-day temporary-attachment cleanup. |
| `ProviderFailureRecoveryCard.tsx` | Friendly recovery surface for terminal provider capacity and usage-limit failures. Shows human-readable error identity and guidance, then offers **Retry turn** and **Choose model** only after the failed turn has released the composer. |
| `chatTurnState.ts` | Pure turn-state helpers shared by live and hydration paths. Terminal transcript evidence beats a stale active session summary, and failed-turn retry resolves the associated non-steer user message even when the optimistic row has no provider turn id. |
| `ChatActionsDrawerPanel.tsx`, `ChatSourcesPanel.tsx`, `chatSources.ts` | Chat Actions tab shell plus Codex Sources view. The source derivation deduplicates files, web queries/results, MCP apps/tools, and external resource URLs from transcript events; safe web rows open in ADE's browser. |
| `VoiceDictationButton.tsx`, `apps/desktop/src/renderer/services/globalVoiceRecorder.ts`, `apps/desktop/src/renderer/components/voice/*` | Desktop dictation UI and recorder. The module-level recorder owns mic capture across navigation, writes live state to the root app store, transcribes via `window.ade.transcription`, inserts cleaned text into the registered composer, and always copies the cleaned transcript to the clipboard. The header indicator and composer pill render the same recording state. |
| `apps/desktop/src/main/services/transcription/*` | Electron main-process transcription service. Writes captured 16 kHz mono PCM to WAV, runs bundled whisper.cpp `base.en`, parses the JSON sidecar, and applies deterministic glossary cleanup. |
| `apps/desktop/resources/voice/voice-glossary.json`, `apps/desktop/resources/whisper/README.md` | Shared dictation glossary and release notes for materialized whisper resources. The large model and binary are generated by `materialize-whisper-resources.mjs` and ignored by git. |
| `apps/desktop/src/renderer/components/work/SessionLifecycleChips.tsx` | Ambient `settled` / `snoozed` chips for the chat surface header, mounted by `WorkSurfaceHeader` through its `lifecycleSessionId` prop (`AgentChatPane` passes the selected session id). `useSessionLifecycleSnapshot(sessionId)` reads the session row out of the per-project session cache the Work tab already mirrors into the app store, so there is no extra IPC; the phase/snooze derivations are the shared `sessionCanonicalUiState` + `isSessionSnoozed` / `snoozeWakeLabel` helpers the Work sidebar uses. Chip menus call `wakeSessionNow` / `setSessionSettleOverride` from `renderer/components/terminals/sessionLifecycleActions.ts`, falling back to `window.ade.sessions.unsettle` for a declared settle. |
| `ChatSurfaceShell.tsx` | Floating chat header, body, footer layout. Backdrop-blur glass-morphism styling. |
| `ChatComposerShell.tsx` | Input container chrome reused by the composer. |
| `ChatAttachmentTray.tsx` | Inline file/image attachment tray inside the composer. Image attachments render an inline thumbnail, open a full-size lightbox on click, and expose a copy-to-clipboard button that ships the image bytes via `window.ade.app.writeClipboardImage` so the user can paste them into another app. Pasted images can pass a seeded preview URL from the composer while the temp file is being saved; tray-only image refs fall back to `window.ade.app.getImageDataUrl`. Non-image attachments fall back to the file glyph. |
| `ChatCommandMenu.tsx` | Popover for slash commands and `@`-prefixed file search. Consumes a `ComposerTrigger` from `shared/composerTriggers.ts` (so the menu opens for a mid-draft trigger, not just a leading one), debounces file search at 40 ms, and keeps a per-menu-session query cache (`QUERY_CACHE_MAX = 40`) so cached queries render same-frame while a background revalidation still runs; the cache clears when the menu closes. |
| `apps/desktop/src/shared/composerTriggers.ts` | Cursor-relative typed-trigger detection shared by the desktop chat composer (rich + textarea), the `WorkViewArea` continue composer, and the ade-code TUI (iOS mirrors the same regexes in Swift). `detectComposerTrigger(text, cursorPos)` finds an in-progress `/command` / `@file` token ending at the cursor at any position; `replaceComposerTriggerSpan` splices exactly that span; `findConfirmedComposerTokens` locates confirmed chip tokens for overlay/prompt styling; `composerTriggerSpansWholeDraft` distinguishes a lone leading command from a mid-sentence one. |
| `apps/desktop/src/shared/smartLinks.ts` | Cross-client URL catalog and deterministic fallback labels. Recognizes GitHub PR/issue/repo/commit/action-run links, Linear issues, `ade://` deeplinks, and generic HTTP(S) pages; trims sentence punctuation, caps each draft at 12 matches, and keeps the canonical URL separate from optional title/favicon metadata. Desktop, hosted web, and ADE Code import this contract; iOS mirrors it in `WorkSmartLinkDetector`. |
| `apps/desktop/src/main/services/chat/smartLinkPreviewService.ts` | Runtime-owned best-effort metadata resolver. GitHub and Linear titles use configured provider services; generic pages use bounded public-network HTML/favicon reads with DNS pinning and SSRF checks. Generic previews cache at most 256 public entries for 30 minutes (five minutes for metadata misses); credential-backed provider results are never stored in that process-global cache. Any error returns the deterministic local preview rather than blocking composition. |
| `ChatTasksPanel.tsx` | Todo list rendered from `todo_update` events. |
| `apps/desktop/src/shared/chatScheduledWork.ts` | Pure scheduled-work derivation. Folds `scheduled_work_update` envelopes into Chat Info schedule rows for Claude wakeups, cron tasks, `/loop`, remote triggers, and background work; defines the shared Background/Schedule Earlier predicates (including fired one-shot wakeups); and formats next-fire labels. A parent turn's terminal event does not stop a background row, and background snapshots whose `sourceTaskId` belongs to a real subagent are omitted so native Agents do not appear twice. Shared by desktop, ADE Code, and mirrored by iOS. |
| `ChatFileChangesPanel.tsx` | Turn-level file change summary with lazy diff expansion. |
| `RewindFilesConfirmDialog.tsx`, `rewindFilesPreview.ts` | Undo confirmation for provider-backed file rewind. Builds a message-scoped file list from provider dry-run output plus turn diff summaries, then renders per-file expandable diffs before applying `rewindFiles`. Claude uses SDK file checkpoints; Codex forks the thread before the selected turn (`thread/fork` + `beforeTurnId`) on app-server >= 0.145.0, or falls back to `thread/rollback` (latest user message only) on older servers, and restores files through ADE's git plan. |
| `ChatSubagentsPanel.tsx` | Chat Info panel. It renders the Codex goal card, latest plan, tasks, schedule, and subagent/background rosters. Running subagent and background rows derive elapsed time from the wall clock and tick once per second; terminal rows keep their final compact duration. Large sections cap active rows and add Show all; terminal rows move into one Completed fold; Clear/Restore is a visual per-session filter. Failed and pinned rows remain active, survivors keep source order, and the pane variant owns a single scroller with sticky section headers. Spawned-chat rows are identified by `childSessionId`, show the live child title supplied by `AgentChatPane` / `WorkViewArea`, keep the runtime as a small kind chip, and navigate to the child rather than opening the provider-subagent drawer. The Schedule header keeps the per-chat pause/play action. For Codex sessions the goal card stays above plan/subagent progress so the current objective stays visible without crowding the chat header. |
| `ChatComputerUsePanel.tsx` | Complete chat proof drawer with image lightbox, inline video, availability/error states, and irreversible artifact deletion. Preview reads stay runtime-routed for remote projects, and the surface has no review or Finder/reveal controls. Inline transcript proof is owned by `AgentChatMessageList` + `ChatProofFilmstrip`: a collapsed count on the producing turn expands in chronology instead of pinning the newest items to the thread tail. |
| `ChatAppControlPanel.tsx` | App Control panel for Electron apps. Two mount points: under the chat composer (chat-scoped, `sessionId` set) and inside the Work right-edge sidebar (lane-scoped, `sessionId={null}`). Two modes: **Control** (live screencast frames + launch/connect form + click/type input + quick `terminal write` / `terminal signal` actions) and **Inspect** (hit-test crosshair on the screenshot; commits selections as `AppControlContextItem`s with screenshot, DOM packet, and source-file candidates). Persists panel state under `sessionStorage["ade.chat.appControlPanel.<key>"]`, where the key is `chat:<sessionId>` for the chat mount and `lane:<laneId>:<projectRoot>` for the sidebar mount. Connect/launch calls forward `laneId` so the resulting `AppControlSession` records its launching lane. See [App Control](../computer-use/app-control.md). |
| `ChatIosSimulatorPanel.tsx` | macOS-only iOS Simulator drawer. Two mount points: under the chat composer and inside the Work right-edge sidebar. Tool-readiness checklist, device + target pickers, three-backend live preview, `interact` vs `inspect` mode, hit-test overlay, and selection emission as `IosElementContextItem`. Accepts an optional `laneId` prop, forwarded into `iosSimulator.launch` so the resulting `IosSimulatorSession` records its launching lane. Simulator controls are not blocked when another chat session owns the simulator — ownership only affects which session receives context insertions, not whether the user can interact with the device. See [iOS Simulator feature](../ios-simulator/README.md). |
| `ChatBuiltInBrowserPanel.tsx` | In-app browser panel mounted under the Work right-edge sidebar's `browser` tab. Renders the address bar, navigation/tab strip, inspect toolbar, screenshot capture, and an empty/error state derived from `BuiltInBrowserStatus`; the actual page content is painted by a main-process `WebContentsView` whose bounds the panel reports back to the broker via `ade.builtInBrowser.setBounds`. Inspect-mode hit-tests emit `BuiltInBrowserContextItem` payloads through `onAddContext`; the sidebar then dispatches `ade:agent-chat:add-builtin-browser-context` to the active chat. The panel does not run inside `AgentChatPane` directly — instead, anywhere in the renderer that wants to open a URL calls `openUrlInAdeBrowser()` (in `apps/desktop/src/renderer/lib/openExternal.ts`), which fires `ADE_OPEN_BUILT_IN_BROWSER_EVENT` and asks the broker to open a new tab. |
| `ChatTerminalDrawer.tsx` | Collapsible terminal drawer at the bottom of the chat. |
| `ChatGitToolbar.tsx` | Git status and quick-action toolbar above the composer. The PR action opens or toggles a linked PR when one exists, otherwise opens the PR creation handoff for the current lane targeting the primary branch. Opening the chat PR pane or compact PR menu performs a targeted, cooldown-bound refresh for that single linked PR. The toolbar is a **status strip only** — the manual PR-sync (↻) button moved into the PR pane's title bar, so surfaces that render this toolbar without a PR pane have no manual sync affordance and heal through reconcile-on-focus plus `prs-updated` instead. |
| `ChatPrPane.tsx` | Left floating PR pane for Work chat. Owns a title bar (`Pull request` + ↻ refresh + ✕ close): ↻ calls `prs.syncLanePr` and then re-reads the pane's PR, and spins for either a manual sync or a backend reconcile-on-focus (`pr-reconcile`, debounced 300 ms on the hide so a fast reconcile does not flicker). ✕ is wired to the parent's `onClose` (the header PR pill still toggles it). Shows cached lane PR details immediately, then refreshes the linked PR row with the same targeted refresh path so pane toggles surface current merged/closed/check state without a broad PR sync. An unmapped lane PR (projection-derived, `pr.unmapped`) skips the refresh and checks/reviews enrichment — there is no DB row behind its synthetic `gh:` id. With no PR it embeds `ChatPrInlineCreator` and forwards the chat's `sessionTitle`. |
| `ChatPrInlineCreator.tsx` | Inline create-PR form inside the PR pane. Laid out as a **flow** with no uppercase section captions: a flat, boxless source row (lane name + branch + lock glyph, immutable), a `↓` connector carrying `N ahead · N behind · clean`/`dirty` from `lane.status` (muted `comparing…` when the lane has no status yet), then the canonical `LaneCombobox` target dropdown (no free text), title, description, and Create. The title defaults to the chat session title whenever it is a real title (the placeholder `New chat` never wins), otherwise to the `<lane> -> <target>` derivation. Linear magic words and the deeplink footer are added server-side by `prService`. On success it hands the created `PrSummary` up through `onCreated` so the pane swaps to details without waiting for `prs-updated`. |
| `ChatUserMinimap.tsx`, `chatUserMinimap.logic.ts` | Tick rail down the transcript's **left** gutter, one hairline per user message, gated on the `chatUserMinimapEnabled` appearance setting and mouse pointers only (`[@media(pointer:fine)]`). Ticks are positioned by percentage of rail height, so they compress instead of overflowing and there is no marker cap or subsampling — the entry index stays 1:1 with the tick index, which is what pointer→index mapping depends on. The whole rail is a single `<button>` (one tab stop for the timeline) that derives the hovered tick from pointer Y (`resolveMinimapIndexFromPointer`) and fans tick widths out by distance from it (magnetic lens). The hit strip is width-clamped to the measured side gutter (`resolveMinimapHitStripWidth`, capped at 40 px) so it can never overlay the centered content column or swallow message-text selection, and it goes `pointer-events-none` at zero gutter. Hovering opens a preview card with the user message plus a 3-line clamp of that turn's final assistant reply, anchored by a 3-way `translateY` (`resolveMinimapPreviewTranslateY`) so the first and last ticks cannot render it off-screen. Turn outcome is encoded redundantly — amber for `interrupted`, red for `failed`, doubled tick thickness, a preview badge, and an aria suffix — so colour is never the only signal. |
| `chatPrPaneInset.ts` | Context carrying the floating PR pane's **viewport-space bottom edge** (not its height). `usePrPaneInsetObserver` attaches a `ResizeObserver` (1 px deadband, seeded synchronously on attach) to the pane card *and to its offset parent* — the card is absolutely positioned, so a resize of the surface is the only signal that the card's top edge moved. `ChatUserMinimap` reads the value through `useChatPrPaneInset` and converts it against the message-list root's own viewport top (`inset = max(0, paneBottom - listTop + gap)`), then re-centres the rail in the remaining band, going inert below ~140 px. The conversion is deliberate: the pane is positioned inside the chat-surface `motion.div` while the rail is positioned inside the message-list root, so a height-plus-constant inset would overshoot by the chat header's height and no constant could fix it. It is a context and not a prop because the pane and the message list are siblings — threading it as a prop would push every PR-pane resize frame through the memoized `AgentChatMessageList`. |
| `chatSessionRetention.ts` | Keeps a chat's `agentChat.onEvent` subscription alive for `CHAT_SESSION_RETENTION_TTL_MS` (5 min) after its pane hides or unmounts, so returning to a tab shows a current transcript instead of one that is stale by a whole tab visit. It is a **renderer** module on purpose: preload's remote event pump only polls while `hasRemoteRuntimeEventSubscribers()` is true, and that predicate counts renderer-held `onEvent` callbacks — a retained renderer subscription keeps the pump alive for free, so moving this into preload would idle the pump for exactly the case it exists to fix. Ownership is a **handoff, not a shared subscription**: a visible pane owns the only subscription; on hide it calls `retainChatSession(sessionId)` and this module opens its own minimal handler; on return `adoptRetainedSession(sessionId)` flushes synchronously and tears the module handler down. The handler captures no pane state, setters, or refs — it talks only to the injected `ChatSessionRetentionHost` (`subscribe` + batched `appendEvents`), wired once from `AgentChatPane` module scope. Envelopes are buffered per session and appended in one batch on a 16 ms timer (`CHAT_SESSION_RETENTION_FLUSH_MS`, the same cadence as the visible pane's flush) because a per-event append re-walks the whole transcript to dedupe/trim/derive, which would make a *hidden* chat cost more per event than a visible one. `MAX_RETAINED_CHAT_SESSIONS = 2` caps fan-out so a grid of tiles hiding at once cannot open one subscription per session. On TTL expiry the subscription drops but the cached view is kept (warm, just no longer live). The module never computes `turnActive` policy — adoption still funnels through `chatTurnState.resolveTurnActive` at the pane's `applyCachedSessionView`, so terminal transcript evidence still outranks a stale cached `turnActive: true`. |
| `chatCompanionUiState.ts` | Per-chat companion UI state — which side panes/drawers a chat had open (`chatActionsOpen`, `chatActionsTab`, `iosSimulatorOpen`, `appControlOpen`, `terminalDrawerOpen`, `prPaneOpen`). Persisted in **`localStorage`** under the `ade.chat.companionUiState.<key>` family (not `sessionStorage`): reopening the app to the chat you left should look like the chat you left. Keys are scoped by companion key and two surfaces write disjoint key spaces — the ADE chat pane keys by chat session id (plus reserved draft keys), the CLI session pane keys by terminal session id — so nothing may assume one surface's keys are the only live ones. `patchChatCompanionUiState(key, patch)` does the read-merge-write because the record has two independent owners (the chat shell's drawer state and `useChatPrAutoPop`'s `prPaneOpen`), and a whole-record write from either clobbers the other. Every read is defensive and degrades to `DEFAULT_CHAT_COMPANION_UI_STATE`; the legacy `proofDrawerOpen` field still maps forward to `chatActionsOpen` + the `proof` tab. Each write stamps `savedAtMs` and runs `pruneChatCompanionUiState` (cap 200 entries, oldest-first, records with no `savedAtMs` sort oldest) — self-pruning from inside the module, because the earlier caller-supplied `knownKeys` prune treated the second writer's live keys as garbage. |
| `useChatPrAutoPop.ts` | Auto-pops the floating PR pane on a qualifying PR delta (baseline seeded silently so an already-open PR never pops on chat open). Takes an optional `persistKey` — the surface's companion-state key — which makes the pane's open/closed state per chat *and* durable across restarts via `chatCompanionUiState`; without it the pane is bare component state and every chat switch or relaunch reopens from "closed". Hydration and persistence are two effects in declaration order: on the commit where `persistKey` changes, the persist effect still closes over the outgoing chat's `prPaneOpen`, so a `pendingHydrationKeyRef` marker makes it skip exactly that one stale flush instead of writing chat A's value into chat B's record. Every transition persists — the toolbar toggle, the pane ✕, and the webhook auto-pop all move the same state. |
| `ChatProposedPlanCard.tsx` | Composer-level plan approval card shown while input is locked. Renders the plan description or question text as rich markdown (`ChatMarkdown`) inside a scrollable container (capped at `min(34vh, 360px)`). Transcript plan events render through `AgentChatMessageList` / `CodexPlanCard`. |
| `apps/ios/ADE/Views/Work/WorkPlanComposerViews.swift` | iOS composer-level plan approval strip. The live `plan_approval` gate renders as a compact full-width strip above the prompt box, opens a large markdown sheet for review, and sends Approve/Reject decisions through `chat.approve` with optional rejection feedback as `responseText`. It is one body of the consolidated pending-input strip (see [Cross-surface parity](#cross-surface-parity)) — the strip in `WorkChatSessionView+Timeline.swift` renders the current request (plan / approval / permission / question / model-selection), a "Request 1 of N" header, and an "Accept all" sweep when more than one gate is queued. |
| `apps/ios/ADE/Views/Work/WorkChatComposerAndInputViews.swift` | iOS prompt box, icon-only staged-steer strip, and `WorkStructuredQuestionCard` — the mobile question card. The card pins only a provider row (plus the question tab strip when paged) above its internal scroll region and the freeform field plus Send/Decline footer below it; the question text, request body, meta rows, and option list all scroll. `WorkPendingInputHeightBoundedCard` in the same file is the generic wrapper that caps the non-question gates. Both budget against `maxCardHeight` (see [Cross-surface parity](#cross-surface-parity)) and enable `.scrollDismissesKeyboard(.interactively)` so a long typed answer can never trap the user away from the footer. |
| `apps/ios/ADE/Views/Work/WorkDraftPersistence.swift` | iOS draft persistence. `WorkComposerDraftStore` keeps unsent composer text per chat (`chat:<sessionId>`) plus fixed keys for the Hub and New Chat composers; `WorkQuestionDraftStore` keeps in-progress question selections/freeform per request id. Both are versioned JSON dictionaries in App Group `UserDefaults` via `WorkDefaultsJSONMap`, LRU-evicted by `updatedAt` (60 composer entries, 30 question entries), with a 400 ms `workDraftAutosaveDebounce`. The `workPersistedDraft(_:key:)` view modifier packages the three legs a plain `String` binding needs: restore-if-empty on appear, debounced autosave, flush on disappear. |
| `ChatModelSelectionPendingCard.tsx` | Full agent-briefing model picker for orchestration pending inputs. Shows description, touched files, run-after dependencies, provider/model controls, and submitting/cancel states without a recommended default model. |
| `codex/CodexPlanCard.tsx` | Codex plan card rendered inline in the transcript for `plan` events. Shows plan state (Planning / Plan ready), step progress with status glyphs, and streaming plan text as rich markdown via `ChatMarkdown`. Completed plans with no discrete steps render the full markdown body inline; plans with steps offer a toggle to expand the raw markdown details (labelled "details" when complete, "live" while streaming). Handles missing `steps` arrays gracefully. |
| `codex/CodexGoalCard.tsx`, `codex/CodexGoalBanner.tsx` | Codex goal surfaces. The card is the active desktop surface and routes edits, status changes, and clears through typed ADE APIs (`ade.agentChat.codex.*`) rather than prompt text. It shows objective, status, token count, and elapsed time, while hiding provider budgets because ADE keeps goals unlimited. The banner remains available for compact surfaces that need a horizontal goal strip. |
| `ChatWorkLogBlock.tsx` | Collapsible work-log group (see `chatTranscriptRows.ts`). Accepts `animate` so completed groups render a static glyph while in-flight ones pulse; prefers `waiting` over `working` when any entry is `interrupted`. Web-search work-log rows render provider action details (`query` / `queries`, `title`, `url`, `snippet`) as compact result chips; URL chips route through `openUrlInAdeBrowser()`. Also renders a `LocalhostServersStrip` above the panels when any work-log entry produced a `localhost`/`127.0.0.1`/`0.0.0.0`/`[::1]` URL: a sky-toned chip per detected URL routes through `openUrlInAdeBrowser()` (so the click opens the Work sidebar Browser tab in a new tab), and a sibling Logs button either reveals the chat's currently active terminal (via `onRevealChatTerminal`) or — when no terminal exists — drafts a "please move this server into the ADE chat terminal" prompt for the agent through `onInsertDraft`. |
| `AskQuestionComposer.tsx` | The ask-question surface, anchored **in the composer**: while a question blocks, it replaces the textarea inside the same prompt-box frame (provider mark + verb header, ledger option rows, capped previews, note row, keyboard-first answering, A/B compare, minimize). See [Pending input card](#pending-input-card). |
| `QuestionReceipts.tsx` | The transcript record for a question: a one-line expandable receipt on the `chatCardPrimitives` / `AdeCard` convention once resolved (`AnsweredQuestionReceipt`), and an "awaiting you" row while the gate is open (`OpenQuestionReceipt`). |
| `apps/desktop/src/shared/pendingInputAnswers.ts` | The shared answer contract — `answerState`, `sendLabel`, `buildAnswers`, `notePlaceholder`, `foldedSummary`, plus `sanitizeAnswersForTranscript` and `flattenAnswerForSingleStringProvider`. Imported directly by the desktop renderer, the web client (same component), and the TUI; iOS mirrors it in Swift. |
| `CodeHighlighter.tsx`, `chatStatusVisuals.tsx`, `chatSurfaceTheme.ts`, `chatToolAppearance.tsx` | Supporting visuals. `chatStatusVisuals.ChatStatusGlyph` takes an `animate` prop so non-active rows skip the ping/spin animation; `AgentChatMessageList.ActivityIndicator` mirrors this and switches to a dimmed static tone plus a non-looping thinking lottie once the turn ends. |
| `pendingInput.ts`, `chatExecutionSummary.ts`, `chatNavigation.ts`, `chatTranscriptRows.ts` | Pure state derivations consumed by the UI. `chatTranscriptRows.ts` also owns two message-list helpers: `shouldCollapseUserMessageText` (a user message over 600 characters or 8 lines renders collapsed) and `countRowsAppendedSince` (the `N new` count on the jump-to-latest pill). |
| `apps/desktop/src/renderer/lib/visualContextFormatting.ts` | Prompt formatting for visual/tool context from attachments, iOS Simulator, App Control, and built-in browser selections. |
| `apps/desktop/src/shared/types/chat.ts` | Shared composer/session DTOs, including `PARALLEL_CHAT_MAX_ATTACHMENTS`, parallel launch state types, the `AgentChatModelCatalog*` set, `AgentChatModelCatalogRefreshProvider` (`opencode` / `cursor` / `droid` / `lmstudio` / `ollama`), and `AgentChatModelCatalogArgs` (`mode`, `refreshProvider`). |
| `apps/desktop/src/renderer/components/shared/ModelPicker/` | Modular ModelPicker (see [ModelPicker structure](#modelpicker-structure)): `ModelPicker.tsx`, `ModelPickerContent.tsx`, `ModelPickerRail.tsx`, `ModelListRow.tsx`, `ReasoningEffortPicker.tsx` (draggable/snapping gradient slider that stays open on selection), `modelCatalog.ts`, `modelOrdering.ts`, `modelPickerSearch.ts`, `providerEmptyState.tsx`, `runtimeCatalogCache.ts`, plus the `useProviderAuthStatus` / `useAuthOnlyFilter` / `useModelFavorites` / `useModelRecents` / `usePerSurfaceModelDefaults` / `useReasoningByFamily` hooks. |
| `apps/desktop/src/renderer/components/shared/PermissionModePicker.tsx` | The permission-mode pill itself, shared by every surface that lets a user choose how a chat starts: the composer's per-provider controls, `SessionLaunchModelControls`, and the cross-machine handoff modal. Exports the generic `PermissionModePicker`, `PermissionModeGlyph`, the tone/icon enums the provider option tables map into, and `PERMISSION_TRIGGER_CLASS` — the one definition of the trigger chrome, previously hand-copied per surface. That class scales with `calc(var(--chat-font-size,14px)*9/14)`; the fallback is load-bearing, because `--chat-font-size` only exists on a chat appearance root and a bare token would leave the launch and handoff pills inheriting the ambient size. Anything offering permission modes renders this, not a lookalike. Tone colour is deliberately asymmetric between the collapsed trigger and the open popover: only the `red` tone (bypassed permissions — the one mode here that can do damage) keeps colour on the resting trigger, and as a border/text tint rather than a filled pill. Every safe tone renders neutral trigger chrome and lets its tone read from the glyph alone. A toolbar where each control is a saturated pill has no way left to say "this one is different"; the full palette still applies to the popover rows, where there is room. |
| `apps/desktop/src/renderer/components/shared/BlockedAction.tsx` | The blocked-action primitive: `BlockedActionReason` (id, title, detail, and the optional fix that clears it), `BlockedReasons` to render them inline, `describeBlockedReasons` for tooltip/a11y text, and `BlockedActionButton`, which takes the reasons themselves rather than a `disabled` boolean so a caller cannot disable a control without handing over the explanation. Exists because ADE keeps regrowing the same bug — a surface computes blockers, disables the primary button, and renders none of them. |

Cross-machine Work drafts do not rebind the project tab. `AgentChatPane` freezes
the selected `OpenProjectBinding` and uses it for model/auth discovery, slash
commands, file search, attachments, parallel launch state, lane/chat creation,
rollback, and recovery. A selected binding that is unresolved or disconnected
fails closed instead of silently using the tab's machine. Changing the selected
machine within the same draft copies local image attachments to the new runtime
and keeps portable image URLs. Non-image files and machine-owned tool context
are removed because their paths cannot cross runtimes safely. Sending waits for
the image copy to finish; a failed copy leaves the source images in place and
requires the user to switch back or remove them. Restoring a draft after a
project-tab switch first reconciles the tab's selected machine, so hydration
does not remove or transfer attachments as though the user changed machines.
Browser, App Control, and iOS panels also fail closed when their local-only
service cannot safely operate on the chat's owning runtime.

## Pane layout

`AgentChatPane` is the mount point. It:

1. Subscribes to `ade.agentChat.event` for the current session and
   accumulates envelopes into local state.
2. Derives:
   - Message rows via `chatTranscriptRows.ts`.
   - Active/idle turn state via `chatTurnState.ts`; terminal transcript
     evidence takes precedence over an eventually consistent active summary.
   - Pending inputs via `pendingInput.ts`.
   - Todo items via `deriveTodoItems()` in `chatExecutionSummary.ts`.
   - Scheduled/background work via `deriveScheduledWorkSnapshots()`.
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

Floating PR and Chat Actions panes may reserve horizontal gutter when they
would otherwise cover the centered chat column. That reservation belongs only
to the selected-session branch that mounts those panes. The empty/draft branch
uses a zero reserve even when the lane's persisted PR-pane preference is open,
so a new-chat composer is centered rather than shifted for invisible chrome.

### Empty draft surface

The draft (new-chat) branch is three elements, not seven: the wordmark, the
composer, and a **launch shelf** tucked under the composer, with the activity
module below. There is no standing "Start a new conversation" caption — the
wordmark already identifies the app, so the line was a band of vertical space
spent restating what the user could see. Only a non-default mode still writes a
line there (`isOrchestratorDraft` renders "Orchestrate a swarm of agents"),
because that names something the surface does not otherwise show.

The shelf holds everything that answers **where this runs**, as two adjacent
dropdowns plus two labelled actions: `DraftMachinePicker`, then a `LaneCombobox`
(mounted `compact`, so its 28px trigger matches the composer pills above it),
then Shell and Import. The composer sits above it at `z-10`.

Machine and lane are **separate controls on purpose**. Folding them into one
list made that list carry two orthogonal choices: every lane row had to name its
machine, and the list grew by machine count rather than staying the length of one
machine's lanes. Choosing the machine first keeps the lane list flat, short, and
scoped — `DraftMachinePicker` renders nothing below two machines, and
`AgentChatPane` passes `draftShelfLanes` (bare lane ids for the selected machine)
rather than the machine-qualified option ids the combined selector needed. A
draft therefore has no machine label in its toolbar: the shelf is the live
machine control. Once a chat exists, the toolbar instead shows its owning
machine as a read-only execution label; moving it remains Chat actions → Handoff
→ Continue on another machine.

`handleMachineChange` in `useDraftMachineRouting.ts` re-points the lane to the
target machine's primary **without touching `draftLaunchTargetId`**, so a draft
sitting on "Auto-create lane" keeps that target and only its underlying machine
moves — auto-create and primary are the two targets ADE guarantees on every
machine running it, so neither needs the user to re-choose. A machine with no
lanes at all falls back to `AUTO_CREATE_LANE_OPTION_ID` rather than erroring or
leaving the picker blank.

Shell and Import keep text labels. As icon-only buttons they were unreadable —
that was a symptom of solving the wrong problem (compressing controls to fit a
shelf that was simply too tall).

`LaneCombobox` itself was reworked for this: a single-line trigger (lane dot,
name, branch, caret) instead of a 40px two-line block, lane colour reduced to
the dot so the control sits in the same neutral ghost family as its neighbours,
and a search field. Branch text truncates before the lane name via flex shrink
factors — the branch is context, the name is the label. Two invariants are pinned
by tests: `fullWidth` emits no `max-w-*` and nothing inside establishes a
min-content floor (the measured narrow-pane overflow this component regressed
before), and `computeLanePopoverPlacement` clamps on both axes including the
case where neither side fits. The popover has no exit animation on purpose — a
body-portal node that outlives `open` by a frame leaks into whatever renders
next, which is how its search field started colliding with unrelated
`getByRole("textbox")` queries in the chat suites. Its machine-grouping support
still exists for other callers; the shelf simply never triggers it.

Its chrome is the `.ade-chat-launch-shelf` class in `renderer/index.css`. The
shelf cancels both the parent stack's 12px gap and the composer's 12px wrapper
margin, overlaps the painted composer by one pixel, and omits its top border.
The composer's bottom edge is therefore the shared edge while the shelf
supplies the continuing sides and lower corners; no background-colored seam
sits between the two surfaces.

**Keep the margin and padding in that CSS rule, not on the element.** They lived
briefly as Tailwind arbitrary values carrying CSS variables
(`-mt-[var(--chat-radius-shell)]`, `pt-[calc(var(--chat-radius-shell)+4px)]`) —
exactly the kind of class that can fail to compile with no error. When the
negative margin silently vanishes, the shelf detaches from the composer.
Nothing in the type system or test suite catches that geometry.

The nesting is also load-bearing: Shell and Import both act on whichever lane is
selected in this shelf, so presenting them *inside* it encodes a dependency the
earlier stacked layout inverted — lane selection used to sit below two buttons
that could not work without it.

### Header

- Session title from `chatSessionTitle()`; falls back to "New chat".
- When the session is attached to a lane, a lane navigation button
  renders the lane's label with a branch icon. Clicking navigates to
  the lane in the Lanes tab via the app store.
- CTO and resolver surfaces override the title and chips through
  `ChatSurfacePresentation` (`assistantLabel`, `accentColor`, `chips`).
- Ambient lifecycle chips. `AgentChatPane` passes the selected session id to
  `WorkSurfaceHeader` as `lifecycleSessionId`, which mounts
  `renderer/components/work/SessionLifecycleChips.tsx`. A settled or snoozed
  chat would otherwise look identical to a live one once you are inside it, so
  the header shows a `settled` and/or `snoozed` chip whose menus call
  `wakeSessionNow` / `setSessionSettleOverride` (or `sessions.unsettle` for a
  declared settle) from
  `renderer/components/terminals/sessionLifecycleActions.ts`. State comes from
  the same derived helpers the Work sidebar uses (`sessionCanonicalUiState` +
  `isSessionSnoozed` / `snoozeWakeLabel`) and
  `useSessionLifecycleSnapshot(sessionId)` reads the `terminal_sessions` row out
  of the per-project session cache the Work tab already mirrors into the app
  store — no extra IPC, and a chip can never disagree with its sidebar row. The
  chips live in the **header** deliberately: the slot directly above the
  composer belongs to lane branch drift, where `AgentChatPane` renders
  `<LaneBranchDriftStrip laneId={laneId} />` and arms it
  (`armLaneBranchDriftWarning`) on submit so a turn about to run against a
  worktree whose HEAD wandered off the lane's branch warns first. See
  [Terminals and sessions](../terminals-and-sessions/README.md) and
  [Lanes › Branch drift](../lanes/README.md#branch-drift).

## Composer

`AgentChatComposer` supports:

- **Post-failure recovery.** A failed/interrupted turn releases the input and
  send controls. Capacity and usage-limit cards can resend the original user
  prompt (with its attachments, context items, and metadata) in the same
  durable provider thread, or explicitly open the model picker before the
  user starts the next turn. Recovery never starts automatically and is
  disabled while another turn is active.

- **Text input** with auto-grow up to `composerMaxHeightPx`. Grid tiles
  pass a fixed 144 px ceiling (computed statically from `layoutVariant`)
  rather than the old `ResizeObserver`-based 28 %-of-height formula;
  that eliminated the observer churn without changing the visible
  ceiling for normal tile sizes.
- **Prompt stashes (desktop only).** Cmd/Ctrl+S stores the current prompt text
  in the project runtime and clears the composer only after the runtime confirms
  the write. The bookmark control immediately left of the context-usage meter
  performs the same action; invoking either path with an empty composer opens
  the stash list instead. Restore immediately puts the saved text back into the
  composer, then consumes the shared row; the runtime acknowledgement never
  overwrites edits made while a connected desktop is responding. If that
  delete cannot be confirmed, ADE favors a harmless duplicate stash over losing
  draft text. Up to 20 entries are retained, newest first. The CRR-backed
  `prompt_stashes` table makes the list available
  to other synced runtimes, while renderer calls always route through the
  currently bound local or remote project runtime. File attachments and visual
  context are deliberately not stashed because their paths can be
  machine-specific. Appearance > Prompt stash button can hide the bookmark;
  the keyboard shortcut remains active. Mobile and the TUI do not expose this
  feature.
- **Smart links.** Once an HTTP(S) or `ade://` URL is completed by paste,
  whitespace, or paragraph insertion, the rich editor replaces its visible run
  with an atomic violet chip. Each chip shows the provider's real brand mark —
  the GitHub octocat, the Linear mark (shared `LINEAR_LOGO_PATH`), and an ADE
  monogram — rendered as an inline `currentColor` SVG by `smartLinkChipMark.ts`;
  generic pages show a globe until they asynchronously adopt a bounded page
  title and favicon from `chat.resolveSmartLinkPreview` (a resolved favicon
  replaces the globe). The provider catalog in `smartLinks.ts` still supplies
  the compact text label beside the mark. The literal URL remains `draft` and
  is what the agent receives. Hover/title reveals the full URL; click, Enter, or
  Space opens Copy link / Remove link; Backspace/Delete removes an adjacent or
  focused chip in one operation. The rich contenteditable is explicitly
  left-aligned so a pasted link (which swaps the textarea for the rich editor)
  cannot inherit a centered ancestor's `text-align`.
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
- **Chip selection highlight.** Rich-composer chips are
  `contentEditable="false"`, so the browser skips them when it paints the native
  selection and dragging across one renders as two disconnected highlight runs.
  Every chip therefore carries a `data-composer-chip` attribute naming its kind
  (`ios-context`, `app-control-context`, `built-in-browser-context`, …), and a
  `selectionchange`-driven effect marks the chips the current range intersects
  with `data-composer-chip-selected`. `index.css` paints that marker as a
  translucent `::after` overlay in the platform selection color, so the
  highlight reads as one continuous run. `range.getRangeAt(0)` is already
  start-before-end, so a backwards drag needs no special casing, and a range
  outside the editor simply drops the marks. The performance contract is
  load-bearing — see
  [Chip selection marking must stay cheap](#fragile-and-tricky-wiring).
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
  starts, label it by mode (`preparing-summary` for a brief,
  `forking-history` for a fork) while the old surface closes, and remove
  it once the new chat is created or the handoff fails — or hide it
  earlier as soon as a matching real session row appears in the sidebar
  (`handoffJobLikelyMaterialized`), so an in-flight handoff never reads
  as two sessions with one vanishing (ADE-122). When the source provider
  is fork-capable
  (`providerSupportsHandoffFork`: Claude, Codex, OpenCode, or Droid) the
  local handoff surface exposes both **Brief** and **Fork** modes,
  defaulting to fork; Cursor is brief-only. Fork keeps the new chat in the
  source lane and on the same provider — the fork model picker is
  constrained to that provider's models — while a brief can retarget any
  active lane in the project (via `targetLaneId`) or a freshly created
  lane. Claude forks the SDK session pointer, Codex the app-server thread
  (`thread/fork`), OpenCode `session.fork`, and Droid `forkSession()`. The
  surface also includes an optional handoff note textarea; blank notes
  are ignored, brief handoffs append non-empty notes to the hidden handoff
  prompt, and forks send the note as the first user turn. Codex handoff
  targets do not inherit ADE session goals or seed app-server goals; forked
  Codex threads are cleared through the goal RPC before user input is sent.
  The Work sidebar renders the job as a non-selectable placeholder in the
  same lane/status/time groups as real sessions.
  Orchestration model-selection requests use
  `ChatModelSelectionPendingCard` instead of the inline selector: the
  card is an agent briefing first (role/tag, description, files,
  dependencies) and a model choice second. It intentionally starts with
  no recommended model so the user makes the routing decision explicitly.
- **Reasoning effort.** A standalone `ReasoningEffortPicker` (extracted
  from the model row) is rendered next to the model trigger when the
  active descriptor exposes `reasoningTiers`. The picker remembers the
  last-used effort per model family via the `useReasoningByFamily`
  hook. The control is a real pointer slider: click or drag previews the
  position and release snaps to the nearest model-supported tick; arrows,
  Home, and End provide the same keyboard path. The filled portion uses a
  progressive low-to-high gradient and the active tier keeps the existing
  pulse/colour treatment. A tier choice does **not** close the popover — the
  user can compare levels until clicking outside or pressing Escape.
  The collapsed trigger uses the full tier label on normal-width composers
  (for example, `Medium` rather than `MED`) and removes the nested label
  outline because the trigger already supplies the interactive boundary.
  Narrow/mobile layouts retain the abbreviated label to preserve space.
  GPT-5.6 displays Light / Medium / High / Extra High / Ultra; ordinary Max
  is hidden for that family, and Ultra explains that it can delegate to
  multiple agents and use limits faster.
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
- **Fast mode.** Toggles the legacy-named `codexFastMode` bit for the
  selected session. Fast mode is a property of a *model*, so the toggle
  lives on the model row inside the shared `ModelPicker` rather than as a
  separate composer chip — every surface that mounts the picker gets it,
  and the composer toolbar keeps one control where it used to spend two.
  The row chip renders whenever that descriptor advertises
  `serviceTiers: ["fast"]` (dynamic Cursor SDK/CLI rows, GPT-5.6, and
  older fast-capable Codex entries) *and* the caller supplied
  `onFastModeChange`. Fast is one bit per surface but it belongs to the
  model it was enabled for, so a chip reads as on only on the *selected*
  row (`fastModeOn={fastMode && isActive}`) — never on every fast-capable
  row at once. Clicking the selected row's chip is a plain on/off toggle
  that neither closes the picker nor re-fires selection; clicking a
  non-selected row's chip means "use this model, fast" — one press
  commits the model selection and turns fast on. A plain row click onto a
  different model clears the previous model's fast bit rather than
  inheriting it. The chip's states are rest (muted outline, outline
  lightning) → hover (darker fill, still off) → press (`active:scale`,
  suppressed under `prefers-reduced-motion`) → on (violet fill, filled
  lightning). The collapsed trigger names the state rather than showing a
  separate indicator — `composeModelPickerTriggerLabel()` in
  `ModelPicker.tsx` renders "GPT-5.6 Terra Fast", with a filled lightning
  glyph rendered before the model name (`aria-hidden`, so the accessible
  name stays text-only). Codex state flows into
  the next `thread/start` / `turn/start` as `serviceTier: "fast"`; Cursor
  SDK state flows through the discovered model-parameter selection, and
  Work CLI launches resolve fast Cursor rows to the matching `*-fast`
  alias. Parallel mode passes the per-slot setter through the slot's own
  picker (`onParallelSlotCodexFastModeChange`).

  Surfaces not yet migrated (`ModelSelector`, `ReviewLaunchModelControls`,
  `CtoSettingsPanel`, `ChatModelSelectionPendingCard`, `ProjectlessComposer`)
  still pass the deprecated `fastModeActive` / `onFastModeToggle` pair,
  which keeps rendering the old sibling chip. Migrating them is a prop
  rename with nothing else to unwind.
- **Overflow control.** Issue context, orchestrator mode, parallel models,
  and the iOS Simulator / App Control drawer toggles are folded behind one
  `⋯` trigger (`ComposerOverflowMenu`). Each entry is gated by exactly the
  condition that used to gate its standalone button, so a control that
  would not have rendered does not become a row, and with no entries left
  the trigger disappears entirely.

  How many entries survive is **contextual**, not fixed — a Work CLI draft
  hides the lane tool drawers (`hideLaneToolDrawers`) and has no
  orchestrator, so it can be left with one. A `⋯` that opens onto a single
  row is a menu pretending to be a button, so at `items.length === 1` the
  control renders that entry directly as an icon button instead. Callers
  must therefore not assume either form; tests reach it through a helper
  that accepts both.

  Because folding hides active state, the collapsed trigger carries an
  accent dot whenever any entry is on, rows report `aria-checked`, and an
  entry may carry a `badge` count (issue context uses it for attached
  issues) which surfaces on the inline button too. Rows that open their
  own portal — issue context — position against the `triggerRef` rather
  than against the row, because the row unmounts with the menu while the
  trigger stays mounted.

  The menu itself **portals to `document.body`** via
  `composerSplitMenuPosition`, like every other composer popover. The
  composer shell clips its overflow, so an inline-absolute menu is cut off
  at the prompt-box edge and simply cannot be read.
- **Send options.** Background launch is the second row on Send's caret,
  and Send is a **split control**: one `rounded-full` body, the arrow on
  the left, a hairline divider, a caret sharing the same fill. This is
  deliberately the same shape as `ActiveTurnSendButton`, so the composer
  uses one send idiom whether or not a turn is running. The earlier
  arrangement — a second filled circle beside Send, also carrying an arrow
  — read as one control accidentally duplicated and overflowed the
  composer's padding, clipping against its rounded edge. The split renders
  only when `onSubmitInBackground` is supplied and the surface is neither
  parallel nor Cursor-Cloud mode; otherwise Send stays a plain circle.
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

  All shared permission dropdowns render only each mode's title in the row.
  The longer explanation remains available as the row tooltip/title instead
  of forcing the popover to become a wall of text.

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
  `startBackgroundLaneNaming` asks the main process for a structured lane
  title + branch identity in the background. The deterministic fallback stays
  persisted for failure safety but is masked in lane-label positions by an
  animated `Naming lane…` state. The renderer retries the background naming
  pass once (750 ms apart), refreshes the completed identity before unmasking
  it, and reveals the fallback only when naming fails or produces no change.
  Branch uniqueness is resolved by the lane service. Each launch creates a `DraftLaunchJob` that
  tracks progress through `creating-lane` / `starting-session` /
  `sending-prompt` / `ready` / `failed` states (auto-create no longer has
  a distinct `naming-lane` phase — it goes straight to `creating-lane`).
  While the background pass runs, affected lanes are flagged in
  `laneNamingStore` so singleton cards, hover details, and grouped lane headers
  all show `Naming lane…`.
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
  entry: edit (guard-cancel the queued entry with `requireQueued: true`, then
  merge its text, file attachments, and structured context attachments into the
  main composer so the user can revise it and choose a delivery mode again),
  cancel (`ade.agentChat.cancelSteer`), and — for Claude SDK sessions only —
  **send during turn** (`ArrowBendDownRight`) and **interrupt & send**
  (`Lightning`). **Send during turn** dispatches the queued message into the
  active turn via `ade.agentChat.dispatchSteer({ mode: "inline" })`;
  the user message then appears in-transcript with
  `deliveryState: "inline"`; the service pushes an SDK message with
  `priority: "next"` and `shouldQuery: true`. **Interrupt & send** calls
  `dispatchSteer({ mode: "interrupt" })`, which uses SDK priority `now` to
  redirect the current model step without tearing down the Claude query. Both buttons are
  hidden for non-Claude providers (Codex, OpenCode, Cursor) which only
  support post-turn delivery.
- **Mid-turn split Send button.** While a Claude turn is active, the
  composer's primary send control is a split button
  (`ActiveTurnSendButton`, Claude Code parity). The caret selects **Send during
  turn**, **Send after turn**, or **Interrupt & send** without sending; the
  primary click and Enter execute the selected mode, and the icon, tooltip,
  and accessible label follow it. Immediate modes are a single atomic
  `steer({ dispatchMode })` call rather than queue-then-dispatch. The primary
  action disables on an empty draft, while the caret remains available so the
  user can inspect or change the delivery mode. Providers without inline-steer dispatch
  (Codex, OpenCode, Cursor) keep the single queue-on-send affordance.
- **Queue-aware Stop button.** In an active Claude chat, Stop becomes a compact
  split control. **Stop & clear queue** is the
  backward-compatible default and uses a trash icon; **Stop only** keeps queued
  messages and uses the stop-square icon. The selection is stored per chat,
  drives the primary button and `Cmd+.`, and the custom portal menu dismisses
  as soon as an option is selected. A successful clear that cancelled
  ADE-attributed messages produces one transcript Undo card for eight seconds;
  Undo calls `restoreCancelledQueue` and restores the original queued payloads.
  With no queue, or on providers without this contract, Stop remains the
  single-action interrupt button.
- **Context meter lifecycle.** `ContextUsageDial` shows a percentage only for
  `state: "measured"`. During compaction it shows an ellipsis and explains that
  the last exact reading is hidden; after a boundary without an exact post
  count it stays `recalculating`; a failed authoritative read shows `?` /
  `unknown`. Streamed usage can move the dial during a turn, but the
  control-channel snapshot after settle/compaction is the authoritative value.
- **Question answering.** When a question-type pending input is active, the
  question card *replaces* the composer textarea (`AskQuestionComposer`) and
  the model / permission / effort footer is hidden until it resolves. Selecting
  an option marks it and never submits; `Next` / `Enter` advances. A selection
  and a typed note both travel, selection first — see [Answer
  semantics](#answer-semantics). Multi-select questions render a toggle ledger
  plus a fixed-height preview pane (sanitised via `ReactMarkdown` +
  `rehype-raw` + `rehype-sanitize` + `remark-gfm`), disclosed by an explicit
  click rather than hover or keyboard focus.
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
| `ModelPicker.tsx` | Trigger + popover entry point. Owns runtime-catalog loading via `runtimeCatalogCache`, fast mode, and the favorites/recents fan-out. Pass `fastMode` + `onFastModeChange` and the picker owns the affordance: a per-row Fast chip inside the popover plus a `<Model name> Fast` trigger suffix composed by the pure `composeModelPickerTriggerLabel` helper. Surfaces that pass neither render no fast affordance at all; the deprecated `fastModeActive` / `onFastModeToggle` / `fastModeSupported` props still render the old sibling chip for call sites that have not migrated. |
| `ModelPickerContent.tsx` | The popover body: search bar, rail, virtualized list (`@tanstack/react-virtual`), empty state. Props include `hidePermissionRail` (forward-compat hook for orchestrated surfaces that suppress permission-related affordances), `allowCliOnlyModels` (switch Cursor filtering from SDK chat models to CLI launch models), `allowRegistryExpansion` (when false, skip merging `MODEL_REGISTRY` entries into the runtime catalog), and `registryFilter` (restrict registry expansion by descriptor, used by fork handoffs to keep the provider fixed without freezing the picker to a stale concrete-id list). When the authenticated-only filter is active, authenticated CLI-backed providers (Claude, Codex, Droid) may expand from the static registry even if the last discovered model-id list is incomplete. Estimated row height `MODEL_ROW_ESTIMATED_HEIGHT = 44`. |
| `ModelPickerRail.tsx` | Left-rail tabs (Favorites / Recents / per-provider groups). Reads `AuthStatus` per family to render auth gates and the OpenCode "Install OpenCode" CTA from `providerEmptyState`. |
| `ModelListRow.tsx` | A single model row (favorite star, brand logo, display name, sub-provider chip, availability tone). Also renders the muted Fast chip when the surface supplied `onFastModeChange` and `modelSupportsFastMode()` holds for that row's descriptor; toggling it changes neither the selection nor the popover's open state. |
| `ReasoningEffortPicker.tsx` | Standalone reasoning-effort dropdown, mounted next to the model trigger and inside per-slot parallel-launch controls. |
| `modelCatalog.ts` | `descriptorsFromAgentChatModelCatalog`, `mergeSelectorModels`, `resolveModelDescriptorWithRuntimeCatalog`, `createUnknownModelPlaceholder` — pure helpers that flatten the IPC catalog into a `ModelDescriptor[]` and reconcile it with the static registry while preserving runtime metadata such as `serviceTiers` and Cursor `cursorAvailability`. |
| `modelOrdering.ts` | `sortModelItems` — provider/group ordering and intra-group ranking (favorites first, then recents, then default registry order). |
| `modelPickerSearch.ts` | `scoreModelPickerSearch` — fuzzy search across display name, family, provider, and ids; ranks favorites/recents above strict matches. |
| `providerEmptyState.tsx` | Per-provider empty/auth/install CTA copy. Surfaces "Install OpenCode" when the binary is missing, "Sign in to Cursor" when auth is missing, etc. |
| `runtimeCatalogCache.ts` | Renderer-side shared catalog cache. Tracks per-provider freshness (30 min for `opencode`/`cursor`/`droid`, 30 s for `lmstudio`/`ollama`) and dedupes concurrent `modelCatalog` requests by `${mode}:${refreshProvider}` keys. |
| `useProviderAuthStatus.ts` | Resolves `AuthStatus` (`ok` / `limited` / `unauthed` / `unknown`) per `ProviderFamily` from the runtime-binding-scoped `aiDiscoveryCache`. A picker with no explicit `providerAuthStatus` seeds from the cached value, joins the shared single-flight refresh, and reacts to cache update/invalidation events; callers that already supply status opt out of the full fetch. The separate cheap OpenCode-binary probe is deduplicated by runtime/project scope. |
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

All desktop call sites should use this shared auth path rather than derive
provider availability from only `availableModelIds`. The ids are a discovered
inventory and can lag authentication; for CLI-backed providers, a positive
provider-auth status is enough to expose registry models. The full status read
starts only while picker content is mounted, uses the shared project cache, and
does not poll. Local and cross-machine fork handoffs additionally apply a
same-provider descriptor filter, so they can show newly registered models from
that provider without allowing a cross-provider fork.

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

`AgentChatMessageList` windows its rendering with a **custom
virtualizer** (no `@tanstack/react-virtual`): a `measuredHeights` row-key
→ height `Map` supplies estimates, a top and a bottom spacer div hold the
scroll height around the rendered window, and `MeasuredEventRow`'s
`ResizeObserver` feeds real heights back through `handleMeasure` →
`reconcileMeasuredScrollTop`. Rows below the virtualization threshold
render unwindowed. Key rules:

- Assistant message cards constrain to `max-w-[78ch]` for readability
  (recent bump from `72ch` to `78ch` on large screens).
- User messages animate in with a `motion/react` spring transition.
- A user message over 600 characters or 8 lines renders collapsed
  (`CollapsibleUserMessageBody`) behind a CSS gradient mask with a
  **Show full message** / **Show less** toggle. The mask is used instead
  of `line-clamp` on purpose: `line-clamp` needs a single inline
  formatting context and mangles markdown, chips, and code. Row keys are
  unchanged by expanding, so the normal measure → reconcile chain
  absorbs the height change.
- Code blocks render through `HighlightedCode`.
- Tables get rounded borders, separated spacing, and a subtle inset
  shadow.
- System notices render compact inline (no pill badges).
- Turn dividers (`ChatTurnDivider`) separate turns.
- Plan approval cards display the plan body as rich markdown inside a
  scrollable container (capped at `360px`). When a plan-approval event
  carries non-empty body text, it is rendered as a `MarkdownBlock`
  beneath the header.
- The jump-to-latest pill (shown while scrolled away from the bottom of
  a live session) reads `N new · jump to latest` when rows arrived after
  the reader detached, and plain `Jump to latest` otherwise. The count
  comes from `countRowsAppendedSince` in `chatTranscriptRows.ts`.
- The transcript head pages older history **silently**: an
  IntersectionObserver on a fixed-height sentinel — plus an underfill
  effect for tails too short to scroll — backfills without asking the
  reader to do anything, so the healthy path renders an empty slot. The
  `couldn't load earlier messages · retry` control appears only after a
  genuine failure that survived the two backoff retries
  (`OLDER_HISTORY_RETRY_DELAYS_MS = [800, 2400]` in `AgentChatPane`).
  The slot height is constant either way, so toggling it never shifts
  the transcript. Clicking **retry** performs one immediate request, keeps
  the failure visible with a loading state, and never repeats the automatic
  backoff ladder. A late result from a previous chat, runtime binding, or
  cursor is discarded.
- The timeline keeps programmatic scrolling and the left tick rail, but hides
  the native browser scrollbar. The minimap remains the transcript-position
  affordance without adding a second bright rail at the window edge.
- The left tick rail (`ChatUserMinimap`) mounts as a direct child of the
  list root, because its `left-0` gutter maths assume the offset parent
  is the element measured as `listWidthPx`. When older transcript pages
  exist before the resident tail, the rail keeps a top continuation marker
  even if the loaded window contains fewer than two user turns; paging fills
  in real ticks progressively instead of making the rail disappear at the
  cutoff.
- iOS uses the same healthy-path contract: a fixed-height head sentinel
  automatically reveals the next local window and requests a 256 KiB host
  page near the top. It renders words only while loading or after a retryable
  failure, preserves the cursor on failure, and uses `LazyVStack` so older
  history does not make every transcript row resident. The subagent roster is
  owned exclusively by Chat Info; only lifecycle cards remain inline at their
  transcript positions.
- **Per-chat scroll memory.** The owning pane force-remounts the list with
  `key={selectedSessionId}`, so every ref and state value dies on a chat
  switch; the memory therefore lives in a module-scope LRU `Map`
  (`chatScrollMemoryBySession`, capped at 32 sessions) — not a ref and not
  the store, since it is throwaway view state, not user data. Each entry
  records `wasPinnedToBottom`, the `anchorRowKey` at the viewport top, its
  `anchorOffsetPx`, and the `lastSeenRowKey` that seeds the `N new`
  counter on return. It is snapshotted on unmount only (refs are still
  live in the cleanup), so following the scroll costs no renders while the
  chat is open. Restore is hybrid: a reader who left pinned to the tail
  comes back pinned, otherwise a layout effect re-anchors — waiting for a
  non-zero container height, because the container measures 0 on the first
  frame and writing `scrollTop` against that clamps to 0 and reads as "it
  forgot where I was" — then applies exactly one correction on the next
  frame once real measured heights replace `ESTIMATED_ROW_HEIGHT`. Any
  real scroll between the two passes means the reader took over and the
  correction is abandoned. The anchor uses `measuredRowStartOffsets`, the
  same shared height model as the prepend anchor and the minimap, so the
  three cannot disagree about where a row starts.

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

`ChatTurnFileChangesPanel` renders `turn_diff_summary` events inline at
the bottom of the turn that produced them. The collapsed row shows the
turn's file count and aggregate insert/delete totals. Expanding it shows
two nested diff scopes:

- **This turn** — fetches the selected turn diff via
  `ade.agentChat.getTurnFileDiff`.
- **Full thread** — aggregates all available turn summaries for the
  session, advancing `afterSha` and stats as later turns amend the same
  file, then fetches the combined diff through the same API.

Both scopes render the shared `AdeDiffViewer`; the former bottom-of-chat
aggregate bar is not mounted on ADE chat surfaces.

## Rewind files confirmation

Claude and Codex user messages expose an undo affordance when the provider
can prove a rewind target. The pane first calls
`ade.agentChat.rewindFiles({ dryRun: true })`; if the checkpoint or
rollback plan can be restored, `rewindFilesPreview.ts` filters turn diff
summaries after the selected user message and pairs each reported file
with the earliest `beforeSha` and latest `afterSha` it can prove. The
confirmation dialog then shows:

- The user message being rewound to and its sent time.
- Aggregate insertion/deletion counts from the SDK dry run.
- One expandable row per file, including status and per-file stats when
  a turn diff summary is available.
- Lazy `AdeDiffViewer` previews via `ade.agentChat.getTurnFileDiff`.

Confirming calls `rewindFiles` without `dryRun`. Claude leaves
conversation history untouched and only restores files. Codex moves the
upstream thread back and restores the matching files: on app-server
>= 0.145.0 it forks the thread before the selected turn (`thread/fork`
with `beforeTurnId`); on older servers, or when the turn id cannot be
resolved, it falls back to the deprecated `thread/rollback` and is limited
to the latest user message (see
[agent-routing.md](./agent-routing.md#codex-rewind-and-0145-readiness)).

## Chat Info and subagents panel

When the Claude Agent SDK spawns background subagents, the service
emits `subagent_started`, `subagent_progress`, and `subagent_result`
events. `ChatSubagentsPanel` renders running/completed/failed/stopped
subagents with usage metrics. Running subagent and background-command durations
tick from wall-clock time once per second instead of freezing on the last SDK
usage snapshot; terminal rows retain their final duration. The same panel also renders the current
Codex goal, plan, `todo_update` task list, and the Schedule section
derived from `scheduled_work_update` events. The Work tab actions badge
shows the running subagent count and also counts scheduled work when no
subagents are present.
Full native Claude subagent-text forwarding is disabled. Any tagged child
assistant/tool frames the parent SDK query still emits carry `parent_tool_use_id`,
and ADE filters those frames out of the main
timeline and resolves the backing Claude session pointer when opening the
dedicated child transcript. A user's mid-turn steer always carries
`parent_tool_use_id: null`, so it remains addressed to the parent agent.
The same lifecycle events also render inline in the transcript as
identity-anchored spawn/result cards (background shells collapse to a
single finish chip) via `deriveSubagentTimelineRows()`
(`shared/chatSubagents.ts`), so the panel is a live roster and the
transcript keeps a durable per-agent boundary; iOS mirrors both the
timeline rows and the unified Subagents/Background/Schedule Chat Info
sheet.

Claude wakeups, cron tasks, `/loop`, remote triggers, and background work
are folded by `deriveScheduledWorkSnapshots()` into rows with kind,
status, cron/prompt/reason details, source ids, fire timestamps, and late
state. A parent turn ending does not coerce a running background row to
`stopped`; only an explicit terminal work update or genuine runtime teardown
does. The SDK's `background_tasks_changed` level set also keeps the owning
query alive past the normal idle cleanup window and is authoritative for
whether `local_bash` is actually backgrounded; ordinary foreground Bash uses
the same task kind and never enters Background. Stop-hook snapshots keep real
session-wide child shell/Monitor rows, but native Agents/workflows remain only
in Subagents so one task cannot appear in both sections. The desktop Schedule header calls the typed
`agentChat.setScheduledWorkPaused` API for the owning chat. While paused,
active schedule rows remain visible but dim and show `paused`; on resume,
overdue work fires once. Cron rows show `last ran <time> · next <relative>`.
Large Chat Info rosters use the shared stable partition in
`shared/chatSubagents.ts`: Subagents cap at 12 active rows, Background at 8,
Schedule at 10, Progress at 14, and Tasks at 12. Terminal rows move into a
single `Completed (N)` disclosure without sorting either group; failed and
pinned rows remain active and cap-exempt. Clear (shown beside the toggle only
while the fold is expanded) hides clearable terminal ids, Restore brings them
back, collapse/Completed/clear state is scoped to the chat session, and Show
all resets when the surface remounts. Small sections
retain the original static header without disclosure chrome. Fired one-shot
wakeups keep their fired time and optional `late` marker in the dim Completed
row. ADE Code mirrors the grouped row model in-memory, while iOS mirrors the
same predicates, caps, persistence semantics, and fired/late decoding.

Desktop renders those rows in the Chat Info drawer, ADE Code renders them
in the Chat Info right pane, and iOS shows the roster only in its Chat Info popup/sheet for
active scheduled items above the composer. The renderer does not own the
timers: all controls mutate the project runtime's durable scheduler.

Interrupt transitions all running subagents to `stopped` by emitting a
`subagent_result` with `status: "stopped"` for each, matching the
Claude Code CLI behavior. Each such `subagent_result` is only emitted when
its `subagent_started` was, and in the transcript a run of two or more
stopped cards folds into one `SubagentStoppedGroupCard` instead of a wall of
identical stopped rows.

Claude Workflow runs (the SDK's multi-agent orchestration tool) render in
the same panel with zero new chrome: `claudeWorkflowProgress.ts` normalizes
the undocumented `workflow_progress` snapshot and fans each workflow agent
out as its own subagent row (phase in the summary line, tokens/duration
from the snapshot, `workflowName` chip), while the parent workflow task row
falls back to a phase/count rollup summary. Child chat sessions spawned with
a parent lineage (`ade chat create` from a tracked agent shell, `--parent`)
also list here via synthetic `subagent_*` events keyed
`chat:<childSessionId>`. `deriveChatSubagentSnapshots` preserves that prefixed
task id and the underscore event's `spawnKind` when the canonical dot-form
`subagent.started` twin merges into the same snapshot, then derives an explicit
`childSessionId`. The panel uses that field for routing, labels the row with
the live child-session title when available, and shows the runtime as the small
kind chip. The parent transcript additionally shows a quiet "Subagent spawned"
chip (a `status:"subagent_spawned"` system notice) that deep-links to the child
chat.

Codex parallel-agent lifecycle comes from both legacy `collabAgentToolCall`
items and newer app-server `subAgentActivity` items. The service registers
each child thread for transcript backfill, carries `label`, `model`, and
`reasoningEffort` when the app-server provides them, and emits the same
`subagent_started` / `subagent_progress` / `subagent_result` rows the
panel already understands. Codex parallel agent failures emit a
system-notice plus `failed` / `stopped` `subagent_result` rows. The
agentChatService maps
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

## Chat Actions and Sources

`ChatActionsDrawerPanel` assembles the contextual tabs for an active chat.
The **Handoff** tab is a two-view surface that resets to its landing menu each
time it opens. The menu presents two cards: **Continue on another machine**
(cross-machine) and **Hand off locally** (same machine, a new chat forked or
briefed from this one). Choosing local opens the local handoff surface with the
fork/brief mode toggle, lane targeting, and optional note described above.
Choosing **Continue on another machine** (only offered for a locally opened
Work project) opens the **Send to machine** staged modal that checks source
publication, lets the user choose an eligible connected runtime, brief or fork
mode, and an optional continuation note, explains clone/storage/model/route
failures, and shows exactly what the capsule includes and excludes before final
confirmation. Remote-bound source tabs do not offer the cross-machine action:
the source project must be opened on the machine that owns its lane and chat.
The complete Git, capsule, fork-transport, idempotency, and security rules live
in [Cross-machine session handoff](../sync-and-multi-device/cross-machine-session-handoff.md).

When the selected provider is Codex, **Sources** is the first tab (ahead of
Missions/Agents/Proof/Handoff/Run) and receives the current display event set.
`deriveChatSources()` builds four compact sections:

- **Files** — user attachments and image URLs.
- **Apps & tools** — MCP servers/plugins/connectors, grouped by app identity
  with the distinct actions summarized once.
- **Web** — search queries and result URLs/titles/snippets.
- **External resources** — HTTP(S) links and resource URIs found in MCP
  metadata/results, including Linear issue context.

The derivation is bounded and recursive only for JSON-shaped tool results,
deduplicates by canonical path/URL/source id, and excludes the internal
`node_repl` execution host. A row is clickable only for an allowed HTTP(S)
URL and opens through `openUrlInAdeBrowser`; local paths remain informational.
The main transcript separately keeps web, image, MCP/connector, and subagent
lifecycle compact across Codex, Claude, Cursor, Droid, and OpenCode adapters.

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

The drawer is mounted only when lane tool drawers are visible on the
chat surface. Work-grid tiles pass `hideLaneToolDrawers` because the
Work sidebar owns lane-scoped tools there; chat headers no longer expose
a separate Terminal shortcut. Other chat-owned terminal creation paths
still reveal the matching drawer tab through the shared
`revealCreatedTerminal` flow.

## Pending input card

The ask-question surface is **anchored in the composer**, not in the
transcript. `AskQuestionComposer` replaces the composer textarea inside the
same prompt-box frame — same border, radius, and width — so nothing shifts when
the question resolves back into a textarea. (There is no longer a separate
`AgentQuestionModal`, no `InlineQuestionRequestCard`, and no question-kind
`pendingBanner`: that banner sat on a composer `composerInputLocked` had
already hard-locked, so the composer was dead *and* wearing a sign saying so.
`plan_approval`, `model_selection`, `approval`, and `permissions` keep their
banners — they render real controls.)

The transcript keeps only the record: `OpenQuestionReceipt` while the gate is
open (which is also where a *queued* second question waits until it becomes the
composer's primary gate), and `AnsweredQuestionReceipt` once it resolves.

### Answer semantics

`apps/desktop/src/shared/pendingInputAnswers.ts` is the contract. Four states
per question — `EMPTY`, `PICK`, `PICK_NOTE`, `NOTE` — and five rules:

1. **Both travel.** A note never replaces a selection; a selection never clears
   a note.
2. **Typing never deselects. Selecting never clears the note.**
3. **Selection values come first**, note last, so a model reads the choice
   before the qualification.
4. **The Send label is the payload receipt.** `sendLabel` is derived from the
   state and nothing else (`Send 1`, `Send 3 picks`, `Send 1 + note`,
   `Send note`, `Send N answers`). If the label and the payload can disagree,
   the implementation is wrong.
5. **Multi-question:** Send is enabled only when every question is answered.

The note row's placeholder says which of its two jobs is live: `Your answer`
when the question has no options, `Or send your own response instead` when
nothing is picked, `Add a note (sent with your pick)` once something is. No
disabled state, no mode switch.

This module previously did not exist and the four surfaces disagreed: desktop
sent both as an array, the TUI let typed text *replace* the selection, and iOS
silently dropped the note once more than one question was in play. No provider
forces any of it — Claude's `question.reply` takes `answers: string[][]`, ADE's
own `askUser` tool returns free-form JSON, and Droid takes a single string ADE
joins itself (now via `flattenAnswerForSingleStringProvider`, which labels the
note rather than comma-joining it into the picks).

### The three defects this shape fixes

- **Hidden mode switch.** `handleOption`'s `submitSingle` branch submitted
  immediately on click for a single single-select question — *unless* the
  freeform field held text, in which case the same click only selected. One
  gesture, two outcomes, no signal. Select marks now; `Next` / `Enter`
  advances.
- **Hover-reflow jitter.** Options set `onMouseEnter → setFocusedOption`, which
  swapped the preview, which changed the card's height, which made the
  virtualizer re-measure and `reconcileMeasuredScrollTop`, so the row walked out
  from under the cursor and the click landed on its neighbour. **Hover mutates
  no state.** Previews open on their own disclosure control, which neither
  selects the option nor advances the question. The option region is
  natural-height and capped: explicit disclosure may grow it once, while hover
  and focus cannot trigger any reflow.
- **Unbounded height.** Only the option list scrolls; header, note row, and
  footer are pinned outside it, so Decline / Next / Send are reachable at any
  list length. Rows that fall fully below the fold get a `⌄ N more options` row
  **on its own line** — floating it over the list would let it cover a row the
  user meant to click, and a shadow alone is deniable (a list that cuts cleanly
  after option 4 reads as "there are four options").

**Height budget (desktop).** `useOptionsMaxHeight` measures
`[data-chat-appearance-root]` — the flex column holding the transcript *and* the
composer — and gives the option list `clamp(260, height * 0.55, 520)`. The
260px floor keeps the normal three-option case, including one disclosed
preview, out of a cramped inner scroller; long lists still scroll with the
footer pinned. Budgeting from that column rather than the transcript viewport
is load-bearing for the same reason it is on iOS
(`workPendingInputMaxHeight`): the column's height does not change when the
card grows, the viewport's does, and feeding the viewport back in is a runaway
loop that eats the screen.

**Minimize.** A `⌄` beside the `×` folds the card to one line inside the prompt
box (provider mark · `{header} — {question}` · `N/M` or `ANSWER` · `⌃`) so the
transcript can be scrolled freely. It does **not** dismiss and does **not**
unblock — the gate stays open, and picks survive the fold. `×` remains the
decline; the two affordances must not be merged. iOS already ships this as
`pendingInputCollapsed`; both share the summary string (`foldedSummary`).

Anatomy:

Anatomy:

- **Header** — the provider mark (`ProviderLogo(source)`) plus a kind-derived
  verb from `pendingInputHeaderLabel(source, kind)`: `{Provider} asks` for
  questions, `{Provider} · Plan ready` for plan approvals. No clock icon and no
  generic "Question from {provider}" title. For paged sets a **dot rail** sits
  on the right (filled = current, green = answered) and jumps between
  questions; `N / M` lives in the footer. Then the minimize `⌄` and the decline
  `×`.
- **Body** — the question's short `header` renders as a kicker, then the
  question text exactly **once**. A request-level `description` only renders
  when it differs from the question text, so it never duplicates the question.
- **Options — a ledger.** One column always, never a 2-col grid (three options
  in two columns leaves a ragged orphan). A hairline between rows and nothing
  else: no per-option border, fill, radius, or radio glyph. Selection is a `✓`
  flush-right; the leading number stays constant. Rows carry
  `role="radio"`/`"checkbox"` in a `radiogroup`/`group` container, support
  multi-select, and show a quiet `Recommended` label. Nothing is preselected.
- **Previews** — `QuestionOptionPreview` (in `questionOptionPreview.tsx`) is
  format-aware: wireframe/ASCII content (detected by `looksLikeWireframe`, or
  `previewFormat: "html"`) renders in a column-preserving monospace `<pre>`
  (`white-space: pre`, horizontal scroll), and prose markdown routes through
  the shared code-fence-aware `ChatMarkdown`. This replaced a bare
  `ReactMarkdown` that collapsed ASCII alignment. Previews live inside the
  capped option region. The closed state stays natural-height with no blank
  preview reserve; an explicit disclosure may grow the composer up to the cap,
  after which only the option region scrolls. When ≥2 options carry previews,
  a `⇄ Compare` toggle shows two side by side.
- **Keyboard-first** — `1-9` pick, `↵` next/send, `←→` page between questions,
  `esc` declines. Digits typed into the note field are never hijacked.
- **Accent** — chrome uses `var(--chat-accent)`, which the chat surface sets per
  provider, so the card is amber for Claude, warm-white for Codex, violet for
  Cursor/Droid, blue for OpenCode (and honours the neutral-chrome preference).
  The tint count is deliberately **two** — the header mark and the selected `✓`
  — plus one structural use: a hairline top border on the composer meaning "you
  are in answer mode". Not a glow, not a fill. The same accent treatment is
  applied to `ChatProposedPlanCard`.

Responses are sent back via `ade.agentChat.respondToInput` (accepts
`AgentChatRespondToInputArgs` with structured `answers`; values may be
`string` or `string[]` for multi-select, plus an optional `decision`).
Legacy `ade.agentChat.approve` is still supported. Plan approval cards
receive the plan text from the `ExitPlanMode` tool input so the UI shows
meaningful content rather than a generic label.

Codex app-server `mcpServer/elicitation/request` uses the same contract.
Form-mode JSON Schema properties become paged questions (enum/oneOf,
boolean, freeform primitive, and multiselect array); answers are coerced back
to the schema before ADE replies. Approval/URL mode shows **Allow once** and
**Deny**, an **Open authorization** action only for safe web URLs, and
**Always allow** only when `_meta.persist` includes `always`. Provider
full-auto mode does not auto-answer these app/connector consent requests.
`serverRequest/resolved` emits the usual resolution event so a request
completed outside the card cannot leave the composer locked.

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

**Height budget (iOS).** The strip is capped so a gate can never claim the
whole page. `workPendingInputMaxHeight(chatSurfaceHeight:)` (in
`WorkChatSessionView.swift`) returns
`max(160, min(available * 0.82, chatSurfaceHeight * 0.62))` where `available`
subtracts a fixed 110pt composer reserve. The input is `chatSurfaceHeight =
max(240, scrollViewportHeight + composerLayoutHeight)`, **not** the transcript
viewport: the transcript and the composer inset split the same surface, so
their sum is invariant to how the two divide it, while the viewport alone
shrinks as the card grows — feeding that back in was a runaway loop where the
card ate the screen. The composer reserve is a constant for the same reason;
`composerLayoutHeight` already includes the strip being sized, so measuring it
would be circular. Inline-in-transcript question cards use the separate
`workInlinePendingInputMaxHeight(transcriptViewportHeight:)` rule
(`max(240, viewport * 0.62)`) because the composer sits below that viewport
either way and there is nothing to reserve for.

The card's own arithmetic subtracts its measured top/bottom chrome plus named
`cardPadding` / `cardStackSpacing` constants from that budget and floors the
scroll region at 64pt — roughly one option row. On a small phone with the
keyboard up the irreducible chrome can still exceed the budget; the overflow is
absorbed by the transcript, not the composer, because the composer inset is
`fixedSize(vertical:)` and the transcript scroll view is the flexible sibling.
That view ordering is the actual guarantee that Send/Decline stay on screen;
the number only keeps the common case from getting there.

**Minimize (iOS).** The strip header carries a chevron that collapses the card
to a one-line pill showing the provider mark, a content-derived summary
(`workPendingInputCollapsedSummary` — the question header, plan title, or
`Permission: <tool>`, never a generic "1 request"), the queued count, and an
expand chevron. The gate stays open and the composer stays locked; only the
card is swapped out, so the user can scroll the conversation for the context
the question needs. State is a `collapsedPendingInputId`, with the boolean
derived from it — a minimize applies to the gate the user chose to defer, so it
must expire the moment a different gate becomes primary, and deriving makes
that impossible to get wrong. A keyboard `Done` toolbar item (gated on the
freeform field actually holding focus, because a toolbar declared
unconditionally would surface over the main composer's keyboard and silently do
nothing), a footer dismiss button, and interactive scroll-to-dismiss are the
three ways back out of the keyboard.

**Draft persistence (iOS).** Mobile keeps unsent text the way desktop does.
`WorkComposerDraftStore` persists each chat's composer draft under
`chat:<sessionId>`, plus fixed keys for the Hub inline composer and the Work
New Chat composer; `WorkQuestionDraftStore` persists a still-open question's
selections, per-question freeform, shared freeform, and page index under the
request id, so backing out of the chat to check the transcript — the exact
reason a user minimizes the card — no longer discards what they picked. Both
autosave on a 400 ms debounce and flush on disappear, because a cancelled
`.task` throws out of its sleep before the write and a navigation pop is
precisely the case the debounce misses. Send clears the stored draft
**synchronously** rather than waiting out the debounce: a jetsam inside that
window would otherwise restore an already-sent message into the composer, where
it reads as unsent and invites sending it twice. Two deliberate exclusions:
answers to `isSecret` questions are never written (the backing store is App
Group `UserDefaults`, shared with the widget extension, so that would put a
credential on disk in plaintext), and unpair does not clear the stores (its only
production trigger fires automatically on an attributed auth failure, and the
stores are keyed by session, not by host, so clearing would destroy unsent text
for every other paired machine).

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
  summaries, and re-exports the shared scheduled-work derivation.
- `apps/desktop/src/shared/chatScheduledWork.ts` -- scheduled-work
  snapshots from `scheduled_work_update` envelopes.
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
- **Empty-state hero column.** The new-chat hero column in
  `AgentChatPane` lives in an `overflow-hidden` wrapper and caps itself
  with `max-h-full`, so exactly one row — the ADE logo — may be
  flexible; every sibling (heading, lane pill, inline composer, extras)
  must be `shrink-0`, and the logo keeps a `min-h` floor so it shrinks
  instead of the column overflowing and clipping top and bottom in a
  short window. The optical lift is wrapper padding, not a negative
  margin on the column: a negative margin escapes the `max-h-full` cap
  and reintroduces the clipping.
- **Session creation and first turn race.** When a new session is
  created from the composer, the pane awaits the `onSessionCreated`
  callback and the session-list refresh before sending the first agent
  turn. Skipping this wait renders a blank "new chat" screen because
  the parent surface has not yet navigated to the chat tab.
- **Model warmup on selection.** Selecting a Claude model triggers
  `ade.agentChat.warmupModel` to preload a V2 session. If the warmup
  promise is never awaited, the first turn incurs a 20 s latency.
- **Reasoning slider pointer ownership.** The track captures a drag only
  after the small movement threshold, writes preview positions through CSS
  custom properties, and commits exactly once on pointer-up. Ridge-button
  clicks take the normal radio path; a drag that starts on a ridge suppresses
  the trailing synthetic click so it cannot toggle the newly snapped tier
  back to Auto. Do not close the Radix popover from `onChange` — outside click
  and Escape are the intentional close actions.
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
- **Chip selection marking must stay cheap.** `selectionchange` fires on every
  caret move on the Work tab's hottest input path, so the chip-highlight effect
  in `AgentChatComposer` holds five constraints together: the document listener
  exists **only** while the editor is focused *and* actually holds a chip; a
  collapsed caret costs one boolean (it returns early unless an earlier
  selection left marks behind); every DOM write is coalesced into a single
  `requestAnimationFrame`; all queries are scoped to the editor element, never
  the document; and because chips are inserted/removed by direct DOM writes
  rather than React renders, a `MutationObserver` watches the editor's
  **structure** (`childList` + `subtree`) and never its character data, and only
  while the editor is focused. Widening any of these — a permanently attached
  listener, a document-wide query, or a `characterData` observer — puts work on
  every keystroke of every chat.
- **Smart-link presentation is not prompt storage.** The chip label, remote
  title, and favicon are presentation only. Preserve the full URL in
  `data-composer-chip-text` and in the controlled draft; reconciliation must
  never replace sent text with a compact label. Metadata failures are expected
  and must degrade to the deterministic provider label or complete URL.
- **Chat event identity is never the sequence number alone.**
  `eventSequence` is a runtime counter, but the transcript it numbers is
  durable and appended across desktop restarts, so a rehydrated session
  that restarts at 0 mints sequence numbers the file already contains —
  one transcript can hold two events numbered 67, hours apart. Any
  consumer keying identity on `sessionId + sequence` then mistakes the
  newer event for a replay of the older one and drops it. Both halves of
  the fix are load-bearing. Host side,
  `readTranscriptHydrationState` (`agentChatService.ts`) seeds
  `managed.eventSequence` from the transcript's max sequence in the same
  pass that recovers todo items — one pass, because the transcript is
  not cached — so sequences stay strictly increasing for the life of the
  file. Client side, iOS's `AgentChatEventEnvelope.id` includes the
  timestamp (`sessionId:timestamp:sequence`), so a genuine redelivery
  (same timestamp *and* sequence) still collapses while cross-epoch
  collisions do not. On a real 425-event transcript the old key destroyed
  103 events, including two `approval_request` envelopes carrying whole
  AskUserQuestion cards and 31 short text chunks (short text has no
  content dedupe key of its own — that requires >= 24 characters — so it
  fell through to the sequence-derived id). Blocking gates additionally
  get itemId-based content dedupe keys in
  `SyncService.chatEventContentDedupeKey` (`approval_request`,
  `structured_question`, `pending_input_resolved`): a dropped gate is a
  question the user never sees and can never answer, so it must not
  depend on sequence uniqueness at all.
- **`isAskUserToolName` deliberately does not match `AskUserQuestion`.**
  For Claude's own ask-user tool the host emits *both* a `tool_call` (keyed
  by the SDK tool-use id) and a separate `approval_request` (keyed by a
  fresh `randomUUID`). iOS's `derivePendingWorkInputs` dedupes by item id,
  so adding `askuserquestion` to that name list produces two cards for one
  question — and the `tool_call`-derived one is unanswerable, because the
  host has no approval registered under that id and discards the response
  silently. The `tool_call` branch exists only as a fallback for hosts that
  emit a bare ask-user call with no wrapping approval.
- **Question drafts persistence.** Question answer state (selected
  options + notes) is local to `AskQuestionComposer` on
  desktop. If the user navigates away and back, drafts reset. Minimizing the
  card does *not* reset them — folding to read the transcript is a normal step
  in answering, so picks survive it. This is
  intentional to avoid stale answers leaking across sessions. iOS makes
  the opposite call for the same surface — see
  [Cross-surface parity](#cross-surface-parity) — because minimizing the
  card to read the transcript is a normal step in answering it there, not
  a session change. The card's one-time focus
  and entrance animation are guarded by module-level sets
  (`focusedQuestionCardKeys` / `enteredQuestionCardKeys`) so the
  virtualized list re-mounting the row mid-scroll doesn't re-steal focus
  or replay the fade.
- **Terminal drawer tab lifecycle.** PTY exit must trigger tab removal,
  and the last-tab-removed condition must collapse the drawer; the
  `ChatTerminalDrawer` state machine is the canonical source.
- **Virtual-scroll offset drift.** The hand-rolled virtualizer is
  sensitive to changing row heights (plan approval cards, work-log
  expansion, expanding a collapsed user message). The spacer heights are
  computed from the `measuredHeights` map, so a row that resizes above
  the viewport desyncs the spacer math from `el.scrollTop` unless
  `handleMeasure` → `reconcileMeasuredScrollTop` compensates. The map is
  keyed by stable row keys; rolling back to an unstable key causes the
  list to "jump" on updates. Sticky-bottom
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
