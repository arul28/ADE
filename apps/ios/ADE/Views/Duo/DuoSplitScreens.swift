import SwiftUI

// MARK: - The split frame

/// What a split's detail column reads about the split around it, and asks of
/// it: the layout family, whether the list column is folded behind a toggle,
/// and whether the detail wants the whole width for now (a PR's Files tab).
@Observable
final class DuoSplitModel {
  /// The family of the whole split, not of the detail column alone.
  var family: DuoFamily = .wide
  /// The list is folded away and the detail's sidebar toggle brings it back
  /// as an overlay.
  var listCollapsible = false
  /// The folded list is showing beside the detail.
  var listShown = false
  /// The detail asked for every column the screen has.
  var detailWantsFullWidth = false

  func toggleList() {
    listShown.toggle()
  }

  func setDetailWantsFullWidth(_ wants: Bool) {
    guard detailWantsFullWidth != wants else { return }
    detailWantsFullWidth = wants
  }
}

extension EnvironmentValues {
  /// The split the view sits in, or nil outside one (the phone, a sheet).
  @Entry var duoSplit: DuoSplitModel? = nil
}

/// The detail column's sidebar toggle: shown only while the split can fold
/// its list away (held portrait, or a detail that took the width).
struct DuoSplitListToggle: ToolbarContent {
  let split: DuoSplitModel?

  var body: some ToolbarContent {
    if let split, split.listCollapsible {
      ToolbarItem(placement: .topBarLeading) {
        Button(split.listShown ? "Hide list" : "Show list", systemImage: "sidebar.left") {
          withAnimation(.spring(response: 0.35, dampingFraction: 0.86)) { split.toggleList() }
        }
      }
    }
  }
}

/// The list-and-detail frame the Duo's inner display gives the Lanes, PRs and
/// Files tabs: a desktop-style list column on the left, the selected thing on
/// the right. The list keeps its width; the detail column takes the rest.
///
/// Book-folded, the column edge sits on the fold so each page keeps its own
/// pane, and the hinge is the only divider.
///
/// `adaptive` screens (PRs, Lanes) also follow the Duo's families: held
/// portrait the list folds behind the detail's sidebar toggle and comes back
/// beside it; a detail that needs both pages (`detailTakesBothPages`
/// book-folded, or a detail that asks through `DuoSplitModel`) folds it the
/// same way. The detail column keeps its identity through all of it, so its
/// state (the open tab, the scroll) survives a fold.
struct DuoSplitScaffold<ListColumn: View, DetailColumn: View>: View {
  /// The sidebar's width when the screen is not book-folded.
  var preferredListWidth: CGFloat = 320
  /// Below this the detail column stops being readable; the sidebar gives up
  /// the room first.
  var minimumDetailWidth: CGFloat = 360
  var adaptive = false
  /// Book-folded, the detail takes both pages (Lanes: dashboard | git).
  var detailTakesBothPages = false
  /// The selected row. Picking one closes the list's overlay.
  var selection: String? = nil
  /// Held landscape, ask the app shell to fold its sidebar away while this
  /// is true: list, detail and the edge bar need the whole display.
  var wantsWholeDisplay = false
  @ViewBuilder var list: (CGFloat) -> ListColumn
  @ViewBuilder var detail: () -> DetailColumn

  @Environment(\.duoLayout) private var duo
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var model = DuoSplitModel()

  private struct Arrangement: Equatable {
    var family: DuoFamily
    var collapsible: Bool
    var hidesShellSidebar: Bool
  }

