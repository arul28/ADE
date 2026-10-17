import SwiftUI

// Settings > Machines, the desktop machine model: one list in two sections.
// Connected machines (the primary one and the ones the user connected) keep a
// live link; available machines stay listed with Connect. Each machine opens
// its own page with its status, projects, accounts, connection help and the
// two remove actions.

// MARK: - Model

struct SettingsMachine: Identifiable, Equatable {
  enum Link: Equatable {
    /// The focused machine: full sync, serves the GitHub PR list and CTO.
    case primary(live: Bool, connecting: Bool)
    /// In the user's connected set, with its fleet state.
    case connected(MachineFleet.MachineState, gaveUp: Bool)
    /// Listed, not connected.
    case available
  }

  let id: String
  let name: String
  let symbol: String
  /// The fleet / saved-profile key (`machine:<device id>`), when the phone has
  /// a pairing for this machine.
  let machineKey: String?
  let account: AccountMachine?
  let link: Link
  /// Directory presence (account rows) or LAN discovery (saved rows).
  let online: Bool
  let isAsleep: Bool
  let lastSeenAt: Date?
  let hiddenIdentity: String
  /// The rest of the second line after the state word ("Local network · 11% battery").
  let detail: String?
  let projects: [RemoteRosterProject]

  var isPrimary: Bool {
    if case .primary = link { return true }
    return false
  }

  var isConnectedSet: Bool {
    if case .available = link { return false }
    return true
  }

  var isLive: Bool {
    switch link {
    case .primary(let live, _): return live
    case .connected(let state, _): return state == .live
    case .available: return false
    }
  }

  var isPaired: Bool { machineKey != nil }

  var gaveUp: Bool {
    if case .connected(_, true) = link { return true }
    return false
  }

  /// The row's second line.
  var subtitle: String {
    switch link {
    case .primary(let live, let connecting):
      if live { return detail ?? "Connected" }
      return connecting ? "Connecting…" : "Not reachable right now"
    case .connected(let state, let gaveUp):
      switch state {
      case .live: return detail ?? "Connected"
      case .connecting: return "Connecting…"
      case .offline: return gaveUp ? "Offline" : "Can’t reach it · retrying"
      case .paused: return "Over the \(MachineFleet.liveMachineLimit)-machine limit"
      case .inactive: return "Paused in the background"
      case .needsUpdate: return "Update ADE on this computer"
      case .needsAttention(let message): return message
      }
    case .available:
      if isAsleep { return ["Asleep", detail].compactMap { $0 }.joined(separator: " · ") }
      if online { return ["Online", detail].compactMap { $0 }.joined(separator: " · ") }
      return machineReachabilityText(isConnected: false, directoryOnline: false, lastSeenAt: lastSeenAt)
    }
  }

  var subtitleIsProblem: Bool {
    switch link {
    case .primary(let live, let connecting): return !live && !connecting
    case .connected(let state, _):
      switch state {
      case .offline, .needsUpdate, .needsAttention: return true
      default: return false
      }
    case .available: return false
    }
  }
}

