import Foundation

/// Swift mirror of the `markdown` node's subset.
///
/// Source of truth: `apps/desktop/src/shared/plugins/vocabularyMarkdown.ts`. The
/// other three clients call that module's `parseVocabMarkdown` directly, so they
/// cannot disagree with each other; this file is the only place the fourth
/// client could drift, and it is written arm for arm against that one so the
/// drift is visible in a diff rather than on a screen.
///
/// **Not `AttributedString(markdown:)` for the document.** Apple's parser is
/// used, but only for the leaf it is right for — see ``PluginVocabMarkdown`` at
/// the bottom of `PluginVocabularyMarkdownViews`. Handing it the whole document
/// would define a second subset: it does not draw a fenced block, it linkifies
/// nothing the shared parser linkifies, and `inlineOnlyPreservingWhitespace` —
/// the option the chat transcript uses — deliberately throws block structure
/// away. A phone showing an issue body as one grey paragraph while the desktop
/// showed headings and a checklist is exactly the break this node exists to
/// close.
///
/// **There is no HTML path here either.** The parser produces text runs with
/// boolean flags. SwiftUI's `Text` draws a `String` as characters, so
/// `<script>` is five words on a screen, not markup — the same structural
/// answer the TS module gives, reached the same way.
enum PluginVocabMarkdownLimits {
  static let maxChars = 4_000
  static let maxBlocks = 100
  /// Container nesting. A top-level block is depth 1.
  static let maxDepth = 3
  /// Runs in one block, after which the rest of the block is one plain run.
  static let maxSpans = 200
  /// A fence's info string, read down to its first word.
  static let maxLanguageChars = 32
}

/// One run of inline text and how it is drawn. Mirrors `VocabMarkdownSpan`.
///
/// Flags rather than nesting, so a run maps onto one `AttributedString` range
/// with its traits set — which is what SwiftUI wants and what the desktop's
/// nested `<strong><em>` means anyway.
struct PluginVocabMarkdownSpan: Equatable {
  var text: String
  var bold = false
  var italic = false
  var strike = false
  /// Inline code. Monospace, and never carries emphasis or a link.
  var code = false
  /// An `https:` destination, already through ``PluginInvokeResult/parseOpenURL(_:)``.
  var href: URL?
}

/// One row of a `list` block. `task` is present only for a task-list row, and is
/// drawn INERT — the plugin declared no action for a checkbox.
struct PluginVocabMarkdownItem: Equatable {
  enum Task: Equatable { case checked, unchecked }

  var task: Task?
  var blocks: [PluginVocabMarkdownBlock]
}

indirect enum PluginVocabMarkdownBlock: Equatable {
  case heading(level: Int, spans: [PluginVocabMarkdownSpan])
  case paragraph(spans: [PluginVocabMarkdownSpan])
  /// A fenced block. `language` is the info string's first word, lowercased.
  case code(language: String?, text: String)
  case quote(blocks: [PluginVocabMarkdownBlock])
  case list(ordered: Bool, start: Int, items: [PluginVocabMarkdownItem])
  case rule
}

struct PluginVocabMarkdownDocument: Equatable {
  var blocks: [PluginVocabMarkdownBlock] = []
  /// True when a ceiling stopped the walk and blocks were dropped. The view says
  /// so rather than ending mid-document.
  var truncated = false
}

// MARK: - Parser

enum PluginVocabMarkdownParser {
  /// Parse a document into the subset. Mirrors `parseVocabMarkdown`.
  static func parse(_ source: String) -> PluginVocabMarkdownDocument {
    var lines = source
      .replacingOccurrences(of: "\r\n", with: "\n")
      .replacingOccurrences(of: "\r", with: "\n")
      .components(separatedBy: "\n")
    // A final newline TERMINATES the last line rather than starting an empty one.
    if lines.count > 1, lines[lines.count - 1].isEmpty { lines.removeLast() }
    var budget = PluginVocabMarkdownLimits.maxBlocks
    let blocks = parseBlocks(lines, depth: 1, budget: &budget)
    return PluginVocabMarkdownDocument(blocks: blocks, truncated: budget <= 0)
  }

  // MARK: Blocks

  private static func isBlank(_ line: String) -> Bool {
    line.trimmingCharacters(in: .whitespaces).isEmpty
  }

  private static func indent(of line: String) -> Int {
    line.count - line.drop(while: { $0 == " " || $0 == "\t" }).count
  }

