import SwiftUI

enum PrGitHubRoute: Hashable {
  case detail(String)
}

enum PrIntegrationRoute: Hashable {
  case detail(String)
}

enum PrQueueRoute: Hashable {
  case detail(String)
}

enum PrRebaseRoute: Hashable {
  case detail(String)
}

struct PRsRootView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService
  @Namespace private var prTransitionNamespace

  @State private var prs: [PullRequestListItem] = []
  @State private var prSnapshotsById: [String: PullRequestSnapshot] = [:]
  @State private var lanes: [LaneSummary] = []
  @State private var laneSnapshots: [LaneListSnapshot] = []
  @State private var integrationProposals: [IntegrationProposal] = []
  @State private var queueStates: [QueueLandingState] = []
  @State private var errorMessage: String?
  @State private var createPresented = false
  @State private var reloadTask: Task<Void, Never>?

  @State private var githubPath = NavigationPath()
  @State private var integrationPath = NavigationPath()
  @State private var queuePath = NavigationPath()
  @State private var rebasePath = NavigationPath()

  @SceneStorage("ade.prs.surface") private var surfaceRawValue = PrTopLevelSurface.github.rawValue
  @SceneStorage("ade.prs.workflowCategory") private var workflowCategoryRawValue = PrWorkflowCategory.integration.rawValue
  @SceneStorage("ade.prs.workflowView") private var workflowViewRawValue = PrWorkflowView.active.rawValue
  @SceneStorage("ade.prs.stateFilter") private var stateFilterRawValue = PrListStateFilter.open.rawValue
  @SceneStorage("ade.prs.sort") private var sortRawValue = PrListSortOption.updated.rawValue

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var isLive: Bool {
    prsStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !prs.isEmpty
  }

  private var selectedSurface: Binding<PrTopLevelSurface> {
    Binding(
      get: { PrTopLevelSurface(rawValue: surfaceRawValue) ?? .github },
      set: { surfaceRawValue = $0.rawValue }
    )
  }

  private var selectedWorkflowCategory: Binding<PrWorkflowCategory> {
    Binding(
      get: { PrWorkflowCategory(rawValue: workflowCategoryRawValue) ?? .integration },
      set: { workflowCategoryRawValue = $0.rawValue }
    )
  }

  private var selectedWorkflowView: Binding<PrWorkflowView> {
    Binding(
      get: { PrWorkflowView(rawValue: workflowViewRawValue) ?? .active },
      set: { workflowViewRawValue = $0.rawValue }
    )
  }

  private var selectedStateFilter: Binding<PrListStateFilter> {
    Binding(
      get: { PrListStateFilter(rawValue: stateFilterRawValue) ?? .open },
      set: { stateFilterRawValue = $0.rawValue }
    )
  }

  private var selectedSort: Binding<PrListSortOption> {
    Binding(
      get: { PrListSortOption(rawValue: sortRawValue) ?? .updated },
      set: { sortRawValue = $0.rawValue }
    )
  }

  private var stateCounts: [PrListStateFilter: Int] {
    pullRequestStateCounts(prs)
  }

  private var rebaseItems: [PrRebaseWorkflowItem] {
    buildRebaseWorkflowItems(from: laneSnapshots)
  }

  private var workflowCollections: PrWorkflowCollections {
    partitionWorkflowCollections(
      integrations: integrationProposals,
      queues: queueStates,
      rebaseItems: rebaseItems,
      laneSnapshots: laneSnapshots,
      view: selectedWorkflowView.wrappedValue
    )
  }

  var body: some View {
    VStack(spacing: 12) {
      surfacePicker
      surfaceContent
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .adeScreenBackground()
    .sensoryFeedback(.success, trigger: prs.count + integrationProposals.count + queueStates.count)
    .task {
      reloadTask?.cancel()
      reloadTask = Task { await reload(refreshRemote: true) }
    }
    .task(id: syncService.localStateRevision) {
      reloadTask?.cancel()
      reloadTask = Task { await reload() }
    }
    .onChange(of: syncService.requestedPrNavigation?.id) { _, requestId in
      guard requestId != nil, let prId = syncService.requestedPrNavigation?.prId else { return }
      surfaceRawValue = PrTopLevelSurface.github.rawValue
      githubPath = NavigationPath()
      githubPath.append(PrGitHubRoute.detail(prId))
      syncService.requestedPrNavigation = nil
    }
    .sheet(isPresented: $createPresented) {
      createSheet
    }
  }

  private var surfacePicker: some View {
    Picker("PR surface", selection: selectedSurface) {
      ForEach(PrTopLevelSurface.allCases) { surface in
        Text(surface.title).tag(surface)
      }
    }
    .pickerStyle(.segmented)
    .padding(.horizontal, 16)
    .padding(.top, 8)
  }

  @ViewBuilder
  private var surfaceContent: some View {
    switch selectedSurface.wrappedValue {
    case .github:
      PrGitHubSurfaceView(
        path: $githubPath,
        prs: prs,
        snapshotsById: prSnapshotsById,
        lanes: lanes,
        stateFilter: selectedStateFilter,
        sortOption: selectedSort,
        stateCounts: stateCounts,
        statusNotice: statusNotice,
        errorMessage: errorMessage,
        isLive: isLive,
        transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? prTransitionNamespace : nil,
        onCreatePr: { createPresented = true },
        onRefresh: { Task { await reload(refreshRemote: true) } },
        onOpenQueue: openQueueGroup,
        onOpenRebase: openRebaseLane
      )
    case .workflows:
      PrWorkflowsSurfaceView(
        workflowCategory: selectedWorkflowCategory,
        workflowView: selectedWorkflowView,
        integrationPath: $integrationPath,
        queuePath: $queuePath,
        rebasePath: $rebasePath,
        prs: prs,
        snapshotsById: prSnapshotsById,
        collections: workflowCollections,
        laneSnapshots: laneSnapshots,
        isLive: isLive,
        statusNotice: statusNotice,
        errorMessage: errorMessage,
        onRefresh: { Task { await reload(refreshRemote: true) } },
        onOpenPr: openPullRequest
      )
    }
  }

  private var createSheet: some View {
    CreatePrWizardView(
      lanes: lanes.filter { $0.laneType != "primary" },
      onCreateSingle: handleCreateSingle,
      onCreateQueue: handleCreateQueue,
      onCreateIntegration: handleCreateIntegration,
      onSimulateIntegration: { laneIds, baseBranch in
        try await syncService.simulateIntegration(sourceLaneIds: laneIds, baseBranch: baseBranch)
      }
    )
    .environmentObject(syncService)
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        do {
          try await syncService.refreshPullRequestSnapshots()
        } catch {
          if !Task.isCancelled { errorMessage = SyncUserFacingError.message(for: error) }
        }
        guard !Task.isCancelled else { return }
        do {
          try await syncService.refreshLaneSnapshots()
        } catch {
          if !Task.isCancelled { errorMessage = SyncUserFacingError.message(for: error) }
        }
        guard !Task.isCancelled else { return }
      }

      async let prsTask = syncService.fetchPullRequestListItems()
      async let snapshotsTask = syncService.fetchPullRequestSnapshotsById()
      async let lanesTask = syncService.fetchLanes()
      async let laneSnapshotsTask = syncService.fetchLaneListSnapshots()
      async let integrationTask = syncService.fetchIntegrationProposals()
      async let queueTask = syncService.fetchQueueStates()

      let fetchedPrs = try await prsTask
      let fetchedSnapshots = try await snapshotsTask
      let fetchedLanes = try await lanesTask
      let fetchedLaneSnapshots = try await laneSnapshotsTask
      let fetchedIntegrations = try await integrationTask
      let fetchedQueues = try await queueTask

      guard !Task.isCancelled else { return }

      prs = fetchedPrs
      prSnapshotsById = fetchedSnapshots
      lanes = fetchedLanes
      laneSnapshots = fetchedLaneSnapshots
      integrationProposals = fetchedIntegrations
      queueStates = fetchedQueues
      errorMessage = nil
    } catch {
      if !Task.isCancelled {
        errorMessage = SyncUserFacingError.message(for: error)
      }
    }
  }

  private func openQueueGroup(_ groupId: String) {
    surfaceRawValue = PrTopLevelSurface.workflows.rawValue
    workflowCategoryRawValue = PrWorkflowCategory.queue.rawValue
    queuePath = NavigationPath()
    queuePath.append(PrQueueRoute.detail(groupId))
  }

  private func openPullRequest(_ prId: String) {
    surfaceRawValue = PrTopLevelSurface.github.rawValue
    githubPath = NavigationPath()
    githubPath.append(PrGitHubRoute.detail(prId))
  }

  private func openRebaseLane(_ laneId: String) {
    surfaceRawValue = PrTopLevelSurface.workflows.rawValue
    workflowCategoryRawValue = PrWorkflowCategory.rebase.rawValue
    rebasePath = NavigationPath()
    rebasePath.append(PrRebaseRoute.detail(laneId))
  }

  private func handleCreateSingle(_ laneId: String, _ title: String, _ body: String, _ draft: Bool, _ baseBranch: String, _ labels: [String], _ reviewers: [String]) {
    Task {
      do {
        try await syncService.createPullRequest(
          laneId: laneId,
          title: title,
          body: body,
          draft: draft,
          baseBranch: baseBranch,
          labels: labels,
          reviewers: reviewers
        )
        createPresented = false
        await reload(refreshRemote: true)
      } catch {
        errorMessage = SyncUserFacingError.message(for: error)
      }
    }
  }

  private func handleCreateQueue(_ laneIds: [String], _ targetBranch: String, _ queueName: String, _ draft: Bool, _ autoRebase: Bool, _ ciGating: Bool) {
    Task {
      do {
        _ = try await syncService.createQueuePullRequests(
          laneIds: laneIds,
          targetBranch: targetBranch,
          queueName: queueName.isEmpty ? nil : queueName,
          draft: draft,
          autoRebase: autoRebase,
          ciGating: ciGating
        )
        createPresented = false
        surfaceRawValue = PrTopLevelSurface.workflows.rawValue
        workflowCategoryRawValue = PrWorkflowCategory.queue.rawValue
        workflowViewRawValue = PrWorkflowView.active.rawValue
        await reload(refreshRemote: true)
      } catch {
        errorMessage = SyncUserFacingError.message(for: error)
      }
    }
  }

  private func handleCreateIntegration(_ laneIds: [String], _ integrationLaneName: String, _ baseBranch: String, _ title: String, _ body: String, _ draft: Bool) {
    Task {
      do {
        _ = try await syncService.createIntegrationPullRequest(
          sourceLaneIds: laneIds,
          integrationLaneName: integrationLaneName,
          baseBranch: baseBranch,
          title: title,
          body: body,
          draft: draft
        )
        createPresented = false
        surfaceRawValue = PrTopLevelSurface.workflows.rawValue
        workflowCategoryRawValue = PrWorkflowCategory.integration.rawValue
        workflowViewRawValue = PrWorkflowView.active.rawValue
        await reload(refreshRemote: true)
      } catch {
        errorMessage = SyncUserFacingError.message(for: error)
      }
    }
  }

  private var statusNotice: ADENoticeCard? {
    switch prsStatus.phase {
    case .disconnected:
      return ADENoticeCard(
        title: prs.isEmpty ? "Host disconnected" : "Showing cached PRs",
        message: prs.isEmpty
          ? (syncService.activeHostProfile == nil
              ? "Pair with a host to hydrate pull requests, stacks, and workflow state."
              : "Reconnect to hydrate pull requests, stacks, and workflow state.")
          : (needsRepairing
              ? "Cached PR state is still visible, but the previous host trust was cleared. Pair again before trusting review or workflow status."
              : "Cached PR state is visible. Reconnect before trusting live merge, review, or queue readiness."),
        icon: "arrow.triangle.pull",
        tint: ADEColor.warning,
        actionTitle: syncService.activeHostProfile == nil ? (needsRepairing ? "Pair again" : "Pair with host") : "Reconnect",
        action: {
          if syncService.activeHostProfile == nil {
            syncService.settingsPresented = true
          } else {
            Task {
              await syncService.reconnectIfPossible()
              await reload(refreshRemote: true)
            }
          }
        }
      )
    case .hydrating:
      return ADENoticeCard(
        title: "Hydrating pull requests",
        message: "Refreshing PR summaries, stack relationships, and cached detail so iPhone does not show partial state.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.accent,
        actionTitle: nil,
        action: nil
      )
    case .syncingInitialData:
      return ADENoticeCard(
        title: "Syncing initial data",
        message: "Waiting for the host to finish syncing project data before PR hydration starts.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "PR hydration failed",
        message: prsStatus.lastError ?? "The host PR state did not hydrate cleanly.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      return nil
    }
  }
}
