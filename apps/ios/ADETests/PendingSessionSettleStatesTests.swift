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

  // MARK: - The one backstop sweeper, serving both overlays

  /// The settle and attention-clear sweepers were verbatim copies, and the copy
  /// had already drifted. One sweeper now serves both kinds, so the first thing
  /// to pin is that unifying the CODE did not unify the WINDOWS: each kind still
  /// waits its own `staleAfter`, and the attention clear's is deliberately much
  /// shorter because its failure mode is a hidden ask rather than a stale chip.
  @MainActor
  func testTheSharedSweeperKeepsEachOverlaysOwnWindow() {
    let slack: UInt64 = 250_000_000
    XCTAssertEqual(
      SyncService.sessionOverlayBackstopDelayNanosecondsForTesting("settle"),
      UInt64(PendingSessionSettleStates.staleAfter * 1_000_000_000) + slack
    )
    XCTAssertEqual(
      SyncService.sessionOverlayBackstopDelayNanosecondsForTesting("attentionClear"),
      UInt64(PendingAttentionClearStates.staleAfter * 1_000_000_000) + slack
    )
    XCTAssertNotEqual(
      SyncService.sessionOverlayBackstopDelayNanosecondsForTesting("settle"),
      SyncService.sessionOverlayBackstopDelayNanosecondsForTesting("attentionClear"),
      "one sweeper, two windows — a shared delay would be the drift this fixed"
    )
    XCTAssertNil(SyncService.sessionOverlayBackstopDelayNanosecondsForTesting("nonsense"))
  }

  /// Each overlay arms and disarms its own timer, and — the asymmetry the copy
  /// introduced — BOTH resets now cancel. The settle reset used to leave its
  /// sweeper armed over a map it had just emptied, so the timer woke, took a
  /// session read nobody asked for (against a host that, on the unpair path, is
  /// gone) and only then stood down.
  @MainActor
  func testEachResetStandsItsOwnBackstopDown() async throws {
    try await withService { service, database in
      var asking = makeSession(id: "session-2", laneId: "lane-1")
      asking.pendingInputItemId = "item-1"
      try database.replaceTerminalSessions([
        makeSession(id: "session-1", laneId: "lane-1"),
        asking,
      ])

      XCTAssertTrue(service.armedSessionOverlayBackstopKindsForTesting.isEmpty)

      service.beginPendingSessionSettleForTesting(
        .settle(uptime: ProcessInfo.processInfo.systemUptime, timestamp: "2026-08-10T12:00:00.000Z"),
        for: "session-1"
      )
      XCTAssertEqual(
        service.armedSessionOverlayBackstopKindsForTesting,
        ["settle"],
        "a settle must not arm the attention-clear sweeper"
      )

      XCTAssertTrue(service.beginPendingAttentionClearForTesting(for: "session-2"))
      XCTAssertEqual(
        service.armedSessionOverlayBackstopKindsForTesting,
        ["settle", "attentionClear"]
      )

      service.resetSessionOverlaysForTesting()
      XCTAssertTrue(
        service.armedSessionOverlayBackstopKindsForTesting.isEmpty,
        "both resets cancel; neither leaves a sweeper running over an empty map"
      )
    }
  }
}

/// U9, the phone half: a Work row that keeps saying "Needs you" after the user
/// has already answered.
///
/// The host clears the attention columns when a card settles, but that clear
/// rides the CRDT changeset, and the `pending_input_resolved` / `user_message`
/// chat event reaches the phone first. `PendingAttentionClearStates` bridges
/// that window — and the tests that matter most here are the ones pinning what
/// the bridge must NEVER do: hide a real ask, or treat the host talking on the
/// agent's behalf as a human answering.
final class PendingAttentionClearStatesTests: XCTestCase {
  /// Monotonic uptime, not wall clock — same reasoning as the settle overlay.
  private let now: TimeInterval = 20_000

  private func session(
    id: String = "session-1",
    pendingInputItemId: String? = nil,
    attentionRequestedAt: String? = nil,
    attentionSource: String? = nil
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
    summary.pendingInputItemId = pendingInputItemId
    summary.attentionRequestedAt = attentionRequestedAt
    summary.attentionSource = attentionSource
    return summary
  }

