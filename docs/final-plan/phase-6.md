# Phase 6: Multi-Device Sync Foundation

## Phase 6 -- Multi-Device Sync Foundation (6-8 weeks)

Goal: Enable real-time state synchronization across all user devices without cloud dependency. Any device running ADE becomes a peer; one device per project is designated the "brain" (runs agents), while others are viewers/controllers. All app state syncs via cr-sqlite CRDTs over WebSocket. File access from remote devices uses on-demand fetch.

### Reference docs

- [architecture/DESKTOP_APP.md](../architecture/DESKTOP_APP.md) — main process service graph, database access
- [features/ONBOARDING_AND_SETTINGS.md](../features/ONBOARDING_AND_SETTINGS.md) — Device Management settings
- [features/LANES.md](../features/LANES.md) — lane metadata sync, worktree lifecycle

### Dependencies

- Phase 5 complete (lane runtime isolation).
- Phase 3 complete (orchestrator autonomy — see `ORCHESTRATOR_OVERHAUL.md`).

### Architecture Overview

#### The Brain Model
- One machine per project is the "brain" — it runs agents, missions, and orchestrator processes.
- Any device except a phone can be a brain: laptop, Mac Studio, Mac Mini, VPS.
- All other connected devices are viewers/controllers — they see full state in real-time and can issue commands.
- Brain designation is explicit: users choose which machine is the brain in the device list.
- Only one brain per project at a time. Brain can be transferred between machines.

#### Sync Architecture
- **cr-sqlite** (SQLite CRDT extension) provides conflict-free replication for all 63 database tables.
- cr-sqlite is a SQLite extension, NOT a database replacement — zero changes to existing SQL code.
- Tables are marked as CRRs (Conflict-free Replicated Relations) with `SELECT crsql_as_crr('table_name')`.
- cr-sqlite generates changesets that are transported via WebSocket to connected peers.
- Each device maintains its own full SQLite database; cr-sqlite merges changes automatically.
- CRDTs handle concurrent writes without conflicts — last-writer-wins per column with Lamport timestamps.

#### What Syncs vs What Doesn't
- **Syncs via cr-sqlite** (all database state):
  - Mission state, steps, attempts, chat messages, agent output
  - Lane metadata (name, branch, status, assignment)
  - Memory entries, agent identities, learning packs
  - Terminal session metadata, summaries, deltas
  - Settings, automation rules, pack metadata
  - AI usage logs, conflict records, PR state
- **Syncs via git** (code only):
  - Source code files in working trees
  - `.ade/agents/*.yaml`, `.ade/identities/*.yaml`, `.ade/local.yaml` (tiny config, no secrets)
  - `.ade/context/` (PRD.ade.md, ARCHITECTURE.ade.md)
- **Does NOT sync** (machine-specific, gitignored):
  - `.ade/local.secret.yaml` (API keys, external MCP configs, local paths)
  - Worktree physical directories (each machine creates its own from git branches)
  - PTY processes and terminal output streams
  - Transcript files on disk (`.ade/transcripts/`)
  - Cache directories, embeddings
  - Running process state

#### `.ade/` Folder Structure (Revised)
```
.ade/
├── agents/            # Git-tracked: agent identity YAML files
│   ├── lead.yaml
│   └── reviewer.yaml
├── identities/        # Git-tracked: user identity configs
├── context/           # Git-tracked: PRD.ade.md, ARCHITECTURE.ade.md
├── local.yaml         # Git-tracked: project config (lane templates, phase profiles, feature flags — NO secrets)
├── local.secret.yaml  # Gitignored: machine-specific secrets (API keys, external MCP server configs, local paths)
├── ade.db             # cr-sqlite synced: ALL app state (gitignored)
├── ade.db-wal         # WAL file (gitignored)
├── mcp.sock           # Runtime socket (gitignored)
├── transcripts/       # Machine-specific logs (gitignored)
├── cache/             # Machine-specific cache (gitignored)
├── worktrees/         # Machine-specific lane checkouts (gitignored)
└── secrets/           # Machine-specific secrets (gitignored)
```

### Workstreams

#### W1: cr-sqlite Integration
- Load cr-sqlite extension into existing sql.js WASM runtime.
- Mark all 63 existing tables as CRRs via migration: `SELECT crsql_as_crr('table_name')` for each table.
- Verify zero breaking changes to existing SQL operations (~926 operations across 40 service files).
- Add changeset extraction: `SELECT * FROM crsql_changes WHERE db_version > ?` to get incremental changes.
- Add changeset application: `INSERT INTO crsql_changes(...)` to apply remote changes.
- Add site ID management for device identity in the CRDT merge.
- Update `.gitignore` to exclude `ade.db` and related files from git tracking.

#### W2: WebSocket Sync Server
- Brain machine runs a WebSocket server (default port 8787) for sync connections.
- Protocol: authenticated WebSocket with JSON-framed cr-sqlite changesets.
- Connection flow: peer connects → authenticates with pairing token → sends its db_version → brain sends all changes since that version → continuous bidirectional sync.
- Changeset delivery: brain watches for local DB changes (WAL hook or polling), extracts changesets, broadcasts to all connected peers.
- Peers send their local changes to brain, which applies and rebroadcasts to other peers.
- Handles connection drops with automatic reconnection and version-based catch-up.
- Compression for changeset batches over slow connections.

