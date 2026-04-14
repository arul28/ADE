# Lane stacking

Stacked lanes are parent-child lane pairs where the child's branch is
based on the parent's branch rather than on `main`. This enables:

- stacked PRs (each lane in the stack opens its own PR, merged in order)
- incremental development (build feature B on top of feature A before A lands)
- rebase propagation (when the parent moves, propagate changes down)

## Data model

Each lane row has `parent_lane_id` (nullable, FK to `lanes.id`). A
stack is simply a chain of lanes linked through this column. The
`lanes` table does not materialize "stack roots" — they're implicit
(rows with `parent_lane_id IS NULL`).

`LaneSummary.stackDepth` and `.childCount` are computed per-list via
`computeStackDepth` and a per-list memoization map.

## Base-ref resolution

The central helper is `shouldLaneTrackParent` in
`src/shared/laneBaseResolution.ts`. A child lane tracks its parent's
branch as its comparison ref only when:

1. The parent exists.
2. The parent is a non-primary lane (primary is excluded because its
   branch _is_ the project default — tracking it would always
   produce zero behind-counts).
3. The parent has a valid, non-empty `branch_ref`.

Otherwise the child falls back to its own `base_ref` (the project
default branch, e.g., `main`).

`branchNameFromLaneRef` strips `refs/heads/`, `refs/remotes/`, and
`origin/` prefixes so comparisons work uniformly.

Consumers:

- `laneService.computeLaneStatus` — ahead/behind math
- `laneService.rebaseStart` — target ref for rebase
- `conflictService.resolveLaneRebaseTarget` — comparison ref for
  conflict prediction (combined with `resolveQueueRebaseOverride`)
- `autoRebaseService` — head-change handling
- `rebaseSuggestionService` — deciding when a suggestion applies
- `rebaseNeedUtils.ts` renderer helpers — route-to-lane mapping

If a new consumer needs a lane's "upstream reference," it must use
these helpers rather than reading `parent_lane_id` or `base_ref`
directly.

## Stack chain retrieval

`laneService.getStackChain(laneId)`:

1. Walks up via `parent_lane_id` to find the root ancestor.
2. Runs a recursive CTE (`with recursive stack as …`) in SQLite to
   collect every descendant from that root that is not archived and
   shares the same project id.
3. Sorts children by `created_at` so the tree has a stable display
   order.
4. Returns an ordered array of `StackChainItem`:

```ts
type StackChainItem = {
  laneId: string;
  laneName: string;
  branchRef: string;
  depth: number;           // 0 = root
  parentLaneId: string | null;
  status: LaneStatus;      // ahead/behind/dirty computed per item
};
```

Status is computed with the correct base (parent branch for tracked
children, `base_ref` otherwise) and memoized per-call.

## Reparenting

`laneService.reparent({ laneId, newParentLaneId })`:

- Refuses to reparent the primary lane (`lane_type === "primary"`).
- Refuses to reparent a lane under one of its own descendants
  (detected by walking up from `newParentLaneId`).
- Refuses to reparent a lane to itself.
- Updates `parent_lane_id` and records a `lane_reparent` operation in
  the history timeline with the reason `reparent`.
- Triggers downstream refresh events (rebase suggestion service
  re-evaluates, stack graph re-renders).

`ReparentLaneResult` carries the before/after parent ids so the UI
can update state without a full list refresh.

## Rebase runs

`laneService.rebaseStart()` orchestrates multi-lane rebases:

- `scope: "lane_only" | "lane_and_descendants"` — default is
  `lane_and_descendants`. The resolver builds an order list via
  `resolveRebaseOrder` that walks the stack in parent→child order so
  children rebase onto freshly rebased parents.
- `pushMode: "none" | "push" | "force-with-lease"` — whether to push
  each lane after its rebase completes.
- `baseBranchOverride` — persists a new base branch on the root lane
  (rejected if the root is a tracked child).
- `actor`, `reason` — audit metadata.

Each rebase run has a unique `runId` and lives in an in-memory
`rebaseRuns` map. Only one run per root stack can be `running` at a
time:

```
if (another run with root-ancestor == this root is already running)
  throw "A rebase run is already active for this lane stack"
```

Per-lane rebase:

1. Capture `preHeadSha`.
2. Run `git rebase <target-ref>` where the target is:
   - the parent's branch when tracked, or
   - `origin/<base>` with fallback to local `<base>` when the parent
     is primary or absent, or
   - a queue override when a PR queue has supplied one.
