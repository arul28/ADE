import SwiftUI

@Observable
class FileTreeViewModel {
  var nodes: [FileTreeNode] = []
  var gitState = FilesGitState.empty
  var errorMessage: String?
  var actionErrorMessage: String?
  var isLoading = true
  var prompt: FilesPathPrompt?
  var promptValue = ""
  var destructiveConfirmation: FilesDestructiveConfirmation?
  var childNodesByPath: [String: [FileTreeNode]] = [:]
  var expandedPaths: Set<String> = []
  var loadingPaths: Set<String> = []

  private var lastIncludeHidden: Bool?

  func canMutateFiles(isLive: Bool, workspace: FilesWorkspace) -> Bool {
    isLive && !workspace.isReadOnlyByDefault
  }

  func canUseGitActions(isLive: Bool, workspace: FilesWorkspace) -> Bool {
    isLive && workspace.laneId != nil
  }

  func mutationDisabledReason(isLive: Bool, workspace: FilesWorkspace, needsRepairing: Bool) -> String? {
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

  @MainActor
  func reload(syncService: SyncService, workspace: FilesWorkspace, parentPath: String, showHidden: Bool, isLive: Bool) async {
    guard isLive else {
      isLoading = false
      return
    }
    do {
      if lastIncludeHidden != showHidden {
        childNodesByPath.removeAll()
        expandedPaths.removeAll()
        loadingPaths.removeAll()
      }
      lastIncludeHidden = showHidden
      isLoading = true
      nodes = try await syncService.listTree(workspaceId: workspace.id, parentPath: parentPath, includeIgnored: showHidden)
      childNodesByPath[parentPath] = nodes
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

  func visibleRows(showHidden: Bool) -> [FilesTreeRowItem] {
    visibleFilesTreeRows(
      nodes: nodes,
      expandedPaths: expandedPaths,
      loadingPaths: loadingPaths,
      childNodesByPath: childNodesByPath,
      showHidden: showHidden
    )
  }

  func open(_ node: FileTreeNode, openDirectory: (String) -> Void, openFile: (String, Int?) -> Void) {
    if node.type == "directory" {
      openDirectory(node.path)
    } else {
      openFile(node.path, nil)
    }
  }

  func presentPrompt(_ kind: FilesPromptKind, basePath: String, node: FileTreeNode?) {
    prompt = FilesPathPrompt(kind: kind, basePath: basePath, node: node)
    promptValue = node?.name ?? ""
    actionErrorMessage = nil
  }

  @MainActor
  func confirmPrompt(
    syncService: SyncService,
    workspace: FilesWorkspace,
    parentPath: String,
    showHidden: Bool,
    isLive: Bool,
    openFile: (String, Int?) -> Void
  ) async {
    guard let prompt else { return }
    let trimmed = promptValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard validatePromptValue(trimmed, prompt: prompt) else { return }

    let targetPath = joinedPath(base: prompt.basePath, name: trimmed)
    let refreshPath = prompt.basePath
    do {
      switch prompt.kind {
      case .createFile:
        try await syncService.createFile(workspaceId: workspace.id, path: targetPath, content: "")
        self.prompt = nil
        await reloadAndRefreshSubtree(refreshPath: refreshPath, syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive)
        openFile(targetPath, nil)
      case .createFolder:
        try await syncService.createDirectory(workspaceId: workspace.id, path: targetPath)
        self.prompt = nil
        await reloadAndRefreshSubtree(refreshPath: refreshPath, syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive)
      case .rename:
        guard let node = prompt.node else { return }
        try await syncService.renamePath(workspaceId: workspace.id, oldPath: node.path, newPath: targetPath)
        self.prompt = nil
        await reloadAndRefreshSubtree(refreshPath: refreshPath, syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive)
      }
      actionErrorMessage = nil
    } catch {
      actionErrorMessage = error.localizedDescription
    }
  }

  @MainActor
  func toggleExpansion(
    node: FileTreeNode,
    syncService: SyncService,
    workspace: FilesWorkspace,
    showHidden: Bool,
    isLive: Bool
  ) async {
    guard node.type == "directory" else { return }
    if expandedPaths.contains(node.path) {
      expandedPaths.remove(node.path)
      loadingPaths.remove(node.path)
      return
    }

    expandedPaths.insert(node.path)
    guard childNodesByPath[node.path] == nil else { return }
    await loadChildren(
      syncService: syncService,
      workspace: workspace,
      directoryPath: node.path,
      showHidden: showHidden,
      isLive: isLive
    )
  }

  @MainActor
  func confirmDestructiveAction(
    _ confirmation: FilesDestructiveConfirmation,
    syncService: SyncService,
    workspace: FilesWorkspace,
    parentPath: String,
    showHidden: Bool,
    isLive: Bool
  ) async {
    switch confirmation.kind {
    case .delete(let node):
      do {
        try await syncService.deletePath(workspaceId: workspace.id, path: node.path)
        await reloadAndRefreshSubtree(refreshPath: parentDirectory(of: node.path), syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive)
        actionErrorMessage = nil
      } catch {
        actionErrorMessage = error.localizedDescription
      }
    case .discard(let path):
      guard let laneId = workspace.laneId else { return }
      do {
        try await syncService.discardFile(laneId: laneId, path: path)
        await reloadAndRefreshSubtree(refreshPath: parentDirectory(of: path), syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive)
        actionErrorMessage = nil
      } catch {
        actionErrorMessage = error.localizedDescription
      }
    case .discardUnsaved:
      break
    }
  }

  @MainActor
  private func reloadAndRefreshSubtree(
    refreshPath: String,
    syncService: SyncService,
    workspace: FilesWorkspace,
    parentPath: String,
    showHidden: Bool,
    isLive: Bool
  ) async {
    await reload(syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive)
    if refreshPath != parentPath {
      childNodesByPath.removeValue(forKey: refreshPath)
      if expandedPaths.contains(refreshPath) {
        await loadChildren(syncService: syncService, workspace: workspace, directoryPath: refreshPath, showHidden: showHidden, isLive: isLive)
      }
    }
  }

  @MainActor
  func stage(_ path: String, laneId: String, syncService: SyncService, workspace: FilesWorkspace, parentPath: String, showHidden: Bool, isLive: Bool) async {
    do {
      try await syncService.stageFile(laneId: laneId, path: path)
      await reload(syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive)
      actionErrorMessage = nil
    } catch {
      actionErrorMessage = error.localizedDescription
    }
  }

  @MainActor
  func unstage(_ path: String, laneId: String, syncService: SyncService, workspace: FilesWorkspace, parentPath: String, showHidden: Bool, isLive: Bool) async {
    do {
      try await syncService.unstageFile(laneId: laneId, path: path)
      await reload(syncService: syncService, workspace: workspace, parentPath: parentPath, showHidden: showHidden, isLive: isLive)
      actionErrorMessage = nil
    } catch {
      actionErrorMessage = error.localizedDescription
    }
  }

  func absolutePath(for relativePath: String, workspace: FilesWorkspace) -> String {
    guard !relativePath.isEmpty else { return workspace.rootPath }
    return (workspace.rootPath as NSString).appendingPathComponent(relativePath)
  }

  @MainActor
  func loadChildren(
    syncService: SyncService,
    workspace: FilesWorkspace,
    directoryPath: String,
    showHidden: Bool,
    isLive: Bool
  ) async {
    guard isLive else { return }
    loadingPaths.insert(directoryPath)
    do {
      let loaded = try await syncService.listTree(
        workspaceId: workspace.id,
        parentPath: directoryPath,
        includeIgnored: showHidden
      )
      childNodesByPath[directoryPath] = loaded
      actionErrorMessage = nil
    } catch {
      actionErrorMessage = error.localizedDescription
    }
    loadingPaths.remove(directoryPath)
  }

  private func validatePromptValue(_ value: String, prompt: FilesPathPrompt) -> Bool {
    let siblingNodes = childNodesByPath[prompt.basePath] ?? []
    if let validationError = filesNameValidationError(
      for: value,
      existingNodes: siblingNodes,
      excluding: prompt.node?.path
    ) {
      actionErrorMessage = validationError
      return false
    }
    actionErrorMessage = nil
    return true
  }
}
