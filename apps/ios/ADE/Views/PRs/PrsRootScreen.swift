import SwiftUI
import UIKit

struct PRsTabView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService
  @Namespace private var prTransitionNamespace

  @State private var path = NavigationPath()
  @State private var prs: [PullRequestListItem] = []
  @State private var lanes: [LaneSummary] = []
  @State private var laneSnapshots: [LaneListSnapshot] = []
  @State private var integrationProposals: [IntegrationProposal] = []
  @State private var queueStates: [QueueLandingState] = []
  @State private var mobileSnapshot: PrMobileSnapshot?
  @State private var errorMessage: String?
  @State private var createPresented = false
  @State private var stackPresentation: PrStackPresentation?
  @State private var refreshFeedbackToken = 0
  @State private var lastPrsLocalProjectionReload = Date.distantPast
  @State private var selectedPrTransitionId: String?
  @State private var laneContextLaneId: String?
  @SceneStorage("ade.prs.stateFilter") private var stateFilterRawValue = PrListStateFilter.all.rawValue
  @State private var searchText = ""

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var isLive: Bool {
    prsStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !prs.isEmpty
  }

  private var isLoadingSkeleton: Bool {
    prsStatus.phase == .hydrating || prsStatus.phase == .syncingInitialData
  }

  private var selectedStateFilter: Binding<PrListStateFilter> {
    Binding(
      get: { PrListStateFilter(rawValue: stateFilterRawValue) ?? .all },
      set: { stateFilterRawValue = $0.rawValue }
    )
  }

  private var filteredPrs: [PullRequestListItem] {
    filterPullRequestListItems(prs, query: searchText, state: selectedStateFilter.wrappedValue)
  }

  /// Prefer the unified `PrMobileSnapshot.workflowCards` payload when available; fall back to the
  /// legacy per-kind fetches (integrationProposals / queueStates / laneSnapshots-derived rebase)
  /// so offline cached state still renders if the mobile snapshot fetch failed.
  private var workflowCards: [PrWorkflowCard] {
    if let mobileSnapshot {
      return mobileSnapshot.workflowCards
    }
    return legacyWorkflowCards
  }

  private var legacyWorkflowCards: [PrWorkflowCard] {
    var cards: [PrWorkflowCard] = []

    for proposal in integrationProposals {
      cards.append(legacyIntegrationCard(from: proposal))
    }
    for queue in queueStates {
      cards.append(legacyQueueCard(from: queue))
    }
    for item in rebaseWorkflowItems {
      cards.append(legacyRebaseCard(from: item))
    }

    return cards
  }

  private var rebaseWorkflowItems: [PrRebaseWorkflowItem] {
    laneSnapshots.compactMap { snapshot in
      guard let suggestion = snapshot.rebaseSuggestion, suggestion.dismissedAt == nil else { return nil }
      let severity: String
      if snapshot.autoRebaseStatus?.state == "rebaseConflict" {
        severity = "critical"
      } else if suggestion.behindCount >= 10 {
        severity = "warning"
      } else {
        severity = "info"
      }

      let message = snapshot.autoRebaseStatus?.message
        ?? "\(snapshot.lane.name) is \(suggestion.behindCount) commit\(suggestion.behindCount == 1 ? "" : "s") behind its parent lane."

      return PrRebaseWorkflowItem(
        laneId: snapshot.lane.id,
        laneName: snapshot.lane.name,
        branchRef: snapshot.lane.branchRef,
        behindCount: suggestion.behindCount,
        severity: severity,
        statusMessage: message,
        deferredUntil: suggestion.deferredUntil
      )
    }
    .sorted { lhs, rhs in
      if lhs.severity == rhs.severity {
        return lhs.behindCount > rhs.behindCount
      }
      return severityRank(lhs.severity) < severityRank(rhs.severity)
    }
  }

  private var canCreatePr: Bool {
    if let createCaps = mobileSnapshot?.createCapabilities {
      return createCaps.canCreateAny && isLive
    }
    return isLive && !lanes.isEmpty
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let statusNotice {
          statusNotice.prListRow()
        }

        if let notice = laneContextNotice {
          notice.prListRow()
        }

        if isLoadingSkeleton {
          ForEach(0..<3, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .prListRow()
          }
        } else {
          PrFiltersCard(
            stateFilter: selectedStateFilter,
            visibleCount: filteredPrs.count,
            totalCount: prs.count,
            isLive: isLive,
            onRefresh: { Task { await reload(refreshRemote: true) } }
          )
          .prListRow()

          if let errorMessage, prsStatus.phase == .ready {
            ADENoticeCard(
              title: "PR view error",
              message: errorMessage,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .prListRow()
          }

          if prsStatus.phase == .ready && filteredPrs.isEmpty {
            ADEEmptyStateView(
              symbol: searchText.isEmpty ? "arrow.triangle.pull" : "magnifyingglass",
              title: searchText.isEmpty ? "No pull requests on this host" : "No PRs match this search",
              message: searchText.isEmpty
                ? "Open PRs and workflow lanes will appear here once the host syncs GitHub state to iPhone."
                : "Try a broader title query or switch the state filter."
            )
            .prListRow()
          }

          if !filteredPrs.isEmpty {
            Section("Pull requests") {
              ForEach(filteredPrs) { pr in
                NavigationLink(value: pr.id) {
                  PrRowCard(
                    pr: pr,
                    transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? prTransitionNamespace : nil,
                    isSelectedTransitionSource: selectedPrTransitionId == pr.id
                  ) { groupId, groupName in
                    stackPresentation = PrStackPresentation(id: groupId, groupName: groupName)
                  }
                }
                .simultaneousGesture(TapGesture().onEnded {
                  selectedPrTransitionId = pr.id
                })
                .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                  rowSwipeActions(for: pr)
                }
                .prListRow()
              }
            }
          }

          ForEach(Array(groupedWorkflowCards.enumerated()), id: \.offset) { _, group in
            Section(group.title) {
              ForEach(group.cards) { card in
                PrMobileWorkflowCardView(
                  card: card,
                  isLive: isLive,
                  onOpenPr: { prId in path.append(prId) },
                  onLand: { prId, method in
                    Task {
                      try? await syncService.mergePullRequest(prId: prId, method: method.rawValue)
                      await reload(refreshRemote: true)
                    }
                  },
                  onRebaseLane: { laneId in
                    Task {
                      try? await syncService.startLaneRebase(laneId: laneId)
                      await reload(refreshRemote: true)
                    }
                  },
                  onDeferRebase: { laneId in
                    Task {
                      try? await syncService.deferRebaseSuggestion(laneId: laneId)
                      await reload(refreshRemote: true)
                    }
                  },
                  onDismissRebase: { laneId in
                    Task {
                      try? await syncService.dismissRebaseSuggestion(laneId: laneId)
                      await reload(refreshRemote: true)
                    }
                  }
                )
                .prListRow()
              }
            }
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("PRs")
      .navigationBarTitleDisplayMode(.inline)
      .searchable(text: $searchText, prompt: "Search PR titles")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          ADEConnectionPill()
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button {
            Task { await reload(refreshRemote: true) }
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .accessibilityLabel("Refresh pull requests")
          .disabled(prsStatus.phase == .hydrating)

          Button {
            createPresented = true
          } label: {
            Image(systemName: "plus")
          }
          .accessibilityLabel("Create pull request")
          .disabled(!canCreatePr)
        }
      }
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task {
        await reload()
      }
      .task(id: syncService.localStateRevision) {
        let now = Date()
        guard now.timeIntervalSince(lastPrsLocalProjectionReload) >= 0.35 else { return }
        lastPrsLocalProjectionReload = now
        await reload()
      }
      .refreshable {
        await refreshFromPullGesture()
      }
      .onChange(of: syncService.requestedPrNavigation?.id) { _, requestId in
        guard requestId != nil, let prId = syncService.requestedPrNavigation?.prId else { return }
        stateFilterRawValue = PrListStateFilter.all.rawValue
        selectedPrTransitionId = prId
        laneContextLaneId = syncService.requestedPrNavigation?.laneId
        path = NavigationPath()
        path.append(prId)
        syncService.requestedPrNavigation = nil
      }
      .navigationDestination(for: String.self) { prId in
        PrDetailView(
          prId: prId,
          transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? prTransitionNamespace : nil
        )
          .environmentObject(syncService)
      }
      .sheet(isPresented: $createPresented) {
        CreatePrWizardView(
          lanes: lanes,
          createCapabilities: mobileSnapshot?.createCapabilities
        ) { laneId, title, body, draft, baseBranch, labels, reviewers in
          Task {
            try? await syncService.createPullRequest(
              laneId: laneId,
              title: title,
              body: body,
              draft: draft,
              baseBranch: baseBranch,
              labels: labels,
              reviewers: reviewers
            )
            try? await syncService.refreshPullRequestSnapshots()
            createPresented = false
            await reload()
          }
        }
        .environmentObject(syncService)
      }
      .sheet(item: $stackPresentation) { presentation in
        PrStackSheet(groupId: presentation.id, groupName: presentation.groupName)
          .environmentObject(syncService)
      }
    }
  }

  @ViewBuilder
  private func rowSwipeActions(for pr: PullRequestListItem) -> some View {
    let caps = mobileSnapshot?.capabilities[pr.id]

    Button("Open") {
      openGitHub(urlString: pr.githubUrl)
    }
    .tint(ADEColor.accent)

    if caps?.canClose ?? (pr.state == "open") {
      Button("Close", role: .destructive) {
        Task {
          try? await syncService.closePullRequest(prId: pr.id)
          await reload(refreshRemote: true)
        }
      }
    } else if caps?.canReopen ?? (pr.state == "closed") {
      Button("Reopen") {
        Task {
          try? await syncService.reopenPullRequest(prId: pr.id)
          await reload(refreshRemote: true)
        }
      }
      .tint(ADEColor.success)
    }
  }

  private struct WorkflowCardGroup {
    let title: String
    let cards: [PrWorkflowCard]
  }

  private var groupedWorkflowCards: [WorkflowCardGroup] {
    let cards = workflowCards
    guard !cards.isEmpty else { return [] }

    let queue = cards.filter { $0.kind == "queue" }
    let integration = cards.filter { $0.kind == "integration" }
    let rebase = cards.filter { $0.kind == "rebase" }

    var groups: [WorkflowCardGroup] = []
    if !queue.isEmpty {
      groups.append(WorkflowCardGroup(title: "Queue", cards: queue))
    }
    if !integration.isEmpty {
      groups.append(WorkflowCardGroup(title: "Integration", cards: integration))
    }
    if !rebase.isEmpty {
      groups.append(WorkflowCardGroup(title: "Rebase", cards: rebase))
    }
    return groups
  }

  private var laneContextNotice: ADENoticeCard? {
    guard let laneContextLaneId else { return nil }
    let laneName = laneSnapshots.first(where: { $0.lane.id == laneContextLaneId })?.lane.name ?? "lane context"
    return ADENoticeCard(
      title: "Opened from \(laneName)",
      message: "Review the linked pull request or keep scanning PRs from the native tab.",
      icon: "arrow.triangle.pull",
      tint: ADEColor.accent,
      actionTitle: "Clear",
      action: { self.laneContextLaneId = nil }
    )
  }

  @MainActor
  private func refreshFromPullGesture() async {
    await reload(refreshRemote: true)
    if errorMessage == nil {
      withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
        refreshFeedbackToken += 1
      }
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try? await syncService.refreshPullRequestSnapshots()
        try? await syncService.refreshLaneSnapshots()
      }

      async let prsTask = syncService.fetchPullRequestListItems()
      async let lanesTask = syncService.fetchLanes()
      async let laneSnapshotsTask = syncService.fetchLaneListSnapshots()
      async let integrationTask = syncService.fetchIntegrationProposals()
      async let queueTask = syncService.fetchQueueStates()

      prs = try await prsTask
      lanes = try await lanesTask
      laneSnapshots = try await laneSnapshotsTask
      integrationProposals = try await integrationTask
      queueStates = try await queueTask

      // Best-effort: the mobile snapshot consolidates stacks/capabilities/workflow-cards for the
      // mobile surface. If the host hasn't registered the command (older desktop build) this
      // throws — swallow it and fall back to the legacy per-kind fetches above.
      mobileSnapshot = try? await syncService.fetchPrMobileSnapshot()

      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func openGitHub(urlString: String) {
    guard let url = URL(string: urlString) else { return }
    UIApplication.shared.open(url)
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
              await syncService.reconnectIfPossible(userInitiated: true)
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

  // MARK: - Legacy → unified workflow card adapters
  //
  // These let the root screen keep rendering queue/integration/rebase state when the mobile
  // snapshot fetch isn't available (older desktop build, or cold cache). Once every host the
  // user pairs with supports `prs.getMobileSnapshot` these can be dropped.

  private func legacyQueueCard(from queue: QueueLandingState) -> PrWorkflowCard {
    PrWorkflowCard(
      id: "queue:\(queue.id)",
      kind: "queue",
      groupId: queue.groupId,
      groupName: queue.groupName,
      targetBranch: queue.targetBranch,
      state: queue.state,
      activePrId: queue.activePrId,
      currentPosition: nil,
      totalEntries: queue.entries.count,
      waitReason: queue.waitReason,
      lastError: queue.lastError,
      updatedAt: nil,
      proposalId: nil,
      title: nil,
      baseBranch: nil,
      overallOutcome: nil,
      integrationStatus: nil,
      laneCount: nil,
      conflictLaneCount: nil,
      workflowDisplayState: nil,
      cleanupState: nil,
      linkedPrId: nil,
      integrationLaneId: nil,
      createdAt: nil,
      laneId: nil,
      laneName: nil,
      behindBy: nil,
      conflictPredicted: nil,
      prId: nil,
      prNumber: nil,
      dismissedAt: nil,
      deferredUntil: nil
    )
  }

  private func legacyIntegrationCard(from proposal: IntegrationProposal) -> PrWorkflowCard {
    PrWorkflowCard(
      id: "integration:\(proposal.id)",
      kind: "integration",
      groupId: nil,
      groupName: nil,
      targetBranch: nil,
      state: nil,
      activePrId: nil,
      currentPosition: nil,
      totalEntries: nil,
      waitReason: nil,
      lastError: nil,
      updatedAt: nil,
      proposalId: proposal.id,
      title: proposal.title ?? proposal.integrationLaneName,
      baseBranch: proposal.baseBranch,
      overallOutcome: proposal.overallOutcome,
      integrationStatus: proposal.status,
      laneCount: proposal.laneSummaries.count,
      conflictLaneCount: proposal.laneSummaries.filter { $0.outcome == "conflict" }.count,
      workflowDisplayState: proposal.workflowDisplayState,
      cleanupState: proposal.cleanupState,
      linkedPrId: proposal.linkedPrId,
      integrationLaneId: proposal.integrationLaneId,
      createdAt: nil,
      laneId: nil,
      laneName: nil,
      behindBy: nil,
      conflictPredicted: nil,
      prId: nil,
      prNumber: nil,
      dismissedAt: nil,
      deferredUntil: nil
    )
  }

  private func legacyRebaseCard(from item: PrRebaseWorkflowItem) -> PrWorkflowCard {
    PrWorkflowCard(
      id: "rebase:\(item.laneId)",
      kind: "rebase",
      groupId: nil,
      groupName: nil,
      targetBranch: nil,
      state: nil,
      activePrId: nil,
      currentPosition: nil,
      totalEntries: nil,
      waitReason: nil,
      lastError: nil,
      updatedAt: nil,
      proposalId: nil,
      title: nil,
      baseBranch: nil,
      overallOutcome: nil,
      integrationStatus: nil,
      laneCount: nil,
      conflictLaneCount: nil,
      workflowDisplayState: nil,
      cleanupState: nil,
      linkedPrId: nil,
      integrationLaneId: nil,
      createdAt: nil,
      laneId: item.laneId,
      laneName: item.laneName,
      behindBy: item.behindCount,
      conflictPredicted: item.severity == "critical",
      prId: nil,
      prNumber: nil,
      dismissedAt: nil,
      deferredUntil: item.deferredUntil
    )
  }
}
