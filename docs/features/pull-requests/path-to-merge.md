# Path to Merge orchestrator

Path to Merge (PtM) drives a PR through CI, review, and merge in one
self-pacing loop instead of forcing the operator to babysit each round.
It is a native TypeScript port of the `/shipLane` Claude skill state
machine — `apps/.claude/commands/shipLane.md` is the source of truth for
the phase delays, terminal-state gate, conflict-strategy switch, and
force-finalize semantics; this implementation mirrors them in-process so
the **active ADE runtime** (local daemon for local-bound windows,
SSH-attached remote runtime for remote-bound windows) can run several
PtM loops in parallel without spawning agents per phase. For
remote-bound windows the loop runs on the remote machine — the merge
ladder, gh CLI invocations, and resolver agent dispatches all execute
on the remote host.

Source: `apps/desktop/src/main/services/prs/pathToMergeOrchestrator.ts`
(used by the runtime daemon and the desktop fallback IPC path alike).

## Wiring and lifecycle

`createPathToMergeOrchestrator(deps)` is built once during runtime
daemon boot (and during desktop main-process boot for the fallback
path) alongside the rest of the PR services. Right after construction,
`setImmediate(() => resumeFromPersistedState())` rearms any loops that
were live when the runtime last shut down. The orchestrator is exposed
to renderer code through two IPCs — preload's `window.ade.prs.pathToMerge.*`
routes through `callProjectRuntimeActionOr("pr", …)` first and falls
back to the legacy `services/ipc/registerIpc.ts` handlers when no
runtime is bound:

| Channel | Purpose |
|---------|---------|
| `ade.prs.pathToMerge.start` | Start (or restart) PtM for a PR. Persists the run args, flips convergence runtime to `launching`/`scheduled`, and kicks the loop via `setImmediate` so the user sees activity right away. |
| `ade.prs.pathToMerge.stop` | Cancel any pending wake-up, interrupt the active fix-agent session if one is running, and persist `status: stopped` / `pollerStatus: stopped` / `autoConvergeEnabled: false`. |

Both channels reject if the orchestrator is not present in the active
`AppContext` (the only such build is the headless test harness).

The orchestrator stores three pieces of state:

- **Persisted, in `pr_convergence_state`** — `ConvergenceRuntimeState`
  (`status`, `pollerStatus`, `currentRound`, `activeSessionId`,
  `pauseReason`, `errorMessage`, timestamps). Same row the manual
  convergence panel reads.
- **Persisted, in `pr_convergence_state.ptm_args_json`** — the
  `StartPathToMergeArgs` (`modelId`, `reasoning`, `scope`,
  `additionalInstructions`). Persisted so a desktop restart can rehydrate
  the original launch options instead of pausing on "No modelId
  available". Cleared by `stopPathToMerge`.
- **In-process only** —
  - `timersByPrId: Map<prId, NodeJS.Timeout>` so wake-ups can be
    cancelled deterministically on stop or reschedule.
  - `iterationInFlight: Map<prId, boolean>` to guard against external
    pokes during an iteration.
  - `inProcessState: Map<prId, { forceFinalizeUsed, runArgs }>`. The
    bonus-iteration consumed flag is reconstructed across restarts from
    `pauseReason === "force-finalize"` because `currentRound > maxRounds`
    is unreliable (the round counter does not advance when an iteration
    finds no new inventory items).

## Phase delays

`PHASE_DELAY_SECONDS` mirrors `/shipLane` §5.3 exactly:

| Kind | Seconds | When |
|------|---------|------|
| `justPushed` | 270 (~4.5 min) | A fix commit was just pushed; let CI start churning before re-evaluating. |
| `warming` | 720 (~12 min) | One of CI / review is still pending; reschedule and re-check the terminal-state gate. |
| `waitingOnReview` | 1800 (30 min) | Everything else is settled, parked waiting on a human / bot reviewer signal. |

Each `schedule(prId, kind)` call clears any prior timer for the same PR
and stores a fresh `setTimeout` handle in `timersByPrId`.

## Iteration body

`runIteration(prId)` is reentry-safe via `iterationInFlight`. The loop
is:

