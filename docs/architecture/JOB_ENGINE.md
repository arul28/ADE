# Job Engine (Pipelines, Coalescing, Comprehensive Packs)

Last updated: 2026-02-11

## 1. Goal

Keep checkpoints, packs, planning revisions, and history graph state synchronized with minimal manual actions.

## 2. Events (Inputs)

- Terminal session started
- Terminal session ended
- Lane git HEAD changed (commit created)
- Staged set changed (`git add`, `git restore --staged`, discard)
- Worktree dirty delta changed (unstaged changes)
- Branch switched inside a lane workspace
- Base branch updated (fetch/pull)
- User requested "refresh pack"
- User requested "re-plan"
- User changed active plan version
- User requested "sync lane"
- User opened conflicts window and requested proposals

## 3. Jobs (Units of Work)

Jobs are idempotent and keyed so they can be coalesced.

- `RefreshLaneStatus(laneId)`
- `CreateCheckpoint(projectId, laneId, sessionId?, reason)`
- `AppendPackEvent(projectId, event)`
- `MaterializeLanePack(laneId)`
- `MaterializeProjectPack(projectId)` (incremental)
- `MaterializeFeaturePack(featureKey)`
- `MaterializeConflictPack(operationId or laneId)`
- `MaterializePlanPack(threadId)`
- `PredictConflicts(laneId)`
- `PredictPairwiseOverlap(projectId)` (lane-lane risk matrix)
- `SimulateMerge(sourceLaneId, targetLaneId or targetRef)`
- `SyncToHostedMirror(laneId)` (coalesced + forced on session end)
- `RequestHostedNarrative(packKey)`
- `RequestHostedProposal(operationId)` (manual trigger from conflicts window)

## 4. Coalescing Rules

Per lane:

- Only one refresh pipeline runs at a time.
- If multiple events arrive during a run, enqueue a follow-up run but collapse duplicates.

Per feature:

- Coalesce repeated materialization requests to one in-flight + one pending run.

Per project pairwise conflict pass:

- Coalesce to one in-flight + one pending matrix recompute.
- Run with short debounce for staged/dirty events.

Sync to hosted:

- Force sync at terminal session end.
- Coalesce during active work to at most one sync per `coalesceSeconds`.
- Early coalesce when estimated dirty changed lines exceed `dirtyLineThreshold`.

## 5. Lane Refresh Pipeline (Comprehensive)

Triggered on session end and on commit:

1. `RefreshLaneStatus`
2. `CreateCheckpoint`
3. `AppendPackEvent(checkpoint_created)`
4. `MaterializeLanePack` (deterministic version + head update)
5. `MaterializeProjectPack` (bounded incremental)
6. `MaterializeFeaturePack` (if linked)
7. `PredictConflicts` (lane vs base, and children vs parent if stacked)
8. `PredictPairwiseOverlap` (lane vs lane across active lanes)
9. If conflicts predicted/active: `MaterializeConflictPack`
10. `SyncToHostedMirror` (forced on session end; coalesced otherwise)
11. Optional: `RequestHostedNarrative` for changed pack keys

Realtime conflict pass (triggered by staged/dirty/branch-switch events):

1. `RefreshLaneStatus`
2. `PredictConflicts`
3. `PredictPairwiseOverlap`
4. Update conflict badges and risk matrix cache

Re-plan pipeline:

1. create immutable `plan_version`
2. append plan events (`plan_version_created`, `plan_version_activated`)
3. materialize plan pack
4. optionally materialize lane/feature pack to include new plan state

## 6. Failure Handling

- If checkpoint creation fails: mark lane state as stale and retry on next event.
- If pack materialization fails: keep prior active pack version; do not overwrite head.
- If hosted sync fails: keep local packs correct; retry with backoff.
- If prediction fails: mark as "unknown" rather than "no conflicts".

## 7. Performance Constraints

- Avoid scanning huge worktrees frequently; derive deltas from SHAs and cached indexes.
- Prefer git-native operations (diff/ls-tree) over filesystem walks.
- Use incremental materializers keyed by checkpoint ids to avoid full rebuilds on each event.
- Keep current pack views pre-rendered for fast UI read paths.
