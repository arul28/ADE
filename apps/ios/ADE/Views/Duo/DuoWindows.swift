import SwiftUI
import UIKit

// The Duo's windows for Files, CTO, Activity, Linear and Settings.
//
// Each surface keeps its phone layout on the outer display and every other
// iPhone. On the inner display it gets the two-page grammar of
// `.ade/cache/duo/briefs/DESIGN.md`: a book fold is the boundary between its
// parts held landscape, a laptop fold held portrait. Every control of the
// detail part sits in the system toolbar, so held landscape it lands in the
// edge bar along the curved trailing edge and held portrait in the top bar.
//
// Nothing here fetches on its own: each window reuses the view models, reads
// and actions of the phone screen it replaces, with their machine scope.

// MARK: - Presentations

/// How the app root presents Settings, Activity and Linear.
///
/// Compact: the sheets the phone has always used. Inner display: Settings is a
/// full-screen two-column window held landscape (a sheet held upright, where a
/// split view would overlay its list); Activity is a 360pt
/// trailing column held landscape and a sheet held upright, where a 360pt
/// column would leave the app too narrow to use; Linear is a full-screen
/// window in both holds.
struct DuoWindowPresentations: ViewModifier {
  @ObservedObject var syncService: SyncService
  let appUpdateAdvisor: AppUpdateAdvisor

  @Environment(\.duoLayout) private var duo
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ObservedObject private var chrome = DuoShellChrome.shared
  @State private var isLandscape = false

  private var wideLandscape: Bool { duo.isWide && isLandscape }
  /// Activity as the app-wide trailing column: held landscape, unless the
  /// Hub's two pages are up, which show it in their right page instead.
  private var activityColumn: Bool { wideLandscape && !chrome.hubHostsActivity }
  /// Activity as a sheet: held upright or on a phone, unless the Hub hosts it.
  private var activitySheet: Bool { !wideLandscape && !chrome.hubHostsActivity }
  /// Settings' two columns: held landscape only. Upright the window is under
  /// ~700pt wide, where a split view lays its list over a dimmed page instead
  /// of beside it, so Settings stays the sheet there.
  private var settingsWindow: Bool { wideLandscape }

  private var motion: Animation? {
    reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)
  }

  func body(content: Content) -> some View {
    // Activity's trailing column is a sibling of the app, not an overlay: the
    // app gives up the width, so its own edge bar steps aside and the column
    // (along the curved edge now) carries Done and its menu there.
    HStack(spacing: 0) {
      content
        // The column takes the curved edge, so the app beside it lays its
        // controls out in top bars instead of an edge bar it no longer reaches.
        .transformEnvironment(\.duoLayout) { layout in
          layout.edgeBarYielded = activityColumn && syncService.attentionDrawerPresented
        }
      if activityColumn && syncService.attentionDrawerPresented {
        DuoSeam(axis: .vertical)
          .ignoresSafeArea()
        ActivityDrawerSheet(onCloseInspector: {
          withAnimation(motion) { syncService.attentionDrawerPresented = false }
        })
        .environmentObject(syncService)
        .environmentObject(syncService.attentionDrawer)
        .frame(width: 360)
        .transition(.move(edge: .trailing))
      }
    }
    .animation(motion, value: activityColumn && syncService.attentionDrawerPresented)
    .onGeometryChange(for: Bool.self) { proxy in
      proxy.isLandscapeIgnoringKeyboard
    } action: { landscape in
      isLandscape = landscape
    }
    .sheet(isPresented: shown($syncService.settingsPresented, when: !settingsWindow)) {
      settings
    }
    .fullScreenCover(isPresented: shown($syncService.settingsPresented, when: settingsWindow)) {
      settings
    }
    .sheet(isPresented: shown($syncService.attentionDrawerPresented, when: activitySheet)) {
      ActivityDrawerSheet()
        .environmentObject(syncService)
        .environmentObject(syncService.attentionDrawer)
    }
    .sheet(isPresented: shown($syncService.linearPanePresented, when: !duo.isWide)) {
      linear
    }
    .fullScreenCover(isPresented: shown($syncService.linearPanePresented, when: duo.isWide)) {
      linear
    }
  }

  private var settings: some View {
    ConnectionSettingsView(syncService: syncService)
      .environmentObject(appUpdateAdvisor)
  }

  private var linear: some View {
    LinearPaneSheet(syncService: syncService)
      .environmentObject(syncService)
  }

  /// One flag, two presentations: this one shows the flag only while
  /// `condition` holds. A presentation the posture just switched away from may
  /// report itself dismissed; that write is dropped so the flag carries over to
  /// the other presentation instead of closing the surface.
  private func shown(_ flag: Binding<Bool>, when condition: Bool) -> Binding<Bool> {
    Binding(
      get: { condition && flag.wrappedValue },
      set: { newValue in
        guard newValue || condition else { return }
        flag.wrappedValue = newValue
      }
    )
  }
}

