import SwiftUI
import UIKit

struct FilesBinaryPreviewView: View {
  let relativePath: String
  let blob: SyncFileBlob
  let imageData: Data?

  var body: some View {
    if let imageData, let image = UIImage(data: imageData) {
      VStack(alignment: .leading, spacing: 10) {
        Text("Preview")
          .font(.headline)
          .foregroundStyle(ADEColor.textPrimary)
        ZoomableImageView(image: image)
          .frame(minHeight: 280)
      }
      .adeGlassCard(cornerRadius: 18)
    } else {
      ADEEmptyStateView(
        symbol: "doc.fill",
        title: "Binary file",
        message: "This file cannot be displayed inline on iPhone yet."
      )
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
      .frame(minHeight: 320)
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
    .frame(minHeight: 320)
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
    case .unchanged: return Color.clear
    case .added: return ADEColor.success.opacity(0.12)
    case .removed: return ADEColor.danger.opacity(0.12)
    }
  }
}

struct ZoomableImageView: View {
  let image: UIImage

  private let maxScale: CGFloat = 8
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
        .onTapGesture(count: 2) {
          withAnimation(.spring(duration: 0.3)) {
            scale = 1
            lastScale = 1
            offset = .zero
            lastOffset = .zero
          }
        }
    }
    .adeInsetField(cornerRadius: 16, padding: 0)
  }

  private var magnificationGesture: some Gesture {
    MagnificationGesture()
      .onChanged { value in
        scale = min(maxScale, max(1, lastScale * value))
      }
      .onEnded { value in
        scale = min(maxScale, max(1, lastScale * value))
        lastScale = scale
        if scale == 1 {
          withAnimation(.spring(duration: 0.2)) {
            offset = .zero
            lastOffset = .zero
          }
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
        lastOffset = offset
      }
  }
}

