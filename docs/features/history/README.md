# History

History is DAEX's per-project timeline, one page (`HistoryPage`) with two
surfaces sharing a zustand store: **Commits** (a git graph for the focused lane)
and **Activity** (recorded operations plus chat rows). The URL remembers the
surface, lane and selection, so links land on the same row. Commits come from
`git log` on the lane's worktree; Activity comes from the `operations` table
plus rows synthesized from chats.

## Source file map

Main and runtime:

- `apps/desktop/src/main/services/history/operationService.ts` — `operations`
  CRUD: `record`, `start`, `finish`, `recordCompleted`, `list`, `get`,
  `listHeadChanges`, `pruneOld`.
- `apps/desktop/src/main/services/git/gitOperationsService.ts` — brackets every
  git operation (`runLaneOperation`), captures pre/post HEAD, owns undo/redo,
  tags, resets and pull modes; verifies the lane's worktree root before any
  lane git read or write.
- `apps/desktop/src/main/services/lanes/laneService.ts` — `CreateLaneArgs.startPoint`
  ("Create lane here").
- `apps/desktop/src/main/services/state/kvDb.ts` — schema (`operations`,
  `terminal_sessions`; still creates the retired `checkpoints` and `pack_*`
  tables, which nothing writes).
- `apps/desktop/src/shared/historyExport.ts` — `buildHistoryExport` (desktop and
  web).
- `apps/desktop/src/shared/adeCloud/accountReader.ts` — commit reads for a
  resting DAEX Cloud lane; `renderer/components/adeCloud/CloudGitAsOf.tsx`.
- Shared types: `shared/types/git.ts` (`GitPullMode`, `GitCreateTagArgs`,
  `GitResetCommitArgs`, `GitHeadChangeActionArgs`, `ListOperationsArgs`,
  `ExportHistoryArgs`), `shared/types/lanes.ts`.

Renderer (`apps/desktop/src/renderer/components/history/`):

- `HistoryPage.tsx` (layout, URL ↔ store, lane sync, auto-refresh),
  `useHistoryLaneSync.ts`, `historyUrlHydration.ts` (`historyCommitsPath`, used by
  every "Commit history" entry point), `useTimelineStore.ts`, `timelineTypes.ts`.
- Commits: `CommitHistoryView.tsx` (virtualized, pages 100 commits with `skip`),
  `CommitRow.tsx`, `CommitGraphLayer.tsx`, `commitGraphLayout.ts` (pure layout:
  `buildCommitGraphLayout`, `contractCommitGraph`, `branchTipKeep`,
  `assignCommitOwners`, `computeDividerAfterRow`), `CommitRefBadges.tsx`,
  `CommitToolbarControls.tsx`, `commitRowModel.ts`, `commitViewPrefs.ts`,
  `historySearch.ts`, `CommitDetailPanel.tsx`, `HistoryGitContextMenu.tsx`,
  `historyGitActions.ts`, `historyLaneActions.ts`, `HistoryLanePicker.tsx`,
  `historyClipboard.ts`.
- Activity: `TimelineToolbar.tsx`, `TimelineGraph.tsx` (lazy),
  `TimelineListView.tsx`, `TimelineCompactView.tsx`, `EventDetailPanel.tsx`,
  `eventTaxonomy.ts` (`EVENT_KIND_META`, the source of truth for categories,
  importance and shapes), `historyActivitySources.ts`
  (`fetchSupplementalTimelineRecords`).

## Gotchas / fragile areas

- **Start/finish pairing.** An operation with no `finish` stays `running`
  forever; use `runLaneOperation` instead of calling start/finish by hand.
- **Undo/redo re-read HEAD** and refuse if it moved since the target operation,
  so `git reset --hard` never clobbers later work. Undo also requires the
  recorded `metadata.branchRef` to match the lane's current branch.
