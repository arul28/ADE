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
│   │   ├── AppDelegate.swift        # APNs registration, notification-category
│   │   │                            # setup, response/action routing, deep-link dispatch
│   │   ├── ContentView.swift        # slim 6-tab TabView
│   │   ├── DeepLinkRouter.swift     # ade://session/<id> + ade://pr/<n> URL handler
│   │   │                            # plus notification userInfo dispatch
│   │   │                            # (sessionId / prId / prNumber → prId via
│   │   │                            #  WorkspaceSnapshot lookup)
│   │   └── NotificationCategories.swift # UNNotificationCategory / UNNotificationAction set
│   ├── Models/
│   │   ├── RemoteModels.swift       # Codable structs mirroring shared types
│   │   └── NotificationPreferences.swift # 13-toggle prefs + quiet hours + per-session overrides
│   ├── Resources/
│   │   └── DatabaseBootstrap.sql    # generated from desktop kvDb.ts
│   ├── Services/
│   │   ├── Database.swift           # SQLite + pure-SQL CRR + offline caches
│   │   ├── KeychainService.swift    # paired device secret storage
│   │   ├── LiveActivityCoordinator.swift # workspace Live Activity lifecycle +
│   │   │                                  # push-token collection
│   │   └── SyncService.swift        # WebSocket client, command routing,
│   │                                # PIN pairing, lane presence, terminal
│   │                                # input/resize, chat push, push-token
│   │                                # registration, worktree discovery
│   ├── Shared/
│   │   ├── ADESharedContainer.swift # App Group UserDefaults + WorkspaceSnapshot helpers
│   │   ├── ADESharedModels.swift    # AgentSnapshot, PrSnapshot — shared with widgets
│   │   ├── ADESharedTheme.swift     # Provider color/icon table mirrored from desktop
│   │   ├── LiveActivityIntentsForward.swift # ADEIntentCommandKind, ADEIntentCommandRegistry
│   │   └── WidgetAppIntents.swift   # OpenADEIntent, ToggleMutePushIntent (iOS 18+)
│   ├── Views/
│   │   ├── Components/              # ADEDesignSystem (incl. ADEConnectionDot),
│   │   │                            # haptics, shimmer, mobile primitives
│   │   ├── Cto/                     # CtoRootScreen, CtoSessionDestinationView
│   │   ├── Lanes/                   # LaneDetailScreen, LaneActionsCard,
│   │   │                            # LaneBatchManageSheet, LaneManageSheet,
│   │   │                            # LaneMultiAttachSheet, LaneStackCanvasScreen,
│   │   │                            # LaneEnvInitProgressView, etc.
│   │   ├── Files/                   # FilesRootScreen, FilesDirectoryScreen,
│   │   │                            # FilesDetailScreen, *+Actions helpers
│   │   ├── Work/                    # WorkRootScreen, WorkChatSessionView,
│   │   │                            # Work*Helpers, WorkNewChat*,
│   │   │                            # WorkSessionDestination*,
│   │   │                            # WorkRootScreen+Selection (multi-select state +
│   │   │                            #   bulk close/archive/restore/delete/export),
│   │   │                            # WorkSelectionActionBar, etc.
│   │   ├── PRs/                     # PrsRootScreen, PrDetailScreen and
│   │   │                            # per-tab views, PrWorkflowCards,
│   │   │                            # PrStackSheet, CreatePrWizardView
│   │   ├── Settings/                # ConnectionSettingsView, NotificationsCenterView,
│   │   │                            # QuietHoursEditorView, PerSessionOverrideView,
│   │   │                            # SettingsPairingSection, SettingsConnectionHeader,
│   │   │                            # SettingsPinSheet, SettingsNotificationsSection
│   │   └── LanesTabView.swift
│   └── Assets.xcassets/             # App icon, brand mark, provider logos
│                                    # (Anthropic, Claude, Codex, Cursor,
│                                    # OpenAI, OpenCode)
├── ADENotificationService/
│   └── NotificationService.swift    # UNNotificationServiceExtension: brand-prefix
│                                    # title, set threadIdentifier, raise interruption level
├── ADEWidgets/
│   ├── ADEWidgetBundle.swift        # WidgetBundle registering all three widget surfaces
│   ├── ADELiveActivity.swift        # ADESessionAttributes (ActivityKit), ADELiveActivity widget
│   ├── ADELiveActivityViews.swift   # Lock Screen / banner + Dynamic Island view hierarchy
│   ├── ADEWorkspaceWidget.swift     # Home Screen widget (small/medium/large)
│   ├── ADEWorkspaceWidgetViews.swift# Widget entry views
│   ├── ADELockScreenWidget.swift    # Lock Screen accessory widget
│   ├── ADEControlWidget.swift       # Control Center widgets (iOS 18+): Open ADE + Mute
│   └── ADEWidgetPreviewData.swift   # Xcode preview fixtures
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
3. Send local `db_version`; `hello_ok` includes the host's current
   project catalog when the host supports project switching.
