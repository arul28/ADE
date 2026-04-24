import SwiftUI
import UIKit

struct FilesProofArtifactsReloadKey: Hashable {
  let workspaceId: String?
  let revision: Int
}

struct FilesRootScreen: View {
  @Environment(\.accessibilityReduceMotion) var reduceMotion
  @EnvironmentObject var syncService: SyncService
  @AppStorage("ade.files.showHidden") private var showHidden = false
  @Namespace var fileTransitionNamespace
  var isTabActive = true

  @State var workspaces: [FilesWorkspace] = []
  @State var selectedWorkspaceId: String?
  @State var quickOpenQuery = ""
  @State var quickOpenResults: [FilesQuickOpenItem] = []
  @State var textSearchQuery = ""
  @State var textSearchResults: [FilesSearchTextMatch] = []
  @State var proofArtifacts: [ComputerUseArtifactSummary] = []
  @State var proofErrorMessage: String?
  @State var selectedProofArtifact: ComputerUseArtifactSummary?
  @State var errorMessage: String?
  @State var navigationPath: [FilesRoute] = []
  @State var refreshFeedbackToken = 0
  @State var selectedFileTransitionPath: String?
  @State var lastFilesLocalProjectionReload = Date.distantPast
  @State var lastHandledFilesProjectionRevision: Int?
  @State var lastHandledQuickOpenSearchKey: FilesSearchKey?
  @State var lastHandledTextSearchKey: FilesSearchKey?
  @State var lastHandledProofArtifactsReloadKey: FilesProofArtifactsReloadKey?
  @State var suppressNextWorkspaceNavigationReset = false

  var filesProjectionReloadKey: Int? {
    isTabActive ? syncService.localStateRevision : nil
  }

  var quickOpenSearchKey: FilesSearchKey? {
    guard isTabActive else { return nil }
    return FilesSearchKey(workspaceId: selectedWorkspaceId, query: quickOpenQuery, isLive: canUseLiveFileActions)
  }

  var textSearchKey: FilesSearchKey? {
    guard isTabActive else { return nil }
    return FilesSearchKey(workspaceId: selectedWorkspaceId, query: textSearchQuery, isLive: canUseLiveFileActions)
  }

  var filesNavigationRequestKey: String? {
    guard isTabActive else { return nil }
    return syncService.requestedFilesNavigation?.id
  }

  var proofArtifactsReloadKey: FilesProofArtifactsReloadKey? {
    isTabActive
      ? FilesProofArtifactsReloadKey(workspaceId: selectedWorkspaceId, revision: syncService.localStateRevision)
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
                ? "Files need a connected host. Reconnect or pair a host in Settings to browse workspaces."
                : "This host does not currently expose any lane-backed workspaces for the mobile Files browser."
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
              selectedWorkspaceId: selectedWorkspaceBinding,
              selectedWorkspace: workspace,
              showHidden: $showHidden
            )

            VStack(alignment: .leading, spacing: 12) {
              HStack(alignment: .center, spacing: 10) {
                Label("Browser", systemImage: "folder")
                  .font(.headline)
                  .foregroundStyle(ADEColor.textPrimary)
                Spacer(minLength: 8)
                Text(canUseLiveFileActions ? "Live" : "Cached")
                  .font(.caption2.weight(.semibold))
                  .foregroundStyle(canUseLiveFileActions ? ADEColor.success : ADEColor.textMuted)
              }

              FilesDirectoryContentsView(
                workspace: workspace,
                parentPath: "",
                showHidden: showHidden,
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
            }
            .adeGlassCard(cornerRadius: 18)

            FilesQueryCard(
              title: "Quick open",
              prompt: "Search files",
              query: $quickOpenQuery,
              disabled: !canUseLiveFileActions,
              emptyMessage: quickOpenEmptyMessage,
              scopeText: workspace.rootPath
            )

            if canUseLiveFileActions {
              ForEach(quickOpenResults) { item in
                Button {
                  openFile(item.path, in: workspace, focusLine: nil)
                } label: {
                  FilesResultRow(
                    path: item.path,
                    transitionNamespace: transitionNamespace,
                    isSelectedTransitionSource: selectedFileTransitionPath == item.path
                  )
                }
                .buttonStyle(.plain)
              }
            }

            FilesQueryCard(
              title: "Text search",
              prompt: "Search text",
              query: $textSearchQuery,
              disabled: !canUseLiveFileActions,
              emptyMessage: textSearchEmptyMessage,
              scopeText: workspace.rootPath
            )

            if canUseLiveFileActions {
              ForEach(textSearchResults) { result in
                Button {
                  openFile(result.path, in: workspace, focusLine: result.line)
                } label: {
                  FilesSearchResultRow(
                    result: result,
                    transitionNamespace: transitionNamespace,
                    isSelectedTransitionSource: selectedFileTransitionPath == result.path
                  )
                }
                .buttonStyle(.plain)
              }
            }

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
        .padding(.bottom, 88)
      }
      .scrollDismissesKeyboard(.interactively)
      .scrollBounceBehavior(.basedOnSize)
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
              showHidden: $showHidden,
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
      .task(id: quickOpenSearchKey) {
        guard let key = quickOpenSearchKey else { return }
        guard lastHandledQuickOpenSearchKey != key else { return }
        await runQuickOpenSearch()
        guard !Task.isCancelled else { return }
        lastHandledQuickOpenSearchKey = key
      }
      .task(id: textSearchKey) {
        guard let key = textSearchKey else { return }
        guard lastHandledTextSearchKey != key else { return }
        await runTextSearch()
        guard !Task.isCancelled else { return }
        lastHandledTextSearchKey = key
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
        if !quickOpenResults.isEmpty {
          quickOpenResults = []
        }
        if !textSearchResults.isEmpty {
          textSearchResults = []
        }
      }
      .sheet(item: $selectedProofArtifact) { artifact in
        FilesProofArtifactSheet(artifact: artifact)
          .environmentObject(syncService)
      }
    }
  }
}
