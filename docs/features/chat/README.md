# Chat

Agent Chat is the interactive AI coding surface inside ADE. Each chat binds a
lane (git worktree + branch), a provider runtime (Claude, Codex, OpenCode,
Cursor), and a transcript into a persistent `AgentChatSession`. The user talks
to the agent the same way they would use any IDE copilot, but with ADE's
lane/session tracking, tool approval flow, identity continuity, and handoff
machinery layered on top.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Main service: session lifecycle, turn dispatch, event emission, provider adapters, steer queue, handoff, auto-title, prompt-derived lane-name suggestions for auto-created / parallel lanes, event-history snapshots, slash-command discovery/merge (delegates to per-provider discovery modules and `slashCommandPromptExpansion` for unified prompt expansion), and active-workload detection used by project/window close guards. Lane naming runs through the session-intelligence prompt path, retries the requested/configured/default title models, then falls back to a prompt slug with an optional temporary suffix for uniqueness. Tracks Fast Mode with the legacy `codexFastMode: boolean` session field for every provider whose descriptor advertises `serviceTiers: ["fast"]`; Codex forwards it as `serviceTier: "fast" \| null` on every `thread/start` and `turn/start` JSON-RPC call, while Cursor SDK sessions resolve it through discovered model parameters (see [Agent Routing](agent-routing.md#provider-service-tiers-fast-mode)). Codex chat goals are managed through the app-server `thread/goal/get` / `set` / `clear` RPCs, persisted in session summaries, validated to the provider's 4,000-character objective limit, and normalized to ADE's unlimited-budget policy by sending `tokenBudget: null` and clearing provider-reported budgets. `applyCodexEffectiveThreadState` accepts a `requestedCodexPolicy` option and uses `shouldPreserveRequestedCodexPolicy` to keep ADE-controlled picker selections authoritative when the lifecycle response echoes an older thread policy (prevents a manual Plan→Edit switch from snapping back); it also syncs the abstract `permissionMode` via `syncLegacyPermissionMode` after every policy application. Builds ADE guidance from the active lane worktree so Agent Skill roots are lane-scoped in persistent system/developer prompts and provider fallback injection. Spawns Claude/Codex agent runtimes with `buildAgentRuntimeEnv(managed)` so every agent process inherits `ADE_CHAT_SESSION_ID`, `ADE_LANE_ID`, `ADE_PROJECT_ROOT`, and `ADE_WORKSPACE_ROOT` (used by the agent guidance to call `ade --socket app-control logs` / `terminal read --chat-session "$ADE_CHAT_SESSION_ID"` without resolving the chat ID itself). When the session has Linear issues attached (`session_linear_issues`), `buildAgentRuntimeEnv` also materializes them into a per-session context file via `writeSessionLinearIssueContextFile` (`<contextDir>/<sessionId>/linear-issues.json`, written atomically; stale files cleared when nothing is attached) and sets `ADE_LINEAR_ISSUE_IDS` (comma-joined identifiers) + `ADE_LINEAR_CONTEXT_FILE` so the agent reads its issue context without Linear credentials. Attaching a `linear_issue` context attachment at run time calls `laneService.attachLinearIssueToSession({ chatSessionId, issues, role: "worked", source: "chat_attach", includeInPr: true })` so the link is persisted even for standalone (laneless) chats; when the session has a lane it additionally runs `laneService.linkLinearIssues` for the lane/PR-card semantics. See [Linear integration](../linear-integration/README.md#session-scoped-issue-attachment-and-cli-context-injection). Claude SDK sessions also resolve the executable through `claudeCodeExecutable.ts` and pass `pathToClaudeCodeExecutable` so packaged builds can prefer the bundled native binary before PATH/auth fallbacks; interrupted Claude turns call `stopTask` for active subagents before emitting stopped subagent results. Claude resume paths run `claudeThinkingTranscriptRepair` before loading a transcript, and the runtime self-heals the same corruption after the Anthropic thinking-block 400 error. Full-auto plan acceptance emits the same plan-mode exit notice as the manual approval path so the renderer composer chip can update even when the session refresh races with compaction. Cursor SDK setup records interrupts that arrive while the worker is still being acquired, releases the acquired generation if setup loses the race, and suppresses false provider-health failures for user-initiated setup interrupts. Cursor provider slash commands use a dedicated discovery path (`cursorSlashCommandDiscovery`) instead of falling through to the generic filesystem-backed list. Large service file. |
| `apps/desktop/src/main/services/chat/runtimeEvents.ts` | Canonical cross-runtime event vocabulary (`turn.*`, `content.delta`, `tool.*`, `subagent.*`, teammate/task events, compaction boundaries) plus shims between legacy `AgentChatEvent` rows and the canonical runtime envelope. Claude emits canonical subagent events alongside the legacy rows while the other adapters migrate. |
| `apps/ade-cli/src/tuiClient/` | Terminal **Work** chat TUI (Ink + React): same action/RPC contracts as desktop, **attached** (socket) or **embedded** (headless runtime via `ade-cli`). See [ADE Code](../ade-code/README.md). |
| `apps/desktop/src/main/services/builtInBrowser/builtInBrowserService.ts` | Main-process broker for the in-app web browser. Owns persistent project-profile partitions derived from the active project root (fallback `persist:ade-browser`) and one window/project browser service per ADE `BrowserWindow`, so each project keeps isolated cookies/storage while its tabs share that project's authenticated browser profile. Each window service manages multiple `WebContentsView` tabs (cap 10), active tab, per-tab lane/chat owner and lease metadata, lightweight browser agent sessions, bounds, visibility, inspect state, targeted status events, screenshot capture, scratch browser-agent observations, diagnostics, per-tab action traces, and emission of `BuiltInBrowserContextItem`s for selected page elements. Observe/click/type/key/scroll/fill/clear/wait/screenshot/select/reload/back/forward/stop can target a hidden or non-active tab by `tabId` or `sessionId`; inspect mode remains a visible-tab interaction. Sessions bind an agent workflow to one tab, remember owner plus last observation/trace ids, and have `ade browser session <action> <id>` CLI aliases. Scratch observations live under `.ade/cache/browser-observations/`, include a bounded DOM element list plus console/network diagnostics by default, can render a numbered element-map screenshot with `includeElementMap`, and prune to the latest 3 observations per tab by default; click/fill/clear/press/wait can target viewport coordinates or resolve `selector`/`text`/`testId`/`elementIndex`/saved observation `handle` before dispatching CDP input. Waits wake from browser/network/page events with a timeout fallback, and `network-idle` requires complete ready state, no pending browser requests, and a configurable idle window. Handles preserve same-origin iframe/open-shadow-root context when available, and tab traces record action target metadata, duration, before/after URL, session id, observation id, and errors without storing typed fill/type text. `ade browser proof` promotes a fresh scratch observation to durable proof through the proof broker. Window-open requests from a page are handled via `setWindowOpenHandler` returning `action: "allow"` + a `createWindow` factory: a new internal tab is created and its `webContents` is returned to Chromium so the popup keeps its real `window.opener` relationship with the opener tab (important for OAuth flows that postMessage back to the parent). Navigation normalization/protocol policy lives in `builtInBrowserNavigation.ts`; Google sign-in permission policy lives in `builtInBrowserPermissions.ts`. Backs the `ade.builtInBrowser.*` IPC surface and is consumed by both `ChatBuiltInBrowserPanel` (sidebar Browser tab) and `openExternal.ts` (links inside the renderer route through the built-in browser when the protocol is `http`/`https`/`about:blank`). |
| `apps/desktop/src/shared/types/builtInBrowser.ts` | Cross-process types for the built-in browser: `BuiltInBrowserStatus`, `BuiltInBrowserTab` (including per-tab owner/lease metadata), `BuiltInBrowserSession`, `BuiltInBrowserContextItem` (`kind: "built_in_browser_element" | "built_in_browser_capture"`), `BuiltInBrowserSelectResult`, `BuiltInBrowserScreenshot`, `BuiltInBrowserObservation` / `BuiltInBrowserDomSnapshot` / `BuiltInBrowserObservationElementMap`, browser diagnostics/action trace DTOs, agent action args for click/type/key/scroll/fill/clear/wait, `BuiltInBrowserOpenPanelArgs`, and the `BuiltInBrowserEventPayload` union (`status`, `open-request`, `selection`, `selection-cleared`, `error`). Navigate / create-tab / switch-tab args carry an optional `openPanel: boolean` so callers can ask for the Work sidebar Browser tab to flip open atomically with the navigation. |
| `apps/desktop/src/main/services/chat/buildClaudeV2Message.ts` | Builds Claude SDK user messages for the `query()` input stream. Handles base64 image content blocks and MIME inference. |
| `apps/desktop/src/main/services/chat/claudeInputPump.ts` | Async iterable input pump that feeds live user turns into the Claude Agent SDK `query()` stream. |
| `apps/desktop/src/main/services/chat/claudeThinkingTranscriptRepair.ts` | Best-effort repair for Claude SDK JSONL transcripts where multiple distinct assistant responses reused one `message.id`. The repair preserves top-level threading, tool ids, thinking content, and signatures, but rekeys later responses before resume so Anthropic thinking blocks remain in the message shape originally generated by the model. |
| `apps/desktop/src/main/services/chat/claudeSubprocessReaper.ts` | Tracks Claude SDK subprocesses and tears them down on runtime shutdown. |
| `apps/desktop/src/main/services/chat/claudeOutputStyles.ts` | Discovers Claude output styles and plugins from project/user roots. Project roots are walked directly, while user-installed marketplace plugins are loaded only from Claude's installed-plugin registry when enabled in settings, so cache/source copies do not leak into ADE sessions. |
| `apps/desktop/src/main/services/chat/markdownSlashCommandDiscovery.ts` | Shared markdown-based slash command discovery engine. Provides frontmatter parsing, filesystem walking, command/agent/skill file discovery, command resolution, prompt expansion (`$ARGUMENTS` substitution), ancestor config root traversal, and deduplication helpers. Consumed by the provider-specific discovery modules (`claudeSlashCommandDiscovery`, `codexSlashCommandDiscovery`, `cursorSlashCommandDiscovery`). |
| `apps/desktop/src/main/services/chat/claudeSlashCommandDiscovery.ts` | Discovers Claude-compatible command files plus Agent Skill entries. Delegates to `markdownSlashCommandDiscovery` for filesystem walking and markdown parsing. Command discovery walks ancestor and home `.claude/commands/**/*.md`; skill discovery uses `getAgentSkillRootCandidates()` so `.claude/skills`, `.agents/skills`, `.ade/skills`, `.cursor/skills`, `.codex/skills`, inherited env roots, and bundled ADE resources can surface `*/SKILL.md` command metadata. Consumed by `agentChatService` to enrich `chat.slashCommands` and provider prompt context with local command/skill metadata. |
| `apps/desktop/src/main/services/chat/cursorSlashCommandDiscovery.ts` | Discovers Cursor-compatible slash commands from `.cursor/commands/**/*.md`, `.cursor/agents/**/*.md`, built-in Cursor subagents (`/explore`, `/bash`, `/browser`), and Agent Skill roots. Delegates to `markdownSlashCommandDiscovery` for filesystem walking. Consumed by `agentChatService` for the Cursor provider's `chat.slashCommands` list and by `slashCommandPromptExpansion` for Cursor prompt expansion. |
| `apps/desktop/src/main/services/chat/projectSlashCommandDiscovery.ts` | Unified project-wide slash command discovery. Merges commands from Claude, Codex, and Cursor discovery modules into a single deduplicated list, filtering `/login`. Used by the ADE Code TUI's `discoverProjectSlashCommands` so all providers see the same cross-provider command catalog. |
| `apps/desktop/src/main/services/chat/slashCommandPromptExpansion.ts` | Provider-routed slash command prompt expansion. Given a provider, cwd, and slash command input, resolves the command's markdown body into prompt text through the appropriate provider-specific resolution path (Claude, Codex, or Cursor). Built-in and runtime-registered commands are skipped so the SDK handles them natively. Consumed by `agentChatService` to expand slash commands before dispatch. |
| `apps/desktop/src/main/services/chat/chatTextBatching.ts` | Batches streaming assistant text fragments (100 ms) before emission to reduce renderer re-renders. |
| `apps/desktop/src/main/services/chat/sessionRecovery.ts` | Version-2 persisted-state reconstruction when sessions resume from disk. |
| `apps/desktop/src/main/services/chat/cursorSdkPool.ts` | Cursor SDK adapter: spawns and pools `cursorSdkWorker.ts` Node workers per session, sends turns, brokers permission/hook callbacks, maps SDK events to chat events, and handles teardown. The connection envelope now carries `modelParams` (a list of `CursorSdkModelParameterValue`s — e.g. `{ id: "reasoning", value: "high" }`) so per-model variant parameters discovered through `cursorModelsDiscovery` flow into the SDK boot. |
| `apps/desktop/src/main/services/chat/cursorSdkWorker.ts` | Node worker that hosts the official `@cursor/sdk` and bridges it to the main process via the JSON line protocol in `cursorSdkProtocol.ts`. |
| `apps/desktop/src/main/services/chat/cursorSdkProtocol.ts` | Shared types for the worker IPC: chat mode, approval policy, sandbox mode, hook decisions, hook requests, `CursorSdkModelParameterValue`, and `CursorSdkWorkerInit` boot envelope. |
| `apps/desktop/src/main/services/chat/cursorSdkPolicy.ts` | Maps ADE permission modes onto Cursor SDK chat mode + approval policy + sandbox mode (`ade` / `cursor-native` / `off`); decides which tool calls auto-approve and which require a user prompt. |
| `apps/desktop/src/main/services/chat/cursorSdkSystemPrompt.ts` | Builds the system prompt the Cursor worker injects (lane context, ADE CLI guidance, persona overlays). |
| `apps/desktop/src/main/services/chat/cursorSdkEventMapper.ts` | Translates `@cursor/sdk` stream events into the ADE `AgentChatEventEnvelope` shape consumed by the renderer. |
| `apps/desktop/src/main/services/chat/cursorModelsDiscovery.ts` | Probes the live `@cursor/sdk` and `cursor-agent` CLI model lists, merges their descriptors, and records `cursorAvailability` so chat sessions see SDK-capable models while Work CLI launches can include CLI-only models. Both JSON and text probes preserve aliases, descriptions, `parameters[]`, and `variants[]`; `*-fast` CLI rows are folded into their base model as `aliases` + `serviceTiers: ["fast"]` so the picker shows one model with a Fast toggle instead of duplicate "Fast" rows. Parameter and variant metadata is classified into `reasoningTiers` (`none`/`dynamic`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`/`thinking`) and `serviceTiers` (`fast`). `resolveCursorSdkModelSelectionParams` rebuilds the matching `CursorSdkModelParameterValue[]` so the SDK boot can target the right variant. The previous minimal `auto` / `composer-2` fallback list has been removed. |
| `apps/desktop/src/main/services/chat/droidSdkPool.ts` | Droid SDK adapter. Forks `droidSdkWorker.cjs` per session, exposes `acquireDroidSdkConnection` / `releaseDroidSdkConnection`, and proxies prompt sends, settings updates, permission decisions, ask-user responses, and cancellation through the worker. Resolves the Droid SDK CLI executable via `resolveDroidExecutable` (PATH + bundle + configured install paths). |
| `apps/desktop/src/main/services/chat/droidSdkWorker.ts` | Node worker that hosts `@factory/droid-sdk`. Streams SDK events back to the main process and forwards permission / ask-user prompts back through the JSON-line protocol. |
| `apps/desktop/src/main/services/chat/droidSdkProtocol.ts` | Worker IPC types: `DroidSdkSessionSettings` (autonomy level, interaction mode, reasoning effort), `DroidSdkReasoningEffort`, `DroidSdkPermissionRequest`/`Decision`, `DroidSdkAskUserRequest`/`Response`, `DroidSdkReady` (handshake with `availableModels`), and `DroidSdkSendPrompt`. |
| `apps/desktop/src/main/services/chat/droidSdkEventMapper.ts` | Per-session `DroidSdkEventMapperState` + `mapDroidSdkMessageToChatEvents` / `mapDroidSdkRunResultToDoneEvent`. Tracks streaming text/thinking item ids, maps tool calls and results, and surfaces token usage. Replaces the deleted `droidAcpPool.ts` + `droidAcpEventMapper` path. |
| `apps/desktop/src/main/services/chat/droidModelsDiscovery.ts` | SDK-driven model probe (`listDroidModelsFromSdk`) plus the `~/.factory/config.json` custom-proxy merge. Exposes `discoverDroidSdkModelDescriptors` (alias for the legacy `discoverDroidCliModelDescriptors` while callers migrate). |
| `apps/desktop/src/main/services/opencode/openCodeBinaryManager.ts` | Resolves the OpenCode CLI: PATH first, then the bundled `node_modules/.bin/opencode`. Cache entries are re-validated with `canRunBinaryCandidate` on every lookup so user installs after launch are picked up; missing-binary lookups are intentionally not cached. `clearOpenCodeBinaryCache()` is wired into the AI integration's full cache reset. |
| `apps/desktop/src/main/services/opencode/openCodeInventory.ts` | OpenCode provider/model probe. Now classifies model variants into `reasoningTiers` + `serviceTiers` (alias map covering `minimal`/`mini`/`med`/`xhigh`/`extra-high`), reads `capabilities` (tools/vision/reasoning) into descriptor capabilities, and tracks both `modelIds` (connected providers only) and `catalogModelIds` (the full browseable catalog). `OpenCodeProviderInfo.availableModelCount` exposes the connected count separately from `modelCount`. |
| `apps/desktop/src/shared/chatTranscript.ts` | Pure JSON-lines parser for `AgentChatEventEnvelope` values. Used by both the main process and the renderer. |
| `apps/desktop/src/shared/chatSubagents.ts` | Cross-target subagent helpers: `buildSubagentPaneRows`, `selectedSubagentSnapshot`, `subagentIndexForPaneLine`, `subagentPaneSelectableLineOffsets`, `buildSubagentTranscriptEvents`, `isLifecycleEventForSnapshot`, plus the `latestPlan` derivation. Both the desktop `ChatSubagentsPanel` and the `apps/ade-cli/src/tuiClient/subagentPane.ts` / `chatInfo.ts` modules re-export from here so the desktop pane and the terminal TUI render the same roster, transcript filter, and plan summary. |
| `apps/desktop/src/shared/types/chat.ts` | All chat types: `AgentChatSession`, `AgentChatEvent` union, `AgentChatEventHistorySnapshot` (with optional `sessionFound` for stale-session detection), Codex goal/token-usage DTOs, typed Codex goal control args, permission modes, pending input, completion reports, `PARALLEL_CHAT_MAX_ATTACHMENTS`, and parallel launch state DTOs. `AgentChatSessionSummary.linearIssueLinks?: SessionLinearIssueLink[]` carries the Linear issues attached to the session (chat or CLI), populated from `session_linear_issues` independent of any lane link. |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` | Top-level renderer surface: state derivation, IPC wiring, composer mount, message-list mount, End/Delete chat controls in the header, parallel multi-model lane launch orchestration, transient-lane cleanup, and multi-lane deep-link navigation. Mounts `AgentQuestionModal` when the active pending input is a question/structured-question. Resolves the surface accent colour through `providerChatAccent(provider)` so Claude/Codex/Cursor stay visually consistent regardless of model variant. Visible Work grid tiles flush user/lifecycle/live events immediately and poll-recover active transcripts when IPC misses an event, even when the tile is not focused. Event-history snapshots with `sessionFound: false` clear stale locked-pane state instead of rendering a dead transcript. Draft chats scope their last-launch config by project/lane/surface/draft-kind and mark local model/reasoning/permission edits as touched so late lane-session hydration cannot overwrite the user's draft selection; composer text is also keyed by the real session id or the lane draft key (`draft:<laneId>`) so switching draft lanes does not leak text through a shared null session key. During project transitions the pane blocks send/model/permission mutations and shows a "Project is switching..." composer placeholder so chat calls do not hit the wrong runtime binding. On macOS, polls `ade.iosSimulator.getStatus` and renders the iOS Simulator drawer toggle in the header when the platform is supported (see [iOS Simulator feature](../ios-simulator/README.md)); selecting elements inside the drawer flows back through the pane as `IosElementContextItem` chips on the composer. Polls `ade.appControl.getStatus` and exposes the App Control drawer toggle when the platform is supported, mounting `ChatAppControlPanel`; selections become `AppControlContextItem` chips + attachments on the composer. See [App Control](../computer-use/app-control.md). When mounted as a Work tile (`SessionSurface` passes `hideLaneToolDrawers={true}`) the iOS, App Control, and chat terminal drawer toggles are suppressed because the Work right-edge sidebar owns those lane-scoped drawers; hidden lane-tool mode also skips App Control status polling and terminal listing. The pane still listens on `ade:agent-chat:add-attachment` / `add-ios-context` / `add-app-control-context` / `add-builtin-browser-context` / `insert-draft` window events so selections from the sidebar flow into the active chat composer; event handlers match on either `sessionId` (for active sessions) or `draftTargetId` (for unsaved draft composers when `draftContextTargetId` is set), enabling the Work sidebar to insert context into a draft composer before a chat session exists. Work-tab CLI launches pass the active lane worktree into the shared launcher so the spawned CLI sees lane-aware Agent Skill roots. Work CLI launches intentionally skip the direct-argv path: the pane drops `command` / `args` from the `onLaunchPtySession` payload and always sends `startupCommand` plus `workCliStartupDelayMs = 180` so the spawned shell can finish drawing its prompt before the CLI invocation is typed in (see [pty-and-processes.md](../terminals-and-sessions/pty-and-processes.md#create-flow-createargs) for how `ptyService.create` consumes the delay). The `onLaunchCliSession` prop is typed as `(args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>` and passes `disposition` matching the draft launch mode so background CLI launches do not steal focus. Internal draft launch state is structured through `DraftLaunchMode`, `DraftLaunchKind`, `DraftLaunchLaneTarget`, `StartedDraftLaunch`, and `DraftLaunchJob`. Each draft launch creates a `DraftLaunchJob` that tracks multi-step progress through a state machine (`naming-lane` -> `creating-lane` -> `starting-session` -> `sending-prompt` -> `ready` | `failed`) and stores it in `appStore.draftLaunchJobsByScope` keyed by project, lane, surface profile, and Work draft kind so loading/error strips survive pane remounts without leaking into another lane pane. The composer is cleared optimistically when the job starts rather than after it finishes; active jobs remain visible while terminal rows are pruned by scope. The pane renders status strips with Open/Restore for ready/failed jobs, Dismiss for terminal jobs, and a hide-status escape hatch for stale active jobs. Failed jobs offer a Restore button that merges the snapshot back into the composer (merging attachments and context items by identity rather than replacing). `clearDraftLaunchComposer` resets the draft, attachments, and context items after a successful launch. `DraftLaunchJob` carries `draftKind` so the dismissible job strip's "Open" action restores the correct Work draft kind (chat vs. CLI). Proof remains chat-scoped and stays on the chat header. |
| `apps/desktop/src/renderer/lib/draftLaunchJobs.ts` | Shared renderer helper for Work draft-launch job DTOs and pruning. Owns `NativeControlState`, `DraftLaunchSnapshot`, `PreparedDraftLaunch`, `DraftLaunchJobStatus`, `DraftLaunchJob`, `isDraftLaunchJobTerminal`, `isDraftLaunchJobStale`, and `pruneDraftLaunchJobs`; active jobs are kept ahead of terminal rows, with terminal rows filling the remaining retained slots and at least one terminal row retained alongside active jobs. |
| `apps/desktop/src/renderer/state/appStore.ts` | Shared renderer state store. Besides project/lane/work selection, it persists user preferences such as `launchPromptClipboardEnabled` and `launchPromptClipboardNoticeEnabled`, mirrors them into per-project stores, and owns `draftLaunchJobsByScope` for Work draft launch status strips. |
| `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx` | Virtualized transcript renderer. Coalesces resize / measurement updates and, while sticky-to-bottom is active, follows height changes across multiple animation frames so streamed output and late row measurements do not leave the user above the newest message. Programmatic scroll writes are tracked by target scroll position, not a stale counter, so browser-coalesced scroll events do not swallow the next real user gesture. Codex goal lifecycle events render as compact user-facing rows (`Goal set`, `Goal paused`, `Goal cleared`) instead of raw JSON-RPC/status wording. |
| `apps/desktop/src/renderer/components/chat/ChatGitToolbar.tsx` | Git / PR quick-action toolbar above the composer. If the lane already has a linked PR, the PR button opens that PR; otherwise it routes to the PR workspace with a create-PR handoff (`create=1&sourceLaneId=<lane>&target=primary`). |
| `apps/desktop/src/renderer/lib/visualContextFormatting.ts` | Serializes iOS, App Control, built-in browser, macOS VM, and attachment context into prompt text. Automatic macOS VM capability context is prompt-intent gated (`ADE VM`, `macOS VM`, Lume, isolated macOS GUI, etc.) so ordinary sends do not query or inject VM state. |
| `apps/desktop/src/renderer/components/chat/RewindFilesConfirmDialog.tsx`, `rewindFilesPreview.ts` | Claude file-rewind confirmation surface. `rewindFilesPreview.ts` maps the selected user message to turn diff summaries and per-file SHA ranges; the dialog lists every restored file, expands rows into `AdeDiffViewer`, and confirms the SDK `rewindFiles` call without using browser-native confirm UI. |
| `apps/desktop/src/renderer/components/chat/ChatSubagentsPanel.tsx`, `codex/CodexGoalCard.tsx` | Subagent drawer content plus the Codex chat goal card. The goal card sits above the plan/subagent roster, exposes edit/clear affordances through typed ADE goal APIs, and shows usage context as tokens/time only; provider token budgets are hidden and cleared so ADE goals stay unlimited. |
| `apps/desktop/src/renderer/components/chat/ChatBuiltInBrowserPanel.tsx` | Renderer panel for the in-app browser. Renders the address bar, tabs strip, navigation controls, an inspect/select toolbar, and a `BuiltInBrowserStatus`-derived empty/error state, then asks the main process to position the underlying `WebContentsView` over the panel's bounding rect through `ade.builtInBrowser.setBounds`. Mounted by `WorkSidebar` under the `browser` tab and (indirectly) by any renderer code that calls `openUrlInAdeBrowser()` — the helper opens the sidebar Browser tab and dispatches the URL into a fresh tab. Selections committed through inspect-mode hit-testing fan out via the `onAddContext` callback as `BuiltInBrowserContextItem` payloads. |
| `apps/desktop/src/renderer/components/work/WorkSurfaceHeader.tsx` | Shared Work surface header chrome for chat and CLI surfaces: title, lane chip, Claude cache badge, git toolbar, and caller-provided trailing actions. |
| `apps/desktop/src/renderer/lib/openExternal.ts` | Renderer-side router for outbound URLs. Defines the `ADE_OPEN_BUILT_IN_BROWSER_EVENT` window event plus `openUrlInAdeBrowser(url)` and `openExternalUrl(url)`. `openUrlInAdeBrowser` dispatches the event (so any open `WorkSidebar` can flip to its Browser tab), then calls `window.ade.builtInBrowser.navigate({ url, newTab: true })`. Anything that is not a normal `http`/`https`/`about:blank` URL falls through to `window.ade.app.openExternal` (system browser). All in-renderer URL clicks (markdown links, lane-runtime open buttons, etc.) go through this helper so the user stays inside ADE. |
| `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx` | Composer UI: single-session prompt entry, attachments, model/permission controls, slash commands, pending input answering, and parallel launch slot configuration. Pasted/dropped image attachments show pending thumbnails while temp files save, and native Electron clipboard images use `ade.app.saveClipboardImageAttachment` before falling back to `ade.agentChat.saveTempAttachment`. The launch-prompt clipboard helper is gated separately from prompt copying: `launchPromptClipboardEnabled` controls copying and `launchPromptClipboardNoticeEnabled` controls whether composer reminder text is shown. |
| `apps/desktop/src/renderer/components/chat/ChatCursorCloudPanel.tsx` | Side panel for Cursor Cloud (background agents): lists existing cloud agents and runs for the lane, lets the user open an existing cloud chat in ADE, archive/unarchive/cancel, and stream run output. Backed by `ade.ai.cursorCloud.*` IPC. |
| `apps/desktop/src/renderer/components/chat/CursorCloudInlineLaunch.tsx` | Inline composer affordance for "Send to Cursor Cloud": picks repo + branch + Cursor Cloud-eligible model, optionally targeting a detected PR, and dispatches the prompt to a fresh cloud agent. |
| `apps/desktop/src/renderer/components/chat/ChatSurfaceShell.tsx` | Shell that wraps every chat surface (desktop pane, mobile lane, CTO chat) with a unified header/footer slot and `--chat-accent` CSS variable. Supports a `layoutVariant="mobile"` mode that the iOS companion mirrors. |
| `apps/desktop/src/renderer/components/chat/chatSurfaceTheme.ts` | Chat chrome tokens. Exports `PROVIDER_CHAT_ACCENTS` (claude → amber, codex → warm white, cursor → violet, opencode → blue, etc.) and `providerChatAccent(provider)`. iOS mirrors this table in `ADEDesignSystem.swift`. |
| `apps/desktop/src/renderer/components/chat/AgentQuestionModal.tsx` | Floating modal surface for question / structured-question pending inputs. Rendered above the transcript so the user can type or pick an option without losing the chat context. |
| `apps/desktop/src/renderer/components/chat/chatTranscriptRows.ts` | Two-layer event-to-row pipeline (render events + grouped envelopes) that powers the message list. |
| `apps/desktop/src/main/services/ai/tools/` | Tool tiers consumed by the service when it provisions a Claude/Codex/OpenCode runtime (see [Tool System](tool-system.md)). |
| `apps/desktop/src/main/services/ipc/registerIpc.ts` | Validates chat IPC args, exposes `agentChat.*` handlers, and persists/retrieves parallel launch recovery state in `kv`. |
| `apps/desktop/src/shared/ipc.ts` | `ade.agentChat.*` IPC channel constants. |

## Where the chat service runs

The chat service is constructed once per project, inside whichever
runtime owns that project. The desktop renderer talks to it through
the runtime IPC bridge — never directly. When a window is bound to the
local machine, that means the Electron main process's chat service;
when bound to a remote runtime, the **remote `ade serve` daemon**
constructs its own `agentChatService` and the renderer is just a
client. The headless `ade serve` bootstrap in
`apps/ade-cli/src/bootstrap.ts` wires the same `createAgentChatService`
the desktop main process uses, so the surface is identical whether
the host is local Electron or a remote daemon. The iOS app also
reaches the chat service over the same channel (via the sync command
surface), again as a client.

This is the framing to internalise: chat sessions are runtime-owned,
not desktop-owned. The renderer can render them, and the iOS app can
render them, but neither one *runs* them.

## Key concepts

- **Claude Agent SDK pipeline.** The Claude adapter is built on the
  stable `query()` API (SDK 0.2.139): every chat owns a `ClaudeQuery`,
  fed by a `ClaudeInputPump` (`claudeInputPump.ts`) async iterable that
  hands live user turns to `query.streamInput`. Warmup goes through the
  SDK `startup()` hook, output styles and plugins are discovered by
  `claudeOutputStyles.ts`, slash commands by `claudeSlashCommandDiscovery.ts`
  (which delegates to the shared `markdownSlashCommandDiscovery` engine),
  and every spawned subprocess is
  tracked by `claudeSubprocessReaper.ts` so runtime shutdown reaps
  child processes. Claude executable resolution prefers an explicit
  `CLAUDE_CODE_EXECUTABLE_PATH`, then the packaged bundled native
  binary, then detected auth/PATH/common locations, and the resolved
  path is passed through `pathToClaudeCodeExecutable`. Context usage,
  rewindFiles, forkSession, and output-style selection all run through the SDK control channel surfaced on the active
  `Query` handle.
- **Provider-agnostic sessions.** `AgentChatProvider` is one of `claude`,
  `codex`, `opencode`, `cursor`, `droid`, or a free-form string reserved for
  local providers. The service owns a pluggable adapter per provider (Claude
  Agent SDK query stream, Codex JSON-RPC app-server, OpenCode runtime, Cursor
  SDK pool via `cursorSdkPool.ts`, Droid SDK pool via `droidSdkPool.ts`). Both
  Cursor and Droid run their official SDKs (`@cursor/sdk`, `@factory/droid-sdk`)
  in dedicated Node worker children over JSON-line protocols
  (`cursorSdkProtocol.ts`, `droidSdkProtocol.ts`). ADE owns permissions,
  hooks, ask-user prompts, and the system prompt; the SDK owns model + tool
  execution. SDK events are translated to ADE chat events by
  `cursorSdkEventMapper.ts` / `droidSdkEventMapper.ts`. The previous
  ACP-based Droid bridge (`droidAcpPool.ts` / `acpEventMapper`) has been
  retired — only `mapStopReasonToTerminalEvents` is still imported from
  `acpEventMapper.ts` for terminal lifecycle parity.
- **Lane-scoped.** Every session carries `laneId`; lane context (branch,
  worktree path) is injected into the system prompt, and working-directory
  resolution runs through `resolveLaneLaunchContext`. The injected ADE
  workspace directive treats the lane worktree as the boundary for
  writes and mutations: read-only inspection outside the worktree is
  allowed when needed, but file edits and mutating commands must stay
  inside the launched lane unless ADE relaunches the session elsewhere.
- **Event stream first.** All transcript content is a JSON-lines stream of
  `AgentChatEventEnvelope` values. Renderer components derive UI state
  entirely from this stream.
- **Pending input abstraction.** Approvals, questions, permission prompts,
  and plan approvals from every provider collapse into
  `PendingInputRequest`. Renderer derives them via
  `derivePendingInputRequests()`.
- **Steer queue.** Follow-up user messages during an active turn are
  queued (cap 10) with per-entry edit/cancel/dispatch. Default delivery
  happens on turn boundaries; for Claude SDK sessions the user can also
  **send-now** (inline-dispatch the queued message into the active
  turn — the SDK appends it with `shouldQuery: false` and the model
  picks it up at the next thinking step) or **send & interrupt**
  (abort the current turn and run the queued message as the next
  turn). Inline dispatches are reversible until the model reads them
  via `cancelAsyncMessage(uuid)`. The pending-steer queue is persisted
  with chat state so undelivered messages survive restart.
- **Identity sessions.** Sessions carrying `identityKey` (`"cto"` or
  `"agent:<id>"`) are filtered out of the Work tab list and rendered by
  dedicated surfaces (CTO tab, worker detail). See [Agent Routing and
  Identity](agent-routing.md).
- **Inline agent CLI install / auth.** When a chat targets a provider
  whose CLI (Claude, Codex, Cursor, Droid) is missing or
  unauthenticated, the service decorates the resulting error envelope
  with an `agentCli` payload (built via `classifyAgentCliError` from
  `apps/ade-cli/src/services/agentRegistry.ts`). The renderer renders
  that as an `AgentCliAuthCard` inline in the transcript: a copy chip
  for the install / auth command and a Run button that opens a
  tracked PTY in the active lane via `window.ade.pty.create`. The
  command runs in the **active runtime** — a remote-bound desktop
  window installs / logs in on the remote machine. See
  [Agents](../agents/README.md#agent-cli-install--auth-from-chat).
- **Work draft launches.** From an empty embedded Work composer, the
  user can auto-create a lane for a single foreground/background chat
  or CLI session, or enable parallel mode, select two or more
  model/control slots, and send one prompt. The launch flow is
  structured around typed envelopes: `DraftLaunchMode` (`"foreground"
  | "background"`), `DraftLaunchKind` (`"chat" | "cli"`),
  `DraftLaunchLaneTarget` (resolved lane + worktree + auto-created
  flag), `StartedDraftLaunch` (returned session id + kind), and
  `DraftLaunchJob` (multi-step progress tracker). Each launch creates
  a `DraftLaunchJob` with status states `naming-lane` ->
  `creating-lane` -> `starting-session` -> `sending-prompt` ->
  `ready` | `failed`; auto-created lanes enter `naming-lane` while the
  prompt-derived branch name is being resolved, then `creating-lane`
  while the lane row/worktree is created. Jobs live in
  `appStore.draftLaunchJobsByScope`, scoped by project, lane, surface
  profile, and Work draft kind, so a new chat pane or remount does not
  drop loading/error state and another lane pane does not inherit the
  strip. The composer is cleared optimistically at job creation rather
  than after the async flow completes, so users can
  begin composing the next prompt immediately. Active jobs remain
  visible; terminal rows are pruned per scope while keeping at least one
  terminal row alongside active jobs. The pane renders a status strip
  per job with progress messages, an Open button (ready jobs), a
  Restore button (failed jobs that merges the draft snapshot back into
  the composer), Dismiss for terminal jobs, and a hide-status escape
  hatch for stale active jobs when an async launch never settles. The
  `DraftLaunchSnapshot` now captures the full composer state including
  `modelId`, `reasoningEffort`, `codexFastMode`, `executionMode`,
  `interactionMode`, and `nativeControls` so that
  `createSessionForLane` and `startDraftCliLaunch` use the
  snapshot's frozen settings rather than the current composer state.
  Foreground auto-create opens the new session in Work only if it is
  still the latest foreground job when the async flow finishes
  (tracked via `latestForegroundDraftLaunchJobIdRef`). Background
  auto-create records the session without stealing focus.
  `clearDraftLaunchComposer` resets the draft text, attachments, and
  context items after a successful launch so the composer is ready for
  the next prompt. CLI draft launches forward the prompt into the PTY
  through `onLaunchCliSession` (typed as `(args: WorkPtyLaunchArgs) =>
  Promise<WorkPtyLaunchResult>`) with `disposition` matching the
  launch mode. Parallel launch still creates child lanes, starts one
  chat in each lane, sends the same prompt and attachments to every
  session, then opens the Lanes view focused on the new lane set.
- **Composer draft persistence.** Draft composer state (text, model,
  reasoning effort, attachments, context items, draft launch target)
  is persisted to `localStorage` under the
  `ade.chat.composerDraft.v1` key family, scoped by
  `projectRoot:companionStateKey:surfaceProfile:workDraftKind`.
  `ComposerDraftStorageSnapshot` is the on-disk shape; it is
  normalized on read through `normalizeStoredComposerDraft` which
  validates every field, re-infers attachment types, dedupes context
  items, and falls back to defaults for invalid entries. On scope
  change (session switch, lane switch) the pane writes the current
  composer state and hydrates the destination scope's saved snapshot,
  restoring model/reasoning/permission settings for draft chats.
  Active session scopes skip model restoration so the session's
  server-side config is not overwritten by a stale draft. The
  persistence effect uses `composerDraftHydratingRef` to skip the
  first write-back after hydration so the freshly restored state
  does not immediately re-persist with a new timestamp.
- **Built-in browser.** The main process owns a persistent
  `persist:ade-browser` partition with multiple `WebContentsView` tabs.
  The Work right-edge sidebar's `browser` tab renders this surface
  through `ChatBuiltInBrowserPanel`; any URL clicked elsewhere in the
  renderer routes through `openUrlInAdeBrowser()` so it opens inside
  the sidebar instead of the system browser. The broker uses
  Electron's stock Chrome User-Agent — header rewriting is gone. Pages
  that call `window.open()` are honoured via `setWindowOpenHandler`
  returning `action: "allow"` with a `createWindow` factory that
  produces a new internal tab and hands its `webContents` back to
  Chromium; this preserves `window.opener` for OAuth `postMessage`
  callbacks instead of denying the popup and re-navigating in the
  background. A narrow Google sign-in permission carve-out
  (`hid`, `serial`, `usb`, `storage-access`,
  `top-level-storage-access`) is allowed when the requesting URL
  resolves to `accounts.google.com`; everything else is denied.
  Navigation, tab create, switch-tab, and the dedicated
  `built_in_browser.showPanel` / `ade.builtInBrowser.showPanel` IPC
  channel each accept `openPanel: true|false`; `true` emits an
  `open-request` event that `TerminalsPage` listens for to flip the
  Work sidebar to its Browser tab. The `--no-panel` / `--hidden` flags
  on the matching `ade browser ...` CLI commands set `openPanel: false`
  so headless callers can prefetch tabs without yanking the user's
  attention. Inspect-mode hit-tests produce `BuiltInBrowserContextItem`
  payloads that the sidebar forwards to the active chat as composer
  chips alongside iOS / App Control selections.
- **Localhost shortcuts in the work log.** When an agent's tool output
  surfaces a `localhost`/`127.0.0.1`/`0.0.0.0`/`[::1]` URL, the chat
  work-log block renders a sky-toned strip above the tool-call panels.
  The primary chip opens the URL inside the ADE built-in browser
  (`openUrlInAdeBrowser`); a sibling Logs button reveals the chat's
  active terminal inside the bottom drawer through `onRevealChatTerminal`,
  or — when no terminal exists yet — drafts a guided "please move this
  server into the chat terminal" prompt for the agent through
  `onInsertDraft`. URLs are extracted from `entry.localUrls` (set by
  `withLocalhostUrls` in `chatTranscriptRows.ts`) so the strip works
  uniformly across shell commands, tool calls, and arbitrary tool
  results.

See the detail docs for the specifics:

- [Transcript and Turns](transcript-and-turns.md) -- event envelope,
  message/tool lifecycle, batching, virtual scrolling.
- [Tool System](tool-system.md) -- three tiers (universal, workflow,
  coordinator) and their gates.
- [Agent Routing](agent-routing.md) -- provider selection, permission-mode
  mapping, model registry, handoff.
- [Composer and UI](composer-and-ui.md) -- composer, tasks, file changes,
  terminal drawer, message list.

## Session lifecycle

1. `createSession({ laneId, provider, model, modelId?, permissionMode?,
   ...})` via `ade.agentChat.create` creates an `AgentChatSession`,
   persists it, and emits `status: "started"`.
2. Sessions warm up in the background. Claude SDK sessions have a 20 s
   warmup watchdog around the SDK `startup()` readiness probe; if warmup
   does not complete within that window the stale runtime is discarded and
   recreated on the next turn.
3. `sendMessage({ sessionId, text, attachments? })` via
   `ade.agentChat.send` dispatches a turn. Each turn has a 5 min
   turn-level timeout enforced by the abort machinery.
4. The runtime streams events through the main-process event emitter and
   into the renderer via `ade.agentChat.event` (a push channel owned by
   `registerIpc.ts`).
5. On completion the service emits `status: "completed" | "failed" |
   "interrupted"`, optionally emits a `turn_diff_summary`, flushes
   buffered text, and pulls the next queued steer.
6. `dispose({ sessionId })` ends the runtime and persists the final state.

Parallel launch is a renderer-orchestrated workflow layered on the same
session primitives:

1. `AgentChatPane` asks `ade.agentChat.suggestLaneName` for a slug base
   derived from the user's prompt. The service runs the shared
   session-intelligence title prompt against the requested model, the
   configured title model, and fallback title models. If no model can
   produce a usable name, it keeps the first-four-words prompt slug and
   appends the renderer's temporary fallback suffix for uniqueness; the
   generic empty-prompt fallback is `parallel-task`.
2. The pane creates one child lane per selected model slot using a
   unique `<base>-<model-family>` style name and persists progress under
   `agent-chat-parallel-launch:<projectRoot>:<parentLaneId>` in `kv`.
3. For each child lane it creates an `AgentChatSession`, sends the same
   prompt and attachments, and records `sentLaneIds` after each
   successful dispatch.
4. When all sends succeed, the persisted state is cleared and the app
   navigates to `/lanes?laneIds=<ids>&inspectorTab=work`, which opens
   the new lanes side-by-side with the Work pane emphasized.
5. If lane creation or send fails, unsent transient child lanes are
   cleaned up best-effort. On reload, unfinished persisted launch state
   is recovered and cleaned up before the user can start another launch.

Inactivity eviction runs every 15 s (`SESSION_CLEANUP_INTERVAL_MS`). A
runtime is torn down when its session is idle, has no live pending
input, and has exceeded its provider-specific inactivity window:
`SESSION_INACTIVITY_TIMEOUT_MS = 5 min` for Claude/Codex/Cursor runtimes,
`OPENCODE_SESSION_INACTIVITY_TIMEOUT_MS = 60 s` for OpenCode runtimes
(OpenCode holds a pooled server, so its idle window is much shorter to
free the underlying server sooner). Teardown routes through
`teardownRuntime(managed, "idle_ttl")`.

`teardownRuntime` distinguishes **terminal** close reasons
(`handle_close`, `ended_session`, `model_switch`) from **non-terminal**
ones (`idle_ttl`, `budget_eviction`, `pool_compaction`, `paused_run`,
`project_close`, `shutdown`). For Claude runtimes only, a non-terminal
teardown preserves resume state: the service pins
`runtime.sdkSessionId` to the last known Claude SDK session id before releasing
the session, persists chat state immediately, and skips the usual
`runtimeInvalidated = true` + `clearLaneDirectiveKey` cleanup. The next
turn on that chat can therefore rehydrate the same Claude SDK session
instead of creating a fresh one, even though the SDK process was
released to reclaim budget or compact the pool. Terminal closes still
run the full invalidation path so runtime stops and explicit model
switches don't leave stale continuation pointers behind. Cursor SDK
model switches are deferred while a turn is busy: the session model
updates immediately, the active turn keeps reporting the model it
started with, and runtime teardown waits until the turn finishes so
approvals and stream callbacks are not orphaned mid-run.

On app shutdown the service exposes `forceDisposeAll()` — called from
`runImmediateProcessCleanup()` in `main.ts`. It stops the cleanup timer,
rejects every outstanding `sessionTurnCollector` with a "closed during
shutdown" error so IPC callers don't hang, resolves local pending-input
promises with a `cancel` decision, and tears down every managed runtime
with reason `"shutdown"`.

`hasActiveWorkloads()` is the close/quit guard used by `main.ts`: a
chat counts as active when its session is active, it has a live pending
input, or its runtime still has work in flight (turn ids, approvals,
queued steers, subagents, Codex plan follow-ups, Cursor cloud runs,
etc.). The companion `hasRetainableSessions()` is broader: it returns
true for **any** managed session that the user has not explicitly
closed or deleted, including sessions sitting between turns. The
project-context rebalancer in `main.ts` checks `hasRetainableSessions`
first so a project context isn't evicted just because every chat
happens to be idle — the runtime stays warm so the next turn doesn't
cold-start. Project/window close probes still fail closed: if the chat
workload probe throws, ADE keeps the project alive instead of closing
over a possibly running agent.

## IPC surface

All channel constants live in `apps/desktop/src/shared/ipc.ts`; service
handlers live in `apps/desktop/src/main/services/ipc/registerIpc.ts`.

| Channel | Direction | Purpose |
|---|---|---|
| `ade.agentChat.list` | invoke | List sessions with optional `includeIdentity`, `includeAutomation`, `includeArchived` (defaults to `true`; pass `false` to filter out archived rows). |
| `ade.agentChat.getSummary` | invoke | Fetch `AgentChatSessionSummary` for a single session. |
| `ade.agentChat.getEventHistory` | invoke | Return `AgentChatEventHistorySnapshot` for a session. `sessionFound: false` is the explicit stale-session signal used by renderer surfaces to clear dead locked panes. |
| `ade.agentChat.create` | invoke | Create a new session; returns the `AgentChatSession`. Accepts `codexFastMode?: boolean` as the legacy-named Fast Mode bit for any provider/model descriptor that advertises `serviceTiers: ["fast"]`. |
| `ade.agentChat.suggestLaneName` | invoke | Derive a slug-safe lane name from a Work launch prompt using the session-intelligence title prompt, with a prompt-slug + optional unique temporary fallback. |
| `ade.agentChat.parallelLaunchState.get` / `.set` | invoke | Read/write crash-recovery state for renderer-orchestrated parallel launches. State is scoped by project root and parent lane id. |
| `ade.agentChat.handoff` | invoke | Create a handoff session with summarized context. Forwards `codexFastMode` when the target model supports Fast Mode. |
| `ade.agentChat.send` | invoke | Dispatch a user message + attachments. If the session has ended, sending is the continuation path. |
| `ade.agentChat.steer` | invoke | Send a follow-up message mid-turn; queued when appropriate. |
| `ade.agentChat.cancelSteer` / `ade.agentChat.editSteer` | invoke | Queue management for queued steers. |
| `ade.agentChat.dispatchSteer` | invoke | Claude-only: deliver a queued steer immediately as `mode: "inline"` (folded into the active turn via SDK `shouldQuery: false` send) or `mode: "interrupt"` (interrupt the active turn so the steer runs next). Throws on Codex/OpenCode/Cursor. |
| `ade.agentChat.cancelDispatchedSteer` | invoke | Claude-only: rescinds an inline-dispatched message before the model reads it (calls SDK `cancelAsyncMessage(uuid)`). No-op if the message has already been consumed. |
| `ade.agentChat.interrupt` | invoke | Provider-specific interruption of the in-flight turn. |
| `ade.agentChat.approve` | invoke | Legacy approval channel (pre-pending-input). |
| `ade.agentChat.respondToInput` | invoke | Unified pending-input answer channel. |
| `ade.agentChat.delete` | invoke | Permanently remove a chat session: disposes the runtime if still running, cancels any pending turn collector, resolves outstanding input waiters, removes the persisted JSON + transcript, and deletes the `terminal_sessions` row. Renderer surfaces this as "Delete chat". |
| `ade.agentChat.updateSession` | invoke | Mutate permission modes, `manuallyNamed`, capability mode, and the legacy-named `codexFastMode` Fast Mode toggle. |
| `ade.agentChat.codex.goal.get` / `.set` / `.setStatus` / `.clear` | invoke | Codex-only IPC channels behind the preload API `window.ade.agentChat.codex.getGoal` / `.setGoal` / `.setGoalStatus` / `.clearGoal`. They call the app-server goal RPCs directly instead of sending `/goal` prompt text through the chat, preserve CLI/PTY sessions, validate objective length, persist goal state into session summaries, and keep ADE goals unlimited by clearing provider token budgets. |
| `ade.agentChat.warmupModel` | invoke | Preload a Claude SDK runtime for an eventual turn. |
| `ade.agentChat.slashCommands` | invoke | List provider + local slash commands. |
| `ade.agentChat.getContextUsage` | invoke | Claude-only: return the SDK control-channel context usage breakdown (`AgentChatContextUsage`) for the `/context` panel. |
| `ade.agentChat.rewindFiles` | invoke | Claude-only: dry-run and apply SDK file rewind for a selected user message. The renderer dry-run opens a rich confirmation dialog with the message context, aggregate stats, per-file rows, and lazy diff previews; the apply call restores files without modifying conversation history. |
| `ade.agentChat.claudePlugins.list` / `.reload` | invoke | Claude-only: enumerate discovered Claude plugins and force a plugin reload. Backs `/plugin`. |
| `ade.agentChat.claudeOutputStyles.list` / `.set` | invoke | Claude-only: list and select discovered output styles (user + project + plugin roots). Backs `/output-style`. |
| `ade.agentChat.claudeSessions.list` / `.info` / `.messages` | invoke | Claude-only: enumerate SDK sessions, fetch session info, and stream messages for `forkSession` handoff and resume flows. |
| `ade.agentChat.fileSearch` | invoke | Debounced attachment picker backend. |
| `ade.agentChat.saveTempAttachment` | invoke | Write pasted/dropped image bytes to a temp file (10 MB cap). Native clipboard image paste prefers `ade.app.saveClipboardImageAttachment` so Electron can save the clipboard PNG directly and return a compact preview. |
| `ade.agentChat.listSubagents` | invoke | Claude subagent snapshot list. Snapshots are re-keyed on `agentId + parentToolUseId` (not just `taskId`) so multiple subagents spawned from the same parent tool call don't collide, and the renderer panel separates them into three tabs: Subagents, Teammates, and Background. Claude `subagent_*` envelopes are enriched with `agentType` (e.g. `code-reviewer`, `Explore`) by stashing the Task tool's `subagent_type` input at the assistant `tool_use` boundary and joining on `parentToolUseId` when the system-message `task_*` envelope arrives. Codex parallel-agent events carry an `Agent #N` label assigned at first announcement (1-based, per-turn) plus the raw threadId as `agentId`. |
| `ade.agentChat.getSubagentTranscript` | invoke | Fetch the transcript of one subagent run within a chat session. Dispatch by runtime kind: Claude/ade-code reads the SDK's per-subagent JSONL at `~/.claude/projects/<projectDir>/<sessionId>/subagents/agent-<agentId>.jsonl`; OpenCode pulls the child session's messages over the OpenCode HTTP client (the child session id is the agentId); Codex returns captured child-thread stream rows for the registered collab thread and merges them with `thread/turns/list` app-server backfill, with the legacy parent `subagent_*` envelope filter only as fallback; Cursor filters the parent stream by the SDK-tagged `agentId`; LM Studio / Droid return `null`. Returns `AgentChatSubagentTranscriptMessage[]` (same shape as `AgentChatClaudeSessionMessage`). |
| `ade.agentChat.models` | invoke | `{ provider, activateRuntime? }`. For OpenCode `activateRuntime: true` is required to *launch* a probe server; otherwise the main process only returns the cached inventory (via `peekOpenCodeInventoryCache`) and an empty list until a real probe has been run. Cursor and Droid always use `activateRuntime: true` in the TUI model listing path so the SDK can enumerate available models. The renderer cache (`aiDiscoveryCache.ts`) keys on `(projectRoot, provider, activateRuntime)` so passive and active reads don't collide. |
| `ade.agentChat.modelCatalog` | invoke | `{ mode?, refreshProvider? }` → `AgentChatModelCatalog`. Returns the full provider-grouped catalog (claude / codex / cursor / droid / opencode plus the local `ollama` / `lmstudio` groups when OpenCode-routed) for the desktop and TUI ModelPickers. `mode: "cached"` returns the in-memory snapshot, `"refresh-stale"` reuses the cache but optionally re-probes the named runtime when its per-provider freshness TTL is expired, and `"force"` re-probes unconditionally. `refreshProvider` is one of `"opencode" | "cursor" | "droid" | "lmstudio" | "ollama"`. The catalog carries an optional `stale: true` flag and per-model `connected` / `requiresConfiguration` / `sourceRuntime` / `providerId` / `providerName` / `serviceTiers` annotations; Cursor rows also carry `cursorAvailability` so renderer and TUI pickers can separate SDK chat models from CLI launch models. |
| `ade.agentChat.getSessionCapabilities` | invoke | Discover supported subagent/review features. |
| `ade.agentChat.getTurnFileDiff` | invoke | Lazy diff expansion for a turn-file-summary row. |
| `ade.agentChat.event` | push | Stream of `AgentChatEventEnvelope` into the renderer. |

## Fragile and tricky wiring

- **Event emission ordering in `agentChatService.ts`.** The service emits
  text, tool, command, file-change, status, and `done` events from
  multiple async sources (Claude SDK stream, Codex JSON-RPC
  notifications, OpenCode runtime, buffered-text flush). The
  `chatTextBatching` buffer must be flushed on every non-text event to
  preserve ordering. Losing that flush corrupts renderer state. Related
  guard: when `getRecentEntries` is called, the service flushes pending
  buffered text first so transcript reads always reflect the latest
  streamed content.
- **Transcript read merges streaming text fragments.** The
  `MAX_TRANSCRIPT_READ_CHARS` budget is `120_000` (was `40_000`) and
  the transcript reader collapses consecutive assistant text events
  that share a `messageId` or `turnId` into one row instead of
  emitting one row per fragment. The merge runs in two paths: a
  keyed map indexed by `message:<id>` / `turn:<id>` for streamed
  fragments that carry an id, and a running `assistantDraft` for
  fragments that share state across events without an explicit id.
  Both flush back to plain `AgentChatTranscriptEntry` rows before
  returning so the on-wire shape is unchanged.
- **`AgentChatSessionSummary.pendingInputItemId` is the addressable
  pending input.** When a session is awaiting input, the service
  resolves the latest pending item id from the live runtime's
  approval / permission / structured-question maps and, as a
  fallback, replays the last 512 events looking for an unresolved
  `approval_request` / `structured_question`. The same id is mirrored
  into `TerminalSessionSummary.pendingInputItemId` for sync clients
  that key off the terminal session row. iOS uses it to back
  Approve/Deny/Reply intents in the Attention Drawer without opening
  the chat.
- **Steer delivery vs. turn completion.** `deliverNextQueuedSteer()` is
  invoked on every turn-end code path (success, failure, interrupt,
  Claude SDK error). Missing any path can strand a queued steer.
- **Pending steer persistence.** The Claude runtime's `pendingSteers`
  array is mirrored into `PersistedChatState.pendingSteers` on every
  state flush and re-hydrated through `hydratePersistedPendingSteers`
  when the runtime is reattached. Attachment paths are re-resolved
  through `resolvePathWithinRoot` on hydration so the lane's worktree
  path (or project root for absolute paths) is the security boundary,
  not whatever the value was when the steer was queued. The cap is
  shared with the live queue (`MAX_PENDING_STEERS`), so a corrupt
  persisted record can't grow it beyond the in-memory budget.
- **Inline-dispatched steer tracking.** Each Claude `ClaudeRuntime`
  tracks `dispatchedInlineSteers: Map<steerId, uuid>`. The UUID is
  generated client-side and passed to the SDK as the message id; the
  cancel path uses it to call `query.cancelAsyncMessage(uuid)`. The
  map is cleared on read by the model (the `user_message` event
  emitted with `deliveryState: "inline"` marks it as committed UI-side,
  but the cancellable window is bounded by the SDK; once the model
  reads the message the cancel is a no-op). The map is intentionally
  not persisted — restart drops the cancellable window.
- **Pending input derivation.** The renderer's `derivePendingInputRequests`
  in `pendingInput.ts` must handle: (a) legacy `askUser` tool calls, (b)
  Claude `AskUserQuestion` SDK events, (c) Codex `permissions` requests,
  (d) Codex ADE CLI elicitation responses (JSON-schema coercion), (e)
  explicit `pending_input_resolved` events, and (f) `done` events which
  clear approvals but preserve plan-approval/question inputs when the
  turn was `completed`.
- **Interrupt idempotency.** Each provider adapter guards repeat
  `interrupt()` calls. Missing the guard yields duplicate
  `subagent_result` or `error` events. See `interrupted` flag in
  `ClaudeChatRuntimeState`.
- **Claude post-compaction identity re-injection.** When a CTO or worker
  identity session undergoes context compaction, the service calls
  `refreshReconstructionContext()` to re-inject persona and continuity
  protocols. Missing this path loses CTO identity mid-session.
- **Transcript persistence.** Sessions persist version-2 state under the
  `.ade` layout. Re-derivation goes through `sessionRecovery.ts`;
  changing the on-disk format without bumping the version silently
  drops entries on next load.
- **Parallel launch recovery.** The renderer owns the multi-lane launch
  loop, but crash recovery lives behind IPC in `kv`. Update
  `AgentChatParallelLaunchState` in `shared/types/chat.ts`,
  `registerIpc.ts`, `preload.ts`, and `global.d.ts` together whenever
  the state shape changes. The cleanup path must tolerate lanes that
  were already deleted.
- **Identity session filtering.** `listSessions` with
  `includeIdentity: true` is the only way to surface CTO and worker
  chats. Regular renderer surfaces pass `undefined` to exclude them;
  CTO and worker pages pass `true`. Double-check when wiring new chat
  lists.
- **OpenCode passive vs. active inventory reads.** `loadAvailableModels`
  for `provider: "opencode"` no longer unconditionally starts a probe
  server. A passive call (the default for Settings page mounts, model
  dropdown hydration, etc.) hits `peekOpenCodeInventoryCache` and
  returns whatever was last probed; only explicit `activateRuntime: true`
  calls (chat pane refresh for a Claude-to-OpenCode switch, sync
  remote command resolution for a `chat.create` missing an explicit
  model) will spin up the shared server. This avoids repeatedly
  launching an OpenCode process just to render chrome. The registered
  request key in `availableModelsRequests` is `${provider}:${mode}`
  so an active probe and a passive peek can be in flight concurrently
  without cross-resolving.
- **OpenCode binary gating.** `ade.ai.isOpenCodeInstalled` is a cheap
  IPC (no probe, just a `resolveOpenCodeBinary` lookup) used by the
  ModelPicker / Settings to gate the OpenCode rail and surface an
  "Install OpenCode" CTA without flashing before auth/install status
  loads. `openCodeBinaryManager.resolveOpenCodeBinary` re-validates the
  cached path on every call (so a fresh user install during the same
  session is picked up) and intentionally does not cache misses.
  `clearOpenCodeBinaryCache()` is wired into the AI integration's full
  cache reset alongside `clearOpenCodeInventoryCache` and the dynamic
  descriptor reset.
- **OpenCode inventory cache shape.** `probeOpenCodeProviderInventory`
  returns `{ modelIds, catalogModelIds, providers, error, descriptors }`.
  `modelIds` is the selectable list (connected providers only);
  `catalogModelIds` is the full browseable catalog including unconnected
  cloud providers. `OpenCodeProviderInfo` carries both `modelCount` and
  `availableModelCount`. Variant keys are classified into
  `reasoningTiers` (alias map handles `mini`/`med`/`extra-high`/etc.)
  and `serviceTiers` (`fast`) instead of a flat `variantKeys` array; the
  Settings page UI consumes this when drawing per-provider model rails.
- **OpenCode shared server pool compaction.** Acquiring a shared
  OpenCode server (`acquireSharedOpenCodeServer`) now calls
  `pruneIdleSharedEntries(excludeKey)` which shuts down every other
  idle shared entry with reason `"pool_compaction"`. The runtime /
  coordinator shutdown-reason union was widened accordingly
  (`teardownRuntime` in the chat service and
  `releaseOpenCodeCoordinatorSession` in `coordinatorAgent.ts` both
  accept `"pool_compaction"`). The effect: only one shared OpenCode
  server runs at a time per project; switching provider config or
  between chats with different configs recycles the pool instead of
  stacking processes.

## Configuration

Config flags that influence chat behavior (all stored under the project
config service):

- `ai.mode` -- `subscription` vs `guest`; gates auto-title, tool
  availability, and provider selection.
- `ai.sessionIntelligence.titles.*` and
  `ai.chat.autoTitleReasoningEffort` -- AI title generation.
- `ai.permissions.*` -- per-provider permission defaults
  (`claudePermissionMode`, Codex approval/sandbox defaults, OpenCode
  permission).
- `ai.taskRouting` -- provider/model selection per task type.

## Related docs

- [Agents README](../agents/README.md) -- CTO and worker identities,
  persona overlays, tool policy.
- [History README](../history/README.md) -- chat sessions are not
  recorded in the operations timeline, but the turns that cause git
  state changes (lane creation, PR creation, commits) are.
