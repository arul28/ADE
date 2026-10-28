import SwiftUI

/// The viewer column with no file open: desktop's WarmEmptyState. One line,
/// one action (search), then the shortest paths back into the workspace —
/// what this lane has changed (from the lane's cached detail; no request) and
/// what was read here recently.
struct FilesNoFileOpenView: View {
  @EnvironmentObject private var syncService: SyncService

  let workspace: FilesWorkspace?
  let recentPaths: [String]
  let onSearch: () -> Void
  let onOpen: (String) -> Void

  @State private var changes: [FileChange] = []

  var body: some View {
    GeometryReader { proxy in
    ScrollView {
      VStack(spacing: 0) {
        VStack(spacing: 10) {
          Image(systemName: "doc.text")
            .font(.system(size: 30, weight: .light))
            .foregroundStyle(ADEColor.textMuted)
          Text("No file open")
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
          Text(workspace.map { "Pick a file in the tree, or search \($0.name)." } ?? "Pick a workspace to browse its files.")
            .font(.subheadline)
            .foregroundStyle(ADEColor.textSecondary)
            .multilineTextAlignment(.center)
          if workspace != nil {
            Button(action: onSearch) {
              Label("Search Files", systemImage: "magnifyingglass")
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 6)
            }
            .buttonStyle(.glass)
            .padding(.top, 4)
          }
        }
        .padding(.bottom, 22)

        if !changes.isEmpty {
          section("Changed in this lane", count: changes.count) {
            // The header counts every change, so list them (the page
            // scrolls); it showed 8 under "17".
            ForEach(changes.prefix(60)) { change in
              pathRow(change.path, badge: filesChangeBadge(change.kind))
            }
          }
        }
        if !recentPaths.isEmpty {
          section("Recent", count: nil) {
            ForEach(recentPaths.prefix(5), id: \.self) { path in
              pathRow(path, badge: nil)
            }
          }
        }
      }
      .frame(maxWidth: 380)
      .padding(.horizontal, 24)
      .padding(.vertical, 32)
      .frame(maxWidth: .infinity, minHeight: proxy.size.height)
    }
    .scrollBounceBehavior(.basedOnSize)
    }
    .background(ADEColor.pageBackground)
    .task(id: workspace?.laneId) {
      await loadChanges()
    }
  }

  private func section<Content: View>(_ title: String, count: Int?, @ViewBuilder content: () -> Content) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Text(title.uppercased())
          .font(.caption2.weight(.semibold))
          .tracking(0.6)
          .foregroundStyle(ADEColor.textMuted)
        if let count {
          Text("\(count)")
            .font(.caption2.monospacedDigit())
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .padding(.horizontal, 10)
      .padding(.bottom, 4)
      content()
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.bottom, 18)
  }

  private func pathRow(_ path: String, badge: FilesChangeBadge?) -> some View {
    let name = lastPathComponent(path)
    let folder = parentDirectory(of: path)
    return Button {
      onOpen(path)
    } label: {
      HStack(spacing: 8) {
        Image(systemName: filesGlyph(for: name))
          .font(.system(size: 13))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 18)
        Text(name)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .layoutPriority(1)
        Text(folder)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.head)
          .frame(maxWidth: .infinity, alignment: .trailing)
        if let badge {
          Text(badge.letter)
            .font(.caption2.monospaced().weight(.bold))
            .foregroundStyle(badge.color)
            .frame(minWidth: 14)
        }
      }
      .padding(.horizontal, 10)
      .frame(minHeight: 36)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(badge.map { "\(name), \($0.title), in \(folder.isEmpty ? "root" : folder)" } ?? "\(name), in \(folder.isEmpty ? "root" : folder)")
  }

  @MainActor
  private func loadChanges() async {
    guard let laneId = workspace?.laneId,
          let detail = try? await syncService.fetchLaneDetail(laneId: laneId),
          let diff = detail.diffChanges
    else {
      if !changes.isEmpty { changes = [] }
      return
    }
    var seen = Set<String>()
    let merged = (diff.staged + diff.unstaged).filter { change in
      // Deleted files have nothing to open.
      guard change.kind.lowercased() != "deleted", change.kind.uppercased() != "D" else { return false }
      return seen.insert(change.path).inserted
    }
    if merged != changes { changes = merged }
  }
}

