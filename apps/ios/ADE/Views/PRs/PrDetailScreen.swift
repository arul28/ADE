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

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var isLive: Bool {
    prsStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var canRunPrActions: Bool {
    isLive && busyAction == nil
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

  // Snapshot-driven capability gate. Falls back to the legacy
  // supportsRemoteAction probe when the host hasn't sent capabilities yet
  // (cached-only / offline), so we never regress below the current gating.
  private var canRerunChecks: Bool {
    capabilities?.canRerunChecks ?? syncService.supportsRemoteAction("prs.rerunChecks")
  }

  private var canAddComment: Bool {
    capabilities?.canComment ?? syncService.supportsRemoteAction("prs.addComment")
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

      PrHeaderCard(pr: currentPr, transitionNamespace: transitionNamespace)
        .prListRow()

      Picker("Detail tab", selection: $selectedTab) {
        ForEach(PrDetailTab.allCases) { tab in
          Text(tab.title).tag(tab)
        }
      }
      .pickerStyle(.segmented)
      .prListRow()

      switch selectedTab {
      case .overview:
        PrOverviewTab(
          pr: currentPr,
          snapshot: snapshot,
          deployments: deployments,
          aiSummary: aiSummary,
          actionAvailability: actionAvailability,
          capabilities: capabilities,
          mergeMethod: $mergeMethod,
          reviewerInput: $reviewerInput,
          isLive: canRunPrActions,
          groupMembers: groupMembers,
          onMerge: mergeCurrentPr,
          onClose: closeCurrentPr,
          onReopen: reopenCurrentPr,
          onRequestReviewers: requestReviewers,
          onOpenGitHub: { openGitHub(urlString: currentPr.githubUrl) },
          onOpenStack: openStack,
          onEditTitle: { editorSheet = .title(currentPr.title) },
          onEditBody: { editorSheet = .body(snapshot?.detail?.body ?? "") },
          onEditLabels: {
            let labels = snapshot?.detail?.labels.map(\.name).joined(separator: ", ") ?? ""
            editorSheet = .labels(labels)
          },
          onSubmitReview: { editorSheet = .review },
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
          canRerunChecks: canRerunChecks,
          isLive: canRunPrActions,
          onRerun: rerunChecks
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
          commentInput: $commentInput,
          canAddComment: canAddComment,
          isLive: canRunPrActions,
          onSubmitComment: submitComment,
          onReplyToThread: replyToThread,
          onSetThreadResolved: setThreadResolved
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
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        ADEConnectionDot()
      }
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
    .sheet(item: $stackPresentation) { presentation in
      PrStackSheet(groupId: presentation.id, groupName: presentation.groupName)
        .environmentObject(syncService)
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

  private func refreshAiSummary() {
    runPrAction("Refreshing AI summary") {
      let summary = try await syncService.fetchPullRequestAiSummary(prId: prId)
      await MainActor.run {
        aiSummary = summary
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
