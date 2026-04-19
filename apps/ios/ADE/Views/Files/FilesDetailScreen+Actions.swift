import SwiftUI

extension FilesDetailScreen {
  @MainActor
  func load(refreshDiff: Bool = false) async {
    var cachedImageBlob: SyncFileBlob?

    if isImagePreviewable, let cachedData = ADEImageCache.shared.cachedData(for: imageCacheKey) {
      let cachedBlob = SyncFileBlob(
        path: relativePath,
        size: cachedData.count,
        mimeType: nil,
        encoding: "base64",
        isBinary: true,
        content: cachedData.base64EncodedString(),
        languageId: nil
      )
      cachedImageBlob = cachedBlob
      blob = cachedBlob
      await loadHistoryAndMetadata(from: cachedBlob)
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
      await loadHistoryAndMetadata(from: loaded)
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
  func loadHistoryAndMetadata(from blob: SyncFileBlob) async {
    hasLoadedHistory = false
    historyErrorMessage = nil
    historyEntries = []

    if let laneId = workspace.laneId {
      do {
        historyEntries = try await syncService.fetchFileHistory(workspaceId: workspace.id, laneId: laneId, path: relativePath, limit: 10)
      } catch {
        historyErrorMessage = error.localizedDescription
      }
    }

    let latest = historyEntries.first
    metadata = FilesFileMetadata(
      sizeText: formattedFileSize(blob.size),
      languageLabel: language.displayName,
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
