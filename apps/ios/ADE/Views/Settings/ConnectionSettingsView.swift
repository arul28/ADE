import Combine
import SwiftUI
import UIKit
import UserNotifications

struct ConnectionSettingsView: View {
  let syncService: SyncService
  let pairingOnly: Bool

  @Environment(\.dismiss) private var dismiss
  @Environment(\.duoLayout) private var duo
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  @StateObject private var presentationModel = SettingsConnectionPresentationModel()
  @StateObject private var machineController = SettingsMachineController()
  @EnvironmentObject private var machineFleet: MachineFleet
  @ObservedObject private var account = AccountService.shared
  @State private var signInPresented = false
  @State private var presentedSheet: SettingsPairSheetRoute?
  @State private var pinPreset: PinPreset?
  @State private var pinSetupRoute: PinSetupRoute?

  init(syncService: SyncService, pairingOnly: Bool = false) {
    self.syncService = syncService
    self.pairingOnly = pairingOnly
  }

  private var colorSchemeChoice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  var body: some View {
    // The Duo's inner display gets Apple Settings' two columns: this list on
    // the left, the page a row opens on the right. It opens on the first row,
    // Machines. Everywhere else it is one pushed stack.
    if duo.isWide && !pairingOnly {
      DuoSettingsSplit(onClose: { dismiss() }, landingTitle: SettingsRoute.machines.title) {
        settingsChrome(settingsList)
      } landing: {
        machinesPage
      } page: { title in
        page(SettingsRoute.allCases.first { $0.title == title } ?? .general)
      }
    } else {
      NavigationStack {
        settingsChrome(
          Group {
            if pairingOnly {
              ScrollView {
                pairingOnlyGroup
                  .padding(.horizontal, 16)
                  .padding(.top, 8)
                  .padding(.bottom, 36)
              }
              .background(ADEColor.pageBackground.ignoresSafeArea())
            } else {
              settingsList
            }
          }
        )
      }
      .environment(\.settingsClose, { dismiss() })
      // On the Duo's outer display the bar stays across the top, as the
      // Hub's does, instead of a rail that costs the list its width.
      .hubHeaderStaysOnTop()
    }
  }

  /// The title, close button, sheets and observers the settings root carries,
  /// whichever column layout hosts it. Close shows where the stack sets
  /// `settingsClose`: not on the Duo's list column, whose page column has it.
  private func settingsChrome<Content: View>(_ content: Content) -> some View {
    content
      .adeNavigationGlass()
      .navigationTitle(pairingOnly ? "Connect a computer" : "Settings")
      .settingsPageClose()
      .sheet(item: $presentedSheet) { route in
        presentedPairingSheet(route)
      }
      .sheet(item: $pinPreset) { preset in
        SettingsPinSheet(
          preset: preset,
          syncService: syncService,
          onNeedsPinSetup: { route in
            pinPreset = nil
            pinSetupRoute = route
          }
        )
        .presentationDetents([.large])
      }
      .sheet(item: $pinSetupRoute) { route in
        SettingsPinSetupSheet(
          route: route,
          onTryAgain: { preset in
            pinSetupRoute = nil
            pinPreset = preset
          }
        )
        .presentationDetents([.large])
      }
      .preferredColorScheme(colorSchemeChoice.preferredColorScheme)
      .overlay(alignment: .top) {
        if let label = syncService.accountConnectSuccessLabel {
          AccountConnectStatusToast(label: label)
            .padding(.horizontal, 20)
            .padding(.top, 12)
            .transition(.move(edge: .top).combined(with: .opacity))
        }
      }
      .animation(.spring(response: 0.35, dampingFraction: 0.86), value: syncService.accountConnectSuccessLabel)
      .adeToast($machineController.toast)
      .sheet(isPresented: $signInPresented) {
        AccountSignInView(onConnect: connectToAccountMachine)
      }
      .confirmationDialog(
        machineController.limitPrompt.map { "Connect \($0.target.name)?" } ?? "",
        isPresented: Binding(
          get: { machineController.limitPrompt != nil },
          set: { if !$0 { machineController.limitPrompt = nil } }
        ),
        titleVisibility: .visible,
        presenting: machineController.limitPrompt
      ) { prompt in
        ForEach(prompt.candidates, id: \.key) { candidate in
          Button("Disconnect \(candidate.name)") {
            machineController.resolveLimit(disconnecting: candidate.key, then: prompt.target)
          }
        }
        Button("Cancel", role: .cancel) {}
      } message: { _ in
        Text("The phone keeps \(MachineFleet.liveMachineLimit) machines live at a time. Pick one to disconnect.")
      }
      .onAppear {
        machineController.bind(syncService: syncService, fleet: machineFleet)
        presentationModel.bind(to: syncService)
        if let request = syncService.requestedPairingQrNavigation {
          syncService.requestedPairingQrNavigation = nil
          handleScannedPairingCode(request.raw)
        }
      }
      .onChange(of: syncService.requestedPairingQrNavigation?.id) { _, _ in
        guard let request = syncService.requestedPairingQrNavigation else { return }
        syncService.requestedPairingQrNavigation = nil
        handleScannedPairingCode(request.raw)
      }
  }

