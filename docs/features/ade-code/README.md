# ADE Code (terminal Work chat)

`ade code` is a terminal-native client for the same **Work** agent chat surface the Electron app exposes in `AgentChatPane`. It targets agents and operators who prefer a shell-first workflow: Ink + React render the TUI, while chat transcripts, slash commands, lane navigation, model picks, and ADE actions all flow through the same JSON-RPC contracts the desktop uses.

It is a client. The runtime, lanes, chats, transcripts, PRs, processes, and proof artifacts live in the per-machine ADE runtime (`ade serve`). `ade code` attaches to that runtime, drives a single project scope, and renders incoming events.

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
| `apps/ade-cli/src/tuiClient/cli.tsx` | TUI entry: argv parsing, project discovery, connection bootstrap, Ink mount. Built to `apps/ade-cli/dist/tuiClient/cli.mjs`. |
| `apps/ade-cli/src/tuiClient/app.tsx` | Primary Ink/React surface: navigation, composer, drawers, right pane, session lifecycle, slash command dispatch. Owns the `Ctrl+Y` "copy ADE deeplink" handler which resolves the focused lane / PR row through `buildDeeplinkForRow` and copies the canonical `ade://...` URL to the system clipboard. Also backs `/skills` by listing Agent Skill roots from project, user, inherited, and bundled ADE locations, independent of the active provider. |
| `apps/ade-cli/src/tuiClient/deeplinkRow.ts` | Pure helper used by the `Ctrl+Y` keybinding. Maps the focused lane or PR row (including parsing a GitHub PR URL when the right pane only carries the URL) onto a `DeeplinkTarget` and returns the built `ade://` URL. Tested in `tuiClient/__tests__/deeplinkKeybind.test.ts`. |
| `apps/ade-cli/src/commands/deeplinks.ts` | `ade open`, `ade link`, and `ade linear install` subcommands. Shares the parser + builder with the desktop main process so URLs round-trip across both surfaces. See [features/deeplinks/README.md](../deeplinks/README.md). |
| `apps/ade-cli/src/tuiClient/connection.ts` | Resolves attached vs embedded mode, runs the `ade/initialize` handshake, registers the project with `projects.add`, wraps subsequent requests with `projectId`. Computes the expected SHA-256 build hash from the resolved CLI entrypoint and compares it against the runtime's reported `runtimeInfo.buildHash` / `defaultRole` / `projectRoot`; a mismatch throws `StaleAdeSocketError`, optionally shuts the stale runtime process down, and lets `spawnDaemon` start a compatible one (with `ADE_DEFAULT_ROLE=cto` in the spawned env). `initializeEmbeddedCto` injects a trusted `cto` role only when `ADE_DEFAULT_ROLE` is not already set to a valid value. |
| `apps/ade-cli/src/runtimeRoles.ts` | `ADE_RUNTIME_ROLES` (`cto`, `orchestrator`, `agent`, `external`, `evaluator`), `normalizeAdeRuntimeRole`, and `resolveAdeDefaultRole`. Shared by `cli.ts`, `adeRpcServer.ts`, `multiProjectRpcServer.ts`, and `tuiClient/connection.ts` so role parsing stays consistent across surfaces. |
| `apps/ade-cli/src/tuiClient/jsonRpcClient.ts` | Socket client: connect, request/response, `chat/event` notifications. |
| `apps/ade-cli/src/tuiClient/commands.ts` / `linearCommands.ts` | Slash command catalog and routing. `commands.ts` ships `/lane delete` (right-pane confirmation form that destroys the active lane), `/effort` (reasoning-effort-only picker, a narrower companion to `/model`), and provider-agnostic `/skills` for Agent Skill discovery. `linearCommands.ts` requires a sub-command — bare `/linear` returns the usage hint instead of silently picking `workflows`. It also routes the session/lane attachment verbs (`attach` / `detach` / `issues` → `lane` domain session-scoped or lane-scoped actions) and the issue write-bridge verbs (`comment` / `set-state` / `assign` / `label` → `linear_issue_tracker` domain), reusing `--issue-id` / `--linear-issue-json` / attachment flags (`source`, `includeInPr`, `closeOnMerge`, `role`) parsing shared with the typed `ade linear` CLI commands in `cli.ts`. |
| `apps/ade-cli/src/tuiClient/rightPaneFormatters.ts` | Pure formatters for right-pane result panes (PR summary / review / checks / comments, Linear status, system details). Keeps `app.tsx` free of ad-hoc rendering helpers. |
| `apps/ade-cli/src/tuiClient/format.ts` | Transcript rendering helpers for the TUI. |
| `apps/ade-cli/src/tuiClient/aggregate.ts` | Pure derivations on top of the chat event stream. Produces `AggregatedBlock`s (assistant text, tool-calls / files-changed / plan / compaction groups, runtime-activity rows for subagent and activity envelopes, queued steers) and `derivePendingSteers`, consumed by `ChatView` and the right-pane steer view. |
| `apps/ade-cli/src/tuiClient/drawerSelection.ts` | Pure selectors for the lane / chat drawer (active row, expanded groups, keyboard navigation). |
| `apps/ade-cli/src/tuiClient/drawerLayout.ts` | Single source of truth for drawer row layout: `computeDrawerLayout` (expanded chat block + compact per-lane chat previews under a height budget) and `drawerMouseHitForLayout`, shared by the Drawer renderer and the app's mouse hit-testing so the two cannot drift. |
| `apps/ade-cli/src/tuiClient/newLaneForm.ts` | Pure model for the `/new lane` form: start-from modes (primary / child / import), runtime placement toggle, per-mode field lists, and `buildNewLaneSubmission` mapping form values onto `lane.create` / `lane.createChild` / `lane.importBranch` payloads. |
| `apps/ade-cli/src/tuiClient/eventDedup.ts` | Reserves and syncs chat-event dedupe keys so replayed runtime events do not render twice. |
| `apps/ade-cli/src/tuiClient/feedback.ts` | Builds the multi-field `/feedback` form. Validates required fields, packs the `FeedbackDraftInput` envelope, and adds project / lane / runtime context before submission. |
| `apps/ade-cli/src/tuiClient/heartbeat.ts` | Maintains the `startTuiHeartbeat` loop that tells the runtime the terminal client is still attached. |
| `apps/ade-cli/src/tuiClient/highlightCache.ts` | Pre-registers highlight.js languages (TypeScript, JavaScript, Python, Rust, Go, Swift, Bash, JSON, YAML, Markdown, XML, CSS, SQL) and caches token streams so chat code fences render once instead of being re-highlighted on every redraw. |
| `apps/ade-cli/src/tuiClient/imageTargets.ts` | Finds the latest openable Codex image result / viewed image target for terminal open actions, and materializes the clipboard image into a `cacheRoot` for paste (`readClipboardImageAttachment`, `clipboardScratchDir`). `cacheRoot` is where the bytes are written *locally* — the project workspace root for a local runtime, but a local scratch dir for a remote runtime (whose real workspace path lives on another machine). Every disk interaction is best-effort: a permission/IO failure yields `null` rather than throwing out of the React handler. |
| `apps/ade-cli/src/tuiClient/laneTree.ts` | Stack-graph ordering for the lane drawer (`sortLanesForStackGraph`). |
| `apps/ade-cli/src/tuiClient/project.ts` | Lane/chat launch resolution: `chooseInitialLane`, `chooseTuiLaunchLane`, and `resolveTuiChatRefreshTarget` (drawer chat browsing via `drawerBrowsingChatId` / `drawerBrowsingNewChat` previews a session in the centre pane before Enter commits it). |
| `apps/ade-cli/src/tuiClient/pendingInput.ts` | Derives pending tool approvals and answer prompts from the chat event stream. Also owns the pure multi-question selection state machine (`PendingQuestionSelectionState` + `create`/`ensure`/`move`/`set` helpers and `optionsForPendingQuestion`) that backs the AskUserQuestion-style approval UI: per-question selected-option index, active-question focus, accumulated answers, answered-count, and the resolved value for the active question (selected option → question `defaultAssumption`). Only the first question inherits the legacy request-level `options` fallback; later questions must carry their own. |
| `apps/ade-cli/src/tuiClient/planMode.ts` | Provider-agnostic plan-mode detector (`isPlanMode(modelState)`) plus `hasFirstUserMessage` event scan. Decides whether the composer should display the plan-mode badge and gate destructive tools. |
| `apps/ade-cli/src/tuiClient/spinTick.tsx` | Shared monotonic spinner tick provider (`SpinTickProvider`) so every animated glyph in the TUI ticks in lockstep. |
| `apps/ade-cli/src/tuiClient/chatInfo.ts` | Builds `ChatInfoSnapshot` for the right-pane Chat Info view (provider/model, lane, plan steps, Codex goal, context %, token summary, subagent roster, streaming state). Consumes the same chat-event stream the TUI is already replaying; Codex goal display treats provider budget-limited states as active because ADE keeps goals unlimited. |
| `apps/ade-cli/src/services/sync/syncRemoteCommandService.ts` | Runtime action registry used by desktop, iOS, and ADE Code attached clients. Exposes the typed `chat.getCodexGoal`, `chat.setCodexGoal`, `chat.setCodexGoalStatus`, and `chat.clearCodexGoal` actions so clients can update Codex goals without injecting `/goal` prompt text into CLI-backed chats. |
| `apps/ade-cli/src/tuiClient/subagentPane.ts` | Pure builders for the Chat Info pane's subagent roster: `buildSubagentPaneRows`, `subagentIndexForPaneLine`, `selectedSubagentSnapshot`, and `subagentPaneContentFromRightPane` (extracts a `SubagentPaneContent` from the `chat-info` right-pane state). `subagentSnapshotsFromEvents` reconstructs snapshots from `subagent_*` and teammate envelopes with sibling-aware parent-placeholder resolution. |
| `apps/ade-cli/src/tuiClient/workEventIds.ts` | Stable Work-tab identity helpers used by the TUI to thread `ade.work-*` event ids through the renderer without re-deriving them per frame. |
| `apps/ade-cli/src/tuiClient/state.ts` | Persists terminal-client state under `~/.ade/`: the last selected chat per lane (`lastChatByLane`) plus the most recently active lane (`lastLaneId`), used to restore lane focus across launches. |
| `apps/ade-cli/src/tuiClient/theme.ts` | Shared Ink color and status tokens. Mirrors the Claude Design wireframe terminal palette 1:1: surfaces, text levels, brand violets, status (`running`/`attention`/`idle`/`failed`/`primary`), executor brand colors (Claude/Codex/Cursor/OpenCode/Droid + Shell + Copilot), plus helper exports `laneStatusColor`, `agentStatusColor`, `agentStatusGlyph`, and per-provider `glyph` + `wordmark`. |
| `apps/ade-cli/src/tuiClient/types.ts` | `AdeCodeConnection`, `ProjectLaunchContext`, `RightPaneContent` (`empty`, `help`, `status`, `details`, `diff`, `chat-info`, `new-chat-setup`, `model-setup`, `form`, `lane-details` with git stats + PR CI fields + lane chat counts, …), `ChatInfoSnapshot`, `ChatInfoPlan`, `ChatInfoPlanStep`, `SubagentSnapshot`, plus navigation DTOs aligned with `apps/desktop/src/shared/types`. |
| `apps/ade-cli/src/tuiClient/components/` | `AdeWordmark`, `Drawer` (`visibleDrawerLaneCount` / `visibleDrawerChatCount`, `DrawerPrSummary` rows, lanes mode chat preview under the selected lane), `ChatView` (transcript renderer; exports `renderChatVisibleSelectionRows` / `renderChatSelectableRowTexts` / `selectedTextFromChatRows` for the ADE-owned mouse selection, plus `computeChatScrollMaxOffset` and `renderChatTranscriptPlainText`), `Header`, `RightPane` (`computeLaneChatCounts`, `LANE_DETAIL_PR_ACTION_INDEX`, wireframe `lane-details` STATUS/CHANGES/ACTIONS/PR/CHATS sections, Chat Info `chat-info`, `model-setup`), `SlashPalette`, `MentionPalette`, `ApprovalPrompt`, `ModelStatus`, `FooterControls`, and `TerminalPane` (xterm-headless preview pane that consumes `ChatTerminalPreviewResult` from `ade.terminal.preview` plus live `ade.pty.data` chunks to render a real terminal grid inside Ink; running Claude terminals can be put into direct control mode from the TUI). |
| `apps/ade-cli/src/tuiClient/keybindings/index.ts` | Verbatim `~/.claude/keybindings.json` reader and TUI action dispatcher (chord support, vim namespace, clipboard-image paste hooks). Resolves `defaultKeybindingsPath()`, parses the Claude keybindings schema, and maps key sequences onto TUI actions. |
| `apps/ade-cli/src/tuiClient/statusline/index.ts` | Claude-compatible status line config reader and runner. Reads the `~/.claude/statusline.json` contract, executes the configured status command, and exposes the rendered lines to `ModelStatus`. |
| `apps/ade-cli/src/tuiClient/components/ModelPicker/` | Ink ModelPicker pane: `ModelPickerPane.tsx` (provider/category rail + search + model rows), `modelPickerLayout.ts` (pure derivations — imports `modelOrdering` and `modelPickerSearch` from the desktop package so behaviour stays in lockstep with the renderer), `modelPickerGeometry.ts` (shared painted-row / click hit-test geometry), and `types.ts` (`ModelPickerEntry`, `ModelPickerRailEntry`, `ModelPickerState`, plus `AdeCodeProvider` extensions for `ollama` / `lmstudio`). Reads the provider-grouped catalog via `getModelCatalog`, preserves runtime `serviceTiers` and Cursor `cursorAvailability` metadata for Fast Mode / chat-vs-CLI parity, keeps the provider rail stable even when a runtime is signed out or empty, and reads favorites / recents via the cross-surface `modelPicker.*` store. |
| `apps/ade-cli/src/services/modelPickerStore.ts` | Cross-surface (desktop + TUI + iOS) favorites and recents stored in the per-project `ade.db` tables `model_picker_favorites` and `model_picker_recents`, with `~/.ade/modelPicker.json` imported once as a legacy migration source. `MAX_RECENTS` caps the recents list in app code because the CRR tables are primary-key-only. Exposed through the top-level `modelPicker.getFavorites` / `setFavorites` / `toggleFavorite` / `getRecents` / `pushRecent` JSON-RPC methods on `adeRpcServer` and through matching iOS sync commands. |
| `apps/desktop/src/shared/types/chat.ts` | Canonical chat DTOs (`AgentChatEventEnvelope`, sessions, pending input, `AgentChatContextUsage`, `AgentChatClaudeOutputStyle`, `AgentChatClaudePlugin`, subagent kinds, `AgentChatModelCatalog*`). Imported per-module so ade-cli typecheck stays scoped. |
| `apps/desktop/src/shared/modelRegistry.ts` | Default model selection for new sessions (`getDefaultModelDescriptor`). |
| `apps/desktop/src/shared/adeLayout.ts` | Resolves project-scoped `.ade` paths. |

