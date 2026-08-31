import XCTest
@testable import ADE

/// The `markdown` node's subset, on the phone.
///
/// These mirror `apps/desktop/src/shared/plugins/vocabularyMarkdown.test.ts`
/// case for case, and that is the whole point of the file. The other three
/// clients call one TS function, so they cannot disagree with each other; this
/// suite is the only thing standing between the phone and a subset of its own.
/// A case added there and not here is a client quietly drifting.
final class PluginVocabularyMarkdownTests: XCTestCase {
  private func blocks(_ source: String) -> [PluginVocabMarkdownBlock] {
    PluginVocabMarkdownParser.parse(source).blocks
  }

  /// Every span of a document, in reading order.
  private func allSpans(_ list: [PluginVocabMarkdownBlock]) -> [PluginVocabMarkdownSpan] {
    var out: [PluginVocabMarkdownSpan] = []
    for block in list {
      switch block {
      case let .heading(_, spans), let .paragraph(spans):
        out.append(contentsOf: spans)
      case let .quote(blocks):
        out.append(contentsOf: allSpans(blocks))
      case let .list(_, _, items):
        for item in items { out.append(contentsOf: allSpans(item.blocks)) }
      case .code, .rule:
        break
      }
    }
    return out
  }

  /// A document's text with every mark dropped. Mirrors `vocabMarkdownPlainText`.
  private func plain(_ list: [PluginVocabMarkdownBlock]) -> String {
    var out: [String] = []
    for block in list {
      switch block {
      case let .heading(_, spans), let .paragraph(spans):
        out.append(spans.map(\.text).joined())
      case let .code(_, text):
        out.append(text)
      case let .quote(blocks):
        out.append(plain(blocks))
      case let .list(_, _, items):
        for item in items { out.append(plain(item.blocks)) }
      case .rule:
        break
      }
    }
    return out.joined(separator: "\n")
  }

  private func kinds(_ list: [PluginVocabMarkdownBlock]) -> [String] {
    list.map { block in
      switch block {
      case .heading: return "heading"
      case .paragraph: return "paragraph"
      case .code: return "code"
      case .quote: return "quote"
      case .list: return "list"
      case .rule: return "rule"
      }
    }
  }

  // MARK: - The security line

  func testAScriptTagIsLiteralTextAndNeverABlockOfItsOwn() {
    let parsed = blocks("Hello <script>alert(1)</script> there")
    XCTAssertEqual(kinds(parsed), ["paragraph"])
    XCTAssertEqual(plain(parsed), "Hello <script>alert(1)</script> there")
    // The whole point: a span carries text and flags, so a tag can only ever
    // arrive as characters `Text` draws literally.
    for span in allSpans(parsed) {
      XCTAssertNil(span.href)
      XCTAssertFalse(span.bold || span.italic || span.strike || span.code)
    }
  }