4. If no active project is selected, show the native project home
   instead of hydrating lane/file/PR surfaces against the wrong row.
5. After the active project row exists locally, receive catchup
   changesets and hydrate lane, file, Work, and PR projections scoped
   to that project.
6. Enter continuous bidirectional sync.
7. On disconnect: automatic reconnection with exponential backoff.
8. After pairing completes, the phone announces currently-open lanes
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
| `project_catalog_request` / `project_catalog` | Phone → host / host → phone | Refresh recent/available desktop projects |
| `project_switch_request` / `project_switch_result` | Phone → host / host → phone | Prepare a sync connection for a selected desktop project |
| `changeset_batch` | Bidirectional | cr-sqlite changeset batch |
| `command` | Phone → host | Execution request |
| `command_ack` | Host → phone | Command receipt |
| `command_result` | Host → phone | Execution result or error |
| `file_request` / `file_response` | Bidirectional | On-demand file access |
| `terminal_subscribe` / `terminal_data` | Phone → host / host → phone | Terminal streaming |
| `terminal_input` / `terminal_resize` | Phone → host | Raw input bytes and viewport size changes for a subscribed live PTY |
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

### Push Notifications (APNs)

ADE delivers push notifications from the desktop host to the iOS app
over Apple Push Notification service. The full stack is implemented:

**Desktop host side** (`apps/desktop/src/main/services/notifications/`):

- `apnsService.ts` — HTTP/2 APNs client using `node:http2` + JWT
  signed with `node:crypto` (ES256). No native binary dependency.
  The `.p8` private key is encrypted at rest via Electron
  `safeStorage.encryptString` and stored at
  `<userData>/apns.key.enc`; decrypted in-memory only during signing.
  Key configured via `ApnsConfigureOptions` (keyP8Pem, keyId, teamId,
  bundleId, env). JWTs are refreshed every 50 minutes to stay within
  Apple's 60-minute limit. `ApnsKeyStore` manages encrypted
  persistence; `signApnsJwt` is the pure signing function.
  `APNS_INVALID_TOKEN_REASONS` lists token-dead reasons
  (`BadDeviceToken`, `Unregistered`, `DeviceTokenNotForTopic`).
  `Http2ApnsTransport` is the default transport; tests inject a mock
  via the `ApnsTransport` interface seam.

- `notificationMapper.ts` — side-effect-free mapping from ADE domain
  events to `MappedNotification` values. Thirteen `NotificationCategory`
  values across four families:

  | Category | Family | Push type | Priority |
  |---|---|---|---|
  | `CHAT_AWAITING_INPUT` | chat | alert | 10 (time-sensitive) |
  | `CHAT_FAILED` | chat | alert | 10 |
  | `CHAT_COMPLETED` | chat | alert | 5 |
  | `CTO_SUBAGENT_STARTED` | cto | alert | 5 |
  | `CTO_SUBAGENT_FINISHED` | cto | alert | 5 |
  | `CTO_MISSION_PHASE` | cto | alert | 5 |
  | `PR_CI_FAILING` | pr | alert | 10 |
  | `PR_REVIEW_REQUESTED` | pr | alert | 10 |
  | `PR_CHANGES_REQUESTED` | pr | alert | 10 |
  | `PR_MERGE_READY` | pr | alert | 5 |
  | `SYSTEM_PROVIDER_OUTAGE` | system | alert | 10 |
  | `SYSTEM_AUTH_RATE_LIMIT` | system | alert | 10 |
  | `SYSTEM_HOOK_FAILURE` | system | alert | 5 |

  Each notification carries a `deepLink` (`ade://session/<id>` or
  `ade://pr/<n>`), a `collapseId` for de-duplication, and a
  `metadata` bag that lets the iOS side set `threadIdentifier`.

