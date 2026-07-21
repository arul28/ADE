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
              SettingsSectionHeader(label: "MAC", hint: "Your Mac connection")

              SettingsConnectionHeader(
                snapshot: presentationModel.connectionSnapshot,
                onDisconnect: { syncService.disconnectForUserConnectionChange() },
                onReconnect: {
                  Task { await syncService.reconnectForUserConnectionChange() }
                }
              )

              SettingsPairingSection(
                snapshot: presentationModel.pairingSnapshot,
                presentedSheet: $presentedSheet
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
              SettingsSectionHeader(label: "CONNECTION", hint: "Your current Mac connection")

              SettingsConnectionHeader(
                snapshot: presentationModel.connectionSnapshot,
                onDisconnect: { syncService.disconnectForUserConnectionChange() },
                onReconnect: {
                  Task { await syncService.reconnectForUserConnectionChange() }
                }
              )
            }
            .padding(.horizontal, 16)

            // 3. Connections: your machines (top 3 + See all), then how to add.
            VStack(alignment: .leading, spacing: 16) {
              SettingsMachinesSection(syncService: syncService)

              SettingsPairingSection(
                snapshot: presentationModel.pairingSnapshot,
                presentedSheet: $presentedSheet
              )
            }
            .padding(.horizontal, 16)

            SettingsAppearanceSection()
              .padding(.horizontal, 16)

            SettingsUsageQuotaSection(syncService: syncService)
              .padding(.horizontal, 16)

            SettingsDiagnosticsSection(snapshot: presentationModel.diagnosticsSnapshot)
              .padding(.horizontal, 16)

            SettingsPushDeliverySection(
              snapshot: presentationModel.pushDeliverySnapshot,
              pushService: PushNotificationService.shared
            )
              .padding(.horizontal, 16)
          }

          Spacer(minLength: 20)
        }
        .padding(.vertical, 12)
      }
      .background(SettingsAuroraBackground().ignoresSafeArea())
      .adeNavigationGlass()
      .navigationTitle(pairingOnly ? "Connect a Mac" : "Settings")
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
      _ = await syncService.pairWithAccountMachine(
        machine,
        authorization: authorization
      )
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
  var canReconnectToSavedHost: Bool
  var errorMessage: String?
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
    hostDisplayName: nil,
    pendingHostName: nil,
    canReconnectToSavedHost: false,
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
        canReconnectToSavedHost: syncService.canReconnectToSavedHost,
        errorMessage: health.transport == .unreachable ? health.lastFailureMessage : nil,
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

private struct SettingsUsageQuotaSection: View {
  let syncService: SyncService

  @ObservedObject private var store = MobileUsageQuotaStore.shared

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .firstTextBaseline) {
        SettingsSectionHeader(label: "AI USAGE", hint: "Live limits from your machine")
        Spacer(minLength: 8)
        Button {
          Task { await store.load(using: syncService, refresh: true) }
        } label: {
          if store.refreshing {
            ProgressView().controlSize(.small)
          } else {
            Image(systemName: "arrow.clockwise")
          }
        }
        .frame(width: 44, height: 44)
        .buttonStyle(.plain)
        .accessibilityLabel("Refresh AI usage limits")
        .disabled(!syncService.supportsRemoteAction("usage.refreshQuota") || store.refreshing)
      }

      VStack(spacing: 0) {
        if let snapshot = store.snapshot {
          ForEach(["claude", "codex"], id: \.self) { provider in
            SettingsUsageProviderCard(
              provider: provider,
              windows: snapshot.windows.filter { $0.provider == provider },
              status: snapshot.providerStatus?[provider],
              spendControlReached: provider == "codex" && snapshot.spendControlReached == true
            )
            if provider == "claude" { Divider().opacity(0.14) }
          }
        } else {
          Text("Pair with an updated ADE machine to load Claude and Codex limits.")
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(14)
        }
      }
      .background(ADEColor.surfaceBackground.opacity(0.82), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
      .overlay { RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(ADEColor.glassBorder, lineWidth: 0.6) }

      if let error = store.errorMessage {
        Text(error)
          .font(.caption2)
          .foregroundStyle(ADEColor.warning)
      }
    }
    .task(id: syncService.connectionState.rawValue) {
      await store.load(using: syncService)
    }
  }
}

