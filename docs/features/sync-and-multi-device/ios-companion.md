# iOS Companion

The ADE iOS app is a native SwiftUI client. It works in two ways, and the
person sees the same tabs in both:

- **With a computer.** The phone is a controller for an ADE runtime
  (`ade serve`) on one of the person's computers. It reads synced state from a
  local SQLite database and sends commands to the runtime over WebSocket. The
  desktop renderer is another client of the same runtime.
- **With no computer.** ADE Cloud is one machine that every signed-in account
  has. The phone reads saved chats, copies, Git summaries, files and history
  from the account server and GitHub. It wakes a cloud computer only to do
  work. See [ADE Cloud on the phone](#ade-cloud-on-the-phone).

The phone never runs agents.

The Work model picker includes GPT-6.2 Sol and GPT-6.2 Astra in its offline
fallback. Sol is the default for a new Codex chat. Both models expose reasoning
through Ultra and Fast mode; runtime-advertised efforts and service tiers take
precedence. Older explicit model IDs retain their original meaning.

## Connect Your Phone

The phone connects to a **machine**, not to a desktop window. It shows the
machine's account-wide custom name, else the computer name from its publisher.
LAN, Tailscale and Relay are connection details, never part of the name.

1. Sign in to the same ADE account on the phone and the computer. This is the
   main path: the computer shows through the account directory, and the phone
   adopts it through Relay with no PIN.
2. For a direct recovery connection, open **Connections** on the computer. The
   **This Mac** card owns the PIN and the QR. On the phone, scan the QR or pick
   the Mac from Nearby. There is no link paste and no manual address entry.
3. Enter the 6-digit PIN. The phone gets a per-device secret in Keychain, so a
   reconnect does not ask again.
4. Pick a project. The machine keeps one sync listener on a stable port; a
   project switch changes which project host owns the connection.

A signed-out launch always shows the account choice first; there is no
account-less mode. A phone with a paired host may choose **Continue to your
work** to read cached work while signed out. A pairing whose credential cannot
be read offers **Pair again**. QR, Nearby and SSH pairing are connection flows,
not a guest mode.

### Account settings and vault boundary

- **Settings and secrets.** The phone uses only the settings and push-preference
  commands the host advertises. It never receives vault values: provider API
  keys, Linear OAuth credentials and account secrets stay in the host's
  encrypted vault. The host migrates device-local credentials; the phone copies
  no secret.
- **Sign-out.** Sign-out closes Relay, blocks saved Relay routes and clears
  account authorization, then tries the direct routes. It keeps direct trust
  (paired secret, DPoP key, profile) for a LAN or Tailscale reconnect. **Forget machine** is the only trust delete. A Clerk or
  directory outage is not a logout.
- **Leaving the account.** "Sign out of this iPhone", or a sign-in as another
  account, also removes the account's computers and runs
  `SyncService.resetLocalReplicaAfterAccountLeft`. The replica file and its
  site id go, so the reset writes no change rows that could sync back. It also
  empties the offline rosters of unpaired computers, the App Group snapshot,
  the Activity drawer, the last project route and work queued for a removed
  computer. A computer paired by code stays and syncs again from the start.
- **Adoption.** A signed-in machine is adopted over LAN, Tailscale, then Relay.
  LAN and Tailscale need the host's Ed25519 key in the directory row and a
  verified sealed `ade-adopt-v1` challenge before the phone releases the
  account credential; an unsigned host stays Relay-only. The account token is
  in memory only, added to each Relay hello, and never saved with the machine.
- **Which secret the phone keeps.** `syncResolveAccountHelloPairedSecret`
  mirrors `resolveAccountHelloPairing`
  (`apps/desktop/src/shared/accountDirectory.ts`). A `hello_ok` with no
  `accountPairing` means "keep your credential": the phone uses the secret it
  holds for that identity, from the profile or from Keychain
  (`machine:<identity>`). An `accountPairing` with another device's id, no
  secret or an explicit null is refused. The host side is *Adopting a manual
  pairing into an account* in [the sync README](./README.md).
- **Cipher.** The phone offers `chacha20-poly1305` and `aes-256-gcm`. The host
  picks the first mutual one, echoes it in `account_challenge_ok` and signs it
  with the challenge, so a peer cannot downgrade it. A host with no `aead` uses
  ChaCha20-Poly1305. With no mutual cipher, the phone releases nothing and asks
  to update ADE on both devices.

### Pair with SSH

SSH pairing is a one-time bootstrap for a Mac that has ADE. The phone takes a
Nearby machine or a host or Tailscale address, port and macOS username, then:

1. signs in with a private key;
2. shows the Mac's `SHA256:` host-key fingerprint for trust on first use, and
   refuses a changed one later;
3. runs `ade sync pair-device --json-stdin`, with the phone's public DPoP
   identity in JSON stdin;
4. saves the result as a normal pairing. Sync never uses SSH after that.

Keys: Ed25519 OpenSSH (encrypted or not) and unencrypted ECDSA P-256, P-384 and
P-521. Citadel 0.12.1 cannot decrypt encrypted ECDSA keys. RSA is refused. A key
is kept only for the session, unless the user turns on SSH recovery; then the
key and passphrase go to Keychain behind the current biometric set and never
sync to the account.

One machine token works over LAN and Tailscale and for all the machine's
projects. `siteId` is a per-project detail, never a machine's visible identity.

## ADE and ADE Beta

Two apps build from this project:

- **ADE** (`com.ade.ios`, `Debug` and `Release`) gets stable releases.
- **ADE Beta** (`com.ade.ios.beta`, `Beta`) gets every beta from
  `ios-testflight.yml`. `ADE_BETA_APP` selects its App Group
  (`group.com.ade.ios.beta`, in `ADESharedContainer`), `release_channel: beta`,
  the name "ADE Beta", the orange `AppIconBeta` and `ade-beta://`
  (`DeepLinkRouter` routes it like `ade://`). It has no App Clip.

The two apps share no data, keychain items or pairings, and both connect to
Stable and Beta machines. They share one build-number sequence, so
`MIN_SUPPORTED_MOBILE_APP_BUILD` means the same for both. See
[the plan](../../plans/ios-beta-app.md).

## Host version compatibility

A new phone must still connect to older brains in the supported wire range,
because the connection is how the person learns the host needs an update.

- **Protocol range.** The phone accepts
  `syncProtocolMinSupported...syncProtocolVersion` (now `1...1`). Outside it,
  the host sends a typed `protocol_version_mismatch` (received, minimum and
  current versions, `updateTarget`) and then closes with `4406`. The phone
  stops retrying and says whether to update the Mac or the iPhone.
- **Feature level.** In range, `hello_ok` may carry
  `features.mobileCompatibility`: `full`, or `limited` (connected, with missing
  actions gated on the phone). A host that omits it is treated as limited, not
  as a failure. Settings shows "Machine update recommended" for a limited host
  (`SettingsConnectionHeader`).
- **Missing actions** fail before they are queued or sent, with an "update ADE
  on the machine" message.
- **Update another machine.** A machine whose ADE is behind on its own
  update track gets **Update** / **Update & restart** on its Settings row
  (Settings › General's "Every machine" list and Settings › Machines read one
  store, `MachineUpdateStore.swift`), with **Update all** when several are
  behind and an attention line before the confirmation ("Mac Studio can update
  to 1.2.130").
  - The phone asks `machine.updateImpact` first and names what the restart
    stops (chats mid-turn by name, the open CLI sessions and terminals), then
    sends `machine.updateAndRestart`. A host that does not advertise both keeps
    its "update ADE on that computer" state.
  - A machine that answers `updateInstallMode: "manual_download"` (a Linux
    AppImage, or an install that cannot replace itself) shows **Download the
    update** instead.
  - The newest build per track comes from the account directory's
    `GET /releases/latest` (the release manifests when signed out). A machine
    only gets a build of its own track. The version it comes back on settles
    an answer lost to the restart. An ADE Cloud computer updates itself, so it
    is never offered.
- **App Store check.** `AppUpdateAdvisor` checks the public listing at most
  once in 6 h, also on foreground. A newer version shows a low-priority banner
  with Update and a per-version Later. A missing listing or a network error is
  silent. Settings diagnostics shows both versions and a manual check.

### Chat Info

- **Scheduled work.** Cancel shows only for an active durable row when
  `canInvokeChatRemoteAction` confirms the chat's host advertises
  `chat.cancelScheduledWork`. The command is non-queueable, so an offline phone
  or an older brain leaves Chat Info view-only. Pause and Resume use the
  viewer-allowed `chat.setScheduledWorkPaused`; create is owner-only and has no
  control on the phone. For a Hub personal chat, `chatActionName` maps these to
  the `personalChats.*` descriptors.
- **Account row.** `WorkChatAccountNote` is pinned at the end, like the desktop
  drawer footer. It shows the provider logo and the account email from the
  chat's `instanceId`, read from `providerAccounts.list` on the chat's own
  machine (a roster connection for another machine; no connection, no row). A
  saved key or custom provider reads "API key" or "Custom provider". When this
  device may call `chat.switchAccount` (controller-allowed) and another account
  exists, the row opens "Run this chat on" with each account's room left. It
  waits while a turn runs. A same-machine quick look at another project's chat
  is read-only until it activates. For another machine,
  `canInvokeChatRemoteAction` reads that host's phone policy.
- **Sections** follow the desktop drawer: each header has its icon and tone,
  and a section with only finished rows folds to one line ("Subagents · 2
  done"). A subagent with an open card in the parent reads **needs you**
  (`workWaitingSubagentKeys`). The pending card names its asker ("`<name>`
  asks") and, for several cards, "Waiting: a · b · c +N more".

## Slim mobile chat wire

The phone sends `mobileChatSlimV1` in its hello. The host then applies three
rules from `apps/desktop/src/shared/chatMobileSlim.ts`. Other clients get the
full wire, and the transcript does not change. On a measured 16.1 MB thread,
`tool_result` (23.1%), `subagent_progress` (19.8%) and its `subagent.progress`
twin (15.2%) held most of the bytes.

- **Drop the `subagent.progress` twin.** The host writes a dot-family twin of
  each underscore lifecycle event (`buildCanonicalAgentChatRuntimeEvent`), and
  iOS decodes both into `.subagentProgress`. A twin is dropped only when the
  underscore original was the previous progress event sent. Dot-family
  progress with no original (an older build) is kept.
- **Progress is state.** iOS never makes a row from `subagent_progress`. The
  `chat_subscribe` snapshot keeps the latest one per agent, and the live stream
  sends at most one per agent per second (last write wins; dropped when a
  result supersedes it). `subagent_started` and `subagent_result` are never
  folded. A progress event sent after a newer event has no `seq`, because the
  client drops `seq <= lastSeq` and the resume watermark must stay on the newer
  event.
- **Fetch tool results.** The phone gets 2 KB of each result (the shared cap is
  16 KB) plus the true size and `resultTruncatedForMobile`. Expanding the row
  sends `chat_tool_result` (`sessionId` + `itemId`, scoped like `chat_history`:
  the peer must be subscribed and the chat scope must match). `SyncService`
  caches the result per item. "Could not read it" and "no longer in the
  transcript" are different answers.

## In-thread subagents have a card, not a transcript

A subagent inside a thread (a Claude or Codex native Task) has no transcript.
Its card shows the label, model, status, latest summary and result. The spawn
and result rows are flat rows, not buttons; Stop is the only action on a
running spawn. A Chat Info roster row expands that agent's details in place.

A spawned child chat is a full chat. Its Chat Info row (task id
`chat:<childId>`) opens it through the "open parent" navigation request, with
the lane id from the child's Work row, so a child on another machine opens on
that machine.

## Startup diagnostics collapse to one row

`foldingWorkDiagnosticCards` (`WorkTimelineHelpers.swift`) folds a run of two
or more diagnostics cards (each `turnDetails` receipt and routine warnings:
Codex config, hooks, rate limits) into one line, for example `1 warning · 2
optional integrations unavailable`, which expands to each sentence. Danger
notices (auth, thread errors) and actionable ones (a reset credit, a host sleep,
a spawn chip) keep their rows. A lone card shows as a normal card. Desktop and
web do not change.

## The model pill names the model, and Custom harnesses are selectable

- **Label.** The pill reads its label from the live `chat.modelCatalog`, as the
  desktop picker does: "DeepSeek V4.1 Flash", not the route id, with the
  upstream maker's mark. With no catalog yet, it shows a prettified id.
- **Custom.** The picker rail starts with **Custom** when the host advertises
  `account.getMachineInventory` and the surface can pass a preset id. It lists
  the machine's saved harnesses with the desktop mark, the `Harness · model`
  line, and "Set up on the machine" when the source is missing. A pick passes
  `presetId` to `chat.create`, `chat.launch` or `work.startCliSession`, and
  the pill shows the preset's name and mark.
  Presets stay on the machine: the phone gets ids, names, models and the
  mark's identity (kind, provider id, accent), never keys or logo artwork.

## Free models on the phone

The phone reads the same free-models block as the desktop (`freeModels` in
`ai.getStatus`; `docs/features/chat/composer-and-ui.md`), from the chat's
own machine (`Views/Work/WorkFreeModels.swift`).

- **Free page.** The picker rail has **Free** after Recents. Its rows carry
  the Free badge. With no OpenCode on that machine, the page offers **Get
  free models** (`ai.pinnedToolDownload`) and shows the progress
  (`ai.pinnedToolStatus`). The page's catalog reads, the download and the
  refresh after it all go to that one machine (`workModelCatalog(on:)`).
  The page shows also when the machine lists no other model.
- **New chat.** With nothing signed in there, a new chat starts on the free
  default. It is ADE's pick: it is not saved as the remembered model, an
  access-mode change keeps it ADE's pick, and nothing changes while a launch
  runs. A sign-in, or a machine with no free model, puts back the model the
  screen opened on. The default tries again after a download
  and after a sign-in on that machine (`WorkFreeModelsStatusStore.generation(for:)`).
- **Sign-in card.** A person who never signed in on that machine gets **Use a
  free model**, which also re-sends a turn that stopped on the sign-in. A
  failed model change keeps the card and sends nothing. The offer is read
  again when the machine reconnects.
- **Older machines.** A machine without the block, or without the actions,
  behaves as before: no Free page setup and no free default.

## Project layout

> The same Xcode project also ships `apps/ios/ADE/Debug/ADEInspectorKit/`,
> a DEBUG-only SwiftUI inspector that publishes per-frame element
> metadata (component id, source file/line, accessibility identifier,
> point/pixel frames) to the running app's data container so the
> desktop Apple Development tool can convert taps into source-anchored
> chat context. See [`features/apple-device/inspector.md`](../apple-device/inspector.md).

```
apps/ios/
├── ADE.xcodeproj/
├── ADE/
│   ├── App/
│   │   ├── ADEApp.swift, ADEAppDelegate.swift  # entry; APNs callbacks → PushNotificationService
│   │   ├── ContentView.swift        # account gate (with paired-host recovery), the Hub
│   │   │                            #   when no project is open, else the 5 tabs
│   │   │                            #   (ADERootTabBarVisibilityModifier), the "Still
│   │   │                            #   starting" inset and ProjectHostRecoveryScreen
│   │   ├── RemoteProjectAddSheet.swift, RemoteProjectAddSteps.swift # Add project
│   │   └── DeepLinkRouter.swift     # ade://, ade-beta:// and https://ade-app.dev/open:
│   │                                #   PR, session (WorkSessionNavigationRequest),
│   │                                #   device sign-in, `ade://activity[?state=]`,
│   │                                #   Linear; other links go to SendToMacCard
│   ├── Models/
│   │   ├── RemoteModels.swift       # Codable mirrors of shared types, lenient
│   │   └── ChatLaunchModels.swift   # mirror of shared/types/chatLaunch.ts
│   ├── Resources/
│   │   ├── DatabaseBootstrap.sql    # generated from desktop kvDb.ts (Database.swift
│   │   │                            #   has the matching ensureColumn migrations)
│   │   ├── SceneShell.html          # generated by
│   │   │                            #   apps/desktop/scripts/generate-ios-scene-shell.mjs
│   │   │                            #   (--check exits 1 when stale)
│   │   └── VoiceGlossary.json       # dictation cleanup glossary
│   ├── Services/
│   │   ├── SyncService.swift (+ extensions) # WebSocket client, command routing,
│   │   │                            #   pairing and account adoption, projections,
│   │   │                            #   terminals, chat push, personal chats,
│   │   │                            #   session.* lifecycle, project-host readiness,
│   │   │                            #   the session read chokepoint (localSessions())
│   │   ├── SyncService+Cloud.swift, AccountCloudStore.swift,
│   │   │   AccountCloudLaunches.swift, CloudServerClient.swift,
│   │   │   CloudAtRestReads.swift   # ADE Cloud: rows, wakes, queue, launches,
│   │   │                            #   catalog, sign-ins, overview, Git summaries
│   │   ├── SyncService+LinearAccount.swift # Linear through the account
│   │   ├── GitHubAccountCredential.swift, GitHubDirectClient.swift,
│   │   │   GitHubDirectClient+Contents.swift # GitHub straight from the phone
│   │   ├── SyncService+ChatLaunch.swift, ChatLaunchStore.swift # new-lane launches
│   │   ├── SyncService+MachineWake.swift, SyncMachineWake.swift # Mac wake prompt
│   │   ├── SyncRecoveryPolicy.swift # reconnect, roam, path change, foreground resume
│   │   ├── SyncConnectionRace.swift # one race over direct and Relay routes,
│   │   │                            #   route memory, relay dial single-flight
│   │   ├── SyncTerminalInputQueue.swift # ordered terminal input with ACK and retry
│   │   ├── AccountService.swift, AccountEmailAuthFlow.swift # Clerk account,
│   │   │                            #   ownership epochs, email sign-in-or-up
│   │   ├── AccountDirectory.swift   # account machines, install labels, relay clients
│   │   ├── AccountProjects.swift    # AccountProjectStore
│   │   ├── DeviceSignInApproval.swift # approve another computer's sign-in link
│   │   │                            #   (sheet: Views/Account/DeviceSignInApprovalSheet,
│   │   │                            #   anchor: Views/Components/WebAuthPresentationAnchor)
│   │   ├── Database.swift           # SQLite, pure-SQL CRR, offline caches
│   │   ├── KeychainService.swift, DpopKeyService.swift,
│   │   │   MobileTrustResetPolicy.swift, PairingQrPayload.swift # trust and pairing
│   │   ├── SSHBootstrapModels.swift, SSHBootstrapService.swift,
│   │   │   SSHCredentialStore.swift, SSHGeneratedKey.swift,
│   │   │   SSHHostFingerprintValidator.swift, SSHHostKeyPinStore.swift,
│   │   │   SSHPrivateKeyParser.swift # one-time SSH pairing
│   │   ├── PushNotificationService.swift, LiveActivityService.swift # APNs, Live Activity
│   │   ├── MobileUsageQuotaStore.swift # cached Claude/Codex quota per host
│   │   ├── MachineUpdateStore.swift # "Update & restart" for the account's other
│   │   │                            #   machines, the newest build per track, the
│   │   │                            #   attempt state ("Back on 1.2.130")
│   │   ├── PendingSessionSettleStates.swift, PendingAttentionClearStates.swift
│   │   │                            # local, never-persisted overlays over host-owned
│   │   │                            #   columns (a replicated write could undo a host
│   │   │                            #   refusal)
│   │   ├── ProviderAccountsStore.swift # providerAccounts.* calls behind AI accounts
│   │   ├── Dictation/               # SpeechDictationService, DictationController
│   │   └── AppUpdateAdvisor.swift   # App Store version check, at most once in 6 h
│   ├── Shared/                      # also compiled into the widget extension
│   │   ├── ADESharedContainer.swift, ADESharedModels.swift, ADESharedTheme.swift
│   │   ├── ADEAgentActivityAttributes.swift # Live Activity state + ownership epoch
│   │   ├── ActivityRowPresentation.swift # item → label/tone/glyph; mirror of desktop
│   │   │                            #   sessionStatusPresentation.ts and
│   │   │                            #   activityPresentation.ts (no SwiftUI)
│   │   ├── ActivityWidgetPresentation.swift # tone colours, lock-screen ranking,
│   │   │                            #   activityURL(for:)
│   │   └── AttentionActionIntents.swift # widget approve/deny/restart/retry
│   ├── Views/
│   │   ├── Activity/                # ActivityDrawerSheet, ActivityDrawerModel,
│   │   │                            #   ActivityRow, ActivityBellButton
│   │   ├── Account/                 # sign-in, access gate, connections
│   │   ├── Components/              # ADEDesignSystem (ADEConnectionDot,
│   │   │                            #   ADERootTabBarHiddenPreferenceKey), ADEUsageDesign,
│   │   │                            #   MachineRowView, ADEMobilePrimitives,
│   │   │                            #   ADEInstructionErrorCard, ADETechnicalDetailsFold,
│   │   │                            #   ADEStaleContentMarker, StartOnPicker, dictation
│   │   ├── Cloud/                   # CloudPaneSheet (Settings › ADE Cloud, over a
│   │   │                            #   computer or the account server), limits,
│   │   │                            #   sign-ins, sizes; CloudLaneAtRest (resting lane);
│   │   │                            #   CloudPhoneFormat ("ADE Cloud" names);
│   │   │                            #   CloudPreviews, CloudNoComputerPreviews,
│   │   │                            #   CloudAtRestPreviews (fixtures)
│   │   ├── Cto/                     # CtoRootScreen, CtoSessionDestinationView,
│   │   │                            #   CtoAccountCopy, CtoHomeChooser
│   │   ├── CursorCloud/             # Cursor Cloud fleet pane (CursorCloudPaneSheet,
│   │   │                            #   ...ToolbarButton, ...PaneStore, ...AgentList/
│   │   │                            #   DetailScreen, CursorCloudModels); every action
│   │   │                            #   runs on the host; shown only when the host
│   │   │                            #   advertises the fleet command
│   │   ├── Deeplinks/               # SendToMacCard
│   │   ├── Duo/                     # iPhone Duo and iPad layouts, DuoPreviews,
│   │   │                            #   DuoSplitPreviews
│   │   ├── Files/                   # FilesRootScreen, FilesDirectoryScreen,
│   │   │                            #   FilesDetailScreen, FilesSearchScreen,
│   │   │                            #   FilesWorkspacePickerDropdown
│   │   ├── GitHubIssues/            # GitHubIssuesPaneSheet, GitHubIssuesPaneStore
│   │   │                            #   (see docs/features/issues)
│   │   ├── Hub/                     # HubScreen (+ChatNavigation, +Selection),
│   │   │                            #   HubActivityState, HubRosterFilterBar,
│   │   │                            #   HubComponents (HubNoMachineState), HubQuickConnect,
│   │   │                            #   HubComposerDrawer, HubComposerFleetDestination,
│   │   │                            #   HubHeaderRow, HubStatusBand, HubPhoneLayout;
│   │   │                            #   account projects: HubAccountProjects,
│   │   │                            #   HubAccountCards, HubRemoveProjects,
│   │   │                            #   ProjectLocationScreen, DeleteProjectSheet;
│   │   │                            #   ProjectHostRecoveryScreen (mirror of
│   │   │                            #   shared/syncHostRecoveryUi.ts)
│   │   ├── Lanes/                   # LaneDetailScreen, LaneDetailSectionChrome,
│   │   │                            #   LaneDetailGitActionsPane, LaneManageSheet,
│   │   │                            #   LaneBatchManageSheet,
│   │   │                            #   LaneDeeplinkHelpers, LaneMoveSheet,
│   │   │                            #   LaneEnvInitProgressView
│   │   ├── Linear/                  # LinearPaneSheet, LinearPaneStore, issue screens,
│   │   │                            #   LinearConnectionScreen, LinearOAuthRunner
│   │   ├── PersonalChats/           # Hub-only projectless chats
│   │   ├── PRs/                     # PrsRootScreen, PrDetailScreen (PrDetailView),
│   │   │                            #   PrConversationDigest, PrDetailOverviewTab,
│   │   │                            #   PrDetailHeaderComponents,
│   │   │                            #   PrGitHubDescriptionParser,
│   │   │                            #   PrHelpers, PrModels, PrRowCard,
│   │   │                            #   CreatePrWizardView, PrTargetBranchPickerDropdown,
│   │   │                            #   PrDetailOverviewPreviews
│   │   ├── Settings/                # ConnectionSettingsView, SettingsRoute, the
│   │   │                            #   General/Chat/Providers/Integrations/Lanes pages,
│   │   │                            #   SettingsMachines (one ADE Cloud row),
│   │   │                            #   SettingsMachineRenameSheet, SettingsMachineUpdates
│   │   │                            #   (Update / Update all, the confirmation, the
│   │   │                            #   machine page's ADE card), SettingsPairingSection,
│   │   │                            #   SettingsPairingScannerSheet, SettingsPinSheet,
│   │   │                            #   SettingsConnectionHeader, SettingsUsagePage,
│   │   │                            #   SettingsUsageChart, SettingsProviderAccounts
│   │   │                            #   (SettingsProviderAccountsPage, ProviderAccountRow,
│   │   │                            #   ProviderAccountDetailPage),
│   │   │                            #   SettingsProviderAccountSignIn,
│   │   │                            #   SettingsProviderAccountsPreviews,
│   │   │                            #   SettingsPushDeliverySection,
│   │   │                            #   SettingsCloudAccountProviders, SSHPairingView
│   │   ├── Work/                    # see "The Work tab" and the sections below:
│   │   │                            #   WorkRootScreen (+Actions, +Selection),
│   │   │                            #   WorkRootComponents, WorkSessionRowCard,
│   │   │                            #   WorkSessionCanonicalState, WorkSpawnNesting,
│   │   │                            #   WorkSessionGrouping, WorkLaneOrder,
│   │   │                            #   WorkSelectionActionBar; WorkNewChatScreen,
│   │   │                            #   WorkNewChatMachinePicker, WorkLanePickerDropdown,
│   │   │                            #   WorkChatLaunch*, WorkLaneSetupTranscriptCard;
│   │   │                            #   WorkCloudMachine, WorkCloudAtRest (ADE Cloud);
│   │   │                            #   WorkChatSessionView, WorkSessionDestination*,
│   │   │                            #   WorkChatAccountNote, WorkChatRichCardViews,
│   │   │                            #   WorkPlanComposerViews,
│   │   │                            #   WorkChatComposerAndInputViews,
│   │   │                            #   WorkComposerTypedTriggers,
│   │   │                            #   WorkComposerSuggestionStrip,
│   │   │                            #   WorkComposerModelChips, WorkChatAttachmentTray,
│   │   │                            #   WorkComposerAttachmentStaging,
│   │   │                            #   WorkChatAttachmentPreviewSheets, WorkDrafts,
│   │   │                            #   WorkDraftScheduleSheet, WorkDraftPersistence,
│   │   │                            #   WorkContextUsageViews; WorkUsageActivityCarousel,
│   │   │                            #   WorkUsageSkyline, WorkUsageLimitsModule,
│   │   │                            #   WorkUsageLimitResume(+Views);
│   │   │                            #   WorkImportSessionScreen, WorkImportSessionRows,
│   │   │                            #   WorkImportSessionPreview, WorkImportActionBar,
│   │   │                            #   WorkExternalSessionAffordances;
│   │   │                            #   WorkArtifactTerminalViews, WorkProofSheet,
│   │   │                            #   WorkProofDrawerModel, WorkProofCitation;
│   │   │                            #   TerminalSessionScreen, SwiftTermSessionView;
│   │   │                            #   WorkPreviews (DEBUG fixtures)
│   │   └── WorkTabView.swift, LanesTabView.swift, PRsTabView.swift, FilesTabView.swift
│   └── Assets.xcassets/             # app icon, brand mark, provider logos
├── ADEWidgets/
│   ├── ADEWidgetBundle.swift        # registers the widget and the Live Activity
│   ├── ADELockScreenWidget.swift, ADEActivityHomeWidget.swift # lock and home widgets
│   ├── LockScreenPriorityStatus.swift # single-focus status with no account feed
│   └── ADEAgentActivityWidget.swift # Live Activity and Dynamic Island
└── ADETests/                        # ADETests.swift plus one file per area, for
                                     #   example SyncRecoveryPolicyTests,
                                     #   SyncTransportSelectionTests,
                                     #   SyncEnvelopeChunkAssemblerTests,
                                     #   PairingAndDpopTests, SSHBootstrapTests,
                                     #   ActivityRowPresentationTests,
                                     #   WorkSessionCanonicalStateTests,
                                     #   WorkSessionGroupingTests
```

Rules that live in these files:

- **Deep links.** A compact PR link changes the tab through
  `.adeDeepLinkRequested`. A session link is routed to the Hub or Work, also
  when it arrives at cold launch. A lane, file, commit, artifact, repo-branch,
  full PR or projectless Linear link posts `.adeSendToMacRequested`, and
  `SendToMacCard` sends it to a paired host with `deeplinks.open`. An unknown
  `ade://activity?state=` value is ignored.
- **Add project** shows on the Hub only when the runtime advertises
  `projectActions`.
- **Slash commands** in the composer come from the host's registry
  (`chat.getSlashCommands`), with a small static list for an older host or an
  offline fetch.
- **Pending-input cards.** The structured-question card and
  `WorkPendingInputHeightBoundedCard` (the other gates) share the height rule
  in Gotchas.
- **`WorkLaneOrder`** ports desktop `workLaneOrder.ts` and the
  `headerlessLaneIds` memo, including manual drag and handoff jobs that iOS
  does not have yet, because those two rules decide whether a lane keeps its
  header.
- **Cursor Cloud** reads `ai.cursorCloudFleet`. The toolbar button shows only
  with an open project, a confirmed Cursor connection and the advertised
  command. No Cursor credential is on the phone.
- **Settings** groups its list like the desktop: General, You, App, Project,
  System. Analytics is on by default, and dictation has no settings page.

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
  cap) and `.balanceNext` (`MobileUsageBalanceNext` — the account smart balance
  would give the next new chat, per provider, so the AI accounts rows can mark
  **Next**), Claude context lifecycle states, queue-aware Stop request DTOs, and
  host model rows including `defaultReasoningEffort`.
- `ADE/Views/Work/WorkModelCatalog.swift` and `WorkModelPickerSheet.swift` —
  host-first model catalog merge, GPT-5.6 ordering/defaults/visible tiers, Fast,
  and the Ultra usage warning. `workModelCatalogGroups` runs every group's
  providers through `workMergedProvidersByKey` — `WorkModelProvider.id` is its
  key and SwiftUI traps on duplicate `ForEach` ids, and *both* branches can
  collide (the plain branch passes host provider keys straight through; the Pi
  branch derives its key from subsection/model metadata rather than
  `provider.key`), so the merge belongs to the group, not to one branch. Same-key
  providers merge in first-seen order, keeping the first non-blank label.
  `WorkModelIdMatcher` is the prebuilt form of `workModelIdsEquivalent`: it
  hoists a needle id list into one lookup-key set so filtering a catalog is
  O(models) instead of O(models × ids). `WorkModelPickerSheet` caches the scoped
  catalog (`rawCatalogGroups` + `scopedCatalogGroups`, written only through
  `setHostGroups`) because `catalog` is read many times per body pass and the
  body re-runs on every search keystroke; `.onChange` on `availableModelIds` and
  `cursorAvailabilityMode` re-scopes from the raw copy, since those are `let`s
  the parent can replace while the sheet's `@State` survives. `ModelPickerListRow`
  is deliberately **not** `Equatable` / `.equatable()`: rows live in a
  `LazyVStack` so only visible rows diff, and `EquatableView` keeping the
  installed view value would also keep its captured closures (`currentModelId`,
  `lanes`, `onSelect`), making a sync update that arrives while the sheet is open
  invisible to a tapped row.
- `ADE/Views/Work/WorkEventMapping.swift`, `WorkTranscriptParser.swift`,
  `WorkModels.swift`, `WorkTimelineHelpers.swift`, and
  `WorkStatusAndFormattingHelpers.swift` — compact web/MCP/image mapping for
  both live Codable events and persisted JSONL fallback (including Codex
  structured web-search `results`, threaded onto the tool card's `Sources` chips
  and deduped against the action URLs), plus the Work context meter's
  provider-neutral measured/compacting/recalculating/unknown reduction across
  live and persisted history. `WorkTimelineHelpers.swift` also owns the
  provider-aware `workPresentedTimelineEntries` filter: compact tool/file
  groups stay visible, activity/task-update ribbons stay out of the mobile
  thread, and Claude prompt suggestions stay out of the visible Claude
  transcript while remaining in the raw timeline. It also owns
  `workPendingInputResolutions`, the first-receipt-wins `itemId` → resolution
  word map that gives question / plan / approval cards their inline outcome.
  `WorkErrorAndMessageHelpers.swift` owns the pending-input gate derivation —
  `workPendingInputSweepState`, `WorkPendingInputQueue`, and
  `deriveWorkPendingInputQueue` — whose swept-vs-open split is reconciled against
  the host by `WorkChatSessionView`'s `canonicalPendingInputs`.
  The Codex spending
  cap surfaces as a "Spending cap reached" note under the Codex row in
  `WorkUsageActivityCarousel`.
- `ADE/Views/Work/WorkThreadEntityRules.swift`, `WorkMarkdownViews.swift`, and
  `WorkChatHeaderAndMessageViews.swift` — the transcript's chip and typography
  rendering. `WorkThreadEntityRules.swift` is the Swift port of the desktop
  `shared/threadEntities.ts` rules and `WorkThreadEntityDirectory` holds the
  device's lanes, chats, Linear team keys, and the chat's slash registry (see
  [Chips on the phone](#chips-on-the-phone)). `WorkMarkdownViews.swift` sizes
  section headings clearly above the body (semibold, with extra top spacing) and
  caches entity-decorated inline renders by text plus lookup revision; a
  `workMarkdownForeground` environment override lets a user bubble's markdown
  brief paint white.
- `ADE/Services/SyncService.swift`, `ADE/Views/Work/WorkSessionDestinationView.swift`,
  and `WorkSessionDestinationView+Actions.swift` — host-advertised chat action
  dispatch, including provider-neutral `chat.recoverTurn` (with the legacy
  Codex action as a compatibility fallback), durable
  `chat.resolveUnprocessedMessage`, the additive
  `chat.interruptWithQueueMode` capability with legacy `chat.interrupt`
  fallback, and the non-queueable `chat.cancelScheduledWork` wrapper used by
  Chat Info.

#### Perceived latency in the chat surface

Three mechanisms keep the transcript feeling native. They are easy to regress,
because each one trades a simpler implementation for a property the eye notices.

**The user's own bubble paints on the tap frame.** Every other timeline change
goes through the 90 ms coalescing rebuild in `scheduleTimelineSnapshotRebuild`,
which is right for host deltas arriving 6-7×/s and wrong for the one change the
user just caused. `applyLocalEchoTailImmediatelyIfPossible` appends the echo to
the existing snapshot synchronously and retires any in-flight rebuild
generation, so a coalesced fold cannot overwrite the bubble it was built
without. Image sends echo *before* the upload: the composer's downscaled
`UIImage` renders behind an uploading state under an `ade-pending-upload://`
placeholder ref (`WorkPendingUploadPreviewStore`), swapped for the real host
path before the message is sent so the echo's dedupe key still matches the
transcript row that returns. The wait for those bytes is bounded (see the
composer-draft rules below), so an upload that never lands fails the send and
offers a retry instead of holding the echo at "Sending". `sending` releases when
the host accepts the message; the transcript/artifact/summary/session refresh runs behind the
composer, chained so two quick sends cannot interleave two transcript loads.

Because that makes back-to-back identical sends easy, echo suppression counts
represented rows rather than testing set membership — two sends of "continue"
share one dedupe key, and one matching transcript row must retire exactly one of
them (`workUnrepresentedLocalEchoMessages`).

**The transcript is a `UICollectionView`, not a `ScrollView`.**
`WorkChatTranscriptCollectionView` hosts a compositional list layout with a
diffable data source keyed by the timeline's own row ids, and every existing
SwiftUI row — bubbles, tool cards, subagent cards, the earlier-messages header,
the bottom gutter — renders unchanged inside a `UIHostingConfiguration` cell.
The reason is one property SwiftUI does not offer: UIKit compensates its own
content offset when a cell self-sizes away from its estimate, so a row
re-measuring above the viewport does not move the row the reader is looking at.
A `LazyVStack` has no such writer, and that missing writer was 88% of the
transcript's measured displacement. `WorkChatTranscriptHeightCache` keys a
measured height by row id + width + content revision, so a row scrolled back
into view is restored to the height the layout already believes it has instead
of re-measuring; the width changing (rotation) drops the cache wholesale.

Row identity is the collection view's identity. A row whose content changed
carries a new *revision* and is reconfigured — never deleted and re-inserted —
because an insert would take the measured height and the reader's anchor with
it. `workChatTranscriptRowRevision` computes that revision, and the timeline
presentation's own signature is built from the same function, so "did the list
change" and "is this cell's measured height still valid" cannot drift apart.

**One latch decides every scroll write.** `workChatFollowLatch` is a pure
function over `{following, inUserSession}` and a handful of events —
`reset`, `userScrollBegin`, `userScrollEnd`, `scroll`, `disclosureSettled`,
`sendMessage`, `jumpToLatest` — and is unit-tested on its own. A scroll frame
may only break follow *inside* a user session, which spans finger-down through
the end of momentum (with a 160 ms settle for a drag that reported none), so a
pin, a jump animation, and UIKit's own layout compensation cannot feed back
into the decision that authorized them. Exactly one function,
`performScrollWrite`, moves the viewport, and it refuses any write under 0.5 pt
— which is what makes the corrections below idempotent rather than a fight.

**Content inserted above the reader keeps the reader's row in place.** While
not following, the transcript holds an anchor: the topmost visible row and how
far its top sat from the viewport's top edge. It is re-sampled only from the
reader's own scrolling — never from a frame UIKit produced while compensating a
re-measure, which is the very displacement the anchor exists to undo. After a
snapshot apply, and again on every layout pass, the anchor is restored by
setting the offset so that row lands where it was. The restore is absolute
rather than incremental, so when UIKit has already compensated correctly it
writes nothing. The pass is caught by a `UICollectionView` subclass that
reports its own `layoutSubviews`: a cell self-sizing re-lays the list without
ever changing the controller's view bounds, and that is exactly the pass that
can move a row above the reader.

**A chat opens at the tail in one frame.** The first non-empty snapshot is
applied, laid out, and pinned to the bottom in the same pass — there is no
retry ladder and no quiescence timer. Hydration that lands afterwards is an
ordinary content change while following, and each one re-pins once. A
transcript shorter than the viewport renders from the top, which the collection
view does by construction.

**Follow survives the keyboard the same way a terminal does.** The keyboard,
the composer growing, and a card collapsing all arrive as a bounds change on
the transcript. Following stays glued to the tail; a reader who had scrolled up
has their anchored row put back, which survives a re-measure that a saved
offset would not. A pin is the app moving the viewport, so it waits out the
reader's whole interaction even when the latch says they are still on the tail
— writing an offset under a live finger is what killed flings.

**Revealing buffered history is scroll-back.** The near-top trigger requires
that the transcript is *not* following. Without that, the first geometry frames
— which report the top, and a content height that trivially "fits", because the
opening pin has not landed and the transcript has one row in it — spent the
whole buffered page before anything was on screen.

The eight bench cases in `ADEUITests/WorkChatScrollBenchUITests.swift` are the
acceptance test, reduced from the `com.ade.ios.scrollbench` trace. The trace's
`viewport row=<id> y=<pt>` line is the one that matters: `contentOffset` stopped
being a usable proxy for "did anything move" the moment UIKit started
compensating its own self-sizing, and it is emitted after the layout pass, not
from the `didScroll` UIKit raises mid-pass from a state no frame is composited
from.

**Assistant messages render whole.** There is no line or character budget, no
head/tail anchor to pick, no budget floor to preserve, and no "Show more" step —
the whole answer is in the transcript, so scrolling is the only thing a reader
has to do to read it. Plan review cards are the same: `WorkPlanReviewCard` used
to cut the plan at 400 characters behind a "View full plan" toggle and then hold
it in a 220pt scroll box, which showed part of a plan the reader is being asked
to approve.

**"Open full response" is a surface, not a repair.** The assistant message
context menu (`workAssistantMessageContextMenu`) offers Copy message and Open
full response; the latter presents `WorkOutputViewerScreen` — a monospaced,
line-numbered, lazily laid out reader with a wrap toggle, occurrence-counting
search, Copy all and the share sheet. Because nothing is cut in the transcript,
this is the searchable, independently scrollable view of a very long answer
rather than a way to see what was hidden. The boxed renderers
(`WorkStructuredOutputBlock`, `WorkDiffOutputBlock`, `WorkInlineDiffPreview`)
still clip at a fixed height with no inner scroller, and for those the viewer is
the only way to reach the rest: `workOutputBoxOverflows` decides whether a box is
clipping without scanning a long result to find out, and a clipping box opens the
viewer from its header *or* by tapping the clipped region. The viewer is
presented once per surface through `\.workOutputViewer` rather than by a
`fullScreenCover` on every transcript row.

**Copy is always the full content, never what is on screen.** Assistant
messages are no longer sliced, so a code block's copy is simply its own text and
the per-block ordinal resolution that existed to rebuild a slice is gone with it.
The rule still binds the surfaces that *do* show less than they hold: the
tool-result box displays its 500-character truncation while `copyText` carries
the whole result, and Copy message on an assistant row copies the whole message
rather than the rows currently laid out.

**Long replies cost O(tail), not O(message).** `parseMarkdownBlocksForStreaming`
already split prose at a stable boundary; syntax highlighting now does the same,
reusing an already-highlighted stable prefix split at the last line boundary
provably outside a block comment, backtick/triple-quote string, or HTML comment.
Attributes are applied by painting a role per UTF-16 position and appending runs
over immutable text — never by retaining an `AttributedString` index across an
attribute assignment, which is undefined. Streaming tail revisions render from
their own small cache instead of the shared 256-entry inline-markdown cache, so
one long turn cannot evict every completed message and force a main-thread
re-parse on scrollback; the final revision is promoted. All derived render
caches drop on `applicationDidReceiveMemoryWarning`.

Two properties make that O(tail) real rather than nominal. Markdown block ids
are position-stable (`markdown-block-<index>`), not content-derived, so a
delta does not hand the `LazyVStack` a new identity for a row that is still the
same row; content changes travel in a separate `digest` field that change
detection reads. And no derived text is recomputed per refresh: each message
carries a digest stamped by the (off-main) snapshot fold, and the presentation
signature hashes those digests plus each row's shape instead of re-hashing the
visible transcript's full text several times a second.

Deployment target: iOS 26+. iPhone, iPad and the iPhone Duo (iOS 27.1
foldable) share one design; only folds and the Duo's edge bar are Duo-specific.

### Large screens: iPhone Duo and iPad

`Views/Duo/` holds the adaptive layer. `.duoLayoutRoot()` (in `ADEApp`)
publishes `\.duoLayout`: `isWide` (the Duo's inner display or an iPad),
`hasFold`, `fold` (`sideBySide` = flat or book, `stacked` = laptop),
`isLandscape`, `hasEdgeBar` and `hingeAngle`. The outer display and other
iPhones are `compact` and use the same views stacked.

- **Edge bar.** On the inner display held landscape, iOS draws the trailing
  stack's toolbar as a vertical rail. `DuoAppTabsToolbar` puts the five tabs at
  its bottom; a screen's own actions sit at its top. The bar does not restore
  an item that was removed and declared again, so `DuoChatRail` declares every
  slot in every state. Content never runs under the rail
  (`duoInsetGroupedMargins()`, `duoLeadingColumnContent()`).
- **Panes at the hinge.** Chat Info, tools, the PR pane and CTO settings open
  beside the chat with the hinge as the divider (`DuoWorkSplit`,
  `DuoToolsPane`).
- **Live streams.** The live stage draws a simulator stream over the pane or
  the display, never inside the chat, with a placement per posture. See
  [Apple device: the phone](../apple-device/README.md#the-phone-watch-and-control).
- **Settings.** Landscape on the inner display shows the list and the page side
  by side (`DuoSettingsSplit`): two stacks, not a `NavigationSplitView`, which
  keeps a pushed page on top when another row is picked. A pick rebuilds the
  page from the row's title. Rows and the page shell are in
  `ADEKitSettings.swift`; each page shows its description under the large title
  (`ADESettingsPageIntro`). Machines comes first and the split opens on it.
  General shows "You" and "Primary machine" as panels whose rows open Account,
  Providers, Usage or Machines. Account shows who you are, "Your computers"
  (one ADE Cloud row, never a row per lane computer, and Manage connections),
  Email, Account ID, a GitHub hint and "Sign out of this iPhone".
- **Lists and details.** Lanes, PRs and Files use `DuoSplitScaffold`: side by
  side when wide, list then detail on a phone.
- **Folding.** Folding swaps the wide columns for the phone stack. The wide Work
  columns stay one moment, hidden with no bar items (`\.duoRailRetired`), so
  the edge-bar items leave with them. `DuoAdaptableTabShell` re-binds the tab
  bars after each fold or rotation.
- **Tent** shows the front screen sideways with the inner display off, so the
  layout is compact. Only laptop stacks.
- **Hinge angle.** `DuoHingeObserver` rounds the angle to a 5° grid (flat is
  180) with hysteresis. A raw value per sensor tick re-rendered the whole app.
- **Crash context.** `CrashReporting.setDisplayLayout` tags Sentry events with
  the display family, edge bar and fold, with one breadcrumb per change.
- **Fixtures.** `-adePreviewScreen duo-*` opens a fixture on any simulator
  (`DuoPreviews.swift`, `DuoSplitPreviews.swift`). The ADE Cloud fixtures are in
  `Views/Cloud/CloudNoComputerPreviews.swift`,
  `Views/Cloud/CloudAtRestPreviews.swift` and `Views/Cloud/CloudPreviews.swift`:
  - chats: `duo-cloud-chat-asleep`, `duo-cloud-chat-waking`,
    `duo-cloud-chat-queued`, `duo-cloud-chat-failed`, `duo-cloud-chat-sign-in`,
    `duo-cloud-chat-deleted`, `duo-cloud-deleting-soon`
  - refusals: `duo-cloud-refused-out_of_hours`,
    `duo-cloud-refused-too_many_awake`, `duo-cloud-refused-account_blocked`
  - new chat and lists: `duo-cloud-new-chat`, `duo-cloud-new-chat-setup`,
    `duo-cloud-new-chat-refused`, `duo-cloud-lanes`, `duo-cloud-work`,
    `duo-cloud-account-tabs`
  - lanes at rest: `duo-cloud-rest-lane`, `duo-cloud-rest-lane-unpushed`,
    `duo-cloud-files`, `duo-cloud-files-folder`, `duo-cloud-files-file`,
    `duo-cloud-files-no-access`, `duo-cloud-files-unpushed`
  - copies: `duo-cloud-session-copy`, `duo-cloud-session-copy-deleted`,
    `duo-cloud-shell-copy-deleted`
  - moves: `duo-cloud-move-asleep`, `duo-cloud-move-deleted`,
    `duo-lane-move`, `duo-lane-move-asleep`, `duo-lane-move-deleted`
  - CTO and Settings: `duo-cloud-cto-copy`, `duo-cloud-cto-copy-sheet`,
    `duo-cloud-settings-direct`, `duo-cloud-machine`, `duo-cloud-limits`,
    `duo-cloud-models`, `duo-cloud-plans`, `duo-cloud-sizes`,
    `duo-cloud-invite`

### Connection status UI

Every connection indicator reads `SyncConnectionHealth`
(`syncConnectionHealth(connectionState:prefersReducedSyncLoad:lastError:)`,
exposed as `SyncService.connectionHealth`), never the raw
`RemoteConnectionState`:

- `transport`: `disconnected`, `connecting`, `connected` or `unreachable`
  (only `.error` maps to `unreachable`). There is no "syncing" state; hydration
  progress is in `SyncDomainStatus`.
- `load`: `strained` when connected with `prefersReducedSyncLoad` on (recent
  timeouts), else `normal`.
- `lastFailureMessage`: shown only while `unreachable`.

| Transport | Load | Color |
|---|---|---|
| `connected` | `normal` | green (purple on the Settings dot) |
| `connected` | `strained` | amber |
| `connecting` | | amber |
| `unreachable` | | red |
| `disconnected` | | muted |

`SettingsConnectionPresentation.statusTint`, `ADEConnectionDot`,
`ADERootToolbarControls` and `SettingsStatusDot` share this mapping.

- **`ADEConnectionDot`** (`ADEDesignSystem.swift`) is a 44 pt button with the
  dot, the state and the machine name. It sits top-leading on every tab root and
  deep screen, and opens Settings. Screens show no offline or reconnect cards
  of their own. The Work top bar also has a Settings gear beside the bell,
  hidden in multi-select.
- **Hub.** With no bar, the Hub shows `HubNoMachineState`: "Cannot reach
  \<machine\>" (`.error`), "Disconnected from \<machine\>" (a saved credential,
  `canReconnectToSavedHost`) with **Reconnect**
  (`reconnectIfPossible(userInitiated: true)`) and "Connection settings", or
  "No machine attached" with "Connect Machine".
- **Which machine.** `syncConnectionSubjectMachineName` names the machine the
  current attempt targets while connecting or unreachable, and the attached
  host otherwise. Settings gets it as `connectAttemptHostName`, separate from
  `hostDisplayName`.
- **Route badge.** `HubConnectionPill` and `SettingsConnectionHeader` show
  `via LAN`, `via Tailscale` or `via ADE Relay` only after an authenticated
  connection, from `lastConnectedRouteKind`, which roaming updates. Other states
  show no badge. The pill has layout priority after the ADE mark.

### Machine naming and reachability

- **Name.** `AccountMachine.displayName`: the custom name, else the hostname,
  else a platform fallback. The Settings row's pencil opens
  `SettingsMachineRenameSheet`; **Use hostname** clears `customName`.
  `AccountService` updates the directory record after the PATCH, so rows refresh
  without a reconnect.
- **Install label.** `AccountMachine` decodes optional `channel` (stable, beta,
  alpha) and `adeHome` (at most 120 characters); a bad value drops only the
  label. `rowLabel` follows desktop `accountMachineRowLabel` ("MacBook Pro · ADE
  Alpha", with the host's own " · Alpha" removed). Connection lists, Hub
  quick-connect and Settings show `rowLabel`; rename and matching use
  `displayName`. `MachineRowView` truncates in the middle.
- **State.** In this order: **Asleep** (the machine announced sleep recently;
  this outranks a held socket), **Connected** (the active socket), **Online**
  (a current lease), else **Last seen …** or **Last seen unknown**. Route names
  stay out of these lines.
- **Power.** `accountMachinePowerClause` adds "82% battery", else "plugged in",
  else "on battery", else nothing (a Mac Studio has no battery), only from a
  fresh directory heartbeat. It must match `machinePowerPhrase` in
  `apps/desktop/src/shared/machinePresence.ts` word for word, and the staleness
  rule in `SyncMachineWake.swift` must match `resolveMachinePresence`,
  boundary included.

### Waking a sleeping Mac

`SyncMachineWake.swift` holds `SyncMachineWakeNeed` (`.asleep`,
`.unreachable`), `syncMachinePresence`, the 10-minute
`syncMachineSleepInferenceWindow` (the desktop's value) and the 24-hour
`syncMachineRecentlySeenWindow` that decides whether a prompt may say "asleep".

- **Dialing is the wake.** There is no wake packet. Wake runs the normal
  `pairWithAccountMachine` race; the traffic wakes the Mac. Only the budget and
  the words change: `SyncConnectionRaceBudget.wakingMachine` allows 25 s overall
  (standard 10 s; a measured clamshell wake is 16 s) and 22 s for relay ready
  (standard 7 s, kept under the overall budget). `restorePreviousConnection`
  resets to `.standard`. The stage reads "Waking <machine>…", and a timeout
  reads "It didn't wake up in time."
- **Card.** `ContentView` shows `MachineWakeCard` on `pendingMachineWake`, with
  a `confirm → waking → failed` stage machine in
  `SyncService+MachineWake.swift`. It uses `sheet(isPresented:)` so the stage
  changes under one id, cannot be dismissed while waking, and resolves to
  "don't wake" after 90 s. A failure keeps the card with **Try again**. In
  Settings a sleeping machine has an amber dot and **Wake it**
  (`MachineRowView.Affordance.wake`).
- **Links name the machine.** `AccountAttentionDestination` adds
  `accountMachineKey=<key>` to session and PR links (and the
  `https://ade-app.dev/open` mirror and widget links). A link with no key gets
  its owner from the attention snapshot, then the workspace snapshot, only when
  it came from outside (`WorkSessionNavigationRequest.Origin.external`); the
  cold-launch restore must not, or a relaunch switches machines.
- **Owned links.** A link with `accountMachineKey` and `projectId` goes through
  `DeepLinkRouter.routeOwned`: wait for the account (up to 10 minutes), connect
  the machine (Wake & open for a sleeping Mac), wait for the live project
  catalog (`projectForOwnedLink` trusts no cached list), open the project, then
  the item. A failure lands on the Hub with the failed step. Copy and share add
  ownership only for a canonical project id on the connected machine
  (`SyncService.deeplinkOwnership`).

### Tailscale-off route hint

`ADETailscaleOffHintCard` ("iPhone isn't on Tailscale") shows when turning
Tailscale on is the one fix. `syncShouldShowTailscaleOffHint(...)`
(`SyncService.tailscaleOffHintVisible`) requires all of:

- a saved credential and a Tailscale route in the profile
  (`profileHasTailnetRoute`);
- no tailnet self-address: `syncHasTailnetSelfAddress` looks for 100.64/10 or
  fd7a:115c:a1e0::/48 **on a `utun*` interface only** (carriers give CGNAT
  addresses to `pdp_ip*`);
- no live discovery hit for the profile;
- no saved full-URL relay candidate (Relay is a valid route, so Tailscale is
  then only faster);
- transport connecting, disconnected or unreachable, never connected.

The scan reruns on `NWPathMonitor` changes, on foreground and before
`enterUnreachableTerminalState` (whose error adds the Tailscale sentence). The
card shows in `HubNoMachineState`, `HubConnectingCard` and
`SettingsConnectionHeader` (`SettingsConnectionSnapshot.showTailscaleOffHint`).
Its action opens `tailscale://`, else the App Store page.

### Connection words and failure cards

- **Settings header.** "Live · ready to sync", "Live · machine responding
  slowly", "Connecting to saved machine", "Can't reach your machine" (with the
  `lastFailureMessage` banner), or a reconnect / pair-another-machine action.
  `SettingsConnectionPresentation.statusLabel` is "Connected" or "Connected,
  slow". There is no "Syncing" label.
- **Accessibility.** The dot's label is "Connected to <machine>", with "Machine
  is responding slowly" when strained and the trimmed `lastFailureMessage` when
  unreachable. `ConnectionHealthPresentation` takes only the health value and
  the host name. The hint is "Opens settings to pair or reconnect", with
  `accessibilityShowsLargeContentViewer()`.
- **Domain failure.** The one inline banner per tab is
  `SyncDomainStatus.inlineHydrationFailureNotice(for:)`, shown only for a
  `.failed` domain: a `SyncDomainFailureNotice` with a concrete title ("Couldn't
  load your chats"), a sentence that the rows are the last ones loaded, a next
  step, the host text in the technical fold, and Retry
  (`reload(refreshRemote: true)`), through `ADEInstructionErrorCard`. These
  cards hide while the project-host phase is not `ready`. Work's `isLive` also
  needs the project host.
- **Project host not ready.** On `host_unavailable` the phone reads `reason`,
  `conflict` and `recoveryEligible`. A verified conflict opens
  `ProjectHostRecoveryScreen` at once. A starting failure retries silently
  (2, 4, 8 s) behind one "Still starting this project's services…" banner with
  the cached rows and one `ADEStaleContentMarker`; then the screen takes over.
  **Fix connection** calls `sync.recoverHost` (stop the blocking runtime,
  restart the brain) and lists the steps. Retry stays live during a repair.
  **Switch Mac** is always there. When no repair is offered, the card says
  whether this iPhone may not stop the other runtime or ADE cannot identify it
  safely.
- **Failed turns** show an instruction card (title, sentence, next step,
  folded details with Copy) from `errorInfo.presentation`, else from the error
  category. A turn is never titled "Error" or "Unknown".
- **Files header.** `FilesHeaderStrip` adds "Syncing" (the Files domain is
  hydrating), "Connecting" or "Offline".

## Account projects on the phone

Signed in, the account's project list decides which projects the Hub shows. A
project is one GitHub repository; each computer can hold copies.

- **Reads.** `AccountProjectStore` (`Services/AccountProjects.swift`) reads
  `GET /account/projects?since=<cursor>` at most once in 60 s (10 s on
  foreground), with backoff, and keeps one cache file per account. `add` and
  `remove` show at once; a read that overlaps a change keeps the changed row
  and reads again.
- **Join.** Each machine card joins its account project by the brain's id,
  then the account copy table, then GitHub `owner/name`. A removed project's
  card hides. A project no reachable machine shows gets its own card, which
  opens in account scope (see [ADE Cloud on the phone](#ade-cloud-on-the-phone)).
  The saved order uses account project ids.
- **One card per project.** Other folders of the project are under the tile's
  "Other folders". A folder that is no account project shows under "Only on
  <computers>".
- **Hide and Remove.** Select offers "Hide on this iPhone" and Remove…, acting
  only on the filtered cards. Hide is phone-only
  (`ade.hub.hiddenOnPhone.v1|<account or machine>`), with "N hidden", Show and
  Show all. Remove… mirrors the desktop dialog (this computer, all my
  computers, or the account). Each `project_forget_request` goes on the link of
  the computer that holds the folder and never falls back to another machine
  (`hubRemoveCopy`). An offline computer keeps its folder; no answer shows "Not
  known". A removed folder stays off the list until the computer lists it again
  (`ade.sync.removedFromHostProjects.<host>`).
- **Start on** lists copies first, then computers that can get one ("Put a
  copy" clones from GitHub).
- **Links.** A link with `accountProjectId` opens the named copy, else a copy on
  the link's computer, else the first in Start-on order. A session link stays on
  its chat's computer. Signed out, the phone asks for sign-in first.
- **Privacy and versions.** The brain sends `accountProjectId` only to its
  signed-in owner and never sends the account user id. The fields are optional
  both ways.
- **Use for new lanes** sends `projects.setMainCheckout` (runtime scope,
  controller only) to the folder's computer. `published: false` means saved on
  the computer but not yet uploaded, and the phone says so. A brain without the
  action shows "Update ADE on <computer> to change this from your phone."
- **Publish to GitHub** (on by default at create) sends
  `github.publishCurrentProject` with the computer's own GitHub sign-in. A
  computer without the action shows the switch off with a reason.

### GitHub on the phone

The account's GitHub sign-in (the ADE GitHub App) lets the phone read PRs and
repositories from GitHub with no computer on.

- **Token.** `GitHubAccountConnection` (`Services/GitHubAccountCredential.swift`)
  reads `/github/app/status`, signs in in a web sheet (`/github/app/sign-in`,
  back on `ade://github/connected`) and gets a token from `/github/app/token`.
  The token is in the keychain (this device, no backup) for one account, until
  `useForSec` ends. An account switch, a disconnect or a new sign-in drops it
  and any answer in flight. If the keychain refuses the delete (locked),
  `ade.githubAccount.droppedTokenPendingDelete` keeps it pending; each load
  deletes first and never reads the record. After a 401 it asks once more with
  the rejected token's hash; a second 401 shows "GitHub connection ended".
- **Reads.** `GitHubDirectClient` sends `If-None-Match` (an ETag cache of 200
  pages), follows `rel="next"` only on api.github.com (5 pages per list),
  pauses background reads under 10% of the rate limit and waits for a reset.
- **Where.** The PRs tab reads GitHub when the project's computer is not
  connected: on show, then once a minute while in front. The project home shows
  the same list. Settings → Account has Connect and Disconnect (with "Revoke on
  GitHub"). Add project → From GitHub lists repositories directly when GitHub
  is connected or no computer is online.

## ADE Cloud on the phone

ADE Cloud is one machine that every signed-in account has. The phone shows it
next to the person's own computers. Each cloud lane has its own computer
behind it, but the phone never shows one cloud computer by name: every cloud
computer is "ADE Cloud" (`CloudLaneComputerLabels.label`,
`Views/Cloud/CloudPhoneFormat.swift`).

### The rule: reading never wakes, doing wakes

- **Reading** comes from the account server or GitHub, with no wake: saved
  chats, CLI and shell copies, Git summaries, files, history, the CTO copy,
  Linear, and Settings › ADE Cloud.
- **Doing** wakes the computer: a send, "Wake and open" on a changed file,
  "Wake to use it" on a copy, "Wake and move", and the Wake button. The wake
  never blocks the screen. The person can leave the screen or the app.
- `MachineFleet.connect(machineKey:timeout:wake:)` connects with no wake when
  `wake` is false: it connects only to a computer that is already up.
  `showsCloudLaneState` (`Views/Work/WorkChatSessionView.swift`) uses that for
  an opened chat or lane. It shows one state line: asleep, waking, deleted,
  wake failed, refused (the server's sentence), or "deleting soon" with Keep
  it (`POST /cloud/instances/:id/keep`).
- `beginCloudWakeIfAsleep` (`Services/SyncService.swift`) is the one waker. A
  second wake of the same computer waits for the first, because a wake costs
  money. `wakeCloudMachineIfNeeded` (`Services/SyncService+Cloud.swift`) sends
  it through a connected computer or through the account server itself.

### Account scope: the tabs with no computer

- A Hub card of an account project that no reachable computer holds opens the
  normal tabs in account scope (`SyncService.openAccountProjectScope`). The
  scope is saved in `ade.sync.activeAccountProjectId`. `activeProject` is then
  a synthetic summary with the id `account:<id>`.
- In account scope, a command for a computer throws "Pick a lane on a computer
  or on ADE Cloud." (`refuseAccountProjectScopeCommand`). The phone never
  queues it.
- Picking a project on a computer (`setActiveProjectId`) ends the scope.

### Work: new chats, saved chats and the queue

- **New chat.** The machine picker always lists "ADE Cloud"
  (`workNewChatCloudOption`, `Views/Work/WorkNewChatMachinePicker.swift`),
  also before the server answers. When the account is refused (out of hours,
  blocked), the option shows the server's reason and is disabled. ADE Cloud is
  preselected in account scope and when the account has no computer of its
  own. With ADE Cloud picked, the lane list shows the project's cloud lanes,
  and "new lane" is the default. The model chip opens the same
  `WorkModelPickerSheet` as every machine, fed by the server's catalog
  (`GET /cloud/models`, `cloudCatalog:`; `workModelCatalogGroups(cloudCatalog:)`),
  never the connected machine's list: provider rail, favorites, efforts and
  fast mode as anywhere else. The send uploads the first message's files
  (`PUT /cloud/launches/:launch/files/:file`, from the bytes on the phone),
  then starts a server launch that names them (`AccountCloudLaunchStore.start`,
  `POST /cloud/launches`); a failed upload is the launch's start error, and
  Retry sends the rest. Only a start that never reached the server (no
  client, a failed upload, a clear refusal) gives the draft back; any other
  start opens the launch's page.
- **The launch's page.** A started launch lists in Work as a row
  (`WorkCloudLaunchRow`) and opens a page with the route
  `ade-cloud-launch:<launch>` (`WorkCloudLaunchPendingScreen`,
  `Views/Work/WorkCloudLaunchViews.swift`). The page uses the parts of a
  normal chat launch (`WorkChatLaunchViews.swift`): the prompt bubble, the
  setup card (`WorkCloudLaunchSetupCard`) and the queue composer. A message
  sent there goes to `POST /cloud/launches/:launch/messages`; a retry of the
  same text keeps its message id. While the page is the only page on the
  phone's stack, the Work list keeps reading, so the new chat lists. Once the
  launch has a session, the phone reads the account again and connects the
  new computer (`SyncService.connectLaunchedCloudComputer`), then opens the
  chat in place of the page with any unsent text as the chat's draft. It
  never opens the chat after the person left the page.
- **Follow-ups at handover.** The server copies the launch's later messages
  into the new chat's own queue (`via_launch` rows) once the chat runs and its
  computer has a machine key, from the stage report or from the key's
  arrival. The chat's held messages then show each one, a failed one with its
  reason.
- **Saved chats.** `CloudServerClient.savedChats` reads pages of 200, at most
  5 pages. With no live link, a chat thread reads the saved copy through
  `AccountCloudStore` (`savedCloudChatAccountKey`), one part at a time.
  Scrolling up pages older parts with the server's `before` cursor
  (`olderSavedPage`); the saved lines carry their `sequence`, so the engine
  pages them like a `chatLogV2` host. A saved subagent chat nests
  under its parent. A computer that left the account still lists its saved
  chats under the key `cloud-saved:<accountMachineKey>`.
- **The queue.** A send to a cloud chat with no live link goes to
  `POST /cloud/chats/:machine/:chat/messages` with the `clientSendId` as the
  message id (`SyncService.sendChatMessage`). The server holds it, wakes the
  computer, and delivers it once. A chat whose computer was deleted continues
  on a new computer in the same chat row. A send with attachments wakes the
  computer and sends over the live link. An older server (404) falls back to
  wake, connect and send.
- **Held messages.** A send to an asleep chat looks like any send, as on
  desktop: the thread draws each held message as the person's own bubble at
  its end (`CloudHeldMessageRow`, `WorkCloudHeldThread` in
  `Views/Work/WorkCloudMachine.swift`), followed by the thread's working line
  while the server moves it. There is no queue bar and no "waking" copy; the
  header's cloud button shows the computer's state. Under the bubble:
  - queued: a quiet Cancel;
  - sending, or delivered: nothing;
  - waiting for a sign-in: "Waiting for a sign-in", with the sign-in step
    above the composer (`CloudQueueSignInSteps`);
  - failed: the thread's "Couldn't send" mark, the server's sentence, Put
    back and Dismiss.
  A message this phone saw open that the server calls delivered stays drawn
  until the transcript shows it (`AccountCloudStore.deliveredAwaitingThread`,
  at most 2 minutes), so it never blinks out. The transcript match is the
  `user_message`'s `clientSendId`, which the computer sets to the held
  message's id (`cloudHeldMessagesShown`; a computer that writes no send id
  matches on text written after the send, only for a message sending or
  delivered, never one still queued). A matched message is retired for
  good (`retireFromThread`): no second copy. One delivered before the phone
  looked is never drawn. Cancel goes to the chat's own account machine key;
  Put back and Dismiss only hide the failed message on this phone
  (`hideFailedMessage`). `AccountCloudStore.followQueue` reads the queue only
  while the chat is open and the app is in front, from 3 s up to 10 s between
  reads. A CLI copy with a deleted computer keeps the list above its composer
  (`CloudQueuedMessagesView`).
- **CLI and shell copies.** The project overview
  (`GET /cloud/projects/overview?origin=`, at most once in 15 s, in
  `CloudAtRestStore`, `Services/CloudAtRestReads.swift`) adds each saved CLI
  or shell session as a Work row with the id `cloud-copy:<machine>|<session>`.
  `CloudSessionCopyScreen` (`Views/Work/WorkCloudAtRest.swift`) shows the
  copy read-only, at the newest line. A shell keeps its last 5,000 lines.
  - Asleep computer: "Wake to use it".
  - Deleted computer, CLI: a composer. The message goes through the same
    queue, and the server continues the CLI on a new computer.
  - Deleted computer, shell: no composer. A shell can't continue on a new
    computer.
- **Move a chat.** Hand off › Another machine on a resting cloud chat opens
  `WorkCloudRestingMoveSheet`: "Wake and move" when the computer sleeps,
  "Write a message" when it was deleted.

### Lanes: at rest, and the lane move

- `laneDestination` (`Views/Lanes/LaneListViewParts.swift`) opens
  `CloudLaneAtRestScreen` (`Views/Cloud/CloudLaneAtRest.swift`) for a cloud
  lane whose computer is not awake. It has three cards:
  - **Git:** the summary the computer saved when it went to sleep
    (`GET /cloud/git/:machine/:lane`): branch, ahead and behind, changed files
    with line counts.
  - **Files:** the lane's branch from GitHub, one folder at a time
    (`GitHubDirectClient+Contents.swift`). Changed files have a mark. A
    changed file offers "Wake and open" or "Open the GitHub copy".
  - **History:** the pushed commits from GitHub, and a line for the commits
    that are on the lane only.
- The Lanes machine filter has one "ADE Cloud" chip for every cloud lane.
- **Move a lane.** The lane detail's ⋯ menu has "Move to…" when the lane has
  an open Work chat (`LaneMoveSheet`, `Views/Lanes/LaneMoveSheet.swift`). The
  move sends `chat.startCrossMachineBatchMove` to the lane's own computer
  through one of its chats (`SyncService.startLaneMove`): the lane, its
  commits, its uncommitted work and its open chats move together.
  - The places are the person's own computers. An offline computer, or one
    without the project, shows disabled with the reason.
  - ADE Cloud shows as one disabled place: "ADE Cloud can't take a moved lane
    yet. Pick one of your computers." No action moves a lane onto a new cloud
    computer.
  - A resting cloud lane moves from its saved copy with no wake, as on the
    desktop (see [ADE Cloud › Move this lane to](../ade-cloud/README.md#the-life-of-a-lanes-computer)).
    When the saved copy is not complete, or the server refuses the delete,
    the sheet offers "Wake and move".
  - A lane whose computer was deleted moves from the kept lane
    (`cloud.restoreKeptLane` on the destination).

### CTO, Linear and Settings

- **CTO.** When the CTO home is asleep or offline, "Read where <name> left
  off" opens the CTO account copy (`GET /cloud/cto?origin=`,
  `Views/Cto/CtoAccountCopy.swift`): open work, notes, routines and the last
  turns, read-only. A message to the CTO wakes its home.
- **Linear.** When no computer answers for the project,
  `SyncService+LinearAccount.swift` reads Linear through
  `POST /cloud/integrations/linear/query` with the account's Linear sign-in.
  A pane load reads at most 2 pages, because the server allows 30 Linear and
  Jira requests a minute. Linear writes still need a computer. iOS has no
  Jira pane.
- **Settings › ADE Cloud.** With no computer, `CloudPaneStore.reloadDirect`
  (`Views/Cloud/CloudPaneSheet.swift`) reads `/cloud/account`,
  `/cloud/instances` and `/cloud/limits` directly. Limits are written with
  `PUT /cloud/limits` and `ifRevision`. Sign-ins come from `/cloud/sign-ins`,
  which returns status only, never a secret. A provider that signs in on ADE
  desktop (Antigravity) shows "Signed in from ADE desktop" when its login
  carried to the account. Qwen takes an API key.
- **Settings › Machines** shows one ADE Cloud row ("N lane computers, M
  awake"), not one row per cloud computer.

### Old servers and old computers

- A 404 or a missing route keeps today's behavior and never shows an empty
  state. A failed read keeps the last answer.
- A computer without `chat.getCrossMachineHandoffOptions` and
  `chat.startCrossMachineBatchMove` shows "The computer this lane is on needs
  an ADE update to move a lane from the phone."

## Architectural pattern

- **Views:** one SwiftUI view per tab, with `@StateObject` sync state and
  local `@State`.
- **Services:** `DatabaseService`, `SyncService` and `KeychainService`
  singletons. `ADEApp` injects `SyncService` as an `@EnvironmentObject`.
- **Models:** plain Swift structs (`RemoteModels.swift`) decoded from JSON.
- **Navigation:** a root `TabView` with five tabs (Work, Lanes, PRs, Files,
  CTO), a `NavigationStack` per tab, Settings as a sheet, and deep links.

## Database: native SQLite + pure-SQL CRR

Source: `apps/ios/ADE/Services/Database.swift`. The phone uses system SQLite
through the `SQLite3` C API, with cr-sqlite done in pure SQL (see
`crdt-model.md` for why the extension cannot load on iOS).

First launch:

1. Create `Application Support/ADE/ade.db`.
2. Load `DatabaseBootstrap.sql` (generated from desktop `kvDb.ts`). It includes
   CRR-safe cleanup, for example the dedupe of `lane_linear_issue_links` and
   the drop of `uq_lane_linear_issue_links_role` before triggers, and the
   `pull_request_chat_sessions` table (a PR can keep several chat edges).
3. Register `ade_next_db_version`, `ade_local_site_id` and
   `ade_capture_local_changes`.
4. Call `enableCrr(for:)` on each non-internal table (INSERT, UPDATE and DELETE
   triggers).
5. Save a stable site id at `Application Support/ADE/secrets/sync-site-id`.
6. Replace the old disposable cache DB if it exists.

Retired tables (the execution-process tables and the removed AI review schema)
are dropped before CRR discovery, and changesets that name them are ignored.

**Every column desktop can write must exist here.** A changeset with an unknown
column fails on the phone, which nacks the whole batch and stops sync until an
app update. `Database.swift` mirrors each replicated column with
`ensureColumn` (nullable, no unique index, because `crsql_as_crr` refuses
non-PK unique indexes), whether or not a view reads it. The `pull_requests`
block (detach and merge metadata, `merge_conflicts`, `behind_base_by`) is the
example.

Reads are plain SQL and work offline. Writes go to the local DB first;
`SyncService.exportChangesSince` sends the `crsql_changes` rows over the
WebSocket. `Notification.Name.adeDatabaseDidChange` follows each write that
changes visible state, with the touched table names when known, so
`SyncService` bumps only the affected projection revision.

## Sync service

Sources: `apps/ios/ADE/Services/SyncService.swift` and
`apps/ios/ADE/Services/SyncRecoveryPolicy.swift`.

### Connection lifecycle

1. **Launch.** Read the pairing secret from Keychain and the saved connection
   draft (machine identity, port, address candidates from the QR or discovery,
   saved relay candidates).
2. **Connect.** `reconnectIfPossible` owns every attempt: socket failures, path
   changes, foreground, heartbeat silence and failed probes all go through it.
   It coalesces overlapping wake-ups, guards delayed tasks with a connection
   generation, and never tears down a live connection.
   - **Direct candidates** (LAN, Tailscale, saved, loopback) first get raw-TCP
     probes in parallel (1.5 s, 3 s for Tailscale through a cold DERP relay).
     `syncIsTailscaleRoute` covers 100.64/10, fd7a:115c:a1e0::/48, `.ts.net`
     and the `ade-sync` alias. `SyncTailnetProbe` (every 45 s) probes only the
     saved ports plus `SyncTailnetDiscovery.probePortCandidates`, never the
     8787–8999 range of the recovery sweep. A phone with Tailscale off skips
     tailnet routes.
   - **Relay candidates** (`wss://…/connect/<machineKey>`) are whole routes,
     never part of the TCP probe or port sweep. They come from the QR and from
     `cloudRelayWssUrl` in `hello_ok` and `brain_status`
     (`savedRelayCandidates`); an explicit `null` clears them. They are
     eligible only when `relayAccountOwnerId` matches the signed-in account.
     Each Relay attempt gets a fresh in-memory account token, fetched in
     parallel with the upgrade (`async let`). A missing or different account
     reports a sign-in message without using the retry budget.
   - **One race.** Direct and Relay candidates enter one authenticated race,
     ordered `lan` < `tailnet` < `relay`. A trailing Relay candidate joins about
     300 ms behind the lead; a Relay candidate that is this network's proven
     route starts at t=0. Openers start 250 ms apart, at most three sockets are
     open, the race has a 10 s budget, and only a completed `hello_ok` wins.
     Each failure admits the next route. Every socket sends the same
     `peer.connectionAttempt`, so the host refuses a late loser. Pairing and
     reconnect use the same order.
   - **Relay ready.** Relay URLs add `ready=2`. The Worker sends `accepted/v2`
     at once and `ready/v2` when the pipe and the host listener exist; iOS sends
     no hello before `ready`. Deadlines: 350 ms for `accepted`, then 7 s for
     `ready` (a Durable Object may wake). A silent `accepted` gets one retry on
     a legacy URL only for an endpoint that never completed `?ready=2`
     (`negotiatedReadyV2`). A relay that accepts and never bridges fails inside
     the race. iOS never downgrades a `ready=2` socket.
   - **Relay single-flight.** A registry keyed by `<relay host>/<machineKey>`
     refuses a second parallel `/connect` for one machine (two tunnels use the
     Durable Object's 16-connection cap); it is not an endpoint failure.
     Foreground with a relay-capable machine warms the Clerk session.
   - **Wire options.** The socket declares `chunkedEnvelopes`,
     `binaryEnvelopes` and `foldedReplay`, offers zlib `deflate`, and accepts
     32 MiB frames. `binaryEnvelopes` sends compressed data as a binary frame
     (`SyncBinaryFrame`, `ADE1` magic) instead of base64, because
     `URLSessionWebSocketTask` has no permessage-deflate. `foldedReplay` folds
     streaming deltas in a `chat_subscribe` snapshot. Nothing changes until
     `hello_ok` confirms it.
   - **Pairing rejection.** `syncCodeIsPairingRejection` is `repair_required`
     or the older `auth_failed`. The phone drops the pairing only when the
     rejecting host names itself (`hello_error.host`) and matches, or when a
     finished race got only rejections from one host. A timeout or mixed
     failure keeps it. `account_not_signed_in`, `account_verification_failed`,
     `host_update_required` and `account_session_changed` never drop a pairing;
     the phone shows the host's message.
   - Settings shows a route-neutral status ("Connected in 0.3s"); the
     diagnostics row has the route.
3. **Hello.** The phone sends its `db_version` and `remoteDbVersionBySite`.
   `currentPeerMetadata` adds `appVersion`, `appBuild` and `bundleIdentifier`,
   which the runtime saves in the device registry. `hello_ok` returns
   `serverDbSiteId`, the project catalog, `connectionTransport` (`direct` or
   `relay`, which diagnostics trust over the URL label), and, when accepted,
   `compression: { codec: "deflate", thresholdBytes: 512 }` and
   `features.chunkedEnvelopes: { enabled: true, maxFrameBytes: 737280 }`. The
   `hello_ok` itself uses the legacy encoder.
4. **No project.** The Hub shows and subscribes to `roster_subscribe`. For the
   active project the roster also shows new lanes and chats before the CRR
   rows arrive; local rows replace them by id. Roster caches are keyed by
   machine identity, so equal paths on two machines never mix.
5. **Hydrate.** Lane and Work hydration run in parallel and gate the first
   screen; PRs run alongside. Foreground recovery runs presence, catalog and
   the three projections in parallel. A manual Work refresh loads lanes before
   sessions that name a missing lane. Each request carries its connection and
   project scope and checks it again before it writes; database replacement
   refuses a project mismatch (lanes, lane detail, Work, PRs, Files). A
   cancelled stale attempt restores the last completed status.
6. **Steady state.** Inbound work runs off the main actor (JSON, inflate,
   chunk reassembly, changeset apply, chat decodes; SQLite is FULLMUTEX), and
   frames apply in order. Chat payloads are gated on the raw dictionary
   (session id, subscription) before a `Task.detached` decoder
   (`syncDecodeChatEventEnvelope`, `syncDecodeChatSubscribeSnapshot`); after
   the decode the generation and subscription are checked again. Phone
   changesets are one durable pending batch; the cursor moves only on ack. A
   NACK or timeout retries it; after the budget the phone re-exports smaller
   windows (64 rows / 64 KB down to 1 row / 4 KB) with 1–30 s backoff.
7. **Disconnect.**
   - Seven fast attempts (1 s → 16 s with jitter) while health stays
     `connecting`, cached chats stay, and the composer says the draft is safe.
     Then `unreachable`, with a quiet 30–40 s retry that never stops.
   - `SyncReconnectFlapTracker`: three closes within 30 s of hello with one
     code and reason in two minutes back off 15 s → 5 min, with "<machine>
     keeps closing the connection right after connecting (<reason>). Retrying
     in N s."
   - `result_too_large` fails only that call: "This was too large to send to
     your phone".
   - PR hydration: `prs.list`, then `prs.refresh { prIds, includeSnapshots:
     "active" }` in batches of 25 for open and draft PRs and PRs on live lanes
     (skipped when none, because an old brain reads empty `prIds` as "all").
     Without `prs.list`, one `prs.refresh { includeSnapshots: "active" }`.
     Other snapshots load when a PR opens; a bounded refresh never prunes
     snapshots it did not ask for.
   - A good hello restores the project, chat and terminal subscriptions, lane
     presence and safe pending operations, without rebuilding navigation.
   - **Machine switch from Settings.** The Hub shows only when a `hello_ok`
     arrives from a machine other than the project's.
     `prepareForUserConnectionChange` saves the identity being left before
     `saveProfile`, and `syncHubTransitionIsOwed` compares against it. An
     explicit disconnect shows the Hub at once. Every switch resets terminal and
     chat subscriptions and history. A disconnect (also Cancel while
     connecting) cancels scheduled reconnects.
   - If iOS ends the app, a project route used in the last 24 h restores on
     launch, with the root pane and an open chat. Hub, sign-out or machine
     removal clears it.
8. **Lane presence.** The phone sends `lanes.presence.announce` for open
   lanes (`LaneSummary.devicesOpen`), `lanes.presence.release` on leave, and a
   30 s heartbeat (the runtime TTL is 60 s).

### Foreground resume

iOS suspends a background socket without a close event, so
`canSendLiveRequests()` only proves the socket object exists. `ADEApp` calls
`syncService.handleBackgroundTransition()` on `.background`, and
`handleForegroundTransition()` classifies the gap with
`syncForegroundResumeAction` (`SyncRecoveryPolicy.swift`):

| Background gap | Action | Behavior |
|---|---|---|
| ≥ 10 s (`syncSuspendedSessionBackgroundGapSeconds`) | `replaceSession` | Rebuild the session without a probe. |
| < 10 s | `probeSession` | Refresh, and run `verifyTransportAliveAfterSilence(trigger: "foreground_resume")` in parallel; no answer tears the session down. |
| none (cold start) | `refreshOnly` | Refresh only. |

- `replaceSession` calls `reconnectIfPossible(replaceSuspendedSession: true)`:
  the strength of the manual Reconnect (cancel the stale attempt, reset the
  ladder, sweep every candidate, pass the healthy-connection and in-flight
  guards) without its user-intent effects, so a paused auto-reconnect stays
  paused. After a suspension the "connected" socket and the "in-flight" attempt
  are usually dead, and the old route often died too.
- Every foreground resets the ladder (`reconnectState.reset()`), also from
  `unreachable`.
- `syncTransportSilenceRecoveryError()` makes the silence error for the
  heartbeat probe and the foreground probe. A socket close builds its own error
  with the close code.

### Switching machines, and what a failed switch costs

- **Attempt target.** `SyncConnectAttemptTarget` names the machine a user
  connect aims at. It is set at the start, kept after a failure (so the failure
  names the machine), and cleared on attach, on the next attempt and on
  disconnect. `syncConnectionSubjectMachineName` picks it while connecting or
  unreachable, through the account directory. The Hub pill, the Hub capsule and
  the Settings header all use it, and Settings resolves it once per snapshot
  as the card's `hostDisplayName`. A saved-machine restore points the target at
  the profile's identity first, because a tapped row can carry only an mDNS
  short name.
- **A failed switch keeps the old machine.** The old socket closes before the
  race (a half-open one keeps its heartbeat and restore loops alive). On
  failure `restorePreviousConnection` reconnects to the interrupted profile,
  points the attempt name at it and turns auto-reconnect back on. With nothing
  to restore, the saved profile still points back. This covers the saved-host,
  account-machine and sealed-adoption paths. A connect to the machine already
  attached returns early (over Relay, a rebuild would race its own tunnel), but
  still checks the account owner and learns new routes.
- **Reading the result.** Do not read success from `connectionState`.
  `reconnect(toSavedHost:)` returns whether that host was reached; the account
  path compares the attached profile's key. `lastConnectAttemptFailure` keeps
  the attempt's reason (the restore's `hello_ok` clears `lastError`), and
  Settings rows prefer it (`settingsMachineRowErrorMessage`). A row error goes
  only when the phone attaches to that machine
  (`settingsMachineRowErrorsRetiring`). A blocked Activity navigation records
  its reason the same way.
- **`SyncService.isAttached`** (`connectionState == .connected`) is the one
  attachment test; `SettingsPinSheet` and
  `syncAccountMachineNavigationIsCurrent` use it. `applyHelloPayload` sets
  `.connected` at `hello_ok`, and `beginPostHelloAttachment` (shared by
  `schedulePostHelloWork` and its DEBUG hook) republishes it. Only the backoff
  reset waits for the guarded completion.

### Route ranking, route memory, and roaming

Sources: `SyncConnectionRace.swift` (ranking, network fingerprint, route
memory, failure memory, relay dial registry) and `SyncRecoveryPolicy.swift`
(roam triggers).

- **Rank.** `syncRankedEndpointAttempts` orders by: not demoted, live
  discovery, transport class (`lan` < `tailnet` < `relay`), latest success.
  `syncEndpointAttemptsHoisting` then moves two remembered routes to the front.
  It only reorders the vetted list, so a refused route cannot come back.
  - `networkRouteMemory` (on `HostConnectionProfile`, in `UserDefaults` under
    `ade.sync.hostProfile`, at most 8, newest first) maps a network
    fingerprint to the route that last authenticated there. The fingerprint is
    `wired`, `wifi:<the phone's IPv4 /24 on en*>` or `cell` (no SSID
    entitlement needed). It leads.
  - `lastSuccessfulAddress` comes next.
- **Demote** (to the back, never removed):
  - Two or more failures in 120 s (`lastFailedAt`, `consecutiveFailures` on
    `HostConnectionEndpointState`); a success clears them. A cancelled or
    superseded attempt, a single-flight refusal, a missing account credential
    or a missing pinned relay key does not count.
  - With no Wi-Fi or wired interface: RFC1918, `.local`, link-local and
    unique-local IPv6. Tailnet CGNAT and loopback (the simulator) stay.
- **Roam.** A healthy connection re-races only for a reason, make-before-break:
  the live socket serves until a new one authenticates. `syncRoamTrigger` has
  two reasons:
  - **Failover:** the interface set changed
    (`syncNetworkPathInterfacesChanged`). Race every candidate after a 3 s
    floor.
  - **Upgrade probe:** a better class looks reachable (a Bonjour hit on a local
    path, or a tailnet address on the phone for a machine with a tailnet route).
    At most once in 5 minutes, only better classes, only for a connection at
    least 10 s old. New discovery results also run this check.
  - A standing fact (cellular with a tailnet route) is never a trigger. A race
    won by the route in use keeps the live socket. Roams have their own task,
    so the follow-up path update cannot cancel a scheduled failover.

### Message types

| Type | Direction | Purpose |
|---|---|---|
| `hello` / `hello_ok` / `hello_error` | both | Handshake |
| `account_challenge` / `_ok` / `_error` | phone ↔ runtime | Signed X25519 challenge and AEAD choice before sealed adoption |
| `pairing_request` / `pairing_result` | phone ↔ runtime | PIN pairing |
| `project_catalog_request` / `project_catalog` | phone ↔ runtime | Refresh the machine's projects |
| `project_switch_request` / `_result` | phone ↔ runtime | Prepare the connection for a project |
| `project_browse_request` / `_result`, `project_default_parent_dir_request` / `project_default_parent_dir` | phone ↔ runtime | Folder picker and default parent folder |
| `project_open_request`, `project_create_request`, `project_clone_request` (`_result`) | phone ↔ runtime | Open, create or clone a project on the machine |
| `project_list_my_github_repos_request` / `_result` | phone ↔ runtime | The machine's GitHub repositories for Clone |
| `project_forget_request` / `_result` | phone ↔ runtime | Remove a project from the machine's catalog |
| `changeset_batch` / `changeset_ack` | both | cr-sqlite batches (a far-behind phone may get the compact catch-up here) and per-batch acks; the sender retransmits on timeout |
| `command` / `command_ack` / `command_result` | phone → runtime → phone | Commands |
| `file_request` / `file_response` | both | Files |
| `terminal_subscribe` / `terminal_unsubscribe` / `terminal_data` / `terminal_history` / `terminal_input` / `terminal_input_ack` / `terminal_resize` | phone ↔ runtime | Terminals (rules below) |
| `chat_subscribe` / `chat_event` / `chat_history` / `chat_tool_result` | phone ↔ runtime | Chats (rules below) |
| `roster_subscribe` / `roster_unsubscribe` / `roster_snapshot` / `roster_delta` | phone ↔ runtime | The all-projects roster behind the Hub (rules below) |
| `envelope_chunk` | both, after negotiation | Slices of an envelope over 720 KiB |
| `heartbeat` | both | Health, every 30 s |
| `brain_status` | runtime → phone | Cluster authority broadcast |

**General.** Types are additive within the protocol range: the phone ignores
types it does not know (`rpc_*`, `fwd_*`), and a missing `hello_ok.features`
flag means unsupported. Compression uses system `zlib`: after the host picks
`deflate`, payloads of 512 bytes or more are deflated both ways; with no pick,
the phone keeps gzip at 4 KiB. `unwrapSyncCommandResponse` returns `result` or
throws an `NSError` with `ADEErrorCode`. `SyncEnvelopeChunkAssembler` allows 8
sets, 512 parts, a 128-byte id and 32 MiB buffered, refuses bad totals and
drops a set after 30 s; the phone sends chunks only after
`chunkedEnvelopes.enabled`.

**Terminals.**

- `terminal_data.offset` is the lifetime logical UTF-8 end offset (null only
  for a stream with no transcript), so a transcript rollover does not rewind
  it. The phone drops duplicates, trims UTF-8 overlap, and on a gap sends one
  guarded resubscribe from its watermark.
- `terminal_subscribe.sinceOffset` returns an append-only `delta: true`
  snapshot when the window still covers it, else a full snapshot that replaces
  local state. Snapshots carry `startOffset`, `endOffset` and `live: false`
  when no PTY backs the session (the phone shows a resume bar). The host's
  snapshot barrier queues live data during capture.
- `terminal_history { sessionId, beforeOffset, maxBytes? }` pages older bytes
  `[startOffset, endOffset)`, cut at a newline, ESC or UTF-8 boundary;
  `atStart: true` means the oldest retained offset. It needs an active
  subscription.
- `terminal_input` waits for the snapshot. With `terminalInputAck` it carries a
  stable `inputId`, one item in flight per session, an 8 s wait and 0.5/1/2 s
  retries inside the host's `retryWindowMs` (four attempts). The host dedupes
  `(device, session, inputId)`. Only `not_subscribed` retries (re-subscribe
  through the barrier, same id); other errors fail that item. A reconnect marks
  in-flight items unsent. When the budget ends, the phone says delivery is not
  confirmed and drops the item. Older hosts get one write with no retry.
- Phone resizes are not authoritative: the runtime restores the desktop size
  when the last phone leaves.
- **`rosterTerminal`.** A host with `features.rosterTerminal: { enabled: true }`
  accepts the terminal envelopes on a roster connection for any project open on
  that machine. The envelope `projectId` names the project; the host never
  routes elsewhere or opens one. A refusal is `terminal_snapshot { live: false,
  error: { code: "project_not_open" | "session_not_found" } }`; input for an
  unsubscribed session answers `not_subscribed`.

**Chats.**

- `chat_subscribe` sends `sinceSeq` for a replay of missed events; a full
  snapshot omits it. Duplicates coalesce for 5 s or until the ack. A full
  request has a 5 s watchdog, two resends, then an error with Retry.
- The first tail is at most 256 KiB, and the ack has `cursorKind: "byte"`,
  `tailStartOffset` and `hasOlderHistory`. Near-top scroll pages 256 KiB of
  `chat_history` and keeps the scroll anchor.
- Project chat subscriptions stay warm 120 s after leaving (at most four), and
  a reopen cancels eviction, also offline. Personal and cross-project scopes
  unsubscribe at once.
- The ack's `turnActive` shows Stop and the working state for a mid-turn
  subscribe; the thread engine keeps it current from `status` and `done`, and
  drops it when a full ack omits it.
- Chat frames never touch `SyncService` published state. They are decoded off
  the main actor into `ChatThreadRegistry`, which gives the view at most one
  frame per display frame (turn state, pending input and local echoes apply at
  once).
- Hub navigation activates the chat's project before it opens the chat.
- **The machine moved to another project.** A brain hosts one project's sync
  at a time, and another device's switch, a restart or a fallback can move it
  while the phone stays on its own (logged as `project_scope.sync_host_switched`
  with its `reason`, and `sync_host.project_switch_requested` with the asking
  device). The host serves a chat envelope stamped with a project it does not
  host from that project's transcripts, like a cross-project chat. A
  `chat_subscribe` it cannot serve at all gets a snapshot with `unavailable
  { code, message }` (`project_not_open`, `project_mismatch`, `no_chat_scope`,
  `transcript_read_failed`) for a phone that advertises
  `chatSubscribeUnavailableV1`, so the chat shows the reason instead of waiting
  out its watchdog; older phones get no answer, as before. The phone notices the
  move from the catalog, the hello or a `changeset_ack` mismatch: after 15 s it
  sends `project_switch_request` for its own project and reconnects, and the new
  hello restores every chat and terminal subscription. It does this at most once
  per machine every 10 minutes; a second move inside that window means two
  devices want different projects, so it holds until the person picks one.
  Diagnostics carry `hostedProjectIsActive` and `hostedProjectHeld`.
- A `session_meta_updated` event with a mode change updates the summary
  through `applyChatSessionMetaModeUpdateIfNeeded`
  (`AgentChatSessionMetaModeUpdate`, all optional), so the mode pill updates
  live.
- **`chatLogV2`.** `chat_subscribe` takes `sinceSequence` + `generation`
  (durable resume; the ack is `{resumed: true, resumeKind: "sequence",
  historyGeneration, maxSequence}` then the missed events, or a snapshot with
  `gap: true`) and `chatLogV2: true` (the cut aligns to the turn start; old
  open approvals go in `pinnedEvents`). `chat_history` takes `beforeSequence`.
  Folded rows carry `sequenceStart`; roster rows carry `maxSequence` and
  `historyGeneration`. A different generation drops that chat's cache.
- **Personal.** `chatScope: "personal"` subscribes with no project. The
  session's send, steer, approval, update, lifecycle and scheduled-work calls go
  to `personalChats.*`, and images load through
  `personalChats.getImageDataUrl`. A missing project scope alone never selects
  this path.

**Roster.** The feed has agent chats, their shell rows and standalone CLI
sessions, live and ended. Subscribe (optionally `sinceSeq`) gives a
`roster_snapshot`, then `roster_delta` (`changed` project entries, `removed`
ids). An unbooted project has disk status only. Rows add `settledAt`,
`statusNote`, `attentionRequestedAt`, `attentionMessage`, `lastTurnFailedAt`,
`exitCode`, and spawn lineage (`spawnKind`, `orchestrationParentSessionId`)
when known. A chat with a running turn is `running` even with
`lastTurnFailedAt`; a disk-only row drops the failure when `last_output_at` is
newer. `toolType` routes chats to the chat view and CLI rows to the terminal; a
CLI row must never take the chat quick look.

### Offline behavior

- Synced state reads offline from the local DB.
- **Queue.** Commands queue locally and replay on reconnect. A queueable
  command that times out on a seemingly live socket also queues, with the same
  `commandId`, and the phone probes the transport. The runtime dedupes by
  `commandId` (a TTL cache and a journal), so a replay returns the cached
  answer. **Exception:** a live `chat.send` whose outcome is unknown restores
  the draft and never replays.
- **Scope.** Project-scoped commands store their project id and root, and
  replay uses that scope. Commands drain when their host reconnects, also for
  another project; file operations wait for their project, because
  `file_request` has no cross-project router.
- **`host_unavailable`** (see `remote-commands.md`) is retryable
  (`isSyncHostUnavailableError`): the drain keeps the operation. The chat-send
  exception applies.
- **Offline chat create.** The phone queues `chat.create` with a stable
  `commandId` and saves a `PendingChatCreation`
  (`ade.sync.pendingChatCreations.v1`). `workPendingChatCreationOptimisticSession`
  shows a `pending-create:<commandId>` row, not openable until the real id
  arrives. The opening prompt and attachments stay in the composer and are not
  sent automatically.
- Queued actions show "pending sync".

### Timeouts

- **Default:** 30 s (`SyncRequestTimeout.defaultTimeoutNanoseconds`), "The
  machine took too long to respond. Try again."
- **`chat.send`:** 120 s (`chatSendTimeoutNanoseconds`), "ADE couldn't confirm
  whether this message started. Your draft was restored; check the transcript
  before sending again."
- **A timeout does not drop the connection.**
  `syncShouldReconnectAfterRequestTimeout(now:lastInboundMessageAt:silenceThreshold:)`
  keeps it when any envelope arrived in the last 12 s
  (`SyncSocketTiming.requestTimeoutReconnectSilenceSeconds`). Otherwise the
  phone fails the request, marks load strained and runs
  `verifyTransportAliveAfterSilence` (ping, then wait 5 s, 8 s on an expensive
  path, 12 s on a constrained one). Heartbeat silence uses the same probe. Only
  a silent probe tears down.
- **Terminal input** has its own budget (see Terminals above).
- **`InitialHydrationGate`** polls for the project row every 200 ms for up to
  15 s after pairing.

## iOS-specific services

### KeychainService

- **What it stores:** the paired secret, the connection draft (identity, route,
  port, last remote db version), and per-machine tokens under
  `connection-token.<machineKey>` (`machine:<hostIdentity>`,
  `site:<legacySiteId>`, `route:<address>:<port>` or `name:<hostName>:<port>`),
  next to the single `connection-token` slot. `ade.sync.hostProfiles` in
  `UserDefaults` maps profiles to tokens. When a stable identity appears, the
  token moves to it and the older aliases are cleared.
- **A failed read changes nothing.** `errSecItemNotFound` means "not there";
  any other error (a launch before first unlock) means "could not read":
  - `readPairedSecret`: a failed read of the machine's own slot stops the
    search, so an older secret is never used or copied over it, and the
    machine is not re-keyed.
  - The Relay device key and ownership epoch: registration and revocation wait
    (the revocation marker stays). The epoch is never written lower.
  - The DPoP key is created only when none exists.
  - The GitHub token stays in memory until the stored one can be read.
  - Each retries when protected data becomes available.
- `KeychainService` calls Security through `KeychainBackend`
  (`SecurityKeychainBackend` in the app).
- **Device id** (`syncResolveDeviceId`): the keychain copy wins and is mirrored
  to `ade.sync.deviceId`. After a failed read the phone uses the saved copy and
  writes nothing. With neither, the id is provisional: not stored, not used to
  pair, and "unknown device" then drops no pairing. It reads again when
  protected data returns or the app becomes active.

### PIN pairing flow

1. On the computer, the **This Mac** card sets or generates a 6-digit PIN. The
   runtime saves a PBKDF2 hash under `~/.ade/secrets` (`0600`) and keeps the
   digits in memory only, so after a restart it can verify but not show them.
2. The phone scans the QR (`SettingsPairingScannerSheet` →
   `PairingQrPayload.parse`: a v3 smart URL with identity, port and address
   candidates, never a code) or finds the machine nearby, then takes the PIN.
   `pinConfigured: false` sends the user to generate a PIN first; `nil` (an
   older host) falls back to the live result.
3. The phone sends `pairing_request`. `syncPairingStore.pairPeer` checks it
   against `syncPinStore`: `invalid_pin`, `pin_not_set` or `pairing_failed`.
   The live answer wins over the QR hint.
4. On success the phone saves the returned secret in Keychain and never uses
   the PIN again.

`SettingsPinSheet` mirrors the desktop sheet. The runtime limits each IP to 5
failures, then 10 minutes. The sheet reads success from `syncService.isAttached`.

### Browser access

The phone never pairs a browser. The web client signs in to the account and
picks the Mac from the directory. Browsers paired by an older release keep
their direct reconnect.

### Background App Refresh

- `BGAppRefreshTask` syncs changesets and updates the shared workspace
  snapshot in the background (about 30 s per window).
- `com.ade.ios.activity.refresh` (in `BGTaskSchedulerPermittedIdentifiers`,
  with the `fetch` mode) re-arms first, then refreshes the Activity snapshot,
  and always reloads widget timelines. It is submitted at launch and on
  background, earliest 15 minutes later.
- A silent push refreshes the snapshot and reloads, also when nothing changed.

### Widgets

Source: `apps/ios/ADEWidgets/`. [Activity, notifications, and Live
Activities](./push-notifications.md#widgets-and-freshness) has the shared rules
(families, tiles, freshness). Phone-side facts:

- `ADEWidgetBundle` registers `ADELockScreenWidget` (accessory and Home Screen
  families) and the `agent-runs` Live Activity. Control Center widgets are not
  registered.
- With no account snapshot, the widget reads `WorkspaceSnapshot`
  (`ADESharedContainer.readWorkspaceSnapshot()`) and uses
  `LockScreenPriorityStatus`, in this order: awaiting input, failed agents,
  failing CI, reviews or changes requested, merge-ready PRs, running agents,
  open PRs, then sync, offline or idle.
- The rectangular accessory may carry an `AttentionActionIntents.swift` action
  (approve, deny, restart, rerun checks). The app calls
  `WidgetCenter.shared.reloadAllTimelines()` after each snapshot write.
- `ADESharedContainer` stores the fetch time beside the snapshot for
  `ActivityWidgetPresentation.Freshness`.
- The snapshot's `connection` field is a wire string: `"connected"`,
  `"syncing"` (from `.connecting`) or `"disconnected"`. `ADELockScreenWidget`
  and `ADESharedTheme` still match `"syncing"`; do not remove it.
- Colors: blue Working, amber Needs you, emerald Done, red Failed, violet
  Planning, neutral Idle and Stale (with a clock, not an offline glyph). Amber
  is only for a state that asks the user to act.
- `AgentSnapshot` and `PrSnapshot` (`Shared/ADESharedModels.swift`) are light
  Codable types the extension reads without the app's renderer code.

### Push notifications & Live Activity

Sources: `PushNotificationService.swift`, `LiveActivityService.swift`,
`ADEWidgets/ADEAgentActivityWidget.swift`, `Shared/ADEAgentActivityAttributes.swift`.
The pipeline and the content-state contract are in
[`push-notifications.md`](./push-notifications.md). Phone-side facts:

- **Registration.** A signed-in or paired phone registers the push-to-start
  token even with alerts denied, and signed-in phones register directly with
  the account relay. `AccountService` serializes device PUTs, coalesces
  refreshes and sends a persisted `ownershipEpoch` on each PUT and DELETE.
  Sign-out commits an unowned epoch first; an account switch goes `A → unowned
  → B`. A relay `409` is not retried. Turning Live Activities off sends an
  explicit token clear on account and paired routes; an omitted token keeps the
  target. `push.registerDevice`, `push.setPrefs` and
  `push.reportLiveActivityToken` stay for paired machines.
- **Deep links.** A tap routes `deepLink` through
  `DeepLinkRouter.handleNotificationUserInfo`, keeping `accountMachineKey` and
  the exact anchor; the app selects that machine first.
- **Approvals.** `ADEAppDelegate` registers the `ADE_APPROVAL` category
  (`aps.category`, top-level `sessionId` and `itemId`). `ADE_APPROVE` and
  `ADE_DENY` go to `ADEIntentCommandRegistry` (`chat.approve`) without opening
  the app. `ApproveSessionIntent` and `DenySessionIntent` are
  `LiveActivityIntent`s (they run in the app) and show only for the current
  host's activity. A tap while the app is dead queues and drains on launch.
- **Badge.** The relay stamps the account-wide count;
  `PushNotificationService.clearAppBadge` clears it on each foreground.
- **Live Activity.** `LiveActivityService` owns one account-wide `agent-runs`
  activity. It applies relay updates and, while the app runs, writes the merged
  drawer feed with `refreshLocalContent` (hash-deduped, at most once a second).
  It ends the activity when the account settles, Live Activities are off, or
  the user signs out, and ends one whose `ownershipEpoch` does not match the
  current owner; the extension shows only **Updating ADE** until then. Rows keep
  `accountMachineKey` in their element links. `NSSupportsLiveActivities` and
  `FrequentUpdates` are in `Info.plist`; `aps-environment` and
  `remote-notification` are in `ADE.entitlements`.
- **Settings › Push delivery** (`SettingsPushDeliverySection`,
  `SettingsPushDeliverySnapshot`) shows registration, the token suffix, the
  APNs environment, the last push and relay reachability (`push.getStatus`),
  with toggles, per-session mutes and quiet hours. Changes write the account's
  `devices[attentionDeviceId]` override through the relay's scoped atomic
  mutation; failures stay marked unsynced and retry with capped backoff. Live
  Activity diagnostics say: authorization off, waiting for a token,
  registration pending, or registered. When the machine cannot answer `push.*`,
  the panel keeps the last status and says "waiting for machine".
- **Physical device.** Simulators get no real APNs pushes and no push-to-start
  tokens.

### Haptic Feedback

`UIImpactFeedbackGenerator` and `UINotificationFeedbackGenerator` fire on send,
approval, worker launch and PR merge.

### Activity drawer

Source: `apps/ios/ADE/Views/Activity/`. The shared rules (columns, item
derivation, acknowledgments) are in
[`push-notifications.md`](./push-notifications.md#ios-activity-drawer).

- **One drawer.** The bell opens `ActivityDrawerSheet` for the whole account.
  A project drawer is a filter over the same model. It works signed in with no
  paired machine.
- **Layout.** **Sessions** by the four columns, with Done folded; **Inbox** for
  PR and CI work and unseen outcomes. The five chips are `HubRosterFilterBar`.
  A Waiting row says why ("Snoozed", "CI running", "Review requested"). A row
  names project and lane; the long-press menu, the chat header and the prompt
  box name the computer ("On Demo Studio"). Sessions count chats, CLI sessions
  and shells, with a chat's shells inside it. Rows swipe to dismiss.
- **Live merge.** `rebuild(from:live:)` lays the paired host's live
  `WorkspaceSnapshot` over its relay rows, because the account poll lags and
  stops when a brain is signed out. The `WorkspaceSnapshot` write waits at most
  2 s and does not restart on each change. The merged list feeds
  `refreshLocalContent`.
- **Every tap lands somewhere visible.**
  - Push Approve and Deny connect to the payload's `accountMachineKey` first.
    If that machine cannot be verified or reached, nothing is sent and the Hub
    says "Could not reach <machine>. Nothing was sent." They never use the
    focused machine instead.
  - A link with no route, or a push with no target, calls
    `SyncService.landOnHub(notice:)`.
  - An outside session link that has not opened after
    `workSessionNavigationTimeout` (10 s) lands on the Hub with a notice that
    names the machine; the timer waits while Wake & open is up. Work clears the
    request when the chat opens, before it acknowledges the item. A loading chat
    shows its header, "Connecting to <machine>…" and a disabled composer.
- **Buttons.** `ActivityRowPresentation.visibleActions` decides them. Approve,
  deny, restart and rerun checks need the row's machine to be this one and
  reachable. `.answer` always shows (a question row carries
  `waiting_for_input` only). `.open` is the row itself. A row is marked seen
  when the hand-off happens, not on tap. Remote items get Open or Reply, never
  a current-host intent.
- **Presentation.** `Shared/ActivityRowPresentation.swift` (pure, no SwiftUI)
  and `Shared/ActivityWidgetPresentation.swift` (tone colors, lock-screen
  ranking) compile into the app and the extension, so both use iOS 17.
  `activityStatusShoutsLabel` matches desktop `sessionStatusShoutsLabel`.
  `ActivityBoardColumn` / `activityBoardColumn(_:)` is pinned to
  `activityBoardColumn.cases.json`; `ActivityStateGroup` (six groups, for
  glyphs and the Live Activity fallback) is pinned to
  `activityStateGroup.cases.json`, with its wire spelling separate from the
  case name. A row leads with a state mark (the group glyph on a tinted disc,
  pulsing while live). `chatActivityMode` decodes to `planning` or an unknown
  value; the phase enum stays frozen.
- **Row text.** Three lines: the chat `title`, lane and machine, then
  `scopeLine`. `attentionSessionTitle`
  (`apps/ade-cli/src/services/push/attentionItemBuilder.ts`) sends the real
  title first. `statusDetail` drops a status that only repeats the lane and
  title (`sanitizeAttentionPreview` clips at 160 characters, so a `…` with a
  stem of 140 or more counts as a clip). `scopeLine` starts with the provider
  mark, or its name when there is no mark (Pi, Gemini, `"Shell"`, `"CLI"`).
  `ADESharedTheme.providerFamilyKey` reads the slug once for mark, name and
  color (so `"Codex-chat"` resolves). PR rows show no provider
  (`isPullRequest`). The model and the status note share one caption; the
  accessibility label always speaks the model.
- **Hub.** `Views/Hub/HubActivityState.swift` reads the same table
  (`HubStateGlyph`). A snoozed running chat files as `idle`.
- **Tones.** `blocked` is a neutral Working item with Open, apart from the amber
  `awaitingInput`. A stale run says `Stale` with a clock.
- **Settings** cover notifications, Live Activities, desktop-first, preview
  privacy, sound, celebration and quiet hours, also for account-only users.

## Tab structure

### Root shell

- **Tabs.** `ContentView.rootTabs` is a `TabView` with Work, Lanes, PRs, Files
  and CTO. Work badges running chats (`SyncService.runningChatSessionCount`).
  CTO shows a string badge when `SyncService.ctoAttention.awaitingInput` is
  true, because the CTO chat is in no roster (see
  [CTO › Hidden from rosters, but never silent](../cto/README.md#hidden-from-rosters-but-never-silent)).
  On the Hub, `HubTopBar` badges the Chats button for personal chats awaiting
  input (zero when the host lacks `personalChats.*`).
- **Hiding the tab bar.** A screen sends `.adeRootTabBarHidden()`
  (`ADERootTabBarHiddenPreferenceKey`). `ADERootTabBarVisibilityModifier` on
  each root is the one reader and applies `.toolbar(.hidden, for: .tabBar)`.
  Work hides it whenever its path is not empty, because a native tab bar
  survives a push and would sit under the composer. On a display whose tabs run
  down an edge rail (the Duo's outer display) nothing hides it. On the inner
  display (`duo.isWide`) the tab bar is always hidden and the bottom bar holds
  the tabs. `ADEUIKitAppearance.configureTabBar()` matches UIKit tab bars.

### Hub and machines

- **Hub.** `HubScreen` takes the root when no project is active or the user
  taps Projects. It lists projects across machines, each opening to chats by
  lane (from `roster_subscribe`). Projects merge across machines by repository
  origin; with no origin on a side, the folder name decides; two known,
  different origins stay apart.
- **Fleet.** The focused machine owns the full sync connection. Up to seven
  more stay on light roster connections (`MachineFleet.liveMachineLimit` is 8).
  Hidden and signed-out machines are not connected. Settings › Machines lists
  them and can hide one. Only the user's connected set gets roster connections
  and merges into the Hub; Disconnect (also on the primary) removes a machine
  until the user connects it.
- **A project shows every machine.** Opening a project connects each machine
  with a copy (`activeProjectCopyMachineKeys` →
  `MachineFleet.setProjectMachines`), before the rest of the set and up to the
  limit, without saving them to the set; one past the limit is "parked". An
  online account computer with a copy that the phone never paired is paired
  beside the primary once per run (`connectActiveProjectAccountCopies`). A
  machine the user connects or whose chat opens goes first. A machine the user
  disconnected stays off (`ade.fleet.userDisconnectedMachineKeys.v1`).
- **One list.** Lanes and Work list every machine's rows together. Rows name no
  machine; the machine shows in the chat header, the lane detail, a lane row's
  "Show only" menu and the Start-on menu. A dropped machine's rows stay 20 s
  (`fleetMachineListsWork`, `MachineFleet.workListReconnectWindow`, restarted
  on foreground). A parked, unconnected or user-disconnected machine lists no
  rows, and counts follow the list. ADE Cloud rows always list, from the last
  roster or, for a computer this phone never paired, from the account's saved
  chats (`restingCloudMachineRows`); opening them never wakes (see
  [ADE Cloud on the phone](#ade-cloud-on-the-phone)). Machine filters only
  narrow; a machine is chosen only where work starts. The focused machine is
  the internal home for calls that name no lane or session.
- **Adding a machine.** With no primary, the next machine connected becomes
  primary. With one, an account machine never paired here is paired beside it
  (`pairAccountMachineAlongsidePrimary`) on its own socket as a roster peer and
  saved as a non-active machine; the primary is untouched, and the toast says
  "connected" only when the link is live. Opening a project on another machine
  from the Hub keeps the previous primary (`switchFocusKeepingPrevious`). A
  project the machine refuses shows its reason as a toast.
- **Settings rows** show each link's real route and track their own action. The
  title is the computer, with the install on its own line ("ADE Beta" or a dev
  home). A failed connect shows "Couldn't connect" and Retry; the machine page
  has the full reason. Relay close 4507 (the bridge refused the tunnel) gets
  `syncRelayHostDidNotAnswerMessage`; 4501 and 4509 keep the route-neutral
  words.
- **Bonjour match.** An advertisement belongs to a saved machine by **device id
  first** (`matchesDiscoveredHost`, the PIN sheet's `latestDiscoveredHost`),
  because installs on one computer share addresses and names but not ids or
  ports. Address and name decide only when a side has no id. A PIN pairing to a
  computer that advertises its live port does not sweep default ports and ranks
  routes only by that machine's history.
- **Drop reports.** A live connection that drops with 1006 or no code sends one
  Sentry report (`SyncLiveDropReport`, area `sync_live_drop`: kind, route,
  code, age bucket, the receive error's domain and code), at most once per kind
  in 10 minutes. A drop on a connection that went to the background, or that
  ends in the background, leaves a `sync.live_drop` breadcrumb instead (iOS
  kills suspended sockets with no close frame). A saved port change leaves a
  `sync.route` breadcrumb.
- **Cursors.** A saved machine keeps `remoteDbVersionBySite` across hellos and
  switches; a pending cursor is written to the machine being left before the
  profile changes. A switch reaches the target only when that socket's hello
  names it, and a failed attempt never restores the old machine after the user
  disconnected.
- **Safety.** Profiles never merge across device identities. A `brain_status`
  from a machine other than the active profile's is ignored. Chat commands go
  to the chat's machine and fail while it is offline; they never queue or fall
  back to the focused machine.
- **Work across checkouts.** Work shows other machines' chats for the same
  repository, one checkout per machine (`pickLiveCheckout`: the most recently
  opened, then roster order), because a second clone on one machine would
  otherwise merge in. The Hub lists every project. A chat on another machine
  takes its composer's model and color from its roster row
  (`RemoteRosterChat.rosterChatSummary`). The Hub chip reads "N machines".
  The Hub composer lists every live machine's projects; a send to another
  machine makes it primary first (`switchFocusKeepingPrevious`) and keeps the
  draft until the switch works.

### Terminals on another machine

A CLI or shell session on another live machine opens at once over that
machine's roster connection, with no change of focus or project, when the
project is open in that roster and `hello_ok` advertises
`features.rosterTerminal`. `MachineConnection` serves the screen through the
same `TerminalStreamTransport` as `SyncService`:

- Each `terminal_*` envelope carries the session's `projectId` and payload
  `projectRootPath`. Refusals are `project_not_open` or `session_not_found` in a
  `terminal_snapshot` with `live: false`.
- Input acks, gap recovery, `sinceOffset` resume and the handler stack work as
  on the focused connection. A new roster socket resubscribes each open terminal
  from its last offset and sends the size again. A failed resubscribe shows the
  error and Retry, never a frozen "live" terminal.
- `work.resumeCliSession` and `chat.typeIntoCli` go to the session's machine
  with the same scope, and are never queued for an unlinked machine.
- With no link, an older host or a closed project, the tap focuses the machine,
  opens the project, then the terminal. Phone, Duo column and deep links
  (`handleRequestedWorkSessionNavigation`) follow this rule.
- An open terminal remembers its machine and is live only while its connection
  still serves that machine; otherwise it shows offline and sends nothing.
- Roster connections renew relay proof (`relayReauthorizeV1`;
  `MachineConnection` refreshes the lease), or the host closes them about a
  minute in. A connection in backoff (5 s, 15 s, 1 min, 5 min) dials at once on
  Connect, a directory "online", a network change or foreground.

**Message bar for an agent CLI.** A text-bubble button swaps the key bar for a
message bar (`@AppStorage("ade.work.cliMessageBar")`, off by default). A message
goes to the session's computer as `chat.typeIntoCli`, which types it only when
the CLI's prompt is free. The bar then says: typed, queued until the turn ends
(on the host), queued until reconnect (the offline queue), or the CLI ended (the
text stays; Resume continues). A screen whose focused connection now serves
another computer refuses the send. A tap anywhere on the bar focuses the field.
Each message has an id: a retry of an untouched draft types once; an edited
draft is a new message.

### Personal chats

`HubPersonalChatsCard` is the only phone entry to projectless chats. It shows
counts when the focused host supports personal chats and opens
`PersonalChatsScreen` with no project. The screen merges the summaries of each
live machine that advertises `personalChats.list` (5 s timeout each), searches
active and archived chats, and caches them per machine in the App Group. Rows
name their machine when chats come from several. A failed machine keeps its
cache with Retry. Every action routes to the chat's machine.
`PersonalChatNewScreen` reuses the Work controls with a machine picker and
sends `personalChats.create` (not queueable). Open chats use
`WorkSessionDestinationView` with `personalChat: true`, the machine key, no lane
actions and personal action names.

### Roster over the local cache

- The machine roster lies over the synced local rows as a display layer. Local
  rows win by id; roster-only lanes and chats fill the gap until CRR rows
  arrive.
- **Exception: turn liveness.** A chat row is `running` between turns, and only
  the phone's `runtime_state` (written by a full `work.listSessions`) knows a
  turn streams. So `RemoteRosterChatStatus.applyingTurnState(to:)` lays the
  roster's running, waiting-input or idle state over the local row; settle,
  attention and failure stay local. `RemoteRosterChat.merging(local:)` never
  lets a local running-or-idle replace the host's.
- The Work bridge admits only non-archived chat rows, at most 200, and makes
  only the lanes those chats need; roster CLI stubs wait for real PTY rows. The
  Work projection is tagged with its project and cleared before a switch.
  Pending offline rows filter by project, and Work rebuilds on that project's
  roster revision only.

### Hub list and chats

- **Filters.** Four cards under the top bar: **All**, **Working** (with
  planning), **Needs you** and **Finished** (done and failed), over the live
  roster, not account Activity. A filter opens matching projects and hides the
  rest.
- **Opening.** A project card opens its tabs. A chat opens at once over the Hub
  (the Hub stays mounted for Back) from `makeRosterSessionStub`, in
  cross-project scope when the host advertises `crossProjectChat`; otherwise it
  waits for activation like a CLI row. The project activates in the background.
  Back calls `abandonInFlightHubProjectActivation`, which cancels only an
  uncommitted switch. A CLI row waits for activation and opens the terminal (it
  has no chat JSONL). A failed wait shows an error with Retry and Back to Hub;
  a chat that already painted is not replaced. If a switch rolls back, the open
  chat goes back to foreign scope. An already-active CLI row opens at once. The
  loading state is `WorkChatTranscriptSkeleton`. CLI rows offer only "Open
  session" (`chat.archive` and `chat.delete` refuse them).
- **Session links.** The repository envelope is a hard project boundary; lane
  and branch hints resolve inside it, and the chat's own lane wins. A hydrated
  active session opens in Work; others go through the Hub, whose retry key
  includes roster, catalog and connection changes. The app-root task handles a
  request present at cold launch. `repoOwner` and `repoName` are set only for a
  canonical GitHub origin; an owner-scoped link fails closed without them.
- **Hub composer.** `HubInlineComposer` (in `HubComposerDrawer`) raises the
  keyboard and opens its controls in place. Expansion is explicit state (not
  `@FocusState`) on one spring, with a Project ▸ Lane picker. The persistent
  composer root presents PhotosPicker, so it is never unmounted under the sheet.
  The chat is created in place and does not open; a "Created in <project> ·
  <lane>" toast has Open (`HubCreatedChat.stubToolType`: `cli` or the chat
  tool type).
- **Cards.** Cards drag to reorder (per machine, phone only). `attentionCount`
  counts awaiting-input and failed chats, shells of a chat and waiting agent
  CLIs, never a standalone CLI that exited non-zero (it has no clear action).
  `runningCount` counts only running chats that are not snoozed
  (`RemoteRosterChat.countsTowardRunning`).
- **Catalog.** The Hub merges the runtime catalog (local to that machine, no SSH
  recents) with cached projects, marks unavailable rows, and switches with
  `project_switch_request`. "Remove from list" hides the project and sends
  `project_forget_request`. Tiles and the Projects button
  (`ADEProjectHubButton`) show `MobileProjectSummary.iconDataUrl` (a 64×64 PNG)
  through `projectIconImage(from:)` (one `NSCache`) and
  `Image.projectIconStyle(size:cornerRadius:)`.
- **Identity.** `SyncService.mergeCachedProjects` keeps the remote `projectId`
  on the active project. `Database.upsertMobileProjectCache` saves summaries
  without CRR capture and normalizes `rootPath`;
  `deduplicateProjectListByRoot` dedupes by that root. A removal stores the
  root key and id under the host profile; opening the project clears them.
- **Chat or CLI preference.** `WorkNewSessionModePreferences`
  (`ade.work.newSessionModeByProject.v1`) is per project and changes only when
  the user taps the switch. `WorkNewChatScreen` reads it when pushed;
  `HubComposerDrawer` reloads it when its project changes.

### New-lane chat launches

- **When.** A new chat on the auto-create-lane target (from `WorkNewChatScreen`
  or the Hub composer) uses the brain's launch (`chat.startLaunch`; see
  [Chat › New-lane launches](../chat/README.md#new-lane-launches)) when
  `SyncService.canStartChatLaunch` holds: the host advertises it, has not
  refused it on this connection (`chatLaunchKnownUnsupported`, reset on
  reconnect), and the phone can send live. CLI sessions, Cursor Cloud, offline
  sends and older hosts keep `lanes.create` → `chat.create` → `chat.send`
  (`ChatLaunchRequest` returns nil).
- **Start.** `SyncService.beginChatLaunch` adds an optimistic snapshot and
  returns at once; attachments stage in the background, then
  `chat.startLaunch` runs. The session id is the launch id, so Work opens the
  chat route at once and the Hub reports it.
- **Route.** `WorkChatLaunchGate` shows `WorkChatLaunchPendingScreen` (the
  opening bubble, the setup card, queued follow-ups and a composer that sends
  `chat.queueLaunchMessage`) until the agent starts, then the normal chat, and
  never flips back. With no launch held, it waits until this connection has
  listed the project's launches.
- **Setup card.** `WorkChatLaunchSetupCard` offers Start now and Cancel while
  running, and Retry, Start anyway (lane made, environment failed) and Delete
  on failure. Its words mirror `shared/chatLaunch.ts`
  (`WorkChatLaunchPresentation.swift`, `ChatLaunchTests`). After the chat
  exists, `WorkLaneSetupTranscriptCard` draws the `lane_setup` `ade_card` from
  the snapshot, or from its own rows (by `key`) after a reload.
- **Rows.** `workOverlayChatLaunches` adds a row (and its lane) for a launch
  whose rows have not replicated; after that, only the preview line borrows the
  launch status, with the segmented rail in `WorkSessionRowCard`.
  `hubRosterOverlayingChatLaunches` does the same on the Hub. Deleting a
  pending row cancels the launch (deletes the lane, branches and chat);
  `chat.cancelLaunch` has a 5-minute budget, as on desktop.
- **Refresh.** `chat_launch_event` carries `projectId` and `projectRootPath`
  (older hosts omit them; the active project is assumed). The active project
  hydrates with `chat.listLaunches` once per connection. Other projects get no
  pushes, so the phone pulls `chat.listLaunches` for any launch still running
  or awaiting its client: on connect, on foreground, and every 3 s while the
  Hub is on screen, stopping when nothing moves.

### The composer

- **Fold by gesture.** A downward swipe anywhere on the card folds the field to
  one line and lowers the keyboard in one spring; an upward swipe, a tap in the
  field or a tap on the compact tray brings it back. There is no collapse row
  (the question card keeps its chevron). `workComposerFoldGesture` runs beside
  the field's recognizers and claims only a mostly vertical drag past 40 pt.
  When a long draft scrolls, the composer watches the text view's pan instead:
  a swipe from the top of the draft folds, one from the middle scrolls, and
  `keyboardDismissMode = .interactive` lowers the keyboard either way.
- **Fold without re-measure.** The text view keeps its full height and the card
  clips it, so the fold is one container animation, applied where the state
  changes (not `.animation(_:value:)`). The tray switches to 24 pt chips
  without unstaging. **No fold path scrolls the transcript.** The rules are in
  `workComposerFoldTransition` and `workComposerFoldGesture`
  (`WorkChatComposerAndInputViews.swift`), so expanding while a question holds
  the field never raises a keyboard over it.
- **Send lowers the keyboard** in every composer (Work chat, new chat, personal
  new chat, Hub). `WorkComposerTextView` and `WorkPlainComposerTextView` never
  change first responder inside `updateUIView`: a shared scheduler yields past
  the update, keeps only the latest request and ignores a first unfocused
  binding. On `WorkNewChatScreen` the activity carousel scrolls with the
  content, so the keyboard gives the prompt the space.
- **Attachments** (`WorkComposerAttachmentStaging.swift`):
  - Images use base64 `chat.saveTempAttachment` (the host checks the bytes and
    the name). Up to ten images become JPEG; failures and overflow stay as
    tray errors. Paste works for image-only clipboards.
  - Video and documents use the chunked `chat.beginTempFileAttachment` route,
    any type, up to 50 MB (`workChatFileAttachmentMaxBytes` mirrors
    `MAX_CHAT_ATTACHMENT_BYTES`; change both). The begin action gates the whole
    ladder. A personal chat is images-only, whatever the host. An old host
    shows "Update ADE on your computer to attach files and videos"; the
    images-only case shows nothing. Empty and oversize files fail on the phone.
  - `WorkChatAttachmentPreviewSheets.swift` previews non-images from
    `chat.getAttachmentChunk` in QuickLook or a player. Chips show `photo`,
    `film` or `doc` (`WorkChatInputAttachmentKind`).
  - `WorkChatInputAttachmentTray` is a fixed shelf above the field.
    Attachments survive Chat/CLI switches. Chat sends attach the
    `AgentChatFileRef` refs to `chat.send` or `chat.steer`; CLI launches put
    the paths in the `Attached files and images:` manifest
    (`workCliInitialInput`) in `work.startCliSession.initialInput`.
  - Staging works offline; upload waits. A host without
    `chat.saveTempAttachment` disables Attach only.
- **Overflow menu.** `WorkComposerOverflowButton` (⋯) holds attach, dictate and
  drafts. With content it saves a draft; empty, it opens the drafts sheet.
  `Schedule send…` is below it. The sheet filters **All**, **Scheduled** and
  **Needs you**, and attaching a draft **claims it before filling** (the claim
  is the delete). `WorkDraftScheduleSheet` sets the target (this chat or a new
  chat in a lane), the machine, an offset-qualified time, the if-late rule and
  the captured provider, model and permission, with a warning for elevated
  modes. Without `chat.listDrafts`, `chat.createDraft`, `chat.updateDraft`,
  `chat.deleteDraft` and `chat.claimDraft` the drafts hide; without only
  `chat.createDraft`, Schedule send hides.
- Context usage is on the latest turn-end marker, not the composer.

### Importing sessions

Work imports CLI sessions from the 11 import providers (Claude, Codex, Cursor,
Droid, OpenCode, Pi, Qwen, Kimi, Grok, Copilot) through
`work.listExternalSessions` and `work.importExternalSession` on the host; the
phone never reads provider storage. See
[External session import](../terminals-and-sessions/external-session-import.md).

- `WorkImportSessionScreen` lists with provider chips, a lane filter (counts and
  "Other folders") and a project/all scope. Rows
  (`WorkImportSessionRows.swift`) name the home lane, never a path, with two
  anchors: **started** (`preview`) and **latest** (the last of `messages`),
  falling back to one and hiding one the heading already shows.
  `ExternalSessionSummary` decodes `messages` through `ADELossyArray`, and an
  unknown `role` drops only that message.
- The detail shows the preview (`WorkImportSessionPreview.swift`) and
  `WorkImportActionBar`, from `workPlanImport` in
  `WorkExternalSessionAffordances.swift` (the port of
  `shared/externalSessionPolicy.ts`): mode, lane (`WorkLanePickerDropdown` or a
  locked lane with its reason), note, action and Copy. `confirmBeforeRun` needs
  a second tap ("Continue anyway").
- The preview reads `work.getExternalSessionDetail` and draws it with the chat
  pipeline (`makeWorkChatTranscript` → `buildWorkChatTimelineSnapshot` →
  `workPresentedTimelineEntries`) and chat row views, newest first, with "Load
  earlier" (`olderCursor`). Without the command, while loading or on failure,
  it shows the sampled `messages`.
- A chat import sets model, reasoning, fast mode and permission from
  `WorkComposerPreferences` and writes them back; a CLI import sends none. The
  result includes the chat or terminal summary, which Work caches before it
  navigates.

### Chips on the phone

iOS ports the desktop chip model to Swift (it cannot import
`apps/desktop/src/shared/chips.ts`):

- **Composer.** `WorkComposerTypedTriggers.swift` finds `@`, `/` and `#` at the
  cursor, and `WorkSmartLink` turns URLs and `ade://` links into the desktop
  labels (`ade://pr/owner/repo/1237` → `#1237`; an unknown `ade://` shape keeps
  its path). `permission` and `skill` chips match the desktop.
- **`@` menu.** Models, chats, lanes, files, terminals, PRs, machines and MCP
  servers, three rows each with "Show N more"; a kind word (`@pr`, `@model`)
  shows one section. A model row shows the maker, the harness and the starting
  thinking level.
- **Model chips** (`WorkComposerModelChips.swift`) show maker, thinking level
  and permission icon. A model pick opens the thinking track, then the
  permission track, then closes; a tap on one part opens only that part, and
  VoiceOver offers the parts as actions. Words, icons, tones and details come
  from `WorkModelMentionDetector.permissionOptions(provider:)`.
- **Messages.** Sent messages draw the same pills over the stored text
  (`WorkChatHeaderAndMessageViews.swift`). A long markdown-looking user message
  (`workUserTextLooksLikeMarkdown`) renders formatted. Copy puts the tokens on
  the pasteboard, not the labels.
- **Agent replies.** `WorkThreadEntityRules.swift` ports
  `shared/threadEntities.ts`: only real things chip (lanes, chats, models,
  permission modes, `/skill`, PRs, commits, Linear issues, zoned timestamps);
  inline code is the strong signal; prose chips only full UUIDs, zoned
  timestamps, `PR #123` and known Linear keys. `WorkThreadEntityDirectory` is
  filled from `WorkRootScreen` and the slash registry and republishes only on a
  visible change. A lane chip has its name and color, a chat chip its title and
  dot, a timestamp shows local time (tap for raw). The desktop's bare
  `3461-3468` line follow-up is not ported (no file-path links on iOS).
- **PRs per chat.** `LaneHelpers.swift` mirrors `selectLanePrs` (lane-owned; a
  main checkout on its base branch has none) and `selectChatPrs` (plus the
  chat's own links); `workChatPrTag` feeds the chat's PR switcher. See
  [Multi-PR lane ownership and chat edges](../pull-requests/README.md#multi-pr-lane-ownership-and-chat-edges).
- The paperclip stays live during a question; staged files ride the answer's
  turn.
- **Parity test.** `apps/desktop/src/shared/__fixtures__/chipCases.json` is read
  by `shared/chips.test.ts` and by
  `ADETests/WorkComposerTriggerDetectorTests.testMatchesSharedChipFixture`
  (from disk, relative to `#filePath`). The `test-ios` gate in
  `.github/workflows/ci.yml` watches that folder too.
- **Link menu.** A message block's long-press menu (Copy message, Open full
  response) adds up to eight of its links, named from the drawn string. Each
  has Open and Copy link; a skill chip has View instructions and Copy /name
  (`WorkMessageLinkMenuItems`, built only when drawn). Skill chips use
  `ade-skill://`: `WorkSkillInstructionsSheet` reads SKILL.md from the chat's
  machine with `chat.getSkillInstructions` (viewer-allowed, optional; resolved
  by `readAgentSkill` from the lane's worktree, then the user and ADE roots,
  capped at 128 KB). Without the sheet or the action, the chip is a label and
  the menu offers Copy only. Fixtures: `-adePreviewScreen chat-links`,
  `skill-instructions`.

### Settled lifecycle and attention parity

`WorkSessionCanonicalState.swift` mirrors
`apps/desktop/src/shared/sessionCanonicalState.ts`, and the nesting in
`WorkSpawnNesting.swift` mirrors `sessionSpawnNesting.ts`. They are mirrors, not
variants: the canonical-state and grouping tests catch drift.

- **Derivation.** An approval, question or `ade chat ask` is `Needs you`; an
  explicit settle applies only at rest; failed and stopped stay distinct; a
  clean exit is ended; a running row whose real activity is 3 h or more old is
  `Stale`. `AgentRunPhase` mirrors `shared/sessionStatusPresentation.ts`: blue
  Working, amber only for a raised hand, emerald Done, red failure, neutral
  stale.
- **Settled rows** recede, stay openable and show `statusNote` as `Done: …`; an
  attention request puts its question in the preview. By status, finished rows
  sit in **Done** (emerald), not in "Your move". A settled chat woken by
  scheduled work shows Running for the turn and goes back to Settled at idle;
  only user activity clears a settle.
- **`settle_override`** (`null | "settled" | "active"`) is read at the
  declared-settle tier: settled, keep active, or back to the stored state. Real
  activity clears it where it clears `settled_at`.
- **Snooze is a synced overlay, never a phase**; the derivation does not read
  it. `snoozed_until` is the deadline (compared to now; no scheduler).
  `snoozed_at` matters: an error wakes early only when newer than it. A wake
  stamps `woke_at` and `woke_reason` (`timer | needs_you | error |
  turn_complete | manual`) until the row is visited (`clearWokeMarker`). A
  failed end wakes; a clean exit 0 does not. `isSessionFiledAsSnoozed(session,
  phase)` is false for `needs_you`; `isSessionSnoozed` is the raw read for row
  chrome.

**Where it lives:**

- **Schema.** `DatabaseBootstrap.sql` and the `ensureColumn` migrations in
  `Database.swift` carry `settle_override`, `snoozed_until`, `snoozed_at`,
  `woke_at`, `woke_reason`, `activity_status_json` and
  `activity_status_changed_at`. **Add each new `terminal_sessions` column to
  both**: the SQL alone leaves upgraded phones failing changeset apply. All are
  nullable with no unique index (`crsql_as_crr`).
- **Models.** `RemoteModels.swift` and `RemoteRosterModels.swift` decode the
  lifecycle fields as optional strings and include them in equality, so a
  lifecycle-only change redraws. Sessions also decode `activityStatus` and
  `activityStatusChangedAt`; chat summaries carry `currentTurnStartedAt` for the
  row timer. Roster chats merge activity reports by their own timestamp, and
  expose `countsTowardRunning` and `applyLocalSnoozeOverlay` (snooze does not
  bump `lastActivityAt`, so a fresher remote row would wipe it).
- **Hub.** `hubChatBoardState` (`HubActivityState.swift`) is the Swift copy of
  the brain's `rosterBoardColumn` with the snooze overlay: awaiting and failed
  are Needs you, snoozed (not failed or asking) and a running chat with a lane
  `prWaitingReason` are Waiting, idle and ended are Done.
- **Commands.** `SyncService.swift` holds the `session.*` callers, gated by the
  connect-time descriptors. The phone never writes the activity-report columns;
  the host drops phone copies.
- **The phone never writes the settle columns** (`settled_at`,
  `settle_override`, `settle_source`). The host's `sessionService` decides them,
  and a phone write would replicate with no host revision and could beat a host
  refusal. `Database.updateSessionSnoozeOverlay` writes only the snooze overlay
  (with rollback). Instant settle feedback comes from
  `PendingSessionSettleStates`, a local overlay applied on read and resolved by
  the host's changeset, a failure, or a 20 s backstop (held while the host is
  unreachable). With two commands outstanding for one session it stops trying
  to confirm and shows the last request until the backstop. The host also drops
  these columns from older phones' changesets (`syncHostService`). See
  [settle-teardown design §3c-i](../terminals-and-sessions/settle-teardown-design.md).
- **Attention clears** use `PendingAttentionClearStates.swift`, a second local
  overlay over `pending_input_item_id`, `attention_requested_at` and
  `attention_source`. It bridges the gap between the answer's chat event and
  the host's clearing changeset and writes nothing (a replicated clear would
  clear attention on the host). `PendingAttentionClearIntent.Baseline` saves the
  three columns, and the overlay applies only while `matches(_:)` holds; any
  host change (the clear or a new ask) makes it inert. Arming on a calm row does
  nothing (`Baseline.hasAttention`). `staleAfter` is 8 s, with no unreachable
  hold, because a stale clear hides a waiting agent.
  `applyChatAttentionResolutionIfNeeded` arms it on `pending_input_resolved`,
  and on `user_message` only when the message is not host-authored
  (`SyncService.hostAuthoredChatMessageMetadataKeys`: `scheduledWake`,
  `spawnCompletion`, `spawnDispatch`, `agentRelay`, `hostContinuation`,
  `boardMove`; the mirror of `HOST_AUTHORED_MESSAGE_PROVENANCE_KEYS`).
  `boardMove` is there because a drag into Needs you writes a message for the
  user.
- **Chokepoint.** Both overlays apply in `localSessions()` and
  `localSession(id:)` (settle, then attention; disjoint columns), prune
  together (`prunePendingSessionOverlays`) and sweep on one timer per
  `SessionOverlayKind`.
- **Row vocabulary.** `workSessionRowPresentation(session:summary:now:)`
  derives phase, capsule, dot and status slot once, from one clock;
  `workSessionStatusBadge`, `workSessionRowTone` and
  `workSessionStatusPresentation` read it. Labels and hues come from
  `ActivityPhaseVocabulary`.
- **Status chips** are the board's columns: `WorkSessionStatusFilter` cases
  `needsYou`, `working`, `waiting`, `done` (mirroring `WorkBoardColumn`), with
  the old raw values (`needsInput`, `running`, `ended`) because
  `WorkViewStateStore` saved them. Three titles come from `ActivityBand`;
  "Waiting" is in `WorkSessionStatusFilter.title`. Tints: amber, blue, neutral,
  emerald; Archived is not amber. `workStatusFilterPartition(phase:)` is the one
  phase → chip map for chips and headers, resolving Waiting first, as
  `buildWorkBoardModel` does.
- **Waiting reasons.** `WorkBoardWaitingReason` (`snoozed`, `ci`, `review`)
  comes from synced `pull_requests` rows through `workLanePrWaitingReason`,
  faithful to `lanePrWaitingReason` (`none` and `not_run` checks are no wait; a
  failing check is the agent's problem). GitHub-only PR rows do not count. The
  reason map is in the row render signature, because `LanePrTag` hashes only
  number and state. iOS never sends `session.moveOnBoard`.
- **Grouping.** `workSessionGroups` (`WorkSessionGrouping.swift`) builds by lane
  (default), by status and by time. `WorkRootScreen.swift`,
  `WorkRootScreen+Actions.swift`, `WorkRootComponents.swift` and
  `WorkSessionRowCard.swift` draw chips and menus and send snooze, wake, settle
  and keep active. Same-lane subagents nest; nested subagents have no drawer
  (`chat-subagents:<parentId>` is inert); the shells drawer opens with
  `drawer-open:chat:<parentId>`.
- **Quiet lanes.** A lane whose full roster is quiet gets a thin header and an
  inverted `lane-open:<laneId>` marker; active work removes the marker. A lane
  waiting on the user never folds.
- **Quiet zone.** Each grouping ends with a `Snoozed` shelf over a `Settled`
  shelf, closed by default (`shelf-open:<id>`, apart from `lane-open:`, which
  `pruneStaleQuietOpenMarkers` sweeps). By lane, settled rows move to the shelf
  too and keep a lane chip. A pinned lane keeps its settled rows (and folds to
  one line when all are settled); snoozed rows still leave it. Archived rows
  stay under "Archived". The headerless rule counts only the rows that stay in
  the lane. "Go to lane" opens the lane and the Working shelf, or, when every
  row is shelved, both shelves.
- **View state.** `WorkViewStateStore` is a versioned App Group map keyed by
  project id and host identity. `WorkRootScreen` saves the outgoing scope, then
  swaps search, filters, grouping and collapsed ids. A lane deeplink frames
  these without saving until the user takes control. "Fold busy lanes"
  (`foldBusyLanes`) is on by default; a record without `focusDefaultApplied`
  loads it on once. The Working shelf header counts chats, not lanes.
- **Tests.** `WorkSessionCanonicalStateTests.swift` (derivation, row
  vocabulary, view state), `WorkSessionGroupingTests.swift` (grouping, quiet
  lanes, nesting, shelves) and `PendingSessionSettleStatesTests.swift` (the
  settle overlay).

### Work session list rows

The Work list ports the desktop Work sidebar and keeps its rule: **interaction
owns the card surface; state never spends it.** Background, border and shadow
mean selection and press only (`SessionCard.tsx:69-86`). There is no provider
tint, because amber means "your move".

- **Three lines** (`WorkSessionRowCard.swift`): the "where" cluster (pin, mute,
  lane chip, lane git state, then model or time) with one right-hand **status
  slot**; the title and the lane's PR badge (`WorkLanePrIndicator`,
  `LanePrTag`); an italic preview and the provider mark.
- **One card at every width.** The phone, the wide sessions column (the Duo's
  inner display, an iPad) and the board draw the same card. The column only
  widens the padding and the selection fill (`duoRow`). A board card
  (`boardCard`) shows the time in the status slot because its column is the
  status, gives the title two lines, and moves the PR badge to the preview
  line, where it yields to Pending sync, ARCHIVED or an EXIT code.
- **Lane name.** Rows, lane headers, the wide chat subtitle, the CLI screen
  title and Work search use the lane's shown name (`LaneSummary.displayName`,
  `workSessionLaneDisplayName`), so the main checkout reads "Main checkout".
  Search also matches the stored name.
- **Status slot.** One label. A provider mode may show **Planning**; a current
  activity (detected by the host from tool calls, or reported by the agent) may
  refine a running row to Planning, Exploring, Implementing, Testing,
  Debugging, Reviewing, Shipping or Monitoring, timed from when it started. An
  agent report must be from the current turn; a detected one may carry over a
  continuation. **Needs you** wins. The activity changes only the card, not the
  phase, column or counts, and the phone only shows the host's value. See
  [provider signal boundaries](../terminals-and-sessions/README.md#provider-signal-boundaries).
- **Nested subagents.** A same-lane subagent of an agent chat is not a row; it
  is in the parent's Chat Info. A subagent of a CLI or terminal stays a row.
  The parent shows one mark: `person.2`, the count and the worst child state
  (red cross, amber dot, dashed ring), read as "2 subagents, 1 needs you".
  Chat Info lists every session the list files under the chat (grandchildren
  too, from the list's rows on that machine), keeping rows the transcript names
  (`chat:<id>` or the bare id) in place and adding the rest oldest first, and
  rebuilds at once from live summaries. A child reads running (starting,
  running, stale, needs you), failed, stopped or completed. Peers stay
  top-level; grandchildren flatten into the root's mark; a quiet parent pulls
  up children that are not done; cross-lane children and children of a
  filtered-out parent stay top-level with the lineage chip; Demote un-nests.
  Remote children nest the same way from roster `spawnKind` and
  `orchestrationParentSessionId`; an older host sends neither.
- **Navigation.** A child opened from Chat Info and a parent opened from a
  breadcrumb go through the Work tab's navigation request, handled at the tab
  root because SwiftUI cancels the list's `.task` under a pushed chat.
- **Receding.** Rows that do not need a human show at 70% opacity. Settled has
  a nil status presentation (the time takes the slot); its `badge` still says
  "Done".
- **Lane identity.** The lane chip shows only on headerless single-row lanes;
  other lanes get a sticky header and an accent rail. The chip truncates at the
  tail and has no colored dot.
- **Header.** One 44 pt row: search, filter and a compose menu (**New chat**,
  **New lane**). There is no "N waiting" count.
- **Context menu** matches desktop: destructive items last, a `Lane ▸` submenu,
  Settle hidden while starting, running or stale, **Keep active** only for a
  declared settle, **Dismiss & settle** for a needs-you row, and a disabled
  **Resolve input to settle** for a prompt ADE cannot answer. Non-chat sessions
  delete through `work.deleteSession` (`SyncService.deleteWorkSession`, gated by
  `supportsWorkSessionDeletion`; the host stops a live runtime first, so "Stop &
  delete" and "Delete session" are one command). Chats use `chat.delete`.
- **Dismiss & settle** sends `session.settleSessions` with
  `dismissPendingInput`, only for a row with a pending prompt (the host throws
  otherwise). An older host ignores the flag: the settle succeeds and the row
  stays Needs you. See [remote commands](remote-commands.md#registry).
- **Limits.** Preview tokens (`#123`, `ABC-123`) are styled but not tappable,
  because the row is a `Button` (routing exists in
  `SyncService.requestedPrNavigation` and `requestedLinearIssueNavigation`).
  `TerminalSessionSummary` has `orchestrationParentSessionId`, `spawnKind`,
  `lastActivityAt` and `parentIdentityKey`, but no `branchRef` or `nextWakeAt`,
  so the branch chip, machine glyph, grid indicator and the `nextWakeAt`
  Waiting status have no iOS form. Chats time their turn from
  `currentTurnStartedAt`; CLI rows fall back to an activity report's time, then
  the row's activity time. Nested compact rows put the identicon and title
  leading and the provider mark trailing.

### Chat session control: PR Watch, goals, Stop, restart

- **PR Watch / Ship** (`WorkChatPrWatchChip` in `WorkChatPrViews.swift`): an
  icon beside the PR chip with Off, Watch and Ship and one status line, through
  the optional `prs.setChatWatch` and `prs.getChatWatches`. A result for a PR
  the chat no longer shows is dropped; a failed change shows in the error line;
  an unreadable watch says "Couldn't read the watch" and Off still works.
- **Goals** (`WorkChatHeaderAndMessageViews.swift`): a "Goal" chip above the
  composer opens details with Edit and Clear (Claude sends `/goal …`; Codex uses
  its goal API). A failed send says so.
- **Stop** (`WorkChatStopCapability` in `WorkModels.swift`, mirroring
  `shared/chatStopModes.ts`): six modes; unsupported ones are disabled with a
  reason. Child-chat modes show only with active child chats on a host that has
  `chat.restartSession`.
- **Restart agent session** (`chat.restartSession`, optional) asks first during
  a turn, then retries with `stopFirst`.

### Lane tool chips and the Work tools sheet

The phone mirrors the desktop Work tools read-only (the browser and App Control
run on the Mac). Mac Desktop is the exception: watch, take control, and start a
display that is off.

- **Chips** (`WorkLaneToolChips.swift`), after the PR chip, in this order:
  - the lane's simulator while up ("16 Pro" with a live dot, read "iPhone 16
    Pro"), shown only when `apple.status`'s `laneDevice.udid` matches the device
    (no `laneDevice`, no chip);
  - **macOS** (`WorkToolChipKind.macDesktop`) while `macDesktop.supported` and
    the lane has a `display`, with a live dot while `stream.running &&
    !stream.idle` and the accent while an agent holds the lease;
  - the browser ("3 tabs", accent while an agent drives it);
  - App Control (the app's name).
  The Mac's active tool alone is not a chip, nor is a powered-off device. Each
  read is gated on its action (`supportsWorkToolsState`,
  `supportsAppleDeviceStatus(laneId:)`, asked of the lane's machine). Chips hide
  in personal chats and while input is locked.
- **What a chip opens.** Simulator: `AppleDeviceViewer` (view only; hold Control
  to drive; see
  [Apple device › The phone: watch and control](../apple-device/README.md#the-phone-watch-and-control)).
  macOS: `MacDesktopViewer` when the host advertises the stream, else its sheet.
  Browser: its sheet. App Control: `AppControlViewer` while streaming, else its
  sheet. `WorkToolsSheet` shows one tool with pull to refresh. `ios` reads
  **Apple**; there is no `pr` tool.
- **Refresh is a poll** (the state is not in a table). The sheet polls
  `workTools.getLaneState` every 3 s while open. `WorkLaneToolsModel` reads it
  and `apple.status` every 10 s while the chat is on screen, skips while the
  sheet or a viewer is up, and publishes only the chips. A failed or slow read
  keeps the last state (`workToolsStateAfterRead`); the host answers the lane
  state within 2 s (`WORK_TOOLS_MAC_DESKTOP_STATUS_DEADLINE_MS`) with the last
  Mac Desktop status.
- **Frames.** The state carries the newest observation path; the sheet reads
  bytes through `workTools.readObservationPreview` (only the two observation
  cache roots, images only, 10 MiB cap). Both commands are `viewerAllowed` and
  in `MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS`. Browser login hand-off shows
  through `WorkToolsBrowserTab.handoffReason`. See
  [Chat › the Work tools pane on iOS and the hosted web client](../chat/README.md#the-work-tools-pane-on-ios-and-the-hosted-web-client).
- **Close a browser tab.** With `workTools.closeBrowserTab` (controller-only,
  not queueable; only a tab the lane shows; a gone tab counts as closed), rows
  have × and Close tab. The row shows "Closing “…”… Undo" for 5 s, then the
  close goes to the lane's machine. Closing the sheet sends pending closes. A
  failure restores the row with an alert. Fixtures: `tools-close`,
  `tools-close-pending`.

#### macOS card and viewer

- **Live picture.** With `hello.features.macDesktopStream` and
  `macDesktop.streamSubscribe`, `MacDesktopLiveView.swift` (an
  `AVSampleBufferDisplayLayer`) subscribes while visible, in front and
  connected, with one id per lane per app run, and resubscribes on reconnect.
  `macDesktop.streamRecord` pushes (a `config`, then Annex-B frames with SPS/PPS
  before each keyframe) decode off the main actor to AVCC through a
  `CMVideoFormatDescription`. `H264FrameGate` (in `H264SampleBufferFeeder`)
  holds P-frames until the keyframe after a gap. `macDesktop.streamEnded` ends
  the session or waits (`connection_closed`). A still loads once as the
  placeholder and stays on `stream.idle`; nothing polls stills.
- **Rules.** The phone never calls `macDesktop.stop`, calls `macDesktop.start`
  only from the Off card, and sends input only after Take control.
- **Card** (titled **macOS**): "W × H · bitrate · fps", chips (display, window
  count, **Recording**), the picture, `stream.lastError`, the lease ribbon,
  parked windows and **Watch**. With no display: "The macOS desktop is off."
  and **Start** (with `macDesktop.start`; an older host says to start it on the
  Mac); "Starting the macOS desktop…" while it starts.
- **Viewer** (`MacDesktopViewer.swift`): Close, Reconnect and Rotate. Watching
  zooms 1× to 4× with pan and double-tap 1× / 2.5× (`MacDesktopZoom` in
  `MacDesktopStreamMath.swift`). Take control forces landscape and no zoom
  (input mapping assumes no zoom); Return restores. An iPad does not rotate. A
  status card offers Reconnect (`lastError` wins). The footer says who watches
  and records. It polls every 3 s and subscribes as
  `…-mac-desktop-viewer-<lane>`; the sheet drops its subscription meanwhile.
  `mountMacDesktopLiveSession` and `macDesktopStartDisplay`
  (`MacDesktopLiveMount.swift`) are shared, so the two cannot unsubscribe each
  other.
- **Wire.** `macDesktop.recording` (`{ running, startedAt }`, optional), `fps`,
  `bitrateKbps` and `lastError`.

### The Proof sheet and viewer

- **Sheet.** `WorkProofSheet.swift` (`.medium` / `.large`) groups proof like the
  desktop drawer: `WorkProofDrawerModel.swift` mirrors
  `apps/desktop/src/shared/proofDrawerModel.ts` (by turn, newest first,
  "Earlier" last; cited items first; a `proof-compare` pair becomes
  Before/After). Each turn is one line over a two-column grid. Filters: All,
  Pictures, Videos, In answers. Pull to refresh; nothing polls.
- **Inline citations.** `WorkMarkdownParsing.swift` turns a line of only
  `![caption](ade-proof://<id>)` into a `proofCitation` block and a
  `proof-compare` fence into `proofCompare`. `WorkProofCitation.swift` finds the
  item (asking the host once more before showing "ADE has no proof with the id
  …"). Another project's or machine's chat reads its list and bytes from that
  host (`fetchRemoteChatComputerUseArtifacts`, `computerUse.listArtifacts`,
  `loadThisChatArtifact`). A failed load shows its reason and Retry
  (`WorkArtifactLoadIntent.retry`).
- **Row text.** `WorkProofRowModel` derives the title (else the kind), kind,
  relative time and the VoiceOver phrase ("Screenshot, Login page, 2m ago")
  with no view types (`WorkProofRowModelTests.swift`). `workProofRelativeTime`
  is hand-written ("now", "2m ago"); a host clock slightly ahead gives "now".
- **Viewer.** `WorkProofViewer` is a full-screen `TabView`, one page per item,
  with `.interactive` dots only when there is more than one. The position is
  1-based (1 if the selection is missing). The bar floats over the picture
  (`ignoresSafeArea(.top)`). Images zoom on black; videos get a player.
- **Video.** Read in 2 MiB slices (`readArtifactRange`) into a partial file,
  renamed when complete. Appearing does a one-byte size read: up to 8 MiB
  downloads; larger shows "Play · 34 MB" until tapped. Decode and write are off
  the main actor. A cancelled load leaves nothing; leaving the chat stops
  downloads. A host without `readArtifactRange` gets the whole file (8 MiB cap).

### Fixture screens for simulator screenshots

`WorkPreviews.swift` (DEBUG only) holds fixture data and
`ADEPreviewScreenHost`. `-adePreviewScreen <name>` (for example `proof`,
`proof-empty`, `proof-viewer`, `tools`) draws one screen and starts no live
machinery, so a simulator can capture it with no pairing, brain or network.
Release builds leave the branch out. `WorkToolsSheet` takes `previewState` and
`previewFrame`, which `refresh` installs instead of asking the socket.

### Tabs

| Tab | Icon | Desktop | Contents |
|---|---|---|---|
| **Lanes** | `square.stack.3d.up` | `/lanes` | The lane list (search, filter chips, `devicesOpen` chips) and lane detail. See [The Lanes tab](#the-lanes-tab). |
| **Files** | `doc.text` | `/files` | `FilesWorkspacePickerDropdown`, the live tree and file read. `FilesSearchScreen` searches names and contents in one query (names first under "Files"; content hits grouped per file; a tap opens the line). Files are editable. With no computer awake, a cloud lane's files come from GitHub. |
| **Work** | `terminal` | `/work` | Chats, CLI sessions and shells of every connected machine. See [The Work tab](#the-work-tab). |
| **PRs** | `arrow.triangle.pull` | `/prs` | List and detail from `prs.getMobileSnapshot`, `CreatePrWizardView` gated per lane, per-PR action capabilities. See [PR detail screen](#pr-detail-screen). |
| **CTO** | `brain` | `/cto` | The CTO thread. See [The CTO tab](#the-cto-tab). |
| **Settings** | `gearshape` | `/settings` (subset) | A sheet; see below. |

### Settings

- **Shape.** The connection header sits above Account, Preferences, this
  repository and this device. Connections: account sign-in (directory and
  Relay, no PIN), machine rename, QR or Nearby with PIN, SSH bootstrap,
  appearance, diagnostics, reconnect, forget, and **Push delivery**.
  `ConnectionSettingsView` gets plain snapshots (`SettingsConnectionSnapshot`,
  `SettingsPairingSnapshot`, `SettingsDiagnosticsSnapshot`,
  `SettingsPushDeliverySnapshot`) from `SettingsConnectionPresentationModel`;
  the sections never read `SyncService`. About shows `v<marketing> (<build>)`.
  Settings also has **Usage** (`SettingsUsagePage`) and **AI accounts**.
- **AI accounts** (Settings → App, and from a machine page's account counts).
  Logins live on each machine, so each has its own accounts, default and smart
  balance.
  - **Accounts on** (`ProviderAccountsMachinePicker`) lists the primary and
    every live fleet machine that advertises `providerAccounts.list`, without
    changing the primary. Commands go through `ProviderAccountsHost`
    (`SyncService`, or `MachineConnection`; the commands are runtime-scoped)
    wrapped by `ProviderAccountsClient`. Each `ProviderAccountsMachine` has a
    store per provider and its own `usage.getQuotaSnapshot`, because account
    ids repeat across machines. A host without the command shows
    `ProviderAccountsUnavailableView`.
  - Rows (`ProviderAccountRow`) carry quota meters (`providerAccountWindows`,
    `ProviderAccountQuotaMeter`, ordered by `adeUsageWindowRank`) and badges
    (`ProviderAccountBadges`): **Next chat** (from
    `MobileUsageQuotaSnapshot.balanceNext`), **New chats** (the default while
    smart balance is off), Signed out, Copy, 1h cache and Login replaced.
    **Smart balance** shows with two or more logins or while on; **Auto-start
    5-hour windows** shows when the machine reports a `five_hour` window.
  - Swipe or menu: use for new chats (`ProviderAccountsStore.useForNewChats`),
    sign out (`providerAccounts.signOut`), remove (never the default or the
    machine's own login), or open `ProviderAccountDetailPage` (the same actions,
    the copy and replaced-login notices, and
    `ProviderAccountSettingsSection` in `SettingsProviderAccountSettings.swift`:
    Claude's Main chat cache, Subagent cache, Extra usage, and per-account
    **Auto-compact** with more than one account). Each change goes through
    `providerAccounts.setSettings` with the `instanceId` and is read back, so an
    older ADE that drops it shows an error.
  - **Add account** makes a nameless account and opens
    `ProviderAccountSignInSheet`: it starts the host's login, polls
    `loginStatus`, and relays the pasted Claude code or shows the Codex device
    code (the phone cannot reach the host's localhost ports). Closing cancels.
    The CLI runs on the machine.
- **Signed-out agent in a chat.** When a turn stopped because the agent is
  signed out on the chat's machine (`errorInfo.agentCli.category ==
  "unauthenticated"`, `WorkChatEnvelope.signedOutAgent`), the transcript shows
  one line ("Muse Code was signed out", then "signed in again",
  `workSignInRecoveredIds`) and `WorkProviderSignInCard`
  (`WorkProviderSignIn.swift`) replaces the composer. It signs in on the chat
  machine's connection (`WorkSessionDestinationView.providerSignInHost`, never
  the primary for another machine's chat) through `providerAccounts.login*`,
  `ai.cliLogin*` (Kimi with a region picker) or `ai.antigravitySignIn*`. It
  opens links in Safari once, copies a device code, sends back a pasted code,
  and resends the last message with its files once the login reads back. Not
  now hides it for that failure; a read-only quick look shows none. A host
  without the `ai.*` commands shows the "cannot do this from the phone yet"
  error.
- **Before a send.** On open and on connect, `WorkChatSessionView` reads
  `ai.getStatus` on the same connection, and `workProviderSignedOutBeforeSend`
  applies desktop's test (`runtimeDetected`, not `authAvailable`, not
  `runtimeAvailable`, a provider the card can sign in). The answer is kept per
  machine and provider. The card reads "Sign in to Muse Code" and sends nothing
  after. Not now hides it for that machine. No answer, no card. Fixtures:
  `chat-signin`, `chat-signin-recovered`, `chat-signin-before-send`.
- **Login to Claude.** `WorkModelPickerSheet` offers it when Claude models are
  unavailable: `SyncService.startClaudeLoginTerminal` sends
  `work.runQuickCommand` (`startupCommand: "claude auth login"`, `toolType:
  "shell"`) on the main checkout and opens the session, fetching lanes first
  when the caller has none.

### The Work tab

The session list is in [Work session list rows](#work-session-list-rows).
Running chats also count in the Work tab badge
(`SyncService.runningChatSessionCount`). A standalone CLI session stays listed
after it ends, as on desktop. `workSessionShouldAppearInWorkList`
(`WorkBrowserHelpers.swift`) hides a chat-owned child shell that is not live.

**New session** (`WorkNewChatScreen`):

- A nav-bar pill switches between **Chat** and **CLI**. In CLI mode,
  `workResolveCliProvider` takes the provider from the picked model.
  `workNormalizedNewChatProvider` keeps Droid models on the `droid` provider.
- The lane picker (`WorkLanePickerDropdown`, searchable, with an
  auto-create-lane row) is pinned above the composer and opens its list as a
  sheet. The screen parks the composer's focus while the sheet is up and
  restores it in the sheet's `onDismiss`.
- The header above the picker steps through `WorkNewChatHeaderTier` (`full`,
  `compact`, `minimal`, `hidden`) from the measured height left for the scroll
  area, never from keyboard notifications, with hysteresis on the way up. The
  usage carousel stays mounted at every tier and collapses to zero height, so
  it does not fetch again.
- The composer's `⋯` menu holds **Issue context** and **Account**:
  - Issue context: Linear in both modes, GitHub in Chat mode only, each when
    the host advertises its attach command. It reads the focused machine's
    project, so it is hidden for a chat on another machine or project.
  - Account: a Claude or Codex launch on another signed-in account of the
    chosen machine, shown only when there is a real choice.
- The controls row (`WorkComposerControlsRow`) is shared with the in-session
  composer: the access dropdown, the model pill, and fast mode (Chat mode and
  fast-capable models only, as `codexFastMode`).
- `WorkComposerPreferences` (App Group `UserDefaults`) keeps the last model,
  access mode, reasoning effort and fast mode. The New Chat screen, the inline
  picker and the session settings sheet read and write it. A provider change
  resets the coupled access mode to that provider's defaults.
- CLI mode sends `work.startCliSession` with the provider, the permission mode
  (Claude also has `auto`), an optional `reasoningEffort` and an optional
  opening message. Codex gets the opening message as its last argv argument
  (`buildTrackedCliLaunchCommand`); other providers get it typed into the PTY.

**Terminal** (`TerminalSessionScreen` + `SwiftTermSessionView`):

- A full-bleed SwiftTerm emulator. A tap raises the keyboard, and keystrokes
  go to the PTY as `terminal_input` (coalesced about 16 ms). The PTY echo is
  the only source of truth. A key bar gives esc, tab, a latching Ctrl, arrows
  and return. Pinch changes the font size.
- While the screen is open, the phone owns the PTY size (`terminal_resize`).
  The runtime restores the desktop size on detach.
- Output streams as offset-stamped `terminal_data` with gap detection and
  `sinceOffset` resume. Near the top, `terminal_history` loads older output.
  A "↓ Live N" pill returns to the live tail. Only a user drag unpins the
  view; a layout change keeps a pinned view at the tail.
- With mouse reporting on (Claude Code, htop), a vertical pan is sent as SGR
  wheel events. A host with no offsets gets a 2 s tail refresh until offsets
  appear.
- `terminal_unsubscribe` runs on disappear. An ended agent CLI row takes a
  message to continue (see Gotchas).

**Chat composer and chat header:**

- The input is `WorkComposerTextView` (`WorkComposerTypedTriggers.swift`), a
  `UITextView`, because it needs the cursor position and styled runs.
  `WorkComposerTriggerDetector` uses the desktop `composerTriggers.ts`
  regexes, so `/command` and `@file` work anywhere in the draft. See
  [Chips on the phone](#chips-on-the-phone).
- `WorkComposerSuggestionController` shows the suggestion strip from the
  active trigger only: a per-provider slash catalog, and `@file` quick-open
  through `SyncService.quickOpen` (40 ms debounce). Confirmed tokens draw as
  chips (`WorkComposerChipLayoutManager`), and `draftState.text` stays the
  plain text that is sent.
- `WorkSmartLinkDetector` draws GitHub, Linear, ADE and web URLs as chips.
  Delete removes a whole URL, and a long press offers Copy link and Remove
  link.
- Attachments draw in `WorkChatAttachmentTray`, with placeholder tiles until
  the image bytes sync.
- The chat header's PR menu opens the lane's PR on GitHub, copies its link,
  or starts the create-PR wizard (`singleModeOnly`). `WorkChatLanePrPolicy`
  decides whether a chat looks up a lane PR at all. The CTO chat and
  subagents do not, so they show no badge and send no request.
- A row with a lane PR (`LanePrTag`) offers "Open in PRs tab" in its
  long-press menu. It publishes `syncService.requestedPrNavigation`, and
  `ContentView` opens the PR.

### The Lanes tab

- **List.** Each row carries a render signature, as Hub rows do, so
  `.equatable()` re-renders only rows whose visible state changed.
- **Detail screen.** It is full-screen and hides the tab bar. Its sections
  (`LaneDetailSectionChrome`) open when they have content and close when empty
  (`LaneSectionDisclosure`), until the user toggles one. Header chips and Git
  buttons wrap through `LaneChipFlowLayout`.
- **Git** (`LaneDetailGitActionsPane`, a port of the desktop Git pane):
  - commit with amend; pull (rebase or merge), push (force-with-lease), fetch
  - staged and unstaged files with stage, unstage, discard, restore, diff and
    open, per file and in bulk
  - stash push, apply, pop and drop
  - recent commits with view files, copy message, revert and cherry-pick
  - a "more actions" menu: switch branch, rebase lane, rebase and push, force
    push
- **Conflicts.** A banner offers continue and abort for a rebase and a merge
  (`git.rebaseContinue`/`Abort`, `git.mergeContinue`/`Abort`).
- **Create.** The creation sheet can copy uncommitted changes into the new lane.
  Template-backed environment setup shows its progress.
- **Options menu.** It copies deeplinks (`LaneDeeplinkHelpers`:
  `ade://lane/<id>`, `ade://repo/<owner>/<repo>/branch/<branch>`) and opens
  `LaneManageSheet` (delete, appearance, archive), the mirror of desktop
  `ManageLaneDialog`. The sheet title has a pencil rename, hidden for the main
  checkout and for hosts without `lanes.rename`. Every lane is managed the same
  way wherever its worktree is, so there is no adopt action.

### The CTO tab

- **Content.** The pure `ctoRootContent(identity:loadError:hostUnreachable:)`
  picks loading, load error, **model pick** or the thread, in the order of
  desktop `CtoPage`. `CtoSessionDestinationView` holds the one session.
- **Model pick.** `CtoIdentity.modelPreferences` is optional, and the host sets
  a preference to null when its provider cannot steer a live turn. In that
  state the screen does not build `CtoSessionDestinationView`, so no session
  starts on a provider the user did not choose.
- **Pickers.** Both CTO model pickers pass `modelFilter` to
  `WorkModelPickerSheet`, which removes providers and groups that become empty.
  The predicate `providerSupportsLiveRedirect` mirrors
  `CTO_LIVE_REDIRECT_PROVIDERS` (a parity test pins it). `applyModelPick` writes
  the identity preferences, ensures the session, pins the model, and publishes
  the snapshot last, so the picker does not close early and no second ensure
  runs.
- **No "Send after turn".** `liveRedirectOnlySends` goes from
  `CtoSessionDestinationView` through `WorkSessionDestinationView` to
  `workChatActiveSendCapability`, which removes `queue` (and moves the default).
  It is its own flag, not a second meaning of `showsLaneActions` or
  `compactComposer`. The host also caps the CTO steer queue at zero.
- **Settings gear.** Home machine, identity (name and standing instructions),
  model, reasoning and Fast, read-only Linear status, and memory
  (`cto.getMemory`).
- **Badge.** `SyncService.refreshCtoAttentionIfNeeded()` calls the optional
  `cto.getAttention` (5 s debounce, gated on `supportsRemoteAction`) and
  publishes `ctoAttention`. It runs before the roster-signature early return
  of `refreshActiveSessionsAndSnapshot`, because the roster leaves out the CTO.
  `saveRemoteCommandDescriptors` calls it with `force: true` after a connect. A
  transport failure or an `unknown` status keeps the last value. A brain
  without the action clears it, and the phone falls back to `awaitingInput`.
- **Home asleep.** "Read where <name> left off" opens the CTO account copy (see
  [ADE Cloud on the phone](#ade-cloud-on-the-phone)).

## Lane data projection

### Project switch

- **Scope.** Lane, file, Work and PR projections read
  `Database.currentProjectId()`. The active id is in `UserDefaults`, mirrored
  into `DatabaseService`; with no project row yet, the Hub shows.
- **One project at a time.** The runtime runs one active sync project behind
  one listener on a stable port. A switch activates the project, returns
  `connection: null`, and the phone reconnects on the same port with its
  pairing. An offline runtime still records the choice.
- **Cursors per host DB site.** `remoteDbVersionBySite` (keyed by
  `serverDbSiteId`) lets a project resume where it stopped. A gap over 5,000
  versions may come as one ACK-gated compact catch-up batch.
- **Reset.** Before the old connection goes, `SyncService` calls
  `resetChatEventState(clearHistory: false)` and
  `resetTerminalSubscriptionState(clearHistory: true)`, so the phone never
  resubscribes to the old project's ids. Pending requests belong to their
  socket generation: teardown fails only the retiring one, and the timeout
  handler refuses stale ones.
- **No blank screen.** `HubScreen` shows `HubConnectingCard` only when it has
  nothing to show (`!canShowProjects && hubProjectPresentations.isEmpty`).
  During a switch the tapped row spins (`presentation.isSwitching`) and the rest
  dim to 0.55 (`syncService.isProjectSwitching`).
- **Fast path.** The race leads with the network's remembered route, then
  `lastSuccessfulAddress`. `hello_ok` is the barrier: lane presence and catalog
  refresh run later in `schedulePostHelloWork`. `logProjectSwitchPhase` traces
  phases (`ADE_SYNC_TRACE project_switch`). The runtime prewarms the two most
  recent scopes (`prewarmRecentScopes` in the sync README).
- **Stable id.** When the cached id and the machine's id differ for one root,
  the catalog reconcile adopts the machine's id once (`refreshProjectCatalog`).
  If it still changes while connected, `setActiveProjectId` restarts the first
  hydration (the old requests cancel themselves).
- **Hub layout** (`HubLayoutStore`) is phone-only, per machine: on the first
  catalog the active project opens and the rest start closed; seed markers keep
  later user choices. Manual order is in the same record. A quick connect from
  the no-machine home fires `ConnectSuccessBeat` and a haptic
  (`HubScreen.triggerConnectBeat`).

### What the runtime sends

- **`LaneListSnapshot`** with runtime buckets (running, awaiting input, ended,
  count). Every git worktree appears on its own; there is no attach, adopt or
  move action. `adoptableAttached` is always `false`, but the host **must keep
  sending it**: shipped builds decode it as a required `Bool`. See
  [Lanes › Gotchas](../lanes/README.md#gotchas-and-fragile-areas).
- **`LaneDetailPayload`** per lane. `lanes.getDetail` and
  `lanes.refreshSnapshots` carry a `signature`; the phone sends it back as
  `ifNoneMatch` and keeps its cache on `{ signature, notModified: true }`
  (`LaneNotModifiedEnvelope`). See [remote-commands.md](./remote-commands.md).
- **`LaneEnvInitProgress`** from `lanes.initEnv`, `lanes.templates.apply` and
  `lanes.getEnvStatus`. `LaneCreateSheet` turns into a progress panel. Only a
  `failed` step is red; a `skipped` step is muted
  (`LaneEnvInitProgressView`).
- **`LaneSummary.devicesOpen`** from presence announcements.
- The phone stores results and reads locally. A cheap refresh may skip
  `includeConflictStatus`; the phone keeps the last conflict badges.

### Revisions and tab shells

- Reloads key on `lanesProjectionRevision`, `laneDetailProjectionRevision`,
  `workProjectionRevision`, `filesProjectionRevision`, `prsProjectionRevision`
  (replicated PR changes), `prsRemoteRevision` (the host's `prs_updated`) and
  `proofArtifactsProjectionRevision`. Work's roster overlay also keys on the
  per-project `rosterRevision(for:)`. Each screen watches only its revision.
- `LanesTabShell` and `PRsTabShell` narrow `SyncService` into `Equatable`
  inputs (`LanesRootInputs`, `PrsRootInputs`), and the screen is `.equatable()`
  on them. A hidden tab tracks only its navigation request and the project.
  **A field the body reads from `SyncService` must be in the struct.** Both
  stay mounted across a switch and clear old rows on `activeProjectId`.

### Lanes tab list

A `List` with a search field (`.searchable` does not render here, because the
bar is hidden), filter chips with counts (`LaneQuickFilter`: Active, Running,
Needs you, Changes, Archived), the focused machine's lanes in stack order, then
each other machine's lanes under its name. Rows swipe to pin and to archive or
restore; a machine with no link shows its last roster dimmed with no swipes.
Archived also lists each live machine's Recently deleted lanes
(`LaneRecentlyDeleted.swift`) with Restore or Put back and a swipe to Drop; a
delete that kept work shows a notice with Restore. Opening a lane pushes
`LaneRoute`. Lane detail reads the cache and the host once on open, and the
cache again if a local revision landed meanwhile.

## PR data projection

- **Snapshot.** The PRs tab reads one command, `prs.getMobileSnapshot`
  (`PrMobileSnapshot`): `prs` (`PrSummary`), `stacks` (`PrStackMember`: `role:
  root | middle | leaf`, dirty flag, PR link, branches, checks and review),
  `capabilities` (`PrActionCapabilities` per PR: `canMerge`, `canClose`,
  `canReopen`, `canRequestReviewers`, `canRerunChecks`, `canComment`,
  `canUpdateDescription`, `canDelete`, `mergeBlockedReason`, `requiresLive`),
  `createCapabilities` (`PrCreateLaneEligibility[]`: `canCreate`,
  `blockedReason`, default base and title) and `live` (false shows a "machine
  offline" banner).
- **Create.** `CreatePrWizardView` takes a source lane and target branch,
  titles `source lane -> target lane`, and sends `prs.createFromLane`.
- **GitHub rows.** The list reads `repoScopedGitHubPullRequests` and ignores
  `externalPullRequests`. A routed PR with no lane-PR row gets a fallback item
  from the GitHub row and snapshot, never `Pull request / @unknown`.
- **Reconcile.** The list joins the bounded GitHub projection with the
  replicated mapped-PR cache, so linked rows work offline and a replicated
  merged or closed state beats a stale Open. All scope reads exact totals from
  one cached GraphQL count; ADE and External count locally. Terminal history
  pages two at a time, up to ten. `prs_updated` invalidates the list; the view
  coalesces 300 ms and reads once with row revalidation off (no timer, no
  per-PR request). Manual refresh runs PRs and lanes in parallel.
- **Merged rows** (`PrHelpers.swift`). `GitHubPrListItem` and `pull_requests`
  carry `detached` (`PrDetachedLane`: frozen name, color, chat, artifact and
  checkpoint counts), `mergedBy` (`PrMergedBy`), `mergeMethod`, `commitCount`
  and `changedFiles`, all optional, because old PRs and old hosts lack them and
  a required field would fail the whole decode. See
  [Detached PR rows](../pull-requests/README.md#detached-pr-rows).
- **Period groups.** `prListPeriodGroups` adds the desktop headers (Today,
  Yesterday, This week, Last week, a week range, a month) with a count and a
  `+1.2k −380` sum, filed by `mergedAt → updatedAt → createdAt`; Open is not
  grouped. `prMondayAnchoredCalendar` sets `firstWeekday = 2`, because
  `Calendar.current` is Sunday-first in `en_US`.
- **`PrRowCard`.** A state symbol, a two-line title with age, an identity line
  with the lane (nothing when none; no `Unmapped` capsule, see
  [A lane link is not a permission](../pull-requests/README.md#a-lane-link-is-not-a-permission)),
  and a branch line with checks, reviews and comments. No avatar fetch. In the
  merged and closed buckets the identity line is `was: <lane>` for a detached
  PR (else nothing) and the branch line is `<merger> · <method> · → <base>`.
  Filter, sort, counts and reconcile recompute only on input change.
  `PrRowCardSkeleton` has the same geometry. The `External` header is a plain
  label.

### PR detail screen

Sources: `PrDetailScreen.swift` (`PrDetailView`), `PrConversationDigest.swift`
(pushes, bot groups, story events), `PrDetailHeaderComponents.swift`,
`PrGitHubDescriptionParser.swift`, `PrDetailOverviewTab.swift`,
`PrHelpers.swift`, `PrDetailRedesign.swift`.

- **Layout.** A single-column version of the desktop view. Overview is sibling
  `List` rows (`overviewThreadRows`), so it virtualizes. The bar has a back
  chevron, the number, author and state (`PrFlatDetailNavTitle`) and `⋯`.
- **Reading order:**
  1. `PrDetailHeaderCard`: number, author, age, state, title, `base ← head`,
     lane.
  2. `PrLocalLaneOfferBanner`, closed by default, when no local lane tracks the
     branch: Create lane from branch (`prs.createLaneFromPrBranch`), Link an
     existing lane (`prs.linkToLane`) or Open in GitHub. It is an offer;
     nothing is gated on it.
  3. `PrThreadDescriptionCard`: GitHub HTML becomes safe Markdown,
     `<details>` becomes a `DisclosureGroup`. `prDescriptionPieces` (the twin of
     desktop `prBodyProof.ts`) draws a picture alone on its line, a GitHub
     attachment alone on its line as a tap-to-load video, and a Before/After
     table as a comparison. Only GitHub-served media loads
     (`prIsGitHubMediaURL`), because a remote picture tells its author who read
     it. Long text folds behind "Show more".
  4. `PrNeedsAttentionHeader`: open review threads with reply and resolve.
  5. History from `buildPullRequestTimeline`, folded by
     `buildPrDigestDisplayItems`: `PrPushDividerRow` per push and one
     `PrBotGroupRow` per bot per push (`reviewerIsBot` / `authorIsBot` also
     fold a bot login without `[bot]`).
  6. Resolved threads, folded.
  7. The comment composer (every PR).
  8. People, the ADE stack and the post-merge cleanup banner.
- **Merged facts.** `PrShippedFacts` gives up to three lines (`by arul · squash
  · 3 Jan`, `12 commits · 9 files · open 2d 4h`, `was: auto-naming · 3 chats ·
  2 proof`), each omitted without inputs.
- **Next step bar** (`PrNextStepBar`, opaque, on every tab): the headline from
  `PrNextStep.resolve` (the port of `resolvePrNextStep`) and one action. Merge
  state comes only from the snapshot: "Checking merge status…" while loading,
  "Merge status unavailable" when none came; never the list row's data. A tap
  opens `PrNextStepSheet` (detail, chips, the second action, "Merge anyway"
  for an admin bypass). Overview has no merge rail or checks, commits and files
  cards.
- **Tabs** Overview, Files, Checks; Checks has `PrChecksTabNote`. A saved
  `.activity` selection opens Overview. `⋯` adds draft toggle
  (`prs.setDraft`), auto-merge (`prs.setAutoMerge`, shown by
  `autoMergeAllowed`) and Copy number, branch and checkout command.
- **Derived models** (timeline, digest, thread split, fallback PR) are built in
  `recomputeDerivedModels()`, never in `body`.
- **PRs with no row** open the same screen as `gh:owner/repo#number`, seeded
  from the warm cache, then `prs.getMobileGithubDetail` in one command. Reads
  and actions are the same as with a lane; `hasLocalLane` only shows the
  banner. `unavailableParts` keeps the last good fields and shows a partial
  notice; retry waits the 25 s window unless explicit.
- **CI checks.** The phone never decides CI. Every surface (`PrRowCard`, the
  next-step chips, `PrMergeChecklist`, `prComputeMergeGate`, Work-chat PR views,
  `PrDetailChecksTab`) reads the host's `checksStatus` (`passing | failing |
  pending | none | not_run`), `checksReason` and `checksMissingRequired`.
  `not_run` is a dashed ring and "No CI ran on this commit" over `checksReason`;
  `none` stays quiet. `prChecksSummaryStats` (`PrChecksStatStrip`) gives
  neutral and skipped their own muted bucket, and under `not_run` marks
  passing rows unverified. Missing required contexts show as ghost rows. See
  [pull-requests](../pull-requests/README.md#checks-rollup-what-counts-as-a-pass).
- **Palette.** The iOS kit (`ADEKit.swift`; see
  [visual language](../../design/visual-language.md#ios)) with no blur or glow.
  GitHub state colors (open `#3fb950`, merged `#a371f7`, closed `#f85149`)
  through `prStateColor`, `PrStateIcon` and `PrStatePill` (`PrRowCard.swift`).
  Only floating controls (next-step bar, reply box, diff navigation) use glass.
- **Freshness.** Sidecars (threads, activity, runs, deployments, capabilities)
  reload on `prsProjectionRevision` and `prsRemoteRevision`, behind
  `detailFreshnessWindow = 25 s`: within it, only the local projection
  refreshes. The warm cache seeds the first paint. Pull to refresh and Retry
  pass the window. Merge, close, reopen, comment and edit go through
  `SyncService.runDurablePrAction`, so spinners survive a remount.
- **Reactions and edits.** `PrReactionBar` under the description and each
  comment: pills (yours tinted) and + with GitHub's eight, shown at once and
  undone if `prs.reactToComment` fails. There is no remove. Your own comments
  (author == `writeViewerLogin ?? viewerLogin`) have Edit through the optional
  `prs.updateComment` (the host checks PR and account).
- **Live checks.** While the PR is on screen, the app active, the link up and a
  check running, the screen reads only checks (`prs.getChecks`, or
  `prs.getChecksByGithub`) every 45 s, every 120 s after ten minutes, and stops
  when CI settles, then reloads once. Fixture: `pr-conversation`.

## Command policy from the runtime

The phone gates actions on the runtime's descriptors
(`SyncRemoteCommandDescriptor.policy`: `viewerAllowed`, `requiresApproval`,
`localOnly`, `queueable`), not on fixed phone rules. A policy change shows on
the next descriptor read.

- **Scheduled work.** `chat.cancelScheduledWork` (viewer-allowed) and
  `chat.setScheduledWorkPaused` (viewer-allowed) are non-queueable;
  `chat.createScheduledWork` is controller-only and has no phone control.
  `WorkSessionDestinationView` checks `canInvokeChatRemoteAction` before it
  builds Cancel, and `WorkScheduledWorkRow` also needs `durable == true` and an
  active status. Personal sessions map to `personalChats.cancelScheduledWork`
  and `personalChats.setScheduledWorkPaused` (non-queueable). See
  [Chat Info](#chat-info).
- **Provider accounts.** `providerAccounts.list`, `getSettings` and `refresh`
  are viewer-allowed. `loginStatus`, `create`, `remove`, `rename`,
  `setDefault`, `dismissReplaced`, `setSettings`, `loginStart`,
  `loginSubmitCode` and `loginCancel` are controller-only (a viewer may see
  logins but not change them or watch a sign-in code).
  `SettingsProviderAccountsPage` gates on `supportsProviderAccounts` (`list`)
  and its controls on `canChangeProviderAccounts` (`setDefault`).
- **Usage** (viewer-allowed project actions):
  - `usage.getQuotaSnapshot` reads the host's cached Claude and Codex windows;
    `usage.refreshQuota` runs a bounded refresh with no interactive host
    authentication. Work shows a compact summary from the host's percent used.
  - Live limits mirror the desktop band: a group per provider, a card per
    window and **one named row per account, always**, with provider colors
    from `ADESharedTheme`, pressure colors, reset countdowns, source,
    freshness, errors, refresh and the limits link
    (`MobileUsageProviderStatus.accountUrl`; an older host hides it). The
    snapshot has `accounts[]` and a per-window `accountId`. The math is
    `adeUsagePoolAccounts` and `adeUsageLimitCards` (`ADEUsageDesign.swift`,
    matching `usageLimitModel.ts`). A row opens
    `ADEUsageAccountDetailSheet` (plan, machines, headroom, reset time, what
    the reset restores, pace, link). `WorkUsageLimitsModule.swift` draws the
    same cards in Work.
  - `usage.getAdeStats` returns the desktop's activity snapshot with daily
    points and `desktop`, `mobile`, `tui` and `web` attribution, for the
    new-chat module and the Usage page. Pull to refresh on new chat refreshes
    quota and the selected range.
- **Usage page** (`SettingsUsagePage.swift`): cost hero and provider split,
  daily chart, Live limits, metric strip, breakdown, all built into
  `SettingsUsagePageModel` on payload change, never in `body`.
  `SettingsUsageChart.swift` is a `Canvas` (a 60-bucket, five-series chart would
  be 300 views). Touching a pace bar keeps that provider lit.
- **Activity skyline** (`WorkUsageSkyline`) starts a week before the first
  active day. With little data, the Tokens and Code bars draw two weeks of
  slots, and one client gets a caption, as desktop `ActivityModule.tsx` does.
- **`ADEUsageDesign.swift`** mirrors `usageDesign.ts`: five type steps, the
  card rhythm, pressure thresholds and "top N plus Other". Heavy work is in
  `build` functions called from a task or `onChange` and held in `@State`.
- **`MobileUsageQuotaStore`** saves snapshots per host identity, rebinds on a
  machine change, drops a late response from the old host, and clears the view
  when the host is unknown or lacks the actions (limited mode with update
  guidance; never another machine's limits). It also holds the range-keyed
  stats: `loadStats(range:using:force:)` serves its memory cache at once and
  refreshes in place, with a generation counter and a host re-check. The cache
  is memory-only (`MobileAdeUsageStats` decodes leniently and cannot encode).
  `force` passes through to the host. A host without `usage.getAdeStats`
  clears the stats and shows update guidance.

## Implementation status (phone specifics)

The sections above describe each area. This table gives only its state.

| Area | State |
|---|---|
| Connection: account sign-in and Relay, QR or Nearby with PIN, SSH bootstrap, DPoP device trust, LAN/Tailscale/Relay routes | Implemented |
| Sync: native SQLite with pure-SQL CRR, deflate, chunked envelopes, protocol version floor | Implemented |
| Hub, account projects, personal chats, several machines at once | Implemented |
| Lanes, Files, Work, PRs and CTO tabs | Implemented |
| ADE Cloud with no computer | Implemented ([ADE Cloud on the phone](#ade-cloud-on-the-phone)) |
| Push notifications, Live Activity, Lock Screen and Home Screen widgets | Implemented (push and Live Activity starts need a physical iPhone to verify) |
| iPad and iPhone Duo layouts | Implemented (`Views/Duo/`) |
| Settings | Implemented for pairing, account, providers, usage, machines and ADE Cloud; not all desktop settings |
| Automations and History tabs, Control Center widgets, Spotlight | Not built |

## Gotchas

### Data, sync and connection

- **Screens observe `SyncMenuSafePublisher`, not `SyncService`.** SwiftUI
  rebuilds an open `Menu` when a view above it re-renders, and a connected
  phone publishes about 15 times a second. `SyncMenuSafePublisher.shared`
  holds publishes while a context menu is up and sends one when it closes.
  Declare observers as `@ObservedObject private var syncPublishes =
  SyncMenuSafePublisher.shared` with `var syncService: SyncService {
  syncPublishes.service }`, never `@EnvironmentObject var syncService`, and use
  `syncService.bindings.x` for bindings. `ADEApp` holds its services in
  `@State`.
- **The phone never runs anything.** Agents, PTYs, worktrees and workers are on
  the runtime; a phone feature is a command to the runtime.
- **The local DB is the read source.** Fix a stale read on the runtime push
  side (a CRR table the phone reads), not with a runtime-only cache. Personal
  chats are the exception: read through `personalChats.list`, cached per host,
  streamed with `chatScope: "personal"`, never merged into project tables.
- **Reads stay in the active project.** If a switch fails, roll back the
  project id, profile, token and remote DB version together.
- **Generated schema.** Regenerate `DatabaseBootstrap.sql` when desktop
  `kvDb.ts` changes, and add each new replicated column to `Database.swift`
  too (see [Database](#database-native-sqlite--pure-sql-crr)).
  `pull_request_chat_sessions` is cleaned with PR rows and retired chats, with
  no secondary unique index. `changeset_batch` apply skips rows of unknown
  tables (that data is missing until the app updates); an unknown column fails
  the batch.
- **Model catalog size.** `ade.agentChat.modelCatalog` sends only connected
  OpenCode providers (the full directory is about 7.2k models, 4.85 MB). The
  phone drops empty provider blocks and groups
  (`providers.filter { !$0.models.isEmpty }`), because iOS has no OpenCode
  connect flow; `WorkModelPickerSheet` shows a hint instead. Weigh any growth of
  this payload against the phone. The picker uses a `LazyVStack`, because one
  provider (`openrouter`, `github-copilot`) can list hundreds of models.
- **Keychain items can survive an uninstall.** "Forget machine" clears both
  Keychain and the draft row.
- **Trust reset is narrower than an account reset.** `MobileTrustResetPolicy`
  clears every connection token and machine-scoped state (drafts, profiles,
  selected project, pending operations, cursors, descriptors, hidden projects,
  reconnect pause) once. It keeps Clerk keys, the device id, the DPoP identity,
  analytics preferences and PIN state. Its marker is written only after the
  Keychain clear succeeds.
- **Direct trust outlives account access.** A signed directory adoption makes
  the same direct credential as QR, Nearby, PIN or SSH. Never make such a
  profile depend on Relay because the Mac also shows in the directory. The
  directory's `online` is only a 90 s lease; with a verified endpoint the phone
  may dial and let the hello decide. Only a final 401 or 403 after one forced
  refresh means the credential expired.
- **Hydration timeout.** `InitialHydrationGate` can time out (15 s) on slow
  links with "The machine returned incomplete ... data." Do not raise it; make
  catch-up faster or let the user retry.
- **Latency over throughput.** The phone sends one command at a time. Batch
  bulk work into one command with one reply.
- **A timeout is not a dead connection** (see [Timeouts](#timeouts)). New
  transport code must bump `lastInboundMessageAt` on inbound traffic and treat
  it as the liveness source.
- **Connection UI reads `SyncConnectionHealth`**, hydration reads
  `SyncDomainStatus`, and "attached?" reads `SyncService.isAttached`. Never add
  a transport state for syncing.
- **The chat-summary cache merges.** `cacheChatSummaries` folds summaries in by
  id, because a partial refresh (the reduced-load `prefix(6)`, or a lane whose
  `listChatSessions` fails) omits the open chat and a nil summary disables the
  composer's model controls (`summary.isAvailable`). A project switch or
  disconnect clears it all (`resetChatEventState(clearHistory: true)`).
- **`ADE_PROJECT_ROOT`.** `ade serve` pre-registers that project
  (`ProjectRegistry.add`, `scopeRegistry.ensureSyncHost(preferredSyncProjectId)`).
  Without it, the phone waits for the desktop to pick a project.
- **Lane presence** is best effort: a 30 s announce, a 60 s runtime TTL. A
  crashed phone leaves `devicesOpen` one cycle later.
- **Phone file edits have no read-only gate.** `mobileReadOnly` and
  `isReadOnlyByDefault` still ride the payload but block nothing.

### Chat stream and transcript

- **Push with `seq` resume.** `chat_subscribe` starts a `chat_event` fan-out
  from `agentChatService.subscribeToEvents`. The phone keeps the highest
  applied `seq` per session, drops duplicates and sends it as `sinceSeq`; an
  uncoverable gap or a non-resumed ack resets to a snapshot. A host hands the
  high-water mark to the next host. The host counts an event as sent only when
  the socket takes it, and retries in order under backpressure. Events with no
  `seq` (older hosts) skip the watermark.
- **`seq` is a resume cursor, not an identity.** Older hosts reset it across
  restarts, so an old transcript can repeat a number. `AgentChatEventEnvelope.id`
  includes the timestamp, so a true redelivery collapses and a cross-epoch
  collision does not. The engine keys its log on the durable `sequence`.
  Current hosts keep `(sessionId, seq)` unique across rehydration
  (`readTranscriptHydrationState` in `agentChatService.ts`) and handoff
  (`syncHostService.ts`).
- **One thread engine per warm chat is the only transcript.**
  `ChatThreadRegistry` (in `SyncService`) keeps a `ChatThreadEngine` actor for
  each open chat, the 8 most recent and every live turn; `ChatLogStore` caches
  sequenced envelopes on disk per (machine, session, scope). Opening a chat
  attaches its model in `init`/`onAppear` (warm: the first frame; cold: from
  disk) and sends `chat_subscribe` in the same run-loop turn (`sinceSequence` on
  a `chatLogV2` host with history, else a full snapshot that extends the
  cache). Summary, session row and proof load in parallel and never gate rows.
  Older history pages from disk, then `chat_history`. A host stand-in for a row
  too large to page (`system_notice`, `status: "history_row_omitted"`, no
  sequence) lives in memory only, placed by time, never stored, never a cursor.
  Work warms its top rows and live turns; launch warms the 5 latest chats.
  Forgetting a machine purges its cache; sign-out and account switches purge
  all; background flushes writes. Offline, cached rows show; the skeleton shows
  only with no rows and no snapshot.
- **Rows reconfigure only for what they draw.** The shared content revision
  holds rare values (expansion, bubble width, live state). The streaming id,
  an in-flight action and the viewport height go only into the rows that read
  them (`workChatTranscriptRowRevision(_:base:inputs:)`), and the height cache
  keys on (row, revision, width). Signposts `thread.open.firstPaint` and
  `thread.delta.onScreen` (category `thread`) measure latency.
- **Snapshot decode is element-lossy.** Snapshot `events` arrays
  (`AgentChatEventHistorySnapshot`, `SyncChatSubscribeSnapshotPayload`) decode
  through `@ADELossyArray`, so one unknown event is skipped instead of losing
  the whole transcript (and its question cards). Keep new decoders tolerant.
- **Turn delivery and recovery are provider-neutral.** `RemoteModels.swift`
  decodes the message-delivery lifecycle, `turn_health`, `turn_recovery`,
  `turn_diagnostics` and legacy events, and `WorkEventMapping.swift` maps them.
  Accepted-but-unprocessed messages show Run next, Edit and Dismiss only with
  `chat.resolveUnprocessedMessage` (durable, idempotent). Stalled rows keep the
  child's `sourceSessionId` and offer Wait, Nudge, Retry and Resume through
  `chat.recoverTurn` (the Codex action is a fallback). Moderation checks fold
  into one diagnostics disclosure. Web-search cards keep `query`, `title`,
  `url` and `snippet`; MCP cards name the app; image events reuse compact tool
  cards and never print data URIs.
- **The thread follows the desktop turn rules.** A finished turn has one fold
  caption (`Worked for <duration>`, or `Worked`) and one turn-end line, and no
  start divider. Tool rows are not drawn; the fold's counts open the activity
  sheet. Durations: one decimal under 10 s, `<1s` under a second, none without a
  user message or `status: started`. Subagent cards are one column on a phone,
  three at regular width. More than three adjacent same-cause stopped or
  usage-limit results fold into a group. A background job live at turn end stays
  visible; a turn with nothing hidden has no fold. `workPresentedTimelineEntries`
  (`WorkTimelineHelpers.swift`) decides what is visible: activity and
  task-update ribbons and Claude prompt suggestions are left out. A tool group of
  computer-use commands draws action rows (`WorkComputerUseActions.swift`, ported
  in `WorkComputerUseSummary.swift` and `WorkComputerUsePresentation.swift`). The
  activity indicator and `WorkTurnEndMarkerView` open `WorkTurnActivitySheet`;
  it never invents file changes. See
  [chat/transcript-and-turns.md](../chat/transcript-and-turns.md).
- **Assistant rows key on `messageId`.** `workAssistantMessageStableId`
  (`WorkEventMapping.swift`) uses the trimmed `messageId`, else `itemId`, in
  canonical mapping (`WorkErrorAndMessageHelpers.swift`), live mapping and JSONL
  replay (`WorkTranscriptParser.swift`), so live and canonical rows reconcile.
  `buildWorkChatMessages` merges into the previous assistant bubble when the
  event has an `itemId` or the previous envelope was assistant text.
- **Fragments merge the same way from any source.** Live frames have a
  `sequence`; `chat.getTranscript` rows do not. Both use
  `mergeWorkStreamingText`; the host keeps canonical text byte-identical (see
  [Canonical assistant text](../chat/transcript-and-turns.md#canonical-assistant-text-fragile--read-before-editing)).
  Do not treat a sequence-less envelope as complete:
  `getChatTranscriptPage` can split a message across pages. Fix disagreements
  on the host.
- **A graduated steer renders once.** The host writes a `deliveryState:
  "queued"` row and a delivered row. The engine's full fold runs
  `pruneResolvedQueuedSteerEnvelopes`, and an append with a graduating row forces
  the full fold. The host side is `transcriptEntriesFromEnvelopes`.
- **A provider handoff is a divider.** `model_handoff` uses
  `AgentChatNoticeKind.modelHandoff` with `from|to` in `detail`;
  `buildWorkEventCards` draws the logo · `HANDOFF` · logo divider, with
  `Model handoff · Codex → Claude` as the accessibility label. A malformed
  `detail` or a same-provider pair draws nothing.
- **Badges float over the thread.** The Chat Info chip and the PR chip are a
  bottom-leading overlay behind a scrim, with "jump to latest" above them. The
  tail spacer reserves their height, and the row is a `ViewThatFits` `HStack`
  (a full-width horizontal `ScrollView` there would take vertical drags).
- **Long chats stay cheap.** The destination draws the engine's frame from its
  first body; "Session unavailable" waits for the session-row load. Rows use the
  render signature, not `body`, for preview and time. The timeline snapshot has
  no previews; cached previews attach only to visible rows. Bubble width is
  measured once at the viewport. `WorkRootTranscriptCache` is a reference
  cache, not `@State`. Root polling ignores terminal-buffer changes when chat
  events exist. Preview classification uses the full message (wireframe glyphs
  and aligned columns get fixed width; fenced code and tables keep Markdown); a
  tail that starts inside a fence restores the opening fence.
- **Context meter and compaction.** `context_compact.postTokens` and
  `context_usage.state` are kept, and `workContextUsageViewModel` clears usage
  before a completed compaction for Claude, Codex, OpenCode, Cursor and Droid,
  ignoring generic `tokens` and `done` counts from that turn. States:
  `compacting`, `recalculating` (no exact post tokens), `unknown` (a failed
  read). Exact tokens or a later snapshot refill it. iOS has no `/context`
  card; it decodes `AgentChatContextUsageCategory.kind`, so "Free" with
  `kind: "used"` stays used.

### Sends and drafts

- **A live chat send is never replayed after an unclear failure.** The turn may
  have started. iOS restores the exact text, marks the echo failed and asks the
  user to check the transcript. Messages written while offline may still queue
  with a stable `commandId`.
- **Send modes during a turn.** `WorkActiveSendCapability` (`WorkModels.swift`)
  hand-mirrors `ACTIVE_TURN_DISPATCH_MODES` in
  `apps/desktop/src/shared/types/chat.ts`; read the table for the per-provider
  modes (menu order, first is default). Claude and Cursor have **Send during
  turn**, **Send after turn** and an interrupt; `interruptContinues` makes
  Cursor's read **Interrupt & continue**. A Cursor **Cloud** session has no
  Send during turn: `workChatCursorSessionRunsInCloud` mirrors
  `cursorSessionRunsInCloud` and reads `cursorRuntime` (older hosts: a non-empty
  agent id). All words use `agentLabel`. The chevron opens a popover that closes
  on pick. `WorkActiveSendModeStore` remembers the pick per chat; a provider
  change resets it only when the new provider cannot honor it. Queue-only
  providers keep a plain button.
- **Stop modes.** With `chat.interruptWithQueueMode`, Claude Stop is a split
  control for **Turn only**, **Turn + queue**, **Turn + background** and **Turn
  + queue + background**, saved per chat, with legacy Stop on older brains.
  Running subagent rows, background rows with a `sourceTaskId` and spawn cards
  have a stop that calls `chat.stopTask` when advertised (not `chat:` task ids).
- **Active-turn sends are atomic.** `AgentChatSteerRequest` carries
  `dispatchMode` (`"inline"` / `"interrupt"`), sent with the steer by
  `SyncService.steerChatSession`; a capable host answers `queued: false` and
  writes no queued row. The mode is fixed before the send, also for the resend
  after "turn already active". `workChatAtomicSteerDispatchMode` is nil for Send
  after turn, for a provider with no channel and without `chat.dispatchSteer`.
  A `queued: true` answer (an older host, or a live run that refused inline)
  falls back to the two-step promotion; if that fails, the one queued message
  stays and the draft is not restored twice.
- **A non-throwing `chat.dispatchSteer` is not a delivery.**
  `SyncService.dispatchChatSteer` returns a `Bool` from `dispatchedAt`; null
  (the run refused, or a queued command with no answer yet) keeps the row
  queued. The composer and the strip share `dispatchSteer(_:mode:)`.
- **The staged strip is only "you queued this".** `WorkQueuedSteerStrip` rows
  have no frame: a waiting glyph, one line, a `Sends next` / `Queued` tag and
  icon buttons **Send now**, **Interrupt**, **Edit**, **Cancel** (44 pt). The
  disposition is in the VoiceOver label and the sheet. The glyph pulses through
  `ADEMotion.pulse` (Reduce Motion: steady). A tap on the row opens
  `WorkQueuedSteerDetailSheet`: the whole message, attachments, staged time,
  what happens next, and every option as a row (disabled with a reason when the
  provider cannot), from `workChatActiveSendCapability`.
- **Optimistic steers reconcile at turn end.** A mid-turn send shows as
  "Sends after turn" (`WorkQueuedSteerRow`, the ack's steer id). On the
  active-to-idle change (`workChatTranscriptPreferenceStatus`, using
  `liveTurnActiveHint`), `reconcileOptimisticSteersAfterTurnEnd` loads a fresh
  snapshot and drops steers the host no longer lists, never while unreachable
  or after an empty refresh.
- **Drafts are a store, not view state.** `WorkDraftPersistence.swift` holds
  `WorkComposerDraftStore` (text and attachment refs per chat, plus Hub and New
  Chat keys) and `WorkQuestionDraftStore` (question selections, freeform, page),
  versioned JSON in App Group `UserDefaults`, LRU-capped, saved after 400 ms and
  flushed on disappear. Rules: restore only into an empty field; **a send owns
  the draft until the host confirms**; never save an `isSecret` answer (the
  widget shares that suite). `forgetHost()` (called by
  `handleReconnectFailure`) does not touch them, because they are keyed by
  session. `WorkComposerDraftStore.Entry` (v2, like
  `ComposerDraftStorageSnapshot`) saves refs, never bytes. With no host, bytes
  go to `Caches/ade-composer-drafts/<key>` (5 files, 10 MB), purged on send,
  clear and eviction.
- **An unconfirmed send keeps its message.** `WorkChatComposerDraftState
  .beginPendingSend` and `workChatPersistComposerAttachments` save text and
  attachments before the field empties; `finishPendingSend(sent:)` drops them on
  confirm. Autosave stands down meanwhile. A kill between accept and confirm
  restores a sent message as a draft, which the timeout words warn about.
- **Upload waits are bounded.** `WorkComposerAttachmentUploads.resolve` waits at
  most `workComposerAttachmentUploadTimeoutNanoseconds` (the send timeout) and
  answers the host ref, "stage inline" or "abandoned" (the send fails).
  `workAwaitWithDeadline` abandons the wait, not the upload. A failed send
  restores the composer with "Couldn't send. Tap to retry." (same
  `performSend`, same mode). The tracker's upload calls
  `workChatStageAttachmentOnHost`, never `workChatSaveInputAttachments` (which
  resolves through the tracker and would wait for itself).

### Pending input

- **A swept gate is marked, not deleted; the host decides.** This mirrors
  desktop (see "Pending input derivation" in
  [Chat](../chat/README.md#fragile-and-tricky-wiring)). `workPendingInputSweepState`
  (`WorkErrorAndMessageHelpers.swift`) returns `{ openItemIds, sweptItemIds }`:
  only `pending_input_resolved` removes an id; a `done`, or a `tool_result`,
  `command` or `file_change` with the gate's `itemId`, records a sweep; a new
  ask clears it. `deriveWorkPendingInputQueue` returns both halves.
  - `liveItems` serves readers with no summary: the snapshot builder's
    `suppressedItemIds` and `SyncService.pendingInputItemIdForSnapshot` (the
    widget, when the row has no `pendingInputItemId`). `derivePendingWorkInputs`
    must stay `liveItems`, or the widget over-claims "needs you".
  - `resolved(hostPendingInputItemId:)` mirrors `resolvePendingInputs`.
    `WorkChatSessionView.canonicalPendingInputs` applies it at read time with
    the summary's id, else the row's, outside the cached timeline snapshot
    (built with no summary). Optimistic hiding sits on top.
  - Accepted cost: a rescued gate shows twice (strip and static chip), because
    suppression is baked into the cached snapshot.
  - Deliberate divergence: iOS sweeps `plan_approval` after a completed turn
    (desktop's `keepAfterCompletedTurn` keeps it); the host's
    `pendingInputItemId` brings it back.
- **First receipt wins.** `workPendingInputResolutions`
  (`WorkTimelineHelpers.swift`) keeps the first resolution per `itemId`, like
  `resolvedInputStates` in `AgentChatMessageList.tsx`, and the "Input resolved"
  ribbon (only for permission and model-selection gates) dedupes the same way.
  A second receipt is a late click recorded by `settleUnclaimedPendingInput`.
- **The item id flows through summaries.** The runtime fills
  `pendingInputItemId` on chat and terminal summaries while awaiting input (from
  the live map, else recent events). iOS reads it into
  `AgentSnapshot.pendingInputItemId` and `AttentionItem.itemId` for the
  App Intent buttons. Live-only `steeringInput` (Codex `isBlocking: false`)
  keeps the tile Working with a `?` pip, does not lock the composer, and is
  never Needs you.
- **One strip with optimistic removal.** `consolidatedPendingStripSection`
  (`WorkChatSessionView+Timeline.swift`) pins all gates above the composer. An
  answer adds its id to `optimisticallyAnsweredInputIds` until it leaves the
  host queue (`canonicalPendingInputSignature`) or the command fails. "Accept
  all" (`acceptAllPendingInputs`) is only for approval and permission gates: it
  sets `acceptForSession` and accepts the rest in order. The strip can shrink to
  a pill (`collapsedPendingInputId`) that names the ask; the gate stays open and
  the collapse ends when another gate leads.
- **Size a card from the chat surface, not the viewport.** The budget is
  `chatSurfaceHeight = max(240, scrollViewportHeight + composerLayoutHeight)`
  into `workPendingInputMaxHeight(chatSurfaceHeight:)`, with a constant composer
  reserve. The card subtracts its measured chrome so its scroll region takes the
  overflow. Send stays reachable because the composer inset is
  `fixedSize(vertical:)` and the transcript is the flexible sibling.

### Subagents, background work and usage limits

- **Subagents are structure, not event spam.** `RemoteModels.swift` accepts
  underscore and dotted lifecycle events. The roster is in Chat Info; the badge
  chip is the entry. `buildWorkSubagentTimelineRows` mirrors
  `deriveSubagentTimelineRows` (`chatSubagents.ts`): one spawn row and one
  result row per subagent and one finish chip per background shell.
  `collapseLegacyWorkSubagentResultEnvelopes` drops (never merges) a legacy
  `subagent.completed` frame (`isLegacySubagentCompletedFrame`) whose id a
  canonical frame claims; a merge cannot tell a twin from two real results.
  `buildWorkSubagentSnapshots` runs it too.
- **Known gap: a running background job has no phone presence.** Desktop folds
  `scheduled_work_update {kind: "background_task"}` into a live
  `background_job_line` (`chatTranscriptRows.ts`); iOS drops it
  (`WorkTimelineHelpers.swift`), so nothing shows while a Claude background
  shell runs. This is unported work.
- **Chat Info sections** (`WorkChatRichCardViews`): Subagents, Background and
  Schedule as on desktop, with caps 12 / 8 / 10, one **Completed** fold, and
  Clear/Restore per session (`ade.chat.paneCleared.v1:<sessionId>`). Cancel,
  Pause and Resume call `SyncService.cancelScheduledWork` and
  `setScheduledWorkPaused`, then reload the summary for the result and
  `nextWakeAt`. Two or more interrupt-stopped subagents fold into
  `WorkSubagentStoppedGroupCardView` ("N agents stopped when you interrupted");
  a row reopens that subagent.
- **Usage limits.** `WorkUsageLimitResumePill` reads
  `AgentChatSessionSummary.usageLimitResume`, else `usageLimitParkedUntil` from
  an older host, and opens `WorkUsageLimitResumeSheet` ("<Provider> usage
  limit", when ADE sends `"continue"`, **Nothing is lost. Subagents restart with
  it.**, raw detail, and **Resume now**, **Try again** / **Turn on**, **Fork in
  this lane**, **Don't continue**). A refusal (`no_live_usage_limit`,
  `resume_in_flight`) is an `ok: false` answer: the phone shows the host's
  sentence with the failure haptic and refreshes. Resume now uses
  `chat.resumeUsageLimitNow` (owner-only, optional) and
  `workUsageLimitShowsPrimaryButton` hides it without the action; the others
  use `chat.updateSession` and only disable while busy. A viewer device keeps
  the button and gets the policy message (`requireInvokableRemoteAction`).
  `workUsageLimitRowStatus` mirrors `usageLimitResumeRowStatus` and
  `workUsageLimitRelativePhrase` the desktop countdown (seconds round up). The
  countdown ticks each second within five minutes, else each minute. A limit
  turn's footer is `Paused · usage limit · <elapsed>`. Adjacent failed
  subagents with usage-limit summaries fold into `<n> agents stopped · usage
  limit`, apart from interrupt-stopped groups.

### Activity, accounts and links

- **Device ownership is epoch-ordered** (see
  [Push notifications & Live Activity](#push-notifications--live-activity)).
  Do not replace it with task cancellation, which cannot recall a request that
  reached Relay. `LiveActivityService` and `ADEAgentActivityWidget` show account
  details only when both epochs match the current owner.
- **Account routes keep `accountMachineKey`** in destinations, APNs payloads,
  Live Activity rows and their links. `DeepLinkRouter` passes it into
  `WorkSessionNavigationRequest` and `PrNavigationRequest`, and navigation
  selects that machine first. Missing keys are valid only for local payloads.
- **Dismissals are scoped to live ids.** `ActivityDrawerModel.dismissVisible(in:)`
  stores ids under `ade.attention.dismissedItemIDs` and prunes them against the
  live set on each rebuild, so a recurrence shows again. Do not make it a
  permanent list.

### Terminals and lanes

- **CLI launcher providers are runtime-validated.** `parseCliProvider` matches
  `claude | codex | cursor | droid | opencode | shell` exactly. The phone cannot
  pass `command` or `startupCommand` (they come from
  `apps/desktop/src/shared/cliLaunch.ts`) and derives the provider from the
  model (`workResolveCliProvider` in `WorkModelCatalog.swift`, the mirror of
  `resolveCliProviderForModel`); a new provider needs both updated. A runtime
  `shell` launch uses `resolveCleanShellLaunchFields` (no profile or rc files).
  `SyncStartCliSessionArgs.reasoningEffort` reaches
  `buildTrackedCliLaunchCommand`. Codex gets the prompt as its last argv
  argument, with the attachment manifest first.
  - Claude fallback catalog: Opus 5.5 (default), Fable 5.2, Sonnet 5.5, Sonnet
    5, Haiku 5.5, Fable 5.1, Opus 5. Sonnet 4.6, Fable 5, Opus 4.8 and Opus 4.7
    normalize forward; `opus` is Opus 5.5, `sonnet` is Sonnet 5.5.
  - OpenAI order: GPT-6.1 Sol, GPT-6 Astra, GPT-6.1 Terra, GPT-6 Sol, GPT-6
    Luna, GPT-5.6 Sol, GPT-5.6 Luna, then GPT-5.5. GPT-6.1 Sol is the default.
  - Reasoning: host tiers first. The fallback is Light to Max on the Lunas, up
    to Ultra on Astra, the Sols and Terra (`low` for Astra and Sol, `medium` for
    Terra and Luna).
- **An ended agent CLI continues through `work.sendToSession`** with the durable
  `sessionId`: the runtime writes to a live PTY or starts the continuation on
  the same row.
- **The terminal is a SwiftTerm grid** (see [The Work tab](#the-work-tab)). The
  size sent is (cols, rows) from the glyph cell. Unsubscribe on disappear keeps
  a phone paging through the list from holding the PTY size.
  `restoreTerminalSubscriptions` resubscribes each id in
  `subscribedTerminalSessionIds` from its last offset. A host with no offsets
  gets snapshots of up to 240 KB.

### ADE Cloud

- **A cloud open must not wake.** Opening a cloud chat, lane or copy calls
  `MachineFleet.connect(…, wake: false)` or reads the account. Only a doing
  action passes `wake: true`; a read that wakes costs the person money.
- **Cloud rows have no live link.** A saved chat, a `cloud-copy:` row and a
  `cloud-saved:` key have no host; a host command must take the queue or the
  wake path first. In account scope, `refuseAccountProjectScopeCommand` throws
  before the queue.
- **Never show one cloud computer.** Name it with
  `CloudLaneComputerLabels.label` ("ADE Cloud"); pickers and filters show one
  ADE Cloud entry.
- **A cloud send keeps its message id.** A retry after a network failure sends
  the same `messageId`; a refusal clears it.