/// Builds the machine list from the account directory, the saved pairings and
/// the fleet. Deduplicated by device identity; hidden machines stay out.
@MainActor
func settingsMachines(
  syncService: SyncService,
  account: AccountService,
  fleet: MachineFleet,
  hidden: HiddenMachineStore
) -> [SettingsMachine] {
  let focusedKey = syncService.focusedMachineKey
  let primaryLive = syncService.connectionState == .connected
  let primaryConnecting = syncService.connectionState == .connecting
  let primaryDisconnectedByUser = syncService.primaryDisconnectedByUser
  var seen = Set<String>()
  var result: [SettingsMachine] = []

  func pairedKey(identity: String?) -> String? {
    guard let identity = nonEmptyTrimmed(identity) else { return nil }
    let key = HiddenMachineStore.fleetKey(deviceId: identity)
    if key == focusedKey || fleet.machine(for: key) != nil { return key }
    return nil
  }

  func link(for key: String?) -> SettingsMachine.Link {
    guard let key else { return .available }
    if key == focusedKey {
      if primaryDisconnectedByUser { return .available }
      return .primary(live: primaryLive, connecting: primaryConnecting)
    }
    if let machine = fleet.machine(for: key), machine.isPinned {
      return .connected(machine.state, gaveUp: machine.gaveUp)
    }
    return .available
  }

  func projects(for key: String?) -> [RemoteRosterProject] {
    guard let key else { return [] }
    if key == focusedKey { return syncService.rosterProjects }
    return fleet.machine(for: key)?.projects ?? []
  }

  for machine in account.machines {
    let identity = nonEmptyTrimmed(machine.deviceId)
    let dedupeKey = (identity ?? machine.machineKey).lowercased()
    guard seen.insert(dedupeKey).inserted else { continue }
    let key = pairedKey(identity: identity)
    let lastSeen = machineLastSeenDate(epochMilliseconds: machine.lastSeenAt)
    let isAsleep = syncMachinePresence(
      connected: key == focusedKey && primaryLive,
      online: machine.online,
      sleepState: machine.sleepState,
      sleepStateAt: machineLastSeenDate(epochMilliseconds: machine.sleepStateAt),
      lastSeenAt: lastSeen
    ) == .asleep
    let power = syncMachinePowerReadingIsFresh(directoryOnline: machine.online, lastSeenAt: lastSeen)
      ? accountMachinePowerClause(machine.power)
      : nil
    // A connected machine names the route its link took, not the routes the
    // directory advertises (a relay link used to read "Local network").
    let route = key == focusedKey
      ? syncService.lastConnectedRouteKind?.label ?? machine.routeLabel
      : key.flatMap { fleet.machine(for: $0)?.routeKind?.label } ?? machine.routeLabel
    let detail = [route, power].compactMap { $0 }.joined(separator: " · ")
    result.append(SettingsMachine(
      id: "account-\(machine.machineKey)",
      name: machine.rowLabel,
      symbol: machineDeviceSymbol(deviceType: machine.deviceType, platform: machine.platform),
      machineKey: key,
      account: machine,
      link: link(for: key),
      online: machine.online,
      isAsleep: isAsleep,
      lastSeenAt: lastSeen,
      hiddenIdentity: identity ?? "account:\(machine.machineKey)",
      detail: detail.isEmpty ? nil : detail,
      projects: projects(for: key)
    ))
  }

  let discovered = syncService.discoveredHosts
  for host in syncService.savedReconnectHosts {
    let identity = nonEmptyTrimmed(host.hostIdentity)
    let dedupeKey = identity?.lowercased() ?? "name:\(host.hostName.lowercased())"
    guard seen.insert(dedupeKey).inserted else { continue }
    let key = pairedKey(identity: identity)
    result.append(SettingsMachine(
      id: "saved-\(host.id)",
      name: host.hostName,
      symbol: machineDeviceSymbol(deviceType: nil, platform: nil),
      machineKey: key,
      account: nil,
      link: link(for: key),
      online: discovered.contains { sameSyncHost(host, $0) },
      isAsleep: false,
      lastSeenAt: machineLastSeenDate(iso8601: host.lastResolvedAt),
      hiddenIdentity: identity ?? "name:\(host.hostName)",
      detail: key == focusedKey ? syncService.lastConnectedRouteKind?.label : nil,
      projects: projects(for: key)
    ))
  }

  return result.filter { $0.isConnectedSet || !hidden.isHidden(identity: $0.hiddenIdentity) }
}

/// Connected first (primary, then the rest by name), then available (online
/// first, then by name).
func settingsMachineSections(_ machines: [SettingsMachine]) -> (connected: [SettingsMachine], available: [SettingsMachine]) {
  let connected = machines.filter(\.isConnectedSet).sorted { lhs, rhs in
    if lhs.isPrimary != rhs.isPrimary { return lhs.isPrimary }
    return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
  }
  let available = machines.filter { !$0.isConnectedSet }.sorted { lhs, rhs in
    if lhs.online != rhs.online { return lhs.online }
    return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
  }
  return (connected, available)
}

// MARK: - Actions

struct SettingsMachineLimitPrompt: Identifiable {
  let target: SettingsMachine
  let candidates: [(key: String, name: String)]
  var id: String { target.id }
}

