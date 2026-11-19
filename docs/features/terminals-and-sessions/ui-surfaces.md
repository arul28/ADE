# Terminal and Session UI Surfaces

The renderer surfaces that show session data. Paths are under
`apps/desktop/src/renderer/components/terminals/` unless noted.

## Entry page: `TerminalsPage.tsx`

The Work tab. `PaneTilingLayout` holds two panes: `sessions` (default 24%,
min 15%) with `SessionListPane`, and `view` (default 76%, min 40%) with
`WorkViewArea` and, when `workSidebarOpen`, the right-edge `WorkSidebar`
(width `workSidebarWidthPct`, 26–55%). All state comes from
`useWorkSessions()`. It renders `SessionContextMenu` and `SessionInfoPopover`.

- **Context targets.** With no session selected but a draft composer mounted,
  `contextTarget` has kind `"draft"` (`work:draft:<laneId>:<draftKind>`), so
  the tools pane can insert context before a chat exists.
  `isPtyContextInsertableToolType` (`lib/sessions.ts`) decides which CLIs take
  PTY context. The Terminal tool resolves its owner from the active session
  (a chat, or a running CLI with a `ptyId`), not from `contextTarget`.
- **`ade:work:select-session`** (`{ sessionId, laneId? }`, from lineage
  links) selects the lane, focuses the session and opens its tab; a missing
  lane comes from the loaded list.
- **Lane deletes** (`useWorkLaneDeleteProgress`): Work hydrates
  `lanes.listDeleteProgress`, follows progress events, and covers the active
  lane with an overlay until the refresh succeeds (two retries, then a sticky
  toast).
- **Selection.** `handleSelectSession(id, event, visibleSessionIds,
  binding?)`: a plain click opens the row, shift selects the on-screen range
  across every machine's rows, meta or ctrl toggles. A plain primary-button
  open runs on the **press**, not the release (`lib/pressActivation.ts`,
  `selectOnPress`); modified clicks, touch, pen, keyboard and presses on a
  control in the row keep their click. A drag that starts from that press
  undoes it (`selectionRestorer` puts back the active and selected items, the
  lane, the open list and the seen stamps). A woken row is acknowledged on
  release. The board, the Focus grid and grid members keep the click.
  Selections that leave the rendered list are pruned.
- **Foreign CLI and shell rows**
  (`handleSelectForeignRuntimeSession`): with the owning binding still open
  (`machineRouter.isLivePin`) the row opens in place with that pin and the tab
  stays; otherwise the tab switches, and a failed switch opens nothing.
- **Bulk actions.** Stop (running PTYs, after a confirm), Delete (ended rows:
  `ade.agentChat.delete` for chats, `ade.sessions.delete` for PTYs) and Stop
  & delete. Bulk settle lives in `SessionListPane`: visible at-rest,
  non-settled, non-`Needs you` rows go through `ade.sessions.settleMany`, one
  call per machine with its pin, with an 8 s undo to the same machines; one
  failing machine does not stop the others. On the web client the federated
  adapter sends each pinned batch to its machine's adapter. Bulk settle never
  dismisses input, stops a runtime or archives.
