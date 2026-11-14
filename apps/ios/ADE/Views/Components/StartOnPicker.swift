import SwiftUI

// Start on: the computer a new lane or chat of an account project starts on.
// The order is the desktop's (`resolveStartOn`), without "this computer":
// the computer this phone used last for the project, the other computers
// with a copy (the main copy first, then a live one, then the newest),
// online computers that need a copy first, and last the offline copies,
// which are never the default.

/// One computer in the Start-on list.
struct StartOnCandidate: Equatable, Identifiable {
  enum Kind: Equatable {
    /// It holds a copy and is online: live now, or a pick connects it.
    case copy
    /// It is online and holds no copy: the project is copied there first.
    case cloneFirst
    /// It holds a copy but is offline. A pick is not possible; Wake may be.
    case offline
  }

  /// The account machine key (`AccountMachine.machineKey`).
  let accountMachineKey: String
  /// The phone's key for the computer (the primary's key or a fleet key).
  /// Nil when this phone never paired it.
  let fleetKey: String?
  let name: String
  var symbol: String = "desktopcomputer"
  var kind: Kind
  var isMain: Bool
  /// Epoch ms the account last saw the copy, 0 when unknown.
  let lastSeenAt: Double
  /// It has a live link now. Otherwise a pick connects it first.
  var isLive: Bool
  /// Offline, but asleep recently: dialing it may wake it.
  var canWake: Bool = false
  /// "2 hours ago" for an offline computer.
  var lastSeen: String? = nil

  var id: String { accountMachineKey }
}

/// Pure: the Start-on order. `lastMachineKey` is the account machine key the
/// phone used last for this project; it goes first only when it can start.
func resolveStartOn(_ candidates: [StartOnCandidate], lastMachineKey: String?) -> [StartOnCandidate] {
  func rank(_ candidate: StartOnCandidate) -> Int {
    switch candidate.kind {
    case .copy: return candidate.accountMachineKey == lastMachineKey ? 0 : 1
    case .cloneFirst: return 2
    case .offline: return 3
    }
  }
  return candidates.enumerated().sorted { lhs, rhs in
    let (a, b) = (lhs.element, rhs.element)
    if rank(a) != rank(b) { return rank(a) < rank(b) }
    switch a.kind {
    case .copy:
      if a.isMain != b.isMain { return a.isMain }
      // A computer that is live costs no connection.
      if a.isLive != b.isLive { return a.isLive }
      if a.lastSeenAt != b.lastSeenAt { return a.lastSeenAt > b.lastSeenAt }
    case .cloneFirst:
      let order = a.name.localizedCaseInsensitiveCompare(b.name)
      if order != .orderedSame { return order == .orderedAscending }
    case .offline:
      if a.lastSeenAt != b.lastSeenAt { return a.lastSeenAt > b.lastSeenAt }
    }
    return lhs.offset < rhs.offset
  }.map(\.element)
}

/// Pure: the row a Start-on list preselects: the first one that can start.
func startOnDefault(_ ordered: [StartOnCandidate]) -> StartOnCandidate? {
  ordered.first { $0.kind != .offline }
}

