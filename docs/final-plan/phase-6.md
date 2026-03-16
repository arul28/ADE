# Phase 6: Multi-Device Sync & iOS Companion

## Phase 6 -- Multi-Device Sync & iOS Companion (8-10 weeks)

Goal: Ship end-to-end multi-device ADE with a polished iOS app for project management. One desktop-class machine acts as the live host for a session, and phones or other desktops can attach as controllers. Independent desktop-to-desktop work still happens through Git plus the tracked ADE scaffold/config layer. Sync is peer-to-peer via cr-sqlite CRDTs over WebSocket — no cloud. By the end of this phase a user can pick up their iPhone and manage their project with high-parity Lanes, Files, Work, and PRs tabs while their Mac Studio runs agents in the background.

Important 2026-03-16 status update:

- W4 now includes the iOS local replicated-state foundation, not just desktop pairing/network work.
- `apps/ios/` exists, the app shell exists, and the data layer has been rewritten around a real local replicated database contract instead of a cache DB.
- The current phone pairing UX is manual host/port + numeric code entry. QR pairing, discovery, Tailscale selection, and broader network hardening remain follow-on W5 work.
- The current blocker is the vendored iOS `crsqlite.xcframework`. It is packaged like a SQLite loadable extension, not an embeddable iOS-safe initializer, so the rewritten local-sync path cannot boot yet on iOS.
- Practically: W5 must start by replacing or wrapping the iOS `crsqlite` artifact, then finish the expected dogfooding/pairing polish. The app shell is present, but the current iOS build is not yet a valid dogfood target until that blocker is removed.

Important 2026-03-15 scope clarification:

- W3 is no longer only "live host/controller sync + handoff".
- W3 also owns the narrow **shared ADE scaffold/config layer** for desktop-class ADE machines.
- Another desktop that clones/pulls the repo must be able to open the project with the shared ADE scaffold/config/identity files already present, without first attaching to a live host.
- One connected cluster still has exactly one live execution host at a time, and this Git-tracked layer does not replace live sync for runtime state.

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

#### The host/controller model

- One desktop-class machine per live session is the **host**. It runs agents, missions, orchestrator processes, CTO heartbeats, Linear sync, and all AI compute.
- Any Mac (laptop, Mac Studio, Mac Mini) or VPS can be a host. Phones cannot.
- All other connected devices are **controllers**. They see state, read local replicated data, and issue commands. The host does the execution work.
- Host designation is explicit: the user chooses which machine is the live host in Settings > Devices. Only one host owns live ADE execution side effects at a time.
- A second desktop can either work independently through Git plus tracked ADE scaffold/config, or connect to another host as a controller.
- Desktop portability is still a first-class requirement: a second Mac that simply pulls the repo should recover the shared ADE scaffold/config layer from tracked state even before it joins a live session.

#### Two operating modes

Phase 6 is built around two distinct user stories:

1. **Independent desktop mode**
   - A user alternates between desktop-class ADE machines (for example, Mac Studio and laptop).
   - Each desktop has its own local clone, local worktrees, and local machine runtime.
   - Code portability happens through git.
   - Shared ADE scaffold/config portability happens through tracked `.ade/`.
   - The desktops do not need to be in the same live sync cluster just to let the user continue work on another machine later.
   - This mode is intentionally tolerant of "only one machine is actively doing work right now"; it does not require active-active multi-host runtime sync.

2. **Controller-to-host mode**
   - One machine or VPS is the live execution host.
   - Another desktop or phone attaches as a controller.
   - In this mode, work happens on the host only.
   - The controller needs live ADE sync because it must see current state, output, agent activity, and command results in real time.
   - This is the primary model for iPhone/iPad and for controlling a more powerful or always-on host remotely.

These modes solve different problems and both are first-class:

- independent desktop mode solves "pick this project up on another development machine"
- controller-to-host mode solves "control and observe a live execution machine from somewhere else"

#### Sync Architecture

- **cr-sqlite** (SQLite CRDT extension) provides conflict-free replication for all **103 database tables** (see current schema in `kvDb.ts`).
- cr-sqlite is a vendored native SQLite extension loaded into the Node.js `node:sqlite` runtime on desktop and native SQLite on iOS — zero changes to existing SQL code.
- Tables are marked as CRRs (Conflict-free Replicated Relations): `SELECT crsql_as_crr('table_name')`.
- cr-sqlite generates changesets transported via WebSocket to connected peers.
- Each device maintains its own full SQLite database. cr-sqlite merges changes automatically using last-writer-wins per column with Lamport timestamps.
- The FTS4 virtual table (`unified_memories_fts`) is **not** marked as a CRR — each device rebuilds its FTS index from the synced `unified_memories` table.
- **All 103 tables are synced to all devices** (desktop and iOS alike). The sync layer is comprehensive — what varies between devices is the UI, not the data. This keeps the sync protocol simple and ensures any future iOS tab can read its data immediately without sync changes.

#### Design Principle: Mobile as Desktop Parity