// MARK: - Activity

/// The Activity column's bucket: Sessions or Inbox, with counts, as a native
/// segmented control.
struct DuoActivityInspectorFilters: View {
  @EnvironmentObject private var drawer: ActivityDrawerModel
  @Binding var bucket: ActivityBucket

  var body: some View {
    Picker("Activity", selection: $bucket) {
      ForEach(ActivityBucket.allCases, id: \.self) { value in
        let count = drawer.rows(in: value).count
        Text(count > 0 ? "\(value.title) \(count)" : value.title)
          .tag(value)
      }
    }
    .pickerStyle(.segmented)
    .padding(.horizontal, 16)
    .padding(.top, 6)
    .padding(.bottom, 10)
  }
}

/// Desktop's column chips (All, Needs you, Working, Waiting, Done) with their
/// counts, as a toolbar menu: five full labels never fit a 360pt segmented
/// control, and a menu never truncates them.
struct DuoActivityStateMenu: View {
  @EnvironmentObject private var drawer: ActivityDrawerModel

  private var selection: Binding<HubRosterFilter> {
    Binding(
      get: { HubRosterFilter(column: drawer.stateFilter) },
      set: { drawer.stateFilter = $0.column }
    )
  }

  var body: some View {
    let counts = HubRosterFilter.counts(from: drawer.columnCounts)
    Menu {
      Picker("Agent state", selection: selection) {
        ForEach(HubRosterFilter.allCases) { filter in
          Label(
            "\(filter.title)  \(counts[filter] ?? 0)",
            systemImage: filter.column?.systemImage ?? "square.grid.2x2"
          )
          .tag(filter)
        }
      }
      .pickerStyle(.inline)
    } label: {
      Label(
        selection.wrappedValue == .all ? "Filter" : selection.wrappedValue.title,
        systemImage: selection.wrappedValue == .all
          ? "line.3.horizontal.decrease"
          : "line.3.horizontal.decrease.circle.fill"
      )
    }
    .accessibilityLabel("Show \(selection.wrappedValue.title)")
    .accessibilityHint("Shows only the sessions in that state.")
  }
}

// MARK: - Settings

/// Settings held landscape on the inner display: Apple Settings' two columns,
/// the settings list on the left and the page a row opens on the right. A book
/// fold puts each on its own page. Held upright it is the phone's stack.
struct DuoSettingsSplit<Sidebar: View, Landing: View>: View {
  /// Closes Settings. The split puts its close button on the page column, the
  /// trailing stack, so held landscape iOS puts it at the top of the edge bar
  /// under the thumb; the list column carries none.
  let onClose: () -> Void
  @ViewBuilder var sidebar: () -> Sidebar
  @ViewBuilder var landing: () -> Landing

  /// The row whose page fills the right column; nil while the landing page
  /// shows. Rows read it through `\.duoSettingsSelection`.
  @State private var selection: String?

  var body: some View {
    DuoLocalFoldReader { fold, size, landscape in
      if landscape {
        NavigationSplitView(columnVisibility: .constant(.all)) {
          sidebar()
            .navigationSplitViewColumnWidth(sidebarWidth(fold: fold, size: size))
            .toolbar(removing: .sidebarToggle)
            .environment(\.duoSettingsSelection, $selection)
            .environment(\.duoSettingsClose, onClose)
        } detail: {
          NavigationStack {
            landing()
              .modifier(DuoSettingsCloseItem(onClose: onClose))
          }
        }
        .navigationSplitViewStyle(.balanced)
      } else {
        NavigationStack {
          sidebar()
            .modifier(DuoSettingsCloseItem(onClose: onClose))
        }
      }
    }
  }