  func testOverlayHidesTheAskTheUserJustAnswered() {
    var states = PendingAttentionClearStates()
    let asking = session(pendingInputItemId: "item-1", attentionRequestedAt: "2026-08-10T12:00:00.000Z")
    states.begin(for: "session-1", baseline: asking, uptime: now)

    let overlaid = states.apply(to: asking)

    XCTAssertNil(overlaid.pendingInputItemId)
    XCTAssertNil(overlaid.attentionRequestedAt)
    XCTAssertNil(overlaid.attentionSource)
  }

  /// The failure mode this whole design is shaped around. An agent that raises
  /// its hand again the instant the user replies is normal and important, and a
  /// local guess from a moment ago must never outvote it.
  func testANewAskFromTheHostIsNeverSuppressed() {
    var states = PendingAttentionClearStates()
    states.begin(
      for: "session-1",
      baseline: session(pendingInputItemId: "item-1", attentionRequestedAt: "2026-08-10T12:00:00.000Z"),
      uptime: now
    )

    // The agent asks again: a fresh itemId, a fresh attention stamp.
    let reAsked = session(pendingInputItemId: "item-2", attentionRequestedAt: "2026-08-10T12:00:01.000Z")

    XCTAssertEqual(
      states.apply(to: reAsked).pendingInputItemId,
      "item-2",
      "a newer host ask outranks an older local guess"
    )
    XCTAssertEqual(states.apply(to: reAsked).attentionRequestedAt, "2026-08-10T12:00:01.000Z")
  }

  /// Even a partial move — the host clearing the item but leaving the escalated
  /// attention stamp, or the reverse — takes the overlay out of the picture. The
  /// key is the whole attention row, not one column of it.
  func testAnyMovementInTheAttentionRowMakesTheOverlayInert() {
    var states = PendingAttentionClearStates()
    states.begin(
      for: "session-1",
      baseline: session(pendingInputItemId: "item-1", attentionRequestedAt: "2026-08-10T12:00:00.000Z"),
      uptime: now
    )

    let partiallyMoved = session(pendingInputItemId: nil, attentionRequestedAt: "2026-08-10T12:00:00.000Z")

    XCTAssertEqual(states.apply(to: partiallyMoved).attentionRequestedAt, "2026-08-10T12:00:00.000Z")
  }

  func testAHostChangesetRetiresTheOverlay() {
    var states = PendingAttentionClearStates()
    states.begin(for: "session-1", baseline: session(pendingInputItemId: "item-1"), uptime: now)

    // The host's clear lands — exactly what the overlay was predicting.
    XCTAssertTrue(states.prune(against: [session(pendingInputItemId: nil)], uptime: now))

    XCTAssertTrue(
      states.isEmpty,
      "a local guess must not outlive the host state it was guessing at"
    )
  }

  /// The re-ask, end to end through the overlay's own lifecycle: the guess is
  /// retired by the changeset that carries the new ask, so nothing is left that
  /// a later identical-looking row could re-activate.
  func testTheReAskChangesetRetiresTheOverlayToo() {
    var states = PendingAttentionClearStates()
    states.begin(for: "session-1", baseline: session(pendingInputItemId: "item-1"), uptime: now)

    XCTAssertTrue(states.prune(against: [session(pendingInputItemId: "item-2")], uptime: now))
    XCTAssertTrue(states.isEmpty)
  }

  func testACalmRowRecordsNoOverlay() {
    var states = PendingAttentionClearStates()

    XCTAssertEqual(states.begin(for: "session-1", baseline: session(), uptime: now), 0)
    XCTAssertTrue(
      states.isEmpty,
      "an overlay over a calm row is a suppression lying in wait for the next real ask"
    )
  }

  /// A provider's structured input raises needs-you through `attention_source`
  /// alone, so that column has to count as an ask in its own right.
  func testProviderStructuredAttentionCountsAsAnAsk() {
    var states = PendingAttentionClearStates()
    let asking = session(attentionSource: "provider_structured")

    XCTAssertNotEqual(states.begin(for: "session-1", baseline: asking, uptime: now), 0)
    XCTAssertNil(states.apply(to: asking).attentionSource)
  }

