import Foundation

/// The Lanes tab's rows from the other paired machines: the focused
/// repository's lanes on every machine that has a checkout of it, the way the
/// desktop's Lanes tab lists every machine (`crossMachineLanes.ts`).
///
/// A live machine answers `lanes.refreshSnapshots` over its roster link (the
/// same rows the focused machine's list shows, with namespaced lane ids). A
/// machine with no live link (reconnecting, or an ADE Cloud computer that is
/// asleep) shows the lanes its last roster named, with no actions. Reads run only while the tab is visible, at most one per
/// machine at a time, each bounded, and never hold up the focused list.
@MainActor
final class LaneRemoteMachinesModel: ObservableObject {
  struct MachineLanes: Equatable, Identifiable {
    let machineKey: String
    let name: String
    /// The project id and root of the repository's checkout on that machine.
    let projectId: String
    let rootPath: String?
    let isLive: Bool
    let snapshots: [LaneListSnapshot]
    /// Why the last read failed, when the rows are older than the last attempt.
    let error: String?
    var id: String { machineKey }
    /// The project id a command for this checkout carries.
    var markedProjectId: String { syncFleetMarkedProjectId(machineKey: machineKey, projectId: projectId) }
  }

  /// Same cadence and bound as the desktop union (`crossMachineLanes.ts`).
  static let refreshIntervalNanoseconds: UInt64 = 30_000_000_000
  static let readTimeoutNanoseconds: UInt64 = 8_000_000_000

  @Published private(set) var machines: [MachineLanes] = []
  /// The last successful read of each machine: shown while a read runs or
  /// after it fails.
  /// Keyed by `laneRemoteReadKey`: a read belongs to one machine's checkout.
  private var lastRead: [String: [LaneListSnapshot]] = [:]
  /// Bumped by `reset()`: a refresh from before it publishes nothing, and a
  /// new one does not wait for it.
  private var generation = 0
  private var inFlightGeneration: Int?

  func refresh(sync: SyncService, fleet: MachineFleet) async {
    let runGeneration = generation
    guard inFlightGeneration != runGeneration else { return }
    inFlightGeneration = runGeneration
    defer { if inFlightGeneration == runGeneration { inFlightGeneration = nil } }
    let repos = sync.listedRemoteReposForActiveProject()
    var results: [String: Result<[LaneListSnapshot], Error>] = [:]
    await withTaskGroup(of: (String, Result<[LaneListSnapshot], Error>).self) { group in
      for repo in repos where fleet.isLive(repo.machineKey) {
        group.addTask { @MainActor in
          do {
            let snapshots = try await sync.fetchRemoteLaneSnapshots(
              repo: repo,
              timeoutNanoseconds: Self.readTimeoutNanoseconds
            )
            return (laneRemoteReadKey(repo), .success(snapshots))
          } catch {
            return (laneRemoteReadKey(repo), .failure(error))
          }
        }
      }
      for await (key, result) in group {
        results[key] = result
      }
    }
    guard runGeneration == generation else { return }
    // The project or the fleet may have changed while the reads ran; build
    // from the repos as they are now. A read of another checkout (the project
    // switched) matches no current key and is dropped.
    let current = sync.listedRemoteReposForActiveProject()
    let currentKeys = Set(current.map(laneRemoteReadKey))
    lastRead = lastRead.filter { currentKeys.contains($0.key) }
    var next: [MachineLanes] = []
    for repo in current {
      let isLive = fleet.isLive(repo.machineKey)
      let key = laneRemoteReadKey(repo)
      var error: String?
      switch results[key] {
      case .success(let snapshots)?:
        lastRead[key] = snapshots
      case .failure(let failure)?:
        error = SyncUserFacingError.message(for: failure)
      case nil:
        break
      }
      let read = isLive
        ? (lastRead[key] ?? laneRemoteRosterSnapshots(repo))
        : laneRemoteRosterSnapshots(repo)
      // Badge counts by the Hub's rule, from that machine's roster. An ADE
      // Cloud lane computer's main checkout is only its lane's clone: left out,
      // as on desktop (`crossMachineLanes.ts`).
      let snapshots = laneSnapshotsWithoutCloudMainCheckout(read, machineKey: repo.machineKey, sync: sync).map { snapshot -> LaneListSnapshot in
        guard let rosterLaneId = workParseRemoteLaneId(snapshot.lane.id)?.laneId else { return snapshot }
        var next = snapshot
        next.runtime = laneRuntimeByHubRule(snapshot.runtime, rosterLaneId: rosterLaneId, chats: repo.chats)
        return next
      }
      next.append(MachineLanes(
        machineKey: repo.machineKey,
        name: repo.machineName,
        projectId: repo.projectId,
        rootPath: repo.rootPath,
        isLive: isLive,
        snapshots: snapshots,
        error: error
      ))
    }
    if next != machines { machines = next }
  }

