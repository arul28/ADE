import SwiftUI
import UIKit

extension FilesDirectoryContentsView {
  @MainActor
  func reload() async {
    do {
      if nodes.isEmpty {
        isLoading = true
      }
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
      copyAbsolutePath(for: node)
    }

    Button("Copy Relative Path") {
      copyRelativePath(for: node)
    }
  }

  func copyAbsolutePath(for node: FileTreeNode) {
    UIPasteboard.general.string = absolutePath(for: node.path)
  }

  func copyRelativePath(for node: FileTreeNode) {
    UIPasteboard.general.string = node.path
  }

  func absolutePath(for relativePath: String) -> String {
    guard !relativePath.isEmpty else { return workspace.rootPath }
    return (workspace.rootPath as NSString).appendingPathComponent(relativePath)
  }

  struct DirectoryReloadKey: Hashable {
    let workspaceId: String
    let parentPath: String
    let includeHidden: Bool
    let live: Bool
    let active: Bool
    let manualReloadToken: Int
  }
}
