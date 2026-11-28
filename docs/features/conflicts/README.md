# Conflicts

The conflict service shows integration risk before merge time. One service in
`apps/desktop/src/main/services/conflicts/conflictService.ts` does conflict
prediction, pairwise risk, merge simulation, rebase-need scanning and AI
resolution proposals. There is no Conflicts tab. The signal shows up in:

- **Lanes:** the catch-up notice and menu (rebase needs through
  `window.ade.rebase.*`, `renderer/components/lanes/laneRebaseNeeds.ts`) and
  the lane list snapshot's conflict status.
- **PRs:** per-PR conflict analysis; an update that hits conflicts hands a
  resolve prompt to the lane's chat.
- **Agents and the CTO:** `conflicts.*` runtime actions (risk matrix, batch
  assessment, merge simulation, proposals).

No renderer view draws the risk matrix.

## Source file map

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/main/services/conflicts/conflictService.ts` | Prediction, simulation, risk matrix, proposals, rebase needs (`resolveLaneRebaseTarget`), AI rebase. |
| `apps/desktop/src/main/services/git/git.ts` | `runGit`, `runGitOrThrow`, `runGitMergeTree`, conflict type normalization. |
| `apps/desktop/src/main/services/git/gitConflictState.ts` | `detectConflictKind` for live merge/rebase state. |
| `apps/desktop/src/main/services/shared/remoteTrackingBranch.ts` | `fetchRemoteTrackingBranch`. |
| `apps/desktop/src/shared/laneBaseResolution.ts` | `branchNameFromLaneRef`; the compare base comes from `lanes/laneCompareBase.ts`. |
| `apps/desktop/src/shared/types/conflicts.ts` | Status, overlap, matrix, proposal and simulation types. |
| `apps/desktop/src/renderer/components/lanes/laneRebaseNeeds.ts` | Per-machine rebase-need scans for the Lanes tab. |
| `apps/desktop/src/renderer/components/prs/ConflictFilePreview.tsx` | Conflict marker preview. |

Detail docs:

- [`detection.md`](./detection.md): the prediction engine (periodic and realtime).
- [`simulation.md`](./simulation.md): one-shot merge simulation and AI resolution.

## Gotchas

- **Serialized pair tasks.** `runSerializedPairTask(pairId, task)` keeps one
  prediction per pair at a time; a queued task runs after the current one.
- **Above `FULL_MATRIX_MAX_LANES = 15` lanes** the service switches to
  prefilter mode (cheap overlap heuristic first, merge-tree only for likely
  pairs). Expect `truncated: true` and `strategy: "prefilter-overlap"`.
- **Stale predictions are still returned** with `lastPredictedAt`. For a fresh
  result, call `runPrediction` for that lane.
- **`git merge-tree` exit 128 is blocked, not clean.**
- **Insufficient context returns no patch.** Proposals set
  `insufficientContext: true` with `insufficientReasons[]` instead of guessing.
- **Don't hardcode the pack directory.** `conflictPacksDir` may be injected for
  tests; otherwise it derives from `resolveAdeLayout(projectRoot).packsDir`.

## Where this runs

Prediction, risk, the job engine and proposal prepare/dispatch/apply run on the
machine that holds the project (the brain for a local binding, the remote
runtime for a remote one). `window.ade.conflicts.*` calls go through preload to
the bound runtime; the in-process IPC handlers run only when no runtime is
bound. The worktrees and pack artifacts read are on that machine.

## Status model

`ConflictStatusValue` derives from prediction data:

| Value | Meaning |
|-------|---------|
| `merge-ready` | Base prediction exists, no predicted conflicts, behind-count = 0 |
| `behind-base` | Base prediction exists, no conflicts, but behind > 0 |
| `conflict-predicted` | Dry-merge predicts conflicts with base or a peer |
| `conflict-active` | An attempted merge/rebase has produced actual conflicts |
| `unknown` | No prediction yet, or prediction failed |

`computeStatusValue` enforces precedence: active conflict → unknown
fallback → predicted → behind → merge-ready.

`ConflictStatus`:

```ts
type ConflictStatus = {
  laneId: string;
  status: ConflictStatusValue;
  overlappingFileCount: number;
  peerConflictCount: number;
  lastPredictedAt: string | null;
};
```

`ConflictOverlap` carries the per-peer file list with risk level:

```ts
type ConflictOverlap = {
  peerId: string | null;  // null = overlap with base
  peerName: string;
  files: Array<{ path: string; conflictType: ConflictFileType }>;
  riskLevel: "none" | "low" | "medium" | "high";
};
```

`riskLevel` is derived from overlap count and conflict count via
`riskFromPrediction`:

- conflict or conflictCount > 0 → `high`
- overlapCount 0 → `none`
- overlapCount ≤ 2 → `low`
- overlapCount ≤ 6 → `medium`
- otherwise → `high`

## Risk matrix

`RiskMatrixEntry` for the project-wide pairwise grid:

```ts
type RiskMatrixEntry = {
  laneAId: string;
  laneBId: string;
  riskLevel: "none" | "low" | "medium" | "high";
  overlapCount: number;
  hasConflict: boolean;
};
```

`BatchAssessmentResult` bundles the entire snapshot:

```ts
type BatchAssessmentResult = {
  lanes: ConflictStatus[];
  matrix: RiskMatrixEntry[];
  overlaps: BatchOverlapEntry[];
  computedAt: string;
  progress: { completedPairs: number; totalPairs: number };
  strategy?: "full" | "full-target" | "prefilter-overlap";
  truncated?: boolean;
  pairwisePairsComputed?: number;
  pairwisePairsTotal?: number;
};
```

No renderer view shows the matrix. The data is available through the
conflicts tools and actions: the CTO `getConflictRiskMatrix` tool and
the `conflicts.getRiskMatrix` / `conflicts.getBatchAssessment` actions.
The lane list snapshot also reads the batch assessment for lane badges.

## Conflict pack / export

Context sent to an AI provider is a bounded export, not a raw pack dump: the
lane's and peer's lite lane exports (`laneExportLite`, `peerLaneExportLite`)
and a `ConflictExportStandard` with file contexts, side snapshots, hunks and
lineage. Envelopes carry `schema: "ade.conflictJobContext.v1"` (a wire name
kept as is).

Storage:

- `<projectRoot>/.ade/artifacts/packs/conflicts/v2/<laneId>__<peerKey>.md`: conflict pack markdown
- `<projectRoot>/.ade/artifacts/packs/conflicts/predictions/<laneId>.json`: per-lane prediction summary

Freshness metadata: `predictionAt`, `lastRecomputedAt`, `stalePolicy.ttlMs`,
plus `strategy`, `truncated`, `pairwisePairsComputed`, `pairwisePairsTotal`.

## Proposal model

`ConflictProposal`:

```ts
type ConflictProposal = {
  id: string;
  laneId: string;
  peerLaneId: string | null;
  predictionId: string | null;
  source: "subscription" | "local";
  confidence: number | null;
  explanation: string;
  diffPatch: string;
  status: "pending" | "applied" | "rejected" | "superseded";
  jobId: string | null;
  artifactId: string | null;
  appliedOperationId: string | null;
  createdAt: string;
  updatedAt: string;
};
```

`ConflictProposalPreview` captures the preview phase before AI dispatch
(bounded context, target file list, provider metadata). Stored
with a 20-minute TTL (`PREPARED_TTL_MS`) so stale previews are
auto-discarded.

Apply modes: `unstaged | staged | commit`. Apply goes through
`git apply --3way` and records an operation for undo via
`git apply -R`.

## Live conflict state (`GitConflictState`)

`detectConflictKind` inspects the lane worktree's gitdir for:

- `rebase-apply/` or `rebase-merge/` → `kind: "rebase"`
- `MERGE_HEAD` → `kind: "merge"`
- Neither → `kind: "none"`

Returns per-state `canContinue` / `canAbort` / `conflictedFiles`.
Surfaces: `ade.git.getConflictState`, `ade.git.rebaseContinue`,
`ade.git.rebaseAbort`, `ade.git.mergeContinue`, `ade.git.mergeAbort`.
The same five operations are registered as sync remote commands
(`git.getConflictState`, `git.rebaseContinue` / `Abort`,
`git.mergeContinue` / `Abort`) so the iOS lane conflict banner can
continue or abort either flow remotely.

## IPC surface

Prediction + simulation:

| Channel | Description |
|---------|-------------|
| `ade.conflicts.getLaneStatus` | Lane status badge |
| `ade.conflicts.listOverlaps` | Per-peer overlap details |
| `ade.conflicts.getRiskMatrix` | Full pairwise matrix |
| `ade.conflicts.runPrediction` | Trigger prediction for a lane or subset of lanes |
| `ade.conflicts.event` | Event stream: `prediction-progress`, `prediction-complete`, `prediction-updated` |

The full snapshot (`getBatchAssessment`) and the one-off merge simulation
(`simulateMerge`) have no IPC channel. Agents and scripts reach them through
the `conflicts.getBatchAssessment` and `conflicts.simulateMerge` runtime
actions and the CTO `simulateMerge` tool.

Proposals (AI + apply/undo):

| Channel | Description |
|---------|-------------|
| `ade.conflicts.listProposals` | Proposals for a lane |
| `ade.conflicts.prepareProposal` | Build bounded context, return preview |
| `ade.conflicts.requestProposal` | Dispatch to the Conflict Proposals model from Settings via `aiIntegrationService`; empty picker throws `Choose a Conflict Proposals model in Settings` rather than defaulting to Sonnet or the first available provider |
| `ade.conflicts.applyProposal` | Apply via `git apply --3way`, record operation |
| `ade.conflicts.undoProposal` | Reverse-apply via `git apply -R` |

Rebase needs (the Lanes tab reads them through `window.ade.rebase.scanNeeds` /
`getNeed` / `onEvent`, channels `ade.rebase.*`):

| Channel | Description |
|---------|-------------|
| `ade.conflicts.scanRebaseNeeds` | Compute rebase needs for all lanes |
| `ade.conflicts.getRebaseNeed` | Single-lane rebase need |
| `ade.conflicts.rebaseLane` | Rebase a lane onto its base (`daex git rebase --lane`) |

## Event stream

`ConflictEventPayload` kinds:

- `prediction-progress` — per-pair progress during `runPrediction`.
- `prediction-complete` — batch finished, emits chip deltas
  (`buildChips(before, after)`).
- `prediction-updated` — an individual prediction row changed
  outside a batch.
- `rebase-started`, `rebase-completed` — AI rebase lifecycle.

## Key constants

In `conflictService.ts`:

- `FULL_MATRIX_MAX_LANES = 15` — threshold below which a full
  pairwise matrix is computed automatically.
- `PREFILTER_MAX_PEERS_PER_LANE = 6` — peer cap in prefilter mode.
- `PREFILTER_MAX_GLOBAL_PAIRS = 800` — global cap.
- `PREFILTER_MAX_TOUCHED_FILES = 800` — touched-file cap per lane
  heuristic.
- `STALE_MS = 5 * 60_000` — 5-minute staleness cutoff.
- `PREPARED_TTL_MS = 20 * 60_000` — prepared proposal preview TTL.
