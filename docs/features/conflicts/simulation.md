# Merge simulation and resolution

Pre-flight conflict checking, one-shot merge simulation, AI
resolution proposals, and external CLI resolver runs all live
alongside detection in
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

- Graph edge click → inline conflict panel → `simulateMerge`.
- Lane detail → merge simulation panel.
- Integration tab → per-pair simulation (via `prService.simulateIntegration`,
  not `conflictService.simulateMerge`).

## Chained simulation

`simulateChainedMerge` covers multi-lane sequential merges (the
merge-plan flow). For each step in stack-depth order:

1. Simulate the merge of the current source onto the running
   chain state.
2. If clean, apply it to an in-memory chain tree and continue.
3. If conflicted, stop and report the blocked step.

This feeds the Integration tab's merge plan view where the user sees
"lanes 1-3 merge cleanly; lane 4 conflicts with lane 2."

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
   which calls `AgentExecutor.execute()` with the Claude CLI by
   default (`sonnet`, read-only permissions, 60 s timeout).
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

## External CLI resolver

`runExternalResolver(args)` runs a Codex / Claude CLI session in the
target lane's worktree (single-source) or a dedicated integration
lane (multi-source). Resolution happens interactively; the resolver
runs with full repo access and produces changes that ADE then
commits via the explicit `commitExternalResolverRun` step.

### CWD policy

- **Single source lane** (`sourceLaneIds.length === 1`): cwd =
  source lane's worktree.
- **Multi-source integration merge** (`sourceLaneIds.length > 1`):
  cwd = integration lane's worktree. The integration lane is
  created automatically via `ensureIntegrationLane` if not
  supplied.
- **Explicit override**: caller may pass `cwdLaneId` to force a
  specific worktree.

Scenario is recorded as `ResolverSessionScenario`:
`"single-merge" | "integration-merge"`.

### Execution

1. `prepareResolverSession(...)` — builds prompt, conflict
   context, picks model/reasoning effort/permission mode, writes
   the initial `ExternalResolverRunRecord` to
   `<packsRoot>/external-resolver-runs/<runId>/run.json`.
2. Command template resolution via
   `resolveExternalResolverCommand(provider)`. Templates support
   `{{promptFile}}`, `{{projectRoot}}`, `{{targetLaneId}}`,
   `{{sourceLaneIds}}`, `{{runDir}}` placeholders.
3. Spawn the CLI with:
   - `cwd: cwdLane.worktreePath`
   - `stdio: ["ignore", "pipe", "pipe"]`
   - `timeout: 8 * 60_000` (8 min)
   - 8 MB stdout/stderr caps per stream.
4. Write `output.log` with combined stdout + stderr.
5. Capture changes via `git diff --binary` (32 MB cap). Write to
   `changes.patch` if non-empty.
6. Update the run record with `status`, `completedAt`, `command`,
   `changedFiles`, `summary`, `patchPath`, `logPath`, `warnings`,
   `error`.

### Insufficient-context guard

If context validation fails at prepare time, the run is recorded
as `status: "blocked"` with `warnings` like
`missing_context:<repoRelativePath>`. The runner short-circuits
without spawning the CLI. This prevents speculative patches in
situations where ADE knows it's missing required file content.

### Commit workflow

`commitExternalResolverRun({ runId, message? })`:

1. Re-read the run record; reject if not `completed`, if already
   committed, or if no patch artifact exists.
2. Read the patch body and extract touched paths via
   `extractCommitPathsFromUnifiedDiff`.
3. Normalize paths to repo-relative via `ensureRelativeRepoPath`.
4. `git add -- <paths>` + `git commit -m <message> -- <paths>`.
5. Read the resulting `commitSha` and persist
   `committedAt` / `commitSha` / `commitMessage` on the run record.

Commit message defaults to
`"Resolve conflicts via ADE <provider> external resolver"`.

### Session tracking

When `sessionService` is wired in, the resolver can surface inside
the Sessions surface and the terminal modal
(`renderer/components/shared/conflictResolver/ResolverTerminalModal.tsx`).
`attachResolverSession`, `finalizeResolverSession`, and
`cancelResolverSession` bridge between the run record and session
state.

### Suggesting a target

`suggestResolverTarget(args)` picks a reasonable default target
lane for the UI given the scenario:

- Single-source: the source lane.
- Multi-source: heuristic prefers existing integration lanes over
  creating a new one; ties break by most recently touched.

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
`projectConfigService`.

## Gotchas

- **Context completeness is strict.** Both
  `relevantFilesForConflict[]` and `fileContexts[]` must be present
  and non-empty to dispatch. Partial context blocks the run.
- **External resolver runs are not transactional.** The CLI may
  complete partial work even when reporting `status !== 0`. The
  commit workflow is a separate explicit step so the user can
  review before committing.
- **Patch files accumulate on disk** under
  `<worktree>/.ade/tmp/conflict-proposals/` if proposals are neither
  applied nor rejected. `deletePatchFile` runs after apply/undo.
  Consider adding a sweep for orphaned patches in long-running
  projects.
- **`git diff --binary` can produce huge output.** The 32 MB cap is
  a hard stop; warnings `git_diff_stdout_truncated` /
  `git_diff_stderr_truncated` flag truncation so the UI can warn.
- **Provider-specific command templates** come from
  `projectConfigService` and may be empty. When missing, the
  service records `resolver_command_missing_in_config` and returns
  a failed run rather than throwing.
- **Process signals** (SIGTERM, etc) are recorded as
  `process_signal:<signal>` warnings so postmortem debugging can
  distinguish "CLI crashed" from "CLI exited non-zero cleanly."
- **Integration lane auto-creation** happens only for multi-source
  runs. If you manually create an integration lane first and pass
  it via `cwdLaneId`, the service does not try to create a second
  one — it respects the override.
- **TTL for prepared previews (20 min)** may force re-prepare if the
  user takes too long between preview and dispatch. The dispatch
  path re-prepares transparently.
