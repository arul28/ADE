# Git Operations (In-App)

Last updated: 2026-02-11

## 1. Goal

All routine git workflows should be executable from ADE's UI, without requiring users to leave the app for CLI-only flows.

Design intent:

- keep power-user speed
- preserve safety for destructive actions
- keep lane/workspace/branch context explicit

## 2. UX Surface

Primary surface:

- Lanes tab center pane (changes/diff + source control actions)
- Lane inspector actions for lane-scoped git operations

Secondary surface:

- PR panel actions where git remote ops are required (push/update)

Guidelines:

- every action shows scope (`lane`, `workspace path`, `branch`, `files`, `commit`)
- destructive actions require explicit confirmation
- operation progress/status appears in timeline/history

## 3. Functional Requirements

### 3.1 File/Hunk Operations

- Stage file
- Unstage file
- Stage selected hunks (where supported)
- Discard file changes (with confirmation)
- Restore staged file to HEAD (with confirmation)

### 3.2 Commit Operations

- Commit staged changes (message required)
- Amend last commit (message + staged changes)
- View recent commits for selected lane
- Revert commit (creates new commit)

### 3.3 Sync and Branch Operations

- Fetch remote
- Sync lane with base (merge default, rebase optional)
- Rebase continue/abort when conflicts occur
- Cherry-pick commit(s) into lane
- Reset lane HEAD:
  - soft / mixed / hard (hard must have high-friction confirmation)
- Branch create
- Branch switch
- Branch rename
- Branch delete (safe checks)

### 3.4 Stash Operations

- Stash push (optionally include untracked)
- Stash list
- Stash apply
- Stash pop
- Stash drop

### 3.5 Remote Operations

- Push branch
- Force push (`--force-with-lease`) with explicit confirmation
- Pull/rebase from tracked upstream (lane-scoped)

## 4. Safety Rules

- Renderer sends typed intents only; main process executes git.
- All destructive operations require a confirmation modal with exact lane/branch/workspace target.
- `--force-with-lease` and hard reset require secondary confirmation text.
- All operations create timeline records with pre/post SHA where possible.
- Branch switch safety:
  - if dirty: require commit/stash/discard choice
  - if running sessions: block unless user force-confirms
- Primary-lane protection:
  - warn or block direct commits to protected branches (for example `main`) based on user policy

## 5. Development Checklist

MVP:

- [ ] Stage/unstage file actions from diff list
- [ ] Commit staged changes from in-app UI
- [ ] Push branch / force-with-lease with confirmation
- [ ] Fetch + lane sync (merge/rebase) UI integration
- [ ] Stash push/pop/apply/drop UI
- [ ] Revert and cherry-pick UI actions
- [ ] Branch create/switch UI actions with safety checks
- [ ] Operation records written to timeline/history

V1:

- [ ] Hunk-level staging
- [ ] Branch rename/delete UI with dependency checks
- [ ] Interactive rebase UX (todo/edit/drop)
- [ ] Batch git actions across selected lanes
