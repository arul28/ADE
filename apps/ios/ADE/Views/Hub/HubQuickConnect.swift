import SwiftUI

// One-tap connect cards shown on the hub's no-machine home. Split out of
// HubComponents.swift so that large file stays focused on the project/lane/chat
// list rendering.

// MARK: - Quick-connect (no-machine home)

/// One-tap connect cards shown on the no-machine home for machines that are
/// reachable right now: online machines on the signed-in account, plus
/// previously-paired machines currently visible on the local network. Tapping a
/// whole card connects to it. When nothing is online it either shows a quiet
/// grayed note (signed in / has saved machines) or nothing at all.
struct HubQuickConnectSection: View {
  @EnvironmentObject private var syncService: SyncService
  @ObservedObject private var account = AccountService.shared
  var onConnectSuccess: () -> Void = {}

  @State private var connectingId: String?
  @State private var errorText: String?

  private var onlineAccountMachines: [AccountMachine] {
    account.machines.filter(\.online)
  }

  /// Saved paired machines that a live discovery currently corroborates as
  /// reachable — so a tap connects immediately rather than timing out.
  private var onlinePairedHosts: [DiscoveredSyncHost] {
    let live = syncService.discoveredHosts
    return syncService.savedReconnectHosts.filter { saved in
      live.contains { sameSyncHost(saved, $0) }
    }
  }

  private var hasTargets: Bool {
    !onlineAccountMachines.isEmpty || !onlinePairedHosts.isEmpty
  }

  private var showsEmptyNote: Bool {
    !hasTargets && (account.isSignedIn || !syncService.savedReconnectHosts.isEmpty)
  }

  var body: some View {
    Group {
      if hasTargets {
        VStack(spacing: 10) {
          ForEach(onlineAccountMachines) { machine in
            HubQuickConnectCard(
              title: machine.displayName,
              routeHint: machine.routeLabel ?? machineStatusHint(online: true),
              deviceSymbol: machineDeviceSymbol(deviceType: machine.deviceType, platform: machine.platform),
              isConnecting: connectingId == accountKey(machine),
              isDisabled: connectingId != nil
            ) { connectAccount(machine) }
          }
          ForEach(onlinePairedHosts) { host in
            HubQuickConnectCard(
              title: host.hostName,
              routeHint: machineStatusHint(online: true),
              deviceSymbol: machineDeviceSymbol(deviceType: nil, platform: nil),
              isConnecting: connectingId == savedKey(host),
              isDisabled: connectingId != nil
            ) { connectSaved(host) }
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
          Text("No machines online right now")
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

  private func connectAccount(_ machine: AccountMachine) {
    guard connectingId == nil else { return }
    connectingId = accountKey(machine)
    errorText = nil
    Task { @MainActor in
      guard let session = await AccountService.shared.pairingSession() else {
        errorText = "Your account session ended. Sign in again, then choose your Mac."
        connectingId = nil
        return
      }
      let connected = await syncService.pairWithAccountMachine(
        machine,
        accountToken: session.token,
        authorization: session.authorization
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
  var isConnecting: Bool
  var isDisabled: Bool
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      MachineRowView(
        deviceSymbol: deviceSymbol,
        title: title,
        routeHint: routeHint,
        online: true,
        statusPill: nil,
        affordance: isConnecting ? .connecting : .chevron,
        surface: .card
      )
      .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
    }
    .buttonStyle(ADEScaleButtonStyle())
    .disabled(isDisabled)
    .opacity(isDisabled && !isConnecting ? 0.5 : 1)
    .accessibilityLabel("Connect to \(title), online, \(routeHint)")
  }
}
