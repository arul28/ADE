import SwiftUI

// MARK: - Lane detail screen

struct LaneDetailScreen: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject var syncService: SyncService

  let laneId: String
  let initialSnapshot: LaneListSnapshot
  let allLaneSnapshots: [LaneListSnapshot]
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

  init(
    laneId: String,
    initialSnapshot: LaneListSnapshot,
    allLaneSnapshots: [LaneListSnapshot],
    initialSection: LaneDetailSection = .git,
    onRefreshRoot: @escaping @MainActor () async -> Void
  ) {
    self.laneId = laneId
    self.initialSnapshot = initialSnapshot
    self.allLaneSnapshots = allLaneSnapshots
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
        if let banner = connectionBanner { banner }

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

        if detail == nil && errorMessage == nil {
          ADECardSkeleton(rows: 4)
        }

        detailHeader
        gitSections
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .scrollBounceBehavior(.basedOnSize)
    .navigationTitle(detail?.lane.name ?? initialSnapshot.lane.name)
    .navigationBarTitleDisplayMode(.inline)
    .task { await loadDetail(refreshRemote: true) }
    .task(id: syncService.localStateRevision) {
      guard busyAction == nil, detail != nil else { return }
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
    syncService.connectionState == .connected || syncService.connectionState == .syncing
  }

  private var connectionBanner: ADENoticeCard? {
    let lanesStatus = syncService.status(for: .lanes)
    switch syncService.connectionState {
    case .connected:
      if lanesStatus.phase == .ready {
        return nil
      }
      return ADENoticeCard(
        title: "Hydrating",
        message: "Lane data is still loading from the host.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    case .syncing, .connecting:
      return ADENoticeCard(
        title: "Syncing",
        message: "Actions will run when sync settles.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    case .disconnected, .error:
      return ADENoticeCard(
        title: "Offline",
        message: "Showing last cached lane state.",
        icon: "icloud.slash",
        tint: ADEColor.textSecondary,
        actionTitle: nil,
        action: nil
      )
    }
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
