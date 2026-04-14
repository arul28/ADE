# Conflicts

ADE's conflict feature surfaces integration risk before it becomes a
merge-time emergency. A single shared service powers conflict
detection, pairwise risk computation, merge simulation, rebase-need
scanning, AI resolution proposals, and external CLI resolver runs.
There is no dedicated "Conflicts" tab in the app — conflict signal
is projected into the surfaces where it matters:

- **Lanes**: status badges and overlap chips on lane rows, inline
  merge simulation, rebase banner.
- **Graph**: project-wide `RiskMatrix`, pairwise overlap tooltips,
  inline `ConflictPanel` for AI resolution.
- **PRs**: blocked/manual rebase UIs, integration (merge-plan)
  pairwise simulation, issue resolution.

## Source file map

Main-process:

| File | Responsibility |
|------|---------------|
| `apps/desktop/src/main/services/conflicts/conflictService.ts` | Prediction, simulation, risk matrix, proposals, external resolver runs, rebase needs, AI rebase (4.6k lines) |
| `apps/desktop/src/main/services/git/git.ts` | `runGit`, `runGitOrThrow`, `runGitMergeTree`, conflict type normalization |
| `apps/desktop/src/main/services/git/gitConflictState.ts` | `detectConflictKind` for live merge/rebase state |
| `apps/desktop/src/main/services/shared/queueRebase.ts` | `resolveQueueRebaseOverride`, `fetchQueueTargetTrackingBranches`, `fetchRemoteTrackingBranch` |
| `src/shared/laneBaseResolution.ts` | `shouldLaneTrackParent`, `branchNameFromLaneRef` for comparison ref resolution |

Renderer:

| File | Responsibility |
|------|---------------|
| `renderer/components/graph/shared/RiskMatrix.tsx` | Animated pairwise risk grid |
| `renderer/components/graph/shared/RiskTooltip.tsx` | Hover detail for a matrix cell |
| `renderer/components/graph/graphDialogs/ConflictPanel.tsx` | AI proposal apply flow, overlapping file list |
| `renderer/components/lanes/mergeSimulation/*` | Conflict file diff, merge simulation panel, language detection |
| `renderer/components/shared/conflictResolver/ResolverTerminalModal.tsx` | External CLI resolver terminal modal |
| `renderer/components/prs/ConflictFilePreview.tsx` | Conflict marker preview (re-used from PR flows) |

Detail docs in this folder:

- [`detection.md`](./detection.md) — the prediction engine (periodic + realtime).
- [`simulation.md`](./simulation.md) — pre-flight merge simulation, merge plans, AI resolution, external resolver.

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

The renderer consumes this via `ade.conflicts.getBatchAssessment`
and renders the matrix in the Graph tab.

## Conflict pack / export

Conflict context sent to AI providers is bundled as a versioned
export, not a raw pack dump:

- `LaneExportLite`, `LaneExportStandard`, `LaneExportDeep` — lane
  context at varying levels of detail.
- `ConflictExportStandard` — per-conflict bundle with file contexts,
  side snapshots, hunks, and lineage.
- Context envelopes include `schema: "ade.conflictJobContext.v1"` so
  downstream consumers can version-gate.

Storage:

- `<projectRoot>/.ade/artifacts/packs/conflicts/v2/<laneId>__<peerKey>.md` — conflict pack v2 markdown
- `<projectRoot>/.ade/artifacts/packs/conflicts/predictions/<laneId>.json` — per-lane prediction summary
- `<projectRoot>/.ade/artifacts/packs/external-resolver-runs/<runId>/` — external resolver run artifacts (prompt, stdout, patch, summary)

Pack freshness metadata: `predictionAt`, `lastRecomputedAt`,
`stalePolicy.ttlMs`, plus coverage metadata `strategy`, `truncated`,
`pairwisePairsComputed`, `pairwisePairsTotal`.

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

## IPC surface

Prediction + simulation:

| Channel | Description |
|---------|-------------|
| `ade.conflicts.getLaneStatus` | Lane status badge |
| `ade.conflicts.listOverlaps` | Per-peer overlap details |
| `ade.conflicts.getRiskMatrix` | Full pairwise matrix |
| `ade.conflicts.getBatchAssessment` | Full snapshot with progress metadata |
| `ade.conflicts.simulateMerge` | One-off merge simulation between two lanes or lane-to-base |
| `ade.conflicts.runPrediction` | Trigger prediction for a lane or subset of lanes |
| `ade.conflicts.event` | Event stream: `prediction-progress`, `prediction-complete`, `prediction-updated` |

Proposals (AI + apply/undo):

| Channel | Description |
|---------|-------------|
| `ade.conflicts.listProposals` | Proposals for a lane |
| `ade.conflicts.prepareProposal` | Build bounded context, return preview |
| `ade.conflicts.requestProposal` | Dispatch to provider via `aiIntegrationService` |
| `ade.conflicts.applyProposal` | Apply via `git apply --3way`, record operation |
| `ade.conflicts.undoProposal` | Reverse-apply via `git apply -R` |

