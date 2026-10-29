# Merge simulation and resolution

Pre-flight conflict checking, one-shot merge simulation, and AI
resolution proposals all live alongside detection in
`apps/desktop/src/main/services/conflicts/conflictService.ts`.

## One-shot merge simulation

`simulateMerge({ laneAId, laneBId? })` runs a single on-demand
merge simulation and returns a `MergeSimulationResult` with
rendered conflict markers:

```ts
type MergeSimulationResult = {
  outcome: "clean" | "conflict" | "error";
  mergedFiles: string[];
  conflictingFiles: Array<{ path: string; conflictMarkers: string }>;
  diffStat: { insertions: number; deletions: number; filesChanged: number };
  error?: string;
};
```

Steps inside `simulateMerge`:

1. Look up `laneA` in the active lanes list; 404 if missing.
2. Read `laneAHead = git rev-parse HEAD` from the lane worktree.
3. If `laneBId` is provided: read `laneBHead` from lane B's
   worktree. Else: read the base branch head from the project
   root (`readHeadSha(projectRoot, laneA.baseRef)`).
4. Compute `mergeBase = git merge-base <laneAHead> <laneBHead>`.
5. Run `runGitMergeTree({ cwd: projectRoot, mergeBase, branchA,
   branchB, timeoutMs: 60_000 })`.
6. Read diff numstats for both sides and compute per-side insertions
   / deletions / files-changed sets.
7. Compute `mergedFiles` as `touchedA ∪ touchedB` and `overlapFiles`
   as their intersection.
8. Build `conflictFiles` via `buildConflictFiles(conflicts,
   overlapFiles)` — merge-tree conflicts first, overlapping-but-not-conflicting
   paths second with `conflictType: "content"`.
9. Derive `outcome` from `(conflictFiles.length, merge.exitCode)`:
   - any conflicts → `"conflict"`
   - zero conflicts + exit 0 → `"clean"`
   - otherwise → `"error"` with `merge.stderr.trim()`

Consumers:

- The `conflicts.simulateMerge` runtime action and the CTO `simulateMerge`
  tool. The desktop renderer has no bridge for it.

## AI resolution proposal

Two phases: **prepare** (build bounded context, surface a preview)
and **request** (dispatch to the provider).

### `prepareProposal(args)`

1. Compose the context envelope:
   - `LaneExportLite` for the lane
   - `LaneExportLite` for the peer (when pairwise)
   - `ConflictExportStandard` for the specific conflict pack
   - `conflictJobContext` with freshness metadata and stale policy
2. Validate that required file contexts are present
   (`relevantFilesForConflict[]` + `fileContexts[]`). If gaps are
   found, mark `insufficientContext: true` and include
   `insufficientReasons[]`.
3. Redact secrets through `redactSecretsDeep`.
4. Return a `ConflictProposalPreview` with preview files, target
   branch (for apply), confidence estimate, and provider metadata.

The preview is cached in memory under a `sha256` digest of its
serialized envelope with a 20-minute TTL (`PREPARED_TTL_MS`).
`cleanupPreparedContexts()` runs opportunistically to expire stale
entries.

### `requestProposal(args)`

1. Re-fetch the prepared context from the cache (or rebuild if
   missing).
2. Short-circuit if `insufficientContext`: record a `failed`
   proposal with explicit data-gap messaging, do not dispatch.
3. Route through `aiIntegrationService.requestConflictProposal`
   using the caller-supplied model. There is no Settings conflict-proposal
   picker.
4. Persist the result as a `conflict_proposals` row with:
   - `source: 'subscription'` or `'local'`
   - `confidence: number | null` (0.0–1.0)
   - `explanation`, `diff_patch`, `status: 'pending'`
   - `job_id`, `artifact_id`, `metadata_json`
5. Emit a `proposal-ready` event.

Logged to `ai_usage_log` for usage tracking.

### Prompt contract

Conflict prompts enforce an exact output structure:

1. `ResolutionStrategy`
2. `RelevantEvidence`
3. `Scope`
4. `Patch`
5. `Confidence`
6. `Assumptions`
7. `Unknowns`
8. `InsufficientContext`

If `InsufficientContext=true`, the `Patch` section must be empty.
`parseStructuredObject(text)` + `extractDiffPatchFromText(text)`
walk the response and guard against malformed payloads.

### Apply modes

`applyProposal({ proposalId, mode, message? })`:

- `mode: "unstaged"` — `git apply <patch>`, leave unstaged
- `mode: "staged"` — `git apply --index <patch>`, stage but don't commit
- `mode: "commit"` — `git apply --index <patch>`, then `git commit`
  with the supplied (or AI-generated) message

All paths use `git apply --3way` so partial conflicts surface as
merge markers rather than a hard failure. Each apply records an
operation with the proposal id and the pre/post HEAD SHAs so the
undo path can reverse cleanly.

### Undo

`undoProposal({ proposalId })`:

1. Look up the applied operation.
2. Run `git apply -R <patch>` against the stored patch file.
3. Record a new operation with reason `conflict-proposal-undo`.
4. Mark the proposal `status: 'rejected'`.

Patch files live at
`<worktree>/.ade/tmp/conflict-proposals/proposal-<uuid>.patch` and
are cleaned up on proposal rejection/application.

## User configuration (`local.yaml`)

Users can persist resolution preferences under
`ai.conflict_resolution`:

```yaml
ai:
  conflict_resolution:
    change_target: "ai_decides"      # target | source | ai_decides
    post_resolution: "staged"        # unstaged | staged | commit
    pr_behavior: "do_nothing"        # do_nothing | open_pr | add_to_existing
    auto_apply_threshold: 0.85       # 0.0-1.0
    autonomy: "propose_only"         # propose_only | auto_apply
```

The conflict resolution dialog reads and writes these values via
`projectConfigService`. Merge simulation runs from the lane surfaces.

## Gotchas

- **Context completeness is strict.** Both
  `relevantFilesForConflict[]` and `fileContexts[]` must be present
  and non-empty to dispatch. Partial context blocks the run.
- **Patch files accumulate on disk** under
  `<worktree>/.ade/tmp/conflict-proposals/` if proposals are neither
  applied nor rejected. `deletePatchFile` runs after apply/undo.
  Consider adding a sweep for orphaned patches in long-running
  projects.
- **TTL for prepared previews (20 min)** may force re-prepare if the
  user takes too long between preview and dispatch. The dispatch
  path re-prepares transparently.
