import SwiftUI

// MARK: - The split frame

/// The list-and-detail frame the Duo's inner display gives the Lanes, PRs and
/// Files tabs: a desktop-style sidebar on the left, the selected thing on the
/// right. The sidebar keeps its width; the detail column takes the rest.
///
/// Book-folded, the column edge sits on the fold so each page keeps its own
/// pane. Laptop and tent postures keep the columns side by side: their top half
/// is read from a distance, so it must not carry the whole reading pane. The
/// tab bars above each column stay clear of the horizontal fold.
struct DuoSplitScaffold<ListColumn: View, DetailColumn: View>: View {
  /// The sidebar's width when the screen is not book-folded.
  var preferredListWidth: CGFloat = 320
  /// Below this the detail column stops being readable; the sidebar gives up
  /// the room first.
  var minimumDetailWidth: CGFloat = 360
  @ViewBuilder var list: (CGFloat) -> ListColumn
  @ViewBuilder var detail: () -> DetailColumn

  var body: some View {
    DuoLocalFoldReader { fold, size in
      let metrics = DuoSplitMetrics(
        fold: fold,
        size: size,
        preferredListWidth: preferredListWidth,
        minimumDetailWidth: minimumDetailWidth
      )
      HStack(spacing: 0) {
        list(metrics.listWidth)
          .frame(width: metrics.listWidth)
          .frame(maxHeight: .infinity, alignment: .top)
        // The gutter is page, never a dark band: when the screen is book-folded
        // the hinge itself separates the pages, so only the unfolded columns
        // get a hairline.
        ZStack {
          ADEColor.pageBackground
          if metrics.showsDividerRule {
            Rectangle()
              .fill(ADEKit.rule)
              .frame(width: 1)
          }
        }
        .frame(width: metrics.gutterWidth)
        .frame(maxHeight: .infinity)
        .accessibilityHidden(true)
        detail()
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(ADEColor.pageBackground)
    }
  }
}

/// How wide each column is for one fold. A book fold hands the left page to
/// the sidebar and starts the detail at the hinge; every other posture keeps a
/// normal sidebar width.
struct DuoSplitMetrics: Equatable {
  var listWidth: CGFloat
  /// The space between the columns: the hinge's own width when book-folded, so
  /// nothing is drawn across it.
  var gutterWidth: CGFloat
  /// A hairline between two columns that share one continuous screen. Book-
  /// folded, the hinge is the divider and no line is drawn.
  var showsDividerRule: Bool

  init(
    fold: DuoFold,
    size: CGSize,
    preferredListWidth: CGFloat = 320,
    minimumDetailWidth: CGFloat = 360
  ) {
    let available = max(0, size.width)
    var width = preferredListWidth
    var gutter: CGFloat = 1
    var showsRule = true
    if case .sideBySide(let rect) = fold, rect.minX > 0 {
      width = rect.minX
      gutter = min(max(rect.width, 1), 48)
      showsRule = false
    }
    // A folded page is the sidebar, but never squeeze the detail below
    // something readable and never let the sidebar take the whole screen.
    let ceiling = max(200, available - minimumDetailWidth - gutter)
    let floor: CGFloat = 220
    width = min(max(width, floor), ceiling)
    self.listWidth = min(max(width, 0), available)
    self.gutterWidth = min(gutter, available)
    self.showsDividerRule = showsRule
  }
}

/// What a detail column says before anything is selected. Calm on purpose: it
/// is a resting place, not an error.
struct DuoSplitPlaceholder: View {
  let symbol: String
  let title: String
  let message: String

  var body: some View {
    VStack(spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 30, weight: .light))
        .foregroundStyle(ADEColor.textMuted)
      Text(title)
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Text(message)
        .font(.footnote)
        .foregroundStyle(ADEColor.textMuted)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: 300)
    }
    .padding(32)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ADEColor.surfaceBackground)
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Lanes

extension LanesTabView {
  /// The Lanes tab on the Duo's inner display: the lane list and the selected
  /// lane's detail as two columns. Selecting a row fills the detail column
  /// instead of pushing.
  @ViewBuilder
  var duoLanesSplitBody: some View {
    DuoSplitScaffold { _ in
      duoLanesListColumn
    } detail: {
      duoLaneDetailColumn
    }
    .adeScreenBackground()
  }

