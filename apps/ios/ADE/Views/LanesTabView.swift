import SwiftUI

// MARK: - Lanes tab

struct LanesTabView: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @EnvironmentObject var syncService: SyncService

  @State var laneSnapshots: [LaneListSnapshot] = []
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
  @State private var lastLanesLocalProjectionReload = Date.distantPast

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

  var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !laneSnapshots.isEmpty
  }

  var isConnected: Bool {
    switch syncService.connectionState {
    case .connected, .syncing: return true
    case .connecting, .disconnected, .error: return false
    }
  }

  var body: some View {
    NavigationStack {
      Group {
        if isConnected {
          ScrollView {
            LazyVStack(spacing: 14) {
              if let errorMessage, laneStatus.phase == .ready {
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
              if let primaryBranchError, laneStatus.phase == .ready {
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
              if laneSnapshots.isEmpty && (laneStatus.phase == .hydrating || laneStatus.phase == .syncingInitialData) {
                ADECardSkeleton(rows: 4)
                ADECardSkeleton(rows: 3)
              }
              if !openLaneSnapshots.isEmpty {
                openLanesTray
                  .transition(.move(edge: .top).combined(with: .opacity))
              }
              if !visibleSuggestions.isEmpty || !visibleAutoRebaseAttention.isEmpty {
                attentionSection
                  .transition(.move(edge: .top).combined(with: .opacity))
              }
              laneList
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
          }
          .scrollBounceBehavior(.basedOnSize)
          .searchable(text: $searchText, prompt: "Filter by lane, branch, is:dirty...")
          .refreshable { await refreshFromPullGesture() }
        } else {
          LanesOfflineEmptyState()
        }
      }
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Lanes")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbarContent }
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task { await reload() }
      .task(id: primaryLane?.id) {
        await refreshPrimaryBranches(force: true)
      }
      .task(id: syncService.localStateRevision) {
        guard laneStatus.phase == .ready else { return }
        let now = Date()
        guard now.timeIntervalSince(lastLanesLocalProjectionReload) >= 0.35 else { return }
        lastLanesLocalProjectionReload = now
        await reload(refreshRemote: false)
      }
      .onChange(of: syncService.connectionState) { oldValue, newValue in
        let wasOnline = oldValue == .connected || oldValue == .syncing
        let nowOnline = newValue == .connected || newValue == .syncing
        if wasOnline && !nowOnline {
          ADEHaptics.warning()
        }
      }
      .sheet(isPresented: $addLaneSheetPresented) {
        AddLaneSheet(
          primaryLane: primaryLane,
          lanes: laneSnapshots.map(\.lane),
          onLaneCreated: { createdLaneId in
            addLaneSheetPresented = false
            if !openLaneIds.contains(createdLaneId) {
              openLaneIds.insert(createdLaneId, at: 0)
            }
            await reload(refreshRemote: true)
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
            onRefreshRoot: { await reload(refreshRemote: true) }
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

  // MARK: - Toolbar

  @ToolbarContentBuilder
  private var toolbarContent: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      ADEConnectionDot()
    }
    ToolbarItemGroup(placement: .topBarTrailing) {
      Menu {
        Section("Scope") {
          ForEach(LaneListScope.allCases) { option in
            Button {
              scope = option
            } label: {
              Label(
                "\(option.title) (\(laneScopeCount(laneSnapshots, scope: option)))",
                systemImage: scope == option ? "checkmark.circle.fill" : "circle"
              )
            }
          }
        }
        Section("Runtime") {
          ForEach(LaneRuntimeFilter.allCases) { filter in
            Button {
              runtimeFilter = filter
            } label: {
              Label(
                "\(filter.title) (\(laneRuntimeCount(laneSnapshots, filter: filter)))",
                systemImage: runtimeFilter == filter ? "checkmark.circle.fill" : "circle"
              )
            }
          }
        }
        if manageableVisibleLaneIds.count > 1 {
          Section {
            Button {
              batchManageLaneIds = manageableVisibleLaneIds
              batchManagePresented = true
            } label: {
              Label("Manage visible lanes", systemImage: "slider.horizontal.3")
            }
          }
        }
        if let primaryLane {
          Section("Primary branch") {
            ForEach(primaryBranches) { branch in
              Button(branch.name) {
                Task {
                  do {
                    try await syncService.checkoutPrimaryBranch(laneId: primaryLane.id, branchName: branch.name)
                    await reload(refreshRemote: true)
                    await refreshPrimaryBranches(force: true)
                  } catch {
                    ADEHaptics.error()
                    primaryBranchError = error.localizedDescription
                  }
                }
              }
            }
          }
        }
      } label: {
        Image(systemName: "line.3.horizontal.decrease.circle")
          .symbolVariant(scope != .active || runtimeFilter != .all ? .fill : .none)
          .foregroundStyle(scope != .active || runtimeFilter != .all ? ADEColor.accent : ADEColor.textSecondary)
      }
      .accessibilityLabel("Lane filters")

      Button {
        addLaneSheetPresented = true
      } label: {
        Image(systemName: "plus")
          .font(.body.weight(.semibold))
          .foregroundStyle(ADEColor.accent)
      }
      .accessibilityLabel("Add lane")
    }
  }
}
