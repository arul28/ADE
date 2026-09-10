# Terminal and Session UI Surfaces

The renderer surfaces that expose session data to the user. All paths
are under `apps/desktop/src/renderer/components/terminals/` unless
noted otherwise.

## Entry page: `TerminalsPage.tsx`

Top-level page for the Work tab. Wraps two panes with `PaneTilingLayout`:

- `sessions` pane (default 24%, min 15%) → `SessionListPane`
- `view` pane (default 76%, min 40%) → `WorkViewArea` plus the right-edge
  `WorkSidebar` when `workSidebarOpen` is true.
  The view + sidebar share the row via a flex container with a draggable
  column separator; the sidebar width is persisted as
  `workSidebarWidthPct` (clamped 26–55%).
  The pane includes the Terminal tool, which renders the same
  attached-terminal surface for chat sessions and running tracked agent CLI
  sessions.

Pulls all session state through `useWorkSessions()` and renders two
globally-positioned overlays:

- `SessionContextMenu` — right-click actions on session cards and tabs.
- `SessionInfoPopover` — hover/click info panel showing tool type,
  lane, transcript path, exit code, and management actions.

The page handles session navigation (selection, tab open, "go to lane")
and invalidates the shared session list cache before pushing a
freshly-opened chat into the Work tab. It also computes a
`draftContextTargetId` (formatted as `work:draft:<laneId>:<draftKind>`)
and a `contextTarget` that includes a `"draft"` kind when no active
Work session is selected but a draft composer is mounted, so the Work
sidebar can insert context (attachments, iOS/App Control/browser
selections) into the draft composer before a chat session exists.
Context insertion is enabled for draft targets — the "no session open"
disabled message no longer appears when a draft is active. The page
also determines PTY context insertability through
`isPtyContextInsertableToolType` (exported from
`apps/desktop/src/renderer/lib/sessions.ts`), which covers all tracked agent
CLI tool types: `claude`, `codex`, `cursor-cli`, `droid`, and `opencode`.
The Terminal tab does **not** key off `contextTarget`: terminal ownership is
an identity question, so it resolves the owner from the active session
itself — a chat session, or a running CLI session with a `ptyId` and an
insertable tool type — and falls back to the `contextTarget` sessionId only
when no session is active.

The same page is the subscriber for `ade:work:select-session`, the
renderer event dispatched by orchestration and lineage navigation. The
handler accepts `{ sessionId, laneId? }`; when the caller omits `laneId`, it
resolves the target lane from the loaded session list. It then selects that
lane, focuses the target session, opens its Work tab, and stores it as the
active selected session. This lets a spawned-chat row or parent-lineage glyph
jump across lanes without already knowing the target lane.

`useWorkLaneDeleteProgress` also makes this page the Work-owned consumer of
lane deletion state. While Work is active it subscribes to streamed delete
progress and lane lifecycle events, and it hydrates `lanes.listDeleteProgress`
so a delete started on another tab remains visible after returning to Work.
When teardown finishes, it invalidates the session-list cache and refreshes
both Work sessions and lightweight lane metadata. The active lane's content
and tools are covered by a blocking status overlay until refresh succeeds;
refresh failures retry twice with bounded backoff, then clear the stale
progress and surface a sticky error toast rather than leaving Work disabled.

It also owns the sidebar's multi-select state:

- `selectedSessionIds: Set<string>` with a `selectionAnchorId` tracker.
- `handleSelectSession(id, event, visibleSessionIds, binding?)` — plain click
  clears the multi-selection and opens the tab; shift-click selects the
  range from the anchor; meta/ctrl-click toggles the id in/out of the
  set; any of the three refresh the active single-selected item. The optional
  binding is the per-session runtime pin carried into the opened view.
- `handleSelectForeignRuntimeSession(session, binding, event, visibleSessionIds)`
  — the CLI/shell row of another machine, forwarded from `SessionListPane`.
  When the owning binding is still open (`machineRouter.isLivePin`), the page
  remembers it as the session's runtime pin and opens the row **in place**
  through the normal selection path; the project tab is not touched, so Lanes,
  PRs, and Files stay where the user put them. Only when that binding is not
  open in this window does it fall back to switching the tab to the owning
  project, since there is then nothing to pin to; a failed switch leaves the
  session closed rather than opening a foreign session id against the tab's
  current runtime.
- `handleBulkStopSelected` runs on selected running PTY sessions,
  confirming before calling `stopRuntime(ptyId, sessionId)`; failures
  are counted and surfaced through `sessionActionError`. Chat rows stay
  durable and are continued by sending a message instead of exposing a
  separate lifecycle action.
- `handleBulkDeleteSelected` runs on selected non-running sessions
  with a similar confirm + promise-all-settled loop, wired to
  `ade.agentChat.delete` for chat rows and `ade.sessions.delete` for
  PTY rows. Succeeded ids are removed from the cache and the open-tabs
  list.
- Bulk settle is owned by `SessionListPane`: it sends only visible selected
  at-rest, non-settled, non-`Needs you` ids through
  `ade.sessions.settleMany`, retains only the ids the service actually changed,
  and offers an eight-second Unsettle undo. Bulk settle does not dismiss
  pending input, stop a runtime, delete a transcript, or archive a chat.
- `handleBulkStopAndDeleteSelected` stops selected running runtimes, then
  permanently deletes every selected session once the user confirms.

Any selection-entry that is no longer present in the rendered session
list is pruned from `selectedSessionIds` automatically so stale ids
don't leak across filter changes.

## Session sidebar: `SessionListPane.tsx`

Lists sessions grouped by one of three modes (controlled by
`sessionListOrganization` in the work view state):

- `by-lane` — one group per active lane
- `all-lanes-by-status` — Running / Your move / Ended / Snoozed / Settled
- `by-time` — today / yesterday / older

Each group uses a `StickyGroupHeader` with collapsed-state persistence
via `workCollapsedLaneIds` / `workCollapsedSectionIds`. There are **two** quiet
tiers, not one. Settled is a lifecycle phase; Snoozed sits one tier above it and
is a visibility overlay — a snoozed row keeps its canonical status and is simply
filed elsewhere. Status and time views render one final section per tier, while
lane view renders collapsible snoozed and settled tails inside each lane. Rows
in either tail are always reachable; there is no separate visibility filter
because Status grouping already exposes the complete lifecycle. Every global
section and per-lane tail starts collapsed. User-expanded state is persisted,
and collapsed tails do not contribute ids to shift-range selection.

Every disclosure has one visual shape and one toggle contract: clicking either
the label or far-right chevron toggles it, while the label remains the only
keyboard/assistive-technology stop. A collapsed header folds its count into the
label (`Lane name (3)`, `Settled (12)`); an expanded header drops the count
because its rows are visible. Fully quiet lanes and the global Snoozed/Settled
shelves are closed-by-default three-state disclosures: no marker means never
touched and closed, `shelf-open:*` / `lane-open:*` means explicitly opened, and
removing the marker closes them again. Notification deep links add the open
marker so a Settled destination cannot remain hidden.

Lane groups with two or more sessions render an accent-coloured lane name,
optional machine/PR markers, then indent the cards beside a lane-tinted rail.
A lane with exactly one session suppresses the redundant divider and rail; the
full-width card carries lane identity and PR state instead, and its context
menu inherits the lane actions. For a foreign singleton, that card also carries
the same amber machine glyph the omitted header would have shown. The marker is
present exactly when the lane is not on the physical Mac, not when it differs
from the project tab's binding; a grouped header owns the glyph so its child
cards do not repeat it. The singleton/header transition participates in the
same layout animation as lane reordering.

Filing comes from `effectiveSessionFilingBuckets` (wrapping the base
`sessionFilingBucket` rule), which combines canonical lifecycle
with the snooze visibility overlay in one shared answer. Snooze still yields to
a `needs_you` phase, so a snoozed row that is blocked on the user stays in its
normal section. Ordering inside the quiet tiers
diverges from the default `startedAt` sort: settled rows rank by `settledAt`
(so a session settled just now sits at the top rather than under sessions
settled long ago) and snoozed rows rank by `snoozedUntil` ascending, because the
group answers "what comes back first". Group headers carry an explicit
`role="heading"` and a `"<label> (<count>)"` accessible name.

The Lane organization has its own Work-scoped lane order. The primary lane is
always first; all other rows file as pinned, active, then quiet. A pin is not a
Lanes-tab pin: it keeps the Work row above active work and suppresses its
compact/dimmed quiet treatment. The funnel offers Activity, Name, Created, and
Manual sort modes inside those tiers. Dragging a non-primary lane header onto a
row in the same tier (before or after its midpoint) switches to Manual and
persists the displayed order; it cannot move a lane across the primary, pin, or
quiet boundaries. Native drag-and-drop owns the drop line and rAF edge
autoscroll, while the list uses the resulting order signature only for its
layout animation rather than remeasuring on every session tick.

The same funnel also owns the persisted session chips. Status (Your move,
Running, Ended, Settled, Snoozed) and Tool choices are ORed within their own
axis; the Status, Tool, Has PR, and Dirty-lane axes are ANDed together. The
status chip uses the same effective filing result as the sidebar, Has PR
uses the coalesced PR snapshot that powers lane-header badges, and Dirty reads
the already-loaded lane status. Chips apply before all three organization
modes. A remote lane has no local PR snapshot, so Has PR fails closed there;
the filtered empty state names the active chips and provides a clear action
instead of implying that the sessions disappeared.

Lane group headers also wire into `useWorkLaneContextMenu`, so right-click
actions are available from the session sidebar. Color changes and copy/reveal
run inline. **Manage lane** opens the shared `ManageLaneDialog` in a portal over
Work, leaving the route, selected session, and Work layout unchanged when the
dialog closes; direct adopt, batch, and split actions continue through Lanes-tab
deeplinks.

The pane reads `laneDeleteProgressByLaneId` from the shared app store. In
`by-lane` mode the matching lane header becomes non-interactive and shows a
spinner with `Deleting`, `Deleted`, or `Deleted with warnings`. Every matching
`SessionCard` receives a `disabledReason`, so the lane's chats and CLI sessions
are dimmed and blocked in all three organization modes, not only beneath the
lane-group header.

In `by-lane` mode, any session whose `laneId` is not in the current
lanes list is still rendered under its own sticky "orphaned sessions" group
below the active lane groups. The list is built from
`missingLaneSessionGroups`: every `laneId` from `sessionsGroupedByLane`
that's absent from the `lanes` set becomes a group, labelled with the
session's `laneName` (falling back to the raw `laneId`) and sorted by
most-recent `startedAt`, with ties broken alphabetically. These groups
reuse the same `workCollapsedLaneIds` persistence, so a user who
collapses an orphan group sees it stay collapsed on reload. This keeps
sessions reachable when their lane has been archived, deleted, or not
yet loaded, instead of quietly dropping them from the sidebar. They use a
warning icon and neutral tint rather than pretending to be a current lane,
explain that chat history is still preserved, and offer a non-destructive
lane refresh. ADE never deletes a session or Git data from this recovery row.

Foreign-machine lane rows follow the same filing contract instead of using a
parallel card-only renderer. `partitionQuietSessions` splits each row with
`effectiveSessionFilingBuckets`; active cards render normally, while snoozed and settled
cards use the same collapsed quiet tails as local lanes. A fully quiet foreign
lane starts as the same minimal header with inline counts and uses
`lane-open:<machineId>:<laneId>` for explicit expansion. When active work
returns, `SessionListPane` clears that marker so the next all-quiet state starts
collapsed — except on an offline machine, whose chats only look active because
that is the last thing it reported. Card selection and context actions still
carry the owning runtime binding. **Manage lane** opens the shared dialog with
every read and mutation pinned to that machine. An offline machine's lane group
is dimmed and folds shut like a quiet one; expanding it is allowed, but every
card in it is disabled and reads "<machine> is offline". The other disabled
foreign row is one whose reachable machine has not resolved a project binding
yet. A one-session reachable foreign lane is allowed to use the same headerless
shape as a local singleton; an offline machine remains grouped so its folded,
dimmed state has a header to live on.

In-flight chat handoffs are rendered as temporary placeholder cards in
the same sidebar. `TerminalsPage` pulls matching `HandoffLaunchJob`
rows from the root store and passes them into `SessionListPane`, which
lets them participate in the current lane, status, time, and search
filters. Placeholder rows are non-selectable, show the target model and
current handoff phase, and disappear when the new chat is created or
the handoff fails.

