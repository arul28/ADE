import SwiftUI

/// What the Lanes screen draws from `SyncService` and the machine fleet,
/// narrowed so a publish that changes none of it does not re-render the tab.
/// While the tab is hidden only navigation requests and the project are
/// tracked: a hidden tab used to re-render on every sync publish (~190 body
/// passes in a minute on the PRs tab).
struct LanesRootInputs: Equatable {
  var isActive = false
  var activeProjectId: String?
  var requestedLaneNavigationId: String?
  // Tracked only while the tab is visible.
  var connectionState: RemoteConnectionState = .disconnected
  var laneStatus = SyncDomainStatus.disconnected
  var suppressHydrationNotices = false
  var activeLaneDeletionError: String?
  var lanesProjectionRevision = 0
  var laneGithubPrItems: [GitHubPrListItem] = []
  var pendingLaneDeletionIds: Set<String> = []
  var focusedMachineKey: String?
  var focusedMachineName = ""
  var hasHostProfile = false
  var liveMachineKeys: [String] = []

  @MainActor
  init(_ sync: SyncService, fleet: MachineFleet, isActive: Bool) {
    self.isActive = isActive
    activeProjectId = sync.activeProjectId
    requestedLaneNavigationId = sync.requestedLaneNavigation?.id
    guard isActive else { return }
    connectionState = sync.connectionState
    laneStatus = sync.status(for: .lanes)
    suppressHydrationNotices = sync.shouldSuppressDomainHydrationNotices
    activeLaneDeletionError = sync.activeLaneDeletionError
    lanesProjectionRevision = sync.lanesProjectionRevision
    laneGithubPrItems = sync.laneGithubPrItems
    pendingLaneDeletionIds = sync.pendingLaneDeletionIds
    focusedMachineKey = sync.focusedMachineKey
    focusedMachineName = sync.focusedMachineDisplayName
    hasHostProfile = sync.activeHostProfile != nil
    liveMachineKeys = fleet.liveMachineKeys
  }
}

/// The Lanes tab: a thin shell that turns `SyncService`'s publishes into
/// `LanesRootInputs`; the screen behind it is `.equatable()` on them (the
/// Work tab's pattern).
struct LanesTabShell: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }
  @EnvironmentObject private var machineFleet: MachineFleet
  var isActive = true

  var body: some View {
    LanesTabView(
      syncService: syncService,
      machineFleet: machineFleet,
      isActive: isActive,
      inputs: LanesRootInputs(syncService, fleet: machineFleet, isActive: isActive)
    )
    .equatable()
  }
}

struct LanesTabView: View, Equatable {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @Environment(\.duoLayout) var duoLayout
  /// Deliberately not observed: what the body draws arrives in `inputs`.
  let syncService: SyncService
  let machineFleet: MachineFleet
  @StateObject var remoteLanes = LaneRemoteMachinesModel()
  @Namespace private var laneTransitionNamespace
  let isActive: Bool
  let inputs: LanesRootInputs

  nonisolated static func == (lhs: LanesTabView, rhs: LanesTabView) -> Bool {
    lhs.isActive == rhs.isActive && lhs.inputs == rhs.inputs
  }

  @State var laneSnapshots: [LaneListSnapshot] = []
  @State var pullRequests: [PullRequestListItem] = []
  @State var laneListPresentation = LaneListPresentation.empty
  @State var errorMessage: String?
  @State var searchText = ""
  @State var quickFilter: LaneQuickFilter = .active
  @State var lanePath = NavigationPath()
  /// The lane the Duo's inner display shows in its detail column. A selection,
  /// not a push: changing it replaces the detail instead of stacking.
  @State var duoSelectedLaneId: String?
  @State var addLaneSheetPresented = false
  @State var openLaneIds: [String] = []
  @AppStorage("ade.lanes.pinnedIds") private var pinnedLaneIdsStorage: String = ""
  @State var primaryBranches: [GitBranchSummary] = []
  @State var primaryBranchLaneId: String?
  @State var primaryBranchError: String?
  @State var detailSheetTarget: LaneDetailSheetTarget?
  @State var batchManageLaneIds: [String] = []
  @State var batchManagePresented = false
  @State var refreshFeedbackToken = 0
  @State var selectedLaneTransitionId: String?
  @State private var lastLanesLocalProjectionReload = Date.distantPast
  @State private var lastHandledLanesProjectionRevision: Int?
  /// Which machines' lanes the list shows (the filter chips).
  @State var machineFilter: LaneMachineFilter = .all
  /// Live lane actions have been waiting long enough to say so (see
  /// `liveActionNoticePresentation`).
  @State var laneLiveActionWaitIsLong = false

  var scope: LaneListScope { quickFilter.scope }

