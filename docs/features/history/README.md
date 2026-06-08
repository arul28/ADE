# History

History is ADE's per-project timeline. It has two surfaces sharing a
single page: a **Commits** view (GitKraken-style DAG for the focused
lane) and an **Activity** view (the unified operations + sessions +
worker feed). Both surfaces live inside `HistoryPage` and
sync through a shared zustand store; the URL remembers which surface,
which lane, and which selection are active so deep links land back on
the same row.

The Activity feed is sourced from the `operations` SQLite table plus
in-memory adapters that synthesize timeline rows from chat sessions,
CTO sessions, and worker runs. Git commits in the Commits
view come from `git log` on the lane's worktree, not from the
operations table.

## Where this runs

Operation recording, the `operations` SQLite table, and the export
pipeline all live inside the **active ADE runtime** (local machine runtime for
local-bound windows, SSH-attached remote runtime for remote-bound
windows). Every git operation runs through the runtime's
`gitOperationsService` which brackets the command with
`operationService.start` / `finish`, so the timeline records work
performed on whichever host owns the lane's worktree. The renderer's
`window.ade.history.listOperations` and `exportOperations` go through
preload's `callProjectRuntimeActionOr("operation", …)` first and fall
back to the legacy in-process IPC handlers when no runtime is bound.
For remote-bound windows the operations database lives on the remote
machine; the desktop simply renders rows it pulled through the
runtime. The Commits view runs `git.listRecentCommits` /
`git.listBranches` through the same runtime route. The export-to-disk
dialog itself still runs on the desktop because the file is saved on
the user's local machine — the runtime returns the rows, then the
desktop's IPC handler writes the CSV/JSON to disk through the native
save dialog.

Supplemental activity sources (chat sessions, CTO snapshot,
worker runs) are fetched directly from the renderer through the
existing per-feature preload bridges and merged into the timeline at
render time; they are not persisted into `operations`.

## Source file map

Main process / runtime services:

| Path | Role |
|---|---|
| `apps/desktop/src/main/services/history/operationService.ts` | CRUD for `operations` rows; the canonical entry point for `record`, `start`, `finish`, `list`, `get`, and `listHeadChanges`. Same source backs the ADE runtime and the desktop fallback path. |
| `apps/desktop/src/main/services/state/kvDb.ts` | Schema for `operations`, `checkpoints`, `pack_events`, `pack_versions`, `pack_heads`, `terminal_sessions`, and orchestration-related tables. |
| `apps/desktop/src/main/services/git/gitOperationsService.ts` | Brackets every git operation with `operationService.start` / `finish`, captures pre/post HEAD SHAs, and owns the per-lane undo/redo head-change pipeline (`undoLastHeadChange`, `redoLastHeadChange`, `createTag`, `resetToCommit`, `pull` with `ff-only` / `rebase` / `merge` modes). Before lane git mutations or lane git reads, it verifies that the saved `worktreePath` is still the Git top-level for that lane; stale paths that resolve to the primary checkout are rejected as missing lane worktrees so History and Git Actions do not read or mutate the wrong branch. Undo selection is branch-aware: it ignores checkout/undo rows, requires the recorded operation's `metadata.branchRef` to match the lane's current branch, and rechecks the branch before running `reset --hard`. |
| `apps/desktop/src/main/services/lanes/laneService.ts` | Lane CRUD now accepts `CreateLaneArgs.startPoint`, used by the Commits view's "Create lane here" affordance to fork a new lane from a specific commit. |
| `apps/desktop/src/main/services/prs/prService.ts` | Records PR creation as an operation. |
| `apps/desktop/src/main/services/conflicts/conflictService.ts` | Records rebase operations. |
| `apps/desktop/src/main/services/sessions/sessionService.ts` | Terminal session lifecycle (separate `terminal_sessions` table). |
| `apps/desktop/src/main/services/ipc/registerIpc.ts` | `ade.history.listOperations`, `ade.history.exportOperations`, plus the new git IPC channels surfaced by the History toolbar (`ade.git.createTag`, `ade.git.resetToCommit`, `ade.git.undoLastHeadChange`, `ade.git.redoLastHeadChange`, the `ff-only`/`rebase`/`merge` variants of `ade.git.pull`). |

Renderer components (`apps/desktop/src/renderer/components/history/`):

