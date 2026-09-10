import XCTest
@testable import ADE

/// Coverage for the usage-limit resume surface: the wire decode, the pill copy
/// per state at an injected instant, the legacy `subagent_result` +
/// `subagent.completed` pair collapse, and the grouped usage-limit failures.
///
/// Every time-sensitive assertion pins `now` — a countdown that only passes at
/// the moment the suite runs is not a test.
final class WorkUsageLimitResumeTests: XCTestCase {

  // MARK: - Fixtures

  /// 2026-07-08T00:00:00Z.
  private let now = Date(timeIntervalSince1970: 1_783_468_800)

  private func summaryJSON(_ extra: String) -> Data {
    Data("""
    {
      "sessionId":"chat-1",
      "laneId":"lane-1",
      "provider":"claude",
      "model":"claude-sonnet",
      "status":"idle",
      "startedAt":"2026-07-08T00:00:00.000Z",
      "lastActivityAt":"2026-07-08T00:00:03.000Z"
      \(extra)
    }
    """.utf8)
  }

  private func summary(
    resume: AgentChatUsageLimitResume?,
    parkedUntil: String? = nil,
    autoContinue: Bool? = nil
  ) -> AgentChatSessionSummary {
    var summary = try! JSONDecoder().decode(AgentChatSessionSummary.self, from: summaryJSON(""))
    summary.usageLimitResume = resume
    summary.usageLimitParkedUntil = parkedUntil
    summary.autoContinueAtUsageLimit = autoContinue
    return summary
  }

