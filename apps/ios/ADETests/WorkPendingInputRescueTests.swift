import XCTest
@testable import ADE

/// Parity coverage for the desktop pending-input turn-boundary fix
/// (`resolvePendingInputs` in `pendingInput.ts`, `resolvedInputStates` in
/// `AgentChatMessageList.tsx`).
///
/// Two contracts, both load-bearing and both invisible in a screenshot:
///
///  1. A gate swept at a turn boundary WITHOUT a `pending_input_resolved`
///     receipt is not gone — it is unproven. The transcript alone must not show
///     it, and the session summary's `pendingInputItemId` must be able to bring
///     it back. Without the rescue, a blocking approval whose asker outlived its
///     turn disappears from the strip while the host still counts it: the
///     composer unlocks, the send is refused, and there is no card left to
///     answer.
///  2. A second receipt for one itemId is a late click settled by the host's
///     `settleUnclaimedPendingInput` (which downgrades an accept to
///     `cancelled`), not a re-answer. First one wins, and it paints one ribbon,
///     not two contradicting ones.
final class WorkPendingInputRescueTests: XCTestCase {
  private let permissionDetail = """
  {"request":{"itemId":"perm-1","kind":"permissions","tool":"functions.GitHub","description":"Allow GitHub MCP"}}
  """