  private func sidebarWidth(fold: DuoFold, size: CGSize) -> CGFloat {
    if case .sideBySide(let rect) = fold, rect.minX > 240 {
      return rect.minX
    }
    return min(340, size.width * 0.38)
  }
}

extension EnvironmentValues {
  /// The two-column Settings window's selected row (by title). Nil outside it.
  @Entry var duoSettingsSelection: Binding<String?>? = nil
  /// The two-column Settings window's close, which every page a row opens in
  /// the right column carries (so it stays on the edge bar). Nil outside it.
  @Entry var duoSettingsClose: (() -> Void)? = nil
}

/// Settings' close button, the standard close role, on the trailing side of
/// a page's bar: held landscape in the right column that is the edge bar.
struct DuoSettingsCloseItem: ViewModifier {
  let onClose: () -> Void

  func body(content: Content) -> some View {
    content.toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button(role: .close, action: onClose)
          .accessibilityLabel("Close settings")
      }
    }
  }
}

// MARK: - Linear

/// Linear on the inner display: desktop's three panes. Held landscape, the
/// views rail and the issue list share the leading column and the selected
/// issue fills the detail column (one page each when book-folded). Held
/// upright, the issues are the top half and the issue the bottom half: under
/// ~700pt a split view overlays its list rather than sitting beside it.
///
/// The selected issue is the first `.issue` route of the pane's own path, so
/// deep links and the launch flow keep working unchanged: a launch pushes onto
/// the detail column's stack.
struct DuoLinearWindow<IssueList: View, Destination: View>: View {
  @ObservedObject var store: LinearPaneStore
  @Binding var path: [LinearRoute]
  let onClose: () -> Void
  @ViewBuilder var issueList: () -> IssueList
  @ViewBuilder var destination: (LinearRoute) -> Destination

  @State private var listPath: [LinearRoute] = []

  var body: some View {
    DuoLocalFoldReader { fold, size, landscape in
      if landscape {
        NavigationSplitView(columnVisibility: .constant(.all)) {
          issuesColumn
            .navigationSplitViewColumnWidth(leadingWidth(fold: fold, size: size))
            .toolbar(removing: .sidebarToggle)
        } detail: {
          detailColumn
        }
        .navigationSplitViewStyle(.balanced)
      } else {
        DuoTwoPages {
          issuesColumn
        } second: {
          detailColumn
        }
      }
    }
    .environment(\.linearIssueSelection, LinearIssueSelection(
      selectedIssueId: selectedIssue?.id,
      select: { issue in
        withAnimation(.spring(response: 0.35, dampingFraction: 0.86)) {
          path = [.issue(issue)]
        }
      }
    ))
  }

  private var selectedIssue: NormalizedLinearIssue? {
    guard case .issue(let issue)? = path.first else { return nil }
    return issue
  }

  /// The rail and the list, in a stack of their own so the list's gear can
  /// still push the connection screen.
  private var issuesColumn: some View {
    NavigationStack(path: $listPath) {
      HStack(alignment: .top, spacing: 0) {
        DuoLinearViewsRail(store: store)
          .padding(.leading, 8)
          .padding(.trailing, 4)
          .padding(.vertical, 8)
        issueList()
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationDestination(for: LinearRoute.self) { route in
        destination(route)
      }
    }
  }

  private var detailColumn: some View {
    NavigationStack(path: detailPath) {
      Group {
        if let selectedIssue {
          destination(.issue(selectedIssue))
            .id(selectedIssue.id)
        } else {
          ContentUnavailableView(
            "Select an issue",
            systemImage: "list.bullet.rectangle",
            description: Text("Pick an issue to read it here, then launch it into a lane.")
          )
          .background(ADEColor.pageBackground.ignoresSafeArea())
        }
      }
      .navigationDestination(for: LinearRoute.self) { route in
        destination(route)
      }
    }
  }

  /// The detail column's own stack: everything after the selected issue.
  private var detailPath: Binding<[LinearRoute]> {
    Binding(
      get: { selectedIssue == nil ? path : Array(path.dropFirst()) },
      set: { rest in
        path = (selectedIssue.map { [.issue($0)] } ?? []) + rest
      }
    )
  }

  private func leadingWidth(fold: DuoFold, size: CGSize) -> CGFloat {
    if case .sideBySide(let rect) = fold, rect.minX > 240 {
      return rect.minX
    }
    return min(420, size.width * 0.44)
  }
}

/// The issue the wide Linear window shows beside the list. The list's rows
/// select through this instead of pushing when it is set.
struct LinearIssueSelection {
  var selectedIssueId: String?
  var select: ((NormalizedLinearIssue) -> Void)?
}

extension EnvironmentValues {
  @Entry var linearIssueSelection = LinearIssueSelection()
}

/// An issue's two launches as toolbar items: Launch agent pinned and
/// prominent, New lane beside it.
struct DuoLinearLaunchToolbar: ToolbarContent {
  let issue: NormalizedLinearIssue

