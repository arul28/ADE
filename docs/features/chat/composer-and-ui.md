# Composer and chat UI

The chat UI lives in `apps/desktop/src/renderer/components/chat/`: a pane
(`AgentChatPane`), a message list (`AgentChatMessageList`), a composer
(`AgentChatComposer`) and side panels. The pane derives everything from the
`AgentChatEventEnvelope` stream plus session metadata. Event and row rules are
in [transcript-and-turns.md](transcript-and-turns.md).

## Source file map

Unqualified files are in `apps/desktop/src/renderer/components/chat/`.

| Path | Role |
|---|---|
| `AgentChatPane.tsx` | Top-level pane: IPC, session state, presentation, launches, panels, draft state (`ade.chat.composerDraft.v1`), unread divider (`ade.chat.lastViewed.v1:<sessionId>`), history-miss handling, view cache (128 MB / 32 MB per chat), active-turn stall recovery (10 s). |
| `ChatRuntimeScope.tsx` | Which machine this chat is on: `useChatRuntimeScope()` (`pin`, `binding`, lane, `isRemote`, `machineName`, `online`, `machineRests`). ESLint bans tab-store reads of `projectBinding` / `lanes` / `project.rootPath` in `components/chat/**`. `chatRunsOnThisComputer(scope)` hides this-computer actions on a foreign chat. |
| `AgentChatComposer.tsx`, `ChatComposerShell.tsx` | The composer: input, attachments, model and permission controls, menus, drafts, pending input, send/stop menus. |
| `AgentChatMessageList.tsx`, `chatCardPrimitives.tsx` | Virtualized list, `WorkingIndicator`, `ChatInfoHostContext`. |
| `ChatSurfaceShell.tsx`, `chatComposerOverlayInset.tsx`, `ChatJumpToLatestPill.tsx` | Floating header/body/footer (opaque, no `backdrop-filter`); composer height written to DOM styles, never React state. |
| `useDraftMachineRouting.ts`, `draftAttachmentTransfer.ts` | Draft machine selection, lane remap on machine switch, attachment transfer between machines. |
| `launch/`, `renderer/state/chatLaunchStore.ts`, `state/useChatLaunchSync.ts`, `renderer/lib/draftLaunchJobs.ts` | New-lane launches (brain-owned) and renderer-owned launch chains. |
| `components/app/ChatLaunchesSlideOut.tsx`, `components/terminals/useChatLaunchCliDriver.ts` | Launches slide-out; CLI launch driver. |
| `CrossMachineHandoffModal.tsx`, `ChatHandoffDialogs.tsx`, `renderer/lib/chatHandoffIntent.ts`, `renderer/lib/handoffLaunchJobs.ts` | Handoff surfaces. |
| `ProviderSignInCard.tsx`, `ProviderSignInSlot.tsx`, `useProviderStatusRefresh.ts`, `renderer/lib/aiDiscoveryCache.ts` | Sign-in card and provider status for the chat's machine. |
| `ComposerDrafts.tsx`, `DraftSchedulePopover.tsx` | Drafts and scheduled send ([drafts doc](drafts-and-scheduled-send.md)). |
| `TurnFailureLine.tsx`, `UsageLimitChip.tsx`, `usageLimitResumePresentation.ts`, `chatTurnState.ts` | Failed turns, usage limits, turn state. |
| `ChatCommandMenu.tsx`, `shared/composerTriggers.ts` | `/`, `@`, `#` menus and trigger detection (iOS mirrors). |
| `shared/chips.ts`, `composerChipDom.ts`, `ChipText.tsx`, `ChipHoverCard.tsx`, `chipPreviewStore.ts`, `shared/composerClipboard.ts`, `shared/__fixtures__/chipCases.json` | The one chip model, DOM serialization, rendering, hover cards, clipboard, iOS parity fixture. |
| `shared/smartLinks.ts`, `main/services/chat/smartLinkPreviewService.ts` | Smart links and previews (SSRF-checked, cached). |
| `ChatAttachmentTray.tsx`, `chatAttachmentStaging.ts`, `heldChatAttachments.ts`, `deviceHeldSend.ts`, `renderer/lib/attachmentImage.ts`, `shared/attachmentLabels.ts`, `shared/chatAttachmentLimits.ts`, `shared/chatAttachmentStagingFs.ts`, `shared/pastedTextAttachment.ts` | Attachments end to end. |
| `components/shared/ModelPicker/`, `components/shared/PermissionModePicker.tsx`, `components/shared/BlockedAction.tsx` | Model picker, permission pill, blocked-action reasons. |
| `AskQuestionComposer.tsx`, `QuestionReceipts.tsx`, `PendingInputStack.tsx`, `shared/pendingInputAnswers.ts`, `pendingInput.ts` | Pending input. `pendingInput.ts` is the **only** pending-input derivation. |
| `ChatSubagentsPanel.tsx`, `ChatActionsDrawerPanel.tsx`, `ChatSourcesPanel.tsx`, `ChatTaskListCard.tsx`, `shared/chatScheduledWork.ts` | Chat Info, actions drawer, sources, task list, schedules. |
| `ChatFileChangesPanel.tsx`, `RewindFilesConfirmDialog.tsx`, `rewindFilesPreview.ts` | File changes and rewind. |
| `ChatTerminalDrawer.tsx`, `ChatCodeBlockRun.tsx`, `ChatGitToolbar.tsx`, `ChatPrPane.tsx`, `ChatPrInlineCreator.tsx` | Terminal drawer, run-code-block, git strip, PR tool. |
| `ChatComputerUsePanel.tsx`, `ChatAppControlPanel.tsx`, `ChatIosSimulatorPanel.tsx`, `ChatBuiltInBrowserPanel.tsx` | Proof drawer and Work tool panels; every call uses the chat's `runtimePin`. |
| `chatSessionRetention.ts`, `chatCompanionUiState.ts`, `chatPromptHistory.ts`, `ChatUserMinimap.tsx` | Retained subscriptions, per-chat pane state, prompt history, minimap. |
| `chatMarkdownBlock.tsx`, `chatMarkdown.tsx`, `threadEntities.tsx`, `AssistantTextBody.tsx`, `textReveal.ts`, `useRevealedText.ts`, `chatWorkspacePaths.tsx` | Markdown rendering, thread entities, paced reveal, workspace paths. |
| `CodexVoice.tsx`, `VoiceSessionCard.tsx`, `main/services/chat/codexVoice*.ts`, `shared/codexVoice.ts` | Voice conversations. |
| `VoiceDictationButton.tsx`, `renderer/services/globalVoiceRecorder.ts`, `main/services/transcription/*` | Dictation (local Parakeet model). |
| `chatSurfaceTheme.ts` | `chatAccentForRenderedChat`. |
| `renderer/components/app/cloudAgents/`, `main/services/chat/cloudAgentsService.ts` | Devin Cloud / Cursor Cloud panels and service. |
| `apps/ios/ADE/Views/Work/Work*.swift` | iOS composer, pending-input strip, drafts, chips. |

