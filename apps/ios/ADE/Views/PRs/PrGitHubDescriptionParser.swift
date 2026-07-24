import Foundation

enum PrGitHubDescriptionBlock: Identifiable, Equatable {
  case markdown(id: String, markdown: String)
  case disclosure(id: String, title: String, markdown: String)

  var id: String {
    switch self {
    case .markdown(let id, _), .disclosure(let id, _, _):
      return id
    }
  }
}

private enum PrGitHubDescriptionRegex {
  static let details = expression(
    #"<details\b[^>]*>(.*?)</details\s*>"#,
    options: [.caseInsensitive, .dotMatchesLineSeparators]
  )
  static let summary = expression(
    #"<summary\b[^>]*>(.*?)</summary\s*>"#,
    options: [.caseInsensitive, .dotMatchesLineSeparators]
  )
  static let scriptOrStyle = htmlExpression(
    #"<(?:script|style)\b[^>]*>.*?</(?:script|style)\s*>"#
  )
  static let code = htmlExpression(#"<code\b[^>]*>(.*?)</code\s*>"#)
  static let strong = htmlExpression(#"<(?:strong|b)\b[^>]*>(.*?)</(?:strong|b)\s*>"#)
  static let emphasis = htmlExpression(#"<(?:em|i)\b[^>]*>(.*?)</(?:em|i)\s*>"#)
  static let link = htmlExpression(#"<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a\s*>"#)
  static let heading = htmlExpression(#"<h([1-6])\b[^>]*>(.*?)</h[1-6]\s*>"#)
  static let listItem = htmlExpression(#"<li\b[^>]*>(.*?)</li\s*>"#)
  static let image = htmlExpression(#"<img\b[^>]*\balt\s*=\s*["']([^"']+)["'][^>]*>"#)
  static let lineBreak = expression(#"<br\s*/?>"#, options: [.caseInsensitive])
  static let paragraph = expression(#"</?p\b[^>]*>"#, options: [.caseInsensitive])
  static let list = expression(#"</?(?:ul|ol)\b[^>]*>"#, options: [.caseInsensitive])
  static let blockquoteOpen = expression(#"<blockquote\b[^>]*>"#, options: [.caseInsensitive])
  static let blockquoteClose = expression(#"</blockquote\s*>"#, options: [.caseInsensitive])
  static let horizontalRule = expression(#"<hr\s*/?>"#, options: [.caseInsensitive])
  static let anyTag = expression(#"<[^>]+>"#, options: [.caseInsensitive])
  static let repeatedBlankLines = expression(#"\n{3,}"#)
  static let inlineCode = expression(#"(`+)[^\n]*?\1"#)
  static let fenceOpening = expression(
    #"^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)"#,
    options: [.anchorsMatchLines]
  )
  static let fenceClosing = expression(
    #"^[ \t]*(`{3,}|~{3,})[ \t]*(?=\n|$)"#,
    options: [.anchorsMatchLines]
  )
  static let numericEntity = htmlExpression(#"&#(x?[0-9a-f]+);"#)

  private static func htmlExpression(_ pattern: String) -> NSRegularExpression {
    expression(pattern, options: [.caseInsensitive, .dotMatchesLineSeparators])
  }

  private static func expression(
    _ pattern: String,
    options: NSRegularExpression.Options = []
  ) -> NSRegularExpression {
    // All patterns are compile-time literals covered by parser tests.
    try! NSRegularExpression(pattern: pattern, options: options)
  }
}

/// GitHub PR bodies are Markdown with a small amount of embedded HTML. Apple's
/// Markdown parser treats those tags as literal prose, so Dependabot release
/// notes can render as a wall of `<details>`, `<li>`, and `<a>` tags. Split
/// details blocks into native disclosures and normalize the remaining safe
/// GitHub HTML into Markdown before it reaches the shared renderer.
func parsePrGitHubDescriptionBlocks(_ text: String) -> [PrGitHubDescriptionBlock] {
  let protectedCode = prProtectMarkdownCode(in: normalizePrMarkdownText(text))
  let source = protectedCode.text

  func normalizeFragment(_ fragment: String) -> String {
    prRestoreMarkdownCode(
      in: normalizePrGitHubHtmlFragment(fragment),
      segments: protectedCode.segments
    )
  }

  let nsSource = source as NSString
  let matches = PrGitHubDescriptionRegex.details.matches(
    in: source,
    range: NSRange(location: 0, length: nsSource.length)
  )
  guard !matches.isEmpty else {
    return [.markdown(id: "description-markdown-0", markdown: normalizeFragment(source))]
  }

  var blocks: [PrGitHubDescriptionBlock] = []
  var cursor = 0

  func appendMarkdown(_ raw: String) {
    let markdown = normalizeFragment(raw)
    guard !markdown.isEmpty else { return }
    blocks.append(.markdown(id: "description-markdown-\(blocks.count)", markdown: markdown))
  }

  for match in matches {
    if match.range.location > cursor {
      appendMarkdown(nsSource.substring(with: NSRange(
        location: cursor,
        length: match.range.location - cursor
      )))
    }

    let innerRange = match.range(at: 1)
    let inner = innerRange.location == NSNotFound ? "" : nsSource.substring(with: innerRange)
    let nsInner = inner as NSString
    let summaryMatch = PrGitHubDescriptionRegex.summary.firstMatch(
      in: inner,
      range: NSRange(location: 0, length: nsInner.length)
    )
    let title: String
    let body: String
    if let summaryMatch, summaryMatch.range.location != NSNotFound {
      let titleRange = summaryMatch.range(at: 1)
      title = titleRange.location == NSNotFound
        ? "Details"
        : prRestoreMarkdownCode(
          in: prGitHubHtmlPlainText(nsInner.substring(with: titleRange)),
          segments: protectedCode.segments
        )
      let mutableBody = NSMutableString(string: inner)
      mutableBody.replaceCharacters(in: summaryMatch.range, with: "")
      body = mutableBody as String
    } else {
      title = "Details"
      body = inner
    }

    let markdown = normalizeFragment(body)
    if !markdown.isEmpty {
      blocks.append(.disclosure(
        id: "description-disclosure-\(blocks.count)",
        title: title.isEmpty ? "Details" : title,
        markdown: markdown
      ))
    }
    cursor = NSMaxRange(match.range)
  }

  if cursor < nsSource.length {
    appendMarkdown(nsSource.substring(from: cursor))
  }

  return blocks.isEmpty
    ? [.markdown(id: "description-markdown-0", markdown: normalizeFragment(source))]
    : blocks
}

func normalizePrGitHubHtmlFragment(_ source: String) -> String {
  let protectedCode = prProtectMarkdownCode(in: normalizePrMarkdownText(source))
  var value = protectedCode.text

  value = prReplaceHtmlMatches(
    in: value,
    regex: PrGitHubDescriptionRegex.scriptOrStyle
  ) { _, _ in "" }
  value = prReplaceHtmlMatches(
    in: value,
    regex: PrGitHubDescriptionRegex.code
  ) { match, original in
    let inner = prHtmlCapture(match, in: original, index: 1)
    let code = prDecodeHtmlEntities(prStripHtmlTags(inner))
      .replacingOccurrences(of: "`", with: "\\`")
    return code.isEmpty ? "" : "`\(code)`"
  }
  value = prReplaceHtmlMatches(
    in: value,
    regex: PrGitHubDescriptionRegex.strong
  ) { match, original in
    let inner = prDecodeHtmlEntities(prStripHtmlTags(prHtmlCapture(match, in: original, index: 1)))
    return inner.isEmpty ? "" : "**\(inner)**"
  }
  value = prReplaceHtmlMatches(
    in: value,
    regex: PrGitHubDescriptionRegex.emphasis
  ) { match, original in
    let inner = prDecodeHtmlEntities(prStripHtmlTags(prHtmlCapture(match, in: original, index: 1)))
    return inner.isEmpty ? "" : "*\(inner)*"
  }
  value = prReplaceHtmlMatches(
    in: value,
    regex: PrGitHubDescriptionRegex.link
  ) { match, original in
    let href = prDecodeHtmlEntities(prHtmlCapture(match, in: original, index: 1))
    let label = prDecodeHtmlEntities(prStripHtmlTags(prHtmlCapture(match, in: original, index: 2)))
    guard let url = URL(string: href),
          let scheme = url.scheme?.lowercased(),
          scheme == "http" || scheme == "https"
    else {
      return label
    }
    let escapedLabel = label
      .replacingOccurrences(of: "[", with: "\\[")
      .replacingOccurrences(of: "]", with: "\\]")
    return "[\(escapedLabel)](\(url.absoluteString))"
  }
  value = prReplaceHtmlMatches(
    in: value,
    regex: PrGitHubDescriptionRegex.heading
  ) { match, original in
    let level = Int(prHtmlCapture(match, in: original, index: 1)) ?? 2
    let title = prDecodeHtmlEntities(prStripHtmlTags(prHtmlCapture(match, in: original, index: 2)))
    return "\n\(String(repeating: "#", count: level)) \(title)\n"
  }
  value = prReplaceHtmlMatches(
    in: value,
    regex: PrGitHubDescriptionRegex.listItem
  ) { match, original in
    let item = prDecodeHtmlEntities(prStripHtmlTags(prHtmlCapture(match, in: original, index: 1)))
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return item.isEmpty ? "" : "\n- \(item)"
  }
  value = prReplaceHtmlMatches(
    in: value,
    regex: PrGitHubDescriptionRegex.image
  ) { match, original in
    let alt = prDecodeHtmlEntities(prHtmlCapture(match, in: original, index: 1))
    return alt.isEmpty ? "" : "[Image: \(alt)]"
  }

  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.lineBreak, replacement: "\n")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.paragraph, replacement: "\n\n")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.list, replacement: "\n")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.blockquoteOpen, replacement: "\n> ")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.blockquoteClose, replacement: "\n")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.horizontalRule, replacement: "\n---\n")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.anyTag, replacement: "")
  value = prDecodeHtmlEntities(value)

  value = value
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map { $0.trimmingCharacters(in: .whitespaces) }
    .joined(separator: "\n")
  value = PrGitHubDescriptionRegex.repeatedBlankLines.stringByReplacingMatches(
    in: value,
    range: NSRange(location: 0, length: (value as NSString).length),
    withTemplate: "\n\n"
  )
  value = value.trimmingCharacters(in: .whitespacesAndNewlines)
  return prRestoreMarkdownCode(in: value, segments: protectedCode.segments)
}

private struct PrProtectedMarkdownCode {
  let token: String
  let value: String
}

private func prProtectMarkdownCode(
  in source: String
) -> (text: String, segments: [PrProtectedMarkdownCode]) {
  var text = source
  var segments: [PrProtectedMarkdownCode] = []

  func protect(regex: NSRegularExpression) {
    let original = text as NSString
    let matches = regex.matches(
      in: text,
      range: NSRange(location: 0, length: original.length)
    )
    guard !matches.isEmpty else { return }
    let result = NSMutableString(string: text)
    for match in matches.reversed() {
      let token = "\u{E000}ADEPRCODE\(segments.count)\u{E001}"
      segments.append(PrProtectedMarkdownCode(
        token: token,
        value: original.substring(with: match.range)
      ))
      result.replaceCharacters(in: match.range, with: token)
    }
    text = result as String
  }

  text = prProtectMarkdownFences(in: text, segments: &segments)
  protect(regex: PrGitHubDescriptionRegex.inlineCode)
  return (text, segments)
}

private func prProtectMarkdownFences(
  in source: String,
  segments: inout [PrProtectedMarkdownCode]
) -> String {
  let openingRegex = PrGitHubDescriptionRegex.fenceOpening
  let closingRegex = PrGitHubDescriptionRegex.fenceClosing

  let original = source as NSString
  var protectedRanges: [NSRange] = []
  var searchLocation = 0

  while searchLocation < original.length,
        let opening = openingRegex.firstMatch(
          in: source,
          range: NSRange(location: searchLocation, length: original.length - searchLocation)
        )
  {
    let openingDelimiter = original.substring(with: opening.range(at: 1))
    let openingCharacter = openingDelimiter.first
    let closingSearchStart = NSMaxRange(opening.range)
    var closingSearchLocation = closingSearchStart
    var matchingClosing: NSTextCheckingResult?

    while closingSearchLocation < original.length,
          let candidate = closingRegex.firstMatch(
            in: source,
            range: NSRange(
              location: closingSearchLocation,
              length: original.length - closingSearchLocation
            )
          )
    {
      let closingDelimiter = original.substring(with: candidate.range(at: 1))
      if closingDelimiter.first == openingCharacter,
         closingDelimiter.count >= openingDelimiter.count
      {
        matchingClosing = candidate
        break
      }
      closingSearchLocation = NSMaxRange(candidate.range)
    }

    guard let matchingClosing else {
      searchLocation = NSMaxRange(opening.range)
      continue
    }

    let blockRange = NSRange(
      location: opening.range.location,
      length: NSMaxRange(matchingClosing.range) - opening.range.location
    )
    protectedRanges.append(blockRange)
    searchLocation = NSMaxRange(matchingClosing.range)
  }

  guard !protectedRanges.isEmpty else { return source }
  let result = NSMutableString(string: source)
  for range in protectedRanges.reversed() {
    let token = "\u{E000}ADEPRCODE\(segments.count)\u{E001}"
    segments.append(PrProtectedMarkdownCode(
      token: token,
      value: original.substring(with: range)
    ))
    result.replaceCharacters(in: range, with: token)
  }
  return result as String
}

private func prRestoreMarkdownCode(
  in source: String,
  segments: [PrProtectedMarkdownCode]
) -> String {
  segments.reduce(into: source) { value, segment in
    value = value.replacingOccurrences(of: segment.token, with: segment.value)
  }
}

private func prGitHubHtmlPlainText(_ source: String) -> String {
  prDecodeHtmlEntities(prStripHtmlTags(source))
    .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func prStripHtmlTags(_ source: String) -> String {
  PrGitHubDescriptionRegex.anyTag.stringByReplacingMatches(
    in: source,
    range: NSRange(location: 0, length: (source as NSString).length),
    withTemplate: ""
  )
}

private func prReplaceHtmlMatches(
  in source: String,
  regex: NSRegularExpression,
  transform: (NSTextCheckingResult, NSString) -> String
) -> String {
  let original = source as NSString
  let matches = regex.matches(
    in: source,
    range: NSRange(location: 0, length: original.length)
  )
  guard !matches.isEmpty else { return source }
  let result = NSMutableString(string: source)
  for match in matches.reversed() {
    result.replaceCharacters(in: match.range, with: transform(match, original))
  }
  return result as String
}

private func prReplacingHtmlTag(
  _ source: String,
  regex: NSRegularExpression,
  replacement: String
) -> String {
  regex.stringByReplacingMatches(
    in: source,
    range: NSRange(location: 0, length: (source as NSString).length),
    withTemplate: replacement
  )
}

private func prHtmlCapture(_ match: NSTextCheckingResult, in source: NSString, index: Int) -> String {
  guard index < match.numberOfRanges else { return "" }
  let range = match.range(at: index)
  guard range.location != NSNotFound else { return "" }
  return source.substring(with: range)
}

private func prDecodeHtmlEntities(_ source: String) -> String {
  var value = source
    .replacingOccurrences(of: "&nbsp;", with: " ", options: .caseInsensitive)
    .replacingOccurrences(of: "&quot;", with: "\"", options: .caseInsensitive)
    .replacingOccurrences(of: "&#39;", with: "'", options: .caseInsensitive)
    .replacingOccurrences(of: "&apos;", with: "'", options: .caseInsensitive)
    .replacingOccurrences(of: "&lt;", with: "<", options: .caseInsensitive)
    .replacingOccurrences(of: "&gt;", with: ">", options: .caseInsensitive)
    .replacingOccurrences(of: "&amp;", with: "&", options: .caseInsensitive)

  value = prReplaceHtmlMatches(
    in: value,
    regex: PrGitHubDescriptionRegex.numericEntity
  ) { match, original in
    let raw = prHtmlCapture(match, in: original, index: 1)
    let radix = raw.lowercased().hasPrefix("x") ? 16 : 10
    let digits = radix == 16 ? String(raw.dropFirst()) : raw
    guard let number = UInt32(digits, radix: radix),
          let scalar = UnicodeScalar(number)
    else { return "" }
    return String(Character(scalar))
  }
  return value
}
