import Foundation

// The project's one CTO lives on one machine, its "home" (account setting
// `cto.homeMachine` under `repo:<origin>`, shared with the desktop's
// `ctoHomeMachine.ts`). The phone sends every CTO call there. When the home is
// another machine that is not live, CTO calls fail closed: answering from the
// primary machine's CTO would split the one CTO in two.

extension SyncService {
  /// Git origin of the focused project, the key of its account repo settings.
  var activeProjectGitOriginUrl: String? {
    guard let activeProject else { return nil }
    if let origin = nonEmptyTrimmed(rosterProject(for: activeProject)?.repoOriginUrl) { return origin }
    guard let owner = nonEmptyTrimmed(activeProject.repoOwner),
          let name = nonEmptyTrimmed(activeProject.repoName) else { return nil }
    return "https://github.com/\(owner)/\(name)"
  }

  /// Where CTO commands go: the home machine's checkout of this project when
  /// the home is another machine, else the primary machine (nil target).
  /// Throws when the home is another machine the phone cannot reach now.
  func ctoCommandTarget() throws -> (projectId: String?, rootPath: String?, repo: WorkRemoteMachineRepo?) {
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
      applyCtoHome(key: nil, name: nil, projectId: projectId)
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
      projectId: projectId
    )
  }

  /// Makes `machineKey` (nil = the primary machine) the project's CTO home
  /// for every device on the account.
  func setCtoHomeMachine(machineKey: String?, name: String) async throws {
    guard let origin = activeProjectGitOriginUrl else {
      throw NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: "This project has no git origin, so its CTO home can't be shared."])
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
    _ = try await sendCommand(
      action: "cto.setHomeMachine",
      args: ["gitOriginUrl": origin, "record": ["deviceId": deviceId, "name": name]]
    )
    applyCtoHome(key: machineKey == focusedMachineKey ? nil : machineKey, name: name, projectId: activeProjectId)
  }

  private func applyCtoHome(key: String?, name: String?, projectId: String?) {
    if ctoHomeMachineKey != key { ctoHomeMachineKey = key }
    if ctoHomeMachineName != name { ctoHomeMachineName = name }
    ctoHomeProjectId = projectId
  }
}