private struct SettingsUsageProviderCard: View {
  let provider: String
  let windows: [MobileUsageQuotaWindow]
  let status: MobileUsageProviderStatus?
  let spendControlReached: Bool

  private var displayName: String { providerLabel(provider) }
  private var providerTint: Color { ADEColor.providerBrand(for: provider) }
  private var usageURL: URL {
    if provider == "claude" {
      return URL(string: "https://claude.ai/new#settings/usage")!
    }
    return URL(string: "https://chatgpt.com/codex/cloud/settings/analytics#usage")!
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack {
        if let assetName = providerAssetName(provider) {
          Image(assetName)
            .resizable()
            .scaledToFit()
            .frame(width: 18, height: 18)
            .accessibilityHidden(true)
        }

        Text(displayName)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)

        Link(destination: usageURL) {
          Image(systemName: "arrow.up.right")
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 44, height: 44)
            .contentShape(Rectangle())
        }
        .accessibilityLabel("Open \(displayName) usage in browser")

        Spacer()
        Text("\(mobileUsageProviderSource(status)) · \(mobileUsageSettingsRelativeTime(status?.updatedAt ?? status?.lastSuccessAt))")
          .font(.caption2)
          .foregroundStyle(ADEColor.textMuted)
      }

      if spendControlReached {
        Text("Spending cap reached")
          .font(.caption.weight(.medium))
          .foregroundStyle(ADEColor.warning)
      }

      ForEach(windows) { window in
        let percentUsed = window.clampedPercentUsed
        VStack(alignment: .leading, spacing: 5) {
          HStack {
            Text(mobileUsageWindowLabel(window))
            Spacer()
            Text(String(format: "%.1f%% used", percentUsed))
              .fontWeight(.semibold)
          }
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)

          ProgressView(value: percentUsed, total: 100)
            .tint(percentUsed > 90 ? ADEColor.danger : percentUsed > 70 ? ADEColor.warning : providerTint)

          Text(mobileUsageSettingsResetLabel(window.resetsAt))
            .font(.caption2)
            .foregroundStyle(ADEColor.textMuted)
        }
      }

      if windows.isEmpty, status?.state == "ok" {
        Text("Waiting for the next usage reading")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }

      if let statusMessage = mobileUsageStatusMessage(status) {
        Text(statusMessage)
          .font(.caption2)
          .foregroundStyle(ADEColor.warning)
      }
    }
    .padding(14)
    .accessibilityElement(children: .contain)
  }
}

private func mobileUsageProviderSource(_ status: MobileUsageProviderStatus?) -> String {
  switch status?.source {
  case "oauth": return "OAuth"
  case "http": return "HTTP"
  case "cli": return "CLI"
  default: return "Waiting"
  }
}

private func mobileUsageWindowLabel(_ window: MobileUsageQuotaWindow) -> String {
  if window.windowType == "five_hour",
     let durationMs = window.windowDurationMs,
     durationMs > 0 {
    let minutes = Int((durationMs / 60_000).rounded())
    if minutes < 60 { return "\(minutes)-min" }
    let hours = Double(minutes) / 60
    if hours.rounded() == hours { return "\(Int(hours))-hour" }
    return String(format: "%.1f-hour", hours)
  }
  switch window.windowType {
  case "five_hour": return "5-hour"
  case "weekly": return "Weekly"
  case "monthly": return "Monthly"
  case "weekly_oauth_apps": return "OAuth apps"
  case "weekly_cowork": return "Cowork"
  default: return window.windowType.replacingOccurrences(of: "_", with: " ").capitalized
  }
}

private func mobileUsageStatusMessage(_ status: MobileUsageProviderStatus?) -> String? {
  guard let status, status.state != "ok" else { return nil }
  if let message = status.message?.trimmingCharacters(in: .whitespacesAndNewlines), !message.isEmpty {
    return message
  }
  return status.state == "stale" ? "Showing last known quota" : "Quota is unavailable"
}

private func mobileUsageSettingsDate(_ iso: String?) -> Date? {
  guard let iso else { return nil }
  let fractional = ISO8601DateFormatter()
  fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return fractional.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
}

