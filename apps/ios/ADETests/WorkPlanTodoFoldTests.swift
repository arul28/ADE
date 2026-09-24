import XCTest
@testable import ADE

final class WorkPlanTodoFoldTests: XCTestCase {
  func testPlanAndTodoUpdatesShareOneStableCardAndKeepActiveForm() {
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
        event: .taskListUpdate(items: [
          AgentChatTodoItem(id: "inspect", description: "Inspect", status: .completed),
          AgentChatTodoItem(id: "ship", description: "Ship", status: .inProgress, activeForm: "Shipping", cancelled: nil),
        ], turnId: "turn-1")
      ),
    ]

    let taskCards = buildWorkEventCards(from: transcript).filter { $0.kind == "taskList" }
    XCTAssertEqual(taskCards.count, 1)
    XCTAssertEqual(taskCards.first?.id, "task-list:chat-1")
    XCTAssertEqual(taskCards.first?.taskList?.items.map(\.status), [.done, .running])
    XCTAssertEqual(taskCards.first?.taskList?.items.last?.activeLabel, "Shipping")
    XCTAssertEqual(taskCards.first?.timestamp, "2026-09-22T00:00:01.000Z")
  }

  func testTodoOnlyListCarriesCancelledAsSkippedAndEmptyUpdateClearsIt() {
    let first = WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-09-22T00:00:00.000Z",
      sequence: 1,
      event: .taskListUpdate(items: [
        AgentChatTodoItem(id: "cancelled", description: "Old task", status: .completed, activeForm: nil, cancelled: true),
        AgentChatTodoItem(id: "active", description: "Run checks", status: .inProgress, activeForm: "Running checks", cancelled: nil),
      ], turnId: "turn-1")
    )
    let second = WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-09-22T00:00:01.000Z",
      sequence: 2,
      event: .taskListUpdate(items: [], turnId: "turn-1")
    )
    XCTAssertTrue(buildWorkEventCards(from: [first, second]).filter { $0.kind == "taskList" }.isEmpty)
    let card = buildWorkEventCards(from: [first]).first { $0.kind == "taskList" }
    XCTAssertEqual(card?.taskList?.items.first?.status, .done)
    XCTAssertEqual(card?.taskList?.items.first?.note, "skipped")
    XCTAssertEqual(card?.taskList?.items.last?.activeLabel, "Running checks")
  }

  func testPlanProposalDoesNotReplaceTheTaskList() {
    let task = WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-09-22T00:00:00.000Z",
      sequence: 1,
      event: .plan(steps: [WorkPlanStep(text: "Build", status: "pending")], explanation: nil, turnId: "turn-1")
    )
    let proposal = WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-09-22T00:00:01.000Z",
      sequence: 2,
      event: .planProposal(text: "A short proposal", turnId: "turn-2")
    )
    let cards = buildWorkEventCards(from: [task, proposal])
    XCTAssertEqual(cards.filter { $0.kind == "taskList" }.count, 1)
    XCTAssertEqual(cards.filter { $0.kind == "plan" }.first?.body, "A short proposal")
  }

  func testAssistantTextPhasesRemainSeparateWhenTheyShareAnItemId() {
    let transcript = makeWorkChatTranscript(from: [
      AgentChatEventEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-09-24T00:00:00.000Z",
        event: .text(text: "I will inspect the changes.", messageId: "msg-1", turnId: "turn-1", itemId: "item-1", phase: "commentary"),
        sequence: 1,
        provenance: nil
      ),
      AgentChatEventEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-09-24T00:00:01.000Z",
        event: .text(text: "The changes are ready.", messageId: "msg-1", turnId: "turn-1", itemId: "item-1", phase: "final_answer"),
        sequence: 2,
        provenance: nil
      ),
    ])

    let messages = buildWorkChatMessages(from: transcript)
    XCTAssertEqual(messages.count, 2)
    XCTAssertEqual(messages.map(\.textPhase), ["commentary", "final_answer"])
    XCTAssertNotEqual(messages[0].id, messages[1].id)
  }

  func testCompletedTurnFoldsWorkAndKeepsTheFinalAnswerVisible() {
    let user = WorkChatMessage(id: "user-1", role: "user", markdown: "Fix the issue", timestamp: "2026-09-24T00:00:00.000Z", turnId: "turn-1", itemId: nil)
    let commentary = WorkChatMessage(id: "commentary-1", role: "assistant", markdown: "I am checking the source.", timestamp: "2026-09-24T00:00:01.000Z", turnId: "turn-1", itemId: "text-1", textPhase: "commentary")
    let answer = WorkChatMessage(id: "answer-1", role: "assistant", markdown: "The issue is fixed.", timestamp: "2026-09-24T00:00:03.000Z", turnId: "turn-1", itemId: "text-1", textPhase: "final_answer")
    let tool = WorkToolCardModel(id: "tool-1", toolName: "Read", status: .completed, startedAt: "2026-09-24T00:00:02.000Z", completedAt: "2026-09-24T00:00:02.500Z", argsText: nil, resultText: nil, turnId: "turn-1")
    let marker = WorkTurnEndMarker(turnId: "turn-1", time: "2026-09-24T00:00:04.000Z", workedDurationLabel: "4s", status: "completed", terminalReasonLabel: nil, provider: "codex", modelLabel: "GPT", modelId: nil, sourceCount: 2)
    let timeline = [
      WorkTimelineEntry(id: "user:user-1", timestamp: user.timestamp, rank: 0, payload: .message(user), turnId: "turn-1"),
      WorkTimelineEntry(id: "tool:tool-1", timestamp: tool.startedAt, rank: 1, payload: .toolCard(tool), turnId: "turn-1"),
      WorkTimelineEntry(id: "message:commentary-1", timestamp: commentary.timestamp, rank: 2, payload: .message(commentary), turnId: "turn-1"),
      WorkTimelineEntry(id: "message:answer-1", timestamp: answer.timestamp, rank: 3, payload: .message(answer), turnId: "turn-1"),
      WorkTimelineEntry(id: "turn-end:turn-1", timestamp: marker.time, rank: 4, payload: .turnEndMarker(marker), turnId: "turn-1"),
    ]

    let closed = workApplyingTurnFolds(timeline)
    XCTAssertTrue(closed.contains { if case .turnFold = $0.payload { return true }; return false })
    XCTAssertFalse(closed.contains { $0.id == "tool:tool-1" })
    XCTAssertFalse(closed.contains { $0.id == "message:commentary-1" })
    XCTAssertTrue(closed.contains { $0.id == "message:answer-1" })
    let fold = closed.compactMap { entry -> WorkTurnFoldModel? in
      guard case .turnFold(let model) = entry.payload else { return nil }
      return model
    }.first
    XCTAssertEqual(fold?.label, "Worked for 4s · 1 tool · 2 sources")

    let open = workApplyingTurnFolds(timeline, expandedTurnIds: ["turn-1"])
    XCTAssertTrue(open.contains { $0.id == "tool:tool-1" })
    XCTAssertTrue(open.contains { $0.id == "message:commentary-1" })
    XCTAssertTrue(open.contains { $0.id == "message:answer-1" })
  }

  func testBackgroundJobThatWasLiveAtTurnEndStaysBelowTheFold() {
    let user = WorkChatMessage(id: "user-1", role: "user", markdown: "Start the server", timestamp: "2026-09-24T00:00:00.000Z", turnId: "turn-1", itemId: nil)
    let job = WorkBackgroundJobModel(id: "background-job:job-1", taskId: "job-1", title: "npm run dev", status: "completed", startedAt: "2026-09-24T00:00:01.000Z", updatedAt: "2026-09-24T00:00:05.000Z", durationLabel: "4s", turnId: "turn-1")
    let answer = WorkChatMessage(id: "answer-1", role: "assistant", markdown: "The server is running.", timestamp: "2026-09-24T00:00:06.000Z", turnId: "turn-1", itemId: nil, textPhase: "final_answer")
    let marker = WorkTurnEndMarker(turnId: "turn-1", time: "2026-09-24T00:00:07.000Z", workedDurationLabel: "7s", status: "completed", terminalReasonLabel: nil, provider: "claude", modelLabel: "Claude", modelId: nil, liveEntryIds: [job.id])
    let timeline = [
      WorkTimelineEntry(id: "user:user-1", timestamp: user.timestamp, rank: 0, payload: .message(user), turnId: "turn-1"),
      WorkTimelineEntry(id: job.id, timestamp: job.startedAt, rank: 1, payload: .backgroundJob(job), turnId: "turn-1"),
      WorkTimelineEntry(id: "message:answer-1", timestamp: answer.timestamp, rank: 2, payload: .message(answer), turnId: "turn-1"),
      WorkTimelineEntry(id: "turn-end:turn-1", timestamp: marker.time, rank: 3, payload: .turnEndMarker(marker), turnId: "turn-1"),
    ]

    let closed = workApplyingTurnFolds(timeline)
    XCTAssertTrue(closed.contains { $0.id == job.id })
    XCTAssertTrue(closed.contains { if case .turnFold = $0.payload { return true }; return false })
  }

  func testBackgroundTaskUpdatesProduceOneAnchoredTimelineLine() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-09-24T00:00:01.000Z",
        sequence: 1,
        event: .scheduledWorkUpdate(id: "background:job-1", kind: "background_task", status: "running", origin: nil, title: "npm run dev", summary: nil, prompt: nil, reason: nil, cron: nil, nextRunAt: nil, lastRunAt: nil, firedAt: nil, late: nil, recurring: nil, durable: nil, sourceToolUseId: nil, sourceTaskId: "job-1", turnId: "turn-1", error: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-09-24T00:00:04.000Z",
        sequence: 2,
        event: .scheduledWorkUpdate(id: "background:job-1", kind: "background_task", status: "completed", origin: nil, title: "npm run dev", summary: nil, prompt: nil, reason: nil, cron: nil, nextRunAt: nil, lastRunAt: nil, firedAt: nil, late: nil, recurring: nil, durable: nil, sourceToolUseId: nil, sourceTaskId: "job-1", turnId: "turn-1", error: nil)
      ),
    ]
    let timeline = buildWorkTimeline(
      transcript: transcript,
      fallbackEntries: [],
      toolCards: [],
      commandCards: [],
      fileChangeCards: [],
      eventCards: [],
      artifacts: [],
      localEchoMessages: []
    )
    let jobs = timeline.compactMap { entry -> WorkBackgroundJobModel? in
      guard case .backgroundJob(let job) = entry.payload else { return nil }
      return job
    }

    XCTAssertEqual(jobs.count, 1)
    XCTAssertEqual(jobs.first?.id, "background-job:job-1")
    XCTAssertEqual(jobs.first?.startedAt, "2026-09-24T00:00:01.000Z")
    XCTAssertEqual(jobs.first?.updatedAt, "2026-09-24T00:00:04.000Z")
    XCTAssertEqual(jobs.first?.status, "completed")
  }

  func testSourceNormalizationMatchesDesktopTrackingAndMirrorRules() {
    XCTAssertEqual(
      workNormalizeSourceUrl("http://www.example.com/article/amp?b=2&utm_source=mail&a=1#section"),
      "https://example.com/article?a=1&b=2"
    )
    XCTAssertEqual(
      workNormalizeSourceUrl("https://en.m.wikipedia.org/wiki/Foo_(bar)?ref=publisher.example&ref=main"),
      "https://en.wikipedia.org/wiki/Foo_(bar)?ref=main"
    )
    XCTAssertNil(workNormalizeSourceUrl("https://user:secret@example.com/article"))
  }

  func testSourcesDeduplicateMirrorsAndMarkPagesLinkedByTheAnswer() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-09-24T00:00:00.000Z",
        sequence: 1,
        event: .assistantText(
          text: "See [the article](https://example.com/article?a=1&b=2&utm_campaign=answer).",
          turnId: "turn-1",
          itemId: "answer-1"
        )
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-09-24T00:00:01.000Z",
        sequence: 2,
        event: .sources(refs: [
          AgentChatSourceRef(
            kind: "web",
            url: "https://www.example.com/article/amp?b=2&utm_source=mail&a=1#section",
            title: "Example article",
            snippet: nil,
            path: nil,
            lineStart: nil,
            lineEnd: nil,
            query: nil,
            cited: nil
          ),
          AgentChatSourceRef(
            kind: "web",
            url: "http://m.example.com/article?a=1&b=2&ref=publisher.example",
            title: "Example article mirror",
            snippet: nil,
            path: nil,
            lineStart: nil,
            lineEnd: nil,
            query: nil,
            cited: nil
          ),
        ], turnId: "turn-1", omittedForMobile: nil)
      ),
    ]

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )

    XCTAssertEqual(snapshot.sourceRefs.count, 1)
    XCTAssertEqual(snapshot.sourceRefs.first?.title, "Example article mirror")
    XCTAssertEqual(snapshot.sourceRefs.first?.cited, true)
  }

  func testResumedCliChildReopensItsMobileCardAndDropsThePreviousResult() {
    let transcript = parseWorkChatTranscript("""
    {"sessionId":"parent","timestamp":"2026-09-24T10:00:00.000Z","sequence":1,"event":{"type":"subagent_started","taskId":"chat:cli-child","agentId":"cli-child","provider":"codex","agentType":"codex","taskType":"subagent","spawnKind":"subagent","description":"Fix flaky tests"}}
    {"sessionId":"parent","timestamp":"2026-09-24T10:01:00.000Z","sequence":2,"event":{"type":"subagent_result","taskId":"chat:cli-child","agentId":"cli-child","provider":"codex","agentType":"codex","status":"completed","summary":"All tests passed."}}
    {"sessionId":"parent","timestamp":"2026-09-24T10:05:00.000Z","sequence":3,"event":{"type":"subagent_started","taskId":"chat:cli-child","agentId":"cli-child","provider":"codex","agentType":"codex","taskType":"subagent","spawnKind":"subagent","description":"Fix flaky tests","resumed":true}}
    """)

    XCTAssertTrue(transcript.last?.subagentResumed == true)
    let snapshots = buildWorkSubagentSnapshots(from: transcript)
    XCTAssertEqual(snapshots.count, 1)
    XCTAssertEqual(snapshots.first?.provider, "codex")
    XCTAssertEqual(snapshots.first?.status, .running)
    XCTAssertEqual(snapshots.first?.startedAt, "2026-09-24T10:05:00.000Z")
    XCTAssertNil(snapshots.first?.latestSummary)

    let rows = buildWorkSubagentTimelineRows(from: transcript, snapshots: snapshots)
    XCTAssertEqual(rows.map(\.kind), [.spawn])
    XCTAssertEqual(rows.first?.timestamp, "2026-09-24T10:05:00.000Z")
  }
}