- `notificationEventBus.ts` — routes domain events to APNs and/or
  in-app WebSocket delivery. Call surface: `publishChatEvent`,
  `publishPrEvent`, `publishMissionEvent`, `publishSystemEvent`,
  `sendTestPush`. The bus asks `listPushTargets()` and
  `getPrefsForDevice()` at send time so preference toggles take effect
  immediately. If the device is currently connected over WebSocket,
  the bus also delivers an in-app notification via
  `sendInAppNotification` even when APNs is disabled. `apns-expiration`
  is set to `+1h` for priority-10 pushes and `+10m` for priority-5
  pushes; stale banners are not queued after the window.
  Also sends Live Activity `liveactivity` pushes to per-activity
  update tokens when the notification maps to an attention value (chat
  awaiting input / failed, PR CI failing / review requested / merge
  ready).

**iOS client side**:

- `AppDelegate.swift` — owns APNs registration
  (`registerForRemoteNotifications`), notification-category setup
  (`NotificationCategories.register()`), and response routing:
  `Approve`/`Deny`/`Reply` actions forward to
  `SyncService.sendRemoteCommand(approveSession/denySession/replyToSession)`;
  `Restart` calls `restartSession`; `RetryChecks` calls
  `retryPrChecks`; tapping the banner body dispatches to
  `DeepLinkRouter`.
  Requests `.alert`, `.badge`, `.sound`, `.providesAppNotificationSettings`,
  and `.timeSensitive` (iOS 15+) at first launch.
  Token registration calls
  `SyncService.shared?.registerPushToken(hex, kind: .alert, ...)` which
  transmits the token to the desktop host via the sync command surface.

- `NotificationCategories.swift` — declares ten
  `UNNotificationCategory` / `UNNotificationAction` values matching
  the desktop `NotificationCategory` identifiers 1:1.
  `CHAT_AWAITING_INPUT` gets Approve + Deny + Reply (text input);
  `CHAT_FAILED` gets Open agent + Restart; `PR_CI_FAILING` gets
  Open PR + Retry checks; `PR_MERGE_READY` gets View PR; CTO
  and system categories get generic Open / Open mission actions.

- `ADENotificationService/NotificationService.swift` — Notification
  Service Extension that decorates inbound APNs payloads before
  display: prefixes the title with the provider brand slug (e.g.
  `Claude · Awaiting approval`), sets `threadIdentifier` from
  `sessionId` or `prNumber` so the OS groups banners per session/PR,
  and raises `interruptionLevel` / `relevanceScore` based on category.

- `DeepLinkRouter.swift` — `ade://` URL handler and notification-
  payload dispatcher. Parses `ade://session/<id>` and
  `ade://pr/<n>` URLs, plus notification `userInfo` bags carrying
  `sessionId`, `prId`, or `prNumber`, and posts
  `.adeDeepLinkRequested` to `NotificationCenter` so individual tab
  views can flip their selection. PR deep links specifically resolve
  to a stable `prId`: when the inbound identifier is the GitHub PR
  number (from a widget / Live Activity URL or a legacy `prNumber`
  payload), `resolvePrId` looks it up against the App Group
  `WorkspaceSnapshot` and stashes the matching id on
  `SyncService.requestedPrNavigation` (a `PrNavigationRequest`) so
  `PrsRootScreen` opens the same row the desktop would. When the
  payload already carries a `prId`, that is used verbatim.

**Notification preferences** (`apps/ios/ADE/Models/NotificationPreferences.swift`):

- `NotificationPreferences` — 13 per-category toggles (chat 3,
  CTO 3, PR 4, system 3), a quiet-hours window (start/end time-of-day
  `Date`), and `perSessionOverrides` keyed by `sessionId`
  (`muted`, `awaitingInputOnly`). Persisted as JSON in the App Group
  `UserDefaults` at key `ade.notifications.prefs`.
- Synced to the desktop host so the host can gate APNs sends by
  device preferences without requiring an extra round-trip.
- `NotificationsCenterView.swift` — unified notifications settings
  screen with category toggles, quiet-hours picker
  (`QuietHoursEditorView`), per-session overrides
  (`PerSessionOverrideView`), authorization status banner, and "Send
  test push" action.

### Live Activities

