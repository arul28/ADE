import SwiftUI

extension FilesDetailScreen {
  @MainActor
  func load(refreshDiff: Bool = false) async {
    do {
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
        blob = cachedBlob
        await loadGitState()
        await loadMetadata(from: cachedBlob)
        if refreshDiff {
          await loadDiff()
        }
        errorMessage = nil
        return
      }

      let wasDirty = isDirty
      let loaded = try await syncService.readFile(workspaceId: workspace.id, path: relativePath)
      blob = loaded
      if loaded.isBinary, isImagePreviewable, let data = imageData {
        ADEImageCache.shared.store(data, for: imageCacheKey)
      }
      if !loaded.isBinary && (!wasDirty || draftText.isEmpty) {
        draftText = loaded.content
      }
      await loadGitState()
      await loadMetadata(from: loaded)
      if refreshDiff {
        await loadDiff()
      }
      errorMessage = nil
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func loadGitState() async {
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
  func loadMetadata(from blob: SyncFileBlob) async {
    var lastCommitTitle: String?
    var lastCommitDateText: String?

    if let laneId = workspace.laneId {
      do {
        let entries = try await syncService.fetchFileHistory(workspaceId: workspace.id, laneId: laneId, path: relativePath, limit: 10)
        if let latest = entries.first {
          lastCommitTitle = latest.subject
          lastCommitDateText = relativeDateDescription(from: latest.authoredAt)
        }
      } catch {
        // Best-effort metadata.
      }
    }

    metadata = FilesFileMetadata(
      sizeText: formattedFileSize(blob.size),
      languageLabel: language.displayName,
      lastCommitTitle: lastCommitTitle,
      lastCommitDateText: lastCommitDateText
    )
  }

  @MainActor
  func loadDiff() async {
    guard let laneId = workspace.laneId else {
      diff = nil
      diffErrorMessage = nil
      return
    }
    do {
      diff = try await syncService.fetchFileDiff(workspaceId: workspace.id, laneId: laneId, path: relativePath, mode: diffMode.rawValue)
      diffErrorMessage = nil
    } catch {
      diffErrorMessage = error.localizedDescription
    }
  }

  @MainActor
  func save() async {
    guard canEdit else { return }
    do {
      try await syncService.writeText(workspaceId: workspace.id, path: relativePath, text: draftText)
      saveTrigger += 1
      await load(refreshDiff: mode == .diff)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func stageCurrentFile() async {
    guard let laneId = workspace.laneId else { return }
    do {
      try await syncService.stageFile(laneId: laneId, path: relativePath)
      await load(refreshDiff: true)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  @MainActor
  func unstageCurrentFile() async {
    guard let laneId = workspace.laneId else { return }
    do {
      try await syncService.unstageFile(laneId: laneId, path: relativePath)
      await load(refreshDiff: true)
    } catch {
      errorMessage = error.localizedDescription
    }
  }

  func attemptNavigation(_ target: EditorNavigationTarget) {
    guard isDirty else {
      performNavigation(target)
      return
    }
    pendingNavigationTarget = target
    pendingDestructiveConfirmation = FilesDestructiveConfirmation(kind: .discardUnsaved)
  }

  func performNavigationTarget() {
    if let target = pendingNavigationTarget {
      performNavigation(target)
      pendingNavigationTarget = nil
    }
  }

  func performNavigation(_ target: EditorNavigationTarget) {
    switch target {
    case .dismiss:
      dismiss()
    case .directory(let path):
      navigateToDirectory(path)
    }
  }

  var disconnectedNotice: ADENoticeCard {
    ADENoticeCard(
      title: "Read-only while disconnected",
      message: needsRepairing
        ? "Pair again before trusting file state or saving edits."
        : "The last-loaded file content stays visible, but editing and file operations are disabled until the host reconnects.",
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
}
