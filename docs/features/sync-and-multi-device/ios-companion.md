# iOS Companion

The ADE iOS app is a native SwiftUI companion that acts as a
**controller** for an ADE runtime (`ade serve`). The runtime may be running
on a Mac that also has the desktop app open or on a headless machine —
the phone does not care, and the desktop renderer is just another
client of the same runtime. The phone never runs agents; it reads synced
state from a local SQLite DB and sends execution commands to the runtime
over WebSocket.

This doc summarises the architecture at a level useful for understanding
the sync surface. For the full roadmap, see Phase 6 and Phase 7 plans in
the repo's `docs/final-plan/`.

## Connect Your Phone

ADE Mobile connects to a **machine**, not to a desktop window. The
machine is shown by its computer name, with LAN and Tailscale routes
kept as connection details behind the row.

1. On the computer, open ADE Settings > Sync > Pair a phone, or run
   `ade sync pin generate` from the CLI.
2. On the phone, open Settings > Pairing and either scan the pairing QR
   shown in ADE on the computer (a smart URL carrying machine identity,
   port, and address candidates), choose the machine from Nearby
   machines, or enter a machine address and port manually when discovery
   is unavailable.
3. Enter the 6-digit PIN. The phone receives a durable per-device
   secret and stores it in Keychain, so future reconnects do not ask
   for the PIN again.
4. Pick a project from the machine catalog. The machine keeps one sync
   listener on a stable port; switching projects swaps which project
   host owns the connection, and the user-facing model stays
   machine -> projects.

The same machine token works across LAN and Tailscale routes and across
that machine's projects. `siteId` remains an internal per-project
database/runtime detail and must not be used as the visible identity of
a saved machine.

## Host version compatibility

ADE Mobile treats the machine connection as the recovery path for updates, so a
new mobile app must still connect to older brains. The phone reads
`features.mobileCompatibility` from `hello_ok` when a host advertises it:
`full` means every required mobile command is present, while `limited` means the
phone remains connected but gates missing host actions locally. Older brains
omit the feature entirely; iOS interprets that as a legacy limited connection,
not as a handshake failure.

Unsupported actions fail before they are queued or sent with a user-facing
"update ADE on the machine" message. This keeps an auto-updated phone usable for
the one action users need most: seeing that the host is behind and triggering a
host update path that the older brain still supports.

The Settings machine card mirrors this state through
`SettingsConnectionHeader`: connected limited hosts show a compact "Machine
update recommended" warning while staying connected, so users can still browse
available state and recover the host.

## Project layout

> The same Xcode project also ships `apps/ios/ADE/Debug/ADEInspectorKit/`,
> a DEBUG-only SwiftUI inspector that publishes per-frame element
> metadata (component id, source file/line, accessibility identifier,
> point/pixel frames) to the running app's data container so the
> desktop iOS Simulator drawer can convert taps into source-anchored
> chat context. See [`features/ios-simulator/inspector.md`](../ios-simulator/inspector.md).

```
apps/ios/
├── ADE.xcodeproj/
├── ADE/
│   ├── App/
│   │   ├── ADEApp.swift             # SwiftUI app entry
│   │   ├── ADEAppDelegate.swift     # UIApplicationDelegate: APNs device-token
│   │   │                            # callbacks + notification presentation,
│   │   │                            # feeds PushNotificationService
│   │   ├── ContentView.swift        # 5-tab TabView with a custom
│   │   │                            # `ADERootBottomTabBar` overlay
│   │   │                            # (Work/Lanes/PRs/Files/CTO + Work
│   │   │                            # running-chat badge); the system tab
│   │   │                            # strip is hidden and individual screens
│   │   │                            # can hide the custom bar via
│   │   │                            # `adeRootTabBarHidden()`. When no active
│   │   │                            # project is selected the root shows the
│   │   │                            # Hub (HubScreen, all-projects roster home)
│   │   │                            # instead of the tabs; the Hub includes Add
│   │   │                            # project when the runtime advertises
│   │   │                            # projectActions
│   │   ├── RemoteProjectAddSheet.swift # Open/create/clone project flow
│   │   │                               # backed by runtime-scoped
│   │   │                               # project action envelopes
│   │   ├── DeepLinkRouter.swift     # ade:// and https://ade-app.dev/open
│   │   │                            # handler. Session and compact PR links
│   │   │                            # flip tabs via .adeDeepLinkRequested;
│   │   │                            # session event/offset anchors ride
│   │   │                            # WorkSessionNavigationRequest.
│   │   │                            # Linear issue links route in-app when a
│   │   │                            # project is open; lane/file/commit/artifact/
│   │   │                            # repo-branch, full PR, and projectless
│   │   │                            # Linear issue links post
│   │   │                            # .adeSendToMacRequested so SendToMacCard can
│   │   │                            # bounce the URL to a paired host via the
│   │   │                            # deeplinks.open sync command.
│   ├── Models/
│   │   └── RemoteModels.swift       # Codable structs mirroring shared types
│   ├── Resources/
│   │   ├── DatabaseBootstrap.sql    # generated from desktop kvDb.ts
│   │   └── VoiceGlossary.json       # shared dictation cleanup glossary
│   ├── Services/
│   │   ├── Database.swift           # SQLite + pure-SQL CRR + offline caches
│   │   ├── KeychainService.swift    # paired device secret storage
│   │   ├── DpopKeyService.swift     # Secure Enclave P-256 key + signed
│   │   │                            # DPoP proof for every paired hello
│   │   ├── PairingQrPayload.swift   # smart-URL QR parser (port of
│   │   │                            # shared/pairingQr.ts)
│   │   ├── PushNotificationService.swift # APNs registration, alert/deep-link
│   │   │                                 # handling, prefs, push.getStatus
│   │   ├── LiveActivityService.swift # ActivityKit start/update/end for the
│   │   │                             # aggregate "agent runs" activity
│   │   ├── Dictation/               # SpeechDictationService,
│   │   │                            # DictationController, deterministic
│   │   │                            # cleanup, VoiceGlossary loader
│   │   └── SyncService.swift        # WebSocket client, command routing,
│   │                                # PIN pairing, scoped projection
│   │                                # revisions, lane presence, terminal
│   │                                # subscribe/unsubscribe + input/resize,
│   │                                # CLI launcher (startCliSession), chat push,
│   │                                # machine project browse/open/create/clone,
│   │                                # lane reparent stack-base override payloads,
│   │                                # Linear read/launch RPC wrappers, worktree
│   │                                # discovery
│   ├── Shared/
│   │   ├── ADESharedContainer.swift # App Group UserDefaults + WorkspaceSnapshot helpers
│   │   ├── ADESharedModels.swift    # AgentSnapshot, PrSnapshot — shared with widgets
│   │   ├── ADESharedTheme.swift     # Provider color/icon table mirrored from desktop
│   │   ├── ADEAgentActivityAttributes.swift # ActivityKit attributes +
│   │   │                            # ContentState (shared app ↔ widget)
│   │   └── AttentionActionIntents.swift # widget actions for approve/deny/restart/retry
│   ├── Views/
│   │   ├── Components/              # ADEDesignSystem (incl. ADEConnectionDot,
│   │   │                            # ADEUIKitAppearance.configureTabBar(),
│   │   │                            # ADERootTabBarHiddenPreferenceKey),
│   │   │                            # haptics, ADEMobilePrimitives (incl.
│   │   │                            # ADEOptionButton for selection rows),
│   │   │                            # dictation mic, recording pill, global
│   │   │                            # dictation pill
│   │   │                            # — `ADEStreamingShimmer.swift` was retired
│   │   ├── Cto/                     # CtoRootScreen, CtoSessionDestinationView
│   │   ├── Hub/                     # HubScreen (all-projects roster home),
│   │   │                            # HubComponents (project/lane/chat cards,
│   │   │                            #   HubNoMachineState), HubComposerDrawer
│   │   │                            #   (HubInlineComposer — inline keyboard
│   │   │                            #   composer, not a modal drawer),
│   │   │                            # HubScreen+ChatNavigation (chat open +
│   │   │                            #   cross-project quick look)
│   │   ├── Lanes/                   # LaneDetailScreen, LaneActionsCard,
│   │   │                            # LaneDetailSectionChrome (collapsible
│   │   │                            #   sections + wrapping chip-flow layout),
│   │   │                            # LaneDetailGitActionsPane (commit /
│   │   │                            #   stage / stash / history / escape
│   │   │                            #   hatches, desktop pane parity),
│   │   │                            # LaneBatchManageSheet, LaneManageSheet
│   │   │                            #   (tabbed manage dialog + adopt-attached),
│   │   │                            # LaneMultiAttachSheet, LaneStackGraphSheet,
│   │   │                            # LaneDeeplinkHelpers (envelope-aware
│   │   │                            #   https/ade lane/session/branch/PR
│   │   │                            #   link minting),
│   │   │                            # LaneEnvInitProgressView, etc.
│   │   ├── Files/                   # FilesRootScreen, FilesDirectoryScreen,
│   │   │                            # FilesDetailScreen, *+Actions helpers,
│   │   │                            # FilesSearchScreen (full-screen unified
│   │   │                            #   name+content search; replaced the
│   │   │                            #   inline FilesQueryCard search cards),
│   │   │                            # FilesWorkspacePickerDropdown
│   │   ├── Work/                    # WorkRootScreen, WorkChatSessionView,
│   │   │                            # Work*Helpers, WorkNewChatScreen (chat/CLI
│   │   │                            #   launcher + per-project interface
│   │   │                            #   preference shared with Hub),
│   │   │                            # WorkLanePickerDropdown,
│   │   │                            # WorkChatRichCardViews (de-glassed
│   │   │                            #   tool-call / work-log / command /
│   │   │                            #   file-change transcript cards plus
│   │   │                            #   Chat Info schedule popup/sheet for
│   │   │                            #   scheduled_work_update snapshots),
│   │   │                            # WorkPlanComposerViews (plan-approval
│   │   │                            #   strip + review sheet),
│   │   │                            # WorkComposerTypedTriggers (UITextView
│   │   │                            #   composer + cursor-relative /command
│   │   │                            #   & @file detection, inline suggestion
│   │   │                            #   strip, chip pills; replaced the
│   │   │                            #   WorkMentionsPickerSheet /
│   │   │                            #   WorkSlashCommandsSheet modals),
│   │   │                            # WorkChatAttachmentTray,
│   │   │                            # WorkArtifactTerminalViews,
│   │   │                            # TerminalSessionScreen + SwiftTermSessionView
│   │   │                            #   (full-screen SwiftTerm terminal,
│   │   │                            #   offset resume/history paging +
│   │   │                            #   viewport reporter),
│   │   │                            # WorkSessionDestination*,
│   │   │                            # WorkRootScreen+Selection (multi-select state +
│   │   │                            #   bulk close/archive/restore/delete/export),
│   │   │                            # WorkSelectionActionBar, etc.
│   │   ├── Linear/                  # LinearPaneSheet, issue list/detail screens,
│   │   │                            # launch config, brand/logo paths, pane store
│   │   │                            # and toolbar button. Uses existing cto.* read
│   │   │                            # RPCs plus lane/chat/CLI launch primitives.
│   │   ├── PRs/                     # PrsRootScreen, PrDetailScreen
│   │   │                            #   (PrDetailView — Overview emitted as
│   │   │                            #   sibling List rows, not a monolith),
│   │   │                            # PrDetailActivityTab (timeline builder +
│   │   │                            #   commit-group folding), PrDetailOverviewTab,
│   │   │                            # PrMergeGateCard (PrGlassPalette tokens),
│   │   │                            # PrHelpers, PrListRowModifier,
│   │   │                            # PrWorkflowCards, PrStackSheet,
│   │   │                            # CreatePrWizardView, PrRebaseScreen,
│   │   │                            # PrTargetBranchPickerDropdown,
│   │   │                            # PrDetailOverviewPreviews (preview fixtures)
│   │   ├── Settings/                # ConnectionSettingsView, SettingsPairingSection,
│   │   │                            # SettingsPairingScannerSheet (camera QR
│   │   │                            #   scanner), SettingsWebClientPairSheet
│   │   │                            #   (pair a browser: QR + link + PIN via
│   │   │                            #   sync.getWebPairingInfo),
│   │   │                            # SettingsConnectionHeader,
│   │   │                            #   host compatibility warning banner,
│   │   │                            # SettingsPinSheet, SettingsPushDeliverySection
│   │   │                            #   (push + Live Activity diagnostics/toggles),
│   │   │                            # SettingsVoiceInputSection
│   │   └── LanesTabView.swift
│   └── Assets.xcassets/             # App icon, brand mark, provider logos
│                                    # (Anthropic, Claude, Codex, Cursor,
│                                    # Droid, OpenAI, OpenCode)
├── ADEWidgets/
│   ├── ADEWidgetBundle.swift        # WidgetBundle registering the lock-screen
│   │                                # widget AND the "agent runs" Live Activity
│   ├── ADELockScreenWidget.swift    # Lock Screen accessory widget + previews
│   └── ADEAgentActivityWidget.swift # ActivityKit Live Activity + Dynamic Island
│                                    # presentation for active agent runs
└── ADETests/
    ├── ADETests.swift
    └── PairingAndDpopTests.swift    # smart-URL QR parse + DPoP proof tests
```