## Gotchas

**Machine scope**

- **Everything a prompt box offers is scoped to its machine.** The pane passes
  `activeComposerRuntimeBinding` (the chat's pin, or the draft shelf's machine;
  never `null`) as `modelRuntimePin`, so catalogs, file search, slash commands,
  attachments and launches go there. Cross-machine drafts never rebind the tab.
- Panels (browser, App Control, iOS) fail closed when their local service
  cannot act on the chat's machine.

**Launches**

- **One id.** A chat launch's `launchId` IS the session id, chosen by the
  renderer first. Never mint a second id.
- Launch rows merge into `sessions` for chats not listed yet, are never cached
  in `sessionsCacheByProject`, and never count as running.
- **Narrow subscriptions.** Only the setup card, the chat's sidebar row and the
  slide-out read full launch snapshots; pages use equality-gated selectors.
- **Draft launch jobs live in the root store** (`draftLaunchJobsByScope`),
  because a launch outlives its pane and a project switch tears down the
  project store.
- **Project-switch safety.** The chain captures `launchBinding` and passes it
  as `pin` to every call, including rollback; with no binding it aborts on root
  drift (`LAUNCH_PROJECT_CHANGED_MESSAGE`). Each step has
  `withDraftLaunchTimeout` (90 s).

**Composer state**

- **An existing chat never shows an empty model.** The model resolves from the
  summary's `modelId`, its `model`, its preset, the newest `done` naming a model
  (`resolveTranscriptComposerModelId`), then raw `model`; until then "Loading
  model…". The fallback never swaps an existing chat's model.
- The locked summary read retries (1, 2, 4, 8, 15 s, then every 30 s).
- No warmup on model selection; the new model binds on Send.
- **Native permission updates serialize** (`pendingNativeControlUpdateRef`);
  `submit()` awaits it.
- **Inbound mode changes re-seed the composer** on `session_meta_updated`.

**Menus and chips**

- **Triggers are cursor-relative** (`shared/composerTriggers.ts`). A slash needs
  a word boundary before it and no whitespace or `/` inside; do not add
  `startsWith("/")` gates. The rich editor detects on DOM text around the caret
  (`getRichTriggerContext`).
- **Chip selection marking must stay cheap**: the `selectionchange` listener
  and `MutationObserver` (`childList` + `subtree`, never `characterData`) exist
  only while the editor is focused and holds a chip; DOM writes coalesce into one
  rAF.
- **Smart-link presentation is not prompt storage.** The full URL stays in
  `data-composer-chip-text` and the draft.

**Transcript**

- **Event identity is never the sequence alone.** The host seeds
  `managed.eventSequence` from the transcript's max on hydration
  (`readTranscriptHydrationState`); iOS keys on `sessionId:timestamp:sequence`.
- **`isAskUserToolName` does not match `AskUserQuestion`** (that would draw two
  cards, one unanswerable).
- **Virtual-scroll drift.** Unstable row keys make the list jump; a resize above
  the viewport needs `handleMeasure` → `reconcileMeasuredScrollTop`.

## Pane layout

`AgentChatPane` subscribes to the session's events, derives rows, turn state,
pending inputs (`derivePendingInputRequests` then `resolvePendingInputs` against
the summary, in the `resolvedPendingInputsBySession` memo every reader uses),
the task list, schedules, subagents and diff summaries, resolves a
`ChatSurfacePresentation`, and mounts header, list, composer and panels.

In an open Work chat the composer floats over the transcript;
`chatComposerOverlayInset.tsx` writes its height onto the transcript's padding
and the overlays. An empty draft reserves no side pane.

### Empty draft surface

Wordmark, composer, a **launch shelf** (`DraftMachinePicker`, a compact
`LaneCombobox`, Shell and Import), the activity module, and the import hint.

- Machine and lane are separate controls. The lane list is only the picked
  machine's lanes plus auto-create; each machine has its own main checkout.
- **Lane remap** after a machine change (`remapDraftLaneToMachine`): same id,
  else the new main checkout for an old one (`findPrimaryDraftLane` prefers
  `laneType === "primary"`), else the same name, else the main checkout. A lane
  handed in with its machine (`initialDraftMachineId`) is never remapped.
- **Loading hold:** a machine with no lane read yet shows `Loading lanes for
  <machine>…` and blocks send until the read lands, fails, or 12 s pass
  (`LANE_CATALOG_HOLD_MS`).
- A machine switch inside one draft copies local images and keeps image URLs;
  other files and machine-bound context are removed with a notice. A pending or
  failed transfer blocks send.
- Shelf chrome is `.ade-chat-launch-shelf` in `renderer/index.css`. Keep its
  margin and padding in that CSS rule (Tailwind arbitrary values with CSS vars
  can silently fail).
- Over a scene picture, shelf and switcher frost with `SceneFrost`, never
  `backdrop-filter`.

### Header

- Title is `chatSessionTitle()`, else "New chat"; a lane button opens the lane.
- CTO and resolver surfaces override title, accent and chips via
  `ChatSurfacePresentation`.
