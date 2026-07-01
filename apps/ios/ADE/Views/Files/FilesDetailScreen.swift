import SwiftUI
import UIKit

struct FilesDetailScreen: View {
  @EnvironmentObject var syncService: SyncService

  let workspace: FilesWorkspace
  let relativePath: String
  let focusLine: Int?
  let transitionNamespace: Namespace.ID?
  let navigateToDirectory: (String) -> Void

  @State var blob: SyncFileBlob?
  @State var errorMessage: String?
  @State var metadata: FilesFileMetadata?
  @State var mode: FilesEditorMode = .preview
  @State var markdownViewMode: FilesMarkdownViewMode = .preview
  @State var diffMode: FilesDiffMode = .unstaged
  @State var diffRenderState: FilesDiffRenderState?
  @State var diffErrorMessage: String?
  @State var historyEntries: [GitFileHistoryEntry] = []
  @State var historyErrorMessage: String?
  @State var hasLoadedHistory = false
  @State var hasLoadedDiff = false
  @State var isDetailsSheetPresented = false
  @State var codeLayoutMode: FilesCodeLayoutMode = .wrap
  @State var lastHandledFilesProjectionRevision: Int?
  @State var lastFilesDetailReload = Date.distantPast

  var language: FilesLanguage {
    FilesLanguage.detect(languageId: blob?.languageId, filePath: relativePath)
  }

  var isImagePreviewable: Bool {
    filesIsImagePreviewable(
      path: relativePath,
      blob: blob ?? SyncFileBlob(path: relativePath, size: 0, encoding: "utf8", isBinary: false, content: "")
    )
  }

  var imageData: Data? {
    guard let blob else { return nil }
    return filesImageData(from: blob)
  }

  var imageCacheKey: String {
    "files-preview::\(workspace.id)::\(relativePath)"
  }

  var editorModes: [FilesEditorMode] {
    filesEditorModes(laneId: workspace.laneId)
  }

  var historyFallback: FilesSectionFallback? {
    filesHistoryFallback(laneId: workspace.laneId, entries: historyEntries, errorMessage: historyErrorMessage)
  }

  var isMarkdownFile: Bool {
    guard let blob else { return false }
    return filesIsMarkdown(blob: blob, path: relativePath)
  }

  var fullPath: String {
    filesFullPath(rootPath: workspace.rootPath, relativePath: relativePath)
  }

  var body: some View {
    Group {
      if let blob {
        filesContentHero(blob: blob)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
      } else if errorMessage == nil {
        ADECardSkeleton(rows: 4)
          .padding(16)
        Spacer(minLength: 0)
      } else {
        Spacer(minLength: 0)
      }
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .adeRootTabBarHidden()
    .navigationTitle(lastPathComponent(relativePath))
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItemGroup(placement: .topBarTrailing) {
        Menu {
          Button("Copy Full Path") {
            UIPasteboard.general.string = fullPath
          }

          Button("Copy Relative Path") {
            UIPasteboard.general.string = relativePath
          }
        } label: {
          Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("File actions")

        Button {
          isDetailsSheetPresented = true
        } label: {
          Image(systemName: "info.circle")
        }
        .accessibilityLabel("File details")
        .disabled(blob == nil)
      }
    }
    .safeAreaInset(edge: .top, spacing: 0) {
      VStack(alignment: .leading, spacing: 6) {
        FilesBreadcrumbBar(
          relativePath: relativePath,
          includeCurrentFile: true,
          onSelectDirectory: { path in
            if path.isEmpty {
              navigateToDirectory("")
            } else {
              navigateToDirectory(path)
            }
          }
        )
        .padding(.horizontal, 16)

        if let blob {
          FilesViewerControlStrip(
            editorModes: editorModes,
            mode: $mode,
            showsMarkdownToggle: mode == .preview && isMarkdownFile,
            markdownViewMode: $markdownViewMode,
            showsLayoutToggle: showsCodeLayoutControl(blob: blob),
            codeLayoutMode: $codeLayoutMode,
            showsDiffScopeToggle: mode == .diff && workspace.laneId != nil,
            diffMode: $diffMode
          )
        }

        if let errorMessage {
          FilesCompactBanner(
            symbol: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            title: errorMessage,
            actionTitle: "Retry",
            onAction: { Task { await load() } }
          )
          .padding(.horizontal, 16)
        }
      }
      .padding(.top, 4)
      .padding(.bottom, 6)
      .background(ADEColor.pageBackground.opacity(0.94))
    }
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : filesTransitionId(kind: "container", workspaceId: workspace.id, path: relativePath), in: transitionNamespace)
    .sheet(isPresented: $isDetailsSheetPresented) {
      FilesDetailsSheet(
        relativePath: relativePath,
        fullPath: fullPath,
        blob: blob,
        metadata: metadata,
        language: language,
        historyEntries: historyEntries,
        historyFallback: historyFallback,
        hasLoadedHistory: hasLoadedHistory,
        isLaneBacked: workspace.laneId != nil
      )
      .presentationDetents([.medium, .large])
      .presentationDragIndicator(.visible)
      .environmentObject(syncService)
    }
    .task(id: syncService.filesProjectionRevision) {
      await refreshForFilesProjectionRevision(syncService.filesProjectionRevision)
    }
    .task(id: mode) {
      if mode == .diff {
        await loadDiff()
      }
    }
    .task(id: diffMode) {
      if mode == .diff {
        await loadDiff()
      }
    }
  }