  var body: some View {
    DuoLocalFoldReader { fold, size in
      let metrics = DuoSplitMetrics(
        fold: fold,
        size: size,
        preferredListWidth: preferredListWidth,
        minimumDetailWidth: minimumDetailWidth
      )
      let family = adaptive ? duo.family(for: size) : .wide
      let bookFolded: Bool = {
        if case .sideBySide = fold { return true }
        return false
      }()
      let collapsible = adaptive
        && (family == .tall || model.detailWantsFullWidth || (detailTakesBothPages && bookFolded))
      let arrangement = Arrangement(
        family: family,
        collapsible: collapsible,
        hidesShellSidebar: adaptive && wantsWholeDisplay && family == .wide
      )
      let foldedListWidth = family == .tall ? min(preferredListWidth, size.width * 0.45) : metrics.listWidth

      HStack(spacing: 0) {
        // A folded list comes back beside the detail, pushing it over, the
        // way an iPad sidebar does held portrait. The detail stays in the
        // same slot either way, so it keeps its state.
        if !collapsible || model.listShown {
          let width = collapsible ? foldedListWidth : metrics.listWidth
          list(width)
            .frame(width: width)
            .frame(maxHeight: .infinity, alignment: .top)
            .transition(.move(edge: .leading))
          DuoSeam(
            axis: .vertical,
            foldRect: metrics.showsDividerRule ? nil : CGRect(x: 0, y: 0, width: metrics.gutterWidth, height: size.height)
          )
        }
        detail()
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(ADEColor.pageBackground)
      .onChange(of: arrangement, initial: true) { _, next in
        model.family = next.family
        if model.listCollapsible != next.collapsible {
          model.listCollapsible = next.collapsible
          // Held portrait with nothing open, the list is the screen.
          model.listShown = next.collapsible && next.family == .tall && selection == nil
        }
        if adaptive {
          DuoShellChrome.shared.setSidebarPreferredHidden(next.hidesShellSidebar)
        }
      }
    }
    .environment(\.duoSplit, model)
    .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86), value: model.listShown)
    .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86), value: model.detailWantsFullWidth)
    .onChange(of: selection) { _, _ in hideList() }
    .onDisappear {
      if adaptive { DuoShellChrome.shared.setSidebarPreferredHidden(false) }
    }
  }

  private func hideList() {
    guard model.listShown else { return }
    model.listShown = false
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
    var detailFloor = minimumDetailWidth
    if case .sideBySide(let rect) = fold, rect.minX > 0 {
      width = rect.minX
      gutter = min(max(rect.width, 1), 48)
      showsRule = false
      // Book-folded the hinge decides: the list is the whole left page and
      // the detail the right one, even when that page is narrower than the
      // detail would like (a detail across the hinge is worse).
      detailFloor = min(minimumDetailWidth, 240)
    }
    // A folded page is the sidebar, but never squeeze the detail below
    // something readable and never let the sidebar take the whole screen.
    let ceiling = max(200, available - detailFloor - gutter)
    let floor: CGFloat = 220
    width = min(max(width, floor), ceiling)
    self.listWidth = min(max(width, 0), available)
    self.gutterWidth = min(gutter, available)
    self.showsDividerRule = showsRule
  }
}

/// What a detail column says before anything is selected. Calm on purpose: it
/// is a resting place, not an error. Its own stack, so the trailing column
/// still carries the edge bar and its app tabs.
struct DuoSplitPlaceholder: View {
  let symbol: String
  let title: String
  let message: String
  /// Activity and Settings with the tabs; a screen whose list column's ⋯
  /// carries them leaves them off the rail.
  var includesUtilities = true

  var body: some View {
    NavigationStack {
      ContentUnavailableView {
        Label(title, systemImage: symbol)
      } description: {
        Text(message)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(ADEColor.pageBackground)
      .toolbar { DuoAppTabsToolbar(includesUtilities: includesUtilities) }
    }
  }
}

// MARK: - Lanes

extension LanesTabView {
  /// The Lanes tab on the Duo's inner display (and an iPad): the lane list
  /// beside ONE detail column for the selected lane (a header over Overview |
  /// Git). Book-folded the list is the left page and the detail the right;
  /// held portrait the list folds behind the detail's sidebar toggle.
  @ViewBuilder
  var duoLanesSplitBody: some View {
    DuoSplitScaffold(
      preferredListWidth: 320,
      minimumDetailWidth: 420,
      adaptive: true,
      selection: duoSelectedLaneId
    ) { _ in
      duoLanesListColumn
    } detail: {
      duoLaneDetailColumn
    }
    .adeScreenBackground()
  }

  /// The project the tab belongs to, for the header's ‹ logo.
  private var duoProjectIconDataUrl: String? {
    syncService.projects.first { $0.id == syncService.activeProjectId }?.iconDataUrl
  }

