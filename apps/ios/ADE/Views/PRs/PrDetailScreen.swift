import SwiftUI
import UIKit

struct PrDetailView: View {
  @EnvironmentObject private var syncService: SyncService
  let prId: String
  let transitionNamespace: Namespace.ID?

  @State private var pr: PullRequestListItem?
  @State private var snapshot: PullRequestSnapshot?
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
          canRerunChecks: canRerunChecks,
          isLive: canRunPrActions,
          onRerun: rerunChecks
        )
        .prListRow()
      case .activity:
        PrActivityTab(
          timeline: buildPullRequestTimeline(pr: currentPr, snapshot: snapshot ?? PullRequestSnapshot(detail: nil, status: nil, checks: [], reviews: [], comments: [], files: [])),
          commentInput: $commentInput,
          canAddComment: canAddComment,
          isLive: canRunPrActions,
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
      var refreshError: Error?
      if refreshRemote {
        do {
          try await syncService.refreshPullRequestSnapshots(prId: prId)
        } catch {
          refreshError = error
        }
      }
      let listItems = try await syncService.fetchPullRequestListItems()
      pr = listItems.first(where: { $0.id == prId })
      snapshot = try await syncService.fetchPullRequestSnapshot(prId: prId)
      if let groupId = pr?.linkedGroupId {
        groupMembers = try await syncService.fetchPullRequestGroupMembers(groupId: groupId)
      } else {
        groupMembers = []
      }
      errorMessage = refreshError?.localizedDescription
    } catch {
      errorMessage = error.localizedDescription
    }

    // Capability fetch is best-effort and live-only: failure leaves
    // `capabilities` nil so the view falls back to supportsRemoteAction.
    if isLive {
      do {
        let mobileSnapshot = try await syncService.fetchPrMobileSnapshot()
        capabilities = mobileSnapshot.capabilities[prId]
      } catch {
        capabilities = nil
      }
    } else {
      capabilities = nil
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

  private func submitComment() {
    let trimmed = commentInput.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }

    runPrAction(
      "Posting comment",
      action: { try await syncService.addPullRequestComment(prId: prId, body: trimmed) },
      onSuccess: { commentInput = "" }
    )
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