Each tab is factored into a root screen, one `+Actions` extension for
side-effecting work, and several helper modules (timeline, markdown
parsing, model catalog, session grouping) to keep individual files
under a few hundred lines. This split is the primary reason the Work
tab grew from one ~3,000-line file to ~30 focused files.

Deployment target: iOS 26+. iPhone and iPad (adaptive layouts planned for
Phase 7).

### Connection status UI

Machine connection status is surfaced through a single shared component,
`ADEConnectionDot` (in `Views/Components/ADEDesignSystem.swift`). It
renders a colored dot, a state label, and the truncated machine name when
connected, and acts as a 44pt button that opens Settings.

All visible connection affordances read from `SyncConnectionHealth`
(produced by the pure helper `syncConnectionHealth(connectionState:
prefersReducedSyncLoad: lastError:)` and re-exposed through
`SyncService.connectionHealth`) instead of branching on the raw
`RemoteConnectionState`. The health value separates three concerns
that used to be tangled together:

- `transport: SyncTransportHealth` — `disconnected` / `connecting` /
  `connected` / `unreachable`. `RemoteConnectionState.syncing` collapses
  into `connected` because the connection is alive while the runtime streams a
  catchup batch; only `RemoteConnectionState.error` maps to
  `unreachable`.
- `load: SyncLoadHealth` — `normal` / `strained`. `strained` is set
  when the transport is connected but `prefersReducedSyncLoad` is on,
  i.e. recent request timeouts have caused the phone to back off
  background work.
- `lastFailureMessage` — surfaced only when transport is `unreachable`,
  so a stale error from a previous connection does not bleed into the UI
  while the phone is happily disconnected or reconnecting.

Tint mapping (resolved by `SettingsConnectionPresentation.statusTint`,
`ADEConnectionDot`, `ADERootToolbarControls`, and `SettingsStatusDot`):

| Transport | Load | Color |
|---|---|---|
| `connected` | `normal` | success (green) / purple accent on the Settings dot |
| `connected` | `strained` | warning (amber) |
| `connecting` | (n/a) | warning (amber) |
| `unreachable` | (n/a) | danger (red) |
| `disconnected` | (n/a) | danger (red) on the toolbar dot, muted on the Settings dot |

The dot is placed in the top-leading `ToolbarItem` of every top-level
tab (Lanes, Files, Work, PRs) and every deep screen
(`LaneDetailScreen`, `PrDetailView`, `WorkSessionDestinationView`,
`WorkNewChatScreen`, `FilesDirectoryScreen`; `FilesDetailScreen`
hosts it alongside its back-button affordance). It replaces the
older `ADEConnectionPill` and the per-tab "connection notice" banner
cards — controllers no longer ship duplicate offline / reconnect /
hydrating cards inside each screen body.

The Hub is the exception: with the navigation bar hidden, its
no-machine / connection-error state renders `HubNoMachineState` instead
of project cards, using the same `SyncConnectionHealth` mapping as
`ADEConnectionDot` and routing taps through
`syncService.settingsPresented` to the same Settings sheet the dot
opens. Its status capsule distinguishes three states: "Cannot reach
\<machine\>" (`.error`, danger dot), "Disconnected from \<machine\>"
(`.disconnected` while a pairing credential is still saved —
`canReconnectToSavedHost`), and "No machine attached" (truly unpaired).
With a saved machine the primary action is **Reconnect** (calls
`reconnectIfPossible(userInitiated: true)`) with a secondary
"Connection settings" link; unpaired phones keep the single
"Connect Machine" button into Settings.

### Tailscale-off route hint

Connection surfaces show an "iPhone isn't on Tailscale" warning card
(`ADETailscaleOffHintCard` in `ADEDesignSystem.swift`) when the one
user action that can fix the connection is turning Tailscale on. The
card is not shown when the phone has a saved ADE relay route, because
relay is a valid automatic fallback and Tailscale is then only a
performance recommendation. Gating is the pure helper
`syncShouldShowTailscaleOffHint(...)`, exposed as
`SyncService.tailscaleOffHintVisible`; all of the following must hold:

- a pairing credential exists and the saved profile carries a Tailscale
  route (`profileHasTailnetRoute`),
- the phone holds **no** tailnet self-address — `syncHasTailnetSelfAddress`
  scans `getifaddrs` output for a Tailscale CGNAT IPv4 (100.64/10) or
  Tailscale IPv6 (fd7a:115c:a1e0::/48) address **on a `utun*` interface
  only** (cellular carriers assign CGNAT 100.64/10 to `pdp_ip*`, so an
  unscoped scan would false-positive on LTE),
- no live discovery hit matches the profile (Bonjour ⇒ same LAN; the
  tailnet probe only resolves when the tunnel is up),
- no saved full-URL relay candidate exists for the profile,
- transport is connecting / disconnected / unreachable — never while
  connected, so a working VPN-to-LAN setup is left alone.

The interface scan refreshes on `NWPathMonitor` path changes (VPN
tunnels flip the path), on foreground transitions, and before
`enterUnreachableTerminalState` surfaces its terminal error (whose
message appends the Tailscale explanation when the hint holds). The
card renders in `HubNoMachineState`, `HubConnectingCard`, and
`SettingsConnectionHeader` (via
`SettingsConnectionSnapshot.showTailscaleOffHint`); its action opens
the Tailscale app (`tailscale://`), falling back to the App Store page.

`SettingsConnectionHeader` distinguishes the four states explicitly:

- Connected, normal load → "Live · ready to sync".
- Connected, strained load → "Live · machine responding slowly".
- Connected with `connectionState == .syncing` → "Live · syncing
  changes".
- `connecting` → "Connecting to saved machine".
- `unreachable` → "Unable to reach your machine" plus the
  `lastFailureMessage` banner.
- `disconnected` → reconnect / pair-different-machine CTA depending on
  whether a saved Tailscale address candidate is present.

`SettingsConnectionPresentation.statusLabel` returns "Connected, slow"
when transport is connected and load is strained, and "Connected"
otherwise. The legacy "Syncing" label was removed — syncing is just
a connected transport doing work.

Accessibility: the dot's `accessibilityLabel` describes load strain
("Connected to <machine>. Machine is responding slowly"), explicit syncing
work ("Connected to <machine>. Syncing changes"), or plain "Connected to
<machine>" when neither applies; for transport `unreachable` it appends
the trimmed `lastFailureMessage`. `accessibilityHint` is "Opens
settings to pair or reconnect", and
`accessibilityShowsLargeContentViewer()` keeps it reachable from
VoiceOver and Large Content.

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
- Deep links jump to specific screens.

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
   `kvDb.ts`). Bootstrap SQL includes CRR-safe cleanup for replicated
   tables whose desktop schema dropped secondary UNIQUE indexes, such as
   deduping `lane_linear_issue_links` and dropping the legacy
   `uq_lane_linear_issue_links_role` index before triggers are installed.
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
The notification includes touched table names when the writer knows
them, letting `SyncService` coalesce updates and bump only the affected
projection revision instead of invalidating every tab for every
incoming changeset.

## Sync service

Source: `apps/ios/ADE/Services/SyncService.swift`.

### Connection lifecycle

1. App launch: read pairing secret from Keychain. Read the stored
   connection draft (machine identity, port, address candidates from the
   v3 smart-URL QR / discovery, and any saved relay candidates).
