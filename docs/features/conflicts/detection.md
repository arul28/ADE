# Conflict detection

The conflict prediction engine lives in
`apps/desktop/src/main/services/conflicts/conflictService.ts`. It
runs `git merge-tree` to predict whether a merge or rebase would
produce conflicts — without actually performing the merge. Results
are cached in `conflict_predictions` and surfaced as lane status
badges, risk matrix cells, overlap chips, and rebase needs.

## `git merge-tree` primer

`git merge-tree` (3-way form) takes a merge-base SHA and two branch
SHAs and produces a merge tree without creating a commit or touching
the working directory. Exit codes:

- `0` — clean merge
- non-zero (but not 128) — conflicts found; stdout contains the
  tree OID and per-file conflict entries
- `128` — fatal git error (corrupt ref, missing object)

ADE wraps this via `runGitMergeTree({ cwd, mergeBase, branchA,
branchB, timeoutMs })` which parses stdout and returns:

```ts
{
  exitCode: number;
  stdout: string;
  stderr: string;
  treeOid: string | null;
  conflicts: Array<{ path: string; conflictType: string; markerPreview: string }>;
}
```

## Prediction sources

Two kinds of predictions are stored:

1. **Lane-to-base** — `lane_b_id IS NULL`. Compares the lane's head
   against its base ref (resolved through
   `shouldLaneTrackParent` / queue override / `base_ref` fallback).
2. **Pairwise** — `lane_a_id`, `lane_b_id` both set. Compares two
   lane heads at their merge base.

Per-pair deduplication uses `pairKey(a, b) = a < b ? a::b : b::a`
so `(A, B)` and `(B, A)` map to the same key.

## Periodic prediction (`runPrediction`)

Default path when no arguments are supplied:

```
1. Build a batch assessment snapshot (pre).
2. If a target laneId was supplied:
   - strategy = "full-target"
   - comparisonLanes = all active lanes
   - basePredictionLanes = [targetLane]
   - pairwiseComparisons = every other lane paired with the target
3. Otherwise, if laneIds[] was supplied:
   - comparisonLanes = selected lanes
   - basePredictionLanes = selected lanes
4. Otherwise:
   - comparisonLanes = all active lanes
   - basePredictionLanes = all active lanes
5. If |comparisonLanes| <= FULL_MATRIX_MAX_LANES (15):
   - strategy = "full"
   - pairwiseComparisons = every unordered pair
6. Else:
   - strategy = "prefilter-overlap"
   - Run buildPrefilterPairs(comparisonLanes)
   - truncated = pairwiseComparisons.length < pairwisePairsTotal
7. Run base predictions via runSerializedPairTask("base:<laneId>").
8. Run pairwise predictions via runSerializedPairTask("pair:<key>").
9. emitProgress per pair; emit "prediction-complete" at end with
   chip deltas computed from before/after matrices.
10. Write conflict packs via writeConflictPacks(after).
```

Per-pair serialization prevents duplicated work: if the UI triggers
a prediction for `(A, B)` while another is running for that pair,
the later call awaits the running one (and short-circuits if queued
work is redundant).

## Prefilter heuristic

Over 15 lanes, the service switches to a prefilter that computes a
cheap overlap heuristic before running merge-tree.

`buildPrefilterPairs(lanes)`:

1. For each lane, read "files touched since base" with
   `readTouchedFilesSinceBase(lane)`. This is capped at
   `PREFILTER_MAX_TOUCHED_FILES = 800` per lane (truncated
   alphabetically) so pathological lanes don't dominate.
2. For each lane, rank peers by touched-file overlap count.
3. Keep the top `PREFILTER_MAX_PEERS_PER_LANE = 6` peers per lane.
4. Deduplicate across the global pair set, capped at
   `PREFILTER_MAX_GLOBAL_PAIRS = 800`.
5. Return the prefiltered pair list.

The resulting `pairwiseComparisons` is typically far smaller than
the full `N*(N-1)/2`. Assessment metadata records:

- `truncated: true`
- `strategy: "prefilter-overlap"`
- `pairwisePairsComputed` (actual)
- `pairwisePairsTotal` (theoretical full matrix size)

Users can still force a full matrix for a specific lane by passing
`laneId` (→ strategy `"full-target"`) or `laneIds[]`.

## Realtime prediction

When a lane's dirty state changes, a lightweight overlap pass
kicks off:

1. Identify files touched in the current dirty state.
2. Compare against each peer's touched-file set (fast, in-memory).
3. For lanes with overlap, enqueue targeted merge-tree jobs.
4. Update lane statuses and emit `prediction-updated` for the UI.

This is the path that drives "new overlap" chips on lane rows as
users edit files.

## Stale prediction handling

A prediction is considered stale when `predicted_at` is older than
`STALE_MS = 5 * 60_000` (5 minutes).

