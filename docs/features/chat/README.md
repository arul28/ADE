# Chat

Agent Chat is DAEX's interactive AI coding surface. Each chat binds a lane (git
worktree + branch), a provider runtime and a transcript into a persistent
`AgentChatSession`, with lane and session tracking, tool approvals, identity
continuity and handoff on top. DAEX runs 13 providers (Claude, Codex, Cursor,
Droid, OpenCode, Pi, Muse, Qwen, Kimi, Grok, GitHub Copilot, Devin,
Antigravity; `AgentChatProvider` in `apps/desktop/src/shared/types/chat.ts`),
each as a **chat** (DAEX drives an SDK or protocol) and as a **CLI** in a DAEX
terminal. The CLI is `daex` (`ade` still works).

Detail docs: [agent routing](agent-routing.md) (providers, models, permissions),
[composer and UI](composer-and-ui.md), [transcript and turns](transcript-and-turns.md),
[tool system](tool-system.md), [drafts and scheduled send](drafts-and-scheduled-send.md),
[quick slots](quick-slots.md), and per-provider docs for
[OpenCode](opencode-integration.md), [Copilot](copilot-sdk-provider.md),
[ACP providers](acp-providers-spec.md) and [Antigravity](antigravity-provider.md).

## Source file map

Paths are under `apps/desktop/src/` unless they start with `apps/`. Per-provider
files are listed in the provider docs; renderer chat files in
[composer and UI](composer-and-ui.md#source-file-map).

| Path | Role |
|---|---|
| `main/services/chat/agentChatService.ts` | The chat service: sessions, runtimes for every provider, turns, steers, pending input, handoff, persistence, scheduled work, spawns. Very large; search by symbol. |
| `shared/types/chat.ts` | All chat types and many single-sourced tables (`ACTIVE_TURN_DISPATCH_MODES`, stop support, notice copy). |
| `shared/ipc.ts`, `main/services/ipc/registerIpc.ts`, `preload/preload.ts` | `ade.agentChat.*` channels, arg validation, the renderer API (pinned calls). |
| `apps/ade-cli/src/adeRpcServer.ts` | Agent-facing RPC: action policy, `runtimeActor` stamping, standalone-chat restrictions. |
| `main/services/adeActions/registry.ts`, `actionPolicy.ts` | `chat.*` runtime actions and their remote/agent access. |
| `main/services/chat/chatRuntimeBudget.ts`, `chatRuntimeOwnership.ts` | Warm-runtime budget; DAEX-home ownership stamp (one brain per chat). |
| `main/services/chat/chatLaunchService.ts`, `chatLaunchArgs.ts`, `chatLaunchRecords.ts`, `chatLaunchDelivery.ts`, `shared/types/chatLaunch.ts`, `shared/chatLaunch.ts` | Brain-owned new-lane launches. |
| `main/services/chat/chatLaunchDefaults.ts`, `renderer/components/chat/accountLaunchDefaults.ts` | Launch defaults per machine and per account. |
| `renderer/components/chat/useAdeCloudDraft.ts`, `AdeCloudComposerParts.tsx`, `renderer/state/cloudAccess.ts` | Run on DAEX Cloud from the composer. |
| `renderer/state/adeCloudChatQueue.ts`, `renderer/state/cloudSavedChats.ts` | The account's message queue for an asleep or deleted DAEX Cloud chat. |
| `main/services/chat/sideChatService.ts`, `shared/sideChat.ts`, `sideChatClaudeCut.ts`, `piForkCut.ts` | Side chats (`/side`). |
| `main/services/chat/chatProviderFork.ts`, `crossMachineForkTransport.ts`, `codexEphemeralFork.ts`, `shared/crossMachineHandoff.ts` | Native forks and cross-machine fork transport. |
| `main/services/chat/deletedChats.ts`, `cliSessionLifecycle.ts`, `cliCrossMachineMove.ts` | Recently deleted chats; tracked agent CLI lifecycle and moves. |
| `main/services/chat/agentCliWakes.ts`, `agentCliTyping.ts`, `main/services/pty/cliStatusInspector.ts` | Wakes and typed text for tracked agent CLIs; idle-terminal check. |
| `main/services/chat/spawnMissionOwnership.ts`, `parentWakeBatcher.ts`, `childReportText.ts`, `childAncestry.ts`, `shared/sessionSpawnNesting.ts` | Spawns: who a child works for, parent wakes, child reports, orphaned children, Work filing. |
| `main/services/chat/chatScheduledWorkScheduler.ts`, `claudeCliScheduledWork.ts`, `shared/chatScheduledWork.ts` | Durable scheduled work for chats and tracked Claude CLIs. |
| `main/services/chat/chatAutoResumeCoordinator.ts`, `shared/chatAutoResume.ts` | Auto-resume after a usage limit. |
| `main/services/chat/chatWaitRegistry.ts`, `chatWebhookRegistry.ts` | Event-driven waits; chat webhooks. |
| `main/services/chat/draftService.ts`, `draftDelivery.ts`, `draftScheduler.ts` | Drafts and scheduled sends ([doc](drafts-and-scheduled-send.md)). |
| `main/services/chat/sessionNaming.ts`, `sessionMetadataService.ts` | Titles, lane names, status lines. |
| `main/services/chat/chatMentionService.ts`, `shared/chatMentions.ts`, `shared/chips.ts` | `@` mentions and chips. |
| `main/services/chat/slashCommandPromptExpansion.ts`, `markdownSlashCommandDiscovery.ts`, `claudeSlashCommandDiscovery.ts`, `cursorSlashCommandDiscovery.ts` | Slash command discovery and the one pre-expansion path. |
| `shared/mcpRegistry.ts`, `main/services/chat/mcpRegistryLaunch.ts`, `shared/callerMcpServers.ts` | The MCP registry; caller-injected MCP and per-provider support. |
| `shared/mcpApp.ts`, `main/services/chat/mcpAppHost.ts`, `mcpAppGrants.ts`, `mcpAppStore.ts`, `renderer/components/chat/McpAppFrame.tsx` | MCP Apps. |
| `shared/chatScene*.ts`, `shared/scene*.ts`, `renderer/components/chat/SceneFrame.tsx`, `main/services/scenes/*` | Scenes (agent-drawn UI) and their stills and previews. |
| `shared/claudePluginUi.ts`, `main/services/chat/claudePluginUiService.ts` | Claude mod UI for plugins. |
| `main/services/chat/piSdkUiBridge.ts`, `piSdkEventMapper.ts` | Pi UI bridge (`ask_user`, extensions). |
| `main/services/chat/externalChatHistoryImport.ts` | Import of external Claude and Codex chats. |
| `main/services/chat/chatTranscriptEntries.ts`, `chatTranscriptHistoryPager.ts`, `chatTextBatching.ts`, `shared/chatEventCompaction.ts` | Transcript text, paging, batching, compaction ([transcript doc](transcript-and-turns.md)). |
| `main/services/chat/runtimeEvents.ts`, `contextCompactionEmitter.ts`, `turnDiffSummary.ts`, `turnFileDiff.ts` | Canonical events, compaction events, turn diffs. |
| `main/services/chat/pendingInputRecovery.ts`, `shared/pendingInputRequest.ts`, `sessionApprovalGrants.ts`, `codexMcpElicitation.ts` | Pending input after restart, untyped reader, session grants, MCP elicitations. |
| `main/services/chat/turnEndQuestionCheck.ts`, `turnEndAsk.ts`, `awaitingOwnWorkTracker.ts`, `statusLineStaleCheck.ts`, `settleNudgeSweep.ts` | Jev checks on chats. |
| `main/services/jev/*`, `shared/jevSettings.ts` | Jev decisions. |
| `main/services/chat/nextPromptSuggestion.ts` | Next-prompt suggestions. |
| `main/services/chat/hostSleepChipTracker.ts`, `shared/hostSleepNotice.ts` | "Paused — computer asleep". |
| `main/services/runtime/brainUnplannedRestart.ts`, `liveTurnProjects.ts`, `renderer/components/app/BrainRestartNotice.tsx` | Continuing chats after an unplanned brain restart. |
| `main/services/chat/providerThreadMove.ts`, `providerResumeClassifier.ts`, `continuityConversation.ts` | Moving a thread between accounts; resume failure classes; continuity summaries. |
| `main/services/chat/claudeInputPump.ts`, `buildClaudeV2Message.ts`, `claudeSdkCompat.ts`, `claudeSubprocessReaper.ts`, `claudeMcpConfigFile.ts`, `claudeOutputStyles.ts` | Claude runtime pieces. |
| `main/services/chat/codexAppServerPool.ts`, `codexPlanHandoff.ts`, `codexErrorPresentation.ts`, `codexThreadSample.ts` | Codex runtime pieces. |
| `main/services/chat/cursorSdk*.ts`, `cursorCloud*.ts`, `cloudAgentsService.ts` | Cursor adapter, Cursor Cloud, cloud agents. |
| `main/services/chat/droidSdk*.ts`, `piSdk*.ts`, `piSession*.ts`, `copilotSdk*.ts`, `museSdkHost.ts`, `acpHost/`, `main/services/opencode/*` | Other provider adapters (see provider docs). |
| `main/services/chat/sdkWorkerProcess.ts`, `workerAttachmentImages.ts`, `main/services/shared/processOrphans.ts` | Forked SDK workers, worker image IPC, orphan sweeps. |
| `main/services/ai/pinnedProviderTools.ts`, `shared/pinnedToolSpawnEnv.ts`, `main/services/ai/providerFallForward.ts` | Pinned provider binaries and fall-forward. |
| `main/services/chat/providerInlineImage.ts`, `attachmentInlineGuard.ts`, `clipboardImageEncoding.ts`, `claudeInlineDocument.ts`, `shared/chatAttachmentStagingFs.ts` | Attachment fitting and staging. |
| `main/services/builtInBrowser/*`, `shared/types/builtInBrowser.ts`, `renderer/components/browser/*`, `renderer/components/chat/ChatBuiltInBrowserPanel.tsx` | The DAEX browser (Work tool and Browser top tab). |
| `main/services/devServers/*`, `renderer/lib/laneDevServers.ts` | Dev-server discovery and stop. |
| `renderer/components/work/WorkLiveCornerCard.tsx`, `renderer/components/terminals/useNativeToolSessions.ts` | Corner card and native tool feeds. |
| `renderer/components/chat/ChatFindLayer.tsx`, `renderer/lib/findScope.ts` | Find in a chat (⌘F). |
| `shared/threadComments.ts`, `main/services/chat/threadCommentService.ts` | Thread comments and Add-to-chat quotes. |
| `shared/messageAuthor.ts`, `main/services/chat/laneShareMoveChat.ts` | Lane sharing message authors and moves. |
| `shared/types/personalChats.ts`, `packages/sdk/` | Personal chats contract; the embeddable SDK. |
| `main/services/ai/tools/` | DAEX tools ([tool system](tool-system.md)). |
| `shared/chatStopModes.ts`, `shared/steerOrder.ts` | Stop modes; queue reordering. |
| `shared/chatErrorPresentation.ts`, `shared/providerAccountRefusal.ts` | Failed-turn copy; provider account refusal verdict. |

## Gotchas / fragile areas

**Scope and machines**

- **Personal chats** use the same engine with `surface: "personal"` and a hidden
  internal lane, but replace prompt, cwd, env, slash discovery, guidance and
  browser profile at the boundary. Never treat a missing lane or project id as
  personal scope. See [Personal chats](../personal-chats/README.md).
- **Provider-account injection lives in `buildAgentRuntimeEnv`.** Every
  Claude/Codex process a chat starts derives env there; a path that builds env
  from `process.env` silently runs as the machine's default account.
  `sessionProviderLookupEnv` is only for lookups that must not pay its cost.
- **Claude slash/skill discovery is not per-account** (walks ancestor `.claude`
  dirs, ignores `CLAUDE_CONFIG_DIR`). Known boundary.
- **Pointer reconciliation probes one Codex home**
  (`reconcileThreadPointerFromRedundantSources`); with all state gone, a
  non-default Codex account's chat starts fresh.
- **Identity session filtering:** only `listSessions({ includeIdentity: true })`
  lists CTO chats. Check this in every new chat list.

**Turns and events**

- **Event emission order.** Text, tools, status and `done` come from several
  async sources; `chatTextBatching` must flush on every non-text event.
- **Claude streamed tool input is not optional.** On idle turns
  `content_block_start` often has `input: {}` and the real payload arrives in
  `input_json_delta` chunks. Parse at `content_block_stop` and re-emit with the
  same item id, or task lists freeze.
- **Claude system subtypes are triaged at the type level**
  (`HandledClaudeSystemSubtype`, `IgnoredClaudeSystemSubtype`, `AssertNever` on
  the rest), so an SDK bump adding one fails typecheck. Triage it in both
  stream readers; never widen the ignored union to pass the build.
- **Provider failures are terminal once.** One visible `error` per turn and
  error identity, then terminal `status` + `done`. `willRetry: true` is a
  `provider_health` notice, not a failure.
- **Terminal transcript evidence outranks a stale active summary**
  (`chatTurnState.resolveTurnActive`, used by every rehydration path).
- **A detached chat closes the turn that died with its runtime:** on hydration
  DAEX appends one `interrupted` close-out and a notice (all providers).
- **Interrupt idempotency:** each adapter guards repeat `interrupt()`.
- **Steer delivery:** `deliverNextQueuedSteer()` runs on every turn-end path;
  rows being dispatched sit in `dispatchingSteerIds` so a completing turn cannot
  push them. Claude's `pendingSteers` persist (`MAX_PENDING_STEERS`), paths
  re-resolved within the lane root.
- **Auto-resume after a brain restart** retries only when its wake message is
  definitely absent and no turn started (60 s settling window).

**Pending input**

- **Derivation.** `derivePendingInputRequests` (`pendingInput.ts`) is the only
  renderer derivation. A `done` or mooting tool result only marks a card
  `sweptWithoutReceipt`; `resolvePendingInputs(derived, summary)` keeps it if
  the summary's `pendingInputItemId` names it. Only `pending_input_resolved`
  deletes. Main biases toward over-claiming (`latestPendingInputItemIdFromEvents`),
  because the opposite bias wedges a chat with no card while sends are refused.
  iOS mirrors this split (`workPendingInputSweepState`); change both together.
- **Answering a card whose asker is gone still writes a receipt**
  (`settleUnclaimedPendingInput`: `pending_input_resolved` plus "That request is
  no longer active."), recorded as `cancel`.
- **An unanswered `approval_request` is never trimmed out of history**
  (`shared/chatPendingInputRetention.ts`, applied in main and renderer).
- **A Codex async question is a card, not a waiter** (`managed.asyncQuestions`);
  it never sets `awaitingInput`, or the composer would lock on an ignorable
  question.
- **`normalizePendingInputAnswers` keys answers by question id**; a shared
  `responseText` goes to the last answered question.
- **Every path that ends a Codex turn settles its cards**
  (`settleCodexPendingInputs`): interrupt, `turn/aborted`, teardown,
  `thread/deleted`, process error/exit. Runtime death passes
  `planApprovals: "preserve-cards"` so plan approvals can be rebuilt from the
  transcript; a completed turn passes `"retain-waiters"`; queue-preserving stop
  modes do not settle cards. Exactly one receipt per card.
- **Dismiss & settle** is one backend transaction (`settleTerminalSession`,
  `dismissPendingInputForSettlement`), never renderer `respondToInput` then
  settle.

**Transcript and memory**

- **The in-memory event ring is live-tail only** (64 sessions,
  `CHAT_EVENT_HISTORY_BUFFER_MAX_SESSIONS`). Never write a merged snapshot back
  into it (it once grew to ~1 GB). Quiet chats release history after 10 min
  (`releaseIdleChatHistory`), except a ring holding events a failed append did
  not write.
- **Compaction is one idempotent policy** for storage and wire
  (`shared/chatEventCompaction.ts`); new heavy fields go in its cap table. See
  [Persisted transcript](transcript-and-turns.md#persisted-transcript).
- **Transcript reads** merge fragments by `messageId`/`turnId`
  (`MAX_TRANSCRIPT_READ_CHARS` 120,000).
- **Resume-time splice repair** (`chatEnvelopeSpliceRepair.ts`) rebuilds runs of
  split Claude text with SDK ids; other lines stay byte-for-byte; writes via
  temp rename with a one-time `.splice.bak`; files over 64 MB skipped.
- **Persisted state is versioned** (`PersistedChatState`, version 2); change the
  format only with a version bump.
- **Continuity recovery:** a resume failure never silently replaces the saved
  thread. DAEX classifies it and emits a `continuity_recovery` notice
  (`ChatContinuityRecoveryCard`); a `thread_missing` thread is rebuilt once from
  the conversation. Pointer ledger:
  `.ade/cache/chat-sessions/thread-pointers.jsonl` (see
  [Storage and recovery](../storage-and-recovery/README.md#durable-metadata-and-chat-continuity)).
- **An unchanged head sha is not an empty turn:** `collectTurnDiffSummary`
  compares against the working tree and untracked files.
- **Text limits** cut at code points (`shared/codePointText.ts`).

**Presentation**

- **Transcript measurement is in layout pixels.** The hosted web zooms with
  `body { zoom }`; rect values go through `toLayoutPx()` (`lib/webZoom.ts`).
- **Command text is redacted before it is shortened**
  (`redactCommandLine` / `oneLineRedacted`, `shared/secretRedaction.ts`; shell
  args via `maskShellCommandArgs`). Placeholders like `$TOKEN` stay visible.
  iOS mirrors it in `WorkCommandRedaction.swift`.
- **Refusals:** `classifyProviderAccountRefusal`
  (`shared/providerAccountRefusal.ts`) returns `plan`, `auth`, `model` or none.
  Only `auth` marks sign-in failed; a usage limit is never `plan`.
- **`disable-model-invocation` skills** are withheld from the injected skill
  list (the user can still run `/<name>`).
- **Cursor local chats read images** from `~/.cursor/projects/<slug>/assets/`
  and `<project>/.ade/attachments/` (read-only grant in `cursorSdkPolicy.ts`;
  the attachments grant needs the explicit project root and fails closed).

**Config and MCP**

- **Caller MCP strict mode is a guarantee on Claude only.** Read
  `strictRequested`, then `level === "enforced"`; never infer isolation from
  `delivered: true`. An explicit `strictMcpConfig: false` must survive create.
- **New `ai.*` config fields go in both `coerceAiConfig` and `mergeAiConfig`**
  (`projectConfigService.ts`) and in `AiConfig`. The merge replaces, local wins.
- **The Codex plan-limit notice** re-arms only on a real low reading, never on
  `null`.
- **A compacted CTO thread is replaced, not re-injected**
  (`refreshCtoProviderThread`; see [CTO](../cto/README.md#what-the-cto-is-given-each-turn)).
- **Parallel launch recovery:** change `AgentChatParallelLaunchState`,
  `registerIpc.ts`, `preload.ts` and `global.d.ts` together.

## Find in a chat (⌘F)

⌘F in a chat pane opens a find bar over the transcript (`ChatFindLayer.tsx`,
`useChatFindIndex.ts`, shared plumbing in `renderer/lib/findScope.ts`).

- It searches `presentedRows` (before folding) as a reader sees them: user
  bubbles, replies with markdown reduced to displayed text, plan checklists. It
  skips reasoning, tool output, duplicate answers and queued steers.
- The pane backfills history, so a chat under the resident cap is searched in
  full; while pages load the count reads `N+`.
- Moving uses `scrollToRowKey`, which opens a hiding fold first.
- Painting uses the CSS Custom Highlight API (`ade-find`, `ade-find-active`),
  never touching reply DOM. Closed, it costs nothing.
- ⌘K offers `Find "…" in this chat`.
- Clear timer/frame handles on unmount, not just cancel them.

## Built-in browser

The DAEX browser (`main/services/builtInBrowser/*`) is a main-process broker of
`WebContentsView` tabs on one shared profile (`persist:ade-browser`), shown as
the Work tools Browser panel (`ChatBuiltInBrowserPanel.tsx`) and the Browser top
tab. Agents drive it with `daex browser …`.

### Authentication and trust

- Touch ID WebAuthn on signed macOS builds (keychain group
  `VQ372F39G6.com.ade.desktop.webauthn`; source builds need
  `ADE_ENABLE_TOUCH_ID_WEBAUTHN=1`). Credentials are device-bound, not iCloud
  passkeys. No Apple Passwords or arbitrary Chrome extensions.
- Cookies stay as the site set them; a clean restart restores tab URLs only.
- HTTP Basic/proxy auth uses a sandboxed modal; values are never stored.
- **Self-signed local certificates** can be trusted for local/private hosts
  only (`builtInBrowserCertificateTrust.ts`), per profile, host, port,
  fingerprint and error, via **Trust and reload**. Only trusted-renderer IPC can
  trust; agents can read the failure but not approve it.
- The context menu opens only for the visible active tab of a focused window,
  so an agent's synthetic right-click cannot pop it.
- Search engine is a machine-wide setting (Settings → DAEX browser).

### Chrome identity, tab ownership, cleanup

- The browser presents a clean Chrome UA and client hints
  (`builtInBrowserChromeIdentity.ts`, tab preload `installChromeBrandHook`), so
  Google pages work; Google sign-in may still refuse (login import is the
  fallback).
- **Tab owners** (`browser/browserTabOwnership.ts`): you, a chat, or free. Real
  input on the visible tab, hand navigation, Attach to chat or **Keep** makes an
  agent's tab yours (`keptByPerson`).
- Agent tabs group under their chat in the strip. One browser per project
  profile, never per lane; a lane toggle filters.
- **Agent tabs clean themselves up**: the brain reports chat lifecycle through
  `chatBrowserLifecycle`; unkept tabs close 15 min after the chat goes idle
  (`CHAT_IDLE_CLOSE_MS`) and at once when the chat ends or its lane is archived;
  a 2 h sweep catches lost signals.
- Background tabs sleep after 30 min unless they hold something a reload would
  lose.
- `browserPanelNormalizers.ts#normalizeTab` is a field allowlist: add new tab
  fields there.

### Tabs on other machines

Tabs stay on the machine that opened them. A pane pinned to another machine
lists its lane tabs (`RemoteBrowserTabs.tsx`); picking one streams frames
(`work_tools.readBrowserTabFrame`, ~4 fps, 6 s watch) and **Take control** sends
input as frame fractions (`work_tools.sendBrowserTabInput`). Both are
person-only (`ADE_ACTION_USER_ONLY`). The phone uses the same calls and may ask
for a phone-size viewport (controller peers only; `builtInBrowserRemoteViewport.ts`).
`workTools.openBrowserTab` opens a lane's dev server from the phone (loopback
ports the lane serves only).

### New tabs, presets, find, dev servers

- A new tab is a launchpad on `about:blank` (Clipboard, Local servers, Recently
  used); DAEX sends no request nobody asked for. Recents are sanitized
  (`browserRecentUrls.ts`: no query, no credentials, no ephemeral loopback
  ports).
- ⌘F and ⌘W arrive through the app menu (`IPC.appCommand`,
  `lib/appMenuCommands.ts`); the browser claims them only when it holds the
  keyboard.
- A device preset owns the tab's debugger (CDP emulation, re-applied on
  navigate) and is letterboxed at exact CSS size; DevTools refuses an emulating
  tab.
- **Dev servers are discovered, never probed**: PTY ready lines, agent shell
  output and a listener scan in the lane's runtime
  (`devServerRegistry.ts`), published as `dev_server_event` and
  `work_tools.listDevServers` to every machine. `browser.autoOpenDevServer`
  (default true) opens a background tab once per lane and port.
- `daex browser proof --har` files a `browser_trace` artifact (needs network
  logging).

## The Browser top tab

The DAEX browser is also a top-level tab beside Chats
(`renderer/components/browser/BrowserPage.tsx`, route `/browser`,
`browserTabOpen` in the app store). It needs no project.

- It mounts `ChatBuiltInBrowserPanel` with `projectRootOverride={null}`: the
  `personal` collection on the shared profile.
- The page lives in main; leaving hides the view and coming back re-attaches it.
- Entry points: the home **Browser** button, `Mod+Shift+B`
  (`shell.browser.open`), and link routing from docked/Chats chats.
- Without a chat, Inspect and Attach hide. **Ask agent** docks a project-less
  chat (`usePersonalChatPaneScope`); the front tab goes into its composer as a
  `<ade-browser-tab …>` token (`shared/browserTabMention.ts`) and is handed to
  the chat with `handTabToChat` (renderer-only; agents cannot call it).
- The token text (`browserTabTakeoverHint`) tells the agent to claim the live
  tab (`daex browser claim --tab <id>`), not fetch the URL.
- Off-screen tabs are muted unless media started on screen
  (`builtInBrowserMediaHooks.ts`).
- The dock chat lives on the Chats tab's machine; the browser is always this
  computer's.

## Attach to the user's own browser

Only when the user asks, an agent runs `daex browser attach [--tab …]
[--browser chrome|edge|brave|arc|helium|chromium]` on the chat's machine; page
commands then act in the user's tab and print `target: your <browser> on
<machine>`. `daex browser detach` returns. Details:
[computer-use README](../computer-use/README.md#attach-to-the-users-own-browser).

## The corner card and parked preview views

`WorkLiveCornerCard` shows the browser when the Work tools pane shows something
else ([UI surfaces](../terminals-and-sessions/ui-surfaces.md#the-floating-live-preview-card-worklivecornercardtsx)).

- `builtInBrowserPreviewStream.ts` is refcounted per owner, skips rather than
  queues, pauses while hidden; it is not a recording.
- A watched tab is **parked** off every display (a detached view has no surface
  and captures come back empty). A view that never surfaced is **warmed** for
  `BUILT_IN_BROWSER_PREVIEW_WARM_MS` (120 ms) at the window's bottom-right
  corner first; do not lengthen it.
- A parked view keeps its size (`parkedPreviewSize`: 1280×800 when recording,
  the preset size, else the last settled panel rect via
  `createPanelRectSettler`, else 960×600). A size change off-screen needs a
  warm (`surfacedSizes`).
- Main-frame load failures set `loadError`; the card steps aside.

## The Work tools pane on iOS and the hosted web client

The pane runs on the desktop; iOS and hosted web get a **read-only mirror**
built by `apps/ade-cli/src/services/workTools/workToolsStateService.ts`:

- `activeTool` / `openTools` from the desktop renderer
  (`work_tools.setActiveTool`, in memory only); unknown tool ids drop.
- `browser` proxied from the desktop bridge (`built_in_browser.getStatus`,
  scoped by `projectRoot`); without a desktop, `browserUnavailable` explains.
- `appControl` read in-process.
- Frames never travel with state; clients fetch the newest observation through
  `workTools.readObservationPreview` (only inside the observation cache roots,
  images only, ≤ 10 MiB).
- `work_tools` reads are lane-scoped and deny by default for non-user callers
  without a resolvable lane; `callerLaneId` is always stripped; the CTO is
  exempt.
- Hosted web shows `WorkToolReadOnlyView`; iOS shows lane tool chips
  (`WorkLaneToolChips.swift`) and polls only while visible; `daex work-tools
  state` prints the mirror. Both remote commands are optional
  (`MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS`).

## Agents open panes: `daex ui show`

<a id="agents-open-panes-ade-ui-show"></a>

`daex ui show <surface>` (`apple`, `mac-desktop`, `app-control`, their
`floating-*` forms, `browser`, `proof`) asks a desktop to show a surface of the
agent's own chat. `daex apple show [--floating]` is the same.

1. The brain (`workToolShowRequests.ts`) publishes `work_tool_show_request` on
   the runtime event stream.
2. `renderer/lib/workToolShowRequests.ts` routes it to the pane registered for
   that chat (`useWorkShowRequests.ts`, `useChatPaneShowRequests.ts`).
3. `shown` only when the surface is mounted, has width and the window is visible
   (`workToolOnScreen.ts`); a closed tools pane floats the player instead.
4. No pane showing the chat → `held` (expires after 10 min). No answer in 8 s →
   `no_desktop`.

Agent input to the Apple device sends automatic float requests (`auto: true`, at
most every 5 s), never held.

## "An agent is using the browser"

A pulsing globe (session card, header, Work tools tab, iOS Tools sheet) shows a
chat driving the browser. Presence is derived from `built_in_browser.*` commands
that carry a chat, never announced (`builtInBrowserPresence.ts`): expires 20 s
after the last command, held while recording or watched (10 min cap), cleared
on tab close, capability revoke or login handoff. Desktop gets `agent-presence`
events (seed via `builtInBrowser.getAgentPresence()`, not `getStatus`, which
loads every tab); read-only clients get `agentBrowserPresence` in the Work-tools
lane state.

## Where the chat service runs

The chat service is built once per project inside the runtime that owns it: the
Electron main process for a local window, the remote `daex serve` daemon
(`apps/ade-cli/src/bootstrap.ts`, same `createAgentChatService`) for a remote
one. Renderers and iOS render chats; they never run them.

### One brain per chat

Two brains can share one DAEX home (a dev brain beside the installed app). Each
chat's persisted state carries a `runtimeOwner` stamp (`chatRuntimeOwnership.ts`):

- **Only the owner drives a chat.** Mutating calls go through
  `assertChatRuntimeOwnedHere`; elsewhere they throw
  `ChatRuntimeOwnedElsewhereError` naming the owner's socket
  (`daex --socket "<owner>" …`).
- Live ownership crosses DAEX homes; a dead owner's chat can be adopted when its
  provider account is available here.
- A secondary brain yields unattended work (recovery, prewarm, wakes) to a live
  installed machine brain; a chat stamped with an installed brain's socket waits
  for it (`isMachineBrainSocket`).
- **The machine brain takes its chats back:** a send there asks the owner to
  release (`takeChatRuntimeOrRefuse` → `chat.releaseChatRuntime`, 10 s). A busy
  owner answers `busy` (`ChatRuntimeBusyElsewhereError`).
- A non-owner never re-stamps or releases, reports `runtimeOwnedElsewhere`, and
  defers the chat's scheduled work.

## Caller-injected MCP

An embedder (the DAEX SDK, or `daex chat create --arg-json`) can pass MCP
servers at create time, plus a tristate `strictMcpConfig` that withholds the
user's own MCP config. They merge with DAEX-managed servers.
`CALLER_MCP_SUPPORT` in `shared/callerMcpServers.ts` is the source of truth;
`resolveCallerMcpCapability` reports it as the session's `mcpCapability`
(`level`, `mechanism`, `residual`, `delivered`, `strictRequested`).

- Strict is **enforced only on Claude**; Codex, Cursor, Droid and OpenCode are
  best-effort with a named residual; Pi refuses injected servers.
- Absent `strictMcpConfig` loads the user's MCP, except on the lightweight
  profile (SDK/personal chats), which is strict by default.
- Create refuses invalid servers, reserved names (`computer_use`, `daex-cto`,
  `ade-cto`), transports the provider cannot express (Codex has no SSE), more
  than `MAX_CALLER_MCP_SERVERS`, or any injected servers on Pi.
- See [DAEX SDK](../sdk/README.md#strict-mcp-honesty).

## The MCP registry

Servers defined once in Settings › Integrations › MCP servers reach every
ordinary chat at launch. The list is the account setting `mcp.servers`; names
can be turned off per device or per repository; secret values live in the
account vault (`readAccountSecret`). `registryMcpServersForLaunch` resolves
through `resolveMcpRegistryForLaunch` (`mcpRegistryLaunch.ts`) from the account
settings cache, so offline launches work. Caller-injected servers win on name
clashes. See [MCP servers](../onboarding-and-settings/mcp-servers.md).

- Not on the light profile or with `strictMcpConfig: true`.
- Only providers with `registryMcpSupport` (`shared/callerMcpServers.ts`) get
  them: Grok, Qwen and Devin do not. Pi registers them in its worker
  ([Pi MCP servers](agent-routing.md#pi-mcp-servers)); Kimi and Antigravity via
  ACP `session/new`; Copilot via the SDK's `mcpServers`.
- Unusable transports and missing secrets are left out with a warning notice.

## Caller-supplied permission policy

An embedder can pass `permissionPolicy` (`allowedTools`, `deniedTools`,
`autoApproveMcpServers`, `sandboxRoot`, required `fallback` `"ask" | "deny"`),
normalized by `shared/permissionPolicy.ts`, persisted, and re-read on every tool
call. It applies on the personal (SDK) surface only; on a Work chat it is
ignored and logged once.

- With a policy and no explicit provider permission, DAEX uses settings that
  still raise requests (`claudePermissionMode: "default"`,
  `codexApprovalPolicy: "on-request"`, `codexSandbox: "workspace-write"`).
- **Claude:** a `canUseTool` gate; `Bash` names no path, so tool rules then
  `fallback` decide it. Under `suppressAlwaysAllowRule`, "Allow for session"
  becomes a one-shot allow.
- **Codex:** the sandbox decides first; the policy governs only sandbox
  escapes; `sandboxRoot` replaces the lane as the containment root. Codex raises
  no approval for plain MCP calls.
- `PERMISSION_POLICY_SUPPORT` in `shared/hostSessionConfig.ts` is the source of
  truth. See [DAEX SDK](../sdk/README.md#permission-policy-and-approvals).

## Durable scheduled work

### Creating a schedule

Every chat runtime and tracked provider CLI can create a DAEX-owned schedule
with `chat.createScheduledWork`: a prompt (≤ 4,000 chars) and exactly one of
`delaySeconds`, `runAt` (ISO with offset or `Z`) or `cron` (five fields, brain
machine's local zone; `recurring: false` for one shot). The result carries the
brain's IANA `timeZone` and `nextRunAt`. Ids are `action:<sessionId>:<uuid>`.
Chats get the wake through `messageSession({ kind: "wake" })`; tracked CLIs
through `ptyService.sendToSession` at a verified prompt boundary. Recurring rows
expire after seven days.

**Claude SDK chats** can also arm `ScheduleWakeup`, `CronCreate` and `/loop`.
Claude owns the job id; DAEX records a job only after the successful
`PostToolUse` hook and mirrors it durably as an independent delivery guarantee.
`CronCreate` always creates a new job.

### The durable schedule store

Project-scoped SQLite `kv` key `agent-chat:scheduled-work:v1`
(`chatScheduledWorkScheduler.ts`), built by both Electron main and `daex serve`.
Records hold the owning session, provider ids, full prompt, timing, pause state
and expiry. Claude's Stop-hook `session_crons` snapshot reconciles the mirror,
but only for its exact provider-session owner, and DAEX keeps the full prompt
from `PostToolUse`.

### Firing a schedule

- On start, an overdue one-shot fires once with `late: true`; an overdue cron
  runs one catch-up turn (missed intervals are not replayed).
- Claude-owned rows usually fire natively (`claimNativeFire`, which needs an
  explicit SDK cron-task start); DAEX's backstop timer is 90 s later.
- **Mid-turn**, a due row stays `scheduled` and retries every 20 s; it never
  goes into the turn's input queue.

### Schedules across brains

Every brain that opens the project sees the same rows. To deliver, a brain
inserts `agent-chat:scheduled-work:claim:<id>@<fireAt>` with `insert or ignore`;
only the winner delivers, the others adopt its outcome. A brain yields chats it
does not run to the owner or the machine brain. A refused wake (signed out,
blocked) completes as `Not delivered: <reason>`; disk pressure and ownership
refusals release the claim.

### Schedule teardown

Deleting or archiving a chat cancels its schedules. Claude-owned jobs get an
exact-id `CronDelete` (DAEX waits up to 30 s); an unreachable owner never blocks
chat management. Continuity loss and lane teardown pause durable provider rows
(recoverable in Settings) and cancel local-only work. Quit and project close end
rows as `completed` (at rest) or `detached` (work in flight); schedules stay
armed for restart.

### Schedule delivery

- During a foreground turn the row retries; at the boundary the session is
  resumed or cold-started and gets a turn with `metadata.scheduledWake`. A race
  queues the wake as a new turn, never a steer.
- Tracked CLIs need the PTY's provider-specific prompt check plus quiet time;
  an ended CLI resumes first. Untracked shells are not targets.
- One-shots go `scheduled` → `fired` → `completed`; crons record `lastRunAt`
  and re-arm. Terminal rows keep ≤ 7 days / newest 200.

### Schedule controls and summaries

- Chat Info pauses/resumes all of a chat's schedules; DAEX-managed rows have
  Cancel. Settings › AI Features has **Pause all scheduled work**
  (`ai.chat.scheduledWorkPaused`) and an **Active scheduled work** manager.
- CLI: `daex chat scheduled-work create|list|cancel|pause|resume|status`
  (`--in`, `--at`, `--cron [--once]`, `--prompt`). Inside a DAEX chat or tracked
  CLI, `sessionId` defaults to `ADE_CHAT_SESSION_ID`; a bound agent cannot name
  another session.
- Mobile: `chat.createScheduledWork` (owner-only), `setScheduledWorkPaused` and
  `cancelScheduledWork`, each gated on host descriptors.
- Session summaries carry `nextWakeAt` and the live background-task count: Work
  rows read **Working** while background tasks run, **Waiting** with a countdown
  while a wake is armed, **Done** with neither.
- **Accepted sends read Working** at once (`showTurnBeforeRuntime` for cold
  ACP, Muse, Pi, Copilot and OpenCode runtimes); a held send carries
  `turnAcceptedAt` (cleared after `TURN_ACCEPTED_START_TIMEOUT_MS`, 60 s).
- Every unattended turn starts with a `Woke on schedule` divider.

### Auto-resume after a usage limit

When a turn dies at a usage limit and the provider published a reset (only
Claude's plan-quota snapshot and Codex's `account/rateLimits`),
`chatAutoResumeCoordinator.ts` arms a one-shot at reset + 90 s
(`source: "auto_resume_limit"`, id `auto-resume:<sessionId>`). Others show
`no_reset`.

- **The limit holds the queue:** messages queued behind the limited turn move to
  `usageLimitHeldSteers` (persisted) and go with the next turn. A model or
  account switch clears the hold and sends the queue.
- **Limits come only from structured signals** (`rate_limit_event`, result
  error prefixes, Claude "Extra usage: Stop the turn" overage). Assistant text is
  never scanned.
- Stale park state heals on hydration and at the next turn start.
- **One state field:** `AgentChatSessionSummary.usageLimitResume` (`armed`,
  `resuming`, `paused`, `opted_out`, `no_reset`, or absent) drives every client.
  `usageLimitParkedUntil` is a deprecated mirror for old iOS builds.
- Actions (`chat.*`): `updateSession {autoContinueAtUsageLimit}`,
  `resumeUsageLimitNow` (refuses `no_live_usage_limit` / `resume_in_flight`;
  restores the row if dispatch fails), `continueUsageLimitOnAlternate`.
- **Another account:** with `alternateAccount` set (another signed-in Claude or
  Codex account with room), Continue on (or Smart balance) copies the provider
  thread to that account's config home (`providerThreadMove.ts`) and continues
  in place; if the thread cannot move, a new chat in the same lane continues.
  Never offered to subagents.
- User activity cancels only this row (sweep at both dispatch commit points),
  never a user's cron. After two arms against distinct resets: `Paused after 2
  tries`.

### Goals

| Provider | Mechanism |
|---|---|
| Codex | App-server `thread/goal/*` (Edit, Pause/Resume, Clear). |
| Claude | `/goal <condition>` / `/goal clear`; DAEX tracks it (`noteClaudeGoalCommand`, `settleClaudeGoalOnTurnEnd`) because `active_goal` messages are unreliable. |
| Copilot | Autopilot goals ([Copilot doc](copilot-sdk-provider.md#goals-goal)). |

The goal shows first in the actions drawer and as a Work-row glyph. Reached or
blocked goals post `goal_reached` / `goal_blocked` notices, a phone push and an
OS notification.

### Waits

- `daex chat wait <session> --for …` long-polls `chat.waitFor` (≤ 25 s per poll;
  `chatWaitTargetMatches` in `shared/chatWait.ts`). A chat waiting on a
  user-only card answers `waitingOnUser` (exit 1).
- **Durable waits** (`chat.armWait`, `daex chat wait <ids…> --async [--any]`,
  CTO `waitForChats`) wake the caller when targets reach the state or after the
  timeout (24 h default). Persisted in `agent-chat:waiters:v1`
  (`chatWaitRegistry.ts`). A target waiting on the user is reported once per
  card. `daex chat waits`, `daex chat wait --cancel <id>`.
- `daex chat send <B> --after <A>` sends B's prompt once A is idle.
- Long Claude MCP calls and subagents move to Background after 2 min
  (`CLAUDE_AUTO_BACKGROUND_TASKS`) and wake the agent when done.
- `chat.holdBackgroundWork` / `daex chat wait --background`: rows show
  **Background work ×N**; `daex chat status` reports `WAITING`. Claude and
  OpenCode wake their agent themselves; for Codex DAEX re-reads held terminals
  every 15 s.

### Restart agent session

Stops the provider process and keeps the conversation; the next message starts
a fresh process on the same thread (picking up new skills, MCP and
instructions). Entry points: session menu, palette, `daex chat restart
[<session>] [--stop | --after-turn]`, `chat.restartSession`. An agent's bare
`daex chat restart` restarts its own chat after the turn. A running turn is
never stopped silently. Lost background work is reported (below).

### Background work lost with the agent process

Background subagents, workflows and shells live inside the provider process.

- **Spared first:** DAEX does not end a Claude process that runs awaited
  background work (`claudeHasAwaitedBackgroundWorkload`) for idle sweeps,
  budgets or settings changes; resets wait (`pendingSessionReset`) and the
  summary's `pendingSettingsAfterBackground` shows "Settings pending". Effort
  changes go to the live query first (`applyClaudeReasoningEffortLive`).
- `reasoningEffortChange` (`{ current, next, appliesAfter }`) shows an effort
  the running work has not taken yet, for every provider.
- **Told when lost anyway:** every Claude path that ends the process runs
  `reportLostBackgroundWork`: a warning notice, a note for the next prompt
  (`pendingRestartNote`), and one wake (`BACKGROUND_WORK_LOST_RESUME_PROMPT`)
  when the chat had ended its turn waiting on that work. User stops only tell.

### Continue chats after restarts

**Continue chats after restarts** (Settings → Chat › Restarts, default on) is a
per-machine value in `~/.ade/continue-after-restart.json`
(`continueAfterRestartStore.ts`; `ai.getContinueAfterRestart` /
`ai.setContinueAfterRestart` with the machine's pin). `continueAfterRestartHold`
decides for every restart kind.

- **Chats:** `recoverDetachedChatAfterRestart` closes the orphaned turn and arms
  one durable continue row (`armRestartResume`). Only chats active within 6 h
  (`RESTART_RESUME_MAX_AGE_MS`); archived chats stay asleep; a chat at rest
  resumes only if the restart stopped background work it waited on.
- **Updates:** `armUpdateResume` continues each chat at work; the desktop
  retries unarmed chats at 15 s, 60 s, 3 min, 10 min.
- **Tracked agent CLIs** (`cliReopenAfterRestart.ts`): a planned stop saves open
  CLIs to `.ade/cache/reopen-cli-after-restart.<pid>.json`; a crash is
  reconstructed from session rows of dead owners
  (`findCliSessionsCutOffByCrash`). Each reopen claims once per session and
  owner, at most `MAX_CONSECUTIVE_RESTART_RESUMES` in a row, none in a restart
  loop. A reopened CLI resumes at its prompt and gets one restart row.
- Entry points all go through `runRestartRecoveryIfPending`: the stale-run sweep
  (5 s after start, then every minute), load/startup for `detached` rows, and a
  turn start.
- **After a crash:** each brain keeps a run record
  (`runtime/brain-run/<endpoint>.json`, `brainUnplannedRestart.ts`); projects
  with a running turn are listed in `runtime/live-turns/`
  (`liveTurnProjects.ts`) and reopened one at a time.
  `getRuntimeStatus.lastUnplannedRestart` feeds `BrainRestartNotice`.
- The model always learns what the restart stopped through a one-time note
  (`buildRestartNote`, `pendingRestartNote`, prefixed by
  `consumePendingTurnContextPrefix`). `queueAgentNote` / `queueNoteForNextTurn`
  use the same channel for other host notes (DAEX Cloud memory guard, size
  approvals).

### Codex reset credits

A reset credit clears an account's rate-limit windows (not the billing
balance). Credits come from `account/rateLimits/read`
(`rateLimitResetCredits`, `status: "available"`); DAEX probes each Codex account
home at most every 15 min. Spending (`usage.consumeResetCredit`) is single-flight
with a kept idempotency key (`shared/usageResetCredit.ts`). A rate-limited Codex
turn with a credit posts `reset_credit_available` with **Use reset**.

## Codex models and runtime

DAEX pins Codex app-server 0.169.0 (`@openai/codex` in
`apps/desktop/package.json`) for chats and terminals. New Codex chats default to
the model the manifest names (`defaults.providers.codex` in
`shared/model-manifest.json`). The registry records a model's maximum context;
the running thread's reported limit is authoritative. See
[agent routing](agent-routing.md#codex-thread-behavior).

## Key concepts

### Claude Agent SDK pipeline

- `@anthropic-ai/claude-agent-sdk` is pinned exactly (0.3.321 in
  `apps/desktop/package.json` and `apps/ade-cli/package.json`). Each chat owns a
  `ClaudeQuery` fed by a `ClaudeInputPump` (`claudeInputPump.ts`) into
  `query.streamInput`; warmup uses `startup()`.
- Plugins use `pluginDelivery: "initialize"` for DAEX's binary (keeps Windows
  command lines short); `plugins_applied: false` logs
  `agent_chat.claude_plugins_ignored`. `claudeSubprocessReaper.ts` reaps
  children at shutdown.
- Hook events, progress summaries, prompt suggestions, file checkpointing and
  all skills are on. Retry/refusal/notification events become `system_notice`
  rows; `TaskCreate`/`TaskUpdate` become `todo_update`.
- **Turn end** is the SDK's `session_state_changed` idle event (after
  `heldBackResult` flushes); no time-based idle watchdog.
- **Stop modes:** `stop_and_clear` uses interrupt with `cancel_queued: true`
  when advertised, else per-message `cancelAsyncMessage`; `stop_only` keeps
  queue and background jobs; `*_and_background` also stops subagents.
- **Background exemption:** live background tasks and subagents protect the
  query from idle and budget eviction, up to 3 h of total silence
  (`RUNTIME_WORKLOAD_EXEMPTION_MAX_SILENCE_MS` = `SESSION_STALE_AFTER_MS`).
- Launch pins `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=3` and
  `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=20`. Settings follow
  [Provider config ownership](agent-routing.md#provider-config-ownership).
- SessionStore is read only for resume-time repair and the on-demand
  `ade.agentChat.getMainTranscript`; DAEX envelopes are the render backend.

### Providers and subagents

- Each provider has an adapter (see [agent routing](agent-routing.md#supported-providers)).
  Worker SDK adapters (Cursor, Droid, Pi, Copilot) run in forked workers over
  JSON lines; DAEX owns permissions, hooks, ask-user and the system prompt.
- **A parent's terminal event never proves every child stopped:** Codex
  children settle on their own `turn/completed`; OpenCode on the child's
  execution events; Cursor on the `Task` tool result; Droid on
  `mission_worker_completed`.
- **Delegation routing:** a short-lived child whose result belongs in the same
  thread uses the provider's native subagent tool (Claude `Agent`/`Task`, Codex
  collaboration, Cursor task, Droid workers, OpenCode `task`). Pi has none, so
  it uses a DAEX `--type subagent` chat. DAEX child chats are for durable
  transcripts, scheduling, cross-provider work or separate permissions. The
  runtime prompt and the `daex-cli-control-plane` skill carry this rule.
- **Lane-scoped:** every session has a `laneId`; `resolveLaneLaunchContext`
  resolves the cwd. Edits stay inside the lane worktree; read-only inspection
  elsewhere is allowed.
- **Identity sessions** (`identityKey: "cto"`) are left out of the Work list.

### Plan handoff

A Codex plan approval can be implemented here (default) or in a new chat
(**Implement in a new chat**, or `daex chat respond <session> --new-chat`, a
person only). The new chat gets the source's lane, model and account, full-auto
access unless a host permission policy owns approvals, and the plan as its first
message. Its id is reserved on disk first, so retries reopen the same chat; one
plan card takes one answer at a time (`codexPlanHandoff.ts`).

### Codex permission switches

Codex takes approval/sandbox changes at thread or turn start. Switching a live
session to Full Auto auto-answers stale lane-confined gates from the old policy
(turn-scoped, path-checked); ambiguous grants stay manual.

### Steer queue

Follow-ups during a turn can be staged (cap `MAX_PENDING_STEERS`, 10). Composer
modes per provider are in
[composer-and-ui.md](composer-and-ui.md#staged-messages-and-sending-during-a-turn).

- **Claude:** **Send during turn** (`priority: "next"`) and **Interrupt & send**
  (`priority: "now"`), both `shouldQuery: true`. A person's interrupt carries
  `origin: { kind: "human" }` (`sentByUser`), so Claude Code detaches a running
  Bash or web fetch; DAEX keeps the row running
  (`ClaudeRuntime.detachedToolCalls`) and settles it from the later
  `<task-notification>`.
- **Cursor:** `Run.steer()` inline (local only); **Interrupt & continue** stops
  with `stop_only` + `preserveQueuedSteersOnInterrupt` and sends the message as
  the next turn. Cursor Cloud refuses steers.
- `steer()` returns `{ steerId, queued, reason?: "queue_full" }`. Immediate
  modes are one atomic call. Each steer settles once (`settledSteerIds`).
- **The CTO thread's queue cap is zero:** deliveries without a mode use the
  provider's first non-queue mode; the CTO runs only on
  `CTO_LIVE_REDIRECT_PROVIDERS` (`shared/types/chat.ts`).
- `sendMessage({ routeActiveToSteer })` turns a phone's mid-turn `chat.send` into
  a steer ([remote commands](../sync-and-multi-device/remote-commands.md)).
- `ade.agentChat.stopTask({ sessionId, taskId })` stops one task.

### Inline agent download and the sign-in card

When a chat's provider is not downloaded or signed out, the error carries an
`agentCli` payload (`classifyAgentCliError`,
`apps/ade-cli/src/services/agentRegistry.ts`).

- **Missing:** `AgentCliAuthCard` with Download/Retry for the pinned copy on the
  chat's machine, then **Retry turn**.
- **Signed out:** a quiet `ProviderSignInReceipt` line plus
  `ProviderSignInComposer` above the prompt box. Before a send, a strip says
  "<Provider> isn't signed in on <machine>" with **Sign in**.
- One tap runs the provider's sign-in **on the chat's machine** (the composer's
  pin):

  | Flow | Providers |
  |---|---|
  | `providerInstances.login*` | Claude, Codex |
  | `ai.cliLogin*` | Copilot, Grok, Kimi, Droid, Muse, Devin |
  | `ai.antigravitySignIn*` | Antigravity |
  | Cursor's own login | Cursor |
  | Settings page on that machine | Qwen, OpenCode, Pi |

  On success the stopped turn is resent (`resendLastUserMessage(…, {
  afterSignIn: true })`). See
  [Agents](../agents/README.md#agent-download--auth-from-chat).
- **Send is off until the provider is signed in** (`sendBlockedReason` "Sign in
  to <provider> first"); text stays. Skipped for DAEX Cloud, Cursor Cloud, Devin
  and CLI drafts (`draftSkipsLocalSignIn`). `/login`, Claude `/usage` and
  `/context`, and some Codex commands stay exempt (`sendBlockExempt`). Status
  refreshes on sign-in success, Settings cache invalidation, or window focus
  (≤ every 15 s), never on a timer.
- Signed-out models stay listed and selectable with **Sign in**; only other
  reasons dim a row.
- **Claude 401 fast-fail:** the first definitive auth signal ends the turn
  (`failClaudeTurnUnauthenticated`, `CLAUDE_RUNTIME_AUTH_ERROR`). On macOS DAEX
  first checks the keychain item (`probeClaudeKeychainLogin`); an unanswering
  keychain retries once after 15 s rather than showing a sign-out.

### Work draft launches and draft persistence

Renderer launch chains, jobs and project-switch safety are in
[composer-and-ui.md](composer-and-ui.md#parallel-and-auto-create-launches).
Composer drafts are saved to `localStorage` (`ade.chat.composerDraft.v1`) 350 ms
after a change (`COMPOSER_DRAFT_WRITE_DEBOUNCE_MS`); on quit main sends
`ade:app-will-quit` and waits up to 500 ms (`saveWindowDraftsBeforeQuit.ts`) so
panes flush. A flush never overwrites a newer stored snapshot.

### Built-in browser internals

- **Popups** become new tabs through `setWindowOpenHandler` + `createWindow`,
  keeping `window.opener` for OAuth.
- **Permissions** are denied by default; secure-origin managed contents get a
  native Allow / Block prompt remembered per origin.
- `openPanel: true|false` on navigation and tab calls controls whether the
  Browser tool shows (`--no-panel` / `--hidden` on `daex browser`).
- Browser commands work only from a DAEX-launched chat-bound agent or owned
  terminal with a browser actor capability.
- **Inspect** produces `BuiltInBrowserContextItem` chips; hit-testing is
  `builtInBrowserHitTest.ts` (iframes via `cdpFrameTransform.ts`).
- **Login import** (`builtInBrowser/loginImport/`) seeds the shared profile with
  cookies from another browser after a domain picker. Cookies only. Reads run on
  a `VACUUM INTO` snapshot in a child process (`loginImportReadWorkerClient.ts`,
  `ELECTRON_RUN_AS_NODE=1`). Trusted-renderer IPC only; `daex browser` has no
  import command. On Windows only Firefox and Helium import (Chrome App-Bound
  Encryption). Safari needs Full Disk Access (checked via `EPERM`).
- **Link rules:** `browser.linkOpenMode` (`in-app` | `external`, in
  `.ade/local.yaml`); Mod+Click always external, Shift+Click always in DAEX
  (`resolveLinkOpenTarget`, `openLinkFromUi`).
- **Per-tab capabilities** (renderer and `daex browser`, per-chat scoped):
  emulation presets (`shared/builtInBrowserEmulation.ts`), zoom (0.25–5), find,
  DevTools (excludes network logging), a 500-entry network log with auth headers
  redacted and HAR export, and recording via a hidden `getDisplayMedia` page
  (5 min cap; a login handoff aborts it).
- Work-log `localhost` URLs get chips (`withLocalhostUrls`) that open in the
  DAEX browser; **Logs** reveals the chat's terminal.

## Scenes

A **scene** is a ```` ```scene ```` fence of HTML/CSS/JS an agent wrote,
rendered live in the transcript (`SceneFrame.tsx`, `shared/chatScene*.ts`). It
is code, so it never runs in DAEX's renderer. The `daex-scene` skill teaches
agents to write one; every agent prompt carries one line on when to use it
(`buildAdeBootstrapGuidance`).

**A scene shows, and it can ask.** `ade.reply(text)` or a `data-reply`
button/form puts a draft in the prompt box after a real click (nothing is
sent). A scene is **answered** once a reader message follows it; reply
controls then go inert. A reply is never a permission. `parseSceneHostMessage`
allows only `ready`, `resize`, `settled`, `emit`, `error`, `open`, `reply`.

### The sandbox is the whole contract

- An iframe with `sandbox="allow-scripts"` and **never** `allow-same-origin`
  (that pair gives the frame back its origin).
- Documents come over `ade-scene:` (registered non-standard, opaque origin,
  served from memory by `sceneDocumentStore`; the id is a map key, never a
  path), or a blob URL fallback.
- `rendererCsp.ts` lists `ade-scene:` and `blob:` in `frame-src` only.
- `SCENE_CONTENT_SECURITY_POLICY` starts `default-src 'none'` with
  `connect-src 'none'`: a scene cannot fetch. The policy is sent as a header
  and as the first `<head>` meta; model-written CSP metas and `<base>` are
  stripped.
- It cannot stop CPU use or a misleading drawing; scenes cannot approve,
  confirm or fetch.

### The still

A scene leaves a still when it stops moving (`settled`: no animations and a
quiet DOM for 600 ms, or after 4 s). Capture is a window crop only when the
rect is provably the scene (`measureCapturableSceneRect`). Stills are filed as
artifacts with `metadata.kind = "scene_still"` and excluded from every proof
surface; one per `sceneScopeKey` (per fence), at most 32 per chat. The broker
is the index; rehydrated mounts show the still first.

### Lifetime and idle

- One IntersectionObserver per scene (`useSceneOnScreen`): mount after 120 ms
  near the viewport with no scrolling for 150 ms, unmount 4 s off screen. A
  scene that already played comes back **restored** (animations jump to their
  end).
- A settled, untouched scene idles: endless animations pause, rAF batches to
  250 ms. Measured with `scripts/perf-chat-scenes.mjs`.
- A streaming fence shows a `drawing` placeholder and mounts once when it
  closes.
- **Proof** (`window.ade.scene.attachProof`) files the current view through the
  artifact broker (or the CTO-only `computer_use_artifacts.ingestSceneSnapshot`
  in runtime-backed builds), with a lexical then realpath jail.

### The injected SDK

`window.ade` (`ade.data`, `ade.theme`, `ade.reply`, `ade.open`, `ade.ready`,
`ade.animate`, `ade.countUp`, `ade.chart`, …) ships no third-party library.
Theme values are resolved and pushed live; fonts are inlined as data URLs.

### Live data and click-through

`<!-- @scene data="lanes,sessions,prs" -->` subscribes to a read-only snapshot
from the chat's machine (`sceneData.ts`; names, counts, states and `daex://`
links, never paths or transcripts), sent on change at most once a second.
`ade.open` opens `daex://` links in DAEX and http(s) in the DAEX browser with
the chat's pin, only with focus and user activation, at most once per 800 ms.

### Previewing a scene before it is sent

`daex scene preview <file|-> [--theme] [--width]` renders in a hidden offscreen
window on the attached desktop (`scenePreviewRenderer.ts`, a partition that
refuses every request; 20 s settle, 25 s hard stop) and prints a screenshot path
(`.ade/cache/scene-previews/`, newest 20) plus problems from `lintSceneSource`.

### Limits and failure

Source ≤ 96,000 bytes (`SCENE_LIMITS.maxSourceBytes`); height 120–960 px; 64
documents in the store. Errors pin to the toolbar without tearing the frame
down; a throw before `ready` collapses to a banner with Retry / Show code.

## MCP Apps

An **MCP App** is a page an MCP server ships with a tool (`_meta.ui.resourceUri`
`ui://…`); DAEX shows it under the tool call. The page is third-party code.
Runs in Claude and Codex chats on desktop and iPhone; other providers show
ordinary rows; hosted web shows fallback text.

- **Capture** (`mcpAppHost.ts`): on tool completion, read the page through the
  chat's provider session (`query.readMcpResource` for Claude, needs
  `mcp_read_resource_v1`; `mcpServer/resource/read` for Codex), require
  `text/html;profile=mcp-app` ≤ 4 MB, store it (`mcpAppStore.ts`) and emit an
  `ade_card` `mcp_app` (`mcp-app:<tool call id>`). Claude Code is told it may
  render apps via `CLAUDE_CODE_MCP_APPS_HOST=1` (undocumented; recheck on CLI
  bumps).
- **Sandbox:** same as scenes, served from `mcpAppDocumentStore`
  (`ade-scene://app/<id>`) with a policy built in main by
  `buildMcpAppContentSecurityPolicy` from the resource's declared origins only
  (https/wss hosts; no `'self'`, nested frames, eval, workers or device access;
  ≤ 128 origins).
- **Frame messages** (`McpAppFrame.tsx`, `parseMcpAppFrameMessage`):
  `ui/initialize`, tool input/result notifications, size changes, `ui/open-link`
  and `ui/message` (only right after a click), `tools/call` and
  `resources/read` (to the brain). Everything else is refused.
- **Calls back** (`chat.mcpAppRequest`): only while the chat's Claude query or
  Codex app-server is live (nothing is woken); read-only tools run at once;
  others need `userActivated` and, the first time, a user-only approval card
  (Allow once / Always allow / Don't allow). Grants are per server and tool,
  stored in `agent-chat:mcp-app-grants:v1` (`mcpAppGrants.ts`) with a server
  definition fingerprint when readable. `chat.mcpAppRequest` and
  `chat.revokeMcpAppGrant` are in `ADE_ACTION_USER_ONLY`.
- **iPhone** (`WorkMcpAppView.swift`): `chat.getMcpApp` and
  `chat.mcpAppRequest` sync commands; pages ≤ 1 MB; the policy comes from the
  Mac and the phone refuses pages without it; the page runs in a sandboxed
  iframe inside a DAEX shell page.
- **Limits:** 4 MB page, 512 KB stored input/result, 40 apps per chat. A page
  that does not handshake in 10 s folds to a banner; **Reload preview** never
  re-runs the tool.

## Claude mod UI

A Claude Code **mod** is a plugin with a hooks module that can draw a status
line, toasts, a band above the prompt and panes. DAEX chat draws them in one
dock on the composer; **off by default** (`ai.chat.claudePluginUiEnabled`,
Settings › Chat › Claude mods).

- **The channel is private:** `ui_status`, `ui_toast`, `ui_panes`,
  `ui_invalidate` system messages from the CLI; `ui_render`, `ui_press`,
  `ui_input`, `ui_select`, `ui_close` control requests via the untyped
  `Query.request`. None is in the SDK types. **A failure here never touches a
  turn**: `claudePluginUiService` checks `request` exists, times out each call
  at 5 s, swallows errors.
- Both Claude loops pass messages to `claudePluginUi.ingest` first; mod
  messages never count as model activity or hold a turn open.
- Trees pass `sanitizeClaudePluginUiTree` (known elements only, bounded,
  control/bidi characters stripped); links follow
  `safeClaudePluginUiHref` (https or localhost http) and open in the system
  browser.
- Snapshots go out as transient `session_meta_updated` (`claudePluginUi`),
  never to transcript, database, phones or web
  (`isClaudePluginUiOnlyMetaEvent`). Desktop reads `chat.getClaudePluginUi` and
  acts with `chat.actOnClaudePluginUi` on the chat's machine
  (`callPinnedOrBoundRuntimeActionOr`).
- A press is bound to the process `generation` that drew it and is never
  resent. Both actions are user-client only (`CLAUDE_PLUGIN_UI_ACTION_NAMES`).
- Not drawn on hosted web or iOS; a tracked CLI draws its own.

## Pi UI bridge, `ask_user`, and extensions

Pi asks the human from `AuthInteraction` (login), custom tool `execute`, and an
extension's UI context. `piSdkUiBridge` funnels all three into one reverse-RPC
channel (protocol version 2): `ui_request`, `ui_response`, `ui_notice`,
`ui_cancel`, each with an `origin` (`auth`, `tool`, `extension`, `approval`).

- `bridge.request()` never rejects; dismissals, aborts and timeouts resolve
  `null`.
- Every desktop path answers exactly once, including interrupt and teardown via
  `cancelPendingInputsFrom(managed, "pi", "ade")`. That helper must get every
  source the ending turn owns, or the session stays blocked (OpenCode drains
  `"opencode", "ade"`; Codex `"codex", "ade"`).
- Requests become pending inputs with `source: "pi"`.

**`ask_user`** is injected into every Pi chat (personal chats too); declining
tells the model to continue and state its assumption. **Approval gating** of
`bash`/`edit`/`write` and MCP tools: see [tool system](tool-system.md#pi-tools)
and [agent routing › Pi](agent-routing.md#pi).

**Extensions** load by default (`ai.chat.piExtensionsEnabled`) on DAEX's
`ExtensionUIContext` (`select`/`confirm`/`input`/`editor` → cards;
`notify`/`setStatus` → notices; TUI-only surfaces do nothing). Boundaries:

- **Repository code never loads:** `SettingsManager` with `projectTrusted:
  false`, so only `~/.pi/agent/extensions` loads, never a checkout's `.pi/`.
- Only in modes that grant tools outright (`edit`, `full-auto`); not in
  read-only or ask-first modes, nor personal chats.
- **Extension tools run outside DAEX's permission modes**; a one-time notice
  says so.

## External chat import

The external-session import turns a CLI session of any provider in
`EXTERNAL_SESSION_PROVIDERS` into a DAEX chat
(`externalSessionsService.importExternalSession` → policy in
`shared/externalSessionPolicy.ts` → `agentChatService.importExternalChatSession`,
which stamps `importedFrom` and returns the summary). Full doc:
[External Session Import](../terminals-and-sessions/external-session-import.md).

| Path | When | How |
|---|---|---|
| Claude native | Claude-family target or none | Reads the source JSONL; a copy or another cwd writes a copied transcript with a new id and resumes it. |
| Codex native | Codex-family target or none | `thread/read`; a fork calls `thread/fork` first. |
| Native continue | Droid, OpenCode, Pi, Copilot (`mode: "resume"`) | Seeds the provider's session pointer so the first turn opens the CLI's own session (session folder must be the lane root). |
| Replay copy | Everything else | History from `loadExternalSessionEvents` is staged as a transcript replay. |

Chat continue is not offered for Cursor or the ACP providers. Seeding reads the
last 32 MB (`MAX_IMPORT_TRANSCRIPT_BYTES`) and keeps the newest 2,000 content
events (`externalChatHistoryImport.ts`); imported tool turns get a `done`
(`withImportedTurnBoundaries`).

## Recently deleted chats

Deleting a chat removes DAEX's record and transcript, never the agent's own
copy. Settings › Deleted & Archived › Recently deleted (`daex chat deleted
list|reopen`) reads those copies back (`deletedChats.ts`).

- A row is written just before the delete; `deleted_chats` stays on this machine
  (excluded from CRR sync). The delete returns `{ recoverable }`.
- **Reopen** goes through the external-session import (same lane continues;
  another lane is a copy). **Remove from list** is user-only
  (`chat.removeDeletedChats`).
- A lane delete records its chats first; restoring the lane reopens them.
- `RecentlyDeletedSection.tsx` lists every online machine; each row's calls
  carry its machine pin. Hosted web uses `chat.listDeleted`,
  `chat.getDeletedDetail`, `chat.reopenDeleted`, `chat.removeDeleted`.

### Agent CLI sessions

A tracked agent CLI terminal (`row.tracked && isTrackedAgentCliToolType(row.toolType)`)
follows a chat's lifecycle through the same `chat.*` actions, on its owning
machine (`cliSessionLifecycle.ts`).

- **Delete** stops the CLI, waits up to 3 s for its conversation id, writes a
  `deleted_chats` row with `kind = 'cli'`, then removes the row. **Reopen**
  resumes it (`ptyService.resumeSession`) when the agent still has the
  conversation, else starts a fresh CLI with the old launch settings.
- **Archive** stops it at its prompt (a mid-turn CLI finishes first) and cancels
  its scheduled work.
- **Handoff and fork** start a new chat (fork via the import when the
  conversation id is known; otherwise a deterministic brief).
- **Moving to another machine** (`cliCrossMachineMove.ts`) packs Claude Code's or
  Codex's conversation file, writes it under the destination lane path, and
  resumes there; other agents start fresh with a brief. Refused mid-turn (use
  `--when-turn-ends`). The source row is locked to the destination
  (`setMovedAwayCliLock`). Agents may move only CLIs their own chat started.
  The destination must answer `cliMoveSupport: 1`.

#### Talking to an agent CLI session

`chat.messageSession`, `steer`, `interrupt`, `restartSession`, `updateSession`,
`switchAccount`, `regenerateSessionMetadata`, `listPendingInputs`,
`respondToInput` and `approveToolUse` also take a tracked CLI session id
(`agentCliSessionActions.ts`), running on the terminal's machine. Plain shells
are refused with a pointer to `daex terminal write`.

| Command | On a tracked agent CLI |
| --- | --- |
| `send` | Typed at a free prompt (`deliverWakeToSession`); busy → a durable queued wait (`delivery: "queued"`, cancel with `daex chat wait --cancel`). No attachments. |
| `steer` | Typed now, even mid-turn. |
| `interrupt` | Presses the cancel key (Esc; Esc twice for OpenCode; Ctrl-C for Cursor); nothing at a free prompt. |
| `restart` | Stops, waits up to 5 s, resumes in the same row. |
| `update` | Title/pin are row settings; model, effort, fast and permission go on the resume launch and relaunch the CLI (refused mid-turn or when the CLI cannot carry the setting). |
| `switch-account` | Claude and Codex: copies the conversation into the new account's config home and relaunches. |
| `pending` / `respond` | One `cli-prompt` item while the CLI waits at its own prompt; `--approve` / `--approve-session` / `--deny` press the provider's keys (Claude Code, Codex, Cursor only). |

## New-lane launches

A chat on **Auto-create lane** is launched by the brain
(`chatLaunchService.ts`). The client picks `launchId` (the session id) and the
lane id, calls `chat.startLaunch` and opens the chat at once; the brain publishes
a full `ChatLaunchSnapshot` after every change. A **configured** new lane (the
picker's `+`) passes a recipe in `ChatLaunchArgs.laneConfig` (`root` / `child` /
`import`); nothing is created until Send.

Stages:

1. **Fetch base branch** (omitted when lanes come from the local base).
2. **Check out files:** `laneService.create` with the reserved id, streaming
   git's progress. Retries clean leftovers (`cleanupReservedWorktree`) and adopt
   an existing lane row (`findLaneIdentity`).
3. **Apply lane template / set up environment** (`runLaneEnvironmentSetup`),
   only when configured.
4. **Start agent:** `createSession` with `sessionId = launchId`, the opening
   message, then messages queued during setup (`chat.queueLaunchMessage`; a
   failed delivery stays listed and retries). A CLI launch stops at
   `awaiting-client`; the client reports with `chat.completeLaunchClient`.

The lane gets a deterministic name, then `generateAutoLaneIdentity` renames it.

- `chat.cancelLaunch` is for setup only (after the agent starts it refuses);
  it deletes everything the launch created, including the branch.
- `chat.retryLaunch` reruns from the first unfinished stage without
  duplicating anything. `chat.startLaunchNow` starts the agent during
  environment setup ("Start anyway" after a failure).
- Snapshots stream as `chat_launch_event` (desktop, web, phone);
  `chat.listLaunches` hydrates. Once the chat exists the brain writes an
  `ade_card` `lane_setup` (`buildLaneSetupCard`, `lane-setup:<launchId>`).
- Records persist under `.ade/cache/chat-launches/`; a brain restart turns a
  running launch into `failed` with Retry.

### DAEX Cloud lanes

<a id="ade-cloud-lanes"></a>

A launch with `cloud: { sizeId }` (`shared/cloudTiers.ts`) gets one new DAEX
Cloud computer for its one lane, made by the account server's launcher
(`/cloud/launches`; see [DAEX Cloud](../ade-cloud/README.md)). The owner (desktop
main `cloudLaneLaunchService.ts`, or a brain for the CLI) sends the launch; the
computer joins the account, clones the repo and starts the same launch on its
brain (same `launchId` and `laneId`).

- Three rows precede the brain's (`cloudLaneComputerStages.ts`): **Make
  computer**, **Join your account** (with **Approve** when it cannot sign
  itself in), **Clone repository**.
- After hand-off the brain finishes with the desktop closed. A repeated start
  returns the same launch and computer (server `replayRequest`).
- Retry replaces a computer that failed before its agent started, under the
  same id. Cancel before hand-off asks the server first.
- Records in `<userData>/cloud-lane-launches/`. Only GitHub origins, no
  uncommitted start, ≤ 10 files of 25 MB on the first message.
- Kinds: `chat`, `cli` (parks at `awaiting-client`), `lane`
  (`daex lanes create --machine cloud`).

#### Run on DAEX Cloud in the composer

<a id="run-on-ade-cloud-in-the-composer"></a>

- **Run on:** `DraftMachinePicker` always lists one **DAEX Cloud** row for a
  signed-in account (`renderer/state/cloudAccess.ts`); lane computers get no
  rows.
- **Lane:** Auto-create, then this project's DAEX Cloud lanes from computer
  metadata (nothing wakes). DAEX Cloud has no main checkout.
- **Size** (new lane only): tiers from the account catalog; the default is the
  account preference `cloudDefaultTier`.
- Send: a new lane calls `chatLaunch.start` with `cloud`; an existing DAEX Cloud
  lane sends through its computer's pin (`adeCloudLaneBinding.ts`), waking it.
- **Before Send**, a label holds Send off (text stays) when DAEX Cloud cannot take
  the message (account facts from `CloudAccountState`; start problems from
  `cloudLaneLaunchStartRefusal` in `shared/cloudLaneLaunch.ts`, which main also
  uses). A DAEX Cloud draft shows no local sign-in strip.

### Messages to an asleep or deleted DAEX Cloud chat

<a id="messages-to-an-asleep-or-deleted-ade-cloud-chat"></a>

A send never waits for a DAEX Cloud computer to start: the account server queues
it (`POST /cloud/chats/:machineKey/:chatId/messages`), and the computer takes it
when up.

- **Asleep computer:** `cloudSavedChats.ts` sends through the queue
  (`sendThroughAdeCloudQueue`); the queue id is the send's `clientSendId`.
  Settings picked since the last send ride the queued message (`settings`) and
  are applied by the computer before sending.
- **Deleted computer:** the queue starts a launch that continues the chat on a
  new computer in the same chat row (native capsule for Claude, Codex,
  OpenCode; transcript replay otherwise). Files wait.
- Without queue support an asleep computer is woken; a deleted computer's chat
  shows `SAVED_CHAT_COMPUTER_GONE_MESSAGE`.
- The chat shows queued messages as the person's own bubbles with Cancel
  (`useCloudQueuedBubbles.ts`); delivery is matched by `clientSendId`; failed
  ones offer **Put back** / **Dismiss**. `CloudQueueSendCard.tsx` shows a new
  computer's setup. Reads happen on open and focus, no timer.

### Launch defaults follow the account

A new draft starts from the newer (`updatedAt`) of the machine's launch defaults
(`chat.launchDefaults`, pinned, `chatLaunchDefaults.ts`) and the account row
`chat.launchDefaults.v1` (scope `all`), merged in `accountLaunchDefaults.ts`.
Fast mode never goes to the account. A saved per-pane draft with a model wins
over both.

## Session lifecycle

1. **Create:** `createSession` (`ade.agentChat.create`) persists an
   `AgentChatSession` and emits `status: "started"`.
2. **Warm up** in the background (Claude: 20 s watchdog around `startup()`).
3. **Send:** `sendMessage` (`ade.agentChat.send`, action `chat.sendMessage`).
   `chat.messageSession({ sessionId, text, kind })` is the agent-to-agent
   primitive: `auto` (steer an active session with the provider's default mode,
   wake an idle one; Cursor Cloud routes to `interrupt`), `queue`, `wake`,
   `interrupt-replace`. CLI: `daex chat send` (auto), `daex chat message --kind`,
   `daex chat status` (`chat.getTurnStatus`: RUNNING / BLOCKED / WAITING /
   IDLE), `daex chat read` (bounded `chat.readTranscript` / `readTranscriptPage`).
   - **Scope:** a session-bound agent's scoped calls apply only to its own chat;
     `chat.messageSession` is the way to reach another. A cross-session target
     fails with `policyDenied` / `session_scope_denied`. A kickoff
     `chat.sendMessage` to the caller's own empty direct child is converted.
   - **Timeouts:** interactive sends have no clock. `runSessionTurn`
     (automations, headless) defaults to 5 min (`null`/`0` = none), with an
     optional `idleTimeoutMs` that pauses while tools or approvals are open
     (`sessionTurnLimits.ts`). Expiry interrupts the turn, never the chat.
4. **Stream** to the renderer via `ade.agentChat.event`. Codex turns run a
   no-first-output watchdog that reconciles with `thread/read`, tries one
   restart + resume, then publishes `turn_health`.
5. **Complete:** terminal `status`, optional `turn_diff_summary`, text flush,
   idle, next queued steer. A terminal failure also stops active child
   subagents.
6. **Dispose** ends the runtime and persists `disposed`. Project close and quit
   end chats `completed` or `detached` and keep durable schedules. Lane
   archive/delete disposes every session of the lane.

### Settling

Settling writes `settledAt`; it stops nothing (`sessions/settleWiring.ts` only
refuses a running turn). In `Needs you`, settle uses one transaction with
`dismissPendingInput: true` (`dismissPendingInputForSettlement`), never
`respondToInput`. Tracked CLIs can dismiss only an explicit `daex chat ask`
marker.

### Parallel launch

Renderer-orchestrated: one lane per model slot from the current branch
(`<base>-<model-family>`), progress persisted under
`agent-chat-parallel-launch:<projectRoot>:<parentLaneId>` in `kv`, one session
per lane with the same prompt, then `/lanes?laneIds=…&inspectorTab=work`.
Unfinished state is recovered and cleaned on reload.

### Runtime eviction and budget

- **Inactivity eviction** every 15 s (`SESSION_CLEANUP_INTERVAL_MS`): an idle
  runtime with no pending input is torn down after 3 min
  (`SESSION_INACTIVITY_TIMEOUT_MS`, all providers). Restarts are cheap (prompt
  cache).
- **Background-work exemption** for Claude and OpenCode runtimes, up to 3 h of
  silence (`RUNTIME_WORKLOAD_EXEMPTION_MAX_SILENCE_MS`); then reclaimed with a
  notice (`agent_chat.runtime_workload_exemption_expired`).
- **Teardown reasons:** terminal (`handle_close`, `ended_session`,
  `model_switch`) invalidate provider pointers; non-terminal (`idle_ttl`,
  `budget_eviction`, `pool_compaction`, `paused_run`, `project_close`,
  `shutdown`) persist state so the next turn resumes the same provider session.
- **Unattended release:** with no client connected, the brain releases quiet
  chats after 30 s (`releaseUnattendedRuntimes`, `brainIdleMemory.ts`), keeping
  live turns, pending sends, pending input and claimed background work.
- **Cursor resume** may return a new agent id; `stageCursorSdkAgentRotationRecovery`
  stages a continuity block.
- **Close guards:** `hasActiveWorkloads()` guards close and quit;
  `hasRetainableSessions()` keeps projects with idle chats warm; a throwing probe
  keeps the project open.
- **The runtime budget** `MAX_CONCURRENT_ACTIVE_RUNTIMES` (5,
  `chatRuntimeBudget.ts`) is per process (desktop main and brain each build one)
  and evicts the globally least-recently-used releasable runtime. Never go back
  to a per-project cap. With nothing releasable it yields rather than kill a live
  turn.

### A Cursor worker that died mid-run

A worker that dies mid-run leaves the run marked active in the SDK's local
store, so later sends are refused (`Agent <id> already has active run`).
`sendExpiringDeadRun` (`cursorSdkWorker.ts`) expires it with `local.force` and
re-sends, keeping the agent and history.

### Cursor thread recycling and the first-event watchdog

A Cursor transport failure (stream reset, `ECANCELED`/`EPIPE`) poisons the
server-side agent thread while the worker lives; later sends hang silently.

- The shared quiet watchdog posts "Cursor hasn't answered" after 90 s
  (`CURSOR_SDK_FIRST_EVENT_WATCHDOG_MS`); it is advisory.
- A transport error before any event, or **Restart Cursor**, runs
  `recycleCursorSdkAgentThread`: cancel (≤ 3 s), force-evict the worker, arm a
  forced rotation to a fresh agent seeded with the transcript.
- At most one automatic re-send per user turn (`runCursorSdkTurnWithRecovery`,
  `forceExpireActiveRun`), reported once.
- **Expired access tokens** (`isCursorSdkStaleAccessTokenText`) recycle with
  `preserveAgentId: true`: a new worker resumes the same agent. A second failure
  says to sign in again.
- Queued steers survive the swap or are cancelled with a notice. The intents
  (`cursorSdkForceExpireNextSend`, `cursorSdkPendingRotationPreviousAgentId`)
  persist across restarts.

### Cursor worker orphan guard

Workers guard themselves when their brain dies without unwinding
(`cursorSdkWorkerGuards.ts`: stop sending once disconnected, ignore EPIPE,
2 s exit deadlines, poll the owner pid from `--ade-owner-pid=<pid>`).
`recoverCursorSdkWorkerOrphans` runs at brain and desktop startup and kills only
workers whose owner pid is dead (shared helpers in
`services/shared/processOrphans.ts`).

### Message delivery, turn health, and quiet diagnostics

A user message moves `accepted` → `processed`; a steer the turn never consumed
persists `unprocessed`, offering **Run next**, **Edit**, **Dismiss**
(`chat.resolveUnprocessedMessage`, durable `user_message_resolution`). Desktop
draws delivery as one small line under the bubble: Steered, Steering…, Not
steered (amber, with actions), Sent after turn, Steer failed, Couldn't send.
`user_message_reaction` (CTO emoji on a user message) and
`assistant_message_reaction` (person's emoji on a CTO reply) are keyed by
`userMessageReactionKey()` / `assistantMessageReactionKey()`.

- **Turn health:** stalls use provider-neutral `turn_health` and
  `chat.recoverTurn` (`wait`, `nudge`, `retry_same_runtime`, `restart_resume`);
  progress is recorded as `turn_recovery`.
- **The shared quiet watchdog** (`chatQuietWatchdog.ts`) covers every provider:
  2 min to first event, 10 min mid-turn (Cursor first event 90 s). Explainable
  silences (pending approval, open tool) are watched again; anything else posts
  one "<Provider> hasn't answered" card with **Restart** / **Keep waiting**. It
  never restarts or re-sends by itself; restart is the user's, sent with the
  chat's pin.
- **The stall banner:** no progress for 5 min (`TURN_STALL_AFTER_MS`,
  `shared/sessionStatusPresentation.ts`) with no open work shows "No new
  activity for 5m" with **Interrupt**. Progress is `isTurnProgressEvent`
  (`shared/turnInFlight.ts`); DAEX's own rows never count.

### When the host machine sleeps

On an announced suspend, every session with a turn in flight gets a
**Paused — computer asleep** chip, replaced on wake with **Resumed · paused 4m**
(`hostSleepChipTracker.ts`, keyed `host-sleep:<sleepId>`).
`shouldAttributeRetryToHostSuspend` holds (does not consume) a transport retry
that a sleep explains: no HTTP status, a transport-class cause, and either a
fresh `asleep` announcement or within 30 s of an announced resume
(`HOST_RESUME_RETRY_GRACE_MS`). Logged as
`agent_chat.api_retry_held_for_host_suspend`. Keeping the machine awake is
opt-in ([onboarding and settings](../onboarding-and-settings/README.md#keeping-the-machine-awake)).

Codex moderation metadata is kept but not drawn; it folds into the turn's
`turn_diagnostics` ("Turn details").

## Side chats (`/side`)

A side chat is a read-only native fork of a Work chat for a side question.
`/side <question>` (desktop, web, iOS) or `daex chat side <session> "<question>"`
opens it (`startSideChat`, `sideChatService.ts`) on the main chat's machine, in
the same lane, provider, model and account.

- Linked by `sideChatParentSessionId` / `sideChatSessionId`; not a spawned
  child (never reports or nests). One per chat.
- Only providers that fork natively (`SIDE_CHAT_PROVIDERS` in
  `shared/sideChat.ts`: handoff-fork providers minus transcript-replay ones).
  Mid-turn forks cut at the last finished turn where the provider can
  (`claudeSideChatCut`, Codex `beforeTurnId`, Muse `session/sideChat`, Pi
  `piForkCut`).
- No history is copied into its transcript; the side-chat role rides the first
  message (`buildSideChatFirstPrompt`) to keep the prompt cache.
- **Read-only, enforced** per provider (Claude `default` plus a `canUseTool`
  fence and `PreToolUse` hook, Bash only if `claudeSideChatBashIsReadOnly`;
  Codex read-only sandbox; OpenCode/Copilot `plan`; Droid `read-only`; Muse
  `denyUnmatched`; Pi `readOnly`; Kimi `plan` plus an ACP fence).
  `updateSession` refuses raising access.
- Hidden from lists unless `includeSideChats`.
- **Sending to the main chat** only when the user asks: `<send_to_main>…</send_to_main>`
  blocks are delivered at turn end (`forwardSideChatSendsToMain`).
- `endSideChat` deletes it; deleting or archiving the main chat deletes it.
- Desktop shows a **Side chat** Work tool (`side-chat`); iOS a slide-up panel.
  Every call carries the main chat's pin (`chat.startSideChat` /
  `chat.endSideChat`).

## Spawn types and completion reporting

A chat can spawn another chat. The session carries `spawnKind = "subagent" |
"peer"` with `orchestrationParentSessionId` (`SPAWN_LINEAGE_FIELD_NAMES` in
`agentChatService.ts`). `subagent` (default) reports back; `peer` is side work
the parent does not wait on. The product never says "peer": the flag is
`--no-report`, the UI says "Started by <parent>", "Stop reports to <parent>",
"Report back to <parent>".

Where it is set:

- `daex new chat --mode chat|cli [--no-report]` (`--type subagent|peer` also
  works). Both modes default the parent from `ADE_CHAT_SESSION_ID`; `--parent`
  overrides; `--no-parent` creates a top-level chat. An agent-created chat also
  records a passive `launchedBySessionId` from the RPC-stamped actor.
- `daex chat create --type subagent --provider <p> --model <m>`.
- The CTO's `spawnChat` defaults to `subagent`.

Rules:

- **Inherited permissions:** a new `subagent` chat or tracked CLI with no child
  mode inherits a full-auto parent's level, translated to its provider; explicit
  restrictions, host policies and the ceiling still apply.
- **Decisions** go to the parent in the closing summary. A child's own
  `daex chat ask` is reported with `daex chat ask --clear --session <child>`.
- `parentIdentityKey` (`"cto"`) is host-stamped on summaries.
- **Work list:** same-lane `subagent` chats and tracked CLI subagents are filed
  under their parent row; peers stay top-level. `daex chat list` stays flat. See
  [Session sidebar](../terminals-and-sessions/ui-surfaces.md#session-sidebar-sessionlistpanetsx).

### A subagent's question reaches its parent

A child blocked on a question never ends its turn, so `relayChildQuestionToParent`
wakes the parent once per item (`hostContinuation.reason: "subagent_question"`)
with the question and exact `daex chat respond <child> --item <id> …` commands
(`describePendingInputForAgent`, `shared/pendingInputCommand.ts`). Not relayed:
approvals, secrets and user-only consent cards, a peer's questions, parents
outside this service.

- For user-only cards, `relayChildAwaitingUserToParent` tells the parent the
  child waits on the user (`subagent_awaiting_user`), also across machines to
  brains advertising `externalWakeNotices`.
- When the person answers a card an agent posted (e.g. a DAEX Cloud size
  request), the agent gets one `card_answer` wake.
- A scheduled wake does not fire while a card is open. `daex chat respond`
  answers via `chat.respondToInput`.

### Type-decided completion reporting

When a spawned chat completes a turn, `reportChildSpawnEnded` acts on the
child's current `spawnKind`.

- **`subagent`:** the parent is woken through `messageSession({ kind: "wake",
  metadata: { spawnCompletion } })` (inline steer for an active Claude or Codex
  parent). `AgentChatSpawnCompletion` carries child ids, status and the bounded
  report.
- **The report is the child's final message, lines kept**
  (`boundChildReport`, `childReportText.ts`, `CHILD_REPORT_MAX_CHARS` 3,500),
  keeping the **end** of a long reply behind a "start was cut" line.
- **Durable delivery:** with the brain's router, reports go through the brain's
  outbox (`router.queueLocal`, `crossScopeChats.ts`) under
  `~/.ade/cross-machine/`, retried 30 s to 5 min for up to 24 h. One outbox
  file per brain endpoint. Restart recovery does not report a turn it is about
  to continue.
- **Batching:** for an idle parent, `createParentWakeBatcher` holds a result up
  to 15 s (`PARENT_WAKE_BATCH_HOLD_MS`) while siblings run, then wakes once.
- **`peer`:** nothing is posted; the child's card in the parent closes.
- `spawn_completed` notices fold per child (`foldSpawnCompletionLines`); a
  render-only `repeatCount` counts turns.

### A CTO parent gets one line

For a CTO parent the completion renders as one `system_notice`
(`formatCtoChildReportLine` in `ctoTurnContext.ts`: title · provider · outcome ·
PR #n). The CTO itself is woken with the line plus the bounded report
(`hostContinuation` `cto_child_report`). The wake is sent first and the notice
written after, since the notice is the dedupe anchor.

### Takeover, parents and moves

- **Takeover:** `spawnKind` is mutable. Taking over (`daex chat demote`, banner,
  menu) sets `peer` and posts `spawn_takeover`; promoting restores `subagent`.
  A human message to a subagent does not take the report channel.
- **Parent gone:** a subagent reports to the nearest live ancestor, up to the
  project's CTO (`childAncestry.ts`; deleted links in
  `.ade/cache/chat-sessions/deleted-parent-links.json`, 90 days). It is relinked
  with a `spawn_parent_relinked` notice. With nothing above, it is demoted to
  peer with one `spawn_parent_gone` notice.
- **Delivery failure:** the outbox retries for 24 h before noting it on the
  child; every completion logs `agent_chat.spawn_completion_routed`.
- **Changing the parent:** `chat.setParent` (`daex chat set-parent <session>
  --parent <chat> [--no-report]`, `--no-parent`), refusing self-parents and
  loops. An agent may move only its own chat, adopt an orphan, or release its
  own child (`actingAgentSessionId`).
- **Cross-machine moves keep the tree:** the capsule carries the parent and
  kind; the destination relinks local children of the moved chat.

#### Mission ownership decides the wake

Wake versus quiet is the child's persisted `spawnKind`, never the latest human
message (`isHumanChildMessage` in `spawnMissionOwnership.ts` only counts them).
Host-authored inputs (`scheduledWake`, `spawnCompletion`, `agentRelay`,
`hostContinuation`, `orchestrationOrigin`, `spawnDispatch`, `boardMove`) are
never human.

**Provenance is host-authored**, never accepted from a caller:
`withTrustedAgentProvenance` (RPC edge, on `chat.messageSession`,
`chat.sendMessage`, `chat.steer`) strips every key in
`HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS` and re-derives `spawnDispatch` (caller
is the persisted parent) or `agentRelay`. Positional invocation of those actions
is rejected. An `agentRelay` message reaches the model with one line naming the
sending agent and chat (`agentRelaySenderNote`, `chat/agentRelayNote.ts`);
slash commands get no note. `messageClearsAttentionMarkers(metadata)` is the one
predicate for whether a send clears attention markers. iOS mirrors the key list
in `SyncService.hostAuthoredChatMessageMetadataKeys`.

### CLI children

A `--mode cli` child is a tracked PTY with no turns, so it reports once per run
at process exit (`ptyService.onExit` → `deliverChildCompletionToParent`; rules
in `cliChildSessions.ts`): exit 0 finished, non-zero failed, closed stopped
unless it already wrote a closing message. The report is its last assistant
message (Codex rollout, Claude Code session file) or the terminal tail. Use
`--mode chat` for a subagent that must report every turn. Both child types get
`ADE_PARENT_CHAT_SESSION_ID` and `ADE_SPAWN_KIND`.

### Inline card vs. quiet pill

A spawn emits inline `subagent_started` / `subagent_result` cards, so the
`subagent_spawned` notice sets `hasInlineCard: true` and the pill is suppressed.
Stopped cards keep the host's stop source and cause.

### Navigation and lineage surfacing

Every spawn surface routes through `navigateToSpawnedChat`
(`spawnNavigation.ts`). `spawnKind` and the parent are projected onto
`TerminalSessionSummary`; the Work sidebar shows a type pill, a live-children
badge and a lineage identicon. A spawned chat's header has one back control to
the parent; its actions pane leads with the parent's roster. Takeover controls:
the composer banner (**Take over** / **Keep reporting**), the Work context menu,
the iOS long-press menu.

## IPC surface

Channel constants: `apps/desktop/src/shared/ipc.ts`; handlers:
`apps/desktop/src/main/services/ipc/registerIpc.ts`; renderer API:
`window.ade.agentChat.*` in `preload/preload.ts`. Most channels mirror a
`chat.*` runtime action. Read those files for the full list. Contracts worth
knowing:

- `ade.agentChat.getEventHistory` / `getEventHistoryPage` take one object;
  `sessionFound: false` vs `unavailable: true`; `hasOlderHistory` is
  authoritative ([transcript doc](transcript-and-turns.md#history-snapshots-scroll-back-and-misses)).
- `ade.agentChat.create` accepts `fastMode` / `fastTier`, caller-injected
  `mcpServers` and tristate `strictMcpConfig` ([Caller-injected MCP](#caller-injected-mcp)).
- `ade.agentChat.steer` returns `AgentChatSteerResult`; `cancelSteer({
  requireQueued: true })` refuses a row delivery already claimed;
  `dispatchSteer` delivers a staged row now (a refused Cursor inline dispatch
  answers `{ dispatchedAt: null }` without throwing; callers must read it).
- `ade.agentChat.interrupt` takes a stop mode; a queue-clearing mode settles
  Codex cards on every path.
- `ade.agentChat.stopTask` (one Claude task), `restoreCancelledQueue` (8 s
  undo), `recoverCodexTurn` (one guarded recovery per turn).
- `ade.agentChat.respondToInput` is the unified pending-input answer;
  `dismissPendingInput` only for `providerMetadata.dismissible: true`.
- `ade.agentChat.delete` waits for Claude cron cancellation confirmation and
  leaves the chat unchanged on a provider timeout.
- `ade.agentChat.switchAccount` / `continueUsageLimitOnAlternate` move a Claude
  or Codex chat between accounts (owner-only; refused mid-turn).
- `ade.agentChat.modelCatalog({ mode?, refreshProvider? }, pin?)` answers for the
  machine that served it; composers pass their machine's pin.
- `ade.agentChat.saveTempAttachment` (base64, 10 MB) /
  `copyTempAttachment` (local copy, 50 MB) /
  `ade.remoteRuntime.uploadChatAttachment` (streamed upload).
- `ade.agentChat.getImageDataUrl` reads only inside allowed roots (realpath
  containment).
- `ade.agentChat.getSubagentTranscript`, `listSubagents`, `getMainTranscript`
  (Claude-only provider view), `rewindFiles`, `getContextUsage` and
  `getClaudeUsage` (Claude `/usage` via `get_usage`).
- `ade.agentChat.event` (push) is the envelope stream.
- Provider connections live on `ade.ai.*` (OpenCode OAuth and keys, Pi login,
  Cursor Cloud fleet); cloud agents on `ade.cloudAgents.*`.

### Handoff and fork

`ade.agentChat.handoff`: `mode: "brief"` sends a compact hidden first message
and may target another lane; `mode: "fork"` needs the same provider and keeps
the lane; `handoffNote` rides the brief or becomes a fork's first turn.

| Provider | Fork |
|---|---|
| Claude | SDK session pointer |
| Codex | `thread/fork` in a short-lived private app-server (`codexEphemeralFork.ts`); goals cleared |
| OpenCode | `session.fork` |
| Droid | SDK `session.fork()`, then reopen the source branch |
| Copilot | SDK session fork ([Copilot doc](copilot-sdk-provider.md#fork-and-rewind)) |
| Pi | Worker `fork` (`createBranchedSession`) |
| Cursor | No provider fork: the new agent gets the source transcript replayed (`buildFittedTranscriptReplay`) |

Cross-machine fork transports native history for Claude, Codex and OpenCode;
Cursor and Droid cross-machine handoffs are brief-only.

## Async questions and provider dialogs

### Async questions (a card you may ignore)

| Provider | Async questions | Reply channel | Dismissible |
|---|---|---|---|
| Codex | Yes (`agentMessage` `delivery: "async"`, 0.156+) | An ordinary user message (`responseMode: "message"`) | Yes (local) |
| Claude | No (`AskUserQuestion` blocks) | `canUseTool` result | No |
| Cursor, OpenCode, Droid, Pi, Copilot, Muse, ACP | No | — | No |

Dismissing writes `pending_input_resolved` (`cancelled`) plus "Question
dismissed".

### Claude dialog kinds (capability gate)

The SDK can ask the host to render dialogs (`onUserDialog` +
`supportedDialogKinds`). Declaring a kind DAEX cannot draw would park an
unanswerable dialog, so the list is a capability claim.

| Dialog kind | Declared | Decision |
|---|---|---|
| `resume_return` | Yes | Blocking card: Compact and continue / Keep full history / Don't ask again (`claudeResumeReturnDismissed` stops declaring it on this machine). |
| `refusal_fallback_prompt` | No | The refusal ends the turn; a mid-turn model switch would misattribute the turn. |
| anything else | No | Answers `{ behavior: "cancelled" }`. |

Lightweight and embedder-owned personal chats declare none.

### Claude MCP elicitations

`buildClaudeElicitationHandler` raises the same card Codex and Copilot raise
(form → `structured_question`, URL → **Open authorization**), parked on
`runtime.approvals` so every turn end settles it. In full-auto chats and
automation runs DAEX answers itself (empty or fully defaulted forms accepted,
everything else declined) with a notice; elsewhere the card waits 5 min
(`CLAUDE_MCP_ELICITATION_TIMEOUT_MS`) then cancels. No **Always allow**.

### Refusal fallback follows the model

When Claude Code retries a refused turn on its fallback model with session scope
(`system/model_refusal_fallback`), DAEX writes the fallback model to the session
(`followClaudeRefusalFallbackModel`) and emits `session_meta_updated`.
`scope: "local"` changes nothing; presets and stored credentials keep their
model.

### Title refinement

After the first completed run DAEX re-asks for a title once with the run's output
(`maybeAutoTitleSession({ mode: "refine" })`), only for a title DAEX wrote in
this process. Forks carry their source's context into the first title prompt.

## Provider accounts

Claude and Codex keep a signed-in identity in one config directory
(`CLAUDE_CONFIG_DIR`, `CODEX_HOME`). A DAEX **provider account** ("instance") is
that directory plus a label; a per-launch env carries the variable (`HOME` is
never changed). Other providers have one identity per machine.

- Registry: machine-local `provider-instances.json` under the DAEX home; new
  accounts get `<ADE home>/provider-homes/<provider>/<instanceId>/`. The default
  account is synthesized from the machine's existing login.
- **A chat's account is pinned to the chat** (`instanceId`). New chats record
  their launch account; older chats are tied once by
  `findInstanceHoldingThread`. Forks run as the source's account.
- A new launch can name its account (composer `⋯` → Account; `daex chat create
  --instance <id>`).
- **Switching a chat's account** (`chat.switchAccount`, `daex chat
  switch-account`) copies the thread file to the other home
  (`moveChatToAccount`); refused mid-turn and for saved keys or custom providers.
- A Claude resume never quietly starts blank: a missing thread is copied from
  the account with the newest copy (`ensureClaudeThreadInSessionHome`), else
  continuity recovery.
- **Injection happens once, in `buildAgentRuntimeEnv`.**
- A removed account falls back to the default and forgets the thread pointer.
  Removing an account deletes nothing on disk.
- CLI: `daex providers accounts list|add|remove|rename|default`.

## Harness presets

A **harness preset** pairs a harness with a source of intelligence (account,
stored key, or a Claude/Codex subscription through DAEX's proxy) plus model,
effort and subagent pins. No permission mode. Full doc:
[harness presets](../onboarding-and-settings/harness-presets.md).

- `presetId` (or `credentialId`) travels on create args, session, summary and
  CLI launch metadata; the lane's runtime resolves it
  (`harnessPresetLaunch.ts`). No key crosses IPC or sync.
- Injection happens in `buildAgentRuntimeEnv`, on top of the account patch.
- Unsupported is a value (`{ unsupported: "<reason>" }`): the chat runs on the
  harness's own sign-in with a notice.
- Create with only `presetId` records the preset's harness and model.

### Capability gate

| Harness | Key source | Subscription source | Preset in CLI mode | Subagent model |
|---|---|---|---|---|
| Claude Code | Yes | Yes | Yes | Yes |
| Codex CLI | Yes | Yes | Yes | No |
| OpenCode | Yes (needs an endpoint) | Yes | Yes | No |
| Droid | Yes | Yes (proxy) | Yes | No |
| Qwen Code | Yes | Yes (proxy) | Yes | No |
| Kimi | Yes | Yes (proxy) | Yes | No |
| Grok | Yes | Yes (proxy) | Yes | Yes |
| GitHub Copilot | Yes | Yes (proxy) | Yes | No |
| Pi | Yes | Yes (proxy) | Yes | No |
| Cursor | No | No | **No** | No |

Harnesses are `HARNESS_PRESET_BODIES` (`shared/harnessPresets.ts`); Muse, Devin and Antigravity are not among them. The CLI-mode gate is
`CLI_PRESET_GATED_HARNESSES` in `shared/harnessPresetCliGate.ts`.

## Configuration

Chat config keys (project config service; read `AiConfig` in
`shared/types/config.ts`):

| Key | Meaning |
|---|---|
| `ai.permissions.providers.*` | Per-provider permission defaults (the only source `resolveChatConfig` reads). |
| `ai.customProviders`, `ai.customModelSlugs` | Custom OpenAI/Anthropic-compatible providers and extra model slugs (both in `coerceAiConfig` and `mergeAiConfig`). |
| `ai.chat.piExtensionsEnabled` | Load Pi extensions in chat (default true). |
| `ai.chat.claudePluginUiEnabled` | Draw Claude mod UI (default false). |
| `ai.chat.codexPromptSuggestionsEnabled` / `ai.chat.promptSuggestionsEnabled` | Next-prompt suggestions (Codex default true; others default false). |
| `ai.chat.smartDecisionsEnabled` | Jev master switch (default true); groups `smartChatStatusEnabled`, `smartSettleNudgeEnabled`, `modelHintMode`, `smartPaletteEnabled`, `smartLaneEmojiEnabled` (`jevEnabled` in `shared/jevSettings.ts`). |
| `ai.chat.jevZenCreditEnabled` | Pay Jev from the user's OpenCode Zen balance after the free allowance (default false). |
| `ai.chat.scheduledWorkPaused` | Pause all scheduled work. |

### Jev decisions

`main/services/jev/jevService.ts` asks the Jev decision model typed questions
(`noul`, `choice`, `score`; `shared/types/jev.ts`). `decide(…)` answers every
question or returns `null` ("use your existing logic") on any failure; it never
throws or shows an error.

- **Routes** (`JEV_ROUTES`, one time budget): `free` (OpenCode's
  `jev-1.13-free`, per-network daily allowance), `zen_credit` (the user's Zen
  balance, only when enabled and signed in), `bonus` (the account server's
  `POST /jev/systemone`; the Worker holds the partner key and caps per account
  and fleet).
- **Resilience:** 1.5 s interactive / 4 s background timeouts; per-route
  breakers; ≤ 4 calls in flight; a 10-minute cache.
- `ai.jevDecide` / `ai.jevStatus` are remote read actions, called with the
  machine's pin. `feature` is the closed union `JEV_FEATURES`.

### Next prompt suggestions

After a turn the empty prompt box shows a one-line guess (Tab fills, Esc hides).
Claude Code sends its own (`promptSuggestions`); DAEX never adds one for Claude.
Others get one from `chat/nextPromptSuggestion.ts` (one cheap call after a
clean turn, ≤ 120 chars). Codex falls back to `thread/sample`
(`codexThreadSample.ts`, 0.164+). Both are live-only `prompt_suggestion` events.

## Related docs

- [Cross-machine session handoff](../sync-and-multi-device/cross-machine-session-handoff.md)
- [Personal chats](../personal-chats/README.md)
- [DAEX SDK](../sdk/README.md) (`@daex-dev/sdk`, `@daex-dev/chat-ui`)
- [Agents](../agents/README.md), [CTO](../cto/README.md)
- [Terminals and sessions](../terminals-and-sessions/README.md)
- [Search](../search/README.md): chat transcripts are FTS-indexed per message.
