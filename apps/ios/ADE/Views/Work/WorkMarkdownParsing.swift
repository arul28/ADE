import SwiftUI
import UIKit
import AVKit

enum WorkMarkdownBlockKind: Equatable {
  case paragraph(String)
  case heading(Int, String)
  case unorderedList([String])
  case orderedList(start: Int, items: [String])
  case blockquote([String])
  case table(headers: [String], rows: [[String]])
  case code(language: String?, code: String)
  case rule

  var cacheKey: String {
    switch self {
    case .paragraph(let text):
      return "paragraph|\(text)"
    case .heading(let level, let text):
      return "heading|\(level)|\(text)"
    case .unorderedList(let items):
      return "unorderedList|\(items.joined(separator: "\u{001F}"))"
    case .orderedList(let start, let items):
      return "orderedList|\(start)|\(items.joined(separator: "\u{001F}"))"
    case .blockquote(let lines):
      return "blockquote|\(lines.joined(separator: "\u{001F}"))"
    case .table(let headers, let rows):
      let rowDigest = rows.map { $0.joined(separator: "\u{001F}") }.joined(separator: "\u{001E}")
      return "table|\(headers.joined(separator: "\u{001F}"))|\(rowDigest)"
    case .code(let language, let code):
      return "code|\(language ?? "")|\(code)"
    case .rule:
      return "rule"
    }
  }
}

struct WorkMarkdownBlock: Identifiable, Equatable {
  let id: String
  let kind: WorkMarkdownBlockKind
}

func parseMarkdownBlocks(_ markdown: String) -> [WorkMarkdownBlock] {
  let key = markdown as NSString
  if let cached = workMarkdownBlocksCache.object(forKey: key) {
    return cached.value
  }

  let parsed = parseMarkdownBlocksInternal(markdown)
  workMarkdownBlocksCache.setObject(WorkMarkdownBlocksCacheBox(parsed), forKey: key)
  return parsed
}

/// Tail-only block parsing for the actively-streaming assistant message.
///
/// While a turn streams, the message text grows with every delta, so the
/// whole-text cache in `parseMarkdownBlocks` misses on every rebuild and the
/// entire (ever longer) message re-parses each frame. This entry point splits
/// the text at the last "stable boundary" — the last empty line that is not
/// inside an unclosed ``` fence. Everything before that boundary can never be
/// re-interpreted by text that arrives later (every non-code construct in the
/// parser terminates at a blank line and never looks past one), so the prefix
/// is parsed once and cached under `cacheKey` (the message id); only the small
/// growing tail re-parses per delta.
///
/// The combined output is exactly `parseMarkdownBlocks(fullText)` — same
/// kinds, same ids — so views can switch between the streaming and completed
/// paths without any visual or identity churn.
func parseMarkdownBlocksForStreaming(_ markdown: String, cacheKey: String) -> [WorkMarkdownBlock] {
  let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n")
  let key = cacheKey as NSString
  let cached = workStreamingMarkdownCache.object(forKey: key)
  if let cached, cached.fullText == normalized {
    return cached.blocks
  }

  guard let boundary = workStreamingStableBoundaryIndex(in: normalized) else {
    // No stable prefix yet (still inside the first block, or everything sits
    // in one unclosed leading fence) — parse the whole text fresh.
    let blocks = parseMarkdownBlocksInternal(normalized)
    workStreamingMarkdownCache.setObject(
      WorkStreamingMarkdownCacheBox(prefixText: "", prefixBlocks: [], fullText: normalized, blocks: blocks),
      forKey: key
    )
    return blocks
  }

  let prefixText = String(normalized[..<boundary])
  let prefixBlocks: [WorkMarkdownBlock]
  if let cached, cached.prefixText == prefixText {
    prefixBlocks = cached.prefixBlocks
  } else {
    prefixBlocks = parseMarkdownBlocksInternal(prefixText)
  }

  let tailBlocks = parseMarkdownBlocksInternal(String(normalized[boundary...]))
  var blocks = prefixBlocks
  blocks.reserveCapacity(prefixBlocks.count + tailBlocks.count)
  for tailBlock in tailBlocks {
    // Re-id the tail blocks so indices continue from the prefix — the parser
    // bakes the running block index into each id, and ids must match the
    // whole-text parse exactly.
    blocks.append(WorkMarkdownBlock(
      id: "markdown-block-\(blocks.count)-\(workStableDigest(tailBlock.kind.cacheKey))",
      kind: tailBlock.kind
    ))
  }
  workStreamingMarkdownCache.setObject(
    WorkStreamingMarkdownCacheBox(prefixText: prefixText, prefixBlocks: prefixBlocks, fullText: normalized, blocks: blocks),
    forKey: key
  )
  return blocks
}