| File | Responsibility |
|---|---|
| `HistoryPage.tsx` | Hosts the `TimelineStoreProvider`, the two-pane `PaneTilingLayout` (timeline ~60%, detail ~40%), URL ↔ store hydration for `surface` / `laneId` / `eventId` / `commitSha`, selected-lane mirroring when the URL is not driving lane state, commit-on-lane tracking for destructive action gates, and the auto-refresh poll for running activity events. Surface defaults to `commits`. |
| `useTimelineStore.ts` | Zustand store: raw + enriched events, WIP-by-lane nodes, surface, focus lane, selected commit/event, view mode, scope level, filters, lane visibility, columns. `fetchEvents` merges `history.listOperations` with `fetchSupplementalTimelineRecords` and sorts/dedupes via `sortTimelineRecords`. |
| `timelineTypes.ts` | `HistorySurface = "activity" \| "commits"`, `ViewMode = "graph" \| "list" \| "compact"`, `TimelineEvent` (enriched `OperationRecord`), `LaneTrack`, `GraphLayout`, `TimelineFilters`, `LaneVisibility`, `ColumnConfig`, `WIPNode`, `MinimapBucket`. `DEFAULT_COLUMNS` order is timestamp → graph → event → lane → author → status → duration → sha. |
| `eventTaxonomy.ts` | Source of truth for event categories, importance levels, node shapes, and the per-kind `EVENT_KIND_META` table that every renderer (graph, list, compact, detail panel) consults. Adds taxonomy entries for the new git head-change kinds (`git_undo_head_change`, `git_redo_head_change`, `git_tag_create`, `git_reset_soft`/`_mixed`/`_hard`) and the unified-feed kinds (`chat.session`, `cto.session`, `worker.run`, `worker.activity`). |
| `historyActivitySources.ts` | Pure mappers + the single `fetchSupplementalTimelineRecords(limit)` entry point that builds synthetic `OperationRecord` rows from `agentChat.list`, `cto.getState`, and `cto.listAgentRuns`. Synthetic IDs are namespaced (`chat:`, `worker-run:`, `cto-session:`, `cto-activity:`) and the actor/eventLabel are embedded in `metadataJson` so the detail panel + graph can render them uniformly. |
| `historySearch.ts` | Tokenizer + matcher behind the Commits view search input. Supports bare full-text, quoted phrases, and the `message:` / `msg:` / `=` / `author:` / `@` / `commit:` / `sha:` / `#` / `branch:` / `ref:` / `parent:` / `is:` / `type:` keys (e.g. `is:merge`, `is:local`, `type:pushed`). |
| `commitGraphLayout.ts` | Pure `buildCommitGraphLayout(commitsNewestFirst)` that assigns DAG columns first-parent style, then exposes `commitEdgePath`, `columnCenterX`, `rowCenterY`, and the `COMMIT_ROW_HEIGHT` / `COMMIT_GRAPH_COL_WIDTH` / `COMMIT_GRAPH_PAD_LEFT` constants the SVG layer in `CommitHistoryView` consumes. |
| `CommitHistoryView.tsx` | Virtualized GitKraken-style commit graph for the focused lane. Loads commits via `git.listRecentCommits` (initial limit 120, expands to 500 on scroll-to-bottom and on non-empty search), `git.listBranches` for ref pills, draws nodes + edges as an SVG layer overlaid on `@tanstack/react-virtual` rows, and dispatches right-click commit actions via `HistoryGitContextMenu`. |
| `CommitDetailPanel.tsx` | Right pane for the Commits surface: subject, author, full message (lazy via `git.getCommitMessage`), changed file list (`git.listCommitFiles`), related operations (any `OperationRecord` whose `preHeadSha` or `postHeadSha` matches the commit), and the same git action set the context menu exposes. Destructive lane mutations are disabled when the lane has no worktree or the commit was resolved only through a targeted lookup outside that lane's visible history. |
| `HistoryGitContextMenu.tsx` | Reusable right-click menu shared by `CommitHistoryView` rows and the `CommitDetailPanel` actions strip; built from `buildCommitContextActions` + `groupCommitContextActions`. |
| `historyGitActions.ts` | Per-commit action catalogue and dispatcher: `Inspect` (checkout, open in Lanes git pane, compare-with-parent, view files), `Create` (branch, lane, tag), `Apply` (cherry-pick, revert, soft/mixed/hard reset), `Share` (open/copy GitHub link, copy patch via `git.listCommitFiles` + `diff.getFilePatch`, copy SHA, copy subject). Calls `window.ade.git.*` + `window.ade.lanes.create({ startPoint })` and centralizes disabled reasons for missing worktrees or commits not on the focused lane history. |
| `historyUrlHydration.ts` | Pure URL-hydration helper used by `HistoryPage` tests and effects. Re-applies `commitSha` when a URL-driven lane focus change clears the store selection, while refusing to hydrate commit selections on the Activity surface. |
| `historyLaneActions.ts` | Lane-level action catalogue surfaced through the Commits toolbar's "Lane git actions" menu: `Remote` (fetch, pull ff-only/rebase/merge, push, force-push-with-lease), `Recover` (undo/redo last head change), `Branch and PR` (copy branch name, open/copy branch link, open/copy PR link), `Lane` (rename, archive, delete worktree, delete + branch), `Integrate` (merge/rebase onto base), `Stash`, `Conflict` (rebase/merge continue + abort, only when a conflict is in progress), `Open` (jump to Lanes git pane). |
| `TimelineToolbar.tsx` | The shared toolbar above both surfaces. Renders the surface toggle (`Commits` / `Activity`), the lane selector + `LaneGitActionsMenu` on the Commits surface, and the activity controls (view-mode toggle, scope selector, search, export-to-JSON, column gear, category/status/time-range/lane filter chips). |
| `TimelineGraph.tsx` (lazy) | SVG-based per-lane swimlane graph for the Activity surface — used when `viewMode === "graph"`. |
| `TimelineListView.tsx` | Table-style activity list with column visibility driven by `columns` from the store. |
| `TimelineCompactView.tsx` | Density-optimized one-line-per-event list. |
| `EventDetailPanel.tsx` | Right pane for the Activity surface: label, status, lane chip, pre/post SHA buttons, parsed metadata, jump-to-lane / open-chat links derived from metadata. |