  var body: some ToolbarContent {
    #if compiler(>=6.4)
    if #available(iOS 27.0, *) {
      ToolbarItem(placement: .topBarPinnedTrailing) {
        launchAgent
      }
    } else {
      ToolbarItem(placement: .primaryAction) {
        launchAgent
      }
    }
    #else
    ToolbarItem(placement: .primaryAction) {
      launchAgent
    }
    #endif
    ToolbarItem(placement: .primaryAction) {
      NavigationLink(value: LinearRoute.launch(issue: issue, laneOnly: true)) {
        Label("New lane", systemImage: "link")
      }
    }
  }

  private var launchAgent: some View {
    NavigationLink(value: LinearRoute.launch(issue: issue, laneOnly: false)) {
      Label("Launch agent", systemImage: "play.fill")
    }
    .buttonStyle(.borderedProminent)
    .tint(LinearBrand.primaryBright)
  }
}

/// Desktop's views rail as a slim Liquid Glass capsule along the list's leading
/// edge: All issues, My issues, then the workspace's projects. Each bubble sets
/// the store's existing filters, so the list reloads the way it always does.
struct DuoLinearViewsRail: View {
  @ObservedObject var store: LinearPaneStore

  private enum Scope: Hashable {
    case all
    case mine
    case project(String)
  }

  private var current: Scope {
    if let projectId = store.projectId { return .project(projectId) }
    return store.assignedToMe ? .mine : .all
  }

  var body: some View {
    GlassEffectContainer {
      ScrollView(.vertical, showsIndicators: false) {
        VStack(spacing: 6) {
          bubble(.all, symbol: "square.stack.3d.up", title: "All issues")
          bubble(.mine, symbol: "person.crop.circle", title: "My issues")
          if !store.projects.isEmpty {
            Divider()
              .frame(width: 22)
              .padding(.vertical, 2)
            // A project is its folder in the project's own colour, like
            // desktop's rail; the name is the label and the tooltip.
            ForEach(store.projects) { project in
              bubble(
                .project(project.id),
                symbol: "folder.fill",
                title: project.name,
                tint: LaneColorPalette.displayColor(forHex: project.color, fallback: ADEColor.textSecondary)
              )
            }
          }
        }
        .padding(.vertical, 8)
      }
      .frame(width: 44)
      .fixedSize(horizontal: false, vertical: true)
      .glassEffect(.regular, in: .capsule)
    }
    .frame(maxHeight: .infinity, alignment: .top)
  }

  private func bubble(_ scope: Scope, symbol: String, title: String, tint: Color? = nil) -> some View {
    let selected = current == scope
    return Button {
      withAnimation(.spring(response: 0.35, dampingFraction: 0.86)) {
        select(scope)
      }
    } label: {
      ZStack {
        Circle()
          .fill(selected ? LinearBrand.primaryBright.opacity(0.22) : Color.clear)
        Image(systemName: symbol)
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(tint ?? (selected ? LinearBrand.primaryBright : ADEColor.textSecondary))
      }
      .frame(width: 34, height: 34)
      .contentShape(Circle())
    }
    .buttonStyle(.plain)
    .help(title)
    .accessibilityLabel(title)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  private func select(_ scope: Scope) {
    switch scope {
    case .all:
      store.projectId = nil
      store.assignedToMe = false
    case .mine:
      store.projectId = nil
      store.assignedToMe = true
    case .project(let id):
      store.projectId = id
    }
  }
}

#if DEBUG
/// Fixture screens for this area, routed by `DuoPreviewRouter`.
enum DuoWindowsPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-files": return AnyView(DuoFilesFixture())
    case "duo-files-split": return AnyView(DuoFilesSplitFixture())
    case "duo-cto": return AnyView(DuoCtoFixture())
    case "duo-activity": return AnyView(DuoPresentationFixture(surface: .activity))
    case "duo-settings": return AnyView(DuoPresentationFixture(surface: .settings))
    case "duo-linear": return AnyView(DuoLinearFixture())
    default: return nil
    }
  }
}

