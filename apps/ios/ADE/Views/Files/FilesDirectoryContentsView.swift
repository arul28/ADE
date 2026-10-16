import SwiftUI

struct FilesDirectoryContentsView: View {
  @EnvironmentObject var syncService: SyncService

  let workspace: FilesWorkspace
  let parentPath: String
  let isLive: Bool
  let isTabActive: Bool
  let openDirectory: (String) -> Void
  let openFile: (String, Int?) -> Void
  let transitionNamespace: Namespace.ID?
  let selectedFilePath: String?
  let manualReloadToken: Int

  @State var nodes: [FileTreeNode] = []
  @State var errorMessage: String?
  @State var isLoading = true

  var body: some View {
    LazyVStack(alignment: .leading, spacing: 12) {
      if let errorMessage, !syncService.connectionState.isHostUnreachable {
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
        ADECardSkeleton(rows: 5)
      } else if nodes.isEmpty {
        ADEEmptyStateView(
          symbol: parentPath.isEmpty ? "folder" : "folder.badge.minus",
          title: parentPath.isEmpty ? "Workspace is empty" : "Folder is empty",
          message: isLive ? "This directory does not have any files to preview on iPhone yet." : "Reconnect to refresh files from the machine."
        )
      } else {
        // One kit panel, hairlines between rows.
        LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(Array(filesSortedNodes(nodes).enumerated()), id: \.element.id) { index, node in
          if index > 0 {
            Rectangle().fill(ADEKit.rule).frame(height: 0.75).padding(.leading, 44)
          }
          FilesTreeNodeRow(
            workspaceId: workspace.id,
            node: node,
            transitionNamespace: transitionNamespace,
            isSelectedTransitionSource: selectedFilePath == node.path,
            onOpen: { open(node) },
            onCopyPath: { copyAbsolutePath(for: node) },
            onCopyRelativePath: { copyRelativePath(for: node) }
          )
          .contextMenu {
            contextMenu(for: node)
          }
          .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            Button("Copy Full Path") {
              copyAbsolutePath(for: node)
            }
            .tint(ADEColor.accent)

            Button("Copy Relative Path") {
              copyRelativePath(for: node)
            }
            .tint(ADEColor.info)
          }
          .accessibilityAction(named: Text("Copy Full Path")) {
            copyAbsolutePath(for: node)
          }
          .accessibilityAction(named: Text("Copy Relative Path")) {
            copyRelativePath(for: node)
          }
        }
        }
        .adeKitCard(padding: nil)
      }
    }
    .task(id: DirectoryReloadKey(
      workspaceId: workspace.id,
      parentPath: parentPath,
      includeHidden: true,
      live: isLive,
      active: isTabActive,
      manualReloadToken: manualReloadToken
    )) {
      guard isTabActive else { return }
      await reload()
    }
  }
}