Stale predictions are still returned by `getBatchAssessment` and
`getLaneStatus` with their original `lastPredictedAt` timestamp.
The UI decorates them rather than refetching:

- Risk matrix cells render at reduced opacity with a clock icon
  (`renderer/components/graph/shared/RiskMatrix.tsx`).
- Hover tooltip shows "Last computed N min ago. Click to refresh."
- Clicking triggers `runPrediction` for the specific pair.

`isStalePrediction(predictedAt)` returns `true` for missing or
unparseable timestamps, ensuring "no data" renders as stale rather
than fresh-but-empty.

## Chip generation

`buildChips(before, after)` diffs two risk matrices and produces
`ConflictChip[]` transitions:

- `new overlap` — a pair transitioned from `none` → any
  non-`none` risk level.
- `high risk` — a pair transitioned to `high` (multiple overlapping
  files or marker conflicts detected).

Chips are deduplicated via `dedupeChips` keyed by
`${laneId}:${peerId ?? "base"}:${kind}`, keeping the entry with the
higher `overlapCount`.

## Conflict file assembly

`buildConflictFiles(conflicting, overlapFiles)` merges the two
inputs into a stable list:

1. First, every entry from `conflicting` (conflict-typed entries
   from merge-tree) in insertion order.
2. Then every path from `overlapFiles` that wasn't already present,
   with `conflictType: "content"` and empty marker preview.
3. Sorted by path at the end.

This ensures the UI always sees a deterministic, deduplicated list
even when the prediction run recorded overlaps separately from the
merge-tree conflict output.

## Queue-aware comparison ref

`resolveLaneRebaseTarget({ lane, lanesById, queueOverride })` picks
the comparison ref for rebase predictions:

1. If `queueOverride` present: use
   `queueOverride.comparisonRef` and `displayBaseBranch`.
2. Else if parent is non-primary and
   `shouldLaneTrackParent({ lane, parent })`: use the parent's
   branch ref, with `origin/<parent-branch>` as a fallback.
3. Else if `lane.baseRef` present: use `origin/<baseRef>` with
   local `<baseRef>` as fallback.
4. Else: use `lane.baseRef` directly and display it.

This resolver is used by both `scanRebaseNeeds` (batch) and
`getRebaseNeed` (single). `rebaseLane` (AI-assisted) applies the
same logic so the prediction and the actual rebase target stay in
sync.

## Tables

```sql
-- Prediction records
conflict_predictions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  lane_a_id TEXT NOT NULL,
  lane_b_id TEXT,                  -- NULL = lane vs base
  status TEXT NOT NULL,            -- 'clean' | 'conflict' | 'unknown'
  conflicting_files_json TEXT,
  overlap_files_json TEXT,
  lane_a_sha TEXT,
  lane_b_sha TEXT,
  predicted_at TEXT NOT NULL,
  expires_at TEXT
)

-- Rebase dismiss/defer (persisted across app restarts)
rebase_dismissed (project_id, lane_id, dismissed_at)
rebase_deferred  (project_id, lane_id, deferred_until)
```

Both rebase tables are loaded into in-memory caches
(`rebaseDismissed`, `rebaseDeferred`) on service init for fast reads
during scan.

## Events

`ConflictEventPayload` kinds emitted during detection:

- `prediction-progress` — per-pair with `{ completedPairs,
  totalPairs, pair: { laneAId, laneBId } }`.
- `prediction-complete` — end-of-batch with chip deltas and
  affected `laneIds[]`.
- `prediction-updated` — single-row update (targeted re-prediction
  or realtime pass).

The renderer subscribes via `ade.conflicts.event` and uses progress
events to drive the `RiskMatrix` animated progress bar.

## Gotchas

- **Don't clear `prediction` tables at startup.** The rebase
  dismiss/defer caches load from DB on service init; wiping them
  would re-surface every dismissed suggestion on next boot.
- **Prefilter does NOT guarantee freshness.** A pair below the
  "likely conflict" threshold is not re-predicted in prefilter
  mode. The UI treats those as `unknown` status for pairs that lack
  a row, not `clean`.
- **`EXTERNAL_DIFF_MAX_OUTPUT_BYTES = 32 MB`** is the hard cap on
  external diff capture. A pathological diff will truncate rather
  than OOM the process.
- **Parent tracking is a shared rule.** Any consumer that recomputes
  "is this lane behind its base" outside of
  `resolveLaneRebaseTarget` will produce wrong results for lanes
  parented to the primary lane. Always use the resolver.
- **`git merge-tree` timeouts** default to 30 s in `simulateMerge`
  and 60 s elsewhere. Long timeouts protect against giant branches
  but mean a stuck git process can block the pair lock for that
  long. If you see `conflicts.predict_pair_failed` warnings with
  AbortError, check for a hung git.
