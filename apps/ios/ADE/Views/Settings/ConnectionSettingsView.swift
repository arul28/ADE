import Combine
import SwiftUI
import UserNotifications

struct ConnectionSettingsView: View {
  let syncService: SyncService
  let pairingOnly: Bool

  @Environment(\.dismiss) private var dismiss
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  @StateObject private var presentationModel = SettingsConnectionPresentationModel()
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
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 18) {
          if pairingOnly {
            // Pairing-only entry point (from the no-account gate): connection
            // status + the pair actions, nothing else.
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
          } else {
            // Settings IA (M5): account card → connection status → connections
            // (machines list, then the ways to add one).

            // 1. Account card (identity / sign-in). Self-hides with no Clerk key.
            AccountConnectionsSection(onConnectMachine: connectToAccountMachine)
              .padding(.horizontal, 16)
              .padding(.top, 4)

            // 2. Connection status.
            VStack(alignment: .leading, spacing: 12) {
              SettingsSectionHeader(label: "CONNECTION")

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
            }
            .padding(.horizontal, 16)

            // 3. Connections: your machines (top 3 + See all), then how to add.
            VStack(alignment: .leading, spacing: 16) {
              SettingsMachinesSection(
                syncService: syncService,
                onPairWithPin: { host in
                  pinPreset = .discover(host)
                }
              )

              SettingsPairingSection(
                snapshot: presentationModel.pairingSnapshot,
                presentedSheet: $presentedSheet
              )
            }
            .padding(.horizontal, 16)

            SettingsAppearanceSection()
              .padding(.horizontal, 16)

            VStack(spacing: 8) {
              // One Usage destination — cost, activity, and live limits on a
              // single scroll rather than a limits section here and a stats
              // screen somewhere else.
              SettingsNavigationRow(
                title: "Usage",
                subtitle: "Cost, activity, and live limits",
                systemImage: "chart.line.uptrend.xyaxis"
              ) {
                SettingsUsagePage(syncService: syncService)
              }

              SettingsNavigationRow(
                title: "Connection details",
                subtitle: "Route and connection performance",
                systemImage: "point.3.connected.trianglepath.dotted"
              ) {
                SettingsDestinationPage(title: "Connection details") {
                  SettingsDiagnosticsSection(
                    snapshot: presentationModel.diagnosticsSnapshot,
                    content: .connection
                  )
                }
              }

              SettingsNavigationRow(
                title: "About",
                subtitle: "App, machine, and device information",
                systemImage: "info.circle"
              ) {
                SettingsDestinationPage(title: "About") {
                  SettingsDiagnosticsSection(
                    snapshot: presentationModel.diagnosticsSnapshot,
                    content: .about
                  )
                }
              }

              SettingsNavigationRow(
                title: "Push delivery",
                subtitle: "Notifications and Live Activities",
                systemImage: "bell.badge"
              ) {
                SettingsDestinationPage(title: "Push delivery") {
                  SettingsPushDeliverySection(
                    snapshot: presentationModel.pushDeliverySnapshot,
                    pushService: PushNotificationService.shared
                  )
                }
              }

              SettingsNavigationRow(
                title: "Delivery diagnostics",
                subtitle: "Push registration and relay status",
                systemImage: "stethoscope"
              ) {
                SettingsDestinationPage(title: "Delivery diagnostics") {
                  SettingsPushDeliverySection(
                    snapshot: presentationModel.pushDeliverySnapshot,
                    pushService: PushNotificationService.shared,
                    content: .diagnostics
                  )
                }
              }
            }
              .padding(.horizontal, 16)
          }

          Spacer(minLength: 20)
        }
        .padding(.vertical, 12)
      }
      .background(SettingsAuroraBackground().ignoresSafeArea())
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
      .onAppear {
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

private struct SettingsNavigationRow<Destination: View>: View {
  let title: String
  let subtitle: String
  let systemImage: String
  @ViewBuilder let destination: () -> Destination

  var body: some View {
    NavigationLink(destination: destination) {
      HStack(spacing: 14) {
        Image(systemName: systemImage)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent)
          .frame(width: 34, height: 34)
          .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
              .fill(ADEColor.purpleAccent.opacity(0.14))
          )

        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.body.weight(.medium))
            .foregroundStyle(ADEColor.textPrimary)
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 8)

        Image(systemName: "chevron.right")
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(ADEColor.purpleAccent.opacity(0.65))
      }
      .padding(.horizontal, 14)
      .padding(.vertical, 12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(ADEColor.surfaceBackground.opacity(0.5))
      )
      .glassEffect(in: .rect(cornerRadius: 14))
      .overlay(
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .stroke(ADEColor.glassBorder, lineWidth: 0.75)
      )
    }
    .buttonStyle(ADEScaleButtonStyle())
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
    .background(SettingsAuroraBackground().ignoresSafeArea())
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

