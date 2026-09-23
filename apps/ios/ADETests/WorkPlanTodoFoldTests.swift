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

  /// Cursor writes the todo first, then the plan for the same list. The plan
  /// card stays; the todo row it fully names is dropped (desktop
  /// `dropTodoRowsCoveredByPlan`).
  func testALaterPlanThatNamesEveryTodoItemDropsTheTodoRow() {
    let cards = buildWorkEventCards(from: [
      todo(["Pending: Inspect", "Pending: Ship"], turnId: "turn-1", sequence: 1),
      plan(["Inspect", "Ship", "Announce"], turnId: "turn-1", sequence: 2),
    ])
    XCTAssertEqual(cards.filter { $0.kind == "plan" }.count, 1)
    XCTAssertTrue(cards.filter { $0.kind == "todo" }.isEmpty)
  }

  func testAPlanThatMissesATodoItemOrIsAnotherTurnKeepsTheTodoRow() {
    let partial = buildWorkEventCards(from: [
      todo(["Pending: Inspect", "Pending: Deploy"], turnId: "turn-1", sequence: 1),
      plan(["Inspect", "Ship"], turnId: "turn-1", sequence: 2),
    ])
    XCTAssertEqual(partial.filter { $0.kind == "todo" }.count, 1)

    let otherTurn = buildWorkEventCards(from: [
      todo(["Pending: Inspect"], turnId: "turn-1", sequence: 1),
      plan(["Inspect"], turnId: "turn-2", sequence: 2),
    ])
    XCTAssertEqual(otherTurn.filter { $0.kind == "todo" }.count, 1)
  }

  func testCoverageNeedsEveryItemAndIsNeverTrueWhenEmpty() {
    let steps = [WorkPlanStep(text: "Read", status: "pending"), WorkPlanStep(text: "Write", status: "pending")]
    XCTAssertTrue(workTodoLinesCoveredByPlanSteps(["In Progress:  Read "], steps))
    XCTAssertFalse(workTodoLinesCoveredByPlanSteps(["Pending: Read", "Pending: Deploy"], steps))
    XCTAssertFalse(workTodoLinesCoveredByPlanSteps([], steps))
    XCTAssertFalse(workTodoLinesCoveredByPlanSteps(["Pending: Read"], []))
  }

  private func todo(_ items: [String], turnId: String, sequence: Int) -> WorkChatEnvelope {
    WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-09-22T00:00:0\(sequence).000Z",
      sequence: sequence,
      event: .todoUpdate(items: items, turnId: turnId)
    )
  }

  private func plan(_ steps: [String], turnId: String, sequence: Int) -> WorkChatEnvelope {
    WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-09-22T00:00:0\(sequence).000Z",
      sequence: sequence,
      event: .plan(steps: steps.map { WorkPlanStep(text: $0, status: "pending") }, explanation: nil, turnId: turnId)
    )
  }
}
