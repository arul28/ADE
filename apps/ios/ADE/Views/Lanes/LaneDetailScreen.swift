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
  @State private var chatLaunchTarget: LaneChatLaunchTarget?
  @State private var lanePullRequests: [PullRequestListItem] = []
  @State private var headerExpanded = true
  @State private var selectedSection: LaneDetailSection
  @State var commitMessage = ""
  @State var amendCommit = false
  @State var stashMessage = ""
  @State var confirmDiscardFile: FileChange?
  @State private var filesWorkspaceId: String?

  init(
    laneId: String,
    initialSnapshot: LaneListSnapshot,
    allLaneSnapshots: [LaneListSnapshot],
    initialSection: LaneDetailSection = .overview,
    onRefreshRoot: @escaping @MainActor () async -> Void
  ) {
    self.laneId = laneId
    self.initialSnapshot = initialSnapshot
    self.allLaneSnapshots = allLaneSnapshots
    self.onRefreshRoot = onRefreshRoot
    _selectedSection = State(initialValue: initialSection)
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
        sectionContent
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .scrollBounceBehavior(.basedOnSize)
    .navigationTitle(detail?.lane.name ?? initialSnapshot.lane.name)
    .navigationBarTitleDisplayMode(.inline)
    .safeAreaInset(edge: .top, spacing: 0) {
      stickySectionBar
    }
    .task { await loadDetail(refreshRemote: true) }
    .task(id: syncService.localStateRevision) {
      guard busyAction == nil else { return }
      await loadDetail(refreshRemote: false)
    }
    .refreshable { await loadDetail(refreshRemote: true) }
    .sheet(item: $selectedDiffRequest) { request in
      LaneDiffScreen(request: request)
    }
    .sheet(isPresented: $showStackGraph) {
      LaneStackGraphSheet(snapshots: allLaneSnapshots, selectedLaneId: laneId)
    }
    .sheet(item: $chatLaunchTarget) { target in
      LaneChatLaunchSheet(laneId: laneId, provider: target.provider) { _ in
        await loadDetail(refreshRemote: true)
        await onRefreshRoot()
      }
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
  }

  @ViewBuilder
  var detailHeader: some View {
    LaneDetailHeaderCard(
      snapshot: currentSnapshot,
      detail: detail,
      linkedPullRequests: lanePullRequests,
      isExpanded: headerExpanded,
      onToggleExpanded: {
        withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
          headerExpanded.toggle()
        }
      },
      onManageTapped: {
        selectedSection = .manage
        managePresented = true
      },
      onStackTapped: { showStackGraph = true },
      onOpenLinkedPullRequest: { pr in
        openPullRequest(pr)
      }
    )
  }

  @ViewBuilder
  var sectionPicker: some View {
    Picker("Lane section", selection: $selectedSection) {
      ForEach(LaneDetailSection.allCases) { section in
        Label(section.title, systemImage: section.symbol)
          .labelStyle(.titleOnly)
          .tag(section)
          .accessibilityLabel("\(section.title) section")
      }
    }
    .pickerStyle(.segmented)
  }

  @ViewBuilder
  var stickySectionBar: some View {
    VStack(spacing: 0) {
      sectionPicker
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 10)
    }
    .background(.ultraThinMaterial)
    .overlay(alignment: .bottom) {
      Rectangle()
        .fill(ADEColor.border.opacity(0.16))
        .frame(height: 0.5)
    }
  }

  @ViewBuilder
  var sectionContent: some View {
    switch selectedSection {
    case .overview:
      overviewSection
    case .work:
      workSection
    case .git:
      gitSections
    case .manage:
      manageSection
    }
  }

  @ViewBuilder
  var overviewSection: some View {
    VStack(spacing: 14) {
      GlassSection(title: "Overview", subtitle: overviewSubtitle) {
        VStack(alignment: .leading, spacing: 12) {
          HStack(alignment: .top, spacing: 10) {
            LaneTypeBadge(text: statusInfo.label, tint: statusInfo.tint)
            Spacer(minLength: 8)
            Text(currentSnapshot.lane.branchRef)
              .font(.system(.caption, design: .monospaced))
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
          }

          LaneInfoRow(label: "Host", value: canRunLiveActions ? "Live connection" : "Offline cached")
          LaneInfoRow(label: "Lane type", value: currentSnapshot.lane.laneType.capitalized)
          LaneInfoRow(label: "Path", value: currentSnapshot.lane.worktreePath, isMonospaced: true)
        }
      }

      GlassSection(title: "Quick actions") {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            LaneActionButton(title: "Files", symbol: "folder", tint: ADEColor.accent) {
              Task { await openFiles() }
            }
            LaneActionButton(title: "Stack", symbol: "square.stack.3d.up") {
              showStackGraph = true
            }
            LaneActionButton(title: "PRs", symbol: "arrow.triangle.pull", tint: ADEColor.accent) {
              openFirstPullRequest()
            }
            .disabled(lanePullRequests.isEmpty)
            LaneActionButton(title: "Manage", symbol: "slider.horizontal.3") {
              selectedSection = .manage
              managePresented = true
            }
          }
        }
      }

      if let detail {
        if !detail.stackChain.isEmpty {
          GlassSection(title: "Stack chain") {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(detail.stackChain.prefix(5)) { item in
                HStack(spacing: 8) {
                  Circle()
                    .fill(item.laneId == laneId ? ADEColor.accent : runtimeTint(bucket: detail.runtime.bucket))
                    .frame(width: 6, height: 6)
                    .padding(.leading, CGFloat(item.depth) * 8)
                  VStack(alignment: .leading, spacing: 2) {
                    Text(item.laneName)
                      .font(.caption.weight(.medium))
                      .foregroundStyle(ADEColor.textPrimary)
                    Text(item.branchRef)
                      .font(.caption2)
                      .foregroundStyle(ADEColor.textSecondary)
                      .lineLimit(1)
                  }
                  Spacer(minLength: 8)
                }
              }
            }
          }
        }

        if let suggestion = detail.rebaseSuggestion, suggestion.dismissedAt == nil {
          GlassSection(title: "Rebase attention") {
            VStack(alignment: .leading, spacing: 12) {
              Text("Behind parent by \(suggestion.behindCount) commit\(suggestion.behindCount == 1 ? "" : "s").")
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
              HStack(spacing: 8) {
                LaneActionButton(title: "Rebase", symbol: "arrow.triangle.2.circlepath", tint: ADEColor.warning) {
                  Task {
                    await performAction("rebase lane") {
                      try await syncService.startLaneRebase(laneId: laneId)
                    }
                  }
                }
                LaneActionButton(title: "Defer", symbol: "clock.arrow.circlepath") {
                  Task {
                    await performAction("defer rebase") {
                      try await syncService.deferRebaseSuggestion(laneId: laneId)
                    }
                  }
                }
                LaneActionButton(title: "Dismiss", symbol: "xmark.circle", tint: ADEColor.textSecondary) {
                  Task {
                    await performAction("dismiss rebase") {
                      try await syncService.dismissRebaseSuggestion(laneId: laneId)
                    }
                  }
                }
              }
            }
          }
        }

        if let conflictStatus = detail.conflictStatus, conflictStatus.status == "conflict-active" {
          GlassSection(title: "Conflict attention") {
            VStack(alignment: .leading, spacing: 12) {
              Text(conflictSummary(conflictStatus))
                .font(.subheadline)
                .foregroundStyle(ADEColor.textSecondary)
              HStack(spacing: 8) {
                if let conflictState = detail.conflictState, conflictState.inProgress {
                  LaneActionButton(title: "Continue", symbol: "play.fill", tint: ADEColor.accent) {
                    Task {
                      await performAction("rebase continue") {
                        try await syncService.rebaseContinueGit(laneId: laneId)
                      }
                    }
                  }
                  .disabled(!conflictState.canContinue)
                }
                if !lanePullRequests.isEmpty {
                  LaneActionButton(title: "Review in PRs", symbol: "arrow.triangle.pull", tint: ADEColor.accent) {
                    openFirstPullRequest()
                  }
                }
              }
            }
          }
        }

        if !lanePullRequests.isEmpty {
          GlassSection(title: "Linked pull requests") {
            VStack(alignment: .leading, spacing: 12) {
              ForEach(lanePullRequests) { pr in
                Button {
                  openPullRequest(pr)
                } label: {
                  HStack(alignment: .top, spacing: 10) {
                    LaneTypeBadge(text: pr.state.uppercased(), tint: lanePullRequestTint(pr.state))
                    VStack(alignment: .leading, spacing: 3) {
                      Text(pr.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(ADEColor.textPrimary)
                        .lineLimit(2)
                      Text("\(pr.repoOwner)/\(pr.repoName) #\(pr.githubPrNumber)")
                        .font(.caption2)
                        .foregroundStyle(ADEColor.textSecondary)
                    }
                    Spacer(minLength: 0)
                  }
                  .frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
              }
            }
          }
        }

        if let envInitProgress = detail.envInitProgress {
          GlassSection(title: "Environment", subtitle: envInitProgress.overallStatus.capitalized) {
            VStack(alignment: .leading, spacing: 8) {
              ForEach(envInitProgress.steps) { step in
                HStack(spacing: 10) {
                  Text(step.label)
                    .font(.caption)
                    .foregroundStyle(ADEColor.textPrimary)
                  Spacer()
                  Text(step.status)
                    .font(.system(.caption2, design: .monospaced))
                    .foregroundStyle(ADEColor.textSecondary)
                }
              }
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  var workSection: some View {
    VStack(spacing: 14) {
      GlassSection(title: "Launch", subtitle: "Work stays lane-scoped on this phone.") {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            LaneActionButton(title: "Files", symbol: "folder", tint: ADEColor.accent) {
              Task { await openFiles() }
            }
            LaneActionButton(title: "Shell", symbol: "terminal") {
              Task {
                await performAction("launch shell") {
                  try await syncService.runQuickCommand(laneId: laneId, title: "Shell", toolType: "shell", tracked: true)
                }
              }
            }
            LaneActionButton(title: "Codex", symbol: "sparkle", tint: ADEColor.accent) {
              chatLaunchTarget = LaneChatLaunchTarget(provider: "codex")
            }
            LaneActionButton(title: "Claude", symbol: "brain.head.profile", tint: ADEColor.warning) {
              chatLaunchTarget = LaneChatLaunchTarget(provider: "claude")
            }
          }
        }
      }

      if !sessions.isEmpty {
        GlassSection(title: "Terminal sessions") {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(sessions) { session in
              NavigationLink {
                LaneSessionTranscriptView(session: session)
              } label: {
                LaneSessionCard(session: session)
              }
              .buttonStyle(.plain)
            }
          }
        }
      }

      if !chatSessions.isEmpty {
        GlassSection(title: "Chat sessions") {
          VStack(alignment: .leading, spacing: 12) {
            ForEach(chatSessions) { chat in
              NavigationLink {
                LaneChatSessionView(summary: chat)
              } label: {
                LaneChatCard(chat: chat)
              }
              .buttonStyle(.plain)
            }
          }
        }
      }
    }
  }

  @ViewBuilder
  var manageSection: some View {
    VStack(spacing: 14) {
      GlassSection(title: "Manage", subtitle: "Use the manage sheet for rename, appearance, reparenting, and delete.") {
        VStack(alignment: .leading, spacing: 12) {
          LaneInfoRow(label: "Name", value: currentSnapshot.lane.name)
          LaneInfoRow(label: "Branch", value: currentSnapshot.lane.branchRef, isMonospaced: true)
          LaneInfoRow(label: "Path", value: currentSnapshot.lane.worktreePath, isMonospaced: true)
          LaneInfoRow(label: "Type", value: currentSnapshot.lane.laneType.capitalized)
          LaneInfoRow(label: "State", value: currentSnapshot.lane.archivedAt == nil ? "Active" : "Archived")
          if currentSnapshot.adoptableAttached {
            LaneInfoRow(label: "Attach state", value: "Can adopt attached worktree")
          }
          if !currentSnapshot.lane.tags.isEmpty {
            LaneInfoRow(label: "Tags", value: currentSnapshot.lane.tags.joined(separator: ", "))
          }
        }
      }

      GlassSection(title: "Actions") {
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: 8) {
            LaneActionButton(title: "Open manage sheet", symbol: "slider.horizontal.3", tint: ADEColor.accent) {
              managePresented = true
            }
            if currentSnapshot.lane.archivedAt == nil {
              LaneActionButton(title: "Archive", symbol: "archivebox", tint: ADEColor.warning) {
                Task {
                  await performAction("archive lane") {
                    try await syncService.archiveLane(laneId)
                  }
                }
              }
            } else {
              LaneActionButton(title: "Restore", symbol: "tray.and.arrow.up", tint: ADEColor.accent) {
                Task {
                  await performAction("restore lane") {
                    try await syncService.unarchiveLane(laneId)
                  }
                }
              }
            }
            if currentSnapshot.adoptableAttached {
              LaneActionButton(title: "Adopt attached", symbol: "link.circle", tint: ADEColor.accent) {
                Task {
                  await performAction("adopt attached lane") {
                    _ = try await syncService.adoptAttachedLane(laneId)
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  private var overviewSubtitle: String? {
    guard let detail else { return currentSnapshot.lane.description }
    if let conflictStatus = detail.conflictStatus, conflictStatus.status == "conflict-active" {
      return conflictSummary(conflictStatus)
    }
    if let autoRebaseStatus = detail.autoRebaseStatus, autoRebaseStatus.state != "autoRebased" {
      return autoRebaseStatus.message ?? "Rebase attention required."
    }
    if let rebaseSuggestion = detail.rebaseSuggestion {
      return "Behind parent by \(rebaseSuggestion.behindCount) commit\(rebaseSuggestion.behindCount == 1 ? "" : "s")."
    }
    return currentSnapshot.lane.description
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

  private var statusInfo: (label: String, tint: Color) {
    if let conflictStatus = detail?.conflictStatus, conflictStatus.status == "conflict-active" {
      return ("Conflict", ADEColor.danger)
    }
    if let autoRebaseStatus = detail?.autoRebaseStatus, autoRebaseStatus.state != "autoRebased" {
      return ("Rebase attention", ADEColor.warning)
    }
    if currentSnapshot.lane.archivedAt != nil {
      return ("Archived", ADEColor.textMuted)
    }
    if currentSnapshot.lane.status.dirty {
      return ("Dirty", ADEColor.warning)
    }
    if currentSnapshot.runtime.bucket == "running" {
      return ("Running", ADEColor.success)
    }
    if currentSnapshot.runtime.bucket == "awaiting-input" {
      return ("Awaiting input", ADEColor.warning)
    }
    return ("Clean", ADEColor.success)
  }

  private var connectionBanner: ADENoticeCard? {
    let lanesStatus = syncService.status(for: .lanes)
    switch syncService.connectionState {
    case .connected:
      if lanesStatus.phase == .ready {
        return nil // Suppress banner when everything is nominal
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
    // Best-effort fetch — continue to push even if offline or the remote is unreachable.
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

  private func openFirstPullRequest() {
    guard let pr = lanePullRequests.first else { return }
    openPullRequest(pr)
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
}
