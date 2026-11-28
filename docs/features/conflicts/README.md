# Conflicts

The conflict service shows integration risk before merge time. One service,
`apps/desktop/src/main/services/conflicts/conflictService.ts`, does conflict
prediction, pairwise risk, merge simulation, rebase-need scanning and AI
resolution proposals. There is no Conflicts tab; the signal shows up in:

- **Lanes:** the catch-up notice and menu (rebase needs through `window.ade.rebase.*`, `renderer/components/lanes/laneRebaseNeeds.ts`) and the lane list snapshot's conflict status.
- **PRs:** `prs.getConflictAnalysis` / `prs.listWithConflicts`; an **Update branch** that hits conflicts hands a resolve prompt to the lane's chat ([PRs › Merge flow](../pull-requests/README.md#merge-flow)).
- **Agents and the CTO:** `conflicts.*` runtime actions (risk matrix, batch assessment, merge simulation, proposals).

No renderer view draws the risk matrix.

Detail docs:

- [`detection.md`](./detection.md): the prediction engine (periodic and realtime).
- [`simulation.md`](./simulation.md): one-shot merge simulation and AI resolution.

## Source file map

| File | Owns |
|---|---|
| `apps/desktop/src/main/services/conflicts/conflictService.ts` | Prediction, simulation, risk matrix, proposals, rebase needs (`resolveLaneRebaseTarget`), AI rebase. |
| `apps/desktop/src/main/services/git/git.ts` | `runGit`, `runGitMergeTree`, conflict type normalization. |
| `apps/desktop/src/main/services/git/gitConflictState.ts` | `detectConflictKind` for a live merge or rebase. |
| `apps/desktop/src/main/services/shared/remoteTrackingBranch.ts` | `fetchRemoteTrackingBranch`. |
| `apps/desktop/src/main/services/lanes/laneCompareBase.ts`, `apps/desktop/src/shared/laneBaseResolution.ts` | The compare base. |
| `apps/desktop/src/shared/types/conflicts.ts` | Status, overlap, matrix, proposal and simulation types. |
| `apps/desktop/src/renderer/components/lanes/laneRebaseNeeds.ts` | Per-machine rebase-need scans for Lanes. |
| `apps/desktop/src/renderer/components/prs/ConflictFilePreview.tsx` | Conflict marker preview. |

## Gotchas

- **Serialized pair tasks.** `runSerializedPairTask(pairId, task)` runs one prediction per pair at a time.
- **Above `FULL_MATRIX_MAX_LANES` (15) lanes** the service switches to prefilter mode (cheap overlap heuristic, merge-tree only for likely pairs): expect `truncated: true` and `strategy: "prefilter-overlap"`. Caps: `PREFILTER_MAX_PEERS_PER_LANE`, `PREFILTER_MAX_GLOBAL_PAIRS`, `PREFILTER_MAX_TOUCHED_FILES`.
- **Stale predictions are still returned** with `lastPredictedAt` (stale after `STALE_MS`, 5 min). Call `runPrediction` for a fresh one.
- **`git merge-tree` exit 128 is blocked, not clean**; any other non-zero with no conflicts is unknown.
- **Insufficient context returns no patch.** Proposals set `insufficientContext: true` with `insufficientReasons[]`.
- **Don't hardcode the pack directory.** It derives from `resolveAdeLayout(projectRoot).packsDir` unless injected.

## Where this runs

Prediction, risk, the job engine and proposals run on the machine that holds
the project (the brain, or the remote runtime). `window.ade.conflicts.*` goes
through preload to the bound runtime; in-process IPC runs only with no runtime
bound.

## Status model

`ConflictStatusValue`: `merge-ready` (no conflicts, not behind), `behind-base`,
`conflict-predicted` (a dry merge with base or a peer conflicts),
`conflict-active` (a real merge or rebase is conflicted), `unknown`.
`computeStatusValue` precedence: active → unknown → predicted → behind →
merge-ready.

`ConflictOverlap` lists per-peer files (`peerId: null` means the base) with a
`riskLevel` from `riskFromPrediction`: any conflict → `high`; 0 overlapping
files → `none`; ≤ 2 → `low`; ≤ 6 → `medium`; else `high`.

`BatchAssessmentResult` bundles lane statuses, the pairwise `RiskMatrixEntry[]`,
overlaps, progress and `strategy` / `truncated`. It is read by the CTO
`getConflictRiskMatrix` tool, the `conflicts.getRiskMatrix` /
`conflicts.getBatchAssessment` actions, and the lane list snapshot for badges.

## Conflict context and storage

Context sent to an AI provider is a bounded export (lite lane exports plus a
`ConflictExportStandard` of file contexts, hunks and lineage), wrapped with
`schema: "ade.conflictJobContext.v1"` (a frozen wire name). Packs live under
`.ade/artifacts/packs/conflicts/` (`v2/<laneId>__<peerKey>.md` and
`predictions/<laneId>.json`).

## Proposals

`ConflictProposal` (`source: "subscription" | "local"`, `status: pending |
applied | rejected`). A prepared preview lives 20 minutes
(`PREPARED_TTL_MS`). Apply (`unstaged | staged | commit`) runs
`git apply --3way` and records an operation; undo runs `git apply -R`. Details
in [simulation.md](./simulation.md).

## Live conflict state

`detectConflictKind` reads the lane's gitdir: `rebase-apply/` or
`rebase-merge/` → `rebase`, `MERGE_HEAD` → `merge`, else `none`, with
`canContinue` / `canAbort` / `conflictedFiles`. Surfaces:
`ade.git.getConflictState`, `rebaseContinue`, `rebaseAbort`, `mergeContinue`,
`mergeAbort`, also as sync commands for the iOS conflict banner.

## IPC surface

- Prediction: `ade.conflicts.getLaneStatus`, `listOverlaps`, `getRiskMatrix`, `runPrediction`, and the `ade.conflicts.event` stream (`prediction-progress`, `prediction-complete` with chip deltas, `rebase-started`, `rebase-completed`, `rebase-needs-updated`).
- `getBatchAssessment` and `simulateMerge` have no IPC channel: use the `conflicts.*` runtime actions or the CTO `simulateMerge` tool.
- Proposals: `listProposals`, `prepareProposal`, `requestProposal` (uses the Conflict Proposals model from Settings; with none chosen it throws "Choose a Conflict Proposals model in Settings" instead of guessing), `applyProposal`, `undoProposal`.
- Rebase needs: `scanRebaseNeeds`, `getRebaseNeed`, `rebaseLane` (`daex git rebase --lane`); the Lanes tab reads them through `window.ade.rebase.*`. The comparison ref comes from `resolveLaneRebaseTarget` (open PR base, else the default branch), the same resolver the lane rebase uses.
