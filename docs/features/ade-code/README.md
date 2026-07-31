# ADE Code (terminal Work chat)

`ade code` is a terminal-native client for the same **Work** agent chat surface the Electron app exposes in `AgentChatPane`. It targets agents and operators who prefer a shell-first workflow: Ink + React render the TUI, while chat transcripts, slash commands, lane navigation, model picks, and ADE actions all flow through the same JSON-RPC contracts the desktop uses. The TUI owns its own runtime UI stack in `apps/ade-cli` (`ink@7` + React 19); the Electron renderer stays on its separate React dependency graph.

It is a client. The runtime, lanes, chats, transcripts, PRs, terminal sessions, and proof artifacts live in the per-machine ADE runtime (`ade serve`). `ade code` attaches to that runtime, drives a single project scope, and renders incoming events.

## Browser mirror (development)

Ink renders to a TTY, not the DOM. For local dev, **`npm run dev:code:web`** (`scripts/tui-web.mjs`) runs **one** `ade code` in a PTY and streams the same ANSI byte stream to xterm.js in the browser — the same live session, not a separate UI or React DOM clone.

```text
ade code (Ink) → PTY stdout → tui-web.mjs → WebSocket → xterm.js
```

Use **`npm run dev:code`** when you want the TUI in Terminal.app or iTerm instead. Do not run `ade code` in a native terminal **and** open the web mirror unless both attach to that single PTY (the web script owns the process).

Point Cursor’s browser inspector at the served page for layout debugging. The DOM is mostly xterm’s terminal grid (rows/cells), not Ink components like `Drawer` or `ChatView`. Fix layout, colors, and keybindings in `apps/ade-cli/src/tuiClient/`; fix blank pages, WebSocket stalls, cwd, or resize/grid drift in `scripts/tui-web.mjs`.

## Source file map