  /// Pairing-only entry point (from the no-account gate): connection status +
  /// the pair actions, nothing else.
  @ViewBuilder
  private var pairingOnlyGroup: some View {
    VStack(alignment: .leading, spacing: ADEKit.sectionGap) {
      ADESettingsSection("Connection") {
        connectionStatus().adeKitCard()
      }

      SettingsPairingSection(
        snapshot: presentationModel.pairingSnapshot,
        presentedSheet: $presentedSheet
      )
    }
  }

  private func connectionStatus(machineShownAbove: Bool = false) -> some View {
    SettingsConnectionHeader(
      snapshot: presentationModel.connectionSnapshot,
      onDisconnect: { syncService.disconnectForUserConnectionChange() },
      onReconnect: {
        Task { await syncService.reconnectForUserConnectionChange() }
      },
      onPairWithPin: {
        if let host = syncService.accountPairingPinFallbackHost {
          pinPreset = .discover(host)
        }
      },
      onWake: wakeAsleepMachine,
      machineShownAbove: machineShownAbove
    )
  }

  /// The root list, as the desktop's settings sidebar lays it out: who you
  /// are, then Machines and General, then You, App, Project and System. On the Duo's
  /// inner display held landscape this is the left column and each row's page
  /// fills the right one (`DuoSettingsSplit`).
  private var settingsList: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 2) {
        accountHeader
          .padding(.bottom, 8)
        ForEach(SettingsRouteGroup.allCases, id: \.self) { group in
          let routes = visibleRoutes.filter { $0.group == group }
          if !routes.isEmpty {
            if let title = groupTitle(group) {
              ADESettingsSidebarGroupLabel(text: title)
            }
            ForEach(routes) { route in
              ADESettingsSidebarLink(title: route.title, symbol: route.symbol, tint: route.tint, value: rowValue(route)) {
                page(route)
              }
            }
          }
        }
      }
      .padding(.horizontal, 10)
      .padding(.top, 4)
      .padding(.bottom, 36)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
  }

  /// The project pages act on the open project, so they show only while the
  /// phone has one, as the desktop shows them only with a project open.
  private var visibleRoutes: [SettingsRoute] {
    SettingsRoute.allCases.filter { route in
      route.group != .project || syncService.activeProject != nil
    }
  }

  /// The desktop names the project group after the open project
  /// ("Project: ADE").
  private func groupTitle(_ group: SettingsRouteGroup) -> String? {
    guard group == .project else { return group.title }
    guard let project = syncService.activeProject else { return group.title }
    return "\(group.title ?? "Project"): \(project.displayName)"
  }

  private func rowValue(_ route: SettingsRoute) -> String? {
    switch route {
    case .appearance: return colorSchemeChoice.label
    case .machines:
      let live = machineController.liveCount(machines)
      return live > 0 ? "\(live) live" : nil
    default: return nil
    }
  }

  @ViewBuilder
  private func page(_ route: SettingsRoute) -> some View {
    switch route {
    case .general: generalPage
    case .account: accountPage
    case .usage: SettingsUsagePage(syncService: syncService)
    case .chat: SettingsChatPage(syncService: syncService)
    case .providers: SettingsProvidersPage(syncService: syncService)
    case .integrations: SettingsIntegrationsPage(syncService: syncService)
    case .notifications:
      ADESettingsPage(route: .notifications) {
        SettingsPushDeliverySection(
          snapshot: presentationModel.pushDeliverySnapshot,
          pushService: PushNotificationService.shared
        )
      }
    case .appearance:
      ADESettingsPage(route: .appearance) { SettingsAppearanceSection() }
    case .lanes: SettingsLanesPage(syncService: syncService)
    case .machines: machinesPage
    case .advanced: advancedPage
    }
  }

  /// General, where Settings opens: what needs attention, you, the machine
  /// this phone works on, and ADE on every machine.
  private var generalPage: some View {
    SettingsGeneralPage(
      syncService: syncService,
      machines: machines,
      onSignIn: { signInPresented = true },
      accountPage: { AnyView(page(.account)) },
      usagePage: { AnyView(page(.usage)) },
      providersPage: { AnyView(page(.providers)) },
      machinesPage: { AnyView(machinesPage) },
      advancedPage: { AnyView(advancedPage) },
      connection: { machineShownAbove in AnyView(connectionStatus(machineShownAbove: machineShownAbove)) }
    )
  }

  /// Every machine Settings lists: connected, signed in, or saved.
  private var machines: [SettingsMachine] {
    settingsMachines(
      syncService: syncService,
      account: account,
      fleet: machineFleet,
      hidden: HiddenMachineStore.shared
    )
  }

  private var accountPage: some View {
    SettingsAccountPage(
      syncService: syncService,
      machineController: machineController,
      onSignIn: { signInPresented = true },
      machinesPage: { AnyView(machinesPage) },
      integrationsPage: { AnyView(page(.integrations)) }
    )
  }

  /// Machines: the connected set and the rest of the account's machines, then
  /// the ways to add one.
  private var machinesPage: some View {
    ADESettingsPage(route: .machines) {
      SettingsMachineSections(
        syncService: syncService,
        controller: machineController,
        presentedSheet: $presentedSheet
      )
      SettingsPairingSection(
        snapshot: presentationModel.pairingSnapshot,
        presentedSheet: $presentedSheet
      )
    }
  }

  /// Advanced: how the phone reaches its machine, why a notification did or
  /// did not arrive, and this phone's build and ids.
  private var advancedPage: some View {
    ADESettingsPage(route: .advanced) {
      SettingsDiagnosticsSection(snapshot: presentationModel.diagnosticsSnapshot, content: .connection)
      ADESettingsSection("Notifications", symbol: "bell.badge", tint: .red) {
        ADESettingsRows {
          ADESettingsLink(title: "Delivery diagnostics", symbol: "stethoscope") {
            ADESettingsPage(title: "Delivery diagnostics") {
              SettingsPushDeliverySection(
                snapshot: presentationModel.pushDeliverySnapshot,
                pushService: PushNotificationService.shared,
                content: .diagnostics
              )
            }
          }
        }
      }
      SettingsDiagnosticsSection(snapshot: presentationModel.diagnosticsSnapshot, content: .about)
    }
  }

  /// The signed-in account as the list's header row, as the desktop sidebar
  /// opens on who you are. Opens Account.
  @ViewBuilder
  private var accountHeader: some View {
    if account.isConfigured {
      switch account.phase {
      case .signedIn:
        if let identity = account.identity {
          SettingsAccountHeaderLink(identity: identity) {
            accountPage
          }
        }
      case .loading:
        ProgressView()
          .frame(maxWidth: .infinity, minHeight: 64)
      default:
        Button {
          signInPresented = true
        } label: {
          HStack(spacing: 12) {
            ADESettingsIconTile(symbol: "person.crop.circle.badge.plus", tint: .accent, size: 40)
            VStack(alignment: .leading, spacing: 2) {
              Text("Sign in to ADE")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(ADEColor.accent)
              Text("Your machines and settings, on every device.")
                .font(.system(size: 12.5))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
            }
            Spacer(minLength: 0)
          }
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
        }
        .buttonStyle(ADEKitRowButtonStyle(shape: .sidebar))
      }
    }
  }

  @ViewBuilder
  private func presentedPairingSheet(_ route: SettingsPairSheetRoute) -> some View {
    switch route {
    case .discover:
      DiscoverHostsSheet { host in
        presentedSheet = nil
        pinPreset = .discover(host)
      }
      .environmentObject(syncService)

    case .scan:
      SettingsPairingScannerSheet { payload in
        presentedSheet = nil
        routePairingQr(payload)
      }

    case .ssh:
      SSHPairingView(syncService: syncService)
        .presentationDetents([.large])
    }
  }

  /// Account machines pair through the verified relay and then reconnect with
  /// a device-bound secret. The user does not need to find or re-enter a PIN.
  private func connectToAccountMachine(_ machine: AccountMachine) {
    Task { @MainActor in
      guard let authorization = AccountService.shared.currentPairingAuthorization else {
        return
      }
      let connected = await syncService.pairWithAccountMachine(
        machine,
        authorization: authorization
      )
      if connected {
        ADEHaptics.medium()
      }
    }
  }

  /// Dials the machine the connection card says is asleep. Dialling is what
  /// wakes it, so this is the same call the machine row makes — aimed at the
  /// machine the card NAMES, never at whichever one the saved profile holds.
  ///
  /// Bounded by the connect attempt itself: it ends attached, or it ends with
  /// a named failure and this same button. There is no third outcome and no
  /// spinner that outlives the attempt.
  ///
  /// The key arrives from the card, which only renders the button when it has
  /// one (`settingsWakeMachineKey`), so this is never asked to dial nothing.
  private func wakeAsleepMachine(machineKey: String) {
    guard let machine = AccountService.shared.machines.first(where: { $0.machineKey == machineKey })
    else { return }
    connectToAccountMachine(machine)
  }

  /// Parses a scanned/deep-linked pairing code and dispatches it. Unparseable
  /// strings (e.g. an unrelated deep link) are ignored.
  private func handleScannedPairingCode(_ raw: String) {
    guard let payload = PairingQrPayload.parse(raw) else { return }
    routePairingQr(payload)
  }

  /// Already paired → refresh routes and reconnect silently. New machine → open
  /// PIN entry pre-filled from the payload (the user only types the PIN).
  private func routePairingQr(_ payload: PairingQrPayload) {
    let directCandidates = payload.directCandidateHosts
    let relayCandidates = payload.relayCandidateHosts
    Task { @MainActor in
      let reconnected = await syncService.reconnectUsingPairingQr(
        hostIdentity: payload.hostIdentity.deviceId,
        port: payload.port,
        directCandidates: directCandidates,
        relayCandidates: relayCandidates
      )
      if reconnected {
        ADEHaptics.medium()
      } else {
        pinPreset = .qr(payload)
      }
    }
  }
}