@MainActor
final class SettingsMachineController: ObservableObject {
  /// Rows with an action in flight. Per row: one machine connecting never
  /// locks the others.
  @Published var busyMachineIds: Set<String> = []
  /// Rows pairing next to the primary right now; each counts toward the limit.
  private var pairingAlongsideIds: Set<String> = []
  @Published var toast: ADEToastMessage?
  @Published var errors: [String: String] = [:]
  @Published var limitPrompt: SettingsMachineLimitPrompt?
  @Published var renaming: AccountMachine?

  private weak var syncService: SyncService?
  private weak var fleet: MachineFleet?

  func bind(syncService: SyncService, fleet: MachineFleet) {
    self.syncService = syncService
    self.fleet = fleet
  }

  /// A machine that is live disproves its own failure; failures of other
  /// machines stay (see `settingsMachineRowErrorsRetiring`).
  func retireErrors(liveMachineIds: [String]) {
    var next = errors
    for id in liveMachineIds {
      next = settingsMachineRowErrorsRetiring(next, attachedEntryId: id)
    }
    if next != errors { errors = next }
  }

  /// Connected machines right now: the primary plus the fleet's live set.
  func liveCount(_ machines: [SettingsMachine]) -> Int {
    machines.filter(\.isLive).count
  }

  func connect(_ machine: SettingsMachine) {
    guard let syncService, let fleet, !busyMachineIds.contains(machine.id), !machine.isConnectedSet else { return }
    errors[machine.id] = nil
    // With no primary attached the machine becomes primary (see
    // `performConnect`), so it does not count against the limit.
    // A pairing still in flight takes a slot too: two pairings started back to
    // back must not both slip under the limit and silently push a machine out.
    if syncService.primaryIsAttached, fleet.isAtLiveLimit(pending: pairingAlongsideIds.count) {
      var candidates = fleet.connectedMachinesLeastRecentFirst.map { (key: $0.machineKey, name: $0.name) }
      if machine.machineKey != nil, let primary = syncService.focusedMachineKey {
        candidates.append((key: primary, name: syncService.focusedMachineDisplayName))
      }
      guard !candidates.isEmpty else {
        // Only pairings still in flight fill the limit: nothing to disconnect yet.
        errors[machine.id] = "Wait for the machine that is pairing to finish, then connect this one."
        return
      }
      limitPrompt = SettingsMachineLimitPrompt(target: machine, candidates: candidates)
      return
    }
    performConnect(machine)
  }

  /// The user picked `key` to disconnect so `target` fits under the limit.
  func resolveLimit(disconnecting key: String, then target: SettingsMachine) {
    guard let syncService, let fleet else { return }
    limitPrompt = nil
    if key == syncService.focusedMachineKey {
      // The new machine takes the primary's place; the old primary leaves the
      // connected set.
      guard let targetKey = target.machineKey else {
        performConnect(target)
        return
      }
      run(target, success: "\(target.name) is primary") {
        fleet.markConnected(machineKey: targetKey)
        guard await syncService.switchFocus(toMachineKey: targetKey) else {
          fleet.stopKeepingLive(machineKey: targetKey)
          return false
        }
        fleet.stopKeepingLive(machineKey: key)
        return true
      }
      return
    }
    fleet.stopKeepingLive(machineKey: key)
    performConnect(target)
  }

  private func performConnect(_ machine: SettingsMachine) {
    guard let syncService, let fleet else { return }
    if let key = machine.machineKey {
      // No primary attached (none yet, or the user disconnected it): this
      // machine becomes primary instead of a fleet machine beside nothing.
      if !syncService.primaryIsAttached {
        run(machine, success: "\(machine.name) connected") {
          await syncService.switchFocus(toMachineKey: key)
        }
      } else {
        fleet.keepLive(machineKey: key)
        ADEHaptics.light()
      }
      return
    }
    // Never paired on this phone: pair through the account.
    guard let accountMachine = machine.account else { return }
    guard let authorization = AccountService.shared.currentPairingAuthorization else {
      errors[machine.id] = "Your account session ended. Sign in again, then connect."
      return
    }
    guard syncService.primaryIsAttached else {
      // No primary to keep: this machine becomes the primary.
      run(machine, success: "\(machine.name) connected") {
        await syncService.pairAccountMachineKeepingPrevious(accountMachine, authorization: authorization)
      }
      return
    }
    // A primary is up: pair next to it, like desktop. The primary's connection
    // is never touched, and the toast waits for the new machine's link.
    var live = false
    pairingAlongsideIds.insert(machine.id)
    run(machine, successToast: { live ? "\(machine.name) connected" : "\(machine.name) paired · connecting…" }) {
      let result = await syncService.pairAccountMachineAlongsidePrimary(accountMachine, authorization: authorization)
      // Paired (into the connected set) or failed: no longer pending either way,
      // so it is never counted twice while its link comes up.
      self.pairingAlongsideIds.remove(machine.id)
      switch result {
      case .failure(let failure):
        self.errors[machine.id] = failure.message
        return false
      case .success(let key):
        live = await fleet.connect(machineKey: key, timeout: .seconds(15))
        return true
      }
    }
  }

