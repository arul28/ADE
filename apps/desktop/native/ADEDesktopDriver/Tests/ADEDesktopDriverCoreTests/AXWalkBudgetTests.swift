import XCTest
@testable import ADEDesktopDriverCore

final class AXWalkBudgetTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)

    private func budget(seconds: TimeInterval = 5, maxNodes: Int = 100, maxForeign: Int = 10) -> AXWalkBudget {
        AXWalkBudget(startedAt: start, timeBudget: seconds, maxNodes: maxNodes, maxForeignNodes: maxForeign)
    }

    // -- the timeouts themselves ---------------------------------------------

    /// The numbers the whole fix rests on, pinned against the deadlines they
    /// have to beat: the service's 5 s health read, the watchdog's 15 s, and
    /// the service's 20 s request timeout.
    func testTimeoutsStayUnderTheDeadlinesTheyProtect() {
        XCTAssertLessThanOrEqual(AXTimeouts.walkRead, 1)
        XCTAssertLessThan(AXTimeouts.walkRead, AXTimeouts.global)
        XCTAssertLessThan(Double(AXTimeouts.global), 5, "one stuck call must not make a 5 s ping late")
        XCTAssertLessThanOrEqual(AXTimeouts.observeWalk, 15 / 2, "observe also screenshots before the 15 s watchdog")
        XCTAssertLessThan(AXTimeouts.waitPollWalk, AXTimeouts.observeWalk)
        // Two stalled apps still leave time for the healthy ones.
        XCTAssertLessThan(Double(AXTimeouts.walkRead) * 2, AXTimeouts.observeWalk)
    }

    func testClassifiesTheCannotCompleteCodeAsATimeout() {
        XCTAssertEqual(AXCallResult.classify(rawError: 0), .ok)
        XCTAssertEqual(AXCallResult.classify(rawError: -25204), .timedOut)
        // kAXErrorAttributeUnsupported, kAXErrorNoValue, kAXErrorInvalidUIElement.
        XCTAssertEqual(AXCallResult.classify(rawError: -25205), .failed)
        XCTAssertEqual(AXCallResult.classify(rawError: -25212), .failed)
        XCTAssertEqual(AXCallResult.classify(rawError: -25202), .failed)
    }

    /// A timed-out press opened a modal; it happened. Only a refusal may fall
    /// through to the next action, or the element is pressed twice.
    func testATimedOutActionCountsAsDelivered() {
        XCTAssertTrue(AXCallResult.wasDelivered(rawError: 0))
        XCTAssertTrue(AXCallResult.wasDelivered(rawError: -25204))
        XCTAssertFalse(AXCallResult.wasDelivered(rawError: -25206))
    }

    // -- the walk budget ------------------------------------------------------

    func testStopsAtTheDeadlineAndSaysTimeout() {
        var walk = budget(seconds: 2)
        XCTAssertTrue(walk.admitNode(now: start))
        XCTAssertTrue(walk.admitNode(now: start.addingTimeInterval(1.9)))
        XCTAssertFalse(walk.admitNode(now: start.addingTimeInterval(2)))
        // Once stopped, stays stopped: a clock that stepped back must not
        // restart a walk that already reported a timeout.
        XCTAssertFalse(walk.admitNode(now: start))
        XCTAssertEqual(walk.visited, 2)
        XCTAssertEqual(walk.stopReason(limitHit: true), .timeout)
        XCTAssertEqual(walk.remaining(now: start.addingTimeInterval(3)), 0)
        XCTAssertEqual(walk.elapsedMs(now: start.addingTimeInterval(2.5)), 2_500)
    }

    func testStopsAtTheNodeCap() {
        var walk = budget(maxNodes: 3)
        for _ in 0..<3 { XCTAssertTrue(walk.admitNode(now: start)) }
        XCTAssertFalse(walk.admitNode(now: start))
        XCTAssertEqual(walk.stopReason(limitHit: false), .nodeCap)
    }

    func testACompleteWalkHasNoReasonAndALimitIsTheWeakestOne() {
        var walk = budget()
        XCTAssertTrue(walk.admitNode(now: start))
        XCTAssertNil(walk.stopReason(limitHit: false))
        XCTAssertEqual(walk.stopReason(limitHit: true), .limit)
    }

    /// The TextEdit case: the app stops answering, its subtree is dropped, the
    /// walk carries on with the others, and the reply names the app.
    func testAStalledAppIsSkippedAndNamedOnce() {
        var walk = budget()
        walk.noteStall(pid: 42, appName: "TextEdit")
        walk.noteStall(pid: 42, appName: "TextEdit")
        XCTAssertTrue(walk.isStalled(pid: 42))
        XCTAssertFalse(walk.admitChild(pid: 42, windowPid: 42))
        XCTAssertTrue(walk.admitChild(pid: 7, windowPid: 7))
        XCTAssertEqual(walk.stalled, [AXWalkBudget.StalledApp(pid: 42, appName: "TextEdit")])
        XCTAssertEqual(walk.stopReason(limitHit: true), .stalled)
    }

    func testATimeoutOutranksAStall() {
        var walk = budget(seconds: 1)
        walk.noteStall(pid: 42, appName: "TextEdit")
        XCTAssertFalse(walk.admitNode(now: start.addingTimeInterval(1)))
        XCTAssertEqual(walk.stopReason(limitHit: false), .timeout)
    }

    /// A remote view (another pid inside the host's window) is walked, but only
    /// up to its own cap, and never counted against the host app.
    func testCapsARemoteViewWithoutCappingTheHostWindow() {
        var walk = budget(maxForeign: 2)
        XCTAssertTrue(walk.admitChild(pid: 99, windowPid: 42))
        XCTAssertTrue(walk.admitChild(pid: 99, windowPid: 42))
        XCTAssertFalse(walk.admitChild(pid: 99, windowPid: 42))
        XCTAssertEqual(walk.cappedForeignPids, [99])
        for _ in 0..<10 { XCTAssertTrue(walk.admitChild(pid: 42, windowPid: 42)) }
        XCTAssertTrue(walk.admitChild(pid: 100, windowPid: 42))
        XCTAssertEqual(walk.stopReason(limitHit: false), .nodeCap)
    }

    func testAWaitPollNeverOutlivesTheWaitButAlwaysGetsAMoment() {
        XCTAssertEqual(
            AXWalkBudget.waitPollBudget(now: start, waitDeadline: start.addingTimeInterval(60)),
            AXTimeouts.waitPollWalk
        )
        XCTAssertEqual(AXWalkBudget.waitPollBudget(now: start, waitDeadline: start.addingTimeInterval(1)), 1)
        XCTAssertEqual(AXWalkBudget.waitPollBudget(now: start, waitDeadline: start.addingTimeInterval(-3)), 0.25)
    }

    func testANegativeBudgetIsAnAlreadySpentOne() {
        var walk = budget(seconds: -1)
        XCTAssertFalse(walk.admitNode(now: start))
        XCTAssertEqual(walk.stopReason(limitHit: false), .timeout)
    }

    // -- the shared stall registry --------------------------------------------

    func testTheRegistrySkipsAnAppForTheCooldownThenTriesAgain() {
        let registry = AXStallRegistry(cooldown: 5)
        XCTAssertFalse(registry.isStalled(pid: 42, at: start))
        XCTAssertTrue(registry.noteStall(pid: 42, at: start), "a new stall is reported")
        XCTAssertTrue(registry.isStalled(pid: 42, at: start.addingTimeInterval(4.9)))
        XCTAssertFalse(registry.isStalled(pid: 7, at: start))
        XCTAssertFalse(registry.isStalled(pid: 42, at: start.addingTimeInterval(5)))
        // After the cooldown the entry is gone, so the next stall is new again.
        XCTAssertTrue(registry.noteStall(pid: 42, at: start.addingTimeInterval(6)))
    }

    /// A wait polls four times a second; the log line must not.
    func testARepeatStallInsideTheCooldownIsNotNew() {
        let registry = AXStallRegistry(cooldown: 5)
        XCTAssertTrue(registry.noteStall(pid: 42, at: start))
        XCTAssertFalse(registry.noteStall(pid: 42, at: start.addingTimeInterval(1)))
        // A repeat extends the cooldown from the latest stall.
        XCTAssertTrue(registry.isStalled(pid: 42, at: start.addingTimeInterval(5.5)))
        registry.clear(pid: 42)
        XCTAssertFalse(registry.isStalled(pid: 42, at: start.addingTimeInterval(1)))
    }

    // -- the deadline inside one element ---------------------------------------

    /// Near the deadline a read gets only what is left, so one call cannot
    /// carry the walk far past its budget; and a timeout on that shortened
    /// read must not be mistaken for a stalled app.
    func testTheLastReadsOfAWalkAreShortenedAndSaySo() {
        let walk = budget(seconds: 5)
        let early = walk.readTimeout(now: start)
        XCTAssertEqual(early.seconds, AXTimeouts.walkRead)
        XCTAssertTrue(early.isFull)
        let late = walk.readTimeout(now: start.addingTimeInterval(4.7))
        XCTAssertEqual(Double(late.seconds), 0.3, accuracy: 0.001)
        XCTAssertFalse(late.isFull)
        // Never zero: a zero timeout means "use the default" to the AX API.
        XCTAssertEqual(Double(walk.readTimeout(now: start.addingTimeInterval(9)).seconds), 0.05, accuracy: 0.001)
    }

    func testExpiringEndsTheWalkAsATimeout() {
        var walk = budget()
        XCTAssertTrue(walk.admitNode(now: start))
        walk.expire()
        XCTAssertFalse(walk.admitNode(now: start))
        XCTAssertEqual(walk.stopReason(limitHit: false), .timeout)
    }
}
