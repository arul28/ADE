import SwiftUI

// The Hub as ONE list of projects across every paired machine (no
// per-machine lists). A project that exists on several machines
// (same repository origin) is one card; its lanes and chats come from every
// machine, and a lane from a machine other than the focused one carries that
// machine's name. A chat opens through its own machine's roster connection; a
// project that lives only on another machine opens by focusing that machine.
// Machine state and "keep live" live in Settings > Machines
// (`SettingsMachineFleet.swift`), not here.

/// Where a Hub chat or lane from another machine really lives.
struct HubRemoteOwner: Equatable {
  let machineKey: String
  /// That machine's project (its own id and root).
  let project: MobileProjectSummary
  /// The lane with its id on that machine.
  let lane: RemoteRosterLane?
}

struct HubFleetMerge: Equatable {
  /// Focused-machine project id -> its roster with the other machines' lanes
  /// and chats of the same repository added.
  var mergedRosters: [String: RemoteRosterProject] = [:]
  /// Projects no focused-machine project matches, as cards of their own.
  var extraProjects: [(summary: MobileProjectSummary, roster: RemoteRosterProject)] = []
  /// Chat id -> owner, for chats from other machines.
  var chatOwners: [String: HubRemoteOwner] = [:]
  /// Namespaced lane id -> owner, for lanes from other machines.
  var laneOwners: [String: HubRemoteOwner] = [:]
  /// Extra project card id -> the machine that opens it.
  var projectOwners: [String: HubRemoteOwner] = [:]

  static func == (lhs: HubFleetMerge, rhs: HubFleetMerge) -> Bool {
    lhs.mergedRosters == rhs.mergedRosters
      && lhs.extraProjects.map(\.summary) == rhs.extraProjects.map(\.summary)
      && lhs.extraProjects.map(\.roster) == rhs.extraProjects.map(\.roster)
      && lhs.chatOwners == rhs.chatOwners
      && lhs.laneOwners == rhs.laneOwners
      && lhs.projectOwners == rhs.projectOwners
  }
}

/// Card id of a project that exists only on other machines.
func hubRemoteProjectCardId(machineKey: String, projectId: String) -> String {
  "fleet|\(machineKey)|\(projectId)"
}

