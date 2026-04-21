import SwiftUI
import UIKit

struct PrDetailView: View {
  @EnvironmentObject private var syncService: SyncService
  let prId: String
  let transitionNamespace: Namespace.ID?

  @State private var pr: PullRequestListItem?
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
    guard let status = snapshot?.status else { return false }
    let state = status.state.isEmpty ? currentPr.state : status.state
    return state == "open" && !status.isMergeable && !status.mergeConflicts
  }

  private var currentPr: PullRequestListItem {
    pr ?? PullRequestListItem(
      id: prId,
      laneId: "",
      laneName: nil,
      projectId: "",
      repoOwner: "",
      repoName: "",
      githubPrNumber: 0,
      githubUrl: "",
      title: "Pull request",
      state: snapshot?.status?.state ?? "open",
      baseBranch: "",
      headBranch: "",
      checksStatus: snapshot?.status?.checksStatus ?? "none",
      reviewStatus: snapshot?.status?.reviewStatus ?? "none",
      additions: 0,
      deletions: 0,
      lastSyncedAt: nil,
      createdAt: "",
      updatedAt: "",
      adeKind: nil,
      linkedGroupId: nil,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: nil,
      cleanupState: nil
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

  private var mergeGateInfo: PrMergeGateInfo {
    prComputeMergeGate(
      status: snapshot?.status,
      checks: snapshot?.checks ?? [],
      reviewThreadsUnresolved: unresolvedThreadCount,
      reviewsNeeded: reviewsNeeded,
      reviewsHave: reviewsHave,
      capabilities: capabilities
    )
  }

  private var behindBaseBy: Int {
    snapshot?.status?.behindBaseBy ?? 0
  }

  /// Set of sub-tabs shown in the detail picker.
  private var visibleTabs: [PrDetailTab] {
    [.overview, .checks, .activity, .files, .convergence]
  }

  private func tabTitle(_ tab: PrDetailTab) -> String {
    switch tab {
    case .overview: return "Overview"
    case .checks: return "Checks"
    case .activity: return "Reviews"
    case .files: return "Files"
    case .convergence: return "Path"
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

      if let errorMessage {
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
          onSetPipelineRebasePolicy: setPipelineRebasePolicy
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
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(currentPr.title)
    .navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .bottom) {
      stickyActionBar
    }
    .toolbar {
      ADERootToolbarLeadingItems()
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          Button {
            editorSheet = .title(currentPr.title)
          } label: {
            Label("Edit title", systemImage: "pencil")
          }
          .disabled(!canUpdateCurrentPrMetadata)
          Button {
            editorSheet = .body(snapshot?.detail?.body ?? "")
          } label: {
            Label("Edit description", systemImage: "text.alignleft")
          }
          .disabled(!canUpdateCurrentPrMetadata)
          Button {
            let labels = snapshot?.detail?.labels.map(\.name).joined(separator: ", ") ?? ""
            editorSheet = .labels(labels)
          } label: {
            Label("Set labels", systemImage: "tag")
          }
          .disabled(!canUpdateCurrentPrMetadata)
          Button {
            editorSheet = .review
          } label: {
            Label("Submit review", systemImage: "checkmark.seal")
          }
          .disabled(!canRunPrActions)
          if shouldShowCloseAction {
            Button(role: .destructive, action: closeCurrentPr) {
              Label("Close PR", systemImage: "xmark.circle")
            }
            .disabled(!canCloseCurrentPr)
          }
          if shouldShowReopenAction {
            Button(action: reopenCurrentPr) {
              Label("Reopen PR", systemImage: "arrow.counterclockwise")
            }
            .disabled(!canReopenCurrentPr)
          }
          Button(action: { openGitHub(urlString: currentPr.githubUrl) }) {
            Label("Open in GitHub", systemImage: "arrow.up.right.square")
          }
          .disabled(!canOpenCurrentPrInGitHub)
          Button {
            UIPasteboard.general.string = currentPr.githubUrl
            ADEHaptics.success()
            actionMessage = "URL copied."
          } label: {
            Label("Copy URL", systemImage: "doc.on.doc")
          }
          .disabled(currentPr.githubUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
          Button {
            Task { await reload(refreshRemote: true) }
          } label: {
            Label("Refresh", systemImage: "arrow.clockwise")
          }
        } label: {
          Label("Pull request actions", systemImage: "ellipsis.circle")
            .labelStyle(.iconOnly)
        }
      }
    }
    .refreshable {
      await reload(refreshRemote: true)
    }
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : "pr-container-\(prId)", in: transitionNamespace)
    .task(id: syncService.localStateRevision) {
      await reload()
    }
    .alert(cleanupChoice == .archive ? "Archive lane?" : "Delete lane and branch?", isPresented: $cleanupConfirmationPresented) {
      Button(cleanupChoice == .archive ? "Archive" : "Delete", role: cleanupChoice == .archive ? nil : .destructive) {
        Task { await performCleanup() }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(cleanupChoice == .archive
        ? "This keeps the lane for history but removes it from the active stack."
        : "This removes the lane from ADE and asks the host to delete the branch as part of cleanup.")
    }
    .confirmationDialog(
      "Merge strategy",
      isPresented: $mergeMethodSheetPresented,
      titleVisibility: .visible
    ) {
      ForEach(PrMergeMethodOption.allCases) { option in
        Button(option.title) {
          mergeMethod = option
          mergeCurrentPr()
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text(canAttemptBlockedMerge
        ? "ADE sees merge blockers, but this will still ask GitHub to merge. GitHub may reject the request unless your account can bypass the current requirements."
        : "Pick how this PR should be merged. Host rules may override your choice.")
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

  // MARK: - Hero

  private var heroCard: some View {
    let state = snapshot?.status?.state ?? currentPr.state
    let stateTint = prStateTint(state)
    let author = snapshot?.detail?.author.login ?? "unknown"
    let metaPrefix = currentPr.headBranch.isEmpty
      ? "unknown"
      : "\(currentPr.headBranch) → \(currentPr.baseBranch.isEmpty ? "base" : currentPr.baseBranch)"

    return VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Text("#\(currentPr.githubPrNumber)")
          .font(.system(size: 12, weight: .bold, design: .monospaced))
          .foregroundStyle(stateTint)
          .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-status-\(currentPr.id)", in: transitionNamespace)
        PrTagChip(label: state, color: stateTint)
        if let kindLabel = prAdeKindLabel(currentPr.adeKind) {
          PrTagChip(label: kindLabel, color: ADEColor.tintPRs)
        }
        Spacer(minLength: 0)
      }

      Text(currentPr.title)
        .font(.system(size: 22, weight: .semibold))
        .tracking(-0.5)
        .foregroundStyle(ADEColor.textPrimary)
        .lineSpacing(1)
        .fixedSize(horizontal: false, vertical: true)
        .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "pr-title-\(currentPr.id)", in: transitionNamespace)

      Text("\(metaPrefix) · opened \(prRelativeTime(currentPr.createdAt)) by \(author)")
        .font(.system(size: 11, design: .monospaced))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(2)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 18)
    .padding(.vertical, 10)
  }

  // MARK: - Sub-tab picker

  private var subTabPicker: some View {
    HStack(spacing: 2) {
      ForEach(visibleTabs) { tab in
        let active = selectedTab == tab
        Button {
          selectedTab = tab
        } label: {
          Text(tabTitle(tab))
            .font(.system(size: 12.5, weight: active ? .semibold : .medium))
            .foregroundStyle(active ? ADEColor.tintPRs : ADEColor.textSecondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(
              RoundedRectangle(cornerRadius: 9, style: .continuous)
                .fill(active ? ADEColor.tintPRs.opacity(0.14) : Color.clear)
            )
            .overlay(
              RoundedRectangle(cornerRadius: 9, style: .continuous)
                .strokeBorder(active ? ADEColor.tintPRs.opacity(0.3) : Color.clear, lineWidth: 0.5)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
    }
    .padding(3)
    .background(
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .fill(ADEColor.recessedBackground.opacity(0.7))
    )
    .overlay(
      RoundedRectangle(cornerRadius: 11, style: .continuous)
        .strokeBorder(ADEColor.glassBorder, lineWidth: 0.5)
    )
    .padding(.horizontal, 16)
    .padding(.top, 2)
  }

  // MARK: - Sticky action bar

  private var stickyActionBar: some View {
    let gate = mergeGateInfo
    let needsRebase = gate.tone == .amber || behindBaseBy > 0
    let rebaseLabel = behindBaseBy > 0 ? "Rebase · \(behindBaseBy) behind" : "Rebase"

    let mergeLabel: String
    let mergeTint: Color
    let mergeEnabled: Bool
    switch gate.tone {
    case .green:
      mergeLabel = "Merge"
      mergeTint = ADEColor.success
      mergeEnabled = canRunPrActions && (capabilities?.canMerge ?? actionAvailability.mergeEnabled)
    case .red where canAttemptBlockedMerge:
      mergeLabel = "Attempt merge"
      mergeTint = ADEColor.warning
      mergeEnabled = true
    case .amber:
      mergeLabel = "Needs rebase"
      mergeTint = ADEColor.warning
      mergeEnabled = false
    case .red:
      mergeLabel = "Merge blocked"
      mergeTint = ADEColor.danger
      mergeEnabled = false
    }

    return PrStickyActionBar {
      Button(action: triggerRebase) {
        Text(rebaseLabel)
          .font(.system(size: 12.5, weight: .semibold))
          .foregroundStyle(needsRebase ? ADEColor.textPrimary : ADEColor.textSecondary)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
          .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(Color.white.opacity(needsRebase ? 0.06 : 0.03))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .strokeBorder(Color.white.opacity(needsRebase ? 0.12 : 0.05), lineWidth: 0.5)
          )
      }
      .buttonStyle(.plain)
      .disabled(!needsRebase || !canRunPrActions || currentPr.laneId.isEmpty)

      Button {
        if mergeEnabled {
          ADEHaptics.success()
          presentMergeMethodPicker()
        }
      } label: {
        Text(mergeLabel)
          .font(.system(size: 12.5, weight: .bold))
          .foregroundStyle(mergeTint)
          .frame(maxWidth: .infinity)
          .padding(.vertical, 12)
          .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .fill(mergeTint.opacity(0.14))
          )
          .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
              .strokeBorder(mergeTint.opacity(0.32), lineWidth: 0.5)
          )
      }
      .buttonStyle(.plain)
      .disabled(!mergeEnabled)
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

  // MARK: - Data loading (unchanged)

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    let capabilitiesTask: Task<PrActionCapabilities?, Never>? = isLive
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
      let reviewThreadsTask = isLive ? Task { try? await syncService.fetchPullRequestReviewThreads(prId: prId) } : nil
      let actionRunsTask = isLive ? Task { try? await syncService.fetchPullRequestActionRuns(prId: prId) } : nil
      let activityTask = isLive ? Task { try? await syncService.fetchPullRequestActivity(prId: prId) } : nil
      let deploymentsTask = isLive ? Task { try? await syncService.fetchPullRequestDeployments(prId: prId) } : nil
      let aiSummaryTask = isLive ? Task { try? await syncService.fetchPullRequestAiSummary(prId: prId) } : nil
      let issueInventoryTask = isLive ? Task { try? await syncService.fetchIssueInventory(prId: prId) } : nil
      let pipelineSettingsTask = isLive ? Task { try? await syncService.fetchPipelineSettings(prId: prId) } : nil

      let listItems = try await listItemsTask
      pr = listItems.first(where: { $0.id == prId })
      snapshot = try await snapshotTask
      reviewThreads = await reviewThreadsTask?.value ?? []
      actionRuns = await actionRunsTask?.value ?? []
      activityEvents = await activityTask?.value ?? []
      deployments = await deploymentsTask?.value ?? []
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

    capabilities = await capabilitiesTask?.value
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

  private func toggleAutoMerge() {
    let next = !(pipelineSettings?.autoMerge ?? false)
    runPrAction(next ? "Enabling auto-merge" : "Disabling auto-merge") {
      try await syncService.savePipelineSettings(prId: prId, autoMerge: next)
      let settings = try await syncService.fetchPipelineSettings(prId: prId)
      await MainActor.run {
        pipelineSettings = settings
      }
    }
  }

  private func setPipelineMergeMethod(_ method: String) {
    runPrAction("Updating merge method") {
      try await syncService.savePipelineSettings(prId: prId, mergeMethod: method)
      let settings = try await syncService.fetchPipelineSettings(prId: prId)
      await MainActor.run {
        pipelineSettings = settings
      }
    }
  }

  private func setPipelineMaxRounds(_ maxRounds: Int) {
    runPrAction("Updating max rounds") {
      try await syncService.savePipelineSettings(prId: prId, maxRounds: maxRounds)
      let settings = try await syncService.fetchPipelineSettings(prId: prId)
      await MainActor.run {
        pipelineSettings = settings
      }
    }
  }

  private func setPipelineRebasePolicy(_ policy: String) {
    runPrAction("Updating rebase policy") {
      try await syncService.savePipelineSettings(prId: prId, onRebaseNeeded: policy)
      let settings = try await syncService.fetchPipelineSettings(prId: prId)
      await MainActor.run {
        pipelineSettings = settings
      }
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

  private func copyFilePath(_ file: PrFile) {
    UIPasteboard.general.string = file.filename
    actionMessage = "Copied \(file.filename)."
    errorMessage = nil
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

  var body: some View {
    NavigationStack {
      Form {
        Section("Review") {
          Picker("Decision", selection: $event) {
            ForEach(PrReviewEventOption.allCases) { option in
              Text(option.title).tag(option)
            }
          }
          TextEditor(text: $reviewBody)
            .frame(minHeight: 180)
        }

        Section {
          Text("Approvals can be submitted without a note. Requested changes and comments should include enough context for the author to act.")
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
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
          .disabled(event != .approve && reviewBody.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
  }
}