  func testTheOverlayExpiresAtTheBackstop() {
    var states = PendingAttentionClearStates()
    states.begin(for: "session-1", baseline: session(pendingInputItemId: "item-1"), uptime: now)

    // The confirming changeset never arrives. A suppression must lapse rather
    // than paint a calm row indefinitely.
    XCTAssertTrue(states.prune(against: [], uptime: now + PendingAttentionClearStates.staleAfter + 1))
    XCTAssertTrue(states.isEmpty)
  }

  func testOverlayOnlyTouchesTheSessionItWasBegunFor() {
    var states = PendingAttentionClearStates()
    states.begin(for: "session-1", baseline: session(pendingInputItemId: "item-1"), uptime: now)

    let rows = states.apply(to: [
      session(id: "session-1", pendingInputItemId: "item-1"),
      session(id: "session-2", pendingInputItemId: "item-1"),
    ])

    XCTAssertNil(rows[0].pendingInputItemId)
    XCTAssertEqual(rows[1].pendingInputItemId, "item-1")
  }

  func testRemoveAllForgetsEverythingInFlight() {
    var states = PendingAttentionClearStates()
    states.begin(for: "session-1", baseline: session(pendingInputItemId: "item-1"), uptime: now)

    states.removeAll()

    XCTAssertTrue(states.isEmpty)
    XCTAssertEqual(states.apply(to: session(pendingInputItemId: "item-1")).pendingInputItemId, "item-1")
  }
}

/// The wiring half: the chat event has to reach both halves of the local
/// attention state — the cached chat summary AND the session row's overlay —
/// and it has to refuse to do so for a message the host authored itself.
final class PendingAttentionClearWiringTests: XCTestCase {
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

  private func makeSession(
    id: String = "session-1",
    pendingInputItemId: String?
  ) -> TerminalSessionSummary {
    TerminalSessionSummary(
      id: id,
      laneId: "lane-1",
      laneName: "Lane",
      ptyId: nil,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: nil,
      toolType: "claude-chat",
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
      runtimeState: "idle",
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: nil,
      chatSessionId: nil,
      pendingInputItemId: pendingInputItemId
    )
  }

  private func makeChatSummary(
    awaitingInput: Bool?,
    pendingInputItemId: String?
  ) -> AgentChatSessionSummary {
    AgentChatSessionSummary(
      sessionId: "session-1",
      laneId: "lane-1",
      provider: "claude",
      model: "opus",
      modelId: nil,
      sessionProfile: nil,
      title: nil,
      goal: nil,
      reasoningEffort: nil,
      codexFastMode: nil,
      fastMode: nil,
      executionMode: nil,
      permissionMode: nil,
      interactionMode: nil,
      claudePermissionMode: nil,
      codexApprovalPolicy: nil,
      codexSandbox: nil,
      codexConfigSource: nil,
      opencodePermissionMode: nil,
      droidPermissionMode: nil,
      cursorModeSnapshot: nil,
      cursorModeId: nil,
      cursorConfigValues: nil,
      identityKey: nil,
      surface: nil,
      automationId: nil,
      automationRunId: nil,
      capabilityMode: nil,
      computerUse: nil,
      completion: nil,
      status: "running",
      idleSinceAt: nil,
      startedAt: "2026-08-10T00:00:00.000Z",
      endedAt: nil,
      archivedAt: nil,
      lastActivityAt: "2026-08-10T00:00:00.000Z",
      lastOutputPreview: nil,
      summary: nil,
      awaitingInput: awaitingInput,
      pendingInputItemId: pendingInputItemId,
      threadId: nil,
      requestedCwd: nil
    )
  }

