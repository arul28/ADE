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
