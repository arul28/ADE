import XCTest

@testable import ADE

/// The phone must never write `settled_at` into its CRR replica — that write
/// replicates upstream and can settle a session the host rejected. These cover
/// the local overlay that replaced it: it has to feel like the old optimistic
/// write, and it has to stop lying the moment the host answers.
final class PendingSessionSettleStatesTests: XCTestCase {
  /// Monotonic uptime, not wall clock — the overlay measures staleness with
  /// `ProcessInfo.systemUptime` so a clock change cannot expire or freeze it.
  private let now: TimeInterval = 10_000

  private func addUptime(_ base: TimeInterval, _ delta: TimeInterval) -> TimeInterval { base + delta }

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
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    // A declared settle clears ANY override host-side — including a keep-active
    // pin, so it cannot silently veto the settle — and the overlay does too.
    let overlaid = states.apply(to: session(settleOverride: "active"))
    XCTAssertEqual(overlaid.settledAt, "2026-08-10T12:00:00.000Z")
    XCTAssertNil(overlaid.settleOverride)
  }

  func testUnsettleLeavesAKeepActivePinAlone() {
    var states = PendingSessionSettleStates()
    states.begin(.unsettle(uptime: now), for: "session-1", baseline: nil)

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
    states.begin(.unsettle(uptime: now), for: "session-1", baseline: nil)

    let overlaid = states.apply(to: session(settleOverride: "settled"))
    XCTAssertNil(overlaid.settleOverride)

    // And it must not resolve while that pin is still on the replicated row.
    states.prune(against: [session(settleOverride: "settled")], uptime: now)
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session()], uptime: now)
    XCTAssertNil(states["session-1"])
  }

  func testSettleResolvesOnlyOnceTheHostAlsoClearedTheOverride() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    // `sessionService.settleMany` / `settleSession` both set
    // `settle_override = null` unconditionally, so that a keep-active pin cannot
    // silently veto the settle the user asked for. A row that still carries one
    // has therefore not applied our settle yet.
    states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z", settleOverride: "active")], uptime: now)
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], uptime: now)
    XCTAssertNil(states["session-1"])
  }

  func testIntentResolvesOnTheHostsOwnTimestampNotOurs() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    // The host writes its own clock. Matching on the exact string would never
    // resolve, so presence is what the settle intent predicts.
    states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], uptime: now)

    XCTAssertNil(states["session-1"])
  }

  func testIntentSurvivesUntilTheHostRowActuallyChanges() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    states.prune(against: [session(settledAt: nil)], uptime: now)

    XCTAssertNotNil(states["session-1"])
    XCTAssertEqual(states.apply(to: session()).settledAt, "2026-08-10T12:00:00.000Z")
  }

  func testUnsettleIntentResolvesWhenTheRowGoesBackToNull() {
    var states = PendingSessionSettleStates()
    states.begin(.unsettle(uptime: now), for: "session-1", baseline: nil)

    states.prune(against: [session(settledAt: "2026-08-10T09:00:00.000Z")], uptime: now)
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session(settledAt: nil)], uptime: now)
    XCTAssertNil(states["session-1"])
  }

  func testOverrideIntentComparesTheExactValueWeAskedFor() {
    var states = PendingSessionSettleStates()
    states.begin(.settleOverride("active", uptime: now), for: "session-1", baseline: nil)

    // `settle_override` is a value we own, unlike the settle timestamp — a
    // different non-null value is the host disagreeing, not confirming.
    states.prune(against: [session(settleOverride: "settled")], uptime: now)
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session(settleOverride: "active")], uptime: now)
    XCTAssertNil(states["session-1"])
  }

  func testClearingAnOverrideResolvesOnNull() {
    var states = PendingSessionSettleStates()
    states.begin(.settleOverride(nil, uptime: now), for: "session-1", baseline: nil)

    XCTAssertNil(states.apply(to: session(settleOverride: "active")).settleOverride)

    states.prune(against: [session(settleOverride: nil)], uptime: now)
    XCTAssertNil(states["session-1"])
  }

  func testAFailedCommandDropsTheIntentSoTheRowSnapsBack() {
    var states = PendingSessionSettleStates()
    let token = states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    states.clear("session-1", token: token)

    XCTAssertNil(states.apply(to: session()).settledAt)
  }

  /// Two commands for one session can overlap — tap "Keep active", then "Settle"
  /// before the first returns. The loser's failure must not retire the intent
  /// the user is now waiting on.
  func testAStaleFailureCannotRetireANewerIntent() {
    var states = PendingSessionSettleStates()
    let stale = states.begin(.settleOverride("active", uptime: now), for: "session-1", baseline: nil)
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    states.clear("session-1", token: stale)

    XCTAssertEqual(states.apply(to: session()).settledAt, "2026-08-10T12:00:00.000Z")
  }

  func testAnIntentWhoseChangesetNeverArrivesExpires() {
    var states = PendingSessionSettleStates()
    let token = states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)
    states.restartBackstop(for: "session-1", token: token, uptime: now)

    let justBefore = addUptime(now, PendingSessionSettleStates.staleAfter - 1)
    states.prune(against: [session(settledAt: nil)], uptime: justBefore)
    XCTAssertNotNil(states["session-1"])

    let after = addUptime(now, PendingSessionSettleStates.staleAfter)
    states.prune(against: [session(settledAt: nil)], uptime: after)
    XCTAssertNil(states["session-1"], "a pending overlay must not outlive its round trip indefinitely")
  }

  /// A settle taken offline is durably queued and can sit for minutes. Ageing
  /// it out on wall clock would snap the row back to unsettled while the
  /// command is still on its way, then settle it again when the queue drains.
  func testAQueuedSettleDoesNotExpireWhileTheHostIsUnreachable() {
    var states = PendingSessionSettleStates()
    let token = states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)
    states.restartBackstop(for: "session-1", token: token, uptime: now)

    var clock = now
    for _ in 0..<10 {
      clock = addUptime(clock, PendingSessionSettleStates.staleAfter)
      states.holdBackstop(uptime: clock)
      states.prune(against: [session(settledAt: nil)], uptime: clock)
    }

    XCTAssertNotNil(states["session-1"], "an unreachable host cannot confirm, so the backstop must not run")
    XCTAssertEqual(states.apply(to: session()).settledAt, "2026-08-10T12:00:00.000Z")
  }

  func testTheBackstopResumesOnceTheHostIsReachableAgain() {
    var states = PendingSessionSettleStates()
    let token = states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)
    states.restartBackstop(for: "session-1", token: token, uptime: now)

    // Offline for well past the budget, then reachable: the clock restarts from
    // the moment we could have been answered, not from the tap.
    let reconnectedAt = addUptime(now, 600)
    states.holdBackstop(uptime: reconnectedAt)
    states.prune(against: [session(settledAt: nil)], uptime: reconnectedAt)
    XCTAssertNotNil(states["session-1"])

    let past = addUptime(reconnectedAt, PendingSessionSettleStates.staleAfter)
    states.prune(against: [session(settledAt: nil)], uptime: past)
    XCTAssertNil(states["session-1"])
  }

  func testPruneReportsOnlyRealResolutionsSoRepaintCannotLoop() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    // Re-stamping the offline deadline is not a resolution; reporting it as one
    // would repaint on every read forever.
    states.holdBackstop(uptime: now)
    XCTAssertFalse(states.prune(against: [session(settledAt: nil)], uptime: now))
    XCTAssertTrue(states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], uptime: now))
    XCTAssertFalse(states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], uptime: now))
  }

  func testTheNewestCommandWins() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)
    states.begin(.unsettle(uptime: now), for: "session-1", baseline: nil)

    XCTAssertNil(states.apply(to: session(settledAt: "2026-08-10T09:00:00.000Z")).settledAt)
  }

  /// Two lifecycle commands can overlap: the settle overlay makes the row read
  /// as settled, so the menu offers Unsettle, and the user can tap it before the
  /// settle has landed. The newer intent's target value is exactly what the
  /// stale row still holds, so confirming on value equality alone would retire
  /// it immediately — and the first command's changeset would then paint the row
  /// settled while the user's later unsettle was still in flight.
  func testAReplacementIntentSurvivesUntilTheRowActuallyMoves() {
    var states = PendingSessionSettleStates()
    let unsettled = session()
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: unsettled)
    let token = states.begin(.unsettle(uptime: now), for: "session-1", baseline: unsettled)
    states.restartBackstop(for: "session-1", token: token, uptime: now)

    // The row has not moved yet — `settled_at` is still nil, which is also what
    // the unsettle wants. It must NOT count as confirmation.
    states.prune(against: [unsettled], uptime: now)
    XCTAssertNotNil(states["session-1"])

    // The first command lands. Still not our intent, so the overlay holds and
    // keeps showing the row as the user last asked for it.
    let settledByFirstCommand = session(settledAt: "2026-08-10T12:00:00.417Z")
    states.prune(against: [settledByFirstCommand], uptime: now)
    XCTAssertNotNil(states["session-1"])
    XCTAssertNil(states.apply(to: settledByFirstCommand).settledAt)

    // It is NOT confirmable by movement either: with two commands outstanding a
    // row change cannot be attributed to one of them. It holds what the user
    // last asked for and yields at the backstop, by which point the run has
    // converged.
    states.prune(against: [unsettled], uptime: now)
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [unsettled], uptime: addUptime(now, PendingSessionSettleStates.staleAfter))
    XCTAssertNil(states["session-1"])
  }

  /// `settle → unsettle → settle` before anything replicates. The first
  /// settle's changeset both moves the row off the third command's baseline and
  /// matches it, so confirming on movement would retire the overlay against the
  /// WRONG command — and the row would then flip when the intervening unsettle
  /// replicated.
  func testAThirdOverlappingCommandIsNotConfirmedByAnEarlierOnesChangeset() {
    var states = PendingSessionSettleStates()
    let unsettled = session()
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: unsettled)
    states.begin(.unsettle(uptime: now), for: "session-1", baseline: unsettled)
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:02.000Z"), for: "session-1", baseline: unsettled)

    // The FIRST settle replicates. It matches the third intent by value, and it
    // moved the row — but it is not the third command.
    states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], uptime: now)

    XCTAssertNotNil(states["session-1"], "an earlier command's changeset must not confirm the latest one")
  }

  /// A keep-active pin plus an overlapping pair of commands. Host-side the
  /// settle clears the pin and the unsettle then preserves whatever is left, so
  /// the run ends with no override. Reading the stale row here would resurrect
  /// the pin and offer the wrong actions until replication caught up.
  func testUnsettleAfterAnUnlandedSettleDoesNotResurrectAKeepActivePin() {
    var states = PendingSessionSettleStates()
    let pinned = session(settleOverride: "active")
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: pinned)
    states.begin(.unsettle(uptime: now), for: "session-1", baseline: pinned)

    let overlaid = states.apply(to: pinned)
    XCTAssertNil(overlaid.settledAt)
    XCTAssertNil(overlaid.settleOverride, "the settle the user already issued clears the pin host-side")
  }

  /// The same branch with no overlapping command: a pin the host really will
  /// preserve must still be shown.
  func testAStandaloneUnsettleStillPreservesAKeepActivePin() {
    var states = PendingSessionSettleStates()
    let pinned = session(settledAt: "2026-08-10T09:00:00.000Z", settleOverride: "active")
    states.begin(.unsettle(uptime: now), for: "session-1", baseline: pinned)

    XCTAssertEqual(states.apply(to: pinned).settleOverride, "active")
  }

  /// The request may legitimately run longer than `staleAfter`, so the window
  /// has to measure the wait for the CHANGESET, not the round trip.
  func testAnAnsweredCommandRestartsItsWindow() {
    var states = PendingSessionSettleStates()
    let token = states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    let answeredAt = addUptime(now, PendingSessionSettleStates.staleAfter - 1)
    states.restartBackstop(for: "session-1", token: token, uptime: answeredAt)

    // Past the original deadline but inside the restarted one.
    states.prune(against: [session()], uptime: addUptime(now, PendingSessionSettleStates.staleAfter + 1))
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session()], uptime: addUptime(answeredAt, PendingSessionSettleStates.staleAfter))
    XCTAssertNil(states["session-1"])
  }

  /// The sweep armed when the command was sent must not remove an intent whose
  /// request is still outstanding — restarting the window afterwards cannot
  /// bring back an intent that is already gone.
  func testAnOutstandingRequestCannotBeExpiredBySweepOrPrune() {
    var states = PendingSessionSettleStates()
    let token = states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    // Well past the deadline, but the request has not answered yet.
    states.prune(against: [session()], uptime: addUptime(now, PendingSessionSettleStates.staleAfter * 3))
    XCTAssertNotNil(states["session-1"])

    let answeredAt = addUptime(now, PendingSessionSettleStates.staleAfter * 3)
    states.restartBackstop(for: "session-1", token: token, uptime: answeredAt)

    states.prune(against: [session()], uptime: addUptime(answeredAt, 1))
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session()], uptime: addUptime(answeredAt, PendingSessionSettleStates.staleAfter))
    XCTAssertNil(states["session-1"], "once answered, the window applies normally")
  }

  /// The `queued` sentinel is durable acceptance by this device, not an answer
  /// from the host. Treating it as answered would start a window that can expire
  /// while the reconnect replay — with its own longer timeout — is still running.
  func testAQueuedCommandStaysOutstandingUntilTheReplayAnswers() {
    var states = PendingSessionSettleStates()
    let token = states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)
    states.attachQueuedOperation("op-1", for: "session-1", token: token)

    // Queued: no `restartBackstop`. Far past the window, it must survive.
    states.prune(against: [session()], uptime: addUptime(now, PendingSessionSettleStates.staleAfter * 5))
    XCTAssertNotNil(states["session-1"])

    let replayedAt = addUptime(now, PendingSessionSettleStates.staleAfter * 5)
    states.markAnswered(forOperation: "op-1", uptime: replayedAt)

    states.prune(against: [session()], uptime: addUptime(replayedAt, 1))
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session()], uptime: addUptime(replayedAt, PendingSessionSettleStates.staleAfter))
    XCTAssertNil(states["session-1"])
  }

  /// Two commands for one session queued together drain in append order. The
  /// first replay's completion must not resolve the second's intent — that
  /// would start its window before its own replay had even begun.
  func testAReplayResolvesOnlyItsOwnQueuedIntent() {
    var states = PendingSessionSettleStates()
    let first = states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)
    states.attachQueuedOperation("op-first", for: "session-1", token: first)
    let second = states.begin(.unsettle(uptime: now), for: "session-1", baseline: nil)
    states.attachQueuedOperation("op-second", for: "session-1", token: second)

    states.markAnswered(forOperation: "op-first", uptime: now)

    // Still the first operation's id on record? No — the live intent is the
    // second, and it has not been replayed, so it stays outstanding.
    states.prune(against: [session()], uptime: addUptime(now, PendingSessionSettleStates.staleAfter * 3))
    XCTAssertNotNil(states["session-1"])
  }

  /// A replay the host refuses must retire its intent. Leaving it outstanding
  /// would paint a refused state indefinitely, since an outstanding intent
  /// deliberately cannot expire.
  func testATerminallyRejectedReplayRetiresItsIntent() {
    var states = PendingSessionSettleStates()
    let token = states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)
    states.attachQueuedOperation("op-1", for: "session-1", token: token)

    XCTAssertTrue(states.clear(forOperation: "op-1"))
    XCTAssertNil(states["session-1"])
    XCTAssertFalse(states.clear(forOperation: "op-1"))
  }

  func testASlowCommandCannotExtendAnIntentTheUserReplaced() {
    var states = PendingSessionSettleStates()
    let stale = states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)
    let current = states.begin(.unsettle(uptime: now), for: "session-1", baseline: nil)
    states.restartBackstop(for: "session-1", token: current, uptime: now)

    // The replaced command answers late; it must not push the newer intent's
    // deadline out.
    states.restartBackstop(for: "session-1", token: stale, uptime: addUptime(now, 100))

    states.prune(against: [session()], uptime: addUptime(now, PendingSessionSettleStates.staleAfter))
    XCTAssertNil(states["session-1"], "the replaced command's answer must not extend the newer intent")
  }

  func testAnUnknownBaselineFallsBackToValueEquality() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], uptime: now)

    XCTAssertNil(states["session-1"], "with no baseline the value match is all we have")
  }

  func testRemoveAllForgetsEverythingInFlight() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    states.removeAll()

    XCTAssertTrue(states.isEmpty)
    XCTAssertNil(states.apply(to: session()).settledAt)
  }

  func testASessionMissingFromAScopedReadKeepsItsIntent() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    // A partial or differently-scoped read is not the host disagreeing.
    states.prune(against: [session(id: "session-2", settledAt: nil)], uptime: now)

    XCTAssertNotNil(states["session-1"])
  }

  func testOverlayOnlyTouchesTheSessionItWasBegunFor() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(uptime: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    let others = states.apply(to: [session(id: "session-1"), session(id: "session-2")])

    XCTAssertEqual(others[0].settledAt, "2026-08-10T12:00:00.000Z")
    XCTAssertNil(others[1].settledAt)
  }
}

