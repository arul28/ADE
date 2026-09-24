import XCTest
@testable import ADEDesktopDriverCore

/// The filter every listing applies before its Accessibility read. The sweep
/// used to read Zed, Music and System Settings on every tick, up to a second
/// each, because a lookup by window id listed every app on the Mac.
final class WindowListScopeTests: XCTestCase {
    private let laneDisplay: UInt32 = 7
    private let mainDisplay: UInt32 = 1

    func testALaneListingSkipsAnUnrelatedAppOnTheMainScreen() {
        let scope = WindowListScope(laneId: "lane")
        XCTAssertFalse(scope.admits(windowId: 1, ownerPid: 500, ownedBy: nil, displayId: mainDisplay, laneDisplayId: laneDisplay))
        // Off every display (a minimized or hidden window): not on the lane.
        XCTAssertFalse(scope.admits(windowId: 1, ownerPid: 500, ownedBy: nil, displayId: nil, laneDisplayId: laneDisplay))
        // Held by another lane and on the main screen.
        XCTAssertFalse(scope.admits(windowId: 1, ownerPid: 500, ownedBy: "other", displayId: mainDisplay, laneDisplayId: laneDisplay))
    }

    func testALaneListingKeepsItsOwnWindowsAndWhatSitsOnItsDisplay() {
        let scope = WindowListScope(laneId: "lane")
        // Held, wherever it is: a minimized held window keeps its row.
        XCTAssertTrue(scope.admits(windowId: 1, ownerPid: 500, ownedBy: "lane", displayId: nil, laneDisplayId: laneDisplay))
        // Dragged onto the lane's display by hand.
        XCTAssertTrue(scope.admits(windowId: 2, ownerPid: 600, ownedBy: nil, displayId: laneDisplay, laneDisplayId: laneDisplay))
        // A lane with no display lists only what it holds.
        XCTAssertFalse(scope.admits(windowId: 2, ownerPid: 600, ownedBy: nil, displayId: laneDisplay, laneDisplayId: nil))
    }

    func testALookupByIdKeepsOnlyThatWindow() {
        let scope = WindowListScope(windowIds: [62912])
        XCTAssertTrue(scope.admits(windowId: 62912, ownerPid: 73002, ownedBy: "lane", displayId: laneDisplay, laneDisplayId: nil))
        XCTAssertFalse(scope.admits(windowId: 900, ownerPid: 800, ownedBy: nil, displayId: mainDisplay, laneDisplayId: nil))
        XCTAssertFalse(scope.isUnscoped)
    }

    func testAPidListingKeepsOnlyThatProcess() {
        let scope = WindowListScope(pid: 73002)
        XCTAssertTrue(scope.admits(windowId: 1, ownerPid: 73002, ownedBy: nil, displayId: mainDisplay, laneDisplayId: nil))
        XCTAssertFalse(scope.admits(windowId: 2, ownerPid: 400, ownedBy: nil, displayId: mainDisplay, laneDisplayId: nil))
    }

    func testOnlyTheClaimPickerListsEverything() {
        let scope = WindowListScope()
        XCTAssertTrue(scope.isUnscoped)
        XCTAssertTrue(scope.admits(windowId: 1, ownerPid: 400, ownedBy: nil, displayId: mainDisplay, laneDisplayId: nil))
    }
}
