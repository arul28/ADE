import Foundation

// The Work tab's cross-machine rows: the
// focused project plus the SAME repository's chats on every other paired
// machine, the way the desktop Work board unions machines
// (`crossMachineLanes.ts`). Checkouts match by `fleetProjectsMatch`, the
// same rule as the Hub.

/// One other machine's checkout of the focused repository, as its roster
/// reports it.
struct WorkRemoteMachineRepo: Equatable {
  let machineKey: String
  let machineName: String
  let projectId: String
  let rootPath: String?
  let lanes: [RemoteRosterLane]
  let chats: [RemoteRosterChat]
}

/// `owner/name`, lowercased, from a git origin URL in any common form:
/// `https://github.com/Owner/Repo.git`, `git@github.com:Owner/Repo.git`,
/// `ssh://git@host/owner/repo`. Nil when the URL has no owner and name.
func workRepoIdentity(originUrl: String?) -> String? {
  guard var value = originUrl?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
    return nil
  }
  if value.hasSuffix("/") { value.removeLast() }
  if value.lowercased().hasSuffix(".git") { value.removeLast(4) }
  // scp-like `user@host:owner/repo`
  if !value.contains("://"), let colon = value.firstIndex(of: ":") {
    value = String(value[value.index(after: colon)...])
  } else if let schemeEnd = value.range(of: "://") {
    let rest = value[schemeEnd.upperBound...]
    guard let slash = rest.firstIndex(of: "/") else { return nil }
    value = String(rest[rest.index(after: slash)...])
  }
  let parts = value.split(separator: "/").map(String.init).filter { !$0.isEmpty }
  guard parts.count >= 2 else { return nil }
  return "\(parts[parts.count - 2])/\(parts[parts.count - 1])".lowercased()
}

func workRepoIdentity(owner: String?, name: String?) -> String? {
  guard let owner = owner?.trimmingCharacters(in: .whitespacesAndNewlines), !owner.isEmpty,
        let name = name?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty
  else { return nil }
  return "\(owner)/\(name)".lowercased()
}

/// Whether two checkouts on different machines are the same project. Known
/// origins decide. The folder name decides only when one side has no origin
/// (hosts before the fleet release send none), so two different repositories
/// that share a folder name never merge.
func fleetProjectsMatch(
  identity lhsIdentity: String?,
  folder lhsFolder: String?,
  otherIdentity rhsIdentity: String?,
  otherFolder rhsFolder: String?
) -> Bool {
  if let lhsIdentity, let rhsIdentity { return lhsIdentity == rhsIdentity }
  guard let lhsFolder, let rhsFolder else { return false }
  return lhsFolder == rhsFolder
}

/// Lane ids of another machine live in the list under a namespaced id, so a
/// lane never merges with a focused-machine lane (or another machine's).
func workRemoteLaneId(machineKey: String, laneId: String) -> String {
  "\(workRemoteLaneIdPrefix)\(machineKey)|\(laneId)"
}

private let workRemoteLaneIdPrefix = "fleet|"

/// Whether a lane id is another machine's namespaced lane id.
func isWorkRemoteLaneId(_ laneId: String) -> Bool {
  laneId.hasPrefix(workRemoteLaneIdPrefix)
}

/// The other machines' checkouts of the repository `identity`.
func workRemoteMachineRepos(
  machines: [MachineFleet.Machine],
  identity: String?,
  folderKey: String? = nil
) -> [WorkRemoteMachineRepo] {
  guard identity != nil || folderKey != nil else { return [] }
  var repos: [WorkRemoteMachineRepo] = []
  for machine in machines {
    for project in machine.projects {
      guard fleetProjectsMatch(
        identity: identity,
        folder: folderKey,
        otherIdentity: workRepoIdentity(originUrl: project.repoOriginUrl),
        otherFolder: hubProjectFolderKey(project.rootPath, displayName: project.displayName)
      ) else { continue }
      repos.append(WorkRemoteMachineRepo(
        machineKey: machine.machineKey,
        machineName: machine.name,
        projectId: project.projectId,
        rootPath: project.rootPath,
        lanes: project.lanes,
        chats: project.chats.filter { $0.archived != true && !$0.isIdentityChat }
      ))
    }
  }
  return repos
}

struct WorkRemoteMachineMerge {
  var sessions: [TerminalSessionSummary]
  var lanes: [LaneSummary]
  /// Session id -> where the chat lives, for routing and navigation.
  var remoteChats: [String: SyncRemoteMachineChat]
}

/// Add the other machines' chats and lanes to the focused project's rows. A
/// session id the focused machine already shows wins (the desktop union
/// deduplicates the same way).
func workMergeRemoteMachineRows(
  sessions: [TerminalSessionSummary],
  lanes: [LaneSummary],
  remote: [WorkRemoteMachineRepo]
) -> WorkRemoteMachineMerge {
  guard !remote.isEmpty else {
    return WorkRemoteMachineMerge(sessions: sessions, lanes: lanes, remoteChats: [:])
  }
  var seenSessionIds = Set(sessions.map(\.id))
  var mergedSessions = sessions
  var mergedLanes = lanes
  var seenLaneIds = Set(lanes.map(\.id))
  var remoteChats: [String: SyncRemoteMachineChat] = [:]
  for repo in remote {
    let laneById = Dictionary(repo.lanes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
    var usedLaneIds: [String] = []
    var usedLaneIdSet = Set<String>()
    for chat in repo.chats where chat.isChatTool {
      guard seenSessionIds.insert(chat.id).inserted else { continue }
      let lane = laneById[chat.laneId]
      let laneName = "\(lane?.name ?? "Lane") · \(repo.machineName)"
      var session = chat.asTerminalSessionSummary(laneName: laneName)
      session.laneId = workRemoteLaneId(machineKey: repo.machineKey, laneId: chat.laneId)
      mergedSessions.append(session)
      if usedLaneIdSet.insert(chat.laneId).inserted { usedLaneIds.append(chat.laneId) }
      remoteChats[chat.id] = SyncRemoteMachineChat(
        machineKey: repo.machineKey,
        projectId: repo.projectId,
        rootPath: repo.rootPath ?? ""
      )
    }
    for laneId in usedLaneIds {
      let namespaced = workRemoteLaneId(machineKey: repo.machineKey, laneId: laneId)
      guard seenLaneIds.insert(namespaced).inserted else { continue }
      var summary = (laneById[laneId] ?? RemoteRosterLane(id: laneId, name: "Lane", color: nil, icon: nil, laneType: nil, branchRef: nil)).asLaneSummary()
      summary.id = namespaced
      summary.name = "\(summary.name) · \(repo.machineName)"
      // Never the focused project's primary lane.
      if summary.laneType == "primary" { summary.laneType = "worktree" }
      mergedLanes.append(summary)
    }
  }
  return WorkRemoteMachineMerge(sessions: mergedSessions, lanes: mergedLanes, remoteChats: remoteChats)
}
