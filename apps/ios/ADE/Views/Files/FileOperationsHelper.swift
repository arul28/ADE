import SwiftUI
import UIKit

// MARK: - Navigation Types

enum FilesRoute: Hashable {
  case directory(workspaceId: String, parentPath: String)
  case editor(workspaceId: String, relativePath: String, focusLine: Int?)
}

struct FilesSearchKey: Hashable {
  let workspaceId: String?
  let query: String
  let isLive: Bool
  var retryToken: Int = 0
}

// MARK: - Editor Types

enum FilesEditorMode: String, CaseIterable, Identifiable {
  case preview
  case edit
  case diff

  var id: String { rawValue }

  var title: String {
    switch self {
    case .preview: return "Preview"
    case .edit: return "Edit"
    case .diff: return "Diff"
    }
  }
}

enum FilesDiffMode: String, CaseIterable, Identifiable {
  case unstaged
  case staged

  var id: String { rawValue }

  var title: String {
    switch self {
    case .unstaged: return "Working tree"
    case .staged: return "Staged"
    }
  }
}

// MARK: - Prompt Types

enum FilesPromptKind {
  case createFile
  case createFolder
  case rename
}

struct FilesPathPrompt: Identifiable {
  let id = UUID()
  let kind: FilesPromptKind
  let basePath: String
  let node: FileTreeNode?

  var title: String {
    switch kind {
    case .createFile: return "New file"
    case .createFolder: return "New folder"
    case .rename: return "Rename"
    }
  }

  var message: String {
    switch kind {
    case .createFile:
      return basePath.isEmpty ? "Create a file at the workspace root." : "Create a file in \(basePath)."
    case .createFolder:
      return basePath.isEmpty ? "Create a folder at the workspace root." : "Create a folder in \(basePath)."
    case .rename:
      return "Rename \(node?.name ?? "this item")."
    }
  }

  var placeholder: String {
    switch kind {
    case .createFile: return "example.swift"
    case .createFolder: return "NewFolder"
    case .rename: return node?.name ?? "Name"
    }
  }

  var confirmLabel: String {
    switch kind {
    case .createFile: return "Create"
    case .createFolder: return "Create"
    case .rename: return "Rename"
    }
  }

  var initialValue: String {
    node?.name ?? ""
  }
}

// MARK: - Destructive Confirmation

enum FilesDestructiveKind {
  case delete(node: FileTreeNode)
  case discard(path: String)
  case discardUnsaved
}

struct FilesDestructiveConfirmation: Identifiable {
  let id = UUID()
  let kind: FilesDestructiveKind

  var title: String {
    switch kind {
    case .delete(let node):
      return "Delete \(node.name)?"
    case .discard(let path):
      return "Discard changes for \(lastPathComponent(path))?"
    case .discardUnsaved:
      return "Discard unsaved changes?"
    }
  }

  var message: String {
    switch kind {
    case .delete:
      return "This permanently removes the item from the host workspace."
    case .discard:
      return "This permanently loses your local edits."
    case .discardUnsaved:
      return "Your unsaved edits on iPhone will be lost."
    }
  }

  var confirmLabel: String {
    switch kind {
    case .delete: return "Delete"
    case .discard, .discardUnsaved: return "Discard"
    }
  }
}

// MARK: - State Types

struct FilesGitState {
  var staged: Set<String> = []
  var unstaged: Set<String> = []

  static let empty = FilesGitState()

  func isStaged(_ path: String) -> Bool { staged.contains(path) }
  func isUnstaged(_ path: String) -> Bool { unstaged.contains(path) }
  func hasChanges(_ path: String) -> Bool { isStaged(path) || isUnstaged(path) }
}

struct FilesFileMetadata {
  let sizeText: String
  let languageLabel: String
  let lastCommitTitle: String?
  let lastCommitDateText: String?
}

struct FilesTreeRowItem: Identifiable, Equatable {
  enum Kind: Equatable {
    case node(FileTreeNode)
    case loading(String)
  }

  let kind: Kind
  let depth: Int

  var id: String {
    switch kind {
    case .node(let node):
      return node.path
    case .loading(let path):
      return "loading::\(path)"
    }
  }

  var node: FileTreeNode? {
    if case .node(let node) = kind {
      return node
    }
    return nil
  }
}