- **Bulk menu.** Right-clicking a selected row opens `SessionBulkContextMenu`
  (`ui/ContextMenu`): grid open (up to `MAX_WORK_GRID_TILES`, this tab's rows),
  remove from grid, pin, stop, snooze, wake, settle, unsettle, copy ids, clear,
  delete, stop & delete. Partial actions show "k of N". Lifecycle writes go per
  machine with one failure toast and one undo. The Lanes submenu sends the
  selection's lanes to the Lanes tab (`/lanes?action=select|batch&laneIds=…`;
  a foreign lane as `machineId:laneId` from `buildForeignSessionLanes`); a
  lane that cannot be acted on is left out and named ("2 skipped · Studio is
  offline").

## Keyboard shortcuts

`useWorkShortcuts` (`components/work/workShortcuts.ts`, ids in
`shared/keybindings.ts`):

- `⌘↑` / `⌘↓` move the selection by pressing the row's control, so modifiers
  and a foreign row's pin behave as a click does.
- `⌘I` enters and leaves the prompt box (the chat's, or a CLI's input). `⌘⇧A`
  opens the chat's actions drawer (`ade:chat:open-info`); `⌘⇧N` starts a draft.
- `⌘T` opens or closes the tools pane with the keyboard inside; `Esc` backs
  out. `?` toggles the shortcut sheet outside text fields.
- `⌃⇥` / `⇧⌃⇥` cycle project tabs in strip order by pressing the tab
  (`components/app/useProjectTabShortcuts.ts`); with one project, the palette's
  project picker opens.
- On the web client the browser keeps `⌘T` and `⌘⇧N`; the palette's
  `Tools: …` rows and a lane's "New chat" cover them.

Chords fire inside text fields, except `⌘↑`/`⌘↓`, which a field or terminal
keeps. The contract is in `docs/design/keyboard.md`.

## Session sidebar: `SessionListPane.tsx`

`workViewMode` picks the list or the board, separately from grouping. In board
mode the body is `WorkKanbanBoard` with the whole content area (moving the
splitter would overwrite the list layout); it includes other machines' chats,
and New chat goes back to the list. See
[The Work board](README.md#the-work-board).

In list mode, `sessionListOrganization` groups by lane, by status (Running /
Your move / Ended / Snoozed / Settled) or by time (today / yesterday / older).

- **Disclosures.** `StickyGroupHeader` keeps collapse state
  (`workCollapsedLaneIds`, `workCollapsedSectionIds`). The label and the
  chevron both toggle; the label is the only keyboard stop. A collapsed header
  shows its count (`Settled (12)`). Headers have `role="heading"`.
- **Two quiet tiers.** Settled is a phase; Snoozed (above it) is a visibility
  overlay. Status and time views end with one section each; lane view puts
  both tails in each lane. All start collapsed; collapsed tails are out of
  shift-range selection. `shelf-open:*` / `lane-open:*` mark an explicit open;
  a notification deep link adds it. The Working, Snoozed and Settled shelves
  count chats (top-level rows plus pending handoffs), not lanes.
- **Filing** comes from `effectiveSessionFilingBuckets` (over
  `sessionFilingBucket`): lifecycle plus snooze, and `needs_you` always stays
  in its section. Settled rows sort by `settledAt`, snoozed by `snoozedUntil`.

### Focus: the Working shelf

The **Focus** pill (`workFoldBusyLanes`, on by default) folds each lane with
live work and nothing waiting on the user onto a collapsed **Working** shelf,
the first shelf of the quiet zone. Only the user opens it; the open chat's
lane folds too. `summarizeLaneFocus` (`workLaneFocus.ts`) is the one rule for
the shelf, the headers and the board.

- A lane folds only when a live agent row (chat or tracked agent CLI) is
  busy. A plain shell never counts.
- These hold a lane out with its rows visible: a raised hand, a stale run, a
  stalled turn, a scheduled wake that came due and never started, or a failure
  the user has not left. A clean finish never holds a lane, and a lane with
  only finished rows never folds. Snoozed and settled rows take no part.
- A finished nested row never holds its lane out (a nested raised hand
  does). A finished helper that a busy agent in the same lane launched (a peer
  or a `--no-parent` chat with `launchedBySessionId`) does not hold it either.
  Pinned lanes never fold; the main checkout folds like any lane.
- **Stalled turn:** a live turn silent for `TURN_STALL_AFTER_MS` (5 min) with
  no open work. The host counts open work per turn (`trackTurnInFlight`:
  commands, tool calls, foreground subagents, approvals) as
  `turnOpenWorkCount`. `sessionTurnStallMs` is the rule; the slot shows **No
  output** and re-evaluates at `nextTurnStallDeadlineMs`. A resting chat is
  never stale or stalled (`canonicalSessionState` checks idle first).
- **Scheduled wake:** a resting chat with a wake still to come is Waiting
  (`scheduledWakeState`). A wake overdue by more than
  `SCHEDULED_WAKE_GRACE_MS` (2 min) is Done and holds its lane out. A chat
  whose nested subagent is mid-turn or waiting on a wake is Waiting too
  (`subagentKeepsParentBusy`, `parentsWithBusySubagents`); archived and
  snoozed subagents and attached shells do not count.
- **Background work** reported by the provider already reads as running
  (`liveness: "background"`). A finished chat whose last reply said it waits
  on its own work (`awaitingOwnWorkAt`, see
  [Chat › turn-end check](../chat/README.md)) is Waiting only while a chat it
  launched is busy in the same lane; the verdict is in brain memory only. iOS
  reads it in `WorkLaneFocus.swift`.
- Every surface reads the same rule: the row label, the lane rollup and Focus
  grid (`busySubagentParentIds`), the board chips ("Wake scheduled",
  "Subagent working"), the host's `deriveWorkBoardColumn`, the Lanes
  overview, the palette and iOS. Each re-evaluates at
  `nextScheduledWakeDeadlineMs`; nothing polls.
- Turning Focus off forgets the return state.
- Each lane header has one rolled-up dot (`LaneFocusStatusDot`: Needs you >
  Working > Waiting > Done). A failure is acknowledged only once the user
  **leaves** it (`workSeenAtBySessionId`, at most `WORK_SEEN_AT_LIMIT`). A lane
  back from the shelf floats to the front of its tier, except in Manual sort.

### Lane groups, subagents and shells

- A lane with two or more sessions has a header (lane name in the lane accent,
  PR marker) and an indented rail. A one-session lane has no header; its card
  carries the lane and PR and inherits the lane menu. Only top-level units
  count: shells and same-lane subagents file under their parent.
- **Shells** are not Work rows. They live in the chat's actions pane
  (**Shells**): click to open, right-click or `⋯` for the row menu. A shell
  whose chat is gone is archived with it.
- **Subagents** of a parent chat are not Work rows either. They live in the
  parent's **Subagents** section. The parent row has one mark
  (`nestedSubagentMark`: a people icon, the count and the worst state, labelled
  like "2 subagents, 1 needs you") that opens the actions pane
  (`requestChatActionsPane`). The pane lists the transcript's children, then
  every filed subagent it lacks (`filedSubagentsOf`, `useChatChildRoster`). A
  subagent of a CLI or shell stays top-level.
- Filing rules: a peer stays top-level; grandchildren count for the root; a
  quiet parent pulls not-done children up; a child with a hidden or deleted
  parent stays top-level; status, time and board stay flat; foreign rows file
  the same way. **Stop reports to <parent>** un-nests and **Report back to
  <parent>** files again. A cross-lane child stays in its own lane with its
  **Subagent** chip, and its hover card says **Started by <parent>**.
  `ade chat list` stays flat.

### Order, filters and lane actions

- Lane order: the main checkout first, then pinned, active and quiet tiers. A
  Work pin is not a Lanes pin. Activity, Name, Created or Manual sort inside a
  tier. Dragging a header (not the main checkout) inside its tier switches to
  Manual.
- Filters: Status, Tool and Machine OR within an axis; Has PR and Dirty AND
  across. Machine is empty (all) by default; a chip for a machine that left
  stays so it can be cleared. A remote lane has no local PR snapshot, so Has
  PR fails closed. The empty state names the chips and clears them; foreign
  matches count.
- Lane headers use `useWorkLaneContextMenu` (inline color, copy, reveal;
  **Manage lane** in a portal over Work).
- A deleting lane (`laneDeleteProgressByLaneId`) has a spinner header
  (`Deleting`, `Deleted`, `Deleted with warnings`), and its cards get a
  `disabledReason` in every grouping.
- Orphaned sessions (a `laneId` not in the lane list) group under their
  `laneName` (`missingLaneSessionGroups`) with a warning icon, a note that the
  chat history is kept, and a lane refresh. ADE never deletes anything from
  this row.

### Rows from other machines

- Foreign lanes file through the same `partitionQuietSessions` and quiet
  tails; a fully quiet foreign lane uses `lane-open:<machineId>:<laneId>`.
  Cards and actions carry the owning binding; **Manage lane** is pinned to
  that machine.
- Rows never name their machine: no chip, glyph or lane-header mark (a Devin
  or Cursor Cloud lane shows a cloud mark). The hover card, an open chat's
  composer and the Start on picker name it.
- A machine that drops keeps its rows for the reconnect window
  (`applyReachability`, 45 s to 2 min), then its rows leave until it
  reconnects. The open chat stays on screen while its machine is unreachable
  (`WorkViewArea` holds it, and `AgentChatPane` keeps it selected through a
  list read). A machine that stopped redialing because only the person can fix
  it (a rejected pairing or identity, or a sign-in the account refused) shows
  that failure and its action (`Pair again`, or the machine's row) in place of
  "Reconnecting to …". An asleep ADE Cloud computer stays listed
  (`machineIsCloudResting` in `cloudRestingRows.ts`); opening a row wakes it
  (`wakeRestingCloudMachine` in `lib/cloudMachineWake.ts`), and the chat shows
  "Waking <machine>…" (`ChatMachineWakeBanner`) while the Lanes tab shows
  `RestingCloudLaneDetail`. Only a reachable machine with no project binding
  yet has a disabled row.
- In-flight handoffs (`HandoffLaunchJob`) show as placeholder cards that
  follow the filters, cannot be selected, and leave when the chat exists or
  the handoff fails.

### Chrome

- A 32 px toolbar: **Hide sessions** (a thin left rail shows **Show
  sessions**), Search (opens the palette; the word drops under 360 px), the
  **Focus** pill with its grid half, List/Board, the filter funnel with its
  count, and New chat.
- `WorkFilterPanel`: **View** (Group by, Sort by) and **Show only** (Status,
  Agent, Machine menus; the `LaneCombobox`; Has a PR and Uncommitted changes;
  Reset).
- Pins: **Pin** writes the synced `terminal_sessions.pinned` column on the
  owning machine, so it follows the user. Lane pins stay in this window's
  view state (`workPinnedLaneIds`).
- A selection bar (Stop N, Settle N, Delete N, Stop & delete N, clear) counts
  only visible rows.
- Shift-range selection follows the pane's own ordered id list.
- `liveChildrenByParentId` and `sessionTitleById` come from the unfiltered
  list, so a lineage tooltip can name a hidden parent.

### `SessionCard.tsx`

One full-bleed row, three lines:

1. **Where and status.** A pin, a singleton lane's identity, lineage, a branch
   only when it differs from the lane's, and a singleton's PR, then
   `SessionStatusSlot`. `AgentBrowserPresenceBadge` sits in the status cluster
   (by the provider logos on a compact row). With none of these, the delta or
   last-activity time fills the line. Lane identity uses the lane accent and
   `LaneIcon`; a branch is muted with `BranchIcon`.
2. **Title and singleton PR.** `primarySessionLabel()`, with `LanePrBadge` at
   the right. A local lane's PR opens in ADE; another machine's opens on
   GitHub. A multi-PR badge picks the newest open PR and lists the rest in a
   clamped, keyboard-reachable portal. During lane naming every lane label
   shows `Naming lane…`; a new title flashes the lane accent.
3. **Preview and quiet facts.** `attentionMessage`, else `statusNote`, else
   the sanitized `lastOutputPreview` (plain text, 120 characters), else
   `summary`, else `goal`. Then the Claude cache TTL, a non-stop exit code and
   `ToolLogo` (after a model handoff, the current logo over a sliver of the
   previous one).

`SessionStatusSlot` shows one label (from
`shared/sessionStatusPresentation.ts`).

- Order: **Needs you** first, then an active snooze or an unacknowledged
  **Woke**, then the activity detail. A chat in plan mode reads **Planning**
  (violet; Codex after `turn/start` accepts the mode). A current activity
  report replaces **Working**. After the turn, provider background tasks read
  **Background work** (×N), and an armed `nextWakeAt` reads **Waiting** with a
  countdown (30 s refresh). None of these change the phase, filing, filters
  or counts; CLI output is never read for plan mode.
- Elapsed time comes from `sessionElapsedAnchor`: `currentTurnStartedAt` for
  a live turn, `backgroundWorkSince` for background work (Codex and Cursor
  have none and use last activity), else last activity. iOS uses an activity
  report's `updatedAt` first. `ade session show` uses the same helper
  (`sessionElapsedLabel`).
- On hover or focus the label swaps, with no reflow, for
  `SessionSnoozeControl` and Settle or Un-settle. The button disables itself
  while its call runs. Settle is hidden while a turn runs and shown when only
  background work is left. An open snooze menu keeps the slot visible. A
  **Woke** row keeps its mark until it is opened.

`SessionHoverCard` opens after 1 s of hover, to the right of the sidebar: lane,
machine, branch, provider, PR, parent thread, spawn kind, live children,
import source, grid membership, Claude tag, next wake, non-zero exit and the
cleanup hint. PR and parent are links. Row-to-row movement opens the next card
at once; scroll and resize cancel it. A key press, or a press outside the
card, cancels or closes it, and cards then stay closed until the pointer moves
3 px; the row under the pointer then starts its delay again. A list that
re-sorts under a resting pointer therefore opens no card over the composer.
A press or a key inside the card keeps it open.

A card with `disabledReason` (its lane is being deleted) blocks selection,
drag and its menu and shows a status overlay. Selection and hover use the row
background; multi-select adds a ring; rows never fade by state. Only
`needs_you` counts toward the Work highlight, notifications and the Dock badge
(`useAppWideSessionAttention`, at `AppShell`).

The account-wide Activity UI groups agents by the board's four columns
through `activityBoardColumn` (`shared/attention/activityBoardColumn.ts`), so
the board, Activity, the phone and the Live Activity count the same rows. A
failed agent files under Needs you with a red **Failed** mark; Waiting rows
carry their reason (`WORK_BOARD_WAITING_REASON_LABEL`). The popover and
"Open all" are one panel (`activity/ActivityPanel.tsx`); see
[push-notifications.md](../sync-and-multi-device/push-notifications.md#desktop-activity).
Activity's Sessions list is agents only; PRs and checks are in its Inbox.

## Work view: `WorkViewArea.tsx`

The render target for open sessions, by `viewMode`:

- `tabs` — a tab strip and one `SessionSurface`, with "New Chat". With
  `hasGroupedTabs`, lane-grouped chips (with `useWorkLaneContextMenu`).
- `grid` — `PaneTilingLayout` seeded by
  `buildWorkSessionTilingTree(visibleSessionIds, tilingPreset)`, each tile a
  `grid-tile` `SessionSurface`. The arrange menu (Auto / Rows / Columns)
  rewrites the saved tree (`tilingTree.set`) and resets sizes
  (`layout.set(gridLayoutId, {})`).
- `single` — one session, no tab chrome.

It also builds a title index that locked `AgentChatPane` embeddings use to
name spawned-chat rows.

### `SessionSurface` (internal component)

- Chat tool types → `AgentChatPane` with
  `lockSessionProvider={providerFromChatToolType(session.toolType)}`, so the
  accent is right on the first frame
  ([Resolving the accent](../chat/composer-and-ui.md#resolving-the-accent-for-the-chat-on-screen)).
- PTY sessions → `TerminalView` on the session's `ptyId`. Terminal tools open
  from the tools pane's Terminal tab.
- A suspended grid tile shows a static preview card.
- Props: `isActive` (focus and input), `terminalVisible` (false stops fits and
  resize broadcasts), `layoutVariant` (`"standard"` or `"grid-tile"`). Grid
  mode keeps running PTYs mounted.
- An exited tracked agent CLI renders `ClosedCliSessionSurface` (a wrong
  `detached` lands here too; see
  [Stale-detached repair](README.md#stale-detached-repair)). It reads
  `ade.terminal.preview`; `snapshotLooksLikeTui(rows)` picks the snapshot when
  it holds TUI frames or many styled cells, else the transcript text. It keeps
  the live header (with the Tools toggle), **Resume**
  (`ade.pty.resumeSession`, no prompt) and the continuation composer
  (`ade.pty.sendToSession`, the prompt goes on the first resume launch).
- Tile minimums: chat 440 × 340, terminal 320 × 220.

### Input box for a running agent CLI: `WorkCliInputBox.tsx`

A running tracked agent CLI can take its text from a box docked under the
terminal. The header's keyboard button (`CliInputModeToggle`) picks **type in
the terminal** (default) or **use the box**, one choice per person
(`ade.work.cliInputMode`); a dot shows texts still waiting while the box is
hidden. Plain shells and untracked CLIs get no box. The terminal stays usable.

- Enter sends; Shift+Enter is a new line. A multi-line message uses the host's
  CLI typing path (`writeAgentCliInput`: clear the line, paste, submit).
- `@` opens `ChatCommandMenu`: a file inserts `@path`; models, chats, lanes,
  terminals, PRs, machines and MCP servers insert the chat token, and the host
  (`agentCliTyping.ts` → `applyChatMentionExpansion`) adds the same
  `<ade-mention>` block a chat send does (visible in the scrollback). `/`
  lists the provider's commands.
- Up arrow on the first line recalls the last 50 sends; the draft is saved per
  session (`ade.work.cliInputDraft.<id>`).

Every send goes through a queue (`cliInputBoxState.ts`) outside the box, kept
in local storage, with a runner only while something waits. Each send calls
`agentChat.typeIntoCli` (`chat.typeIntoCli`) on the CLI's machine
(`runtimePin`). The host types only at a free prompt
(`typeIntoAgentCliWhenFree` in `agentCliTyping.ts`, through
`deliverWakeToSession`); a busy CLI answers `deferred`. A free prompt is one
`canTakeTypedMessage` accepts: never while the CLI reported a menu or a
question (its Enter would pick an option).

ADE reads the free prompt of Claude, Codex, Cursor, Droid, OpenCode, Pi and
Muse only (`agentCliReadsFreePrompt` in `shared/cliLaunch.ts`). For Qwen,
Kimi, Grok, Copilot, Antigravity and Devin, the host types each text at once,
as the person's own keys would be, and answers `typedAtOnce`. The box never
shows these CLIs as busy, and its placeholder says that Enter types at once.
The same rule applies to wakes, scheduled prompts and `ade chat send`.

| State | What it means | What happens next |
|---|---|---|
| Queued | The CLI is mid-turn. | Asked again every 1.5 s, 4 s after 30 s, 10 s after 5 min, and at once on a runtime state change. |
| Typing it now | Being typed. | Removed when the host confirms. |
| Sends when *computer* reconnects | The machine is disconnected, or the call was refused before it was sent. | Sent on reconnect. |
| Unconfirmed | The connection dropped mid-send. | Sent once more with the same id after a short reconnect (a brain that announces `agentCliTypeNow` types a repeated id once). Still unconfirmed: never retried by itself; **Send again** or **Remove**. |
| Failed | The host refused it (archived, not an agent CLI). | **Send again**, **Edit** or **Remove**. |

When the CLI ends, waiting texts move to the ended session's continue box
(`ade.work.cliContinueDraft.<id>`). Two windows share the queue and claim a
text before typing it. Typing clears the CLI's prompt line first.

### Typing into an agent CLI on a far link

On a far or slow link (see
[A slow or dropping link](../remote-runtime/README.md#a-slow-or-dropping-link))
an agent CLI terminal sends every key straight to the CLI, as on a fast link;
only plain shells get type-ahead (`terminalTypeAhead.ts`). To write text on
this computer first, the person opens the input box above on purpose.

A CLI on an asleep or deleted ADE Cloud computer takes messages through the
account server's queue, from the web, the iPhone or the desktop. On wake, the
brain types each one through `typeIntoAgentCliWhenFree`, so the CLI's ready
signal decides when
([the turn signal table](pty-and-sessions.md#exact-turn-status-for-agent-clis)).
A CLI that ended with the computer's restart returns the message as failed,
with a sentence to open the CLI and send it again. A deleted computer's CLI
first continues on a new computer; see
[On an ADE Cloud computer](../remote-runtime/README.md#on-an-ade-cloud-computer).

A Claude CLI whose preview shows `Please run /login` or a 401 gets the
**Login to Claude** button (`ClaudeLoginPromptButton`): a tracked shell in the
lane runs `claude auth login`, and Work selects it.

## Focus grid

The Focus pill's grid half (`workFocusGrid`, only while Focus is on) replaces
the work area with every chat that needs the user. It is the normal Work grid
(`WorkGridView` over `PaneTilingLayout`, with standard chat surfaces). The
differences:

- **Members come from the sidebar.** `workFocusQueue` (`workLaneFocus.ts`)
  returns each agent chat that needs the user: a raised hand, a stale or
  stalled run, a wake that came due and never started, or a failure the user
  has not left. This is the `holdsOut` flag the fold reads, so a clean finish
  gets no tile. Plain shells get none; a nested row gets one only while it
  asks for the user or its wake came due. Other machines' chats come in with
  their row's binding. `SessionListPane` reports the list
  (`WorkFocusQueueItem`) through `onFocusQueueChange`, so the grid and the
  list agree; the sidebar stays mounted while collapsed to keep the report
  live.
- **No Tools pane.** Each chat header shows **Open in full view**
  (`WorkHeaderOpenFullViewButton`). A sidebar click focuses a tile, or opens a
  chat with no tile in the normal view. New chat leaves the grid.
- **Stable layout.** `stableFocusOrder` keeps tiles in place. The layout is
  saved per set of chats (`makeGridLayoutId(project, "focus-<hash>")`); a new
  set starts from the even auto layout.
- **Pages.** `focusFit` measures the grid box (ResizeObserver, CSS pixels) at
  `FOCUS_TILE_MIN_WIDTH` × `FOCUS_TILE_MIN_HEIGHT`, for a capacity between one
  and `MAX_WORK_GRID_TILES`. The minimum height is high, so a second row comes
  only when both rows clear it. **Chats per page** (Settings › Appearance ›
  Focus grid, `interfacePreferences.focusGridMaxChats`, Automatic by default)
  can lower the capacity, never raise it. `focusEvenPages` uses the fewest
  pages and spreads chats evenly (8 into room for 6 → 4 + 4).
  `focusPageColumns` prefers side by side (4 into 3 columns → 2 × 2). Only the
  page on screen is mounted.
- **Roster, sidebar open.** The sidebar is the roster: `useWorkFocusGrid`
  builds the marks for `SessionListPane`. Only the focused tile's card is
  filled; a card on another page gets "Page N" (an accent dot when it arrived
  unseen). `WorkFocusToolbarPager` ("‹ 1–3/6 ›") takes the List/Board
  toggle's place, and the search hides its "⌘K".
- **Roster, sidebar collapsed.** `WorkFocusRoster` under the grid: one chip
  per waiting chat (logo and title), grouped by page, the page on screen lit
  and the focused chat highlighted. A chip goes to its page; a right-click
  opens the card menu. The right side reads "Chats 5–7 of 7 / Page 2 of 2" (or
  "N waiting"). The strip is 41 px, scrolls sideways and keeps the lit page in
  view.
- A chat that arrived on another page has an accent dot (chip or card, and the
  arrow toward it) until the user goes there. A sideways two-finger swipe
  flips a page (`wheelScrollsInside` lets a wide code block keep it); the new
  page slides in (180 ms, none under reduced motion).
- **PR badge.** A tile's PR badge opens the PRs tab (`prOpensPrsTab` on
  `ChatGitToolbar`), by number and repo for another machine's lane.
- **Machine.** Each tile takes its chat's binding from the Focus list, not
  from the remembered pin, which arrives one effect late.

### Grid chrome (all Work grids)

- Tiles meet edge to edge. The splitter takes no width: a 1 px line, a hit
  area over both edges, accent on hover or drag. Tiles are square and
  borderless; the lane tint stays on the header.
- The centred header reserves the right cluster's width on both sides; under
  140 px the title moves left and truncates. Labelled header links
  (`.ade-header-collapsible-label`) collapse to icons under 640 px.
- One Tools pane serves the focused tile. Only its toggle reads open; another
  tile's toggle moves the pane to that chat. The pane shows **For ● lane ·
  chat** while the active chat is in a grid (`WorkSidebar showOwner`).

## Grid mode: `PaneTilingLayout` + `workSessionTiling.ts`

- `buildWorkSessionTilingTree(sessionIds, preset = "auto")` seeds the tree
  when nothing is saved for `gridLayoutId`, and serves the arrange menu.
  `auto` is near square (`columnCount = ceil(sqrt(n))`, earlier rows take the
  remainder); `rows` and `columns` give one split per session. Floors:
  `MIN_PANE_SIZE` 8%, `MIN_ROW_SIZE` 12%.
- `WorkViewArea` builds one `PaneConfig` per session (title, status dot,
  close, mouse and context handlers, a `grid-tile` `SessionSurface`).

## Pane tiling layout primitives

`PaneTilingLayout` (`components/ui/PaneTilingLayout.tsx`) and `paneTreeOps.ts`
serve the Work grid, `LanesPage`, `TerminalsPage` and history views.

- **Seed tree.** The `tree: PaneSplit` prop; `collectLeafIds(tree)` is the
  expected pane list.
- **Persistence.** The saved tree comes from `tilingTree.get(layoutId)`;
  every change is written back after 300 ms. Panel sizes are a separate
  `DockLayoutState` store, reset on each tree change so new panels start at
  `defaultSize`.
- **Reconciliation.** `reconcilePaneTree(candidate, expectedPaneIds,
  fallback)` drops unexpected leaves, flattens one-child splits and adds
  missing ids by splitting the heaviest leaf (alternating direction).
  Duplicates or unknown ids replace the tree with the fallback.
- **Drops.** `detectDropEdge` uses a 25% edge band. The centre swaps
  (`swapPanes`); an edge calls `splitPaneAtEdge` (`right`/`bottom` keep the
  target first).
- **Minimize.** A leaf shrinks to `LEAF_MINIMIZED_{HEIGHT,WIDTH}_PX`; a split
  whose leaves are all minimized compacts (`COMPACTED_WIDTH_PX`, or
  `COMPACTED_HEIGHT_PER_LEAF_PX × leafCount`). Un-minimize restores the size.
- `FloatingPane` takes `onPaneMouseDown` / `onPaneContextMenu`; `PaneConfig`
  passes a `className` through (for example `ade-work-glass-tile`).

## Right-edge Work sidebar: `WorkSidebar.tsx`

The tools pane follows the active lane and session. It shows beside
`WorkViewArea` when `workSidebarOpen` is true and the view is not `grid`. A
5 px separator resizes it (`workSidebarWidthPct`).

### The splitter is clamped in two units

`workSidebarSplitter.ts` holds the rule. The percentage clamp
(`MIN_WORK_SIDEBAR_WIDTH_PCT` 26 to `MAX_WORK_SIDEBAR_WIDTH_PCT` 55, also in
`normalizeWorkSidebarWidthPct`) is one unit. A drag also keeps at least
`MIN_WORK_SIDEBAR_PANE_PX` (280) of pane and `MIN_WORK_CONTENT_PANE_PX` (360)
of chat column. With no container width, only the percentage applies.
`WORK_SIDEBAR_SPLITTER_PX` is 5; arrow keys move 2%
(`WORK_SIDEBAR_KEYBOARD_STEP_PCT`).

During a drag `TerminalsPage` sends `ade:work-sidebar-browser-resize-start` /
`-end` (`lib/workSidebarBrowserResize.ts`). `useNativeBrowserViewBounds` then
pushes bounds every frame, and for 400 ms after, measured on the pane's
content box, so the browser view does not paint over the chat column.

### A tab strip, and a picker page behind it

The pane is a tab strip and one page: one tab per open tool, and the picker
when you press the grid button or `+`. A tool is open once. There are six
tools: Terminal, Browser, Git, Files, Simulator, App Control (catalogue in
`workTools.ts`). PRs have their own tab.

**The picker** (`WorkToolPicker.tsx`) is one centred column, at most 512 px
(`COLUMN_MAX_PX`), with no title.

- It centres on the whole pane with `m-auto` (a `justify-center` child in a
  scroller loses its top).
- The grid is `auto-fit` over `CARD_MIN_TRACK_PX` (188): two columns or one,
  never three, so cards grow with the pane. An odd last card spans the row.
- A card: a 16 px glyph, the name and one line. The only mark is a red dot
  when the tool is broken (`workToolHasError`). Cards are glass
  (`.ade-tool-card`: 82% fill, a 12% hairline, no `backdrop-filter`).
- Arrow keys move a highlight and focus; a pointer move drops the keyboard
  highlight. The last-opened tool has `aria-current` and no fill.
- `workToolSummary` picks the line: the tool's status (with an error count),
  else the catalogue `hint`, else the reason it is unavailable. Git shows
  unpublished, dirty count, ahead/behind or pushed age. Files shows tracked
  files and changed entries (an entry is counted once; a payload with no
  entry count says `dirty`). Status comes only from reads the pane already
  makes, so nothing polls. Lines shimmer for at most 300 ms
  (`useWorkToolStatuses.ts`). The tooltip shows only when the text clipped.

**The backdrop** (`WorkToolPickerBackdrop.tsx`) is a violet-to-indigo WebGL
mesh. `backdropThemeFor` feeds it ADE's colour tokens (weaker in light). The
Work new-chat surface uses the same backdrop.

- Budget: DPR 1, at most `BACKDROP_PIXEL_BUDGET` (600 k) pixels, at most
  30 fps gated on the rAF timestamp. It stops while the window is blurred,
  hidden or out of view. Reduced motion paints one frame. The cursor swirl
  needs `(hover: hover)` and `(pointer: fine)`.
- A CSS gradient paints first. While a tool is on screen the picker stays
  mounted, `inert` and paused (`playing={false}`).
- Every path that drops a context uses `releaseContext` (lose it, 1×1
  buffer); unmount defers through `pendingContextReleases`. A
  `webglcontextlost` switches to the static backdrop with no restore.
- Layout reads are one `getBoundingClientRect` per frame. With no WebGL there
  is no canvas: `.ade-tool-picker-static` instead.
- The canvas is `aria-hidden` and `pointer-events: none`, on a non-scrolling
  wrapper. `resolveBackdropSize` holds the size rule.

**Availability.** A tool that cannot run shows a disabled card with the
reason. The one reason left is "The runtime for this project is not a Mac"
(`iosSimulator.getStatus().supported` false on the bound runtime). Every tool
follows the session's machine, a remote Mac included. The browser is this
desktop's, so it stays available on remote lanes. On the web client the
browser and App Control are read-only (`isReadOnlyWorkTool`); the simulator is
not. `workToolAvailability` decides from capability flags, never
`process.platform`. A tool that becomes unavailable falls back to the picker.

**The header** (`WorkToolHeader.tsx`, 32 px) is the strip on both pages:

- `⊞ Tools` back to the picker (also `Esc`, `work.tools.picker`), lit while
  the picker shows. Then one tab per open tool (glyph, name, `×` on hover),
  then `+` (hidden while the picker shows), then dots for live tools with no
  tab, then the close ✕. The lit tab is the title. Float and Maximize sit on
  each tool's own row (`WorkToolPreviewControls`).
- The `×` is a sibling of the tab button, `pointer-events: none` until hover
  or focus. On a 24 px icon tab it is a top-right badge, which the activity
  dot yields on hover.
- The strip is a `tablist` with a roving tabindex, `aria-controls`
  (`workToolPanelId`) and manual activation (`←`/`→`/`Home`/`End` move focus
  only).
- `workToolContextLabel` gives one fact per tool (Git: the branch; Files: the
  lane; others: the status line) in the active tab's tooltip and name.
- `workToolTabLayout` measures: under 420 px tabs drop their words, then extra
  tabs move to a `…` menu. The active tool never overflows.
- A dot's colour is its state (`workToolDotState` / `workToolDotColor`): red
  error, amber needs you, the tool's hue for live, none when idle.
- Motion: picker ↔ tool 180 ms with a 4 px shift, tab ↔ tab 120 ms opacity;
  card hover lifts 2 px with an accent glow; reduced motion keeps only colour.

**Mounting and close.** Only the active tab is mounted. Inactive tools keep
their main-process service. `hideBuiltInBrowserView` parks the browser view on
every switch, close, deactivation and unmount. Closing a **tab** stops the
tool (`closeWorkToolForReal`, on its runtime pin): the browser closes its
tabs, App Control calls `appControl.stop`, the simulator
`iosSimulator.shutdown` (`ignoreOwnership`), the Mac Desktop
`mac_desktop.stop`. A failure is logged and the tab still closes. Closing the
**pane** stops nothing.

### Which tools are open is per lane

- `workSidebarTool` (null = picker) and `workSidebarOpenTools` are stored per
  lane in `laneWorkViewByScope` (`"<projectKey>::<laneId>"`) through
  `useWorkSidebarTool(laneId, runtimePin, chatSessionId)`. The pin sends
  `work_tools.setActiveTool` to the chat's machine; the chat id is the owner
  for a tab-close stop.
- A pick appends a tab or activates it. A close hands the pane right, then
  left, then to the picker (`openWorkToolTab` / `closeWorkToolTab`). The
  picker keeps the strip. Version 6 state becomes a one-tab strip.
- A lane with no choice uses the project-scoped copy, as does a lane-less
  surface. `workSidebarOpen` and the width stay project-wide; any pick opens
  the pane.
- Other surfaces file a request (`workToolRequests.ts`) that the Work page
  runs against the right scope, now or on mount: the browser open-request
  handler and the palette's `Tools: …` rows (`buildWorkToolCommands`).

### The pane follows the chat's machine

`WorkSidebar` takes `runtimePin` (`resolveSessionRuntimePin(activeWorkSession)`;
null is the tab's machine). Every tool follows the chat.

- **Lanes.** The active lane resolves through `useLanesForPin(runtimePin)`, so
  a foreign chat has a worktree path and lane-mismatch messages name real
  lanes.
- **Keys.** Each panel has a machine key (`work-git:<pinKey>:<laneId>`,
  `work-terminal:…`, `work-files:…`, `work-ios:…`, `work-appcontrol:…`,
  `work-browser:…`). Diff selection resets on a pin or lane change.
- **Offline.** With the pinned machine offline, Git and Terminal show
  `"<machine> is offline."` and the App Control and simulator probes are
  skipped. Names come from `machineNameForBinding` and are never "remote".
- **Pinned calls.** `appControl.getStatus` / `onEvent`,
  `iosSimulator.getStatus` / `onEvent` and `terminal.write`. The pin goes to
  `LaneGitActionsPane`, `LaneDiffPane`, `ChatTerminalDrawer`,
  `ChatIosSimulatorPanel`, `ChatAppControlPanel`, `ChatBuiltInBrowserPanel`
  and `FilesTab`.

Tabs:

- `git` — `LaneGitActionsPane`, with `LaneDiffPane` under it when a file or
  commit is selected.
- `files` — `FilesTab` with `embedded`: no title block, `View lane`, theme
  toggle, `Open In` or count; monochrome glyphs; one chrome row with the
  breadcrumb. Under `EMBEDDED_SINGLE_SURFACE_PX` (520) it shows the tree or
  the editor, not both; the hidden one is `inert`, so focus claims (⌘F) check
  `host.closest("[inert]")`.
- `terminal` — `ChatTerminalDrawer` (`panel`) on the terminal owner. **Split**
  stacks a second, different shell (kept as a tab id, so closing it ends the
  split); **Clear** runs `clearTerminalRuntimeScrollback`. The shell count
  goes out through `workTerminalShells.ts`.
- `ios` and `app-control` — `ChatIosSimulatorPanel` and `ChatAppControlPanel`
  for the lane, on the pinned machine.
- `browser` — `ChatBuiltInBrowserPanel` over this window's `WebContentsView`
  tabs (per window; one `persist:ade-browser` partition). Leaving the tab or
  closing the pane runs `hideBuiltInBrowserView()` (`stopInspect`, zero
  bounds, `visible: false`). For a foreign chat, loopback URLs tunnel to that
  machine; see
  [The ADE browser for a remote chat](../remote-runtime/README.md#the-ade-browser-for-a-remote-chat).

**Browser tabs.**

- Each tab has a fixed `groupLaneId` (where it opened, or its agent's lane).
  `orderBrowserTabsByLane` (`chat/browser/browserTabGroups.ts`) puts the
  current lane first, then other lanes by first open, then no lane.
  `BrowserTabStrip` outlines tabs in their lane colour; the robot mark shows
  only while a chat holds the tab (`ownerChatSessionId`).
- Leases expire when idle. Every agent sees every tab: a free tab is
  `claimable`, another chat's is `heldByOtherChat`, and `ade browser status`
  names the owner. Any agent may close any tab; claiming a held one is
  refused. A command with no tab from a chat that owns none is refused.
- Over the tab limit (20 per collection, "Tabs per project"), the error lists
  only the caller's and unkept agent tabs. A deleted lane frees its tabs. A
  restart restores user tabs and kept agent tabs, not OAuth pages.
- **Zoom-aware inspect.** The overlay sits outside the preview's body zoom and
  probes the pointer at both scales, keeping the element that contains it.
- **Login handoff.** `ade browser handoff --tab <id> --reason "..."` runs
  `startHandoff` (`builtInBrowserService.ts`): it parks the lease in
  `handoff.previousOwner`, clears the navigation guard, makes the tab
  human-owned and opens the pane. While `tab.handoff` is set, agent calls on
  the tab throw `handoff_active`; the pane's own calls pass. The pane shows
  the reason and **Hand back**, then "Signed in? / Hand back now / Keep
  control" after the origin changes. Only a person can hand back
  (`endHandoff` on IPC, and on the runtime bridge for user clients only). Tab
  close and the timeout (15 min) also end it; each end restores the lease and
  writes `handoff-end` (`endedBy`, `durationMs`).
  `builtInBrowserHandoffSession.ts` raises the chat's hand, clears it at the
  end and adds the card "Handed back to the agent". The CLI also sends a push
  ("Sign in for me") and waits unless `--no-wait`. iOS shows it read-only
  (`WorkToolsBrowserTab.handoffReason`).

**Context insertion.** `WorkSidebarContextTarget` is one of:

- `chat` for a chat session, or `draft` (`draftTargetId`, `laneId`,
  `draftKind`) with no session but a draft composer. These get window events
  (`ade:agent-chat:add-attachment`, `add-ios-context`,
  `add-app-control-context`, `add-builtin-browser-context`, `insert-draft`).
- `pty` (`sessionId`, `ptyId`, `toolType`) for a tracked agent CLI. The
  selection is formatted by `lib/visualContextFormatting.ts` and written as a
  bracketed paste through `terminal.write(..., runtimePin)`, then
  `ADE_WORK_PTY_CONTEXT_INSERTED_EVENT` lets `TerminalView` show a mark.
- With no target, panels drop the attach controls with no banner.
- PTY insertion works across machines. Chat insertion is a DOM event, so a
  foreign chat gets "Tool context insertion is not available for chats on
  another machine."
- `isPtyContextInsertableToolType` (`lib/sessions.ts`): claude, codex,
  cursor-cli, droid, opencode. Shells host terminals but take no context.
- `terminalOwnerSessionId` comes from the active session (a chat, or a
  running insertable CLI with a `ptyId`, on any machine), and from
  `contextTarget` only with no active session.
- The one banner is **lane attribution**: the pane's own App Control and
  simulator subscriptions see a tool started from another lane and say so,
  with the catalogue names (`workToolLabel`). It does not block insertion.

Open state and width go through `setWorkSidebarOpen` /
`setWorkSidebarWidthPct`; the tool through `useWorkSidebarTool(laneId).setTool`,
which also opens the pane. The toggle is the mirrored `SidebarSimple` on
`WorkSurfaceHeader`. A Work tile's `AgentChatPane` gets
`hideLaneToolDrawers`, so the simulator and App Control toggles live only in
the pane; Proof stays on the chat header.

### One chrome vocabulary: `workToolChrome.tsx`

- One chrome row per tool, 40 px (`WORK_TOOL_CHROME_ROW_HEIGHT`), under the
  32 px header, with `ade-pane-chrome` (`select-none`) and the
  `ade-tool-pane-rule` hairline.
- Ghost controls: hover and press change fill only, over 120 ms
  (`WORK_TOOL_CHROME_MOTION`). Focus is an inset hairline
  (`WORK_TOOL_CHROME_FOCUS`).
- Icons are 16 px (12 px in a chip). Tooltips carry the words.
- A content surface (terminal, diff, App Control stage) is inset 8 px with a
  10 px radius and a 1 px inset ring.
- The browser builds its own row and App Control a bordered one, with the
  same height and motion constants.

### One set of tool feeds, shared

`useNativeToolSessions.ts` holds the browser, App Control and simulator
subscriptions, one capability gate and one meaning of "live". `TerminalsPage`
mounts it once and shares it through `NativeToolFeedsContext.tsx` with the
pane and the corner card. Browser error badges fold pushed `diagnostics`
events (`workToolErrors.ts`); a main-frame navigation resets the count.

### The floating live-preview card: `WorkLiveCornerCard.tsx`

A live thumbnail of the most recent screen tool that is not on screen, in a
corner of the chat column, one click from taking the pane back.

- **Size.** Width is the user's (default 288 px, 200–560, at most half the
  column). Height is `width / aspect`, capped near 340 px; the 200 px floor
  beats the cap, and the column height beats the floor. The aspect is the
  source's natural size for every tool (the browser's parked view has a real
  size; see
  [Corner card and parked preview views](../chat/README.md#the-corner-card-and-parked-preview-views)),
  else 16:10 (3:4 for the simulator). Everything is `object-fit: contain`. A
  corner handle resizes width; frames are asked for at device pixels.
- **Chrome.** An 8 px status dot at rest; on hover a 32 px pill (icon, name,
  last action, ✕) that is also the drag handle. A 2 px scrub strip overlays
  the bottom; the hovered frame is held by trace id. Browser activity is
  `browserActivitySignature`, so the card's own stream close does not count.
- **Which tool.** `selectWorkLiveCardTool` (`workLiveCard.ts`) picks the
  live, non-active tool with the newest activity, seeded from `getStatus` too.
  A floated tool shows before its first paint and outranks the rest. The
  card's only candidate is `browser`; App Control, the Apple device and the
  Mac Desktop have their own players.
- **It steps aside** while any floating player shows
  (`useAnyFloatingPlayerShown`, `floatingPlayerSlots.ts`) and tears down its
  feed; a hand-floated tool still shows. It also steps aside while the tab has
  a `loadError`, keeping the float.
- **It belongs to the open chat.** It shows only sessions the chat owns (a tab's
  `ownerChatSessionId`, a session's `chatSessionId`). An unowned session shows
  only in a chat whose pane showed it (`workLiveCardSeenByTool` in the chat's
  companion state). A floated tool's float ends with its session.
- **Off stays off.** ✕ records the session per chat
  (`chatCompanionUiState.ts`). `isWorkLivePreviewEnabled` is presence-based,
  so a new session does not reopen it. Each tool row's “Show preview when
  minimized” toggle (`WorkToolPreviewControls`, on by default) clears or
  writes the same marker (`setWorkLivePreviewEnabledForChat`). Frames and
  remounts never reopen it.
- Position and width are project-scoped (`workLiveCardPosition`,
  `workLiveCardWidth`); a resize re-clamps the position. A narrow column
  shrinks the card to its minimum.
- **Cost.** It uses existing feeds (App Control's screencast, the browser's
  refcounted preview stream, the H.264 device stream), paints inside one rAF
  with no React renders, and drops every feed when Work is not active.
- **Parked, not hidden.** A browser tab with a preview subscriber is moved
  past every display instead of detached, because a hidden view captures
  nothing.

### The shared floating player

`components/shared/FloatingPlayer.tsx` is the shell for the floating Apple
device and Mac Desktop: drag, resize from any edge, a status dot at rest, and
a hover bar (Open in pane, picture in picture, Close). During picture in
picture the box stays composited at near-zero opacity with no pointer input.

`MacDesktopMiniPlayer.tsx` mounts beside the corner card.
`macDesktopFloatState` shows it for the open chat when that chat may see the
lane's desktop (viewer, lease holder or a grant), the preview is not
dismissed, and there is a picture, the Off state, a float or a held decoder.
It hides while the pane shows Mac Desktop. Close records
`display:<displayId>:<createdAt>` per chat. Place and width are one window
choice (`ade.macDesktop.floatingPlayer.v1`).

`macDesktopLiveViewLease.ts` shares one decoder per lane. The first holder
starts the stream and the last stops it; the pane outranks the player. One
lane never has two decoders.

### Tooltips and menus in the pane

- `ui/PaneTooltip.tsx` over `ui/tooltipPosition.ts`: flip before shift, and
  never over the trigger.
- `ui/paneMenuTokens.ts` paints both pane menus (the browser's Radix
  `DropdownMenu` and App Control's own menu, which hosts inline forms). The
  tokens hold paint and width only. App Control's menu stays inside the pane.
  Max height follows the viewport.

## Terminal renderer: `TerminalView.tsx`

xterm.js with `FitAddon`.

- **Cache.** `Terminal` instances live in a module map keyed by
  `terminalRuntimeKey` (`runtimePin`, `projectRoot`, `sessionId`, `ptyId`); a
  pin adds a `pin:<kind>:<key>::` prefix. Each entry records its
  `(projectRoot, projectRevision)`; `disposeStaleRuntimes` clears entries
  whose own project aged out, not when another project tab is active.
  `projectRevision` is in `useAppStore`.
- **Renderer.** WebGL first, the DOM renderer on any failure or context loss.
  At most `MAX_WEBGL_TERMINALS` (8) hold a context (Chromium keeps 16 per
  page). A DOM cursor blinks through `lib/xtermCursorBlink.ts` (a 500 ms
  flip, no per-frame restyle).
- `TerminalHealthCounters`: `fitFailures`, `zeroDimFits`,
  `rendererFallbacks`, `droppedChunks`, `fitRecoveries`.
- **Fit recovery.** Invalid dims (`cols < 20`, `rows < 6`, host under
  `MIN_HOST_WIDTH_PX` 120 / `MIN_HOST_HEIGHT_PX` 48) restore the last good
  dims and retry after `INVALID_FIT_RETRY_MS` (90 ms). The host size is the
  max of the three DOM measures.
- `isActive` gates input; `isVisible` gates fit and resize.
- `terminalPreferences` changes apply live (font, size, line height,
  scrollback) and clear the WebGL atlas.
- **Frame writes** coalesce on rAF while visible and foreground, else on a
  16 ms timer (`flushPendingFrameWrites` / `clearFrameWriteSchedule`).
- **Reveal.** `WORK_SURFACE_REVEALED_EVENT` (from `PersistentWorkSurface`)
  clears the atlas, flushes writes, refits on the next frame, refreshes, and
  focuses and scrolls the active tile. Hidden surfaces get no resize events,
  so this is the one signal.
- **Runtime pin.** `runtimePin` (null on the hot path) is stored on the cached
  runtime and goes on `pty.write` / `pty.resize`, `terminal.preview`,
  `sessions.get`, `sessions.readTranscriptTail`,
  `agentChat.saveTempAttachment`, `pty.setDataSubscriptions` and
  `pty.onData` / `pty.onExit`. Listeners and the main-side id filter are
  grouped per pin. A pin that resolves late moves the key;
  `teardownRelocatedRuntimes` disposes the old runtime.
- **Hydration.** `ade.terminal.preview` first.
  `serializeSnapshotForHydration`: an alternate-buffer snapshot repaints the
  visible rows (`serializeSnapshotVisibleRows`); a main-buffer snapshot writes
  the `serialized` scrollback (else the visible rows). With no snapshot, the
  transcript tail.
- **Replay.** For a disposed session (`sessions.get`),
  `sessions.readTranscriptTail({ raw: true })` (up to
  `REPLAY_TRANSCRIPT_MAX_BYTES`, 8 MB) goes through
  `stripFullScreenRedrawSequences()` (alt-screen switches, `\x1bc`, full
  erases), with `REPLAY_SCROLLBACK_LINES` (100 000) and no
  `trimToLikelyTerminalFrameBoundary`. A session that ended while mounting
  has its live output replaced (`canReplayOverLiveData`) unless the replay is
  shorter or the alternate screen is up.
- **Backfill.** With nothing renderable but live data on screen,
  `scheduleHydrationBackfill` retries the preview every ~100 ms (120 tries);
  it re-arms when a visible tile has empty rows.
- **Stream recovery.** The hosted web adapter marks a full snapshot as
  `PtyDataEvent.replace`. The view bumps its hydration generation, cancels
  timers, drops queued writes, resets xterm and writes the snapshot. Async
  hydration steps check the generation. Deltas stay append-only.
- **Mouse.** `updateTerminalInputModes` tracks DECSET 1000/1002/1003. On
  macOS, `terminalMacShiftSelection.ts` turns Shift+drag into xterm's force
  selection only while mouse tracking is on.
- **Scroll hint (web only).** A wheel over a mouse-tracking session shows a
  pill with the provider's scroll keys (`terminalScrollHint.ts`): Claude and
  OpenCode `PgUp`/`PgDn`, Codex `Ctrl+T` first, `Fn+↑`/`Fn+↓` on Apple
  keyboards. Droid and cursor-agent get none. Dismissal is per provider.
- **⌘C** with no selection sends `\x03` on macOS.

Font stack: `ui-monospace`, `SFMono-Regular`, `Menlo`, `Monaco`,
`Cascadia Mono`, `JetBrains Mono`, `Geist Mono`, `monospace`.

## Empty state: `WorkStartSurface.tsx`

With no open session, Work shows `WorkStartSurface`: an `AgentChatPane` in
draft mode (`forceDraftMode`, `embeddedWorkLayout`, `hideLaneToolDrawers`)
with `workDraftKind`. `draftContextTargetId` lets the tools pane insert
context into the draft.

- `ModeSwitcherPills` (`WorkViewArea.tsx`) picks `draftKind`
  (`WorkDraftKind = "chat" | "cli" | "shell"`): **Chat** composes an ADE chat,
  **CLI** starts a tracked agent CLI, **Shell** opens a plain shell in the
  lane's worktree.
- The lane picker (`LaneCombobox`) sits on the launch shelf. The draft machine
  and lane come from the Start on picker.
- A chat draft keeps the ADE wordmark and a transparent canvas, so the picker
  backdrop shows through. The usage card sits under the launch shelf.
- A CLI draft uses the same composer: the model picker lists CLI-capable
  models (`allowCliOnlyModels`), a prompt or context is required, and the
  launch passes `runtimeCliLaunch` (provider, permission mode, model, effort,
  fast mode, the initial prompt, and a credential or account) with
  `startupDelayMs` (`workCliStartupDelayMs`, 180 ms) to `onLaunchPtySession`.
  The host builds the command. The tab title comes from the prompt or
  `LAUNCH_PROFILE_TITLE`.
- A shell draft opens an untracked shell PTY (`profile = "shell"`).
- With the sessions list collapsed, a thin left rail offers **Show sessions**.

`apps/desktop/src/shared/cliLaunch.ts` holds the launch registry for every
CLI provider (`CliProvider`, `LAUNCH_PROFILE_TOOL_TYPE`,
`LAUNCH_PROFILE_TITLE`); `components/terminals/cliLaunch.ts` re-exports it and
defines `WorkPtyLaunchArgs`. iOS `work.startCliSession` uses the same module.

- `buildTrackedCliLaunchCommand` returns `{ command?, args, startupCommand,
  env? }`. Each provider maps the permission mode to its own flags
  (`permissionModeTo*Flags`):
  - Claude: `--permission-mode`.
  - Codex: `default` and `edit` are `--sandbox workspace-write
    --ask-for-approval on-request`; `plan` is read-only; `full-auto` is
    `--dangerously-bypass-approvals-and-sandbox`; `config-toml` defers to
    `.codex/config.toml`. Fast adds `service_tier` (`ultrafast` for Codex
    Ultrafast); a resume that sets Fast itself uses plain Fast. ADE does not
    rewrite Codex `mcp_servers`.
  - Cursor: `--mode plan|ask` or `--force`; an initial prompt goes in after
    readiness.
  - Droid: a settings JSON written before `droid --settings
    $ADE_DROID_SETTINGS`.
  - OpenCode: the intent rides in `ADE_OPENCODE_LAUNCH` (none for
    `config-toml`). `attachOpenCodeTerminal`
    (`services/opencode/openCodeTerminal.ts`) creates the session with the ADE
    agent and model on ADE's shared server and runs `opencode --server <lease
    url> --session <id>`. It strips flags the 2.0 TUI rejects (`--agent`,
    `--model`, `--variant`, `--mini`, `--replay*`) from old resume commands.
  - The other providers have their own `permissionModeTo*Flags` and model
    helpers in the same file.
- Every provider gets ADE CLI guidance: Claude through
  `--append-system-prompt` (dropped on the shell fallback), the others as a
  leading prompt or initial input.
- `resolveTrackedCliResumeCommand(session)` and
  `buildTrackedCliResumeCommand(metadata, overrides)` build the resume line
  for the continuation composer. `sendToSession` passes the first follow-up as
  the `prompt` override; `resumeSession` passes none.

## Context menu: `SessionContextMenu.tsx`

One grouped menu; every row has a 13 px duotone glyph.

- **Name & status** (chat rows): **Rename…**, **Generate chat title**,
  **Generate lane name**, **Generate status line**, **Generate all three**.
  Other rows keep Rename (inline, `manuallyNamed: true`) beside Set tag, pin
  and grid removal.
- **Lifecycle**: runtime stop, Snooze/Wake, Settle/Un-settle.
- **Go to**: the lane and web links. A child chat gets **Open <parent>**, and
  **Stop reports to <parent>** or **Report back to <parent>**.
- **Copy**: the session id and deep link.
- The red block at the end: Stop & delete, Delete chat, Delete session.
- Keyboard: Shift+F10 or the Menu key opens it; arrows, Home and End move;
  Enter runs; Escape closes and returns focus (`ContextMenuSurface`).
- Chat: Set tag… (running Claude only) and **Change status**. A settle clears
  the hand in the same write.
- **Hand off…**: **Local handoff** and **Another machine** select the row and
  send the intent through `lib/chatHandoffIntent.ts` (see
  [Chat Actions and Sources](../chat/composer-and-ui.md#chat-actions-and-sources)).
  **Auto handoff…** / **Edit auto handoff…** / **Remove auto handoff** open
  `AutoHandoffModal`, hosted at the menu level. A failed rule read keeps the
  item disabled.
- Metadata generation makes one structured request and applies only the
  chosen fields. A status refresh sends the lane name, title, worktree folder
  and the last assistant paragraphs; a title refresh sends the transcript; a
  lane-name refresh sends the lane's other threads and the git diff from the
  base. Fields show `Naming …` while they generate. An edit made meanwhile
  wins for its field. Generate lane name is off for the main checkout.
- PTY: Stop runtime / Stop & delete while running, Delete session after exit,
  **Change status**. A tracked CLI at its own prompt with no recorded hand
  keeps **Done** off ("Resolve the prompt in the terminal first"); a
  `cli_prompt` hand can be dismissed.

**Change status** (its hint names the current column) lists **Working**,
**Needs you**, **Done**, the snooze times (or **Wake now**), then
**Unsettle** / **Keep active** for a settled row. The three columns call
`session.moveOnBoard`, as a board drag does, through `moveSessionOnBoard`
(`sessionBoardMoveUi.ts`, a 5 s undo); a foreign row is read again after a
move or undo. `lib/sessionStatusChange.ts` decides what is offered, and each
disabled entry names its reason:

- **Working** only when the session is live (running, or live background
  work): "Nothing is running — send a message to start it". It is refused over
  a provider card, on an at-rest failure, on an ended or detached row, and
  while a derived wait would file it back to Waiting.
- **Needs you** is always offered. A running chat gets "The user set this
  chat's status to Needs you. Ask them what they need before you continue." A
  tracked CLI gets a session-worded copy at a free prompt.
- **Done** clears the hand and settles. It is refused over a provider card
  and on a tracked CLI in Needs you with no recorded hand.
- **Snooze** expands into `resolveSnoozePresets` (`In 1 hour`, `This
  evening` until an hour before 18:00, `Tomorrow`, `Next week`, `Until I'm
  asked`). A snoozed row shows **Wake now**. **Unsettle** clears `settledAt`;
  **Keep active** and `settleOverride` pin a state.
- **Waiting** is never a target; only its snooze is the person's to set.
- The block is exhaustive, so every hidden row can come back. Snooze and
  settle go through `sessionLifecycleActions.ts`, columns through
  `sessionBoardMoveUi.ts`, so the menu, board, `SessionSnoozeControl` and chat
  header chips agree.

A singleton lane's menu adds a **Lane** submenu (`LaneActionsSubmenu`) built
from the same `buildLaneMenuGroups()` model as `LaneContextMenu`. A foreign
card passes its `lane`, `binding` and `machineId`: **Start chat in lane**
writes `draftMachineId`, colour and manage go to that runtime, and tab or
split actions are left out. **Open lane menu…** shows only when the lane
cannot be resolved. Submenus share `MenuSubmenu` (180 ms open, 300 ms close
grace, clamping, keys).

Rename submits `agentChat.updateSession({ title, manuallyNamed: true })` for
chats and `sessions.updateMeta(...)` for PTYs; errors go to `renameError`.
`Set tag…` (running `claude-chat` only) submits
`agentChat.updateSession({ sessionId, tag })`; empty clears it, and
`claudeTag` shows as a pill on the card.

## Work view hook: `useWorkSessions.ts`

- **Lists** come from `listSessionsCached()` keyed by project, lane and
  status. `mergePendingOptimisticSession(persisted, optimistic)` keeps the
  optimistic `ptyId` on a running persisted row that lacks it (and fills
  `toolType` / `runtimeState`), with `keepPending: true` until the row catches
  up; a matching `ptyId` drops the pending entry.
- **View state** per project (open items, active and selected, view mode,
  draft kind, filters, lane order and pins, organization, collapsed ids) and
  per lane (`projectRoot::laneId`), saved to `ade.workViewState.v1` on each
  change.
- `refresh({ showLoading, force })` busts the cache.
- **Project switch.** Cached rows render at once but are not authoritative
  until the project's refresh applies; until then the hook does not write
  `sessionsCacheByProject` or prune open tabs.
- **Draft lane.** `setDraftLaneId` writes only `draftLaneId`, never
  `selectLane`, because the draft can target another machine whose lane ids
  the bound project does not know. `WorkStartSurface` syncs the global lane
  only when the draft machine is the bound one.
- **Routing.** One `useWorkMachineRouter()` gives `machineRouter` and
  `resolveSessionRuntimePin` (down to each `SessionSurface` as `runtimePin`).
  `canMutatePinnedProjectUi` is `machineRouter.isLivePin`. Launch and resume
  remember their pin; `stopRuntime` / `stopAll` resolve the pin from the
  cross-machine union.
- `useWorkSessions({ active })`: with `active: false` the hook schedules no
  refresh and defers the first one until Work is shown.
- Exposes `openSessionTab`, `focusSession`, `selectLane`,
  `upsertOptimisticChatSession` (also used by `chatSessionEvents.ts` for
  headless chats), `refresh`, `setWorkSidebarOpen`,
  `setWorkSidebarWidthPct` (26–55%), `setWorkSessionFilters`,
  `toggleWorkLanePinned`, `setWorkLaneSortMode` and `reorderWorkLanes`. Each
  view setter replaces a deep link's framing. A reorder starts from the
  lanes on screen and sets Manual. The tools pane tool is in
  `useWorkSidebarTool`.
- `useLanePrsByLaneId` gives one coalesced PR read plus `prs-updated` for the
  bound machine, joined with other machines' PR rows. With no active chips
  the filtered list is the same reference.
- **`launchPtySession(WorkPtyLaunchArgs)`** returns `WorkPtyLaunchResult`.
  The args carry `laneId`, `profile` (`LaunchProfile`), `title`,
  `permissionMode`, `command`, `args`, `startupCommand`, `startupDelayMs`,
  `env`, `initialInput`, `runtimeCliLaunch`, `tracked`, `disposition`, `pin`
  and `linearIssues`. With no `runtimeCliLaunch` and no `command`, the
  helper builds one with `buildTrackedCliLaunchCommand`. `startupDelayMs`
  goes to `ade.pty.create` only when passed (see
  [pty-and-sessions.md](./pty-and-sessions.md#create-flow-createargs)).
  `"background"` inserts the optimistic row without moving focus;
  `"foreground"` focuses and opens the tab from the synchronous `ptyCreate`
  result before the forced refresh, so `TerminalView` subscribes before a
  fast TUI paints. The runtime skips leading `ENV=value` words before it
  reads the provider.

## Session delta hook: `useSessionDelta.ts`

Reads `SessionDeltaSummary` by session id for `SessionCard`
(`filesChanged`, `insertions`, `deletions`, `touchedFiles`, `failureLines`,
`computedAt`). A failure returns null and the card shows nothing.

## Shared helpers

- `apps/desktop/src/renderer/lib/sessions.ts` — `primarySessionLabel`,
  `preferredSessionLabel`, `shortToolTypeLabel`, `isChatToolType` (from
  `sessionSpawnNesting.ts`), `isPtyContextInsertableToolType`,
  `buildOptimisticChatSessionSummary`.
- `apps/desktop/src/renderer/lib/terminalAttention.ts` —
  `canonicalInputFromSummary`, `sessionCanonicalUiState`,
  `sessionStatusBucket`, `sessionFilingBucket`, `sessionStatusDot`,
  `sessionCapsuleBadge`, `sessionIsMidFlight`, `sessionNeedsYou`,
  `summarizeTerminalAttention`, `sessionInlineStatusLabel`,
  `sanitizeTerminalInlineText`.
- `apps/desktop/src/renderer/lib/sessionListCache.ts` — `listSessionsCached`,
  `invalidateSessionListCache`. Normal reads coalesce; forced reads and
  invalidation skip stale in-flight reads, and promise identity stops a late
  reply from replacing a newer cache.
- `apps/desktop/src/renderer/lib/chatSessionEvents.ts` —
  `announceWorkChatSessionCreated` clears both list caches and publishes a
  new chat for optimistic insertion; `shouldRefreshSessionListForChatEvent`
  limits refreshes on streamed chat events.

## Gotchas

- Do not unmount a hidden `SessionSurface`. Pass `terminalVisible={false}`
  so the PTY stays attached. The cached runtime disposes 400 ms after its
  refs reach zero.
- The list cache keys `ListSessionsArgs` by `projectRoot + laneId + status +
  toolTypes`. Work reads the full list and groups by status locally. Call
  `invalidateSessionListCache()` before the first `refresh()` for an event
  that must reach every view.
- Do not read "loud" from the Your move bucket: it mixes `needs_you` with
  quiet `ready`/`idle`. Use `sessionNeedsYou()` or
  `summarizeTerminalAttention()` for badges and notifications.
- Do not clear `settledAt` on output from a chat that declared itself done.
  The next user turn clears a chat settle; only PTY output clears a settle on
  activity. A scheduled or background wake shows Running, then Settled again.
- Use the snooze columns only for filing. `canonicalSessionState()` never
  reads them, and counts and badges do not change. Use
  `effectiveSessionFilingBuckets` (or `sessionFilingBucket` for one row) and
  `isSessionSnoozed` for row chrome.
- Do not write lifecycle state when a snooze expires. Expiry compares
  `snoozedUntil` to now. A render-only timer may repaint an open surface (the
  Work hook for the roster; an open chat, the palette and the foreign-row pane
  for themselves); none writes state.
- Nothing derives a settle. A clean exit is `ended`, never `settled`
  (`sessionCanonicalState.ts`), so a settled row has `settledAt` or a
  `"settled"` override, and Unsettle clears both. The `"active"` pin holds a
  row out of the quiet tier against a later declared settle (the PR-merge
  policy).
- On a launch, open the tab from the synchronous create result before the
  forced refresh, then merge the stale persisted row. Do not prune open tabs
  before an authoritative refresh for the current project.
- Work and Lanes share `useWorkSessions`. Keep lane state keyed by
  `projectRoot::laneId`.
- Spawn nesting is one rule in `sessionSpawnNesting.ts` (iOS:
  `WorkSpawnNesting.swift`). Do not derive nesting in a list renderer. Status,
  time and board stay flat; `ade chat list` is a flat table.
- Every grid tile stays mounted (`terminalVisible={true}`; `isActive` gates
  input). `gridLayoutId` is `work:grid:tiling:v1:<projectRoot>[::<laneId>]`.
- Each grid member costs renderer heap, so a set holds at most
  `MAX_WORK_GRID_TILES` (6, `lib/workGrid.ts`). Three places enforce it:
  `addSessionBesideTarget` refuses a seventh; `WorkGridView` stops offering
  `acceptExternalDropMime` (counting saved `gridSet.sessionIds`, as
  `addSessionBesideTarget` does); `normalizeWorkGridSets` (`appStore.ts`)
  trims an oversized saved set. Trimmed members stay unclaimed, so they open
  as single sessions.

## Cross-links

- Main-process services: [pty-and-sessions.md](./pty-and-sessions.md).
- Lane gating and worktree isolation:
  [runtime-isolation.md](./runtime-isolation.md).
- The chat pane: `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx`.