  private func envelope(_ event: AgentChatEvent) -> AgentChatEventEnvelope {
    AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-08-10T12:00:00.000Z",
      event: event,
      sequence: 1
    )
  }

  private func rawPayload(_ event: [String: Any]) -> [String: Any] {
    ["sessionId": "session-1", "event": event]
  }

  @MainActor
  private func withService(
    pendingInputItemId: String? = "item-1",
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
    try database.replaceTerminalSessions([makeSession(pendingInputItemId: pendingInputItemId)])
    service.cacheChatSummary(makeChatSummary(awaitingInput: true, pendingInputItemId: pendingInputItemId))
    try await body(service, database)
  }

  @MainActor
  func testPendingInputResolvedClearsTheCachedAttentionFlags() async throws {
    try await withService { service, _ in
      service.applyChatAttentionResolutionIfNeeded(
        envelope: envelope(.pendingInputResolved(itemId: "item-1", resolution: "accepted", turnId: "turn-1")),
        rawPayload: rawPayload([
          "type": "pending_input_resolved",
          "itemId": "item-1",
          "resolution": "accepted",
        ])
      )

      XCTAssertEqual(service.chatSummaryCache["session-1"]?.awaitingInput, false)
      XCTAssertNil(service.chatSummaryCache["session-1"]?.pendingInputItemId)
    }
  }

  @MainActor
  func testAHumanUserMessageClearsTheCachedAttentionFlags() async throws {
    try await withService { service, _ in
      service.applyChatAttentionResolutionIfNeeded(
        envelope: envelope(.userMessage(
          text: "yes, go ahead",
          attachments: nil,
          turnId: "turn-1",
          steerId: nil,
          deliveryState: nil,
          processed: nil
        )),
        rawPayload: rawPayload(["type": "user_message", "text": "yes, go ahead"])
      )

      XCTAssertEqual(service.chatSummaryCache["session-1"]?.awaitingInput, false)
      XCTAssertNil(service.chatSummaryCache["session-1"]?.pendingInputItemId)

      // And the row itself reads calm through the chokepoint, without the
      // database having been touched — the overlay never replicates.
      let overlaid = try await service.fetchSession(id: "session-1")
      XCTAssertNil(overlaid?.pendingInputItemId)
    }
  }

  /// A scheduled wake, a child's completion report, a sibling's relay: the host
  /// delivers all of them as `user_message`. None is a human answering, and
  /// treating one as an answer would mask a genuine "Needs you".
  @MainActor
  func testAHostAuthoredMessageLeavesTheAttentionAlone() async throws {
    try await withService { service, _ in
      service.applyChatAttentionResolutionIfNeeded(
        envelope: envelope(.userMessage(
          text: "Scheduled wake: continue the migration.",
          attachments: nil,
          turnId: "turn-2",
          steerId: nil,
          deliveryState: nil,
          processed: nil
        )),
        rawPayload: rawPayload([
          "type": "user_message",
          "text": "Scheduled wake: continue the migration.",
          "metadata": [
            "scheduledWake": [
              "scheduleId": "sched-1",
              "kind": "wakeup",
              "firedAt": "2026-08-10T12:00:00.000Z",
            ],
          ],
        ])
      )

      XCTAssertEqual(service.chatSummaryCache["session-1"]?.awaitingInput, true)
      XCTAssertEqual(service.chatSummaryCache["session-1"]?.pendingInputItemId, "item-1")

      let row = try await service.fetchSession(id: "session-1")
      XCTAssertEqual(row?.pendingInputItemId, "item-1", "a host-authored message must not clear a real ask")
    }
  }

  /// Dragging a card into "Needs you" is the one board move the host refuses to
  /// clear attention for. Its message rides the wire as a `user_message`, so the
  /// phone must read it as host-authored or it masks the row the user just
  /// parked for the whole life of the overlay.
  @MainActor
  func testABoardMoveIntoNeedsYouLeavesTheAttentionAlone() async throws {
    try await withService { service, _ in
      service.applyChatAttentionResolutionIfNeeded(
        envelope: envelope(.userMessage(
          text: "Moved to Needs you.",
          attachments: nil,
          turnId: "turn-2",
          steerId: nil,
          deliveryState: nil,
          processed: nil
        )),
        rawPayload: rawPayload([
          "type": "user_message",
          "text": "Moved to Needs you.",
          "metadata": [
            "boardMove": [
              "from": "working",
              "to": "needs_you",
            ],
          ],
        ])
      )

      XCTAssertEqual(service.chatSummaryCache["session-1"]?.awaitingInput, true)
      XCTAssertEqual(service.chatSummaryCache["session-1"]?.pendingInputItemId, "item-1")

      let row = try await service.fetchSession(id: "session-1")
      XCTAssertEqual(row?.pendingInputItemId, "item-1", "a board move must not clear the attention it just raised")
    }
  }

  @MainActor
  func testEveryHostAuthoredMarkerIsRecognised() async throws {
    try await withService { service, _ in
      for key in ["scheduledWake", "spawnCompletion", "spawnDispatch", "agentRelay", "hostContinuation", "boardMove"] {
        XCTAssertTrue(
          service.isHostAuthoredChatMessagePayload(rawPayload([
            "type": "user_message",
            "text": "…",
            "metadata": [key: ["any": "value"]],
          ])),
          "\(key) marks a message the host authored on the agent's behalf"
        )
      }
      XCTAssertFalse(
        service.isHostAuthoredChatMessagePayload(rawPayload([
          "type": "user_message",
          "text": "…",
          // Provenance on a "Run next" replay of the USER's own message — still
          // a human answering, so it must not be excluded.
          "metadata": ["replayedFromUnprocessedSteer": ["action": "run_next"]],
        ]))
      )
    }
  }

  /// The sequence the overlay exists to survive: the user answers, the row goes
  /// calm immediately, and the agent raises its hand again before the first
  /// clear has even replicated. The row must come back to "Needs you".
  @MainActor
  func testTheRowReturnsToNeedsYouWhenTheAgentImmediatelyAsksAgain() async throws {
    try await withService { service, database in
      service.applyChatAttentionResolutionIfNeeded(
        envelope: envelope(.pendingInputResolved(itemId: "item-1", resolution: "accepted", turnId: "turn-1")),
        rawPayload: rawPayload(["type": "pending_input_resolved", "itemId": "item-1", "resolution": "accepted"])
      )

      // `XCTUnwrap` takes an autoclosure, which cannot carry an `await`.
      let answeredRow = try await service.fetchSession(id: "session-1")
      let answered = try XCTUnwrap(answeredRow)
      XCTAssertNil(answered.pendingInputItemId)
      XCTAssertNotEqual(
        workCanonicalSessionState(session: answered, summary: service.chatSummaryCache["session-1"]).phase,
        .needsYou,
        "the row leaves Needs you on the answer, not one changeset later"
      )

      // The agent asks again, and the host's changeset lands.
      try database.replaceTerminalSessions([makeSession(pendingInputItemId: "item-2")])

      let reAskedRow = try await service.fetchSession(id: "session-1")
      let reAsked = try XCTUnwrap(reAskedRow)
      XCTAssertEqual(reAsked.pendingInputItemId, "item-2")
      XCTAssertEqual(
        workCanonicalSessionState(session: reAsked, summary: service.chatSummaryCache["session-1"]).phase,
        .needsYou,
        "a newer host ask must never be suppressed by an older local guess"
      )
    }
  }

  /// The host's clear is the source of truth; the overlay is only a bridge to
  /// it. Once the changeset lands the guess is gone, so it cannot be sitting
  /// there to swallow a later ask that happens to look the same.
  @MainActor
  func testTheOverlayIsPrunedWhenTheHostChangesetLands() async throws {
    try await withService { service, database in
      service.applyChatAttentionResolutionIfNeeded(
        envelope: envelope(.pendingInputResolved(itemId: "item-1", resolution: "accepted", turnId: "turn-1")),
        rawPayload: rawPayload(["type": "pending_input_resolved", "itemId": "item-1", "resolution": "accepted"])
      )

      // The host agrees and clears the columns.
      try database.replaceTerminalSessions([makeSession(pendingInputItemId: nil)])
      _ = try await service.fetchSessions()

      // Now the SAME itemId comes back — a genuinely new ask that happens to
      // reuse the id. A retired overlay cannot hide it.
      try database.replaceTerminalSessions([makeSession(pendingInputItemId: "item-1")])
      let row = try await service.fetchSession(id: "session-1")
      XCTAssertEqual(row?.pendingInputItemId, "item-1")
    }
  }

  /// A message into a chat that is not asking for anything must not leave a
  /// suppression behind for the NEXT ask to walk into.
  @MainActor
  func testAMessageIntoACalmChatLeavesNoSuppression() async throws {
    try await withService(pendingInputItemId: nil) { service, database in
      service.applyChatAttentionResolutionIfNeeded(
        envelope: envelope(.userMessage(
          text: "one more thing",
          attachments: nil,
          turnId: "turn-1",
          steerId: nil,
          deliveryState: nil,
          processed: nil
        )),
        rawPayload: rawPayload(["type": "user_message", "text": "one more thing"])
      )

      try database.replaceTerminalSessions([makeSession(pendingInputItemId: "item-9")])

      let row = try await service.fetchSession(id: "session-1")
      XCTAssertEqual(row?.pendingInputItemId, "item-9")
    }
  }
}