| Path | Role |
|------|------|
| `scripts/tui-web.mjs` | Dev browser mirror for `ade code`: ensures the dev runtime, spawns one PTY, serves xterm.js + WebSocket bridge (`npm run dev:code:web`). |
| `apps/ade-cli/src/cli.ts` | Resolves the built or source TUI entry and forwards the parsed launch context to `runAdeCodeCli`. |
| `apps/ade-cli/src/adeRpcServer.ts` | Runtime JSON-RPC and ADE action dispatcher used by the TUI/CLI. After a successful user-issued meaningful mutation it records one local usage event, attributing `ade-code` / `ade-cli` clients to `tui`; agent-owned run/step/chat calls and read-only actions are excluded. |
| `apps/ade-cli/src/tuiClient/cli.tsx` | TUI entry: argv parsing, project discovery, connection bootstrap, Ink mount. Built to `apps/ade-cli/dist/tuiClient/cli.mjs`. |
| `apps/ade-cli/src/tuiClient/app.tsx` | Primary Ink/React surface: navigation, composer, drawers, right pane, session lifecycle, slash command dispatch. It joins chat/terminal lists with `session.list` lifecycle fields and dispatches `/chat ask`, `/chat note`, `/chat settle`, and `/chat unsettle` through the session action domain (settle/unsettle land on the cto-gated `session.settleSession` / `session.unsettleSession` — the agent-facing `*SelfSession` pair was removed in 2026-07); settling a row that is awaiting input or explicitly requesting attention asks the backend to dismiss that pending input in the same settlement transaction. The target-addressable `/session snooze` / `wake` / `settle` / `unsettle` / `keep-active` commands are parsed in `sessionLifecycle.ts` and dispatched from here, with `components/Drawer.tsx` and `components/RightPane.tsx` rendering the resulting snooze/woke row markers. Owns startup reconnect/retry UI, the debounced/cached `@` mention loader, cursor-relative `/command` + `@file` trigger detection via the shared `apps/desktop/src/shared/composerTriggers.ts` module (mid-sentence slash completion on Tab/Enter, colored `@file`/`/command` chip tokens painted into the prompt rows through `segmentPromptLineText` + `findConfirmedComposerTokens`), smart-link prompt styling/summary strips, terminal mode restoration on exit/heartbeat shutdown, and the `Ctrl+Y` "copy ADE deeplink" handler which resolves the focused lane / PR row through `buildDeeplinkForRow` and copies the canonical `ade://...` URL to the system clipboard. It also owns cache-first chat revisits and the two-stage older-history path: drain the already-hydrated local snapshot buffer, then request byte-cursor pages with bounded retry while preserving the cursor on transient failure. Also backs `/skills` by listing Agent Skill roots from project, user, inherited, and bundled ADE locations, independent of the active provider. |
| `apps/ade-cli/src/tuiClient/attentionPane.ts` | Account-first `/attention` model: loads through machine-global `attention.call`, groups the shared Attention contract, derives exact ADE links, labels machine fallback honestly, and sends account-owner/source-revision-fenced seen mutations only after navigation succeeds. |
| `apps/ade-cli/src/tuiClient/components/AttentionPaneView.tsx` | Calm right-pane rendering for Needs you, Failing or blocked, Done unreviewed, Live now, and Recent groups, including machine/project context, offline last-known labels, recovery copy, and keyboard hints. |
| `apps/ade-cli/src/tuiClient/promptSmartLinks.ts` | ADE Code's capability-adapted smart-link helpers. Formats a one-row violet provider/label strip from the shared `smartLinks.ts` catalog and makes character Backspace/Delete remove the whole URL when the cursor intersects it; the prompt still contains and sends the canonical raw URL. |
| `apps/ade-cli/src/tuiClient/productAnalytics.ts` | Pure TUI screen normalization plus runtime `analytics.capture` calls. `app.tsx` records a deduplicated open and normalized screen changes; it never owns a PostHog client, reads terminal/chat content, or emits per-render/poll events. Accepted events share the machine runtime's consent and 200-event daily budget. See [logging and product analytics](../../logging.md). |
| `apps/ade-cli/src/tuiClient/externalSessionBrowser.ts` | Pure state/actions for the provider-native session browser. Filters and clamps rows, consumes the shared Continue/Copy policy, puts `Open existing ADE session` first for imported rows, and exposes only Copy actions after it so Enter never re-imports the original session. |
| `apps/ade-cli/src/tuiClient/deeplinkRow.ts` | Pure helper used by the `Ctrl+Y` keybinding. Maps the focused lane or PR row (including parsing a GitHub PR URL when the right pane only carries the URL) onto a `DeeplinkTarget` and returns the built `ade://` URL. Tested in `tuiClient/__tests__/deeplinkKeybind.test.ts`. |
| `apps/ade-cli/src/commands/deeplinks.ts` | `ade open`, `ade link`, and `ade linear install` subcommands. Shares the parser + builder with the desktop main process so URLs round-trip across both surfaces. See [features/deeplinks/README.md](../deeplinks/README.md). |
| `apps/ade-cli/src/tuiClient/connection.ts` | Resolves attached vs embedded mode, runs the `ade/initialize` handshake, registers the project with `projects.add`, wraps subsequent requests with `projectId`, and exposes `subscribeRuntimeEvents`. Computes the expected SHA-256 build hash from the resolved CLI entrypoint and compares it against the runtime's reported `runtimeInfo.buildHash` / `defaultRole` / `projectRoot`; a mismatch throws `StaleAdeSocketError`, optionally shuts the stale runtime process down, and lets `spawnDaemon` start a compatible one (with `ADE_DEFAULT_ROLE=cto` in the spawned env). Remote sockets skip local build-hash/project-root compatibility checks. Runtime-event subscription responses surface replay gaps (`gap`, `oldestCursor`, `nextCursor`) to callers so the TUI can reset stale cursors instead of silently missing events. `initializeEmbeddedCto` injects a trusted `cto` role only when `ADE_DEFAULT_ROLE` is not already set to a valid value. |
| `apps/ade-cli/src/runtimeRoles.ts` | `ADE_RUNTIME_ROLES` (`cto`, `orchestrator`, `agent`, `external`, `evaluator`), role normalization, the runtime default-role ceiling, and `resolveSessionBoundRole`. A chat-session binding is an authority boundary: it preserves an explicit lower role but clamps an otherwise CTO-capable session to `agent`. Shared by `cli.ts`, `adeRpcServer.ts`, `multiProjectRpcServer.ts`, and `tuiClient/connection.ts` so role parsing stays consistent across surfaces. |
| `apps/ade-cli/src/tuiClient/jsonRpcClient.ts` | Socket client for Unix/named-pipe and `tcp://` endpoints. Supports JSON-line and Content-Length frames, per-request timeouts, unexpected-close callbacks, notifications (`chat/event`, `runtime/event`), and bounded read buffers (16 MB frame cap, 64 KB header cap) so a wedged runtime cannot grow memory unbounded. |
| `apps/ade-cli/src/tuiClient/remoteLauncher.ts` | `ade code remote` CLI coordinator: parses target/project/session/route flags, prompts for the saved machine, registers or selects a remote project, lists launchable remote chats/tracked CLI terminals, and invokes the normal TUI with remote project/session hints. Account-created targets are paired-only and never fall back to SSH. |
| `apps/ade-cli/src/tuiClient/pairedRemoteConnector.ts` | Canonical paired route policy for ADE Code remote: resolves credentials, orders or filters LAN/Tailscale/Relay candidates, obtains Relay account proof, opens the bounded runtime channel, verifies the account did not change mid-connect, records endpoint health, and returns structured path failures. |
| `apps/ade-cli/src/tuiClient/remoteLaunchBudget.ts` | Shared total-deadline and per-attempt cancellation utilities used by paired and SSH remote connection setup. |
| `apps/ade-cli/src/tuiClient/remoteBridge.ts` | Remote transport shim used by `remoteLauncher.ts`: connects to the existing paired sync-runtime bridge or starts `ade rpc --stdio` over SSH, performs JSON-RPC for selection/listing, then exposes a local one-connection bridge socket (Unix socket on POSIX, loopback TCP on Windows) to the regular TUI. Owns bounded frames, transport diagnostics, child-process cleanup, and bridge-socket teardown. |
| `apps/ade-cli/src/tuiClient/commands.ts` / `linearCommands.ts` | Slash command catalog and routing. `commands.ts` ships the active-session lifecycle commands (`/chat ask`, `/chat note`, `/chat settle`, `/chat unsettle`) plus the target-addressable `/session` family (`/session snooze`, `/session wake`, `/session settle`, `/session unsettle`, `/session keep-active`, parsed and dispatched through `sessionLifecycle.ts`; `/chat settle` and `/chat unsettle` keep their own active-only dispatch in `app.tsx`), `/lane delete` (right-pane confirmation form that destroys the active lane), `/effort` (reasoning-effort-only picker, a narrower companion to `/model`), provider-agnostic `/skills` for Agent Skill discovery, and provider-agnostic `/secrets` for masked project-secret listing/copying. `linearCommands.ts` requires a sub-command — bare `/linear` returns the usage hint instead of silently picking `workflows`. It also routes the session/lane attachment verbs (`attach` / `detach` / `issues` → `lane` domain session-scoped or lane-scoped actions) and the issue write-bridge verbs (`comment` / `set-state` / `assign` / `label` → `linear_issue_tracker` domain), reusing `--issue-id` / `--linear-issue-json` / attachment flags (`source`, `includeInPr`, `closeOnMerge`, `role`) parsing shared with the typed `ade linear` CLI commands in `cli.ts`. |
| `apps/ade-cli/src/tuiClient/providerMetadata.ts` | Provider labels, family labels, token normalization, and provider lookup helpers shared by setup rows and the model picker. Keeps Anthropic/OpenAI/Factory aliases mapped onto the TUI's provider ids and decides which providers support runtime catalog refresh. |
| `apps/ade-cli/src/tuiClient/modelState.ts` | Pure model/setup state for draft chats and `/model`: GPT-5.6 Sol default plus Sol/Terra/Luna ordering, Chat vs CLI interface mode, Cursor chat-vs-CLI availability reconciliation, Codex preset/approval/sandbox mapping, provider-specific permission summaries, host-aware reasoning defaults/visible tiers, Fast Mode support, and the `SetupPaneRow` list rendered in setup panes. GPT-5.6 labels `low` as Light and `xhigh` as Extra High, exposes Max on all three models, and adds Ultra after Max on Sol/Terra. |
| `apps/ade-cli/src/tuiClient/modelPickerController.ts` | Small adapter between right-pane model-picker state and `modelPickerLayout.ts`: supplies active model/reasoning/interface, favorites/recents, AI status, footer focus, lane label, and provider refresh routing. |
| `apps/ade-cli/src/tuiClient/rightPaneFormatters.ts` | Pure formatters for right-pane result panes (PR summary / review / checks / comments, Linear status, system details). Keeps `app.tsx` free of ad-hoc rendering helpers. |
| `apps/ade-cli/src/tuiClient/format.ts` | Transcript rendering helpers for the TUI. `webSearchResultPreviewLines` / `webSearchResultDomain` turn Codex structured web-search `results` into compact `title — domain` lines with a `+N more` tail, shared by `renderChatLines` (subagent pane) and `ChatView` (work log). |
| `apps/ade-cli/src/tuiClient/displayWidth.ts` | Grapheme-aware terminal-cell helpers using `string-width`: code-unit ↔ display-cell mapping, display-cell slicing, truncation, wrapping, and selection splitting for Unicode-safe chat/model/right-pane rendering. |
| `apps/ade-cli/src/tuiClient/aggregate.ts` | Pure derivations on top of the chat event stream. Produces `AggregatedBlock`s (assistant text, connector-aware tool calls, files changed, web/image/plan/compaction groups, runtime-activity rows for subagent and activity envelopes, queued steers) and `derivePendingSteers`, consumed by `ChatView` and the right-pane steer view. MCP app/server identity replaces generic tool labels and image lifecycle updates collapse by item id. |
| `apps/ade-cli/src/tuiClient/bracketedPaste.ts` | Bracketed-paste parser/formatter for terminal-control mode and multi-line forwarded input. Normalizes pasted newlines and wraps multi-line user input in bracketed-paste markers before writing it into provider CLI PTYs. |
| `apps/ade-cli/src/tuiClient/closedCliSessions.ts` | Converts live or ended tracked CLI terminal sessions into chat-like summaries, retains the persisted settled/status/attention/failure fields, filters ended rows out of open chat lists, derives resumability/provider metadata, projects the scheduler-backed pause/jobs/next-wake state fetched by the Ink root, and maps user-initiated closes (0/130/143) to the neutral idle glyph instead of a failure state. |
| `apps/ade-cli/src/tuiClient/sessionLifecycle.ts` | ADE Code's half of the session-lifecycle surface: argument parsing for the `/session …` slash commands plus the text-only row markers the drawer and the right-pane chat list render. Everything semantic is imported, never re-derived — `isSessionSnoozed` / `isSessionFiledAsSnoozed` from `apps/desktop/src/shared/sessionCanonicalState.ts`, wake-label copy (`snoozeWakeLabel` → "wakes in 3h" / "wakes tomorrow" / "wakes when asked" / "wakes now") and woke-reason copy (`sessionWokeMarker` → "needs approval" / "errored" / "turn finished") from `apps/desktop/src/renderer/lib/sessionSnooze`, and duration grammar from `sessionSnoozeDuration.ts`. Snooze stays a visibility overlay: nothing in the module reads or writes a canonical phase. `resolveSnoozeChoices` / `resolveSnoozeChoice` / `resolveSnoozeFreeText` back the duration picker. `resolveSnoozeChoices(nowMs)` is a function rather than the module-level constant it replaced, and deliberately so: the shared `resolveSnoozePresets` suppresses "This evening" once 18:00 is within an hour or past, and a list derived once at import would freeze that decision at process start — a TUI launched at 2pm would still offer "This evening" at 11pm. |
| `apps/ade-cli/src/sessionSnoozeDuration.ts` | Snooze duration parsing shared by the `ade session snooze` planner in `cli.ts` and the TUI's `/session snooze`. Extracted rather than duplicated so there is exactly one answer to "what does `1.5h` mean" and exactly one cap (`MAX_SNOOZE_MS`, 30 days — beyond that it is almost certainly a typo, and no scheduler exists that could walk the deadline back). Grammar: an integer or one-decimal amount plus a unit suffix (`30m`, `1h`, `1.5h`, `4h`, `1d`, `1w`); a bare number reads as minutes. It returns a result union (`{ ok: true, ms }` \| `{ ok: false, code: "invalid" \| "too-short" \| "too-long", message }`) instead of throwing, so each surface dresses the failure in its own voice: `cli.ts` re-throws a `CliUsageError` with the flag-worded `message`, while the TUI switches on `code` to write terminal copy that never mentions a flag the user did not type. |
| `apps/ade-cli/src/tuiClient/adeApi.ts` | Typed wrappers over the runtime action domains used by the Ink root, including the session lifecycle calls `snoozeSession`, `wakeSession`, `setSessionSettleOverride`, and `clearSessionWokeMarker` (all mapping onto the `session` action domain) and the `TuiSessionLifecycleFields` type. `enrichChatSessionsWithLifecycle` / `enrichTerminalSessionsWithLifecycle` carry `settleOverride`, `snoozedUntil`, `snoozedAt`, `wokeAt`, and `wokeReason` onto enriched rows so the drawer and right pane render markers without a second read. Chat hydration requests a 1,000-event / 256 KiB recent window and exposes the append-stable `getChatEventHistoryPage` byte-cursor wrapper for older pages. Both history calls use the runtime's canonical single object envelope instead of positional options that one-argument runtime wrappers would discard. |
| `apps/ade-cli/src/tuiClient/olderHistory.ts` | Bounded transcript-window policy for ADE Code. It initially paints the newest 500 snapshot events, drains the contiguous local remainder before network paging, dedupes page seams, and keeps at most 60,000 resident events. At the cap, scrollback becomes a sliding window that retains the newly requested older side and marks the view detached; `End` rehydrates the authoritative recent tail and folds in buffered live events. The cursor stays retryable on `unavailable`, and the underfill/near-top policy triggers loading without requiring an extra scroll event. |
| `apps/ade-cli/src/tuiClient/drawerSelection.ts` | Pure selectors for the lane / chat drawer (active row, expanded groups, keyboard navigation). |
| `apps/ade-cli/src/tuiClient/drawerLayout.ts` | Single source of truth for drawer row layout: `computeDrawerLayout` (expanded chat block, closed-CLI group rows, and compact per-lane chat previews under a height budget) and `drawerMouseHitForLayout`, shared by the Drawer renderer and the app's mouse hit-testing so the two cannot drift. |
| `apps/ade-cli/src/tuiClient/newLaneForm.ts` | Pure model for the `/new lane` form: start-from modes (primary / child / import), Linear issue + setup-template fields, per-mode field lists, and `buildNewLaneSubmission` mapping form values onto `lane.create` / `lane.createChild` / `lane.importBranch` payloads. |
| `apps/ade-cli/src/tuiClient/eventDedup.ts` | Reserves and syncs chat-event dedupe keys so replayed runtime events do not render twice. |
| `apps/ade-cli/src/tuiClient/feedback.ts` | Builds the multi-field `/feedback` form. Validates required fields, packs the `FeedbackDraftInput` envelope, and adds project / lane / runtime context before submission. |
| `apps/ade-cli/src/tuiClient/heartbeat.ts` | Maintains the `startTuiHeartbeat` loop that tells the runtime the terminal client is still attached. |
| `apps/ade-cli/src/tuiClient/highlightCache.ts` | Pre-registers highlight.js languages (TypeScript, JavaScript, Python, Rust, Go, Swift, Bash, JSON, YAML, Markdown, XML, CSS, SQL) and caches token streams so chat code fences render once instead of being re-highlighted on every redraw. |
| `apps/ade-cli/src/tuiClient/imageTargets.ts` | Finds the latest openable Codex image result / viewed image target for terminal open actions, and materializes the clipboard image into a `cacheRoot` for paste (`readClipboardImageAttachment`, `clipboardScratchDir`). `cacheRoot` is where the bytes are written *locally* — the project workspace root for a local runtime, but a local scratch dir for a remote runtime (whose real workspace path lives on another machine). Every disk interaction is best-effort: a permission/IO failure yields `null` rather than throwing out of the React handler. |
| `apps/ade-cli/src/tuiClient/laneTree.ts` | Stack-graph ordering for the lane drawer (`sortLanesForStackGraph`). |
| `apps/ade-cli/src/tuiClient/project.ts` | Lane/chat launch resolution: `chooseInitialLane`, `chooseTuiLaunchLane`, and `resolveTuiChatRefreshTarget` (drawer chat browsing via `drawerBrowsingChatId` / `drawerBrowsingNewChat` previews a session in the centre pane before Enter commits it). |
| `apps/ade-cli/src/tuiClient/pendingInput.ts` | Derives pending tool approvals and answer prompts from the chat event stream. Also owns the pure multi-question selection state machine (`PendingQuestionSelectionState` + `create`/`ensure`/`move`/`set` helpers and `optionsForPendingQuestion`) that backs the AskUserQuestion-style approval UI: per-question selected-option index, active-question focus, provisional digit quick-select, accumulated answers, answered-count, and the resolved value for the active question (selected option → question `defaultAssumption`). Only the first question inherits the legacy request-level `options` fallback; later questions must carry their own. |
| `apps/ade-cli/src/tuiClient/planMode.ts` | Provider-agnostic plan-mode detector (`isPlanMode(modelState)`) plus `hasFirstUserMessage` event scan. Decides whether the composer should display the plan-mode badge and gate destructive tools. |
| `apps/ade-cli/src/tuiClient/spinTick.tsx` | Shared monotonic spinner tick provider (`SpinTickProvider`) so every animated glyph in the TUI ticks in lockstep. |
| `apps/ade-cli/src/tuiClient/chatInfo.ts` | Builds `ChatInfoSnapshot` for the right-pane Chat Info view (provider/model, lane, plan steps, Codex goal, context %, token summary, subagent roster, scheduled work, background work, next wake, streaming state). Consumes the same chat-event stream the TUI is already replaying; Codex goal display treats provider budget-limited states as active because ADE keeps goals unlimited. Schedule and background rows come from the shared `deriveScheduleItems` / `deriveBackgroundItems` split in `apps/desktop/src/shared/chatScheduledWork.ts`, and `isBackgroundShellCommand` filters historical command-shaped snapshots out of the subagent roster. Chat sessions receive state in `AgentChatSessionSummary`; when a tracked CLI terminal is selected, the Ink root fetches `chat.getScheduledWorkState` whether its process is live or ended, so Chat Info shows its pause state, jobs, and earliest armed fire too. The token summary shows cache reads as `✶` and, when present, Codex cache-write tokens as `✎` (`latestTokenStats` in `adeApi.ts` reads the `cacheWriteTokens` breakdown field 0.145 maps from `cacheWriteInputTokens`). |
| `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` | Runtime action registry used by desktop, iOS, ADE Code, and hosted-web controllers. Exposes the typed `chat.getCodexGoal`, `chat.setCodexGoal`, `chat.setCodexGoalStatus`, and `chat.clearCodexGoal` actions so clients can update Codex goals without injecting `/goal` prompt text into CLI-backed chats. Schedule create/list/cancel/pause capabilities are also advertised when the host supports them. Tracked provider CLI sessions launched from Work can schedule their own durable follow-up through `ade`; delivery waits for a visible provider composer boundary or resumes the ended CLI. ADE Code reads chat schedule state from session summaries and uses the direct `chat.getScheduledWorkState` ADE action for tracked CLI Chat Info. |
| `apps/ade-cli/src/tuiClient/subagentPane.ts` | Pure builders for the Chat Info pane's subagent roster: `buildSubagentPaneRows`, `subagentIndexForPaneLine`, `selectedSubagentSnapshot`, and `subagentPaneContentFromRightPane` (extracts a `SubagentPaneContent` from the `chat-info` right-pane state). `subagentSnapshotsFromEvents` reconstructs snapshots from `subagent_*` and teammate envelopes with sibling-aware parent-placeholder resolution. |
| `apps/ade-cli/src/tuiClient/workEventIds.ts` | Stable Work-tab identity helpers used by the TUI to thread `ade.work-*` event ids through the renderer without re-deriving them per frame. |
| `apps/ade-cli/src/tuiClient/state.ts` | Persists terminal-client state under `~/.ade/ade-code-state.json`: the last selected chat per lane (`lastChatByLane`), the most recently active lane (`lastLaneId`), and the last explicitly chosen draft Interface (`draftKind`, `chat` or `cli`). Entries are project-scoped with legacy global fallback, matching desktop's project-scoped Work view memory. Writes are serialized through a short lock file so multiple TUI instances do not corrupt the JSON state. |
| `apps/ade-cli/src/tuiClient/theme.ts` | Shared Ink color and status tokens. Mirrors the Claude Design wireframe terminal palette 1:1: surfaces, text levels, brand violets, status (`running`/`attention`/`idle`/`failed`/`primary`), executor brand colors (Claude/Codex/Cursor/OpenCode/Droid + Shell + Copilot), plus helper exports `laneStatusColor`, `agentStatusColor`, `agentStatusGlyph`, and per-provider `glyph` + `wordmark`. |
| `apps/ade-cli/src/tuiClient/types.ts` | `AdeCodeConnection`, `ProjectLaunchContext`, `RightPaneContent` (`empty`, `help`, `status`, `details`, `diff`, `chat-info`, `new-chat-setup`, `model-setup`, `form`, `lane-details` with git stats + PR CI fields + lane chat counts, …), `ChatInfoSnapshot`, `ChatInfoPlan`, `ChatInfoPlanStep`, `SubagentSnapshot`, `ChatScheduledWorkSnapshot`, plus navigation DTOs aligned with `apps/desktop/src/shared/types`. |
| `apps/ade-cli/src/tuiClient/components/` | `AdeWordmark`, `Drawer` (`visibleDrawerLaneCount` / `visibleDrawerChatCount`, `DrawerPrSummary` rows, lanes mode chat preview under the selected lane, closed tracked CLI session group), `ChatView` (transcript renderer; exports `renderChatVisibleSelectionRows` / `renderChatSelectableRowTexts` / `selectedTextFromChatRows` for the ADE-owned mouse selection, plus `computeChatScrollMaxOffset` and `renderChatTranscriptPlainText`), `Header`, `RightPane` (`computeLaneChatCounts` with active / needs-you / settled / closed / failed rollups, `LANE_DETAIL_PR_ACTION_INDEX`, wireframe `lane-details` STATUS/SETUP/CHANGES/ACTIONS/PR/CHATS sections, Chat Info `chat-info`, `model-setup`, masked `/secrets` list), `SlashPalette`, `MentionPalette`, `ApprovalPrompt`, `ModelStatus`, `FooterControls`, and `TerminalPane` (xterm-headless preview pane that consumes `ChatTerminalPreviewResult` from `ade.terminal.preview` plus live `ade.pty.data` chunks to render a real terminal grid inside Ink; running provider CLI terminals — Claude, Codex, Cursor, Droid, OpenCode — can be put into direct control mode from the TUI). |
| `apps/desktop/src/shared/externalSessionAffordances.ts` | Cross-client capability-to-action policy shared by desktop and ADE Code, including cwd-locked original-folder continuation and cross-lane Copy eligibility. |
| `apps/ade-cli/src/tuiClient/keybindings/index.ts` | Verbatim `~/.claude/keybindings.json` reader and TUI action dispatcher (chord support, vim namespace, clipboard-image paste hooks). Resolves `defaultKeybindingsPath()`, parses the Claude keybindings schema, and maps key sequences onto TUI actions. |
| `apps/ade-cli/src/tuiClient/statusline/index.ts` | Claude-compatible status line config reader and runner. Reads the `~/.claude/statusline.json` contract, executes the configured status command, and exposes the rendered lines to `ModelStatus`. |
| `apps/ade-cli/src/tuiClient/components/ModelPicker/` | Ink ModelPicker pane: `ModelPickerPane.tsx` (provider/category rail + search + model rows), `modelPickerLayout.ts` (pure derivations — imports `modelOrdering` and `modelPickerSearch` from the desktop package so behaviour stays in lockstep with the renderer), `modelPickerGeometry.ts` (shared painted-row / click hit-test geometry), and `types.ts` (`ModelPickerEntry`, `ModelPickerRailEntry`, `ModelPickerState`, plus `AdeCodeProvider` extensions for `ollama` / `lmstudio`). Reads the provider-grouped catalog via `getModelCatalog`, preserves runtime `serviceTiers` and Cursor `cursorAvailability` metadata for Fast Mode / chat-vs-CLI parity, keeps the provider rail stable even when a runtime is signed out or empty, and reads favorites / recents via the cross-surface `modelPicker.*` store. |
| `apps/ade-cli/src/services/modelPickerStore.ts` | Cross-surface (desktop + TUI + iOS) favorites and recents stored in the per-project `ade.db` tables `model_picker_favorites` and `model_picker_recents`, with `~/.ade/modelPicker.json` imported once as a legacy migration source. `MAX_RECENTS` caps the recents list in app code because the CRR tables are primary-key-only. Exposed through the top-level `modelPicker.getFavorites` / `setFavorites` / `toggleFavorite` / `getRecents` / `pushRecent` JSON-RPC methods on `adeRpcServer` and through matching iOS sync commands. |
| `apps/desktop/src/shared/types/chat.ts` | Canonical chat DTOs (`AgentChatEventEnvelope`, sessions, pending input, `AgentChatContextUsage`, `AgentChatClaudeOutputStyle`, `AgentChatClaudePlugin`, subagent kinds, scheduled-work/retraction events, `AgentChatModelCatalog*`). Imported per-module so ade-cli typecheck stays scoped. |
| `apps/desktop/src/shared/modelRegistry.ts` | Default model selection for new sessions (`getDefaultModelDescriptor`). |
| `apps/desktop/src/main/utils/codexComputerUse.ts`, `apps/desktop/src/shared/cliLaunch.ts` | Explicit-opt-in, OpenAI-signature-verified Computer Use MCP resolution plus the Codex CLI start/resume flags reused by attached and embedded ADE Code runtime actions. |
| `apps/desktop/src/shared/adeLayout.ts` | Resolves project-scoped `.ade` paths. |

