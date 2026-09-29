import SwiftUI

struct LanesTabView: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @EnvironmentObject var syncService: SyncService
  @EnvironmentObject var machineFleet: MachineFleet
  @StateObject var remoteLanes = LaneRemoteMachinesModel()
  @Namespace private var laneTransitionNamespace
  var isActive = true

  @State var laneSnapshots: [LaneListSnapshot] = []
  @State var pullRequests: [PullRequestListItem] = []
  @State var laneListPresentation = LaneListPresentation.empty
  @State var errorMessage: String?
  @State var searchText = ""
  @State var scope: LaneListScope = .active
  @State var runtimeFilter: LaneRuntimeFilter = .all
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
    guard isActive, let projectId = syncService.activeProjectId else { return nil }
    let live = machineFleet.machines.filter { $0.state == .live }.map(\.machineKey).sorted()
    return "\(projectId)|\(live.joined(separator: ","))"
  }

  var laneNavigationRequestKey: String? {
    guard isActive else { return nil }
    return syncService.requestedLaneNavigation?.id
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 14) {
          if !syncService.connectionState.isHostUnreachable,
            !syncService.shouldSuppressDomainHydrationNotices,
            let hydrationNotice = laneStatus.inlineHydrationFailureNotice(for: .lanes)
          {
            ADEInstructionErrorCard(
              notice: hydrationNotice,
              retry: { Task { await reload(refreshRemote: true) } }
            )
            .transition(.opacity)
          }
          if let errorMessage,
            laneStatus.phase == .ready,
            !syncService.connectionState.isHostUnreachable
          {
            ADENoticeCard(
              title: "Lane view error",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .transition(.opacity)
          }
          if let laneDeletionError = syncService.activeLaneDeletionError {
            ADENoticeCard(
              title: "Lane deletion failed",
              message: laneDeletionError,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Dismiss",
              action: { syncService.clearLaneDeletionFailure() }
            )
            .transition(.opacity)
          }
          if let primaryBranchError,
            laneStatus.phase == .ready,
            !syncService.connectionState.isHostUnreachable
          {
            ADENoticeCard(
              title: "Primary branch error",
              message: primaryBranchError,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await refreshPrimaryBranches(force: true) } }
            )
            .transition(.opacity)
          }
          if !syncService.connectionState.isHostUnreachable,
            let liveActionNoticePresentation
          {
            ADENoticeCard(
              title: liveActionNoticePresentation.title,
              message: liveActionNoticePresentation.message,
              icon: liveActionNoticePresentation.symbol,
              tint: ADEColor.warning,
              actionTitle: liveActionNoticePresentation.actionTitle,
              action: liveActionNoticePresentation.action.map { action in
                { handleNoticeAction(action) }
              }
            )
            .transition(.opacity)
          }
          if showsLaneLoadingSkeletons {
            ADECardSkeleton(rows: 4)
            ADECardSkeleton(rows: 3)
          }
          if !remoteLanes.machines.isEmpty {
            laneMachineFilterChips
          }
          if !openLaneSnapshots.isEmpty {
            openLanesTray
              .transition(.move(edge: .top).combined(with: .opacity))
          }
          laneList
        }
        .padding(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
      }
      .scrollBounceBehavior(.basedOnSize)
      .searchable(text: $searchText, prompt: "Filter by lane, branch, is:dirty...")
      .refreshable { await refreshFromPullGesture() }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.hidden, for: .navigationBar)
      .safeAreaInset(edge: .top, spacing: 0) {
        ADERootTopBar(title: "Lanes") {
          topBarActions
        }
      }
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
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
        remoteLanes.reset()
        machineFilter = .all
      }
      .task(id: laneNavigationRequestKey) {
        guard laneNavigationRequestKey != nil else { return }
        await handleRequestedLaneNavigation()
      }
      .onAppear {
        guard isActive, syncService.requestedLaneNavigation != nil else { return }
        Task { await handleRequestedLaneNavigation() }
      }
      .onChange(of: searchText) { _, _ in refreshLaneListPresentation() }
      .onChange(of: scope) { _, _ in refreshLaneListPresentation() }
      .onChange(of: runtimeFilter) { _, _ in refreshLaneListPresentation() }
      .onChange(of: pinnedLaneIdsStorage) { _, _ in refreshLaneListPresentation() }
      .onChange(of: syncService.laneGithubPrItems) { _, _ in refreshLaneListPresentation() }
      .onChange(of: syncService.pendingLaneDeletionIds) { _, _ in
        refreshLaneListPresentation()
        let pendingIds = syncService.pendingLaneDeletionIds
        openLaneIds.removeAll { pendingIds.contains($0) }
        if let selectedLaneTransitionId, pendingIds.contains(selectedLaneTransitionId) {
          self.selectedLaneTransitionId = nil
        }
      }
      .onChange(of: isActive) { _, active in
        guard active, syncService.requestedLaneNavigation != nil else { return }
        Task { await handleRequestedLaneNavigation() }
      }
      .onChange(of: syncService.requestedLaneNavigation?.id) { _, requestId in
        guard isActive, requestId != nil else { return }
        Task { await handleRequestedLaneNavigation() }
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

  @ViewBuilder
  private var topBarActions: some View {
    addLaneActionButton
  }

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

  @ViewBuilder
  func primaryBranchPickerMenu<Label: View>(@ViewBuilder label: () -> Label) -> some View {
    if let primaryLane, !primaryBranches.isEmpty {
      Menu {
        ForEach(primaryBranches) { branch in
          Button(branch.name) {
            Task {
              do {
                try await syncService.checkoutPrimaryBranch(
                  laneId: primaryLane.id,
                  branchName: branch.name,
                  mode: "existing",
                  startPoint: nil,
                  baseRef: nil,
                  acknowledgeActiveWork: false
                )
                await reload(refreshRemote: true)
                await refreshPrimaryBranches(force: true)
              } catch {
                ADEHaptics.error()
                primaryBranchError = error.localizedDescription
              }
            }
          }
          .disabled(!canRunLiveActions)
        }
      } label: {
        label()
      }
      .accessibilityLabel("Primary branch")
    }
  }
}

/// The Lanes tab's "+ Lane" button, in the root top bar.
struct LaneAddButton: View {
  let enabled: Bool
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: "plus")
          .font(.system(size: 13, weight: .bold))
        Text("Lane")
          .font(.subheadline.weight(.semibold))
      }
      .foregroundStyle(.white)
      .padding(.horizontal, 12)
      .frame(height: 36)
      .background(ADEColor.accent, in: Capsule(style: .continuous))
      .glassEffect(in: .capsule)
      .overlay(Capsule(style: .continuous).stroke(.white.opacity(0.18), lineWidth: 0.6))
      .shadow(color: ADEColor.accent.opacity(0.35), radius: 8, x: 0, y: 3)
    }
    .buttonStyle(.plain)
    .opacity(enabled ? 1 : 0.55)
    .accessibilityLabel("Add lane")
    .accessibilityHint(enabled ? "Opens lane creation options" : "Reconnect to machine before creating lanes")
  }
}