Shared types:

| File | Adds / changes |
|---|---|
| `apps/desktop/src/shared/types/git.ts` | `GitPullMode` (`ff-only` / `rebase` / `merge`), `GitPullArgs`, `GitCreateTagArgs`, `GitResetCommitArgs`, `GitHeadChangeActionArgs`. `ListOperationsArgs` gains a server-side `status` filter; `ExportHistoryArgs` keeps its own `"all"` sentinel by omitting the new field. |
| `apps/desktop/src/shared/types/lanes.ts` | `CreateLaneArgs.startPoint?: string` — fork the new lane's branch from a specific commit/ref. Used by the "Create lane here" affordance in the commit context menu. |
| `apps/desktop/src/shared/types/sync.ts` | Adds `git.createTag`, `git.resetToCommit`, `git.undoLastHeadChange`, `git.redoLastHeadChange` to `SyncRemoteCommandAction` so controllers (iOS, peer desktops) can issue the new commands. |
| `apps/desktop/src/shared/ipc.ts` | New channels: `gitCreateTag`, `gitResetToCommit`, `gitUndoLastHeadChange`, `gitRedoLastHeadChange`. |

## Surfaces

### Commits

GitKraken-style DAG for the focused lane. The user picks a lane from
the toolbar's lane select; the view runs `git.listRecentCommits` and
`git.listBranches` against that lane's worktree, builds a column
assignment with `buildCommitGraphLayout`, and renders a virtualized
list with an SVG layer for nodes and parent/merge edges.

Each commit row shows the short SHA, optional `HEAD` and `merge`
pills, up to two ref pills (branches whose `lastCommitSha` is this
commit), the subject, the author name, and a relative timestamp.
Right-click — or the actions strip in the detail panel — opens
`HistoryGitContextMenu` with grouped actions; see
`historyGitActions.ts` for the catalogue.

The search field above the list parses through `filterCommitsForSearch`
in `historySearch.ts`. Bare text matches subject / SHA / author /
parent / refs. Prefixed keys narrow the match: `message:`, `author:`
(or `@`), `commit:` (or `#`), `branch:` / `ref:`, `parent:`, plus
`is:merge`, `is:local`, `is:pushed`. The view automatically bumps the
commit limit from 120 to 500 when a search is active so unloaded
commits do not silently miss.

The Commits toolbar also exposes a `LaneGitActionsMenu` populated by
`buildHistoryLaneActions` / `groupHistoryLaneActions`. That menu drives
lane-scoped operations against `window.ade.git.*` + `window.ade.lanes.*`
without leaving the History tab.

### Activity