/// Pure: the Start-on candidates of an account project from the account's
/// computers. `phoneKey` gives the phone's key for a computer it holds a
/// pairing for; `isLive` says whether that key has a live link now.
func startOnCandidateList(
  project: AccountProject,
  machines: [AccountMachine],
  phoneKey: (AccountMachine) -> String?,
  isLive: (String) -> Bool,
  now: Date = Date()
) -> [StartOnCandidate] {
  func awake(_ machine: AccountMachine) -> Bool {
    syncMachineWakeNeed(
      online: machine.online,
      lastSeenAt: machine.lastSeenAt.map { Date(timeIntervalSince1970: $0 / 1000) },
      sleepState: machine.sleepState,
      sleepStateAt: machine.sleepStateAt.map { Date(timeIntervalSince1970: $0 / 1000) },
      now: now
    ) == nil
  }
  var candidates: [StartOnCandidate] = []
  var withCopy = Set<String>()
  for entry in accountProjectCopyMachines(project, machines: machines) {
    // A copy of a computer that left the account cannot start anything.
    guard let machine = entry.machine else { continue }
    withCopy.insert(machine.machineKey)
    let key = phoneKey(machine)
    let live = key.map(isLive) ?? false
    let canStart = live || awake(machine)
    var candidate = StartOnCandidate(
      accountMachineKey: machine.machineKey,
      fleetKey: key,
      name: machine.presentedName,
      symbol: machineDeviceSymbol(deviceType: machine.deviceType, platform: machine.platform),
      kind: canStart ? .copy : .offline,
      isMain: entry.copy.isMain,
      lastSeenAt: entry.copy.lastSeenAt,
      isLive: live
    )
    if !canStart {
      let lastSeen = machine.lastSeenAt.map { Date(timeIntervalSince1970: $0 / 1000) }
      candidate.canWake = syncMachineWakeNeed(
        online: machine.online,
        lastSeenAt: lastSeen,
        sleepState: machine.sleepState,
        sleepStateAt: machine.sleepStateAt.map { Date(timeIntervalSince1970: $0 / 1000) },
        now: now
      ) == .asleep
      candidate.lastSeen = hubAccountRelativeTime(epochMs: machine.lastSeenAt, now: now)
    }
    candidates.append(candidate)
  }
  for machine in machines where !withCopy.contains(machine.machineKey) && isAccountComputer(machine) {
    let key = phoneKey(machine)
    let live = key.map(isLive) ?? false
    guard live || awake(machine) else { continue }
    candidates.append(StartOnCandidate(
      accountMachineKey: machine.machineKey,
      fleetKey: key,
      name: machine.presentedName,
      symbol: machineDeviceSymbol(deviceType: machine.deviceType, platform: machine.platform),
      kind: .cloneFirst,
      isMain: false,
      lastSeenAt: 0,
      isLive: live
    ))
  }
  return candidates
}

/// The computer this phone used last for each account project
/// (`ade.startOn.lastMachine.v1`: `{ accountProjectId: accountMachineKey }`).
enum StartOnMemory {
  static let defaultsKey = "ade.startOn.lastMachine.v1"
  /// Enough for every project of a large account; the oldest entries are not
  /// tracked, so a full map drops an arbitrary one.
  private static let maxEntries = 500

  static func lastMachine(for accountProjectId: String, defaults: UserDefaults = .standard) -> String? {
    (defaults.dictionary(forKey: defaultsKey) as? [String: String])?[accountProjectId]
  }

  static func remember(_ accountMachineKey: String, for accountProjectId: String, defaults: UserDefaults = .standard) {
    var map = (defaults.dictionary(forKey: defaultsKey) as? [String: String]) ?? [:]
    guard map[accountProjectId] != accountMachineKey else { return }
    map[accountProjectId] = accountMachineKey
    while map.count > maxEntries, let drop = map.keys.first(where: { $0 != accountProjectId }) {
      map.removeValue(forKey: drop)
    }
    defaults.set(map, forKey: defaultsKey)
  }
}

// MARK: - The phone's side

extension SyncService {
  /// The account project of the open project: the id its machine sent, then
  /// the copy table, then its GitHub address. Nil signed out, on an older
  /// server, or for a folder that is not on the account.
  func accountProjectForActiveProject() -> AccountProject? {
    guard let activeProject else { return nil }
    return accountProject(forCheckout: activeProject, onMachine: focusedMachineKey)
  }

  /// The resolver of the account list, built once for a pass over many
  /// folders. Nil when the account does not decide the projects.
  func accountProjectResolver() -> HubAccountResolver? {
    let store = AccountProjectStore.shared
    guard store.governsHub else { return nil }
    let account = AccountService.shared
    return hubAccountResolver(
      live: store.liveProjects,
      removed: store.removedProjects,
      merged: store.mergedTargets,
      accountMachineKey: { fleetKey in account.machine(forFleetKey: fleetKey)?.machineKey }
    )
  }

