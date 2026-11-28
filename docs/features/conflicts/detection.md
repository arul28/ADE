# Conflict detection

The prediction engine (`apps/desktop/src/main/services/conflicts/conflictService.ts`)
runs in the active runtime and uses `git merge-tree` on the machine that owns
the worktrees to predict whether a merge or rebase would conflict, without
touching any working tree. Results are cached in `conflict_predictions` and
feed lane status badges, overlap chips and rebase needs. A remote window
receives events through preload and never spawns git itself.

## `git merge-tree`

`runGitMergeTree({ cwd, mergeBase, branchA, branchB, timeoutMs })` (`git/git.ts`)
returns `{ exitCode, stdout, stderr, treeOid, conflicts[] }`. Exit `0` is clean,
another non-zero (not 128) means conflicts, `128` is a fatal git error.

One `git merge-tree -h` probe per process decides whether `--write-tree`
(git 2.38+) and `--merge-base` (2.40+) exist. Older git runs the legacy
trivial-merge form: markers, a delete against a change, and a binary changed on
both sides count as conflicts; `treeOid` is null. Calls use a 60 s timeout; a
hung git holds that pair's lock until then (look for
`conflicts.predict_pair_failed` with `AbortError`).

## What is predicted

- **Lane-to-base** (`lane_b_id IS NULL`): the lane's head against its rebase target.
- **Pairwise**: two lane heads at their merge base, keyed by `pairKey(a, b)` (order-independent).

`runPrediction({ laneId?, laneIds? })`:

- With `laneId`: strategy `full-target`, the lane against base and against every other lane.
- With `laneIds`: those lanes only.
- Otherwise all active lanes: `full` (every pair) up to `FULL_MATRIX_MAX_LANES` (15), else `prefilter-overlap`.
- Each base and pair runs through `runSerializedPairTask` (a call for a running pair awaits it), emits `prediction-progress`, and the batch ends with `prediction-complete` carrying chip deltas, then `writeConflictPacks`.

**Prefilter** (`buildPrefilterPairs`): read each lane's files touched since
base (≤ `PREFILTER_MAX_TOUCHED_FILES` = 800), keep
each lane's top `PREFILTER_MAX_PEERS_PER_LANE` (6) peers by overlap, cap at
`PREFILTER_MAX_GLOBAL_PAIRS` (800). The assessment records `truncated`,
`pairwisePairsComputed` and `pairwisePairsTotal`. Pairs left out have no row and
read as `unknown`, never `clean`. Passing `laneId` forces a full matrix for one
lane.

## Staleness, chips and files

- A prediction older than `STALE_MS` (5 min) is stale but still returned with its timestamp. `isStalePrediction` treats a missing or bad timestamp as stale.
- `buildChips(before, after)` emits `new-overlap` (a pair left `none`) and `high-risk` (a pair reached `high`), deduped per `laneId:peer:kind` keeping the larger `overlapCount`.
- `buildConflictFiles` lists merge-tree conflicts first, then overlap-only paths as `content`, deduped and sorted by path.

## Rebase target

`resolveLaneRebaseTarget(lane)` is the lane's compare base (open PR base, else
the default branch), read as `origin/<base>` with the local branch as fallback.
`scanRebaseNeeds`, `getRebaseNeed` and `rebaseLane` all use it, so prediction
and rebase agree. For a lane built on a recently merged PR, prediction replays
only the commits after that PR's head, matching the rebase's `--onto`. Any
code that decides "is this lane behind" must use this resolver. Rebase needs
are computed per scan and never stored; changes emit `rebase-needs-updated`.

## Table

`conflict_predictions`: `lane_a_id`, `lane_b_id` (null for base), `status`
(`clean` / `conflict` / `unknown`), `conflicting_files_json`,
`overlap_files_json`, `lane_a_sha`, `lane_b_sha`, `predicted_at`, `expires_at`.

## Events

`ade.conflicts.event` carries `prediction-progress` (`completedPairs`,
`totalPairs`, `pair`), `prediction-complete` (`chips`, `laneIds`),
`rebase-started`, `rebase-completed` and `rebase-needs-updated`. No renderer
view draws the matrix or its progress.
