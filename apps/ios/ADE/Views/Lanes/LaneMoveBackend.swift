import SwiftUI

// What the move sheet asks of the brains. `SyncLaneMoveBackend` sends each
// call to the machine it belongs to (the lane's own brain for a live move,
// the destination for a move from saved copies). Fixture screens pass their
// own backend, which answers from in-process data and sends nothing.

/// A live move's first read: where it runs, its options and what it carries.
struct LaneMoveLiveRead {
  /// The lane's own brain. Nil only on fixture screens.
  let route: LaneMoveRoute?
  let options: AgentChatCrossMachineHandoffOptions?
  let items: [LaneMoveItem]
  /// The lane as its brain names it and its chats, when the read had to
  /// fetch them (a sheet opened from a chat).
  var laneName: String? = nil
  var chats: [AgentChatSessionSummary]? = nil
}

/// A read that can't go ahead, in words for the person.
struct LaneMoveReadFailure: Error {
  let message: String
}

/// A move the review starts.
struct LaneMoveStartRequest {
  let source: LaneMoveSource
  let target: LaneMoveTarget
  let route: LaneMoveRoute
  /// A live move: the chats and CLIs it carries.
  let sessionIds: [String]
  /// A live move ends with deleting the lane's ADE Cloud computer.
  let deletesComputer: Bool
}

@MainActor
protocol LaneMoveBackend {
  /// The computers a move from saved copies can go to.
  func restoreTargets() -> [LaneMoveTarget]
  /// The machines a live move lists, from the brain's options.
  func liveMachines(_ options: AgentChatCrossMachineHandoffOptions) -> [AgentChatCrossMachineHandoffMachineOption]
  /// Reads a live move on the lane's own brain.
  func readLive(source: LaneMoveSource) async throws -> LaneMoveLiveRead
  /// Wakes the lane's ADE Cloud computer. Nil once it is up; else why not.
  func wake(fleetKey: String) async -> String?
  /// What a move from saved copies brings, read on the destination.
  func preview(route: LaneMoveRoute, source: LaneMoveSource) async throws -> CloudKeptLaneRestorePreview
  /// Starts the move. The run to follow; nil when nothing was sent.
  func start(_ request: LaneMoveStartRequest) async throws -> String?
}

/// The real calls, over the phone's sync connection.
struct SyncLaneMoveBackend: LaneMoveBackend {
  /// Holds nothing, so a view's default argument can make one anywhere.
  nonisolated init() {}

  private var sync: SyncService { SyncMenuSafePublisher.shared.service }

  func restoreTargets() -> [LaneMoveTarget] {
    sync.keptLaneRestoreTargets()
  }

  func liveMachines(_ options: AgentChatCrossMachineHandoffOptions) -> [AgentChatCrossMachineHandoffMachineOption] {
    laneMoveMachines(options, sync: sync)
  }

  func readLive(source: LaneMoveSource) async throws -> LaneMoveLiveRead {
    guard let via = source.viaSessionId else {
      throw LaneMoveReadFailure(message: "This lane has no chat yet. Start a chat on it, then move it.")
    }
    let route = try sync.laneMoveRoute(laneId: source.laneId, viaSessionId: via)
    guard sync.laneMoveActionAvailable("chat.getCrossMachineHandoffOptions", route: route),
          sync.laneMoveActionAvailable("chat.startCrossMachineBatchMove", route: route),
          sync.laneMoveActionAvailable("chat.getCrossMachineBatchMove", route: route)
    else {
      throw LaneMoveReadFailure(message: "The computer this lane is on needs an ADE update to move a lane from the phone.")
    }
    let options = try await sync.laneMoveOptions(route: route, viaSessionId: via)
    if let sessions = source.sessions, let chats = source.chats {
      return LaneMoveLiveRead(route: route, options: options, items: laneMoveItems(sessions: sessions, chats: chats))
    }
    // Opened from a chat: one read of the lane on its own brain.
    let detail = try await sync.readLaneMoveDetail(route: route, laneId: source.laneId)
    return LaneMoveLiveRead(
      route: route,
      options: options,
      items: laneMoveItems(sessions: detail.sessions, chats: detail.chatSessions),
      laneName: detail.lane.displayName,
      chats: detail.chatSessions
    )
  }

  func wake(fleetKey: String) async -> String? {
    let up: Bool
    if fleetKey == sync.focusedMachineKey {
      up = await sync.wakeFocusedCloudMachineIfAsleep()
    } else {
      up = await sync.machineFleet?.connect(machineKey: fleetKey, timeout: .seconds(150)) ?? false
    }
    return up ? nil : (sync.cloudWakeFailure(fleetKey: fleetKey) ?? "The computer didn't come up. Try again.")
  }

  func preview(route: LaneMoveRoute, source: LaneMoveSource) async throws -> CloudKeptLaneRestorePreview {
    try await sync.previewKeptLaneRestore(route: route, laneId: source.restoreLaneId, fromComputer: source.fromComputer)
  }

  func start(_ request: LaneMoveStartRequest) async throws -> String? {
    let source = request.source
    if source.restores {
      // The destination's brain deletes an asleep computer itself, first; nothing is deleted after.
      let record = try await sync.restoreKeptLane(route: request.route, laneId: source.restoreLaneId, fromComputer: source.fromComputer)
      return LaneMoveRuns.shared.followRestore(
        record: record,
        route: request.route,
        laneId: source.laneId,
        targetName: request.target.name,
        fromComputer: source.fromComputer,
        sync: sync
      )
    }
    let record = try await sync.startLaneMoveBatch(
      route: request.route,
      sessionIds: request.sessionIds,
      machineKey: request.target.machineKey,
      clone: request.target.hasRepository == false
    )
    return LaneMoveRuns.shared.followLive(
      record: record,
      route: request.route,
      laneId: source.laneId,
      laneName: source.laneName,
      targetName: request.target.name,
      computer: request.deletesComputer ? source.computer : nil,
      sync: sync
    )
  }
}
