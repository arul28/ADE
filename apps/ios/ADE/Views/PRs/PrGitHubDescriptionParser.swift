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
  // A `>` inside a quoted attribute (alt="before > after") does not end the tag.
  static let image = htmlExpression(#"<img\b(?:[^>"']|"[^"]*"|'[^']*')*>"#)
  static let imageAlt = expression(#"\balt\s*=\s*["']([^"']*)["']"#, options: [.caseInsensitive])
  static let lineBreak = expression(#"<br\s*/?>"#, options: [.caseInsensitive])
  static let paragraph = expression(#"</?p\b[^>]*>"#, options: [.caseInsensitive])
  static let list = expression(#"</?(?:ul|ol)\b[^>]*>"#, options: [.caseInsensitive])
  static let blockquoteOpen = expression(#"<blockquote\b[^>]*>"#, options: [.caseInsensitive])
  static let blockquoteClose = expression(#"</blockquote\s*>"#, options: [.caseInsensitive])
  static let horizontalRule = expression(#"<hr\s*/?>"#, options: [.caseInsensitive])
  static let anyTag = expression(
    #"</?(?:a|abbr|address|area|article|aside|audio|b|base|bdi|bdo|blockquote|body|br|button|canvas|caption|center|cite|code|col|colgroup|data|datalist|dd|del|details|dfn|dialog|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer|form|h[1-6]|head|header|hgroup|hr|html|i|iframe|img|input|ins|kbd|label|legend|li|link|main|map|mark|menu|meta|meter|nav|noscript|object|ol|optgroup|option|output|p|picture|pre|progress|q|rp|rt|ruby|s|samp|script|search|section|select|slot|small|source|span|strong|style|sub|summary|sup|table|tbody|td|template|textarea|tfoot|th|thead|time|title|tr|track|u|ul|var|video|wbr)(?=[\s/>])(?:[^>"']|"[^"]*"|'[^']*')*>"#,
    options: [.caseInsensitive]
  )
  static let unsafeAngleExpression = expression(
    #"<(?:javascript|data|vbscript)\s*:[^>\n]*>"#,
    options: [.caseInsensitive]
  )
  static let repeatedBlankLines = expression(#"\n{3,}"#)
  static let inlineCode = expression(#"(`+)[^\n]*?\1"#)
  static let safeAutolink = expression(
    #"<(?:https?://[^\s<>]+|[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+)>"#,
    options: [.caseInsensitive]
  )
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

private struct PrGitHubDetailsRange {
  let full: NSRange
  let inner: NSRange
}

private struct PrGitHubDetailsTag {
  enum Kind {
    case opening
    case closing
  }

  let kind: Kind
  let range: NSRange
}

/// GitHub PR bodies are Markdown with a small amount of embedded HTML. Apple's
/// Markdown parser treats those tags as literal prose, so Dependabot release
/// notes can render as a wall of `<details>`, `<li>`, and `<a>` tags. Split
/// details blocks into native disclosures and normalize the remaining safe
/// GitHub HTML into Markdown before it reaches the shared renderer.
func parsePrGitHubDescriptionBlocks(_ text: String) -> [PrGitHubDescriptionBlock] {
  let protectedMarkdown = prProtectMarkdownSyntax(in: normalizePrMarkdownText(text))
  let source = protectedMarkdown.text

  func normalizeFragment(_ fragment: String) -> String {
    prRestoreMarkdownSyntax(
      in: normalizePrGitHubHtmlFragment(fragment),
      segments: protectedMarkdown.segments
    )
  }

  let nsSource = source as NSString
  let matches = prGitHubDetailsRanges(in: nsSource)
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
    if match.full.location > cursor {
      appendMarkdown(nsSource.substring(with: NSRange(
        location: cursor,
        length: match.full.location - cursor
      )))
    }

    let inner = nsSource.substring(with: match.inner)
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
        : prRestoreMarkdownSyntax(
          in: prGitHubHtmlPlainText(nsInner.substring(with: titleRange)),
          segments: protectedMarkdown.segments
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
    cursor = NSMaxRange(match.full)
  }

  if cursor < nsSource.length {
    appendMarkdown(nsSource.substring(from: cursor))
  }

  return blocks.isEmpty
    ? [.markdown(id: "description-markdown-0", markdown: normalizeFragment(source))]
    : blocks
}

private func prGitHubDetailsRanges(in source: NSString) -> [PrGitHubDetailsRange] {
  var ranges: [PrGitHubDetailsRange] = []
  var cursor = 0
  var depth = 0
  var outerStart = 0
  var innerStart = 0

  while let tag = prNextGitHubDetailsTag(in: source, from: cursor) {
    switch tag.kind {
    case .opening:
      if depth == 0 {
        outerStart = tag.range.location
        innerStart = NSMaxRange(tag.range)
      }
      depth += 1
    case .closing:
      guard depth > 0 else {
        cursor = NSMaxRange(tag.range)
        continue
      }
      depth -= 1
      if depth == 0 {
        ranges.append(PrGitHubDetailsRange(
          full: NSRange(
            location: outerStart,
            length: NSMaxRange(tag.range) - outerStart
          ),
          inner: NSRange(
            location: innerStart,
            length: tag.range.location - innerStart
          )
        ))
      }
    }
    cursor = NSMaxRange(tag.range)
  }

  return ranges
}

private func prNextGitHubDetailsTag(
  in source: NSString,
  from start: Int
) -> PrGitHubDetailsTag? {
  var cursor = start
  while cursor < source.length {
    let openingBracket = source.range(
      of: "<",
      options: [],
      range: NSRange(location: cursor, length: source.length - cursor)
    )
    guard openingBracket.location != NSNotFound else { return nil }

    var nameStart = NSMaxRange(openingBracket)
    let isClosing = nameStart < source.length && source.character(at: nameStart) == 47
    if isClosing {
      nameStart += 1
    }

    let nameLength = 7
    let nameEnd = nameStart + nameLength
    guard nameEnd <= source.length,
          source.substring(with: NSRange(location: nameStart, length: nameLength))
            .caseInsensitiveCompare("details") == .orderedSame,
          nameEnd == source.length || prIsGitHubHtmlTagBoundary(source.character(at: nameEnd))
    else {
      cursor = NSMaxRange(openingBracket)
      continue
    }

    var tagEnd = nameEnd
    var quote: unichar?
    while tagEnd < source.length {
      let character = source.character(at: tagEnd)
      if let activeQuote = quote {
        if character == activeQuote {
          quote = nil
        }
      } else if character == 34 || character == 39 {
        quote = character
      } else if character == 62 {
        return PrGitHubDetailsTag(
          kind: isClosing ? .closing : .opening,
          range: NSRange(
            location: openingBracket.location,
            length: tagEnd - openingBracket.location + 1
          )
        )
      }
      tagEnd += 1
    }

    return nil
  }
  return nil
}

private func prIsGitHubHtmlTagBoundary(_ character: unichar) -> Bool {
  character == 9
    || character == 10
    || character == 12
    || character == 13
    || character == 32
    || character == 47
    || character == 62
}

func normalizePrGitHubHtmlFragment(_ source: String) -> String {
  let protectedMarkdown = prProtectMarkdownSyntax(in: normalizePrMarkdownText(source))
  var value = protectedMarkdown.text

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
    // GitHub's own uploads often carry no `alt`, or an empty one.
    let tag = original.substring(with: match.range)
    let alt = PrGitHubDescriptionRegex.imageAlt
      .firstMatch(in: tag, range: NSRange(location: 0, length: (tag as NSString).length))
      .map { prDecodeHtmlEntities((tag as NSString).substring(with: $0.range(at: 1))) } ?? ""
    // A picture GitHub hosts is drawn as a picture (`prDescriptionPieces`).
    // Any other source stays words, as before.
    if let source = prHtmlImageSource(tag),
       prIsGitHubMediaURL(source) {
      let label = alt.replacingOccurrences(of: "[", with: "(").replacingOccurrences(of: "]", with: ")")
      return "\n\n![\(label)](\(source))\n\n"
    }
    return alt.isEmpty ? "" : "[Image: \(alt)]"
  }

  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.lineBreak, replacement: "\n")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.paragraph, replacement: "\n\n")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.list, replacement: "\n")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.blockquoteOpen, replacement: "\n> ")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.blockquoteClose, replacement: "\n")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.horizontalRule, replacement: "\n---\n")
  value = prReplacingHtmlTag(value, regex: PrGitHubDescriptionRegex.anyTag, replacement: "")
  value = prReplacingHtmlTag(
    value,
    regex: PrGitHubDescriptionRegex.unsafeAngleExpression,
    replacement: ""
  )
  value = prDecodeHtmlEntities(value)

  value = value
    .split(separator: "\n", omittingEmptySubsequences: false)
    .map(prTrimmingTrailingHorizontalWhitespace)
    .joined(separator: "\n")
  value = PrGitHubDescriptionRegex.repeatedBlankLines.stringByReplacingMatches(
    in: value,
    range: NSRange(location: 0, length: (value as NSString).length),
    withTemplate: "\n\n"
  )
  value = prTrimmingBlankLines(value)
  return prRestoreMarkdownSyntax(in: value, segments: protectedMarkdown.segments)
}

private func prTrimmingTrailingHorizontalWhitespace(_ line: Substring) -> String {
  String(line.reversed().drop(while: { $0 == " " || $0 == "\t" }).reversed())
}

private func prTrimmingBlankLines(_ source: String) -> String {
  var lines = source.split(separator: "\n", omittingEmptySubsequences: false)
  while lines.first.map({ String($0).trimmingCharacters(in: .whitespaces).isEmpty }) == true {
    lines.removeFirst()
  }
  while lines.last.map({ String($0).trimmingCharacters(in: .whitespaces).isEmpty }) == true {
    lines.removeLast()
  }
  return lines.joined(separator: "\n")
}

private struct PrProtectedMarkdownSegment {
  let token: String
  let value: String
}

private func prProtectMarkdownSyntax(
  in source: String
) -> (text: String, segments: [PrProtectedMarkdownSegment]) {
  var text = source
  var segments: [PrProtectedMarkdownSegment] = []

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
      segments.append(PrProtectedMarkdownSegment(
        token: token,
        value: original.substring(with: match.range)
      ))
      result.replaceCharacters(in: match.range, with: token)
    }
    text = result as String
  }

  text = prProtectMarkdownFences(in: text, segments: &segments)
  protect(regex: PrGitHubDescriptionRegex.inlineCode)
  protect(regex: PrGitHubDescriptionRegex.safeAutolink)
  return (text, segments)
}

private func prProtectMarkdownFences(
  in source: String,
  segments: inout [PrProtectedMarkdownSegment]
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
    segments.append(PrProtectedMarkdownSegment(
      token: token,
      value: original.substring(with: range)
    ))
    result.replaceCharacters(in: range, with: token)
  }
  return result as String
}