3. On success: capture `postHeadSha`, optionally push.
4. On conflict: mark `status = 'conflict'`, collect conflicting
   files, pause the run until user resolves via
   `ade.git.rebaseContinue` / `.rebaseAbort`.
5. Emit `rebase-run-event` IPC events throughout.

`rebaseAbort` reverts each lane that was rebased in the run by
resetting back to its `preHeadSha`. `rebaseRollback` does the same
after a run has finished.

## Rebase suggestions

`rebaseSuggestionService` monitors stacked lanes for a parent head
advance. When detected, it emits a `RebaseSuggestion`:

```ts
type RebaseSuggestion = {
  laneId: string;
  parentLaneId: string;
  parentHeadSha: string;
  behindBy: number;
  lastSuggestedAt: string;
  deferredUntil: string | null;
  dismissedAt: string | null;
};
```

State is persisted in the KV store under `rebase:suggestion:<laneId>`.
Suggestions are suppressed when:

- the lane has been dismissed for the current parent head sha, or
- the lane has been deferred and `deferredUntil` has not yet passed.

When the parent head sha changes, dismiss state is reset so a fresh
suggestion can re-appear.

The renderer subscribes via `ade.lanes.rebaseSuggestions.event` and
surfaces a banner on lane rows plus a `LaneRebaseBanner` inline with
Rebase Now / Defer / Dismiss actions.

## Auto-rebase

`autoRebaseService` is the opt-in background worker that rebases
children when a parent advances. Enable via Settings → Lane Behavior
→ Auto-rebase child lanes.

State storage is `auto_rebase:status:<laneId>` in the KV store. The
`AutoRebaseLaneStatus` record tracks:

- `state`: `"autoRebased" | "rebasePending" | "rebaseConflict" | "rebaseFailed"`
- `parentHeadSha` at the point of rebase
- `conflictCount`, `message`
- `source`: `"auto"` or `"manual"` (for attention items surfaced in the PRs > Rebase tab)

Key behaviors:

- Head-change events from `laneService` (`preHeadSha` → `postHeadSha`)
  trigger `onHeadChanged`, which enumerates direct children and
  queues rebases.
- The service debounces via `RUN_DEBOUNCE_MS` (1.2 s) to batch bursts
  of head changes, and `SWEEP_DEBOUNCE_MS` (30 s) for scheduled sweeps.
- `recordAttentionStatus` lets other subsystems (queue landing,
  manual rebase UI) annotate a lane so it appears in the Rebase tab's
  attention section.
- Statuses expire from the "auto-rebased" banner after
  `AUTO_REBASED_TTL_MS` (15 min).

## Queue-aware rebase

When a lane belongs to an active PR merge queue, its rebase target is
the queue's tracking branch, not the lane's static base branch.
`resolveQueueRebaseOverride` in
`src/main/services/shared/queueRebase.ts` returns a
`QueueRebaseOverride` that `conflictService.resolveLaneRebaseTarget`
and `laneService.rebaseStart` both respect.

## Renderer wiring

- `LaneStackPane` renders the stack graph in the left pane of the
  Lanes tab. Nodes show runtime dot (running/awaiting-input/ended)
  and integration-source chips for integration lanes.
- `LanesPage` passes `integrationSourcesByLaneId` built via
  `buildIntegrationSourcesByLaneId` from `renderer/lib/integrationLanes.ts`.
- `LaneRebaseBanner` is conditionally rendered above the lane detail
  when `listRebaseSuggestions` returns a suggestion that is neither
  dismissed nor deferred.
- `rebaseNeedUtils.ts` on the renderer side provides
  `buildUpstreamRebaseChain` for surfacing the full upstream rebase
  chain in the PRs Rebase tab (see `pull-requests/stacking.md`).

## Gotchas

- **Primary-parented children are repaired on startup** by
  `repairPrimaryParentedRootLanes`. If you create a non-primary lane
  with the primary as its parent (bypassing `createChild`), it will
  be detached on the next app launch.
- **Cycles are impossible via IPC** thanks to the reparent guard, but
  a SQL hotfix could introduce one. `getStackChain` uses a `visited`
  set when walking up and the recursive CTE naturally terminates at
  rows with no children.
- **`parent_lane_id` can reference an archived lane.** The stack
  chain recursive CTE filters archived lanes explicitly
  (`where l.project_id = ? and l.status != 'archived'`), so archived
  ancestors truncate the chain.
- **Base-ref drift is only repaired on startup.** Editing a lane's
  base_ref via direct SQL without going through `laneService` and
  without re-running the repair routine will leave a mismatch that
  only manifests in ahead/behind counts.
