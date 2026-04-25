import SwiftUI

struct LaneDetailScreen: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
  @State private var managePresented = false
  @State private var lanePullRequests: [PullRequestListItem] = []
  @State var commitMessage = ""
  @State var amendCommit = false
  @State var stashMessage = ""
  @State var pendingFileConfirmation: LaneFileConfirmation?
  @State private var filesWorkspaceId: String?
  @State var showCommitSheet = false
  @State var rebaseSuggestionDismissed = false
  @State var showCommitDiffPicker = false
  @State var commitDiffFiles: [String] = []
  @State var commitDiffSha = ""
  @State var commitDiffSubject = ""
  @State private var commitMessageGenerationToken = UUID()
  @State var cachedCommitDiffFilesBySha: [String: [String]] = [:]
  @State var pendingGitConfirmation: LaneGitConfirmation?
  @State private var lastLaneDetailLocalReload = Date.distantPast

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
    ScrollView {
      LazyVStack(spacing: 14) {
        if let busyAction {
          HStack(spacing: 10) {
            ProgressView()
              .tint(ADEColor.accent)
            Text(busyAction.capitalized)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textSecondary)
            Spacer()
          }
          .adeGlassCard(cornerRadius: 12, padding: 12)
        }

        if let errorMessage {
          HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
              .foregroundStyle(ADEColor.danger)
            Text(errorMessage)
              .font(.footnote)
              .foregroundStyle(ADEColor.danger)
            Spacer()
          }
          .adeGlassCard(cornerRadius: 12, padding: 12)
        }

        rebaseBannerSection

        detailHeader

        if detail != nil {
          gitSections
        } else if let detailEmptyStatePresentation {
          detailEmptyStateCard(detailEmptyStatePresentation)
        }
      }
      .padding(EdgeInsets(top: 14, leading: 16, bottom: 14, trailing: 16))
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .scrollBounceBehavior(.basedOnSize)
    .navigationTitle(detail?.lane.name ?? initialSnapshot.lane.name)
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ADERootToolbarLeadingItems()
    }
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : "lane-container-\(laneId)", in: transitionNamespace)
    .task {
      syncService.announceLaneOpen(laneId: laneId)
      await loadDetail(refreshRemote: false)
      if detail == nil, canRunLiveActions {
        await loadDetail(refreshRemote: true)
      }
    }
    .task(id: syncService.localStateRevision) {
      guard busyAction == nil, detail != nil else { return }
      let now = Date()
      guard now.timeIntervalSince(lastLaneDetailLocalReload) >= 0.35 else { return }
      lastLaneDetailLocalReload = now
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
        allLaneSnapshots: allLaneSnapshots
      ) {
        await loadDetail(refreshRemote: true)
        await onRefreshRoot()
      }
    }
    .sheet(isPresented: $showCommitDiffPicker) {
      commitDiffPickerSheet
    }
    .sheet(isPresented: $showCommitSheet) {
      LaneCommitSheet(
        commitMessage: $commitMessage,
        amendCommit: $amendCommit,
        stagedCount: detail?.diffChanges?.staged.count ?? 0,
        unstagedCount: detail?.diffChanges?.unstaged.count ?? 0,
        canRunLiveActions: canRunLiveActions,
        onGenerateMessage: {
          let requestToken = UUID()
          let shouldAmend = amendCommit
          commitMessageGenerationToken = requestToken
          Task { @MainActor in
            do {
              let msg = try await syncService.generateCommitMessage(laneId: laneId, amend: shouldAmend)
              guard commitMessageGenerationToken == requestToken, showCommitSheet else { return }
              commitMessage = msg
            } catch {
              guard commitMessageGenerationToken == requestToken, showCommitSheet else { return }
              ADEHaptics.error()
              errorMessage = error.localizedDescription
            }
          }
        },
        onCommit: {
          Task {
            commitMessageGenerationToken = UUID()
            await performAction("commit") {
              try await syncService.commitLane(laneId: laneId, message: commitMessage, amend: amendCommit)
            }
            if errorMessage == nil {
              commitMessage = ""
              amendCommit = false
              showCommitSheet = false
            }
          }
        },
        onDismiss: {
          commitMessageGenerationToken = UUID()
          showCommitSheet = false
        }
      )
      .presentationDetents([.medium, .large])
    }
    .onDisappear {
      commitMessageGenerationToken = UUID()
      syncService.releaseLaneOpen(laneId: laneId)
    }
  }

  @ViewBuilder
  var detailHeader: some View {
    LaneDetailHeaderCard(
      snapshot: currentSnapshot,
      detail: detail,
      linkedPullRequests: lanePullRequests,
      transitionNamespace: transitionNamespace,
      transitionLaneId: laneId,
      canManage: canRunLiveActions,
      onManageTapped: { managePresented = true },
      onStackTapped: { showStackGraph = true },
      onOpenLinkedPullRequest: { pr in openPullRequest(pr) }
    )
  }

  @MainActor
  func handleRebaseSuggestionDefer() {
    Task {
      do {
        try await syncService.deferRebaseSuggestion(laneId: laneId)
        rebaseSuggestionDismissed = true
        await onRefreshRoot()
      } catch {
        ADEHaptics.error()
        errorMessage = error.localizedDescription
      }
    }
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

  private var sessions: [TerminalSessionSummary] {
    detail?.sessions ?? []
  }

  private var chatSessions: [AgentChatSessionSummary] {
    detail?.chatSessions ?? []
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
      async let cachedDetailTask = syncService.fetchLaneDetail(laneId: laneId)
      async let pullRequestsTask = syncService.fetchPullRequestListItems(laneId: laneId)

      if let cachedDetail = try await cachedDetailTask {
        if detail != cachedDetail {
          detail = cachedDetail
        }
      }

      let cachedPullRequests = try await pullRequestsTask
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
