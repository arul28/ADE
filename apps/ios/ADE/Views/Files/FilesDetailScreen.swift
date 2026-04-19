import SwiftUI
import UIKit

struct FilesDetailScreen: View {
  @EnvironmentObject var syncService: SyncService
  @Environment(\.dismiss) var dismiss

  let workspace: FilesWorkspace
  let relativePath: String
  let focusLine: Int?
  let isFilesLive: Bool
  let transitionNamespace: Namespace.ID?
  let navigateToDirectory: (String) -> Void

  @State var blob: SyncFileBlob?
  @State var errorMessage: String?
  @State var metadata: FilesFileMetadata?
  @State var mode: FilesEditorMode = .preview
  @State var diffMode: FilesDiffMode = .unstaged
  @State var diff: FileDiff?
  @State var diffErrorMessage: String?
  @State var historyEntries: [GitFileHistoryEntry] = []
  @State var historyErrorMessage: String?
  @State var hasLoadedHistory = false
  @State var hasLoadedDiff = false
  @State var isDetailsSheetPresented = false

  var language: FilesLanguage {
    FilesLanguage.detect(languageId: blob?.languageId, filePath: relativePath)
  }

  var isImagePreviewable: Bool {
    let lowercased = relativePath.lowercased()
    return ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff"].contains((lowercased as NSString).pathExtension)
  }

  var imageData: Data? {
    guard let blob else { return nil }
    if blob.encoding.lowercased() == "base64" {
      return Data(base64Encoded: blob.content)
    }
    return Data(blob.content.utf8)
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

  var readOnlyTagline: String {
    if workspace.laneId != nil {
      return "Read-only on iPhone — previews, metadata, history, and diffs only. Use desktop ADE for edits."
    }
    return "Read-only on iPhone — previews and metadata only. Use desktop ADE for edits."
  }

  var body: some View {
    VStack(spacing: 0) {
      topChrome

      if let blob {
        filesContentHero(blob: blob)
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
          .padding(.horizontal, 16)
          .padding(.top, 12)
      } else if errorMessage == nil {
        ADECardSkeleton(rows: 4)
          .padding(.horizontal, 16)
          .padding(.top, 12)
        Spacer(minLength: 0)
      } else {
        Spacer(minLength: 0)
      }

      Text(readOnlyTagline)
        .font(.caption2)
        .foregroundStyle(ADEColor.textMuted)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 18)
        .padding(.vertical, 10)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .navigationTitle(lastPathComponent(relativePath))
    .navigationBarTitleDisplayMode(.inline)
    .navigationBarBackButtonHidden(true)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) {
        HStack(spacing: 10) {
          Button {
            dismiss()
          } label: {
            Image(systemName: "chevron.left")
          }
          .accessibilityLabel("Back")
          ADEConnectionDot()
        }
      }
      ToolbarItem(placement: .topBarTrailing) {
        Button {
          isDetailsSheetPresented = true
        } label: {
          Image(systemName: "info.circle")
        }
        .accessibilityLabel("File details")
        .disabled(blob == nil)
      }
    }
    .adeNavigationZoomTransition(id: transitionNamespace == nil ? nil : "files-container-\(relativePath)", in: transitionNamespace)
    .sheet(isPresented: $isDetailsSheetPresented) {
      FilesDetailsSheet(
        relativePath: relativePath,
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
    .task(id: syncService.localStateRevision) {
      await load(refreshDiff: mode == .diff)
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

  @ViewBuilder
  private var topChrome: some View {
    VStack(alignment: .leading, spacing: 10) {
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

      if let errorMessage {
        FilesCompactBanner(
          symbol: "exclamationmark.triangle.fill",
          tint: ADEColor.danger,
          title: errorMessage,
          actionTitle: "Retry",
          onAction: { Task { await load() } }
        )
      }

      if let blob {
        FilesHeaderStrip(
          relativePath: relativePath,
          language: language,
          fileSize: blob.size,
          isFilesLive: isFilesLive,
          transitionNamespace: transitionNamespace
        )

        if editorModes.count > 1 {
          filesModeControl
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
  }

  @ViewBuilder
  private var filesModeControl: some View {
    VStack(alignment: .leading, spacing: 8) {
      Picker("Mode", selection: $mode) {
        ForEach(editorModes) { editorMode in
          Text(editorMode.title).tag(editorMode)
        }
      }
      .pickerStyle(.segmented)

      if mode == .diff, workspace.laneId != nil {
        Picker("Diff", selection: $diffMode) {
          ForEach(FilesDiffMode.allCases) { item in
            Text(item.title).tag(item)
          }
        }
        .pickerStyle(.segmented)
      }
    }
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
    if blob.isBinary {
      if isImagePreviewable, let data = imageData, let image = UIImage(data: data) {
        ZoomableImageView(image: image)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if isImagePreviewable {
        FilesContentFallback(
          symbol: "photo",
          title: "Image preview pending",
          message: "The host returned metadata only. Reconnect to stream the full bytes."
        )
      } else {
        FilesContentFallback(
          symbol: "doc.fill",
          title: "Binary file",
          message: "iPhone keeps this read-only. Use desktop ADE to open with a local tool."
        )
      }
    } else {
      if let limit = filesTextPreviewLimit(blob: blob) {
        FilesContentFallback(
          symbol: "doc.text.magnifyingglass",
          title: limit.title,
          message: limit.message
        )
      } else {
        SyntaxHighlightedCodeView(
          text: blob.content,
          language: language,
          focusLine: focusLine
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
    } else if !hasLoadedDiff, diffErrorMessage == nil {
      ADECardSkeleton(rows: 5)
    } else if let diffErrorMessage {
      FilesCompactBanner(
        symbol: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        title: diffErrorMessage,
        actionTitle: "Retry",
        onAction: { Task { await loadDiff() } }
      )
    } else if let diff, diff.isBinary == true {
      FilesContentFallback(
        symbol: "doc.badge.gearshape",
        title: "Binary diff",
        message: "The host reported a binary diff that cannot be rendered inline."
      )
    } else if let diff, let limit = filesDiffPreviewLimit(diff: diff) {
      FilesContentFallback(
        symbol: "arrow.left.arrow.right",
        title: limit.title,
        message: limit.message
      )
    } else if let diff {
      FilesInlineDiffView(
        lines: buildInlineDiffLines(original: diff.original.text, modified: diff.modified.text),
        language: FilesLanguage.detect(languageId: diff.language, filePath: relativePath)
      )
    } else {
      FilesContentFallback(
        symbol: "arrow.left.arrow.right",
        title: "No diff available",
        message: "Nothing cached for \(diffMode.title.lowercased()) diff. Reconnect or refresh to try again."
      )
    }
  }
}
