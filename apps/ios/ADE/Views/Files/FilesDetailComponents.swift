import SwiftUI
import UIKit

struct FilesHeaderStrip: View {
  let relativePath: String
  let language: FilesLanguage
  let fileSize: Int
  let isFilesLive: Bool
  let transitionNamespace: Namespace.ID?

  var body: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: fileIcon(for: relativePath))
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(fileTint(for: relativePath))
        .frame(width: 38, height: 38)
        .background(ADEColor.surfaceBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .glassEffect(in: .rect(cornerRadius: 12))
        .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "files-icon-\(relativePath)", in: transitionNamespace)

      VStack(alignment: .leading, spacing: 3) {
        Text(lastPathComponent(relativePath))
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
          .adeMatchedGeometry(id: transitionNamespace == nil ? nil : "files-title-\(relativePath)", in: transitionNamespace)

        HStack(spacing: 6) {
          Text(language.displayName.uppercased())
            .font(.caption2.monospaced().weight(.semibold))
            .foregroundStyle(ADEColor.accent)
          Text("·").foregroundStyle(ADEColor.textMuted)
          Text(formattedFileSize(fileSize))
            .font(.caption2.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
          Text("·").foregroundStyle(ADEColor.textMuted)
          Text("Read only")
            .font(.caption2.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
          if !isFilesLive {
            Text("·").foregroundStyle(ADEColor.textMuted)
            Text("Offline")
              .font(.caption2.weight(.semibold))
              .foregroundStyle(ADEColor.warning)
          }
        }
      }

      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .combine)
  }
}

struct FilesCompactBanner: View {
  let symbol: String
  let tint: Color
  let title: String
  let actionTitle: String?
  let onAction: (() -> Void)?

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: 20, height: 20)

      Text(title)
        .font(.caption.weight(.medium))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(2)
        .fixedSize(horizontal: false, vertical: true)

      Spacer(minLength: 8)

      if let actionTitle, let onAction {
        Button(actionTitle, action: onAction)
          .buttonStyle(.glass)
          .controlSize(.mini)
          .tint(tint)
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(tint.opacity(0.08), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 12, style: .continuous)
        .stroke(tint.opacity(0.24), lineWidth: 0.5)
    )
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title)\(actionTitle.map { ". Action: \($0)" } ?? "")")
  }
}

struct FilesContentFallback: View {
  let symbol: String
  let title: String
  let message: String

  var body: some View {
    VStack(spacing: 12) {
      Image(systemName: symbol)
        .font(.system(size: 24, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
        .frame(width: 50, height: 50)
        .background(ADEColor.accent.opacity(0.12), in: Circle())
        .glassEffect(in: .circle)

      Text(title)
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)

      Text(message)
        .font(.subheadline)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(maxWidth: .infinity)
    .padding(24)
    .adeInsetField(cornerRadius: 18, padding: 24)
  }
}

struct FilesMetadataRow: View {
  let label: String
  let value: String

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(label)
        .font(.caption.weight(.semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Text(value)
        .font(label == "Path" ? .caption.monospaced() : .subheadline)
        .foregroundStyle(ADEColor.textPrimary)
        .textSelection(.enabled)
    }
  }
}

struct FilesDetailsFallback: View {
  let fallback: FilesSectionFallback
  let symbol: String

  var body: some View {
    HStack(alignment: .top, spacing: 12) {
      Image(systemName: symbol)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
        .frame(width: 20, height: 20)
      VStack(alignment: .leading, spacing: 4) {
        Text(fallback.title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text(fallback.message)
          .font(.caption)
          .foregroundStyle(ADEColor.textSecondary)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(14)
    .adeInsetField(cornerRadius: 14, padding: 14)
  }
}

struct FilesHistoryEntryCard: View {
  let entry: GitFileHistoryEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 4) {
          Text(entry.subject)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(ADEColor.textPrimary)
          Text(entry.path)
            .font(.caption.monospaced())
            .foregroundStyle(ADEColor.textSecondary)
            .textSelection(.enabled)
        }

        Spacer(minLength: 8)

        ADEStatusPill(text: historyChangeTypeLabel(entry.changeType).uppercased(), tint: historyChangeTypeTint(entry.changeType))
      }

      if let previousPath = entry.previousPath, !previousPath.isEmpty, previousPath != entry.path {
        FilesMetadataRow(label: "Previous path", value: previousPath)
      }

      HStack(spacing: 10) {
        Label(entry.shortSha, systemImage: "arrow.triangle.branch")
        Label(entry.authorName, systemImage: "person.crop.circle")
        if let relativeDate = relativeDateDescription(from: entry.authoredAt) {
          Label(relativeDate, systemImage: "clock")
        }
      }
      .font(.caption)
      .foregroundStyle(ADEColor.textSecondary)
    }
    .adeInsetField(cornerRadius: 14, padding: 14)
  }

  private func historyChangeTypeLabel(_ changeType: String) -> String {
    switch changeType.lowercased() {
    case "add", "added":
      return "Added"
    case "delete", "deleted", "remove", "removed":
      return "Deleted"
    case "rename", "renamed":
      return "Renamed"
    default:
      return "Modified"
    }
  }

  private func historyChangeTypeTint(_ changeType: String) -> Color {
    switch changeType.lowercased() {
    case "add", "added":
      return ADEColor.success
    case "delete", "deleted", "remove", "removed":
      return ADEColor.danger
    case "rename", "renamed":
      return ADEColor.accent
    default:
      return ADEColor.warning
    }
  }
}

struct FilesDetailsSheet: View {
  @Environment(\.dismiss) private var dismiss