Source: `apps/ios/ADE/Services/LiveActivityCoordinator.swift`,
`apps/ios/ADEWidgets/ADELiveActivity.swift`.

A single workspace Live Activity (`ADESessionAttributes`) shows the
current agent roster + the single most important pending action on the
Lock Screen and in the Dynamic Island. Apple enforces one active
activity per app at a time; the coordinator ends stale per-session
activities from older builds on launch.

`ADESessionAttributes.ContentState` carries:
- `sessions: [ActiveSession]` — sorted by awaiting-input → failed →
  newest running.
- `attention: Attention?` — one of `awaitingInput`, `failed`,
  `ciFailing`, `reviewRequested`, `mergeReady`. Nil when nothing
  requires immediate action.
- `failingCheckCount`, `awaitingReviewCount`, `mergeReadyCount` — PR
  aggregate counts.

`LiveActivityCoordinator` exposes a single `reconcile(with:prs:)`
call wired from `SyncService`. Push-to-start (iOS 17.2+) and
per-activity update tokens are collected via `pushTokenUpdates` and
forwarded to the host through `LiveActivityHost.sendPushToken`.
The host sends `liveactivity` APNs pushes to the update tokens via
`notificationEventBus` whenever an attention-eligible event fires.

The `ADELiveActivity` widget registers the `ActivityConfiguration`
for the lock-screen / banner presentation and the Dynamic Island
expanded/leading/trailing/minimal regions.

### Widgets

Source: `apps/ios/ADEWidgets/`.

Three widget / control surfaces are registered by `ADEWidgetBundle`:

- `ADEWorkspaceWidget` (Home Screen) — `systemSmall`, `systemMedium`,
  `systemLarge`. Reads `WorkspaceSnapshot` from the App Group
  (`ADESharedContainer.readWorkspaceSnapshot()`). Shows running
  agents and PR attention counts. Main app triggers
  `WidgetCenter.shared.reloadAllTimelines()` after each snapshot write.

- `ADELockScreenWidget` — accessory rectangular/circular sizes
  for the iOS Lock Screen; reads from the same shared snapshot.

- `ADEControlWidget` (iOS 18+) — Control Center "Open ADE" button
  and "Mute ADE" toggle. The mute toggle persists a window via
  `ADEMutePreferences.setMute(until:)` and forwards the ISO timestamp
  to the desktop host via the intent command bridge
  (`ADEIntentCommandRegistry` / `ADESyncIntentBridge`).

Shared DTOs live in `apps/ios/ADE/Shared/ADESharedModels.swift`:
`AgentSnapshot` and `PrSnapshot` — lightweight Codable structs
readable by the widget extension and the notification service
extension without importing the main app's heavier renderer code.

### Haptic Feedback

- `UIImpactFeedbackGenerator` and `UINotificationFeedbackGenerator`
  on message send, intervention approval, mission launch, PR merge.

## Tab structure

Before the tabs render, `ProjectHomeView` can take over the root screen
when no active project is selected or the user taps the Projects toolbar
button. It merges the host-provided catalog with projects already present
in the local replicated DB, marks cached/unavailable rows, and requests a
fresh bootstrap connection for the selected desktop project through
`project_switch_request`.

### Shipped

| Tab | Icon | Desktop equivalent | Capabilities |
|---|---|---|---|
| **Lanes** | `square.stack.3d.up` | `/lanes` | Full lane surface: search/filter chips, open/create/attach/manage, multi-attach for unregistered worktrees, stack canvas, git/diff/rebase/conflicts, template-backed environment setup progress, lane-scoped sessions and AI chats. `devicesOpen` presence chips show which other devices currently have the lane open. |
| **Files** | `doc.text` | `/files` | Lane-backed workspace picker, live file tree/search/read, protected-workspace read-only parity. `mobileReadOnly` on the workspace payload gates mutating file actions on the phone via `ensureMobileFileMutationsAllowed`; quick-open and text-search result lists cap visible rows at 40 and ask the user to refine when more matches exist. |
| **Work** | `terminal` | `/work` | Terminal + chat session list, cached history with persisted lane names, output streaming, typed terminal input and Ctrl-C forwarding for subscribed live PTYs, quick-launch actions, session pinning, live chat-event push from the host (no polling lag once subscribed). |
| **PRs** | `arrow.triangle.pull` | `/prs` | PR list/detail driven by `prs.getMobileSnapshot`: stack visibility (`PrStackSheet`), create-PR wizard (`CreatePrWizardView`) gated by per-lane eligibility, workflow cards (queue / integration / rebase) rendered from `PrWorkflowCard`, per-PR action capabilities. |
| **CTO** | `sparkles` | `/cto` | CTO snapshot: Chat / Team / Workflows segments, with the mobile workflows screen mirroring the desktop workflow policy/dashboard and preserving the shared glass navigation chrome. Drills into per-worker chat sessions via `CtoSessionDestinationView`. |
| **Settings** | `gearshape` | `/settings` (sync subset) | PIN pairing (`SettingsPinSheet`), notification preferences (`NotificationsCenterView`), quiet hours, per-session overrides, appearance, diagnostics, connection header with QR payload and address candidates, reconnect, forget. |

