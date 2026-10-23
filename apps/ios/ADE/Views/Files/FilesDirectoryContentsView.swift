import SwiftUI
import UIKit

/// The Files tab's tree, desktop's FilesExplorer on iOS: folders expand in
/// place, every listing is kept for the session (per workspace), and a folder
/// paints from the phone's last cached listing while the machine answers.
///
/// Reads go through `SyncService.listTree`, which routes a workspace on
/// another machine to that machine.
@MainActor
final class FilesTreeModel: ObservableObject {
  struct Row: Identifiable, Equatable {
    enum Kind: Equatable {
      case node(FileTreeNode, isExpanded: Bool, isLoading: Bool)
      /// A folder that failed to list; tapping retries it.
      case failed(parentPath: String, message: String)
      /// An expanded folder with nothing in it.
      case empty(parentPath: String)
    }

    let id: String
    let depth: Int
    let kind: Kind
  }

  private struct WorkspaceState {
    var listings: [String: [FileTreeNode]] = [:]
    var expanded: Set<String> = []
    var loading: Set<String> = []
    var errors: [String: String] = [:]
    var recent: [String] = []
  }

  /// The visible rows, flattened in display order.
  @Published private(set) var rows: [Row] = []
  /// The open workspace's root listing state.
  @Published private(set) var rootPhase: RootPhase = .loading
  @Published private(set) var recentPaths: [String] = []

  enum RootPhase: Equatable {
    case loading
    case ready
    case empty
    case failed(String)
  }

  private weak var syncService: SyncService?
  private(set) var workspaceId: String?
  private var states: [String: WorkspaceState] = [:]
  private var inFlight: Set<String> = []

  func attach(_ syncService: SyncService) {
    if self.syncService == nil { self.syncService = syncService }
  }

  /// Shows a workspace: its kept tree at once, else the cached root listing,
  /// then the machine's answer. `refresh` re-lists what is visible (tab
  /// re-opened, pull to refresh) without spinners.
  func show(workspaceId: String, refresh: Bool) {
    let switched = self.workspaceId != workspaceId
    self.workspaceId = workspaceId
    if switched { publish() }
    let state = states[workspaceId] ?? WorkspaceState()
    if state.listings[""] == nil {
      load("", in: workspaceId)
    } else if refresh {
      Task { await refreshVisible() }
    }
  }

  /// Re-lists the root and every expanded folder of the open workspace.
  func refreshVisible() async {
    guard let workspaceId else { return }
    let state = states[workspaceId] ?? WorkspaceState()
    let paths = [""] + state.expanded.sorted()
    await withTaskGroup(of: Void.self) { group in
      for path in paths {
        group.addTask { @MainActor in
          await self.fetch(path, in: workspaceId)
        }
      }
    }
  }

  func toggle(_ path: String) {
    guard let workspaceId else { return }
    var state = states[workspaceId] ?? WorkspaceState()
    if state.expanded.contains(path) {
      state.expanded.remove(path)
      states[workspaceId] = state
      publish()
    } else {
      state.expanded.insert(path)
      states[workspaceId] = state
      publish()
      load(path, in: workspaceId)
    }
  }

  func isExpanded(_ path: String) -> Bool {
    guard let workspaceId else { return false }
    return states[workspaceId]?.expanded.contains(path) == true
  }

  /// Expands every folder down to `path` (a folder, or a file's folder) in a
  /// workspace, shown now or next.
  func reveal(_ path: String, isDirectory: Bool, in workspaceId: String) {
    let components = pathComponents(path)
    let folderCount = isDirectory ? components.count : max(0, components.count - 1)
    guard folderCount > 0 else { return }
    var folders: [String] = []
    for index in 0..<folderCount {
      folders.append(components[0...index].joined(separator: "/"))
    }
    var state = states[workspaceId] ?? WorkspaceState()
    guard !folders.allSatisfy({ state.expanded.contains($0) }) else { return }
    state.expanded.formUnion(folders)
    states[workspaceId] = state
    if workspaceId == self.workspaceId { publish() }
    for folder in folders { load(folder, in: workspaceId) }
  }

  func retry(_ path: String) {
    guard let workspaceId else { return }
    states[workspaceId, default: WorkspaceState()].errors[path] = nil
    publish()
    load(path, in: workspaceId, skipCache: true)
  }

  /// Remembers a file the user opened, newest first (this session only).
  func noteOpened(_ path: String, in workspaceId: String) {
    var state = states[workspaceId] ?? WorkspaceState()
    state.recent.removeAll { $0 == path }
    state.recent.insert(path, at: 0)
    if state.recent.count > 6 { state.recent.removeLast(state.recent.count - 6) }
    states[workspaceId] = state
    if workspaceId == self.workspaceId, recentPaths != state.recent {
      recentPaths = state.recent
    }
  }

