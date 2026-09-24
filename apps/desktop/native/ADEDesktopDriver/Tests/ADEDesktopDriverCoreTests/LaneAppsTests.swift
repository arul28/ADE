import XCTest
@testable import ADEDesktopDriverCore

/// Blank launches, the new-window decision, and which apps `stop` quits.
final class LaneAppsTests: XCTestCase {
    // -----------------------------------------------------------------------
    // BlankLaunch
    // -----------------------------------------------------------------------

    func testAppKitAppGetsTheBlankDefaultsBeforeTheCallersArguments() {
        let arguments = BlankLaunch.arguments(engine: .appKit, userArguments: ["/tmp/a.txt"])
        XCTAssertEqual(Array(arguments.prefix(6)), [
            "-ApplePersistenceIgnoreState", "YES",
            "-NSQuitAlwaysKeepsWindows", "NO",
            "-NSShowAppCentricOpenPanelInsteadOfUntitledFile", "NO",
        ])
        XCTAssertEqual(arguments.last, "/tmp/a.txt")
    }

    func testChromiumElectronAndGeckoAppsGetOnlyTheCallersArguments() {
        // They read a loose "YES" as a URL or a file to open.
        XCTAssertEqual(
            BlankLaunch.engine(frameworkNames: ["Electron Framework.framework", "Squirrel.framework"], executableNames: ["Cursor"]),
            .ownCommandLine
        )
        XCTAssertEqual(
            BlankLaunch.engine(frameworkNames: ["Google Chrome Framework.framework"], executableNames: ["Google Chrome"]),
            .ownCommandLine
        )
        XCTAssertEqual(
            BlankLaunch.engine(frameworkNames: [], executableNames: ["firefox", "XUL"]),
            .ownCommandLine
        )
        XCTAssertEqual(BlankLaunch.arguments(engine: .ownCommandLine, userArguments: ["--x"]), ["--x"])
    }

    func testAPlainAppIsAppKit() {
        XCTAssertEqual(BlankLaunch.engine(frameworkNames: [], executableNames: ["TextEdit"]), .appKit)
        XCTAssertEqual(
            BlankLaunch.engine(frameworkNames: ["Sparkle.framework"], executableNames: ["Zed"]),
            .appKit
        )
    }

    // -----------------------------------------------------------------------
    // NewWindowTracker
    // -----------------------------------------------------------------------

    func testEveryWindowOfALaunchedAppStaysACandidateUntilItIsParked() {
        // The launch could not park the window in its three seconds. The old
        // bookkeeping had already marked it known, so no sweep tried it again.
        let tracker = NewWindowTracker()
        tracker.watch(pid: 10, laneId: "lane", launched: true, existing: [1])
        XCTAssertEqual(tracker.candidates(pid: 10, current: [1], unowned: [1]), [1])
        XCTAssertEqual(tracker.candidates(pid: 10, current: [1], unowned: [1]), [1])
        tracker.noteParked(pid: 10, windowId: 1)
        XCTAssertEqual(tracker.candidates(pid: 10, current: [1], unowned: [1]), [])
    }

    func testANewDocumentWindowOfALaunchedAppIsACandidate() {
        let tracker = NewWindowTracker()
        tracker.watch(pid: 10, laneId: "lane", launched: true, existing: [])
        tracker.noteParked(pid: 10, windowId: 1)
        // The Open panel closes and an untitled document opens.
        XCTAssertEqual(tracker.candidates(pid: 10, current: [2], unowned: [2]), [2])
    }

    func testANotReadyWindowIsRetriedAfterAnotherWindowOfTheAppParks() {
        // The old sweep forgot a not-ready window, then the next park reset
        // the known set to every current window, and it was never retried.
        let tracker = NewWindowTracker()
        tracker.watch(pid: 10, laneId: "lane", launched: true, existing: [])
        XCTAssertEqual(tracker.candidates(pid: 10, current: [1, 2], unowned: [1, 2]), [1, 2])
        XCTAssertEqual(tracker.noteNotReady(pid: 10, windowId: 1), .retry(isFirst: true))
        tracker.noteParked(pid: 10, windowId: 2)
        // `park` watches again for every window it parks; that must not settle 1.
        tracker.watch(pid: 10, laneId: "lane", launched: true, existing: [1, 2])
        XCTAssertEqual(tracker.candidates(pid: 10, current: [1, 2], unowned: [1]), [1])
    }