// MARK: Files fixture

/// The real Files tab over an offline service whose database holds a lane
/// workspace, its folders and two files: Files reads cached rows when no
/// machine answers, so this renders exactly what a cached project shows.
private struct DuoFilesFixture: View {
  var body: some View {
    FilesRootScreen(
      isTabActive: true,
      selectedWorkspaceId: DuoWindowsFixtureData.workspace.id,
      navigationPath: [
        .editor(
          workspaceId: DuoWindowsFixtureData.workspace.id,
          relativePath: DuoWindowsFixtureData.openFilePath,
          focusLine: nil
        )
      ],
      selectedFileTransitionPath: DuoWindowsFixtureData.openFilePath
    )
    .environmentObject(DuoWindowsFixtureData.filesService)
  }
}

/// The Files window with two editor groups open ("Open to the Side"), over
/// the same cached workspace.
private struct DuoFilesSplitFixture: View {
  private var workspace: FilesWorkspace { DuoWindowsFixtureData.workspace }

  var body: some View {
    DuoFilesWindow(
      primary: DuoFilesEditorRef(workspaceId: workspace.id, path: DuoWindowsFixtureData.openFilePath),
      openPrimary: { _, _ in },
      onFind: {},
      tree: { _, _ in EmptyView() },
      editor: { ref, chrome in
        FilesDetailScreen(
          workspace: workspace,
          relativePath: ref.path,
          focusLine: nil,
          transitionNamespace: nil,
          navigateToDirectory: { _ in },
          duoChrome: chrome
        )
      },
      side: DuoFilesEditorRef(workspaceId: workspace.id, path: "apps/ios/ADE/Views/Duo/DuoShell.swift")
    )
    .environmentObject(DuoWindowsFixtureData.filesService)
  }
}

// MARK: CTO fixture

/// The CTO tab's wide column around the real chat view (Work's fixture
/// transcript; the CTO thread itself needs a machine).
private struct DuoCtoFixture: View {
  var body: some View {
    NavigationStack {
      workPreviewChatSessionView()
        .tint(ADEColor.ctoAccent)
        .adeScreenBackground()
        .navigationTitle("CTO")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          DuoHubBackToolbarItem()
          DuoAppTabsToolbar()
        }
    }
  }
}

// MARK: Activity and Settings fixtures

/// The app root's real presentation modifier over the Home fixture, with
/// Activity (fixture account snapshot) or Settings already open.
private struct DuoPresentationFixture: View {
  enum Surface { case activity, settings }
  let surface: Surface

  @EnvironmentObject private var syncService: SyncService
  @StateObject private var advisor = AppUpdateAdvisor()

  var body: some View {
    DuoPreviewRouter.view(named: "duo-home")
      .modifier(DuoWindowPresentations(syncService: syncService, appUpdateAdvisor: advisor))
      .environmentObject(syncService.attentionDrawer)
      .task {
        syncService.attentionDrawer.rebuild(from: ActivityPreviewData.snapshot)
        // After the first layout, so the root knows its posture, as it does
        // by the time a person taps anything.
        try? await Task.sleep(for: .milliseconds(400))
        switch surface {
        case .activity:
          syncService.attentionDrawerPresented = true
          // The drawer refreshes from the (signed-out) account as it opens;
          // put the fixture rows back once that has run.
          try? await Task.sleep(for: .seconds(2))
          syncService.attentionDrawer.rebuild(from: ActivityPreviewData.snapshot)
        case .settings:
          // Settle the account row the way launch does (no session on a bare
          // simulator, so the real "Sign in to ADE" row), not a spinner.
          await AccountService.shared.bootstrap()
          syncService.settingsPresented = true
        }
      }
  }
}

// MARK: Linear fixture

/// The wide Linear window with the real list, rail and issue detail over a
/// fixture workspace (the store reads through `LinearPaneSyncing`).
private struct DuoLinearFixture: View {
  @StateObject private var store = LinearPaneStore(sync: DuoLinearFixtureSync())
  @State private var path: [LinearRoute] = [.issue(DuoLinearFixtureSync.issues[1])]

