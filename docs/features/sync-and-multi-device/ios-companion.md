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
│   │   ├── ADEApp.swift             # SwiftUI app entry
│   │   └── ContentView.swift        # slim 5-tab TabView
│   ├── Models/
│   │   └── RemoteModels.swift       # Codable structs mirroring shared types
│   ├── Resources/
│   │   └── DatabaseBootstrap.sql    # generated from desktop kvDb.ts
│   ├── Services/
│   │   ├── Database.swift           # SQLite + pure-SQL CRR + offline caches
│   │   ├── KeychainService.swift    # paired device secret storage
│   │   └── SyncService.swift        # WebSocket client, command routing,
│   │                                # PIN pairing, lane presence, chat push
│   ├── Views/
│   │   ├── Components/              # ADEDesignSystem, haptics, shimmer,
│   │   │                            # mobile primitives, code rendering cache
│   │   ├── Lanes/                   # AddLaneSheet, LaneDetailScreen,
│   │   │                            # LaneChat*, LaneCommitBar, LaneDiff*,
│   │   │                            # LaneListViewParts, LaneTreeView, etc.
│   │   ├── Files/                   # FilesRootScreen, FilesDirectoryScreen,
│   │   │                            # FilesDetailScreen, *+Actions helpers
│   │   ├── Work/                    # WorkRootScreen, WorkChatSessionView,
│   │   │                            # Work*Helpers, WorkNewChat*,
│   │   │                            # WorkSessionDestination*, etc.
│   │   ├── PRs/                     # PrsRootScreen, PrDetailScreen and
│   │   │                            # per-tab views, PrWorkflowCards,
│   │   │                            # PrStackSheet, CreatePrWizardView
│   │   ├── Settings/                # ConnectionSettingsView + modular
│   │   │                            # SettingsPairingSection,
│   │   │                            # SettingsAppearanceSection,
│   │   │                            # SettingsDiagnosticsSection,
│   │   │                            # SettingsConnectionHeader,
│   │   │                            # SettingsPinSheet
│   │   ├── LanesTabView.swift
│   │   ├── FilesTabView.swift
│   │   ├── WorkTabView.swift
│   │   └── PRsTabView.swift
│   └── Assets.xcassets/             # App icon, brand mark, provider logos
│                                    # (Anthropic, Claude, Codex, Cursor,
│                                    # OpenAI, OpenCode)
└── ADETests/
    └── ADETests.swift
