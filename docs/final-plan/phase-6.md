# Phase 6: Multi-Device Sync & iOS Companion

## Phase 6 -- Multi-Device Sync & iOS Companion (8-10 weeks)

Goal: Ship end-to-end multi-device ADE. Any Mac can be a brain (runs agents), any other Mac or iPhone can be a viewer/controller. Sync is peer-to-peer via cr-sqlite CRDTs over WebSocket — no cloud. By the end of this phase a user can pick up their iPhone, see what agents are doing on their Mac Studio, chat with the CTO, approve interventions, and launch missions.

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

#### Selective Sync for Mobile

Not all 103 tables need to sync to every device. Tables are classified into three sync tiers:

| Tier | Tables | Syncs to | Examples |
|------|--------|----------|----------|
| **Core** | ~40 tables | All devices (desktop + iOS) | missions, mission_steps, lanes, pull_requests, agent_identities, worker_agents, cto_*, unified_memories, ai_usage_log, budget_usage_records |
| **Extended** | ~45 tables | Desktop peers only | orchestrator_attempts, orchestrator_runtime_events, orchestrator_context_snapshots, memory_procedure_*, session_deltas, process_runs, test_runs |
| **Local-only** | ~18 tables | Never syncs | terminal_sessions, process_runtime, automation_runs, memory_sweep_log, memory_consolidation_log, attempt_transcripts |

The brain maintains a sync manifest that tells each peer which tiers to subscribe to based on its device type. iOS peers request Core tier only. Desktop peers request Core + Extended.

#### What Syncs vs What Doesn't

- **Syncs via cr-sqlite** (database state per tier):
  - Mission state, steps, events, interventions, artifacts, chat messages
  - Lane metadata (name, branch, status, assignment, agent run state)
  - CTO identity, core memory, session logs, flow policies
  - Worker agent identities, revisions, task sessions, runs, cost events
  - Unified memories, embeddings metadata (not the blob data on iOS)
  - Linear sync state, issue snapshots, dispatch queue, workflow runs
  - AI usage logs, budget records, external MCP usage events
  - PR state, conflict predictions, integration proposals
  - Settings, pack metadata, phase cards, phase profiles
  - Orchestrator runs, steps, claims, decisions, worker digests (desktop only)
  - Orchestrator reflections, retrospectives, pattern stats (desktop only)
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
- Classify tables into sync tiers (Core / Extended / Local-only) and build the sync manifest.
- Add FTS rebuild trigger: after applying remote changesets that touch `unified_memories`, rebuild affected FTS rows.

#### W2: WebSocket Sync Server & Protocol

- Brain machine runs a WebSocket server (default port 8787) embedded in the Electron main process.
- Protocol: authenticated WebSocket with JSON-framed cr-sqlite changesets.
- Connection flow:
  1. Peer connects with pairing token + device type (desktop/iOS)
  2. Brain validates token, sends sync manifest (which tiers this peer receives)
  3. Peer sends its `db_version`
  4. Brain sends all changesets since that version (filtered by tier)
  5. Continuous bidirectional sync begins