struct SettingsConnectionSnapshot: Equatable {
  var health: SyncConnectionHealth
  var connectionState: RemoteConnectionState
  var routeKind: SyncConnectionRouteKind?
  /// The machine this phone is attached to, or was last attached to.
  var hostDisplayName: String?
  /// The machine the in-flight or just-failed attempt is aimed at. Kept apart
  /// from `hostDisplayName` because these are only the same Mac by coincidence.
  var connectAttemptHostName: String?
  /// The machine this phone is attached to right now, if any. `hostDisplayName`
  /// is the card's SUBJECT and follows the attempt; this one never does, which
  /// is what lets the card say "…is asleep, you're still on <the other one>".
  var attachedMachineName: String?
  /// Set only when the machine an attempt is waking, or just failed to wake, is
  /// asleep. Drives the outcome-first card.
  var asleepMachineName: String?
  /// Directory key of that machine, so the card's Wake button dials the machine
  /// it names rather than whichever one the saved profile points at.
  var wakeMachineKey: String?
  var canReconnectToSavedHost: Bool
  var errorMessage: String?
  var accountConnectStageLabel: String?
  var canPairWithPin = false
  var hostCompatibilityMode: SyncHostCompatibilityMode = .unknown
  var hostCompatibilityMissingActions: [String] = []
  var hostStallNotice: SyncHostStallNotice?
  var hostStorageWaitNotice: SyncHostStorageWaitNotice?
}

