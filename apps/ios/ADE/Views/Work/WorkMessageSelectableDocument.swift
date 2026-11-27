import UIKit

// An agent reply as plain, selectable text, and the thread-comment anchor for
// a range of it. The anchor is the twin of desktop `captureTextAnchor`
// (`apps/desktop/src/renderer/components/chat/threadCommentAnchors.ts`): the
// selected visible text, whitespace-collapsed, plus up to
// `workThreadCommentContextChars` of context on each side. Keep the two in
// step, or desktop cannot find a comment made on the phone.

/// `THREAD_COMMENT_CONTEXT_CHARS` in `apps/desktop/src/shared/threadComments.ts`.
let workThreadCommentContextChars = 32
/// `MAX_THREAD_COMMENT_EXCERPT_CHARS`.
let workThreadCommentExcerptChars = 120
/// `MAX_THREAD_COMMENT_QUOTE_CHARS`. The host caps a longer quote; the sheet
/// says so before the comment is sent rather than after.
let workThreadCommentQuoteChars = 2_000

/// Characters drawn for reading but not part of the reply's text: list
/// markers and quote bars. Desktop draws them with CSS, so they are not in its
/// text either, and a quote that held one would not be found there.
private let workSelectionIgnoredAttribute = NSAttributedString.Key("ade.threadCommentIgnore")

/// One reply laid out as plain, selectable text, with each markdown block's
/// range so the long-pressed block can be selected on open.
struct WorkSelectableMessageDocument {
  let attributed: NSAttributedString
  /// Block id (`WorkMarkdownBlock.id`) to its range in `attributed`.
  let blockRanges: [String: NSRange]
  /// UTF-16 offsets where desktop's text walk puts a space that is not in the
  /// text: the end of each text node directly inside a paragraph, list item,
  /// heading, cell or code element (`collapsedTextOf`'s soft space).
  fileprivate let softBreakOffsets: IndexSet

  var string: String { attributed.string }

  func text(in range: NSRange) -> String {
    let ns = attributed.string as NSString
    let clamped = NSIntersectionRange(range, NSRange(location: 0, length: ns.length))
    return ns.substring(with: clamped)
  }
}

private enum WorkSelectionFont {
  static var body: UIFont { UIFont.preferredFont(forTextStyle: .body) }
  static var mono: UIFont {
    UIFontMetrics(forTextStyle: .callout).scaledFont(
      for: .monospacedSystemFont(ofSize: 15, weight: .regular)
    )
  }

  static func heading(_ level: Int) -> UIFont {
    let style: UIFont.TextStyle = level <= 1 ? .title2 : level == 2 ? .title3 : .headline
    return with(UIFont.preferredFont(forTextStyle: style), traits: .traitBold)
  }

  static func with(_ font: UIFont, traits: UIFontDescriptor.SymbolicTraits) -> UIFont {
    guard let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(traits)) else {
      return font
    }
    return UIFont(descriptor: descriptor, size: 0)
  }
}

/// Lays a reply out for the selection sheet. `monospaced` is the transcript's
/// whole-message monospace rendering (a file tree, raw output).
func workSelectableMessageDocument(markdown: String, monospaced: Bool = false) -> WorkSelectableMessageDocument {
  if monospaced {
    var builder = WorkSelectableDocumentBuilder()
    builder.appendPlain(markdown, font: WorkSelectionFont.mono)
    return builder.document()
  }
  return workSelectableMessageDocument(blocks: parseMarkdownBlocks(markdown))
}

/// The same layout for some blocks of a reply. One block of it is what "Copy
/// this part" copies, so the copy and the sheet never disagree.
func workSelectableMessageDocument(blocks: [WorkMarkdownBlock]) -> WorkSelectableMessageDocument {
  var builder = WorkSelectableDocumentBuilder()
  for (index, block) in blocks.enumerated() {
    // One line break: the paragraph spacing is the gap between blocks.
    if index > 0 { builder.appendPlain("\n") }
    builder.append(block)
  }
  return builder.document()
}

private struct WorkSelectableDocumentBuilder {
  private let output = NSMutableAttributedString()
  private var blockRanges: [String: NSRange] = [:]
  private var softBreaks = IndexSet()
  private let baseAttributes: [NSAttributedString.Key: Any] = {
    let paragraph = NSMutableParagraphStyle()
    paragraph.paragraphSpacing = 12
    paragraph.lineSpacing = 2
    // Table cells are tab-separated; fixed stops keep the columns aligned.
    paragraph.tabStops = (1...8).map { NSTextTab(textAlignment: .left, location: CGFloat($0) * 104) }
    paragraph.defaultTabInterval = 104
    return [.font: WorkSelectionFont.body, .foregroundColor: UIColor.label, .paragraphStyle: paragraph]
  }()