- Brain watches for local DB changes via WAL hook or short-interval polling, extracts changesets, broadcasts to connected peers (filtered per peer's tier).
- Peers send their local changes (commands, chat messages) to brain; brain applies and rebroadcasts to other peers.
- Automatic reconnection with version-based catch-up on connection drops.
- Changeset compression (zlib) for batches over slow or metered connections.
- Heartbeat ping/pong (30s interval) for connection health monitoring.

#### W3: Device Registry & Brain Management

- New `devices` table (synced): device_id, name, platform (`macOS` / `iOS` / `linux`), device_type (`desktop` / `phone` / `vps`), last_seen, is_brain, ip_addresses, tailscale_ip, sync_tier.
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
  - View per-device sync status (last seen, sync lag, tier)

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

#### W5: iOS App Shell & Navigation

- Native **SwiftUI** application targeting iOS 17+.
- cr-sqlite embedded via SQLite.swift wrapper with cr-sqlite extension loaded natively.
- WebSocket client for brain connection — reuses the same protocol from W2.
- Local SQLite database as a cr-sqlite peer — Core tier tables synced, full state available offline.
- Pairing flow: open iOS app → scan QR code displayed on brain → token stored in iOS Keychain → connected.
- Tab-based navigation:
  - **Dashboard** — active missions summary, brain connection status, recent activity feed
  - **Missions** — mission list, detail view, launch, intervention approval
  - **Chat** — agent chat sessions (CTO + workers), send messages, view responses
  - **Lanes** — lane list with availability states, agent status per lane
  - **Settings** — paired devices, notification preferences, connection status
- Pull-to-refresh triggers manual sync check.
- Background app refresh for periodic state sync when app is backgrounded.

#### W6: Agent Chat (iOS)

- Full agent chat interface — not a read-only view.
- Chat session list showing all active sessions on the brain (CTO, workers, ad-hoc chats).
- Message list with real-time updates:
  - History syncs via cr-sqlite (message rows in DB).
  - Streaming tokens for in-progress responses delivered via WebSocket for real-time feel.
- Send messages to any active agent session. Message is written locally, synced to brain, brain triggers agent processing, response syncs back.
- Start new agent chat sessions from the phone — brain spawns the agent, phone is the UI.
- View inline code blocks and diffs in agent responses (read-only, syntax-highlighted).
- Chat with CTO: full CTO conversation with memory and identity context preserved on brain.

#### W7: Mission Management (iOS)

- Mission list with status indicators (planning, running, paused, completed, failed).
- Mission detail view: phase progress, step list with status, worker assignment, budget utilization.
- **Launch new missions** from the phone: text input → command routes to brain → brain plans and executes.
- **Intervention handling**: push notification → tap → view intervention details → approve/reject with optional comment. This is the primary mobile use case — fast approval from anywhere.
- Mission history with searchable archive.
- Budget overview: per-mission and aggregate spend visible from the missions tab.
- CTO org chart view: CTO + workers, their status (idle/running/paused), current assignment.

#### W8: Push Notifications

- Brain sends notification events to iOS peers over WebSocket. iOS app uses local notifications when in foreground and registers for background processing.
- **APNs relay** for notifications when app is backgrounded or terminated:
  - Option A: Self-hosted — tiny Node.js relay on brain or VPS, forwards directly to APNs.
  - Option B: Firebase Cloud Messaging — free tier, handles APNs delivery.
  - Option C: No push — phone relies on background refresh and manual checks.
- Notification events:
  - Mission completed / failed
  - Intervention needed (approve/reject) — **highest priority**
  - Agent error requiring attention
  - Budget threshold reached
  - Brain status change (went offline, transferred)
- Notification tap → deep link to relevant screen (mission detail, intervention, chat).
- Notification preferences in iOS Settings tab: per-event-type toggles.

#### W9: Command Routing & Connection Status

**Command routing:**
- When any non-brain device issues a command:
  - **State-only operations** (create lane metadata, update settings, add memory): write locally, cr-sqlite syncs to brain and all peers.
  - **Execution operations** (launch mission, spawn agent, start CTO chat, approve intervention): send command over WebSocket to brain. Brain executes, state changes sync back via cr-sqlite.
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
- Persistent connection indicator in the iOS dashboard header.
- Same four states as desktop, adapted for mobile UI.
- Connection lost → banner notification with "Reconnecting..." and auto-retry.

#### W10: Lane Portability (Desktop-to-Desktop)

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

#### W11: File Access Protocol

- Remote file viewing: viewer requests a file path → brain reads from disk → sends content over WebSocket.
- Supports text files (source code, configs) and binary files (images) with configurable size limits.
- File listing: remote device can browse the project directory tree.
- Basic file editing (desktop viewers): viewer sends edit (path + content) → brain writes to disk → git tracks the change.
- File change notifications: brain notifies viewers when watched files change on disk.
- iOS file viewing: read-only syntax-highlighted source viewer. No editing from phone in Phase 6.
- NOT a full filesystem tunnel — on-demand fetch for specific files only.

#### W12: Validation

**cr-sqlite:**
- Mark all tables as CRRs, verify zero SQL breakage across all services.
- Generate changesets, apply to second database, verify identical state.
- Concurrent writes from two peers, verify CRDT merge correctness.
- FTS rebuild after remote changeset application.
- Selective sync: verify iOS peer only receives Core tier tables.

**WebSocket sync:**
- Connection, authentication, changeset exchange.
- Reconnection with version-based catch-up.
- Compression, heartbeat, connection timeout.
- Multiple peers connected simultaneously.

**iOS app:**
- App startup, cr-sqlite initialization, initial sync.
- Pairing flow: QR scan → token storage → auto-reconnect.
- Agent chat: send message from phone, receive response, verify on desktop.
- Mission launch from phone, intervention approval from phone.
- Push notification delivery: foreground, background, app-terminated.
- Offline: take actions while disconnected, reconnect, verify queue replay.

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
2. Multiple devices (desktop + iOS) sync database state in real-time via WebSocket.
3. Selective sync delivers Core tier to iOS, Core + Extended to desktop peers.
4. Brain designation is explicit and transferable between Macs.
5. Devices pair with a one-time QR/code scan and reconnect automatically (macOS Keychain + iOS Keychain).
6. Tailscale integration works for cross-network reachability (optional, not required).
7. VPS headless brain deployment works via `xvfb-run`.
8. iOS app ships with functional dashboard, mission management, agent chat, lane overview, and push notifications.
9. Missions can be launched and managed entirely from the phone.
10. Agent chat from phone works end-to-end: send message → brain processes → response visible on phone.
11. Interventions can be approved/rejected from the phone via push notification deep link.
12. Commands from any non-brain device route to brain and execute correctly.
13. Offline command queue replays correctly on reconnect.
14. Connection status visible on both desktop (status bar) and iOS (dashboard header).
15. Device management UI in Settings shows all paired devices with type, role, status, and sync lag.
16. Lane availability states computed and displayed correctly on non-brain Macs.
17. Auto-push policy works with all three modes.
18. One-click lane sync orchestrates push → fetch → worktree creation.
19. Agent-running guard prevents concurrent writes across devices.
20. Remote file viewing works from both desktop viewers and iOS (read-only on iOS).
