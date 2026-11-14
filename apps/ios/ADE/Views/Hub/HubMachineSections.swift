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
  /// Card id (a focused-machine project's id, or an extra card's id) -> every
  /// other machine that has this project, with its own id and root there. The
  /// card's machine chip counts them, and a change to the project (its icon)
  /// is sent to each.
  var projectLocations: [String: [HubRemoteOwner]] = [:]
  /// Card id -> the account project its folders are copies of, when the
  /// resolver knew one (`hubMergeFleetRosters(resolver:)`).
  var accountIdByCardId: [String: String] = [:]

  static func == (lhs: HubFleetMerge, rhs: HubFleetMerge) -> Bool {
    lhs.mergedRosters == rhs.mergedRosters
      && lhs.extraProjects.map(\.summary) == rhs.extraProjects.map(\.summary)
      && lhs.extraProjects.map(\.roster) == rhs.extraProjects.map(\.roster)
      && lhs.chatOwners == rhs.chatOwners
      && lhs.laneOwners == rhs.laneOwners
      && lhs.projectOwners == rhs.projectOwners
      && lhs.projectLocations == rhs.projectLocations
      && lhs.accountIdByCardId == rhs.accountIdByCardId
  }
}

/// Card id of a project that exists only on other machines.
func hubRemoteProjectCardId(machineKey: String, projectId: String) -> String {
  "fleet|\(machineKey)|\(projectId)"
}