  func document() -> WorkSelectableMessageDocument {
    WorkSelectableMessageDocument(attributed: output, blockRanges: blockRanges, softBreakOffsets: softBreaks)
  }

  mutating func append(_ block: WorkMarkdownBlock) {
    let start = output.length
    switch block.kind {
    case .paragraph(let text):
      appendInline(text)
    case .heading(let level, let text):
      appendInline(text, font: WorkSelectionFont.heading(level))
    case .list(let items):
      for (itemIndex, item) in items.enumerated() {
        if itemIndex > 0 { appendPlain("\n") }
        appendPlain(String(repeating: "    ", count: item.depth) + "\(item.markerLabel ?? "  ") ", ignored: true)
        appendInline(item.text)
      }
    case .blockquote(let lines):
      for (lineIndex, line) in lines.enumerated() {
        if lineIndex > 0 { appendPlain("\n") }
        appendPlain("> ", ignored: true)
        appendInline(line, font: WorkSelectionFont.with(WorkSelectionFont.body, traits: .traitItalic))
      }
    case .table(let headers, let rows):
      // Cells are tab-separated: a tab collapses to the same single space
      // desktop's text walk puts between two cells.
      for (rowIndex, row) in ([headers] + rows).enumerated() where !row.isEmpty {
        if output.length > start { appendPlain("\n") }
        for (cellIndex, cell) in row.enumerated() {
          if cellIndex > 0 { appendPlain("\t") }
          appendInline(cell, font: rowIndex == 0 ? WorkSelectionFont.with(WorkSelectionFont.body, traits: .traitBold) : WorkSelectionFont.body)
        }
      }
    case .code(_, let code):
      appendPlain(code, font: WorkSelectionFont.mono, softBreakAfter: true)
    case .rule:
      appendPlain("\u{2014}\u{2014}\u{2014}", ignored: true)
    case .proofCitation(_, let caption):
      appendPlain(caption.isEmpty ? "[proof]" : caption, ignored: caption.isEmpty)
    case .proofCompare(let compare):
      appendPlain(compare.caption.isEmpty ? "[\(compare.before.label) \u{2192} \(compare.after.label)]" : compare.caption)
    }
    blockRanges[block.id] = NSRange(location: start, length: output.length - start)
  }

  mutating func appendPlain(
    _ text: String,
    font: UIFont = WorkSelectionFont.body,
    ignored: Bool = false,
    softBreakAfter: Bool = false
  ) {
    var attributes = baseAttributes
    attributes[.font] = font
    if ignored {
      attributes[workSelectionIgnoredAttribute] = true
      attributes[.foregroundColor] = UIColor.secondaryLabel
    }
    output.append(NSAttributedString(string: text, attributes: attributes))
    if softBreakAfter { softBreaks.insert(output.length) }
  }