## Modes

### Attached (default)

`ade code` opens a Unix-domain or named-pipe connection to the ADE runtime. Resolution order in `connectToAde`:

1. `--socket /path/to/sock` on the parent `ade` process (also reads `ADE_RPC_SOCKET_PATH`).
2. The machine socket from `resolveMachineAdeLayout()` (`~/.ade/sock/ade.sock` or `\\.\pipe\ade-runtime`).
3. If the machine socket is not listening, `connection.ts` calls `spawnDaemon(socketPath)` — a detached `ade serve --socket <socketPath>` — and retries up to 25 times with a 200 ms delay.
4. As a final fallback, the legacy project-scoped socket from `resolveAdeLayout(projectRoot)` if the user passed `--require-socket` and the machine socket is unavailable.

`ade code --print-state` exercises that whole path, prints the chosen mode and socket path, and exits. The interactive TUI does not strand users on a blank first connection failure: it renders the failure, offers `r` for immediate retry, and schedules an automatic reconnect.

### Embedded

`ade code --embedded` (or `ade --headless code`) skips the machine runtime and builds an `AdeRuntime` in-process via `loadEmbeddedAdeCli()`, which dynamic-imports `bootstrap` and `adeRpcServer` from the `ade-cli` package itself. Used for headless or development environments where `ade serve` is not present. This mode is single-project, single-process: closing the TUI tears the runtime down.