  /// The same notices, tray and rows the phone list draws, under Work's
  /// two-row header: ‹ project logo and "Lanes", then search (with the
  /// filter inside it), Add lane and ⋯ (Activity, Settings).
  var duoLanesListColumn: some View {
    NavigationStack {
      List {
        Section {
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
      .safeAreaInset(edge: .top, spacing: 0) { duoLanesSearchRow }
      // The column ends at the seam: the trailing inset iOS reports here is
      // the edge bar's, not this column's.
      .duoLeadingColumnContent()
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          HStack(spacing: 6) {
            WorkHeaderProjectButton(iconDataUrl: duoProjectIconDataUrl) { syncService.showProjectHub() }
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
  }

  /// The column's second header row, Work's: search with the filter inside
  /// it, then Add lane and ⋯.
  private var duoLanesSearchRow: some View {
    HStack(spacing: 8) {
      LaneHeaderSearchField(searchText: $searchText) {
        duoLaneFilterMenuContent
      } filterActive: {
        quickFilter != .active || machineFilter != .all
      }
      Button {
        if canRunLiveActions {
          addLaneSheetPresented = true
        } else {
          handleBlockedLiveAction()
        }
      } label: {
        Image(systemName: "plus")
          .font(.system(size: 18, weight: .medium))
          .foregroundStyle(canRunLiveActions ? ADEColor.textPrimary : ADEColor.textMuted)
          .frame(width: 32, height: 44)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Add lane")
      WorkHeaderOverflowMenu(
        showsLinear: false,
        showsCursorCloud: false,
        actions: WorkRootHeaderActions(
          onOpenActivity: { syncService.attentionDrawerPresented = true },
          onOpenSettings: { syncService.settingsPresented = true }
        )
      )
    }
    .padding(.horizontal, 16)
    .padding(.bottom, 6)
    .background(ADEColor.pageBackground.opacity(0.94))
  }

  /// What the search field's filter chip offers: the lane filter with counts,
  /// and which machines' lanes show.
  @ViewBuilder
  private var duoLaneFilterMenuContent: some View {
    Picker("Show", selection: $quickFilter) {
      ForEach(LaneQuickFilter.allCases) { filter in
        let count = laneListPresentation.quickFilterCounts[filter] ?? 0
        Text("\(filter.title) (\(count))").tag(filter)
      }
    }
    .pickerStyle(.inline)
    if !remoteLanes.machines.isEmpty {
      Section("Machines") {
        duoLaneMachineButtons
      }
    }
  }

  /// Which machines' lanes the list shows.
  @ViewBuilder
  private var duoLaneMachineButtons: some View {
      Button {
        machineFilter = .all
      } label: {
        if machineFilter == .all {
          Label("All machines", systemImage: "checkmark")
        } else {
          Text("All machines")
        }
      }
      Button {
        machineFilter = .focused
      } label: {
        if machineFilter == .focused {
          Label(focusedMachineName, systemImage: "checkmark")
        } else {
          Text(focusedMachineName)
        }
      }
      ForEach(remoteLanes.machines) { machine in
        Button {
          machineFilter = .machine(machine.machineKey)
        } label: {
          if machineFilter == .machine(machine.machineKey) {
            Label(machine.name, systemImage: "checkmark")
          } else {
            Text(machine.isLive ? machine.name : "\(machine.name) (offline)")
          }
        }
      }
  }

  @ViewBuilder
  var duoLaneDetailColumn: some View {
    if let laneId = duoSelectedLaneId, duoLaneIsAvailable(laneId) {
      // A fresh screen per lane: the detail's own state (diffs, commit field,
      // disclosures) belongs to one lane, never the previous one. Its own
      // stack, so held landscape its toolbar is the edge bar.
      NavigationStack {
        laneDestination(LaneRoute(laneId: laneId), showsBackButton: false)
          // Activity and Settings live in the list column's ⋯ inside a
          // project, never on the rail: the rail's bottom is the five tabs.
          .toolbar { DuoAppTabsToolbar(includesUtilities: !duoLayout.hasEdgeBar) }
      }
      .id(laneId)
    } else {
      DuoSplitPlaceholder(
        symbol: "square.stack.3d.up",
        title: "Select a lane",
        message: "Pick a lane to see its overview, changes, commits and git actions.",
        includesUtilities: !duoLayout.hasEdgeBar
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

/// Lanes' search field, Work's shape: the field takes the row's width and the
/// filter is a chip inside its trailing edge (a menu), accent while a filter
/// other than the default is on.
struct LaneHeaderSearchField<MenuContent: View>: View {
  @Binding var searchText: String
  /// The field's placeholder and the filter chip's name (the PRs tab reuses it).
  var prompt = "Search lanes, branches"
  var filterLabel = "Lane filters"
  @ViewBuilder var menuContent: () -> MenuContent
  var filterActive: () -> Bool

  var body: some View {
    let active = filterActive()
    HStack(spacing: 6) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .accessibilityHidden(true)
      TextField(prompt, text: $searchText)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .font(.subheadline)
        .submitLabel(.search)
      if !searchText.isEmpty {
        Button {
          searchText = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 24, height: 36)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear search")
      }
      Menu {
        menuContent()
      } label: {
        Image(systemName: "line.3.horizontal.decrease")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(active ? ADEColor.accent : ADEColor.textSecondary)
          .padding(.horizontal, 8)
          .frame(height: 24)
          .background(
            active ? ADEColor.accent.opacity(0.14) : ADEColor.recessedBackground,
            in: Capsule(style: .continuous)
          )
          .frame(minWidth: 36, minHeight: 40)
          .contentShape(Rectangle())
      }
      .accessibilityLabel(filterLabel)
      .accessibilityValue(active ? "On" : "None")
    }
    .padding(.leading, 10)
    .padding(.trailing, 4)
    .frame(minHeight: 40)
    .frame(maxWidth: .infinity)
    .background(ADEColor.composerBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    )
  }
}

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
              .adeFlatRow(insets: EdgeInsets(top: 0, leading: 2, bottom: 0, trailing: 6))
              .listRowBackground(selection == snapshot.lane.id ? ADEColor.accent.opacity(0.12) : Color.clear)
            }
          }
        }
        .adeFlatList()
        .listSectionSpacing(.compact)
        .environment(\.defaultMinListRowHeight, 0)
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search lanes, branches, is:dirty")
        .navigationTitle("Lanes")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Menu {
              Picker("Show", selection: $filter) {
                ForEach(LaneQuickFilter.allCases) { filter in
                  Text(filter.title).tag(filter)
                }
              }
            } label: {
              Label("Filter", systemImage: "line.3.horizontal.decrease.circle")
            }
          }
          ToolbarItem(placement: .topBarLeading) {
            Menu {
              Button("All machines", systemImage: "checkmark") {}
              Button("MacBook Pro") {}
            } label: {
              Label("Machines", systemImage: "desktopcomputer")
            }
          }
          ToolbarItem(placement: .topBarTrailing) {
            Button("Add lane", systemImage: "plus") {}
          }
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
      onCopyBranchLink: {}
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
        .padding(.horizontal, 16)
        .padding(.top, 8)
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
              .adeFlatRow(insets: EdgeInsets(top: 11, leading: 16, bottom: 11, trailing: 16))
              .listRowBackground(selection == item.githubPrNumber ? ADEColor.accent.opacity(0.12) : Color.clear)
            }
          }
        }
        .adeFlatList()
        .contentMargins(.bottom, 24, for: .scrollContent)
        .safeAreaInset(edge: .top, spacing: 0) {
          Picker("Status", selection: $category) {
            Text(verbatim: "Open 17").tag(PrGitHubCategory.open)
            Text(verbatim: "Merged 1035").tag(PrGitHubCategory.merged)
            Text(verbatim: "Closed 167").tag(PrGitHubCategory.closed)
          }
          .pickerStyle(.segmented)
          .padding(.horizontal, 16)
          .padding(.top, 4)
          .padding(.bottom, 8)
        }
        .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search PRs, branches, authors")
        .navigationTitle("PRs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbarTitleMenu {
          Picker("View", selection: .constant(PrRootSurface.github)) {
            Label("GitHub", systemImage: "arrow.triangle.pull").tag(PrRootSurface.github)
            Label("Workflows", systemImage: "point.3.filled.connected.trianglepath.dotted").tag(PrRootSurface.workflows)
          }
        }
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("New pull request", systemImage: "plus") {}
          }
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
