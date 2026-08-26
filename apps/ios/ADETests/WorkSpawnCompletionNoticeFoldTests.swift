import XCTest
@testable import ADE

/// Parity coverage for the iOS mirror of the desktop adjacency fold in
/// `collapseTranscriptRows`: a parent that spawned a peer gets one
/// `spawn_completed` notice per sibling TURN, and a run of them for the SAME
/// child collapses into one row carrying a trailing `×N`.
///
/// These run end-to-end (`buildWorkEventCards` → `buildWorkTimeline`) rather
/// than against the collapse function alone, because the fold's correctness is
/// half in where it sits in the chain: the tool collapse buffers soft-break rows
/// past a cluster, so folding after it would join runs the parent's own work had
/// separated.
final class WorkSpawnCompletionNoticeFoldTests: XCTestCase {
  private func completionNotice(
    child: String,
    title: String,
    sequence: Int,
    message: String? = nil,
    detail: String? = nil
  ) -> WorkChatEnvelope {
    WorkChatEnvelope(
      sessionId: "chat-parent",
      timestamp: "2026-08-25T00:00:0\(sequence).000Z",
      sequence: sequence,
      event: .systemNotice(
        kind: "info",
        message: message ?? "Chat \"\(title)\" finished its turn",
        detail: detail ?? """
        {"spawnCompletion":{"childSessionId":"\(child)","childTitle":"\(title)",\
        "spawnKind":"peer","status":"completed"}}
        """,
        turnId: "turn-1",
        steerId: nil
      )
    )
  }

  private func userMessage(sequence: Int) -> WorkChatEnvelope {
    WorkChatEnvelope(
      sessionId: "chat-parent",
      timestamp: "2026-08-25T00:00:0\(sequence).000Z",
      sequence: sequence,
      event: .userMessage(
        text: "keep going",
        attachments: [],
        turnId: "turn-1",
        steerId: nil,
        deliveryState: nil,
        processed: nil
      )
    )
  }

  private func timeline(_ transcript: [WorkChatEnvelope]) -> [WorkTimelineEntry] {
    buildWorkTimeline(
      transcript: transcript,
      fallbackEntries: [],
      toolCards: [],
      commandCards: [],
      fileChangeCards: [],
      eventCards: buildWorkEventCards(from: transcript),
      artifacts: [],
      localEchoMessages: []
    )
  }

  private func noticeCards(_ transcript: [WorkChatEnvelope]) -> [WorkEventCardModel] {
    timeline(transcript).compactMap { entry in
      guard case .eventCard(let card) = entry.payload, card.kind == "notice" else { return nil }
      return card
    }
  }

  func testAdjacentCompletionsForSameChildFoldWithCount() throws {
    let transcript = [
      completionNotice(child: "child-a", title: "Alpha", sequence: 1),
      completionNotice(child: "child-a", title: "Alpha", sequence: 2),
      completionNotice(child: "child-a", title: "Alpha", sequence: 3),
    ]

    let cards = noticeCards(transcript)

    XCTAssertEqual(cards.count, 1)
    let card = try XCTUnwrap(cards.first)
    // The host's own sentence, untouched, with the multiplier trailing it.
    XCTAssertEqual(card.body, "Chat \"Alpha\" finished its turn ×3")
    // The row reports the most recent completion.
    XCTAssertEqual(card.timestamp, "2026-08-25T00:00:03.000Z")
    XCTAssertEqual(card.spawnCompletionChildId, "child-a")
  }

  /// A peer completion is a quiet notice, never a subagent card — the decode
  /// paths gate the subagent card on `spawnKind == "subagent"`, and the fold
  /// must not smuggle peers into that lane.
  func testFoldedPeerCompletionNeverBecomesASubagentRow() {
    let entries = timeline([
      completionNotice(child: "child-a", title: "Alpha", sequence: 1),
      completionNotice(child: "child-a", title: "Alpha", sequence: 2),
    ])

    XCTAssertFalse(entries.contains { entry in
      if case .subagent = entry.payload { return true }
      if case .subagentStoppedGroup = entry.payload { return true }
      return false
    })
  }

  func testDifferentChildrenDoNotFold() {
    let cards = noticeCards([
      completionNotice(child: "child-a", title: "Alpha", sequence: 1),
      completionNotice(child: "child-b", title: "Bravo", sequence: 2),
    ])

    XCTAssertEqual(cards.map(\.body), [
      "Chat \"Alpha\" finished its turn",
      "Chat \"Bravo\" finished its turn",
    ])
  }

  /// Anything the parent said or did between two completions separates them.
  func testInterveningEntryBreaksTheRun() {
    let cards = noticeCards([
      completionNotice(child: "child-a", title: "Alpha", sequence: 1),
      completionNotice(child: "child-a", title: "Alpha", sequence: 2),
      userMessage(sequence: 3),
      completionNotice(child: "child-a", title: "Alpha", sequence: 4),
      completionNotice(child: "child-a", title: "Alpha", sequence: 5),
    ])

    XCTAssertEqual(cards.map(\.body), [
      "Chat \"Alpha\" finished its turn ×2",
      "Chat \"Alpha\" finished its turn ×2",
    ])
  }

  /// Persisted transcripts still carry the pre-rename `Peer "X" turn finished`
  /// sentence. iOS never re-derives the line, so those words survive verbatim —
  /// folded or not.
  func testLegacyWordingRendersAndFoldsUnchanged() throws {
    let folded = noticeCards([
      completionNotice(child: "child-a", title: "Alpha", sequence: 1, message: "Peer \"Alpha\" turn finished"),
      completionNotice(child: "child-a", title: "Alpha", sequence: 2, message: "Peer \"Alpha\" turn finished"),
    ])
    XCTAssertEqual(folded.map(\.body), ["Peer \"Alpha\" turn finished ×2"])

    let lone = noticeCards([
      completionNotice(child: "child-a", title: "Alpha", sequence: 1, message: "Peer \"Alpha\" turn finished"),
    ])
    XCTAssertEqual(lone.map(\.body), ["Peer \"Alpha\" turn finished"])
  }

  /// A completion whose detail lost its `spawnCompletion` has no key to fold on,
  /// so it keeps its own row rather than absorbing a different child's.
  func testUnidentifiedCompletionKeepsItsOwnRow() {
    let cards = noticeCards([
      completionNotice(child: "child-a", title: "Alpha", sequence: 1, detail: "{\"spawnCompletion\":{}}"),
      completionNotice(child: "child-a", title: "Alpha", sequence: 2, detail: "{\"spawnCompletion\":{}}"),
    ])

    XCTAssertEqual(cards.count, 2)
    XCTAssertTrue(cards.allSatisfy { $0.spawnCompletionChildId == nil })
  }
}