  /// The account project of one machine folder (`project` as `machineKey`
  /// lists it; nil = the primary). Pass a `resolver` for a pass over many
  /// folders; without one, a single folder is looked up in the list
  /// directly, with the resolver's order and no tables to build (views ask
  /// on every render).
  func accountProject(
    forCheckout project: MobileProjectSummary,
    onMachine machineKey: String?,
    resolver: HubAccountResolver? = nil
  ) -> AccountProject? {
    let store = AccountProjectStore.shared
    let identity = workRepoIdentity(owner: project.repoOwner, name: project.repoName)
    if let resolver {
      guard let id = accountProjectId(forCheckout: project, onMachine: machineKey, resolver: resolver),
            resolver.liveIds.contains(id) else { return nil }
      return store.liveProjects.first { $0.id == id }
    }
    guard store.governsHub else { return nil }
    let live = store.liveProjects
    if let sentId = project.accountProjectId, !sentId.isEmpty {
      let id = store.mergedTargets[sentId] ?? sentId
      return live.first { $0.id == id }
    }
    if let accountKey = AccountService.shared.machine(forFleetKey: machineKey ?? focusedMachineKey)?.machineKey,
       let byCopy = live.first(where: { candidate in
         candidate.copies.contains { $0.machineKey == accountKey && $0.checkoutId == project.id }
       }) {
      return byCopy
    }
    guard let identity else { return nil }
    return live.first { accountProjectGitHubIdentities($0).contains(identity) }
  }

  /// The id `resolver` gives one machine folder (nil = the primary): a live,
  /// removed or unknown project. Nil when nothing names it.
  func accountProjectId(
    forCheckout project: MobileProjectSummary,
    onMachine machineKey: String?,
    resolver: HubAccountResolver
  ) -> String? {
    resolver.accountProjectId(
      fleetKey: machineKey ?? focusedMachineKey,
      checkoutId: project.id,
      gitHubIdentity: workRepoIdentity(owner: project.repoOwner, name: project.repoName),
      sentId: project.accountProjectId
    )
  }

  /// The phone's key for an account computer: the primary's key, or the
  /// fleet key of a computer it holds a pairing for. Nil when never paired.
  func startOnPhoneKey(for machine: AccountMachine) -> String? {
    let account = AccountService.shared
    if let focused = focusedMachineKey, account.machine(forFleetKey: focused)?.machineKey == machine.machineKey {
      return focused
    }
    guard let deviceId = machine.deviceId, !deviceId.isEmpty else { return nil }
    let key = HiddenMachineStore.fleetKey(deviceId: deviceId)
    return machineFleet?.machine(for: key) != nil ? key : nil
  }

  /// A phone key has a live link now.
  func startOnIsLive(_ key: String) -> Bool {
    key == focusedMachineKey ? connectionState == .connected : (machineFleet?.isLive(key) ?? false)
  }

  /// The ordered Start-on list of an account project for this phone.
  func startOnCandidates(for project: AccountProject) -> [StartOnCandidate] {
    let candidates = startOnCandidateList(
      project: project,
      machines: AccountService.shared.machines,
      phoneKey: { self.startOnPhoneKey(for: $0) },
      isLive: { self.startOnIsLive($0) }
    )
    return resolveStartOn(candidates, lastMachineKey: StartOnMemory.lastMachine(for: project.id))
  }

