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
}
