# Terminals & Sessions — Command Center

> Roadmap reference: `docs/final-plan.md` is the canonical future plan and sequencing source.

> Last updated: 2026-02-18

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
  - [Tiling Layout](#tiling-layout)
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

The combination of session tracking and delta computation is a foundational capability that feeds into other ADE features: the History tab uses sessions as nodes in the development timeline, Packs are refreshed when sessions end, and checkpoint creation is already triggered by tracked session boundaries.

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
- **Goal**: A short human-readable intent/purpose string (distinct from the auto-generated title).
- **Tool type**: Detected or specified tool type (`shell`, `claude`, `codex`, `cursor`, `aider`, `continue`, `other`). Used for filtering and display.
- **Tracked/Pinned**: Whether the session captures transcripts (`tracked`) and whether it is pinned for visibility (`pinned`).
- **Timing**: Start time, end time, duration.
- **State**: `running`, `completed`, `failed`, or `disposed`. Exit code.
- **Git context**: HEAD SHA at session start and end (enabling delta computation).
- **Transcript path**: Location of the captured output file.
- **Preview**: Last few lines of output (ANSI-stripped) for display in lists without reading the full transcript.
- **Summary**: A deterministic one-line summary generated when the session ends (via `sessionSummary.ts`, ANSI-stripped). Examples: `Ran npm test (PASS, 31 tests, 1.2s)`, `Ran npm install (FAIL, exit code 1, EACCES permission denied)`, `Ran cargo build (OK)`. The summarizer detects Jest, Vitest, and pytest output formats for test summaries.

When AI is available and the `terminal_summaries` feature toggle is enabled, ADE generates an AI-enhanced summary in addition to the deterministic one. The AI summary provides:
- **Intent detection**: What the developer was trying to accomplish (e.g., "debugging auth middleware timeout", "setting up Docker environment")
- **Outcome assessment**: Whether the goal was achieved, partially achieved, or failed
- **Key findings**: Important discoveries, errors, or configuration changes made during the session
- **Next steps**: Suggested follow-up actions based on the session outcome

The AI summary is generated asynchronously after the session ends using the configured `terminal_summaries` provider (default: Claude). It does not block the session end flow. The deterministic summary is always generated first and displayed immediately; the AI summary appears when ready and is stored alongside the deterministic one.

### Transcript

A **transcript** is the raw terminal output saved to disk at `.ade/transcripts/<session-id>.log`. Every byte written by the PTY to stdout is appended to this file. Transcripts are stored raw (including ANSI escape codes for color/cursor control).

User-facing excerpts derived from transcripts (previews, failure lines, summaries) are **sanitized** before display:
- ANSI escape sequences are stripped.
- Carriage-return line rewrites and backspaces are normalized so the output reads like plain text.

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
| `failure_lines` | ANSI-stripped, de-duplicated lines from the transcript matching common failure patterns (stack traces, error keywords) |

### Checkpoint

A **checkpoint** is an immutable snapshot created at a tracked session boundary. On session end, ADE records checkpoint metadata (including SHA anchors and delta context) through the pack pipeline, enabling durable history, replay context, and rollback-oriented workflows described in the History/Packs docs.

### Untracked Session

An **untracked session** is a terminal launched with context recording disabled. Its output is not captured to a transcript, no session delta is computed on exit, no checkpoint is created, and no pack refresh is triggered. Untracked sessions are useful for:

- Quick one-off commands that don't warrant context overhead (e.g., `ls`, `cat`, `top`)
- Sensitive operations where transcript capture is undesirable (e.g., entering credentials, viewing secrets)
- Debugging or exploration that the developer explicitly wants excluded from project history

Untracked sessions still appear in the session list (marked with a "no context" badge) so the developer can see what's running, but they produce no persistent artifacts. Terminals can be launched either with context (tracked) or without context (untracked).

**Implementation note**: When `tracked: false` is passed to `ade.pty.create`, the PTY service skips transcript file creation, the session service skips delta computation on exit, and the job engine receives no session-end trigger.

---

## User Experience

### Terminals Tab (Global)

The Terminals tab provides a centralized view of all terminal sessions across all lanes in the project, using a `PaneTilingLayout` with 3 panes: session list (28%), terminal view (top-right 70%), and details (bottom-right 30%).

```
+--------------------+----------------------------------------------+
| Session List       |  Terminal View                               |
| (~28%)             |  (xterm.js, ~70% of right)                   |
|                    |                                              |
| [Filters]          +----------------------------------------------+
| [session rows]     |  Session Details                             |
|                    |  (delta card, metadata, ~30% of right)       |
+--------------------+----------------------------------------------+
```

**Filter bar**:
- **Lane dropdown**: Filter sessions to a specific lane, or show all.
- **Status dropdown**: Filter by running, completed, failed, disposed, or all.
- **Search field**: Free-text search across session titles and content.

**Session list**:
Each session row displays:
- **Title/Goal**: Goal (if set) takes precedence, falling back to auto-generated title. Ended sessions show a composite label: `toolType · exit status · summary`.
- **Lane name**: Which lane this session belongs to.
- **Status chip**: Green "Running" (with green dot), gray "Ended"/"Completed", red "Failed", muted "Disposed".
- **Exit code**: Displayed for ended sessions. Non-zero codes highlighted in red.
- **Timestamp**: When the session started.
- **Tool type**: Detected tool type badge (claude, codex, shell, etc.).
- **Last output preview**: Truncated last line(s) of terminal output.

**Session row interactions**:
- Click: Select session and show terminal view / details in adjacent panes.
- **Close button** (for running sessions): Dispose the PTY (sends SIGTERM).
- **Jump to Lane button**: Navigate to the Lanes tab and select this session's lane.
- **Transcript button**: View raw transcript for ended sessions.

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

**Quick launch buttons**: One-click launch for common agent tools (Claude Code, Codex) and a plain Shell. A settings cog in the terminal area allows:
- Toggle "launch with context" vs "without context" defaults
- Manage the quick buttons (add/remove custom commands)

**Close button per tab**: Running sessions have an explicit close (kill) button per tab/session.

**Session summary**: Sessions are labeled by a short, human-readable goal/intent (not internal IDs or jargon).

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
|                                                |
| AI Summary (when available):                   |
| "Set up Docker environment for local dev.      |
|  Successfully configured docker-compose with   |
|  Postgres and Redis. Tests pass. Next: add     |
|  health check endpoints."                      |
+-----------------------------------------------+
```

**Delta card contents**:
- Summary line: Total files changed, insertions, and deletions.
- Per-file breakdown: File path with individual insertion/deletion counts.
- Change type grouping: Modified, Added, and Deleted files shown separately.
- Potential issues: Lines from the transcript matching failure patterns (error keywords, stack traces, non-zero exit codes).

### Tiling Layout

A lightweight tiling mode allows multiple running terminals to be visible simultaneously in a tiled grid layout.

**Current capabilities** (Phase 8, `TilingLayout.tsx`):
- Toggle between a tab view (single focused session) and a tiling grid view.
- Recursive binary tree layout: sessions are split into a balanced tree with alternating horizontal/vertical directions at each depth level.
- Each tile shows a running session terminal with focus ring, title overlay (visible on hover for running sessions), and close button.
- Ended sessions display title, status, and exit code in a centered placeholder.
- Split panes use `react-resizable-panels` with proportional sizing based on leaf count.
- Tile focus: click a tile to set it as active (highlighted with accent ring).

**Deferred enhancements**:
- Full drag-to-rearrange of tiles.
- Keyboard navigation between tiles beyond the global focus model.

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

4. **Delta Computation**: The session service computes the delta by running `git diff --stat` between `head_sha_start` and the current working tree state. It also scans the transcript for lines matching failure patterns (configurable regex). In parallel it generates a deterministic one-line `summary` (ANSI-stripped) and stores it on the session record. The delta is stored in the `session_deltas` table.

5. **Trigger**: The job engine is notified that a session has ended. It enqueues a pack refresh job for the lane, ensuring that pack data stays current with the latest changes.

6. **AI Summary** (optional): If the `terminal_summaries` feature toggle is enabled and an AI provider is available, the AI integration service generates an enhanced summary from the transcript tail and delta data. The AI summary is stored on the session record alongside the deterministic summary.

---

## Technical Implementation

### Services

| Service | Responsibility |
|---------|---------------|
| `ptyService` | Creates PTY instances via `node-pty`. Manages the lifecycle of PTY processes (spawn, write, resize, dispose). Streams PTY output to the renderer via IPC events. Captures all output to transcript files at `.ade/transcripts/`. Tracks active PTYs for cleanup on application exit. On session end, generates deterministic summary via `sessionSummary.ts` and strips ANSI via `ansiStrip.ts`. |
| `sessionService` | CRUD operations for session records in the database. Creates session records when PTYs are spawned. Updates records on PTY exit (with status: completed/failed/disposed). Queries sessions by lane, status, or date range. Computes deltas after session end. Provides transcript access (tail, search). Supports `updateMeta` for goal and tool type. |
| `ansiStrip.ts` | Utility for stripping ANSI escape sequences (CSI, OSC, charset, two-char escapes), carriage returns, and backspace rewrites from terminal output. Used by ptyService and pack generation. |
| `sessionSummary.ts` | Deterministic session summary generator. Detects likely commands from transcript prompts, parses test output (Jest, Vitest, pytest), identifies failure hints. Produces one-line summaries like `Ran npm test (PASS, 31 tests, 1.2s)`. |
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
| `ade.sessions.list` | `(args: { laneId?: string, status?: TerminalSessionStatus, limit?: number }) => TerminalSessionSummary[]` | List sessions with optional filters. Returns summaries (no transcript content). |
| `ade.sessions.get` | `(sessionId: string) => TerminalSessionDetail \| null` | Get full session details including metadata, delta, and transcript path. |
| `ade.sessions.updateMeta` | `(args: UpdateSessionMetaArgs) => void` | Update session goal, tool type, or other metadata. |
| `ade.sessions.readTranscriptTail` | `(args: { sessionId: string, lines?: number }) => string` | Read the last N lines of a session's transcript. Used for the "last output preview" in session lists. |
| `ade.sessions.getDelta` | `(sessionId: string) => SessionDeltaSummary \| null` | Get the computed delta for an ended session. Returns null if the session is still running or delta hasn't been computed yet. |

**Type definitions**:

```typescript
type PtyCreateResult = {
  ptyId: string;
  sessionId: string;
};

type TerminalSessionStatus = "running" | "completed" | "failed" | "disposed";

type TerminalToolType = "shell" | "claude" | "codex" | "cursor" | "aider" | "continue" | "other";

type TerminalSessionSummary = {
  id: string;
  laneId: string;
  laneName: string;
  ptyId: string | null;
  tracked: boolean;
  pinned: boolean;
  goal: string | null;
  toolType: TerminalToolType | null;
  title: string;
  status: TerminalSessionStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  transcriptPath: string;
  headShaStart: string | null;
  headShaEnd: string | null;
  lastOutputPreview: string | null;
  summary: string | null;
};

type TerminalSessionDetail = TerminalSessionSummary & {
  // Reserved for future expansion
};

type SessionDeltaSummary = {
  sessionId: string;
  laneId: string;
  startedAt: string;
  endedAt: string | null;
  headShaStart: string | null;
  headShaEnd: string | null;
  filesChanged: number;
  insertions: number;
  deletions: number;
  touchedFiles: string[];
  failureLines: string[];
  computedAt: string | null;
};
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
   - Captured failure lines are ANSI-stripped, normalized (carriage returns/backspaces), and de-duplicated before storage.
6. Store the computed delta in the `session_deltas` table.

---

## Data Model

### Database Schema

```sql
terminal_sessions (
  id                  TEXT PRIMARY KEY,       -- UUID
  lane_id             TEXT NOT NULL,          -- FK to lanes table
  pty_id              TEXT,                   -- PTY identifier (null after PTY is disposed)
  tracked             INTEGER NOT NULL DEFAULT 1, -- 1 = tracked (transcript capture + delta), 0 = untracked
  pinned              INTEGER NOT NULL DEFAULT 0, -- 1 = pinned (always visible in session list)
  goal                TEXT,                   -- User-provided goal/intent string
  tool_type           TEXT,                   -- 'shell' | 'claude' | 'codex' | 'cursor' | 'aider' | 'continue' | 'other'
  title               TEXT NOT NULL,          -- User-provided or auto-generated title
  status              TEXT NOT NULL,          -- 'running' | 'completed' | 'failed' | 'disposed'
  started_at          TEXT NOT NULL,          -- ISO 8601 timestamp
  ended_at            TEXT,                   -- ISO 8601 timestamp, null if still running
  exit_code           INTEGER,               -- Process exit code, null if still running
  transcript_path     TEXT NOT NULL,          -- Path to transcript file
  head_sha_start      TEXT,                   -- Git HEAD SHA when session started
  head_sha_end        TEXT,                   -- Git HEAD SHA when session ended
  summary             TEXT,                   -- Deterministic one-line summary (ANSI-stripped). Null while running.
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

### Phase 4 — Advanced Features

| ID | Task | Status |
|----|------|--------|
| TERM-021 | Tiling layout for multiple terminals | DONE — Phase 8 (`TilingLayout.tsx` with `react-resizable-panels`, recursive binary tree layout) |
| TERM-022 | Split horizontal/vertical | DONE — Phase 8 (alternating horizontal/vertical splits based on tree depth in TilingLayout) |
| TERM-023 | Drag to rearrange tiles | PARTIAL — resizable split panes implemented; full drag-to-rearrange deferred to Phase 9 |
| TERM-024 | Terminal theme sync (dark/light) | DONE — Phase 8 (light/dark xterm themes derived from app theme in `TerminalView.tsx`) |
| TERM-025 | Session goal/purpose tagging | DONE — Phase 8 (`goal` field on session records, displayed in session labels and delta cards) |
| TERM-026 | Tool type detection (Claude, Cursor, etc.) | DONE — Phase 8 (`toolType` field: shell/claude/codex/cursor/aider/continue/other; set via launch profiles or `updateMeta`) |
| TERM-027 | Session transcript search | TODO — **moved to Phase 9** |
| TERM-028 | Transcript upload opt-in (hosted mirror) | REMOVED — transcript upload was part of the hosted backend, which has been fully removed. Transcripts are stored locally only. |
| TERM-029 | Checkpoint creation on session end | DONE — Phase 8 (checkpoints created via packService on session end; indexed in SQLite `checkpoints` table) |
| TERM-030 | Pin important sessions | DONE — Phase 8 (`pinned` column on session records; pinned sessions stay visible in list) |
| TERM-031 | Grid view (multi-terminal overview) | DONE — Phase 8 (tiling grid view via `TilingLayout.tsx`, toggled from tab view in `LaneTerminalsPanel`) |
| TERM-032 | Untracked session mode | DONE |

### Phase 8 Additions

| ID | Task | Status |
|----|------|--------|
| TERM-033 | PaneTilingLayout for TerminalsPage | DONE — Phase 8 (3-pane layout: sessions, terminal, details) |
| TERM-034 | Quick-launch terminal profiles (Claude/Codex/Shell) | DONE — Phase 8 (one-click launch buttons in LaneTerminalsPanel, configurable via `ade.terminalProfiles.*`) |
| TERM-035 | Session summary generator (`sessionSummary.ts`) | DONE — Phase 8 (deterministic summaries with Jest/Vitest/pytest detection, command extraction, failure hints) |
| TERM-036 | ANSI strip utility (`ansiStrip.ts`) | DONE — Phase 8 (CSI/OSC/charset/backspace stripping, used for previews and summaries) |
| TERM-037 | Session update meta IPC (`ade.sessions.updateMeta`) | DONE — Phase 8 (update goal, tool type post-creation) |
| TERM-038 | xterm viewport safety patches | DONE — Phase 8 (patch `_innerRefresh` and `syncScrollArea` to prevent teardown crashes in `TerminalView.tsx`) |
| TERM-039 | AI-enhanced session summaries via AgentExecutor | TODO — AI summary generation from transcript tail and delta data, stored alongside deterministic summary |
| TERM-040 | AI summary display in session cards and delta cards | TODO — AI summary section in delta card UI, shown below deterministic summary when available |