  // MARK: Loading

  private func load(_ path: String, in workspaceId: String, skipCache: Bool = false) {
    guard states[workspaceId]?.listings[path] == nil || skipCache else { return }
    Task { [weak self] in
      guard let self else { return }
      if !skipCache, let syncService,
         let cached = await syncService.cachedDirectoryListing(workspaceId: workspaceId, parentPath: path, includeIgnored: true),
         self.states[workspaceId]?.listings[path] == nil {
        self.store(filesSortedNodes(cached), path: path, in: workspaceId)
      }
      await self.fetch(path, in: workspaceId)
    }
  }

  private func fetch(_ path: String, in workspaceId: String) async {
    guard let syncService else { return }
    let key = "\(workspaceId)\u{1}\(path)"
    guard !inFlight.contains(key) else { return }
    inFlight.insert(key)
    defer { inFlight.remove(key) }
    let showsSpinner = states[workspaceId]?.listings[path] == nil
    if showsSpinner {
      states[workspaceId, default: WorkspaceState()].loading.insert(path)
      if workspaceId == self.workspaceId { publish() }
    }
    do {
      let nodes = try await syncService.listTree(workspaceId: workspaceId, parentPath: path, includeIgnored: true)
      states[workspaceId, default: WorkspaceState()].loading.remove(path)
      states[workspaceId, default: WorkspaceState()].errors[path] = nil
      store(filesSortedNodes(nodes), path: path, in: workspaceId, force: showsSpinner)
    } catch {
      var state = states[workspaceId] ?? WorkspaceState()
      state.loading.remove(path)
      // A listing already on screen stays; only a folder with nothing to show
      // says it failed.
      if state.listings[path] == nil {
        state.errors[path] = error.localizedDescription
      }
      states[workspaceId] = state
      if workspaceId == self.workspaceId { publish() }
    }
  }

  private func store(_ nodes: [FileTreeNode], path: String, in workspaceId: String, force: Bool = false) {
    var state = states[workspaceId] ?? WorkspaceState()
    let changed = state.listings[path] != nodes
    state.listings[path] = nodes
    states[workspaceId] = state
    if (changed || force), workspaceId == self.workspaceId { publish() }
  }

  // MARK: Rows

  private func publish() {
    guard let workspaceId else {
      if !rows.isEmpty { rows = [] }
      return
    }
    let state = states[workspaceId] ?? WorkspaceState()
    var next: [Row] = []
    next.reserveCapacity(rows.count + 16)
    if let root = state.listings[""] {
      append(root, depth: 0, state: state, into: &next)
    }
    if rows != next { rows = next }

    let phase: RootPhase
    if let root = state.listings[""] {
      phase = root.isEmpty ? .empty : .ready
    } else if let message = state.errors[""] {
      phase = .failed(message)
    } else {
      phase = .loading
    }
    if rootPhase != phase { rootPhase = phase }
    if recentPaths != state.recent { recentPaths = state.recent }
  }

  private func append(_ nodes: [FileTreeNode], depth: Int, state: WorkspaceState, into rows: inout [Row]) {
    for node in nodes {
      let isDirectory = node.type == "directory"
      let isExpanded = isDirectory && state.expanded.contains(node.path)
      rows.append(Row(
        id: node.path,
        depth: depth,
        kind: .node(node, isExpanded: isExpanded, isLoading: state.loading.contains(node.path))
      ))
      guard isExpanded else { continue }
      if let children = state.listings[node.path] {
        if children.isEmpty {
          rows.append(Row(id: "\(node.path)\u{1}empty", depth: depth + 1, kind: .empty(parentPath: node.path)))
        } else {
          append(children, depth: depth + 1, state: state, into: &rows)
        }
      } else if let message = state.errors[node.path] {
        rows.append(Row(id: "\(node.path)\u{1}failed", depth: depth + 1, kind: .failed(parentPath: node.path, message: message)))
      }
    }
  }
}

/// The tree as a native list: disclosure, indentation guides, file-type
/// glyphs, git status, the open file highlighted. `header` and `footer` are
/// list sections above and below the rows (notices, proof).
struct FilesOutlineTree<Header: View, Footer: View>: View {
  @ObservedObject var model: FilesTreeModel
  let workspace: FilesWorkspace
  let selectedPath: String?
  let isLive: Bool
  let onOpenFile: (String) -> Void
  var onRefresh: (() async -> Void)? = nil
  @ViewBuilder var header: () -> Header
  @ViewBuilder var footer: () -> Footer

  @Environment(\.filesOpenToSide) private var openToSide
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// The open file the tree last scrolled to, so it scrolls once per file
  /// (when its folders have listed), not on every row change.
  @State private var revealedPath: String?

