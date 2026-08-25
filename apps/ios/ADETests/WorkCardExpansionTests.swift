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

  // MARK: - Finished turns keep their work

  /// The shape that reported this: a Claude turn whose whole body was one
  /// `Read` and one approved shell command. Both fold into one cluster, and the
  /// transcript has to still draw that cluster once the turn ends — a finished
  /// turn collapses to one line, it does not disappear.
  func testFinishedTurnKeepsItsToolClusterInTheTranscript() {
    let grouped = collapseConsecutiveWorkToolEntries([
      userMessage("msg-1"),
      toolCard(id: "read-1", toolName: "Read", argsText: #"{"file_path":"README.md"}"#),
      commandCard(id: "bash-1", command: "npm test"),
      assistantMessage("msg-2"),
      turnEnd("turn-1", id: "end-1"),
    ])

    let presented = workPresentedTimelineEntries(grouped)
    let members = presented.flatMap { entry -> [WorkToolGroupMember] in
      guard case .toolGroup(let group) = entry.payload else { return [] }
      return group.members
    }

    XCTAssertTrue(
      members.contains { $0.id == "tool:read-1" },
      "the finished turn's Read has to keep a row in the transcript"
    )
    XCTAssertTrue(
      members.contains { $0.id == "command:bash-1" },
      "the finished turn's shell command has to keep a row in the transcript"
    )
  }

  /// A cluster and a file-change group are the same kind of thing to a reader,
  /// so the transcript cannot draw one and swallow the other.
  func testPresentationDrawsToolClustersAndFileChangesAlike() {
    let grouped = collapseConsecutiveWorkToolEntries([
      toolCard(id: "read-1", toolName: "Read", argsText: #"{"file_path":"README.md"}"#),
      assistantMessage("msg-1"),
      toolCard(id: "edit-1", toolName: "Edit", argsText: #"{"file_path":"main.swift"}"#),
    ])

    let presented = workPresentedTimelineEntries(grouped)
    let hasToolCluster = presented.contains {
      if case .toolGroup = $0.payload { return true }
      return false
    }
    let hasChangedFiles = presented.contains {
      if case .changedFiles = $0.payload { return true }
      return false
    }

    XCTAssertTrue(hasChangedFiles, "file-change clusters already render")
    XCTAssertTrue(hasToolCluster, "so read-only clusters have to render too")
  }

  /// Nothing streams in a reopened chat, so the cluster lands on its own default
  /// — the one-line row, not the member list.
  func testFinishedToolClusterDefaultsToItsCollapsedRow() {
    let state = WorkCardExpansionState()

    XCTAssertFalse(state.isExpanded(id: "tool-group:read-1", defaultsOpen: false))
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

  private func toolCard(id: String, toolName: String, argsText: String?) -> WorkTimelineEntry {
    WorkTimelineEntry(
      id: "tool-\(id)",
      timestamp: "2026-01-01T00:00:00.000Z",
      rank: 0,
      payload: .toolCard(
        WorkToolCardModel(
          id: id,
          toolName: toolName,
          status: .completed,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:01.000Z",
          argsText: argsText,
          resultText: "ok"
        )
      )
    )
  }

  private func commandCard(id: String, command: String) -> WorkTimelineEntry {
    WorkTimelineEntry(
      id: "command-\(id)",
      timestamp: "2026-01-01T00:00:00.000Z",
      rank: 0,
      payload: .commandCard(
        WorkCommandCardModel(
          id: id,
          command: command,
          cwd: "/repo",
          output: "3 passing",
          status: .completed,
          timestamp: "2026-01-01T00:00:00.000Z",
          exitCode: 0,
          durationMs: 1200
        )
      )
    )
  }

  private func userMessage(_ id: String) -> WorkTimelineEntry {
    message(id, role: "user", markdown: "run the tests")
  }

  private func assistantMessage(_ id: String) -> WorkTimelineEntry {
    message(id, role: "assistant", markdown: "Done.")
  }

  private func message(_ id: String, role: String, markdown: String) -> WorkTimelineEntry {
    WorkTimelineEntry(
      id: "message-\(id)",
      timestamp: "2026-01-01T00:00:00.000Z",
      rank: 0,
      payload: .message(
        WorkChatMessage(
          id: id,
          role: role,
          markdown: markdown,
          timestamp: "2026-01-01T00:00:00.000Z",
          turnId: "turn-1",
          itemId: nil
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
