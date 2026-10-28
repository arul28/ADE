import SwiftUI

// MARK: - Fixtures

#if DEBUG
/// Fixture screens for this area, routed by `DuoPreviewRouter`.
///
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-lanes
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-prs
enum DuoSplitPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-lanes": return AnyView(DuoLanesFixtureScreen())
    case "duo-lane-diff": return AnyView(DuoLanesFixtureScreen(showsDiff: true))
    case "duo-prs": return AnyView(DuoPrsFixtureScreen())
    case "duo-pr-files": return AnyView(DuoPrsFixtureScreen(initialTab: .files))
    case "duo-pr-checks": return AnyView(DuoPrsFixtureScreen(initialTab: .checks))
    case "duo-pr-merge": return AnyView(DuoPrsFixtureScreen(initialDock: .merge))
    default: return nil
    }
  }
}

// MARK: Lanes fixture

/// The Lanes split over fixture data: the real lane rows in the list
/// column's own stack, and the real Duo lane detail (`LaneDuoDetailLayout`
/// with `LaneDuoDashboard` and `LaneDetailGitActionsPane`) beside it.
private struct DuoLanesFixtureScreen: View {
  /// `duo-lane-diff`: a changed file's diff open in the git column.
  var showsDiff = false
  @State private var selection = "s-sync"
  @State private var filter: LaneQuickFilter = .active
  @State private var search = ""
  @State private var diffOpen = false

  private var selectedSnapshot: LaneListSnapshot? {
    DuoSplitFixtureData.lanes.first { $0.lane.id == selection }
  }

  var body: some View {
    DuoSplitScaffold(
      preferredListWidth: 280,
      minimumDetailWidth: 420,
      adaptive: true,
      detailTakesBothPages: true,
      selection: selection,
      wantsWholeDisplay: true
    ) { _ in
      // The real list column's shape: ‹ logo + "Lanes", then search (the
      // filter inside it), Add lane and ⋯, and the selected row tinted.
      NavigationStack {
        List {
          Section {
            ForEach(DuoSplitFixtureData.lanes.filter(filter.matches)) { snapshot in
              LaneTreeRow(
                snapshot: snapshot,
                depth: snapshot.lane.laneType == "primary" ? 0 : 1,
                pullRequest: nil,
                isPinned: snapshot.lane.id == "s-sync",
                isOpen: true,
                transitionNamespace: nil,
                isSelectedTransitionSource: selection == snapshot.lane.id,
                onContextMenu: { _ in AnyView(EmptyView()) },
                onSelectLane: { _ in },
                onOpen: { selection = snapshot.lane.id },
                machine: nil,
                showsMachineChip: snapshot.lane.laneType == "primary"
              )
              .background {
                if selection == snapshot.lane.id {
                  RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(ADEColor.accent.opacity(0.12))
                    .padding(.horizontal, 6)
                }
              }
              .adeFlatRow(insets: EdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 6))
            }
          }
        }
        .adeFlatList()
        .listSectionSpacing(.compact)
        .environment(\.defaultMinListRowHeight, 0)
        .safeAreaInset(edge: .top, spacing: 0) {
          HStack(spacing: 8) {
            LaneHeaderSearchField(searchText: $search) {
              Picker("Show", selection: $filter) {
                ForEach(LaneQuickFilter.allCases) { filter in
                  Text(filter.title).tag(filter)
                }
              }
              .pickerStyle(.inline)
            } filterActive: {
              filter != .active
            }
            Button {} label: {
              Image(systemName: "plus")
                .font(.system(size: 18, weight: .medium))
                .foregroundStyle(ADEColor.textPrimary)
                .frame(width: 32, height: 44)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add lane")
            WorkHeaderOverflowMenu(
              showsLinear: false,
              showsCursorCloud: false,
              actions: WorkRootHeaderActions(onOpenActivity: {}, onOpenSettings: {})
            )
          }
          .padding(.horizontal, 16)
          .padding(.bottom, 6)
          .background(ADEColor.pageBackground.opacity(0.94))
        }
        .duoLeadingColumnContent()
        .adeScreenBackground()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            HStack(spacing: 6) {
              WorkHeaderProjectButton(iconDataUrl: nil) {}
              Text("Lanes")
                .font(.system(size: 22, weight: .heavy, design: .rounded))
                .foregroundStyle(ADEColor.textPrimary)
                .lineLimit(1)
                .fixedSize()
                .accessibilityAddTraits(.isHeader)
            }
            .padding(.horizontal, 4)
          }
          .sharedBackgroundVisibility(.hidden)
        }
      }
    } detail: {
      if let snapshot = selectedSnapshot {
        NavigationStack {
          DuoLaneDetailFixture(snapshot: snapshot, diffOpen: $diffOpen)
            .toolbar { DuoAppTabsToolbar() }
        }
        .id(snapshot.lane.id)
      } else {
        DuoSplitPlaceholder(
          symbol: "square.stack.3d.up",
          title: "Select a lane",
          message: "Pick a lane to see its dashboard, changes, commits and git actions."
        )
      }
    }
    .onAppear { diffOpen = showsDiff }
  }
}