```

Each tab is factored into a root screen, one `+Actions` extension for
side-effecting work, and several helper modules (timeline, markdown
parsing, model catalog, session grouping) to keep individual files
under a few hundred lines. This split is the primary reason the Work
tab grew from one ~3,000-line file to ~30 focused files.

Deployment target: iOS 26+. iPhone and iPad (adaptive layouts planned for
Phase 7).

### Connection status UI

Host connection status is surfaced through a single shared component,
`ADEConnectionDot` (in `Views/Components/ADEDesignSystem.swift`). It
renders a colored dot, a state label (Connected / Syncing / Connecting
/ Disconnected / Error), and the truncated host name when connected,
and acts as a 44pt button that opens Settings. Tint mapping:

| Connection state | Color |
|---|---|
| `connected` | success (green) |
| `syncing` | warning (amber) |
| `connecting` | warning (amber) |
| `disconnected` | danger (red) |
| `error` | danger (red) |

The dot is placed in the top-leading `ToolbarItem` of every top-level
tab (Lanes, Files, Work, PRs) and every deep screen
(`LaneDetailScreen`, `PrDetailView`, `WorkSessionDestinationView`,
`WorkNewChatScreen`, `FilesDirectoryScreen`; `FilesDetailScreen`
hosts it alongside its back-button affordance). It replaces the
older `ADEConnectionPill` and the per-tab "connection notice" banner
cards — controllers no longer ship duplicate offline / reconnect /
hydrating cards inside each screen body.

Accessibility: the dot exposes `accessibilityLabel` that includes the
host name when connected and trims the last error message for the
error state, an `accessibilityHint` of "Opens settings to pair or
reconnect", and `accessibilityShowsLargeContentViewer()` so VoiceOver
and Large Content can reach it.

The one remaining inline banner per tab is the hydration-failure
notice built from `SyncDomainStatus.inlineHydrationFailureNotice(for:)`
on `RemoteModels.swift`. It surfaces only when a domain is in
`.failed` phase (so cached rows may still render underneath) and
offers a single "Retry" action that calls `reload(refreshRemote: true)`.
The read-only header strip in `FilesHeaderStrip` also appends a
compact "Syncing" / "Connecting" / "Offline" suffix derived directly
from `SyncService.connectionState` and `status(for: .files).phase`.

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
   connection draft (host, port, QR payload v2 address candidates).
2. Open WebSocket connection. `reconnectIfPossible` is guarded so
   overlapping wake-ups never stack TCP/WebSocket attempts.
3. Send local `db_version`, receive catchup changesets.
4. Enter continuous bidirectional sync.
5. On disconnect: automatic reconnection with exponential backoff.
6. After pairing completes, the phone announces currently-open lanes
   via `lanes.presence.announce` so the host decorates
   `LaneSummary.devicesOpen` for other controllers; the phone calls
   `lanes.presence.release` when the user leaves a lane surface and
   re-announces on a 30 s heartbeat (host-side TTL is 60 s).

### Message types

Implemented envelope types on iOS:

| Type | Direction | Purpose |
|---|---|---|
| `hello` / `hello_ok` / `hello_error` | Bidirectional | Handshake |
| `pairing_request` / `pairing_result` | Phone → host / host → phone | 6-digit PIN pairing |
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

- Stores the paired device secret produced after a successful PIN
  pairing.
- Stores connection draft metadata (host, port, last remote db
  version) so reconnects resume cleanly. The legacy
  `lastBrainDeviceId` draft field has been removed — connections now
  resolve an address candidate from the host's device registry.
- Uses iOS Keychain Services API (`SecItemAdd` / `SecItemCopyMatching`
  / `SecItemUpdate` / `SecItemDelete`).

### PIN pairing flow

1. User opens Settings > Sync on the host desktop and sets a 6-digit
   PIN. The desktop writes `.ade/secrets/sync-pin.json` (chmod `0600`)
   and surfaces it on the Settings > Sync sheet for the duration the
   user wants to accept pairings.
2. Phone opens Settings > Pairing, either scans the desktop QR (which
   carries address candidates + port only) or enters host/port
   manually, then types the same PIN the user set.
3. Phone sends a `pairing_request` envelope with the PIN. The host's
   `syncPairingStore.pairPeer` validates against `syncPinStore`; the
   failure codes are `invalid_pin`, `pin_not_set`, or `pairing_failed`.
4. On success the host persists a per-device record and returns a
   secret. The phone stores it in Keychain and subsequent connections
   authenticate with the paired secret, not the PIN.

`SettingsPinSheet` on iOS mirrors the desktop PIN sheet and handles
the entry UX. If the user misreads the digits, the host applies
per-IP rate limiting (5 failures → 10-minute cooldown).

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

### Shipped

| Tab | Icon | Desktop equivalent | Capabilities |
|---|---|---|---|
| **Lanes** | `square.stack.3d.up` | `/lanes` | Full lane surface: search/filter chips, open/create/attach/manage, stack, git/diff/rebase/conflicts, lane-scoped sessions and AI chats. `devicesOpen` presence chips show which other devices currently have the lane open. |
| **Files** | `doc.text` | `/files` | Lane-backed workspace picker, live file tree/search/read, protected-workspace read-only parity. `mobileReadOnly` on the workspace payload gates mutating file actions on the phone via `ensureMobileFileMutationsAllowed`. |
| **Work** | `terminal` | `/work` | Terminal + chat session list, cached history with persisted lane names, read-only output streaming, quick-launch actions, session pinning, live chat-event push from the host (no polling lag once subscribed). |
| **PRs** | `arrow.triangle.pull` | `/prs` | PR list/detail driven by `prs.getMobileSnapshot`: stack visibility (`PrStackSheet`), create-PR wizard (`CreatePrWizardView`) gated by per-lane eligibility, workflow cards (queue / integration / rebase) rendered from `PrWorkflowCard`, per-PR action capabilities. |
| **Settings** | `gearshape` | `/settings` (sync subset) | PIN pairing (`SettingsPinSheet`), appearance, diagnostics, connection header with QR payload and address candidates, reconnect, forget. |

### Planned

- Missions, CTO/Chat, Automations, Graph, History tabs.
- Full Settings parity with the desktop (beyond the current sync/
  appearance/diagnostics subset).
- APNs relay for background/terminated notifications.
- iPad adaptive layout, widgets, Spotlight.

## Lane data projection

Rather than reconstructing lane detail surfaces client-side from
primitive rows, the iOS app persists richer projections the host
sends:

- Lane list snapshots (`LaneListSnapshot`) with runtime bucket
  summaries (running / awaiting-input / ended / session count).
- Cached lane-detail payloads (`LaneDetailPayload`) keyed by lane id
  so the Lanes tab can render the desktop stack / git / diff / manage
  / work surfaces without client-side reconstruction.
- `LaneSummary.devicesOpen` lists the devices currently on a lane,
  decorated by the host from `lanes.presence.announce` events.

The host produces these via `lanes.refreshSnapshots` and
`lanes.getDetail` remote commands. The phone calls the command, stores
the result, and reads from the local store afterward so reconnects and
offline usage remain fast.

## PR data projection

The iOS PRs tab consumes a single aggregate command,
`prs.getMobileSnapshot`, which returns `PrMobileSnapshot`:

- `prs` — `PrSummary` rows (same shape as desktop).
- `stacks` — ordered lane chains with `PrStackMember` entries
  (`role: root | middle | leaf`, dirty flag, PR linkage, base/head
  branches, checks/review status).
- `capabilities` — `PrActionCapabilities` keyed by PR id with
  per-action gates (`canMerge`, `canClose`, `canReopen`,
  `canRequestReviewers`, `canRerunChecks`, `canComment`,
  `canUpdateDescription`, `canDelete`) plus `mergeBlockedReason` and
  `requiresLive`.
- `createCapabilities` — `PrCreateLaneEligibility[]` powering the
  mobile create-PR wizard; each lane carries `canCreate`,
  `blockedReason`, default base branch, and a default title.
- `workflowCards` — union of `PrQueueWorkflowCard`,
  `PrIntegrationWorkflowCard`, `PrRebaseWorkflowCard` rendered by
  `PrWorkflowCards.swift`.
- `live: boolean` — false signals the phone should render a
  "host offline" banner.

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
| PIN pairing flow | Implemented |
| QR pairing payload (v2, address candidates + port) | Implemented |
| Lanes tab | Implemented to live desktop parity (with `devicesOpen`) |
| Files tab | Implemented with `mobileReadOnly` workspace gate |
| Work tab | Implemented; live chat-event push from host |
| PRs tab | Implemented; driven by `prs.getMobileSnapshot` |
| Settings tab (pairing / appearance / diagnostics) | Implemented |
| Missions tab | Planned |
| CTO / Automations / Graph / History tabs | Planned |
| Full Settings parity | Planned |
| Push notifications (APNs) | Planned |
| iPad adaptive layout | Planned |
| Widgets + Spotlight | Planned |

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
- **Chat streaming is push, with polling as fallback.** Once a phone
  sends `chat_subscribe`, the host fans out `chat_event` envelopes in
  real time from `agentChatService.subscribeToEvents`. The host still
  runs its polling path on reconnect / catchup to fill any gap; the
  phone de-duplicates per-event keys so a push and a catchup poll
  covering the same event produce one rendered message.
- **Lane presence is best-effort with a TTL.** The phone
  re-announces on a 30 s cadence; the host prunes stale entries at
  60 s. A phone that crashes without sending `lanes.presence.release`
  will disappear from `devicesOpen` one cycle later, not instantly.
- **`mobileReadOnly` is an additional gate on top of
  `isReadOnlyByDefault`.** The iOS app checks both before allowing a
  `files.*` mutating command. A workspace that is desktop-writable
  may still be read-only from the phone to avoid accidental edits
  on a lossy network.
