import SwiftUI
import UIKit

struct PrDetailView: View {
  @Environment(\.dismiss) private var dismiss
  @Environment(\.duoLayout) private var duoLayout
  @Environment(\.duoSplit) private var duoSplit
  @EnvironmentObject private var syncService: SyncService
  let prId: String
  let transitionNamespace: Namespace.ID?
  let requestedRepoOwner: String?
  let requestedRepoName: String?
  let availableLanes: [LaneSummary]
  /// The lane another machine holds for this PR, when the focused machine has
  /// no PR row for it. Its namespaced lane id sends every lane call there.
  let remoteLaneLink: PrRemoteLaneLink?
  let machineContext: PrMachineContext
  /// Called after a lane was made or linked on another machine, so the list
  /// reads that machine again and this screen gets its new link.
  let onRemoteLinksChanged: (@MainActor () async -> Void)?
  /// Shown inside another screen's surface (a chat's PR, in the Duo's tools
  /// pane) rather than pushed: the phone layout at the pane's width, with no
  /// toolbar of its own (the pane sits in the chat's navigation stack, whose
  /// toolbar is the chat's). Its title and ⋯ go to the pane's header row.
  var embedded = false
  /// Embedded only: the host's own control beside the ⋯ in the pane header
  /// (the chat's PR watch).
  var embeddedHeaderAccessory: AnyView?

  init(
    prId: String,
    transitionNamespace: Namespace.ID?,
    requestedRepoOwner: String? = nil,
    requestedRepoName: String? = nil,
    availableLanes: [LaneSummary] = [],
    initialTab: PrDetailTab = .overview,
    remoteLaneLink: PrRemoteLaneLink? = nil,
    machineContext: PrMachineContext = .single,
    onRemoteLinksChanged: (@MainActor () async -> Void)? = nil
  ) {
    self.prId = prId
    self.transitionNamespace = transitionNamespace
    self.requestedRepoOwner = requestedRepoOwner
    self.requestedRepoName = requestedRepoName
    self.availableLanes = availableLanes
    self.remoteLaneLink = remoteLaneLink
    self.machineContext = machineContext
    self.onRemoteLinksChanged = onRemoteLinksChanged
    _selectedTab = State(initialValue: initialTab)
  }

