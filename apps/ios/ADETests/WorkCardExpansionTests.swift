import XCTest
@testable import ADE

/// Auto-collapse rules for the Work transcript: which cards belong to the turn
/// in flight, what a turn ending does to the reader's overrides, and what the
/// collapsed one-liners say.
final class WorkCardExpansionTests: XCTestCase {

  // MARK: - Turn attribution

  func testEntriesAfterLastTurnEndBelongToTheLiveTurn() {
    let timeline = [
      entry("a"),
      turnEnd("turn-1", id: "end-1"),
      entry("b"),
      entry("c"),
    ]

    XCTAssertEqual(workEntryIdsAfterLatestTurnEnd(in: timeline), ["b", "c"])
  }

  func testEverythingBelongsToTheLiveTurnBeforeAnyTurnHasEnded() {
    let timeline = [entry("a"), entry("b")]

    XCTAssertEqual(workEntryIdsAfterLatestTurnEnd(in: timeline), ["a", "b"])
  }

  /// The state a reopened chat lands in: the last row is a turn-end marker, so
  /// nothing is attributed to a live turn and every card renders collapsed.
  func testNoLiveEntriesWhenTheTranscriptEndsOnATurnEnd() {
    let timeline = [
      entry("a"),
      turnEnd("turn-1", id: "end-1"),
      entry("b"),
      turnEnd("turn-2", id: "end-2"),
    ]

    XCTAssertTrue(workEntryIdsAfterLatestTurnEnd(in: timeline).isEmpty)
  }

  func testOnlyTheMostRecentTurnCounts() {
    let timeline = [
      turnEnd("turn-1", id: "end-1"),
      entry("stale"),
      turnEnd("turn-2", id: "end-2"),
      entry("fresh"),
    ]

    let live = workEntryIdsAfterLatestTurnEnd(in: timeline)
    XCTAssertTrue(live.contains("fresh"))
    XCTAssertFalse(live.contains("stale"))
  }

  // MARK: - Expansion overrides

  func testCardWithoutAnOverrideFollowsItsDefault() {
    let state = WorkCardExpansionState()

    XCTAssertTrue(state.isExpanded(id: "plan-1", defaultsOpen: true))
    XCTAssertFalse(state.isExpanded(id: "tool-1", defaultsOpen: false))
  }

  func testManualExpandOnAnEndedTurnSticks() {
    var state = WorkCardExpansionState()
    state.toggle(id: "tool-1", defaultsOpen: false)

    XCTAssertTrue(state.isExpanded(id: "tool-1", defaultsOpen: false))
  }

  /// The escape hatch: shutting a card that auto-opens while its turn is live
  /// has to survive every subsequent streaming delta.
  func testManualCollapseDuringALiveTurnSticks() {
    var state = WorkCardExpansionState()
    state.toggle(id: "plan-1", defaultsOpen: true)

    XCTAssertFalse(state.isExpanded(id: "plan-1", defaultsOpen: true))
  }

  func testTogglingBackToTheDefaultDropsTheOverride() {
    var state = WorkCardExpansionState()
    state.toggle(id: "plan-1", defaultsOpen: true)
    state.toggle(id: "plan-1", defaultsOpen: true)

    XCTAssertTrue(state.isExpanded(id: "plan-1", defaultsOpen: true))
    XCTAssertTrue(state.isEmpty, "a card back at its default should carry no override")
  }

  func testTurnEndClearsBothManualExpandsAndManualCollapses() {
    var state = WorkCardExpansionState()
    state.toggle(id: "tool-1", defaultsOpen: false)   // opened by hand
    state.toggle(id: "plan-1", defaultsOpen: true)    // shut by hand while live
    XCTAssertFalse(state.isEmpty)

    state.clearForTurnEnd()

    XCTAssertTrue(state.isEmpty)
    // Everything now renders collapsed, because an ended turn's cards never
    // default open.
    XCTAssertFalse(state.isExpanded(id: "tool-1", defaultsOpen: false))
    XCTAssertFalse(state.isExpanded(id: "plan-1", defaultsOpen: false))
  }

  func testRenderSignatureChangesWhenExpansionChanges() {
    var state = WorkCardExpansionState()
    let empty = workCardExpansionRenderSignature(state)

    state.toggle(id: "tool-1", defaultsOpen: false)
    let expanded = workCardExpansionRenderSignature(state)
    XCTAssertNotEqual(empty, expanded)

    state.clearForTurnEnd()
    XCTAssertEqual(empty, workCardExpansionRenderSignature(state))
  }