The iOS app is fundamentally a 1:1 wrap of the desktop chat/workspace experience in an iOS form factor. Every capability that works on desktop — tool calls, streaming UI, terminal output, chat attachments, computer use artifacts — must work on mobile via the sync protocol. The mobile app is not a "lite" companion; it is a full peer that happens to run on a phone. Where the desktop renders a tool call result inline, the phone renders the same data with native SwiftUI components. Where the desktop streams terminal output into a pane, the phone streams the same output via the terminal sub-protocol. No feature is desktop-only by design — only by phase scoping (Phase 6 ships four tabs, Phase 7 adds the rest).

#### Future-Proofing: Sync Once, UI Later

The sync infrastructure syncs all tables to all device types. This is a deliberate architectural choice:

- **Adding a new table** to the desktop app requires one line (`SELECT crsql_as_crr('new_table')`) and the data flows to all devices automatically.
- **Adding a new column** to an existing table requires no sync changes — cr-sqlite handles new columns transparently.
- **Adding a new iOS tab** (Phase 7) requires only SwiftUI work — the data is already on the device.
- **Adding a new command type** (e.g., "launch mission" from iOS in Phase 7) requires one command handler on the host.

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
- **Syncs via git** (portable repo state, desktop peers only):
  - Source code files in working trees
  - ADE scaffold and shared config under tracked `.ade/`
  - Shared ADE scaffold/config: committed low-churn ADE config and identity artifacts that make another desktop clone look like an existing ADE project
- **Does NOT sync** (machine-specific):
  - `.ade/local.secret.yaml` (API keys, external MCP configs)
  - Worktree physical directories
  - PTY processes and terminal output streams
  - Raw transcript/session log files, cache, embedding model weights
  - Running process state, mcp.sock

#### Portability contract for independent desktops

W3 now owns a second portability layer beyond live CRDT sync:

- **Live cluster state** continues to move through ADE sync (`.ade/ade.db` via cr-sqlite + WebSocket).
- **Shared ADE scaffold/config** must move through tracked ADE files so another desktop clone sees the shared ADE setup after a normal `git pull`.
- **Local runtime** stays local.

The rule is simple:

- if the file is low-churn, human-authored, and clearly shared, it can live in tracked `.ade/`
- if the state is hot operational/runtime state, it belongs in ADE sync
- if the state is machine-bound execution state, it stays local

Examples of the tracked shared ADE layer:

- `.ade/.gitignore`
- `.ade/ade.yaml`
- `.ade/cto/identity.yaml`
- human-authored files under `.ade/templates/**`
- human-authored files under `.ade/skills/**`
- stable repo-backed workflow/config files when present

Examples that remain ADE-sync-only:

- live mission/chat runtime state
- device registry and cluster state
- active queue/process/PTY ownership
- other operational tables that matter for a connected live host/controller session

#### CTO & Worker Agent Reachability

- **Agent state syncs via cr-sqlite**: identities, memory entries, run status, chat messages, org chart, cost events, Linear workflow state. Any device sees the full picture in real-time.
- **Agent execution is host-only**: CTO heartbeats, Linear polling, worker activations, mission orchestration, embedding worker — all run on the host. Non-host devices never spawn agent processes.
- **Command routing for agent chat**: user sends a message from phone or controller Mac → message written locally → cr-sqlite syncs to host → WebSocket command triggers host to process → agent response written on host → cr-sqlite syncs back to all peers.
- **Linear credentials are host-only**: API tokens live in `.ade/local.secret.yaml` (machine-specific, never synced). Only the host needs them.

#### `.ade/` Folder Structure

```
.ade/
├── .gitignore         # Git-tracked: canonical ADE ignore contract
├── ade.yaml           # Git-tracked: shared ADE config
├── cto/
│   ├── identity.yaml     # Git-tracked: shared CTO identity
│   ├── core-memory.json  # Local/generated CTO runtime memory (gitignored)
│   └── daily-logs/       # Raw operational logs (gitignored)
├── templates/         # Git-tracked: human-authored templates
├── skills/            # Git-tracked: human-authored skills
├── workflows/
│   └── linear/        # Git-tracked when stable repo-backed workflow files exist
├── local.yaml         # Gitignored: machine-local overrides
├── local.secret.yaml  # Gitignored: machine-specific secrets
├── ade.db             # cr-sqlite synced live cluster state (gitignored)
├── ade.db-wal         # WAL file (gitignored)
├── mcp.sock           # Runtime socket (gitignored)
├── agents/            # Local/generated worker state (gitignored)
├── context/           # Generated local context docs (gitignored)
├── memory/            # Local/generated memory exports (gitignored)
├── history/           # Local/generated history summaries (gitignored)
├── reflections/       # Local/generated reflection state (gitignored)
├── transcripts/       # Machine-specific logs (gitignored)
├── cache/             # Machine-specific cache (gitignored)
├── worktrees/         # Machine-specific lane checkouts (gitignored)
└── secrets/           # Machine-specific secrets (gitignored)
```

#### iOS App Scope (Phase 6)

The Phase 6 iOS app ships **four high-parity tabs** that provide complete project management from the phone:

| Tab | Desktop equivalent | What it does on iOS |
|-----|-------------------|---------------------|
| **Lanes** | `/lanes` | Full lane list with status, branch info, agent assignment, dirty/ahead/behind indicators. Create and archive lanes. View lane details. On non-host: lane availability states (Local/Behind/Live/Remote only). |
| **Files** | `/files` | Full file browser with directory tree, syntax-highlighted file viewer, file search, basic file editing (sends edits to host). High parity with desktop file explorer. |
| **Work** | `/work` | Terminal session list, read-only terminal output viewing (streamed from host via WebSocket), session metadata. Quick-launch actions that route to host. |
| **PRs** | `/prs` | PR list with status, merge readiness, CI checks. PR detail view with diff. Create PR (routes to host). Merge/close actions. Stacked PR visualization. |

**Not in Phase 6 iOS** (deferred to Phase 7):
- Missions tab (mission management, intervention approval, launch)
- CTO tab (agent chat, org chart, identity management)
- Chat tab (ad-hoc agent chat sessions)
- Automations tab
- Graph tab
- History tab
- Settings tab (beyond basic device/connection settings)

This scoping is intentional: Lanes + Files + Work + PRs give full project management from the phone. The AI orchestration tabs (Missions, CTO, Chat) come in Phase 7 once the project management foundation is proven.

#### iOS Design Direction

- **Native SwiftUI throughout** — the iOS app uses native SwiftUI components and follows iOS Human Interface Guidelines. No embedded web views for core UI. Components should feel native to the platform.
- **Color palette**: project purple (`#7C3AED`) as the primary accent color, with iOS-standard system backgrounds (`Color(.systemBackground)`, `Color(.secondarySystemBackground)`). Dark mode support via system appearance.
- **Typography**: SF Pro (the iOS system font) exclusively. No custom fonts, no monospace outside of code/terminal contexts. Use standard Dynamic Type size categories for accessibility.
- **Navigation**: standard `TabView` with four tabs (Lanes, Files, Work, PRs). Each tab uses `NavigationStack` for drill-down. No hamburger menus, no custom tab bars.
- **Aesthetic**: clean, functional, slightly opinionated. Avoid generic AI app aesthetics — no gradient blobs, no floating orbs, no "chat with your AI" landing screens. The app opens to real project state, not decoration.
- **Chat bubbles, tool call cards, and proof panels** (Phase 7 and forward-looking W8 elements): these must feel native to iOS, not web-view ports. Use `List` rows, `DisclosureGroup` for expandable content, `Sheet` for detail panels. No custom scroll views where SwiftUI native components suffice.
- **Iconography**: SF Symbols exclusively. No custom icon sets.

#### iOS Chat & Agent Visibility Requirements (Forward-Looking)

While the full Chat tab is scoped for Phase 7, certain agent interaction patterns appear in Phase 6 tabs (Work tab terminal streaming, command routing feedback) and must be designed with the following in mind for continuity:

- **Streaming message rendering**: chat messages from agents must render incrementally as tokens arrive, not after completion. The sync protocol delivers message deltas via cr-sqlite; the UI appends content on each changeset.
- **Tool call results visible inline**: when an agent executes a tool (file write, terminal command, git operation), the result must be visible inline in chat context. Use expandable/collapsible `DisclosureGroup` cards — collapsed by default showing tool name + status, expandable to show full output.
- **Terminal output streaming to iOS**: terminal output from agent sessions on the host must be streamable to iOS in real-time via the terminal stream sub-protocol (W2). This is already used by the W8 Work tab, but must also feed into chat context when agents run commands.
- **Persistent process indicator**: when agents are running commands, a persistent indicator must be visible — similar to a terminal-above-prompt pattern. On iOS, this is a sticky banner or inline card at the top of the chat/work view showing: agent name, current tool/command, elapsed time, and a pulsing activity indicator.
- **Chat attachments (images, files)**: all attachments sent or received in chat must render on iOS. Images render inline with tap-to-fullscreen. Files show metadata with a tap-to-view action that fetches content via the file access sub-protocol.

#### iOS Computer Use & Proof Requirements

Proof that agents are working is critical to user trust. The desktop app has a proof drawer pattern (screenshots, videos, traces from computer use sessions). The iOS app needs equivalent visibility:

- **Computer use artifacts (screenshots, videos, traces) must be viewable on iOS**: these are stored as file references in the database (paths in artifact records). The artifact metadata syncs via cr-sqlite like all other tables. The actual media files are served by the host over the existing WebSocket file access sub-protocol (W2) — the same mechanism the Files tab uses to fetch file contents.
- **No separate media backend needed**: the host device serves media files (screenshots, screen recordings, trace logs) over the existing WebSocket connection. No S3, no CDN, no cloud relay. The phone requests a file by path, the host reads it from disk and sends the bytes. This is the same flow as the Files tab viewing a source file — just with an image or video MIME type.
- **Proof panel on iOS**: the desktop proof drawer pattern translates to a SwiftUI `Sheet` or `NavigationLink` detail view. Tapping an artifact card in chat or in a mission step opens the proof panel showing:
  - Screenshots: full-resolution image with pinch-to-zoom
  - Videos: inline video player (`AVKit` `VideoPlayer`)
  - Traces: scrollable log view with timestamp + action pairs