1. **Reload context** — refresh PR state via `prService.refresh`,
   reload the row + pipeline settings + runtime. Early-exit on
   `merged` (terminal) or `closed` (paused) states.
2. **Base-advance conflict check** — if `behindBaseBy > 0` (read
   once via `prService.getStatus`), run
   `applyConflictStrategy(ctx, "base_advance")`. The strategy switch
   is below; failure pauses the loop, success continues.
3. **Early merge on green** — when
   `pipelineSettings.earlyMergeOnGreen` (default `true`) and checks
   are passing and review is clean, run the merge ladder. If
   `pipelineSettings.autoMerge` is false, park as `converged` instead
   of landing.
4. **Terminal-state gate** — `isTerminalForFixPush(pr)` requires
   *both* checks (`passing | failing | none`) and review
   (`approved | changes_requested | none`) to be terminal before
   pushing more fixes. Pushing on a partial signal causes review-bot
   thrash, so non-terminal gates schedule `warming` and exit.
5. **Hard cap and force-finalize** — when
   `runtime.currentRound >= maxRounds`, consult
   `pipelineSettings.forceFinalizeMode`:
   - `off` → pause with "Hard cap reached".
   - `unconditional` → run a bonus iteration that ignores review.
   - `conditional` → run a bonus iteration only if
     `forceFinalizeRequireNoCiFailures` is satisfied (no failing
     checks).

   The bonus iteration is consumed by the merge-ladder attempt in step
   7, not by a fix dispatch — otherwise force-finalize would degrade
   to "one extra fix iteration, then pause" and never actually retry
   the merge once the agent's fix turned CI green.
6. **Fix-agent dispatch** — unless force-finalize already has CI green,
   call `launchPrIssueResolutionChat` with the persisted scope (or
   `"checks"` during force-finalize) and the resolved
   `modelId` / `reasoning`. Before dispatching, the loop verifies the
   prior session is no longer active via
   `agentChatService.getSessionSummary` — two fix agents racing on the
   same worktree corrupts pushes. After dispatch, schedule
   `justPushed`.
7. **Force-finalize merge ladder** — when force-finalize fired with CI
   already green, skip the dispatch and run the merge ladder
   immediately. `forceFinalizeUsed` is set to `true` so the next hard
   cap check pauses with "force-finalize already attempted".

A merged observation (e.g. `gh pr merge --auto` landed between
iterations) is handled at the top of the iteration body: `runPostMergeCleanup`
runs and the runtime flips to `merged` / `stopped`.

## Conflict strategy

`applyConflictStrategy(ctx, kind)` runs at two sites: at the top of each
iteration as a base-advance sync (`base_advance`) and when the merge
ladder reports a conflict (`merge_time`). The behavior switches on
`pipelineSettings.conflictStrategy`:

| Strategy | Behavior |
|----------|----------|
| `pause` | Mark the loop paused with `Conflict (kind): paused per pipeline settings.` |
| `rebase` | `git fetch origin <base>` then `git rebase origin/<base>` then `git push --force-with-lease origin HEAD:<branch>`. Aborts the rebase on failure so the worktree is not left half-rebased. |
| `merge` | `git merge --no-edit origin/<base>` then `git push origin HEAD:<branch>`. Aborts on conflict. |
| `auto` | `conflictService.runExternalResolver` with the configured `autoAgentSettings` (provider / model / reasoningEffort / permissionMode). The resolver agent reads the worktree, picks rebase vs merge, and resolves any marker-style conflicts itself. |

The legacy `pipelineSettings.onRebaseNeeded` (`pause | auto_rebase`) is
projected to/from the 4-option strategy via
`conflictStrategyFromLegacyRebasePolicy` /
`legacyRebasePolicyFromConflictStrategy` so older settings rows continue
to work and queue auto-resolve callers that still read the legacy field
keep functioning.

## Merge ladder

`runMergeLadder(ctx)` is the rung sequence used by both early-merge and
force-finalize paths:

1. **REST** — `prService.land({ prId, method, archiveLane: false })`
   with the merge method resolved by `resolveMergeMethod` (defaults to
   `squash` when settings are `repo_default`, since GitHub's REST
   merge API requires an explicit method). On success the existing
   post-merge cleanup pipeline runs inside `prService.land`.
