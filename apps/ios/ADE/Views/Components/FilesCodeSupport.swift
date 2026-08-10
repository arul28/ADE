import SwiftUI

enum FilesLanguage: String, CaseIterable, Hashable {
  case swift
  case typescript
  case javascript
  case python
  case rust
  case go
  case java
  case html
  case css
  case json
  case yaml
  case markdown
  case plaintext

  var displayName: String {
    switch self {
    case .swift: return "Swift"
    case .typescript: return "TypeScript"
    case .javascript: return "JavaScript"
    case .python: return "Python"
    case .rust: return "Rust"
    case .go: return "Go"
    case .java: return "Java"
    case .html: return "HTML"
    case .css: return "CSS"
    case .json: return "JSON"
    case .yaml: return "YAML"
    case .markdown: return "Markdown"
    case .plaintext: return "Plain text"
    }
  }

  static func detect(languageId: String?, filePath: String) -> FilesLanguage {
    if let detected = detect(languageHint: languageId) {
      return detected
    }
    return detect(path: filePath)
  }

  private static func detect(languageHint: String?) -> FilesLanguage? {
    guard let languageHint else { return nil }
    switch languageHint.lowercased() {
    case "swift":
      return .swift
    case "typescript", "typescriptreact", "tsx", "ts":
      return .typescript
    case "javascript", "javascriptreact", "jsx", "js", "mjs", "cjs":
      return .javascript
    case "python", "py":
      return .python
    case "rust", "rs":
      return .rust
    case "go", "golang":
      return .go
    case "java":
      return .java
    case "html":
      return .html
    case "css", "scss", "sass", "less":
      return .css
    case "json", "jsonc":
      return .json
    case "yaml", "yml":
      return .yaml
    case "markdown", "md", "mdx":
      return .markdown
    default:
      return nil
    }
  }

  private static func detect(path: String) -> FilesLanguage {
    let lowercased = path.lowercased()
    let ext = (lowercased as NSString).pathExtension
    switch ext {
    case "swift":
      return .swift
    case "ts", "tsx", "mts", "cts":
      return .typescript
    case "js", "jsx", "mjs", "cjs":
      return .javascript
    case "py":
      return .python
    case "rs":
      return .rust
    case "go":
      return .go
    case "java":
      return .java
    case "html", "htm":
      return .html
    case "css", "scss", "sass", "less":
      return .css
    case "json", "jsonc":
      return .json
    case "yaml", "yml":
      return .yaml
    case "md", "mdx":
      return .markdown
    default:
      if lowercased.hasSuffix(".env") || lowercased.contains(".env.") {
        return .yaml
      }
      return .plaintext
    }
  }
}

enum SyntaxTokenRole: Equatable {
  case keyword
  case string
  case comment
  case type
  case number
  case heading
  case link
}

struct SyntaxToken: Identifiable, Equatable {
  var id: String { "\(role)-\(range.location)-\(range.length)-\(text)" }
  let text: String
  let role: SyntaxTokenRole
  let range: NSRange
}

/// The already-highlighted stable prefix of the code block currently streaming
/// in a given language. It always ends just past a newline that no token spans,
/// so re-highlighting from there cannot disagree with a whole-text render.
struct SyntaxHighlightPrefix {
  let text: String
  let attributed: AttributedString
}

/// The delimiters whose matches can run across a newline, per language.
///
/// Nearly every rule here can: not only block comments and backticks, but any
/// `"(?:[^"\\]|\\.)*"` string, because `[^"\\]` matches `\n`. Which characters
/// those are is language-specific — `'` opens a string in Python but not in
/// JSON, and Go's raw backticks process no escapes — so the boundary scan reads
/// this table instead of assuming one grammar for every language.
struct SyntaxMultilineDelimiters {
  /// A delimiter that is its own closer (`"`, `'`, `` ` ``).
  ///
  /// `escapes` mirrors whether that rule's pattern consumes `\\.`. It is per
  /// delimiter, not per language: Go's `"` strings take escapes while its raw
  /// backtick strings do not, and getting it wrong in either direction
  /// mis-counts the delimiter and flips parity for every following line.
  struct Symmetric {
    let character: Character
    var escapes: Bool = true
  }

