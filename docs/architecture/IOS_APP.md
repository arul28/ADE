# iOS App Architecture

> Roadmap reference: `docs/final-plan/phase-6.md` (Phase 6) and `docs/final-plan/phase-7.md` (Phase 7).

> Last updated: 2026-03-16

> Status: **Phase 6 W4 foundation partially implemented. The app exists under `apps/ios/`, uses native SwiftUI + SQLite3, and the four project-management tabs are wired against a real local replicated database contract. The current blocker is the vendored iOS `crsqlite.xcframework`, which is not safely embeddable in its current form and prevents the sync database from booting.**

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

- `TabView` at the root with four tabs (Phase 6) expanding to more (Phase 7).
- `NavigationStack` within each tab for push/pop navigation.
- Deep links from push notifications navigate to specific screens.

### Target

- iOS 17+.
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

Current blocker:

- The vendored iOS `crsqlite.xcframework` exports `sqlite3_crsqlite_init` plus `sqlite3_api`, which indicates a SQLite loadable-extension-style entrypoint.
- Direct `sqlite3_crsqlite_init(db, &err, nil)` crashes because the SQLite API thunk is nil.
- `sqlite3_auto_extension(...)` is deprecated and rejected on Apple platforms.
- iOS system SQLite does not expose `sqlite3_load_extension(...)` as a usable fallback.
- W5 therefore starts with replacing this framework or adding a native wrapper library that links cr-sqlite against SQLite in an iOS-safe way.

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
| **Lanes** | `rectangle.3.group` | `/lanes` | Lane list, detail, create, archive, availability states, agent status |
| **Files** | `doc.text` | `/files` | File tree, syntax-highlighted viewer, search, basic editing, diff viewer |
| **Work** | `terminal` | `/work` | Terminal session list, read-only output streaming, quick-launch actions |
| **PRs** | `arrow.triangle.pull` | `/prs` | PR list, detail, diff viewer, create, merge, close, stacked PR view |

### Phase 7 (Full AI Orchestration)

Additional tabs added in Phase 7:

| Tab | Desktop Equivalent | Capabilities |
|---|---|---|
| **Missions** | `/missions` | Mission list, detail, launch, intervention approval, history, budget |
| **CTO/Chat** | `/cto` | CTO chat, worker chat, ad-hoc sessions, org chart, streaming tokens |
| **Automations** | `/automations` | Rule list, enable/disable, run history, digest |
| **Graph** | `/graph` | Workspace topology, overlays, node navigation |
| **History** | `/history` | Operation history, filters, search |
| **Settings** | `/settings` | Devices, providers, notifications, general, context, usage |

---

## Implementation Status

| Component | Status | Phase |
|---|---|---|
| Xcode project setup | Implemented | Phase 6 W4 |
| Native SQLite3 + cr-sqlite integration | Blocked on vendored iOS artifact shape | Phase 6 W4/W5 |
| WebSocket client | Implemented | Phase 6 W4 |
| Numeric-code pairing flow | Implemented (initial) | Phase 6 W4 |
| QR pairing flow | Planned | Phase 6 W5 |
| Lanes tab | Implemented (initial local-first) | Phase 6 W4 |
| Files tab | Implemented (workspace metadata local-first, file IO remote) | Phase 6 W4 |
| Work tab | Implemented (local sessions + terminal subscribe) | Phase 6 W4 |
| PRs tab | Implemented (initial local-first) | Phase 6 W4 |
| Missions tab | Planned | Phase 7 W1 |
| CTO/Chat tab | Planned | Phase 7 W2 |
| Automations, Graph, History tabs | Planned | Phase 7 W3 |
| Full Settings tab | Planned | Phase 7 W4 |
| Push notifications (APNs) | Planned | Phase 7 W5 |
| iPad adaptive layout | Planned | Phase 7 W10 |
| Widgets + Spotlight | Planned | Phase 7 W10 |

**Overall status**: The app shell and local-first data contract are in place, but the current vendored iOS `crsqlite` framework blocks the replicated database from initializing. W5 starts with fixing that artifact/integration problem, then continues with real-device dogfooding, QR/discovery UX, and broader network/pairing hardening.