- **Artifact timeline**: within a mission step or agent chat session, artifacts are displayed in chronological order so the user can follow what the agent did step by step.
- **Media sync path**: artifact metadata (file path, timestamp, type, associated step/session) syncs via cr-sqlite. Media files themselves are fetched on-demand from the host via the file access sub-protocol — not eagerly synced. This keeps the cr-sqlite changeset stream lightweight. Thumbnails can be cached locally on iOS after first fetch.

---

### Workstreams

#### W1: cr-sqlite Integration

Status: Implemented on desktop + headless MCP.

- `openKvDb(...)` now uses a shared sync-aware SQLite adapter backed by `node:sqlite` plus the vendored `crsqlite` extension.
- The existing `AdeDb` contract still works, and W1 adds `db.sync.getSiteId()`, `getDbVersion()`, `exportChangesSince(version)`, and `applyChanges(changes)`.
- Eligible tables are marked as CRRs dynamically from `sqlite_master`; virtual/internal tables and `unified_memories_fts` are excluded.
- Existing databases get a one-time local backup before first CRR enablement: `<db>.pre-crsqlite-w1.bak`.
- Device-local site identity lives at `.ade/secrets/sync-site-id` and is intentionally not synced.
- Applying remote changes rebuilds the local unified memory FTS index when `unified_memories` changes.
- Sync-managed tables support later `ALTER TABLE ... ADD COLUMN` through automatic alter wrapping in the shared DB adapter, which keeps follow-on migrations W2+ friendly.

#### W2: WebSocket Sync Server & Protocol

- Host machine runs a WebSocket server (default port 8787) embedded in the Electron main process.
- Protocol: authenticated WebSocket with JSON-framed cr-sqlite changesets.
- Implementation note: desktop W2 now ships the transport on top of W1. The current auth mechanism is a machine-local bootstrap token stored in `.ade/secrets/sync-bootstrap-token`. This is intentionally temporary scaffolding pulled forward from W4 so transport and cross-peer testing can happen before the device registry and pairing UX land.
- Connection flow:
  1. Peer connects with pairing token + device type (desktop/iOS)
  2. Host validates token
  3. Peer sends its `db_version`
  4. Host sends all changesets since that version
  5. Continuous bidirectional sync begins
- Host watches for local DB changes via WAL hook or short-interval polling, extracts changesets, broadcasts to all connected peers.
- Peers send their local changes (commands, chat messages) to host; host applies and rebroadcasts to other peers.
- Automatic reconnection with version-based catch-up on connection drops.
- Changeset compression (zlib) for batches over slow or metered connections.
- Heartbeat ping/pong (30s interval) for connection health monitoring.
- **File access sub-protocol**: request/response for on-demand file reads, directory listings, and file writes. Used by iOS Files tab, desktop remote file viewing, and media/artifact retrieval. Supports any file type — source code, images, videos, logs — by path. Content-type is inferred from file extension. This single sub-protocol is the transport for all file-like data including computer use screenshots and screen recordings (no separate media backend needed).
- **Terminal stream sub-protocol**: subscribe to terminal session output from host. Used by iOS Work tab for read-only terminal viewing and by agent chat sessions for inline terminal output.
- Validation scaffolding pulled forward from W10: W2 also carries one narrow command path, `work.runQuickCommand`, so remote terminal launch and stream round-trips can be proven before full command routing ships. All other execution commands remain W10 work.

#### W3: Device Registry, Host Management, and portable desktop state

- W3 live cluster sync and handoff are implemented on desktop.
- W3 scope includes the shared ADE scaffold/config layer for independent desktops.
- Synced `devices` table stores durable device metadata: `device_id`, `site_id`, `name`, `platform`, `device_type`, `last_seen`, `last_host`, `last_port`, `ip_addresses`, `tailscale_ip`, and metadata JSON.
- Host authority lives in synced singleton `sync_cluster_state` with `brain_device_id` and `brain_epoch`. We do not use a per-row `is_brain` flag because CRDT replication would make split-host edge cases harder to reason about.
- Local desktop auto-registers on startup from the existing `.ade/secrets/sync-site-id` identity and a stable machine-local `sync-device-id`.
- New Settings > Sync UI ships:
  - Local device rename/edit controls
  - Manual host/port/bootstrap-token desktop connect
  - Current host/connect details on the active host
  - Per-device live status (connected state, last seen, lag, latency)
  - Disconnect/forget actions
  - “Make this device the host”
- Host transfer protocol in W3:
  1. Preflight blocks handoff if live work exists
  2. Final sync flush completes
  3. `brain_epoch` increments and `brain_device_id` moves
  4. Host/client lifecycle flips on the participating desktops
- W3 transfer blocker rules:
  - Block on active missions, running chat turns, live PTY sessions, and running managed lane processes
  - Allow paused missions, CTO history and idle threads, and idle or ended agent chats to survive handoff as durable synced state
- Host status broadcast now carries connected peers and sync metrics to viewers.
- W3 shared-config portability requirements:
  - Another desktop that pulls the repo should no longer feel like a fresh ADE project bootstrap.
  - The tracked `.ade/` layer is limited to low-churn, human-authored, team-sharable config and identity artifacts.
  - Live runtime state, DB-derived state, and generated high-churn files remain in ADE sync or machine-local storage.
- Discovery, QR pairing, keychain storage, Tailscale selection, and secure revoke are not W3. They move to W4.

