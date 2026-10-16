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
      let localWorkspaces = try await loadedWorkspacesTask
      let localLanes = try await loadedLanesTask
      // Lanes of this project on the other live machines, read in parallel; a
      // machine that fails or is slow adds nothing.
      async let remoteTask = filesRemoteMachineWorkspaces(syncService: syncService)
      let remote = await remoteTask
      let loadedWorkspaces = localWorkspaces + remote.workspaces
      let loadedLanes = localLanes + remote.lanes
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
    if let searchQuery = request.searchQuery, !searchQuery.isEmpty {
      // Several files share this name; search lets the user pick the right one.
      selectedFileTransitionPath = nil
      navigationPath = []
      pendingSearchQuery = searchQuery
      isSearchPresented = true
    } else if let relativePath = request.relativePath, !relativePath.isEmpty {
      if request.pathKind == .directory {
        openDirectory(relativePath, in: workspace)
      } else {
        selectedFileTransitionPath = relativePath
        openFile(relativePath, in: workspace, focusLine: request.focusLine)
      }
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

/// The Files workspaces of this project's lanes on the other live machines.
/// A lane's workspace id is its (namespaced) lane id, so reads of it route to
/// that machine (`SyncService.remoteWorkspaceFileRoute`).
@MainActor
func filesRemoteMachineWorkspaces(syncService: SyncService) async -> (workspaces: [FilesWorkspace], lanes: [LaneSummary]) {
  let repos = syncService.remoteReposForActiveProject().filter { repo in
    syncService.machineFleet?.isLive(repo.machineKey) == true
  }
  guard !repos.isEmpty else { return ([], []) }
  var snapshotsByMachine: [String: [LaneListSnapshot]] = [:]
  await withTaskGroup(of: (WorkRemoteMachineRepo, [LaneListSnapshot]).self) { group in
    for repo in repos {
      group.addTask { @MainActor in
        let snapshots = (try? await syncService.fetchRemoteLaneSnapshots(
          repo: repo,
          timeoutNanoseconds: LaneRemoteMachinesModel.readTimeoutNanoseconds
        )) ?? []
        return (repo, snapshots)
      }
    }
    for await (repo, snapshots) in group {
      snapshotsByMachine[repo.machineKey] = snapshots
    }
  }
  var workspaces: [FilesWorkspace] = []
  var lanes: [LaneSummary] = []
  for repo in repos {
    for lane in (snapshotsByMachine[repo.machineKey] ?? []).map(\.lane) where lane.archivedAt == nil {
      lanes.append(lane)
      workspaces.append(FilesWorkspace(
        id: lane.id,
        kind: lane.laneType == "primary" ? "primary" : "worktree",
        laneId: lane.id,
        name: lane.name,
        branchRef: lane.branchRef,
        rootPath: lane.worktreePath,
        isReadOnlyByDefault: false,
        machineName: repo.machineName
      ))
    }
  }
  return (workspaces, lanes)
}
