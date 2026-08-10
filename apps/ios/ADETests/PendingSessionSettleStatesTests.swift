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
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    // A declared settle clears ANY override host-side — including a keep-active
    // pin, so it cannot silently veto the settle — and the overlay does too.
    let overlaid = states.apply(to: session(settleOverride: "active"))
    XCTAssertEqual(overlaid.settledAt, "2026-08-10T12:00:00.000Z")
    XCTAssertNil(overlaid.settleOverride)
  }

  func testUnsettleLeavesAKeepActivePinAlone() {
    var states = PendingSessionSettleStates()
    states.begin(.unsettle(now: now), for: "session-1", baseline: nil)

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
    states.begin(.unsettle(now: now), for: "session-1", baseline: nil)

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
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

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
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    // The host writes its own clock. Matching on the exact string would never
    // resolve, so presence is what the settle intent predicts.
    states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], now: now)

    XCTAssertNil(states["session-1"])
  }

  func testIntentSurvivesUntilTheHostRowActuallyChanges() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    states.prune(against: [session(settledAt: nil)], now: now)

    XCTAssertNotNil(states["session-1"])
    XCTAssertEqual(states.apply(to: session()).settledAt, "2026-08-10T12:00:00.000Z")
  }

  func testUnsettleIntentResolvesWhenTheRowGoesBackToNull() {
    var states = PendingSessionSettleStates()
    states.begin(.unsettle(now: now), for: "session-1", baseline: nil)

    states.prune(against: [session(settledAt: "2026-08-10T09:00:00.000Z")], now: now)
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session(settledAt: nil)], now: now)
    XCTAssertNil(states["session-1"])
  }

  func testOverrideIntentComparesTheExactValueWeAskedFor() {
    var states = PendingSessionSettleStates()
    states.begin(.settleOverride("active", now: now), for: "session-1", baseline: nil)

    // `settle_override` is a value we own, unlike the settle timestamp — a
    // different non-null value is the host disagreeing, not confirming.
    states.prune(against: [session(settleOverride: "settled")], now: now)
    XCTAssertNotNil(states["session-1"])

    states.prune(against: [session(settleOverride: "active")], now: now)
    XCTAssertNil(states["session-1"])
  }

  func testClearingAnOverrideResolvesOnNull() {
    var states = PendingSessionSettleStates()
    states.begin(.settleOverride(nil, now: now), for: "session-1", baseline: nil)

    XCTAssertNil(states.apply(to: session(settleOverride: "active")).settleOverride)

    states.prune(against: [session(settleOverride: nil)], now: now)
    XCTAssertNil(states["session-1"])
  }

  func testAFailedCommandDropsTheIntentSoTheRowSnapsBack() {
    var states = PendingSessionSettleStates()
    let token = states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    states.clear("session-1", token: token)

    XCTAssertNil(states.apply(to: session()).settledAt)
  }

  /// Two commands for one session can overlap — tap "Keep active", then "Settle"
  /// before the first returns. The loser's failure must not retire the intent
  /// the user is now waiting on.
  func testAStaleFailureCannotRetireANewerIntent() {
    var states = PendingSessionSettleStates()
    let stale = states.begin(.settleOverride("active", now: now), for: "session-1", baseline: nil)
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    states.clear("session-1", token: stale)

    XCTAssertEqual(states.apply(to: session()).settledAt, "2026-08-10T12:00:00.000Z")
  }

  func testAnIntentWhoseChangesetNeverArrivesExpires() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

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
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

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
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

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
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    // Re-stamping the offline deadline is not a resolution; reporting it as one
    // would repaint on every read forever.
    states.holdBackstop(now: now)
    XCTAssertFalse(states.prune(against: [session(settledAt: nil)], now: now))
    XCTAssertTrue(states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], now: now))
    XCTAssertFalse(states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], now: now))
  }

  func testTheNewestCommandWins() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)
    states.begin(.unsettle(now: now), for: "session-1", baseline: nil)

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
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: unsettled)
    states.begin(.unsettle(now: now), for: "session-1", baseline: unsettled)

    // The row has not moved yet — `settled_at` is still nil, which is also what
    // the unsettle wants. It must NOT count as confirmation.
    states.prune(against: [unsettled], now: now)
    XCTAssertNotNil(states["session-1"])

    // The first command lands. Still not our intent, so the overlay holds and
    // keeps showing the row as the user last asked for it.
    let settledByFirstCommand = session(settledAt: "2026-08-10T12:00:00.417Z")
    states.prune(against: [settledByFirstCommand], now: now)
    XCTAssertNotNil(states["session-1"])
    XCTAssertNil(states.apply(to: settledByFirstCommand).settledAt)

    // The unsettle lands: the row has now moved AND matches.
    states.prune(against: [unsettled], now: now)
    XCTAssertNil(states["session-1"])
  }

  func testAnUnknownBaselineFallsBackToValueEquality() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    states.prune(against: [session(settledAt: "2026-08-10T12:00:00.417Z")], now: now)

    XCTAssertNil(states["session-1"], "with no baseline the value match is all we have")
  }

  func testRemoveAllForgetsEverythingInFlight() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    states.removeAll()

    XCTAssertTrue(states.isEmpty)
    XCTAssertNil(states.apply(to: session()).settledAt)
  }

  func testASessionMissingFromAScopedReadKeepsItsIntent() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

    // A partial or differently-scoped read is not the host disagreeing.
    states.prune(against: [session(id: "session-2", settledAt: nil)], now: now)

    XCTAssertNotNil(states["session-1"])
  }

  func testOverlayOnlyTouchesTheSessionItWasBegunFor() {
    var states = PendingSessionSettleStates()
    states.begin(.settle(now: now, timestamp: "2026-08-10T12:00:00.000Z"), for: "session-1", baseline: nil)

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
        .settle(now: Date(), timestamp: "2026-08-10T12:00:00.000Z"),
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
        .settle(now: Date(), timestamp: "2026-08-10T12:00:00.000Z"),
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
        .settle(now: Date(), timestamp: "2026-08-10T12:00:00.000Z"),
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
