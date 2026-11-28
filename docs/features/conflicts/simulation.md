# Merge simulation and resolution

One-shot merge simulation and AI resolution proposals live beside detection in
`apps/desktop/src/main/services/conflicts/conflictService.ts`.

## One-shot merge simulation

`simulateMerge({ laneAId, laneBId? })` returns a `MergeSimulationResult`
(`outcome: "clean" | "conflict" | "error"`, `mergedFiles`, `conflictingFiles`
with markers, `diffStat`, `error?`):

1. Read lane A's HEAD; lane B's HEAD, or the base branch head from the project root when no `laneBId`.
2. `git merge-base`, then `runGitMergeTree` (60 s timeout).
3. Numstat both sides; `mergedFiles` is the union of touched files, overlap the intersection.
4. `buildConflictFiles`: merge-tree conflicts first, overlap-only paths as `content`.
5. Any conflict → `conflict`; none and exit 0 → `clean`; otherwise `error` with git's stderr.

Reached only through the `conflicts.simulateMerge` runtime action and the CTO
`simulateMerge` tool; the renderer has no bridge for it.

## AI resolution proposal

**Prepare** (`prepareProposal`) builds the context: lite lane exports for the
lane and peer, the `ConflictExportStandard` for the pack, and a
`conflictJobContext` with freshness metadata. Missing
`relevantFilesForConflict[]` or `fileContexts[]` sets `insufficientContext:
true` with `insufficientReasons[]`. Secrets are redacted (`redactSecretsDeep`).
The `ConflictProposalPreview` is cached in memory by the context's SHA-256
digest for 20 minutes (`PREPARED_TTL_MS`).

**Request** (`requestProposal`) needs that digest: a missing or expired context
throws "Prepare a fresh preview before requesting AI." Insufficient context
records a failed proposal and dispatches nothing. Otherwise it calls
`aiIntegrationService` with the Conflict Proposals model chosen in Settings
(none chosen: "Choose a Conflict Proposals model in Settings."), then stores a
`conflict_proposals` row (`source`, `confidence`, `explanation`, `diff_patch`,
`status: 'pending'`). The answer must be JSON with `explanation`, `confidence`
(0..1) and `diffPatch` (empty when a safe patch is not possible), parsed
defensively (`parseStructuredObject`, `extractDiffPatchFromText`).

**Apply** (`applyProposal({ proposalId, mode, message? })`): `unstaged`,
`staged` (`--index`) or `commit`, always with `git apply --3way` so partial
conflicts become markers. Each apply records an operation with pre/post HEAD.
**Undo** (`undoProposal`) runs `git apply -R` on the stored patch, records
`conflict-proposal-undo`, and marks the proposal `rejected`. Patches live in
`<worktree>/.ade/tmp/conflict-proposals/` and are deleted after apply or undo.

## Configuration

`ai.conflictResolution` in project config (`changeTarget`: target | source |
ai_decides; `postResolution`: unstaged | staged | commit; `prBehavior`:
do_nothing | open_pr | add_to_existing; `autoApplyThreshold`, default 0.85;
`autonomy`: propose_only | auto_apply), read by `readConflictResolutionConfig`.

## Gotchas

- **Context completeness is strict**: partial context blocks the dispatch.
- **Patch files can accumulate** in `.ade/tmp/conflict-proposals/` for proposals neither applied nor rejected.
- **The prepared preview expires after 20 minutes**; the caller must prepare again.
