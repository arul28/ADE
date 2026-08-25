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
  /// block parsing through the bounded streaming parser, which caches the
  /// latest preview under this key instead of asking the whole-text cache to
  /// retain throwaway revisions. Completed messages keep the default
  /// whole-text cache path.
  var streamingCacheKey: String? = nil
  /// The whole message this markdown was sliced from, when `markdown` is a
  /// bounded preview of it. Copying a fenced block resolves against this, so a
  /// truncated block still copies whole.
  var fullMarkdown: String? = nil
  /// Which end of `fullMarkdown` the slice was taken from. Decides whether code
  /// blocks are numbered from the front or the back.
  var previewAnchor: WorkAssistantMessagePreviewAnchor = .head
  /// Stable identity for the authoritative source. The chat timeline passes
  /// its stamped digest/revision so source equality never relies on length.
  var fullMarkdownIdentity: String? = nil

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
    let ordinals = fullMarkdown == nil
      ? [:]
      : workCodeBlockOrdinals(blocks, countsFromEnd: previewAnchor == .tail)
    VStack(alignment: .leading, spacing: 10) {
      ForEach(blocks) { block in
        WorkMarkdownBlockView(
          block: block,
          isStreamingTail: block.id == streamingTailId,
          codeSource: codeSource(for: block, ordinals: ordinals)
        )
      }
    }
  }

  private func codeSource(
    for block: WorkMarkdownBlock,
    ordinals: [String: Int]
  ) -> WorkCodeBlockSource? {
    guard let fullMarkdown, let ordinal = ordinals[block.id] else { return nil }
    return WorkCodeBlockSource(
      markdown: fullMarkdown,
      ordinal: ordinal,
      countsFromEnd: previewAnchor == .tail,
      markdownIdentity: fullMarkdownIdentity
    )
  }
}

struct WorkMarkdownBlockView: View {
  let block: WorkMarkdownBlock
  var isStreamingTail = false
  /// Set when this block was parsed from a bounded slice of a longer message.
  var codeSource: WorkCodeBlockSource? = nil

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
      WorkMarkdownTable(headers: headers, rows: rows, isStreamingTail: isStreamingTail)
    case .code(let language, let code):
      WorkCodeBlockView(language: language, code: code, source: codeSource)
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
  /// Cells of a still-growing table are throwaway revisions like any other
  /// streaming tail; without this they land in the shared completed-message
  /// cache and evict it, which is the eviction bug this branch fixes for prose.
  var isStreamingTail = false

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      VStack(spacing: 0) {
        HStack(spacing: 0) {
          ForEach(headers.indices, id: \.self) { index in
            WorkInlineMarkdownText(text: headers[index], isStreamingTail: isStreamingTail)
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
              WorkInlineMarkdownText(text: index < row.count ? row[index] : "", isStreamingTail: isStreamingTail)
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
  /// Non-nil when `code` is the slice of a block from a longer message. Copy
  /// and the viewer resolve the whole block through it, at tap time — resolving
  /// on every render pass would reparse the message behind every frame.
  var source: WorkCodeBlockSource? = nil

  @State private var copied = false

  var detectedLanguage: FilesLanguage {
    FilesLanguage.detect(languageId: language, filePath: "snippet.\(language ?? "txt")")
  }

  private var label: String {
    (language?.isEmpty == false ? language : detectedLanguage.displayName)
      .map { $0.uppercased() } ?? detectedLanguage.displayName.uppercased()
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        Text(label)
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textMuted)
        Spacer()
        WorkOpenFullOutputButton(
          title: "Code · \(label.lowercased())",
          text: code,
          kind: .code,
          languageId: language,
          codeSource: source
        )
        Button {
          // The rendered block can be a slice; the clipboard never is.
          UIPasteboard.general.string = source?.resolvedCode(fallback: code) ?? code
          copied = true
          Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_400_000_000)
            copied = false
          }
        } label: {
          Text(copied ? "Copied" : "Copy")
            .font(.caption2.weight(.semibold))
            .foregroundStyle(copied ? ADEColor.success : ADEColor.accent)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "Copied to clipboard" : "Copy code")
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