  func disconnect(_ machine: SettingsMachine) {
    guard let syncService, let fleet, let key = machine.machineKey else { return }
    switch machine.link {
    case .primary:
      // The most recently connected live machine becomes primary.
      if let next = fleet.connectedMachinesLeastRecentFirst.last(where: { $0.state == .live }) {
        run(machine, success: "\(next.name) is primary") {
          guard await syncService.switchFocus(toMachineKey: next.machineKey) else { return false }
          // The old primary is now a fleet machine: out of the connected set.
          fleet.stopKeepingLive(machineKey: key)
          return true
        }
      } else {
        syncService.disconnectForUserConnectionChange()
        ADEHaptics.light()
      }
    case .connected:
      fleet.stopKeepingLive(machineKey: key)
      ADEHaptics.light()
    case .available:
      break
    }
  }

  func makePrimary(_ machine: SettingsMachine) {
    guard let syncService, let key = machine.machineKey, !machine.isPrimary else { return }
    run(machine, success: "\(machine.name) is primary") {
      await syncService.switchFocusKeepingPrevious(toMachineKey: key)
    }
  }

  func retry(_ machine: SettingsMachine) {
    guard let syncService, let fleet else { return }
    errors[machine.id] = nil
    if machine.isPrimary {
      Task { await syncService.reconnectForUserConnectionChange() }
    } else if let key = machine.machineKey {
      fleet.retry(machineKey: key)
    }
  }

  /// Drops the pairing and hides the machine on this phone.
  func forget(_ machine: SettingsMachine) {
    guard let syncService else { return }
    syncService.forgetMachineOnThisPhone(
      machineKey: machine.machineKey,
      hiddenIdentity: machine.hiddenIdentity
    )
    toast = ADEToastMessage(text: "\(machine.name) forgotten on this phone")
    ADEHaptics.light()
  }

  func removeFromAccount(_ machine: SettingsMachine) {
    guard let accountMachine = machine.account else { return }
    run(machine, success: "\(machine.name) removed from your account") {
      do {
        try await AccountService.shared.removeMachineFromAccount(accountMachine)
      } catch {
        self.errors[machine.id] = error.localizedDescription
        return false
      }
      self.syncService?.forgetMachineOnThisPhone(
        machineKey: machine.machineKey,
        hiddenIdentity: machine.hiddenIdentity
      )
      return true
    }
  }

  private func run(_ machine: SettingsMachine, success: String, _ body: @escaping () async -> Bool) {
    run(machine, successToast: { success }, body)
  }

  /// `successToast` is read when the action finishes, so it can describe what
  /// actually happened (connected, or paired and still connecting).
  private func run(
    _ machine: SettingsMachine,
    successToast: @escaping () -> String,
    _ body: @escaping () async -> Bool
  ) {
    busyMachineIds.insert(machine.id)
    Task { @MainActor in
      let ok = await body()
      busyMachineIds.remove(machine.id)
      if ok {
        ADEHaptics.success()
        toast = ADEToastMessage(text: successToast())
      } else {
        ADEHaptics.error()
        if errors[machine.id] == nil, let syncService {
          errors[machine.id] = settingsMachineRowErrorMessage(
            attemptFailure: syncService.lastConnectAttemptFailure,
            lastError: syncService.lastError,
            fallback: "ADE could not reach \(machine.name). Try again."
          )
        }
      }
    }
  }
}

// MARK: - List

/// The Connected and Available sections of the Settings list.
struct SettingsMachineSections: View {
  let syncService: SyncService
  @ObservedObject var controller: SettingsMachineController
  @Binding var presentedSheet: SettingsPairSheetRoute?
  @ObservedObject private var account = AccountService.shared
  @ObservedObject private var hidden = HiddenMachineStore.shared
  @EnvironmentObject private var fleet: MachineFleet

