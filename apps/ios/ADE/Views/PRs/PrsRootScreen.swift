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
  @State private var lastHandledPrsProjectionRevision: Int?
  @State private var lastPrsLiveSnapshotAttempt = Date.distantPast
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
    let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let status = selectedGitHubStatusFilter.wrappedValue
    let scope = selectedGitHubScopeFilter.wrappedValue
    return prs.filter { item in
      matchesCachedPrStatus(item, status: status)
        && matchesCachedPrScope(item, scope: scope)
        && matchesCachedPrSearch(item, query: query)
    }
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

  private var prsProjectionReloadKey: Int? {
    isActive ? syncService.localStateRevision : nil
  }

  private var prNavigationRequestKey: String? {
    guard isActive else { return nil }
    return syncService.requestedPrNavigation?.id
  }

  private var syncEyebrow: String {
    if isLoadingSkeleton {
      return "HYDRATING…"
    }
    if !isLive {
      return "CACHED"
    }
    if let syncedAt = githubSnapshot?.syncedAt, !syncedAt.isEmpty {
      return "UP TO DATE · \(prRelativeTime(syncedAt).uppercased())"
    }
    return "UP TO DATE"
  }

  private var linkedPrCount: Int {
    allGitHubPrs.filter { $0.linkedPrId != nil || $0.linkedLaneId != nil || $0.adeKind != nil }.count
  }

  var body: some View {
    NavigationStack(path: $path) {
      List {
        compactStatusHeader

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
        ADERootToolbarLeadingItems()
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
      .task(id: prsProjectionReloadKey) {
        guard let revision = prsProjectionReloadKey else { return }
        guard lastHandledPrsProjectionRevision != revision || prs.isEmpty else { return }
        let now = Date()
        if !prs.isEmpty || githubSnapshot != nil || mobileSnapshot != nil {
          let elapsed = now.timeIntervalSince(lastPrsLocalProjectionReload)
          if elapsed < 0.35 {
            try? await Task.sleep(for: .milliseconds(max(1, Int((0.35 - elapsed) * 1_000))))
            guard !Task.isCancelled, prsProjectionReloadKey == revision else { return }
          }
        }
        lastPrsLocalProjectionReload = Date()
        await reload()
        guard !Task.isCancelled, prsProjectionReloadKey == revision else { return }
        lastHandledPrsProjectionRevision = revision
      }
      .task(id: prNavigationRequestKey) {
        guard prNavigationRequestKey != nil else { return }
        await handleRequestedPrNavigation()
      }
      .refreshable {
        await refreshFromPullGesture()
      }
      .onDisappear {
        rootActionTask?.cancel()
        rootActionTask = nil
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
        ) { laneId, title, body, draft, baseBranch, labels, reviewers, strategy in
          runPrRootAction("Creating pull request") {
            try await syncService.createPullRequest(
              laneId: laneId,
              title: title,
              body: body,
              draft: draft,
              baseBranch: baseBranch,
              labels: labels,
              reviewers: reviewers,
              strategy: strategy
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
  private var compactStatusHeader: some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(syncEyebrow)
        .font(.caption.weight(.semibold))
        .textCase(.uppercase)
        .foregroundStyle(ADEColor.tintPRs)
        .lineLimit(1)
        .minimumScaleFactor(0.85)
        .accessibilityLabel("Pull request sync status: \(syncEyebrow)")

      Spacer(minLength: 0)

      if linkedPrCount > 0 {
        Text("\(linkedPrCount) linked")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
    }
    .padding(.horizontal, 4)
    .padding(.vertical, 2)
    .listRowBackground(Color.clear)
    .listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
    .listRowSeparator(.hidden)
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
            githubRowNavigation(for: item)
              .prListRow()
          }
        }
      }
      if !externalItems.isEmpty {
        Section("External PRs") {
          ForEach(externalItems) { item in
            githubRowNavigation(for: item)
              .prListRow()
          }
        }
      }
    }
  }

  @ViewBuilder
  private func githubRowNavigation(for item: GitHubPrListItem) -> some View {
    if let prId = item.linkedPrId {
      Button {
        path.append(prId)
      } label: {
        PrRowCard(
          item: item,
          transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? prTransitionNamespace : nil,
          isSelectedTransitionSource: selectedPrTransitionId == prId
        )
      }
      .buttonStyle(.plain)
      .simultaneousGesture(TapGesture().onEnded { selectedPrTransitionId = prId })
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        Button("Open in GitHub") { openGitHub(urlString: item.githubUrl) }
          .tint(ADEColor.accent)
      }
    } else {
      Button {
        laneLinkRequest = PrGitHubLaneLinkRequest(item: item)
      } label: {
        PrRowCard(item: item)
      }
      .buttonStyle(.plain)
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        Button("Link lane") {
          laneLinkRequest = PrGitHubLaneLinkRequest(item: item)
        }
        .tint(ADEColor.warning)
        Button("Open in GitHub") { openGitHub(urlString: item.githubUrl) }
          .tint(ADEColor.accent)
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

    Button("Open in GitHub") {
      openGitHub(urlString: pr.githubUrl)
    }
    .tint(ADEColor.accent)

    Button("Copy URL") {
      UIPasteboard.general.string = pr.githubUrl
      ADEHaptics.success()
    }
    .tint(ADEColor.textSecondary)

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

  private func matchesCachedPrStatus(_ item: PullRequestListItem, status: PrGitHubStatusFilter) -> Bool {
    switch status {
    case .all:
      return true
    case .open:
      return item.state == "open" || item.state == "draft"
    case .merged:
      return item.state == "merged"
    case .closed:
      return item.state == "closed"
    }
  }

  private func matchesCachedPrScope(_ item: PullRequestListItem, scope: PrGitHubScopeFilter) -> Bool {
    switch scope {
    case .all, .ade:
      return true
    case .external:
      return false
    }
  }

  private func matchesCachedPrSearch(_ item: PullRequestListItem, query: String) -> Bool {
    guard !query.isEmpty else { return true }
    let haystack = [
      item.title,
      item.headBranch,
      item.baseBranch,
      item.laneName,
      item.repoOwner,
      item.repoName,
      item.adeKind,
      item.workflowDisplayState,
      "#\(item.githubPrNumber)",
      "\(item.githubPrNumber)",
    ]
    .compactMap { $0?.lowercased() }
    .joined(separator: " ")
    return haystack.contains(query)
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

      let loadedPrs = try await prsTask
      let loadedLanes = try await lanesTask
      if prs != loadedPrs {
        prs = loadedPrs
      }
      if lanes != loadedLanes {
        lanes = loadedLanes
      }

      let now = Date()
      let missingLiveSnapshot = mobileSnapshot == nil || githubSnapshot == nil
      let shouldAttemptLiveSnapshots = isLive
        && (refreshRemote || missingLiveSnapshot || now.timeIntervalSince(lastPrsLiveSnapshotAttempt) >= 10)

      var nextMobileSnapshot: PrMobileSnapshot?
      if shouldAttemptLiveSnapshots {
        lastPrsLiveSnapshotAttempt = now
        let mobileSnapshotTask = Task { try? await syncService.fetchPrMobileSnapshot() }
        let githubSnapshotTask = Task { try? await syncService.fetchGitHubPullRequestSnapshot(force: refreshRemote) }
        nextMobileSnapshot = await mobileSnapshotTask.value
        if let nextGithubSnapshot = await githubSnapshotTask.value, githubSnapshot != nextGithubSnapshot {
          githubSnapshot = nextGithubSnapshot
        }
      }

      if !isLive {
        if mobileSnapshot != nil {
          mobileSnapshot = nil
        }
        if githubSnapshot != nil {
          githubSnapshot = nil
        }
      }
      if let nextMobileSnapshot {
        if mobileSnapshot != nextMobileSnapshot {
          mobileSnapshot = nextMobileSnapshot
        }
        if !laneSnapshots.isEmpty {
          laneSnapshots = []
        }
        if !integrationProposals.isEmpty {
          integrationProposals = []
        }
        if !queueStates.isEmpty {
          queueStates = []
        }
      } else if mobileSnapshot == nil {
        async let laneSnapshotsTask = syncService.fetchLaneListSnapshots()
        async let integrationTask = syncService.fetchIntegrationProposals()
        async let queueTask = syncService.fetchQueueStates()

        let loadedLaneSnapshots = try await laneSnapshotsTask
        let loadedIntegrationProposals = try await integrationTask
        let loadedQueueStates = try await queueTask
        if laneSnapshots != loadedLaneSnapshots {
          laneSnapshots = loadedLaneSnapshots
        }
        if integrationProposals != loadedIntegrationProposals {
          integrationProposals = loadedIntegrationProposals
        }
        if queueStates != loadedQueueStates {
          queueStates = loadedQueueStates
        }
      }

      let message = refreshError?.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    } catch {
      let message = error.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    }
  }

  @MainActor
  private func handleRequestedPrNavigation() async {
    guard let request = syncService.requestedPrNavigation else { return }
    rootSurfaceRawValue = PrRootSurface.github.rawValue
    stateFilterRawValue = PrListStateFilter.all.rawValue
    selectedPrTransitionId = request.prId
    laneContextLaneId = request.laneId
    path = NavigationPath()
    path.append(request.prId)
    syncService.requestedPrNavigation = nil
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

private struct PrLaneLinkSheet: View {
  @Environment(\.dismiss) private var dismiss
  let item: GitHubPrListItem
  let lanes: [LaneSummary]
  let canLink: Bool
  let onLink: (String) -> Void
  let onOpenGitHub: () -> Void
  @State private var selectedLaneId = ""

  private var availableLanes: [LaneSummary] {
    lanes
      .filter { $0.archivedAt == nil && $0.laneType != "primary" }
      .sorted { lhs, rhs in lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending }
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
            Text("No eligible lanes are available to link.")
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