  /// The same search, filters, notices, tray and rows the phone list draws.
  var duoLanesListColumn: some View {
    List {
      Section {
        laneSearchField
          .adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 6, trailing: 16), separator: .hidden)
        if !laneSnapshots.isEmpty {
          laneQuickFilterChips
            .adeFlatRow(insets: EdgeInsets(top: 2, leading: 0, bottom: 8, trailing: 0), separator: .hidden)
        }
        if !remoteLanes.machines.isEmpty {
          laneMachineFilterChips
            .adeFlatRow(insets: EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16), separator: .hidden)
        }
        laneNoticeRows
        if showsLaneLoadingSkeletons {
          ForEach(0..<5, id: \.self) { _ in
            LaneRowSkeleton()
              .adeFlatRow(insets: laneRowInsets)
          }
        }
        if !openLaneSnapshots.isEmpty {
          openLanesTray
            .adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 10, trailing: 16), separator: .hidden)
        }
      }
      laneListSections
    }
    .adeFlatList()
    .listSectionSpacing(.compact)
    .contentMargins(.bottom, 24, for: .scrollContent)
    .environment(\.defaultMinListRowHeight, 0)
    .adeScrollDiagnosticsSurface(.lanes, key: "lanes-split")
    .refreshable { await refreshFromPullGesture() }
    .safeAreaInset(edge: .top, spacing: 0) {
      ADERootTopBar(title: "Lanes") {
        addLaneActionButton
      }
    }
  }

  @ViewBuilder
  var duoLaneDetailColumn: some View {
    if let laneId = duoSelectedLaneId, duoLaneIsAvailable(laneId) {
      // A fresh screen per lane: the detail's own state (diffs, commit field,
      // disclosures) belongs to one lane, never the previous one.
      NavigationStack {
        laneDestination(LaneRoute(laneId: laneId), showsBackButton: false)
      }
      .id(laneId)
    } else {
      DuoSplitPlaceholder(
        symbol: "square.stack.3d.up",
        title: "Select a lane",
        message: "Pick a lane to see its branch, changes, commits and git actions."
      )
    }
  }

  /// A selected lane can be this machine's or another machine's row.
  func duoLaneIsAvailable(_ laneId: String) -> Bool {
    laneSnapshots.contains { $0.lane.id == laneId }
      || remoteLanes.machines.contains { machine in
        machine.snapshots.contains { $0.lane.id == laneId }
      }
  }
}

// MARK: - PRs

extension PRsTabView {
  /// The PRs tab on the Duo's inner display: the PR list and the selected PR's
  /// detail. Pushes made inside the detail (a rebase, a file) stay in its
  /// column.
  @ViewBuilder
  var duoPrsSplitBody: some View {
    DuoSplitScaffold { _ in
      duoPrsListColumn
    } detail: {
      duoPrDetailColumn
    }
  }

  /// The phone list with its own toolbar and search, as the sidebar.
  var duoPrsListColumn: some View {
    NavigationStack {
      List {
        noticeRows
        if isLoadingSkeleton {
          Section {
            ForEach(0..<4, id: \.self) { _ in
              PrRowCardSkeleton().adeFlatRow()
            }
          }
        } else {
          switch selectedRootSurface.wrappedValue {
          case .github:
            githubSurfaceRows
          case .workflows:
            workflowsSurfaceRows
          }
        }
      }
      .adeFlatList()
      .contentMargins(.bottom, 24, for: .scrollContent)
      .adeScrollDiagnosticsSurface(.prList, key: "pr-list-split")
      .searchable(
        text: $searchText,
        isPresented: $searchPresented,
        placement: .navigationBarDrawer(displayMode: .automatic),
        prompt: selectedRootSurface.wrappedValue == .github ? "Search PRs, branches, authors" : "Search workflows"
      )
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { prsToolbar }
      .adeToast($toast)
      .refreshable { await refreshFromPullGesture() }
    }
  }

