import SwiftUI
import UIKit

private enum FilesRoute: Hashable {
  case directory(workspaceId: String, parentPath: String)
  case editor(workspaceId: String, relativePath: String, focusLine: Int?)
}

private struct FilesSearchKey: Hashable {
  let workspaceId: String?
  let query: String
  let isLive: Bool
}

private enum FilesEditorMode: String, CaseIterable, Identifiable {
  case preview
  case edit
  case diff

  var id: String { rawValue }

  var title: String {
    switch self {
    case .preview: return "Preview"
    case .edit: return "Edit"
    case .diff: return "Diff"
    }
  }
}

private enum FilesDiffMode: String, CaseIterable, Identifiable {
  case unstaged
  case staged

  var id: String { rawValue }

  var title: String {
    switch self {
    case .unstaged: return "Working tree"
    case .staged: return "Staged"
    }
  }
}

private enum FilesPromptKind {
  case createFile
  case createFolder
  case rename
}

private struct FilesPathPrompt: Identifiable {
  let id = UUID()
  let kind: FilesPromptKind
  let basePath: String
  let node: FileTreeNode?

  var title: String {
    switch kind {
    case .createFile:
      return "New file"
    case .createFolder:
      return "New folder"
    case .rename:
      return "Rename"
    }
  }

  var message: String {
    switch kind {
    case .createFile:
      return basePath.isEmpty ? "Create a file at the workspace root." : "Create a file in \(basePath)."
    case .createFolder:
      return basePath.isEmpty ? "Create a folder at the workspace root." : "Create a folder in \(basePath)."
    case .rename:
      return "Rename \(node?.name ?? "this item")."
    }
  }

  var placeholder: String {
    switch kind {
    case .createFile:
      return "example.swift"
    case .createFolder:
      return "NewFolder"
    case .rename:
      return node?.name ?? "Name"
    }
  }

  var confirmLabel: String {
    switch kind {
    case .createFile:
      return "Create"
    case .createFolder:
      return "Create"
    case .rename:
      return "Rename"
    }
  }

  var initialValue: String {
    node?.name ?? ""
  }
}

private enum FilesDestructiveKind {
  case delete(node: FileTreeNode)
  case discard(path: String)
  case discardUnsaved
}

private struct FilesDestructiveConfirmation: Identifiable {
  let id = UUID()
  let kind: FilesDestructiveKind

  var title: String {
    switch kind {
    case .delete(let node):
      return "Delete \(node.name)?"
    case .discard(let path):
      return "Discard changes for \(lastPathComponent(path))?"
    case .discardUnsaved:
      return "Discard unsaved changes?"
    }
  }

  var message: String {
    switch kind {
    case .delete:
      return "This permanently removes the item from the host workspace."
    case .discard:
      return "This permanently loses your local edits."
    case .discardUnsaved:
      return "Your unsaved edits on iPhone will be lost."
    }
  }

  var confirmLabel: String {
    switch kind {
    case .delete:
      return "Delete"
    case .discard, .discardUnsaved:
      return "Discard"
    }
  }
}

private struct FilesGitState {
  var staged: Set<String> = []
  var unstaged: Set<String> = []

  static let empty = FilesGitState()

  func isStaged(_ path: String) -> Bool {
    staged.contains(path)
  }

  func isUnstaged(_ path: String) -> Bool {
    unstaged.contains(path)
  }

  func hasChanges(_ path: String) -> Bool {
    isStaged(path) || isUnstaged(path)
  }
}

private struct FilesFileMetadata {
  let sizeText: String
  let languageLabel: String
  let lastCommitTitle: String?
  let lastCommitDateText: String?
}