2. **`gh pr merge --admin`** — when the REST call fails for a
   non-conflict reason (typically a branch-protection block the
   operator has admin override for). On success the orchestrator
   explicitly invokes `prService.runPostMergeCleanup` because gh CLI
   does not run the cleanup pipeline itself.
3. **`gh pr merge --auto`** — only attempted when
   `pipelineSettings.autoMerge` is true. This **arms** GitHub
   auto-merge; the PR has not actually landed. The orchestrator parks
   the loop with `pollerStatus: waiting_for_checks` and re-polls
   `pr.state` on each subsequent wake; cleanup runs when the merge
   observation lands.

Conflict detection on the REST rung is substring-based on the error
message (`/conflict|409/i`); a conflict short-circuits the ladder so
the caller can run the merge-time conflict strategy and retry.

`gh pr merge` is invoked **without** `--delete-branch`. Per shipLane
line 212, `--delete-branch` would conflict with the project-root
worktree on `main`; branch deletion is delegated to
`prService.runPostMergeCleanup` so it goes through the same path as the
REST flow.

## Conflict resolver provider

The `auto` strategy uses `conflictService.runExternalResolver` with
`originSurface: "rebase"` and
`originLabel: "path-to-merge:<base_advance|merge_time>:pr=<num>"`. There
is no dedicated `path-to-merge` origin yet; `rebase` is the closest
existing surface (worktree-local base sync), which is exactly what the
PtM loop is asking the resolver to do.

`pipelineSettings.autoAgentSettings.provider` must be set when
`conflictStrategy === "auto"`; the loop pauses with a clear error
otherwise.

## Persistence and resume

`resumeFromPersistedState()` runs on runtime daemon boot (and on
desktop main-process boot for the fallback path). It iterates every PR
via `prService.listAll()` and rearms a `warming`-phase wake-up for any
whose convergence runtime is still flagged as live
(`autoConvergeEnabled === true`,
`pollerStatus !== "stopped"`,
`status !∈ {merged, stopped, cancelled}`). The warming delay is chosen
intentionally — it is long enough that any push-driven CI churn from
before the restart has settled, so the first iteration after resume
sees a stable state.

The `pr_convergence_state.ptm_args_json` column (added in the same
migration as the other PtM-aware pipeline columns) carries the
`StartPathToMergeArgs` JSON. Resume rehydrates `modelId`, `reasoning`,
`scope`, and `additionalInstructions` from this column; absence of the
column or an unparseable payload falls back to `scope: "both"` and
null model overrides (the dispatch then uses `defaultModelId` from
deps).

## Pipeline settings columns

`pr_pipeline_settings` gained eight columns to back the new behavior
(see `apps/desktop/src/main/services/state/kvDb.ts`):

| Column | Type | Default | Maps to |
|--------|------|---------|---------|
| `conflict_strategy` | text | `'pause'` | `PipelineSettings.conflictStrategy` |
| `force_finalize_mode` | text | `'off'` | `PipelineSettings.forceFinalizeMode` |
| `force_finalize_require_no_ci_failures` | int | `1` | `PipelineSettings.forceFinalizeRequireNoCiFailures` |
| `early_merge_on_green` | int | `1` | `PipelineSettings.earlyMergeOnGreen` |
| `auto_agent_provider` | text | null | `autoAgentSettings.provider` |
| `auto_agent_model` | text | null | `autoAgentSettings.model` |
| `auto_agent_reasoning_effort` | text | null | `autoAgentSettings.reasoningEffort` |
| `auto_agent_permission_mode` | text | null | `autoAgentSettings.permissionMode` |
| `auto_agent_confidence_threshold` | real | null | `autoAgentSettings.confidenceThreshold` |

All eight are added via `try { db.run("alter table … add column …") } catch {}`
so existing DBs upgrade in place; the legacy `on_rebase_needed` column
stays for back-compat reads.

`DEFAULT_PIPELINE_SETTINGS` (in `apps/desktop/src/shared/types/prs.ts`)
is the single source of truth for new-row defaults.

## Renderer surface

Two main consumers drive the orchestrator from the UI:

- `renderer/components/prs/shared/PrPipelineSettings.tsx` — per-PR
  pipeline settings editor used inside `PrConvergencePanel`. Surfaces
  the 4-option `conflictStrategy` selector, the `auto`-only
  `autoAgentSettings` group (provider / model / reasoning /
  permission mode / confidence threshold), the `forceFinalizeMode`
  selector with the conditional sub-toggle, and the
  `earlyMergeOnGreen` switch. When `conflictStrategy` is `rebase` or
  `auto`, the panel renders a force-push-warning chip.
- `renderer/components/prs/shared/PrConvergencePanel.tsx` — the
  Path-to-Merge panel itself. Status copy uses "Path to Merge" verbatim
  ("Agent working on Path to Merge…", "Ready to launch another Path to
  Merge run", "Path to Merge is frozen for terminal PRs"). The
  convergence sub-tab on `PrDetailPane` is labelled "Path to Merge" so
  the surface name matches the orchestrator.
- `renderer/components/prs/tabs/QueueAutomateMergingModal.tsx` — the
  Queue tab's "Automate Merging" entry point. The modal applies one
  `PipelineSettings` config to every queue member, then for each member
  in queue order: saves settings, retargets the base branch to the
  queue's tracking branch (skipping position 0 — the first PR keeps its
  original base), starts PtM via `pathToMergeStart`, and polls
  `convergenceStateGet` every 4 s until the runtime status reaches a
  terminal value (`merged` is success;
  `failed | cancelled | stopped` halts the sequence). Closing the modal
  mid-sequence stops dispatching new starts but leaves already-launched
  orchestrators running.

The IPC bridge for the modal also adds `ade.prs.retargetBase` (PR id +
base branch), which is what re-points each non-leading queue PR at the
chain base before PtM picks it up.

## Differences from `/shipLane`

`/shipLane` relies on Claude Code's `TeamCreate` primitive to run a
poll-agent + fix-agent + rebase-agent in parallel. ADE has no
equivalent, so each iteration here dispatches a **single fix agent**
through `launchPrIssueResolutionChat`; that agent decides internally
whether to fix CI, review comments, or both. The shipLane Phase 0
`automate-agent` / `finalize-agent` are also unimplemented — the
orchestrator assumes the PR already exists and PR creation is the
caller's responsibility (the Queue Automate Merging modal handles this
for stack flows, since each queue member is already a PR).

Wake-up delays, the combined CI + review terminal gate (line 206), the
4-option conflict strategy switch, the merge ladder rung sequence
(REST → admin → auto), and the force-finalize predicate (lines
183–198) all match `/shipLane` exactly.

## Gotchas

- **Never pass `--delete-branch` to gh.** Branch deletion goes through
  `prService.runPostMergeCleanup` so the post-merge cleanup pipeline
  (child-lane rebase, group-membership cleanup, cache invalidation,
  rebase-needs scan) actually runs. shipLane line 212 documents the
  same constraint.
- **Don't set `forceFinalizeUsed` on fix dispatch.** It is consumed by
  the merge-ladder attempt in step 7. Setting it on dispatch degrades
  force-finalize to "one extra fix iteration, then pause" instead of
  letting the fix run and retrying the ladder once CI flips green.
- **Terminal-state gate must consider *both* signals.** Pushing on a
  partial signal (e.g. CI passing but review still pending) makes
  review bots churn on every commit; the orchestrator will explicitly
  schedule `warming` and exit instead of dispatching a fix.
- **Conflict detection on the REST rung is substring-based** (`conflict`
  or `409`). Changing the wording GitHub returns silently disables the
  conflict short-circuit and the loop will treat conflicts as generic
  failures.
- **`forceFinalizeUsed` rehydration uses `pauseReason`.** Step 5 writes
  `pauseReason: "force-finalize"` *before* dispatching the bonus
  iteration. `currentRound > maxRounds` would not survive restarts
  reliably because the round counter does not advance when no new
  inventory items are produced.
- **`auto` conflict strategy needs an explicit provider.** A null
  `autoAgentSettings.provider` pauses the loop with a clear error —
  ship a UI guard before saving the strategy if surface design changes.
- **Resume uses the `warming` delay deliberately.** After a desktop
  restart, kicking the loop on `justPushed` would retry while CI
  state from a stale push is still propagating; `warming` lets the
  state stabilise before the first post-resume iteration.
