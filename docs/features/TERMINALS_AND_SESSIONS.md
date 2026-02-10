# Terminals and Sessions

Last updated: 2026-02-10

## 1. User Value

Embedded terminals let users run any agent tool and project commands in a lane-scoped workspace, with strong linkage between "what ran" and "what changed".

## 2. UX Surface

- Per-lane terminal tabs (multiple sessions).
- Terminal grid view (command center).
- Session metadata:
  - title/label
  - start/end time
  - exit code (if applicable)
  - linked lane
  - head SHA at start/end

## 3. Functional Requirements

MVP:

- Spawn PTY terminal in a lane worktree directory.
- Capture session transcript to a local file (configurable).
- Label a session and show summaries of:
  - duration
  - exit code
  - touched files (derived post-session)
- Provide "Spawn agent" shortcuts:
  - Codex CLI
  - Claude Code
  - Custom commands

V1:

- Session templates ("Implement feature", "Write tests", "Fix lint").
- Split panes and terminal grid improvements.
- Streamed session end event triggers lane refresh pipeline.

## 4. Session End Contract

When a session ends, ADE should:

1. record:
   - `head_sha_start`, `head_sha_end`
   - dirty diff summary
   - transcript path
2. trigger the lane refresh pipeline:
   - update deterministic packs
   - sync to hosted mirror
   - predict conflicts

## 5. Edge Cases

- Interactive CLIs that change terminal state.
- Large output volumes (need ring buffer + file-backed logs).
- Secrets in transcripts (default local-only; upload optional).

## 6. Development Checklist

Milestone 0 (gating):

- [ ] PTY works cross-platform (macOS + Windows first; Linux next)
- [ ] xterm.js rendering + resize + copy/paste stable

MVP:

- [ ] Per-lane terminals
- [ ] Session transcript capture and indexing
- [ ] Agent command shortcuts (config-driven)

Testing:

- [ ] Spawn multiple concurrent PTYs; ensure no cross-lane cwd/env leaks