  /// A container's continuation lines: blank, or indented past its marker.
  private static func isContinuation(_ line: String, indent width: Int) -> Bool {
    isBlank(line) || indent(of: line) >= width
  }

  private static func parseBlocks(
    _ lines: [String],
    depth: Int,
    budget: inout Int
  ) -> [PluginVocabMarkdownBlock] {
    var blocks: [PluginVocabMarkdownBlock] = []
    let nestable = depth < PluginVocabMarkdownLimits.maxDepth
    var index = 0

    while index < lines.count {
      if budget <= 0 { return blocks }
      let line = lines[index]

      if isBlank(line) {
        index += 1
        continue
      }

      if let fence = readFence(line) {
        var body: [String] = []
        index += 1
        while index < lines.count {
          let candidate = lines[index].trimmingCharacters(in: .whitespaces)
          if candidate.count >= fence.marker.count,
             candidate.allSatisfy({ $0 == fence.marker.first }) {
            index += 1
            break
          }
          body.append(lines[index])
          index += 1
        }
        budget -= 1
        // An unclosed fence still renders: the alternative turns one missing
        // line into a page of source.
        blocks.append(.code(
          language: fence.language.isEmpty ? nil : fence.language,
          text: body.joined(separator: "\n")
        ))
        continue
      }

      if let heading = readHeading(line) {
        budget -= 1
        blocks.append(.heading(level: heading.level, spans: parseInline(heading.text)))
        index += 1
        continue
      }

      if isRule(line) {
        budget -= 1
        blocks.append(.rule)
        index += 1
        continue
      }

      if nestable, readQuote(line) != nil {
        var body: [String] = []
        while index < lines.count {
          if let quoted = readQuote(lines[index]) {
            body.append(quoted)
          } else if !isBlank(lines[index]), !body.isEmpty {
            body.append(lines[index])
          } else {
            break
          }
          index += 1
        }
        // The quote costs a block, then its content is parsed at depth + 1
        // against the same budget — nesting cannot buy more nodes.
        if budget <= 0 { break }
        budget -= 1
        blocks.append(.quote(blocks: parseBlocks(body, depth: depth + 1, budget: &budget)))
        continue
      }

      let bullet = nestable ? readBullet(line) : nil
      let ordered = nestable && bullet == nil ? readOrdered(line) : nil
      if bullet != nil || ordered != nil {
        let isOrdered = ordered != nil
        let start = ordered?.number ?? 1
        var items: [PluginVocabMarkdownItem] = []
        if budget <= 0 { break }
        budget -= 1
        while index < lines.count {
          let marker: (indent: Int, content: String)?
          if isOrdered, let match = readOrdered(lines[index]) {
            marker = (match.indent, match.content)
          } else if !isOrdered, let match = readBullet(lines[index]) {
            marker = (match.indent, match.content)
          } else {
            marker = nil
          }
          guard let marker else { break }
          let width = marker.indent + 2
          var body: [String] = []
          index += 1
          while index < lines.count, isContinuation(lines[index], indent: width) {
            // A blank line ends the item unless indented content follows it,
            // which is how a two-paragraph list row is written.
            if isBlank(lines[index]) {
              guard index + 1 < lines.count,
                    isContinuation(lines[index + 1], indent: width),
                    !isBlank(lines[index + 1]) else { break }
            }
            let stripped = String(lines[index].dropFirst(min(width, indent(of: lines[index]))))
            body.append(stripped)
            index += 1
          }
          let task = readTask(marker.content)
          var content = [task?.rest ?? marker.content]
          content.append(contentsOf: body)
          items.append(PluginVocabMarkdownItem(
            task: task?.task,
            blocks: parseBlocks(content, depth: depth + 1, budget: &budget)
          ))
          if budget <= 0 { break }
        }
        blocks.append(.list(ordered: isOrdered, start: start, items: items))
        continue
      }

      var paragraph: [String] = []
      while index < lines.count, !isBlank(lines[index]) {
        let next = lines[index]
        // A paragraph ends where another block begins.
        if !paragraph.isEmpty {
          let starts = readHeading(next) != nil || isRule(next) || readFence(next) != nil
            || (nestable && (readQuote(next) != nil || readBullet(next) != nil || readOrdered(next) != nil))
          if starts { break }
        }
        paragraph.append(next.trimmingCharacters(in: .whitespaces))
        index += 1
      }
      if !paragraph.isEmpty {
        if budget <= 0 { break }
        budget -= 1
        // Newlines survive inside a paragraph, the same promise `text` makes:
        // a plugin that wrote two lines meant two lines.
        blocks.append(.paragraph(spans: parseInline(paragraph.joined(separator: "\n"))))
      }
    }

    return blocks
  }