2. Open WebSocket connection. Before connecting, the saved **direct**
   address candidates (LAN, Tailscale, saved, loopback) are raced with
   concurrent raw-TCP reachability probes (happy eyeballs) and tried in
   first-reachable order, so a dead LAN IP does not cost a full open
   timeout before the live Tailscale route is attempted. Tailscale-classified
   candidates get a longer probe budget (3 s vs 1.5 s) because first contact
   through a cold DERP relay can exceed the LAN-sized timeout on exactly the
   networks where the tailnet is the only working route. Route classification
   (`syncIsTailscaleRoute`) covers CGNAT IPv4 (100.64/10), Tailscale
   IPv6 (fd7a:115c:a1e0::/48), `.ts.net` names, and the `ade-sync`
   alias. The background tailnet discovery probe (`SyncTailnetProbe`,
   45 s cadence) sweeps only a bounded port set — saved-profile ports
   plus `SyncTailnetDiscovery.probePortCandidates` (default port + 8) —
   never the full 8787–8999 stale-port range, which belongs to the
   connect path's recovery sweep. Cloud-relay candidates (full
   `wss://…/connect/<machineKey>` URLs) are zero-config and carry their
   own path/port, so they are never mixed into the host:port TCP probe
   or fallback-port sweep. When the phone has a Tailscale tunnel,
   direct routes stay preferred. When the phone has no Tailscale tunnel
   and a saved relay route exists, reconnect probes only currently live
   same-LAN routes, then dials the relay before stale saved LAN/Tailscale
   routes; this prevents "Tailscale off" from waiting behind a dead
   tailnet sweep. Pairing uses the same endpoint ordering, so a phone
   without Tailscale can pair through relay without extra user setup.
   Relay routes arrive from the pairing QR and — for already-paired
   phones — from `hello_ok` /
   `brain_status`'s `cloudRelayWssUrl`, persisted into the host
   profile's `savedRelayCandidates` (an explicit `cloudRelayWssUrl:
   null` in `brain_status` means the operator flipped the machine's
   relay kill-switch, and the phone clears its saved relay routes).
   When the ACTIVE connection is a relay route, the Settings connection
   header shows one quiet line: "Using ADE relay. For faster, more
   stable sync, connect both devices with Tailscale." `reconnectIfPossible` is guarded so overlapping
   wake-ups never stack TCP/WebSocket attempts, and a reconnect never
   tears down an already-live connection. The socket declares the
   `chunkedEnvelopes` capability and sets a 32 MiB
   `maximumMessageSize` receive budget.
   An `auth_failed` hello rejection drops the saved pairing **only**
   when the rejecting machine attributed itself (`hello_error.host`)
   and its identity matches the paired machine; unattributed or
   mismatched rejections are marked ambiguous, keep the pairing, and
   let the reconnect loop try other routes.
3. Send local `db_version` plus the per-host-DB cursor map
   (`remoteDbVersionBySite`); `hello_ok` returns the host DB's
   `serverDbSiteId` and the runtime's current project catalog when the
   runtime supports project switching. The hello peer metadata
   (`currentPeerMetadata`) also advertises the app's provenance —
   `appVersion` (`CFBundleShortVersionString`), `appBuild`
   (`CFBundleVersion`), and `bundleIdentifier` from `Bundle.main` — which
   the runtime persists into the peer's device-registry `metadata_json`.
4. If no active project is selected, show the Hub (all-projects roster
   home) instead of hydrating lane/file/PR surfaces against the wrong row.
   The Hub subscribes to the roster feed (`roster_subscribe`) to render
   every project's chats-by-lane without activating each project.
5. After the active project row exists locally, receive catchup
   changesets and hydrate lane, file, Work, and PR projections scoped
   to that project.
6. Enter continuous bidirectional sync. Inbound processing runs off
   the main actor: envelope JSON parse, gunzip, payload JSON parse,
   chunked-envelope reassembly, and changeset decode + apply all run
   in detached tasks (the SQLite connection is FULLMUTEX). The receive
   loop awaits frames in order, so application order is unchanged —
   the UI just never freezes under sync load.
7. On transport disconnect: a fast exponential-backoff reconnect burst,
   then an indefinite ~30 s slow-heartbeat retry loop. The phone never
   permanently gives up — a paired machine that comes back minutes
   later reconnects without the user touching anything. User-initiated
   disconnects from Settings (including the connecting-state Cancel
   button) cancel scheduled reconnect work and leave the phone in the
   disconnected state until the user reconnects or pairs again.
8. After pairing completes, the phone announces currently-open lanes
   via `lanes.presence.announce` so the runtime decorates
   `LaneSummary.devicesOpen` for other controllers; the phone calls
   `lanes.presence.release` when the user leaves a lane surface and
   re-announces on a 30 s heartbeat (runtime-side TTL is 60 s).

### Message types

Implemented envelope types on iOS:

| Type | Direction | Purpose |
|---|---|---|
| `hello` / `hello_ok` / `hello_error` | Bidirectional | Handshake |
| `pairing_request` / `pairing_result` | Phone → runtime / runtime → phone | 6-digit PIN pairing |
| `project_catalog_request` / `project_catalog` | Phone → runtime / runtime → phone | Refresh recent/available machine projects |
| `project_switch_request` / `project_switch_result` | Phone → runtime / runtime → phone | Prepare a sync connection for a selected machine project |
| `project_browse_request` / `project_browse_result` | Phone → runtime / runtime → phone | Browse machine directories for Open project / parent-directory picker |
| `project_default_parent_dir_request` / `project_default_parent_dir` | Phone → runtime / runtime → phone | Resolve the default parent directory for Create/Clone project forms |
| `project_open_request` / `project_open_result` | Phone → runtime / runtime → phone | Register/open an existing Git repository from the machine filesystem |
| `project_create_request` / `project_create_result` | Phone → runtime / runtime → phone | Create a new local Git project under a selected parent directory |
| `project_clone_request` / `project_clone_result` | Phone → runtime / runtime → phone | Clone a GitHub repository on the machine and register it in the project catalog |
| `project_list_my_github_repos_request` / `project_list_my_github_repos_result` | Phone → runtime / runtime → phone | List the runtime machine's authenticated GitHub repositories for the Clone flow |
| `project_forget_request` / `project_forget_result` | Phone → runtime / runtime → phone | Remove a project from the machine recent-project catalog |
| `changeset_batch` | Bidirectional | cr-sqlite changeset batch |
| `changeset_ack` | Bidirectional | Per-batch apply confirmation (or error code); the sender retransmits on timeout |
| `command` | Phone → runtime | Execution request |
| `command_ack` | Runtime → phone | Command receipt |
| `command_result` | Runtime → phone | Execution result or error |
| `file_request` / `file_response` | Bidirectional | On-demand file access |
| `terminal_subscribe` / `terminal_unsubscribe` / `terminal_data` | Phone ↔ runtime | Terminal streaming; `unsubscribe` is sent when a Work terminal screen disappears so the phone stops accumulating buffer for off-screen sessions. `terminal_data` carries `offset` — the transcript's end byte offset after the chunk (null when the session has no transcript or hit the size cap) — so the phone can detect dropped chunks. `terminal_subscribe` accepts `sinceOffset`; when the runtime can serve exactly `sinceOffset → end` within the byte budget it replies with a `delta: true` snapshot (append, don't replace), giving exact back-fill after reconnects/gaps. Snapshots also report `startOffset`/`endOffset`, plus `live: false` when no PTY backs the session (ended, or orphaned by a brain restart while status still says running) so the phone shows a resume bar instead of silently accepting keystrokes |
| `terminal_history` | Phone → runtime | On-demand scrollback paging: `{ sessionId, beforeOffset, maxBytes? }` returns transcript bytes `[startOffset, endOffset)` ending at/before `beforeOffset` (page start scanned forward to a newline/ESC boundary; `atStart: true` at beginning of transcript). Requires an active `terminal_subscribe` |
| `terminal_input` / `terminal_resize` | Phone → runtime | Raw input bytes and viewport size changes for a subscribed live PTY. Mobile resizes are non-authoritative: the runtime records the last desktop-originated size and restores it when the last subscribed phone detaches |
| `chat_subscribe` / `chat_event` | Phone → runtime / runtime → phone | Agent chat transcript streaming; `chat_subscribe` carries `sinceSeq` so the runtime can replay exactly the missed events from its per-session buffer instead of re-sending a snapshot. The subscribe ack carries `turnActive` from the live agent chat service so a phone subscribing mid-turn renders the stop button and working indicator immediately — the byte-capped snapshot tail may have dropped the turn's `status: started` event, and the synced session row arrives via the slower changeset pump. The phone keeps the hint current from live `status` / `done` events, drops it when a full ack omits the flag (older host / no live summary), and clears it on project switch / reconnect resets. Incoming chat events bump a UI revision through a leading-edge coalescer (~150 ms window: the first event after a quiet period renders immediately, bursts batch); turn-state flips bypass the coalescer entirely so the stop button reacts instantly. When the host advertises `crossProjectChat`, `chat_subscribe` / `chat_unsubscribe` also carry an optional `projectId` / `projectRootPath` override so the Hub can open a chat in a **foreign** project read-only (transcript streamed straight off that project's `.ade` JSONL) without switching the phone's active project — see the Hub and Lane-data-projection sections. A `session_meta_updated` `chat_event` carrying a client's permission/interaction/mode change is folded into the cached summary via `applyChatSessionMetaModeUpdateIfNeeded` (decoded through `AgentChatSessionMetaModeUpdate`, a lenient all-optional-string type that no-ops for the bare title/manuallyNamed events older hosts send), so the open composer's mode pill updates live without a refetch |
| `roster_subscribe` / `roster_unsubscribe` / `roster_snapshot` / `roster_delta` | Phone → runtime / runtime → phone | All-projects session roster feed backing the Hub: agent chats, their attached shell rows, and standalone CLI (tracked terminal) sessions — live **and** ended (`run-shell` infrastructure rows are excluded). Subscribe (optionally with `sinceSeq`) yields a full `roster_snapshot` then incremental `roster_delta` upserts (`changed` = whole project entries) / `removed` project ids. Un-booted projects carry disk-derived status only (a booted scope also overlays PTY liveness for CLI rows); transcripts load on demand when a chat opens. `toolType` passes through so the phone routes chat rows to the chat surface and CLI rows to the terminal — a CLI row must never take the cross-project chat quick-look (it has no chat JSONL and would render blank) |
| `envelope_chunk` | Runtime → phone | Slice of an oversized encoded envelope (>720 KB); the phone reassembles by `chunkId`/`index` before normal decode. `SyncEnvelopeChunkAssembler` enforces a 32 MiB reassembly byte cap (`maxChunkedSyncEnvelopeBytes`) and drops chunk sets with inconsistent `total`s so a malformed or oversized stream cannot grow phone memory unbounded |
| `heartbeat` | Bidirectional | Connection health (30s) |
| `brain_status` | Runtime → phone | Legacy-named cluster authority broadcast |

Gzip decompression uses the system `zlib` module. `unwrapSyncCommandResponse`
turns a raw response dict into either the `result` value or throws an
`NSError` with `ADEErrorCode` when `ok: false`.

### Offline behavior

- All synced state is available offline from the local DB.
- Execution commands queue locally and replay on reconnect. Queueable commands
  also enter the local queue when a send times out while the WebSocket still
  appears connected; the phone keeps the same `commandId`, schedules a short
  retry, and probes the transport instead of dropping the user's action. The
  runtime deduplicates retried commands by `commandId` through a TTL'd cache +
  persisted journal, so a replay returns the cached `command_ack` /
  `command_result` instead of running twice.
- A `command_result` with `error.code: "host_unavailable"` (the brain-level
  ingress answering while the project sync host is restarting — see
  `remote-commands.md`) is treated exactly like a timeout, never like an
  application rejection: `isSyncHostUnavailableError` makes it retryable and
  queueable, and the queue-drain loop **keeps** a pending operation that hits
  it so queued work survives host restarts instead of being deleted on
  replay.
- **Offline chat creation shows a "Pending sync" row.** `chat.create` is
  not host-advertised as queueable while disconnected, so when the phone
  can't send a live request it explicitly enqueues the create with a
  stable `commandId` and records a `PendingChatCreation` snapshot
  (persisted under `ade.sync.pendingChatCreations.v1` in the App Group
  defaults, carrying project/lane/name/provider/model + `queuedAt`).
  `workPendingChatCreationOptimisticSession` synthesizes a
  `TerminalSessionSummary` with a `pending-create:<commandId>` id that the
  Work list folds into its optimistic sessions so the new chat appears
  immediately; the row is not openable until the queued `chat.create`
  drains after reconnect and the real session id arrives, at which point
  the pending snapshot is removed.
- UI shows "pending sync" indicators for queued actions.

### Timeouts

`SyncRequestTimeout.defaultTimeoutNanoseconds = 30_000_000_000` (30s).
Timed-out requests throw with the message *"The machine took too long to
respond. Reconnecting now."* Chat send commands (`chat.send` and the
mobile CLI launchers) use an extended budget
`SyncRequestTimeout.chatSendTimeoutNanoseconds = 120_000_000_000` (120s)
with the friendlier message *"The machine is still starting this chat
turn. Live updates will keep syncing."* because warmup-heavy turns
routinely outlast the 30 s default without indicating a transport
failure.

A request timeout no longer unconditionally drops the connection. Inbound
traffic on the WebSocket is timestamped via `lastInboundMessageAt`
(set whenever any envelope arrives — heartbeats, change batches,
results, anything), and the timeout path consults
`syncShouldReconnectAfterRequestTimeout(now:lastInboundMessageAt:
silenceThreshold:)` before tearing down. The default silence
threshold is `SyncSocketTiming.requestTimeoutReconnectSilenceSeconds
= 12 s`. If any envelope arrived within the last 12 seconds, the
phone keeps the connection and lets the user retry. Even when the
connection has been silent for the full window, the phone does not
tear down immediately: it fails the request, marks the connection
load-strained, and runs an **active transport probe**
(`verifyTransportAliveAfterRequestTimeout` — ping the host and wait
briefly for any inbound traffic). Only a probe that hears nothing
back triggers the normal transport-failure teardown. This avoids
cycling a healthy-but-slow connection (catalog/PR refreshes can take
30 s+ on cellular) into a perpetual timeout→reconnect→re-request
loop.

`InitialHydrationGate` polls for the project row at 200ms intervals up
to a 15s total budget. This covers the first sync-after-pairing gap
where the phone has opened the WebSocket but the project row has not
yet arrived in the catchup batch.

## iOS-specific services

### KeychainService

- Stores the paired device secret produced after a successful PIN
  pairing.
- Stores connection draft metadata (machine identity, route, port, last remote db
  version) so reconnects resume cleanly. The legacy
  `lastBrainDeviceId` draft field has been removed — connections now
  resolve an address candidate from the runtime's device registry.
- Per-machine token shelf: in addition to the legacy
  single-token `connection-token` slot, tokens may be saved against a
  derived `connection-token.<machineKey>` account where `machineKey` is
  `machine:<hostIdentity>`, `site:<legacySiteId>`,
  `route:<address>:<port>`, or `name:<hostName>:<port>`.
  `SyncService` keeps a parallel
  `ade.sync.hostProfiles` `UserDefaults` blob so a phone that has
  paired with multiple machines can re-resolve the right token when
  the runtime initiates a project switch without re-bundling
  credentials. When discovery exposes a stable machine identity, the
  token migrates to the new machine key and legacy `site:` / route /
  name slots are cleared so the keychain does not accumulate orphaned
  aliases.
- Uses iOS Keychain Services API (`SecItemAdd` / `SecItemCopyMatching`
  / `SecItemUpdate` / `SecItemDelete`).

### PIN pairing flow

1. User opens Settings > Sync on the machine and sets a 6-digit
   PIN. The runtime writes the PIN under `~/.ade/secrets` (chmod `0600`)
   and surfaces it on the Settings > Sync sheet for the duration the
   user wants to accept pairings.
2. Phone opens Settings > Pairing, either scans the machine QR
   (`SettingsPairingScannerSheet` → `PairingQrPayload.parse`, a v3 smart
   URL carrying machine identity, port, and address candidates — never a
   pairing code), discovers the machine on the network, or enters machine
   address/port manually, then types the same PIN the user set.
3. Phone sends a `pairing_request` envelope with the PIN. The runtime's
   `syncPairingStore.pairPeer` validates against `syncPinStore`; the
   failure codes are `invalid_pin`, `pin_not_set`, or `pairing_failed`.
4. On success the runtime persists a per-device record and returns a
   secret. The phone stores it in Keychain and subsequent connections
   authenticate with the paired secret, not the PIN.

`SettingsPinSheet` on iOS mirrors the desktop PIN sheet and handles
the entry UX. If the user misreads the digits, the runtime applies
per-IP rate limiting (5 failures → 10-minute cooldown).

### Pair a browser

Settings > Pairing also carries a **Pair a browser** row
(`SettingsPairingSection` → `SettingsPairSheetRoute.webClient`) that lets the
phone hand the hosted browser web client
(`../web-client/README.md`) everything it needs to pair with the same machine —
without the operator having to open ADE on the computer.

`SettingsWebClientPairSheet` fetches the machine's pairing details over the
runtime-scoped `sync.getWebPairingInfo` remote command (gated on
`supportsRemoteAction("sync.getWebPairingInfo")`, so it stays hidden against
older hosts). The runtime returns a `WebPairingInfo`: the web-client pairing URL
(`https://app.ade-app.dev/pair#<payload>`, built host-side with
`buildWebClientPairUrl(buildPairingQrPayload(...))`), the current 6-digit PIN
(`code` / `pinConfigured`), the machine name, and relay reachability
(`relayEnabled` / `hasRelayCandidate`). The sheet renders a QR of the pairing
URL, a copyable/shareable link, and the pairing code as three separate panels —
the payload carries machine identity, port, address candidates, and the relay
URL, never the PIN, so the code is shown apart from the link.

