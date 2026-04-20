import SwiftUI
import UIKit

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

  var body: some View {
    NavigationStack(path: $navigationPath) {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          if let hydrationNotice = filesStatus.inlineHydrationFailureNotice(for: .files) {
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
          if let errorMessage, filesStatus.phase == .ready {
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

          if filesStatus.phase == .ready && workspaces.isEmpty {
            ADEEmptyStateView(
              symbol: "folder.badge.questionmark",
              title: "No workspaces available",
              message: "This host does not currently expose any lane-backed workspaces for the mobile Files browser."
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

            VStack(alignment: .leading, spacing: 12) {
              Text("Browser")
                .font(.headline)
                .foregroundStyle(ADEColor.textPrimary)
              Text("Drill into folders, follow breadcrumbs, and open read-first previews without leaving the current workspace.")
                .font(.caption)
                .foregroundStyle(ADEColor.textSecondary)

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
                selectedFilePath: selectedFileTransitionPath
              )
              .environmentObject(syncService)
            }
            .adeGlassCard(cornerRadius: 18)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
      }
      .scrollBounceBehavior(.basedOnSize)
      .adeScreenBackground()
      .adeNavigationGlass()
      .navigationTitle("Files")
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
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          ADEConnectionDot()
        }
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
      .sensoryFeedback(.success, trigger: refreshFeedbackToken)
      .task(id: isTabActive) {
        guard isTabActive else { return }
        await reload()
      }
      .task(id: "\(syncService.localStateRevision)-\(isTabActive)") {
        guard isTabActive else { return }
        let now = Date()
        guard now.timeIntervalSince(lastFilesLocalProjectionReload) >= 0.35 else { return }
        lastFilesLocalProjectionReload = now
        await reload()
      }
      .task(id: "\(FilesSearchKey(workspaceId: selectedWorkspaceId, query: quickOpenQuery, isLive: canUseLiveFileActions).hashValue)-\(isTabActive)") {
        guard isTabActive else { return }
        await runQuickOpenSearch()
      }
      .task(id: "\(FilesSearchKey(workspaceId: selectedWorkspaceId, query: textSearchQuery, isLive: canUseLiveFileActions).hashValue)-\(isTabActive)") {
        guard isTabActive else { return }
        await runTextSearch()
      }
      .task(id: "\(syncService.requestedFilesNavigation?.id ?? "none")-\(isTabActive)") {
        guard isTabActive else { return }
        await handleRequestedNavigation()
      }
      .task(id: "\(selectedWorkspaceId ?? "none")-\(isTabActive)") {
        guard isTabActive else { return }
        await loadProofArtifacts()
      }
      .onChange(of: selectedWorkspaceId) { _, _ in
        navigationPath = []
        quickOpenResults = []
        textSearchResults = []
      }
      .sheet(item: $selectedProofArtifact) { artifact in
        FilesProofArtifactSheet(artifact: artifact)
          .environmentObject(syncService)
      }
    }
  }
}