- Lifecycle (settled, snoozed) is one chip in `StatusStrip`, not the header;
  the branch-drift chip shares that strip
  ([Lanes › Branch drift](../lanes/README.md#branch-drift)).
- "New since 9:12 PM" divider from the last-viewed time; streaming rows never
  move it.

### Retained chat subscriptions

`chatSessionRetention.ts` keeps a hidden chat's `agentChat.onEvent`
subscription for 5 min (`CHAT_SESSION_RETENTION_TTL_MS`, at most 2), so a
returning tab is current. It lives in the renderer on purpose: preload's remote
event pump polls only while a renderer callback exists. The visible pane owns
the only subscription and hands it over on hide (`retainChatSession`) and back
on return (`adoptRetainedSession`). Events batch every 16 ms.

### New-lane launches

A chat or CLI on "Auto-create lane" opens at once while the brain sets up the
lane. Contract: `shared/types/chatLaunch.ts`; words: `shared/chatLaunch.ts`.

- Stages come from the host (fetch base, check out files with percent, template
  / environment, start agent). The optimistic snapshot predicts them until the
  host answers.
- **Foreground chat:** the sidebar row, prompt bubble and setup card appear in
  the same frame. Sends during setup go to `chatLaunch.queueMessage` in typing
  order. Once the chat exists, stand-ins yield to real rows (the card becomes
  the `ade_card` `lane_setup` row, `cardId` `lane-setup:<launchId>`).
- **Setup card:** stages, Start now (during environment), Cancel; on failure
  Retry, Start anyway, Delete. Cancel/Delete confirm, delete the lane and chat,
  and put the prompt back in the composer. A cancel never applies to a launch
  whose agent already started.
- **Background chats and CLI launches** show in the Launches slide-out (this
  window's launches only). CLI launches stop at `awaiting-client`;
  `useChatLaunchCliDriver` starts the PTY and reports with `completeClient`.
- **Render cost:** the store writes once per frame, unchanged stage objects are
  shared, durations read one 250 ms clock, the rail is compositor-only.
- **Send animations** (composer dock glide, first-message flight, departing
  draft chrome) animate transform/opacity only, skip under reduced motion,
  resource pressure ≥ 3 or a hidden window, and end at once when the reply's
  first text shows (`settleSendHandoff`).

## Composer

### Turns, failures and limits

- A failed turn is one `TurnFailureLine` with **Retry** (resends the original
  prompt in the same thread). Usage limits have no Retry; `UsageLimitChip`
  owns them from `AgentChatSessionSummary.usageLimitResume`: resume countdown,
  Cancel / Resume, and **Continue on <account>** when another account has room.
- **Deferred model handoffs:** a new model in an existing chat changes only the
  composer until the next send. A `model_handoff` divider appears only when the
  provider group changes.

### Input

- Paste is plain text; large text pastes (> 3,000 UTF-16 units or 40 lines)
  become a file attachment (`shouldPasteTextAsFile`) whose text is read back
  into the message at send.
- **Smart links:** a completed HTTP(S) or `daex://` (also `ade://`) URL becomes
  an atomic chip; the literal URL is what the agent gets.
- **Chat-context chips:** select assistant output → Add to chat; serializes an
  `<ade-chat-context>` block.
- **Slash commands** merge local commands, SDK commands, command files and
  skills (`.claude/skills`, `.agents/skills`, `.ade/skills`, `.codex/skills`,
  `ADE_AGENT_SKILLS_DIRS`, bundled roots) through `ade.agentChat.slashCommands`.
  Only a local `/clear` is intercepted. `isProviderSlashCommandInput` reads
  `"/rebase the lane?"` as text.
- **File search** `ade.agentChat.fileSearch` (40 ms debounce, stale guard).
- **Issue context:** Linear and GitHub issues attach via the overflow menu and
  are recorded on the session. PRs are not attachable.
- Dragging a Work row onto a composer inserts an `@chat:` / `@term:` chip.

### The command menus

`ChatCommandMenu.tsx` draws menus from a `ComposerTrigger`:

- **`@`**: recent rows by kind (chats, lanes, terminals, PRs, machines, MCP
  servers, people, files); a kind word (`@pr`, `@mac`, `@mcp`, `@people`, …)
  narrows; any other query is one ranked mixed list
  (`rankComposerAtMenuItems`). Selection inserts an opaque pointer
  (`@chat:<id>`, `@lane:<id>`, `@term:<id>`, `@pr:<id>`, `@mac:<id>`,
  `@mcp:<name>`, `@person:<source>.<id>`) shown as a chip
  (`shared/chatMentions.ts`).
- **People** come from the chat machine's Linear workspace and the repo's
  GitHub assignees (cached 5 min). A person mention is context only; the agent
  assigns or notifies only when asked. A resting DAEX Cloud chat shows none.
- **`#`** lists PRs reachable on the chat's pin.
- **`/`** groups Commands, Skills and MCP prompts
  (`shared/slashCommandSections.ts`).
- Stale results count as loading, so no false "no matches" fires.
- **Dismissal** (`isComposerTriggerDismissed`): extending a dismissed query
  stays dismissed. Three close calls: `closeCommandMenu()` (resolved),
  `dismissCommandMenu(trigger)` (Escape, no-match), and
  `closeCommandMenuKeepingDismissal()` (cannot open now; touch no dismissal).

### Attachments

- Drop anywhere, paste or pick. A pending image holds its place as an uploading
  token at the caret; a failed save keeps tile and token with **Retry** /
  **Remove**.
- Clipboard images are fitted under the paste cap
  (`encodeClipboardImageWithinCap`). HEIC converts to JPEG on macOS only.
- **Staging mode** is asked of the chat's machine once per batch: `copy` (this
  machine), `upload` (streamed HTTP route on the host) or `base64`. Dropped or
  picked files with a path stage by path up to 50 MB; pastes and hosted-web
  files take base64 (10 MB). Limits: `shared/chatAttachmentLimits.ts`.
- **A resting DAEX Cloud computer:** copying a file would wake it, so while the
  chat's computer rests (`useChatRuntimeScope().machineRests`) files stay on
  this device under `ade-held:<id>/<name>` (`heldChatAttachments.ts`, ≤ 64 MB in
  memory). The send copies them first (`prepareDeviceHeldForSend`); a failed
  copy sends nothing and restores text and files. A send with files always goes
  direct, never through the account queue.
- Parallel launches cap at `PARALLEL_CHAT_MAX_ATTACHMENTS` (12).

### Attachment handling

- Tray (`ChatAttachmentTray`) for composer and sent messages; preview modal uses
  the Files viewers on the chat's machine.
- Prompt grammar (`shared/attachmentLabels.ts`): the k-th image is `[Image #k]`,
  the k-th file `[File #k: <basename>]`; tokens resolve by ordinal.
- Image types sent as bytes: `PROVIDER_IMAGE_BYTE_MEDIA_TYPES` (JPEG, PNG, GIF,
  WebP); others go as a text reference. Inlined images are fitted
  (`fitImageForProviderInline`); a big file degrades the message, never fails
  the turn.
- Image reads go through `readAttachmentImageDataUrl(path, pin)` on the chat's
  machine; a remote path is never read locally.
- **Remote hosts** with `features.attachmentUploadV1` take a streamed upload
  (single-use ticket from `chat.createAttachmentUpload`, POST to
  `/ade-attachments/upload`); others use `chat.saveTempAttachment` (10 MB).
  iOS documents and videos use the chunked `chat.beginTempFileAttachment`
  contract (50 MB).
- Writes to `<projectRoot>/.ade/attachments` follow
  `shared/chatAttachmentStagingFs.ts` (UUID name, checked extension,
  containment).

### A slow or dropping link to the chat's machine

See [Remote runtime](../remote-runtime/README.md#a-slow-or-dropping-link).

- A `Slow connection · <rtt> ms` chip shows in slow-link mode.
- **`clientSendId`:** an unconfirmed send keeps its id per chat and payload, so
  a retry never writes twice. The brain writes the id on the message
  (`user_message.clientSendId`); a pane that sees it treats the send as
  delivered.
- A send that lost its answer holds the words up to two minutes (ten for
  another machine) while it checks the chat.

### Prompt history

↑ on the first line recalls prompts (this chat first, then recent prompts on
this device); ↓ past the newest restores the draft. **Search prompt history**
(Ctrl+R on macOS, Ctrl+Shift+R elsewhere).

### Drafts and scheduled send

Cmd/Ctrl+S saves the prompt as a runtime draft (claim-first restore, schedule
form). See [drafts-and-scheduled-send.md](drafts-and-scheduled-send.md).

### Model, effort and Fast

- **Catalogs** load per machine bucket (`runtimeCatalogCache.ts`, ≤ 8 buckets,
  no fallback to another machine's bucket): 30 min after a live probe for
  Cursor/Droid/OpenCode, 30 s for LM Studio/Ollama. A provider change on a
  machine invalidates its buckets (`invalidateRuntimeCatalogScope`). Chat hides
  CLI-only Cursor rows.
- **Allowlist mode** (`availableModelIdsOverride`) limits selection to exactly
  those ids.
- **Reasoning effort:** `ReasoningEffortPicker` (one bar per tier); last effort
  per family (`useReasoningByFamily`). A chat's saved level always shows, read
  only, when the visible ladder lacks it.
- **Fast** lives on the model row. With `fastModeAllowed === false` there is no
  Fast control and a chip press points to Settings → Chat → Fast mode. The chip
  reads "on" only on the selected row. Codex Ultrafast cycles Off → Fast →
  Ultrafast where offered. See
  [Provider service tiers](agent-routing.md#provider-service-tiers-fast-mode).
- **Handoff jobs:** a `HandoffLaunchJob` placeholder shows in the Work sidebar
  until the chat exists. Fork is the default when `providerSupportsHandoffFork`.

### Model hint (Jev)

`useComposerModelHint` suggests a model/effort for a new chat's first prompt
via one `ai.jevDecide` (`model_hint`) after 700 ms idle. It shows only at ≥ 0.7
confidence (cheaper models at 0.9 and only if the user tends to accept them),
never acts by itself, and is hidden while a turn runs, for Custom presets,
parallel launches, or on failure. Settings: `ai.chat.smartDecisionsEnabled`,
`ai.chat.modelHintMode` (`model_and_effort`, `effort_only`, `off`). History:
`ade.modelHint.history.v1` in `localStorage`. Calls use `modelRuntimePin`.

### Voice

- **Dictation:** `globalVoiceRecorder` records 16 kHz mono, transcribes locally
  (bundled `transcribe-cli` + Parakeet model), inserts at the caret and copies.
- **Voice conversation:** see [Voice conversations](#voice-conversations).

### Toolbar controls

- Overflow `⋯` (`ComposerOverflowMenu`): issue context, account, parallel
  models, iOS / App Control toggles; one entry renders as a plain button.
- **Account entry** only on a new Claude or Codex chat with a real choice; the
  pick travels as `instanceId`.
- Send is a split control; its caret offers background launch.
- Permission controls use `PermissionModePicker` (Claude, Codex presets,
  OpenCode modes, Cursor modes); popovers portal to `document.body`.

### Parallel and auto-create launches

- **Parallel mode** (empty Work draft): slots with model, effort, mode and
  permissions; Send needs two or more.
- **Brain-owned auto-create:** a single-model local launch on Auto-create lane
  picks session and lane UUIDs, names the lane deterministically, inserts an
  optimistic snapshot and fires `chatLaunch.start` (args from
  `buildChatCreateArgs`).
- **Renderer-owned chain** (`launch/rendererOwnedLaunch.ts`): existing lane,
  parallel, Cursor Cloud, or a runtime without `chat.startLaunch`. A
  `DraftLaunchJob` goes `creating-lane` → `starting-session` →
  `sending-prompt` → `ready` / `failed`.
- A foreground result opens only if no new draft was requested since Send
  (`markNewDraftRequests`, `launchMayOpenItsSession`, per project tab).

### Staged messages and sending during a turn

Queued messages show above the input as `PendingSteerItem`s with edit (cancel
with `requireQueued: true`), cancel (`ade.agentChat.cancelSteer`) and the
immediate actions the provider allows.

Per provider (`ACTIVE_TURN_DISPATCH_MODES`, `queuedSteersCanReorder`,
`providerStopModeSupport` in `shared/types/chat.ts`; unlisted = queue only):

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
  the row stays staged with one notice.
- `stagedSteerHint` names what this pane can really dispatch (from
  `capability.modes`).
- Reordering (drag or keys) calls `ade.agentChat.moveSteer`; only DAEX-held
  queues move.
- **Mid-turn split Send** (`ActiveTurnSendButton`): **Send during turn**,
  **Send after turn**, **Interrupt & send** (Cursor: **Interrupt & continue**).
  A mode with no wired handler falls back to queue, never interrupt.
- **The CTO composer never offers Send after turn** (its steer queue cap is
  zero; `liveRedirectOnly`).

### Stop choices

Stop is a split control over `shared/chatStopModes.ts`: **Turn only**
(`stop_only`), **Turn + queue** (`stop_and_clear`, default), **+ background**,
**+ queue + background**, and with spawned chats working **+ child chats** /
**Everything + child chats** (depth-first). `providerStopModeSupport` disables
rows a provider cannot honour. Codex stops background work via
`thread/backgroundTerminals/terminate` (never user shells). The choice is kept
per chat and drives `Cmd+.`. CLI: `daex chat interrupt --stop-children
[--stop-background]`, `daex chat stop-task <session> <taskId>`.

### Context meter and Compact first

- `ContextUsageDial` shows a percent only for `state: "measured"`; the tick
  marks `compactAtTokens`. The popover offers **Compact now** for Claude,
  Codex, Pi, OpenCode (when it lists `compact`) and local Cursor
  (`manualCompactAvailable`).
- **Compact first:** when the prompt cache expired and context ≥ 200k tokens
  (`COMPACT_FIRST_MIN_TOKENS`, `shared/compactFirst.ts`), a chip offers to
  compact before the next send. `chat.send` carries `compactFirst: true`.
  Claude queues the message behind a `/compact` turn; others wait for the
  compaction (≤ 90 s, `COMPACT_FIRST_INLINE_WAIT_MS`) then send. A failed
  compaction sends with the full chat and a notice. Setting: `ask` / `always` /
  `never` (Claude `ask`, others `never`).
- Claude warm timer (`always`, 1 h cache): compacts 54 min in
  (`warmIdleCompactionScheduler.ts`).
- Claude cache lifetime: `claudePromptCacheTtlOfWrites` stores
  `promptCache: { ttl, since }` per session; `ClaudeCacheTtlBadge` counts down.
- A DAEX Cloud send through the account queue carries the choice in
  `CloudChatMessageSettings.compactFirst`.

### Pending input in the composer

- **Questions** replace the textarea (`AskQuestionComposer`); picking marks,
  `Next`/`Enter` advances.
- **Blocking input locks the composer**; the service refuses sends with
  "Answer or decline the pending request before sending another message."
- **Codex non-blocking questions** (`isBlocking: false`) sit above an open
  composer.
- **Sending while an approval waits declines it and redirects**
  (`isRedirectablePendingRequest`): `submit` declines every waiting card via
  `respondToInput` first; a failed decline sends nothing.
- **Still hard-locked:** ACP runtimes, Codex and Cursor plan approvals, and
  user-only cards (`isUserOnlyConsentCard`: secrets, consent, MCP App calls).

### Launch memory

Last launch settings are kept per machine in
`ade.chat.lastLaunchConfig.v1:<surfaceProfile>:<kind>` (no project or lane).
The brain-side record is [Machine launch defaults](agent-routing.md#machine-launch-defaults).

### ModelPicker structure

`renderer/components/shared/ModelPicker/`:

| Module | Role |
|---|---|
| `ModelPicker.tsx` | Trigger and popover; Fast chips and `<Model> Fast` label. |
| `ModelPickerContent.tsx` | Search, rail, virtualized list (fixed 50 px rows). |
| `ModelPickerRail.tsx` | Provider tabs in a fixed order shared with web and iOS; Free models tab. |
| `ModelListRow.tsx` | Row: logo, name, Sign in, capabilities, Fast slot, star. |
| `modelCatalog.ts` | Merge catalog and registry per machine scope (no cross-machine fallback). |
| `runtimeCatalogCache.ts`, `sharedCatalogFetch.ts` | Per-machine cache; one deduplicated fetch that reserves its bucket before awaiting. |
| `useProviderAuthStatus.ts` | Auth per family from `aiDiscoveryCache`, probing the composer's machine (keyed on `pin.key`). |
| `useAuthOnlyFilter.ts` | "Only models I can use" (off by default). |
| `useModelFavorites.ts` | Favorites per account on the account server (`/account/model-favorites`); `localStorage` holds a copy and unconfirmed `{add, remove}` changes; a change queued under another account is refused (`account_changed`). |
| `useModelRecents.ts`, `useReasoningByFamily.ts` | Recents per client; last effort per family. |

A caller passing `providerAuthStatus` must itself listen for
`ade:ai-status-cache-updated` / `invalidated`, or Settings shows Connected while
the picker stays Off.

### Free models

With no plan, account or key, OpenCode Zen's free tier runs in DAEX's pinned
OpenCode. Rule: `shared/freeModels.ts` (`modelOnlyRunsInOpenCode`); iOS mirrors
it.

- The picker's Free tab lists the machine's free models (badges `free` /
  `ad-supported`); with no OpenCode yet it offers **Get free models**
  (`pinnedToolDownload` on the picker's machine).
- The machine's status carries `freeModels` (`freeModelsStatus.ts`):
  `nothingSignedIn`, `everSignedIn`, `preferredDefaultModelIds` (the manifest's
  `defaults.free`). With nothing signed in, the picker opens on Free, a fresh
  draft starts on a free model (not remembered as a launch default), and the
  sign-in strip offers **Use a free model**.
- A computer with no sign of any agent downloads OpenCode at launch
  (`agentToolDemand.ts`).
- Every read and download goes to the composer's machine (remote:
  `ai.pinnedToolStatus` / `ai.pinnedToolDownload`).

## Voice conversations

Voice runs on the Codex app server's realtime API (`thread/realtime/*`,
protocol `v3`, WebRTC) with the user's ChatGPT sign-in, desktop only.

- Shown when "Voice conversations" is on, Codex is signed in on the chat's
  machine, and the composer is not a grid tile or parallel launch.
- The renderer (`useCodexVoice`) owns mic, peer connection and playback; only
  the SDP offer goes to the brain (`chat.startCodexRealtime`). Do not trim the
  offer (CRLF); always send `version: "v3"`.
- `startCodexRealtime`, `stopCodexRealtime`, `getCodexRealtimeState` carry the
  chat's pin for the whole call.

| Mode | Chats | How a request reaches the chat |
|---|---|---|
| native | Codex | Codex runs each hand-off as a turn on the chat's thread; DAEX adopts it. |
| host | every other provider | A private `codex app-server` (MCP off, `codexMcpOff.ts`) with a relay thread (`codexVoiceHost.ts`); DAEX sends the spoken text to the real chat and narrates its turn. |

- `clientManagedHandoffs: true`: DAEX alone decides what voice says. Spoken
  requests are `user_message` with `metadata.voiceInput`.
- Narration (`codexVoiceNarration.ts`) speaks sentence by sentence, drops code,
  and yields to the user (`BARGE_IN_HOLD_MS`). "End the call" closes it.
- A finished session leaves a `system_notice` `status: "voice_session"`
  (`VoiceSessionCard`).
- One session per chat; switching chats or closing ends it.

## Chips

Every pill comes from `shared/chips.ts`: mentions, model and permission chips,
smart links, paths, and the transcript's skill, artifact, commit, branch and
web chips. A `Chip` carries a canonical `token` and a display `label`.

- Copy writes tokens to `text/plain` and labels to `text/x-ade-composer`
  (`shared/composerClipboard.ts`), so a chip pastes into another chat as a chip.
- Sent messages render through `splitTextIntoChipParts` (`ChipText.tsx`).
- `daex://` / `ade://` links go through `deeplinks.ts`.
- Folders are chips (pointers), never attachments.
- iOS ports the model and is held to `shared/__fixtures__/chipCases.json` (the
  `test-ios` CI gate watches that folder).

### Model chips

Token `@model:<registry-id>?effort=<level>&perm=<mode>`
(`shared/modelMentions.ts`). Inserted from the `@` menu's Models section; Tab
edits thinking then permission (`composerModelChip.ts`). At send,
`chatMentionService` expands it into an `<ade-mention kind="model">` block with
exact `daex chat create` / `daex chat handoff` flags (unknown model →
`resolved="false"`). The transcript chip offers **New chat with this model**.

### Local files an agent embeds

Markdown image syntax for a local file goes to `ChatInlineMedia.tsx` (resolved
on the chat's machine, read via `streamFileBytes` over
`createPinnedFilesApi(pin)`, ≤ 100 MB): images inline, audio and video players,
other files as chips.

### Entities an agent's reply names

`shared/threadEntities.ts` turns names in a reply (lanes, chats, models,
permission modes, slash commands, PRs, commits, Linear keys, zoned timestamps,
line ranges) into pills. Only real things (a match in the chat machine's index);
inline code is the strong signal; prose matches only UUIDs, zoned timestamps,
`PR #123` and known Linear keys. iOS: `WorkThreadEntityRules.swift`.

### Settings and page chips

Agents run `daex settings find <words>` (from `shared/settingsManifest.ts`) and
write the printed link. `daex://settings/<id>` draws a `setting` chip labelled
with the manifest path; protected settings show a lock ("Only you can change
this"). A Computer page opens on the chat's machine unless `?machine=` is named.
`daex://open/<place>` draws a `place` chip (`shared/openPlaces.ts`).

### Chips are pointers, so pointers need hover cards

`ChipHoverCard.tsx` (a `pointer-events-none` tooltip portal, never stealing
focus), `chipMenu.ts`, `chipActions.ts`. Reads start when the card opens and
resolve on the **chat's** machine (lane ids are unique per machine). MCP
mentions attach no tools and grant nothing. `chipPreviewStore.ts` caches
previews keyed by URL plus project state key, so credential-read titles never
cross projects.

## Message list

`AgentChatMessageList` has its own virtualizer (see
[transcript-and-turns](transcript-and-turns.md#virtual-scrolling-and-message-list-layout)).

- User messages render in full; long markdown-like messages render as markdown.
  `metadata.hideFullPrompt` shows only `displayText`.
- A stalled Codex turn shows Wait / Nudge / Retry / Resume
  (`agentChat.recoverCodexTurn`).
- A fork's seeded history gets one divider (`computeForkHistoryDividerRowKey`).
- **Sticky bottom** survives streamed growth and late measurements
  (`commitPinnedScrollTop`). Plain scrolling commits no render.
- **Jump to latest** reads `N new · Jump to latest`.
- **Older history pages silently** (head sentinel ~two viewports out; retries
  at 800 / 2400 ms). The Work pane backfills idle pages for local chats only.
- **Scroll memory** per chat and per subagent transcript (module LRU of 32).
- `useStableIdentity` keeps derived maps and `groupedRowKeys` stable across
  deltas.

### Row identity stabilization

`events` is a new array each delta; `useStableIdentity(value, isSame)` returns
the previous reference when nothing changed, for `resolvedInputStates`,
`resolvedInputAnswers` and `groupedRowKeys` (which feeds every row's
`ResizeObserver`).

### Paced text reveal

**Off by default**: at the brain's 100 ms buffer, painting on arrival looks the
same and costs half the main-thread time ([macOS baseline](../../perf/macos-baseline.md)).
The streaming row still splits into memoized settled segments plus a re-parsed
tail (cut at the last blank line outside fences). Turn pacing on with a positive
`ade.textRevealHorizonMs` in `localStorage`. Rules: `textReveal.ts`,
`useRevealedText.ts`.

## Mermaid diagrams

A ` ```mermaid ` fence in an assistant reply draws as a diagram
(`components/shared/MermaidDiagram.tsx`, shared with PR and file markdown):
loaded lazily, `securityLevel: "strict"`, HTML labels off, cached per source and
theme. An open fence while streaming stays code. iOS shows code.

## Tasks section

Chat Info shows one Tasks section from `deriveChatTaskList()`
([One task list per chat](transcript-and-turns.md#one-task-list-per-chat)),
drawn by `ChatTaskListView`, always expanded.

## File changes panel

One `N tools · M files` line above the turn's time row. A turn with a
`turn_diff_summary` uses `ChatTurnFileChangesPanel` (This turn / Full thread,
diffs via `ade.agentChat.getTurnFileDiff`, revert); otherwise
`ChatTurnFilesChangedSummary` (from work-log entries, deduped by path). Never
both.

## Rewind files confirmation

Claude and Codex user messages offer undo when the provider can prove a target:
`rewindFiles({ dryRun: true })`, `rewindFilesPreview.ts` pairs files with turn
SHAs, the dialog shows per-file diffs, then `rewindFiles`. Codex also moves the
thread ([Codex rewind](agent-routing.md#codex-rewind-and-0145-readiness)). Diffs
and restores use the chat's `runtimePin`.

## Chat Info and subagents panel

`ChatSubagentsPanel`: Codex goal, task list, subagents, background work and
Schedule in one scroller.

- Model chips from `subagentModelAttribution` (reported model, else parent's
  marked **inherited**). Inspecting a subagent locks the picker to its model.
- Spawned chats list via synthetic rows keyed `chat:<childSessionId>`;
  `filedSubagentsOf` (`chatSubagentRoster.ts`) adds chats filed under this one;
  a waiting child reads **needs you**.
- Schedule rows from `deriveScheduledWorkSnapshots()`; pause/play calls
  `agentChat.setScheduledWorkPaused`. A parent turn ending never marks a
  background row stopped.
- Caps: Subagents 12 active, Background 8, Schedule 10, with **Show all** and a
  `Completed (N)` fold.
- Claude Workflow runs show a **Workflow activity** card; Codex parallel agents
  map their statuses into completed/failed/stopped.
- The actions badge shows proof count, else running subagents, else task
  progress; the drawer opens once per chat when content first appears.

## Chat Actions and Sources

`ChatActionsDrawerPanel` is one scroll of sections, each only when it has
content: progress (goal, tasks, subagents, background), proof, Droid mission,
sources (`ChatSourcesPanel`, see
[Sources](transcript-and-turns.md#sources)). No section has its own border or
scroller.

**Handoff** is on the session card's context menu (Lifecycle → **Hand off…**):

- **Local handoff** (`ChatHandoffDialogs.tsx`): fork or brief, lane, note.
- **Another machine** (`CrossMachineHandoffModal`): destination, brief/fork,
  preview, then `startCrossMachineHandoff`, run by the source chat's brain;
  every call uses the chat's `runtimePin`. See
  [Cross-machine session handoff](../sync-and-multi-device/cross-machine-session-handoff.md).
- **Auto handoff…** (`AutoHandoffModal`).

## Terminal drawer

`ChatTerminalDrawer`: untracked shell PTYs in the chat's lane, pinned to the
chat's machine. Chat-owned terminals created elsewhere (an agent's App Control
launch) are deduped into it (`revealCreatedTerminal`). Removing the last tab
closes the drawer.

## Pending input card

The question surface is in the composer (`AskQuestionComposer`); the transcript
keeps `OpenQuestionReceipt` / `AnsweredQuestionReceipt`. The pane draws
`resolvedPendingInputsBySession[sessionId][0]`, reconciled with the summary's
`pendingInputItemId` (an asker can outlive its turn).

### Answer semantics

`shared/pendingInputAnswers.ts` (iOS mirrors):

1. Selection and note both travel; typing never deselects.
2. The Send label is the payload receipt (`Send 1`, `Send 1 + note`, …).
3. Multi-question Send needs every answer, except a lone typed reply
   (`isLoneTypedReply`), which marks the rest
   `QUESTION_SKIPPED_FOR_REPLY_ANSWER`.

- Decline sends `QUESTION_DECLINED_MODEL_MESSAGE` (stop and ask in plain text)
  for Claude, DAEX `ask_user`, Codex and Cursor; Pi sends
  `QUESTION_UNANSWERED_MODEL_MESSAGE`; a live Codex question gets
  `LIVE_QUESTION_DECLINED_MODEL_MESSAGE`.
- A typed reply with no pick is marked as talking back (`answersForModel`), so
  the model answers it instead of re-asking.
- Droid takes one string (`flattenAnswerForSingleStringProvider`).

### Card behaviour

Select marks, `Next`/`Enter` advances, hover changes nothing, only the option
list scrolls, minimize (`⌄`) is not decline (`×`). Keys: `1-9` pick, `↵`,
`←→`, `esc` declines. The free-text answer **is** the composer's editor (chips,
paste and attachments work); secret answers use a masked input. Responses go
through `ade.agentChat.respondToInput`.

**MCP elicitations:** Codex form schemas become paged questions; URL mode shows
Allow once / Deny (Always allow only when `_meta.persist` allows). Claude
(`onElicitation`) raises the same card; in Claude full-auto DAEX answers it
(empty or fully defaulted forms accepted, else declined). Codex full-auto never
auto-answers.

### Private secret card

Agents never ask for a secret in chat. `daex secrets request NAME --reason "…"
[--generate] [--timeout 30m]` (`project_secret.request`) shows a card with a
password field; the value saves to the project's secrets and the agent sees only
the name.

- Optional **Temporary private file** delivery (`--delivery file`): written on
  the chat's machine under `<ADE_HOME>/secrets/temp-files/` (owner-only), TTL ≤
  24 h, swept on start (`secretTempFiles.ts`).
- Mechanism: a pending-input question marked
  `providerMetadata.projectSecretRequest`; the value is an `isSecret` answer
  the transcript drops. `requestProjectSecretFromUser` saves in `beforeAccept`,
  so a failed save keeps the card open.
- User-only (`isUserOnlyConsentCard`). An orphaned card saves nothing.

### Connect card

`daex integrations connect <provider> --reason "…"`
(`integration_connect.request`) for GitHub, Linear or Jira. Methods in
`shared/integrationConnect.ts`; browser sign-in only when the chat's machine is
the computer in front of the person. Keys are verified with the provider first
(`integrationConnectAdapters.ts`) and saved in `beforeAccept`
(`requestIntegrationConnect`). User-only. `daex integrations status` lists
connections, never credentials.

### Approval vs question

`approval_request.kind` names the shape; optional `requestKind:
PendingInputKind` names what is asked (absent = approval). Readers use
`isQuestionKind(requestKind)`, including the push publisher
(`waiting_for_input` vs `waiting_for_approval`; see
[push notifications](../sync-and-multi-device/push-notifications.md)).

### Subagent cards

A subagent inside the chat's provider session (Claude background agent, Codex
`spawn_agent` child, OpenCode child, Muse subagent) asks through the **parent**
chat, with the parent's pin. DAEX child chats keep their own cards.

- `subagent: { key, name }` names the card ("`<name>` asks"). Copilot, Cursor,
  Droid and ACP carry no matchable id, so their cards stay unnamed.
- `PendingInputStack` lists several open cards; Chat Info marks the subagent
  **needs you**.
- **Accept all covers the chat.** For Codex and OpenCode DAEX remembers exact
  grants per chat (`sessionApprovalGrants.ts`) and answers matches itself.
- A subagent ending closes its cards; an answer after a restart is not sent but
  held in a `subagent_answer_unsent` notice.

### Cross-surface parity

`PendingInputRequest` (`shared/types/chat.ts`) is the one contract; labels in
`shared/pendingInputLabels.ts` (mirrored in Swift). iOS shows one strip above
the composer ("Request 1 of N"), removes answers optimistically, and keeps
drafts and question picks (never `isSecret` answers) in App Group defaults.

### Per-runtime question richness (ceilings)

| Runtime | Fields filled |
|---|---|
| Claude | Full (`AskUserQuestion`: header, description, preview, recommended, multiSelect). |
| Codex | Full (`requestUserInput`); `isBlocking: false` is non-blocking. |
| Cursor | Full via `normalizeCursorControlQuestions`. |
| OpenCode | header, multiSelect, freeform, description. |
| Copilot | Questions and elicitation via the question card. |
| Pi | DAEX `ask_user` (question, header, choices). |
| Droid | header and string options only. |

## Presentation profiles

`ChatSurfacePresentation` (`shared/types/chat.ts`): `mode` (`standard` |
`resolver`), `profile` (`standard` | `persistent_identity`), text overrides,
`accentColor`, `chips`. CTO and resolver surfaces use `persistent_identity`.

### Resolving the accent for the chat on screen

`chatAccentForRenderedChat()` (`chatSurfaceTheme.ts`), synchronous, best
evidence first: `sessionProvider`, `lockSessionProvider`, `modelFamily`,
`modelColor`, `NEUTRAL_CHAT_ACCENT`. **The caller owns staleness**: pass `null`
for anything not true this frame. Model inputs are withheld unless
`composerModelDescribesRenderedChat`, because the pane is not remounted on a
switch. `providerFromChatToolType` is the inverse of `chatToolTypeForProvider`
(`renderer/lib/sessions.ts`).

## State derivation helpers

- `pendingInput.ts`: `derivePendingInputRequests` deletes a card only on
  `pending_input_resolved` (a `done` only marks it swept);
  `resolvePendingInputs(derived, summary)` keeps a swept card the summary still
  names. Renderers never fold the summary in themselves.
- `chatTranscriptRows.ts`, `shared/chatTaskList.ts`, `chatExecutionSummary.ts`,
  `chatToolAppearance.tsx`.

## Cloud agents (Devin Cloud and Cursor Cloud)

A **cloud lane** keeps a local worktree as a mirror while its chats run on the
cloud's VM. These are third-party clouds, separate from DAEX Cloud.

- Tag `ade:cloud:devin` / `ade:cloud:cursor` (`shared/cloudLanes.ts`) marks the
  lane. One running cloud chat per lane.
- Devin has no branch field, so `buildDevinCloudBranchPin` puts a checkout
  instruction in the first turn. After each turn `syncCloudLaneMirror`
  fast-forwards a clean mirror.
- **Transport:** Devin Cloud uses `devin acp --cloud`
  (`acpDialects/devinCloud.ts`, CLI login); the directory
  (`devinCloudDirectory.ts`) lists, cancels and archives. Cursor Cloud reuses
  `cursorCloudFleetService`.
- `cloudAgentsService.ts` backs the `ai` actions `listCloudAgents`,
  `openCloudAgent`, `stopCloudAgent`, `archiveCloudAgent`, `launchCloudAgent`
  (IPC, `window.ade.cloudAgents.*`, sync commands).
- Panels in `renderer/components/app/cloudAgents/`.
- **Honest gating:** a Devin Cloud shell is `devin ssh <id>`; Cursor Cloud has
  no shell; machine-bound tools are off in cloud lanes (`CLOUD_MACHINE_TOOLS`);
  a Devin Cloud chat's model is fixed.

## Browser dock context

The Browser dock strips URL credentials, sensitive query values and fragments
from page context, and adds the current tab to ordinary sends while showing
only the user's text.
