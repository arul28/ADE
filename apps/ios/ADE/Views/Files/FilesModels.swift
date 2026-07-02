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

struct FilesBreadcrumbItem: Equatable {
  let label: String
  let path: String
  let isDirectory: Bool
}

func filesTransitionId(kind: String, workspaceId: String, path: String) -> String {
  "files-\(kind)-\(workspaceId)::\(path)"
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

  var systemImage: String {
    switch self {
    case .preview: return "doc.text"
    case .diff: return "arrow.left.arrow.right"
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

  var systemImage: String {
    switch self {
    case .wrap: return "text.alignleft"
    case .scroll: return "arrow.left.and.right"
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
      message: "The machine did not return recent commits for this file yet. Reconnect or refresh to try again."
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

  var systemImage: String {
    switch self {
    case .unstaged: return "pencil.and.outline"
    case .staged: return "tray.and.arrow.down"
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

struct FilesDiffRenderState {
  let diff: FileDiff
  let hasVisibleChanges: Bool
  let previewLimit: FilesPreviewLimit?
  let inlineLines: [FilesInlineDiffLine]

  init(diff: FileDiff) {
    let hasVisibleChanges = filesDiffHasChanges(diff)
    let previewLimit = filesDiffPreviewLimit(diff: diff)

    self.diff = diff
    self.hasVisibleChanges = hasVisibleChanges
    self.previewLimit = previewLimit
    self.inlineLines = diff.isBinary == true || !hasVisibleChanges || previewLimit != nil
      ? []
      : buildInlineDiffLines(original: diff.original.text, modified: diff.modified.text)
  }
}

let filesDetailRefreshMinimumInterval: TimeInterval = 0.75

func filesDetailRefreshDelay(
  hasLoadedBlob: Bool,
  elapsedSinceLastLoad: TimeInterval,
  minimumInterval: TimeInterval = filesDetailRefreshMinimumInterval
) -> TimeInterval? {
  guard hasLoadedBlob, elapsedSinceLastLoad < minimumInterval else { return nil }
  return max(0, minimumInterval - elapsedSinceLastLoad)
}

private let filesTextPreviewByteLimit = 300 * 1024
private let filesTextPreviewLineLimit = 4_000
private let filesDiffPreviewByteLimit = 400 * 1024
private let filesDiffPreviewLineLimit = 6_000
private let filesDiffPreviewLinePairLimit = 1_500_000

func filesTextPreviewLimit(blob: SyncFileBlob) -> FilesPreviewLimit? {
  guard !blob.isBinary else { return nil }
  return filesTextLimit(
    byteCount: max(blob.size, blob.content.utf8.count),
    lineCount: filesEstimatedLineCount(blob.content),
    lineLimit: filesTextPreviewLineLimit,
    byteLimit: filesTextPreviewByteLimit,
    title: "Preview paused",
    action: "Use ADE on your machine or narrow the file before previewing it on iPhone."
  )
}

func filesOmittedPreviewLimit(blob: SyncFileBlob) -> FilesPreviewLimit? {
  guard blob.contentOmitted == true else { return nil }
  let title = blob.omittedReason == "too_large" ? "Preview paused" : "Preview unavailable"
  let message: String
  if blob.omittedReason == "too_large" {
    message = "This content is \(formattedFileSize(blob.size)). Open it from ADE on your machine to inspect the full file."
  } else {
    message = "The machine marked this file as unsupported for inline mobile preview. Open it from ADE on your machine."
  }
  return FilesPreviewLimit(title: title, message: message)
}

func filesIsMarkdown(blob: SyncFileBlob, path: String) -> Bool {
  let ext = (path.lowercased() as NSString).pathExtension
  if ["md", "markdown", "mdx"].contains(ext) { return true }
  if blob.mimeType?.lowercased() == "text/markdown" { return true }
  return blob.languageId?.lowercased() == "markdown"
}

private let filesImageExtensions: Set<String> = [
  "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff", "ico", "avif", "svg",
]
private let filesAudioExtensions: Set<String> = [
  "aac", "flac", "m4a", "mp3", "oga", "ogg", "opus", "wav",
]
private let filesVideoExtensions: Set<String> = [
  "avi", "m4v", "mkv", "mov", "mp4", "ogv", "webm",
]
private let filesDocumentExtensions: Set<String> = [
  "pdf", "doc", "docx", "ppt", "pptx", "xls", "xlsx",
]

func filesIsImagePreviewable(path: String, blob: SyncFileBlob) -> Bool {
  let ext = (path.lowercased() as NSString).pathExtension
  if blob.previewKind?.lowercased() == "image" { return true }
  return filesImageExtensions.contains(ext)
}

func filesBinaryKind(path: String, mimeType: String?) -> (label: String, symbol: String)? {
  let ext = (path.lowercased() as NSString).pathExtension
  let mime = mimeType?.lowercased() ?? ""
  if mime.hasPrefix("audio/") || filesAudioExtensions.contains(ext) {
    return ("Audio", "waveform")
  }
  if mime.hasPrefix("video/") || filesVideoExtensions.contains(ext) {
    return ("Video", "play.rectangle")
  }
  if filesDocumentExtensions.contains(ext) {
    return ("Document", "doc.richtext")
  }
  return nil
}

func filesStripYamlFrontmatter(_ text: String) -> String {
  let normalized = text.replacingOccurrences(of: "\r\n", with: "\n")
  guard normalized.hasPrefix("---\n") else { return text }
  let searchStart = normalized.index(normalized.startIndex, offsetBy: 4)
  guard searchStart < normalized.endIndex,
        let endRange = normalized.range(of: "\n---\n", range: searchStart..<normalized.endIndex)
  else {
    return text
  }
  return String(normalized[endRange.upperBound...])
}

func filesImageData(from blob: SyncFileBlob) -> Data? {
  if let dataUrl = blob.dataUrl, let comma = dataUrl.firstIndex(of: ",") {
    let base64 = String(dataUrl[dataUrl.index(after: comma)...])
    return Data(base64Encoded: base64)
  }
  if blob.encoding.lowercased() == "base64" {
    return Data(base64Encoded: blob.content)
  }
  return Data(blob.content.utf8)
}

enum FilesMarkdownViewMode: String, CaseIterable, Identifiable {
  case preview
  case source

  var id: String { rawValue }

  var title: String {
    switch self {
    case .preview: return "Rendered"
    case .source: return "Source"
    }
  }

  var systemImage: String {
    switch self {
    case .preview: return "text.document"
    case .source: return "chevron.left.forwardslash.chevron.right"
    }
  }
}

func filesDiffPreviewLimit(diff: FileDiff) -> FilesPreviewLimit? {
  if diff.original.isTruncated == true || diff.modified.isTruncated == true {
    return FilesPreviewLimit(
      title: "Diff preview paused",
      message: "This diff is too large to compare fully on iPhone. Open the file from ADE on your machine or inspect a smaller diff before rendering it on iPhone."
    )
  }

  let originalLineCount = filesEstimatedLineCount(diff.original.text)
  let modifiedLineCount = filesEstimatedLineCount(diff.modified.text)
  if filesLinePairCountExceedsLimit(originalLineCount: originalLineCount, modifiedLineCount: modifiedLineCount) {
    return FilesPreviewLimit(
      title: "Diff preview paused",
      message: "This diff compares \(originalLineCount) original lines against \(modifiedLineCount) modified lines. Open the file from ADE on your machine or inspect a smaller diff before rendering it on iPhone."
    )
  }

  let combinedText = "\(diff.original.text)\n\(diff.modified.text)"
  return filesTextLimit(
    byteCount: combinedText.utf8.count,
    lineCount: originalLineCount + modifiedLineCount,
    lineLimit: filesDiffPreviewLineLimit,
    byteLimit: filesDiffPreviewByteLimit,
    title: "Diff preview paused",
    action: "Open the file from ADE on your machine or inspect a smaller diff before rendering it on iPhone."
  )
}

func filesDiffHasChanges(_ diff: FileDiff) -> Bool {
  if diff.original.exists != diff.modified.exists || diff.original.text != diff.modified.text {
    return true
  }
  if let originalSize = diff.original.size, let modifiedSize = diff.modified.size, originalSize != modifiedSize {
    return true
  }
  return diff.original.isTruncated == true || diff.modified.isTruncated == true
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

private func filesLinePairCountExceedsLimit(originalLineCount: Int, modifiedLineCount: Int, limit: Int = filesDiffPreviewLinePairLimit) -> Bool {
  guard originalLineCount > 0, modifiedLineCount > 0 else { return false }
  return originalLineCount > limit / modifiedLineCount
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

/// Copy for the unified file-search prompt / unavailable states. The new search
/// page searches file names and contents together, so the message no longer
/// branches on a search "kind" — it only reflects connection state. (No-match
/// copy is rendered inline by the search page with the active query.)
func filesSearchEmptyMessage(isLive: Bool, needsRepairing: Bool) -> String {
  if !isLive {
    return needsRepairing
      ? "Pair again before searching files."
      : "File search needs a live machine connection."
  }
  return "Matches file names and contents — tap a line to jump straight to it."
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
