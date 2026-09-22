import XCTest
@testable import ADE

/// A later todo update writes its status onto the plan card for that turn.
/// Desktop does this in `foldTodoUpdateIntoExistingPlan`. Dropping the todo
/// without the write left the plan on its first snapshot.
final class WorkPlanTodoFoldTests: XCTestCase {
  func testLaterTodoUpdateRewritesThePlanAndDoesNotAddASecondCard() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-09-22T00:00:00.000Z",
        sequence: 1,
        event: .plan(
          steps: [
            WorkPlanStep(text: "Inspect", status: "pending"),
            WorkPlanStep(text: "Ship", status: "pending"),
          ],
          explanation: nil,
          turnId: "turn-1"
        )
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-09-22T00:00:01.000Z",
        sequence: 2,
        event: .todoUpdate(
          items: ["Completed: Inspect", "In Progress: Ship"],
          turnId: "turn-1"
        )
      ),
    ]

    let cards = buildWorkEventCards(from: transcript)
    let plan = cards.filter { $0.kind == "plan" }
    XCTAssertEqual(plan.count, 1)
    XCTAssertEqual(plan.first?.planSteps.map(\.status), ["completed", "in_progress"])
    XCTAssertTrue(cards.filter { $0.kind == "todo" }.isEmpty)
  }
}