  /// Connects a Start-on computer next to the primary and returns its phone
  /// key once its link is live. A computer this phone holds a pairing for
  /// joins the connected set (past the limit the oldest choice drops, and the
  /// Hub says so); one it never paired pairs through the account first. The
  /// primary's connection is never touched.
  func connectForStartOn(accountMachineKey: String) async -> Result<String, SyncPairAlongsideFailure> {
    func fail(_ message: String) -> Result<String, SyncPairAlongsideFailure> {
      .failure(SyncPairAlongsideFailure(message: message))
    }
    guard let machine = AccountService.shared.machines.first(where: { $0.machineKey == accountMachineKey }) else {
      return fail("That computer is not in your ADE account anymore.")
    }
    guard let fleet = machineFleet else { return fail("ADE could not reach \(machine.displayName).") }
    if let key = startOnPhoneKey(for: machine) {
      if key == focusedMachineKey {
        // The user picked this computer: bring its link back, as the
        // Reconnect button does, before saying it is out of reach.
        if connectionState != .connected { await reconnectIfPossible(userInitiated: true) }
        return connectionState == .connected
          ? .success(key)
          : fail("ADE could not reach \(machine.displayName). Check that ADE is running on it.")
      }
      return await fleet.connect(machineKey: key, timeout: .seconds(15))
        ? .success(key)
        : fail("ADE could not reach \(machine.displayName). Check that ADE is running on it.")
    }
    guard let authorization = AccountService.shared.currentPairingAuthorization else {
      return fail("Your account session ended. Sign in again, then try again.")
    }
    switch await pairAccountMachineAlongsidePrimary(machine, authorization: authorization) {
    case .failure(let failure):
      return .failure(failure)
    case .success(let key):
      return await fleet.connect(machineKey: key, timeout: .seconds(15))
        ? .success(key)
        : fail("Paired with \(machine.displayName), but it is not connected yet. Try again in a moment.")
    }
  }

  /// Connects an account computer (`connectForStartOn`), then copies the
  /// project onto it. Answers the new folder and the computer's phone key,
  /// or the sentence to show. Every "Put a copy" goes through here.
  func putAccountProjectCopy(
    _ project: AccountProject,
    onAccountMachine accountMachineKey: String
  ) async -> Result<(folder: MobileProjectSummary, phoneKey: String), SyncPairAlongsideFailure> {
    switch await connectForStartOn(accountMachineKey: accountMachineKey) {
    case .failure(let failure):
      return .failure(failure)
    case .success(let key):
      do {
        return .success((try await copyAccountProject(project, ontoMachine: key), key))
      } catch {
        return .failure(SyncPairAlongsideFailure(message: SyncUserFacingError.message(for: error)))
      }
    }
  }

  /// Copies an account project onto a connected computer that has no copy:
  /// a clone from GitHub into that computer's default project folder, sent
  /// over that computer's own link.
  func copyAccountProject(_ project: AccountProject, ontoMachine machineKey: String) async throws -> MobileProjectSummary {
    let parent = try await machineProjectDefaultParentDir(onMachine: machineKey)
    return try await cloneMachineProject(
      url: accountProjectCloneURL(project),
      name: "",
      parentDir: parent,
      onMachine: machineKey
    )
  }
}

// MARK: - Add project targets

/// A computer Add project can work on: one the phone has a live link to, or
/// an online account computer that a pick connects first.
struct ProjectAddTarget: Identifiable, Equatable {
  /// The phone key when known, else the account machine key.
  let id: String
  /// The phone's key for the computer (primary or fleet). Nil until paired.
  let phoneKey: String?
  let accountMachineKey: String?
  let name: String
  let symbol: String
  var isLive: Bool
}

/// Phones and tablets on the account are not computers a project lives on.
func isAccountComputer(_ machine: AccountMachine) -> Bool {
  let symbol = machineDeviceSymbol(deviceType: machine.deviceType, platform: machine.platform)
  return symbol != "iphone" && symbol != "ipad"
}

