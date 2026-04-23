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

enum FilesCodeLayoutMode: String, CaseIterable, Identifiable {
  case wrap
  case scroll

  var id: String { rawValue }

  var title: String {
    switch self {
    case .wrap: return "Wrap"
    case .scroll: return "Scroll"
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

struct FilesPreviewLimit: Equatable {
  let title: String
  let message: String
}

private let filesTextPreviewByteLimit = 300 * 1024
private let filesTextPreviewLineLimit = 4_000
private let filesDiffPreviewByteLimit = 400 * 1024
private let filesDiffPreviewLineLimit = 6_000

func filesTextPreviewLimit(blob: SyncFileBlob) -> FilesPreviewLimit? {
  guard !blob.isBinary else { return nil }
  return filesTextLimit(
    byteCount: max(blob.size, blob.content.utf8.count),
    lineCount: filesEstimatedLineCount(blob.content),
    lineLimit: filesTextPreviewLineLimit,
    byteLimit: filesTextPreviewByteLimit,
    title: "Preview paused",
    action: "Use desktop ADE or narrow the file before previewing it on iPhone."
  )
}

func filesDiffPreviewLimit(diff: FileDiff) -> FilesPreviewLimit? {
  let combinedText = "\(diff.original.text)\n\(diff.modified.text)"
  return filesTextLimit(
    byteCount: combinedText.utf8.count,
    lineCount: filesEstimatedLineCount(combinedText),
    lineLimit: filesDiffPreviewLineLimit,
    byteLimit: filesDiffPreviewByteLimit,
    title: "Diff preview paused",
    action: "Open the file on desktop or inspect a smaller diff before rendering it on iPhone."
  )
}

func filesDiffHasChanges(_ diff: FileDiff) -> Bool {
  diff.original.exists != diff.modified.exists || diff.original.text != diff.modified.text
}

private func filesTextLimit(byteCount: Int, lineCount: Int, lineLimit: Int, byteLimit: Int, title: String, action: String) -> FilesPreviewLimit? {
  if lineCount > lineLimit {
    return FilesPreviewLimit(
      title: title,
      message: "This content has \(lineCount) lines. \(action)"
    )
  }

  if byteCount > byteLimit {
    return FilesPreviewLimit(
      title: title,
      message: "This content is \(formattedFileSize(byteCount)). \(action)"
    )
  }

  return nil
}

private func filesEstimatedLineCount(_ text: String) -> Int {
  guard !text.isEmpty else { return 0 }
  return text.reduce(1) { count, character in
    character == "\n" ? count + 1 : count
  }
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