private func mobileUsageSettingsRelativeTime(_ iso: String?) -> String {
  guard let date = mobileUsageSettingsDate(iso) else { return "not updated" }
  let seconds = max(0, Int(Date().timeIntervalSince(date)))
  if seconds < 60 { return "now" }
  if seconds < 3_600 { return "\(seconds / 60)m ago" }
  if seconds < 86_400 { return "\(seconds / 3_600)h ago" }
  return "\(seconds / 86_400)d ago"
}

private func mobileUsageSettingsResetLabel(_ iso: String) -> String {
  guard let date = mobileUsageSettingsDate(iso) else { return "Resetting soon" }
  let seconds = max(0, Int(date.timeIntervalSinceNow))
  if seconds == 0 { return "Resetting now" }
  let days = seconds / 86_400
  let hours = (seconds % 86_400) / 3_600
  let minutes = (seconds % 3_600) / 60
  if days > 0 { return "Resets in \(days)d \(hours)h" }
  if hours > 0 { return "Resets in \(hours)h \(minutes)m" }
  return "Resets in \(minutes)m"
}

// MARK: - Machines section (M5 / M14)

/// The CONNECTIONS machine list: a unified, deduplicated roster of the Macs a
/// phone can reach — machines on the signed-in account plus previously-paired
/// machines — ranked current → online → offline. Shows the top three inline
/// with a "See all machines" sheet for the rest. Offline machines render grayed
/// and non-tappable (desktop-style). A failed connect surfaces inline on the
/// tapped row (M14) rather than in a separate lower banner.
struct SettingsMachinesSection: View {
  let syncService: SyncService
  @ObservedObject private var account = AccountService.shared

  @State private var seeAllPresented = false
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
    let isCurrent: Bool
    let kind: Kind
  }

  private var isConnected: Bool {
    syncService.connectionState == .connected || syncService.connectionState == .syncing
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
      return (
        key: (machine.deviceId ?? machine.machineKey).lowercased(),
        entry: Entry(
          id: "account-\(machine.id)",
          name: machine.displayName,
          // Route-neutral to match the saved rows below; the route kind stays
          // in the Connection details section, never on the primary list.
          routeHint: machineStatusHint(online: machine.online),
          online: machine.online,
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
        routeHint: machineStatusHint(online: online),
        online: online,
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
      SettingsSectionHeader(label: "MACHINES", hint: "Macs you can connect to")

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
    .sheet(isPresented: $seeAllPresented) {
      allMachinesSheet
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
    let tappable = !entry.isCurrent && connectingId == nil

    VStack(alignment: .leading, spacing: 0) {
      Button {
        connect(entry)
      } label: {
        MachineRowView(
          deviceSymbol: deviceSymbol(entry),
          title: entry.name,
          routeHint: entry.routeHint,
          online: entry.online,
          statusPill: entry.isCurrent ? .connected : nil,
          affordance: rowAffordance(entry, isConnecting: isConnecting),
          surface: .row
        )
        .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
      }
      .buttonStyle(ADEScaleButtonStyle())
      .disabled(!tappable)
      .accessibilityLabel("\(entry.name), \(entry.isCurrent ? "connected" : "saved connection")")
      .accessibilityHint(tappable ? "Connect." : "")

      if let error = rowErrors[entry.id] {
        Text(error)
          .font(.caption)
          .foregroundStyle(ADEColor.danger)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 12)
          .padding(.top, 6)
      }
    }
  }

  private func rowAffordance(_ entry: Entry, isConnecting: Bool) -> MachineRowView.Affordance {
    if isConnecting { return .connecting }
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

  private func connect(_ entry: Entry) {
    guard connectingId == nil else { return }
    connectingId = entry.id
    rowErrors[entry.id] = nil
    Task { @MainActor in
      switch entry.kind {
      case .account(let machine):
        guard let authorization = AccountService.shared.currentPairingAuthorization else {
          connectingId = nil
          rowErrors[entry.id] = "Your account session ended. Sign in again, then choose your Mac."
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
          rowErrors[entry.id] = syncService.lastError ?? "ADE could not connect to that Mac. Try again."
        }

      case .saved(let host):
        await syncService.reconnect(toSavedHost: host)
        connectingId = nil
        if syncService.connectionState == .connected || syncService.connectionState == .syncing {
          ADEHaptics.success()
        } else {
          ADEHaptics.error()
          rowErrors[entry.id] = syncService.lastError ?? "ADE could not reconnect to \(host.hostName)."
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
