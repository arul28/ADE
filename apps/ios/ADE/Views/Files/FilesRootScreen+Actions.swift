import SwiftUI

extension FilesRootScreen {
  var filesStatus: SyncDomainStatus {
    syncService.status(for: .files)
  }

  var selectedWorkspace: FilesWorkspace? {
    workspaces.first(where: { $0.id == selectedWorkspaceId }) ?? workspaces.first
  }

  var selectedWorkspaceBinding: Binding<String> {
    Binding(
      get: { selectedWorkspaceId ?? selectedWorkspace?.id ?? "" },
      set: { selectedWorkspaceId = $0 }
    )
  }

  var transitionNamespace: Namespace.ID? {
    ADEMotion.allowsMatchedGeometry(reduceMotion: reduceMotion) ? fileTransitionNamespace : nil
  }

  var canUseLiveFileActions: Bool {
    filesStatus.phase == .ready && (syncService.connectionState == .connected || syncService.connectionState == .syncing)
  }

  var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !workspaces.isEmpty
  }

  var isLoadingSkeleton: Bool {
    filesStatus.phase == .hydrating || filesStatus.phase == .syncingInitialData
  }

  var quickOpenEmptyMessage: String {
    filesSearchEmptyMessage(kind: .quickOpen, isLive: canUseLiveFileActions, needsRepairing: needsRepairing, query: quickOpenQuery)
  }

  var textSearchEmptyMessage: String {
    filesSearchEmptyMessage(kind: .textSearch, isLive: canUseLiveFileActions, needsRepairing: needsRepairing, query: textSearchQuery)
  }

  @MainActor
  func refreshFromPullGesture() async {
    await reload(refreshRemote: true)
    if errorMessage == nil {
      withAnimation(ADEMotion.emphasis(reduceMotion: reduceMotion)) {
        refreshFeedbackToken += 1
      }
    }
  }

  @MainActor
  func reload(refreshRemote: Bool = false) async {
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
      await loadProofArtifacts()
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func loadProofArtifacts() async {
    guard let laneId = selectedWorkspace?.laneId else {
      proofArtifacts = []
      proofErrorMessage = nil
      return
    }

    do {
      let artifacts = try await syncService.fetchComputerUseArtifacts(ownerKind: "lane", ownerId: laneId)
      proofArtifacts = Array(artifacts.sorted { lhs, rhs in
        lhs.createdAt > rhs.createdAt
      }.prefix(6))
      proofErrorMessage = nil
    } catch {
      proofArtifacts = []
      proofErrorMessage = error.localizedDescription
    }
  }

  @MainActor
  func runQuickOpenSearch() async {
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
    guard !Task.isCancelled, isTabActive, canUseLiveFileActions else { return }
    guard query == quickOpenQuery.trimmingCharacters(in: .whitespacesAndNewlines), workspaceId == selectedWorkspaceId else { return }

    do {
      let results = try await syncService.quickOpen(workspaceId: workspaceId, query: query)
      guard !Task.isCancelled, isTabActive, canUseLiveFileActions else { return }
      guard query == quickOpenQuery.trimmingCharacters(in: .whitespacesAndNewlines), workspaceId == selectedWorkspaceId else { return }
      quickOpenResults = results
      errorMessage = nil
    } catch {
      guard !Task.isCancelled, isTabActive else { return }
      guard query == quickOpenQuery.trimmingCharacters(in: .whitespacesAndNewlines), workspaceId == selectedWorkspaceId else { return }
      errorMessage = error.localizedDescription
      quickOpenResults = []
    }
  }

  @MainActor
  func runTextSearch() async {
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
    guard !Task.isCancelled, isTabActive, canUseLiveFileActions else { return }
    guard query == textSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines), workspaceId == selectedWorkspaceId else { return }

    do {
      let results = try await syncService.searchText(workspaceId: workspaceId, query: query)
      guard !Task.isCancelled, isTabActive, canUseLiveFileActions else { return }
      guard query == textSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines), workspaceId == selectedWorkspaceId else { return }
      textSearchResults = results
      errorMessage = nil
    } catch {
      guard !Task.isCancelled, isTabActive else { return }
      guard query == textSearchQuery.trimmingCharacters(in: .whitespacesAndNewlines), workspaceId == selectedWorkspaceId else { return }
      errorMessage = error.localizedDescription
      textSearchResults = []
    }
  }

  @MainActor
  func handleRequestedNavigation() async {
    guard let request = syncService.requestedFilesNavigation else { return }
    if workspaces.isEmpty {
      await reload()
    }
    guard let workspace = resolveFilesWorkspace(for: request, in: workspaces) else {
      errorMessage = "The requested lane workspace is not cached on this phone yet. Refresh Files and try again."
      syncService.requestedFilesNavigation = nil
      return
    }
    selectedWorkspaceId = workspace.id
    if let relativePath = request.relativePath, !relativePath.isEmpty {
      selectedFileTransitionPath = relativePath
      openFile(relativePath, in: workspace, focusLine: request.focusLine)
    } else {
      selectedFileTransitionPath = nil
      navigationPath = []
    }
    syncService.requestedFilesNavigation = nil
  }

  func openDirectory(_ parentPath: String, in workspace: FilesWorkspace) {
    selectedWorkspaceId = workspace.id
    selectedFileTransitionPath = nil
    navigationPath = routesForDirectory(parentPath, workspace: workspace)
  }

  func openFile(_ relativePath: String, in workspace: FilesWorkspace, focusLine: Int?) {
    selectedWorkspaceId = workspace.id
    selectedFileTransitionPath = relativePath
    navigationPath = routesForFile(relativePath, workspace: workspace, focusLine: focusLine)
  }

  func routesForDirectory(_ parentPath: String, workspace: FilesWorkspace) -> [FilesRoute] {
    let components = pathComponents(parentPath)
    guard !components.isEmpty else { return [] }
    return components.indices.map { index in
      .directory(workspaceId: workspace.id, parentPath: components[0...index].joined(separator: "/"))
    }
  }

  func routesForFile(_ relativePath: String, workspace: FilesWorkspace, focusLine: Int?) -> [FilesRoute] {
    var routes = routesForDirectory(parentDirectory(of: relativePath), workspace: workspace)
    routes.append(.editor(workspaceId: workspace.id, relativePath: relativePath, focusLine: focusLine))
    return routes
  }
}