/// Finds the position just past the last empty line that is NOT inside an
/// unclosed ``` fence (fence state is tracked by toggling on every line whose
/// trimmed text starts with "```", mirroring the parser's open/close rule).
/// Splitting there is safe because blank lines terminate every non-code
/// construct in `parseMarkdownBlocksInternal`, and the parser's only lookahead
/// (the table-header check) never crosses a blank line.
private func workStreamingStableBoundaryIndex(in normalized: String) -> String.Index? {
  var boundary: String.Index?
  var insideFence = false
  var lineStart = normalized.startIndex
  while lineStart < normalized.endIndex {
    let newlineIndex = normalized[lineStart...].firstIndex(of: "\n")
    let lineEnd = newlineIndex ?? normalized.endIndex
    if lineStart == lineEnd {
      if !insideFence {
        boundary = newlineIndex.map { normalized.index(after: $0) } ?? lineEnd
      }
    } else if normalized[lineStart..<lineEnd].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
      insideFence.toggle()
    }
    guard let newlineIndex else { break }
    lineStart = normalized.index(after: newlineIndex)
  }
  return boundary
}

private func parseMarkdownBlocksInternal(_ markdown: String) -> [WorkMarkdownBlock] {
  let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  var index = 0
  var blocks: [WorkMarkdownBlock] = []

  func appendBlock(_ kind: WorkMarkdownBlockKind) {
    let blockID = "markdown-block-\(blocks.count)-\(workStableDigest(kind.cacheKey))"
    blocks.append(WorkMarkdownBlock(id: blockID, kind: kind))
  }

  func appendParagraph(_ lines: [String]) {
    let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty {
      appendBlock(.paragraph(text))
    }
  }

  while index < lines.count {
    let line = lines[index]
    let trimmed = line.trimmingCharacters(in: .whitespaces)

    if trimmed.isEmpty {
      index += 1
      continue
    }

    if trimmed.hasPrefix("```") {
      let language = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespacesAndNewlines)
      index += 1
      var codeLines: [String] = []
      while index < lines.count, !lines[index].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
        codeLines.append(lines[index])
        index += 1
      }
      if index < lines.count { index += 1 }
      appendBlock(.code(language: language.isEmpty ? nil : language, code: codeLines.joined(separator: "\n")))
      continue
    }

    if let heading = trimmed.firstIndex(where: { $0 != "#" }), heading > trimmed.startIndex, trimmed[..<heading].allSatisfy({ $0 == "#" }) {
      let level = trimmed[..<heading].count
      let text = trimmed[heading...].trimmingCharacters(in: .whitespaces)
      appendBlock(.heading(level, text))
      index += 1
      continue
    }

    if ["---", "***", "___"].contains(trimmed) {
      appendBlock(.rule)
      index += 1
      continue
    }

    if trimmed.hasPrefix(">") {
      var quoteLines: [String] = []
      while index < lines.count {
        let value = lines[index].trimmingCharacters(in: .whitespaces)
        guard value.hasPrefix(">") else { break }
        quoteLines.append(String(value.dropFirst()).trimmingCharacters(in: .whitespaces))
        index += 1
      }
      appendBlock(.blockquote(quoteLines))
      continue
    }

    if isMarkdownTableHeader(lines: lines, index: index) {
      let headers = splitMarkdownTableRow(lines[index])
      index += 2
      var rows: [[String]] = []
      while index < lines.count, lines[index].contains("|") {
        rows.append(splitMarkdownTableRow(lines[index]))
        index += 1
      }
      appendBlock(.table(headers: headers, rows: rows))
      continue
    }

    if let unordered = parseList(startingAt: index, in: lines, ordered: false) {
      appendBlock(.unorderedList(unordered.items))
      index = unordered.nextIndex
      continue
    }

    if let ordered = parseList(startingAt: index, in: lines, ordered: true) {
      appendBlock(.orderedList(start: ordered.startNumber ?? 1, items: ordered.items))
      index = ordered.nextIndex
      continue
    }

    var paragraphLines: [String] = []
    while index < lines.count {
      let value = lines[index].trimmingCharacters(in: .whitespaces)
      if value.isEmpty || value.hasPrefix("```") || value.hasPrefix(">") || isMarkdownTableHeader(lines: lines, index: index) || isMarkdownListItem(value, ordered: false) || isMarkdownListItem(value, ordered: true) || ["---", "***", "___"].contains(value) {
        break
      }
      // Only break for REAL headings (hashes followed by text). A line of
      // only '#' characters is not matched by the heading branch above, so
      // breaking on it here would leave `index` unadvanced and spin this
      // parser forever — streaming snapshots routinely end mid-heading
      // (e.g. the text so far is exactly "#").
      if value.hasPrefix("#"), value.contains(where: { $0 != "#" }) { break }
      paragraphLines.append(lines[index])
      index += 1
    }
    appendParagraph(paragraphLines)
  }

  return blocks
}