  var body: some View {
    let machines = settingsMachines(syncService: syncService, account: account, fleet: fleet, hidden: hidden)
    let sections = settingsMachineSections(machines)
    VStack(alignment: .leading, spacing: ADEKit.sectionGap) {
      ADESettingsSection(
        "Connected",
        hint: "\(controller.liveCount(machines)) of \(MachineFleet.liveMachineLimit) live",
        trailing: { addMenu }
      ) {
        ADESettingsRows {
          if sections.connected.isEmpty {
            ADESettingsRow("No machine connected", hint: "Connect one below, or add one with +.")
          }
          ForEach(sections.connected) { machine in
            row(machine)
          }
        }
      }
      if !sections.available.isEmpty {
        ADESettingsSection("Available") {
          ADESettingsRows {
            ForEach(sections.available) { machine in
              row(machine)
            }
          }
        }
      }
    }
    .task { await account.loadMachines() }
    .onChange(of: machines.filter(\.isLive).map(\.id)) { _, liveIds in
      controller.retireErrors(liveMachineIds: liveIds)
    }
  }

  private func row(_ machine: SettingsMachine) -> some View {
    NavigationLink {
      SettingsMachinePage(syncService: syncService, controller: controller, machineId: machine.id)
    } label: {
      SettingsMachineRow(
        machine: machine,
        busy: controller.busyMachineIds.contains(machine.id),
        error: controller.errors[machine.id],
        onConnect: { controller.connect(machine) },
        onRetry: { controller.retry(machine) }
      )
    }
    .buttonStyle(ADEKitRowButtonStyle())
  }

  private var addMenu: some View {
    Menu {
      Button { presentedSheet = .scan } label: { Label("Scan pairing code", systemImage: "qrcode.viewfinder") }
      Button { presentedSheet = .discover } label: { Label("Find on this network", systemImage: "wifi") }
      Button { presentedSheet = .ssh } label: { Label("Connect over SSH", systemImage: "terminal") }
    } label: {
      Label("Add", systemImage: "plus")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .padding(.horizontal, 10)
        .frame(height: 28)
        .background(ADEKit.track, in: Capsule(style: .continuous))
    }
    .accessibilityLabel("Add machine")
  }
}