  // MARK: Line readers

  private static func readHeading(_ line: String) -> (level: Int, text: String)? {
    let trimmed = line.drop(while: { $0 == " " })
    guard line.count - trimmed.count <= 3 else { return nil }
    let hashes = trimmed.prefix(while: { $0 == "#" })
    guard !hashes.isEmpty, hashes.count <= 6 else { return nil }
    let rest = trimmed.dropFirst(hashes.count)
    guard rest.isEmpty || rest.first == " " || rest.first == "\t" else { return nil }
    var text = rest.trimmingCharacters(in: .whitespaces)
    // A closing run of hashes is decoration, not content.
    while text.hasSuffix("#") { text = String(text.dropLast()) }
    return (hashes.count, text.trimmingCharacters(in: .whitespaces))
  }

  private static func isRule(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard let first = trimmed.first, first == "-" || first == "*" || first == "_" else { return false }
    let marks = trimmed.filter { $0 == first }
    return marks.count >= 3 && trimmed.allSatisfy { $0 == first || $0 == " " }
  }

  private static func readFence(_ line: String) -> (marker: String, language: String)? {
    let trimmed = line.drop(while: { $0 == " " })
    guard line.count - trimmed.count <= 3, let first = trimmed.first, first == "`" || first == "~" else {
      return nil
    }
    let marker = trimmed.prefix(while: { $0 == first })
    guard marker.count >= 3 else { return nil }
    let info = trimmed.dropFirst(marker.count).trimmingCharacters(in: .whitespaces)
    let language = String(info.prefix(while: { !$0.isWhitespace }))
      .lowercased()
      .prefix(PluginVocabMarkdownLimits.maxLanguageChars)
    return (String(marker), String(language))
  }

  private static func readQuote(_ line: String) -> String? {
    let trimmed = line.drop(while: { $0 == " " })
    guard line.count - trimmed.count <= 3, trimmed.first == ">" else { return nil }
    var rest = trimmed.dropFirst()
    if rest.first == " " { rest = rest.dropFirst() }
    return String(rest)
  }

  private static func readBullet(_ line: String) -> (indent: Int, content: String)? {
    let width = indent(of: line)
    let rest = line.dropFirst(width)
    guard let first = rest.first, first == "-" || first == "*" || first == "+" else { return nil }
    let after = rest.dropFirst()
    guard let space = after.first, space == " " || space == "\t" else { return nil }
    return (width, String(after.drop(while: { $0 == " " || $0 == "\t" })))
  }

  private static func readOrdered(_ line: String) -> (indent: Int, number: Int, content: String)? {
    let width = indent(of: line)
    let rest = line.dropFirst(width)
    let digits = rest.prefix(while: { $0.isNumber })
    guard !digits.isEmpty, digits.count <= 9, let number = Int(digits) else { return nil }
    let after = rest.dropFirst(digits.count)
    guard let delimiter = after.first, delimiter == "." || delimiter == ")" else { return nil }
    let tail = after.dropFirst()
    guard let space = tail.first, space == " " || space == "\t" else { return nil }
    return (width, number, String(tail.drop(while: { $0 == " " || $0 == "\t" })))
  }

  private static func readTask(_ content: String) -> (task: PluginVocabMarkdownItem.Task, rest: String)? {
    guard content.count >= 4, content.first == "[" else { return nil }
    let characters = Array(content)
    guard characters[2] == "]", characters[3] == " " || characters[3] == "\t" else { return nil }
    let mark = characters[1]
    let rest = String(characters[4...]).drop(while: { $0 == " " || $0 == "\t" })
    if mark == " " { return (.unchecked, String(rest)) }
    if mark == "x" || mark == "X" { return (.checked, String(rest)) }
    return nil
  }

  // MARK: Inline

  private struct SpanStyle {
    var bold = false
    var italic = false
    var strike = false
    var href: URL?
  }

  /// ASCII punctuation a backslash may escape, per CommonMark.
  private static let escapable = Set("\\`*_{}[]()#+-.!|~<>\"'$%&,/:;=?@^")

