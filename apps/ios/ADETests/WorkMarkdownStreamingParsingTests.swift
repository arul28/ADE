import SwiftUI
import XCTest
@testable import ADE

/// Equivalence tests for the tail-only streaming markdown parser: replaying a
/// document as a stream of appended deltas must produce, at EVERY snapshot,
/// exactly the same blocks (kinds and ids) as the whole-text parser.
final class WorkMarkdownStreamingParsingTests: XCTestCase {
  /// Feeds `fullText` to the streaming parser in growing snapshots (deltas of
  /// rotating sizes, simulating token-by-token streaming) and compares each
  /// snapshot against `parseMarkdownBlocks` on the same text.
  private func assertStreamingMatchesFullParse(
    _ fullText: String,
    deltaSizes: [Int] = [1, 3, 7, 16],
    cacheKey: String = #function,
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    var snapshot = ""
    var remainder = Substring(fullText)
    var sizeIndex = 0
    while !remainder.isEmpty {
      let size = deltaSizes[sizeIndex % deltaSizes.count]
      sizeIndex += 1
      snapshot += remainder.prefix(size)
      remainder = remainder.dropFirst(size)

      let streamed = parseMarkdownBlocksForStreaming(snapshot, cacheKey: cacheKey)
      let full = parseMarkdownBlocks(snapshot)
      XCTAssertEqual(
        streamed.map(\.id), full.map(\.id),
        "Block id mismatch at snapshot length \(snapshot.count)",
        file: file, line: line
      )
      XCTAssertEqual(
        streamed, full,
        "Block mismatch at snapshot length \(snapshot.count)",
        file: file, line: line
      )
    }
    XCTAssertEqual(snapshot, fullText, "Delta replay must reconstruct the full text", file: file, line: line)
  }

  func testStreamingMatchesFullParseAcrossMixedBlocks() {
    assertStreamingMatchesFullParse("""
    # Release notes

    First paragraph with **bold**, `inline code`, and a [link](https://ade.dev).

    Second paragraph that spans
    two physical lines.

    - unordered one
    - unordered two

    1. ordered one
    2. ordered two

    > quoted line one
    > quoted line two

    ---

    Closing paragraph.
    """)
  }

  func testOrderedListsSplitByBlankLinesKeepSourceNumbers() {
    let blocks = parseMarkdownBlocks("""
    1. first

    2. second

    3. third
    """)

    let starts = blocks.compactMap { block -> Int? in
      guard case .orderedList(let start, _) = block.kind else { return nil }
      return start
    }
    XCTAssertEqual(starts, [1, 2, 3])
  }

  func testStreamingMatchesFullParseWhileCodeFenceOpensAndClosesAcrossDeltas() {
    // The fence opens in one snapshot and closes many deltas later; the blank
    // lines INSIDE the fence must never be picked as a split boundary.
    assertStreamingMatchesFullParse("""
    Intro paragraph.

    ```swift
    let a = 1

    let b = 2

    print(a | b)
    ```

    Middle paragraph.

    ```sh
    echo hi
    ```

    Outro paragraph.
    """)
  }

  func testStreamingMatchesFullParseWithUnclosedTrailingFence() {
    // Streaming frequently ends a snapshot mid-fence; the unclosed fence must
    // stay one growing code block and never split at its interior blank lines.
    assertStreamingMatchesFullParse("""
    Para one.

    Para two.

    ```python
    print(1)

    print(2)
    """)
  }

  func testStreamingMatchesFullParseAcrossTables() {
    assertStreamingMatchesFullParse("""
    Status summary:

    | Name | Status | Owner |
    | --- | --- | --- |
    | Build |  | ADE |
    | Ship | done |  |

    After the table.

    | A | B |
    | - | - |
    | 1 | 2 |
    """)
  }

  func testStreamingMatchesFullParseWithCRLFNewlines() {
    let text = "# Title\r\n\r\nParagraph one.\r\n\r\n```js\r\nconst x = 1\r\n```\r\n\r\n- item"
    assertStreamingMatchesFullParse(text, deltaSizes: [2, 5])
  }

  /// An oversized paragraph becomes several blocks, and the tail-only parser
  /// has to agree with the whole-text parser about every one of them. It can:
  /// the split is a function of one paragraph's text, and a paragraph never
  /// crosses the blank line the streaming parser splits at, so both paths chunk
  /// the same text. Anything that broke that would show up as a block the two
  /// paths number differently — the identity churn this parser exists to avoid.
  func testStreamingMatchesFullParseWithAnOversizedParagraph() {
    let wall = (1...70)
      .map { "\($0). The keeper walked the length of the gallery and counted the lamps again." }
      .joined(separator: " ")
    assertStreamingMatchesFullParse("Short opener.\n\n\(wall)\n\nShort closer.", deltaSizes: [23, 61])
  }

