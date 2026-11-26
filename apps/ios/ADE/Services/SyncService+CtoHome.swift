import Foundation

// The project's one CTO lives on one machine, its "home" (account setting
// `cto.homeMachine` under `repo:<origin>`, shared with the desktop's
// `ctoHomeMachine.ts`). The phone sends every CTO call there. There is no
// default: until the account has a home record the person picks one, and when
// the home is another machine that is not live, CTO calls fail closed:
// answering from the primary machine's CTO would split the one CTO in two.

/// Why a CTO home cannot be shared, in the words every CTO surface shows.
let ctoHomeNeedsGitOriginMessage = "This project has no git origin, so its CTO home can't be shared."

/// What the machine that is now the CTO's home took from the account copy when
/// the person moved it (`cto.adoptAccountCopy`).
struct CtoAccountCopyAdoption: Equatable {
  /// True when that machine took the CTO's memory and turns from the copy.
  let restored: Bool
  /// The machine the copy came from, when it was restored.
  let fromName: String?
  let savedAt: String?
}

/// The CTO screen's asleep copy: an ADE Cloud home sleeps and only ADE on a
/// computer wakes it; any other home is offline and moving keeps its notes and
/// recent chat.
@MainActor
func ctoHomeOfflineCopy(sync: SyncService) -> (line: String, message: String) {
  guard sync.ctoHomeIsCloudComputer else {
    let name = nonEmptyTrimmed(sync.ctoHomeMachineName) ?? sync.focusedMachineDisplayName
    return (
      "\(name) is offline",
      "Pick another home to keep going; its notes and recent chat come along."
    )
  }
  return (
    "Asleep on ADE Cloud",
    "Its notes and recent chat come along. Tap Reconnect to wake it, or pick another home."
  )
}

extension SyncService {
  /// Git origin of the focused project, the key of its account repo settings.
  var activeProjectGitOriginUrl: String? {
    guard let activeProject else { return nil }
    if let origin = nonEmptyTrimmed(rosterProject(for: activeProject)?.repoOriginUrl) { return origin }
    guard let owner = nonEmptyTrimmed(activeProject.repoOwner),
          let name = nonEmptyTrimmed(activeProject.repoName) else { return nil }
    return "https://github.com/\(owner)/\(name)"
  }

  /// Whether the account answered for this project and names no home: there is
  /// no default, so the CTO screen asks the person to pick one. False whenever
  /// the answer is unknown (an older brain, or not read yet), which keeps the
  /// primary machine as before.
  var ctoHomeNeedsChoice: Bool { ctoHomeProjectId == activeProjectId && !ctoHomeChosen }

  /// Whether the home is an ADE Cloud computer: it sleeps when idle instead of
  /// being offline, and Reconnect wakes it through the server.
  var ctoHomeIsCloudComputer: Bool { nonEmptyTrimmed(ctoHomeCloudInstanceId) != nil }

  /// Whether the CTO's home cannot be reached right now. The primary machine's
  /// home is offline when its own socket is; any other when its roster link is
  /// not live. A machine still dialing is not offline: the screen waits.
  var ctoHomeIsOffline: Bool {
    guard !ctoHomeNeedsChoice else { return false }
    guard let key = ctoHomeMachineKey, key != focusedMachineKey else {
      return connectionState.isHostUnreachable
    }
    guard let machine = machineFleet?.machine(for: key) else { return false }
    switch machine.state {
    case .live, .connecting, .inactive:
      return false
    case .offline, .paused, .needsUpdate, .needsAttention:
      return true
    }
  }

  /// Dials the CTO's home again: another machine's roster link, or this
  /// machine's own connection. For an ADE Cloud home the dial is the phone's
  /// wake, so this is what "Reconnect" does when the CTO is asleep.
  func reconnectCtoHome() async {
    guard !ctoHomeNeedsChoice, let key = ctoHomeMachineKey, key != focusedMachineKey else {
      await reconnectIfPossible(userInitiated: true)
      return
    }
    _ = await machineFleet?.connect(machineKey: key)
  }

  /// Where CTO commands go: the home machine's checkout of this project when
  /// the home is another machine, else the primary machine (nil target).
  /// Throws when no home has been chosen yet, or when the home is another
  /// machine the phone cannot reach now.
  /// Where the CTO's provider accounts live: the home machine's own
  /// connection when it is another machine, so a picked account is one the
  /// home can run. Nil while that machine isn't connected.
  func ctoProviderAccountsHost() -> ProviderAccountsHost? {
    guard ctoHomeProjectId == activeProjectId,
          let key = ctoHomeMachineKey,
          key != focusedMachineKey
    else { return self }
    guard let connection = machineFleet?.connection(for: key), connection.phase == .live else { return nil }
    return connection
  }

  /// Whether the CTO's home machine runs `action`: that machine's commands when
  /// the home is another machine, else the focused one's. Nil while the home
  /// is not connected (unknown, not "no").
  func ctoHomeSupportsAction(_ action: String) -> Bool? {
    guard ctoHomeProjectId == activeProjectId,
          let key = ctoHomeMachineKey,
          key != focusedMachineKey
    else { return supportsRemoteAction(action) }
    guard let connection = machineFleet?.connection(for: key), connection.phase == .live else { return nil }
    return connection.supportsAction(action)
  }

