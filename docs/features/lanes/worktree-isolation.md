# Worktree isolation

Every non-primary lane lives in its own git worktree. This is the
mechanism that lets ADE hold dozens of branches checked out
simultaneously without thrashing a single working directory.

Worktree creation, removal, and the `git worktree …` shell-outs that
back them are owned by the **active ADE runtime** — the local machine runtime
(`ade serve`) for local-bound windows, or the SSH-attached remote
runtime for remote-bound windows. The desktop main process exposes
`apps/desktop/src/main/services/lanes/laneService.ts` as a fallback
target with the same interface so older callers and tests keep
working, but the canonical lifecycle lives in the ADE runtime.
Remote-bound windows therefore create worktrees on the remote
machine: the desktop UX is identical, but the worktree directory,
the per-lane state, and every git command for the lane all live on
the remote host.

## Worktree placement

Managed (ADE-created) worktrees live under `.ade/worktrees/<slug>/` at
the repo root. The slug is produced by `slugify(laneName)` inside
`laneService.ts`:

```
name → lower-cased → [^a-z0-9]+ replaced by "-" → trim leading/trailing "-"
empty → "lane"
```

Collisions are resolved by suffixing `-2`, `-3`, … until unique. The
final directory is stored as an absolute path in
`lanes.worktree_path`.

