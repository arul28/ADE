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
  @State var diffMode: FilesDiffMode = .unstaged
  @State var diff: FileDiff?
  @State var diffErrorMessage: String?
  @State var historyEntries: [GitFileHistoryEntry] = []
  @State var historyErrorMessage: String?
  @State var hasLoadedHistory = false
  @State var hasLoadedDiff = false
  @State var isDetailsSheetPresented = false
  @State var codeLayoutMode: FilesCodeLayoutMode = .wrap
  @State var lastHandledFilesDetailRevision: Int?
  @State var lastFilesDetailReload = Date.distantPast

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
      return "Read-only on iPhone. Preview, diff, and metadata are available here; edit on the machine."
    }
    return "Read-only on iPhone. Preview and metadata are available here; edit on the machine."
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
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
    .adeScreenBackground()
    .adeNavigationGlass()
    .adeRootTabBarHidden()
    .navigationTitle(lastPathComponent(relativePath))
    .navigationBarTitleDisplayMode(.inline)
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
      await refreshForLocalStateRevision(syncService.localStateRevision)
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
          fileKindLabel: fileKindLabel(for: blob),
          fileSize: blob.size,
          transitionNamespace: transitionNamespace,
          onShowDetails: { isDetailsSheetPresented = true }
        )

        if editorModes.count > 1 {
          filesModeControl
        }

        if showsCodeLayoutControl(blob: blob) {
          filesCodeLayoutControl
        }
      }
    }
    .padding(.horizontal, 16)
    .padding(.top, 8)
  }

  @ViewBuilder
  private var filesModeControl: some View {
    VStack(alignment: .leading, spacing: 8) {
      FilesSegmentedControl(
        title: "Mode",
        items: editorModes,
        selection: $mode,
        label: { $0.title }
      )

      if mode == .diff, workspace.laneId != nil {
        FilesSegmentedControl(
          title: "Diff",
          items: FilesDiffMode.allCases,
          selection: $diffMode,
          label: { $0.title }
        )
      }
    }
  }

  @ViewBuilder
  private var filesCodeLayoutControl: some View {
    FilesSegmentedControl(
      title: "Code layout",
      items: FilesCodeLayoutMode.allCases,
      selection: $codeLayoutMode,
      label: { $0.title }
    )
  }

  private func showsCodeLayoutControl(blob: SyncFileBlob) -> Bool {
    switch mode {
    case .preview:
      return !blob.isBinary
    case .diff:
      return workspace.laneId != nil
    }
  }

  func fileKindLabel(for blob: SyncFileBlob) -> String {
    if isImagePreviewable {
      return "Image"
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
    if blob.isBinary {
      if isImagePreviewable, let data = imageData, let image = UIImage(data: data) {
        ZoomableImageView(image: image)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else if isImagePreviewable {
        FilesContentFallback(
          symbol: "photo",
          title: "Image preview pending",
          message: "The machine returned metadata only. Reconnect to stream the full bytes."
        )
      } else {
        FilesContentFallback(
          symbol: "doc.fill",
          title: "Binary file",
          message: "iPhone keeps this read-only. Use ADE on the machine to open with a local tool."
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
          focusLine: focusLine,
          layoutMode: codeLayoutMode
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
        message: "The machine reported a binary diff that cannot be rendered inline."
      )
    } else if let diff, !filesDiffHasChanges(diff) {
      FilesContentFallback(
        symbol: "checkmark.circle",
        title: "No \(diffMode.title.lowercased()) changes",
        message: "This file matches the selected \(diffMode.title.lowercased()) diff scope."
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
        language: FilesLanguage.detect(languageId: diff.language, filePath: relativePath),
        layoutMode: codeLayoutMode
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

private struct FilesSegmentedControl<Item: Identifiable & Equatable>: View {
  let title: String
  let items: [Item]
  @Binding var selection: Item
  let label: (Item) -> String

  var body: some View {
    HStack(spacing: 3) {
      ForEach(items) { item in
        let isSelected = selection == item
        Button {
          guard !isSelected else { return }
          withAnimation(.snappy(duration: 0.16)) {
            selection = item
          }
        } label: {
          Text(label(item))
            .font(.caption.weight(.semibold))
            .foregroundStyle(isSelected ? ADEColor.textPrimary : ADEColor.textSecondary)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .frame(maxWidth: .infinity, minHeight: 34)
            .padding(.horizontal, 8)
            .background {
              if isSelected {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .fill(ADEColor.accent.opacity(0.18))
              }
            }
            .overlay {
              if isSelected {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                  .stroke(ADEColor.accent.opacity(0.35), lineWidth: 0.75)
              }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title): \(label(item))")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
      }
    }
    .padding(3)
    .background(ADEColor.recessedBackground.opacity(0.72), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(ADEColor.glassBorder, lineWidth: 0.5)
    }
  }
}