/// The Duo lane detail over fixture data, with no service reads.
private struct DuoLaneDetailFixture: View {
  let snapshot: LaneListSnapshot
  @Binding var diffOpen: Bool
  @State private var commitMessage = ""
  @State private var amendCommit = false
  @State private var stashMessage = ""

  var body: some View {
    let detail = DuoSplitFixtureData.laneDetail(snapshot)
    LaneDuoDetailLayout(
      snapshot: snapshot,
      machineName: "Arul’s Mac Studio",
      pullRequest: nil,
      canCreatePullRequest: true,
      onOpenPullRequest: { _ in },
      onCreatePullRequest: {},
      onRefresh: {},
      onStackGraph: {},
      onOpenFiles: {},
      onManage: {},
      onCopyLaneLink: {},
      onCopyBranchLink: {},
      forcesGit: diffOpen
    ) {
      LaneDuoDashboard(
        snapshot: snapshot,
        detail: detail,
        machineName: "Arul’s Mac Studio",
        pullRequests: [PrFlatPreviewData.pr(state: "open")],
        canCreatePullRequest: true,
        onOpenPullRequest: { _ in },
        onCreatePullRequest: {},
        onOpenChat: { _ in },
        onOpenLane: { _ in },
        onStackGraph: {}
      )
    } git: {
      if diffOpen {
        LaneDiffScreen(
          request: LaneDiffRequest(
            laneId: snapshot.lane.id,
            path: "apps/ios/ADE/Views/Duo/DuoSplitScreens.swift",
            mode: "unstaged",
            compareRef: nil,
            compareTo: nil,
            title: "DuoSplitScreens.swift"
          ),
          inline: true,
          initialDiff: DuoSplitFixtureData.fileDiff
        ) {
          diffOpen = false
        }
      } else {
        LaneDetailGitActionsPane(
          snapshot: snapshot,
          detail: detail,
          linkedPullRequests: [],
          canRunLiveActions: true,
          busyAction: nil,
          commitMessage: $commitMessage,
          amendCommit: $amendCommit,
          stashMessage: $stashMessage,
          onRefresh: {},
          onCommit: {},
          onPull: { _ in },
          onPush: { _ in },
          onFetch: {},
          onStageFile: { _ in },
          onUnstageFile: { _ in },
          onDiscardFile: { _ in },
          onRestoreStaged: { _ in },
          onStageAll: {},
          onUnstageAll: {},
          onDiscardAllUnstaged: {},
          onRestoreAllStaged: {},
          onOpenDiff: { _, _ in diffOpen = true },
          onOpenFiles: { _ in },
          onStashPush: { _ in },
          onStashApply: { _ in },
          onStashPop: { _ in },
          onStashDrop: { _ in },
          onOpenCommitDiff: { _ in },
          onCopyCommitMessage: { _ in },
          onRevertCommit: { _ in },
          onCherryPickCommit: { _ in },
          onSwitchBranch: {},
          onRebaseLane: {},
          onRebaseDescendants: {},
          onRebaseAndPush: {},
          onForcePush: {},
          onOpenLinkedPullRequest: { _ in },
          onCreateLaneFromChanges: {}
        )
      }
    }
  }
}

// MARK: PRs fixture

/// The PRs split over fixture data: the real list rows in the list column's
/// own stack, and the real Duo detail column (`PrDuoDetail`) beside it.
private struct DuoPrsFixtureScreen: View {
  var initialTab: PrDetailTab = .overview
  var initialDock: PrDuoDock?
  @State private var selection = 1367
  @State private var category = PrGitHubCategory.open
  @State private var search = ""
  @State private var tab: PrDetailTab = .overview
  @State private var method: PrMergeMethodOption = .squash

  private var items: [GitHubPrListItem] {
    PrFlatPreviewData.mergedItems.filter { item in
      search.isEmpty || item.title.localizedCaseInsensitiveContains(search)
    }
  }

