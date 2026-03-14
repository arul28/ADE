# Phase 6: Multi-Device Sync Foundation

## Phase 6 -- Multi-Device Sync Foundation (6-8 weeks)

Goal: Enable real-time state synchronization across all user devices without cloud dependency. Any device running ADE becomes a peer; one device per project is designated the "brain" (runs agents), while others are viewers/controllers. All app state syncs via cr-sqlite CRDTs over WebSocket. File access from remote devices uses on-demand fetch.

### Reference docs

- [architecture/DESKTOP_APP.md](../architecture/DESKTOP_APP.md) — main process service graph, database access
- [features/ONBOARDING_AND_SETTINGS.md](../features/ONBOARDING_AND_SETTINGS.md) — Device Management settings
- [features/LANES.md](../features/LANES.md) — lane metadata sync, worktree lifecycle

### Dependencies

- Phase 4 complete (CTO + org system — agent identities, memory, heartbeat, and Linear sync all create database tables and state that must be CRR-marked for sync).
- Phase 3 complete (orchestrator autonomy — see `ORCHESTRATOR_OVERHAUL.md`).
- Phase 5 is **NOT** a dependency. Play runtime isolation (ports, proxies, lane environments) is local-only infrastructure — nothing in Phase 6 requires it. Phase 5 can run fully in parallel with Phase 4 and complete before, during, or after Phase 6.

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

#### CTO & Worker Agent Reachability

The CTO agent and all worker agents (Phase 4) run exclusively on the brain machine. Multi-device access works as follows:

- **Agent state syncs via cr-sqlite**: Agent identities, memory entries, config revisions, run status, chat messages, and org chart structure all sync as regular database state. Any device sees the full org in real-time.
- **Agent execution is brain-only**: CTO heartbeats, Linear polling, worker activations, and mission orchestration all run on the brain. Non-brain devices never spawn agent processes.
- **Command routing for agent chat**: When a user talks to the CTO or any worker from a non-brain device, the message is written locally (cr-sqlite syncs to brain) and a WebSocket command routes to the brain to trigger agent processing. The agent's response syncs back via cr-sqlite.
- **Heartbeat on VPS brain**: When ADE runs headlessly on a VPS (W9), the CTO heartbeat fires on schedule, Linear sync runs continuously, and workers process issues — all without a desktop being open.
- **Linear credentials are brain-only**: Linear API token lives in `.ade/local.secret.yaml` (gitignored, machine-specific). Only the brain needs it. Other devices see mission results via cr-sqlite sync.

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

#### W10: Lane Portability & Multi-Device Lane UX

Lane portability is the user-facing layer that makes multi-device development feel seamless. It covers how lanes appear on non-brain devices, how code syncs between machines, and how ADE prevents dangerous concurrent writes.

##### Core Mechanics

- Lane metadata (name, branch, status, agent assignment) syncs via cr-sqlite — instant, automatic, always.
- Worktree physical directories are machine-specific — NOT synced. Each machine creates its own from the git branch.
- Code syncs via git (push from brain → pull on viewer). This is the one step that requires an explicit action (or auto-push policy).
- Archiving a lane on one device archives it everywhere (metadata sync).

##### Auto-Push Policy

To close the gap between "metadata synced" and "code available," the brain should auto-push lane branches:

- **On every commit**: When an agent or user commits on a lane, the brain auto-pushes the branch to the remote. This makes code available to other devices within seconds of a commit.
- **Configurable**: Users can set the auto-push policy per project in Settings:
  - `on-commit` (default): Push after every commit. Minimal delay, code always available.
  - `on-agent-complete`: Push when an agent finishes its work on the lane. Avoids mid-work pushes for cleaner history.
  - `manual`: Never auto-push. User must explicitly push. For users who want full control.
- **Push failures**: If auto-push fails (network down, remote rejected), the lane is flagged as "push pending" and retried on next connectivity. The viewer device sees "Behind (push pending on [brain-name])" instead of a stale state.

##### Lane Availability States

Each lane has a per-device **availability state** computed from cr-sqlite metadata + local git state. This is the primary signal shown to the user on non-brain devices:

| State | Icon | Meaning | User Actions |
|-------|------|---------|--------------|
| **Local** | ✓ | Branch synced, worktree exists locally, no remote agents running | Full local dev — edit, commit, push, run processes |
| **Behind** | ⚠ | Brain has commits not yet pulled to this device, agents are done | "Sync to this Mac" (one-click) |
| **Live on [device]** | 🔵 | Agent actively running on this lane on the brain | View remotely, chat with agent, wait, or auto-sync when done |
| **Remote only** | ☁ | Lane exists on brain, never been pulled to this device | "Bring to this machine" (one-click) |
| **Push pending** | ⏳ | Brain has commits but hasn't pushed yet (auto-push failed or policy is manual) | "Request push from [brain-name]" or wait |
| **Offline** | ○ | Lane metadata synced but brain is unreachable, code state unknown | View cached metadata only, work on already-local lanes |

State derivation logic:
```typescript
function computeLaneAvailability(lane: LaneSummary, device: Device): LaneAvailability {
  const hasLocalWorktree = localWorktreeExists(lane.worktreePath);
  const brainReachable = isBrainConnected();
  const agentRunning = lane.activeAgentRunId != null;
  const localBranchExists = gitBranchExistsLocally(lane.branchRef);
  const localBehind = localBranchExists && isLocalBehindRemote(lane.branchRef);
  const pushPending = lane.pushPendingOnDevice != null;

  if (!brainReachable) return 'offline';
  if (agentRunning) return 'live';
  if (pushPending) return 'push-pending';
  if (hasLocalWorktree && !localBehind) return 'local';
  if (localBranchExists && localBehind) return 'behind';
  return 'remote-only';
}
```

##### Device Sync Summary (On Connection)

When a non-brain device connects to the brain (e.g., opening laptop at a coffee shop), ADE shows a **Device Sync Summary** overlay before dumping the user into the lanes list. This gives a full picture in one glance:

```
+------------------------------------------------------------------+
| CONNECTED TO MAC STUDIO                          via Tailscale    |
+------------------------------------------------------------------+
|                                                                    |
|  3 lanes on this project                                           |
|                                                                    |
|  ● feat-auth         🔵 Agent running (step 4/7)                 |
|                       View remotely · Auto-sync when done          |
|                                                                    |
|  ● bugfix-nav         ⚠ Behind (2 commits)                       |
|                       [Sync to this Mac]                           |
|                                                                    |
|  ● refactor-db        ✓ Already local & up to date                |
|                                                                    |
|  ──────────────────────────────────────────────                    |
|  [Sync all ready lanes]              Skips lanes with active agents |
+------------------------------------------------------------------+
```

- Appears as a dismissible overlay on first connection per session (not on every reconnect).
- Also accessible on-demand from the status bar → "Device sync status."
- "Sync all ready lanes" bulk-syncs all lanes in `behind` or `remote-only` state where no agent is running.
- Lanes in `live` state show the agent's current progress and offer "Auto-sync when done."

##### One-Click Lane Sync Flow

"Sync to this Mac" (or "Bring to this machine") is one button that orchestrates:

1. **If brain has unpushed commits**: Send command to brain → brain runs `git push` on the lane branch.
2. **Local device**: `git fetch origin` → fetch the updated branch.
3. **Create local worktree**: `git worktree add .ade/worktrees/<slug> <branch-ref>`.
4. **Lane state transitions to Local** — full local dev enabled.

Progress is shown inline:
```
● bugfix-nav         Syncing...
  Pushing from Mac Studio... → Fetching... → Creating worktree... → Done ✓
```

If any step fails (network error, merge conflict on push), the error is shown inline with a retry option and the lane stays in its previous state.

##### Agent-Running Guard

**Core rule: Don't let two machines write to the same branch simultaneously.**

When a lane has `activeAgentRunId != null` (agent running on brain):

- **Local worktree creation is blocked** on other devices. The UI shows:
  ```
  ● feat-auth                                 🔵 Live on Mac Studio
    Agent: Claude Sonnet · Step 4/7 · Running for 12m

    ┌─────────────────────────────┐
    │  View agent work (remote)   │
    └─────────────────────────────┘

    ⓘ Local editing disabled while agent is running on Mac Studio.
      You can view, chat with the agent, or wait for it to finish.
    When done: [Notify me] [Auto-sync when done]
  ```

- **"View agent work (remote)"** opens the lane in remote-view mode: file contents fetched via File Access Protocol (W6), agent chat visible via cr-sqlite, terminal output streamed. The user can send messages to the agent from the viewer device.

- **"Auto-sync when done"** registers an intent:
  1. Brain finishes agent work → auto-pushes the lane branch (per auto-push policy).
  2. Brain sends a `lane-agent-completed` event to all peers.
  3. Viewer device receives event → auto-fetches branch → creates local worktree → notifies user.
  4. If user has moved on (app backgrounded), a system notification surfaces: "feat-auth is ready for local dev."

