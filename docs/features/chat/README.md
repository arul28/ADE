# Chat

Agent Chat is the interactive AI coding surface inside ADE. Each chat binds a
lane (git worktree + branch), a provider runtime (Claude, Codex, OpenCode,
Cursor), and a transcript into a persistent `AgentChatSession`. The user talks
to the agent the same way they would use any IDE copilot, but with ADE's
lane/session tracking, tool approval flow, memory integration, and handoff
machinery layered on top.

## Source file map

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/chat/agentChatService.ts` | Main service: session lifecycle, turn dispatch, event emission, provider adapters, steer queue, handoff, auto-title, and prompt-derived lane-name suggestions for parallel launch. Tracks Codex Fast Mode (`codexFastMode: boolean`) per session and forwards it as `serviceTier: "fast" \| null` on every Codex `thread/start` and `turn/start` JSON-RPC call (see [Agent Routing](agent-routing.md#codex-service-tiers-fast-mode)). Spawns Claude/Codex agent runtimes with `buildAgentRuntimeEnv(managed)` so every agent process inherits `ADE_CHAT_SESSION_ID`, `ADE_LANE_ID`, `ADE_PROJECT_ROOT`, and `ADE_WORKSPACE_ROOT` (used by the agent guidance to call `ade --socket app-control logs` / `terminal read --chat-session "$ADE_CHAT_SESSION_ID"` without resolving the chat ID itself). Claude SDK sessions also resolve the executable through `claudeCodeExecutable.ts` and pass `pathToClaudeCodeExecutable` so packaged builds can prefer the bundled native binary before PATH/auth fallbacks. Large orchestrator file. |
| `apps/desktop/src/main/services/chat/runtimeEvents.ts` | Canonical cross-runtime event vocabulary (`turn.*`, `content.delta`, `tool.*`, `subagent.*`, teammate/task events, compaction boundaries) plus shims between legacy `AgentChatEvent` rows and the canonical runtime envelope. Claude emits canonical subagent events alongside the legacy rows while the other adapters migrate. |
| `apps/ade-cli/src/tuiClient/` | Terminal **Work** chat TUI (Ink + React): same action/RPC contracts as desktop, **attached** (socket) or **embedded** (headless runtime via `ade-cli`). See [ADE Code](../ade-code/README.md). |
| `apps/desktop/src/main/services/builtInBrowser/builtInBrowserService.ts` | Main-process broker for the in-app web browser. Owns a single `persist:ade-browser` partition, multiple `WebContentsView` tabs (cap 10), bounds + visibility against the renderer-supplied frame, debugger-protocol attachment for inspect-mode hit tests, screenshot capture, and emission of `BuiltInBrowserContextItem`s for selected page elements. Spoofs a desktop Chrome `User-Agent` and the matching `Sec-CH-UA*` client hints on every request through `webRequest.onBeforeSendHeaders` so external sign-in flows (Google, etc.) treat the embedded view as a normal desktop Chrome instead of refusing to load — the previous "open Google sign-in in the system browser" branch was removed because the spoofed UA stops Google from blocking the page in the first place. Window-open requests are forwarded into a fresh tab with `openPanel: true` so the Work sidebar Browser tab pops automatically. Backs the `ade.builtInBrowser.*` IPC surface and is consumed by both `ChatBuiltInBrowserPanel` (sidebar Browser tab) and `openExternal.ts` (links inside the renderer route through the built-in browser when the protocol is `http`/`https`/`about:blank`). |
| `apps/desktop/src/shared/types/builtInBrowser.ts` | Cross-process types for the built-in browser: `BuiltInBrowserStatus`, `BuiltInBrowserTab`, `BuiltInBrowserContextItem` (`kind: "built_in_browser_element" | "built_in_browser_capture"`), `BuiltInBrowserSelectResult`, `BuiltInBrowserScreenshot`, `BuiltInBrowserOpenPanelArgs`, and the `BuiltInBrowserEventPayload` union (`status`, `open-request`, `selection`, `selection-cleared`, `error`). Navigate / create-tab / switch-tab args carry an optional `openPanel: boolean` so callers can ask for the Work sidebar Browser tab to flip open atomically with the navigation. |
| `apps/desktop/src/main/services/chat/buildClaudeV2Message.ts` | Builds Claude SDK user messages for the `query()` input stream. Handles base64 image content blocks and MIME inference. |
| `apps/desktop/src/main/services/chat/claudeInputPump.ts` | Async iterable input pump that feeds live user turns into the Claude Agent SDK `query()` stream. |
| `apps/desktop/src/main/services/chat/claudeSubprocessReaper.ts` | Tracks Claude SDK subprocesses and tears them down on runtime shutdown. |
| `apps/desktop/src/main/services/chat/claudeOutputStyles.ts` | Discovers Claude output styles and plugins from project/user roots. Project roots are walked directly, while user-installed marketplace plugins are loaded only from Claude's installed-plugin registry when enabled in settings, so cache/source copies do not leak into ADE sessions. |
| `apps/desktop/src/main/services/chat/claudeSlashCommandDiscovery.ts` | Discovers project and user Claude slash surfaces by walking ancestor `.claude` roots, reading `.claude/commands/**/*.md`, `~/.claude/commands/**/*.md`, and `.claude/skills/*/SKILL.md` / `~/.claude/skills/*/SKILL.md` entries with command frontmatter. Consumed by `agentChatService` to enrich both the `chat.slashCommands` response and Claude system prompt with local command/skill metadata. |
| `apps/desktop/src/main/services/chat/chatTextBatching.ts` | Batches streaming assistant text fragments (100 ms) before emission to reduce renderer re-renders. |
| `apps/desktop/src/main/services/chat/sessionRecovery.ts` | Version-2 persisted-state reconstruction when sessions resume from disk. |
| `apps/desktop/src/main/services/chat/cursorSdkPool.ts` | Cursor SDK adapter: spawns and pools `cursorSdkWorker.ts` Node workers per session, sends turns, brokers permission/hook callbacks, maps SDK events to chat events, and handles teardown. |
| `apps/desktop/src/main/services/chat/cursorSdkWorker.ts` | Node worker that hosts the official `@cursor/sdk` and bridges it to the main process via the JSON line protocol in `cursorSdkProtocol.ts`. |
| `apps/desktop/src/main/services/chat/cursorSdkProtocol.ts` | Shared types for the worker IPC: chat mode, approval policy, sandbox mode, hook decisions, hook requests, and `CursorSdkWorkerInit` boot envelope. |
| `apps/desktop/src/main/services/chat/cursorSdkPolicy.ts` | Maps ADE permission modes onto Cursor SDK chat mode + approval policy + sandbox mode (`ade` / `cursor-native` / `off`); decides which tool calls auto-approve and which require a user prompt. |
| `apps/desktop/src/main/services/chat/cursorSdkSystemPrompt.ts` | Builds the system prompt the Cursor worker injects (lane context, ADE CLI guidance, persona overlays). |
| `apps/desktop/src/main/services/chat/cursorSdkEventMapper.ts` | Translates `@cursor/sdk` stream events into the ADE `AgentChatEventEnvelope` shape consumed by the renderer. |
| `apps/desktop/src/shared/chatTranscript.ts` | Pure JSON-lines parser for `AgentChatEventEnvelope` values. Used by both the main process and the renderer. |
| `apps/desktop/src/shared/types/chat.ts` | All chat types: `AgentChatSession`, `AgentChatEvent` union, permission modes, pending input, completion reports, `PARALLEL_CHAT_MAX_ATTACHMENTS`, and parallel launch state DTOs. |
| `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` | Top-level renderer surface: state derivation, IPC wiring, composer mount, message-list mount, End/Delete chat controls in the header, parallel multi-model lane launch orchestration, transient-lane cleanup, and multi-lane deep-link navigation. Mounts `AgentQuestionModal` when the active pending input is a question/structured-question. Resolves the surface accent colour through `providerChatAccent(provider)` so Claude/Codex/Cursor stay visually consistent regardless of model variant. On macOS, polls `ade.iosSimulator.getStatus` and renders the iOS Simulator drawer toggle in the header when the platform is supported (see [iOS Simulator feature](../ios-simulator/README.md)); selecting elements inside the drawer flows back through the pane as `IosElementContextItem` chips on the composer. Polls `ade.appControl.getStatus` and exposes the App Control drawer toggle when the platform is supported, mounting `ChatAppControlPanel`; selections become `AppControlContextItem` chips + attachments on the composer. See [App Control](../computer-use/app-control.md). When mounted as a Work tile (`SessionSurface` passes `hideLaneToolDrawers={true}`) the iOS / App Control toggles are suppressed because the Work right-edge sidebar owns those drawers at lane scope; the pane still listens on `ade:agent-chat:add-attachment` / `add-ios-context` / `add-app-control-context` / `add-builtin-browser-context` / `insert-draft` window events so selections from the sidebar flow into the active chat composer when the sidebar's `attachChatSessionId` matches. Proof remains chat-scoped and stays on the chat header. |
| `apps/desktop/src/renderer/components/chat/RewindFilesConfirmDialog.tsx`, `rewindFilesPreview.ts` | Claude file-rewind confirmation surface. `rewindFilesPreview.ts` maps the selected user message to turn diff summaries and per-file SHA ranges; the dialog lists every restored file, expands rows into `AdeDiffViewer`, and confirms the SDK `rewindFiles` call without using browser-native confirm UI. |
| `apps/desktop/src/renderer/components/chat/ChatBuiltInBrowserPanel.tsx` | Renderer panel for the in-app browser. Renders the address bar, tabs strip, navigation controls, an inspect/select toolbar, and a `BuiltInBrowserStatus`-derived empty/error state, then asks the main process to position the underlying `WebContentsView` over the panel's bounding rect through `ade.builtInBrowser.setBounds`. Mounted by `WorkSidebar` under the `browser` tab and (indirectly) by any renderer code that calls `openUrlInAdeBrowser()` — the helper opens the sidebar Browser tab and dispatches the URL into a fresh tab. Selections committed through inspect-mode hit-testing fan out via the `onAddContext` callback as `BuiltInBrowserContextItem` payloads. |
| `apps/desktop/src/renderer/lib/openExternal.ts` | Renderer-side router for outbound URLs. Defines the `ADE_OPEN_BUILT_IN_BROWSER_EVENT` window event plus `openUrlInAdeBrowser(url)` and `openExternalUrl(url)`. `openUrlInAdeBrowser` dispatches the event (so any open `WorkSidebar` can flip to its Browser tab), then calls `window.ade.builtInBrowser.navigate({ url, newTab: true })`. Anything that is not a normal `http`/`https`/`about:blank` URL falls through to `window.ade.app.openExternal` (system browser). All in-renderer URL clicks (markdown links, lane-runtime open buttons, etc.) go through this helper so the user stays inside ADE. |
| `apps/desktop/src/renderer/components/chat/AgentChatComposer.tsx` | Composer UI: single-session prompt entry, attachments, model/permission controls, slash commands, pending input answering, and parallel launch slot configuration. Pasted/dropped image attachments show pending thumbnails while temp files save, and native Electron clipboard images use `ade.app.saveClipboardImageAttachment` before falling back to `ade.agentChat.saveTempAttachment`. |
| `apps/desktop/src/renderer/components/chat/ChatCursorCloudPanel.tsx` | Side panel for Cursor Cloud (background agents): lists existing cloud agents and runs for the lane, lets the user open an existing cloud chat in ADE, archive/unarchive/cancel, and stream run output. Backed by `ade.ai.cursorCloud.*` IPC. |
| `apps/desktop/src/renderer/components/chat/CursorCloudInlineLaunch.tsx` | Inline composer affordance for "Send to Cursor Cloud": picks repo + branch + Cursor Cloud-eligible model, optionally targeting a detected PR, and dispatches the prompt to a fresh cloud agent. |
| `apps/desktop/src/renderer/components/chat/ChatSurfaceShell.tsx` | Shell that wraps every chat surface (desktop pane, mobile lane, CTO mission) with a unified header/footer slot and `--chat-accent` CSS variable. Supports a `layoutVariant="mobile"` mode that the iOS companion mirrors. |
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
  `claudeOutputStyles.ts`, slash commands by `claudeSlashCommandDiscovery.ts`,
  and every spawned subprocess is
  tracked by `claudeSubprocessReaper.ts` so runtime shutdown reaps
  child processes. Claude executable resolution prefers an explicit
  `CLAUDE_CODE_EXECUTABLE_PATH`, then the packaged bundled native
  binary, then detected auth/PATH/common locations, and the resolved
  path is passed through `pathToClaudeCodeExecutable`. Context usage,
  rewindFiles, forkSession, and output-style selection all run through the SDK control channel surfaced on the active
  `Query` handle.
- **Provider-agnostic sessions.** `AgentChatProvider` is one of `claude`,
  `codex`, `opencode`, `cursor`, or a free-form string reserved for local
  providers. The service owns a pluggable adapter per provider (Claude Agent
  SDK query stream, Codex JSON-RPC app-server, OpenCode runtime, Cursor SDK pool via
  `cursorSdkPool.ts`). The Cursor adapter runs the official `@cursor/sdk`
  in a Node worker (`cursorSdkWorker.ts`) over the JSON line protocol
  defined in `cursorSdkProtocol.ts`; permissions, hooks, and the system
  prompt are assembled by `cursorSdkPolicy.ts` and
  `cursorSdkSystemPrompt.ts`, and SDK events are translated into
  ADE chat events by `cursorSdkEventMapper.ts`. Cursor is SDK-backed here;
  ACP is only used by providers that still expose an ACP host, such as Droid.
- **Lane-scoped.** Every session carries `laneId`; lane context (branch,
  worktree path) is injected into the system prompt, and working-directory
  resolution runs through `resolveLaneLaunchContext`.
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
- **Parallel multi-model launch.** From an empty embedded Work composer,
  the user can enable parallel mode, select two or more model/control
  slots, and send one prompt. ADE creates child lanes, starts one chat
  in each lane, sends the same prompt and attachments to every session,
  then opens the Lanes view focused on the new lane set.
- **Built-in browser.** The main process owns a persistent
  `persist:ade-browser` partition with multiple `WebContentsView` tabs.
  The Work right-edge sidebar's `browser` tab renders this surface
  through `ChatBuiltInBrowserPanel`; any URL clicked elsewhere in the
  renderer routes through `openUrlInAdeBrowser()` so it opens inside
  the sidebar instead of the system browser. The browser broker spoofs
  a desktop Chrome User-Agent (with matching `Sec-CH-UA*` headers) so
  third-party sign-in flows treat the embedded view as desktop Chrome
  — the older "Google sign-in opens in the system browser" carve-out is
  gone. Navigation, tab create, switch-tab, and the new dedicated
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
   derived from the user's prompt. The service uses a lightweight
   OpenCode text call when an eligible model is available and falls back
   to a deterministic first-four-words slug (`parallel-task` for empty
   prompts).
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
switches don't leave stale continuation pointers behind.

On app shutdown the service exposes `forceDisposeAll()` — called from
`runImmediateProcessCleanup()` in `main.ts`. It stops the cleanup timer,
rejects every outstanding `sessionTurnCollector` with a "closed during
shutdown" error so IPC callers don't hang, resolves local pending-input
promises with a `cancel` decision, and tears down every managed runtime
with reason `"shutdown"`.

## IPC surface

All channel constants live in `apps/desktop/src/shared/ipc.ts`; service
handlers live in `apps/desktop/src/main/services/ipc/registerIpc.ts`.

| Channel | Direction | Purpose |
|---|---|---|
| `ade.agentChat.list` | invoke | List sessions with optional `includeIdentity`, `includeAutomation`. |
| `ade.agentChat.getSummary` | invoke | Fetch `AgentChatSessionSummary` for a single session. |
| `ade.agentChat.create` | invoke | Create a new session; returns the `AgentChatSession`. Accepts `codexFastMode?: boolean` for Codex sessions to start with the `serviceTier: "fast"` default. |
| `ade.agentChat.suggestLaneName` | invoke | Derive a slug-safe base lane name from a parallel prompt using a lightweight model call with deterministic fallback. |
| `ade.agentChat.parallelLaunchState.get` / `.set` | invoke | Read/write crash-recovery state for renderer-orchestrated parallel launches. State is scoped by project root and parent lane id. |
| `ade.agentChat.handoff` | invoke | Create a handoff session with summarized context. Forwards `codexFastMode` when the target provider is Codex. |
| `ade.agentChat.send` | invoke | Dispatch a user message + attachments. If the session has ended, sending is the continuation path. |
| `ade.agentChat.steer` | invoke | Send a follow-up message mid-turn; queued when appropriate. |
| `ade.agentChat.cancelSteer` / `ade.agentChat.editSteer` | invoke | Queue management for queued steers. |
| `ade.agentChat.dispatchSteer` | invoke | Claude-only: deliver a queued steer immediately as `mode: "inline"` (folded into the active turn via SDK `shouldQuery: false` send) or `mode: "interrupt"` (interrupt the active turn so the steer runs next). Throws on Codex/OpenCode/Cursor. |
| `ade.agentChat.cancelDispatchedSteer` | invoke | Claude-only: rescinds an inline-dispatched message before the model reads it (calls SDK `cancelAsyncMessage(uuid)`). No-op if the message has already been consumed. |
| `ade.agentChat.interrupt` | invoke | Provider-specific interruption of the in-flight turn. |
| `ade.agentChat.approve` | invoke | Legacy approval channel (pre-pending-input). |
| `ade.agentChat.respondToInput` | invoke | Unified pending-input answer channel. |
| `ade.agentChat.delete` | invoke | Permanently remove a chat session: disposes the runtime if still running, cancels any pending turn collector, resolves outstanding input waiters, removes the persisted JSON + transcript, and deletes the `terminal_sessions` row. Renderer surfaces this as "Delete chat". |
| `ade.agentChat.updateSession` | invoke | Mutate permission modes, `manuallyNamed`, capability mode, and the `codexFastMode` toggle. |
| `ade.agentChat.warmupModel` | invoke | Preload a Claude SDK runtime for an eventual turn. |
| `ade.agentChat.slashCommands` | invoke | List provider + local slash commands. |
| `ade.agentChat.getContextUsage` | invoke | Claude-only: return the SDK control-channel context usage breakdown (`AgentChatContextUsage`) for the `/context` panel. |
| `ade.agentChat.rewindFiles` | invoke | Claude-only: dry-run and apply SDK file rewind for a selected user message. The renderer dry-run opens a rich confirmation dialog with the message context, aggregate stats, per-file rows, and lazy diff previews; the apply call restores files without modifying conversation history. |
| `ade.agentChat.claudePlugins.list` / `.reload` | invoke | Claude-only: enumerate discovered Claude plugins and force a plugin reload. Backs `/plugin`. |
| `ade.agentChat.claudeOutputStyles.list` / `.set` | invoke | Claude-only: list and select discovered output styles (user + project + plugin roots). Backs `/output-style`. |
| `ade.agentChat.claudeSessions.list` / `.info` / `.messages` | invoke | Claude-only: enumerate SDK sessions, fetch session info, and stream messages for `forkSession` handoff and resume flows. |
| `ade.agentChat.fileSearch` | invoke | Debounced attachment picker backend. |
| `ade.agentChat.saveTempAttachment` | invoke | Write pasted/dropped image bytes to a temp file (10 MB cap). Native clipboard image paste prefers `ade.app.saveClipboardImageAttachment` so Electron can save the clipboard PNG directly and return a compact preview. |
| `ade.agentChat.listSubagents` | invoke | Claude subagent snapshot list. Snapshots are re-keyed on `agentId + parentToolUseId` (not just `taskId`) so multiple subagents spawned from the same parent tool call don't collide, and the renderer panel separates them into three tabs: Subagents, Teammates, and Background. |
| `ade.agentChat.models` | invoke | `{ provider, activateRuntime? }`. For OpenCode `activateRuntime: true` is required to *launch* a probe server; otherwise the main process only returns the cached inventory (via `peekOpenCodeInventoryCache`) and an empty list until a real probe has been run. The renderer cache (`aiDiscoveryCache.ts`) keys on `(projectRoot, provider, activateRuntime)` so passive and active reads don't collide. |
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
  `refreshReconstructionContext()` to re-inject persona + core memory +
  protocols. Missing this path loses CTO identity mid-session.
- **ADE CLI approval bypass during auto-compaction.** The Claude runtime
  sets `compactionInProgress` when the SDK `PreCompact` hook fires and
  keeps it set for 60 s (the SDK emits no `PostCompact` signal). While
  the flag is true, `canUseTool` auto-approves ADE CLI tools (notably
  `memory_add`) so the compaction flush can persist memories without
  blocking on an approval prompt that no user is present to answer.
  Non-ADE CLI tools still go through the normal approval gate.
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

- [Memory README](../memory/README.md) -- memory tools are provisioned
  for every chat; turn-level memory guard blocks mutations on "required"
  intents until `memorySearch` is called.
- [Agents README](../agents/README.md) -- CTO and worker identities,
  persona overlays, tool policy.
- [History README](../history/README.md) -- chat sessions are not
  recorded in the operations timeline, but the turns that cause git
  state changes (lane creation, PR creation, commits) are.
