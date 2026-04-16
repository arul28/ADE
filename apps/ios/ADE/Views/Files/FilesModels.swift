import Foundation

enum FilesRoute: Hashable {
  case directory(workspaceId: String, parentPath: String)
  case editor(workspaceId: String, relativePath: String, focusLine: Int?)
}

struct FilesSearchKey: Hashable {
  let workspaceId: String?
  let query: String
  let isLive: Bool
}

enum FilesSearchKind {
  case quickOpen
  case textSearch
}

struct FilesBrowserStatusPresentation: Equatable {
  let title: String
  let message: String
  let actionTitle: String?
}

struct FilesBreadcrumbItem: Equatable {
  let label: String
  let path: String
  let isDirectory: Bool
}

enum FilesEditorMode: String, CaseIterable, Identifiable {
  case preview
  case diff

  var id: String { rawValue }

  var title: String {
    switch self {
    case .preview: return "Preview"
    case .diff: return "Diff"
    }
  }
}

struct FilesSectionFallback: Equatable {
  let title: String
  let message: String
}

func filesEditorModes(laneId: String?) -> [FilesEditorMode] {
  laneId == nil ? [.preview] : [.preview, .diff]
}

func filesHistoryFallback(
  laneId: String?,
  entries: [GitFileHistoryEntry],
  errorMessage: String?
) -> FilesSectionFallback? {
  if let errorMessage, !errorMessage.isEmpty {
    return FilesSectionFallback(title: "History unavailable", message: errorMessage)
  }
  if laneId == nil {
    return FilesSectionFallback(
      title: "History unavailable",
      message: "This workspace is not lane-backed, so Files can only show the current preview and metadata on iPhone."
    )
  }
  if entries.isEmpty {
    return FilesSectionFallback(
      title: "No recent history",
      message: "The host did not return recent commits for this file yet. Reconnect or refresh to try again."
    )
  }
  return nil
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

struct FilesFileMetadata {
  let sizeText: String
  let languageLabel: String
  let lastCommitTitle: String?
  let lastCommitDateText: String?
}

func resolveFilesWorkspace(for request: FilesNavigationRequest, in workspaces: [FilesWorkspace]) -> FilesWorkspace? {
  if let exact = workspaces.first(where: { $0.id == request.workspaceId }) {
    return exact
  }
  if let laneId = request.laneId {
    return workspaces.first(where: { $0.laneId == laneId })
  }
  return nil
}

func filesBrowserStatusPresentation(
  status: SyncDomainStatus,
  hasCachedWorkspaces: Bool,
  hasActiveHostProfile: Bool,
  needsRepairing: Bool
) -> FilesBrowserStatusPresentation? {
  switch status.phase {
  case .disconnected:
    if hasCachedWorkspaces {
      return FilesBrowserStatusPresentation(
        title: "Showing cached workspaces",
        message: needsRepairing
          ? "Workspace metadata and cached directory snapshots are still visible, but you need to pair again before trusting the host or refreshing Files."
          : "Workspace metadata and cached directory snapshots stay visible on iPhone, but quick open, text search, and refresh need the host to reconnect.",
        actionTitle: hasActiveHostProfile ? "Reconnect" : "Open Settings"
      )
    }

    return FilesBrowserStatusPresentation(
      title: "Host disconnected",
      message: hasActiveHostProfile
        ? "Reconnect to hydrate workspace roots, browse live directories, and run quick open or text search from Files."
        : (needsRepairing
            ? "The previous pairing was cleared. Open Settings to pair again before Files can trust or hydrate workspace data."
            : "Pair with a host from Settings to hydrate workspace roots before browsing files on iPhone."),
      actionTitle: hasActiveHostProfile ? "Reconnect" : "Open Settings"
    )
  case .hydrating:
    return FilesBrowserStatusPresentation(
      title: "Hydrating workspaces",
      message: "Files uses lane hydration for workspace roots. Waiting for the latest host lane data before browsing continues.",
      actionTitle: nil
    )
  case .syncingInitialData:
    return FilesBrowserStatusPresentation(
      title: "Syncing initial data",
      message: "Waiting for the host to finish syncing project and lane metadata before Files loads the workspace browser.",
      actionTitle: nil
    )
  case .failed:
    return FilesBrowserStatusPresentation(
      title: "Workspace hydration failed",
      message: status.lastError ?? "The lane graph did not hydrate, so Files cannot trust its workspace model yet.",
      actionTitle: "Retry"
    )
  case .ready:
    return nil
  }
}

func filesSearchEmptyMessage(kind: FilesSearchKind, isLive: Bool, needsRepairing: Bool, query: String) -> String {
  let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
  let label: String = switch kind {
  case .quickOpen:
    "Quick open"
  case .textSearch:
    "Workspace search"
  }

  if !isLive {
    return needsRepairing
      ? "Pair again before using \(label.lowercased())."
      : "\(label) needs a live host connection."
  }
  if trimmed.isEmpty {
    switch kind {
    case .quickOpen:
      return "Type a filename or path to fuzzy-search the selected workspace."
    case .textSearch:
      return "Search the selected workspace and preview matching lines before opening a file."
    }
  }
  return "No matches found."
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
