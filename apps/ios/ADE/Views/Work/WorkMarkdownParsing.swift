import SwiftUI
import UIKit
import AVKit

enum WorkMarkdownBlockKind: Equatable {
  case paragraph(String)
  case heading(Int, String)
  case unorderedList([String])
  case orderedList([String])
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
    case .orderedList(let items):
      return "orderedList|\(items.joined(separator: "\u{001F}"))"
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
      appendBlock(.orderedList(ordered.items))
      index = ordered.nextIndex
      continue
    }

    var paragraphLines: [String] = []
    while index < lines.count {
      let value = lines[index].trimmingCharacters(in: .whitespaces)
      if value.isEmpty || value.hasPrefix("```") || value.hasPrefix(">") || isMarkdownTableHeader(lines: lines, index: index) || isMarkdownListItem(value, ordered: false) || isMarkdownListItem(value, ordered: true) || ["---", "***", "___"].contains(value) {
        break
      }
      if value.hasPrefix("#") { break }
      paragraphLines.append(lines[index])
      index += 1
    }
    appendParagraph(paragraphLines)
  }

  return blocks
}

func parseList(startingAt index: Int, in lines: [String], ordered: Bool) -> (items: [String], nextIndex: Int)? {
  guard index < lines.count else { return nil }
  guard let regex = workMarkdownListRegex(ordered: ordered) else { return nil }
  var cursor = index
  var items: [String] = []
  while cursor < lines.count {
    let line = lines[cursor].trimmingCharacters(in: .whitespaces)
    guard let item = markdownListItemText(line, regex: regex) else { break }
    items.append(item)
    cursor += 1
  }
  return items.isEmpty ? nil : (items, cursor)
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
  return (line as NSString).substring(from: match.range.length)
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
  for run in attributed.runs {
    let intent = run.inlinePresentationIntent ?? []
    guard intent.contains(.code) else { continue }
    let range = run.range
    attributed[range].backgroundColor = ADEColor.accent.opacity(0.14)
    attributed[range].foregroundColor = ADEColor.accent
    attributed[range].font = Font.system(.caption, design: .monospaced).weight(.semibold)
  }

  workMarkdownCache.setObject(WorkMarkdownCacheBox(attributed), forKey: key)
  return attributed
}
