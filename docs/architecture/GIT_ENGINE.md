# Git Engine (Worktrees, Sync, Conflict Prediction)

Last updated: 2026-02-10

## 1. Lane = Branch + Worktree

Lane creation should use `git worktree` so each lane is a real directory with isolated files.

Recommended flow:

- Resolve base ref (default `main`, configurable).
- Create branch and worktree:
  - `git worktree add -b <laneBranch> <worktreePath> <baseRef>`
- Register lane in local DB.

## 2. Drift Status

Compute ahead/behind counts:

- `git rev-list --left-right --count <base>...<lane>`

Compute dirty status:

- `git status --porcelain` in worktree

## 3. Sync Lane With Base

Support both merge and rebase. Default should be merge-first (safer) but configurable per project/lane.

### Merge sync (default)

- Ensure lane is clean (or require user to stash/commit).
- Record `pre_head_sha`.
- `git merge <baseRef>` (or `git merge --no-ff` depending on policy).
- If conflicts: stop and collect conflict markers.
- Record operation in timeline for undo.

### Rebase sync (optional)

- Ensure lane is clean.
- Record `pre_head_sha`.
- `git rebase <baseRef>`.
- If conflicts: stop and collect conflict markers.
- Provide a guided "continue/abort" flow.
- Record operation for undo.

Undo strategy (MVP):

- Use operation record with `pre_head_sha`.
- Undo can be implemented as:
  - a safe guided reset: `git reset --hard <pre_head_sha>` (scary but effective)
  - or a revert-based approach (less scary but can be noisy)

## 4. Conflict Prediction (Dry-Run)

Goal: predict conflicts without mutating the lane worktree by default.

Approaches:

1. `git merge-tree` style analysis:
   - compute merge base
   - produce a synthetic merge result and parse conflicts

2. Temporary index/worktree approach:
   - use `GIT_INDEX_FILE` and a temporary work dir to attempt the merge
   - detect conflicts
   - discard

MVP output:

- `conflict_predicted` boolean
- list of files likely to conflict
- coarse conflict types (same lines, rename/delete) if feasible

## 5. Stack Awareness

If lane B is stacked on lane A:

- base(B) = branch(A)
- drift/conflict prediction for B must be computed against A, not `main`.

Restack:

- propagate changes from parent to child by repeated sync operations (merge or rebase), in dependency order.

