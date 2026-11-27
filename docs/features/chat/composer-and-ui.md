# Composer and Chat UI

The chat UI lives in `apps/desktop/src/renderer/components/chat/`: a pane
(`AgentChatPane`), a message list (`AgentChatMessageList`), a composer
(`AgentChatComposer`) and side panels (tasks, scheduled work, file changes,
subagents, computer use). The pane derives what it shows from the
`AgentChatEventEnvelope` stream and session metadata.

## Source file map

Unqualified files are in `apps/desktop/src/renderer/components/chat/`.

| Path | Role |
|---|---|
| `AgentChatPane.tsx` | The top-level pane: IPC, session state, presentation profile, lane navigation, parallel launches, sub-panels and composer. Reads the last-viewed time (`ade.chat.lastViewed.v1:<sessionId>`) for the list's `unreadSince` divider. Owns draft state (`ade.chat.composerDraft.v1`, keyed per session or lane draft; `draftContextTargetId` lets the Work sidebar target an unsaved draft), pending-steer Edit (`cancelSteer({ requireQueued: true })`, unchanged draft when the message already left), and root-store `DraftLaunchJob`s (`creating-lane` → `starting-session` → `sending-prompt` → `ready` / `failed`) that survive a project switch: the launch chain pins every call to the originating binding and caps each step at 90 s. Brain-owned launches clear the composer at job start; a foreground chat from an existing lane keeps the prompt until the new pane's first bubble takes it. Also owns the transcript-resilience rules ([Transcript and turns](transcript-and-turns.md#history-snapshots-scroll-back-and-misses)): `resolveChatHistoryMissAction`, `resolveSnapshotHistoryCursor` (`hasOlderHistory` beats `tailStartOffset`), retries at 800 / 2400 ms, `syncPendingBySession` (`data-chat-sync-pending`, a fading 2 px hairline), the cold skeleton (`data-chat-cold-skeleton`), and `resolveRenderedChatSessionId` (paint from props, not the synced id). The view cache holds 128 MB total, 32 MB per session, and skips a **detached** view. Active-turn recovery is a stall detector (`ACTIVE_TURN_RECOVERY_INTERVAL_MS`, 10 s, skipped when the subscription delivered). Hidden panes hand their subscription to `chatSessionRetention.ts`. An empty draft reserves no side pane. |
| `useDraftMachineRouting.ts`, `draftAttachmentTransfer.ts`, `draftAttachmentSources.ts` | Draft machine selection: reconcile the restored machine before send, list only that machine's lanes plus auto-create, re-resolve the lane on a switch (`remapDraftLaneToMachine` / `findPrimaryDraftLane`), and hold a foreign machine behind `Loading lanes for <machine>…` (`laneCatalogLoading`, `requestCrossMachineLanesForMachine`). On a user machine switch, `useDraftAttachmentTransfer` keeps image URLs and re-stages what it can (kept bytes or paths through `saveTempAttachment` / `stageFileAttachment`; images through pinned `getImageDataUrl`). Other files and machine-bound context stay behind with an amber notice. A pending or failed transfer blocks send. |
| `components/usage/ActivityModule.tsx`, `ActivityHeatmap.tsx`, `activityIntensity.ts` | The activity module under an empty Work draft (`WorkActivityModule`, compact; `data-chat-empty-usage`; tab and range in `ade.activity.module.v1`). `scoreActivityDays` scales each of seven dimensions against its own maximum before the weighted sum; `isActiveDay` stays unweighted; `describeActivityInsight` writes the one sentence above the grid from the same scores. Buckets are quartiles over non-zero days. The ramp is explicit light/dark pairs (never `--color-accent`), with tile borders under `prefers-contrast: more` (`usePrefersMoreContrast.ts`) and a "Less → More" key. |
| `renderer/lib/draftLaunchJobs.ts` | Draft-launch job DTOs, stale detection and pruning (active rows first, at least one terminal row kept); `DRAFT_LAUNCH_TIMEOUT_MS` (90 s) + `withDraftLaunchTimeout` (unwedges the renderer; the IPC keeps running); `LAUNCH_PROJECT_CHANGED_MESSAGE` for unpinned launches; the new-draft request count that keeps a late launch from taking the screen back. |
| `renderer/state/chatLaunchStore.ts`, `state/useChatLaunchSync.ts` | Renderer mirror of brain-owned launches (`shared/types/chatLaunch.ts`), keyed by launch id with their binding; snapshots only move forward (`mergeChatLaunchSnapshot`), and the host's first answer replaces the optimistic one. Holds the window's `originClientId` and a local record per launch it started. `useChatLaunchSync` (in `AppShell`) is the one `chatLaunch.onEvent` subscription, hydrated by `chatLaunch.list`. A list replaces its binding's acknowledged launches, except a launch first acknowledged after the list was sent (`chatLaunchAckMark`, a counter, not a clock): a list to another machine also waits on a cloud read, so the `start` reply can beat a list the host answered before it registered the launch, and dropping it would hide the new chat's row and open pane until that machine lists the chat. Narrow selectors: `useChatLaunchRowSources`, `useChatLaunchForPane`, `useChatLaunchSelector`. |
| `launch/` (`chatLaunchActions.ts`, `LaneSetupCard.tsx`, `LaunchProgressRail.tsx`, `launchClock.ts`, `chatLaunchSynthetic.ts`, `chatLaunchDock.ts`, `chatLaunchDraftRestore.ts`, `useChatLaunchPaneState.ts`, `newLaneLaunchArgs.ts`, `rendererOwnedLaunch.ts`) | The launch surfaces: every Start/Retry/Start now/Cancel/Delete/queue (pinned to the launch's binding); the setup card and its `lane_setup` row; the stand-in roster row, prompt bubble and queued messages of a pending chat; the composer dock and first-message flight (skipped for reduced motion, hidden windows and high resource pressure); the one draft-restore channel back to Work; the pane's launch seam; `chatLaunch.start` args; and the renderer-owned chain (existing lane, Cursor Cloud, runtimes without `chat.startLaunch`). |
| `renderer/webclient/adapter/chatLaunch.ts`, `renderer/webclient/sync/chatLaunchEvents.ts` | Hosted-web `window.ade.chatLaunch` over the `chat.startLaunch` … `chat.completeLaunchClient` commands (writes skip the read cache; an older host rejects so the composer falls back), with `chat_launch_event` decoded by `decodeChatLaunchEventPayload`. |
| `components/app/ChatLaunchesSlideOut.tsx`, `components/terminals/useChatLaunchCliDriver.ts` | The Launches slide-out, and the driver that starts this window's CLI launches at `awaiting-client`. |
| `renderer/lib/handoffLaunchJobs.ts` | Handoff placeholder DTOs, ids, labels and search, shown in the Work sidebar (`TerminalsPage`). Fork is offered when `providerSupportsHandoffFork` (Claude, Codex, OpenCode, Droid, Cursor); Cursor's fork replays the transcript (`providerForkReplaysTranscript`). |
| `renderer/lib/chatHandoffIntent.ts` | One-shot bridge from the session menu's **Hand off…** (`SessionContextMenu.tsx`, `openChatHandoff`, `"local"` \| `"remote"`) to the pane; only the active tile drains it. |
| `renderer/lib/aiDiscoveryCache.ts` | AI status and model cache per runtime binding (local and remote copies never share). `getAiStatusCached`: 10 s freshness, deduplicated `ade.ai.getStatus`, change events instead of polling. A chat pane reads its chat machine's status (by the chat's pin) when it shows, when a turn starts and ends, and when the chat moves; and past this cache on that machine's `providerLogins.onChanged` (an ADE Cloud computer applies the account's sign-ins about 30 s after ADE starts, so a read before that says "no login"), on a new connection to it (a wake), and at the end of a turn while the status says the provider cannot run. So the "<Provider> runtime" banner cannot outlive the sign-ins that fix it. |
| `CrossMachineHandoffModal.tsx`, `crossMachineHandoffPresentation.tsx` | **Continue on another machine**: destination, brief or fork, model, effort, Fast, permission, note and clone choice, then `startCrossMachineHandoff`; the source brain runs it (`crossMachineHandoffOrchestrator.ts`). Options (`getCrossMachineHandoffOptions`), a read-only preview (`previewCrossMachineHandoff`) and progress come from that brain. Every call, including **Publish branch** / **Update branch** (`git.push` / `git.pull`), is pinned to the source chat's `runtimePin`. Blockers render through `BlockedReasons` / `BlockedActionButton`; Send is the confirmation. |
| `ChatHandoffDialogs.tsx` | The **Local handoff** Radix dialog (fork/brief form, or "Handoff is not available for this chat."). Popovers inside stay clickable through `PortalContainerContext`; Escape closes an open lane list first. |
| `ProviderSignInCard.tsx`, `ProviderSignInSlot.tsx` | The sign-in card above the prompt box (`aboveComposerSlot`) while the provider is signed out on the composer's machine. See [README › Inline agent download, and the sign-in card](README.md). |
| `ChatRuntimeScope.tsx` | Which machine THIS chat is on: `useChatRuntimeScope()` (`{ pin, binding, laneId, lane, laneWorktreePath, rootPath, isRemote, machineName, online }`), `useChatRuntimeScopeForPin`, `useChatScopeDerivation`, `ChatRuntimeScopeProvider`. `pin === null` means only "the tab's binding". ESLint bans tab-store reads of `projectBinding` / `lanes` / `project.rootPath` and `selectActiveProjectRoot` in `components/chat/**`. `chatRunsOnThisComputer(scope)` hides this-computer actions (Scene **Proof**, Codex image **Open**) on a foreign chat. Contract in the chat [README](README.md#source-file-map). |
| `AgentChatMessageList.tsx` | The virtualized message list; see [Message list](#message-list). Also `WorkingIndicator` (`<activity> · working for <elapsed>`, labels from `resolveWorkingIndicatorLabel` / `ACTIVITY_LABELS`, a file-named `Editing …`, a `tool_calling` / `running_command` wait named from the newest running entry (`Running pnpm test`), a callback ref for the imperatively written timer) and `ChatInfoHostContext` (whether the host listens for `ade:chat:open-info`; a context, not a global, because every pane stays mounted). |
| `AgentChatComposer.tsx`, `ComposerDrafts.tsx`, `DraftSchedulePopover.tsx`, `ComposerSmartLinkMenu.tsx`, `smartLinkChipMark.ts` | The composer: input, attachments, model and permission controls (`PermissionModePickerOption` tables for the shared `PermissionModePicker`), slash commands, drafts and scheduled sends, smart-link and chat-context chips (`<ade-chat-context>`), pending input, dictation target, parallel slots, send and stop menus. One-shot open requests reach the ModelPicker (acknowledged, so a remount does not reopen it) for transcript recovery cards. See [Composer](#composer). `launchPromptClipboardNoticeEnabled` controls the reminder text, separate from `launchPromptClipboardEnabled`. |
| `main/services/chat/draftService.ts`, `draftDelivery.ts`, `draftScheduler.ts` | Runtime drafts and scheduled sends in the CRR `prompt_stashes` table (name kept; cr-sqlite cannot rename a CRR): text, up to ten image references, origin site, captured config, and an armed send's time, target and if-late policy. Plain drafts cap at 20; armed sends at 50, delivered by the target chat's machine through an exactly-once `scheduled` → `sending` claim. Local image bytes stay on the origin, protected from the seven-day attachment cleanup. |
| `TurnFailureLine.tsx`, `turnFailureRows.ts` | A failed turn is one line: glyph, title, `×N` for folded retries, **Retry** / **Details**. `foldTurnFailureRows` drops usage-limit error rows (the turn-end reads `Usage limit`) and folds identical retries. |
| `UsageLimitChip.tsx` | The status-row chip: `Usage limit reached`, a **Cancel** / **Resume in …** toggle, and **Continue on <account>** when another account has room; pinned actions. |
| `usageLimitResumePresentation.ts` | Pure usage-limit copy: `parseUsageLimitResume` (strict reader), countdown cadence (seconds round up, as iOS), `usageLimitResumeRowStatus`, `usageLimitTurnFooterLabel`, `isUsageLimitFailureText`. Clock-injected; nothing reads `Date.now()`. |
| `chatTurnState.ts` | Turn-state helpers for live and hydration paths: terminal transcript evidence beats a stale summary; failed-turn retry finds its non-steer user message without a provider turn id. |
| `ChatActionsDrawerPanel.tsx`, `ChatSourcesPanel.tsx`, `chatSources.ts` | The progress drawer (sections appear once they have content) and Sources (deduplicated files, web queries, MCP tools and URLs; safe web rows open in ADE's browser). |
| `VoiceDictationButton.tsx`, `microphonePermissionGuidance.ts`, `renderer/services/globalVoiceRecorder.ts`, `components/voice/*`, `main/services/transcription/microphoneAccess.ts` | Dictation. The module-level recorder survives navigation, transcribes through `window.ade.transcription`, inserts into the registered composer and always copies the text. Windows denied/restricted mic states get Privacy & security guidance; unknown states go to Chromium's prompt. |
| `main/services/transcription/*` | Transcription: 16 kHz mono WAV through the bundled `transcribe-cli` and the downloaded Parakeet Ultra model, then glossary cleanup. Threads cap near the physical core count. `downloadModel` is single-flight. After install, one silent warm-up (`stage: "warmup"`, "Finishing setup"); a failed warm-up still leaves the model installed. |
| `CodexVoice.tsx`, `VoiceSessionCard.tsx`, `main/services/chat/codexVoiceSession.ts`, `codexVoiceNarration.ts`, `codexVoiceHost.ts`, `shared/codexVoice.ts`, `components/settings/VoiceConversationSection.tsx` | Voice conversations; see [Voice conversations](#voice-conversations). |
| `resources/voice/voice-glossary.json`, `resources/whisper/README.md` | The dictation glossary and binary notes; `materialize-whisper-resources.mjs` builds `transcribe-cli` from a pinned commit (git-ignored; the model downloads at runtime). |
| `components/work/useSessionLifecycleSnapshot.ts` | The read behind `ChatLifecyclePill` (settled, snoozed): the Work session cache, then the cross-machine lane snapshot; a render-only timer repaints an expired snooze. Wake now calls `wakeSessionNow` (`sessionLifecycleActions.ts`). |
| `ChatSurfaceShell.tsx` | Floating header, body and footer: tinted, opaque chrome with no `backdrop-filter`, because one on the page makes Chromium on macOS redraw the whole window for every change. `canvasFill` overrides `--chat-canvas-bg` (the Work draft passes `transparent`). On Work, `.ade-chat-shell-header` uses `--ade-work-chrome-rail-h` like `.ade-tool-header`. |
| `ChatComposerShell.tsx` | Composer input chrome. |
| `chatComposerOverlayInset.tsx`, `ChatJumpToLatestPill.tsx` | The composer stack's height and element go through `ChatComposerOverlayContext`; consumers write it to DOM styles (`useChatComposerOverlayInset`, `ChatComposerOverlayClear`), never React state. The jump pill docks in `data-chat-composer-jump-slot` while the chip row shows a chip (`useChatComposerJumpSlot`). |
| `ChatAttachmentTray.tsx`, `ChatAttachmentPreviewModal.tsx` | Attachment tray for the composer and sent messages; see [Attachment handling](#attachment-handling). |
| `renderer/lib/attachmentImage.ts` | `readAttachmentImageDataUrl(path, pin)`, the one image reader (tray, chips, viewed images, drafts, draft transfer): a personal chat's own reader, else the pin's runtime; this computer's `app.getImageDataUrl` only when it owns the file and the runtime gave no final answer. |
| `AttachmentChipPeek.tsx` | `useAttachmentThumbnail` and the hover peek shared by composer and transcript chips: the caller's preview, the URL of an `image-url`, else one pinned read keyed on `pin.key`. |
| `shared/attachmentLabels.ts` | The prompt-attachment grammar for desktop, runtimes and iOS: the k-th image is `[Image #k]` (an `image-url` counts), the k-th file `[File #k: <basename>]` (`[ ] CR LF` become `_`). Tokens resolve by ordinal only; an unmatched token stays text. `formatAttachmentToken`, `labelAttachments` / `labelAttachmentsByRef`, `parseAttachmentTokens`, `resolveAttachmentToken`, `renumberAttachmentTokens`, `formatAttachedImageLegend`. |
| `chatAttachmentStaging.ts` | Staging one file: `readAttachmentStagingMode(pin)` asks once per batch and never throws (`CONSERVATIVE_ATTACHMENT_STAGING_MODE` on no answer). `planAttachmentStaging` forces the bytes leg with no source path (paste, hosted web), a renderer conversion (HEIC → JPEG) or a `base64` host, and then caps at `LEGACY_MAX_CHAT_ATTACHMENT_BYTES`. `stageAttachmentBytesFromFile` is that leg (with `holdOnDevice` it keeps the bytes here instead); `AttachmentConversionError` gets no retry. |
| `heldChatAttachments.ts` | Files attached while the chat's ADE Cloud computer rests, kept on this device under `ade-held:` stand-ins until the send copies them (`stageHeldAttachments`). See [Attachments](#attachments). |
| `deviceHeldSend.ts` | `prepareDeviceHeldForSend`: right before a send, copies the files and hands over the comments this device kept while the chat's computer rested, the way the send reaches it. |
| `useProviderStatusRefresh.ts` | The pane's provider-status re-reads past the 10 s cache: when the chat's machine applies sign-ins (`providerLogins.onChanged`, pinned), on a new connection to that machine, at the end of a turn while the provider can't run, and when the chat's pin key changes. Keyed on `pin?.key`. |
| `shared/chatAttachmentLimits.ts` | The ceilings and messages for renderer, main and the CLI sync host: `MAX_CHAT_ATTACHMENT_BYTES` (50 MB, files), `LEGACY_MAX_CHAT_ATTACHMENT_BYTES` (10 MB, base64 in a payload; 720 KiB frames under 25 MB over sync), `MAX_PROVIDER_INLINE_FILE_BYTES` (10 MB), `MAX_PROVIDER_INLINE_IMAGE_BYTES` (3.5 MB), `MAX_PROVIDER_INLINE_IMAGE_EDGE_PX` (2000 px). Messages render from the constants (`formatAttachmentSize`, `legacyAttachmentCapMessage`, `attachmentTooLargeMessage`). `maxBase64EncodedLength` refuses an oversized payload before decoding (`approxDecodedBytes`). |
| `shared/chatAttachmentStagingFs.ts` | The Node-only write rule for `<projectRoot>/.ade/attachments` (UUID name, checked extension, containment, stat before copy); contract in the chat [README](README.md#source-file-map). Local Cursor may Read these and its own `~/.cursor/projects/<slug>/assets` copies. |
| `attachmentViewerTarget.ts` | Finds an attachment's Files workspace on the client, pin-aware: both separators, segment compare through `normalizePathForComparison` (`/a/ADE-backup` never matches `/a/ADE`), the longest root wins. |
| `ChatCommandMenu.tsx` | The `/`, `@` and `#` menus; see [The command menus](#the-command-menus). |
| `shared/composerTriggers.ts` | Cursor-relative trigger detection for the desktop composers (iOS mirrors it): `detectComposerTrigger(text, cursorPos)`, `replaceComposerTriggerSpan`, `findConfirmedComposerTokens`, `composerTriggerSpansWholeDraft`, and dismissal (`ComposerTriggerDismissal`, `isComposerTriggerDismissed`); see [The command menus](#the-command-menus). |
| `shared/smartLinks.ts` | The URL catalog and fallback labels (GitHub PR/issue/repo/commit/run, Linear, `ade://`, HTTP(S)); trims punctuation and caps a draft at 12 matches. iOS mirrors it (`WorkSmartLinkDetector`). `ade_deeplink` URLs go through the real `deeplinks.ts` parser, so `ade://pr/…` becomes a PR chip. |
| `main/services/chat/smartLinkPreviewService.ts` | Best-effort metadata: GitHub and Linear through their services; generic pages through bounded reads with DNS pinning and SSRF checks, cached (256 entries, 30 min; 5 min for misses). Credential-backed results are never cached. Errors return the local preview. |
| `shared/chips.ts` | The one chip model (iOS re-implements it against a shared fixture). `Chip` is `{ kind, token, label, detail?, title?, iconDataUrl?, source }`: `token` is canonical text, `label` display only. `parseChips` / `splitTextIntoChipParts`, the producers `chipFromPath` / `chipFromMention` / `chipFromDeeplinkTarget` / `chipFromSmartLink`, `chipDisplayLabel`, `CHIP_GLYPH`. Pure: a chip is a pointer. |
| `shared/composerClipboard.ts` | Copy and cut: `text/plain` gets canonical tokens; `text/x-ade-composer` (`COMPOSER_CLIPBOARD_MIME`) adds a label per token, so a chip pastes into another chat as a chip. `parseComposerClipboard` returns `null` on bad input. Bounds: 64 chips, 256 label chars, 100,000 text chars. |
| `shared/pastedTextAttachment.ts`, `shared/composerPasteFolding.ts` | The paste rule desktop and iOS share: `shouldPasteTextAsFile` is true over 3,000 UTF-16 units or 40 lines (CRLF/CR as LF, one trailing newline dropped). `sniffPastedTextExtension`: `.diff`, then `.json`, then `.log` (3+ lines, 60% timestamped), else `.txt`. The file is `pasted-<epoch ms>.<ext>`, labelled `Pasted · N lines` (`pastedTextChipLabel`). `pastedTextAttachmentFile` marks the file in a `WeakSet` (`isPastedTextAttachmentFile`; a dropped file sets `intent: "user_prompt"`). At send, ADE reads the text back into the message. Files, images and small link pastes skip the rule. |
| `shared/sessionDraftIndicators.ts` | `deriveSessionRowIndicators({ hasDraft, queuedCount, queuedSending, queuedFailed })`: up to two marks (draft, then outbox) with label and sentence. |

| `renderer/state/composerDraftPresenceStore.ts` | Which sessions hold an unsent draft, in memory. The draft lives in `localStorage` under `COMPOSER_DRAFT_STORAGE_KEY_PREFIX` (`<prefix>:<projectRoot>:<sessionId>:<profile>:<kind>`). `useComposerDraftPresence(sessionId)` reads one boolean through `useSyncExternalStore`, so a row re-renders only when its own mark flips. |
| `composerChipDom.ts` | `serializeComposerDom(root)`, the one walker from the composer DOM to draft text plus a token→label map, used by send (`serializeRichEditor`) and copy. |
| `ChipText.tsx` | Sent text with tokens as pills (`splitTextIntoChipParts`); `event.text` stays raw. `[Image #k]` / `[File #k: name]` resolve against `event.attachments` (a 14 px thumbnail or file glyph; an unmatched token stays text). Pills enrich from `chipPreviewStore` after a synchronous first paint and open a hover card. |
| `ChipHoverCard.tsx` | The hover card for PR, commit, lane, chat and Linear chips: a `pointer-events-none` `role="tooltip"` portal (not a Radix Popover, which would take focus from the composer), placed by `computeTooltipPosition`. Commit cards read through the chat's pinned Git reader after hover; PRs through `listPrsCoalesced`. Everything resolves on the **chat's** machine (`useChatRuntimeScope()`, `useLanesForPin`, `useMachineEntryForBinding`), because lane ids are unique per machine. Missing data means no card. |
| `chipPreviewStore.ts` | The transcript's cache for `agentChat.resolveSmartLinkPreview`, subscribed per chip through `useSyncExternalStore` (not a context). One request per URL, never throws (a failure caches as "nothing to add"), keyed by URL **plus the project's state key**, so credential-read titles never cross projects. |
| `shared/permissionLadder.ts` | The four autonomy levels; see [Agent Routing](agent-routing.md#the-permission-ladder). |
| `shared/__fixtures__/chipCases.json` | The chip parity fixture for `shared/chips.test.ts` and iOS (`WorkComposerTriggerDetectorTests.testMatchesSharedChipFixture`, read relative to `#filePath`). A new row fails the iOS suite until Swift matches; the `test-ios` gate in `.github/workflows/ci.yml` includes this folder. |
| `ChatTaskListCard.tsx` | The task list (`shared/chatTaskList.ts`): `ChatTaskListCard` (collapsed to `label · done/total · current item`) and `ChatTaskListView`. See [One task list per chat](transcript-and-turns.md#one-task-list-per-chat). |
| `shared/chatScheduledWork.ts` | Folds `scheduled_work_update` into Chat Info schedule rows (Claude wakeups, cron, `/loop`, remote triggers, background work), the Background/Schedule Earlier predicates and next-fire labels. A parent's terminal event does not stop a background row; snapshots whose `sourceTaskId` is a real subagent are left out. iOS mirrors it. |
| `ChatFileChangesPanel.tsx` | Turn file changes from `turn_diff_summary`, with lazy diffs read on the chat's machine. Rows show the lane-relative path (directory truncates first; full path in the tooltip). |
| `RewindFilesConfirmDialog.tsx`, `rewindFilesPreview.ts` | The rewind confirmation: a message-scoped file list from the provider dry run plus diff summaries, per-file diffs, then `rewindFiles`. Diffs and restores use the chat's `runtimePin`. See [Codex rewind](agent-routing.md#codex-rewind-and-0145-readiness). |
| `PendingInputStack.tsx` | The list of open cards when a chat has more than one; see [Subagent cards](#subagent-cards). |
| `ChatSubagentsPanel.tsx` | Chat Info; see [Chat Info and subagents panel](#chat-info-and-subagents-panel). |
| `ChatComputerUsePanel.tsx` | The proof drawer (lightbox, video, states, irreversible delete), read on the chat's machine; no review or reveal controls. Inline proof is `ChatProofFilmstrip` in the message list: a count on the producing turn, open by default. |
| `ChatAppControlPanel.tsx` | App Control for Electron apps, under the composer (`sessionId` set) or in the Work sidebar (`sessionId={null}`). **Control** (screencast, launch/connect, input, `terminal write` / `terminal signal`) and **Inspect** (commits `AppControlContextItem`s). State in `sessionStorage["ade.chat.appControlPanel.<key>"]` (`chat:<sessionId>` or `lane:<laneId>:<projectRoot>`, plus the pin). Connect/launch pass `laneId`; every call uses the `runtimePin`. See [App Control](../computer-use/app-control.md). |
| `ChatIosSimulatorPanel.tsx` | macOS-only iOS Simulator drawer (composer and Work sidebar): readiness checklist, pickers, one live view encoded by the vendored Swift helper on the device's machine (no Simulator.app window, no Screen Recording grant), inspect as a toggle, `IosElementContextItem` output. `useAppleDeviceStream` holds the stream; `AppleDeviceColumn` renders it. `laneId` goes into `iosSimulator.launch`. Another chat owning the simulator only changes where context goes. Scope from `useChatRuntimeScopeForPin`, project root from that machine's worktree. See [iOS Simulator](../apple-device/README.md). |
| `ChatBuiltInBrowserPanel.tsx` | The Work sidebar browser: address bar, tabs, inspect, capture, states from `BuiltInBrowserStatus`; a main-process `WebContentsView` paints the page (`ade.builtInBrowser.setBounds`). Inspect emits `BuiltInBrowserContextItem`s (selector, role, attributes, crop, trimmed HTML, deciding CSS, and `frameworkSource`: React `_debugSource` on the element is exact and fills `sourceFile` / `sourceLine`; other sources are approximate; production builds give none). `ELEMENT_CONTEXT_SNIPPET` (`builtInBrowserService.ts`) redacts secret-looking attributes, values and bodies. Other code opens URLs with `openUrlInAdeBrowser()` (`openExternal.ts`, `ADE_OPEN_BUILT_IN_BROWSER_EVENT`). Calls use the `runtimePin`. **Attach to chat** (tab right-click, or ⋯) goes through `onAttachTab` → `useWorkToolContextInsertion().attachBrowserTab`; a chat gets `ade:agent-chat:insert-browser-tab` and a globe chip (`composerBrowserTabChip.ts`) that serializes `<ade-browser-tab id="…" title="…" url="…">…</ade-browser-tab>` (`shared/browserTabMention.ts`) with the takeover commands (`ade browser claim --tab <id> --text`). `parseChips` reads it back as a `browser_tab` chip. A CLI target gets one pasted line. The URL is the human's, so a tunneled tab shows its remote origin. |
| `ChatTerminalDrawer.tsx` | The chat's terminal drawer, pinned to the chat's machine. `requestChatTerminalFocus` (`chatTerminalFocus.ts`) carries the terminal, so it can show one that ended. |
| `ChatCodeBlockRun.tsx`, `shellCodeBlockRun.ts`, `codeBlockActionButton.ts` | Run on shell code blocks (`planShellBlockRun`, confirm, run store, "Send output to the agent"); see transcript-and-turns.md, "Run on shell code blocks". |
| `ChatGitToolbar.tsx` | The git status strip above the composer. The changed count is **distinct paths** (an `MM` file is in both lists). The PR mark shows only when the lane has a PR and opens the PR Work tool, which refreshes that PR. No manual sync here; it heals through reconcile-on-focus and `prs-updated`. Scope from `useChatRuntimeScopeForPin(runtimePin, laneId)`, because the CLI header renders it with no `ChatRuntimeScopeProvider`. |
| `ChatPrPane.tsx` | The lane PR tool (`variant="tools"`): `PrSwitcherMenu` and the `‹ 1/N ›` `PrSwitcherStepper` for several PRs, stacked detail, or the inline creator. A PR pill elsewhere selects its PR through `chatPrPaneRequests.ts`, held for the named chat. Title bar: ↻ (`prs.syncLanePr`, spinning also for `pr-reconcile`, 300 ms debounce) and ✕ (`onClose`). Cached details first, then a targeted refresh; an unmapped PR (`pr.unmapped`, synthetic `gh:` id) skips it. With no PR it embeds `ChatPrInlineCreator` with the `sessionTitle`; under a `runtimePin` it points at the owning machine. A GitHub stack shows `ChatPrStackOffer` (**Link stack** / **Not now**, per chat and stack). All reads use the pin. |
| `ChatPrInlineCreator.tsx` | The create-PR flow: an immutable source row, a `↓` connector with `N ahead · N behind · clean`/`dirty` (or `comparing…`) from `lane.status`, the `LaneCombobox` target, title, description, Create. The title is the chat title unless it is `New chat`, else `<lane> -> <target>`. `prService` adds Linear words and the deeplink footer. `onCreated` passes the `PrSummary` up at once. |
| `ChatUserMinimap.tsx`, `chatUserMinimap.logic.ts` | The tick rail in the left gutter, one tick per user message, behind `chatUserMinimapEnabled` and `[@media(pointer:fine)]`. Ticks are placed by percentage, with no cap, so index maps 1:1 (`resolveMinimapIndexFromPointer`). One `<button>` for the rail. The hit strip is clamped to the gutter (`resolveMinimapHitStripWidth`, max 40 px) and off at zero gutter. The hover preview shows the message and three lines of the reply, kept on screen by `resolveMinimapPreviewTranslateY`. Compaction events have no tick. |
| `chatPromptHistory.ts` | Prompt history from the selected transcript: ArrowUp starts at the newest; same-direction presses stay in history for 3 s; multiline caret motion resumes after a pause at a line boundary; ArrowDown past the newest restores the unsent draft. Each pick jumps the transcript. |
| `chatSessionRetention.ts` | Keeps a hidden chat's `agentChat.onEvent` subscription for `CHAT_SESSION_RETENTION_TTL_MS` (5 min). See [Retained chat subscriptions](#retained-chat-subscriptions). |
| `chatCompanionUiState.ts` | Which panes a chat had open (`chatActionsOpen`, `iosSimulatorOpen`, `appControlOpen`, `terminalDrawerOpen`, the Apple tools card), in `localStorage` (`ade.chat.companionUiState.<key>`). The chat pane keys by session id, the CLI pane by terminal id. `patchChatCompanionUiState(key, patch)` merges. Old `prPaneOpen` / `chatActionsTab` fields are ignored; `proofDrawerOpen` maps to `chatActionsOpen`. Reads fall back to `DEFAULT_CHAT_COMPANION_UI_STATE`. Each write stamps `savedAtMs` and self-prunes to 200 entries (`pruneChatCompanionUiState`). |
| `ChatProposedPlanCard.tsx` | The plan approval card while input is locked: markdown in a scroll box capped at `min(34vh, 360px)`. Transcript plans use `CodexPlanCard`. |
| `apps/ios/ADE/Views/Work/WorkPlanComposerViews.swift` | iOS plan approval strip above the prompt box, with a markdown sheet; Approve/Reject through `chat.approve` (feedback as `responseText`). One body of the iOS pending-input strip; see [Cross-surface parity](#cross-surface-parity). |
| `apps/ios/ADE/Views/Work/WorkChatComposerAndInputViews.swift` | iOS prompt box, staged-steer strip and `WorkStructuredQuestionCard`: only the provider row (and tabs) is pinned above the scroll area, the field and Send/Decline below. `WorkPendingInputHeightBoundedCard` caps the other gates. Both use `maxCardHeight` and `.scrollDismissesKeyboard(.interactively)`. |
| `apps/ios/ADE/Views/Work/WorkDraftPersistence.swift` | iOS drafts: `WorkComposerDraftStore` (per chat `chat:<sessionId>`, plus Hub and New Chat) and `WorkQuestionDraftStore` (per request), JSON in App Group `UserDefaults` (`WorkDefaultsJSONMap`), LRU by `updatedAt` (60 / 30), autosave after 400 ms (`workDraftAutosaveDebounce`). `workPersistedDraft(_:key:)` restores, autosaves and flushes. |
| `codex/CodexPlanCard.tsx` | The Codex plan card for `plan` events with markdown and no steps (plans with steps feed the task list): Planning / Plan ready, step glyphs, streaming markdown; a details/live toggle when steps exist. |
| `codex/CodexGoalCard.tsx`, `codex/CodexGoalBanner.tsx` | Codex goal card (edits, status and clears through `ade.agentChat.codex.*`; objective, status, tokens, elapsed; no budgets, since goals are unlimited) and a compact banner. |
| `ChatWorkLogBlock.tsx` | Work-log presentation. The transcript renders no `work_log_group` rows. After `done`, `ChatTurnWorkSummary` is one `N tools · M files` line directly above the time/usage row (`4:12 PM · ran 12s · tokens`); expanding lists tools (`ChatToolActivityDetails`) then files between them. The files half is left out when a `turn_diff_summary` exists. `ChatWorkLogBlock` remains for the Settings preview. |
| `AskQuestionComposer.tsx` | The question surface inside the composer; see [Pending input card](#pending-input-card). |
| `QuestionReceipts.tsx` | A question's transcript record: `AnsweredQuestionReceipt` (one expandable line, `AdeCard` convention) and `OpenQuestionReceipt` ("awaiting you"). |
| `shared/pendingInputAnswers.ts` | The answer contract for desktop and web (iOS mirrors it); see [Answer semantics](#answer-semantics). |
| `chatMarkdown.tsx` | The shared agent-markdown renderer (`ChatMarkdown`, `buildChatMarkdownComponents`, `SAFE_PREVIEW_SCHEMA`) for plan cards, previews and other non-transcript surfaces. `ChatMarkdownAnchor`: a workspace path opens through the workspace-path context, a real URL opens in the in-app browser, anything else (a bare `file:`) is inert text. A path must never reach `normalizeBrowserUrlInput`, which would make `laneService.ts` a host. `SAFE_PREVIEW_SCHEMA` allows `file:` and drive letters on `href` because `rehypeSanitize` runs before `urlTransform`; `javascript:` / `data:` / `vbscript:` stay blocked. `chatMarkdownUrlTransform` decodes `C:%5Crepo%5Cx.ts` first. |
| `remarkBareLinkSuffix.ts` | After remark-gfm: puts back a trailing `_` or `~` run that GFM left out of a bare `http(s)://` or `www.` link, only when the source has exactly that run. |
| `chatMarkdownBlock.tsx` | `MarkdownBlock`, the transcript's markdown renderer: prose classes, `react-markdown` overrides, `HighlightedCode` fences, memoized `MarkdownBody`. Runs `remarkThreadEntities` (with `workspaceFilePathOf`) and draws `ThreadEntityNode`; an `ade://` link is a `TranscriptChip`. Headings size from `--chat-font-size`; inline code wraps with `[overflow-wrap:anywhere]`. With `tailMarkdown`, the settled prefix and the growing tail render as two bodies, so only the tail re-parses. `tone="bubble"` forces the neutral palette. |
| `threadEntities.tsx` | Thread-entity chips: `ThreadEntityProvider` builds the lookup from the chat's machine (`useLanesForPin` / `useSessionsForPin`) and slash commands, keyed on value; `remarkThreadEntities` makes `ade-entity` nodes; `ThreadEntityNode` draws a chip, a `file_line` follow-up or a local timestamp. Rules in `shared/threadEntities.ts`. |
| `AssistantTextBody.tsx` | The assistant row's markdown leaf, the only component that renders at 60 Hz while streaming (`useRevealedLength` / `useSplitRevealed`); `paced` is true for at most one row. Writes `data-stream-text-len` during perf runs (`renderer/perf/streamSmoothness.ts`). |
| `textReveal.ts` | The pure paced-reveal machine. `step = min(backlog, max(1, ceil(backlog * elapsedMs / horizonMs)))`; grapheme-safe cuts (`clampToGraphemeBoundary`; no `Intl.Segmenter` disables pacing). `DEFAULT_TEXT_REVEAL_HORIZON_MS = 0` (paint on arrival; a positive `ade.textRevealHorizonMs` turns pacing on), a 250 ms elapsed clamp, a 60 Hz floor, and `advanceSplitScan` / `splitRevealed`, which cut only on a blank line outside fences (`$$` counts). |
| `useRevealedText.ts` | The rAF binding. `useSplitRevealed` gives settled text whole and as append-only `settledSegments`. The loop runs only while paced, enabled, visible **and** on screen (visibility in refs); otherwise everything reveals at once. A row complete at first sight paints in full. |
| `chatWorkspacePaths.tsx` | Workspace-path parsing and the opener context; see the chat [README](README.md#source-file-map). |
| `CodeHighlighter.tsx`, `chatStatusVisuals.tsx`, `chatSurfaceTheme.ts`, `chatToolAppearance.tsx` | Visuals. `ChatStatusGlyph` takes `animate`, so inactive rows skip animation; `ActivityIndicator` turns static after the turn. |
| `pendingInput.ts`, `chatExecutionSummary.ts`, `chatTranscriptRows.ts` | Pure derivations. `pendingInput.ts` is the **only** pending-input derivation (do not add another): `derivePendingInputRequests` (transcript → raw cards) and `resolvePendingInputs` (with the summary → live cards). `countRowsAppendedSince` gives the jump pill's `N new`. |
| `renderer/lib/visualContextFormatting.ts` | Prompt text for attachment, iOS, App Control and browser context. |
| `shared/types/chat.ts` | Composer and session DTOs: `PARALLEL_CHAT_MAX_ATTACHMENTS`, parallel launch types, `AgentChatModelCatalog*`, `AgentChatModelCatalogRefreshProvider`, `AgentChatModelCatalogArgs`. Single-sourced copy: `spawnCompletedNoticeMessage(childTitle)` and `waitingOnYouDescription(count?)` (`Waiting on your answer(s).`, also the Notch subtitle, push body and lock-screen text). `approval_request` can carry `requestKind`; see [Approval vs question](#approval-vs-question). |
| `components/shared/ModelPicker/` | The ModelPicker; see [ModelPicker structure](#modelpicker-structure). `ReasoningEffortPicker.tsx` is the segmented effort track, open after a pick. |
| `components/shared/PermissionModePicker.tsx` | The one permission pill for the composer, `SessionLaunchModelControls` and the handoff modal: `PermissionModePicker`, `PermissionModeGlyph`, tone and icon enums, `PERMISSION_TRIGGER_CLASS` (sized `calc(var(--chat-font-size,14px)*9/14)`; the fallback matters outside a chat root). Only the `red` (bypass) tone colours the resting trigger, as a tint; the open menu uses every tone. The menu is a vertical track with a sliding highlight, a `detail` line for the highlighted mode, a check on the current one, and wrapping arrow/Home/End keys. `permissionModeToneRgb` is shared with `ModelChipSegmentMenu`. |
| `components/shared/BlockedAction.tsx` | `BlockedActionReason` (id, title, detail, optional fix), `BlockedReasons`, `describeBlockedReasons`, and `BlockedActionButton`, which takes the reasons instead of a `disabled` boolean, so no control is disabled without its explanation. |

**Cross-machine drafts** do not rebind the tab. `AgentChatPane` freezes the
selected `OpenProjectBinding` for discovery, slash commands, file search,
attachments, launches, rollback and recovery.

- An unresolved or disconnected machine falls back to this computer once the
  catalog resolves. While it loads, the saved choice stays; when unavailable,
  the picker shows an unavailable row and **Use this computer**.
- A machine switch inside one draft copies local images and keeps image URLs;
  other files and machine-owned context are removed. Send waits for the copy;
  a failed copy blocks send until the user switches back or removes them.
- Restoring a draft after a tab switch reconciles the machine first, so it is
  never taken for a user switch.
- Browser, App Control and iOS panels fail closed when their local service
  cannot act on the chat's machine.

Quick slots (nine actions on a leader chord plus a digit) are in
[Quick slots](quick-slots.md). `QuickSlotsHost` is in `AppShell`; the visible
composer publishes its target through
`renderer/quickSlots/useQuickSlotComposerTarget.ts`.

## Pane layout

`AgentChatPane` is the mount point. It:

1. Subscribes to `ade.agentChat.event` for the session and keeps the
   envelopes.
2. Derives message rows (`chatTranscriptRows.ts`), turn state
   (`chatTurnState.ts`; terminal transcript evidence wins), pending inputs
   (`derivePendingInputRequests`, then `resolvePendingInputs` against the
   summary in the `resolvedPendingInputsBySession` memo, which every reader
   uses), the task list (`deriveChatTaskList()`), scheduled work
   (`deriveScheduledWorkSnapshots()`), subagents
   (`deriveChatSubagentSnapshots()`) and diff summaries
   (`deriveTurnDiffSummaries()`).
3. Resolves a `ChatSurfacePresentation` (standard, resolver, worker thread,
   activity feed) for the title, accent and chips.
4. Mounts the header, list, composer and side panels by `executionMode` and
   capabilities.

`ChatSurfaceShell` gives a floating header (tinted and opaque, no backdrop blur), a body on `--chat-canvas-bg`
(or `canvasFill`; the empty Work draft is transparent) and a composer footer.

In an open Work chat (`overlayFooter`) the footer floats over the body and the
transcript scrolls behind it. `chatComposerOverlayInset.tsx` writes the
footer's height onto the transcript's `padding-bottom` and
`scroll-padding-bottom`, the right panes, the Chat Actions pane, the notice
overlay and the Jump to latest pill. A pinned reader stays pinned when the
prompt grows. Chips and banners get an opaque backing; gaps stay
click-through. With an app panel open the composer docks below the column.

Floating PR and Chat Actions panes reserve a gutter only in the
selected-session branch; an empty draft reserves none, so its composer stays
centered.

### Empty draft surface

The draft is the wordmark, the composer, a **launch shelf** under it, the
activity module (`mt-11`, width-capped to the shelf) and the
`ImportFloatingBadge` hint as the last row. Optical lift is wrapper padding
(`pb-[100px]` with no app panel), not a negative margin.

- Every row below the wordmark is `shrink-0`; the wordmark absorbs overflow by
  letterboxing (`h-full w-full object-contain`, not `h-auto max-h-full`,
  which crops). The badge renders nothing when dismissed or with no project.
- **The shelf answers "where this runs":** `DraftMachinePicker`, a compact
  `LaneCombobox` (28 px, like the composer pills), then Shell and Import
  with text labels. Shell and Import act on the shelf's lane. The composer
  sits above at `z-10`.
- **Machine and lane are separate controls.** `DraftMachinePicker` renders
  nothing below two machines; `AgentChatPane` passes `draftShelfLanes` (bare
  lane ids for the machine). A draft's toolbar has no machine label; a
  running chat's toolbar shows its machine read-only (move it with **Hand
  off… → Another machine**).
- **The lane list is only the picked machine's lanes** plus auto-create
  (`selectorLanes` from `executionLanes`). Lane ids are unique per machine and
  each machine has its own Primary.
- `handleMachineChange` only clears the error and records the machine; it
  keeps `draftLaunchTargetId`, so "Auto-create lane" stays.

**Lane remap.** After a machine change the hook made itself (a user pick, or
the fallback off a vanished machine; `pendingLaneRemapRef`), the lane is
re-resolved by identity:

- `remapDraftLaneToMachine`: the same id if it exists there, else the new
  primary for an old primary, else the same name, else the new primary.
  `findPrimaryDraftLane` prefers `laneType === "primary"` over the name.
- The old lane is looked up in its own machine's list; only a never-read
  machine lets the target answer for the raw id.
- A machine handed in with its own lane (`initialDraftMachineId`: **New chat in
  this lane**, **Start chat in lane**, a PR's chat action) is never remapped,
  nor is an outside lane request naming the picked machine while it loads.
  Switching back to the source machine drops the pending remap.
- An unknown lane on an unchanged machine stays an error. A catalog with zero
  lanes keeps the selection unresolved until the real list arrives.

Over a scene picture, the shelf and the Chat / CLI switch are frosted with
`SceneFrost` (`renderer/scene/SceneFrost.tsx`), not with a `backdrop-filter`:
each mounts its slice of the window-sized picture under a plain `filter` blur,
with its own tint on top (`styles/scene.css`). The blur is drawn once, so typing
the first message redraws only what changed. Without a picture they keep a flat
tint. The activity card under the shelf stays an opaque plate with no blur. The
slice follows its box when the box moves: `SceneImageLayer` with
`variant="frost"` also watches the boxes around it for a size change.

**Loading hold.** A foreign machine with no lane read yet holds the selection
and shows `Loading lanes for <machine>…` (one string for the placeholder and
every launch path; send is blocked; the name from `machineNameForBinding`).
Picking it calls `requestCrossMachineLanesForMachine`. The hold ends on a
read failure, on an intended read set
(`crossMachineLaneIntendedMachineIds`) that excludes the machine, or after
`LANE_CATALOG_HOLD_MS` (12 s), and then "Selected lane is not available on
the selected machine" returns. An empty intended set does not end it. The
bound machine is not held.

**`LaneCombobox`.**

- A one-line trigger (dot, name, branch, caret) and a search field; the
  branch truncates before the name.
- `fullWidth` emits no `max-w-*` and nothing inside sets a min-content floor;
  `computeLanePopoverPlacement` clamps both axes.
- The popover portals to `document.body`, or to `PortalContainerContext`
  (`components/ui/portalContainer.tsx`), which the handoff dialogs set so the
  list stays clickable in a modal. It has no exit animation, so no portal
  node outlives `open`.

**Shelf chrome** is `.ade-chat-launch-shelf` in `renderer/index.css`: it cancels
the stack gap and the composer margin, overlaps the composer by 1 px and has
no top border, so the composer's bottom edge is the shared edge.

- **Keep that margin and padding in the CSS rule.** As Tailwind arbitrary
  values with CSS variables they can fail to compile silently, and the shelf
  detaches. No test catches that geometry.

### Header

- The title is `chatSessionTitle()`, else "New chat". A lane button (branch
  icon) opens the lane in the Lanes tab.
- CTO and resolver surfaces override title and chips through
  `ChatSurfacePresentation` (`assistantLabel`, `accentColor`, `chips`).
- **Lifecycle stays out of the header.** Settled and snoozed state is one chip
  (`ChatLifecyclePill`) in `StatusStrip` (`ui/notice/StatusChip.tsx`), a single
  row of 22 px chips on the composer's top edge that scrolls sideways. Settled
  reads `Settled · Un-settle` (what sending does is in the tooltip). Wake now
  calls `wakeSessionNow`; both use the Work sidebar's lifecycle helpers and
  cache.
- The branch-drift chip shares the strip (`<LaneBranchComposerChip
  laneId={laneId} />`, armed on submit by `armLaneBranchDriftWarning`). See
  [Lanes › Branch drift](../lanes/README.md#branch-drift).
- **New since you left.** The pane reads `ade.chat.lastViewed.v1:<sessionId>`
  once per open and passes it as `unreadSince`; the list draws one `New since
  9:12 PM` divider above the first row that arrived since. Rows that stream in
  while open never move it.

### Retained chat subscriptions

`chatSessionRetention.ts` keeps a hidden chat's `agentChat.onEvent`
subscription for `CHAT_SESSION_RETENTION_TTL_MS` (5 min), so a returning tab
shows a current transcript.

- **Renderer, on purpose.** Preload's remote event pump polls only while
  `hasRemoteRuntimeEventSubscribers()` counts a renderer `onEvent` callback, so
  a retained subscription keeps the pump alive.
- **A handoff, not a shared subscription.** The visible pane owns the only
  subscription. On hide it calls `retainChatSession(sessionId)`; on return
  `adoptRetainedSession(sessionId)` flushes and tears the module handler down.
  The handler holds no pane state; it talks only to `ChatSessionRetentionHost`
  (`subscribe` + batched `appendEvents`).
- Events batch on a 16 ms timer (`CHAT_SESSION_RETENTION_FLUSH_MS`), because a
  per-event append re-walks the transcript.
- `MAX_RETAINED_CHAT_SESSIONS = 2`. At TTL the subscription drops; the cached
  view stays.
- The module computes no `turnActive`: adoption goes through
  `chatTurnState.resolveTurnActive` in `applyCachedSessionView`.
  `appendRetainedChatSessionEvents` caches the **raw**
  `derivePendingInputRequests` output and leaves `resolvePendingInputs` to the
  pane.

### New-lane launches

A new chat or CLI session on "Auto-create lane" opens at once while the brain
sets up its lane. The contract is `shared/types/chatLaunch.ts` (snapshot,
stages, events) and `shared/chatLaunch.ts` (stage labels, status line,
progress, durations; every surface uses these words).

**Stages.** The card renders `snapshot.stages` as the host gives them: fetch
base branch (left out when lanes come from the local base), check out files
(live percent), apply template / set up environment (only when one applies,
with nested steps), and start agent / start CLI session. Before the host
answers, the optimistic snapshot predicts fetch (from the last-read config),
checkout and agent.

**Foreground chat.**

- Send opens the new chat in the same frame: its sidebar row (under the
  lane's name), the composer glide, the prompt bubble and the live setup
  card. Until `sessionCreated`, the pane reads nothing from the session and
  renders the launch; the picker shows the launch's model.
- Sends during setup go to `chatLaunch.queueMessage` as queued bubbles, sent
  in order once the agent starts. A message typed before the brain accepted
  the launch waits in `chatLaunchActions` and goes after `start`; one chain
  keeps typing order. A refused message returns to the composer with the
  error.
- A queued message the brain could not deliver stays marked "Couldn't send —
  retrying" (reason on hover) until delivered; meanwhile new sends also queue
  (`launchRoutesSends`).
- When the chat exists, the same pane reads it, and each stand-in yields to
  its real row: the bubble to `user_message`, the card to the `ade_card`
  `lane_setup` row (`cardId` `lane-setup:<launchId>`).

**The setup card.**

- A header: a phase tile (violet running, emerald done, amber failed), the
  title ("Setting up lane…", "Lane setup failed", "Lane set up in 4.2s"), lane
  and base chips, and elapsed time. Then `LaunchProgressRail` and one row per
  stage (icon tile, label, muted detail such as "origin/main at 807fb2c",
  checkout percent, duration, status mark). Environment steps nest under
  their stage with per-kind glyphs. Warnings and failures are amber, never
  red.
- Actions: Details, Start now (during the environment stage; the agent starts
  and the steps continue), Cancel while running, and on failure Retry, Start
  anyway (lane exists and the environment stage failed) and Delete.
- Cancel and Delete confirm. With a lane they delete it (worktree, local and
  remote branch) and the chat; before a lane, Cancel only stops setup. The
  tab closes, Work returns to the draft and the prompt goes back into the
  composer at once (merged with typed text).
- The confirm re-reads the launch and never cancels one whose agent started
  or that completed ("Setup finished — nothing to cancel", or a toast). A
  refused cancel shows its reason on the card.
- After the launch, the row collapses to "Lane set up in 4.2s ›". A reload
  with no live launch renders the payload's rows by each row's `key` (stage
  id), with the card's `title`, the `Template` metric and the `agent` row's
  icon. A failed launch this window never started asks the chat's machine
  once (`chat.getLaunch`; failed records do not expire), and meanwhile shows
  the failed row's error in full.

**Sidebar row.** While pending, the preview line shows the status line
("Checking out files · 62%", or an amber failure) with a spinner, and the
status slot says "Setting up" / "Setup failed" with no settle or snooze. The
height does not change; a new row slides in once. A stand-in row is listed
only until the chat exists or while the launch owns it
(`isChatLaunchPending`), and only for the active binding and the same project
on another machine.

**Background chats and CLI launches.**

- A background chat clears the composer. A CLI launch keeps the prompt until
  its session is starting.
- The Launches slide-out (app shell, bottom right) lists this window's
  (`originClientId`) background chats and CLI launches, never a foreground
  chat. Header: "Setting up 2 lanes…" / "2 ready · 1 failed" and X. Rows:
  kind tile with status badge, prompt title (two lines), status line (a stale
  fetch says "Fetching latest main (last fetched 2 days ago)"), lane name,
  elapsed time and `LaunchProgressRail`. A row expands to the compact card
  with Open once the session exists; there a stage's detail sits under its
  label.
- It leaves three seconds after everything started; a failure stays until
  handled or dismissed. Dismissing it while a CLI launch fetches cancels that
  launch, aborts the fetch and returns the prompt at once.

**Render cost.** The brain sends up to ~8 snapshots a second during checkout.

- `useChatLaunchSync` writes the store once per frame (newest per launch; a
  50 ms timeout backs `requestAnimationFrame` for a hidden window).
- `shareChatLaunchStages` keeps unchanged stage objects, so only the moving
  stage re-renders; slide-out rows are memoized.
- Work rows read `useChatLaunchRowState` (pending / failed / startedAt) and a
  child reads the status line, so a tick updates one text node.
- Live durations read one clock (`launchClock.ts`, 250 ms, only while one is
  mounted, paused while hidden) as text.
- The rail is compositor-only (`transform: scaleX()`, the
  `ade-launch-rail-sheen` bar; no sheen under reduced motion).

**CLI launches.** The brain stops at `awaiting-client` once the lane is ready.
`useChatLaunchCliDriver` (beside `useWorkSessions`) starts the PTY through
`launchPtySession` (disposition = the launch's mode) and reports it with
`completeClient`, or the error. A window reloaded mid-launch reports that it
lost the prepared launch. If the brain does not take the session, the driver
disposes the PTY.

**Composer dock.**

- The draft captures its composer rect (`[data-chat-composer-wrapper]`, or
  the bottom-bar dock with an App Control/iOS panel open). A brain-owned launch
  stashes it right before the switch; an existing-lane launch captures it
  before the IPC and moves it to the new session id (1.5 s TTL).
- The chat pane pins its docked composer at that spot and, two frames later
  (the first commit can block 150–300 ms), plays a WAAPI FLIP translate (420
  ms, `cubic-bezier(0.4, 0, 0.2, 1)`), aligning bottom edges and centers. It
  never scales the field.
- Clipping ancestors that do not contain the start rect become `overflow:
  visible` for the glide. `WorkViewArea` skips its blur dissolve for that
  switch.

**First-message flight** (`chatLaunchDock.ts`).

- The handoff records the prompt text box and its typed text and style. The
  pane parks a copy of its first bubble (`[data-chat-user-message-card]`) on
  the prompt text and, once settled, flies it to the bubble (480 ms) with the
  real bubble hidden.
- Three layers: the chrome contracts from the text box into the bubble (fade
  in over 45%); the typed text rises and fades out (40%); the bubble text fades
  in from 25% to 70%. Each layer is laid out at its end geometry and animates
  only `transform` and `opacity`, so it stays smooth while the chat mounts.
- The docked composer's text stays blank until the glide lands. Neither layer
  uses `backdrop-filter`. The copy lives in a `document.body` overlay with the
  inline appearance variables of `[data-chat-appearance-root]`.
- It runs for the first message of a new chat in all three paths: a new lane
  (the synthetic prompt row is the target); an existing lane (the composer
  keeps the prompt until the chat opens, the new pane seeds its optimistic
  bubble, later additions stay in the composer, and
  `clearDraftLaunchComposer` cleans stored drafts if the pane unmounted); and
  in-place create (`submit` measures before `createSession`; a layout effect
  on `selectedSessionId` hides the old composer and plays both FLIPs).

**Departing draft chrome.** `data-draft-depart` elements in
`[data-work-draft-surface]` (the Chat/CLI switcher is `rise`; logo, shelf,
usage module and import hint are `fade`) are cloned into a fixed overlay at
stash time. When the chat settles, the switcher morphs into
`[data-chat-shell-header]` (420 ms): a bar layer grows out of the pill, the
labels fade, a content layer fades in from 60%. The real header is hidden
until the morph lands. With no header, the switcher flies off the top. The
rest fades and drops 10 px (260 ms). Transform and opacity only (`contain:
layout style`); unplayed copies remove themselves after the TTL.

**The reply ends the send animations.** When the shown chat's reply shows the
first text of its turn (`isFirstTextOfTurn`, `lib/chatSessionEvents.ts`) while
that chat's draft copy is still on screen (copies are keyed by the chat that
played them), or within 1 s after that chat took over from its draft,
`settleSendHandoff` removes the copies and finishes the `WorkViewArea`
dissolve (`onSendHandoffSettle`) in the same frame, so a quick reply is never
drawn under a fade or a blur. The 1 s covers a dissolve that outlives the
draft copy, and one that plays with no copy (the copy skips under resource
pressure). Only animations that started within 250 ms of the take-over end
(`startedWithSendHandoff`), so a later transition (a grid, another chat) plays
in full. That first text also flushes in the next frame, not at the next
work beat. A reply that comes after the animations end changes nothing.

**Skips.** The flight is skipped when the bubble does not mount in 500 ms.
Both animations are skipped for reduced motion, at resource pressure level 3
or higher (`latestAppResourcePressureLevel`) and while the window is hidden;
a handoff that sees no frames in 1.5 s gives up and restores the composer.

## Composer

### Turns, failures and limits

- **Post-failure recovery.** A failed or interrupted turn releases the input.
  A failed turn's line offers **Retry**, which resends the original prompt
  (attachments, context, metadata) in the same provider thread. Usage limits
  have no Retry; the chip owns them. Recovery never starts by itself and is
  disabled while another turn runs.
- **Usage-limit resume.** With `AgentChatSessionSummary.usageLimitResume`
  (the source of truth), `UsageLimitChip`
  shows `Usage limit reached · resumes in …` with **Cancel**, `auto-resume
  off` with **Resume in …**, `paused after 2 tries` with **Try again**,
  `resuming…`, or the provider's name when it gave no reset. **Continue on
  <account>** copies the provider thread to another account with room and
  resumes there; a thread that cannot move continues, with its queued
  messages, in a new chat in the
  same lane (a compaction-only turn reports the failure). Clock and provider
  text are in the tooltip.
- **Quiet limits.** A turn that ended at a 429, or the live resume turn, shows
  `Paused · usage limit · <elapsed>` in its footer, with usage behind the
  details. Two or more consecutive failed subagent results naming a usage
  limit fold into `<n> agents stopped · usage limit`.
- **Work-list badge.** `sessionStatusPresentation` shows `armed` / `resuming`
  as a neutral `Resumes <local time>` / `Resuming`, and `paused` as `Paused ·
  limit`. `opted_out` and `no_reset` fall through to the normal phase.
- **Deferred model handoffs.** A new model in an existing chat changes only the
  composer until the next send; its permission, effort and Fast controls stay
  local too. The pick is per chat. Send applies the handoff with those
  controls. A `model_handoff` divider (two provider marks; iOS draws logo →
  `HANDOFF` → logo) is recorded only when the top-level provider group
  changes; OpenCode, Cursor and Droid are one group each. A same-provider
  switch still rebinds the runtime but draws no divider, and renderers drop a
  same-provider pair from older transcripts.

### Input

- **Auto-grow** up to `composerMaxHeightPx`; grid tiles pass a fixed 144 px.
- **Paste is plain text.** The rich editor inserts the clipboard's
  `text/plain`, so pasted text takes the prompt's own style. Chips, images,
  files, folded large pastes and URL chips are handled as before.
- **Focus-on-active.** The composer takes focus when its pane is active
  (`isTileActive: true` for grid tiles).
- **Smart links.** A completed HTTP(S) or `ade://` URL becomes an atomic violet
  chip with the provider's mark (`smartLinkChipMark.ts`: GitHub, Linear
  `LINEAR_LOGO_PATH`, ADE), or a globe that a resolved favicon replaces
  (`chat.resolveSmartLinkPreview`). The literal URL stays in the draft and is
  what the agent gets. Click, Enter or Space opens Copy link / Remove link;
  Backspace/Delete removes the whole chip. The editor is left-aligned.
- **Chips.** Every chip has a kind-naming `data-composer-chip` attribute and
  keeps its literal text in `data-composer-chip-text`. Chips are
  `contentEditable="false"`, so a `selectionchange` effect marks intersected
  chips with `data-composer-chip-selected` and `index.css` paints an overlay;
  see [Chip selection marking must stay cheap](#fragile-and-tricky-wiring).
- **Chat-context chips.** Select assistant output → Add to chat. The chip shows
  the quote's first words, serializes an `<ade-chat-context>` block telling
  the agent the text after it is the user's reply, and the sent message shows
  a quote card.
- **Typed triggers** anywhere in the draft; see
  [The command menus](#the-command-menus). Selecting replaces only the trigger
  span (`replaceComposerTriggerSpan`), or only `@` plus the label for a
  multi-word pick (`composerTriggerForSelection`). A lone leading command keeps
  the fill-the-draft path (`/clear` intercept, argument hints). The textarea
  draws a backdrop overlay for confirmed tokens. IME composition freezes
  trigger checks until `compositionend`.
- **File search** (`ade.agentChat.fileSearch`, 40 ms debounce, per-session
  cache, stale-result guard). An empty-query search on bind warms the lane's
  index (`fileService.warmQuickOpenIndex`).
- **Slash commands.** Local commands (`/clear`, `/login`) resolve in the
  renderer where the provider owns them. SDK commands, Codex prompt files
  (`.codex/prompts/**/*.md`), Claude command files (`.claude/commands/**/*.md`)
  and skills (`.claude/skills`, `.agents/skills`, `.ade/skills`,
  `.codex/skills`, `ADE_AGENT_SKILLS_DIRS`, bundled roots) merge through
  `ade.agentChat.slashCommands`. Only a local `/clear` is intercepted; every
  other command goes to the agent. `isProviderSlashCommandInput`
  (`shared/chatSlashCommands.ts`) reads `"/rebase the lane?"` as text and
  `"/plan"` as a command.
- **Issue context.** The attach menu (Linear and GitHub) opens
  `LinearIssueSelectModal` / `GitHubIssueSelectModal`; GitHub only when
  `detectRepo()` matches this project, and never in personal chats. Items are
  `linear_issue` / `github_issue` (`chatContextAttachments.ts`); sending
  records them on the session (`attachLinearIssueToSession` /
  `attachGitHubIssueToSession`). PRs are not attachable. iOS has the same
  section, gated per attach command and per the focused machine's project; a
  CLI start records Linear only. PR bodies get `Refs ADE-123` and `Closes
  owner/repo#42`; see [Linear integration](../linear-integration/README.md).
- **Drag a chat in.** A Work row's drag carries `CHAT_MENTION_DND_MIME` (`{ kind,
  id, title }`); dropped on a composer ("Drop to reference") it becomes an
  `@chat:` / `@term:` chip. A chat dropped on itself is ignored.

### The command menus

`ChatCommandMenu.tsx` draws the `/`, `@` and `#` menus from a `ComposerTrigger`
(`shared/composerTriggers.ts`), so a trigger opens mid-draft too.

- **Triggers.** `detectComposerTrigger` finds a `/command`, `@` or `#` query
  ending at the cursor; the one typed closest to the cursor wins. `#` takes a
  number or a short query with no space, so `# Title` and `owner/repo#12` never
  trigger. `@` queries may hold spaces but stop at a newline or another `@`.
  Selecting narrows the replaced span to the label, so trailing prose stays.
  `findConfirmedComposerTokens` finds confirmed tokens (`ComposerTokenKind`:
  `"file" | "command" | "mention"`; mentions are known by their `chat:` /
  `lane:` / `term:` / `pr:` / `mac:` prefix).
- **`@`, bare:** recent rows grouped by kind (Chats, Lanes, Terminals, Pull
  requests, Machines, MCP servers, Files), five each.
- **`@` with a kind word** (`@pr`, `@mac`/`@machine`, `@mcp`/`@server`,
  `@chat`, `@lane`, `@term`): that section only, searching the rest
  (`parseChatMentionKindFilter`; files are not searched).
- **`@` with any other query:** one mixed list (files, folders, chats, lanes,
  terminals, PRs, machines, MCP servers) ranked by `rankComposerAtMenuItems`
  (exact, prefix, substring, subsequence). Files and mentions are two
  debounced (40 ms) `useDebouncedSuggestions` sources, each with a
  per-session query cache (`QUERY_CACHE_MAX = 40`) cleared on close or a
  provider change. Results for an older provider or query are dropped **and
  count as loading**, so no false no-match fires.
- **Rows.** PR rows: state dot, `#<n> title`, checks glyph. Machine rows:
  online dot, name, "this machine · online / last seen · N projects". MCP
  rows name the chat machine's registry servers; the transcript hover card
  shows cached tool count, first tools and the last error without probing.
  Clicking an MCP chip, or **Open MCP settings**, opens this computer's MCP
  Settings page on that server.
- **People.** The **People** section lists the chat machine's Linear
  workspace members (active users, through its Linear connection) and the
  users who can be assigned in the project's GitHub repository
  (`/repos/<owner>/<name>/assignees`). Each row shows its source logo, the
  handle, and a **Linear** or **GitHub** label, so one person in both shows as
  two rows that read apart; `@people` narrows to them, and `@linear` or
  `@github` matches a source through the subtitle. Each source is read once
  and kept 5 minutes; a disconnected or failing source is retried after a
  minute. A bare `@` browse waits at most 800 ms for a cold read (the rows
  join on the next keystroke); anything typed, `@people` included, waits for
  the read itself (4 s cap), because an answer without people would read as no matches and the
  composer closes the menu on that. Finishing a kind word (`@peop` →
  `@people`) reopens a menu that a no-match closed; an Escape still holds. No email is read into a row. A
  person mention is **context only**: its block (`kind="person"`) gives the
  name, Linear display name and user id, or the GitHub login and repository,
  and tells the agent to assign, comment or notify only when the user asks
  (`ade linear assign <issue> <id>` for Linear; writing `@login` on GitHub
  notifies). A resting ADE Cloud chat shows no people rows, because only its
  computer can read them. A CLI's input box inserts a person as plain text
  (`@login`, or the name with its Linear id), since a CLI gets no expansion.
  iOS skips the kind until its Swift mirror learns it.
- **Selection** inserts an opaque `@chat:<id>`, `@lane:<id>`, `@term:<id>`,
  `@pr:<id>`, `@mac:<id>`, `@mcp:<name>` or `@person:<source>.<id>`
  (`linear.<user id>`, `github.<login>`) pointer and shows a title chip
  (`shared/chatMentions.ts`; a PR chip reads `#1319 title`). A sent Linear
  person chip gets its name from the menu's rows, else from an exact lookup of
  the chips' ids on the chat's machine (`listMentionSuggestions` with `ids`,
  batched per machine, never on a resting ADE Cloud computer; a miss is asked
  again after a minute) (`mentionChipLabels.ts`); a GitHub one shows
  `@login`.
- **`#`** lists the PRs the chat can reach (`ComposerPrSuggestion`,
  `prs.listAll` on the chat's pin) and inserts a PR chip.
- **`/`** groups Commands, Skills and MCP prompts (per server), ranked by the
  same tiers (`shared/slashCommandSections.ts`), so `/test` ranks `test` first.
- `onNoMatches?(trigger)` fires once when a **non-empty** `@` query settles
  empty, so the owner closes the menu; an empty query never reports.
- Both menus use the opaque `ade-chat-drawer-solid` background, because blur
  does not work in portaled menus. All rows share `MenuRow`.

**Dismissal.** `isComposerTriggerDismissed(trigger, dismissal)` keeps an
extension of a dismissed query dismissed (search only narrows); backspacing,
editing into another query, or a new `@` reopen. The composer holds the last
dismissal in a ref and has three close calls:

- `closeCommandMenu()` closes and forgets: the trigger is resolved (selection,
  trigger gone, composer locked or reset).
- `dismissCommandMenu(trigger)` closes and stays closed while the query
  grows: Escape, Enter/Tab with no row, and the menu's no-match report.
- `closeCommandMenuKeepingDismissal()`: this trigger cannot open a menu now
  (already a token, or still covered), but nothing was resolved or dismissed.
  Do not clear or record a dismissal here.

### Attachments

- Drag-drop anywhere on the chat, paste, or the picker; images show a pending
  thumbnail. A pending image also holds its place in the prompt as an
  uploading token at the caret (`composerPendingAttachmentChip.ts`,
  `data-composer-pending-id`, the id of the same pending record the tray
  tile draws); it serializes to nothing and the real chip replaces it in
  place when the save lands. A failed save keeps tile and token, marked
  failed, with **Retry** (the same bytes, the same token, a fresh staged
  copy) and **Remove** (tile and token together) until the user chooses;
  a retry that cannot start stays failed with the reason. Electron clipboard images use
  `ade.app.saveClipboardImageAttachment` (main saves and returns a preview);
  `ade.agentChat.saveTempAttachment` is the fallback.
- **Clipboard images are re-encoded bitmaps**, often over the 10 MB paste
  ceiling. `encodeClipboardImageWithinCap` (`clipboardImageEncoding.ts`)
  fits them: PNG, else JPEG, shrinking the long edge from 4096 px, refusing
  below 768 px. On desktop an oversized single pasted image goes to that
  reader, unless it has a disk path (streams from the path). The hosted web
  keeps the normal path.
- **HEIC/HEIF** drops convert to JPEG on macOS before staging. Windows and
  Linux have no codec and ask the user to convert.
- **Staging mode.** The composer asks the chat's machine once per batch for a
  `ChatAttachmentStagingMode` (mode plus ceiling): **`copy`** (this machine;
  decided in preload), **`upload`** (a host with the streamed HTTP route) or
  **`base64`**. A dropped or picked file has a path
  (`window.ade.project.getDroppedPath`), so `copy` and `upload` stage it by
  path, any type up to 50 MB. Pastes, converted HEIC and hosted-web files take
  base64 with its 10 MB ceiling. The MIME sniff on that leg runs on the sync
  host only.
- A fixable staging failure offers **Try again**; a size rejection or a failed
  HEIC conversion does not.
- **A resting ADE Cloud computer.** Copying a file to the chat's computer is
  a write, and a write wakes it. While the chat's computer rests (the pane's
  `chatComputerResting`, read as `useChatRuntimeScope().machineRests`), a
  paste, drop or pick into a chat keeps the bytes on this device
  (`heldChatAttachments.ts`) under a stand-in path `ade-held:<id>/<name>`,
  after the same staging plan and ceiling (a resting computer answers
  `base64`, so 10 MB). Previews read the bytes there
  (`readAttachmentImageDataUrl`). The send copies each held file to the
  chat's computer right before the message (`prepareDeviceHeldForSend`),
  through the pane's chat API and the send's own reach (`chatSendReach`: a
  resting chat's computer by its machine key, as `send` goes), and sends the
  real paths; the send wakes the computer anyway, and a send with files
  always goes direct, never through the account's queue. A copy that fails
  sends nothing and puts the text and every file back; a file already copied
  to that machine (by the chat pin's key) is not copied again on the next
  try. After the copies the send, its bubble, its retry and its put-back
  name the real paths. Held bytes live in this window's memory only, up to
  64 MB (past that a new file is copied at once, as before), and go as soon
  as nothing shows them: a file taken out of the box at once, a sent one
  once its bubble names the copy. After a reload a send names the file to
  attach again. An awake computer stages as before. Desktop and ADE Web;
  iOS already keeps files on the phone while the chat sends through the
  account and sends them with the queued message (`beginAttachmentUploads`).
  The same flag makes Up-arrow history skip its stash, which is a saved
  draft on the chat's machine.
- Parallel mode caps attachments at `PARALLEL_CHAT_MAX_ATTACHMENTS = 12`, since
  every lane gets the same list.

### Prompt history

With the cursor on the first line, press ↑ to recall a prompt. Keep pressing
↑ or ↓ to browse while the recalled text is unchanged. Press ↓ past the newest
prompt to restore what you were typing. The current chat's transcript comes
first, followed by recent prompts sent in other chats on this device or browser
profile. Hosted web keeps a separate history for each signed-in account.

Open **Search prompt history** from **More composer controls** or press Ctrl+R
on macOS (Ctrl+Shift+R on Windows and Linux). Enter recalls the selected prompt.

In **Settings → Chat**, **Copy prompts to clipboard** is off by default.
The **Message bubble** setting offers Gradient and Solid. Solid uses the
gradient's middle color for your messages, darkened as needed for white text.
It also gives the light-mode composer a solid background.

### Drafts and scheduled send

- Cmd/Ctrl+S (or the bookmark left of the context meter) saves the prompt in
  the project runtime and clears the composer after the write is confirmed;
  with an empty composer it opens the list. Appearance > Drafts can hide the
  bookmark; the shortcut stays. The bookmark also hides while the composer and
  list are both empty.
- The list has **All**, **Scheduled** and **Needs you** tabs whose counts come
  from the same rows. It is a viewport-clamped portal with a scrolling list.
- **Claim first.** Attaching deletes the row as the claim; only the winner
  fills a composer. A save copies up to ten images into the owning runtime
  first and rolls back if it cannot. On another runtime a row keeps text and
  image count and refuses to attach the images. Machine-bound context and
  non-image files are not kept.
- 20 plain drafts, newest first; armed sends cap at 50. `prompt_stashes` syncs
  the list; calls go to the bound runtime.
- ArrowUp from a new draft keeps it before loading history; ArrowDown past the
  newest restores it.
- **Schedule send** (`DraftSchedulePopover`) needs a target (this chat or a new
  chat in a lane), a fire time on the target machine's clock, an if-late
  policy (`wait` / `strict` / `grace`), and the composer's config; an elevated
  permission mode is badged.
- iOS mirrors it (`WorkDrafts.swift`, `chat.listDrafts` / `createDraft` /
  `updateDraft` / `deleteDraft` / `claimDraft`, optional so an older host hides
  it). Personal chats hide drafts.

### Model, effort and Fast

- **Model selection.** `ProviderModelSelector` filters by
  `filterChatModelIdsForSession`; crossing families is a handoff. Dynamic
  inventories load only when their rail opens and the TTL lapsed
  (`agentChat.modelCatalog({ mode: "cached" | "refresh-stale" | "force",
  refreshProvider? })`; `runtimeCatalogCache.ts`: 30 min for Cursor / Droid /
  OpenCode, 30 s for `lmstudio` / `ollama`). A change on a machine (a
  provider installed, signed in, given a key, or set up in Settings ›
  Providers) marks that machine's cached buckets out of date
  (`invalidateRuntimeCatalogScope`, `refreshRuntimeCatalogsForMachine`;
  Settings re-reads only the changed provider through
  `MODEL_CATALOG_REFRESH_PROVIDERS` / `refreshProvider`, since a full
  refresh starts several provider processes). The old list stays on screen,
  and every surface that shows models (the "@" menu, the picker, the effort
  control) follows the bucket's change version
  (`useRuntimeCatalogVersion`). The "@" menu shows a quiet **Loading
  models…** row, and a query with no match yet is not called empty, while
  its machine's list is being read (`modelsLoading`). On the host the chat
  catalog goes stale when the OpenCode inventory or a provider's model list
  really changed (`openCodeInventoryGeneration`, `providerModelsGeneration`),
  not on a re-check that kept them. Chat hides CLI-only Cursor rows;
  Work CLI hides SDK-only ones.
- **Everything a prompt box offers is scoped to its machine.** `AgentChatPane`
  always passes `activeComposerRuntimeBinding` (the chat's `chatRuntimePin` or
  the shelf's machine, never `null`) as `modelRuntimePin`; the picker routes
  `agentChat.modelCatalog(args, pin)` there and caches by binding. During a tab
  switch, `modelCatalog` and `getAvailableModels` stay on the runtime. Tools,
  git, iOS and App Control still use `null` for the tab's own machine. ADE Web
  rejects a foreign pin (`assertWebRuntimePinRoutable`) and uses the pinned
  list.
- **Allowlist.** With `availableModelIdsOverride`, selection is limited to
  exactly those ids (`includeActiveSessionModel: false`, no catalog merge,
  `constrainModelSelection` / `constrainToAvailableModelIds`, no "Show all
  models"). `constrainedModelSelectionError` blocks submit, auto-create and
  parallel launches when a model falls off; setters ignore outside ids.
- **Handoff jobs.** A root-store `HandoffLaunchJob` (`preparing-summary` or
  `forking-history`) shows as a placeholder in the Work sidebar until the
  chat exists or fails, or until a matching row appears
  (`handoffJobLikelyMaterialized`). Fork is the default when
  `providerSupportsHandoffFork`; it stays on the source lane and provider. A
  brief can target any lane (`targetLaneId`) or a new one. Cursor's copy
  says the conversation is replayed (`providerForkReplaysTranscript`). An
  optional note goes into a brief's hidden prompt, or as a fork's first turn.
  Codex targets get no ADE goals; forked Codex threads have their goal cleared
  first.
- **Reasoning effort.** `ReasoningEffortPicker` sits beside the model when the
  descriptor has `reasoningTiers`. Its trigger shows an `EffortMeter` (one bar
  per tier, lit to the level) and the full tier name on normal widths
  (abbreviated on narrow ones). `useReasoningByFamily` remembers the last
  effort per family. The open track slides one indicator by `transform`;
  click, drag, arrows, Home and End move it. Over four levels, segments show
  short labels (`Min` / `Med` / `XHigh` / `Ultra`). A pick does not close the
  popover. GPT-5.6 shows Light / Medium / High / Extra High / Ultra (no Max);
  Ultra warns that it can delegate and use limits faster.
  A chat's saved level always shows: when the ladder in view does not
  list it (the machine's catalog is not loaded, its computer is asleep, or the
  list is partial) the control shows that level on a common ladder instead of
  "Auto", read-only until the catalog arrives, and nothing writes it back.
- **Fast mode** lives on the model row inside `ModelPicker`.
  - **Account gate first.** With `fastModeAllowed === false` the toolbar shows
    no Fast control. Row chips stay but a press selects nothing, closes the
    popover and calls `onFastModeLocked` ("Turn on Fast mode in Settings";
    Continue opens Settings → Chat → Fast mode with the spotlight). Without
    `onFastModeLocked` no chips show while locked. The picker never sends
    `fastMode: true` while locked.
  - The chip shows when the descriptor has `serviceTiers: ["fast"]` and the
    caller passes `onFastModeChange`. It reads on only on the **selected** row
    (`fastModeOn={fastMode && isActive}`). The selected row's chip cycles the
    tier; another row's chip selects that model with Fast. A plain switch
    keeps Fast only when the new model has the tier. States: muted outline,
    darker hover, violet on. Presses change colour, never size.
  - The trigger names the state (`composeModelPickerTriggerLabel()`: "GPT-5.6
    Terra Fast", with an `aria-hidden` glyph). Parallel slots use
    `onParallelSlotCodexFastModeChange`.
  - **Codex Ultrafast.** Where the surface passes `fastTier` and the model's
    catalog lists `ultrafast`, the chip cycles Off → Fast → Ultrafast (`Ultra`,
    double bolt); the tier is `onFastModeChange`'s second argument. Other
    surfaces keep two states. See
    [Provider service tiers](agent-routing.md#provider-service-tiers-fast-mode).
  - **What came back.** Pass `effectiveFastTier` (the session's
    `codexServiceTier`) and the selected row draws a badge with the tier the
    server reported: quiet when it matches, amber when not; unknown words
    (`default`, `priority`) show as is.
  - When Claude answers a Fast request at standard speed, the transcript shows
    one notice per reason (`fast_mode_disabled_reason` or a rate-limit
    cooldown); the toggle keeps the user's choice.
  - `ModelSelector` still uses the deprecated `fastModeActive` /
    `onFastModeToggle` sibling chip.

### Model hint (Jev)

`useComposerModelHint` (drawn by `ComposerModelHintChip.tsx`) suggests a model
and effort for a new chat's first prompt.

- **When it asks.** After 700 ms idle, for a prompt of at least three words or
  12 characters (`isModelHintPrompt`), again only after a 10% change; an
  answer about older text never shows.
- **The call.** One `ai.jevDecide` (feature `model_hint`, `modelHint.ts`) with
  the prompt, up to five recent new chats on the same provider and maker
  (`modelHintHistory.ts`), and `choice` questions: which model
  (`hintChoices`: current, history models, four strongest others; only image
  models with images; skipped under `effort_only`) and which effort.
- **When it shows.** Another model at 0.7 confidence or more, or an effort two
  or more levels away at 0.7. It suggests only a model the catalogue rates
  stronger, and moves no model up for a lowest-effort request.
- **Cheaper model.** A `cheapest` question (with each model's intelligence and
  price, `HintChoice.facts`) shows `cheaperChoice` only at 0.9 confidence, for
  a lowest-effort request, for a weaker model, and when `wouldTake` puts 0.5
  or more on the user accepting, judged from their last five answers to such
  chips (`readCheaperHintOutcomes`).
- **The chip** reads `↓ low effort?` or `↑ Opus 5.5 · max?`; hover says whether
  it came from similar chats or the prompt. While it shows, the effort
  trigger drops its level name below a wide composer (`squeezed`). A model
  listed only in another harness borrows that entry. A click applies model
  (`onModelChange`) then effort (`onReasoningEffortChange`); × or a manual
  effort hides it for this prompt. It never acts by itself.
- **Hidden** while a turn runs, when the picker is locked, for a Custom
  preset, in parallel launch, and on any failure. It needs Smart decisions
  (`ai.chat.smartDecisionsEnabled`) and **Model and effort hint**
  (`ai.chat.modelHintMode`: `model_and_effort` default, `effort_only`, `off`).
  In full hint mode, GitHub Copilot can suggest Standard or Long context for
  models that offer both. The context choice can also be changed between turns
  from the model picker.
  The catalogue and setting cache per machine (10 min, 1 min); every call uses
  `modelRuntimePin`.
- **Local memory** (`modelHintHistory.ts`, window `localStorage`): the last
  100 composer-sent new chats (`ade.modelHint.history.v1`: provider, maker,
  model, effort, first 100 characters) and the last 20 cheaper-chip answers
  (`ade.modelHint.cheaperOutcomes.v1`); an ignored chip is not recorded.
  Agent-started chats are not in it.

### Voice

- **Dictation** types for you (not the voice conversation button). With voice
  input on and the model installed, a mic sits beside Send. The app-global
  `globalVoiceRecorder` survives unmounts, records 16 kHz mono PCM, transcribes
  in main, cleans with the glossary, inserts at the registered composer's
  cursor and copies the text. The composer and top-bar pills share the root
  dictation state. macOS asks through `systemPreferences.askForMediaAccess`;
  Windows blocks only `denied` / `restricted` and points to **Settings >
  Privacy & security > Microphone**.
- **Voice conversation**: the waveform button; see
  [Voice conversations](#voice-conversations).

### Toolbar controls

- **Overflow `⋯`** (`ComposerOverflowMenu`): issue context, account (new chat
  only), parallel models and the iOS / App Control toggles, each under its own
  condition; no entries means no trigger. One entry renders as a plain icon
  button (`items.length === 1`; a Work CLI draft hides lane drawers with
  `hideLaneToolDrawers`), so tests accept both forms. The trigger carries an
  accent dot when any entry is on; rows report `aria-checked` and may carry a
  `badge`. Rows with their own portal position against `triggerRef`. The menu
  portals to `document.body` (`composerSplitMenuPosition`), because the shell
  clips.
- **Account entry.** Only on a new Claude or Codex chat with a real choice
  (several working logins, or one that is not the default). It lists
  `Default (machine picks)` and each account by email; the pick travels as
  `instanceId`. A failed read offers Retry and never clears the pick.
  Provider sign-ins (OpenCode's Anthropic / OpenAI) are never accounts.
- **Send split.** Background launch is Send's second caret row. Send is a
  split control (one `rounded-full` body, arrow, hairline, caret), the same
  shape as `ActiveTurnSendButton`. It splits only with `onSubmitInBackground`
  and outside parallel and Cursor Cloud modes.
- **Permission controls.** Interaction mode (`default` / `plan`); Claude's mode
  popover (**Ask permissions** green, **Accept edits** blue, **Plan mode**
  purple, **Bypass permissions** red; `CLAUDE_MODE_TONE_STYLES`); Codex presets
  (Plan / Guarded Edit / Full Auto, plus a read-only "Custom" row for custom
  and `config-toml`); OpenCode modes; Cursor's mode snapshot and options. Rows
  show titles only; detail is the tooltip. Popovers portal to
  `document.body` (`getBoundingClientRect` + `window.innerHeight`); outside
  clicks check the anchor and a `data-*-picker-dropdown` attribute.
- **Border beam.** On standard layouts the shell has `BorderBeam`
  (`colorful` at rest, slower `ocean` during a turn).
- `launchPromptClipboardNoticeEnabled` controls the clipboard reminder,
  separate from `promptClipboardCopyEnabled`.

### Parallel and auto-create launches

- **Parallel mode** (an empty embedded Work draft with no session) shows a
  slot list: each slot holds model, effort, execution mode and native
  permissions; the first two copy the composer. Send needs text and two or
  more slots.
- **Brain-owned auto-create.** A single-model local launch on "Auto-create
  lane" (chat or CLI, foreground or background) goes to the brain
  ([New-lane launches](#new-lane-launches)). The composer picks the session
  and lane UUIDs, names the lane (`createDeterministicAutoLaneName`; the brain
  renames it later), inserts an optimistic snapshot, clears, and fires
  `chatLaunch.start` without waiting. Create args come from
  `buildChatCreateArgs`, so the chat starts with the settings on screen.
- **Renderer-owned chain** (`launch/rendererOwnedLaunch.ts`) for an existing
  lane, parallel launches, Cursor Cloud, and a runtime without
  `chat.startLaunch` (`action_not_callable` / `action_not_exposed`, `Unknown
  ADE action`, or no web descriptor; other rejections are real failures).
  - A `DraftLaunchJob` goes `creating-lane` → `starting-session` →
    `sending-prompt` → `ready` / `failed`. Lanes are named at once;
    `startBackgroundLaneNaming` asks for an AI name and branch, with `Naming
    lane…` labels (`laneNamingStore`).
  - The composer clears at start; `DraftLaunchSnapshot` freezes the controls.
    Jobs live in `appStore.draftLaunchJobsByScope` (project, lane, profile,
    draft kind).
  - A foreground result opens only if it is still the latest
    (`latestForegroundDraftLaunchJobIdRef`) and the person asked for no new
    draft since the send. `showDraftKind` (⌘⇧N, the New chat button, the
    Chat/CLI switch) and `openStartChatDraft` (the palette, a lane's menu, a
    chip) count each request per project tab (`noteNewDraftRequested`); the job
    keeps its project's count at Send, before any await
    (`markNewDraftRequests`), and
    `launchMayOpenItsSession` compares it. A request in another project tab
    does not count. A
    result that may not open keeps `autoOpen` off, so a later draft pane does
    not open it either; the session shows in the list. Cursor Cloud and Devin
    Cloud launches follow the same rule (`adoptCloudChatSession`), and a
    cloud launch that may not open leaves the draft's cloud and lane choices
    as they are. A foreground CLI carries the mark into `launchPtySession`
    (`WorkPtyLaunchArgs.newDraftMarkAtSend`, also on the brain-owned new-lane
    path through the local launch record), which focuses the terminal only
    while the mark holds. The open in the Work tab also puts the chat in the
    URL (`?sessionId=`), which the Work page applies only once the chat is in
    its list; `noteLaunchUrlOpen` keeps the project's count at the open, and
    the page drops that URL without opening the chat when a new draft was
    asked for since (`takeLaunchUrlOpenAllowed`). Background
    jobs show a strip with Open. Failed jobs offer Restore (also on the
    matching error banner). Stale active jobs can be hidden; terminal rows are
    pruned.

### Staged messages and sending during a turn

- **Pending steers.** Queued messages show above the input as
  `PendingSteerItem`s ("Sends after turn"). The action strip
  (`pending-steer-actions`) hides behind hover only inside `@media (hover:
  hover)`, so touch screens always show it. Actions: edit (cancel with
  `requireQueued: true`, then merge text and attachments back), cancel
  (`ade.agentChat.cancelSteer`), and the immediate actions
  `ACTIVE_TURN_DISPATCH_MODES` allows: **send during turn**
  (`dispatchSteer({ mode: "inline" })`, `deliveryState: "inline"`; Cursor and
  OpenCode show `accepted` first and fall back to `queued` on refusal; Claude
  gets `priority: "next"`) and **interrupt** (Claude's `priority: "now"`
  redirect; Cursor's **Interrupt & continue**). A Cursor Cloud chat has
  interrupt only (`cursorSessionRunsInCloud`, see
  [Agent Routing](agent-routing.md)).

**Per provider** (`ACTIVE_TURN_DISPATCH_MODES`, `queuedSteersCanReorder`,
`providerStopModeSupport`; a provider not in the dispatch table is queue-only):

| Provider | Mid-turn modes | Reorder staged rows | Stop ends background work | Stop can keep the queue |
|---|---|---|---|---|
| Claude | inline, queue, interrupt | yes | yes | yes |
| Codex | inline, queue | no (app-server queue) | yes | yes |
| Muse | inline, queue, interrupt | no | yes | yes |
| Cursor | inline, queue, interrupt | yes | no | yes |
| OpenCode | inline, queue | no | yes | yes |
| Pi | inline, queue | yes | no | no |
| Copilot | inline, queue | yes | no | no |
| Kimi | queue, interrupt | yes | no | no |
| Droid | queue | yes | no | yes |
| Qwen, Grok, Antigravity, Devin | queue | yes | no | no |

- A refused inline dispatch returns `{ dispatchedAt: null }` without throwing;
  the row stays staged and one notice says it will send as a new message.
- `stagedSteerHint` names the provider and the actions this pane can really
  dispatch (a cloud Cursor chat: "Interrupt with this message, edit or
  remove."). Queue-only providers say so ("Droid cannot take a message
  mid-turn, so this one waits for the turn to end."), keyed off
  `capability.modes`, not wired handlers.
- **Reordering.** With two or more staged rows, a drag handle
  (`pending-steer-reorder-handle`, an `application/x-ade-pending-steer` drag)
  or ArrowUp / ArrowDown / Home / End moves a row. The pane calls
  `ade.agentChat.moveSteer({ sessionId, steerId, toIndex })`, shows the new
  order and reverts on refusal. The host reorders the queue
  `deliverNextQueuedSteer` reads (or the persisted `pendingSteers` with no
  runtime) and emits `queue_reordered { steerIds }`. A row an inline dispatch
  owns is refused. Only ADE-held queues move (`queuedSteersCanReorder`). iOS offers a long-press menu when the
  host has `chat.moveSteer`.
- Staged attachments show in the composer's `ChatAttachmentTray`.
- A failed cancel shows "Couldn't remove the queued message: …" in the banner.
- **Mid-turn split Send** (`ActiveTurnSendButton`) when the provider offers
  more than queue. The caret picks a mode; the button and Enter run it. Modes
  come from `ACTIVE_TURN_DISPATCH_MODES` (`activeTurnDispatchModes` /
  `defaultActiveTurnDispatchMode`; `activeTurnSendModesForProvider` adds the
  copy; the pane, the service guards and iOS `WorkActiveSendCapability` read
  the same table). Copy: **Send during turn** / **Send after turn** /
  **Interrupt & send**, or **Interrupt & continue** for Cursor
  (`activeTurnInterruptContinues`). The default is the provider's first mode
  (`defaultActiveTurnDispatchMode`). Descriptions name the provider ("Stop and redirect Cursor now.").
- The mode is held per session and re-normalized on a provider change. A mode
  with no wired handler (a model of another provider picked mid-turn, or a
  Cursor Cloud chat) falls back to **queue**, never interrupt. Immediate modes
  are one atomic `steer({ dispatchMode })`. The button disables on an empty
  draft; the caret does not. Queue-only providers keep plain queue-on-send
  ("Message queued — will be sent when the current turn completes.").
- **The CTO composer never offers *Send after turn*.** `surfaceProfile ===
  "persistent_identity"` sets `activeTurnSendModesForProvider(provider, {
  liveRedirectOnly: true })`, because the CTO's steer queue cap is zero.

### Stop choices

Stop is a split control over `shared/chatStopModes.ts`: **Turn only**
(`stop_only`), **Turn + queue** (`stop_and_clear`, the default), **Turn +
background (N jobs)** (`stop_and_background`), **Turn + queue + background (N
jobs)** (`stop_and_clear_and_background`), and, while spawned chats work,
**Turn + queue + child chats (N)** (`stop_and_clear_and_children`) and
**Everything + child chats (N)** (`stop_everything_and_children`; children stop
depth-first with the same mode, reported as `stoppedChildChatCount`).

- `providerStopModeSupport` disables rows a provider cannot honour, with the
  reason (see the table above; iOS mirrors it in `WorkChatStopCapability`).
  Codex stops background work through
  `thread/backgroundTerminals/terminate` (never user shells), and a
  user-picked queue clear deletes its app-server queue
  (`thread/queue/delete`); ADE's internal Codex stops leave that queue. A
  remembered choice that cannot apply falls back to the default.
- The job count is `activeBackgroundTaskCount`. Default Stop leaves Claude's
  query and background jobs when `perTaskStopAffordance` is declared; square
  stops call `ade.agentChat.stopTask` for one `taskId`.
- The choice is stored per chat and drives the button and `Cmd+.`; the menu
  closes on selection. A clear that cancelled ADE messages shows an eight-second
  Undo card (`restoreCancelledQueue`).
- CLI: `ade chat interrupt --stop-children [--stop-background]`, `ade chat
  stop-task <session> <taskId>`.

### Context meter and Compact first

- **The dial** (`ContextUsageDial`) shows a percent only for `state:
  "measured"`: an ellipsis during compaction, `recalculating` after a boundary
  with no exact count, `?` / `unknown` after a failed read. The settled
  snapshot is authoritative. The ring fills against the model window; a tick
  marks `compactAtTokens` (Claude: 33,000 below its compaction window).
- **The popover**: `312k of 1M used · compacts at 367k`, its source ("Your
  setting" / "Claude default"), **Compact now** and a settings link. Compact
  now sends `/compact` and keeps the draft; it exists for Claude, Codex, Pi,
  OpenCode (when the server lists `compact`) and local Cursor
  (`manualCompactAvailable` for web and iOS), and is disabled during a turn or
  pending input. ADE compacts Claude at 97% at a turn boundary when Claude did
  not.
- **Compact first.** For those providers, when the prompt cache expired and
  the last measured context is at least 200,000 tokens
  (`COMPACT_FIRST_MIN_TOKENS`), a `StatusChip` reads `Cache expired · 412k`
  with **Compact first**. The tooltip compares re-sending everything with
  about 8k after compacting (the last `postTokens`, else
  `estimateCompactedTokens`: 2%, at least 5k). The action applies to the next
  send only (`Compacts on next send · 412k`, with **Cancel**); × hides it until
  the next turn ends. The chip hides while a message is queued.
- **How it sends.** `chat.send` carries `compactFirst: true`. For Claude, the
  brain starts `/compact` as a turn and queues the message behind it (shown as
  queued). For Codex, Pi, OpenCode and Cursor, the brain runs the same
  `/compact` as Compact now, waits for it to end (up to
  `COMPACT_FIRST_INLINE_WAIT_MS`, 90 s), then sends. A Cursor compaction still
  running at the deadline is a live turn, so the message queues. A failed or
  non-shrinking compaction sends with the full chat and the notice "Compaction
  did not finish, so your message was sent with the full chat." Stop cancels
  it. A send that times out (`isRuntimeTransportTimeoutError`) returns to the
  composer only if it does not appear within two minutes (else a toast).
- **Setting** "After the cache expires": `ask` (chip), `always` (chip starts
  on) or `never`. Claude defaults to `ask`; the others to `never`.
- **Warm timer (Claude, `always`).** A one-hour-cache chat compacts 54 minutes
  in (`WARM_IDLE_COMPACT_FRACTION`, `warmIdleCompactAtMs`,
  `warmIdleCompactionScheduler.ts`), because ADE closes an idle Claude process
  after five minutes. A turn cancels it; a timer over a minute late is dropped.
  Claude's `idleCompaction` setting is left alone.
- Only a send with `compactFirst: true` compacts first; CLI, automation and
  queued sends never do. A send to an ADE Cloud chat that goes through the
  account's queue (its computer asleep or moving; desktop, ADE Web and the
  phone) carries the choice in its settings (`CloudChatMessageSettings.compactFirst`),
  and the computer passes it with that send when it delivers it, never as a
  chat setting. An older server or computer drops it. No compaction while Claude's `resume_return` question
  waits, or while background work is live (`hasRuntimeActiveWorkload`).
- **Shared values.** `shared/compactFirst.ts` (`compactFirstIdleMs`,
  `COMPACT_FIRST_MIN_TOKENS`); the summary carries `compactFirstMinTokens` and
  `compactFirstIdleMs`. The idle clock starts at the cache's `since`, or at
  `lastFinishedTurnMs` when `since` is older. Windows: Claude measured (5m/1h),
  Codex 30 min, Pi/OpenCode the model vendor's (30 min OpenAI, else an hour).
  iOS fetches summaries for other projects too. `ADE_COMPACT_FIRST_MIN_TOKENS=<n>`
  on the brain lowers the floor for testing.
- **The real cache lifetime (Claude).** At each turn end
  `claudePromptCacheTtlOfWrites` (`shared/claudePromptCache.ts`) reads the
  cache writes (`cacheCreationTokens`, `cacheWrite1hTokens`; the larger share
  wins) and stores `promptCache: { ttl: "5m" | "1h", since }` on the session
  and summary (`TerminalSessionSummary.chatPromptCache`). `since` is the last
  request's start (`lastRequestStartedAt`), else the turn end. A read-only
  turn moves `since`; an account move clears it. Compact first waits that
  lifetime (or an hour after the last turn when unknown). The countdown badge
  (`ClaudeCacheTtlBadge`, `lib/claudeCacheTtl.ts`) on the header and Work card
  counts a 5-minute cache from 5:00; a 1-hour cache shows nothing for 45
  minutes, then counts from 10:00 to 55 minutes. No known lifetime, no badge.

### Pending input in the composer

- **Questions** replace the textarea (`AskQuestionComposer`) and hide the model
  footer until resolved. Picking marks, never submits; `Next` / `Enter`
  advances. Selection and note both travel; see
  [Answer semantics](#answer-semantics). Multi-select previews are sanitized
  (`rehype-raw` + `rehype-sanitize` + `remark-gfm`) and open on click.
- **Blocking input locks the composer.** With `pendingInput.blocking`, the
  editor, attachments, slash commands and edits are off, the placeholder says
  to resolve the request, Enter does nothing and Escape cancels. The service
  refuses `sendMessage`, queued steers and `dispatchSteer` with "Answer or
  decline the pending request before sending another message.", mirrored in
  the composer banner.
- **Codex non-blocking questions** (`item/tool/requestUserInput` with
  `isBlocking: false`) are live steering: the card sits above the open
  composer in the same `--chat-column` (`codex-steering-question`), the row
  stays Working with a `?` pip, and sends work. Missing `isBlocking` blocks.
- **Sending while an approval waits declines it and redirects.** Approval,
  permission, plan and model-choice cards do not lock
  (`isRedirectablePendingRequest`). The placeholder reads "Send a message to
  decline and redirect the agent" ("…to reject the plan…"). `AgentChatPane.submit`
  declines every waiting card through `respondToInput` right before dispatch
  (after local commands), then sends as a mid-turn message or new turn. A
  failed decline sends nothing; a draft edited during the declines is not
  sent. Sends that would go elsewhere (a subagent, a queued launch message, a
  continued chat, a cloud launch) are refused while a card waits. Escape
  clears a typed redirect first.
- **Still hard-locked:** ACP runtimes (no mid-turn steer), Codex and Cursor plan
  approvals (their decline starts a turn), and user-only cards
  (`isUserOnlyConsentCard`: secrets, desktop consent, MCP App calls).

### Launch memory

The last launch settings (model, effort, Fast with its Codex tier, permission
level) are remembered **per machine** under
`ade.chat.lastLaunchConfig.v1:<surfaceProfile>:<kind>` in `localStorage`, with
no project root or lane id: the intent is "I prefer Opus", not "in this lane".
**Kind** (chat or CLI) and **surface profile** (the CTO launches with other
autonomy) still split it. The older per-project, per-lane key is read, never
written, and ranks below the machine key.

### Layout variants

`AgentChatComposer`'s `layoutVariant` is `"standard"` (default) or
`"grid-tile"` (packed tiles; `composerMaxHeightPx` caps growth).

### ModelPicker structure

`renderer/components/shared/ModelPicker/`:

| Module | Role |
|---|---|
| `ModelPicker.tsx` | Trigger and popover; runtime catalogs through `sharedCatalogFetch`; favorites and recents. With `fastMode` + `onFastModeChange` it owns the row Fast chips and the `<Model> Fast` trigger (`composeModelPickerTriggerLabel`); `effectiveFastTier` adds the reported-tier badge; `fastTier` enables Ultrafast. Without them (and no `onFastModeLocked`) there is no Fast control; the deprecated `fastModeActive` / `onFastModeToggle` / `fastModeSupported` render the old chip. |
| `ModelPickerContent.tsx` | The popover body: search, rail, virtualized list (`@tanstack/react-virtual`), empty state. The rail and search share one recessed L; the list panel has a section label (provider, `Favorites`, `Recents`, `Custom`, `N results`). Sub-provider tabs show the maker's logo. Rows are a fixed 50 px (`MODEL_ROW_HEIGHT`), `overscan` 4, ten rows before the scroller has a height. Search focuses after first paint. Props: `hidePermissionRail`, `allowCliOnlyModels`, `allowRegistryExpansion`, `registryFilter` (fork handoffs), `fastTier` + `ultrafastEnabled`, `runtimePin`. A provider's own rail drops its name from row details (`omitProviderInDetail`). With the auth filter on, signed-in CLI providers (Claude, Codex, Droid, Qwen, Kimi, Grok, Copilot) may expand from the registry. |
| `ModelPickerRail.tsx` | Icon-only tabs: Favorites, Recents, Free models (see [Free models](#free-models)), Anthropic, OpenAI, Muse, Cursor, Devin, OpenCode, Pi, GitHub Copilot, Grok, Droid, Kimi, Qwen, Ollama, LM Studio (the same order on desktop, web and iOS; no Cursor on Windows ARM). Auth gates and the "Install OpenCode" CTA come from `providerEmptyState`. |
| `ModelListRow.tsx` | A 48 px two-line row: logo, name, check, local mark, then fixed columns: **Sign in** (or a blank of the same width; a "Not signed in" tag when the surface has no sign-in), a two-slot capability pill (faint when absent), a Fast/Ultrafast slot, and the star (on hover/focus, or when starred). On a narrow row Fast goes first, then capabilities, then Sign in becomes an icon. Toggling Fast changes neither the selection nor the popover. Context menu via `Z_LAYERS.contextMenu`. |
| `ReasoningEffortPicker.tsx` | The effort control (beside the model and in parallel slots); see [Model, effort and Fast](#model-effort-and-fast). `reasoningEffortTrackLabel` gives the short labels. `resolveDisplayedReasoningEffort` falls back to the family's last effort; `AgentChatPane` resolves the same function, so trigger and launch agree. |
| `modelCatalog.ts` | `descriptorsFromAgentChatModelCatalog`, `mergeSelectorModels`, `resolveModelDescriptorWithRuntimeCatalog`, `createUnknownModelPlaceholder`: flatten the catalog and merge it with the registry, keeping `serviceTiers` and `cursorAvailability`. All take the machine's scope key, with **no fallback to another machine's bucket**: a miss goes to the registry, then the placeholder. |
| `modelOrdering.ts` | `sortModelItems`: favorites, recents, then registry order. |
| `modelPickerSearch.ts` | `scoreModelPickerSearch`: fuzzy over name, family, provider and ids. |
| `providerEmptyState.tsx` | Empty, auth and install copy ("Install OpenCode", "Sign in to Cursor"). |
| `runtimeCatalogCache.ts` | The catalog cache, **bucketed per machine**. `DEFAULT_RUNTIME_CATALOG_SCOPE` (`""`) only for surfaces with no composer machine; Work composers always key by their machine. Up to 8 scopes; the `""` bucket is never evicted. Per-provider freshness (30 min after a **live** probe for `opencode`/`cursor`/`droid`; 30 s for `lmstudio`/`ollama`); static OpenCode rows start no TTL. Each bucket owns its parsed descriptors. |
| `sharedCatalogFetch.ts` | The one deduplicated catalog fetch (`${scopeKey}|${mode}:${refreshProvider}:${cursorSource}`). `fetchSharedRuntimeCatalog` claims the bucket (`reserveRuntimeCatalogScope`) **before** the await, so an evicted bucket is not revived. Returns `ok` / `unavailable` (no bridge) / `error`. Separate from the cache to avoid an import cycle. Used by the composer picker and the Custom preset wizard. |
| `useRuntimeCatalogForFamily.ts` | One family's catalog for the Custom preset wizard; `enabled` gates it. Host-enumerated families (Cursor, OpenCode, Pi, ACP) get the cached → refresh-stale → force ladder. Every exit clears loading. |
| `useProviderAuthStatus.ts` | `AuthStatus` (`ok` / `limited` / `unauthed` / `unknown`) per family from `aiDiscoveryCache`, plus `runtimeMissing` (`familiesWithoutRuntime`, shown dimmed). `runtimePin` probes the composer's machine, keyed on `pin.key`. For the tab's own machine it shares Settings' unpinned cache, and a same-root tab switch refetches it. A picker with no `providerAuthStatus` seeds from cache and reacts to cache events (`arePathsEqual`). |
| `useAuthOnlyFilter.ts` | **Only models I can use**: off by default (signed-out models stay selectable with Sign in); stored in `ade.modelPicker.onlyUsable.v1`. |
| `useModelFavorites.ts` / `useModelRecents.ts` | Per client (`localStorage`), not per machine. The old per-project lists (`model_picker_favorites`, `model_picker_recents` via `modelPicker.*`) are imported once and merged; a failed import retries next start; nothing writes back. |
| `useReasoningByFamily.ts` | Last effort per family. |

- The rail is stable across auth and loading states, shows every provider
  (unavailable ones dimmed), and has its own focus, separate from the list.
- Use the shared auth path, not `availableModelIds` alone; a signed-in CLI
  provider exposes registry models. The status read runs only while the
  picker is open, from the shared cache, with no polling.
- A caller passing `providerAuthStatus` (Work's `AgentChatPane`) must itself
  listen for `ade:ai-status-cache-updated` / `invalidated`, apply
  `peekAiStatusCached`, and settle an orphan invalidate with one non-force
  `getAiStatusCached`. Otherwise Settings shows Connected while the picker
  stays Off.
- Fork handoffs add a same-provider descriptor filter.

### Free models

A person with no paid plan, account or key can still chat: OpenCode Zen's
free tier runs in ADE's pinned OpenCode with nothing signed in.
`shared/freeModels.ts` holds the rule (`modelOnlyRunsInOpenCode`: a
`-free` id or `big-pickle`); iOS mirrors it in `WorkFreeModels.swift`.

- **Free page.** The picker rail's gift tab, under Recents, lists every free
  model of the picker's machine. A picker narrowed to its caller's own list
  shows the tab only when that list has a free model. It needs no sign-in, so "Only models I can
  use" never hides it. Each row carries a `source` (one tab per source; one
  source draws no tabs) and a `badge` (`free` or `ad-supported`), shown by
  `FreeModelBadge.tsx` on that row everywhere in the picker. Searching
  "free" finds them from any page.
- **No OpenCode yet.** `FreeModelsEmptyState.tsx` offers **Get free models**
  (`pinnedToolDownload` on the picker's machine), shows the download's
  progress, then re-reads that machine's status and force-refreshes
  OpenCode's catalog. It mounts only while the page is empty, so a page with
  rows reads nothing extra. It shares `PickerEmptyMessage` with the provider
  pages.
- **Nothing signed in.** The status of the composer's machine carries
  `freeModels` (`main/services/ai/freeModelsStatus.ts`): `nothingSignedIn`
  (no provider, key, custom provider or local model), `everSignedIn` and
  `preferredDefaultModelIds` (the manifest's `defaults.free`).
  `everSignedIn` reads a record in ADE's cache: the first check writes it,
  counting an agent that ran there before (older ADE versions), and the
  first sign-in seen marks it. Later agent runs do not count, because a
  runtime start is noted even with no sign-in. A local model is not a
  sign-in: it clears `nothingSignedIn` but never marks the record. Pi
  counts only with a stored key or login, because its settings list models
  that have no sign-in.
  With nothing signed in:
  - the picker opens on the Free page (also when the status arrives after
    the picker opened, unless the person picked a page);
  - a fresh chat draft starts on the preferred free model, else the first
    listed one (`chat/useFreeModelsDraft.ts`). It loads OpenCode's catalog
    for that machine, and a load that found no free model runs again on a
    later status read, at most once in 30 s. ADE set it, so it is not
    remembered as the launch default or "last used", also after a launch or
    a reload, until a person picks a model; another chat or draft starts
    without the mark. A model someone chose
    wins, also one chosen before the status arrived, the tour's pick and a
    restored saved draft. A sign-in on that
    machine puts the draft back on the model it opened on;
  - a person who never signed in there gets **Use a free model** on the
    sign-in strip, on a draft or an open chat (iOS: on the chat's sign-in
    card, which also re-sends a turn that stopped on the sign-in, once the
    model change succeeded);
  - the app banner says **Free models are ready** (accent) instead of the
    missing-provider warning, once OpenCode is on the machine.
- **Download at launch.** A computer with no sign of any agent downloads
  OpenCode at launch (`agentToolDemand.ts`, `signals` policy
  only). The banner, the first-run OpenCode tile and a waiting draft follow
  the tools cache's push (`renderer/lib/toolsCacheEvents.ts`), this computer
  only.
- **Other machines.** Every read and download goes to the composer's
  machine: the status through the pinned status cache, the download through
  `pinnedToolDownload` with the picker's pin. The phone and the web client
  reach the same calls as `ai.pinnedToolStatus` / `ai.pinnedToolDownload`
  remote commands.
- **Analytics.** One `ade_feature_used` (`feature: chat`, `action:
  free_model_used`, `provider: opencode`) per chat, on its first settled
  turn on a free model. The model id goes only to `$ai_generation`.

### Attachment handling

- **One pipeline.** The whole chat surface accepts the composer's file and
  image-URL drops; composer drops are handled once. Files use
  `ade.agentChat.saveTempAttachment`; clipboard images prefer
  `ade.app.saveClipboardImageAttachment` (writes the PNG, returns a small
  preview). During a save, send is disabled and the tray shows a cancellable
  thumbnail.
- **The tray** (`ChatAttachmentTray`, composer and sent messages): images get a
  thumbnail and a copy button (`window.ade.app.writeClipboardImage`); other
  files get a chip with `getFileIcon`, a middle-truncated name, size (only
  for files this composer staged) and ×. Chips are focusable (Delete removes,
  Enter opens, arrows move). Clicking opens the lazy
  `ChatAttachmentPreviewModal`, which uses the Files tab's viewers
  (`resolveViewerKind`, `ViewerHost`), found by
  `resolveAttachmentWorkspaceTarget` on the chat's machine; an image outside
  every workspace falls back to the chip's bytes.
- **iOS Simulator selections** become `IosElementContextItem` chips
  (`data-ios-context`), serialized by `formatIosElementContextForPrompt` with
  `componentId`, source file and line. A screenshot from the same selection
  within 10 s links through `attachmentPath`. See
  [Apple device](../apple-device/README.md).
- `inferAttachmentType` and `mergeAttachments` (`shared/types/chat.ts`) dedupe
  by path, last write wins.
- **Image types.** `PROVIDER_IMAGE_BYTE_MEDIA_TYPES` (`providerInlineImage.ts`:
  JPEG, PNG, GIF, WebP) is the one allowlist. Any other image is sent as the
  text reference `[Image attached (image/svg+xml): <path>]`
  (`imageAttachmentReferenceText`) on every provider. OpenCode uses runtime
  content blocks.
- `normalizeImageAttachmentFilename` renames an image with a missing or wrong
  extension on both staging paths.
- **Thumbnails.** Every `getImageDataUrl` route reads through
  `readImageFileAsDataUrl` (`imageAttachmentConverter.ts`): type from the bytes
  (`shared/imageSniff.ts`); TIFF and HEIC become JPEG through `sips` on macOS.
  Other hosts return the bytes; the desktop tray shows its placeholder if they
  do not draw.
- **Stage cap and inline caps differ** (`shared/chatAttachmentLimits.ts`).
  Images inlined into a request are fitted by `fitImageForProviderInline`
  (PNG/JPEG down to 1568 px). Every inlining path (Claude sends and steers,
  OpenCode, ACP, the Cursor/Pi/Droid workers) fits or substitutes a path
  hint, so a big file degrades the message instead of failing the turn. A
  Claude `terminal_reason: "image_error"` gets "Claude couldn't read an
  attached image", and the SDK's `<synthetic>` model never replaces the
  turn's model.
- **Remote hosts.** A host with `features.attachmentUploadV1` in `hello_ok`
  takes a streamed upload: a single-use ticket (`chat.createAttachmentUpload`,
  consumed before the first byte) and a POST to `/ade-attachments/upload` on
  its sync port. Older hosts, relay sockets and SSH use
  `chat.saveTempAttachment` (10 MB). **iOS sends images through the
  10 MB command.**
  - Pasted bytes: preload's `agentChat.saveTempAttachment` sends them to
    `IPC.remoteRuntimeUploadChatAttachment` for an upload-capable paired
    machine. `remoteConnectionService.uploadChatAttachmentBytes` enforces the
    smaller of `maxBytes` and `MAX_CHAT_ATTACHMENT_BYTES`, checks the encoded
    length first, writes a private temp file (`withTempAttachmentFile`),
    uploads and removes it. A failed upload is reported
    (`chat/attachment_upload_failed`) and falls back to the command only when
    it fits that command's cap; otherwise the upload's own error shows.
  - The composer captures the project binding and chat API before a batch;
    a project or machine switch stops the rest and rejects in-flight results.
    Errors include the underlying reason.
- **Attachment images** are read through `readAttachmentImageDataUrl(path,
  pin)`: a personal chat's own reader (`useChatImageReader`), else the pin's
  runtime (which allows the project, lanes, temp, Downloads, Documents and
  Desktop), and this computer's `app.getImageDataUrl` only as described in
  the source map. A remote path is never read here. A viewed image is cached
  per `version`.
- **File attachments over sync (iOS).** Documents and videos use a chunked
  base64 contract: `chat.beginTempFileAttachment` /
  `appendTempFileAttachmentChunk` / `finishTempFileAttachment` /
  `abortTempFileAttachment` (`apps/ade-cli/src/services/fileAttachment.ts`),
  50 MB, 512 KiB slices, a `.part` file renamed on finish; the host owns the
  ceiling. The ref has type `File`. `chat.getAttachmentChunk` reads them back
  for previews. The phone enables "Attach file…" / "Attach video…" only when
  the host lists `chat.beginTempFileAttachment` (else "Update ADE on your
  computer to attach files and videos."); personal chats hide them.
  `workChatFileAttachmentAvailability` decides, and
  `SyncService.saveChatFileAttachment` re-checks.
- **iOS composer.** Attachments upload when staged, so Send stays live and the
  saved draft holds refs (`WorkComposerDraftStore.Entry` v2). Offline bytes go
  to `Caches/ade-composer-drafts/<key>` (≤5 files, ≤10 MB), purged on send,
  clear and eviction. A collapse control (`keyboard.chevron.compact.down`)
  lowers the keyboard, clamps the field to one line and shrinks chips to 24 pt.
- Parallel launches give every child the same refs after the 12-file check.

### A slow or dropping link to the chat's machine

The composer adapts to the chat's machine (`shared/slowLinkMode.ts`; see
[Remote runtime](../remote-runtime/README.md#a-slow-or-dropping-link)).

- With slow-connection mode on, a `Slow connection · <rtt> ms` chip shows in
  the status strip (the hover explains tap-to-load pictures and terminal
  type-ahead).
- A pasted picture shows its pending tile at once. Over 128 KiB, to a machine
  with `chatAttachmentParts`, it goes in resumable parts that each say where
  they start (`chatAttachmentParts.ts`, `remoteAttachmentParts.ts`).
- **`clientSendId`.** The composer keeps the id of an unconfirmed send, keyed
  by chat and the whole payload, and reuses it for the same payload, so the
  machine never writes a message twice. The id is forgotten once confirmed.
- The brain writes that id on the message it wrote for the send
  (`AgentChatEvent.user_message.clientSendId`). A pane that sees it, here or in
  the transcript after a reconnect, treats the send as delivered whatever words
  the message holds: its words, files and context never go back in a composer
  or saved draft. An older brain writes no id, so only its id-less rows count by
  words; a row that names another send is never evidence for this one.
- A send that lost its answer shows "Sending is taking longer than expected"
  and holds the words for up to two minutes while it checks the chat. A send to
  another machine then waits for that machine's link to settle (at most ten
  minutes, then the text goes back), because its message and id show only once
  the chat's history does.
- An older machine gets one upload request and a new id per send.

## Voice conversations

A voice conversation lets the user talk with any chat. It always runs on the
Codex app server's realtime API (`thread/realtime/*`, protocol `v3`, WebRTC)
with the user's ChatGPT sign-in, on desktop only.

- **Who sees it.** The waveform button shows when "Voice conversations" is on
  (Settings → Chat), Codex is signed in on the chat's machine
  (`availableProviders.codex`), the surface is the desktop app, and the
  composer is not a grid tile or parallel launch. Free, Go and API-key Codex
  sign-ins get a clear refusal at start.
- **Audio path.** The renderer (`useCodexVoice`) owns the mic, the
  `RTCPeerConnection` and playback. It sends only its SDP offer to the brain
  (`chat.startCodexRealtime`) and gets the answer and a token; audio never
  passes through ADE. Do not trim the offer (SDP lines end in CRLF; OpenAI
  answers "unmarshal SDP: EOF"). Always send `version: "v3"`.
- **Which brain.** `startCodexRealtime`, `stopCodexRealtime` and
  `getCodexRealtimeState` carry the chat's pin (`useChatRuntimeScope().pin`),
  kept for the whole call. Audio still flows from the user's computer.

| Mode | Chats | Where voice runs | How a request reaches the chat |
|---|---|---|---|
| native | Codex | The chat's own Codex thread | Codex runs each hand-off as a turn on that thread; ADE adopts the turn (also on the resumed-turn path) and shows the spoken request as its user message. |
| host | every other provider | A private `codex app-server` with every config.toml MCP server switched off (`codexMcpOff.ts`) and one ephemeral relay thread (`codexVoiceHost.ts`) | The relay turn replies only `[RELAYED]` (GPT-6 Luna, low). ADE sends the spoken text to the real chat with `sendMessage` or an inline `steer` and narrates that chat's turn. |

Both modes set `clientManagedHandoffs: true`, so ADE alone decides what voice
says. A spoken request is a `user_message` with `metadata.voiceInput` ("Spoken"
with a mic glyph). Subagent start and finish reach the session as context; a
finish is spoken.

**Narration** (`codexVoiceNarration.ts`) streams the turn's prose into speech:

- A sentence at a time; a paused stream flushes after `SPEECH_FLUSH_MS`.
- Fenced code is dropped whole and markdown stripped (`speakableText` for an
  unstreamed turn).
- Milestones (a plan, a long command in `chatty`, an error, a subagent
  finishing), gated by `NARRATION_MIN_GAP_MS`, once per turn.
- A progress line after `NARRATION_IDLE_MS` of silence; the model's own speech
  (`thread/realtime/outputAudio/delta` → `lastSpokeAt`) counts.
- The turn's end says only what was not streamed.
- **The user wins.** There is no cancel call, so `speakNow` refuses within
  `BARGE_IN_HOLD_MS` of the user's transcribed words and drops (does not
  queue) that narration. `speakResult` defers a result instead.
- `updates`: `balanced` (default) and `chatty` narrate; `quiet` acks and reads
  the answer once.
- The developer item makes voice a narrator: work in progress has not
  concluded, a result is stated only from the agent's finished message, and
  the user may cut in.

**Ending.** `asksToEnd` matches the user's own words ("end the call", "hang
up", a bare farewell) and closes after `END_GRACE_MS`; negations and questions
back out. `speakNow` refuses once closing. `handleHandoff` checks `asksToEnd`
first, so an end request never goes to the agent.

**The bar.** `CodexVoiceBar` is the composer's own top row (`voiceBar` slot on
`ChatComposerShell`): waveform, newest caption, state word, timer, mute and
end. Only the waveform moves. States: Connecting, Listening, Speaking, Working,
Muted. Captions come from `chat.getCodexRealtimeState`, polled every 300 ms
only while live. Small talk stays out of the thread.

**The card.** A finished session leaves a `system_notice` with `status:
"voice_session"`: a one-line `message` ("Voice conversation · 2:26 · 8 requests
· 5 handed to the agent"), the transcript in `detail`, and the numbers in a
`voiceSession` field beside them (an object `detail` would print as JSON on
iOS). `VoiceSessionCard` draws it as a `ChatCard`.

**Context and style.** Voice gets Codex's startup context plus an ADE developer
item: chat, lane, worktree, model, these rules, the `codexVoice` preferences
(`shared/codexVoice.ts`: personality, voice, name, updates, language) and the
last 12 messages. Codex's own voice instructions stay. `v3` uses the older
voice list (cove default).

**Cost.** $0.05 a minute of the plan's Codex allowance (1.25 credits a minute
on credit billing). Handed-off work bills the chat's provider; a relay turn
costs a fraction of a cent.

**Lifecycle.** One session per chat; a new start replaces the old (which sees
`status: "ended"`). Switching chats, closing the window, a non-voice surface, a
Codex restart or OpenAI closing ends it with the reason. A stop during connect
still ends the brain session. The CTO chat uses the same button.

## Chips

Every pill comes from one model, `shared/chips.ts`: the `@chat:` / `@lane:` /
`@term:` / `@pr:` / `@mac:` / `@mcp:` mentions, model and permission mentions,
smart links, file and folder paths, and the transcript's skill, artifact,
commit, branch and web-page chips. A `Chip` carries its canonical `token` next
to its `label`:

- **Copy and cut** write tokens to `text/plain` and labels to
  `text/x-ade-composer` (`shared/composerClipboard.ts`).
- **Paste** registers each label (`onMentionLabelChange`) before rebuilding
  pills, so a paste into another chat works.
- **Sent messages** render through `splitTextIntoChipParts` (`ChipText.tsx`).
  A chat, lane or terminal mention opens through its owning machine; a machine
  mention opens its facts card; a PR mention resolves ADE's row id first; an
  MCP mention opens this computer's MCP Settings on that server.
- **ADE deeplinks** go through `deeplinks.ts`, so `ade://pr/...` is a PR pill.
- **Folders** are chips (`fileSearchIndexService.ts` keeps directories in a
  separate map); a folder is a pointer, never an attachment.

### The four surfaces, and what each one owns

| Surface | What it draws a chip from |
|---|---|
| Desktop composer | `contentEditable` spans (`contenteditable=false`, `data-composer-chip`, `data-composer-chip-text`); `composerChipDom.serializeComposerDom` serves send and copy. |
| Desktop transcript | `ChipText.splitTextIntoChipParts` over `event.text` for user bubbles, and `remarkThreadEntities` ([Entities an agent's reply names](#entities-an-agents-reply-names)) over assistant markdown and briefs. Stored text is unchanged. |
| iOS | Swift ports (`WorkComposerTypedTriggers.swift`, `WorkStatusAndFormattingHelpers.swift`) held to `shared/__fixtures__/chipCases.json`. `@mcp` draws a named chip; a machine mention opens a native sheet. |

Only one surface can import the model, so the fixture exists, and the
`test-ios` gate watches `apps/desktop/src/shared/__fixtures__/` too.

### Model chips

One pill names a model, a thinking level and a permission mode.

- **Token.** `@model:<registry-id>?effort=<level>&perm=<mode>`
  (`shared/modelMentions.ts`); both keys optional; `perm` is `default | auto |
  plan | edit | full-auto`, as `ade chat create --permissions`.
- **Menu.** A "Models" section (`rankComposerModelSuggestions`) shows a model
  only when the query names it (two or more characters); a query starting with
  `model` lists all, and a name hit puts the section first (`@deep` + Tab). The
  list is every model a new chat could start on (`mentionModelIds`). Among
  equal matches, recent picks lead (`rankComposerModelMatches`
  `recentModelIds`, the picker's recents; an `@` pick records one). A better
  match always wins.
- **Editing** (`composerModelChip.ts`). After insertion the thinking part opens
  at the model's default. Tab moves thinking → permission → out, Shift+Tab
  back, arrows change the value, a letter jumps, Enter or Escape leaves. A
  click reopens a part. No thinking levels, no thinking part. The list is
  `ModelChipSegmentMenu` on `AnchoredMenu`.
- **Send.** `chatMentionService` expands each model token into an
  `<ade-mention kind="model">` block with the exact `ade chat create` and
  `ade chat handoff` flags. An unknown model is `resolved="false"` (ask, do
  not guess); an unsupported level is dropped and named.
- **Transcript.** The label is `Display name · Level · Mode`. **New chat with
  this model** opens an unsent Work draft in the same lane and machine with
  those settings, when the machine's catalog has the model.

### Local files an agent embeds

Markdown image syntax for a file on disk (absolute, workspace-relative or
`file:`) goes from `chatMarkdownBlock.tsx`'s `img` override to
`ChatInlineMedia.tsx`, not an `<img>` the CSP blocks. `http(s)` / `data:`
images and `ade-proof://` keep their paths.

- It resolves like a link (`resolveWorkspaceMediaTarget`,
  `chatWorkspacePaths.tsx`) on the chat's machine, with a 30 s cache, and only
  near the viewport.
- An image draws inline (up to 25 MB) and opens in Files. Audio gets
  `ChatInlineAudio` (play, seek, time, mute, 1×/1.5×/2×, Open; no bytes before
  Play; one clip at a time; Retry after failure). Video streams on Play. Other
  files are a chip; a path outside the machine's workspaces is a muted chip
  saying so.
- Reads are `streamFileBytes` over `createPinnedFilesApi(pin)`, capped at 100
  MB, into a Blob URL revoked on unmount.
- A sent audio attachment uses the same player.

### Entities an agent's reply names

`shared/threadEntities.ts` turns names an agent writes (lane, chat, model,
permission mode, slash command, PR, commit, Linear issue, zoned timestamp, a
line range after a file) into the composer's pills:

- **Only real things.** A lane or chat chip needs a match in the surface's
  index; an unknown id stays code.
- **Inline code is the strong signal.** `matchInlineCodeEntity` reads whole
  code spans: explicit tokens (`@lane:…`, `@model:…`, `ade://`), lane names,
  ids and unique 8+ character prefixes, `@mcp:…`, distinctive permission
  values, `#123`, `/skill`, a known `TEAM-123`, a zoned ISO timestamp, a bare
  `3461-3468` after a file in the same block, a commit SHA, and a registry
  model with `-` or `/`.
- **Prose is narrow.** `findProseEntities` matches only full UUIDs, zoned ISO
  timestamps, `PR #123` and known Linear keys.
- **The token stays the truth**, so hover shows the original.

Lane names, colours, chat titles and live dots resolve on the chat's machine;
a timestamp shows local time. iOS ports the rules
(`WorkThreadEntityRules.swift`) without the line follow-up.

### Settings and page chips

An agent asked where something is runs `ade settings find <words>` (from
`shared/settingsManifest.ts`, no brain call) and writes the printed link;
`[user only: <why>]` marks settings only the user changes.

- **`ade://settings/<id>`** draws a `setting` chip labelled with the manifest
  path (`App › Studio › Providers › AI connections`), never the agent's text.
  A Computer page adds the chat machine's name unless the link names
  `?machine=`; Appearance and Apple devices never do. Long paths shorten in
  the middle.
- **A lock** replaces the gear on protected settings (publishing, sign-ins,
  money, agent reach, the computer, data); the card says "Only you can change
  this" and why.
- **The click** opens the card; a Computer page opens on the named machine,
  else the chat's (`chatSettingsMachineId`). A setting this window cannot show
  is muted and explains why.
- The chip uses the theme accent (white glass on the user's bubble).
- **`ade://open/<place>`** draws a `place` chip for a page in
  `shared/openPlaces.ts`; open-only, and outside `open` links are refused.
- **iOS** labels both from `WorkSettingsCatalog.swift`
  (`generate-ios-settings-catalog.mjs`, `--check` in CI) without linking them.
- An `ade://` link in backticks is never a workspace path
  (`parseWorkspacePathLocation`).

### Chips are pointers, so pointers need hover cards

`ChipHoverCard.tsx`, `chipMenu.ts` and `chipActions.ts` give a hover/focus card
and a right-click menu; the primary click runs the target action. Cards cover
PRs, lanes, chats, terminals, models, permission modes, skills, artifacts,
commits, branches, web pages, machines, MCP servers and issue links.

- **No focus theft**: a `pointer-events-none` `role="tooltip"` portal.
- **Lazy**: reads start when the card opens; missing data drops details.
- **Owning machine**: chat, lane, terminal, commit, skill, artifact and PR
  reads use the chat's pin; machine facts come from the account directory and
  the connection snapshot.
- **Contents**: terminal (title, lane, tool, state, start), model and routing
  facts, permission and skill explanations, artifact kind and time, commit and
  branch facts, cached web title and host, and MCP cached state, transport,
  tools and the last redacted error (never a probe).
- **Machine mentions** (`@mac:<key>`) use the account directory's TTL cache
  and the Connections presence resolver; **Open in Connections** focuses the
  machine. iOS uses a native sheet.
- **MCP mentions** are references only: they attach no tools and grant
  nothing.
- **Model chips** offer **New chat with this model** (an unsent draft).
- **Enrichment.** `chipPreviewStore.ts` lets the transcript reuse the
  composer's title and favicon route, so a sent link keeps its preview.

## Message list

`AgentChatMessageList` uses a **hand-rolled virtualizer** (not
`@tanstack/react-virtual`): a `measuredHeights` row-key → height `Map`, top
and bottom spacers, and `MeasuredEventRow` `ResizeObserver`s feeding
`handleMeasure` → `reconcileMeasuredScrollTop`, so a correction above the
viewport does not move what the reader sees. Short transcripts render
unwindowed.

**Rows.**

- Assistant cards cap at `max-w-[78ch]`. User messages spring in
  (`motion/react`) and render in full, with no clamp. A markdown-length user
  message (`userTextLooksLikeMarkdown`) renders as markdown (`MarkdownBlock
  tone="bubble"`). A `metadata.hideFullPrompt` message shows and copies only
  its `displayText`, with a brief chip.
- Code blocks use `HighlightedCode`; tables get rounded borders; system
  notices are compact; `ChatTurnDivider` separates turns.
- A `Woke on schedule` divider precedes each scheduled turn. Real subagents
  get inline `SubagentSpawnCard` / `SubagentResultCard` rows; backgrounded
  shell runs get `BackgroundJobRunRow`.
- A run of `codex_image_view` events in one turn folds into one `Viewed N
  images` strip; a local thumbnail reads through the chat's machine.
- An interim narration line (any assistant text row but the turn's last)
  floats its hover actions below the row instead of reserving a strip.
- Assistant text has an icon-only Copy; the turn-end row has Copy turn (that
  turn's assistant text only).
- A Claude `queue_recovery: available` row shows one eight-second Undo card;
  later `restored` / `expired` rows settle it.
- Plan approvals render their body as markdown, uncapped in the transcript.
  The pinned `ChatProposedPlanCard` caps at `min(52vh, 560px)` so
  **Implement** and **Keep planning** stay reachable.
- Codex goal rows read `Goal set` / `Goal paused` / `Goal cleared`. A stalled
  Codex turn shows a Wait / Nudge / Retry / Resume card
  (`agentChat.recoverCodexTurn`). A failed turn is one `TurnFailureLine`.
- A fork's seeded history gets one `Forked from the previous chat — full
  history above` divider (`computeForkHistoryDividerRowKey`).

**Scrolling.**

- **Sticky bottom.** A pinned reader stays pinned through streamed growth,
  late measurements and a shrinking viewport. The content `ResizeObserver`
  pins in the same frame; a pin commits `scrollTop` only when it changes what
  the list draws (`commitPinnedScrollTop`); a pinned reader's growing last row
  takes no measure tick.
- Plain scrolling commits no render: `handleScroll` commits only when the
  window or the active minimap tick changes (plus one after settling). Row
  offsets cache on a measured-heights version.
- The native scrollbar is hidden; the minimap is the position control.
- **Jump to latest** reads `N new · Jump to latest` (`countRowsAppendedSince`)
  or `Jump to latest`; it docks in the chip row when a chip shows, else floats.
- **Older history pages silently.** A head sentinel (plus an underfill effect)
  starts about two viewports out (`resolveOlderHistoryPrefetchTriggerPx`, 300
  px before measuring), one page at a time. `readOlderHistoryBatch` pages
  until it holds a user message. `couldn't load earlier messages · retry`
  shows only after both backoff retries fail (`OLDER_HISTORY_RETRY_DELAYS_MS =
  [800, 2400]`); retry is one immediate request. The slot height is constant.
  Late results for another chat, binding or cursor are dropped.
- **Idle backfill** (Work pane only): `backfillOlderHistory` loads one page
  per idle slot until the history is resident, stopping at the resident cap.
  Other owners page on scroll only.
- **The minimap** (`ChatUserMinimap`) is a direct child of the list root. It
  ticks only messages the reader typed, draws up to 50 at once with
  earlier/later controls, and stays attached as history loads.
- PRs open in the lane's PR Work tool, not over the transcript.
- **Scroll memory.** The list remounts per chat (`key={renderedSessionId ??
  "chat-draft"}`) but not for nested transcripts; `scrollMemoryKey` separates
  the parent and each `subagent:<session>:<taskId>`. A module LRU
  (`chatScrollMemoryBySession`, 32) keeps `wasPinnedToBottom`, `anchorRowKey`,
  `anchorOffsetPx` and `lastSeenRowKey`. A pinned reader returns pinned;
  otherwise restore waits for a non-zero height, then corrects once after real
  measurements, unless the reader scrolled. The anchor uses
  `measuredRowStartOffsets`, as do the prepend anchor and the minimap.
- **iOS** uses the same contract: a head sentinel, 256 KiB host pages, words
  only while loading or after a failure, and `LazyVStack`. Chat Info owns the
  subagent roster; lifecycle cards stay inline.

Rows come from `chatTranscriptRows.ts` (see
[transcript-and-turns](transcript-and-turns.md)).

### Row identity stabilization

`events` is a new array on every delta. `useStableIdentity(value, isSame)`
returns the previous reference when a cheap comparison (`sameMapContents`,
`sameSetContents`, `sameKeyList`) says nothing changed, for
`resolvedInputStates`, `resolvedInputAnswers`, `staleInterruptReceipts`,
`settledQueueRecoveryIds` and `groupedRowKeys`. `groupedRowKeys` matters most:
it feeds `rowHeight`, `handleMeasure` and every row's `ResizeObserver`.

### Paced text reveal

The paced reveal is **off by default**: at the brain's 100 ms buffer, paint on
arrival looks the same and costs half the main-thread time
([PandaCode streaming](../../perf/macos-baseline.md)). The store is never
delayed.

- With pacing off the streaming row still splits: settled text renders as one
  memoized body per piece (`settledSegments`), and only the tail re-parses. A
  reply with a link reference or footnote definition outside a fence parses
  as one body. A finished row is one body through the parse cache.
- `AgentChatMessageList` paces one row: the trailing `text` row of a
  streaming turn, found within `PACED_TEXT_ROW_SCAN_DEPTH` (8) rows, via
  `pacedTextReveal`. Subagent views pass `textPacingEnabled={false}`.
- The cut is the last blank line outside fences, so the settled half is
  byte-identical between frames.
- Turn it on with a positive `ade.textRevealHorizonMs` in `localStorage` and
  a reload (read once per session). See `textReveal.ts` and
  `useRevealedText.ts` in the source map for the step, clamps and frame rules.

## Mermaid diagrams

A ` ```mermaid ` fence in an assistant reply draws as a diagram
(`MarkdownBlock`'s fence handler, `chatMarkdownBlock.tsx`); a fence in the
user's own message stays code.

- Edge labels sit on the app background (`edgeLabelBackground`).
- While a fence is still open during streaming (`openFence`,
  `shared/chatScene.ts`), it stays highlighted code; closed diagrams above it
  stay drawn.
- A row under the diagram toggles to code and copies the source; a click opens
  it in `MediaLightbox` (one blob URL at a time).
- Chat, PR markdown (`PrMarkdown`) and markdown files (`RichMarkdown`) share
  `components/shared/MermaidDiagram.tsx`: mermaid loads on the first diagram,
  renders at `securityLevel: "strict"` with HTML labels off (both on mermaid's
  `secure` list, so `%%{init}%%` cannot change them), one at a time (global
  config), cached per source and theme (64 settled entries; pending never
  evicted). A failed import shows Retry; a parse error shows mermaid's message
  above the source.
- iOS shows the fence as code.

## Tasks section

Chat Info (`ChatSubagentsPanel`) shows **one** Tasks section: the chat's task
list from `deriveChatTaskList()`, whatever wrote it (see
[One task list per chat](transcript-and-turns.md#one-task-list-per-chat)). It
is always expanded, uncapped and in provider order, drawn by
`ChatTaskListView`. A plan shows `label  done/total`; a bare todo list puts
the count on the header. `AgentChatPane` passes it as `taskList` (else the
panel derives it from `events`). A cleared list, a plan-mode proposal and a
plan with no steps are not content.

## File changes panel

A turn shows its tools and files as one expandable `N tools · M files` line
above the done row's time/usage row. Which summary renders depends on whether
the turn moved HEAD; a done row whose turn has a `turn_diff_summary`
suppresses the fallback, so a turn never shows two. `work_log_group` rows are
dropped. iOS follows the same turn-end contract
([transcript-and-turns](transcript-and-turns.md#render-pipeline)).

- **Checkpoint-backed** (`ChatTurnFileChangesPanel`, from `turn_diff_summary`):
  file count and totals; expanded, **This turn** and **Full thread** (summaries
  merged, advancing `afterSha`), both through `ade.agentChat.getTurnFileDiff`
  and `AdeDiffViewer`. Reverting lives here (it owns the SHAs).
- **Entry-derived fallback** (`ChatTurnFilesChangedSummary` in
  `ChatWorkLogBlock.tsx`) for a turn with no checkpoint: the turn's
  `file_change` and write-tool entries, deduped by path, as `N files changed +A
  −D`. Rows show the lane-relative path, open in Files and expand the entry's
  diff. **Review in Files** only opens the Files tab.

## Rewind files confirmation

Claude and Codex user messages offer undo when the provider can prove a
target.

1. The pane calls `ade.agentChat.rewindFiles({ dryRun: true })`.
2. `rewindFilesPreview.ts` pairs each reported file with the earliest
   `beforeSha` and latest `afterSha` from later turn summaries.
3. The dialog shows the message and its time, the dry-run totals, one row per
   file (status and stats when known) and lazy `AdeDiffViewer` previews.
4. Confirm calls `rewindFiles` without `dryRun`.

Claude restores files only. Codex also moves the thread back: `thread/fork`
with `beforeTurnId` on app-server 0.145.0 or later, else the deprecated
`thread/rollback`, limited to the latest user message (see
[agent-routing](agent-routing.md#codex-rewind-and-0145-readiness)).

## Chat Info and subagents panel

`ChatSubagentsPanel` draws the Codex goal, the task list, subagents
(`subagent_started` / `_progress` / `_result`), background work and Schedule in
**one scroller with sticky section headers**.

**Rows.**

- A sentence-case model chip from `subagentModelAttribution`: a reported
  `model` is ground truth; else the parent's label marked **inherited**
  (display only). Inspecting a subagent switches the header to the child's
  attribution and locks the model picker without changing the parent's
  `modelId`.
- Running durations tick once a second from the wall clock; finished rows
  keep their final time.
- Square stops are labelled `Stop ${agentType}`; `chat:` rows have none.
- **Spawned chats** (`ade chat create --parent` from a tracked shell) list via
  synthetic `subagent_*` events keyed `chat:<childSessionId>`.
  `deriveChatSubagentSnapshots` keeps that id and `spawnKind` when the
  dot-form twin merges, and sets `childSessionId`; the row shows the child's
  live title and runtime chip and opens on the parent's machine. The parent
  transcript gets a "Subagent spawned" chip (`status: "subagent_spawned"`).
  Chats filed under this one on the same machine and lane, grandchildren
  included, come from `filedSubagentsOf` (`chatSubagentRoster.ts`); a waiting
  child reads **needs you**.
- Native Claude subagent text is not forwarded. Child frames carrying
  `parent_tool_use_id` are filtered from the main timeline; a user steer
  always carries `parent_tool_use_id: null`.
- The transcript also shows identity-anchored spawn/result cards
  (`chatTranscriptRows.ts`; a backgrounded shell is one `background_job_line`).
  `deriveSubagentTimelineRows()` (`shared/chatSubagents.ts`) is the portable
  shape iOS mirrors (`buildWorkSubagentTimelineRows`), with a background shell
  as one chip.

**Badge and auto-open.** The Work actions badge shows the proof count, else
running subagents, else `done/total` of an unfinished task list. The drawer
opens once per chat when subagents, a task list (a plan counts) or scheduled
work first appear.

**Schedule.** `deriveScheduledWorkSnapshots()` folds wakeups, cron, `/loop`,
remote triggers and background work into rows (kind, status, details, ids,
fire times, late).

- A parent turn ending never marks a running background row `stopped`; only a
  terminal update or teardown does.
- `background_tasks_changed` keeps the query alive past idle cleanup and
  decides whether `local_bash` is backgrounded.
- Stop-hook snapshots keep child shell/Monitor rows; native Agents and
  workflows stay in Subagents only.
- The header's pause/play calls `agentChat.setScheduledWorkPaused`; paused
  rows dim; on resume overdue work fires once. Cron rows read `last ran <time> ·
  next <relative>`. The runtime's scheduler owns the timers.

**Large rosters** (`shared/chatSubagents.ts`, mirrored on iOS): Subagents cap
at 12 active rows, Background 8, Schedule 10 (Tasks uncapped), with **Show
all** (reset on remount). Finished rows go into one `Completed (N)` fold
without re-sorting; failed and pinned rows stay active and uncapped. Clear
(while the fold is open) hides finished ids and Restore brings them back,
scoped per chat. Fired one-shot wakeups keep their time and `late` mark. iOS
shows the roster only in its Chat Info sheet.

**Interrupt** emits `subagent_result` `status: "stopped"` for each started
subagent. In the transcript two or more same-cause stops fold into one
`SubagentStoppedGroupCard`: `<n> agents stopped when you interrupted` or `<n>
agents stopped · usage limit`, not an error.

**Claude Workflow runs.** `claudeWorkflowProgress.ts` normalizes
`workflow_progress` and fans each workflow agent out as a row (phase, tokens,
duration, `workflowName` chip); the parent row rolls up phases and counts. A
**Workflow activity** card above the roster opens a modal with the phase rail,
counts and per-agent details; it traps focus, closes on Escape or backdrop,
hides the raw prompt and can stop the parent workflow (which owns the stop).

**Codex parallel agents** come from `collabAgentToolCall` and
`subAgentActivity` items. The service registers each child thread for
backfill, carries `label`, `model` and `reasoningEffort`, and emits the same
events. `failed | errored | rejected | refused | denied` map to `failed`;
`stopped | interrupted | shutdown | notfound | cancelled | canceled` to
`stopped`; `readCodexCollabFailureSummary` pulls the reason from `item.error`,
`item.result` or `item.contentItems[*].text`. `deriveChatSubagentSnapshots`
(`chatExecutionSummary.ts`) keeps siblings under one `parentToolUseId`
distinct, adopting the placeholder only when exactly one resolves.

**Row titles** (`agentType`):

| Runtime | Title source |
|---|---|
| Claude | The Task tool's `input.subagent_type`, stashed at `tool_use` (`runtime.taskToolInputByToolUseId`) and joined onto `task_*` envelopes via `parentToolUseId`; cleared at turn end and completion. |
| Codex | `Agent #N` from `assignCodexAgentLabel`, per turn (`runtime.codexAgentIndexByTurn`); the thread id stays `agentId`. |
| OpenCode | No `agentType`; the row uses `session.title` (the `description`). |

## Chat Actions and Sources

`ChatActionsDrawerPanel` (tree icon left of the Tools toggle) is one scroll of
sections the host passes in order, each only when it has content: progress
(goal, tasks, subagents, background), proof (one or more artifacts), Droid
mission (features or progress), sources (`hasChatSources()`, checked only
while open). `ChatSubagentsPanel` is always passed and renders `null` when
empty.

- Dividers only between rendered sections (`[&>*+*]:border-t`); no section has
  its own border, height or scroller (in `variant="pane"`, no `h-full`,
  `min-h-full` or inner `overflow-y-auto`), in the floating card and the split
  pane.
- Empty: "Nothing here yet. Agents, tasks, proof and sources show up as the
  chat runs." (also via `only:block` when every section rendered `null`).

**Handoff** is on the session card's context menu: Lifecycle → **Hand off…** →
**Local handoff**, **Another machine**, **Auto handoff…** (**Edit auto
handoff…** / **Remove auto handoff** when rules exist). The menu queues the
destination (`lib/chatHandoffIntent.ts`) and selects the row; that chat's pane
opens the surface. A running turn does not disable the rows; each surface
keeps send disabled until the turn ends.

- **Local handoff** opens a modal (`ChatHandoffDialogs.tsx`) with fork/brief,
  lane target and note, starting in fork mode on the current lane.
- **Another machine** opens `CrossMachineHandoffModal`: source blockers, a
  machine on the account, brief or fork, a note, the destination's preview
  failures, and what moves, before confirming. It opens for every chat,
  including one on another machine: calls go through `chatRuntimePin` (frozen
  per operation) and that brain runs the move. See
  [Cross-machine session handoff](../sync-and-multi-device/cross-machine-session-handoff.md).
- **Auto handoff…** opens `AutoHandoffModal` (from `SessionContextMenu`).
- The dialogs use Radix Dialog and set `PortalContainerContext`, so the
  `LaneCombobox` list stays clickable; Escape closes only an open list.
- The quota card's **Fork in this lane** opens the form in fork mode with its
  note.
- The form picks a target model other than the source's when one exists, and
  keeps choosing as the catalog grows until the user picks.

**Sources** (last section, Codex chats; Droid missions sit under proof).
`deriveChatSources()` builds **Files** (attachments, image URLs), **Apps &
tools** (MCP servers and connectors grouped by app), **Web** (queries and
results) and **External resources** (HTTP(S) links and resource URIs from MCP
results, Linear context). It is bounded, recursive only for JSON results,
deduplicated, and skips `node_repl`. Only allowed HTTP(S) rows click
(`openUrlInAdeBrowser`).

## Terminal drawer

`ChatTerminalDrawer` is a collapsible drawer at the bottom of the chat. Each
tab is an untracked shell PTY in the current lane, drawn by the shared
`TerminalView`. Tabs track exit state; removing the last tab closes the drawer.

- A chat-owned terminal created elsewhere (an agent's `ade --socket app-control
  launch`, the localhost strip's "Logs") is deduped into the drawer:
  `AgentChatPane` watches `window.ade.sessions.onChanged`, and
  `revealCreatedTerminal` calls `ChatTerminalDrawer.openTab`, which matches by
  `sessionId` / `ptyId`.
- The drawer mounts only when lane tool drawers show; Work grid tiles pass
  `hideLaneToolDrawers`.

## Pending input card

The question surface is **in the composer**: `AskQuestionComposer` replaces
the textarea inside the same prompt-box frame, so nothing shifts when it
resolves. Question kinds have no `pendingBanner`; `plan_approval`,
`model_selection`, `approval` and `permissions` keep banners because they
carry real controls.

- The transcript keeps the record: `OpenQuestionReceipt` while open (a queued
  second question waits there) and `AnsweredQuestionReceipt` after.
- The pane draws `resolvedPendingInputsBySession[sessionId][0]`: the
  transcript derivation reconciled with the summary's `pendingInputItemId`,
  because an asker can outlive its turn and only main knows whether it still
  blocks. See "Pending input derivation" in
  [Fragile and tricky wiring](README.md#fragile-and-tricky-wiring).

### Answer semantics

`shared/pendingInputAnswers.ts` is the contract for desktop and web (iOS
mirrors it): `answerState` (`EMPTY`, `PICK`, `PICK_NOTE`, `NOTE`), `sendLabel`,
`buildAnswers`, `notePlaceholder`, `foldedSummary`,
`sanitizeAnswersForTranscript`.

1. **Both travel.** Typing never deselects; selecting never clears the note.
2. **Selection first**, note last.
3. **The Send label is the payload receipt** (`Send 1`, `Send 3 picks`, `Send 1
   + note`, `Send note`, `Send N answers`), derived from the state alone.
4. **Multi-question:** Send needs every question answered, except a lone typed
   reply (`isLoneTypedReply`): a `Send note` button beside `Next` sends it, and
   the other questions get `QUESTION_SKIPPED_FOR_REPLY_ANSWER`
   (`loneTypedReplyAnswers`), because Claude refuses a partial set. Enter
   still means `Next`.

- The note placeholder names its live job: `Your answer` (no options), `Or
  send your own response instead` (nothing picked), `Add a note (sent with
  your pick)`.
- Droid takes one string; `flattenAnswerForSingleStringProvider` labels the
  note instead of comma-joining it.
- **What the model hears.** `isQuestionKind(kind)` splits asking from
  allowing; an unknown or missing kind is an approval.
  - Decline (button or Escape) sends `QUESTION_DECLINED_MODEL_MESSAGE` (stop
    and ask in plain text, never "choose for me") for Claude `AskUserQuestion`,
    ADE `ask_user`, Codex `requestUserInput` and Cursor. Pi sends
    `QUESTION_UNANSWERED_MODEL_MESSAGE`.
  - `declineMessageForModel` picks `LIVE_QUESTION_DECLINED_MODEL_MESSAGE`
    ("keep working") for a live Codex question (`isBlocking: false`).
  - A Codex async question (`delivery: "async"`) sends nothing on dismiss; a
    cancelled Cursor planning question starts no turn.
  - `answersForModel` / `withTypedReplyNote` mark a typed reply with no pick
    ("eli5 please") as talking back, so the model answers it instead of
    re-asking; text naming only offered options ("A, B") is a choice. Claude,
    Codex, Cursor, Pi and `ask_user` apply it. Droid (`cancelled: true`) and
    OpenCode's question tool keep their own wording.

### Card behaviour

- **Select marks; `Next` / `Enter` advances.** A click never submits.
- **Hover changes no state.** Previews open on their own disclosure control,
  so the row never moves under the cursor.
- **Only the option list scrolls**; header, note and footer stay pinned. Rows
  fully below the fold get a `⌄ N more options` row on its own line.
- **Height (desktop).** `useOptionsMaxHeight` measures
  `[data-chat-appearance-root]` (transcript plus composer, which does not
  change as the card grows) and gives the list `clamp(260, height * 0.55,
  520)`. Measuring the transcript viewport would feed back into itself.
- **Minimize.** `⌄` beside `×` folds the card to one line (mark · `{header} —
  {question}` · `N/M` or `ANSWER` · `⌃`, from `foldedSummary`). It neither
  dismisses nor unblocks; picks survive. `×` is decline; keep the two apart.
- **Header**: `ProviderLogo(source)` and `pendingInputHeaderLabel(source,
  kind)` (`{Provider} asks`, `{Provider} · Plan ready`); paged sets get a dot
  rail (filled current, green answered); `N / M` sits in the footer.
- **Body**: the short `header` as a kicker, the question once, and a
  `description` only when it differs.
- **Options are a ledger**: one column, hairlines only, a flush-right `✓`, a
  constant leading number, `role="radio"` / `"checkbox"` in a `radiogroup` /
  `group`, a quiet `Recommended` label, nothing preselected.
- **Previews** (`QuestionOptionPreview`, `questionOptionPreview.tsx`):
  wireframes (`looksLikeWireframe` or `previewFormat: "html"`) in a
  `white-space: pre` block, prose through `ChatMarkdown`, inside the capped
  region; `⇄ Compare` shows two side by side when two or more options have
  previews.
- **Keys**: `1-9` pick, `↵` next/send, `←→` page, `esc` declines; digits in the
  note field are not captured.
- **Accent**: `var(--chat-accent)` on two things only (the header mark and the
  `✓`) plus a hairline top border meaning answer mode. `ChatProposedPlanCard`
  uses the same treatment.

### The free-text answer is the composer, not a second text box

The free-text field **is** the composer's `contentEditable` editor, so `@`, `#`,
smart links, image paste, drag-drop and the paperclip all work.
`AskQuestionComposer` takes it through `renderAnswerEditor`; without the slot
(mobile, tests) it falls back to a textarea.

- **The host owns the current question's text.** `answerValue` (with
  `onAnswerValueChange`) is the serialized string, chip tokens included; every
  all-question read (dots, count, payload) merges it in.
- **Paging moves the answer.** `goToPage` stashes the editor's text under the
  question left and loads the next one's.
- **Secret answers use a masked input**, never the rich editor (it cannot mask
  or keep the value out of the DOM). `allowsFreeform === false` gets no field.
- **`inField`** counts `input`, `textarea`, `isContentEditable` and
  `closest("[contenteditable='true']")` (the explicit `'true'`, because chips
  are `contenteditable="false"`). Without all four the card steals digits and
  handles Enter twice.
- **A question locks text, not files.** `canAttach` ignores
  `composerInputLocked`; staged files ride the **next** turn, the lock does not
  discard them, and submitting an answer leaves them.

**Responses** go through `ade.agentChat.respondToInput`
(`AgentChatRespondToInputArgs`: `answers` values `string` or `string[]`, an
optional `decision`); `ade.agentChat.approve` still works. Plan approval cards
take the plan text from the `ExitPlanMode` input.

**MCP elicitations.** Codex `mcpServer/elicitation/request` form-mode schema
properties become paged questions (enum/oneOf, boolean, primitive,
multiselect), coerced back to the schema. Approval/URL mode shows **Allow
once** and **Deny**, **Open authorization** only for safe web URLs, and
**Always allow** only when `_meta.persist` includes `always`. Claude
(`onElicitation`) raises the same card without **Always allow**. In a Claude
full-auto chat or automation run ADE answers it (an empty form is accepted, a
form takes schema defaults when every required field has one, anything else is
declined) with a notice; an unanswered Claude card cancels after 5 minutes.
Codex full-auto does not auto-answer. `serverRequest/resolved` closes a card
answered elsewhere.

### Private secret card

An agent never asks for a secret in chat. It runs `ade secrets request NAME
--reason "…" [--generate] [--timeout 30m]` (`project_secret.request`), and the
composer shows the secret card: name, reason, a password field with show/hide
and copy, "Generate a strong one" (32 random bytes as hex; `--generate` marks
it suggested), and "Saved to Passwords & Secrets for this project. The agent
only sees the name." Enter saves, Esc declines. An existing name opens on
"Keep existing" with "Replace" one click away.

- **Temporary private file.** The card also asks "Save to ADE secrets" or
  "Temporary private file" (`--delivery file` sets the default; the person
  decides; the `secret_delivery` question, so the phone shows a normal
  choice). The file is written on the chat's machine to `<ADE
  home>/secrets/temp-files/<random>` (0600 in a 0700 dir, `wx`, owner-only ACL
  on Windows) with a value-free `<id>.json` sidecar; the agent gets `{saved:
  true, delivery: "file", file, expiresAt}`. The value never enters secrets,
  transcript, events or logs. Files go on archive or delete, after the TTL (24
  h max), and in the next start's sweep (`secretTempFiles.ts`). The same
  `--request-id` returns the same file. An answer with no pick goes where the
  agent asked.
- **Mechanism.** A pending-input `question` (`requestChatInput`) marked by
  `providerMetadata.projectSecretRequest` (`name`, `reason`, `generate`,
  `exists`; `shared/projectSecretRequest.ts`). The value is the `isSecret`
  answer `secret_value`, so the transcript writer drops it.
  `requestProjectSecretFromUser` (`main/services/secrets/projectSecretRequest.ts`)
  saves through `projectSecretService.set` in the `beforeAccept` hook, inside
  the user's `respondToInput`, so a failed save keeps the card open with the
  error. The value is stored as typed (`normalizePendingInputAnswers` does not
  trim `isSecret`). An existing name adds a `secret_action` pick (`keep` /
  `replace`).
- **Results**: `{name, saved: true, replaced}`, `{name, saved: false, kept:
  true}` or `{name, saved: false, declined: true}`. The receipt is one locked
  line: "NAME saved to this project · never shown to the agent", "NAME · kept
  the existing value" or "NAME · declined". IPC traces redact `answers` and
  `responseText`.
- **Rules.** User-only (`isUserOnlyConsentCard`); a session-bound agent can
  raise it only in its own chat, under `ask_user`'s rate limit. A client that
  does not draw the card still gets a password question.
- **Orphaned card.** Answering a card whose asker is gone saves and sends
  nothing (`isQuestionShapedPendingInput` never re-routes an `isSecret` card
  as a message); a notice names the secret. Each outcome is one
  `chat/secret_requested` event ([Logging](../../logging.md)).
- **Add secret…** in the overflow menu opens the same fields in a `Dialog`
  (`window.ade.projectSecrets.set`) and appends a note naming the secret, never
  its value, to the draft.

### Connect card

An agent that needs GitHub, Linear or Jira runs `ade integrations connect
<provider> --reason "…" [--timeout 30m]` (`integration_connect.request`). A
connected integration returns `method: "already"` at once; otherwise the
composer shows the connect card.

- **Look**: the Settings page's banner, `SolidLogo` and accent
  (`integrationThemeVars`); the reason, one tab per method, the fields, a link
  to make a key, "Open in Settings" (on the chat's machine via
  `chatSettingsMachineId`), "Not now", and a line on where the credential
  goes. Enter connects, Esc is not now.
- **Methods** (`shared/integrationConnect.ts`): Linear "Sign in" (browser
  OAuth) and "API key"; Jira "API token" (site, email, token); GitHub "Access
  token". Browser sign-in returns to a port on the chat's machine, so it is
  offered only when that machine is the computer in front of the person (no
  remote pin, tab not bound elsewhere); otherwise the card says why.
- **Mechanism.** Marked by `providerMetadata.integrationConnectRequest`
  (`provider`, `reason`); user-only. The method is the `connect_method` answer;
  each key is an `isSecret` answer. `requestIntegrationConnect`
  (`main/services/integrations/integrationConnectRequest.ts`) saves in
  `beforeAccept`. A key is checked with the provider first
  (`integrationConnectAdapters.ts`: `api.github.com/user`, Linear `viewer`,
  `jiraService.connect`), then stored by the integration's service. A sign-in
  runs `cto.startLinearOAuth` with the chat's pin and the host checks it now
  reports connected. A refusal keeps the card open with the host's message in
  the card (`pendingInputError`). A second request joins the open card.
- **Results**: `{provider, connected: true, method, account, next}` (`next`
  names commands to use) or `{provider, connected: false, declined: true}`.
  Receipts: "Linear connected with an API key · never shown to the agent",
  "Jira · not now", "Connect GitHub · awaiting you". An answer after the asker
  stopped saves nothing; a finished browser sign-in says it is signed in.
- `ade integrations status` (`integration_connect.status`) lists connection
  and account, never a credential.
- Events: `chat/connect_requested`; `mcp_registry.request` →
  `chat/mcp_server_requested`; `mcp_registry.remove` (the removal card, see
  [MCP servers](../onboarding-and-settings/mcp-servers.md#agents-adding-and-removing-servers))
  → `chat/mcp_server_remove_requested` ([Logging](../../logging.md)).

A bare `ade://` address in a reply is a link (`remarkBareAdeLinks.ts`), the
same chip as `[…](ade://…)`; the sanitized preview renderer (`ChatMarkdown`,
plan cards) leaves it as text.

### Approval vs question

`approval_request.kind` names the shape (`tool_call`, `permissions`,
`plan_approval`, …); the optional `requestKind: PendingInputKind` names what is
asked. Without it an event is an approval. Readers use
`isQuestionKind(requestKind)`:

- `AgentChatMessageList` uses it directly.
- The push publisher (`pushPublisherService.ts`) sets `waiting_for_input` for a
  question and `waiting_for_approval` otherwise, and sends a question without
  the Approve/Deny category. Each card alerts once
  (`alert:<sessionId>:approval:<itemId>`). See
  [push notifications](../sync-and-multi-device/push-notifications.md).

### Subagent cards

A subagent inside the chat's own provider session (a Claude background agent,
a Codex `spawn_agent` child, an OpenCode child session, a Muse subagent) asks
through the **parent** chat, with the parent's answer key and pin. ADE child
chats (`ade chat create --type subagent`) keep their own cards.

- **Naming.** `subagent: { key, name, background? }` (`PendingInputSubagent`,
  kept by `readPendingInputSubagent`); `key` is the roster id
  (`subagentAgentKey`), `name` the row's start `title`. The header reads
  "`<name>` asks". Copilot, Cursor, Droid and ACP carry no matchable id, so
  their cards stay unnamed; Grok's ACP child asks on the parent's session id.
- **Several at once.** `PendingInputStack` lists open cards above the open one
  ("N waiting for you", three rows, then "+N more"). The open card is the
  person's pick, else the first. Chat Info marks the subagent **needs you**
  (`waitingSubagentKeys`), on desktop and iOS.
- **Accept all covers the chat** ("…the main agent and all its subagents.").
  Claude's session rule covers the query already. For Codex and OpenCode ADE
  remembers the grant per chat (`ManagedChatSession.sessionApprovalGrants`,
  `sessionApprovalGrantKey` in `sessionApprovalGrants.ts`) and answers later
  matches itself. Keys are exact: Codex command + `cwd` + extra permissions; a
  file change's grant root or file set; an OpenCode ask's type and resources.
  Nothing to key on, no grant. A fallback deny still wins.
- **Lifecycle.** Default Stop leaves running background subagents and their
  cards; Stop with background closes them. A Codex parent turn ending keeps
  cards of running children. A subagent ending closes its cards
  (`settleEndedSubagentCardsSoon`); a child-thread `serverRequest/resolved`
  closes that card. A Claude card ADE closes sends `CLAUDE_CARD_CLOSED_MESSAGE`,
  not "User denied". Dismissing a Muse subagent's card declines only that
  approval (or stops only that subagent); the parent turn continues.
- **After a restart.** An answer to a subagent question after a restart (or
  after it ended) is not sent as a message. The card closes and a
  `subagent_answer_unsent` notice holds the answer with **Send my answer to the
  main agent** (sent with the chat's pin, only on click).

### Cross-surface parity

`PendingInputRequest` / `PendingInputQuestion` / `PendingInputOption`
(`shared/types/chat.ts`) is the one contract; iOS
(`WorkStructuredQuestionCard`, `WorkPlanComposerStrip`) draws the same verb,
dedup, monospace preview and accent. Label helpers live in
`shared/pendingInputLabels.ts` (mirrored in Swift).

- **One strip on iOS** (`consolidatedPendingStripSection`,
  `WorkChatSessionView+Timeline.swift`) above the composer: the primary
  request, "Request 1 of N" when several wait, advancing as each is answered.
  Answers remove optimistically (`dispatchPendingInputAnswer` /
  `optimisticallyAnsweredInputIds`), reconciled when the host queue changes
  (`canonicalPendingInputSignature`) or rolled back on error.
- **Accept all** (approval and permission gates only) sets `acceptForSession`
  on the current gate, then accepts each remaining sweepable gate in turn.
- A blocking input shows "Awaiting you" on the Lanes row and Work tile (from
  exact counts); iOS plays a light haptic on a new blocking gate.
- **Height (iOS).** `workPendingInputMaxHeight(chatSurfaceHeight:)` returns
  `max(160, min(available * 0.82, chatSurfaceHeight * 0.62))`, `available`
  minus a fixed 110 pt composer reserve, with `chatSurfaceHeight = max(240,
  scrollViewportHeight + composerLayoutHeight)` (invariant as the card grows).
  Inline cards use `workInlinePendingInputMaxHeight` (`max(240, viewport *
  0.62)`). The card floors its scroll region at 64 pt. The composer inset is
  `fixedSize(vertical:)` and the transcript is the flexible sibling, which
  keeps Send/Decline on screen.
- **Minimize (iOS).** A chevron folds the strip to a pill: mark,
  `workPendingInputCollapsedSummary` (question header, plan title or
  `Permission: <tool>`), queued count, expand. The gate stays open. State is
  `collapsedPendingInputId`, so it expires when another gate becomes primary.
  A keyboard `Done` item (only while the freeform field has focus), a footer
  dismiss and scroll-to-dismiss lower the keyboard.
- **Drafts (iOS).** `WorkComposerDraftStore` keeps drafts under
  `chat:<sessionId>` plus Hub and New Chat keys; `WorkQuestionDraftStore`
  keeps an open question's picks, notes and page by request id. Both save on a
  400 ms debounce and flush on disappear. Send clears synchronously. `isSecret`
  answers are never written (App Group `UserDefaults` is shared with the
  widget). Unpair does not clear them (keyed by session, not host).

### Per-runtime question richness (ceilings)

| Runtime | Fields filled |
|---|---|
| Claude | Full (`AskUserQuestion`): `header`, option `description` / `preview` / `previewFormat` / `recommended`, `multiSelect`. |
| Codex | Full (`item/tool/requestUserInput`: header, multiSelect, isSecret, option description/preview). `isBlocking: false` is non-blocking steering: header `{Provider} has a question`, composer open, row stays Working with a pip, the card dies on Stop or `turn/completed` with a `pending_input_resolved` cancel; no `awaitingInput` / `pendingInputItemId`; typed send ungated (`pendingApprovalCapturesPrompt`). Missing `isBlocking` blocks. Thread start/resume send `config.tools.update_plan.enabled = true`. |
| Cursor | Full via `normalizeCursorControlQuestions` (with `defaultAssumption`, `impact`, `isSecret`). |
| OpenCode | `header`, `multiSelect` (`multiple`), `allowsFreeform` (`custom`), option `description`. No `recommended` / `preview` / `isSecret`. |
| Droid | `topic` → `header` and string options. The `@factory/droid-sdk` 0.9.x schema has per-question `multiSelect`, which ADE does not draw as its own control; no option description or preview. |

## Presentation profiles

`ChatSurfacePresentation` (`shared/types/chat.ts`) drives the surface's look:

| Field | Effect |
|---|---|
| `mode` | `standard | resolver | worker-thread | activity-feed`. |
| `profile` | `standard | persistent_identity`; persistent identity changes accent, chips, title and some layouts. |
| `modelSwitchPolicy` | Overrides the session's switch policy. |
| `title`, `subtitle`, `assistantLabel`, `messagePlaceholder` | Text overrides. |
| `accentColor` | Accent for the header, chips and active-turn indicators. |
| `chips` | `{ label, tone }` header chips. |
| `showMcpStatus` | Whether to show the ADE CLI status indicator. |

CTO and resolver surfaces set `profile: "persistent_identity"` and their own
chips.

### Resolving the accent for the chat on screen

Codex/OpenAI user bubbles blend the near-white accent into muted violet at each
gradient stop; icons and other chrome keep the accent.

`chatAccentForRenderedChat()` (`chatSurfaceTheme.ts`) is the one derivation,
and it is synchronous so the accent is right on the switch frame. Best evidence
first:

1. `sessionProvider`, the rendered chat's provider.
2. `lockSessionProvider`, the provider an embedding host knows.
3. `modelFamily`, the composer model's family.
4. `modelColor`, the registry colour.
5. `NEUTRAL_CHAT_ACCENT` (`#A1A1AA`).

**The caller owns staleness.** Pass `null` for anything not true for this
frame; gray is better than the previous chat's colour.

- `AgentChatPane`'s `sessionProvider` comes from `renderedSession` (from
  `renderedSessionId`, with `initialSessionSummary` as the switch-frame
  fallback).
- The model inputs are withheld unless `composerModelDescribesRenderedChat`
  (`selectedSession?.sessionId ?? null === renderedSessionId`), because the pane
  is not remounted on a chat switch. Do not use `!chatSelectionTransitioning`:
  it already agrees on the frame where `selectedSession` is still null. A draft
  (`null === null`) keeps its model colour.
- `WorkViewArea`'s `SessionSurface` passes `lockSessionProvider` as
  `providerFromChatToolType(session.toolType)`, the inverse of
  `chatToolTypeForProvider` (`renderer/lib/sessions.ts`). The forward map is a
  `Record<KnownChatProvider, …>` (a new provider is a type error); a round-trip
  test pins the reverse map. Both look up with `Object.hasOwn`, so
  `constructor` or `toString` fall back.

## State derivation helpers

Pure modules:

- `chatTranscriptRows.ts`: events to rows (visibility, work-log grouping,
  tool summary absorption).
- `pendingInput.ts`: `derivePendingInputRequests` deletes a card only on an
  explicit `pending_input_resolved`; a `done` or a mooting `tool_result` /
  `command` / `file_change` only marks it `sweptWithoutReceipt`.
  `resolvePendingInputs(derived, summary)` keeps a swept card the summary still
  names in `pendingInputItemId`. Renderers call it and never read the flag or
  fold the summary into the derivation (see "Pending input derivation" in
  [Fragile and tricky wiring](README.md#fragile-and-tricky-wiring)). Also
  `getPendingInputQuestionCount()` and `hasPendingInputOptions()`.
- `shared/chatTaskList.ts`: the one task list (provider normalization,
  merge/replace/clear, progress, summary line).
- `chatExecutionSummary.ts`: subagent snapshots and turn diff summaries;
  re-exports `shared/chatScheduledWork.ts` (scheduled-work snapshots from
  `scheduled_work_update`).
- `chatToolAppearance.tsx`: tool icons, tone and labels.

## Cloud agents (Devin Cloud and Cursor Cloud)

A **cloud lane** is a lane whose branch lives on the cloud: ADE keeps a local
worktree as a mirror, and the lane's chats run on the cloud's VM. The machine
in the prompt box is where the lane lives, and a cloud is one of those
machines.

### The model

- **The synced tag** `ade:cloud:devin` or `ade:cloud:cursor` marks a cloud lane
  (`shared/cloudLanes.ts`: `cloudLaneTag`, `laneCloudProvider`,
  `withCloudLaneTag`); `isReservedLaneTag` hides it from the tag editor.
- **A Devin Cloud lane's chats are Devin Cloud sessions.** On a cloud machine
  the lane list shows cloud lanes, and picking one selects cloud mode.
- **One running cloud chat per lane** (`cloudAgents.launch` refuses a second).
- **Devin has no branch field**, so `buildDevinCloudBranchPin`
  (`shared/devinCloud.ts`) puts a "fetch and check out `<branch>`" block in the
  first turn and a reminder later (`AgentChatDevinCloudConfig.pinned`).
  `stripDevinCloudBranchPin` removes it wherever Devin echoes the prompt.
- **After each successful turn** `syncCloudLaneMirror`
  (`lanes/cloudLaneMirror.ts`) fetches `origin/<branch>` and fast-forwards only
  a clean worktree on that branch (`git symbolic-ref`), then emits the diff
  summary; anything else is logged and left.

### Transport

Devin Cloud uses the **ACP cloud relay**, `devin acp --cloud`
(`acpHost/acpDialects/devinCloud.ts`), on the CLI login (no API token).

- `session/new` takes `repos`, `devin_version` (the model, via
  `modelConfigOptionId`) and `platform` as `initialConfigValues` on new
  sessions. Relay ids are `devin-<hex>`, REST/web ids `<hex>`
  (`devinCloudAcpSessionId` / `devinCloudRestSessionId`).
- `session/load` replays history; user messages become cloud `user_message`
  rows (`echoRemoteUserMessages`), deduped by `cognition.ai/eventId`.
- `session_info_update` carries status, `userActionRequired`,
  `pendingRequest` and title. `devinDirectoryStatus` maps blocked with either
  flag to needs_you, for the chat and the panel.
- `openDevinCloudChat` needs a `devinCloud` config unless the chat is already a
  relay chat, and rejects ids outside `[devin-]<letters, digits, - or _>`
  (`normalizeDevinCloudSessionId`).
- **The directory** (`devinCloudDirectory.ts`) is a short-lived relay client
  for `session/list` (4 s cache, single-flight), cancel (`session/load` +
  `session/cancel`) and archive (the `/archive` prompt; no unarchive). Cursor
  Cloud reuses `cursorCloudFleetService`.

### The service and actions

`cloudAgentsService.ts` (brain and desktop main) backs the `ai`-domain actions
`listCloudAgents`, `openCloudAgent`, `stopCloudAgent`, `archiveCloudAgent` and
`launchCloudAgent`, as IPC, `window.ade.cloudAgents.*` and the sync commands
`ai.*CloudAgent*` (which the web panel uses).

- `list`: `CloudAgent` rows with ADE status (starting / working / needs_you /
  idle / finished / failed / archived), PR, model, platform and a `link` to
  the ADE chat and lane.
- `open`: reuses the linked chat; else the lane on the PR branch, else a lane
  imported from it; with no branch (merged or closed PR) or no PR, a new cloud
  lane on a pushed branch. The chat opens with history.
- `stop`: interrupts the linked chat, or cancels through the directory.
- `launch`: creates or reuses a cloud lane (`<provider>/<slug>-<rand>`,
  pushed), creates the chat and sends the prompt.

### The panels

`renderer/components/app/cloudAgents/` (`CloudAgentsPanel`, `CloudAgentRow`,
`cloudAgentsModel.ts`: filters, sections Needs you / Working / In ADE / Recent,
brands; an unknown Devin model id reads "Devin"). Each cloud has its own
top-bar modal (`CloudAgentsQuickViewButton` with its `provider`), opened by
`openCloudAgentsPanel(provider)`.

- **Launch bar:** prompt, Model, VM (Devin), Lane (new or existing); ⌘↵ starts.
- **List:** filters with counts, This project / All repos, search.
- **Row actions:** Open, Stop, web, and ⋯ (Shell on the VM, Forward a port,
  Take over its desktop for Cursor, Copy link, Archive).
- Opening or launching refreshes lanes and reveals the chat;
  `ade:work:select-session` reloads the list when the chat is not loaded yet.

### Honest gating

- **Shell in a Devin Cloud lane** is `devin ssh <id>`
  (`useWorkSessions.launchPtySession`), never local, and needs a chat first.
- **Cursor Cloud has no shell**; the launch throws and says so.
- **Machine-bound tools** (iOS, Mac desktop, App Control) are off in cloud
  lanes with the reason (`workTools.ts` `CLOUD_MACHINE_TOOLS`).
- **A Devin Cloud chat's model is fixed** and shows as a label
  (`fixedModelLabel`).
- **Cloud lanes are marked** by `LaneCloudMarker` and a cloud glyph on cards
  that name the lane.

## Fragile and tricky wiring

**Launches**

- **One id.** A chat launch's `launchId` IS the session id, chosen by the
  renderer first. The Work tab, sidebar row, `lockSessionId`, dock stash and
  card id key off it. Never mint a second id.
- **Launch rows.** `useWorkSessions` keeps the host list in `hostSessions` and
  merges launch rows into `sessions` for chats not listed yet. Launch rows are
  never mirrored into `sessionsCacheByProject` and never count as running.
  Tabs close through `chatLaunchDraftRestore`: the first host snapshot that
  moves a held launch to `cancelled` posts a close notice (closing the tab and
  returning Work to the draft if it was on screen). Cancel/Delete here also
  restore the prompt and switch the draft to the launch's kind.
- **Narrow subscriptions.** Only the setup card, that chat's sidebar row and
  the slide-out read full snapshots; page-level components use
  equality-gated selectors. A plain `useChatLaunchEntries()` in a page
  re-renders it every tick.
- **Pending pane reads.** While `launchAwaitingSession` the pane skips the
  summary read, history, turn recovery, delta and computer-use reads (history
  re-runs when it flips). `submit` intercepts queued sends before the
  model/lane checks.
- **Draft launch jobs live in the root store** (`draftLaunchJobsByScope` via
  `useRootAppStore` / `rootAppStoreApi.getState().setDraftLaunchJobs`), because a
  launch outlives its pane and a project switch tears down the project store.
  Restore (`restoreDraftLaunchSnapshot`) appends text and merges context by id.
  `isDraftLaunchJobStale` makes a hung row hideable.
  `DraftLaunchSnapshot` gives `createSessionForLane` a `launchState` that
  overrides the live composer.
- **Project-switch safety.** The chain captures `launchBinding` and passes it
  as `pin` to config reads, branch discovery, lane create/rename, name
  suggestions, session create/send/delete and PTY create/dispose (preload's
  `callPinnedRuntimeAction`; see
  [Remote runtime](../remote-runtime/internal-architecture.md#local-runtime-routing)).
  Rollback uses the same binding (`window.ade.lanes.delete(..., launchBinding)`,
  `window.ade.agentChat.delete(..., pin)`). With no binding the chain aborts on
  root drift (`LAUNCH_PROJECT_CHANGED_MESSAGE`). Each step has
  `withDraftLaunchTimeout` (`DRAFT_LAUNCH_TIMEOUT_MS = 90 s`).
- **First turn waits.** A composer-created session awaits `onSessionCreated` and
  the list refresh before the first turn; otherwise the screen shows a blank
  new chat.

**Composer state**

- **An existing chat never shows an empty model.** The model resolves from the
  summary's `modelId`, its `model` in the registry, its preset, the newest
  `done` event naming a model (`resolveTranscriptComposerModelId`, last 2,000
  events), then the raw `model`. Until then the picker shows "Loading model…"
  (`emptyLabel`), and a locked pane clears a model left from the previous chat.
  The fallback effect never swaps an existing chat's model, even when this
  catalog cannot list it. A pick made before the model is known still applies.
- **The locked summary read retries** (`refreshLockedSessionSummary`): it keeps
  the held summary and retries at 1, 2, 4, 8, 15 s, then every 30 s while the
  pane stays; "not found" keeps it until it persists 60 s. A late result for
  another chat writes nothing; unmount or a switch cancels.
- **Draft persistence.** `ComposerDraftStorageSnapshot` saves to
  `localStorage` on each change and restores on scope switch;
  `composerDraftHydratingRef` skips the first write-back;
  `normalizeStoredComposerDraft` validates every field.
- **Empty-state column.** Only the logo may flex (with a `min-h` floor); every
  sibling is `shrink-0`; the lift is padding (`pb-[100px]`), because a negative
  margin escapes `max-h-full`.
- **No warmup on selection.** A model change does not call
  `ade.agentChat.warmupModel`; the new model binds on Send.
- **Effort track pointer.** A drag starts after a small threshold, previews
  through CSS custom properties and commits once on pointer-up; a drag from a
  ridge suppresses the trailing click. Do not close the Radix popover from
  `onChange`.
- **Native permission updates serialize.** `pendingNativeControlUpdateRef`
  (sessionId, monotonic `updateId`, promise) chains every `updateSession`, and
  `submit()` awaits it. The handler patches the summary with the returned
  fields (`permissionMode`, `interactionMode`, `claudePermissionMode`,
  `codexApprovalPolicy`, `codexSandbox`, `codexConfigSource`,
  `opencodePermissionMode`, `cursorModeId`, `cursorModeSnapshot`).
- **Inbound mode changes re-seed the composer.** On `session_meta_updated`
  ([transcript-and-turns](transcript-and-turns.md)) for the selected session,
  `AgentChatPane` patches the summary and calls the composer setters
  (`setInteractionMode`, `setClaudePermissionMode`, the Codex, OpenCode, Droid
  and Cursor setters), because the composer seeds from session scope. A
  title-only event changes nothing.

**Menus and chips**

- **Stale slash commands.** SDK commands fetch by session; a pending model
  handoff fetches by lane and pending provider, so the menu drops the old
  provider's commands.
- **File-search debounce.** 40 ms in `ChatCommandMenu`, a sequence number
  drops stale results; cached queries show at once and revalidate.
- **Triggers are cursor-relative** (`shared/composerTriggers.ts`). A slash
  needs a word boundary before it and no whitespace or `/` inside, so paths,
  URLs and fractions never open the menu; do not add `startsWith("/")` gates.
  `@` queries may contain spaces and stop at a newline or another `@`. The
  rich editor detects on the DOM text around the caret
  (`getRichTriggerContext`), not serialized offsets.
- **Chip selection marking must stay cheap.** The `selectionchange` listener
  exists only while the editor is focused and holds a chip; a collapsed caret
  costs one boolean; DOM writes coalesce into one `requestAnimationFrame`;
  queries stay inside the editor; a `MutationObserver` watches `childList` +
  `subtree` (never `characterData`) only while focused. Widening any of these
  adds work to every keystroke.
- **Smart-link presentation is not prompt storage.** Keep the full URL in
  `data-composer-chip-text` and the draft; a failed lookup degrades to the
  provider label or URL.

**Transcript**

- **Event identity is never the sequence alone.** The transcript is durable across restarts, so a rehydrated session that
  restarts at 0 would reuse numbers already in the file. Host: `readTranscriptHydrationState` (`agentChatService.ts`)
  seeds `managed.eventSequence` from the transcript's max in the same pass
  that recovers todos. iOS: `AgentChatEventEnvelope.id` is
  `sessionId:timestamp:sequence`; the thread engine keys on the durable
  `sequence`, and cards derive per `itemId` (`derivePendingWorkInputs`). Short
  text (under 24 characters) has no content dedupe key, so it depends on this.
- **`isAskUserToolName` does not match `AskUserQuestion`.** Claude's ask emits a
  `tool_call` (tool-use id) and an `approval_request` (a fresh `randomUUID`);
  matching both makes two cards, and the `tool_call` one is unanswerable. That
  branch is only for a bare ask-user call.
- **Question drafts.** On desktop, picks and notes live in
  `AskQuestionComposer` and reset when you leave the chat (minimizing keeps
  them), so stale answers do not cross sessions; iOS keeps them
  ([Cross-surface parity](#cross-surface-parity)). Focus and entrance run once
  per card (`focusedQuestionCardKeys` / `enteredQuestionCardKeys`).
- **Terminal drawer tabs.** PTY exit removes the tab; the last removal closes
  the drawer (`ChatTerminalDrawer` owns the state machine).
- **Virtual-scroll drift.** Spacers come from `measuredHeights` keyed by stable
  row keys; a resize above the viewport needs `handleMeasure` →
  `reconcileMeasuredScrollTop`. Unstable keys make the list jump. Sticky-bottom
  recovery follows for a few frames after a measurement; removing it makes a
  stream look cut short.

## Browser dock context

The Browser dock strips URL credentials, sensitive query values and fragments
from page context, adds the current tab to ordinary sends and queued launch
messages while showing only the user's text, and leaves provider slash commands
unchanged. Its page card replaces the empty-chat logo.

## Related docs

- [Chat README](README.md): service overview and IPC.
- [Transcript and Turns](transcript-and-turns.md): the data the UI renders.
- [Tool System](tool-system.md): tool tiers in the composer.