  private mutating func appendInline(_ text: String, font: UIFont = WorkSelectionFont.body) {
    let parsed = markdownAttributedString(text)
    for run in parsed.runs {
      let piece = String(parsed[run.range].characters)
      var attributes = baseAttributes
      let intent = run.inlinePresentationIntent ?? []
      var runFont = font
      if intent.contains(.code) {
        runFont = WorkSelectionFont.mono
        attributes[.backgroundColor] = UIColor.secondarySystemFill
      }
      if intent.contains(.stronglyEmphasized) { runFont = WorkSelectionFont.with(runFont, traits: .traitBold) }
      if intent.contains(.emphasized) { runFont = WorkSelectionFont.with(runFont, traits: .traitItalic) }
      if intent.contains(.strikethrough) { attributes[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
      if let link = run.link { attributes[.link] = link }
      attributes[.font] = runFont
      output.append(NSAttributedString(string: piece, attributes: attributes))
      // Desktop's soft space follows a text node whose parent is the block
      // (plain text, not inside a link, bold or italic) or a `code` element.
      // Inline code that names a file is a path link there (a `span`), so it
      // gets none.
      let codeElement = intent.contains(.code) && !workLooksLikeWorkspacePath(piece)
      if codeElement || (intent.isEmpty && run.link == nil) {
        softBreaks.insert(output.length)
      }
    }
  }
}

/// Desktop `looksLikeWorkspacePath` (`chatWorkspacePaths.tsx`): inline code
/// that desktop draws as a clickable path rather than a `code` element. Keep
/// the two in step.
func workLooksLikeWorkspacePath(_ value: String) -> Bool {
  var text = value.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !text.isEmpty else { return false }
  let lower = text.lowercased()
  if ["http:", "https:", "mailto:", "tel:", "ade:", "#"].contains(where: { lower.hasPrefix($0) }) { return false }
  if lower.hasPrefix("file://") {
    text = String(text.dropFirst(7))
  } else if lower.hasPrefix("file:") {
    text = String(text.dropFirst(5))
  }
  text = String(text.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
  text = String(text.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
  text = (text.trimmingCharacters(in: .whitespaces).removingPercentEncoding ?? text)
    .replacingOccurrences(of: "\\", with: "/")
  if text.range(of: #"^/[A-Za-z]:/"#, options: .regularExpression) != nil { text.removeFirst() }
  // A `:12` or `:12:3` line suffix.
  if let suffix = text.range(of: #":\d+(:\d+)?$"#, options: .regularExpression), suffix.lowerBound != text.startIndex {
    text = String(text[..<suffix.lowerBound])
  }
  if text.hasPrefix("./") { text.removeFirst(2) }
  guard !text.isEmpty else { return false }
  if text == ".." || text.hasPrefix("../") || text.hasPrefix("~/") { return false }
  // A shortened path (`/tmp/claude-501/.../out.txt`) names no real file.
  if text.split(separator: "/").contains(where: { $0 == "..." || $0 == "\u{2026}" }) { return false }
  let bare = text.hasPrefix("/") ? String(text.dropFirst()) : text
  if bare.contains("/") { return true }
  // A bare token must end in something file-shaped that is not a version
  // number or a domain.
  guard let dot = bare.range(of: #"\.[A-Za-z0-9]{1,8}$"#, options: .regularExpression) else { return false }
  let ext = bare[dot].dropFirst().lowercased()
  if ext.allSatisfy(\.isNumber) { return false }
  return !["com", "org", "net", "io", "ai", "dev", "gov", "edu"].contains(ext)
}

// MARK: - The anchor

struct WorkThreadCommentTextAnchor: Equatable {
  let quote: String
  let prefix: String
  let suffix: String
}

/// The reply's text as desktop's `collapsedTextOf` reads the DOM: whitespace
/// runs collapsed to one space, ignored characters left out, and a soft space
/// at each soft break. `offsets[i]` is the UTF-16 offset of collapsed char `i`
/// (a soft space takes the offset of the break, the end of its run).
private func workCollapsedSelectionText(_ document: WorkSelectableMessageDocument) -> (text: [Character], offsets: [Int]) {
  let attributed = document.attributed
  var ignored = IndexSet()
  attributed.enumerateAttribute(
    workSelectionIgnoredAttribute,
    in: NSRange(location: 0, length: attributed.length)
  ) { value, range, _ in
    if value != nil { ignored.insert(integersIn: range.location..<(range.location + range.length)) }
  }
  var text: [Character] = []
  var offsets: [Int] = []
  var lastWasSpace = true
  var offset = 0
  for character in attributed.string {
    let width = character.utf16.count
    defer { offset += width }
    if ignored.contains(offset) { continue }
    if character.isWhitespace {
      if lastWasSpace { continue }
      text.append(" ")
      lastWasSpace = true
    } else {
      text.append(character)
      lastWasSpace = false
    }
    offsets.append(offset)
    if !lastWasSpace, document.softBreakOffsets.contains(offset + width) {
      text.append(" ")
      offsets.append(offset + width)
      lastWasSpace = true
    }
  }
  return (text, offsets)
}

/// The first 120 collapsed characters, so the agent knows which reply.
func workThreadCommentExcerpt(_ document: WorkSelectableMessageDocument) -> String {
  let collapsed = workCollapsedSelectionText(document).text
  return String(collapsed.prefix(workThreadCommentExcerptChars)).trimmingCharacters(in: .whitespaces)
}

/// The anchor for a selected range of the document, or nil when the range
/// holds no reply text (only markers or space).
func workThreadCommentAnchor(
  in document: WorkSelectableMessageDocument,
  range: NSRange
) -> WorkThreadCommentTextAnchor? {
  guard range.length > 0 else { return nil }
  let collapsed = workCollapsedSelectionText(document)
  func index(atOrAfter utf16Offset: Int) -> Int {
    // Offsets never decrease, so the first one at or past the point is a
    // binary search away.
    var low = 0
    var high = collapsed.offsets.count
    while low < high {
      let mid = (low + high) / 2
      if collapsed.offsets[mid] < utf16Offset { low = mid + 1 } else { high = mid }
    }
    return low
  }
  var start = index(atOrAfter: range.location)
  var end = index(atOrAfter: range.location + range.length)
  while start < end, collapsed.text[start] == " " { start += 1 }
  while end > start, collapsed.text[end - 1] == " " { end -= 1 }
  guard end > start else { return nil }
  let context = workThreadCommentContextChars
  return WorkThreadCommentTextAnchor(
    quote: String(collapsed.text[start..<end]),
    prefix: String(collapsed.text[max(0, start - context)..<start]),
    suffix: String(collapsed.text[end..<min(collapsed.text.count, end + context)])
  )
}