  var symmetric: [Symmetric] = []
  /// Open/close pairs (`/* */`, `<!-- -->`). Neither processes escapes.
  var pairs: [(open: String, close: String)] = []

  static let none = SyntaxMultilineDelimiters()
}

/// UTF-16 offset just past the last newline at which every multi-line delimiter
/// is balanced, or 0 when there is no such newline.
///
/// This asks a deliberately weaker question than "what is open here?". A state
/// machine would have to model how the rules interact, but the tokenizer runs
/// each rule independently over the whole text, so a `'` inside a `//` comment
/// really does start a string match. Balance can't be fooled that way: an
/// unbalanced delimiter anywhere since the last boundary simply refuses the
/// split. Wrong guesses only ever cost a shorter prefix — never a wrong render.
///
/// The tokens themselves can't answer this either: while a block comment is
/// still unterminated mid-stream, no token covers it yet, and a boundary placed
/// inside it would be frozen in before the closer arrives.
/// Scanning resumes at `startOffset`, which must itself be a confirmed boundary:
/// everything before it is balanced by definition, so the counts start clean and
/// the per-tick cost is the length of the new tail rather than the whole block.
private func syntaxStableBoundaryOffset(
  in text: String,
  from startOffset: Int,
  delimiters: SyntaxMultilineDelimiters
) -> Int {
  guard !text.isEmpty, startOffset <= text.utf16.count else { return startOffset }
  let start = String.Index(utf16Offset: startOffset, in: text)

  // Each symmetric delimiter is counted with its own escape rule, so one
  // delimiter's escapes cannot mis-count another's.
  var counts = [Int](repeating: 0, count: delimiters.symmetric.count)
  var pendingEscape = [Bool](repeating: false, count: delimiters.symmetric.count)
  var pairDepths = [Int](repeating: 0, count: delimiters.pairs.count)
  var boundary = startOffset
  var offset = startOffset
  var index = start

  func isBalanced() -> Bool {
    counts.allSatisfy { $0 % 2 == 0 } && pairDepths.allSatisfy { $0 == 0 }
  }

  while index < text.endIndex {
    let character = text[index]
    let width = character.utf16.count

    if character == "\n" {
      if isBalanced() {
        boundary = offset + width
        // Everything before here is confirmed closed, so later lines start clean.
        for position in counts.indices { counts[position] = 0 }
      }
      for position in pendingEscape.indices { pendingEscape[position] = false }
      offset += width
      index = text.index(after: index)
      continue
    }

    var matchedPair = false
    for (position, pair) in delimiters.pairs.enumerated() {
      if syntaxMatches(pair.open, in: text, at: index) {
        pairDepths[position] += 1
        offset += pair.open.utf16.count
        index = text.index(index, offsetBy: pair.open.count)
        matchedPair = true
        break
      }
      if syntaxMatches(pair.close, in: text, at: index) {
        pairDepths[position] = max(0, pairDepths[position] - 1)
        offset += pair.close.utf16.count
        index = text.index(index, offsetBy: pair.close.count)
        matchedPair = true
        break
      }
    }
    if matchedPair { continue }

    for (position, delimiter) in delimiters.symmetric.enumerated() {
      if pendingEscape[position] {
        pendingEscape[position] = false
        continue
      }
      if character == "\\", delimiter.escapes {
        pendingEscape[position] = true
        continue
      }
      if character == delimiter.character {
        counts[position] += 1
      }
    }

    offset += width
    index = text.index(after: index)
  }
  return boundary
}

/// Whether `marker` occurs at `index` without running past the end of `text`.
private func syntaxMatches(_ marker: String, in text: String, at index: String.Index) -> Bool {
  var cursor = index
  for character in marker {
    guard cursor < text.endIndex, text[cursor] == character else { return false }
    cursor = text.index(after: cursor)
  }
  return true
}


