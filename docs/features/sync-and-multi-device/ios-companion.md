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

ADE Mobile connects to a **machine**, not to a desktop window. The machine is
shown by its account-wide custom name when one exists, then by the computer name
reported by its publisher. LAN, Tailscale, and Relay remain connection details
rather than being inferred from the name.

1. Sign in to the same ADE account on the phone and computer. This is the
   primary path: the computer appears through the account directory and the
   phone adopts it through Relay without a PIN.
2. For a direct connection without an account, open the computer's
   **Connections** panel. The **This Mac** card owns the pairing PIN and QR.
   On the phone, scan that QR or choose the Mac from Nearby; there is no
   pairing-link paste or manual address + PIN entry.
3. Enter the 6-digit PIN for a new QR/Nearby pairing. The phone receives a
   durable per-device secret and stores it in Keychain, so future reconnects
   do not ask for the PIN again.
4. Pick a project from the machine catalog. The machine keeps one sync
   listener on a stable port; switching projects swaps which project
   host owns the connection, and the user-facing model stays
   machine -> projects.

Every fresh signed-out launch shows the account choice before the app. Signing
in is not required for local-first use: **Continue without an account** keeps
QR + PIN, Nearby + PIN, and the advanced SSH bootstrap available. If
the phone already has a direct pairing, continuing resumes its ordinary saved
reconnect without asking for the PIN again. A signed-in launch enters the app
directly.

Choosing a signed-in account machine performs first-time adoption through the
directory using LAN, Tailscale, then Relay. LAN/Tailscale adoption is allowed
only when the directory row contains the host's Ed25519 signing key and the
phone verifies a sealed `ade-adopt-v1` challenge before releasing the account
credential; an unsigned legacy host remains Relay-only. The phone stores the
returned per-device secret and DPoP key for direct reconnects, and adds a fresh
in-memory account token to every later Relay hello. The account token is never
saved with the machine.

For that sealed adoption, iOS advertises the AEADs its CryptoKit runtime
supports (`chacha20-poly1305` and `aes-256-gcm`). The host selects the first
mutual option, echoes it in `account_challenge_ok`, and signs the selected AEAD
with the ephemeral-key challenge so an on-path peer cannot downgrade it. The
phone uses that same AEAD for both the sealed account hello and the sealed
paired credentials in `hello_ok`. A legacy host that omits `aead` remains
compatible through the original ChaCha20-Poly1305 path; a host with no mutual
cipher fails before the phone releases any account credential and asks for ADE
to be updated on both devices.

Device-bound machine trust and account transport authorization are separate.
Signing out, switching accounts, or confirmed session loss closes an active
Relay socket, removes account-directory visibility, and blocks every saved
Relay route. It does not delete the host-issued paired secret, DPoP key, or
machine profile needed for a LAN/Tailscale reconnect. ADE immediately tries
those direct routes, and **Forget machine** remains the explicit trust-deletion
boundary. A transient Clerk or directory outage is not treated as logout and
does not erase saved machines.

### Pair with SSH

SSH pairing is a one-time bootstrap for a Mac that already has ADE installed.
The phone accepts a Nearby machine or a manually entered host/Tailscale address,
port, and macOS username. It then:

1. authenticates with a private key;
2. displays the Mac's `SHA256:` SSH host-key fingerprint for explicit trust on
   first use (and rejects a changed fingerprint later);
3. invokes `ade sync pair-device --json-stdin` over SSH, with the phone's public
   DPoP identity only in JSON stdin; and
4. stores the returned device pairing as a normal ADE machine pairing. SSH is
   no longer used for routine sync after that point.

Supported client keys are Ed25519 OpenSSH private keys, encrypted or
unencrypted, and unencrypted ECDSA P-256, P-384, or P-521 OpenSSH private keys.
Citadel 0.12.1 cannot decrypt encrypted ECDSA OpenSSH keys; import an
unencrypted copy or use Ed25519. RSA keys are deliberately rejected. Imported
keys are ephemeral by default. If the user opts into SSH recovery, the key and
passphrase are stored in this device's Keychain with current-biometric-set
access control and are not synced to an ADE account.

The same machine token works across LAN and Tailscale routes and across
that machine's projects. `siteId` remains an internal per-project
database/runtime detail and must not be used as the visible identity of
a saved machine.

## Host version compatibility

ADE Mobile treats the machine connection as the recovery path for updates, so a
new mobile app must still connect to older brains inside the supported wire
range. Protocol versions are strict integers and the accepted interval is
`syncProtocolMinSupported...syncProtocolVersion` (currently `1...1`). A host
outside that interval returns or triggers a typed
`protocol_version_mismatch`; the phone stops retrying and says whether to
update the Mac or the iPhone. The host's typed error carries the received,
minimum, and current versions plus `updateTarget`, and the host closes with
code `4406` only after attempting that uncompressed error frame. This hard
version boundary is separate from additive feature compatibility.

Inside the supported range, the phone reads
`features.mobileCompatibility` from `hello_ok` when a host advertises it:
`full` means every required mobile command is present, while `limited` means the
phone remains connected but gates missing host actions locally. Older brains
omit the feature entirely; iOS interprets that as a legacy limited connection,
not as a handshake failure.

Unsupported actions fail before they are queued or sent with a user-facing
"update ADE on the machine" message. This keeps an auto-updated phone usable for
the one action users need most: seeing that the host is behind and triggering a
host update path that the older brain still supports.

Scheduled-work cancellation follows that rule. The phone shows Cancel only for
an active durable row and only when `canInvokeChatRemoteAction` confirms that
the selected chat's host advertises `chat.cancelScheduledWork`. The command is
non-queueable: an offline phone or older brain leaves Chat Info view-only rather
than recording a cancellation that could run after the job has already fired.
The host registry also advertises non-queueable `chat.createScheduledWork` and
`chat.setScheduledWorkPaused` descriptors. Native Chat Info implements per-chat
Pause/Resume when the viewer-allowed pause descriptor is present; create remains
owner-only and has no native creation control. For a Hub
personal chat, `chatActionName` maps Cancel and Pause/Resume to the matching
runtime-scoped `personalChats.*` descriptors, so the same UI works without a
project binding.

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
│   │   ├── ContentView.swift        # signed-in-or-continue launch gate, then
│   │   │                            # 5-tab TabView with a custom
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
│   │   │                            # handler. Compact PR links flip tabs via
│   │   │                            # .adeDeepLinkRequested. Session links publish
│   │   │                            # WorkSessionNavigationRequest with lane/repo/
│   │   │                            # branch/event/offset scope; the app-root task
│   │   │                            # routes the request to Hub or Work, including
│   │   │                            # when it is already present at cold launch.
│   │   │                            # Linear issue links route in-app when a
│   │   │                            # project is open; lane/file/commit/artifact/
│   │   │                            # repo-branch, full PR, and projectless
│   │   │                            # Linear issue links post
│   │   │                            # .adeSendToMacRequested so SendToMacCard can
│   │   │                            # bounce the URL to a paired host via the
│   │   │                            # deeplinks.open sync command.
│   ├── Models/
│   │   └── RemoteModels.swift       # Codable structs mirroring shared types,
│   │                                # including legacy and dotted subagent
│   │                                # lifecycle chat events
│   ├── Resources/
│   │   ├── DatabaseBootstrap.sql    # generated from desktop kvDb.ts; carries
│   │   │                            # the replicated `terminal_sessions`
│   │   │                            # lifecycle columns for fresh installs
│   │   │                            # (Database.swift owns the matching
│   │   │                            # ensureColumn migrations for upgrades)
│   │   └── VoiceGlossary.json       # shared dictation cleanup glossary
│   ├── Services/
│   │   ├── AccountService.swift     # Clerk-backed optional account identity,
│   │   │                            # transferable social auth outcomes,
│   │   │                            # durable sign-out/device-ownership epochs,
│   │   │                            # serialized account push registration,
│   │   │                            # and exact pairing generations
│   │   ├── AccountEmailAuthFlow.swift # identifier-first email sign-in-or-up:
│   │   │                              # precise account-not-found fallback and
│   │   │                              # matching attempt verification
│   │   ├── AccountDirectory.swift   # account machine directory list/rename +
│   │   │                            # Attention relay clients
│   │   ├── Database.swift           # SQLite + pure-SQL CRR + offline caches
│   │   ├── KeychainService.swift    # per-host pairing secrets, stable device
│   │   │                            # identity, and SSH credential storage
│   │   ├── MobileTrustResetPolicy.swift # one-time connection-token/profile
│   │   │                                 # reset; preserves account + identity
│   │   ├── DpopKeyService.swift     # Secure Enclave P-256 key + signed
│   │   │                            # DPoP proof for every paired hello
│   │   ├── SSHBootstrapModels.swift, SSHBootstrapService.swift,
│   │   │   SSHCredentialStore.swift, SSHGeneratedKey.swift,
│   │   │   SSHHostFingerprintValidator.swift, SSHHostKeyPinStore.swift,
│   │   │   SSHPrivateKeyParser.swift # one-time SSH pairing bootstrap,
│   │   │                              # key handling, and host-key pinning
│   │   ├── PairingQrPayload.swift   # smart-URL QR parser (port of
│   │   │                            # shared/pairingQr.ts)
│   │   ├── PushNotificationService.swift # APNs registration, alert/deep-link
│   │   │                                 # handling, prefs, push.getStatus
│   │   ├── LiveActivityService.swift # ActivityKit start/update/end for the
│   │   │                             # account-wide "agent runs" activity
│   │   ├── MobileUsageQuotaStore.swift # host-scoped cached Claude/Codex
│   │   │                               # quota snapshot + refresh state
│   │   ├── SyncRecoveryPolicy.swift # deterministic reconnect, roam-trigger
│   │   │                            # policy (failover vs upgrade probe),
│   │   │                            # path-change, heartbeat-silence, and
│   │   │                            # timeout policy
│   │   ├── SyncConnectionRace.swift # one happy-eyeballs race over direct +
│   │   │                            # Relay candidates: stagger/budget/relay
│   │   │                            # join delay, relay accepted/ready
│   │   │                            # deadlines, coarse network fingerprint +
│   │   │                            # per-network route memory, endpoint
│   │   │                            # failure memory, relay dial single-flight
│   │   │                            # registry, and route truth
│   │   ├── SyncTerminalInputQueue.swift # bounded ordered terminal input,
│   │   │                                # ACK timeout/retry, stable input ids
│   │   ├── Dictation/               # SpeechDictationService,
│   │   │                            # DictationController, deterministic
│   │   │                            # cleanup, VoiceGlossary loader
│   │   └── SyncService.swift        # WebSocket client, command routing,
│   │                                # PIN + sealed account adoption,
│   │                                # scoped projection
│   │                                # revisions, lane presence, logical-offset
│   │                                # terminal snapshots, gap recovery,
│   │                                # reliable input/resize,
│   │                                # CLI launcher (startCliSession), chat push,
│   │                                # provider-aware scheduled-work cancel,
│   │                                # machine project browse/open/create/clone,
│   │                                # lane reparent stack-base override payloads,
│   │                                # Linear read/launch RPC wrappers, retained
│   │                                # background lane-deletion tasks + scoped
│   │                                # completion refresh, worktree
│   │                                # discovery, personal-chat cache/actions/
│   │                                # subscription routing, session.* lifecycle
│   │                                # (settle / override / snooze / wake /
│   │                                # clear-woke-marker) callers
│   ├── Shared/
│   │   ├── ADESharedContainer.swift # App Group UserDefaults + WorkspaceSnapshot helpers
│   │   ├── ADESharedModels.swift    # AgentSnapshot, PrSnapshot — shared with widgets
│   │   ├── ADESharedTheme.swift     # Provider color/icon table mirrored from desktop
│   │   ├── ADEAgentActivityAttributes.swift # account-wide ActivityKit
│   │   │                            # content-state + exact machine links +
│   │   │                            # non-PII ownership-epoch fence
│   │   ├── ActivityRowPresentation.swift # pure item → label/tone/glyph/elapsed
│   │   │                            # mapper; the iOS mirror of desktop
│   │   │                            #   sessionStatusPresentation.ts +
│   │   │                            #   activityPresentation.ts. No SwiftUI —
│   │   │                            #   tones are tokens. Compiles into the
│   │   │                            #   widget extension, so iOS 17 only.
│   │   ├── ActivityWidgetPresentation.swift # tone → colour binding and the
│   │   │                            # lock-screen ranking, shared by the app and
│   │   │                            #   the widget so the two cannot describe the
│   │   │                            #   same session differently. iOS 17 only.
│   │   └── AttentionActionIntents.swift # widget actions for approve/deny/restart/retry
│   ├── Views/
│   │   ├── Activity/                # ActivityDrawerSheet (global account-wide
│   │   │                            #   Sessions/Inbox drawer), ActivityDrawerModel
│   │   │                            #   (snapshot + local dismissals + acks),
│   │   │                            # ActivityRow, ActivityBellButton
│   │   ├── Account/                 # account choice/sign-in plus the mobile
│   │   │                            # access gate and connections section
│   │   ├── Components/              # ADEDesignSystem (incl. ADEConnectionDot,
│   │   │                            # ADEUIKitAppearance.configureTabBar(),
│   │   │                            # ADERootTabBarHiddenPreferenceKey),
│   │   │                            # MachineRowView (shared Mac row used by the
│   │   │                            #   Settings account/machines lists and the
│   │   │                            #   Hub quick-connect home; .row / .card looks),
│   │   │                            # haptics, ADEMobilePrimitives (incl.
│   │   │                            # ADEOptionButton for selection rows),
│   │   │                            # dictation mic, recording pill, global
│   │   │                            # dictation pill
│   │   │                            # — `ADEStreamingShimmer.swift` was retired
│   │   ├── Cto/                     # CtoRootScreen, CtoSessionDestinationView
│   │   ├── Hub/                     # HubScreen (all-projects roster home),
│   │   │                            # HubComponents (project/lane/chat cards,
│   │   │                            #   HubNoMachineState), HubQuickConnect
│   │   │                            #   (HubQuickConnectSection — one-tap connect
│   │   │                            #   cards for online account/paired machines
│   │   │                            #   on the no-machine home), HubComposerDrawer
│   │   │                            #   (HubInlineComposer — inline keyboard
│   │   │                            #   composer, not a modal drawer),
│   │   │                            # HubScreen+ChatNavigation (chat open +
│   │   │                            #   cross-project quick look),
│   │   │                            # HubLiveStrip ("Live now" — agents working
│   │   │                            #   across every account machine, read from
│   │   │                            #   ActivityDrawerModel; hidden when empty)
│   │   ├── PersonalChats/           # Hub-only projectless chat list,
│   │   │                            # new-chat model composer, and reused
│   │   │                            # Work transcript destination adapter
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
│   │   │                            # WorkUsageActivityCarousel (host quota
│   │   │                            #   limits + cross-client activity charts),
│   │   │                            # WorkImportSessionScreen +
│   │   │                            #   WorkExternalSessionAffordances
│   │   │                            #   (provider session browse/details,
│   │   │                            #   lane picker, Continue/Copy policy),
│   │   │                            # WorkLanePickerDropdown,
│   │   │                            # WorkChatRichCardViews (de-glassed
│   │   │                            #   tool-call / work-log / command /
│   │   │                            #   file-change transcript cards, inline
│   │   │                            #   subagent spawn/result/background-chip
│   │   │                            #   timeline rows, plus the unified Chat
│   │   │                            #   rich `ade_card` rows (duration,
│   │   │                            #   degraded/stale state, truncated counts,
│   │   │                            #   and failure-only mobile CI detail),
│   │   │                            #   Info sheet — ordered Subagents /
│   │   │                            #   Background / Schedule sections mirroring
│   │   │                            #   desktop — the subagent strip/badge, and
│   │   │                            #   the resolved-question card that collapses
│   │   │                            #   an answered question to a one-line
│   │   │                            #   "Answered · <choice>" / "Declined" row),
│   │   │                            # WorkPlanComposerViews (plan-approval
│   │   │                            #   strip + review sheet),
│   │   │                            # WorkComposerTypedTriggers (UITextView
│   │   │                            #   composer + cursor-relative /command
│   │   │                            #   & @file detection, inline suggestion
│   │   │                            #   strip, chip pills, smart-link detection,
│   │   │                            #   atomic deletion + Copy/Remove menus,
│   │   │                            #   deferred/coalesced
│   │   │                            #   UIKit focus transitions; replaced the
│   │   │                            #   WorkMentionsPickerSheet /
│   │   │                            #   WorkSlashCommandsSheet modals),
│   │   │                            # WorkChatAttachmentTray,
│   │   │                            # WorkChatComposerAndInputViews (compacted
│   │   │                            #   icon-only staged-steer strip + the
│   │   │                            #   structured-question card: pinned provider
│   │   │                            #   row / tab strip above and freeform +
│   │   │                            #   Send/Decline footer below a
│   │   │                            #   budget-capped internal scroll, plus
│   │   │                            #   WorkPendingInputHeightBoundedCard for the
│   │   │                            #   non-question gates),
│   │   │                            # WorkDraftPersistence (WorkComposerDraftStore
│   │   │                            #   per-chat/Hub/New-Chat composer text +
│   │   │                            #   WorkQuestionDraftStore per-request
│   │   │                            #   selections, over App Group UserDefaults;
│   │   │                            #   debounced autosave + workPersistedDraft
│   │   │                            #   view modifier),
│   │   │                            # WorkArtifactTerminalViews (minimal
│   │   │                            #   collapsed in-thread proof row with a
│   │   │                            #   44pt target, compact thumbnail/status,
│   │   │                            #   expandable preview, and a friendly
│   │   │                            #   unavailable fallback),
│   │   │                            # TerminalSessionScreen + SwiftTermSessionView
│   │   │                            #   (full-screen SwiftTerm terminal,
│   │   │                            #   offset resume/history paging +
│   │   │                            #   viewport reporter),
│   │   │                            # WorkSessionDestination*,
│   │   │                            # WorkRootScreen+Selection (multi-select state +
│   │   │                            #   bulk close/archive/restore/delete/export),
│   │   │                            # WorkSelectionActionBar,
│   │   │                            # WorkLaneOrder (pure lane ordering + the
│   │   │                            #   singleton/headerless rule; the port of
│   │   │                            #   desktop workLaneOrder.ts and the
│   │   │                            #   headerlessLaneIds memo. Models manual
│   │   │                            #   drag and handoff jobs even though iOS
│   │   │                            #   has neither yet — they are the two rules
│   │   │                            #   that decide whether a lane keeps its
│   │   │                            #   header, and dropping them is how a port
│   │   │                            #   silently loses a rule later), etc.
│   │   ├── Linear/                  # LinearPaneSheet, issue list/detail screens,
│   │   │                            # launch config, brand/logo paths, pane store
│   │   │                            # and toolbar button. Uses existing cto.* read
│   │   │                            # RPCs plus lane/chat/CLI launch primitives.
│   │   │                            # LinearConnectionScreen (gear → connect via
│   │   │                            #   OAuth/API key, reconnect, disconnect;
│   │   │                            #   shared LinearConnectActions on the
│   │   │                            #   disconnected pane) +
│   │   │                            # LinearOAuthRunner (worker-bounce OAuth via
│   │   │                            #   ASWebAuthenticationSession, ade:// capture),
│   │   │                            #   all gated on supportsRemoteAction.
│   │   ├── PRs/                     # PrsRootScreen, PrDetailScreen
│   │   │                            #   (PrDetailView — Overview emitted as
│   │   │                            #   sibling List rows, not a monolith),
│   │   │                            # PrDetailActivityTab (timeline builder +
│   │   │                            #   commit-group folding), PrDetailOverviewTab,
│   │   │                            # PrDetailHeaderComponents (compact summary,
│   │   │                            #   collapsible unmapped notice, description),
│   │   │                            # PrGitHubDescriptionParser (safe embedded
│   │   │                            #   HTML → Markdown/native disclosures),
│   │   │                            # PrMergeGateCard (PrGlassPalette tokens),
│   │   │                            # PrHelpers, PrModels, PrRowCard,
│   │   │                            # PrListRowModifier,
│   │   │                            # PrWorkflowCards, PrStackSheet,
│   │   │                            # CreatePrWizardView, PrRebaseScreen,
│   │   │                            # PrTargetBranchPickerDropdown,
│   │   │                            # PrDetailOverviewPreviews (preview fixtures)
│   │   ├── Settings/                # ConnectionSettingsView (account card →
│   │   │                            #   connection status → machines list → ways
│   │   │                            #   to add one), SettingsMachinesSection
│   │   │                            #   (reachable-machine list: top 3 + See all),
│   │   │                            # SettingsMachineRenameSheet (account-wide
│   │   │                            #   custom name set/clear),
│   │   │                            # SettingsPairingSection,
│   │   │                            # SettingsPairingScannerSheet (camera QR
│   │   │                            #   scanner),
│   │   │                            # SettingsConnectionHeader,
│   │   │                            #   host compatibility warning banner,
│   │   │                            #   full usage limits + refresh section,
│   │   │                            # SettingsPinSheet, SettingsPushDeliverySection
│   │   │                            #   (push + Live Activity diagnostics/toggles),
│   │   │                            # SSHPairingView + view model/state
│   │   │                            #   — SettingsVoiceInputSection and
│   │   │                            #   SettingsAnalyticsSection were removed
│   │   │                            #   (analytics is default-on; dictation has
│   │   │                            #   no settings panel)
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
    ├── AccountEmailAuthFlowTests.swift # returning email sign-in, new-email
    │                                   # sign-up fallback, exact error codes
    ├── PairingAndDpopTests.swift    # smart-URL QR parse + DPoP proof tests
    ├── PrMergeMergeStateTests.swift # PR merge state, history/count decoding,
    │                                # reconciliation, partial-detail retention
    ├── SSHBootstrapTests.swift      # key parsing, fingerprint, bootstrap policy
    ├── SyncEnvelopeChunkAssemblerTests.swift # bidirectional frame budget,
    │                                          # reassembly bounds/expiry,
    │                                          # compression + version matrices
    ├── SyncRecoveryPolicyTests.swift # reconnect/backoff, path-change, and
    │                                 # roam-trigger (failover vs upgrade) policy
    ├── SyncTransportSelectionTests.swift # single-race candidate plan, relay
    │                                     # join delay, network fingerprint +
    │                                     # route memory, endpoint failure
    │                                     # memory, relay dial single-flight
    └── WorkSessionCanonicalStateTests.swift # settle-override / snooze / filing
                                     # parity against the shared TS derivation