extension SyncService {
  /// The computers Add project offers: the primary, the other live computers,
  /// then the online account computers that are not connected.
  func projectAddTargets() -> [ProjectAddTarget] {
    let account = AccountService.shared
    var rows: [ProjectAddTarget] = []
    var seenAccountKeys = Set<String>()
    func add(phoneKey: String, name: String) {
      let accountMachine = account.machine(forFleetKey: phoneKey)
      if let key = accountMachine?.machineKey { seenAccountKeys.insert(key) }
      rows.append(ProjectAddTarget(
        id: phoneKey,
        phoneKey: phoneKey,
        accountMachineKey: accountMachine?.machineKey,
        name: accountMachine?.presentedName ?? name,
        symbol: accountMachine.map { machineDeviceSymbol(deviceType: $0.deviceType, platform: $0.platform) } ?? "desktopcomputer",
        isLive: true
      ))
    }
    if let focused = focusedMachineKey, connectionState == .connected {
      add(phoneKey: focused, name: focusedMachineDisplayName)
    }
    for machine in machineFleet?.machines ?? [] where machine.state == .live && machine.machineKey != focusedMachineKey {
      add(phoneKey: machine.machineKey, name: machine.name)
    }
    for machine in account.machines where machine.online && isAccountComputer(machine) && !seenAccountKeys.contains(machine.machineKey) {
      let phoneKey = startOnPhoneKey(for: machine)
      rows.append(ProjectAddTarget(
        id: phoneKey ?? machine.machineKey,
        phoneKey: phoneKey,
        accountMachineKey: machine.machineKey,
        name: machine.presentedName,
        symbol: machineDeviceSymbol(deviceType: machine.deviceType, platform: machine.platform),
        isLive: false
      ))
    }
    return rows
  }

  /// The projects a computer the phone has a live link to reports now. Nil
  /// for a computer with no live link (its last roster is old).
  func liveRoster(forPhoneKey phoneKey: String) -> [RemoteRosterProject]? {
    if phoneKey == focusedMachineKey {
      return connectionState == .connected ? rosterProjects : nil
    }
    guard let fleet = machineFleet?.machines.first(where: { $0.machineKey == phoneKey }), fleet.state == .live else { return nil }
    return fleet.projects
  }

  /// A live computer already has a folder of this project, though the
  /// account does not list the copy yet (a project added back after a
  /// removal lists only the copy that added it).
  func liveRosterHasFolder(of project: AccountProject, phoneKey: String) -> Bool {
    guard let roster = liveRoster(forPhoneKey: phoneKey) else { return false }
    let identity = project.host == "github.com" ? "\(project.owner)/\(project.name)".lowercased() : nil
    return roster.contains { folder in
      folder.accountProjectId == project.id
        || (identity != nil && hubGitHubRepoIdentity(originUrl: folder.repoOriginUrl) == identity)
    }
  }

