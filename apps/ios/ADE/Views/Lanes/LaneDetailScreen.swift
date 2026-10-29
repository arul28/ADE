import SwiftUI
import UIKit

struct LaneDetailScreen: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.dismiss) private var dismiss
  @Environment(\.duoLayout) private var duoLayout
  @EnvironmentObject var syncService: SyncService

  let laneId: String
  let initialSnapshot: LaneListSnapshot
  let allLaneSnapshots: [LaneListSnapshot]
  let transitionNamespace: Namespace.ID?
  /// False when the screen is a split column's detail: there is nothing to go
  /// back to in that column.
  let showsBackButton: Bool
  /// Shown inside another surface (the Work tools pane) rather than as a
  /// screen of its own: it must not hide the root tab bar around it.
  let embedded: Bool
  /// The machine the lane lives on, for the Duo's subtitle and dashboard.
  let machineName: String?
  let onRefreshRoot: @MainActor () async -> Void

  @State private(set) var detail: LaneDetailPayload?
  @State var errorMessage: String?
  @State private(set) var busyAction: String?
  @State var selectedDiffRequest: LaneDiffRequest?
  @State var managePresented = false
  @State var showBranchPicker = false
  @State private var lanePullRequests: [PullRequestListItem] = []
  @State var commitMessage = ""
  @State var amendCommit = false
  @State var stashMessage = ""
  @State var pendingFileConfirmation: LaneFileConfirmation?
  @State private var filesWorkspaceId: String?
  @State var showCommitDiffPicker = false
  @State var commitDiffFiles: [String] = []
  @State var commitDiffSha = ""
  @State var commitDiffSubject = ""
  @State var cachedCommitDiffFilesBySha: [String: [String]] = [:]
  @State var pendingGitConfirmation: LaneGitConfirmation?
  @State private var lastLaneDetailLocalReload = Date.distantPast
  /// Field diagnostics: this screen's open-to-ready timings.
  @State private var openTiming = ScreenOpenTiming()
  /// The opening load (cache, then one host read) has finished. Until then the
  /// keyed reload task stays out of its way.
  @State private var openingLoadFinished = false

  var laneDetailProjectionReloadKey: String {
    // Per-lane revision keeps this screen from reloading when an unrelated lane's
    // local detail cache changes; the global revision still catches broad triggers
    // (CRR-synced lanes/PR/linear rows, project-scope changes).
    "\(laneId)-\(syncService.laneDetailProjectionRevision)-\(syncService.laneDetailRevisions[laneId] ?? 0)"
  }
  @State private var copiedLinkNotice: String?
  @State private var newLaneWithChangesPresented = false
  /// The Duo's git column shows this diff in place of the git list.
  @State private var inlineDiffRequest: LaneDiffRequest?

  init(
    laneId: String,
    initialSnapshot: LaneListSnapshot,
    allLaneSnapshots: [LaneListSnapshot],
    transitionNamespace: Namespace.ID? = nil,
    initialSection: LaneDetailSection = .git,
    showsBackButton: Bool = true,
    embedded: Bool = false,
    machineName: String? = nil,
    onRefreshRoot: @escaping @MainActor () async -> Void
  ) {
    self.laneId = laneId
    self.initialSnapshot = initialSnapshot
    self.allLaneSnapshots = allLaneSnapshots
    self.transitionNamespace = transitionNamespace
    self.showsBackButton = showsBackButton
    self.embedded = embedded
    self.machineName = machineName
    self.onRefreshRoot = onRefreshRoot
  }

  var currentSnapshot: LaneListSnapshot {
    if let detail {
      return LaneListSnapshot(
        lane: detail.lane,
        runtime: detail.runtime,
        conflictStatus: detail.conflictStatus,
        stateSnapshot: detail.stateSnapshot
      )
    }
    return allLaneSnapshots.first(where: { $0.lane.id == laneId }) ?? initialSnapshot
  }

  var body: some View {
    // One design on every display: the header over Overview | Git, the
    // controls in the toolbar (the edge bar held landscape on the Duo, the
    // navigation bar on a phone), pushed on a phone and a split's detail on
    // the inner display and an iPad.
    duoBody
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : "lane-container-\(laneId)", in: transitionNamespace)
    .adeAnalyticsScreen(.laneDetail)
    .onAppear {
      ScrollDiagnostics.shared.enter(.laneDetail)
      openTiming.opened()
    }
    .onChange(of: detail != nil) { _, loaded in
      if loaded { openTiming.mark("laneDetail.content") }
    }
    .task {
      syncService.announceLaneOpen(laneId: laneId)
      let openingKey = laneDetailProjectionReloadKey
      await loadDetail(refreshRemote: canRunLiveActions)
      openingLoadFinished = true
      // A local bump landed during the host read: read the cache once more
      // so the newest local state wins over an older host reply.
      if laneDetailProjectionReloadKey != openingKey {
        await loadDetail(refreshRemote: false)
      }
    }
    .modifier(LaneDetailReloadAndPresentations(screen: self))
  }

  /// The keyed reload and the sheets and alerts both layouts present. A
  /// modifier so the body's type stays small enough to type-check quickly.
  fileprivate struct LaneDetailReloadAndPresentations: ViewModifier {
    let screen: LaneDetailScreen

    func body(content: Content) -> some View {
      screen.reloadAndPresentations(content)
    }
  }

  fileprivate func reloadAndPresentations<Content: View>(_ content: Content) -> some View {
    content
    .task(id: laneDetailProjectionReloadKey) {
      // The opening load owns the first read, and reads again itself if
      // this key moved while it ran.
      guard busyAction == nil, openingLoadFinished else { return }
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
    .sheet(item: $selectedDiffRequest) { request in
      LaneDiffScreen(request: request)
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
          dismiss()
          // SyncService refreshes once its retained host cleanup finishes;
          // starting another snapshot request here would duplicate that work.
        },
        onRenamed: {
          await loadDetail(refreshRemote: true)
          await onRefreshRoot()
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
    .sheet(isPresented: $newLaneWithChangesPresented) {
      newLaneWithChangesSheet
    }
    .onDisappear {
      ScrollDiagnostics.shared.leave(.laneDetail)
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
    }
    .padding(.horizontal, 16)
    .padding(.top, 4)
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
        openDiff(LaneDiffRequest(
          laneId: laneId,
          path: file.path,
          mode: staged ? "staged" : "unstaged",
          compareRef: nil,
          compareTo: nil,
          title: (file.path as NSString).lastPathComponent
        ))
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
      onRebaseAndPush: { requestGitConfirmation(.rebaseAndPush) },
      onForcePush: { requestGitConfirmation(.forcePush) },
      onOpenLinkedPullRequest: { pr in openPullRequest(pr) },
      onCreateLaneFromChanges: { openNewLaneWithChanges() },
      loadBranchChanges: syncService.supportsBranchDiff
        ? { try await syncService.fetchBranchChanges(laneId: laneId) }
        : nil,
      onOpenBranchDiff: { file in
        openDiff(LaneDiffRequest(
          laneId: laneId,
          path: file.path,
          mode: "branch",
          compareRef: nil,
          compareTo: nil,
          title: (file.path as NSString).lastPathComponent
        ))
      }
    )
  }

  /// A file's diff, in place of the git list (its back control returns).
  private func openDiff(_ request: LaneDiffRequest) {
    withAnimation(.spring(response: 0.35, dampingFraction: 0.86)) { inlineDiffRequest = request }
  }

  // MARK: - Duo

  private var duoPullRequest: PullRequestListItem? {
    lanePullRequests.first { $0.state == "open" || $0.state == "draft" } ?? lanePullRequests.first
  }

  private var canCreateDuoPullRequest: Bool {
    canRunLiveActions && currentSnapshot.lane.laneType != "primary" && currentSnapshot.lane.archivedAt == nil
  }

  /// `LaneDuoDetailLayout` over this screen's state: the dashboard, and the
  /// git column (banners, then the git pane or a diff in its place).
  private var duoBody: some View {
    LaneDuoDetailLayout(
      snapshot: currentSnapshot,
      machineName: machineName,
      pullRequest: duoPullRequest,
      canCreatePullRequest: canCreateDuoPullRequest,
      onOpenPullRequest: openPullRequest,
      onCreatePullRequest: {
        syncService.requestedPrNavigation = PrNavigationRequest(createLaneId: laneId)
      },
      onRefresh: { Task { await loadDetail(refreshRemote: true) } },
      onOpenFiles: { Task { await openFiles() } },
      onManage: { managePresented = true },
      onCopyLaneLink: copyLaneLink,
      onCopyBranchLink: copyBranchLink,
      forcesGit: inlineDiffRequest != nil
    ) {
      LaneDuoDashboard(
        snapshot: currentSnapshot,
        detail: detail,
        machineName: machineName,
        pullRequests: lanePullRequests,
        canCreatePullRequest: canCreateDuoPullRequest,
        onOpenPullRequest: openPullRequest,
        onCreatePullRequest: {
          syncService.requestedPrNavigation = PrNavigationRequest(createLaneId: laneId)
        },
        onOpenChat: { chat in
          syncService.requestedWorkSessionNavigation = WorkSessionNavigationRequest(sessionId: chat.sessionId, laneId: laneId)
        }
      )
      .refreshable { await loadDetail(refreshRemote: true) }
    } git: {
      if let inlineDiffRequest {
        LaneDiffScreen(request: inlineDiffRequest, inline: true) {
          withAnimation(.spring(response: 0.35, dampingFraction: 0.86)) { self.inlineDiffRequest = nil }
        }
        .id(inlineDiffRequest.id)
        .transition(.move(edge: .trailing).combined(with: .opacity))
      } else if let detail {
        VStack(spacing: 10) {
          detailBannerStack
          if let conflictState = detail.conflictState, conflictState.inProgress {
            conflictSection(conflictState: conflictState)
              .padding(.horizontal, 16)
          }
          gitActionsPane(detail: detail)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .refreshable { await loadDetail(refreshRemote: true) }
        }
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
  }

  // MARK: - New lane with these changes

  /// The lanes of this lane's machine (namespaced ids for another machine):
  /// the new lane goes there, and this lane is where the changes are copied from.
  private var sameMachineLanes: [LaneSummary] {
    let machineKey = workParseRemoteLaneId(laneId)?.machineKey
    var lanes = allLaneSnapshots.map(\.lane).filter { workParseRemoteLaneId($0.id)?.machineKey == machineKey }
    if !lanes.contains(where: { $0.id == laneId }) {
      lanes.append(currentSnapshot.lane)
    }
    return lanes
  }

  /// Where `lanes.create` goes: nil for the focused machine, else this lane's
  /// machine's checkout of the project.
  private var newLaneTarget: LaneCreateTarget? {
    guard let machineKey = workParseRemoteLaneId(laneId)?.machineKey,
          let repo = syncService.remoteLaneRepo(machineKey: machineKey) else { return nil }
    return LaneCreateTarget(projectId: repo.markedProjectId, rootPath: repo.rootPath)
  }

  /// A new branch from this lane's branch with a copy of its uncommitted
  /// changes. This lane keeps its changes.
  private func openNewLaneWithChanges() {
    // A lane of another machine must reach that machine; never fall back to
    // the focused one.
    if workParseRemoteLaneId(laneId) != nil, newLaneTarget == nil {
      ADEHaptics.error()
      errorMessage = "This lane's machine no longer lists this project."
      return
    }
    newLaneWithChangesPresented = true
  }

  @ViewBuilder
  private var newLaneWithChangesSheet: some View {
    let lanes = sameMachineLanes
    LaneCreateSheet(
      primaryLane: lanes.first { $0.laneType == "primary" },
      lanes: lanes,
      initialMode: .newBranch,
      initialStart: LaneStart(
        from: .branch,
        branch: plainLaneStartBranch(currentSnapshot.lane.branchRef),
        bring: .uncommitted
      ),
      showsModePicker: true,
      target: newLaneTarget,
      onComplete: { _ in
        ADEHaptics.success()
        await onRefreshRoot()
      }
    )
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
      ProgressView().controlSize(.small)
      Text(label.capitalized)
        .font(.system(size: 13.5))
        .foregroundStyle(ADEColor.textSecondary)
      Spacer()
    }
    .adeKitCard(padding: 12)
  }

  @ViewBuilder
  private func errorBanner(_ message: String) -> some View {
    ADESettingsNotice(message: message, tone: .crit)
  }

  @ViewBuilder
  private func copiedBanner(_ message: String) -> some View {
    HStack(spacing: 10) {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.success)
      Text(message)
        .font(.system(size: 13.5))
        .foregroundStyle(ADEColor.textSecondary)
      Spacer()
    }
    .adeKitCard(padding: 12)
  }

  var canRunLiveActions: Bool {
    laneAllowsLiveActions(connectionState: syncService.connectionState, laneStatus: syncService.status(for: .lanes))
  }

  var liveActionDisabledSubtitle: String {
    let laneStatus = syncService.status(for: .lanes)
    if syncService.connectionState == .connected {
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
        openTiming.mark("laneDetail.fresh")
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
        try await syncService.startLaneRebase(laneId: laneId)
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
    try await syncService.startLaneRebase(laneId: laneId, pushMode: "none")
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
        .buttonStyle(ADEKitButtonStyle(prominent: true))
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