struct FilesTabView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService
  @AppStorage("ade.files.showHidden") private var showHidden = false
  @Namespace private var fileTransitionNamespace

  @State private var workspaces: [FilesWorkspace] = []
  @State private var selectedWorkspaceId: String?
  @State private var quickOpenQuery = ""
  @State private var quickOpenResults: [FilesQuickOpenItem] = []
  @State private var textSearchQuery = ""
  @State private var textSearchResults: [FilesSearchTextMatch] = []
  @State private var errorMessage: String?
  @State private var navigationPath: [FilesRoute] = []
  @State private var refreshFeedbackToken = 0
  @State private var selectedFileTransitionPath: String?

  private var filesStatus: SyncDomainStatus {
    syncService.status(for: .files)
  }

  private var selectedWorkspace: FilesWorkspace? {
    workspaces.first(where: { $0.id == selectedWorkspaceId }) ?? workspaces.first
  }

  private var canUseLiveFileActions: Bool {
    filesStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  private var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !workspaces.isEmpty
  }

  private var isLoadingSkeleton: Bool {
    filesStatus.phase == .hydrating || filesStatus.phase == .syncingInitialData
  }

  var body: some View {
    NavigationStack(path: $navigationPath) {
      List {
        if let notice = statusNotice {
          notice.filesListRow()
        }

        if isLoadingSkeleton {
          ForEach(0..<3, id: \.self) { _ in
            ADECardSkeleton(rows: 3)
              .filesListRow()
          }
        }

        if let errorMessage, filesStatus.phase == .ready {
          ADENoticeCard(
            title: "Files view error",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await reload(refreshRemote: true) } }
          )
          .filesListRow()
        }

        if filesStatus.phase == .ready && workspaces.isEmpty {
          ADEEmptyStateView(
            symbol: "folder.badge.questionmark",
            title: "No workspaces available",
            message: "This host does not currently expose any lane-backed workspaces to browse from iPhone."
          ) {
            if syncService.activeHostProfile == nil {
              Button("Open Settings") {
                syncService.settingsPresented = true
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
            }
          }
          .filesListRow()
        }

        if let workspace = selectedWorkspace {
          Section("Workspace") {
            FilesWorkspaceHeader(
              workspaces: workspaces,
              selectedWorkspaceId: Binding(
                get: { selectedWorkspaceId ?? workspace.id },
                set: { selectedWorkspaceId = $0 }
              ),
              selectedWorkspace: workspace,
              showHidden: $showHidden
            )
            .filesListRow()
          }

          Section("Quick open") {
            FilesQueryCard(
              title: "Quick open",
              prompt: "Search files",
              query: $quickOpenQuery,
              disabled: !canUseLiveFileActions,
              emptyMessage: quickOpenEmptyMessage
            )
            .filesListRow()

            if canUseLiveFileActions {
              ForEach(quickOpenResults) { item in
                Button {
                  openFile(item.path, in: workspace, focusLine: nil)
                } label: {
                  FilesResultRow(
                    path: item.path,
                    transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? fileTransitionNamespace : nil,
                    isSelectedTransitionSource: selectedFileTransitionPath == item.path
                  )
                }
                .buttonStyle(.plain)
                .filesListRow()
              }
            }
          }

          Section("Text search") {
            FilesQueryCard(
              title: "Workspace search",
              prompt: "Search text",
              query: $textSearchQuery,
              disabled: !canUseLiveFileActions,
              emptyMessage: textSearchEmptyMessage
            )
            .filesListRow()

            if canUseLiveFileActions {
              ForEach(textSearchResults) { result in
                Button {
                  openFile(result.path, in: workspace, focusLine: result.line)
                } label: {
                  FilesSearchResultRow(
                    result: result,
                    transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? fileTransitionNamespace : nil,
                    isSelectedTransitionSource: selectedFileTransitionPath == result.path
                  )
                }
                .buttonStyle(.plain)
                .filesListRow()
              }
            }
          }

          Section("Tree") {
            FilesDirectoryContentsView(
              workspace: workspace,
              parentPath: "",
              showHidden: showHidden,
              isLive: canUseLiveFileActions,
              needsRepairing: needsRepairing,
              showDisconnectedNotice: false,
              openDirectory: { path in
                openDirectory(path, in: workspace)
              },
              openFile: { path, line in
                openFile(path, in: workspace, focusLine: line)
              },
              transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? fileTransitionNamespace : nil,
              selectedFilePath: selectedFileTransitionPath
            )
            .environmentObject(syncService)
          }
        }
      }
      .listStyle(.plain)
      .scrollContentBackground(.hidden)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Files")
      .navigationDestination(for: FilesRoute.self) { route in
        switch route {
        case .directory(let workspaceId, let parentPath):
          if let workspace = workspaces.first(where: { $0.id == workspaceId }) {
            FilesDirectoryScreen(
              workspace: workspace,
              parentPath: parentPath,
              showHidden: $showHidden,
              isLive: canUseLiveFileActions,
              needsRepairing: needsRepairing,
              openDirectory: { path in
                openDirectory(path, in: workspace)
              },
              openFile: { path, line in
                openFile(path, in: workspace, focusLine: line)
              },
              transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? fileTransitionNamespace : nil,
              selectedFilePath: selectedFileTransitionPath
            )
            .environmentObject(syncService)
          } else {
            ADEEmptyStateView(
              symbol: "folder.badge.questionmark",
              title: "Workspace unavailable",
              message: "The selected workspace is no longer available on this device."
            )
            .adeScreenBackground()
            .adeNavigationGlass()
          }
        case .editor(let workspaceId, let relativePath, let focusLine):
          if let workspace = workspaces.first(where: { $0.id == workspaceId }) {
            FileEditorView(
              workspace: workspace,
              relativePath: relativePath,
              focusLine: focusLine,
              isFilesLive: canUseLiveFileActions,
              needsRepairing: needsRepairing,
              transitionNamespace: ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? fileTransitionNamespace : nil,
              navigateToDirectory: { path in
                openDirectory(path, in: workspace)
              }
            )
            .environmentObject(syncService)
          } else {
            ADEEmptyStateView(
              symbol: "doc.badge.questionmark",
              title: "File unavailable",
              message: "The workspace for this file is no longer available."
            )
            .adeScreenBackground()
            .adeNavigationGlass()
          }
        }
      }
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            Task { await reload(refreshRemote: true) }
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .accessibilityLabel("Refresh files")
          .disabled(syncService.activeHostProfile == nil && workspaces.isEmpty)
        }
      }
      .refreshable {
        await refreshFromPullGesture()
      }
      .sensoryFeedback(.selection, trigger: selectedWorkspaceId)
      .sensoryFeedback(.success, trigger: quickOpenResults.count + textSearchResults.count)
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task {
        await reload()
      }
      .task(id: syncService.localStateRevision) {
        await reload()
      }
      .task(id: FilesSearchKey(workspaceId: selectedWorkspaceId, query: quickOpenQuery, isLive: canUseLiveFileActions)) {
        await runQuickOpenSearch()
      }
      .task(id: FilesSearchKey(workspaceId: selectedWorkspaceId, query: textSearchQuery, isLive: canUseLiveFileActions)) {
        await runTextSearch()
      }
      .task(id: syncService.requestedFilesNavigation?.id) {
        await handleRequestedNavigation()
      }
      .onChange(of: selectedWorkspaceId) { _, _ in
        navigationPath = []
        quickOpenResults = []
        textSearchResults = []
      }
    }
  }

  @MainActor
  private func refreshFromPullGesture() async {
    await reload(refreshRemote: true)
    if errorMessage == nil {
      withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
        refreshFeedbackToken += 1
      }
    }
  }

  @MainActor
  private func reload(refreshRemote: Bool = false) async {
    do {
      if refreshRemote {
        try? await syncService.refreshLaneSnapshots()
      }
      workspaces = try await syncService.listWorkspaces()
      selectedWorkspaceId = selectedWorkspaceId.flatMap { candidate in
        workspaces.contains(where: { $0.id == candidate }) ? candidate : nil
      } ?? workspaces.first?.id
      if !canUseLiveFileActions {
        quickOpenResults = []
        textSearchResults = []
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func runQuickOpenSearch() async {
    guard canUseLiveFileActions else {
      quickOpenResults = []
      return
    }
    guard let workspaceId = selectedWorkspaceId else {
      quickOpenResults = []
      return
    }
    let query = quickOpenQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else {
      quickOpenResults = []
      return
    }

    try? await Task.sleep(nanoseconds: 250_000_000)
    guard query == quickOpenQuery.trimmingCharacters(in: .whitespacesAndNewlines), workspaceId == selectedWorkspaceId else { return }

    do {
      quickOpenResults = try await syncService.quickOpen(workspaceId: workspaceId, query: query)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
      quickOpenResults = []
    }
  }

  @MainActor
  private func runTextSearch() async {
    guard canUseLiveFileActions else {
      textSearchResults = []
      return
    }
    guard let workspaceId = selectedWorkspaceId else {
      textSearchResults = []
      return
    }
    let query = textSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !query.isEmpty else {
      textSearchResults = []
      return
    }

    try? await Task.sleep(nanoseconds: 250_000_000)
    guard query == textSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines), workspaceId == selectedWorkspaceId else { return }

    do {
      textSearchResults = try await syncService.searchText(workspaceId: workspaceId, query: query)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
      textSearchResults = []
    }
  }

  @MainActor
  private func handleRequestedNavigation() async {
    guard let request = syncService.requestedFilesNavigation else { return }
    if workspaces.isEmpty {
      await reload()
    }
    guard let workspace = workspaces.first(where: { $0.id == request.workspaceId }) else {
      syncService.requestedFilesNavigation = nil
      return
    }
    selectedWorkspaceId = workspace.id
    if let relativePath = request.relativePath, !relativePath.isEmpty {
      selectedFileTransitionPath = relativePath
      openFile(relativePath, in: workspace, focusLine: nil)
    } else {
      selectedFileTransitionPath = nil
      navigationPath = []
    }
    syncService.requestedFilesNavigation = nil
  }

  private func openDirectory(_ parentPath: String, in workspace: FilesWorkspace) {
    selectedWorkspaceId = workspace.id
    selectedFileTransitionPath = nil
    navigationPath = routesForDirectory(parentPath, workspace: workspace)
  }

  private func openFile(_ relativePath: String, in workspace: FilesWorkspace, focusLine: Int?) {
    selectedWorkspaceId = workspace.id
    selectedFileTransitionPath = relativePath
    navigationPath = routesForFile(relativePath, workspace: workspace, focusLine: focusLine)
  }

  private func routesForDirectory(_ parentPath: String, workspace: FilesWorkspace) -> [FilesRoute] {
    let components = pathComponents(parentPath)
    guard !components.isEmpty else { return [] }
    return components.indices.map { index in
      .directory(workspaceId: workspace.id, parentPath: components[0...index].joined(separator: "/"))
    }
  }

  private func routesForFile(_ relativePath: String, workspace: FilesWorkspace, focusLine: Int?) -> [FilesRoute] {
    var routes = routesForDirectory(parentDirectory(of: relativePath), workspace: workspace)
    routes.append(.editor(workspaceId: workspace.id, relativePath: relativePath, focusLine: focusLine))
    return routes
  }

  private var quickOpenEmptyMessage: String {
    if !canUseLiveFileActions {
      return needsRepairing
        ? "Pair again before searching or opening files."
        : "Quick open needs a live host connection."
    }
    if quickOpenQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "Type a filename or path to fuzzy-search the workspace."
    }
    return "No matching files found."
  }

  private var textSearchEmptyMessage: String {
    if !canUseLiveFileActions {
      return needsRepairing
        ? "Pair again before searching workspace contents."
        : "Workspace search needs a live host connection."
    }
    if textSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      return "Search across the current workspace and preview matching lines."
    }
    return "No matches found."
  }

  private var statusNotice: ADENoticeCard? {
    switch filesStatus.phase {
    case .disconnected:
      return ADENoticeCard(
        title: workspaces.isEmpty ? "Host disconnected" : "Showing cached workspaces",
        message: workspaces.isEmpty
          ? (syncService.activeHostProfile == nil
              ? "Pair with a host to hydrate the workspace list before browsing files."
              : "Reconnect to hydrate the workspace list before browsing files.")
          : (needsRepairing
              ? "Workspace names are cached locally, but the previous host trust was cleared. Pair again before trusting file state or write access."
              : "Workspace information is cached locally. Reconnect before editing, creating, or refreshing files."),
        icon: "icloud.slash",
        tint: ADEColor.warning,
        actionTitle: syncService.activeHostProfile == nil ? (needsRepairing ? "Pair again" : "Pair with host") : "Reconnect",
        action: {
          if syncService.activeHostProfile == nil {
            syncService.settingsPresented = true
          } else {
            Task {
              await syncService.reconnectIfPossible()
              await reload(refreshRemote: true)
            }
          }
        }
      )
    case .hydrating:
      return ADENoticeCard(
        title: "Hydrating workspaces",
        message: "Files uses the lane graph for workspace roots. Waiting for the latest lane hydration from the host.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.accent,
        actionTitle: nil,
        action: nil
      )
    case .syncingInitialData:
      return ADENoticeCard(
        title: "Syncing initial data",
        message: "Waiting for the host to finish syncing project and lane metadata before Files hydrates.",
        icon: "arrow.trianglehead.2.clockwise.rotate.90",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    case .failed:
      return ADENoticeCard(
        title: "Workspace hydration failed",
        message: filesStatus.lastError ?? "The lane graph did not hydrate, so Files cannot trust its workspace model yet.",
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
    case .ready:
      return nil
    }
  }
}

private struct FilesDirectoryScreen: View {
  @EnvironmentObject private var syncService: SyncService

  let workspace: FilesWorkspace
  let parentPath: String
  @Binding var showHidden: Bool
  let isLive: Bool
  let needsRepairing: Bool
  let openDirectory: (String) -> Void
  let openFile: (String, Int?) -> Void
  let transitionNamespace: Namespace.ID?
  let selectedFilePath: String?

  var body: some View {
    List {
      FilesBreadcrumbBar(
        relativePath: parentPath,
        includeCurrentFile: false,
        onSelectDirectory: { path in
          openDirectory(path)
        }
      )
      .filesListRow()

      FilesDirectoryContentsView(
        workspace: workspace,
        parentPath: parentPath,
        showHidden: showHidden,
        isLive: isLive,
        needsRepairing: needsRepairing,
        showDisconnectedNotice: true,
        openDirectory: openDirectory,
        openFile: openFile,
        transitionNamespace: transitionNamespace,
        selectedFilePath: selectedFilePath
      )
      .environmentObject(syncService)
    }
    .listStyle(.plain)
    .scrollContentBackground(.hidden)
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(parentPath.isEmpty ? "Root" : lastPathComponent(parentPath))
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button {
          showHidden.toggle()
        } label: {
          Image(systemName: showHidden ? "eye.slash" : "eye")
        }
        .accessibilityLabel(showHidden ? "Hide hidden files" : "Show hidden files")

        Button {
          Task {
            try? await syncService.refreshLaneSnapshots()
          }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .accessibilityLabel("Refresh files for this lane")
      }
    }
  }
}