`forceEmbedded` and `requireSocket` are mutually exclusive — `connectToAde` rejects the combination.

### Account-wide Attention

`/attention` is a machine-global right-pane utility, not a view of the selected
lane or project. A signed-in TUI asks `attention.call/getSnapshot` for the
consolidated account stream. The runtime's account coordinator can read the
relay independently of the current project, while each item retains its owning
machine/project/session/PR destination. Enter opens that exact destination and
only then marks the loaded revision seen.

When signed out, ADE Code asks the connected host for
`getMachineSnapshot` and labels the result This machine only. A temporary
account failure may degrade to the same real host snapshot. A legacy host that
does not implement Attention remains connected in limited mode and shows an
Update `<host>` / restart-brain recovery message instead of an empty pane.
Account changes and stale source revisions reject the mutation until the pane
refreshes.

## Initialize handshake

Both modes run the same handshake before the TUI mounts:

```text
-> ade/initialize {
     protocolVersion: "2025-06-18",
     clientName: "ade-code",
     identity: { role: "cto", callerId: "ade-code:<pid>" }
   }
<- {
     runtimeInfo: {
       name: "ade-rpc",
       version: "<cli-version>",
       buildHash: "<sha256-or-null>",
       defaultRole: "cto",
       projectRoot: "/path/to/project",
       multiProject: true,
       pid: 12345
     },
     capabilities: {
       projects: true,
       actions: { listChanged: false }
     }
   }
-> ade/initialized
```

`identity.role` remains compatibility metadata; the runtime's trusted
role comes from `ADE_DEFAULT_ROLE` and the rest of the ADE context env.
Direct headless CLI sets that env role from `--role` (defaulting to
`cto`). `ade code` injects `cto` only for an embedded runtime or a
freshly spawned runtime when no valid explicit role exists. Socket
clients then read `runtimeInfo.buildHash`, `runtimeInfo.defaultRole`,
`runtimeInfo.projectRoot`, and `runtimeInfo.pid` to detect stale local
runtime processes via `attachedRuntimeMismatchReason`; a mismatch raises
`StaleAdeSocketError`, optionally shuts the stale runtime down, and
falls through to `spawnDaemon`. `capabilities.actions.listChanged` is
currently `false`, so the action list is static after initialization
and there is no `ade/actions/list_changed` notification stream.

If the response advertises `runtimeInfo.multiProject === true` or `capabilities.projects === true`, `connection.ts` calls `projects.add { rootPath: <project-root> }`, captures the returned `projectId`, and from then on every project-scoped request is rewritten to include `projectId`. The runtime-scoped methods (the set in `MULTI_PROJECT_RUNTIME_METHODS`: `ade/initialize`, `projects.*`, `ping`, `runtime/info`, etc.) pass through unchanged.

For the embedded runtime there is no `projects.add` step — the in-process runtime is already bound to one project root.

## TUI surface

`apps/ade-cli/src/tuiClient/app.tsx` is the Ink root. Layout:

- **Header** — project name, active lane, branch, the terminal client frame, and the shared machine account state. ADE Code reads account status once while the TUI surface is active; it does not add a poll loop. `ade login` remains the canonical sign-in command.
- **Drawer** (toggled with the configured shortcut) — two modes, **lanes** (default) and **chats**, switched with `Tab` while the drawer is focused. Lane cards show name + status (no branch ref — that lives in lane details). Every lane shows its chats: the selected lane expands the full chat block (the same tight single-row chats every lane shows, distinguished only by a violet border plus a trailing `+ new chat` row — there is no `CHATS` header), while every other lane renders a compact always-visible preview (the lane's chats as single rows, plus a `+N more` tail only when the row budget can't fit them all) whose rows are clickable and select lane + chat in one step. The TUI enriches both chat and tracked-CLI rows from `session.list`: explicit asks render the blocking question in amber, status notes render inline (`done: …` when settled), and a sanitized last-output preview is the first fallback before summary or goal. Settled rows dim into the quiet glyph tier, and last-turn failures render as failures. Snooze is a second, independent quiet tier: a snoozed row carries a text-only `z` marker plus its wake label ("wakes in 3h" / "wakes tomorrow" / "wakes when asked" / "wakes now"), and a row that woke early carries a `*` marker naming the reason ("needs approval" / "errored" / "turn finished") until it is visited, at which point the marker is cleared. Because snooze is a visibility overlay rather than a phase, a snoozed row that is blocking on the user stays in its normal place — `isSessionFiledAsSnoozed` yields to a `needs_you` phase — while `isSessionSnoozed` remains the raw column read used for row chrome. Ended tracked CLI sessions are hidden behind a `closed (N)` row in the expanded lane; expanding it shows dim one-line rows with provider glyph, title, and relative end time, and `↵` resumes a resumable closed CLI session through the same terminal resume path as desktop. Continuation forwards the stored model, reasoning, Fast Mode, permission mode, and exact Codex approval/sandbox/config controls through the shared launch-field mapper. Row layout and mouse hit-testing share one pure model (`drawerLayout.ts: computeDrawerLayout` / `drawerMouseHitForLayout`) so open chats, closed toggles, closed sessions, and `+ new chat` cannot drift. In **lanes** mode, `↑`/`↓` move lane cards; `↓` on an available lane enters **chats** mode for that lane; `↵` opens lane details or resumes the lane's last chat. In **chats** mode, `↑`/`↓` move within the lane's chat rows, closed group, and `+ new chat`; highlighting a chat previews it in the centre pane via `resolveTuiChatRefreshTarget` before `↵` commits the session. `Esc` returns from the chat list to **lanes**. Lane and chat selection drive the right pane's context.
- **ChatView** — the main transcript. Renders user, assistant, file-change, and system events from `chat/event` notifications while normalized tool telemetry stays behind the active activity/status row or the completed turn's `Ran for` row. Codex and most providers label the live row `model working`; Claude keeps its existing provider-specific live presentation and adds only a compact actions disclosure when tools are available. Expanding either status reveals one line per tool (`✓ read apps/x.ts`) with the desktop slug + target-arg derivation (pure helpers imported from `apps/desktop/.../chatTranscriptRows` and `toolPresentation`); MCP events prefer the app/plugin/server name plus action instead of a generic `mcp` label, and expanded `web_search` actions include the first provider action query/title/URL when available plus up to three Codex structured `title — domain` previews with a `+N more` tail. Generated/viewed-image lifecycle updates still collapse to one concise notice per item, and provider-specific narration, reasoning, subagent/activity cards, and notices remain in their existing positions. File-change groups remain chronological, collapse to one summary row, and expand to typed file rows whose `diff` action opens the turn diff in the right pane. Every row truncates to the pane width (rows never wrap — the scroll math assumes 1 row = 1 line). Codex app-server runtime events (`codex_safety_buffering`, `codex_moderation_metadata`, `codex_sleep`, `codex_thread_deleted`, `codex_turn_stalled`) render as concise transcript notices instead of disappearing into generic activity. A valid ` ```mosaic ` fence (the interactive card the desktop transcript renders — see [chat composer-and-ui.md](../chat/composer-and-ui.md)) collapses to a single dim summary line here via `summarizeMosaicCard` from `apps/desktop/src/shared/chatMosaic.ts`, since the TUI cannot render the interactive form; a fence that fails to parse falls back to the plain code block. The most recent expandable failure id is tracked so `Enter` can drill into it. Mouse selection is ADE-owned so it can follow virtual transcript rows: drag selects, edge-drag scrolls, wheel scrolling preserves the highlighted range, Shift-click extends the current anchor, and `Ctrl+C` / delivered `Cmd+C` copy selected chat text. Near the top, both scroll and underfilled viewports silently request more history; the stable first row reads `↑ older messages`, changes in place to `↑ loading earlier…`, and exposes `Ctrl+R` only after all automatic retries fail. Paging continues beyond the 60,000-event resident ceiling by sliding the window toward the transcript head; live events are buffered while detached, and `End` restores the latest bounded tail.
- **Composer** — multi-line input with mention completion (`@…`) sourced from `MentionPalette` and slash command completion from `SlashPalette`. Both triggers are detected cursor-relatively through the shared `apps/desktop/src/shared/composerTriggers.ts` module (`detectComposerTrigger`), so a `/command` or `@file` token is recognized anywhere in the draft — not just at position 0 (`fix @src/foo.ts then run /test`). Both palettes stay visible with a no-match row while the user is actively typing. Selecting a suggestion splices exactly the trigger span (`replaceComposerTriggerSpan`) rather than replacing the whole prompt; a lone leading `/command` keeps the legacy fill-the-prompt behavior. `Tab` completes the highlighted slash command, and for a **mid-sentence** slash trigger `Enter` completes into the draft (instead of submitting/running), mirroring the desktop command menu — a leading-only command still runs on `Enter`. Confirmed tokens render as colored chips in the prompt rows via `findConfirmedComposerTokens` + `segmentPromptLineText`: inserted `@file` mentions and `/command` names matching the built-in or runtime catalog paint cyan (files) or violet (commands) and bold, while unmatched `@`/`/` text stays plain. URLs detected by shared `smartLinks.ts` also paint violet and add a compact `links [provider label]` row above the raw prompt; GitHub, Linear, ADE, and generic web labels are deterministic and do not require metadata fetching in the terminal. Character Backspace/Delete removes the whole intersected URL, while the canonical URL remains the submitted prompt text. Mention completion publishes local lane/chat hits immediately, then debounces remote file/git/PR RPCs; file results are cached per lane+query and git/PR results are cached per lane for the open TUI session. Pending tool approvals surface as `ApprovalPrompt`. AskUserQuestion-style answer requests (one or more questions, each with options) render every question inline with its option list and an `N of M answered` header. While such a request is pending and the composer is empty, keyboard input drives the picker instead of the prompt: `↑`/`↓` move the selected option (or move between questions when the active question has no options), `←`/`→` switch the active question, `1`-`9` within the option count highlights that option without submitting, and `Enter` submits the active question's current selection (advancing to the next unanswered question, or finalizing the whole request once every question is answered). If the next printable input after a digit quick-select is text, that digit becomes the start of a free-text answer and the previous option highlight is restored; digits above the option count type directly into the composer. Clicking an option still submits it immediately. The deny chip still declines the whole request. Selection lives in `pendingInput.ts`'s `PendingQuestionSelectionState`.
- **RightPane** — context-sensitive drawer for slash command output. The "right" placement commands (see below) render their results here as forms, lists, diffs, help text, or rendered objects. `/secrets` opens a masked project-secret list and copies the selected secret value to the local system clipboard with `Enter` or `c`; it never reveals values inline and only uses the read actions behind the existing project-secret RPC path. When a chat is active the default content is the **Chat Info** view (`kind: "chat-info"`): provider/model header, lane label, streaming/idle indicator with context-percent + token summary, plan steps for the current turn (plus the provider's plan explanation / streaming text when present), Codex `/goal` block when present, a roster of subagents (running first, then teammates and background), and — below the roster, like the Droid Missions block — **TASKS** (latest `todo_update` snapshot, desktop ChatTasksPanel parity), **SCHEDULE** (Claude wakeups/cron/`/loop` from `scheduled_work_update` via `deriveScheduleItems`, desktop Chat Info parity, plus `⏰ next wake <duration>` from the active session summary), **BACKGROUND** (`background_task` work from `scheduled_work_update` via `deriveBackgroundItems`, each rendered as a `$ <label>` line through `backgroundCommandLabel`), and **PR** (the lane's PR state + checks rollup with `/pr` hand-off hints, desktop ChatPrPane parity). The next-wake line is omitted when the timestamp is missing, invalid, paused, or already past. PR rows refresh from runtime PR update notifications when available and still keep the 30s poll as a fallback. Codex goal state comes from the shared chat event stream and is normalized so provider token budgets do not show as ADE-side limits. Selecting a subagent row with `↵` first probes for a usable subagent transcript; if one is available the centre transcript swaps to it, otherwise the local reconstruction stays visible with a notice. `Esc` returns to the main chat. For an active lane with no chat focus, the default switches to the wireframe **`lane-details`** view: **STATUS** (clean/dirty, ahead/behind), optional **SETUP** (lane setup progress or retryable failure; press `r` on a failed setup to retry), **CHANGES** (file list + staged/unstaged counts from `diff.listLaneDiffStats`), **ACTIONS** (lane shortcuts — `new chat`, `open / create PR`, `stage all`, `move unstaged to new lane`, `commit`, `push`, `diff`, `reparent`, `delete lane`; each row carries a semantic glyph color so additive actions are green, navigational actions are violet, the rescue-unstaged action is amber, and `delete lane` is red), optional **PR #N** (state chip, CI activity via `checksPending` / `checksFailed`, `↵` opens the PR URL when the PR row is selected), and **CHATS** (active / needs you / settled / closed / failed counts from `computeLaneChatCounts`). A `worktreeAvailable` guard surfaces a recoverable warning when the lane worktree path is missing from disk. `/model` opens a separate **`model-setup`** pane for provider/model/reasoning/permission picks before the first prompt.
- **External session browser** — a RightPane flow backed by
  `external-sessions.list` / `external-sessions.import` for Claude, Codex,
  Cursor, Droid, and OpenCode. It uses the same shared Continue/Copy policy as
  desktop. An already-imported row opens its persisted ADE chat/terminal on
  Enter (or `o`) and keeps only Copy alternatives, so the original is not
  resumed twice. Import results install the returned persisted summary before
  refresh and open the session under its actual lane.