Unified operations feed combining recorded `OperationRecord` rows with
synthesized rows from chat sessions, CTO snapshots, and
worker runs (see `historyActivitySources.ts`). `fetchEvents` merges
them in `useTimelineStore`, deduplicates by `id`, and sorts by
`startedAt` descending before clamping to `limit`.

Three view modes (`graph` / `list` / `compact`) are selectable from
the toolbar:

- **Graph** — `TimelineGraph` lays events out on per-lane swimlanes,
  draws cross-lane connectors, and renders each event with its
  category color + shape from `eventTaxonomy`.
- **List** — `TimelineListView` is a tabular view honoring the user's
  column visibility (`columns` in the store; defaults below).
- **Compact** — `TimelineCompactView` collapses each event to a
  single dense line.

Default visible columns: `Time`, `Graph`, `Event`, `Lane`, `Status`,
`Duration`. Hidden by default: `Author`, `SHA`. Toggles persist in
the store (not localStorage — they reset when the store is recreated).

The toolbar's **scope** selector controls the importance threshold
applied before any other filter:

| Scope | Allowed importance |
|---|---|
| Key | `high` |
| Standard (default) | `high`, `medium` |
| Detailed | `high`, `medium`, `low` |
| All | everything, including `noise` |

Additional filters: lane multi-select, category multi-select, status
multi-select (`running` / `succeeded` / `failed` / `canceled`),
time-range (`1h` / `today` / `week` / `month` / `all`), free-text
search across label / kind / lane name / status / metadata, and
solo/hide chips per lane (`visibility.soloedLaneIds`, `hiddenLaneIds`).

Auto-refresh: every 4 s while any event has `running` status, gated
on `document.visibilityState === "visible"` and `window.focus`, and
suppressed on the Commits surface.

The export button calls `ade.history.exportOperations` with the
current `focusLaneId` and (when exactly one status is selected) the
chosen `status`, format `json`, default `limit: 500`. The desktop
runs the save dialog locally and writes the file. The button shows
`"Export unavailable (headless)"` when the preload bridge is missing.

## What history captures

History records **operations** — discrete, typed actions that changed
state — plus synthesized rows from the chat/CTO/worker feeds
that pretend to be operations for rendering purposes only. Synthesized
rows are not written into the `operations` table; they are rebuilt on
every refresh.

### Operation kinds

Tracked kinds (canonical, recorded by services via `operationService`):

| Kind | Source | Metadata |
|---|---|---|
| `git_commit` | `gitOperationsService.commit` | `{ message, filesChanged, sha, reason, branchRef, baseRef }` |
| `git_checkout_branch` | `gitOperationsService.checkoutBranch` | `{ fromBranch, toBranch, mode }` |
| `git.merge` | `gitOperationsService.merge` | `{ fromBranch, conflicts }` |
| `git.rebase` | `gitOperationsService.rebase`, `conflictService.rebaseLane` | `{ ontoBranch, commitCount }` |
| `git_push` | `gitOperationsService.push` | `{ remote, branch, commitCount }` |
| `git_push_force_with_lease` | `gitOperationsService.push({ forceWithLease })` | `{ remote, branch }` |
| `git_pull` | `gitOperationsService.pull` | `{ mode: "ff-only" \| "rebase" \| "merge" }` |
| `git_fetch` | `gitOperationsService.fetch` | `{ remote }` |
| `git_sync_merge` / `git_sync_rebase` | `gitOperationsService.sync` | `{ baseRef }` |
| `git_cherry_pick` | `gitOperationsService.cherryPickCommit` | `{ commitSha }` |
| `git_revert` | `gitOperationsService.revertCommit` | `{ commitSha }` |
| `git_tag_create` | `gitOperationsService.createTag` | `{ commitSha, tagName, annotated }` |
| `git_reset_soft` / `git_reset_mixed` / `git_reset_hard` | `gitOperationsService.resetToCommit` | `{ commitSha, mode }` |
| `git_undo_head_change` | `gitOperationsService.undoLastHeadChange` | `{ undoneOperationId, undoneOperationKind, redoHeadSha, targetHeadSha }` |
| `git_redo_head_change` | `gitOperationsService.redoLastHeadChange` | `{ redoneUndoOperationId, targetHeadSha }` |
| `git_stash_push` / `_apply` / `_pop` / `_drop` / `_clear` | `gitOperationsService.stash*` | `{ ref?, message?, includeUntracked? }` |
| `git_rebase_continue` / `_abort` / `git_merge_continue` / `_abort` | `gitOperationsService.rebase*` / `merge*` | `{}` |
| `pack_update_lane` | `packService.refreshLane` | `{ reason, trigger }` |
| `pack_update_project` | `packService.refreshProject` | `{ reason, trigger }` |

