# File Viewer, Diffs, Quick Edit

Last updated: 2026-02-10

## 1. Goal

Support review and small edits without becoming a full IDE.

## 2. UX Surface

- File tree scoped to lane worktree.
- Diff viewer:
  - staged vs unstaged
  - commit diffs
  - 2-up and inline
- Quick edit:
  - small patch edits
  - conflict marker edits
- "Open in external editor" deep link.
- "Copy snippet for agent" utility.

## 3. Functional Requirements

MVP:

- Show file tree and file content (read-only).
- Show diffs for:
  - working tree changes
  - staged changes
  - commits
- Quick edit for small changes (save atomically).
- In conflict resolution mode:
  - highlight conflict markers
  - allow editing and saving

V1:

- Inline comments/notes (local-only).
- Better navigation across diffs and hunks.

## 4. Development Checklist

MVP:

- [ ] File tree + file viewer
- [ ] Diff viewer (staged/unstaged)
- [ ] Quick edit (atomic writes)
- [ ] External editor open

V1:

- [ ] Notes/comments
- [ ] Diff navigation polish

