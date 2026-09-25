import XCTest
@testable import ADEDesktopDriverCore

/// The decisions a request makes when a run-loop pump let another request run
/// to completion inside it: a stop, a release, a second start.
final class LaneLifecycleTests: XCTestCase {
    // -----------------------------------------------------------------------
    // LaneStopGate
    // -----------------------------------------------------------------------

    func testAStoppingLaneRefusesNewWorkWithItsOwnCode() {
        let gate = LaneStopGate()
        XCTAssertNil(gate.refusal(laneId: "a", action: "open an app"))
        gate.begin("a")
        XCTAssertEqual(gate.refusal(laneId: "a", action: "open an app")?.code, DriverErrorCode.laneStopping)
        XCTAssertNil(gate.refusal(laneId: "b", action: "open an app"), "another lane is unaffected")
        gate.end("a")
        XCTAssertFalse(gate.isStopping("a"))
    }

    func testANestedStopEndingDoesNotClearTheOuterStop() {
        // display.destroy running inside display.reconcile for the same lane.
        let gate = LaneStopGate()
        gate.begin("a")
        gate.begin("a")
        gate.end("a")
        XCTAssertTrue(gate.isStopping("a"))
        gate.end("a")
        XCTAssertFalse(gate.isStopping("a"))
        gate.end("a") // an unmatched end is harmless
        XCTAssertFalse(gate.isStopping("a"))
    }

    // -----------------------------------------------------------------------
    // RequestAdmission
    // -----------------------------------------------------------------------

    func testAShuttingDownDriverAnswersOnlyPing() {
        XCTAssertNil(RequestAdmission.refusal(op: .health, isShuttingDown: true))
        for op in DriverOp.allCases where op != .health {
            XCTAssertEqual(
                RequestAdmission.refusal(op: op, isShuttingDown: true)?.code,
                DriverErrorCode.driverUnavailable,
                "\(op.rawValue) must be refused during shutdown"
            )
            XCTAssertNil(RequestAdmission.refusal(op: op, isShuttingDown: false))
        }
        XCTAssertNotNil(RequestAdmission.refusal(op: nil, isShuttingDown: true))
    }

    // -----------------------------------------------------------------------
    // ParkRecheck
    // -----------------------------------------------------------------------

    private let display = LanePlacement(
        placement: DisplayPlacement(origin: CGPoint(x: 8000, y: 0), width: 1280, height: 800, scale: 2),
        displayId: 7,
        generation: 1
    )

    func testAParkWhoseLaneStillHoldsEverythingProceeds() {
        XCTAssertEqual(
            ParkRecheck.decide(
                laneId: "a", windowId: 7, ownerNow: "a",
                placementAtStart: display, placementNow: display, isStopping: false
            ),
            .proceed(display)
        )
    }

    func testAParkWhoseDisplayWasReplacedInsideTheWaitIsRefused() {
        // The lane stopped and started again while the park waited: a new
        // display, somewhere else and another size. Sizing the window from the
        // old one put it on a display the lane no longer has.
        let moved = LanePlacement(
            placement: DisplayPlacement(origin: CGPoint(x: 12000, y: 0), width: 1920, height: 1080, scale: 2),
            displayId: 9,
            generation: 2
        )
        guard case .refuse(let error, let dropHold) = ParkRecheck.decide(
            laneId: "a", windowId: 7, ownerNow: "a",
            placementAtStart: display, placementNow: moved, isStopping: false
        ) else { return XCTFail("expected a refusal") }
        XCTAssertEqual(error.code, DriverErrorCode.noDisplay)
        XCTAssertTrue(error.message.contains("changed"))
        XCTAssertFalse(dropHold, "the hold the lane has now is a later take's")

        // Made again at the same place and size, with the same id: still a
        // different display.
        let remade = LanePlacement(placement: display.placement, displayId: display.displayId, generation: 2)
        guard case .refuse = ParkRecheck.decide(
            laneId: "a", windowId: 7, ownerNow: "a",
            placementAtStart: display, placementNow: remade, isStopping: false
        ) else { return XCTFail("a remade display must not pass as the old one") }
    }

