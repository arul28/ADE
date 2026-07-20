import SwiftUI
import UIKit

struct PrDetailView: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService
  let prId: String
  let transitionNamespace: Namespace.ID?
  let requestedRepoOwner: String?
  let requestedRepoName: String?
  let availableLanes: [LaneSummary]

  init(
    prId: String,
    transitionNamespace: Namespace.ID?,
    requestedRepoOwner: String? = nil,
    requestedRepoName: String? = nil,
    availableLanes: [LaneSummary] = []
  ) {
    self.prId = prId
    self.transitionNamespace = transitionNamespace
    self.requestedRepoOwner = requestedRepoOwner
    self.requestedRepoName = requestedRepoName
    self.availableLanes = availableLanes
  }

  @State private var pr: PullRequestListItem?
  @State private var githubItem: GitHubPrListItem?
  @State private var snapshot: PullRequestSnapshot?
  @State private var reviewThreads: [PrReviewThread] = []
  @State private var actionRuns: [PrActionRun] = []
  @State private var activityEvents: [PrActivityEvent] = []
  @State private var deployments: [PrDeployment] = []
  @State private var aiSummary: AiReviewSummary?
  @State private var groupMembers: [PrGroupMemberSummary] = []
  @State private var capabilities: PrActionCapabilities?
  @State private var unavailableDetailParts: [String] = []
  @State private var selectedTab: PrDetailTab = .overview
  @State private var mergeMethod: PrMergeMethodOption = .squash
  @State private var reviewerInput = ""
  @State private var commentInput = ""
  @State private var errorMessage: String?
  @State private var actionMessage: String?
  @State private var cleanupChoice: PrCleanupChoice = .archive
  @State private var cleanupConfirmationPresented = false
  @State private var filesWorkspaceId: String?
  @State private var stackPresentation: PrStackPresentation?
  @State private var laneLinkItem: GitHubPrListItem?
  @State private var editorSheet: PrDetailEditorSheet?
  @State private var mergeMethodSheetPresented: Bool = false
  @State private var actionsSheetPresented: Bool = false
  @State private var hasLoadedLiveSidecars = false
  @State private var hasAttemptedInitialLoad = false
  @State private var hasSeededFromWarmCache = false
  @State private var summaryCommitsExpanded = false
  @State private var pendingTimelineScrollId: String?
  @State private var timelineSectionMounted = false

  // MARK: - Derived models (computed off the render path)
  //
  // The timeline and the synthesized fallback PR are rebuilt ONCE per data
  // change (reload / warm-cache seed), never inside `body`. Rebuilding +
  // re-sorting the timeline on every body evaluation was a primary source of
  // scroll lag on long PRs.

  /// Fallback list item synthesized from the GitHub item + snapshot when the
  /// PR has no lane-PR row. Cached so `currentPr` stops allocating per access.
  @State private var synthesizedPr: PullRequestListItem?
  /// Unified timeline, sorted ascending (oldest → newest, GitHub-style —
  /// desktop parity). Fed to the Overview thread rows.
  @State private var timelineEvents: [PrTimelineEvent] = []
  /// Timeline folded for display: runs of consecutive same-author commits
  /// collapse into a single group row (desktop `PrTimeline` parity).
  @State private var timelineDisplayItems: [PrTimelineDisplayItem] = []
  /// Review threads split + sorted once per data change (most recent first).
  @State private var unresolvedThreads: [PrReviewThread] = []
  @State private var resolvedThreads: [PrReviewThread] = []

  // Thread reply state (was owned by the removed PrUnifiedOverviewThread).
  @State private var focusedThreadId: String?
  @State private var replyDraft: [String: String] = [:]

  /// How long a warm detail cache entry is considered fresh. Within this window
  /// a PR projection bump renders from cache without re-firing the cold sidecar
  /// fan-out. The pull-to-refresh and explicit retry paths bypass this.
  private static let detailFreshnessWindow: TimeInterval = 25

  // MARK: - Durable per-control busy keys
  //
  // Detail actions are keyed on the durable `SyncService.prActionsInFlight`
  // registry so their spinners survive a tab switch + remount. Each control gets
  // a distinct key off the route `prId` so spinners are localized to the right
  // button instead of a single global banner.

  /// Main action funnel key (merge/close/reopen/comment/edit/etc.).
  private var detailActionKey: String { "pr-detail:\(prId)" }
  /// AI review-summary regeneration key.
  private var aiSummaryKey: String { "pr-ai-summary:\(prId)" }

  /// In-flight label of the main detail action, if any (durable across tab
  /// switches via the service registry).
  private var detailBusyLabel: String? {
    syncService.prActionLabel(forKey: detailActionKey)
  }
  private var isDetailBusy: Bool { detailBusyLabel != nil }
  private var isAiSummaryLoading: Bool { syncService.isPrActionInFlight(key: aiSummaryKey) }

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var isLive: Bool {
    prsStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var canRunPrActions: Bool {
    isLive && !isDetailBusy && hasActionablePrId
  }

  private var canOpenCurrentPrInGitHub: Bool {
    !currentPr.githubUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && (capabilities?.canOpenInGithub ?? true)
  }

  private var canUpdateCurrentPrMetadata: Bool {
    canRunPrActions && (capabilities?.canUpdateDescription ?? true)
  }

  private var shouldShowCloseAction: Bool {
    capabilities?.canClose ?? actionAvailability.showsClose
  }

  private var shouldShowReopenAction: Bool {
    capabilities?.canReopen ?? actionAvailability.showsReopen
  }

  private var canCloseCurrentPr: Bool {
    canRunPrActions && shouldShowCloseAction
  }

  private var canReopenCurrentPr: Bool {
    canRunPrActions && shouldShowReopenAction
  }

  private var canAttemptBlockedMerge: Bool {
    guard canRunPrActions else { return false }
    guard !isCurrentPrDraft else { return false }
    guard let status = snapshot?.status else { return false }
    let state = status.state.isEmpty ? currentPr.state : status.state
    return state == "open" && !status.isMergeable && !status.mergeConflicts
  }

  private var routedPrNumber: Int? {
    routedGitHubCoordinates?.githubPrNumber ?? Self.prNumber(fromRouteId: prId)
  }

  private var routedGitHubCoordinates: (repoOwner: String, repoName: String, githubPrNumber: Int)? {
    prGitHubCoordinates(fromRouteId: prId)
  }

  private var requestedRepoScope: PrDetailRouteScope? {
    PrDetailRouteScope(repoOwner: requestedRepoOwner, repoName: requestedRepoName)
  }

  private var hasPrDetailData: Bool {
    pr != nil || githubItem != nil || snapshot != nil
  }

  private var effectivePrId: String {
    pr?.id ?? githubItem?.linkedPrId ?? prId
  }

  private var hasActionablePrId: Bool {
    pr != nil || githubItem?.linkedPrId != nil
  }

  private var isAwaitingInitialPrDetail: Bool {
    !hasAttemptedInitialLoad && !hasPrDetailData
  }

  private var isPrDetailUnavailable: Bool {
    hasAttemptedInitialLoad && !hasPrDetailData
  }

  private var unavailablePrLabel: String {
    if let routedPrNumber {
      return "#\(routedPrNumber)"
    }
    return "this pull request"
  }

  private var displayedPrNumber: Int? {
    if let pr { return pr.githubPrNumber }
    if let githubItem { return githubItem.githubPrNumber }
    if let routedPrNumber { return routedPrNumber }
    return nil
  }

  private var detailHeaderAccessibilityLabel: String {
    if let displayedPrNumber {
      return "Pull request \(displayedPrNumber), \(currentPr.title)"
    }
    return "Pull request, \(currentPr.title)"
  }

  private var detailHeaderMetaText: String {
    let number = displayedPrNumber.map { "#\($0)" }
    let lane = currentPr.laneName?.trimmingCharacters(in: .whitespacesAndNewlines)
    let laneLabel = lane?.isEmpty == false
      ? lane
      : (currentPr.laneId.isEmpty ? "Unmapped" : currentPr.laneId)
    let branchLabel = currentPr.headBranch.isEmpty ? nil : currentPr.headBranch
    return [number, laneLabel, branchLabel]
      .compactMap { $0 }
      .filter { !$0.isEmpty }
      .joined(separator: " · ")
  }

  private var currentPr: PullRequestListItem {
    if let pr { return pr }
    if let synthesizedPr { return synthesizedPr }
    // Cold path: only hit before the first `recomputeDerivedModels()` runs.
    return Self.synthesizePlaceholderPr(
      prId: prId,
      routedPrNumber: routedPrNumber,
      requestedRepoOwner: requestedRepoScope?.repoOwner,
      requestedRepoName: requestedRepoScope?.repoName,
      githubItem: githubItem,
      snapshot: snapshot
    )
  }

  private static func synthesizePlaceholderPr(
    prId: String,
    routedPrNumber: Int?,
    requestedRepoOwner: String?,
    requestedRepoName: String?,
    githubItem: GitHubPrListItem?,
    snapshot: PullRequestSnapshot?
  ) -> PullRequestListItem {
    let detail = snapshot?.detail
    let status = snapshot?.status
    let files = snapshot?.files ?? []
    let additions = files.reduce(0) { $0 + $1.additions }
    let deletions = files.reduce(0) { $0 + $1.deletions }
    return PullRequestListItem(
      id: prId,
      laneId: "",
      laneName: nil,
      projectId: "",
      repoOwner: githubItem?.repoOwner ?? requestedRepoOwner ?? "",
      repoName: githubItem?.repoName ?? requestedRepoName ?? "",
      githubPrNumber: githubItem?.githubPrNumber ?? routedPrNumber ?? 0,
      githubUrl: githubItem?.githubUrl ?? "",
      title: githubItem?.title ?? routedPrNumber.map { "Pull request #\($0)" } ?? "Pull request",
      state:
        detail?.isDraft == true || githubItem?.isDraft == true
          ? "draft"
          : (githubItem?.state ?? status?.state ?? "open"),
      baseBranch: githubItem?.baseBranch ?? "",
      headBranch: githubItem?.headBranch ?? "",
      checksStatus: status?.checksStatus ?? "none",
      reviewStatus: status?.reviewStatus ?? "none",
      additions: additions,
      deletions: deletions,
      lastSyncedAt: nil,
      createdAt: githubItem?.createdAt ?? "",
      updatedAt: githubItem?.updatedAt ?? "",
      adeKind: githubItem?.adeKind,
      linkedGroupId: githubItem?.linkedGroupId,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: githubItem?.workflowDisplayState,
      cleanupState: githubItem?.cleanupState
    )
  }

  /// Rebuilds every render-path-expensive derived model. Call after any
  /// mutation of `pr` / `githubItem` / `snapshot` / `activityEvents`.
  @MainActor
  private func recomputeDerivedModels() {
    synthesizedPr = pr == nil
      ? Self.synthesizePlaceholderPr(
          prId: prId,
          routedPrNumber: routedPrNumber,
          requestedRepoOwner: requestedRepoScope?.repoOwner,
          requestedRepoName: requestedRepoScope?.repoName,
          githubItem: githubItem,
          snapshot: snapshot
        )
      : nil
    let snap = snapshot ?? PullRequestSnapshot(detail: nil, status: nil, checks: [], reviews: [], comments: [], files: [])
    // Ascending (oldest → newest), undated events sink to the end — mirrors
    // desktop `stableSortByTs`.
    timelineEvents = buildPullRequestTimeline(pr: currentPr, snapshot: snap, activity: activityEvents)
      .sorted { lhs, rhs in
        let l = prParsedDate(lhs.timestamp) ?? .distantFuture
        let r = prParsedDate(rhs.timestamp) ?? .distantFuture
        if l != r { return l < r }
        return lhs.id < rhs.id
      }
    timelineDisplayItems = buildPrTimelineDisplayItems(timelineEvents)
    let sortedThreads = reviewThreads.sorted { lhs, rhs in
      let l = prParsedDate(lhs.updatedAt ?? lhs.createdAt) ?? .distantPast
      let r = prParsedDate(rhs.updatedAt ?? rhs.createdAt) ?? .distantPast
      return l > r
    }
    unresolvedThreads = sortedThreads.filter { !$0.isResolved }
    resolvedThreads = sortedThreads.filter { $0.isResolved }
  }

  private var actionAvailability: PrActionAvailability {
    PrActionAvailability(prState: snapshot?.status?.state ?? currentPr.state)
  }

  private var canRerunChecks: Bool {
    capabilities?.canRerunChecks ?? syncService.supportsRemoteAction("prs.rerunChecks")
  }

  private var canAddComment: Bool {
    capabilities?.canComment ?? syncService.supportsRemoteAction("prs.addComment")
  }

  private var unresolvedThreadCount: Int {
    reviewThreads.filter { !$0.isResolved }.count
  }

  private var reviewsHave: Int {
    (snapshot?.reviews ?? []).filter { $0.state == "approved" }.count
  }

  /// `PrDetail.requestedReviewers` is the current open review-request list;
  /// treat that count as "needed" approvals. Falls back to 0 otherwise.
  private var reviewsNeeded: Int {
    snapshot?.detail?.requestedReviewers.count ?? 0
  }

  private var isCurrentPrDraft: Bool {
    currentPr.state == "draft" || snapshot?.status?.state == "draft" || snapshot?.detail?.isDraft == true
  }

  private var mergeGateInfo: PrMergeGateInfo {
    prComputeMergeGate(
      status: snapshot?.status,
      checks: snapshot?.checks ?? [],
      summaryChecksStatus: snapshot?.status?.checksStatus ?? currentPr.checksStatus,
      reviewThreadsUnresolved: unresolvedThreadCount,
      reviewsNeeded: reviewsNeeded,
      reviewsHave: reviewsHave,
      capabilities: capabilities,
      isDraft: isCurrentPrDraft
    )
  }

  private var showsStickyActionBar: Bool {
    // The unified Overview thread carries its own comment composer + inline
    // merge rail at the bottom (desktop parity), so a global sticky merge bar
    // in the same slot would cover the composer. Keep the sticky bar only on
    // the non-thread tabs (Files / Checks).
    hasPrDetailData && selectedTab != .overview && selectedTab != .activity
  }

  /// Whether the current PR is mapped to an ADE lane. Drives the unmapped
  /// banner + locked composer in the unified Overview thread.
  private var isCurrentPrMapped: Bool {
    !currentPr.laneId.isEmpty
  }

  private var canAutoMapCurrentPr: Bool {
    isLive && !isDetailBusy && syncService.supportsRemoteAction("prs.createLaneFromPrBranch")
      && githubItem?.scope != "external"
      && !currentPr.repoOwner.isEmpty && !currentPr.repoName.isEmpty
      && currentPr.githubPrNumber > 0
  }

  private var canMapCurrentPr: Bool {
    isLive && !isDetailBusy && githubItem != nil
      && githubItem?.scope != "external"
      && syncService.supportsRemoteAction("prs.linkToLane")
  }

  /// GitHub-style requirement checklist for the merge rail + merge sheet.
  /// Mirrors desktop's `buildMergeChecklist`, driven by the structured
  /// merge-state fields.
  private var mergeChecklistItems: [PrMergeChecklistItem] {
    PrMergeChecklist.build(
      prState: snapshot?.status?.state ?? currentPr.state,
      summaryReviewStatus: snapshot?.status?.reviewStatus ?? currentPr.reviewStatus,
      status: snapshot?.status,
      checks: snapshot?.checks ?? [],
      reviews: snapshot?.reviews ?? []
    )
  }

  /// The bypass toggle is shown ONLY when the viewer can bypass and the
  /// merge-box state is `blocked` (branch protection). Mirrors desktop gating.
  private var showsMergeBypassToggle: Bool {
    canRunPrActions && PrMergeChecklist.showsBypassToggle(status: snapshot?.status, capabilities: capabilities)
  }

  /// Builds the inline merge-rail model for the unified Overview thread.
  private var overviewMergeRailModel: PrOverviewMergeRailModel {
    let state = snapshot?.status?.state ?? currentPr.state
    let phase: PrOverviewMergeRailModel.Phase = {
      if state == "merged" { return .merged }
      if state == "closed" { return .closed }
      return .active
    }()
    return PrOverviewMergeRailModel(
      phase: phase,
      repoOwner: currentPr.repoOwner,
      repoName: currentPr.repoName,
      prNumber: currentPr.githubPrNumber,
      gate: mergeGateInfo,
      isDraft: isCurrentPrDraft,
      // Green must agree with the STRUCTURED checklist: the gate's review math
      // uses requestedReviewers counts, which read 0 when reviewDecision is
      // reviewRequired but nobody is currently requested — without the fail-row
      // condition the rail could enable merge under a visible failing row. The
      // non-green arm keeps the deliberate blocked-attempt (bypass) affordance.
      canMerge: canRunPrActions
        && (capabilities?.canMerge ?? actionAvailability.mergeEnabled)
        && (mergeGateInfo.tone == .green
              ? !mergeChecklistItems.contains(where: { $0.state == .fail })
              : canAttemptBlockedMerge),
      canClose: canRunPrActions && shouldShowCloseAction,
      canDeleteBranch: !currentPr.laneId.isEmpty,
      canReopen: canRunPrActions && shouldShowReopenAction,
      isBusy: isDetailBusy,
      mergeMethod: mergeMethod,
      onMerge: { presentMergeMethodPicker() },
      onChangeMethod: { mergeMethodSheetPresented = true },
      onClose: { closeCurrentPr() },
      onReopen: { reopenCurrentPr() },
      onDeleteBranch: {
        cleanupChoice = .deleteBranch
        cleanupConfirmationPresented = true
      }
    )
  }

  private var behindBaseBy: Int {
    snapshot?.status?.behindBaseBy ?? 0
  }

  /// Set of sub-tabs shown in the detail picker. The Activity tab is folded
  /// into the unified Overview thread (desktop parity), so it no longer appears
  /// as its own tab.
  private var visibleTabs: [PrDetailTab] {
    [.overview, .files, .checks]
  }

  private func tabTitle(_ tab: PrDetailTab) -> String {
    switch tab {
    case .overview: return "Overview"
    case .checks: return "CI / Checks"
    case .activity: return "Activity"
    case .files: return "Files"
    }
  }

  /// Live count for the segmented tab pill. Returns nil when no count is
  /// meaningful (Overview) or when data hasn't synced yet (zero hidden).
  private func tabCount(_ tab: PrDetailTab) -> Int? {
    switch tab {
    case .overview:
      return nil
    case .files:
      let count = snapshot?.files.count ?? 0
      return count > 0 ? count : nil
    case .checks:
      let count = snapshot?.checks.count ?? 0
      return count > 0 ? count : nil
    case .activity:
      let comments = snapshot?.comments.count ?? 0
      let reviews = snapshot?.reviews.count ?? 0
      let commits = snapshot?.commits?.count ?? 0
      let events = activityEvents.count
      let count = comments + reviews + commits + events
      return count > 0 ? count : nil
    }
  }

  var body: some View {
    ScrollViewReader { scrollProxy in
      List {
      // Durable in-flight banner: reads the label from the service registry so
      // a merge/close/comment started here keeps showing a spinner even if the
      // user switches tabs and returns.
      if let detailBusyLabel {
        HStack(spacing: 10) {
          ProgressView()
            .tint(ADEColor.accent)
          Text(detailBusyLabel)
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
          Spacer(minLength: 0)
        }
        .adeGlassCard(cornerRadius: 12, padding: 12)
        .prListRow()
      }

      if let actionMessage {
        ADENoticeCard(
          title: "PR action complete",
          message: actionMessage,
          icon: "checkmark.circle.fill",
          tint: ADEColor.success,
          actionTitle: nil,
          action: nil
        )
        .prListRow()
      }

      if let errorMessage, !syncService.connectionState.isHostUnreachable {
        ADENoticeCard(
          title: "PR detail failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: { Task { await retryPrDetailLoad() } }
        )
        .prListRow()
      }

      if !unavailableDetailParts.isEmpty {
        ADENoticeCard(
          title: "Some PR data is unavailable",
          message: "ADE could not refresh \(unavailableDetailParts.map { $0.replacingOccurrences(of: "_", with: " ") }.joined(separator: ", ")). The visible data is partial, not a zero result.",
          icon: "exclamationmark.arrow.triangle.2.circlepath",
          tint: ADEColor.warning,
          actionTitle: "Retry",
          action: { Task { await retryPrDetailLoad() } }
        )
        .prListRow()
      }

      if isAwaitingInitialPrDetail {
        ADECardSkeleton(rows: 4)
          .prListRow()
      } else if isPrDetailUnavailable {
        ADENoticeCard(
          title: "Pull request unavailable",
          message: isLive
            ? "ADE could not find \(unavailablePrLabel). Refresh the PR list and try again."
            : "Reconnect to your Mac to load \(unavailablePrLabel).",
          icon: "arrow.triangle.merge",
          tint: ADEColor.warning,
          actionTitle: "Retry",
          action: { Task { await retryPrDetailLoad() } }
        )
        .prListRow()
      } else {
        PrDetailSummarySection(
          pr: currentPr,
          snapshot: snapshot,
          mergeGate: mergeGateInfo,
          commitsExpanded: $summaryCommitsExpanded,
          onStatusTap: { selectedTab = .overview },
          onChecksTap: { selectedTab = .checks },
          onFilesTap: { selectedTab = .files },
          onCommitTap: focusCommitInTimeline
        )
        .prListRow()

        subTabPicker
          .prListRow()

        switch selectedTab {
      case .overview, .activity:
        // Unified Overview thread — folds the former Activity tab in. `.activity`
        // is routed here too so any persisted/legacy selection still renders.
        // Emitted as SIBLING List rows (not one nested mega-row) so the List
        // actually virtualizes offscreen thread content.
        overviewThreadRows(scrollProxy: scrollProxy)
      case .files:
        PrFilesTab(
          snapshot: snapshot,
          canOpenFiles: !currentPr.laneId.isEmpty,
          onOpenFile: { file in Task { await openFileInFiles(file) } },
          onCopyPath: copyFilePath
        )
          .prListRow()
      case .checks:
        PrChecksTab(
          checks: snapshot?.checks ?? [],
          overallChecksStatus: snapshot?.status?.checksStatus ?? currentPr.checksStatus,
          actionRuns: actionRuns,
          deployments: deployments,
          canRerunChecks: canRerunChecks,
          isLive: canRunPrActions,
          onRerun: rerunChecks
        )
        .prListRow()
        }
      }
      }
      .listStyle(.plain)
    .listRowSpacing(12)
    .scrollContentBackground(.hidden)
    .background(prLiquidGlassBackdrop().ignoresSafeArea())
    .adeNavigationGlass()
    .adeAnalyticsScreen(.pullRequestDetail)
    .safeAreaInset(edge: .top, spacing: 0) {
      detailNavigationHeader
    }
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .navigationBar)
    .safeAreaInset(edge: .bottom) {
      if showsStickyActionBar {
        stickyActionBar
      }
    }
    .refreshable {
      await reload(refreshRemote: true)
    }
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : "pr-container-\(prId)", in: transitionNamespace)
    .task(id: "\(syncService.prsProjectionRevision):\(syncService.prsRemoteRevision)") {
      // Seed from the warm cache first so an instant render is shown and, when
      // the cached entry is fresh, `hasLoadedLiveSidecars` is set BEFORE the
      // gate below evaluates. Doing this inside `.task` (rather than relying on
      // `.onAppear` firing first) makes the ordering deterministic.
      seedFromWarmCacheIfNeeded()
      // Freshness gate: a FRESH warm-cache entry (loaded < detailFreshnessWindow
      // ago) means this revision-driven reload skips the sidecar fan-out (8+
      // network calls) and only refreshes the cheap local projection. Once the
      // window lapses, the next projection bump re-fetches the sidecars too.
      // That is what keeps review threads / activity / checks runs live while
      // the screen is open: GitHub webhooks land on the host, the host's hot
      // poll rewrites the replicated snapshot rows, the changeset pump bumps
      // `prsProjectionRevision` here, and this gate turns that into a throttled
      // sidecar refresh instead of a one-shot load.
      let needLiveSidecars = shouldFetchPrDetailLiveSidecars(
        hasLoadedLiveSidecars: hasLoadedLiveSidecars,
        refreshRemote: false
      ) || !syncService.prDetailWarmEntryIsFresh(for: prId, within: Self.detailFreshnessWindow)
      await reload(includeLiveSidecars: needLiveSidecars)
    }
    .onChange(of: pendingTimelineScrollId) { _, anchorId in
      guard let anchorId else { return }
      scrollPendingTimelineAnchorIfReady(anchorId: anchorId, scrollProxy: scrollProxy)
    }
    .sheet(isPresented: $cleanupConfirmationPresented) {
      PrCleanupConfirmationSheet(
        choice: cleanupChoice,
        onConfirm: {
          cleanupConfirmationPresented = false
          Task { await performCleanup() }
        },
        onCancel: {
          cleanupConfirmationPresented = false
        }
      )
      .presentationDetents([.height(340)])
      .presentationDragIndicator(.hidden)
      .presentationBackground(.clear)
    }
    .sheet(isPresented: $mergeMethodSheetPresented) {
      PrMergeStrategySheet(
        selected: $mergeMethod,
        checklist: mergeChecklistItems,
        canAttemptBlockedMerge: canAttemptBlockedMerge,
        showsBypassToggle: showsMergeBypassToggle,
        prTitle: currentPr.title,
        prNumber: currentPr.githubPrNumber,
        headBranch: currentPr.headBranch,
        repoOwner: currentPr.repoOwner,
        commits: snapshot?.commits ?? [],
        onMerge: { method, bypass, commitTitle, commitBody in
          mergeMethod = method
          mergeMethodSheetPresented = false
          mergeCurrentPr(bypassRules: bypass, commitTitle: commitTitle, commitBody: commitBody)
        },
        onCancel: {
          mergeMethodSheetPresented = false
        }
      )
      .presentationDetents([.large])
      .presentationDragIndicator(.hidden)
      .presentationBackground(.clear)
    }
    .sheet(item: $stackPresentation) { presentation in
      PrStackSheet(groupId: presentation.id, groupName: presentation.groupName)
        .environmentObject(syncService)
    }
    .sheet(item: $laneLinkItem) { item in
      PrLaneLinkSheet(
        item: item,
        lanes: availableLanes,
        canLink: canMapCurrentPr
      ) { laneId in
        runPrAction(
          "Linking pull request",
          action: {
            try await syncService.linkPullRequestToLane(
              laneId: laneId,
              prUrlOrNumber: item.githubUrl.isEmpty ? "\(item.githubPrNumber)" : item.githubUrl
            )
          },
          onSuccess: { laneLinkItem = nil }
        )
      } onOpenGitHub: {
        openGitHub(urlString: item.githubUrl)
      }
      .presentationDetents([.large])
      .presentationDragIndicator(.hidden)
      .presentationBackground(.clear)
    }
    .sheet(isPresented: $actionsSheetPresented) {
      prActionsSheet
        .presentationDetents([.height(560)])
        .presentationDragIndicator(.hidden)
        .presentationBackground(.clear)
    }
    .sheet(item: $editorSheet) { sheet in
      switch sheet {
      case .title(let title):
        PrSingleLineEditSheet(
          title: "Edit title",
          fieldTitle: "Title",
          initialValue: title,
          submitTitle: "Save"
        ) { value in
          runPrAction("Updating PR title") {
            try await syncService.updatePullRequestTitle(prId: effectivePrId, title: value)
          } onSuccess: {
            editorSheet = nil
          }
        }
      case .body(let body):
        PrMultilineEditSheet(
          title: "Edit description",
          initialValue: body,
          submitTitle: "Save"
        ) { value in
          runPrAction("Updating PR description") {
            try await syncService.updatePullRequestBody(prId: effectivePrId, body: value)
          } onSuccess: {
            editorSheet = nil
          }
        }
      case .labels(let labels):
        PrSingleLineEditSheet(
          title: "Set labels",
          fieldTitle: "Labels",
          initialValue: labels,
          submitTitle: "Save"
        ) { value in
          let labels = value
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
          runPrAction("Updating labels") {
            try await syncService.setPullRequestLabels(prId: effectivePrId, labels: labels)
          } onSuccess: {
            editorSheet = nil
          }
        }
      case .review:
        PrSubmitReviewSheet { event, body in
          runPrAction("Submitting review") {
            try await syncService.submitPullRequestReview(prId: effectivePrId, event: event.rawValue, body: body)
          } onSuccess: {
            editorSheet = nil
          }
        }
      }
    }
    }
  }

  private var detailNavigationHeader: some View {
    HStack(spacing: 8) {
      Button {
        dismiss()
      } label: {
        Image(systemName: "chevron.left")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(width: 40, height: 40)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Back to PRs")

      VStack(alignment: .center, spacing: 2) {
        Text(currentPr.title)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.tail)
        Text(detailHeaderMetaText)
          .font(.system(size: 10.5, weight: .medium, design: .monospaced))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }
      .frame(maxWidth: .infinity)
      .accessibilityElement(children: .combine)
      .accessibilityLabel(detailHeaderAccessibilityLabel)

      Button {
        actionsSheetPresented = true
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 18, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(width: 40, height: 40)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Pull request actions")
    }
    .padding(.horizontal, 16)
    .padding(.top, 2)
    .padding(.bottom, 8)
    .background {
      ADEColor.pageBackground
        .opacity(0.98)
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false)
    }
  }

  private var prActionsSheet: some View {
    PrDetailActionsSheet(
      canUpdateMetadata: canUpdateCurrentPrMetadata,
      canRunActions: canRunPrActions,
      shouldShowClose: shouldShowCloseAction,
      shouldShowReopen: shouldShowReopenAction,
      canClose: canCloseCurrentPr,
      canReopen: canReopenCurrentPr,
      canOpenGitHub: canOpenCurrentPrInGitHub,
      hasGitHubUrl: !currentPr.githubUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
      hasADELink: !currentPr.repoOwner.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && !currentPr.repoName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && currentPr.githubPrNumber > 0,
      onDismiss: { actionsSheetPresented = false },
      onEditTitle: {
        actionsSheetPresented = false
        editorSheet = .title(currentPr.title)
      },
      onEditDescription: {
        actionsSheetPresented = false
        editorSheet = .body(snapshot?.detail?.body ?? "")
      },
      onSetLabels: {
        let labels = snapshot?.detail?.labels.map(\.name).joined(separator: ", ") ?? ""
        actionsSheetPresented = false
        editorSheet = .labels(labels)
      },
      onSubmitReview: {
        actionsSheetPresented = false
        editorSheet = .review
      },
      onClose: {
        actionsSheetPresented = false
        closeCurrentPr()
      },
      onReopen: {
        actionsSheetPresented = false
        reopenCurrentPr()
      },
      onOpenGitHub: {
        actionsSheetPresented = false
        openGitHub(urlString: currentPr.githubUrl)
      },
      onCopyUrl: {
        actionsSheetPresented = false
        UIPasteboard.general.string = currentPr.githubUrl
        ADEHaptics.success()
        actionMessage = "URL copied."
      },
      onCopyAdeLink: {
        actionsSheetPresented = false
        UIPasteboard.general.string = LaneDeeplinkHelpers.prLink(
          repoOwner: currentPr.repoOwner,
          repoName: currentPr.repoName,
          number: currentPr.githubPrNumber
        )
        ADEHaptics.success()
        actionMessage = "ADE link copied."
      },
      onRefresh: {
        actionsSheetPresented = false
        Task { await reload(refreshRemote: true) }
      }
    )
  }

  // MARK: - Sub-tab picker

  /// Compact tab labels used in the inactive state where we have less room.
  /// Active tab gets the full label so the user always knows where they are.
  private func compactTabTitle(_ tab: PrDetailTab) -> String {
    switch tab {
    case .checks: return "Checks"
    default: return tabTitle(tab)
    }
  }

  private var subTabPicker: some View {
    HStack(spacing: 4) {
      ForEach(visibleTabs) { tab in
        let active = selectedTab == tab
        let count = tabCount(tab)
        Button {
          withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
            selectedTab = tab
          }
        } label: {
          HStack(spacing: 4) {
            Text(active ? tabTitle(tab) : compactTabTitle(tab))
              .font(.system(size: 12.5, weight: active ? .semibold : .medium))
              .foregroundStyle(active ? ADEColor.textPrimary : ADEColor.textSecondary)
              .lineLimit(1)
              .minimumScaleFactor(0.85)
            if let count {
              Text("\(count)")
                .font(.system(size: 9.5, weight: .bold, design: .monospaced))
                .foregroundStyle(active ? ADEColor.tintPRs : ADEColor.textMuted)
                .padding(.horizontal, 4)
                .padding(.vertical, 1.5)
                .background(
                  Capsule(style: .continuous)
                    .fill((active ? ADEColor.tintPRs : ADEColor.textMuted).opacity(0.16))
                )
            }
          }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 9)
            .background {
              if active {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .fill(PrGlassPalette.panelCard)
                  .overlay(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                      .strokeBorder(PrGlassPalette.cardBorder, lineWidth: 0.6)
                  )
              }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
    }
    .padding(4)
    .frame(height: 40)
    .background(
      RoundedRectangle(cornerRadius: 13, style: .continuous)
        .fill(PrGlassPalette.threadCard)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 13, style: .continuous)
        .strokeBorder(PrGlassPalette.cardBorder, lineWidth: 0.5)
    )
    .padding(.horizontal, 2)
    .padding(.top, 2)
  }

  // MARK: - Overview thread rows (desktop Timeline+Rails, stacked for mobile)
  //
  // Desktop reading order adapted to one column: AI summary → description →
  // chronological event feed → review threads → composer → merge rail →
  // metadata cards (checks / commits / files / people / stack). Every card is
  // its own List row.
  @ViewBuilder
  private func overviewThreadRows(scrollProxy: ScrollViewProxy) -> some View {
    if !isCurrentPrMapped {
      PrUnmappedThreadBanner(
        canAutoMap: canAutoMapCurrentPr,
        canMap: canMapCurrentPr,
        onAutoMap: autoMapCurrentPr,
        onMap: {
          if let githubItem {
            laneLinkItem = githubItem
          }
        },
        onOpenInGitHub: { openGitHub(urlString: currentPr.githubUrl) }
      )
      .prListRow()
    }

    // AI summary — desktop pins it at the top of the timeline. +/- totals come
    // from the snapshot's file list (same source as the Files card) so the two
    // never disagree; the PR-row totals are only a fallback when files haven't
    // synced yet.
    let summaryFiles = snapshot?.files ?? []
    PrAiSummaryCard(
      summary: aiSummary,
      additions: summaryFiles.isEmpty ? currentPr.additions : summaryFiles.reduce(0) { $0 + $1.additions },
      deletions: summaryFiles.isEmpty ? currentPr.deletions : summaryFiles.reduce(0) { $0 + $1.deletions },
      fileCount: summaryFiles.count,
      isLoading: isAiSummaryLoading,
      isLive: canRunPrActions,
      onRegenerate: refreshAiSummary
    )
    .padding(14)
    .prGlassCard(cornerRadius: 16)
    .prListRow()

    // Description (PR body) — the first card of the chronological thread.
    let descriptionText = (snapshot?.detail?.body ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    if !descriptionText.isEmpty {
      PrThreadDescriptionCard(
        author: snapshot?.detail?.author.login ?? githubItem?.author,
        text: descriptionText
      )
      .prListRow()
    }

    // Chronological event feed — one row per event / folded commit group.
    ForEach(timelineDisplayItems) { item in
      let anchorId = timelineAnchorId(for: item)
      PrTimelineDisplayRow(item: item)
        .id(anchorId)
        .onAppear {
          timelineSectionMounted = true
          scrollPendingTimelineAnchorIfReady(anchorId: pendingTimelineScrollId, scrollProxy: scrollProxy)
        }
        .onDisappear {
          if selectedTab != .overview && selectedTab != .activity {
            timelineSectionMounted = false
          }
        }
        .prListRow()
    }

    // Review threads: unresolved first, resolved folded away (desktop parity).
    if !unresolvedThreads.isEmpty {
      PrThreadSectionHeader(title: "Threads", trailing: "\(unresolvedThreads.count) unresolved")
        .prListRow()
      ForEach(unresolvedThreads) { thread in
        PrReviewThreadCard(
          thread: thread,
          isLive: canRunPrActions,
          isFocused: focusedThreadId == thread.id,
          replyDraft: Binding(
            get: { replyDraft[thread.id] ?? "" },
            set: { replyDraft[thread.id] = $0 }
          ),
          onFocus: { focusedThreadId = thread.id },
          onReply: { body in
            replyToThread(threadId: thread.id, body: body)
            replyDraft[thread.id] = ""
          },
          onResolve: { resolved in setThreadResolved(threadId: thread.id, resolved: resolved) }
        )
        .prListRow()
      }
    }
    if !resolvedThreads.isEmpty {
      PrCollapsibleResolvedSection(
        threads: resolvedThreads,
        isLive: canRunPrActions,
        onReopen: { threadId in setThreadResolved(threadId: threadId, resolved: false) }
      )
      .prListRow()
    }

    // Comment composer — locked when the PR is unmapped.
    if isCurrentPrMapped {
      VStack(alignment: .leading, spacing: 6) {
        PrReplyComposer(
          text: $commentInput,
          placeholder: focusedThreadId != nil ? "Reply…" : "Comment on PR…",
          isLive: canRunPrActions && canAddComment,
          onSend: {
            if let focusedThreadId {
              replyToThread(threadId: focusedThreadId, body: commentInput)
              commentInput = ""
            } else {
              submitComment()
            }
          },
          onClearFocus: focusedThreadId != nil ? { focusedThreadId = nil } : nil
        )
        if !canAddComment {
          Text("Posting comments requires a machine that exposes PR comment actions to mobile.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
        }
      }
      .prListRow()
    } else {
      PrLockedComposerBar()
        .prListRow()
    }

    // Inline merge rail with the requirement checklist (desktop merge rail).
    PrOverviewMergeRail(model: overviewMergeRailModel, checklist: mergeChecklistItems)
      .prListRow()

    // Metadata cards — the desktop right rail, stacked.
    if let snapshot, !snapshot.checks.isEmpty {
      PrOverviewChecksCard(checks: snapshot.checks) { selectedTab = .checks }
        .prListRow()
    }
    if let commits = snapshot?.commits, !commits.isEmpty {
      PrOverviewCommitsCard(commits: commits)
        .prListRow()
    }
    if let files = snapshot?.files, !files.isEmpty {
      PrOverviewFilesCard(files: files) { selectedTab = .files }
        .prListRow()
    }
    if snapshot?.detail != nil {
      PrOverviewPeopleCard(
        detail: snapshot?.detail,
        reviews: snapshot?.reviews ?? [],
        authorLogin: snapshot?.detail?.author.login ?? githubItem?.author
      )
      .prListRow()
    }
    if !groupMembers.isEmpty, let groupId = currentPr.linkedGroupId {
      PrOverviewStackCard(
        groupMembers: groupMembers,
        groupId: groupId,
        laneName: currentPr.laneName,
        isLive: canRunPrActions,
        onOpenStack: openStack
      )
      .prListRow()
    }
    if currentPr.state == "merged" {
      PrLaneCleanupBanner(
        laneName: currentPr.laneName,
        isLive: canRunPrActions,
        onArchive: {
          cleanupChoice = .archive
          cleanupConfirmationPresented = true
        },
        onDeleteBranch: {
          cleanupChoice = .deleteBranch
          cleanupConfirmationPresented = true
        }
      )
      .prListRow()
    }

    Color.clear
      .frame(height: 88)
      .accessibilityHidden(true)
      .prListRow()
  }

  private func timelineAnchorId(for item: PrTimelineDisplayItem) -> String {
    "pr-timeline-\(item.id)"
  }

  private func focusCommitInTimeline(_ commit: PrCommit) {
    let missingCommitMessage = "That commit is not in the loaded conversation timeline yet."
    let timelineWasMounted = selectedTab == .overview || selectedTab == .activity
    if !timelineWasMounted {
      timelineSectionMounted = false
    }
    selectedTab = .overview
    pendingTimelineScrollId = nil
    guard let anchorId = timelineAnchorId(for: commit) else {
      errorMessage = missingCommitMessage
      return
    }
    if errorMessage == missingCommitMessage {
      errorMessage = nil
    }
    ADEHaptics.light()
    pendingTimelineScrollId = anchorId
  }

  private func timelineAnchorId(for commit: PrCommit) -> String? {
    for item in timelineDisplayItems {
      switch item {
      case .event(let event):
        if eventMatches(commit: commit, event: event) {
          return timelineAnchorId(for: item)
        }
      case .commitGroup(_, _, let events):
        if events.contains(where: { eventMatches(commit: commit, event: $0) }) {
          return timelineAnchorId(for: item)
        }
      }
    }
    return nil
  }

  private func eventMatches(commit: PrCommit, event: PrTimelineEvent) -> Bool {
    guard event.kind == .commit else { return false }
    let shortSha = commit.shortSha.isEmpty ? String(commit.sha.prefix(7)) : commit.shortSha
    let fullSha = commit.sha
    guard !shortSha.isEmpty || !fullSha.isEmpty else { return false }
    let haystack = [
      event.id,
      event.title,
      event.metadata ?? "",
    ].joined(separator: " ")
    return (!shortSha.isEmpty && haystack.localizedCaseInsensitiveContains(shortSha))
      || (!fullSha.isEmpty && haystack.localizedCaseInsensitiveContains(fullSha))
  }

  private func scrollPendingTimelineAnchorIfReady(anchorId: String?, scrollProxy: ScrollViewProxy) {
    guard let anchorId, timelineSectionMounted else { return }
    Task { @MainActor in
      let retryDelays: [UInt64] = [0, 80_000_000, 220_000_000]
      for (index, delay) in retryDelays.enumerated() {
        if delay == 0 {
          await Task.yield()
        } else {
          try? await Task.sleep(nanoseconds: delay)
        }
        guard pendingTimelineScrollId == anchorId, timelineSectionMounted else { return }
        withAnimation(.easeInOut(duration: 0.25)) {
          scrollProxy.scrollTo(anchorId, anchor: .center)
        }
        if index == retryDelays.count - 1 {
          pendingTimelineScrollId = nil
        }
      }
    }
  }

  // MARK: - Sticky action bar

  private var stickyActionBar: some View {
    let gate = mergeGateInfo
    let canRebaseFromGate = gate.tone == .amber
      && gate.target == .overview
      && (behindBaseBy > 0 || snapshot?.status?.isMergeable == false)

    // Single full-width action — matches the mocks. The pre-merge "needs
    // rebase" / "merge blocked" states surface as inline body cards (Merge
    // Gate, Needs Attention, Rebase Banner) — they don't double up as
    // bottom buttons. The bottom bar is the one decisive action right now.
    let label: String
    let symbol: String
    let isPrimary: Bool   // green = ready to merge
    let isAmber: Bool     // amber = need rebase first
    let action: () -> Void
    let enabled: Bool

    switch gate.tone {
    case .green:
      label = "Merge"
      symbol = "checkmark.seal.fill"
      isPrimary = true
      isAmber = false
      // Same structured-checklist agreement rule as overviewMergeRailModel.
      enabled = canRunPrActions
        && (capabilities?.canMerge ?? actionAvailability.mergeEnabled)
        && !mergeChecklistItems.contains(where: { $0.state == .fail })
      action = { presentMergeMethodPicker() }
    case .amber:
      if canRebaseFromGate {
        label = behindBaseBy > 0 ? "Rebase · \(behindBaseBy) behind" : "Rebase"
        symbol = "arrow.triangle.2.circlepath"
      } else if gate.target == .checks {
        label = "Checks pending"
        symbol = "clock.badge.checkmark"
      } else if gate.target == .reviews {
        label = "Review needed"
        symbol = "person.crop.circle.badge.exclamationmark"
      } else {
        label = "Waiting for status"
        symbol = "clock"
      }
      isPrimary = false
      isAmber = true
      enabled = canRebaseFromGate && canRunPrActions && !currentPr.laneId.isEmpty
      action = { if canRebaseFromGate { triggerRebase() } }
    case .red where canAttemptBlockedMerge:
      label = "Attempt merge"
      symbol = "arrow.triangle.merge"
      isPrimary = false
      isAmber = true
      enabled = true
      action = { presentMergeMethodPicker() }
    case .red:
      label = "Merge blocked"
      symbol = "xmark.octagon.fill"
      isPrimary = false
      isAmber = false
      enabled = false
      action = { }
    }

    return PrStickyActionBar {
      Button {
        if enabled {
          ADEHaptics.success()
          action()
        }
      } label: {
        HStack(spacing: 8) {
          // Inline spinner mirrors the per-button pattern from PrRebaseScreen so
          // the decisive bottom action shows local progress while its durable
          // round-trip runs.
          if isDetailBusy {
            ProgressView()
              .controlSize(.small)
              .tint(isPrimary ? .white : (isAmber ? ADEColor.warning : ADEColor.danger))
          } else {
            Image(systemName: symbol)
              .font(.system(size: 14, weight: .bold))
          }
          Text(isDetailBusy ? (detailBusyLabel ?? label) : label)
            .font(.system(size: 15, weight: .bold))
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
        }
        .foregroundStyle(isPrimary ? Color.white : (isAmber ? ADEColor.warning : ADEColor.danger))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background {
          if isPrimary {
            RoundedRectangle(cornerRadius: 16, style: .continuous)
              .fill(ADEColor.success)
          } else {
            ZStack {
              RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(PrGlassPalette.threadCard)
              RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill((isAmber ? ADEColor.warning : ADEColor.danger).opacity(0.12))
            }
          }
        }
        .overlay(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(
              isPrimary ? Color.white.opacity(0.20) : (isAmber ? ADEColor.warning.opacity(0.45) : ADEColor.danger.opacity(0.45)),
              lineWidth: 0.75
            )
        )
        .opacity(enabled ? 1 : 0.55)
      }
      .buttonStyle(.plain)
      .disabled(!enabled)
    }
  }

  private func presentMergeMethodPicker() {
    mergeMethodSheetPresented = true
  }

  @MainActor
  private func triggerRebase() {
    guard !currentPr.laneId.isEmpty else {
      errorMessage = "This PR has no linked lane — rebase is unavailable."
      return
    }
    runPrAction("Starting rebase") {
      try await syncService.startLaneRebase(laneId: currentPr.laneId)
    }
  }

  // MARK: - Data loading

  private static func prNumber(fromRouteId routeId: String) -> Int? {
    let prefix = "github-pr-number:"
    guard routeId.hasPrefix(prefix) else { return nil }
    return Int(routeId.dropFirst(prefix.count))
  }

  @MainActor
  private func reload(refreshRemote: Bool = false, includeLiveSidecars: Bool? = nil) async {
    let requestedPrNumber = routedPrNumber
    let routeCoordinates = routedGitHubCoordinates
    let shouldFetchLiveSidecars = isLive && (includeLiveSidecars ?? (refreshRemote || requestedPrNumber != nil))

    do {
      var refreshError: Error?
      if refreshRemote, routeCoordinates == nil {
        do {
          if requestedPrNumber == nil {
            try await syncService.refreshPullRequestSnapshots(prId: effectivePrId)
          } else {
            try await syncService.refreshPullRequestSnapshots()
          }
        } catch {
          refreshError = error
        }
      }
      let listItems = try await syncService.fetchPullRequestListItems()
      var fallbackGitHubItem: GitHubPrListItem? = githubItem
      if shouldFetchLiveSidecars && requestedPrNumber != nil && routeCoordinates == nil {
        if fallbackGitHubItem == nil {
          fallbackGitHubItem = await fetchGitHubFallbackItem(requestedPrNumber: requestedPrNumber)
        }
      }

      pr = prDetailRouteListItem(
        from: listItems,
        prId: prId,
        requestedPrNumber: requestedPrNumber,
        githubItem: fallbackGitHubItem,
        requestedRepoOwner: requestedRepoScope?.repoOwner,
        requestedRepoName: requestedRepoScope?.repoName
      )
      let snapshotPrId = pr?.id ?? (requestedPrNumber == nil ? prId : nil)

      if pr == nil, let routeCoordinates {
        githubItem = fallbackGitHubItem
        if shouldFetchLiveSidecars {
          let mobileDetail = try await syncService.fetchPrMobileGithubDetail(
            repoOwner: routeCoordinates.repoOwner,
            repoName: routeCoordinates.repoName,
            githubPrNumber: routeCoordinates.githubPrNumber
          )
          let unavailable = Set(mobileDetail.unavailableParts)
          let previousSnapshot = snapshot
          let incomingSnapshot = mobileDetail.snapshot
          githubItem = mobileDetail.item
          snapshot = prMergeMobileGithubSnapshot(
            incoming: incomingSnapshot,
            previous: previousSnapshot,
            unavailableParts: mobileDetail.unavailableParts
          )
          if !unavailable.contains("review_threads") {
            reviewThreads = mobileDetail.reviewThreads
          }
          if !unavailable.contains("action_runs") {
            actionRuns = mobileDetail.actionRuns
          }
          if !unavailable.contains("activity") {
            activityEvents = mobileDetail.activity
          }
          unavailableDetailParts = mobileDetail.unavailableParts
          deployments = []
          aiSummary = nil
          capabilities = nil
          groupMembers = []
          // Partial failures retain the last good values above and use the
          // normal 25-second freshness window as retry backoff. Explicit Retry
          // still bypasses the gate immediately.
          hasLoadedLiveSidecars = true
        }
        errorMessage = refreshError?.localizedDescription
        recomputeDerivedModels()
        if shouldFetchLiveSidecars {
          storeWarmCache()
        }
        hasAttemptedInitialLoad = true
        return
      }

      if let snapshotPrId {
        snapshot = try await syncService.fetchPullRequestSnapshot(prId: snapshotPrId)
      } else {
        snapshot = nil
      }
      // Fall back to the repo-scoped GitHub snapshot when the PR isn't in the
      // lane-PR list. This keeps the hero card from collapsing into
      // "Pull request / @unknown" placeholders without resurrecting legacy
      // cross-repo snapshot items.
      if pr == nil && shouldFetchLiveSidecars {
        if fallbackGitHubItem == nil {
          fallbackGitHubItem = await fetchGitHubFallbackItem(requestedPrNumber: requestedPrNumber)
        }
        githubItem = fallbackGitHubItem
      } else if pr != nil {
        githubItem = nil
      }
      let sidecarPrId = snapshotPrId ?? githubItem?.linkedPrId ?? prId
      let capabilitiesTask: Task<PrActionCapabilities?, Never>? = shouldFetchLiveSidecars ? Task {
        do {
          let mobileSnapshot = try await syncService.fetchPrMobileSnapshot()
          return mobileSnapshot.capabilities[sidecarPrId]
        } catch {
          return nil
        }
      } : nil
      let reviewThreadsTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchPullRequestReviewThreads(prId: sidecarPrId) } : nil
      let actionRunsTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchPullRequestActionRuns(prId: sidecarPrId) } : nil
      let activityTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchPullRequestActivity(prId: sidecarPrId) } : nil
      let deploymentsTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchPullRequestDeployments(prId: sidecarPrId) } : nil
      let aiSummaryTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchPullRequestAiSummary(prId: sidecarPrId) } : nil
      if let reviewThreadsTask {
        reviewThreads = await reviewThreadsTask.value ?? []
      }
      if let actionRunsTask {
        actionRuns = await actionRunsTask.value ?? []
      }
      if let activityTask {
        activityEvents = await activityTask.value ?? []
      }
      if let deploymentsTask {
        deployments = await deploymentsTask.value ?? []
      }
      if let summary = await aiSummaryTask?.value {
        aiSummary = summary
      }
      if let capabilitiesTask {
        capabilities = await capabilitiesTask.value
      }
      if let groupId = pr?.linkedGroupId {
        groupMembers = try await syncService.fetchPullRequestGroupMembers(groupId: groupId)
      } else {
        groupMembers = []
      }
      unavailableDetailParts = []
      errorMessage = refreshError?.localizedDescription
    } catch {
      errorMessage = error.localizedDescription
    }

    recomputeDerivedModels()

    if shouldFetchLiveSidecars {
      hasLoadedLiveSidecars = true
      // Persist a warm entry once a full live load lands so re-opening the PR
      // (or re-entering the tab) renders instantly from cache while the
      // freshness gate decides whether to refetch.
      storeWarmCache()
    }
    hasAttemptedInitialLoad = true
  }

  /// Seed local detail state from the service warm cache on first appearance so
  /// the screen renders immediately instead of flashing the skeleton while the
  /// `.task` reload runs. Only seeds once per view lifetime, before any fresh
  /// load has populated state.
  @MainActor
  private func seedFromWarmCacheIfNeeded() {
    guard !hasSeededFromWarmCache, !hasPrDetailData else { return }
    hasSeededFromWarmCache = true
    guard
      let entry = syncService.prDetailWarmEntry(for: prId),
      prDetailWarmEntryMatchesRequestedScope(entry, requestedRepoScope: requestedRepoScope)
    else { return }
    pr = entry.pr
    githubItem = entry.githubItem
    snapshot = entry.snapshot
    reviewThreads = entry.reviewThreads
    actionRuns = entry.actionRuns
    activityEvents = entry.activityEvents
    deployments = entry.deployments
    aiSummary = entry.aiSummary
    groupMembers = entry.groupMembers
    capabilities = entry.capabilities
    unavailableDetailParts = entry.unavailableParts
    // Treat the cache as a successful prior load so the UI shows content (not
    // the skeleton/unavailable states) while the background refresh runs.
    hasAttemptedInitialLoad = true
    // Only suppress the cold sidecar fan-out when the cached entry is still
    // FRESH. A stale entry seeds the visuals for an instant render but leaves
    // `hasLoadedLiveSidecars == false`, so the `.task` below performs a full
    // refresh instead of letting stale data permanently mask fresh server
    // state. This is the single place the freshness window is enforced.
    if syncService.prDetailWarmEntryIsFresh(for: prId, within: Self.detailFreshnessWindow) {
      hasLoadedLiveSidecars = true
    }
    recomputeDerivedModels()
  }

  /// Snapshot the current fully-loaded detail state into the service warm cache.
  @MainActor
  private func storeWarmCache() {
    syncService.storePrDetailWarmEntry(
      PrDetailWarmEntry(
        pr: pr,
        githubItem: githubItem,
        snapshot: snapshot,
        reviewThreads: reviewThreads,
        actionRuns: actionRuns,
        activityEvents: activityEvents,
        deployments: deployments,
        aiSummary: aiSummary,
        groupMembers: groupMembers,
        capabilities: capabilities,
        unavailableParts: unavailableDetailParts,
        loadedAt: Date()
      ),
      for: prId
    )
  }

  @MainActor
  private func retryPrDetailLoad() async {
    hasAttemptedInitialLoad = false
    errorMessage = nil
    await reload(refreshRemote: true)
  }

  @MainActor
  private func fetchGitHubFallbackItem(requestedPrNumber: Int?) async -> GitHubPrListItem? {
    guard let github = try? await syncService.fetchGitHubPullRequestSnapshot(
      includeExternalClosed: true,
      historyPageLimit: 2
    ) else { return nil }
    let routeScope = requestedRepoScope
    return repoScopedGitHubPullRequests(from: github)
      .first {
        let identityMatches = $0.linkedPrId == prId || $0.id == prId
        let numberMatches = requestedPrNumber != nil && $0.githubPrNumber == requestedPrNumber
        guard identityMatches || numberMatches else { return false }
        guard let routeScope else { return true }
        return $0.repoOwner.caseInsensitiveCompare(routeScope.repoOwner) == .orderedSame
          && $0.repoName.caseInsensitiveCompare(routeScope.repoName) == .orderedSame
      }
  }

  /// Main detail-action funnel. Routes through the durable service registry
  /// keyed by `detailActionKey` so the spinner + completion survive a tab switch
  /// + remount: the remote round-trip runs at the service level and COMPLETES
  /// regardless of this view's lifecycle. The view-side success/error toast and
  /// reload only run when the view is still alive — acceptable for ephemeral
  /// feedback; the durable part is the in-flight state and the work itself.
  @MainActor
  private func runPrAction(_ label: String, action: @escaping () async throws -> Void, onSuccess: @escaping @MainActor () -> Void = {}) {
    let service = syncService
    let key = detailActionKey
    let actionablePrId = effectivePrId
    errorMessage = nil
    actionMessage = nil
    service.runDurablePrAction(
      key: key,
      label: label,
      operation: {
        try await action()
        // Refresh remote snapshots at the service level so the result lands
        // even if the view is gone by the time the round-trip completes.
        try? await service.refreshPullRequestSnapshots(prId: actionablePrId)
      },
      onSuccess: {
        onSuccess()
        Task { await reload(includeLiveSidecars: true) }
        actionMessage = "\(label) finished."
      },
      onFailure: { error in
        Task { await reload(includeLiveSidecars: true) }
        errorMessage = error.localizedDescription
      }
    )
  }

  private func mergeCurrentPr(
    bypassRules: Bool = false,
    commitTitle: String? = nil,
    commitBody: String? = nil
  ) {
    // Stale-head guard: pass the SHA the status was computed against so GitHub
    // rejects (409) if the head advanced while the sheet was open.
    let expectedHeadSha = snapshot?.status?.headSha
    let label = bypassRules ? "Merging (admin bypass)" : "Merging pull request"
    runPrAction(label) {
      try await syncService.mergePullRequest(
        prId: effectivePrId,
        method: mergeMethod.rawValue,
        bypassRules: bypassRules,
        commitTitle: commitTitle,
        commitBody: commitBody,
        expectedHeadSha: expectedHeadSha
      )
    }
  }

  private func closeCurrentPr() {
    runPrAction("Closing pull request") { try await syncService.closePullRequest(prId: effectivePrId) }
  }

  private func reopenCurrentPr() {
    runPrAction("Reopening pull request") { try await syncService.reopenPullRequest(prId: effectivePrId) }
  }

  /// Auto-map the current (unmapped) PR: create a lane from its head branch via
  /// the durable action wrapper so the spinner survives a tab switch. On a
  /// blocking conflict the message surfaces through the standard failure path.
  private func autoMapCurrentPr() {
    let owner = currentPr.repoOwner
    let repo = currentPr.repoName
    let number = currentPr.githubPrNumber
    guard !owner.isEmpty, !repo.isEmpty else { return }
    runPrAction("Creating lane from PR branch") {
      let result = try await syncService.createLaneFromPrBranch(
        repoOwner: owner,
        repoName: repo,
        githubPrNumber: number
      )
      if let conflict = result.preflight.blockingConflict {
        throw PrAutoMapError.blocked(conflict.message)
      }
    }
  }

  private func requestReviewers() {
    let reviewers = reviewerInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }

    guard !reviewers.isEmpty else { return }

    runPrAction(
      "Requesting reviewers",
      action: { try await syncService.requestReviewers(prId: effectivePrId, reviewers: reviewers) },
      onSuccess: { reviewerInput = "" }
    )
  }

  private func rerunChecks() {
    runPrAction("Re-running checks") { try await syncService.rerunPullRequestChecks(prId: effectivePrId) }
  }

  private func refreshAiSummary() {
    guard canRunPrActions, !isAiSummaryLoading else { return }
    let service = syncService
    let key = aiSummaryKey
    let actionablePrId = effectivePrId
    let token = service.beginPrAction(key: key, label: "Regenerating AI summary")
    Task { @MainActor in
      defer { service.endPrAction(key: key, token: token) }
      do {
        let summary = try await service.fetchPullRequestAiSummary(prId: actionablePrId)
        aiSummary = summary
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  private func submitComment() {
    let trimmed = commentInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    runPrAction(
      "Posting comment",
      action: { try await syncService.addPullRequestComment(prId: effectivePrId, body: trimmed) },
      onSuccess: { commentInput = "" }
    )
  }

  private func replyToThread(threadId: String, body: String) {
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    runPrAction("Replying to review thread") {
      try await syncService.replyToPullRequestReviewThread(prId: effectivePrId, threadId: threadId, body: trimmed)
    }
  }

  private func setThreadResolved(threadId: String, resolved: Bool) {
    runPrAction(resolved ? "Resolving review thread" : "Reopening review thread") {
      try await syncService.setPullRequestReviewThreadResolved(prId: effectivePrId, threadId: threadId, resolved: resolved)
    }
  }

  private func performCleanup() async {
    guard let laneId = pr?.laneId, !laneId.isEmpty else { return }
    let choice = cleanupChoice
    let token = syncService.beginPrAction(
      key: detailActionKey,
      label: choice == .archive ? "Archiving lane" : "Deleting lane and branch"
    )
    defer { syncService.endPrAction(key: detailActionKey, token: token) }
    errorMessage = nil
    actionMessage = nil
    do {
      switch choice {
      case .archive:
        try await syncService.archiveLane(laneId)
      case .deleteBranch:
        try await syncService.deleteLane(laneId, deleteBranch: true, deleteRemoteBranch: true)
      }
      actionMessage = choice == .archive ? "Lane archived." : "Lane and branch cleanup requested."
    } catch {
      errorMessage = error.localizedDescription
    }
    await reload(refreshRemote: true)
  }

  private func openGitHub(urlString: String) {
    guard let url = URL(string: urlString) else { return }
    UIApplication.shared.open(url)
  }

  private func openStack(groupId: String, groupName: String?) {
    stackPresentation = PrStackPresentation(id: groupId, groupName: groupName)
  }

  @MainActor
  private func openFileInFiles(_ file: PrFile) async {
    let laneId = currentPr.laneId
    guard !laneId.isEmpty else {
      errorMessage = "This PR is not linked to a lane, so Files cannot open \(file.filename)."
      return
    }

    do {
      let workspaceId: String
      if let filesWorkspaceId {
        workspaceId = filesWorkspaceId
      } else {
        let workspaces = try await syncService.listWorkspaces()
        guard let workspace = workspaces.first(where: { $0.laneId == laneId }) else {
          errorMessage = "No Files workspace is cached for this PR lane."
          return
        }
        filesWorkspaceId = workspace.id
        workspaceId = workspace.id
      }

      syncService.requestedFilesNavigation = FilesNavigationRequest(
        workspaceId: workspaceId,
        laneId: laneId,
        relativePath: file.filename
      )
      actionMessage = "Opening \(file.filename) in Files."
      errorMessage = nil
    } catch {
      filesWorkspaceId = nil
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  private func copyFilePath(_ file: PrFile) {
    UIPasteboard.general.string = file.filename
    actionMessage = "Copied \(file.filename)."
    errorMessage = nil
  }
}

// MARK: - PR surface backdrop
//
// Flat, theme-aware surface (desktop `--pr-surface` parity). The previous
// stacked radial-gradient + `.plusLighter` backdrop forced expensive
// re-compositing under every scroll frame and clashed with the app palette.

@ViewBuilder
func prLiquidGlassBackdrop() -> some View {
  PrGlassPalette.ink
}

private struct PrDetailActionsSheet: View {
  let canUpdateMetadata: Bool
  let canRunActions: Bool
  let shouldShowClose: Bool
  let shouldShowReopen: Bool
  let canClose: Bool
  let canReopen: Bool
  let canOpenGitHub: Bool
  let hasGitHubUrl: Bool
  let hasADELink: Bool
  let onDismiss: () -> Void
  let onEditTitle: () -> Void
  let onEditDescription: () -> Void
  let onSetLabels: () -> Void
  let onSubmitReview: () -> Void
  let onClose: () -> Void
  let onReopen: () -> Void
  let onOpenGitHub: () -> Void
  let onCopyUrl: () -> Void
  let onCopyAdeLink: () -> Void
  let onRefresh: () -> Void

  var body: some View {
    ZStack {
      prLiquidGlassBackdrop().ignoresSafeArea()

      VStack(spacing: 0) {
        Capsule(style: .continuous)
          .fill(ADEColor.textMuted.opacity(0.45))
          .frame(width: 36, height: 5)
          .padding(.top, 8)
          .padding(.bottom, 8)

        HStack {
          Button("Done", action: onDismiss)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(PrGlassPalette.purpleBright)
          Spacer(minLength: 0)
          Text("Pull request actions")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Spacer(minLength: 0)
          Button(action: onRefresh) {
            Image(systemName: "arrow.clockwise")
              .font(.system(size: 14, weight: .semibold))
          }
          .accessibilityLabel("Refresh pull request")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
          Rectangle()
            .fill(Color.white.opacity(0.06))
            .frame(height: 0.5)
        }

        ScrollView {
          VStack(spacing: 10) {
            PrDetailActionRow(title: "Edit title", symbol: "pencil", disabled: !canUpdateMetadata, action: onEditTitle)
            PrDetailActionRow(title: "Edit description", symbol: "text.alignleft", disabled: !canUpdateMetadata, action: onEditDescription)
            PrDetailActionRow(title: "Set labels", symbol: "tag", disabled: !canUpdateMetadata, action: onSetLabels)
            PrDetailActionRow(title: "Submit review", symbol: "checkmark.seal", disabled: !canRunActions, action: onSubmitReview)
            if shouldShowClose {
              PrDetailActionRow(
                title: "Close PR",
                symbol: "xmark.circle",
                tint: PrGlassPalette.danger,
                disabled: !canClose,
                isDestructive: true,
                action: onClose
              )
            }
            if shouldShowReopen {
              PrDetailActionRow(
                title: "Reopen PR",
                symbol: "arrow.counterclockwise",
                disabled: !canReopen,
                action: onReopen
              )
            }
            PrDetailActionRow(
              title: "Open in GitHub",
              symbol: "arrow.up.right.square",
              disabled: !canOpenGitHub,
              action: onOpenGitHub
            )
            PrDetailActionRow(
              title: "Copy URL",
              symbol: "doc.on.doc",
              disabled: !hasGitHubUrl,
              action: onCopyUrl
            )
            PrDetailActionRow(
              title: "Copy ADE link",
              symbol: "link",
              disabled: !hasADELink,
              action: onCopyAdeLink
            )
            PrDetailActionRow(title: "Refresh", symbol: "arrow.clockwise", action: onRefresh)
          }
          .padding(16)
        }
      }
    }
  }
}

private struct PrDetailActionRow: View {
  let title: String
  let symbol: String
  let tint: Color
  let disabled: Bool
  let isDestructive: Bool
  let action: () -> Void

  init(
    title: String,
    symbol: String,
    tint: Color = PrGlassPalette.textSecondary,
    disabled: Bool = false,
    isDestructive: Bool = false,
    action: @escaping () -> Void
  ) {
    self.title = title
    self.symbol = symbol
    self.tint = tint
    self.disabled = disabled
    self.isDestructive = isDestructive
    self.action = action
  }

  var body: some View {
    let button = Button(role: isDestructive ? .destructive : nil, action: action) {
      HStack(spacing: 12) {
        Image(systemName: symbol)
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(tint)
          .frame(width: 28, height: 28)
          .background(tint.opacity(0.13), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        Text(title)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(PrGlassPalette.textPrimary)
        Spacer(minLength: 0)
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(PrGlassPalette.textSecondary.opacity(0.7))
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
      .prGlassCard(cornerRadius: 14, shadow: false)
      .opacity(disabled ? 0.45 : 1)
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .accessibilityLabel(title)

    button
  }
}

private struct PrSingleLineEditSheet: View {
  @Environment(\.dismiss) private var dismiss
  let title: String
  let fieldTitle: String
  let submitTitle: String
  let onSubmit: (String) -> Void
  @State private var value: String

  init(
    title: String,
    fieldTitle: String,
    initialValue: String,
    submitTitle: String,
    onSubmit: @escaping (String) -> Void
  ) {
    self.title = title
    self.fieldTitle = fieldTitle
    self.submitTitle = submitTitle
    self.onSubmit = onSubmit
    _value = State(initialValue: initialValue)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section(fieldTitle) {
          TextField(fieldTitle, text: $value, axis: .vertical)
            .lineLimit(1...4)
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(submitTitle) {
            onSubmit(value.trimmingCharacters(in: .whitespacesAndNewlines))
          }
          .disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
  }
}

private struct PrMultilineEditSheet: View {
  @Environment(\.dismiss) private var dismiss
  let title: String
  let submitTitle: String
  let onSubmit: (String) -> Void
  @State private var value: String

  init(title: String, initialValue: String, submitTitle: String, onSubmit: @escaping (String) -> Void) {
    self.title = title
    self.submitTitle = submitTitle
    self.onSubmit = onSubmit
    _value = State(initialValue: initialValue)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section("Description") {
          TextEditor(text: $value)
            .frame(minHeight: 260)
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(submitTitle) {
            onSubmit(value)
          }
        }
      }
    }
  }
}

private struct PrSubmitReviewSheet: View {
  @Environment(\.dismiss) private var dismiss
  let onSubmit: (PrReviewEventOption, String?) -> Void
  @State private var event: PrReviewEventOption = .comment
  @State private var reviewBody = ""
  @FocusState private var bodyFocused: Bool

  private var accentColor: Color {
    switch event {
    case .approve: return PrGlassPalette.success
    case .requestChanges: return PrGlassPalette.danger
    case .comment: return PrGlassPalette.blue
    }
  }

  private var submitDisabled: Bool {
    event != .approve && reviewBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    PrDetailLiquidSheetShell(
      title: "Submit review",
      leadingLabel: "Cancel",
      onLeading: { dismiss() },
      trailingLabel: "Submit",
      trailingTint: accentColor,
      trailingDisabled: submitDisabled,
      onTrailing: {
        let trimmed = reviewBody.trimmingCharacters(in: .whitespacesAndNewlines)
        onSubmit(event, trimmed.isEmpty ? nil : trimmed)
      }
    ) {
      VStack(alignment: .leading, spacing: 16) {
        VStack(alignment: .leading, spacing: 8) {
          PrEyebrow(text: "Decision")
            .padding(.horizontal, 2)

          PrReviewDecisionPicker(selection: $event)
        }

        VStack(alignment: .leading, spacing: 8) {
          PrEyebrow(text: "Review")
            .padding(.horizontal, 2)

          ZStack(alignment: .topLeading) {
            if reviewBody.isEmpty {
              Text("Leave a note with your review…")
                .font(.system(size: 14))
                .foregroundStyle(ADEColor.textMuted)
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .allowsHitTesting(false)
            }
            TextEditor(text: $reviewBody)
              .scrollContentBackground(.hidden)
              .focused($bodyFocused)
              .font(.system(size: 14))
              .foregroundStyle(ADEColor.textPrimary)
              .padding(.horizontal, 10)
              .padding(.vertical, 6)
              .frame(minHeight: 160)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .prGlassCard(cornerRadius: 14, shadow: false)
          .onTapGesture { bodyFocused = true }
        }

        Text("Approvals can be submitted without a note, but comments and requests for changes need one.")
          .font(.system(size: 11))
          .foregroundStyle(ADEColor.textMuted)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 2)
      }
      .padding(16)
    }
  }
}

// MARK: - File-private liquid-glass sheet primitives (PR detail)

/// Shared sheet shell mirroring the one on PrsRootScreen: deep-ink backdrop,
/// 36x5 grab handle, title bar with leading (Cancel) and trailing (Submit).
private struct PrDetailLiquidSheetShell<Content: View>: View {
  let title: String
  let leadingLabel: String
  let onLeading: () -> Void
  let trailingLabel: String
  let trailingTint: Color
  let trailingDisabled: Bool
  let onTrailing: () -> Void
  @ViewBuilder let content: () -> Content

  var body: some View {
    ZStack {
      prLiquidGlassBackdrop().ignoresSafeArea()

      VStack(spacing: 0) {
        Capsule(style: .continuous)
          .fill(ADEColor.textMuted.opacity(0.45))
          .frame(width: 36, height: 5)
          .padding(.top, 8)
          .padding(.bottom, 8)

        HStack {
          Button(action: onLeading) {
            Text(leadingLabel)
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(PrGlassPalette.purpleBright)
          }
          Spacer(minLength: 0)
          Text(title)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Spacer(minLength: 0)
          Button(action: onTrailing) {
            Text(trailingLabel)
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(trailingTint)
              .opacity(trailingDisabled ? 0.35 : 1.0)
          }
          .disabled(trailingDisabled)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .overlay(alignment: .bottom) {
          Rectangle()
            .fill(Color.white.opacity(0.06))
            .frame(height: 0.5)
        }

        ScrollView {
          content()
        }
      }
    }
  }
}

/// 3-way tinted segmented picker for the review decision.
private struct PrReviewDecisionPicker: View {
  @Binding var selection: PrReviewEventOption

  var body: some View {
    HStack(spacing: 6) {
      ForEach(PrReviewEventOption.allCases) { option in
        PrReviewDecisionTab(
          option: option,
          isSelected: selection == option
        ) {
          withAnimation(.easeOut(duration: 0.15)) {
            selection = option
          }
        }
      }
    }
    .padding(4)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(.ultraThinMaterial)
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
    )
  }
}

private struct PrReviewDecisionTab: View {
  let option: PrReviewEventOption
  let isSelected: Bool
  let onTap: () -> Void

  private var tint: Color {
    switch option {
    case .approve: return PrGlassPalette.success
    case .requestChanges: return PrGlassPalette.danger
    case .comment: return PrGlassPalette.blue
    }
  }

  var body: some View {
    Button(action: onTap) {
      Text(option.title)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(isSelected ? Color.white : ADEColor.textSecondary)
        .frame(maxWidth: .infinity)
        .frame(height: 34)
        .background(
          ZStack {
            if isSelected {
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(
                  LinearGradient(
                    colors: [tint.opacity(0.85), tint.opacity(0.55)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                  )
                )
              RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(tint.opacity(0.65), lineWidth: 0.75)
            }
          }
        )
        .shadow(color: isSelected ? tint.opacity(0.45) : .clear, radius: 10, x: 0, y: 3)
    }
    .buttonStyle(.plain)
  }
}

/// Merge-strategy dialog (radio rows + Cancel + Merge).
/// GitHub-style merge box: requirement checklist, method picker, editable
/// commit title/body (squash & merge only), and an admin-bypass toggle gated
/// on `showsBypassToggle`. `onMerge` returns the chosen method, bypass flag,
/// and (when applicable) the edited commit title/body.
private struct PrMergeStrategySheet: View {
  @Binding var selected: PrMergeMethodOption
  let checklist: [PrMergeChecklistItem]
  /// True when ADE sees blockers but the merge can still be force-requested
  /// (drives the warning tone + "Merge anyway" copy).
  let canAttemptBlockedMerge: Bool
  /// Whether the admin-bypass toggle is offered (canBypass && blocked).
  let showsBypassToggle: Bool
  let prTitle: String
  let prNumber: Int
  let headBranch: String
  let repoOwner: String
  let commits: [PrCommit]
  let onMerge: (_ method: PrMergeMethodOption, _ bypass: Bool, _ commitTitle: String?, _ commitBody: String?) -> Void
  let onCancel: () -> Void

  @State private var bypassEnabled = false
  @State private var commitTitle = ""
  @State private var commitBody = ""
  /// User edited the message — stop auto-overwriting on method changes.
  @State private var commitMessageEdited = false
  /// Suppresses edit-tracking while we set the fields programmatically.
  @State private var applyingDefaults = false

  /// Commit title/body editor is shown for squash & merge, hidden for rebase.
  private var showsCommitEditor: Bool { selected != .rebase }

  private var primaryTint: Color {
    (canAttemptBlockedMerge || bypassEnabled) ? PrGlassPalette.warning : PrGlassPalette.purpleDeep
  }

  private var mergeButtonTitle: String {
    if bypassEnabled { return "Merge with bypass" }
    return canAttemptBlockedMerge ? "Merge anyway" : "Merge"
  }

  var body: some View {
    ZStack {
      Color.black.opacity(0.55)
        .ignoresSafeArea()
        .onTapGesture(perform: onCancel)

      VStack(spacing: 0) {
        // Grab handle.
        Capsule(style: .continuous)
          .fill(ADEColor.textMuted.opacity(0.45))
          .frame(width: 36, height: 5)
          .padding(.top, 10)
          .padding(.bottom, 4)

        ScrollView {
          VStack(alignment: .leading, spacing: 16) {
            header

            if !checklist.isEmpty {
              section(title: "Requirements") {
                PrMergeChecklistView(items: checklist)
              }
            }

            section(title: "Merge method") {
              VStack(spacing: 8) {
                ForEach(PrMergeMethodOption.allCases) { option in
                  PrGlassRadioRow(
                    title: option.title,
                    subtitle: option.description,
                    icon: iconFor(option),
                    isSelected: selected == option
                  ) {
                    guard selected != option else { return }
                    selected = option
                    // Re-derive the default message for the newly chosen method
                    // (GitHub regenerates it per method).
                    commitMessageEdited = false
                    syncCommitMessageForMethod()
                  }
                }
              }
            }

            if showsCommitEditor {
              section(title: "Commit message") {
                commitEditor
              }
            }

            if showsBypassToggle {
              bypassRow
            }
          }
          .padding(.horizontal, 18)
          .padding(.top, 10)
          .padding(.bottom, 16)
        }

        // Sticky action footer.
        HStack(spacing: 10) {
          Button(action: onCancel) {
            Text("Cancel")
          }
          .buttonStyle(PrDetailGlassOutlineButtonStyle())

          Button {
            onMerge(
              selected,
              bypassEnabled,
              showsCommitEditor ? commitTitle : nil,
              showsCommitEditor ? commitBody : nil
            )
          } label: {
            Label(mergeButtonTitle, systemImage: "arrow.triangle.merge")
          }
          .buttonStyle(PrDetailGlassPrimaryButtonStyle(tint: primaryTint))
        }
        .padding(.horizontal, 18)
        .padding(.top, 12)
        .padding(.bottom, 18)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      .background {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .fill(PrGlassPalette.ink)
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .fill(.ultraThinMaterial)
      }
      .overlay(
        RoundedRectangle(cornerRadius: 24, style: .continuous)
          .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
      )
      .overlay(alignment: .top) {
        LinearGradient(
          colors: [PrGlassPalette.purple.opacity(0.22), .clear],
          startPoint: .top,
          endPoint: .bottom
        )
        .frame(height: 80)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .allowsHitTesting(false)
      }
      .padding(.horizontal, 10)
      .padding(.vertical, 12)
    }
    .onAppear {
      // Seed the commit message from the current method's GitHub-style default.
      if !commitMessageEdited { syncCommitMessageForMethod() }
    }
  }

  private var header: some View {
    VStack(alignment: .leading, spacing: 4) {
      PrEyebrow(text: "Merge pull request", tint: PrGlassPalette.purple)
      Text(canAttemptBlockedMerge ? "Force-request merge" : "Confirm merge")
        .font(.system(size: 18, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .tracking(-0.2)
      Text(canAttemptBlockedMerge
        ? "ADE sees merge blockers, but this will still ask GitHub to merge. GitHub may reject unless your account can bypass requirements."
        : "Review the requirements below, then merge into the base branch.")
        .font(.system(size: 11.5))
        .foregroundStyle(ADEColor.textSecondary)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  private var commitEditor: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 5) {
        Text("Title")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
        TextField("Commit title", text: $commitTitle)
          .font(.system(size: 13, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
          .textInputAutocapitalization(.never)
          .autocorrectionDisabled(true)
          .padding(.horizontal, 12)
          .padding(.vertical, 10)
          .background(glassFieldBackground)
          .onChange(of: commitTitle) { _, _ in if !applyingDefaults { commitMessageEdited = true } }
      }

      VStack(alignment: .leading, spacing: 5) {
        Text("Description")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
        TextEditor(text: $commitBody)
          .font(.system(size: 12, design: .monospaced))
          .foregroundStyle(ADEColor.textPrimary)
          .scrollContentBackground(.hidden)
          .frame(minHeight: 96, maxHeight: 160)
          .padding(.horizontal, 8)
          .padding(.vertical, 6)
          .background(glassFieldBackground)
          .onChange(of: commitBody) { _, _ in if !applyingDefaults { commitMessageEdited = true } }
      }
    }
  }

  private var bypassRow: some View {
    Toggle(isOn: $bypassEnabled) {
      VStack(alignment: .leading, spacing: 2) {
        Text("Merge without waiting for requirements")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("Use your administrator bypass to merge despite branch protection rules.")
          .font(.system(size: 11))
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .tint(PrGlassPalette.warning)
    .padding(.horizontal, 12)
    .padding(.vertical, 12)
    .background(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .fill(PrGlassPalette.warning.opacity(0.10))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(PrGlassPalette.warning.opacity(0.34), lineWidth: 0.75)
    )
  }

  private var glassFieldBackground: some View {
    RoundedRectangle(cornerRadius: 12, style: .continuous)
      .fill(Color.white.opacity(0.06))
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
      )
  }

  private func section<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 10) {
      PrEyebrow(text: title, tint: ADEColor.textSecondary)
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// Recomputes the default commit message for the active method unless the user
  /// has already edited it. Mirrors GitHub re-deriving the message on method change.
  private func syncCommitMessageForMethod() {
    guard !commitMessageEdited else { return }
    let defaults = PrMergeChecklist.defaultCommitMessage(
      method: selected,
      prTitle: prTitle,
      prNumber: prNumber,
      headBranch: headBranch,
      repoOwner: repoOwner,
      commits: commits
    )
    // Set under the guard so the field `onChange` handlers don't mark these
    // programmatic writes as user edits.
    applyingDefaults = true
    commitTitle = defaults.title
    commitBody = defaults.body
    DispatchQueue.main.async { applyingDefaults = false }
  }

  private func iconFor(_ option: PrMergeMethodOption) -> String {
    switch option {
    case .squash: return "square.stack.3d.down.right.fill"
    case .merge: return "arrow.triangle.merge"
    case .rebase: return "arrow.triangle.2.circlepath"
    }
  }
}

/// Centered cleanup confirmation sheet.
private struct PrCleanupConfirmationSheet: View {
  let choice: PrCleanupChoice
  let onConfirm: () -> Void
  let onCancel: () -> Void

  private var isDestructive: Bool { choice == .deleteBranch }

  private var title: String {
    choice == .archive ? "Archive lane?" : "Delete lane and branch?"
  }

  private var message: String {
    choice == .archive
      ? "This keeps the lane for history but removes it from the active stack."
      : "This removes the lane from ADE and asks the machine to delete the branch as part of cleanup. This cannot be undone."
  }

  private var confirmTitle: String { choice == .archive ? "Archive" : "Delete" }

  var body: some View {
    ZStack {
      Color.black.opacity(0.55)
        .ignoresSafeArea()
        .onTapGesture(perform: onCancel)

      VStack(spacing: 14) {
        ZStack {
          Circle()
            .fill((isDestructive ? PrGlassPalette.danger : PrGlassPalette.warning).opacity(0.22))
          Image(systemName: isDestructive ? "trash.fill" : "archivebox.fill")
            .font(.system(size: 20, weight: .semibold))
            .foregroundStyle(isDestructive ? PrGlassPalette.danger : PrGlassPalette.warning)
        }
        .frame(width: 44, height: 44)

        Text(title)
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .tracking(-0.2)
          .multilineTextAlignment(.center)

        Text(message)
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .padding(.horizontal, 4)

        HStack(spacing: 10) {
          Button(action: onCancel) {
            Text("Cancel")
          }
          .buttonStyle(PrDetailGlassOutlineButtonStyle())

          Button(action: onConfirm) {
            Text(confirmTitle)
          }
          .buttonStyle(
            PrDetailGlassPrimaryButtonStyle(
              tint: isDestructive ? PrGlassPalette.danger : PrGlassPalette.purpleDeep
            )
          )
        }
        .padding(.top, 2)
      }
      .padding(20)
      .frame(maxWidth: .infinity)
      .background {
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(PrGlassPalette.ink)
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(.ultraThinMaterial)
      }
      .overlay(
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
      )
      .shadow(color: Color.black.opacity(0.55), radius: 28, x: 0, y: 10)
      .padding(.horizontal, 28)
    }
  }
}

/// Radio row used in the merge strategy dialog.
private struct PrGlassRadioRow: View {
  let title: String
  let subtitle: String
  let icon: String
  let isSelected: Bool
  let onTap: () -> Void

  var body: some View {
    Button(action: onTap) {
      HStack(alignment: .center, spacing: 12) {
        ZStack {
          if isSelected {
            Circle()
              .fill(PrGlassPalette.accentGradient)
          } else {
            Circle()
              .fill(Color.white.opacity(0.06))
          }
          Image(systemName: icon)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(isSelected ? Color.white : ADEColor.textSecondary)
        }
        .frame(width: 32, height: 32)

        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(subtitle)
            .font(.system(size: 11))
            .foregroundStyle(ADEColor.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
        }

        Spacer(minLength: 0)

        ZStack {
          Circle()
            .strokeBorder(
              isSelected ? PrGlassPalette.purpleBright : Color.white.opacity(0.22),
              lineWidth: isSelected ? 1.5 : 1
            )
            .frame(width: 18, height: 18)
          if isSelected {
            Circle()
              .fill(PrGlassPalette.purpleBright)
              .frame(width: 10, height: 10)
              .shadow(color: PrGlassPalette.purpleBright.opacity(0.7), radius: 6)
          }
        }
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .prGlassCard(
        cornerRadius: 12,
        tint: isSelected ? PrGlassPalette.purple.opacity(0.55) : nil,
        strokeOpacity: isSelected ? 0.22 : 0.10,
        shadow: false
      )
    }
    .buttonStyle(.plain)
  }
}

private struct PrDetailGlassPrimaryButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled
  let tint: Color

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(Color.white)
      .frame(maxWidth: .infinity)
      .frame(height: 44)
      .background(
        ZStack {
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(
              LinearGradient(
                colors: [tint.opacity(0.95), tint.opacity(0.70)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
              )
            )
          RoundedRectangle(cornerRadius: 12, style: .continuous)
            .stroke(
              LinearGradient(
                colors: [Color.white.opacity(0.45), Color.white.opacity(0.05)],
                startPoint: .top,
                endPoint: .bottom
              ),
              lineWidth: 1
            )
        }
      )
      .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1.0) : 0.45)
      .shadow(color: tint.opacity(isEnabled ? 0.45 : 0.0), radius: 14, x: 0, y: 5)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

private struct PrDetailGlassOutlineButtonStyle: ButtonStyle {
  @Environment(\.isEnabled) private var isEnabled

  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 14, weight: .semibold))
      .foregroundStyle(ADEColor.textPrimary)
      .frame(maxWidth: .infinity)
      .frame(height: 44)
      .background(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(.ultraThinMaterial)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
      )
      .opacity(isEnabled ? (configuration.isPressed ? 0.85 : 1.0) : 0.45)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}