#### W4: Device Pairing & Network

- First-time pairing: host generates a **QR code** (encodes host IP/port + one-time pairing token) or a **6-digit numeric code** for manual entry.
- Pairing establishes a shared secret stored in OS keychain (macOS Keychain / iOS Keychain).
- After pairing, devices reconnect automatically on every app launch — no re-auth.
- Current implementation status (2026-03-16):
  - Numeric-code pairing is implemented end to end.
  - The desktop host mints per-device pairing secrets and validates them on later `hello` handshakes.
  - The iOS app stores the paired secret locally and reconnects automatically.
  - QR presentation/scanning and the final hardened network/discovery UX are still remaining W5 work.
- Temporary bridge for testing: before this full pairing flow ships, W2 uses a machine-local bootstrap token in `.ade/secrets/sync-bootstrap-token` so the transport can be exercised end to end. Replacing that bootstrap token with registry-backed pairing and keychain storage is still W4 work.
- Explicit carry-over from W3: the current desktop host listens on all interfaces with bootstrap-token auth only. Treat W3 as trusted-LAN-only scaffolding. W4 must harden this with per-device secrets, secure revoke, and the intended network policy.
- **Tailscale integration** (optional):
  - ADE detects Tailscale IPs (100.64.x.x) automatically and uses them when LAN discovery fails.
  - Peer-to-peer WireGuard encrypted traffic — no cloud relay.
  - Self-hostable control plane via Headscale for zero cloud dependency.
  - Tailscale is never required — LAN-only users skip it entirely.
- **VPS host deployment**:
  - ADE runs headlessly on a VPS via `xvfb-run electron .` (~200MB RAM overhead, zero code changes).
  - Systemd service file for auto-restart on crash.
  - VPS host works identically to a desktop host — other devices connect via Tailscale, direct IP, or VPN.
  - Deployment guide: install Node.js, clone repo, install deps, configure as host, pair devices remotely.
- Remove device: revokes pairing token, device can no longer connect, entry removed from registry.

#### W5: iOS App Shell & Core Navigation

- Native **SwiftUI** application targeting iOS 17+.
- Native `SQLite3` integration with per-connection `sqlite3_crsqlite_init(...)`, currently blocked until the vendored iOS `crsqlite` artifact is replaced or wrapped with an iOS-safe embedding path.
- WebSocket client for host connection — reuses the same protocol from W2.
- Local SQLite database as a cr-sqlite peer — all tables synced, full state available offline.
- Before or alongside W5, revisit sync hot-path performance in the `node:sqlite` adapter. Statement caching is deferred in W3/W4, but it becomes more important once phone peers and heavier multi-peer polling are in the loop.
- Pairing flow today: open iOS app → enter host/port + pairing code shown by the host → paired secret stored locally → connected.
- W5 carry-forward: add QR presentation/scanning and make the pairing UX shippable without Xcode/manual engineering steps.
- **Four-tab navigation**: Lanes, Files, Work, PRs.
- Persistent connection status header: host name, connection state, sync indicator.
- Pull-to-refresh triggers manual sync check.
- Background app refresh for periodic state sync when app is backgrounded.
- Basic Settings screen (accessible from profile/gear icon): paired devices list, connection info, disconnect.

W5 handoff target as of 2026-03-16:

- Treat the app shell + four Phase 6 tabs as already present.
- Use W5 to close the gap between "engineering-ready" and "reliably dogfoodable":
  - first replace or wrap the vendored iOS `crsqlite` artifact so the replicated database can boot on iOS
  - then do physical-device install/build validation on a healthy Xcode setup
  - QR pairing UX
  - discovery / Tailscale / host hardening
  - end-to-end manual phone validation against a live host after the database blocker is removed

#### W6: iOS Lanes Tab

High-parity SwiftUI implementation of the desktop Lanes page.

- **Lane list**: all lanes with name, branch, dirty/ahead/behind indicators, agent assignment badge, mission link.
- **Lane detail view**: full lane info — branch, status, recent commits, assigned agent and status, linked mission/step.
- **Create lane**: name + base branch input → command routes to host → host creates worktree → metadata syncs back.
- **Archive/unarchive lane**: swipe action or detail view button.
- **Lane availability states** (when connected to host from a non-host device):
  - Local, Behind, Live on [device], Remote only, Push pending, Offline
  - Computed from cr-sqlite metadata + host status
  - "Sync to this Mac" not applicable on iOS (no worktrees), but state is displayed for awareness
- **Agent status per lane**: if an agent is running on a lane, show provider, model, current step, duration.
- **Search and filter**: filter by status (active/archived), search by name.
- **Swipe gestures**: swipe to archive, long-press for quick actions.

#### W7: iOS Files Tab

High-parity SwiftUI implementation of the desktop Files page.