### Synthesized kinds (Activity surface only)

These are built in `historyActivitySources.ts` and rendered as
operations even though no row lands in the database. They show up in
the activity feed and the detail panel; they will never appear in
`ade.history.exportOperations` output.

| Kind | Source | Metadata highlights |
|---|---|---|
| `chat.session` | `agentChat.list({ includeAutomation: true })` | `sessionId`, `title`, `provider`, `model`, `chatStatus`, `awaitingInput`, `automationId` |
| `worker.run` | `cto.listAgentRuns({ limit })` | `runId`, `agentId`, `taskKey`, `workerStatus`, `wakeupReason`, `error` |
| `cto.session` | `cto.getState({ recentLimit }).recentSessions` | `sessionId`, `summary`, `provider`, `model`, `capabilityMode` |
| `worker.activity` | `cto.getState({ recentLimit }).recentSubordinateActivity` | `agentId`, `agent`, `sessionId`, `taskKey`, `activityType` |

### Status

`running | succeeded | failed | canceled`. `running` is set at `start`
and transitions on `finish`. Canceled operations are bracketed with
`finish({ status: "canceled" })` by the caller. The toolbar's status
filter and the new `ListOperationsArgs.status` argument both apply
this field; the export path uses its own `status` (with an `"all"`
sentinel) and falls back to client-side filtering when a single status
is requested via the toolbar.

### SHA transitions

Every git operation records `preHeadSha` and `postHeadSha`. The undo
and redo paths in `gitOperationsService` rely on this. `undoLastHeadChange`
searches recent head changes for the current lane, skips
`git_undo_head_change` and `git_checkout_branch`, requires the stored
`metadata.branchRef` to match the lane's current branch, rechecks that
the lane branch has not changed after selection, verifies current HEAD
still equals the selected operation's `postHeadSha`, then runs
`git reset --hard preHeadSha`. `redoLastHeadChange` inverts that,
reading the `redoHeadSha` stamped into the latest undo's metadata. The
`CommitDetailPanel.relatedEvents` view also keys off this pair: any
operation whose `preHeadSha` or `postHeadSha` matches the focused
commit is surfaced alongside the commit.

## Other history-adjacent tables

Several features own their own history-style tables. These are not
queried via `ade.history.*` but contribute to the broader picture.

### Terminal sessions

`terminal_sessions` (schema in `kvDb.ts`):

- `id`, `lane_id`, `pty_id`, `tracked`, `pinned`, `manually_named`
- `goal`, `tool_type`, `title`
- `started_at`, `ended_at`, `exit_code`, `status`
- `transcript_path` -- filesystem path to the persisted transcript
- `head_sha_start`, `head_sha_end` -- git HEAD bracketing the session
- `last_output_preview`, `last_output_at`, `summary`
- `resume_command`, `resume_metadata_json` -- resume info for CLI
  tools (Claude Code, Codex, Cursor) so sessions can be picked up
  after exit.

Sessions are owned by `sessionService.ts`; their full transcript is on
disk at `transcript_path`. Terminal sessions do **not** synthesize
rows into the activity feed yet — chat sessions do.

### Checkpoints (Phase 8)

`checkpoints` (schema in `kvDb.ts`):

- Immutable SHA snapshots at session boundaries.
- Carry diff stats and linked pack event IDs.
- Surfaced internally via `packService` compatibility paths but not
  through a public `ade.packs.*` IPC.

### Pack events (Phase 8)

`pack_events`:

- Append-only log of pack state changes (checkpoint created, narrative
  updated, conflict detected, etc.).
- Event-specific payload stored as JSON.

### Pack versions (Phase 8)

`pack_versions`, `pack_heads`:

- Track pack content hashes and which version is "live" per pack key.
- Used by deterministic-context exports.

### AI usage log

`ai_usage_log`:

- Per-turn token and cost tracking across providers.
- Consumed by the budget/usage dashboards, not the history UI.

## IPC surface

Defined in `apps/desktop/src/shared/ipc.ts`, handled in
`apps/desktop/src/main/services/ipc/registerIpc.ts`.

### History

