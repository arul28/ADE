import SwiftUI

struct FilesDirectoryScreen: View {
  @EnvironmentObject private var syncService: SyncService

  let workspace: FilesWorkspace
  let parentPath: String
  @Binding var showHidden: Bool
  let isLive: Bool
  let needsRepairing: Bool
  let openDirectory: (String) -> Void
  let openFile: (String, Int?) -> Void
  let transitionNamespace: Namespace.ID?
  let selectedFilePath: String?

  var body: some View {
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 14) {
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
          needsRepairing: needsRepairing,
          showDisconnectedNotice: true,
          openDirectory: openDirectory,
          openFile: openFile,
          transitionNamespace: transitionNamespace,
          selectedFilePath: selectedFilePath
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
      ToolbarItemGroup(placement: .topBarTrailing) {
        Button {
          showHidden.toggle()
        } label: {
          Image(systemName: showHidden ? "eye.slash" : "eye")
        }
        .accessibilityLabel(showHidden ? "Hide hidden files" : "Show hidden files")

        Button {
          Task {
            try? await syncService.refreshLaneSnapshots()
          }
        } label: {
          Image(systemName: "arrow.clockwise")
        }
        .accessibilityLabel("Refresh files for this lane")
      }
    }
  }
}
