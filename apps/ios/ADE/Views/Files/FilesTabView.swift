import SwiftUI

struct FilesTabView: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @EnvironmentObject private var syncService: SyncService
  @AppStorage("ade.files.showHidden") private var showHidden = false
  @Namespace private var fileTransitionNamespace

  @State private var searchViewModel = FileSearchViewModel()
  @State private var workspaces: [FilesWorkspace] = []
  @State private var selectedWorkspaceId: String?
  @State private var errorMessage: String?
  @State private var navigationPath: [FilesRoute] = []
  @State private var refreshFeedbackToken = 0
  @State private var selectedFileTransitionPath: String?
  @State private var isSearchPresented = false

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
        if let notice = filesStatusNotice(
          filesStatus: filesStatus,
          workspaces: workspaces,
          needsRepairing: needsRepairing,
          syncService: syncService,
          reload: { await reload(refreshRemote: true) }
        ) {
          notice.filesListRow()
        }

        if isLoadingSkeleton {
          ForEach(0..<3, id: \.self) { _ in
            ADECardSkeleton(rows: 3).filesListRow()
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
              Button("Open Settings") { syncService.settingsPresented = true }
                .buttonStyle(.glassProminent)
                .tint(ADEColor.accent)
            }
          }
          .filesListRow()
        }

        if let workspace = selectedWorkspace {
          Section {
            FilesWorkspaceCompactBar(
              workspaces: workspaces,
              selectedWorkspaceId: Binding(
                get: { selectedWorkspaceId ?? workspace.id },
                set: { selectedWorkspaceId = $0 }
              ),
              selectedWorkspace: workspace
            )
            .filesListRow()
          }

          Section("Tree") {
            FilesDirectoryContentsView(
              workspace: workspace,
              parentPath: "",
              showHidden: showHidden,
              isLive: canUseLiveFileActions,
              needsRepairing: needsRepairing,
              showDisconnectedNotice: false,
              openDirectory: { path in openDirectory(path, in: workspace) },
              openFile: { path, line in openFile(path, in: workspace, focusLine: line) },
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
      .navigationBarTitleDisplayMode(.inline)
      .navigationDestination(for: FilesRoute.self) { route in
        destinationView(for: route)
      }
      .toolbar {
        ToolbarItemGroup(placement: .topBarTrailing) {
          Button {
            isSearchPresented = true
          } label: {
            Image(systemName: "magnifyingglass")
          }
          .accessibilityLabel("Search files")
          .disabled(selectedWorkspace == nil)

          Button {
            Task { await reload(refreshRemote: true) }
          } label: {
            Image(systemName: "arrow.clockwise")
          }
          .accessibilityLabel("Refresh files")
          .disabled(syncService.activeHostProfile == nil && workspaces.isEmpty)

          Menu {
            Button(showHidden ? "Hide hidden files" : "Show hidden files") {
              showHidden.toggle()
            }
            .accessibilityLabel(showHidden ? "Hide hidden files" : "Show hidden files")
          } label: {
            Image(systemName: "ellipsis.circle")
          }
          .accessibilityLabel("More files options")
        }
      }
      .sheet(isPresented: $isSearchPresented) {
        if let workspace = selectedWorkspace {
          FilesSearchSheetView(
            searchViewModel: searchViewModel,
            workspace: workspace,
            canUseLiveFileActions: canUseLiveFileActions,
            needsRepairing: needsRepairing,
            openFile: { path, line in
              isSearchPresented = false
              openFile(path, in: workspace, focusLine: line)
            }
          )
          .environmentObject(syncService)
        } else {
          NavigationStack {
            ADEEmptyStateView(
              symbol: "magnifyingglass",
              title: "No workspace selected",
              message: "Pick a workspace before searching files."
            )
            .padding()
            .navigationTitle("Search")
            .toolbar {
              ToolbarItem(placement: .topBarTrailing) {
                Button("Done") { isSearchPresented = false }
              }
            }
          }
        }
      }
      .refreshable { await refreshFromPullGesture() }
      .sensoryFeedback(.selection, trigger: selectedWorkspaceId)
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task { await reload() }
      .task(id: syncService.localStateRevision) { await reload() }
      .task(id: FilesSearchKey(workspaceId: selectedWorkspaceId, query: searchViewModel.quickOpenQuery, isLive: canUseLiveFileActions, retryToken: searchViewModel.retryToken)) {
        await searchViewModel.runQuickOpenSearch(syncService: syncService, workspaceId: selectedWorkspaceId, canUseLiveFileActions: canUseLiveFileActions)
      }
      .task(id: FilesSearchKey(workspaceId: selectedWorkspaceId, query: searchViewModel.textSearchQuery, isLive: canUseLiveFileActions, retryToken: searchViewModel.retryToken)) {
        await searchViewModel.runTextSearch(syncService: syncService, workspaceId: selectedWorkspaceId, canUseLiveFileActions: canUseLiveFileActions)
      }
      .task(id: syncService.requestedFilesNavigation?.id) { await handleRequestedNavigation() }
      .onChange(of: selectedWorkspaceId) { _, _ in
        navigationPath = []
        searchViewModel.clear()
        searchViewModel.searchErrorMessage = nil
      }
    }
  }

  @ViewBuilder
  private func destinationView(for route: FilesRoute) -> some View {
    switch route {
    case .directory(let workspaceId, let parentPath):
      if let workspace = workspaces.first(where: { $0.id == workspaceId }) {
        FilesDirectoryScreen(
          workspace: workspace,
          parentPath: parentPath,
          showHidden: $showHidden,
          isLive: canUseLiveFileActions,
          needsRepairing: needsRepairing,
          openDirectory: { path in openDirectory(path, in: workspace) },
          openFile: { path, line in openFile(path, in: workspace, focusLine: line) },
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
          navigateToDirectory: { path in openDirectory(path, in: workspace) }
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

  // MARK: - Actions

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
      if refreshRemote { try? await syncService.refreshLaneSnapshots() }
      workspaces = try await syncService.listWorkspaces()
      selectedWorkspaceId = selectedWorkspaceId.flatMap { candidate in
        workspaces.contains(where: { $0.id == candidate }) ? candidate : nil
      } ?? workspaces.first?.id
      if !canUseLiveFileActions { searchViewModel.clear() }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  private func handleRequestedNavigation() async {
    guard let request = syncService.requestedFilesNavigation else { return }
    if workspaces.isEmpty { await reload() }
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
    navigationPath = filesRouteForDirectory(parentPath, workspace: workspace)
  }

  private func openFile(_ relativePath: String, in workspace: FilesWorkspace, focusLine: Int?) {
    selectedWorkspaceId = workspace.id
    selectedFileTransitionPath = relativePath
    navigationPath = filesRouteForFile(relativePath, workspace: workspace, focusLine: focusLine)
  }
}