  let relativePath: String
  let blob: SyncFileBlob?
  let metadata: FilesFileMetadata?
  let language: FilesLanguage
  let historyEntries: [GitFileHistoryEntry]
  let historyFallback: FilesSectionFallback?
  let hasLoadedHistory: Bool
  let isLaneBacked: Bool

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          sheetHeader
          metadataSection
          historySection
        }
        .padding(16)
      }
      .adeScreenBackground()
      .navigationTitle("Details")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Done") { dismiss() }
            .fontWeight(.semibold)
        }
      }
    }
  }

  @ViewBuilder
  private var sheetHeader: some View {
    HStack(alignment: .center, spacing: 12) {
      Image(systemName: fileIcon(for: relativePath))
        .font(.system(size: 19, weight: .semibold))
        .foregroundStyle(fileTint(for: relativePath))
        .frame(width: 42, height: 42)
        .background(ADEColor.surfaceBackground, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .glassEffect(in: .rect(cornerRadius: 12))

      VStack(alignment: .leading, spacing: 3) {
        Text(lastPathComponent(relativePath))
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .truncationMode(.middle)
        Text(parentDirectory(of: relativePath).isEmpty ? "Workspace root" : parentDirectory(of: relativePath))
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
      }

      Spacer(minLength: 0)
    }
  }

  @ViewBuilder
  private var metadataSection: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Metadata")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)

      VStack(alignment: .leading, spacing: 14) {
        FilesMetadataRow(label: "Path", value: relativePath)
        FilesMetadataRow(
          label: "Size",
          value: metadata?.sizeText ?? blob.map { formattedFileSize($0.size) } ?? "—"
        )
        FilesMetadataRow(label: "Language", value: metadata?.languageLabel ?? language.displayName)
        FilesMetadataRow(label: "Last commit", value: metadata?.lastCommitTitle ?? "No commit information available")
        if let lastCommitDateText = metadata?.lastCommitDateText {
          FilesMetadataRow(label: "Last change", value: lastCommitDateText)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .adeInsetField(cornerRadius: 16, padding: 16)
    }
  }

  @ViewBuilder
  private var historySection: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("History")
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)

      if !hasLoadedHistory, isLaneBacked, historyFallback == nil {
        VStack(alignment: .leading, spacing: 10) {
          ADESkeletonView(width: 220, height: 14)
          ADESkeletonView(height: 12)
          ADESkeletonView(width: 160, height: 12)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .adeInsetField(cornerRadius: 14, padding: 0)
      } else if let fallback = historyFallback {
        FilesDetailsFallback(fallback: fallback, symbol: "clock.arrow.circlepath")
      } else {
        VStack(spacing: 10) {
          ForEach(historyEntries) { entry in
            FilesHistoryEntryCard(entry: entry)
          }
        }
      }
    }
  }
}

