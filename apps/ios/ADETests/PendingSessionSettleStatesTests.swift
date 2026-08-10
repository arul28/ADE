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

    // A declared settle clears ANY override host-side — including a keep-active
    // pin, so it cannot silently veto the settle — and the overlay does too.
    let overlaid = states.apply(to: session(settleOverride: "active"))
    XCTAssertEqual(overlaid.settledAt, "2026-08-10T12:00:00.000Z")
    XCTAssertNil(overlaid.settleOverride)
  }

  func testUnsettleLeavesAKeepActivePinAlone() {
    var states = PendingSessionSettleStates()
    states.begin(.unsettle(now: now), for: "session-1")

    // The host PRESERVES an `"active"` pin through an unsettle, so the overlay
    // must not claim it was cleared.
    let overlaid = states.apply(to: session(settledAt: "2026-08-10T09:00:00.000Z", settleOverride: "active"))
    XCTAssertNil(overlaid.settledAt)
    XCTAssertEqual(overlaid.settleOverride, "active")
  }

  /// A row settled purely BY a `"settled"` pin has a null `settled_at` already,
  /// so clearing the timestamp alone would show the user nothing at all. Which
  /// branch the host takes is decided by the value already in the row, so the
  /// overlay can predict it exactly.
  func testUnsettleClearsASettledPinBecauseTheHostWill() {
    var states = PendingSessionSettleStates()
    states.begin(.unsettle(now: now), for: "session-1")

    let overlaid = states.apply(to: session(settleOverride: "settled"))
    XCTAssertNil(overlaid.settleOverride)

    // And it must not resolve while that pin is still on the replicated row.
    states.prune(against: [session(settleOverride: "settled")], now: now)
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session()], now: now)
    XCTAssertNil(states["session-1"])
  }

  func testSettleResolvesOnlyOnceTheHostAlsoClearedTheOverride() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    // `sessionService.settleMany` / `settleSession` both set
    // `settle_override = null` unconditionally, so that a keep-active pin cannot
    // silently veto the settle the user asked for. A row that still carries one
    // has therefore not applied our settle yet.
    states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z", settleOverride: "active")], now: now)
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], now: now)
    XCTAssertNil(states["session-1"])
  }

  func testIntentResolvesOnTheHostsOwnTimestampNotOurs() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    // The host writes its own clock. Matching on the exact string would never
    // resolve, so presence is what the settle intent predicts.
    states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], now: now)

    XCTAssertNil(states["session-1"])
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
    let token = states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    states.clear("session-1", token: token)

    XCTAssertNil(states.apply(to: session()).settledAt)
  }

  /// Two commands for one session can overlap — tap "Keep active", then "Settle"
  /// before the first returns. The loser's failure must not retire the intent
  /// the user is now waiting on.
  func testAStaleFailureCannotRetireANewerIntent() {
    var states = PendingSessionSettleStates()
    let stale = states.begin(.settleOverride("active", now: now), for: "session-1")
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    states.clear("session-1", token: stale)

    XCTAssertEqual(states.apply(to: session()).settledAt, "2026-08-10T12:00:00.000Z")
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

  /// A settle taken offline is durably queued and can sit for minutes. Ageing
  /// it out on wall clock would snap the row back to unsettled while the
  /// command is still on its way, then settle it again when the queue drains.
  func testAQueuedSettleDoesNotExpireWhileTheHostIsUnreachable() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    var clock = now
    for _ in 0..<10 {
      clock = clock.addingTimeInterval(PendingSessionSettleStates.staleAfter)
      states.holdBackstop(now: clock)
      states.prune(against: [session(settledAt: nil)], now: clock)
    }

    XCTAssertNotNil(states["session-1"], "an unreachable host cannot confirm, so the backstop must not run")
    XCTAssertEqual(states.apply(to: session()).settledAt, "2026-08-10T12:00:00.000Z")
  }

  func testTheBackstopResumesOnceTheHostIsReachableAgain() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    // Offline for well past the budget, then reachable: the clock restarts from
    // the moment we could have been answered, not from the tap.
    let reconnectedAt = now.addingTimeInterval(600)
    states.holdBackstop(now: reconnectedAt)
    states.prune(against: [session(settledAt: nil)], now: reconnectedAt)
    XCTAssertNotNil(states["session-1"])

    let past = reconnectedAt.addingTimeInterval(PendingSessionSettleStates.staleAfter)
    states.prune(against: [session(settledAt: nil)], now: past)
    XCTAssertNil(states["session-1"])
  }

  func testPruneReportsOnlyRealResolutionsSoRepaintCannotLoop() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    // Re-stamping the offline deadline is not a resolution; reporting it as one
    // would repaint on every read forever.
    states.holdBackstop(now: now)
    XCTAssertFalse(states.prune(against: [session(settledAt: nil)], now: now))
    XCTAssertTrue(states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], now: now))
    XCTAssertFalse(states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], now: now))
  }

  func testTheNewestCommandWins() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")
    states.begin(.unsettle(now: now), for: "session-1")

    XCTAssertNil(states.apply(to: session(settledAt: "2026-08-10T09:00:00.000Z")).settledAt)
  }

  func testRemoveAllForgetsEverythingInFlight() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1")

    states.removeAll()

    XCTAssertTrue(states.isEmpty)
    XCTAssertNil(states.apply(to: session()).settledAt)
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