struct SyntaxHighlighter {
  static func tokenize(_ text: String, as language: FilesLanguage) -> [SyntaxToken] {
    let cacheKey = "tokens|\(language.rawValue)|\(workStableDigest(text))"
    if let cached = ADECodeRenderingCache.shared.tokens(for: cacheKey) {
      return cached
    }

    let nsText = text as NSString
    let rules = tokenRules(for: language)
    let tokens = rules
      .flatMap { rule in
        regexMatches(pattern: rule.pattern, in: text).map { match in
          SyntaxToken(
            text: nsText.substring(with: match.range),
            role: rule.role,
            range: match.range
          )
        }
      }
      .sorted {
        if $0.range.location == $1.range.location {
          return $0.range.length < $1.range.length
        }
        return $0.range.location < $1.range.location
      }

    ADECodeRenderingCache.shared.storeTokens(tokens, for: cacheKey)
    return tokens
  }

  /// Syntax-highlights a code block, incrementally while it is still streaming.
  ///
  /// A streaming block grows by a few characters per delta. Highlighting the
  /// whole text each time is O(n) regex work *plus* O(n) attribute application
  /// per token, which made a long block the most expensive main-thread path in
  /// an agent reply. This mirrors what `parseMarkdownBlocksForStreaming` does
  /// for prose: everything up to the last line boundary that is provably outside
  /// a multi-line construct can never be re-interpreted by text arriving later,
  /// so it is highlighted once and reused; only the growing tail is re-scanned.
  static func highlightedAttributedString(_ text: String, as language: FilesLanguage) -> AttributedString {
    let cacheKey = "highlighted|\(language.rawValue)|\(workStableDigest(text))"
    if let cached = ADECodeRenderingCache.shared.highlightedString(for: cacheKey) {
      return cached
    }

    let attributed = incrementallyHighlighted(text, as: language)
    ADECodeRenderingCache.shared.storeHighlightedString(attributed, for: cacheKey)
    return attributed
  }

  private static func incrementallyHighlighted(
    _ text: String,
    as language: FilesLanguage
  ) -> AttributedString {
    let reusable = ADECodeRenderingCache.shared.highlightPrefix(for: language)
      .flatMap { prefix -> SyntaxHighlightPrefix? in
        // Byte-prefix check: only a block that literally grew from this prefix
        // may reuse it. A different block of the same language starts over.
        guard !prefix.text.isEmpty, text.hasPrefix(prefix.text) else { return nil }
        return prefix
      }

    // The scan and both highlight passes start at the reused prefix, so a tick
    // costs the length of the new tail rather than the whole block.
    let scanOffset = reusable.map { $0.text.utf16.count } ?? 0
    let boundaryOffset = syntaxStableBoundaryOffset(
      in: text,
      from: scanOffset,
      delimiters: multilineDelimiters(for: language)
    )

    let boundary = String.Index(utf16Offset: boundaryOffset, in: text)
    let scanStart = String.Index(utf16Offset: scanOffset, in: text)

    var attributed = reusable?.attributed ?? AttributedString()
    if boundary > scanStart {
      attributed.append(highlightedSegment(text[scanStart..<boundary], as: language))
    }
    ADECodeRenderingCache.shared.storeHighlightPrefix(
      SyntaxHighlightPrefix(text: String(text[..<boundary]), attributed: attributed),
      for: language
    )

    guard boundary < text.endIndex else { return attributed }
    var result = attributed
    result.append(highlightedSegment(text[boundary...], as: language))
    return result
  }