    func testAParkWhoseLaneStartedStoppingLeavesTheHoldToTheStop() {
        guard case .refuse(let error, let dropHold) = ParkRecheck.decide(
            laneId: "a", windowId: 7, ownerNow: "a", placementAtStart: display, placementNow: display, isStopping: true
        ) else { return XCTFail("expected a refusal") }
        XCTAssertEqual(error.code, DriverErrorCode.laneStopping)
        XCTAssertFalse(dropHold)
    }

    func testAParkWhoseLaneLostItsDisplayDropsItsHold() {
        guard case .refuse(let error, let dropHold) = ParkRecheck.decide(
            laneId: "a", windowId: 7, ownerNow: "a", placementAtStart: display, placementNow: nil, isStopping: false
        ) else { return XCTFail("expected a refusal") }
        XCTAssertEqual(error.code, DriverErrorCode.noDisplay)
        XCTAssertTrue(dropHold)
    }

    func testAParkWhoseWindowWasReleasedOrTakenDoesNotTouchIt() {
        guard case .refuse(let released, let dropReleased) = ParkRecheck.decide(
            laneId: "a", windowId: 7, ownerNow: nil, placementAtStart: display, placementNow: nil, isStopping: false
        ) else { return XCTFail("expected a refusal") }
        XCTAssertEqual(released.code, DriverErrorCode.windowNotFound)
        XCTAssertFalse(dropReleased)

        guard case .refuse(let taken, let dropTaken) = ParkRecheck.decide(
            laneId: "a", windowId: 7, ownerNow: "b", placementAtStart: display, placementNow: display, isStopping: false
        ) else { return XCTFail("expected a refusal") }
        XCTAssertEqual(taken.code, DriverErrorCode.appOwnedByOtherLane)
        XCTAssertTrue(taken.message.contains("lane b"))
        XCTAssertFalse(dropTaken)
    }

    func testTheSweepStopsQuietlyOnlyWhenTheLaneIsGoing() {
        XCTAssertTrue(ParkRecheck.isLaneGone(code: DriverErrorCode.laneStopping))
        XCTAssertTrue(ParkRecheck.isLaneGone(code: DriverErrorCode.noDisplay))
        XCTAssertFalse(ParkRecheck.isLaneGone(code: DriverErrorCode.windowNotReady))
        XCTAssertFalse(ParkRecheck.isLaneGone(code: nil))
    }

    // -----------------------------------------------------------------------
    // CaptureStartReservations
    // -----------------------------------------------------------------------

    func testASecondStartForTheSameLaneIsRefusedWhileTheFirstRuns() {
        let reservations = CaptureStartReservations()
        let first = reservations.reserve("a")
        XCTAssertNotNil(first)
        XCTAssertNil(reservations.reserve("a"))
        XCTAssertNotNil(reservations.reserve("b"), "another lane starts independently")
        XCTAssertTrue(reservations.finish(first!))
        XCTAssertFalse(reservations.isStarting("a"))
        XCTAssertNotNil(reservations.reserve("a"), "a finished start frees the lane")
    }

    func testAStopDuringTheStartCancelsIt() {
        let reservations = CaptureStartReservations()
        let token = reservations.reserve("a")!
        XCTAssertTrue(reservations.cancel("a"))
        XCTAssertTrue(reservations.isCancelled(token))
        XCTAssertFalse(reservations.finish(token), "a cancelled start must not install what it built")
        XCTAssertFalse(reservations.cancel("a"), "nothing left to cancel")
    }

    func testACancelledStartFinishingLateLeavesTheNextStartAlone() {
        let reservations = CaptureStartReservations()
        let stale = reservations.reserve("a")!
        reservations.cancel("a")
        let next = reservations.reserve("a")!
        XCTAssertFalse(reservations.finish(stale))
        XCTAssertTrue(reservations.isStarting("a"), "the stale finish did not clear the new marker")
        XCTAssertTrue(reservations.finish(next))
    }