- **FooterControls** — two-row footer. The top row (mode bar, only present when there's content) shows provider glyph + label, model display, fast-mode badge, reasoning effort, permission summary, pending steer count, a compact context-usage dial, and the cached token summary. Completed compaction boundaries clear pre-compaction usage for all five SDK providers; Claude post-compaction tokens and Codex live thread usage can refill it immediately, while per-turn counters from the compacted turn are ignored. The bottom row shows pane toggles (`^o` lanes, `^p` pane, `^a` chat info) and pane-specific hints (drawer mode lanes/chats, details navigation, chat scroll position, `/steer` reminder when steers are queued). The `⊚ chat info` chip shows the live subagent count when greater than zero. `footerControlsForAvailability(agentsAvailable)` decides which toggles are wired.
- **Provider CLI terminal control** — when the active session is a
  running provider CLI terminal (Claude, Codex, Cursor, Droid, or
  OpenCode), `Ctrl+T` moves keyboard input from ADE into that terminal.
  `TerminalPane` switches from preview mode to a bordered control frame,
  stops hiding the CLI's bottom input rows, and the footer shows
  `<PROVIDER> CONTROL` (e.g. `CODEX CONTROL`) with `^t` to return to
  ADE and `^]` as the escape chord. Raw terminal input strips only
  those control bytes before forwarding the rest to the PTY. `/model` and
  `/effort` write directly into a running terminal only for Claude; other
  providers rely on `pty.sendToSession` for continuation.
- **Ctrl+C semantics** — when a chat turn is streaming or active, `Ctrl+C`
  cancels the turn through `cancelChatTurn`. Otherwise it arms a
  ~1.5 s "press again to exit" window so a stray Ctrl+C does not kill
  the TUI on the first hit; the prompt is surfaced as an info notice.
  When the chat has an active text selection, Ctrl+C (and Cmd+C on
  macOS) copies the selection through `writeClipboardText` instead.

The lane-details CHATS rollup assigns every row to one bucket in precedence
order: awaiting-input or explicit-attention rows are **needs you**; a settled
row that is no longer active is **settled**; `lastTurnFailedAt` rows are
**failed**; active or idle rows are **active**; remaining blocked completions
are **failed**; and every other terminal state is **closed**.

Heartbeats are kept alive with `startTuiHeartbeat` so the runtime knows the chat client is still attached. Normal exits and heartbeat-triggered terminal shutdowns restore mouse tracking, alternate scroll, and the alternate screen before sending terminal signals.

## Slash commands

`commands.ts` exports the built-in slash command catalog. `placement` decides whether the command runs inline in the chat or opens the right pane. The TUI also discovers project command files, Codex prompts, and Agent Skill roots before a chat exists, then refreshes against server-provided `AgentChatSlashCommand`s from the active runtime via `getSlashCommands`. Provider/runtime commands win over same-named built-ins except for local terminal controls such as `/login`, `/quit`, and `/clear`.

Inline (acts immediately in the TUI):

| Command | Effect |
| --- | --- |
| `/commit [message]` | Commit lane changes through `git.commit`. |
| `/push` | Push the active lane branch. |
| `/pull [--ff-only\|--rebase\|--merge]` | Pull the active lane branch; default is fast-forward-only. |
| `/undo` | Undo the last recorded HEAD change on the active lane branch. |
| `/redo` | Redo the most recently undone HEAD change on the active lane. |
| `/stage all` | Stage all changes in the active lane. |
| `/clear` | Clear the local TUI transcript view. |
| `/login` | Sign in to the active CLI-backed provider from this terminal; after a successful login, the TUI restores the most recent auth-failed prompt for resend. |
| `/open` | Hand the current ADE context off to desktop via `app/navigate`. |
| `/quit` | Exit `ade code`. |
| `/steer cancel` | Remove the latest staged steer message from the local queue. |
| `/steer edit <text>` | Edit the latest staged steer message. |
| `/steer send` | Claude only: deliver the latest staged steer inline into the active turn (SDK `dispatchSteer mode: "inline"`). |
| `/steer interrupt` | Claude only: interrupt the active turn and run the latest staged steer next (`dispatchSteer mode: "interrupt"`). |

Right pane (open contextual content):

| Command | Pane |
| --- | --- |
| `/steer` | Show staged steer messages and their delivery state. |
| `/new lane` | Lane creation form (desktop CreateLaneDialog parity): start-from modes for primary base branch / child lane / import branch, color picker, optional Linear issue attachment, optional setup template id, and post-create setup progress with retryable failure. Backed by `newLaneForm.ts` and the `lane.create` / `lane.createChild` / `lane.importBranch` actions. |
| `/new chat [title]` | New chat in the active lane. |
| `/rename [title]`, `/chat rename [title]` | Rename the active chat. |
| `/chat archive` | Archive the active chat. |
| `/chat unarchive <chat-id\|title>` | Unarchive a chat by id or title. |
| `/chat archived [filter]` | List archived chats. |
| `/chat delete` | Delete the active chat after confirmation. |
| `/chat ask <question>` | Escalate a blocking question from the active chat or tracked CLI session; creates the loud `Needs you` state. |
| `/chat note [note]` | Update the active session's Work status line; omit the note to clear it. |
| `/chat settle [outcome]` | Mark the active session settled; if it is awaiting input or explicitly requesting attention, dismiss that pending input in the same backend transaction. An outcome becomes the `done:` status line. `ade code` is a *user* surface (it connects at cto role), which is why it keeps settle even though the agent-facing `ade chat settle` was removed in 2026-07. |
| `/chat unsettle` | Remove the active session's settled state. |
| `/session snooze [session-id] [30m\|1h\|4h\|1d]` | Snooze a session out of the attention list until a deadline. Omitting the duration opens the choice list; free text goes through the shared duration grammar (`30m`, `1h`, `1.5h`, `1d`, `1w`; a bare number means minutes), capped at 30 days. |
| `/session wake [session-id]` | Wake a snoozed session back into the attention list. |
| `/session settle [session-id] [outcome]` | Mark a session settled, declaring the settle at the override tier. |
| `/session unsettle [session-id]` | Clear a session's declared settle plus any `settled` pin. |
| `/session keep-active [session-id]` | Write the `active` settle-override pin, holding the row in the active list even if something later declares a settle on it (e.g. the PR-merge policy). Note that nothing *derives* a settle: a clean CLI exit leaves the row `ended`, never `settled`. |
| `/attention` | Open account-wide Attention in the right pane. Signed-out or degraded mode is labeled as connected-machine-only; `Enter` opens the exact destination and `R` refreshes. |
| `/tag <tag\|clear>` | Tag the active Claude chat (Claude only). |
| `/output-style [style]` | List or select the active Claude output style (Claude only). |
| `/plugin [reload\|native args]` | List, reload, or manage Claude plugins (Claude only). |
| `/status` | Project, lane, and runtime state summary. |
| `/context` | Show chat context usage. |
| `/agents` | List Claude agents from user/project config (Claude only). |
| `/info` | Open Chat Info for the active chat: plan, goal, tasks, schedule, PR rollup, and subagents. |
| `/skills` | List Agent Skills from project, user, inherited, and bundled ADE roots. |
| `/secrets` | List project secret names with masked values; `Enter` or `c` copies the selected value to the local system clipboard without revealing it. |
| `/init` | Generate AGENTS.md and Claude pointer files (Claude only). |
| `/diff` | Active lane diff (file list with summarized hunks). |
| `/log` | Recent commits. |
| `/reparent <parent-lane-id\|parent-name> [stack-base-ref]` | Move the active lane under another lane. |
| `/lane rename [name]` | Rename the active lane. |
| `/lane archive` | Archive the active lane. |
| `/lane unarchive <lane-id\|name>` | Unarchive a lane by id or name. |
| `/lane archived` | List archived lanes. |
| `/lane delete` | Open a right-pane confirmation form for deleting the active lane. |
| `/pr` | Open PR details with summary and checks. |
| `/pr open` | Create or open a PR for the active lane; new PR forms default to `source lane -> target lane` and submit normal PRs (`draft: false`). |
| `/pr review` | Show PR reviews. |
| `/pr comments` | Show actionable PR comments. |
| `/pr comment <text>` | Comment on the active PR. |
| `/pr approve [note]` | Approve the active PR. |
| `/pr request-changes <text>` | Request changes on the active PR. |
| `/pr land [confirm] [merge\|squash\|rebase] [bypass]` | Merge the active PR after confirmation. |
| `/pr update-branch [merge\|rebase]` | Update the PR branch with its base. |
| `/pr checks` | Show PR checks. |
| `/linear …` (`list`, `workflows`, `run`, `route`, `sync`, `ingress`, `pull`, `comment`, `comments`, `status`, `assign`, `label`, `set-state`, `issue`, `attach`, `detach`, `issues`, `create-from`) | Linear sub-router; backed by `linearCommands.ts`. `attach` / `detach` / `issues` operate on the active chat session by default, or on a `--lane`; issue write verbs bridge through `linear_issue_tracker`. |
| `/feedback` | Multi-field feedback form wired to `feedback.submit` via the `feedback.ts` form builder. |
| `/chats [filter]` | List chats in the active lane, with ended tracked CLI sessions behind a `closed (N)` toggle. Selecting a closed CLI session resumes it when resumable. |
| `/switch [lane\|chat]` | Switch lane or chat. |
| `/help` | Keymap and command help. |
| `/keybindings [open]` | Show Claude-compatible keybinding config diagnostics. Pass `open` to launch the configured editor on `~/.claude/keybindings.json`. |
| `/statusline` | Show Claude-compatible status line config. |
| `/doctor` | Show ADE Code and Claude-compat diagnostics. |
| `/model` | Open the unified model / reasoning / permission picker. |
| `/effort` | Open a focused reasoning-effort-only picker for the active provider. |
| `/system` | System and runtime details. |
| `/ade <domain.action\|command> [json]` | Run an allowlisted ADE action or force a TUI command; shows result in RightPane. |

Inline chat commands (forwarded through the active chat runtime):

| Command | Effect |
| --- | --- |
| `/compact [instructions]` | Compact the active Claude or Codex context window. |
| `/usage` | Show Claude usage / rate-limit window through the active SDK session. |
| `/insights` | Generate Claude session insights through the active SDK session. |
| `/fast [on\|off]` | Toggle Claude fast mode through the active SDK session. |
| `/goal [<objective>\|clear\|status active\|paused\|complete]` | Set, clear, or inspect the active Claude/Codex chat goal. Token-budget management is intentionally not exposed — when a Codex thread reports `budget_limited`, ADE auto-clears the runtime budget and the goal banner stays in the active state. |

Claude-only commands only appear in the slash palette when the active chat's provider is `claude`. The palette filters built-in entries by their `providers` whitelist so a Codex / OpenCode / Cursor chat does not show parity affordances that have no backing call. `/skills` and `/secrets` are deliberately provider-agnostic because they use ADE project data instead of provider runtime commands.

Several slash commands forward to a desktop route when issued from `ade code`:

```text
/app-control          -> /app-control
/browser              -> /browser
/computer             -> /proof
/computer-use         -> /proof
/ios, /ios-sim        -> /ios-sim
/pencil               -> /pencil
/proof                -> /proof
```

`navigateDesktop` posts an `app/navigate` request to the same runtime, which the multi-window desktop shell uses to open or focus the appropriate window. The TUI does not host these surfaces itself; it points the desktop at them.

## Project / lane resolution

Lane resolution at launch goes through helpers in `tuiClient/project.ts`:

1. `chooseInitialLane(lanes, context)` — context-only pick: `--lane` hint, then the lane whose worktree contains the current `workspaceRoot`, then the primary/first lane, falling back to "no lane".
2. `chooseTuiLaunchLane(lanes, context, lastLaneId)` — the actual TUI entry point. If the context lane is explicit (a `--lane` hint, or the user invoked `ade code` from inside a non-primary lane's worktree / attached root), that wins. Otherwise the persisted `AdeCodeState.lastLaneId` from `~/.ade/` wins so reopening the TUI returns to the previously focused lane. Falls back to the context choice when there is no persisted lane.
3. `resolveTuiChatRefreshTarget(...)` — while the drawer is open in **chats** mode, `drawerBrowsingChatId` can preview a highlighted session in the centre pane (without committing it) until the user presses `↵`.

Lane selection persists `lastLaneId` and updates the runtime's session state so the same lane is reflected in desktop and iOS clients attached to the same runtime. New-chat Interface memory (`draftKind: "chat" | "cli"`) is persisted in the same TUI state file, project-scoped the same way as desktop's Work view state.

## Launch

```bash
ade code                                 # attached to the machine runtime for the current project
ade code --print-state                   # smoke-test: print mode + socket and exit
ade code --embedded                      # in-process runtime fallback
ade code remote --target mac --project ADE
                                         # attach to a saved paired or SSH target/project
ade code remote --target mac --route tailscale
                                         # require the paired Tailscale path for this launch
ade code remote session --target mac --project ADE --session chat-1
                                         # open a specific remote chat or provider CLI terminal session
ade login                                # sign in to the optional shared machine account
ade machines list --text                # list available, unreachable, and offline machines
ade machines connect <machine-key> --project ADE
                                         # pair if needed, then open ADE Code
ade machines hop <device-id> --session chat-1
                                         # connect alias with a stable selector and session hint
ade code remote --list-targets           # list saved desktop remote machines
ade code remote --target mac --list-projects
                                         # list projects registered on that remote runtime
ade code remote session --target mac --project ADE --list-sessions
                                         # list launchable remote chats/provider CLI terminals
ade --project-root /repo code            # bind to a different project
ade --socket /tmp/ade-runtime-dev.sock code
                                         # attach to a specific socket (dev runtime, peer machine, etc.)
```

`ade code remote` is a launcher around the same TUI. It reads saved desktop
remote targets and uses the target's declared transport. Paired targets use the
ordinary paired-secret plus pinned-DPoP sync runtime bridge. SSH targets probe
stable/beta/alpha ADE homes, start `ade rpc --stdio`, and hand that stdio stream
to `remoteBridge.ts`. Both transports expose a local one-connection JSON-RPC
endpoint (temporary Unix socket on POSIX, loopback `tcp://` on Windows), then
invoke the normal `runAdeCodeCli` with `--remote`, `--remote-label`,
`--require-socket`, remote project roots, and the selected `--lane` /
`--session` hints. Interactive launches always show the saved-machine chooser,
even when only one target exists, so the selected host is never implicit.
Non-interactive launches may still auto-select a single saved target and require
`--target` when several exist.

Paired connections try LAN → Tailscale → ADE Relay by default and print the
winning path before the TUI starts. `--route lan|tailscale|relay` pins a launch
to one route class and fails explicitly when that class is unavailable; it
never silently changes to SSH. The launcher closes its discovery connection,
opens and verifies the long-lived paired transport, and only then starts the
TUI bridge. The first TUI socket consumes that verified transport instead of
redialing during handoff, which prevents a transient “connected” screen followed
by a broken local bridge. If the connection later drops, the bridge stays
available for the TUI retry and redials the saved paired paths, reporting when
the winning path changes. Remote startup errors name the machine and path class
without exposing the temporary local socket path.

Account authentication is used only for a new pairing over an exact allowlisted
WSS relay; the returned paired credentials are persisted and subsequent LAN,
tailnet, and relay connections use the ordinary paired path. Account-created
targets have no SSH routes and fail closed. Explicit address, pairing-code,
local, and existing SSH behavior is unchanged. A legacy account machine that
desktop saved as an uncredentialed SSH target is upgraded to the same paired
record before launch; if it cannot be verified, is offline, or pairing fails,
the CLI fails closed instead of retrying SSH. For a true SSH target, route
overrides retain the saved host alias so OpenSSH still applies `Host`-scoped
credentials and proxy configuration. All route/runtime attempts share one
cancellable total deadline and return aggregated diagnostics. Remote launches
skip local project-root and build-hash compatibility checks because the
authoritative runtime and filesystem are on the target machine.

After local changes, run `npm run build` inside `apps/ade-cli` so both `dist/cli.cjs` and `dist/tuiClient/cli.mjs` exist for packaged and linked use. The CLI build verifier imports `dist/tuiClient/cli.mjs` from an isolated temp directory, checks that bundled `__dirname` / `__filename` references have ESM shims, and confirms `runAdeCodeCli(["--help"])` prints the ADE Code help banner without relying on repo-local `node_modules`. During repo development, `npm run dev:code` runs the source TUI in the terminal against the shared dev runtime at `/tmp/ade-runtime-dev.sock`; `npm run dev:code:web` mirrors that same process in the browser (see [Browser mirror](#browser-mirror-development)).

## Claude Code 2.1.x parity

`ade code` ships verbatim compatibility with the Claude Code 2.1.x terminal contracts so users coming from Claude Code keep their existing config and muscle memory:

- **Keybindings.** `tuiClient/keybindings/index.ts` reads `~/.claude/keybindings.json` (resolved through `defaultKeybindingsPath()`, with `CLAUDE_HOME` and `XDG_CONFIG_HOME` overrides). The full Claude schema is honored — chord sequences, modifier syntax, and the `vim` namespace — and dispatched onto TUI actions through `dispatchKeybinding()`. `/keybindings` surfaces a diagnostics view; `openKeybindingsFile()` opens the config in the user's editor.
- **Status line.** `tuiClient/statusline/index.ts` reads `~/.claude/statusline.json`, executes the configured command, and feeds the rendered lines into `ModelStatus`. `/statusline` shows the contract and the most recent stdout/stderr. When a status command produces output, the status panel hides the default token/context meter for the same row.
- **Vim namespace.** When vim mode is active, the model-status row exposes the current `insert`/`normal` mode tag and the keybindings dispatcher routes `vim.*` actions.
- **Clipboard image paste.** Cross-platform clipboard-image paste is wired into the composer (Linux via `xclip`/`wl-paste`, macOS via `pngpaste`/AppleScript, Windows via PowerShell), so pasting a screenshot uploads it as a Claude attachment alongside text. The clipboard always lives on the machine running the TUI, so the routing depends on where the runtime is: for a **local** runtime the image is materialized under the project workspace (`.ade/cache/...`) and attached by path. For a **remote** runtime the workspace path lives on another machine, so writing there locally would fail (EACCES) and the agent couldn't read it — instead the image is materialized into a local scratch dir and its bytes are uploaded to the runtime via the `chat/saveTempAttachment` action (`saveRuntimeTempAttachment`, mirroring the desktop composer), which returns a runtime-valid path that is then mentioned. The local scratch temp is cleaned up after upload; a pre-existing user file the clipboard merely *referenced* is uploaded but never deleted.
- **Permission modes.** The Claude picker accepts `auto` (mapped onto the SDK `permissionMode: "auto"`) in addition to `default`, `plan`, `acceptEdits`, and `bypassPermissions`. The Droid picker cycles the same ordered modes as desktop, including `agi` after the `auto-*` levels.
- **Chat Info (subagent panel).** The right pane's Chat Info view replaces the legacy Subagents tab strip. It puts the main agent in row 0 and the live subagent / teammate / background roster in rows 1..N, all selectable with `↑`/`↓`; `↵` probes for a usable subagent transcript and only swaps the main transcript when that fetch succeeds, otherwise the local reconstruction remains visible with a notice. Snapshots are still keyed by `agentId + parentToolUseId` and reconstructed from `subagent_*` envelopes (plus `teammate.idle` / `task.completed` for teammates) through `subagentSnapshotsFromEvents()`. Sibling subagents that share a parent tool-use id are tracked separately by counting resolved subagent ids per parent and only adopting the placeholder parent row when exactly one resolves under it. Each snapshot carries `parentToolUseId`, `turnId`, `startedAt`, `endedAt`, and a derived `durationMs` so rows show elapsed time even when the runtime did not report `usage.durationMs`. Below the roster, Chat Info also renders the latest task snapshot and a schedule block from `deriveScheduledWorkSnapshots()`; the block adds the active chat's `nextWakeAt` as a compact alarm countdown so an armed durable schedule is visible even before its first event row is replayed. `todo_update` and `scheduled_work_update` events can auto-open the pane the same way new subagent activity does, without taking composer focus. The `^a` footer toggle opens or closes the Chat Info pane.
- **Context, output styles, plugins.** `/context`, `/output-style`, and `/plugin` call `chat.getContextUsage`, `chat.listClaudeOutputStyles` / `chat.setClaudeOutputStyle`, and `chat.listClaudePlugins` / `chat.reloadClaudePlugins` against the same Claude SDK runtime the desktop chat uses.

## Chat setup

- `+ new chat` opens a draft setup view (`new-chat-setup`) in the right pane; it does not create a backend chat until the first prompt is sent from the middle composer.
- The draft setup and `/model` panes carry an **Interface: Chat | CLI** row (immediately after Provider), matching the desktop/iOS Chat/CLI switcher. **Chat** creates an SDK chat via `chat.createSession` (all providers, including Claude); **CLI** starts a tracked provider CLI terminal via the `start_cli_session` action (Claude, Codex, Cursor, Droid, or OpenCode). New drafts default to the last explicitly selected Interface for the project, persisted in `~/.ade/ade-code-state.json` with legacy fallback; programmatic draft resets do not overwrite it. The row is editable while the chat is a draft and becomes read-only once a session exists (its value then reflects the session type). First-prompt submit branches on it: draft `CLI` starts a tracked terminal; otherwise an SDK chat is created. Ollama / LM Studio have no CLI and stay Chat-only.
- `/model` opens the model setup view (`model-setup`) in the right pane. It can switch provider, model, reasoning, Fast Mode for fast-capable descriptors, and permission settings, refresh provider readiness through `ai.getStatus`, and open desktop Settings > AI Providers for full configuration. Cursor rows come from the same provider-grouped catalog as desktop, including `cursorAvailability`, so SDK chat models and Cursor CLI launch models stay separated consistently — and the picker gates Cursor availability on the selected Interface (Chat disables CLI-only Cursor models and vice versa).
- The Codex/OpenAI list always begins GPT-5.6 Sol, Terra, Luna; Sol is the new-chat default and GPT-5.5 remains below the family. Sol/Terra expose Light, Medium, High, Extra High, Max, Ultra; Luna exposes Light, Medium, High, Extra High, Max. ADE Code uses each descriptor/host row's `defaultReasoningEffort` (`low` for Sol, `medium` for Terra/Luna) and preserves host-advertised effort ordering.
- On macOS, both Chat and CLI Codex drafts inherit the same direct Computer Use integration as desktop. If the bundled plugin or canonical MCP server is explicitly enabled in Codex config and the standalone OpenAI client passes strict signature checks, native chats receive it on app-server thread start/resume and CLI launches receive `mcp_servers.computer_use` overrides. Disabled/unverified/missing clients add no flags. MCP app consent still appears as pending input; Full Auto does not bypass it.
- `/login` delegates only to provider CLIs that can authenticate in the current terminal: Claude (`claude auth login`), Codex (`codex login`), and OpenCode (`opencode auth login`). After a successful login for the active provider, an auth-failed latest prompt is restored into the composer with a "logged in — press Enter to resend" notice. Cursor chat is `@cursor/sdk` and needs `CURSOR_API_KEY` or desktop Settings > AI Providers. Droid chat runs Factory Droid over ACP and needs `FACTORY_API_KEY` or Factory's interactive `droid` login.
- The middle composer shows the selected provider, model, reasoning, and permission mode under the prompt so draft changes on the right are visible before the chat starts.

## Deeplinks (`ade open` / `ade link` / `ade linear install`)

`ade code` exposes the ADE deeplink contract at three points:

- **`Ctrl+Y`** over a highlighted lane or PR row in the drawer / right pane copies the canonical `ade://` URL to the system clipboard via `buildDeeplinkForRow` (`deeplinkRow.ts`). A toast confirms the copy or explains why the focused row can't be linked (e.g. no PR is attached to a chat preview).
- **`ade open <url>`** invokes the OS opener on a validated `ade://` or `https://ade-app.dev/open?...` URL, which routes back to the running desktop process (or starts it cold). The `--linear-issue <id> --branch <branch>` variant is what Linear's "Open issue in coding tool" entry passes; the desktop opens the Linear pane to that issue or shows the Linear setup state for the active project.
- **`ade link …`** builds and clipboard-copies a deeplink for a lane / work session / branch / PR / Linear issue. `--ade` emits the custom scheme, the default is the HTTPS form. `ade link <url>` round-trips a parsed URL into the chosen form.
- **`ade linear install`** writes `~/.linear/coding-tools.json` so Linear's "Open issue in coding tool" dropdown can launch `ade open --linear-issue ... --branch ...` directly.

See [features/deeplinks/README.md](../deeplinks/README.md) for the full URL grammar, parser semantics, and the desktop / iOS / web sides of the protocol.

## Related docs

- [ADE CLI](../../../apps/ade-cli/README.md) — ADE runtime, install paths, service manager, full CLI surface.
- [Chat feature](../chat/README.md) — in-app Work chat architecture (service + renderer); same agent chat backend.
- [Remote runtime](../remote-runtime/README.md) — how the same ADE runtime is reached over SSH.
- [Deeplinks](../deeplinks/README.md) — `ade://` and `https://ade-app.dev/open` URL grammar shared across desktop, ADE Code, iOS, and the marketing site.
- [System overview](../../ARCHITECTURE.md) — CLI / terminal client placement in the system diagram.
