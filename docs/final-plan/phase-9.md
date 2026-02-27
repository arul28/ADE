# Phase 9: iOS Control App

## Phase 9 -- iOS Control App (4-6 weeks)

Goal: Mobile remote control for an ADE instance running on Mac Mini/VPS.

> **Note:** iOS app does NOT sync full ADE state. It is a remote control for a running ADE instance. Project state (code + `.ade/`) syncs via git between desktop machines.

### Reference docs

- [features/MISSIONS.md](../features/MISSIONS.md) — mission lifecycle, intervention flow, artifacts, mobile-first behavior (§ Mobile-First Behavior)
- [features/ONBOARDING_AND_SETTINGS.md](../features/ONBOARDING_AND_SETTINGS.md) — AI usage dashboard (mirrored on iOS for subscription visibility)
- [features/PACKS.md](../features/PACKS.md) — pack exports consumed by iOS for context summaries
- Phase 8 workstreams — relay architecture, pairing model, notification relay, git-based state sync (iOS connects via relay for real-time updates)

### Dependencies

- Phase 8 complete.
- Phase 3 complete (orchestrator autonomy + missions overhaul — see `phase-3.md`).

### Workstreams

- App:
  - Add SwiftUI shell + relay auth/session handling.
  - Connect via relay WebSocket to ADE instance on Mac Mini/VPS for real-time updates.
  - Launch missions on the remote machine.
  - Handle interventions (approve/reject).
  - View mission results, agent status, morning briefing.
  - Add push notifications for mission completion, intervention requests.
  - Add pack/PR/conflict summary surfaces.
  - Add preview URL viewer per backend (Local proxy, Daytona workspace URL, VPS relay).
- Remote control architecture:
  - iPhone never runs agents. Mac Mini/VPS does all compute.
  - Phone sends intent and displays results.
  - Token-by-token streaming via WebSocket for native-feeling responsiveness.
- Optimistic UI:
  - Phone caches last-known state locally (SQLite on device).
  - Actions show immediately (optimistic), remote machine confirms async.
- Push notifications:
  - APNs relay for "Mission completed", "Intervention needed", background notifications.
  - Tap notification -> app opens -> WebSocket reconnects -> back to real-time.
- Persistent connection:
  - WebSocket stays alive in background (iOS active session support).
  - Auto-reconnect with exponential backoff on network changes.
- One-time pairing:
  - QR code scan or manual entry on first launch.
  - Pairing token in iOS Keychain.
  - No re-auth needed after initial setup.
- Offline resilience:
  - Cached view of last-known state available when offline.
  - Queue actions locally, replay when reconnected.
- Validation:
  - Mobile intervention flow tests.
  - Relay event sync latency and consistency checks.
  - Optimistic UI conflict resolution tests (server rejects optimistic action).
  - Push notification delivery tests (foreground, background, terminated states).
  - Offline queue replay tests.
  - Remote mission launch from iOS end-to-end tests.

### Exit criteria

- Users can monitor missions and resolve interventions from iOS.
- Users can launch missions on Mac Mini/VPS from their phone.
- Users can inspect resident-agent queues and morning briefing actions from iOS.
- Mobile actions are reflected in desktop/relay state in near real time.
- Token-by-token streaming provides native-feeling responsiveness for agent output.
- Push notifications reliably surface intervention requests and mission completions.
- Offline cached state displays instantly; queued actions replay correctly on reconnect.
- One-time pairing requires no re-auth after initial setup.
