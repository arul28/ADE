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

/// Whether a scan position sits inside a construct that can span lines. Every
/// token rule is line-anchored except block comments and backtick / triple-quote
/// strings, so a line boundary reached with all of these clear is a point no
/// later text can reinterpret.
///
/// Ambiguity resolves toward "still inside": a false positive only stops the
/// stable prefix from growing (slower, still correct), while a false negative
/// would let a token straddle the split.
struct SyntaxNestingBalance: Equatable {
  var insideBlockComment = false
  var insideBacktick = false
  var insideTripleQuote = false

  var isClear: Bool {
    !insideBlockComment && !insideBacktick && !insideTripleQuote
  }
}

/// The already-highlighted stable prefix of the code block currently streaming
/// in a given language. It always ends just past a newline reached with no
/// multi-line construct open, so a resumed scan can start from a clear state.
struct SyntaxHighlightPrefix {
  let text: String
  let attributed: AttributedString
}

/// Returns the position just past the last newline in `text[start...]` reached
/// with no multi-line construct open (never earlier than `start`). `start` is
/// itself such a position, so the scan begins from a clear state.
private func syntaxStableBoundary(in text: String, from start: String.Index) -> String.Index {
  var balance = SyntaxNestingBalance()
  var boundary = start
  var index = start
  while index < text.endIndex {
    let character = text[index]
    let next = text.index(after: index)

    if character == "\n" {
      if balance.isClear { boundary = next }
      index = next
      continue
    }

    if balance.insideBlockComment {
      if character == "*", next < text.endIndex, text[next] == "/" {
        balance.insideBlockComment = false
        index = text.index(after: next)
        continue
      }
    } else if balance.insideBacktick {
      if character == "`" { balance.insideBacktick = false }
    } else if balance.insideTripleQuote {
      if syntaxIsTripleQuote(text, at: index) {
        balance.insideTripleQuote = false
        index = text.index(index, offsetBy: 3)
        continue
      }
    } else if character == "/", next < text.endIndex, text[next] == "*" {
      balance.insideBlockComment = true
      index = text.index(after: next)
      continue
    } else if character == "`" {
      balance.insideBacktick = true
    } else if syntaxIsTripleQuote(text, at: index) {
      balance.insideTripleQuote = true
      index = text.index(index, offsetBy: 3)
      continue
    }

    index = next
  }
  return boundary
}

private func syntaxIsTripleQuote(_ text: String, at index: String.Index) -> Bool {
  let character = text[index]
  guard character == "\"" || character == "'" else { return false }
  var cursor = index
  for _ in 0..<2 {
    cursor = text.index(after: cursor)
    guard cursor < text.endIndex, text[cursor] == character else { return false }
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

    let reusedText = reusable?.text ?? ""
    let scanStart = text.index(text.startIndex, offsetBy: reusedText.count)
    let boundary = syntaxStableBoundary(in: text, from: scanStart)

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

  /// Highlights one self-contained segment. Attribute ranges are walked with a
  /// single forward cursor — the previous implementation re-walked from
  /// `startIndex` for every token, which is what made a long block quadratic.
  ///
  /// Applied to a whole code block this is the non-incremental reference
  /// rendering, which is what the equivalence tests compare against.
  static func highlightedSegment(
    _ segment: Substring,
    as language: FilesLanguage
  ) -> AttributedString {
    let text = String(segment)
    var attributed = AttributedString(text)
    attributed.font = .system(.body, design: .monospaced)
    attributed.foregroundColor = ADEColor.textPrimary

    var cursorOffset = 0
    var cursor = attributed.startIndex
    for token in tokenize(text, as: language) {
      guard let stringRange = Range(token.range, in: text) else { continue }
      let startOffset = text.distance(from: text.startIndex, to: stringRange.lowerBound)
      let endOffset = text.distance(from: text.startIndex, to: stringRange.upperBound)
      // Tokens arrive sorted by location, but overlapping rules can hand back a
      // range that starts before the cursor; rewind only in that case.
      if startOffset < cursorOffset {
        cursor = attributed.startIndex
        cursorOffset = 0
      }
      guard let lowerBound = attributed.characters.index(
        cursor,
        offsetBy: startOffset - cursorOffset,
        limitedBy: attributed.endIndex
      ), let upperBound = attributed.characters.index(
        lowerBound,
        offsetBy: endOffset - startOffset,
        limitedBy: attributed.endIndex
      ) else { continue }
      attributed[lowerBound..<upperBound].foregroundColor = token.role.tint
      attributed[lowerBound..<upperBound].font = token.role.font
      cursor = lowerBound
      cursorOffset = startOffset
    }
    return attributed
  }

  private static func regexMatches(pattern: String, in text: String) -> [NSTextCheckingResult] {
    guard let regex = ADECodeRenderingCache.shared.regex(for: pattern) else {
      return []
    }
    return regex.matches(in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length))
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

private extension SyntaxTokenRole {
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
