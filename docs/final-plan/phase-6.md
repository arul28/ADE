# Phase 6: Multi-Device Sync & iOS Companion

## Phase 6 -- Multi-Device Sync & iOS Companion (8-10 weeks)

Goal: Ship end-to-end multi-device ADE with a polished iOS app for project management. Any Mac can be a brain (runs agents), any other Mac or iPhone can be a viewer/controller. Sync is peer-to-peer via cr-sqlite CRDTs over WebSocket — no cloud. By the end of this phase a user can pick up their iPhone and manage their project with high-parity Lanes, Files, Work, and PRs tabs while their Mac Studio runs agents in the background.

### Reference docs

- [architecture/DESKTOP_APP.md](../architecture/DESKTOP_APP.md) — main process service graph, database, startup contract
- [architecture/MEMORY.md](../architecture/MEMORY.md) — unified memory schema, embedding service, CTO core memory
- [architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — agent runtimes, orchestrator, MCP tools
- [features/CTO.md](../features/CTO.md) — CTO state, daily logs, Linear sync
- [features/CHAT.md](../features/CHAT.md) — agent chat sessions, providers, attachments

### Dependencies

- Phases 1-5 complete (single-device operation is stable and shipping).

---

### Architecture Overview

#### The Brain Model

- One machine per project is the **brain** — it runs agents, missions, orchestrator processes, CTO heartbeats, Linear sync, and all AI compute.
- Any Mac (laptop, Mac Studio, Mac Mini) or VPS can be a brain. Phones cannot.
- All other connected devices are **viewers/controllers** — they see full state in real-time and can issue commands. The brain does the work.
- Brain designation is explicit: the user chooses which machine is the brain in Settings > Devices. Only one brain per project at a time.
- Brain can be transferred between machines via a structured handoff protocol.

#### Sync Architecture

- **cr-sqlite** (SQLite CRDT extension) provides conflict-free replication for all **103 database tables** (see current schema in `kvDb.ts`).
- cr-sqlite is a SQLite extension loaded into the existing sql.js WASM runtime on desktop and native SQLite on iOS — zero changes to existing SQL code.
- Tables are marked as CRRs (Conflict-free Replicated Relations): `SELECT crsql_as_crr('table_name')`.
- cr-sqlite generates changesets transported via WebSocket to connected peers.
- Each device maintains its own full SQLite database. cr-sqlite merges changes automatically using last-writer-wins per column with Lamport timestamps.
- The FTS4 virtual table (`unified_memories_fts`) is **not** marked as a CRR — each device rebuilds its FTS index from the synced `unified_memories` table.
- **All 103 tables are synced to all devices** (desktop and iOS alike). The sync layer is comprehensive — what varies between devices is the UI, not the data. This keeps the sync protocol simple and ensures any future iOS tab can read its data immediately without sync changes.

#### Future-Proofing: Sync Once, UI Later

The sync infrastructure syncs all tables to all device types. This is a deliberate architectural choice:

- **Adding a new table** to the desktop app requires one line (`SELECT crsql_as_crr('new_table')`) and the data flows to all devices automatically.
- **Adding a new column** to an existing table requires no sync changes — cr-sqlite handles new columns transparently.
- **Adding a new iOS tab** (Phase 7) requires only SwiftUI work — the data is already on the device.
- **Adding a new command type** (e.g., "launch mission" from iOS in Phase 7) requires one command handler on the brain.

This means Phase 6 sync work is a one-time investment. Phase 7 iOS tabs are pure UI work with zero sync layer changes.

#### What Syncs vs What Doesn't

- **Syncs via cr-sqlite** (all database state):
  - Mission state, steps, events, interventions, artifacts, chat messages
  - Lane metadata (name, branch, status, assignment, agent run state)
  - CTO identity, core memory, session logs, flow policies
  - Worker agent identities, revisions, task sessions, runs, cost events
  - Unified memories, embeddings metadata
  - Linear sync state, issue snapshots, dispatch queue, workflow runs
  - AI usage logs, budget records, external MCP usage events
  - PR state, conflict predictions, integration proposals
  - Settings, pack metadata, phase cards, phase profiles
  - Orchestrator runs, steps, claims, decisions, worker digests, reflections, retrospectives
  - Terminal session metadata, session deltas
  - Process definitions, test suites, test runs
  - All other tables in `kvDb.ts`
- **Syncs via git** (code, desktop peers only):
  - Source code files in working trees
  - `.ade/agents/*.yaml`, `.ade/context/`, `.ade/local.yaml`
- **Does NOT sync** (machine-specific):
  - `.ade/local.secret.yaml` (API keys, external MCP configs)
  - Worktree physical directories
  - PTY processes and terminal output streams
  - `.ade/cto/daily-logs/` files (brain-only, summaries sync via cr-sqlite)
  - Transcript files, cache, embedding model weights
  - Running process state, mcp.sock

#### CTO & Worker Agent Reachability

- **Agent state syncs via cr-sqlite**: identities, memory entries, run status, chat messages, org chart, cost events, Linear workflow state. Any device sees the full picture in real-time.
- **Agent execution is brain-only**: CTO heartbeats, Linear polling, worker activations, mission orchestration, embedding worker — all run on the brain. Non-brain devices never spawn agent processes.
- **Command routing for agent chat**: user sends a message from phone or viewer Mac → message written locally → cr-sqlite syncs to brain → WebSocket command triggers brain to process → agent response written on brain → cr-sqlite syncs back to all peers.
- **Linear credentials are brain-only**: API tokens live in `.ade/local.secret.yaml` (machine-specific, never synced). Only the brain needs them.

#### `.ade/` Folder Structure

```
.ade/
├── agents/            # Git-tracked: agent identity YAML files
├── identities/        # Git-tracked: user identity configs
├── context/           # Git-tracked: PRD.ade.md, ARCHITECTURE.ade.md
├── local.yaml         # Git-tracked: project config (no secrets)
├── local.secret.yaml  # Gitignored: machine-specific secrets
├── ade.db             # cr-sqlite synced: ALL app state (gitignored)
├── ade.db-wal         # WAL file (gitignored)
├── mcp.sock           # Runtime socket (gitignored)
├── cto/
│   ├── core-memory.json  # Dual-persisted (also in cr-sqlite)
│   └── daily-logs/       # Brain-only markdown logs (gitignored)
├── transcripts/       # Machine-specific logs (gitignored)
├── cache/             # Machine-specific cache (gitignored)
├── worktrees/         # Machine-specific lane checkouts (gitignored)
└── secrets/           # Machine-specific secrets (gitignored)
```

#### iOS App Scope (Phase 6)

The Phase 6 iOS app ships **four high-parity tabs** that provide complete project management from the phone:

| Tab | Desktop equivalent | What it does on iOS |
|-----|-------------------|---------------------|
| **Lanes** | `/lanes` | Full lane list with status, branch info, agent assignment, dirty/ahead/behind indicators. Create and archive lanes. View lane details. On non-brain: lane availability states (Local/Behind/Live/Remote only). |
| **Files** | `/files` | Full file browser with directory tree, syntax-highlighted file viewer, file search, basic file editing (sends edits to brain). High parity with desktop file explorer. |
| **Work** | `/work` | Terminal session list, read-only terminal output viewing (streamed from brain via WebSocket), session metadata. Quick-launch actions that route to brain. |
| **PRs** | `/prs` | PR list with status, merge readiness, CI checks. PR detail view with diff. Create PR (routes to brain). Merge/close actions. Stacked PR visualization. |

**Not in Phase 6 iOS** (deferred to Phase 7):
- Missions tab (mission management, intervention approval, launch)
- CTO tab (agent chat, org chart, identity management)
- Chat tab (ad-hoc agent chat sessions)
- Automations tab
- Graph tab
- History tab
- Settings tab (beyond basic device/connection settings)

This scoping is intentional: Lanes + Files + Work + PRs give full project management from the phone. The AI orchestration tabs (Missions, CTO, Chat) come in Phase 7 once the project management foundation is proven.

---

### Workstreams

#### W1: cr-sqlite Integration

- Load cr-sqlite extension into the existing sql.js WASM runtime used by `kvDb.ts`.
- Mark all 103 existing tables as CRRs via migration: `SELECT crsql_as_crr('table_name')` for each table.
- Exclude FTS4 virtual table (`unified_memories_fts`) from CRR marking — FTS indexes are rebuilt locally from synced content.
- Verify zero breaking changes to existing SQL operations across all service files.
- Add changeset extraction: `SELECT * FROM crsql_changes WHERE db_version > ?` for incremental sync.
- Add changeset application: `INSERT INTO crsql_changes(...)` to apply remote changes.
- Add site ID management for device identity in the CRDT merge (one unique site ID per device).
- Add FTS rebuild trigger: after applying remote changesets that touch `unified_memories`, rebuild affected FTS rows.

#### W2: WebSocket Sync Server & Protocol

- Brain machine runs a WebSocket server (default port 8787) embedded in the Electron main process.
- Protocol: authenticated WebSocket with JSON-framed cr-sqlite changesets.
- Connection flow:
  1. Peer connects with pairing token + device type (desktop/iOS)
  2. Brain validates token
  3. Peer sends its `db_version`
  4. Brain sends all changesets since that version
  5. Continuous bidirectional sync begins
- Brain watches for local DB changes via WAL hook or short-interval polling, extracts changesets, broadcasts to all connected peers.
- Peers send their local changes (commands, chat messages) to brain; brain applies and rebroadcasts to other peers.
- Automatic reconnection with version-based catch-up on connection drops.
- Changeset compression (zlib) for batches over slow or metered connections.
- Heartbeat ping/pong (30s interval) for connection health monitoring.
- **File access sub-protocol**: request/response for on-demand file reads, directory listings, and file writes. Used by iOS Files tab and desktop remote file viewing.
- **Terminal stream sub-protocol**: subscribe to terminal session output from brain. Used by iOS Work tab for read-only terminal viewing.

#### W3: Device Registry & Brain Management

- New `devices` table (synced): device_id, name, platform (`macOS` / `iOS` / `linux`), device_type (`desktop` / `phone` / `vps`), last_seen, is_brain, ip_addresses, tailscale_ip.
- Brain election: explicit user action — "Make this device the brain" in Settings > Devices.
- Brain transfer protocol:
  1. Current brain stops all agents and orchestrator processes
  2. Final sync flush to all connected peers
  3. Brain flag transfers to new device
  4. New brain starts accepting agent work
- Brain status broadcast: brain periodically announces running missions, active agents, resource usage, and uptime to all peers.
- Device discovery: mDNS/Bonjour for zero-config LAN discovery. Tailscale IPs used when LAN fails.
- Device configuration UI in Settings > Devices:
  - Add device (shows pairing flow)
  - Configure device type and role
  - Remove device (revokes pairing, disconnects)
  - Transfer brain designation
  - View per-device sync status (last seen, sync lag)

#### W4: Device Pairing & Network

- First-time pairing: brain generates a **QR code** (encodes brain IP/port + one-time pairing token) or a **6-digit numeric code** for manual entry.
- Pairing establishes a shared secret stored in OS keychain (macOS Keychain / iOS Keychain).
- After pairing, devices reconnect automatically on every app launch — no re-auth.
- **Tailscale integration** (optional):
  - ADE detects Tailscale IPs (100.64.x.x) automatically and uses them when LAN discovery fails.
  - Peer-to-peer WireGuard encrypted traffic — no cloud relay.
  - Self-hostable control plane via Headscale for zero cloud dependency.
  - Tailscale is never required — LAN-only users skip it entirely.
- **VPS brain deployment**:
  - ADE runs headlessly on a VPS via `xvfb-run electron .` (~200MB RAM overhead, zero code changes).
  - Systemd service file for auto-restart on crash.
  - VPS brain works identically to a desktop brain — other devices connect via Tailscale, direct IP, or VPN.
  - Deployment guide: install Node.js, clone repo, install deps, configure as brain, pair devices remotely.
- Remove device: revokes pairing token, device can no longer connect, entry removed from registry.

#### W5: iOS App Shell & Core Navigation

- Native **SwiftUI** application targeting iOS 17+.
- cr-sqlite embedded via SQLite.swift wrapper with cr-sqlite extension loaded natively.
- WebSocket client for brain connection — reuses the same protocol from W2.
- Local SQLite database as a cr-sqlite peer — all tables synced, full state available offline.
- Pairing flow: open iOS app → scan QR code displayed on brain → token stored in iOS Keychain → connected.
- **Four-tab navigation**: Lanes, Files, Work, PRs.
- Persistent connection status header: brain name, connection state, sync indicator.
- Pull-to-refresh triggers manual sync check.
- Background app refresh for periodic state sync when app is backgrounded.
- Basic Settings screen (accessible from profile/gear icon): paired devices list, connection info, disconnect.

#### W6: iOS Lanes Tab

High-parity SwiftUI implementation of the desktop Lanes page.

- **Lane list**: all lanes with name, branch, dirty/ahead/behind indicators, agent assignment badge, mission link.
- **Lane detail view**: full lane info — branch, status, recent commits, assigned agent and status, linked mission/step.
- **Create lane**: name + base branch input → command routes to brain → brain creates worktree → metadata syncs back.
- **Archive/unarchive lane**: swipe action or detail view button.
- **Lane availability states** (when connected to brain from a non-brain device):
  - Local, Behind, Live on [device], Remote only, Push pending, Offline
  - Computed from cr-sqlite metadata + brain status
  - "Sync to this Mac" not applicable on iOS (no worktrees), but state is displayed for awareness
- **Agent status per lane**: if an agent is running on a lane, show provider, model, current step, duration.
- **Search and filter**: filter by status (active/archived), search by name.
- **Swipe gestures**: swipe to archive, long-press for quick actions.

#### W7: iOS Files Tab

High-parity SwiftUI implementation of the desktop Files page.

- **File tree browser**: hierarchical project directory tree fetched on-demand from brain via file access sub-protocol. Lazy-loaded — only expanded directories fetch contents.
- **Syntax-highlighted file viewer**: full syntax highlighting for common languages (Swift, TypeScript, Python, Rust, Go, Java, HTML/CSS, JSON, YAML, Markdown). Line numbers, word wrap toggle.
- **File search**: fuzzy filename search across the project. Search request routes to brain, results displayed on phone.
- **Basic file editing**: tap "Edit" on any text file → simple text editor for quick fixes. Edit routes to brain, brain writes to disk, git tracks the change. Not a full IDE — intentionally minimal for config tweaks and typo fixes.
- **Diff viewer**: view pending changes (unstaged/staged) per file with syntax-highlighted unified diff.
- **File metadata**: size, last modified, last commit touching this file.
- **Binary file preview**: images rendered inline, other binary files show metadata only.

#### W8: iOS Work Tab

High-parity SwiftUI implementation of the desktop Work page.

- **Terminal session list**: all active and recent terminal sessions from the brain, showing session name, lane, status (running/exited), last output timestamp.
- **Read-only terminal output**: tap a session to view its output streamed in real-time from the brain via the terminal stream sub-protocol. Monospace rendering with ANSI color support.
- **Session metadata**: start time, duration, exit code (if finished), associated lane.
- **Quick-launch actions**: predefined commands (e.g., "npm test", "npm run build") that route to the brain for execution. Brain spawns the process, output streams back to the phone.
- **Session search**: search across session output (search request routes to brain).
- **Pull-to-refresh**: refreshes session list and reconnects any dropped terminal streams.

#### W9: iOS PRs Tab

High-parity SwiftUI implementation of the desktop PRs page.

- **PR list**: all open PRs with title, branch, status (open/merged/closed), CI check status (pass/fail/pending), review status, merge readiness indicator.
- **PR detail view**: full PR info — title, description, branch, base, commits, file changes, CI checks, reviewers.
- **Diff viewer**: per-file syntax-highlighted unified diffs. Swipe between changed files. Line count badges.
- **PR actions** (route to brain):
  - Create PR: select lane → title + description input → brain runs `gh pr create`.
  - Merge: merge button with strategy selector (merge/squash/rebase) → brain executes.
  - Close: close PR with optional comment.
  - Request review: add reviewers.
- **Stacked PR visualization**: if lanes use stacking, show the stack order and per-PR status.
- **CI check details**: tap a check to see its log output (fetched from brain/GitHub).
- **Pull-to-refresh**: refreshes PR state from GitHub via brain.

#### W10: Command Routing & Connection Status

**Command routing:**
- When any non-brain device issues a command:
  - **State-only operations** (create lane metadata, update settings): write locally, cr-sqlite syncs to brain and all peers.
  - **Execution operations** (create worktree, run terminal command, create PR, merge PR, git operations): send command over WebSocket to brain. Brain executes, state changes sync back via cr-sqlite.
- Command acknowledgment: brain confirms receipt and execution start.
- Command failure: brain returns error, originating device shows actionable error with retry option.
- Offline command queue: if device is disconnected, execution commands queue locally and replay on reconnect (in order, with conflict detection).

**Connection status (desktop):**
- Always-visible status indicator in the top bar:
  - **Brain** — "Running locally" with device count badge
  - **Connected** — "Connected to [device-name]" with sync indicator
  - **Disconnected** — "Offline — last synced [timestamp]"
  - **Syncing** — "Syncing..." with progress during large catch-ups
- Click status bar → opens device management panel with full device list and sync status.
- Connection quality indicator (latency, sync lag, last changeset timestamp).

**Connection status (iOS):**
- Persistent connection indicator in the header across all tabs.
- Same four states as desktop, adapted for mobile UI.
- Connection lost → banner with "Reconnecting..." and auto-retry.

#### W11: Lane Portability (Desktop-to-Desktop)

Lane portability makes multi-device desktop development seamless. This workstream applies to desktop peers — iOS shows lane status but does not create worktrees.

**Core mechanics:**
- Lane metadata (name, branch, status, agent assignment) syncs via cr-sqlite — instant and automatic.
- Worktree physical directories are machine-specific — NOT synced. Each Mac creates its own from the git branch.
- Code syncs via git (push from brain → pull on viewer). Requires explicit action or auto-push policy.

**Auto-push policy** (configurable per project in Settings):
- `on-commit` (default): push after every commit. Code available on other devices within seconds.
- `on-agent-complete`: push when agent finishes work on the lane. Cleaner mid-work history.
- `manual`: never auto-push. User pushes explicitly.
- Push failure: lane flagged as "push pending," retried on next connectivity.

**Lane availability states** (computed per device from cr-sqlite metadata + local git state):

| State | Meaning | Actions |
|-------|---------|---------|
| **Local** | Branch synced, worktree exists, no remote agents running | Full local dev |
| **Behind** | Brain has commits not yet pulled | "Sync to this Mac" (one-click) |
| **Live on [device]** | Agent actively running on brain | View remotely, chat with agent, auto-sync when done |
| **Remote only** | Lane exists on brain, never pulled | "Bring to this machine" (one-click) |
| **Push pending** | Brain has unpushed commits | Wait or request push |
| **Offline** | Brain unreachable, code state unknown | View cached metadata, work on local lanes |

**One-click lane sync** ("Sync to this Mac"):
1. If brain has unpushed commits → command brain to `git push`
2. Local device runs `git fetch origin`
3. Create local worktree from branch ref
4. Lane transitions to Local — full dev enabled

**Agent-running guard:**
- When an agent is active on a lane on the brain, local worktree creation is blocked on other Macs.
- "Auto-sync when done" registers intent: agent completes → auto-push → auto-fetch → worktree created → system notification.
- Reverse guard: warns if launching a remote agent on a locally-checked-out lane (prevents divergent changes).

**Device sync summary:**
- Shown as a dismissible overlay when a non-brain Mac connects to the brain.
- Shows per-lane availability state, agent progress, and sync actions.
- "Sync all ready lanes" bulk-syncs all non-live lanes.

#### W12: Validation

**cr-sqlite:**
- Mark all tables as CRRs, verify zero SQL breakage across all services.
- Generate changesets, apply to second database, verify identical state.
- Concurrent writes from two peers, verify CRDT merge correctness.
- FTS rebuild after remote changeset application.

**WebSocket sync:**
- Connection, authentication, changeset exchange.
- Reconnection with version-based catch-up.
- Compression, heartbeat, connection timeout.
- Multiple peers connected simultaneously.
- File access sub-protocol: request file, receive content, verify integrity.
- Terminal stream sub-protocol: subscribe, receive output, handle disconnection.

**iOS app — Lanes tab:**
- Lane list displays all lanes with correct status indicators.
- Create lane from phone → brain creates worktree → lane appears on phone.
- Archive lane from phone → reflected on desktop.
- Lane availability states display correctly for non-brain connections.

**iOS app — Files tab:**
- File tree loads and navigates without stalling.
- Syntax highlighting renders correctly for all supported languages.
- File edit on phone → brain writes → verify change in git.
- File search returns correct results.

**iOS app — Work tab:**
- Terminal session list matches desktop session list.
- Terminal output streams in real-time from brain.
- Quick-launch command executes on brain and output appears on phone.

**iOS app — PRs tab:**
- PR list matches GitHub state.
- PR creation from phone → verify PR exists on GitHub.
- Merge from phone → verify merge on GitHub.
- Diff viewer renders correctly for various file types.

**iOS app — general:**
- Pairing flow: QR scan → token storage → auto-reconnect.
- Offline: view cached state, queue commands, reconnect and replay.
- Background refresh keeps state fresh.

**Desktop-to-desktop:**
- Lane availability state computation for all 6 states.
- Auto-push policy: on-commit, on-agent-complete, manual, failure retry.
- One-click sync flow end-to-end.
- Agent-running guard and reverse guard.
- Device sync summary overlay.
- Brain transfer: stop agents → sync → transfer → new brain starts.

**Cross-device:**
- Action on phone → verify on desktop, and vice versa.
- Action on Mac A → verify on Mac B (both non-brain).
- Brain dies after auto-push → viewer syncs normally.
- Network drop during sync → retry succeeds.

---

### Exit criteria

1. cr-sqlite extension loads and all 103 tables are CRR-marked with zero SQL code changes.
2. All devices (desktop + iOS) sync full database state in real-time via WebSocket.
3. Brain designation is explicit and transferable between Macs.
4. Devices pair with a one-time QR/code scan and reconnect automatically (macOS Keychain + iOS Keychain).
5. Tailscale integration works for cross-network reachability (optional, not required).
6. VPS headless brain deployment works via `xvfb-run`.
7. iOS Lanes tab has high parity with desktop: lane list, detail, create, archive, availability states.
8. iOS Files tab has high parity with desktop: file tree, syntax-highlighted viewer, search, basic editing.
9. iOS Work tab shows terminal sessions with real-time output streaming from brain.
10. iOS PRs tab has high parity with desktop: PR list, detail, diff viewer, create, merge, close.
11. Commands from any non-brain device route to brain and execute correctly.
12. Offline command queue replays correctly on reconnect.
13. Connection status visible on both desktop (status bar) and iOS (header).
14. Device management UI in Settings shows all paired devices with type, role, status, and sync lag.
15. Lane availability states computed and displayed correctly on non-brain Macs.
16. Auto-push policy works with all three modes.
17. One-click lane sync orchestrates push → fetch → worktree creation.
18. Agent-running guard prevents concurrent writes across devices.
19. Remote file access works from both desktop viewers and iOS.
20. Terminal output streaming works from iOS to brain.
