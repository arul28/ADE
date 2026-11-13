import Foundation
import OSLog

// Lanes of the focused repository on the other paired machines, the way the
// desktop shows every machine in every tab (`laneMachineRouting.ts`).
//
// A lane owns its machine. On the phone a lane of another machine keeps a
// namespaced id (`workRemoteLaneId`: `fleet|<machineKey>|<laneId>`) in every
// screen, and every command that names it goes to that machine:
// `routeOrStripFleetTarget` takes the tag off the args, sends the command to
// the lane's machine in the project that machine holds, and tags the lane ids
// of the reply again (`syncTagRemoteLaneIds`). A command for such a lane is
// never queued and never falls through to the focused machine: the same lane
// id can name a different lane there.
//
// Lanes of other machines live in memory only. `ade.db` replicates the focused
// machine's project and has no machine column.

/// A command whose args name lanes of one other machine.
struct SyncRemoteLaneTarget {
  let machineKey: String
  /// The args with the machine tag taken off every lane id.
  let args: [String: Any]
}

/// Keys whose values are lane ids, in command args and in host replies.
private let syncLaneIdKeys: Set<String> = [
  "laneId", "baseLaneId", "sourceLaneId", "targetLaneId",
]
private let syncLaneIdListKeys: Set<String> = ["laneIds"]

/// The machine a command's lane ids name, with the tags taken off. Nil when no
/// arg is a namespaced lane id. Throws when the args name lanes of two
/// machines: no host can serve that.
func syncRemoteLaneTarget(args: [String: Any]) throws -> SyncRemoteLaneTarget? {
  var machineKey: String?
  var stripped = args
  func take(_ value: String) throws -> String {
    guard let parsed = workParseRemoteLaneId(value) else { return value }
    if let machineKey, machineKey != parsed.machineKey {
      throw NSError(domain: "ADE", code: 26, userInfo: [NSLocalizedDescriptionKey: "These lanes are on different machines."])
    }
    machineKey = parsed.machineKey
    return parsed.laneId
  }
  for (key, value) in args {
    if syncLaneIdKeys.contains(key), let text = value as? String {
      stripped[key] = try take(text)
    } else if syncLaneIdListKeys.contains(key), let list = value as? [String] {
      stripped[key] = try list.map(take)
    }
  }
  guard let machineKey else { return nil }
  return SyncRemoteLaneTarget(machineKey: machineKey, args: stripped)
}

/// A host reply with every lane id of `machineKey` namespaced: the lane-id
/// keys everywhere, and the `id` of every lane object (one that has both
/// `laneType` and `worktreePath`). Already namespaced ids stay as they are.
func syncTagRemoteLaneIds(in value: Any, machineKey: String) -> Any {
  func tag(_ id: String) -> String {
    guard !id.isEmpty, workParseRemoteLaneId(id) == nil else { return id }
    return workRemoteLaneId(machineKey: machineKey, laneId: id)
  }
  if let list = value as? [Any] {
    return list.map { syncTagRemoteLaneIds(in: $0, machineKey: machineKey) }
  }
  guard var object = value as? [String: Any] else { return value }
  let isLane = object["laneType"] != nil && object["worktreePath"] != nil
  for (key, child) in object {
    if syncLaneIdKeys.contains(key), let text = child as? String {
      object[key] = tag(text)
    } else if syncLaneIdListKeys.contains(key), let list = child as? [String] {
      object[key] = list.map(tag)
    } else if isLane, key == "id", let text = child as? String {
      object[key] = tag(text)
    } else if child is [Any] || child is [String: Any] {
      object[key] = syncTagRemoteLaneIds(in: child, machineKey: machineKey)
    }
  }
  return object
}

/// A lane row built from roster data only (a machine that is not live, or a
/// reply with no snapshots): no sessions are known.
let syncRemoteLaneEmptyRuntime = LaneRuntimeSummary(
  bucket: "none", runningCount: 0, awaitingInputCount: 0, endedCount: 0, sessionCount: 0
)

/// Account computers the open project already tried to pair this app run.
@MainActor private var syncAutoPairedAccountMachines = Set<String>()
@MainActor private var syncAutoPairRunning = false
private let syncFleetAutoPairLog = Logger(subsystem: "com.ade.ios", category: "fleet")

// MARK: - Lanes of other machines (see SyncService+RemoteLanes.swift)

extension SyncService {
  /// Every other paired machine's checkout of the focused repository, as the
  /// fleet's rosters report it. The same rule the Work tab and the Hub use.
  func remoteReposForActiveProject() -> [WorkRemoteMachineRepo] {
    guard let fleet = machineFleet, !fleet.machines.isEmpty, let activeProject else { return [] }
    let identity = workRepoIdentity(owner: activeProject.repoOwner, name: activeProject.repoName)
      ?? workRepoIdentity(originUrl: rosterProject(for: activeProject)?.repoOriginUrl)
    return workRemoteMachineRepos(
      machines: fleet.machines,
      identity: identity,
      folderKey: hubProjectFolderKey(activeProject.rootPath, displayName: activeProject.displayName),
      account: accountCopiesOfActiveProject()
    )
  }