## Modes

### Attached (default)

`ade code` opens a Unix-domain or named-pipe connection to the ADE runtime. Resolution order in `connectToAde`:

1. `--socket /path/to/sock` on the parent `ade` process (also reads `ADE_RPC_SOCKET_PATH`).
2. The machine socket from `resolveMachineAdeLayout()` (`~/.ade/sock/ade.sock` or `\\.\pipe\ade-runtime`).
3. If the machine socket is not listening, `connection.ts` calls `spawnDaemon(socketPath)` — a detached `ade serve --socket <socketPath>` — and retries up to 25 times with a 200 ms delay.
4. As a final fallback, the legacy project-scoped socket from `resolveAdeLayout(projectRoot)` if the user passed `--require-socket` and the machine socket is unavailable.

`ade code --print-state` exercises that whole path, prints the chosen mode and socket path, and exits.

### Embedded

`ade code --embedded` (or `ade --headless code`) skips the machine runtime and builds an `AdeRuntime` in-process via `loadEmbeddedAdeCli()`, which dynamic-imports `bootstrap` and `adeRpcServer` from the `ade-cli` package itself. Used for headless or development environments where `ade serve` is not present. This mode is single-project, single-process: closing the TUI tears the runtime down.

`forceEmbedded` and `requireSocket` are mutually exclusive — `connectToAde` rejects the combination.

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

