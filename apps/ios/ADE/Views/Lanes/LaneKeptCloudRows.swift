import SwiftUI

// The rows of a project's ADE Cloud lanes whose computer was deleted, in the
// Lanes list: a deleted computer's lane (listed from its saved chats) and a
// lane ADE kept with no saved chat yet. Each is a normal lane row with a quiet
// "Computer deleted"; a tap opens its newest saved chat, else its lane page.

extension LanesTabView {
  /// Whether a row is a lane whose ADE Cloud computer was deleted: the
  /// account lists it from its saved chats, under the old computer's key.
  func laneComputerDeleted(_ laneId: String) -> Bool {
    workParseRemoteLaneId(laneId)?.machineKey.hasPrefix(ADECloudMachine.savedFleetKeyPrefix) == true
  }

  /// A tap on a lane whose ADE Cloud computer was deleted opens its newest
  /// saved chat, where the next message makes the new computer; with none,
  /// the lane page. Its long-press menu always has Open lane.
  func openDeletedComputerLane(_ laneId: String) {
    if let remote = workParseRemoteLaneId(laneId),
       let chat = KeptCloudLane.newestChat(
         laneId: remote.laneId,
         accountMachineKey: syncService.cloudAccountMachineKey(fleetKey: remote.machineKey),
         sync: syncService
       ) {
      ADEHaptics.light()
      KeptCloudLane.openChat(chat, laneId: remote.laneId, sync: syncService)
      return
    }
    openLane(laneId)
  }

  /// A lane ADE Cloud kept without a computer that no listed machine shows:
  /// its newest saved chat, else its kept-lane page (New computer, Delete).
  func openKeptCloudLane(_ lane: CloudLaneWithoutComputer) {
    if let chat = KeptCloudLane.newestChat(laneId: lane.laneId, sync: syncService) {
      ADEHaptics.light()
      KeptCloudLane.openChat(chat, laneId: lane.laneId, sync: syncService)
      return
    }
    openLane(lane.laneId)
  }

  /// This project's kept lanes that no machine's row already lists (a
  /// deleted computer's saved chats list most), under All or ADE Cloud.
  /// Before the quick filter and the search.
  var keptCloudLanesUnlisted: [CloudLaneWithoutComputer] {
    guard !inputs.keptCloudLanes.isEmpty else { return [] }
    switch machineFilter {
    case .all: break
    case .focused: return []
    case .machine(let key): if key != ADECloudMachine.id { return [] }
    }
    var listed = Set<String>()
    for machine in remoteLanes.machines {
      for snapshot in machine.snapshots {
        listed.insert(workParseRemoteLaneId(snapshot.lane.id)?.laneId ?? snapshot.lane.id)
      }
    }
    return inputs.keptCloudLanes.filter { !listed.contains($0.laneId) }
  }

  /// The kept lanes as rows: only under Active, and searched like the rest.
  var keptCloudLaneRows: [CloudLaneWithoutComputer] {
    guard quickFilter == .active else { return [] }
    let unlisted = keptCloudLanesUnlisted
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !query.isEmpty else { return unlisted }
    return unlisted.filter { lane in
      lane.laneName.lowercased().contains(query) || lane.branchName?.lowercased().contains(query) == true
    }
  }

  /// A quick filter's count, the kept lanes included: they show under Active.
  func laneQuickFilterCount(_ filter: LaneQuickFilter) -> Int {
    let counted = laneListPresentation.quickFilterCounts[filter] ?? 0
    return filter == .active ? counted + keptCloudLanesUnlisted.count : counted
  }

  /// A kept lane as a normal lane row with a quiet "Computer deleted".
  func keptCloudLaneRow(_ lane: CloudLaneWithoutComputer) -> some View {
    let summary = RemoteRosterLane(
      id: lane.laneId,
      name: lane.laneName,
      color: nil,
      icon: nil,
      laneType: "worktree",
      branchRef: lane.branchName
    ).asLaneSummary()
    let isDuoSelected = duoLayout.isWide && duoSelectedLaneId == lane.laneId
    return LaneTreeRow(
      snapshot: LaneListSnapshot(lane: summary, runtime: syncRemoteLaneEmptyRuntime),
      pullRequest: nil,
      isPinned: false,
      isOpen: false,
      transitionNamespace: nil,
      isSelectedTransitionSource: false,
      computerDeleted: true,
      onContextMenu: { _ in
        AnyView(
          Button {
            openLane(lane.laneId)
          } label: {
            Label("Open lane", systemImage: "square.stack.3d.up")
          }
        )
      },
      onSelectLane: { _ in },
      onOpen: { openKeptCloudLane(lane) }
    )
    .background {
      if isDuoSelected {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(ADEColor.accent.opacity(0.12))
          .padding(.horizontal, 6)
      }
    }
    .adeFlatRow(insets: laneRowInsets)
    .adeInspectable("Lanes.KeptLaneRow")
  }
}