- **File tree browser**: hierarchical project directory tree fetched on-demand from host via file access sub-protocol. Lazy-loaded — only expanded directories fetch contents.
- **Syntax-highlighted file viewer**: full syntax highlighting for common languages (Swift, TypeScript, Python, Rust, Go, Java, HTML/CSS, JSON, YAML, Markdown). Line numbers, word wrap toggle.
- **File search**: fuzzy filename search across the project. Search request routes to host, results displayed on phone.
- **Basic file editing**: tap "Edit" on any text file → simple text editor for quick fixes. Edit routes to host, host writes to disk, git tracks the change. Not a full IDE — intentionally minimal for config tweaks and typo fixes.
- **Diff controller**: view pending changes (unstaged/staged) per file with syntax-highlighted unified diff.
- **File metadata**: size, last modified, last commit touching this file.
- **Binary file preview**: images rendered inline, other binary files show metadata only.

#### W8: iOS Work Tab

High-parity SwiftUI implementation of the desktop Work page, including agent activity visibility.

- **Terminal session list**: all active and recent terminal sessions from the host, showing session name, lane, status (running/exited), last output timestamp.
- **Read-only terminal output**: tap a session to view its output streamed in real-time from the host via the terminal stream sub-protocol. Monospace rendering with ANSI color support.
- **Session metadata**: start time, duration, exit code (if finished), associated lane.
- **Quick-launch actions**: predefined commands (e.g., "npm test", "npm run build") that route to the host for execution. Host spawns the process, output streams back to the phone.
- **Session search**: search across session output (search request routes to host).
- **Pull-to-refresh**: refreshes session list and reconnects any dropped terminal streams.
- **Agent activity feed**: when agents are running on the host, the Work tab shows a persistent activity section at the top of the session list. Each active agent shows: agent name, current action (tool call name or terminal command), lane, elapsed time, and a pulsing activity dot. Tapping an active agent opens its terminal session output. This gives the user immediate proof that work is happening without navigating to a separate tab.
- **Tool call result cards**: when an agent session includes tool calls (file writes, git operations, test runs), these appear as inline cards in the terminal stream — collapsed by default (tool name + pass/fail badge), expandable to show full output. This mirrors the desktop chat experience where tool call results are visible inline.
- **Computer use artifact previews**: if an agent session produces computer use artifacts (screenshots, screen recordings), thumbnail previews appear inline in the session view. Tap to open the proof panel (full-resolution image or video player). Artifacts are fetched on-demand from the host via the file access sub-protocol.

#### W9: iOS PRs Tab

High-parity SwiftUI implementation of the desktop PRs page.

- **PR list**: all open PRs with title, branch, status (open/merged/closed), CI check status (pass/fail/pending), review status, merge readiness indicator.
- **PR detail view**: full PR info — title, description, branch, base, commits, file changes, CI checks, reviewers.
- **Diff controller**: per-file syntax-highlighted unified diffs. Swipe between changed files. Line count badges.
- **PR actions** (route to host):
  - Create PR: select lane → title + description input → host runs `gh pr create`.
  - Merge: merge button with strategy selector (merge/squash/rebase) → host executes.
  - Close: close PR with optional comment.
  - Request review: add reviewers.
- **Stacked PR visualization**: if lanes use stacking, show the stack order and per-PR status.
- **CI check details**: tap a check to see its log output (fetched from host/GitHub).
- **Pull-to-refresh**: refreshes PR state from GitHub via host.

#### W10: Command Routing & Connection Status

**Command routing:**
- When any non-host device issues a command:
  - **State-only operations** (create lane metadata, update settings): write locally, cr-sqlite syncs to host and all peers.
  - **Execution operations** (create worktree, run terminal command, create PR, merge PR, git operations): send command over WebSocket to host. Host executes, state changes sync back via cr-sqlite.
- Command acknowledgment: host confirms receipt and execution start.
- Command failure: host returns error, originating device shows actionable error with retry option.
- Offline command queue: if device is disconnected, execution commands queue locally and replay on reconnect (in order, with conflict detection).
- W2 pull-forward note: the transport now supports one seed execution command, `work.runQuickCommand`, to validate remote PTY launch plus terminal streaming. That seed path is test scaffolding, not the completion of W10. The rest of command routing and UI connection-state work remains in this workstream.

**Connection status (desktop):**
- Always-visible status indicator in the top bar:
  - **Host** — "Running locally" with device count badge
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
- Code syncs via git (push from host → pull on controller). Requires explicit action or auto-push policy.

**Auto-push policy** (configurable per project in Settings):
- `on-commit` (default): push after every commit. Code available on other devices within seconds.
- `on-agent-complete`: push when agent finishes work on the lane. Cleaner mid-work history.
- `manual`: never auto-push. User pushes explicitly.
- Push failure: lane flagged as "push pending," retried on next connectivity.

**Lane availability states** (computed per device from cr-sqlite metadata + local git state):

| State | Meaning | Actions |
|-------|---------|---------|
| **Local** | Branch synced, worktree exists, no remote agents running | Full local dev |
| **Behind** | Host has commits not yet pulled | "Sync to this Mac" (one-click) |
| **Live on [device]** | Agent actively running on host | View remotely, chat with agent, auto-sync when done |
| **Remote only** | Lane exists on host, never pulled | "Bring to this machine" (one-click) |
| **Push pending** | Host has unpushed commits | Wait or request push |
| **Offline** | Host unreachable, code state unknown | View cached metadata, work on local lanes |

**One-click lane sync** ("Sync to this Mac"):
1. If host has unpushed commits → command host to `git push`
2. Local device runs `git fetch origin`
3. Create local worktree from branch ref
4. Lane transitions to Local — full dev enabled

