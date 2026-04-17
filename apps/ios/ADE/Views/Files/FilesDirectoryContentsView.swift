import SwiftUI

struct FilesDirectoryContentsView: View {
  @EnvironmentObject var syncService: SyncService

  let workspace: FilesWorkspace
  let parentPath: String
  let showHidden: Bool
  let isLive: Bool
  let isTabActive: Bool
  let needsRepairing: Bool
  let showDisconnectedNotice: Bool
  let openDirectory: (String) -> Void
  let openFile: (String, Int?) -> Void
  let transitionNamespace: Namespace.ID?
  let selectedFilePath: String?

  @State var nodes: [FileTreeNode] = []
  @State var errorMessage: String?
  @State var isLoading = true

  var body: some View {
    LazyVStack(alignment: .leading, spacing: 12) {
      if showDisconnectedNotice && !isLive {
        disconnectedNotice
      }

      if let errorMessage {
        ADENoticeCard(
          title: "Directory load failed",
          message: errorMessage,
          icon: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          actionTitle: "Retry",
          action: { Task { await reload() } }
        )
      }

      if isLoading {
        ForEach(0..<4, id: \.self) { _ in
          ADECardSkeleton(rows: 2)
        }
      } else if nodes.isEmpty {
        ADEEmptyStateView(
          symbol: parentPath.isEmpty ? "folder" : "folder.badge.minus",
          title: parentPath.isEmpty ? "Workspace is empty" : "Folder is empty",
          message: isLive ? "This directory does not have any files to preview on iPhone yet." : "Reconnect to refresh files from the host."
        )
      } else {
        ForEach(filesSortedNodes(nodes)) { node in
          Button {
            open(node)
          } label: {
            FilesTreeNodeRow(
              node: node,
              transitionNamespace: transitionNamespace,
              isSelectedTransitionSource: selectedFilePath == node.path
            )
          }
          .buttonStyle(.plain)
          .contextMenu {
            contextMenu(for: node)
          }
        }
      }
    }
    .task(id: DirectoryReloadKey(workspaceId: workspace.id, parentPath: parentPath, includeHidden: showHidden, live: isLive, active: isTabActive, revision: syncService.localStateRevision)) {
      guard isTabActive else { return }
      await reload()
    }
  }
}