  /// An expand and a collapse of the same id must not hash alike — the two sets
  /// are what tell the row which way to draw.
  func testRenderSignatureDistinguishesExpandFromCollapse() {
    var expandedState = WorkCardExpansionState()
    expandedState.toggle(id: "card-1", defaultsOpen: false)

    var collapsedState = WorkCardExpansionState()
    collapsedState.toggle(id: "card-1", defaultsOpen: true)

    XCTAssertNotEqual(
      workCardExpansionRenderSignature(expandedState),
      workCardExpansionRenderSignature(collapsedState)
    )
  }

  // MARK: - Collapsed CI row

  func testCollapsedCiRowSummarizesTitleAndPrNumber() throws {
    let card = try adeCard(
      """
      {
        "cardId": "ci-490",
        "variant": "pr_ci",
        "state": "terminal",
        "title": "CI",
        "subtitle": "PR #490 · build-and-test",
        "progress": {"passed": 18, "failed": 3, "running": 0, "queued": 0},
        "fallbackText": "PR #490 checks failing."
      }
      """
    )

    XCTAssertEqual(workAdeCardCollapsedSummary(card), "CI · PR #490")
    XCTAssertEqual(workAdeCardCollapsedChips(card).map(\.label), ["18✓", "3✕"])
    XCTAssertEqual(workAdeCardCollapsedGlyph(card), "checklist")
  }

  func testCollapsedCiRowOmitsAZeroChip() throws {
    let card = try adeCard(
      """
      {
        "cardId": "ci-491",
        "variant": "pr_ci",
        "state": "terminal",
        "title": "CI",
        "subtitle": "PR #491",
        "progress": {"passed": 21, "failed": 0, "running": 0, "queued": 0},
        "fallbackText": "PR #491 checks passing."
      }
      """
    )

    XCTAssertEqual(workAdeCardCollapsedChips(card).map(\.label), ["21✓"])
  }

  func testCollapsedCiRowHasNoChipsWithoutProgress() throws {
    let card = try adeCard(
      """
      {
        "cardId": "ci-492",
        "variant": "pr_ci",
        "state": "running",
        "title": "CI",
        "subtitle": "PR #492",
        "fallbackText": "PR #492 checks running."
      }
      """
    )

    XCTAssertTrue(workAdeCardCollapsedChips(card).isEmpty)
  }

  func testCollapsedCiAccessibilityLabelSpeaksTheCounts() throws {
    let card = try adeCard(
      """
      {
        "cardId": "ci-490",
        "variant": "pr_ci",
        "state": "terminal",
        "title": "CI",
        "subtitle": "PR #490 · build-and-test",
        "progress": {"passed": 18, "failed": 3, "running": 0, "queued": 0},
        "fallbackText": "PR #490 checks failing."
      }
      """
    )

    XCTAssertEqual(
      workAdeCardCollapsedAccessibilityLabel(card),
      "CI · PR #490, 18 passed, 3 failed, collapsed"
    )
  }

  func testCollapsedAdeCardFallsBackToItsFallbackTextWhenUntitled() throws {
    let card = try adeCard(
      """
      {
        "cardId": "mystery-1",
        "variant": "some_future_variant",
        "state": "terminal",
        "fallbackText": "Something happened upstream."
      }
      """
    )

    XCTAssertEqual(workAdeCardCollapsedSummary(card), "Something happened upstream.")
    XCTAssertEqual(workAdeCardCollapsedGlyph(card), "square.stack")
  }

  /// The slug substitution happens for known variants too, so the row has to
  /// refuse `pr_ci` there as well and lead with the subtitle instead.
  func testCollapsedAdeCardNeverShowsTheRawVariantSlug() throws {
    let card = try adeCard(
      """
      {
        "cardId": "ci-493",
        "variant": "pr_ci",
        "state": "terminal",
        "subtitle": "PR #493 · build-and-test",
        "progress": {"passed": 4, "failed": 0, "running": 0, "queued": 0},
        "fallbackText": "PR #493 checks passing."
      }
      """
    )

    XCTAssertEqual(workAdeCardCollapsedSummary(card), "PR #493")
  }

  // MARK: - Collapsed plan row

  func testCollapsedPlanRowCountsDoneStepsAndLeadsWithTheActiveOne() {
    let card = planCard(steps: [
      ("Read the failing test", "completed"),
      ("Patch the parser", "completed"),
      ("Add a regression test", "completed"),
      ("Update the snapshot", "completed"),
      ("Run the suite", "in_progress"),
      ("Write the changelog", "pending"),
      ("Open the PR", "pending"),
    ])

    XCTAssertEqual(workPlanCardCollapsedProgressLabel(card), "4/7")
    XCTAssertEqual(workPlanCardCollapsedSummary(card), "Plan · Run the suite")
  }

  func testCollapsedPlanRowHasNoProgressChipWithoutSteps() {
    let card = planCard(steps: [])

    XCTAssertNil(workPlanCardCollapsedProgressLabel(card))
    XCTAssertEqual(workPlanCardCollapsedSummary(card), "Plan")
  }