// MARK: - The wide Files window

/// One open file in an editor group.
struct DuoFilesEditorRef: Equatable {
  var workspaceId: String
  var path: String
  var focusLine: Int?
}

extension FilesRootScreen {
  /// The Files tab in a wide window (the Duo's inner display, an iPad): the
  /// tree beside one or two editor groups. See `DuoFilesWindow`.
  var duoFilesWindowBody: some View {
    DuoFilesWindow(
      primary: duoWindowPrimaryEditor,
      openPrimary: { path, line in
        guard let workspace = selectedWorkspace else { return }
        openFile(path, in: workspace, focusLine: line)
      },
      onFind: presentSearch,
      tree: { open, carriesAppTabs in
        NavigationStack {
          filesTreeList(selectedPath: duoWindowPrimaryEditor?.path) { path in
            selectedFileTransitionPath = path
            open(path, nil)
          }
          .filesTreeChrome(
            projectIconDataUrl: projectIconDataUrl,
            onBackToHub: { syncService.showProjectHub() }
          ) {
            // Search is the viewer's (the rail's top held landscape).
            filesTreeHeaderRow(showsSearch: false)
          }
          // The column ends at the seam: the trailing inset iOS reports here
          // is the edge bar's, not this column's.
          .duoLeadingColumnContent()
          .toolbar {
            if carriesAppTabs {
              DuoAppTabsToolbar(includesUtilities: !duoLayout.hasEdgeBar)
            }
          }
        }
      },
      editor: { ref, chrome in
        if let workspace = workspaces.first(where: { $0.id == ref.workspaceId }) {
          FilesDetailScreen(
            workspace: workspace,
            relativePath: ref.path,
            focusLine: ref.focusLine,
            transitionNamespace: nil,
            navigateToDirectory: { path in openDirectory(path, in: workspace) },
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
      },
      noFile: AnyView(
        FilesNoFileOpenView(
          workspace: selectedWorkspace,
          recentPaths: treeModel.recentPaths,
          onSearch: presentSearch,
          onOpen: { path in
            guard let workspace = selectedWorkspace else { return }
            openFile(path, in: workspace, focusLine: nil)
          }
        )
        .environmentObject(syncService)
      )
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
}

/// Desktop's Files workbench in a wide window: the tree, then one or two
/// editor groups.
///
/// - Held landscape, flat: tree (320) | editor. "Open to the Side" adds a
///   second group; the tree folds away and the groups split 50/50.
/// - Book: the tree is the left page and the editor the right (split at the
///   hinge); with two groups each group is a page.
/// - Upright and flat (and an iPad): tree | editor, narrower. Where the
///   editor would drop under ~430pt the tree steps aside once a file opens and
///   the toggle brings it back.
/// - Laptop: the tree on the top half, the editor below; two groups stack.
///
/// The tree and each group are their own navigation stacks. Held landscape,
/// the right-most one gets the system edge bar; its bottom is the five app
/// tabs and its top the viewer's actions.
struct DuoFilesWindow<Tree: View, Editor: View>: View {
  let primary: DuoFilesEditorRef?
  let openPrimary: (String, Int?) -> Void
  let onFind: () -> Void
  @ViewBuilder var tree: (_ open: @escaping (String, Int?) -> Void, _ carriesAppTabs: Bool) -> Tree
  @ViewBuilder var editor: (DuoFilesEditorRef, FilesDuoEditorChrome) -> Editor
  /// What a group shows with no file open.
  var noFile: AnyView = AnyView(EmptyView())

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.duoLayout) private var duoLayout
  /// The second group's file ("Open to the Side"). Nil for one group.
  @State var side: DuoFilesEditorRef?
  @State private var sideFocused = false
  /// The user's tree toggle. Nil follows the layout's default.
  @State private var treeShownChoice: Bool?
  /// Upright and too narrow for tree and code side by side.
  @State private var narrowUpright = false

  static var treeWidth: CGFloat { 320 }
  private static var minimumEditorWidth: CGFloat { 430 }

  private var motion: Animation? {
    reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)
  }

  var body: some View {
    DuoLocalFoldReader { fold, size, landscape in
      let narrow = !landscape && !fold.isStacked && size.width - Self.treeWidth < Self.minimumEditorWidth
      Group {
        if landscape {
          landscapeLayout(fold: fold, size: size)
        } else if fold.isStacked {
          stackedLayout(fold: fold, size: size)
        } else {
          uprightLayout(size: size)
        }
      }
      .onChange(of: narrow, initial: true) { _, value in narrowUpright = value }
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

  /// Held landscape. Only ever two navigation stacks, created once: the
  /// tree's (kept alive at zero width while hidden) and the right-most one,
  /// which the edge bar follows. A stack created beside the edge bar's stack
  /// later (a second editor group as its own stack, or the tree coming back)
  /// left the bar with no top items and two empty capsules at the bottom, so
  /// two groups share the right-most stack instead.
  @ViewBuilder
  private func landscapeLayout(fold: DuoFold, size: CGSize) -> some View {
    let treeShown = isTreeShown(fold: fold, landscape: true)
    let book: CGRect? = {
      if case .sideBySide(let rect) = fold, rect.minX > 0 { return rect }
      return nil
    }()
    let leadWidth: CGFloat = book.map { max(0, min($0.minX, size.width)) } ?? Self.treeWidth
    HStack(spacing: 0) {
      tree(open, false)
        .frame(width: treeShown ? leadWidth : 0)
        // The tree scrolls to the screen's bottom edge like every other
        // list column; clipped at the safe area it ended in a hard cut.
        .ignoresSafeArea(.container, edges: .bottom)
        .opacity(treeShown ? 1 : 0)
        .allowsHitTesting(treeShown)
        .accessibilityHidden(!treeShown)
        .clipped()
      if treeShown {
        DuoSeam(axis: .vertical, foldRect: book)
          .ignoresSafeArea()
      }
      Group {
        if let side, let primary {
          pairedGroups(primary: primary, side: side, book: book, size: size, fold: fold)
        } else {
          group(primary, isSide: false, carriesAppTabs: true, runsUnderRail: false, fold: fold, landscape: true)
        }
      }
      .frame(maxWidth: .infinity)
    }
  }

  /// Two editor groups in the right-most stack: the right one's controls
  /// are the edge bar's top, the left one's sit in its own header capsule.
  private func pairedGroups(primary: DuoFilesEditorRef, side: DuoFilesEditorRef, book: CGRect?, size: CGSize, fold: DuoFold) -> some View {
    let leftChrome = FilesDuoEditorChrome(
      onCloseGroup: { closeGroup(isSide: false) },
      onFind: onFind,
      treeVisible: false,
      declaresToolbar: false
    )
    let rightChrome = FilesDuoEditorChrome(
      onCloseGroup: { closeGroup(isSide: true) },
      onFind: onFind,
      treeVisible: false,
      runsUnderRail: false
    )
    let leftWidth = book.map { max(0, min($0.minX, size.width)) } ?? size.width / 2
    return NavigationStack {
      HStack(spacing: 0) {
        editor(primary, leftChrome)
          .id("pair-left|\(primary.workspaceId)|\(primary.path)")
          .frame(width: leftWidth)
          .simultaneousGesture(TapGesture().onEnded { sideFocused = false })
        DuoSeam(axis: .vertical, foldRect: book)
          .ignoresSafeArea()
        editor(side, rightChrome)
          .id("pair-right|\(side.workspaceId)|\(side.path)")
          .frame(maxWidth: .infinity)
          .simultaneousGesture(TapGesture().onEnded { sideFocused = true })
      }
      .toolbar { DuoAppTabsToolbar(includesUtilities: !duoLayout.hasEdgeBar) }
    }
  }

  /// Laptop / tent: the top half and the bottom half, split at the hinge.
  @ViewBuilder
  private func stackedLayout(fold: DuoFold, size: CGSize) -> some View {
    let treeShown = isTreeShown(fold: fold, landscape: false)
    if case .stacked(let rect) = fold {
      let top = max(0, min(rect.minY, size.height))
      VStack(spacing: 0) {
        Group {
          if side != nil || !treeShown {
            group(primary, isSide: false, carriesAppTabs: true, runsUnderRail: false, fold: fold, landscape: false)
          } else {
            // The top page: its bar carries the app tabs menu.
            tree(open, true)
          }
        }
        .frame(height: top)
        DuoSeam(axis: .horizontal, foldRect: rect)
          .ignoresSafeArea()
        Group {
          if side != nil {
            group(side, isSide: true, carriesAppTabs: false, runsUnderRail: false, fold: fold, landscape: false)
          } else if treeShown {
            group(primary, isSide: false, carriesAppTabs: false, runsUnderRail: false, fold: fold, landscape: false)
          } else {
            noFileStack(carriesAppTabs: false, fold: fold, landscape: false)
          }
        }
        .frame(maxHeight: .infinity)
      }
    }
  }

  /// Upright and flat, and an iPad: tree | editor side by side.
  @ViewBuilder
  private func uprightLayout(size: CGSize) -> some View {
    let fold = DuoFold.none
    let treeShown = isTreeShown(fold: fold, landscape: false)
    HStack(spacing: 0) {
      if treeShown {
        tree(open, false)
          .frame(width: min(Self.treeWidth, size.width * 0.5))
          .transition(.move(edge: .leading).combined(with: .opacity))
        DuoSeam(axis: .vertical)
          .ignoresSafeArea()
      }
      if let side, let primary {
        // Too narrow for two editors side by side, and two stacked halves
        // showed a few lines each: one editor at a time, the two files a
        // switcher in its header.
        group(
          sideFocused ? side : primary,
          isSide: sideFocused,
          carriesAppTabs: true,
          runsUnderRail: false,
          fold: fold,
          landscape: false,
          switcher: AnyView(editorSwitcher(primary: primary, side: side))
        )
        .frame(maxWidth: .infinity)
      } else {
        group(primary, isSide: false, carriesAppTabs: true, runsUnderRail: false, fold: fold, landscape: false)
          .frame(maxWidth: .infinity)
      }
    }
  }

  // MARK: Groups

  /// The two open files, one shown at a time (a narrow window).
  private func editorSwitcher(primary: DuoFilesEditorRef, side: DuoFilesEditorRef) -> some View {
    Picker("Editor", selection: Binding(
      get: { sideFocused },
      set: { next in
        ADEHaptics.light()
        sideFocused = next
      }
    )) {
      Text(verbatim: (primary.path as NSString).lastPathComponent).tag(false)
      Text(verbatim: (side.path as NSString).lastPathComponent).tag(true)
    }
    .pickerStyle(.segmented)
    .padding(.horizontal, 16)
    .padding(.top, 4)
    .padding(.bottom, 8)
    .frame(maxWidth: .infinity)
    .background(ADEColor.pageBackground)
  }

  private func noFileStack(carriesAppTabs: Bool, fold: DuoFold, landscape: Bool) -> some View {
    let treeShown = isTreeShown(fold: fold, landscape: landscape)
    return NavigationStack {
      noFile
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .topBarLeading) {
            Button {
              toggleTree(fold: fold, landscape: landscape)
            } label: {
              Label(treeShown ? "Hide Files" : "Show Files", systemImage: "sidebar.left")
            }
          }
          ToolbarItem(placement: .primaryAction) {
            Button(action: onFind) {
              Label("Search", systemImage: "magnifyingglass")
            }
          }
          if carriesAppTabs {
            DuoAppTabsToolbar(includesUtilities: !duoLayout.hasEdgeBar)
          }
        }
    }
  }

  private func group(
    _ ref: DuoFilesEditorRef?,
    isSide: Bool,
    carriesAppTabs: Bool,
    runsUnderRail: Bool,
    fold: DuoFold,
    landscape: Bool,
    switcher: AnyView? = nil
  ) -> AnyView {
    guard let ref else {
      return AnyView(noFileStack(carriesAppTabs: carriesAppTabs, fold: fold, landscape: landscape))
    }
    let chrome = FilesDuoEditorChrome(
      onOpenToSide: side == nil ? { openToSide(ref.path) } : nil,
      onCloseGroup: side == nil ? nil : { closeGroup(isSide: isSide) },
      onFind: onFind,
      onToggleTree: side == nil ? { toggleTree(fold: fold, landscape: landscape) } : nil,
      treeVisible: isTreeShown(fold: fold, landscape: landscape),
      runsUnderRail: runsUnderRail && duoLayout.hasEdgeBar
    )
    return AnyView(
      NavigationStack {
        editor(ref, chrome)
          .safeAreaInset(edge: .top, spacing: 0) {
            if let switcher { switcher }
          }
          .toolbar {
            if carriesAppTabs {
              DuoAppTabsToolbar(includesUtilities: !duoLayout.hasEdgeBar)
            }
          }
      }
      // A stack that changes role (beside another group, or the right-most
      // one that becomes the edge bar) is a new stack: the edge bar does not
      // rebuild an existing stack's items, and left empty capsules behind.
      .id("\(isSide ? "side" : "main")|\(side != nil)|\(carriesAppTabs)|\(ref.workspaceId)|\(ref.path)")
      // The tree opens files into the group touched last.
      .simultaneousGesture(TapGesture().onEnded {
        guard side != nil, sideFocused != isSide else { return }
        sideFocused = isSide
      })
    )
  }

  // MARK: Actions

  private func defaultTreeShown(fold: DuoFold, landscape: Bool) -> Bool {
    if side != nil { return false }
    if landscape || fold.isStacked { return true }
    // Upright: beside the code when there is room, else until a file opens.
    return !narrowUpright || primary == nil
  }

  private func isTreeShown(fold: DuoFold, landscape: Bool) -> Bool {
    treeShownChoice ?? defaultTreeShown(fold: fold, landscape: landscape)
  }

  private func toggleTree(fold: DuoFold, landscape: Bool) {
    let shown = isTreeShown(fold: fold, landscape: landscape)
    withAnimation(motion) {
      treeShownChoice = !shown
    }
  }

  private func open(_ path: String, _ line: Int?) {
    if side != nil, sideFocused, let current = side {
      side = DuoFilesEditorRef(workspaceId: current.workspaceId, path: path, focusLine: line)
    } else {
      openPrimary(path, line)
    }
    // Upright and narrow, the tree steps aside for the file it opened.
    if narrowUpright, treeShownChoice == true {
      withAnimation(motion) { treeShownChoice = nil }
    }
  }

  private func openToSide(_ path: String) {
    guard let workspaceId = primary?.workspaceId ?? side?.workspaceId else {
      openPrimary(path, nil)
      return
    }
    // No animation: the edge bar does not pick up a stack that arrives
    // mid-transition.
    side = DuoFilesEditorRef(workspaceId: workspaceId, path: path, focusLine: nil)
    sideFocused = true
    treeShownChoice = nil
  }

  private func closeGroup(isSide: Bool) {
    if !isSide, let side {
      openPrimary(side.path, side.focusLine)
    }
    side = nil
    sideFocused = false
    treeShownChoice = nil
  }
}