  var body: some View {
    ScrollViewReader { proxy in
      list
        .onChange(of: model.rows) { _, rows in
          scrollToSelected(rows: rows, proxy: proxy)
        }
        .onChange(of: selectedPath, initial: true) { _, _ in
          scrollToSelected(rows: model.rows, proxy: proxy)
        }
    }
  }

  /// Opening a file from search, a link or the changed list reveals it: its
  /// folders expand (the model) and the tree scrolls to it.
  private func scrollToSelected(rows: [FilesTreeModel.Row], proxy: ScrollViewProxy) {
    guard let selectedPath, revealedPath != selectedPath,
          rows.contains(where: { $0.id == selectedPath }) else { return }
    revealedPath = selectedPath
    withAnimation(reduceMotion ? nil : .smooth) {
      proxy.scrollTo(selectedPath, anchor: .center)
    }
  }

  private var list: some View {
    List {
      Section {
        header()
      }
      Section {
        switch model.rootPhase {
        case .loading:
          ForEach(0..<8, id: \.self) { index in
            FilesTreeSkeletonRow(widthFraction: [0.42, 0.55, 0.36, 0.6, 0.48, 0.3, 0.52, 0.4][index])
              .adeFlatRow(insets: Self.rowInsets, separator: .hidden)
          }
        case .failed(let message):
          FilesTreeMessageRow(
            symbol: "exclamationmark.triangle",
            text: isLive ? "Couldn't list this workspace. \(message)" : "Reconnect to list this workspace.",
            actionTitle: "Retry",
            action: { model.retry("") }
          )
          .adeFlatRow(insets: Self.rowInsets, separator: .hidden)
        case .empty:
          FilesTreeMessageRow(symbol: "folder", text: "This workspace is empty.", actionTitle: nil, action: {})
            .adeFlatRow(insets: Self.rowInsets, separator: .hidden)
        case .ready:
          ForEach(model.rows) { row in
            rowView(row)
              .adeFlatRow(insets: Self.rowInsets, separator: .hidden)
          }
        }
      }
      footer()
    }
    .environment(\.defaultMinListRowHeight, 0)
    .adeFlatList()
    .listSectionSpacing(.compact)
    .contentMargins(.top, 4, for: .scrollContent)
    .contentMargins(.bottom, 24, for: .scrollContent)
    .refreshable {
      if let onRefresh { await onRefresh() } else { await model.refreshVisible() }
    }
  }

  static var rowInsets: EdgeInsets { EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 8) }

  @ViewBuilder
  private func rowView(_ row: FilesTreeModel.Row) -> some View {
    switch row.kind {
    case .node(let node, let isExpanded, let isLoading):
      FilesTreeRow(
        node: node,
        depth: row.depth,
        isExpanded: isExpanded,
        isLoading: isLoading,
        isSelected: node.type == "file" && node.path == selectedPath,
        onTap: {
          if node.type == "directory" {
            withAnimation(reduceMotion ? nil : .snappy(duration: 0.22)) {
              model.toggle(node.path)
            }
          } else {
            // Already in view: no scroll for a file picked in the tree.
            revealedPath = node.path
            onOpenFile(node.path)
          }
        }
      )
      .contextMenu { contextMenu(for: node) }
      .swipeActions(edge: .trailing, allowsFullSwipe: false) {
        Button("Copy Path") { copyRelativePath(node.path) }
          .tint(ADEColor.accent)
      }
    case .failed(let parentPath, let message):
      FilesTreeMessageRow(
        symbol: "exclamationmark.triangle",
        text: message,
        actionTitle: "Retry",
        action: { model.retry(parentPath) },
        depth: row.depth
      )
    case .empty:
      FilesTreeMessageRow(symbol: nil, text: "Empty folder", actionTitle: nil, action: {}, depth: row.depth)
    }
  }

  @ViewBuilder
  private func contextMenu(for node: FileTreeNode) -> some View {
    if node.type == "file" {
      Button("Open", systemImage: "doc.text") { onOpenFile(node.path) }
      if let openToSide {
        Button("Open to the Side", systemImage: "rectangle.split.2x1") { openToSide(node.path) }
      }
    } else {
      Button(model.isExpanded(node.path) ? "Collapse" : "Expand", systemImage: "chevron.right") {
        model.toggle(node.path)
      }
    }
    Divider()
    Button("Copy Relative Path", systemImage: "doc.on.clipboard") { copyRelativePath(node.path) }
    Button("Copy Full Path", systemImage: "doc.on.doc") {
      UIPasteboard.general.string = filesFullPath(rootPath: workspace.rootPath, relativePath: node.path)
    }
  }

  private func copyRelativePath(_ path: String) {
    UIPasteboard.general.string = path
  }
}