External resolver (Codex/Claude CLI):

| Channel | Description |
|---------|-------------|
| `ade.conflicts.runExternalResolver` | Spawn CLI session, attach/track via session service |
| `ade.conflicts.listExternalResolverRuns` | Run history for a lane |
| `ade.conflicts.commitExternalResolverRun` | Stage + commit the resolver's changes |
| `ade.conflicts.prepareResolverSession` | Build scenario, cwd, integration lane selection |
| `ade.conflicts.attachResolverSession`, `.finalizeResolverSession`, `.cancelResolverSession` | Session lifecycle |
| `ade.conflicts.suggestResolverTarget` | Heuristic target lane suggestion |

Rebase needs / AI rebase:

| Channel | Description |
|---------|-------------|
| `ade.conflicts.scanRebaseNeeds` | Compute rebase needs for all lanes |
| `ade.conflicts.getRebaseNeed` | Single-lane rebase need |
| `ade.conflicts.dismissRebase` / `.deferRebase` | Suppress a rebase need |
| `ade.conflicts.rebaseLane` | Run AI-assisted rebase |

## Surface split

Conflict intelligence lives where it's useful:

- **Lanes**: status badges, overlap counts, "Open in Graph" jump.
- **Graph**: `RiskMatrix` with animated transitions, cell tooltips
  with overlap file lists, `ConflictPanel` for AI proposal apply,
  merge simulation entry from edge clicks.
- **PRs > Rebase**: rebase continue/abort, manual attention surface
  for failed auto-rebases, upstream rebase chain view.
- **PRs > Integration**: pairwise matrix for merge-plan proposals.

All surfaces consume the same service. Keeping prediction,
simulation, and proposals behind a single service means the
surfaces are rendering views rather than re-implementing logic.

## Event stream

`ConflictEventPayload` kinds:

- `prediction-progress` — per-pair progress during `runPrediction`.
- `prediction-complete` — batch finished, emits chip deltas
  (`buildChips(before, after)`).
- `prediction-updated` — an individual prediction row changed
  outside a batch.
- `rebase-started`, `rebase-completed` — AI rebase lifecycle.
- `resolver-run-started`, `resolver-run-completed`,
  `resolver-run-failed` — external resolver lifecycle.

## Key constants

In `conflictService.ts`:

- `FULL_MATRIX_MAX_LANES = 15` — threshold below which a full
  pairwise matrix is computed automatically.
- `PREFILTER_MAX_PEERS_PER_LANE = 6` — peer cap in prefilter mode.
- `PREFILTER_MAX_GLOBAL_PAIRS = 800` — global cap.
- `PREFILTER_MAX_TOUCHED_FILES = 800` — touched-file cap per lane
  heuristic.
- `STALE_MS = 5 * 60_000` — 5-minute staleness cutoff.
- `EXTERNAL_DIFF_MAX_OUTPUT_BYTES = 32 * 1024 * 1024` — 32 MB hard
  cap on external resolver diff output.
- `PREPARED_TTL_MS = 20 * 60_000` — prepared proposal preview TTL.

## Gotchas

- **Serialized pair tasks.** `runSerializedPairTask(pairId, task)`
  uses a `pairLocks` map to prevent concurrent predictions for the
  same pair. Queuing a second task while one is running is safe —
  the queued task will run after the current finishes.
- **Prediction cap matters.** Above `FULL_MATRIX_MAX_LANES = 15`
  lanes the service falls back to prefilter mode, which computes a
  cheap overlap heuristic first and only runs merge-tree for
  likely-conflicting pairs. Expect `truncated: true` and
  `strategy: "prefilter-overlap"` in assessment metadata.
- **Stale predictions are still returned.** Callers see the
  `lastPredictedAt` field; the UI decides to annotate rather than
  re-fetch. For a guaranteed-fresh result, call `runPrediction`
  with the specific lane id.
- **`git merge-tree` exit 128** is treated as blocked, not clean.
  Don't interpret a fatal git error as "no conflicts."
- **Insufficient-context guard.** AI proposals refuse to emit
  speculative patches when required file context is incomplete.
  They return `insufficientContext: true` with
  `insufficientReasons[]` rather than a best-guess patch.
- **Queue-aware rebase overrides.** `resolveQueueRebaseOverride`
  must run before comparing against `base_ref`. Without it, queued
  PRs will appear misaligned relative to their queue's tracking
  branch.
- **Pack root dir resolution.** `conflictPacksDir` may be injected
  for tests; the derived `packsRootDir` is the parent of that path
  if injected, otherwise `resolveAdeLayout(projectRoot).packsDir`.
  Don't hardcode the artifact directory.
