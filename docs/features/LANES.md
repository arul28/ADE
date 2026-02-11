# Lanes

Last updated: 2026-02-11

## 1. User Value

Lanes make parallel work safe and visible while supporting multiple workflows:

- work directly in the main repository directory
- develop in isolated git worktrees
- manage stacked PR flows
- stay on a single branch when preferred

A lane is a logical work unit that points to a workspace directory and an active branch.

## 2. Core Model

ADE must treat these as separate concepts:

- Workspace: a physical directory (`main repo dir` or `git worktree` path)
- Branch: git branch currently checked out in that workspace
- Lane: metadata and UI behavior bound to workspace + branch + goals

### 2.1 Lane Types

- Primary lane:
  - points to the main repository directory
  - default for users who want to work in-place
- Worktree lane:
  - dedicated git worktree + branch pair (default lane creation path)
- Attached lane:
  - imports an already-existing external worktree path

## 3. UX Surface

- Lanes dashboard:
  - list + filters (active/ready/archived)
  - indicators: dirty, ahead/behind, conflict predicted/active, tests status, PR status
  - lane type badge: `primary`, `worktree`, `attached`
  - actions: create, rename, archive, open folder, open terminal, sync, run tests
- Workspace graph mode:
  - main directory node centered
  - outgoing edges to all active/stale worktrees
  - lane status and conflict overlays on nodes/edges
  - quick merge simulation per edge pair
- Lane source control actions (in-app):
  - stage/unstage
  - commit/amend/revert/cherry-pick
  - stash push/pop/apply/drop
  - push/force-with-lease
  - branch create/switch/rename/delete (safe flow)
- Lane detail:
  - file tree + diffs
  - terminals (lane inspector -> Terminals)
  - processes/tests context (read-only pointers; full controls live in Projects/Home)
  - lane pack

## 4. Functional Requirements

### 4.1 Lane Creation

- Create primary lane for the main directory during onboarding.
- Create lane from base ref (default `main`) as worktree lane.
- Create lane from template/profile (name conventions, initial commands, defaults).
- Attach existing worktree path as lane.
- Rename/label lane; add description.

### 4.2 Branch Management Inside a Lane

- Show current branch and upstream for each lane.
- Support branch create/switch/rename/delete from lane UI.
- On branch switch with dirty state:
  - require commit/stash/discard flow before switching
- Block branch switch while terminal session is running unless user force-confirms.

### 4.3 Main Directory Workflow

- Primary lane must be first-class (not hidden fallback).
- User can work in main directory with full lane controls.
- Optional protection mode for primary lane:
  - warn or block direct commits to protected branches (for example `main`)

### 4.4 Custom Lane Profiles and Local Overlays

- Lane profile may define:
  - bootstrap commands
  - env/setup steps
  - default agent/tool settings
  - default tests/processes to run
- Support explicit local-only overlay file policy:
  - allowlist of files/globs that can be copied/symlinked into a lane on creation
  - common use cases: `.env.local`, local tool configs, generated caches
- Never copy all gitignored files implicitly.

### 4.5 Archive Behavior

- If merged: remove worktree folder and optionally delete branch.
- If unmerged: require explicit confirmation and offer snapshot/tag.
- Primary lane cannot remove main directory; archive means hide/deactivate only.

## 5. Status Computation

Lane status is derived from:

- git dirty state
- ahead/behind counts vs base ref
- conflict prediction result vs base and vs peer lanes
- merge simulation state to selected target lane/branch
- test status from recent test runs
- PR linkage state

## 6. Edge Cases

- Branch collisions; worktree path already exists.
- Repo default branch not `main`.
- Multiple remotes; upstream not set.
- Dirty worktree during branch switch/sync/archive.
- Primary lane on detached HEAD.
- Overlay allowlist includes missing paths.

## 7. Development Checklist

MVP:

- [ ] Create and persist primary lane for main directory
- [ ] Create worktree lane (branch + worktree) from base
- [ ] Attach existing worktree as lane
- [ ] List lanes with lane type + derived status
- [ ] Branch create/switch flow in lane UI with safety checks
- [ ] Open lane folder and open terminal in lane
- [ ] Lane-scoped source control actions wired to git engine

V1:

- [ ] Lane profile/template UI
- [ ] Overlay allowlist copy/symlink flow
- [ ] Batch actions (sync selected, test selected, archive merged)
- [ ] Searchable lane history view

Testing:

- [ ] Integration tests with non-standard default branch
- [ ] Branch switching safety checks with dirty/running-session states
- [ ] Lane creation/archival leaves repo in consistent state
- [ ] Overlay policy enforces explicit allowlist only