/// Pure: fold the other machines' rosters into the focused machine's project
/// list. With a `resolver` (a signed-in account), folders that are copies of
/// one account project are one card, whatever their origin or folder name,
/// and two different account projects never merge. Otherwise, and for
/// folders the account does not know, checkouts on different machines match
/// by `fleetProjectsMatch`.
func hubMergeFleetRosters(
  focused: [(project: MobileProjectSummary, roster: RemoteRosterProject?)],
  machines: [MachineFleet.Machine],
  resolver: HubAccountResolver? = nil,
  focusedMachineKey: String? = nil
) -> HubFleetMerge {
  var merge = HubFleetMerge()
  var focusedByIdentity: [String: String] = [:]
  var focusedByFolder: [String: String] = [:]
  var focusedIdentityById: [String: String] = [:]
  var focusedByAccount: [String: String] = [:]
  for entry in focused {
    let identity = workRepoIdentity(owner: entry.project.repoOwner, name: entry.project.repoName)
      ?? workRepoIdentity(originUrl: entry.roster?.repoOriginUrl)
    if let accountId = resolver?.accountProjectId(
      fleetKey: focusedMachineKey,
      checkoutId: entry.project.id,
      gitHubIdentity: workRepoIdentity(owner: entry.project.repoOwner, name: entry.project.repoName)
        ?? hubGitHubRepoIdentity(originUrl: entry.roster?.repoOriginUrl),
      sentId: entry.project.accountProjectId ?? entry.roster?.accountProjectId
    ) {
      merge.accountIdByCardId[entry.project.id] = accountId
      if focusedByAccount[accountId] == nil { focusedByAccount[accountId] = entry.project.id }
    }
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
  var extraAccountId: [Int: String] = [:]

  for machine in machines {
    for remote in machine.projects {
      let identity = workRepoIdentity(originUrl: remote.repoOriginUrl)
      let ownerProject = remote.asRemoteMachineProjectSummary
      // This machine's lanes and chats, namespaced and labelled.
      var lanes: [RemoteRosterLane] = []
      for lane in remote.lanes {
        var copy = lane
        copy.id = workRemoteLaneId(machineKey: machine.machineKey, laneId: lane.id)
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
      let accountId = resolver?.accountProjectId(
        fleetKey: machine.machineKey,
        checkoutId: remote.projectId,
        gitHubIdentity: hubGitHubRepoIdentity(originUrl: remote.repoOriginUrl),
        sentId: remote.accountProjectId
      )
      // Two folders the account knows as different projects never merge.
      func sameAccountProject(_ other: String?) -> Bool {
        guard let accountId, let other else { return true }
        return accountId == other
      }
      let matchedFocusedId = accountId.flatMap { focusedByAccount[$0] }
        ?? identity.flatMap { focusedByIdentity[$0] }.flatMap { focusedId in
          sameAccountProject(merge.accountIdByCardId[focusedId]) ? focusedId : nil
        }
        ?? folder.flatMap { focusedByFolder[$0] }.flatMap { focusedId in
          fleetProjectsMatch(
            identity: identity,
            folder: folder,
            otherIdentity: focusedIdentityById[focusedId],
            otherFolder: folder
          ) && sameAccountProject(merge.accountIdByCardId[focusedId]) ? focusedId : nil
        }
      let location = HubRemoteOwner(machineKey: machine.machineKey, project: ownerProject, lane: nil)
      if let focusedId = matchedFocusedId {
        // A focused card the account did not name takes this folder's project,
        // so a folder of another account project cannot join it later.
        if let accountId, merge.accountIdByCardId[focusedId] == nil {
          merge.accountIdByCardId[focusedId] = accountId
          if focusedByAccount[accountId] == nil { focusedByAccount[accountId] = focusedId }
        }
        merge.projectLocations[focusedId, default: []].append(location)
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
        // Chats a paged roster has not loaded yet, from either side.
        let unloaded = target.unloadedChatCount + remote.unloadedChatCount
        target.lanes.append(contentsOf: lanes)
        target.chats.append(contentsOf: chats)
        target.chatTotal = unloaded > 0 ? target.chats.count + unloaded : nil
        merge.mergedRosters[focusedId] = hubRecountedRoster(target)
        continue
      }

      let key = identity.map { "repo:\($0)" }
        ?? folder.map { "folder:\($0)" }
        ?? hubRemoteProjectCardId(machineKey: machine.machineKey, projectId: remote.projectId)
      let accountKey = accountId.map { "account:\($0)" }
      let existingIndex = accountKey.flatMap { extraIndexByKey[$0] }
        ?? extraIndexByKey[key].flatMap { sameAccountProject(extraAccountId[$0]) ? $0 : nil }
      if let index = existingIndex {
        if let accountId, let accountKey, extraAccountId[index] == nil {
          extraAccountId[index] = accountId
          extraIndexByKey[accountKey] = index
          merge.accountIdByCardId[merge.extraProjects[index].summary.id] = accountId
        }
        if extraIndexByKey[key] == nil { extraIndexByKey[key] = index }
        merge.projectLocations[merge.extraProjects[index].summary.id, default: []].append(location)
        var roster = merge.extraProjects[index].roster
        let unloaded = roster.unloadedChatCount + remote.unloadedChatCount
        roster.lanes.append(contentsOf: lanes)
        roster.chats.append(contentsOf: chats)
        roster.chatTotal = unloaded > 0 ? roster.chats.count + unloaded : nil
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
      roster.chatTotal = remote.unloadedChatCount > 0 ? chats.count + remote.unloadedChatCount : nil
      let newIndex = merge.extraProjects.count
      if extraIndexByKey[key] == nil { extraIndexByKey[key] = newIndex }
      if let accountId, let accountKey {
        extraIndexByKey[accountKey] = newIndex
        extraAccountId[newIndex] = accountId
        merge.accountIdByCardId[cardId] = accountId
      }
      merge.extraProjects.append((summary: summary, roster: hubRecountedRoster(roster)))
      merge.projectOwners[cardId] = location
      merge.projectLocations[cardId, default: []].append(location)
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

/// Pure: a machine roster with the phone's local cache of the active project
/// laid over it (its lanes and chats added or merged), recounted.
func hubMergedRoster(remote: RemoteRosterProject, local: RemoteRosterProject) -> RemoteRosterProject {
  var merged = remote

  var laneIds = Set(merged.lanes.map(\.id))
  for lane in local.lanes where laneIds.insert(lane.id).inserted {
    merged.lanes.append(lane)
  }

  var chatIndexById = Dictionary(uniqueKeysWithValues: merged.chats.enumerated().map { ($0.element.id, $0.offset) })
  for localChat in local.chats {
    if let index = chatIndexById[localChat.id] {
      merged.chats[index] = merged.chats[index].merging(local: localChat)
    } else {
      chatIndexById[localChat.id] = merged.chats.count
      merged.chats.append(localChat)
    }
  }

  merged.booted = remote.booted || local.booted
  merged.runningCount = merged.chats.filter(\.countsTowardRunning).count
  merged.attentionCount = merged.chats.filter(\.needsAttention).count
  merged.chats.sort { ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "") }
  return merged.excludingIdentityChats()
}

/// Sends a picked icon to every machine a project is on, each with its own
/// project id and root (a project on several machines shows the same icon on
/// all of them). Answers one line per machine that did not change: offline,
/// too old, or an error. The others still change.
@MainActor
func hubSendProjectIcon(
  _ project: MobileProjectSummary,
  png: Data,
  onFocused: Bool,
  locations: [HubRemoteOwner],
  sync: SyncService,
  fleet: MachineFleet
) async -> [String] {
  var failures: [String] = []
  if onFocused {
    do {
      try await sync.setProjectIcon(project, png: png)
    } catch {
      failures.append("\(sync.focusedMachineDisplayName): \(error.localizedDescription)")
    }
  }
  for location in locations {
    let name = fleet.machine(for: location.machineKey)?.name ?? "Another machine"
    guard let connection = fleet.connection(for: location.machineKey),
          connection.isLive, connection.supportsProjectIcon else {
      failures.append("\(name): can’t reach it, or its ADE is too old")
      continue
    }
    do {
      try await connection.setProjectIcon(projectId: location.project.id, rootPath: location.project.rootPath, png: png)
    } catch {
      failures.append("\(name): \(error.localizedDescription)")
    }
  }
  return failures
}

/// A roster with its chats and lanes taken out: the project card stays.
func hubRosterWithoutWork(_ roster: RemoteRosterProject) -> RemoteRosterProject {
  var copy = roster
  copy.chats = []
  copy.lanes = []
  copy.chatTotal = nil
  copy.runningCount = 0
  copy.attentionCount = 0
  return copy
}

/// A machine as the Hub merges it: one whose work is not listed
/// (`fleetMachineListsWork`) keeps its project cards, without chats or lanes.
func hubMachineWithListedWork(_ machine: MachineFleet.Machine) -> MachineFleet.Machine {
  guard !machine.listsWork else { return machine }
  var copy = machine
  copy.projects = machine.projects.map(hubRosterWithoutWork)
  return copy
}