struct FilesBreadcrumbItem: Equatable {
  let label: String
  let path: String
  let isDirectory: Bool
}

// MARK: - Editor Navigation

enum EditorNavigationTarget {
  case dismiss
  case directory(String)
}

// MARK: - Reload Key

struct DirectoryReloadKey: Hashable {
  let workspaceId: String
  let parentPath: String
  let includeHidden: Bool
  let live: Bool
  let revision: Int
}

// MARK: - Path Helpers

func joinedPath(base: String, name: String) -> String {
  let cleanedBase = base.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  let cleanedName = name.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
  guard !cleanedBase.isEmpty else { return cleanedName }
  guard !cleanedName.isEmpty else { return cleanedBase }
  return "\(cleanedBase)/\(cleanedName)"
}

func parentDirectory(of path: String) -> String {
  let components = pathComponents(path)
  guard components.count > 1 else { return "" }
  return components.dropLast().joined(separator: "/")
}

func pathComponents(_ path: String) -> [String] {
  path.split(separator: "/").map(String.init)
}

func lastPathComponent(_ path: String) -> String {
  pathComponents(path).last ?? path
}

func fileTint(for name: String) -> Color {
  let icon = fileIcon(for: name)
  switch icon {
  case "chevron.left.forwardslash.chevron.right": return .blue
  case "doc.badge.gearshape": return .orange
  case "doc.text": return .yellow
  case "photo": return .pink
  case "doc.zipper": return .red
  default: return ADEColor.textSecondary
  }
}

func changeStatusTint(_ changeStatus: String) -> Color {
  switch changeStatus.uppercased() {
  case "A": return ADEColor.success
  case "D": return ADEColor.danger
  case "M": return ADEColor.warning
  default: return ADEColor.textSecondary
  }
}

func changeStatusDescription(_ changeStatus: String) -> String {
  switch changeStatus.uppercased() {
  case "A": return "Added"
  case "D": return "Deleted"
  case "M": return "Modified"
  default: return changeStatus.uppercased()
  }
}

func filesNameValidationError(
  for proposedName: String,
  existingNodes: [FileTreeNode],
  excluding excludedPath: String? = nil
) -> String? {
  let trimmed = proposedName.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else {
    return "Name cannot be empty."
  }
  guard trimmed != "." && trimmed != ".." else {
    return "That name is reserved."
  }
  guard !trimmed.contains("/") && !trimmed.contains("\\") else {
    return "Use a single file or folder name here."
  }
  guard !trimmed.contains("\u{0}") else {
    return "Use a single file or folder name here."
  }
  guard trimmed.rangeOfCharacter(from: .controlCharacters) == nil else {
    return "Use a single file or folder name here."
  }

  if let conflict = existingNodes.first(where: {
    $0.name.caseInsensitiveCompare(trimmed) == .orderedSame && $0.path != excludedPath
  }) {
    return "\(conflict.name) already exists in this folder."
  }

  return nil
}

func isBinaryFilePath(_ path: String) -> Bool {
  let lowercased = path.lowercased()
  let ext = (lowercased as NSString).pathExtension
  return [
    "bin", "exe", "dll", "so", "dylib", "o", "a", "class",
    "jar", "war", "ear", "wasm", "pyc",
  ].contains(ext)
}

func visibleFilesTreeRows(
  nodes: [FileTreeNode],
  expandedPaths: Set<String>,
  loadingPaths: Set<String>,
  childNodesByPath: [String: [FileTreeNode]],
  showHidden: Bool,
  depth: Int = 0
) -> [FilesTreeRowItem] {
  nodes.flatMap { node -> [FilesTreeRowItem] in
    if !showHidden && node.name.hasPrefix(".") {
      return []
    }

    var rows: [FilesTreeRowItem] = [.init(kind: .node(node), depth: depth)]
    guard node.type == "directory", expandedPaths.contains(node.path) else {
      return rows
    }

    if loadingPaths.contains(node.path) {
      rows.append(.init(kind: .loading(node.path), depth: depth + 1))
      return rows
    }

    if let children = childNodesByPath[node.path] {
      rows.append(contentsOf: visibleFilesTreeRows(
        nodes: children,
        expandedPaths: expandedPaths,
        loadingPaths: loadingPaths,
        childNodesByPath: childNodesByPath,
        showHidden: showHidden,
        depth: depth + 1
      ))
    }

    return rows
  }
}

