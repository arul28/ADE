import Combine
import SwiftUI

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

  private weak var boundService: SyncService?
  private var cancellable: AnyCancellable?

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
        errorMessage: health.transport == .unreachable ? health.lastFailureMessage : nil
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
  }

  private func update<Value: Equatable>(_ value: inout Value, to nextValue: Value) {
    guard value != nextValue else { return }
    value = nextValue
  }

  private static func routeLine(address: String?, port: Int?) -> String? {
    guard let address else { return nil }
    let prefix = syncIsTailscaleIPv4Address(address) ? "Tailscale " : ""
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
