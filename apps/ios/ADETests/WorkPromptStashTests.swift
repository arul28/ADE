import XCTest
@testable import ADE

final class WorkPromptStashTests: XCTestCase {
  func testOverflowStashTitleDependsOnComposerContent() {
    XCTAssertEqual(workComposerOverflowStashTitle(hasContent: true), "Stash prompt")
    XCTAssertEqual(workComposerOverflowStashTitle(hasContent: false), "View prompt stash")
  }

  func testComposerHasStashableContentForTextOrReadyImages() {
    XCTAssertFalse(workComposerHasStashableContent(text: "   ", attachments: []))
    XCTAssertTrue(workComposerHasStashableContent(text: "retry this", attachments: []))
  }

  func testLoadingAttachmentsAreNotReadyToStash() {
    let loading = WorkChatInputAttachment(
      filename: "shot.png",
      state: .loading
    )
    XCTAssertTrue(workChatInputHasLoadingAttachments([loading]))
    XCTAssertTrue(workComposerHasStashableContent(text: "retry this", attachments: [loading]))
    XCTAssertTrue(workChatInputReadyAttachments([loading]).isEmpty)
  }

  func testPromptStashEntryDecodesAttachmentsAndAvailability() throws {
    let json = """
    {
      "id": "stash-1",
      "text": "with a screenshot",
      "attachments": [{ "path": "/tmp/shot.png", "type": "image" }],
      "attachmentCount": 1,
      "attachmentsAvailable": true,
      "provider": "codex",
      "modelId": "gpt-5.6",
      "createdAt": "2026-08-14T00:00:00.000Z"
    }
    """.data(using: .utf8)!
    let entry = try JSONDecoder().decode(PromptStashEntry.self, from: json)
    XCTAssertEqual(entry.resolvedAttachmentCount, 1)
    XCTAssertFalse(entry.imagesUnavailable)
    XCTAssertEqual(workPromptStashEntryLabel(entry), "with a screenshot")
  }

  func testLatestTurnEndUsesTheNewestMarker() {
    let older = WorkTimelineEntry(
      id: "old",
      timestamp: "2026-08-14T00:00:00.000Z",
      rank: 1,
      payload: .turnEndMarker(WorkTurnEndMarker(
        turnId: "turn-1",
        time: "2026-08-14T00:00:00.000Z",
        workedDurationLabel: "2s",
        status: "completed",
        terminalReasonLabel: nil,
        provider: "codex",
        modelLabel: "GPT",
        modelId: nil
      ))
    )
    let newer = WorkTimelineEntry(
      id: "new",
      timestamp: "2026-08-14T00:01:00.000Z",
      rank: 2,
      payload: .turnEndMarker(WorkTurnEndMarker(
        turnId: "turn-2",
        time: "2026-08-14T00:01:00.000Z",
        workedDurationLabel: "4s",
        status: "completed",
        terminalReasonLabel: nil,
        provider: "codex",
        modelLabel: "GPT",
        modelId: nil
      ))
    )
    XCTAssertEqual(workLatestTurnEndTurnId(in: [older, newer]), "turn-2")
    XCTAssertNil(workLatestTurnEndTurnId(in: []))
  }
}