  @ViewBuilder
  var duoPrDetailColumn: some View {
    if let prId = duoSelectedPrId {
      NavigationStack {
        duoPrDetail(prId)
      }
      .id(prId)
    } else {
      DuoSplitPlaceholder(
        symbol: "arrow.triangle.pull",
        title: "Select a pull request",
        message: "Choose a pull request to read its description, review threads, files and checks."
      )
    }
  }
}

// MARK: - Files

extension FilesRootScreen {
  /// The Files tab on the Duo's inner display: the folder list on the left and
  /// the open file on the right. Folders browse in the list column; a file
  /// opens in the viewer column and stays open while the list moves.
  @ViewBuilder
  var duoFilesSplitBody: some View {
    DuoSplitScaffold { _ in
      duoFilesListColumn
    } detail: {
      duoFilesDetailColumn
    }
  }

  var duoFilesListColumn: some View {
    let folderPath = duoFilesFolderPath
    return ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        filesListPreamble

        if let workspace = selectedWorkspace {
          FilesWorkspaceHeader(
            workspaces: workspaces,
            lanes: lanes,
            selectedWorkspaceId: selectedWorkspaceBinding,
            selectedWorkspace: workspace,
            isLive: canUseLiveFileActions
          )

          if !folderPath.isEmpty {
            FilesBreadcrumbBar(
              relativePath: folderPath,
              includeCurrentFile: false,
              onSelectDirectory: { path in
                duoFolderPath = path
              }
            )
            .padding(.horizontal, 2)
          }

          FilesDirectoryContentsView(
            workspace: workspace,
            parentPath: folderPath,
            isLive: canUseLiveFileActions,
            isTabActive: isTabActive,
            openDirectory: { path in
              selectedFileTransitionPath = nil
              duoFolderPath = path
            },
            openFile: { path, line in
              openFile(path, in: workspace, focusLine: line)
            },
            transitionNamespace: transitionNamespace,
            selectedFilePath: selectedFileTransitionPath,
            manualReloadToken: 0
          )
          .environmentObject(syncService)

          if workspace.laneId != nil {
            FilesProofSection(
              artifacts: proofArtifacts,
              errorMessage: proofErrorMessage,
              onRefresh: { Task { await loadProofArtifacts() } },
              onOpenArtifact: { artifact in
                selectedProofArtifact = artifact
              },
              onCopyReference: { artifact in
                UIPasteboard.general.string = artifact.uri
              }
            )
          }
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .scrollDismissesKeyboard(.interactively)
    .scrollBounceBehavior(.basedOnSize)
    .contentMargins(.bottom, 24, for: .scrollContent)
    .adeScreenBackground()
    .refreshable { await refreshFromPullGesture() }
    .safeAreaInset(edge: .top, spacing: 0) {
      ADERootTopBar(title: "Files") {
        filesTopBarActions
      }
    }
  }

  @ViewBuilder
  var duoFilesDetailColumn: some View {
    if let editor = duoFilesOpenEditor,
      let workspace = workspaces.first(where: { $0.id == editor.workspaceId })
    {
      NavigationStack {
        FilesDetailScreen(
          workspace: workspace,
          relativePath: editor.path,
          focusLine: editor.focusLine,
          transitionNamespace: nil,
          navigateToDirectory: { path in
            duoFolderPath = path
          }
        )
        .environmentObject(syncService)
      }
      .id(editor.path)
    } else {
      DuoSplitPlaceholder(
        symbol: "doc.text",
        title: "Select a file",
        message: "Pick a folder in the list, then a file to read it here."
      )
    }
  }

  /// The folder the split's list column shows. Until someone browses there in
  /// the split, it follows the phone's stack so folding or unfolding the device
  /// keeps the reader in the same folder.
  var duoFilesFolderPath: String {
    if let duoFolderPath { return duoFolderPath }
    if case .directory(_, let path)? = navigationPath.last(where: { route in
      if case .directory = route { return true }
      return false
    }) {
      return path
    }
    if let editor = duoFilesOpenEditor {
      return parentDirectory(of: editor.path)
    }
    return ""
  }

  /// The file the split's viewer column shows: the phone's last open file,
  /// unless the split opened one itself.
  var duoFilesOpenEditor: (workspaceId: String, path: String, focusLine: Int?)? {
    for route in navigationPath.reversed() {
      if case .editor(let workspaceId, let relativePath, let focusLine) = route {
        return (workspaceId, relativePath, focusLine)
      }
    }
    return nil
  }
}

// MARK: - Fixtures

#if DEBUG
/// Fixture screens for this area, routed by `DuoPreviewRouter`.
///
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-lanes
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-prs
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-files
enum DuoSplitPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-lanes": return AnyView(DuoLanesFixtureScreen())
    case "duo-prs": return AnyView(DuoPrsFixtureScreen())
    case "duo-files": return AnyView(DuoFilesFixtureScreen())
    default: return nil
    }
  }
}

