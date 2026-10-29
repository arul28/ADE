# PR conflict simulation

ADE predicts PR merge conflicts before the user hits Merge by running
`git merge-tree` locally. This covers two PR-adjacent scenarios:

1. **PR-to-base** — will this PR land cleanly on its base branch?
2. **Lane rebase** — is the lane behind its parent or base branch, and
   if so, does rebasing produce conflicts?

Both use the shared conflict service primitives documented in
[`../conflicts/README.md`](../conflicts/README.md) and
[`../conflicts/detection.md`](../conflicts/detection.md). This doc
focuses on the PR-surface specifics.

## PR-to-base simulation

`conflictService.simulateMerge({ laneAId })` (omit `laneBId` for
lane-to-base) runs:

```
git merge-tree <base> <lane-HEAD>
```

Results:

- `outcome: "clean"` — no conflicts.
- `outcome: "conflict"` — a list of conflicting files with marker
  previews.
- `outcome: "error"` — the merge-tree command failed (typically a
  bad ref or corrupt index).

The PR detail pane surfaces the outcome in the merge readiness
panel. When outcome is `conflict`, the "Merge" button is disabled
unless the user opts into merge bypass (and only when the PR is not
locally conflicting).

When **Update branch** hits conflicts, the detail pane hands a
"resolve conflicts" prompt to the lane's newest work chat (or a new
chat), on the lane's own machine.

## Rebase prediction

The same merge-tree primitive powers rebase prediction. For each
lane, `scanRebaseNeeds` computes:

- `behindBy` — commit count difference against the comparison ref.
- `conflictPredicted` — true if `git merge-tree` reports conflicts.
- `conflictingFiles` — when `conflictPredicted`, the paths that
  would conflict on rebase.

The comparison ref is resolved via `resolveLaneRebaseTarget`:

- The open PR base branch, or the project default branch when no PR is open.

This keeps the prediction consistent with the lane service's actual
rebase target (they use the same resolver). Rebase needs are computed on
each scan; nothing about them is stored.

## Caching and staleness

Prediction results are stored in the `conflict_predictions` table:

| Column | Use |
|--------|-----|
| `lane_a_id`, `lane_b_id` | pair (or lane-to-base when `lane_b_id IS NULL`) |
| `status` | `clean` / `conflict` / `unknown` |
| `conflicting_files_json` | JSON array of `{ path, conflictType }` |
| `overlap_files_json` | paths touched on both sides |
| `lane_a_sha`, `lane_b_sha` | head SHAs at prediction time |
| `predicted_at` | ISO timestamp |
| `expires_at` | when the prediction goes stale |

`STALE_MS = 5 * 60_000` — predictions older than 5 minutes are
marked stale and surfaced with a clock indicator in the UI.

The prediction engine runs:

- **Periodically** via the job engine (background sweep).
- **On-demand** via `ade.conflicts.runPrediction` (user-triggered
  from the UI).
- **Realtime** when a lane's dirty state changes and overlap is
  detected with a peer lane.

## IPC surface (PR side)

| Channel | Description |
|---------|-------------|
| `ade.prs.getConflictAnalysis` | Per-PR conflict analysis (risk, overlaps, peer conflicts) |
| `ade.prs.listWithConflicts` | PR rows, optionally with conflict analysis |
| `ade.rebase.scanNeeds` / `ade.rebase.getNeed` | Lane rebase needs |

Shared conflict IPC consumed by PR flows:

| Channel | Description |
|---------|-------------|
| `ade.conflicts.getLaneStatus` | Lane conflict status badge |
| `ade.conflicts.listOverlaps` | Per-peer overlap lists |
| `ade.conflicts.runPrediction` | Trigger prediction for a lane or pair |

## Renderer wiring

- `PrDetailPane.tsx` renders mergeability and conflict badges.
- `ConflictFilePreview.tsx` renders file-level conflict markers.

## Gotchas

- **`git merge-tree` exit codes**. Exit 0 = clean or conflict
  (parse stdout to differentiate). Exit 128 = fatal (corrupt ref,
  missing object). Any other non-zero with no conflicts = unknown
  state, not clean.
- **`conflictType` is `"content"` for marker conflicts.** Rename /
  delete / add conflicts are detected at the git level, not via
  conflict markers.