/// Pure: fold the other machines' rosters into the focused machine's project
/// list. Checkouts on different machines match by `fleetProjectsMatch`.
func hubMergeFleetRosters(
  focused: [(project: MobileProjectSummary, roster: RemoteRosterProject?)],
  machines: [MachineFleet.Machine]
) -> HubFleetMerge {
  var merge = HubFleetMerge()
  var focusedByIdentity: [String: String] = [:]
  var focusedByFolder: [String: String] = [:]
  var focusedIdentityById: [String: String] = [:]
  for entry in focused {
    let identity = workRepoIdentity(owner: entry.project.repoOwner, name: entry.project.repoName)
      ?? workRepoIdentity(originUrl: entry.roster?.repoOriginUrl)
    if let identity {
      focusedIdentityById[entry.project.id] = identity
      if focusedByIdentity[identity] == nil { focusedByIdentity[identity] = entry.project.id }
    }
    if let folder = hubProjectFolderKey(entry.project.rootPath ?? entry.roster?.rootPath, displayName: entry.project.displayName),
       focusedByFolder[folder] == nil {
      focusedByFolder[folder] = entry.project.id
    }
  }
  let focusedRosterById = Dictionary(
    focused.map { ($0.project.id, $0.roster) },
    uniquingKeysWith: { first, _ in first }
  )
  var seenChatIds = Set(focused.flatMap { $0.roster?.chats.map(\.id) ?? [] })
  var extraIndexByKey: [String: Int] = [:]

  for machine in machines {
    for remote in machine.projects {
      let identity = workRepoIdentity(originUrl: remote.repoOriginUrl)
      let ownerProject = remote.asRemoteMachineProjectSummary
      // This machine's lanes and chats, namespaced and labelled.
      var lanes: [RemoteRosterLane] = []
      for lane in remote.lanes {
        var copy = lane
        copy.id = workRemoteLaneId(machineKey: machine.machineKey, laneId: lane.id)
        copy.name = "\(lane.name) · \(machine.name)"
        if copy.laneType == "primary" { copy.laneType = "worktree" }
        lanes.append(copy)
        merge.laneOwners[copy.id] = HubRemoteOwner(machineKey: machine.machineKey, project: ownerProject, lane: lane)
      }
      let laneById = Dictionary(remote.lanes.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
      var chats: [RemoteRosterChat] = []
      for chat in remote.chats where seenChatIds.insert(chat.id).inserted {
        var copy = chat
        copy.laneId = workRemoteLaneId(machineKey: machine.machineKey, laneId: chat.laneId)
        chats.append(copy)
        merge.chatOwners[chat.id] = HubRemoteOwner(
          machineKey: machine.machineKey,
          project: ownerProject,
          lane: laneById[chat.laneId]
        )
      }

      // One card per project, not one per machine.
      let folder = hubProjectFolderKey(remote.rootPath, displayName: remote.displayName)
      let matchedFocusedId = identity.flatMap { focusedByIdentity[$0] }
        ?? folder.flatMap { focusedByFolder[$0] }.flatMap { focusedId in
          fleetProjectsMatch(
            identity: identity,
            folder: folder,
            otherIdentity: focusedIdentityById[focusedId],
            otherFolder: folder
          ) ? focusedId : nil
        }
      if let focusedId = matchedFocusedId {
        var target = merge.mergedRosters[focusedId]
          ?? focusedRosterById[focusedId].flatMap { $0 }
          ?? RemoteRosterProject(
            projectId: focusedId,
            rootPath: nil,
            displayName: remote.displayName,
            iconDataUrl: nil,
            lastOpenedAt: nil,
            booted: false,
            runningCount: 0,
            attentionCount: 0,
            lanes: [],
            chats: []
          )
        target.lanes.append(contentsOf: lanes)
        target.chats.append(contentsOf: chats)
        merge.mergedRosters[focusedId] = hubRecountedRoster(target)
        continue
      }

      let key = identity.map { "repo:\($0)" }
        ?? folder.map { "folder:\($0)" }
        ?? hubRemoteProjectCardId(machineKey: machine.machineKey, projectId: remote.projectId)
      if let index = extraIndexByKey[key] {
        var roster = merge.extraProjects[index].roster
        roster.lanes.append(contentsOf: lanes)
        roster.chats.append(contentsOf: chats)
        merge.extraProjects[index].roster = hubRecountedRoster(roster)
        continue
      }
      let cardId = hubRemoteProjectCardId(machineKey: machine.machineKey, projectId: remote.projectId)
      var summary = ownerProject
      summary.id = cardId
      var roster = remote
      roster.projectId = cardId
      roster.lanes = lanes
      roster.chats = chats
      extraIndexByKey[key] = merge.extraProjects.count
      merge.extraProjects.append((summary: summary, roster: hubRecountedRoster(roster)))
      merge.projectOwners[cardId] = HubRemoteOwner(machineKey: machine.machineKey, project: ownerProject, lane: nil)
    }
  }
  return merge
}

private func hubRecountedRoster(_ roster: RemoteRosterProject) -> RemoteRosterProject {
  var copy = roster
  copy.runningCount = copy.chats.filter(\.countsTowardRunning).count
  copy.attentionCount = copy.chats.filter(\.needsAttention).count
  copy.chats.sort { ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "") }
  return copy
}

/// A project's folder name, lowercased: the fallback match between machines
/// when no repository origin is known.
func hubProjectFolderKey(_ rootPath: String?, displayName: String?) -> String? {
  if let rootPath = rootPath?.trimmingCharacters(in: .whitespacesAndNewlines), !rootPath.isEmpty {
    let normalized = rootPath.replacingOccurrences(of: "\\", with: "/")
    if let last = normalized.split(separator: "/").last, !last.isEmpty {
      return String(last).lowercased()
    }
  }
  guard let name = displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty else { return nil }
  return name.lowercased()
}