  var pinnedLaneIds: Set<String> {
    get {
      Set(pinnedLaneIdsStorage.split(separator: ",").map(String.init).filter { !$0.isEmpty })
    }
    nonmutating set {
      pinnedLaneIdsStorage = newValue.sorted().joined(separator: ",")
    }
  }

  var laneStatus: SyncDomainStatus {
    syncService.status(for: .lanes)
  }

  var canRunLiveActions: Bool {
    laneAllowsLiveActions(connectionState: syncService.connectionState, laneStatus: laneStatus)
  }

  var transitionNamespace: Namespace.ID? {
    ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? laneTransitionNamespace : nil
  }

  var lanesProjectionReloadKey: Int? {
    isActive ? syncService.lanesProjectionRevision : nil
  }

  var primaryBranchReloadKey: String? {
    guard isActive else { return nil }
    return "\(primaryLane?.id ?? "none")-\(canRunLiveActions)"
  }

  /// Re-read the other machines while the tab is visible, for the focused
  /// project, and again when a machine's live link comes or goes.
  var remoteLanesPollKey: String? {
    guard isActive, let projectId = inputs.activeProjectId else { return nil }
    return "\(projectId)|\(inputs.liveMachineKeys.joined(separator: ","))"
  }

  var laneNavigationRequestKey: String? {
    guard isActive else { return nil }
    return syncService.requestedLaneNavigation?.id
  }

  var body: some View {
    let _ = ScrollDiagnostics.shared.count(.lanesBody)
    Group {
      // The Duo's inner display has room for the list beside a lane's detail;
      // every other size keeps the phone's push navigation.
      if duoLayout.isWide {
        duoLanesSplitBody
      } else {
        lanesPhoneBody
      }
    }
    .sensoryFeedback(.success, trigger: refreshFeedbackToken)
    // Folding keeps the lane on screen: the split's selected lane is pushed
    // when the window turns compact, and a phone's pop clears the selection.
    .onChange(of: duoLayout.isWide) { _, wide in
      if wide {
        lanePath = NavigationPath()
      } else if let laneId = duoSelectedLaneId {
        lanePath = NavigationPath([LaneRoute(laneId: laneId)])
      }
    }
    .onChange(of: lanePath.count) { _, count in
      if !duoLayout.isWide, count == 0 { duoSelectedLaneId = nil }
    }
    // Times the "Waiting for live lane actions" notice: shown only if the wait
    // outlasts the routine re-sync a visit starts.
    .task(id: isActive && laneLiveActionsWaiting) {
      laneLiveActionWaitIsLong = false
      guard isActive, laneLiveActionsWaiting else { return }
      try? await Task.sleep(for: .seconds(4))
      guard !Task.isCancelled else { return }
      laneLiveActionWaitIsLong = true
    }
    .task(id: primaryBranchReloadKey) {
      guard primaryBranchReloadKey != nil else { return }
      await refreshPrimaryBranches(force: false)
    }
    .task(id: lanesProjectionReloadKey) {
      guard let revision = lanesProjectionReloadKey else { return }
      guard lastHandledLanesProjectionRevision != revision || laneSnapshots.isEmpty else { return }
      let now = Date()
      if !laneSnapshots.isEmpty {
        let elapsed = now.timeIntervalSince(lastLanesLocalProjectionReload)
        if elapsed < 0.35 {
          try? await Task.sleep(for: .milliseconds(max(1, Int((0.35 - elapsed) * 1_000))))
          guard !Task.isCancelled, lanesProjectionReloadKey == revision else { return }
        }
      }
      lastLanesLocalProjectionReload = Date()
      await reload(refreshRemote: false)
      guard !Task.isCancelled, lanesProjectionReloadKey == revision else { return }
      lastHandledLanesProjectionRevision = revision
    }
    .task(id: remoteLanesPollKey) {
      guard remoteLanesPollKey != nil else { return }
      while !Task.isCancelled {
        await remoteLanes.refresh(sync: syncService, fleet: machineFleet)
        try? await Task.sleep(nanoseconds: LaneRemoteMachinesModel.refreshIntervalNanoseconds)
      }
    }
    .onChange(of: syncService.activeProjectId) { _, _ in
      // The tab stays mounted across a project switch: drop the previous
      // project's lanes so they never show while the new project loads.
      remoteLanes.reset()
      machineFilter = .all
      laneSnapshots = []
      pullRequests = []
      laneListPresentation = .empty
      openLaneIds = []
      primaryBranches = []
      primaryBranchLaneId = nil
      selectedLaneTransitionId = nil
      duoSelectedLaneId = nil
      errorMessage = nil
      lanePath = NavigationPath()
    }
    // Keyed on the tab being active and the request id, so it runs on
    // appear, when the tab comes forward, and for each new request.
    .task(id: laneNavigationRequestKey) {
      guard laneNavigationRequestKey != nil else { return }
      await handleRequestedLaneNavigation()
    }
    .onChange(of: searchText) { _, _ in refreshLaneListPresentation() }
    .onChange(of: quickFilter) { _, _ in refreshLaneListPresentation() }
    .onChange(of: pinnedLaneIdsStorage) { _, _ in refreshLaneListPresentation() }
    .onChange(of: syncService.laneGithubPrItems) { _, _ in refreshLaneListPresentation() }
    .onChange(of: syncService.pendingLaneDeletionIds) { _, _ in
      refreshLaneListPresentation()
      let pendingIds = syncService.pendingLaneDeletionIds
      openLaneIds.removeAll { pendingIds.contains($0) }
      if let selectedLaneTransitionId, pendingIds.contains(selectedLaneTransitionId) {
        self.selectedLaneTransitionId = nil
      }
      if let duoSelectedLaneId, pendingIds.contains(duoSelectedLaneId) {
        self.duoSelectedLaneId = nil
      }
    }
    .onChange(of: syncService.connectionState) { oldValue, newValue in
      guard isActive else { return }
      let wasOnline = oldValue == .connected
      let nowOnline = newValue == .connected
      if wasOnline && !nowOnline {
        ADEHaptics.warning()
      }
    }
    .sheet(isPresented: $addLaneSheetPresented) {
      AddLaneSheet(
        machines: laneCreateMachines,
        onLaneCreated: { createdLaneId in
          addLaneSheetPresented = false
          if !openLaneIds.contains(createdLaneId) {
            openLaneIds.insert(createdLaneId, at: 0)
          }
          if isWorkRemoteLaneId(createdLaneId) {
            await remoteLanes.refresh(sync: syncService, fleet: machineFleet)
          } else {
            await reload(refreshRemote: true)
          }
        }
      )
    }
    .sheet(item: $detailSheetTarget) { target in
      NavigationStack {
        LaneDetailScreen(
          laneId: target.laneId,
          initialSnapshot: target.snapshot,
          allLaneSnapshots: laneSnapshots,
          initialSection: target.initialSection,
          onRefreshRoot: { await reload(refreshRemote: true, includeDecorations: false) }
        )
      }
    }
    .sheet(isPresented: $batchManagePresented) {
      LaneBatchManageSheet(
        snapshots: laneSnapshots.filter { batchManageLaneIds.contains($0.lane.id) }
      ) {
        await reload(refreshRemote: true)
      }
    }
  }