// MARK: Lanes fixture

private struct DuoLanesFixtureScreen: View {
  @State private var selection = "s-sync"
  @State private var filter: LaneQuickFilter = .active
  @State private var search = ""

  private var selectedSnapshot: LaneListSnapshot? {
    DuoSplitFixtureData.lanes.first { $0.lane.id == selection }
  }

  private var visibleLanes: [LaneListSnapshot] {
    DuoSplitFixtureData.lanes
      .filter(filter.matches)
      .filter { snapshot in
        search.isEmpty
          || snapshot.lane.name.localizedCaseInsensitiveContains(search)
          || snapshot.lane.branchRef.localizedCaseInsensitiveContains(search)
      }
  }

  var body: some View {
    VStack(spacing: 0) {
      ADERootTopBar(title: "Lanes", showsGlobalControls: false) {
        LaneAddButton(enabled: true) {}
      }
      DuoSplitScaffold { _ in
        List {
          Section {
            duoFixtureSearchField("Search lanes, branches, is:dirty", text: $search)
              .adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 6, trailing: 16), separator: .hidden)
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 7) {
                ForEach(LaneQuickFilter.allCases) { filter in
                  LaneQuickFilterChip(
                    title: filter.title,
                    count: DuoSplitFixtureData.lanes.filter(filter.matches).count,
                    tone: filter == .attention ? ADEColor.warning : nil,
                    selected: self.filter == filter
                  ) {
                    self.filter = filter
                  }
                }
              }
              .padding(.horizontal, 16)
              .padding(.vertical, 1)
            }
            .scrollClipDisabled()
            .adeFlatRow(insets: EdgeInsets(top: 2, leading: 0, bottom: 8, trailing: 0), separator: .hidden)
            ScrollView(.horizontal, showsIndicators: false) {
              HStack(spacing: 7) {
                LaneMachineFilterChip(title: "All", symbol: "square.stack.3d.up", liveDot: nil, selected: false) {}
                LaneMachineFilterChip(title: "Arul’s Mac Studio", symbol: "desktopcomputer", liveDot: true, selected: true) {}
                LaneMachineFilterChip(title: "MacBook Pro (97)", symbol: "laptopcomputer", liveDot: true, selected: false) {}
              }
              .padding(.horizontal, 16)
              .padding(.vertical, 1)
            }
            .scrollClipDisabled()
            .adeFlatRow(insets: EdgeInsets(top: 0, leading: 0, bottom: 8, trailing: 0), separator: .hidden)
          }
          Section {
            ForEach(visibleLanes) { snapshot in
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
              .adeFlatRow(insets: EdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 6))
              .listRowBackground(selection == snapshot.lane.id ? ADEColor.accent.opacity(0.12) : Color.clear)
            }
          } header: {
            ADEFlatSectionHeader("Arul’s Mac Studio", detail: "\(visibleLanes.count)")
          }
        }
        .adeFlatList()
        .listSectionSpacing(.compact)
        .contentMargins(.bottom, 24, for: .scrollContent)
      } detail: {
        if let snapshot = selectedSnapshot {
          NavigationStack {
            DuoLaneDetailFixture(snapshot: snapshot)
          }
          .id(snapshot.lane.id)
        } else {
          DuoSplitPlaceholder(
            symbol: "square.stack.3d.up",
            title: "Select a lane",
            message: "Pick a lane to see its branch, changes, commits and git actions."
          )
        }
      }
    }
    .adeScreenBackground()
  }
}