  func ctoCommandTarget() throws -> (projectId: String?, rootPath: String?, repo: WorkRemoteMachineRepo?) {
    guard !ctoHomeNeedsChoice else {
      throw NSError(domain: "ADE", code: 14, userInfo: [
        NSLocalizedDescriptionKey: "Pick where the CTO lives before it can answer.",
      ])
    }
    guard ctoHomeProjectId == activeProjectId,
          let key = ctoHomeMachineKey,
          key != focusedMachineKey
    else { return (nil, nil, nil) }
    guard machineFleet?.isLive(key) == true, let repo = remoteLaneRepo(machineKey: key) else {
      let name = ctoHomeMachineName ?? "its home machine"
      throw NSError(domain: "ADE", code: 14, userInfo: [
        NSLocalizedDescriptionKey: "The CTO lives on \(name), which is not connected. Connect it in Settings, or choose another home machine in CTO settings.",
      ])
    }
    return (repo.markedProjectId, repo.rootPath, repo)
  }

  /// Reads the project's CTO home machine from the account settings (through
  /// the primary machine). An older brain leaves the CTO on the primary one.
  func refreshCtoHomeMachine() async {
    let projectId = activeProjectId
    guard supportsRemoteAction("cto.getHomeMachine"), let origin = activeProjectGitOriginUrl else {
      applyCtoHome(key: nil, name: nil, projectId: projectId, chosen: true, cloudInstanceId: nil)
      return
    }
    guard let raw = try? await sendCommand(action: "cto.getHomeMachine", args: ["gitOriginUrl": origin]),
          let result = raw as? [String: Any],
          result["available"] as? Bool == true,
          activeProjectId == projectId
    else { return }
    let record = result["value"] as? [String: Any]
    let key = (record?["deviceId"] as? String).flatMap(nonEmptyTrimmed).map(HiddenMachineStore.fleetKey(deviceId:))
    applyCtoHome(
      key: key == focusedMachineKey ? nil : key,
      name: (record?["name"] as? String).flatMap(nonEmptyTrimmed),
      projectId: projectId,
      chosen: record != nil,
      cloudInstanceId: (record?["cloudInstanceId"] as? String).flatMap(nonEmptyTrimmed)
    )
  }

  /// Makes `machineKey` (nil = the primary machine) the project's CTO home
  /// for every device on the account. Answers the record the account stored,
  /// which the new home is handed when it adopts the CTO (`adoptCtoAccountCopy`).
  @discardableResult
  func setCtoHomeMachine(machineKey: String?, name: String) async throws -> [String: Any] {
    guard let origin = activeProjectGitOriginUrl else {
      throw NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: ctoHomeNeedsGitOriginMessage])
    }
    // The account records machines by device identity; a machine known only by
    // address or name cannot be the home.
    let deviceId = if let machineKey {
      HiddenMachineStore.identity(fromFleetKey: machineKey)
    } else {
      nonEmptyTrimmed(activeHostProfile?.hostIdentity ?? activeHostProfile?.lastHostDeviceId)
    }
    guard let deviceId else {
      throw NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: "That machine has no account identity yet."])
    }
    let raw = try await sendCommand(
      action: "cto.setHomeMachine",
      args: ["gitOriginUrl": origin, "record": ["deviceId": deviceId, "name": name]]
    )
    let stored = (raw as? [String: Any])?["value"] as? [String: Any]
    let cloudInstanceId = (stored?["cloudInstanceId"] as? String).flatMap(nonEmptyTrimmed)
    applyCtoHome(
      key: machineKey == focusedMachineKey ? nil : machineKey,
      name: (stored?["name"] as? String).flatMap(nonEmptyTrimmed) ?? name,
      projectId: activeProjectId,
      chosen: true,
      cloudInstanceId: cloudInstanceId
    )
    return stored ?? ["deviceId": deviceId, "name": name]
  }

  /// Has the machine that is now the home take the CTO from its account copy:
  /// its notes, identity, routines and last turns. `machineKey` names the new
  /// home (nil = the primary machine), so the call goes to that machine's own
  /// checkout of the project rather than the primary one. Answers what it
  /// restored, or nil when it could not (an older brain without the action,
  /// a machine that is not live, or a refusal): the move still stands.
  func adoptCtoAccountCopy(home: [String: Any], machineKey: String?) async -> CtoAccountCopyAdoption? {
    var projectId: String?
    var rootPath: String?
    if let machineKey, machineKey != focusedMachineKey {
      guard machineFleet?.isLive(machineKey) == true, let repo = remoteLaneRepo(machineKey: machineKey) else {
        return nil
      }
      projectId = repo.markedProjectId
      rootPath = repo.rootPath
    }
    // Bounded, and never a reason to drop the connection: a home that does not
    // answer simply moved without its copy coming along.
    guard let raw = try? await sendCommand(
      action: "cto.adoptAccountCopy",
      args: ["home": home],
      disconnectOnTimeout: false,
      timeoutNanoseconds: 12_000_000_000,
      targetProjectId: projectId,
      targetProjectRootPath: rootPath
    ), let result = raw as? [String: Any] else { return nil }
    return CtoAccountCopyAdoption(
      restored: result["restored"] as? Bool == true,
      fromName: (result["fromName"] as? String).flatMap(nonEmptyTrimmed),
      savedAt: (result["savedAt"] as? String).flatMap(nonEmptyTrimmed)
    )
  }

  private func applyCtoHome(
    key: String?,
    name: String?,
    projectId: String?,
    chosen: Bool,
    cloudInstanceId: String?
  ) {
    if ctoHomeMachineKey != key { ctoHomeMachineKey = key }
    if ctoHomeMachineName != name { ctoHomeMachineName = name }
    if ctoHomeChosen != chosen { ctoHomeChosen = chosen }
    if ctoHomeCloudInstanceId != cloudInstanceId { ctoHomeCloudInstanceId = cloudInstanceId }
    ctoHomeProjectId = projectId
  }
}
