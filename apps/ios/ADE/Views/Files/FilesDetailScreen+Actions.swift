import SwiftUI
import UIKit

extension FilesDetailScreen {
  /// A projection bump re-reads the open file, but not within a few seconds
  /// of the last read: reading a file writes the phone's cache, and that write
  /// bumps the projection again, which re-read the file in a loop (a request
  /// every ~0.7s for as long as a file was open).
  @MainActor
  func refreshForFilesProjectionRevision(_ revision: Int) async {
    guard lastHandledFilesProjectionRevision != revision || blob == nil else { return }
    if blob != nil, Date().timeIntervalSince(lastFilesDetailReload) < filesDetailQuietInterval {
      lastHandledFilesProjectionRevision = revision
      return
    }
    if let delay = filesDetailRefreshDelay(
      hasLoadedBlob: blob != nil,
      elapsedSinceLastLoad: Date().timeIntervalSince(lastFilesDetailReload)
    ) {
      try? await Task.sleep(for: .milliseconds(max(1, Int(delay * 1_000))))
      guard !Task.isCancelled, syncService.filesProjectionRevision == revision else { return }
    }
    await load(refreshDiff: mode == .diff, preservesVisibleHistory: true)
    lastFilesDetailReload = Date()
    guard !Task.isCancelled else { return }
    lastHandledFilesProjectionRevision = syncService.filesProjectionRevision
  }

  @MainActor
  func load(refreshDiff: Bool = false, preservesVisibleHistory: Bool = false) async {
    var cachedImageBlob: SyncFileBlob?

    if filesIsImagePreviewable(path: relativePath, blob: blob ?? SyncFileBlob(path: relativePath, size: 0, encoding: "utf8", isBinary: true, content: "")),
       let cachedData = ADEImageCache.shared.cachedData(for: imageCacheKey) {
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
      if blob != loaded { blob = loaded }
      if filesIsImagePreviewable(path: relativePath, blob: loaded), let data = filesImageData(from: loaded) {
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
      clearDiffState()
      diffErrorMessage = nil
      hasLoadedDiff = true
      return
    }
    hasLoadedDiff = false
    do {
      let loaded = try await syncService.fetchFileDiff(workspaceId: workspace.id, laneId: laneId, path: relativePath, mode: diffMode.rawValue)
      diffRenderState = FilesDiffRenderState(diff: loaded)
      diffErrorMessage = nil
    } catch {
      clearDiffState()
      diffErrorMessage = error.localizedDescription
    }
    hasLoadedDiff = true
  }

  @MainActor
  private func clearDiffState() {
    diffRenderState = nil
  }

}

// MARK: - Viewer chrome

extension EnvironmentValues {
  /// Opens a file in the Files window's second editor group. Nil wherever
  /// there is no second group to open.
  @Entry var filesOpenToSide: ((String) -> Void)? = nil
}

/// What the wide Files window tells one editor group about its place. The
/// phone's viewer has none.
struct FilesDuoEditorChrome {
  /// Opens the same file in a second group; nil when one is already open.
  var onOpenToSide: (() -> Void)?
  /// Closes this group; nil for the only group.
  var onCloseGroup: (() -> Void)?
  /// Searches the workspace (the viewer is not a text view, so find in file
  /// is the workspace search).
  var onFind: () -> Void
  /// Shows or hides the file tree; nil while two groups hide it.
  var onToggleTree: (() -> Void)?
  var treeVisible: Bool
  /// This group's bar is the Duo's edge bar: the code runs under the rail's
  /// strip, stopping short of the rail.
  var runsUnderRail = false
  /// False for the left of two groups sharing one stack: its controls (close,
  /// changes, ⋯) move into its header capsule so they don't merge into the
  /// right group's bar.
  var declaresToolbar = true
}

extension FilesDetailScreen {
  /// The Changes toggle stays in its slot (the edge bar does not restore a
  /// removed item); greyed, its name says why.
  var changesButtonTitle: String {
    editorModes.count < 2 ? "No changes in this file" : "Changes"
  }

  /// "apps/ios/ADE/Views · Swift · 8 KB"
  var viewerSubtitle: String {
    var parts: [String] = []
    let folder = parentDirectory(of: relativePath)
    parts.append(folder.isEmpty ? workspace.name : folder)
    if let blob {
      parts.append(fileKindLabel(for: blob))
      parts.append(formattedFileSize(blob.size))
    }
    return parts.joined(separator: " · ")
  }

  /// The wide viewer's header: a slim floating glass capsule over the code
  /// with the file's glyph, name and folder. Tapping it lists the folders on
  /// the way to the file; picking one reveals it in the tree.
  @ViewBuilder
  var viewerHeader: some View {
    if let duoChrome, !duoChrome.declaresToolbar {
      HStack(spacing: 8) {
        viewerHeaderCapsule
        Spacer(minLength: 0)
        GlassEffectContainer(spacing: 8) {
          HStack(spacing: 4) {
            Button {
              mode = mode == .diff ? .preview : .diff
            } label: {
              Image(systemName: mode == .diff ? "plusminus.circle.fill" : "plusminus.circle")
                .frame(width: 34, height: 34)
            }
            .disabled(editorModes.count < 2)
            .accessibilityLabel(changesButtonTitle)
            Menu {
              viewerMenuContent(duoChrome)
            } label: {
              Image(systemName: "ellipsis")
                .frame(width: 34, height: 34)
            }
            .accessibilityLabel("More")
            if let onCloseGroup = duoChrome.onCloseGroup {
              Button(action: onCloseGroup) {
                Image(systemName: "xmark")
                  .frame(width: 34, height: 34)
              }
              .accessibilityLabel("Close Editor")
            }
          }
          .font(.system(size: 15, weight: .medium))
          .foregroundStyle(ADEColor.accent)
          .padding(.horizontal, 4)
          .glassEffect(.regular.interactive(), in: Capsule(style: .continuous))
        }
      }
    } else {
      viewerHeaderCapsule
    }
  }