  /// Append a run, merging it into the previous one when nothing about it
  /// changed. Mirrors `pushSpan`.
  private static func push(
    _ spans: inout [PluginVocabMarkdownSpan],
    _ text: String,
    _ style: SpanStyle,
    code: Bool = false
  ) {
    guard !text.isEmpty else { return }
    if var last = spans.last,
       last.bold == style.bold,
       last.italic == style.italic,
       last.strike == style.strike,
       last.href == style.href,
       last.code == code {
      last.text += text
      spans[spans.count - 1] = last
      return
    }
    spans.append(PluginVocabMarkdownSpan(
      text: text,
      bold: style.bold,
      italic: style.italic,
      strike: style.strike,
      code: code,
      href: style.href
    ))
  }

  /// Inline runs for one block's text. Mirrors `parseInline`, precedence and all:
  /// a code span swallows everything inside it, a link's text is parsed for
  /// emphasis but never for another link, and an unclosed delimiter is literal.
  static func parseInline(_ source: String) -> [PluginVocabMarkdownSpan] {
    parseInline(Array(source), style: SpanStyle(), depth: 0)
  }

  private static func parseInline(
    _ source: [Character],
    style: SpanStyle,
    depth: Int
  ) -> [PluginVocabMarkdownSpan] {
    var spans: [PluginVocabMarkdownSpan] = []
    var plain = ""
    var index = 0

    func flush() {
      push(&spans, plain, style)
      plain = ""
    }

    while index < source.count {
      let char = source[index]

      if char == "\\", index + 1 < source.count, escapable.contains(source[index + 1]) {
        plain.append(source[index + 1])
        index += 2
        continue
      }

      if char == "`" {
        var run = index
        while run < source.count, source[run] == "`" { run += 1 }
        let length = run - index
        if let close = findCodeCloser(source, from: run, length: length) {
          flush()
          var content = String(source[run..<close])
          if content.count > 2, content.hasPrefix(" "), content.hasSuffix(" ") {
            content = String(content.dropFirst().dropLast())
          }
          var codeStyle = SpanStyle()
          codeStyle.href = style.href
          push(&spans, content, codeStyle, code: true)
          index = close + length
          continue
        }
      }

      // `![alt](url)` — the image is omitted and the alt text stays.
      if char == "!", index + 1 < source.count, source[index + 1] == "[",
         let link = readLink(source, start: index + 1) {
        flush()
        spans.append(contentsOf: parseInline(Array(link.text), style: style, depth: depth + 1))
        index = link.end
        continue
      }

      // A link inside a link is not a thing: the reader would have no way to
      // tell which destination they were pressing.
      if char == "[", style.href == nil, depth < PluginVocabMarkdownLimits.maxDepth,
         let link = readLink(source, start: index) {
        flush()
        var nested = style
        // The SAME gate the `{openUrl}` action verb passes. A refused
        // destination keeps the words and loses the link.
        if let url = PluginInvokeResult.parseOpenURL(link.url) { nested.href = url }
        spans.append(contentsOf: parseInline(Array(link.text), style: nested, depth: depth + 1))
        index = link.end
        continue
      }

      // `<https://…>` — the one autolink form, because its bounds are written
      // down rather than guessed at by a detector.
      if char == "<", style.href == nil, let close = Self.index(of: ">", in: source, from: index + 1) {
        let inner = String(source[(index + 1)..<close])
        if !inner.contains(" "), let url = PluginInvokeResult.parseOpenURL(inner) {
          flush()
          var linked = style
          linked.href = url
          push(&spans, inner, linked)
          index = close + 1
          continue
        }
      }

      if depth < PluginVocabMarkdownLimits.maxDepth,
         let marker = emphasisMarker(source, at: index, style: style),
         let close = findCloser(source, from: index + marker.token.count, marker: marker.token),
         close > index + marker.token.count {
        flush()
        var inner = style
        if marker.bold { inner.bold = true }
        if marker.italic { inner.italic = true }
        if marker.strike { inner.strike = true }
        let slice = Array(source[(index + marker.token.count)..<close])
        spans.append(contentsOf: parseInline(slice, style: inner, depth: depth + 1))
        index = close + marker.token.count
        continue
      }

      plain.append(char)
      index += 1
    }

    flush()
    return capSpans(spans)
  }