struct SettingsPairingSnapshot: Equatable {
  var discoveredHostCount = 0
  var savedReconnectHostCount = 0
}

struct SettingsDiagnosticsSnapshot: Equatable {
  var connectionRoute: String?
  var connectionPerformance: String?
  var pairedMachineIdentity: String?
  var lastSyncDescription: String?
  var deviceIdentity: String?
}

@MainActor
private final class SettingsConnectionPresentationModel: ObservableObject {
  @Published private(set) var connectionSnapshot = SettingsConnectionSnapshot(
    health: syncConnectionHealth(
      connectionState: .disconnected,
      prefersReducedSyncLoad: false,
      lastError: nil
    ),
    connectionState: .disconnected,
    routeKind: nil,
    hostDisplayName: nil,
    connectAttemptHostName: nil,
    canReconnectToSavedHost: false,
    errorMessage: nil
  )
  @Published private(set) var pairingSnapshot = SettingsPairingSnapshot()
  @Published private(set) var diagnosticsSnapshot = SettingsDiagnosticsSnapshot()
  @Published private(set) var pushDeliverySnapshot = SettingsPushDeliverySnapshot()

  private weak var boundService: SyncService?
  private var cancellable: AnyCancellable?
  private var pushCancellable: AnyCancellable?
  private var accountCancellable: AnyCancellable?

  func bind(to syncService: SyncService) {
    guard boundService !== syncService else {
      refresh(from: syncService)
      return
    }

    boundService = syncService
    refresh(from: syncService)
    cancellable = syncService.objectWillChange
      .throttle(for: .milliseconds(250), scheduler: RunLoop.main, latest: true)
      .sink { [weak self, weak syncService] _ in
        Task { @MainActor in
          guard let syncService else { return }
          self?.refresh(from: syncService)
        }
      }
    // Push-delivery state lives on its own singleton; mirror its changes into
    // the panel snapshot so the section stays a pure function of Equatable state.
    pushCancellable = PushNotificationService.shared.objectWillChange
      .throttle(for: .milliseconds(200), scheduler: RunLoop.main, latest: true)
      .sink { [weak self] _ in
        Task { @MainActor in self?.refreshPushSnapshot() }
      }
    accountCancellable = AccountService.shared.objectWillChange
      .throttle(for: .milliseconds(200), scheduler: RunLoop.main, latest: true)
      .sink { [weak self] _ in
        Task { @MainActor in
          guard let self else { return }
          if let syncService = self.boundService {
            self.refresh(from: syncService)
          } else {
            self.refreshPushSnapshot()
          }
        }
      }
  }