  private func subagentResult(
    taskId: String,
    agentId: String?,
    status: String,
    summary: String,
    sequence: Int,
    agentType: String? = nil,
    isLegacyCompletedFrame: Bool = false
  ) -> WorkChatEnvelope {
    WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-07-08T00:00:0\(sequence).000Z",
      sequence: sequence,
      event: .subagentResult(
        taskId: taskId,
        agentId: agentId,
        agentType: agentType,
        parentToolUseId: nil,
        status: status,
        summary: summary,
        label: nil,
        model: nil,
        reasoningEffort: nil,
        turnId: "turn-1"
      ),
      isLegacySubagentCompletedFrame: isLegacyCompletedFrame
    )
  }

  private func failedResultEntry(
    _ id: String,
    _ title: String,
    summary: String,
    rank: Int,
    status: WorkSubagentSnapshot.Status = .failed
  ) -> WorkTimelineEntry {
    let snapshot = WorkSubagentSnapshot(
      taskId: id,
      agentId: id,
      agentType: nil,
      parentToolUseId: nil,
      description: title,
      background: false,
      label: nil,
      model: nil,
      reasoningEffort: nil,
      status: status,
      lastToolName: nil,
      latestSummary: summary,
      turnId: nil,
      startedAt: nil,
      updatedAt: nil
    )
    let row = WorkSubagentTimelineRow(
      kind: .result,
      snapshot: snapshot,
      timestamp: "2026-07-08T00:00:0\(rank)Z",
      summary: summary,
      commandLabel: nil,
      exitLabel: nil
    )
    return WorkTimelineEntry(id: row.id, timestamp: row.timestamp, rank: rank, payload: .subagent(row))
  }

  // MARK: - Decoding

  func testSessionSummaryDecodesUsageLimitResume() throws {
    let data = summaryJSON("""
    ,"usageLimitResume":{
      "state":"armed",
      "provider":"claude",
      "fireAt":"2026-07-08T00:03:00.000Z",
      "resetAt":"2026-07-08T00:02:00.000Z",
      "scheduleId":"auto-resume:chat-1",
      "attempts":1,
      "providerDetail":"5-hour limit reached · resets 7:31 PM ET",
      "turnId":"turn-9",
      "updatedAt":"2026-07-08T00:00:01.000Z"
    }
    """)
    let summary = try JSONDecoder().decode(AgentChatSessionSummary.self, from: data)
    let resume = try XCTUnwrap(summary.usageLimitResume)
    XCTAssertEqual(resume.state, .armed)
    XCTAssertEqual(resume.provider, "claude")
    XCTAssertEqual(resume.fireAt, "2026-07-08T00:03:00.000Z")
    XCTAssertEqual(resume.resetAt, "2026-07-08T00:02:00.000Z")
    XCTAssertEqual(resume.scheduleId, "auto-resume:chat-1")
    XCTAssertEqual(resume.attempts, 1)
    XCTAssertEqual(resume.providerDetail, "5-hour limit reached · resets 7:31 PM ET")
    XCTAssertEqual(resume.turnId, "turn-9")
    XCTAssertEqual(resume.updatedAt, "2026-07-08T00:00:01.000Z")
  }

  func testSessionSummaryDecodesEveryResumeStateAndDegradesUnknown() throws {
    let expected: [(String, AgentChatUsageLimitResumeState)] = [
      ("armed", .armed),
      ("resuming", .resuming),
      ("paused", .paused),
      ("opted_out", .optedOut),
      ("no_reset", .noReset),
      ("teleported_out", .unknown),
    ]
    for (wire, state) in expected {
      let data = summaryJSON(
        ",\"usageLimitResume\":{\"state\":\"\(wire)\",\"provider\":\"claude\",\"updatedAt\":\"x\"}"
      )
      let summary = try JSONDecoder().decode(AgentChatSessionSummary.self, from: data)
      XCTAssertEqual(summary.usageLimitResume?.state, state, "state \(wire)")
      // A missing `attempts` must not fail the whole summary.
      XCTAssertEqual(summary.usageLimitResume?.attempts, 0, "state \(wire)")
    }
  }

  func testAbsentResumeLeavesNilAndKeepsLegacyParkedField() throws {
    let data = summaryJSON(",\"usageLimitParkedUntil\":\"2026-07-08T00:47:00.000Z\"")
    let summary = try JSONDecoder().decode(AgentChatSessionSummary.self, from: data)
    XCTAssertNil(summary.usageLimitResume)
    XCTAssertEqual(summary.usageLimitParkedUntil, "2026-07-08T00:47:00.000Z")
  }

  func testSessionMetaUpdateCarriesResumeAndItsExplicitClear() throws {
    var cached = summary(resume: AgentChatUsageLimitResume(state: .armed, provider: "claude"))

    let armed = try JSONDecoder().decode(
      AgentChatSessionMetaModeUpdate.self,
      from: Data("""
      {"usageLimitResume":{"state":"paused","provider":"claude","attempts":2,"updatedAt":"x"}}
      """.utf8)
    )
    XCTAssertTrue(armed.hasAnyField)
    cached.applyModeUpdate(armed)
    XCTAssertEqual(cached.usageLimitResume?.state, .paused)
    XCTAssertEqual(cached.usageLimitResume?.attempts, 2)

    let cleared = try JSONDecoder().decode(
      AgentChatSessionMetaModeUpdate.self,
      from: Data(#"{"usageLimitResume":null}"#.utf8)
    )
    XCTAssertTrue(cleared.usageLimitResumeWasCleared)
    XCTAssertTrue(cleared.hasAnyField)
    cached.applyModeUpdate(cleared)
    XCTAssertNil(cached.usageLimitResume, "an explicit null means the limit lifted")

    // An absent key is not a clear.
    cached.usageLimitResume = AgentChatUsageLimitResume(state: .armed, provider: "claude")
    let unrelated = try JSONDecoder().decode(
      AgentChatSessionMetaModeUpdate.self,
      from: Data(#"{"permissionMode":"plan"}"#.utf8)
    )
    cached.applyModeUpdate(unrelated)
    XCTAssertEqual(cached.usageLimitResume?.state, .armed)
  }

  /// The clear arrives as an event, and `usageLimitParkedUntil` is a mirror that
  /// event never touches — so without a marker the summary reads exactly like an
  /// old host's and the fallback resurrects the pill the host just retired.
  func testStructuredClearSuppressesTheDeprecatedParkedFallback() throws {
    var cached = summary(
      resume: AgentChatUsageLimitResume(state: .armed, provider: "claude"),
      // Still in the future, and now a lie.
      parkedUntil: "2026-07-08T09:00:00.000Z"
    )

    let cleared = try JSONDecoder().decode(
      AgentChatSessionMetaModeUpdate.self,
      from: Data(#"{"usageLimitResume":null}"#.utf8)
    )
    cached.applyModeUpdate(cleared)
    XCTAssertEqual(cached.usageLimitResumeWasCleared, true)
    XCTAssertEqual(
      cached.usageLimitParkedUntil,
      "2026-07-08T09:00:00.000Z",
      "the event does not touch the mirror — that is exactly the problem"
    )
    XCTAssertNil(
      workUsageLimitResumeModel(for: cached, now: now),
      "a host that speaks the structured row has said the limit lifted"
    )

    // The clear travels into an open view's live summary through the cache fold.
    var live = summary(
      resume: AgentChatUsageLimitResume(state: .armed, provider: "claude"),
      parkedUntil: "2026-07-08T09:00:00.000Z"
    )
    live.mergeModeFields(from: cached)
    XCTAssertNil(live.usageLimitResume)
    XCTAssertEqual(live.usageLimitResumeWasCleared, true)
    XCTAssertNil(workUsageLimitResumeModel(for: live, now: now))

    // A later live row resets the marker, so a real limit is never suppressed.
    let rearmed = try JSONDecoder().decode(
      AgentChatSessionMetaModeUpdate.self,
      from: Data(#"{"usageLimitResume":{"state":"armed","provider":"claude","updatedAt":"x"}}"#.utf8)
    )
    cached.applyModeUpdate(rearmed)
    XCTAssertEqual(cached.usageLimitResumeWasCleared, false)
    XCTAssertEqual(workUsageLimitResumeModel(for: cached, now: now)?.state, .armed)

    live.mergeModeFields(from: cached)
    XCTAssertEqual(live.usageLimitResumeWasCleared, false)
    XCTAssertEqual(workUsageLimitResumeModel(for: live, now: now)?.state, .armed)

    // An old host never sets the marker, so its fallback still works.
    let old = summary(resume: nil, parkedUntil: "2026-07-08T00:47:00.000Z")
    XCTAssertNil(old.usageLimitResumeWasCleared)
    XCTAssertEqual(workUsageLimitResumeModel(for: old, now: now)?.isLegacyFallback, true)
  }

  // MARK: - Render model

  func testRenderModelPrefersHostRowAndFallsBackToLegacyParkedField() {
    let hosted = workUsageLimitResumeModel(
      for: summary(
        resume: AgentChatUsageLimitResume(
          state: .paused,
          provider: "claude",
          fireAt: "2026-07-08T00:03:00.000Z",
          attempts: 2
        ),
        // Present and contradictory on purpose: the deprecated mirror must never
        // win while the host row exists.
        parkedUntil: "2026-07-08T09:00:00.000Z"
      ),
      now: now
    )
    XCTAssertEqual(hosted?.state, .paused)
    XCTAssertEqual(hosted?.attempts, 2)
    XCTAssertEqual(hosted?.isLegacyFallback, false)
    XCTAssertEqual(hosted?.fireAt, Date(timeIntervalSince1970: 1_783_468_980))

    let legacy = workUsageLimitResumeModel(
      for: summary(resume: nil, parkedUntil: "2026-07-08T00:47:00.000Z"),
      now: now
    )
    XCTAssertEqual(legacy?.state, .armed)
    XCTAssertEqual(legacy?.isLegacyFallback, true)

    XCTAssertNil(
      workUsageLimitResumeModel(for: summary(resume: nil), now: now),
      "no limit, no pill"
    )
    XCTAssertNil(
      workUsageLimitResumeModel(
        for: summary(resume: AgentChatUsageLimitResume(state: .unknown, provider: "claude")),
        now: now
      ),
      "a state this build predates renders nothing rather than the wrong copy"
    )
    XCTAssertNil(
      workUsageLimitResumeModel(
        for: summary(resume: nil, parkedUntil: "2026-07-08T00:47:00.000Z", autoContinue: false),
        now: now
      ),
      "legacy fallback still respects an old opt-out"
    )
  }

  // MARK: - Pill copy

  private func armed(minutes: Double, attempts: Int = 1) -> WorkUsageLimitResumeModel {
    WorkUsageLimitResumeModel(
      state: .armed,
      provider: "claude",
      fireAt: now.addingTimeInterval(minutes * 60),
      attempts: attempts
    )
  }

  func testPillLabelPerStateAtAnInjectedNow() {
    XCTAssertEqual(
      workUsageLimitPillLabel(armed(minutes: 3), now: now),
      "Resumes in 3 min · usage limit"
    )
    XCTAssertEqual(
      workUsageLimitPillLabel(armed(minutes: 125), now: now),
      "Resumes in 2 hr 5 min · usage limit"
    )
    // Under five minutes the label gains seconds, which is exactly the window
    // where the pill also ticks per second.
    XCTAssertEqual(
      workUsageLimitPillLabel(armed(minutes: 4.5), now: now),
      "Resumes in 4 min 30 s · usage limit"
    )
    // Armed but already due reads as the act, not a negative countdown.
    XCTAssertEqual(workUsageLimitPillLabel(armed(minutes: -2), now: now), "Resuming…")

    XCTAssertEqual(
      workUsageLimitPillLabel(
        WorkUsageLimitResumeModel(state: .resuming, provider: "claude"),
        now: now
      ),
      "Resuming…"
    )
    XCTAssertEqual(
      workUsageLimitPillLabel(
        WorkUsageLimitResumeModel(
          state: .paused,
          provider: "claude",
          resetAt: now.addingTimeInterval(3_600),
          attempts: 2
        ),
        now: now
      ),
      "Paused after 2 tries · Try at \(workUsageLimitClockLabel(now.addingTimeInterval(3_600)))"
    )
    XCTAssertEqual(
      workUsageLimitPillLabel(
        WorkUsageLimitResumeModel(state: .optedOut, provider: "claude"),
        now: now
      ),
      "Won't auto-resume · Turn on"
    )
    XCTAssertEqual(
      workUsageLimitPillLabel(
        WorkUsageLimitResumeModel(state: .noReset, provider: "claude"),
        now: now
      ),
      "Usage limit · no reset time · Retry"
    )
  }

  func testPillIsNeverAWarningGlyphAndAccessibilityLabelSpellsItOut() {
    for state: AgentChatUsageLimitResumeState in [.armed, .resuming, .paused, .optedOut, .noReset] {
      let glyph = workUsageLimitPillGlyph(state)
      XCTAssertFalse(glyph.contains("exclamationmark"), "\(state) must not wear an error glyph")
      XCTAssertFalse(glyph.isEmpty)
    }
    let label = workUsageLimitPillAccessibilityLabel(armed(minutes: 3), now: now)
    XCTAssertFalse(label.contains("·"), "VoiceOver should not read a middle dot")
    XCTAssertTrue(label.hasPrefix("Claude usage limit."))
  }

  func testTickIntervalDropsToOneSecondInsideTheLastFiveMinutes() {
    XCTAssertEqual(workUsageLimitTickInterval(fireAt: now.addingTimeInterval(600), now: now), 60)
    XCTAssertEqual(workUsageLimitTickInterval(fireAt: now.addingTimeInterval(299), now: now), 1)
    XCTAssertEqual(workUsageLimitTickInterval(fireAt: nil, now: now), 60)
  }

  /// Past the target the interval has already dropped to one second and the
  /// label is frozen at "Resuming…", so a stale armed model left behind by a
  /// disconnected host would tick forever with nothing to redraw.
  func testCountdownStopsBeingLiveOnceItsTargetPasses() {
    XCTAssertTrue(workUsageLimitCountdownIsLive(target: now.addingTimeInterval(1), now: now))
    XCTAssertFalse(workUsageLimitCountdownIsLive(target: now, now: now))
    XCTAssertFalse(workUsageLimitCountdownIsLive(target: now.addingTimeInterval(-1), now: now))
    XCTAssertFalse(workUsageLimitCountdownIsLive(target: nil, now: now), "no target, no timer")

    // `resuming` and `paused` have nothing to count to at all.
    XCTAssertFalse(
      workUsageLimitCountdownIsLive(
        target: WorkUsageLimitResumeModel(state: .resuming, provider: "claude").countdownTarget,
        now: now
      )
    )
    XCTAssertFalse(
      workUsageLimitCountdownIsLive(target: armed(minutes: -2).countdownTarget, now: now),
      "an armed row already past its fire time stops the ticker"
    )
  }

  // MARK: - Sheet copy

  func testSheetTitleBodyAndPrimaryActionPerState() {
    let model = armed(minutes: 3)
    XCTAssertEqual(workUsageLimitSheetTitle(model), "Claude usage limit")
    let lines = workUsageLimitSheetBodyLines(model, now: now)
    XCTAssertEqual(lines.count, 2)
    XCTAssertTrue(lines[0].hasPrefix("ADE sends \u{201C}continue\u{201D} at "))
    XCTAssertTrue(lines[0].hasSuffix("(in 3 min)."))
    XCTAssertEqual(lines[1], "Nothing is lost. Subagents restart with it.")

    XCTAssertEqual(workUsageLimitPrimaryAction(.armed), .resumeNow)
    XCTAssertEqual(workUsageLimitPrimaryAction(.resuming), .resumeNow)
    XCTAssertEqual(workUsageLimitPrimaryAction(.noReset), .resumeNow)
    XCTAssertEqual(workUsageLimitPrimaryAction(.paused), .tryAgain)
    XCTAssertEqual(workUsageLimitPrimaryAction(.optedOut), .turnOn)
    XCTAssertEqual(WorkUsageLimitResumePrimaryAction.resumeNow.label, "Resume now")
    XCTAssertEqual(WorkUsageLimitResumePrimaryAction.tryAgain.label, "Try again")
    XCTAssertEqual(WorkUsageLimitResumePrimaryAction.turnOn.label, "Turn on")

    // Nothing to opt out of once you already have.
    XCTAssertFalse(workUsageLimitShowsOptOut(.optedOut))
    XCTAssertTrue(workUsageLimitShowsOptOut(.armed))
    XCTAssertTrue(workUsageLimitShowsOptOut(.paused))
  }

  /// The sheet hides `Resume now` only for a host that cannot run it. A viewer
  /// device or a dropped connection still gets the button — the tap is what
  /// reports the cause, so hiding it there would lose the explanation.
  func testResumeNowButtonHidesOnlyForAnUnsupportedHost() {
    // Supported host, owner device: the handler is wired, the button shows.
    XCTAssertTrue(
      workUsageLimitShowsPrimaryButton(state: .armed, hasResumeNowAction: true)
    )
    XCTAssertTrue(
      workUsageLimitShowsPrimaryButton(state: .resuming, hasResumeNowAction: true)
    )
    XCTAssertTrue(
      workUsageLimitShowsPrimaryButton(state: .noReset, hasResumeNowAction: true)
    )

    // Older host: no handler is passed, so the primary disappears rather than
    // sitting there permanently dead.
    XCTAssertFalse(
      workUsageLimitShowsPrimaryButton(state: .armed, hasResumeNowAction: false)
    )
    XCTAssertFalse(
      workUsageLimitShowsPrimaryButton(state: .resuming, hasResumeNowAction: false)
    )
    XCTAssertFalse(
      workUsageLimitShowsPrimaryButton(state: .noReset, hasResumeNowAction: false)
    )

    // `Try again` / `Turn on` ride `chat.updateSession`, which is not gated on
    // the new action at all — they stay visible either way.
    XCTAssertTrue(
      workUsageLimitShowsPrimaryButton(state: .paused, hasResumeNowAction: false)
    )
    XCTAssertTrue(
      workUsageLimitShowsPrimaryButton(state: .optedOut, hasResumeNowAction: false)
    )
  }

  // MARK: - Session-list badge

  func testRowStatusReplacesTheFailedDotForArmedAndPaused() {
    let armedStatus = workUsageLimitRowStatus(armed(minutes: 3), now: now)
    XCTAssertEqual(armedStatus?.glyph, .parked)
    XCTAssertEqual(
      armedStatus?.label,
      "Resumes \(workUsageLimitClockLabel(now.addingTimeInterval(180)))"
    )
    XCTAssertEqual(ActivityGlyph.parked.systemImage, "clock")
    // A scheduled resume is an appointment, not a problem.
    XCTAssertEqual(armedStatus?.tone, .neutral)

    let pausedStatus = workUsageLimitRowStatus(
      WorkUsageLimitResumeModel(state: .paused, provider: "claude", attempts: 2),
      now: now
    )
    XCTAssertEqual(pausedStatus?.label, "Paused · limit")
    // Paused is the one state that wants the eye: nothing is scheduled any more
    // and only the user can restart it.
    XCTAssertEqual(pausedStatus?.tone, .amber)
    let resumingStatus = workUsageLimitRowStatus(
      WorkUsageLimitResumeModel(state: .resuming, provider: "claude"),
      now: now
    )
    XCTAssertEqual(resumingStatus?.label, "Resuming")
    XCTAssertEqual(resumingStatus?.tone, .neutral)
    // A `resuming` row never quotes a clock, even when a future fireAt is still
    // attached: the resume is happening now, not at that time.
    let resumingWithFutureFireAt = workUsageLimitRowStatus(
      WorkUsageLimitResumeModel(
        state: .resuming,
        provider: "claude",
        fireAt: now.addingTimeInterval(180)
      ),
      now: now
    )
    XCTAssertEqual(resumingWithFutureFireAt?.label, "Resuming")
    XCTAssertEqual(resumingWithFutureFireAt?.tone, .neutral)
    // An `armed` row whose fire time has already passed is due, not late.
    let armedOverdue = workUsageLimitRowStatus(
      WorkUsageLimitResumeModel(
        state: .armed,
        provider: "claude",
        fireAt: now.addingTimeInterval(-30)
      ),
      now: now
    )
    XCTAssertEqual(armedOverdue?.label, "Resuming")
    // Nothing is scheduled in these two, so the row keeps its real phase.
    XCTAssertNil(
      workUsageLimitRowStatus(WorkUsageLimitResumeModel(state: .optedOut, provider: "claude"), now: now)
    )
    XCTAssertNil(
      workUsageLimitRowStatus(WorkUsageLimitResumeModel(state: .noReset, provider: "claude"), now: now)
    )
    XCTAssertNil(workUsageLimitRowStatus(nil, now: now))
  }

  // MARK: - Legacy subagent result pair collapse

  func testLegacyResultPairKeepsTheCanonicalFrameAndDropsTheTwin() {
    // The old host shape: the canonical `subagent_result` keyed only by taskId,
    // then the legacy `subagent.completed` twin keyed by agentId, for the SAME
    // finished subagent. The canonical frame survives verbatim — the twin
    // defaults an absent status to "completed", so merging its fields in is how
    // a real failure used to be downgraded.
    let transcript = [
      subagentResult(
        taskId: "toolu_01",
        agentId: nil,
        status: "failed",
        summary: "Claude usage limit reached",
        sequence: 1,
        agentType: "explorer"
      ),
      subagentResult(
        taskId: "toolu_01",
        agentId: "toolu_01",
        status: "completed",
        summary: "Completed",
        sequence: 2,
        agentType: "general-purpose",
        isLegacyCompletedFrame: true
      ),
    ]

    let collapsed = collapseLegacyWorkSubagentResultEnvelopes(transcript)
    XCTAssertEqual(collapsed.count, 1, "one finished subagent, one result frame")
    guard case .subagentResult(_, let agentId, let agentType, _, let status, let summary, _, _, _, _) =
      collapsed[0].event
    else { return XCTFail("expected the canonical subagent result") }
    XCTAssertNil(agentId, "the canonical frame is kept verbatim, not rewritten")
    XCTAssertEqual(agentType, "explorer", "no field of the twin leaks into the survivor")
    XCTAssertEqual(status, "failed", "a real failure is never downgraded by the twin's default")
    XCTAssertEqual(summary, "Claude usage limit reached")
    XCTAssertEqual(collapsed[0].timestamp, "2026-07-08T00:00:01.000Z", "keeps the earlier position")

    // And the fold that actually draws the transcript emits one result row.
    let rows = buildWorkSubagentTimelineRows(from: transcript)
      .filter { $0.kind == .result }
    XCTAssertEqual(rows.count, 1)
    XCTAssertEqual(rows[0].snapshot.status, .failed)
  }

  /// The case a field-by-field merge could not tell from the legacy pair: one
  /// agent that reported `completed` and was then settled `stopped` by an
  /// interrupt. Both frames are canonical, so both must survive.
  func testGenuineCompletedThenStoppedPairStaysTwoRows() {
    let collapsed = collapseLegacyWorkSubagentResultEnvelopes([
      subagentResult(taskId: "a", agentId: "a", status: "completed", summary: "done", sequence: 1),
      subagentResult(taskId: "a", agentId: "a", status: "stopped", summary: "Interrupted", sequence: 2),
    ])
    XCTAssertEqual(collapsed.count, 2)
  }

  /// A legacy twin with no canonical frame to defer to is all the transcript
  /// has; dropping it would lose the row entirely.
  func testLoneLegacyFrameIsKept() {
    let collapsed = collapseLegacyWorkSubagentResultEnvelopes([
      subagentResult(
        taskId: "a",
        agentId: "a",
        status: "completed",
        summary: "done",
        sequence: 1,
        isLegacyCompletedFrame: true
      ),
      subagentResult(taskId: "b", agentId: "b", status: "failed", summary: "two", sequence: 2),
    ])
    XCTAssertEqual(collapsed.count, 2)
  }

  func testDistinctSubagentResultsAreNotMerged() {
    let collapsed = collapseLegacyWorkSubagentResultEnvelopes([
      subagentResult(taskId: "a", agentId: "a", status: "failed", summary: "one", sequence: 1),
      subagentResult(taskId: "b", agentId: "b", status: "failed", summary: "two", sequence: 2),
    ])
    XCTAssertEqual(collapsed.count, 2)
  }

  // MARK: - Usage-limit text rule

  /// Mirrors desktop's `isUsageLimitFailureText`. The bare status code is
  /// the trap: it shows up in stack traces and token counts that have nothing
  /// to do with a limit, so `429` only counts alongside a limit word.
  func testUsageLimitTextRuleMatchesTheDesktopRule() {
    XCTAssertTrue(workTextIndicatesUsageLimit("usage_limit exceeded"))
    XCTAssertTrue(workTextIndicatesUsageLimit("Claude usage limit reached"))
    XCTAssertTrue(workTextIndicatesUsageLimit("HTTP 429 rate_limit"))
    XCTAssertTrue(workTextIndicatesUsageLimit("Quota exceeded"))
    XCTAssertTrue(workTextIndicatesUsageLimit("quota-exhausted"))
    XCTAssertTrue(workTextIndicatesUsageLimit("429: usage cap hit"))

    XCTAssertFalse(workTextIndicatesUsageLimit("AssertionError at parser.ts:429"))
    XCTAssertFalse(workTextIndicatesUsageLimit("context overflow: 4290 tokens"))
    XCTAssertFalse(workTextIndicatesUsageLimit("compile error in main.swift"))
    XCTAssertFalse(workTextIndicatesUsageLimit("   "))
    XCTAssertFalse(workTextIndicatesUsageLimit(nil))
  }

  // MARK: - Grouped usage-limit failures

  func testConsecutiveUsageLimitFailuresGroupIntoOneRow() {
    let folded = collapseSameCauseSubagentEntries([
      failedResultEntry("a", "Alpha", summary: "Claude usage limit reached", rank: 0),
      failedResultEntry("b", "Bravo", summary: "Claude usage limit reached", rank: 1),
      failedResultEntry("c", "Charlie", summary: "rate limit (429)", rank: 2),
    ], causeOf: workSubagentStoppedGroupCause)
    XCTAssertEqual(folded.count, 1)
    guard case .subagentStoppedGroup(let model) = folded[0].payload else {
      return XCTFail("expected a usage-limit group")
    }
    XCTAssertEqual(model.count, 3)
    XCTAssertEqual(model.reason, .usageLimit)
    XCTAssertEqual(model.headline, "3 agents stopped · usage limit")
    XCTAssertEqual(folded[0].id, "subagent-usage-limit-group-a")
  }

  func testUnrelatedFailureBreaksTheUsageLimitRunAndLoneFailureStaysIndividual() {
    let folded = collapseSameCauseSubagentEntries([
      failedResultEntry("a", "Alpha", summary: "usage limit reached", rank: 0),
      failedResultEntry("b", "Bravo", summary: "usage limit reached", rank: 1),
      failedResultEntry("x", "Interloper", summary: "compile error in main.swift", rank: 2),
      failedResultEntry("c", "Charlie", summary: "usage limit reached", rank: 3),
    ], causeOf: workSubagentStoppedGroupCause)
    // group(a,b) · failed(x) · failed(c)
    XCTAssertEqual(folded.count, 3)
    guard case .subagentStoppedGroup(let group) = folded[0].payload else {
      return XCTFail("expected the leading pair to group")
    }
    XCTAssertEqual(group.count, 2)
    if case .subagentStoppedGroup = folded[1].payload { XCTFail("an unrelated failure must not group") }
    if case .subagentStoppedGroup = folded[2].payload { XCTFail("a lone failure stays an ordinary row") }
  }

  func testInterruptStoppedRunsKeepTheirOwnReasonAndCopy() {
    // A run breaks whenever the cause changes, so an interrupt casualty and a
    // usage-limit casualty can never land in the same group.
    let folded = collapseSameCauseSubagentEntries(
      [
        failedResultEntry("a", "Alpha", summary: "stopped", rank: 0, status: .stopped),
        failedResultEntry("b", "Bravo", summary: "stopped", rank: 1, status: .stopped),
      ],
      causeOf: workSubagentStoppedGroupCause
    )
    XCTAssertEqual(folded.count, 1)
    guard case .subagentStoppedGroup(let model) = folded[0].payload else {
      return XCTFail("expected an interrupt group")
    }
    XCTAssertEqual(model.reason, .interrupted)
    XCTAssertEqual(model.headline, "2 agents stopped when you interrupted")
  }

  // MARK: - Quiet turn footer

  private func doneEnvelope(
    turnId: String,
    apiErrorStatus: Int?,
    sequence: Int
  ) -> WorkChatEnvelope {
    WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-07-08T00:00:0\(sequence).000Z",
      sequence: sequence,
      event: .done(
        status: "failed",
        summary: "",
        usage: makeWorkUsageSummary(
          inputTokens: 120,
          outputTokens: 40,
          cacheReadTokens: nil,
          cacheCreationTokens: nil,
          reasoningTokens: nil,
          totalTokens: 160,
          contextWindow: nil,
          costUsd: 0.02
        ),
        turnId: turnId,
        model: "claude-sonnet",
        modelId: "claude-sonnet",
        terminalReason: nil
      ),
      apiErrorStatus: apiErrorStatus
    )
  }

  func testTurnEndMarkerReadsAsPausedFromA429() {
    let markers = workTurnEndMarkers(from: [doneEnvelope(turnId: "turn-1", apiErrorStatus: 429, sequence: 1)])
    XCTAssertEqual(markers.count, 1)
    XCTAssertTrue(markers[0].usageLimitPaused)
    XCTAssertNotNil(markers[0].usage, "usage rides the marker so it can move behind the details toggle")
  }

  /// The 429 has to survive the real sync path, not just a hand-built envelope.
  ///
  /// `AgentChatEvent.done` does not decode `apiErrorStatus`, so the field only
  /// reaches the footer because `AgentChatEventEnvelope` peeks at the raw event
  /// and `makeWorkChatTranscript` forwards it. The tests above build a
  /// `WorkChatEnvelope` directly and would keep passing with that whole chain
  /// deleted — which is exactly how every synced usage-limit turn came to look
  /// unlimited, losing its quiet footer as soon as the resume row cleared.
  private func syncedTranscript(apiErrorStatusJSON: String) throws -> [WorkChatEnvelope] {
    let startJSON = """
    {
      "sessionId": "chat-1",
      "timestamp": "2026-07-08T00:00:00.000Z",
      "sequence": 1,
      "event": { "type": "status", "turnStatus": "started", "turnId": "turn-1" }
    }
    """
    let doneJSON = """
    {
      "sessionId": "chat-1",
      "timestamp": "2026-07-08T00:01:30.000Z",
      "sequence": 2,
      "event": {
        "type": "done",
        "turnId": "turn-1",
        "status": "failed",
        "terminalReason": "api_error"\(apiErrorStatusJSON)
      }
    }
    """
    let decoder = JSONDecoder()
    let envelopes = try [startJSON, doneJSON].map {
      try decoder.decode(AgentChatEventEnvelope.self, from: Data($0.utf8))
    }
    return makeWorkChatTranscript(from: envelopes)
  }

  func testSyncedDoneFrameCarriesItsApiErrorStatusToTheQuietFooter() throws {
    let transcript = try syncedTranscript(apiErrorStatusJSON: ",\n        \"apiErrorStatus\": 429")
    let done = try XCTUnwrap(transcript.last)
    XCTAssertEqual(done.apiErrorStatus, 429, "the decode has to carry the status off the wire")

    let markers = workTurnEndMarkers(from: transcript)
    XCTAssertEqual(markers.count, 1)
    XCTAssertTrue(
      markers[0].usageLimitPaused,
      "a synced 429 turn reads as paused with no resume row to anchor it"
    )
    // The footer's own line is `Paused · usage limit · <worked duration>`.
    XCTAssertEqual(markers[0].workedDurationLabel, "1m 30s")
  }

  func testSyncedDoneFrameWithoutA429IsNotPaused() throws {
    let transcript = try syncedTranscript(apiErrorStatusJSON: "")
    XCTAssertNil(transcript.last?.apiErrorStatus)
    XCTAssertFalse(
      workTurnEndMarkers(from: transcript)[0].usageLimitPaused,
      "an ordinary API error is a failure, not a pause"
    )

    let other = try syncedTranscript(apiErrorStatusJSON: ",\n        \"apiErrorStatus\": 529")
    XCTAssertEqual(other.last?.apiErrorStatus, 529)
    XCTAssertFalse(
      workTurnEndMarkers(from: other)[0].usageLimitPaused,
      "only 429 is a usage limit; 529 is an overload"
    )
  }

  /// An off-contract `apiErrorStatus` costs only itself.
  ///
  /// Both raw fields are peeked off the same `event` object, so decoding them
  /// under one throwing path would let a non-numeric status fail the peek
  /// wholesale and take the wire `type` with it — and `type` is the only thing
  /// that tells a legacy `subagent.completed` twin apart from a genuine second
  /// result, so a bad status in one frame would surface as duplicated subagent
  /// rows somewhere else entirely.
  func testAnOffContractApiErrorStatusDoesNotCostTheWireType() throws {
    let doneJSON = """
    {
      "sessionId": "chat-1",
      "timestamp": "2026-07-08T00:01:30.000Z",
      "sequence": 1,
      "event": {
        "type": "done",
        "turnId": "turn-1",
        "status": "failed",
        "apiErrorStatus": "429"
      }
    }
    """
    let done = try JSONDecoder().decode(AgentChatEventEnvelope.self, from: Data(doneJSON.utf8))
    XCTAssertNil(done.apiErrorStatus, "a string is not the numeric status the host contract promises")
    guard case .done = done.event else {
      return XCTFail("the envelope still has to decode — one bad field is not a lost event")
    }
    XCTAssertFalse(done.isLegacySubagentCompletedFrame)

    // The same garbage on the frame where `type` actually carries weight.
    let legacyJSON = """
    {
      "sessionId": "chat-1",
      "timestamp": "2026-07-08T00:02:00.000Z",
      "sequence": 2,
      "event": {
        "type": "subagent.completed",
        "agentId": "agent-1",
        "apiErrorStatus": "not-a-number"
      }
    }
    """
    let legacy = try JSONDecoder().decode(AgentChatEventEnvelope.self, from: Data(legacyJSON.utf8))
    XCTAssertNil(legacy.apiErrorStatus)
    XCTAssertTrue(
      legacy.isLegacySubagentCompletedFrame,
      "the wire type survives its neighbour's bad value, so the twin still collapses"
    )
  }

  func testTurnEndMarkerReadsAsPausedFromTheResumeRowTurnId() {
    let transcript = [doneEnvelope(turnId: "turn-7", apiErrorStatus: nil, sequence: 1)]
    XCTAssertFalse(workTurnEndMarkers(from: transcript)[0].usageLimitPaused)
    let anchored = workTurnEndMarkers(from: transcript, usageLimitTurnId: "turn-7")
    XCTAssertTrue(anchored[0].usageLimitPaused)
    XCTAssertFalse(
      workTurnEndMarkers(from: transcript, usageLimitTurnId: "turn-other")[0].usageLimitPaused,
      "the anchor is a turn id, not a wildcard"
    )
  }

  func testUsageRowMovesOffTheTimelineForALimitedTurn() {
    let transcript = [doneEnvelope(turnId: "turn-1", apiErrorStatus: 429, sequence: 1)]
    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    let standaloneUsageRows = snapshot.timeline.filter {
      if case .usageSummary = $0.payload { return true }
      return false
    }
    XCTAssertTrue(standaloneUsageRows.isEmpty, "the USAGE row folds into the footer's details")

    let plain = buildWorkChatTimelineSnapshot(
      transcript: [doneEnvelope(turnId: "turn-1", apiErrorStatus: nil, sequence: 1)],
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    XCTAssertFalse(
      plain.timeline.filter {
        if case .usageSummary = $0.payload { return true }
        return false
      }.isEmpty,
      "an ordinary turn keeps its usage row exactly where it was"
    )
  }

  /// `WorkChatTimelineSnapshot.==` compares nothing but the signature, so the
  /// anchor has to be IN the signature: a rebuild driven purely by the summary's
  /// resume row would otherwise compare equal to the stale snapshot and the
  /// footer would keep saying "Failed" for a chat that is only paused.
  func testSnapshotSignatureFollowsTheUsageLimitTurnAnchor() {
    let transcript = [doneEnvelope(turnId: "turn-1", apiErrorStatus: nil, sequence: 1)]
    func snapshot(_ usageLimitTurnId: String?) -> WorkChatTimelineSnapshot {
      buildWorkChatTimelineSnapshot(
        transcript: transcript,
        fallbackEntries: [],
        artifacts: [],
        localEchoMessages: [],
        usageLimitTurnId: usageLimitTurnId
      )
    }

    let unanchored = snapshot(nil)
    let anchored = snapshot("turn-1")
    XCTAssertNotEqual(anchored.signature, unanchored.signature)
    XCTAssertNotEqual(anchored, unanchored, "the rebuilt snapshot must not look stale")
    XCTAssertNotEqual(anchored, snapshot("turn-other"))
    XCTAssertEqual(snapshot("turn-1"), anchored, "and the same inputs still settle")
  }

  // MARK: - Raw transcript parity

  /// The sync decoder accepts both spellings; the raw parser has to as well, or
  /// a snake-case transcript loses its 429 and the turn reads as a failure.
  func testRawTranscriptAcceptsTheSnakeCaseApiErrorStatus() {
    func parsed(_ key: String) -> [WorkChatEnvelope] {
      parseWorkChatTranscript("""
      {
        "sessionId": "chat-1",
        "timestamp": "2026-07-08T00:00:00.000Z",
        "sequence": 1,
        "event": { "type": "status", "turnStatus": "started", "turnId": "turn-1" }
      }
      {
        "sessionId": "chat-1",
        "timestamp": "2026-07-08T00:01:30.000Z",
        "sequence": 2,
        "event": {
          "type": "done",
          "turnId": "turn-1",
          "status": "failed",
          "terminalReason": "api_error",
          "\(key)": 429
        }
      }
      """)
    }

    for key in ["apiErrorStatus", "api_error_status"] {
      let transcript = parsed(key)
      XCTAssertEqual(transcript.last?.apiErrorStatus, 429, "key \(key)")
      XCTAssertTrue(workTurnEndMarkers(from: transcript)[0].usageLimitPaused, "key \(key)")
    }

    // An explicit `null` on the camel-case key is PRESENT in the dictionary as
    // an `NSNull`, so coalescing the raw values would swallow the real status
    // sitting beside it. Each key is coerced on its own.
    let bothKeys = parseWorkChatTranscript("""
    {
      "sessionId": "chat-1",
      "timestamp": "2026-07-08T00:01:30.000Z",
      "sequence": 1,
      "event": {
        "type": "done",
        "turnId": "turn-1",
        "status": "failed",
        "apiErrorStatus": null,
        "api_error_status": 429
      }
    }
    """)
    XCTAssertEqual(bothKeys.last?.apiErrorStatus, 429, "a null camel key must not shadow the snake one")
  }

  /// The raw parser flags `subagent.completed` as the legacy twin, so it also has
  /// to DECODE it as a result — left `.unknown` the flag was dead weight and the
  /// collapse never ran, which is the doubled-result wall all over again.
  func testRawTranscriptDecodesAndCollapsesTheLegacySubagentTwin() throws {
    let raw = """
    {
      "sessionId": "chat-1",
      "timestamp": "2026-07-08T00:00:01.000Z",
      "sequence": 1,
      "event": {
        "type": "subagent_result",
        "taskId": "task-1",
        "agentId": "agent-1",
        "status": "failed",
        "summary": "Canonical result",
        "turnId": "turn-1"
      }
    }
    {
      "sessionId": "chat-1",
      "timestamp": "2026-07-08T00:00:02.000Z",
      "sequence": 2,
      "event": {
        "type": "subagent.completed",
        "agentId": "agent-1",
        "turnId": "turn-1"
      }
    }
    """
    let transcript = parseWorkChatTranscript(raw)
    XCTAssertEqual(transcript.count, 2)
    let twin = try XCTUnwrap(transcript.last)
    XCTAssertTrue(twin.isLegacySubagentCompletedFrame)
    guard case .subagentResult(let taskId, let agentId, _, _, let status, let summary, _, _, _, _) = twin.event else {
      return XCTFail("the legacy twin has to decode as the result it is")
    }
    // Same normalization the sync decoder applies: the agent id doubles as the
    // task id, and an absent status/summary defaults to completed.
    XCTAssertEqual(taskId, "agent-1")
    XCTAssertEqual(agentId, "agent-1")
    XCTAssertEqual(status, "completed")
    XCTAssertEqual(summary, "Completed")

    let collapsed = collapseLegacyWorkSubagentResultEnvelopes(transcript)
    XCTAssertEqual(collapsed.count, 1, "the canonical frame already claims this agent")
    XCTAssertEqual(collapsed.first?.sequence, 1)
    XCTAssertEqual(
      buildWorkSubagentSnapshots(from: transcript).count,
      1,
      "one finished agent is one row"
    )

    // A legacy frame with no canonical twin is still kept verbatim.
    let orphan = parseWorkChatTranscript("""
    {
      "sessionId": "chat-1",
      "timestamp": "2026-07-08T00:00:03.000Z",
      "sequence": 3,
      "event": { "type": "subagent.completed", "agentId": "agent-2", "summary": "Done" }
    }
    """)
    XCTAssertEqual(collapseLegacyWorkSubagentResultEnvelopes(orphan).count, 1)
  }

  /// The typed decoder REQUIRES `agentId` on a legacy twin and drops the frame
  /// without one. The raw path has to agree: an identity-less twin has nothing
  /// to collapse on, so keying a row by the empty string would put a phantom
  /// subagent on the timeline that the synced transcript never shows.
  func testRawLegacySubagentTwinWithoutAnAgentIdIsNotARow() throws {
    let raw = """
    {
      "sessionId": "chat-1",
      "timestamp": "2026-07-08T00:00:01.000Z",
      "sequence": 1,
      "event": { "type": "subagent.completed", "summary": "No identity at all" }
    }
    """
    let transcript = parseWorkChatTranscript(raw)
    let frame = try XCTUnwrap(transcript.first)
    guard case .unknown(let type) = frame.event else {
      return XCTFail("an identity-less legacy twin is not a result")
    }
    XCTAssertEqual(type, "subagent.completed")
    XCTAssertTrue(
      buildWorkSubagentSnapshots(from: transcript).isEmpty,
      "no identity, no subagent row"
    )
    // The typed decoder agrees — it throws the same frame away entirely.
    XCTAssertThrowsError(
      try JSONDecoder().decode(AgentChatEventEnvelope.self, from: Data(raw.utf8))
    )

    // The twin's own fields still ride through when the id IS there, including
    // `parentAgentId` staying OUT of `parentToolUseId` (the typed decoder pins
    // that to nil).
    let parented = parseWorkChatTranscript("""
    {
      "sessionId": "chat-1",
      "timestamp": "2026-07-08T00:00:02.000Z",
      "sequence": 2,
      "event": {
        "type": "subagent.completed",
        "agentId": "agent-3",
        "parentAgentId": "parent-9",
        "status": "failed",
        "summary": "Ran out of budget"
      }
    }
    """)
    guard case .subagentResult(let taskId, _, _, let parentToolUseId, let status, let summary, _, _, _, _) =
      try XCTUnwrap(parented.first).event
    else {
      return XCTFail("a twin with an agent id is a result")
    }
    XCTAssertEqual(taskId, "agent-3", "the agent id doubles as the task id")
    XCTAssertNil(parentToolUseId, "parentAgentId is not a parent tool use id on this frame")
    XCTAssertEqual(status, "failed", "an explicit status still wins over the completed default")
    XCTAssertEqual(summary, "Ran out of budget")
  }

  // MARK: - Resume-now result

  /// A refused `Resume now` is an ordinary answer with `ok: false`, not a
  /// thrown error. If the phone drops it, the tap plays the success haptic and
  /// clears the error while the chat stays parked — the desktop popover shows
  /// the host's sentence, and so must this.
  func testResumeUsageLimitNowRefusalCarriesTheHostSentence() throws {
    let refused = try JSONDecoder().decode(
      AgentChatResumeUsageLimitNowResult.self,
      from: Data("""
      {"ok":false,"reason":"resume_in_flight","message":"This chat is already resuming. Wait for the current turn to start."}
      """.utf8)
    )
    XCTAssertFalse(refused.ok)
    XCTAssertEqual(refused.reason, "resume_in_flight")
    XCTAssertEqual(
      refused.refusalMessage,
      "This chat is already resuming. Wait for the current turn to start."
    )

    let noLimit = try JSONDecoder().decode(
      AgentChatResumeUsageLimitNowResult.self,
      from: Data("""
      {"ok":false,"reason":"no_live_usage_limit","message":"No usage limit is live for this chat."}
      """.utf8)
    )
    XCTAssertEqual(noLimit.refusalMessage, "No usage limit is live for this chat.")
  }

  /// Success carries no sentence, so nothing is shown — and a null `turnId` is
  /// normal, because some providers only mint one after the backend answers.
  func testResumeUsageLimitNowSuccessShowsNothing() throws {
    let sent = try JSONDecoder().decode(
      AgentChatResumeUsageLimitNowResult.self,
      from: Data(#"{"ok":true,"turnId":null}"#.utf8)
    )
    XCTAssertTrue(sent.ok)
    XCTAssertNil(sent.turnId)
    XCTAssertNil(sent.refusalMessage)

    let withTurn = try JSONDecoder().decode(
      AgentChatResumeUsageLimitNowResult.self,
      from: Data(#"{"ok":true,"turnId":"turn-9"}"#.utf8)
    )
    XCTAssertEqual(withTurn.turnId, "turn-9")
    XCTAssertNil(withTurn.refusalMessage)
  }

  /// Decoding stays total: an unexpected payload must not turn a real outcome
  /// into a parser error, and a refusal without copy still says something. It is
  /// also fail-closed — a payload with no `ok` is a refusal, because reading it
  /// as success would clear the error and retire the pill on a chat that is
  /// still parked.
  func testResumeUsageLimitNowDecodingIsTotal() throws {
    let bare = try JSONDecoder().decode(
      AgentChatResumeUsageLimitNowResult.self,
      from: Data("{}".utf8)
    )
    XCTAssertFalse(bare.ok, "an empty payload is no evidence the prompt went out")
    XCTAssertEqual(bare.refusalMessage, "This chat can\u{2019}t be resumed right now.")

    let blank = try JSONDecoder().decode(
      AgentChatResumeUsageLimitNowResult.self,
      from: Data(#"{"ok":false,"reason":"resume_in_flight","message":"   "}"#.utf8)
    )
    XCTAssertEqual(blank.refusalMessage, "This chat can\u{2019}t be resumed right now.")

    // A present field with the wrong JSON type is just as untrusted as a
    // missing field: fail closed and keep the mobile action total.
    let malformed = try JSONDecoder().decode(
      AgentChatResumeUsageLimitNowResult.self,
      from: Data(#"{"ok":"false","reason":42,"message":true,"turnId":[]}"#.utf8)
    )
    XCTAssertFalse(malformed.ok)
    XCTAssertNil(malformed.reason)
    XCTAssertNil(malformed.message)
    XCTAssertNil(malformed.turnId)
    XCTAssertEqual(malformed.refusalMessage, "This chat can\u{2019}t be resumed right now.")
  }
}
