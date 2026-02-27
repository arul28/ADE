# Phase 8: Relay + Machines

## Phase 8 -- Relay + Machines (6-8 weeks)

Goal: Remote machine execution with explicit routing and ownership. Git IS the sync layer -- ADE stores state in `.ade/` which is committable to the repo. No full hub/relay/state-sync system needed.

### Reference docs

- [architecture/SYSTEM_OVERVIEW.md](../architecture/SYSTEM_OVERVIEW.md) — component overview (relay as future component)
- [architecture/DESKTOP_APP.md](../architecture/DESKTOP_APP.md) — project switching model (basis for machine context switching)
- [features/MISSIONS.md](../features/MISSIONS.md) — execution target metadata (`targetMachineId`), mission lifecycle (shared across machines)
- [architecture/SECURITY_AND_PRIVACY.md](../architecture/SECURITY_AND_PRIVACY.md) — trust model extension for relay connections
- [architecture/AI_INTEGRATION.md](../architecture/AI_INTEGRATION.md) — AgentExecutor interface (must work identically on VPS headless)

### Dependencies

- Phase 7 complete.
- Phase 3 complete (orchestrator autonomy + missions overhaul — see `phase-3.md`).

### Key Insight: Git-Based State Sync

Git IS the sync layer. ADE stores state in `.ade/` which is committable to the repo. No cloud backend or complex state sync protocol needed.

Cross-Machine State Flow:
1. Mac Mini runs a mission overnight
2. Agent commits code + pushes to remote
3. `.ade/` directory updated with mission history, new memories, learning entries
4. `.ade/` changes pushed (same branch or dedicated `ade/state` branch)
5. You open laptop, `git fetch`, ADE reads `.ade/` — full state available
6. Real-time: if laptop is connected to Mac Mini via relay, you see progress live

### Workstreams

- Remote execution routing:
  - Machine registry: register machines that can run ADE agents (Mac Mini, VPS, etc.).
  - Remote execution: from your laptop, launch a mission that runs on your Mac Mini.
  - The relay is essentially SSH/WebSocket tunnel to trigger ADE on a remote machine.
  - Results are pushed to git by the remote machine, your laptop pulls them.
- Machine registry:
  - Simple registry of known machines with their capabilities (CPU, RAM, available models).
  - Health checks via heartbeat.
  - Machine selection: manual ("run this on Mac Mini") or automatic (pick best available).
- WebSocket relay (real-time progress, NOT state sync):
  - WebSocket server runs on VPS/desktop. Both desktop and iOS connect as clients.
  - Real-time mission progress streaming (see your mission running on Mac Mini from your laptop).
  - Remote mission launch (trigger from laptop/phone).
  - Remote intervention handling (approve/reject from phone).
  - Live agent transcript tailing.
  - Persistent connection with auto-reconnect and exponential backoff.
- Pairing model:
  - One-time QR code or manual address entry for initial pairing.
  - Pairing token stored in OS keychain (macOS Keychain on desktop, iOS Keychain on phone).
  - No login/password/auth screen after initial pairing.
- VPS deployment:
  - ADE core runs headless on VPS alongside MCP server, CLI tools, git repos, and relay server.
  - Desktop and phone connect via WebSocket relay for real-time progress.
- Notification relay skeleton:
  - Minimal APNs relay component for push notifications when phone is backgrounded.
  - Options: tiny Lambda, Firebase Cloud Messaging, or third-party service (OneSignal, Pusher).
  - Keep `infra/` directory skeleton for this component.
- Renderer:
  - Add `Machines` tab (health, assignment, sync diagnostics).
  - Add local vs relay execution mode controls.
- Validation:
  - Reconnect and failover tests.
  - Ownership/race-condition tests.
  - Pairing flow tests (QR code, manual entry, token persistence).
  - Git-based state sync round-trip tests (`.ade/` identical after push/pull).
  - Remote mission launch end-to-end tests.

### Exit criteria

- Desktop can target local or relay machines predictably.
- Machine health and assignment are visible and actionable.
- Remote mission launch works: trigger from laptop, execute on Mac Mini, results pushed to git.
- `.ade/` directory syncs correctly across machines via git (mission history, memories, learning entries).
- Real-time relay shows live mission progress from remote machines.
- QR code / manual pairing completes in a single step with no re-auth required.
- VPS headless deployment runs ADE core, MCP server, and relay with no desktop dependency.
- Notification relay skeleton is in place with documented deployment options.
