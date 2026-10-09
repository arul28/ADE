import XCTest
@testable import ADE

final class WorkDraftsTests: XCTestCase {
  func testOverflowDraftTitleDependsOnComposerContent() {
    XCTAssertEqual(workComposerOverflowDraftTitle(hasContent: true), "Save draft")
    XCTAssertEqual(workComposerOverflowDraftTitle(hasContent: false), "View drafts")
  }

  func testComposerHasDraftableContentForTextOrReadyImages() {
    XCTAssertFalse(workComposerHasDraftableContent(text: "   ", attachments: []))
    XCTAssertTrue(workComposerHasDraftableContent(text: "retry this", attachments: []))
  }

  func testLoadingAttachmentsAreNotReadyToDraft() {
    let loading = WorkChatInputAttachment(
      filename: "shot.png",
      state: .loading
    )
    XCTAssertTrue(workChatInputHasLoadingAttachments([loading]))
    XCTAssertTrue(workComposerHasDraftableContent(text: "retry this", attachments: [loading]))
    XCTAssertTrue(workChatInputReadyAttachments([loading]).isEmpty)
  }

  func testDraftEntryDecodesAttachmentsAvailabilityAndSchedule() throws {
    let json = """
    {
      "id": "draft-1",
      "text": "with a screenshot",
      "attachments": [{ "path": "/tmp/shot.png", "type": "image" }],
      "attachmentCount": 1,
      "attachmentsAvailable": true,
      "provider": "codex",
      "modelId": "gpt-5.6",
      "createdAt": "2026-08-14T00:00:00.000Z",
      "updatedAt": "2026-08-14T01:00:00.000Z",
      "kind": "scheduled",
      "status": "blocked",
      "scheduledAt": "2026-08-14T09:00:00.000Z",
      "deliveryPolicy": "grace",
      "graceSeconds": 900,
      "targetKind": "new",
      "targetLaneId": "lane-9",
      "targetMachineKey": "machine:studio",
      "originSessionId": "chat-3",
      "scheduledBy": "user",
      "lastError": "Waiting for this send's images to reach this machine."
    }
    """.data(using: .utf8)!
    let entry = try JSONDecoder().decode(DraftEntry.self, from: json)
    XCTAssertEqual(entry.resolvedAttachmentCount, 1)
    XCTAssertFalse(entry.imagesUnavailable)
    XCTAssertEqual(workDraftEntryLabel(entry), "with a screenshot")
    XCTAssertEqual(entry.resolvedKind, .scheduled)
    XCTAssertEqual(entry.resolvedStatus, .blocked)
    XCTAssertTrue(entry.isScheduled)
    XCTAssertTrue(entry.needsYou)
    XCTAssertEqual(entry.deliveryPolicy, .grace)
    XCTAssertEqual(entry.graceSeconds, 900)
    XCTAssertEqual(entry.targetKind, .new)
    XCTAssertEqual(entry.targetMachineKey, "machine:studio")
    XCTAssertEqual(entry.originSessionId, "chat-3")
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
