# iOS Companion

The ADE iOS app is a native SwiftUI companion that acts as a **controller**
for a desktop or VPS host running the full ADE Electron app. The phone
never runs agents; it reads synced state from a local SQLite DB and sends
execution commands to the host over WebSocket.

This doc summarises the architecture at a level useful for understanding
the sync surface. For the full roadmap, see Phase 6 and Phase 7 plans in
the repo's `docs/final-plan/`.

## Project layout

```
apps/ios/
├── ADE.xcodeproj/
├── ADE/
│   ├── App/
│   │   ├── ADEApp.swift           # SwiftUI app entry
│   │   └── ContentView.swift
│   ├── Models/
│   │   └── RemoteModels.swift     # decoding structs
│   ├── Resources/
│   │   └── DatabaseBootstrap.sql  # generated from desktop kvDb.ts
│   ├── Services/
│   │   ├── Database.swift         # SQLite + pure-SQL CRR emulation
│   │   ├── KeychainService.swift  # paired device secret storage
│   │   └── SyncService.swift      # WebSocket client, command routing
│   ├── Views/
│   │   ├── LanesTabView.swift
│   │   ├── FilesTabView.swift
│   │   ├── WorkTabView.swift
│   │   └── PRsTabView.swift
│   └── Assets.xcassets/
└── ADETests/
    └── ADETests.swift
```

Deployment target: iOS 26+. iPhone and iPad (adaptive layouts planned for
Phase 7).

## Architectural pattern

The implementation is deliberately small:

- **Views** — one SwiftUI view per top-level tab. State is a mix of
  `@StateObject` (for sync) and view-local `@State`.
- **Services** — three singletons: `DatabaseService`, `SyncService`,
  `KeychainService`. Everything else builds on these.
- **Models** — plain Swift structs (`RemoteModels.swift`), decoded from
  JSON.
- **Environment injection** — `SyncService` is injected as a shared
  `@StateObject` / `@EnvironmentObject` from `ADEApp`.

Navigation:

- `TabView` at the root with five tabs (Lanes, Files, Work, PRs, Settings).
- `NavigationStack` per tab for push/pop.
- Deep links from push notifications jump to specific screens.

## Database: native SQLite + pure-SQL CRR

Source: `apps/ios/ADE/Services/Database.swift`.

The phone runs **system SQLite** via the `SQLite3` C API with Swift
bindings. cr-sqlite is implemented in pure SQL against that stock
SQLite — see `crdt-model.md` for the full story on why the native
cr-sqlite extension cannot be loaded on iOS and how the emulation
works.

Bootstrap flow on first launch:

1. Create `Application Support/ADE/ade.db`.
2. Load `DatabaseBootstrap.sql` (checked in, generated from desktop
   `kvDb.ts`).
3. Register custom SQLite functions (`ade_next_db_version`,
   `ade_local_site_id`, `ade_capture_local_changes`).
4. Call `enableCrr(for:)` on every discovered non-internal table to
   install the three triggers (INSERT / UPDATE / DELETE) per table.
5. Assign a stable local site id stored at
   `Application Support/ADE/secrets/sync-site-id`.
6. Replace the legacy disposable iOS cache DB if it is detected at
   the old path.

Reads are plain SQL queries — instant, offline-capable, and drive the
SwiftUI views directly. Writes happen to the same local DB first;
`crsql_changes` trigger rows flow out through `SyncService.exportChangesSince`
and across the WebSocket.

`Notification.Name.adeDatabaseDidChange` is posted after every write
that materially alters read-visible state so SwiftUI views re-query.

## Sync service

Source: `apps/ios/ADE/Services/SyncService.swift`.

### Connection lifecycle

1. App launch: read pairing secret from Keychain. Read the stored
   connection draft (host, port, last brain device id).
2. Open WebSocket connection.
3. Send local `db_version` (from `AdeDb.sync.getDbVersion()`
   equivalent on iOS), receive catchup changesets.
4. Enter continuous bidirectional sync.
5. On disconnect: automatic reconnection with exponential backoff.

### Message types

Implemented envelope types on iOS:

| Type | Direction | Purpose |
|---|---|---|
| `hello` / `hello_ok` / `hello_error` | Bidirectional | Handshake |
| `pairing_request` / `pairing_result` | Phone → host / host → phone | Numeric-code pairing |
| `changeset_batch` | Bidirectional | cr-sqlite changeset batch |
| `command` | Phone → host | Execution request |
| `command_ack` | Host → phone | Command receipt |
| `command_result` | Host → phone | Execution result or error |
| `file_request` / `file_response` | Bidirectional | On-demand file access |
| `terminal_subscribe` / `terminal_data` | Phone → host / host → phone | Terminal streaming |
| `chat_subscribe` / `chat_event` | Phone → host / host → phone | Agent chat transcript streaming |
| `heartbeat` | Bidirectional | Connection health (30s) |
| `brain_status` | Host → phone | Cluster authority broadcast |

Gzip decompression uses the system `zlib` module. `unwrapSyncCommandResponse`
turns a raw response dict into either the `result` value or throws an
`NSError` with `ADEErrorCode` when `ok: false`.

### Offline behavior

- All synced state is available offline from the local DB.
- Execution commands queue locally and replay on reconnect.
- UI shows "pending sync" indicators for queued actions.

### Timeouts

`SyncRequestTimeout.defaultTimeoutNanoseconds = 30_000_000_000` (30s).
Timed-out requests throw with the message *"The host took too long to
respond. Reconnecting now."* The reconnect is automatic.

`InitialHydrationGate` polls for the project row at 200ms intervals up
to a 15s total budget. This covers the first sync-after-pairing gap
where the phone has opened the WebSocket but the project row has not
yet arrived in the catchup batch.