  /// The focused project's account project, for `workRemoteMachineRepos`: its
  /// copies match after a GitHub rename, the main copy wins, and an address
  /// on another host does not match. Every caller passes it, so the Work
  /// list, lane links and new lanes use the same folder. Nil for a folder
  /// that is not on the account.
  func accountCopiesOfActiveProject() -> WorkAccountCopies? {
    guard let project = accountProjectForActiveProject() else { return nil }
    let copies = project.copies
    let account = AccountService.shared
    return WorkAccountCopies(host: project.host) { fleetKey in
      guard let accountKey = account.machine(forFleetKey: fleetKey)?.machineKey else { return (ids: [], main: nil) }
      let onMachine = copies.filter { $0.machineKey == accountKey }
      return (ids: Set(onMachine.map(\.checkoutId)), main: onMachine.first(where: \.isMain)?.checkoutId)
    }
  }

  /// The primary (focused) machine's name for machine lists and chips: the
  /// account's name for it ("windows") when it has one, as Settings shows it,
  /// else the computer's own host name.
  var focusedMachineDisplayName: String {
    focusedMachineAccountName ?? "This machine"
  }

  /// The word after the focused machine's name on its rows in a project's
  /// lists, nil while live (`MachineFleet.Machine.rowStateWord`).
  var focusedMachineRowStateWord: String? {
    switch connectionState {
    case .connected: return nil
    case .connecting: return "connecting"
    case .disconnected, .error: return "offline"
    }
  }

  /// `focusedMachineDisplayName` without the placeholder: nil when the phone
  /// knows no name for the primary machine.
  var focusedMachineAccountName: String? {
    accountMachinePresentationName(
      hostIdentity: activeHostProfile?.machineIdentity,
      fallback: nonEmptyTrimmed(hostName) ?? activeHostProfile?.hostName,
      machines: AccountService.shared.machines
    )
  }

  /// The paired machines (fleet keys) with a copy of the open project: the
  /// account's copies first (the main copy first), then every machine whose
  /// roster lists the repository. The focused machine is left out; it has its
  /// own connection. Empty while no project is open. The fleet keeps these
  /// live, so opening a project shows every machine's lanes and chats with no
  /// pick.
  func activeProjectCopyMachineKeys() -> [String] {
    guard activeProjectId != nil, machineFleet != nil else { return [] }
    let focused = focusedMachineKey
    var keys: [String] = []
    if let project = accountProjectForActiveProject() {
      let machines = AccountService.shared.machines
      let copies = project.copies.filter(\.isMain) + project.copies.filter { !$0.isMain }
      for copy in copies {
        guard let machine = machines.first(where: { $0.machineKey == copy.machineKey }),
              let key = startOnPhoneKey(for: machine), key != focused else { continue }
        keys.append(key)
      }
    }
    keys += remoteReposForActiveProject().map(\.machineKey).filter { $0 != focused }
    var seen = Set<String>()
    return keys.filter { seen.insert($0).inserted }
  }

  /// Pairs, next to the primary, each online account computer that holds a
  /// copy of the open project and that this phone never paired: the same
  /// silent account pairing Start on uses. Once per computer per app run,
  /// one at a time, and only while the live limit has room. The fleet then
  /// keeps it live with the other copies. A failure stays quiet: the
  /// computer is listed in Settings with its state.
  func connectActiveProjectAccountCopies() {
    guard !syncAutoPairRunning,
          let project = accountProjectForActiveProject(),
          let fleet = machineFleet,
          let authorization = AccountService.shared.currentPairingAuthorization
    else { return }
    let machines = AccountService.shared.machines
    var seen = Set<String>()
    let candidates = project.copies.compactMap { copy -> AccountMachine? in
      guard let machine = machines.first(where: { $0.machineKey == copy.machineKey }),
            machine.online,
            syncNonEmpty(machine.deviceId) != nil,
            startOnPhoneKey(for: machine) == nil,
            !syncAutoPairedAccountMachines.contains(machine.machineKey),
            seen.insert(machine.machineKey).inserted
      else { return nil }
      return machine
    }
    guard !candidates.isEmpty else { return }
    syncAutoPairRunning = true
    Task { @MainActor in
      defer { syncAutoPairRunning = false }
      for machine in candidates {
        guard fleet.hasRoomForAnotherLiveMachine else { break }
        syncAutoPairedAccountMachines.insert(machine.machineKey)
        if case .failure(let failure) = await pairAccountMachineAlongsidePrimary(machine, authorization: authorization) {
          syncFleetAutoPairLog.notice("auto pair of a project copy's computer failed: \(failure.message, privacy: .public)")
        }
      }
    }
  }