/// The overlay type is exhaustively covered above, but the defect that actually
/// shipped was in the WIRING: a reader that went to the database instead of the
/// read chokepoint, so a settle the user had just tapped stayed visible as a
/// live agent on the widget, the Live Activity, and the Activity drawer. These
/// pin the chokepoint itself.
final class PendingSessionSettleOverlayWiringTests: XCTestCase {
  private func makeLane(id: String) -> LaneSummary {
    LaneSummary(
      id: id, name: "Lane", description: nil, laneType: "worktree", baseRef: "main",
      branchRef: "feature/\(id)", worktreePath: "/tmp/\(id)", attachedRootPath: nil,
      parentLaneId: nil, childCount: 0, stackDepth: 0, parentStatus: nil, isEditProtected: false,
      status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
      color: nil, icon: nil, tags: [], folder: nil, linearIssue: nil, linearIssueLinks: nil,
      createdAt: "", archivedAt: nil, devicesOpen: nil
    )
  }

  private func makeSession(id: String, laneId: String) -> TerminalSessionSummary {
    TerminalSessionSummary(
      id: id,
      laneId: laneId,
      laneName: "Lane",
      ptyId: nil,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: nil,
      toolType: "codex-chat",
      title: "Chat",
      status: "running",
      startedAt: "2026-08-10T00:00:00.000Z",
      endedAt: nil,
      archivedAt: nil,
      exitCode: nil,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: nil,
      summary: nil,
      // At rest between turns — the state a user actually settles from. A
      // declared settle is honored only at rest (`WorkSessionCanonicalState`),
      // so a mid-stream chat deliberately stays on the roster.
      runtimeState: "idle",
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: nil,
      chatSessionId: nil,
      pendingInputItemId: nil
    )
  }

