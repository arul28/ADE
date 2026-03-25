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

struct SyntaxHighlighter {
  static func tokenize(_ text: String, as language: FilesLanguage) -> [SyntaxToken] {
    let nsText = text as NSString
    let rules = tokenRules(for: language)
    return rules
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
  }

  static func highlightedAttributedString(_ text: String, as language: FilesLanguage) -> AttributedString {
    var attributed = AttributedString(text)
    attributed.font = .system(.body, design: .monospaced)
    attributed.foregroundColor = ADEColor.textPrimary

    for token in tokenize(text, as: language) {
      guard let stringRange = Range(token.range, in: text) else { continue }
      let startOffset = text.distance(from: text.startIndex, to: stringRange.lowerBound)
      let endOffset = text.distance(from: text.startIndex, to: stringRange.upperBound)
      let lowerBound = attributed.characters.index(attributed.startIndex, offsetBy: startOffset)
      let upperBound = attributed.characters.index(attributed.startIndex, offsetBy: endOffset)
      let attributeRange = lowerBound..<upperBound
      attributed[attributeRange].foregroundColor = token.role.tint
      attributed[attributeRange].font = token.role.font
    }

    return attributed
  }

  private static func regexMatches(pattern: String, in text: String) -> [NSTextCheckingResult] {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: []) else {
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
  var id: String {
    "\(kind)-\(originalLineNumber ?? -1)-\(modifiedLineNumber ?? -1)-\(text)"
  }

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

  var lcs = Array(
    repeating: Array(repeating: 0, count: modifiedLines.count + 1),
    count: originalLines.count + 1
  )

  if !originalLines.isEmpty && !modifiedLines.isEmpty {
    for originalIndex in stride(from: originalLines.count - 1, through: 0, by: -1) {
      for modifiedIndex in stride(from: modifiedLines.count - 1, through: 0, by: -1) {
        if originalLines[originalIndex] == modifiedLines[modifiedIndex] {
          lcs[originalIndex][modifiedIndex] = lcs[originalIndex + 1][modifiedIndex + 1] + 1
        } else {
          lcs[originalIndex][modifiedIndex] = max(lcs[originalIndex + 1][modifiedIndex], lcs[originalIndex][modifiedIndex + 1])
        }
      }
    }
  }

  var diffLines: [FilesInlineDiffLine] = []
  var originalIndex = 0
  var modifiedIndex = 0
  var originalLineNumber = 1
  var modifiedLineNumber = 1

  while originalIndex < originalLines.count && modifiedIndex < modifiedLines.count {
    if originalLines[originalIndex] == modifiedLines[modifiedIndex] {
      diffLines.append(
        FilesInlineDiffLine(
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
    } else if lcs[originalIndex + 1][modifiedIndex] >= lcs[originalIndex][modifiedIndex + 1] {
      diffLines.append(
        FilesInlineDiffLine(
          kind: .removed,
          text: originalLines[originalIndex],
          originalLineNumber: originalLineNumber,
          modifiedLineNumber: nil
        )
      )
      originalIndex += 1
      originalLineNumber += 1
    } else {
      diffLines.append(
        FilesInlineDiffLine(
          kind: .added,
          text: modifiedLines[modifiedIndex],
          originalLineNumber: nil,
          modifiedLineNumber: modifiedLineNumber
        )
      )
      modifiedIndex += 1
      modifiedLineNumber += 1
    }
  }

  while originalIndex < originalLines.count {
    diffLines.append(
      FilesInlineDiffLine(
        kind: .removed,
        text: originalLines[originalIndex],
        originalLineNumber: originalLineNumber,
        modifiedLineNumber: nil
      )
    )
    originalIndex += 1
    originalLineNumber += 1
  }

  while modifiedIndex < modifiedLines.count {
    diffLines.append(
      FilesInlineDiffLine(
        kind: .added,
        text: modifiedLines[modifiedIndex],
        originalLineNumber: nil,
        modifiedLineNumber: modifiedLineNumber
      )
    )
    modifiedIndex += 1
    modifiedLineNumber += 1
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
