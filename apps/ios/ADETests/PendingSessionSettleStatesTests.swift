import XCTest

@testable import ADE

/// The phone must never write `settled_at` into its CRR replica — that write
/// replicates upstream and can settle a session the host rejected. These cover
/// the local overlay that replaced it: it has to feel like the old optimistic
/// write, and it has to stop lying the moment the host answers.
final class PendingSessionSettleStatesTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_760_000_000)

  private func session(
    id: String = "session-1",
    settledAt: String? = nil,
    settleOverride: String? = nil
  ) -> TerminalSessionSummary {
    var summary = TerminalSessionSummary(
      id: id,
      laneId: "lane-1",
      laneName: "Lane",
      ptyId: nil,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: nil,
      toolType: "claude-chat",
      title: "Session",
      status: "running",
      startedAt: "2026-08-10T00:00:00.000Z",
      endedAt: nil,
      exitCode: nil,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: nil,
      summary: nil,
      runtimeState: "idle",
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: nil
    )
    summary.settledAt = settledAt
    summary.settleOverride = settleOverride
    return summary
  }

  func testSettleIntentShowsTheRowSettledBeforeTheHostAnswers() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    let overlaid = states.apply(to: session())
    XCTAssertEqual(overlaid.settledAt, "2026-08-10T12:00:00.000Z")
    // A declared settle clears a `"settled"` pin host-side, so the overlay
    // shows that too.
    XCTAssertNil(overlaid.settleOverride)
  }

  func testUnsettleIntentLeavesTheOverrideToTheHost() {
    var states = PendingSessionSettleStates()
    states.begin(.unsettle(now: now), for: "session-1")

    // The host clears a `"settled"` override but PRESERVES an `"active"` pin,
    // and the phone cannot know which branch it takes — so the overlay must not
    // claim either.
    let overlaid = states.apply(to: session(settledAt: "2026-08-10T09:00:00.000Z", settleOverride: "active"))
    XCTAssertNil(overlaid.settledAt)
    XCTAssertEqual(overlaid.settleOverride, "active")
  }

  func testIntentResolvesOnTheHostsOwnTimestampNotOurs() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    // The host writes its own clock. Matching on the exact string would never
    // resolve, so presence is what the settle intent predicts.
    states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], now: now)

    XCTAssertNil(states["session-1"])
    XCTAssertTrue(states.isEmpty)
  }

  func testIntentSurvivesUntilTheHostRowActuallyChanges() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    states.prune(against: [session(settledAt: nil)], now: now)

    XCTAssertNotNil(states["session-1"])
    XCTAssertEqual(states.apply(to: session()).settledAt, "2026-08-10T12:00:00.000Z")
  }

  func testUnsettleIntentResolvesWhenTheRowGoesBackToNull() {
    var states = PendingSessionSettleStates()
    states.begin(.unsettle(now: now), for: "session-1")

    states.prune(against: [session(settledAt: "2026-08-10T09:00:00.000Z")], now: now)
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session(settledAt: nil)], now: now)
    XCTAssertNil(states["session-1"])
  }

  func testOverrideIntentComparesTheExactValueWeAskedFor() {
    var states = PendingSessionSettleStates()
    states.begin(.settleOverride("active", now: now), for: "session-1")

    // `settle_override` is a value we own, unlike the settle timestamp — a
    // different non-null value is the host disagreeing, not confirming.
    states.prune(against: [session(settleOverride: "settled")], now: now)
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session(settleOverride: "active")], now: now)
    XCTAssertNil(states["session-1"])
  }

  func testClearingAnOverrideResolvesOnNull() {
    var states = PendingSessionSettleStates()
    states.begin(.settleOverride(nil, now: now), for: "session-1")

    XCTAssertNil(states.apply(to: session(settleOverride: "active")).settleOverride)

    states.prune(against: [session(settleOverride: nil)], now: now)
    XCTAssertNil(states["session-1"])
  }

  func testAFailedCommandDropsTheIntentSoTheRowSnapsBack() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    states.clear("session-1")

    XCTAssertNil(states.apply(to: session()).settledAt)
  }

  func testAnIntentWhoseChangesetNeverArrivesExpires() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    let justBefore = now.addingTimeInterval(PendingSessionSettleStates.staleAfter - 1)
    states.prune(against: [session(settledAt: nil)], now: justBefore)
    XCTAssertNotNil(states["session-1"])

    let after = now.addingTimeInterval(PendingSessionSettleStates.staleAfter)
    states.prune(against: [session(settledAt: nil)], now: after)
    XCTAssertNil(states["session-1"], "a pending overlay must not outlive its round trip indefinitely")
  }

  func testASessionMissingFromAScopedReadKeepsItsIntent() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    // A partial or differently-scoped read is not the host disagreeing.
    states.prune(against: [session(id: "session-2", settledAt: nil)], now: now)

    XCTAssertNotNil(states["session-1"])
  }

  func testOverlayOnlyTouchesTheSessionItWasBegunFor() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    let others = states.apply(to: [session(id: "session-1"), session(id: "session-2")])

    XCTAssertEqual(others[0].settledAt, "2026-08-10T12:00:00.000Z")
    XCTAssertNil(others[1].settledAt)
  }
}