  /// Highlights one self-contained segment.
  ///
  /// Built by appending styled pieces in order rather than by assigning into
  /// ranges of an existing `AttributedString`. Range assignment needs an index
  /// per token, and deriving each one from `startIndex` is what made a long
  /// block quadratic — while *retaining* an index across the assignment that
  /// follows it is undefined, since attribute mutation invalidates indices.
  /// Appending needs no `AttributedString` index at all, and the only cursor it
  /// keeps is a `String.Index` into immutable text.
  ///
  /// Applied to a whole code block this is the non-incremental reference
  /// rendering, which is what the equivalence tests compare against.
  static func highlightedSegment(
    _ segment: Substring,
    as language: FilesLanguage
  ) -> AttributedString {
    let text = String(segment)
    guard !text.isEmpty else { return AttributedString() }
    let tokens = tokenize(text, as: language)

    // Rules match independently, so a `.type` inside a string or a keyword
    // inside a comment produces overlapping ranges — including a short token
    // fully contained in a long one. Assigning attributes in sorted order let
    // the later token win the overlapping positions and left the rest of the
    // earlier token intact; painting per position reproduces that precedence
    // exactly, without needing an index into the string being built.
    let utf16Count = text.utf16.count
    var roles = [SyntaxTokenRole?](repeating: nil, count: utf16Count)
    for token in tokens {
      let lower = max(0, token.range.location)
      let upper = min(utf16Count, NSMaxRange(token.range))
      guard lower < upper else { continue }
      for position in lower..<upper {
        roles[position] = token.role
      }
    }

    var result = AttributedString()
    var runStart = text.startIndex
    var runRole: SyntaxTokenRole?
    var index = text.startIndex
    var offset = 0
    while index < text.endIndex {
      // Sampled at character starts only, so a token range that splits a
      // surrogate pair can never split a character's styling.
      let role = offset < utf16Count ? roles[offset] : nil
      if role != runRole {
        appendRun(text[runStart..<index], role: runRole, to: &result)
        runStart = index
        runRole = role
      }
      offset += text[index].utf16.count
      index = text.index(after: index)
    }
    appendRun(text[runStart...], role: runRole, to: &result)
    return result
  }

  private static func appendRun(
    _ text: Substring,
    role: SyntaxTokenRole?,
    to result: inout AttributedString
  ) {
    guard !text.isEmpty else { return }
    var run = AttributedString(text)
    run.font = role?.font ?? .system(.body, design: .monospaced)
    run.foregroundColor = role?.tint ?? ADEColor.textPrimary
    result.append(run)
  }

