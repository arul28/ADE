import SwiftUI

// Where a lane moves from: the lane, the machine it is on, and the kind of
// move that machine allows. Every move sheet builds its source here.

/// The chats of a lane that start a tree: the lane detail offers "Move to…"
/// only when it has one, since a live move reads its options through a
/// chat. The brain adds each one's subagents. A chat that already continues
/// on another machine stays out. Pure.
func laneMoveChats(_ chats: [AgentChatSessionSummary]) -> [AgentChatSessionSummary] {
  chats.filter { chat in
    chat.archivedAt == nil
      && (chat.surface ?? "work") == "work"
      && chat.orchestrationParentSessionId == nil
      && chat.crossMachineHandoff?.state != .continued
  }
}

/// The places a lane can move to: the brain's machines without the ADE
/// Cloud computers, which hold one lane each.
@MainActor
func laneMoveMachines(_ options: AgentChatCrossMachineHandoffOptions, sync: SyncService) -> [AgentChatCrossMachineHandoffMachineOption] {
  let cloudKeys = Set((sync.cloudAccountMachineKeys ?? []).map { $0.lowercased() })
    .union(sync.cloudServerInstances.compactMap { $0.machineKey?.lowercased() })
  return options.machines.filter { !cloudKeys.contains($0.machineKey.lowercased()) }
}

/// Where a lane is, as its move needs it.
struct LaneMoveSource: Identifiable, Equatable {
  var id: String { laneId }
  var kind: LaneMoveSourceKind
  /// The lane as the phone names it (`fleet|…` for a lane of another
  /// machine); the kept lane's own id for a move from saved copies.
  let laneId: String
  var laneName: String
  /// Where the lane is now, for "From …" and the summary note.
  let machineName: String
  /// A chat on the lane: a live move reads its options through it.
  let viaSessionId: String?
  /// The fleet key of the lane's computer (an asleep one wakes through it).
  let fleetKey: String?
  /// The lane's own ADE Cloud computer, deleted once the move is checked.
  var computer: LaneMoveCloudComputer?
  /// The lane's sessions and chats when the caller already read them.
  var sessions: [TerminalSessionSummary]? = nil
  var chats: [AgentChatSessionSummary]? = nil

  /// The move ends with deleting the lane's ADE Cloud computer.
  var deletesComputer: Bool { kind == .cloud && computer != nil }

  /// The asleep ADE Cloud computer a move from its saved copy deletes first.
  /// Only a computer made for this one lane; nil for every other move.
  var fromComputer: String? { kind == .cloudAsleep ? computer?.instanceId : nil }

  /// The move comes from saved copies, run by the destination: a deleted
  /// computer's kept lane, or an asleep computer's saved copy.
  var restores: Bool { kind == .cloudGone || fromComputer != nil }

  /// The lane's own id, as a move from saved copies names it.
  var restoreLaneId: String { computer?.laneId ?? workParseRemoteLaneId(laneId)?.laneId ?? laneId }

  /// A lane whose ADE Cloud computer was deleted (a kept lane).
  static func kept(_ lane: CloudLaneWithoutComputer) -> LaneMoveSource {
    LaneMoveSource(
      kind: .cloudGone,
      laneId: lane.laneId,
      laneName: lane.laneName,
      machineName: ADECloudMachine.name,
      viaSessionId: nil,
      fleetKey: nil,
      computer: nil
    )
  }
}