    func testShutdownCancelsEveryStart() {
        let reservations = CaptureStartReservations()
        let a = reservations.reserve("a")!
        let b = reservations.reserve("b")!
        reservations.cancelAll()
        XCTAssertFalse(reservations.finish(a))
        XCTAssertFalse(reservations.finish(b))
        XCTAssertEqual(
            CaptureStartReservations.alreadyStarting(laneId: "a", what: "live stream").code,
            DriverErrorCode.captureStarting
        )
    }

    // -----------------------------------------------------------------------
    // Launched apps belong to the lane that launched them
    // -----------------------------------------------------------------------

    func testAnotherLaneNeverTakesOverALaunchedWatch() {
        let tracker = NewWindowTracker()
        XCTAssertTrue(tracker.watch(pid: 10, laneId: "a", launched: true, existing: []))
        XCTAssertFalse(tracker.watch(pid: 10, laneId: "b", launched: false, existing: [1]))
        XCTAssertFalse(tracker.watch(pid: 10, laneId: "b", launched: true, existing: []))
        XCTAssertEqual(tracker.laneId(forPid: 10), "a")
        XCTAssertTrue(tracker.isLaunched(pid: 10))
    }

    func testAClaimedWatchCanStillMoveAndTheSameLaneCanUpgradeIt() {
        let tracker = NewWindowTracker()
        XCTAssertTrue(tracker.watch(pid: 10, laneId: "a", launched: false, existing: [1]))
        XCTAssertTrue(tracker.watch(pid: 10, laneId: "a", launched: true, existing: []))
        XCTAssertTrue(tracker.isLaunched(pid: 10))
        XCTAssertTrue(tracker.watch(pid: 11, laneId: "a", launched: false, existing: []))
        XCTAssertTrue(tracker.watch(pid: 11, laneId: "b", launched: false, existing: []))
        XCTAssertEqual(tracker.laneId(forPid: 11), "b")
    }

    func testAWindowOfAnotherLanesLaunchedAppIsRefused() {
        let registry = LaunchedAppRegistry()
        registry.record(pid: 10, laneId: "a", appName: "TextEdit", bundleId: "com.apple.TextEdit", wasRunningBefore: false)
        XCTAssertEqual(registry.laneId(forPid: 10), "a")
        XCTAssertNil(registry.refusal(pid: 10, laneId: "a", appName: "TextEdit"))
        XCTAssertNil(registry.refusal(pid: 99, laneId: "b", appName: "Notes"), "a user app is anyone's to claim")
        let refusal = registry.refusal(pid: 10, laneId: "b", appName: "TextEdit")
        XCTAssertEqual(refusal?.code, DriverErrorCode.appOwnedByOtherLane)
        XCTAssertTrue(refusal?.message.contains("lane a") ?? false)
    }

    func testARawKillNeedsTheSameAppUnderThePid() {
        let app = LaunchedAppRegistry.App(pid: 10, laneId: "a", appName: "TextEdit", bundleId: "com.apple.TextEdit")
        XCTAssertTrue(app.isStillRunning(currentBundleId: "com.apple.TextEdit", isTerminated: false, hasProcess: true))
        XCTAssertFalse(app.isStillRunning(currentBundleId: "com.other.App", isTerminated: false, hasProcess: true), "a reused pid")
        XCTAssertFalse(app.isStillRunning(currentBundleId: "com.apple.TextEdit", isTerminated: true, hasProcess: true))
        XCTAssertFalse(app.isStillRunning(currentBundleId: nil, isTerminated: true, hasProcess: false))
    }

    // -----------------------------------------------------------------------
    // Release scoped to a lane
    // -----------------------------------------------------------------------

    func testALaneCannotReleaseAnotherLanesWindow() throws {
        let registry = OwnershipRegistry()
        try registry.park(laneId: "a", windowId: 7)
        XCTAssertNil(registry.releaseRefusal(windowId: 7, laneId: "a"))
        XCTAssertNil(registry.releaseRefusal(windowId: 7, laneId: nil), "an older client names no lane")
        XCTAssertNil(registry.releaseRefusal(windowId: 8, laneId: "b"), "nobody holds window 8")
        XCTAssertEqual(
            registry.releaseRefusal(windowId: 7, laneId: "b"),
            .windowOwnedByOtherLane(windowId: 7, holderLaneId: "a")
        )
    }
}