```

Each tab is factored into a root screen, one `+Actions` extension for
side-effecting work, and several helper modules (timeline, markdown
parsing, model catalog, session grouping) to keep individual files
under a few hundred lines. This split is the primary reason the Work
tab grew from one ~3,000-line file to ~30 focused files.

The Work model/activity parity path is concentrated in these files:

- `ADE/Models/RemoteModels.swift` — tolerant chat-event decoding, MCP app/tool
  source metadata, image events/omission metadata, Codex recovery DTOs, the
  `web_search` event's structured `CodexWebSearchResult` hits (`results` decoded
  through `ADELossyArray` so one malformed hit can't fail the event, plus
  `resultsTotal`), `MobileUsageQuotaSnapshot.spendControlReached` (Codex spending
  cap), Claude context lifecycle states, queue-aware Stop request DTOs, and
  host model rows including `defaultReasoningEffort`.
- `ADE/Views/Work/WorkModelCatalog.swift` and `WorkModelPickerSheet.swift` —
  host-first model catalog merge, GPT-5.6 ordering/defaults/visible tiers, Fast,
  and the Ultra usage warning.
- `ADE/Views/Work/WorkEventMapping.swift`, `WorkTranscriptParser.swift`,
  `WorkModels.swift`, `WorkTimelineHelpers.swift`, and
  `WorkStatusAndFormattingHelpers.swift` — compact web/MCP/image mapping for
  both live Codable events and persisted JSONL fallback (including Codex
  structured web-search `results`, threaded onto the tool card's `Sources` chips
  and deduped against the action URLs), plus the Work context meter's
  provider-neutral measured/compacting/recalculating/unknown reduction across
  live and persisted history. The Codex spending
  cap surfaces as a "Spending cap reached" note under the Codex row in
  `WorkUsageActivityCarousel`.
- `ADE/Services/SyncService.swift`, `ADE/Views/Work/WorkSessionDestinationView.swift`,
  and `WorkSessionDestinationView+Actions.swift` — host-advertised chat action
  dispatch, including provider-neutral `chat.recoverTurn` (with the legacy
  Codex action as a compatibility fallback), durable
  `chat.resolveUnprocessedMessage`, the additive
  `chat.interruptWithQueueMode` capability with legacy `chat.interrupt`
  fallback, and the non-queueable `chat.cancelScheduledWork` wrapper used by
  Chat Info.

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
| `disconnected` | (n/a) | muted |

The dot is placed in the top-leading `ToolbarItem` of every top-level
tab (Lanes, Files, Work, PRs) and every deep screen
(`LaneDetailScreen`, `PrDetailView`, `WorkSessionDestinationView`,
`WorkNewChatScreen`, `FilesDirectoryScreen`; `FilesDetailScreen`
hosts it alongside its back-button affordance). It replaces the
older `ADEConnectionPill` and the per-tab "connection notice" banner
cards — controllers no longer ship duplicate offline / reconnect /
hydrating cards inside each screen body.

The Work root top bar also places a Settings gear immediately to the right of
the notification bell. It opens the same `ConnectionSettingsView` sheet as the
Hub connection affordance and is hidden while Work is in multi-select mode.

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

The connected Hub top bar uses the same health value. `HubConnectionPill`
renders the account custom name when available and, only after an authenticated
connection, a compact observed-route line: `via LAN`, `via Tailscale`, or
`via ADE Relay`. `SettingsConnectionHeader` shows the same route text beside
**Connected**. Both read `lastConnectedRouteKind`, which is updated when
roaming replaces the winning socket, so the badge describes the route actually
in use rather than the best route the directory advertised. Connecting,
unreachable, and disconnected states never retain a stale transport badge.
The Hub top bar gives this pill layout priority immediately after the fixed ADE
mark; the add, Settings, and Chats controls remain fixed-size trailing buttons.

### Machine naming and reachability

Account directory records keep the publisher's `name` and the account-owned
`customName` as separate fields. `AccountMachine.displayName` applies the one
display rule everywhere: non-empty custom name, then reported hostname, then a
platform/generic fallback. The Settings machine row exposes a 44-point pencil
button and `SettingsMachineRenameSheet`; **Use hostname** clears `customName`
instead of copying the hostname into it. `AccountService` updates the in-memory
directory record after the authenticated PATCH, so the machine rows, connection
header, and Hub pill refresh without reconnecting.

Primary machine rows state only facts they can prove:

- the active authenticated socket is **Connected**;
- a current directory/discovery lease is **Online**;
- otherwise the row says **Last seen just now**, **Last seen Nm/Nh/Nd ago**, or
  **Last seen unknown**.

The `online` heartbeat never earns connected styling, and an expired heartbeat
never becomes a claim that the Mac is powered off. Route names stay out of these
reachability lines; observed transport belongs in the connected badge and
Connection details.

### Tailscale-off route hint

Connection surfaces show an "iPhone isn't on Tailscale" warning card
(`ADETailscaleOffHintCard` in `ADEDesignSystem.swift`) when the one
user action that can fix the connection is turning Tailscale on. The
card is not shown when the phone has a saved ADE relay route, because
relay is a valid automatic route and Tailscale is then only a
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

**Every column desktop can write must exist here.** Replicated tables are
column-additive on the desktop side (`safeAddColumn` in `kvDb.ts`), and a
changeset naming a column the phone does not know about fails to apply *on the
phone* — which nacks the whole batch and freezes sync for that device until an
app update ships. `Database.swift` therefore mirrors each replicated column with
an `ensureColumn` call, nullable and without a unique index (`crsql_as_crr`
rejects non-PK unique indices), whether or not any Swift view reads it. The
`pull_requests` block is the worked example: it mirrors the detach and merge
metadata columns alongside `merge_conflicts` / `behind_base_by`, which desktop
had been writing since the merge-conflict work without a phone-side counterpart.

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

Sources: `apps/ios/ADE/Services/SyncService.swift` and
`apps/ios/ADE/Services/SyncRecoveryPolicy.swift`.

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
   or fallback-port sweep; they are ranked as whole routes instead.
   Direct and Relay candidates then enter **one** authenticated
   happy-eyeballs race rather than sequential per-transport phases. Transport
   class still orders the plan (`lan` < `tailnet` < `relay`), so a usable LAN
   route is dialed first and normally wins outright; a Relay candidate that
   does not lead the ranking joins the race ~300 ms behind the leading direct
   candidate, and a Relay candidate that *does* lead — because it is the proven
   route for this network — is dialed at t=0. That is what makes an off-LAN
   reconnect as fast as an on-LAN one, instead of paying out the direct budget
   on candidates that cannot succeed. A phone with Tailscale
   disabled skips ineligible tailnet routes. Pairing and ordinary reconnect
   share this policy, so the route order does not change after a pairing code
   succeeds. Candidates in the opening wave start
   250 ms apart, at most three sockets are open at once, the whole race has a
   10-second budget, and only a completed `hello_ok` can win. The opening wave
   covers the best candidate plus transport/route diversity, and each failure
   admits the next ranked route. Every socket in the wave sends the same monotonic
   `peer.connectionAttempt` metadata; the host rejects a late losing socket as
   superseded instead of letting it replace the winner.
   Relay routes arrive from the pairing QR and — for already-paired
   phones — from `hello_ok` /
   `brain_status`'s `cloudRelayWssUrl`, persisted into the host
   profile's `savedRelayCandidates` (an explicit `cloudRelayWssUrl:
   null` in `brain_status` means the host is not currently advertising Relay,
   normally because it is signed out or its account lease is unavailable, and
   the phone clears its saved relay routes).
   Relay candidates are eligible only when the profile's verified
   `relayAccountOwnerId` matches the currently signed-in account. ADE fetches a
   fresh account token in memory for every Relay attempt and adds it only to the
   paired hello. Missing/different account state reports a clear sign-in or
   same-account requirement without consuming the reconnect retry budget; LAN
   and Tailscale attempts remain available. A host-issued paired secret remains
   direct-route trust after account loss; forgetting the machine is the action
   that removes the profile and Keychain secret.
   The primary Settings status stays route-neutral (for example, "Connected in
   0.3s"); the host-observed LAN/Tailscale/relay route remains available in the
   diagnostics row for troubleshooting. `reconnectIfPossible` is the single
   connection-attempt owner: socket delegate failures, path changes,
   foreground return, heartbeat silence, and failed liveness probes all
   converge there. Overlapping wake-ups are coalesced, delayed path tasks carry
   a connection-generation guard, and an automatic reconnect never tears down
   an already-live connection. The socket declares the
   `chunkedEnvelopes` capability, offers zlib-wrapped `deflate` in
   `hello.compression`, and sets a 32 MiB `maximumMessageSize` receive
   budget. The phone does not use either new wire behavior until the host
   confirms it in `hello_ok`, so an older host stays on the exact legacy path.
   Relay candidates first append `ready=2`. A new Worker sends `accepted/v2`
   before bridge setup and `ready/v2` only after both pipe and validated local
   listener exist; iOS sends no ADE hello before `ready`. The two frames carry
   separate deadlines because they mean different things. `accepted` is served
   the instant `/connect` is, so 350 ms of silence genuinely suggests a relay
   that predates v2; `ready` waits on a hibernating Durable Object waking,
   signaling the host, and dialing the host's local port, and so gets 7 seconds
   once `accepted` has arrived. A silent `accepted` window earns one retry of
   the same endpoint on a fresh legacy URL, but only for an endpoint that has
   never completed a `?ready=2` handshake (`negotiatedReadyV2` on its saved
   endpoint state); on an endpoint known to speak ready-v2 the silence is a
   fault, and redialing would only burn a second tunnel slot against the Durable
   Object's connection cap. A relay that accepts and then never bridges fails
   *inside* the race, so the endpoint accumulates the failure and frees its
   concurrency slot. iOS never downgrades a `ready=2` socket in place.
   The Clerk account token a Relay hello needs is fetched concurrently with the
   WebSocket upgrade (`async let`) rather than after it, and a single-flight
   registry keyed by `<relay host>/<machineKey>` refuses a second simultaneous
   `/connect` dial for the same machine — two tunnels on one Durable Object
   consume its 16-connection cap and the orphan is only swept minutes later, so
   the second dial is turned away instead of being recorded as an endpoint
   failure. Foregrounding with a relay-capable machine and no live connection
   warms the Clerk session ahead of the imminent dial.
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
   `hello_ok.connectionTransport` is the host-observed post-authentication
   `direct | relay` result. Connection diagnostics and Relay policy use that
   value when present instead of trusting how the candidate URL was labelled.
   A current host also returns
   `compression: { codec: "deflate", thresholdBytes: 512 }` when it accepted
   the offer, and
   `features.chunkedEnvelopes: { enabled: true, maxFrameBytes: 737280 }` when
   it accepted bidirectional chunk framing. The selection-bearing `hello_ok`
   itself remains on the legacy encoder; selected behavior starts with later
   envelopes.
4. If no active project is selected, show the Hub (all-projects roster
   home) instead of hydrating lane/file/PR surfaces against the wrong row.
   The Hub subscribes to the roster feed (`roster_subscribe`) to render
   every project's chats-by-lane without activating each project. For the
   active project, that same lightweight roster is also a display bridge for
   newly created lanes/chats that arrive before the project CRR replica: Hub
   navigation and the Work list can render and subscribe immediately, while
   richer local rows replace the temporary projection by id when they land.
   Persisted roster snapshots are keyed by stable machine identity. Switching
   Macs clears the in-memory sequence/support state and loads only that Mac's
   cache; the legacy unscoped cache is discarded so identical project paths on
   two machines cannot leak stale session rows across connections.
5. After the active project row exists locally, receive catchup
   changesets and hydrate lane, file, Work, and PR projections scoped
   to that project. Initial lane and Work hydration run concurrently and
   jointly gate the first usable project surface; PR hydration runs alongside
   them but does not delay first paint. Foreground recovery likewise overlaps
   lane-presence restore, project-catalog refresh, and the three projection
   refreshes instead of paying five serial round trips. A manual Work refresh
   preserves the database's lane
   integrity boundary by fetching a lightweight lane snapshot before installing
   any session snapshot that references a lane missing locally. Every async
   hydration request captures its connection + project selection scope, sends
   that scope explicitly to the host, and revalidates it before status,
   signature, or SQLite mutation. Database replacement also rejects an
   expected-project mismatch as a final guard against late responses after a
   project switch. The guarded replacement paths cover lane lists, lane detail,
   Work sessions, PR snapshots, and the Files workspace catalog. Overlapping
   refreshes are tracked as separate domain attempts: cancelling a stale
   attempt restores the prior or newer completed status instead of leaving the
   domain stuck in `hydrating` or overwriting a newer result.
6. Enter continuous bidirectional sync. Inbound processing runs off
   the main actor: envelope JSON parse, gzip/deflate decompression, payload JSON parse,
   chunked-envelope reassembly, and changeset decode + apply all run
   in detached tasks (the SQLite connection is FULLMUTEX). The receive
   loop awaits frames in order, so application order is unchanged —
   the UI just never freezes under sync load.
   Phone-originated changesets are persisted as one pending batch and the
   outbound cursor advances only on a successful ack. Ack timeout/NACK retries
   the same batch; exhausting the retry budget re-exports from the unchanged
   cursor with a smaller 64-row/64-KB window (down to one row/4 KB) after a
   bounded 1–30 second backoff. A reconnect/project switch reloads the durable
   pending batch rather than skipping unconfirmed phone writes.
7. On transport disconnect: run a finite seven-attempt fast burst with
   1 s -> 16 s exponential backoff and jitter. During that window the
   connection health remains `connecting`, cached chat content stays mounted,
   and the composer reports that the draft is safe. Exhausting the burst moves
   the UI to `unreachable`, but an indefinite quiet 30-40 s heartbeat keeps
   trying one route budget at a time. A paired machine that comes back minutes
   later therefore reconnects without navigation or a user tap. A successful
   hello restores the active project, chat and terminal subscriptions, tracked
   lane presence, and pending safe operations without rebuilding the current
   navigation stack. A user-initiated machine transition from Settings first
   presents the Hub, then disconnects, reconnects, pairs, or adopts the selected
   machine. The cached active project can remain available for recovery, but no
   in-project screen keeps rendering state owned by the previous machine.
   Disconnects (including the connecting-state Cancel button) also cancel
   scheduled reconnect work and leave the phone disconnected until the user
   reconnects or pairs again. Ordinary transport recovery does not force Hub
   navigation. If iOS reclaims the app, a project route used within the last
   24 hours restores optimistically on launch, including the selected root pane
   and an open Work chat; reconnect and hydration continue underneath the
   existing connection affordance. An explicit trip back to Hub, sign-out, or
   machine removal clears the marker.
8. After pairing completes, the phone announces currently-open lanes
   via `lanes.presence.announce` so the runtime decorates
   `LaneSummary.devicesOpen` for other controllers; the phone calls
   `lanes.presence.release` when the user leaves a lane surface and
   re-announces on a 30 s heartbeat (runtime-side TTL is 60 s).

### Route ranking, route memory, and roaming

Sources: `apps/ios/ADE/Services/SyncConnectionRace.swift` (candidate ranking
constants, the network fingerprint, per-network route memory, endpoint failure
memory, and the relay dial registry) and
`apps/ios/ADE/Services/SyncRecoveryPolicy.swift` (the roam-trigger policy).

`syncRankedEndpointAttempts` orders the vetted candidate set by, in priority
order: not demoted, backed by live discovery, transport class
(`lan` < `tailnet` < `relay`), then most recent success. Two memories are then
hoisted in front of that ranking. `syncEndpointAttemptsHoisting` only
**reorders** the vetted list — it never synthesizes a candidate — so a route
that address policy or relay-account eligibility already rejected cannot
re-enter through the front door:

- **`networkRouteMemory`** (on `HostConnectionProfile`, persisted in iOS
  `UserDefaults` under `ade.sync.hostProfile`) maps a coarse network
  fingerprint to the endpoint that last authenticated on that network,
  most-recently-used first and capped at eight entries. The fingerprint is
  `wired`, `wifi:<the phone's own IPv4 /24>`, or `cell`; the /24 is read off an
  `en*` interface, which separates home, office, and hotspot well enough for
  "which route worked here" without the entitlement an SSID lookup would need.
  The endpoint remembered for the current network leads the plan.