#### W3: Device Registry & Brain Management
- New `devices` table tracking all paired devices: device_id, name, platform (macOS/iOS/Linux), last_seen, is_brain, ip_addresses.
- Brain election: explicit user action — "Make this device the brain" in device list.
- Brain transfer protocol: current brain stops agents → syncs final state → new brain takes over → starts accepting agent work.
- Brain status broadcast: brain periodically announces its status (running missions, resource usage) to all peers.
- Device discovery: mDNS/Bonjour on local network for zero-config LAN discovery. Tailscale for cross-network.

#### W4: Tailscale Integration
- Optional Tailscale integration for device reachability across networks.
- Tailscale gives every device a stable IP (100.64.x.x) that works from anywhere — home, office, mobile.
- Traffic is peer-to-peer (WireGuard encrypted), NOT routed through a cloud relay.
- Self-hostable control plane via Headscale for users who want zero cloud dependency.
- ADE detects Tailscale IPs automatically and uses them for sync when LAN discovery fails.
- Tailscale is optional — LAN-only users can skip it entirely.

#### W5: Device Pairing UX
- First-time pairing: brain generates a QR code or 6-digit code. New device scans/enters the code.
- Pairing establishes a shared secret stored in OS keychain (macOS Keychain, iOS Keychain).
- After pairing, devices reconnect automatically — no re-auth needed.
- Device list in Settings → Devices: shows all paired devices with name, platform, status (online/offline/brain).
- Remove device: revokes pairing token, device can no longer connect.

#### W6: File Access Protocol
- Remote file viewing: viewer device requests a file path → brain reads from disk → sends content over WebSocket.
- Supports text files (source code, configs) and binary files (images) with size limits.
- File listing: remote device can browse the project directory tree.
- Basic file editing: viewer sends edit (path + content) → brain writes to disk → git tracks the change.
- NOT a full filesystem tunnel — on-demand fetch for specific files only.
- File change notifications: brain notifies viewers when watched files change on disk.

#### W7: Persistent Status Bar
- Always-visible status indicator in the app chrome showing current connection state:
  - **Local (Brain)**: "Running locally" — this device is the brain.
  - **Connected**: "Connected to [device-name]" — viewing/controlling a remote brain.
  - **Disconnected**: "Offline — last synced [timestamp]" — no brain reachable.
  - **Syncing**: "Syncing..." — actively exchanging changesets.
- Click status bar → opens device management panel.
- Connection quality indicator (latency, sync lag).

#### W8: Command Routing
- When a viewer/controller device issues a command (launch mission, start agent chat, create lane):
  - If it's a state-only operation (create lane metadata): write locally, cr-sqlite syncs to brain.
  - If it requires brain execution (launch mission, spawn agent): send command over WebSocket to brain, brain executes.
- Command acknowledgment: brain confirms receipt and execution start.
- Command result: brain executes → state changes sync back via cr-sqlite.

#### W9: VPS Deployment (Headless Brain)
- ADE can run headlessly on a VPS as a brain using `xvfb-run electron .` (virtual framebuffer).
- This wastes ~200MB RAM for the unused renderer but requires ZERO code changes.
- VPS deployment guide: install Node.js, clone repo, install deps, run with xvfb.
- VPS brain works identically to a desktop brain — other devices connect via Tailscale or direct IP.
- Systemd service file for auto-restart on crash.

#### W10: Lane Portability
- Lane metadata (name, branch, status, agent assignment) syncs via cr-sqlite.
- Worktree physical directories are machine-specific — NOT synced.
- When a device becomes brain or wants to work on a lane: it creates its own worktree from the lane's git branch.
- Worktree creation is automatic and transparent — user sees the lane, not the worktree mechanics.
- Archiving a lane on one device archives it everywhere (metadata sync).

#### W11: Validation
- cr-sqlite integration tests: mark tables, generate changesets, apply changesets, verify merge correctness.
- WebSocket sync tests: connection, authentication, changeset exchange, reconnection, catch-up.
- Multi-device simulation: 2-3 devices making concurrent changes, verify eventual consistency.
- Brain transfer tests: transfer brain designation, verify agents stop/start correctly.
- File access tests: remote file read/write, directory listing, size limits.
- Device pairing tests: QR code generation, code entry, token persistence, device removal.
- VPS deployment tests: headless startup, sync connectivity, agent execution.
- Offline/reconnection tests: device goes offline, makes changes, reconnects, changes merge correctly.

### Exit criteria

- cr-sqlite extension loads and all existing tables are CRR-marked with zero SQL code changes.
- Multiple devices sync database state in real-time via WebSocket.
- Brain designation is explicit and transferable between devices.
- Devices pair with a one-time code/QR scan and reconnect automatically.
- Remote file viewing and basic editing work from any connected device.
- Status bar shows connection state at all times.
- Commands from viewer devices route to brain and execute correctly.
- VPS headless deployment works as a brain with xvfb.
- Lane metadata syncs; worktrees are machine-specific.
- Tailscale integration works for cross-network device reachability (optional).
- Device list in Settings shows all paired devices with status.