  private static func regexMatches(pattern: String, in text: String) -> [NSTextCheckingResult] {
    guard let regex = ADECodeRenderingCache.shared.regex(for: pattern) else {
      return []
    }
    return regex.matches(in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length))
  }

  /// Mirrors the newline-crossing constructs in `tokenRules(for:)`. Keep the two
  /// in step: a delimiter missing here can let the stable prefix split inside a
  /// construct, and an extra one only shortens the prefix.
  static func multilineDelimiters(for language: FilesLanguage) -> SyntaxMultilineDelimiters {
    typealias Symmetric = SyntaxMultilineDelimiters.Symmetric
    let blockComment = [(open: "/*", close: "*/")]
    let quote = Symmetric(character: "\"")
    let apostrophe = Symmetric(character: "'")
    switch language {
    case .swift:
      return SyntaxMultilineDelimiters(symmetric: [quote], pairs: blockComment)
    case .typescript, .javascript:
      return SyntaxMultilineDelimiters(
        symmetric: [quote, apostrophe, Symmetric(character: "`")],
        pairs: blockComment
      )
    case .python:
      return SyntaxMultilineDelimiters(symmetric: [quote, apostrophe])
    case .rust, .java:
      return SyntaxMultilineDelimiters(symmetric: [quote, apostrophe], pairs: blockComment)
    case .go:
      // Raw strings are backtick-delimited and process no escapes, so a
      // backslash before the closing backtick does not escape it.
      return SyntaxMultilineDelimiters(
        symmetric: [quote, Symmetric(character: "`", escapes: false)],
        pairs: blockComment
      )
    case .html:
      return SyntaxMultilineDelimiters(
        symmetric: [quote, apostrophe],
        pairs: [(open: "<!--", close: "-->")]
      )
    case .css:
      return SyntaxMultilineDelimiters(symmetric: [quote, apostrophe], pairs: blockComment)
    case .json:
      return SyntaxMultilineDelimiters(symmetric: [quote])
    case .yaml:
      return SyntaxMultilineDelimiters(symmetric: [quote, apostrophe])
    case .markdown:
      // Covers both `inline` and ``` fences: a fence is three backticks, so an
      // open fence reads as unbalanced until its closer arrives.
      return SyntaxMultilineDelimiters(symmetric: [Symmetric(character: "`", escapes: false)])
    case .plaintext:
      return .none
    }
  }

  private static func tokenRules(for language: FilesLanguage) -> [TokenRule] {
    let numberRule = TokenRule(role: .number, pattern: #"\b\d+(?:\.\d+)?\b"#)
    switch language {
    case .swift:
      return [
        TokenRule(role: .comment, pattern: #"(?m)//.*$|(?s)/\*.*?\*/"#),
        TokenRule(role: .string, pattern: #""(?:[^"\\]|\\.)*""#),
        TokenRule(role: .keyword, pattern: #"\b(import|struct|class|actor|enum|protocol|extension|func|let|var|if|else|guard|return|async|await|throws|throw|try|for|in|while|switch|case|default|private|fileprivate|internal|public|open|static)\b"#),
        TokenRule(role: .type, pattern: #"\b[A-Z][A-Za-z0-9_]*\b"#),
        numberRule,
      ]
    case .typescript:
      return [
        TokenRule(role: .comment, pattern: #"(?m)//.*$|(?s)/\*.*?\*/"#),
        TokenRule(role: .string, pattern: #""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`"#),
        TokenRule(role: .keyword, pattern: #"\b(export|import|from|as|async|await|function|const|let|var|return|type|interface|extends|implements|if|else|for|while|switch|case|default|new|class|public|private|protected)\b"#),
        TokenRule(role: .type, pattern: #"\b[A-Z][A-Za-z0-9_]*\b"#),
        numberRule,
      ]
    case .javascript:
      return [
        TokenRule(role: .comment, pattern: #"(?m)//.*$|(?s)/\*.*?\*/"#),
        TokenRule(role: .string, pattern: #""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`"#),
        TokenRule(role: .keyword, pattern: #"\b(export|import|from|as|async|await|function|const|let|var|return|if|else|for|while|switch|case|default|new|class)\b"#),
        TokenRule(role: .type, pattern: #"\b[A-Z][A-Za-z0-9_]*\b"#),
        numberRule,
      ]
    case .python:
      return [
        TokenRule(role: .comment, pattern: #"(?m)#.*$"#),
        TokenRule(role: .string, pattern: #""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'"#),
        TokenRule(role: .keyword, pattern: #"\b(def|class|import|from|as|return|if|elif|else|for|while|try|except|finally|with|async|await|lambda|pass|raise|yield|True|False|None)\b"#),
        TokenRule(role: .type, pattern: #"\b[A-Z][A-Za-z0-9_]*\b"#),
        numberRule,
      ]
    case .rust:
      return [
        TokenRule(role: .comment, pattern: #"(?m)//.*$|(?s)/\*.*?\*/"#),
        TokenRule(role: .string, pattern: #""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'"#),
        TokenRule(role: .keyword, pattern: #"\b(fn|let|mut|impl|trait|struct|enum|pub|crate|use|mod|match|if|else|for|while|loop|return|async|await|move|where)\b"#),
        TokenRule(role: .type, pattern: #"\b[A-Z][A-Za-z0-9_]*\b"#),
        numberRule,
      ]
    case .go:
      return [
        TokenRule(role: .comment, pattern: #"(?m)//.*$|(?s)/\*.*?\*/"#),
        TokenRule(role: .string, pattern: #"`(?:.|\n)*?`|"(?:[^"\\]|\\.)*""#),
        TokenRule(role: .keyword, pattern: #"\b(package|import|func|type|struct|interface|map|chan|go|defer|if|else|for|range|return|switch|case|default|var|const)\b"#),
        TokenRule(role: .type, pattern: #"\b[A-Z][A-Za-z0-9_]*\b"#),
        numberRule,
      ]
    case .java:
      return [
        TokenRule(role: .comment, pattern: #"(?m)//.*$|(?s)/\*.*?\*/"#),
        TokenRule(role: .string, pattern: #""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'"#),
        TokenRule(role: .keyword, pattern: #"\b(package|import|class|interface|enum|public|private|protected|static|final|void|new|return|if|else|for|while|switch|case|default|extends|implements|throws|try|catch)\b"#),
        TokenRule(role: .type, pattern: #"\b[A-Z][A-Za-z0-9_]*\b"#),
        numberRule,
      ]
    case .html:
      return [
        TokenRule(role: .comment, pattern: #"(?s)<!--.*?-->"#),
        TokenRule(role: .string, pattern: #""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'"#),
        TokenRule(role: .keyword, pattern: #"</?[A-Za-z][A-Za-z0-9:-]*|/>|>"#),
      ]
    case .css:
      return [
        TokenRule(role: .comment, pattern: #"(?s)/\*.*?\*/"#),
        TokenRule(role: .string, pattern: #""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'"#),
        TokenRule(role: .keyword, pattern: #"(?m)^[\.#]?[A-Za-z][A-Za-z0-9_\-:#\.\s,>+~]*\s*\{|\b(display|color|background|padding|margin|border|font|grid|flex|position|inset|width|height)\b"#),
        numberRule,
      ]
    case .json:
      return [
        TokenRule(role: .string, pattern: #""(?:[^"\\]|\\.)*"(?=\s*:)"#),
        TokenRule(role: .keyword, pattern: #"\b(true|false|null)\b"#),
        TokenRule(role: .number, pattern: #"\b-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b"#),
      ]
    case .yaml:
      return [
        TokenRule(role: .comment, pattern: #"(?m)#.*$"#),
        TokenRule(role: .string, pattern: #""(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'"#),
        TokenRule(role: .keyword, pattern: #"(?m)^\s*[A-Za-z0-9_.-]+:(?=\s|$)|\b(true|false|null|yes|no|on|off)\b"#),
        numberRule,
      ]
    case .markdown:
      return [
        TokenRule(role: .heading, pattern: #"(?m)^#{1,6}\s.+$"#),
        TokenRule(role: .comment, pattern: #"(?m)^>\s.+$"#),
        TokenRule(role: .string, pattern: #"`[^`]+`|```(?:.|\n)*?```"#),
        TokenRule(role: .link, pattern: #"\[[^\]]+\]\([^\)]+\)"#),
      ]
    case .plaintext:
      return []
    }
  }
}

private struct TokenRule {
  let role: SyntaxTokenRole
  let pattern: String
}

// Not `private`: the highlighter's equivalence tests reproduce the previous
// whole-text algorithm as their baseline, and a baseline that substitutes its
// own colors cannot prove the two renderings agree.
extension SyntaxTokenRole {
  var tint: Color {
    switch self {
    case .keyword:
      return .purple
    case .string:
      return .green
    case .comment:
      return ADEColor.textSecondary
    case .type:
      return .blue
    case .number:
      return .orange
    case .heading:
      return .pink
    case .link:
      return .teal
    }
  }

  var font: Font {
    switch self {
    case .keyword, .type, .heading:
      return .system(.body, design: .monospaced).weight(.semibold)
    case .comment:
      return .system(.body, design: .monospaced)
    case .string, .number, .link:
      return .system(.body, design: .monospaced)
    }
  }
}

enum FilesInlineDiffKind: Equatable {
  case unchanged
  case added
  case removed
}

struct FilesInlineDiffLine: Identifiable, Equatable {
  let id: String
  let kind: FilesInlineDiffKind
  let text: String
  let originalLineNumber: Int?
  let modifiedLineNumber: Int?
}

func buildInlineDiffLines(original: String, modified: String) -> [FilesInlineDiffLine] {
  let originalLines = splitPreservingEmptyLines(original)
  let modifiedLines = splitPreservingEmptyLines(modified)

  guard !originalLines.isEmpty || !modifiedLines.isEmpty else {
    return []
  }

  let difference = modifiedLines.difference(from: originalLines)
  let removedOffsets = Set(difference.compactMap { change -> Int? in
    if case .remove(let offset, _, _) = change { return offset }
    return nil
  })
  let insertedOffsets = Set(difference.compactMap { change -> Int? in
    if case .insert(let offset, _, _) = change { return offset }
    return nil
  })
  var diffLines: [FilesInlineDiffLine] = []
  var originalIndex = 0
  var modifiedIndex = 0
  var originalLineNumber = 1
  var modifiedLineNumber = 1

  func appendLine(kind: FilesInlineDiffKind, text: String, originalLineNumber: Int?, modifiedLineNumber: Int?) {
    diffLines.append(
      FilesInlineDiffLine(
        id: "line-\(diffLines.count)-\(kind)-\(originalLineNumber ?? -1)-\(modifiedLineNumber ?? -1)",
        kind: kind,
        text: text,
        originalLineNumber: originalLineNumber,
        modifiedLineNumber: modifiedLineNumber
      )
    )
  }

  while originalIndex < originalLines.count || modifiedIndex < modifiedLines.count {
    while originalIndex < originalLines.count && removedOffsets.contains(originalIndex) {
      appendLine(
        kind: .removed,
        text: originalLines[originalIndex],
        originalLineNumber: originalLineNumber,
        modifiedLineNumber: nil
      )
      originalIndex += 1
      originalLineNumber += 1
    }

    while modifiedIndex < modifiedLines.count && insertedOffsets.contains(modifiedIndex) {
      appendLine(
        kind: .added,
        text: modifiedLines[modifiedIndex],
        originalLineNumber: nil,
        modifiedLineNumber: modifiedLineNumber
      )
      modifiedIndex += 1
      modifiedLineNumber += 1
    }

    if originalIndex < originalLines.count,
       modifiedIndex < modifiedLines.count,
       originalLines[originalIndex] == modifiedLines[modifiedIndex] {
      diffLines.append(
        FilesInlineDiffLine(
          id: "line-\(diffLines.count)-unchanged-\(originalLineNumber)-\(modifiedLineNumber)",
          kind: .unchanged,
          text: originalLines[originalIndex],
          originalLineNumber: originalLineNumber,
          modifiedLineNumber: modifiedLineNumber
        )
      )
      originalIndex += 1
      modifiedIndex += 1
      originalLineNumber += 1
      modifiedLineNumber += 1
    } else {
      if originalIndex < originalLines.count {
        appendLine(
          kind: .removed,
          text: originalLines[originalIndex],
          originalLineNumber: originalLineNumber,
          modifiedLineNumber: nil
        )
        originalIndex += 1
        originalLineNumber += 1
      }
      if modifiedIndex < modifiedLines.count {
        appendLine(
          kind: .added,
          text: modifiedLines[modifiedIndex],
          originalLineNumber: nil,
          modifiedLineNumber: modifiedLineNumber
        )
        modifiedIndex += 1
        modifiedLineNumber += 1
      }
    }
  }

  return diffLines
}

func fileIcon(for name: String) -> String {
  let lowercased = name.lowercased()
  let ext = (lowercased as NSString).pathExtension
  switch ext {
  case "swift", "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "c", "cpp", "cc", "h", "m", "mm", "java", "kt", "kts", "sh", "bash", "zsh":
    return "chevron.left.forwardslash.chevron.right"
  case "json", "yaml", "yml", "toml", "xml", "plist", "ini", "env":
    return "doc.badge.gearshape"
  case "md", "mdx", "txt", "rtf":
    return "doc.text"
  case "png", "jpg", "jpeg", "gif", "svg", "webp", "heic", "bmp", "tiff":
    return "photo"
  case "pdf":
    return "doc.richtext"
  case "zip", "tar", "gz", "bz2", "xz", "rar", "7z":
    return "doc.zipper"
  default:
    if lowercased.hasPrefix(".") || lowercased.hasSuffix(".env") || lowercased.contains(".env.") {
      return "doc.badge.gearshape"
    }
    return "doc"
  }
}

func formattedFileSize(_ bytes: Int) -> String {
  if bytes < 1024 { return "\(bytes) B" }
  if bytes < 1024 * 1024 { return "\(bytes / 1024) KB" }
  return String(format: "%.1f MB", Double(bytes) / 1_048_576.0)
}

func splitPreservingEmptyLines(_ text: String) -> [String] {
  guard !text.isEmpty else { return [] }
  return text.components(separatedBy: "\n")
}