- **`lastSuccessfulAddress`** is the global last-good and sits directly behind
  the per-network memory, which outranks it because the global value may belong
  to an entirely different network.

Two things demote a candidate to the back of the plan. Demotion never removes a
route, so one that recovers is still tried on every connect:

- **Failure memory.** Each `HostConnectionEndpointState` carries `lastFailedAt`
  and `consecutiveFailures`. Two or more consecutive failures inside 120 seconds
  schedule that endpoint last; a success clears the streak. Only failures that
  say something about the *route* count — a cancelled or superseded attempt, a
  dial turned away by the relay single-flight registry, a missing account
  credential, and a missing pinned relay key are facts about this attempt or
  this device, and leave the endpoint's record untouched.
- **Path implausibility.** On a path with no Wi-Fi or wired interface, RFC1918
  addresses, `.local` mDNS names, and IPv6 link-local / unique-local candidates
  cannot succeed, and each one raced eagerly costs a full socket-open timeout,
  so they move to the back. Tailnet CGNAT and loopback do not — Tailscale works
  over cellular, and loopback is the simulator's own route.

**Roaming.** A healthy connection is re-raced only for a reason, and the race is
make-before-break: the live socket keeps serving traffic and is replaced only
after a replacement candidate has authenticated. `syncRoamTrigger` recognizes
exactly two reasons:

- **Failover** — the interface set itself changed
  (`syncNetworkPathInterfacesChanged` compares satisfied / Wi-Fi / cellular /
  wired). The route in use may be gone, so every candidate is raced, behind only
  a 3-second floor that absorbs the burst of `NWPathMonitor` updates a single
  physical change produces.
- **Upgrade probe** — nothing changed, but a strictly better transport class
  looks reachable: a live Bonjour hit on a local-link path for LAN, or this
  phone actually holding a tailnet address for a machine with a saved tailnet
  route. At most one quiet attempt every 5 minutes, restricted to classes
  strictly better than the one in use, and only for a connection at least
  10 seconds old. New discovery results also run this evaluation, because a
  phone on stable Wi-Fi can go hours without a path update.

Standing facts are deliberately not triggers. "On cellular with a saved tailnet
route" stays true forever, so treating it as one turned every path-monitor
twitch into a full race that tore down a working socket. A race that wins on the
endpoint already in use likewise keeps the live socket rather than swapping to
an identical route. Roams own a task separate from the scheduled path reconnect,
so the follow-up path update for one physical change — which reports no
interface change — cannot cancel the failover that change just scheduled.

### Message types

Implemented envelope types on iOS:

| Type | Direction | Purpose |
|---|---|---|
| `hello` / `hello_ok` / `hello_error` | Bidirectional | Handshake |
| `account_challenge` / `account_challenge_ok` / `account_challenge_error` | Phone → runtime / runtime → phone | Signed X25519 challenge and AEAD negotiation before sealed same-account adoption |
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
| `changeset_batch` | Bidirectional | cr-sqlite changeset batch; a far-behind ACK- and chunk-capable phone may receive the host's compact current-state catch-up through this existing envelope (no new Swift Codable type) |
| `changeset_ack` | Bidirectional | Per-batch apply confirmation (or error code); the sender retransmits on timeout |
| `command` | Phone → runtime | Execution request |
| `command_ack` | Runtime → phone | Command receipt |
| `command_result` | Runtime → phone | Execution result or error |
| `file_request` / `file_response` | Bidirectional | On-demand file access |
| `terminal_subscribe` / `terminal_unsubscribe` / `terminal_data` | Phone ↔ runtime | Terminal streaming; `unsubscribe` is sent when a Work terminal screen disappears so the phone stops accumulating buffer for off-screen sessions. `terminal_data.offset` is the lifetime logical UTF-8 end offset (null only for untracked/no-transcript or failed-write streams), so physical transcript rollover does not rewind it. The phone drops duplicates, trims UTF-8 overlap, and on a gap launches one guarded resubscribe from its watermark instead of rendering out of order. `terminal_subscribe.sinceOffset` returns an append-only `delta: true` snapshot when the retained logical window still covers the request; otherwise a full snapshot replaces local state even when its end offset equals the watermark. The host's bounded snapshot barrier queues live data/exits during capture and recaptures rather than flushing a gap. Snapshots also report `startOffset`/`endOffset`, plus `live: false` when no PTY backs the session so the phone shows a resume bar instead of accepting keystrokes |
| `terminal_history` | Phone → runtime | On-demand scrollback paging: `{ sessionId, beforeOffset, maxBytes? }` returns retained transcript bytes `[startOffset, endOffset)` ending at/before `beforeOffset` (page start scanned forward to a newline/ESC and UTF-8 boundary; `atStart: true` means the oldest **retained logical offset**, which may be greater than zero after rollover). Requires an active `terminal_subscribe` |
| `terminal_input` / `terminal_input_ack` / `terminal_resize` | Phone ↔ runtime | Input is queued in order only after the terminal snapshot is ready. ACK-capable hosts receive a stable `inputId`; the phone sends one item at a time, waits 8 seconds, and retries with 0.5/1/2-second backoff within the host-advertised lease (four total attempts). The host dedupes `(device, session, inputId)` before writing, so a lost ack cannot type twice. `not_subscribed` is the only retryable rejection: iOS re-subscribes through the snapshot barrier and resends the same id. Other errors fail that item and continue the queue. Legacy hosts receive one-shot input without an id or ambiguous retry. Mobile resizes are non-authoritative: the runtime restores the last desktop size when the final phone detaches |
| `chat_subscribe` / `chat_event` / `chat_history` | Phone → runtime / runtime → phone | Agent chat transcript streaming and cursor-paged scrollback. `chat_subscribe` carries `sinceSeq` so the runtime can replay exactly the missed events from its per-session buffer instead of re-sending a snapshot. Explicit full-snapshot subscribes omit `sinceSeq`; rapid duplicates are coalesced for five seconds or until the snapshot ack arrives. A full-snapshot request starts a five-second acknowledgement watchdog; unanswered requests are resent twice regardless of project scope, then the chat renders an explicit error with Retry instead of an empty transcript. The initial tail is capped at 256 KiB and the ack carries `cursorKind: "byte"`, `tailStartOffset`, and `hasOlderHistory`; near-top scroll requests continuous 256 KiB `chat_history` pages against the existing subscription until the transcript head, preserving the visible scroll anchor as pages prepend. Ordinary project-chat subscriptions stay warm for 120 seconds after leaving a detail screen (at most four pending inactive chats), and reopening synchronously cancels eviction even while offline. Personal and cross-project scopes still unsubscribe immediately so their routing scope can be cleared safely. The subscribe ack carries `turnActive` from the live agent chat service so a phone subscribing mid-turn renders the stop button and working indicator immediately — the byte-capped snapshot tail may have dropped the turn's `status: started` event, and the synced session row arrives via the slower changeset pump. The phone keeps the hint current from live `status` / `done` events, drops it when a full ack omits the flag (older host / no live summary), and clears it on project switch / reconnect resets. Incoming chat events bump a UI revision through a leading-edge coalescer (~150 ms window: the first event after a quiet period renders immediately, bursts batch); turn-state flips bypass the coalescer entirely so the stop button reacts instantly. On strained relay connections, the Work detail view stays subscribed to `chat_event` but skips heavyweight `chat.getChatEventHistory` and fallback transcript fetches while the turn is active; idle refresh reconciles the canonical transcript. Cross-project transcript scope remains an additive protocol capability for controller reads, but Hub navigation always activates the tapped chat's owning project before opening it. A `session_meta_updated` `chat_event` carrying a client's permission/interaction/mode change is folded into the cached summary via `applyChatSessionMetaModeUpdateIfNeeded` (decoded through `AgentChatSessionMetaModeUpdate`, a lenient all-optional-string type that no-ops for the bare title/manuallyNamed events older hosts send), so the open composer's mode pill updates live without a refetch |
| `chat_subscribe` with `chatScope: "personal"` | Phone → runtime / runtime → phone | Explicit projectless transcript/event subscription. `SyncService` marks the session personal, omits project id/root, routes send/steer/approval/update/lifecycle and scheduled-work Cancel/Pause calls to `personalChats.*`, and loads image bytes through `personalChats.getImageDataUrl`. Missing project scope alone never selects this path. |
| `roster_subscribe` / `roster_unsubscribe` / `roster_snapshot` / `roster_delta` | Phone → runtime / runtime → phone | All-projects session roster feed backing the Hub: agent chats, their attached shell rows, and standalone CLI (tracked terminal) sessions — live **and** ended. Subscribe (optionally with `sinceSeq`) yields a full `roster_snapshot` then incremental `roster_delta` upserts (`changed` = whole project entries) / `removed` project ids. Un-booted projects carry disk-derived status only (a booted scope also overlays PTY liveness for CLI rows); transcripts load on demand when a chat opens. Additive lifecycle fields carry `settledAt`, `statusNote`, `attentionRequestedAt`, `attentionMessage`, `lastTurnFailedAt`, and `exitCode`; disk readers return nulls against legacy databases that do not have those columns. `toolType` passes through so the phone routes chat rows to the chat surface and CLI rows to the terminal — a CLI row must never take the cross-project chat quick-look (it has no chat JSONL and would render blank) |
| `envelope_chunk` | Bidirectional after negotiation | Slice of an oversized encoded envelope (>720 KiB). The phone sends chunks only after `hello_ok.features.chunkedEnvelopes.enabled`; both sides reassemble by `chunkId`/`index` before normal decompression/decode. `SyncEnvelopeChunkAssembler` allows at most eight sets / 512 parts, a 128-byte id, and 32 MiB aggregate decoded buffering; it rejects inconsistent totals and expires incomplete sets after 30 seconds |
| `heartbeat` | Bidirectional | Connection health (30s) |
| `brain_status` | Runtime → phone | Legacy-named cluster authority broadcast |

Protocol types are additive within the supported integer version interval. The
phone decodes the common envelope and its string `type`, then ignores types it
does not implement. In particular, desktop-only `rpc_*` and `fwd_*` envelopes
do not fail or disconnect an iOS client. `hello_ok.features` is also read
additively: missing flags resolve to unsupported/limited behavior, so an older
host or a newer host advertising desktop-only flags does not break the mobile
handshake. A version outside the interval is not additive: it produces
`SyncProtocolVersionMismatchError` and update-targeted UI rather than a silent
drop.

