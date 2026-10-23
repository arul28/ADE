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

  /// Lists the workspaces. The phone's cached list paints first; `live`
  /// then asks this machine, then the other live machines (in parallel, each
  /// slow or failing one adds nothing), repainting as each answers. Without
  /// `live` (a projection bump) only the cache is re-read.
  @MainActor
  func reload(refreshRemote: Bool = false, live: Bool = true) async {
    if !live || localWorkspaces.isEmpty {
      let cached = await syncService.cachedFilesWorkspaces()
      if !cached.isEmpty || !live {
        applyWorkspaces(local: cached, localLanes: nil, final: !live && hasLoadedWorkspaces)
      }
    }
    guard live else { return }
    let previousSelectedWorkspaceId = selectedWorkspaceId
    do {
      if refreshRemote {
        try? await syncService.refreshLaneSnapshots()
      }
      async let loadedLanesTask = syncService.fetchLanes()
      let loadedWorkspaces = try await syncService.listWorkspaces()
      let loadedLanes = (try? await loadedLanesTask) ?? localLanes
      applyWorkspaces(local: loadedWorkspaces, localLanes: loadedLanes, final: false)
      if errorMessage != nil {
        errorMessage = nil
      }
    } catch {
      let message = error.localizedDescription
      if errorMessage != message {
        errorMessage = message
      }
    }
    let remote = await filesRemoteMachineWorkspaces(syncService: syncService)
    if remoteWorkspaces != remote.workspaces { remoteWorkspaces = remote.workspaces }
    if remoteLanes != remote.lanes { remoteLanes = remote.lanes }
    applyWorkspaces(local: localWorkspaces, localLanes: nil, final: true)
    hasLoadedWorkspaces = true
    if previousSelectedWorkspaceId == selectedWorkspaceId {
      await loadProofArtifacts()
      lastHandledProofArtifactsReloadKey = proofArtifactsReloadKey
    }
  }

  /// Merges this machine's and the other machines' lists and keeps the
  /// selection. Before the other machines have answered (`final` false) a
  /// selected workspace that is not listed yet stays selected.
  @MainActor
  func applyWorkspaces(local: [FilesWorkspace], localLanes nextLocalLanes: [LaneSummary]?, final: Bool) {
    if localWorkspaces != local { localWorkspaces = local }
    if let nextLocalLanes, localLanes != nextLocalLanes { localLanes = nextLocalLanes }
    let merged = localWorkspaces + remoteWorkspaces
    if workspaces != merged { workspaces = merged }
    let mergedLanes = localLanes + remoteLanes
    if lanes != mergedLanes { lanes = mergedLanes }
    // A pane opens on the chat's own lane workspace; every other caller keeps
    // the first workspace (or the one the user already chose).
    let preferredLaneWorkspaceId = preferredLaneId.flatMap { laneId in
      merged.first(where: { $0.laneId == laneId })?.id
    }
    let current = selectedWorkspaceId.flatMap { candidate in
      merged.contains(where: { $0.id == candidate }) || !final ? candidate : nil
    }
    let next = current ?? preferredLaneWorkspaceId ?? merged.first?.id
    if selectedWorkspaceId != next {
      selectedWorkspaceId = next
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

  /// Shows a folder: the tree expands down to it (and the phone pops back to
  /// the tree).
  func openDirectory(_ parentPath: String, in workspace: FilesWorkspace) {
    if selectedWorkspaceId != workspace.id {
      suppressNextWorkspaceNavigationReset = true
    }
    selectedWorkspaceId = workspace.id
    treeModel.attach(syncService)
    treeModel.reveal(parentPath, isDirectory: true, in: workspace.id)
    if !duoLayout.isWide || embeddedInPane {
      navigationPath = []
    }
  }

  func openFile(_ relativePath: String, in workspace: FilesWorkspace, focusLine: Int?) {
    if selectedWorkspaceId != workspace.id {
      suppressNextWorkspaceNavigationReset = true
    }
    selectedWorkspaceId = workspace.id
    selectedFileTransitionPath = relativePath
    treeModel.attach(syncService)
    treeModel.reveal(relativePath, isDirectory: false, in: workspace.id)
    treeModel.noteOpened(relativePath, in: workspace.id)
    navigationPath = [.editor(workspaceId: workspace.id, relativePath: relativePath, focusLine: focusLine)]
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
