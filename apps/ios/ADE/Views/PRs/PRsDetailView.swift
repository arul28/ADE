import SwiftUI
import UIKit

struct PrDetailView: View {
  @EnvironmentObject private var syncService: SyncService

  let prId: String
  let transitionNamespace: Namespace.ID?
  let onOpenQueue: (String) -> Void
  let onOpenRebase: (String) -> Void

  @State private var pr: PullRequestListItem?
  @State private var snapshot: PullRequestSnapshot?
  @State private var actionRuns: [PrActionRun] = []
  @State private var activityEvents: [PrActivityEvent] = []
  @State private var groupMembers: [PrGroupMemberSummary] = []
  @State private var selectedTab: PrDetailTab = .overview
  @State private var mergeMethod: PrMergeMethodOption = .squash
  @State private var reviewerInput = ""
  @State private var commentInput = ""
  @State private var labelsInput = ""
  @State private var assigneesInput = ""
  @State private var reviewBody = ""
  @State private var selectedReviewEvent = "COMMENT"
  @State private var titleDraft = ""
  @State private var bodyDraft = ""
  @State private var replyToCommentId: String?
  @State private var replyToAuthor: String?
  @State private var editingCommentId: String?
  @State private var isEditingTitle = false
  @State private var isEditingBody = false
  @State private var errorMessage: String?
  @State private var cleanupChoice: PrCleanupChoice = .archive
  @State private var cleanupConfirmationPresented = false
  @State private var pendingDeleteComment: PrTimelineEvent?
  @State private var bypassMergeGuards = false
  @State private var isLoading = false

  private var prsStatus: SyncDomainStatus {
    syncService.status(for: .prs)
  }

  private var isLive: Bool {
    prsStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
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
    syncService.supportsRemoteAction("prs.rerunChecks")
  }

  private var canAddComment: Bool {
    syncService.supportsRemoteAction("prs.addComment")
  }

  private var canUpdateTitle: Bool {
    syncService.supportsRemoteAction("prs.updateTitle")
  }

  private var canUpdateBody: Bool {
    syncService.supportsRemoteAction("prs.updateBody")
  }

  private var canSetLabels: Bool {
    syncService.supportsRemoteAction("prs.setLabels")
  }

  private var canSetAssignees: Bool {
    syncService.supportsRemoteAction("prs.setAssignees")
  }

  private var canSubmitReview: Bool {
    syncService.supportsRemoteAction("prs.submitReview")
  }

  private var canUpdateComment: Bool {
    syncService.supportsRemoteAction("prs.updateComment")
  }

  private var canDeleteComment: Bool {
    syncService.supportsRemoteAction("prs.deleteComment")
  }

  private var timeline: [PrTimelineEvent] {
    if activityEvents.isEmpty {
      return buildPullRequestTimeline(
        pr: currentPr,
        snapshot: snapshot ?? PullRequestSnapshot(detail: nil, status: nil, checks: [], reviews: [], comments: [], files: [])
      )
    }
    return buildPullRequestTimeline(activityEvents: activityEvents)
  }

  private var commentComposerTitle: String {
    if editingCommentId != nil {
      return "Edit comment"
    }
    if let replyToAuthor, !replyToAuthor.isEmpty {
      return "Reply to \(replyToAuthor)"
    }
    return "Add comment"
  }

  private var commentComposerActionTitle: String {
    editingCommentId == nil ? "Post comment" : "Save comment"
  }

  private var activeCommentDraft: String? {
    editingCommentId ?? replyToCommentId
  }

