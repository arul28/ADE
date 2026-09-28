import Foundation

// PR ↔ lane links from the other paired machines, the way the desktop merges
// every machine's PRs (`prMachines.tsx`).
//
// The PR list stays GitHub-sourced: the focused machine's GitHub snapshot is
// the same repository everywhere. What the focused machine cannot know is that
// a PR's lane lives on another machine: that PR row sits in the other
// machine's `.ade` database. Each live machine answers `prs.list` for its
// checkout of the repository, and its lane ids come back namespaced
// (`workRemoteLaneId`), so every lane call made with one of them goes to that
// machine. Another machine's PR row id is never used: GitHub calls (merge,
// close, review, labels, checks) stay on the focused machine, by the PR's
// GitHub coordinates.
//
// Memory only: `ade.db` has no machine column. A machine with no live link
// gives no links, and its failure is never shown as an error.

/// A PR whose lane lives on another machine.
struct PrRemoteLaneLink: Equatable {
  let repoOwner: String
  let repoName: String
  let githubPrNumber: Int
  /// Namespaced lane id (`fleet|<machineKey>|<laneId>`).
  let laneId: String
  let laneName: String?
  let machineKey: String
  let machineName: String
}

/// The fields of a `prs.list` row that the merge needs.
struct PrRemoteSummaryRow: Decodable, Equatable {
  let laneId: String?
  let repoOwner: String
  let repoName: String
  let githubPrNumber: Int
  /// True for a row the host made from GitHub data alone, with no lane.
  let unmapped: Bool?
}

/// A machine a new lane from a PR can be created on.
struct PrLaneMachine: Identifiable, Equatable {
  /// The machine key, or "" for the focused machine.
  let id: String
  let name: String
  /// Where the create command goes: a machine-marked project id and the
  /// checkout's root. Nil for the focused machine.
  let targetProjectId: String?
  let targetRootPath: String?
  /// Chats running in the project on that machine: fewer is shown first.
  let runningCount: Int
}

/// What the PR screens know about the machines holding the focused repository.
struct PrMachineContext: Equatable {
  var focusedName: String
  /// Names of the other machines with a checkout, by machine key. Empty when
  /// the project is on one machine only: then no screen names a machine.
  var remoteNames: [String: String] = [:]
  /// Where a new lane can go, least busy first.
  var createMachines: [PrLaneMachine] = []

  static let single = PrMachineContext(focusedName: "This machine")

  var spansMachines: Bool { !remoteNames.isEmpty }

  /// The name of the machine a lane is on, or nil when the project is on one
  /// machine or there is no lane.
  func machineName(forLaneId laneId: String?) -> String? {
    guard spansMachines, let laneId, !laneId.isEmpty else { return nil }
    if let remote = workParseRemoteLaneId(laneId) { return remoteNames[remote.machineKey] }
    return focusedName
  }
}

func prRemoteLinkKey(repoOwner: String, repoName: String, githubPrNumber: Int) -> String {
  "\(repoOwner.lowercased())/\(repoName.lowercased())#\(githubPrNumber)"
}

/// The GitHub rows with the lanes other machines hold for them. A row the
/// focused machine links (a PR row or a lane) keeps its own link: a stale copy
/// elsewhere never overrides it. Among other machines the first link wins.
/// The row's `linkedPrId` stays nil: another machine's PR row id would reach
/// the focused machine, where it names nothing.
func prApplyRemoteLaneLinks(_ items: [GitHubPrListItem], links: [PrRemoteLaneLink]) -> [GitHubPrListItem] {
  guard !links.isEmpty else { return items }
  var byKey: [String: PrRemoteLaneLink] = [:]
  for link in links {
    let key = prRemoteLinkKey(repoOwner: link.repoOwner, repoName: link.repoName, githubPrNumber: link.githubPrNumber)
    if byKey[key] == nil { byKey[key] = link }
  }
  return items.map { item in
    guard item.linkedPrId == nil, item.linkedLaneId == nil, item.scope != "external" else { return item }
    let key = prRemoteLinkKey(repoOwner: item.repoOwner, repoName: item.repoName, githubPrNumber: item.githubPrNumber)
    guard let link = byKey[key] else { return item }
    var next = item
    next.linkedLaneId = link.laneId
    next.linkedLaneName = link.laneName
    return next
  }
}

/// The PRs tab's view of the other paired machines: each live machine's PR ↔
/// lane links for its checkout of the focused repository, and its lanes (for
/// linking a PR to one). Reads run only while the tab is visible, at most one
/// per machine at a time, each bounded, and never hold up the GitHub list.
@MainActor
final class PrRemoteMachinesModel: ObservableObject {
  struct Machine: Equatable, Identifiable {
    let machineKey: String
    let name: String
    /// The project id and root of the repository's checkout on that machine.
    let projectId: String
    let rootPath: String?
    let isLive: Bool
    let runningCount: Int
    /// Its lanes from the last roster, with namespaced ids. Empty when not live.
    let lanes: [LaneSummary]
    /// Its PR ↔ lane links. Empty when not live.
    let links: [PrRemoteLaneLink]
    var id: String { machineKey }
  }