private struct FilesDirectoryContentsView: View {
  @EnvironmentObject private var syncService: SyncService

  let workspace: FilesWorkspace
  let parentPath: String
  let showHidden: Bool
  let isLive: Bool
  let needsRepairing: Bool
  let showDisconnectedNotice: Bool
  let openDirectory: (String) -> Void
  let openFile: (String, Int?) -> Void
  let transitionNamespace: Namespace.ID?
  let selectedFilePath: String?

  @State private var nodes: [FileTreeNode] = []
  @State private var gitState = FilesGitState.empty
  @State private var errorMessage: String?
  @State private var actionErrorMessage: String?
  @State private var isLoading = true
  @State private var prompt: FilesPathPrompt?
  @State private var promptValue = ""
  @State private var destructiveConfirmation: FilesDestructiveConfirmation?

  private var canMutateFiles: Bool {
    isLive && !workspace.isReadOnlyByDefault
  }

  private var canUseGitActions: Bool {
    isLive && workspace.laneId != nil
  }

  var body: some View {
    Group {
      FilesDirectoryActionRow(
        canMutateFiles: canMutateFiles,
        mutationDisabledReason: mutationDisabledReason,
        createFile: { presentPrompt(.createFile, basePath: parentPath, node: nil) },
        createFolder: { presentPrompt(.createFolder, basePath: parentPath, node: nil) }
      )
      .filesListRow()

      if showDisconnectedNotice && !isLive {
        disconnectedNotice.filesListRow()
      }

      if let actionErrorMessage {
        ADENoticeCard(
          title: "File action failed",
          message: actionErrorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: nil,
          action: nil
        )
        .filesListRow()
      }

      if let errorMessage {
        ADENoticeCard(
          title: "Directory load failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: { Task { await reload() } }
        )
        .filesListRow()
      }

      if isLoading {
        ForEach(0..<4, id: \.self) { _ in
          ADECardSkeleton(rows: 2)
            .filesListRow()
        }
      } else if nodes.isEmpty {
        ADEEmptyStateView(
          symbol: parentPath.isEmpty ? "folder" : "folder.badge.minus",
          title: parentPath.isEmpty ? "Workspace is empty" : "Folder is empty",
          message: isLive ? "This directory does not have any files to preview on iPhone yet." : "Reconnect to load files from the host."
        )
        .filesListRow()
      }

      ForEach(nodes) { node in
        Button {
          open(node)
        } label: {
          FilesTreeNodeRow(
            node: node,
            transitionNamespace: transitionNamespace,
            isSelectedTransitionSource: selectedFilePath == node.path
          )
        }
        .buttonStyle(.plain)
        .contextMenu {
          contextMenu(for: node)
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
          if canMutateFiles {
            Button("Rename") {
              presentPrompt(.rename, basePath: parentDirectory(of: node.path), node: node)
            }
            .tint(ADEColor.accent)

            Button("Delete", role: .destructive) {
              destructiveConfirmation = FilesDestructiveConfirmation(kind: .delete(node: node))
            }
          }
        }
        .filesListRow()
      }
    }
    .task(id: DirectoryReloadKey(workspaceId: workspace.id, parentPath: parentPath, includeHidden: showHidden, live: isLive, revision: syncService.localStateRevision)) {
      await reload()
    }
    .alert(prompt?.title ?? "", isPresented: Binding(
      get: { prompt != nil },
      set: { if !$0 { prompt = nil } }
    )) {
      TextField(prompt?.placeholder ?? "Name", text: $promptValue)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
      Button(prompt?.confirmLabel ?? "Save") {
        Task {
          await confirmPrompt()
        }
      }
      Button("Cancel", role: .cancel) {
        prompt = nil
      }
    } message: {
      Text(prompt?.message ?? "")
    }
    .alert(item: $destructiveConfirmation) { confirmation in
      Alert(
        title: Text(confirmation.title),
        message: Text(confirmation.message),
        primaryButton: .destructive(Text(confirmation.confirmLabel)) {
          Task {
            await confirmDestructiveAction(confirmation)
          }
        },
        secondaryButton: .cancel()
      )
    }
  }

