# Terminal Command Center

Last updated: 2026-02-10

This spec defines how ADE manages many terminals across many lanes without becoming chaotic.

## 1. Goals

- Support 3-10+ concurrent sessions without losing context.
- Make it obvious what each session is “for” and what happened.
- Provide both lane-scoped views and an all-terminals command center view.

## 2. Session Model (Metadata)

Each terminal session should record:

- lane id
- title/label (user-set or template)
- goal (optional, user-set; feeds packs)
- agent/tool type (codex/claude/custom)
- start/end timestamps
- head sha start/end
- exit code
- transcript path (local)
- “current status”:
  - running
  - waiting for user input (best-effort detection)
  - completed
  - failed (non-zero exit)

## 3. Views

### 3.1 Lane Terminals (inside Lanes tab)

Per-lane terminal view supports:

- tabbed sessions
- split view (2 terminals) (V1 if needed)
- start new session with template
- show session summary inline after exit

### 3.2 Global Terminals Tab

The global terminals tab supports:

- list view (default):
  - compact rows with: lane, title, status, last output line preview, start time
- grid view:
  - many terminals visible at once
  - only actively focused terminals render full xterm to avoid perf issues
- filters:
  - lane
  - status
  - tool type
  - “has errors”
- pinning:
  - pin important sessions (e.g., long-running agent work)
- jump-to-lane:
  - open lane detail and focus on that session

## 4. “What Is This Terminal Doing?” (Context Surfacing)

We should not rely on trying to fully parse terminal output.

Instead:

- require or strongly encourage a session label/goal at start (one click templates)
- after session ends, compute a deterministic session delta:
  - changed files
  - diff stats
  - commands that exited non-zero (best-effort from transcript)
- generate a hosted narrative “session note” (optional) that feeds the Lane Pack

UI surface:

- a small “session card” in the lane pack:
  - goal
  - key changes
  - failures
  - next steps

## 5. Transcript + Privacy

Defaults:

- transcripts are stored locally
- transcripts are not uploaded unless explicitly enabled

If upload is enabled for hosted proposals:

- redact obvious secret patterns (best-effort)
- allow user to opt out per session

## 6. Performance Constraints

Rendering:

- do not render 20 full xterm instances simultaneously by default
- in grid view, render “live terminals” and show previews for the rest

Storage:

- cap transcript size or rotate logs for long sessions

## 7. Development Checklist

MVP:

- [ ] Session metadata capture (label, lane id, start/end, exit code)
- [ ] Global terminals list view (across lanes)
- [ ] Lane terminals panel in Lanes tab
- [ ] Session delta computation and attach to Lane Pack

V1:

- [ ] Grid view with virtualization
- [ ] Pinning and better filters
- [ ] Hosted “session note” generation and surfacing