/// One machine row: icon, name (with "Primary"), state line, and one trailing
/// control (live dot, Connect, Retry or a spinner).
struct SettingsMachineRow: View {
  let machine: SettingsMachine
  var busy = false
  var error: String?
  var onConnect: () -> Void = {}
  var onRetry: () -> Void = {}

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: machine.symbol)
        .font(.system(size: 16))
        .foregroundStyle(machine.isConnectedSet ? ADEColor.textPrimary : ADEColor.textMuted)
        .frame(width: 24)
      VStack(alignment: .leading, spacing: 2) {
        HStack(spacing: 6) {
          Text(machine.name)
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          if machine.isPrimary {
            ADEKitTag(text: "Primary", tone: .accent)
          }
        }
        Text(machine.subtitle)
          .font(.system(size: 12.5))
          .foregroundStyle(machine.subtitleIsProblem ? ADEColor.warning : ADEColor.textSecondary)
          .lineLimit(1)
        if let error {
          Text(error)
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.danger)
            .lineLimit(3)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      Spacer(minLength: 8)
      trailing
      ADESettingsChevron()
    }
    .padding(.horizontal, ADEKit.inset)
    .padding(.vertical, 11)
    .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
    .opacity(machine.isConnectedSet || machine.online || machine.isPaired ? 1 : 0.62)
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder
  private var trailing: some View {
    if busy {
      ProgressView().controlSize(.small)
    } else {
      switch machine.link {
      case .primary(let live, let connecting):
        if live { ADEKitDot(tone: .ok, size: 7) }
        else if connecting { ProgressView().controlSize(.small) }
        else { retryButton }
      case .connected(let state, let gaveUp):
        switch state {
        case .live: ADEKitDot(tone: .ok, size: 7)
        case .connecting: ProgressView().controlSize(.small)
        case .offline where gaveUp: retryButton
        case .needsUpdate, .needsAttention: retryButton
        default: ADEKitDot(tone: .neutral, size: 7)
        }
      case .available:
        if machine.online || machine.isPaired {
          Button("Connect", action: onConnect)
            .buttonStyle(ADEKitButtonStyle())
        } else {
          Text("Offline")
            .font(.system(size: 12.5))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
    }
  }

  private var retryButton: some View {
    Button("Retry", action: onRetry)
      .buttonStyle(ADEKitButtonStyle(tone: .warn))
  }
}

// MARK: - Machine page

struct SettingsMachinePage: View {
  let syncService: SyncService
  @ObservedObject var controller: SettingsMachineController
  let machineId: String
  @ObservedObject private var account = AccountService.shared
  @ObservedObject private var hidden = HiddenMachineStore.shared
  @EnvironmentObject private var fleet: MachineFleet
  @Environment(\.dismiss) private var dismiss
  @State private var confirmForget = false
  @State private var confirmRemove = false

  var body: some View {
    let machine = settingsMachines(syncService: syncService, account: account, fleet: fleet, hidden: hidden)
      .first { $0.id == machineId }
    Group {
      if let machine {
        SettingsMachinePageContent(
          machine: machine,
          busy: controller.busyMachineIds.contains(machine.id),
          error: controller.errors[machine.id],
          actions: SettingsMachinePageActions(
            connect: { controller.connect(machine) },
            disconnect: { controller.disconnect(machine) },
            makePrimary: { controller.makePrimary(machine) },
            retry: { controller.retry(machine) },
            rename: machine.account.map { accountMachine in { controller.renaming = accountMachine } },
            forget: { confirmForget = true },
            removeFromAccount: machine.account == nil ? nil : { confirmRemove = true },
            accountsPage: settingsMachineCanManageAccounts(machine, fleet: fleet)
              ? { provider in
                SettingsProviderAccountsPage(
                  syncService: syncService,
                  provider: provider,
                  machineKey: machine.isPrimary ? nil : machine.machineKey
                )
              }
              : nil
          )
        )
        .confirmationDialog("Forget \(machine.name) on this phone?", isPresented: $confirmForget, titleVisibility: .visible) {
          Button("Forget on this phone", role: .destructive) {
            controller.forget(machine)
            dismiss()
          }
          Button("Cancel", role: .cancel) {}
        } message: {
          Text("The phone drops its pairing and hides the machine. Your account keeps it; connect again from the account list or with a pairing code.")
        }
        .confirmationDialog("Remove \(machine.name) from your account?", isPresented: $confirmRemove, titleVisibility: .visible) {
          Button("Remove from account", role: .destructive) {
            controller.removeFromAccount(machine)
            dismiss()
          }
          Button("Cancel", role: .cancel) {}
        } message: {
          Text("Every device on your account loses this machine. It can only rejoin when someone confirms it on that computer.")
        }
      } else {
        ADEEmptyStateView(symbol: "desktopcomputer", title: "Machine gone", message: "This machine is no longer on your list.")
      }
    }
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .adeToast($controller.toast)
    .sheet(item: $controller.renaming) { machine in
      SettingsMachineRenameSheet(machine: machine)
        .presentationDetents([.medium, .large])
    }
  }
}

struct SettingsMachinePageActions {
  var connect: () -> Void = {}
  var disconnect: () -> Void = {}
  var makePrimary: () -> Void = {}
  var retry: () -> Void = {}
  var rename: (() -> Void)?
  var forget: () -> Void = {}
  var removeFromAccount: (() -> Void)?
  /// The machine's AI accounts page; set only for a live machine that can
  /// answer account commands (see `settingsMachineCanManageAccounts`).
  var accountsPage: ((ProviderAccountProvider) -> SettingsProviderAccountsPage)?
}

/// A live machine whose accounts the phone can manage: the primary over its
/// main connection, any other over its roster connection.
@MainActor
func settingsMachineCanManageAccounts(_ machine: SettingsMachine, fleet: MachineFleet) -> Bool {
  switch machine.link {
  case .primary(let live, _):
    return live
  case .connected(.live, _):
    guard let key = machine.machineKey else { return false }
    return fleet.connection(for: key)?.supportsProviderAccounts == true
  default:
    return false
  }
}

/// The machine page body, as a pure view of one `SettingsMachine`.
struct SettingsMachinePageContent: View {
  let machine: SettingsMachine
  var busy = false
  var error: String?
  var actions = SettingsMachinePageActions()
  @State private var showsAllProjects = false

  /// Long project lists collapse to the first few and one "Show all" row.
  private static let collapsedProjectCount = 6

  var body: some View {
    let projects = showsAllProjects ? machine.projects : Array(machine.projects.prefix(Self.collapsedProjectCount))
    ScrollView {
      VStack(alignment: .leading, spacing: ADEKit.sectionGap) {
        VStack(alignment: .leading, spacing: 14) {
          header
          actionBar
          if let error {
            ADESettingsNotice(message: error, tone: .crit, actionTitle: "Retry", action: actions.retry)
          }
        }
        .adeKitCard()

        ADESettingsSection("Status") {
          ADESettingsRows {
            ForEach(statusFacts, id: \.label) { fact in
              ADESettingsValueRow(title: fact.label, value: fact.value)
            }
          }
        }

        ADESettingsSection("Projects", hint: machine.projects.isEmpty ? nil : "\(machine.projects.count) open") {
          ADESettingsRows {
            if machine.projects.isEmpty {
              ADESettingsRow(machine.isLive ? "No projects open on this machine." : "Projects show once the machine is connected.")
            }
            ForEach(projects) { project in
              ADESettingsRow(title: project.displayName, symbol: "folder") {
                Text(projectSummary(project))
                  .font(.adeMono(11))
                  .foregroundStyle(ADEColor.textMuted)
              }
            }
            if machine.projects.count > Self.collapsedProjectCount {
              ADESettingsActionRow(title: showsAllProjects ? "Show fewer" : "Show all \(machine.projects.count)") {
                showsAllProjects.toggle()
              }
            }
          }
        }

        if let inventory = machine.account?.inventory {
          ADESettingsSection("AI accounts") {
            ADESettingsRows {
              ForEach(inventory.providers, id: \.provider) { provider in
                if let page = actions.accountsPage, let kind = ProviderAccountProvider(rawValue: provider.provider) {
                  NavigationLink { page(kind) } label: { accountCountRow(provider, link: true) }
                    .buttonStyle(ADEKitRowButtonStyle())
                } else {
                  accountCountRow(provider, link: false)
                }
              }
              ADESettingsValueRow(title: "Presets", value: inventory.presets == 0 ? "Nothing custom" : "\(inventory.presets)")
            }
          }
        }

        ADESettingsSection("Connection", hint: offlineHelp) {
          ADESettingsRows {
            ForEach(connectionFacts, id: \.label) { fact in
              ADESettingsValueRow(title: fact.label, value: fact.value)
            }
          }
        }

        if machine.isPaired || actions.removeFromAccount != nil {
          ADESettingsRows {
            if machine.isPaired {
              ADESettingsActionRow(title: "Forget on this phone", destructive: true, action: actions.forget)
            }
            if let removeFromAccount = actions.removeFromAccount {
              ADESettingsActionRow(title: "Remove from account", destructive: true, action: removeFromAccount)
            }
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 36)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
  }

  private var header: some View {
    HStack(alignment: .center, spacing: 14) {
      Image(systemName: machine.symbol)
        .font(.system(size: 26, weight: .light))
        .foregroundStyle(ADEColor.textPrimary)
        .frame(width: 40, height: 40)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 8) {
          Text(machine.name)
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
          if let rename = actions.rename {
            Button(action: rename) {
              Image(systemName: "pencil")
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(ADEColor.textMuted)
                .adeTapTarget(visual: 20)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Rename")
          }
        }
        HStack(spacing: 6) {
          ADEKitDot(tone: machine.isLive ? .ok : (machine.subtitleIsProblem ? .warn : .neutral))
          Text(stateLine)
            .font(.system(size: 12.5))
            .foregroundStyle(machine.subtitleIsProblem ? ADEColor.warning : ADEColor.textSecondary)
            .lineLimit(2)
        }
      }
      Spacer(minLength: 0)
    }
  }

  private var stateLine: String {
    let state: String
    switch machine.link {
    case .primary(let live, _): state = live ? "Primary · connected" : "Primary · \(machine.subtitle.lowercased())"
    case .connected(let fleetState, _): state = fleetState == .live ? "Connected" : machine.subtitle
    case .available: return machine.subtitle
    }
    guard machine.isLive, let detail = machine.detail else { return state }
    return "\(state) · \(detail)"
  }

  @ViewBuilder
  private var actionBar: some View {
    HStack(spacing: 8) {
      if busy {
        ProgressView().controlSize(.small)
      } else if machine.isConnectedSet {
        if machine.gaveUp || machine.subtitleIsProblem {
          Button("Retry", action: actions.retry).buttonStyle(ADEKitButtonStyle(prominent: true))
        }
        Button("Disconnect", action: actions.disconnect).buttonStyle(ADEKitButtonStyle())
        if !machine.isPrimary {
          Button("Make primary", action: actions.makePrimary).buttonStyle(ADEKitButtonStyle())
        }
      } else {
        Button("Connect", action: actions.connect).buttonStyle(ADEKitButtonStyle(prominent: true))
      }
      Spacer(minLength: 0)
    }
  }

  private struct Fact { let label: String; let value: String }

  private var statusFacts: [Fact] {
    var facts: [Fact] = []
    if let account = machine.account {
      if let platform = nonEmptyTrimmed(account.platform) {
        facts.append(Fact(label: "Platform", value: settingsPlatformName(platform)))
      }
      if let install = account.installLabel {
        facts.append(Fact(label: "Install", value: install))
      }
      if let power = accountMachinePowerClause(account.power) {
        facts.append(Fact(label: "Power", value: power.prefix(1).uppercased() + power.dropFirst()))
      }
    }
    facts.append(Fact(
      label: "Last seen",
      value: machine.isLive
        ? "Now"
        : machineReachabilityText(isConnected: false, directoryOnline: false, lastSeenAt: machine.lastSeenAt)
          .replacingOccurrences(of: "Last seen ", with: "")
    ))
    return facts
  }

  private var connectionFacts: [Fact] {
    var facts: [Fact] = []
    if let endpoints = machine.account?.reachableEndpoints, !endpoints.isEmpty {
      let kinds = endpoints.map(\.kind.label)
      var seen = Set<String>()
      facts.append(Fact(label: "Routes", value: kinds.filter { seen.insert($0).inserted }.joined(separator: " · ")))
    }
    facts.append(Fact(label: "Paired on this phone", value: machine.isPaired ? "Yes" : "No"))
    return facts
  }

  private var offlineHelp: String? {
    guard !machine.isLive else { return nil }
    if case .connected(.needsUpdate, _) = machine.link {
      return "This computer runs an older ADE. Update ADE there, then tap Retry."
    }
    if machine.gaveUp {
      return "The phone stopped trying after several attempts. It tries again when you open the app, when the network changes, or when the machine comes online. Make sure ADE is open on that computer."
    }
    if !machine.online, machine.account != nil {
      return "Open ADE on that computer. Away from its network, connect both devices through Tailscale or the ADE relay."
    }
    return nil
  }

  private func accountCountRow(_ provider: AccountMachineInventoryProvider, link: Bool) -> some View {
    HStack(spacing: 12) {
      if let asset = providerAssetName(provider.provider) {
        ADEProviderMark(assetName: asset, size: 18)
          .frame(width: 22)
      }
      Text(ADESharedTheme.providerDisplayName(for: provider.provider) ?? provider.provider.capitalized)
        .font(.system(size: 15))
        .foregroundStyle(ADEColor.textPrimary)
      Spacer(minLength: 8)
      Text(provider.accounts == 1 ? "1 account" : "\(provider.accounts) accounts")
        .font(.system(size: 14))
        .foregroundStyle(ADEColor.textSecondary)
      if link { ADESettingsChevron() }
    }
    .padding(.horizontal, ADEKit.inset)
    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
  }

  private func projectSummary(_ project: RemoteRosterProject) -> String {
    let lanes = project.lanes.count == 1 ? "1 lane" : "\(project.lanes.count) lanes"
    guard project.runningCount > 0 else { return lanes }
    return "\(lanes) · \(project.runningCount) running"
  }
}

func settingsPlatformName(_ raw: String) -> String {
  switch raw.lowercased() {
  case "darwin", "macos", "mac": return "macOS"
  case "win32", "windows": return "Windows"
  case "linux": return "Linux"
  default: return raw.capitalized
  }
}
