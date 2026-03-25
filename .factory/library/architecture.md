# Architecture

Architectural decisions, patterns discovered, and design principles.

**What belongs here:** Architectural patterns, data flow, component organization, design decisions.

---

## iOS App Architecture

### Pattern: MVVM-like with Shared Service
- `SyncService` is the shared `@MainActor ObservableObject` injected via `.environmentObject()`
- Views own local `@State` for UI concerns
- Views call into `SyncService` for remote operations and data fetching
- Data flow: `SyncService` → `DatabaseService` (SQLite) → `localStateRevision` increment → SwiftUI reactivity via `.task(id: syncService.localStateRevision)`

### File Structure
```
ADE/
├── App/
│   ├── ADEApp.swift              # App entry point, UIKit theme config
│   └── ContentView.swift         # Root TabView, Settings tab, design system components
├── Views/
│   ├── LanesTabView.swift        # ~3,706 lines - complete
│   ├── FilesTabView.swift        # ~500 lines - baseline
│   ├── WorkTabView.swift         # ~300 lines - baseline
│   └── PRsTabView.swift          # ~500 lines - baseline
├── Models/
│   └── RemoteModels.swift        # ~700 lines - all domain models
├── Services/
│   ├── Database.swift            # ~1,949 lines - SQLite + cr-sqlite sync
│   ├── KeychainService.swift     # ~50 lines - token persistence
│   └── SyncService.swift         # ~1,781 lines - WebSocket + Bonjour + RPC
└── Resources/
    └── DatabaseBootstrap.sql     # ~2,260 lines - full schema
```

### Database
- Direct SQLite3 C API (no ORM)
- cr-sqlite change tracking with custom triggers (insert/update/delete)
- Bidirectional changeset sync via WebSocket
- Site ID management (persistent 128-bit random)
- Full bootstrap SQL schema (~2,260 lines) mirroring desktop

### Networking
- Raw `URLSessionWebSocketTask` — no third-party dependencies
- JSON envelopes with optional gzip compression (>4KB)
- Heartbeat ping/pong protocol
- Auto-reconnect with exponential backoff
- Bonjour (`NetServiceBrowser`) for LAN discovery
- Connection-scoped async work in `SyncService` must be tied to the active socket/session: store long-lived tasks so `disconnect()` and host switching can cancel them, and ignore stale send/receive callbacks unless they still belong to the current `socket`

### Command Routing
- State-only operations: write locally → cr-sqlite syncs to host
- Execution operations: send command via WebSocket → host executes → state syncs back
- Offline command queue: persisted to UserDefaults, flushed on reconnect

### Key Model Types (RemoteModels.swift)
- `RemoteLane`, `RemoteLaneDetail`, `LaneStateSnapshot`
- `RemoteTerminalSession`, `SessionHistoryEntry`
- `PullRequestRow`, `PullRequestSnapshot`, `PRDetailPayload`
- `RemoteFileNode`, `RemoteSearchResult`
- `ChatMessage`, `ToolCallResult`

### Adding New Swift Files
New .swift files MUST be added to the Xcode project by editing `ADE.xcodeproj/project.pbxproj`.
Both `PBXFileReference` and `PBXSourcesBuildPhase` sections need entries.
