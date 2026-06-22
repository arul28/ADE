import SwiftUI
import UIKit

struct FilesProofArtifactsReloadKey: Hashable {
  let workspaceId: String?
  let revision: Int
}

struct FilesRootScreen: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @EnvironmentObject var syncService: SyncService
  @Namespace var fileTransitionNamespace
  var isTabActive = true

  @State var workspaces: [FilesWorkspace] = []
  @State var lanes: [LaneSummary] = []
  @State var selectedWorkspaceId: String?
  @State var isSearchPresented = false
  @State var proofArtifacts: [ComputerUseArtifactSummary] = []
  @State var proofErrorMessage: String?
  @State var selectedProofArtifact: ComputerUseArtifactSummary?
  @State var errorMessage: String?
  @State var navigationPath: [FilesRoute] = []
  @State var refreshFeedbackToken = 0
  @State var selectedFileTransitionPath: String?
  @State var lastFilesLocalProjectionReload = Date.distantPast
  @State var lastHandledFilesProjectionRevision: Int?
  @State var lastHandledProofArtifactsReloadKey: FilesProofArtifactsReloadKey?
  @State var suppressNextWorkspaceNavigationReset = false

  var filesProjectionReloadKey: Int? {
    isTabActive ? syncService.filesProjectionRevision : nil
  }

  var filesNavigationRequestKey: String? {
    guard isTabActive else { return nil }
    return syncService.requestedFilesNavigation?.id
  }

  var proofArtifactsReloadKey: FilesProofArtifactsReloadKey? {
    isTabActive
      ? FilesProofArtifactsReloadKey(workspaceId: selectedWorkspaceId, revision: syncService.proofArtifactsProjectionRevision)
      : nil
  }

  var body: some View {
    NavigationStack(path: $navigationPath) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          // Suppress connection-caused load failure banners; the top-right
          // gear dot is the single source of truth for host reachability.
          if !syncService.connectionState.isHostUnreachable,
            let hydrationNotice = filesStatus.inlineHydrationFailureNotice(for: .files)
          {
            ADENoticeCard(
              title: hydrationNotice.title,
              message: hydrationNotice.message,
              icon: "exclamationmark.triangle.fill",
              tint: ADEColor.danger,
              actionTitle: "Retry",
              action: { Task { await reload(refreshRemote: true) } }
            )
            .transition(.opacity)
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
            .transition(.opacity)
          }

          if isLoadingSkeleton {
            ADECardSkeleton(rows: 3)
            ADECardSkeleton(rows: 4)
          }

          if workspaces.isEmpty && !isLoadingSkeleton {
            let isDisconnected = filesStatus.phase == .disconnected || syncService.activeHostProfile == nil
            ADEEmptyStateView(
              symbol: isDisconnected ? "wifi.slash" : "folder.badge.questionmark",
              title: isDisconnected ? "Files unavailable" : "No workspaces available",
              message: isDisconnected
                ? "Files need a connected machine. Reconnect or pair a machine in Settings to browse workspaces."
                : "This machine does not currently expose any lane-backed workspaces for the mobile Files browser."
            ) {
              Button(syncService.activeHostProfile == nil ? "Open Settings" : "Refresh Files") {
                if syncService.activeHostProfile == nil {
                  syncService.settingsPresented = true
                } else {
                  Task { await reload(refreshRemote: true) }
                }
              }
              .buttonStyle(.glassProminent)
              .tint(ADEColor.accent)
            }
          }

          if let workspace = selectedWorkspace {
            FilesWorkspaceHeader(
              workspaces: workspaces,
              lanes: lanes,
              selectedWorkspaceId: selectedWorkspaceBinding,
              selectedWorkspace: workspace,
              isLive: canUseLiveFileActions
            )

            FilesDirectoryContentsView(
              workspace: workspace,
              parentPath: "",
              isLive: canUseLiveFileActions,
              isTabActive: isTabActive,
              openDirectory: { path in
                openDirectory(path, in: workspace)
              },
              openFile: { path, line in
                openFile(path, in: workspace, focusLine: line)
              },
              transitionNamespace: transitionNamespace,
              selectedFilePath: selectedFileTransitionPath,
              manualReloadToken: 0
            )
            .environmentObject(syncService)

            if workspace.laneId != nil {
              FilesProofSection(
                artifacts: proofArtifacts,
                errorMessage: proofErrorMessage,
                onRefresh: { Task { await loadProofArtifacts() } },
                onOpenArtifact: { artifact in
                  selectedProofArtifact = artifact
                },
                onCopyReference: { artifact in
                  UIPasteboard.general.string = artifact.uri
                }
              )
            }
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
      }
      .scrollDismissesKeyboard(.interactively)
      .scrollBounceBehavior(.basedOnSize)
      .contentMargins(.bottom, 24, for: .scrollContent)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("")
      .navigationBarTitleDisplayMode(.inline)
      .navigationDestination(for: FilesRoute.self) { route in
        switch route {
        case .directory(let workspaceId, let parentPath):
          if let workspace = workspaces.first(where: { $0.id == workspaceId }) {
            FilesDirectoryScreen(
              workspace: workspace,
              parentPath: parentPath,
              isLive: canUseLiveFileActions,
              isTabActive: isTabActive,
              openDirectory: { path in
                openDirectory(path, in: workspace)
              },
              openFile: { path, line in
                openFile(path, in: workspace, focusLine: line)
              },
              transitionNamespace: transitionNamespace,
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
      .toolbar(.hidden, for: .navigationBar)
      .safeAreaInset(edge: .top, spacing: 0) {
        ADERootTopBar(title: "Files") {
          if selectedWorkspace != nil {
            Button {
              isSearchPresented = true
            } label: {
              Image(systemName: "magnifyingglass")
            }
            .accessibilityLabel("Search files")
            .disabled(!canUseLiveFileActions)
          }
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
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task(id: filesProjectionReloadKey) {
        guard let revision = filesProjectionReloadKey else { return }
        guard lastHandledFilesProjectionRevision != revision || workspaces.isEmpty else { return }
        let now = Date()
        if !workspaces.isEmpty {
          let elapsed = now.timeIntervalSince(lastFilesLocalProjectionReload)
          if elapsed < 0.35 {
            try? await Task.sleep(for: .milliseconds(max(1, Int((0.35 - elapsed) * 1_000))))
            guard !Task.isCancelled, filesProjectionReloadKey == revision else { return }
          }
        }
        lastFilesLocalProjectionReload = Date()
        await reload()
        guard !Task.isCancelled, filesProjectionReloadKey == revision else { return }
        lastHandledFilesProjectionRevision = revision
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
            onOpenFile: { path, line in
              openFile(path, in: workspace, focusLine: line)
            }
          )
          .environmentObject(syncService)
        } else {
          // The workspace list emptied while search was open (e.g. a disconnect
          // reload). Never strand the user on a blank cover with no way out.
          Color.clear.onAppear { isSearchPresented = false }
        }
      }
    }
  }
}
