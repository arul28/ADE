import Combine
import SwiftUI
import UIKit
import UserNotifications

struct ConnectionSettingsView: View {
  let syncService: SyncService
  let pairingOnly: Bool

  @Environment(\.dismiss) private var dismiss
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

  /// "This iPhone" / "This iPad", from the device rather than a literal.
  ///
  /// The desktop group is sourced from `THIS_MACHINE_NAME` for exactly this
  /// reason: a hardcoded model name is wrong on every other device, and the
  /// user notices immediately.
  private var thisDeviceGroupLabel: String {
    "This \(UIDevice.current.model)"
  }

  var body: some View {
    NavigationStack {
      Group {
        if pairingOnly {
          ScrollView {
            LazyVStack(spacing: 18) {
              pairingOnlyGroup
              Spacer(minLength: 20)
            }
            .padding(.vertical, 12)
          }
          .background(SettingsAuroraBackground().ignoresSafeArea())
        } else {
          settingsList
        }
      }
      .adeNavigationGlass()
      .navigationTitle(pairingOnly ? "Connect a computer" : "Settings")
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            dismiss()
          } label: {
            Image(systemName: "xmark")
              .font(.system(size: 13, weight: .semibold))
          }
          .accessibilityLabel("Close settings")
        }
      }
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
  }

  /// Pairing-only entry point (from the no-account gate): connection status +
  /// the pair actions, nothing else.
  @ViewBuilder
  private var pairingOnlyGroup: some View {
    VStack(alignment: .leading, spacing: 12) {
      SettingsSectionHeader(label: "CONNECTION", hint: "Your computer connection")

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
        onWake: wakeAsleepMachine
      )

      SettingsPairingSection(
        snapshot: presentationModel.pairingSnapshot,
        presentedSheet: $presentedSheet,
        initiallyExpanded: true
      )
    }
    .padding(.horizontal, 16)
    .padding(.top, 4)
  }

  private var settingsList: some View {
    List {
      Section {
        accountRow
      }
      SettingsMachineSections(
        syncService: syncService,
        controller: machineController,
        presentedSheet: $presentedSheet
      )
      Section {
        linkRow("Appearance", systemImage: "circle.lefthalf.filled") {
          SettingsDestinationPage(title: "Appearance") { SettingsAppearanceSection() }
        }
        linkRow("Notifications", systemImage: "bell.badge") {
          SettingsDestinationPage(title: "Notifications") {
            SettingsPushDeliverySection(
              snapshot: presentationModel.pushDeliverySnapshot,
              pushService: PushNotificationService.shared
            )
          }
        }
        linkRow("Usage", systemImage: "chart.line.uptrend.xyaxis") {
          SettingsUsagePage(syncService: syncService)
        }
        linkRow("AI accounts", systemImage: "person.2.badge.key") {
          SettingsProviderAccountsPage(syncService: syncService)
        }
      } header: {
        ADEFlatSectionHeader("App")
      }
      Section {
        linkRow("Connection details", systemImage: "point.3.connected.trianglepath.dotted") {
          SettingsDestinationPage(title: "Connection details") {
            SettingsDiagnosticsSection(snapshot: presentationModel.diagnosticsSnapshot, content: .connection)
          }
        }
        linkRow("Delivery diagnostics", systemImage: "stethoscope") {
          SettingsDestinationPage(title: "Delivery diagnostics") {
            SettingsPushDeliverySection(
              snapshot: presentationModel.pushDeliverySnapshot,
              pushService: PushNotificationService.shared,
              content: .diagnostics
            )
          }
        }
        linkRow("About \(thisDeviceGroupLabel.replacingOccurrences(of: "This ", with: "this "))", systemImage: "info.circle") {
          SettingsDestinationPage(title: "About") {
            SettingsDiagnosticsSection(snapshot: presentationModel.diagnosticsSnapshot, content: .about)
          }
        }
      } header: {
        ADEFlatSectionHeader("About")
      }
    }
    .adeFlatList()
  }

  @ViewBuilder
  private var accountRow: some View {
    if account.isConfigured {
      switch account.phase {
      case .signedIn:
        if let identity = account.identity {
          NavigationLink {
            SettingsAccountPage()
          } label: {
            HStack(spacing: 12) {
              AccountAvatar(identity: identity)
              VStack(alignment: .leading, spacing: 2) {
                Text(identity.displayName)
                  .font(.body.weight(.semibold))
                  .foregroundStyle(ADEColor.textPrimary)
                  .lineLimit(1)
                if let email = identity.email {
                  Text(email)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                }
              }
            }
          }
          .adeFlatRow()
        }
      case .loading:
        ProgressView()
          .frame(maxWidth: .infinity, alignment: .leading)
          .adeFlatRow()
      default:
        Button {
          signInPresented = true
        } label: {
          Label("Sign in to ADE", systemImage: "person.crop.circle.badge.plus")
            .foregroundStyle(ADEColor.accent)
        }
        .adeFlatRow()
      }
    }
  }

  private func linkRow<Destination: View>(
    _ title: String,
    systemImage: String,
    @ViewBuilder destination: @escaping () -> Destination
  ) -> some View {
    NavigationLink(destination: destination) {
      Label {
        Text(title)
          .foregroundStyle(ADEColor.textPrimary)
      } icon: {
        Image(systemName: systemImage)
          .foregroundStyle(ADEColor.accent)
      }
    }
    .adeFlatRow()
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
      .presentationDetents([.medium, .large])

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

private struct SettingsDestinationPage<Content: View>: View {
  let title: String
  @ViewBuilder let content: () -> Content

  var body: some View {
    ScrollView {
      content()
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .adeNavigationGlass()
    .navigationTitle(title)
    .navigationBarTitleDisplayMode(.inline)
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
        hostCompatibilityMissingActions: syncService.hostCompatibilityMissingActions
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

private struct SettingsAuroraBackground: View {
  var body: some View {
    ZStack {
      ADEColor.pageBackground

      RadialGradient(
        colors: [
          ADEColor.purpleAccent.opacity(0.35),
          ADEColor.purpleAccent.opacity(0.0),
        ],
        center: UnitPoint(x: 0.5, y: -0.05),
        startRadius: 30,
        endRadius: 420
      )

      RadialGradient(
        colors: [
          Color(red: 99.0 / 255.0, green: 102.0 / 255.0, blue: 241.0 / 255.0).opacity(0.22),
          .clear,
        ],
        center: UnitPoint(
          x: 0.92,
          y: 0.18
        ),
        startRadius: 8,
        endRadius: 280
      )

      RadialGradient(
        colors: [
          Color(red: 236.0 / 255.0, green: 72.0 / 255.0, blue: 153.0 / 255.0).opacity(0.14),
          .clear,
        ],
        center: UnitPoint(
          x: 0.05,
          y: 0.32
        ),
        startRadius: 6,
        endRadius: 240
      )
    }
  }
}

/// Settings > Account: who is signed in, and Sign out.
struct SettingsAccountPage: View {
  @ObservedObject private var account = AccountService.shared
  @State private var confirmSignOut = false

  var body: some View {
    List {
      if let identity = account.identity {
        Section {
          HStack(spacing: 14) {
            AccountAvatar(identity: identity)
            VStack(alignment: .leading, spacing: 3) {
              Text(identity.displayName)
                .font(.title3.weight(.semibold))
                .foregroundStyle(ADEColor.textPrimary)
              if let email = identity.email {
                Text(email)
                  .font(.footnote)
                  .foregroundStyle(ADEColor.textSecondary)
                  .truncationMode(.middle)
              }
            }
            Spacer(minLength: 8)
            ADEFlatBadge(text: identity.providerLabel, tint: identity.accent)
          }
          .adeFlatRow(separator: .hidden)
        }
      }
      Section {
        Button("Sign out", role: .destructive) {
          confirmSignOut = true
        }
        .adeFlatRow()
      }
    }
    .adeFlatList()
    .navigationTitle("Account")
    .navigationBarTitleDisplayMode(.inline)
    .confirmationDialog("Sign out of ADE?", isPresented: $confirmSignOut, titleVisibility: .visible) {
      Button("Sign out", role: .destructive) {
        Task { await account.signOut() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Signing out removes this iPhone's access to your account and its account-connected machines. Devices paired directly with a code stay connected.")
    }
  }
}
