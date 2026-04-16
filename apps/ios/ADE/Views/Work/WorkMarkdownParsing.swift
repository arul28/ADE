import SwiftUI
import UIKit
import AVKit

enum WorkMarkdownBlockKind {
  case paragraph(String)
  case heading(Int, String)
  case unorderedList([String])
  case orderedList([String])
  case blockquote([String])
  case table(headers: [String], rows: [[String]])
  case code(language: String?, code: String)
  case rule
}

struct WorkMarkdownBlock: Identifiable {
  let id = UUID().uuidString
  let kind: WorkMarkdownBlockKind
}

func parseMarkdownBlocks(_ markdown: String) -> [WorkMarkdownBlock] {
  let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
  var index = 0
  var blocks: [WorkMarkdownBlock] = []

  func appendParagraph(_ lines: [String]) {
    let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    if !text.isEmpty {
      blocks.append(WorkMarkdownBlock(kind: .paragraph(text)))
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
      blocks.append(WorkMarkdownBlock(kind: .code(language: language.isEmpty ? nil : language, code: codeLines.joined(separator: "\n"))))
      continue
    }

    if let heading = trimmed.firstIndex(where: { $0 != "#" }), heading > trimmed.startIndex, trimmed[..<heading].allSatisfy({ $0 == "#" }) {
      let level = trimmed[..<heading].count
      let text = trimmed[heading...].trimmingCharacters(in: .whitespaces)
      blocks.append(WorkMarkdownBlock(kind: .heading(level, text)))
      index += 1
      continue
    }

    if ["---", "***", "___"].contains(trimmed) {
      blocks.append(WorkMarkdownBlock(kind: .rule))
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
      blocks.append(WorkMarkdownBlock(kind: .blockquote(quoteLines)))
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
      blocks.append(WorkMarkdownBlock(kind: .table(headers: headers, rows: rows)))
      continue
    }

    if let unordered = parseList(startingAt: index, in: lines, ordered: false) {
      blocks.append(WorkMarkdownBlock(kind: .unorderedList(unordered.items)))
      index = unordered.nextIndex
      continue
    }

    if let ordered = parseList(startingAt: index, in: lines, ordered: true) {
      blocks.append(WorkMarkdownBlock(kind: .orderedList(ordered.items)))
      index = ordered.nextIndex
      continue
    }

    var paragraphLines: [String] = []
    while index < lines.count {
      let value = lines[index].trimmingCharacters(in: .whitespaces)
      if value.isEmpty || value.hasPrefix("```") || value.hasPrefix(">") || isMarkdownTableHeader(lines: lines, index: index) || parseList(startingAt: index, in: lines, ordered: false) != nil || parseList(startingAt: index, in: lines, ordered: true) != nil || ["---", "***", "___"].contains(value) {
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
  let pattern = ordered ? #"^\d+\.\s+"# : #"^[-*+]\s+"#
  guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
  var cursor = index
  var items: [String] = []
  while cursor < lines.count {
    let line = lines[cursor].trimmingCharacters(in: .whitespaces)
    let range = NSRange(location: 0, length: (line as NSString).length)
    guard let match = regex.firstMatch(in: line, options: [], range: range) else { break }
    let item = (line as NSString).substring(from: match.range.length)
    items.append(item)
    cursor += 1
  }
  return items.isEmpty ? nil : (items, cursor)
}

func isMarkdownTableHeader(lines: [String], index: Int) -> Bool {
  guard index + 1 < lines.count else { return false }
  let header = lines[index]
  let separator = lines[index + 1].trimmingCharacters(in: .whitespaces)
  return header.contains("|") && separator.contains("|") && separator.replacingOccurrences(of: "|", with: "").allSatisfy { $0 == "-" || $0 == ":" || $0 == " " }
}

func splitMarkdownTableRow(_ row: String) -> [String] {
  row
    .split(separator: "|", omittingEmptySubsequences: false)
    .map { $0.trimmingCharacters(in: .whitespaces) }
    .filter { !$0.isEmpty }
}

func markdownAttributedString(_ text: String) -> AttributedString {
  // Preserve line breaks so multi-line paragraphs render correctly — the
  // default `AttributedString(markdown:)` initializer collapses them.
  let options = AttributedString.MarkdownParsingOptions(
    interpretedSyntax: .inlineOnlyPreservingWhitespace
  )
  guard var attributed = try? AttributedString(markdown: text, options: options) else {
    return AttributedString(text)
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

  return attributed
}