  var body: some View {
    List {
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

      if isLoading && pr == nil {
        ADECardSkeleton(rows: 4)
          .prListRow()
      }

      PrHeaderCard(
        pr: currentPr,
        snapshot: snapshot,
        transitionNamespace: transitionNamespace,
        titleDraft: $titleDraft,
        isEditingTitle: $isEditingTitle,
        canUpdateTitle: canUpdateTitle,
        onSaveTitle: saveTitle,
        onOpenGitHub: { openGitHub(urlString: currentPr.githubUrl) },
        onOpenQueue: {
          if let groupId = currentPr.linkedGroupId, currentPr.linkedGroupType == "queue" {
            onOpenQueue(groupId)
          }
        },
        onOpenLane: openLane
      )
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
          actionAvailability: actionAvailability,
          mergeMethod: $mergeMethod,
          bypassMergeGuards: $bypassMergeGuards,
          reviewerInput: $reviewerInput,
          labelsInput: $labelsInput,
          assigneesInput: $assigneesInput,
          reviewBody: $reviewBody,
          selectedReviewEvent: $selectedReviewEvent,
          bodyDraft: $bodyDraft,
          isEditingBody: $isEditingBody,
          isLive: isLive,
          canUpdateBody: canUpdateBody,
          canSetLabels: canSetLabels,
          canSetAssignees: canSetAssignees,
          canSubmitReview: canSubmitReview,
          groupMembers: groupMembers,
          onMerge: mergeCurrentPr,
          onClose: closeCurrentPr,
          onReopen: reopenCurrentPr,
          onRequestReviewers: requestReviewers,
          onSetLabels: saveLabels,
          onSetAssignees: saveAssignees,
          onSaveBody: saveBody,
          onSubmitReview: submitReview,
          onOpenGitHub: { openGitHub(urlString: currentPr.githubUrl) },
          onArchiveLane: {
            cleanupChoice = .archive
            cleanupConfirmationPresented = true
          },
          onDeleteBranch: {
            cleanupChoice = .deleteBranch
            cleanupConfirmationPresented = true
          },
          onOpenLane: openLane,
          onOpenRebase: openRebase,
          onOpenLinkedPr: { linkedPrId in
            syncService.requestedPrNavigation = PrNavigationRequest(prId: linkedPrId)
          }
        )
        .prListRow()
      case .files:
        PrFilesTab(snapshot: snapshot)
          .prListRow()
      case .checks:
        PrChecksTab(
          pr: currentPr,
          checks: snapshot?.checks ?? [],
          actionRuns: actionRuns,
          canRerunChecks: canRerunChecks,
          isLive: isLive,
          onRerun: rerunChecks
        )
        .prListRow()
      case .activity:
        PrActivityTab(
          timeline: timeline,
          commentInput: $commentInput,
          composerTitle: commentComposerTitle,
          composerActionTitle: commentComposerActionTitle,
          canAddComment: canAddComment,
          canUpdateComment: canUpdateComment,
          canDeleteComment: canDeleteComment,
          isLive: isLive,
          onCancelComposer: activeCommentDraft == nil ? nil : cancelCommentDraft,
          onSubmitComment: submitComment,
          onReplyComment: beginReply,
          onEditComment: beginEditComment,
          onDeleteComment: promptDeleteComment
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
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : "pr-container-\(prId)", in: transitionNamespace)
    .task {
      await reload(refreshRemote: true)
    }
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
    .alert("Delete comment?", isPresented: deleteCommentConfirmationBinding) {
      Button("Delete", role: .destructive) {
        deletePendingComment()
      }
      Button("Cancel", role: .cancel) {
        pendingDeleteComment = nil
      }
    } message: {
      Text("This removes the comment from GitHub and refreshes the PR timeline.")
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    if refreshRemote { isLoading = pr == nil }
    defer { isLoading = false }
    do {
      if refreshRemote {
        try? await syncService.refreshPullRequestSnapshots(prId: prId)
      }
      let listItems = try await syncService.fetchPullRequestListItems()
      pr = listItems.first(where: { $0.id == prId })
      snapshot = try await syncService.fetchPullRequestSnapshot(prId: prId)
      if syncService.supportsRemoteAction("prs.getActionRuns") {
        actionRuns = (try? await syncService.fetchPullRequestActionRuns(prId: prId)) ?? []
      } else {
        actionRuns = []
      }
      if syncService.supportsRemoteAction("prs.getActivity") {
        activityEvents = (try? await syncService.fetchPullRequestActivity(prId: prId)) ?? []
      } else {
        activityEvents = []
      }
      if let groupId = pr?.linkedGroupId {
        groupMembers = try await syncService.fetchPullRequestGroupMembers(groupId: groupId)
      } else {
        groupMembers = []
      }
      if !isEditingTitle {
        titleDraft = pr?.title ?? titleDraft
      }
      if !isEditingBody {
        bodyDraft = snapshot?.detail?.body ?? bodyDraft
      }
      if !isEditingTitle && !isEditingBody {
        labelsInput = snapshot?.detail?.labels.map(\.name).joined(separator: ", ") ?? labelsInput
        assigneesInput = snapshot?.detail?.assignees.map(\.login).joined(separator: ", ") ?? assigneesInput
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func mergeCurrentPr() {
    Task { await runAction { try await syncService.mergePullRequest(prId: prId, method: mergeMethod.rawValue) } }
  }

  private func closeCurrentPr() {
    Task { await runAction { try await syncService.closePullRequest(prId: prId) } }
  }

  private func reopenCurrentPr() {
    Task { await runAction { try await syncService.reopenPullRequest(prId: prId) } }
  }

  private func requestReviewers() {
    let reviewers = reviewerInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }

    guard !reviewers.isEmpty else { return }

    Task {
      await runAction { try await syncService.requestReviewers(prId: prId, reviewers: reviewers) }
      reviewerInput = ""
    }
  }

  private func saveLabels() {
    let labels = labelsInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }

    Task { await runAction { try await syncService.setPullRequestLabels(prId: prId, labels: labels) } }
  }

  private func saveAssignees() {
    let assignees = assigneesInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }

    Task { await runAction { try await syncService.setPullRequestAssignees(prId: prId, assignees: assignees) } }
  }

  private func saveTitle() {
    let trimmed = titleDraft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    Task {
      await runAction { try await syncService.updatePullRequestTitle(prId: prId, title: trimmed) }
      isEditingTitle = false
    }
  }

  private func saveBody() {
    Task {
      await runAction { try await syncService.updatePullRequestBody(prId: prId, body: bodyDraft) }
      isEditingBody = false
    }
  }

  private func submitReview() {
    let body = reviewBody.trimmingCharacters(in: .whitespacesAndNewlines)
    Task {
      await runAction { try await syncService.submitPullRequestReview(prId: prId, event: selectedReviewEvent, body: body.isEmpty ? nil : body) }
      reviewBody = ""
    }
  }

  private func rerunChecks() {
    Task { await runAction { try await syncService.rerunPullRequestChecks(prId: prId) } }
  }

  private func submitComment() {
    let trimmed = commentInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    Task {
      if let editingCommentId {
        await runAction { try await syncService.updatePullRequestComment(prId: prId, commentId: editingCommentId, body: trimmed) }
      } else {
        await runAction {
          try await syncService.addPullRequestComment(prId: prId, body: trimmed, inReplyToCommentId: replyToCommentId)
        }
      }
      clearCommentDraft()
    }
  }

  private func beginReply(_ event: PrTimelineEvent) {
    guard event.canReply, let commentId = event.commentId else { return }
    editingCommentId = nil
    replyToCommentId = commentId
    replyToAuthor = event.author
    commentInput = ""
  }

  private func beginEditComment(_ event: PrTimelineEvent) {
    guard event.canEdit, let commentId = event.commentId else { return }
    editingCommentId = commentId
    replyToCommentId = nil
    replyToAuthor = nil
    commentInput = event.body ?? ""
  }

  private func promptDeleteComment(_ event: PrTimelineEvent) {
    guard event.canDelete else { return }
    pendingDeleteComment = event
  }

  private func deletePendingComment() {
    guard let comment = pendingDeleteComment, let commentId = comment.commentId else { return }
    pendingDeleteComment = nil
    Task {
      await runAction { try await syncService.deletePullRequestComment(prId: prId, commentId: commentId) }
      if editingCommentId == commentId || replyToCommentId == commentId {
        clearCommentDraft()
      }
    }
  }

  private func cancelCommentDraft() {
    clearCommentDraft()
  }

  private func clearCommentDraft() {
    commentInput = ""
    replyToCommentId = nil
    replyToAuthor = nil
    editingCommentId = nil
  }

  private func performCleanup() async {
    guard let laneId = pr?.laneId, !laneId.isEmpty else { return }
    switch cleanupChoice {
    case .archive:
      await runAction { try await syncService.archiveLane(laneId) }
    case .deleteBranch:
      await runAction { try await syncService.deleteLane(laneId, deleteBranch: true, deleteRemoteBranch: true) }
    }
  }

  private func openGitHub(urlString: String) {
    guard let url = URL(string: urlString) else { return }
    UIApplication.shared.open(url)
  }

  private func openLane() {
    guard let laneId = pr?.laneId, !laneId.isEmpty else { return }
    syncService.requestedLaneNavigation = LaneNavigationRequest(laneId: laneId)
  }

  private func openRebase() {
    guard let laneId = pr?.laneId, !laneId.isEmpty else { return }
    onOpenRebase(laneId)
  }

  @MainActor
  private func runAction(_ action: () async throws -> Void) async {
    do {
      try await action()
      await reload(refreshRemote: true)
    } catch {
      errorMessage = SyncUserFacingError.message(for: error)
    }
  }

  private var deleteCommentConfirmationBinding: Binding<Bool> {
    Binding(
      get: { pendingDeleteComment != nil },
      set: { newValue in
        if !newValue {
          pendingDeleteComment = nil
        }
      }
    )
  }
}
