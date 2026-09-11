import XCTest
@testable import ADE

final class WorkAssistantRenderingTests: XCTestCase {
  func testAssistantMessageMarkdownWithPaddedTableIsNotMonospaced() {
    let markdown = """
    Here's the summary of the run:

    | File            | Status   |
    |-----------------|----------|
    | AppDelegate     | modified |
    | SceneDelegate   | deleted  |

    All tests passed. Let me know if you want the diff.
    """
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessageFencedCodeWithAlignedColumnsIsNotMonospaced() {
    let markdown = """
    The tests all pass now:

    ```
    Suite ADETests started
    testPreview        passed   0.003s
    testTimeline       passed   0.108s
    ```

    I also cleaned up the helper while I was in there.
    """
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessageFencedWireframeGlyphsAreNotMonospaced() {
    let markdown = """
    Proposed layout:

    ```
    ┌─────────┬─────────┐
    │ sidebar │ content │
    └─────────┴─────────┘
    ```

    The sidebar keeps its fixed width.
    """
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessageFencedUnicodeTreeOutputIsNotMonospaced() {
    let markdown = """
    Here's the new layout of the module:

    ```
    apps/ios/ADE/Views/Work
    ├── WorkChatSessionView.swift
    ├── WorkMarkdownParsing.swift
    │   └── WorkMarkdownViews.swift
    └── WorkChatHeaderAndMessageViews.swift
    ```

    The parser helpers stay in one file.
    """
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessageUnfencedWireframeStaysMonospaced() {
    let markdown = (1...40).map { "│ pane \($0)  │" }.joined(separator: "\n")
    XCTAssertTrue(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessagePlainAsciiLayoutDominatedByAlignedColumnsIsMonospaced() {
    let markdown = (1...30).map { "[Button \($0)]      [Input field \($0)]" }.joined(separator: "\n")
    XCTAssertTrue(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testAssistantMessageProseWithFewAlignedLinesIsNotMonospaced() {
    let prose = (1...20).map { "This is regular prose line number \($0) in the final answer." }
    let aligned = ["column a      column b", "value 1       value 2"]
    let markdown = (prose + aligned).joined(separator: "\n")
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
  }

  func testLatestAssistantAnswerWithPaddedTableRendersFullMarkdownWithoutShowMore() {
    let tableLines = (1...20).map { "| file-\($0).swift    | modified |" }
    let markdown = (
      ["Here's where things landed:", "", "| File | Status |", "|------|--------|"]
        + tableLines
        + ["", "Everything is committed on the branch."]
    ).joined(separator: "\n")
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))

    let preview = workAssistantMessagePreview(markdown)
    XCTAssertEqual(preview.text, markdown)

    var message = makeAssistantMessage(id: "assistant-table-answer", markdown: markdown)
    message.assistantPreview = preview
    let rendered = workTimelineRenderEntries(
      from: [makeMessageEntry(message)],
      streamingAssistantMessageId: nil,
      splitAssistantMessageId: message.id
    )
    assertMarkdownOnly(rendered)
  }


  func testFiftyFourLineProseAndFencedTreeRendersFullyWithoutShowMore() {
    let markdownLines = (
      ["Here is the result:", "", "```", "root"]
        + (1...42).map { "├── item-\($0)" }
        + ["└── final-item", "```", "", "The tree is complete.", "All expected files are present.", "No files were omitted.", "The checks passed.", "That is the full result."]
    )
    XCTAssertEqual(markdownLines.count, 54)
    let markdown = markdownLines.joined(separator: "\n")
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))

    let preview = workAssistantMessagePreview(markdown)
    XCTAssertEqual(preview.text, markdown)

    var message = makeAssistantMessage(id: "assistant-fifty-four-lines", markdown: markdown)
    message.assistantPreview = preview
    let rendered = workTimelineRenderEntries(
      from: [makeMessageEntry(message)],
      streamingAssistantMessageId: nil,
      splitAssistantMessageId: message.id
    )
    assertMarkdownOnly(rendered)
  }

  // MARK: - Nothing is ever truncated

  /// The owner's rule, at the seam every render path goes through: the preview
  /// hands back the WHOLE message and reports its real counts, so no caller has
  /// a "visible vs total" gap to draw a "Show more" row from.
  func testAssistantPreviewRendersTheWholeMessage() {
    let markdown = (1...1_200).map { "Line \($0): the agent explained another step." }
      .joined(separator: "\n")

    let preview = workAssistantMessagePreview(markdown)
    XCTAssertEqual(preview.text, markdown)
    XCTAssertEqual(preview.totalLineCount, 1_200)
    XCTAssertEqual(preview.totalCharacterCount, markdown.count)
  }

  /// A very wide monospaced answer used to walk the slower 24-line ladder.
  /// It renders whole too.
  func testWideMonospacedAnswerRendersWhole() {
    let markdown = (1...400).map { _ in String(repeating: "█", count: 200) }
      .joined(separator: "\n")
    let preview = workAssistantMessagePreview(markdown)
    XCTAssertEqual(preview.text, markdown)
  }


  // MARK: - Position-stable block ids

  func testMarkdownBlockIdsAreIndexBasedAndSurviveContentEdits() {
    let before = parseMarkdownBlocks("First paragraph.\n\n## Heading\n\nSecond paragraph.")
    let after = parseMarkdownBlocks("First paragraph, revised.\n\n## Heading\n\nSecond paragraph.")

    XCTAssertEqual(before.map(\.id), after.map(\.id))
    XCTAssertEqual(before.map(\.id), (0..<before.count).map { "markdown-block-\($0)" })
    // Identity is stable, but the change is still visible to change detection.
    XCTAssertNotEqual(before[0].digest, after[0].digest)
    XCTAssertEqual(before[1].digest, after[1].digest)
    XCTAssertNotEqual(before[0], after[0])
  }

  func testStreamingBlockIdsMatchTheWholeTextParse() {
    let markdown = "Intro paragraph.\n\n```swift\nlet x = 1\n```\n\nClosing paragraph."
    let streamed = parseMarkdownBlocksForStreaming(markdown, cacheKey: "streaming-id-parity")
    let whole = parseMarkdownBlocks(markdown)
    XCTAssertEqual(streamed.map(\.id), whole.map(\.id))
    XCTAssertEqual(streamed.map(\.digest), whole.map(\.digest))
  }

  /// A streaming message grows one delta at a time. Every already-rendered row
  /// has to keep its identity across those deltas, or the LazyVStack rebuilds
  /// the whole subtree on every frame instead of updating the tail.
  func testStreamingDeltasDoNotChurnEarlierBlockIds() {
    let head = "Intro paragraph.\n\n## Findings\n\n"
    let first = parseMarkdownBlocksForStreaming(head + "Partial", cacheKey: "streaming-churn")
    let second = parseMarkdownBlocksForStreaming(head + "Partial answer, now longer.", cacheKey: "streaming-churn")
    XCTAssertGreaterThanOrEqual(first.count, 2)
    XCTAssertEqual(Array(first.prefix(2)).map(\.id), Array(second.prefix(2)).map(\.id))
    XCTAssertEqual(Array(first.prefix(2)), Array(second.prefix(2)))
  }

  /// The result box shows a slice; the clipboard never does.
  func testToolResultBoxSeparatesWhatIsShownFromWhatIsCopied() {
    let resultText = String(repeating: "x", count: workToolResultTruncateLimit + 400)
    let collapsed = workToolResultBlockText(resultText, expanded: false)
    XCTAssertTrue(collapsed.didTruncate)
    XCTAssertLessThan(collapsed.displayed.count, resultText.count)
    XCTAssertEqual(collapsed.copy, resultText)

    let expanded = workToolResultBlockText(resultText, expanded: true)
    XCTAssertFalse(expanded.didTruncate)
    XCTAssertEqual(expanded.displayed, resultText)
    XCTAssertEqual(expanded.copy, resultText)
  }

  // MARK: - Hybrid expand ladder

  func testHybridLadderStepsOnceInPlaceThenOffersTheViewer() {
    XCTAssertEqual(
      workTruncatedOutputAffordance(isTruncated: true, hasExpandedInPlace: false, isClipped: false),
      .showMore
    )
    XCTAssertEqual(
      workTruncatedOutputAffordance(isTruncated: true, hasExpandedInPlace: true, isClipped: false),
      .openFullOutput
    )
  }

  /// Nothing truncated and nothing clipped means nothing to offer — the ladder
  /// must not leave a permanent control under every box.
  func testHybridLadderOffersNothingWhenTheWholeBoxIsVisible() {
    XCTAssertEqual(
      workTruncatedOutputAffordance(isTruncated: false, hasExpandedInPlace: false, isClipped: false),
      .none
    )
    XCTAssertEqual(
      workTruncatedOutputAffordance(isTruncated: false, hasExpandedInPlace: true, isClipped: false),
      .none
    )
  }

  /// Expanding a box that clips at a fixed height adds text nobody can see, so
  /// a fully-expanded-but-clipped box goes straight to the viewer.
  func testHybridLadderOffersTheViewerForAClippedBox() {
    XCTAssertEqual(
      workTruncatedOutputAffordance(isTruncated: false, hasExpandedInPlace: true, isClipped: true),
      .openFullOutput
    )
  }





  func testOutputBoxOverflowsCountsWrappedLinesForAWrappingBox() {
    let short = "one\ntwo\nthree"
    XCTAssertFalse(workOutputBoxOverflows(short, lineCapacity: 11, columnCapacity: 46))

    let tall = (1...40).map { "line \($0)" }.joined(separator: "\n")
    XCTAssertTrue(workOutputBoxOverflows(tall, lineCapacity: 11, columnCapacity: 46))

    // One long line wraps into many in a wrapping box…
    let oneLongLine = String(repeating: "y", count: 46 * 12)
    XCTAssertTrue(workOutputBoxOverflows(oneLongLine, lineCapacity: 11, columnCapacity: 46))
    // …and stays one line in a box that scrolls horizontally instead.
    XCTAssertFalse(workOutputBoxOverflows(oneLongLine, lineCapacity: 11, columnCapacity: nil))
  }

  func testOutputBoxOverflowsCountsOnlyHardBreaksForADiff() {
    let diff = (1...30).map { "+ added line \($0)" }.joined(separator: "\n")
    XCTAssertTrue(workOutputBoxOverflows(diff, lineCapacity: workDiffOutputBoxLineCapacity, columnCapacity: nil))
    XCTAssertFalse(workOutputBoxOverflows(diff, lineCapacity: 40, columnCapacity: nil))
    XCTAssertFalse(workOutputBoxOverflows("", lineCapacity: 11, columnCapacity: nil))
  }

  // MARK: - Viewer search

  func testViewerSearchCountsEveryOccurrenceNotEveryLine() {
    let lines = ["alpha beta alpha", "gamma", "ALPHA"]
    XCTAssertEqual(workOutputViewerMatchLines(lines, query: "alpha"), [0, 0, 2])
    XCTAssertEqual(workOutputViewerMatchLines(lines, query: "delta"), [])
    XCTAssertEqual(workOutputViewerMatchLines(lines, query: "   "), [])
  }

  func testViewerSearchStepsWrapAtBothEnds() {
    XCTAssertEqual(workOutputViewerSteppedMatchIndex(current: 2, delta: 1, count: 3), 0)
    XCTAssertEqual(workOutputViewerSteppedMatchIndex(current: 0, delta: -1, count: 3), 2)
    XCTAssertEqual(workOutputViewerSteppedMatchIndex(current: 0, delta: 1, count: 0), 0)
  }

  // MARK: - Helpers

  private func makeAssistantMessage(id: String, markdown: String) -> WorkChatMessage {
    WorkChatMessage(
      id: id,
      role: "assistant",
      markdown: markdown,
      timestamp: "2026-07-22T00:00:01.000Z",
      turnId: "turn-1",
      itemId: "item-1"
    )
  }

  private func makeMessageEntry(_ message: WorkChatMessage) -> WorkTimelineEntry {
    WorkTimelineEntry(id: "message-\(message.id)", timestamp: message.timestamp, rank: 0, payload: .message(message))
  }

  private func assertMarkdownOnly(_ rendered: [WorkTimelineRenderEntry], file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertTrue(rendered.contains { if case .assistantMarkdownBlock = $0.payload { return true }; return false }, file: file, line: line)
    XCTAssertFalse(rendered.contains { if case .assistantMonospaced = $0.payload { return true }; return false }, file: file, line: line)
  }
}