  private static func index(of needle: Character, in source: [Character], from: Int) -> Int? {
    var index = from
    while index < source.count {
      if source[index] == needle { return index }
      index += 1
    }
    return nil
  }

  private static func startsWith(_ source: [Character], _ token: String, at index: Int) -> Bool {
    let characters = Array(token)
    guard index + characters.count <= source.count else { return false }
    for offset in 0..<characters.count where source[index + offset] != characters[offset] {
      return false
    }
    return true
  }

  private struct EmphasisMarker {
    var token: String
    var bold = false
    var italic = false
    var strike = false
  }

  private static func emphasisMarker(
    _ source: [Character],
    at index: Int,
    style: SpanStyle
  ) -> EmphasisMarker? {
    /// An opener sits against the text it opens: `* 3` is arithmetic, `*3` is not.
    func opens(_ length: Int) -> Bool {
      guard index + length < source.count else { return false }
      return !source[index + length].isWhitespace
    }
    if startsWith(source, "~~", at: index) {
      return style.strike || !opens(2) ? nil : EmphasisMarker(token: "~~", strike: true)
    }
    if startsWith(source, "**", at: index) || startsWith(source, "__", at: index) {
      guard !style.bold, opens(2) else { return nil }
      return EmphasisMarker(token: String(source[index...index + 1]), bold: true)
    }
    let char = source[index]
    guard char == "*" || char == "_", opens(1) else { return nil }
    // `snake_case_names` are not emphasis.
    if char == "_" {
      let before = index > 0 ? source[index - 1] : " "
      let after = index + 1 < source.count ? source[index + 1] : " "
      if before.isLetter || before.isNumber, after.isLetter || after.isNumber { return nil }
    }
    return style.italic ? nil : EmphasisMarker(token: String(char), italic: true)
  }

  /// A closing delimiter run of exactly `marker`, ignoring escaped characters.
  /// A closer may not sit against whitespace on its inner side.
  private static func findCloser(_ source: [Character], from: Int, marker: String) -> Int? {
    let width = marker.count
    var index = from
    while index + width <= source.count {
      if source[index] == "\\" {
        index += 2
        continue
      }
      if startsWith(source, marker, at: index), index > from, !source[index - 1].isWhitespace {
        return index
      }
      index += 1
    }
    return nil
  }

  /// A code span's closer: a backtick run of exactly `length`.
  private static func findCodeCloser(_ source: [Character], from: Int, length: Int) -> Int? {
    var index = from
    while index < source.count {
      guard source[index] == "`" else {
        index += 1
        continue
      }
      var end = index
      while end < source.count, source[end] == "`" { end += 1 }
      if end - index == length { return index }
      index = end
    }
    return nil
  }

  /// `[text](url)` starting at `[`. `nil` when either half does not close.
  private static func readLink(
    _ source: [Character],
    start: Int
  ) -> (text: String, url: String, end: Int)? {
    var depth = 0
    var index = start
    while index < source.count {
      let char = source[index]
      if char == "\\" {
        index += 2
        continue
      }
      if char == "[" {
        depth += 1
      } else if char == "]" {
        depth -= 1
        if depth == 0 { break }
      }
      index += 1
    }
    guard depth == 0, index + 1 < source.count, source[index + 1] == "(" else { return nil }
    // Balanced, not the first `)`: `[x](javascript:alert(1))` closes at the last
    // one, so the whole destination reaches the gate rather than a prefix.
    var close = index + 2
    var open = 0
    while close < source.count {
      let char = source[close]
      if char == "\\" {
        close += 2
        continue
      }
      if char == "(" {
        open += 1
      } else if char == ")" {
        if open == 0 { break }
        open -= 1
      }
      close += 1
    }
    guard close < source.count else { return nil }
    return (
      String(source[(start + 1)..<index]),
      String(source[(index + 2)..<close]).trimmingCharacters(in: .whitespaces),
      close + 1
    )
  }

  /// Fold everything past the span ceiling into one plain run. The text
  /// survives; only the styling past the ceiling does not.
  private static func capSpans(_ spans: [PluginVocabMarkdownSpan]) -> [PluginVocabMarkdownSpan] {
    let max = PluginVocabMarkdownLimits.maxSpans
    guard spans.count > max else { return spans }
    var kept = Array(spans.prefix(max - 1))
    kept.append(PluginVocabMarkdownSpan(text: spans.suffix(from: max - 1).map(\.text).joined()))
    return kept
  }
}
