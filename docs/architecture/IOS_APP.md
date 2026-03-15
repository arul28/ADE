# iOS App Architecture

> Roadmap reference: `docs/final-plan/phase-6.md` (Phase 6) and `docs/final-plan/phase-7.md` (Phase 7).

> Last updated: 2026-03-15

> Status: **Phase 6 planned, not yet implemented.**

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

The iOS app is a native SwiftUI application that acts as a viewer/controller for an ADE brain (a Mac or VPS running the full desktop app). It maintains a local cr-sqlite database that syncs live cluster state from the brain in real time. The phone never runs agents -- it reads synced state and sends commands to the brain for execution.

Desktop portability note:

- iOS depends on ADE sync and a live/reachable brain
- desktop-to-desktop portability also depends on tracked portable ADE project intelligence in the repo
- that portable desktop layer is not an iOS concern because phones are never standalone brains

---

## Project Structure

```
apps/ios/                          # To be created
├── ADE.xcodeproj/
├── ADE/
│   ├── App/
│   │   ├── ADEApp.swift           # App entry point
│   │   └── ContentView.swift      # Root tab navigation
│   ├── Models/
│   │   ├── Database.swift         # SQLite.swift + cr-sqlite setup
│   │   └── ...                    # Domain model types
│   ├── Services/
│   │   ├── SyncService.swift      # WebSocket client, changeset exchange
│   │   ├── CommandService.swift   # Send execution commands to brain
│   │   ├── KeychainService.swift  # Pairing token and secret storage
│   │   ├── NotificationService.swift  # Local + push notification handling
│   │   └── BackgroundRefresh.swift    # Background app refresh
│   ├── Views/
│   │   ├── Lanes/                 # Lanes tab views
│   │   ├── Files/                 # Files tab views
│   │   ├── Work/                  # Work tab views
│   │   ├── PRs/                   # PRs tab views
│   │   ├── Missions/              # Phase 7: Missions tab
│   │   ├── CTO/                   # Phase 7: CTO & Chat tab
│   │   ├── Automations/           # Phase 7: Automations tab
│   │   ├── Settings/              # Device settings, connection info
│   │   └── Shared/                # Reusable components
│   └── Utilities/
│       ├── SyntaxHighlighter.swift
│       └── ANSIRenderer.swift     # Terminal ANSI color rendering
├── Tests/
└── Packages/                      # SPM dependencies
```

---

## SwiftUI Architecture

### Pattern

The app uses a standard SwiftUI architecture with `@Observable` view models (Swift 5.9+):

- **Views**: SwiftUI views, declarative, no business logic.
- **ViewModels**: `@Observable` classes that own state and coordinate services. One per screen or logical unit.
- **Services**: Singletons injected via SwiftUI environment. Handle database, sync, commands, keychain.
- **Models**: Plain Swift structs mapped from SQLite rows.

### Navigation

- `TabView` at the root with four tabs (Phase 6) expanding to more (Phase 7).
- `NavigationStack` within each tab for push/pop navigation.
- Deep links from push notifications navigate to specific screens.

### Target

- iOS 17+ (required for `@Observable` macro and modern SwiftUI APIs).
- iPhone and iPad (adaptive layouts in Phase 7).

---

## SQLite and cr-sqlite Integration

### Stack

| Layer | Library | Purpose |
|---|---|---|
| SQLite engine | System SQLite (iOS) | Native SQLite runtime |
| Swift bindings | SQLite.swift | Type-safe query building |
| CRDT extension | cr-sqlite | Conflict-free replication |

### Database Setup

1. On first launch, create the local `ade.db` with the same schema as the desktop app.
2. Load the cr-sqlite extension into the SQLite connection.
3. Mark all tables as CRRs (`SELECT crsql_as_crr('table_name')`).
4. Assign a unique site ID for this device.

### Data Flow

- All reads are local SQLite queries -- instant, offline-capable.
- Writes from user actions are written locally first, then synced to brain via cr-sqlite changesets.
- FTS index (`unified_memories_fts`) is rebuilt locally from synced `unified_memories` content.

### Schema Compatibility

The iOS app uses the same table schema as the desktop app. Schema migrations are versioned and applied on both platforms. cr-sqlite handles schema evolution transparently for new columns.

---

## WebSocket Client Architecture

### Connection Lifecycle

1. App launch: read pairing token from Keychain.
2. Resolve brain address (cached IP, mDNS discovery, or Tailscale IP).
3. Open WebSocket connection with pairing token authentication.
4. Send local `db_version`, receive catchup changesets.
5. Enter continuous bidirectional sync.
6. On disconnect: automatic reconnection with exponential backoff.

### Message Types

| Type | Direction | Purpose |
|---|---|---|
| `changeset` | Bidirectional | cr-sqlite changeset batch |
| `command` | Phone to brain | Execution request (create PR, run command, etc.) |
| `command_ack` | Brain to phone | Command receipt confirmation |
| `command_result` | Brain to phone | Command execution result or error |
| `file_request` / `file_response` | Bidirectional | On-demand file access |
| `terminal_subscribe` / `terminal_data` | Phone to brain / brain to phone | Terminal output streaming |
| `heartbeat` | Bidirectional | Connection health (30s interval) |

### Offline Behavior

- All synced state is available offline from the local database.
- Execution commands queue locally and replay on reconnect.
- UI shows "pending sync" indicators for queued actions.

---

## iOS-Specific Services

### Keychain (KeychainService)

- Stores pairing token, shared secret, and device identity.
- Uses iOS Keychain Services API with `kSecAttrAccessibleAfterFirstUnlock` for background access.
- Pairing tokens are per-project.

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
| Xcode project setup | Planned | Phase 6 W5 |
| SQLite.swift + cr-sqlite integration | Planned | Phase 6 W5 |
| WebSocket client | Planned | Phase 6 W5 |
| Pairing flow (QR scan) | Planned | Phase 6 W5 |
| Lanes tab | Planned | Phase 6 W6 |
| Files tab | Planned | Phase 6 W7 |
| Work tab | Planned | Phase 6 W8 |
| PRs tab | Planned | Phase 6 W9 |
| Missions tab | Planned | Phase 7 W1 |
| CTO/Chat tab | Planned | Phase 7 W2 |
| Automations, Graph, History tabs | Planned | Phase 7 W3 |
| Full Settings tab | Planned | Phase 7 W4 |
| Push notifications (APNs) | Planned | Phase 7 W5 |
| iPad adaptive layout | Planned | Phase 7 W10 |
| Widgets + Spotlight | Planned | Phase 7 W10 |

**Overall status**: Not yet implemented. The `apps/ios/` directory does not exist yet. Work begins in Phase 6 W5 after sync infrastructure (W1-W4) is proven.
