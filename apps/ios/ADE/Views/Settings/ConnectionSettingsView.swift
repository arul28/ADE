import Combine
import SwiftUI
import UserNotifications

struct ConnectionSettingsView: View {
  let syncService: SyncService

  @Environment(\.dismiss) private var dismiss
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  @StateObject private var presentationModel = SettingsConnectionPresentationModel()
  @State private var presentedSheet: SettingsPairSheetRoute?
  @State private var pinPreset: PinPreset?
  @State private var pinSetupRoute: PinSetupRoute?

  private var colorSchemeChoice: ADEColorSchemeChoice {
    ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 18) {
          // One "MACHINE" subsection: header → connection status card → pair
          // actions, so the whole machine area reads as a single group.
          VStack(alignment: .leading, spacing: 12) {
            SettingsSectionHeader(
              label: "MACHINE",
              hint: "Your machine connection"
            )

            SettingsConnectionHeader(
              snapshot: presentationModel.connectionSnapshot,
              onDisconnect: {
                syncService.disconnect()
              },
              onReconnect: { preferTailnet in
                Task {
                  await syncService.reconnectIfPossible(
                    userInitiated: true,
                    preferTailnet: preferTailnet
                  )
                }
              }
            )

            SettingsPairingSection(
              snapshot: presentationModel.pairingSnapshot,
              presentedSheet: $presentedSheet
            )
          }
            .padding(.horizontal, 16)
            .padding(.top, 4)

          SettingsAppearanceSection()
            .padding(.horizontal, 16)

          SettingsVoiceInputSection()
            .padding(.horizontal, 16)

          SettingsDiagnosticsSection(snapshot: presentationModel.diagnosticsSnapshot)
            .padding(.horizontal, 16)

          SettingsPushDeliverySection(
            snapshot: presentationModel.pushDeliverySnapshot,
            pushService: PushNotificationService.shared
          )
            .padding(.horizontal, 16)

          Spacer(minLength: 20)
        }
        .padding(.vertical, 12)
      }
      .background(SettingsAuroraBackground().ignoresSafeArea())
      .adeNavigationGlass()
      .navigationTitle("Settings")
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

    case .manual:
      ManualEntrySheet { host, port in
        presentedSheet = nil
        pinPreset = .manual(host: host, port: port)
      }
      .presentationDetents([.medium])

    case .scan:
      SettingsPairingScannerSheet { payload in
        presentedSheet = nil
        routePairingQr(payload)
      }

    case .webClient:
      SettingsWebClientPairSheet(syncService: syncService)
        .presentationDetents([.large])
    }
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
  var hostDisplayName: String?
  var pendingHostName: String?
  var routeLine: String?
  var canReconnectToSavedHost: Bool
  var savedReconnectPrefersTailnet: Bool
  var errorMessage: String?
  var showTailscaleOffHint = false
  var hostCompatibilityMode: SyncHostCompatibilityMode = .unknown
  var hostCompatibilityMissingActions: [String] = []
  /// True when the live, connected route is the cloud relay (a full wss:// URL)
  /// rather than a direct LAN/Tailscale path. Drives the quiet "prefer
  /// Tailscale" nudge in the header.
  var usingRelay = false
}

struct SettingsPairingSnapshot: Equatable {
  var discoveredHostCount = 0
  var savedReconnectHostCount = 0
}

struct SettingsDiagnosticsSnapshot: Equatable {
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
    hostDisplayName: nil,
    pendingHostName: nil,
    routeLine: nil,
    canReconnectToSavedHost: false,
    savedReconnectPrefersTailnet: false,
    errorMessage: nil
  )
  @Published private(set) var pairingSnapshot = SettingsPairingSnapshot()
  @Published private(set) var diagnosticsSnapshot = SettingsDiagnosticsSnapshot()
  @Published private(set) var pushDeliverySnapshot = SettingsPushDeliverySnapshot()

  private weak var boundService: SyncService?
  private var cancellable: AnyCancellable?
  private var pushCancellable: AnyCancellable?

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
  }

  private func refresh(from syncService: SyncService) {
    let activeProfile = syncService.activeHostProfile
    let savedReconnectHost = syncService.savedReconnectHost
    let health = syncService.connectionHealth
    let hostDisplayName = Self.trimmedNonEmpty(syncService.hostName) ?? Self.trimmedNonEmpty(activeProfile?.hostName)
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
        hostDisplayName: hostDisplayName,
        pendingHostName: health.transport == .connecting || health.transport == .unreachable ? hostDisplayName : nil,
        routeLine: Self.routeLine(address: address, port: activeProfile?.port),
        canReconnectToSavedHost: syncService.canReconnectToSavedHost,
        savedReconnectPrefersTailnet: savedReconnectHost?.tailscaleAddress != nil,
        errorMessage: health.transport == .unreachable ? health.lastFailureMessage : nil,
        showTailscaleOffHint: syncService.tailscaleOffHintVisible,
        hostCompatibilityMode: syncService.hostCompatibilityMode,
        hostCompatibilityMissingActions: syncService.hostCompatibilityMissingActions,
        usingRelay: syncService.connectionState == .connected
          && (address.map(syncIsFullWebSocketRoute) ?? false)
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
    snapshot.liveActivityTokenPresent = diagnostics.liveActivityPushToStartTokenSuffix != nil
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