| Channel | Args | Purpose |
|---|---|---|
| `ade.history.listOperations` | `ListOperationsArgs` (`{ laneId?, kind?, status?, limit?, offset? }`) | Query operations with optional filters and pagination. `status` is applied server-side. Default limit 300, max 1000. |
| `ade.history.exportOperations` | `ExportHistoryArgs` (`{ format: "csv" \| "json"; laneId?, kind?, status?, limit? }`) | Export filtered history as CSV or JSON via a save dialog. `status` accepts `OperationRecord["status"] \| "all"`; `"all"` skips both server-side and client-side status filtering. Cancellation returns `{ cancelled: true }`. |

### Git (used by the History toolbar + commit context menu)

| Channel | Args | Notes |
|---|---|---|
| `ade.git.listRecentCommits` | `{ laneId, limit? }` | Limit is clamped to `[1, 500]` (was 200). The Commits view uses 120 by default and bumps to 500 on search or near-bottom scroll. |
| `ade.git.listBranches` | `{ laneId }` | Used to overlay branch refs on commit rows. |
| `ade.git.listCommitFiles` | `{ laneId, commitSha }` | Drives the detail panel file list and the "Copy patch" action (capped at 50 files). |
| `ade.git.getCommitMessage` | `{ laneId, commitSha }` | Full commit message body (lazy). |
| `ade.git.getOriginRemote` | `{ laneId }` | Used to build GitHub commit / branch URLs. |
| `ade.git.getOpenPrForBranch` | `{ laneId }` | Used by "Open branch PR" and "Copy PR link". |
| `ade.git.checkoutBranch` | `{ laneId, branchName, mode, startPoint? }` | "Create branch here" passes the commit SHA as `startPoint`. |
| `ade.git.cherryPickCommit` | `{ laneId, commitSha }` | Records `git_cherry_pick`. |
| `ade.git.revertCommit` | `{ laneId, commitSha }` | Records `git_revert`. |
| `ade.git.createTag` | `GitCreateTagArgs` (`{ laneId, commitSha, tagName, message? }`) | Lightweight tag when `message` is omitted, annotated otherwise. Records `git_tag_create`. |
| `ade.git.resetToCommit` | `GitResetCommitArgs` (`{ laneId, commitSha, mode: "soft" \| "mixed" \| "hard" }`) | Records `git_reset_<mode>`. |
| `ade.git.pull` | `GitPullArgs` (`{ laneId, mode?: "ff-only" \| "rebase" \| "merge" }`) | Default `ff-only`. Records `git_pull` with `metadata.mode`. |
| `ade.git.undoLastHeadChange` | `GitHeadChangeActionArgs` (`{ laneId }`) | Resets HEAD to the previous successful head-changing op's `preHeadSha`. Fails if HEAD has moved since. Records `git_undo_head_change`. |
| `ade.git.redoLastHeadChange` | `GitHeadChangeActionArgs` (`{ laneId }`) | Restores HEAD to the most recent undo's `redoHeadSha`. Fails if HEAD has moved since the undo. Records `git_redo_head_change`. |

All lane-scoped `ade.git.*` reads and mutations validate the lane
worktree root before running provider Git commands. A missing or stale
worktree path throws the same "restore or recreate the lane worktree"
error for history reads, commit-message generation, branch/stash/sync
metadata, and mutating Git actions.

The conflict-resume channels (`gitRebaseContinue`, `gitRebaseAbort`,
`gitMergeContinue`, `gitMergeAbort`) accept either a bare `string`
laneId (legacy) or `{ laneId }` (preferred); the preload normalizes
via `normalizeLaneIdArg` before dispatching.

### Lanes (used from the commit context menu)

| Channel | Args | Notes |
|---|---|---|
| `ade.lanes.create` | `CreateLaneArgs` with `startPoint` | "Create lane here" forks the new branch from `commit.sha` instead of from the parent lane's tip. |

## Operation recording pattern

Every operation that should appear in history follows:

```ts
const op = operationService.start({
  laneId,
  kind: "git_commit",
  preHeadSha,
  metadata: { reason, branchRef }
});

try {
  const result = await doTheThing();
  const postHeadSha = await getHeadSha();
  operationService.finish({
    operationId: op.operationId,
    status: "succeeded",
    postHeadSha,
    metadataPatch: { message: result.message, filesChanged: result.files.length }
  });
} catch (error) {
  operationService.finish({
    operationId: op.operationId,
    status: "failed",
    postHeadSha: await getHeadSha(),
    metadataPatch: { error: error.message }
  });
  throw error;
}
```