/// The real lane detail body over fixture data: header plus the git actions
/// pane, with no service reads.
private struct DuoLaneDetailFixture: View {
  let snapshot: LaneListSnapshot
  @State private var commitMessage = ""
  @State private var amendCommit = false
  @State private var stashMessage = ""

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 7) {
        WorkLaneLogoMark(
          color: laneSurfaceTint(forHex: snapshot.lane.color).text ?? ADEColor.accent,
          laneIcon: snapshot.lane.icon,
          emoji: snapshot.lane.emoji,
          size: 14
        )
        Text(snapshot.lane.name)
          .font(.system(size: 17, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Spacer(minLength: 8)
        Image(systemName: "ellipsis")
          .font(.system(size: 16, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .frame(width: 36, height: 32)
      }
      .padding(.horizontal, 16)
      .frame(height: 44)
      .background(ADEColor.pageBackground)

      LaneDetailGitActionsPane(
        snapshot: snapshot,
        detail: DuoSplitFixtureData.laneDetail(snapshot),
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
        onOpenDiff: { _, _ in },
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
    .adeScreenBackground()
  }
}

// MARK: PRs fixture

private struct DuoPrsFixtureScreen: View {
  @State private var selection = 1367
  @State private var category = PrGitHubCategory.open
  @State private var search = ""

  private var items: [GitHubPrListItem] {
    PrFlatPreviewData.mergedItems.filter { item in
      search.isEmpty || item.title.localizedCaseInsensitiveContains(search)
    }
  }

  private var selectedItem: GitHubPrListItem? {
    items.first { $0.githubPrNumber == selection } ?? items.first
  }

  var body: some View {
    VStack(spacing: 0) {
      ADERootTopBar(title: "PRs", showsGlobalControls: false) {
        Button {} label: { ADEKitCircleIcon(systemImage: "magnifyingglass") }
          .buttonStyle(.plain)
          .accessibilityLabel("Search pull requests")
        Button {} label: { ADEKitCircleIcon(systemImage: "plus") }
          .buttonStyle(.plain)
          .accessibilityLabel("Create pull request")
      }
      DuoSplitScaffold { _ in
        List {
          Section {
            Picker("Status", selection: $category) {
              Text(verbatim: "Open 17").tag(PrGitHubCategory.open)
              Text(verbatim: "Merged 1035").tag(PrGitHubCategory.merged)
              Text(verbatim: "Closed 167").tag(PrGitHubCategory.closed)
            }
            .pickerStyle(.segmented)
            .adeFlatRow(insets: EdgeInsets(top: 2, leading: 16, bottom: 8, trailing: 16), separator: .hidden)
            duoFixtureSearchField("Search PRs, branches, authors", text: $search)
              .adeFlatRow(insets: EdgeInsets(top: 0, leading: 16, bottom: 8, trailing: 16), separator: .hidden)
          }
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
              .adeFlatRow(insets: EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16))
              .listRowBackground(selection == item.githubPrNumber ? ADEColor.accent.opacity(0.12) : Color.clear)
            }
          } header: {
            ADEFlatSectionHeader("Open", detail: "\(items.count)")
          }
        }
        .adeFlatList()
        .contentMargins(.bottom, 24, for: .scrollContent)
      } detail: {
        DuoPrDetailFixture(item: selectedItem)
      }
    }
    .adeScreenBackground()
  }
}

/// The flat PR detail over fixture data: header, the Overview/Files/Checks
/// tabs, and the next-step bar.
private struct DuoPrDetailFixture: View {
  let item: GitHubPrListItem?
  @State private var tab: PrDetailTab = .overview