Because the browser is a hosted HTTPS page, it can only reach the machine over a
`wss://` route: when the machine advertises no relay candidate the sheet warns
that the browser may only work on the same network (or that no relay route is
available yet), and when no PIN is set it tells the user to set one in ADE on the
computer. This is the phone-side mirror of the desktop's Settings > Sync web
client card.

### Background App Refresh

- Registers `BGAppRefreshTask` for periodic state sync when the app
  is backgrounded.
- iOS grants ~30 seconds per fetch window.
- Priority order: sync cr-sqlite changesets and update shared workspace
  snapshots.

### Lock Screen widget

Source: `apps/ios/ADEWidgets/`.

`ADEWidgetBundle` registers a single `ADELockScreenWidget` surface.
The widget reads the shared `WorkspaceSnapshot` from the App Group
(`ADESharedContainer.readWorkspaceSnapshot()`) and presents one
prioritized status across agents and PRs:

- awaiting user input,
- failed agents,
- failing CI,
- requested reviews or changes,
- merge-ready PRs,
- running agents,
- open PRs,
- sync/offline/idle fallback states.

The rectangular accessory carries the richest summary and, when useful,
an App Intent action from `AttentionActionIntents.swift` for approve,
deny, restart, or retry checks. Circular and inline accessories use the
same priority model with compact count/status treatments. The iOS app
still updates the shared snapshot and calls
`WidgetCenter.shared.reloadAllTimelines()` after snapshot writes.

Home Screen widgets and Control Center widgets are intentionally not
registered. ActivityKit and Dynamic Island **are** now registered — see
the Live Activity section below.

Shared DTOs live in `apps/ios/ADE/Shared/ADESharedModels.swift`:
`AgentSnapshot` and `PrSnapshot` — lightweight Codable structs
readable by the widget extension without importing the main app's
heavier renderer code.

### Push notifications & Live Activity

Source: `apps/ios/ADE/Services/PushNotificationService.swift`,
`LiveActivityService.swift`, `apps/ios/ADEWidgets/ADEAgentActivityWidget.swift`,
and `apps/ios/ADE/Shared/ADEAgentActivityAttributes.swift`. The full
pipeline (Cloudflare relay, brain publisher, APNs, content-state
contract) is documented in
[`push-notifications.md`](./push-notifications.md); the phone-side pieces:

- **Registration is post-pairing only.** The app requests notification
  authorization and registers for remote notifications after a machine
  is paired, never on first launch. `ADEAppDelegate` receives the APNs
  device token and hands it to `PushNotificationService`, which sends
  `push.registerDevice` / `push.setPrefs` /
  `push.reportLiveActivityToken` over the paired sync WebSocket
  (runtime-scoped commands the brain forwards to the relay). Every
  foreground transition re-reports tokens and ends orphaned activities;
  unpair/forget sends `push.unregisterDevice` and ends local activities.
- **Alert payloads deep-link.** A default tap carries a top-level
  `deepLink` (`ade://session/<id>`, `ade://pr/<n>`) routed through
  `DeepLinkRouter.handleNotificationUserInfo`.
- **Approval alerts are actionable.** `ADEAppDelegate` registers the
  `ADE_APPROVAL` notification category so approval pushes (stamped
  `aps.category = "ADE_APPROVAL"` plus top-level `sessionId` / `itemId` by
  the brain) show inline Approve / Deny. `didReceive response` maps the
  `ADE_APPROVE` / `ADE_DENY` action ids to `ADEIntentCommandRegistry`
  (`chat.approve`), so approvals resolve from the lock screen without
  opening the app. The `waiting_for_approval` Live Activity row carries the
  same buttons via `ApproveSessionIntent` / `DenySessionIntent`, which are
  `LiveActivityIntent`s (so they run in-app, not the widget extension); a
  tap while the app is dead queues in the registry and drains on the next
  launch / foreground.
