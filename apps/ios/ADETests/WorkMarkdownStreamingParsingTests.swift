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

  /// Replays a long code block as a token stream and reports the cost of the
  /// incremental path against the previous whole-text algorithm, which is
  /// reproduced here (full tokenize + `index(offsetBy:)` walked from the start
  /// for every token). Not a pass/fail threshold — it prints the numbers the
  /// change is justified by, and fails only if the incremental path is slower.
  func testStreamingHighlightIsCheaperThanWholeTextHighlight() {
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
    let legacyStart = Date()
    for snapshot in snapshots {
      _ = Self.legacyHighlight(snapshot, as: .swift)
    }
    let legacySeconds = Date().timeIntervalSince(legacyStart)

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
    XCTAssertLessThan(incrementalSeconds, legacySeconds)
  }

  /// The pre-change algorithm, kept only as the benchmark's baseline: tokenize
  /// the whole text, then walk from `startIndex` for every token. The per-token
  /// tints are `fileprivate` to the highlighter, so this applies stand-ins — the
  /// cost being measured is the index walk and the run splitting, which are
  /// identical either way.
  private static func legacyHighlight(_ text: String, as language: FilesLanguage) -> AttributedString {
    var attributed = AttributedString(text)
    attributed.font = .system(.body, design: .monospaced)
    for token in SyntaxHighlighter.tokenize(text, as: language) {
      guard let stringRange = Range(token.range, in: text) else { continue }
      let startOffset = text.distance(from: text.startIndex, to: stringRange.lowerBound)
      let endOffset = text.distance(from: text.startIndex, to: stringRange.upperBound)
      let lowerBound = attributed.characters.index(attributed.startIndex, offsetBy: startOffset)
      let upperBound = attributed.characters.index(attributed.startIndex, offsetBy: endOffset)
      attributed[lowerBound..<upperBound].foregroundColor = Color.orange
      attributed[lowerBound..<upperBound].font = Font.system(.body, design: .monospaced).weight(.semibold)
    }
    return attributed
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

  func testMemoryWarningPurgeDropsRenders() {
    let text = "Something worth caching."
    _ = markdownAttributedString(text)
    XCTAssertTrue(workMarkdownSharedCacheHolds(text))
    workPurgeMarkdownRenderCaches()
    XCTAssertFalse(workMarkdownSharedCacheHolds(text))
  }
}
