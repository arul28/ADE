# PR conflict simulation

ADE predicts PR merge conflicts before the user hits Merge by running
`git merge-tree` locally. This covers three PR-adjacent scenarios:

1. **PR-to-base** — will this PR land cleanly on its base branch?
2. **Pairwise integration** — do any two source PRs in an integration
   proposal conflict with each other?
3. **Queue-aware rebase** — is the lane behind its queue's tracking
   branch, and if so, does rebasing produce conflicts?

All three use the shared conflict service primitives documented in
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

## Pairwise integration simulation

`prService.simulateIntegration({ sourceLaneIds, baseBranch,
mergeIntoLaneId? })` runs the pairwise matrix for an integration
(merge-plan) proposal:

1. `buildIntegrationPreflight` validates:
   - at least one source lane
   - no duplicate source lane ids (`duplicateSourceLaneIds`)
   - no missing source lane ids (`missingSourceLaneIds`)
2. Resolve `baseSha` via `git rev-parse <baseBranch>`.
3. For each source lane, read `headSha`, `commitCount`, and
   `diffStat` against the base.
4. For each unordered pair `(i, j)` with `i < j`:
   - `runGitMergeTree({ mergeBase: baseSha, branchA: headSha_i,
     branchB: headSha_j, timeoutMs: 30_000 })`.
   - Exit code 128 is a fatal git error — both lanes are marked as
     `blocked`.
   - Non-zero exit without conflicts is also treated as blocked (an
     unknown state).
   - Otherwise: parse conflict tree OID, list conflicting files,
     produce marker previews via `parseConflictMarkers`.
5. Compute per-lane summary rows (`laneSummaries`) with position,
   commit hash, commit count, and diff stat.
6. If `mergeIntoLaneId` is present, resolve that lane's HEAD and run
   additional merge-tree checks from the adopted merge target against
   each source lane. This does not replace the child-vs-child pairwise
   matrix; it adds target-lane conflict evidence.
7. Return `IntegrationProposal` with pairwise results, lane
   summaries, computed overall outcome, and optional merge-target
   metadata.

`IntegrationProposal` fields include:

- `steps` — serialized merge plan with per-step status.
- `pairwiseResults` — `Array<{ laneAId, laneBId, outcome: "clean" | "conflict" | "blocked", conflictingFiles }>`.
- `laneSummaries` — per-lane commit hash, position, `conflictsWith[]`.
- `overallOutcome` — `"clean" | "conflict" | "blocked"`.
- `preferredIntegrationLaneId` — selected existing merge target lane
  when the proposal should merge into an adopted lane.
- `mergeIntoHeadSha` — selected merge target HEAD at simulation time,
  used to detect drift before commit.

## Conflict marker parsing

Conflict previews come from `parseConflictMarkers` in
`prService.ts`:

```ts
const markerRegex = /(<<<<<<<[^\r\n]*\r?\n)([\s\S]*?)(=======\r?\n)([\s\S]*?)(>>>>>>>[^\r\n]*)/g;
```

Handles `\r\n` line endings alongside `\n` for Windows compatibility.
Extracts:

- `conflictMarkers` — the raw marker blocks joined with `---`
  separators, capped at 2000 bytes.
- `oursExcerpt` / `theirsExcerpt` — the content between markers,
  each capped at 500 bytes.
- `diffHunk` — the first 12 lines of each marker block joined.

The parser is shared between `readConflictFilePreviewFromWorktree`
and the integration merge flow so they produce identical output.

`hasMergeConflictMarkers(content)` in `integrationValidation.ts` is
the gating check used before parsing. It requires all three markers
(`<<<<<<<`, `=======`, `>>>>>>>`) to be present.

## Integration lane creation

When a proposal's plan is accepted, ADE either creates a dedicated
integration lane or adopts an existing lane as the merge target.

`createIntegrationLaneForProposal`:

1. Ensure the proposal has no `integration_lane_id` yet.
2. If `preferred_integration_lane_id` is set, validate that lane still
   exists, is not a source lane, is not primary, and passes the dirty
   worktree preflight unless `allowDirtyWorktree` was explicitly set.
3. Otherwise create a child lane under the base branch, name
   `integration-<short-id>`.
4. Persist `integration_lane_id` on the proposal row. The display
   origin is inferred as `adopted` when the preferred lane became the
   integration lane; otherwise it is `ade-created`.
5. Emit lane/PR events so graph and workflow surfaces refresh.

