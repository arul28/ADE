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
        WorkMarkdownBlockView(
          block: block,
          isStreamingTail: block.id == streamingTailId
        )
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
      WorkMarkdownTable(headers: headers, rows: rows, isStreamingTail: isStreamingTail)
    case .code(let language, let code):
      if workIsSceneFenceLanguage(language) {
        // A scene is HTML the agent wrote for the desktop's sandboxed frame —
        // up to 96 KB of it. iOS has no frame to run it in, and dumping the
        // markup into the transcript buries the answer the user asked for, so
        // the phone collapses it the way the TUI does.
        WorkSceneFencePlaceholder(source: code)
      } else {
        WorkCodeBlockView(language: language, code: code)
      }
    case .rule:
      Divider()
    case .proofCitation(let artifactId, let caption):
      WorkProofCitationView(artifactId: artifactId, caption: caption)
    case .proofCompare(let compare):
      WorkProofCompareView(compare: compare)
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

/// A scene fence, stood in for rather than rendered.
///
/// Parity note: a scene NEVER renders as markup here. iOS has no sandboxed,
/// opaque-origin frame (`SceneFrame` on desktop), and a `WKWebView` loading
/// agent-authored HTML inside the app would be exactly the thing the desktop's
/// CSP and `sandbox="allow-scripts"`-without-`allow-same-origin` pair exist to
/// prevent. The desktop freezes a scene to a PNG snapshot at the end of its
/// turn, but that snapshot is chat-scoped proof on the host and is not carried
/// in the transcript, so the phone has a title and nothing else to show.
struct WorkSceneFencePlaceholder: View {
  let source: String

  private var title: String? { workSceneFenceTitle(source) }

  var body: some View {
    HStack(alignment: .center, spacing: 10) {
      Image(systemName: "rectangle.on.rectangle.angled")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.textMuted)
      VStack(alignment: .leading, spacing: 2) {
        Text(title ?? "Generated view")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("Open this chat on desktop to run it.")
          .font(.caption)
          .foregroundStyle(ADEColor.textMuted)
      }
      Spacer(minLength: 0)
    }
    .padding(12)
    .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    .background(ADEColor.surfaceBackground.opacity(0.65), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .stroke(ADEColor.glassBorder.opacity(0.7), lineWidth: 0.5)
    )
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Generated view: \(title ?? "untitled"). Open this chat on desktop to run it.")
  }
}

struct WorkCodeBlockView: View {
  let language: String?
  let code: String

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
          languageId: language
        )
        Button {
          UIPasteboard.general.string = code
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
