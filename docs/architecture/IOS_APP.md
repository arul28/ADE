# iOS App Architecture

> Roadmap reference: `docs/final-plan/phase-6.md` (Phase 6) and `docs/final-plan/phase-7.md` (Phase 7).

> Last updated: 2026-03-19

> Status: **Phase 6 W5 hardening is shipped as the baseline iPhone controller contract, and Phase 6 W6 shipped full live-desktop parity for the iPhone Lanes tab. The app exists under `apps/ios/`, uses native SwiftUI + SQLite3, and the current shipped phone surface is Lanes / Files / Work / PRs plus a dedicated sync Settings tab.**

This document describes the architecture of the ADE iOS companion app. The iOS app provides real-time project management and (in Phase 7) full AI orchestration control from an iPhone or iPad.

---

## Table of Contents

- [Overview](#overview)
- [Project Structure](#project-structure)
- [SwiftUI Architecture](#swiftui-architecture)
- [SQLite and cr-sqlite Integration](#sqlite-and-cr-sqlite-integration)
- [WebSocket Client Architecture](#websocket-client-architecture)
- [iOS-Specific Services](#ios-specific-services)
- [Tab Structure](#tab-structure)
- [Implementation Status](#implementation-status)

---

## Overview

The iOS app is a native SwiftUI application that acts as a controller for an ADE host machine (a Mac or VPS running the full desktop app). It is intended to maintain a local cr-sqlite database that syncs live ADE state from the host in real time. The phone never runs agents -- it reads synced state and sends commands to the host for execution.

Desktop portability note:

- iOS depends on ADE sync and a live/reachable host
- desktop-to-desktop portability also depends on tracked portable ADE project intelligence in the repo
- that portable desktop layer is not an iOS concern because phones are never standalone hosts

---

## Project Structure

```text
apps/ios/
├── ADE.xcodeproj/
├── ADE/
│   ├── App/
│   │   ├── ADEApp.swift
│   │   └── ContentView.swift
│   ├── Models/
│   │   └── RemoteModels.swift
│   ├── Resources/
│   │   └── DatabaseBootstrap.sql
│   ├── Services/
│   │   ├── Database.swift
│   │   ├── KeychainService.swift
│   │   └── SyncService.swift
│   ├── Views/
│   │   ├── LanesTabView.swift
│   │   ├── FilesTabView.swift
│   │   ├── WorkTabView.swift
│   │   └── PRsTabView.swift
│   └── Assets.xcassets/
└── ADETests/
    └── ADETests.swift
```

---

## SwiftUI Architecture

### Pattern

The current implementation is intentionally small:

- **Views**: SwiftUI views per top-level tab.
- **Services**: `DatabaseService`, `SyncService`, and `KeychainService` are the core runtime pieces.
- **Models**: Plain Swift structs in `RemoteModels.swift`.
- **Environment injection**: `SyncService` is injected as a shared `@StateObject` / `@EnvironmentObject`.

This is enough for the current Phase 6 scope. The code can be split into finer-grained view models later if Phase 7 tab complexity makes that worthwhile.

### Navigation

- `TabView` at the root with the five shipped Phase 6 tabs: Lanes, Files, Work, PRs, and Settings. Phase 7 adds the remaining desktop surfaces.
- `NavigationStack` within each tab for push/pop navigation.
- Deep links from push notifications navigate to specific screens.

### Target

- iOS 26+.
- iPhone and iPad (adaptive layouts in Phase 7).

---

## SQLite and cr-sqlite Integration

### Stack

| Layer | Library | Purpose |
|---|---|---|
| SQLite engine | System SQLite (iOS) | Native SQLite runtime |
| Swift bindings | `SQLite3` C API from Swift | Direct native database access |
| CRDT extension | cr-sqlite | Conflict-free replication |

### Database Setup

1. On first launch, create `Application Support/ADE/ade.db`.
2. Open the database with system SQLite and initialize cr-sqlite for that connection.
3. Load the checked-in bootstrap schema generated from desktop `kvDb.ts`.
4. Mark eligible tables as CRRs (`SELECT crsql_as_crr('table_name')`).
5. Assign a stable local site ID stored at `Application Support/ADE/secrets/sync-site-id`.
6. Replace the legacy disposable iOS cache DB if it is detected.

### Data Flow

- All reads are local SQLite queries -- instant, offline-capable.
- Writes from user actions are written locally first, then synced to the host via cr-sqlite changesets.
- FTS index (`unified_memories_fts`) is rebuilt locally from synced `unified_memories` content.

### Schema Compatibility

The iOS app uses the same table schema as the desktop app through a generated canonical bootstrap SQL artifact checked in at `apps/ios/ADE/Resources/DatabaseBootstrap.sql`. Desktop `kvDb.ts` remains the schema source of truth.

Current Phase 6 stance:

- The iOS local database now boots under the native SQLite3 path used by the app and remains the source of truth for offline reads on the phone.
- W5 shipped the hardening baseline: host-side CRR integrity repair for phone-critical tables, explicit Lanes / Work / PR hydration, authoritative lane/workspace metadata persistence, read-only protections, reconnect/revoke/forget correctness, and the dedicated Settings tab.
- W6 expanded the lane projections beyond simple summaries. The phone now persists lane list snapshots plus cached lane-detail payloads keyed by lane ID so the Lanes tab can render the desktop stack/git/diff/manage/work surfaces without reconstructing them client-side.
- The host now exposes command-policy metadata and richer lane payloads through the sync command path, so iPhone queueing and action gating follow host-declared rules instead of hardcoded mobile assumptions.
- The remaining risk is validation, not architecture: simulator/device runs still need to prove the full Lanes surface, create/manage flows, git/rebase actions, and reconnect behavior against live desktop data.

---

## WebSocket Client Architecture

### Connection Lifecycle

1. App launch: read pairing token from Keychain.
2. Resolve host address from the saved draft or manual entry.
3. Open WebSocket connection.
4. Send local `db_version`, receive catchup changesets.
5. Enter continuous bidirectional sync.
6. On disconnect: automatic reconnection with exponential backoff.

### Message Types

| Type | Direction | Purpose |
|---|---|---|
| `changeset_batch` | Bidirectional | cr-sqlite changeset batch |
| `pairing_request` / `pairing_result` | Phone to host / host to phone | Numeric-code pairing |
| `command` | Phone to host | Execution request (create PR, run command, etc.) |
| `command_ack` | Host to phone | Command receipt confirmation |
| `command_result` | Host to phone | Command execution result or error |
| `file_request` / `file_response` | Bidirectional | On-demand file access |
| `terminal_subscribe` / `terminal_data` | Phone to host / host to phone | Terminal output streaming |
| `chat_subscribe` / `chat_event` | Phone to host / host to phone | Agent chat transcript streaming. Subscribe sends a snapshot of recent events; incremental events follow via polling. |
| `heartbeat` | Bidirectional | Connection health (30s interval) |

### Offline Behavior

- All synced state is available offline from the local database.
- Execution commands queue locally and replay on reconnect.
- UI shows "pending sync" indicators for queued actions.

---

## iOS-Specific Services

### Keychain (KeychainService)

- Stores the paired device secret used after numeric-code pairing.
- Stores enough connection draft metadata for reconnect.
- Uses iOS Keychain Services API for local secret storage.

### Background App Refresh (BackgroundRefresh)

- Registers `BGAppRefreshTask` for periodic state sync when backgrounded.
- iOS grants ~30 seconds per fetch window.
- Priorities: sync cr-sqlite changesets, update notification badges.

### Push Notifications (NotificationService)

- Phase 6: local notifications when app is in foreground.
- Phase 7: APNs relay for background/terminated delivery (self-hosted or FCM).
- Deep links: notification tap navigates to relevant screen (mission detail, intervention, chat).

### Haptic Feedback

- Confirmation haptics on message send, intervention approval, mission launch, PR merge.
- Uses `UIImpactFeedbackGenerator` and `UINotificationFeedbackGenerator`.

---

## Tab Structure

### Phase 6 (Project Management)

| Tab | Icon | Desktop Equivalent | Capabilities |
|---|---|---|---|
| **Lanes** | `rectangle.3.group` | `/lanes` | Full live-desktop lane surface: search/filter chips, open lanes, create/attach/manage, stack, git/diff/rebase/conflicts, lane-scoped sessions and AI chats |
| **Files** | `doc.text` | `/files` | Lane-backed workspace picker, live file tree/search/read, protected-workspace read-only parity |
| **Work** | `terminal` | `/work` | Terminal session list, cached history with persisted lane names, read-only output streaming, quick-launch actions |
| **PRs** | `arrow.triangle.pull` | `/prs` | PR list, detail, state-gated merge/close/reopen/request-reviewer baseline, diff viewer |
| **Settings** | `gearshape` | `/settings` (sync subset) | Pairing, reconnect, host identity, per-domain sync state, disconnect/forget |

### Phase 7 (Full AI Orchestration)

Additional tabs added in Phase 7:

| Tab | Desktop Equivalent | Capabilities |
|---|---|---|
| **Missions** | `/missions` | Mission list, detail, launch, intervention approval, history, budget |
| **CTO/Chat** | `/cto` | CTO chat, worker chat, ad-hoc sessions, org chart, streaming tokens |
| **Automations** | `/automations` | Rule list, enable/disable, run history, digest |
| **Graph** | `/graph` | Workspace topology, overlays, node navigation |
| **History** | `/history` | Operation history, filters, search |
| **Settings parity expansion** | `/settings` | Devices, providers, notifications, general, context, usage beyond the Phase 6 sync shell |

---

## Implementation Status

| Component | Status | Phase |
|---|---|---|
| Xcode project setup | Implemented | Phase 6 W4 |
| Native SQLite3 + cr-sqlite integration | Implemented | Phase 6 W4 |
| WebSocket client | Implemented | Phase 6 W4 |
| Numeric-code pairing flow | Implemented | Phase 6 W4 |
| QR pairing flow | Implemented in the phone shell; still needs repeated live validation coverage | Phase 6 W5 |
| Lanes tab | Implemented to live desktop parity on iPhone | Phase 6 W6 |
| Files tab | Implemented to W5 dogfood baseline | Phase 6 W5 |
| Work tab | Implemented to W5 dogfood baseline | Phase 6 W5 |
| PRs tab | Implemented to W5 dogfood baseline | Phase 6 W5 |
| Sync Settings tab | Implemented (pairing, reconnect, status, disconnect/forget) | Phase 6 W5 |
| Missions tab | Planned | Phase 7 W1 |
| CTO/Chat tab | Planned | Phase 7 W2 |
| Automations, Graph, History tabs | Planned | Phase 7 W3 |
| Full Settings parity | Planned | Phase 7 W4 |
| Push notifications (APNs) | Planned | Phase 7 W5 |
| iPad adaptive layout | Planned | Phase 7 W10 |
| Widgets + Spotlight | Planned | Phase 7 W10 |

**Overall status**: The Phase 6 controller architecture is shipped. W5 delivered the hardening baseline that made Lanes / Files / Work / PRs plus Settings trustworthy for day-to-day phone use, and W6 brought the iPhone Lanes tab up to the full live desktop surface using richer host-backed lane payloads and command routing. The main remaining work is validation breadth on simulator/device and the Phase 7 tabs that have not shipped yet.