  private func approvalRequest(
    itemId: String,
    detail: String? = nil,
    turnId: String,
    sequence: Int
  ) -> WorkChatEnvelope {
    WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-08-25T00:00:0\(sequence).000Z",
      sequence: sequence,
      event: .approvalRequest(
        description: "Allow",
        detail: detail,
        itemId: itemId,
        turnId: turnId
      )
    )
  }

  private func done(status: String, turnId: String, sequence: Int) -> WorkChatEnvelope {
    WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-08-25T00:00:0\(sequence).000Z",
      sequence: sequence,
      event: .done(
        status: status,
        summary: "",
        usage: nil,
        turnId: turnId,
        model: nil,
        modelId: nil,
        terminalReason: nil
      )
    )
  }

  private func resolved(
    itemId: String,
    resolution: String,
    turnId: String,
    sequence: Int
  ) -> WorkChatEnvelope {
    WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-08-25T00:00:0\(sequence).000Z",
      sequence: sequence,
      event: .pendingInputResolved(itemId: itemId, resolution: resolution, turnId: turnId)
    )
  }

  // MARK: - Turn-boundary sweep is evidence, not proof

  func testCompletedTurnSweepsApprovalWithoutReceiptButKeepsItRescuable() {
    let transcript = [
      approvalRequest(itemId: "perm-1", detail: permissionDetail, turnId: "t-1", sequence: 1),
      done(status: "completed", turnId: "t-1", sequence: 2),
    ]

    let queue = deriveWorkPendingInputQueue(from: transcript)
    XCTAssertEqual(queue.sweptItemIds, ["perm-1"])
    XCTAssertTrue(queue.liveItems.isEmpty, "The transcript alone cannot prove the gate is still open.")
    XCTAssertTrue(
      pendingWorkInputItemIds(from: transcript).isEmpty,
      "Transcript-only callers must keep treating a swept id as closed."
    )

    XCTAssertEqual(
      queue.resolved(hostPendingInputItemId: nil).map(\.itemId),
      [],
      "A host that has stopped claiming the gate leaves it swept."
    )
    XCTAssertEqual(
      queue.resolved(hostPendingInputItemId: "  perm-1  ").map(\.itemId),
      ["perm-1"],
      "The host still counting the gate must bring the card back."
    )
    XCTAssertEqual(
      queue.resolved(hostPendingInputItemId: "   ").map(\.itemId),
      [],
      "A blank id is not a claim."
    )
    XCTAssertEqual(
      queue.resolved(hostPendingInputItemId: "some-other-item").map(\.itemId),
      [],
      "A claim on a different item must not rescue this one."
    )
  }

  func testInterruptedTurnSweepsQuestionsAndApprovalsAlike() {
    let questionDetail = """
    {"request":{"itemId":"q-1","kind":"question","questions":[{"questionId":"a","question":"Ship it?","options":[],"allowsFreeform":true}]}}
    """
    let transcript = [
      approvalRequest(itemId: "q-1", detail: questionDetail, turnId: "t-1", sequence: 1),
      approvalRequest(itemId: "perm-1", detail: permissionDetail, turnId: "t-1", sequence: 2),
      done(status: "interrupted", turnId: "t-1", sequence: 3),
    ]

    let queue = deriveWorkPendingInputQueue(from: transcript)
    XCTAssertEqual(queue.sweptItemIds, ["q-1", "perm-1"])
    XCTAssertTrue(queue.liveItems.isEmpty)
    XCTAssertEqual(queue.resolved(hostPendingInputItemId: "q-1").map(\.itemId), ["q-1"])
  }

  func testReceiptDeletesOutrightAndIsNotRescuable() {
    let transcript = [
      approvalRequest(itemId: "perm-1", detail: permissionDetail, turnId: "t-1", sequence: 1),
      resolved(itemId: "perm-1", resolution: "accepted", turnId: "t-1", sequence: 2),
      done(status: "completed", turnId: "t-1", sequence: 3),
    ]

    let queue = deriveWorkPendingInputQueue(from: transcript)
    XCTAssertTrue(queue.items.isEmpty, "An explicit receipt is a hard delete, not a sweep.")
    XCTAssertTrue(queue.sweptItemIds.isEmpty)
    XCTAssertTrue(queue.resolved(hostPendingInputItemId: "perm-1").isEmpty)
  }

  func testReRequestUnderTheSameIdClearsTheSweep() {
    let transcript = [
      approvalRequest(itemId: "perm-1", detail: permissionDetail, turnId: "t-1", sequence: 1),
      done(status: "completed", turnId: "t-1", sequence: 2),
      approvalRequest(itemId: "perm-1", detail: permissionDetail, turnId: "t-2", sequence: 3),
    ]

    let queue = deriveWorkPendingInputQueue(from: transcript)
    XCTAssertTrue(queue.sweptItemIds.isEmpty, "A fresh ask is not a swept one.")
    XCTAssertEqual(queue.liveItems.map(\.itemId), ["perm-1"])
  }

  func testToolResultSweepStaysSweptWithoutAHostClaim() {
    // A provider approval shares its tool call's itemId, so the tool resolving
    // moots it — but leaves no receipt. The host will not be claiming it, which
    // is exactly what keeps this stale card out of the strip.
    let transcript = [
      approvalRequest(itemId: "call_abc", detail: permissionDetail, turnId: "t-1", sequence: 1),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-08-25T00:00:02.000Z",
        sequence: 2,
        event: .toolResult(
          tool: "functions.GitHub",
          resultText: "ok",
          itemId: "call_abc",
          parentItemId: nil,
          turnId: "t-1",
          status: .completed
        )
      ),
    ]

    let queue = deriveWorkPendingInputQueue(from: transcript)
    XCTAssertEqual(queue.sweptItemIds, ["call_abc"])
    XCTAssertTrue(queue.resolved(hostPendingInputItemId: nil).isEmpty)
  }

  func testUnsweptGateNeedsNoHostClaim() {
    let transcript = [
      approvalRequest(itemId: "perm-1", detail: permissionDetail, turnId: "t-1", sequence: 1),
    ]

    let queue = deriveWorkPendingInputQueue(from: transcript)
    XCTAssertTrue(queue.sweptItemIds.isEmpty)
    XCTAssertEqual(queue.resolved(hostPendingInputItemId: nil).map(\.itemId), ["perm-1"])
  }

  // MARK: - A second receipt is a late click, not a re-answer

  func testDuplicateReceiptPaintsOneRibbonWithTheFirstOutcome() {
    // Permission gates do NOT fold their resolution inline, so the standalone
    // "Input resolved" ribbon is the only place the outcome shows. The host's
    // `settleUnclaimedPendingInput` can now write a second, downgraded receipt
    // for a gate that was already answered.
    let transcript = [
      approvalRequest(itemId: "perm-1", detail: permissionDetail, turnId: "t-1", sequence: 1),
      resolved(itemId: "perm-1", resolution: "accepted", turnId: "t-1", sequence: 2),
      resolved(itemId: "perm-1", resolution: "cancelled", turnId: "t-1", sequence: 3),
    ]

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    let ribbons = snapshot.eventCards.filter { $0.kind == "pendingInputResolved" }
    XCTAssertEqual(ribbons.count, 1, "Two receipts for one gate must not read as two answers.")
    XCTAssertEqual(ribbons.first?.metadata, [pendingInputResolutionLabel(for: "accepted")])
  }

  func testDuplicateReceiptKeepsTheFirstOutcomeOnAnInlineFoldedCard() {
    // Generic approvals DO fold inline, and drop the ribbon entirely. The inline
    // outcome must be the first receipt for the same reason.
    let approvalDetail = """
    {"request":{"requestId":"3","itemId":"call_abc","source":"codex","kind":"approval","description":"Approve file changes","questions":[],"allowsFreeform":false,"blocking":true}}
    """
    let transcript = [
      approvalRequest(itemId: "call_abc", detail: approvalDetail, turnId: "t-1", sequence: 1),
      resolved(itemId: "call_abc", resolution: "accepted", turnId: "t-1", sequence: 2),
      resolved(itemId: "call_abc", resolution: "cancelled", turnId: "t-1", sequence: 3),
    ]

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    XCTAssertFalse(
      snapshot.eventCards.contains { $0.kind == "pendingInputResolved" },
      "An inline-folded gate keeps painting zero standalone ribbons."
    )
    let approvalCard = snapshot.eventCards.first { $0.kind == "approval" }
    XCTAssertEqual(approvalCard?.resolution, "accepted")
  }
}