private func prRestoreMarkdownSyntax(
  in source: String,
  segments: [PrProtectedMarkdownSegment]
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

// MARK: - Pictures and videos in a PR text
//
// The desktop twin is `apps/desktop/src/shared/prBodyProof.ts`
// (`preparePrBodyProofForAde`). A PR's text is written once and read on
// GitHub, on the desktop and here, so the three must agree on what is a
// picture, a video and a before/after pair.

/// One run of a PR text: markdown the shared renderer draws, or media.
enum PrDescriptionPiece: Equatable {
  case markdown(String)
  case media(PrDescriptionMedia)
  /// A `| Before | After |` table whose one row holds one picture per cell.
  case compare([PrDescriptionCompareSide])
}

struct PrDescriptionMedia: Equatable {
  enum Kind: Equatable {
    case image
    /// A GitHub attachment written as a bare link on its own line. GitHub
    /// stores an uploaded video that way and draws it as a player.
    case video
  }

  let kind: Kind
  let url: URL
  let label: String
}

struct PrDescriptionCompareSide: Equatable {
  let title: String
  let media: PrDescriptionMedia
}

private enum PrDescriptionMediaRegex {
  static let imageSource = try! NSRegularExpression(
    pattern: #"\bsrc\s*=\s*["']([^"']+)["']"#,
    options: [.caseInsensitive]
  )
  /// `![alt](url)` or `![alt](url "title")`, alone.
  static let imageOnly = try! NSRegularExpression(
    pattern: #"^!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)$"#
  )
  static let attachmentOnly = try! NSRegularExpression(
    pattern: #"^https://github\.com/user-attachments/assets/[0-9a-fA-F-]{36}$"#
  )
  static let tableRule = try! NSRegularExpression(
    pattern: #"^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$"#
  )
  static let compareTitle = try! NSRegularExpression(
    pattern: #"^(before|after)\b"#,
    options: [.caseInsensitive]
  )
  /// `[label]: url` on its own line: a link or footnote used elsewhere.
  static let referenceDefinition = try! NSRegularExpression(
    pattern: #"^ {0,3}\[[^\]\n]+\]:\s*\S"#,
    options: [.anchorsMatchLines]
  )
}

private func prFullMatch(_ regex: NSRegularExpression, _ text: String) -> NSTextCheckingResult? {
  regex.firstMatch(in: text, range: NSRange(location: 0, length: (text as NSString).length))
}

func prHtmlImageSource(_ tag: String) -> String? {
  guard let match = prFullMatch(PrDescriptionMediaRegex.imageSource, tag), match.numberOfRanges > 1 else { return nil }
  return (tag as NSString).substring(with: match.range(at: 1))
}

/// Only media GitHub itself serves is loaded: an attachment, or one of its
/// image hosts. A PR's text can be written by anyone who can open one, and any
/// other URL would let its author see who read the PR.
func prIsGitHubMediaURL(_ raw: String) -> Bool {
  guard let url = URL(string: raw), url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else {
    return false
  }
  if host == "github.com" { return url.path.hasPrefix("/user-attachments/") }
  return host.hasSuffix(".githubusercontent.com")
}

private func prImageOnly(_ text: String) -> PrDescriptionMedia? {
  let trimmed = text.trimmingCharacters(in: .whitespaces)
  guard let match = prFullMatch(PrDescriptionMediaRegex.imageOnly, trimmed) else { return nil }
  let ns = trimmed as NSString
  let raw = ns.substring(with: match.range(at: 2))
  guard prIsGitHubMediaURL(raw), let url = URL(string: raw) else { return nil }
  return PrDescriptionMedia(kind: .image, url: url, label: ns.substring(with: match.range(at: 1)).trimmingCharacters(in: .whitespaces))
}

private func prTableCells(_ line: String) -> [String] {
  var trimmed = line.trimmingCharacters(in: .whitespaces)
  if trimmed.hasPrefix("|") { trimmed.removeFirst() }
  if trimmed.hasSuffix("|") { trimmed.removeLast() }
  return trimmed.components(separatedBy: "|").map { $0.trimmingCharacters(in: .whitespaces) }
}

/// Splits a PR text into markdown and the media a reader should see as media.
/// Lines inside a code fence are never media.
func prDescriptionPieces(_ markdown: String) -> [PrDescriptionPiece] {
  // A link defined on its own line can be used anywhere in the text. Cut into
  // pieces, the use and the definition land in different renderers and the
  // link dies, so such a text stays whole.
  if prFullMatch(PrDescriptionMediaRegex.referenceDefinition, markdown) != nil {
    return markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? [] : [.markdown(markdown)]
  }
  let lines = markdown.components(separatedBy: "\n")
  var pieces: [PrDescriptionPiece] = []
  var text: [String] = []
  var fence: (char: Character, length: Int)?

  func flushText() {
    let joined = text.joined(separator: "\n").trimmingCharacters(in: .newlines)
    if !joined.trimmingCharacters(in: .whitespaces).isEmpty { pieces.append(.markdown(joined)) }
    text = []
  }

  var index = 0
  while index < lines.count {
    let line = lines[index]
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if let first = trimmed.first, first == "`" || first == "~" {
      let run = trimmed.prefix { $0 == first }.count
      if run >= 3 {
        if let open = fence {
          if open.char == first && run >= open.length && trimmed.count == run { fence = nil }
        } else {
          fence = (first, run)
        }
        text.append(line)
        index += 1
        continue
      }
    }
    // Inside a fence, or indented as code (four spaces or a tab): not media.
    if fence != nil || line.hasPrefix("    ") || line.hasPrefix("\t") {
      text.append(line)
      index += 1
      continue
    }

    // A before/after table: headings, a rule, and one row of pictures.
    if line.contains("|"), index + 2 < lines.count {
      let titles = prTableCells(line)
      let isCompare = (2...3).contains(titles.count)
        && titles.allSatisfy { prFullMatch(PrDescriptionMediaRegex.compareTitle, $0) != nil }
        && prFullMatch(PrDescriptionMediaRegex.tableRule, lines[index + 1]) != nil
        && (index + 3 >= lines.count || !lines[index + 3].contains("|"))
      if isCompare {
        let media = prTableCells(lines[index + 2]).map(prImageOnly)
        if media.count == titles.count, !media.contains(where: { $0 == nil }) {
          flushText()
          pieces.append(.compare(zip(titles, media).map { PrDescriptionCompareSide(title: $0.0, media: $0.1!) }))
          index += 3
          continue
        }
      }
    }
    if let image = prImageOnly(line) {
      flushText()
      pieces.append(.media(image))
      index += 1
      continue
    }
    if prFullMatch(PrDescriptionMediaRegex.attachmentOnly, trimmed) != nil, let url = URL(string: trimmed) {
      flushText()
      pieces.append(.media(PrDescriptionMedia(kind: .video, url: url, label: "")))
      index += 1
      continue
    }
    text.append(line)
    index += 1
  }
  flushText()
  return pieces
}
