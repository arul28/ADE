import SwiftUI
import UIKit

// The two faces of the launch update gate (`ClientUpdateGate.swift`):
// - `PhoneUpdateBlockedScreen`: this phone is below its install's minimum;
//   it covers the whole app, with one way out (the update).
// - `FocusedMachineUpdateGate`: the computer the phone works on is below its
//   track's minimum; it covers that machine's project tabs only, with that
//   machine's update, and the way back to the other machines.

// MARK: - This phone

struct PhoneUpdateBlockedScreen: View {
  let requirement: PhoneUpdateRequirement
  @AppStorage("ade.colorScheme") private var colorSchemeRaw: String = ADEColorSchemeChoice.system.rawValue

  var body: some View {
    ZStack {
      ADEColor.pageBackground.ignoresSafeArea()
      ScrollView {
        VStack(spacing: 20) {
          Image(systemName: "arrow.down.app.fill")
            .font(.system(size: 52, weight: .regular))
            .foregroundStyle(ADEColor.accent)
            .accessibilityHidden(true)
          VStack(spacing: 10) {
            Text("Update ADE to keep working")
              .font(.title2.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .multilineTextAlignment(.center)
            Text("This version of ADE is no longer supported. Your work on your computers and in ADE Cloud is saved.")
              .font(.body)
              .foregroundStyle(ADEColor.textSecondary)
              .multilineTextAlignment(.center)
              .fixedSize(horizontal: false, vertical: true)
          }
          HStack(spacing: 10) {
            Text(requirement.currentLabel)
              .foregroundStyle(ADEColor.textSecondary)
            Image(systemName: "arrow.right")
              .foregroundStyle(ADEColor.textMuted)
              .accessibilityHidden(true)
            Text(requirement.requiredLabel)
              .foregroundStyle(ADEColor.textPrimary)
          }
          .font(.adeMono(14))
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .background(ADEKit.track, in: Capsule(style: .continuous))
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("You have \(requirement.currentLabel). ADE needs \(requirement.requiredLabel).")
          Button(requirement.buttonTitle) {
            UIApplication.shared.open(requirement.updateURL)
          }
          .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
          .padding(.top, 6)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 40)
        .frame(maxWidth: 480)
        .frame(maxWidth: .infinity)
        .containerRelativeFrame(.vertical, alignment: .center)
      }
      .scrollBounceBehavior(.basedOnSize)
    }
    .preferredColorScheme((ADEColorSchemeChoice(rawValue: colorSchemeRaw) ?? .system).preferredColorScheme)
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.isModal)
  }
}

// MARK: - The machine the phone works on

/// What blocks the focused machine, and what the phone can do about it.
struct MachineVersionBlock: Equatable {
  enum Remedy: Equatable {
    /// `machine.updateAndRestart` from the phone, with its impact confirmation.
    case updateFromPhone(MachineUpdateTarget)
    /// ADE Cloud updates the computer (`POST /cloud/instances/:id/update`).
    /// Nil id: the phone hasn't read the computer's row yet.
    case cloudUpdate(instanceId: String?)
    /// Its ADE is too old to take an update from another device.
    case updateOnMachine
  }

  let machineKey: String
  let machineName: String
  let requirement: DesktopUpdateRequirement
  let remedy: Remedy
}

/// The focused machine's block, or nil while it may keep working. A sleeping
/// (or offline) ADE Cloud computer is never blocked: reading it never wakes
/// it, and only doing does. A desktop stays blocked while its update is in
/// flight, so the card follows the restart instead of vanishing under it.
@MainActor
func focusedMachineVersionBlock(
  sync: SyncService,
  gate: ClientUpdateGateStore,
  updates: MachineUpdateStore
) -> MachineVersionBlock? {
  guard let key = sync.focusedMachineKey,
        let version = sync.hostAppVersionByMachineKey[key],
        let requirement = gate.desktopRequirement(forMachineVersion: version) else { return nil }
  let connected = sync.connectionState == .connected
  let name = sync.machineDisplayName
  if sync.cloudMachineFleetKeys.contains(key) {
    guard connected else { return nil }
    if let instance = sync.cloudServerInstance(fleetKey: key), !instance.isAwake { return nil }
    return MachineVersionBlock(
      machineKey: key,
      machineName: name,
      requirement: requirement,
      remedy: .cloudUpdate(instanceId: sync.cloudServerInstance(fleetKey: key)?.id)
    )
  }
  let updating = updates.updatingKeys.contains(key)
    || updates.checkingKeys.contains(key)
    || updates.attempts[key].map { describeMachineUpdateAttempt($0, live: connected, version: version, now: Date()).inFlight } == true
  guard connected || updating else { return nil }
  let remedy: MachineVersionBlock.Remedy = updates.canAsk(machineKey: key) || updating
    ? .updateFromPhone(MachineUpdateTarget(
      id: key,
      name: name,
      symbol: "desktopcomputer",
      version: version,
      targetVersion: requirement.targetVersion
    ))
    : .updateOnMachine
  return MachineVersionBlock(machineKey: key, machineName: name, requirement: requirement, remedy: remedy)
}