`commitIntegration` runs the actual merges sequentially:

1. For each step in stack-depth order, merge the source lane's
   head into the integration lane.
2. Pause on conflict — the user can run the external resolver
   (Codex / Claude) through the Integration tab.
3. On success, mark the step `committed`.
4. When all steps complete, flip the proposal's
   `workflow_display_state` to `history` and surface cleanup actions.

`cleanupIntegrationWorkflow` prompts the user to declare whether to
delete the integration lane / its source lanes / neither, and records
the decision in `cleanup_state`. Adopted merge-target lanes are kept by
default because ADE did not create them for the proposal.

## Rebase prediction

The same merge-tree primitive powers rebase prediction. For each
lane, `scanRebaseNeeds` computes:

- `behindBy` — commit count difference against the comparison ref.
- `conflictPredicted` — true if `git merge-tree` reports conflicts.
- `conflictingFiles` — when `conflictPredicted`, the paths that
  would conflict on rebase.

The comparison ref is resolved via `resolveLaneRebaseTarget`:

- Queue override (if the lane is in a merge queue)
- Parent lane branch (if non-primary parent and `shouldLaneTrackParent`)
- `origin/<baseRef>` with fallback to local `<baseRef>`

This keeps the PR Rebase tab's prediction consistent with the lane
service's actual rebase target (they use the same resolver).

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

PR-specific IPC that consumes the conflict/simulation stack:

| Channel | Description |
|---------|-------------|
| `ade.prs.simulateIntegration` | Compute pairwise integration matrix |
| `ade.prs.createIntegrationLaneForProposal` | Create or adopt merge-target lane |
| `ade.prs.commitIntegration` | Sequentially merge source lanes into the integration lane |
| `ade.prs.cleanupIntegrationWorkflow` | Record cleanup decision |
| `ade.prs.getMergeContext` | Read PR merge readiness (mergeable, behind-by, conflicts) |
| `ade.prs.recheckIntegrationStep` | Re-simulate a single integration step |

Shared conflict IPC consumed by PR flows:

| Channel | Description |
|---------|-------------|
| `ade.conflicts.simulateMerge` | Run a merge simulation between two lanes (or lane-to-base) |
| `ade.conflicts.getLaneStatus` | Lane conflict status badge |
| `ade.conflicts.listOverlaps` | Per-peer overlap lists |
| `ade.conflicts.runPrediction` | Trigger prediction for a lane or pair |
| `ade.conflicts.getBatchAssessment` | Batch view (used by Graph risk matrix) |

## Renderer wiring

- `PrDetailPane.tsx` reads merge context on PR select and renders
  mergeability + conflict badges.
- `IntegrationTab.tsx` (3022 lines) is the primary consumer for
  pairwise simulation. It builds the matrix, streams per-step
  commits, and surfaces blocked/conflict states with resolver entry
  points.
- `ConflictFilePreview.tsx` renders file-level conflict markers
  from the parsed output.
- `IntegrationPrContextPanel.tsx` shows the integration proposal's
  evidence inline on the PR detail.
- `graph/shared/RiskMatrix.tsx` renders the full pairwise matrix
  (see [`../workspace-graph/README.md`](../workspace-graph/README.md)).

## Gotchas

- **`git merge-tree` exit codes**. Exit 0 = clean or conflict
  (parse stdout to differentiate). Exit 128 = fatal (corrupt ref,
  missing object). Any other non-zero with no conflicts = unknown
  state; both lanes are marked `blocked` rather than assumed clean.
  Blocking blocks surface in the integration UI with a log warning.
- **Commit count vs diff stat path**. `rev-list --count <base>..<head>`
  counts commits; `diff --shortstat` reports aggregate
  insertions/deletions. When `headSha` is null (rev-parse failed),
  the lane summary carries `commitCount: 0` and `diffStat: 0/0/0`.
- **Base SHA is resolved once per proposal simulation.** All lanes
  compare against the same `baseSha` so pairwise results are
  internally consistent even if the base branch advances mid-run.
- **The `\0` sanitization in the merge-tree unknown log** preserves
  stdout for debugging without letting null bytes break the
  structured log. If you change this, test with a real merge-tree
  tree OID that contains NULs.
- **Marker parser caps are not user-configurable.** 2000/500/500
  byte caps are hardcoded for predictable prompt sizes downstream.
- **`conflictType` is always `"content"` from the parser.** Rename /
  delete / add conflicts are detected at the git level, not via the
  marker parser.