  private func refresh(from syncService: SyncService) {
    let activeProfile = syncService.activeHostProfile
    let health = syncService.connectionHealth
    let hostDisplayName = accountMachinePresentationName(
      hostIdentity: activeProfile?.hostIdentity,
      fallback: Self.trimmedNonEmpty(syncService.hostName) ?? Self.trimmedNonEmpty(activeProfile?.hostName),
      machines: AccountService.shared.machines
    )
    // Resolved through the directory too, so a machine the user renamed reads
    // the same while you're reaching for it as it does once you're on it.
    let attemptHostName = syncService.connectAttemptTarget.flatMap { target in
      accountMachinePresentationName(
        hostIdentity: target.machineIdentity,
        fallback: target.machineName,
        machines: AccountService.shared.machines
      )
    }
    // One name for the whole card. While an attempt is in flight — or has just
    // failed — every line names the machine the user aimed at; the saved host
    // takes over again only once the card is idle or attached.
    let subjectMachineName = syncConnectionSubjectMachineName(
      transport: health.transport,
      attemptMachineName: attemptHostName,
      hostDisplayName: hostDisplayName
    )
    // A machine that is asleep owns the card. Name and identity are resolved
    // together so the copy and the "Wake it" can never come from two different
    // machines — see `syncAsleepCardSubject`.
    let asleepMachine = syncAsleepCardSubject(
      transport: health.transport,
      attemptIsWakingMachine: syncService.connectAttemptIsWakingMachine,
      attemptMachineName: attemptHostName,
      attemptMachineIdentity: syncService.connectAttemptTarget?.machineIdentity,
      failure: syncService.lastConnectAttemptFailure
    )
    // Identity first, name only as a fallback: two Macs in one account can
    // carry the same name, and the wake has to dial the one that was tapped.
    let wakeMachineKey = asleepMachine.flatMap { subject -> String? in
      let machines = AccountService.shared.machines
      if let identity = subject.identity,
         let byIdentity = machines.first(where: {
           $0.deviceId?.caseInsensitiveCompare(identity) == .orderedSame
         }) {
        return byIdentity.machineKey
      }
      return machines.first(where: { $0.displayName == subject.name })?.machineKey
    }
    let address = Self.trimmedNonEmpty(syncService.currentAddress) ?? Self.trimmedNonEmpty(activeProfile?.lastSuccessfulAddress)
    let displayedDiscovery = syncDiscoveredHostsForDisplay(
      savedHosts: syncService.savedReconnectHosts,
      liveHosts: syncService.discoveredHosts
    )

    update(
      &connectionSnapshot,
      to: SettingsConnectionSnapshot(
        health: health,
        connectionState: syncService.connectionState,
        routeKind: health.transport.isConnected ? syncService.lastConnectedRouteKind : nil,
        hostDisplayName: subjectMachineName,
        connectAttemptHostName: health.transport == .connecting || health.transport == .unreachable
          ? subjectMachineName
          : nil,
        attachedMachineName: health.transport.isConnected ? hostDisplayName : nil,
        asleepMachineName: asleepMachine?.name,
        wakeMachineKey: wakeMachineKey,
        canReconnectToSavedHost: syncService.canReconnectToSavedHost,
        errorMessage: health.transport == .unreachable ? health.lastFailureMessage : nil,
        accountConnectStageLabel: syncService.accountConnectStageLabel,
        canPairWithPin: syncService.accountPairingPinFallbackHost != nil,
        hostCompatibilityMode: syncService.hostCompatibilityMode,
        hostCompatibilityMissingActions: syncService.hostCompatibilityMissingActions,
        hostStallNotice: syncService.hostStallNotice,
        hostStorageWaitNotice: syncService.hostStorageWaitNotice
      )
    )

    update(
      &pairingSnapshot,
      to: SettingsPairingSnapshot(
        discoveredHostCount: displayedDiscovery.liveHosts.count,
        savedReconnectHostCount: displayedDiscovery.savedHosts.count
      )
    )

    update(
      &diagnosticsSnapshot,
      to: SettingsDiagnosticsSnapshot(
        connectionRoute: Self.routeLine(address: address, port: activeProfile?.port),
        connectionPerformance: settingsConnectedRouteChipText(
          durationMs: syncService.lastConnectDurationMs,
          routeKind: syncService.lastConnectedRouteKind
        ),
        pairedMachineIdentity: activeProfile?.hostIdentity.map(Self.shortIdentity),
        lastSyncDescription: syncService.lastSyncAt.map(Self.relativeSyncDescription),
        deviceIdentity: activeProfile?.pairedDeviceId.map(Self.shortIdentity)
      )
    )

    refreshPushSnapshot()
  }

