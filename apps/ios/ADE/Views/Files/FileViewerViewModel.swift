import Darwin
import SwiftUI

@Observable
class FileViewerViewModel {
  var blob: SyncFileBlob?
  var draftText = ""
  var errorMessage: String?
  var metadata: FilesFileMetadata?
  var gitState = FilesGitState.empty
  var mode: FilesEditorMode = .preview
  var diffMode: FilesDiffMode = .unstaged
  var diff: FileDiff?
  var diffErrorMessage: String?
  var saveTrigger = 0
  var pendingDestructiveConfirmation: FilesDestructiveConfirmation?
  var pendingNavigationTarget: EditorNavigationTarget?
  var showUnsavedChangesConfirmation = false
  var showInfoSheet = false
  var findQuery = ""
  var replaceQuery = ""
  var searchMatches: [NSRange] = []
  var selectedSearchMatchIndex: Int?
  var editorSelection = NSRange(location: 0, length: 0)

  func language(for relativePath: String) -> FilesLanguage {
    FilesLanguage.detect(languageId: blob?.languageId, filePath: relativePath)
  }

  func isImagePreviewable(relativePath: String) -> Bool {
    let lowercased = relativePath.lowercased()
    return ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff"].contains((lowercased as NSString).pathExtension)
  }

  func imageData(for relativePath: String) -> Data? {
    guard let blob, blob.isBinary, isImagePreviewable(relativePath: relativePath) else { return nil }

    let decodedData: Data?
    if blob.encoding.lowercased() == "base64" {
      decodedData = Data(base64Encoded: blob.content)
    } else {
      decodedData = Data(blob.content.utf8)
    }

    guard let decodedData, UIImage(data: decodedData) != nil else { return nil }
    return decodedData
  }

  func imageCacheKey(workspace: FilesWorkspace, relativePath: String) -> String {
    "files-preview::\(workspace.id)::\(relativePath)"
  }

  func canEdit(isFilesLive: Bool, workspace: FilesWorkspace) -> Bool {
    isFilesLive && !workspace.isReadOnlyByDefault && blob?.isBinary == false
  }

  var isDirty: Bool {
    guard let blob, !blob.isBinary else { return false }
    return draftText != blob.content
  }

  func editorModes(workspace: FilesWorkspace) -> [FilesEditorMode] {
    guard blob?.isBinary == false else { return [.preview] }
    if workspace.laneId != nil {
      return [.preview, .edit, .diff]
    }
    return [.preview, .edit]
  }

  func effectiveMode(workspace: FilesWorkspace) -> FilesEditorMode {
    let modes = editorModes(workspace: workspace)
    return modes.contains(mode) ? mode : .preview
  }

  var searchSummaryText: String {
    guard !searchMatches.isEmpty else {
      return findQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "Find text in this file." : "No matches."
    }
    let current = min((selectedSearchMatchIndex ?? 0) + 1, searchMatches.count)
    return "\(current) of \(searchMatches.count) matches"
  }