  @MainActor
  private func withService(
    _ body: (SyncService, DatabaseService) async throws -> Void
  ) async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }
    try database.executeSqlForTesting("""
      insert into projects (id, root_path, display_name, default_base_ref, created_at, last_opened_at) values
      ('project-1', '/tmp/p1', 'P1', 'main', '2026-08-10T00:00:00.000Z', '2026-08-10T00:00:00.000Z');
    """)
    database.setActiveProjectId("project-1")
    try database.replaceLaneSnapshots([makeLane(id: "lane-1")])
    try database.replaceTerminalSessions([makeSession(id: "session-1", laneId: "lane-1")])
    try await body(service, database)
  }

  @MainActor
  func testFetchSessionsAppliesTheOverlayWhileTheDatabaseStaysUntouched() async throws {
    try await withService { service, database in
      service.beginPendingSessionSettleForTesting(
        .settle(uptime: ProcessInfo.processInfo.systemUptime, timestamp: "2026-08-10T12:00:00.000Z"),
        for: "session-1"
      )

      let overlaid = try await service.fetchSessions().first { $0.id == "session-1" }
      XCTAssertEqual(overlaid?.settledAt, "2026-08-10T12:00:00.000Z")

      // The whole point of the overlay: nothing was written, so nothing can
      // replicate upstream and defeat a host rejection by CRDT merge.
      XCTAssertNil(database.fetchSession(id: "session-1")?.settledAt)
    }
  }

  @MainActor
  func testFetchSessionByIdGoesThroughTheSameChokepoint() async throws {
    try await withService { service, _ in
      service.beginPendingSessionSettleForTesting(
        .settle(uptime: ProcessInfo.processInfo.systemUptime, timestamp: "2026-08-10T12:00:00.000Z"),
        for: "session-1"
      )

      let single = try await service.fetchSession(id: "session-1")
      XCTAssertEqual(single?.settledAt, "2026-08-10T12:00:00.000Z")
    }
  }

  /// The regression: `refreshActiveSessionsAndSnapshot` read the database
  /// directly, so a just-settled chat stayed in `activeSessions` — which backs
  /// the lock-screen widget, the Live Activity, and the in-app Activity drawer.
  @MainActor
  func testASettledChatLeavesTheWidgetAndActivityRosterImmediately() async throws {
    try await withService { service, _ in
      service.refreshActiveSessionsAndSnapshot()
      XCTAssertTrue(
        service.activeSessions.contains { $0.sessionId == "session-1" },
        "precondition: a running chat is on the active roster"
      )

      service.beginPendingSessionSettleForTesting(
        .settle(uptime: ProcessInfo.processInfo.systemUptime, timestamp: "2026-08-10T12:00:00.000Z"),
        for: "session-1"
      )
      service.refreshActiveSessionsAndSnapshot()

      XCTAssertFalse(
        service.activeSessions.contains { $0.sessionId == "session-1" },
        "a settle the user just tapped must not keep reporting as a live agent"
      )
    }
  }
}