    func testNotReadyRetriesAreCappedAndLoggedOnce() {
        let tracker = NewWindowTracker(maxNotReadyAttempts: 3)
        tracker.watch(pid: 10, laneId: "lane", launched: true, existing: [])
        XCTAssertEqual(tracker.noteNotReady(pid: 10, windowId: 7), .retry(isFirst: true))
        XCTAssertEqual(tracker.noteNotReady(pid: 10, windowId: 7), .retry(isFirst: false))
        XCTAssertEqual(tracker.noteNotReady(pid: 10, windowId: 7), .giveUp)
        XCTAssertEqual(tracker.candidates(pid: 10, current: [7], unowned: [7]), [])
    }

    func testAClaimedAppKeepsItsExistingWindowsAndLendsOnlyNewOnesAsClaimed() {
        let tracker = NewWindowTracker()
        tracker.watch(pid: 20, laneId: "lane", launched: false, existing: [1, 2])
        XCTAssertEqual(tracker.candidates(pid: 20, current: [1, 2, 3], unowned: [1, 2, 3]), [3])
        XCTAssertEqual(tracker.originForNewWindow(pid: 20), "claimed")
        tracker.watch(pid: 20, laneId: "lane", launched: true, existing: [])
        XCTAssertEqual(tracker.originForNewWindow(pid: 20), "ade_launched")
    }

    func testAWindowOwnedByALaneIsNeverACandidate() {
        let tracker = NewWindowTracker()
        tracker.watch(pid: 10, laneId: "lane", launched: true, existing: [])
        XCTAssertEqual(tracker.candidates(pid: 10, current: [1, 2], unowned: [2]), [2])
    }

    func testAnUnwatchedPidHasNoCandidates() {
        let tracker = NewWindowTracker()
        XCTAssertEqual(tracker.candidates(pid: 99, current: [1], unowned: [1]), [])
        XCTAssertEqual(tracker.noteNotReady(pid: 99, windowId: 1), .giveUp)
    }

    // -----------------------------------------------------------------------
    // LaunchedAppRegistry and the quit report
    // -----------------------------------------------------------------------

    func testAnInstanceTheUserStartedIsNeverTheLanes() {
        let registry = LaunchedAppRegistry()
        XCTAssertFalse(registry.record(pid: 5, laneId: "lane", appName: "Finder", bundleId: "com.apple.finder", wasRunningBefore: true))
        XCTAssertTrue(registry.apps(forLane: "lane").isEmpty)
        XCTAssertTrue(registry.record(pid: 6, laneId: "lane", appName: "TextEdit", bundleId: nil, wasRunningBefore: false))
        // A second open of the same instance by the same lane stays the lane's.
        XCTAssertTrue(registry.record(pid: 6, laneId: "lane", appName: "TextEdit", bundleId: nil, wasRunningBefore: true))
        XCTAssertFalse(registry.record(pid: 6, laneId: "other", appName: "TextEdit", bundleId: nil, wasRunningBefore: true))
        XCTAssertTrue(registry.isLaunched(pid: 6, byLane: "lane"))
        XCTAssertFalse(registry.isLaunched(pid: 6, byLane: "other"))
        XCTAssertEqual(registry.forgetLane("lane").map(\.pid), [6])
        XCTAssertTrue(registry.all.isEmpty)
    }

    func testTheQuitReportNamesTheAppsThatStayed() {
        let apps = [
            LaunchedAppRegistry.App(pid: 1, laneId: "lane", appName: "Safari", bundleId: nil),
            LaunchedAppRegistry.App(pid: 2, laneId: "lane", appName: "TextEdit", bundleId: nil),
        ]
        let report = LaneQuitReport.settle(apps: apps, stillRunning: [2])
        XCTAssertEqual(report.quit, ["Safari"])
        XCTAssertEqual(report.leftOpen.map(\.appName), ["TextEdit"])
        XCTAssertEqual(
            report.leftOpen.first?.message,
            "TextEdit did not quit, probably because it has unsaved work. It moved to your screen."
        )
        XCTAssertEqual(report.jsonFields["quitApps"], .array([.string("Safari")]))
    }
}