  private func refreshPushSnapshot() {
    let push = PushNotificationService.shared
    let diagnostics = push.diagnostics
    var snapshot = SettingsPushDeliverySnapshot()
    snapshot.registrationState = push.registrationState
    snapshot.permissionStatus = push.permissionStatus
    snapshot.apnsEnvironment = diagnostics.apsEnvironment
    snapshot.tokenSuffix = diagnostics.tokenSuffix
    snapshot.lastRegisteredAt = diagnostics.lastRegisteredAt
    snapshot.lastPushReceivedAt = diagnostics.lastPushReceivedAt
    snapshot.lastError = diagnostics.lastError
    snapshot.relayRefreshError = push.relayRefreshError
    snapshot.canRefreshRelayStatus = boundService?.canSendPushCommands == true
    snapshot.isPaired = boundService?.hasPairedHost == true
    snapshot.accountDeliveryAvailable = AccountService.shared.isSignedIn
    snapshot.liveActivitiesAuthorized = push.liveActivitiesAuthorized
    snapshot.liveActivityTokenPresent = diagnostics.liveActivityPushToStartTokenSuffix != nil
    snapshot.liveActivityTokenRegistered =
      diagnostics.liveActivityPushToStartTokenSuffix != nil
      && diagnostics.liveActivityPushToStartTokenSuffix
        == diagnostics.liveActivityRegisteredTokenSuffix
    if let relay = push.relayStatus {
      snapshot.relayResolved = true
      snapshot.publisherEnabled = relay.publisherEnabled
      snapshot.relayApnsConfigured = relay.relayApnsConfigured
      snapshot.relayUrl = relay.relayUrl
      snapshot.deviceRegistered = relay.deviceRegistered
      snapshot.registeredDeviceCount = relay.registeredDeviceCount
      snapshot.lastPublishAt = relay.lastPublishAt
      snapshot.lastPublishError = relay.lastPublishError
      snapshot.lastRelayContactAt = relay.lastRelayContactAt
    }
    update(&pushDeliverySnapshot, to: snapshot)
  }

  private func update<Value: Equatable>(_ value: inout Value, to nextValue: Value) {
    guard value != nextValue else { return }
    value = nextValue
  }

  private static func routeLine(address: String?, port: Int?) -> String? {
    guard let address else { return nil }
    // A full wss:// relay URL carries an opaque `/connect/<machineKey>` path and
    // its own port — showing it raw is noise. Name the route instead.
    if syncIsFullWebSocketRoute(address) {
      return "ADE relay"
    }
    let prefix = syncIsTailscaleRoute(address) ? "Tailscale " : ""
    if let port {
      return "\(prefix)\(address) · :\(port)"
    }
    return "\(prefix)\(address)"
  }

  private static func trimmedNonEmpty(_ value: String?) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
      return nil
    }
    return value
  }

  private static func relativeSyncDescription(_ date: Date) -> String {
    let age = abs(Date().timeIntervalSince(date))
    guard age >= 5 else { return "just now" }
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .short
    return formatter.localizedString(for: date, relativeTo: Date())
  }

  private static func shortIdentity(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.count > 12 else { return trimmed }
    let prefix = trimmed.prefix(6)
    let suffix = trimmed.suffix(4)
    return "\(prefix)…\(suffix)"
  }
}

// MARK: - Machines section (M5 / M14)

/// The message a failed row should carry.
///
/// `lastError` describes the CONNECTION, and after a failed switch the
/// connection is fine — it is the previous machine's, restored — so `lastError`
/// is nil exactly when the user most needs to be told why the machine they
/// picked would not answer. `lastConnectAttemptFailure` outlives that restore
/// and is the only source that still knows.
func settingsMachineRowErrorMessage(
  attemptFailure: SyncConnectAttemptFailure?,
  lastError: String?,
  fallback: String
) -> String {
  func nonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
          !trimmed.isEmpty else { return nil }
    return trimmed
  }
  return nonEmpty(attemptFailure?.message) ?? nonEmpty(lastError) ?? fallback
}

/// A row failure describes one attempt against one machine, so it survives
/// exactly as long as it stays true: attaching to a machine disproves that
/// machine's failure. Failures against OTHER machines are left alone
/// deliberately — a failed switch restores the connection it interrupted, so
/// "connected to the Studio, MacBook row explaining why it would not answer" is
/// the honest steady state rather than the contradiction it used to be.
func settingsMachineRowErrorsRetiring(
  _ existing: [String: String],
  attachedEntryId: String?
) -> [String: String] {
  guard let attachedEntryId else { return existing }
  var remaining = existing
  remaining.removeValue(forKey: attachedEntryId)
  return remaining
}

