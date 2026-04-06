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
  @State var createPresented = false
  @State var createMode: LaneCreateMode = .primary
  @State var attachPresented = false
  @State var openLaneIds: [String] = []
  @State var pinnedLaneIds = Set<String>()
  @State var primaryBranches: [GitBranchSummary] = []
  @State var primaryBranchLaneId: String?
  @State var primaryBranchError: String?
  @State var detailSheetTarget: LaneDetailSheetTarget?
  @State var batchManageLaneIds: [String] = []
  @State var batchManagePresented = false
  @State var refreshFeedbackToken = 0

  var laneStatus: SyncDomainStatus {
    syncService.status(for: .lanes)
  }

  var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !laneSnapshots.isEmpty
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(spacing: 14) {
          if let notice = statusNotice {
            notice
              .transition(.asymmetric(
                insertion: .move(edge: .top).combined(with: .opacity),
                removal: .opacity
              ))
          }
          quickActionsRow
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
          if let notice = primaryBranchNotice {
            notice
              .transition(.opacity)
          }
          if laneStatus.phase == .hydrating || laneStatus.phase == .syncingInitialData {
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
      .adeScreenBackground()
      .adeNavigationGlass()
      .scrollBounceBehavior(.basedOnSize)
      .searchable(text: $searchText, prompt: "Filter by lane, branch, is:dirty...")
      .navigationTitle("Lanes")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { toolbarContent }
      .refreshable { await refreshFromPullGesture() }
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task { await reload(refreshRemote: true) }
      .task(id: primaryLane?.id) {
        await refreshPrimaryBranches(force: true)
      }
      .task(id: syncService.localStateRevision) {
        guard laneStatus.phase == .ready else { return }
        await reload(refreshRemote: false)
      }
      .sheet(isPresented: $createPresented) {
        LaneCreateSheet(primaryLane: primaryLane, lanes: laneSnapshots.map(\.lane), initialMode: createMode) { createdLaneId in
          createPresented = false
          if !openLaneIds.contains(createdLaneId) {
            openLaneIds.insert(createdLaneId, at: 0)
          }
          await reload(refreshRemote: true)
        }
      }
      .sheet(isPresented: $attachPresented) {
        LaneAttachSheet { attachedLaneId in
          attachPresented = false
          if !openLaneIds.contains(attachedLaneId) {
            openLaneIds.insert(attachedLaneId, at: 0)
          }
          await reload(refreshRemote: true)
        }
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

      Menu {
        Button {
          createMode = .primary
          createPresented = true
        } label: {
          Label("New lane", systemImage: "plus.square")
        }
        Button {
          createMode = .child
          createPresented = true
        } label: {
          Label("Child lane", systemImage: "arrow.turn.up.right")
        }
        Button {
          createMode = .importBranch
          createPresented = true
        } label: {
          Label("Import branch", systemImage: "arrow.down.square")
        }
        Button {
          createMode = .rescueUnstaged
          createPresented = true
        } label: {
          Label("Rescue unstaged", systemImage: "bandage")
        }
        Button {
          attachPresented = true
        } label: {
          Label("Attach worktree", systemImage: "link")
        }
      } label: {
        Image(systemName: "plus.circle.fill")
          .symbolRenderingMode(.hierarchical)
      }
      .accessibilityLabel("Create or attach lane")
    }
  }

  @ViewBuilder
  private var quickActionsRow: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        LaneQuickAction(title: "New", symbol: "plus", tint: ADEColor.accent) {
          createMode = .primary
          createPresented = true
        }
        LaneQuickAction(title: "Import", symbol: "arrow.down.square", tint: ADEColor.accent) {
          createMode = .importBranch
          createPresented = true
        }
        LaneQuickAction(title: "Rescue", symbol: "bandage", tint: ADEColor.warning) {
          createMode = .rescueUnstaged
          createPresented = true
        }
        LaneQuickAction(title: "Attach", symbol: "link", tint: ADEColor.textSecondary) {
          attachPresented = true
        }
      }
      .padding(.vertical, 2)
    }
  }
}
