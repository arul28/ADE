# Worktree isolation

Every lane except the main checkout lives in its own git worktree, so many
branches can be checked out at once. Worktree creation, removal and every git
command for a lane run on the machine that holds the lane (the brain for a
local binding, the remote runtime for a remote one). The code is
`apps/desktop/src/main/services/lanes/laneService.ts`. Lifecycle steps,
delete rails and the reconcile are in the [Lanes README](./README.md); this doc
covers placement, saved work and the per-lane state on disk.

## Worktree placement

Worktrees DAEX makes live at `.ade/worktrees/<slug>-<laneId[0:8]>/` under the
repo root (`laneWorktreeFolderName` in `laneWorktreeNaming.ts`). The slug is
`slugify(laneName)` (lower case, `[^a-z0-9]+` → `-`, trimmed, empty → `lane`),
cut to 40 characters at a word boundary because Windows stops at 260
characters. The lane id suffix keeps names unique. Lane and branch names are
not cut. On Windows every git command DAEX runs sets `core.longpaths=true`
(`GIT_CONFIG_OVERRIDE_ARGS`). The absolute path is stored in
`lanes.worktree_path`.

A worktree you made yourself keeps its path; adoption records it as is.
Legacy `attached` rows (`attached_root_path`) are ordinary lanes. What DAEX may
remove is decided by the path, never the lane type.

The main checkout's `worktree_path` is the repo root.

## Creating a worktree

`laneService.create()` for a `worktree` lane:

1. Resolve the start choice (saved defaults when omitted); `normalizeBranchName`
   strips `refs/heads/`, `refs/remotes/`, `origin/` (`shared/laneBaseResolution.ts`).
2. Build the path from the name and lane id.
3. `git worktree add -b <branch> <path> <baseRef>`. See
   [Reserved ids, checkout progress, cancellation](./README.md#reserved-ids-checkout-progress-cancellation).
4. Insert the `lanes` row (`lane_type = 'worktree'`, `is_edit_protected = 0`,
   `status = 'active'`), compute status, return `LaneSummary`.

Failures: a failed `worktree add` inserts no row, and removes the branch it
made unless git refused because the branch or folder already existed. A failed
insert after the add tears down the worktree and branch (`git worktree remove
--force --force`, falling back to folder removal plus `unlock` + `prune`). An
abort mid-checkout kills git's process tree, then removes the half-written
worktree (locked "initializing", hence the double `--force`) and the new
branch. An abort before git started removes nothing.

## Unsaved work on delete

Before deleting, DAEX checks dirtiness only when the saved path still resolves
to that exact worktree root; otherwise the lane is treated as stale rather than
reading the main checkout's status. `git/worktreeState.ts` counts as unsaved:
uncommitted or untracked files (regardless of `status.showUntrackedFiles`), a
changed submodule, files in an uninitialized submodule folder, and a submodule
commit no remote-tracking branch has (a tag does not count). A submodule with
no remote, nested four or more levels, or unreadable also stops the delete.
Without force the delete stops with the reason; archive-and-reclaim asks for
`forceDirty`. A batch delete (desktop and phone) skips dirty lanes unless the
person ticks the box naming them.

### Saved work

Right before the first destructive step, `deletedLaneSnapshots.ts` saves what
the delete would lose: uncommitted and untracked files (not ignored ones),
commits no other branch, remote or tag holds, and commits only the remote branch
holds when that is deleted too (fetched first). It writes one commit (HEAD as
first parent, the working tree as tree) under
`refs/ade/deleted-lanes/<epochMs>-<laneId>` (ref name kept for compatibility)
with name, branch and time in trailers. A clean lane with its commits elsewhere
saves nothing. A failed save stops the delete. Archive-and-reclaim with
`forceDirty` saves as kind `freed`, and `unarchive` puts the newest freed save
back.

Saves are listed in Settings › Deleted & Archived › Recently deleted, on the
phone under Lanes › Archived (each machine's own list), and by `daex lanes
deleted list`. Restore (`daex lanes deleted restore <id>`) makes a new lane on
the old branch name (or `<name>-restored`) at the saved HEAD, never pushed,
applies the uncommitted files back, and reopens the chats the delete moved to
Recently deleted (`reopenedChats`). Commits the branch does not hold go on
sibling branches such as `<name>-remote`. Saves older than 30 days are pruned.
A save covers the parent repository only, so a delete stops when a checked-out
submodule or nested untracked repository has unsaved work.

## Residual cleanup retry sweep

`worktreeResidualCleanup.ts` retries managed folders that survived a delete.
`local_worktree_residual_cleanups` is machine-local (not replicated). The sweep
starts from `laneService.list()` without blocking it, backs off a folder that
keeps failing (doubling up to an hour), and removes through
`removeTreeOffProcess.ts`. Before removing anything it rebuilds three guard
sets: registered worktrees, `lanes.worktree_path` values (archived included),
and pending creates. Only direct children of `.ade/worktrees/` qualify. Unknown
folders are removed only when empty and old; unknown non-empty folders are left
as user data.

Status reads verify `worktree_path` with `git rev-parse --path-format=absolute
--show-toplevel` first; a missing or different top level returns a clean
default status instead of reading the wrong checkout. `gitOperationsService`
does the same check before any mutation or history read.

## Per-lane state on disk

| Path | Contents |
|------|----------|
| `<worktree>/.ade/tmp/conflict-proposals/` | Scratch patches from AI conflict proposals |
| `.ade/artifacts/packs/conflicts/v2/<laneId>__<peerKey>.md` | Conflict pack for a lane/peer pair |
| `.ade/artifacts/packs/conflicts/predictions/<laneId>.json` | Prediction summary |
| `.ade/artifacts/packs/external-resolver-runs/<runId>/` | External resolver artifacts |

Environment, port lease and proxy route state live in SQLite, not on disk.
Ports, proxy hostnames, OAuth and environment setup are in
[runtime.md](./runtime.md) and [oauth-redirect.md](./oauth-redirect.md).

## Gotchas

- **Stashes, rebases and merges are worktree-local.** In-progress state is read
  from the worktree's gitdir (`rebase-apply/`, `rebase-merge/`, `MERGE_HEAD`)
  by `detectConflictKind` in `git/gitConflictState.ts`.
- **Symlinks:** copy paths and mount points go through `resolvePathWithinRoot`.
- **Git lock files:** a stray `index.lock` blocks only that lane. DAEX does not
  remove stale locks.
- **Processes started outside DAEX** may hold files or ports after a delete;
  lane-owned PTYs and watchers are stopped first.
- **Moving a worktree folder outside DAEX strands the lane.** Git keeps listing
  the old path as prunable (so no reap) and the new path is not registered (so
  no adoption). Fix with `git worktree repair` or re-add the worktree.
- **Git reports realpaths.** Any new comparison of a lane path against git
  output must canonicalize both sides, or it double-adopts and falsely reaps.
- **Main checkout == repo root.** Delete is blocked by the edit-protected flag.
  Starting a lane with `on: "uncommitted"` from the main checkout's branch
  copies its changes and never touches its files or index.
