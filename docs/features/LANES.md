# Lanes

Last updated: 2026-02-10

## 1. User Value

Lanes make parallel work safe and visible. Each lane is a real workspace (git worktree) with its own terminals, status, and packs.

## 2. UX Surface

- Lanes dashboard:
  - list + filters (active/ready/archived)
  - indicators: dirty, ahead/behind, conflict predicted/active, tests status, PR status
  - actions: create, rename, archive, open folder, open terminal, sync, run tests
- Lane detail:
  - file tree + diffs
  - terminals (lane inspector -> Terminals)
  - processes/tests context (read-only pointers; full controls live in Projects/Home)
  - lane pack

## 3. Functional Requirements

- Create lane from base ref (default `main`).
- Create lane from template (name conventions, initial commands, agent provider default).
- Rename/label lane; add description.
- Archive lane:
  - if merged: remove worktree folder and optionally delete branch
  - if unmerged: require explicit confirmation and offer snapshot/tag
- Show physical path of lane worktree and allow opening in OS file manager.

## 4. Lane Naming and IDs

Requirements:

- Human-friendly name (editable).
- Stable internal id (uuid) used for packs and DB.
- Branch name can be derived from name + id suffix to avoid collisions.

## 5. Status Computation

Lane status is derived from:

- git dirty state
- ahead/behind counts vs base ref
- conflict prediction result vs base
- test status from recent test runs
- PR linkage state

## 6. Edge Cases

- Branch collisions; worktree path already exists.
- Repo default branch not `main`.
- Multiple remotes; upstream not set.
- Dirty worktree when user tries to sync or archive.

## 7. Development Checklist

MVP:

- [ ] Create lane (branch + worktree) from base
- [ ] List lanes with derived status
- [ ] Rename lane and persist
- [ ] Archive lane (safe flow)
- [ ] Open lane folder and open terminal in lane

V1:

- [ ] Lane templates UI (feature/bugfix/hotfix/etc.)
- [ ] Batch actions (sync selected, test selected, archive merged)
- [ ] Searchable lane history view

Testing:

- [ ] Integration tests with repos that have non-standard default branch
- [ ] Lane creation/archival leaves repo in consistent state