  var body: some View {
    let pr = PrFlatPreviewData.pr(state: "open")
    let snapshot = PrFlatPreviewData.snapshot()
    let cleaned = prCleanBody(snapshot.detail?.body)
    let inputs = prDigestInputs(
      pr: pr,
      snapshot: snapshot,
      reviewThreads: PrFlatPreviewData.threads,
      activity: PrFlatPreviewData.activity,
      bodySections: cleaned.sections
    )
    let digest = buildPrConversationDigest(commits: inputs.commits, entries: inputs.entries, story: inputs.story)
    let step = PrNextStep.resolve(PrNextStepInput(
      state: "open",
      mergeStateStatus: nil,
      mergeConflicts: false,
      behindBaseBy: nil,
      mergeabilityComputing: false,
      checksStatus: "failing",
      failingChecks: 1,
      pendingChecks: 1,
      passingChecks: 4,
      reviewDecision: nil,
      approvalsCount: nil,
      requiredApprovals: nil,
      changesRequestedBy: [],
      unresolvedThreads: 2,
      canBypass: false,
      autoMergeAllowed: nil,
      autoMergeEnabled: false,
      autoMergeMethod: nil,
      baseBranch: "main"
    ))
    NavigationStack {
      List {
        Section {
          PrFlatDetailHeader(
            createdAt: item?.createdAt ?? pr.createdAt,
            updatedAt: item?.updatedAt ?? pr.updatedAt,
            title: item?.title ?? pr.title,
            baseBranch: item?.baseBranch ?? pr.baseBranch,
            headBranch: item?.headBranch ?? pr.headBranch,
            laneName: item?.linkedLaneName ?? "cross-machine",
            ghostLaneName: nil,
            machineName: item?.linkedLaneId?.hasPrefix("fleet|") == true ? "MacBook Pro" : nil,
            stackLabel: nil,
            onOpenLane: {},
            onOpenStack: nil,
            canCreateLane: true,
            canLinkLane: true,
            onCreateLane: {},
            onLinkLane: {}
          )
          .adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 12, trailing: 16), separator: .hidden)
          Picker("Section", selection: $tab) {
            Text("Overview").tag(PrDetailTab.overview)
            Text("Files \(snapshot.files.count)").tag(PrDetailTab.files)
            Text("Checks \(snapshot.checks.count)").tag(PrDetailTab.checks)
          }
          .pickerStyle(.segmented)
          .adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16), separator: .hidden)
        }
        switch tab {
        case .overview, .activity:
          PrOverviewSections(
            description: cleaned.body,
            digest: digest,
            threadsById: Dictionary(uniqueKeysWithValues: PrFlatPreviewData.threads.map { ($0.id, $0) }),
            canAct: true,
            onReply: { _, _ in },
            onResolve: { _, _ in }
          )
        case .files:
          PrFilesSections(
            files: snapshot.files,
            isLoading: false,
            canOpenFiles: true,
            onOpenFile: { _ in },
            onCopyPath: { _ in }
          )
        case .checks:
          PrChecksSections(
            checks: snapshot.checks,
            overallChecksStatus: "failing",
            checksReason: nil,
            missingRequired: [],
            actionRuns: PrFlatPreviewData.actionRuns,
            deployments: [],
            canRerun: true,
            onRerun: {}
          )
        }
      }
      .adeFlatList()
      .listSectionSpacing(.compact)
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .principal) {
          PrFlatDetailNavTitle(
            number: item?.githubPrNumber ?? 1367,
            author: item?.author ?? "arul28",
            authorIsBot: item?.isBot ?? false,
            state: item?.state ?? "open"
          )
        }
        ToolbarItem(placement: .topBarTrailing) {
          Image(systemName: "ellipsis")
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .frame(width: 36, height: 32)
        }
      }
      .safeAreaInset(edge: .bottom) {
        PrNextStepFlatBar(step: step, isBusy: false, busyLabel: nil, onTapText: {}) {
          Button {} label: {
            Text("Merge")
              .font(.subheadline.weight(.semibold))
          }
          .buttonStyle(.glassProminent)
          .tint(ADEColor.success)
        }
      }
    }
  }
}

// MARK: Files fixture

private struct DuoFilesFixtureScreen: View {
  @State private var selection = "apps/ios/ADE/Views/Duo/DuoSplitScreens.swift"

  private var workspace: FilesWorkspace { DuoSplitFixtureData.workspace }

