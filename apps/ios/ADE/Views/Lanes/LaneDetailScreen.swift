import SwiftUI

// MARK: - Lane detail screen

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
  @State var confirmDiscardFile: FileChange?
  @State private var filesWorkspaceId: String?
  @State var syncExpanded = false
  @State var stashesExpanded = false
  @State var historyExpanded = false
  @State var showCommitDiffPicker = false
  @State var commitDiffFiles: [String] = []
  @State var commitDiffSha = ""
  @State var commitDiffSubject = ""
  @State var cachedCommitDiffFilesBySha: [String: [String]] = [:]
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
          .padding(12)
          .background(ADEColor.danger.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }

        if let detailConnectionNotice {
          connectionNoticeCard(detailConnectionNotice)
        }

        detailHeader

        if detail != nil {
          gitSections
        } else if let detailEmptyStatePresentation {
          detailEmptyStateCard(detailEmptyStatePresentation)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .scrollBounceBehavior(.basedOnSize)
    .navigationTitle(detail?.lane.name ?? initialSnapshot.lane.name)
    .navigationBarTitleDisplayMode(.inline)
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
    .alert("Discard changes?", isPresented: Binding(
      get: { confirmDiscardFile != nil },
      set: { if !$0 { confirmDiscardFile = nil } }
    )) {
      Button("Discard", role: .destructive) {
        if let file = confirmDiscardFile {
          Task {
            await performAction("discard file", refreshRoot: true) {
              try await syncService.discardFile(laneId: laneId, path: file.path)
            }
          }
        }
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("Unstaged changes to this file will be permanently lost.")
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
    .onDisappear {
      syncService.releaseLaneOpen(laneId: laneId)
    }
    .safeAreaInset(edge: .bottom) {
      if detail != nil { commitBar }
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

  @ViewBuilder
  var commitBar: some View {
    LaneCommitBar(
      commitMessage: $commitMessage,
      amendCommit: $amendCommit,
      hasStaged: !(detail?.diffChanges?.staged.isEmpty ?? true),
      hasDirty: detail?.lane.status.dirty ?? false,
      canPush: (detail?.lane.status.ahead ?? 0) > 0 || detail?.syncStatus?.hasUpstream == false,
      isPublish: detail?.syncStatus?.hasUpstream == false,
      canRunLiveActions: canRunLiveActions,
      onCommit: {
        Task {
          await performAction("commit") {
            try await syncService.commitLane(laneId: laneId, message: commitMessage, amend: amendCommit)
          }
          if errorMessage == nil { commitMessage = ""; amendCommit = false }
        }
      },
      onPush: {
        Task { await performAction("push") { try await syncService.pushGit(laneId: laneId) } }
      },
      onGenerateMessage: {
        Task {
          do {
            let msg = try await syncService.generateCommitMessage(laneId: laneId, amend: amendCommit)
            commitMessage = msg
          } catch {
            ADEHaptics.error()
            errorMessage = error.localizedDescription
          }
        }
      },
      onFetch: {
        Task { await performAction("fetch") { try await syncService.fetchGit(laneId: laneId) } }
      },
      onPullMerge: {
        Task { await performAction("pull merge") { try await syncService.pullGit(laneId: laneId) } }
      },
      onPullRebase: {
        Task { await performAction("pull rebase") { try await syncService.syncGit(laneId: laneId, mode: "rebase") } }
      },
      onForcePush: {
        Task { await performAction("force push") { try await syncService.pushGit(laneId: laneId, forceWithLease: true) } }
      },
      onStash: {
        Task {
          await performAction("stash") {
            try await syncService.stashPush(laneId: laneId, message: stashMessage, includeUntracked: true)
          }
          if errorMessage == nil { stashMessage = "" }
        }
      },
      onRebaseLane: {
        Task { await performAction("rebase lane") { try await syncService.startLaneRebase(laneId: laneId, scope: "lane_only") } }
      },
      onRebaseDescendants: {
        Task { await performAction("rebase descendants") { try await syncService.startLaneRebase(laneId: laneId, scope: "lane_and_descendants") } }
      },
      onRebaseAndPush: {
        Task { await performAction("rebase and push") { try await runRebaseAndPush() } }
      }
    )
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

  private var detailConnectionNotice: LaneConnectionNoticePresentation? {
    laneDetailConnectionNotice(
      connectionState: syncService.connectionState,
      laneStatus: syncService.status(for: .lanes),
      hasCachedDetail: detail != nil,
      hasHostProfile: syncService.activeHostProfile != nil,
      needsRepairing: syncService.activeHostProfile == nil && detail != nil
    )
  }

  private var detailEmptyStatePresentation: LaneEmptyStatePresentation? {
    laneDetailEmptyState(
      connectionState: syncService.connectionState,
      laneStatus: syncService.status(for: .lanes),
      hasHostProfile: syncService.activeHostProfile != nil
    )
  }

  @MainActor
  private func loadDetail(refreshRemote: Bool) async {
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
  private func connectionNoticeCard(_ presentation: LaneConnectionNoticePresentation) -> some View {
    ADENoticeCard(
      title: presentation.title,
      message: presentation.message,
      icon: presentation.icon,
      tint: presentation.tintRole.color,
      actionTitle: presentation.actionTitle,
      action: presentation.action.map { action in
        {
          handleNoticeAction(action)
        }
      }
    )
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
