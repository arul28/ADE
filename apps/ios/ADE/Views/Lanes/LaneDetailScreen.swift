import SwiftUI
import UIKit

struct LaneDetailScreen: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject var syncService: SyncService

  let laneId: String
  let initialSnapshot: LaneListSnapshot
  let allLaneSnapshots: [LaneListSnapshot]
  let transitionNamespace: Namespace.ID?
  let onRefreshRoot: @MainActor () async -> Void

  @State private(set) var detail: LaneDetailPayload?
  @State var errorMessage: String?
  @State private(set) var busyAction: String?
  @State var selectedDiffRequest: LaneDiffRequest?
  @State private var showStackGraph = false
  @State var managePresented = false
  @State var showBranchPicker = false
  @State private var lanePullRequests: [PullRequestListItem] = []
  @State var commitMessage = ""
  @State var amendCommit = false
  @State var stashMessage = ""
  @State var pendingFileConfirmation: LaneFileConfirmation?
  @State private var filesWorkspaceId: String?
  @State var rebaseSuggestionDismissed = false
  @State var showCommitDiffPicker = false
  @State var commitDiffFiles: [String] = []
  @State var commitDiffSha = ""
  @State var commitDiffSubject = ""
  @State var cachedCommitDiffFilesBySha: [String: [String]] = [:]
  @State var pendingGitConfirmation: LaneGitConfirmation?
  @State private var lastLaneDetailLocalReload = Date.distantPast

  var laneDetailProjectionReloadKey: String {
    // Per-lane revision keeps this screen from reloading when an unrelated lane's
    // local detail cache changes; the global revision still catches broad triggers
    // (CRR-synced lanes/PR/linear rows, project-scope changes).
    "\(laneId)-\(syncService.laneDetailProjectionRevision)-\(syncService.laneDetailRevisions[laneId] ?? 0)"
  }
  @State private var copiedLinkNotice: String?
  @State private var showRescueSheet = false
  @State private var rescueLaneName = ""

  init(
    laneId: String,
    initialSnapshot: LaneListSnapshot,
    allLaneSnapshots: [LaneListSnapshot],
    transitionNamespace: Namespace.ID? = nil,
    initialSection: LaneDetailSection = .git,
    onRefreshRoot: @escaping @MainActor () async -> Void
  ) {
    self.laneId = laneId
    self.initialSnapshot = initialSnapshot
    self.allLaneSnapshots = allLaneSnapshots
    self.transitionNamespace = transitionNamespace
    self.onRefreshRoot = onRefreshRoot
  }

  var currentSnapshot: LaneListSnapshot {
    if let detail {
      return LaneListSnapshot(
        lane: detail.lane,
        runtime: detail.runtime,
        rebaseSuggestion: detail.rebaseSuggestion,
        autoRebaseStatus: detail.autoRebaseStatus,
        conflictStatus: detail.conflictStatus,
        stateSnapshot: detail.stateSnapshot,
        adoptableAttached: detail.lane.laneType == "attached" && detail.lane.archivedAt == nil
      )
    }
    return allLaneSnapshots.first(where: { $0.lane.id == laneId }) ?? initialSnapshot
  }

  var body: some View {
    Group {
      if let detail {
        VStack(spacing: 10) {
          detailBannerStack
          if let conflictState = detail.conflictState, conflictState.inProgress {
            conflictSection(conflictState: conflictState)
              .padding(.horizontal, 16)
          }
          gitActionsPane(detail: detail)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .padding(.bottom, 8)
      } else {
        ScrollView {
          VStack(spacing: 12) {
            detailBannerStack
            if let detailEmptyStatePresentation {
              detailEmptyStateCard(detailEmptyStatePresentation)
            }
          }
          .padding(EdgeInsets(top: 4, leading: 16, bottom: 16, trailing: 16))
        }
        .scrollBounceBehavior(.basedOnSize)
      }
    }
    .adeScreenBackground()
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar(.hidden, for: .navigationBar)
    .toolbar(.hidden, for: .tabBar)
    .adeRootTabBarHidden()
    .safeAreaInset(edge: .top, spacing: 0) {
      laneDetailTopBar
    }
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : "lane-container-\(laneId)", in: transitionNamespace)
    .task {
      syncService.announceLaneOpen(laneId: laneId)
      await loadDetail(refreshRemote: canRunLiveActions)
    }
    .task(id: laneDetailProjectionReloadKey) {
      guard busyAction == nil else { return }
      if detail == nil, canRunLiveActions {
        await loadDetail(refreshRemote: true)
        return
      }
      guard detail != nil else { return }
      let revision = laneDetailProjectionReloadKey
      let elapsed = Date().timeIntervalSince(lastLaneDetailLocalReload)
      if elapsed < 0.35 {
        // Defer (don't drop) a bump that lands inside the throttle window: sleep
        // out the remainder, then re-check. A newer bump cancels/restarts this
        // task, so only the trailing reload proceeds.
        try? await Task.sleep(for: .milliseconds(max(1, Int((0.35 - elapsed) * 1_000))))
        guard !Task.isCancelled, laneDetailProjectionReloadKey == revision else { return }
      }
      lastLaneDetailLocalReload = Date()
      await loadDetail(refreshRemote: false)
    }
    .refreshable { await loadDetail(refreshRemote: true) }
    .sheet(item: $selectedDiffRequest) { request in
      LaneDiffScreen(request: request)
    }
    .sheet(isPresented: $showStackGraph) {
      LaneStackGraphSheet(snapshots: allLaneSnapshots, selectedLaneId: laneId)
    }
    .alert(item: $pendingFileConfirmation) { confirmation in
      Alert(
        title: Text(confirmation.title),
        message: Text(confirmation.message),
        primaryButton: .destructive(Text(confirmation.confirmTitle)) {
          Task { await performConfirmedFileAction(confirmation) }
        },
        secondaryButton: .cancel()
      )
    }
    .alert(item: $pendingGitConfirmation) { confirmation in
      Alert(
        title: Text(confirmation.title),
        message: Text(confirmation.message),
        primaryButton: .destructive(Text(confirmation.confirmTitle)) {
          Task { await performConfirmedGitAction(confirmation) }
        },
        secondaryButton: .cancel()
      )
    }
    .sheet(isPresented: $managePresented) {
      LaneManageSheet(
        snapshot: currentSnapshot,
        allLaneSnapshots: allLaneSnapshots,
        onDeleted: {
          await onRefreshRoot()
          dismiss()
        }
      ) {
        await loadDetail(refreshRemote: true)
        await onRefreshRoot()
      }
    }
    .sheet(isPresented: $showCommitDiffPicker) {
      commitDiffPickerSheet
    }
    .sheet(isPresented: $showBranchPicker) {
      if let detail {
        LaneBranchPickerSheet(
          laneId: laneId,
          branchRef: detail.lane.branchRef,
          onComplete: { await loadDetail(refreshRemote: true) }
        )
      }
    }
    .sheet(isPresented: $showRescueSheet) {
      rescueLaneSheet
    }
    .onDisappear {
      syncService.releaseLaneOpen(laneId: laneId)
    }
  }

  @ViewBuilder
  private var detailBannerStack: some View {
    VStack(spacing: 8) {
      if let busyAction {
        busyBanner(busyAction)
      }
      if let errorMessage {
        errorBanner(errorMessage)
      }
      if let copiedLinkNotice {
        copiedBanner(copiedLinkNotice)
      }
      rebaseBannerSection
    }
    .padding(.horizontal, 16)
    .padding(.top, 4)
  }

  private var laneDetailTopBar: some View {
    HStack(spacing: 0) {
      Button {
        dismiss()
      } label: {
        Image(systemName: "chevron.left")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(width: 36, height: 32)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Back to lanes")

      Spacer(minLength: 0)

      Menu {
        Button {
          copyLaneLink()
        } label: {
          Label("Copy ADE lane link", systemImage: "link")
        }
        Button {
          copyBranchLink()
        } label: {
          Label("Copy branch link", systemImage: "arrow.triangle.branch")
        }
        Divider()
        Button {
          managePresented = true
        } label: {
          Label("Manage lane", systemImage: "slider.horizontal.3")
        }
      } label: {
        Image(systemName: "ellipsis")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(width: 36, height: 32)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Lane options")
    }
    .padding(.horizontal, 10)
    .padding(.bottom, 2)
    .background {
      ADEColor.pageBackground.opacity(0.98)
        .ignoresSafeArea(edges: .top)
        .allowsHitTesting(false)
    }
  }

  @ViewBuilder
  private func gitActionsPane(detail: LaneDetailPayload) -> some View {
    LaneDetailGitActionsPane(
      snapshot: currentSnapshot,
      detail: detail,
      linkedPullRequests: lanePullRequests,
      canRunLiveActions: canRunLiveActions,
      busyAction: busyAction,
      commitMessage: $commitMessage,
      amendCommit: $amendCommit,
      stashMessage: $stashMessage,
      onRefresh: {
        Task { await loadDetail(refreshRemote: true) }
      },
      onCommit: {
        Task {
          await performAction("commit") {
            try await syncService.commitLane(laneId: laneId, message: commitMessage, amend: amendCommit)
          }
          if errorMessage == nil {
            commitMessage = ""
            amendCommit = false
          }
        }
      },
      onPull: { mode in
        Task { await performAction("pull \(mode)") { try await syncService.syncGit(laneId: laneId, mode: mode) } }
      },
      onPush: { force in
        Task { await performAction(force ? "force push" : "push") { try await syncService.pushGit(laneId: laneId, forceWithLease: force) } }
      },
      onFetch: {
        Task { await performAction("fetch") { try await syncService.fetchGit(laneId: laneId) } }
      },
      onStageFile: { file in
        Task { await performAction("stage file") { try await syncService.stageFile(laneId: laneId, path: file.path) } }
      },
      onUnstageFile: { file in
        Task { await performAction("unstage file") { try await syncService.unstageFile(laneId: laneId, path: file.path) } }
      },
      onDiscardFile: { file in
        Task { await performConfirmedFileAction(.discardUnstaged(file)) }
      },
      onRestoreStaged: { file in
        Task { await performConfirmedFileAction(.restoreStaged(file)) }
      },
      onStageAll: {
        let paths = (detail.diffChanges?.unstaged ?? []).map(\.path)
        guard !paths.isEmpty else { return }
        Task { await performAction("stage all") { try await syncService.stageAll(laneId: laneId, paths: paths) } }
      },
      onUnstageAll: {
        let paths = (detail.diffChanges?.staged ?? []).map(\.path)
        guard !paths.isEmpty else { return }
        Task { await performAction("unstage all") { try await syncService.unstageAll(laneId: laneId, paths: paths) } }
      },
      onDiscardAllUnstaged: {
        let files = detail.diffChanges?.unstaged ?? []
        guard !files.isEmpty else { return }
        Task { await performConfirmedFileAction(.discardAllUnstaged(files)) }
      },
      onRestoreAllStaged: {
        let files = detail.diffChanges?.staged ?? []
        guard !files.isEmpty else { return }
        Task { await performConfirmedFileAction(.restoreAllStaged(files)) }
      },
      onOpenDiff: { file, staged in
        selectedDiffRequest = LaneDiffRequest(
          laneId: laneId,
          path: file.path,
          mode: staged ? "staged" : "unstaged",
          compareRef: nil,
          compareTo: nil,
          title: (file.path as NSString).lastPathComponent
        )
      },
      onOpenFiles: { file in
        Task { await openFiles(path: file.path) }
      },
      onStashPush: { message in
        Task {
          await performAction("stash") {
            try await syncService.stashPush(laneId: laneId, message: message, includeUntracked: true)
          }
        }
      },
      onStashApply: { ref in
        Task { await performAction("stash apply") { try await syncService.stashApply(laneId: laneId, stashRef: ref) } }
      },
      onStashPop: { ref in
        Task { await performAction("stash pop") { try await syncService.stashPop(laneId: laneId, stashRef: ref) } }
      },
      onStashDrop: { ref in
        Task { await performAction("stash drop") { try await syncService.stashDrop(laneId: laneId, stashRef: ref) } }
      },
      onOpenCommitDiff: { commit in await openCommitDiffs(for: commit) },
      onCopyCommitMessage: { commit in
        do {
          UIPasteboard.general.string = try await syncService.getCommitMessage(laneId: laneId, commitSha: commit.sha)
          ADEHaptics.success()
        } catch {
          ADEHaptics.error()
          errorMessage = error.localizedDescription
        }
      },
      onRevertCommit: { commit in
        Task { await performAction("revert commit") { try await syncService.revertCommit(laneId: laneId, commitSha: commit.sha) } }
      },
      onCherryPickCommit: { commit in
        Task { await performAction("cherry pick") { try await syncService.cherryPickCommit(laneId: laneId, commitSha: commit.sha) } }
      },
      onSwitchBranch: { showBranchPicker = true },
      onRebaseLane: { requestGitConfirmation(.rebaseLane) },
      onRebaseDescendants: { requestGitConfirmation(.rebaseDescendants) },
      onRebaseAndPush: { requestGitConfirmation(.rebaseAndPush) },
      onForcePush: { requestGitConfirmation(.forcePush) },
      onOpenLinkedPullRequest: { pr in openPullRequest(pr) },
      onCreateLaneFromChanges: {
        rescueLaneName = suggestedRescueLaneName
        showRescueSheet = true
      }
    )
    .padding(.horizontal, 16)
  }

  private var suggestedRescueLaneName: String {
    let base = currentSnapshot.lane.name
    return base.isEmpty ? "Rescue lane" : "\(base) changes"
  }

  @ViewBuilder
  private var rescueLaneSheet: some View {
    NavigationStack {
      Form {
        Section {
          TextField("Lane name", text: $rescueLaneName)
            .textInputAutocapitalization(.words)
        } footer: {
          Text("Moves unstaged changes into a new child lane on this stack.")
            .font(.caption)
        }
      }
      .navigationTitle("New lane")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Cancel") { showRescueSheet = false }
        }
        ToolbarItem(placement: .confirmationAction) {
          Button("Create") {
            Task { await createLaneFromUnstagedChanges() }
          }
          .disabled(rescueLaneName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
      }
    }
    .presentationDetents([.medium])
  }

  @MainActor
  private func createLaneFromUnstagedChanges() async {
    let name = rescueLaneName.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !name.isEmpty else { return }
    await performAction("create rescue lane", refreshRoot: true) {
      _ = try await syncService.createFromUnstaged(sourceLaneId: laneId, name: name)
    }
    if errorMessage == nil {
      showRescueSheet = false
      rescueLaneName = ""
    }
  }

  @MainActor
  private func copyLaneLink() {
    let url = LaneDeeplinkHelpers.laneLink(
      laneId: laneId,
      envelope: LaneDeeplinkHelpers.envelope(
        lane: currentSnapshot.lane,
        pullRequest: lanePullRequests.first
      )
    )
    UIPasteboard.general.string = url
    ADEHaptics.success()
    copiedLinkNotice = "Copied lane link"
    Task {
      try? await Task.sleep(for: .seconds(2))
      if copiedLinkNotice == "Copied lane link" { copiedLinkNotice = nil }
    }
  }

  @MainActor
  private func copyBranchLink() {
    let branch = normalizedPrBranchName(currentSnapshot.lane.branchRef)
    guard !branch.isEmpty else {
      copyLaneLink()
      return
    }
    if let pr = lanePullRequests.first {
      let url = LaneDeeplinkHelpers.branchLink(
        repoOwner: pr.repoOwner,
        repoName: pr.repoName,
        branch: branch,
        prNumber: pr.githubPrNumber
      )
      UIPasteboard.general.string = url
      ADEHaptics.success()
      copiedLinkNotice = "Copied branch link"
    } else {
      UIPasteboard.general.string = LaneDeeplinkHelpers.laneLink(
        laneId: laneId,
        envelope: LaneDeeplinkHelpers.envelope(lane: currentSnapshot.lane, pullRequest: nil)
      )
      ADEHaptics.success()
      copiedLinkNotice = "No GitHub remote — copied lane link instead"
    }
    Task {
      try? await Task.sleep(for: .seconds(2.5))
      if copiedLinkNotice?.hasPrefix("Copied") == true || copiedLinkNotice?.hasPrefix("No GitHub") == true {
        copiedLinkNotice = nil
      }
    }
  }

  @ViewBuilder
  private func busyBanner(_ label: String) -> some View {
    HStack(spacing: 10) {
      ProgressView().tint(ADEColor.accent)
      Text(label.capitalized)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer()
    }
    .adeGlassCard(cornerRadius: 12, padding: 12)
  }

  @ViewBuilder
  private func errorBanner(_ message: String) -> some View {
    HStack(spacing: 10) {
      Image(systemName: "exclamationmark.triangle.fill")
        .foregroundStyle(ADEColor.danger)
      Text(message)
        .font(.footnote)
        .foregroundStyle(ADEColor.danger)
      Spacer()
    }
    .adeGlassCard(cornerRadius: 12, padding: 12)
  }

  @ViewBuilder
  private func copiedBanner(_ message: String) -> some View {
    HStack(spacing: 10) {
      Image(systemName: "doc.on.doc.fill")
        .foregroundStyle(ADEColor.success)
      Text(message)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
      Spacer()
    }
    .adeGlassCard(cornerRadius: 12, padding: 12)
  }

  @MainActor
  func handleRebaseSuggestionDismiss() {
    Task {
      do {
        try await syncService.dismissRebaseSuggestion(laneId: laneId)
        rebaseSuggestionDismissed = true
        await onRefreshRoot()
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
      }
    }
  }

  var canRunLiveActions: Bool {
    laneAllowsLiveActions(connectionState: syncService.connectionState, laneStatus: syncService.status(for: .lanes))
  }

  var liveActionDisabledSubtitle: String {
    let laneStatus = syncService.status(for: .lanes)
    if syncService.connectionState == .connected || syncService.connectionState == .syncing {
      return laneStatus.phase == .ready ? "Waiting for live lane actions." : "Waiting for lane sync."
    }
    return "Reconnect to run git actions."
  }

  private var detailEmptyStatePresentation: LaneEmptyStatePresentation? {
    laneDetailEmptyState(
      connectionState: syncService.connectionState,
      laneStatus: syncService.status(for: .lanes),
      hasHostProfile: syncService.activeHostProfile != nil
    )
  }

  @MainActor
  func loadDetail(refreshRemote: Bool) async {
    do {
      if let cachedDetail = try await syncService.fetchLaneDetail(laneId: laneId) {
        if detail != cachedDetail {
          detail = cachedDetail
        }
      }

      let cachedPullRequests = try await syncService.fetchPullRequestListItems(laneId: laneId)
      if lanePullRequests != cachedPullRequests {
        lanePullRequests = cachedPullRequests
      }

      if refreshRemote, canRunLiveActions {
        let refreshedDetail = try await syncService.refreshLaneDetail(laneId: laneId)
        if detail != refreshedDetail {
          detail = refreshedDetail
        }
        let refreshedPullRequests = try await syncService.fetchPullRequestListItems(laneId: laneId)
        if lanePullRequests != refreshedPullRequests {
          lanePullRequests = refreshedPullRequests
        }
      }

      errorMessage = nil
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func performAction(_ label: String, refreshRoot: Bool = true, operation: () async throws -> Void) async {
    do {
      busyAction = label
      errorMessage = nil
      try await operation()
      await loadDetail(refreshRemote: true)
      if refreshRoot {
        await onRefreshRoot()
      }
    } catch {
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
    busyAction = nil
  }

  @MainActor
  func requestGitConfirmation(_ confirmation: LaneGitConfirmation) {
    pendingGitConfirmation = confirmation
  }

  @MainActor
  private func performConfirmedGitAction(_ confirmation: LaneGitConfirmation) async {
    pendingGitConfirmation = nil
    switch confirmation {
    case .rebaseLane:
      await performAction(confirmation.actionLabel) {
        try await syncService.startLaneRebase(laneId: laneId, scope: "lane_only")
      }
    case .rebaseDescendants:
      await performAction(confirmation.actionLabel) {
        try await syncService.startLaneRebase(laneId: laneId, scope: "lane_and_descendants")
      }
    case .forcePush:
      await performAction(confirmation.actionLabel) {
        try await syncService.pushGit(laneId: laneId, forceWithLease: true)
      }
    case .rebaseAndPush:
      await performAction(confirmation.actionLabel) {
        try await runRebaseAndPush()
      }
    }
  }

  @MainActor
  private func performConfirmedFileAction(_ confirmation: LaneFileConfirmation) async {
    pendingFileConfirmation = nil
    switch confirmation {
    case .discardUnstaged(let file):
      await performAction(confirmation.actionLabel, refreshRoot: true) {
        try await syncService.discardFile(laneId: laneId, path: file.path)
      }
    case .discardAllUnstaged(let files):
      await performAction(confirmation.actionLabel, refreshRoot: true) {
        for file in files {
          try await syncService.discardFile(laneId: laneId, path: file.path)
        }
      }
    case .restoreStaged(let file):
      await performAction(confirmation.actionLabel, refreshRoot: true) {
        try await syncService.restoreStagedFile(laneId: laneId, path: file.path)
      }
    case .restoreAllStaged(let files):
      await performAction(confirmation.actionLabel, refreshRoot: true) {
        for file in files {
          try await syncService.restoreStagedFile(laneId: laneId, path: file.path)
        }
      }
    }
  }

  func runRebaseAndPush() async throws {
    try await syncService.startLaneRebase(laneId: laneId, scope: "lane_only", pushMode: "none")
    try? await syncService.fetchGit(laneId: laneId)
    let syncStatus = try await syncService.fetchSyncStatus(laneId: laneId)
    if syncStatus.hasUpstream == false {
      try await syncService.pushGit(laneId: laneId)
      return
    }
    if syncStatus.diverged && syncStatus.ahead > 0 {
      try await syncService.pushGit(laneId: laneId, forceWithLease: true)
      return
    }
    if syncStatus.ahead > 0 {
      try await syncService.pushGit(laneId: laneId)
    }
  }

  private func openPullRequest(_ pr: PullRequestListItem) {
    syncService.requestedPrNavigation = PrNavigationRequest(prId: pr.id, laneId: pr.laneId)
  }

  @ViewBuilder
  private func detailEmptyStateCard(_ presentation: LaneEmptyStatePresentation) -> some View {
    ADEEmptyStateView(symbol: presentation.symbol, title: presentation.title, message: presentation.message) {
      if let actionTitle = presentation.actionTitle, let action = presentation.action {
        Button(actionTitle) {
          handleNoticeAction(action)
        }
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
      }
    }
  }

  private func handleNoticeAction(_ action: LaneConnectionNoticeAction) {
    switch action {
    case .openSettings:
      syncService.settingsPresented = true
    case .reconnect:
      Task {
        await syncService.reconnectIfPossible(userInitiated: true)
        await loadDetail(refreshRemote: true)
        await onRefreshRoot()
      }
    case .retry:
      Task { await loadDetail(refreshRemote: true) }
    }
  }

  @MainActor
  func openFiles(path: String? = nil) async {
    do {
      let workspaceId: String
      if let filesWorkspaceId {
        workspaceId = filesWorkspaceId
      } else {
        let workspaces = try await syncService.listWorkspaces()
        guard let workspace = workspaces.first(where: { $0.laneId == laneId }) else {
          errorMessage = "No Files workspace for this lane."
          return
        }
        filesWorkspaceId = workspace.id
        workspaceId = workspace.id
      }
      syncService.requestedFilesNavigation = FilesNavigationRequest(
        workspaceId: workspaceId,
        laneId: laneId,
        relativePath: path
      )
    } catch {
      filesWorkspaceId = nil
      ADEHaptics.error()
      errorMessage = error.localizedDescription
    }
  }

  @ViewBuilder
  var commitDiffPickerSheet: some View {
    NavigationStack {
      List(commitDiffFiles, id: \.self) { filePath in
        Button {
          showCommitDiffPicker = false
          selectedDiffRequest = LaneDiffRequest(
            laneId: laneId,
            path: filePath,
            mode: "commit",
            compareRef: commitDiffSha,
            compareTo: nil,
            title: (filePath as NSString).lastPathComponent
          )
        } label: {
          Text(filePath)
            .font(.system(.subheadline, design: .monospaced))
            .foregroundStyle(ADEColor.textPrimary)
        }
      }
      .navigationTitle(commitDiffSubject)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) {
          Button("Done") { showCommitDiffPicker = false }
        }
      }
    }
    .presentationDetents([.medium, .large])
  }
}
