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
    XCTAssertEqual(effectiveLineBudget(workAssistantMessageInitialLineBudget, for: markdown), workAssistantMessageInitialLineBudget)
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
    XCTAssertEqual(effectiveLineBudget(workAssistantMessageInitialLineBudget, for: markdown), workAssistantMessageInitialLineBudget)
  }

  func testAssistantMessageUnfencedWireframeStaysMonospaced() {
    let markdown = (1...40).map { "│ pane \($0)  │" }.joined(separator: "\n")
    XCTAssertTrue(workAssistantMessageUsesMonospacedPreview(markdown))
    XCTAssertEqual(effectiveLineBudget(workAssistantMessageInitialLineBudget, for: markdown), workAssistantMessageWideInitialLineBudget)
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

    let preview = workAssistantMessagePreview(
      markdown,
      lineBudget: workAssistantMessageTailFullLineBudget,
      characterBudget: workAssistantMessageCharacterBudget(
        forLineBudget: workAssistantMessageTailFullLineBudget,
        tailCanRenderFull: true
      ),
      anchor: .tail
    )
    XCTAssertFalse(preview.isTruncated)
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

  func testAssistantTailStartingInsideFencedTreeStillRendersAsMarkdown() {
    let markdown = (
      ["The complete tree is below:", "", "```", "root"]
        + (1...170).map { "├── generated-item-\($0)" }
        + ["```", "", "Only the generated subtree changed."]
    ).joined(separator: "\n")
    let preview = workAssistantMessagePreview(
      markdown,
      lineBudget: workAssistantMessageTailFullLineBudget,
      characterBudget: workAssistantMessageTailFullCharacterBudget,
      anchor: .tail
    )

    XCTAssertTrue(preview.isTruncated)
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(preview.text))
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
    XCTAssertTrue(preview.text.hasPrefix("```\n"))

    var message = makeAssistantMessage(id: "assistant-fenced-tail", markdown: markdown)
    message.assistantPreview = preview
    let rendered = workTimelineRenderEntries(
      from: [makeMessageEntry(message)],
      streamingAssistantMessageId: nil,
      splitAssistantMessageId: message.id,
      assistantLineBudgets: [message.id: workAssistantMessageTailFullLineBudget]
    )
    let blockKinds = rendered.compactMap { entry -> WorkMarkdownBlockKind? in
      guard case .assistantMarkdownBlock(let model) = entry.payload else { return nil }
      return model.block.kind
    }
    XCTAssertTrue(blockKinds.contains { if case .code(_, let code) = $0 { return code.contains("generated-item-") }; return false })
    XCTAssertTrue(blockKinds.contains { if case .paragraph(let text) = $0 { return text.contains("Only the generated subtree changed.") }; return false })
    XCTAssertFalse(rendered.contains { if case .assistantMonospaced = $0.payload { return true }; return false })
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

    let preview = workAssistantMessagePreview(
      markdown,
      lineBudget: workAssistantMessageTailFullLineBudget,
      characterBudget: workAssistantMessageTailFullCharacterBudget,
      anchor: .tail
    )
    XCTAssertFalse(preview.isTruncated)
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

  // MARK: - "Show more" reaches the end of any message

  func testShowMoreStepsRevealEveryLineOfALongNormalWidthAnswer() {
    let markdown = (1...1000).map { "Line \($0): the agent explained another step of the run." }
      .joined(separator: "\n")
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))

    let walk = walkShowMore(markdown, anchor: .head)
    XCTAssertFalse(walk.preview.isTruncated, "Show more stalled after \(walk.taps) taps")
    XCTAssertEqual(walk.preview.text, markdown)
    XCTAssertEqual(walk.preview.visibleLineCount, 1000)
    XCTAssertGreaterThan(walk.taps, 0)
  }

  func testShowMoreStepsRevealEveryLineOfALongWideAnswer() {
    let markdown = (1...400).map { "│ pane \($0)  │  column b  │" }.joined(separator: "\n")
    XCTAssertTrue(workAssistantMessageUsesMonospacedPreview(markdown))
    // The wide layout starts on its own slower ladder…
    XCTAssertEqual(
      effectiveLineBudget(workAssistantMessageInitialLineBudget, for: markdown),
      workAssistantMessageWideInitialLineBudget
    )

    let walk = walkShowMore(markdown, anchor: .head)
    // …and that ladder still has no top: repeated taps land on the whole thing.
    XCTAssertFalse(walk.preview.isTruncated, "Wide Show more stalled after \(walk.taps) taps")
    XCTAssertEqual(walk.preview.text, markdown)
    XCTAssertEqual(walk.preview.visibleLineCount, 400)
  }

  func testShowMoreStepsRevealEveryLineOfATailAnchoredAnswer() {
    let markdown = (1...900).map { "Line \($0): tail anchored transcript output." }
      .joined(separator: "\n")

    let walk = walkShowMore(markdown, anchor: .tail)
    XCTAssertFalse(walk.preview.isTruncated, "Tail Show more stalled after \(walk.taps) taps")
    XCTAssertEqual(walk.preview.text, markdown)
    XCTAssertEqual(walk.preview.visibleLineCount, 900)
  }

  /// The character budget is the other budget that can bind, and a message of
  /// very long lines is where it binds hardest. It has to keep stepping too,
  /// or the reader is stranded at a character limit instead of a line limit.
  func testShowMoreStepsRevealEveryLineWhenTheCharacterBudgetBinds() {
    let longLine = String(repeating: "prose that runs on and on ", count: 12)
    let markdown = (1...200).map { "Line \($0): \(longLine)" }.joined(separator: "\n")
    XCTAssertFalse(workAssistantMessageUsesMonospacedPreview(markdown))
    XCTAssertGreaterThan(markdown.count, 50_000)

    let firstPage = workAssistantMessagePreview(
      markdown,
      lineBudget: workAssistantMessageInitialLineBudget,
      characterBudget: workAssistantMessageCharacterBudget(forLineBudget: workAssistantMessageInitialLineBudget),
      anchor: .head
    )
    // The first page is character-bound, not line-bound: fewer than 48 lines fit.
    XCTAssertLessThan(firstPage.visibleLineCount, workAssistantMessageInitialLineBudget)

    let walk = walkShowMore(markdown, anchor: .head)
    XCTAssertFalse(walk.preview.isTruncated, "Show more stalled after \(walk.taps) taps")
    XCTAssertEqual(walk.preview.text, markdown)
    XCTAssertEqual(walk.preview.visibleLineCount, 200)
  }

  func testShowMoreSummaryStaysAccurateAtEveryStep() {
    let markdown = (1...600).map { "Line \($0): step accurate summary." }.joined(separator: "\n")

    var previousVisible = 0
    let walk = walkShowMore(markdown, anchor: .tail) { preview in
      XCTAssertEqual(preview.totalLineCount, 600)
      XCTAssertLessThanOrEqual(preview.visibleLineCount, preview.totalLineCount)
      XCTAssertGreaterThanOrEqual(preview.visibleLineCount, previousVisible)
      previousVisible = preview.visibleLineCount
      if preview.isTruncated, preview.visibleLineCount < preview.totalLineCount {
        XCTAssertEqual(
          workAssistantMessagePreviewSummaryText(preview),
          "Latest \(preview.visibleLineCount) of 600 lines"
        )
      }
    }
    XCTAssertFalse(walk.preview.isTruncated)
    XCTAssertEqual(workAssistantMessagePreviewSummaryText(walk.preview), "600 lines")
  }

  /// Production stepping, not a reimplementation of it: this drives the same
  /// `nextLineBudget` the controls row hands back to `assistantLineBudgets`.
  func testAssistantControlsOfferShowMoreUntilTheWholeMessageIsRendered() {
    let markdown = (1...1200).map { "Line \($0): rendered through the timeline." }
      .joined(separator: "\n")
    var message = makeAssistantMessage(id: "assistant-huge", markdown: markdown)
    var budgets: [String: Int] = [:]
    var taps = 0
    var lastPreview: WorkAssistantMessagePreview?

    while taps < 200 {
      let lineBudget = budgets[message.id] ?? workAssistantMessageInitialLineBudget
      let preview = workAssistantMessagePreview(
        markdown,
        lineBudget: lineBudget,
        characterBudget: workAssistantMessageCharacterBudget(forLineBudget: lineBudget),
        anchor: .tail
      )
      message.assistantPreview = preview
      lastPreview = preview

      let rendered = workTimelineRenderEntries(
        from: [makeMessageEntry(message)],
        streamingAssistantMessageId: nil,
        splitAssistantMessageId: message.id,
        assistantLineBudgets: budgets
      )
      let controls = rendered.compactMap { entry -> WorkAssistantMessageControlsModel? in
        guard case .assistantControls(let model) = entry.payload else { return nil }
        return model
      }.first

      guard let controls else { break }
      XCTAssertTrue(preview.isTruncated)
      XCTAssertTrue(controls.canShowMore, "Show more disappeared with \(preview.visibleLineCount) of 1200 lines visible")
      XCTAssertEqual(controls.visibleLineCount, preview.visibleLineCount)
      XCTAssertEqual(controls.totalLineCount, 1200)
      XCTAssertGreaterThan(controls.nextLineBudget, lineBudget)
      budgets[message.id] = controls.nextLineBudget
      taps += 1
    }

    XCTAssertLessThan(taps, 200, "Show more never finished revealing the message")
    XCTAssertEqual(lastPreview?.isTruncated, false)
    XCTAssertEqual(lastPreview?.visibleLineCount, 1200)
  }

  func testWideLineLadderKeepsClimbingPastTheOldNinetySixLineCeiling() {
    // 24 lines to start, then 24 more for every 48-line step of the shared
    // requested budget — and no top: the ladder used to stop dead at 96.
    XCTAssertEqual(
      workAssistantMessageEffectiveLineBudget(requestedLineBudget: 48, usesMonospacedPreview: true),
      workAssistantMessageWideInitialLineBudget
    )
    XCTAssertEqual(
      workAssistantMessageEffectiveLineBudget(requestedLineBudget: 96, usesMonospacedPreview: true),
      48
    )
    XCTAssertEqual(
      workAssistantMessageEffectiveLineBudget(requestedLineBudget: 192, usesMonospacedPreview: true),
      96
    )
    XCTAssertEqual(
      workAssistantMessageEffectiveLineBudget(requestedLineBudget: 960, usesMonospacedPreview: true),
      480
    )
    XCTAssertEqual(
      workAssistantMessageEffectiveLineBudget(requestedLineBudget: 4_848, usesMonospacedPreview: true),
      2_424
    )
    // Normal-width answers are governed by the requested budget unchanged.
    XCTAssertEqual(
      workAssistantMessageEffectiveLineBudget(requestedLineBudget: 4_848, usesMonospacedPreview: false),
      4_848
    )
  }

  func testExpandedCharacterBudgetKeepsUpWithTheAdvertisedLineBudget() {
    // The untouched first page keeps its tight budget so hydration stays cheap.
    XCTAssertEqual(
      workAssistantMessageCharacterBudget(forLineBudget: workAssistantMessageInitialLineBudget),
      workAssistantMessageInitialCharacterBudget
    )
    // Every expansion past it can carry the line count it promises.
    for steps in 1...12 {
      let lineBudget = workAssistantMessageInitialLineBudget + (steps * workAssistantMessageLineBudgetStep)
      XCTAssertGreaterThanOrEqual(
        workAssistantMessageCharacterBudget(forLineBudget: lineBudget),
        lineBudget * workAssistantMessageExpandedCharactersPerLine
      )
    }
  }

  // MARK: - Helpers

  private struct ShowMoreWalk {
    let taps: Int
    let preview: WorkAssistantMessagePreview
  }

  /// Mirrors what a tap does in production: add one line step to the requested
  /// budget and rebuild the preview from the same budget pair the views use.
  private func walkShowMore(
    _ markdown: String,
    anchor: WorkAssistantMessagePreviewAnchor,
    maxTaps: Int = 200,
    onStep: ((WorkAssistantMessagePreview) -> Void)? = nil
  ) -> ShowMoreWalk {
    func preview(at lineBudget: Int) -> WorkAssistantMessagePreview {
      workAssistantMessagePreview(
        markdown,
        lineBudget: lineBudget,
        characterBudget: workAssistantMessageCharacterBudget(forLineBudget: lineBudget),
        anchor: anchor
      )
    }

    var lineBudget = workAssistantMessageInitialLineBudget
    var current = preview(at: lineBudget)
    onStep?(current)
    var taps = 0
    while current.isTruncated, taps < maxTaps {
      lineBudget += workAssistantMessageLineBudgetStep
      current = preview(at: lineBudget)
      taps += 1
      onStep?(current)
    }
    return ShowMoreWalk(taps: taps, preview: current)
  }

  private func effectiveLineBudget(_ requested: Int, for markdown: String) -> Int {
    workAssistantMessageEffectiveLineBudget(
      requestedLineBudget: requested,
      usesMonospacedPreview: workAssistantMessageUsesMonospacedPreview(markdown)
    )
  }

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
    XCTAssertFalse(rendered.contains { if case .assistantControls = $0.payload { return true }; return false }, file: file, line: line)
  }
}