- **`finish` merges `metadataPatch` shallowly**; nested objects are replaced.
- **Status filters**: `listOperations.status` takes one status; export also
  takes `"all"`. Multi-select filters run client-side, after the 1,000-row clamp.
- **`laneName` is a left join**: deleted lanes show `laneName: null`.
- **Synthesized chat rows never export**; the export is the operations table.
- **Graph edges** are filtered to the virtual window (±2 rows); a long edge may
  pop at the seam by design.
- **`startPoint`** is resolved with `git rev-parse --verify`; an invalid ref
  throws `Start point not found for new lane: …`, which the action surfaces.
- **Lane worktree check**: a missing or stale worktree path throws "restore or
  recreate the lane worktree" for every lane git call, so History never reads
  the primary checkout by mistake.

## Where this runs

Operations live in the brain of the machine that owns the lane's worktree.

- **Reads take the lane's pin.** `window.ade.history.listOperations` and
  `exportOperations` accept `pin?: OpenProjectBinding | null` and route through
  `callPinnedOrBoundRuntimeActionOr(pin, "operation", …)`; the Commits view's git
  reads use the selected lane's binding. A pinned export reads rows from that
  machine and writes the file on this one; the web client builds the file in the
  browser and downloads it.
- **Every machine with the repository**: the lane picker groups lanes by machine;
  Activity reads are paged per machine so one slow brain does not hold the rest.
  Mutating git actions are disabled for a lane on another machine.
- **With no computer awake**, a resting DAEX Cloud lane (`isAccountAnsweredPin`)
  shows its pushed commits from GitHub through the account reader, with
  `CloudGitAsOf` ("As of 3:12 PM, saved by its computer at rest", from
  `adeCloud.projectOverview`). Unpushed commits show when the computer is on. Git
  actions that change the lane wake it first.

## Surfaces

### Commits

- **This lane** walks the lane's HEAD; **All lanes** (`scope: "lanes"`, `git log
  --date-order`) walks HEAD, the base and every active lane's branch. Each lane's
  own commits take its colour; the base line is grey; unowned branches are
  fainter. Hovering focuses a lane's path.
- In This lane, a divider row (`main · 34 behind`) sits under the lane's oldest
  own commit (a layout gap, so lines run through). An unmeasured or stale `0/0`
  is never read as "even with the base": the divider waits for a measured
  `ahead`, and the drift pill shows "Last known".
- Rows: ref badges, agent logo (from a `Co-authored-by` trailer), subject with its
  `(#123)` PR link, author (shown only where it changes), age, SHA. Hollow nodes
  are unpushed; the ringed node is HEAD. "Fold to branch tips" keeps refs,
  merges, roots and fork points.
- The details pane shows the message, the agent and chat at commit time, PR,
  push state, parents, files and DAEX activity rows (lane operations whose pre/post
  HEAD matches, cached 15 s). Enter or **Changes** opens the diff full-page.
  Right-click or ⋯ opens grouped git actions (`historyGitActions.ts`); destructive
  actions are disabled for a commit not on the focused lane's history.
- **Search** (`historySearch.ts`): bare text, quoted phrases, `message:`,
  `author:`/`@`, `commit:`/`#`, `branch:`/`ref:`, `parent:`, `is:merge|local|pushed`.
  Results keep the graph connected; the view reads older pages until 60 matches
  or 3,000 commits ("Search older" goes further).
- `LaneGitActionsMenu` (`historyLaneActions.ts`) runs lane operations from the
  toolbar. Lanes' overview and lane context menus offer **Commit history**.

### Activity

Recorded operations merged with synthesized chat rows (`chat.session`, from
`agentChat.list({ includeAutomation: true })`), deduplicated by id and sorted by
`startedAt`. View modes: graph (per-lane swimlanes), list (columns: Time, Graph,
Event, Lane, Status, Duration; Author and SHA hidden), compact. Scope sets the
importance threshold (Key: high; Standard: high + medium; Detailed: + low; All:
everything). Filters: lanes, categories, statuses, time range, text, per-lane
solo/hide. Auto-refresh every 4 s while something runs and the window is visible
and focused. Export writes JSON by default (500 rows).

## What history captures

### Operation kinds

Recorded through `operationService` (metadata in parentheses):

- `git_commit` (message, filesChanged, sha, branchRef, baseRef),
  `git_checkout_branch`, `git.merge`, `git.rebase` (also `conflictService`),
  `git_push`, `git_push_force_with_lease`, `git_pull` (`mode`), `git_fetch`,
  `git_sync_merge` / `git_sync_rebase`, `git_cherry_pick`, `git_revert`,
  `git_tag_create`, `git_reset_soft|mixed|hard`, `git_undo_head_change`
  (`undoneOperationId`, `redoHeadSha`, `targetHeadSha`), `git_redo_head_change`,
  `git_stash_*`, `git_rebase_continue|abort`, `git_merge_continue|abort`.
- PR creation (`prService`).
- Old databases may hold `pack_update_*` rows; nothing records them now.

`eventTaxonomy.ts` must have an entry for every kind.

### Status and SHA transitions

`running | succeeded | failed | canceled`. Every git operation records
`preHeadSha` and `postHeadSha`. `undoLastHeadChange` picks the latest
head-changing operation on the lane (skipping undo and checkout rows), checks the
branch and that HEAD still equals its `postHeadSha`, then resets to `preHeadSha`;
`redoLastHeadChange` restores the undo's `redoHeadSha`.

### Retention

`operationService.pruneOld()` drops finished operations older than 60 days and
keeps at most 5,000 finished rows per project, never touching `running` rows. It
is called when the desktop's in-process project context starts (`main.ts`,
`operation_prune_failed` on error); the brain runtime does not call it.

