import SwiftUI
import UIKit

struct PRsTabView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService
  @Namespace private var prTransitionNamespace
  var isActive = true

  @State private var path = NavigationPath()
  @State private var prs: [PullRequestListItem] = []
  @State private var lanes: [LaneSummary] = []
  @State private var laneSnapshots: [LaneListSnapshot] = []
  @State private var integrationProposals: [IntegrationProposal] = []
  @State private var queueStates: [QueueLandingState] = []
  @State private var mobileSnapshot: PrMobileSnapshot?
  @State private var githubSnapshot: GitHubPrSnapshot?
  @State private var errorMessage: String?
  @State private var actionMessage: String?
  @State private var busyAction: String?
  @State private var createPresented = false
  @State private var stackPresentation: PrStackPresentation?
  @State private var refreshFeedbackToken = 0
  @State private var lastPrsLocalProjectionReload = Date.distantPast
  @State private var selectedPrTransitionId: String?
  @State private var laneContextLaneId: String?
  @State private var rootActionTask: Task<Void, Never>?
  @State private var laneLinkRequest: PrGitHubLaneLinkRequest?
  @SceneStorage("ade.prs.rootSurface") private var rootSurfaceRawValue = PrRootSurface.github.rawValue
  @SceneStorage("ade.prs.workflowFilter") private var workflowFilterRawValue = PrWorkflowKindFilter.all.rawValue
  @SceneStorage("ade.prs.stateFilter") private var stateFilterRawValue = PrListStateFilter.all.rawValue
  @SceneStorage("ade.prs.githubStatusFilter") private var githubStatusFilterRawValue = PrGitHubStatusFilter.open.rawValue
  @SceneStorage("ade.prs.githubScopeFilter") private var githubScopeFilterRawValue = PrGitHubScopeFilter.all.rawValue
  @SceneStorage("ade.prs.githubSort") private var githubSortRawValue = PrGitHubSortOption.updated.rawValue
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

  private var selectedRootSurface: Binding<PrRootSurface> {
    Binding(
      get: { PrRootSurface(rawValue: rootSurfaceRawValue) ?? .github },
      set: { rootSurfaceRawValue = $0.rawValue }
    )
  }

  private var selectedWorkflowFilter: Binding<PrWorkflowKindFilter> {
    Binding(
      get: { PrWorkflowKindFilter(rawValue: workflowFilterRawValue) ?? .all },
      set: { workflowFilterRawValue = $0.rawValue }
    )
  }

  private var selectedGitHubStatusFilter: Binding<PrGitHubStatusFilter> {
    Binding(
      get: { PrGitHubStatusFilter(rawValue: githubStatusFilterRawValue) ?? .open },
      set: { githubStatusFilterRawValue = $0.rawValue }
    )
  }

  private var selectedGitHubScopeFilter: Binding<PrGitHubScopeFilter> {
    Binding(
      get: { PrGitHubScopeFilter(rawValue: githubScopeFilterRawValue) ?? .all },
      set: { githubScopeFilterRawValue = $0.rawValue }
    )
  }

  private var selectedGitHubSort: Binding<PrGitHubSortOption> {
    Binding(
      get: { PrGitHubSortOption(rawValue: githubSortRawValue) ?? .updated },
      set: { githubSortRawValue = $0.rawValue }
    )
  }

  private var filteredPrs: [PullRequestListItem] {
    filterPullRequestListItems(prs, query: searchText, state: selectedStateFilter.wrappedValue)
  }

  private var allGitHubPrs: [GitHubPrListItem] {
    (githubSnapshot?.repoPullRequests ?? []) + (githubSnapshot?.externalPullRequests ?? [])
  }

  private var filteredGitHubPrs: [GitHubPrListItem] {
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let status = selectedGitHubStatusFilter.wrappedValue
    let scope = selectedGitHubScopeFilter.wrappedValue
    let sort = selectedGitHubSort.wrappedValue
    return allGitHubPrs
      .filter { item in
        matchesGitHubStatus(item, status: status)
          && matchesGitHubScope(item, scope: scope)
          && matchesGitHubSearch(item, query: query)
      }
      .sorted { lhs, rhs in
        switch sort {
        case .updated:
          return (prParsedDate(lhs.updatedAt) ?? .distantPast) > (prParsedDate(rhs.updatedAt) ?? .distantPast)
        case .created:
          return (prParsedDate(lhs.createdAt) ?? .distantPast) > (prParsedDate(rhs.createdAt) ?? .distantPast)
        case .number:
          if lhs.repoOwner == rhs.repoOwner && lhs.repoName == rhs.repoName {
            return lhs.githubPrNumber > rhs.githubPrNumber
          }
          return "\(lhs.repoOwner)/\(lhs.repoName)" < "\(rhs.repoOwner)/\(rhs.repoName)"
        }
      }
  }

  private var githubFilterCounts: PrGitHubFilterCounts {
    let scope = selectedGitHubScopeFilter.wrappedValue
    let status = selectedGitHubStatusFilter.wrappedValue
    let scopedItems = allGitHubPrs.filter { matchesGitHubScope($0, scope: scope) }
    let statusItems = allGitHubPrs.filter { matchesGitHubStatus($0, status: status) }
    return PrGitHubFilterCounts(
      open: scopedItems.filter { matchesGitHubStatus($0, status: .open) }.count,
      merged: scopedItems.filter { matchesGitHubStatus($0, status: .merged) }.count,
      closed: scopedItems.filter { matchesGitHubStatus($0, status: .closed) }.count,
      all: scopedItems.count,
      ade: statusItems.filter { matchesGitHubScope($0, scope: .ade) }.count,
      external: statusItems.filter { matchesGitHubScope($0, scope: .external) }.count
    )
  }

  private var canLinkGitHubPullRequests: Bool {
    isLive && busyAction == nil && syncService.supportsRemoteAction("prs.linkToLane")
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
      return createCaps.canCreateAny && canRunWorkflowActions
    }
    return canRunWorkflowActions && !lanes.isEmpty
  }

  private var canRunWorkflowActions: Bool {
    isLive && busyAction == nil
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        if let notice = laneContextNotice {
          notice.prListRow()
        }

        if isLoadingSkeleton {
          ForEach(0..<3, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .prListRow()
          }
        } else {
          if let hydrationNotice = prsStatus.inlineHydrationFailureNotice(for: .prs) {
            ADENoticeCard(
              title: hydrationNotice.title,
              message: hydrationNotice.message,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .prListRow()
          }
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

          if let busyAction {
            HStack(spacing: 10) {
              ProgressView()
                .tint(ADEColor.accent)
              Text(busyAction)
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
              Spacer(minLength: 0)
            }
            .adeGlassCard(cornerRadius: 12, padding: 12)
            .prListRow()
          }

          if let actionMessage {
            ADENoticeCard(
              title: "PR workflow updated",
              message: actionMessage,
              icon: "checkmark.circle.fill",
              tint: ADEColor.success,
              actionTitle: nil,
              action: nil
            )
            .prListRow()
          }

          Picker("PR surface", selection: selectedRootSurface) {
            ForEach(PrRootSurface.allCases) { surface in
              Text(surface.title).tag(surface)
            }
          }
          .pickerStyle(.segmented)
          .prListRow()

          switch selectedRootSurface.wrappedValue {
          case .github:
            githubSurfaceRows
          case .workflows:
            workflowsSurfaceRows
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("PRs")
      .navigationBarTitleDisplayMode(.inline)
      .searchable(text: $searchText, prompt: selectedRootSurface.wrappedValue == .github ? "Search PRs, branches, authors" : "Search workflow cards")
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          ADEConnectionDot()
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
      .task(id: isActive) {
        guard isActive else { return }
        await reload()
      }
      .task(id: "\(syncService.localStateRevision)-\(isActive)") {
        guard isActive else { return }
        let now = Date()
        guard now.timeIntervalSince(lastPrsLocalProjectionReload) >= 0.35 else { return }
        lastPrsLocalProjectionReload = now
        await reload()
      }
      .refreshable {
        await refreshFromPullGesture()
      }
      .onDisappear {
        rootActionTask?.cancel()
        rootActionTask = nil
      }
      .onChange(of: syncService.requestedPrNavigation?.id) { _, requestId in
        guard requestId != nil, let prId = syncService.requestedPrNavigation?.prId else { return }
        rootSurfaceRawValue = PrRootSurface.github.rawValue
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
          runPrRootAction("Creating pull request") {
            try await syncService.createPullRequest(
              laneId: laneId,
              title: title,
              body: body,
              draft: draft,
              baseBranch: baseBranch,
              labels: labels,
              reviewers: reviewers
            )
          } onSuccess: {
            createPresented = false
          }
        }
        .environmentObject(syncService)
      }
      .sheet(item: $stackPresentation) { presentation in
        PrStackSheet(groupId: presentation.id, groupName: presentation.groupName)
          .environmentObject(syncService)
      }
      .sheet(item: $laneLinkRequest) { request in
        PrLaneLinkSheet(
          item: request.item,
          lanes: lanes,
          canLink: canLinkGitHubPullRequests
        ) { laneId in
          runPrRootAction(
            "Linking pull request",
            operation: {
              try await syncService.linkPullRequestToLane(
                laneId: laneId,
                prUrlOrNumber: request.item.githubUrl.isEmpty ? "\(request.item.githubPrNumber)" : request.item.githubUrl
              )
            },
            onSuccess: {
              laneLinkRequest = nil
            }
          )
        } onOpenGitHub: {
          openGitHub(urlString: request.item.githubUrl)
        }
      }
    }
  }

  @ViewBuilder
  private var githubSurfaceRows: some View {
    PrGitHubFiltersCard(
      repo: githubSnapshot?.repo,
      viewerLogin: githubSnapshot?.viewerLogin,
      syncedAt: githubSnapshot?.syncedAt,
      statusFilter: selectedGitHubStatusFilter,
      scopeFilter: selectedGitHubScopeFilter,
      sortOption: selectedGitHubSort,
      counts: githubFilterCounts,
      visibleCount: githubSnapshot == nil ? filteredPrs.count : filteredGitHubPrs.count,
      totalCount: githubSnapshot == nil ? prs.count : allGitHubPrs.count,
      isLive: isLive,
      onRefresh: { Task { await reload(refreshRemote: true) } }
    )
    .prListRow()

    if prsStatus.phase == .ready && filteredPrs.isEmpty && filteredGitHubPrs.isEmpty {
      ADEEmptyStateView(
        symbol: searchText.isEmpty ? "arrow.triangle.pull" : "magnifyingglass",
        title: searchText.isEmpty ? "No pull requests for these filters" : "No PRs match this search",
        message: searchText.isEmpty
          ? "Try a different status or scope, or refresh GitHub state from the host."
          : "Try a broader query or switch the status and scope filters."
      )
      .prListRow()
    }

    if githubSnapshot == nil, !filteredPrs.isEmpty {
      Section("Cached ADE pull requests") {
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

    if let githubSnapshot {
      let repoItems = filteredGitHubPrs.filter { $0.scope != "external" }
      let externalItems = filteredGitHubPrs.filter { $0.scope == "external" }
      if !repoItems.isEmpty {
        Section(githubSnapshot.repo.map { "\($0.owner)/\($0.name)" } ?? "Repository PRs") {
          ForEach(repoItems) { item in
            GitHubPullRequestRow(item: item) { prId in
              path.append(prId)
            } onOpenGitHub: {
              openGitHub(urlString: item.githubUrl)
            } onLinkToLane: {
              laneLinkRequest = PrGitHubLaneLinkRequest(item: item)
            }
            .prListRow()
          }
        }
      }
      if !externalItems.isEmpty {
        Section("External PRs") {
          ForEach(externalItems) { item in
            GitHubPullRequestRow(item: item) { prId in
              path.append(prId)
            } onOpenGitHub: {
              openGitHub(urlString: item.githubUrl)
            } onLinkToLane: {
              laneLinkRequest = PrGitHubLaneLinkRequest(item: item)
            }
            .prListRow()
          }
        }
      }
    }
  }

  @ViewBuilder
  private var workflowsSurfaceRows: some View {
    Picker("Workflow", selection: selectedWorkflowFilter) {
      ForEach(PrWorkflowKindFilter.allCases) { filter in
        Text(filter.title).tag(filter)
      }
    }
    .pickerStyle(.segmented)
    .prListRow()

    if groupedWorkflowCards.isEmpty {
      ADEEmptyStateView(
        symbol: "point.3.filled.connected.trianglepath.dotted",
        title: "No active PR workflows",
        message: "Queue, integration, and rebase work appears here once the host syncs workflow state."
      )
      .prListRow()
    } else {
      ForEach(groupedWorkflowCards, id: \.title) { group in
        Section(group.title) {
          ForEach(group.cards) { card in
            PrMobileWorkflowCardView(
              card: card,
              isLive: canRunWorkflowActions,
              onOpenPr: { prId in path.append(prId) },
              onLand: { prId, method in
                runPrRootAction("Landing active PR") {
                  try await syncService.mergePullRequest(prId: prId, method: method.rawValue)
                }
              },
              onLandQueueNext: { groupId, method in
                runPrRootAction("Landing queue next") {
                  try await syncService.landQueueNext(groupId: groupId, method: method.rawValue)
                }
              },
              onPauseQueue: { queueId in
                runPrRootAction("Pausing queue") {
                  try await syncService.pauseQueueAutomation(queueId: queueId)
                }
              },
              onResumeQueue: { queueId, method in
                runPrRootAction("Resuming queue") {
                  try await syncService.resumeQueueAutomation(queueId: queueId, method: method.rawValue)
                }
              },
              onCancelQueue: { queueId in
                runPrRootAction("Canceling queue") {
                  try await syncService.cancelQueueAutomation(queueId: queueId)
                }
              },
              onReorderQueue: { groupId, prIds in
                runPrRootAction("Reordering queue") {
                  try await syncService.reorderQueue(groupId: groupId, prIds: prIds)
                }
              },
              onCreateIntegrationLane: { proposalId in
                runPrRootAction("Creating integration lane") {
                  _ = try await syncService.createIntegrationLaneForProposal(proposalId: proposalId)
                }
              },
              onDeleteIntegrationProposal: { proposalId in
                runPrRootAction("Deleting integration proposal") {
                  _ = try await syncService.deleteIntegrationProposal(proposalId: proposalId)
                }
              },
              onDismissIntegrationCleanup: { proposalId in
                runPrRootAction("Dismissing integration cleanup") {
                  try await syncService.dismissIntegrationCleanup(proposalId: proposalId)
                }
              },
              onCleanupIntegrationWorkflow: { proposalId, sourceLaneIds in
                runPrRootAction("Cleaning up integration lanes") {
                  try await syncService.cleanupIntegrationWorkflow(
                    proposalId: proposalId,
                    archiveIntegrationLane: true,
                    archiveSourceLaneIds: sourceLaneIds
                  )
                }
              },
              onResolveIntegrationLane: { proposalId, laneId in
                runPrRootAction("Resolving integration lane") {
                  _ = try await syncService.startIntegrationResolution(proposalId: proposalId, laneId: laneId)
                }
              },
              onRecheckIntegrationLane: { proposalId, laneId in
                runPrRootAction("Rechecking integration lane") {
                  _ = try await syncService.recheckIntegrationStep(proposalId: proposalId, laneId: laneId)
                }
              },
              onRebaseLane: { laneId in
                runPrRootAction("Rebasing lane") {
                  try await syncService.startLaneRebase(laneId: laneId)
                }
              },
              onDeferRebase: { laneId in
                runPrRootAction("Deferring rebase") {
                  try await syncService.deferRebaseSuggestion(laneId: laneId)
                }
              },
              onDismissRebase: { laneId in
                runPrRootAction("Dismissing rebase") {
                  try await syncService.dismissRebaseSuggestion(laneId: laneId)
                }
              }
            )
            .prListRow()
          }
        }
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
        runPrRootAction("Closing pull request") {
          try await syncService.closePullRequest(prId: pr.id)
        }
      }
    } else if caps?.canReopen ?? (pr.state == "closed") {
      Button("Reopen") {
        runPrRootAction("Reopening pull request") {
          try await syncService.reopenPullRequest(prId: pr.id)
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
    let cards = workflowCards.filter { card in
      let selected = selectedWorkflowFilter.wrappedValue
      guard selected != .all else { return true }
      return card.kind == selected.rawValue
    }
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

  private func matchesGitHubStatus(_ item: GitHubPrListItem, status: PrGitHubStatusFilter) -> Bool {
    switch status {
    case .all:
      return true
    case .open:
      return item.state == "open" || item.isDraft
    case .merged:
      return item.state == "merged"
    case .closed:
      return item.state == "closed"
    }
  }

  private func matchesGitHubScope(_ item: GitHubPrListItem, scope: PrGitHubScopeFilter) -> Bool {
    switch scope {
    case .all:
      return true
    case .ade:
      return item.adeKind != nil || item.linkedPrId != nil || item.linkedLaneId != nil
    case .external:
      return item.adeKind == nil && item.linkedPrId == nil && item.linkedLaneId == nil
    }
  }

  private func matchesGitHubSearch(_ item: GitHubPrListItem, query: String) -> Bool {
    guard !query.isEmpty else { return true }
    let haystack = [
      item.title,
      item.author,
      item.repoOwner,
      item.repoName,
      item.baseBranch,
      item.headBranch,
      item.linkedLaneName,
      item.adeKind,
      item.workflowDisplayState,
      "#\(item.githubPrNumber)",
      "\(item.githubPrNumber)",
    ]
    .compactMap { $0?.lowercased() }
    .joined(separator: " ")
    return haystack.contains(query) || item.labels.contains { $0.name.lowercased().contains(query) }
  }

  private var laneContextNotice: ADENoticeCard? {
    guard let laneContextLaneId else { return nil }
    let laneName = lanes.first(where: { $0.id == laneContextLaneId })?.name ?? "lane context"
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
      var refreshError: Error?
      if refreshRemote {
        do {
          try await syncService.refreshPullRequestSnapshots()
          try await syncService.refreshLaneSnapshots()
        } catch {
          refreshError = error
        }
      }

      async let prsTask = syncService.fetchPullRequestListItems()
      async let lanesTask = syncService.fetchLanes()
      let mobileSnapshotTask = isLive
        ? Task { try? await syncService.fetchPrMobileSnapshot() }
        : nil
      let githubSnapshotTask = isLive
        ? Task { try? await syncService.fetchGitHubPullRequestSnapshot(force: refreshRemote) }
        : nil

      prs = try await prsTask
      lanes = try await lanesTask
      githubSnapshot = await githubSnapshotTask?.value

      if let mobileSnapshot = await mobileSnapshotTask?.value {
        self.mobileSnapshot = mobileSnapshot
        laneSnapshots = []
        integrationProposals = []
        queueStates = []
      } else {
        async let laneSnapshotsTask = syncService.fetchLaneListSnapshots()
        async let integrationTask = syncService.fetchIntegrationProposals()
        async let queueTask = syncService.fetchQueueStates()

        laneSnapshots = try await laneSnapshotsTask
        integrationProposals = try await integrationTask
        queueStates = try await queueTask
        mobileSnapshot = nil
      }

      errorMessage = refreshError?.localizedDescription
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func runPrRootAction(
    _ label: String,
    operation: @escaping () async throws -> Void,
    onSuccess: @escaping @MainActor () -> Void = {}
  ) {
    rootActionTask?.cancel()
    let task = Task { @MainActor in
      busyAction = label
      errorMessage = nil
      actionMessage = nil
      do {
        try await operation()
        guard !Task.isCancelled else {
          busyAction = nil
          return
        }
        onSuccess()
        guard !Task.isCancelled else {
          busyAction = nil
          return
        }
        await reload(refreshRemote: true)
        guard !Task.isCancelled else {
          busyAction = nil
          return
        }
        actionMessage = "\(label) finished."
      } catch {
        guard !Task.isCancelled else {
          busyAction = nil
          return
        }
        let message = error.localizedDescription
        await reload(refreshRemote: false)
        guard !Task.isCancelled else {
          busyAction = nil
          return
        }
        errorMessage = message
      }
      busyAction = nil
    }
    rootActionTask = task
  }

  private func openGitHub(urlString: String) {
    guard let url = URL(string: urlString) else { return }
    UIApplication.shared.open(url)
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
      queueId: queue.queueId,
      groupId: queue.groupId,
      groupName: queue.groupName,
      targetBranch: queue.targetBranch,
      state: queue.state,
      activePrId: queue.activePrId,
      currentPosition: nil,
      totalEntries: queue.entries.count,
      entries: queue.entries,
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
      lanes: nil,
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
      queueId: nil,
      groupId: nil,
      groupName: nil,
      targetBranch: nil,
      state: nil,
      activePrId: nil,
      currentPosition: nil,
      totalEntries: nil,
      entries: nil,
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
      lanes: proposal.laneSummaries.map {
        PrIntegrationWorkflowLane(laneId: $0.laneId, laneName: $0.laneName, outcome: $0.outcome)
      },
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
      queueId: nil,
      groupId: nil,
      groupName: nil,
      targetBranch: nil,
      state: nil,
      activePrId: nil,
      currentPosition: nil,
      totalEntries: nil,
      entries: nil,
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
      lanes: nil,
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

private struct PrGitHubFiltersCard: View {
  let repo: GitHubRepoRef?
  let viewerLogin: String?
  let syncedAt: String?
  @Binding var statusFilter: PrGitHubStatusFilter
  @Binding var scopeFilter: PrGitHubScopeFilter
  @Binding var sortOption: PrGitHubSortOption
  let counts: PrGitHubFilterCounts
  let visibleCount: Int
  let totalCount: Int
  let isLive: Bool
  let onRefresh: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(alignment: .top, spacing: 12) {
        VStack(alignment: .leading, spacing: 4) {
          Text(repo.map { "\($0.owner)/\($0.name)" } ?? "GitHub pull requests")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 0)
        Button(action: onRefresh) {
          Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(.glass)
        .accessibilityLabel("Refresh GitHub pull requests")
      }

      HStack(spacing: 8) {
        ADEStatusPill(text: isLive ? "LIVE" : "CACHED", tint: isLive ? ADEColor.success : ADEColor.warning)
        ADEStatusPill(text: "\(visibleCount)/\(totalCount)", tint: ADEColor.accent)
        if let viewerLogin, !viewerLogin.isEmpty {
          ADEStatusPill(text: "@\(viewerLogin)", tint: ADEColor.textSecondary)
        }
        Spacer(minLength: 0)
      }

      VStack(alignment: .leading, spacing: 8) {
        Text("Status")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        PrGitHubFilterChipRow(selection: $statusFilter) { filter in
          switch filter {
          case .open: return counts.open
          case .merged: return counts.merged
          case .closed: return counts.closed
          case .all: return counts.all
          }
        }
      }

      VStack(alignment: .leading, spacing: 8) {
        Text("Scope")
          .font(.caption.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        PrGitHubFilterChipRow(selection: $scopeFilter) { filter in
          switch filter {
          case .all: return counts.all
          case .ade: return counts.ade
          case .external: return counts.external
          }
        }
      }

      Picker("Sort", selection: $sortOption) {
        ForEach(PrGitHubSortOption.allCases) { option in
          Text(option.title).tag(option)
        }
      }
      .pickerStyle(.segmented)
    }
    .adeListCard()
  }

  private var subtitle: String {
    let synced = syncedAt.map { "Synced \(prRelativeTime($0))" } ?? "No GitHub snapshot yet"
    if let defaultBranch = repo?.defaultBranch, !defaultBranch.isEmpty {
      return "\(synced) · default \(defaultBranch)"
    }
    return synced
  }
}

private struct PrGitHubFilterChipRow<Selection: CaseIterable & Identifiable & Hashable>: View where Selection.AllCases: RandomAccessCollection, Selection: RawRepresentable, Selection.RawValue == String {
  @Binding var selection: Selection
  let count: (Selection) -> Int

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(Array(Selection.allCases), id: \.id) { item in
          Button {
            selection = item
          } label: {
            HStack(spacing: 6) {
              Text(title(for: item))
              Text("\(count(item))")
                .font(.caption2.weight(.bold))
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(Capsule().fill(selection == item ? ADEColor.accent.opacity(0.22) : ADEColor.recessedBackground.opacity(0.85)))
            }
            .font(.caption.weight(.semibold))
          }
          .buttonStyle(.glass)
          .tint(selection == item ? ADEColor.accent : ADEColor.textSecondary)
        }
      }
    }
  }

  private func title(for item: Selection) -> String {
    switch item.rawValue {
    case "open": return "Open"
    case "merged": return "Merged"
    case "closed": return "Closed"
    case "all": return "All"
    case "ade": return "ADE"
    case "external": return "External"
    default: return titleCase(item.rawValue)
    }
  }
}

private struct PrLaneLinkSheet: View {
  @Environment(\.dismiss) private var dismiss
  let item: GitHubPrListItem
  let lanes: [LaneSummary]
  let canLink: Bool
  let onLink: (String) -> Void
  let onOpenGitHub: () -> Void
  @State private var selectedLaneId = ""

  private var availableLanes: [LaneSummary] {
    lanes.sorted { lhs, rhs in lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending }
  }

  var body: some View {
    NavigationStack {
      List {
        Section {
          VStack(alignment: .leading, spacing: 8) {
            Text(item.title)
              .font(.headline)
              .foregroundStyle(ADEColor.textPrimary)
            Text("#\(item.githubPrNumber) · \(item.repoOwner)/\(item.repoName)")
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
            if let head = item.headBranch, let base = item.baseBranch {
              Text("\(head) → \(base)")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
          .padding(.vertical, 4)
        }

        if !canLink {
          Section {
            Label("Reconnect to a host that supports PR lane linking.", systemImage: "wifi.exclamationmark")
              .font(.subheadline)
              .foregroundStyle(ADEColor.warning)
          }
        }

        Section("Lane") {
          if availableLanes.isEmpty {
            Text("No lanes are available to link.")
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
          } else {
            Picker("Lane", selection: $selectedLaneId) {
              Text("Choose lane").tag("")
              ForEach(availableLanes) { lane in
                Text(lane.name).tag(lane.id)
              }
            }
          }
        }

        Section {
          Button("Link to lane") {
            onLink(selectedLaneId)
          }
          .disabled(!canLink || selectedLaneId.isEmpty)

          Button("Open in GitHub") {
            onOpenGitHub()
          }
        }
      }
      .navigationTitle("Link PR")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { dismiss() }
        }
      }
    }
    .onAppear {
      if selectedLaneId.isEmpty {
        selectedLaneId = item.linkedLaneId ?? availableLanes.first?.id ?? ""
      }
    }
  }
}

private struct GitHubPullRequestRow: View {
  let item: GitHubPrListItem
  let onOpenLinkedPr: (String) -> Void
  let onOpenGitHub: () -> Void
  let onLinkToLane: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 5) {
          Text(item.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(2)
          Text("#\(item.githubPrNumber) · \(item.repoOwner)/\(item.repoName) · updated \(prRelativeTime(item.updatedAt))")
            .font(.system(.caption, design: .monospaced))
            .foregroundStyle(ADEColor.textSecondary)
        }
        Spacer(minLength: 8)
        ADEStatusPill(text: item.isDraft ? "DRAFT" : item.state.uppercased(), tint: prStateTint(item.isDraft ? "draft" : item.state))
      }

      HStack(spacing: 8) {
        if let author = item.author, !author.isEmpty {
          ADEStatusPill(text: item.isBot ? "\(author) BOT" : author, tint: item.isBot ? ADEColor.warning : ADEColor.textSecondary)
        }
        if let laneName = item.linkedLaneName, !laneName.isEmpty {
          ADEStatusPill(text: laneName.uppercased(), tint: ADEColor.accent)
        } else {
          ADEStatusPill(text: "UNLINKED", tint: ADEColor.warning)
        }
        if item.scope == "external" {
          ADEStatusPill(text: "EXTERNAL", tint: ADEColor.tintFiles)
        }
        if let adeKind = prAdeKindLabel(item.adeKind) {
          ADEStatusPill(text: adeKind, tint: ADEColor.tintPRs)
        }
      }

      HStack(spacing: 8) {
        if let head = item.headBranch, let base = item.baseBranch {
          Label("\(head) → \(base)", systemImage: "arrow.triangle.branch")
            .lineLimit(1)
        }
        if item.commentCount > 0 {
          Label("\(item.commentCount)", systemImage: "bubble.left.and.bubble.right")
        }
        if let workflowDisplayState = item.workflowDisplayState, !workflowDisplayState.isEmpty {
          Label(titleCase(workflowDisplayState), systemImage: "point.3.connected.trianglepath.dotted")
            .lineLimit(1)
        }
        Spacer(minLength: 0)
      }
      .font(.caption.weight(.semibold))
      .foregroundStyle(ADEColor.textSecondary)

      if !item.labels.isEmpty {
        PrChipWrap(users: item.labels.prefix(6).map(\.name), tint: ADEColor.tintPRs)
      }

      HStack(spacing: 10) {
        if let linkedPrId = item.linkedPrId {
          Button("Open detail") {
            onOpenLinkedPr(linkedPrId)
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.accent)
        } else {
          Button("Link lane") {
            onLinkToLane()
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.warning)
        }

        Button("Open GitHub") {
          onOpenGitHub()
        }
        .buttonStyle(.glass)
      }
      .font(.caption.weight(.semibold))
    }
    .adeListCard()
  }
}