  @MainActor
  private func reload() async {
    guard isLive else {
      isLoading = false
      return
    }

    do {
      isLoading = true
      nodes = try await syncService.listTree(workspaceId: workspace.id, parentPath: parentPath, includeIgnored: showHidden)
      if let laneId = workspace.laneId {
        let changes = try await syncService.fetchLaneChanges(laneId: laneId)
        gitState = FilesGitState(
          staged: Set(changes.staged.map(\.path)),
          unstaged: Set(changes.unstaged.map(\.path))
        )
      } else {
        gitState = .empty
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
    isLoading = false
  }

  private func open(_ node: FileTreeNode) {
    if node.type == "directory" {
      openDirectory(node.path)
    } else {
      openFile(node.path, nil)
    }
  }

  private func contextMenu(for node: FileTreeNode) -> some View {
    Group {
      Button("Open") {
        open(node)
      }

      Button("Copy Path") {
        UIPasteboard.general.string = absolutePath(for: node.path)
      }

      Button("Copy Relative Path") {
        UIPasteboard.general.string = node.path
      }

      if node.type == "directory" && canMutateFiles {
        Button("New File") {
          presentPrompt(.createFile, basePath: node.path, node: nil)
        }

        Button("New Folder") {
          presentPrompt(.createFolder, basePath: node.path, node: nil)
        }
      }

      Button("Rename") {
        presentPrompt(.rename, basePath: parentDirectory(of: node.path), node: node)
      }
      .disabled(!canMutateFiles)

      Button("Delete", role: .destructive) {
        destructiveConfirmation = FilesDestructiveConfirmation(kind: .delete(node: node))
      }
      .disabled(!canMutateFiles)

      if node.type == "file", let laneId = workspace.laneId {
        Button("Stage") {
          Task { await stage(node.path, laneId: laneId) }
        }
        .disabled(!canUseGitActions || !gitState.isUnstaged(node.path))

        Button("Unstage") {
          Task { await unstage(node.path, laneId: laneId) }
        }
        .disabled(!canUseGitActions || !gitState.isStaged(node.path))

        Button("Discard Changes", role: .destructive) {
          destructiveConfirmation = FilesDestructiveConfirmation(kind: .discard(path: node.path))
        }
        .disabled(!canUseGitActions || !gitState.isUnstaged(node.path))
      }
    }
  }

  private func presentPrompt(_ kind: FilesPromptKind, basePath: String, node: FileTreeNode?) {
    prompt = FilesPathPrompt(kind: kind, basePath: basePath, node: node)
    promptValue = node?.name ?? ""
  }

  @MainActor
  private func confirmPrompt() async {
    guard let prompt else { return }
    let trimmed = promptValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard validatePromptValue(trimmed, prompt: prompt) else { return }

    let targetPath = joinedPath(base: prompt.basePath, name: trimmed)
    do {
      switch prompt.kind {
      case .createFile:
        try await syncService.createFile(workspaceId: workspace.id, path: targetPath, content: "")
        self.prompt = nil
        await reload()
        openFile(targetPath, nil)
      case .createFolder:
        try await syncService.createDirectory(workspaceId: workspace.id, path: targetPath)
        self.prompt = nil
        await reload()
      case .rename:
        guard let node = prompt.node else { return }
        try await syncService.renamePath(workspaceId: workspace.id, oldPath: node.path, newPath: targetPath)
        self.prompt = nil
        await reload()
      }
      actionErrorMessage = nil
    } catch {
      actionErrorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func confirmDestructiveAction(_ confirmation: FilesDestructiveConfirmation) async {
    switch confirmation.kind {
    case .delete(let node):
      do {
        try await syncService.deletePath(workspaceId: workspace.id, path: node.path)
        await reload()
        actionErrorMessage = nil
      } catch {
        actionErrorMessage = error.localizedDescription
      }
    case .discard(let path):
      guard let laneId = workspace.laneId else { return }
      do {
        try await syncService.discardFile(laneId: laneId, path: path)
        await reload()
        actionErrorMessage = nil
      } catch {
        actionErrorMessage = error.localizedDescription
      }
    case .discardUnsaved:
      break
    }
  }

  @MainActor
  private func stage(_ path: String, laneId: String) async {
    do {
      try await syncService.stageFile(laneId: laneId, path: path)
      await reload()
      actionErrorMessage = nil
    } catch {
      actionErrorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func unstage(_ path: String, laneId: String) async {
    do {
      try await syncService.unstageFile(laneId: laneId, path: path)
      await reload()
      actionErrorMessage = nil
    } catch {
      actionErrorMessage = error.localizedDescription
    }
  }

  private func validatePromptValue(_ value: String, prompt: FilesPathPrompt) -> Bool {
    guard !value.isEmpty else {
      actionErrorMessage = "Name cannot be empty."
      return false
    }
    guard !value.contains("/") && !value.contains("\\") else {
      actionErrorMessage = "Use a single file or folder name here."
      return false
    }
    if let conflict = nodes.first(where: {
      $0.name.caseInsensitiveCompare(value) == .orderedSame && $0.path != prompt.node?.path
    }) {
      actionErrorMessage = "\(conflict.name) already exists in this folder."
      return false
    }
    actionErrorMessage = nil
    return true
  }

  private func absolutePath(for relativePath: String) -> String {
    guard !relativePath.isEmpty else { return workspace.rootPath }
    return (workspace.rootPath as NSString).appendingPathComponent(relativePath)
  }

  private var mutationDisabledReason: String? {
    if workspace.isReadOnlyByDefault {
      return "This workspace stays read-only on the host."
    }
    if !isLive {
      return needsRepairing
        ? "Pair again before creating, renaming, or deleting files."
        : "Reconnect before creating, renaming, or deleting files."
    }
    return nil
  }

  private var disconnectedNotice: ADENoticeCard {
    ADENoticeCard(
      title: nodes.isEmpty ? "Reconnect to load this folder" : "Showing cached directory",
      message: needsRepairing
        ? "The previous host trust was cleared. Pair again before trusting or editing file state."
        : "Edits and refresh are disabled until the host reconnects.",
      icon: "icloud.slash",
      tint: ADEColor.warning,
      actionTitle: syncService.activeHostProfile == nil ? "Pair again" : "Reconnect",
      action: {
        if syncService.activeHostProfile == nil {
          syncService.settingsPresented = true
        } else {
          Task {
            await syncService.reconnectIfPossible()
          }
        }
      }
    )
  }

  private struct DirectoryReloadKey: Hashable {
    let workspaceId: String
    let parentPath: String
    let includeHidden: Bool
    let live: Bool
    let revision: Int
  }
}

private struct FileEditorView: View {
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.dismiss) private var dismiss

  let workspace: FilesWorkspace
  let relativePath: String
  let focusLine: Int?
  let isFilesLive: Bool
  let needsRepairing: Bool
  let transitionNamespace: Namespace.ID?
  let navigateToDirectory: (String) -> Void

  @State private var blob: SyncFileBlob?
  @State private var draftText = ""
  @State private var errorMessage: String?
  @State private var metadata: FilesFileMetadata?
  @State private var gitState = FilesGitState.empty
  @State private var mode: FilesEditorMode = .preview
  @State private var diffMode: FilesDiffMode = .unstaged
  @State private var diff: FileDiff?
  @State private var diffErrorMessage: String?
  @State private var saveTrigger = 0
  @State private var isMetadataExpanded = true
  @State private var pendingDestructiveConfirmation: FilesDestructiveConfirmation?
  @State private var pendingNavigationTarget: EditorNavigationTarget?

  private enum EditorNavigationTarget {
    case dismiss
    case directory(String)
  }

  private var language: FilesLanguage {
    FilesLanguage.detect(languageId: blob?.languageId, filePath: relativePath)
  }

  private var isImagePreviewable: Bool {
    let lowercased = relativePath.lowercased()
    return ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff"].contains((lowercased as NSString).pathExtension)
  }

  private var imageData: Data? {
    guard let blob else { return nil }
    if blob.encoding.lowercased() == "base64" {
      return Data(base64Encoded: blob.content)
    }
    return Data(blob.content.utf8)
  }

  private var imageCacheKey: String {
    "files-preview::\(workspace.id)::\(relativePath)"
  }

  private var canEdit: Bool {
    isFilesLive && !workspace.isReadOnlyByDefault && blob?.isBinary == false
  }

  private var isDirty: Bool {
    guard let blob, !blob.isBinary else { return false }
    return draftText != blob.content
  }

  private var editorModes: [FilesEditorMode] {
    guard blob?.isBinary == false else { return [.preview] }
    if workspace.laneId != nil {
      return [.preview, .edit, .diff]
    }
    return [.preview, .edit]
  }

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        FilesBreadcrumbBar(
          relativePath: relativePath,
          includeCurrentFile: true,
          onSelectDirectory: { path in
            attemptNavigation(.directory(path))
          }
        )

        if !isFilesLive {
          disconnectedNotice
        }

        if let errorMessage {
          ADENoticeCard(
            title: "File load failed",
            message: errorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await load() } }
          )
        }

        if blob == nil && errorMessage == nil {
          ADECardSkeleton(rows: 4)
        }

        if let blob {
          filesHeader(blob: blob)

          DisclosureGroup(isExpanded: $isMetadataExpanded) {
            VStack(alignment: .leading, spacing: 10) {
              FilesMetadataRow(label: "Path", value: relativePath)
              FilesMetadataRow(label: "Size", value: metadata?.sizeText ?? formattedFileSize(blob.size))
              FilesMetadataRow(label: "Language", value: metadata?.languageLabel ?? language.displayName)
              FilesMetadataRow(label: "Last commit", value: metadata?.lastCommitTitle ?? "No commit information available")
              if let lastCommitDateText = metadata?.lastCommitDateText {
                FilesMetadataRow(label: "Last change", value: lastCommitDateText)
              }
            }
            .padding(.top, 10)
          } label: {
            Text("Metadata")
              .font(.headline)
              .foregroundStyle(ADEColor.textPrimary)
          }
          .adeGlassCard(cornerRadius: 18)

          if blob.isBinary {
            binaryPreview(blob: blob)
          } else {
            codeSurface(blob: blob)
          }
        }
      }
      .padding(16)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(lastPathComponent(relativePath))
    .navigationBarBackButtonHidden(true)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        Button {
          attemptNavigation(.dismiss)
        } label: {
          Image(systemName: "chevron.left")
        }
        .accessibilityLabel("Back")
      }

      ToolbarItemGroup(placement: .topBarTrailing) {
        if isDirty {
          ADEStatusPill(text: "UNSAVED", tint: ADEColor.warning)
        }

        if canEdit {
          Button("Save") {
            Task { await save() }
          }
          .disabled(!isDirty)
        }
      }
    }
    .sensoryFeedback(.success, trigger: saveTrigger)
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : "files-container-\(relativePath)", in: transitionNamespace)
    .task {
      await load()
    }
    .task(id: syncService.localStateRevision) {
      await load(refreshDiff: mode == .diff)
    }
    .task(id: mode) {
      if mode == .diff {
        await loadDiff()
      }
    }
    .task(id: diffMode) {
      if mode == .diff {
        await loadDiff()
      }
    }
    .alert(item: $pendingDestructiveConfirmation) { confirmation in
      Alert(
        title: Text(confirmation.title),
        message: Text(confirmation.message),
        primaryButton: .destructive(Text(confirmation.confirmLabel)) {
          switch confirmation.kind {
          case .discardUnsaved:
            performNavigationTarget()
          case .discard(let path):
            guard let laneId = workspace.laneId else { return }
            Task {
              do {
                try await syncService.discardFile(laneId: laneId, path: path)
                await load(refreshDiff: true)
              } catch {
                errorMessage = error.localizedDescription
              }
            }
          case .delete:
            break
          }
        },
        secondaryButton: .cancel()
      )
    }
  }

  @ViewBuilder
  private func filesHeader(blob: SyncFileBlob) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: fileIcon(for: relativePath))
          .font(.title3.weight(.semibold))
          .foregroundStyle(fileTint(for: relativePath))
          .frame(width: 42, height: 42)
          .background(ADEColor.surfaceBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          .glassEffect(in: .rect(cornerRadius: 12))
          .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "files-icon-\(relativePath)", in: transitionNamespace)

        VStack(alignment: .leading, spacing: 6) {
          Text(lastPathComponent(relativePath))
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "files-title-\(relativePath)", in: transitionNamespace)
          Text(parentDirectory(of: relativePath).isEmpty ? "Workspace root" : parentDirectory(of: relativePath))
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 0)
      }

      ScrollView(.horizontal, showsIndicators: false) {
        ADEGlassGroup(spacing: 8) {
          ADEStatusPill(text: language.displayName.uppercased(), tint: ADEColor.accent)
          if workspace.isReadOnlyByDefault {
            ADEStatusPill(text: "READ ONLY", tint: ADEColor.warning)
          } else if !isFilesLive {
            ADEStatusPill(text: "DISCONNECTED", tint: ADEColor.warning)
          }
          if let laneId = workspace.laneId, gitState.isUnstaged(relativePath) || gitState.isStaged(relativePath) {
            FilesGitActionGroup(
              laneId: laneId,
              path: relativePath,
              gitState: gitState,
              stage: { Task { await stageCurrentFile(laneId: laneId) } },
              unstage: { Task { await unstageCurrentFile(laneId: laneId) } },
              discard: { pendingDestructiveConfirmation = FilesDestructiveConfirmation(kind: .discard(path: relativePath)) }
            )
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }

  @ViewBuilder
  private func binaryPreview(blob: SyncFileBlob) -> some View {
    if isImagePreviewable, let data = imageData, let image = UIImage(data: data) {
      VStack(alignment: .leading, spacing: 10) {
        Text("Preview")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        ZoomableImageView(image: image)
          .frame(minHeight: 280)
      }
      .adeGlassCard(cornerRadius: 18)
    } else if isImagePreviewable {
      ADENoticeCard(
        title: "Image preview unavailable",
        message: "The current host only exposed file metadata for this image. Reconnect and reopen after the host sends binary bytes for previews.",
        icon: "photo",
        tint: ADEColor.warning,
        actionTitle: nil,
        action: nil
      )
    } else {
      ADEEmptyStateView(
        symbol: "doc.fill",
        title: "Binary file",
        message: "This file cannot be displayed inline on iPhone yet."
      )
    }
  }

  @ViewBuilder
  private func codeSurface(blob: SyncFileBlob) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      Picker("Mode", selection: $mode) {
        ForEach(editorModes) { editorMode in
          Text(editorMode.title).tag(editorMode)
        }
      }
      .pickerStyle(.segmented)

      switch mode {
      case .preview:
        SyntaxHighlightedCodeView(
          text: draftText,
          language: language,
          focusLine: focusLine
        )
      case .edit:
        VStack(alignment: .leading, spacing: 10) {
          if workspace.isReadOnlyByDefault {
            Text("This workspace is edit-protected on the host.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          } else if !isFilesLive {
            Text("Reconnect to a live host before editing or saving file contents.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          }

          TextEditor(text: $draftText)
            .font(.system(.body, design: .monospaced))
            .frame(minHeight: 320)
            .disabled(!canEdit)
            .adeInsetField(cornerRadius: 16, padding: 12)
        }
      case .diff:
        VStack(alignment: .leading, spacing: 10) {
          if workspace.laneId == nil {
            Text("Diff mode requires a lane-backed workspace.")
              .font(.caption)
              .foregroundStyle(ADEColor.textSecondary)
          } else {
            Picker("Diff", selection: $diffMode) {
              ForEach(FilesDiffMode.allCases) { item in
                Text(item.title).tag(item)
              }
            }
            .pickerStyle(.segmented)

            if let diffErrorMessage {
              ADENoticeCard(
                title: "Diff unavailable",
                message: diffErrorMessage,
                icon: "exclamationmark.triangle.fill",
                tint: ADEColor.danger,
                actionTitle: "Retry",
                action: { Task { await loadDiff() } }
              )
            } else if let diff, diff.isBinary == true {
              ADEEmptyStateView(
                symbol: "doc.badge.gearshape",
                title: "Binary diff",
                message: "This file changed, but the host reported a binary diff that cannot be rendered inline."
              )
            } else if let diff {
              FilesInlineDiffView(
                lines: buildInlineDiffLines(original: diff.original.text, modified: diff.modified.text),
                language: FilesLanguage.detect(languageId: diff.language, filePath: relativePath)
              )
            } else {
              ADECardSkeleton(rows: 4)
            }
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }

  @MainActor
  private func load(refreshDiff: Bool = false) async {
    do {
      if isImagePreviewable, let cachedData = ADEImageCache.shared.cachedData(for: imageCacheKey) {
        let cachedBlob = SyncFileBlob(
          path: relativePath,
          size: cachedData.count,
          mimeType: nil,
          encoding: "base64",
          isBinary: true,
          content: cachedData.base64EncodedString(),
          languageId: nil
        )
        blob = cachedBlob
        await loadGitState()
        await loadMetadata(from: cachedBlob)
        if refreshDiff {
          await loadDiff()
        }
        errorMessage = nil
        return
      }

      let wasDirty = isDirty
      let loaded = try await syncService.readFile(workspaceId: workspace.id, path: relativePath)
      blob = loaded
      if loaded.isBinary, isImagePreviewable, let data = imageData {
        ADEImageCache.shared.store(data, for: imageCacheKey)
      }
      if !loaded.isBinary && (!wasDirty || draftText.isEmpty) {
        draftText = loaded.content
      }
      await loadGitState()
      await loadMetadata(from: loaded)
      if refreshDiff {
        await loadDiff()
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func loadGitState() async {
    guard let laneId = workspace.laneId, isFilesLive else { return }
    do {
      let changes = try await syncService.fetchLaneChanges(laneId: laneId)
      gitState = FilesGitState(
        staged: Set(changes.staged.map(\.path)),
        unstaged: Set(changes.unstaged.map(\.path))
      )
    } catch {
      // Preserve current git state if fetch fails.
    }
  }

  @MainActor
  private func loadMetadata(from blob: SyncFileBlob) async {
    var lastCommitTitle: String?
    var lastCommitDateText: String?

    if let laneId = workspace.laneId, isFilesLive {
      do {
        let commits = try await syncService.listRecentCommits(laneId: laneId)
        for commit in commits.prefix(25) {
          let files = try await syncService.listCommitFiles(laneId: laneId, commitSha: commit.sha)
          if files.contains(relativePath) {
            lastCommitTitle = commit.subject
            lastCommitDateText = relativeDateDescription(from: commit.authoredAt)
            break
          }
        }
      } catch {
        // Best-effort metadata.
      }
    }

    metadata = FilesFileMetadata(
      sizeText: formattedFileSize(blob.size),
      languageLabel: language.displayName,
      lastCommitTitle: lastCommitTitle,
      lastCommitDateText: lastCommitDateText
    )
  }

  @MainActor
  private func loadDiff() async {
    guard let laneId = workspace.laneId, isFilesLive else {
      diff = nil
      diffErrorMessage = nil
      return
    }
    do {
      diff = try await syncService.fetchFileDiff(laneId: laneId, path: relativePath, mode: diffMode.rawValue)
      diffErrorMessage = nil
    } catch {
      diffErrorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func save() async {
    guard canEdit else { return }
    do {
      try await syncService.writeText(workspaceId: workspace.id, path: relativePath, text: draftText)
      saveTrigger += 1
      await load(refreshDiff: mode == .diff)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func stageCurrentFile(laneId: String) async {
    do {
      try await syncService.stageFile(laneId: laneId, path: relativePath)
      await load(refreshDiff: true)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func unstageCurrentFile(laneId: String) async {
    do {
      try await syncService.unstageFile(laneId: laneId, path: relativePath)
      await load(refreshDiff: true)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  private func attemptNavigation(_ target: EditorNavigationTarget) {
    guard isDirty else {
      performNavigation(target)
      return
    }
    pendingNavigationTarget = target
    pendingDestructiveConfirmation = FilesDestructiveConfirmation(kind: .discardUnsaved)
  }

  private func performNavigationTarget() {
    if let target = pendingNavigationTarget {
      performNavigation(target)
      pendingNavigationTarget = nil
    }
  }

  private func performNavigation(_ target: EditorNavigationTarget) {
    switch target {
    case .dismiss:
      dismiss()
    case .directory(let path):
      navigateToDirectory(path)
    }
  }

  private var disconnectedNotice: ADENoticeCard {
    ADENoticeCard(
      title: "Read-only while disconnected",
      message: needsRepairing
        ? "Pair again before trusting file state or saving edits."
        : "The last-loaded file content stays visible, but editing and file operations are disabled until the host reconnects.",
      icon: "icloud.slash",
      tint: ADEColor.warning,
      actionTitle: syncService.activeHostProfile == nil ? "Pair again" : "Reconnect",
      action: {
        if syncService.activeHostProfile == nil {
          syncService.settingsPresented = true
        } else {
          Task {
            await syncService.reconnectIfPossible()
          }
        }
      }
    )
  }
}

private struct FilesWorkspaceHeader: View {
  let workspaces: [FilesWorkspace]
  @Binding var selectedWorkspaceId: String
  let selectedWorkspace: FilesWorkspace
  @Binding var showHidden: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      Picker("Workspace", selection: $selectedWorkspaceId) {
        ForEach(workspaces) { workspace in
          Text(workspace.name).tag(workspace.id)
        }
      }
      .pickerStyle(.menu)

      VStack(alignment: .leading, spacing: 8) {
        Text(selectedWorkspace.rootPath)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .textSelection(.enabled)

        ScrollView(.horizontal, showsIndicators: false) {
          ADEGlassGroup(spacing: 8) {
            ADEStatusPill(text: selectedWorkspace.kind.uppercased(), tint: ADEColor.accent)
            if selectedWorkspace.isReadOnlyByDefault {
              ADEStatusPill(text: "READ ONLY", tint: ADEColor.warning)
            }
            Button {
              showHidden.toggle()
            } label: {
              Label(showHidden ? "Hide dotfiles" : "Show dotfiles", systemImage: showHidden ? "eye.slash" : "eye")
                .font(.caption.weight(.semibold))
            }
            .buttonStyle(.glass)
            .accessibilityLabel(showHidden ? "Hide hidden files" : "Show hidden files")
          }
        }
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct FilesQueryCard: View {
  let title: String
  let prompt: String
  @Binding var query: String
  let disabled: Bool
  let emptyMessage: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(title)
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
      TextField(prompt, text: $query)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .disabled(disabled)
        .adeInsetField()
      Text(emptyMessage)
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct FilesDirectoryActionRow: View {
  let canMutateFiles: Bool
  let mutationDisabledReason: String?
  let createFile: () -> Void
  let createFolder: () -> Void

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Folder actions")
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)

      ADEGlassGroup(spacing: 10) {
        Button(action: createFile) {
          Label("New file", systemImage: "doc.badge.plus")
            .font(.caption.weight(.semibold))
        }
        .buttonStyle(.glass)
        .disabled(!canMutateFiles)

        Button(action: createFolder) {
          Label("New folder", systemImage: "folder.badge.plus")
            .font(.caption.weight(.semibold))
        }
        .buttonStyle(.glass)
        .disabled(!canMutateFiles)
      }

      if let mutationDisabledReason {
        Text(mutationDisabledReason)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
      }
    }
    .adeGlassCard(cornerRadius: 18)
  }
}

private struct FilesTreeNodeRow: View {
  let node: FileTreeNode
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: node.type == "directory" ? "folder.fill" : fileIcon(for: node.name))
        .font(.headline)
        .foregroundStyle(node.type == "directory" ? ADEColor.accent : fileTint(for: node.name))
        .frame(width: 22)
        .adeMatchedGeometry(id: canTransition ? "files-icon-\(node.path)" : nil, in: transitionNamespace)

      VStack(alignment: .leading, spacing: 4) {
        Text(node.name)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .adeMatchedGeometry(id: canTransition ? "files-title-\(node.path)" : nil, in: transitionNamespace)
        Text(node.path.isEmpty ? (node.type == "directory" ? "Folder" : "File") : node.path)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }

      Spacer(minLength: 8)

      if let size = node.size, node.type == "file" {
        Text(formattedFileSize(size))
          .font(.caption2.monospaced())
          .foregroundStyle(ADEColor.textMuted)
      }

      if let changeStatus = node.changeStatus {
        ADEStatusPill(text: changeStatus.uppercased(), tint: changeStatusTint(changeStatus))
      }

      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .adeListCard(cornerRadius: 16)
    .adeMatchedTransitionSource(id: canTransition ? "files-container-\(node.path)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(accessibilityLabel)
  }

  private var canTransition: Bool {
    node.type == "file" && isSelectedTransitionSource
  }

  private var accessibilityLabel: String {
    if let changeStatus = node.changeStatus {
      return "\(node.name), \(node.type), \(changeStatusDescription(changeStatus))"
    }
    return "\(node.name), \(node.type)"
  }
}

private struct FilesResultRow: View {
  let path: String
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: fileIcon(for: path))
        .foregroundStyle(fileTint(for: path))
        .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-icon-\(path)" : nil, in: transitionNamespace)
      VStack(alignment: .leading, spacing: 3) {
        Text(lastPathComponent(path))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-title-\(path)" : nil, in: transitionNamespace)
        Text(path)
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
      Spacer()
      Image(systemName: "chevron.right")
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textMuted)
    }
    .adeListCard(cornerRadius: 16)
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "files-container-\(path)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(lastPathComponent(path)), file")
  }
}

private struct FilesSearchResultRow: View {
  let result: FilesSearchTextMatch
  let transitionNamespace: Namespace.ID?
  let isSelectedTransitionSource: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Image(systemName: fileIcon(for: result.path))
          .foregroundStyle(fileTint(for: result.path))
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-icon-\(result.path)" : nil, in: transitionNamespace)
        Text(lastPathComponent(result.path))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .adeMatchedGeometry(id: isSelectedTransitionSource ? "files-title-\(result.path)" : nil, in: transitionNamespace)
        Spacer()
        ADEStatusPill(text: "L\(result.line)", tint: ADEColor.accent)
      }
      Text(result.path)
        .font(.caption.monospaced())
        .foregroundStyle(ADEColor.textSecondary)
      Text(result.preview)
        .font(.caption)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
    }
    .adeListCard(cornerRadius: 16)
    .adeMatchedTransitionSource(id: isSelectedTransitionSource ? "files-container-\(result.path)" : nil, in: transitionNamespace)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(lastPathComponent(result.path)), line \(result.line)")
  }
}

private struct FilesBreadcrumbBar: View {
  let relativePath: String
  let includeCurrentFile: Bool
  let onSelectDirectory: (String) -> Void

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        Button("root") {
          onSelectDirectory("")
        }
        .buttonStyle(.glass)

        ForEach(Array(breadcrumbs.enumerated()), id: \.offset) { index, breadcrumb in
          Image(systemName: "chevron.right")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(ADEColor.textMuted)

          if breadcrumb.isDirectory {
            Button(breadcrumb.label) {
              onSelectDirectory(breadcrumb.path)
            }
            .buttonStyle(.glass)
          } else {
            Text(breadcrumb.label)
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .padding(.horizontal, 10)
              .padding(.vertical, 7)
              .background(ADEColor.surfaceBackground, in: Capsule())
              .glassEffect()
          }
        }
      }
      .padding(4)
    }
    .adeGlassCard(cornerRadius: 18, padding: 12)
  }

  private var breadcrumbs: [(label: String, path: String, isDirectory: Bool)] {
    let components = pathComponents(relativePath)
    guard !components.isEmpty else { return [] }
    return components.indices.map { index in
      let path = components[0...index].joined(separator: "/")
      let isLast = index == components.count - 1
      return (components[index], path, includeCurrentFile ? !isLast : true)
    }
  }
}

private struct FilesGitActionGroup: View {
  let laneId: String
  let path: String
  let gitState: FilesGitState
  let stage: () -> Void
  let unstage: () -> Void
  let discard: () -> Void

  var body: some View {
    ADEGlassGroup(spacing: 8) {
      if gitState.isUnstaged(path) {
        Button("Stage", action: stage)
          .buttonStyle(.glass)
      }
      if gitState.isStaged(path) {
        Button("Unstage", action: unstage)
          .buttonStyle(.glass)
      }
      if gitState.isUnstaged(path) {
        Button("Discard", role: .destructive, action: discard)
          .buttonStyle(.glass)
      }
    }
  }
}

private struct FilesMetadataRow: View {
  let label: String
  let value: String

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Text(value)
        .font(label == "Path" ? .caption.monospaced() : .subheadline)
        .foregroundStyle(ADEColor.textPrimary)
        .textSelection(.enabled)
    }
  }
}

private struct SyntaxHighlightedCodeView: View {
  let text: String
  let language: FilesLanguage
  let focusLine: Int?

  private var lines: [String] {
    let split = splitPreservingEmptyLines(text)
    return split.isEmpty ? [""] : split
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView([.horizontal, .vertical]) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
            HStack(alignment: .top, spacing: 12) {
              Text("\(index + 1)")
                .font(.caption2.monospaced())
                .foregroundStyle(ADEColor.textMuted)
                .frame(minWidth: 36, alignment: .trailing)
              Text(SyntaxHighlighter.highlightedAttributedString(line.isEmpty ? " " : line, as: language))
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(ADEColor.textPrimary)
                .fixedSize(horizontal: true, vertical: false)
                .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background((focusLine == index + 1 ? ADEColor.accent.opacity(0.12) : Color.clear), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .id(index + 1)
          }
        }
        .padding(10)
      }
      .frame(minHeight: 320)
      .adeInsetField(cornerRadius: 16, padding: 0)
      .task(id: focusLine) {
        guard let focusLine else { return }
        withAnimation(.smooth) {
          proxy.scrollTo(focusLine, anchor: .center)
        }
      }
    }
  }
}

private struct FilesInlineDiffView: View {
  let lines: [FilesInlineDiffLine]
  let language: FilesLanguage

  var body: some View {
    ScrollView([.horizontal, .vertical]) {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(lines) { line in
          HStack(alignment: .top, spacing: 12) {
            diffLineNumber(line.originalLineNumber)
            diffLineNumber(line.modifiedLineNumber)
            Text(SyntaxHighlighter.highlightedAttributedString(line.text.isEmpty ? " " : line.text, as: language))
              .font(.system(.body, design: .monospaced))
              .foregroundStyle(ADEColor.textPrimary)
              .fixedSize(horizontal: true, vertical: false)
              .textSelection(.enabled)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 10)
          .padding(.vertical, 4)
          .background(diffBackground(for: line.kind), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
      }
      .padding(10)
    }
    .frame(minHeight: 320)
    .adeInsetField(cornerRadius: 16, padding: 0)
  }

  private func diffLineNumber(_ lineNumber: Int?) -> some View {
    Text(lineNumber.map(String.init) ?? "•")
      .font(.caption2.monospaced())
      .foregroundStyle(ADEColor.textMuted)
      .frame(minWidth: 32, alignment: .trailing)
  }

  private func diffBackground(for kind: FilesInlineDiffKind) -> Color {
    switch kind {
    case .unchanged:
      return Color.clear
    case .added:
      return ADEColor.success.opacity(0.12)
    case .removed:
      return ADEColor.danger.opacity(0.12)
    }
  }
}

private struct ZoomableImageView: View {
  let image: UIImage

  @State private var scale: CGFloat = 1
  @State private var lastScale: CGFloat = 1
  @State private var offset: CGSize = .zero
  @State private var lastOffset: CGSize = .zero

  var body: some View {
    GeometryReader { proxy in
      Image(uiImage: image)
        .resizable()
        .scaledToFit()
        .scaleEffect(scale)
        .offset(offset)
        .frame(width: proxy.size.width, height: proxy.size.height)
        .contentShape(Rectangle())
        .gesture(magnificationGesture.simultaneously(with: dragGesture))
    }
    .adeInsetField(cornerRadius: 16, padding: 0)
  }

  private var magnificationGesture: some Gesture {
    MagnificationGesture()
      .onChanged { value in
        scale = min(max(lastScale * value, 1), 6)
      }
      .onEnded { _ in
        lastScale = scale
        if scale <= 1 {
          offset = .zero
          lastOffset = .zero
        }
      }
  }

  private var dragGesture: some Gesture {
    DragGesture()
      .onChanged { value in
        guard scale > 1 else { return }
        offset = CGSize(width: lastOffset.width + value.translation.width, height: lastOffset.height + value.translation.height)
      }
      .onEnded { _ in
        guard scale > 1 else {
          offset = .zero
          lastOffset = .zero
          return
        }
        lastOffset = offset
      }
  }
}

private extension View {
  func filesListRow() -> some View {
    listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
  }
}

private func joinedPath(base: String, name: String) -> String {
  let cleanedBase = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  let cleanedName = name.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  guard !cleanedBase.isEmpty else { return cleanedName }
  guard !cleanedName.isEmpty else { return cleanedBase }
  return "\(cleanedBase)/\(cleanedName)"
}

private func parentDirectory(of path: String) -> String {
  let components = pathComponents(path)
  guard components.count > 1 else { return "" }
  return components.dropLast().joined(separator: "/")
}

private func pathComponents(_ path: String) -> [String] {
  path
    .split(separator: "/")
    .map(String.init)
}

private func lastPathComponent(_ path: String) -> String {
  pathComponents(path).last ?? path
}

private func fileTint(for name: String) -> Color {
  let icon = fileIcon(for: name)
  switch icon {
  case "chevron.left.forwardslash.chevron.right":
    return .blue
  case "doc.badge.gearshape":
    return .orange
  case "doc.text":
    return .yellow
  case "photo":
    return .pink
  case "doc.zipper":
    return .red
  default:
    return ADEColor.textSecondary
  }
}

private func changeStatusTint(_ changeStatus: String) -> Color {
  switch changeStatus.uppercased() {
  case "A":
    return ADEColor.success
  case "D":
    return ADEColor.danger
  case "M":
    return ADEColor.warning
  default:
    return ADEColor.textSecondary
  }
}

private func changeStatusDescription(_ changeStatus: String) -> String {
  switch changeStatus.uppercased() {
  case "A":
    return "Added"
  case "D":
    return "Deleted"
  case "M":
    return "Modified"
  default:
    return changeStatus.uppercased()
  }
}

private func relativeDateDescription(from isoTimestamp: String?) -> String? {
  guard let isoTimestamp, let date = ISO8601DateFormatter().date(from: isoTimestamp) else {
    return nil
  }
  return RelativeDateTimeFormatter().localizedString(for: date, relativeTo: Date())
}
