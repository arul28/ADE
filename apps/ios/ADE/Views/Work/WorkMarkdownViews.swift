import SwiftUI
import UIKit
import AVKit

/// The one definition of chat text sizes. Every size is a Dynamic Type text
/// style, so accessibility sizes keep scaling; the chat simply sits one step
/// below the system `.body` (17 pt → `.callout` 16 pt at the default size) to
/// fit more of an answer on a phone line.
enum WorkChatTypography {
  /// Assistant markdown prose, list items, and user message bubbles.
  static let body: Font = .callout
  /// Inline code runs: monospaced, one style below `body` so the wider mono
  /// glyphs read at the same weight without raising the line height.
  static let inlineCode: Font = .system(.subheadline, design: .monospaced)
  static let inlineCodeBackground: Color = ADEColor.textPrimary.opacity(0.07)
  /// Markdown table cells (dense by design).
  static let tableCell: Font = .caption
  static let tableHeader: Font = .caption.weight(.semibold)

  static func heading(level: Int) -> Font {
    switch level {
    case 1: return .title3.weight(.bold)
    case 2: return .headline.weight(.bold)
    default: return .callout.weight(.bold)
    }
  }
}

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
    // Headings and table cells set their own font closer to the text, which
    // wins over this block-wide default.
    content.font(WorkChatTypography.body)
  }

  @ViewBuilder
  private var content: some View {
    switch block.kind {
    case .paragraph(let text):
      WorkInlineMarkdownText(text: text, isStreamingTail: isStreamingTail)
    case .heading(let level, let text):
      WorkInlineMarkdownText(text: text, isStreamingTail: isStreamingTail)
        .font(WorkChatTypography.heading(level: level))
    case .list(let items):
      VStack(alignment: .leading, spacing: 6) {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
          WorkMarkdownListRow(item: item, isStreamingTail: isStreamingTail)
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
}

/// One row of a (possibly nested) list: invisible copies of each ancestor's
/// marker column indent it so it starts exactly under its parent's text, then
/// its own fixed-width, trailing-aligned marker column, then the text.
struct WorkMarkdownListRow: View {
  let item: WorkMarkdownListItem
  var isStreamingTail = false

  private static let columnGap: CGFloat = 8

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: Self.columnGap) {
      ForEach(Array(item.ancestors.enumerated()), id: \.offset) { _, column in
        WorkMarkdownListMarkerView(column: column, label: nil)
      }
      WorkMarkdownListMarkerView(column: item.column, label: item.markerLabel)
      WorkInlineMarkdownText(text: item.text, isStreamingTail: isStreamingTail)
    }
  }
}

/// A marker column sized by an invisible placeholder of the widest marker the
/// column holds, so it tracks Dynamic Type without a hard-coded width.
struct WorkMarkdownListMarkerView: View {
  let column: WorkMarkdownListMarkerColumn
  /// The visible marker, or nil for an indentation-only slot.
  let label: String?

  var body: some View {
    Text(workMarkdownListMarkerPlaceholder(column))
      .monospacedDigit()
      .hidden()
      .overlay(alignment: alignment) {
        if let label {
          Text(label)
            .monospacedDigit()
            .foregroundStyle(ADEColor.accent)
            .fixedSize()
        }
      }
      .accessibilityHidden(label == nil)
  }

  private var alignment: Alignment {
    if case .bullet = column { return .center }
    return .trailing
  }
}

struct WorkMarkdownTable: View {
  let headers: [String]
  let rows: [[String]]
  /// Cells of a still-growing table are throwaway revisions like any other
  /// streaming tail; without this they land in the shared completed-message
  /// cache and evict it, which is the eviction bug this branch fixes for prose.
  var isStreamingTail = false

  /// Widest a column may grow before its cells wrap. A cell with a long
  /// sentence would otherwise lay out on one line as wide as the sentence.
  private let maxColumnWidth: CGFloat = 260

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      WorkMarkdownTableLayout(columns: max(1, headers.count), maxColumnWidth: maxColumnWidth) {
        ForEach(headers.indices, id: \.self) { index in
          cell(headers[index], font: WorkChatTypography.tableHeader, isHeader: true)
        }
        ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
          ForEach(headers.indices, id: \.self) { index in
            cell(index < row.count ? row[index] : "", font: WorkChatTypography.tableCell, isHeader: false)
          }
        }
      }
      .background(ADEColor.surfaceBackground.opacity(0.45), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
      .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
  }

  private func cell(_ text: String, font: Font, isHeader: Bool) -> some View {
    WorkInlineMarkdownText(text: text, isStreamingTail: isStreamingTail)
      .font(font)
      .padding(10)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(isHeader ? ADEColor.surfaceBackground.opacity(0.7) : Color.clear)
      .overlay(alignment: .top) {
        if !isHeader {
          Rectangle()
            .fill(ADEColor.glassBorder.opacity(0.6))
            .frame(height: 0.5)
        }
      }
  }
}

/// Table grid for markdown tables.
///
/// A column is as wide as its widest cell, up to `maxColumnWidth`; a cell over
/// that wraps. Each row is then as tall as its tallest cell at the column
/// width. SwiftUI's `Grid` measures cells at their ideal (one-line) size inside
/// a horizontal scroll view, so a wrapped cell drew over the next row.
struct WorkMarkdownTableLayout: Layout {
  let columns: Int
  let maxColumnWidth: CGFloat
  var minColumnWidth: CGFloat = 64

  struct Cache {
    var widths: [CGFloat] = []
    var rowHeights: [CGFloat] = []
  }

  func makeCache(subviews: Subviews) -> Cache {
    measure(subviews)
  }

  func updateCache(_ cache: inout Cache, subviews: Subviews) {
    cache = measure(subviews)
  }

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) -> CGSize {
    CGSize(width: cache.widths.reduce(0, +), height: cache.rowHeights.reduce(0, +))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout Cache) {
    var y = bounds.minY
    for (rowIndex, height) in cache.rowHeights.enumerated() {
      var x = bounds.minX
      for column in 0..<columns {
        let index = rowIndex * columns + column
        guard index < subviews.count else { break }
        let width = cache.widths[column]
        subviews[index].place(
          at: CGPoint(x: x, y: y),
          anchor: .topLeading,
          proposal: ProposedViewSize(width: width, height: height)
        )
        x += width
      }
      y += height
    }
  }

  private func measure(_ subviews: Subviews) -> Cache {
    guard columns > 0, !subviews.isEmpty else { return Cache() }
    var widths = Array(repeating: minColumnWidth, count: columns)
    for (index, subview) in subviews.enumerated() {
      let ideal = subview.sizeThatFits(.unspecified).width
      let column = index % columns
      widths[column] = max(widths[column], min(ideal.rounded(.up), maxColumnWidth))
    }
    let rowCount = (subviews.count + columns - 1) / columns
    var heights: [CGFloat] = []
    heights.reserveCapacity(rowCount)
    for row in 0..<rowCount {
      var height: CGFloat = 0
      for column in 0..<columns {
        let index = row * columns + column
        guard index < subviews.count else { break }
        let size = subviews[index].sizeThatFits(ProposedViewSize(width: widths[column], height: nil))
        height = max(height, size.height.rounded(.up))
      }
      heights.append(height)
    }
    return Cache(widths: widths, rowHeights: heights)
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