  func testAnImgOnerrorPayloadStaysText() {
    let parsed = blocks(#"<img src=x onerror="alert(1)">"#)
    XCTAssertEqual(plain(parsed), #"<img src=x onerror="alert(1)">"#)
    XCTAssertTrue(allSpans(parsed).allSatisfy { $0.href == nil })
  }

  func testAJavascriptLinkIsRefusedAndItsWordsSurvive() {
    let parsed = blocks("[Click me](javascript:alert(1))")
    XCTAssertEqual(plain(parsed), "Click me")
    XCTAssertTrue(allSpans(parsed).allSatisfy { $0.href == nil })
  }

  func testDataFileAndHttpDestinationsAreRefused() {
    for url in ["data:text/html,<b>x", "file:///etc/passwd", "http://example.com"] {
      let parsed = blocks("[link](\(url))")
      XCTAssertTrue(allSpans(parsed).allSatisfy { $0.href == nil }, url)
      XCTAssertEqual(plain(parsed), "link", url)
    }
  }

  func testAnHttpsLinkIsKept() {
    let spans = allSpans(blocks("See [the issue](https://linear.app/ade/issue/ADE-1)."))
    let link = spans.first { $0.href != nil }
    XCTAssertEqual(link?.text, "the issue")
    XCTAssertEqual(link?.href?.absoluteString, "https://linear.app/ade/issue/ADE-1")
    XCTAssertEqual(plain(blocks("See [the issue](https://linear.app/x).")), "See the issue.")
  }

  func testAutolinkTakesHttpsOnly() {
    XCTAssertEqual(
      allSpans(blocks("<https://ade.dev>")).first?.href?.absoluteString,
      "https://ade.dev"
    )
    XCTAssertTrue(allSpans(blocks("<javascript:alert(1)>")).allSatisfy { $0.href == nil })
    XCTAssertEqual(plain(blocks("<b>bold</b>")), "<b>bold</b>")
  }

  func testABareUrlIsNotAutolinked() {
    // Three clients, three URL-detection regexes, three answers about where a
    // bare URL ends. The subset writes links down instead.
    XCTAssertTrue(allSpans(blocks("Go to https://ade.dev/x, then stop.")).allSatisfy { $0.href == nil })
  }

  func testALinkInsideALinkKeepsOnlyTheOuterDestination() {
    let hrefs = Set(allSpans(blocks("[outer [inner](https://evil.test)](https://ok.test)"))
      .compactMap { $0.href?.absoluteString })
    XCTAssertEqual(hrefs, ["https://ok.test"])
  }

  // MARK: - The subset

  func testHeadingLevels() {
    let levels = blocks("# a\n\n## b\n\n###### f").compactMap { block -> Int? in
      if case let .heading(level, _) = block { return level }
      return nil
    }
    XCTAssertEqual(levels, [1, 2, 6])
    XCTAssertEqual(kinds(blocks("####### g")), ["paragraph"])
  }

  func testEmphasisArrivesAsFlagsIncludingNesting() {
    let spans = allSpans(blocks("**bold** _italic_ ~~gone~~ **b _and i_**"))
    XCTAssertEqual(spans.first { $0.text == "bold" }?.bold, true)
    XCTAssertEqual(spans.first { $0.text == "italic" }?.italic, true)
    XCTAssertEqual(spans.first { $0.text == "gone" }?.strike, true)
    let both = spans.first { $0.text == "and i" }
    XCTAssertEqual(both?.bold, true)
    XCTAssertEqual(both?.italic, true)
  }

  func testSnakeCaseIsNotEmphasisAndAnUnclosedDelimiterIsLiteral() {
    XCTAssertTrue(allSpans(blocks("read plugin_panel_row now")).allSatisfy { !$0.italic })
    XCTAssertEqual(plain(blocks("2 * 3 and **unclosed")), "2 * 3 and **unclosed")
  }

  func testACodeSpanSwallowsEverythingInsideIt() {
    let spans = allSpans(blocks("Run `**not bold** <b>` now"))
    let code = spans.first { $0.code }
    XCTAssertEqual(code?.text, "**not bold** <b>")
    XCTAssertEqual(code?.bold, false)
    XCTAssertNil(code?.href)
  }

  func testFencedBlocks() {
    XCTAssertEqual(blocks("```ts\nconst a = 1;\n```").first, .code(language: "ts", text: "const a = 1;"))
    // An unclosed fence still renders, rather than turning the rest of the
    // document into source.
    XCTAssertEqual(blocks("```\nstill code\n").first, .code(language: nil, text: "still code"))
    XCTAssertEqual(blocks("```\n# not a heading\n```").first, .code(language: nil, text: "# not a heading"))
  }

  func testListsAndTheirStart() {
    guard case let .list(ordered, _, items)? = blocks("- one\n- two").first else {
      return XCTFail("expected a list")
    }
    XCTAssertFalse(ordered)
    XCTAssertEqual(items.count, 2)

    guard case let .list(isOrdered, start, _)? = blocks("3. three\n4. four").first else {
      return XCTFail("expected an ordered list")
    }
    XCTAssertTrue(isOrdered)
    XCTAssertEqual(start, 3)
  }

  func testATaskListIsDataOnly() {
    guard case let .list(_, _, items)? = blocks("- [x] done\n- [ ] not done\n- plain").first else {
      return XCTFail("expected a list")
    }
    XCTAssertEqual(items.map(\.task), [.checked, .unchecked, nil])
    // The marker is consumed, so no client draws the checkbox twice. There is
    // no slot on an item an action could arrive in, which is what makes the
    // rendered box inert by construction rather than by a view's restraint.
    XCTAssertEqual(plain(blocks("- [x] done\n- [ ] not done\n- plain")), "done\nnot done\nplain")
  }

  func testABlockquoteReparsesItsContent() {
    guard case let .quote(inner)? = blocks("> ## quoted\n> and **prose**").first else {
      return XCTFail("expected a quote")
    }
    XCTAssertEqual(kinds(inner), ["heading", "paragraph"])
  }

  func testRuleAndNoSetextHeading() {
    XCTAssertEqual(kinds(blocks("a\n\n---\n\nb")), ["paragraph", "rule", "paragraph"])
    XCTAssertEqual(kinds(blocks("Title\n===")), ["paragraph"])
  }

  func testAnImageBecomesItsAltText() {
    let parsed = blocks("Before ![a diagram](https://ade.dev/x.png) after")
    XCTAssertEqual(plain(parsed), "Before a diagram after")
    XCTAssertTrue(allSpans(parsed).allSatisfy { $0.href == nil })
  }

  func testLineBreaksSurviveInsideAParagraph() {
    XCTAssertEqual(kinds(blocks("one\ntwo")), ["paragraph"])
    XCTAssertEqual(plain(blocks("one\ntwo")), "one\ntwo")
    XCTAssertEqual(blocks("one\n\ntwo").count, 2)
  }

  func testAParagraphEndsWhereTheNextBlockBegins() {
    XCTAssertEqual(kinds(blocks("intro\n- one\n- two")), ["paragraph", "list"])
    XCTAssertEqual(kinds(blocks("intro\n# head")), ["paragraph", "heading"])
  }

  func testADocumentWrittenOnWindows() {
    XCTAssertEqual(kinds(blocks("# a\r\n\r\n- one\r\n- two")), ["heading", "list"])
  }

  func testBackslashEscape() {
    XCTAssertEqual(plain(blocks(#"\*not italic\*"#)), "*not italic*")
    XCTAssertTrue(allSpans(blocks(#"\*not italic\*"#)).allSatisfy { !$0.italic })
  }

  // MARK: - The ceilings

  func testTheBlockBudgetStopsTheWalkAndSaysSo() {
    let source = (0..<(PluginVocabMarkdownLimits.maxBlocks + 20))
      .map { "p\($0)" }
      .joined(separator: "\n\n")
    let parsed = PluginVocabMarkdownParser.parse(source)
    XCTAssertLessThanOrEqual(parsed.blocks.count, PluginVocabMarkdownLimits.maxBlocks)
    XCTAssertTrue(parsed.truncated)
    XCTAssertFalse(PluginVocabMarkdownParser.parse("# a\n\nb").truncated)
  }

  func testAPathologicalRunOfDelimitersIsBounded() {
    let parsed = blocks(String(repeating: "*a*", count: 400))
    for block in parsed {
      if case let .paragraph(spans) = block {
        XCTAssertLessThanOrEqual(spans.count, PluginVocabMarkdownLimits.maxSpans)
      }
    }
    // Nothing is deleted; only the styling past the ceiling is.
    XCTAssertEqual(
      plain(parsed).replacingOccurrences(of: "*", with: ""),
      String(repeating: "a", count: 400)
    )
  }

  // MARK: - The node

  private func node(_ body: String) throws -> PluginVocabNode {
    let json = """
    { "v": 1, "fallback": { "title": "t", "text": "f" }, "body": [\(body)] }
    """
    guard case let .ok(schema, _) = PluginPanelParser.parse(json), let first = schema.body.first else {
      throw XCTSkip("Expected a parsed panel")
    }
    return first
  }

  func testTheNodeParsesADocument() throws {
    // `##"…"##`, not `#"…"#`: the JSON contains `"#` — the quote before the
    // heading's hash — which would close a single-pound raw string right there.
    let parsed = try node(##"{ "component": "markdown", "text": "# Title\n\nBody" }"##)
    XCTAssertEqual(parsed, .markdown(PluginVocabMarkdown(text: "# Title\n\nBody", truncated: false)))
  }

  func testTheNodeDegradesWhenTextIsMissingOrEmpty() throws {
    XCTAssertEqual(try node(#"{ "component": "markdown" }"#).componentName, "markdown")
    if case .markdown = try node(#"{ "component": "markdown" }"#) {
      XCTFail("A markdown node with no text must become an invalid node.")
    }
    if case .markdown = try node(#"{ "component": "markdown", "text": "   " }"#) {
      XCTFail("A markdown node with blank text must become an invalid node.")
    }
  }

  func testTheNodeClampsAnOverLongDocumentAndFlagsIt() throws {
    let long = String(repeating: "a", count: PluginVocabLimits.maxMarkdownChars + 500)
    let parsed = try node(#"{ "component": "markdown", "text": "\#(long)" }"#)
    guard case let .markdown(markdown) = parsed else { return XCTFail("expected a markdown node") }
    XCTAssertEqual(markdown.text.count, PluginVocabLimits.maxMarkdownChars)
    XCTAssertTrue(markdown.truncated)
    // No ellipsis inside the source: it would render as content, and a cut that
    // landed in a fence would draw it as code.
    XCTAssertFalse(markdown.text.hasSuffix("…"))
  }

  func testTheNodeIsRenderableSoItNeverDrawsAsAMarker() {
    XCTAssertTrue(PluginRenderSupport.renderableComponents.contains("markdown"))
    XCTAssertEqual(PluginVocabLimits.maxMarkdownChars, PluginVocabLimits.maxTextChars)
  }

  // MARK: - A golden issue body

  func testEveryFeatureOfTheSubsetInOneDocument() {
    let golden = [
      "## Fix the login redirect",
      "",
      "The redirect drops the `next` param when the session is **stale**.",
      "See [ADE-122](https://linear.app/ade/issue/ADE-122) for the trace.",
      "",
      "- [x] Reproduce on `main`",
      "- [ ] Add a regression test",
      "",
      "> Reviewer: this is ~~blocked~~ ready.",
      "",
      "```ts",
      #"const next = url.searchParams.get("next");"#,
      "```",
      "",
      "---",
      "",
      "<script>alert(1)</script>",
    ].joined(separator: "\n")

    let parsed = PluginVocabMarkdownParser.parse(golden)
    XCTAssertFalse(parsed.truncated)
    XCTAssertEqual(kinds(parsed.blocks), [
      "heading", "paragraph", "list", "quote", "code", "rule", "paragraph",
    ])

    let spans = allSpans(parsed.blocks)
    XCTAssertEqual(spans.first { $0.text == "next" }?.code, true)
    XCTAssertEqual(spans.first { $0.text == "stale" }?.bold, true)
    XCTAssertEqual(spans.first { $0.text == "blocked" }?.strike, true)
    XCTAssertEqual(
      spans.first { $0.text == "ADE-122" }?.href?.absoluteString,
      "https://linear.app/ade/issue/ADE-122"
    )

    if case let .list(_, _, items) = parsed.blocks[2] {
      XCTAssertEqual(items.map(\.task), [.checked, .unchecked])
    } else {
      XCTFail("expected a list")
    }

    XCTAssertEqual(
      parsed.blocks[4],
      .code(language: "ts", text: #"const next = url.searchParams.get("next");"#)
    )
    // The tag is the last paragraph's text, not a tag.
    XCTAssertEqual(plain([parsed.blocks[6]]), "<script>alert(1)</script>")
  }
}