  private func showsCodeLayoutControl(blob: SyncFileBlob) -> Bool {
    switch mode {
    case .preview:
      if isMarkdownFile {
        return markdownViewMode == .source
      }
      return !blob.isBinary && !filesIsMarkdown(blob: blob, path: relativePath)
    case .diff:
      return workspace.laneId != nil
    }
  }

  func fileKindLabel(for blob: SyncFileBlob) -> String {
    if filesIsImagePreviewable(path: relativePath, blob: blob) {
      return "Image"
    }
    if let binaryKind = filesBinaryKind(path: relativePath, mimeType: blob.mimeType) {
      return binaryKind.label
    }
    if blob.isBinary {
      return "Binary"
    }
    return language.displayName
  }

  @ViewBuilder
  private func filesContentHero(blob: SyncFileBlob) -> some View {
    switch mode {
    case .preview:
      filesPreviewContent(blob: blob)
    case .diff:
      filesDiffContent(blob: blob)
    }
  }

  @ViewBuilder
  private func filesPreviewContent(blob: SyncFileBlob) -> some View {
    if let limit = filesOmittedPreviewLimit(blob: blob) {
      FilesContentFallback(
        symbol: "doc.text.magnifyingglass",
        title: limit.title,
        message: limit.message
      )
      .padding(16)
    } else if blob.isBinary || filesIsImagePreviewable(path: relativePath, blob: blob) {
      if isImagePreviewable, let data = imageData, let image = UIImage(data: data) {
        ZoomableImageView(image: image, fillsContainer: true)
      } else if isImagePreviewable {
        FilesContentFallback(
          symbol: "photo",
          title: "Image preview pending",
          message: "The machine returned metadata only. Reconnect to stream the full bytes."
        )
        .padding(16)
      } else {
        let binaryKind = filesBinaryKind(path: relativePath, mimeType: blob.mimeType)
        FilesContentFallback(
          symbol: binaryKind?.symbol ?? "doc.fill",
          title: binaryKind.map { "\($0.label) file" } ?? "Binary file",
          message: "iPhone cannot preview this binary inline. Use ADE on the machine to preview it or open it with a local tool."
        )
        .padding(16)
      }
    } else {
      if let limit = filesTextPreviewLimit(blob: blob) {
        FilesContentFallback(
          symbol: "doc.text.magnifyingglass",
          title: limit.title,
          message: limit.message
        )
        .padding(16)
      } else if filesIsMarkdown(blob: blob, path: relativePath) {
        if markdownViewMode == .source {
          SyntaxHighlightedCodeView(
            text: blob.content,
            language: .markdown,
            focusLine: focusLine,
            layoutMode: codeLayoutMode,
            fillsContainer: true
          )
        } else {
          FilesMarkdownPreview(text: filesStripYamlFrontmatter(blob.content), fillsContainer: true)
        }
      } else {
        SyntaxHighlightedCodeView(
          text: blob.content,
          language: language,
          focusLine: focusLine,
          layoutMode: codeLayoutMode,
          fillsContainer: true
        )
      }
    }
  }

  @ViewBuilder
  private func filesDiffContent(blob _: SyncFileBlob) -> some View {
    if workspace.laneId == nil {
      FilesContentFallback(
        symbol: "arrow.left.arrow.right",
        title: "Diff needs a lane",
        message: "Open this file from a lane-backed workspace to compare working tree or staged changes."
      )
      .padding(16)
    } else if !hasLoadedDiff, diffErrorMessage == nil {
      ADECardSkeleton(rows: 5)
        .padding(16)
    } else if let diffErrorMessage {
      FilesCompactBanner(
        symbol: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        title: diffErrorMessage,
        actionTitle: "Retry",
        onAction: { Task { await loadDiff() } }
      )
      .padding(16)
    } else if let diffRenderState, diffRenderState.diff.isBinary == true {
      FilesContentFallback(
        symbol: "doc.badge.gearshape",
        title: "Binary diff",
        message: "The machine reported a binary diff that cannot be rendered inline."
      )
      .padding(16)
    } else if let diffRenderState, !diffRenderState.hasVisibleChanges {
      FilesContentFallback(
        symbol: "checkmark.circle",
        title: "No \(diffMode.title.lowercased()) changes",
        message: "This file matches the selected \(diffMode.title.lowercased()) diff scope."
      )
      .padding(16)
    } else if let diffRenderState, let limit = diffRenderState.previewLimit {
      FilesContentFallback(
        symbol: "arrow.left.arrow.right",
        title: limit.title,
        message: limit.message
      )
      .padding(16)
    } else if let diffRenderState {
      FilesInlineDiffView(
        lines: diffRenderState.inlineLines,
        language: FilesLanguage.detect(languageId: diffRenderState.diff.language, filePath: relativePath),
        layoutMode: codeLayoutMode,
        fillsContainer: true
      )
    } else {
      FilesContentFallback(
        symbol: "arrow.left.arrow.right",
        title: "No diff available",
        message: "Nothing cached for \(diffMode.title.lowercased()) diff. Reconnect or refresh to try again."
      )
      .padding(16)
    }
  }
}