### Planned

- Missions, Automations, Graph, History tabs.
- Full Settings parity with the desktop.
- iPad adaptive layout, Spotlight.

## Lane data projection

All lane, file, Work, and PR projections are scoped through
`Database.currentProjectId()`. The iOS app stores the active project id
in `UserDefaults`, mirrors it into `DatabaseService`, and falls back to
the project home if no selected project row has arrived yet. Project
switches reset the remote DB version. The desktop runs at most one sync
host at a time — pinned to the active project — so when the phone asks
the desktop to switch projects, the desktop activates the requested
project locally, returns `connection: null`, and the phone reuses its
existing pairing credentials to reconnect against the now-active host.
If the desktop is offline at switch time, it still records the requested
project as active and the phone reconnects when the desktop returns.

Rather than reconstructing lane detail surfaces client-side from
primitive rows, the iOS app persists richer projections the host
sends:

- Lane list snapshots (`LaneListSnapshot`) with runtime bucket
  summaries (running / awaiting-input / ended / session count).
- Cached lane-detail payloads (`LaneDetailPayload`) keyed by lane id
  so the Lanes tab can render the desktop stack / git / diff / manage
  / work surfaces without client-side reconstruction.
- Unregistered-worktree candidates (`UnregisteredLaneCandidate`) returned
  by `lanes.listUnregisteredWorktrees`; `LaneMultiAttachSheet` can attach
  selected rows and optionally move them under ADE management.
- Environment-init progress (`LaneEnvInitProgress`) returned by
  `lanes.initEnv`, `lanes.templates.apply`, and `lanes.getEnvStatus`;
  `LaneCreateSheet` switches from the form to a progress panel when a
  template-backed create starts host-side setup.
- `LaneSummary.devicesOpen` lists the devices currently on a lane,
  decorated by the host from `lanes.presence.announce` events.

The host produces these via `lanes.refreshSnapshots` and
`lanes.getDetail` remote commands. The phone calls the command, stores
the result, and reads from the local store afterward so reconnects and
offline usage remain fast.

## PR data projection

The iOS PR wizard (`CreatePrWizardView`) supports three create modes —
`single`, `queue`, and `integration` — with a shared stepper (Mode →
Source → Details → Review) and per-mode submit handlers routed through
the sync command surface:

- single → `prs.createFromLane` (via `onCreateSingle` callback)
- queue → `prs.createQueue` and `prs.startQueueAutomation`, returning
  `CreateQueuePrsResult`
- integration → `prs.simulateIntegration` followed by
  `prs.commitIntegration`, returning `CreateIntegrationPrResult`

`SyncService.swift` exposes these through typed wrappers
(`createQueuePrs`, `startQueueAutomation`, `simulateIntegration`,
`commitIntegration`, `listIntegrationWorkflows`, `landStackEnhanced`)
along with `getPipelineSettings` / `savePipelineSettings` /
`deletePipelineSettings` so the iOS PR detail can read and mutate the
same convergence pipeline the desktop detail pane uses.
`RemoteModels.swift` now also carries `CreateQueuePrError`,
`CreateQueuePrsResult`, `IntegrationMergeResult`,
`CreateIntegrationPrResult`, `CleanupIntegrationWorkflowResult`, and
`LandResult` to match the desktop return shapes.

