import SwiftUI

// MARK: - Lane detail screen

struct LaneDetailScreen: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject var syncService: SyncService

  let laneId: String
  let initialSnapshot: LaneListSnapshot
  let allLaneSnapshots: [LaneListSnapshot]
  let onRefreshRoot: @MainActor () async -> Void

  @State var detail: LaneDetailPayload?
  @State var errorMessage: String?
  @State var busyAction: String?
  @State var selectedDiffRequest: LaneDiffRequest?
  @State var showStackGraph = false
  @State var managePresented = false
  @State var chatLaunchTarget: LaneChatLaunchTarget?
  @State var lanePullRequests: [PullRequestListItem] = []
  @State var headerExpanded = true
  @State var presentManageOnLoad = false
  @State var commitMessage = ""
  @State var amendCommit = false
  @State var stashMessage = ""
  @State var confirmForcePush = false
  @State var confirmDiscardFile: FileChange?

  init(
    laneId: String,
    initialSnapshot: LaneListSnapshot,
    allLaneSnapshots: [LaneListSnapshot],
    initialSection: LaneDetailSection = .git,
    onRefreshRoot: @escaping @MainActor () async -> Void
  ) {
    self.laneId = laneId
    self.initialSnapshot = initialSnapshot
    self.allLaneSnapshots = allLaneSnapshots
    self.onRefreshRoot = onRefreshRoot
    _presentManageOnLoad = State(initialValue: initialSection == .manage)
  }

  var currentSnapshot: LaneListSnapshot {
    allLaneSnapshots.first(where: { $0.lane.id == laneId }) ?? initialSnapshot
  }

  var body: some View {
    ScrollView {
      LazyVStack(spacing: 14) {
        if let banner = connectionBanner { banner }

        if let busyAction {
          HStack(spacing: 10) {
            ProgressView()
              .tint(ADEColor.accent)
            Text(busyAction.capitalized)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
            Spacer()
          }
          .adeGlassCard(cornerRadius: 12, padding: 12)
        }

        if let errorMessage {
          HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
              .foregroundStyle(ADEColor.danger)
            Text(errorMessage)
              .font(.footnote)
              .foregroundStyle(ADEColor.danger)
            Spacer()
          }
          .padding(12)
          .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }

        if detail == nil && errorMessage == nil {
          ADECardSkeleton(rows: 4)
        }

        detailHeader
        gitSections
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(detail?.lane.name ?? initialSnapshot.lane.name)
    .navigationBarTitleDisplayMode(.inline)
    .task { await loadDetail(refreshRemote: true) }
    .refreshable { await loadDetail(refreshRemote: true) }
    .sheet(item: $selectedDiffRequest) { request in
      LaneDiffScreen(request: request)
    }
    .sheet(isPresented: $showStackGraph) {
      LaneStackGraphSheet(snapshots: allLaneSnapshots, selectedLaneId: laneId)
    }
    .sheet(item: $chatLaunchTarget) { target in
      LaneChatLaunchSheet(laneId: laneId, provider: target.provider) { _ in
        await loadDetail(refreshRemote: true)
      }
    }
    .alert("Force push?", isPresented: $confirmForcePush) {
      Button("Force push", role: .destructive) {
        Task { await performAction("force push") { try await syncService.pushGit(laneId: laneId, forceWithLease: true) } }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This rewrites remote history. Other collaborators may lose work.")
    }
    .alert("Discard changes?", isPresented: Binding(
      get: { confirmDiscardFile != nil },
      set: { if !$0 { confirmDiscardFile = nil } }
    )) {
      Button("Discard", role: .destructive) {
        if let file = confirmDiscardFile {
          Task { await performAction("discard file") { try await syncService.discardFile(laneId: laneId, path: file.path) } }
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Unstaged changes to this file will be permanently lost.")
    }
    .sheet(isPresented: $managePresented) {
      LaneManageSheet(
        snapshot: currentSnapshot,
        allLaneSnapshots: allLaneSnapshots
      ) {
        await loadDetail(refreshRemote: true)
      }
    }
  }

  // MARK: - Detail helpers

  @ViewBuilder
  var detailHeader: some View {
    LaneDetailHeaderCard(
      snapshot: currentSnapshot,
      detail: detail,
      linkedPullRequests: lanePullRequests,
      isExpanded: headerExpanded,
      onToggleExpanded: {
        withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
          headerExpanded.toggle()
        }
      },
      onManageTapped: { managePresented = true },
      onStackTapped: { showStackGraph = true },
      onOpenLinkedPullRequest: { pr in
        openPullRequest(pr.id)
      }
    )
  }

  var connectionBanner: ADENoticeCard? {
    guard !canRunLiveActions else { return nil }
    return ADENoticeCard(
      title: "Offline — cached data",
      message: "Reconnect to refresh git state and lane actions.",
      icon: "icloud.slash",
      tint: ADEColor.warning,
      actionTitle: syncService.activeHostProfile == nil ? "Pair again" : "Reconnect",
      action: {
        if syncService.activeHostProfile == nil {
          syncService.settingsPresented = true
        } else {
          Task {
            await syncService.reconnectIfPossible()
            await loadDetail(refreshRemote: true)
          }
        }
      }
    )
  }

  var canRunLiveActions: Bool {
    syncService.connectionState == .connected || syncService.connectionState == .syncing
  }

  @MainActor
  func loadDetail(refreshRemote: Bool) async {
    let shouldPresentManageSheet = presentManageOnLoad && !managePresented
    do {
      if let cached = try await syncService.fetchLaneDetail(laneId: laneId) {
        detail = cached
      }
      if refreshRemote {
        let refreshed = try await syncService.refreshLaneDetail(laneId: laneId)
        detail = refreshed
        await onRefreshRoot()
      }
      lanePullRequests = (try? await syncService.fetchPullRequestListItems().filter { $0.laneId == laneId }) ?? []
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
    if shouldPresentManageSheet {
      managePresented = true
      presentManageOnLoad = false
    }
  }

  @MainActor
  func performAction(_ label: String, operation: () async throws -> Void) async {
    do {
      busyAction = label
      try await operation()
      await loadDetail(refreshRemote: true)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
    busyAction = nil
  }

  func runRebaseAndPush() async throws {
    try await syncService.startLaneRebase(laneId: laneId, scope: "lane_only", pushMode: "none")
    try? await syncService.fetchGit(laneId: laneId)
    let syncStatus = try await syncService.fetchSyncStatus(laneId: laneId)
    if syncStatus.hasUpstream == false {
      try await syncService.pushGit(laneId: laneId)
      return
    }
    if syncStatus.diverged && syncStatus.ahead > 0 {
      try await syncService.pushGit(laneId: laneId, forceWithLease: true)
      return
    }
    if syncStatus.ahead > 0 {
      try await syncService.pushGit(laneId: laneId)
    }
  }

  func openPullRequest(_ prId: String) {
    syncService.requestedPrNavigation = PrNavigationRequest(prId: prId)
  }

  @MainActor
  func openFiles(path: String? = nil) async {
    do {
      let workspaces = try await syncService.listWorkspaces()
      guard let workspace = workspaces.first(where: { $0.laneId == laneId }) else {
        errorMessage = "No Files workspace for this lane."
        return
      }
      syncService.requestedFilesNavigation = FilesNavigationRequest(
        workspaceId: workspace.id,
        relativePath: path
      )
    } catch {
      errorMessage = error.localizedDescription
    }
  }
}