func filesBreadcrumbItems(relativePath: String, includeCurrentFile: Bool) -> [FilesBreadcrumbItem] {
  let components = pathComponents(relativePath)
  guard !components.isEmpty else { return [] }

  return components.indices.map { index in
    let path = components[0...index].joined(separator: "/")
    let isLast = index == components.count - 1
    return FilesBreadcrumbItem(
      label: components[index],
      path: path,
      isDirectory: includeCurrentFile ? !isLast : true
    )
  }
}

private let sharedISOFormatter = ISO8601DateFormatter()
private let sharedRelativeFormatter: RelativeDateTimeFormatter = {
  let f = RelativeDateTimeFormatter()
  return f
}()

func relativeDateDescription(from isoTimestamp: String?) -> String? {
  guard let isoTimestamp, let date = sharedISOFormatter.date(from: isoTimestamp) else { return nil }
  return sharedRelativeFormatter.localizedString(for: date, relativeTo: Date())
}

func filesRouteForDirectory(_ parentPath: String, workspace: FilesWorkspace) -> [FilesRoute] {
  let components = pathComponents(parentPath)
  guard !components.isEmpty else { return [] }
  return components.indices.map { index in
    .directory(workspaceId: workspace.id, parentPath: components[0...index].joined(separator: "/"))
  }
}

func filesRouteForFile(_ relativePath: String, workspace: FilesWorkspace, focusLine: Int?) -> [FilesRoute] {
  var routes = filesRouteForDirectory(parentDirectory(of: relativePath), workspace: workspace)
  routes.append(.editor(workspaceId: workspace.id, relativePath: relativePath, focusLine: focusLine))
  return routes
}

@MainActor
func filesStatusNotice(
  filesStatus: SyncDomainStatus,
  workspaces: [FilesWorkspace],
  needsRepairing: Bool,
  syncService: SyncService,
  reload: @escaping () async -> Void
) -> ADENoticeCard? {
  switch filesStatus.phase {
  case .disconnected:
    return ADENoticeCard(
      title: workspaces.isEmpty ? "Host disconnected" : "Showing cached workspaces",
      message: workspaces.isEmpty
        ? (syncService.activeHostProfile == nil
            ? "Pair with a host to hydrate the workspace list before browsing files."
            : "Reconnect to hydrate the workspace list before browsing files.")
        : (needsRepairing
            ? "Workspace names are cached locally, but the previous host trust was cleared. Pair again before trusting file state or write access."
            : "Workspace information is cached locally. Reconnect before editing, creating, or refreshing files."),
      icon: "icloud.slash",
      tint: ADEColor.warning,
      actionTitle: syncService.activeHostProfile == nil ? (needsRepairing ? "Pair again" : "Pair with host") : "Reconnect",
      action: {
        if syncService.activeHostProfile == nil {
          syncService.settingsPresented = true
        } else {
          Task {
            await syncService.reconnectIfPossible()
            await reload()
          }
        }
      }
    )
  case .hydrating:
    return ADENoticeCard(
      title: "Hydrating workspaces",
      message: "Files uses the lane graph for workspace roots. Waiting for the latest lane hydration from the host.",
      icon: "arrow.trianglehead.2.clockwise.rotate.90",
      tint: ADEColor.accent,
      actionTitle: nil,
      action: nil
    )
  case .syncingInitialData:
    return ADENoticeCard(
      title: "Syncing initial data",
      message: "Waiting for the host to finish syncing project and lane metadata before Files hydrates.",
      icon: "arrow.trianglehead.2.clockwise.rotate.90",
      tint: ADEColor.warning,
      actionTitle: nil,
      action: nil
    )
  case .failed:
    return ADENoticeCard(
      title: "Workspace hydration failed",
      message: filesStatus.lastError ?? "The lane graph did not hydrate, so Files cannot trust its workspace model yet.",
      icon: "exclamationmark.triangle.fill",
      tint: ADEColor.danger,
      actionTitle: "Retry",
      action: { Task { await reload() } }
    )
  case .ready:
    return nil
  }
}

// MARK: - View Extensions

extension View {
  func filesListRow() -> some View {
    listRowInsets(EdgeInsets(top: 0, leading: 0, bottom: 0, trailing: 0))
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
  }
}
