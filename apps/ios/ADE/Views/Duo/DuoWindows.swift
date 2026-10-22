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
  @State private var isLandscape = false

  private var wideLandscape: Bool { duo.isWide && isLandscape }
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
          layout.edgeBarYielded = wideLandscape && syncService.attentionDrawerPresented
        }
      if wideLandscape && syncService.attentionDrawerPresented {
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
    .animation(motion, value: wideLandscape && syncService.attentionDrawerPresented)
    .onGeometryChange(for: Bool.self) { proxy in
      proxy.size.width > proxy.size.height
    } action: { landscape in
      isLandscape = landscape
    }
    .sheet(isPresented: shown($syncService.settingsPresented, when: !settingsWindow)) {
      settings
    }
    .fullScreenCover(isPresented: shown($syncService.settingsPresented, when: settingsWindow)) {
      settings
    }
    .sheet(isPresented: shown($syncService.attentionDrawerPresented, when: !wideLandscape)) {
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
    DuoLocalFoldReader { fold, size in
      if size.width > size.height {
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
    DuoLocalFoldReader { fold, size in
      if size.width > size.height {
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
    if #available(iOS 27.0, *) {
      ToolbarItem(placement: .topBarPinnedTrailing) {
        launchAgent
      }
    } else {
      ToolbarItem(placement: .primaryAction) {
        launchAgent
      }
    }
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

// MARK: - Files

extension EnvironmentValues {
  /// Opens a file in the Files window's second editor group. Nil wherever
  /// there is no second group to open.
  @Entry var filesOpenToSide: ((String) -> Void)? = nil
}

/// What the Files window tells one editor group about its place.
struct FilesDuoEditorChrome {
  /// Opens the same file in a second group; nil when one is already open.
  var onOpenToSide: (() -> Void)?
  /// Closes this group; nil for the only group.
  var onCloseGroup: (() -> Void)?
  /// Searches the workspace (the viewer is not a text view, so find in file
  /// is the workspace search seeded by the user).
  var onFind: () -> Void
  /// Shows or hides the file tree; nil while two groups hide it.
  var onToggleTree: (() -> Void)?
  var treeVisible: Bool
  /// The group keeps a horizontal top bar (beside another group, or held
  /// portrait): its secondary actions move to the overflow so the file name
  /// keeps its room.
  var condensed = false
}

/// The viewer's title: the file name, and in the Duo's Files window where it
/// lives and what it is as the subtitle.
struct FilesDuoEditorTitle: ViewModifier {
  let chrome: FilesDuoEditorChrome?
  let title: String
  let subtitle: String

  func body(content: Content) -> some View {
    if chrome != nil {
      content
        .navigationTitle(title)
        .navigationSubtitle(subtitle)
    } else {
      content.navigationTitle(title)
    }
  }
}

extension FilesDetailScreen {
  /// "apps/ios/ADE/Views · Swift · 8 KB"
  var duoSubtitle: String {
    var parts: [String] = []
    let folder = parentDirectory(of: relativePath)
    parts.append(folder.isEmpty ? workspace.name : folder)
    if let blob {
      parts.append(fileKindLabel(for: blob))
      parts.append(formattedFileSize(blob.size))
    }
    return parts.joined(separator: " · ")
  }

  /// The viewer's controls as toolbar items: the edge bar held landscape, the
  /// top bar held portrait.
  @ToolbarContentBuilder
  func duoEditorToolbar(_ chrome: FilesDuoEditorChrome) -> some ToolbarContent {
    if let onToggleTree = chrome.onToggleTree {
      ToolbarItem(placement: .topBarLeading) {
        Button(action: onToggleTree) {
          Label(chrome.treeVisible ? "Hide Files" : "Show Files", systemImage: "sidebar.left")
        }
      }
    }

    if let onCloseGroup = chrome.onCloseGroup {
      ToolbarItem(placement: .cancellationAction) {
        Button(action: onCloseGroup) {
          Label("Close Editor", systemImage: "xmark")
        }
      }
    }

    duoViewerItems
    duoActionItems(chrome)
    duoOverflowItems
  }

  /// What the viewer shows: changes, rendered or source, wrapped or not.
  @ToolbarContentBuilder
  private var duoViewerItems: some ToolbarContent {
    if editorModes.count > 1 {
      ToolbarItem(placement: .primaryAction) {
        Button {
          mode = mode == .diff ? .preview : .diff
        } label: {
          Label("Changes", systemImage: mode == .diff ? "plusminus.circle.fill" : "plusminus.circle")
        }
        .accessibilityValue(mode == .diff ? "On" : "Off")
      }
    }

    if mode == .preview, isMarkdownFile {
      ToolbarItem(placement: .primaryAction) {
        Button {
          markdownViewMode = markdownViewMode == .source ? .preview : .source
        } label: {
          Label(
            markdownViewMode == .source ? "Rendered" : "Source",
            systemImage: markdownViewMode == .source ? "doc.richtext" : "chevron.left.forwardslash.chevron.right"
          )
        }
      }
    }

    if let blob, showsCodeLayoutControl(blob: blob) {
      ToolbarItem(placement: .primaryAction) {
        Button {
          codeLayoutMode = codeLayoutMode == .wrap ? .scroll : .wrap
        } label: {
          Label(
            codeLayoutMode == .wrap ? "Don't Wrap" : "Wrap Lines",
            systemImage: codeLayoutMode == .wrap ? "text.alignleft" : "arrow.turn.down.left"
          )
        }
      }
    }

  }

  @ToolbarContentBuilder
  private func duoActionItems(_ chrome: FilesDuoEditorChrome) -> some ToolbarContent {
    ToolbarItem(placement: chrome.condensed ? .secondaryAction : .primaryAction) {
      Button(action: chrome.onFind) {
        Label("Find", systemImage: "magnifyingglass")
      }
    }

    if let blob, !blob.isBinary {
      ToolbarItem(placement: chrome.condensed ? .secondaryAction : .primaryAction) {
        ShareLink(item: blob.content, subject: Text(lastPathComponent(relativePath))) {
          Label("Share", systemImage: "square.and.arrow.up")
        }
      }
    }

    if let onOpenToSide = chrome.onOpenToSide {
      ToolbarItem(placement: .primaryAction) {
        Button(action: onOpenToSide) {
          Label("Open to the Side", systemImage: "rectangle.split.2x1")
        }
      }
    }

  }

  /// The overflow: paths, the diff's scope and the file's details.
  @ToolbarContentBuilder
  private var duoOverflowItems: some ToolbarContent {
    ToolbarItem(placement: .secondaryAction) {
      Button("Copy Full Path", systemImage: "doc.on.doc") {
        UIPasteboard.general.string = fullPath
      }
    }
    ToolbarItem(placement: .secondaryAction) {
      Button("Copy Relative Path", systemImage: "doc.on.clipboard") {
        UIPasteboard.general.string = relativePath
      }
    }
    if mode == .diff, workspace.laneId != nil {
      ToolbarItem(placement: .secondaryAction) {
        Picker("Compare", selection: $diffMode) {
          ForEach(FilesDiffMode.allCases) { option in
            Label(option.title, systemImage: option.systemImage).tag(option)
          }
        }
      }
    }
    ToolbarItem(placement: .secondaryAction) {
      Button("Details", systemImage: "info.circle") {
        isDetailsSheetPresented = true
      }
      .disabled(blob == nil)
    }
  }
}

/// One open file in an editor group.
struct DuoFilesEditorRef: Equatable {
  var workspaceId: String
  var path: String
  var focusLine: Int?
}

extension FilesRootScreen {
  /// The Files tab on the inner display: the tree beside one or two editor
  /// groups. See `DuoFilesWindow`.
  var duoFilesWindowBody: some View {
    DuoFilesWindow(
      primary: duoWindowPrimaryEditor,
      openPrimary: { path, line in
        guard let workspace = selectedWorkspace else { return }
        openFile(path, in: workspace, focusLine: line)
      },
      onFind: {
        pendingSearchQuery = ""
        isSearchPresented = true
      },
      tree: { open in
        duoWindowTree(open: open)
      },
      editor: { ref, chrome in
        if let workspace = workspaces.first(where: { $0.id == ref.workspaceId }) {
          FilesDetailScreen(
            workspace: workspace,
            relativePath: ref.path,
            focusLine: ref.focusLine,
            transitionNamespace: nil,
            navigateToDirectory: { path in duoFolderPath = path },
            duoChrome: chrome
          )
          .environmentObject(syncService)
        } else {
          ContentUnavailableView(
            "File unavailable",
            systemImage: "doc.badge.questionmark",
            description: Text("The workspace for this file is no longer available.")
          )
        }
      }
    )
  }

  /// The file the first editor group shows: the phone stack's open file, so
  /// folding or unfolding the device keeps it.
  var duoWindowPrimaryEditor: DuoFilesEditorRef? {
    for route in navigationPath.reversed() {
      if case .editor(let workspaceId, let relativePath, let focusLine) = route {
        return DuoFilesEditorRef(workspaceId: workspaceId, path: relativePath, focusLine: focusLine)
      }
    }
    return nil
  }

  /// The folder the tree column lists: the one browsed in the window, else
  /// the phone stack's folder, else the open file's.
  var duoWindowFolderPath: String {
    if let duoFolderPath { return duoFolderPath }
    if case .directory(_, let path)? = navigationPath.last(where: { route in
      if case .directory = route { return true }
      return false
    }) {
      return path
    }
    if let primary = duoWindowPrimaryEditor {
      return parentDirectory(of: primary.path)
    }
    return ""
  }

  /// The tree column: the workspace, the folder's breadcrumb, its contents and
  /// the lane's proof. `open` routes a file to the focused editor group.
  func duoWindowTree(open: @escaping (String, Int?) -> Void) -> some View {
    let folderPath = duoWindowFolderPath
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
              selectedFileTransitionPath = path
              open(path, line)
            },
            transitionNamespace: nil,
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
    .background(ADEColor.pageBackground)
    .refreshable { await refreshFromPullGesture() }
  }
}

/// Desktop's Files workbench on the inner display: the tree, then one or two
/// editor groups.
///
/// - Held landscape, flat: tree (300) | editor. "Open to the Side" adds a
///   second group; the tree folds away and the groups split 50/50.
/// - Book: the tree is the left page and the editor the right; with two groups
///   each group is a page.
/// - Held portrait: the editor is full and the tree slides over it from the
///   leading edge; laptop puts the tree on the top half and the editor below,
///   and two groups stack top and bottom.
///
/// The tree and each group are their own navigation stacks, so each carries its
/// own title and controls. Held landscape, the group along the trailing edge
/// gets the system edge bar; the others keep a top bar.
struct DuoFilesWindow<Tree: View, Editor: View>: View {
  let primary: DuoFilesEditorRef?
  let openPrimary: (String, Int?) -> Void
  let onFind: () -> Void
  @ViewBuilder var tree: (_ open: @escaping (String, Int?) -> Void) -> Tree
  @ViewBuilder var editor: (DuoFilesEditorRef, FilesDuoEditorChrome) -> Editor

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// The second group's file ("Open to the Side"). Nil for one group.
  @State var side: DuoFilesEditorRef?
  @State private var sideFocused = false
  /// The user's tree toggle. Nil follows the layout's default.
  @State private var treeShownChoice: Bool?

  private var motion: Animation? {
    reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)
  }

  var body: some View {
    DuoLocalFoldReader { fold, size in
      let landscape = size.width > size.height
      Group {
        if landscape {
          landscapeLayout(fold: fold, size: size)
        } else {
          portraitLayout(fold: fold, size: size)
        }
      }
      .environment(\.filesOpenToSide, { path in
        openToSide(path)
      })
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    // Two editor groups want both pages: the app sidebar folds away for them,
    // the same signal Work's tools pane uses (see DuoShell.swift).
    .onChange(of: side != nil) { _, twoGroups in
      DuoShellChrome.shared.setSidebarPreferredHidden(twoGroups)
    }
    .onDisappear {
      if side != nil { DuoShellChrome.shared.setSidebarPreferredHidden(false) }
    }
  }

  // MARK: Layouts

  @ViewBuilder
  private func landscapeLayout(fold: DuoFold, size: CGSize) -> some View {
    let treeShown = treeShownChoice ?? defaultTreeShown(landscape: true, fold: fold)
    let groups = editorGroups(landscape: true, fold: fold)
    if case .sideBySide(let rect) = fold {
      let lead = max(0, min(rect.minX, size.width))
      HStack(spacing: 0) {
        if side != nil {
          groups.first.frame(width: lead)
        } else if treeShown {
          treeColumn().frame(width: lead)
        } else {
          groups.first.frame(width: lead)
        }
        DuoSeam(axis: .vertical, foldRect: rect)
          .ignoresSafeArea()
        Group {
          if side != nil {
            groups.second
          } else if treeShown {
            groups.first
          } else {
            treePlaceholderPage
          }
        }
        .frame(maxWidth: .infinity)
      }
    } else {
      HStack(spacing: 0) {
        if treeShown {
          treeColumn()
            .frame(width: 300)
            .transition(.move(edge: .leading).combined(with: .opacity))
          DuoSeam(axis: .vertical)
            .ignoresSafeArea()
        }
        groups.first
          .frame(maxWidth: .infinity)
        if side != nil {
          DuoSeam(axis: .vertical)
            .ignoresSafeArea()
          groups.second
            .frame(maxWidth: .infinity)
        }
      }
    }
  }

  @ViewBuilder
  private func portraitLayout(fold: DuoFold, size: CGSize) -> some View {
    let treeShown = treeShownChoice ?? defaultTreeShown(landscape: false, fold: fold)
    let groups = editorGroups(landscape: false, fold: fold)
    if case .stacked(let rect) = fold {
      let top = max(0, min(rect.minY, size.height))
      VStack(spacing: 0) {
        Group {
          if side != nil || !treeShown {
            groups.first
          } else {
            // The top page: its bar carries the app tabs.
            treeColumn(carriesAppTabs: true)
          }
        }
        .frame(height: top)
        DuoSeam(axis: .horizontal, foldRect: rect)
          .ignoresSafeArea()
        Group {
          if side != nil {
            groups.second
          } else if treeShown {
            groups.first
          } else {
            treePlaceholderPage
          }
        }
        .frame(maxHeight: .infinity)
      }
    } else {
      VStack(spacing: 0) {
        groups.first
          .frame(maxHeight: .infinity)
        if side != nil {
          DuoSeam(axis: .horizontal)
            .ignoresSafeArea()
          groups.second
            .frame(maxHeight: .infinity)
        }
      }
      .overlay(alignment: .leading) {
        if treeShown {
          treeColumn(overlay: true)
            .frame(width: 320)
            .background(ADEColor.pageBackground)
            .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 18, x: 4)
            .padding(8)
            .transition(.move(edge: .leading).combined(with: .opacity))
        }
      }
    }
  }

  // MARK: Columns

  /// The tree. Over the editor (held portrait, flat) it slides away once a
  /// file is picked, the way a sidebar overlay does.
  private func treeColumn(overlay: Bool = false, carriesAppTabs: Bool = false) -> some View {
    NavigationStack {
      tree { path, line in
        open(path, line: line)
        if overlay {
          withAnimation(motion) { treeShownChoice = false }
        }
      }
      .navigationTitle("Files")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .primaryAction) {
          Button(action: onFind) {
            Label("Search", systemImage: "magnifyingglass")
          }
        }
        if carriesAppTabs {
          DuoAppTabsToolbar()
        }
      }
    }
  }

  /// What a page shows when the tree is hidden and only one group is open:
  /// a quiet invitation, never an empty slab.
  private var treePlaceholderPage: some View {
    // Its own stack: when it is the right page, it carries the edge bar.
    NavigationStack {
      ContentUnavailableView(
        "Open a file beside this one",
        systemImage: "rectangle.split.2x1",
        description: Text("Choose Open to the Side from a file, or show the tree.")
      )
      .toolbar { DuoAppTabsToolbar() }
    }
  }

  /// Whether this group's stack carries the app tabs: the trailing column held
  /// landscape (the edge bar), the top group held portrait (its top bar).
  private func groupCarriesAppTabs(isSide: Bool, treeShown: Bool, landscape: Bool, fold: DuoFold) -> Bool {
    guard landscape else {
      // Laptop-folded with the tree on the top page, the tree carries them.
      if fold.isStacked, side == nil, treeShown { return false }
      return !isSide
    }
    if isSide { return true }
    guard side == nil else { return false }
    // Book-folded with the tree hidden, this group is the left page and the
    // placeholder page beside it is the trailing column.
    if case .sideBySide = fold, !treeShown { return false }
    return true
  }

  private func editorGroups(landscape: Bool, fold: DuoFold) -> (first: AnyView, second: AnyView) {
    let treeShown = treeShownChoice ?? defaultTreeShown(landscape: landscape, fold: fold)
    let first = group(primary, isSide: false, treeShown: treeShown, landscape: landscape, fold: fold)
    let second = group(side, isSide: true, treeShown: treeShown, landscape: landscape, fold: fold)
    return (first, second)
  }

  private func group(
    _ ref: DuoFilesEditorRef?,
    isSide: Bool,
    treeShown: Bool,
    landscape: Bool,
    fold: DuoFold
  ) -> AnyView {
    let toggleTree = { self.toggleTree(defaultShown: defaultTreeShown(landscape: landscape, fold: fold)) }
    let carriesAppTabs = groupCarriesAppTabs(isSide: isSide, treeShown: treeShown, landscape: landscape, fold: fold)
    guard let ref else {
      return AnyView(
        NavigationStack {
          ContentUnavailableView(
            "Select a file",
            systemImage: "doc.text",
            description: Text("Pick a file in the tree to read it here.")
          )
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .toolbar {
            ToolbarItem(placement: .topBarLeading) {
              Button(action: toggleTree) {
                Label(treeShown ? "Hide Files" : "Show Files", systemImage: "sidebar.left")
              }
            }
            ToolbarItem(placement: .primaryAction) {
              Button(action: onFind) {
                Label("Search", systemImage: "magnifyingglass")
              }
            }
            if carriesAppTabs {
              DuoAppTabsToolbar()
            }
          }
        }
      )
    }
    // Each group is its own stack, so each carries its own controls: the
    // trailing one in the edge bar held landscape, the other in its top bar.
    let chrome = FilesDuoEditorChrome(
      onOpenToSide: side == nil ? { openToSide(ref.path) } : nil,
      onCloseGroup: side == nil ? nil : { closeGroup(isSide: isSide) },
      onFind: onFind,
      onToggleTree: side == nil ? toggleTree : nil,
      treeVisible: treeShown,
      // Beside another group, or held portrait where the bar runs across the
      // top: secondary actions go to the overflow so the file name keeps room.
      condensed: (side != nil && !isSide) || !landscape
    )
    return AnyView(
      NavigationStack {
        editor(ref, chrome)
          .toolbar {
            if carriesAppTabs {
              DuoAppTabsToolbar()
            }
          }
      }
      .id("\(isSide ? "side" : "main")|\(ref.workspaceId)|\(ref.path)")
      // The tree opens files into the group touched last.
      .simultaneousGesture(TapGesture().onEnded {
        guard side != nil, sideFocused != isSide else { return }
        sideFocused = isSide
      })
    )
  }

  // MARK: Actions

  /// The tree's default: shown beside one group held landscape (flat, or as
  /// its own page in a book fold), as the top page in a laptop fold, folded
  /// away for two groups, and over the editor only on request when the window
  /// is taller than wide (held portrait flat, or one page of a book).
  private func defaultTreeShown(landscape: Bool, fold: DuoFold) -> Bool {
    if side != nil { return false }
    return landscape || fold.isStacked
  }

  private func toggleTree(defaultShown: Bool) {
    withAnimation(motion) {
      treeShownChoice = !(treeShownChoice ?? defaultShown)
    }
  }

  private func open(_ path: String, line: Int?) {
    if side != nil, sideFocused, let current = side {
      side = DuoFilesEditorRef(workspaceId: current.workspaceId, path: path, focusLine: line)
    } else {
      openPrimary(path, line)
    }
  }

  private func openToSide(_ path: String) {
    guard let workspaceId = primary?.workspaceId ?? side?.workspaceId else {
      openPrimary(path, nil)
      return
    }
    withAnimation(motion) {
      side = DuoFilesEditorRef(workspaceId: workspaceId, path: path, focusLine: nil)
      sideFocused = true
      treeShownChoice = nil
    }
  }

  private func closeGroup(isSide: Bool) {
    withAnimation(motion) {
      if !isSide, let side {
        openPrimary(side.path, side.focusLine)
      }
      side = nil
      sideFocused = false
      treeShownChoice = nil
    }
  }
}

// MARK: - CTO

/// The CTO tab on the inner display: the CTO chat beside a live overview of
/// what the CTO is watching. Held landscape they are two pages (one each when
/// book-folded). Folded laptop the overview is the top half; upright and flat
/// the chat is full and the toolbar's Overview toggle puts the overview beside
/// it, as two narrower pages.
struct DuoCtoWide<Chat: View>: View {
  let title: String
  let onOpenSettings: () -> Void
  var isTabActive = true
  /// Fixtures hand the overview its rows; the app builds them.
  var overviewModel: DuoCtoOverviewModel? = nil
  @ViewBuilder var chat: () -> Chat

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var overviewChoice: Bool?

  var body: some View {
    DuoLocalFoldReader { fold, size in
      let landscape = size.width > size.height
      let overviewShown = overviewChoice ?? defaultOverviewShown(landscape: landscape, fold: fold)
      layout(fold: fold, size: size, landscape: landscape, overviewShown: overviewShown)
        .toolbar {
          ToolbarItem(placement: .primaryAction) {
            Button {
              withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) {
                overviewChoice = !overviewShown
              }
            } label: {
              Label(overviewShown ? "Hide Overview" : "Show Overview", systemImage: "rectangle.split.2x1")
            }
          }
          ToolbarItem(placement: .primaryAction) {
            Button(action: onOpenSettings) {
              Label("CTO Settings", systemImage: "gearshape")
            }
          }
          DuoAppTabsToolbar()
        }
    }
    .navigationTitle(title)
    .navigationSubtitle("Chief of staff")
  }

  @ViewBuilder
  private func layout(fold: DuoFold, size: CGSize, landscape: Bool, overviewShown: Bool) -> some View {
    if !overviewShown {
      chat()
    } else if landscape {
      DuoTwoPages {
        chat()
      } second: {
        DuoCtoOverview(isActive: isTabActive, fixedModel: overviewModel)
      }
    } else if case .stacked = fold {
      DuoTwoPages {
        DuoCtoOverview(isActive: isTabActive, fixedModel: overviewModel)
      } second: {
        chat()
      }
    } else {
      // Upright and flat: the same two pages as held landscape, narrower. The
      // overview starts hidden here (the chat would drop under ~430pt).
      DuoTwoPages(flatShare: 0.56, sideBySideWhenUpright: true) {
        chat()
      } second: {
        DuoCtoOverview(isActive: isTabActive, fixedModel: overviewModel)
      }
    }
  }

  private func defaultOverviewShown(landscape: Bool, fold: DuoFold) -> Bool {
    if landscape { return true }
    return fold.isStacked
  }
}

