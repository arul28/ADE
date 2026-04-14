# Worktree isolation

Every non-primary lane lives in its own git worktree. This is the
mechanism that lets ADE hold dozens of branches checked out
simultaneously without thrashing a single working directory.

Source: `apps/desktop/src/main/services/lanes/laneService.ts`.

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

Attached lanes use the user-supplied external path (validated with
`isWithinDir` and resolved to an absolute path). `lane_type =
'attached'` and `attached_root_path` records the external root so ADE
never moves or cleans it on delete.

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

## Attaching an existing worktree

`laneService.attach()` validates that the supplied path is a git
worktree of the same repository (looks for `.git` file pointing into
the repo's `.git/worktrees/<id>/gitdir`) and stores the row without
mutating the directory. Deleting an attached lane only removes the
row; the user retains the directory.

`adoptAttached()` (via `ade.lanes.adoptAttached`) promotes an attached
lane to managed status by moving the directory under
`.ade/worktrees/`, useful when the user wants ADE to eventually
auto-clean it.

## Deleting a worktree

`laneService.deleteLane()`:

1. Fetch the row; reject if `is_edit_protected = 1` (primary).
2. If managed worktree: `git worktree remove --force <path>`. If
   attached: skip.
3. If caller requested `deleteBranch`: `git branch -D <branch>`.
4. Delete the lane row. Stale state in `key_value`, `operations`,
   `sessions`, etc. that references the lane is either cascaded
   (via FK ON DELETE) or retained for audit as documented on each
   table.

A worktree that has been manually removed from disk but still has a
row is repaired by `laneService.removeStaleWorktrees()` at startup.

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

All git commands are routed through
`apps/desktop/src/main/services/git/git.ts` with `cwd` pinned to the
lane's `worktree_path`. This matters because:

- Stashes, rebases, merges, and cherry-picks are worktree-local —
  nothing bleeds into other lanes.
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
- **Stopping a running dev server on delete**: `deleteLane` does not
  terminate processes launched inside the worktree. `runtimeDiagnosticsService`
  may still report a port as responding for a short period after
  delete; the proxy route is removed synchronously.
- **Attached lane path resolution**: attached paths are stored as
  given after `path.resolve`. If the user renames the containing
  directory outside ADE, `ade.lanes.list` will still return the row
  but any git command will fail. There is no auto-detection.
- **Primary worktree == repo root**. Operations that would destroy
  the repo root (delete) are blocked by the edit-protected flag.
  Operations that would clobber the primary's uncommitted changes
  (e.g., `createFromUnstaged` from primary) are guarded by
  precondition checks inside the relevant method.