/// Settings › Account: the desktop's Account page (`AccountPage.tsx`) on the
/// phone, in its order. Signed in: who you are, your computers, then the
/// account's details and Sign out (this phone only). Signed out: the sign-in
/// card. The desktop's "This computer" panel and its update-other-machines
/// block have no phone counterpart and are left out.
struct SettingsAccountPage: View {
  let syncService: SyncService
  @ObservedObject var machineController: SettingsMachineController
  let onSignIn: () -> Void
  let machinesPage: () -> AnyView
  let integrationsPage: () -> AnyView
  @ObservedObject private var account = AccountService.shared
  @ObservedObject private var hidden = HiddenMachineStore.shared
  @EnvironmentObject private var fleet: MachineFleet
  /// The desktop's "hide this suggestion" for the GitHub row, by the same key.
  @AppStorage("ade.account.repoBridgeDismissed.v1") private var repoBridgeDismissed = false
  @State private var githubNotConnected = false
  @State private var showIntegrations = false
  @State private var confirmSignOut = false
  @State private var signingOut = false
  @State private var copiedAccountId = false

  var body: some View {
    ADESettingsPage(route: .account) {
      if let identity = account.identity, account.phase == .signedIn {
        heroSection(identity)
        computersSection
        detailsSection(identity)
      } else {
        signedOutPanel
      }
    }
    .navigationDestination(isPresented: $showIntegrations) { integrationsPage() }
    .task(id: githubCheckKey) { await loadGitHub() }
    .confirmationDialog("Sign out of ADE?", isPresented: $confirmSignOut, titleVisibility: .visible) {
      Button("Sign out", role: .destructive) {
        Task {
          signingOut = true
          await account.signOut()
          signingOut = false
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Signing out removes this \(UIDevice.current.model)'s access to your account and its account-connected machines. Devices paired directly with a code stay connected.")
    }
  }

  // MARK: Who you are

  private func heroSection(_ identity: AccountIdentity) -> some View {
    ADESettingsRows {
      SettingsGeneralLeadRow(
        title: identity.displayName,
        subtitle: identity.email == identity.displayName ? nil : identity.email
      ) {
        AccountAvatar(identity: identity)
      } trailing: {
        ADEKitTag(text: identity.providerLabel)
      }
    }
  }

  // MARK: Your computers

  private var accountMachines: [SettingsMachine] {
    settingsMachines(syncService: syncService, account: account, fleet: fleet, hidden: hidden)
      .filter { $0.account != nil }
  }

  private var computersSection: some View {
    let machines = accountMachines
    return ADESettingsSection(
      "Your computers",
      hint: "Every computer signed in to this account. Open one to see how it connects and what's signed in on it.",
      symbol: "desktopcomputer",
      tint: .blue
    ) {
      ADESettingsRows {
        if machines.isEmpty {
          switch account.machinesState {
          case .idle, .loading:
            HStack { ProgressView().controlSize(.small) }
              .frame(maxWidth: .infinity, minHeight: 48)
          case .unconfigured:
            ADESettingsRow("This build has no account directory", hint: "Pair a computer with a code from Machines.")
          case .unreachable(let message):
            ADESettingsRow("Couldn't load your computers", hint: message)
          case .loaded:
            ADESettingsRow("No computers yet", hint: "Sign in to ADE on a computer and it shows here.")
          }
        }
        ForEach(machines) { machine in
          NavigationLink {
            SettingsMachinePage(syncService: syncService, controller: machineController, machineId: machine.id)
          } label: {
            SettingsMachineRow(
              machine: machine,
              busy: machineController.busyMachineIds.contains(machine.id),
              error: machineController.errors[machine.id],
              onConnect: { machineController.connect(machine) },
              onRetry: { machineController.retry(machine) }
            )
          }
          .buttonStyle(ADEKitRowButtonStyle())
        }
        // The desktop's "Manage connections".
        ADESettingsPageLink(title: SettingsRoute.machines.title, destination: machinesPage) { _, pushes in
          ADESettingsRow(title: "Manage connections", symbol: SettingsRoute.machines.symbol, tint: SettingsRoute.machines.tint) {
            if pushes { ADESettingsChevron() }
          }
        }
      }
    }
    .task { await account.loadMachines() }
  }

  // MARK: Account

  private func detailsSection(_ identity: AccountIdentity) -> some View {
    ADESettingsSection("Account", symbol: SettingsRoute.account.symbol, tint: .violet) {
      ADESettingsRows {
        ADESettingsRow(
          title: "Email",
          hint: "Signed in with \(identity.providerLabel)",
          symbol: "at",
          sizesControlFirst: false
        ) {
          Text(identity.email ?? "Your ADE account")
            .font(.system(size: 14))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
        if !identity.userId.isEmpty {
          ADESettingsRow(title: "Account ID", symbol: "person.text.rectangle", sizesControlFirst: false) {
            HStack(spacing: 8) {
              Text(identity.userId)
                .font(.adeMono(12))
                .foregroundStyle(ADEColor.textSecondary)
                .lineLimit(1)
                .truncationMode(.middle)
              Button {
                UIPasteboard.general.string = identity.userId
                copiedAccountId = true
                Task { @MainActor in
                  try? await Task.sleep(nanoseconds: 1_500_000_000)
                  copiedAccountId = false
                }
              } label: {
                Image(systemName: copiedAccountId ? "checkmark" : "doc.on.doc")
                  .font(.system(size: 13, weight: .semibold))
              }
              .buttonStyle(.borderless)
              .accessibilityLabel(copiedAccountId ? "Copied" : "Copy account ID")
            }
          }
        }
        if githubNotConnected && !repoBridgeDismissed {
          // The phone cannot connect GitHub; Integrations says where to.
          ADESettingsNotice(
            message: "GitHub is not connected on \(syncService.machineDisplayName). Lanes, pull requests and checks need it.",
            tone: .neutral,
            actionTitle: "Open Integrations",
            action: { showIntegrations = true },
            dismiss: { repoBridgeDismissed = true }
          )
          .padding(ADEKit.inset)
        }
        Button {
          confirmSignOut = true
        } label: {
          ADESettingsRow(
            title: "Sign out of this \(UIDevice.current.model)",
            hint: "Signing out only affects this \(UIDevice.current.model). Your computers and other devices stay signed in.",
            symbol: "rectangle.portrait.and.arrow.right",
            titleColor: ADEColor.danger,
            tint: .red
          ) {
            if signingOut { ProgressView().controlSize(.small) }
          }
        }
        .buttonStyle(ADEKitRowButtonStyle())
        .disabled(signingOut)
      }
    }
  }

  // MARK: GitHub

  /// GitHub status is read from the primary machine's open project.
  private var githubCheckKey: String {
    [
      account.phase == .signedIn ? "in" : "out",
      syncService.connectionState.rawValue,
      syncService.activeProjectId ?? "",
    ].joined(separator: "|")
  }

  private func loadGitHub() async {
    githubNotConnected = false
    guard account.phase == .signedIn,
          !repoBridgeDismissed,
          syncService.connectionState == .connected,
          syncService.activeProject != nil,
          syncService.supportsRemoteAction("github.getStatus") else { return }
    guard let status = try? await syncService.fetchGitHubSettingsStatus(), !Task.isCancelled else { return }
    githubNotConnected = IntegrationSummary(github: status) == .notConnected
  }
}

extension SettingsAccountPage {
  /// Signed out: the desktop's sign-in card. The empty avatar, what an
  /// account gives you, and one wide Sign in, centred in one panel.
  fileprivate var signedOutPanel: some View {
    VStack(spacing: 14) {
      Image(systemName: "person.fill")
        .font(.system(size: 30, weight: .medium))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 72, height: 72)
        .background(ADEKit.track, in: Circle())
        .overlay(Circle().strokeBorder(ADEKit.rule, lineWidth: 1))
        .accessibilityHidden(true)
      VStack(spacing: 6) {
        Text("Sign in to ADE")
          .font(.system(size: 19, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(account.isConfigured
          ? "Sign in to reach your machines from any network and keep your settings on every device."
          : "Account sign-in isn't available in this build. Pair a computer with a code instead.")
          .font(.system(size: 14))
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
      }
      if account.isConfigured {
        Button("Sign in", action: onSignIn)
          .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
          .padding(.top, 4)
        Text("Sign in to use ADE Relay.")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textMuted)
      }
    }
    .padding(.horizontal, 22)
    .padding(.vertical, 26)
    .frame(maxWidth: .infinity)
    .adeKitCard(padding: nil)
  }
}

/// The root list's account row: avatar, name and email, opening Account. A
/// sidebar row, so on the Duo's two columns it fills the right column
/// instead of pushing.
private struct SettingsAccountHeaderLink<Destination: View>: View {
  let identity: AccountIdentity
  @ViewBuilder var destination: () -> Destination

  var body: some View {
    ADESettingsPageLink(title: SettingsRoute.account.title, shape: .sidebar, destination: destination) { _, pushes in
      label(pushes: pushes)
    }
  }

  private func label(pushes: Bool) -> some View {
    HStack(spacing: 12) {
      AccountAvatar(identity: identity)
      VStack(alignment: .leading, spacing: 2) {
        Text(identity.displayName)
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let email = identity.email {
          Text(email)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
            .truncationMode(.middle)
        }
      }
      Spacer(minLength: 8)
      if pushes {
        ADESettingsChevron()
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .accessibilityElement(children: .combine)
    .accessibilityHint("Opens Account.")
  }
}
