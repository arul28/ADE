# Files Workbench (Explorer, Editor, Diff)

Last updated: 2026-02-11

## 1. Goal

Provide an IDE-style file explorer and editor experience inside ADE without becoming a full IDE.

This workbench is optimized for:

- browsing files across main directory and lanes/worktrees
- making focused code edits quickly
- reviewing diffs in context
- staying integrated with lane/git/packs workflows

## 2. UX Surface

Dedicated `Files` tab (workbench) with a 3-pane layout:

- Left: workspace + lane selector, file explorer tree
- Center: editor/diff tabs (Monaco)
- Right: context panel (git status, symbols, references, packs/snippet tools)

### 2.1 Workspace Scope Selector

User can switch scope between:

- primary workspace (main repository directory)
- any active lane workspace
- attached worktree lanes

Selector behavior:

- switching scope updates tree root and git context
- active scope is shown prominently in editor header

### 2.2 Editor Modes

- file mode:
  - editable Monaco buffer
- diff mode:
  - staged vs unstaged
  - working tree vs HEAD
  - commit diffs
  - lane-vs-lane comparison (V1)
- conflict mode:
  - highlight conflict markers
  - side-by-side assist for resolution

### 2.3 Utilities

- open in external editor
- copy snippet for agent
- quick stage/unstage selected file
- jump to owning lane details or conflict panel

## 3. Functional Requirements

MVP:

- Show workspace/lane selector and file tree.
- Show file content with edit/save support.
- Show diffs for:
  - working tree changes
  - staged changes
  - commits
- Quick edit for small and medium edits (atomic writes).
- In conflict resolution mode:
  - highlight conflict markers
  - allow editing and saving

V1:

- Multi-file tabs and split editor panes.
- Lane-vs-lane diff mode.
- Inline notes/comments (local-only).
- Better navigation across hunks/symbols/references.

## 4. Safety and Guardrails

- Always show active workspace path and branch in header.
- Save operations are lane/workspace scoped and atomic.
- Warn before edits on protected primary branch (policy-controlled).
- Dirty state and staged state updates should propagate to lane/conflict views in near real time.

## 5. Development Checklist

MVP:

- [ ] Files tab route and shell
- [ ] Workspace/lane selector
- [ ] File explorer tree + file viewer
- [ ] Monaco editor save flow
- [ ] Diff viewer (staged/unstaged/commit)
- [ ] External editor open
- [ ] Quick stage/unstage controls

V1:

- [ ] Split editor/tabs
- [ ] Lane-vs-lane diff mode
- [ ] Notes/comments
- [ ] Diff navigation polish
