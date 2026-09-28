import Foundation

/// The Lanes tab's rows from the other paired machines: the focused
/// repository's lanes on every machine that has a checkout of it, the way the
/// desktop's Lanes tab lists every machine (`crossMachineLanes.ts`).
///
/// A live machine answers `lanes.refreshSnapshots` over its roster link (the
/// same rows the focused machine's list shows, with namespaced lane ids). A
/// machine with no live link shows the lanes its last roster named, dimmed and
/// with no actions. Reads run only while the tab is visible, at most one per
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
  }

  /// Same cadence and bound as the desktop union (`crossMachineLanes.ts`).
  static let refreshIntervalNanoseconds: UInt64 = 30_000_000_000
  static let readTimeoutNanoseconds: UInt64 = 8_000_000_000

  @Published private(set) var machines: [MachineLanes] = []
  /// The last successful read of each machine: shown while a read runs or
  /// after it fails.
  private var lastRead: [String: [LaneListSnapshot]] = [:]
  private var refreshing = false

  func refresh(sync: SyncService, fleet: MachineFleet) async {
    guard !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    let repos = sync.remoteReposForActiveProject()
    let liveKeys = Set(repos.map(\.machineKey).filter { fleet.connection(for: $0)?.isLive == true })
    var results: [String: Result<[LaneListSnapshot], Error>] = [:]
    await withTaskGroup(of: (String, Result<[LaneListSnapshot], Error>).self) { group in
      for repo in repos where liveKeys.contains(repo.machineKey) {
        group.addTask { @MainActor in
          do {
            let snapshots = try await sync.fetchRemoteLaneSnapshots(
              repo: repo,
              timeoutNanoseconds: Self.readTimeoutNanoseconds
            )
            return (repo.machineKey, .success(snapshots))
          } catch {
            return (repo.machineKey, .failure(error))
          }
        }
      }
      for await (machineKey, result) in group {
        results[machineKey] = result
      }
    }
    // The project or the fleet may have changed while the reads ran; build
    // from the repos as they are now.
    let current = sync.remoteReposForActiveProject()
    let currentKeys = Set(current.map(\.machineKey))
    lastRead = lastRead.filter { currentKeys.contains($0.key) }
    var next: [MachineLanes] = []
    for repo in current {
      let isLive = fleet.connection(for: repo.machineKey)?.isLive == true
      var error: String?
      switch results[repo.machineKey] {
      case .success(let snapshots)?:
        lastRead[repo.machineKey] = snapshots
      case .failure(let failure)?:
        error = SyncUserFacingError.message(for: failure)
      case nil:
        break
      }
      let snapshots = isLive
        ? (lastRead[repo.machineKey] ?? laneRemoteRosterSnapshots(repo))
        : laneRemoteRosterSnapshots(repo)
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
    lastRead = [:]
    if !machines.isEmpty { machines = [] }
  }
}

/// Lane rows from a machine's roster alone: name, branch, color and type.
func laneRemoteRosterSnapshots(_ repo: WorkRemoteMachineRepo) -> [LaneListSnapshot] {
  repo.lanes.map { rosterLane in
    var lane = rosterLane.asLaneSummary()
    lane.id = workRemoteLaneId(machineKey: repo.machineKey, laneId: rosterLane.id)
    return LaneListSnapshot(lane: lane, runtime: syncRemoteLaneEmptyRuntime)
  }
}