Also renders:

- a 32 px toolbar with a **Hide sessions** control, then a slightly
  tighter Search button, then Filters and New chat; Search opens the
  command palette and displays the configured shortcut. **Hide sessions**
  is not in the chat/CLI header. When the list is collapsed, a thin left
  rail in `TerminalsPage` shows the same glyph as **Show sessions**.
- an expandable filter panel with group selector (Lane / Status / Time), lane
  sort, status/tool chips, Has PR / Dirty, and `LaneCombobox`
- the actual list of `SessionCard` rows (memoized)
- a bottom **New lane** action that opens `CreateLaneDialogHost` in-place. The
  Work flow uses the host's `close-on-create` behavior: it closes as
  soon as the lane row is created, then runs lane environment setup
  detached from the sidebar component and leaves a sticky retry toast if
  setup fails.
- a compact selection toolbar beneath the header that appears when
  `selectedSessionIds` is
  non-empty: "Stop N" for running PTYs, "Settle N", "Delete N" for
  deletable ended rows, "Stop & delete N" when the selection includes a
  running runtime, and a clear-selection X. The footer
  totals only count sessions that are still visible in the current
  filter; callers are `TerminalsPage`'s bulk handlers.

`onSelectSession(id, event, visibleSessionIds)` is forwarded verbatim
from `TerminalsPage`. The pane passes its own ordered id list (derived
from the active organization mode and uncollapsed groups) as the third
argument so shift-range selection follows the visual order the user
sees, not the underlying data order.

The pane derives `liveChildrenByParentId` and `sessionTitleById` from the
unfiltered session inventory. The latter uses `primarySessionLabel()` and is
passed to each child card as `parentSessionTitle`, so lineage tooltips can name
a parent even when search, lane filtering, or a collapsed group hides its row.

### `SessionCard.tsx`

The full card is one full-bleed row with three lines:

1. **Where + status** — an adaptive identity slot on the left and
   `SessionStatusSlot` on the right. The identity slot can carry a pin, the lane
   identity for a singleton lane, spawned-chat lineage, a branch only when it
   differs from the lane's declared branch, and the lane PR for a singleton.
   A foreign singleton gets one fixed-width amber machine glyph in the right
   status cluster; the card's hover details name the machine. The same cluster
   carries `AgentBrowserPresenceBadge` — a pulsing accent globe while this
   chat's agent is driving the built-in browser, and nothing at all otherwise.
   It sits beside the machine glyph because it answers the same question:
   where is this work happening. Compact rows have no line one, so they carry
   it next to the provider logo stack instead. When none of those
   apply, session delta or last-activity time is the floor, so the line never
   renders empty. A grouped lane owns machine identity and PR state in its
   header; child rows do not repeat them. Lane identity always uses the lane
   accent and `LaneIcon`; branch identity is always muted and uses `BranchIcon`.
2. **Title + singleton PR** — `primarySessionLabel()` is the prominent,
   elastic element. When the card stands in for a one-session lane, the shared
   `LanePrBadge` sits at the right edge directly beneath the lifecycle status
   and stays untruncated. A card whose lane lives on this machine deep-links to
   the PR in ADE; a card on another machine badges from that machine's own PR
   rows and opens the PR on GitHub, because the PRs tab can only resolve a PR
   id on the machine the project tab is bound to. When a lane has multiple PRs,
   the badge represents the newest open/draft PR, or the newest terminal
   activity when no PR is active, and its `+N` list is rendered in a
   viewport-clamped portal so the session card cannot clip the details. The portal remains
   keyboard reachable (ArrowDown opens it, Escape closes it and restores focus) and its own
   list can scroll without dismissing. While the owning lane is
   mid background AI naming, every visible lane-label position (singleton row,
   hover detail, or grouped header) uses the shared animated `Naming lane…`
   placeholder; the persisted deterministic fallback stays hidden unless
   naming fails. A resolved title change gets a short lane-accent highlight.
3. **Preview + quiet metadata** — preview content remains visible during lane
   naming. It shows an explicit `attentionMessage` first, then `statusNote` (`done: …` in the
   settled tier), then a sanitized `lastOutputPreview`, then
   `session.summary`, then `session.goal`. Output fallback is plain text (never
   linkified), capped at 120 characters, and strips ANSI/control sequences plus
   repeated whitespace via `sanitizeTerminalInlineText`. The trailing cluster
   is limited to Claude cache TTL, a non-stop exit code, and `ToolLogo` — or,
   after a model handoff, a stacked current-over-previous provider mark with
   the previous logo peeking as a sliver to the right (offset ~28% of the mark,
   current logo at full opacity). Delta
   moved to line one so preview text owns the width it needs.

`SessionStatusSlot` is the card's only permanent status vocabulary. It resolves
words, glyphs, tone, prominence, and elapsed-time behavior through
`shared/sessionStatusPresentation.ts`. An active ADE chat in its authoritative
plan interaction mode reads **Planning** in violet; other active turns retain
**Working**. Once the foreground turn is idle, provider-reported background
tasks read blue **Background work** (**Background work ×N** when several are
live), while an armed `nextWakeAt` reads neutral
**Waiting** with a compact countdown. Naming that state rather than reusing
**Working** matters because the turn has already ended: a duration-less
"Working" on a finished turn is indistinguishable from one that has hung.
These contextual labels do not change the
canonical lifecycle, filing bucket, filters, or attention count, and CLI output
is never scraped to infer plan mode. Working/Planning elapsed time ticks from
the active chat's immutable `currentTurnStartedAt`, so streamed activity cannot
reset it; legacy chat rows without that anchor, plus CLI and Stale durations,
use last activity. Background work counts from `backgroundWorkSince` — when the
session's live background set last went from empty to non-empty — which the
runtime reports on the session summary. Anchoring it to last activity instead
made it meaningless: every provider frame refreshes that column, so a job that
had been running for two hours read "Background work ×2 3s", identical to one
that started three seconds ago, and the row could not be judged by its own
duration. It is still a session-level anchor rather than any single job's
runtime — a second job joining a live set counts from the first one's start —
and providers with no background-task level (Codex, Cursor) keep the last-activity
fallback. All three anchors come from one shared helper, `sessionElapsedAnchor`,
so the Work rows, `ade code`, and `ade session show` cannot report different
durations for the same session. The desktop slot feeds the raw anchor to a
ticking component; the two text surfaces take the already-formatted string from
`sessionElapsedLabel`, which wraps the same anchor. Waiting refreshes on a quiet
30-second cadence. On row hover or
keyboard focus the status swaps, without reflow, for `SessionSnoozeControl` and
the context-appropriate Settle or Un-settle action. That button disables itself
while its settle/un-settle call is in flight: settle teardown now does real
provider work on the rows where it is offered, so a second click lands inside
the window and the backend answers a joined settle with a raw session id. An
open snooze menu pins the action slot visible. A row whose snooze ended early shows the shared Woke
presentation until it is opened, at which point `TerminalsPage` clears the
marker — opening is the acknowledgement.

After one second of uninterrupted hover, `SessionHoverCard` opens over the
content area to the right of the sidebar. It uses icon-led fact rows rather
than `Label: value` text and carries details intentionally removed from the hot
row: lane, machine, branch, provider, PR, parent thread, orchestration role,
spawn kind, live-child count, import provenance, grid membership, Claude tag,
next scheduled wake, non-zero exit, and the long-running process cleanup hint.
PR and parent-thread facts are clickable. Moving directly from a row whose card
is open to another session row opens the next card immediately; entering from
blank space, the content pane, or a row whose timer never fired starts a fresh
one-second delay. Pointer leave before the delay, list scroll, and resize cancel
the card. The portal is viewport-clamped and fades/slides right from the source
row, with motion disabled under reduced-motion preferences.

When `disabledReason` is set, the card disables selection, dragging, and its
context menu, lowers opacity, and renders a centered spinner/status overlay.
This is used while the card's owning lane is being deleted.

Selected and hovered rows spend the reserved background surface; multi-select
adds a subtle ring. Non-prominent states (working, background work, starting, stale, stopped,
ended, snoozed, and settled) recede until hovered, while Needs you, Done, and
Failed keep full weight. Only canonical `needs_you` contributes to the Work-tab
highlight, notifications, and Dock badge. `useAppWideSessionAttention` owns
that count at `AppShell`, so it remains live outside Work.

The same canonical session phase feeds the account-wide Activity UI, where it is
grouped by the six shared state groups — Needs you, Failed, Planning, Working,
Idle, Done — defined by `activityStateGroup` in the renderer's
`activity/activityPresentation.ts` and mirrored by the notch, iOS, and the relay.
The desktop header popover omits Idle and Done; the full pane, Hub tree, and Mac
notch compact strip keep them. Activity's session column is agents only; pull
requests and checks render in its Notifications column. ADE Notch shows the same
ordering as a compact strip of clickable state-glyph badges and can flash a
needs-you card. The hook and wire-level `attention` vocabulary remain
compatibility names; user-facing surfaces call the feature Activity.

Planning is the one state the phase vocabulary cannot express. `AttentionPhase`
is frozen push wire, so a planning turn publishes as `running` and carries the
additive `chatActivityMode: "planning"` alongside it; readers that do not
understand it fall back to Working.

## Work view: `WorkViewArea.tsx`

Owns the render target for open sessions. Supports three modes tied to
`viewMode`:

`WorkViewArea` also builds a title index for all loaded sessions and threads
it through `SessionSurface` into locked `AgentChatPane` embeddings. The chat
pane uses it to label spawned-chat rows in Chat Info with the live child title
instead of the provider/runtime fallback.

- `tabs` — tab-strip + single `SessionSurface` for the active tab, plus
  a "New Chat" button in the tab strip. A second sub-mode (`hasGroupedTabs`)
  renders lane-grouped tab chips with per-group collapse. Lane group chips use
  `useWorkLaneContextMenu` for the same color/manage/split/batch actions as
  the Lanes tab.
- `grid` — tiled pane layout. Each session becomes a `PaneConfig` that
  mounts a `SessionSurface` in `grid-tile` variant. The tiling tree is
  rendered by `PaneTilingLayout`, seeded by
  `buildWorkSessionTilingTree(visibleSessionIds, tilingPreset)`. Grid
  mode renders an inline arrange menu (Auto / Rows / Columns) next to
  the visible-session count when more than one session is open;
  switching presets rewrites the persisted tiling tree
  (`window.ade.tilingTree.set(gridLayoutId, …)`) and resets pane sizes
  via `window.ade.layout.set(gridLayoutId, {})` so the new preset
  starts from `defaultSize` rather than inherited percentages.
- `single` — a single focused session with no tab chrome.

### `SessionSurface` (internal component)

Branches on `session.toolType`:

- chat tool types → `AgentChatPane` for the matching chat session, mounted with
  `lockSessionProvider={providerFromChatToolType(session.toolType)}`. The Work
  row knows the provider synchronously; the pane learns its own only after an
  IPC summary round trip and is not remounted across a chat switch, so without
  this the provider-derived accent would paint the *outgoing* chat's colour for
  a frame. See [Resolving the accent](../chat/composer-and-ui.md#resolving-the-accent-for-the-chat-on-screen).
- PTY sessions → `TerminalView` wired to the session's `ptyId`
- lane-scoped terminal tools are opened from the Work sidebar's
  Terminal tab; tracked agent CLI sessions no longer add a separate
  Terminal shortcut in their work header

When a tile is suspended (grid layout where the tile is not visible),
it renders a static preview card instead of mounting the terminal.

Props that matter:

- `isActive` — whether this surface is the focused tab; terminals use
  this to gate input.
- `terminalVisible` — whether the surface is currently on screen; false
  disables xterm fit operations and PTY-resize broadcasts. Used by
  hidden grid tiles.
- `layoutVariant` — `"standard"` (single tab) vs `"grid-tile"`
  (compact chrome, smaller fonts).

Grid mode keeps running PTY sessions mounted so multiple terminals can
stay live at once; `isActive` only controls focus/input, not whether the
terminal renderer exists.

For tracked agent CLI sessions that have already exited, `WorkViewArea`
renders `ClosedCliSessionSurface` instead of `TerminalView`. A session
wrongly marked `detached` by the ownership reconcile lands here too, showing
frozen "Ended" copy over a live PTY — which is why every activity write repairs
a stale detach; see
[Stale-detached repair](README.md#stale-detached-repair). The surface
fetches `ade.terminal.preview` and decides between a serialized snapshot
preview and the plain transcript text via `snapshotLooksLikeTui(rows)`:
when the snapshot contains TUI frame characters (`╭`, `─`, etc.) or
enough styled cells to be obviously a TUI redraw, the snapshot wins so
the user sees the Claude/Codex final screen instead of a flattened
transcript with the alt-screen escape codes visible. Ended tracked CLI
surfaces keep the same `WorkSurfaceHeader` controls as live CLI and chat
surfaces, including the far-right Tools toggle (a mirrored `SidebarSimple`
glyph so the solid rail sits on the right). The sessions-list collapse
control lives on the session sidebar search row, not in the chat/CLI
header; when that sidebar is hidden, a thin left rail with **Show sessions**
recovers it. They
also expose two relaunch paths: **Resume** calls
`ade.pty.resumeSession` and opens the provider TUI without sending a
prompt, while the continuation composer calls `ade.pty.sendToSession`
and sends the follow-up as part of the first resume launch when
structured resume metadata is present.

Claude CLI surfaces whose recent preview/transcript reports `Please run
/login` or a 401 invalid-credentials error show the same dismissible
`Login to Claude` CTA used by Claude chat headers. It creates a tracked
shell PTY in the session's lane and runs `claude auth login`; the Work
tab selects that PTY so the user can finish the interactive login.

Constants:

- `CHAT_TILE_MIN_WIDTH = 440`, `CHAT_TILE_MIN_HEIGHT = 340`
- `TERMINAL_TILE_MIN_WIDTH = 320`, `TERMINAL_TILE_MIN_HEIGHT = 220`

## Grid mode: `PaneTilingLayout` + `workSessionTiling.ts`

The Work grid is a standard `PaneTilingLayout` instance with one leaf
per visible session. Two helpers build the inputs:

- `buildWorkSessionTilingTree(sessionIds, preset = "auto")` (in
  `workSessionTiling.ts`) returns the seed `PaneSplit` used when
  nothing has been persisted for the current `gridLayoutId`, and is
  also called by the arrange menu when the user requests a specific
  preset. `auto` biases toward near-square layouts:
  `columnCount = ceil(sqrt(n))`, `rowCount = ceil(n / columnCount)`,
  then `rowSizes(n, rowCount)` spreads sessions across rows so
  earlier rows absorb the remainder. `rows` produces one full-width
  vertical split per session; `columns` produces one full-height
  horizontal split per session. `minSize: 8%` (MIN_PANE_SIZE) /
  `12%` (MIN_ROW_SIZE) floors protect against accidentally collapsing
  a row.
- `WorkViewArea` builds one `PaneConfig` per visible session (keyed by
  `session.id`) with title, status dot, close button, mouse/context
  handlers that forward to `onSelectItem` / `onContextMenu`, and a
  `SessionSurface` child in `grid-tile` variant.

The actual split tree, resize state, and pane origin are owned by
`PaneTilingLayout`. See the next section for invariants the layout
enforces.

## Pane tiling layout primitives

`PaneTilingLayout` (`apps/desktop/src/renderer/components/ui/PaneTilingLayout.tsx`)
and its pure operations (`paneTreeOps.ts`) are shared across the Work
grid, `LanesPage`, `TerminalsPage` itself, and history detail views.
Reconciliation invariants the layout guarantees:

- **Seed tree.** Consumers pass a `tree: PaneSplit` prop that describes
  the default layout for the current set of pane IDs. `collectLeafIds(tree)`
  is the canonical `expectedPaneIds` list.
- **Persistence.** On mount the layout reads a persisted tree from
  `window.ade.tilingTree.get(layoutId)`. Every user-driven change
  (drop-edge split, swap, reconciliation) is written back with a 300 ms
  debounce. Panel sizes use a separate `DockLayoutState` store keyed by
  `layoutId` + positional path; any tree mutation resets that panel-size
  store so newly-split panels start from their `defaultSize` instead of
  inheriting a stale saved percentage.
- **Tree reconciliation.** `reconcilePaneTree(candidate, expectedPaneIds,
  fallback)` is called both on load (against the persisted tree) and on
  prop-tree changes. It drops leaves that are no longer expected,
  flattens any single-child splits produced by that removal, and
  inserts missing pane IDs by splitting the leaf with the largest
  computed weight (direction alternates: a missing pane added to a
  horizontal parent becomes a vertical split, and vice versa).
  Duplicate leaves or unknown IDs surviving the cleanup pass cause the
  whole tree to be replaced with the fallback.
- **Drop-edge detection.** `detectDropEdge(rect, clientX, clientY)`
  maps a pointer position to `top | bottom | left | right | center`
  using a 25 % edge threshold. The center zone triggers a swap
  (`swapPanes`); the four edges trigger `splitPaneAtEdge(tree, targetId,
  draggedId, edge)`, which prunes the dragged leaf, coerces the
  remaining tree to a split in the correct orientation, and replaces
  the target leaf with a two-child split whose child order follows the
  edge (`right`/`bottom` keep the target first; `left`/`top` put the
  dragged pane first).
- **Minimization.** Each leaf can minimize via its `FloatingPane`
  header. `PaneTilingLayout` runs two compaction passes off the
  `minimized` map: an individual-leaf pass that shrinks the leaf's
  containing panel to `LEAF_MINIMIZED_{HEIGHT,WIDTH}_PX`, and a
  split-level pass that compacts an entire subtree when every
  descendant leaf is minimized (`COMPACTED_WIDTH_PX` for horizontal
  parents, `COMPACTED_HEIGHT_PER_LEAF_PX × leafCount` for vertical
  parents). Both paths restore the previous panel size on un-minimize
  via `PanelImperativeHandle.resize`.

`FloatingPane` now also accepts `onPaneMouseDown` / `onPaneContextMenu`
so consumers (like the Work grid) can run selection / context-menu
logic on the wrapper without subscribing through drag handlers.
`PaneConfig` exposes a `className` pass-through so callers can apply
their own tile chrome classes (e.g. `ade-work-glass-tile`) alongside
the floating-pane defaults.

## Right-edge Work sidebar: `WorkSidebar.tsx`

A persistent right-edge pane that follows the active lane (and active
Work session when one is selected). It is rendered next to
`WorkViewArea` whenever `workSidebarOpen` is true and the view mode is
not `grid` — the grid layout owns the full row, so the sidebar is
suppressed there. `TerminalsPage` wraps the view + sidebar in a flex
container with a 5 px draggable column separator; the sidebar width is
persisted as `workSidebarWidthPct`.

### The splitter is clamped in two units

`workSidebarSplitter.ts` owns the whole rule, pure so the arithmetic is
testable without a layout engine. The percentage clamp
(`MIN_WORK_SIDEBAR_WIDTH_PCT` 26 – `MAX_WORK_SIDEBAR_WIDTH_PCT` 55,
mirrored by `normalizeWorkSidebarWidthPct` in the store) is a taste rule
and says nothing about pixels: 26 % of a 900 px window is 234 px, and at
234 px the pane's own 36 px header — back button, tool name, activity
dots, ✕ — has nowhere to go, which is how a drag once left the close
button off-window. So a drag is clamped in **both** units: never below
`MIN_WORK_SIDEBAR_PANE_PX` (280) of real pane, and never leaving the chat
column narrower than `MIN_WORK_CONTENT_PANE_PX` (360). The container
width is the only thing the pane supplies; omit it (as the store does
when it has no layout to consult) and only the percentage rule applies.
`WORK_SIDEBAR_SPLITTER_PX` (5) belongs to neither pane, and arrow keys
move the separator by `WORK_SIDEBAR_KEYBOARD_STEP_PCT` (2).

The splitter also announces itself: `TerminalsPage` dispatches
`ade:work-sidebar-browser-resize-start` / `-end`
(`renderer/lib/workSidebarBrowserResize.ts`) so the browser panel's
`useNativeBrowserViewBounds` can raise its suppression count for the
length of the drag and keep pushing bounds every frame for 400 ms after
it ends. Bounds are measured against the pane's **content box**, not the
frame's own laid-out rect, which lags a pointer-driven resize by a frame
or two — without that trim the composited page keeps its old width and
paints over the chat column and the window edge while you drag.

### A tab strip, and a picker page behind it

The pane is a **tab strip plus one page**: one tab per open tool, one of
them on screen, and the picker page whenever you press the grid button or
the `+`. There is no multi-instance — a tool is open once. There are six
tools and no Pull request tool: PRs live on their own tab, and a seventh
card that opened a read-only summary was the one card in the grid that did
not take the pane over.

The picker is one **centred 512 px column** (`COLUMN_MAX_PX`) — no title
and no subline, just a grid of cards in the order Terminal, Browser, Git,
Files, Simulator, App Control (`WorkToolPicker.tsx`, catalogue in
`workTools.ts`). The page does not name itself: the strip above it already
carries the word "Tools", and six labelled cards do not need introducing.
The column is vertically centred against the **whole pane** rather than
against the space left under the 36 px header, which is what the extra
bottom pad buys; it centres with `m-auto` rather than `justify-center`,
because a centred flex child in an overflow container has its overflowing
top clipped and unreachable. The grid is `auto-fit` over a
`CARD_MIN_TRACK_PX` (188) minimum, so it is **two columns or one, never
three**: with 24 px of padding either side and an 8 px gutter, two tracks
need 432 px of pane and three would need 628 px, and the column is capped
below that. 188 rather than 196 because the pane's default width is
447 px, which missed the old threshold by a single pixel and gave everyone
one column down a pane wide enough for two. Cards therefore *grow* with
the pane (188 → 252 px) instead of multiplying and shrinking. An odd card
count lets the last card span the full row rather than orphaning it.

Behind the grid is the pane's one decorated surface: a slow violet mesh
(`WorkToolPickerBackdrop.tsx`, adapted from the 21st.dev Shader Builder
"Mesh drift"). Nothing in its GLSL names a colour — `backdropThemeFor`
hands the shader ADE's own tokens as uniforms, `--color-bg` →
`--color-accent-deep` → `--color-accent` → `--color-accent-bright` in
dark, and `--color-surface` up the same violet hues at well under half
the intensity in light, since on a light canvas the same amount of colour
reads as a stain. The theme comes from the store (`s.theme`), the same
value `App.tsx` writes to `data-theme`.

Its budget is a hard requirement, because this is decoration on a page you
land on constantly inside a renderer that is also running a terminal, a
browser view and a chat stream. It draws at **DPR 1**, never more than
`BACKDROP_PIXEL_BUDGET` (600 k) pixels — past that the canvas keeps its
CSS size and the drawing buffer is floored down, which a mesh this soft
cannot show — and never faster than **30 fps**, gated on the rAF
timestamp rather than a timer so a 240 Hz panel costs seven cheap no-ops
instead of seven mesh evaluations. It stops entirely while the window is
blurred, the document hidden, or the canvas out of the intersection
observer's view; `prefers-reduced-motion` paints exactly one frame and
never starts the loop; the cursor swirl is wired only on `(hover: hover)`
and `(pointer: fine)` devices, since a touchscreen "cursor" is a tap that
would yank the background sideways. Unmount releases the context through a
deferred `pendingContextReleases` timer, cancelled if the same canvas
comes straight back — which it does on every picker ↔ tool crossfade. Every
path that decides not to use a context releases it through the same
`releaseContext` helper (lose the context, shrink the drawing buffer to
1×1), refusals included: on the machines that refuse — SwiftShader, a
blacklisted Windows driver — a merely abandoned context per crossfade walks
the browser's context cap until it starts evicting other canvases. A
`webglcontextlost` on the canvas flips the page to the static backdrop and
stops the loop; it does **not** `preventDefault`, since asking for a
restore would mean rebuilding the program on a machine that has just proven
it is short of GPU. Layout measurement is rAF-coalesced to one
`getBoundingClientRect` per frame — the listener is capture-phase scroll,
so a wheel gesture over the picker would otherwise force a dozen synchronous
reflows a frame — and it is wired only when the cursor effect is enabled.
With no WebGL there is **no canvas at all**: the same box renders
`.ade-tool-picker-static`, the same corner light as flat CSS, because a
software-rendered mesh would be the most expensive thing in the window.
The canvas is `aria-hidden` and `pointer-events: none` — a decoration that
swallowed a click meant for a card would be breaking the page it
decorates. It is pinned to a **non-scrolling wrapper** around the picker's
scroll container rather than inside it: `inset: 0` inside a scroller
resolves against the scroll origin, so on a pane too short for the column
the mesh ended at the fold and the rest of the page scrolled onto bare
chrome. `resolveBackdropSize` owns the whole size/budget policy and is
unit-tested without a GPU.

A card is deliberately thin: a monochrome 16 px glyph, the name, and
exactly one line underneath. No tinted square, no key cap, and **no
per-card activity dot** — the only mark a card can carry is a red 6 px dot
when that tool is actually broken (`workToolHasError`), because that is
the one fact worth interrupting a calm page for. Now that there is
something behind it the card is glass rather than a flat rectangle
(`.ade-tool-card`): a measured 82 % translucent fill and one hairline at
12 % white (a border token in light). The fill carries the mesh through on
its own — there is deliberately **no `backdrop-filter`**, because six blur
regions over a 30 fps animating canvas re-blur on every backdrop frame and
spend back everything the backdrop's own budget saves; 82 % is the point
where every 12 px line still clears 4:1 over the mesh's brightest
peak. Nothing is
highlighted on entry; arrow keys move a highlight and take focus with
them, so Enter is the browser's own activation, and a pointer move drops
the keyboard highlight so two cards never look hovered at once.

The line under the name is resolved by `workToolSummary` in one priority:
the tool's measured status (plus an error-count suffix), else the
catalogue's short `hint` ("Run a shell here", "Drive a real browser",
"Commit, push, rebase", "Boot a simulator", "Drive a desktop app"), else
the availability reason. Git shows the lane's unpublished, dirty-count,
ahead/behind, or pushed/committed-age state; Files shows the cached tracked-file
total and unique changed-entry count — entries, so a file with both index
and worktree changes counts once, and a new untracked directory counts as
one entry rather than as everything inside it. A legacy or remote lane payload
that carries no changed-entry count says `dirty` rather than a number: the
per-side staged/unstaged totals count entries on each side, so no arithmetic
over them recovers how many files are involved. Status comes only from reads the pane
already makes — the `builtInBrowser` / `iosSimulator` / `appControl`
status subscriptions, the terminal panel's published shell count, and the
lane's cached git summary — so nothing here polls. Lines hold a stepped-shimmer
skeleton for at most 300 ms while those reads settle
(`useWorkToolStatuses.ts`). A card's tooltip is `"<Tool> — <line>"` and
appears **only when the card clipped its text** (`onlyWhenClipped`), so a
tooltip is the rest of a sentence rather than a repeat of one; the
catalogue owns the hint string so the card and its tooltip can never
disagree about how much it says.

A tool that cannot run in this context renders as a **disabled card with
the reason as its status line** rather than disappearing: "Runs on this
computer only" (Simulator / App Control on a remote project), "Desktop
app only" (Simulator in the hosted web client), and "macOS only"
(Simulator off a Mac). Only those two tools are local-only — the browser
is hosted by this desktop's main process and a remote lane drives that
same window, so it stays available on remote lanes. In the hosted web
client the browser and App Control render **read-only** — the tab list,
attached app, and latest screenshot, with no way to drive them
(`isReadOnlyWorkTool`). Availability is decided by
capability flags in `workToolAvailability`, never by `process.platform` —
the web client renders this same component. An active tool that becomes
unavailable falls back to the **picker**, not to another tool.

The pane's one 36 px header (`WorkToolHeader.tsx`) is the strip, and it is
the same bar on both pages. Left edge is the `⊞ Tools` button back to the
picker (Escape does the same, bound as `work.tools.picker` with scope
`work` so it only fires inside the pane), lit while the picker is up.
Immediately right of it, one tab per OPEN tool in strip order — glyph,
name, a `×` on hover — with the tool on screen filled; then a `+` that
opens the picker, dropped while the picker is already showing, because two
controls opening one page is one too many. Activity dots for tools with
**no tab** that are usable here and not idle sit to the right of that, and
the close ✕ keeps its place at the end. There is no centred title: the lit
tab is the title.

The `×` is a sibling of the tab button, never a child — a button inside a
button is invalid and the browser resolves it by dropping one of the two
click targets — and it is `pointer-events: none` until the tab is hovered
or the `×` itself is focused, because `opacity: 0` alone still hit-tests.
In the labelled strip it holds reserved space on the tab's right edge, so
pointing at a strip does not shuffle the tabs under the pointer. On a 24 px
icon-only tab there is no space to reserve, so it becomes a small badge in
the tab's **top-right corner** rather than a target over its middle: a
centred close button on a 24 px tab means the obvious click, dead centre on
the glyph, closes the tool instead of opening it. The tab's activity dot
shares that corner and yields it on hover.

The strip is a real `tablist`: only tabs are inside it (the `…` overflow
button is a menu button and sits outside), the selected tab names its pane
with `aria-controls` (`workToolPanelId`, per tool because the pane
crossfades and two panels are briefly in the document at once), and the
strip carries a **roving tabindex** — one Tab stop, landing on the tool you
are looking at, with `←`/`→`/`Home`/`End` moving focus between tabs.
Activation is manual: arrowing past a tool must not attach its terminal or
show its `WebContentsView`, so Enter and Space are the button's own
activation and there is no second key handler to disagree with the click
path.

The header's one fact per tool is a rule on the catalogue
(`workToolContextLabel`), not an `if` cascade at the header: Git shows the
branch (the dirty count is already its status line), Files shows the lane
name, and every other tool shows its own status line. It rides in the
active tab's tooltip and accessible name (`Browser · example.com`), never
as a header line — an icon-only tab would otherwise have no name at all,
and a bar that spelled out what the lit tab already says was saying one
thing twice in 36 px.

The strip is measured, not guessed (`workToolTabLayout`, pure and tested):
below **420 px** of header the tabs drop their words and become glyphs, a
pane too narrow to spell every open tool drops the words rather than
hiding tabs, and only when even the glyphs do not fit do the extras move
into a `…` menu (Radix, on the pane's shared `MENU_CONTENT_CLASS`). The
tool on screen is never the one that overflows, and at least one tab is
always drawn. Six glyphs fit inside the splitter's 280 px minimum, so the
menu is genuinely the last resort.

A dot's colour is its **state**, not its tool
(`workToolDotState` / `workToolDotColor`): red for an error, amber for
"needs you" (`attention` — a login handoff is the whole reason to look
away from the tool you are in), the tool's own hue for live, and idle
tools get no dot at all. Colouring dots by tool made every dot the same
news ("this tool exists"). An erroring or waiting tool earns a dot even
when nothing of its is running. The dot's tooltip is that tool's status
line; clicking it switches, and the dot animates into the header icon
through a shared `layoutId`.

Motion: picker ↔ tool is a 180 ms crossfade with a 4 px y-shift on
`cubic-bezier(0.4, 0, 0.2, 1)`; tab → tab is the shorter, flatter version
of it — 120 ms of opacity and no y-shift, because switching tabs is a
lateral move inside one surface rather than the pane re-opening; dots
enter on the overshoot curve
`cubic-bezier(0.34, 1.56, 0.64, 1)`. A card's hover is the one place the
page spends colour: a 2 px lift, its hairline to 45 % accent, the glyph
tinted to accent, and one soft accent glow, over 160 ms ease-out; press
collapses the lift and takes the card to `scale(0.99)`, so it gives under
the cursor rather than jumping out from under it. The keyboard highlight
draws exactly the hover state, so the two can never disagree. The
last-opened tool carries `aria-current` but **no** fill: the picker is a
page for choosing, and a card pre-tinted in the colour hover uses reads as
already-hovered. Under `prefers-reduced-motion` the transitions and the
lift both go; the fill and hairline still answer the cursor.

Only the ACTIVE tab is mounted. Inactive tools **unmount their view and
keep their service alive**.
Terminals, browser tabs, App Control sessions, and iOS simulator streams
all live in the main process and keep running; only the React views go.
The browser is the one tool with an explicit obligation, since its
`WebContentsView` is composited above the renderer: `hideBuiltInBrowserView`
parks it on every switch away, on close, when the pane goes inactive, on
unmount, and when the Work route deactivates.

### Which tools are open is per lane

`workSidebarTool` (`WorkSidebarTab | null`, null = picker) and
`workSidebarOpenTools` (the strip, in order, with the active tool among
it) are stored per lane in `laneWorkViewByScope` under
`"<projectKey>::<laneId>"`, read and written through
`useWorkSidebarTool(laneId)`. Picking a tool appends it, or activates the
tab it already has without moving it; closing one hands the pane to the
tab on its **right**, then its left, then the picker
(`openWorkToolTab` / `closeWorkToolTab`, pure). Going back to the picker
keeps the strip — the tabs are still open, the pane is just showing the
page you pick from. Persisted state written before the strip existed
(`WORK_VIEW_STATE_VERSION` 6) normalizes its single tool into a one-tab
strip, so upgrading lands on the pane you left rather than an empty
picker. A lane with no stored choice
falls back to the project-scoped copy of the same fields, which is also
where a lane-less (projectless / personal) Work surface reads and writes.
`workSidebarOpen` and `workSidebarWidthPct` stay project-wide: the pane's
geometry is a workspace preference, its contents are not. Picking any tool
(including returning to the picker) forces `workSidebarOpen` true, so every
entry point still acts as a one-click reveal.

Surfaces outside the Work page cannot write this state, because only that
page resolves the lane the pane is following. They file a request instead
(`workToolRequests.ts`) and the Work page drains it against the right
scope — immediately if it is mounted, on mount if the request arrived
while another tab was open. That is the path used by the app shell's
`builtInBrowser` open-request handler and by the command palette's
`Tools: <name>` / `Tools: Show picker` entries
(`buildWorkToolCommands` in `commandPaletteWork.tsx`).

### The pane follows the chat's machine

`WorkSidebar` takes `runtimePin?: OpenProjectBinding | null` — the machine
the active Work session actually runs on, `null` meaning this tab's bound
machine. `TerminalsPage` supplies it from `activeWorkSessionRuntimePin`
(`resolveSessionRuntimePin(activeWorkSession)`). Every tool in the pane
follows the chat: a chat on another machine gets **that** machine's git,
terminals, and files, not the tab's.

- **Lane resolution.** A foreign chat's lane is absent from the tab-bound
  `lanes` array, so the worktree path — and therefore the iOS / App Control
  project root — resolved to null. The pane resolves the active lane against
  `useLanesForPin(runtimePin)` (the pinned machine's slice of the
  cross-machine lane union), falling back to `lanes` only for an unpinned
  session. Lane-mismatch attribution messages are built from that same
  scoped list, so a mismatch names lanes that actually exist on the pinned
  machine.
- **Machine-keyed remounts.** Every panel is mounted with a machine-keyed
  React `key` — `work-git:<pinKey>:<laneId>`, `work-terminal:…`,
  `work-files:…`, `work-ios:…`, `work-appcontrol:…`, `work-browser:…` — so a
  foreign machine's tabs and panel state can never paint into the machine you
  just switched to. Diff selection state (`selectedPath` / `selectedMode` /
  `selectedCommit`) resets on a pin change as well as a lane change.
- **Offline handling.** Pinned calls have no local fallback, so when the
  pinned machine is known offline
  (`useMachineEntryForBinding(runtimePin)?.online === false`) the git and
  terminal tabs render one plain line naming the machine
  (`"<machine> is offline."`) instead of a wall of rejected IPC, and the App
  Control / iOS status probes are skipped entirely. Machine names come from
  `machineNameForBinding` in `shared/machineIdentity.ts` and are absolute
  ("This computer", "MacBook Pro (97)") — never "remote".
- **Pinned calls made from the pane.** `appControl.getStatus(pin)` +
  `appControl.onEvent(cb, pin)`, `iosSimulator.getStatus(pin)` +
  `iosSimulator.onEvent(cb, pin)`, and `terminal.write(..., pin)` for context
  insertion. `runtimePin` is forwarded to `LaneGitActionsPane`,
  `LaneDiffPane`, `ChatTerminalDrawer`, `ChatIosSimulatorPanel`,
  `ChatAppControlPanel`, `ChatBuiltInBrowserPanel`, and `FilesTab`.

Tabs:

- `git` — `LaneGitActionsPane` on top, `LaneDiffPane` underneath
  whenever a file or commit is selected. The two share the row via
  the same min-height-aware flex layout as the lane detail view.
- `files` — `FilesTab` mounted with `preferredLaneId={laneId}` and
  `embedded={true}`. The `embedded` prop drops the desktop title block,
  the `View lane` button, the editor theme toggle, the `Open In` menu,
  and the file count, shrinks the workspace selector so the file tree fits
  a narrow column, paints file glyphs monochrome
  (`MonochromeFileIconsContext`), and replaces the surviving controls with
  one `workToolChrome` row that carries the breadcrumb. Below
  `EMBEDDED_SINGLE_SURFACE_PX` (520) the pane goes **single-surface**: a
  220 px tree beside an editor is two unreadable columns, so one is shown
  at a time — the tree until a file opens, then the editor with a "Back to
  files" crumb. The hidden column stays mounted but `inert`, which is why
  focus-sensitive claims (the code editor's ⌘F) test
  `host.closest("[inert]")` before answering.
- `terminal` — `ChatTerminalDrawer` in `panel` variant, attached to the
  session that owns terminals (see below). Its chrome row carries the
  shell pills plus two ghost controls: **Split**, which stacks a second
  shell under the active one (held as a tab id, not a boolean, so closing
  that shell retires the split instead of leaving an empty half; clicking
  the split shell's own pill makes it active and retires the pane, and the
  next split simply overwrites the stale id), and **Clear**, which wipes
  the active shell's scrollback through
  `clearTerminalRuntimeScrollback(sessionId)`. Only a *different* shell can
  occupy the second pane — the same runtime cannot fill both. The panel
  publishes how many shells it is rendering through `workTerminalShells.ts`,
  which is what the pane header and picker report.
- `ios` — `ChatIosSimulatorPanel` for the active lane (no chat scope),
  driving the simulator on the pinned machine.
- `app-control` — `ChatAppControlPanel` for the active lane, driving the
  controlled app on the pinned machine.
- `browser` — `ChatBuiltInBrowserPanel` over the built-in browser's
  `WebContentsView` tabs for the current ADE window. Unlike the other
  tabs the browser is not lane-scoped; each ADE window owns its own tab
  set, active tab, bounds, and inspect state while all windows share the
  same `persist:ade-browser` partition for authentication. Browser
  selections flow back to the active chat through the same dispatch
  path. Switching off the tab and closing the sidebar both run
  `hideBuiltInBrowserView()`, which calls
  `window.ade.builtInBrowser.stopInspect()` and zeros the bounds with
  `visible: false` so the underlying `WebContentsView` is detached
  from the layout (otherwise it would float over neighbouring panes
  because `WebContentsView` paints above DOM siblings). The pane mounts
  for a chat pinned to another machine too — the browser is always this
  window's — but every loopback URL it is asked for is first tunneled to
  the pinned machine through a port-forward, the URL bar and tab titles
  keep showing the remote origin behind a machine-name badge, and the
  first use of a port an agent chose raises an inline "Agent wants to
  reach port N on <machine>" bar with Allow once / Always for this lane.
  See `docs/features/remote-runtime/README.md`.

  **Login handoff.** An agent that hits a page it cannot get past — a login
  form, a CAPTCHA, an HTTP-auth or client-certificate prompt — calls
  `ade browser handoff --tab <id> --reason "..."`. `startHandoff` in
  `builtInBrowserService.ts` suspends the tab's agent lease into
  `handoff.previousOwner`, clears the agent navigation guard so the person is
  not blocked mid-redirect, marks the tab human-owned, and reveals the pane
  through the usual `open-request` event. While `tab.handoff` is set every
  agent-identified call on that tab throws
  `BuiltInBrowserHandoffActiveError` (`handoff_active`); calls with no agent
  identity — the pane's own toolbar — pass through untouched. The pane shows
  an amber bar with the reason and a `Hand back` button, and swaps to
  "Signed in? / Hand back now / Keep control" once the tab leaves the origin
  it was handed over on; `Keep control` silences that offer until the next
  origin change. Hand-back is human-only: `endHandoff` is exposed on IPC and,
  for locally-pinned chats, on the runtime bridge gated to user clients in
  `adeRpcServer.ts` — there is no agent path to it. The handoff also ends on
  tab close and on its own timeout (default 15 minutes), and each ending
  restores the suspended lease with a fresh TTL and writes a `handoff-end`
  trace entry carrying `endedBy` and `durationMs` next to the `handoff-start`
  entry carrying the reason, so a trace or recording explains the gap.
  `builtInBrowserHandoffSession.ts` is the chat-side half, wired from
  `main.ts`: it raises the requesting session's hand with the same
  `requestAttention` state `ade chat ask` produces, clears it on every ending
  (including ones no CLI is waiting on), and emits a terminal `ade_card`
  reading "Handed back to the agent". The CLI additionally issues
  `session.requestSessionAttention` so the phone push goes out through the
  existing hand-raise path, with `alertTitle: "Sign in for me"` and the reason
  as the body, then blocks on `waitForHandoff` unless `--no-wait` was passed.
  iOS surfaces the same state read-only in the Tools sheet via
  `WorkToolsBrowserTab.handoffReason`.

The sidebar picks a single insertion target per active Work session via
`WorkSidebarContextTarget`: a chat (`kind: "chat"`) when the focused
Work session is chat-typed, a draft composer (`kind: "draft"`, carrying
`draftTargetId`, `laneId`, and `draftKind`) when no session is active
but a draft composer is mounted, or a tracked agent CLI PTY
(`kind: "pty"`, carrying `sessionId`, `ptyId`, and `toolType`) when the
focused Work session is Claude / Codex / Cursor / OpenCode / Droid.
Chat and draft targets receive selections through window events
(`ade:agent-chat:add-attachment`, `add-ios-context`,
`add-app-control-context`, `add-builtin-browser-context`,
`insert-draft`); draft events carry `draftTargetId` instead of
`sessionId` so the matching `AgentChatPane` can identify the correct
draft composer. PTY targets get the same
selections formatted into prompt text by
`apps/desktop/src/renderer/lib/visualContextFormatting.ts`
(`formatIosElementContextForPrompt`,
`formatAppControlContextForPrompt`,
`formatBuiltInBrowserContextForPrompt`) and written into the PTY as a
bracketed-paste payload (`\x1b[200~…\x1b[201~`) through
`window.ade.terminal.write(..., runtimePin)` — PTY insertion is
machine-addressed, so it works against a chat on another machine. After the
write succeeds the sidebar dispatches
`ADE_WORK_PTY_CONTEXT_INSERTED_EVENT`
(`apps/desktop/src/renderer/lib/workPtyContextEvents.ts`) so the active
`TerminalView` can show a brief "context inserted" affordance. When no
chat, draft, or tracked agent CLI session is open in the active Work
lane, the panels simply drop the controls that depend on attachment.
"This session cannot receive inserted context" is a capability the pane
does not offer here, not a warning, so it is no longer narrated in a
banner above controls you can still see.

The one banner that survives is **lane attribution**. The sidebar owns
its own `AppControlSession` / `IosSimulatorSession` subscriptions so it
can detect that a tool was launched from a different lane, and says so —
using the catalogue's own names (`workToolLabel`), because the banner was
the one place the pane called the simulator something the header and the
picker did not. It does not block context insertion: controls affect the
running tool while inserted context goes to the current chat, draft, or
CLI target.

**Terminal ownership is an identity question, not a permission one.**
`terminalOwnerSessionId` is derived from the active session directly, not
from `contextTarget`: any chat session, or any *running* agent-CLI session
with a `ptyId` whose tool type is context-insertable, can host attached
terminals — including one on another machine. It falls back to the
`contextTarget` sessionId only when there is no active session. Deriving it
from `contextTarget` conflated identity with permission and showed foreign
chats an "open a chat or running agent CLI session to attach terminals"
empty state instead of a terminal.

**Context-insertion gating is narrowed to the one path that cannot cross
machines.** PTY context insertion is machine-addressed (`terminal.write`
takes the pin), so it is allowed cross-machine. Only **chat** insertion
fails closed for a foreign machine, because it is a DOM window event
consumed by the chat pane and that path is not machine-addressed; the
disabled reason is correspondingly "Tool context insertion is not available
for chats on another machine." Failing closed for *any* session on another
machine would take PTY insertion down with it.

`isPtyContextInsertableToolType` lives in
`apps/desktop/src/renderer/lib/sessions.ts` (shared by `TerminalsPage` and
`WorkSidebar`): claude / codex / cursor-cli / droid / opencode. Shells are
excluded — they host terminals but are not a context-insertion target.

Open/closed and width go through `useWorkSessions` setters
(`setWorkSidebarOpen`, `setWorkSidebarWidthPct`); which tool is open goes
through `useWorkSidebarTool(laneId).setTool`, which also opens the pane so
choosing a tool from a closed state acts as a one-click reveal. The
tools-pane toggle is the
mirrored `SidebarSimple` glyph on the chat/CLI `WorkSurfaceHeader` (solid
rail on the right), so it matches the sessions-list collapse control on
the opposite edge.

Drawers in `AgentChatPane` accept `hideLaneToolDrawers={true}` when the
pane is mounted as a Work tile (`SessionSurface`), so the chat header
no longer shows the iOS / App Control toggles inside Work — those
drawers now live on the lane-scoped `WorkSidebar`. Proof remains
chat-scoped and stays on the chat header.

### One chrome vocabulary: `workToolChrome.tsx`

Terminal, Git, Files, the simulator, App Control and the browser each had
their own answer to the same row — uppercase mono buttons in one, tinted
`<select>`s in another, three stacked rows in a third. `workToolChrome.tsx`
is that geometry, spent rather than reinvented:

- **Exactly one chrome row per tool**, 40 px
  (`WORK_TOOL_CHROME_ROW_HEIGHT`), under the pane header's own 36 px. The
  row carries `ade-pane-chrome` (which makes it `select-none`, so dragging
  the pane divider no longer leaves half the labels highlighted in accent
  blue) and the same `ade-tool-pane-rule` hairline the header draws, so
  the two read as one piece of furniture.
- **Controls are ghost**: transparent until hover, and hover/press change
  fill only — never size, never colour temperature — over 120 ms
  (`WORK_TOOL_CHROME_MOTION`). Focus is an *inset* accent hairline
  (`WORK_TOOL_CHROME_FOCUS`), because an outset ring on a 28 px square
  overlaps its neighbours in a flush row.
- **Icons are 16 px** in buttons, 12 px inside a chip beside text, and
  nothing in the row is a sentence — what a control does is a tooltip's
  job.
- **Content that is its own surface** (a terminal, a diff, an App Control
  stage) sits inset 8 px with a 10 px radius and a 1 px inset ring, so the
  pane frames it instead of letting it bleed into the chrome.

The browser composes its own row (it has an overflow-hidden omnibox to
fit) and App Control draws a bordered variant; both spend the shared
height and motion constants rather than re-typing them.

### One set of tool feeds, shared

The pane's status lines and activity dots and the floating corner card
all need the same three answers — what the browser, App Control, and the
simulator are doing. `useNativeToolSessions.ts` is that subscription set
(browser status + events, App Control session + events, simulator session
+ events, one capability gate, one definition of "live"), and mounting it
twice opens two sets of subscriptions. `NativeToolFeedsContext.tsx` is
the sharing mechanism: `TerminalsPage` mounts the hook once and provides
it, and the pane and the card both read from the context. Browser error
badges are a pure fold over pushed `diagnostics` events
(`workToolErrors.ts`) — the service emits a tally when a tab's count
moves and resets it to zero on a main-frame navigation, so a reload
clears the badge and nothing polls.

### The floating live-preview card: `WorkLiveCornerCard.tsx`

The Work tab has exactly one pane for a screen tool, so the moment an
agent starts driving the browser while you read a diff, the thing you
most want to see is the thing you just navigated away from. The corner
card is a live thumbnail of the most recently active screen tool that is
**not** the one on screen, parked in a corner of the chat column and one
click away from taking the pane back. Browser and App Control use a fixed
288×180 landscape rectangle (16:10), smaller than the main pane; every frame
uses `object-fit: cover` with `object-position: top`, so a portrait page shows
its top. The simulator keeps a fixed 240×320 portrait card. It asks its source for frames at the card's width in
*device* pixels, so a Retina card is not fed a thumbnail-sized image and
upscaled into mush, nor a 5K panel a full-width one.

Its chrome follows a mini-player: **nothing but an 8 px status dot at
rest**, and a 32 px blurred pill — icon, name, last action, ✕ — that takes
the dot's place on hover and doubles as the drag handle. The picture is
the whole card, so every pixel of chrome is a pixel of preview you do not
get. A 2 px scrub strip **overlays** the media's bottom edge rather than
adding height; the hovered frame is held by trace id, not index, so a new
action shifting the buffer cannot re-caption the picture the pointer is
parked on. Browser "activity" is a diff of the parts a human would call
activity (`browserActivitySignature`), not every status event — closing
the card stops its preview stream, which itself emits one, and a
dismissal undone by the event it caused would never stick.

- **Which tool.** `selectWorkLiveCardTool` in `workLiveCard.ts` picks the
  available, live, non-active tool with the newest activity. Only
  `browser`, `app-control`, and `ios` are previewable
  (`WORK_LIVE_SCREEN_TOOLS` in `state/workLiveCardState.ts`, which the
  store also imports so the list cannot fork); Git and Files have nothing
  to look at.
- **Dismissal is per tool and per lane.** The ✕ records the activity
  stamp the card was showing, so the tool comes back only on strictly
  newer activity — closing it silences the current burst, not the
  feature, and never another tool. Stamps live in the lane's work-view
  state; the card's position is project-scoped and stored as fractions of
  the chat column (`workLiveCardPosition`) so resizing the column keeps it
  in place instead of stranding it off an edge.
- **It costs nothing when nobody watches.** It subscribes to feeds that
  already exist — App Control's screencast, the browser's refcounted
  preview stream, the simulator's shared window capture via
  `iosSimulatorPreviewStream.ts`, which takes its own refcounted parking
  hold and never stops a stream the iOS panel started — paints frames
  straight onto an `<img>`/`<video>` ref inside one rAF (so a 12 fps feed
  causes zero React renders), and tears every feed down the moment the
  Work route is not active.
- **Parked, not hidden.** A `WebContentsView` that is detached or
  `setVisible(false)` has no compositor surface, and with no surface every
  capture path returns an empty image. So a browser tab with a live
  preview subscriber is *parked* past the union of every display's bounds
  instead of being detached — see [Chat › the corner card and parked
  preview views](../chat/README.md#the-corner-card-and-parked-preview-views).

### Tooltips and menus in the pane

`ui/PaneTooltip.tsx` over the pure `ui/tooltipPosition.ts` places the
pane's tooltips: **flip before shift** (a tooltip that would leave the
window flips to the opposite side if that side fits, and is only then
shifted along its cross axis — shifting first is what produced the
clipped "Clos"), and **never over the trigger**, so a tooltip cannot
cover the control it describes. `ui/paneMenuTokens.ts` is the one menu
surface both pane dropdowns paint with: the browser toolbar's Radix
`DropdownMenu` and App Control's hand-rolled menu, which stays
hand-rolled because it hosts inline forms a Radix menu's typeahead and
focus management would fight. The tokens carry paint and width only —
each menu keeps its own positioning, and App Control's is absolutely
positioned inside the pane so it cannot escape the stacking context and
float over another tool's live frame. Max height is viewport-aware
rather than a fixed 320 px, because on a short window a constant cut the
last item ("Stop") in half.

## Terminal renderer: `TerminalView.tsx`

Thin wrapper over xterm.js + `FitAddon`. Caches `Terminal` instances in
a module-level map keyed by `(runtimePin, projectRoot, sessionId, ptyId)`
(via `terminalRuntimeKey`) so a remount does not rebuild the emulator and so
two different project tabs can each cache their own runtime against the
same chat session id without colliding. An unpinned view produces exactly the
old `(projectRoot, sessionId, ptyId)` key; a pin adds a `pin:<kind>:<key>::`
prefix, so a session opened against another machine can never share a cache
entry with a same-id view of the tab's own project. Each cached entry also records
the `(projectRoot, projectRevision)` it was created under; on mount,
`disposeStaleRuntimes(activeProjectRoot, activeProjectRevision)` clears
out-of-date entries. With multi-project tab hosting in `App.tsx`,
project switching no longer evicts another project's terminals: an
entry is only torn down (or scheduled for keepalive teardown) when its
own project context has aged out, **not** when a different project
becomes active. The `projectRevision` counter lives in `useAppStore`
and is bumped on every real project change.

Renderer strategy: WebGL-first, fall back to the DOM renderer on any
init failure or context loss. Canvas renderer is intentionally skipped
(simplified from the earlier three-tier approach).

Exposes `TerminalHealthCounters`:

- `fitFailures`, `zeroDimFits`, `rendererFallbacks`, `droppedChunks`,
  `fitRecoveries`

Key behaviors:

- **Fit recovery** — if a fit computes invalid dims (`cols < 20`,
  `rows < 6`, or host width/height below `MIN_HOST_WIDTH_PX = 120` /
  `MIN_HOST_HEIGHT_PX = 48`), the last valid dims are restored, a retry
  is scheduled (`INVALID_FIT_RETRY_MS = 90 ms`), and the terminal
  content is refreshed. Successful recoveries bump `fitRecoveries`.
- **Measure host** — uses the max of `getBoundingClientRect`,
  `client*`, and `offset*` to handle zero-reported measurements during
  layout transitions.
- **Visibility gating** — `isActive` controls input; `isVisible`
  controls whether fit/resize runs (hidden tiles skip layout work).
- **Preferences reactivity** — watches `useAppStore` for
  `terminalPreferences` changes and applies font family, font size,
  line height, and scrollback to the live terminal, clearing the
  texture atlas to force glyph re-rasterization for WebGL.
- **Frame-write scheduling** — pending frame writes are coalesced on
  `requestAnimationFrame` when the runtime is visible and the page is
  foregrounded; a 16 ms `setTimeout` fallback takes over whenever the
  runtime is parked (no refs), hidden, or the document is
  backgrounded, so background terminals don't stall on `rAF` ticks
  that the browser suppresses. `flushPendingFrameWrites` / `clearFrameWriteSchedule`
  own both code paths.
- **Work-surface reveal redraw** — `TerminalView` listens for the
  `WORK_SURFACE_REVEALED_EVENT` window event (dispatched from
  `PersistentWorkSurface` whenever it returns to the foreground). On
  reveal, the view clears the WebGL texture atlas, flushes any
  pending frame writes, schedules a forced refit on the next animation
  frame, and re-runs `term.refresh(0, rows-1)` plus a focus +
  `scrollToBottom()` when the tile is the active one. This is the only
  reliable signal that "the surface is back on screen at its new
  size" since hidden surfaces no longer fire layout/resize events;
  without it, terminals come back blank after a tab swap.
- **Runtime pin** — the optional `runtimePin` prop is the per-session runtime
  route for a session that lives on another open binding; `null` (the hot path)
  means the tab's own machine and every call keeps its original one-argument
  shape. The pin is stored on the cached runtime rather than read from the
  window, so two simultaneously parked terminals from different machines cannot
  borrow whichever project the window opened last. It is carried by
  `pty.write` / `pty.resize`, `terminal.preview`, `sessions.get`,
  `sessions.readTranscriptTail`, `agentChat.saveTempAttachment`,
  `pty.setDataSubscriptions`, and the `pty.onData` / `pty.onExit`
  subscriptions. Data/exit listeners and the main-side PTY id filter are grouped
  per pin — events are dispatched only to runtimes whose pin matches the
  subscription they arrived on — and the unpinned group keeps one shared
  listener and one signature exactly as before. Because the pin is part of the
  cache key, a session whose pin resolves late (`null` on first render, a real
  binding once the cross-machine lane index loads) moves to a new key;
  `teardownRelocatedRuntimes` disposes the unreferenced runtime left at the old
  key so its subscriptions and pumps do not leak and the same PTY does not end
  up with two emulators. Re-hydrating through the new binding is the point: a
  buffer filled through the old transport may describe the wrong machine.
- **Hydration backfill** — initial hydration prefers
  `ade.terminal.preview`. `serializeSnapshotForHydration` picks which half of
  the snapshot to write: an **alternate-buffer** snapshot (a full-screen TUI
  such as Claude or Codex) repaints the structured visible rows first
  (`serializeSnapshotVisibleRows`, SGR-bracketed ANSI) because replaying an
  older serialized main buffer would corrupt its full-screen state, while a
  **main-buffer** snapshot prefers the persisted `serialized` scrollback so
  attaching to a running shell starts with scrollable history, falling back to
  the visible rows for legacy or empty serialized snapshots. Only when no
  snapshot is available does hydration use the transcript tail. Before either path
  runs, the runtime calls `sessions.get(sessionId)` to find out whether
  the session is disposed; for any disposed session that hasn't
  displayed live data yet, hydration first tries **replay mode** via
  `sessions.readTranscriptTail({ raw: true })` (capped at
  `REPLAY_TRANSCRIPT_MAX_BYTES = 8 MB`) and feeds the result through
  `stripFullScreenRedrawSequences()` before writing. The strip removes
  alt-screen enter/leave (`?1049h/l`, `?47h/l`), hard resets (`\x1bc`),
  and full-screen erases (`\x1b[2J`, `\x1b[3J`, `\x1b[H\x1b[2J`) so each
  TUI redraw appends to the main buffer's scrollback instead of
  clobbering it. Replay-mode runtimes set `replayMode: true`, get
  `REPLAY_SCROLLBACK_LINES = 100_000` scrollback regardless of user
  preference, and skip the usual `trimToLikelyTerminalFrameBoundary`
  hydration trim so the whole transcript stays scrollable. This is
  what makes a disposed Claude / Codex chat session render as a
  scrollable transcript instead of "the last alt-screen frame" or
  "ANSI escape soup". The runtime tracks `hasAppliedTerminalContent`
  and `displayedLiveDataBeforeHydration`; if hydration returns nothing
  renderable while live PTY data is already on screen,
  `scheduleHydrationBackfill` retries the preview every ~100 ms (up to
  120 attempts) until the DOM reports renderable text. The backfill
  also re-arms whenever the tile becomes visible but the xterm rows
  are empty (e.g. after a webgl→dom fallback).
- **Authoritative stream recovery** — the hosted-web PTY adapter marks only a
  non-delta terminal snapshot as `PtyDataEvent.replace`. `TerminalView` then
  increments its hydration generation, cancels hydration/backfill timers,
  discards queued frame and hydration writes, resets xterm/input-mode state,
  and writes the replacement before refitting. Every async preview/transcript
  continuation captures the generation and no-ops if recovery changed it, so a
  slow initial hydration cannot overwrite a newer gap-repair snapshot. Delta
  snapshots and overlap-trimmed live chunks stay append-only.
- **Mouse tracking and forced selection** — `TerminalView` tracks DECSET 1000 /
  1002 / 1003 mouse modes by scanning every PTY data chunk via
  `updateTerminalInputModes`, alongside xterm's own mouse-tracking state.
  xterm continues to forward ordinary mouse input to the embedded TUI. On
  macOS, `terminalMacShiftSelection.ts` converts left-button Shift+mousedown
  to xterm's Option-based force-selection gesture only while mouse tracking is
  active, so local text selection and copy remain available without sending
  that gesture to the CLI.
- **Keyboard-scroll hint (hosted web only)** — every agent CLI runs on the
  alternate screen with mouse reporting on, so the wheel is forwarded to the app
  as mouse reports rather than scrolling xterm's scrollback. Over sync each of
  those reports costs a full ACK-gated round trip (the terminal input queue in
  `webclient/sync/client.ts` sends one input and waits for its ack), so a wheel
  spin advances a few lines per round trip while `PgUp` moves half a screen for
  the same single trip. When a web user wheel-scrolls a mouse-tracking session,
  `TerminalView` shows a dismissible pill naming that session's scroll keys.
  Copy is per provider and vendor-documented (`terminalScrollHint.ts`): Claude
  and OpenCode take `PgUp`/`PgDn`, Codex needs `Ctrl+T` to open its transcript
  overlay first, and Apple keyboards are told `Fn+↑`/`Fn+↓` because they have no
  dedicated PgUp/PgDn keys. Droid and cursor-agent get no hint — their binaries
  carry pageup handling but neither vendor documents it, and a wrong key hint is
  worse than none. Dismissal is remembered per provider, since the keys differ.
- **Cmd+C → SIGINT on macOS** — when the terminal is focused on macOS,
  ⌘C with no current selection sends `\x03` to the PTY (matches the
  Terminal.app behaviour TUI users expect). Selection-aware copy is
  handled by xterm's own selection plus the runtime's clipboard hook.

Font stack defaults: `ui-monospace`, `SFMono-Regular`, `Menlo`,
`Monaco`, `Cascadia Mono`, `JetBrains Mono`, `Geist Mono`, `monospace`.

## Empty state: `WorkStartSurface.tsx`

Rendered when the Work view has no open sessions. Accepts a
`draftContextTargetId` prop that is forwarded to the embedded
`AgentChatPane` so the Work sidebar can target the draft composer
for context insertions. Contains:

- A three-mode liquid-glass pill (`ModeSwitcherPills` in
  `WorkViewArea.tsx`) toggling `draftKind` between **Chat** (compose a
  new ADE chat in the lane), **CLI** (spawn a tracked agent CLI
  session), and **Shell** (plain shell terminal in the lane's
  worktree). `draftKind` is `WorkDraftKind = "chat" | "cli" | "shell"`
  in `appStore`.
- When the sessions list is collapsed, a thin left rail still offers
  **Show sessions**. The empty draft does not put that control in the
  chat header.
- lane selector (`LaneCombobox`) synced to the global `selectedLaneId`
- for chat drafts: `AgentChatPane` in draft mode with provider-specific
  permission controls (`getPermissionOptions`, `safetyColors`)
- for cli drafts: a five-tile provider grid (Claude Code, Codex CLI,
  Cursor Agent CLI, Factory Droid CLI, OpenCode CLI) with logos sourced
  from `ToolLogos.tsx` / `ProviderLogos.tsx`. Selecting a provider
  resets the permission picker to that provider's documented default
  (`getPermissionOptions` keyed by `family`); Droid and OpenCode default
  to `edit`, the rest default to `default`. The "Launch" button calls
  `onLaunchPtySession` (typed as `(args: WorkPtyLaunchArgs) =>
  Promise<WorkPtyLaunchResult>`) with the payload from
  `buildTrackedCliLaunchCommand` (`{ command?, args, startupCommand,
  env? }`). `onLaunchPtySession` forwards `command` + `args` for direct
  argv spawn (Claude / Codex), passes `env` through to the PTY when set
  (OpenCode's `OPENCODE_CONFIG_CONTENT`), and ships `startupCommand` as
  the shell fallback the multi-line Cursor / Droid / OpenCode preambles
  always rely on. The recorded `toolType` and tab title come from the
  shared `LAUNCH_PROFILE_TOOL_TYPE` / `LAUNCH_PROFILE_TITLE` maps in
  `apps/desktop/src/shared/cliLaunch.ts` (the renderer
  `components/terminals/cliLaunch.ts` is now a thin re-export), so
  adding a new provider only requires extending the shared registry
  plus the `WorkStartSurface` option list — the same module also
  powers the iOS `work.startCliSession` mobile launcher.
- for shell drafts: a "Launch" button that opens an untracked shell PTY
  in the lane's worktree (`profile = "shell"`).

Launch commands are built by `apps/desktop/src/shared/cliLaunch.ts`:

- `buildTrackedCliLaunchCommand({ provider, permissionMode, ... })`
  returns the canonical `{ command?, args, startupCommand, env? }`
  shape used for fresh launches and internal provider continuation.
  Permission mode
  choices map onto provider-native flags / configs:
  - **Claude** → `--permission-mode` flag (CLI default plus
    plan/acceptEdits/bypassPermissions).
  - **Codex** → `--ask-for-approval` + `--sandbox` pair. `default`
    maps to `--sandbox workspace-write --ask-for-approval on-request`
    (Codex's documented Guarded Edit semantics; the older `--full-auto`
    alias caused the TUI to drop straight into auto-approval and was
    surprising in the Work tab). `full-auto` keeps the explicit
    `--dangerously-bypass-approvals-and-sandbox` flag, and `config-toml`
    mode defers to `.codex/config.toml`. ADE does not rewrite
    `mcp_servers` for Codex CLI launches; Codex config remains
    host-owned so ADE does not synthesize partial MCP tables that the
    CLI rejects during config validation.
  - **Cursor** → `--mode plan|ask` for read-only modes and `--force`
    for full-auto. Fresh launches start interactive `cursor-agent`
    directly; initial user prompts are submitted through PTY input after
    Cursor readiness, and empty launches do not submit ADE guidance as a
    first turn.
  - **Droid** → an autonomy-tiered settings JSON written to a temp file
    that `droid --settings $ADE_DROID_SETTINGS` consumes; `spec`
    autonomy is the plan/read-only fallback.
  - **OpenCode** → an inline JSON permission policy passed via the
    `OPENCODE_CONFIG_CONTENT` env var (`config-toml` mode skips the env
    so OpenCode reads `opencode.json` instead). Plan mode adds `--agent
    plan`. Fresh launches always start the full root TUI —
    `opencode [-m model] [--agent plan] [--prompt <initial prompt>]`.
    There is deliberately no `run --interactive` branch and no
    reasoning/fast `--variant`: the root command silently drops unknown
    args, so variants remain a chat-runtime feature and tracked launches
    carry only the model and permission agent.
  Every provider also receives ADE CLI guidance — Claude through
  `--append-system-prompt`, Codex/Droid/OpenCode as a leading prompt
  argument, and Cursor through PTY `initialInput` only when there is an
  initial user prompt.
- `buildTrackedCliStartupCommand({ provider, permissionMode, ... })`
  thin wrapper that returns just the shell-typed `startupCommand`.
- `resolveTrackedCliResumeCommand(session)` — internal runtime helper
  for rebuilding the command used behind the continuation composer.
  It calls `buildTrackedCliResumeCommand(metadata, overrides)`, which knows how
  to format Claude (`claude --resume <uuid>`), Codex (`codex resume
  <thread>`), Cursor (`cursor-agent --resume <chatId>` / `--continue`),
  Droid (the same `--settings` preamble plus `droid --resume <id>`),
  and OpenCode (`opencode --session <id>` / `--continue`). The
  `prompt` override is used by `sendToSession` for the first
  ended-session follow-up; `resumeSession` rebuilds the same command
  without a prompt.
- `buildOpenCodeReplayResumeLaunchCommand` — OpenCode continuations that
  carry the first follow-up prompt use this shape when the installed CLI
  supports replay resume: root `--mini` mode replays the newest messages on
  resume by default, and `--replay-limit <N>` (`OPENCODE_RESUME_REPLAY_LIMIT`,
  40) caps how far back the freeze-frame reaches; the prompt travels via
  `--prompt`. An explicit `--replay` flag is an upstream error on current
  OpenCode, so nothing sends one. The support gate probes root
  `opencode --help` (not `run --help`) for both `--mini` and
  `--replay-limit`, with an env override
  (`ADE_OPENCODE_REPLAY_RESUME=1|0`) forcing either way; without support ADE
  falls back to the plain root-TUI resume above.

## Context menu: `SessionContextMenu.tsx`

The right-click menu uses one grouped, liquid-glass menu vocabulary. Every row
carries a 13px duotone Phosphor glyph so the list is scannable:

- Chat rows put **Rename…**, **Generate chat title**, **Generate lane name**,
  **Generate status line**, and **Generate all three** in a **Name & status**
  submenu. Non-chat rows keep Rename in the unlabelled identity block (inline
  text input, `manuallyNamed: true`), alongside optional Set tag, pin, and grid
  removal.
- **Lifecycle** carries runtime stop, Snooze/Wake, and Settle/Un-settle.
- **Go to** carries lane and optional web navigation.
- **Copy** is a hover/keyboard submenu for the session ID and deep link.
- Destructive Stop & delete / Delete chat / Delete session actions are fenced
  into the final red block.
- Chat: Set tag… (running Claude only), Settle/Unsettle when at rest — "at rest"
  being the negation of `sessionIsMidFlight` (`renderer/lib/terminalAttention.ts`),
  the one predicate the row's hover slot and its right-click menu share. Note
  mid-flight is narrower than the `running` phase: it is `stale`, or `running`
  with `liveness === "turn"`. A session whose turn has ended but which still owns
  background work is promoted back to `running` with a non-turn liveness, so it
  is *not* mid-flight and must stay settleable — settle teardown is what stops
  that work and releases the warm agent. Hiding Settle there left the one state
  a user most wants to stop as the only state with no control. The chat block
  also carries **Dismiss & settle** for `Needs you`, and Delete chat. Dismissal routes
  through the backend settlement transaction; it interrupts the provider and
  clears live/restored pending input before writing settle instead of sending a
  synthetic decline.
- Chat metadata generation makes one structured request for all three visible
  fields and applies only the selected fields. A status-only refresh sends the
  lane name, chat title, worktree folder, and last assistant paragraphs — not
  the full transcript, sibling threads, or git dump. Title refresh still carries
  this thread's full transcript; lane-name refresh still carries every other
  thread in the lane plus the git work that differs from the remote/base. While
  those fields generate, the session card and work-surface header mask them in
  place with the same shimmering "Naming …" animation auto-created lanes use.
  It may intentionally replace a
  manual title because the menu action is explicit user intent; edits made while
  the request is running win per field. Generate lane name is disabled for the
  primary lane, and a busy session disables duplicate generation.
- PTY: Stop runtime / Stop & delete while running, Delete session after exit,
  and Settle/Unsettle when the runtime is not actively working (same shared
  predicate). A tracked CLI's
  explicit `ade chat ask` marker can use **Dismiss & settle**; a raw native TUI
  prompt shows the disabled **Resolve input to settle** row.

Every row also carries one exhaustive lifecycle block holding each action that
changes where the sidebar files it. **Snooze…** expands in place into the
durations resolved by `resolveSnoozePresets` (`In 1 hour`, `This evening`,
`Tomorrow`, `Next week`, `Until I'm asked` — each with a time column beside it,
and `This evening` dropped once 18:00 is within an hour or past, so the row
count varies with the time of day); an already-snoozed row instead shows
**Wake now** with its wake label. Settle actions operate on explicit declarations: a declared settle
has `settledAt` for **Unsettle** to clear and can additionally be pinned with
**Keep active**, while `settleOverride` explicitly pins either state. The block
is kept exhaustive on purpose: a
row that reaches the end of it with nothing rendered is a row the user cannot
un-hide. All writes go through
`components/terminals/sessionLifecycleActions.ts`, which also owns the
five-second undo toast, so the row menu, the hover `SessionSnoozeControl`, and
the chat header chips can never disagree about what an action does.

A singleton lane has no divider to right-click, so its session menu adds a
**Lane** hover submenu. `LaneActionsSubmenu` renders the exact
`buildLaneMenuGroups()` model used by `LaneContextMenu`; it does not transcribe
the actions. A headerless foreign card passes its `lane`, `binding`, and
`machineId` into that submenu so it is the same menu as a local singleton —
**Start chat in lane** writes `draftMachineId` for the owning machine, colour
and manage pin to that runtime, and tab/split actions (which navigate the local
Lanes tab) stay omitted. The old **Open lane menu…** stub remains only when the
lane cannot be resolved at all. Menu subpanels share `MenuSubmenu`'s 180 ms open
delay, 300 ms pointer-safe close grace, viewport clamping, and keyboard
navigation.

The rename input uses local state. Chat rows submit through
`agentChat.updateSession({ title, manuallyNamed: true })`; PTY rows submit
through `sessions.updateMeta({ title, manuallyNamed: true })`. Errors bubble up
to `renameError` in `TerminalsPage`.

`Set tag…` is a second inline editor that reuses the same input chrome.
It appears only for running `claude-chat` sessions (writing a tag needs a
live Claude SDK runtime — `updateSession` throws for ended sessions),
submits `agentChat.updateSession({ sessionId, tag })` where an empty
value clears the tag, and the resolved `claudeTag` renders as a small
mono pill on the session card.

## Work view hook: `useWorkSessions.ts`

A single hook that owns a lot of state:

- session lists, deduped via `listSessionsCached()` with project-root +
  lane + status keying. When the IPC refresh returns a persisted row
  that already has a pending optimistic session for the same id, the
  hook calls `mergePendingOptimisticSession(persisted, optimistic)` to
  keep the optimistic `ptyId` on the row until the persisted view
  reflects it. The helper only merges when the persisted row is still
  `running`, the optimistic session carries a non-empty `ptyId`, and
  the persisted `ptyId` does not already match — that case returns the
  persisted row untouched and drops the pending entry. When merged,
  the row keeps the persisted fields but inherits the optimistic
  `ptyId` (plus `toolType` / `runtimeState` as gap-fillers when the
  persisted row hasn't backfilled them yet), and `keepPending: true`
  leaves the pending entry in place so the next refresh can re-merge
  if the persisted row still hasn't caught up. This closes a race
  where the persisted row landed before its `ptyId` was written and
  would otherwise clobber the optimistic attachment, leaving the new
  `TerminalView` unable to subscribe to live PTY data
- per-project work view state (open items, active/selected, view mode,
  draft kind, text/lane filters, chip filters, lane ordering and pins,
  organization, collapsed IDs,
  focus-hidden flag)
- lane-scoped work view state keyed as `projectRoot::laneId`
- persistence to `localStorage` under `ade.workViewState.v1`, written on
  every mutation
- `refresh({ showLoading, force })` — forces a cache bust and reloads
- project-switch hydration guards: cached destination rows can render
  immediately, but they are not treated as authoritative until the
  active project's refresh applies. While that guard is set,
  `useWorkSessions` does not mirror the current `sessions` array back
  into `sessionsCacheByProject` and does not prune persisted open tabs,
  because React can briefly render the previous project's session list
  after `projectRoot` changes.
- the Work tab's per-session runtime routing, through the single
  `useWorkMachineRouter()` instance it owns. It is re-exported as
  `machineRouter` and `resolveSessionRuntimePin` (which `TerminalsPage` passes
  down to `WorkViewArea`, which hands it to each `SessionSurface` as
  `runtimePin`). `canMutatePinnedProjectUi` is `machineRouter.isLivePin`, launch
  and resume paths remember their pin through the router, and `stopRuntime` /
  `stopAll` resolve theirs from the combined cross-machine union so a foreign
  PTY is disposed on its owning machine.

`useWorkSessions({ active })` accepts an optional `active` flag (default
`true`). When `active` is false, the hook stops scheduling background
refreshes, defers the initial `refresh` until the route flips back to
`/work`, and cancels any pending refresh timer on transition. Callers
that mount the hook on tabs other than Work pass `active: false` to
avoid scanning sessions while the user can't see them.

The hook exposes `openSessionTab`, `focusSession`, `selectLane`,
`upsertOptimisticChatSession` (so new chats appear in the tab strip
before the IPC round-trip completes), `refresh`, and the right-sidebar
setters `setWorkSidebarOpen` and `setWorkSidebarWidthPct` (clamped
26–55%). Which tool the pane shows is not here — it is per lane, and lives
in `useWorkSidebarTool`.
`chatSessionEvents.ts` uses that optimistic path for durable chats created by
headless/batch launch, then schedules a short background refresh.

It also exposes `setWorkSessionFilters`, `toggleWorkLanePinned`,
`setWorkLaneSortMode`, and `reorderWorkLanes`. Each takes over any transient
deeplink framing before persisting the user's view choice. A reorder starts
from the lanes currently rendered on screen, prunes dead ids only on write, and
sets Manual even for a no-op drop from another mode so the control truthfully
describes the current ordering. `useLanePrsByLaneId` supplies one coalesced PR
read plus `prs-updated` pushes for the bound machine, folded together with each
other machine's PR rows from the cross-machine union, and serves both the lane
badges (machine-scoped keys) and the Has PR filter (the union key);
with no active chips the filtered session list is returned by reference so the
new controls do not add avoidable downstream re-renders.

`launchPtySession` accepts `WorkPtyLaunchArgs` and returns
`Promise<WorkPtyLaunchResult>`. The args carry `disposition?:
WorkPtyLaunchDisposition` (`"foreground" | "background"`). When
disposition is `"background"`, the hook inserts the optimistic session
and invalidates the cache but skips `selectLane`, `focusSession`, and
`openSessionTab` so the launch happens without stealing the user's
current focus. When disposition is `"foreground"` (or unset), the hook
opens the tab off the synchronous `ptyCreate` result before kicking off
the background refresh: it focuses the session, calls `openSessionTab`,
and only then fires `refresh({ showLoading: false, force: true })`.
This is what makes the Work tab's optimistic terminal visible the
moment the PTY exists, which is the window in which the new
`TerminalView` runtime needs to attach so it can subscribe to live PTY
data before fast TUIs like Codex or Claude paint their first frame.
Waiting on the refresh round-trip first used to lose the initial paint
and leave the terminal blank. The `WorkPtyLaunchArgs` type (defined in
`apps/desktop/src/renderer/components/terminals/cliLaunch.ts`) carries
`laneId`, `profile`, and optional `command`, `args`, `startupCommand`,
`startupDelayMs`, `env`, `title`, `tracked`, and `disposition`. The
helper (and its lane-scoped twin in `useLaneWorkSessions`) builds a
default launch payload with `buildTrackedCliLaunchCommand` when the
caller didn't override `command`/`args`/`env`, so every entry point —
chat composer launch button, TopBar work controls, lane Work pane —
produces the same argv-based spawn with ADE CLI guidance baked in.
`profile` is a `LaunchProfile` (`"claude" | "codex" | "cursor" |
"droid" | "opencode" | "shell"`); the matching tab title and recorded
`TerminalToolType` come from the shared `LAUNCH_PROFILE_TITLE` /
`LAUNCH_PROFILE_TOOL_TYPE` maps in
`apps/desktop/src/shared/cliLaunch.ts`.
The runtime strips leading `ENV=value` assignments before sniffing the
provider, so continuation commands the OpenCode preamble emits
(`OPENCODE_CONFIG_CONTENT=… opencode --session …`) round-trip
correctly. `startupDelayMs` is forwarded into the `ade.pty.create`
payload only when the caller passes it (so non-Work callers don't
inherit a non-zero default); the Work CLI launch path in
`AgentChatPane` passes `workCliStartupDelayMs = 180` and
intentionally omits `command` / `args` so every Work CLI launch
goes through the shell + `startupCommand` path (see
[pty-and-sessions.md](./pty-and-sessions.md#create-flow-createargs)
for how the PTY service consumes the delay).

`useLaneWorkSessions` (in
`apps/desktop/src/renderer/components/lanes/useLaneWorkSessions.ts`)
wraps the same state but scopes to a single lane for the Lanes tab.
It consumes the same renderer-local chat-session creation announcement as
Work, filters it to the active project/lane, inserts the optimistic chat row,
and schedules a short background refresh.
Its `launchPtySession` also accepts `WorkPtyLaunchArgs` and returns
`WorkPtyLaunchResult`, forwarding `startupDelayMs` and respecting
`disposition` the same way. The lane-scoped launcher builds an
optimistic `TerminalSessionSummary` from the `ptyCreate` result and
upserts it into the session list immediately, then fires the forced
session-list refresh as fire-and-forget so the tab opens without
blocking on the IPC round-trip.

## Session delta hook: `useSessionDelta.ts`

Lightweight fetcher for `SessionDeltaSummary` keyed by session ID.
Called by `SessionCard` with `{ enabled: true }` and returns the
delta with `filesChanged`, `insertions`, `deletions`, `touchedFiles`,
`failureLines`, `computedAt`. Failures return null; the card renders
nothing when no delta is available.

## Shared helpers

- `apps/desktop/src/renderer/lib/sessions.ts` — `primarySessionLabel`,
  `preferredSessionLabel`, `shortToolTypeLabel`, `isChatToolType`,
  `isPtyContextInsertableToolType`, `buildOptimisticChatSessionSummary`.
- `apps/desktop/src/renderer/lib/terminalAttention.ts` —
  `canonicalInputFromSummary`, `sessionCanonicalUiState`,
  `sessionStatusBucket`, `sessionFilingBucket`, `sessionStatusDot`,
  `sessionCapsuleBadge`, `sessionIsMidFlight` (the shared Settle-affordance
  predicate — see the context-menu section),
  `sessionNeedsYou`, `summarizeTerminalAttention`,
  `sessionInlineStatusLabel`, `sanitizeTerminalInlineText`.
- `apps/desktop/src/renderer/lib/sessionListCache.ts` —
  `listSessionsCached`, `invalidateSessionListCache`. Normal reads coalesce;
  forced reads and mutation invalidation bypass stale in-flight snapshots,
  with promise identity preventing late responses from replacing fresh cache.
- `apps/desktop/src/renderer/lib/chatSessionEvents.ts` —
  `announceWorkChatSessionCreated` invalidates both renderer list caches and
  publishes a durable chat session for optimistic Work/Lanes insertion;
  `shouldRefreshSessionListForChatEvent` gates refreshes on streamed chat IPC
  events so the session list does not thrash on every message.

## Gotchas

- Mount stability matters. Do not unmount a `SessionSurface` just
  because a tab is hidden; use `terminalVisible={false}` instead so the
  PTY stays attached. The cached runtime has a 400 ms dispose timer
  that fires only when refs hit zero and stay there.
- The session list cache keys normalized `ListSessionsArgs` by
  `projectRoot + laneId + status + toolTypes`; Work requests the full inventory
  and derives its Status grouping locally.
  Events that should update all views (e.g. a new chat session) should
  call `invalidateSessionListCache()` before the first `refresh()`.
- Do not infer “loud” from the Your move bucket. That bucket deliberately mixes
  deterministic `needs_you` with quiet `ready`/`idle`; use
  `sessionNeedsYou()` or `summarizeTerminalAttention()` for badges,
  notifications, or interruption.
- Do not clear `settledAt` on assistant output from a chat that just declared
  itself done. Chat settle is cleared at the next user turn; only PTY output
  clears settle on activity. Scheduled/background chat wakes temporarily render
  Running and return to Settled when idle.
- Do not derive anything from the snooze columns except *where a row is filed*.
  Snooze is a visibility overlay: `canonicalSessionState()` never reads it, the
  status dot never changes, and the counts, badges, and Dock badge stay
  truthful. Use `effectiveSessionFilingBuckets` for renderer grouping (and
  `sessionFilingBucket` for the base single-row rule) and the raw
  `isSessionSnoozed` for row chrome.
- Do not schedule lifecycle writes for snooze expiry. Expiry is derived by
  comparing `snoozedUntil` to now. Render-only deadline timers may bump a
  counter to repaint an open surface: the Work hook covers the full roster,
  while an open chat, the command palette, and the standalone foreign-row pane
  arm their own bounded timer when they need one. None mutates session state, so
  there is still one source of truth rather than a watchdog that can diverge
  from surfaces not currently mounted.
- Nothing *derives* a settle. A clean process exit leaves a row `ended`, never
  `settled` (`sessionCanonicalState.ts`), so every settled row has either a
  `settledAt` or a `"settled"` override and plain Unsettle clears both. The
  `"active"` keep-active pin exists to hold a row out of the quiet tier when
  something later declares a settle on it (the PR-merge policy), not to rescue
  an inferred one.
- Refresh ordering for launches — use the synchronous `ptyCreate` /
  chat-create result to `openSessionTab` before the background forced
  refresh, then merge any stale persisted row with the optimistic row.
  Do not prune open tabs until an authoritative refresh for the current
  project has applied.
- The Work tab and the Lanes tab share the hook; changes to
  `useWorkSessions` ripple. Keep lane-scoped persistence keyed by
  `projectRoot::laneId` or the Lanes tab state leaks across projects.
- The Work grid is `PaneTilingLayout` — every visible session has a
  leaf and stays mounted. Grid tiles pass `terminalVisible={true}`;
  `isActive` controls input but not mount state, so multiple PTYs can
  stay live at once. The gridLayoutId is namespaced
  (`work:grid:tiling:v1:<projectRoot>[::<laneId>]`) so a persisted
  layout travels with the project/lane pair.
- Because every tile stays mounted, grid-set membership is a direct
  multiplier on renderer heap, and it is capped at
  `MAX_WORK_GRID_TILES` = 6 (`renderer/lib/workGrid.ts`). An uncapped set
  can OOM the ~4 GB renderer. The cap is enforced in three places that
  must agree: `addSessionBesideTarget` refuses a new member once the
  target set is full; `WorkGridView` withholds
  `acceptExternalDropMime` at that point so a full grid stops
  advertising the drop target and no drop indicator appears (measured
  against persisted `gridSet.sessionIds`, the same thing
  `addSessionBesideTarget` counts — measuring the resolved tiles instead
  would advertise a drop that then silently no-ops); and
  `normalizeWorkGridSets` in `appStore.ts` trims a set persisted by an
  older uncapped build on load. Trimmed members are left **unclaimed**
  (not marked seen) so they remain openable as ordinary single sessions
  rather than disappearing.

## Cross-links

- Main-process services feeding these surfaces:
  [pty-and-sessions.md](./pty-and-sessions.md)
- Lane gating and worktree isolation:
  [runtime-isolation.md](./runtime-isolation.md)
- Agent chat pane lives under
  `apps/desktop/src/renderer/components/chat/AgentChatPane.tsx` and is
  shared with this feature when the session is chat-typed.