  var body: some View {
    DuoSplitScaffold(adaptive: true, selection: "\(selection)", wantsWholeDisplay: true) { _ in
      NavigationStack {
        List {
          Section {
            ForEach(items) { item in
              Button {
                selection = item.githubPrNumber
              } label: {
                PrRowCard(
                  item: item,
                  laneMachineName: item.linkedLaneId?.hasPrefix("fleet|") == true ? "MacBook Pro" : nil
                )
              }
              .buttonStyle(.plain)
              // Before `adeFlatRow`, as in the real list: the innermost row
              // background wins.
              .listRowBackground(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                  .fill(selection == item.githubPrNumber ? ADEColor.accent.opacity(0.14) : Color.clear)
                  .padding(.horizontal, 6)
                  .padding(.vertical, 2)
              )
              .adeFlatRow(insets: EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16))
            }
          }
        }
        .adeFlatList()
        .contentMargins(.bottom, 24, for: .scrollContent)
        // The real list column's header (PrsRootScreen).
        .safeAreaInset(edge: .top, spacing: 0) {
          PrListHeaderBar(
            searchText: $search,
            prompt: "Search PRs",
            filterActive: false,
            canCreate: true,
            onCreate: {},
            onOpenActivity: {},
            onOpenSettings: {}
          ) {
            Button("Mine") {}
          } category: {
            Picker("Status", selection: $category) {
              Text(verbatim: "Open 17").tag(PrGitHubCategory.open)
              Text(verbatim: "Merged 1035").tag(PrGitHubCategory.merged)
              Text(verbatim: "Closed 167").tag(PrGitHubCategory.closed)
            }
            .pickerStyle(.segmented)
          }
        }
        .duoLeadingColumnContent()
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            HStack(spacing: 6) {
              WorkHeaderProjectButton(iconDataUrl: nil) {}
              PrListTitleLabel(title: "PRs")
            }
            .padding(.horizontal, 4)
          }
          .sharedBackgroundVisibility(.hidden)
        }
      }
    } detail: {
      NavigationStack {
        PrDuoDetail(
          model: PrFlatPreviewData.duoModel(),
          actions: .inert,
          tab: $tab,
          mergeMethod: $method,
          initialDock: initialDock,
          header: {
            PrFlatDetailHeader(
              createdAt: PrFlatPreviewData.iso(12 * PrFlatPreviewData.day),
              updatedAt: PrFlatPreviewData.iso(3 * PrFlatPreviewData.hour),
              title: "",
              baseBranch: "main",
              headBranch: "ade/cross-machine-to-phone",
              laneName: "cross-machine",
              ghostLaneName: nil,
              machineName: "MacBook Pro",
              stackLabel: nil,
              onOpenLane: {},
              onOpenStack: nil,
              canCreateLane: false,
              canLinkLane: false,
              onCreateLane: {},
              onLinkLane: {},
              showsTitle: false
            )
          },
          overflow: {
            Button("Comment", systemImage: "text.bubble") {}
            Button("Edit title", systemImage: "pencil") {}
            Button("Copy link", systemImage: "link") {}
          }
        )
        .toolbar { DuoAppTabsToolbar() }
      }
      .id(selection)
    }
    .onAppear { tab = initialTab }
  }
}

// MARK: Fixture data

private enum DuoSplitFixtureData {
  static func iso(_ secondsAgo: TimeInterval) -> String {
    ISO8601DateFormatter().string(from: Date().addingTimeInterval(-secondsAgo))
  }