  func testCollapsedPlanRowPrefersAMeaningfulTitle() {
    let card = planCard(
      title: "Fix the flaky sync test",
      steps: [("Reproduce", "pending"), ("Fix", "pending")]
    )

    XCTAssertEqual(workPlanCardCollapsedSummary(card), "Plan · Fix the flaky sync test")
    XCTAssertEqual(workPlanCardCollapsedProgressLabel(card), "0/2")
  }

  func testCollapsedPlanRowFallsBackToTheFirstStepOnceEveryStepIsDone() {
    let card = planCard(steps: [("Ship it", "completed")])

    XCTAssertEqual(workPlanCardCollapsedSummary(card), "Plan · Ship it")
    XCTAssertEqual(workPlanCardCollapsedProgressLabel(card), "1/1")
  }

  /// `done`/`complete`/`success` are all terminal on the wire; the collapsed
  /// count has to agree with the expanded checklist's checkmarks.
  func testCompletedStepDetectionMatchesTheExpandedChecklist() {
    XCTAssertTrue(workPlanStepIsCompleted("completed"))
    XCTAssertTrue(workPlanStepIsCompleted("done"))
    XCTAssertTrue(workPlanStepIsCompleted("complete"))
    XCTAssertTrue(workPlanStepIsCompleted("success"))
    XCTAssertFalse(workPlanStepIsCompleted("in_progress"))
    XCTAssertFalse(workPlanStepIsCompleted("failed"))
    XCTAssertFalse(workPlanStepIsCompleted("pending"))
  }

  func testCollapsedPlanAccessibilityLabelSpeaksTheProgress() {
    let card = planCard(steps: [
      ("Read", "completed"),
      ("Write", "pending"),
    ])

    XCTAssertEqual(
      workPlanCardCollapsedAccessibilityLabel(card),
      "Plan · Write, 1 of 2 steps done, collapsed"
    )
  }

  // MARK: - Composer chip count

  func testChatInfoCountCoversSubagentsAndScheduledWork() {
    let count = workChatInfoItemCount(
      subagents: [subagent(taskId: "task-1"), subagent(taskId: "task-2")],
      scheduledWork: []
    )

    XCTAssertEqual(count, 2, "the one chip has to speak for the whole sheet")
  }

  func testChatInfoChipIsHiddenWhenThereIsNothingToShow() {
    XCTAssertEqual(workChatInfoItemCount(subagents: [], scheduledWork: []), 0)
  }

  // MARK: - Fixtures

  private func entry(_ id: String) -> WorkTimelineEntry {
    WorkTimelineEntry(
      id: id,
      timestamp: "2026-01-01T00:00:00.000Z",
      rank: 0,
      payload: .usageSummary(
        WorkUsageSummary(
          turnCount: 1,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
          costUsd: 0
        )
      )
    )
  }

  private func turnEnd(_ turnId: String, id: String) -> WorkTimelineEntry {
    WorkTimelineEntry(
      id: id,
      timestamp: "2026-01-01T00:00:00.000Z",
      rank: 0,
      payload: .turnEndMarker(
        WorkTurnEndMarker(
          turnId: turnId,
          time: "12:00",
          workedDurationLabel: "1m",
          status: "completed",
          terminalReasonLabel: nil,
          provider: "claude",
          modelLabel: "Opus",
          modelId: nil
        )
      )
    )
  }

  private func adeCard(_ json: String) throws -> WorkAdeCardModel {
    let payload = try JSONDecoder().decode(
      AgentChatAdeCardPayload.self,
      from: Data(json.utf8)
    )
    return makeWorkAdeCardModel(from: payload)
  }

  private func planCard(title: String = "Plan", steps: [(String, String)]) -> WorkEventCardModel {
    WorkEventCardModel(
      id: "plan-1",
      kind: "plan",
      title: title,
      icon: "list.bullet.clipboard",
      tint: .accent,
      timestamp: "2026-01-01T00:00:00.000Z",
      body: nil,
      bullets: [],
      metadata: [],
      planSteps: steps.map { WorkPlanStep(text: $0.0, status: $0.1) }
    )
  }

  private func subagent(taskId: String) -> WorkSubagentSnapshot {
    WorkSubagentSnapshot(
      taskId: taskId,
      agentId: nil,
      agentType: "general-purpose",
      parentToolUseId: nil,
      description: "Investigate",
      background: false,
      label: nil,
      model: nil,
      reasoningEffort: nil,
      status: .running,
      lastToolName: nil,
      latestSummary: nil,
      turnId: "turn-1",
      startedAt: nil,
      updatedAt: nil
    )
  }
}
