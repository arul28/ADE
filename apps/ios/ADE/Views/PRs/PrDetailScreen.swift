import SwiftUI
import UIKit

struct PrDetailView: View {
  @EnvironmentObject private var syncService: SyncService
  let prId: String
  let transitionNamespace: Namespace.ID?

  @State private var pr: PullRequestListItem?
  @State private var snapshot: PullRequestSnapshot?
  @State private var groupMembers: [PrGroupMemberSummary] = []
  @State private var selectedTab: PrDetailTab = .overview
  @State private var mergeMethod: PrMergeMethodOption = .squash
  @State private var reviewerInput = ""
  @State private var commentInput = ""
  @State private var errorMessage: String?
  @State private var cleanupChoice: PrCleanupChoice = .archive
  @State private var cleanupConfirmationPresented = false

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
          actionAvailability: actionAvailability,
          mergeMethod: $mergeMethod,
          reviewerInput: $reviewerInput,
          isLive: isLive,
          groupMembers: groupMembers,
          onMerge: mergeCurrentPr,
          onClose: closeCurrentPr,
          onReopen: reopenCurrentPr,
          onRequestReviewers: requestReviewers,
          onOpenGitHub: { openGitHub(urlString: currentPr.githubUrl) },
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
      case .files:
        PrFilesTab(snapshot: snapshot)
          .prListRow()
      case .checks:
        PrChecksTab(
          checks: snapshot?.checks ?? [],
          canRerunChecks: canRerunChecks,
          isLive: isLive,
          onRerun: rerunChecks
        )
        .prListRow()
      case .activity:
        PrActivityTab(
          timeline: buildPullRequestTimeline(pr: currentPr, snapshot: snapshot ?? PullRequestSnapshot(detail: nil, status: nil, checks: [], reviews: [], comments: [], files: [])),
          commentInput: $commentInput,
          canAddComment: canAddComment,
          isLive: isLive,
          onSubmitComment: submitComment
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
      await reload()
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
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try? await syncService.refreshPullRequestSnapshots(prId: prId)
      }
      let listItems = try await syncService.fetchPullRequestListItems()
      pr = listItems.first(where: { $0.id == prId })
      snapshot = try await syncService.fetchPullRequestSnapshot(prId: prId)
      if let groupId = pr?.linkedGroupId {
        groupMembers = try await syncService.fetchPullRequestGroupMembers(groupId: groupId)
      } else {
        groupMembers = []
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func mergeCurrentPr() {
    Task {
      try? await syncService.mergePullRequest(prId: prId, method: mergeMethod.rawValue)
      await reload(refreshRemote: true)
    }
  }

  private func closeCurrentPr() {
    Task {
      try? await syncService.closePullRequest(prId: prId)
      await reload(refreshRemote: true)
    }
  }

  private func reopenCurrentPr() {
    Task {
      try? await syncService.reopenPullRequest(prId: prId)
      await reload(refreshRemote: true)
    }
  }

  private func requestReviewers() {
    let reviewers = reviewerInput
      .split(separator: ",")
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }

    guard !reviewers.isEmpty else { return }

    Task {
      try? await syncService.requestReviewers(prId: prId, reviewers: reviewers)
      reviewerInput = ""
      await reload(refreshRemote: true)
    }
  }

  private func rerunChecks() {
    Task {
      try? await syncService.rerunPullRequestChecks(prId: prId)
      await reload(refreshRemote: true)
    }
  }

  private func submitComment() {
    let trimmed = commentInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    Task {
      try? await syncService.addPullRequestComment(prId: prId, body: trimmed)
      commentInput = ""
      await reload(refreshRemote: true)
    }
  }

  private func performCleanup() async {
    guard let laneId = pr?.laneId, !laneId.isEmpty else { return }
    switch cleanupChoice {
    case .archive:
      try? await syncService.archiveLane(laneId)
    case .deleteBranch:
      try? await syncService.deleteLane(laneId, deleteBranch: true, deleteRemoteBranch: true)
    }
    await reload(refreshRemote: true)
  }

  private func openGitHub(urlString: String) {
    guard let url = URL(string: urlString) else { return }
    UIApplication.shared.open(url)
  }
}