  static func lane(
    _ id: String,
    _ name: String,
    type: String = "worktree",
    branch: String,
    color: String?,
    parent: String? = nil,
    depth: Int = 0,
    children: Int = 0,
    status: LaneStatus = LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false)
  ) -> LaneSummary {
    LaneSummary(
      id: id,
      name: name,
      description: nil,
      laneType: type,
      baseRef: "main",
      branchRef: branch,
      worktreePath: "/tmp/\(id)",
      attachedRootPath: nil,
      parentLaneId: parent,
      childCount: children,
      stackDepth: depth,
      parentStatus: nil,
      isEditProtected: false,
      status: status,
      color: color,
      icon: nil,
      tags: [],
      folder: nil,
      createdAt: "2026-09-28T12:00:00Z",
      archivedAt: nil,
      devicesOpen: nil
    )
  }

  static func snapshot(_ lane: LaneSummary, running: Int = 0, awaiting: Int = 0) -> LaneListSnapshot {
    LaneListSnapshot(
      lane: lane,
      runtime: LaneRuntimeSummary(
        bucket: running > 0 ? "running" : "none",
        runningCount: running,
        awaitingInputCount: awaiting,
        endedCount: 0,
        sessionCount: running + awaiting
      )
    )
  }

  static let lanes: [LaneListSnapshot] = [
    snapshot(lane("s-main", "Primary", type: "primary", branch: "main", color: "#3B82F6", children: 2), running: 1),
    snapshot(
      lane(
        "s-sync",
        "fix sync loop",
        branch: "ade/fix-sync-loop-2f81",
        color: "#A855F7",
        parent: "s-main",
        depth: 1,
        status: LaneStatus(dirty: true, ahead: 3, behind: 1, remoteBehind: 0, rebaseInProgress: false)
      ),
      awaiting: 1
    ),
    snapshot(lane("s-docs", "docs refresh", branch: "ade/docs-refresh-91aa", color: "#22C55E", parent: "s-main", depth: 1)),
  ]

  static func laneDetail(_ snapshot: LaneListSnapshot) -> LaneDetailPayload {
    LaneDetailPayload(
      lane: snapshot.lane,
      runtime: snapshot.runtime,
      stackChain: [
        StackChainItem(laneId: "s-main", laneName: "Primary", branchRef: "main", depth: 0, parentLaneId: nil, status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false)),
        StackChainItem(laneId: snapshot.lane.id, laneName: snapshot.lane.name, branchRef: snapshot.lane.branchRef, depth: 1, parentLaneId: "s-main", status: snapshot.lane.status),
      ],
      children: [],
      stateSnapshot: nil,
      rebaseSuggestion: nil,
      autoRebaseStatus: nil,
      conflictStatus: nil,
      overlaps: [],
      syncStatus: GitUpstreamSyncStatus(
        hasUpstream: true,
        upstreamRef: "origin/ade/fix-sync-loop-2f81",
        ahead: 3,
        behind: 0,
        diverged: false,
        recommendedAction: "push"
      ),
      conflictState: nil,
      recentCommits: [
        GitCommitSummary(
          sha: "602290b33aa",
          shortSha: "602290b",
          parents: ["d8febdd"],
          authorName: "arul",
          authoredAt: iso(3_600),
          subject: "fix(ios): keep a reconnect from dropping the lane roster",
          pushed: true
        ),
        GitCommitSummary(
          sha: "d8febdd20bb",
          shortSha: "d8febdd",
          parents: ["e348c0e"],
          authorName: "arul",
          authoredAt: iso(9_000),
          subject: "feat(ios): split lanes and PRs on the inner display",
          pushed: true
        ),
        GitCommitSummary(
          sha: "e348c0e11cc",
          shortSha: "e348c0e",
          parents: [],
          authorName: "arul",
          authoredAt: iso(86_400),
          subject: "feat(ios): route lane calls to the owner machine",
          pushed: true
        ),
      ],
      diffChanges: DiffChanges(
        unstaged: [
          FileChange(
            path: "apps/ios/ADE/Views/Duo/DuoSplitScreens.swift",
            kind: "modified",
            oldPath: nil,
            additions: 220,
            deletions: 4
          ),
          FileChange(
            path: "apps/ios/ADE/Views/LanesTabView.swift",
            kind: "modified",
            oldPath: nil,
            additions: 12,
            deletions: 2
          ),
        ],
        staged: [
          FileChange(
            path: "apps/ios/ADE/Views/Lanes/LaneDetailScreen.swift",
            kind: "modified",
            oldPath: nil,
            additions: 8,
            deletions: 6
          )
        ]
      ),
      stashes: [
        GitStashSummary(ref: "stash@{0}", subject: "WIP on ade/fix-sync-loop-2f81: probe the reconnect", createdAt: iso(2 * 86_400))
      ],
      envInitProgress: nil,
      sessions: [],
      chatSessions: [
        chat("chat-1", "Fix the reconnect loop on the lane roster", model: "claude-opus-5-5", status: "active", ago: 120),
        chat("chat-2", "Write the Duo split fixtures", model: "gpt-5.3-codex", provider: "codex", status: "idle", ago: 3_600),
        chat("chat-3", "Review the sync service change", model: "claude-sonnet-5", status: "ended", ago: 86_400),
      ]
    )
  }

  /// A chat summary as a host would send it.
  static func chat(
    _ id: String,
    _ title: String,
    model: String,
    provider: String = "claude",
    status: String,
    ago: TimeInterval
  ) -> AgentChatSessionSummary {
    let payload: [String: Any] = [
      "sessionId": id, "laneId": "s-sync", "provider": provider, "model": model, "status": status,
      "startedAt": iso(ago + 600), "lastActivityAt": iso(ago), "title": title,
    ]
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
    return (try? JSONDecoder().decode(AgentChatSessionSummary.self, from: data))!
  }

  static let fileDiff = FileDiff(
    path: "apps/ios/ADE/Views/Duo/DuoSplitScreens.swift",
    mode: "unstaged",
    original: DiffSide(exists: true, text: "struct DuoSplitScaffold: View {\n  var body: some View {\n    HStack { list; detail }\n  }\n}\n", size: 80),
    modified: DiffSide(exists: true, text: "struct DuoSplitScaffold: View {\n  var adaptive = false\n  var body: some View {\n    HStack { list; DuoSeam(axis: .vertical); detail }\n  }\n}\n", size: 120),
    isBinary: false,
    language: "swift"
  )

  static let workspace = FilesWorkspace(
    id: "s-sync",
    kind: "worktree",
    laneId: "s-sync",
    name: "fix sync loop",
    branchRef: "ade/fix-sync-loop-2f81",
    rootPath: "/Users/arul/ADE/.ade/worktrees/fix-sync-loop",
    isReadOnlyByDefault: false
  )

  static let fileNodes: [FileTreeNode] = [
    FileTreeNode(name: "App", path: "apps/ios/ADE/App", type: "directory", hasChildren: true, children: nil, changeStatus: nil, size: nil),
    FileTreeNode(name: "Views", path: "apps/ios/ADE/Views", type: "directory", hasChildren: true, children: nil, changeStatus: nil, size: nil),
    FileTreeNode(
      name: "DuoSplitScreens.swift",
      path: "apps/ios/ADE/Views/Duo/DuoSplitScreens.swift",
      type: "file",
      hasChildren: nil,
      children: nil,
      changeStatus: "modified",
      size: 8_420
    ),
    FileTreeNode(
      name: "LanesTabView.swift",
      path: "apps/ios/ADE/Views/LanesTabView.swift",
      type: "file",
      hasChildren: nil,
      children: nil,
      changeStatus: "modified",
      size: 15_960
    ),
    FileTreeNode(
      name: "PrsRootScreen.swift",
      path: "apps/ios/ADE/Views/PRs/PrsRootScreen.swift",
      type: "file",
      hasChildren: nil,
      children: nil,
      changeStatus: nil,
      size: 52_118
    ),
    FileTreeNode(
      name: "FilesRootScreen.swift",
      path: "apps/ios/ADE/Views/Files/FilesRootScreen.swift",
      type: "file",
      hasChildren: nil,
      children: nil,
      changeStatus: "added",
      size: 9_204
    ),
  ]

  static let swiftSource = """
  import SwiftUI

  // MARK: - The split frame

  /// The list-and-detail frame the Duo's inner display gives the Lanes, PRs and
  /// Files tabs: a desktop-style sidebar on the left, the selected thing on the
  /// right. The sidebar keeps its width; the detail column takes the rest.
  struct DuoSplitScaffold<ListColumn: View, DetailColumn: View>: View {
    var preferredListWidth: CGFloat = 320
    var minimumDetailWidth: CGFloat = 360
    @ViewBuilder var list: (CGFloat) -> ListColumn
    @ViewBuilder var detail: () -> DetailColumn

    var body: some View {
      DuoLocalFoldReader { fold, size, _ in
        let metrics = DuoSplitMetrics(fold: fold, size: size)
        HStack(spacing: 0) {
          list(metrics.listWidth)
            .frame(width: metrics.listWidth)
          ZStack {
            ADEColor.pageBackground
            if metrics.showsDividerRule {
              Rectangle()
                .fill(ADEKit.rule)
                .frame(width: 1)
            }
          }
          .frame(width: metrics.gutterWidth)
          detail()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .background(ADEColor.pageBackground)
      }
    }
  }

  /// How wide each column is for one fold. A book fold hands the left page to
  /// the sidebar and starts the detail at the hinge.
  struct DuoSplitMetrics: Equatable {
    var listWidth: CGFloat
    var gutterWidth: CGFloat
    var showsDividerRule: Bool

    init(fold: DuoFold, size: CGSize) {
      let available = max(0, size.width)
      var width: CGFloat = 320
      var gutter: CGFloat = 1
      var showsRule = true
      if case .sideBySide(let rect) = fold, rect.minX > 0 {
        width = rect.minX
        gutter = min(max(rect.width, 1), 48)
        showsRule = false
      }
      let ceiling = max(200, available - 360 - gutter)
      self.listWidth = min(max(width, 220), ceiling)
      self.gutterWidth = gutter
      self.showsDividerRule = showsRule
    }
  }
  """
}
#endif