struct SyntaxHighlightedCodeView: View {
  let text: String
  let language: FilesLanguage
  let focusLine: Int?

  private var lines: [String] {
    let split = splitPreservingEmptyLines(text)
    return split.isEmpty ? [""] : split
  }

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView([.horizontal, .vertical]) {
        LazyVStack(alignment: .leading, spacing: 0) {
          ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
            HStack(alignment: .top, spacing: 12) {
              Text("\(index + 1)")
                .font(.caption2.monospaced())
                .foregroundStyle(ADEColor.textMuted)
                .frame(minWidth: 36, alignment: .trailing)
              Text(SyntaxHighlighter.highlightedAttributedString(line.isEmpty ? " " : line, as: language))
                .font(.system(.body, design: .monospaced))
                .foregroundStyle(ADEColor.textPrimary)
                .fixedSize(horizontal: true, vertical: false)
                .textSelection(.enabled)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background((focusLine == index + 1 ? ADEColor.accent.opacity(0.12) : Color.clear), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .id(index + 1)
          }
        }
        .padding(10)
      }
      .adeInsetField(cornerRadius: 16, padding: 0)
      .task(id: focusLine) {
        guard let focusLine else { return }
        withAnimation(.smooth) {
          proxy.scrollTo(focusLine, anchor: .center)
        }
      }
    }
  }
}

struct FilesInlineDiffView: View {
  let lines: [FilesInlineDiffLine]
  let language: FilesLanguage

  var body: some View {
    ScrollView([.horizontal, .vertical]) {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(lines) { line in
          HStack(alignment: .top, spacing: 12) {
            diffLineNumber(line.originalLineNumber)
            diffLineNumber(line.modifiedLineNumber)
            Text(SyntaxHighlighter.highlightedAttributedString(line.text.isEmpty ? " " : line.text, as: language))
              .font(.system(.body, design: .monospaced))
              .foregroundStyle(ADEColor.textPrimary)
              .fixedSize(horizontal: true, vertical: false)
              .textSelection(.enabled)
          }
          .frame(maxWidth: .infinity, alignment: .leading)
          .padding(.horizontal, 10)
          .padding(.vertical, 4)
          .background(diffBackground(for: line.kind), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
      }
      .padding(10)
    }
    .adeInsetField(cornerRadius: 16, padding: 0)
  }

  private func diffLineNumber(_ lineNumber: Int?) -> some View {
    Text(lineNumber.map(String.init) ?? "•")
      .font(.caption2.monospaced())
      .foregroundStyle(ADEColor.textMuted)
      .frame(minWidth: 32, alignment: .trailing)
  }

  private func diffBackground(for kind: FilesInlineDiffKind) -> Color {
    switch kind {
    case .unchanged:
      return Color.clear
    case .added:
      return ADEColor.success.opacity(0.12)
    case .removed:
      return ADEColor.danger.opacity(0.12)
    }
  }
}

struct FilesProofArtifactSheet: View {
  @Environment(\.dismiss) private var dismiss
  @EnvironmentObject private var syncService: SyncService

  let artifact: ComputerUseArtifactSummary

  @State private var blob: SyncFileBlob?
  @State private var errorMessage: String?

  private var artifactURL: URL? {
    URL(string: artifact.uri)
  }

