# Terminals & Sessions — Command Center

> Last updated: 2026-02-11

---

## Table of Contents

- [Overview](#overview)
- [Core Concepts](#core-concepts)
  - [PTY (Pseudo-Terminal)](#pty-pseudo-terminal)
  - [Session](#session)
  - [Transcript](#transcript)
  - [Session Delta](#session-delta)
  - [Checkpoint](#checkpoint)
- [User Experience](#user-experience)
  - [Terminals Tab (Global)](#terminals-tab-global)
  - [Lane Terminal Panel](#lane-terminal-panel)
  - [Terminal View](#terminal-view)
  - [Session Delta Card](#session-delta-card)
  - [Tiling Layout (Future)](#tiling-layout-future)
  - [Session Lifecycle](#session-lifecycle)
- [Technical Implementation](#technical-implementation)
  - [Services](#services)
  - [IPC Channels](#ipc-channels)
  - [Data Streaming Architecture](#data-streaming-architecture)
  - [Transcript Capture Pipeline](#transcript-capture-pipeline)
  - [Delta Computation Algorithm](#delta-computation-algorithm)
- [Data Model](#data-model)
  - [Database Schema](#database-schema)
  - [Filesystem Artifacts](#filesystem-artifacts)
- [Implementation Tracking](#implementation-tracking)
  - [Phase 1 — Core PTY Infrastructure (DONE)](#phase-1--core-pty-infrastructure-done)
  - [Phase 2 — Session Tracking (DONE)](#phase-2--session-tracking-done)
  - [Phase 3 — Global Terminals UI (DONE)](#phase-3--global-terminals-ui-done)
  - [Phase 4 — Advanced Features (TODO)](#phase-4--advanced-features-todo)

---

## Overview

The **Terminals tab** provides a global view of all terminal sessions across lanes. Each lane also has an embedded terminal panel accessible via its "Terminals" sub-tab. Sessions are tracked with metadata, transcripts, and delta statistics for full context awareness.

This feature matters because terminals are the primary interface for interacting with code. Developers spend most of their time in terminals running commands, debugging, and iterating. ADE elevates terminals from disposable shell tabs to tracked, contextualized sessions. Every terminal session is associated with a lane, its output is captured as a transcript, and when it ends, ADE computes what changed — files modified, lines added and removed, potential failures. This transforms terminal activity from an opaque black box into structured development history.

The combination of session tracking and delta computation is a foundational capability that feeds into other ADE features: the History tab uses sessions as nodes in the development timeline, Packs are refreshed when sessions end, and future checkpoint creation will be triggered by session boundaries.

---

## Core Concepts

### PTY (Pseudo-Terminal)

A **PTY** is a real terminal emulator backed by `node-pty`, a native Node.js module that spawns actual pseudo-terminal processes. Unlike simple `child_process.spawn`, PTYs provide:

- Full terminal emulation (ANSI escape codes, colors, cursor movement, alternate screen buffer).
- Interactive input (arrow keys, tab completion, Ctrl+C, etc.).
- Correct behavior for TUI applications (vim, htop, less, etc.).

In ADE, PTYs are rendered in the browser using `xterm.js`, a high-performance terminal frontend that matches the capabilities of native terminal applications.

### Session

A **session** is a tracked terminal lifecycle from creation to exit. When a PTY is created, a session record is simultaneously created in the database. The session captures:

- **Identity**: Unique session ID, associated lane, user-provided title.
- **Timing**: Start time, end time, duration.
- **State**: Running or ended, exit code.
- **Git context**: HEAD SHA at session start and end (enabling delta computation).
- **Transcript path**: Location of the captured output file.
- **Preview**: Last few lines of output (for display in session lists without reading the full transcript).

### Transcript

A **transcript** is the raw terminal output saved to disk at `.ade/transcripts/<session-id>.log`. Every byte written by the PTY to stdout is appended to this file. Transcripts include ANSI escape codes (preserving color and formatting information).

Transcripts serve multiple purposes:
- **Audit trail**: Review what commands were run and what output was produced.
- **Search**: Find specific output or error messages across sessions.
- **Replay** (future): Reconstruct the terminal output for playback.

### Session Delta

A **session delta** is a set of statistics computed after a session ends. It answers the question: "What changed in the repository during this terminal session?"

Delta computation works by comparing the git state at session start (captured HEAD SHA) to the state at session end:

| Metric | Description |
|--------|-------------|
| `files_changed` | Number of files with differences |
| `insertions` | Total lines added across all changed files |
| `deletions` | Total lines removed across all changed files |
| `touched_files` | List of specific file paths that changed |
| `failure_lines` | Lines from the transcript matching common failure patterns (stack traces, error keywords) |

### Checkpoint

A **checkpoint** is an immutable snapshot created at a session boundary. This is a future feature that will capture the complete state of a lane at the moment a session ends, enabling rollback and time-travel debugging. Checkpoints are described in the History feature documentation.

### Untracked Session

An **untracked session** is a terminal launched with context recording disabled. Its output is not captured to a transcript, no session delta is computed on exit, no checkpoint is created, and no pack refresh is triggered. Untracked sessions are useful for:

- Quick one-off commands that don't warrant context overhead (e.g., `ls`, `cat`, `top`)
- Sensitive operations where transcript capture is undesirable (e.g., entering credentials, viewing secrets)
- Debugging or exploration that the developer explicitly wants excluded from project history

Untracked sessions still appear in the session list (marked with a "ghost" badge) so the developer can see what's running, but they produce no persistent artifacts. The "New Terminal" button offers a dropdown: "New Terminal" (default, tracked) and "New Terminal (Untracked)".

**Implementation note**: When `tracked: false` is passed to `ade.pty.create`, the PTY service skips transcript file creation, the session service skips delta computation on exit, and the job engine receives no session-end trigger.

---

## User Experience

### Terminals Tab (Global)

The Terminals tab provides a centralized view of all terminal sessions across all lanes in the project.

```
+-------------------------------------------------------------------+
| Filter: [All Lanes ▼] [All Status ▼] [Search...              ]   |
+-------------------------------------------------------------------+
| Session List                                                      |
| +---------------------------------------------------------------+ |
| | Title              | Lane         | Status  | Exit | Time     | |
| |--------------------|--------------|---------|------|----------| |
| | npm run dev        | feature-auth | Running |  —   | 14:30    | |
| | pytest tests/      | bugfix-123   | Ended   |  0   | 14:15    | |
| | cargo build        | refactor-db  | Ended   |  1   | 13:45    | |
| | git rebase -i      | feature-auth | Ended   |  0   | 13:30    | |
| +---------------------------------------------------------------+ |
| Last output: "Server listening on port 3000..."                   |
+-------------------------------------------------------------------+
```

**Filter bar**:
- **Lane dropdown**: Filter sessions to a specific lane, or show all.
- **Status dropdown**: Filter by running, ended, or all.
- **Tool type filter** (future): Filter by detected tool type (Claude, Cursor, shell, etc.).
- **Search field**: Free-text search across session titles and transcript content.

**Session list**:
Each session row displays:
- **Title**: User-provided or auto-generated (from the initial command).
- **Lane name**: Which lane this session belongs to.
- **Status chip**: Green "Running" or gray "Ended".
- **Exit code**: Displayed for ended sessions. Non-zero codes highlighted in red.
- **Timestamp**: When the session started.
- **Last output preview**: Truncated last line(s) of terminal output.

**Session row interactions**:
- Click: Navigate to the Lanes tab with the associated lane selected and this session focused in the terminal panel.
- **Close button** (for running sessions): Send SIGTERM to the PTY.
- **Jump to Lane button**: Switch to the Lanes tab and select this session's lane.

### Lane Terminal Panel

Inside the Lanes tab, each lane has a "Terminals" sub-tab that shows sessions scoped to that specific lane.

**Layout**:
```
+-------------------------------------------------------------------+
| Lane: feature-auth | [Diff] [Terminals] [Packs]                  |
+-------------------------------------------------------------------+
| Sessions for this lane                                            |
| +---------------------------------------------------------------+ |
| | ● npm run dev        Running    14:30                          | |
| |   pytest tests/      Ended (0)  14:15                          | |
| |   cargo build        Ended (1)  13:45                          | |
| +---------------------------------------------------------------+ |
|                                                                   |
| Terminal View (xterm.js)                                          |
| +---------------------------------------------------------------+ |
| | $ npm run dev                                                  | |
| | > project@1.0.0 dev                                            | |
| | > next dev                                                     | |
| |                                                                | |
| | ▲ Ready on http://localhost:3000                               | |
| | ○ Compiling / ...                                              | |
| | ✓ Compiled / in 1.2s                                           | |
| |                                                                | |
| | █                                                              | |
| +---------------------------------------------------------------+ |
|                                                                   |
| [+ New Terminal]                                                  |
+-------------------------------------------------------------------+
```

**Session list** (top):
- Shows all sessions for this lane, sorted by most recent first.
- Click a session to display its terminal view below.
- Running sessions show a green dot. Ended sessions show exit code.

**Terminal view** (bottom):
- Full xterm.js renderer showing PTY output.
- For running sessions: Interactive — user can type commands and see output in real-time.
- For ended sessions: Read-only — shows the captured transcript.

**Create new terminal button**: Spawns a new PTY in this lane's worktree directory and creates a corresponding session record.

### Terminal View

The terminal view is powered by xterm.js and provides a near-native terminal experience in the browser.

**Features**:
- Full ANSI color support (256 colors and true color).
- Unicode and emoji rendering.
- Scrollback buffer (configurable, default 5000 lines).
- Selection and copy (`Cmd+C` / `Ctrl+C` when text is selected).
- Paste (`Cmd+V` / `Ctrl+V`).
- Find in terminal (`Cmd+F` / `Ctrl+F`) — searches the scrollback buffer.
- Resize: Terminal automatically resizes when the pane is resized, sending the new dimensions to the PTY.
- Link detection: URLs in terminal output are clickable.
- Font: Uses the system monospace font, size adjustable via `Cmd+Plus` / `Cmd+Minus`.

### Session Delta Card

When a session ends, ADE computes a delta and displays it as a card below or beside the terminal view.

```
+-----------------------------------------------+
| Session Delta                                  |
|-----------------------------------------------|
| 5 files changed, +142 insertions, -37 deletions|
|                                                |
| Modified:                                      |
|   src/components/App.tsx          +45  -12     |
|   src/utils/helpers.ts            +23   -8     |
|   src/api/routes.ts               +67  -15     |
| Added:                                         |
|   src/components/NewWidget.tsx     +7    -0     |
| Deleted:                                       |
|   src/legacy/oldCode.ts            -2          |
|                                                |
| Potential issues:                              |
|   Line 45: TypeError: Cannot read property...  |
+-----------------------------------------------+
```

**Delta card contents**:
- Summary line: Total files changed, insertions, and deletions.
- Per-file breakdown: File path with individual insertion/deletion counts.
- Change type grouping: Modified, Added, and Deleted files shown separately.
- Potential issues: Lines from the transcript matching failure patterns (error keywords, stack traces, non-zero exit codes).

### Tiling Layout (Future)

A future enhancement will allow multiple terminals to be visible simultaneously in a tiled grid layout.

**Planned capabilities**:
- Split the terminal area horizontally or vertically.
- Each tile shows a different session's terminal.
- Drag tiles to rearrange.
- Resize tiles by dragging dividers.
- Keyboard shortcuts to navigate between tiles.
- Grid view: Overview of all running terminals as small tiles, click to focus.

### Session Lifecycle

The session lifecycle is a 5-step process that integrates PTY management, session tracking, delta computation, and job triggers:

```
1. Create PTY          2. Stream Data           3. Exit
   ┌──────────┐           ┌──────────┐           ┌──────────┐
   │ PTY spawn │──────────►│ xterm.js │──────────►│ PTY exit │
   │ Session   │           │ Transcript│           │ Session  │
   │ created   │           │ capture  │           │ updated  │
   │ HEAD SHA  │           │          │           │ Exit code│
   │ recorded  │           │          │           │ End SHA  │
   └──────────┘           └──────────┘           └──────────┘
                                                       │
                                                       ▼
                                                  4. Delta
                                                  ┌──────────┐
                                                  │ Diff start│
                                                  │ vs end   │
                                                  │ SHA      │
                                                  │ Scan for │
                                                  │ failures │
                                                  └──────────┘
                                                       │
                                                       ▼
                                                  5. Trigger
                                                  ┌──────────┐
                                                  │ Pack     │
                                                  │ refresh  │
                                                  │ job      │
                                                  │ enqueued │
                                                  └──────────┘
```

**Step-by-step**:

1. **Create PTY**: A PTY instance is spawned via `node-pty` in the lane's worktree directory. Simultaneously, a session record is created in the database with `status: 'running'`, `started_at`, and `head_sha_start` (current HEAD of the lane's branch).

2. **Stream Data**: PTY output is streamed to the renderer via IPC events (`ade.pty.data`). xterm.js renders the output in the browser. Simultaneously, all output is appended to the transcript file at `.ade/transcripts/<session-id>.log`.

3. **Exit**: When the PTY process exits (user types `exit`, process terminates, or is killed), the `ade.pty.exit` event fires. The session record is updated with `status: 'ended'`, `ended_at`, `exit_code`, and `head_sha_end`.

4. **Delta Computation**: The session service computes the delta by running `git diff --stat` between `head_sha_start` and the current working tree state. It also scans the transcript for lines matching failure patterns (configurable regex). The delta is stored in the `session_deltas` table.

5. **Trigger**: The job engine is notified that a session has ended. It enqueues a pack refresh job for the lane, ensuring that pack data stays current with the latest changes.

---

## Technical Implementation

### Services

| Service | Responsibility |
|---------|---------------|
| `ptyService` | Creates PTY instances via `node-pty`. Manages the lifecycle of PTY processes (spawn, write, resize, dispose). Streams PTY output to the renderer via IPC events. Captures all output to transcript files at `.ade/transcripts/`. Tracks active PTYs for cleanup on application exit. |
| `sessionService` | CRUD operations for session records in the database. Creates session records when PTYs are spawned. Updates records on PTY exit. Queries sessions by lane, status, or date range. Computes deltas after session end. Provides transcript access (tail, search). |
| `jobEngine` | Receives session-end notifications and enqueues appropriate jobs (pack refresh, checkpoint creation). Manages job scheduling and execution. |

### IPC Channels

**PTY management**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.pty.create` | `(args: { laneId: string, title?: string, cwd?: string, shell?: string, tracked?: boolean }) => PtyCreateResult` | Create a new PTY in the lane's worktree. Set `tracked: false` for untracked sessions. Returns the PTY ID and session ID. |
| `ade.pty.write` | `(args: { ptyId: string, data: string }) => void` | Send user input (keystrokes) to the PTY. |
| `ade.pty.resize` | `(args: { ptyId: string, cols: number, rows: number }) => void` | Resize the PTY when the terminal view changes size. |
| `ade.pty.dispose` | `(args: { ptyId: string }) => void` | Kill the PTY process and clean up resources. |

**PTY events** (streamed from main to renderer):

| Event | Payload | Description |
|-------|---------|-------------|
| `ade.pty.data` | `{ ptyId: string, data: string }` | Output from the PTY process. High-frequency event — may fire hundreds of times per second during heavy output. |
| `ade.pty.exit` | `{ ptyId: string, exitCode: number }` | The PTY process has exited. Includes the exit code. |

**Session management**:

| Channel | Signature | Description |
|---------|-----------|-------------|
| `ade.sessions.list` | `(args: { laneId?: string, status?: string, limit?: number }) => TerminalSessionSummary[]` | List sessions with optional filters. Returns summaries (no transcript content). |
| `ade.sessions.get` | `(sessionId: string) => TerminalSessionDetail \| null` | Get full session details including metadata, delta, and transcript path. |
| `ade.sessions.readTranscriptTail` | `(args: { sessionId: string, lines?: number }) => string` | Read the last N lines of a session's transcript. Used for the "last output preview" in session lists. |
| `ade.sessions.getDelta` | `(sessionId: string) => SessionDeltaSummary \| null` | Get the computed delta for an ended session. Returns null if the session is still running or delta hasn't been computed yet. |

**Type definitions**:

```typescript
interface PtyCreateResult {
  ptyId: string;
  sessionId: string;
}

interface TerminalSessionSummary {
  id: string;
  laneId: string;
  laneName: string;
  title: string;
  status: 'running' | 'ended';
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  lastOutputPreview: string | null;
}

interface TerminalSessionDetail extends TerminalSessionSummary {
  ptyId: string | null;
  transcriptPath: string;
  headShaStart: string | null;
  headShaEnd: string | null;
  delta: SessionDeltaSummary | null;
}

interface SessionDeltaSummary {
  sessionId: string;
  laneId: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  touchedFiles: Array<{
    path: string;
    insertions: number;
    deletions: number;
    changeType: 'M' | 'A' | 'D';
  }>;
  failureLines: string[];
  computedAt: string;
}
```

### Data Streaming Architecture

PTY data streaming is the most performance-critical IPC path in ADE. Terminal output can be extremely bursty (e.g., `cat`-ing a large file produces megabytes of output per second).

**Architecture**:

```
[node-pty process]
       │
       │ (raw bytes, high frequency)
       ▼
[ptyService - main process]
       │
       ├──► Transcript file (append, buffered I/O)
       │
       └──► IPC channel (ade.pty.data)
              │
              ▼
       [preload bridge]
              │
              ▼
       [renderer - xterm.js]
```

**Performance considerations**:
- PTY output is forwarded to the renderer without buffering or batching in the main process. xterm.js is optimized to handle high-throughput input.
- Transcript writes use buffered I/O (Node.js `fs.appendFile` with a write stream) to minimize disk I/O impact.
- When the terminal view is not visible (e.g., another tab is active), output is still captured to the transcript but IPC events may be throttled.

### Transcript Capture Pipeline

Transcripts are captured using a write stream that is opened when the PTY is created and closed when it exits.

```
1. PTY created → Open write stream to .ade/transcripts/<session-id>.log
2. PTY data event → Append raw bytes to write stream
3. PTY exit → Flush and close write stream
4. Update session record with final transcript size
```

The transcript includes raw ANSI escape codes, preserving all formatting information. This enables future features like transcript replay (re-rendering the terminal output with full color and formatting).

### Delta Computation Algorithm

Delta computation runs asynchronously after a session ends. The algorithm:

1. Read the session's `head_sha_start` and the current working tree state.
2. Run `git diff --stat <head_sha_start>` in the lane's worktree to get file-level change statistics.
3. Also diff the working tree (unstaged changes) to capture uncommitted modifications made during the session.
4. Parse the diff output to extract per-file insertions, deletions, and change types.
5. Scan the transcript file for lines matching configurable failure patterns:
   - Common patterns: `Error:`, `FAIL`, `TypeError`, `panic`, `Exception`, stack trace indicators.
   - The failure pattern list is configurable in `.ade/ade.yaml`.
6. Store the computed delta in the `session_deltas` table.

---

## Data Model

### Database Schema

```sql
terminal_sessions (
  id                  TEXT PRIMARY KEY,       -- UUID
  lane_id             TEXT NOT NULL,          -- FK to lanes table
  pty_id              TEXT,                   -- PTY identifier (null after PTY is disposed)
  title               TEXT NOT NULL,          -- User-provided or auto-generated title
  status              TEXT NOT NULL,          -- 'running' | 'ended'
  started_at          TEXT NOT NULL,          -- ISO 8601 timestamp
  ended_at            TEXT,                   -- ISO 8601 timestamp, null if still running
  exit_code           INTEGER,               -- Process exit code, null if still running
  transcript_path     TEXT NOT NULL,          -- Path to transcript file
  head_sha_start      TEXT,                   -- Git HEAD SHA when session started
  head_sha_end        TEXT,                   -- Git HEAD SHA when session ended
  last_output_preview TEXT,                   -- Last few lines of output (for list display)
  FOREIGN KEY (lane_id) REFERENCES lanes(id)
)

session_deltas (
  session_id          TEXT PRIMARY KEY,       -- FK to terminal_sessions
  lane_id             TEXT NOT NULL,          -- FK to lanes table (denormalized for query efficiency)
  files_changed       INTEGER NOT NULL,       -- Number of files with differences
  insertions          INTEGER NOT NULL,       -- Total lines added
  deletions           INTEGER NOT NULL,       -- Total lines removed
  touched_files_json  TEXT,                   -- JSON array of {path, insertions, deletions, changeType}
  failure_lines_json  TEXT,                   -- JSON array of failure line strings
  computed_at         TEXT NOT NULL,          -- ISO 8601 timestamp when delta was computed
  FOREIGN KEY (session_id) REFERENCES terminal_sessions(id),
  FOREIGN KEY (lane_id) REFERENCES lanes(id)
)
```

**Indexes**:

```sql
CREATE INDEX idx_sessions_lane_id ON terminal_sessions(lane_id);
CREATE INDEX idx_sessions_status ON terminal_sessions(status);
CREATE INDEX idx_sessions_started_at ON terminal_sessions(started_at);
CREATE INDEX idx_deltas_lane_id ON session_deltas(lane_id);
```

### Filesystem Artifacts

| Path | Description |
|------|-------------|
| `.ade/transcripts/` | Directory containing all session transcript files |
| `.ade/transcripts/<session-id>.log` | Raw terminal output for a specific session (includes ANSI codes) |

**Transcript file sizing**:
- Typical interactive session: 10 KB - 1 MB
- Heavy output session (build, test suite): 1 MB - 50 MB
- Transcripts are not automatically pruned. A future cleanup policy will archive or delete old transcripts based on age and size thresholds.

---

## Implementation Tracking

### Phase 1 — Core PTY Infrastructure (DONE)

| ID | Task | Status |
|----|------|--------|
| TERM-001 | PTY service (node-pty spawn + management) | DONE |
| TERM-002 | xterm.js terminal rendering | DONE |
| TERM-003 | PTY data streaming (main to renderer) | DONE |
| TERM-004 | PTY input handling (renderer to main) | DONE |
| TERM-005 | PTY resize handling | DONE |
| TERM-006 | Transcript capture to file | DONE |

### Phase 2 — Session Tracking (DONE)

| ID | Task | Status |
|----|------|--------|
| TERM-007 | Session record creation and tracking | DONE |
| TERM-008 | Session status updates (running to ended) | DONE |
| TERM-009 | Exit code recording | DONE |
| TERM-010 | HEAD SHA tracking (start/end) | DONE |
| TERM-011 | Session delta computation | DONE |
| TERM-012 | Session delta card UI | DONE |

### Phase 3 — Global Terminals UI (DONE)

| ID | Task | Status |
|----|------|--------|
| TERM-013 | Global Terminals page with session list | DONE |
| TERM-014 | Lane terminal panel (sub-tab) | DONE |
| TERM-015 | Session filters (lane, status) | DONE |
| TERM-016 | Session search (title, content) | DONE |
| TERM-017 | Jump to lane from session | DONE |
| TERM-018 | Close running session | DONE |
| TERM-019 | Last output preview in session rows | DONE |
| TERM-020 | Session end triggers pack refresh job | DONE |

### Phase 4 — Advanced Features (TODO)

| ID | Task | Status |
|----|------|--------|
| TERM-021 | Tiling layout for multiple terminals | TODO |
| TERM-022 | Split horizontal/vertical | TODO |
| TERM-023 | Drag to rearrange tiles | TODO |
| TERM-024 | Terminal theme sync (dark/light) | DONE |
| TERM-025 | Session goal/purpose tagging | TODO |
| TERM-026 | Tool type detection (Claude, Cursor, etc.) | TODO |
| TERM-027 | Session transcript search | TODO |
| TERM-028 | Transcript upload opt-in (hosted mirror) | DONE — Phase 6 (toggle in SettingsPage, conditional upload in `hostedAgentService.syncTranscripts()`) |
| TERM-029 | Checkpoint creation on session end | TODO |
| TERM-030 | Pin important sessions | TODO |
| TERM-031 | Grid view (multi-terminal overview) | TODO |
| TERM-032 | Untracked session mode | DONE |
