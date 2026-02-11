# Terminals and Sessions

Last updated: 2026-02-11

## 1. User Value

Embedded terminals let users run agent tools and project commands in lane-scoped workspaces, with durable linkage between "what ran", "what changed", and "why it changed".

## 2. UX Surface

- Per-lane terminal tabs (multiple sessions), shown inside the **Lanes** tab (lane inspector -> Terminals).
- Terminal grid view (command center).
- Session metadata:
  - title/label
  - goal
  - tool/agent type
  - start/end time
  - exit code (if applicable)
  - linked lane
  - head SHA at start/end
  - checkpoint id (after session end)

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
- Create immutable checkpoint at session end.

V1:

- Session templates ("Implement feature", "Write tests", "Fix lint").
- Split panes and terminal grid improvements.
- Session-level context replay from prior checkpoint.

## 4. Session End Contract

When a session ends, ADE should:

1. record session boundary:
   - `head_sha_start`, `head_sha_end`
   - transcript path/hash
   - deterministic diff summary
2. build and persist checkpoint:
   - session/tool metadata
   - touched files and failure lines
   - optional prompt/tool-call/token summaries (if available)
3. trigger the refresh pipeline:
   - append checkpoint + pack events
   - update deterministic packs
   - sync to hosted mirror (if enabled)
   - predict conflicts

## 5. Edge Cases

- Interactive CLIs that change terminal state.
- Large output volumes (need ring buffer + file-backed logs).
- Secrets in transcripts (default local-only; upload optional).
- Sessions that create multiple commits.

## 6. Development Checklist

Milestone 0 (gating):

- [ ] PTY works cross-platform (macOS + Windows first; Linux next)
- [ ] xterm.js rendering + resize + copy/paste stable

MVP:

- [ ] Per-lane terminals
- [ ] Session transcript capture and indexing
- [ ] Agent command shortcuts (config-driven)
- [ ] Checkpoint creation on session end

Testing:

- [ ] Spawn multiple concurrent PTYs; ensure no cross-lane cwd/env leaks
- [ ] Verify checkpoint integrity and SHA anchors for every completed session
