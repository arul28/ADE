# Terminal and Session UI Surfaces

The renderer surfaces that show sessions: the Work tab, its list, grid, tools
pane and terminal renderer. Paths are under
`apps/desktop/src/renderer/components/terminals/` unless noted. Main-process
services are in [pty-and-sessions.md](./pty-and-sessions.md).

## Source file map

### Work page and list

| File | Owns |
|---|---|
| `TerminalsPage.tsx` | The Work page: list pane + work view + tools pane, selection, bulk actions, launch disposition, foreign-row open in place, lane-delete overlay. |
| `useWorkSessions.ts` | Work view state (`ade.workViewState.v1`), the session list, optimistic rows, refresh cadence, the board model, pins, filters, `launchPtySession`. |
| `useWorkMachineRouter.ts` | The one per-session routing authority (`pinForSession`, `resolveSessionRuntimePin`). |
| `SessionListPane.tsx` | The list: lane/status/time grouping, quiet tails, Focus shelf, filters, bulk bar, board swap. |
| `SessionCard.tsx`, `SessionHoverCard`, `shared/sessionStatusPresentation.ts` | The three-line row, its status label and hover card. |
| `workLaneFocus.ts`, `useTurnStallClock.ts` (`renderer/lib/`) | `summarizeLaneFocus` / `workFocusQueue`: the one Focus rule; stall re-render clock. |
| `useWorkFocusGrid.ts`, `useWorkFocusQueueReport.ts`, `WorkFocusGrid.tsx` | The Focus grid. |
| `WorkKanbanBoard.tsx`, `sessionBoardMoveUi.ts` | The board view and board moves with undo. |
| `workLaneOrder.ts`, `useWorkLaneReorder.ts`, `workSessionFilters.ts`, `WorkFilterPanel.tsx` | Lane tiers and sort; chip filters. |
| `workLaneBranchClusters.ts` | Same-branch lanes grouped in a dashed cluster. |
| `useWorkLaneContextMenu.tsx`, `WorkManageLaneDialogHost.tsx`, `useWorkLaneDeleteProgress.ts`, `ForeignLaneContextMenu.tsx` | Lane menus, Manage lane, delete progress. |
| `SessionContextMenu.tsx`, `SessionInfoPopover.tsx`, `LaneActionsSubmenu.tsx`, `AutoHandoffModal.tsx` | Row menu, info overlay, lane submenu, auto-handoff rules. |
| `sessionLifecycleActions.ts`, `renderer/lib/sessionStatusChange.ts` | Snooze/settle actions and the Change status rules. |
| `LaneMachineMarker.tsx`, `LanePrBadge.tsx`, `useLanePrs.ts` | Machine and cloud marks; PR badge; lane→PR map ([PRs](../pull-requests/README.md#which-machine-answers-a-pr-read)). |
| `renderer/state/crossMachineLanes.ts`, `renderer/state/cloudRestingRows.ts` | The cross-machine union and resting DAEX Cloud rows. |
| `useChatLaunchCliDriver.ts` | Finishes brain-owned new-lane CLI launches parked at `awaiting-client`. |
| `importSessions/`, `apps/desktop/src/shared/externalSessionPolicy.ts` | Import dialog and the one import policy ([external-session-import.md](./external-session-import.md)). |
| `components/work/workShortcuts.ts`, `WorkShortcutSheet.tsx` | Work chords; contract in `docs/design/keyboard.md`. |
| `renderer/lib/sessionListCache.ts`, `renderer/lib/chatSessionEvents.ts`, `renderer/lib/firstLoadRetry.ts` | List cache, chat-created announcements, first-load retry. |
| `renderer/lib/sessions.ts`, `renderer/lib/terminalAttention.ts` | Labels, insertable tool types, filing buckets, attention helpers. |
| `apps/desktop/src/shared/sessionSpawnNesting.ts` | The one spawn-nesting rule (iOS: `WorkSpawnNesting.swift`). |

### Work view, grid and terminal

| File | Owns |
|---|---|
| `WorkViewArea.tsx`, `WorkGridView.tsx` | Single session, grid, or draft; `SessionSurface`; `ClosedCliSessionSurface` for ended CLIs. |
| `WorkStartSurface.tsx` | The empty draft surface (`AgentChatPane` in draft mode). |
| `components/work/WorkSurfaceHeader.tsx`, `CliSessionWorkSurfaceHeader.tsx`, `components/work/ClaudeLoginPromptButton.tsx` | Work headers; Claude login button. |
| `WorkCliInputBox.tsx`, `cliInputBoxState.ts` | Input box and send queue for a running agent CLI. |
| `workSessionTiling.ts`, `renderer/lib/workGrid.ts`, `ui/PaneTilingLayout.tsx`, `ui/paneTreeOps.ts` | Grid seed tree, grid sets, the shared pane tree. |
| `TerminalView.tsx` | xterm.js wrapper: renderer, fit, hydration, replay, pins. |
| `terminalTypeAhead.ts`, `terminalImagePaste.ts`, `terminalBracketedPaste.ts`, `osc52.ts`, `terminalMacShiftSelection.ts`, `terminalScrollHint.ts` | Terminal input helpers. |
| `terminalTranscriptNormalize.ts`, `terminalPreviewRows.ts` | Transcript-to-grid normalization; headless replay of an ended session. |
| `ptySizeOwnership.ts` | Which viewer sets the PTY size when several mirror one session. |
| `workSurfaceVisibility.ts` | `WORK_SURFACE_REVEALED_EVENT`. |
| `apps/desktop/src/shared/cliLaunch.ts`, `cliLaunch.ts` | The one CLI launch builder (shared with the phone); Work launch types. |
| `apps/desktop/src/shared/adeCliGuidance.ts`, `shared/agentSkillRoots.ts`, `shared/sessionStatusNote.ts` | CLI guidance, skill roots, status-note bounds. |
| `pty/terminalShells.ts` (main), `settings/TerminalShellSection.tsx` | Default shell discovery and setting. |

### Tools pane

| File | Owns |
|---|---|
| `WorkSidebar.tsx` | The right-edge tools pane. |
| `workTools.ts` | Tool catalogue (`WORK_TOOL_DEFINITIONS`), `workToolAvailability`, `isReadOnlyWorkTool`. |
| `WorkToolPicker.tsx`, `WorkToolPickerBackdrop.tsx` + `workToolPickerBackdrop*.ts`, `WorkToolHeader.tsx`, `workToolPanels.tsx`, `remoteWorkToolPanels.tsx`, `workToolChrome.tsx` | Picker, backdrop, tab strip, panels, shared chrome. |
| `useWorkToolCatalog*.ts`, `useToolMachines.ts`, `useRemoteDeviceProbes.ts`, `chatDeviceSources.ts`, `remoteWorkCleanup.ts` | Where each device runs and how it is probed. |
| `useWorkSidebarTool.ts`, `useWorkToolStatuses.ts`, `workToolRequests.ts`, `workToolErrors.ts`, `workSidebarSplitter.ts` | Open tools per lane, status lines, requests, error dots, splitter clamp. |
| `useChatToolActivity.ts`, `useToolHandoff.ts`, `WorkToolPanelBar.tsx`, `workToolStartState.tsx` | Agent activity per tool, Take over / Hand back, start state. |
| `useWorkShowRequests.ts`, `renderer/lib/workToolShowRequests.ts` | Work's side of `daex ui show` ([chat](../chat/README.md#agents-open-panes-daex-ui-show)). |
| `useNativeToolSessions.ts`, `NativeToolFeedsContext.tsx`, `agentBrowserPresence.ts` | Shared browser/App Control/simulator feeds; "Using the browser". |
| `workTerminalShells.ts`, `useAttachedTerminalShells.ts` | Shell counts per session. |
| `components/work/WorkLiveCornerCard.tsx`, `workLiveCard.ts`, `components/shared/FloatingPlayer.tsx`, `components/work/MacDesktopMiniPlayer.tsx` | Floating previews. |

### iOS

| File | Owns |
|---|---|
| `apps/ios/ADE/Views/Work/WorkRootScreen.swift` (+ extensions, `WorkRootComponents.swift`) | The phone's Work list; same visibility rule as desktop. |
| `WorkSessionRowCard.swift`, `WorkSessionGrouping.swift`, `WorkSpawnNesting.swift`, `WorkLaneFocus.swift` | Rows, grouping and quiet zone, nesting, Focus rule. |
| `TerminalSessionScreen.swift`, `SwiftTermSessionView.swift` | SwiftTerm terminal: `sinceOffset` subscribe, gap recovery, ordered input. |
| `WorkChatSessionView.swift`, `WorkNewChatScreen.swift` and composer/card views | Chat and new-chat (DAEX chat or CLI session via `work.startCliSession`). |
| `WorkImportSessionScreen.swift`, `WorkExternalSessionAffordances.swift` | Import flow and the Swift port of the import policy. |
| `apps/ios/ADE/Services/PendingSessionSettleStates.swift` | Local overlay for an in-flight settle, unsettle or override. |

## Entry page: `TerminalsPage.tsx`

`PaneTilingLayout` with `sessions` (`SessionListPane`) and `view`
(`WorkViewArea` plus, when open, `WorkSidebar` at 26–55 % width). All state
comes from `useWorkSessions()`.

- **Selection.** A plain primary click opens on press (`lib/pressActivation.ts`); a drag from that press undoes it. Shift selects the on-screen range across machines; meta/ctrl toggles.
- **Foreign rows** open in place with the row's pin when this window holds the binding (`machineRouter.isLivePin`); otherwise the tab switches.
- **Bulk actions.** Stop, Delete (`agentChat.delete` for chats, `sessions.delete` for PTYs), Stop & delete, Settle. Bulk settle sends one `sessions.settleMany` per machine with its pin and an 8 s undo; one failing machine does not stop the others. It never dismisses input, stops a runtime or archives.
- **Context target.** With no session but a draft composer, `contextTarget` is `draft`, so tools can insert context before a chat exists.
- `ade:work:select-session` (`{ sessionId, laneId? }`) selects and opens a session.

## Keyboard shortcuts

`components/work/workShortcuts.ts` (ids in `shared/keybindings.ts`): `⌘↑`/`⌘↓`
move by pressing the row's control (so a foreign row keeps its pin), `⌘I`
prompt box, `⌘⇧A` actions drawer, `⌘⇧N` new draft, `⌘T` tools pane, `Esc`
back, `?` sheet, `⌃⇥` project tabs. On the web the browser keeps `⌘T` and
`⌘⇧N`.

## Session sidebar: `SessionListPane.tsx`

List mode groups by lane, status (Running / Your move / Ended / Snoozed /
Settled) or time. Board mode is `WorkKanbanBoard`; see
[The Work board](README.md#the-work-board).

- **Quiet tails.** Settled is a phase; Snoozed (above it) is a visibility overlay. Both start collapsed and are out of shift-range selection. `shelf-open:*` / `lane-open:*` record an explicit open. Filing comes from `effectiveSessionFilingBuckets`; `needs_you` always stays in its section.
- **Lane groups.** A lane with two or more top-level sessions gets a header; a one-session lane's card carries the lane and PR. Shells and same-lane subagents are not rows: they live in the parent chat's actions pane, and the parent row has one subagent mark. Nesting comes only from `sessionSpawnNesting.ts`; status, time and board stay flat.
- **Order and filters.** Main checkout first, then pinned, active and quiet tiers; Activity / Name / Created / Manual inside a tier. Status, Tool, Machine OR within an axis; Has PR and Dirty AND across. A remote lane has no local PR snapshot, so Has PR fails closed for it.
- **Orphaned sessions** (lane not in the list) group under the lane's UI name with a warning; DAEX never deletes from that row.
- **Pins.** A chat pin writes the synced `terminal_sessions.pinned` column on the owning machine. Lane pins stay in this window's view state.

### Focus: the Working shelf

The **Focus** pill (`workFoldBusyLanes`, on by default) folds each lane with
live work and nothing waiting onto a collapsed **Working** shelf.
`summarizeLaneFocus` (`workLaneFocus.ts`) is the one rule for the shelf,
headers, board, Focus grid, palette and iOS.

- A lane folds only when a live agent row (chat or tracked agent CLI) is busy; a plain shell never counts. Pinned lanes never fold.
- A lane is held out for a raised hand, a stale run, a stalled turn, a scheduled wake that came due and never started, or a failure the user has not left. A clean finish never holds a lane.
- **Stalled turn:** a live turn silent for `TURN_STALL_AFTER_MS` (5 min) with no open work (`turnOpenWorkCount` from the host). The slot reads **No output**.
- **Scheduled wake:** a resting chat with a wake to come is Waiting; overdue by more than `SCHEDULED_WAKE_GRACE_MS` (2 min) it is Done and holds the lane out. A parent with a busy subagent is Waiting too.
- Surfaces re-evaluate at the next deadline; nothing polls.

### Rows from other machines

- The list is the cross-machine union. It gets the unfiltered local roster, so a session never shows twice. Foreign lane keys are `<machineId>:<laneId>`.
- Rows never name their machine; the hover card, the open chat's composer and the Start on picker do. A Devin or Cursor Cloud lane shows a cloud mark.
- Every foreign row carries its `OpenProjectBinding`, and context actions pass it.
- A dropped machine keeps its rows for the reconnect window (`applyReachability`, 45 s–2 min), then hides them until it reconnects. The open chat stays on screen. An asleep DAEX Cloud computer stays listed and readable; opening a row wakes it (`wakeRestingCloudMachine`).
- Union reads stop while the window is hidden: chats every 10 s, lanes every 30 s (each costs a git status on that machine).

### `SessionCard.tsx`

Three lines: where and status (`SessionStatusSlot`), title with a singleton
lane's PR badge, then preview (`attentionMessage` → `statusNote` → sanitized
output → summary → goal) and quiet facts. Rows never fade by state. Only
`needs_you` counts toward the Work highlight, notifications and the Dock badge
(`useAppWideSessionAttention`).

- The status label order: **Needs you**, then snooze or an unacknowledged **Woke**, then activity (**Planning**, an activity report, **Background work**, **Waiting** with a countdown). None of these change phase, filing or counts.
- On hover the label swaps for snooze and Settle/Un-settle with no reflow.
- A card with `disabledReason` (lane being deleted) blocks selection, drag and menu.
- Activity groups agents by the board's columns through `activityBoardColumn` (`shared/attention/activityBoardColumn.ts`); see [Desktop Activity](../sync-and-multi-device/push-notifications.md#desktop-activity).

## Work view: `WorkViewArea.tsx`

No session tabs: one `SessionSurface`, a grid (`WorkGridView`), or the draft.

- Chat tool types render `AgentChatPane` with `lockSessionProvider`, so the accent is right on the first frame.
- PTY sessions render `TerminalView` on the session's `ptyId`.
- An ended tracked agent CLI renders `ClosedCliSessionSurface`: the TUI snapshot or transcript text (`snapshotLooksLikeTui`), **Resume** (`pty.resumeSession`) and a continuation composer (`pty.sendToSession`, the first prompt goes on the resume command line). Both resolve the row's pin first. A wrong `detached` also lands here; see [Stale-detached repair](README.md#stale-detached-repair).
- Hidden surfaces get `terminalVisible={false}`, not an unmount.

### Input box for a running agent CLI: `WorkCliInputBox.tsx`

A running tracked agent CLI can take text from a box under the terminal
(`CliInputModeToggle`, one choice per person in `ade.work.cliInputMode`).
Plain shells get none.

- `@` mentions expand on the host into the same `<ade-mention>` block a chat send uses; `/` lists the provider's commands.
- Every send goes through a queue (`cliInputBoxState.ts`, in local storage) and `agentChat.typeIntoCli` on the CLI's machine (`runtimePin`). The host types only at a free prompt (`typeIntoAgentCliWhenFree`); a busy CLI answers `deferred`, and the queue asks again with backoff.
- DAEX reads the free prompt only for Claude, Codex, Cursor, Droid, OpenCode, Pi and Muse (`agentCliReadsFreePrompt`). For Qwen, Kimi, Grok, Copilot, Antigravity and Devin the host types at once (`typedAtOnce`). The same rule applies to wakes, scheduled prompts and `daex chat send`.
- A send whose connection dropped mid-way retries once with the same id; still unconfirmed, it waits for **Send again** or **Remove**. Waiting texts move to the continue box when the CLI ends.

### Typing into an agent CLI on a far link

On a slow link an agent CLI terminal sends every key straight through; only
plain shells get type-ahead ([Type-ahead on a slow link](README.md#type-ahead-on-a-slow-link)).
A CLI on an asleep or deleted DAEX Cloud computer takes messages through the
account server's queue, typed by `typeIntoAgentCliWhenFree` on wake; see
[On a DAEX Cloud computer](../remote-runtime/README.md#on-a-daex-cloud-computer).

## Focus grid

The Focus pill's grid half replaces the work area with every chat that needs
the user (`workFocusQueue`, the same `holdsOut` flag the fold reads). It is the
normal Work grid with these differences:

- `SessionListPane` reports the members (`onFocusQueueChange`), so grid and list agree. Other machines' chats come with their row's binding, not the remembered pin.
- No Tools pane; each header offers **Open in full view**.
- Tiles keep their place (`stableFocusOrder`); layout is saved per set of chats.
- Pages: capacity from the measured grid box, one to `MAX_WORK_GRID_TILES`; **Chats per page** (`interfacePreferences.focusGridMaxChats`) can only lower it. Only the page on screen is mounted.

## Grid mode

- `buildWorkSessionTilingTree(sessionIds, preset)` seeds the tree when nothing is saved for `gridLayoutId` (`work:grid:tiling:v1:<projectRoot>[::<laneId>]`). `auto` is near square.
- `PaneTilingLayout` saves the tree 300 ms after a change; `reconcilePaneTree` drops unknown leaves and adds missing ids; drops use a 25 % edge band.
- A grid set holds at most `MAX_WORK_GRID_TILES` (6, `lib/workGrid.ts`), enforced in `addSessionBesideTarget`, `WorkGridView`'s drop acceptance and `normalizeWorkGridSets` (`appStore.ts`).
- One Tools pane serves the focused tile.

## Right-edge Work sidebar: `WorkSidebar.tsx`

The tools pane follows the active lane and session. Width is clamped to
26–55 % and to at least 280 px of pane and 360 px of chat column
(`workSidebarSplitter.ts`).

**Tools** (`WORK_TOOL_DEFINITIONS`): Terminal, Browser, Git, Pull request,
Issues, Side chat, Files, iOS, Android, App Control, Mac Desktop and Windows
Desktop (the picker shows one Screen card for the machine's platform). A tool
is open once; the strip has one tab per open tool and the picker behind `+`.

- **Availability** comes from capability flags (`workToolAvailability`), never `process.platform`. iOS needs `iosSimulator.getStatus().supported` on the session's machine. On the web client Browser and App Control are read-only. A tool that becomes unavailable falls back to the picker.
- **Open tools are per lane** (`useWorkSidebarTool(laneId, runtimePin, chatSessionId)`, stored in `laneWorkViewByScope`), published as `work_tools.setActiveTool` to the chat's machine. Open state and width are per project.
- **Mounting.** Only the active tab mounts; the picker stays mounted `inert` and paused. Closing a tab stops the tool on its pin (`closeWorkToolForReal`: browser tabs close, `appControl.stop`, `iosSimulator.shutdown`, `mac_desktop.stop`). Closing the pane stops nothing. `hideBuiltInBrowserView` parks the browser view on every switch.
- **The picker backdrop** is WebGL at DPR 1, ≤ 600 k pixels, ≤ 30 fps, paused when unseen, with a CSS fallback. Every path that drops the context releases it.

### The pane follows the chat's machine

`WorkSidebar` takes `runtimePin` (`resolveSessionRuntimePin(activeWorkSession)`).

- Lanes resolve through `useLanesForPin(runtimePin)`.
- Each panel's React key includes the pin key (`work-git:<pinKey>:<laneId>`, …), so one machine's state never paints into another.
- A known-offline pinned machine shows "<machine> is offline." and skips probes.
- The pin goes to `appControl.*`, `iosSimulator.*`, `terminal.write` and every panel (`LaneGitActionsPane`, `LaneDiffPane`, `ChatTerminalDrawer`, `ChatIosSimulatorPanel`, `ChatAppControlPanel`, `ChatBuiltInBrowserPanel`, `FilesTab`).
- The browser is this window's (`persist:ade-browser` partition). For a foreign chat, loopback URLs tunnel to that machine; see [The DAEX browser for a remote chat](../remote-runtime/README.md#the-daex-browser-for-a-remote-chat).

**Context insertion.** A chat or draft target gets window events
(`ade:agent-chat:*`). A tracked agent CLI (`isPtyContextInsertableToolType`:
every provider CLI, not shells) gets a bracketed paste through
`terminal.write(..., runtimePin)`. PTY insertion works across machines; chat
insertion for a chat on another machine fails closed with a message.

**Browser tabs.** Each tab has a fixed lane group. Agent leases expire when
idle; another chat's tab is `heldByOtherChat` and cannot be claimed. Over the
tab limit the error lists only the caller's and unkept agent tabs.
`daex browser handoff` makes a tab human-owned until a person hands it back
(or 15 minutes pass); agent calls meanwhile throw `handoff_active`.

### The floating live-preview card: `WorkLiveCornerCard.tsx`

A live thumbnail of the browser when it is live and not on screen, in a corner
of the chat column. App Control, the Apple device and the Mac Desktop use
their own floating players (`FloatingPlayer.tsx`).

- It shows only sessions the open chat owns (or that this chat's pane showed).
- It steps aside while any floating player shows (`floatingPlayerSlots.ts`).
- ✕ records the session per chat (`chatCompanionUiState.ts`); a new session does not reopen it.
- It uses existing feeds, paints inside one rAF with no React renders, and drops every feed when Work is not active. A previewed browser tab is moved off-screen, not hidden, because a hidden view captures nothing.
- `macDesktopLiveViewLease.ts` keeps one decoder per lane for the pane and the mini player.

## Terminal renderer: `TerminalView.tsx`

xterm.js with `FitAddon`.

- **Cache.** Instances live in a module map keyed by `terminalRuntimeKey` (`runtimePin`, project root, session, PTY). A late pin moves the key and `teardownRelocatedRuntimes` disposes the old one. A cached runtime disposes 400 ms after its last ref.
- **Renderer.** WebGL first, DOM on failure or context loss. At most 8 WebGL terminals (`MAX_WEBGL_TERMINALS`; Chromium allows 16 contexts per page).
- **Fit.** Invalid dims (< 20 cols, < 6 rows) restore the last good dims and retry. Width-sensitive writes wait for a fit and `document.fonts.ready`.
- **Pins.** `runtimePin` goes on `pty.write` / `pty.resize`, `terminal.preview`, `sessions.get`, `sessions.readTranscriptTail`, `agentChat.saveTempAttachment`, `pty.setDataSubscriptions`, `pty.onData` / `pty.onExit`.
- **Hydration.** `terminal.preview` first (alt-screen snapshots repaint visible rows), else the transcript tail. A disposed session replays up to 8 MB of raw transcript with full-screen redraws stripped.
- **Stream recovery.** A `PtyDataEvent.replace` resets xterm and writes the snapshot; async hydration checks a generation counter.
- **Image paste.** A tracked agent CLI saves the image on the session's machine and pastes a path. A local plain shell keeps `^V`.
- **OSC 52** is write-only, ≤ 1 MiB, only from the visible focused terminal; the brain's headless mirror ignores it.
- **Size ownership** (`ptySizeOwnership.ts`): a hidden document never owns the PTY size, a focused one always does.
- **Reveal.** `WORK_SURFACE_REVEALED_EVENT` clears the atlas, refits and refocuses; hidden surfaces get no resize events.
- `terminalTranscriptNormalize.ts` replays a transcript at its inferred width so a different-size viewer shows no staircase; it recovers DEC modes but never alt-screen.

## Empty state: `WorkStartSurface.tsx`

An `AgentChatPane` in draft mode. `ModeSwitcherPills` picks
`WorkDraftKind = "chat" | "cli" | "shell"`. The draft machine and lane come
from the Start on picker; `setDraftLaneId` never calls `selectLane`, because
the draft can target another machine's lanes.

A CLI draft passes `runtimeCliLaunch` (provider, permission mode, model,
effort, prompt, credential) to `launchPtySession`; the host builds the command.

### CLI launch (`apps/desktop/src/shared/cliLaunch.ts`)

The one launch builder for every CLI provider (`CliProvider`,
`LAUNCH_PROFILE_TOOL_TYPE`, `LAUNCH_PROFILE_TITLE`); iOS `work.startCliSession`
uses it too.

- `buildTrackedCliLaunchCommand` returns explicit argv, so `ptyService.create` never types a launch line into a shell. Each provider maps the permission mode in its own `permissionModeTo*Flags`; `auto` is Claude only, `config-toml` Codex and OpenCode only.
- Guidance: Claude through `--append-system-prompt`, others as a leading prompt or initial input; OpenCode gets the slim chat base prompt on its session.
- An initial prompt goes into argv for Claude, Droid and OpenCode; Codex interactive and Cursor use `initialInput` after the PTY is ready.
- OpenCode launches attach to DAEX's shared server (`attachOpenCodeTerminal`); see [OpenCode CLI](README.md#opencode-cli-attach-to-ades-server).
- Resume rebuilds a structured descriptor from `TerminalResumeMetadata` (`buildTrackedCliResumeLaunchCommand`), so Windows argv never passes through PowerShell quoting.
- Plain shells are login shells on macOS, interactive non-login on Linux. Windows accepts PowerShell 5.1/7, cmd or an absolute Git Bash path, never WSL. Clean shells skip rc files.
- **Default shell** (`pty/terminalShells.ts`): discovered per machine, stored in `<ADE home>/terminal-shell.json`, applied only to plain shells the user opens. `pty.getShellSettings` / `pty.setDefaultShell` take the Settings machine pin.
- Every PTY gets `TERM_PROGRAM=ADE` (kept for compatibility) and drops the host terminal's session pointers.

## Context menu: `SessionContextMenu.tsx`

Groups: **Name & status** (Rename, Generate title / lane name / status line /
all three), **Lifecycle** (stop, snooze/wake, settle/un-settle), **Go to**,
**Copy**, **Hand off…** (Local, Another machine, Auto handoff…), then the
destructive block.

**Change status** offers Working, Needs you, Done, snooze presets and
Unsettle / Keep active. Columns call `session.moveOnBoard` through
`moveSessionOnBoard` (5 s undo). `lib/sessionStatusChange.ts` decides what is
offered and names each disabled reason (Working only when something is live;
Done refused over a provider card). Menu, board, snooze control and chat
header chips share `sessionLifecycleActions.ts` and `sessionBoardMoveUi.ts`.

A failed auto-handoff rule read (`loadAutoHandoffRulesForSession` returns
`null`, never `[]`) keeps the item disabled, so it cannot delete rules.

## Gotchas

- Do not unmount a hidden `SessionSurface`; pass `terminalVisible={false}`. Grid tiles stay mounted; `isActive` gates input.
- The list cache keys by `projectRoot + laneId + status + toolTypes`. Call `invalidateSessionListCache()` before the first `refresh()` for an event every view must see.
- Do not read "loud" from the Your move bucket (it mixes `needs_you` with quiet `ready`/`idle`). Use `sessionNeedsYou()` or `summarizeTerminalAttention()`.
- Snooze columns are for filing only. `canonicalSessionState()` never reads them, and expiry writes nothing.
- Nothing derives a settle. A clean exit is `ended`; a settled row has `settledAt` or a `"settled"` override. The next user turn clears a chat settle; only PTY output clears one on activity.
- On launch, open the tab from the synchronous create result before the forced refresh, so `TerminalView` subscribes before a fast TUI paints. Do not prune open tabs before an authoritative refresh for the current project.
- Work and Lanes share `useWorkSessions`; keep lane state keyed by `projectRoot::laneId`.
- Effects that depend on a pin key on `pin.key`, not the object.