  @MainActor
  func load(
    syncService: SyncService,
    workspace: FilesWorkspace,
    relativePath: String,
    isFilesLive: Bool,
    refreshDiff: Bool = false
  ) async {
    let cacheKey = imageCacheKey(workspace: workspace, relativePath: relativePath)

    do {
      if isImagePreviewable(relativePath: relativePath),
         let cachedData = ADEImageCache.shared.cachedData(for: cacheKey) {
        if UIImage(data: cachedData) != nil {
          let cachedBlob = SyncFileBlob(
            path: relativePath,
            size: cachedData.count,
            mimeType: nil,
            encoding: "base64",
            isBinary: true,
            content: cachedData.base64EncodedString(),
            languageId: nil
          )
          blob = cachedBlob
          await loadGitState(syncService: syncService, workspace: workspace, isFilesLive: isFilesLive)
          await loadMetadata(syncService: syncService, workspace: workspace, relativePath: relativePath, from: cachedBlob, isFilesLive: isFilesLive)
          if refreshDiff {
            await loadDiff(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive)
          }
          errorMessage = nil
          return
        }
        ADEImageCache.shared.removeData(for: cacheKey)
      }

      let wasDirty = isDirty
      let loaded = try await syncService.readFile(workspaceId: workspace.id, path: relativePath)
      blob = loaded
      if loaded.isBinary, isImagePreviewable(relativePath: relativePath) {
        if let data = imageData(for: relativePath) {
          ADEImageCache.shared.store(data, for: cacheKey)
        } else {
          ADEImageCache.shared.removeData(for: cacheKey)
        }
      }
      if !loaded.isBinary && (!wasDirty || draftText.isEmpty) {
        draftText = loaded.content
      }
      refreshSearchMatches(preserving: editorSelection)
      await loadGitState(syncService: syncService, workspace: workspace, isFilesLive: isFilesLive)
      await loadMetadata(syncService: syncService, workspace: workspace, relativePath: relativePath, from: loaded, isFilesLive: isFilesLive)
      if refreshDiff {
        await loadDiff(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive)
      }
      errorMessage = nil
    } catch {
      if shouldClearLoadedFile(for: error) {
        blob = nil
        metadata = nil
        diff = nil
        diffErrorMessage = nil
      }
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func loadGitState(syncService: SyncService, workspace: FilesWorkspace, isFilesLive: Bool) async {
    guard let laneId = workspace.laneId, isFilesLive else { return }
    do {
      let changes = try await syncService.fetchLaneChanges(laneId: laneId)
      gitState = FilesGitState(
        staged: Set(changes.staged.map(\.path)),
        unstaged: Set(changes.unstaged.map(\.path))
      )
    } catch {
      // Preserve current git state if fetch fails.
    }
  }

  @MainActor
  func loadMetadata(
    syncService: SyncService,
    workspace: FilesWorkspace,
    relativePath: String,
    from blob: SyncFileBlob,
    isFilesLive: Bool
  ) async {
    let lang = language(for: relativePath)
    var lastCommitTitle: String?
    var lastCommitDateText: String?

    if let laneId = workspace.laneId, isFilesLive {
      do {
        if let commit = try await syncService.findLastCommitForFile(laneId: laneId, path: relativePath) {
          lastCommitTitle = commit.subject
          lastCommitDateText = relativeDateDescription(from: commit.authoredAt)
        }
      } catch {
        // Best-effort metadata.
      }
    }

    metadata = FilesFileMetadata(
      sizeText: formattedFileSize(blob.size),
      languageLabel: lang.displayName,
      lastCommitTitle: lastCommitTitle,
      lastCommitDateText: lastCommitDateText
    )
  }

  @MainActor
  func loadDiff(syncService: SyncService, workspace: FilesWorkspace, relativePath: String, isFilesLive: Bool) async {
    guard let laneId = workspace.laneId, isFilesLive else {
      diff = nil
      diffErrorMessage = nil
      return
    }
    do {
      diff = try await syncService.fetchFileDiff(laneId: laneId, path: relativePath, mode: diffMode.rawValue)
      diffErrorMessage = nil
    } catch {
      diffErrorMessage = error.localizedDescription
    }
  }

  @MainActor
  func save(syncService: SyncService, workspace: FilesWorkspace, relativePath: String, isFilesLive: Bool) async -> Bool {
    guard canEdit(isFilesLive: isFilesLive, workspace: workspace) else { return false }
    do {
      try await syncService.writeText(workspaceId: workspace.id, path: relativePath, text: draftText)
      saveTrigger += 1
      await load(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive, refreshDiff: mode == .diff)
      return true
    } catch {
      errorMessage = error.localizedDescription
      return false
    }
  }

  @MainActor
  func stageCurrentFile(laneId: String, syncService: SyncService, workspace: FilesWorkspace, relativePath: String, isFilesLive: Bool) async {
    do {
      try await syncService.stageFile(laneId: laneId, path: relativePath)
      await load(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive, refreshDiff: true)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func unstageCurrentFile(laneId: String, syncService: SyncService, workspace: FilesWorkspace, relativePath: String, isFilesLive: Bool) async {
    do {
      try await syncService.unstageFile(laneId: laneId, path: relativePath)
      await load(syncService: syncService, workspace: workspace, relativePath: relativePath, isFilesLive: isFilesLive, refreshDiff: true)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func attemptNavigation(_ target: EditorNavigationTarget, performNavigation: (EditorNavigationTarget) -> Void) {
    guard isDirty else {
      performNavigation(target)
      return
    }
    pendingNavigationTarget = target
    showUnsavedChangesConfirmation = true
  }

  func performPendingNavigation(performNavigation: (EditorNavigationTarget) -> Void) {
    if let target = pendingNavigationTarget {
      performNavigation(target)
      pendingNavigationTarget = nil
    }
    showUnsavedChangesConfirmation = false
  }

  func cancelPendingNavigation() {
    pendingNavigationTarget = nil
    showUnsavedChangesConfirmation = false
  }

  func updateDraftText(_ text: String) {
    guard draftText != text else { return }
    draftText = text
    refreshSearchMatches(preserving: editorSelection)
  }

  func updateEditorSelection(_ selection: NSRange) {
    guard editorSelection != selection else { return }
    editorSelection = selection
    if let matchIndex = fileViewerMatchIndex(containing: selection, in: searchMatches) {
      selectedSearchMatchIndex = matchIndex
    }
  }

  func updateSearchQuery(_ query: String) {
    guard findQuery != query else { return }
    findQuery = query
    refreshSearchMatches(preserving: editorSelection)
  }

  func refreshSearchMatches(preserving selection: NSRange? = nil) {
    searchMatches = fileViewerFindMatches(in: draftText, query: findQuery)
    guard !searchMatches.isEmpty else {
      selectedSearchMatchIndex = nil
      return
    }

    if let selection, let index = fileViewerMatchIndex(containing: selection, in: searchMatches) {
      selectedSearchMatchIndex = index
      editorSelection = searchMatches[index]
      return
    }

    if let selectedSearchMatchIndex, searchMatches.indices.contains(selectedSearchMatchIndex) {
      editorSelection = searchMatches[selectedSearchMatchIndex]
      return
    }

    selectedSearchMatchIndex = 0
    editorSelection = searchMatches[0]
  }

  func selectNextSearchMatch() {
    guard !searchMatches.isEmpty else { return }
    let nextIndex = ((selectedSearchMatchIndex ?? -1) + 1).modulo(searchMatches.count)
    selectedSearchMatchIndex = nextIndex
    editorSelection = searchMatches[nextIndex]
  }

  func selectPreviousSearchMatch() {
    guard !searchMatches.isEmpty else { return }
    let previousIndex = ((selectedSearchMatchIndex ?? 0) - 1).modulo(searchMatches.count)
    selectedSearchMatchIndex = previousIndex
    editorSelection = searchMatches[previousIndex]
  }

  func replaceCurrentMatch() {
    guard !findQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    let matchIndex = selectedSearchMatchIndex ?? 0
    guard let result = fileViewerReplaceCurrentMatch(
      in: draftText,
      query: findQuery,
      replacement: replaceQuery,
      matchIndex: matchIndex
    ) else { return }

    draftText = result.text
    editorSelection = result.selection
    refreshSearchMatches(preserving: result.selection)
    if let updatedIndex = fileViewerMatchIndex(containing: result.selection, in: searchMatches) {
      selectedSearchMatchIndex = updatedIndex
    }
  }

  func replaceAllMatches() {
    guard !findQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    let updatedText = fileViewerReplaceAllMatches(in: draftText, query: findQuery, replacement: replaceQuery)
    guard updatedText != draftText else { return }
    draftText = updatedText
    editorSelection = NSRange(location: 0, length: 0)
    refreshSearchMatches(preserving: editorSelection)
  }

  func clearTransientEditorState() {
    pendingDestructiveConfirmation = nil
    pendingNavigationTarget = nil
    showUnsavedChangesConfirmation = false
    showInfoSheet = false
  }

  private func shouldClearLoadedFile(for error: Error) -> Bool {
    if containsMissingFileError(error as NSError) {
      return true
    }

    let message = error.localizedDescription.lowercased()
    return [
      "not found",
      "no such file",
      "does not exist",
      "enoent",
      "missing file",
      "missing path",
    ].contains(where: { message.contains($0) })
  }

  private func containsMissingFileError(_ error: NSError) -> Bool {
    if error.domain == NSCocoaErrorDomain &&
       [NSFileNoSuchFileError, NSFileReadNoSuchFileError].contains(error.code) {
      return true
    }

    if error.domain == NSPOSIXErrorDomain && error.code == Int(ENOENT) {
      return true
    }

    if let underlyingError = error.userInfo[NSUnderlyingErrorKey] as? NSError {
      return containsMissingFileError(underlyingError)
    }

    return false
  }
}

private extension Int {
  func modulo(_ value: Int) -> Int {
    guard value > 0 else { return 0 }
    let remainder = self % value
    return remainder >= 0 ? remainder : remainder + value
  }
}