## iOS-specific services

### KeychainService

- Stores the paired device secret produced during numeric-code
  pairing.
- Stores connection draft metadata (host, port, last brain device id,
  last remote db version) so reconnects resume cleanly.
- Uses iOS Keychain Services API (`SecItemAdd` / `SecItemCopyMatching`
  / `SecItemUpdate` / `SecItemDelete`).

### Background App Refresh

- Registers `BGAppRefreshTask` for periodic state sync when the app
  is backgrounded.
- iOS grants ~30 seconds per fetch window.
- Priority order: sync cr-sqlite changesets, update notification badges.

### Push Notifications

- Phase 6: local notifications when foregrounded.
- Phase 7 (planned): APNs relay for background/terminated delivery.
- Deep links from notification tap navigate to relevant screen
  (mission detail, intervention, chat).

### Haptic Feedback

- `UIImpactFeedbackGenerator` and `UINotificationFeedbackGenerator`
  on message send, intervention approval, mission launch, PR merge.

## Tab structure

### Phase 6 (shipped)

| Tab | Icon | Desktop equivalent | Capabilities |
|---|---|---|---|
| **Lanes** | `rectangle.3.group` | `/lanes` | Full lane surface: search/filter chips, open/create/attach/manage, stack, git/diff/rebase/conflicts, lane-scoped sessions and AI chats |
| **Files** | `doc.text` | `/files` | Lane-backed workspace picker, live file tree/search/read, protected-workspace read-only parity |
| **Work** | `terminal` | `/work` | Terminal session list, cached history with persisted lane names, read-only output streaming, quick-launch actions |
| **PRs** | `arrow.triangle.pull` | `/prs` | PR list/detail, state-gated merge/close/reopen/request-reviewer, diff viewer |
| **Settings** | `gearshape` | `/settings` (sync subset) | Pairing, reconnect, host identity, per-domain sync state, disconnect/forget |

### Phase 7 (planned)

Planned tabs: Missions, CTO/Chat, Automations, Graph, History,
Settings parity expansion.

## Lane data projection (Phase 6 W6)

Rather than reconstructing lane detail surfaces client-side from
primitive rows, the iOS app persists richer projections the host
sends:

- Lane list snapshots (`LaneListSnapshot`) with runtime bucket
  summaries (running / awaiting-input / ended / session count).
- Cached lane-detail payloads (`LaneDetailPayload`) keyed by lane id
  so the Lanes tab can render the desktop stack / git / diff / manage
  / work surfaces without client-side reconstruction.

The host produces these via `lanes.refreshSnapshots` and
`lanes.getDetail` remote commands. The phone calls the command, stores
the result, and reads from the local store afterward so reconnects and
offline usage remain fast.

## Command policy from the host

The host exposes command-policy metadata
(`SyncRemoteCommandDescriptor.policy` with `viewerAllowed`,
`requiresApproval`, `localOnly`, `queueable`) through the sync command
surface. The phone reads these descriptors and gates UI actions
against them instead of relying on hardcoded mobile assumptions. A
host that disables a command via policy change is immediately
reflected in the phone's UI on the next descriptor read.

## Implementation status (phone specifics)

| Component | Status |
|---|---|
| Xcode project setup | Implemented |
| Native SQLite3 + pure-SQL CRR | Implemented |
| WebSocket client | Implemented |
| Numeric-code pairing flow | Implemented |
| QR pairing flow | Shell shipped; needs broader live validation |
| Lanes tab | Implemented to live desktop parity |
| Files tab | Implemented to W5 baseline |
| Work tab | Implemented to W5 baseline |
| PRs tab | Implemented to W5 baseline |
| Sync Settings tab | Implemented |
| Missions tab | Planned (Phase 7 W1) |
| CTO/Chat tab | Planned (Phase 7 W2) |
| Automations / Graph / History tabs | Planned (Phase 7 W3) |
| Full Settings parity | Planned (Phase 7 W4) |
| Push notifications (APNs) | Planned (Phase 7 W5) |
| iPad adaptive layout | Planned (Phase 7 W10) |
| Widgets + Spotlight | Planned (Phase 7 W10) |

## Gotchas

- **Phones never host.** Any future feature that needs to run on the
  phone should be implemented as a controller operation that sends a
  command to the host. Agent processes, PTYs, worktrees, workers,
  mission orchestration — all host-side.
- **The phone's local DB is authoritative for reads.** If a read
  looks stale, the fix is on the host push side (make sure the table
  is a CRR, make sure writes land in a table the phone reads), not
  on the phone. Avoid adding host-only caches that the phone has no
  way to observe.
- **Keychain items survive app uninstall on some iOS builds.**
  Pairing forget should both clear Keychain and clear the draft row;
  the Settings tab's "Forget host" does both.
- **The ADE iOS bootstrap SQL is generated.** When desktop `kvDb.ts`
  schema changes, regenerate `DatabaseBootstrap.sql`. Schema drift
  between desktop and iOS breaks the first-launch bootstrap, and
  `changeset_batch` apply will fail for tables that don't exist
  locally.
- **`InitialHydrationGate` can fire its 15s timeout on slow links.**
  The visible symptom is "The host returned incomplete ... data."
  Bumping the timeout globally is not recommended; instead improve
  the host's catchup responsiveness or let the user retry.
- **Per-command latency matters more than throughput.** The phone
  often submits one command at a time (user tapped "merge"). Keep
  command handlers on the host responsive; bulk operations should
  be batched into a single command with a single reply rather than
  rapid-fire command storms.
- **Chat streaming is polling-based, not push.** `chat_subscribe`
  sends a snapshot then begins polling for new entries server-side;
  the phone receives `chat_event` envelopes as the host finds them.
  This design choice makes reconnection simple at the cost of some
  latency.