/// What kind of move a lane gets, from where it lives now. `fleetKey` is the
/// lane's computer when the caller knows it; else the lane id names it.
@MainActor
private func laneMoveKind(laneId: String, fleetKey known: String? = nil, sync: SyncService) -> (
  kind: LaneMoveSourceKind,
  fleetKey: String?,
  computer: LaneMoveCloudComputer?,
  kept: CloudLaneWithoutComputer?
) {
  let fleetKey = known ?? cloudLaneFleetKey(laneId, sync: sync)
  guard sync.isCloudFleetKey(fleetKey) else { return (.own, fleetKey, nil, nil) }
  let plain = workParseRemoteLaneId(laneId)?.laneId ?? laneId
  if fleetKey?.hasPrefix(ADECloudMachine.savedFleetKeyPrefix) == true {
    let kept = AccountCloudStore.shared.lanesWithoutComputer.first { $0.laneId == plain }
    return (.cloudGone, fleetKey, nil, kept)
  }
  // Only a computer made for this one lane is deleted after the move.
  let computer = sync.cloudServerInstance(fleetKey: fleetKey).flatMap { instance -> LaneMoveCloudComputer? in
    guard !instance.isGone, instance.laneId == plain else { return nil }
    return LaneMoveCloudComputer(instanceId: instance.id, accountMachineKey: instance.machineKey, laneId: plain)
  }
  if case .awake? = cloudLaneState(fleetKey: fleetKey, sync: sync, store: AccountCloudStore.shared) {
    return (.cloud, fleetKey, computer, nil)
  }
  return (.cloudAsleep, fleetKey, computer, nil)
}

/// The move of a live lane the lane detail shows, with the sessions and
/// chats it already read.
@MainActor
func laneMoveSource(
  laneId: String,
  laneName: String,
  machineName: String?,
  sessions: [TerminalSessionSummary],
  chats: [AgentChatSessionSummary],
  sync: SyncService
) -> LaneMoveSource {
  let found = laneMoveKind(laneId: laneId, sync: sync)
  if found.kind == .cloudGone, let kept = found.kept { return .kept(kept) }
  let cloud = found.kind != .own
  return LaneMoveSource(
    kind: found.kind,
    laneId: laneId,
    laneName: laneName,
    machineName: cloud ? ADECloudMachine.name : (nonEmptyTrimmed(machineName) ?? "this computer"),
    viaSessionId: laneMoveChats(chats).first?.sessionId,
    fleetKey: found.fleetKey,
    computer: found.computer,
    sessions: sessions,
    chats: chats
  )
}

/// The move a chat's machine label opens: the chat's lane, from wherever it
/// is. Nil for a chat that can't move its lane (a CTO or personal chat, a
/// chat with no lane, a deleted ADE Cloud computer whose lane ADE no longer
/// keeps). `fleetKey` is the chat's own machine when the caller knows it.
@MainActor
func laneMoveSourceForChat(
  sessionId: String,
  laneId: String,
  laneName: String?,
  surface: String?,
  fleetKey: String? = nil,
  sync: SyncService
) -> LaneMoveSource? {
  guard (surface ?? "work") == "work", nonEmptyTrimmed(laneId) != nil else { return nil }
  let found = laneMoveKind(laneId: laneId, fleetKey: fleetKey, sync: sync)
  if found.kind == .cloudGone {
    return found.kept.map(LaneMoveSource.kept)
  }
  return LaneMoveSource(
    kind: found.kind,
    laneId: laneId,
    laneName: nonEmptyTrimmed(laneName) ?? "This lane",
    machineName: found.kind == .own ? (sync.chatMachineName(sessionId: sessionId) ?? "this computer") : ADECloudMachine.name,
    viaSessionId: sessionId,
    fleetKey: found.fleetKey,
    computer: found.computer
  )
}

/// The move the lane at rest opens: a lane whose ADE Cloud computer is
/// asleep or deleted, with no chat read yet. Nil for a deleted computer
/// whose lane ADE no longer keeps.
@MainActor
func laneMoveSourceAtRest(laneId: String, laneName: String, fleetKey: String, sync: SyncService) -> LaneMoveSource? {
  let found = laneMoveKind(laneId: laneId, fleetKey: fleetKey, sync: sync)
  if found.kind == .cloudGone {
    return found.kept.map(LaneMoveSource.kept)
  }
  return LaneMoveSource(
    kind: found.kind,
    laneId: workParseRemoteLaneId(laneId)?.laneId ?? laneId,
    laneName: laneName,
    machineName: ADECloudMachine.name,
    viaSessionId: nil,
    fleetKey: found.fleetKey,
    computer: found.computer
  )
}