**Agent-running guard:**
- When an agent is active on a lane on the host, local worktree creation is blocked on other Macs.
- "Auto-sync when done" registers intent: agent completes → auto-push → auto-fetch → worktree created → system notification.
- Reverse guard: warns if launching a remote agent on a locally-checked-out lane (prevents divergent changes).

**Device sync summary:**
- Shown as a dismissible overlay when a non-host Mac connects to the host.
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
- Create lane from phone → host creates worktree → lane appears on phone.
- Archive lane from phone → reflected on desktop.
- Lane availability states display correctly for non-host connections.

**iOS app — Files tab:**
- File tree loads and navigates without stalling.
- Syntax highlighting renders correctly for all supported languages.
- File edit on phone → host writes → verify change in git.
- File search returns correct results.

**iOS app — Work tab:**
- Terminal session list matches desktop session list.
- Terminal output streams in real-time from host.
- Quick-launch command executes on host and output appears on phone.
- Agent activity feed shows active agents with correct status, tool name, and elapsed time.
- Tool call result cards render inline and expand/collapse correctly.
- Computer use artifact thumbnails appear inline; tapping opens proof panel with full-resolution media.
- Media files (screenshots, videos) load correctly via file access sub-protocol from host.

**iOS app — PRs tab:**
- PR list matches GitHub state.
- PR creation from phone → verify PR exists on GitHub.
- Merge from phone → verify merge on GitHub.
- Diff controller renders correctly for various file types.

**iOS app — general:**
- Pairing flow: QR scan → token storage → auto-reconnect.
- Offline: view cached state, queue commands, reconnect and replay.
- Background refresh keeps state fresh.
- Design audit: all screens use SF Pro, SF Symbols, project purple accent, native SwiftUI components. No web views, no custom fonts, no generic AI aesthetics.

**Desktop-to-desktop:**
- Lane availability state computation for all 6 states.
- Auto-push policy: on-commit, on-agent-complete, manual, failure retry.
- One-click sync flow end-to-end.
- Agent-running guard and reverse guard.
- Device sync summary overlay.
- Host transfer: stop agents → sync → transfer → new host starts.

**Cross-device:**
- Action on phone → verify on desktop, and vice versa.
- Action on Mac A → verify on Mac B (both non-host).
- Host dies after auto-push → controller syncs normally.
- Network drop during sync → retry succeeds.

---

### Execution Order

#### Dependency Graph

```
W1 (cr-sqlite) ──► W2 (WebSocket sync) ──► W3 (device registry) ──► W4 (pairing & network)
                                                    │
                                                    ▼
                                              W5 (iOS shell) ──┬──► W6 (Lanes tab)
                                                               ├──► W7 (Files tab)
                                                               ├──► W8 (Work tab)
                                                               └──► W9 (PRs tab)
                                                                        │
                                              W11 (lane portability) ◄──┤  (W11 needs W2-W4, not iOS)
                                                                        │
                                                                        ▼
                                              W10 (command routing + connection status)
                                                                        │
                                                                        ▼
                                              W12 (validation)
```

Key dependencies:
- W1 (cr-sqlite) is the foundational dependency -- everything else builds on it.
- W2 requires W1 (changesets to transport).
- W3 requires W2 (device table needs sync, host status needs WebSocket).
- W4 requires W3 (pairing writes to device registry).
- W5 requires W1-W4 proven (iOS app depends on working sync infrastructure).
- W6-W9 require W5 (each tab builds on the iOS shell) and can run in parallel.
- W10 requires W6-W9 (command routing surfaces across all tabs).
- W11 requires W2-W4 (desktop-to-desktop lane sync) but is independent of iOS work.
- W12 requires all other workstreams (validation covers everything).

#### Wave Groupings

**Wave 1: Sync Infrastructure (W1-W4) -- ~3-4 weeks**

The foundation. cr-sqlite integration, WebSocket protocol, device registry, pairing, and the narrow shared ADE scaffold/config portability layer. Nothing else can start until this wave proves the sync architecture works. W1-W3 are now implemented on desktop using Node.js native `node:sqlite` with a vendored cr-sqlite extension (not WASM).

**Wave 2: iOS Shell (W5) -- ~1-2 weeks**

Historically this wave was "first iOS shell". In practice, most of that shell work has already landed during W4 implementation: Xcode project setup, WebSocket client, manual pairing, tab navigation scaffold, and local-first reads for Lanes / Files / Work / PRs. W5 now starts with the iOS `crsqlite` embedding fix, because the current vendored artifact still blocks the replicated database from booting. Only after that blocker is removed should W5 proceed to device validation, pairing/discovery polish, and broader phone dogfooding. W11 (lane portability) can still run in parallel since it only needs desktop sync infrastructure.

**Wave 3: iOS Tabs (W6-W9) in Parallel -- ~3-4 weeks**

Four tabs built in parallel by separate developers or sequentially by one. Each tab follows the same pattern: read from local cr-sqlite database, render SwiftUI views, send commands to host. W10 (command routing + connection status) is woven in as tabs need it.

**Wave 4: Integration and Validation (W10-W12) -- ~1-2 weeks**