  var viewerHeaderCapsule: some View {
    let folders = filesBreadcrumbItems(relativePath: parentDirectory(of: relativePath), includeCurrentFile: false)
    return Menu {
      Section("Reveal in Files") {
        Button(workspace.name, systemImage: "folder") { navigateToDirectory("") }
        ForEach(folders.reversed(), id: \.path) { folder in
          Button(folder.path, systemImage: "folder") { navigateToDirectory(folder.path) }
        }
      }
      Button("Copy Relative Path", systemImage: "doc.on.clipboard") {
        UIPasteboard.general.string = relativePath
      }
    } label: {
      HStack(spacing: 7) {
        Image(systemName: filesGlyph(for: relativePath))
          .font(.system(size: 12, weight: .medium))
          .foregroundStyle(ADEColor.textSecondary)
        Text(lastPathComponent(relativePath))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .layoutPriority(1)
        // The folder gives way first (from its start); kind and size stay.
        let folder = parentDirectory(of: relativePath)
        Text(folder.isEmpty ? workspace.name : folder)
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .truncationMode(.head)
        if let blob {
          Text("· \(fileKindLabel(for: blob)) · \(formattedFileSize(blob.size))")
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
            .lineLimit(1)
            .fixedSize()
        }
      }
      .padding(.horizontal, 14)
      .frame(height: 34)
      .glassEffect(.regular.interactive(), in: Capsule(style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(lastPathComponent(relativePath)), \(viewerSubtitle)")
    .accessibilityHint("Shows the folders on the way to this file")
  }

  /// The viewer's controls in fixed slots (the edge bar does not restore an
  /// item that leaves and comes back): the tree toggle, Search, Changes, and
  /// ⋯ for everything else. Held landscape on the Duo they are the rail's
  /// top; elsewhere the top bar.
  @ToolbarContentBuilder
  func viewerToolbar(_ chrome: FilesDuoEditorChrome?) -> some ToolbarContent {
    if chrome?.declaresToolbar != false {
      viewerToolbarItems(chrome)
    }
  }

  @ToolbarContentBuilder
  private func viewerToolbarItems(_ chrome: FilesDuoEditorChrome?) -> some ToolbarContent {
    if let chrome {
      // Each slot is fixed for the life of the stack: the window gives a
      // group a new stack whenever its role (and so this list) changes.
      if let onToggleTree = chrome.onToggleTree {
        ToolbarItem(placement: .topBarLeading) {
          Button(action: onToggleTree) {
            Label(chrome.treeVisible ? "Hide Files" : "Show Files", systemImage: "sidebar.left")
          }
        }
      }
      if let onCloseGroup = chrome.onCloseGroup {
        ToolbarItem(placement: .cancellationAction) {
          Button(action: onCloseGroup) {
            Label("Close Editor", systemImage: "xmark")
          }
        }
      }
      ToolbarItem(placement: .primaryAction) {
        Button(action: chrome.onFind) {
          Label("Search", systemImage: "magnifyingglass")
        }
      }
    }
    ToolbarItem(placement: .primaryAction) {
      Button {
        mode = mode == .diff ? .preview : .diff
      } label: {
        Label(changesButtonTitle, systemImage: mode == .diff ? "plusminus.circle.fill" : "plusminus.circle")
      }
      .disabled(editorModes.count < 2)
      .accessibilityValue(mode == .diff ? "On" : "Off")
    }
    ToolbarItem(placement: .primaryAction) {
      Menu {
        viewerMenuContent(chrome)
      } label: {
        Label("More", systemImage: "ellipsis")
      }
    }
  }

  /// Everything in ⋯: how the file reads, sharing, paths and details.
  @ViewBuilder
  func viewerMenuContent(_ chrome: FilesDuoEditorChrome?) -> some View {
    Section {
      if mode == .preview, isMarkdownFile {
        Picker("Markdown", selection: $markdownViewMode) {
          ForEach(FilesMarkdownViewMode.allCases) { option in
            Label(option.title, systemImage: option.systemImage).tag(option)
          }
        }
      }
      if let blob, showsCodeLayoutControl(blob: blob) {
        Toggle(isOn: Binding(
          get: { codeLayoutMode == .wrap },
          set: { codeLayoutMode = $0 ? .wrap : .scroll }
        )) {
          Label("Wrap Lines", systemImage: "text.alignleft")
        }
      }
      if mode == .diff, workspace.laneId != nil {
        Picker("Compare", selection: $diffMode) {
          ForEach(FilesDiffMode.allCases) { option in
            Label(option.title, systemImage: option.systemImage).tag(option)
          }
        }
      }
    }
    Section {
      if let onOpenToSide = chrome?.onOpenToSide {
        Button("Open to the Side", systemImage: "rectangle.split.2x1", action: onOpenToSide)
      }
      if let blob, !blob.isBinary {
        ShareLink(item: blob.content, subject: Text(lastPathComponent(relativePath))) {
          Label("Share", systemImage: "square.and.arrow.up")
        }
      }
      Button("Copy Relative Path", systemImage: "doc.on.clipboard") {
        UIPasteboard.general.string = relativePath
      }
      Button("Copy Full Path", systemImage: "doc.on.doc") {
        UIPasteboard.general.string = fullPath
      }
    }
    Button("Details", systemImage: "info.circle") {
      isDetailsSheetPresented = true
    }
    .disabled(blob == nil)
  }
}
