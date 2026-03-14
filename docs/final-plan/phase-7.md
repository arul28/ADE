# Phase 7: Mobile + Remote Access

## Phase 7 -- Mobile + Remote Access (5-7 weeks)

Goal: Deliver an iOS companion app that provides full participation in ADE workflows — not just a dashboard, but a real client that can launch missions, chat with agents, and manage projects. Add built-in VPS provider integrations for users who want always-on brain machines.

### Reference docs

- [features/MISSIONS.md](../features/MISSIONS.md) — mission lifecycle, intervention flow, artifacts
- [features/ONBOARDING_AND_SETTINGS.md](../features/ONBOARDING_AND_SETTINGS.md) — Device Management, VPS Provider settings
- Phase 6 workstreams — cr-sqlite sync, WebSocket protocol, device pairing, brain model

### Dependencies

- Phase 6 complete (multi-device sync foundation).

### Architecture Overview

#### Phone as Full Participant
- The phone is a real cr-sqlite peer — it maintains its own local SQLite database with full app state.
- All database tables sync to the phone via the same cr-sqlite mechanism used between desktops.
- Phone can read and write to any synced table — it's a full participant, not a "baby monitor."
- Phone NEVER runs agents or the orchestrator — all compute happens on the brain machine.
- Phone sends commands to the brain via the WebSocket connection; brain executes and state syncs back.

#### What the Phone Can Do
- View and respond to agent chats in real-time (full message history synced via cr-sqlite).
- Launch new missions on the brain machine.
- Create lanes, assign agents, configure settings.
- Approve/reject interventions.
- View file contents (fetched on-demand from brain).
- Browse mission history, activity feed, and agent output.
- Receive push notifications for mission completion, interventions, and errors.
- View morning briefings from Night Shift runs.
- Chat with the CTO agent or any worker agent in the org (messages route to brain for processing).
- View the org chart: CTO, workers, their status (idle/running/paused), budget utilization.
- Receive push notifications from CTO: mission auto-dispatched from Linear, worker hit budget limit, escalation needed.

### Workstreams

#### W1: iOS App Shell (SwiftUI)
- Native SwiftUI application targeting iOS 17+.
- cr-sqlite embedded via SQLite Swift wrapper with cr-sqlite extension loaded.
- WebSocket client for brain connection (reuses Phase 6 protocol).
- Local SQLite database as cr-sqlite peer — full state available offline.
- Pairing flow: scan QR code from desktop brain → stored in iOS Keychain → auto-reconnect.

#### W2: Core Navigation & Dashboard
- Tab-based navigation: Missions, Chat, Lanes, Activity, Settings.
- Dashboard home: active missions summary, recent activity, brain connection status.
- Pull-to-refresh triggers manual sync check.
- Background app refresh for periodic state sync.

#### W3: Mission Management
- Mission list with status indicators (planning, running, paused, completed, failed).
- Mission detail view: phase progress, step list, worker status.
- Launch new mission: text input → sends to brain → brain plans and executes.
- Intervention handling: push notification → tap → approve/reject with optional comment.
- Mission history with full searchable archive.

#### W4: Agent Chat (Mobile)
- Full agent chat interface — not a read-only view.
- Chat message list with streaming updates (synced via cr-sqlite for history, WebSocket for real-time streaming tokens).
- Send messages to active agent sessions on the brain.
- View inline diffs, command output, and plan progress.
- Start new agent chat sessions (brain spawns the agent, phone is the UI).

#### W5: Activity Feed & Notifications
- Activity feed showing all ADE events across missions, agents, and lanes.
- Push notifications via APNs for:
  - Mission completed / failed
  - Intervention needed (approve/reject)
  - Agent error requiring attention
  - Night Shift morning briefing ready
- Notification tap → deep link to relevant screen.
- Notification preferences in Settings (per-event-type toggles).

#### W6: APNs Relay Service
- Lightweight relay service for push notification delivery.
- Options (user chooses):
  - Self-hosted: tiny Node.js service on brain machine or VPS, forwards to APNs directly.
  - Firebase Cloud Messaging: free tier, handles APNs delivery.
  - No push: phone relies on background refresh and manual checks.
- Brain sends notification payload to relay when events occur.
- Relay forwards to APNs → iOS displays notification.
- Minimal infrastructure — relay only handles notification routing, NOT state sync.

#### W7: VPS Provider Integrations
- Built-in integrations for popular VPS providers to provision always-on brain machines:
  - **Hetzner**: API integration for server creation, management, and teardown.
  - **DigitalOcean**: Droplet provisioning via API.
  - **Daytona**: Workspace creation for managed dev environments.
  - **Generic SSH**: Connect to any machine with SSH access.
- Provider setup in Settings → VPS Providers: add API key, select region/size.
- One-click brain provisioning: "Create VPS Brain" → provisions server → installs ADE → configures as brain → pairs automatically.
- VPS management: start/stop/restart, resource monitoring, cost estimates.
- VPS brain runs ADE headlessly via `xvfb-run electron .` (from Phase 6 W9).

#### W8: Remote File Browsing (Mobile)
- File browser: tree view of project directory structure (fetched from brain).
- File viewer: syntax-highlighted source code viewing for common languages.
- Basic file editing: simple text editor for quick fixes (sends edit command to brain).
- Diff viewer: see changes made by agents with syntax-highlighted unified diffs.
- File search: fuzzy search across project files (search request sent to brain).

#### W9: Offline Resilience
- Phone maintains full database state locally — always viewable even without connection.
- Offline state shows "Last synced: [timestamp]" indicator.
- Queued commands: if user takes action while offline, commands queue locally.
- On reconnect: queued commands replay in order, cr-sqlite merges any state changes.
- Conflict resolution: cr-sqlite CRDTs handle concurrent changes automatically.

#### W10: Validation
- iOS app startup and cr-sqlite initialization tests.
- Pairing flow tests: QR scan, token storage, auto-reconnect.
- Mission launch from phone end-to-end tests.
- Agent chat from phone: send message, receive streaming response, view results.
- Push notification delivery tests: foreground, background, app-terminated states.
- Offline queue tests: take actions offline, reconnect, verify replay.
- VPS provisioning tests: create server, install ADE, pair, verify brain functionality.
- Cross-device consistency tests: action on phone, verify on desktop, and vice versa.

### Exit criteria

- iOS app provides full participation in ADE workflows (missions, chats, lanes, activity).
- Phone is a real cr-sqlite peer with local state — works offline with cached data.
- Agent chat from phone allows sending messages and viewing real-time responses.
- Missions can be launched and managed entirely from the phone.
- Push notifications reliably surface interventions and mission completions.
- VPS provider integrations allow one-click brain provisioning.
- Offline actions queue and replay correctly on reconnect.
- Pairing is one-time (QR scan) with no re-auth required.
