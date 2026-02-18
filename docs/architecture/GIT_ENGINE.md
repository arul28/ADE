# Git Engine Architecture

> Last updated: 2026-02-11

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Technical Details](#technical-details)
   - [Worktree Model](#worktree-model)
   - [Lane Status Derivation](#lane-status-derivation)
   - [Git Operations Service](#git-operations-service)
   - [Operation Tracking](#operation-tracking)
   - [Sync Strategy](#sync-strategy)
   - [Path Validation](#path-validation)
4. [Integration Points](#integration-points)
5. [Implementation Status](#implementation-status)

---

## Overview

The Git Engine is the subsystem responsible for all git interactions within ADE. Rather than using a JavaScript git implementation (like isomorphic-git), ADE shells out to the system `git` binary for all operations. This ensures full compatibility with the user's existing git configuration, hooks, credentials, and extensions.

The engine is split across two primary modules:

- **`git.ts`**: Low-level utilities for executing git commands (`runGit`, `runGitOrThrow`) with timeout support and structured output parsing
- **`gitOperationsService.ts`**: High-level service that wraps git commands with lane resolution, operation tracking, and event callbacks

Every git mutation is wrapped in an operation record that captures the pre and post HEAD SHAs, enabling future undo capabilities and providing a complete audit trail in the history view.

---

## Design Decisions

### Shell Out to System Git

ADE uses the system `git` binary rather than a JavaScript git library. This decision was driven by:

- **Full feature parity**: No need to reimplement complex git operations (rebase, cherry-pick, merge strategies)
- **Hook compatibility**: User's pre-commit hooks, commit-msg hooks, etc. run naturally
- **Credential handling**: SSH keys, credential helpers, and GPG signing work without configuration
- **Performance**: Native git is significantly faster for large repositories
- **Trade-off**: Requires git to be installed on the system (universally true for developers)

### Worktrees Over Branches

Each lane maps to a dedicated git worktree rather than just a branch. This enables:

- Simultaneous checkout of multiple branches
- Independent working trees with no switching overhead
- Clean filesystem isolation for process execution
- Per-lane terminal sessions that always operate in the correct directory

### Operation Wrapping

Every git mutation goes through `runLaneOperation()`, which:

1. Resolves the lane's worktree path, base ref, and branch ref
2. Captures the pre-operation HEAD SHA
3. Creates an operation record in the database
4. Executes the git command
5. Captures the post-operation HEAD SHA
6. Updates the operation record with the result
7. Fires the `onHeadChanged` callback if the HEAD moved

This wrapper provides atomicity guarantees for the operation record (always created, always finalized) and ensures consistent event propagation.

### Strict Path Validation

All file paths passed to git operations are validated by `ensureRelativeRepoPath()`:

- Must be non-empty
- Must not contain null bytes
- Must be repo-relative (not absolute)
- Must not escape the lane root via `../` traversal

This prevents path injection attacks from the renderer process.

---

## Technical Details

### Worktree Model

Each lane creates a git worktree under `.ade/worktrees/`:

```bash
git worktree add -b ade/<slug>-<uuid8> .ade/worktrees/<slug>-<uuid8> <base_ref>
```

**Lane types**:

| Type | Description | Worktree Location |
|------|-------------|-------------------|
| Worktree | Standard ADE lane | `.ade/worktrees/<slug>-<uuid8>` |
| Primary | Main repo directory | Project root itself |
| Attached | Pre-existing worktree | User-specified path |

**Branch naming convention**: `ade/<slugified-name>-<uuid-prefix>`

Example: A lane named "Add Login Page" creates branch `ade/add-login-page-a1b2c3d4` and worktree at `.ade/worktrees/add-login-page-a1b2c3d4`.

The slugification process converts the lane name to lowercase, replaces non-alphanumeric characters with hyphens, and trims leading/trailing hyphens. The UUID prefix (first 8 characters) ensures uniqueness.

**Worktree lifecycle**:

- **Create**: `git worktree add -b <branch> <path> <base>` with 60-second timeout
- **Archive**: Lane status set to `archived` in database (worktree remains on disk)
- **Delete**: `git worktree remove <path>` (with optional `--force`), followed by `git branch -D <branch>` if `deleteBranch` is true
- **Cleanup**: Associated session deltas, terminal sessions, operations, and pack index entries are cascade-deleted from the database

### Lane Status Derivation

Lane status is computed on demand (not cached) by `computeLaneStatus()`:

```typescript
type LaneStatus = {
  dirty: boolean;    // Any uncommitted changes
  ahead: number;     // Commits ahead of base ref
  behind: number;    // Commits behind base ref
};
```

**Dirty detection**:
```bash
git status --porcelain=v1
```
Any non-empty output indicates dirty state. Timeout: 8 seconds.

**Ahead/Behind computation**:
```bash
git rev-list --left-right --count <base_ref>...<branch_ref>
```
The output `A\tB` means B commits ahead and A commits behind. Timeout: 8 seconds.

**Future status extensions** (planned):
- `conflictPrediction`: Result of dry-merge simulation against other lanes
- `testStatus`: Most recent test run result for this lane
- `prStatus`: GitHub PR state (open, merged, review requested)
- `processHealth`: Aggregate health of lane-associated processes

### Git Operations Service

The `gitOperationsService.ts` module provides the full set of git operations exposed to the renderer via IPC. All operations are organized into categories:

#### File Operations

| Operation | Git Command | Purpose |
|-----------|------------|---------|
| `stageFile` | `git add -- <path>` | Stage a file for commit |
| `unstageFile` | `git restore --staged -- <path>` | Remove a file from staging |
| `discardFile` | `git restore --worktree -- <path>` or `git clean -f -- <path>` | Discard working tree changes |
| `restoreStagedFile` | `git restore --staged --worktree --source=HEAD -- <path>` | Fully restore a file to HEAD state |

The `discardFile` operation checks whether the file is untracked (via `git status --porcelain=v1`) and uses `git clean -f` for untracked files or `git restore --worktree` for tracked files.

#### Commit Operations

| Operation | Git Command | Purpose |
|-----------|------------|---------|
| `commit` | `git commit -m <message>` | Create a new commit |
| `commit` (amend) | `git commit --amend -m <message>` | Amend the most recent commit |
| `revertCommit` | `git revert --no-edit <sha>` | Create a revert commit |
| `cherryPickCommit` | `git cherry-pick <sha>` | Cherry-pick a commit into the current branch |

#### Stash Operations

| Operation | Git Command | Purpose |
|-----------|------------|---------|
| `stashPush` | `git stash push [-u] [-m <msg>]` | Save working changes to stash |
| `listStashes` | `git stash list --date=iso-strict --format=...` | List all stash entries |
| `stashApply` | `git stash apply <ref>` | Apply stash without removing it |
| `stashPop` | `git stash pop <ref>` | Apply and remove stash |
| `stashDrop` | `git stash drop <ref>` | Remove stash without applying |

#### Sync Operations

| Operation | Git Command | Purpose |
|-----------|------------|---------|
| `fetch` | `git fetch --prune` | Fetch remote refs, prune deleted |
| `sync` (merge) | `git fetch --prune` then `git merge --no-edit <base>` | Sync with upstream via merge |
| `sync` (rebase) | `git fetch --prune` then `git rebase <base>` | Sync with upstream via rebase |
| `push` | `git push [-u origin <branch>] [--force-with-lease]` | Push branch to remote |

#### Query Operations

| Operation | Git Command | Purpose |
|-----------|------------|---------|
| `listRecentCommits` | `git log -n<limit> --pretty=format:...` | List recent commits with metadata |

The `listRecentCommits` operation uses a unit separator (`\x1f`) delimited format to parse commit fields: full SHA, short SHA, author name, authored date (ISO), and subject line.

### Operation Tracking

Every git mutation is wrapped by `runLaneOperation()`:

```typescript
const runLaneOperation = async <T>({
  laneId, kind, reason, metadata, fn
}: {
  laneId: string;
  kind: string;          // e.g., "git_commit", "git_push"
  reason: string;        // Human-readable trigger description
  metadata?: Record<string, unknown>;
  fn: (lane: LaneInfo) => Promise<T>;
}): Promise<{ result: T; action: GitActionResult }> => {
  const lane = laneService.getLaneBaseAndBranch(laneId);
  const preHeadSha = await getHeadSha(lane.worktreePath);
  const operation = operationService.start({ laneId, kind, preHeadSha, metadata });

  try {
    const result = await fn(lane);
    const postHeadSha = await getHeadSha(lane.worktreePath);
    operationService.finish({ operationId, status: "succeeded", postHeadSha });
    if (preHeadSha !== postHeadSha) onHeadChanged?.({ laneId, reason, ... });
    return { result, action: { operationId, preHeadSha, postHeadSha } };
  } catch (error) {
    operationService.finish({ operationId, status: "failed", ... });
    throw error;
  }
};
```

The `GitActionResult` returned to the renderer contains:
- `operationId`: UUID for the operation record
- `preHeadSha`: HEAD SHA before the operation
- `postHeadSha`: HEAD SHA after the operation (may be null on failure)

### Sync Strategy

The sync operation supports two modes:

**Merge** (default):
1. `git fetch --prune` -- Fetch all remote refs, remove stale tracking branches
2. `git merge --no-edit <base_ref>` -- Merge upstream changes with auto-generated message

**Rebase**:
1. `git fetch --prune` -- Fetch all remote refs
2. `git rebase <base_ref>` -- Replay local commits on top of upstream

Both modes require a clean working tree (no uncommitted changes). The `isWorktreeDirty()` check runs before the fetch to fail fast with a clear error message.

The `push` operation handles both tracked and untracked branches:
1. Checks for an upstream branch via `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}`
2. If upstream exists: `git push [--force-with-lease]`
3. If no upstream: `git push -u origin <branch_ref> [--force-with-lease]`

### Path Validation

The `ensureRelativeRepoPath()` function validates all file paths before passing them to git:

```typescript
function ensureRelativeRepoPath(relPath: string): string {
  const normalized = relPath.trim().replace(/\\/g, "/");
  if (!normalized.length) throw new Error("File path is required");
  if (normalized.includes("\0")) throw new Error("Invalid file path");
  if (path.isAbsolute(normalized)) throw new Error("Path must be repo-relative");
  if (normalized.startsWith("../") || normalized === ".."
      || normalized.includes("/../")) {
    throw new Error("Path escapes lane root");
  }
  return normalized;
}
```

This prevents:
- Empty path injection
- Null byte injection
- Absolute path access
- Directory traversal attacks

---

## Integration Points

### Upstream Dependencies

- **Lane Service**: Provides worktree path resolution and lane metadata (`getLaneBaseAndBranch`)
- **Operation Service**: Records operation history with pre/post HEAD SHAs

### Downstream Consumers

- **Job Engine**: Receives `onHeadChanged` callbacks when git operations modify HEAD, triggering pack refresh
- **Renderer (via IPC)**: All git operations are exposed through 13 IPC channels under the `ade.git.*` namespace
- **Pack Service**: Consumes git state (HEAD SHA, diff stats) during pack generation

### Event Flow

```
Renderer: user clicks "Commit"
  --> IPC: ade.git.commit
    --> gitService.commit()
      --> runLaneOperation()
        --> operationService.start()
        --> git commit -m "message"
        --> operationService.finish()
        --> onHeadChanged() (if HEAD moved)
          --> jobEngine.onHeadChanged()
            --> packService.refreshLanePack()
            --> packService.refreshProjectPack()
  <-- GitActionResult { operationId, preHeadSha, postHeadSha }
```

---

## Implementation Status

### Completed

- Git command execution utilities (`runGit`, `runGitOrThrow`) with timeout support
- Lane worktree creation and deletion
- Lane status computation (dirty, ahead, behind)
- File operations: stage, unstage, discard, restore staged
- Commit operations: commit, amend, revert, cherry-pick
- Stash operations: push, list, apply, pop, drop
- Sync operations: fetch, merge sync, rebase sync
- Push with automatic upstream setup and force-with-lease option
- Recent commits listing with parsed metadata
- Operation tracking wrapper with pre/post HEAD SHA capture
- Path validation with traversal prevention
- HEAD change event propagation to job engine
- Conflict prediction via dry-merge simulation using `git merge-tree` (Phase 5)
- Pairwise lane conflict detection across all active lanes (Phase 5)
- Stack operations: parent-child lane relationships with restack propagation (Phase 4)
- Primary lane support: main repo directory represented as a lane (Phase 7)
- Attached worktree support: link pre-existing worktrees to ADE (Phase 7)

### Planned (Not Yet Started)

- **Branch operations**: Create, delete, checkout, rename branches
- **Interactive rebase support**: Reorder, squash, fixup commits
- **Merge conflict resolution UI**: Inline conflict markers with accept/reject actions
- **Git hooks integration**: Surface pre-commit hook failures in the UI
- **Partial staging**: Stage individual hunks within a file
- **Blame integration**: Surface authorship information in diff views
