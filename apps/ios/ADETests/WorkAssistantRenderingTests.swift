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
    XCTAssertEqual(workAssistantMessageMaxLineBudget(for: markdown), workAssistantMessageMaxLineBudget)
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
    XCTAssertEqual(workAssistantMessageMaxLineBudget(for: markdown), workAssistantMessageMaxLineBudget)
  }

  func testAssistantMessageUnfencedWireframeStaysMonospaced() {
    let markdown = (1...40).map { "│ pane \($0)  │" }.joined(separator: "\n")
    XCTAssertTrue(workAssistantMessageUsesMonospacedPreview(markdown))
    XCTAssertEqual(workAssistantMessageMaxLineBudget(for: markdown), workAssistantMessageWideMaxLineBudget)
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
