import SwiftUI
import UIKit

struct FilesProofArtifactsReloadKey: Hashable {
  let workspaceId: String?
  let revision: Int
}

struct FilesRootScreen: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @Environment(\.duoLayout) var duoLayout
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  var syncService: SyncService { syncPublishes.service }
  @Namespace var fileTransitionNamespace
  var isTabActive = true
  /// Set by the Work tools pane: the same browser, scoped to a chat's lane
  /// workspace, in one column with no claim on the Files tab's deeplinks.
  var preferredLaneId: String? = nil
  var embeddedInPane = false

  @StateObject var treeModel = FilesTreeModel()
  @State var workspaces: [FilesWorkspace] = []
  @State var lanes: [LaneSummary] = []
  /// This machine's workspaces and lanes, and the other live machines', kept
  /// apart so a cached repaint never drops the other machines' rows.
  @State var localWorkspaces: [FilesWorkspace] = []
  @State var localLanes: [LaneSummary] = []
  @State var remoteWorkspaces: [FilesWorkspace] = []
  @State var remoteLanes: [LaneSummary] = []
  @State var selectedWorkspaceId: String?
  @State var isSearchPresented = false
  /// Seed for the search field, set when a chat file link matched several files.
  @State var pendingSearchQuery = ""
  @State var proofArtifacts: [ComputerUseArtifactSummary] = []
  @State var proofErrorMessage: String?
  @State var selectedProofArtifact: ComputerUseArtifactSummary?
  @State var errorMessage: String?
  @State var navigationPath: [FilesRoute] = []
  @State var refreshFeedbackToken = 0
  @State var selectedFileTransitionPath: String?
  @State var lastFilesLocalProjectionReload = Date.distantPast
  @State var lastHandledProofArtifactsReloadKey: FilesProofArtifactsReloadKey?
  @State var suppressNextWorkspaceNavigationReset = false
  @State var hasLoadedWorkspaces = false

  var filesProjectionReloadKey: Int? {
    isTabActive ? syncService.filesProjectionRevision : nil
  }

  var filesNavigationRequestKey: String? {
    // A pane's copy must never consume a deeplink meant for the Files tab.
    guard isTabActive, !embeddedInPane else { return nil }
    return syncService.requestedFilesNavigation?.id
  }

  var proofArtifactsReloadKey: FilesProofArtifactsReloadKey? {
    isTabActive
      ? FilesProofArtifactsReloadKey(workspaceId: selectedWorkspaceId, revision: syncService.proofArtifactsProjectionRevision)
      : nil
  }

  /// The tree shows the selected workspace while the tab is open; re-opening
  /// the tab re-lists what is visible.
  var treeKey: String? {
    isTabActive ? selectedWorkspace?.id : nil
  }

  var projectIconDataUrl: String? {
    syncService.projects.first { $0.id == syncService.activeProjectId }?.iconDataUrl
  }

  /// Load notices above the tree. Shared by the phone layout and the wide
  /// tree column.
  @ViewBuilder
  var filesListPreamble: some View {
    // Suppress connection-caused load failure banners; the top-right
    // gear dot is the single source of truth for host reachability.
    if !syncService.connectionState.isHostUnreachable,
      !syncService.shouldSuppressDomainHydrationNotices,
      let hydrationNotice = filesStatus.inlineHydrationFailureNotice(for: .files)
    {
      ADEInstructionErrorCard(
        notice: hydrationNotice,
        retry: { Task { await reload(refreshRemote: true) } }
      )
      .adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16), separator: .hidden)
    }
    if let errorMessage,
      filesStatus.phase == .ready,
      !syncService.connectionState.isHostUnreachable
    {
      ADENoticeCard(
        title: "Files view error",
        message: errorMessage,
        icon: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        actionTitle: "Retry",
        action: { Task { await reload(refreshRemote: true) } }
      )
      .adeFlatRow(insets: EdgeInsets(top: 4, leading: 16, bottom: 8, trailing: 16), separator: .hidden)
    }
  }

  /// No workspace to browse: a machine is missing, or it exposes none.
  @ViewBuilder
  var filesNoWorkspaceState: some View {
    let isDisconnected = filesStatus.phase == .disconnected || syncService.activeHostProfile == nil
    ADEEmptyStateView(
      symbol: isDisconnected ? "wifi.slash" : "folder.badge.questionmark",
      title: isDisconnected ? "Files unavailable" : "No workspaces",
      message: isDisconnected
        ? "Files need a connected machine. Reconnect or pair a machine in Settings to browse workspaces."
        : "This machine does not expose any lane workspaces for Files yet."
    ) {
      Button(syncService.activeHostProfile == nil ? "Open Settings" : "Refresh Files") {
        if syncService.activeHostProfile == nil {
          syncService.settingsPresented = true
        } else {
          Task { await reload(refreshRemote: true) }
        }
      }
      .buttonStyle(ADEKitButtonStyle(prominent: true))
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .padding(24)
  }

  /// The tree with its notices and the lane's proof. `showsSearch` is false
  /// where another bar (the edge bar, the viewer's bar) already carries search.
  @ViewBuilder
  func filesTreeList(selectedPath: String?, onOpenFile: @escaping (String) -> Void) -> some View {
    if let workspace = selectedWorkspace {
      FilesOutlineTree(
        model: treeModel,
        workspace: workspace,
        selectedPath: selectedPath,
        isLive: canUseLiveFileActions,
        onOpenFile: onOpenFile,
        onRefresh: { await refreshFromPullGesture() }
      ) {
        filesListPreamble
      } footer: {
        if workspace.laneId != nil {
          FilesProofListSection(
            artifacts: proofArtifacts,
            errorMessage: proofErrorMessage,
            onRefresh: { Task { await loadProofArtifacts() } },
            onOpenArtifact: { artifact in selectedProofArtifact = artifact },
            onCopyReference: { artifact in UIPasteboard.general.string = artifact.uri }
          )
        }
      }
    } else if hasLoadedWorkspaces {
      filesNoWorkspaceState
        .background(ADEColor.pageBackground.ignoresSafeArea())
    } else {
      // Workspaces still listing: the tree's own skeleton rows.
      List {
        ForEach(0..<8, id: \.self) { index in
          FilesTreeSkeletonRow(widthFraction: [0.42, 0.55, 0.36, 0.6, 0.48, 0.3, 0.52, 0.4][index])
            .adeFlatRow(insets: FilesOutlineTree<EmptyView, EmptyView>.rowInsets, separator: .hidden)
        }
      }
      .environment(\.defaultMinListRowHeight, 0)
      .adeFlatList()
      .scrollDisabled(true)
    }
  }

  var body: some View {
    Group {
      // Wide windows (the Duo's inner display, an iPad) put the tree beside
      // the viewer; every other size keeps the phone's push navigation.
      if duoLayout.isWide && !embeddedInPane {
        duoFilesWindowBody
      } else {
        filesPhoneBody
      }
    }
    .sensoryFeedback(.selection, trigger: selectedWorkspaceId)
    .sensoryFeedback(.success, trigger: refreshFeedbackToken)
    // Opening the tab: paint the cached workspaces, then ask the machines.
    .task(id: isTabActive) {
      guard isTabActive else { return }
      await reload()
    }
    // A projection bump (often this tab's own cache writes) re-reads the
    // phone's cache only; it never asks the machine again, so it cannot loop.
    .task(id: filesProjectionReloadKey) {
      guard filesProjectionReloadKey != nil, hasLoadedWorkspaces else { return }
      let elapsed = Date().timeIntervalSince(lastFilesLocalProjectionReload)
      if elapsed < 1 {
        try? await Task.sleep(for: .milliseconds(max(1, Int((1 - elapsed) * 1_000))))
        guard !Task.isCancelled else { return }
      }
      lastFilesLocalProjectionReload = Date()
      await reload(live: false)
    }
    .task(id: treeKey) {
      treeModel.attach(syncService)
      guard let treeKey else { return }
      treeModel.show(workspaceId: treeKey, refresh: true)
      // The open file's folders stay expanded (a restored or folded window).
      if case .editor(let workspaceId, let path, _)? = navigationPath.last, workspaceId == treeKey {
        treeModel.reveal(path, isDirectory: false, in: workspaceId)
      }
    }
    .task(id: filesNavigationRequestKey) {
      guard filesNavigationRequestKey != nil else { return }
      await handleRequestedNavigation()
    }
    .task(id: proofArtifactsReloadKey) {
      guard let key = proofArtifactsReloadKey else { return }
      guard lastHandledProofArtifactsReloadKey != key else { return }
      await loadProofArtifacts()
      guard !Task.isCancelled else { return }
      lastHandledProofArtifactsReloadKey = key
    }
    .onChange(of: selectedWorkspaceId) { _, _ in
      if suppressNextWorkspaceNavigationReset {
        suppressNextWorkspaceNavigationReset = false
        return
      }
      if !navigationPath.isEmpty {
        navigationPath = []
      }
    }
    .sheet(item: $selectedProofArtifact) { artifact in
      FilesProofArtifactSheet(artifact: artifact)
        .environmentObject(syncService)
    }
    .fullScreenCover(isPresented: $isSearchPresented) {
      if let workspace = selectedWorkspace {
        FilesSearchScreen(
          workspace: workspace,
          isLive: canUseLiveFileActions,
          needsRepairing: needsRepairing,
          initialQuery: pendingSearchQuery,
          onOpenFile: { path, line in
            openFile(path, in: workspace, focusLine: line)
          }
        )
        .environmentObject(syncService)
        .onDisappear { pendingSearchQuery = "" }
      } else {
        // The workspace list emptied while search was open (e.g. a disconnect
        // reload). Never strand the user on a blank cover with no way out.
        Color.clear.onAppear { isSearchPresented = false }
      }
    }
  }

  /// The phone layout: the tree, pushing the viewer.
  private var filesPhoneBody: some View {
    NavigationStack(path: $navigationPath) {
      filesTreeList(selectedPath: selectedFileTransitionPath) { path in
        guard let workspace = selectedWorkspace else { return }
        openFile(path, in: workspace, focusLine: nil)
      }
      .filesTreeChrome(
        projectIconDataUrl: projectIconDataUrl,
        onBackToHub: { syncService.showProjectHub() }
      ) {
        filesTreeHeaderRow(showsSearch: true)
      }
      .navigationDestination(for: FilesRoute.self) { route in
        switch route {
        case .editor(let workspaceId, let relativePath, let focusLine):
          if let workspace = workspaces.first(where: { $0.id == workspaceId }) {
            FilesDetailScreen(
              workspace: workspace,
              relativePath: relativePath,
              focusLine: focusLine,
              transitionNamespace: transitionNamespace,
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
    }
  }

  /// The tree's header row (workspace picker, search, ⋯), or nothing while
  /// no workspace is listed.
  @ViewBuilder
  func filesTreeHeaderRow(showsSearch: Bool) -> some View {
    if !workspaces.isEmpty {
      FilesTreeHeaderRow(
        workspaces: workspaces,
        lanes: lanes,
        selectedWorkspaceId: selectedWorkspaceBinding,
        isLive: canUseLiveFileActions,
        showsSearch: showsSearch,
        onSearch: presentSearch
      )
    }
  }

  func presentSearch() {
    // A manual open always starts from an empty field; only a chat file link
    // seeds one.
    pendingSearchQuery = ""
    isSearchPresented = true
  }
}

extension View {
  /// The Files tree's header, Work's and Lanes' grammar: ‹ project logo and
  /// "Files" in the bar, the header row (picker, search, ⋯) under it.
  func filesTreeChrome<Row: View>(
    projectIconDataUrl: String?,
    onBackToHub: @escaping () -> Void,
    @ViewBuilder row: () -> Row
  ) -> some View {
    safeAreaInset(edge: .top, spacing: 0) { row() }
      // The viewer hides the bar held landscape on a phone; coming back,
      // the tree asks for it again (SwiftUI kept it hidden after the pop).
      .toolbar(.visible, for: .navigationBar)
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          HStack(spacing: 6) {
            WorkHeaderProjectButton(iconDataUrl: projectIconDataUrl, action: onBackToHub)
            Text("Files")
              .font(.system(size: 22, weight: .heavy, design: .rounded))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
              .fixedSize()
              .accessibilityAddTraits(.isHeader)
          }
          .padding(.horizontal, 4)
        }
        .sharedBackgroundVisibility(.hidden)
      }
  }
}