  /// The `onMachine` value for a phone key: nil for the primary.
  /// "Use for new lanes": connects the computer when it is not live, then
  /// asks its brain to make `checkoutId` the folder its new lanes start from
  /// (`projects.setMainCheckout`, runtime scope, on that computer only). The
  /// account list shows the change after the brain's next publish, which the
  /// brain sends at once.
  func setAccountProjectMainFolder(
    checkoutId: String,
    onAccountMachine accountMachineKey: String
  ) async -> Result<Void, SyncPairAlongsideFailure> {
    let machineName = AccountService.shared.machines.first { $0.machineKey == accountMachineKey }?.displayName ?? "that computer"
    switch await connectForStartOn(accountMachineKey: accountMachineKey) {
    case .failure(let failure):
      return .failure(failure)
    case .success(let key):
      let callKey = machineCallKey(key)
      guard machineAllowsPhoneAction(accountProjectSetMainAction, onMachine: callKey) else {
        return .failure(SyncPairAlongsideFailure(message: "Update ADE on \(machineName) to change this from your phone."))
      }
      do {
        let raw = try await sendMachineCommand(action: accountProjectSetMainAction, args: ["checkoutId": checkoutId], onMachine: callKey)
        let answer = raw as? [String: Any] ?? [:]
        if answer["ok"] as? Bool == true {
          // Saved on the computer, but your account does not have it yet.
          if answer["published"] as? Bool == false {
            return .failure(SyncPairAlongsideFailure(message: "\(machineName) saved this, but could not send it to your ADE account yet. It tries again on its own."))
          }
          return .success(())
        }
        let message = (answer["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }
          ?? "\(machineName) did not change the folder for new lanes."
        return .failure(SyncPairAlongsideFailure(message: message))
      } catch {
        return .failure(SyncPairAlongsideFailure(message: SyncUserFacingError.message(for: error)))
      }
    }
  }

  func machineCallKey(_ phoneKey: String?) -> String? {
    guard let phoneKey, phoneKey != focusedMachineKey else { return nil }
    return phoneKey
  }
}

/// The brain action behind "Use for new lanes". Older brains lack it.
let accountProjectSetMainAction = "projects.setMainCheckout"

/// The HTTPS clone address of an account project.
func accountProjectCloneURL(_ project: AccountProject) -> String {
  "https://\(project.host)/\(project.owner)/\(project.name).git"
}

/// Hosts a sheet with a Start-on list: it reads the account's computers once
/// when the sheet opens, and the parent's content builds the rows again when
/// they change, so a computer that went offline shows as offline.
struct StartOnAccountHost<Content: View>: View {
  @ObservedObject private var account = AccountService.shared
  @ViewBuilder let content: () -> Content

  var body: some View {
    content()
      .task { await account.loadMachines() }
  }
}

// MARK: - The list

/// The Start-on list: one copy row per computer, the chosen one checked.
/// A row that is not live connects when picked; an offline row cannot be
/// picked, and offers Wake when the computer is only asleep.
struct StartOnSection: View {
  let candidates: [StartOnCandidate]
  let selectedId: String?
  /// Computers the phone is connecting to or copying onto now.
  let busyIds: Set<String>
  let onPick: (StartOnCandidate) -> Void
  let onWake: (StartOnCandidate) -> Void

  var body: some View {
    ADESettingsSection("Start on") {
      if candidates.allSatisfy({ $0.kind == .offline }) {
        Text("No computer can start this. Wake one or connect another computer.")
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 4)
      }
      ADESettingsRows {
        ForEach(candidates) { candidate in
          row(candidate)
        }
      }
    }
  }

  @ViewBuilder
  private func row(_ candidate: StartOnCandidate) -> some View {
    let busy = busyIds.contains(candidate.id)
    let selected = selectedId == candidate.id
    let content = HubCopyRow(
      name: candidate.name,
      reach: reach(candidate, busy: busy),
      detail: detail(candidate),
      symbol: candidate.symbol
    ) {
      if busy {
        ProgressView().controlSize(.small)
      } else if candidate.kind == .offline {
        if candidate.canWake {
          Button("Wake") { onWake(candidate) }
            .buttonStyle(ADEKitButtonStyle())
            .accessibilityLabel("Wake \(candidate.name)")
        }
      } else if selected {
        Image(systemName: "checkmark")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.accent)
      }
    }
    if candidate.kind == .offline {
      content
    } else {
      Button { onPick(candidate) } label: { content }
        .buttonStyle(ADEKitRowButtonStyle())
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
  }

  private func reach(_ candidate: StartOnCandidate, busy: Bool) -> HubCopyReach {
    if busy { return candidate.kind == .cloneFirst ? .copying : .connecting }
    switch candidate.kind {
    case .offline: return .offline(lastSeen: candidate.lastSeen)
    case .copy, .cloneFirst: return candidate.isLive ? .live : .online
    }
  }

  /// The account marks the main copy of each computer, and the list holds one
  /// copy for each computer. "Main copy" tells rows apart only when a listed
  /// copy is not its computer's main one.
  private var mainMarkTellsApart: Bool {
    let copies = candidates.filter { $0.kind != .cloneFirst }
    return copies.contains { $0.isMain } && copies.contains { !$0.isMain }
  }

  private func detail(_ candidate: StartOnCandidate) -> String? {
    switch candidate.kind {
    case .copy: return candidate.isMain && mainMarkTellsApart ? "Main copy" : nil
    case .cloneFirst: return "Copies the project first"
    case .offline: return nil
    }
  }
}