func parseList(startingAt index: Int, in lines: [String], ordered: Bool) -> (items: [String], nextIndex: Int, startNumber: Int?)? {
  guard index < lines.count else { return nil }
  guard let regex = workMarkdownListRegex(ordered: ordered) else { return nil }
  var cursor = index
  var items: [String] = []
  var startNumber: Int?
  while cursor < lines.count {
    let line = lines[cursor].trimmingCharacters(in: .whitespaces)
    guard let item = markdownListItemText(line, regex: regex) else { break }
    if ordered, startNumber == nil {
      startNumber = markdownOrderedListItemNumber(line)
    }
    items.append(item)
    cursor += 1
  }
  return items.isEmpty ? nil : (items, cursor, startNumber)
}

func isMarkdownListItem(_ line: String, ordered: Bool) -> Bool {
  guard let regex = workMarkdownListRegex(ordered: ordered) else { return false }
  return markdownListItemText(line, regex: regex) != nil
}

func isMarkdownTableHeader(lines: [String], index: Int) -> Bool {
  guard index + 1 < lines.count else { return false }
  let header = lines[index]
  let separator = lines[index + 1].trimmingCharacters(in: .whitespaces)
  return header.contains("|") && separator.contains("|") && separator.replacingOccurrences(of: "|", with: "").allSatisfy { $0 == "-" || $0 == ":" || $0 == " " }
}

func markdownListItemText(_ line: String, regex: NSRegularExpression) -> String? {
  let range = NSRange(location: 0, length: (line as NSString).length)
  guard let match = regex.firstMatch(in: line, options: [], range: range) else { return nil }
  var text = (line as NSString).substring(from: match.range.length)
  // GFM task lists: render the checkbox marker as a glyph instead of leaking
  // literal "[ ]" / "[x]" into the prose (desktop's remark-gfm renders real
  // checkboxes for these).
  if text.hasPrefix("[ ] ") {
    text = "☐ " + text.dropFirst(4)
  } else if text.hasPrefix("[x] ") || text.hasPrefix("[X] ") {
    text = "☑ " + text.dropFirst(4)
  }
  return text
}