## IPC surface

- `ade.history.listOperations` — `{ laneId?, kind?, status?, limit?, offset? }`,
  default 300, max 1,000.
- `ade.history.exportOperations` — `{ format: "csv" | "json", laneId?, kind?,
  status?, limit? }`; cancel returns `{ cancelled: true }`.
- Git channels the page uses: `ade.git.listRecentCommits` (`{ laneId, limit?,
  skip?, scope?, includeCoAuthors? }`, limit 1–500 per page, no overall cap;
  `scope: "lanes"` marks unpushed commits), `listBranches`, `listCommitFiles`,
  `getCommitMessage`, `getOriginRemote`, `getOpenPrForBranch`, `checkoutBranch`
  (`startPoint`), `cherryPickCommit`, `revertCommit`, `createTag`,
  `resetToCommit`, `pull` (default `ff-only`), `undoLastHeadChange`,
  `redoLastHeadChange`. The same git actions are sync remote commands
  ([remote commands](../sync-and-multi-device/remote-commands.md)).
- Conflict channels accept a bare `laneId` (legacy) or `{ laneId }`
  (`normalizeLaneIdArg`).

## Export

Up to 1,000 rows from the lane's machine; `buildHistoryExport` writes
`ade-history-<projectSlug>-<YYYY-MM-DD>.<csv|json>` (the file name keeps its old
prefix). JSON: `exportedAt`, project, filters, `rowCount`, `rows`. CSV: `id,
laneId, laneName, kind, status, startedAt, endedAt, preHeadSha, postHeadSha,
metadataJson`, RFC 4180 quoted, with a `'` prefix on cells starting `=`, `+`,
`-`, `@` or a tab.

## What is not in history

Individual tool calls, UI navigation, PR polling and check reruns, AI token usage
(`ai_usage_log`), terminal sessions (their own `terminal_sessions` table; they do
not appear in Activity). Chat transcripts live in the chat system
([transcript and turns](../chat/transcript-and-turns.md)).

## Related docs

- [Lanes](../lanes/README.md) — lane creation and `startPoint`.
- [Remote commands](../sync-and-multi-device/remote-commands.md).
- [Chat](../chat/README.md).