/// What the CTO overview lists, read from the rows the phone already holds.
struct DuoCtoOverviewModel: Equatable {
  var needsYou: [DuoNeedsYouItem] = []
  var running: [DuoNeedsYouItem] = []
  var pullRequests: [PullRequestListItem] = []
  var machines: [DuoHomeMachine] = []

  /// Built from the active project's local roster (the Work tab's rows, from
  /// the replicated database) and its cached pull requests. No request.
  @MainActor
  static func build(syncService: SyncService, fleet: MachineFleet) async -> DuoCtoOverviewModel {
    var model = DuoCtoOverviewModel()
    model.machines = duoHomeMachines(syncService: syncService, fleet: fleet)
    if let roster = syncService.buildActiveProjectLocalRoster(),
       let project = syncService.projects.first(where: { $0.id == syncService.activeProjectId }) {
      let presentation = buildHubProjectPresentation(
        project: project,
        roster: roster,
        isActive: true,
        isSwitching: false
      )
      model.apply(presentations: [presentation])
    }
    let prs = (try? await syncService.fetchPullRequestListItems()) ?? []
    model.pullRequests = duoCtoPullRequestsNeedingAction(prs)
    return model
  }

  mutating func apply(presentations: [HubProjectPresentation]) {
    needsYou = duoNeedsYouItems(from: presentations)
    var working: [DuoNeedsYouItem] = []
    for presentation in presentations {
      for lane in presentation.lanes {
        for row in lane.rows where row.boardState.column == .working {
          working.append(DuoNeedsYouItem(project: presentation.project, lane: lane.lane, row: row))
        }
      }
    }
    let needsYouIds = Set(needsYou.map(\.id))
    running = working
      .filter { !needsYouIds.contains($0.id) }
      .sorted { ($0.row.chat.lastActivityAt ?? "") > ($1.row.chat.lastActivityAt ?? "") }
  }
}