func markdownOrderedListItemNumber(_ line: String) -> Int? {
  guard let regex = ADECodeRenderingCache.shared.regex(for: #"^(\d+)\.\s+"#) else { return nil }
  let range = NSRange(location: 0, length: (line as NSString).length)
  guard let match = regex.firstMatch(in: line, options: [], range: range),
        match.numberOfRanges > 1,
        let numberRange = Range(match.range(at: 1), in: line)
  else { return nil }
  return Int(String(line[numberRange]))
}

func workMarkdownListRegex(ordered: Bool) -> NSRegularExpression? {
  let pattern = ordered ? #"^\d+\.\s+"# : #"^[-*+]\s+"#
  return ADECodeRenderingCache.shared.regex(for: pattern)
}

func splitMarkdownTableRow(_ row: String) -> [String] {
  var cells = row
    .split(separator: "|", omittingEmptySubsequences: false)
    .map { $0.trimmingCharacters(in: .whitespaces) }
  if cells.first == "" {
    cells.removeFirst()
  }
  if cells.last == "" {
    cells.removeLast()
  }
  return cells
}

/// LRU cache for parsed markdown. Chat messages re-render on every transcript
/// change, and `AttributedString(markdown:)` is not cheap — caching saves us
/// from reparsing the same paragraph every frame during a streaming turn.
private final class WorkMarkdownCacheBox {
  let value: AttributedString
  init(_ value: AttributedString) { self.value = value }
}

private final class WorkMarkdownBlocksCacheBox: NSObject {
  let value: [WorkMarkdownBlock]

  init(_ value: [WorkMarkdownBlock]) {
    self.value = value
  }
}

private let workMarkdownCache: NSCache<NSString, WorkMarkdownCacheBox> = {
  let cache = NSCache<NSString, WorkMarkdownCacheBox>()
  cache.countLimit = 256
  return cache
}()

private let workMarkdownBlocksCache: NSCache<NSString, WorkMarkdownBlocksCacheBox> = {
  let cache = NSCache<NSString, WorkMarkdownBlocksCacheBox>()
  cache.countLimit = 128
  return cache
}()

/// Per-message state for `parseMarkdownBlocksForStreaming`, keyed by message
/// id. Immutable snapshot box (replaced wholesale on each delta) so concurrent
/// readers never observe a half-updated entry. Only one message streams at a
/// time per session, so the limit stays tiny.
private final class WorkStreamingMarkdownCacheBox: NSObject {
  let prefixText: String
  let prefixBlocks: [WorkMarkdownBlock]
  let fullText: String
  let blocks: [WorkMarkdownBlock]

  init(prefixText: String, prefixBlocks: [WorkMarkdownBlock], fullText: String, blocks: [WorkMarkdownBlock]) {
    self.prefixText = prefixText
    self.prefixBlocks = prefixBlocks
    self.fullText = fullText
    self.blocks = blocks
  }
}

private let workStreamingMarkdownCache: NSCache<NSString, WorkStreamingMarkdownCacheBox> = {
  let cache = NSCache<NSString, WorkStreamingMarkdownCacheBox>()
  cache.countLimit = 8
  return cache
}()

func workStableDigest(_ string: String) -> String {
  var hash: UInt64 = 0xcbf29ce484222325
  for byte in string.utf8 {
    hash ^= UInt64(byte)
    hash &*= 0x100000001b3
  }
  return String(hash, radix: 16, uppercase: false)
}

func markdownAttributedString(_ text: String) -> AttributedString {
  let key = text as NSString
  if let cached = workMarkdownCache.object(forKey: key) {
    return cached.value
  }

  // Preserve line breaks so multi-line paragraphs render correctly — the
  // default `AttributedString(markdown:)` initializer collapses them.
  let options = AttributedString.MarkdownParsingOptions(
    interpretedSyntax: .inlineOnlyPreservingWhitespace
  )
  guard var attributed = try? AttributedString(markdown: text, options: options) else {
    let fallback = AttributedString(text)
    workMarkdownCache.setObject(WorkMarkdownCacheBox(fallback), forKey: key)
    return fallback
  }

  // Give inline code runs the desktop "pill" look: tinted background,
  // monospaced font, and a slight accent on the foreground color so
  // identifiers / branch names / file paths visually pop from prose.
  // Strikethrough intent is mapped explicitly — SwiftUI does not reliably
  // draw it from the presentation intent alone, which left ~~text~~ looking
  // like plain prose on mobile while desktop (remark-gfm) struck it through.
  for run in attributed.runs {
    let intent = run.inlinePresentationIntent ?? []
    let range = run.range
    if intent.contains(.strikethrough) {
      attributed[range].strikethroughStyle = .single
    }
    guard intent.contains(.code) else { continue }
    attributed[range].backgroundColor = ADEColor.accent.opacity(0.14)
    attributed[range].foregroundColor = ADEColor.accent
    attributed[range].font = Font.system(.caption, design: .monospaced).weight(.semibold)
  }

  // GFM autolinks: desktop linkifies bare URLs via remark-gfm; Apple's
  // markdown parser only links explicit [text](url) syntax. Linkify bare
  // URLs when the parser produced none (results are LRU-cached, so the
  // detector does not run per frame during streaming).
  if text.contains("http"), attributed.runs.allSatisfy({ $0.link == nil }) {
    let plain = String(attributed.characters)
    if let detector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
      let matches = detector.matches(in: plain, options: [], range: NSRange(plain.startIndex..., in: plain))
      for match in matches {
        guard let url = match.url,
              let stringRange = Range(match.range, in: plain),
              let lower = AttributedString.Index(stringRange.lowerBound, within: attributed),
              let upper = AttributedString.Index(stringRange.upperBound, within: attributed)
        else { continue }
        attributed[lower..<upper].link = url
        attributed[lower..<upper].foregroundColor = ADEColor.accent
        attributed[lower..<upper].underlineStyle = .single
      }
    }
  }

  workMarkdownCache.setObject(WorkMarkdownCacheBox(attributed), forKey: key)
  return attributed
}