/// The CONNECTIONS machine list: a unified, deduplicated roster of the computers a
/// phone can reach — machines on the signed-in account plus previously-paired
/// machines — ranked current → online → offline. Shows the top three inline
/// with a "See all machines" sheet for the rest. Offline machines render grayed
/// and non-tappable (desktop-style). A failed connect surfaces inline on the
/// tapped row (M14) rather than in a separate lower banner.
struct SettingsMachinesSection: View {
  let syncService: SyncService
  let onPairWithPin: (DiscoveredSyncHost) -> Void
  @ObservedObject private var account = AccountService.shared

  @State private var seeAllPresented = false
  @State private var renamingMachine: AccountMachine?
  @State private var connectingId: String?
  @State private var rowErrors: [String: String] = [:]

  struct Entry: Identifiable {
    enum Kind {
      case account(AccountMachine)
      case saved(DiscoveredSyncHost)
    }
    let id: String
    let name: String
    let routeHint: String
    let online: Bool
    /// The machine said it was asleep, or has been silent long enough that
    /// asleep is the only honest reading. Turns "Connect" into "Wake".
    let isAsleep: Bool
    /// This phone holds a socket to it. Still true for a machine that has since
    /// announced a suspend — the socket does not report itself closed — which
    /// is why it is not what the row RENDERS.
    let isCurrent: Bool
    let kind: Kind

    /// What the row is allowed to show as connected. An announced sleep
    /// outranks the socket: a green CONNECTED pill on a Mac that told us it was
    /// going dark is the claim this whole pass exists to stop making.
    var presentsAsConnected: Bool { isCurrent && !isAsleep }
  }

  private var isConnected: Bool {
    syncService.connectionState == .connected
  }

  /// Row id of the machine currently attached, so its stale failure — and only
  /// its — can be retired the moment it is disproven.
  private var currentEntryId: String? {
    entries.first(where: \.isCurrent)?.id
  }