  func testStreamingRepeatedCallsWithSameTextReturnStableBlocks() {
    let text = "Para one.\n\n```swift\nlet a = 1\n```\n\nPara two."
    let first = parseMarkdownBlocksForStreaming(text, cacheKey: #function)
    let second = parseMarkdownBlocksForStreaming(text, cacheKey: #function)
    XCTAssertEqual(first, second)
    XCTAssertEqual(first, parseMarkdownBlocks(text))
  }

  func testStreamingRecoversWhenTextIsRewrittenUnderSameKey() {
    // Message text is not strictly append-only (dedup can rewrite it); a
    // non-extension rewrite under the same cache key must still parse exactly.
    let key = #function
    _ = parseMarkdownBlocksForStreaming("AAA paragraph.\n\nBBB paragraph.\n\nCCC tail", cacheKey: key)
    let rewritten = "# Different\n\nEntirely new body.\n\n- a\n- b"
    XCTAssertEqual(
      parseMarkdownBlocksForStreaming(rewritten, cacheKey: key),
      parseMarkdownBlocks(rewritten)
    )
    let shrunk = "Tiny"
    XCTAssertEqual(
      parseMarkdownBlocksForStreaming(shrunk, cacheKey: key),
      parseMarkdownBlocks(shrunk)
    )
  }
}

final class WorkStreamingMonospacedClassifierTests: XCTestCase {
  func testAppendCanFlipAFalseClassificationWhenSecondAlignedRowArrives() {
    var state = WorkStreamingMonospacedClassifierState()
    state.append("left   value\n")
    XCTAssertFalse(state.usesMonospacedRendering)

    state.append("right   value")
    XCTAssertTrue(state.usesMonospacedRendering)
  }

  func testAlignedRowsInsideFenceDoNotClassifyUntilFenceCloses() {
    var state = WorkStreamingMonospacedClassifierState()
    state.append("```text\nleft   value\nright   value\n")
    XCTAssertFalse(state.usesMonospacedRendering)

    state.append("```\nleft   value\nright   value")
    XCTAssertTrue(state.usesMonospacedRendering)
  }

  func testClassifierMatchesWholeTextAcrossDeltaBoundaries() {
    let text = "Intro\n\n```\nleft   value\nright   value\n```\n\nleft   value\nright   value"
    var state = WorkStreamingMonospacedClassifierState()
    var snapshot = ""
    for character in text {
      snapshot.append(character)
      state.append(String(character))
      XCTAssertEqual(
        state.usesMonospacedRendering,
        workAssistantMessageUsesMonospacedPreview(snapshot),
        "classifier diverged at \(snapshot.count) characters"
      )
    }
  }
}

/// Diagnostic benchmark for the path that previously rescanned the entire
/// growing assistant response on every delta. It deliberately reports rather
/// than asserts wall-clock numbers: CI hosts vary, but the optimized path must
/// remain visible in test logs and in the simulator trace.
final class WorkStreamingPreviewPerformanceTests: XCTestCase {
  func testStreamingAssistantPreviewCostIsReported() {
    let deltaCount = 500
    var optimizedMessage = WorkChatMessage(
      id: "assistant-preview-benchmark",
      role: "assistant",
      markdown: "Seed.",
      timestamp: "2026-03-25T00:00:01.000Z",
      turnId: "turn-1",
      itemId: "item-1"
    )
    let optimizedCache = WorkAssistantPreviewCache()
    let characterBudget = workAssistantMessageCharacterBudget(
      forLineBudget: workAssistantMessageInitialLineBudget
    )

    let optimizedStart = Date()
    for index in 1...deltaCount {
      _ = workApplyStreamingAssistantText(
        " Delta \(index): the keeper walked the length of the gallery and counted the lamps again.",
        to: &optimizedMessage
      )
      _ = optimizedCache.preview(
        for: optimizedMessage,
        anchor: .tail,
        lineBudget: workAssistantMessageInitialLineBudget,
        characterBudget: characterBudget,
        classification: nil
      )
    }
    let optimizedSeconds = Date().timeIntervalSince(optimizedStart)

    var baselineText = "Seed."
    let baselineStart = Date()
    for index in 1...deltaCount {
      baselineText += " Delta \(index): the keeper walked the length of the gallery and counted the lamps again."
      _ = workAssistantMessagePreview(
        baselineText,
        lineBudget: workAssistantMessageInitialLineBudget,
        characterBudget: characterBudget,
        anchor: .tail
      )
    }
    let baselineSeconds = Date().timeIntervalSince(baselineStart)

    XCTAssertEqual(optimizedMessage.markdown, baselineText)
    print(String(
      format: "assistant preview streaming benchmark: %d deltas / %d chars; optimized %.1f ms, full-rescan baseline %.1f ms, speedup %.1fx",
      deltaCount,
      baselineText.count,
      optimizedSeconds * 1000,
      baselineSeconds * 1000,
      baselineSeconds / max(optimizedSeconds, .leastNonzeroMagnitude)
    ))
  }
}

/// The syntax highlighter reuses an already-highlighted stable prefix while a
/// code block streams. The property that has to hold is the same one the
/// markdown parser is held to: at every snapshot, the incremental render must
/// equal a from-scratch render of the same text.
final class SyntaxHighlighterStreamingTests: XCTestCase {
  override func setUp() {
    super.setUp()
    // Streaming prefix state is process-wide; start each case cold.
    ADECodeRenderingCache.shared.purgeOnMemoryWarning()
  }

  private func assertIncrementalMatchesFullHighlight(
    _ fullText: String,
    as language: FilesLanguage,
    deltaSizes: [Int] = [1, 4, 11],
    file: StaticString = #filePath,
    line: UInt = #line
  ) {
    var snapshot = ""
    var remainder = Substring(fullText)
    var sizeIndex = 0
    while !remainder.isEmpty {
      snapshot += remainder.prefix(deltaSizes[sizeIndex % deltaSizes.count])
      remainder = remainder.dropFirst(deltaSizes[sizeIndex % deltaSizes.count])
      sizeIndex += 1

      let incremental = SyntaxHighlighter.highlightedAttributedString(snapshot, as: language)
      let reference = SyntaxHighlighter.highlightedSegment(Substring(snapshot), as: language)
      if incremental != reference {
        XCTFail(
          """
          Highlight mismatch at snapshot length \(snapshot.count).
          Snapshot: \(snapshot.debugDescription)
          First differing run: \(Self.firstRunDifference(incremental, reference) ?? "<none>")
          """,
          file: file, line: line
        )
        return
      }
    }
  }

  /// Reports the first run whose text or attributes diverge, so a failure names
  /// the construct that broke rather than dumping two whole documents.
  private static func firstRunDifference(
    _ lhs: AttributedString,
    _ rhs: AttributedString
  ) -> String? {
    let lhsRuns = Array(lhs.runs)
    let rhsRuns = Array(rhs.runs)
    for index in 0..<max(lhsRuns.count, rhsRuns.count) {
      guard index < lhsRuns.count else { return "extra reference run: \(String(rhs[rhsRuns[index].range].characters).debugDescription)" }
      guard index < rhsRuns.count else { return "extra incremental run: \(String(lhs[lhsRuns[index].range].characters).debugDescription)" }
      let lhsText = String(lhs[lhsRuns[index].range].characters)
      let rhsText = String(rhs[rhsRuns[index].range].characters)
      if lhsText != rhsText || lhsRuns[index].attributes != rhsRuns[index].attributes {
        return "run \(index): incremental \(lhsText.debugDescription) vs reference \(rhsText.debugDescription)"
      }
    }
    return nil
  }

  func testStreamingSwiftBlockMatchesFullHighlight() {
    assertIncrementalMatchesFullHighlight(
      """
      import Foundation

      struct Counter {
        // A line comment with a / and a * in it.
        var value = 0

        func bump(by amount: Int) -> Int {
          value += amount
          return value
        }
      }
      """,
      as: .swift
    )
  }

  func testStreamingBlockCommentSpanningLinesMatchesFullHighlight() {
    // A stable boundary must never land inside the comment: the prefix would
    // then be highlighted as code and never corrected.
    assertIncrementalMatchesFullHighlight(
      """
      let a = 1
      /* opening
         still inside
         and here */
      let b = 2
      """,
      as: .swift
    )
  }

  func testStreamingTemplateLiteralSpanningLinesMatchesFullHighlight() {
    assertIncrementalMatchesFullHighlight(
      """
      const q = `select *
      from t
      where id = 1`
      const n = 42
      """,
      as: .typescript
    )
  }

  func testStreamingPythonTripleQuotedStringMatchesFullHighlight() {
    assertIncrementalMatchesFullHighlight(
      """
      def f():
          \"\"\"Doc line one.

          Doc line two.
          \"\"\"
          return 1
      """,
      as: .python
    )
  }

  /// The incremental path must render a token-dense block exactly like the
  /// previous whole-text algorithm.
  ///
  /// The streaming-equivalence tests above compare `highlightedAttributedString`
  /// against `highlightedSegment`, which share their span/attribute logic — so
  /// they cannot catch a change in that logic. This pins it against the
  /// independent implementation the rewrite replaced.
  func testHighlightMatchesPreviousWholeTextAlgorithm() {
    let sources: [(FilesLanguage, String)] = [
      (.swift, """
      import Foundation
      // A comment mentioning Counter and 42
      struct Counter {
        let label = "Counter value: 42"
        func bump() -> Int { return 1 }
      }
      """),
      (.python, """
      def f(x):
          # returns Value 7
          s = "Value 7"
          return s
      """),
      (.html, """
      <div class="Box">
      <!-- comment with Value 3
           still commented -->
      <span>Text</span>
      </div>
      """),
    ]
    for (language, source) in sources {
      ADECodeRenderingCache.shared.purgeOnMemoryWarning()
      let rewritten = SyntaxHighlighter.highlightedSegment(Substring(source), as: language)
      let legacy = Self.legacyHighlight(source, as: language)
      if rewritten != legacy {
        XCTFail(
          """
          \(language.rawValue) highlight diverged from the previous algorithm.
          First differing run: \(Self.firstRunDifference(rewritten, legacy) ?? "<none>")
          """
        )
      }
    }
  }

  /// Replays a long code block as a token stream and reports the cost of the
  /// incremental path against the previous whole-text algorithm, which is
  /// reproduced here (full tokenize + `index(offsetBy:)` walked from the start
  /// for every token).
  ///
  /// Diagnostic only. The correctness gate is
  /// `testHighlightMatchesPreviousWholeTextAlgorithm`; asserting on wall-clock
  /// here would just add a flake under CI load.
  func testStreamingHighlightCostIsReported() {
    let line = "  let value\(Int.random(in: 0...9)) = compute(from: \"input\", count: 12) // step\n"
    let fullText = String(repeating: line, count: 200)

    var snapshots: [String] = []
    var snapshot = ""
    var remainder = Substring(fullText)
    while !remainder.isEmpty {
      snapshot += remainder.prefix(24)
      remainder = remainder.dropFirst(24)
      snapshots.append(snapshot)
    }

    ADECodeRenderingCache.shared.purgeOnMemoryWarning()
    let incrementalStart = Date()
    for snapshot in snapshots {
      _ = SyntaxHighlighter.highlightedAttributedString(snapshot, as: .swift)
    }
    let incrementalSeconds = Date().timeIntervalSince(incrementalStart)

    ADECodeRenderingCache.shared.purgeOnMemoryWarning()
    let wholeTextStart = Date()
    for snapshot in snapshots {
      _ = SyntaxHighlighter.highlightedSegment(Substring(snapshot), as: .swift)
    }
    let wholeTextSeconds = Date().timeIntervalSince(wholeTextStart)

    ADECodeRenderingCache.shared.purgeOnMemoryWarning()
    let legacyStart = Date()
    for snapshot in snapshots {
      _ = Self.legacyHighlight(snapshot, as: .swift)
    }
    let legacySeconds = Date().timeIntervalSince(legacyStart)
    print(String(
      format: "whole-text with the role fill (no prefix reuse): %.3f ms per tick (%.1fx vs previous)",
      wholeTextSeconds * 1000 / Double(snapshots.count),
      legacySeconds / max(wholeTextSeconds, .leastNonzeroMagnitude)
    ))

    let ticks = Double(snapshots.count)
    print(String(
      format: "streaming highlight over %d ticks (%d chars): incremental %.1f ms total / %.3f ms per tick, previous %.1f ms total / %.3f ms per tick (%.1fx)",
      snapshots.count,
      fullText.count,
      incrementalSeconds * 1000,
      incrementalSeconds * 1000 / ticks,
      legacySeconds * 1000,
      legacySeconds * 1000 / ticks,
      legacySeconds / max(incrementalSeconds, .leastNonzeroMagnitude)
    ))
  }

  /// The pre-change algorithm, verbatim: tokenize the whole text, then walk from
  /// `startIndex` for every token, letting later tokens overwrite the ranges
  /// they overlap. Serves as both the benchmark baseline and the correctness
  /// oracle, so it applies the real per-role attributes.
  private static func legacyHighlight(_ text: String, as language: FilesLanguage) -> AttributedString {
    var attributed = AttributedString(text)
    attributed.font = .system(.body, design: .monospaced)
    attributed.foregroundColor = ADEColor.textPrimary
    for token in SyntaxHighlighter.tokenize(text, as: language) {
      guard let stringRange = Range(token.range, in: text) else { continue }
      let startOffset = text.distance(from: text.startIndex, to: stringRange.lowerBound)
      let endOffset = text.distance(from: text.startIndex, to: stringRange.upperBound)
      let lowerBound = attributed.characters.index(attributed.startIndex, offsetBy: startOffset)
      let upperBound = attributed.characters.index(attributed.startIndex, offsetBy: endOffset)
      attributed[lowerBound..<upperBound].foregroundColor = token.role.tint
      attributed[lowerBound..<upperBound].font = token.role.font
    }
    return attributed
  }

  func testStreamingEscapedBacktickKeepsTemplateLiteralOpen() {
    // The template-literal rule consumes `\\.`, so an escaped backtick does not
    // end the string. A boundary landing on the newline after it would freeze
    // the rest of the literal into the prefix as mis-highlighted code.
    assertIncrementalMatchesFullHighlight(
      #"""
      const q = `a \` b
      still inside
      ` + `second`
      const n = 42
      """#,
      as: .typescript
    )
  }

  func testStreamingEscapedQuoteInsideTripleQuotedStringStaysOpen() {
    assertIncrementalMatchesFullHighlight(
      #"""
      def f():
          s = """doc \" line

          more
          """
          return s
      """#,
      as: .python
    )
  }

  func testStreamingGoRawStringWithTrailingBackslashMatchesFullHighlight() {
    // Go raw strings process no escapes, so the backslash before the closing
    // backtick does not escape it. Treating it as an escape desynchronizes the
    // delimiter parity and can leave a later multi-line raw string looking
    // closed — the boundary would then split inside it.
    assertIncrementalMatchesFullHighlight(
      #"""
      a := `C:\path\`
      b := `multi
      line`
      c := 1
      """#,
      as: .go
    )
  }

  func testStreamingHtmlAttributeStringSpanningLinesMatchesFullHighlight() {
    // The quote rules use `[^"\\]`, which matches newlines, so an attribute
    // value left open runs across lines for the tokenizer.
    assertIncrementalMatchesFullHighlight(
      """
      <div class="a
      b">
      <span>text</span>
      </div>
      """,
      as: .html
    )
  }

  func testStreamingYamlQuotedValueSpanningLinesMatchesFullHighlight() {
    assertIncrementalMatchesFullHighlight(
      """
      key: "first
        continued"
      other: 2
      """,
      as: .yaml
    )
  }

  func testStreamingApostropheInCommentDoesNotSplitInsideAStringMatch() {
    // A lone apostrophe in a comment still opens a string match for the rule
    // that scans independently of the comment rule.
    assertIncrementalMatchesFullHighlight(
      """
      // don't do this
      const x = 'ok'
      const y = 2
      """,
      as: .javascript
    )
  }

  func testEscapedQuoteOutsideAStringStillOpensOne() {
    // `\'` in a comment is not an escape — nothing is open for it to escape.
    // The string rule has no preceding-backslash check either, so it opens a
    // match there that runs to the apostrophe two lines later; treating the
    // backslash as an escape would swallow it and mark the newline stable.
    assertIncrementalMatchesFullHighlight(
      #"""
      // path\' here
      // it's fine
      const x = 1
      """#,
      as: .javascript
    )
  }

  func testStreamingHtmlCommentSpanningLinesMatchesFullHighlight() {
    // HTML's comment rule spans lines like a `/* */` block; a stable boundary
    // landing inside one would freeze mis-highlighted markup into the prefix.
    assertIncrementalMatchesFullHighlight(
      """
      <div>
      <!-- opening
           still inside

           and here -->
      <span>after</span>
      </div>
      """,
      as: .html
    )
  }

  /// Languages allowed to reuse a stable prefix, each pinned to the rule
  /// patterns that claim was made about.
  ///
  /// Reuse is only sound while nothing in a language's rules can match across a
  /// newline except the delimiters the boundary counts. That is a property of
  /// the patterns, not something the code can re-derive, and every time it has
  /// been wrong the symptom was a completed block frozen mis-highlighted in
  /// cache. If one of these fingerprints changes, re-check the new pattern
  /// against `multilineDelimiters(for:)` before updating the constant.
  private static let prefixReuseFingerprints: [FilesLanguage: String] = [
    .swift: "2c7b721d13b3bcc9",
    .typescript: "fa894f542c775be5",
    .javascript: "2f738c3408aa7929",
    .python: "6de225fbadd012d8",
    .rust: "563f92af2415db71",
    .go: "3575d64645ceff4c",
    .java: "aa8e57e8d480c530",
    .html: "561765deebafcca7",
  ]

  func testLanguagesWithUnmodelledMultilineRulesOptOutOfPrefixReuse() {
    // Each of these has a rule whose match crosses, or depends on text past, a
    // newline with no delimiter to count: CSS selector lists, YAML's `^\s*` key
    // rule, Markdown links, and JSON's `(?=\s*:)` key lookahead.
    for language in [FilesLanguage.css, .yaml, .markdown, .json] {
      XCTAssertNil(
        SyntaxHighlighter.multilineDelimiters(for: language),
        "\(language.rawValue) has newline-crossing rules the balance scan cannot model"
      )
    }
    for language in Self.prefixReuseFingerprints.keys {
      XCTAssertNotNil(SyntaxHighlighter.multilineDelimiters(for: language))
    }
  }

  func testPrefixReuseLanguagesStillHaveTheRulesThatClaimWasMadeAbout() {
    for (language, pinned) in Self.prefixReuseFingerprints where !pinned.isEmpty {
      XCTAssertEqual(
        SyntaxHighlighter.tokenRuleFingerprint(for: language), pinned,
        """
        \(language.rawValue)'s token rules changed. Prefix reuse assumes no rule \
        matches across a newline except the counted delimiters — re-check the new \
        pattern against multilineDelimiters(for:), then update this fingerprint.
        """
      )
    }
  }

  func testStreamingJsonKeyLookaheadMatchesFullHighlight() {
    // The key rule only matches once `(?=\s*:)` finds the colon, which can
    // arrive after the newline — the key would otherwise freeze unhighlighted.
    assertIncrementalMatchesFullHighlight("{\n  \"key\"\n: 1,\n  \"b\": 2\n}", as: .json)
  }

  func testMultilineCssSelectorStillMatchesFullHighlight() {
    assertIncrementalMatchesFullHighlight(
      """
      .foo,
      .bar {
        color: red;
      }
      """,
      as: .css
    )
  }

  func testMultilineYamlAndMarkdownStillMatchFullHighlight() {
    assertIncrementalMatchesFullHighlight("a:\n\n  b: 1\nc: 2", as: .yaml)
    assertIncrementalMatchesFullHighlight("see [long\nlink](https://x.test)\n\ntext", as: .markdown)
  }

  func testDifferentBlockOfSameLanguageDoesNotReuseForeignPrefix() {
    let first = "let alpha = 1\nlet beta = 2\n"
    _ = SyntaxHighlighter.highlightedAttributedString(first, as: .swift)
    let unrelated = "func gamma() {\n  return\n}\n"
    XCTAssertEqual(
      SyntaxHighlighter.highlightedAttributedString(unrelated, as: .swift),
      SyntaxHighlighter.highlightedSegment(Substring(unrelated), as: .swift)
    )
  }
}

/// The composer's downscaled image has to survive the placeholder → host-path
/// swap, or the fresh chip flashes the generic placeholder while it re-fetches
/// the image the phone just uploaded.
@MainActor
final class WorkPendingUploadPreviewStoreTests: XCTestCase {
  private func makeAttachment() -> WorkChatInputAttachment {
    WorkChatInputAttachment(
      image: UIImage(systemName: "photo") ?? UIImage(),
      uploadData: Data([0x01]),
      filename: "shot.jpg",
      state: .ready
    )
  }

  func testPromotedImageResolvesUnderTheHostPath() {
    let store = WorkPendingUploadPreviewStore.shared
    let placeholders = store.register([makeAttachment()])
    XCTAssertEqual(placeholders.count, 1)
    XCTAssertNotNil(store.image(forPath: placeholders[0].path))

    let saved = [AgentChatFileRef(path: "/project/.ade/attachments/shot.jpg", type: "image")]
    store.promote(placeholders, to: saved)

    XCTAssertNotNil(store.image(forPath: saved[0].path), "no image means the chip flashes a placeholder")
    XCTAssertNil(store.image(forPath: placeholders[0].path), "the placeholder key must not linger")
    store.release(saved)
  }

  func testMismatchedSaveCountReleasesRatherThanMispairing() {
    let store = WorkPendingUploadPreviewStore.shared
    let placeholders = store.register([makeAttachment(), makeAttachment()])
    // One attachment failed to produce a ref: pairing positionally would attach
    // the first image's bytes to a path it does not belong to.
    store.promote(placeholders, to: [AgentChatFileRef(path: "/project/.ade/attachments/only.jpg", type: "image")])

    XCTAssertNil(store.image(forPath: "/project/.ade/attachments/only.jpg"))
    XCTAssertTrue(placeholders.allSatisfy { store.image(forPath: $0.path) == nil })
  }

  func testStoreIsBoundedToRoughlyOneMessageOfAttachments() {
    let store = WorkPendingUploadPreviewStore.shared
    let refs = store.register((0..<(workPendingUploadPreviewLimit + 4)).map { _ in makeAttachment() })
    let retained = refs.filter { store.image(forPath: $0.path) != nil }
    XCTAssertEqual(retained.count, workPendingUploadPreviewLimit)
    XCTAssertTrue(
      retained.allSatisfy { refs.suffix(workPendingUploadPreviewLimit).contains($0) },
      "the newest entries are the ones worth keeping"
    )
    store.release(refs)
  }
}

/// A streaming turn used to insert one throwaway render per delta into the
/// shared inline-markdown cache, evicting every finished message in a long
/// chat. Intermediate revisions now render without displacing finished work,
/// and the final revision is promoted.
final class WorkInlineMarkdownCacheTests: XCTestCase {
  override func setUp() {
    super.setUp()
    workPurgeMarkdownRenderCaches()
  }

  func testIntermediateRevisionsAreNotInsertedIntoTheSharedCache() {
    var snapshot = ""
    for word in "the agent is writing a fairly long answer here".split(separator: " ") {
      snapshot += (snapshot.isEmpty ? "" : " ") + word
      _ = markdownAttributedString(snapshot, intermediate: true)
      XCTAssertFalse(
        workMarkdownSharedCacheHolds(snapshot),
        "Streaming revision \"\(snapshot)\" must not occupy the shared cache"
      )
    }
  }

  func testFinalRevisionIsPromotedIntoTheSharedCache() {
    let finished = "A completed **message** with `code`."
    _ = markdownAttributedString(finished, intermediate: true)
    XCTAssertFalse(workMarkdownSharedCacheHolds(finished))

    _ = markdownAttributedString(finished, intermediate: false)
    XCTAssertTrue(workMarkdownSharedCacheHolds(finished))
  }

  func testIntermediateAndFinalRendersAreIdentical()  {
    let text = "Mixed *emphasis*, `inline code`, and a https://example.com link."
    let intermediate = markdownAttributedString(text, intermediate: true)
    workPurgeMarkdownRenderCaches()
    XCTAssertEqual(intermediate, markdownAttributedString(text, intermediate: false))
  }

  /// The headline regression: a minute-long turn produces hundreds of tail
  /// revisions. Before intermediate exclusion those filled the 256-entry cache
  /// and evicted the finished messages above them, so scrolling back re-parsed
  /// the transcript on the main thread.
  func testLongStreamingTurnDoesNotEvictCompletedMessages() {
    let completed = (0..<40).map { "Completed message number \($0) with some **body** text." }
    for message in completed {
      _ = markdownAttributedString(message)
    }

    var tail = ""
    for index in 0..<600 {
      tail += "token\(index) "
      _ = markdownAttributedString(tail, intermediate: true)
    }

    for message in completed {
      XCTAssertTrue(
        workMarkdownSharedCacheHolds(message),
        "\(message.debugDescription) was evicted by streaming tail revisions"
      )
    }
  }

  /// A streaming tail that parses as a table renders through `WorkMarkdownTable`
  /// rather than the paragraph path, so its cells need the same intermediate
  /// routing — a long table would otherwise evict the completed messages the
  /// exclusion exists to protect.
  func testStreamingTableCellRevisionsStayOutOfTheSharedCache() {
    let completed = "A finished message worth keeping cached."
    _ = markdownAttributedString(completed)
    XCTAssertTrue(workMarkdownSharedCacheHolds(completed))

    // Cells arriving token by token, the way a table streams.
    var cell = ""
    for token in ["Build", " status", " green", " for", " every", " shard"] {
      cell += token
      _ = markdownAttributedString(cell, intermediate: true)
      XCTAssertFalse(
        workMarkdownSharedCacheHolds(cell),
        "streaming cell \(cell.debugDescription) must not occupy the shared cache"
      )
    }

    XCTAssertTrue(workMarkdownSharedCacheHolds(completed), "the finished message must survive")
    _ = markdownAttributedString(cell, intermediate: false)
    XCTAssertTrue(workMarkdownSharedCacheHolds(cell), "the settled cell is promoted like any other block")
  }

  func testMemoryWarningPurgeDropsRenders() {
    let text = "Something worth caching."
    _ = markdownAttributedString(text)
    XCTAssertTrue(workMarkdownSharedCacheHolds(text))
    workPurgeMarkdownRenderCaches()
    XCTAssertFalse(workMarkdownSharedCacheHolds(text))
  }

}

/// One assistant paragraph with no blank line in it used to render as a single
/// row many screens tall. The transcript's `LazyVStack` estimates the height of
/// every row it has not realized from the ones it has, so one outlier moves the
/// estimate, the moved estimate changes which rows are realized, and the two
/// never settle — the main thread pinned at 100% with the chat frozen mid-turn.
///
/// These tests hold the split to the three things that make it safe: rows stay
/// inside the budget, the text survives, and a cut is never moved or withdrawn
/// once the row carrying it has been rendered.
final class WorkBoundedProseRowTests: XCTestCase {
  private func wallOfProse(sentences: Int) -> String {
    (1...sentences)
      .map { "\($0). The keeper walked the length of the gallery and counted the lamps again." }
      .joined(separator: " ")
  }

  /// Words in order, ignoring where the whitespace fell. This supplements the
  /// lossless joined-string assertions with a readable failure if a cut ever
  /// drops, duplicates, or reorders a token.
  private func words(_ text: String) -> [String] {
    text.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }
  }

  // MARK: - The budget

  func testLongParagraphIsSplitIntoBoundedRows() {
    let text = wallOfProse(sentences: 120)
    let chunks = workBoundedProseChunks(text)
    XCTAssertGreaterThan(chunks.count, 1, "a wall of prose has to become several rows")
    for chunk in chunks {
      XCTAssertLessThanOrEqual(
        chunk.count,
        workMarkdownProseRowCharacterLimit,
        "every row must stay inside the layout budget"
      )
    }
    XCTAssertEqual(
      chunks.joined(),
      text,
      "splitting may only insert row boundaries, never change the text"
    )
  }

  func testShortParagraphIsNotSplit() {
    let text = "One sentence. Two sentences. That is the whole answer."
    XCTAssertEqual(workBoundedProseChunks(text), [text])
  }

  /// The budget is counted in characters because row height follows glyphs. A
  /// byte budget would let a Japanese paragraph run three times as tall as an
  /// English one, and a script that does not put spaces between words offers no
  /// word gap to cut at — so the cut has to fall back to the budget's own edge,
  /// exactly as line breaking in those scripts already does.
  func testParagraphWithNoWordGapsIsStillBounded() {
    let text = String(repeating: "検索結果を確認してください。これは長い段落です。", count: 200)
    let chunks = workBoundedProseChunks(text)
    XCTAssertGreaterThan(text.utf8.count, text.count, "the fixture has to be multi-byte to mean anything")
    XCTAssertGreaterThan(chunks.count, 1, "a script without word gaps still needs bounded rows")
    for chunk in chunks {
      XCTAssertLessThanOrEqual(chunk.count, workMarkdownProseRowCharacterLimit)
    }
    XCTAssertEqual(chunks.joined(), text, "a gapless script has no whitespace to lose")
  }

  func testHardWrappedParagraphKeepsEveryWord() {
    let text = (1...90)
      .map { "Line \($0) of a hard wrapped paragraph the agent never separated with a blank line." }
      .joined(separator: "\n")
    let chunks = workBoundedProseChunks(text)
    XCTAssertGreaterThan(chunks.count, 1)
    XCTAssertEqual(words(chunks.joined(separator: " ")), words(text))
  }

  func testGraphemeClustersAreNeverSplit() {
    let text = Array(repeating: "👩‍👩‍👧‍👦 family", count: 400).joined(separator: " ")
    let chunks = workBoundedProseChunks(text)
    XCTAssertGreaterThan(chunks.count, 1)
    XCTAssertEqual(words(chunks.joined(separator: " ")), words(text))
  }

  // MARK: - Cuts settle and stay settled

  /// A paragraph that is still streaming must keep every already-rendered row
  /// byte-identical: same text, same digest, same `markdown-block-<n>` id, and
  /// a cache hit instead of a fresh `AttributedString(markdown:)` per row per
  /// delta. Only the last row may change, and the row count may only grow.
  func testGrowingParagraphKeepsEarlierChunksStable() {
    var previous: [String] = []
    for sentences in stride(from: 20, through: 200, by: 20) {
      let chunks = workBoundedProseChunks(wallOfProse(sentences: sentences))
      XCTAssertGreaterThanOrEqual(
        chunks.count, previous.count,
        "the row count may never drop — every id after the drop would change"
      )
      for (index, settled) in previous.dropLast().enumerated() {
        XCTAssertEqual(
          chunks[index], settled,
          "row \(index) changed when the paragraph grew to \(sentences) sentences"
        )
      }
      previous = chunks
    }
  }

  /// The regression that matters most. An agent typing `` `configuration` ``
  /// mid-paragraph leaves the backtick unclosed for a few deltas. Judging the
  /// split as a whole made that tail retract every cut ahead of it: the
  /// paragraph collapsed from four blocks to one and came back when the closing
  /// backtick arrived, renumbering every block in the message twice — the exact
  /// churn the split exists to remove. Cuts are decided one at a time, out of
  /// text that has already arrived, so an unfinished span cannot reach back.
  func testUnclosedInlineSpanInTheTailDoesNotRetractEarlierCuts() {
    let base = wallOfProse(sentences: 80)
    let deltas = [
      "",
      " Then he checked",
      " Then he checked `configuration",
      " Then he checked `configuration.reload()",
      " Then he checked `configuration.reload()`",
      " Then he checked `configuration.reload()` and left.",
    ]
    var previous: [String] = []
    for delta in deltas {
      let chunks = workBoundedProseChunks(base + delta)
      XCTAssertGreaterThanOrEqual(
        chunks.count, previous.count,
        "an unclosed span collapsed the split at delta \(delta.debugDescription)"
      )
      for (index, settled) in previous.dropLast().enumerated() {
        XCTAssertEqual(chunks[index], settled, "row \(index) moved at delta \(delta.debugDescription)")
      }
      previous = chunks
    }
    XCTAssertGreaterThan(previous.count, 1)
  }

  /// Replays a paragraph character group by character group, the way a real
  /// turn arrives, over text carrying every inline construct the cut has an
  /// opinion about.
  func testCutsNeverMoveWhileAParagraphStreamsInSmallDeltas() {
    let text = wallOfProse(sentences: 60)
      + " He wrote `reload()` twice, then **stopped**, then noted [the ledger](x)"
      + " and *left* at 2 * 3 o'clock. "
      + wallOfProse(sentences: 60)
    var previous: [String] = []
    var cursor = text.startIndex
    while cursor < text.endIndex {
      cursor = text.index(cursor, offsetBy: 17, limitedBy: text.endIndex) ?? text.endIndex
      let chunks = workBoundedProseChunks(String(text[..<cursor]))
      XCTAssertGreaterThanOrEqual(chunks.count, previous.count)
      for (index, settled) in previous.dropLast().enumerated() {
        XCTAssertEqual(chunks[index], settled, "row \(index) moved at length \(text[..<cursor].count)")
      }
      previous = chunks
    }
    XCTAssertGreaterThan(previous.count, 1)
    XCTAssertEqual(words(previous.joined(separator: " ")), words(text))
  }

  // MARK: - Inline markup

  func testNoRowEndsInsideACodeSpanOrBoldRun() {
    let text = wallOfProse(sentences: 40)
      + " a `code span with several words in it` and **a bold run that also spans words** done. "
      + wallOfProse(sentences: 40)
    let chunks = workBoundedProseChunks(text)
    XCTAssertGreaterThan(chunks.count, 1)
    for chunk in chunks {
      XCTAssertTrue(
        (chunk.components(separatedBy: "`").count - 1).isMultiple(of: 2),
        "a row ended inside a code span: \(chunk.suffix(40).debugDescription)"
      )
      XCTAssertTrue(
        (chunk.components(separatedBy: "**").count - 1).isMultiple(of: 2),
        "a row ended inside a bold run: \(chunk.suffix(40).debugDescription)"
      )
    }
  }

  /// One emphasis span opened at the very start and closed at the very end: no
  /// interior boundary can leave a row balanced, so the paragraph stays whole.
  /// A tall row is the lesser evil against a row rendering a stray `**`.
  func testParagraphWrappedEntirelyInOneSpanIsLeftWhole() {
    let text = "**" + wallOfProse(sentences: 120) + "**"
    XCTAssertEqual(workBoundedProseChunks(text), [text])
  }

  /// Emphasis is only counted where it could actually open or close a span.
  /// Reading arithmetic as markup would leave the parity wrong for the whole
  /// rest of the paragraph, and one stray character would cost every later cut
  /// — handing the transcript back the giant row this split exists to prevent.
  func testStrayDelimitersDoNotDisableLaterCuts() {
    for stray in [" the product is 2 * 3 and nothing more. ", " the value at index] was wrong. "] {
      let text = wallOfProse(sentences: 30) + stray + wallOfProse(sentences: 60)
      XCTAssertGreaterThan(
        workBoundedProseChunks(text).count, 1,
        "\(stray.debugDescription) stopped the paragraph from splitting"
      )
    }
  }

  // MARK: - Through the parser

  /// The split has to survive the parser, not just the helper: an oversized
  /// paragraph becomes several `.paragraph` blocks with the usual sequential
  /// position-stable ids.
  func testParserEmitsSeveralBlocksForOneOversizedParagraph() {
    let text = (1...120)
      .map { "The keeper walked the length of the gallery and counted lamp \($0) again." }
      .joined(separator: " ")
    let blocks = parseMarkdownBlocks(text)
    XCTAssertGreaterThan(blocks.count, 1)
    for (index, block) in blocks.enumerated() {
      XCTAssertEqual(block.id, "markdown-block-\(index)")
      guard case .paragraph = block.kind else {
        return XCTFail("a wall of prose only ever produces paragraphs")
      }
    }
  }

  func testLongInlineNumberedNarrativeDoesNotBecomeOneListRow() {
    let text = wallOfProse(sentences: 120)
    XCTAssertTrue(workLooksLikeInlineNumberedProse(text))

    let blocks = parseMarkdownBlocks(text)
    XCTAssertGreaterThan(blocks.count, 1)
    let paragraphs = blocks.compactMap { block -> String? in
      guard case .paragraph(let text) = block.kind else { return nil }
      return text
    }
    XCTAssertEqual(paragraphs.count, blocks.count, "the narrative should stay prose, not a giant ordered-list item")
    XCTAssertEqual(paragraphs.joined(), text)
    XCTAssertLessThanOrEqual(paragraphs.map(\.count).max() ?? 0, workMarkdownProseRowCharacterLimit)
  }

  func testLongSingleOrderedListItemContainingYearRemainsOrderedList() {
    let text = "1. " + String(repeating: "The keeper recorded another calm observation. ", count: 80)
      + "The log was archived in 2026. The next watch began at dusk."
    let blocks = parseMarkdownBlocks(text)

    XCTAssertEqual(blocks.count, 1)
    guard case .orderedList(start: 1, let items) = blocks[0].kind else {
      return XCTFail("a long real list item must keep its ordered-list semantics")
    }
    XCTAssertEqual(items.count, 1)
    XCTAssertEqual(items[0], String(text.dropFirst(3)))
  }

  /// Splitting must not reach any other block kind. A fenced block is rendered
  /// by its own view, and slicing one would break both the code-block ordinals
  /// that Copy resolves through and the code itself.
  func testOversizedFencedCodeIsLeftAsOneBlock() {
    let code = (1...400).map { "let value\($0) = compute(\($0))" }.joined(separator: "\n")
    let blocks = parseMarkdownBlocks("```swift\n\(code)\n```")
    XCTAssertEqual(blocks.count, 1)
    XCTAssertEqual(blocks.first?.kind, .code(language: "swift", code: code))
  }
}