For instantaneous operations (no async work between start and finish),
`operationService.recordCompleted()` wraps both calls.

See `gitOperationsService.ts` for the canonical implementation
(`runLaneOperation` / `runTrackedOperation`). That helper also emits
lane-changed and HEAD-changed events so dependent services can
invalidate caches.

## What is NOT in history

Deliberately excluded from the persisted operations table; some of
these are surfaced on the Activity surface as synthesized rows:

- Individual tool calls during a session.
- UI navigation events.
- PR comment polling / check re-runs (captured in PR module).
- Context-pack generation telemetry.
- AI token usage (`ai_usage_log`).

## Fragile and tricky wiring

- **Start/finish pairing.** Operations without a `finish` stay
  `running` forever. Every code path that calls `start` must have a
  matching `finish` (success or failure). `gitOperationsService`
  wraps both in `runLaneOperation`; new call sites should adopt
  that pattern rather than calling start/finish manually.
- **Pre/post HEAD capture timing.** `preHeadSha` is captured
  immediately before the operation; `postHeadSha` immediately after
  (even on failure). If the operation crashes the process between
  the two reads, the row is left with `running` status and null
  `postHeadSha` -- it must be reconciled on next startup or left as
  a tombstone.
- **Undo/redo HEAD guard.** Both `undoLastHeadChange` and
  `redoLastHeadChange` re-read HEAD before they touch git; if HEAD
  has moved since the operation they target, they refuse. This
  prevents `git reset --hard` from clobbering uncommitted work the
  user did after the original operation.
- **Metadata merge on finish.** `operationService.finish` merges the
  `metadataPatch` into the existing metadata via spread. Nested
  objects are overwritten wholesale, not deep-merged.
- **`listOperations.status` vs `exportOperations.status`.** The list
  API takes a single concrete status; the export API additionally
  accepts `"all"`. The toolbar passes a single status to export only
  when exactly one is selected, falling back to a client-side filter
  for multi-select cases. Large projects with heavy filters can hit
  the 1000-row limit before the filter applies.
- **`laneName` join.** `list()` left-joins `lanes.name`. Deleted or
  archived lanes still show up with `laneName: null` instead of the
  original name -- good for stable history, surprising for the UI.
- **CSV export escaping.** The export path embeds metadata JSON; CSV
  escaping must survive nested quotes. Validate with round-trip
  tests when adjusting export formats.
- **Synthesized rows do not export.** Chat / CTO / worker
  rows are renderer-side only. They appear in the Activity feed and
  the detail panel but never in `ade.history.exportOperations`
  output. Treat the export as the operations table, not the unified
  view.
- **Commit graph virtualization edge filter.** `CommitHistoryView`
  filters edges to ones touching the current virtual window (±2
  rows) to keep SVG cheap on tall histories. If a long edge skips
  more than two rows of virtual scroll, it will pop in and out at
  the seam — by design, not a bug.
- **`startPoint` validation.** `laneService.create` resolves
  `startPoint` with `git rev-parse --verify`. An invalid ref throws
  `Start point not found for new lane: …` synchronously; callers in
  `historyGitActions.create_lane` rely on that error to surface a
  notice.
- **Pack/checkpoint data exists but is hidden.** Phase 8 tables are
  populated but the History UI does not surface them. Any new IPC
  that exposes them must also respect the visibility/focus polling
  guards already in place for operations.

## Detail doc

- [Recording and Export](recording-and-export.md) -- how git/PR/pack
  services emit operations, how head-change undo/redo bracket the
  user-visible recovery actions, and how the export flow writes
  CSV/JSON.

## Related docs

- [Lanes README](../lanes/README.md) -- `CreateLaneArgs.startPoint` is
  documented there alongside the rest of the lane creation flow.
- [Sync remote commands](../sync-and-multi-device/remote-commands.md)
  -- the new git head-change / tag / reset actions are exposed to iOS
  and peer desktops through `SyncRemoteCommandAction`.
- [Chat README](../chat/README.md) -- chat transcript persistence is
  separate from the operations timeline but parallel in intent, and
  chat sessions also synthesize Activity feed rows.
- [Agents README](../agents/README.md) -- worker and CTO session logs
  are tracked in `cto_session_logs` and agent-specific tables; CTO
  snapshot + worker runs synthesize rows into the Activity feed.