  var body: some View {
    DuoLinearWindow(store: store, path: $path, onClose: {}) {
      LinearIssueListScreen(store: store)
    } destination: { route in
      switch route {
      case let .issue(issue):
        LinearIssueDetailScreen(issue: issue, hasLane: issue.id == "lin-2")
      case let .launch(issue, laneOnly):
        LinearLaunchDestination(issue: issue, laneOnly: laneOnly)
      case .connection:
        LinearConnectionScreen(store: store)
      }
    }
    .tint(LinearBrand.primaryBright)
    .task { await store.start() }
  }
}

@MainActor
private final class DuoLinearFixtureSync: LinearPaneSyncing {
  var linearConnectionStatus: LinearConnectionStatus? = LinearConnectionStatus(
    connected: true,
    viewerId: "viewer",
    viewerName: "Arul",
    organizationName: "ADE"
  )

  static let projects = [
    LinearCatalogProject(id: "p-ios", name: "iOS", color: "#5e6ad2"),
    LinearCatalogProject(id: "p-desk", name: "Desktop", color: "#f2994a"),
    LinearCatalogProject(id: "p-sync", name: "Sync", color: "#4cb782"),
  ]

  static let issues: [NormalizedLinearIssue] = [
    issue("lin-1", "ADE-412", "Duo: edge bar for the Work tools pane", state: "In Progress", type: "started", project: "p-ios", priority: 2, assignee: "Arul"),
    issue("lin-2", "ADE-418", "Files window: open a second editor group", state: "In Progress", type: "started", project: "p-ios", priority: 1, assignee: "Arul"),
    issue("lin-3", "ADE-377", "Brain reconnect drops the CTO thread", state: "Todo", type: "unstarted", project: "p-sync", priority: 1, assignee: nil),
    issue("lin-4", "ADE-390", "Lane dashboard: stack section", state: "Todo", type: "unstarted", project: "p-desk", priority: 3, assignee: "Arul"),
    issue("lin-5", "ADE-401", "Settings: two-column on the inner display", state: "Backlog", type: "backlog", project: "p-ios", priority: 4, assignee: nil),
    issue("lin-6", "ADE-355", "PR checks graph on phone", state: "Done", type: "completed", project: "p-ios", priority: 3, assignee: "Arul"),
  ]

  private static func issue(
    _ id: String,
    _ identifier: String,
    _ title: String,
    state: String,
    type: String,
    project: String,
    priority: Int,
    assignee: String?
  ) -> NormalizedLinearIssue {
    NormalizedLinearIssue(
      id: id,
      identifier: identifier,
      title: title,
      description: "The inner display should carry desktop's structure: \(title.lowercased()). Keep every control in the system toolbar so the edge bar holds it.",
      projectId: project,
      projectName: projects.first { $0.id == project }?.name,
      teamKey: "ADE",
      teamName: "ADE",
      stateName: state,
      stateType: type,
      priority: priority,
      priorityLabel: ["No priority", "Urgent", "High", "Medium", "Low"][priority],
      labels: ["iphone-duo"],
      assigneeId: assignee == nil ? nil : "viewer",
      assigneeName: assignee,
      createdAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-86_400 * 3)),
      updatedAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(-3_600))
    )
  }

  func attachedLinearIssueIds() -> Set<String> { ["lin-2"] }

  func fetchLinearQuickView() async throws -> LinearQuickView {
    throw NSError(domain: "ADE", code: 17)
  }

  func fetchLinearIssuePickerData() async throws -> LinearIssuePickerData {
    LinearIssuePickerData(projects: Self.projects, users: [], states: [])
  }

  func searchLinearIssues(_ args: LinearIssueSearchArgs) async throws -> LinearIssueSearchResult {
    let matched = Self.issues.filter { issue in
      (args.projectId == nil || issue.projectId == args.projectId)
        && (args.assigneeId == nil || issue.assigneeId == args.assigneeId)
        && (args.stateTypes == nil || args.stateTypes!.contains(issue.stateType ?? ""))
    }
    return LinearIssueSearchResult(
      issues: matched,
      pageInfo: LinearIssueSearchResultPageInfo(hasNextPage: false, endCursor: nil)
    )
  }
}

// MARK: Fixture data

@MainActor
private enum DuoWindowsFixtureData {
  static let projectId = "duo-windows-project"
  static let openFilePath = "apps/ios/ADE/Views/Duo/DuoLayout.swift"