Command routing hardening, connection status UI on both platforms, lane portability finalization, and comprehensive cross-device validation.

#### Rough Effort Estimates

| Wave | Workstreams | Duration | Risk |
|---|---|---|---|
| Wave 1 | W1-W4 | 3-4 weeks | W1-W3 implemented; W4 now includes the initial iOS local-sync foundation |
| Wave 2 | W5, W11 (parallel) | 1-2 weeks | Medium (iOS `crsqlite` artifact replacement/wrapper, then device validation, QR/discovery polish, real-phone dogfooding) |
| Wave 3 | W6-W9, W10 | 3-4 weeks | Low (pattern is well-defined, each tab is independent) |
| Wave 4 | W10 finalization, W12 | 1-2 weeks | Low (validation, polish) |

**Total: 8-10 weeks** (matches phase estimate). Critical path is Wave 1 -- if cr-sqlite works cleanly, the rest is execution.

---

### W4 carry-overs

Before or during W4, keep these explicit carry-overs in scope:

- Replace W3 bootstrap-token auth with per-device pairing secrets and OS keychain storage.
- Add secure revoke semantics for paired devices.
- Revisit host network posture after pairing lands:
  - current W3 desktop transport is trusted-LAN-only scaffolding
  - current host binding/auth model should not be treated as the final network posture
- Finish the phone-facing pairing/discovery UX:
  - numeric-code pairing is sufficient for engineering validation today
  - QR pairing, address discovery, and smoother connect/reconnect flows are still required before treating the iPhone path as polished
- Preserve the W3 shared-config portability contract:
  - keep the low-churn shared ADE scaffold/config layer as the only Git-tracked ADE portability surface by default
  - another desktop should continue to recover that scaffold after clone/pull without depending on a live host
  - future workstreams should not promote generated/high-churn runtime state into Git by default
- Keep the W3 transfer contract intact:
  - paused missions survive handoff and stay paused
  - CTO history and idle threads survive handoff
  - idle and ended agent chats survive handoff
  - live missions, chat turns, PTYs, and managed processes still block handoff
- Preserve the CRR upsert rule introduced during W3 hardening:
  - `ON CONFLICT(...)` on replicated tables must target the table primary key only
  - non-PK merge cases should use explicit select-then-update logic
- Track `node:sqlite` prepared-statement caching as deferred performance work before iOS peers and heavier multi-peer sync loads arrive.

### Current validation posture

Not yet on iOS. The rewritten local-sync code is in place, but the current vendored `crsqlite.xcframework` blocks the replicated database from initializing.

Current manual validation path after the artifact is fixed:

1. Run the desktop app as the host on a machine using Node 22.13.1.
2. Open desktop Sync/Devices settings and start a pairing session to get the numeric code.
3. Build and install `apps/ios/ADE.xcodeproj` onto a physical iPhone.
4. In the iOS app connection screen, enter the host, port, and pairing code.
5. Verify that Lanes / Files / Work / PRs populate from local synced state and that execution actions still route to the host.

Current blockers:

- replace or wrap the vendored iOS `crsqlite` artifact so the local replicated database can boot
- finish W5 follow-through for smoother pairing/discovery and broader phone dogfooding

---

### Exit criteria

1. cr-sqlite extension loads and all 103 tables are CRR-marked with zero SQL code changes.
2. All devices (desktop + iOS) sync full database state in real-time via WebSocket.
3. Host designation is explicit and transferable between Macs.
4. A fresh desktop clone that pulls the repo recovers the shared ADE scaffold/config layer without re-running full project bootstrap or depending on a live host.
5. Devices pair with a one-time QR/code scan and reconnect automatically (macOS Keychain + iOS Keychain).
6. Tailscale integration works for cross-network reachability (optional, not required).
7. VPS headless host deployment works via `xvfb-run`.
8. iOS Lanes tab has high parity with desktop: lane list, detail, create, archive, availability states.
9. iOS Files tab has high parity with desktop: file tree, syntax-highlighted controller, search, basic editing.
10. iOS Work tab shows terminal sessions with real-time output streaming from host.
11. iOS PRs tab has high parity with desktop: PR list, detail, diff viewer, create, merge, close.
12. Commands from any non-host device route to host and execute correctly.
13. Offline command queue replays correctly on reconnect.
14. Connection status visible on both desktop (status bar) and iOS (header).
15. Device management UI in Settings shows all paired devices with type, role, status, and sync lag.
16. Lane availability states computed and displayed correctly on non-host Macs.
17. Auto-push policy works with all three modes.
18. One-click lane sync orchestrates push → fetch → worktree creation.
19. Agent-running guard prevents concurrent writes across devices.
20. Remote file access works from both desktop viewers and iOS — including media files (images, videos) served via the file access sub-protocol.
21. Terminal output streaming works from iOS to host.
22. Agent activity is visible on iOS Work tab: active agent list, tool call result cards, and process indicators.
23. Computer use artifacts (screenshots, videos, traces) are viewable on iOS via proof panel — fetched on-demand from host.
24. iOS app uses native SwiftUI components, SF Pro typography, project purple (#7C3AED) accent, and SF Symbols throughout — no web-view ports or custom UI frameworks.