A worktree the user created themselves keeps whatever path they put it at.
Nothing relocates it, and nothing needs to: adoption records the path as-is and
every lane rail works from `lanes.worktree_path`. Rows left over from the
removed attach flow (`lane_type = 'attached'`, with the external root in
`attached_root_path`) are ordinary lanes now — including on delete, which
removes their worktree like any other. What ADE may remove is decided by the
path, never by the lane type; see
[Deleting a worktree](#deleting-a-worktree).

Primary lanes reuse the repo root itself (no worktree creation); their
`worktree_path` equals the repo root.

## Creating a worktree

`laneService.create()` sequence for `lane_type = 'worktree'`:

1. Resolve `baseRef`. If `parentLaneId` is provided, default to the
   parent's `branch_ref`; otherwise caller-supplied or the project's
   default branch.
2. `normalizeBranchName(baseRef)` — strips `refs/heads/`, `refs/remotes/`,
   `origin/` prefixes (shared helper in `shared/laneBaseResolution.ts`).
3. Build the target worktree path under `.ade/worktrees/<slug>` with
   collision suffixing.
4. Run `git worktree add -b <branch> <worktree-path> <baseRef>` via
   `runGitOrThrow`. This creates the new branch and checks it out
   into the new worktree in one step.
5. Insert the `lanes` row with `lane_type = 'worktree'`,
   `is_edit_protected = 0`, `status = 'active'`.
6. Compute initial `LaneStatus`.
7. Return `LaneSummary`.

Failure modes handled inline:

- `git worktree add` fails (branch already exists, path exists, base
  ref invalid) → no row inserted, error propagated to the IPC caller.
- SQLite insert fails after worktree creation → worktree is torn down
  (`git worktree remove --force`) to avoid orphaned directories.

## Worktrees you created yourself

There is no attach step. Every git worktree of the repository is a lane:
`lanes.list()` reconciles against `git worktree list` on each call, adopting
any registered worktree that no lane row claims yet
(`recoverManagedWorktreeRows`) and dropping any lane row whose worktree is
gone from both git and disk (`removeVanishedWorktreeLanes`). A worktree you
made with `git worktree add` anywhere on disk shows up as a `worktree` lane
with no user action, and one you remove outside ADE stops being a lane.

The `attach()` and `adoptAttached()` APIs are gone, along with the
`attached` lane type as something anything creates. Rows that already carry
`lane_type = 'attached'` are left alone and behave exactly like `worktree`
lanes — including delete, which removes the worktree for them too. See
[Lane types](./README.md#lane-types).

Adoption is scoped to the project that owns the worktree. When the project
root is itself a linked worktree (opened with "Open as a separate project
instead", or grandfathered in), `git worktree list` reports the whole
repository — the main checkout and every sibling project's worktree. In that
case ADE adopts only worktrees under this project's own `.ade/worktrees`, and
the vanished-row reap likewise ignores rows whose path lies outside it, so one
project can never adopt, delete, or reap another's lanes.

## Deleting a worktree

`laneService.delete()` runs a multi-step teardown rather than deleting
the directory first:

1. Fetch the row; reject if `is_edit_protected = 1` (primary).
2. Check worktree dirtiness only when the saved path still resolves to
   that exact Git worktree root. If the directory is missing, or a stale
   path under the repo now resolves to the primary checkout, ADE treats
   the lane as stale instead of reading the primary worktree's status.
3. Cancel auto-rebase and dismiss rebase suggestions for the lane.
4. Stop PTYs and file watchers for the lane,
   then run any lane-environment cleanup supplied by the runtime.
5. Enter the shared worktree-mutation guard and run
   `git worktree remove --force <path>`. This runs for **every** lane that has
   a worktree, wherever it lives — there is no lane type that opts out. What
   differs is the fallback. Inside `.ade/worktrees`, the storage ADE owns: if
   Git reports success but residual files remain, ADE removes the directory
   with `fs.promises.rm` and runs `git worktree prune` before continuing; if
   Git already considers the path unregistered, ADE still prunes the registry
   and attempts manual residual cleanup; and if manual cleanup or prune fails,
   the delete completes with warnings so the stale row and lane-owned metadata
   are still removed, with the warning naming what could not be cleaned up.
   Failed residual-directory cleanup is recorded in the machine-local
   `local_worktree_residual_cleanups` table so later `lanes.list` calls can
   retry it. Outside `.ade/worktrees` there is no filesystem fallback and
   nothing is queued: if git refuses, the git error is the delete failure, and
   ADE's own `rm` never touches files it did not create.
6. If caller requested `deleteBranch`: `git branch -D <branch>`.
   Optional remote branch cleanup uses `git push <remote> --delete
   <branch>` and is non-fatal.
7. Collect lane-owned proof paths while chat/lane ownership rows still exist,
   resolving each through the realpath-confined `.ade/artifacts` jail. Remove
   the stored files, remove lane pack artifacts, and delete the lane's database
   rows in one transaction. An artifact belongs to the lane through
   `computer_use_artifacts.lane_id` or a legacy explicit lane link; an artifact
   also owned by a chat in another lane is preserved. Archive does none of this.
   Stale state in `key_value`, `operations`, `sessions`, etc. that references
   the lane is either cascaded (via FK ON DELETE) or retained for audit as
   documented on each table.

Independent lane deletes can run through the pre-removal teardown at
the same time. The shared guard is scoped to the actual
`git worktree remove` registry mutation, which prevents concurrent
Git worktree metadata edits without making lane creation wait for
unrelated process, PTY, watcher, or environment cleanup.

A worktree that has been manually removed from disk does not leave a row
behind: the `lanes.list` reconcile reaps it (`removeVanishedWorktreeLanes`,
described under [Worktrees you created yourself](#worktrees-you-created-yourself))
once both git and the filesystem agree it is gone. There is no separate
startup repair for it, and no user action.
Status/read paths also verify the saved `worktree_path` with
`git rev-parse --path-format=absolute --show-toplevel` before running
lane-local Git reads. When the top-level is missing or differs from
the saved path, ADE returns the default clean lane status and avoids
probing `git status`, branch detection, stashes, or change inspection
from the wrong checkout.

## Residual cleanup retry sweep

`worktreeResidualCleanup.ts` is the safety net for managed worktree
directories that survive a delete after the lane row and lane-owned
metadata are gone. The cleanup debt is local machine state, not project
state: `local_worktree_residual_cleanups` stores absolute paths, is
excluded from CRR replication, and is only interpreted by the runtime
that owns those paths.

The sweep runs from `laneService.list()` with a short TTL so normal lane
refreshes can clear previous warnings without a dedicated user action.
Before removing anything it rebuilds three guard sets:

- registered non-bare paths from `git worktree list --porcelain`
- `lanes.worktree_path` values still present for the current project,
  including archived lanes
- paths currently being created by an in-flight lane create

Only direct children of the managed `.ade/worktrees/` directory are
eligible. Unsafe records are dropped, registered Git worktrees and
active lane paths are skipped, and pending creations are left alone.
Recorded delete failures are retried until they disappear or the row is
cleared. Unknown directories under `.ade/worktrees/` are removed only
when they are empty, contain no files or symlinks, and are old enough
to avoid racing a create; unknown non-empty directories are treated as
user data and left in place.

## Per-lane state directories

Lanes store lane-local artifacts under a few conventions:

| Path | Contents |
|------|----------|
| `<worktree>/.ade/tmp/conflict-proposals/` | Scratch patch files from AI conflict proposals |
| `.ade/artifacts/packs/conflicts/v2/<laneId>__<peerKey>.md` | Conflict pack v2 markdown for a lane/peer pair (repo-root-relative) |
| `.ade/artifacts/packs/conflicts/predictions/<laneId>.json` | Prediction summary packs |
| `.ade/artifacts/packs/external-resolver-runs/<runId>/` | External CLI resolver artifacts |

Lane-level environment, port lease, and proxy route state is
persisted in the SQLite KV/tables, not on disk.

## Worktree interactions with git operations

All git commands run inside the active runtime — not in the Electron
main process — with `cwd` pinned to the lane's `worktree_path`. The
runtime spawns `git` directly on the host that owns the worktree
(local runtime spawns on the desktop machine; the remote runtime spawns
on the remote machine over SSH). The desktop fallback path uses
`apps/desktop/src/main/services/git/git.ts` (same shell-out shape) so
the legacy IPC handlers behave identically when the runtime is not
present. This matters because:

- Stashes, rebases, merges, and cherry-picks are worktree-local —
  nothing bleeds into other lanes.
- Before mutating a lane or reading history/diff metadata for a lane,
  `gitOperationsService` validates that `worktree_path` is still the
  Git top-level for that lane. A stale path that now resolves to the
  primary repo checkout is treated as a missing lane worktree, so ADE
  does not stage, commit, generate commit messages, list commits,
  inspect branches/stashes/conflicts, or compute sync state from the
  wrong worktree.
- `git worktree` detects in-progress merge/rebase state via files in
  the worktree's gitdir (`rebase-apply/`, `rebase-merge/`,
  `MERGE_HEAD`). `detectConflictKind` in
  `src/main/services/git/gitConflictState.ts` inspects these to
  populate `GitConflictState` for conflict UI.
- Deleting a worktree while it has an in-progress merge or rebase
  requires `--force`. `laneService.deleteLane` always forces because
  the user asked for the delete explicitly.

## Process, port, proxy, and OAuth isolation

Runtime isolation (Phase 5) extends worktree-level isolation with:

- **Ports**: each lane gets a non-overlapping lease range
  (`portAllocationService`). Lane 0 → 3000–3099, lane 1 → 3100–3199,
  etc.
- **Proxy hostname**: `<slug>.localhost:<proxyPort>` routes browser
  traffic to the lane's dev server via `laneProxyService`. Cookies
  are naturally isolated per hostname.
- **OAuth callbacks**: `oauthRedirectService` routes a single callback
  URL back to the correct lane using an HMAC-signed state parameter.
  See [`oauth-redirect.md`](./oauth-redirect.md).
- **Environment**: env files, docker services, dependencies, and
  mount points are initialized per lane via `laneEnvironmentService`.
  See [`runtime.md`](./runtime.md).

Together these make a lane a complete isolation unit: not just a
worktree, but a full parallel development environment.

## Gotchas

- **Symlinks**: `laneEnvironmentService` validates all copy-path and
  mount-point operations with symlink-aware `resolvePathWithinRoot`
  to prevent escaping the worktree via symlink ladders.
- **Git lock files**: a stray `.git/index.lock` in one worktree can
  block operations in that lane but not others. ADE does not auto-
  remove stale locks — users must.
- **Stopping a running dev server on delete**: lane-owned PTYs and
  watchers are stopped before worktree removal, but processes
  that were launched outside ADE may still hold file handles or keep a
  port alive briefly. The delete pipeline recovers residual files after
  a successful `git worktree remove` and runtime diagnostics may lag
  until the external process exits.
- **Renaming a worktree directory outside ADE strands the lane**: lane rows
  store the absolute path the worktree was created or adopted at, and the
  reconcile does not repair a moved one. Git keeps listing the old path (as
  prunable), which is enough to stop the reap — it removes a row only when the
  path is absent from `git worktree list` *and* gone from disk — while the new
  path is not registered with git at all, so nothing adopts it either. The lane
  survives pointing at a directory that no longer exists and every git command
  for it fails. Recovery is `git worktree repair` or removing and re-adding the
  worktree, not anything in ADE.
- **Git reports realpaths, ADE stores the user's spelling**: every path
  comparison in the reconcile, the residual sweep, and the delete rails is done
  in realpath space, because `/tmp` versus `/private/tmp` is enough to make one
  directory look like two. A new code path that compares a lane path against
  git output must canonicalize both sides or it will silently double-adopt and
  falsely reap.
- **Primary worktree == repo root**. Operations that would destroy
  the repo root (delete) are blocked by the edit-protected flag.
  Operations that would clobber the primary's uncommitted changes
  (e.g., `createFromUnstaged` from primary) are guarded by
  precondition checks inside the relevant method.