- **Header** — project name, active lane, branch, and the terminal client frame.
- **Drawer** (toggled with the configured shortcut) — two modes, **lanes** (default) and **chats**, switched with `Tab` while the drawer is focused. Lane cards show name + status (no branch ref — that lives in lane details). Every lane shows its chats: the selected lane expands the full chat block (header + `+ new chat`), while every other lane renders a compact always-visible preview (up to 3 single-row chats plus a `+N more` tail, budget permitting) whose rows are clickable and select lane + chat in one step. Row layout and mouse hit-testing share one pure model (`drawerLayout.ts: computeDrawerLayout` / `drawerMouseHitForLayout`) so the two cannot drift. In **lanes** mode, `↑`/`↓` move lane cards; `↓` on an available lane enters **chats** mode for that lane; `↵` opens lane details or resumes the lane's last chat. In **chats** mode, `↑`/`↓` move chat rows and `+ new chat`; highlighting a chat previews it in the centre pane via `resolveTuiChatRefreshTarget` before `↵` commits the session. `↑` at the top of the chat list returns to **lanes**; `↓` past the last chat drops to the next lane card. Lane and chat selection drive the right pane's context.
- **ChatView** — the main transcript. Renders user, assistant, tool, and system events from `chat/event` notifications. For the non-Claude runtimes the transcript mirrors the desktop work log: each tool call is one stacked line (`✓ read apps/x.ts`) with the desktop slug + target-arg derivation (pure helpers imported from `apps/desktop/.../chatTranscriptRows` and `toolPresentation`), `web_search` events group with tool calls, reasoning renders as a collapsed `Thinking…`/`Thought` row with a one-line preview, and every row truncates to the pane width (rows never wrap — the scroll math assumes 1 row = 1 line). The most recent expandable failure id is tracked so `Enter` can drill into it. Mouse selection is ADE-owned so it can follow virtual transcript rows: drag selects, edge-drag scrolls, wheel scrolling preserves the highlighted range, Shift-click extends the current anchor, and `Ctrl+C` / delivered `Cmd+C` copy selected chat text.
- **Composer** — multi-line input with mention completion (`@…`) sourced from `MentionPalette` and slash command completion from `SlashPalette`. Pending tool approvals surface as `ApprovalPrompt`. AskUserQuestion-style answer requests (one or more questions, each with options) render every question inline with its option list and an `N of M answered` header. While such a request is pending and the composer is empty, keyboard input drives the picker instead of the prompt: `↑`/`↓` move the selected option (or move between questions when the active question has no options), `←`/`→` switch the active question, `1`-`9` select that option and submit it immediately, `Enter` submits the active question's current selection (advancing to the next unanswered question, or finalizing the whole request once every question is answered), and typing any text falls back to a custom free-text answer. Clicking an option submits it too. The deny chip still declines the whole request. Selection lives in `pendingInput.ts`'s `PendingQuestionSelectionState`; the old single-question `1`-`6` numeric quick-select is replaced by this flow.
- **RightPane** — context-sensitive drawer for slash command output. The "right" placement commands (see below) render their results here as forms, lists, diffs, help text, or rendered objects. When a chat is active the default content is the **Chat Info** view (`kind: "chat-info"`): provider/model header, lane label, streaming/idle indicator with context-percent + token summary, plan steps for the current turn (plus the provider's plan explanation / streaming text when present), Codex `/goal` block when present, a roster of subagents (running first, then teammates and background), and — below the roster, like the Droid Missions block — a **TASKS** section (latest `todo_update` snapshot, desktop ChatTasksPanel parity) and a **PR** section (the lane's PR state + checks rollup with `/pr` hand-off hints, desktop ChatPrPane parity). Codex goal state comes from the shared chat event stream and is normalized so provider token budgets do not show as ADE-side limits. Selecting a subagent row with `↵` swaps the centre transcript to that agent's view via `buildSubagentTranscriptEvents`; `Esc` returns to the main chat. For an active lane with no chat focus, the default switches to the wireframe **`lane-details`** view: **STATUS** (clean/dirty, ahead/behind), **CHANGES** (file list + staged/unstaged counts from `diff.listLaneDiffStats`), **ACTIONS** (lane shortcuts — `new chat`, `open / create PR`, `stage all`, `move unstaged to new lane`, `commit`, `push`, `diff`, `reparent`, `delete lane`; each row carries a semantic glyph color so additive actions are green, navigational actions are violet, the rescue-unstaged action is amber, and `delete lane` is red), optional **PR #N** (state chip, CI activity via `checksPending` / `checksFailed`, `↵` opens the PR URL when the PR row is selected), and **CHATS** (active / closed / killed counts from `computeLaneChatCounts`). A `worktreeAvailable` guard surfaces a recoverable warning when the lane worktree path is missing from disk. `/model` opens a separate **`model-setup`** pane for provider/model/reasoning/permission picks before the first prompt.
- **FooterControls** — two-row footer. The top row (mode bar, only present when there's content) shows provider glyph + label, model display, fast-mode badge, reasoning effort, permission summary, pending steer count, a 10-cell token usage bar (`TokenBar`) that recolors at 50 / 80 / 95 %, and the cached context-percent / token summary. The bottom row shows pane toggles (`^o` lanes, `^p` pane, `^a` chat info) and pane-specific hints (drawer mode lanes/chats, details navigation, chat scroll position, `/steer` reminder when steers are queued). The `⊚ chat info` chip shows the live subagent count when greater than zero. `footerControlsForAvailability(agentsAvailable)` decides which toggles are wired.
- **Claude terminal control** — when the active session is a running
  Claude terminal, `Ctrl+T` moves keyboard input from ADE into that
  terminal. `TerminalPane` switches from preview mode to a bordered
  control frame, stops hiding Claude's bottom input rows, and the footer
  shows `CLAUDE CONTROL` with `Ctrl+T` to return to ADE and `Ctrl+]`
  as the escape chord. Raw terminal input strips only those control
  bytes before forwarding the rest to the PTY.
- **Ctrl+C semantics** — when a chat turn is streaming or active, `Ctrl+C`
  cancels the turn through `cancelChatTurn`. Otherwise it arms a
  ~1.5 s "press again to exit" window so a stray Ctrl+C does not kill
  the TUI on the first hit; the prompt is surfaced as an info notice.
  When the chat has an active text selection, Ctrl+C (and Cmd+C on
  macOS) copies the selection through `writeClipboardText` instead.

Heartbeats are kept alive with `startTuiHeartbeat` so the runtime knows the chat client is still attached.

## Slash commands

`commands.ts` exports the built-in slash command catalog. `placement` decides whether the command runs inline in the chat or opens the right pane. The TUI also discovers project command files, Codex prompts, and Agent Skill roots before a chat exists, then refreshes against server-provided `AgentChatSlashCommand`s from the active runtime via `getSlashCommands`. Provider/runtime commands win over same-named built-ins except for local terminal controls such as `/login`, `/quit`, and `/clear`.

Inline (acts on chat or shell):

| Command | Effect |
| --- | --- |
| `/commit [message]` | Commit lane changes through `git.commit`. |
| `/push` | Push the active lane branch. |
| `/clear` | Clear the local TUI transcript view. |
| `/open` | Hand the current ADE context off to desktop via `app/navigate`. |
| `/quit` | Exit `ade code`. |
| `/steer cancel` | Remove the latest staged steer message from the local queue. |
| `/steer edit <text>` | Edit the latest staged steer message. |
| `/steer send` | Claude only: deliver the latest staged steer inline into the active turn (SDK `dispatchSteer mode: "inline"`). |
| `/steer interrupt` | Claude only: interrupt the active turn and run the latest staged steer next (`dispatchSteer mode: "interrupt"`). |

Right pane (open the contextual drawer):

| Command | Pane |
| --- | --- |
| `/steer` | Show staged steer messages and their delivery state. |
| `/new lane` | Lane creation form (desktop CreateLaneDialog parity): "Start from" mode chips — primary base branch / child of a lane / import an existing branch — swap the visible fields, plus a local-mac / mac-vm runtime toggle. Backed by `newLaneForm.ts` and the `lane.create` / `lane.createChild` / `lane.importBranch` actions. |
| `/new chat [title]` | New chat in the active lane. |
| `/rename [title]` | Rename the active chat. |
| `/tag <tag\|clear>` | Tag the active Claude chat (Claude only). |
| `/output-style [style]` | List or select the active Claude output style (Claude only). |
| `/plugin [reload\|native args]` | List, reload, or manage Claude plugins (Claude only). |
| `/agents` | List Claude agents from user/project config (Claude only). |
| `/info` | Open the Chat Info pane for the active chat (plan, Codex goal, subagents). |
| `/skills` | List Agent Skills from project, user, inherited, and bundled ADE roots. |
| `/context` | Show Claude context usage breakdown (Claude only). |
| `/init` | Generate AGENTS.md and Claude pointer files (Claude only). |
| `/status` | Project, lane, runtime state summary. |
| `/diff` | Active lane diff (file list with summarized hunks). |
| `/log` | Recent commits. |
| `/pr`, `/pr open`, `/pr review`, `/pr checks` | PR detail pane (bare `/pr` combines the summary with live checks), create/open PR, reviews, checks. |
| `/linear …` (`list`, `workflows`, `run`, `route`, `sync`, `ingress`, `pull`, `comment`, `status`, `assign`, `label`, `set-state`, `issue`, `attach`, `detach`, `issues`, `create-from`) | Linear sub-router; backed by `linearCommands.ts`. `attach` / `detach` / `issues` operate on the active chat session by default (session-scoped attachment via the `lane` domain's `attachLinearIssueToSession` / `detachLinearIssueFromSession` / `listLinearIssuesForSession`), or on a `--lane` (`linkLinearIssues` / `unlinkLinearIssues`); `comment` / `set-state` / `assign` / `label` write to the issue through the `linear_issue_tracker` domain over the daemon bridge. |
| `/chats` | Sessions in the active lane. |
| `/switch [lane\|chat]` | Switcher palette. |
| `/help` | Keymap and command help. |
| `/lane delete` | Open a right-pane confirmation form for deleting the active lane (shows lane name, branch ref, and dirty state; force toggle exposed when the lane has uncommitted changes). |
| `/keybindings [open]` | Show Claude-compatible keybinding config diagnostics. Pass `open` to launch the configured editor on `~/.claude/keybindings.json`. |
| `/statusline` | Show Claude-compatible status line config. |
| `/doctor` | Show ADE Code and Claude-compat diagnostics. |
| `/feedback` | Multi-field feedback form (category / summary / details / expected / actual / environment / additional context) wired to `feedback.submit` via the `feedback.ts` form builder. |
| `/model` | Open the unified model / reasoning / permission picker (right pane `model-picker` view, with rail + fuzzy search). |
| `/effort` | Open a focused reasoning-effort-only picker for the active provider (skips the model rail when only the effort needs to change). For Claude terminal sessions, the picker writes the effort directly into the running Claude transcript via `submitClaudePromptToTerminal` so the change applies without restarting the chat. |
| `/system` | System and runtime details. |
| `/ade <domain.action> [json]` | Run an allowlisted ADE action; shows result in RightPane. |

Inline chat commands (run through the active Claude SDK session, Claude only):

| Command | Effect |
| --- | --- |
| `/compact [instructions]` | Compact the Claude context window through the active SDK session. |
| `/usage` | Show Claude usage / rate-limit window through the active SDK session. |
| `/insights` | Generate Claude session insights through the active SDK session. |
| `/fast [on\|off]` | Toggle Claude fast mode through the active SDK session. |
| `/goal [<objective>\|clear\|pause\|resume]` | Set, pause, resume, or clear the chat goal. Token-budget management is intentionally not exposed — when a Codex thread reports `budget_limited`, ADE auto-clears the runtime budget and the goal banner stays in the active state. |

Claude-only commands only appear in the slash palette when the active chat's provider is `claude`. The palette filters built-in entries by their `providers` whitelist so a Codex / OpenCode / Cursor chat does not show parity affordances that have no backing call. `/skills` is deliberately provider-agnostic because it only reads markdown package roots and does not call a provider runtime.

Several slash commands forward to a desktop route when issued from `ade code`:

```text
/app-control          -> /app-control
/browser              -> /browser
/computer             -> /proof
/computer-use         -> /proof
/ios, /ios-sim        -> /ios-sim
/macos-vm             -> /vm
/pencil               -> /pencil
/proof                -> /proof
```

`navigateDesktop` posts an `app/navigate` request to the same runtime, which the multi-window desktop shell uses to open or focus the appropriate window. The TUI does not host these surfaces itself; it points the desktop at them.

## Project / lane resolution

Lane resolution at launch goes through helpers in `tuiClient/project.ts`:

1. `chooseInitialLane(lanes, context)` — context-only pick: `--lane` hint, then the lane whose worktree contains the current `workspaceRoot`, then the primary/first lane, falling back to "no lane".
2. `chooseTuiLaunchLane(lanes, context, lastLaneId)` — the actual TUI entry point. If the context lane is explicit (a `--lane` hint, or the user invoked `ade code` from inside a non-primary lane's worktree / attached root), that wins. Otherwise the persisted `AdeCodeState.lastLaneId` from `~/.ade/` wins so reopening the TUI returns to the previously focused lane. Falls back to the context choice when there is no persisted lane.
3. `resolveTuiChatRefreshTarget(...)` — while the drawer is open in **chats** mode, `drawerBrowsingChatId` can preview a highlighted session in the centre pane (without committing it) until the user presses `↵`.

Lane selection persists `lastLaneId` and updates the runtime's session state so the same lane is reflected in desktop and iOS clients attached to the same runtime.

## Launch

```bash
ade code                                 # attached to the machine runtime for the current project
ade code --print-state                   # smoke-test: print mode + socket and exit
ade code --embedded                      # in-process runtime fallback
ade code remote --target mac --project ADE
                                         # attach through SSH to a saved desktop remote target/project
ade code remote session --target mac --project ADE --session chat-1
                                         # open a specific remote chat or Claude terminal session
ade code remote --list-targets           # list saved desktop remote machines
ade code remote --target mac --list-projects
                                         # list projects registered on that remote runtime
ade code remote session --target mac --project ADE --list-sessions
                                         # list launchable remote chats/Claude terminals
ade --project-root /repo code            # bind to a different project
ade --socket /tmp/ade-runtime-dev.sock code
                                         # attach to a specific socket (dev runtime, peer machine, etc.)
```

`ade code remote` is a launcher around the same TUI. It reads saved desktop
remote targets, probes stable/beta/alpha ADE homes over SSH, starts
`ade rpc --stdio` on the selected machine, exposes that stdio stream as a local
loopback `tcp://` JSON-RPC socket, and then invokes the normal `runAdeCodeCli`
with `--remote`, `--remote-label`, `--require-socket`, remote project roots,
and the selected `--lane` / `--session` hints. Remote launches skip local
project-root and build-hash compatibility checks because the authoritative
runtime and filesystem are on the target machine.

After local changes, run `npm run build` inside `apps/ade-cli` so both `dist/cli.cjs` and `dist/tuiClient/cli.mjs` exist for packaged and linked use. The CLI build verifier imports `dist/tuiClient/cli.mjs` from an isolated temp directory, checks that bundled `__dirname` / `__filename` references have ESM shims, and confirms `runAdeCodeCli(["--help"])` prints the ADE Code help banner without relying on repo-local `node_modules`. During repo development, `npm run dev:code` runs the source TUI in the terminal against the shared dev runtime at `/tmp/ade-runtime-dev.sock`; `npm run dev:code:web` mirrors that same process in the browser (see [Browser mirror](#browser-mirror-development)).

## Claude Code 2.1.x parity

`ade code` ships verbatim compatibility with the Claude Code 2.1.x terminal contracts so users coming from Claude Code keep their existing config and muscle memory:

- **Keybindings.** `tuiClient/keybindings/index.ts` reads `~/.claude/keybindings.json` (resolved through `defaultKeybindingsPath()`, with `CLAUDE_HOME` and `XDG_CONFIG_HOME` overrides). The full Claude schema is honored — chord sequences, modifier syntax, and the `vim` namespace — and dispatched onto TUI actions through `dispatchKeybinding()`. `/keybindings` surfaces a diagnostics view; `openKeybindingsFile()` opens the config in the user's editor.
- **Status line.** `tuiClient/statusline/index.ts` reads `~/.claude/statusline.json`, executes the configured command, and feeds the rendered lines into `ModelStatus`. `/statusline` shows the contract and the most recent stdout/stderr. When a status command produces output, the status panel hides the default token/context meter for the same row.
- **Vim namespace.** When vim mode is active, the model-status row exposes the current `insert`/`normal` mode tag and the keybindings dispatcher routes `vim.*` actions.
- **Clipboard image paste.** Cross-platform clipboard-image paste is wired into the composer (Linux via `xclip`/`wl-paste`, macOS via `pngpaste`/AppleScript, Windows via PowerShell), so pasting a screenshot uploads it as a Claude attachment alongside text. The clipboard always lives on the machine running the TUI, so the routing depends on where the runtime is: for a **local** runtime the image is materialized under the project workspace (`.ade/cache/...`) and attached by path. For a **remote** runtime the workspace path lives on another machine, so writing there locally would fail (EACCES) and the agent couldn't read it — instead the image is materialized into a local scratch dir and its bytes are uploaded to the runtime via the `chat/saveTempAttachment` action (`saveRuntimeTempAttachment`, mirroring the desktop composer), which returns a runtime-valid path that is then mentioned. The local scratch temp is cleaned up after upload; a pre-existing user file the clipboard merely *referenced* is uploaded but never deleted.
- **`auto` permission mode.** The Claude permission picker accepts `auto` (mapped onto the SDK `permissionMode: "auto"`) in addition to `default`, `plan`, `acceptEdits`, and `bypassPermissions`.
- **Chat Info (subagent panel).** The right pane's Chat Info view replaces the legacy Subagents tab strip. It puts the main agent in row 0 and the live subagent / teammate / background roster in rows 1..N, all selectable with `↑`/`↓`; `↵` inspects a subagent by replaying its events into the main transcript via `buildSubagentTranscriptEvents`. Snapshots are still keyed by `agentId + parentToolUseId` and reconstructed from `subagent_*` envelopes (plus `teammate.idle` / `task.completed` for teammates) through `subagentSnapshotsFromEvents()`. Sibling subagents that share a parent tool-use id are tracked separately by counting resolved subagent ids per parent and only adopting the placeholder parent row when exactly one resolves under it. Each snapshot carries `parentToolUseId`, `turnId`, `startedAt`, `endedAt`, and a derived `durationMs` so rows show elapsed time even when the runtime did not report `usage.durationMs`. The `^a` footer toggle opens or closes the Chat Info pane.
- **Context, output styles, plugins.** `/context`, `/output-style`, and `/plugin` call `chat.getContextUsage`, `chat.listClaudeOutputStyles` / `chat.setClaudeOutputStyle`, and `chat.listClaudePlugins` / `chat.reloadClaudePlugins` against the same Claude SDK runtime the desktop chat uses.

## Chat setup

- `+ new chat` opens a draft setup view (`new-chat-setup`) in the right pane; it does not create a backend chat until the first prompt is sent from the middle composer.
- `/model` opens the model setup view (`model-setup`) in the right pane. It can switch provider, model, reasoning, Fast Mode for fast-capable descriptors, and permission settings, refresh provider readiness through `ai.getStatus`, and open desktop Settings > AI Providers for full configuration. Cursor rows come from the same provider-grouped catalog as desktop, including `cursorAvailability`, so SDK chat models and Cursor CLI launch models stay separated consistently.
- `/login` delegates only to provider CLIs that can authenticate in the current terminal: Claude (`claude auth login`), Codex (`codex login`), and OpenCode (`opencode auth login`). Cursor chat is `@cursor/sdk` and needs `CURSOR_API_KEY` or desktop Settings > AI Providers. Droid chat runs Factory Droid over ACP and needs `FACTORY_API_KEY` or Factory's interactive `droid` login.
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