- **"Notify me"** is lighter — just sends a notification when the agent finishes, user decides what to do.

- **Reverse guard**: If a user is actively working on a lane locally on their laptop and tries to launch an agent on that lane on the brain, ADE warns:
  ```
  This lane is checked out on your MacBook Pro.
  Running an agent on Mac Studio would create divergent changes.

  Options:
  [Push changes first, then run agent]  [Run agent here instead]  [Cancel]
  ```

##### Lane Status Badges in Lane List

The lane list on non-brain devices shows availability state prominently:

```
+------------------------------------------------------------------+
| LANES                                                              |
+------------------------------------------------------------------+
|  ● feat-auth        ↑3  M     🔵 Live on Studio                  |
|  ● bugfix-nav       ↑1        ⚠ Behind (2 commits)              |
|  ● refactor-db      ↑2  M     ✓ Local                            |
|  ● experiment-ui              ☁ Remote only                       |
+------------------------------------------------------------------+
```

The availability badge replaces or supplements the existing dirty/ahead/behind indicators when viewing from a non-brain device. On the brain device itself, lanes show the standard indicators (dirty, ahead, behind) since all lanes are inherently "local" on the brain.

##### Failure Scenarios & Recovery

| Scenario | What happens | User sees |
|----------|-------------|-----------|
| Brain dies with unpushed commits | cr-sqlite metadata survived (synced before death). Code is on brain's disk only. | Lane shows "Push pending on [brain] — device offline." User must recover the brain machine or its disk. |
| Brain dies after auto-push | Code is on remote. Viewer can sync. | Lane shows "Behind" → user syncs normally. |
| Network drops during sync | Partial state — branch may be pushed but worktree not created. | "Sync interrupted — [Retry]" with clear status of what completed. |
| User force-pushes on viewer while agent runs on brain | Guard prevents this — local worktree creation is blocked while agent is running. | If user bypasses guard (e.g., raw git commands), ADE detects diverged state on next sync and shows conflict resolution UI. |
| Brain auto-push fails (remote rejected) | Lane flagged as push-pending. Brain retries on schedule. | Viewer sees "Push pending on [brain]" with timestamp of last attempt. |
| Two users on different non-brain devices both try to sync and edit | cr-sqlite handles metadata conflicts. Git handles code conflicts (normal merge/rebase flow). | Standard git conflict resolution if both push to the same branch. ADE's conflict prediction catches this early. |

#### W11: Validation
- cr-sqlite integration tests: mark tables, generate changesets, apply changesets, verify merge correctness.
- WebSocket sync tests: connection, authentication, changeset exchange, reconnection, catch-up.
- Multi-device simulation: 2-3 devices making concurrent changes, verify eventual consistency.
- Brain transfer tests: transfer brain designation, verify agents stop/start correctly.
- File access tests: remote file read/write, directory listing, size limits.
- Device pairing tests: QR code generation, code entry, token persistence, device removal.
- VPS deployment tests: headless startup, sync connectivity, agent execution.
- Offline/reconnection tests: device goes offline, makes changes, reconnects, changes merge correctly.
- **Lane portability tests** (W10):
  - Lane availability state computation: verify correct state derivation for all 6 states (local, behind, live, remote-only, push-pending, offline).
  - Auto-push policy: verify on-commit push, on-agent-complete push, manual mode, and push failure retry.
  - One-click sync flow: remote push → local fetch → worktree creation end-to-end.
  - Agent-running guard: verify local worktree creation is blocked while agent is active on brain.
  - Reverse guard: verify warning when launching remote agent on locally-checked-out lane.
  - Auto-sync-when-done: register intent → agent completes → auto-push → auto-fetch → worktree created → notification delivered.
  - Device Sync Summary: verify overlay appears on first connection, shows correct per-lane states, "Sync all ready lanes" skips live lanes.
  - Failure recovery: brain dies with unpushed commits (metadata survives, code unavailable), network drop during sync (retry works), push rejection (push-pending state shown).

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
- Lane availability states (Local / Behind / Live / Remote only / Push pending / Offline) are computed and displayed correctly on non-brain devices.
- Auto-push policy works with configurable modes (on-commit, on-agent-complete, manual).
- One-click "Sync to this Mac" orchestrates remote push + local fetch + worktree creation.
- Agent-running guard prevents local worktree creation while an agent is writing on the brain.
- "Auto-sync when done" registers intent and automatically syncs when agent completes.
- Device Sync Summary overlay appears on first connection and shows per-lane availability.
- Reverse guard warns when launching a remote agent on a locally-checked-out lane.