Compression uses the shipped system `zlib` module for both zlib-wrapped
deflate and legacy gzip. A phone offers only `deflate`; after the host selects
it, payloads of at least 512 bytes are
deflated and base64-encoded in both directions. When the host omits the
selection, iOS keeps its legacy gzip-at-4-KiB behavior byte-for-byte. No codec
dependency or static dictionary is added. `unwrapSyncCommandResponse` turns a
raw response dict into either the `result` value or throws an `NSError` with
`ADEErrorCode` when `ok: false`.

### Offline behavior

- All synced state is available offline from the local DB.
- Execution commands queue locally and replay on reconnect. Queueable commands
  normally also enter the local queue when a send times out while the WebSocket
  still appears connected; the phone keeps the same `commandId` and probes the
  transport instead of dropping the user's action. The runtime deduplicates
  retried commands by `commandId` through a TTL'd cache + persisted journal, so
  a replay returns the cached `command_ack` / `command_result` instead of
  running twice. An attempted live `chat.send` is the exception: its outcome is
  ambiguous, so iOS restores the draft for manual retry rather than enqueueing
  an automatic replay that could duplicate a turn.
- Project-scoped lane, Work, and PR commands carry their chosen project id/root
  in both the live command payload and any pending-operation record. Replay uses
  that stored scope rather than the project active at drain time, so a project
  switch cannot retarget a mutation. Command envelopes can therefore drain as
  soon as their host reconnects, including foreign-project chat commands; file
  operations still wait for their project to be active because `file_request`
  has no cross-project command router.
- A `command_result` with `error.code: "host_unavailable"` (the brain-level
  ingress answering while the project sync host is restarting — see
  `remote-commands.md`) is treated exactly like a timeout, never like an
  application rejection: `isSyncHostUnavailableError` makes it retryable, and
  the queue-drain loop **keeps** a pending operation that hits it so queued work
  survives host restarts instead of being deleted on replay. The same
  attempted-live-chat exception applies here: preserve the draft instead of
  creating a new queued replay after the host may already have started it.
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
  the pending snapshot is removed. The queued create contains only the empty
  session; its separate opening prompt and attachments remain in the composer
  and are not sent automatically after reconnect.
- UI shows "pending sync" indicators for queued actions.

### Timeouts

`SyncRequestTimeout.defaultTimeoutNanoseconds = 30_000_000_000` (30s).
Timed-out requests throw with the message *"The machine took too long to
respond. Try again."* `chat.send` uses an extended budget
`SyncRequestTimeout.chatSendTimeoutNanoseconds = 120_000_000_000` (120s)
with the ambiguity-safe message *"ADE couldn't confirm whether this message
started. Your draft was restored; check the transcript before sending
again."* Warmup-heavy turns can outlast the 30 s default without indicating a
transport failure, and a missing `command_result` does not prove the host
failed to start the turn.

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
(`verifyTransportAliveAfterSilence` — ping the host and wait 5 s on an
ordinary path, 8 s on an expensive path, or 12 s on a constrained path for any
inbound traffic). Heartbeat silence uses the same coalesced probe, and only a
probe that hears nothing back triggers the normal transport-failure teardown.
This avoids
cycling a healthy-but-slow connection (catalog/PR refreshes can take
30 s+ on cellular) into a perpetual timeout→reconnect→re-request
loop.

Terminal input has a separate ambiguity-safe timeout. On hosts advertising
`terminalInputAck`, iOS retains the exact `inputId`, allows only one in-flight
item per session, and after 8 seconds retries within the advertised
`retryWindowMs` (normally 60 seconds) for at most four attempts. Reconnect
marks in-flight items unsent and waits for the terminal snapshot subscription
to be ready before replay. If the attempt/window budget expires, iOS reports
that delivery could not be confirmed and removes the item instead of typing it
again forever. Older hosts receive a single unacknowledged write and are never
automatically retried after an ambiguous outcome.

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

1. User opens the **This Mac** card in the machine's Connections panel and sets
   or generates a 6-digit PIN. The runtime writes a PBKDF2 hash under `~/.ade/secrets`
   (chmod `0600`) and keeps the plaintext in process memory only while
   that runtime is alive, so a restarted machine can still verify
   pairings but cannot display/copy the digits.
2. Phone opens Settings > Pairing and either scans the machine QR
   (`SettingsPairingScannerSheet` → `PairingQrPayload.parse`, a v3 smart
   URL carrying machine identity, port, and address candidates — never a
   pairing code) or discovers the machine on the network, then types the same
   PIN the user set. The smart URL is internal QR wire encoding for the system
   camera / App Clip, not a user-facing link. The payload may carry an additive
   `pinConfigured` Boolean (`PairingQrPayload.pinConfigured`): when it is
   `false` the host has no PIN set yet, so the phone can point the user at the
   generate-a-PIN step on the **This Mac** card instead of a PIN prompt that
   could only fail. A `nil` hint means the QR came from an older host and the
   phone falls back to the live handshake result.
3. Phone sends a `pairing_request` envelope with the PIN. The runtime's
   `syncPairingStore.pairPeer` validates against `syncPinStore`; the
   failure codes are `invalid_pin`, `pin_not_set`, or `pairing_failed`. The
   `pinConfigured` hint is advisory only — a host whose PIN was cleared after
   the QR was minted still answers `pin_not_set` at pairing time, and that live
   result wins.
4. On success the runtime persists a per-device record and returns a
   secret. The phone stores it in Keychain and subsequent connections
   authenticate with the paired secret, not the PIN.

`SettingsPinSheet` on iOS mirrors the desktop PIN sheet and handles
the entry UX. If the user misreads the digits, the runtime applies
per-IP rate limiting (5 failures → 10-minute cooldown).

### Browser access

The iOS app no longer offers **Pair a browser**. New hosted-web connections are
account-only: open the web client, sign in to the same ADE account as the Mac,
and choose the Mac from the account directory. The deleted
`SettingsWebClientPairSheet` and its QR/link/PIN flow are not compatibility
entry points; only browser environments paired before this release keep their
saved local/direct reconnect behavior.

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

Agent rows mirror desktop's shared status vocabulary: blue `Working`, amber
`Needs you`, emerald `Done`, red `Failed`, and neutral `Stale`. Amber is
reserved for the one state asking the user to act. Syncing, offline hosts,
blocked work, and a live-but-silent stale run remain neutral; stale uses a
clock rather than a network-offline glyph.

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

- **Account registration does not require pairing or alert permission.** A
  signed-in or paired phone registers ActivityKit's push-to-start token even
  when ordinary notification permission is denied and no alert APNs token
  exists. Signed-in phones send APNs and push-to-start routing directly to the
  account Activity relay. `AccountService` serializes
  account device PUTs, coalesces queued token/preferences refreshes, and sends a
  persisted monotonic `ownershipEpoch` on every device PUT/DELETE. Sign-out
  commits an unowned epoch before revocation; a direct account switch commits
  `account A → unowned → account B`, so a delayed old-account request cannot
  reclaim the install. Relay `409` means a newer boundary already won and is
  not retried. Turning Live Activities off sends an explicit token-clear
  mutation through both account and paired-machine routes; an omitted token
  preserves the current relay target so ordinary preference refreshes cannot
  disable delivery accidentally. The older `push.registerDevice` / `push.setPrefs` /
  `push.reportLiveActivityToken` commands remain as a paired-machine
  compatibility path.
- **Alert payloads deep-link.** A default tap carries a top-level
  `deepLink` routed through `DeepLinkRouter.handleNotificationUserInfo`.
  Account alerts preserve `accountMachineKey` plus exact session
  item/event or PR-tab anchors, and the app adopts/selects that machine before
  opening the destination.
- **Approval alerts are actionable only against the owning host.**
  `ADEAppDelegate` registers the
  `ADE_APPROVAL` notification category so approval pushes (stamped
  `aps.category = "ADE_APPROVAL"` plus top-level `sessionId` / `itemId` by
  the brain) show inline Approve / Deny. `didReceive response` maps the
  `ADE_APPROVE` / `ADE_DENY` action ids to `ADEIntentCommandRegistry`
  (`chat.approve`), so approvals resolve from the lock screen without
  opening the app. The `waiting_for_approval` Live Activity row carries the
  same buttons only for a current-host activity via
  `ApproveSessionIntent` / `DenySessionIntent`, which are
  `LiveActivityIntent`s (so they run in-app, not the widget extension); a
  tap while the app is dead queues in the registry and drains on the next
  launch / foreground. Remote account rows navigate to the exact machine and
  pending item instead of executing a current-host intent.
