import SwiftUI
import UIKit

extension FilesDirectoryContentsView {
  @MainActor
  func reload() async {
    do {
      isLoading = true
      nodes = try await syncService.listTree(workspaceId: workspace.id, parentPath: parentPath, includeIgnored: showHidden)
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
    isLoading = false
  }

  func open(_ node: FileTreeNode) {
    if node.type == "directory" {
      openDirectory(node.path)
    } else {
      openFile(node.path, nil)
    }
  }

  @ViewBuilder
  func contextMenu(for node: FileTreeNode) -> some View {
    Button("Open") {
      open(node)
    }

    Button("Copy Path") {
      UIPasteboard.general.string = absolutePath(for: node.path)
    }

    Button("Copy Relative Path") {
      UIPasteboard.general.string = node.path
    }
  }

  func absolutePath(for relativePath: String) -> String {
    guard !relativePath.isEmpty else { return workspace.rootPath }
    return (workspace.rootPath as NSString).appendingPathComponent(relativePath)
  }

  var disconnectedNotice: ADENoticeCard {
    ADENoticeCard(
      title: nodes.isEmpty ? "Reconnect to load this folder" : "Showing cached directory",
      message: needsRepairing
        ? "The previous host trust was cleared. Pair again before trusting refreshed file state."
        : "Cached rows stay browseable, but refresh and search wait for the host to reconnect.",
      icon: "icloud.slash",
      tint: ADEColor.warning,
      actionTitle: syncService.activeHostProfile == nil ? "Open Settings" : "Reconnect",
      action: {
        if syncService.activeHostProfile == nil {
          syncService.settingsPresented = true
        } else {
          Task {
            await syncService.reconnectIfPossible(userInitiated: true)
          }
        }
      }
    )
  }

  struct DirectoryReloadKey: Hashable {
    let workspaceId: String
    let parentPath: String
    let includeHidden: Bool
    let live: Bool
    let revision: Int
  }
}