  /// Same cadence and bound as the Lanes tab and the desktop union.
  static let refreshIntervalNanoseconds: UInt64 = 30_000_000_000
  static let readTimeoutNanoseconds: UInt64 = 8_000_000_000

  @Published private(set) var machines: [Machine] = []
  /// The last successful read of each machine: kept while a read fails and the
  /// machine is still live.
  private var lastRead: [String: [PrRemoteSummaryRow]] = [:]
  private var refreshing = false

  var links: [PrRemoteLaneLink] { machines.flatMap(\.links) }

  func link(repoOwner: String, repoName: String, githubPrNumber: Int) -> PrRemoteLaneLink? {
    let key = prRemoteLinkKey(repoOwner: repoOwner, repoName: repoName, githubPrNumber: githubPrNumber)
    return links.first {
      prRemoteLinkKey(repoOwner: $0.repoOwner, repoName: $0.repoName, githubPrNumber: $0.githubPrNumber) == key
    }
  }

  func refresh(sync: SyncService, fleet: MachineFleet) async {
    guard !refreshing else { return }
    refreshing = true
    defer { refreshing = false }
    let repos = sync.remoteReposForActiveProject()
    let liveKeys = Set(repos.map(\.machineKey).filter { fleet.connection(for: $0)?.isLive == true })
    var results: [String: [PrRemoteSummaryRow]] = [:]
    await withTaskGroup(of: (String, [PrRemoteSummaryRow]?).self) { group in
      for repo in repos where liveKeys.contains(repo.machineKey) {
        group.addTask { @MainActor in
          // A failed read keeps the last one; an offline machine is not an error.
          let rows = try? await sync.fetchRemotePullRequestRows(
            repo: repo,
            timeoutNanoseconds: Self.readTimeoutNanoseconds
          )
          return (repo.machineKey, rows)
        }
      }
      for await (machineKey, rows) in group {
        if let rows { results[machineKey] = rows }
      }
    }
    // The project or the fleet may have changed while the reads ran; build
    // from the repos as they are now.
    let current = sync.remoteReposForActiveProject()
    let currentKeys = Set(current.map(\.machineKey))
    lastRead = lastRead.filter { currentKeys.contains($0.key) }
    for (machineKey, rows) in results where currentKeys.contains(machineKey) {
      lastRead[machineKey] = rows
    }
    var next: [Machine] = []
    for repo in current {
      let isLive = fleet.connection(for: repo.machineKey)?.isLive == true
      if !isLive { lastRead[repo.machineKey] = nil }
      let lanes = isLive ? prRemoteRosterLanes(repo) : []
      let names = Dictionary(lanes.map { ($0.id, $0.name) }, uniquingKeysWith: { first, _ in first })
      let links: [PrRemoteLaneLink] = (lastRead[repo.machineKey] ?? []).compactMap { row in
        guard row.unmapped != true, let laneId = row.laneId, !laneId.isEmpty else { return nil }
        // The router namespaced the reply's lane ids; do it here too when an
        // id came back plain, so it can never reach the focused machine.
        let tagged = workParseRemoteLaneId(laneId) == nil
          ? workRemoteLaneId(machineKey: repo.machineKey, laneId: laneId)
          : laneId
        return PrRemoteLaneLink(
          repoOwner: row.repoOwner,
          repoName: row.repoName,
          githubPrNumber: row.githubPrNumber,
          laneId: tagged,
          laneName: names[tagged],
          machineKey: repo.machineKey,
          machineName: repo.machineName
        )
      }
      next.append(Machine(
        machineKey: repo.machineKey,
        name: repo.machineName,
        projectId: repo.projectId,
        rootPath: repo.rootPath,
        isLive: isLive,
        runningCount: fleet.machine(for: repo.machineKey)?.projects
          .first { $0.projectId == repo.projectId }?.runningCount ?? 0,
        lanes: lanes,
        links: links
      ))
    }
    if next != machines { machines = next }
  }

  func reset() {
    lastRead = [:]
    if !machines.isEmpty { machines = [] }
  }
}

/// A machine's lanes from its roster, with namespaced ids.
private func prRemoteRosterLanes(_ repo: WorkRemoteMachineRepo) -> [LaneSummary] {
  repo.lanes.map { rosterLane in
    var lane = rosterLane.asLaneSummary()
    lane.id = workRemoteLaneId(machineKey: repo.machineKey, laneId: rosterLane.id)
    return lane
  }
}