/// Over the project tabs while the focused machine must update.
struct FocusedMachineUpdateGate: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @ObservedObject private var gate = ClientUpdateGateStore.shared
  @ObservedObject private var updates = MachineUpdateStore.shared

  static let updateOrigin = "machine.versionGate"

  var body: some View {
    if let block = focusedMachineVersionBlock(sync: syncService, gate: gate, updates: updates) {
      MachineVersionBlockScreen(block: block, syncService: syncService)
        .machineUpdateConfirmation(origin: Self.updateOrigin)
        .id(block.machineKey)
    }
  }
}

struct MachineVersionBlockScreen: View {
  let block: MachineVersionBlock
  let syncService: SyncService
  @ObservedObject private var updates = MachineUpdateStore.shared
  @State private var cloudUpdating = false
  @State private var cloudResult: (ok: Bool, message: String)?

  var body: some View {
    ZStack {
      ADEColor.pageBackground.opacity(0.97)
        .ignoresSafeArea()
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Button {
            syncService.showProjectHub()
          } label: {
            Label("Machines", systemImage: "chevron.left")
              .font(.subheadline.weight(.semibold))
          }
          .buttonStyle(.plain)
          .foregroundStyle(ADEColor.accent)
          card
        }
        .padding(20)
        .frame(maxWidth: 560, alignment: .leading)
        .frame(maxWidth: .infinity)
      }
    }
    .accessibilityElement(children: .contain)
  }

  private var card: some View {
    VStack(alignment: .leading, spacing: 12) {
      Image(systemName: "arrow.triangle.2.circlepath")
        .font(.system(size: 22, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
        .accessibilityHidden(true)
      Text("\(block.machineName) runs an old version of ADE (\(block.requirement.currentVersion) → \(block.requirement.targetVersion)). Update it to keep working on it. Its lanes, chats and work are saved.")
        .font(.body)
        .foregroundStyle(ADEColor.textPrimary)
        .fixedSize(horizontal: false, vertical: true)
      remedy
    }
    .adeKitCard()
  }

  @ViewBuilder
  private var remedy: some View {
    switch block.remedy {
    case .updateFromPhone(let target):
      desktopUpdate(target)
    case .cloudUpdate(let instanceId):
      cloudUpdate(instanceId: instanceId)
    case .updateOnMachine:
      Text("Open ADE on \(block.machineName) and update it there.")
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder
  private func desktopUpdate(_ target: MachineUpdateTarget) -> some View {
    let key = block.machineKey
    let attempt = updates.attempts[key]
    let live = syncService.connectionState == .connected
    let status = attempt.map { describeMachineUpdateAttempt($0, live: live, version: target.version, now: updates.clock) }
    let sending = updates.updatingKeys.contains(key) || updates.checkingKeys.contains(key)
    if sending || status?.inFlight == true {
      MachineUpdateProgress(
        phase: sending ? .sending : .restarting,
        targetVersion: attempt?.pendingVersion ?? target.targetVersion
      )
      .padding(.vertical, 4)
    }
    if let status, !status.inFlight {
      ADESettingsNotice(
        message: status.message,
        tone: status.ok ? .ok : .crit,
        dismiss: { updates.dismissAttempt(machineKey: key) }
      )
    }
    if let url = attempt?.manualDownloadURL {
      Button("Download the update") { UIApplication.shared.open(url) }
        .buttonStyle(ADEKitButtonStyle(wide: true))
    }
    if !sending, status?.inFlight != true {
      Button("Update & restart") { updates.request([target], origin: FocusedMachineUpdateGate.updateOrigin) }
        .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
        .padding(.top, 4)
    }
  }

  @ViewBuilder
  private func cloudUpdate(instanceId: String?) -> some View {
    if let cloudResult {
      ADESettingsNotice(
        message: cloudResult.message,
        tone: cloudResult.ok ? .ok : .crit,
        dismiss: cloudResult.ok ? nil : { self.cloudResult = nil }
      )
    }
    if cloudResult?.ok != true {
      Button {
        Task { await runCloudUpdate(instanceId: instanceId) }
      } label: {
        HStack(spacing: 6) {
          if cloudUpdating { ProgressView().controlSize(.mini).tint(.white) }
          Text(cloudUpdating ? "Starting the update…" : "Update & restart")
        }
      }
      .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
      .disabled(cloudUpdating)
      .padding(.top, 4)
    }
  }

  private func runCloudUpdate(instanceId: String?) async {
    cloudUpdating = true
    defer { cloudUpdating = false }
    var id = instanceId
    if id == nil {
      // Not read yet: one read of the account's computers, then the update.
      await syncService.refreshCloudServerInstances()
      id = syncService.cloudServerInstance(fleetKey: block.machineKey)?.id
    }
    guard let id else {
      cloudResult = (false, "ADE Cloud couldn’t find this computer. Try again in a moment.")
      return
    }
    if let failure = await AccountCloudStore.shared.updateComputer(instanceId: id, using: syncService) {
      cloudResult = (false, failure)
      ADEHaptics.error()
    } else {
      cloudResult = (true, "\(block.machineName) is updating. It restarts on the new version in a few minutes; its lanes and chats come back with it.")
      ADEHaptics.success()
    }
  }
}

// MARK: - Fixture screens

#if DEBUG
/// `-adePreviewScreen update-gate-phone` (App Store) and
/// `update-gate-phone-testflight`: the real cover window over a stand-in app,
/// from a fixed requirement. Nothing is read from the server.
struct PhoneUpdateGatePreviewHost: View {
  var source: PhoneInstallSource = .appStore

  /// What `phoneUpdateRequirement` gives each install below its minimum.
  private var requirement: PhoneUpdateRequirement? {
    let minimum = ClientMinimum(
      desktop: .init(),
      ios: .init(appStoreVersion: "1.2.130", testFlightBuild: 10070, betaAppBuild: 20010),
      links: ClientMinimum.defaultLinks
    )
    let build = source == .betaApp ? "20001" : "10063"
    return phoneUpdateRequirement(source: source, marketingVersion: "1.2.129", build: build, minimum: minimum, storeVersion: "1.2.130")
  }

  var body: some View {
    VStack(spacing: 12) {
      Text("The app under the cover")
        .font(.title3.weight(.semibold))
      Text("Nothing here can be reached while the phone must update.")
        .foregroundStyle(ADEColor.textSecondary)
      TextField("A chat composer", text: .constant(""))
        .textFieldStyle(.roundedBorder)
        .padding(.horizontal, 40)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ADEColor.surfaceBackground.ignoresSafeArea())
    .task {
      // A beat after the first frame, as a read that lands after launch does.
      try? await Task.sleep(nanoseconds: 400_000_000)
      PhoneUpdateGateWindows.shared.show(requirement)
    }
  }
}

/// `-adePreviewScreen update-gate-machine`: the Studio (Stable 1.2.126,
/// minimum 1.2.127) over its project tabs, with the real "Update & restart"
/// confirmation from fixed answers (`MachineUpdateStore.useFixture`); nothing
/// is sent. `update-gate-machine-old` is a machine too old to update from the
/// phone; `update-gate-cloud` an ADE Cloud computer.
struct MachineVersionGatePreviewHost: View {
  enum Variant { case desktop, tooOld, cloud }
  var variant: Variant = .desktop
  @State private var ready = false
  @EnvironmentObject private var syncService: SyncService

  private var block: MachineVersionBlock {
    let requirement = desktopUpdateRequirement(
      currentVersion: "1.2.126",
      minimum: ClientMinimum.Desktop(stable: "1.2.127", beta: nil),
      latestStable: "1.2.128",
      latestBeta: nil
    )!
    switch variant {
    case .desktop:
      return MachineVersionBlock(
        machineKey: "machine:studio",
        machineName: "Arul’s Mac Studio",
        requirement: requirement,
        remedy: .updateFromPhone(MachineUpdateTarget(id: "machine:studio", name: "Arul’s Mac Studio", symbol: "desktopcomputer", version: "1.2.126", targetVersion: requirement.targetVersion))
      )
    case .tooOld:
      return MachineVersionBlock(machineKey: "machine:studio", machineName: "Arul’s Mac Studio", requirement: requirement, remedy: .updateOnMachine)
    case .cloud:
      return MachineVersionBlock(machineKey: "machine:cloud", machineName: "ADE Cloud · fix-login-redirect", requirement: requirement, remedy: .cloudUpdate(instanceId: nil))
    }
  }

  var body: some View {
    ZStack {
      ADEColor.surfaceBackground.ignoresSafeArea()
      if ready {
        MachineVersionBlockScreen(block: block, syncService: syncService)
          .machineUpdateConfirmation(origin: FocusedMachineUpdateGate.updateOrigin)
      }
    }
    .task {
      MachineUpdateStore.shared.useFixture(MachineUpdateStore.Fixture(
        latestStable: "1.2.128",
        latestBeta: "1.2.128-beta.2",
        impacts: [
          "machine:studio": MachineUpdateImpact(
            checked: true,
            chats: [.init(id: "c1", title: "Refactor the sync relay", projectName: "ADE", resumable: true, awaitingUser: false)],
            cliSessions: 0,
            terminals: 1,
            continueAfterRestart: true,
            cliSessionsReopen: false
          ),
        ]
      ))
      ready = true
    }
  }
}
#endif
