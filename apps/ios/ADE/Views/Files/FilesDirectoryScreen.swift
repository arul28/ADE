import SwiftUI

struct FilesDirectoryScreen: View {
  @EnvironmentObject private var syncService: SyncService

  let workspace: FilesWorkspace
  let parentPath: String
  @Binding var showHidden: Bool
  let isLive: Bool
  let isTabActive: Bool
  let openDirectory: (String) -> Void
  let openFile: (String, Int?) -> Void
  let transitionNamespace: Namespace.ID?
  let selectedFilePath: String?

  @State private var refreshErrorMessage: String?
  @State private var manualReloadToken = 0

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
        if let refreshErrorMessage, !syncService.connectionState.isHostUnreachable {
          ADENoticeCard(
            title: "Refresh failed",
            message: refreshErrorMessage,
            icon: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            actionTitle: "Retry",
            action: { Task { await refreshDirectory() } }
          )
        }

        FilesBreadcrumbBar(
          relativePath: parentPath,
          includeCurrentFile: false,
          onSelectDirectory: { path in
            openDirectory(path)
          }
        )

        FilesDirectoryContentsView(
          workspace: workspace,
          parentPath: parentPath,
          showHidden: showHidden,
          isLive: isLive,
          isTabActive: isTabActive,
          openDirectory: openDirectory,
          openFile: openFile,
          transitionNamespace: transitionNamespace,
          selectedFilePath: selectedFilePath,
          manualReloadToken: manualReloadToken
        )
        .environmentObject(syncService)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .scrollBounceBehavior(.basedOnSize)
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(parentPath.isEmpty ? "Root" : lastPathComponent(parentPath))
    .toolbar {
      ADERootToolbarLeadingItems()
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button {
          showHidden.toggle()
        } label: {
          Image(systemName: showHidden ? "eye.slash" : "eye")
        }
        .accessibilityLabel(showHidden ? "Hide hidden files" : "Show hidden files")

        Button {
          Task { await refreshDirectory() }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .accessibilityLabel("Refresh files for this lane")
      }
    }
  }

  @MainActor
  private func refreshDirectory() async {
    do {
      try await syncService.refreshLaneSnapshots()
      refreshErrorMessage = nil
    } catch {
      refreshErrorMessage = error.localizedDescription
    }
    manualReloadToken += 1
  }
}
