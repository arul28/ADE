import SwiftUI
import UIKit

struct FilesDetailScreen: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  var syncService: SyncService { syncPublishes.service }
  /// Held landscape on a phone (the Duo's closed display included) the
  /// rail has little height: Changes moves into ⋯ so the tabs keep room.
  @Environment(\.verticalSizeClass) var verticalSizeClass
  @Environment(\.dismiss) var dismissViewer

  let workspace: FilesWorkspace
  let relativePath: String
  let focusLine: Int?
  let transitionNamespace: Namespace.ID?
  let navigateToDirectory: (String) -> Void
  /// Set by the Duo's Files window: the viewer's controls move into the system
  /// toolbar (the edge bar held landscape) and the breadcrumb becomes the
  /// subtitle. Nil keeps the phone's in-content strip.
  var duoChrome: FilesDuoEditorChrome? = nil

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
  /// The trailing safe area the edge bar reserves (wide, held landscape).
  @State var railInset: CGFloat = 0

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

  /// Under the Duo's edge bar the code reaches the screen edge and stops
  /// short of the rail by the bar's own width.
  private var trailingMargin: CGFloat? {
    guard duoChrome?.runsUnderRail == true else { return nil }
    return railInset
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
    .adeAnalyticsScreen(.fileDetail)
    // The file's name is the floating capsule over the code on every
    // display (the wide window's design), not the bar's title.
    .navigationTitle("")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar { viewerToolbar(duoChrome) }
    // Held landscape on a phone, back and ⋯ ride the file's header row: the
    // closed display's rail folds its five tabs to one under two top items.
    .toolbar(changesInMenu(duoChrome) ? .hidden : .automatic, for: .navigationBar)
    .safeAreaInset(edge: .top, spacing: 0) {
      VStack(alignment: .leading, spacing: 6) {
        // The file's name floats over the code in a slim glass capsule (the
        // bar beside or above it is the edge bar or the stack's top bar).
        viewerHeader
          .padding(.horizontal, 12)
          .padding(.top, 6)
        if let errorMessage {
          FilesCompactBanner(
            symbol: "exclamationmark.triangle.fill",
            tint: ADEColor.danger,
            title: errorMessage,
            actionTitle: "Retry",
            onAction: { Task { await load() } }
          )
          .padding(.horizontal, 16)
          .background(ADEColor.pageBackground.opacity(0.94))
        }
      }
      .padding(.bottom, 4)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .environment(\.filesViewerTrailingMargin, trailingMargin)
    .onGeometryChange(for: CGFloat.self) { proxy in
      proxy.safeAreaInsets.trailing
    } action: { inset in
      if railInset != inset { railInset = inset }
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

  func showsCodeLayoutControl(blob: SyncFileBlob) -> Bool {
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
      if let limit = filesPartialPreviewLimit(blob: blob, focusLine: focusLine) {
        // Takes precedence over the generic size cap: "we only got the start"
        // is the honest reason, and it is the one that explains a line number
        // that goes nowhere. The start that did load still shows under it.
        if let focusLine, focusLine > filesPartialPreviewLineCount(blob.content) {
          FilesContentFallback(
            symbol: "doc.text.magnifyingglass",
            title: limit.title,
            message: limit.message
          )
          .padding(16)
        } else {
          VStack(spacing: 0) {
            FilesCompactBanner(
              symbol: "doc.text.magnifyingglass",
              tint: ADEColor.warning,
              title: "\(limit.title). Open it in ADE on your machine to read the rest.",
              actionTitle: nil,
              onAction: nil
            )
            .padding(.horizontal, 16)
            .padding(.bottom, 6)
            SyntaxHighlightedCodeView(
              text: filesPartialPreviewPrefix(blob.content),
              language: language,
              focusLine: focusLine,
              layoutMode: codeLayoutMode,
              fillsContainer: true
            )
          }
        }
      } else if let limit = filesTextPreviewLimit(blob: blob) {
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
