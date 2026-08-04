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
    filesStatus.phase == .ready && syncService.connectionState == .connected
  }

  var needsRepairing: Bool {
    syncService.activeHostProfile == nil && !workspaces.isEmpty
  }

  var isLoadingSkeleton: Bool {
    filesStatus.phase == .hydrating || filesStatus.phase == .syncingInitialData
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
      let previousSelectedWorkspaceId = selectedWorkspaceId
      async let loadedWorkspacesTask = syncService.listWorkspaces()
      async let loadedLanesTask = syncService.fetchLanes()
      let loadedWorkspaces = try await loadedWorkspacesTask
      let loadedLanes = try await loadedLanesTask
      if workspaces != loadedWorkspaces {
        workspaces = loadedWorkspaces
      }
      if lanes != loadedLanes {
        lanes = loadedLanes
      }
      let nextSelectedWorkspaceId = selectedWorkspaceId.flatMap { candidate in
        loadedWorkspaces.contains(where: { $0.id == candidate }) ? candidate : nil
      } ?? loadedWorkspaces.first?.id
      if selectedWorkspaceId != nextSelectedWorkspaceId {
        selectedWorkspaceId = nextSelectedWorkspaceId
      }
      if previousSelectedWorkspaceId == nextSelectedWorkspaceId {
        await loadProofArtifacts()
        lastHandledProofArtifactsReloadKey = proofArtifactsReloadKey
      }
      if errorMessage != nil {
        errorMessage = nil
      }
    } catch {
      let message = error.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    }
  }

  @MainActor
  func loadProofArtifacts() async {
    guard let laneId = selectedWorkspace?.laneId else {
      if !proofArtifacts.isEmpty {
        proofArtifacts = []
      }
      if proofErrorMessage != nil {
        proofErrorMessage = nil
      }
      return
    }

    do {
      let artifacts = try await syncService.fetchComputerUseArtifacts(ownerKind: "lane", ownerId: laneId)
      let nextArtifacts = Array(artifacts.sorted { lhs, rhs in
        lhs.createdAt > rhs.createdAt
      }.prefix(6))
      if proofArtifacts != nextArtifacts {
        proofArtifacts = nextArtifacts
      }
      if proofErrorMessage != nil {
        proofErrorMessage = nil
      }
    } catch {
      if !proofArtifacts.isEmpty {
        proofArtifacts = []
      }
      let message = error.localizedDescription
      if proofErrorMessage != message {
        proofErrorMessage = message
      }
    }
  }

  @MainActor
  func handleRequestedNavigation() async {
    guard let request = syncService.requestedFilesNavigation else { return }
    if workspaces.isEmpty {
      await reload()
    }
    guard let workspace = resolveFilesWorkspace(for: request, in: workspaces) else {
      let message = "The requested lane workspace is not cached on this phone yet. Refresh Files and try again."
      if errorMessage != message {
        errorMessage = message
      }
      syncService.requestedFilesNavigation = nil
      return
    }
    if selectedWorkspaceId != workspace.id {
      suppressNextWorkspaceNavigationReset = true
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
    if selectedWorkspaceId != workspace.id {
      suppressNextWorkspaceNavigationReset = true
    }
    selectedWorkspaceId = workspace.id
    selectedFileTransitionPath = nil
    navigationPath = routesForDirectory(parentPath, workspace: workspace)
  }

  func openFile(_ relativePath: String, in workspace: FilesWorkspace, focusLine: Int?) {
    if selectedWorkspaceId != workspace.id {
      suppressNextWorkspaceNavigationReset = true
    }
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
