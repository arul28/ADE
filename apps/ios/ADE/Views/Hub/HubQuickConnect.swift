import SwiftUI

func hubSavedMachineIsRecentlyReachable(
  _ savedHost: DiscoveredSyncHost,
  liveHosts: [DiscoveredSyncHost]
) -> Bool {
  liveHosts.contains { sameSyncHost(savedHost, $0) }
}

// One-tap connect cards shown on the hub's no-machine home. Split out of
// HubComponents.swift so that large file stays focused on the project/lane/chat
// list rendering.

// MARK: - Quick-connect (no-machine home)

/// One-tap connect cards shown on the no-machine home for account and saved
/// machines. Directory/discovery presence is only a hint; saved secure records
/// remain attemptable without claiming the Mac is currently reachable.
struct HubQuickConnectSection: View {
  @EnvironmentObject private var syncService: SyncService
  @ObservedObject private var account = AccountService.shared
  var onConnectSuccess: () -> Void = {}

  @State private var connectingId: String?
  @State private var errorText: String?

  private enum Target: Identifiable {
    case account(AccountMachine)
    case saved(DiscoveredSyncHost)

    var id: String {
      switch self {
      case .account(let machine): return "account-\(machine.id)"
      case .saved(let host): return "saved-\(host.id)"
      }
    }
  }

  private var accountMachines: [AccountMachine] {
    account.machines
  }

  /// Saved secure records remain connectable even when discovery is stale.
  private var savedHosts: [DiscoveredSyncHost] {
    syncService.savedReconnectHosts
  }

  /// Account and saved records can describe the same Mac. Prefer the account
  /// card when both stable IDs match, while retaining a live saved card when
  /// the account directory currently considers that Mac offline.
  private var targets: [Target] {
    let accountTargets = accountMachines.map(Target.account)
    let accountIdentities = Set(accountMachines.compactMap { normalizedIdentity($0.deviceId) })
    let savedTargets = savedHosts.compactMap { host -> Target? in
      if let identity = normalizedIdentity(host.hostIdentity), accountIdentities.contains(identity) {
        return nil
      }
      return .saved(host)
    }
    return accountTargets + savedTargets
  }

  private var hasTargets: Bool {
    !targets.isEmpty
  }

  private var showsEmptyNote: Bool {
    !hasTargets && (account.isSignedIn || !syncService.savedReconnectHosts.isEmpty)
  }

  var body: some View {
    Group {
      if hasTargets {
        VStack(spacing: 10) {
          ForEach(targets.prefix(2)) { target in
            switch target {
            case .account(let machine):
              HubQuickConnectCard(
                title: machine.displayName,
                routeHint: machineStatusHint(online: machine.online),
                deviceSymbol: machineDeviceSymbol(deviceType: machine.deviceType, platform: machine.platform),
                online: machine.online,
                isConnecting: connectingId == accountKey(machine),
                isDisabled: connectingId != nil
              ) { connectAccount(machine) }
            case .saved(let host):
              let online = hubSavedMachineIsRecentlyReachable(
                host,
                liveHosts: syncService.discoveredHosts
              )
              HubQuickConnectCard(
                title: host.hostName,
                routeHint: machineStatusHint(online: online),
                deviceSymbol: machineDeviceSymbol(deviceType: nil, platform: nil),
                online: online,
                isConnecting: connectingId == savedKey(host),
                isDisabled: connectingId != nil
              ) { connectSaved(host) }
            }
          }
          if targets.count > 2 {
            Button("See all machines", systemImage: "chevron.right") {
              syncService.settingsPresented = true
            }
            .font(.subheadline.bold())
            .frame(minHeight: 44)
          }
          if let errorText {
            Text(errorText)
              .font(.caption)
              .foregroundStyle(ADEColor.danger)
              .multilineTextAlignment(.center)
              .frame(maxWidth: .infinity)
          }
        }
      } else if showsEmptyNote {
        HStack(spacing: 8) {
          Circle().fill(ADEColor.textMuted).frame(width: 7, height: 7)
          Text("No saved machines yet")
            .font(.system(.caption, design: .rounded).weight(.medium))
            .foregroundStyle(ADEColor.textMuted)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(ADEColor.cardBackground.opacity(0.4), in: Capsule())
        .overlay(Capsule().stroke(ADEColor.border.opacity(0.5), lineWidth: 1))
      }
    }
    .frame(maxWidth: 420)
    .task { await account.loadMachines() }
  }

  private func accountKey(_ machine: AccountMachine) -> String { "account-\(machine.id)" }
  private func savedKey(_ host: DiscoveredSyncHost) -> String { "saved-\(host.id)" }

  private func normalizedIdentity(_ identity: String?) -> String? {
    guard let identity = identity?.trimmingCharacters(in: .whitespacesAndNewlines),
          !identity.isEmpty else { return nil }
    return identity.lowercased()
  }

  private func connectAccount(_ machine: AccountMachine) {
    guard connectingId == nil else { return }
    connectingId = accountKey(machine)
    errorText = nil
    Task { @MainActor in
      guard let authorization = AccountService.shared.currentPairingAuthorization else {
        errorText = "Your account session ended. Sign in again, then choose your Mac."
        connectingId = nil
        return
      }
      let connected = await syncService.pairWithAccountMachine(
        machine,
        authorization: authorization
      )
      connectingId = nil
      if connected {
        ADEHaptics.success()
        onConnectSuccess()
      } else {
        ADEHaptics.error()
        errorText = syncService.lastError ?? "ADE could not connect to that Mac. Try again."
      }
    }
  }

  private func connectSaved(_ host: DiscoveredSyncHost) {
    guard connectingId == nil else { return }
    connectingId = savedKey(host)
    errorText = nil
    Task { @MainActor in
      await syncService.reconnect(toSavedHost: host)
      connectingId = nil
      if syncService.connectionState == .connected || syncService.connectionState == .syncing {
        ADEHaptics.success()
        onConnectSuccess()
      } else {
        ADEHaptics.error()
        errorText = syncService.lastError ?? "ADE could not reconnect to \(host.hostName)."
      }
    }
  }
}

struct HubQuickConnectCard: View {
  let title: String
  let routeHint: String
  var deviceSymbol: String = "laptopcomputer"
  var online: Bool
  var isConnecting: Bool
  var isDisabled: Bool
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      MachineRowView(
        deviceSymbol: deviceSymbol,
        title: title,
        routeHint: routeHint,
        online: online,
        statusPill: nil,
        affordance: isConnecting ? .connecting : .chevron,
        surface: .card
      )
      .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
    .buttonStyle(ADEScaleButtonStyle())
    .disabled(isDisabled)
    .opacity(isDisabled && !isConnecting ? 0.5 : 1)
    .accessibilityLabel("Connect to \(title), \(routeHint)")
  }
}
