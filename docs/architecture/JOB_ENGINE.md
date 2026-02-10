# Job Engine (Pipelines, Coalescing, Always-In-Sync Packs)

Last updated: 2026-02-10

## 1. Goal

Make packs, conflict prediction, and UI status stay in sync with minimal manual actions.

## 2. Events (Inputs)

- Terminal session started
- Terminal session ended
- Lane git HEAD changed (commit created)
- Worktree dirty delta changed (unstaged changes)
- Base branch updated (fetch/pull)
- User requested "sync lane"
- User opened conflicts window and requested proposals

## 3. Jobs (Units of Work)

Jobs are idempotent and keyed so they can be coalesced:

- `RefreshLaneStatus(laneId)`
- `UpdateLanePack(laneId)`
- `UpdateProjectPack(projectId)` (incremental)
- `PredictConflicts(laneId)`
- `BuildConflictPack(operationId or laneId)`
- `SyncToHostedMirror(laneId)` (coalesced + forced on session end)
- `RequestHostedProposal(operationId)` (manual trigger from conflicts window)

## 4. Coalescing Rules

Per lane:

- Only one refresh pipeline runs at a time.
- If multiple events arrive during a run, enqueue a follow-up run but collapse duplicates.

Sync to hosted:

- Force sync at terminal session end.
- Coalesce during active work to at most one sync per `coalesceSeconds`.
- Early coalesce when estimated dirty changed lines exceed `dirtyLineThreshold`.

## 5. Lane Refresh Pipeline (Recommended)

Triggered on session end and on commit:

1. `RefreshLaneStatus`
2. `UpdateLanePack` (deterministic)
3. `SyncToHostedMirror` (forced on session end; coalesced otherwise)
4. `PredictConflicts` (lane vs base, and children vs parent if stacked)
5. If conflicts predicted/active: `BuildConflictPack` (deterministic, local)

Hosted proposals are not automatic on prediction; they are triggered from the conflicts window.

## 6. Failure Handling

- If pack update fails: UI shows stale timestamp and error; next event retries.
- If hosted sync fails: keep local packs correct; retry sync with backoff.
- If prediction fails: mark as "unknown" rather than "no conflicts".

## 7. Performance Constraints

- Avoid scanning huge worktrees frequently; derive deltas from cached SHAs.
- Prefer git-native operations (diff/ls-tree) over filesystem walks.

