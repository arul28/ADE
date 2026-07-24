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

  guard let detailsRegex = try? NSRegularExpression(
    pattern: #"<details\b[^>]*>(.*?)</details\s*>"#,
    options: [.caseInsensitive, .dotMatchesLineSeparators]
  ) else {
    return [.markdown(id: "description-markdown-0", markdown: normalizeFragment(source))]
  }

  let nsSource = source as NSString
  let matches = detailsRegex.matches(
    in: source,
    range: NSRange(location: 0, length: nsSource.length)
  )
  guard !matches.isEmpty else {
    return [.markdown(id: "description-markdown-0", markdown: normalizeFragment(source))]
  }

  let summaryRegex = try? NSRegularExpression(
    pattern: #"<summary\b[^>]*>(.*?)</summary\s*>"#,
    options: [.caseInsensitive, .dotMatchesLineSeparators]
  )
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
    let summaryMatch = summaryRegex?.firstMatch(
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
    pattern: #"<(?:script|style)\b[^>]*>.*?</(?:script|style)\s*>"#
  ) { _, _ in "" }
  value = prReplaceHtmlMatches(
    in: value,
    pattern: #"<code\b[^>]*>(.*?)</code\s*>"#
  ) { match, original in
    let inner = prHtmlCapture(match, in: original, index: 1)
    let code = prDecodeHtmlEntities(prStripHtmlTags(inner))
      .replacingOccurrences(of: "`", with: "\\`")
    return code.isEmpty ? "" : "`\(code)`"
  }
  value = prReplaceHtmlMatches(
    in: value,
    pattern: #"<(?:strong|b)\b[^>]*>(.*?)</(?:strong|b)\s*>"#
  ) { match, original in
    let inner = prDecodeHtmlEntities(prStripHtmlTags(prHtmlCapture(match, in: original, index: 1)))
    return inner.isEmpty ? "" : "**\(inner)**"
  }
  value = prReplaceHtmlMatches(
    in: value,
    pattern: #"<(?:em|i)\b[^>]*>(.*?)</(?:em|i)\s*>"#
  ) { match, original in
    let inner = prDecodeHtmlEntities(prStripHtmlTags(prHtmlCapture(match, in: original, index: 1)))
    return inner.isEmpty ? "" : "*\(inner)*"
  }
  value = prReplaceHtmlMatches(
    in: value,
    pattern: #"<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>(.*?)</a\s*>"#
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
    pattern: #"<h([1-6])\b[^>]*>(.*?)</h[1-6]\s*>"#
  ) { match, original in
    let level = Int(prHtmlCapture(match, in: original, index: 1)) ?? 2
    let title = prDecodeHtmlEntities(prStripHtmlTags(prHtmlCapture(match, in: original, index: 2)))
    return "\n\(String(repeating: "#", count: level)) \(title)\n"
  }
  value = prReplaceHtmlMatches(
    in: value,
    pattern: #"<li\b[^>]*>(.*?)</li\s*>"#
  ) { match, original in
    let item = prDecodeHtmlEntities(prStripHtmlTags(prHtmlCapture(match, in: original, index: 1)))
      .trimmingCharacters(in: .whitespacesAndNewlines)
    return item.isEmpty ? "" : "\n- \(item)"
  }
  value = prReplaceHtmlMatches(
    in: value,
    pattern: #"<img\b[^>]*\balt\s*=\s*["']([^"']+)["'][^>]*>"#
  ) { match, original in
    let alt = prDecodeHtmlEntities(prHtmlCapture(match, in: original, index: 1))
    return alt.isEmpty ? "" : "[Image: \(alt)]"
  }

  value = prReplacingHtmlTag(value, pattern: #"<br\s*/?>"#, replacement: "\n")
  value = prReplacingHtmlTag(value, pattern: #"</?p\b[^>]*>"#, replacement: "\n\n")
  value = prReplacingHtmlTag(value, pattern: #"</?(?:ul|ol)\b[^>]*>"#, replacement: "\n")
  value = prReplacingHtmlTag(value, pattern: #"<blockquote\b[^>]*>"#, replacement: "\n> ")
  value = prReplacingHtmlTag(value, pattern: #"</blockquote\s*>"#, replacement: "\n")
  value = prReplacingHtmlTag(value, pattern: #"<hr\s*/?>"#, replacement: "\n---\n")
  value = prReplacingHtmlTag(value, pattern: #"<[^>]+>"#, replacement: "")
  value = prDecodeHtmlEntities(value)

  value = value
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map { $0.trimmingCharacters(in: .whitespaces) }
    .joined(separator: "\n")
  value = value.replacingOccurrences(
    of: #"\n{3,}"#,
    with: "\n\n",
    options: .regularExpression
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

  func protect(pattern: String, options: NSRegularExpression.Options) {
    guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return }
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
  protect(
    pattern: #"(`+)[^\n]*?\1"#,
    options: []
  )
  return (text, segments)
}

private func prProtectMarkdownFences(
  in source: String,
  segments: inout [PrProtectedMarkdownCode]
) -> String {
  guard let openingRegex = try? NSRegularExpression(
    pattern: #"^[ \t]*(`{3,}|~{3,})[^\n]*(?:\n|$)"#,
    options: [.anchorsMatchLines]
  ),
  let closingRegex = try? NSRegularExpression(
    pattern: #"^[ \t]*(`{3,}|~{3,})[ \t]*(?=\n|$)"#,
    options: [.anchorsMatchLines]
  ) else { return source }

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
  source.replacingOccurrences(
    of: #"<[^>]+>"#,
    with: "",
    options: [.regularExpression, .caseInsensitive]
  )
}

private func prReplaceHtmlMatches(
  in source: String,
  pattern: String,
  transform: (NSTextCheckingResult, NSString) -> String
) -> String {
  guard let regex = try? NSRegularExpression(
    pattern: pattern,
    options: [.caseInsensitive, .dotMatchesLineSeparators]
  ) else { return source }
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

private func prReplacingHtmlTag(_ source: String, pattern: String, replacement: String) -> String {
  source.replacingOccurrences(
    of: pattern,
    with: replacement,
    options: [.regularExpression, .caseInsensitive]
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

  value = prReplaceHtmlMatches(in: value, pattern: #"&#(x?[0-9a-f]+);"#) { match, original in
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