`PrRebaseScreen` now mirrors the full desktop RebaseTab detail pane:
drift analysis stat grid, collapsible target-commits list, and the
full action set (AI resolver / local-only rebase / push / defer /
dismiss) routed through the existing sync commands. The phone and
desktop rebase flows stay in parity so the same lane behaves the same
on either device.

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
| Project home + desktop project switching | Implemented |
| Lanes tab | Implemented to live desktop parity (with `devicesOpen`, multi-attach, stack canvas, and template environment progress) |
| Files tab | Implemented with `mobileReadOnly` workspace gate and capped search/quick-open result rendering |
| Work tab | Implemented; live chat-event push from host plus subscribed terminal input/resize control |
| PRs tab | Implemented; driven by `prs.getMobileSnapshot` |
| Settings tab (pairing / appearance / diagnostics) | Implemented |
| Missions tab | Planned |
| CTO / Automations / Graph / History tabs | Planned |
| Full Settings parity | Planned |
| Push notifications (APNs) | Implemented (categories, actions, Notification Service Extension, per-device preferences) |
| Widgets (Home Screen / Lock Screen / Control) | Implemented |
| Live Activities (workspace roster + attention) | Implemented |
| iPad adaptive layout | Planned |
| Spotlight indexing | Planned |

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
- **Project selection gates hydration.** A phone paired to a host can
  know about multiple desktop projects, but lane/file/Work/PR reads must
  stay scoped to the active project id. If a switch fails, roll back the
  active project id, host profile, token, and remote DB version together.
- **Keychain items survive app uninstall on some iOS builds.**
  Pairing forget should both clear Keychain and clear the draft row;
  the Settings tab's "Forget host" does both.
- **The ADE iOS bootstrap SQL is generated.** When desktop `kvDb.ts`
  schema changes, regenerate `DatabaseBootstrap.sql`. Schema drift
  between desktop and iOS breaks the first-launch bootstrap, and
  `changeset_batch` apply will fail for tables that don't exist
  locally.
- **Integration proposal schema must move with PR workflow fields.**
  Desktop merge-into-lane proposals store
  `preferred_integration_lane_id` and `merge_into_head_sha` on
  `integration_proposals`; iOS mirrors them in `DatabaseBootstrap.sql`,
  `DatabaseService.fetchIntegrationProposals()`, and
  `RemoteModels.IntegrationProposal`. Missing any leg makes synced PR
  workflow cards lose their adopted-lane/drift state.
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
- **Chat subscribe requests a 2 MB snapshot window.** The phone sends
  `chat_subscribe` with `maxBytes: 2_000_000`
  (`syncChatSubscriptionMaxBytes`) so the initial snapshot can carry
  long transcripts without the host truncating prematurely. When the
  host still responds with `truncated: true`, the phone calls
  `mergeChatEventHistory` instead of `replaceChatEventHistory`: the
  existing cached events are unioned with the truncated snapshot,
  deduplicated by `id`, and re-sorted by `(timestamp, sequence)`.
  Non-truncated snapshots take the replace path. Both paths run through
  `deduplicatedChatEventHistory` and then through `trimChatEventHistory`,
  which caps retained events at `chatEventHistoryMaxEvents = 1_000`
  (up from the previous 500-event cap) so very long chats don't evict
  their own recent turns on reconnect.
- **Work transcript parser uses `messageId` as a fallback item id.**
  `makeWorkChatEvent` (`WorkEventMapping.swift`) and
  `parseWorkChatTranscript` (`WorkTranscriptParser.swift`) now fall back
  to the `messageId` from `chat_event` when no `itemId` is present, so
  streaming assistant-text fragments merge into the same transcript row
  even when the host only surfaces a `messageId`. `buildWorkChatMessages`
  (`WorkErrorAndMessageHelpers.swift`) tracks a
  `previousEnvelopeWasAssistantText` flag and allows merging into the
  previous assistant bubble when either (a) the text event has an
  `itemId` or (b) the immediately preceding envelope was also assistant
  text. This keeps the iOS Work chat from fanning a single assistant
  turn into many tiny rows.
- **Lane presence is best-effort with a TTL.** The phone
  re-announces on a 30 s cadence; the host prunes stale entries at
  60 s. A phone that crashes without sending `lanes.presence.release`
  will disappear from `devicesOpen` one cycle later, not instantly.
- **`mobileReadOnly` is an additional gate on top of
  `isReadOnlyByDefault`.** The iOS app checks both before allowing a
  `files.*` mutating command. A workspace that is desktop-writable
  may still be read-only from the phone to avoid accidental edits
  on a lossy network.