/// Open pull requests with something to act on: failing checks, changes
/// requested, or approved and green (ready to merge). Newest first.
func duoCtoPullRequestsNeedingAction(_ items: [PullRequestListItem]) -> [PullRequestListItem] {
  items
    .filter { item in
      guard item.state.lowercased() == "open" else { return false }
      let checks = item.checksStatus.lowercased()
      let review = item.reviewStatus.lowercased()
      return checks == "failing" || checks == "failure"
        || review == "changes_requested"
        || (review == "approved" && (checks == "passing" || checks == "success" || checks == "none"))
    }
    .sorted { $0.updatedAt > $1.updatedAt }
}

/// The CTO's live overview: Needs you, Running now, pull requests that need an
/// action, and the machines. Rows open their targets the app's usual way.
struct DuoCtoOverview: View {
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var machineFleet: MachineFleet
  var isActive = true
  /// Fixtures hand the model in; the app builds it from the local rows.
  var fixedModel: DuoCtoOverviewModel?

  @State private var model = DuoCtoOverviewModel()

  private var shown: DuoCtoOverviewModel { fixedModel ?? model }

  var body: some View {
    List {
      Section {
        if shown.needsYou.isEmpty {
          DuoOverviewQuietRow(
            symbol: "checkmark.circle",
            title: "Nothing needs you",
            detail: "No chat is waiting on an answer."
          )
        } else {
          ForEach(shown.needsYou) { item in
            DuoWidgetChatRow(item: item) { openChat(item) }
              .listRowInsets(EdgeInsets())
          }
        }
      } header: {
        DuoOverviewSectionHeader(
          title: "Needs you",
          count: shown.needsYou.isEmpty ? nil : shown.needsYou.count,
          actionTitle: "Activity",
          action: { syncService.attentionDrawerPresented = true }
        )
      }

      Section {
        if shown.running.isEmpty {
          Text("No agent is running.")
            .foregroundStyle(ADEColor.textSecondary)
        } else {
          ForEach(shown.running) { item in
            DuoWidgetChatRow(item: item) { openChat(item) }
              .listRowInsets(EdgeInsets())
          }
        }
      } header: {
        DuoOverviewSectionHeader(
          title: "Running now",
          count: shown.running.isEmpty ? nil : shown.running.count
        )
      }

      Section {
        if shown.pullRequests.isEmpty {
          Text("No pull request needs an action.")
            .foregroundStyle(ADEColor.textSecondary)
        } else {
          ForEach(shown.pullRequests) { pr in
            DuoCtoPullRequestRow(pr: pr) {
              syncService.requestedPrNavigation = PrNavigationRequest(
                prId: pr.id,
                prNumber: pr.githubPrNumber,
                laneId: pr.laneId
              )
            }
          }
        }
      } header: {
        DuoOverviewSectionHeader(
          title: "Pull requests",
          count: shown.pullRequests.isEmpty ? nil : shown.pullRequests.count
        )
      }

      Section {
        ForEach(shown.machines) { machine in
          DuoWidgetMachineRow(machine: machine) {
            syncService.settingsPresented = true
          }
          .listRowInsets(EdgeInsets())
        }
      } header: {
        DuoOverviewSectionHeader(
          title: "Machines",
          actionTitle: "Manage",
          action: { syncService.settingsPresented = true }
        )
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
    .background(ADEColor.pageBackground)
    // Rebuilt when the local rows change, the same signal the CTO tab already
    // reloads on, and only while the tab is on screen.
    .task(id: overviewReloadKey) {
      guard fixedModel == nil, overviewReloadKey != nil else { return }
      let next = await DuoCtoOverviewModel.build(syncService: syncService, fleet: machineFleet)
      if next != model { model = next }
    }
  }

  private var overviewReloadKey: String? {
    guard isActive else { return nil }
    return "\(syncService.activeProjectId ?? "")|\(syncService.localStateRevision)|\(machineFleet.machines.count)"
  }

  /// Opens the chat in Work, on the machine and lane it belongs to.
  private func openChat(_ item: DuoNeedsYouItem) {
    syncService.requestedWorkSessionNavigation = WorkSessionNavigationRequest(
      sessionId: item.row.chat.id,
      laneId: item.row.chat.laneId
    )
  }
}

/// A pull request in the CTO overview: number and title, branch → base, the
/// checks and review state, and the diff size.
struct DuoCtoPullRequestRow: View {
  let pr: PullRequestListItem
  let action: () -> Void

  private var checksTone: ADEKitTone {
    switch pr.checksStatus.lowercased() {
    case "failing", "failure": return .crit
    case "pending", "running": return .warn
    case "passing", "success": return .ok
    default: return .neutral
    }
  }

  private var reviewWord: String? {
    switch pr.reviewStatus.lowercased() {
    case "approved": return "Approved"
    case "changes_requested": return "Changes requested"
    case "review_required", "requested": return "Review requested"
    default: return nil
    }
  }

  var body: some View {
    Button(action: action) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        Text(verbatim: "#\(pr.githubPrNumber)")
          .font(.subheadline.monospacedDigit())
          .foregroundStyle(ADEColor.textSecondary)
          .frame(minWidth: 44, alignment: .leading)

        VStack(alignment: .leading, spacing: 3) {
          Text(pr.title)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          HStack(spacing: 6) {
            ADEKitDot(tone: checksTone, size: 6)
            Text("\(pr.headBranch) → \(pr.baseBranch)")
              .font(.caption.monospaced())
              .lineLimit(1)
              .truncationMode(.middle)
            if let reviewWord {
              Text("· \(reviewWord)")
                .font(.caption)
                .lineLimit(1)
            }
          }
          .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 6)

        HStack(spacing: 4) {
          Text("+\(pr.additions)").foregroundStyle(ADEColor.success)
          Text("−\(pr.deletions)").foregroundStyle(ADEColor.danger)
        }
        .font(.caption.monospacedDigit())
        .fixedSize()
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Pull request \(pr.githubPrNumber), \(pr.title)")
    .accessibilityHint("Opens it in PRs.")
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
      duoFolderPath: parentDirectory(of: DuoWindowsFixtureData.openFilePath),
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
      tree: { _ in EmptyView() },
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

/// The CTO tab's wide body around the real chat view (Work's fixture
/// transcript; the CTO thread itself needs a machine) and the real overview
/// over fixture rows.
private struct DuoCtoFixture: View {
  var body: some View {
    NavigationStack {
      DuoCtoWide(title: "CTO", onOpenSettings: {}, overviewModel: DuoWindowsFixtureData.ctoOverview) {
        workPreviewChatSessionView()
      }
      .tint(ADEColor.ctoAccent)
      .adeScreenBackground()
      .navigationBarTitleDisplayMode(.inline)
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

  // MARK: CTO overview

  static var ctoOverview: DuoCtoOverviewModel {
    let project = MobileProjectSummary(
      id: projectId,
      displayName: "ADE",
      rootPath: "/Users/arul/ADE",
      repoOwner: "arul28",
      repoName: "ADE",
      laneCount: 3,
      isAvailable: true,
      isCached: true,
      isOpen: true
    )
    let lanes = [
      RemoteRosterLane(id: "l-duo", name: "iPhone Duo", color: "#60a5fa", icon: nil, laneType: "worktree", branchRef: "ade/iphone-duo"),
      RemoteRosterLane(id: "l-sync", name: "Sync", color: "#34d399", icon: nil, laneType: "worktree", branchRef: "ade/sync"),
      RemoteRosterLane(id: "l-main", name: "main", color: "#a78bfa", icon: nil, laneType: "primary", branchRef: "main"),
    ]
    func stamp(_ minutes: Int) -> String {
      ISO8601DateFormatter().string(from: Date().addingTimeInterval(-Double(minutes) * 60))
    }
    func chat(_ id: String, _ lane: String, _ title: String, _ status: RemoteRosterChatStatus, awaiting: Bool = false, minutes: Int) -> RemoteRosterChat {
      RemoteRosterChat(
        id: id, laneId: lane, chatSessionId: nil, title: title, provider: "claude", model: "claude-sonnet-5",
        toolType: "claude-chat", status: status, awaitingInput: awaiting, pinned: false, archived: false,
        lastActivityAt: stamp(minutes), preview: nil
      )
    }
    let chats = [
      chat("c-1", "l-duo", "Files window toolbar", .awaiting, awaiting: true, minutes: 2),
      chat("c-2", "l-sync", "Reconnect drops CTO thread", .failed, minutes: 14),
      chat("c-3", "l-duo", "Linear three-pane window", .running, minutes: 1),
      chat("c-4", "l-main", "Release notes for 1.2.117", .running, minutes: 6),
    ]
    let roster = RemoteRosterProject(
      projectId: projectId, rootPath: project.rootPath, displayName: "ADE", iconDataUrl: nil, lastOpenedAt: nil,
      booted: true, runningCount: 2, attentionCount: 2, lanes: lanes, chats: chats
    )
    var model = DuoCtoOverviewModel()
    model.apply(presentations: [
      buildHubProjectPresentation(project: project, roster: roster, isActive: true, isSwitching: false)
    ])
    model.pullRequests = [
      pr(1372, "Duo windows: Files, CTO, Linear, Settings", head: "ade/iphone-duo", checks: "passing", review: "approved", add: 1_840, del: 212),
      pr(1369, "Sync: retry the CTO ensure after reconnect", head: "ade/sync", checks: "failing", review: "review_required", add: 96, del: 31),
    ]
    model.machines = [
      DuoHomeMachine(id: "m-1", name: "Arul's MacBook Pro", statusWord: "Connected", tone: .ok, isFocused: true, projectCount: 3, workingCount: 2),
      DuoHomeMachine(id: "m-2", name: "Mac Studio", statusWord: "Live", tone: .ok, projectCount: 2, workingCount: 1),
    ]
    return model
  }

  private static func pr(_ number: Int, _ title: String, head: String, checks: String, review: String, add: Int, del: Int) -> PullRequestListItem {
    PullRequestListItem(
      id: "pr-\(number)", laneId: "l-duo", laneName: nil, projectId: projectId, repoOwner: "arul28", repoName: "ADE",
      githubPrNumber: number, githubUrl: "https://github.com/arul28/ADE/pull/\(number)", title: title, state: "open",
      baseBranch: "main", headBranch: head, checksStatus: checks, reviewStatus: review, additions: add, deletions: del,
      lastSyncedAt: nil, createdAt: "2026-10-20T10:00:00Z", updatedAt: "2026-10-21T\(number % 24):00:00Z",
      adeKind: nil, linkedGroupId: nil, linkedGroupType: nil, linkedGroupName: nil, linkedGroupPosition: nil,
      linkedGroupCount: 0, workflowDisplayState: nil, cleanupState: nil
    )
  }
}
#endif