- **App-icon badge.** Account Activity delivery stamps the account-wide
  unresolved attention count on alerts and badge-only refreshes. The phone clears the badge
  on every foreground transition (`PushNotificationService.clearAppBadge`,
  called from `ADEApp`'s scene-phase handler) so a lingering count never
  reads as stale.
- **Live Activity** mirrors up to three active agent runs plus up to two
  recent PR lifecycle/status rows on the Lock Screen and Dynamic Island.
  `LiveActivityService` owns one account-wide `agent-runs` activity per phone,
  applies relay-pushed content-state updates, and ends it when the account
  activity settles, Live Activities are disabled, or the user signs out. Each
  `Run` / `PullRequest` row carries an optional `accountMachineKey`; exact
  element-level links preserve it so tapping a secondary row never opens the
  primary item or the wrong machine. Legacy payloads without the additive key
  still decode. Account-wide attributes and content also carry the relay's
  non-PII `ownershipEpoch`. `LiveActivityService` compares both copies with the
  durable current account-device owner and immediately ends a stale activity.
  The widget extension performs that check before drawing project/run details;
  while the app is not awake to end a delayed old-account start, it renders only
  a neutral **Updating ADE** state. Legacy signed-out machine activities do not
  claim account ownership and remain on their separate compatibility path.
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
  hours. Those controls update the signed-in account's explicit
  `devices[attentionDeviceId]` preference override through the relay's scoped
  atomic mutation, preserving account defaults, other devices, projects, and
  unknown fields even when another client saves at the same time. Failed
  mutations remain visibly unsynced and retry with capped exponential backoff;
  sign-out or a newer edit cancels the older retry.
  Live Activity diagnostics distinguish iOS authorization off, waiting
  for a push-to-start token, a token whose relay registration is pending, and
  a registered push-to-start target. The snapshot
  (`SettingsPushDeliverySnapshot`) is a pure
  Equatable value mirrored from `PushNotificationService`. When the
  paired machine is not reachable enough to answer runtime-scoped
  `push.*` commands, the panel preserves the last known relay status,
  disables refresh, and shows "waiting for machine" guidance instead of
  persisting that transient transport state as a failed push setup.
- **What needs a physical device.** Simulators cannot receive real APNs
  pushes or mint push-to-start tokens; end-to-end delivery and Live
  Activity push-to-start are verifiable on-device only. Registration
  flow, command routing, and preferences are covered by simulator builds
  and unit tests.

### Haptic Feedback

- `UIImpactFeedbackGenerator` and `UINotificationFeedbackGenerator`
  on message send, intervention approval, worker launch, PR merge.

### Activity drawer

Source: `apps/ios/ADE/Views/Activity/`.

The navigation-bar bell opens one global account-wide Activity drawer
(`ActivityDrawerSheet`). The signed-in app reads the Clerk-authenticated
relay snapshot incrementally and persists it in the App Group container with
the same source-revision, account-cursor, tombstone, and expiry rules as
desktop. The existing per-project drawer is a project lens over that model; it
is not a separate inbox.

The sheet has two buckets: **Sessions**, ordered as Needs you → Working → Done,
and **Inbox** for PR/CI work and unseen outcomes. It includes project filtering
and machine/project context on every item, and remains useful when the phone is
account-signed-in but not directly paired to a machine. Rows can be dismissed
with a swipe; account fallback and offline states remain explicit.

Each row uses the shared item destination and actions:

- **Needs you** — exact session/question/approval navigation; locally owned
  approvals may expose Approve/Deny.
- **Failed** — exact agent navigation and a locally safe restart affordance.
- **CI failing / review requested / merge ready** — exact PR tab navigation.
- **Completed / merged** — retained in Recent until seen or dismissed.

Row vocabulary is derived once, in `Shared/ActivityRowPresentation.swift` — a
pure item-to-label/tone/glyph/elapsed mapper with no SwiftUI in it — and the
tone-to-colour binding plus the lock-screen ranking live beside it in
`Shared/ActivityWidgetPresentation.swift`. Both compile into the widget
extension as well as the app, which is what keeps the lock screen from
describing a session in words and colours the app does not use; it also means
both files are pinned to the extension's iOS 17 deployment target. The Hub's
"Live now" strip (`Views/Hub/HubLiveStrip.swift`) is a third reader of the same
model, showing agents working on any account machine and hiding itself entirely
when none are.

The drawer uses the same one-hue-one-meaning contract as the widget and desktop
Activity pane. `blocked` is a neutral Working item with an Open action, distinct from the
amber `awaitingInput` kind; running uses the shared dotted-circle glyph, and a
stale run says `Stale` with a clock rather than claiming the host is offline.

Acknowledgments write through the account relay so desktop, ADE Notch, and
mobile settle together. A device never executes a current-host App Intent for
an item that originated on another machine; those items expose exact Open or
Reply navigation instead.

Push settings work for account-only users and cover notifications, Live
Activities, desktop-first behavior, preview privacy, sound, celebration, and
quiet-hour policy. Sign-out best-effort deletes the account device
registration and ends account-wide local Live Activities.

The Lock Screen widget and account-wide `agent-runs` Live Activity read the
same App Group snapshot/phase vocabulary. The relay prioritizes up to three
agent rows and two PR rows; ordinary open PRs do not keep the activity alive.
Every secondary row has its own `Link`, so it cannot accidentally open the
activity's primary item. Remote account activity rows never expose host-local
approval intents.

## Tab structure

The root shell is a `TabView` (`ContentView.rootTabs`) exposing the five
shipped tabs (Work / Lanes / PRs / Files / CTO) as `.tabItem` labels. Two
tabs carry badges: Work counts running chats
(`SyncService.runningChatSessionCount`), and CTO shows a marker when
`SyncService.ctoAttention.awaitingInput` is true — a *string* badge, so it
renders dot-sized and hides itself when idle, with a matching accessibility
label. The CTO needs its own badge source because its chat is excluded from
every session roster and so can never contribute to the Work count; see
[CTO › Hidden from rosters, but never silent](../cto/README.md#hidden-from-rosters-but-never-silent).
Detail screens that should claim the full height —
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
(from the `roster_subscribe` feed — see the sub-protocol table).

The Hub also owns the only mobile entry to projectless Chats.
`HubPersonalChatsCard` shows the active-session count and attention count when
the host advertises personal-chat support, then pushes `PersonalChatsScreen`
without selecting a project. That screen searches active/archived summaries,
refreshes on a five-second live cadence, and uses a per-host App Group cache for
offline list display. `PersonalChatNewScreen` reuses the Work
model/access/reasoning controls but sends `personalChats.create`; creation
requires a live host because it is not queueable. Existing chats reuse
`WorkSessionDestinationView` with `personalChat: true`, no lane list/actions,
runtime-scoped attachment reads, and personal action names for sends, steers,
approvals, metadata, archive, and delete.

The active project's rich chat rows still come from the phone's synced local
DB, but the machine roster is merged over that cache as an ephemeral display
projection. Local rows win by id; roster-only lanes and chats fill the CRR
arrival gap and disappear naturally when the authoritative row replaces them.
This keeps both the active Hub card and the Work list current when another
client creates a chat, without persisting foreign/stub rows or activating every
project. The Work bridge intentionally admits only non-archived chat-tool rows,
caps them at the same 200-session limit as `work.listSessions`, and synthesizes
only the lanes referenced by those chats; roster CLI stubs wait for their real
local PTY rows. The loaded local Work projection is tagged with its project and
cleared before a project switch can merge it with the next roster.
Pending offline chat rows are filtered by active project id/root, and Work keys
its presentation rebuild on that project's roster revision so activity in a
different project does not repaint the current list. Tapping a project card
opens its detailed tabbed view; tapping a chat opens that chat directly over the Hub (the
Hub stays mounted underneath so Back returns to it, and it keeps rebuilding
roster cards while a chat is open). Opening a chat that belongs to a project
other than the active one always activates that project first
(`HubScreen+ChatNavigation`), with the switch/hydration progress visible in the
cover. The requested chat opens when activation completes. A failed or
unresponsive switch resolves to concrete error copy with Retry and Back to Hub;
there is no silent tap or indefinite spinner. The roster still lets
`makeRosterSessionStub` render a chat immediately while its richer CRR row
arrives. CLI (terminal) rows take the same activation boundary and then use the
terminal destination (a CLI session has no chat JSONL; routing it through the
chat transcript surface would render permanently blank). The
hub row context menu also narrows for CLI rows: only "Open session" is
offered, since `chat.archive` / `chat.delete` reject non-chat sessions on the
host.

Session deeplinks use the repository envelope as a hard project boundary;
lane/branch hints are resolved only inside that project, and an announced
chat's own lane always outranks stale URL hints. An already-hydrated active
session opens through Work even when a copied link contains lane metadata,
which preserves compatibility with pre-roster hosts. Foreign or not-yet-
hydrated repository-scoped sessions route through Hub, whose retry key includes
roster, project-catalog, and connection changes. The app-root navigation task
also processes a request already present at cold launch rather than relying on
a later `onChange` event. Current hosts populate the paired `repoOwner` /
`repoName` fields only when they can resolve a canonical GitHub origin; older
hosts omit them and unrecognized origins leave both values null. An owner-scoped
link fails closed when that identity is unavailable instead of guessing from a
same-named folder.

The composer's "Created in …" toast follows the same rule — its Open
shortcut stub carries `toolType: "cli"` for CLI launches and the
provider-derived chat tool type otherwise (`HubCreatedChat.stubToolType`). A bottom
"type to vibecode" bar is now an **inline composer** (`HubInlineComposer`, in
`HubComposerDrawer`): focusing it raises the keyboard and expands the controls
strip (permission/model/mode/dictation) in place above the keyboard rather than
presenting a modal drawer. Expansion is explicit state (never derived from
`@FocusState`, which would snap) so every expand/collapse rides one shared
spring, and a Project ▸ Lane destination picker chooses where the chat lands.
The camera-roll picker is presented by the persistent composer root rather than
the transient plus control. Presenting PhotosPicker may dismiss the keyboard,
but the composer remains expanded until the picker closes, so its presenter is
never unmounted underneath the system sheet.
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
the legacy project picker's connected-state layout while preserving its
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
"Projects" affordance (`ADEProjectHubButton` / `ADERootToolbarControls`)
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

Submitting a valid prompt dismisses the keyboard across every mobile chat
composer: Work session chat clears the observable `UITextView` focus request,
Work new-chat and personal new-chat clear their focus bindings, and the Hub
inline composer collapses its full panel. The prompt field therefore returns to
its compact resting state without an interactive keyboard swipe that can
conflict with chat navigation. `WorkComposerTextView` and
`WorkPlainComposerTextView` never call `becomeFirstResponder` or
`resignFirstResponder` synchronously from `UIViewRepresentable.updateUIView`.
Their shared focus scheduler yields past the active SwiftUI update, coalesces
rapid focus changes to the latest request, and ignores an initial unfocused
binding so it cannot dismiss a responder owned by another view. This prevents
send-time draft clearing from re-entering SwiftUI's view graph while preserving
keyboard dismissal and later focus restoration. On `WorkNewChatScreen`, the
cross-client activity carousel is part of the main scroll content rather than a
pinned sibling above the composer, so keyboard presentation gives an expanding
multi-line prompt the available space instead of lifting the activity panel
with it.

Mobile image attachments use the same host-side temp attachment contract as
desktop. Hub, Work new-session, compact/in-session, Chat, and CLI composers open
the scoped `PhotosPicker` directly from the plus control rather than through a
one-item menu. Their `UITextView` inputs also advertise Paste for image-only
clipboards and stage pasted images through the same path. Up to ten images are
normalized to JPEG and retained locally; overflow and load failures stay visible
as blocking tray errors instead of being silently dropped. Staging works while
offline, while upload/send waits for reconnection. Hosts that do not advertise
`chat.saveTempAttachment` do not offer attachment entry.

`WorkChatInputAttachmentTray` is a separate fixed-height shelf above the input
region, so adding previews grows the composer upward without reducing the text
field's space. Attachments survive Chat/CLI mode switches. Chat sends attach the
saved `AgentChatFileRef` image refs to `chat.send` / `chat.steer`. CLI launches
save through the same contract, then `workCliInitialInput` serializes the temp
paths into the desktop-compatible `Attached files and images:` manifest inside
`work.startCliSession.initialInput`.

Work can also import provider-native Claude, Codex, Cursor, Droid, and OpenCode
CLI sessions. `WorkImportSessionScreen` first shows a compact searchable list,
then opens details with `WorkLanePickerDropdown` and the safe Continue/Copy
actions derived by `WorkExternalSessionAffordances.swift`. Listing and import
run on the paired host through `work.listExternalSessions` and
`work.importExternalSession`; the phone never reads provider storage. Import
results include the persisted chat or terminal summary, which Work caches before
navigating so replication latency cannot produce a blank destination screen.

Rows are identified by two anchors rather than one snippet: **started**, the
thread's opening prompt (`preview`), and **latest**, the last of the bounded
`messages` sample the host attaches. Either may be missing — an older host
predates `messages`, and a thread whose only human text was a slash command has
no recoverable prompt — so the screen falls back to the single preview, and it
suppresses an anchor the row heading is already showing. `ExternalSessionSummary`
decodes `messages` through `ADELossyArray`, and `ExternalSessionMessage` rejects
an unknown `role`, so one malformed element costs that element rather than the
whole summary; the surrounding `try?` would otherwise turn a decode failure into
a silent empty "No sessions found".

Chat imports also choose how the resulting ADE chat starts — model, reasoning
effort, fast mode where the model supports it, and permission mode — seeded from
and written back to `WorkComposerPreferences` so the phone's composer and its
imports stay consistent. Those arguments are sent only for `target: "chat"`; a
CLI import sends none of them so the resumed session keeps its provider state.
See [External session import](../terminals-and-sessions/external-session-import.md).

### Settled lifecycle and attention parity

iOS mirrors `apps/desktop/src/shared/sessionCanonicalState.ts` in
`WorkSessionCanonicalState.swift`. The precedence and visual vocabulary match
desktop: deterministic approval/question/`ade chat ask` is `Needs you`; an
explicit settle applies only while the session is at rest; failed and stopped
remain distinct; a clean process exit is merely ended; and a running row with a
real activity timestamp at least three hours old is `Stale`, not settled.
`AgentRunPhase` mirrors `shared/sessionStatusPresentation.ts`: work in flight is
blue `Working`, only a raised hand is amber, a clean unseen outcome is emerald
`Done`, failure is red, and stale/non-actionable truth is neutral.

The replicated `terminal_sessions` lifecycle columns flow through
`Database.swift`, the active-project session summaries, and
`RemoteRosterChat`. Status grouping includes a final Settled section. Settled
rows use the hollow status ring, lower opacity, stay openable, and render
`statusNote` as `done: …`; an explicit attention request instead puts its
question in the preview line. Ready/idle rows remain in Your move without a
capsule, while `Needs you` is the loud tier used by awaiting counts, the
  Activity drawer, push, and attention-first roster behavior. A settled chat
woken by unattended scheduled work shows Running during the turn and returns
to Settled at idle because only user activity clears its declaration.

#### Settle override and snooze

The phone carries the full lifecycle, not a read-only view of it. Two
mechanisms sit on top of the derivation and both are mirrored here.

`settle_override` is a tri-state (`null | "settled" | "active"`) consulted at
the declared-settle tier. `"settled"` behaves like a declared settle;
`"active"` is an explicit keep-active pin; `null` returns the row to the
persisted lifecycle state. The override is cleared on real activity
at the same write sites that clear `settled_at`.

Snooze is a synced **visibility overlay**, never a lifecycle phase — the Swift
derivation, like the TypeScript one, does not read it. Only where a surface
*files* the row changes. `snoozed_until` is the deadline and expiry is derived
by comparing it to now; there is no scheduler or watchdog on the phone or the
host. `snoozed_at` records when the snooze was taken and is load-bearing: an
error counts as an early wake only when it is strictly newer than `snoozed_at`,
otherwise the very failure the user snoozed on top of would instantly re-wake
the row. Waking stamps `woke_at` / `woke_reason`
(`timer | needs_you | error | turn_complete | manual`) so the row can explain
its return until it is visited, at which point `clearWokeMarker` drops it. Early
wake also fires for a session that ends in failure (non-zero exit, or a
`"failed"` end with no exit code); a clean exit 0 is not a failure and never
wakes. Filing yields to a raised hand: `isSessionFiledAsSnoozed(session, phase)`
returns false for a `needs_you` phase, so a snoozed row blocked on the user
stays in its normal section rather than disappearing into the snoozed tail.
`isSessionSnoozed` stays the raw column read used for row chrome.

The iOS pieces:

- `apps/ios/ADE/Resources/DatabaseBootstrap.sql` declares the five new nullable
  `terminal_sessions` columns (`settle_override`, `snoozed_until`,
  `snoozed_at`, `woke_at`, `woke_reason`) for fresh installs.
- `apps/ios/ADE/Services/Database.swift` carries the matching `ensureColumn`
  migrations for existing installs, plus the columns threaded through the
  session upsert bind indices, the row struct, and the session read queries.
- `apps/ios/ADE/Models/RemoteModels.swift` and `RemoteRosterModels.swift` decode
  `settleOverride`, `snoozedUntil`, `snoozedAt`, `wokeAt`, and `wokeReason` as
  optional `String` fields through `decodeIfPresent`, and include them in
  equality so a lifecycle-only change still redraws the row.
- `apps/ios/ADE/Services/SyncService.swift` holds the `session.*` remote-command
  callers. Mobile has no local write path for lifecycle, so these commands are
  the mechanism, and the connect-time descriptor list gates the affordances.
- `apps/ios/ADE/Views/Work/WorkSessionCanonicalState.swift` is the Swift mirror
  of the shared derivation, now including the settle-override tier and
  `isSessionFiledAsSnoozed`. `WorkSessionGrouping.swift`'s `workSessionGroups`
  grows a snoozed tail, and `WorkRootScreen.swift`,
  `WorkRootScreen+Actions.swift`, and `WorkRootComponents.swift` render the
  chips and menus and dispatch snooze / wake / settle / keep-active. By-lane
  groups whose full unfiltered roster is quiet use a thin collapsed header and
  an inverted `lane-open:<laneId>` expansion marker; expanding renders compact
  rows, and active work removes the marker so the next quiet spell collapses.
  The snooze helper yields to canonical `needs_you`, so a lane waiting on the
  user can never be folded into this quiet presentation.
- `WorkSessionGrouping.swift` also owns `WorkViewStateStore`, a versioned
  App-Group map keyed by project id plus host identity. `WorkRootScreen` swaps
  search, lane/status filters, organization, and collapsed ids when either
  scope component changes and saves the outgoing scope first. Lane deeplinks
  frame those fields transiently: persistence is suppressed until the user
  takes control, at which point edits resume from the saved base rather than
  making notification routing a permanent preference change.
- `apps/ios/ADETests/WorkSessionCanonicalStateTests.swift` covers the derivation
  and scoped view-state parity.

Two invariants govern changes here. The Swift derivation must stay
behaviourally identical to `apps/desktop/src/shared/sessionCanonicalState.ts` —
it is a mirror, not a variant, and the canonical-state tests exist to catch
drift. And any new `terminal_sessions` column must be added to **both** iOS
schema halves, `DatabaseBootstrap.sql` and `Database.swift`'s `ensureColumn`
migrations: bootstrapping only the SQL leaves upgraded phones failing changeset
apply, which surfaces as a phone-side error rather than anything visible on
desktop. Like every replicated table, these columns are nullable with no unique
index, because `terminal_sessions` goes through `crsql_as_crr`, which rejects
any non-primary-key unique index.

### Shipped

| Tab | Icon | Desktop equivalent | Capabilities |
|---|---|---|---|
| **Lanes** | `square.stack.3d.up` | `/lanes` | Full lane surface: search/filter chips, open/create/attach/manage, multi-attach for unregistered worktrees, stack canvas, git/diff/rebase/conflicts, template-backed environment setup progress, lane-scoped sessions and AI chats. `devicesOpen` presence chips show which other devices currently have the lane open. The lane detail screen (full-screen, custom tab bar hidden) is organized into collapsible sections (`LaneDetailSectionChrome`): each section auto-opens when it has content and auto-collapses when empty (`LaneSectionDisclosure`), and stays where the user last put it once they toggle it manually. Header chips and the git action buttons flow through `LaneChipFlowLayout`, a wrapping flow layout that wraps onto new lines instead of horizontally scrolling. Lane rows in the list carry a cheap render-relevant signature (mirroring the Hub row-signature pattern) so `.equatable()` re-renders only rows whose visible state changed. It embeds `LaneDetailGitActionsPane`, a port of desktop's git actions pane: commit message field with amend toggle and an AI "Suggest message" button (gated by runtime capability, with a setup-hint when the runtime reports "AI commit messages are off"), pull (rebase/merge mode) / push (with force-with-lease) / fetch, staged + unstaged file lists with per-file and bulk stage / unstage / discard / restore / open-diff / open-files, stash push/apply/pop/drop, recent-commit history with context-menu view-files / copy-message / revert / cherry-pick, and a "more actions" menu holding switch branch plus the destructive escape hatches (rebase lane, rebase + descendants, rebase and push, force push). A conflict banner offers rebase **and merge** continue/abort (`git.rebaseContinue`/`Abort`, `git.mergeContinue`/`Abort`), and a rescue sheet creates a new lane from uncommitted changes. The lane options menu copies shareable deeplinks (`LaneDeeplinkHelpers`: `ade://lane/<id>`, `ade://repo/<owner>/<repo>/branch/<branch>`) and opens `LaneManageSheet`, now a tabbed manage dialog (delete / appearance / stack / archive) mirroring desktop's `ManageLaneDialog`; for an attached-but-unmanaged lane (`adoptableAttached`, matching the host's derivation) it also surfaces a "Move to ADE-managed worktree" adopt action that copies registration into `.ade/worktrees` without rewriting git history. The previous `LaneAdvancedScreen`, `LaneCommitSheet`, `LaneStashesScreen`, and `LaneCommitHistoryScreen` destinations were deleted in favor of this single pane. |
| **Files** | `doc.text` | `/files` | Lane-backed workspace picker (`FilesWorkspacePickerDropdown`, a desktop-shaped searchable dropdown that replaced the horizontal workspace chip row), live file tree/read. Search is a single full-screen page (`FilesSearchScreen`) opened from the magnifying-glass button in the Files top bar (desktop `SearchOverlay` parity): one query searches file *names* (quick open) and file *contents* (text search) together — name matches surface first under "Files", content hits are grouped per file with collapsible line previews, and tapping a line opens the file at that line. The inline `FilesQueryCard` quick-open / text-search cards (and their 40-row caps) were removed. Files are freely editable — the mobile read-only file-mutation gate (`mobileReadOnly` / edit-protection) was removed on both the host and the phone, matching the desktop change. |
| **Work** | `terminal` | `/work` | Terminal + chat session list (standalone CLI sessions stay listed after they end, matching desktop — `workSessionShouldAppearInWorkList` in `WorkBrowserHelpers.swift` hides orphaned chat-owned child shells that are no longer live), cached history with persisted lane names, output streaming, native key-passthrough terminal input (keystrokes from the iOS keyboard flow straight into the PTY as `terminal_input`, coalesced ~16 ms; PTY echo is the only source of truth), Ctrl-C forwarding for subscribed live PTYs, in-app CLI session launcher (Claude / Codex / Cursor / OpenCode / Droid), message-to-continue on ended agent CLI rows, session pinning, live chat-event push from the runtime (no polling lag once subscribed). The new-session screen (`WorkNewChatScreen`) toggles between **Chat** and **CLI** via a compact nav-bar pill toggle (desktop `ModeSwitcherPills` parity); the lane is chosen through `WorkLanePickerDropdown` (searchable, with an auto-create-lane row), and in CLI mode the provider is derived from the picked model via `workResolveCliProvider` instead of a separate provider row — the explicit `workCliProviderOptions` picker (and its plain "Shell" launch option) was removed. The new-chat composer shares the in-session chat composer's `WorkComposerControlsRow` (the same controls strip used by `WorkComposerChipStrip`): a permission/access control that collapses to a single tone-dot dropdown when space is tight and expands to segmented chips when wide, a model pill, and a fast-mode lightning toggle. The fast-mode toggle is shown only in **Chat** mode for fast-capable models (threaded into `chat.create` via `codexFastMode`) and is hidden in CLI mode, where the launcher has no fast-mode parameter. The composer's last-used selection (model + access mode + reasoning effort + fast mode) persists across surfaces through `WorkComposerPreferences` (App Group `UserDefaults`, versioned key): the New Chat screen seeds its initial state from the saved selection instead of hardcoded defaults, and every change or send — from the New Chat composer, the in-session inline picker (`WorkSessionDestinationView`), or the session settings sheet — writes it back. Because the inline picker is cross-provider, the persisted provider is re-derived from the picked model, and a provider change resets the coupled access mode / sub-settings to that provider's defaults. Droid (Factory) is in the new-chat provider allowlist (`workNormalizedNewChatProvider`), so Droid Core models (GLM / Kimi / MiniMax) keep the `droid` provider instead of silently collapsing to the Claude runtime. The new-chat send button is the shared `ADEComposerSendButton` (an arrow-in-circle disc matching the in-session composer), replacing the earlier paperplane capsule. Each session row carries a minimal per-lane PR status indicator (`WorkLanePrIndicator`: a state-colored dot + `#num` + Open/Draft/Closed/Merged) beside the lane name. It and the Lanes tab chip both render the unified `LanePrTag` (`LaneHelpers.swift`, `selectLaneTabPrTag`, desktop parity), which merges ADE-mapped PRs (the synced `pull_requests` table) with GitHub PRs opened outside ADE — matched to a lane by branch and fetched into the shared `SyncService.laneGithubPrItems` cache (`refreshLaneGithubPrItems`, best-effort, throttled, reset on project switch / reconnect). When a row resolves a `LanePrTag` (mapped or GitHub-by-branch), its long-press context menu (`WorkSessionListRow`) also offers **"Open in PRs tab"**; `WorkRootScreen+Actions.openPullRequest` waits out the menu-dismiss animation, then publishes `syncService.requestedPrNavigation` (a `PrNavigationRequest` carrying the PR id + number + lane id, or just the GitHub PR number for an unmapped tag), and `ContentView`'s `onChange(of: requestedPrNavigation?.id)` flips the app to the PRs tab and opens that PR — the same cross-tab handoff the deep-link router and the in-chat PR menu use. CLI mode submits `work.startCliSession` with the resolved provider, permission mode (Claude additionally supports `auto`), an optional `reasoningEffort`, and an optional opening message. For most providers the runtime types the opening message into the spawned PTY; for Codex the opening message is forwarded as the final argv positional through `buildTrackedCliLaunchCommand`, so the prompt is treated as a real first turn instead of a typed shell line. The terminal viewer (`TerminalSessionScreen` + `SwiftTermSessionView`) is a full-bleed SwiftTerm (real VT100/xterm) emulator: tap-to-focus raises the iOS keyboard for direct passthrough, a single-row key bar provides esc/tab/latching-Ctrl/arrows/return plus an overflow menu, pinch adjusts font size, and the phone owns the PTY's cols×rows while the screen is open (sent as `terminal_resize`; the runtime restores the desktop size on detach). Live output streams via offset-stamped `terminal_data` with gap detection + `sinceOffset` delta resume (no snapshot polling); scrolling near the top auto-pages older transcript via `terminal_history`, and a floating "↓ Live N" pill snaps back to the live tail. Only real user drags can un-pin the viewport: layout-driven geometry changes (keyboard show/hide, key bar, pinch font changes) re-assert the live tail after the pass settles, so a pinned terminal with large scrollback keeps the prompt visible above the keyboard instead of stranding it (SwiftTerm only re-snaps when cols/rows change, and a mouse-mode TUI repainting in place emits no scroll events to self-heal). When the hosted program enables mouse reporting (Claude Code, htop), vertical pans are translated into SGR wheel events so the TUI scrolls itself; mouse-off sessions scroll native scrollback. Against pre-offset hosts (older brains, whose PTY→sync bridge never pushed terminal output) the screen detects the missing offsets and falls back to a 2s tail-refresh poll until offsets appear. The screen unsubscribes via `terminal_unsubscribe` on disappear. The legacy `WorkTerminalEmulatorView`/`WorkTerminalScreen` mini-parser remains only for inline preview cards. The earlier "activity feed" section was retired — running chats are surfaced through the session list and a Work tab badge bound to `SyncService.runningChatSessionCount`. In chat sessions, user-message attachments render through `WorkChatAttachmentTray` (image thumbnails embedded in the bubble, desktop `ChatAttachmentTray` parity, placeholder tiles when the image bytes have not synced from the host yet), and the chat header's PR menu opens the lane's open PR on GitHub, copies its link, or launches the create-PR wizard in `singleModeOnly` mode (eligibility read from `prs.getMobileSnapshot.createCapabilities`). The chat composer input is a `UITextView`-backed field (`WorkComposerTextView` in `WorkComposerTypedTriggers.swift`) rather than a plain SwiftUI `TextField`, because it needs the cursor position and inline styled runs. `WorkComposerTriggerDetector` runs the same cursor-relative regexes as the shared desktop/TUI `composerTriggers.ts` (slash `(?:^|\s)/([^\s/]*)$`, at `(?:^|\s)@([^\s@]*)$`), so a `/command` or `@file` trigger is detected anywhere in the draft, not just at position 0. `WorkComposerSuggestionController` drives an inline suggestion strip (`WorkComposerSuggestionStrip`) above the input — a curated per-provider slash catalog (`WorkComposerSlashCatalog`) resolved locally, and `@file` quick-open resolved over sync via `SyncService.quickOpen` against the lane's files workspace (40 ms debounce, workspace id cached per lane, invalidated on lane change). Its visibility derives purely from the active trigger match, never from `@FocusState`. Committing a suggestion splices exactly the trigger span on the live text view, and confirmed `/command` / `@path` tokens render as tinted chip pills drawn by a custom TextKit 1 `WorkComposerChipLayoutManager` (provider-accent tint, monospace for slash, semibold for at) while `draftState.text` stays the plain-text source of truth that is sent. `WorkSmartLinkDetector` styles GitHub, Linear, ADE, and generic web URLs with the same chip layout manager in both new-chat and in-session composers; Backspace/Delete removes an intersected URL atomically, and long press offers Copy link and Remove link. The raw URL remains the SwiftUI draft and sent prompt. This replaced the modal `WorkMentionsPickerSheet` and `WorkSlashCommandsSheet` (both deleted). |
| **PRs** | `arrow.triangle.pull` | `/prs` | PR list/detail driven by `prs.getMobileSnapshot`: GitHub stack visibility (`PrStackSheet`), create-PR wizard (`CreatePrWizardView`) gated by per-lane eligibility, Integration/Rebase workflow cards rendered from `PrWorkflowCard`, and per-PR action capabilities. The PR detail screen (`PrDetailView`) is a single-column adaptation of the desktop Timeline+Rails layout — its Overview is emitted as sibling `List` rows so the list virtualizes offscreen content, and it stays live off a warm-cache freshness gate (see [PR detail screen](#pr-detail-screen)). |
| **CTO** | `brain` | `/cto` | The CTO chat thread rendered inline as the tab body (single persistent session via `CtoSessionDestinationView`) with a compact one-line voice/send composer. The top-bar gear opens settings for identity/personality, live model/reasoning/Fast selection, read-only Linear status, memory via `cto.getMemory`, and re-run setup. The tab badges when the thread is blocked on the user: `SyncService.refreshCtoAttentionIfNeeded()` calls the optional `cto.getAttention` command (5 s debounce, gated on `supportsRemoteAction`) and publishes `ctoAttention`. It rides the change pulse that rebuilds the session roster, but is invoked *before* `refreshActiveSessionsAndSnapshot`'s roster-signature early return — the CTO is excluded from that roster, so a CTO-only change leaves the signature unchanged and a probe below the guard could never fire. `saveRemoteCommandDescriptors` also calls it with `force: true`, so the first probe after a (re)connect happens as soon as the host advertises the command. A failed probe keeps the last known value; an older brain that does not advertise the action clears it. |
| **Settings** | `gearshape` | `/settings` (sync subset) | Connections — account sign-in (primary, PIN-less directory + Relay adoption), account-wide machine rename/clear, scan the QR (`SettingsPairingScannerSheet`) + PIN, or Nearby + PIN — plus advanced SSH bootstrap, appearance, diagnostics, reconnect, forget, and a **Push delivery** panel (`SettingsPushDeliverySection`: registration/permission state, APNs environment, relay reachability from `push.getStatus`, and notification / Live-Activity / quiet-hours toggles). `ConnectionSettingsView` binds to `SettingsConnectionPresentationModel`, which feeds plain `SettingsConnectionSnapshot` / `SettingsPairingSnapshot` / `SettingsDiagnosticsSnapshot` / `SettingsPushDeliverySnapshot` DTOs into the section views (`SettingsConnectionHeader`, `SettingsPairingSection`, `SettingsDiagnosticsSection`, `SettingsPushDeliverySection`) instead of having them reach into `SyncService` directly. The About row formats the marketing and build versions together as `v<marketing> (<build>)`. |

`WorkModelPickerSheet` shows the same Claude authentication affordance
as desktop when Claude-family models are unavailable: a compact
`Login to Claude` action opens a primary-lane terminal by calling
`SyncService.startClaudeLoginTerminal`, which sends
`work.runQuickCommand` with `startupCommand: "claude auth login"` and
`toolType: "shell"`, then navigates to the created Work session.
Call sites with lane context pass their lanes; otherwise the sheet
fetches the current lane list before reporting that no active lane is
available.

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
sequence — returning to a previously-synced project resumes normal gaps
incrementally without skipping, while a gap strictly over 5,000 versions may
jump through one ACK-gated compact current-state catch-up batch. If the
runtime is offline at switch time, it still records the requested
project as active and the phone reconnects when the machine returns.

Before tearing down the old connection on a project switch, `SyncService`
calls `resetChatEventState(clearHistory: false)` and
`resetTerminalSubscriptionState(clearHistory: true)` so chat /
terminal subscriptions bound to the previous project's session ids
are dropped. Without this reset, the phone would resubscribe to stale
ids after reconnect and either leak foreign chat events into the new
project view or collide with newly-assigned session ids on the runtime. Pending
requests are likewise owned by the socket generation that sent them: teardown
fails only the retiring generation and cancels its timeout tasks, while the
timeout handler rejects any stale generation defensively. An old project-switch
request therefore cannot probe or recover the replacement socket.

The switch is engineered to feel instant rather than blanking to a spinner:

- **The catalog stays mounted.** `HubScreen` only falls back to
  `HubConnectingCard` when there is genuinely nothing to show yet
  (`!canShowProjects && hubProjectPresentations.isEmpty`). While a switch is in
  flight the project list keeps rendering: the tapped row shows its own inline
  spinner (`presentation.isSwitching`) and every other row is disabled and dimmed
  to `0.55` opacity (`syncService.isProjectSwitching`), so the list never swaps
  to a full-screen connecting state.
- **Fast-path reconnect.** The happy-eyeballs race starts from a plan whose
  front is the endpoint `networkRouteMemory` recorded for the network the phone
  is currently on, followed by the proven `lastSuccessfulAddress`, so the
  broader class/health ranking can't push a known-good route down the plan.
  `hello_ok` is treated as the barrier: restorative
  post-hello work (`restoreTrackedOpenLanesAfterReconnect`,
  `refreshRemoteProjectCatalog`) is moved off the critical path into
  `schedulePostHelloWork` so it no longer holds the reconnect caller — and
  therefore the Hub transition — while those network refreshes run. Phase timing
  is traced through `logProjectSwitchPhase` (`ADE_SYNC_TRACE project_switch`).
- **Runtime prewarm.** The machine runtime opportunistically warms up to two
  most-recently-used project scopes in the background after startup (see the
  sync README's `prewarmRecentScopes`), so the scope the phone switches into is
  frequently already open on the host.

Hub layout state is local to the phone and keyed by stable machine connection
identity in `HubLayoutStore`; it is not CRDT state and does not sync to another
phone. On the first catalog for a machine, the active project is expanded while
every other project and every lane starts collapsed. Seed markers distinguish
that one-time default from user intent: later refreshes preserve explicit
expand/collapse choices, and newly discovered projects receive the same
active-expanded/other-collapsed default without resetting existing rows. Manual
project order is persisted in the same per-machine record. The top bar keeps the
ADE mark, connection pill, and fixed circular actions in one compact row rather
than inserting spacer-owned dead width.

A successful quick-connect from the no-machine home fires a brief success beat
(`ConnectSuccessBeat` + haptic) via `HubScreen.triggerConnectBeat`.

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
`prsProjectionRevision`, `prsRemoteRevision`, and
`proofArtifactsProjectionRevision`. `prsProjectionRevision` tracks replicated
mapped-PR changes; `prsRemoteRevision` is the coalescing key for the host's
lightweight `prs_updated` invalidation when local-only GitHub projections
change. Work's roster overlay additionally keys on `rosterRevision(for:)`, a
per-project token, so unrelated-project roster churn does not invalidate the
active Work presentation.
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
(searchable dropdown over the lane's eligible base branches). The title
defaults to `source lane -> target lane`, submit defaults to a normal
PR (`draft: false`), and the wizard no longer calls the AI PR draft
flow before submission. Per-mode submit handlers route through the sync
command surface:

- single → `prs.createFromLane` (via `onCreateSingle` callback)
- integration → `prs.simulateIntegration` followed by
  `prs.commitIntegration`, returning `CreateIntegrationPrResult`

`SyncService.swift` exposes these through typed wrappers
(`simulateIntegration`, `commitIntegration`, `listIntegrationWorkflows`).
`RemoteModels.swift` carries `IntegrationMergeResult`,
`CreateIntegrationPrResult`, and `CleanupIntegrationWorkflowResult`
to match the desktop return shapes.

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
- `workflowCards` — union of `PrIntegrationWorkflowCard` and
  `PrRebaseWorkflowCard` rendered by
  `PrWorkflowCards.swift`.
- `live: boolean` — false signals the phone should render a
  "machine offline" banner.

The PR list's GitHub browser reads the repo-scoped GitHub snapshot
(`repoScopedGitHubPullRequests`). Legacy cross-repo `externalPullRequests`
items are ignored, matching the desktop change — when a routed PR isn't in
the lane-PR list, `PrDetailView` synthesizes a fallback list item from the
repo-scoped GitHub row + snapshot so the hero card never collapses into a
`Pull request / @unknown` placeholder.

The list reconciles the bounded GitHub projection with the replicated mapped-PR
cache, so linked rows remain available offline and a replicated merged/closed
state wins over a stale Open projection. For the All scope, Open / Merged /
Closed tabs read exact repository totals from one cached GraphQL count query;
ADE and External scope counts remain local to the reconciled row set. Terminal
history pages independently in bounded two-page increments, up to ten pages. A
tiny host `prs_updated` envelope invalidates the list after webhook changes;
the view coalesces bursts for 300 ms and reads the newest projected snapshot
once with row revalidation disabled, so freshness requires neither a timer nor
one request per PR. Manual refresh runs PR and lane refreshes concurrently.

Merged and closed rows carry the desktop's merged-bucket treatment, kept in
parity by `PrHelpers.swift`. `GitHubPrListItem` and the replicated
`pull_requests` row both surface `detached` (`PrDetachedLane`: frozen lane name,
colour, and chat / artifact / checkpoint counts), `mergedBy` (`PrMergedBy`),
`mergeMethod`, `commitCount`, and `changedFiles` — all optional with defaults,
because they are absent both on PRs merged before the host recorded them and
against older desktop hosts, and a non-optional field would throw for the whole
snapshot decode. See
[Detached PR rows](../pull-requests/README.md#detached-pr-rows) for what a
detached row means and what may reclaim it.

`prListPeriodGroups` interleaves the same day/week period headers the desktop
list uses (`Today` / `Yesterday` / `This week` / `Last week` / an explicit week
range / month), each with a row count and a summed `+1.2k −380`. Rows file under
`mergedAt → updatedAt → createdAt`, grouping preserves the caller's sort, and
Open stays ungrouped. `prMondayAnchoredCalendar` forces `firstWeekday = 2`:
`Calendar.current` is locale-dependent and Sunday-first under `en_US`, which
would otherwise put the same PR in "This week" on the phone and "Last week" on
desktop.

`PrRowCard` keeps scroll-time rendering deliberately compact: a fixed state
symbol, two-line title with age, one identity line with a non-wrapping
`Unmapped` capsule or lane label, then a branch line whose trailing checks /
reviews / comments remain horizontal. It does not fetch author avatars from
the network. In the terminal buckets it drops the queue signals — the identity
line becomes the dim `was: <lane>` ghost chip when the PR is detached, or
nothing at all when the PR simply never had a lane, and the branch line is
replaced by `<merger> · <method> · → <base>`. Filtering, sorting, counts, and mapped-row reconciliation are
recomputed only when their inputs change rather than during each SwiftUI
`body` pass. `PrRowCardSkeleton` mirrors that three-line geometry so loading
does not jump into the final layout.

### PR detail screen

Source: `apps/ios/ADE/Views/PRs/PrDetailScreen.swift` (the `PrDetailView`
struct), with the timeline builder + commit-group folding in
`PrDetailActivityTab.swift`, the compact header/description views in
`PrDetailHeaderComponents.swift`, the embedded GitHub HTML normalizer in
`PrGitHubDescriptionParser.swift`, and the remaining thread cards in
`PrDetailOverviewTab.swift` / `PrHelpers.swift`.

`PrDetailOverviewTab` builds `PrShippedFacts` for a merged PR — the same three
optional lines as the desktop merge rail's shipped summary (`by arul · squash ·
3 Jan`, `12 commits · 9 files · open 2d 4h`, `was: auto-naming · 3 chats ·
2 proof`), each omitted when its inputs are missing.

The detail screen is a single-column adaptation of the desktop
Timeline+Rails PR view. Its Overview is emitted as sibling `List` rows
(`overviewThreadRows`) rather than a single nested card, so the `List`
virtualizes offscreen thread content instead of laying out the whole PR on
every scroll frame. The navigation header uses a plain back chevron, centered
PR title with `#number · lane · branch`, and a plain ellipsis actions button.
Reading order (desktop parity, folded to one column):

1. a compact summary section (`PrDetailSummarySection`) with a state/approval
   line and three metrics: Checks, Changes, and Commits. Commits expand inline
   from their metric and jump to the matching timeline anchor;
2. a collapsed-by-default unmapped-PR notice (`PrUnmappedThreadBanner`) when
   the PR has no ADE lane. Its expanded state is remembered per PR for the
   current scene; expanded actions offer auto-map
   (`prs.createLaneFromPrBranch`), map to an existing lane
   (`prs.linkToLane`), or Open in GitHub;
3. the PR description (`PrThreadDescriptionCard`). GitHub's embedded HTML is
   normalized into safe Markdown, while `<details>/<summary>` regions become
   native `DisclosureGroup` rows instead of visible raw tags;
4. a chronological event feed — one row per timeline event or folded
   commit group, ascending oldest → newest, built by
   `buildPullRequestTimeline` and folded via `buildPrTimelineDisplayItems`
   (`PrDetailActivityTab.swift`) so runs of same-author commits collapse
   into a single group row;
5. review threads (unresolved first, resolved folded into a collapsible
   section). Individual thread/comment cards are also collapsible on mobile:
   folded rows use cheap inline preview text, while expanded rows render the
   full normalized markdown body through `WorkMarkdownRenderer`;
6. the comment composer (locked for unmapped PRs);
7. the inline merge rail (`PrOverviewMergeRail`) carrying the desktop
   GitHub-style requirement checklist (`PrMergeChecklist` —
   conflicts / behind-base / checks / review), the merge-method sheet, and
   admin-bypass gating;
8. metadata cards — checks, commits, files, people, and the stack card,
   plus a post-merge cleanup banner.

There is no separate Activity sub-tab — the activity feed lives inside
Overview, and the visible sub-tabs are Overview / Files / CI-Checks (a
persisted `.activity` selection routes to Overview). The
render-path-expensive derived models — the sorted timeline, the folded
display items, the unresolved/resolved thread split, and the synthesized
fallback PR — are precomputed once per data change in
`recomputeDerivedModels()`, never inside `body`.

Unmapped rows navigate to this full screen with a synthetic
`gh:owner/repo#number` route instead of opening the old metadata-only sheet.
The warm cache seeds the row title immediately, then
`prs.getMobileGithubDetail` loads detail/status/checks/reviews/comments/files,
commits, review threads, action runs, and activity in one sync command. The
description, files, checks, and timeline therefore remain readable before lane
mapping; lane-dependent mutation controls stay locked. Optional sub-read
failures are returned in `unavailableParts`; the phone preserves the previous
successful field values, displays a partial-data retry notice, and uses the
normal 25 s freshness window as retry backoff. An explicit retry bypasses that
window.

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
activity feed, action runs, deployments, capabilities) on a task keyed by both
the replicated PR projection revision and the lightweight remote GitHub
projection revision, throttled by a warm-cache freshness window
(`detailFreshnessWindow = 25 s`). It first seeds from the service warm cache for
an instant render; when the cached entry is younger than 25 s the
revision-driven reload skips the cold sidecar fan-out (8+ network calls) and
only refreshes the cheap local projection, and when the window has lapsed the
next revision bump re-fetches sidecars too. Mapped PR changes arrive through
the replicated changeset stream and bump `prsProjectionRevision`; local-only
GitHub projection changes arrive through `prs_updated` and bump
`prsRemoteRevision`. Both paths therefore share one throttled refresh gate
instead of creating a poll loop. Pull-to-refresh and the explicit retry path
bypass the window. Detail actions (merge / close / reopen / comment / edit)
route through `SyncService.runDurablePrAction` so their spinners survive a tab
switch + remount.

## Command policy from the runtime

The runtime exposes command-policy metadata
(`SyncRemoteCommandDescriptor.policy` with `viewerAllowed`,
`requiresApproval`, `localOnly`, `queueable`) through the sync command
surface. The phone reads these descriptors and gates UI actions
against them instead of relying on hardcoded mobile assumptions. A
runtime that disables a command via policy change is immediately
reflected in the phone's UI on the next descriptor read.

`chat.cancelScheduledWork` is viewer-allowed but explicitly non-queueable.
`WorkSessionDestinationView` asks `canInvokeChatRemoteAction` before constructing
the cancellation callback, and `WorkScheduledWorkRow` additionally requires
`durable == true` and an active status before rendering the control.
`chat.createScheduledWork` and `chat.setScheduledWorkPaused` are also
project-scoped and non-queueable. Create requires mutation access
(`viewerAllowed: false`); Pause/Resume is a viewer-allowed recovery control,
matching Cancel. The Swift UI renders Pause/Resume when the pause descriptor is
invokable; it does not render schedule creation. For a
personal session, the same checks and calls map to runtime-scoped
`personalChats.cancelScheduledWork` / `personalChats.setScheduledWorkPaused`.
Those actions are in the personal allowlist and are non-queueable, so an older
brain or offline phone keeps the corresponding control read-only.

The usage commands are viewer-allowed project actions:

- `usage.getQuotaSnapshot` reads the host's cached Claude/Codex quota windows
  without doing provider or ledger work. `usage.refreshQuota` runs a bounded
  quota-only refresh with interactive host authentication disabled. Work shows
  a compact provider-icon summary using the host's percent-used values directly.
  Settings mirrors the desktop cards with provider icons, usage-threshold
  colors, reset countdowns, source/freshness/error state, explicit refresh, and
  external links to the Claude and Codex usage pages.
- `usage.getAdeStats` returns the same stale-while-revalidate activity snapshot
  used by desktop Stats, including daily points and `desktop` / `mobile` /
  `tui` / `web` client attribution. The phone uses it for the Activity mode of
  the Work new-chat carousel rather than duplicating the full desktop Stats
  page. Pull-to-refresh on the new-chat screen refreshes both quota and the
  currently selected activity range.

`MobileUsageQuotaStore` persists snapshots by host identity, rebinds on machine
changes, ignores an older in-flight response after a host switch, and clears
the visible snapshot when the active host is unknown or does not advertise the
quota actions. Provider credentials remain on the host. A legacy host therefore
stays connected in limited mode and shows update guidance instead of leaking a
different machine's cached limits.

## Implementation status (phone specifics)

| Component | Status |
|---|---|
| Xcode project setup | Implemented |
| Native SQLite3 + pure-SQL CRR | Implemented |
| WebSocket client | Implemented |
| Negotiated deflate with byte-identical legacy gzip fallback | Implemented |
| Bidirectional chunked envelopes with bounded 30 s reassembly | Implemented |
| Typed protocol version floor/mismatch guidance | Implemented |
| PIN pairing flow | Implemented |
| QR pairing payload (v3 smart URL) + camera scanner (`SettingsPairingScannerSheet`) | Implemented |
| Account launch gate + account machine directory | Implemented; sign-in is the primary PIN-less path, while signed-out launches can continue with QR + PIN, Nearby + PIN, or advanced SSH pairing |
| Account discovery + device-bound direct trust | Implemented; signed directory adoption, exact session-generation commit checks, direct trust retained across sign-out, fresh Relay proof per connection |
| SSH one-time pairing bootstrap | Implemented; explicit host fingerprint trust, JSON-stdin device grant, optional Keychain recovery credentials |
| One-time mobile machine-trust reset | Implemented; clears connection tokens/profiles after update while preserving account and stable device/DPoP identity |
| Device-bound pairing (DPoP, Secure Enclave P-256) | Implemented (`DpopKeyService`; signed proof on every paired hello) |
| Cloud relay (same-account `relay` transport, raced alongside LAN and Tailscale direct routes and ranked behind them) | Implemented; fresh in-memory account proof on every Relay connection, fetched concurrently with the socket upgrade and guarded by a per-machine single-flight dial registry |
| Project hub + machine project switching | Implemented, including Add project actions for browsing/opening existing Git repos, creating local projects, cloning GitHub repos on the paired machine, and removing projects from the list |
| Hub personal chats | Implemented; runtime-scoped list/create/read/send/interactive actions, owner-only scheduled-work creation capability, controller Cancel/Pause actions, per-host offline summary cache, explicit personal transcript subscriptions, native new-chat/model flow, Chat Info Cancel/Pause controls, and project/lane actions suppressed |
| Lanes tab | Implemented to live machine parity (with `devicesOpen`, multi-attach, stack canvas, stack-position/base-branch editing in Manage Lane, and template environment progress) |
| Files tab | Implemented with freely-editable workspaces (mobile read-only file gate removed) and a unified full-screen name + content search page (`FilesSearchScreen`) |
| Work tab | Implemented; live chat-event push from runtime, subscribed terminal input/resize control with `terminal_unsubscribe` on view disappear, in-app CLI session launcher (`work.startCliSession`) with camera-roll and pasted-image prompts, external provider-session browse/import (`work.listExternalSessions` / `work.importExternalSession`), message-to-continue on ended agent CLI rows, fixed cross-client activity carousel above the new-chat composer |
| PRs tab | Implemented; driven by `prs.getMobileSnapshot` |
| Settings tab (pairing / appearance / diagnostics) | Implemented |
| Automations / Graph / History tabs | Planned |
| Full Settings parity | Planned |
| Lock Screen widget | Implemented; one prioritized account status across signed-in machines/projects, agents, PRs, sync, offline, and idle states |
| Push notifications (APNs alerts + exact cross-machine deep links) | Implemented (on-device E2E needs a physical iPhone) |
| Account-wide Live Activity + Dynamic Island (`ADEAgentActivityWidget`) | Implemented; one prioritized activity per phone (push-to-start / background updates verifiable on-device only) |
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
- **Personal chats are the exception to project-DB reads.** Their durable state
  belongs to the machine scope, so iOS reads summaries through
  `personalChats.list`, caches them per host, and streams transcripts with
  `chatScope: "personal"`. Never merge those summaries into the selected
  project's CRR tables.
- **Project selection gates hydration.** A phone paired to a machine can
  know about multiple machine projects, but lane/file/Work/PR reads must
  stay scoped to the active project id. If a switch fails, roll back the
  active project id, machine profile, token, and remote DB version together.
- **Keychain items survive app uninstall on some iOS builds.**
  Pairing forget should both clear Keychain and clear the draft row;
  the Settings tab's "Forget machine" flow does both.
- **The release trust reset is intentionally narrower than an account reset.**
  `MobileTrustResetPolicy` clears every connection token plus machine-scoped
  drafts/profiles, selected-project state, pending operations, cursors,
  descriptors, hidden projects, and reconnect pause once. It preserves Clerk
  account keys, the stable device id and DPoP identity, analytics preferences,
  and pairing-PIN state. The completion marker is written only after Keychain
  token clearing succeeds, so a failed Keychain operation retries next launch.
- **Device-bound direct trust and account-bound Relay access have different
  lifetimes.** A successful signed directory adoption creates the same
  machine-scoped direct credential as QR, Nearby, PIN, or SSH pairing. Sign-out
  removes directory and Relay authorization but retains that direct credential,
  so LAN and Tailscale reconnects keep working; "Forget machine" is the user
  boundary that deletes it. Never make a QR/Nearby/SSH profile Relay-dependent
  just because the same Mac later appears in the account directory. On account
  loss, disconnect Relay and retry direct routes. Treat transient
  account/directory failures as retryable, not as logout. The directory's
  `online` flag is only its 90-second publisher lease: if a row still contains
  a verified secure endpoint, the phone may dial it and let the authenticated
  hello decide liveness. A final 401/403 after one forced refresh is the
  credential-expired boundary; a timeout, server error, or temporary verifier
  outage is not.
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
- **A request timeout is not the same as a dead connection.** The default 30 s
  `SyncRequestTimeout` (120 s for `chat.send`) never tears the socket down
  directly. If
  anything has arrived on the WebSocket within the 12 s
  `requestTimeoutReconnectSilenceSeconds` window (heartbeats, change
  batches, a result), the timeout surfaces to the caller and nothing
  else happens. If the socket has been fully silent, the phone runs the shared
  active transport probe and tears down only when the probe also hears
  nothing. The probe waits 5 s on ordinary paths, 8 s on expensive paths, and
  12 s on constrained paths. Heartbeat silence enters the same probe instead
  of opening a second recovery loop. New transport-affecting code should bump
  `lastInboundMessageAt` on inbound traffic and treat that timestamp
  as the source of truth for "is this connection actually alive".
- **An attempted live chat send is never replayed automatically after an
  ambiguous failure.** The runtime may have started the turn even when the
  command result times out or the socket closes. iOS restores the exact text to
  the mounted composer, marks any optimistic echo failed, and asks the user to
  check the transcript before sending again. Messages composed while already
  offline may still enter the existing queue with a stable `commandId`; this
  special case applies only after a live `chat.send` was attempted.
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
  non-resumed subscribe ack resets the phone's watermark. Host handoff
  carries the per-session high-water mark forward, so a new host does not
  reuse a previously issued `(sessionId, seq)` pair. The host treats optional
  `chat_event` sends as delivered only when the socket accepts them; on
  backpressure it leaves the transcript offset unchanged and retries in
  order. Events without `seq` (older hosts) bypass the watermark entirely.
- **`seq` is a resume cursor, not an event identity.** Older hosts reset the
  counter across desktop restarts while the durable transcript kept being
  appended, so legacy transcripts can contain two events numbered 67 hours
  apart. The phone's dedupe is first-key-wins over file order, so keying
  `AgentChatEventEnvelope.id` on `sessionId:sequence` made the newer event look
  like a replay of the older one and silently discarded it — on a real
  425-event transcript that destroyed 103 events,
  including the `approval_request` envelopes carrying AskUserQuestion cards
  (the phone showed no question at all) and 31 short text chunks (short text
  has no content dedupe key, which needs >= 24 characters, so it fell through
  to the sequence-derived id and a reply rendered mid-word). The envelope id
  now includes the timestamp, so a genuine redelivery — identical timestamp
  *and* sequence — still collapses while cross-epoch collisions are broken
  apart. Blocking gates go further and dedupe on their host-assigned
  session-unique `itemId` in `SyncService.chatEventContentDedupeKey`
  (`approval_request`, `structured_question`, `pending_input_resolved`),
  because a dropped gate is not a cosmetic loss — it is a card the user never
  sees and can never answer. Host-side, `readTranscriptHydrationState`
  (`agentChatService.ts`) now seeds a rehydrated session's `eventSequence`
  from the transcript's maximum instead of restarting at 0, while
  `syncHostService.ts` carries its wire-sequence high-water marks through host
  handoff. Current hosts therefore keep `(sessionId, seq)` pairs unique across
  rehydration. Phone-side identity remains timestamp-qualified so old
  transcripts and older hosts stay compatible.
- **Transcript history pages through an opaque cursor.**
  `chat.getTranscript` responses carry `nextCursor`; the phone's
  `fetchChatTranscriptPage` requests strictly-older history with it.
  Current full agent runtimes also return `cursorKind: "byte"` for their
  append-stable logical JSONL offsets; the phone merges those pages locally
  rather than treating the cursor as a dense array index. Older hosts and the
  minimal headless fallback retain the legacy index merge. The default fetch
  budget is 500 messages / 600k chars.
- **Chat subscribe requests a 256 KiB snapshot window.** The phone sends
  `chat_subscribe` with `maxBytes: 262_144`
  (`syncChatSubscriptionMaxBytes`) so chat switches stay fast; the ack's byte
  cursor and automatic `chat_history` pages make the full transcript reachable
  without putting it all on the critical path. When the
  runtime responds with `truncated: true`, the phone calls
  `mergeChatEventHistory` instead of `replaceChatEventHistory`: the
  existing cached events are unioned with the truncated snapshot,
  deduplicated by `id`, and re-sorted by `(timestamp, sequence)`.
  The host installs a hydration barrier before reading the snapshot and
  resumes its live transcript pump from the pre-capture byte offset only after
  sending the ack, so an event appended during a slow snapshot cannot arrive
  before the ack or disappear between the snapshot and live stream.
  Non-truncated snapshots take the replace path. Both paths run through
  `deduplicatedChatEventHistory` and then through `trimChatEventHistory`,
  which caps retained events at `chatEventHistoryMaxEvents = 1_000`
  (up from the previous 500-event cap) so very long chats don't evict
  their own recent turns on reconnect.
- **The capped live-event ring advances from the previous tail.**
  `WorkLiveTranscriptCache` treats the previously rendered tail envelope as
  the continuity anchor and maps only the newer suffix when the 1,000-event
  ring slides. Count/head equality is not a continuity check once the ring is
  full. A missing tail or out-of-order replacement forces a rebuild; ordinary
  one-event slides must remain O(delta) so old streaming text is not replayed
  and duplicated on every tick.
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
- **Turn delivery and recovery are provider-neutral on Work.** Mobile mirrors
  desktop and ADE Code by decoding the durable message-delivery lifecycle,
  `turn_health`, `turn_recovery`, `turn_diagnostics`, and legacy provider
  events in `RemoteModels.swift`, then mapping them through
  `WorkEventMapping.swift`. Accepted-but-unprocessed user messages remain
  visible and expose Run next / Edit / Dismiss only when the host advertises
  `chat.resolveUnprocessedMessage`; those resolutions are durable and
  idempotent across reconnects. Stalled rows preserve the `sourceSessionId`
  from child chats and expose Wait / Nudge / Retry / Resume through
  provider-neutral `chat.recoverTurn`, with the Codex-specific action retained
  only as a compatibility fallback. Raw moderation checks are not rendered as
  repeated cards: counts and any integration failures are summarized in one
  quiet turn-diagnostics disclosure. Web-search events also carry
  provider action metadata (`query` / `queries`, `title`, `url`,
  `snippet`); Work keeps those in the enriched web-search tool card so
  URLs are visible without duplicating the same event as a second row.
  MCP tool events decode provider-neutral app/server/action metadata so cards
  name the connected app instead of `mcp`. Generated/viewed-image events from
  Codex and other adapters reuse compact tool cards; data URIs are never printed
  into the timeline, and stored/mobile compaction byte counts become a short
  "preview omitted" detail.
- **Tool telemetry is disclosed from turn status, not repeated through the
  mobile transcript.** `WorkChatSessionView` keeps assistant narration,
  reasoning, provider-specific cards, and `WorkChangedFilesPanelView` rows in
  chronological order, but filters normalized `toolGroup` rows from the visible
  timeline. The live `WorkActivityIndicator` and each `WorkTurnEndMarkerView`
  open the corresponding activity in `WorkTurnActivitySheet`. The live row uses
  `ViewThatFits` so narrow phones retain the activity verb and monospaced elapsed
  time without squeezing tool details into the same line. The association is
  data-driven and never invents file changes for providers that did not emit
  them.
- **Active-turn send and Stop use dismissing native popovers.** For Claude,
  the in-session composer mirrors desktop's three delivery choices: **Send
  during turn**, **Send after turn**, and **Interrupt & send**. The primary
  button's icon/label communicates the selected behavior, the chevron opens a
  custom SwiftUI popover, and selection dismisses it immediately. Non-Claude
  providers keep the single stage-behind-turn action. When the host advertises
  additive `chat.interruptWithQueueMode`, Claude Stop likewise becomes a split
  control for **Stop & clear queue**
  and **Stop only**; the per-chat choice is stored in `UserDefaults`, carries
  VoiceOver labels and haptics, and falls back to legacy Stop against older
  brains. Immediate send still stages once on the host before
  `chat.dispatchSteer`; if dispatch fails, the one queued message remains and
  the draft is not restored as a duplicate.
- **The Work context meter treats completed compaction as a usage boundary.**
  `RemoteModels.swift`, `WorkEventMapping.swift`, and the persisted JSONL parser
  retain `context_compact.postTokens` plus the automatic `context_usage.state`.
  `workContextUsageViewModel` in `WorkTimelineHelpers.swift` walks the ordered
  event stream, clears usage from before a completed compaction for Claude,
  Codex, OpenCode, Cursor, and Droid, and rejects generic `tokens` / `done`
  counters from the compacted turn. A compact start renders an ellipsis with
  `compacting`; a completion without exact post tokens becomes
  `recalculating`; a failed authoritative read shows `unknown` rather than a
  stale percentage. Exact post-compaction tokens or a later measured snapshot
  refill the meter immediately.
- **Subagent lifecycle is rendered as chat structure, not event spam.**
  `RemoteModels.swift` accepts both legacy `subagent_started` /
  `subagent_progress` / `subagent_result` events and the canonical dotted
  `subagent.started` / `subagent.progress` / `subagent.completed` forms.
  `WorkChatSessionView` keeps the roster out of the transcript head; the
  roster lives in Chat Info, while the compact composer badge remains the
  at-a-glance entry point. `WorkTimelineHelpers`
  (`buildWorkSubagentTimelineRows`) collapses the raw lifecycle ticks into
  the same durable structure the desktop transcript uses — one spawn row
  and one result row per real subagent anchored where it started and
  ended, and a single finish chip for backgrounded shell commands —
  mirroring `deriveSubagentTimelineRows` in `chatSubagents.ts` so a
  subagent never repaints per tick. `WorkChatRichCardViews` renders those
  rows plus the unified Chat Info sheet, whose ordered Subagents /
  Background / Schedule sections mirror the desktop Chat Info pane —
  including the same active caps (12 / 8 / 10), the single **Completed**
  disclosure that folds terminal rows without reordering survivors, and
  the per-session Clear/Restore filter (persisted under
  `ade.chat.paneCleared.v1:<sessionId>`). An active durable scheduled row has a
  native Cancel button when the host supports `chat.cancelScheduledWork`;
  provider-only/non-durable rows and older hosts remain read-only. The Schedule
  header also shows the next wake and exposes Pause/Resume when the current chat
  scope advertises `setScheduledWorkPaused`. The actions call
  `SyncService.cancelScheduledWork` / `setScheduledWorkPaused`, then refresh the
  session summary so cancellation confirmation, pause state, and `nextWakeAt`
  come back from the brain rather than being guessed locally. A run of two or more
  interrupt-stopped subagents folds into one `WorkSubagentStoppedGroupCardView`
  (`.subagentStoppedGroup`, mirroring the desktop `SubagentStoppedGroupCard`):
  a calm "N agents stopped when you interrupted" line that expands to a
  per-agent list, and tapping a row reopens that subagent's detail.
- **Long Work chats must keep row work and root polling cheap.** The
  destination seeds its render-ready presentation cache synchronously before
  the first SwiftUI body; the async opening load fills only missing state unless
  a force-fresh open was requested, and “Session unavailable” appears only
  after that authoritative load completes. Cached mapped transcript rows and
  canonical fallback rows are mutually exclusive, avoiding duplicate retained
  arrays. Work-list rows render their preview and activity timestamp from the
  equatable render signature instead of recomputing them in `body`. The
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
  paging and `chat_subscribe` resume. Assistant preview classification is
  computed from the authoritative full message and stored with the preview:
  unfenced wireframe glyphs or layout-dominant aligned columns select the
  fixed-width renderer, while fenced code and Markdown table rows keep their
  dedicated Markdown renderers. A bounded tail reuses that full-message
  classification, and when it begins inside a fenced block it restores the
  original opening fence (including its language) so the closing fence and
  following prose still parse correctly.
- **Work assistant rows use `messageId` as their cross-source identity.**
  Canonical transcript entries and live `chat_event` frames can carry both
  `messageId` and provider `itemId`, but the two paths did not historically
  choose them in the same order. `workAssistantMessageStableId`
  (`WorkEventMapping.swift`) now prefers the trimmed `messageId` everywhere
  and falls back to `itemId` only for providers that omit it. Canonical mapping
  (`WorkErrorAndMessageHelpers.swift`), typed live-event mapping, and raw JSONL
  replay (`WorkTranscriptParser.swift`) all use that helper, so live/canonical
  reconciliation updates one assistant row instead of rendering a duplicate
  whose partial streaming text appears cut off. `buildWorkChatMessages`
  (`WorkErrorAndMessageHelpers.swift`) tracks a
  `previousEnvelopeWasAssistantText` flag and allows merging into the
  previous assistant bubble when either (a) the text event has an
  `itemId` or (b) the immediately preceding envelope was also assistant
  text. This keeps the iOS Work chat from fanning a single assistant
  turn into many tiny rows.
- **Assistant fragments merge the same way whatever their source.** Live
  `chat_event` frames carry a `sequence`; rows from `chat.getTranscript` do not.
  Both go through `mergeWorkStreamingText`, because the host now guarantees the
  canonical text is byte-identical to what the phone renders from the same
  fragments (see
  [Canonical assistant text](../chat/transcript-and-turns.md#canonical-assistant-text-fragile--read-before-editing)).
  A client-side guard that treated every sequence-less envelope as a *complete*
  message was tried and removed: `getChatTranscriptPage` can split one message
  across two byte-cursor pages, so both chunks arrive without a sequence and
  neither is whole — keeping only the longer one silently dropped part of the
  answer. Fix disagreements on the host, not with a client rule that has to
  guess what a sequence-less envelope contains.
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
  together; the Claude picker order mirrors desktop (Fable 5, Opus 5,
  Sonnet 5, Haiku 4.5, Opus 4.8 1M, Opus 4.7 1M) and legacy Sonnet 4.6 /
  basic Opus 4.7 selections normalize forward instead of appearing as
  rows, while the generic `opus` alias resolves to Opus 5. The OpenAI picker
  always promotes GPT-5.6 Sol, Terra, Luna in that
  order even when a host returns another order; Sol is the fallback default
  and GPT-5.5 remains below them. The phone prefers host-advertised reasoning
  tiers/defaults in their original order and falls back to Light / Medium /
  High / Extra High / Max / Ultra on Sol/Terra and through Max on Luna
  (`low` for Sol; `medium` for Terra/Luna). `shell` remains valid runtime-side but the phone no longer
  offers a plain-shell launch. `SyncStartCliSessionArgs` also carries
  an optional `reasoningEffort` field that the runtime forwards to
  `buildTrackedCliLaunchCommand`, so the phone can launch a Codex /
  Claude CLI session at a non-default effort tier without going
  through the desktop.
- **Codex CLI launches receive the initial prompt as argv, not PTY
  echo.** Image attachments prepend the same `Attached files and images:`
  temp-path manifest as desktop; attachment-only launches send that manifest
  without synthetic message text. Other providers receive the same composed
  `initialInput` as bytes typed
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
- **Account device ownership is epoch-ordered.** `AccountService` persists a
  positive JavaScript-safe `ownershipEpoch` in the App Group and includes it on
  every authenticated account device PUT/DELETE. A direct account switch is
  two committed transitions (`old owner → nil → new owner`), registration PUTs
  are serialized/latest-wins, and a Relay `409` is terminal because a newer
  owner boundary already superseded the request. Do not replace this with task
  cancellation: cancellation cannot recall an HTTP request that already
  reached Relay. Relay stamps that same epoch into account Live Activity
  attributes and content. `LiveActivityService` and
  `ADEAgentActivityWidget` accept account details only when both payload epochs
  match the durable current owner; a mismatch ends in-app and renders neutral
  extension copy until cleanup.
- **Account routes must retain `accountMachineKey`.** Attention destinations,
  APNs payloads, Live Activity `Run`/`PullRequest` rows, and their element-level
  links carry the canonical account machine key. `DeepLinkRouter` threads it
  into `WorkSessionNavigationRequest` / `PrNavigationRequest`, and navigation
  selects or adopts that exact machine before opening the session, pending
  item/event, PR, or PR tab. Missing keys remain valid only for legacy/local
  payloads.
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
  on the host, so re-sends after auto-resolution are safe). The strip can
  also be minimized to a one-line pill (`collapsedPendingInputId`) that names
  what is being asked; the gate stays open and the composer stays locked, and
  the collapse expires on its own as soon as a different gate becomes primary
  because the boolean is derived from the stored id rather than synchronized
  alongside it.
- **Size a pending-input card from the chat surface, never from the
  transcript viewport.** The transcript and the composer inset split the same
  surface, so the viewport shrinks exactly as the card grows — budgeting off
  it is self-referential and the card walks itself up to full screen. The
  budget input is `chatSurfaceHeight = max(240, scrollViewportHeight +
  composerLayoutHeight)`, whose sum does not move when the card resizes, and
  `workPendingInputMaxHeight(chatSurfaceHeight:)` derives the cap from it.
  The composer reserve inside that helper is a constant for the same reason:
  `composerLayoutHeight` already includes the strip being sized. The card's
  own chrome (provider row, tab strip, freeform field, Send/Decline footer)
  is measured and subtracted so the scroll region absorbs overflow; when the
  irreducible chrome still exceeds the budget on a small phone with the
  keyboard up, the overflow lands on the transcript rather than the footer,
  because the composer inset is `fixedSize(vertical:)` and the transcript is
  the flexible sibling. That view ordering — not the number — is what
  guarantees Send stays reachable.
- **Mobile keeps unsent text; it is a store, not view state.**
  `WorkDraftPersistence.swift` holds `WorkComposerDraftStore` (composer text
  per chat plus fixed Hub / New Chat keys) and `WorkQuestionDraftStore`
  (in-progress question selections, freeform, and page per request id), both
  versioned JSON dictionaries in App Group `UserDefaults`, LRU-capped, saved
  on a 400 ms debounce and flushed on disappear because a cancelled `.task`
  throws out of its sleep before the write. Three rules are load-bearing:
  restore only into an empty field (a failed send that put its text back, or
  a card already mid-edit, is fresher than disk); clear synchronously on send
  rather than letting the debounce get there, or a jetsam inside that window
  resurrects an already-sent message and invites a duplicate; and never write
  an `isSecret` answer, because that defaults suite is shared with the widget
  extension and would hold a credential in plaintext. Clearing a host profile
  deliberately does **not** touch these stores — `forgetHost()` has no UI
  caller and fires automatically from `handleReconnectFailure` on an
  attributed auth failure, and the stores are keyed by session id rather than
  by host, so wiping them would destroy unsent text for every other paired
  machine plus the machine-independent Hub and New Chat drafts.
- **Optimistic steers reconcile on the active-to-idle turn boundary.**
  A message the phone sends mid-turn is echoed as an optimistic "Sends
  after turn" row (`WorkQueuedSteerRow`) using the host-assigned steer id
  the `chat.send` ack returns. Those graduate out when the host's
  `deliverNextQueuedSteer` folds them into the next turn — but if the
  graduation events never reach the phone, the row would linger forever.
  `WorkSessionDestinationView` watches the effective chat status (derived
  through `workChatTranscriptPreferenceStatus`, which downgrades a
  stale-active row to idle via the fresher `liveTurnActiveHint`) and, on the
  active-to-non-active transition, runs `reconcileOptimisticSteersAfterTurnEnd`:
  a forced canonical transcript refresh, then drop any optimistic steer the
  reachable host no longer lists as pending. It never drops while the host is
  unreachable or the refresh came back empty, so a transient gap cannot erase
  a genuinely queued message.
- **`ActivityDrawerModel.dismissVisible(in:)` persists dismissals
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