  func reset() {
    generation &+= 1
    lastRead = [:]
    if !machines.isEmpty { machines = [] }
  }
}

/// One machine's checkout of the repository: a read result belongs to it.
func laneRemoteReadKey(_ repo: WorkRemoteMachineRepo) -> String {
  "\(repo.machineKey)|\(repo.projectId)"
}

/// Lane rows from a machine's roster alone: name, branch, color and type.
func laneRemoteRosterSnapshots(_ repo: WorkRemoteMachineRepo) -> [LaneListSnapshot] {
  repo.lanes.map { rosterLane in
    var lane = rosterLane.asLaneSummary()
    lane.id = workRemoteLaneId(machineKey: repo.machineKey, laneId: rosterLane.id)
    return LaneListSnapshot(lane: lane, runtime: syncRemoteLaneEmptyRuntime)
  }
}

/// A lane's badge counts by the Hub's rule (`hubChatBoardState`): a session
/// counts as running only while it works now, and as waiting only while it
/// asks for the user. The brain's lane summary counts every live session as
/// running, so a quiet shell or a chat between turns lit the lane's ring.
/// `chats` is the lane's machine roster for that checkout; nil (no roster yet)
/// keeps the brain's counts. `rosterLaneId` is the lane id the roster uses.
func laneRuntimeByHubRule(
  _ runtime: LaneRuntimeSummary,
  rosterLaneId: String,
  chats: [RemoteRosterChat]?
) -> LaneRuntimeSummary {
  guard let chats else { return runtime }
  var running = 0
  var awaiting = 0
  var count = 0
  for chat in chats where chat.laneId == rosterLaneId && chat.archived != true && !chat.isIdentityChat {
    count += 1
    if chat.status == .awaiting || chat.awaitingInput == true {
      awaiting += 1
    } else if hubChatBoardState(chat, lane: nil).column == .working {
      running += 1
    }
  }
  let sessions = max(count, runtime.sessionCount)
  let bucket: String
  if awaiting > 0 {
    bucket = "awaiting-input"
  } else if running > 0 {
    bucket = "running"
  } else {
    bucket = sessions > 0 ? "ended" : "none"
  }
  var next = runtime
  next.bucket = bucket
  next.runningCount = running
  next.awaitingInputCount = awaiting
  next.endedCount = max(0, sessions - running - awaiting)
  next.sessionCount = sessions
  return next
}

/// A machine's lanes minus its main checkout when the machine is an ADE Cloud
/// lane computer: that computer exists for its one lane.
@MainActor
func laneSnapshotsWithoutCloudMainCheckout(_ snapshots: [LaneListSnapshot], machineKey: String?, sync: SyncService) -> [LaneListSnapshot] {
  guard sync.isCloudFleetKey(machineKey) else { return snapshots }
  return snapshots.filter { $0.lane.laneType != "primary" }
}

/// The focused machine's lane rows with badge counts by the Hub's rule, from
/// its live roster of the open project.
func laneSnapshotsByHubRule(_ snapshots: [LaneListSnapshot], roster: RemoteRosterProject?) -> [LaneListSnapshot] {
  guard let roster else { return snapshots }
  return snapshots.map { snapshot in
    var next = snapshot
    next.runtime = laneRuntimeByHubRule(snapshot.runtime, rosterLaneId: snapshot.lane.id, chats: roster.chats)
    return next
  }
}