  /// The phone layout: the same list as the inner display's left column,
  /// with each lane's detail (the same Overview | Git screen) pushed on top.
  private var lanesPhoneBody: some View {
    NavigationStack(path: $lanePath) {
      lanesListContent
        .navigationDestination(for: LaneRoute.self) { route in
          laneDestination(route)
        }
    }
  }

  /// The machines a new lane can go to: this project's checkout on the
  /// focused machine and on every live machine, least busy first.
  var laneCreateMachines: [LaneCreateMachine] {
    var machines = [LaneCreateMachine(
      id: "",
      name: focusedMachineName,
      primaryLane: primaryLane,
      lanes: laneSnapshots.map(\.lane),
      target: nil,
      runningCount: laneSnapshots.reduce(0) { $0 + $1.runtime.runningCount }
    )]
    for machine in remoteLanes.machines where machine.isLive {
      machines.append(LaneCreateMachine(
        id: machine.machineKey,
        name: machine.name,
        primaryLane: machine.snapshots.first { $0.lane.laneType == "primary" }?.lane,
        lanes: machine.snapshots.map(\.lane),
        target: LaneCreateTarget(projectId: machine.markedProjectId, rootPath: machine.rootPath),
        runningCount: machine.snapshots.reduce(0) { $0 + $1.runtime.runningCount }
      ))
    }
    return machineChoicesLeastBusyFirst(machines, runningCount: \.runningCount)
  }

  // MARK: - Top bar

  /// In the top bar, beside the hub back button and the activity bell.
  var addLaneActionButton: some View {
    LaneAddButton(enabled: canRunLiveActions) {
      if canRunLiveActions {
        addLaneSheetPresented = true
      } else {
        handleBlockedLiveAction()
      }
    }
  }
}

/// The Lanes tab's add-lane button, in the root top bar: the Hub's quiet
/// round add button.
struct LaneAddButton: View {
  let enabled: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      ADEKitCircleIcon(systemImage: "plus")
    }
    .buttonStyle(.plain)
    .opacity(enabled ? 1 : 0.55)
    .accessibilityLabel("Add lane")
    .accessibilityHint(enabled ? "Opens lane creation options" : "Reconnect to machine before creating lanes")
  }
}
