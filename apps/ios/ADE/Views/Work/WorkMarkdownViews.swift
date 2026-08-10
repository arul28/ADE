import SwiftUI
import UIKit
import AVKit

struct WorkInlineMarkdownText: View {
  let text: String
  /// Set on the one block that is still growing, so its throwaway revisions
  /// stay out of the shared inline-markdown cache.
  var isStreamingTail = false

  var body: some View {
    Text(markdownAttributedString(text, intermediate: isStreamingTail))
      .foregroundStyle(ADEColor.textPrimary)
      .tint(ADEColor.accent)
      .frame(maxWidth: .infinity, alignment: .leading)
      .textSelection(.enabled)
  }
}

struct WorkMarkdownRenderer: View {
  let markdown: String
  /// Non-nil while this markdown is still receiving streaming deltas. Routes
  /// block parsing through the tail-only streaming parser (stable prefix
  /// cached under this key — the message id) instead of the whole-text block
  /// cache, which misses on every delta because the text keeps growing.
  /// Completed messages keep the default whole-text cache path.
  var streamingCacheKey: String? = nil

  private var blocks: [WorkMarkdownBlock] {
    if let streamingCacheKey {
      return parseMarkdownBlocksForStreaming(markdown, cacheKey: streamingCacheKey)
    }
    return parseMarkdownBlocks(markdown)
  }

  var body: some View {
    let blocks = self.blocks
    // Only the last block of a streaming message is still growing; everything
    // above it is final and belongs in the shared caches.
    let streamingTailId = streamingCacheKey == nil ? nil : blocks.last?.id
    VStack(alignment: .leading, spacing: 10) {
      ForEach(blocks) { block in
        WorkMarkdownBlockView(block: block, isStreamingTail: block.id == streamingTailId)
      }
    }
  }
}

struct WorkMarkdownBlockView: View {
  let block: WorkMarkdownBlock
  var isStreamingTail = false

  var body: some View {
    switch block.kind {
    case .paragraph(let text):
      WorkInlineMarkdownText(text: text, isStreamingTail: isStreamingTail)
    case .heading(let level, let text):
      WorkInlineMarkdownText(text: text, isStreamingTail: isStreamingTail)
        .font(headingFont(level: level))
    case .unorderedList(let items):
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
          HStack(alignment: .top, spacing: 8) {
            Text("•")
              .foregroundStyle(ADEColor.accent)
            WorkInlineMarkdownText(text: item, isStreamingTail: isStreamingTail)
          }
        }
      }
    case .orderedList(let start, let items):
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(items.enumerated()), id: \.offset) { index, item in
          HStack(alignment: .top, spacing: 8) {
            Text("\(start + index).")
              .foregroundStyle(ADEColor.accent)
            WorkInlineMarkdownText(text: item, isStreamingTail: isStreamingTail)
          }
        }
      }
    case .blockquote(let lines):
      HStack(alignment: .top, spacing: 10) {
        Rectangle()
          .fill(ADEColor.accent.opacity(0.55))
          .frame(width: 3)
        VStack(alignment: .leading, spacing: 4) {
          ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
            WorkInlineMarkdownText(text: line, isStreamingTail: isStreamingTail)
          }
        }
      }
      .padding(10)
      .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    case .table(let headers, let rows):
      WorkMarkdownTable(headers: headers, rows: rows)
    case .code(let language, let code):
      WorkCodeBlockView(language: language, code: code)
    case .rule:
      Divider()
    }
  }

  private func headingFont(level: Int) -> Font {
    switch level {
    case 1: return .title3.weight(.bold)
    case 2: return .headline.weight(.bold)
    default: return .subheadline.weight(.bold)
    }
  }
}

struct WorkMarkdownTable: View {
  let headers: [String]
  let rows: [[String]]

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      VStack(spacing: 0) {
        HStack(spacing: 0) {
          ForEach(headers.indices, id: \.self) { index in
            WorkInlineMarkdownText(text: headers[index])
              .font(.caption.weight(.semibold))
              .padding(10)
              .frame(minWidth: 120, alignment: .leading)
              .background(ADEColor.surfaceBackground.opacity(0.7))
          }
        }
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          Divider()
          HStack(spacing: 0) {
            ForEach(headers.indices, id: \.self) { index in
              WorkInlineMarkdownText(text: index < row.count ? row[index] : "")
                .font(.caption)
                .padding(10)
                .frame(minWidth: 120, alignment: .leading)
            }
          }
        }
      }
      .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }
}

struct WorkCodeBlockView: View {
  let language: String?
  let code: String

  var detectedLanguage: FilesLanguage {
    FilesLanguage.detect(languageId: language, filePath: "snippet.\(language ?? "txt")")
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text((language?.isEmpty == false ? language : detectedLanguage.displayName).map { $0.uppercased() } ?? detectedLanguage.displayName.uppercased())
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
        Spacer()
        Button("Copy") {
          UIPasteboard.general.string = code
        }
        .font(.caption2.weight(.semibold))
      }
      ScrollView(.horizontal, showsIndicators: false) {
        Text(SyntaxHighlighter.highlightedAttributedString(code, as: detectedLanguage))
          .frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
      .padding(12)
      .background(ADEColor.recessedBackground.opacity(0.9), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
    .padding(12)
    .background(ADEColor.surfaceBackground.opacity(0.65), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
  }
}