  /// `machineKey`'s checkout of the focused repository, if it has one.
  func remoteLaneRepo(machineKey: String) -> WorkRemoteMachineRepo? {
    remoteReposForActiveProject().first { $0.machineKey == machineKey }
  }

  /// `remoteLaneRepo`, or the error every lane route of another machine
  /// fails closed with.
  func requireRemoteLaneRepo(machineKey: String) throws -> WorkRemoteMachineRepo {
    guard let repo = remoteLaneRepo(machineKey: machineKey) else {
      throw NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: "This lane's machine no longer lists this project."])
    }
    return repo
  }

  /// The lane snapshots of one other machine's checkout, with namespaced
  /// ids. Throws when that machine is not live.
  func fetchRemoteLaneSnapshots(repo: WorkRemoteMachineRepo, timeoutNanoseconds: UInt64) async throws -> [LaneListSnapshot] {
    let args: [String: Any] = [
      "includeArchived": true,
      "includeStatus": true,
      "includeConflictStatus": true,
    ]
    let raw = try await sendCommand(
      action: "lanes.refreshSnapshots",
      args: args,
      timeoutNanoseconds: timeoutNanoseconds,
      targetProjectId: repo.markedProjectId,
      targetProjectRootPath: repo.rootPath,
      fallbackToActiveProjectScope: false
    )
    // The router tagged the reply's lane ids (a `lanes.*` reply from another
    // machine).
    let payload = try decodeHydrationPayload(raw, as: LaneRefreshPayload.self, domainLabel: "lane", decoder: decoder)
    if let snapshots = payload.snapshots { return snapshots }
    return payload.lanes.map { LaneListSnapshot(lane: $0, runtime: syncRemoteLaneEmptyRuntime) }
  }
}

// MARK: - PRs of other machines (see Views/PRs/PrRemoteMachines.swift)

extension SyncService {
  /// One other machine's PR rows for its checkout of the focused repository,
  /// with namespaced lane ids. Throws when that machine is not live.
  func fetchRemotePullRequestRows(repo: WorkRemoteMachineRepo, timeoutNanoseconds: UInt64) async throws -> [PrRemoteSummaryRow] {
    let raw = try await sendCommand(
      action: "prs.list",
      args: [:],
      timeoutNanoseconds: timeoutNanoseconds,
      targetProjectId: repo.markedProjectId,
      targetProjectRootPath: repo.rootPath,
      fallbackToActiveProjectScope: false
    )
    // The router tagged the reply's lane ids (a `prs.*` reply from another
    // machine).
    return try decodeHydrationPayload(raw, as: [PrRemoteSummaryRow].self, domainLabel: "pull request", decoder: decoder)
  }

  /// `preflightCreateLaneFromPrBranch` on the machine the lane would be made on.
  func preflightCreateLaneFromPrBranch(
    repoOwner: String,
    repoName: String,
    githubPrNumber: Int,
    on machine: PrLaneMachine
  ) async throws -> PrAutoMapPreflightResult {
    guard let target = machine.target else {
      return try await preflightCreateLaneFromPrBranch(repoOwner: repoOwner, repoName: repoName, githubPrNumber: githubPrNumber)
    }
    return try await sendDecodableCommand(
      action: "prs.preflightCreateLaneFromPrBranch",
      args: ["repoOwner": repoOwner, "repoName": repoName, "githubPrNumber": githubPrNumber],
      targetProjectId: target.projectId,
      targetProjectRootPath: target.rootPath,
      fallbackToActiveProjectScope: false,
      as: PrAutoMapPreflightResult.self
    )
  }

  /// `createLaneFromPrBranch` on the chosen machine. The new lane and the PR
  /// row live there; the reply's lane ids come back namespaced.
  @discardableResult
  func createLaneFromPrBranch(
    repoOwner: String,
    repoName: String,
    githubPrNumber: Int,
    on machine: PrLaneMachine
  ) async throws -> PrAutoMapCreateResult {
    guard let target = machine.target else {
      return try await createLaneFromPrBranch(repoOwner: repoOwner, repoName: repoName, githubPrNumber: githubPrNumber)
    }
    return try await sendDecodableCommand(
      action: "prs.createLaneFromPrBranch",
      args: ["repoOwner": repoOwner, "repoName": repoName, "githubPrNumber": githubPrNumber],
      targetProjectId: target.projectId,
      targetProjectRootPath: target.rootPath,
      fallbackToActiveProjectScope: false,
      as: PrAutoMapCreateResult.self
    )
  }
}
