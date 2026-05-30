import SwiftUI

extension FilesDetailScreen {
  @MainActor
  func refreshForLocalStateRevision(_ revision: Int) async {
    guard lastHandledFilesDetailRevision != revision || blob == nil else { return }
    let now = Date()
    if let delay = filesDetailRefreshDelay(
      hasLoadedBlob: blob != nil,
      elapsedSinceLastLoad: now.timeIntervalSince(lastFilesDetailReload)
    ) {
      try? await Task.sleep(for: .milliseconds(max(1, Int(delay * 1_000))))
      guard !Task.isCancelled, syncService.localStateRevision == revision else { return }
    }
    lastFilesDetailReload = Date()
    await load(refreshDiff: mode == .diff, preservesVisibleHistory: true)
    guard !Task.isCancelled, syncService.localStateRevision == revision else { return }
    lastHandledFilesDetailRevision = revision
  }

  @MainActor
  func load(refreshDiff: Bool = false, preservesVisibleHistory: Bool = false) async {
    var cachedImageBlob: SyncFileBlob?

    if isImagePreviewable, let cachedData = ADEImageCache.shared.cachedData(for: imageCacheKey) {
      let cachedBlob = SyncFileBlob(
        path: relativePath,
        size: cachedData.count,
        mimeType: nil,
        encoding: "base64",
        isBinary: true,
        content: cachedData.base64EncodedString(),
        languageId: nil,
        previewKind: "image"
      )
      cachedImageBlob = cachedBlob
      blob = cachedBlob
      await loadHistoryAndMetadata(from: cachedBlob, preservesVisibleHistory: preservesVisibleHistory)
      if refreshDiff {
        await loadDiff()
      }
      errorMessage = nil
    }

    do {
      let loaded = try await syncService.readFile(workspaceId: workspace.id, path: relativePath)
      blob = loaded
      if loaded.isBinary, isImagePreviewable, let data = imageData {
        ADEImageCache.shared.store(data, for: imageCacheKey)
      }
      await loadHistoryAndMetadata(from: loaded, preservesVisibleHistory: preservesVisibleHistory)
      if refreshDiff {
        await loadDiff()
      }
      errorMessage = nil
    } catch {
      guard cachedImageBlob == nil else {
        errorMessage = error.localizedDescription
        return
      }
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func loadHistoryAndMetadata(from blob: SyncFileBlob, preservesVisibleHistory: Bool = false) async {
    let shouldPreserveHistory = preservesVisibleHistory && hasLoadedHistory
    if !shouldPreserveHistory {
      hasLoadedHistory = false
      historyErrorMessage = nil
      historyEntries = []
    }

    var nextEntries: [GitFileHistoryEntry] = []
    var nextErrorMessage: String?
    if let laneId = workspace.laneId {
      do {
        nextEntries = try await syncService.fetchFileHistory(workspaceId: workspace.id, laneId: laneId, path: relativePath, limit: 10)
      } catch {
        nextErrorMessage = error.localizedDescription
      }
    }

    if nextErrorMessage == nil || !shouldPreserveHistory {
      historyEntries = nextEntries
      historyErrorMessage = nextErrorMessage
    }

    let latest = (nextErrorMessage == nil ? nextEntries.first : nil) ?? historyEntries.first
    metadata = FilesFileMetadata(
      sizeText: formattedFileSize(blob.size),
      languageLabel: fileKindLabel(for: blob),
      lastCommitTitle: latest?.subject,
      lastCommitDateText: relativeDateDescription(from: latest?.authoredAt)
    )
    hasLoadedHistory = true
  }

  @MainActor
  func loadDiff() async {
    guard let laneId = workspace.laneId else {
      diff = nil
      diffErrorMessage = nil
      hasLoadedDiff = true
      return
    }
    hasLoadedDiff = false
    do {
      diff = try await syncService.fetchFileDiff(workspaceId: workspace.id, laneId: laneId, path: relativePath, mode: diffMode.rawValue)
      diffErrorMessage = nil
    } catch {
      diff = nil
      diffErrorMessage = error.localizedDescription
    }
    hasLoadedDiff = true
  }

}