- **App-icon badge.** The brain stamps `aps.badge` = the machine-wide
  count of runs awaiting attention on every alert (and a silent badge-only
  item when the count changes with no alert). The phone clears the badge
  on every foreground transition (`PushNotificationService.clearAppBadge`,
  called from `ADEApp`'s scene-phase handler) so a lingering count never
  reads as stale.
- **Live Activity** mirrors up to three active agent runs plus up to two
  recent PR lifecycle/status rows on the Lock Screen and Dynamic Island.
  `LiveActivityService` starts one aggregate activity per machine
  (`activityId: "agent-runs"`), applies brain-pushed content-state updates,
  and ends it when all runs are terminal and the short-lived PR rows expire.
  PR rows are sourced from the same `pr-notification` fan-out as desktop
  toasts and cover opened, reopened, closed, merged, checks failing, changes
  requested, review requested, and merge-ready states. `NSSupportsLiveActivities`
  / `FrequentUpdates` are declared in `Info.plist` and the
  `aps-environment` entitlement + `remote-notification` background mode are
  in `ADE.entitlements`.
- **Settings > Push delivery** (`SettingsPushDeliverySection`, wired from
  `ConnectionSettingsView` via `SettingsConnectionPresentationModel`)
  shows registration state, token suffix, APNs environment, last push
  received, and relay reachability (from `push.getStatus`), plus the
  notification / Live-Activity toggles, per-session mutes, and quiet
  hours. The snapshot (`SettingsPushDeliverySnapshot`) is a pure
  Equatable value mirrored from `PushNotificationService`.
- **What needs a physical device.** Simulators cannot receive real APNs
  pushes or mint push-to-start tokens; end-to-end delivery and Live
  Activity push-to-start are verifiable on-device only. Registration
  flow, command routing, and preferences are covered by simulator builds
  and unit tests.

### Haptic Feedback

- `UIImpactFeedbackGenerator` and `UINotificationFeedbackGenerator`
  on message send, intervention approval, worker launch, PR merge.

### Attention Drawer

Source: `apps/ios/ADE/Views/AttentionDrawer/`.

The attention drawer is a single global sheet (`AttentionDrawerSheet`)
opened from the navigation bar bell. `AttentionDrawerModel` rebuilds the
roster from the App Group `WorkspaceSnapshot` whenever
`SyncService.activeSessions` or `workspaceSnapshotRevision` changes, and
projects each row into an `AttentionItem` that carries the originating
session/PR ids plus an optional `itemId` lifted from
`AgentChatSessionSummary.pendingInputItemId` / `AgentSnapshot.pendingInputItemId`.

Each row renders inline actions sourced from the same surface the
notification banners use:

- **Awaiting input** — when an `itemId` is present, the row shows
  Approve / Deny buttons backed by `ApproveSessionIntent` /
  `DenySessionIntent`; otherwise the primary action is "Open session"
  (which still routes through `Reply`-style behaviour via deep link).
- **Failed** — "Open agent" plus a `RestartSessionIntent` chip.
- **CI failing** — "Open #N" plus `RetryCheckIntent` to rerun checks.
- **Review requested / merge ready** — "Review" / "Merge" /
  "View" entries that deep-link into the PR detail surface.

`AttentionDrawerModel.clearVisibleItems()` snapshots the current set of
ids into `dismissedItemIDs` (persisted under
`ade.attention.dismissedItemIDsKey` in App Group `UserDefaults`) and
prunes the in-memory list. The pruning step in
`pruneDismissedItems(activeIDs:)` runs on every rebuild, so a future
regression — a chat re-entering awaiting-input, a PR going red again —
re-surfaces the card automatically. The "Clear all" toolbar button calls
this method; the cards do not silently come back until the underlying
attention recurs.

## Tab structure

The root shell is a `TabView` whose system tab bar is suppressed
(`toolbar(.hidden, for: .tabBar)`) in favour of a hand-rolled
`ADERootBottomTabBar` injected as a bottom safe-area inset. The custom
bar exposes the five shipped tabs (Work / Lanes / PRs / Files / CTO),
renders a per-tab selection highlight, and shows a red `Capsule` badge on
the Work tab driven by `SyncService.runningChatSessionCount`
(`min(count, 99)`). Detail screens that should claim the full height —
new-chat / model-setup / advanced flows — opt out by emitting an
`ADERootTabBarHiddenPreferenceKey` value via the `.adeRootTabBarHidden()`
modifier. `ADEUIKitAppearance.configureTabBar()` (called from
`ContentView.onAppear`) also tunes the underlying UIKit `UITabBar`
appearance so any system surface that still falls through (sheets,
push-controllers built from UIKit) matches the SwiftUI chrome.

Before the tabs render, the **Hub** (`HubScreen`, in `Views/Hub/`) can take
over the root screen when no active project is selected or the user taps the
Projects toolbar button. The Hub is the app's home surface: it lists every
project on the connected machine, each expandable to its chats grouped by lane
(from the `roster_subscribe` feed — see the sub-protocol table). The active
project's chats come straight from the phone's already-synced local DB
(authoritative + instant) rather than the cross-project roster, so the active
card is never stuck on "Loading chats…". Tapping a project card opens its
detailed tabbed view; tapping a chat opens that chat directly over the Hub (the
Hub stays mounted underneath so Back returns to it, and it keeps rebuilding
roster cards while a chat is open). Opening a chat that belongs to a project
other than the active one uses **cross-project quick look**
(`HubScreen+ChatNavigation`): when the host advertises `crossProjectChat`
(`SyncService.supportsCrossProjectChat`), the cover synthesizes a
`TerminalSessionSummary` stub from the roster row
(`makeCrossProjectSessionStub`) and streams that foreign project's transcript
read-only via a `WorkSessionDestinationView` carrying a
`WorkChatCrossProjectContext` — no project switch, no runtime boot. Lane/PR
affordances are hidden in this mode (`showsLaneActions: false`) but send /
approve still work through scoped commands. On an older host without the flag
it falls back to the previous behavior: activate the project first (keeping the
Hub) and open the full-detail chat once the switch lands. Quick look is
**chat-only**: `RemoteRosterChat.isChatTool` is true only for an explicit chat
tool type (`cursor`, `chat`, `*-chat`) — a nil/unknown `toolType` reads as
non-chat, so CLI (terminal) rows opened from the Hub always take the
activation + terminal path (a CLI session has no chat JSONL; routing it
through the chat transcript surface would render permanently blank). The
hub row context menu also narrows for CLI rows: only "Open session" is
offered, since `chat.archive` / `chat.delete` reject non-chat sessions on the
host. The composer's "Created in …" toast follows the same rule — its Open
shortcut stub carries `toolType: "cli"` for CLI launches and the
provider-derived chat tool type otherwise (`HubCreatedChat.stubToolType`). A bottom
"type to vibecode" bar is now an **inline composer** (`HubInlineComposer`, in
`HubComposerDrawer`): focusing it raises the keyboard and expands the controls
strip (permission/model/mode/dictation) in place above the keyboard rather than
presenting a modal drawer. Expansion is explicit state (never derived from
`@FocusState`, which would snap) so every expand/collapse rides one shared
spring, and a Project ▸ Lane destination picker chooses where the chat lands.
The chat is created in place and does **not** auto-open — a "Created in
&lt;project&gt; · &lt;lane&gt;" toast offers an Open shortcut. Project cards are
drag-reorderable (persisted per machine, mobile-only, never touching desktop
ordering). Attention bubbles are driven by the roster's `attentionCount`
(awaiting-input + failed sessions), which — like the phone-side
`RemoteRosterChat.needsAttention` mirror for the active project — counts only
chat rows and shells attached to a chat: a standalone CLI session that exited
non-zero never contributes, because attention feeds the attention-first
project sort and CLI rows have no mobile archive/clear affordance to make a
stale failure go away. The Hub replaces the old
`ProjectHomeView`'s connected-state layout while preserving its
no-machine / connecting blank states. It still merges the runtime-provided
catalog with projects already present in the local replicated DB, marks
cached/unavailable rows, and requests a fresh bootstrap connection for the
selected machine project through `project_switch_request`. The runtime-provided catalog is local to the
paired machine and excludes desktop SSH remote recents, so the phone never
tries to switch into another machine's path. Each tile exposes a long-press "Remove from list"
action that hides the project locally and sends `project_forget_request`
to the runtime so the machine catalog drops the matching recent entry.
Each tile renders `MobileProjectSummary.iconDataUrl`
when the runtime's `projectIconResolver` found a favicon for the project,
falling back to the brand glyph otherwise. The runtime pre-renders icons
to a 64×64 PNG via Electron `nativeImage` before they reach the phone,
so the iOS side can decode them with stock UIImage. The root toolbar's
"Projects" affordance (`ADEProjectHomeButton` / `ADERootToolbarControls`)
shows the **active** project's detected favicon in place of the generic
`square.grid.2x2.fill` glyph, falling back to the grid glyph when no icon
is available. Icon decode/presentation is shared by the tiles and the
toolbar through `projectIconImage(from:)` (one process-wide `NSCache`)
and the `Image.projectIconStyle(size:cornerRadius:)` helper in
`ADEDesignSystem.swift`.

When a phone is connected, the remote catalog wins identity ties:
`SyncService.mergeCachedProjects` keeps the remote `projectId` on the
currently active project even when the local cache row carries a
different id (the older `mergedById.removeValue` path was demoting the
remote selection back to the cached id, which broke active-project
detection after a project switch). `Database.upsertMobileProjectCache`
persists each `MobileProjectSummary` into the phone's `projects` table
without capturing local CRR changes (`shouldCaptureLocalChanges =
false`) and normalises the `rootPath` (trim, drop trailing `/`) so
catalog rows from different OS reports of the same path don't
duplicate. Project list dedup runs as a final pass
(`deduplicateProjectListByRoot`) keyed on the normalised root path.
Project removal stores the same normalised-root key in addition to the
project id under the active host profile, so a DB-cached row and a
runtime-catalog row representing the same filesystem path disappear
together without hiding matching paths from other paired machines.
Opening or selecting the project again clears those hidden keys.

The Work and Hub new-session composers share the same Chat/CLI interface
preference store (`WorkNewSessionModePreferences`,
`ade.work.newSessionModeByProject.v1` in the App Group defaults). The value is
keyed by project id and is written only when the user explicitly taps the
Chat/CLI switcher, so opening a composer, switching projects, or falling back
from a CLI-only selection to a chat-compatible model never clobbers the user's
stored choice. `WorkNewChatScreen` captures the active project id when pushed;
`HubComposerDrawer` reloads the preference whenever its Project destination
changes so a hub-created session cannot accidentally launch with the previous
project's interface mode.

### Shipped

| Tab | Icon | Desktop equivalent | Capabilities |
|---|---|---|---|
| **Lanes** | `square.stack.3d.up` | `/lanes` | Full lane surface: search/filter chips, open/create/attach/manage, multi-attach for unregistered worktrees, stack canvas, git/diff/rebase/conflicts, template-backed environment setup progress, lane-scoped sessions and AI chats. `devicesOpen` presence chips show which other devices currently have the lane open. The lane detail screen (full-screen, custom tab bar hidden) is organized into collapsible sections (`LaneDetailSectionChrome`): each section auto-opens when it has content and auto-collapses when empty (`LaneSectionDisclosure`), and stays where the user last put it once they toggle it manually. Header chips and the git action buttons flow through `LaneChipFlowLayout`, a wrapping flow layout that wraps onto new lines instead of horizontally scrolling. Lane rows in the list carry a cheap render-relevant signature (mirroring the Hub row-signature pattern) so `.equatable()` re-renders only rows whose visible state changed. It embeds `LaneDetailGitActionsPane`, a port of desktop's git actions pane: commit message field with amend toggle and an AI "Suggest message" button (gated by runtime capability, with a setup-hint when the runtime reports "AI commit messages are off"), pull (rebase/merge mode) / push (with force-with-lease) / fetch, staged + unstaged file lists with per-file and bulk stage / unstage / discard / restore / open-diff / open-files, stash push/apply/pop/drop, recent-commit history with context-menu view-files / copy-message / revert / cherry-pick, and a "more actions" menu holding switch branch plus the destructive escape hatches (rebase lane, rebase + descendants, rebase and push, force push). A conflict banner offers rebase **and merge** continue/abort (`git.rebaseContinue`/`Abort`, `git.mergeContinue`/`Abort`), and a rescue sheet creates a new lane from uncommitted changes. The lane options menu copies shareable deeplinks (`LaneDeeplinkHelpers`: `ade://lane/<id>`, `ade://repo/<owner>/<repo>/branch/<branch>`) and opens `LaneManageSheet`, now a tabbed manage dialog (delete / appearance / stack / archive) mirroring desktop's `ManageLaneDialog`; for an attached-but-unmanaged lane (`adoptableAttached`, matching the host's derivation) it also surfaces a "Move to ADE-managed worktree" adopt action that copies registration into `.ade/worktrees` without rewriting git history. The previous `LaneAdvancedScreen`, `LaneCommitSheet`, `LaneStashesScreen`, and `LaneCommitHistoryScreen` destinations were deleted in favor of this single pane. |
| **Files** | `doc.text` | `/files` | Lane-backed workspace picker (`FilesWorkspacePickerDropdown`, a desktop-shaped searchable dropdown that replaced the horizontal workspace chip row), live file tree/read. Search is a single full-screen page (`FilesSearchScreen`) opened from the magnifying-glass button in the Files top bar (desktop `SearchOverlay` parity): one query searches file *names* (quick open) and file *contents* (text search) together — name matches surface first under "Files", content hits are grouped per file with collapsible line previews, and tapping a line opens the file at that line. The inline `FilesQueryCard` quick-open / text-search cards (and their 40-row caps) were removed. Files are freely editable — the mobile read-only file-mutation gate (`mobileReadOnly` / edit-protection) was removed on both the host and the phone, matching the desktop change. |
| **Work** | `terminal` | `/work` | Terminal + chat session list (standalone CLI sessions stay listed after they end, matching desktop — `workSessionShouldAppearInWorkList` in `WorkBrowserHelpers.swift` hides only `run-shell` infrastructure rows and orphaned chat-owned child shells that are no longer live), cached history with persisted lane names, output streaming, native key-passthrough terminal input (keystrokes from the iOS keyboard flow straight into the PTY as `terminal_input`, coalesced ~16 ms; PTY echo is the only source of truth), Ctrl-C forwarding for subscribed live PTYs, in-app CLI session launcher (Claude / Codex / Cursor / OpenCode / Droid), message-to-continue on ended agent CLI rows, session pinning, live chat-event push from the runtime (no polling lag once subscribed). The new-session screen (`WorkNewChatScreen`) toggles between **Chat** and **CLI** via a compact nav-bar pill toggle (desktop `ModeSwitcherPills` parity); the lane is chosen through `WorkLanePickerDropdown` (searchable, with an auto-create-lane row), and in CLI mode the provider is derived from the picked model via `workResolveCliProvider` instead of a separate provider row — the explicit `workCliProviderOptions` picker (and its plain "Shell" launch option) was removed. The new-chat composer shares the in-session chat composer's `WorkComposerControlsRow` (the same controls strip used by `WorkComposerChipStrip`): a permission/access control that collapses to a single tone-dot dropdown when space is tight and expands to segmented chips when wide, a model pill, and a fast-mode lightning toggle. The fast-mode toggle is shown only in **Chat** mode for fast-capable models (threaded into `chat.create` via `codexFastMode`) and is hidden in CLI mode, where the launcher has no fast-mode parameter. The composer's last-used selection (model + access mode + reasoning effort + fast mode) persists across surfaces through `WorkComposerPreferences` (App Group `UserDefaults`, versioned key): the New Chat screen seeds its initial state from the saved selection instead of hardcoded defaults, and every change or send — from the New Chat composer, the in-session inline picker (`WorkSessionDestinationView`), or the session settings sheet — writes it back. Because the inline picker is cross-provider, the persisted provider is re-derived from the picked model, and a provider change resets the coupled access mode / sub-settings to that provider's defaults. Droid (Factory) is in the new-chat provider allowlist (`workNormalizedNewChatProvider`), so Droid Core models (GLM / Kimi / MiniMax) keep the `droid` provider instead of silently collapsing to the Claude runtime. The new-chat send button is the shared `ADEComposerSendButton` (an arrow-in-circle disc matching the in-session composer), replacing the earlier paperplane capsule. Each session row carries a minimal per-lane PR status indicator (`WorkLanePrIndicator`: a state-colored dot + `#num` + Open/Draft/Closed/Merged) beside the lane name. It and the Lanes tab chip both render the unified `LanePrTag` (`LaneHelpers.swift`, `selectLaneTabPrTag`, desktop parity), which merges ADE-mapped PRs (the synced `pull_requests` table) with GitHub PRs opened outside ADE — matched to a lane by branch and fetched into the shared `SyncService.laneGithubPrItems` cache (`refreshLaneGithubPrItems`, best-effort, throttled, reset on project switch / reconnect). When a row resolves a `LanePrTag` (mapped or GitHub-by-branch), its long-press context menu (`WorkSessionListRow`) also offers **"Open in PRs tab"**; `WorkRootScreen+Actions.openPullRequest` waits out the menu-dismiss animation, then publishes `syncService.requestedPrNavigation` (a `PrNavigationRequest` carrying the PR id + number + lane id, or just the GitHub PR number for an unmapped tag), and `ContentView`'s `onChange(of: requestedPrNavigation?.id)` flips the app to the PRs tab and opens that PR — the same cross-tab handoff the deep-link router and the in-chat PR menu use. CLI mode submits `work.startCliSession` with the resolved provider, permission mode (Claude additionally supports `auto`), an optional `reasoningEffort`, and an optional opening message. For most providers the runtime types the opening message into the spawned PTY; for Codex the opening message is forwarded as the final argv positional through `buildTrackedCliLaunchCommand`, so the prompt is treated as a real first turn instead of a typed shell line. The terminal viewer (`TerminalSessionScreen` + `SwiftTermSessionView`) is a full-bleed SwiftTerm (real VT100/xterm) emulator: tap-to-focus raises the iOS keyboard for direct passthrough, a single-row key bar provides esc/tab/latching-Ctrl/arrows/return plus an overflow menu, pinch adjusts font size, and the phone owns the PTY's cols×rows while the screen is open (sent as `terminal_resize`; the runtime restores the desktop size on detach). Live output streams via offset-stamped `terminal_data` with gap detection + `sinceOffset` delta resume (no snapshot polling); scrolling near the top auto-pages older transcript via `terminal_history`, and a floating "↓ Live N" pill snaps back to the live tail. Only real user drags can un-pin the viewport: layout-driven geometry changes (keyboard show/hide, key bar, pinch font changes) re-assert the live tail after the pass settles, so a pinned terminal with large scrollback keeps the prompt visible above the keyboard instead of stranding it (SwiftTerm only re-snaps when cols/rows change, and a mouse-mode TUI repainting in place emits no scroll events to self-heal). When the hosted program enables mouse reporting (Claude Code, htop), vertical pans are translated into SGR wheel events so the TUI scrolls itself; mouse-off sessions scroll native scrollback. Against pre-offset hosts (older brains, whose PTY→sync bridge never pushed terminal output) the screen detects the missing offsets and falls back to a 2s tail-refresh poll until offsets appear. The screen unsubscribes via `terminal_unsubscribe` on disappear. The legacy `WorkTerminalEmulatorView`/`WorkTerminalScreen` mini-parser remains only for inline preview cards. The earlier "activity feed" section was retired — running chats are surfaced through the session list and a Work tab badge bound to `SyncService.runningChatSessionCount`. In chat sessions, user-message attachments render through `WorkChatAttachmentTray` (image thumbnails embedded in the bubble, desktop `ChatAttachmentTray` parity, placeholder tiles when the image bytes have not synced from the host yet), and the chat header's PR menu opens the lane's open PR on GitHub, copies its link, or launches the create-PR wizard in `singleModeOnly` mode (eligibility read from `prs.getMobileSnapshot.createCapabilities`). The chat composer input is a `UITextView`-backed field (`WorkComposerTextView` in `WorkComposerTypedTriggers.swift`) rather than a plain SwiftUI `TextField`, because it needs the cursor position and inline styled runs. `WorkComposerTriggerDetector` runs the same cursor-relative regexes as the shared desktop/TUI `composerTriggers.ts` (slash `(?:^|\s)/([^\s/]*)$`, at `(?:^|\s)@([^\s@]*)$`), so a `/command` or `@file` trigger is detected anywhere in the draft, not just at position 0. `WorkComposerSuggestionController` drives an inline suggestion strip (`WorkComposerSuggestionStrip`) above the input — a curated per-provider slash catalog (`WorkComposerSlashCatalog`) resolved locally, and `@file` quick-open resolved over sync via `SyncService.quickOpen` against the lane's files workspace (40 ms debounce, workspace id cached per lane, invalidated on lane change). Its visibility derives purely from the active trigger match, never from `@FocusState`. Committing a suggestion splices exactly the trigger span on the live text view, and confirmed `/command` / `@path` tokens render as tinted chip pills drawn by a custom TextKit 1 `WorkComposerChipLayoutManager` (provider-accent tint, monospace for slash, semibold for at) while `draftState.text` stays the plain-text source of truth that is sent. This replaced the modal `WorkMentionsPickerSheet` and `WorkSlashCommandsSheet` (both deleted). |
| **PRs** | `arrow.triangle.pull` | `/prs` | PR list/detail driven by `prs.getMobileSnapshot`: stack visibility (`PrStackSheet`), create-PR wizard (`CreatePrWizardView`) gated by per-lane eligibility, workflow cards (queue / integration / rebase) rendered from `PrWorkflowCard`, per-PR action capabilities. The PR detail screen (`PrDetailView`) is a single-column adaptation of the desktop Timeline+Rails layout — its Overview is emitted as sibling `List` rows so the list virtualizes offscreen content, and it stays live off a warm-cache freshness gate (see [PR detail screen](#pr-detail-screen)). |
| **CTO** | `brain` | `/cto` | The CTO chat thread rendered inline as the tab body (single persistent session via `CtoSessionDestinationView`), with a top-bar gear opening the settings sheet (identity, read-only Linear status, memory via `cto.getMemory`, re-run setup). |
| **Settings** | `gearshape` | `/settings` (sync subset) | Pairing — scan the QR (`SettingsPairingScannerSheet`), discover on network, or enter machine details manually — plus PIN entry (`SettingsPinSheet`), appearance, diagnostics, connection header with QR payload and address candidates, reconnect, forget, and a **Push delivery** panel (`SettingsPushDeliverySection`: registration/permission state, APNs environment, relay reachability from `push.getStatus`, and notification / Live-Activity / quiet-hours toggles). `ConnectionSettingsView` binds to `SettingsConnectionPresentationModel`, which feeds plain `SettingsConnectionSnapshot` / `SettingsPairingSnapshot` / `SettingsDiagnosticsSnapshot` / `SettingsPushDeliverySnapshot` DTOs into the section views (`SettingsConnectionHeader`, `SettingsPairingSection`, `SettingsDiagnosticsSection`, `SettingsPushDeliverySection`) instead of having them reach into `SyncService` directly. |

### Planned

- Automations, Graph, History tabs.
- Full Settings parity with the desktop.
- iPad adaptive layout, Spotlight.

## Lane data projection

All lane, file, Work, and PR projections are scoped through
`Database.currentProjectId()`. The iOS app stores the active project id
in `UserDefaults`, mirrors it into `DatabaseService`, and falls back to
the Hub if no selected project row has arrived yet. The
machine runtime runs at most one active sync project at a time behind
a single brain-level listener on a stable port. When the phone asks
the runtime to switch projects, the runtime activates the requested
project locally, returns `connection: null`, and the phone reuses its
existing pairing credentials to reconnect against the same port. The
phone keeps a durable inbound cursor **per host DB site**
(`remoteDbVersionBySite`, keyed by the `serverDbSiteId` from
`hello_ok`) because each hosted project DB has its own `db_version`
sequence — returning to a previously-synced project resumes its
backlog precisely instead of replaying everything or skipping. If the
runtime is offline at switch time, it still records the requested
project as active and the phone reconnects when the machine returns.

Before tearing down the old connection on a project switch, `SyncService`
calls `resetChatEventState(clearHistory: false)` and
`resetTerminalSubscriptionState(clearHistory: true)` so chat /
terminal subscriptions bound to the previous project's session ids
are dropped. Without this reset, the phone would resubscribe to stale
ids after reconnect and either leak foreign chat events into the new
project view or collide with newly-assigned session ids on the runtime.

Rather than reconstructing lane detail surfaces client-side from
primitive rows, the iOS app persists richer projections the runtime
sends:

- Lane list snapshots (`LaneListSnapshot`) with runtime bucket
  summaries (running / awaiting-input / ended / session count).
- Cached lane-detail payloads (`LaneDetailPayload`) keyed by lane id
  so the Lanes tab can render the desktop stack / git / diff / manage
  / work surfaces without client-side reconstruction. `lanes.getDetail`
  and `lanes.refreshSnapshots` are conditional responses: each carries a
  `signature` (a sha256 of the full payload) and the phone echoes the
  cached one back as `ifNoneMatch`. When it matches, the runtime returns a
  bare `{ signature, notModified: true }` shell (decoded through
  `LaneNotModifiedEnvelope`) and the phone keeps its cached payload,
  skipping both transport and a full re-decode. See
  [remote-commands.md](./remote-commands.md).
- Unregistered-worktree candidates (`UnregisteredLaneCandidate`) returned
  by `lanes.listUnregisteredWorktrees`; `LaneMultiAttachSheet` can attach
  selected rows and optionally move them under ADE management.
- Environment-init progress (`LaneEnvInitProgress`) returned by
  `lanes.initEnv`, `lanes.templates.apply`, and `lanes.getEnvStatus`;
  `LaneCreateSheet` switches from the form to a progress panel when a
  template-backed create starts runtime-side setup.
- `LaneSummary.devicesOpen` lists the devices currently on a lane,
  decorated by the runtime from `lanes.presence.announce` events.

The runtime produces these via `lanes.refreshSnapshots` and
`lanes.getDetail` remote commands. The phone calls the command, stores
the result, and reads from the local store afterward so reconnects and
offline usage remain fast. Lightweight list refreshes can ask the
runtime to skip expensive decorations (`includeConflictStatus`,
`includeRebaseSuggestions`, `includeAutoRebaseStatus`); the phone
preserves the last known decoration values in its local snapshot cache
so rebase/conflict badges do not disappear while a cheap runtime-bucket
refresh is in flight.

Projection reloads are keyed by narrow revision counters:
`lanesProjectionRevision`, `laneDetailProjectionRevision`,
`workProjectionRevision`, `filesProjectionRevision`,
`prsProjectionRevision`, and `proofArtifactsProjectionRevision`.
Top-level tabs and detail screens observe only the revision that maps
to their data, so a chat transcript changeset no longer causes Files,
Lanes, and PRs to all re-query together.

## PR data projection

The iOS PR wizard (`CreatePrWizardView`) supports three create modes —
`single`, `queue`, and `integration` — as a single scrollable form (the
earlier Mode → Source → Details → Review stepper was removed): a mode
selector (hidden when the wizard is opened with `singleModeOnly`, e.g.
from a lane that can only create one PR), a source-branches section,
and a target-branch picker rendered by `PrTargetBranchPickerDropdown`
(searchable dropdown over the lane's eligible base branches). Per-mode
submit handlers route through the sync command surface:

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
  "machine offline" banner.

The PR list's GitHub browser reads the repo-scoped GitHub snapshot
(`repoScopedGitHubPullRequests`). Legacy cross-repo `externalPullRequests`
items are ignored, matching the desktop change — when a routed PR isn't in
the lane-PR list, `PrDetailView` synthesizes a fallback list item from the
repo-scoped GitHub row + snapshot so the hero card never collapses into a
`Pull request / @unknown` placeholder.

### PR detail screen

Source: `apps/ios/ADE/Views/PRs/PrDetailScreen.swift` (the `PrDetailView`
struct), with the timeline builder + commit-group folding in
`PrDetailActivityTab.swift` and card views in `PrDetailOverviewTab.swift` /
`PrHelpers.swift`.

The detail screen is a single-column adaptation of the desktop
Timeline+Rails PR view. Its Overview is emitted as sibling `List` rows
(`overviewThreadRows`) rather than a single nested card, so the `List`
virtualizes offscreen thread content instead of laying out the whole PR on
every scroll frame. The navigation header uses a plain back chevron, centered
PR title with `#number · lane · branch`, and a plain ellipsis actions button.
Reading order (desktop parity, folded to one column):

1. a compact summary section (`PrDetailSummarySection`) with state, merge/check
   status, diff totals, and an expandable commit list whose rows jump to the
   matching timeline anchor;
2. an unmapped-PR banner (`PrUnmappedThreadBanner`) when the PR has no ADE
   lane, offering auto-map (`prs.createLaneFromPrBranch`) or Open in GitHub;
3. the AI summary card (`PrAiSummaryCard`, +/- totals from the file list);
4. the PR description (`PrThreadDescriptionCard`);
5. a chronological event feed — one row per timeline event or folded
   commit group, ascending oldest → newest, built by
   `buildPullRequestTimeline` and folded via `buildPrTimelineDisplayItems`
   (`PrDetailActivityTab.swift`) so runs of same-author commits collapse
   into a single group row;
6. review threads (unresolved first, resolved folded into a collapsible
   section). Individual thread/comment cards are also collapsible on mobile:
   folded rows use cheap inline preview text, while expanded rows render the
   full normalized markdown body through `WorkMarkdownRenderer`;
7. the comment composer (locked for unmapped PRs);
8. the inline merge rail (`PrOverviewMergeRail`) carrying the desktop
   GitHub-style requirement checklist (`PrMergeChecklist` —
   conflicts / behind-base / checks / review), the merge-method sheet, and
   admin-bypass gating;
9. metadata cards — checks, commits, files, people, and the stack card,
   plus a post-merge cleanup banner.

There is no separate Activity sub-tab — the activity feed lives inside
Overview, and the visible sub-tabs are Overview / Files / CI-Checks (a
persisted `.activity` selection routes to Overview). The
render-path-expensive derived models — the sorted timeline, the folded
display items, the unresolved/resolved thread split, and the synthesized
fallback PR — are precomputed once per data change in
`recomputeDerivedModels()`, never inside `body`.

**Palette.** The PR surfaces use `PrGlassPalette` (in `PrMergeGateCard.swift`)
and `PrsGlass` (in `PrListRowModifier.swift`), which are now flat and
adaptive light/dark and map to the desktop CSS tokens: `ink` =
`--pr-surface` (rgb 15,16,16 in dark / 245,243,240 in light), `threadCard` =
`--pr-thread-card` (rgb 23,23,24 dark), `panelCard` = `--pr-panel-card` (rgb
24,23,43 dark, faint violet). `prGlassCard` is a flat fill + hairline border
+ small drop shadow (no materials, blur, or blend modes), and
`prLiquidGlassBackdrop()` is a flat surface color (`PrGlassPalette.ink`) —
the previous stacked radial-gradient / `.plusLighter` backdrop was dropped
because it forced expensive re-compositing under every scroll frame.

**Freshness.** `PrDetailView` re-fetches its action sidecars (review threads,
activity feed, action runs, deployments, AI summary, capabilities) on a
`.task(id: syncService.prsProjectionRevision)`, throttled by a warm-cache
freshness window (`detailFreshnessWindow = 25 s`). It first seeds from the
service warm cache for an instant render; when the cached entry is younger
than 25 s the revision-driven reload skips the cold sidecar fan-out (8+
network calls) and only refreshes the cheap local projection, and when the
window has lapsed the next projection bump re-fetches the sidecars too. This
is what keeps an open detail screen live under webhook-relay-driven host
updates: a GitHub webhook lands on the host, the host's hot poll rewrites
the replicated snapshot rows, the changeset pump bumps `prsProjectionRevision`
here, and the gate turns that into a throttled sidecar refresh (at most once
per 25 s) instead of a one-shot load. Pull-to-refresh and the explicit retry
path bypass the window. Detail actions (merge / close / reopen / comment /
edit) route through `SyncService.runDurablePrAction` so their spinners
survive a tab switch + remount.

## Command policy from the runtime

The runtime exposes command-policy metadata
(`SyncRemoteCommandDescriptor.policy` with `viewerAllowed`,
`requiresApproval`, `localOnly`, `queueable`) through the sync command
surface. The phone reads these descriptors and gates UI actions
against them instead of relying on hardcoded mobile assumptions. A
runtime that disables a command via policy change is immediately
reflected in the phone's UI on the next descriptor read.

## Implementation status (phone specifics)

| Component | Status |
|---|---|
| Xcode project setup | Implemented |
| Native SQLite3 + pure-SQL CRR | Implemented |
| WebSocket client | Implemented |
| PIN pairing flow | Implemented |
| QR pairing payload (v3 smart URL) + camera scanner (`SettingsPairingScannerSheet`) | Implemented |
| Device-bound pairing (DPoP, Secure Enclave P-256) | Implemented (`DpopKeyService`; signed proof on every paired hello) |
| Cloud relay (automatic `relay` transport, promoted when the phone has no Tailscale tunnel, no user setup) | Implemented |
| Project home + machine project switching | Implemented, including Add project actions for browsing/opening existing Git repos, creating local projects, cloning GitHub repos on the paired machine, and removing projects from the list |
| Lanes tab | Implemented to live machine parity (with `devicesOpen`, multi-attach, stack canvas, stack-position/base-branch editing in Manage Lane, and template environment progress) |
| Files tab | Implemented with freely-editable workspaces (mobile read-only file gate removed) and a unified full-screen name + content search page (`FilesSearchScreen`) |
| Work tab | Implemented; live chat-event push from runtime, subscribed terminal input/resize control with `terminal_unsubscribe` on view disappear, in-app CLI session launcher (`work.startCliSession`), message-to-continue on ended agent CLI rows |
| PRs tab | Implemented; driven by `prs.getMobileSnapshot` |
| Settings tab (pairing / appearance / diagnostics) | Implemented |
| CTO / Automations / Graph / History tabs | Planned |
| Full Settings parity | Planned |
| Lock Screen widget | Implemented; single prioritized status across agents, PRs, sync, offline, and idle states |
| Push notifications (APNs alerts + deep links) | Implemented (on-device E2E needs a physical iPhone) |
| Live Activity + Dynamic Island (`ADEAgentActivityWidget`) | Implemented (push-to-start / background updates verifiable on-device only) |
| Push delivery settings panel (`SettingsPushDeliverySection`) | Implemented |
| Home Screen / Control Center widgets | Not shipped |
| iPad adaptive layout | Planned |
| Spotlight indexing | Planned |

## Gotchas

- **Phones never become the runtime.** Any future feature that needs to run on the
  phone should be implemented as a controller operation that sends a
  command to the runtime. Agent processes, PTYs, worktrees, and workers
  are all runtime-side.
- **The phone's local DB is authoritative for reads.** If a read
  looks stale, the fix is on the runtime push side (make sure the table
  is a CRR, make sure writes land in a table the phone reads), not
  on the phone. Avoid adding runtime-only caches that the phone has no
  way to observe.
- **Project selection gates hydration.** A phone paired to a machine can
  know about multiple machine projects, but lane/file/Work/PR reads must
  stay scoped to the active project id. If a switch fails, roll back the
  active project id, machine profile, token, and remote DB version together.
- **Keychain items survive app uninstall on some iOS builds.**
  Pairing forget should both clear Keychain and clear the draft row;
  the Settings tab's "Forget machine" flow does both.
- **The ADE iOS bootstrap SQL is generated.** When desktop `kvDb.ts`
  schema changes, regenerate `DatabaseBootstrap.sql`. Schema drift
  between desktop and iOS breaks the first-launch bootstrap.
  `changeset_batch` apply no longer fails on tables the phone's
  schema doesn't know — those rows are skipped so a newer desktop can
  never freeze a phone's sync — but the skipped tables' data is
  simply missing until the app updates.
- **Integration proposal schema must move with PR workflow fields.**
  Desktop merge-into-lane proposals store
  `preferred_integration_lane_id` and `merge_into_head_sha` on
  `integration_proposals`; iOS mirrors them in `DatabaseBootstrap.sql`,
  `DatabaseService.fetchIntegrationProposals()`, and
  `RemoteModels.IntegrationProposal`. Missing any leg makes synced PR
  workflow cards lose their adopted-lane/drift state.
- **`InitialHydrationGate` can fire its 15s timeout on slow links.**
  The visible symptom is "The machine returned incomplete ... data."
  Bumping the timeout globally is not recommended; instead improve
  the runtime's catchup responsiveness or let the user retry.
- **Per-command latency matters more than throughput.** The phone
  often submits one command at a time (user tapped "merge"). Keep
  command handlers on the runtime responsive; bulk operations should
  be batched into a single command with a single reply rather than
  rapid-fire command storms.
- **A request timeout is not the same as a dead connection.** The 30 s
  `SyncRequestTimeout` never tears the socket down directly. If
  anything has arrived on the WebSocket within the 12 s
  `requestTimeoutReconnectSilenceSeconds` window (heartbeats, change
  batches, a result), the timeout surfaces to the caller and nothing
  else happens. If the socket has been fully silent, the phone runs an
  active transport probe and tears down only when the probe also hears
  nothing. New transport-affecting code should bump
  `lastInboundMessageAt` on inbound traffic and treat that timestamp
  as the source of truth for "is this connection actually alive".
- **Connection UI must use `SyncConnectionHealth`, not the raw state.**
  `RemoteConnectionState.syncing` is just transport `connected` doing
  catchup work, and `RemoteConnectionState.error` carries failure text
  that should not bleed into a `disconnected` UI. New connection
  affordances should render off `syncService.connectionHealth` so
  load-strain and transport failure stay distinct from each other and
  from background sync work.
- **Chat streaming is push, with seq-based resume.** Once a phone
  sends `chat_subscribe`, the runtime fans out `chat_event` envelopes in
  real time from `agentChatService.subscribeToEvents`. Each event
  carries a host-assigned per-session monotonic `seq`; the phone tracks
  the highest applied seq per session, drops duplicates, and sends it
  back as `sinceSeq` on re-subscribe so the runtime replays exactly the
  missed events from its replay buffer instead of re-sending a
  snapshot. Uncoverable gaps fall back to the snapshot path, and a
  non-resumed subscribe ack resets the phone's watermark (seq epochs
  restart at 1 when a new host takes over). Events without `seq`
  (older hosts) bypass the watermark entirely.
- **Transcript history pages through an opaque cursor.**
  `chat.getTranscript` responses carry `nextCursor`; the phone's
  `fetchChatTranscriptPage` requests strictly-older history with it.
  The default fetch budget is 500 messages / 600k chars.
- **Chat subscribe requests a 2 MB snapshot window.** The phone sends
  `chat_subscribe` with `maxBytes: 2_000_000`
  (`syncChatSubscriptionMaxBytes`) so the initial snapshot can carry
  long transcripts without the runtime truncating prematurely. When the
  runtime still responds with `truncated: true`, the phone calls
  `mergeChatEventHistory` instead of `replaceChatEventHistory`: the
  existing cached events are unioned with the truncated snapshot,
  deduplicated by `id`, and re-sorted by `(timestamp, sequence)`.
  Non-truncated snapshots take the replace path. Both paths run through
  `deduplicatedChatEventHistory` and then through `trimChatEventHistory`,
  which caps retained events at `chatEventHistoryMaxEvents = 1_000`
  (up from the previous 500-event cap) so very long chats don't evict
  their own recent turns on reconnect.
- **Chat-event snapshot decode is element-lossy, not all-or-nothing.**
  The `events` array on every chat snapshot payload
  (`AgentChatEventHistorySnapshot`, `SyncChatSubscribeSnapshotPayload`,
  etc.) is decoded through the `@ADELossyArray` property wrapper: one
  event the phone's model can't decode (a newer host emits a field/enum
  case this build doesn't know) is skipped instead of failing the whole
  array. A strict all-or-nothing decode there would drop the entire
  transcript, which strands pending-input question/approval/plan cards
  behind the plain-text fallback and locks the composer. When adding a
  new event or card type, keep the phone's decoders tolerant — a foreign
  event should degrade to "that one event is missing", never "the whole
  transcript is gone".
- **Codex app-server chat events are first-class on Work.** Mobile
  mirrors the desktop/TUI Codex runtime rows by decoding
  `codex_safety_buffering`, `codex_moderation_metadata`, `codex_sleep`,
  `codex_thread_deleted`, and `codex_turn_stalled` in
  `RemoteModels.swift`, mapping them through `WorkEventMapping.swift`,
  and rendering compact timeline cards. Web-search events also carry
  provider action metadata (`query` / `queries`, `title`, `url`,
  `snippet`); Work keeps those in the enriched web-search tool card so
  URLs are visible without duplicating the same event as a second row.
- **Long Work chats must keep row work and root polling cheap.** The
  Work chat detail keeps the full timeline snapshot preview-free, then
  attaches cached initial assistant-message previews only to the visible
  presentation rows. That avoids splitting or line-counting huge hidden
  markdown strings during live-delta rebuilds or SwiftUI body evaluation.
  User-bubble width is measured once at the scroll viewport rather than
  with a `GeometryReader` on every row. The Work root's live-chat
  prefetch cache is intentionally a quiet reference cache
  (`WorkRootTranscriptCache`), not value `@State`, so transcript-cache
  updates do not repaint the session list. Root polling also ignores
  terminal-buffer invalidation when structured chat events exist; terminal
  fallback cache keys use per-session terminal-buffer revisions, and any
  needed transcript cache entries are built on a utility task. Detail
  screens still fetch full history through `chat.getTranscript` cursor
  paging and `chat_subscribe` resume.
- **Work transcript parser uses `messageId` as a fallback item id.**
  `makeWorkChatEvent` (`WorkEventMapping.swift`) and
  `parseWorkChatTranscript` (`WorkTranscriptParser.swift`) now fall back
  to the `messageId` from `chat_event` when no `itemId` is present, so
  streaming assistant-text fragments merge into the same transcript row
  even when the runtime only surfaces a `messageId`. `buildWorkChatMessages`
  (`WorkErrorAndMessageHelpers.swift`) tracks a
  `previousEnvelopeWasAssistantText` flag and allows merging into the
  previous assistant bubble when either (a) the text event has an
  `itemId` or (b) the immediately preceding envelope was also assistant
  text. This keeps the iOS Work chat from fanning a single assistant
  turn into many tiny rows.
- **CLI launcher provider IDs are runtime-validated.** The Work
  new-session screen sends `provider` strings that
  `parseCliProvider` matches verbatim against
  `claude | codex | cursor | droid | opencode | shell`. The phone
  has no way to pass arbitrary `command` / `startupCommand` payloads
  — those come from the shared
  `apps/desktop/src/shared/cliLaunch.ts`. On the phone the provider is
  derived from the picked model via `workResolveCliProvider`
  (`WorkModelCatalog.swift`, mirroring desktop's
  `resolveCliProviderForModel`), so adding a provider means updating
  both the runtime registry and the phone's model-catalog grouping
  together; the Claude picker order mirrors desktop (Fable 5, Opus
  4.8 1M, Sonnet 5, Haiku 4.5, Opus 4.7 1M) and legacy Sonnet 4.6 /
  basic Opus 4.7 selections normalize forward instead of appearing as
  rows. `shell` remains valid runtime-side but the phone no longer
  offers a plain-shell launch. `SyncStartCliSessionArgs` also carries
  an optional `reasoningEffort` field that the runtime forwards to
  `buildTrackedCliLaunchCommand`, so the phone can launch a Codex /
  Claude CLI session at a non-default effort tier without going
  through the desktop.
- **Codex CLI launches receive the initial prompt as argv, not PTY
  echo.** Other providers still receive `initialInput` as bytes typed
  into the spawned PTY (`writeBySessionId(sessionId, "${input}\\r")`),
  but Codex receives it as the final positional argv on `codex` via
  `buildTrackedCliLaunchCommand` so the model sees a clean first turn
  instead of a typed shell line. Runtime-side, plain `shell` launches
  still go through `resolveCleanShellLaunchFields` so the spawned shell
  never reads the user's profile / rc / config files (the phone UI no
  longer offers that option).
- **Pending-input item id flows out through chat summaries.** Both
  `AgentChatSessionSummary.pendingInputItemId` and
  `TerminalSessionSummary.pendingInputItemId` are populated by the
  runtime whenever a session is in `awaitingInput`, derived from the
  live runtime's pending input map and (as fallback) from the recent
  event history. iOS reads it into `AgentSnapshot.pendingInputItemId`
  and `AttentionItem.itemId`, which is the value the AppIntents-backed
  Approve / Deny / Reply buttons need to address a specific approval —
  the phone can decide an awaiting-input row at the source instead of
  forcing the user to open the session.
- **The chat-summary cache merges, it never wholesale-replaces.**
  `cacheChatSummaries` folds each incoming summary into
  `chatSummaryCache` by session id rather than swapping the whole map.
  A partial Work-list refresh (the reduced-sync-load `prefix(6)`, or a
  lane whose `listChatSessions` throws and returns `[]`) hands off a set
  that omits the currently-open session; replacing the cache would evict
  that session's summary and blank the chat composer's model/permission
  controls, which gate on `summary.isAvailable` (false for a nil
  summary). Merging keeps prior summaries alive until explicitly
  overwritten. A project switch or disconnect still clears the whole
  cache — `resetChatEventState(clearHistory: true)` calls
  `chatSummaryCache.removeAll()` — so another project's or a stale
  connection's summaries never linger.
- **Consolidated pending-input strip with optimistic removal.** The Work
  chat session collapses all pending inputs into one strip pinned above
  the composer (`consolidatedPendingStripSection` in
  `WorkChatSessionView+Timeline.swift`), replacing the earlier split of
  plan/approval composer strips plus inline question/permission/model-
  selection transcript cards. Answering an item inserts its id into
  `optimisticallyAnsweredInputIds` so it hides immediately and the strip
  advances to the next request without waiting for the host round-trip;
  the id is reconciled out once the item leaves the host-derived queue
  (`canonicalPendingInputSignature` change) or rolled back if the command
  set `errorMessage`. "Accept all" (`acceptAllPendingInputs`) is offered
  only for approval/permission gates — never question, plan-approval, or
  model-selection — and flips `acceptForSession` on the current gate then
  accepts each remaining sweepable gate sequentially (stale itemIds no-op
  on the host, so re-sends after auto-resolution are safe).
- **`AttentionDrawerModel.clearVisibleItems()` persists dismissals
  scoped to the active id set.** Ids are stored under
  `ade.attention.dismissedItemIDs` and pruned on every rebuild
  against the live active set, so a chat that re-enters
  awaiting-input or a PR that goes red again resurfaces automatically.
  Do not turn this into a permanent allowlist; recurrence visibility
  is the whole point.
- **The runtime's iOS sync wants `ADE_PROJECT_ROOT` for
  preferred project.** `ade serve` reads `ADE_PROJECT_ROOT` and
  pre-registers the project through `ProjectRegistry.add` so the sync
  runtime opens with that project as the preferred one
  (`scopeRegistry.ensureSyncHost(preferredSyncProjectId)`). Without
  it, the runtime still starts but does not pin a project,
  and the phone has to wait for the desktop to switch projects before
  it can issue project-scoped commands.
- **Continuing an ended agent CLI row goes through `work.sendToSession`.**
  The phone keeps the transcript visible, collects the user's next
  message, and sends it with the durable `sessionId`. The runtime writes
  to a live PTY when present, or starts the provider continuation
  internally and attaches the new PTY to the same session row.
- **`TerminalSessionScreen` + `SwiftTermSessionView` drive a real
  SwiftTerm grid, not a free text view.** The viewport reported back to
  the runtime is in (cols, rows) inferred from the rendered glyph cell,
  not pixel dimensions. The terminal unsubscribes the runtime stream on
  `onDisappear` so a user paging through the session list does not keep
  a phone-owned viewport attached; `restoreTerminalSubscriptions`
  re-subscribes on reconnect with the last known transcript end offset
  for any session id still tracked in `subscribedTerminalSessionIds`.
  Terminal snapshots request up to 240 KB for legacy hosts; offset-aware
  hosts use `sinceOffset` delta snapshots and `terminal_history` pages
  so the phone can keep older scrollback without reloading the whole
  tail.
- **Lane presence is best-effort with a TTL.** The phone
  re-announces on a 30 s cadence; the runtime prunes stale entries at
  60 s. A phone that crashes without sending `lanes.presence.release`
  will disappear from `devicesOpen` one cycle later, not instantly.
- **Phone file edits are no longer read-only-gated.** The old
  `mobileReadOnly` / `isReadOnlyByDefault` write gate was removed on
  both the phone and the host, matching the desktop edit-protection
  removal, so a desktop-writable workspace is also editable from the
  phone. The fields still ride the payload but no longer block `files.*`
  mutating commands.