  /// The project's primary workspace: the cache scopes a lane workspace to
  /// lane rows, and the primary one only to the project's root.
  static let workspace = FilesWorkspace(
    id: "primary-ade",
    kind: "primary",
    laneId: nil,
    name: "main",
    branchRef: "main",
    rootPath: "/Users/arul/ADE",
    isReadOnlyByDefault: false
  )

  static let filesService: SyncService = {
    let base = FileManager.default.temporaryDirectory
      .appendingPathComponent("ade-duo-windows-fixture", isDirectory: true)
    try? FileManager.default.removeItem(at: base)
    let database = DatabaseService(baseURL: base)
    try? database.upsertMobileProjectCache(MobileProjectSummary(
      id: projectId,
      displayName: "ADE",
      rootPath: "/Users/arul/ADE",
      repoOwner: "arul28",
      repoName: "ADE",
      laneCount: 1,
      isAvailable: true,
      isCached: true
    ))
    database.setActiveProjectId(projectId)
    try? database.replaceFilesWorkspaces([workspace], expectedProjectId: projectId)
    for (folder, nodes) in folders {
      try? database.cacheDirectorySnapshot(workspaceId: workspace.id, parentPath: folder, includeHidden: true, nodes: nodes)
    }
    for (path, text) in files {
      try? database.cacheFileContentSnapshot(
        workspaceId: workspace.id,
        path: path,
        blob: SyncFileBlob(path: path, size: text.utf8.count, encoding: "utf8", isBinary: false, content: text, languageId: "swift")
      )
    }
    return SyncService(database: database)
  }()

  private static func node(_ path: String, file: Bool, status: String? = nil, size: Int? = nil) -> FileTreeNode {
    FileTreeNode(
      name: lastPathComponent(path),
      path: path,
      type: file ? "file" : "directory",
      hasChildren: file ? nil : true,
      children: nil,
      changeStatus: status,
      size: size
    )
  }

  static let folders: [String: [FileTreeNode]] = [
    "": [node("apps", file: false), node("docs", file: false), node("README.md", file: true, size: 4_210)],
    "apps/ios/ADE/Views/Duo": [
      node("apps/ios/ADE/Views/Duo/DuoHome.swift", file: true, status: "modified", size: 31_820),
      node("apps/ios/ADE/Views/Duo/DuoLayout.swift", file: true, size: 6_154),
      node("apps/ios/ADE/Views/Duo/DuoPreviews.swift", file: true, size: 1_620),
      node("apps/ios/ADE/Views/Duo/DuoShell.swift", file: true, status: "modified", size: 11_904),
      node("apps/ios/ADE/Views/Duo/DuoWindows.swift", file: true, status: "added", size: 48_330),
    ],
  ]

  static let files: [String: String] = [
    "apps/ios/ADE/Views/Duo/DuoLayout.swift": """
    import SwiftUI

    /// Where the fold of an iPhone Duo's inner display sits right now, in the
    /// coordinate space of the view that read it.
    enum DuoFold: Equatable {
      case none
      /// Book: the fold is a vertical line, with a page on each side.
      case sideBySide(CGRect)
      /// Laptop or tent: the fold is a horizontal line.
      case stacked(CGRect)

      var frame: CGRect? {
        switch self {
        case .none: return nil
        case .sideBySide(let rect), .stacked(let rect): return rect
        }
      }
    }

    /// The three layout families every Duo-aware screen designs for.
    enum DuoFamily: Equatable {
      case compact
      case wide
      case tall
    }

    extension DuoLayout {
      func family(for size: CGSize) -> DuoFamily {
        guard isWide else { return .compact }
        return size.width > size.height ? .wide : .tall
      }
    }
    """,
    "apps/ios/ADE/Views/Duo/DuoShell.swift": """
    import SwiftUI

    /// The shell state a pane can set: whether the sidebar should get out of
    /// the way.
    @MainActor
    final class DuoShellChrome: ObservableObject {
      static let shared = DuoShellChrome()
      @Published var sidebarPreferredHidden = false

      func setSidebarPreferredHidden(_ hidden: Bool) {
        guard sidebarPreferredHidden != hidden else { return }
        sidebarPreferredHidden = hidden
      }
    }
    """,
  ]
}
#endif