  var body: some View {
    VStack(spacing: 0) {
      ADERootTopBar(title: "Files", showsGlobalControls: false) {
        Button {} label: { ADEKitCircleIcon(systemImage: "magnifyingglass") }
          .buttonStyle(.plain)
          .accessibilityLabel("Search files")
        Button {} label: { ADEKitCircleIcon(systemImage: "arrow.clockwise") }
          .buttonStyle(.plain)
          .accessibilityLabel("Refresh files")
      }
      DuoSplitScaffold { _ in
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 14) {
            FilesWorkspaceHeader(
              workspaces: [workspace],
              lanes: [],
              selectedWorkspaceId: .constant(workspace.id),
              selectedWorkspace: workspace,
              isLive: true
            )
            FilesBreadcrumbBar(
              relativePath: "apps/ios/ADE/Views/Duo",
              includeCurrentFile: false,
              onSelectDirectory: { _ in }
            )
            .padding(.horizontal, 2)
            LazyVStack(spacing: 0) {
              ForEach(Array(DuoSplitFixtureData.fileNodes.enumerated()), id: \.element.id) { index, node in
                if index > 0 {
                  Rectangle().fill(ADEKit.rule).frame(height: 0.75).padding(.leading, 44)
                }
                FilesTreeNodeRow(
                  workspaceId: workspace.id,
                  node: node,
                  transitionNamespace: nil,
                  isSelectedTransitionSource: selection == node.path,
                  onOpen: {
                    if node.type == "file" { selection = node.path }
                  },
                  onCopyPath: {},
                  onCopyRelativePath: {}
                )
                .background(selection == node.path ? ADEColor.accent.opacity(0.12) : Color.clear)
              }
            }
            .adeKitCard(padding: nil)
          }
          .padding(.horizontal, 16)
          .padding(.vertical, 8)
        }
        .scrollBounceBehavior(.basedOnSize)
        .adeScreenBackground()
      } detail: {
        NavigationStack {
          DuoFileViewerFixture(path: selection)
        }
        .id(selection)
      }
    }
    .adeScreenBackground()
  }
}

/// The real file viewer's shape over fixture source: breadcrumb, language row,
/// then the highlighted file.
private struct DuoFileViewerFixture: View {
  let path: String

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 6) {
        FilesBreadcrumbBar(
          relativePath: path,
          includeCurrentFile: true,
          onSelectDirectory: { _ in }
        )
        HStack(spacing: 8) {
          Text(FilesLanguage.detect(languageId: nil, filePath: path).displayName)
            .font(.system(size: 12, weight: .medium))
            .foregroundStyle(ADEColor.textSecondary)
          Text("\(DuoSplitFixtureData.swiftSource.count) bytes")
            .font(.adeMono(11))
            .foregroundStyle(ADEColor.textMuted)
          Spacer(minLength: 8)
          Image(systemName: "ellipsis.circle")
            .font(.system(size: 15))
            .foregroundStyle(ADEColor.textMuted)
          Image(systemName: "info.circle")
            .font(.system(size: 15))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 8)

      ScrollView {
        SyntaxHighlightedCodeView(
          text: DuoSplitFixtureData.swiftSource,
          language: .swift,
          focusLine: nil,
          layoutMode: .wrap
        )
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
      }
    }
    .adeScreenBackground()
  }
}

/// The list's own search field, matching `LanesTabView.laneSearchField`.
private func duoFixtureSearchField(_ prompt: String, text: Binding<String>) -> some View {
  HStack(spacing: 8) {
    Image(systemName: "magnifyingglass")
      .font(.system(size: 14, weight: .medium))
      .foregroundStyle(ADEColor.textMuted)
    TextField(prompt, text: text)
      .font(.system(size: 15))
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled()
    if !text.wrappedValue.isEmpty {
      Button {
        text.wrappedValue = ""
      } label: {
        Image(systemName: "xmark.circle.fill")
          .font(.system(size: 15))
          .foregroundStyle(ADEColor.textMuted)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Clear search")
    }
  }
  .padding(.horizontal, 12)
  .frame(height: 38)
  .background(ADEKit.track, in: RoundedRectangle(cornerRadius: 11, style: .continuous))
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
      stackChain: [],
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
      chatSessions: []
    )
  }

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
      DuoLocalFoldReader { fold, size in
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
