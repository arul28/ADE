import SwiftUI

/// What the PRs screen draws from `SyncService` and the fleet, narrowed so an
/// unrelated publish does not re-render it. While the tab is hidden only
/// navigation requests and the project are tracked.
struct PrsRootInputs: Equatable {
  var isActive = false
  var activeProjectId: String?
  var requestedPrNavigationId: String?
  // Tracked only while the tab is visible.
  var connectionState: RemoteConnectionState = .disconnected
  var prsStatus = SyncDomainStatus.disconnected
  var projectHostIsLive = false
  var suppressHydrationNotices = false
  var rootActionLabel: String?
  var supportsLink = false
  var supportsAutoMap = false
  var prsProjectionRevision = 0
  var prsRemoteRevision = 0
  var focusedMachineKey: String?
  var focusedMachineName = ""
  var focusedRunningCount = 0
  var liveMachineKeys: [String] = []
  /// The project's GitHub repository, read straight from GitHub, when its
  /// computer is not reachable and the account can read GitHub (spec 3.10).
  var directRepoOwner: String?
  var directRepoName: String?
  /// The computer the lane info waits for, from the account's copies.
  var directComputerName: String?

  @MainActor
  init(_ sync: SyncService, fleet: MachineFleet, isActive: Bool, rootActionKey: String) {
    self.isActive = isActive
    activeProjectId = sync.activeProjectId
    requestedPrNavigationId = sync.requestedPrNavigation?.id
    guard isActive else { return }
    connectionState = sync.connectionState
    prsStatus = sync.status(for: .prs)
    projectHostIsLive = sync.projectHostIsLive
    suppressHydrationNotices = sync.shouldSuppressDomainHydrationNotices
    rootActionLabel = sync.prActionLabel(forKey: rootActionKey)
    supportsLink = sync.supportsRemoteAction("prs.linkToLane")
    supportsAutoMap = sync.supportsRemoteAction("prs.createLaneFromPrBranch")
    prsProjectionRevision = sync.prsProjectionRevision
    prsRemoteRevision = sync.prsRemoteRevision
    focusedMachineKey = sync.focusedMachineKey
    focusedMachineName = sync.focusedMachineDisplayName
    focusedRunningCount = sync.activeProject.flatMap { sync.rosterProject(for: $0) }?.runningCount ?? 0
    liveMachineKeys = fleet.liveMachineKeys
    // Not connected covers a computer the phone is still trying to reach: an
    // offline computer stays "connecting" while the phone retries.
    if sync.connectionState != .connected,
       AccountService.shared.phase == .signedIn,
       GitHubAccountConnection.shared.state != .unsupported,
       let project = sync.activeProject {
      let accountProject = sync.accountProjectForActiveProject() ?? prsAccountProject(forFolder: project, sync: sync)
      if let owner = project.repoOwner, let name = project.repoName {
        directRepoOwner = owner
        directRepoName = name
      } else if let accountProject, accountProject.host == "github.com" {
        // A cached folder can lack its repository; its account project has it.
        directRepoOwner = accountProject.owner
        directRepoName = accountProject.name
      }
      // The computer that holds this folder, which can differ from the one
      // the phone tried last.
      if let rootPath = project.rootPath,
         let copy = accountProject?.copies.first(where: { $0.rootPath == rootPath }) {
        directComputerName = AccountService.shared.machines.first { $0.machineKey == copy.machineKey }?.presentedName
      }
    }
  }
}

/// The account project with a copy at `folder`'s path: on the focused
/// computer first, else the only project with a copy at that path. A folder
/// cached from an offline computer can carry neither its repository nor its
/// account id.
@MainActor
private func prsAccountProject(forFolder folder: MobileProjectSummary, sync: SyncService) -> AccountProject? {
  guard let rootPath = folder.rootPath, !rootPath.isEmpty else { return nil }
  let live = AccountProjectStore.shared.liveProjects
  if let machineKey = AccountService.shared.machine(forFleetKey: sync.focusedMachineKey)?.machineKey,
     let match = live.first(where: { $0.copies.contains { $0.machineKey == machineKey && $0.rootPath == rootPath } }) {
    return match
  }
  let atPath = live.filter { $0.copies.contains { $0.rootPath == rootPath } }
  return atPath.count == 1 ? atPath[0] : nil
}

/// The PRs tab: a thin shell over `PrsRootInputs`; the screen behind it is
/// `.equatable()` on them (the Work tab's pattern).
struct PRsTabShell: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @EnvironmentObject private var machineFleet: MachineFleet
  /// Sign-in and sign-out change whether the tab can read GitHub directly.
  @ObservedObject private var account = AccountService.shared
  @ObservedObject private var github = GitHubAccountConnection.shared
  var isActive = true

  var body: some View {
    PRsTabView(
      syncService: syncService,
      machineFleet: machineFleet,
      isActive: isActive,
      inputs: PrsRootInputs(syncService, fleet: machineFleet, isActive: isActive, rootActionKey: PRsTabView.rootActionKey)
    )
    .equatable()
  }
}