  private var decodedData: Data? {
    guard let blob else { return nil }
    if blob.encoding.lowercased() == "base64" {
      return Data(base64Encoded: blob.content)
    }
    return Data(blob.content.utf8)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          HStack(alignment: .top, spacing: 12) {
            Image(systemName: artifact.artifactKind == "video_recording" ? "video.fill" : "photo.fill")
              .font(.system(size: 20, weight: .semibold))
              .foregroundStyle(ADEColor.accent)
              .frame(width: 44, height: 44)
              .background(ADEColor.accent.opacity(0.12), in: Circle())

            VStack(alignment: .leading, spacing: 4) {
              Text(artifact.title)
                .font(.headline)
                .foregroundStyle(ADEColor.textPrimary)
              Text(artifact.artifactKind.replacingOccurrences(of: "_", with: " ").capitalized)
                .font(.caption.monospaced())
                .foregroundStyle(ADEColor.textSecondary)
              if let description = artifact.description, !description.isEmpty {
                Text(description)
                  .font(.subheadline)
                  .foregroundStyle(ADEColor.textSecondary)
              }
            }
          }

          proofPreview

          VStack(alignment: .leading, spacing: 12) {
            FilesMetadataRow(label: "Reference", value: artifact.uri)
            FilesMetadataRow(label: "Captured", value: relativeDateDescription(from: artifact.createdAt) ?? artifact.createdAt)
          }
          .adeInsetField(cornerRadius: 16, padding: 16)
        }
        .padding(16)
      }
      .adeScreenBackground()
      .navigationTitle("Proof")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Done") { dismiss() }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
          if let artifactURL, artifactURL.scheme?.hasPrefix("http") == true {
            Link(destination: artifactURL) {
              Image(systemName: "arrow.up.right.square")
            }
            .accessibilityLabel("Open proof URL")
          }
          Button {
            UIPasteboard.general.string = artifact.uri
          } label: {
            Image(systemName: "doc.on.doc")
          }
          .accessibilityLabel("Copy proof reference")
        }
      }
      .task(id: artifact.id) {
        await loadArtifact()
      }
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }

  @ViewBuilder
  private var proofPreview: some View {
    if let errorMessage {
      FilesCompactBanner(
        symbol: "exclamationmark.triangle.fill",
        tint: ADEColor.danger,
        title: errorMessage,
        actionTitle: "Retry",
        onAction: { Task { await loadArtifact() } }
      )
    } else if artifact.artifactKind == "video_recording" || artifact.mimeType?.contains("video") == true {
      FilesContentFallback(
        symbol: "video.fill",
        title: "Video proof",
        message: "The artifact is available from its reference. Open the URL or copy the reference to inspect it."
      )
    } else if let decodedData, let image = UIImage(data: decodedData) {
      Image(uiImage: image)
        .resizable()
        .scaledToFit()
        .frame(maxWidth: .infinity)
        .adeInsetField(cornerRadius: 16, padding: 0)
    } else if let blob, !blob.isBinary {
      Text(blob.content)
        .font(.system(.caption, design: .monospaced))
        .foregroundStyle(ADEColor.textPrimary)
        .textSelection(.enabled)
        .frame(maxWidth: .infinity, alignment: .leading)
        .adeInsetField(cornerRadius: 16, padding: 14)
    } else if blob == nil {
      ADECardSkeleton(rows: 4)
    } else {
      FilesContentFallback(
        symbol: "doc.badge.gearshape",
        title: "Preview unavailable",
        message: "The host returned proof metadata, but iPhone could not render this artifact inline."
      )
    }
  }

  @MainActor
  private func loadArtifact() async {
    errorMessage = nil
    do {
      blob = try await syncService.readArtifact(artifactId: artifact.id, uri: artifact.uri)
    } catch {
      blob = nil
      errorMessage = error.localizedDescription
    }
  }
}

struct ZoomableImageView: View {
  let image: UIImage

  @State private var scale: CGFloat = 1
  @State private var lastScale: CGFloat = 1
  @State private var offset: CGSize = .zero
  @State private var lastOffset: CGSize = .zero

  var body: some View {
    GeometryReader { proxy in
      Image(uiImage: image)
        .resizable()
        .scaledToFit()
        .scaleEffect(scale)
        .offset(offset)
        .frame(width: proxy.size.width, height: proxy.size.height)
        .contentShape(Rectangle())
        .gesture(magnificationGesture.simultaneously(with: dragGesture))
    }
    .adeInsetField(cornerRadius: 16, padding: 0)
  }

  private var magnificationGesture: some Gesture {
    MagnificationGesture()
      .onChanged { value in
        scale = min(max(lastScale * value, 1), 6)
      }
      .onEnded { _ in
        lastScale = scale
        if scale <= 1 {
          offset = .zero
          lastOffset = .zero
        }
      }
  }

  private var dragGesture: some Gesture {
    DragGesture()
      .onChanged { value in
        guard scale > 1 else { return }
        offset = CGSize(width: lastOffset.width + value.translation.width, height: lastOffset.height + value.translation.height)
      }
      .onEnded { _ in
        guard scale > 1 else {
          offset = .zero
          lastOffset = .zero
          return
        }
        lastOffset = offset
      }
  }
}