  @State private var pr: PullRequestListItem?
  @State private var githubItem: GitHubPrListItem?
  @State private var snapshot: PullRequestSnapshot?
  @State private var reviewThreads: [PrReviewThread] = []
  @State private var actionRuns: [PrActionRun] = []
  @State private var activityEvents: [PrActivityEvent] = []
  @State private var deployments: [PrDeployment] = []
  @State private var groupMembers: [PrGroupMemberSummary] = []
  @State private var capabilities: PrActionCapabilities?
  @State private var unavailableDetailParts: [String] = []
  @State private var selectedTab: PrDetailTab = .overview
  @State private var mergeMethod: PrMergeMethodOption = .squash
  @State private var reviewerInput = ""
  @State private var commentInput = ""
  @State private var errorMessage: String?
  @State private var cleanupChoice: PrCleanupChoice = .archive
  @State private var cleanupConfirmationPresented = false
  @State private var filesWorkspaceId: String?
  @State private var stackPresentation: PrStackPresentation?
  @State private var laneLinkItem: GitHubPrListItem?
  @State private var autoMapRequest: PrAutoMapRequest?
  @State private var editorSheet: PrDetailEditorSheet?
  /// Closing a PR from the actions sheet asks first, matching desktop. The
  /// inline merge rail has its own two-tap confirm; this covers the other entry
  /// point, which used to fire the moment the row was tapped.
  @State private var closeConfirmationPresented = false
  /// Raised while the actions sheet is still dismissing. Presenting the dialog
  /// in the same pass as the sheet teardown is the case SwiftUI drops on the
  /// floor, which would leave this path with no way to close a PR at all.
  @State private var hasLoadedLiveSidecars = false
  @State private var hasAttemptedInitialLoad = false
  @State private var hasSeededFromWarmCache = false
  /// Fallback list item synthesized from the GitHub item + snapshot when the
  /// PR has no lane-PR row. Cached so `currentPr` stops allocating per access.
  @State private var synthesizedPr: PullRequestListItem?
  /// The description with bot blocks and HTML comments removed.
  @State private var cleanedDescription = ""
  /// The Overview history (open threads, pushes, bot digests, people, events),
  /// rebuilt once per data change, never inside `body`.
  @State private var digest: PrConversationDigest = .empty
  @State private var threadsById: [String: PrReviewThread] = [:]
  @State private var toast: ADEToastMessage?
  /// Merged PRs on archived lanes are left out of the bounded snapshot
  /// hydration; the host sends their snapshot on request, once per visit.
  @State private var didRequestSnapshotOnDemand = false
  @State private var isRefreshingSnapshot = false
  @State private var mergeAnywayConfirmationPresented = false
  @State private var stackMergeConfirmationPresented = false
  /// Field diagnostics: this screen's open-to-ready timings.
  @State private var openTiming = ScreenOpenTiming()
  /// A `reload` is running (see `isAwaitingPrSnapshot`).
  @State private var detailLoadInFlight = false

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
  /// In-flight label of the main detail action, if any (durable across tab
  /// switches via the service registry).
  private var detailBusyLabel: String? {
    syncService.prActionLabel(forKey: detailActionKey)
  }
  private var isDetailBusy: Bool { detailBusyLabel != nil }

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var isLive: Bool {
    prsStatus.phase == .ready && syncService.connectionState == .connected
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

  private var closeConfirmationTitle: String {
    prCloseConfirmationTitle(prNumber: displayedPrNumber)
  }

  private var closeConfirmationMessage: String {
    prCloseConfirmationMessage(headBranch: currentPr.headBranch)
  }

  private var canReopenCurrentPr: Bool {
    canRunPrActions && shouldShowReopenAction
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

  /// The id every PR mutation is sent with, or nil when this screen cannot name
  /// a PR to act on at all.
  ///
  /// A PR that ADE holds no local row for still has one: the host resolves the
  /// synthetic `gh:owner/repo#number` form straight to the GitHub API. Merge,
  /// close, reopen, comment, labels, reviewers and re-run are all plain GitHub
  /// calls, so a local lane link is not a precondition for any of them.
  private var actionablePrId: String? {
    if let pr { return pr.id }
    if let linked = githubItem?.linkedPrId { return linked }
    if routedGitHubCoordinates != nil { return prId }
    if let githubItem,
      !githubItem.repoOwner.isEmpty,
      !githubItem.repoName.isEmpty,
      githubItem.githubPrNumber > 0
    {
      return prSyntheticGitHubId(for: githubItem)
    }
    return nil
  }

  private var effectivePrId: String {
    actionablePrId ?? prId
  }

  private var hasActionablePrId: Bool {
    actionablePrId != nil
  }

  /// A load that can still bring this PR's snapshot is running: the first
  /// read, an on-demand host read, or any reload.
  private var isAwaitingPrSnapshot: Bool {
    snapshot == nil && (!hasAttemptedInitialLoad || isRefreshingSnapshot || detailLoadInFlight)
  }

  /// The merge state comes from the snapshot only. Without one, the list
  /// row's data would read as "Ready to merge", so the bar says it is still
  /// checking, or that the state is unavailable once the loads settle.
  private var mergeStatusPresence: PrMergeStatusPresence {
    if snapshot != nil { return .known }
    return isAwaitingPrSnapshot ? .checking : .unavailable
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

  private var currentPr: PullRequestListItem {
    if let pr { return pr }
    // Cold path: the placeholder is only built before the first
    // `recomputeDerivedModels()` runs.
    var fallback = synthesizedPr ?? Self.synthesizePlaceholderPr(
      prId: prId,
      routedPrNumber: routedPrNumber,
      requestedRepoOwner: requestedRepoScope?.repoOwner,
      requestedRepoName: requestedRepoScope?.repoName,
      githubItem: githubItem,
      snapshot: snapshot
    )
    // No PR row here, but another machine holds this PR's lane: lane calls
    // made with its namespaced id go to that machine.
    if let remoteLaneLink, fallback.laneId.isEmpty {
      fallback.laneId = remoteLaneLink.laneId
      fallback.laneName = remoteLaneLink.laneName
    }
    return fallback
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
      cleanupState: githubItem?.cleanupState,
      stack: githubItem?.stack,
      checksReason: status?.checksReason,
      checksMissingRequired: status?.checksMissingRequired
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
    let cleaned = prCleanBody(snapshot?.detail?.body)
    cleanedDescription = cleaned.body
    let inputs = prDigestInputs(
      pr: currentPr,
      snapshot: snapshot,
      reviewThreads: reviewThreads,
      activity: activityEvents,
      bodySections: cleaned.sections
    )
    digest = buildPrConversationDigest(commits: inputs.commits, entries: inputs.entries, story: inputs.story)
    threadsById = Dictionary(reviewThreads.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
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

  private var isCurrentPrDraft: Bool {
    currentPr.state == "draft" || snapshot?.status?.state == "draft" || snapshot?.detail?.isDraft == true
  }

  private var nativeStackMembership: GitHubPrStackMembership? {
    currentPr.stack ?? githubItem?.stack
  }

  /// How many open PRs a merge of this stacked PR covers. An older host does
  /// not send the count; the position is then the upper bound.
  private var stackMergeCount: Int {
    guard let stack = nativeStackMembership else { return 1 }
    if let count = stack.openThroughHere, count > 0 { return count }
    return stack.position
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


  private var visibleTabs: [PrDetailTab] {
    [.overview, .files, .checks]
  }

  private func tabLabel(_ tab: PrDetailTab) -> String {
    switch tab {
    case .files:
      let count = snapshot?.files.count ?? 0
      return count > 0 ? "Files \(count)" : "Files"
    case .checks:
      let count = snapshot?.checks.count ?? 0
      return count > 0 ? "Checks \(count)" : "Checks"
    default:
      return "Overview"
    }
  }

  private var displayedState: String {
    isCurrentPrDraft ? "draft" : (snapshot?.status?.state ?? currentPr.state)
  }

  private var laneName: String? {
    guard !currentPr.laneId.isEmpty else { return nil }
    return currentPr.laneName ?? availableLanes.first(where: { $0.id == currentPr.laneId })?.name ?? currentPr.headBranch
  }

  private var stackLabel: String? {
    if let stack = nativeStackMembership { return "Stack \(stack.position) of \(stack.size)" }
    if currentPr.linkedGroupId != nil, !groupMembers.isEmpty { return "Stack of \(groupMembers.count)" }
    return nil
  }

  var body: some View {
    let _ = ScrollDiagnostics.shared.count(.prDetailBody)
    Group {
      // The Duo's inner display: desktop's structure, the thread with its
      // push rail and the dock as the column's toolbar. Every other size
      // keeps the phone screen.
      if embedded {
        embeddedDetail
      } else if duoLayout.isWide {
        duoDetail
      } else {
        phoneDetail
      }
    }
    .onAppear { openTiming.opened() }
    .onChange(of: snapshot != nil) { _, loaded in
      if loaded { openTiming.mark("prDetail.snapshot") }
    }
    .onChange(of: hasLoadedLiveSidecars) { _, loaded in
      if loaded { openTiming.mark("prDetail.ready") }
    }
    .adeAnalyticsScreen(.pullRequestDetail)
    .adeToast($toast)
    // `isLive` is in the key so a reconnect reads the detail again.
    .task(id: "\(syncService.prsProjectionRevision):\(syncService.prsRemoteRevision):\(isLive)") {
      // Seed from the warm cache first so the first frame has content and, when
      // the entry is fresh, the sidecar fan-out below is skipped.
      seedFromWarmCacheIfNeeded()
      // Webhooks bump the projection revision; once the freshness window lapses
      // that bump refreshes threads, activity and checks as well.
      let needLiveSidecars = shouldFetchPrDetailLiveSidecars(
        hasLoadedLiveSidecars: hasLoadedLiveSidecars,
        refreshRemote: false
      ) || !syncService.prDetailWarmEntryIsFresh(for: prId, within: Self.detailFreshnessWindow)
      await reload(includeLiveSidecars: needLiveSidecars)
    }
    .modifier(PrDetailPresentations(view: self))
  }

  /// The phone screen: header, the tab picker and the tab as one list, with
  /// the next-step bar at the bottom.
  private var phoneDetail: some View {
    detailList
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(.visible, for: .navigationBar)
      .toolbar {
        if !isAwaitingInitialPrDetail && !isPrDetailUnavailable {
          ToolbarItem(placement: .principal) {
            PrFlatDetailNavTitle(
              number: displayedPrNumber ?? currentPr.githubPrNumber,
              author: snapshot?.detail?.author.login ?? githubItem?.author,
              authorIsBot: snapshot?.detail?.author.isBot ?? githubItem?.isBot,
              state: displayedState
            )
          }
          .sharedBackgroundVisibility(.hidden)
        }
        ToolbarItem(placement: .topBarTrailing) {
          moreMenu
        }
      }
  }

  /// The phone screen inside a pane: the same list, its title and ⋯ handed
  /// to the pane's header instead of a toolbar.
  private var embeddedDetail: some View {
    detailList
      .duoPaneHeader(status: embeddedStatus) {
        if let embeddedHeaderAccessory { embeddedHeaderAccessory }
        Menu {
          moreMenuItems
        } label: {
          Image(systemName: "ellipsis")
            .font(.system(size: 16, weight: .medium))
            .frame(width: 22, height: 22)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel("Pull request actions")
      }
  }

  /// "#1304 · Open · arul28", the pane header's line under its title.
  private var embeddedStatus: String? {
    guard !isAwaitingInitialPrDetail, !isPrDetailUnavailable else { return nil }
    var parts: [String] = []
    if let number = displayedPrNumber ?? (currentPr.githubPrNumber > 0 ? currentPr.githubPrNumber : nil) {
      parts.append("#\(number)")
    }
    parts.append(lanePrStateLabel(displayedState))
    if let author = snapshot?.detail?.author.login ?? githubItem?.author, !author.isEmpty {
      parts.append(author)
    }
    return parts.joined(separator: " · ")
  }

  private var detailList: some View {
    List {
      if isAwaitingInitialPrDetail {
        Section {
          PrFlatDetailHeaderSkeleton()
            .adeFlatRow(separator: .hidden)
        }
      } else if isPrDetailUnavailable {
        Section {
          ADEFlatInlineNotice(
            message: isLive
              ? "ADE could not find \(unavailablePrLabel). Refresh the PR list and try again."
              : "Reconnect to your computer to load \(unavailablePrLabel).",
            retry: { Task { await retryPrDetailLoad() } }
          )
          .adeFlatRow(separator: .hidden)
        }
      } else {
        Section {
          detailHeader
            .adeFlatRow(insets: EdgeInsets(top: 0, leading: 16, bottom: 10, trailing: 16), separator: .hidden)
          if let errorMessage, !syncService.connectionState.isHostUnreachable {
            ADEFlatInlineNotice(message: errorMessage, tint: ADEColor.danger, retry: { Task { await retryPrDetailLoad() } })
              .adeFlatRow(separator: .hidden)
          }
          if !unavailableDetailParts.isEmpty {
            ADEFlatInlineNotice(
              message: "Could not refresh \(unavailableDetailParts.map { $0.replacingOccurrences(of: "_", with: " ") }.joined(separator: ", ")). This is partial, not empty.",
              retry: { Task { await retryPrDetailLoad() } }
            )
            .adeFlatRow(separator: .hidden)
          }
          Picker("Section", selection: $selectedTab) {
            ForEach(visibleTabs) { tab in
              Text(tabLabel(tab)).tag(tab)
            }
          }
          .pickerStyle(.segmented)
          .adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16), separator: .hidden)
        }

        switch selectedTab {
        case .overview, .activity:
          PrOverviewSections(
            description: cleanedDescription,
            digest: digest,
            threadsById: threadsById,
            canAct: canRunPrActions,
            onReply: { threadId, body in replyToThread(threadId: threadId, body: body) },
            onResolve: { threadId, resolved in setThreadResolved(threadId: threadId, resolved: resolved) },
            isLoading: isAwaitingPrSnapshot
          )
        case .files:
          PrFilesSections(
            files: snapshot?.files ?? [],
            isLoading: isRefreshingSnapshot || (!hasLoadedLiveSidecars && isLive),
            // Files reads the focused machine only, so a lane of another
            // machine cannot open there yet.
            canOpenFiles: !currentPr.laneId.isEmpty && !isWorkRemoteLaneId(currentPr.laneId),
            onOpenFile: { file in Task { await openFileInFiles(file) } },
            onCopyPath: copyFilePath
          )
        case .checks:
          PrChecksSections(
            checks: snapshot?.checks ?? [],
            overallChecksStatus: snapshot?.status?.checksStatus ?? currentPr.checksStatus,
            checksReason: snapshot?.status?.checksReason ?? currentPr.checksReason,
            missingRequired: snapshot?.status?.checksMissingRequired ?? currentPr.checksMissingRequired ?? [],
            actionRuns: actionRuns,
            deployments: deployments,
            canRerun: canRerunChecks && canRunPrActions,
            onRerun: rerunChecks
          )
        }
      }
    }
    .adeFlatList()
    .listSectionSpacing(.compact)
    .contentMargins(.bottom, 16, for: .scrollContent)
    // Rows scrolled under the clock and the floating back/actions buttons
    // with nothing between them.
    .scrollEdgeEffectStyle(.hard, for: .top)
    .adeScrollDiagnosticsSurface(.prDetail, key: "pr-detail")
    .safeAreaInset(edge: .bottom) {
      if hasPrDetailData {
        nextStepBar
      }
    }
    .refreshable {
      await reload(refreshRemote: true)
    }
  }

  /// The sheets and confirmations both layouts present. A modifier so the
  /// body's type stays small enough to type-check quickly.
  fileprivate struct PrDetailPresentations: ViewModifier {
    let view: PrDetailView

    func body(content: Content) -> some View {
      view.presentations(content)
    }
  }

  fileprivate func presentations<Content: View>(_ content: Content) -> some View {
    content
    .sheet(item: $stackPresentation) { presentation in
      PrStackSheet(groupId: presentation.id, groupName: presentation.groupName)
        .environmentObject(syncService)
    }
    .sheet(item: $autoMapRequest) { request in
      PrAutoMapSheet(
        item: request.item,
        machines: machineContext.createMachines,
        canCreate: canAutoMapCurrentPr,
        onCreate: { machine in autoMapCurrentPr(on: machine) },
        onCancel: { autoMapRequest = nil }
      )
      .environmentObject(syncService)
    }
    .sheet(item: $laneLinkItem) { item in
      PrLaneLinkSheet(
        item: item,
        lanes: availableLanes,
        canLink: canMapCurrentPr,
        machineContext: machineContext
      ) { laneId in
        runPrAction(
          "Linking pull request",
          success: "Lane linked",
          action: {
            // A namespaced lane id makes the link on the lane's machine.
            try await syncService.linkPullRequestToLane(
              laneId: laneId,
              prUrlOrNumber: item.githubUrl.isEmpty ? "\(item.githubPrNumber)" : item.githubUrl
            )
          },
          onSuccess: {
            laneLinkItem = nil
            guard isWorkRemoteLaneId(laneId), let onRemoteLinksChanged else { return }
            Task { await onRemoteLinksChanged() }
          }
        )
      } onOpenGitHub: {
        openGitHub(urlString: item.githubUrl)
      }
      .presentationDetents([.large])
      .presentationDragIndicator(.hidden)
      .presentationBackground(.clear)
    }
    .confirmationDialog(closeConfirmationTitle, isPresented: $closeConfirmationPresented, titleVisibility: .visible) {
      Button("Close pull request", role: .destructive) { closeCurrentPr() }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(closeConfirmationMessage)
    }
    .confirmationDialog(
      cleanupChoice == .archive ? "Archive this lane?" : "Delete the lane and its branch?",
      isPresented: $cleanupConfirmationPresented,
      titleVisibility: .visible
    ) {
      Button(cleanupChoice == .archive ? "Archive lane" : "Delete lane and branch", role: .destructive) {
        Task { await performCleanup() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(cleanupChoice == .archive
        ? "The lane leaves the Lanes list. Its chats stay in history."
        : "Deletes the lane's worktree, its local branch and \(currentPr.headBranch.isEmpty ? "the remote branch" : currentPr.headBranch) on GitHub.")
    }
    .confirmationDialog(
      stackMergeCount > 1 ? "Merge \(stackMergeCount) stacked PRs?" : "Merge this stacked PR?",
      isPresented: $stackMergeConfirmationPresented,
      titleVisibility: .visible
    ) {
      ForEach(PrMergeMethodOption.allCases) { method in
        Button(method.title) {
          mergeMethod = method
          mergeCurrentPr()
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(stackMergeCount > 1
        ? "GitHub merges the \(stackMergeCount) open PRs up to #\(currentPr.githubPrNumber) together, or none of them. It checks the branch rules during the merge."
        : "This is the bottom open PR of the stack. GitHub checks the branch rules during the merge.")
    }
    .confirmationDialog("Merge anyway?", isPresented: $mergeAnywayConfirmationPresented, titleVisibility: .visible) {
      ForEach(PrMergeMethodOption.allCases) { method in
        Button(nextStep.mergeAnyway.bypass ? "\(method.title), bypassing rules" : method.title, role: .destructive) {
          mergeMethod = method
          mergeCurrentPr(bypassRules: nextStep.mergeAnyway.bypass)
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      let skips = nextStep.mergeAnyway.skips
      let skipText = skips.isEmpty ? "GitHub merges this PR now." : "Merging now skips: \(skips.joined(separator: ", "))."
      Text(nativeStackMembership != nil && stackMergeCount > 1 && nextStep.mergeAnyway.bypass
        ? "\(skipText) GitHub bypasses rules only for the bottom PR, so ADE merges the \(stackMergeCount) PRs one at a time from the bottom."
        : skipText)
    }
    .sheet(item: $editorSheet) { sheet in
      editorSheetView(sheet)
    }
  }

  @ViewBuilder
  private func editorSheetView(_ sheet: PrDetailEditorSheet) -> some View {
    switch sheet {
    case .title(let title):
      PrSingleLineEditSheet(title: "Edit title", fieldTitle: "Title", initialValue: title, submitTitle: "Save") { value in
        runPrAction("Updating PR title", success: "Title updated") {
          try await syncService.updatePullRequestTitle(prId: effectivePrId, title: value)
        } onSuccess: { editorSheet = nil }
      }
      .presentationDetents([.medium])
    case .body(let body):
      PrMultilineEditSheet(title: "Edit description", sectionTitle: "Description", initialValue: body, submitTitle: "Save") { value in
        runPrAction("Updating PR description", success: "Description updated") {
          try await syncService.updatePullRequestBody(prId: effectivePrId, body: value)
        } onSuccess: { editorSheet = nil }
      }
    case .labels(let labels):
      PrSingleLineEditSheet(title: "Labels", fieldTitle: "Comma-separated labels", initialValue: labels, submitTitle: "Save") { value in
        let labels = value.split(separator: ",").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        runPrAction("Updating labels", success: "Labels updated") {
          try await syncService.setPullRequestLabels(prId: effectivePrId, labels: labels)
        } onSuccess: { editorSheet = nil }
      }
      .presentationDetents([.medium])
    case .reviewers:
      PrSingleLineEditSheet(title: "Request review", fieldTitle: "GitHub logins, comma-separated", initialValue: "", submitTitle: "Request") { value in
        reviewerInput = value
        requestReviewers()
        editorSheet = nil
      }
      .presentationDetents([.medium])
    case .comment:
      PrMultilineEditSheet(title: "Comment", sectionTitle: "Comment on the PR", initialValue: "", submitTitle: "Post") { value in
        commentInput = value
        submitComment()
        editorSheet = nil
      }
      .presentationDetents([.medium, .large])
    case .review:
      PrSubmitReviewSheet { event, body in
        runPrAction("Submitting review", success: "Review submitted") {
          try await syncService.submitPullRequestReview(prId: effectivePrId, event: event.rawValue, body: body)
        } onSuccess: { editorSheet = nil }
      }
      .presentationDetents([.medium, .large])
    }
  }

  private var detailHeader: some View {
    PrFlatDetailHeader(
      createdAt: githubItem?.createdAt ?? currentPr.createdAt,
      updatedAt: githubItem?.updatedAt ?? currentPr.updatedAt,
      title: currentPr.title,
      baseBranch: currentPr.baseBranch,
      headBranch: currentPr.headBranch,
      laneName: laneName,
      ghostLaneName: (githubItem?.detached ?? pr?.detached)?.laneName,
      machineName: machineContext.machineName(forLaneId: currentPr.laneId),
      stackLabel: stackLabel,
      onOpenLane: currentPr.laneId.isEmpty ? nil : openCurrentLane,
      onOpenStack: currentPr.linkedGroupId.map { groupId in { openStack(groupId: groupId, groupName: currentPr.linkedGroupName) } }
        ?? (nativeStackMembership != nil ? { openGitHub(urlString: currentPr.githubUrl) } : nil),
      canCreateLane: canAutoMapCurrentPr && githubItem != nil,
      canLinkLane: canMapCurrentPr,
      onCreateLane: presentCreateLane,
      onLinkLane: { if let githubItem { laneLinkItem = githubItem } }
    )
  }

  /// Creating a lane names its machine first when there is more than one.
  private func presentCreateLane() {
    if machineContext.createMachines.count > 1, let githubItem {
      autoMapRequest = PrAutoMapRequest(item: githubItem)
    } else {
      autoMapCurrentPr(on: machineContext.createMachines.first)
    }
  }

  // MARK: - ⋯ menu

  private var moreMenu: some View {
    Menu {
      moreMenuItems
    } label: {
      Image(systemName: "ellipsis")
        .accessibilityLabel("Pull request actions")
    }
  }

  @ViewBuilder
  private var moreMenuItems: some View {
    let state = displayedState
    let isOpen = state == "open" || state == "draft"
    let step = nextStep
    let canDraft = canRunPrActions && syncService.supportsRemoteAction("prs.setDraft")
    let canAutoMerge = canRunPrActions && syncService.supportsRemoteAction("prs.setAutoMerge")
      if isOpen {
        Section {
          Button { editorSheet = .comment } label: { Label("Comment", systemImage: "text.bubble") }
            .disabled(!canRunPrActions || !canAddComment)
          Button { editorSheet = .review } label: { Label("Review…", systemImage: "checkmark.bubble") }
            .disabled(!canRunPrActions)
          Button { editorSheet = .reviewers } label: { Label("Request review…", systemImage: "person.badge.plus") }
            .disabled(!canRunPrActions)
        }
        Section {
          if state == "draft" {
            Button { runNextStep(.readyForReview) } label: { Label("Ready for review", systemImage: "checkmark.circle") }
              .disabled(!canDraft)
          } else {
            Button {
              runPrAction("Converting to draft", success: "Converted to draft") { try await syncService.setPullRequestDraft(prId: effectivePrId, draft: true) }
            } label: { Label("Convert to draft", systemImage: "doc.badge.ellipsis") }
              .disabled(!canDraft)
            if snapshot?.status?.autoMergeEnabled == true {
              Button { runNextStep(.disableAutoMerge) } label: { Label("Turn off auto-merge", systemImage: "arrow.triangle.merge") }
                .disabled(!canAutoMerge)
            } else if snapshot?.status?.autoMergeAllowed != false {
              Button { runNextStep(.enableAutoMerge) } label: { Label("Enable auto-merge", systemImage: "arrow.triangle.merge") }
                .disabled(!canAutoMerge)
            }
          }
          // GitHub bypasses rules for a stack only from its bottom open PR; above
          // it a current host merges the covered PRs one at a time, each bypassing.
          if step.mergeAnyway.visible && !step.mergeAnyway.blocked
            && (nativeStackMembership == nil || stackMergeCount == 1 || syncService.supportsStackLayeredBypass) {
            Button(role: step.mergeAnyway.bypass ? .destructive : nil) {
              mergeAnywayConfirmationPresented = true
            } label: {
              Label(step.mergeAnyway.bypass ? "Bypass rules and merge…" : "Merge anyway…", systemImage: "arrow.triangle.merge")
            }
            .disabled(!canRunPrActions)
          }
          if canRerunChecks {
            Button { rerunChecks() } label: { Label("Re-run checks", systemImage: "arrow.clockwise") }
              .disabled(!canRunPrActions)
          }
          if !currentPr.laneId.isEmpty {
            Button { triggerRebase() } label: { Label("Rebase lane", systemImage: "arrow.triangle.2.circlepath") }
              .disabled(!canRunPrActions)
          }
        }
      }
      Section {
        if currentPr.laneId.isEmpty {
          if canAutoMapCurrentPr && githubItem != nil {
            Button(action: presentCreateLane) { Label("Create lane from branch", systemImage: "plus.square.on.square") }
          }
          if canMapCurrentPr {
            Button { if let githubItem { laneLinkItem = githubItem } } label: { Label("Link a lane…", systemImage: "link") }
          }
        } else {
          Button(action: openCurrentLane) { Label("Open lane", systemImage: "arrow.triangle.branch") }
          if !isOpen {
            Button {
              cleanupChoice = .archive
              cleanupConfirmationPresented = true
            } label: { Label("Archive lane…", systemImage: "archivebox") }
            .disabled(!canRunPrActions)
          }
        }
      }
      Section {
        Button { editorSheet = .title(currentPr.title) } label: { Label("Edit title", systemImage: "pencil") }
          .disabled(!canUpdateCurrentPrMetadata)
        Button { editorSheet = .body(snapshot?.detail?.body ?? "") } label: { Label("Edit description", systemImage: "text.alignleft") }
          .disabled(!canUpdateCurrentPrMetadata)
        Button {
          editorSheet = .labels(snapshot?.detail?.labels.map(\.name).joined(separator: ", ") ?? "")
        } label: { Label("Labels…", systemImage: "tag") }
          .disabled(!canUpdateCurrentPrMetadata)
      }
      Section {
        Button { openGitHub(urlString: currentPr.githubUrl) } label: { Label("Open in GitHub", systemImage: "arrow.up.right.square") }
          .disabled(!canOpenCurrentPrInGitHub)
        Button { copy(currentPr.githubUrl, "Link copied") } label: { Label("Copy link", systemImage: "link") }
          .disabled(currentPr.githubUrl.isEmpty)
        Menu {
          Button { copy("#\(currentPr.githubPrNumber)", "PR number copied") } label: { Label("PR number", systemImage: "number") }
          Button { copy(currentPr.headBranch, "Branch copied") } label: { Label("Branch name", systemImage: "arrow.triangle.branch") }
            .disabled(currentPr.headBranch.isEmpty)
          Button {
            copy("gh pr checkout \(currentPr.githubPrNumber) --repo \(currentPr.repoOwner)/\(currentPr.repoName)", "Checkout command copied")
          } label: { Label("Checkout command", systemImage: "terminal") }
          Button {
            copy(LaneDeeplinkHelpers.prLink(repoOwner: currentPr.repoOwner, repoName: currentPr.repoName, number: currentPr.githubPrNumber), "ADE link copied")
          } label: { Label("ADE link", systemImage: "link.badge.plus") }
            .disabled(currentPr.repoOwner.isEmpty || currentPr.repoName.isEmpty)
        } label: {
          Label("Copy…", systemImage: "doc.on.doc")
        }
        Button { Task { await reload(refreshRemote: true) } } label: { Label("Refresh", systemImage: "arrow.clockwise") }
      }
      if shouldShowCloseAction || shouldShowReopenAction {
        Section {
          if shouldShowCloseAction {
            Button(role: .destructive) { closeConfirmationPresented = true } label: { Label("Close pull request…", systemImage: "xmark.circle") }
              .disabled(!canCloseCurrentPr)
          } else if shouldShowReopenAction {
            Button { reopenCurrentPr() } label: { Label("Reopen", systemImage: "arrow.uturn.backward.circle") }
              .disabled(!canReopenCurrentPr)
          }
        }
      }
  }

  private func copy(_ value: String, _ message: String) {
    UIPasteboard.general.string = value
    ADEHaptics.success()
    toast = ADEToastMessage(text: message)
  }

  // MARK: - Next-step bar

  private var nextStepBar: some View {
    let step = nextStep
    return PrNextStepFlatBar(
      step: step,
      isBusy: isDetailBusy,
      busyLabel: detailBusyLabel,
      onTapText: {
        switch step.kind {
        case .checksFailing, .checksPending: selectedTab = .checks
        default: selectedTab = .overview
        }
      },
      // A merged or closed PR's state is in the list row already; an open
      // one's merge gate is only known once its snapshot arrives.
      mergeStatus: step.kind == .merged || step.kind == .closed ? .known : mergeStatusPresence
    ) {
      nextStepPrimary(step)
    }
  }

  @ViewBuilder
  private func nextStepPrimary(_ step: PrNextStep) -> some View {
    if nativeStackMembership != nil, step.kind != .merged, step.kind != .closed {
      if isCurrentPrDraft {
        Button("Stack on GitHub") { openGitHub(urlString: currentPr.githubUrl) }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.accent)
          .disabled(currentPr.githubUrl.isEmpty)
      } else {
        // GitHub merges a stack as one unit, so the method choice and the
        // confirm live in one dialog that names how many PRs merge.
        Button {
          ADEHaptics.light()
          stackMergeConfirmationPresented = true
        } label: {
          Text(stackMergeCount > 1 ? "Merge \(stackMergeCount) PRs" : "Merge").font(.subheadline.weight(.semibold))
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.success)
        .disabled(isDetailBusy)
      }
    } else if let primary = step.primary, nextStepAvailable(primary) {
      if primary == .merge {
        // A merge always names its method: one tap opens the choice, a second
        // commits to it.
        Menu {
          ForEach(PrMergeMethodOption.allCases) { method in
            Button(method.title) {
              mergeMethod = method
              ADEHaptics.success()
              mergeCurrentPr()
            }
          }
        } label: {
          Text("Merge").font(.subheadline.weight(.semibold))
        }
        .menuStyle(.button)
        .buttonStyle(.glassProminent)
        .tint(ADEColor.success)
        .disabled(isDetailBusy)
      } else {
        Button {
          ADEHaptics.light()
          runNextStep(primary)
        } label: {
          Text(nextStepLabel(primary)).font(.subheadline.weight(.semibold)).lineLimit(1)
        }
        .buttonStyle(.glassProminent)
        .tint(primary == .deleteBranch ? ADEColor.danger : ADEColor.accent)
        .disabled(isDetailBusy)
      }
    }
  }
  // MARK: - Sticky action bar

  // MARK: - Next step (desktop Merge card parity)

  /// Counted the way the Checks tab sorts them (`prCheckConclusionKind`), so
  /// the bar and the tab never disagree on what failed.
  private var checkCounts: (failing: Int, pending: Int, passing: Int) {
    let kinds = (snapshot?.checks ?? []).map(prCheckConclusionKind)
    return (
      kinds.filter { $0 == .failure }.count,
      kinds.filter { $0 == .pending }.count,
      kinds.filter { $0 == .success }.count
    )
  }

  private var nextStep: PrNextStep {
    let status = snapshot?.status
    let counts = checkCounts
    return PrNextStep.resolve(PrNextStepInput(
      state: isCurrentPrDraft ? "draft" : (status?.state ?? currentPr.state),
      mergeStateStatus: status?.mergeStateStatus,
      mergeConflicts: status?.mergeConflicts ?? false,
      behindBaseBy: status?.behindBaseBy,
      mergeabilityComputing: status?.mergeabilityComputing ?? false,
      checksStatus: status?.checksStatus ?? currentPr.checksStatus,
      failingChecks: counts.failing,
      pendingChecks: counts.pending,
      passingChecks: counts.passing,
      reviewDecision: status?.reviewDecision,
      approvalsCount: status?.approvalsCount,
      requiredApprovals: status?.requiredApprovals,
      changesRequestedBy: prChangesRequestedBy(snapshot?.reviews ?? []),
      unresolvedThreads: unresolvedThreadCount,
      canBypass: status?.canBypass ?? false,
      autoMergeAllowed: status?.autoMergeAllowed,
      autoMergeEnabled: status?.autoMergeEnabled ?? false,
      autoMergeMethod: status?.autoMergeMethod,
      baseBranch: currentPr.baseBranch
    ))
  }

  private func nextStepLabel(_ action: PrNextStepAction) -> String {
    switch action {
    case .deleteBranch: return "Delete branch"
    case .reopen: return "Reopen"
    case .readyForReview: return "Ready for review"
    case .resolveConflicts: return currentPr.laneId.isEmpty ? "Resolve on GitHub" : "Rebase lane"
    case .updateBranch: return "Update branch"
    case .fixChecks: return "Open checks"
    case .rerunChecks: return "Re-run checks"
    case .addressFeedback: return "Show feedback"
    case .enableAutoMerge: return "Enable auto-merge"
    case .disableAutoMerge: return "Turn off auto-merge"
    case .requestReview: return "Request review"
    case .fixThreads: return "Show open threads"
    case .merge: return "Merge…"
    }
  }

  private func nextStepAvailable(_ action: PrNextStepAction) -> Bool {
    switch action {
    case .readyForReview: return canRunPrActions && syncService.supportsRemoteAction("prs.setDraft")
    case .enableAutoMerge, .disableAutoMerge: return canRunPrActions && syncService.supportsRemoteAction("prs.setAutoMerge")
    case .updateBranch: return canRunPrActions && !currentPr.laneId.isEmpty
    case .rerunChecks: return canRerunChecks
    case .merge: return canRunPrActions && (capabilities?.canMerge ?? actionAvailability.mergeEnabled)
    case .reopen: return canRunPrActions && shouldShowReopenAction
    case .deleteBranch: return !currentPr.laneId.isEmpty
    default: return true
    }
  }

  private func runNextStep(_ action: PrNextStepAction) {
    switch action {
    case .merge:
      mergeCurrentPr()
    case .deleteBranch:
      cleanupChoice = .deleteBranch
      cleanupConfirmationPresented = true
    case .reopen: reopenCurrentPr()
    case .readyForReview:
      runPrAction("Marking ready for review", success: "Ready for review") { try await syncService.setPullRequestDraft(prId: effectivePrId, draft: false) }
    case .enableAutoMerge:
      runPrAction("Enabling auto-merge", success: "Auto-merge on") { try await syncService.setPullRequestAutoMerge(prId: effectivePrId, enabled: true, method: mergeMethod.rawValue) }
    case .disableAutoMerge:
      runPrAction("Turning off auto-merge", success: "Auto-merge off") { try await syncService.setPullRequestAutoMerge(prId: effectivePrId, enabled: false) }
    case .updateBranch: triggerRebase()
    case .resolveConflicts:
      if currentPr.laneId.isEmpty { openGitHub(urlString: "\(currentPr.githubUrl)/conflicts") } else { triggerRebase() }
    case .fixChecks: selectedTab = .checks
    case .rerunChecks: rerunChecks()
    case .addressFeedback, .fixThreads: selectedTab = .overview
    case .requestReview: editorSheet = .reviewers
    }
  }

  @MainActor
  private func triggerRebase() {
    guard !currentPr.laneId.isEmpty else {
      toast = ADEToastMessage(text: "This PR has no lane to rebase.", kind: .info)
      return
    }
    runPrAction("Starting rebase", success: "Rebase started") {
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
    detailLoadInFlight = true
    defer { detailLoadInFlight = false }
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
          // The aggregate GitHub payload does not include deployments,
          // capabilities, or group membership. Preserve any enrichment already
          // loaded for this route instead of treating absent fields as empty.
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
        // The phone hydrates snapshots only for open PRs and PRs whose lane is
        // live; a merged PR on an archived lane has none (or one without its
        // files) until it is asked for. The host sends it for `prs.refresh
        // { prId }`, so ask once per visit.
        if shouldFetchLiveSidecars, !refreshRemote, !didRequestSnapshotOnDemand,
          snapshot == nil || snapshot?.detail == nil || snapshot?.files.isEmpty == true
        {
          didRequestSnapshotOnDemand = true
          isRefreshingSnapshot = true
          defer { isRefreshingSnapshot = false }
          if (try? await syncService.refreshPullRequestSnapshots(prId: snapshotPrId)) != nil,
            let fresh = try await syncService.fetchPullRequestSnapshot(prId: snapshotPrId)
          {
            snapshot = fresh
          }
        }
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
  private func runPrAction(
    _ label: String,
    success: String? = nil,
    action: @escaping () async throws -> Void,
    successText: (@MainActor () -> String?)? = nil,
    onSuccess: @escaping @MainActor () -> Void = {}
  ) {
    let service = syncService
    let key = detailActionKey
    let actionablePrId = effectivePrId
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
        ADEHaptics.success()
        toast = ADEToastMessage(text: successText?() ?? success ?? "\(label) done")
      },
      onFailure: { error in
        Task { await reload(includeLiveSidecars: true) }
        ADEHaptics.error()
        toast = ADEToastMessage(text: error.localizedDescription, kind: .failure)
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
    let isStack = nativeStackMembership != nil
    let label = bypassRules ? "Merging (admin bypass)" : isStack ? "Merging the stack" : "Merging pull request"
    let outcome = PrLandOutcomeBox()
    let githubUrl = currentPr.githubUrl
    runPrAction(label, success: nil, action: {
      do {
        let result = try await syncService.mergePullRequest(
          prId: effectivePrId,
          method: mergeMethod.rawValue,
          bypassRules: bypassRules,
          commitTitle: commitTitle,
          commitBody: commitBody,
          expectedHeadSha: expectedHeadSha
        )
        await MainActor.run {
          outcome.result = result
        }
      } catch let error where isStack && error.localizedDescription.contains("merge the stack on GitHub") {
        // A computer on an older ADE cannot merge a stack; it says to use
        // GitHub. Open the PR there, as this screen did before.
        openGitHub(urlString: githubUrl)
        throw error
      }
    }, successText: { outcome.successText })
  }

  private func closeCurrentPr() {
    runPrAction("Closing pull request", success: "Pull request closed") { try await syncService.closePullRequest(prId: effectivePrId) }
  }

  private func reopenCurrentPr() {
    runPrAction("Reopening pull request", success: "Pull request reopened") { try await syncService.reopenPullRequest(prId: effectivePrId) }
  }

  /// Auto-map the current (unmapped) PR: create a lane from its head branch via
  /// the durable action wrapper so the spinner survives a tab switch. On a
  /// blocking conflict the message surfaces through the standard failure path.
  /// `machine` is where the lane is made; nil (or the focused machine) keeps
  /// the command on the focused machine.
  private func autoMapCurrentPr(on machine: PrLaneMachine?) {
    autoMapRequest = nil
    let owner = currentPr.repoOwner
    let repo = currentPr.repoName
    let number = currentPr.githubPrNumber
    guard !owner.isEmpty, !repo.isEmpty else { return }
    let onRemote = machine?.target != nil
    runPrAction(
      "Creating lane from PR branch",
      success: "Lane created",
      action: {
        let result: PrAutoMapCreateResult
        if let machine {
          result = try await syncService.createLaneFromPrBranch(
            repoOwner: owner, repoName: repo, githubPrNumber: number, on: machine
          )
        } else {
          result = try await syncService.createLaneFromPrBranch(
            repoOwner: owner, repoName: repo, githubPrNumber: number
          )
        }
        if let conflict = result.preflight.blockingConflict {
          throw PrAutoMapError.blocked(conflict.message)
        }
      },
      onSuccess: {
        guard onRemote, let onRemoteLinksChanged else { return }
        Task { await onRemoteLinksChanged() }
      }
    )
  }

  /// Opens the PR's lane in the Lanes tab. A namespaced id names the lane's
  /// machine.
  private func openCurrentLane() {
    let laneId = currentPr.laneId
    guard !laneId.isEmpty else { return }
    syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: laneId)
  }

  private func requestReviewers() {
    let reviewers = reviewerInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }

    guard !reviewers.isEmpty else { return }

    runPrAction(
      "Requesting reviewers",
      success: "Review requested",
      action: { try await syncService.requestReviewers(prId: effectivePrId, reviewers: reviewers) },
      onSuccess: { reviewerInput = "" }
    )
  }

  private func rerunChecks() {
    runPrAction("Re-running checks", success: "Checks re-running") { try await syncService.rerunPullRequestChecks(prId: effectivePrId) }
  }

  private func submitComment() {
    let trimmed = commentInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    runPrAction(
      "Posting comment",
      success: "Comment posted",
      action: { try await syncService.addPullRequestComment(prId: effectivePrId, body: trimmed) },
      onSuccess: { commentInput = "" }
    )
  }

  private func replyToThread(threadId: String, body: String) {
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    runPrAction("Replying to review thread", success: "Reply posted") {
      try await syncService.replyToPullRequestReviewThread(prId: effectivePrId, threadId: threadId, body: trimmed)
    }
  }

  private func setThreadResolved(threadId: String, resolved: Bool) {
    runPrAction(resolved ? "Resolving review thread" : "Reopening review thread", success: resolved ? "Thread resolved" : "Thread reopened") {
      try await syncService.setPullRequestReviewThreadResolved(prId: effectivePrId, threadId: threadId, resolved: resolved)
    }
  }

  private func performCleanup() async {
    // A lane of another machine is archived or deleted there, by its
    // namespaced id.
    let laneId = currentPr.laneId
    guard !laneId.isEmpty else { return }
    let choice = cleanupChoice
    let token = syncService.beginPrAction(
      key: detailActionKey,
      label: choice == .archive ? "Archiving lane" : "Deleting lane and branch"
    )
    defer { syncService.endPrAction(key: detailActionKey, token: token) }
    do {
      switch choice {
      case .archive:
        try await syncService.archiveLane(laneId)
      case .deleteBranch:
        try await syncService.deleteLane(laneId, deleteBranch: true, deleteRemoteBranch: true)
      }
      toast = ADEToastMessage(text: choice == .archive ? "Lane archived" : "Lane and branch deleted")
    } catch {
      toast = ADEToastMessage(text: error.localizedDescription, kind: .failure)
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
      toast = ADEToastMessage(text: "This PR has no lane, so Files cannot open it.", kind: .info)
      return
    }

    do {
      let workspaceId: String
      if let filesWorkspaceId {
        workspaceId = filesWorkspaceId
      } else {
        let workspaces = try await syncService.listWorkspaces()
        guard let workspace = workspaces.first(where: { $0.laneId == laneId }) else {
          toast = ADEToastMessage(text: "No Files workspace for this lane yet.", kind: .info)
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
      toast = ADEToastMessage(text: "Opening \(prFileName(file.filename)) in Files", kind: .info)
    } catch {
      filesWorkspaceId = nil
      ADEHaptics.error()
      toast = ADEToastMessage(text: error.localizedDescription, kind: .failure)
    }
  }

  private func copyFilePath(_ file: PrFile) {
    UIPasteboard.general.string = file.filename
    toast = ADEToastMessage(text: "Path copied")
  }

  // MARK: - Duo

  /// The Duo's column: `PrDuoDetail` over this screen's state and actions.
  /// Before the first load lands it is the phone list (skeleton or notice),
  /// which already says the right thing.
  @ViewBuilder
  private var duoDetail: some View {
    if isAwaitingInitialPrDetail || isPrDetailUnavailable {
      phoneDetail
        .toolbar { DuoSplitListToggle(split: duoSplit) }
    } else {
      PrDuoDetail(
        model: duoModel,
        actions: duoActions,
        tab: $selectedTab,
        mergeMethod: $mergeMethod,
        header: {
          PrFlatDetailHeader(
            createdAt: githubItem?.createdAt ?? currentPr.createdAt,
            updatedAt: githubItem?.updatedAt ?? currentPr.updatedAt,
            title: currentPr.title,
            baseBranch: currentPr.baseBranch,
            headBranch: currentPr.headBranch,
            laneName: laneName,
            ghostLaneName: (githubItem?.detached ?? pr?.detached)?.laneName,
            machineName: machineContext.machineName(forLaneId: currentPr.laneId),
            stackLabel: stackLabel,
            onOpenLane: currentPr.laneId.isEmpty ? nil : openCurrentLane,
            onOpenStack: currentPr.linkedGroupId.map { groupId in { openStack(groupId: groupId, groupName: currentPr.linkedGroupName) } }
              ?? (nativeStackMembership != nil ? { openGitHub(urlString: currentPr.githubUrl) } : nil),
            canCreateLane: canAutoMapCurrentPr && githubItem != nil,
            canLinkLane: canMapCurrentPr,
            onCreateLane: presentCreateLane,
            onLinkLane: { if let githubItem { laneLinkItem = githubItem } },
            showsTitle: false
          )
        },
        overflow: { moreMenuItems }
      )
    }
  }

  private var duoModel: PrDuoDetailModel {
    let step = nextStep
    let state = displayedState
    var notices: [PrDuoNotice] = []
    if let errorMessage, !syncService.connectionState.isHostUnreachable {
      notices.append(PrDuoNotice(id: "error", message: errorMessage, isError: true))
    }
    if !unavailableDetailParts.isEmpty {
      let parts = unavailableDetailParts.map { $0.replacingOccurrences(of: "_", with: " ") }.joined(separator: ", ")
      notices.append(PrDuoNotice(id: "partial", message: "Could not refresh \(parts). This is partial, not empty.", isError: false))
    }
    var mergedSummary: String?
    if state == "merged" {
      let by = currentPr.mergedBy.map { " by \($0.login)" } ?? ""
      let at = prCompactRelativeTime(currentPr.mergedAt)
      mergedSummary = "Merged into \(currentPr.baseBranch)\(by)\(at.isEmpty ? "" : " · \(at) ago")"
    }
    return PrDuoDetailModel(
      title: currentPr.title,
      number: displayedPrNumber ?? currentPr.githubPrNumber,
      state: state,
      author: snapshot?.detail?.author.login ?? githubItem?.author,
      description: cleanedDescription,
      digest: digest,
      threadsById: threadsById,
      isLoadingDescription: isAwaitingPrSnapshot,
      notices: notices,
      files: snapshot?.files ?? [],
      filesLoading: isRefreshingSnapshot || (!hasLoadedLiveSidecars && isLive),
      // Files reads the focused machine only, so a lane of another machine
      // cannot open there yet.
      canOpenFiles: !currentPr.laneId.isEmpty && !isWorkRemoteLaneId(currentPr.laneId),
      checks: snapshot?.checks ?? [],
      overallChecksStatus: snapshot?.status?.checksStatus ?? currentPr.checksStatus,
      checksReason: snapshot?.status?.checksReason ?? currentPr.checksReason,
      missingRequired: snapshot?.status?.checksMissingRequired ?? currentPr.checksMissingRequired ?? [],
      actionRuns: actionRuns,
      deployments: deployments,
      canRerun: canRerunChecks && canRunPrActions,
      step: step,
      mergeStatus: step.kind == .merged || step.kind == .closed ? .known : mergeStatusPresence,
      busyLabel: detailBusyLabel,
      canAct: canRunPrActions,
      canComment: canRunPrActions && canAddComment,
      canReview: canRunPrActions && (state == "open" || state == "draft"),
      canEditMetadata: canUpdateCurrentPrMetadata,
      detail: snapshot?.detail,
      reviews: snapshot?.reviews ?? [],
      stack: nativeStackMembership.map { PrDuoStackMerge(position: $0.position, size: $0.size, count: stackMergeCount) },
      isDraft: isCurrentPrDraft,
      mergedSummary: mergedSummary,
      canArchiveLane: !currentPr.laneId.isEmpty && canRunPrActions,
      canMergeAnyway: canRunPrActions
        && (nativeStackMembership == nil || stackMergeCount == 1 || syncService.supportsStackLayeredBypass),
      canOpenGitHub: canOpenCurrentPrInGitHub
    )
  }

  private var duoActions: PrDuoDetailActions {
    PrDuoDetailActions(
      refresh: { await reload(refreshRemote: true) },
      retry: { Task { await retryPrDetailLoad() } },
      reply: { threadId, body in replyToThread(threadId: threadId, body: body) },
      resolve: { threadId, resolved in setThreadResolved(threadId: threadId, resolved: resolved) },
      openFile: { file in Task { await openFileInFiles(file) } },
      copyPath: copyFilePath,
      rerun: rerunChecks,
      runStep: runNextStep,
      stepLabel: nextStepLabel,
      stepAvailable: nextStepAvailable,
      merge: { mergeCurrentPr() },
      mergeAnyway: { mergeAnywayConfirmationPresented = true },
      stackMerge: { stackMergeConfirmationPresented = true },
      archiveLane: {
        cleanupChoice = .archive
        cleanupConfirmationPresented = true
      },
      comment: { body in
        commentInput = body
        submitComment()
      },
      review: { event, body in
        runPrAction("Submitting review", success: "Review submitted") {
          try await syncService.submitPullRequestReview(prId: effectivePrId, event: event.rawValue, body: body)
        }
      },
      requestReviewers: { logins in
        reviewerInput = logins.joined(separator: ",")
        requestReviewers()
      },
      setLabels: { labels in
        runPrAction("Updating labels", success: "Labels updated") {
          try await syncService.setPullRequestLabels(prId: effectivePrId, labels: labels)
        }
      },
      openGitHub: { openGitHub(urlString: currentPr.githubUrl) }
    )
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
  let sectionTitle: String
  let submitTitle: String
  let onSubmit: (String) -> Void
  @State private var value: String

  init(title: String, sectionTitle: String, initialValue: String, submitTitle: String, onSubmit: @escaping (String) -> Void) {
    self.title = title
    self.sectionTitle = sectionTitle
    self.submitTitle = submitTitle
    self.onSubmit = onSubmit
    _value = State(initialValue: initialValue)
  }

  var body: some View {
    NavigationStack {
      Form {
        Section(sectionTitle) {
          TextEditor(text: $value)
            .frame(minHeight: 180)
        }
      }
      .navigationTitle(title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button(submitTitle) { onSubmit(value) }
            .disabled(value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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

  private var submitDisabled: Bool {
    event != .approve && reviewBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Picker("Decision", selection: $event) {
            ForEach(PrReviewEventOption.allCases) { option in
              Text(option.title).tag(option)
            }
          }
          .pickerStyle(.segmented)
        }
        Section {
          TextEditor(text: $reviewBody)
            .frame(minHeight: 140)
        } header: {
          Text("Review")
        } footer: {
          Text("Approvals can go without a note; comments and requested changes need one.")
        }
      }
      .navigationTitle("Submit review")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { dismiss() }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Submit") {
            let trimmed = reviewBody.trimmingCharacters(in: .whitespacesAndNewlines)
            onSubmit(event, trimmed.isEmpty ? nil : trimmed)
          }
          .disabled(submitDisabled)
        }
      }
    }
  }
}

/// Carries a merge result out of the durable action closure to its toast.
@MainActor
private final class PrLandOutcomeBox {
  var result: LandResult?

  var successText: String {
    guard let result else { return "Merged" }
    if result.isInFlight { return result.error ?? "GitHub is merging the stack." }
    if let numbers = result.stackPrNumbers, numbers.count > 1 {
      return "Merged \(numbers.count) stacked PRs"
    }
    return "Merged"
  }
}

// MARK: - Duo column

/// What the Duo's PR column shows. Built by `PrDetailView` from its loaded
/// state, and by the fixtures from fixture data.
struct PrDuoDetailModel {
  var title: String
  var number: Int
  var state: String
  var author: String?
  var description: String
  var digest: PrConversationDigest
  var threadsById: [String: PrReviewThread]
  var isLoadingDescription = false
  var notices: [PrDuoNotice] = []
  var files: [PrFile]
  var filesLoading = false
  var canOpenFiles: Bool
  var checks: [PrCheck]
  var overallChecksStatus: String?
  var checksReason: String?
  var missingRequired: [String] = []
  var actionRuns: [PrActionRun]
  var deployments: [PrDeployment] = []
  var canRerun: Bool
  var step: PrNextStep
  var mergeStatus: PrMergeStatusPresence = .known
  var busyLabel: String?
  var canAct: Bool
  var canComment: Bool
  var canReview: Bool
  var canEditMetadata: Bool
  var detail: PrDetail?
  var reviews: [PrReview]
  var stack: PrDuoStackMerge?
  var isDraft = false
  var mergedSummary: String?
  var canArchiveLane: Bool
  var canMergeAnyway: Bool
  var canOpenGitHub: Bool

  /// "#1367 · Merged · arul28"
  var subtitle: String {
    let stateTitle: String
    switch state {
    case "merged": stateTitle = "Merged"
    case "closed": stateTitle = "Closed"
    case "draft": stateTitle = "Draft"
    default: stateTitle = "Open"
    }
    return (["#\(number)", stateTitle] + [author].compactMap { $0 }.filter { !$0.isEmpty })
      .joined(separator: " · ")
  }

  var failingChecks: Int {
    checks.filter { prCheckConclusionKind($0) == .failure }.count
  }
}

struct PrDuoNotice: Identifiable, Equatable {
  let id: String
  let message: String
  let isError: Bool
}

/// What the Duo's PR column does, as the screen's own actions.
struct PrDuoDetailActions {
  var refresh: () async -> Void
  var retry: () -> Void
  var reply: (_ threadId: String, _ body: String) -> Void
  var resolve: (_ threadId: String, _ resolved: Bool) -> Void
  var openFile: (PrFile) -> Void
  var copyPath: (PrFile) -> Void
  var rerun: () -> Void
  var runStep: (PrNextStepAction) -> Void
  var stepLabel: (PrNextStepAction) -> String
  var stepAvailable: (PrNextStepAction) -> Bool
  var merge: () -> Void
  var mergeAnyway: () -> Void
  var stackMerge: () -> Void
  var archiveLane: () -> Void
  var comment: (String) -> Void
  var review: (PrReviewEventOption, String?) -> Void
  var requestReviewers: ([String]) -> Void
  var setLabels: ([String]) -> Void
  var openGitHub: () -> Void
}

/// One PR on the Duo's inner display, as desktop lays it out and Apple draws
/// it: Overview / Files / Checks is a segmented control at the head of the
/// column, the thread fills it with the push rail on its trailing edge, and
/// the dock is toolbar items — held landscape the top of the vertical edge
/// bar (Merge pinned first, then Comment, Reviewers, Labels, Assignees, the
/// overflow last; the app tabs hold the bottom), held portrait the top bar.
/// Nothing is a bottom bar. Each dock item opens desktop's card as a popover
/// from the top of the column, so a card opens even when its item has given
/// way to the overflow menu.
///
/// Files and Checks use the width: list beside the diff or the check, one per
/// page when book-folded, top and bottom halves held portrait.
struct PrDuoDetail<Header: View, Overflow: View>: View {
  let model: PrDuoDetailModel
  let actions: PrDuoDetailActions
  @Binding var tab: PrDetailTab
  @Binding var mergeMethod: PrMergeMethodOption
  @ViewBuilder let header: () -> Header
  @ViewBuilder let overflow: () -> Overflow

  @Environment(\.duoSplit) private var split
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var dock: PrDuoDock?
  @State private var commentDraft = ""
  @State private var reviewerDraft = ""
  @State private var labelDraft = ""
  @State private var selectedFile: String?
  @State private var selectedCheck: String?
  @State private var activePush: String?

  init(
    model: PrDuoDetailModel,
    actions: PrDuoDetailActions,
    tab: Binding<PrDetailTab>,
    mergeMethod: Binding<PrMergeMethodOption>,
    initialDock: PrDuoDock? = nil,
    @ViewBuilder header: @escaping () -> Header,
    @ViewBuilder overflow: @escaping () -> Overflow
  ) {
    self.model = model
    self.actions = actions
    _tab = tab
    _mergeMethod = mergeMethod
    self.header = header
    self.overflow = overflow
    self.initialDock = initialDock
  }

  /// A card to open once the column is on screen (fixtures). A popover asked
  /// for before its toolbar item is laid out never shows.
  private let initialDock: PrDuoDock?

  /// Outside a split (a sheet) the column is narrow: lay it out as portrait.
  private var family: DuoFamily { split?.family ?? .tall }

  var body: some View {
    withToolbar(content)
      .safeAreaInset(edge: .top, spacing: 0) { tabPicker }
      .popover(
        item: $dock,
        attachmentAnchor: .point(.topTrailing),
        arrowEdge: family == .wide ? .trailing : .top
      ) { item in
        card(item)
      }
      .navigationTitle(model.title)
      .navigationSubtitle(model.subtitle)
      .navigationBarTitleDisplayMode(.inline)
      .background(ADEColor.pageBackground)
      // Files wants both pages for the list and the diff: the PR list folds
      // behind the sidebar toggle while it is open.
      .onChange(of: tab == .files, initial: true) { _, files in
        split?.setDetailWantsFullWidth(files)
      }
      .onDisappear { split?.setDetailWantsFullWidth(false) }
      .task {
        guard let initialDock else { return }
        try? await Task.sleep(for: .milliseconds(700))
        dock = initialDock
      }
  }

  /// Overview / Files / Checks, under the title. Checks carries its failing
  /// count in the segment's own text.
  private var tabPicker: some View {
    Picker("Section", selection: Binding(
      get: { tab == .activity ? .overview : tab },
      set: { next in
        guard next != tab else { return }
        ADEHaptics.light()
        dock = nil
        tab = next
      }
    )) {
      Text(PrDetailTab.overview.title).tag(PrDetailTab.overview)
      Text(PrDetailTab.files.title).tag(PrDetailTab.files)
      Text(model.failingChecks > 0 ? "Checks · \(model.failingChecks)" : PrDetailTab.checks.title)
        .tag(PrDetailTab.checks)
    }
    .pickerStyle(.segmented)
    .frame(maxWidth: 420)
    .padding(.horizontal, 16)
    .padding(.top, 6)
    .padding(.bottom, 8)
    .frame(maxWidth: .infinity)
    .background(ADEColor.pageBackground)
  }

  @ViewBuilder
  private var content: some View {
    switch tab {
    case .overview, .activity:
      overview
    case .files:
      files
    case .checks:
      checks
    }
  }

  // MARK: Overview

  private var overview: some View {
    let ticks = prDigestPushTicks(model.digest)
    return ScrollViewReader { proxy in
      List {
        Section {
          header()
            .adeFlatRow(insets: EdgeInsets(top: 6, leading: 16, bottom: 10, trailing: 16), separator: .hidden)
          ForEach(model.notices) { notice in
            Group {
              if notice.isError {
                ADEFlatInlineNotice(message: notice.message, tint: ADEColor.danger, retry: actions.retry)
              } else {
                ADEFlatInlineNotice(message: notice.message, retry: actions.retry)
              }
            }
            .adeFlatRow(separator: .hidden)
          }
        }
        PrOverviewSections(
          description: model.description,
          digest: model.digest,
          threadsById: model.threadsById,
          canAct: model.canAct,
          onReply: actions.reply,
          onResolve: actions.resolve,
          isLoading: model.isLoadingDescription
        )
      }
      .adeFlatList()
      .listSectionSpacing(.compact)
      .contentMargins(.bottom, 24, for: .scrollContent)
      .adeScrollDiagnosticsSurface(.prDetail, key: "pr-detail-duo")
      .refreshable { await actions.refresh() }
      // The rail has its own strip on the thread's trailing edge, so it never
      // covers a row.
      .safeAreaInset(edge: .trailing, alignment: .top, spacing: 0) {
        if ticks.count > 1 {
          PrPushTickRail(ticks: ticks, activeId: activePush) { tick in
            activePush = tick.id
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.3)) {
              proxy.scrollTo(tick.itemId, anchor: .top)
            }
          }
          .padding(.top, 10)
          .padding(.trailing, 6)
        }
      }
    }
  }

  // MARK: Files

  private var files: some View {
    DuoLocalFoldReader { fold, size in
      if family == .wide {
        let listWidth: CGFloat = {
          if case .sideBySide(let rect) = fold, rect.minX > 220 { return rect.minX }
          return min(300, size.width * 0.4)
        }()
        HStack(spacing: 0) {
          filesList.frame(width: listWidth)
          DuoSeam(axis: .vertical, foldRect: sideBySideRect(fold))
          diffPane.frame(maxWidth: .infinity)
        }
      } else {
        let top: CGFloat = {
          if case .stacked(let rect) = fold, rect.minY > 160 { return rect.minY }
          return size.height * 0.4
        }()
        VStack(spacing: 0) {
          filesList.frame(height: top)
          DuoSeam(axis: .horizontal, foldRect: stackedRect(fold))
          diffPane.frame(maxHeight: .infinity)
        }
      }
    }
    .onAppear { selectFirstFileIfNeeded() }
    .onChange(of: model.files.map(\.filename)) { _, _ in selectFirstFileIfNeeded() }
  }

  private var filesList: some View {
    List {
      PrFilesSections(
        files: model.files,
        isLoading: model.filesLoading,
        canOpenFiles: model.canOpenFiles,
        onOpenFile: actions.openFile,
        onCopyPath: actions.copyPath,
        selection: $selectedFile
      )
    }
    .adeFlatList()
    .listSectionSpacing(.compact)
    .contentMargins(.bottom, 24, for: .scrollContent)
  }

  private var currentFile: PrFile? {
    model.files.first { $0.filename == selectedFile } ?? model.files.first
  }

  @ViewBuilder
  private var diffPane: some View {
    if let file = currentFile {
      ScrollView(.vertical) {
        PrFileDiffContent(file: file)
          .padding(.bottom, 24)
      }
      .id(file.filename)
      // Long diff lines scroll inside their own rows; clip them to the column
      // so none of them runs under the edge bar.
      .clipped()
      .background(ADEColor.pageBackground)
    } else {
      ContentUnavailableView("No file selected", systemImage: "doc.text")
    }
  }

  private func selectFirstFileIfNeeded() {
    if selectedFile == nil || !model.files.contains(where: { $0.filename == selectedFile }) {
      selectedFile = model.files.first?.filename
    }
  }

  // MARK: Checks

  @ViewBuilder
  private var checks: some View {
    DuoLocalFoldReader { fold, size in
      // Beside the check only when both fit; a single page pushes it.
      if family == .wide, size.width >= 460 {
        let listWidth = min(300, size.width * 0.45)
        HStack(spacing: 0) {
          checksList(selecting: true).frame(width: listWidth)
          DuoSeam(axis: .vertical, foldRect: sideBySideRect(fold))
          checkPane.frame(maxWidth: .infinity)
        }
      } else {
        checksList(selecting: false)
      }
    }
    .onAppear { selectFirstCheckIfNeeded() }
    .onChange(of: model.checks.map(\.id)) { _, _ in selectFirstCheckIfNeeded() }
  }

  private func checksList(selecting: Bool) -> some View {
    List {
      PrChecksSections(
        checks: model.checks,
        overallChecksStatus: model.overallChecksStatus,
        checksReason: model.checksReason,
        missingRequired: model.missingRequired,
        actionRuns: model.actionRuns,
        deployments: model.deployments,
        canRerun: model.canRerun,
        onRerun: actions.rerun,
        selection: selecting ? $selectedCheck : nil
      )
    }
    .adeFlatList()
    .listSectionSpacing(.compact)
    .contentMargins(.bottom, 24, for: .scrollContent)
    .refreshable { await actions.refresh() }
  }

  @ViewBuilder
  private var checkPane: some View {
    if let check = model.checks.first(where: { $0.id == selectedCheck }) {
      List {
        PrCheckDetailSections(check: check, match: prActionJob(for: check, in: model.actionRuns))
      }
      .adeFlatList()
      .id(check.id)
    } else {
      ContentUnavailableView("No check selected", systemImage: "checkmark.seal")
    }
  }

  /// The first failing check, else the first running one, else the first.
  private func selectFirstCheckIfNeeded() {
    guard selectedCheck == nil || !model.checks.contains(where: { $0.id == selectedCheck }) else { return }
    let kinds: [PrCheckConclusionKind] = [.failure, .pending, .success, .neutral]
    for kind in kinds {
      if let check = model.checks.first(where: { prCheckConclusionKind($0) == kind }) {
        selectedCheck = check.id
        return
      }
    }
    selectedCheck = nil
  }

  private func sideBySideRect(_ fold: DuoFold) -> CGRect? {
    if case .sideBySide(let rect) = fold { return rect }
    return nil
  }

  private func stackedRect(_ fold: DuoFold) -> CGRect? {
    if case .stacked(let rect) = fold { return rect }
    return nil
  }

  // MARK: Toolbar

  @ViewBuilder
  private func withToolbar<Content: View>(_ content: Content) -> some View {
    if #available(iOS 27.0, *) {
      content.toolbar { edgeBarItems }
    } else {
      content.toolbar { plainBarItems }
    }
  }

  /// iOS 27: Merge pinned first, the open tab's own action, then the dock —
  /// Comment and Reviewers held in view, Labels and Assignees the first to
  /// give way — and the rest in the system overflow. All top items: held
  /// landscape the app tabs own the bottom of the edge bar, and held portrait
  /// nothing sits under the content.
  @available(iOS 27.0, *)
  @ToolbarContentBuilder
  private var edgeBarItems: some ToolbarContent {
    DuoSplitListToggle(split: split)
    ToolbarItem(placement: .topBarPinnedTrailing) { mergeBubble }
      .visibilityPriority(.high)
    tabActionItem
    ForEach(PrDuoDock.allCases.filter { $0 != .merge }) { item in
      ToolbarItem(placement: .topBarTrailing) { dockButton(item) }
        .visibilityPriority(item == .comment || item == .reviewers ? .automatic : .low)
    }
    ToolbarOverflowMenu {
      Button("Open on GitHub", systemImage: "arrow.up.right.square", action: actions.openGitHub)
        .disabled(!model.canOpenGitHub)
      overflow()
    }
  }

  /// Before iOS 27 (an iPad on iOS 26): the same items in the top bar.
  @ToolbarContentBuilder
  private var plainBarItems: some ToolbarContent {
    DuoSplitListToggle(split: split)
    ToolbarItem(placement: .topBarTrailing) { mergeBubble }
    tabActionItem
    ForEach(PrDuoDock.allCases.filter { $0 != .merge }) { item in
      ToolbarItem(placement: .topBarTrailing) { dockButton(item) }
    }
    ToolbarItem(placement: .topBarTrailing) {
      Menu {
        Button("Open on GitHub", systemImage: "arrow.up.right.square", action: actions.openGitHub)
          .disabled(!model.canOpenGitHub)
        overflow()
      } label: {
        Image(systemName: "ellipsis")
      }
      .accessibilityLabel("Pull request actions")
    }
  }

  /// The open tab's own action: re-run on Checks, open in Files on Files.
  @ToolbarContentBuilder
  private var tabActionItem: some ToolbarContent {
    if tab == .checks, model.canRerun, model.failingChecks > 0 {
      ToolbarItem(placement: .topBarTrailing) {
        Button("Re-run checks", systemImage: "arrow.clockwise", action: actions.rerun)
      }
    }
    if tab == .files, model.canOpenFiles, let file = currentFile {
      ToolbarItem(placement: .topBarTrailing) {
        Button("Open in Files", systemImage: "folder") { actions.openFile(file) }
      }
    }
  }

  private var mergeBubble: some View {
    Button {
      toggle(.merge)
    } label: {
      PrDuoMergeBubbleLabel(ring: prDuoMergeRingColor(model.step, mergeStatus: model.mergeStatus))
    }
    .accessibilityLabel("Merge: \(model.mergeStatus == .known ? model.step.headline : "checking")")
  }

  private func dockButton(_ item: PrDuoDock) -> some View {
    Button(item.title, systemImage: item.symbol) { toggle(item) }
      .badge(item == .reviewers ? reviewers.count : 0)
  }

  private var reviewers: [PrDuoReviewer] {
    prDuoReviewers(detail: model.detail, reviews: model.reviews)
  }

  private func toggle(_ item: PrDuoDock) {
    ADEHaptics.light()
    dock = dock == item ? nil : item
  }

  /// A confirmation can only present once the card has gone.
  private func afterClosingCard(_ action: @escaping () -> Void) {
    dock = nil
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(400))
      action()
    }
  }

  private func runStep(_ action: PrNextStepAction) {
    switch action {
    case .deleteBranch:
      afterClosingCard { actions.runStep(.deleteBranch) }
    case .requestReview:
      dock = .reviewers
    case .fixChecks:
      dock = nil
      tab = .checks
    case .addressFeedback, .fixThreads:
      dock = nil
      tab = .overview
    default:
      actions.runStep(action)
    }
  }

  @ViewBuilder
  private func card(_ item: PrDuoDock) -> some View {
    switch item {
    case .merge:
      PrDuoMergeCard(
        step: model.step,
        mergeStatus: model.mergeStatus,
        busyLabel: model.busyLabel,
        stack: model.stack,
        isDraft: model.isDraft,
        mergedSummary: model.mergedSummary,
        method: $mergeMethod,
        canMergeAnyway: model.canMergeAnyway,
        canArchiveLane: model.canArchiveLane,
        label: actions.stepLabel,
        isAvailable: actions.stepAvailable,
        onRun: runStep,
        onMerge: actions.merge,
        onMergeAnyway: { afterClosingCard(actions.mergeAnyway) },
        onStackMerge: { afterClosingCard(actions.stackMerge) },
        onArchiveLane: { afterClosingCard(actions.archiveLane) },
        onChip: { chip in
          switch chip.id {
          case "checks": runStep(.fixChecks)
          case "threads", "review": runStep(.fixThreads)
          default: break
          }
        }
      )
    case .comment:
      PrDuoCommentCard(
        canReview: model.canReview,
        canComment: model.canComment,
        isBusy: model.busyLabel != nil,
        draft: $commentDraft,
        onComment: { body in
          actions.comment(body)
          commentDraft = ""
          dock = nil
        },
        onReview: { event, body in
          actions.review(event, body)
          dock = nil
        }
      )
    case .reviewers:
      PrDuoReviewersCard(
        reviewers: reviewers,
        canRequest: model.canAct,
        draft: $reviewerDraft,
        onRequest: actions.requestReviewers
      )
    case .labels:
      PrDuoLabelsCard(
        labels: model.detail?.labels ?? [],
        canEdit: model.canEditMetadata,
        draft: $labelDraft,
        onSet: actions.setLabels
      )
    case .assignees:
      PrDuoAssigneesCard(assignees: model.detail?.assignees ?? [])
    }
  }
}