  private var currentIdentity: String? {
    let value = syncService.activeHostProfile?.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines)
    return (value?.isEmpty == false) ? value : nil
  }

  private var currentHostName: String? {
    let value = syncService.hostName?.trimmingCharacters(in: .whitespacesAndNewlines)
    return (value?.isEmpty == false) ? value : nil
  }

  private var entries: [Entry] {
    var result: [Entry] = []
    var seen = Set<String>()

    let accountEntries = account.machines.map { machine in
      let current = if let currentIdentity, let deviceId = machine.deviceId {
        isConnected && deviceId.caseInsensitiveCompare(currentIdentity) == .orderedSame
      } else {
        false
      }
      let lastSeen = machineLastSeenDate(epochMilliseconds: machine.lastSeenAt)
      // An announced sleep beats attached, not the other way round. A channel
      // to a sleeping machine does not report itself closed — the socket simply
      // stops answering — so `current` is the flag that has not found out yet,
      // and the machine's own "I'm going to sleep now" is the better evidence.
      // Saying "Connected" to a Mac that had been asleep for three minutes is
      // the bug this ordering exists to fix.
      let asleep = syncMachinePresence(
        connected: current,
        online: machine.online,
        sleepState: machine.sleepState,
        sleepStateAt: machineLastSeenDate(epochMilliseconds: machine.sleepStateAt),
        lastSeenAt: lastSeen
      ) == .asleep
      return (
        key: (machine.deviceId ?? machine.machineKey).lowercased(),
        entry: Entry(
          id: "account-\(machine.id)",
          name: machine.displayName,
          // Route-neutral to match the saved rows below; the route kind stays
          // in the Connection details section, never on the primary list.
          routeHint: accountMachineDetailLine(
            isConnected: current && !asleep,
            isAsleep: asleep,
            directoryOnline: machine.online,
            lastSeenAt: lastSeen,
            power: machine.power
          ),
          online: machine.online,
          isAsleep: asleep,
          isCurrent: current,
          kind: .account(machine)
        )
      )
    }

    // Reachable account routes are preferred, but stale directory rows must
    // not hide a currently-discovered saved route for the same Mac.
    for candidate in accountEntries {
      guard seen.insert(candidate.key).inserted else { continue }
      result.append(candidate.entry)
    }

    let live = syncService.discoveredHosts
    for host in syncService.savedReconnectHosts {
      let identity = host.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines)
      let key = identity.flatMap { $0.isEmpty ? nil : $0.lowercased() }
        ?? "name:\(host.hostName.lowercased())"
      guard seen.insert(key).inserted else { continue }
      let online = live.contains { sameSyncHost(host, $0) }
      let identityMatches = if let currentIdentity, let identity {
        currentIdentity.caseInsensitiveCompare(identity) == .orderedSame
      } else {
        false
      }
      let nameMatchesWithoutStableIdentity = currentIdentity == nil
        && identity == nil
        && currentHostName?.caseInsensitiveCompare(host.hostName) == .orderedSame
      let current = isConnected && (identityMatches || nameMatchesWithoutStableIdentity)
      result.append(Entry(
        id: "saved-\(host.id)",
        name: host.hostName,
        routeHint: machineReachabilityText(
          isConnected: current,
          directoryOnline: online,
          lastSeenAt: machineLastSeenDate(iso8601: host.lastResolvedAt)
        ),
        online: online,
        // A directly-paired host publishes no power or sleep state, so it keeps
        // exactly the row it had before any of this existed.
        isAsleep: false,
        isCurrent: current,
        kind: .saved(host)
      ))
    }

    return result.sorted { lhs, rhs in
      if lhs.isCurrent != rhs.isCurrent { return lhs.isCurrent }
      if lhs.online != rhs.online { return lhs.online }
      return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }
  }

  var body: some View {
    let all = entries
    VStack(alignment: .leading, spacing: 12) {
      SettingsSectionHeader(label: "MACHINES")

      if all.isEmpty {
        Text("No machines yet. Add one below.")
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(14)
          .background(ADEColor.surfaceBackground.opacity(0.4), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
          .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 0.5))
      } else {
        VStack(spacing: 8) {
          ForEach(all.prefix(3)) { entry in
            machineRow(entry)
          }
        }

        if all.count > 3 {
          Button {
            seeAllPresented = true
          } label: {
            HStack(spacing: 6) {
              Text("See all machines")
                .font(.subheadline.weight(.semibold))
              Text("\(all.count)")
                .font(.caption.weight(.semibold).monospacedDigit())
                .foregroundStyle(ADEColor.textMuted)
              Spacer(minLength: 0)
              Image(systemName: "chevron.right")
                .font(.system(size: 12, weight: .semibold))
            }
            .foregroundStyle(ADEColor.accent)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 4)
          }
          .buttonStyle(.plain)
        }
      }
    }
    .task { await account.loadMachines() }
    .onChange(of: currentEntryId) { _, entryId in
      rowErrors = settingsMachineRowErrorsRetiring(rowErrors, attachedEntryId: entryId)
    }
    .sheet(isPresented: $seeAllPresented) {
      allMachinesSheet
    }
    .sheet(item: $renamingMachine) { machine in
      SettingsMachineRenameSheet(machine: machine)
        .presentationDetents([.medium, .large])
    }
  }

  private var allMachinesSheet: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 8) {
          ForEach(entries) { entry in
            machineRow(entry)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("All machines")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { seeAllPresented = false }
        }
      }
    }
  }

  @ViewBuilder
  private func machineRow(_ entry: Entry) -> some View {
    let isConnecting = connectingId == entry.id
    // Follows what the row PRESENTS, not the socket: a machine that announced a
    // suspend while we still held a channel keeps its Wake, and keeps it
    // tappable, for the seconds it takes that channel to notice.
    let tappable = !entry.presentsAsConnected && connectingId == nil

    VStack(alignment: .leading, spacing: 0) {
      Group {
        if tappable {
          Button {
            connect(entry)
          } label: {
            machineRowLabel(entry, isConnecting: isConnecting)
          }
          .buttonStyle(ADEScaleButtonStyle())
        } else {
          machineRowLabel(entry, isConnecting: isConnecting)
        }
      }
      .accessibilityLabel("\(entry.name), \(entry.routeHint)")
      .accessibilityHint(tappable ? (entry.isAsleep ? "Wake and connect." : "Connect.") : "")
      .contextMenu {
        if let machine = accountMachine(from: entry) {
          Button {
            renamingMachine = machine
          } label: {
            Label("Rename", systemImage: "pencil")
          }
        }
      }
      .opacity(tappable || entry.isCurrent ? 1 : 0.72)

      if let error = rowErrors[entry.id] {
        VStack(alignment: .leading, spacing: 7) {
          Text(error)
            .font(.caption)
            .foregroundStyle(ADEColor.danger)
            .fixedSize(horizontal: false, vertical: true)
          if let fallbackHost = pinFallbackHost(for: entry) {
            Button("Pair with PIN instead") {
              onPairWithPin(fallbackHost)
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(ADEColor.accent)
            .frame(minHeight: 44)
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
      } else if isConnecting, let stage = syncService.accountConnectStageLabel {
        Text(stage)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 12)
          .padding(.top, 6)
      }
    }
  }

  private func machineRowLabel(_ entry: Entry, isConnecting: Bool) -> some View {
    MachineRowView(
      deviceSymbol: deviceSymbol(entry),
      title: entry.name,
      routeHint: entry.routeHint,
      online: entry.online,
      isAuthenticatedCurrent: entry.presentsAsConnected,
      statusPill: entry.presentsAsConnected ? .connected : nil,
      affordance: rowAffordance(entry, isConnecting: isConnecting),
      surface: .row
    )
  }

  private func accountMachine(from entry: Entry) -> AccountMachine? {
    guard case .account(let machine) = entry.kind else { return nil }
    return machine
  }

  private func rowAffordance(_ entry: Entry, isConnecting: Bool) -> MachineRowView.Affordance {
    if isConnecting { return .connecting }
    // Asleep first, for the same reason the pill defers to it: offering a
    // checkmark on a machine that announced a suspend tells the user the one
    // thing they cannot act on.
    if entry.isAsleep { return .wake }
    if entry.isCurrent { return .connected }
    return .connect
  }

  private func deviceSymbol(_ entry: Entry) -> String {
    switch entry.kind {
    case .account(let machine):
      return machineDeviceSymbol(deviceType: machine.deviceType, platform: machine.platform)
    case .saved:
      return machineDeviceSymbol(deviceType: nil, platform: nil)
    }
  }

  private func pinFallbackHost(for entry: Entry) -> DiscoveredSyncHost? {
    guard case .account(let machine) = entry.kind,
          let fallback = syncService.accountPairingPinFallbackHost,
          fallback.hostIdentity == machine.deviceId else {
      return nil
    }
    return fallback
  }

  private func connect(_ entry: Entry) {
    // Same reading as `tappable`, so a row that offers Wake can take the tap.
    guard !entry.presentsAsConnected, connectingId == nil else { return }
    connectingId = entry.id
    rowErrors = [:]
    Task { @MainActor in
      switch entry.kind {
      case .account(let machine):
        guard let authorization = AccountService.shared.currentPairingAuthorization else {
          connectingId = nil
          rowErrors[entry.id] = "Your account session ended. Sign in again, then choose your computer."
          return
        }
        let connected = await syncService.pairWithAccountMachine(
          machine,
          authorization: authorization
        )
        connectingId = nil
        if connected {
          ADEHaptics.success()
        } else {
          ADEHaptics.error()
          rowErrors[entry.id] = settingsMachineRowErrorMessage(
            attemptFailure: syncService.lastConnectAttemptFailure,
            lastError: syncService.lastError,
            fallback: "ADE could not connect to that computer. Try again."
          )
        }

      case .saved(let host):
        // Ask the call what happened. `connectionState` can be attached here
        // because a failed attempt restored the PREVIOUS machine, which is not
        // the same thing as this row succeeding.
        let reconnected = await syncService.reconnect(toSavedHost: host)
        connectingId = nil
        if reconnected {
          ADEHaptics.success()
        } else {
          ADEHaptics.error()
          rowErrors[entry.id] = settingsMachineRowErrorMessage(
            attemptFailure: syncService.lastConnectAttemptFailure,
            lastError: syncService.lastError,
            fallback: "ADE could not reconnect to \(host.hostName)."
          )
        }
      }
    }
  }
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
