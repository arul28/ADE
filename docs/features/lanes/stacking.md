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
  conflict prediction
- `autoRebaseService` — head-change handling
- `rebaseSuggestionService` — deciding when a suggestion applies
- `rebaseNeedUtils.ts` renderer helpers — route-to-lane mapping

If a new consumer needs a lane's "upstream reference," it must use
these helpers rather than reading `parent_lane_id` or `base_ref`
directly.

## Child-lane guidance for spawned work

The base-ref mechanics above decide what a new lane branches from, but a
caller still has to pick the right creation verb. A fresh lane
(`ade lanes create`) branches off the remote default branch by default
(`git.newLaneBaseSource: "remote"`, resolved host-side by
`resolveDefaultRemoteLaneBase` / `resolveLaneCreateRemoteBase` — see the
Lanes README lifecycle notes), so it does **not** carry the current lane's
uncommitted-to-main commits. A child lane (`ade lanes child`) branches off
the parent's HEAD, so it does. When an agent spins up new work that should
build on the commits already sitting in its lane, it wants a child, not a
fresh lane.

Two CLI affordances make this reachable without the desktop UI:

- **Unmerged-work nudge.** `ade lanes create` and
  `ade new chat --auto-create-lane` (both go through
  `detectUnmergedLaneCreateNudge` in `apps/ade-cli/src/cli.ts`) check
  whether the current worktree has commits ahead of `origin/<default>`. If
  it does, the command prints a stderr nudge before continuing —
  `⚠ Lane "<current>" has N commit(s) not on <default>` — suggesting
  `ade lanes child --lane <current> --name <new>` to carry them, and noting
  that it is otherwise continuing off remote main. The nudge is advisory
  only; the requested create still runs.
- **Stale-base warning.** When the remote-first default base is resolved
  (`resolveLaneCreateRemoteBase`, wired with an `onWarning` sink in
  `adeRpcServer.ts`), a failed fetch surfaces
  `⚠ Base origin/<default> may be stale — fetch failed; using last-known
  ref.`, and a local default branch that is behind its upstream surfaces
  `⚠ local <default> is N behind origin — creating off possibly-stale
  base.` Both are best-effort enrichment; lane creation still falls back to
  the local base on any failure.

The agent-facing decision table lives in the `ade-lanes-git` Agent Skill
(`apps/desktop/resources/agent-skills/ade-lanes-git/SKILL.md`): continue my
unmerged work → `ade lanes child --lane <current> --name <n>`; fresh
unrelated feature → `ade lanes create --name <n>` (off remote main);
build on another lane's unlanded work → `ade lanes child --lane <that> --name <n>`.
The `ade-cli-control-plane` skill cross-references the same rule from its
spawning-agents guidance.

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

`laneService.reparent({ laneId, newParentLaneId, stackBaseBranchRef? })`:

- Refuses to reparent the primary lane (`lane_type === "primary"`).
- Refuses to reparent a lane under one of its own descendants
  (detected by walking up from `newParentLaneId`).
- Refuses to reparent a lane to itself.
- Resolves the new base ref: when `stackBaseBranchRef` is provided it is
  resolved in the project repo through `resolveBranchRebaseTarget` with
  `preferRemote: true` so a name like `develop` picks `origin/develop`
  when it exists; otherwise the new parent's current `branch_ref` is
  used (with the primary-lane upstream fallback handled by
  `resolveParentRebaseTarget`).
- No-op fast path: when the persisted parent link and the resolved base
  ref both match the lane's current state, `reparent` returns the
  current head sha for both pre/post and does not run git. This keeps
  redundant "Apply" clicks from the Manage Lane dialog cheap.
- Otherwise updates `parent_lane_id`, persists the new `base_ref`,
  records a `lane_reparent` operation in the history timeline with the
  reason `reparent`, and rebases the lane's worktree onto the resolved
  base commit.
- Triggers downstream refresh events (rebase suggestion service
  re-evaluates, stack graph re-renders).

`ReparentLaneResult` carries the before/after parent ids and base refs
plus pre/post head shas so the UI can update state without a full list
refresh.

`syncRemoteCommandService` (ade-cli) parses `stackBaseBranchRef` off the
`lanes.reparent` payload as an optional trimmed string, so headless
controllers driving stack edits over sync see the same surface as the
desktop renderer.

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
     is primary or absent.
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
Rebase Now / Snooze banner / Hide banner actions. Those controls only
change suggestion visibility; PR workflow rebase needs come from
`conflictService.scanRebaseNeeds()` and remain actionable while the lane
is still behind.

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
- `recordAttentionStatus` lets other subsystems and the manual rebase UI
  annotate a lane so it appears in the Rebase tab's
  attention section.
- Statuses expire from the "auto-rebased" banner after
  `AUTO_REBASED_TTL_MS` (15 min).

## Renderer wiring

- `LaneStackPane` renders the stack graph in the left pane of the
  Lanes tab. Nodes show runtime dot (running/awaiting-input/ended)
  and integration-source chips for integration lanes.
- `LanesPage` passes `integrationSourcesByLaneId` built via
  `buildIntegrationSourcesByLaneId` from `renderer/lib/integrationLanes.ts`.
- `LaneRebaseBanner` is conditionally rendered above the lane detail
  when `listRebaseSuggestions` returns a suggestion that is neither
  dismissed nor deferred. PR workflow banners use rebase-need drift and
  route hide/snooze actions back to `rebaseSuggestionService`, so hiding
  a notification does not move a still-behind lane out of the active
  Rebase/Merge action list.
- `rebaseNeedUtils.ts` on the renderer side provides
  `buildUpstreamRebaseChain` for surfacing the full upstream rebase
  chain in the PRs Rebase tab (see
  [Pull requests](../pull-requests/README.md#pr-context-loading)).

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
