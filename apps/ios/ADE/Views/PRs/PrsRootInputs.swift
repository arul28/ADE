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
  }
}

/// The PRs tab: a thin shell over `PrsRootInputs`; the screen behind it is
/// `.equatable()` on them (the Work tab's pattern).
struct PRsTabShell: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @EnvironmentObject private var machineFleet: MachineFleet
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
