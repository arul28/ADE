import SwiftUI
import UIKit

struct PrDetailView: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService
  let prId: String
  let transitionNamespace: Namespace.ID?

  @State private var pr: PullRequestListItem?
  @State private var githubItem: GitHubPrListItem?
  @State private var snapshot: PullRequestSnapshot?
  @State private var reviewThreads: [PrReviewThread] = []
  @State private var actionRuns: [PrActionRun] = []
  @State private var activityEvents: [PrActivityEvent] = []
  @State private var deployments: [PrDeployment] = []
  @State private var aiSummary: AiReviewSummary?
  @State private var isAiSummaryLoading: Bool = false
  @State private var issueInventory: IssueInventorySnapshot?
  @State private var pipelineSettings: PipelineSettings?
  @State private var groupMembers: [PrGroupMemberSummary] = []
  @State private var capabilities: PrActionCapabilities?
  @State private var selectedTab: PrDetailTab = .overview
  @State private var mergeMethod: PrMergeMethodOption = .squash
  @State private var reviewerInput = ""
  @State private var commentInput = ""
  @State private var errorMessage: String?
  @State private var actionMessage: String?
  @State private var busyAction: String?
  @State private var cleanupChoice: PrCleanupChoice = .archive
  @State private var cleanupConfirmationPresented = false
  @State private var filesWorkspaceId: String?
  @State private var stackPresentation: PrStackPresentation?
  @State private var editorSheet: PrDetailEditorSheet?
  @State private var mergeMethodSheetPresented: Bool = false
  @State private var aiResolution: AiResolutionState?
  @State private var isAiResolverBusy: Bool = false
  @State private var aiResolverSheetPresented: Bool = false
  @State private var actionsSheetPresented: Bool = false
  @State private var hasLoadedLiveSidecars = false
  /// True while a `prs.pathToMerge.start` or `prs.pathToMerge.stop` round-trip
  /// is in flight. Used to disable the convergence toggle and show a spinner.
  @State private var isPathToMergeBusy: Bool = false

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var isLive: Bool {
    prsStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var canRunPrActions: Bool {
    isLive && busyAction == nil
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

  private var currentPr: PullRequestListItem {
    if let pr { return pr }
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
      repoOwner: githubItem?.repoOwner ?? "",
      repoName: githubItem?.repoName ?? "",
      githubPrNumber: githubItem?.githubPrNumber ?? 0,
      githubUrl: githubItem?.githubUrl ?? "",
      title: githubItem?.title ?? "Pull request",
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
    // The Activity tab has its own comment/reply composer at the end of the
    // content. A global merge bar in the same bottom slot hides that composer
    // on phone-sized screens.
    selectedTab != .activity
  }

  private var behindBaseBy: Int {
    snapshot?.status?.behindBaseBy ?? 0
  }

  /// Set of sub-tabs shown in the detail picker.
  private var visibleTabs: [PrDetailTab] {
    [.overview, .convergence, .files, .checks, .activity]
  }

  private func tabTitle(_ tab: PrDetailTab) -> String {
    switch tab {
    case .overview: return "Overview"
    case .checks: return "CI / Checks"
    case .activity: return "Activity"
    case .files: return "Files"
    case .convergence: return "Path to Merge"
    }
  }

  /// Live count for the segmented tab pill. Returns nil when no count is
  /// meaningful (Overview) or when data hasn't synced yet (zero hidden).
  private func tabCount(_ tab: PrDetailTab) -> Int? {
    switch tab {
    case .overview:
      return nil
    case .convergence:
      let items = issueInventory?.items ?? []
      let active = items.filter { $0.state == "new" || $0.state == "sent_to_agent" || $0.state == "escalated" }.count
      return active > 0 ? active : nil
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
    List {
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
          action: { Task { await reload(refreshRemote: true) } }
        )
        .prListRow()
      }

      heroCard
        .prListRow()

      PrMergeGateCard(info: mergeGateInfo) {
        switch mergeGateInfo.target {
        case .checks: selectedTab = .checks
        case .reviews: selectedTab = .activity
        case .overview: selectedTab = .overview
        }
      }
      .prListRow()

      subTabPicker
        .prListRow()

      switch selectedTab {
      case .overview:
        PrOverviewTab(
          pr: currentPr,
          snapshot: snapshot,
          aiSummary: aiSummary,
          isLive: canRunPrActions,
          isAiSummaryLoading: isAiSummaryLoading,
          groupMembers: groupMembers,
          onNavigate: { target in
            switch target {
            case .checks: selectedTab = .checks
            case .files: selectedTab = .files
            }
          },
          onRegenerateAiSummary: refreshAiSummary,
          onOpenStack: openStack,
          onArchiveLane: {
            cleanupChoice = .archive
            cleanupConfirmationPresented = true
          },
          onDeleteBranch: {
            cleanupChoice = .deleteBranch
            cleanupConfirmationPresented = true
          }
        )
        .prListRow()
      case .convergence:
        PrPathToMergeTab(
          pr: currentPr,
          snapshot: snapshot,
          groupMembers: groupMembers,
          reviewThreads: reviewThreads,
          deployments: deployments,
          aiSummary: aiSummary,
          issueInventory: issueInventory,
          pipelineSettings: pipelineSettings,
          capabilities: capabilities,
          isLive: canRunPrActions,
          aiResolution: aiResolution,
          isAiResolverBusy: isAiResolverBusy,
          onRefreshAiSummary: refreshAiSummary,
          onRerunChecks: rerunChecks,
          onSyncIssueInventory: syncIssueInventory,
          onMarkIssueFixed: { itemId in markIssueInventory(itemId: itemId, action: .fixed) },
          onDismissIssue: { itemId in markIssueInventory(itemId: itemId, action: .dismissed) },
          onEscalateIssue: { itemId in markIssueInventory(itemId: itemId, action: .escalated) },
          onResetIssueInventory: resetIssueInventory,
          onToggleAutoMerge: toggleAutoMerge,
          onSetPipelineMergeMethod: setPipelineMergeMethod,
          onSetPipelineMaxRounds: setPipelineMaxRounds,
          onSetPipelineRebasePolicy: setPipelineRebasePolicy,
          onSetPipelineConflictStrategy: setPipelineConflictStrategy,
          onSetAtCapPolicy: setPipelineAtCapPolicy,
          onSetAtCapWaitMinutes: setPipelineAtCapWaitMinutes,
          onSetAtCapCiRetryMax: setPipelineAtCapCiRetryMax,
          onSetForceMergeRequiresConfirmation: setPipelineForceMergeRequiresConfirmation,
          onSetForceFinalizeRequireNoCiFailures: setPipelineForceFinalizeRequireNoCiFailures,
          onSetEarlyMergeOnGreen: setPipelineEarlyMergeOnGreen,
          onCopyPrompt: copyConvergencePrompt,
          onLaunchAiResolver: { aiResolverSheetPresented = true },
          onStopAiResolver: stopAiResolver,
          isPathToMergeBusy: isPathToMergeBusy,
          onStartPathToMerge: startPathToMerge,
          onStopPathToMerge: stopPathToMerge
        )
        .prListRow()
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
          aiResolution: aiResolution,
          isAiResolverBusy: isAiResolverBusy,
          onRerun: rerunChecks,
          onLaunchAiResolver: { aiResolverSheetPresented = true },
          onStopAiResolver: stopAiResolver
        )
        .prListRow()
      case .activity:
        PrActivityTab(
          timeline: buildPullRequestTimeline(
            pr: currentPr,
            snapshot: snapshot ?? PullRequestSnapshot(detail: nil, status: nil, checks: [], reviews: [], comments: [], files: []),
            activity: activityEvents
          ),
          reviewThreads: reviewThreads,
          reviews: snapshot?.reviews ?? [],
          requestedReviewers: snapshot?.detail?.requestedReviewers ?? [],
          authorLogin: snapshot?.detail?.author.login,
          requiredApprovals: max(reviewsNeeded, 1),
          commentInput: $commentInput,
          canAddComment: canAddComment,
          isLive: canRunPrActions,
          aiResolution: aiResolution,
          isAiResolverBusy: isAiResolverBusy,
          onSubmitComment: submitComment,
          onReplyToThread: replyToThread,
          onSetThreadResolved: setThreadResolved,
          onLaunchAiResolver: { aiResolverSheetPresented = true },
          onStopAiResolver: stopAiResolver
        )
        .prListRow()
      }
    }
    .listStyle(.plain)
    .listRowSpacing(12)
    .scrollContentBackground(.hidden)
    .background(prLiquidGlassBackdrop().ignoresSafeArea())
    .adeNavigationGlass()
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
    .task(id: syncService.localStateRevision) {
      await reload(includeLiveSidecars: shouldFetchPrDetailLiveSidecars(
        hasLoadedLiveSidecars: hasLoadedLiveSidecars,
        refreshRemote: false
      ))
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
        canAttemptBlockedMerge: canAttemptBlockedMerge,
        onMerge: {
          mergeMethodSheetPresented = false
          mergeCurrentPr()
        },
        onCancel: {
          mergeMethodSheetPresented = false
        }
      )
      .presentationDetents([.height(520)])
      .presentationDragIndicator(.hidden)
      .presentationBackground(.clear)
    }
    .sheet(item: $stackPresentation) { presentation in
      PrStackSheet(groupId: presentation.id, groupName: presentation.groupName)
        .environmentObject(syncService)
    }
    .sheet(isPresented: $aiResolverSheetPresented) {
      PrAiResolverSheet(
        prNumber: currentPr.githubPrNumber,
        isBusy: isAiResolverBusy,
        isRunning: aiResolverRunning,
        lastError: aiResolution?.lastError
      ) { model, reasoningEffort in
        startAiResolver(model: model, reasoningEffort: reasoningEffort)
      } onStop: {
        stopAiResolver()
      }
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
            try await syncService.updatePullRequestTitle(prId: prId, title: value)
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
            try await syncService.updatePullRequestBody(prId: prId, body: value)
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
            try await syncService.setPullRequestLabels(prId: prId, labels: labels)
          } onSuccess: {
            editorSheet = nil
          }
        }
      case .review:
        PrSubmitReviewSheet { event, body in
          runPrAction("Submitting review") {
            try await syncService.submitPullRequestReview(prId: prId, event: event.rawValue, body: body)
          } onSuccess: {
            editorSheet = nil
          }
        }
      }
    }
  }

  private var detailNavigationHeader: some View {
    HStack(spacing: 10) {
      Button {
        dismiss()
      } label: {
        Image(systemName: "chevron.left")
          .font(.system(size: 17, weight: .semibold))
          .frame(width: 38, height: 38)
      }
      .buttonStyle(.glass)
      .accessibilityLabel("Back to PRs")

      VStack(alignment: .leading, spacing: 2) {
        Text("#\(currentPr.githubPrNumber)")
          .font(.system(size: 11, weight: .bold, design: .monospaced))
          .foregroundStyle(prStateTint(currentPr.state))
        Text(currentPr.title)
          .font(.headline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.tail)
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel("Pull request \(currentPr.githubPrNumber), \(currentPr.title)")

      Spacer(minLength: 0)

      Button {
        actionsSheetPresented = true
      } label: {
        Image(systemName: "ellipsis.circle")
          .font(.system(size: 17, weight: .semibold))
          .frame(width: 38, height: 38)
      }
      .buttonStyle(.glass)
      .accessibilityLabel("Pull request actions")
    }
    .padding(.horizontal, 16)
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
      onRefresh: {
        actionsSheetPresented = false
        Task { await reload(refreshRemote: true) }
      }
    )
  }

  // MARK: - Hero

  private var heroCard: some View {
    let state = snapshot?.status?.state ?? currentPr.state
    let stateTint = prStateTint(state)
    let author = snapshot?.detail?.author.login ?? githubItem?.author ?? "unknown"
    let baseLabel = currentPr.baseBranch.isEmpty ? "base" : currentPr.baseBranch
    let headLabel = currentPr.headBranch.isEmpty ? "head" : currentPr.headBranch

    return HStack(alignment: .top, spacing: 12) {
      // 44pt state tile on the left
      ZStack {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .fill(
            LinearGradient(
              colors: [stateTint.opacity(0.38), stateTint.opacity(0.14)],
              startPoint: .topLeading,
              endPoint: .bottomTrailing
            )
          )
        RoundedRectangle(cornerRadius: 12, style: .continuous)
          .strokeBorder(stateTint.opacity(0.48), lineWidth: 0.75)
        Image(systemName: "arrow.triangle.pull")
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(stateTint)
          .shadow(color: stateTint.opacity(0.55), radius: 6)
      }
      .frame(width: 44, height: 44)
      .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-status-\(currentPr.id)", in: transitionNamespace)

      VStack(alignment: .leading, spacing: 6) {
        HStack(spacing: 6) {
          Text("#\(currentPr.githubPrNumber)")
            .font(.system(size: 11, weight: .bold, design: .monospaced))
            .foregroundStyle(stateTint)
          PrTagChip(label: state, color: stateTint)
          if let kindLabel = prAdeKindLabel(currentPr.adeKind) {
            PrTagChip(label: kindLabel, color: ADEColor.tintPRs)
          }
          Spacer(minLength: 0)
        }

        Text(currentPr.title)
          .font(.system(size: 15, weight: .semibold))
          .tracking(-0.2)
          .foregroundStyle(ADEColor.textPrimary)
          .lineSpacing(1)
          .lineLimit(3)
          .fixedSize(horizontal: false, vertical: true)
          .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-title-\(currentPr.id)", in: transitionNamespace)

        // Single mono meta line: branch → base · opened … by @author
        (
          Text(headLabel)
            .foregroundColor(ADEColor.textSecondary)
          + Text(" → ")
            .foregroundColor(ADEColor.textMuted)
          + Text(baseLabel)
            .foregroundColor(ADEColor.textSecondary)
          + Text("  ·  opened \(prRelativeTime(currentPr.createdAt)) by @\(author)")
            .foregroundColor(ADEColor.textMuted)
        )
        .font(.system(size: 11, design: .monospaced))
        .lineLimit(1)
        .truncationMode(.middle)
      }

      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 14)
    .padding(.vertical, 14)
    .prGlassCard(cornerRadius: 20, tint: stateTint.opacity(0.42))
    .padding(.horizontal, 2)
    .shadow(color: stateTint.opacity(0.14), radius: 18, y: 8)
  }

  // MARK: - Sub-tab picker

  /// Compact tab labels used in the inactive state where we have less room.
  /// Active tab gets the full label so the user always knows where they are.
  private func compactTabTitle(_ tab: PrDetailTab) -> String {
    switch tab {
    case .convergence: return "Path"
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
                ZStack {
                  RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(.ultraThinMaterial)
                  RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color.white.opacity(0.06))
                  RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(
                      LinearGradient(
                        colors: [Color.white.opacity(0.10), Color.white.opacity(0.0)],
                        startPoint: .top,
                        endPoint: .bottom
                      )
                    )
                  RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.14), lineWidth: 0.6)
                }
                .shadow(color: Color.black.opacity(0.35), radius: 8, y: 3)
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
      ZStack {
        RoundedRectangle(cornerRadius: 13, style: .continuous)
          .fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: 13, style: .continuous)
          .fill(Color.black.opacity(0.22))
      }
    )
    .overlay(
      RoundedRectangle(cornerRadius: 13, style: .continuous)
        .strokeBorder(Color.white.opacity(0.07), lineWidth: 0.5)
    )
    .padding(.horizontal, 2)
    .padding(.top, 2)
  }

  // MARK: - Sticky action bar

  private var stickyActionBar: some View {
    let gate = mergeGateInfo
    let needsRebase = gate.tone == .amber || behindBaseBy > 0

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
      enabled = canRunPrActions && (capabilities?.canMerge ?? actionAvailability.mergeEnabled)
      action = { presentMergeMethodPicker() }
    case .amber:
      label = needsRebase ? (behindBaseBy > 0 ? "Rebase · \(behindBaseBy) behind" : "Rebase") : "Needs rebase"
      symbol = "arrow.triangle.2.circlepath"
      isPrimary = false
      isAmber = true
      enabled = canRunPrActions && !currentPr.laneId.isEmpty
      action = { triggerRebase() }
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
          Image(systemName: symbol)
            .font(.system(size: 14, weight: .bold))
          Text(label)
            .font(.system(size: 15, weight: .bold))
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
        }
        .foregroundStyle(isPrimary ? Color.white : (isAmber ? ADEColor.warning : ADEColor.danger))
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background {
          if isPrimary {
            ZStack {
              RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(
                  LinearGradient(
                    colors: [ADEColor.success, ADEColor.success.opacity(0.82)],
                    startPoint: .top,
                    endPoint: .bottom
                  )
                )
              RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(
                  LinearGradient(
                    colors: [Color.white.opacity(0.22), Color.white.opacity(0.0)],
                    startPoint: .top,
                    endPoint: .bottom
                  )
                )
            }
          } else {
            ZStack {
              RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(.ultraThinMaterial)
              RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill((isAmber ? ADEColor.warning : ADEColor.danger).opacity(0.14))
            }
          }
        }
        .overlay(
          RoundedRectangle(cornerRadius: 16, style: .continuous)
            .strokeBorder(
              isPrimary ? Color.white.opacity(0.32) : (isAmber ? ADEColor.warning.opacity(0.45) : ADEColor.danger.opacity(0.45)),
              lineWidth: 0.75
            )
        )
        .shadow(
          color: isPrimary ? ADEColor.success.opacity(0.45) : .clear,
          radius: 18,
          y: 6
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

  @MainActor
  private func reload(refreshRemote: Bool = false, includeLiveSidecars: Bool? = nil) async {
    let shouldFetchLiveSidecars = isLive && (includeLiveSidecars ?? refreshRemote)
    let capabilitiesTask: Task<PrActionCapabilities?, Never>? = shouldFetchLiveSidecars
      ? Task {
          do {
            let mobileSnapshot = try await syncService.fetchPrMobileSnapshot()
            return mobileSnapshot.capabilities[prId]
          } catch {
            return nil
          }
        }
      : nil

    do {
      var refreshError: Error?
      if refreshRemote {
        do {
          try await syncService.refreshPullRequestSnapshots(prId: prId)
        } catch {
          refreshError = error
        }
      }
      async let listItemsTask = syncService.fetchPullRequestListItems()
      async let snapshotTask = syncService.fetchPullRequestSnapshot(prId: prId)
      let reviewThreadsTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchPullRequestReviewThreads(prId: prId) } : nil
      let actionRunsTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchPullRequestActionRuns(prId: prId) } : nil
      let activityTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchPullRequestActivity(prId: prId) } : nil
      let deploymentsTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchPullRequestDeployments(prId: prId) } : nil
      let aiSummaryTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchPullRequestAiSummary(prId: prId) } : nil
      let issueInventoryTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchIssueInventory(prId: prId) } : nil
      let pipelineSettingsTask = shouldFetchLiveSidecars ? Task { try? await syncService.fetchPipelineSettings(prId: prId) } : nil

      let listItems = try await listItemsTask
      pr = listItems.first(where: { $0.id == prId })
      snapshot = try await snapshotTask

      // Fall back to the repo-scoped GitHub snapshot when the PR isn't in the
      // lane-PR list. This keeps the hero card from collapsing into
      // "Pull request / @unknown" placeholders without resurrecting legacy
      // cross-repo snapshot items.
      if pr == nil && shouldFetchLiveSidecars {
        if let github = try? await syncService.fetchGitHubPullRequestSnapshot() {
          githubItem = repoScopedGitHubPullRequests(from: github)
            .first { $0.linkedPrId == prId || $0.id == prId }
        }
      }
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
      if let inventory = await issueInventoryTask?.value {
        issueInventory = inventory
      }
      if let settings = await pipelineSettingsTask?.value {
        pipelineSettings = settings
      }
      if let groupId = pr?.linkedGroupId {
        groupMembers = try await syncService.fetchPullRequestGroupMembers(groupId: groupId)
      } else {
        groupMembers = []
      }
      errorMessage = refreshError?.localizedDescription
    } catch {
      errorMessage = error.localizedDescription
    }

    if shouldFetchLiveSidecars {
      hasLoadedLiveSidecars = true
    }
    if let capabilitiesTask {
      capabilities = await capabilitiesTask.value
    }
  }

  @MainActor
  private func runPrAction(_ label: String, action: @escaping () async throws -> Void, onSuccess: @escaping @MainActor () -> Void = {}) {
    Task { @MainActor in
      busyAction = label
      errorMessage = nil
      actionMessage = nil
      do {
        try await action()
        onSuccess()
        await reload(refreshRemote: true)
        actionMessage = "\(label) finished."
      } catch {
        let message = error.localizedDescription
        await reload(refreshRemote: false)
        errorMessage = message
      }
      busyAction = nil
    }
  }

  private func mergeCurrentPr() {
    runPrAction("Merging pull request") { try await syncService.mergePullRequest(prId: prId, method: mergeMethod.rawValue) }
  }

  private func closeCurrentPr() {
    runPrAction("Closing pull request") { try await syncService.closePullRequest(prId: prId) }
  }

  private func reopenCurrentPr() {
    runPrAction("Reopening pull request") { try await syncService.reopenPullRequest(prId: prId) }
  }

  private func requestReviewers() {
    let reviewers = reviewerInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }

    guard !reviewers.isEmpty else { return }

    runPrAction(
      "Requesting reviewers",
      action: { try await syncService.requestReviewers(prId: prId, reviewers: reviewers) },
      onSuccess: { reviewerInput = "" }
    )
  }

  private func rerunChecks() {
    runPrAction("Re-running checks") { try await syncService.rerunPullRequestChecks(prId: prId) }
  }

  private var aiResolverRunning: Bool {
    let status = aiResolution?.status?.lowercased() ?? ""
    return status == "running" || status == "starting" || status == "pending"
  }

  private func startAiResolver(model: String?, reasoningEffort: String?) {
    guard !isAiResolverBusy else { return }
    Task { @MainActor in
      isAiResolverBusy = true
      defer { isAiResolverBusy = false }
      do {
        let state = try await syncService.startPrAiResolution(
          prId: prId,
          model: model,
          reasoningEffort: reasoningEffort
        )
        aiResolution = state
        aiResolverSheetPresented = false
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  private func stopAiResolver() {
    guard !isAiResolverBusy else { return }
    Task { @MainActor in
      isAiResolverBusy = true
      defer { isAiResolverBusy = false }
      do {
        try await syncService.stopPrAiResolution(prId: prId)
        if let current = aiResolution {
          aiResolution = AiResolutionState(
            prId: current.prId,
            status: "stopped",
            sessionId: current.sessionId,
            model: current.model,
            reasoningEffort: current.reasoningEffort,
            startedAt: current.startedAt,
            updatedAt: current.updatedAt,
            lastError: current.lastError
          )
        }
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  /// Kick the desktop's Path-to-Merge convergence loop on this PR. The host
  /// returns the updated runtime row, which we splice into the local issue
  /// inventory snapshot so the convergence panel reflects the new state
  /// without waiting for the next sync push.
  private func startPathToMerge() {
    guard !isPathToMergeBusy else { return }
    Task { @MainActor in
      isPathToMergeBusy = true
      defer { isPathToMergeBusy = false }
      do {
        let result = try await syncService.startPathToMerge(prId: prId)
        applyConvergenceRuntime(result.runtime)
        if !result.scheduled {
          errorMessage = result.blockedBy?.message ?? "Path to Merge is blocked by another lane task."
          return
        }
        actionMessage = "Path to Merge started."
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  /// Stop the convergence loop. Mirrors {@link startPathToMerge} but updates
  /// the runtime to the host-returned snapshot (when present) so the UI
  /// reflects the canonical post-stop state, including any pause reason.
  private func stopPathToMerge() {
    guard !isPathToMergeBusy else { return }
    Task { @MainActor in
      isPathToMergeBusy = true
      defer { isPathToMergeBusy = false }
      do {
        let result = try await syncService.stopPathToMerge(prId: prId, reason: "Stopped from iOS.")
        if let runtime = result.runtime {
          applyConvergenceRuntime(runtime)
        }
        actionMessage = "Path to Merge stopped."
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  /// Replace the runtime row inside `issueInventory` (if any) with `next`.
  /// Used by the start/stop handlers so the mode toggle flips immediately.
  private func applyConvergenceRuntime(_ next: ConvergenceRuntimeState) {
    guard let current = issueInventory else { return }
    issueInventory = IssueInventorySnapshot(
      prId: current.prId,
      items: current.items,
      convergence: current.convergence,
      runtime: next
    )
  }

  private func refreshAiSummary() {
    Task { @MainActor in
      guard canRunPrActions else { return }
      isAiSummaryLoading = true
      defer { isAiSummaryLoading = false }
      do {
        let summary = try await syncService.fetchPullRequestAiSummary(prId: prId)
        aiSummary = summary
      } catch {
        errorMessage = error.localizedDescription
      }
    }
  }

  private func syncIssueInventory() {
    runPrAction("Syncing issue inventory") {
      let inventory = try await syncService.syncIssueInventory(prId: prId)
      await MainActor.run {
        issueInventory = inventory
      }
    }
  }

  private enum IssueInventoryAction {
    case fixed
    case dismissed
    case escalated
  }

  private func markIssueInventory(itemId: String, action: IssueInventoryAction) {
    let label: String
    switch action {
    case .fixed: label = "Marking issue fixed"
    case .dismissed: label = "Dismissing issue"
    case .escalated: label = "Escalating issue"
    }
    runPrAction(label) {
      switch action {
      case .fixed:
        try await syncService.markIssueInventoryFixed(prId: prId, itemIds: [itemId])
      case .dismissed:
        try await syncService.markIssueInventoryDismissed(prId: prId, itemIds: [itemId], reason: "Dismissed from iOS")
      case .escalated:
        try await syncService.markIssueInventoryEscalated(prId: prId, itemIds: [itemId])
      }
    }
  }

  private func resetIssueInventory() {
    runPrAction("Resetting issue inventory") {
      try await syncService.resetIssueInventory(prId: prId)
      await MainActor.run {
        issueInventory = nil
      }
    }
  }

  private func defaultPipelineSettings() -> PipelineSettings {
    PipelineSettings(
      autoMerge: false,
      mergeMethod: "repo_default",
      maxRounds: 5,
      onRebaseNeeded: "pause",
      conflictStrategy: "pause",
      forceFinalizeMode: "off",
      forceFinalizeRequireNoCiFailures: true,
      atCapPolicy: "ci_retry_once",
      atCapWaitMinutes: 30,
      atCapCiRetryMax: 3,
      forceMergeRequiresConfirmation: true,
      earlyMergeOnGreen: true
    )
  }

  private func updatePipelineSettings(_ label: String, mutate: @escaping (inout PipelineSettings) -> Void) {
    runPrAction(label) {
      var next: PipelineSettings
      if let current = pipelineSettings {
        next = current
      } else if let fetched = try? await syncService.fetchPipelineSettings(prId: prId) {
        next = fetched
      } else {
        next = defaultPipelineSettings()
      }
      mutate(&next)
      try await syncService.savePipelineSettings(prId: prId, settings: next)
      let settings = try await syncService.fetchPipelineSettings(prId: prId)
      await MainActor.run {
        pipelineSettings = settings
      }
    }
  }

  private func toggleAutoMerge() {
    let next = !(pipelineSettings?.autoMerge ?? false)
    updatePipelineSettings(next ? "Enabling auto-merge" : "Disabling auto-merge") { settings in
      settings.autoMerge = next
    }
  }

  private func setPipelineMergeMethod(_ method: String) {
    updatePipelineSettings("Updating merge method") { settings in
      settings.mergeMethod = method
    }
  }

  private func setPipelineMaxRounds(_ maxRounds: Int) {
    updatePipelineSettings("Updating max rounds") { settings in
      settings.maxRounds = maxRounds
    }
  }

  private func setPipelineRebasePolicy(_ policy: String) {
    updatePipelineSettings("Updating rebase policy") { settings in
      settings.onRebaseNeeded = policy
      settings.conflictStrategy = policy == "auto_rebase" ? "rebase" : "pause"
    }
  }

  private func setPipelineConflictStrategy(_ strategy: String) {
    updatePipelineSettings("Updating conflict strategy") { settings in
      settings.conflictStrategy = strategy
      settings.onRebaseNeeded = strategy == "rebase" ? "auto_rebase" : "pause"
    }
  }

  private func setPipelineAtCapPolicy(_ policy: String) {
    updatePipelineSettings("Updating at-cap policy") { settings in
      settings.atCapPolicy = policy
      if policy == "force_merge" {
        settings.forceFinalizeMode = "force_merge"
      } else if settings.forceFinalizeMode == "force_merge" {
        settings.forceFinalizeMode = "off"
      }
    }
  }

  private func setPipelineAtCapWaitMinutes(_ minutes: Int) {
    updatePipelineSettings("Updating at-cap wait") { settings in
      settings.atCapWaitMinutes = max(1, min(180, minutes))
    }
  }

  private func setPipelineAtCapCiRetryMax(_ maxRetries: Int) {
    updatePipelineSettings("Updating CI retry max") { settings in
      settings.atCapCiRetryMax = max(1, min(10, maxRetries))
    }
  }

  private func setPipelineForceMergeRequiresConfirmation(_ requiresConfirmation: Bool) {
    updatePipelineSettings("Updating force-merge confirmation") { settings in
      settings.forceMergeRequiresConfirmation = requiresConfirmation
    }
  }

  private func setPipelineForceFinalizeRequireNoCiFailures(_ requiresCleanCi: Bool) {
    updatePipelineSettings("Updating force-merge CI guard") { settings in
      settings.forceFinalizeRequireNoCiFailures = requiresCleanCi
    }
  }

  private func setPipelineEarlyMergeOnGreen(_ enabled: Bool) {
    updatePipelineSettings("Updating early merge") { settings in
      settings.earlyMergeOnGreen = enabled
    }
  }

  private func submitComment() {
    let trimmed = commentInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    runPrAction(
      "Posting comment",
      action: { try await syncService.addPullRequestComment(prId: prId, body: trimmed) },
      onSuccess: { commentInput = "" }
    )
  }

  private func replyToThread(threadId: String, body: String) {
    let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    runPrAction("Replying to review thread") {
      try await syncService.replyToPullRequestReviewThread(prId: prId, threadId: threadId, body: trimmed)
    }
  }

  private func setThreadResolved(threadId: String, resolved: Bool) {
    runPrAction(resolved ? "Resolving review thread" : "Reopening review thread") {
      try await syncService.setPullRequestReviewThreadResolved(prId: prId, threadId: threadId, resolved: resolved)
    }
  }

  private func performCleanup() async {
    guard let laneId = pr?.laneId, !laneId.isEmpty else { return }
    busyAction = cleanupChoice == .archive ? "Archiving lane" : "Deleting lane and branch"
    errorMessage = nil
    actionMessage = nil
    do {
      switch cleanupChoice {
      case .archive:
        try await syncService.archiveLane(laneId)
      case .deleteBranch:
        try await syncService.deleteLane(laneId, deleteBranch: true, deleteRemoteBranch: true)
      }
      actionMessage = cleanupChoice == .archive ? "Lane archived." : "Lane and branch cleanup requested."
    } catch {
      errorMessage = error.localizedDescription
    }
    await reload(refreshRemote: true)
    busyAction = nil
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

  /// Builds a markdown-style prompt summarising unresolved PR feedback
  /// and failing checks, then copies it to the system clipboard. Mirrors the
  /// "Copy Prompt" affordance on the desktop Path-to-Merge view — the user can
  /// paste this into Claude/Codex/etc to bootstrap a fix session.
  private func copyConvergencePrompt() {
    var lines: [String] = []
    let pr = currentPr
    lines.append("# PR #\(pr.githubPrNumber) — \(pr.title)")
    if !pr.headBranch.isEmpty || !pr.baseBranch.isEmpty {
      let head = pr.headBranch.isEmpty ? "head" : pr.headBranch
      let base = pr.baseBranch.isEmpty ? "base" : pr.baseBranch
      lines.append("Branch: `\(head)` → `\(base)`")
    }
    if !pr.githubUrl.isEmpty { lines.append(pr.githubUrl) }

    let active = (issueInventory?.items ?? []).filter {
      $0.state == "new" || $0.state == "sent_to_agent" || $0.state == "escalated"
    }
    if !active.isEmpty {
      lines.append("")
      lines.append("## Unresolved PR feedback (\(active.count))")
      for item in active {
        let severity = (item.severity ?? "note").uppercased()
        var location = ""
        if let path = item.filePath, !path.isEmpty {
          location = item.line.map { " — `\(path):\($0)`" } ?? " — `\(path)`"
        }
        lines.append("- **[\(severity)]** \(item.headline)\(location)")
        if let body = item.body, !body.isEmpty {
          let trimmed = body.trimmingCharacters(in: .whitespacesAndNewlines).prefix(280)
          lines.append("  > \(trimmed)")
        }
      }
    }

    let failed = (snapshot?.checks ?? []).filter { check in
      check.status == "completed" && check.conclusion != nil &&
        check.conclusion != "success" && check.conclusion != "neutral" && check.conclusion != "skipped"
    }
    if !failed.isEmpty {
      lines.append("")
      lines.append("## Failing checks (\(failed.count))")
      for check in failed {
        let context = check.conclusion ?? check.status
        lines.append("- `\(check.name)` — \(context)")
      }
    }

    lines.append("")
    lines.append("Resolve these issues, push fixes to `\(pr.headBranch.isEmpty ? "this branch" : pr.headBranch)`, and bring the PR to a green merge gate.")

    UIPasteboard.general.string = lines.joined(separator: "\n")
    ADEHaptics.success()
    actionMessage = "Convergence prompt copied to clipboard."
  }

  private func copyFilePath(_ file: PrFile) {
    UIPasteboard.general.string = file.filename
    actionMessage = "Copied \(file.filename)."
    errorMessage = nil
  }
}

// MARK: - Liquid-glass backdrop

@ViewBuilder
func prLiquidGlassBackdrop() -> some View {
  ZStack {
    PrGlassPalette.ink

    RadialGradient(
      colors: [PrGlassPalette.purple.opacity(0.35), .clear],
      center: .init(x: 0.15, y: 0.12),
      startRadius: 8,
      endRadius: 520
    )
    .blendMode(.plusLighter)

    RadialGradient(
      colors: [PrGlassPalette.blue.opacity(0.28), .clear],
      center: .init(x: 0.95, y: 0.18),
      startRadius: 10,
      endRadius: 460
    )
    .blendMode(.plusLighter)

    RadialGradient(
      colors: [PrGlassPalette.pink.opacity(0.22), .clear],
      center: .init(x: 0.55, y: 1.05),
      startRadius: 10,
      endRadius: 580
    )
    .blendMode(.plusLighter)

    LinearGradient(
      colors: [Color.black.opacity(0.0), Color.black.opacity(0.35)],
      startPoint: .top,
      endPoint: .bottom
    )
  }
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
  let onDismiss: () -> Void
  let onEditTitle: () -> Void
  let onEditDescription: () -> Void
  let onSetLabels: () -> Void
  let onSubmitReview: () -> Void
  let onClose: () -> Void
  let onReopen: () -> Void
  let onOpenGitHub: () -> Void
  let onCopyUrl: () -> Void
  let onRefresh: () -> Void

  var body: some View {
    ZStack {
      prLiquidGlassBackdrop().ignoresSafeArea()

      VStack(spacing: 0) {
        Capsule(style: .continuous)
          .fill(Color.white.opacity(0.25))
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
            .foregroundStyle(Color(red: 0xF0 / 255, green: 0xF0 / 255, blue: 0xF2 / 255))
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
                .foregroundStyle(Color(red: 0x5E / 255, green: 0x5A / 255, blue: 0x70 / 255))
                .padding(.horizontal, 14)
                .padding(.vertical, 12)
                .allowsHitTesting(false)
            }
            TextEditor(text: $reviewBody)
              .scrollContentBackground(.hidden)
              .focused($bodyFocused)
              .font(.system(size: 14))
              .foregroundStyle(Color(red: 0xF0 / 255, green: 0xF0 / 255, blue: 0xF2 / 255))
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
          .foregroundStyle(Color(red: 0x5E / 255, green: 0x5A / 255, blue: 0x70 / 255))
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
          .fill(Color.white.opacity(0.25))
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
            .foregroundStyle(Color(red: 0xF0 / 255, green: 0xF0 / 255, blue: 0xF2 / 255))
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
        .foregroundStyle(isSelected ? Color.white : Color(red: 0xA8 / 255, green: 0xA8 / 255, blue: 0xB4 / 255))
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
private struct PrMergeStrategySheet: View {
  @Binding var selected: PrMergeMethodOption
  let canAttemptBlockedMerge: Bool
  let onMerge: () -> Void
  let onCancel: () -> Void

  var body: some View {
    ZStack(alignment: .bottom) {
      Color.black.opacity(0.55)
        .ignoresSafeArea()
        .onTapGesture(perform: onCancel)

      VStack(spacing: 0) {
        prLiquidGlassBackdrop()
          .opacity(0.0)
          .frame(height: 0)

        VStack(spacing: 14) {
          // Grab handle.
          Capsule(style: .continuous)
            .fill(Color.white.opacity(0.25))
            .frame(width: 36, height: 5)
            .padding(.top, 2)

          VStack(alignment: .leading, spacing: 4) {
            PrEyebrow(text: "Merge strategy", tint: PrGlassPalette.purple)
            Text(canAttemptBlockedMerge ? "Force-request merge" : "Pick how to merge")
              .font(.system(size: 17, weight: .semibold))
              .foregroundStyle(Color(red: 0xF0 / 255, green: 0xF0 / 255, blue: 0xF2 / 255))
              .tracking(-0.2)
            Text(canAttemptBlockedMerge
              ? "ADE sees merge blockers, but this will still ask GitHub to merge. GitHub may reject unless your account can bypass requirements."
              : "Machine rules may override your choice. All checks will be verified before merging.")
              .font(.system(size: 11))
              .foregroundStyle(Color(red: 0xA8 / 255, green: 0xA8 / 255, blue: 0xB4 / 255))
              .fixedSize(horizontal: false, vertical: true)
          }
          .frame(maxWidth: .infinity, alignment: .leading)

          VStack(spacing: 8) {
            ForEach(PrMergeMethodOption.allCases) { option in
              PrGlassRadioRow(
                title: option.title,
                subtitle: option.description,
                icon: iconFor(option),
                isSelected: selected == option
              ) {
                selected = option
              }
            }
          }

          HStack(spacing: 10) {
            Button(action: onCancel) {
              Text("Cancel")
            }
            .buttonStyle(PrDetailGlassOutlineButtonStyle())

            Button(action: onMerge) {
              Label(canAttemptBlockedMerge ? "Merge anyway" : "Merge", systemImage: "arrow.triangle.merge")
            }
            .buttonStyle(PrDetailGlassPrimaryButtonStyle(tint: canAttemptBlockedMerge ? PrGlassPalette.warning : PrGlassPalette.purpleDeep))
          }
          .padding(.top, 2)
        }
        .padding(.horizontal, 18)
        .padding(.top, 10)
        .padding(.bottom, 22)
        .frame(maxWidth: .infinity)
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
          // Ambient purple glow at top edge.
          LinearGradient(
            colors: [PrGlassPalette.purple.opacity(0.22), .clear],
            startPoint: .top,
            endPoint: .bottom
          )
          .frame(height: 80)
          .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
          .allowsHitTesting(false)
        }
        .shadow(color: Color.black.opacity(0.55), radius: 28, x: 0, y: 10)
        .padding(.horizontal, 12)
        .padding(.bottom, 12)
      }
    }
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
          .foregroundStyle(Color(red: 0xF0 / 255, green: 0xF0 / 255, blue: 0xF2 / 255))
          .tracking(-0.2)
          .multilineTextAlignment(.center)

        Text(message)
          .font(.system(size: 12))
          .foregroundStyle(Color(red: 0xA8 / 255, green: 0xA8 / 255, blue: 0xB4 / 255))
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
            .foregroundStyle(isSelected ? Color.white : Color(red: 0xA8 / 255, green: 0xA8 / 255, blue: 0xB4 / 255))
        }
        .frame(width: 32, height: 32)

        VStack(alignment: .leading, spacing: 2) {
          Text(title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Color(red: 0xF0 / 255, green: 0xF0 / 255, blue: 0xF2 / 255))
          Text(subtitle)
            .font(.system(size: 11))
            .foregroundStyle(Color(red: 0xA8 / 255, green: 0xA8 / 255, blue: 0xB4 / 255))
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
      .foregroundStyle(Color(red: 0xF0 / 255, green: 0xF0 / 255, blue: 0xF2 / 255))
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
