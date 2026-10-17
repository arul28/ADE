import XCTest
@testable import ADEDesktopDriverCore

final class WindowHitTestTests: XCTestCase {
    private let front = WindowHitCandidate(pid: 100, frame: CGRect(x: 8000, y: 0, width: 800, height: 600), minimized: false)
    private let back = WindowHitCandidate(pid: 200, frame: CGRect(x: 8400, y: 300, width: 800, height: 600), minimized: false)
    private let hidden = WindowHitCandidate(pid: 300, frame: CGRect(x: 8000, y: 0, width: 2000, height: 2000), minimized: true)

    /// The reason this exists: a click on a lane window must reach that
    /// window's process, never the HID tap that yanks the user's own cursor.
    func testFrontmostWindowUnderThePointWins() {
        XCTAssertEqual(WindowHitTest.pid(at: CGPoint(x: 8500, y: 400), in: [front, back]), 100)
        XCTAssertEqual(WindowHitTest.pid(at: CGPoint(x: 9000, y: 800), in: [front, back]), 200)
    }

    func testEmptyDesktopHasNoProcess() {
        XCTAssertNil(WindowHitTest.pid(at: CGPoint(x: 9500, y: 100), in: [front, back]))
    }

    func testMinimizedWindowsAreNotHit() {
        XCTAssertNil(WindowHitTest.pid(at: CGPoint(x: 9500, y: 1500), in: [hidden]))
        XCTAssertEqual(WindowHitTest.frontmostPid(in: [hidden, back]), 200)
        XCTAssertNil(WindowHitTest.frontmostPid(in: [hidden]))
    }

    private let laneDisplay = CGRect(x: -2560, y: 0, width: 2560, height: 1440)
    private func row(_ pid: pid_t, _ id: UInt32, layer: Int = 0, _ frame: CGRect) -> WindowHitTest.WindowServerRow {
        WindowHitTest.WindowServerRow(pid: pid, windowId: id, layer: layer, frame: frame)
    }

    /// The "background input never reaches the user's screen" guarantee: only
    /// the lane's own windows, and a menu or popover only when it lies wholly
    /// on the lane's display.
    func testBackgroundCandidatesAdmitOnlyTheLanesWindowsAndItsMenus() {
        let laneWindow = row(100, 1, CGRect(x: -2500, y: 30, width: 800, height: 600))
        // Same process (one Safari for every window), not the lane's window,
        // straddling onto the lane display from the user's.
        let usersWindowSameApp = row(100, 2, CGRect(x: -200, y: 100, width: 800, height: 600))
        let menuOnLane = row(100, 3, layer: 101, CGRect(x: -2400, y: 200, width: 260, height: 120))
        let menuStraddling = row(100, 4, layer: 101, CGRect(x: -100, y: 200, width: 260, height: 120))
        let otherAppsMenu = row(300, 5, layer: 101, CGRect(x: -2400, y: 200, width: 260, height: 120))
        let screenSaverBand = row(100, 6, layer: 1000, CGRect(x: -2500, y: 30, width: 400, height: 400))
        let candidates = WindowHitTest.backgroundCandidates(
            [menuOnLane, menuStraddling, otherAppsMenu, screenSaverBand, usersWindowSameApp, laneWindow],
            laneWindowIds: [1],
            lanePids: [100],
            display: laneDisplay
        )
        XCTAssertEqual(candidates.map(\.windowId), [3, 1])
        // Front to back: a click on the open menu lands on the menu, not under it.
        XCTAssertEqual(WindowHitTest.window(at: CGPoint(x: -2300, y: 250), in: candidates)?.windowId, 3)
        XCTAssertEqual(WindowHitTest.window(at: CGPoint(x: -2450, y: 500), in: candidates)?.windowId, 1)
        XCTAssertNil(WindowHitTest.window(at: CGPoint(x: -50, y: 300), in: candidates))
    }

    /// "The app the user is working in" means an ordinary window on the user's
    /// own screen. A window on this lane's or another lane's display does not
    /// count, and neither does a menu-bar extra (not layer 0).
    func testOnlyAnOrdinaryWindowOffEveryLaneDisplayIsTheUsersScreen() {
        let otherLane = CGRect(x: -5120, y: 0, width: 2560, height: 1440)
        let lanes = [laneDisplay, otherLane]
        let onThisLane = row(100, 1, CGRect(x: -2500, y: 30, width: 800, height: 600))
        let onOtherLane = row(100, 2, CGRect(x: -5000, y: 30, width: 800, height: 600))
        let menuBarExtra = row(100, 3, layer: 25, CGRect(x: 4000, y: 0, width: 30, height: 24))
        let onUsersScreen = row(100, 4, CGRect(x: 200, y: 200, width: 800, height: 600))
        XCTAssertFalse(WindowHitTest.hasWindowOnUserScreen([onThisLane, onOtherLane, menuBarExtra], pid: 100, laneDisplays: lanes))
        XCTAssertTrue(WindowHitTest.hasWindowOnUserScreen([onThisLane, onUsersScreen], pid: 100, laneDisplays: lanes))
        XCTAssertFalse(WindowHitTest.hasWindowOnUserScreen([onUsersScreen], pid: 999, laneDisplays: lanes))
    }
}
