import Foundation
import XCTest
@testable import ADEDesktopDriverCore

/// ⌘W and ⌘Q on a lane app must act on the lane's window, never the user's.
final class LaneShortcutTests: XCTestCase {
    func testOtherKeysAndShortcutsArePostedAsKeys() {
        XCTAssertEqual(LaneShortcut.plan(key: "return", modifiers: [], appBelongsToLane: true), .keys)
        XCTAssertEqual(LaneShortcut.plan(key: "s", modifiers: ["cmd"], appBelongsToLane: false), .keys)
        XCTAssertEqual(LaneShortcut.plan(key: "return", modifiers: ["cmd"], appBelongsToLane: true), .keys)
    }

    func testCommandWClosesTheLaneWindowItself() {
        XCTAssertEqual(LaneShortcut.plan(key: "w", modifiers: ["cmd"], appBelongsToLane: false), .closeLaneWindow)
    }

    func testCommandQQuitsOnlyAnAppTheLaneLaunchedAndHoldsWhole() {
        XCTAssertEqual(LaneShortcut.plan(key: "q", modifiers: ["command"], appBelongsToLane: false), .refuseQuit)
        XCTAssertEqual(LaneShortcut.plan(key: "q", modifiers: ["cmd"], appBelongsToLane: true), .quitLaneApp)
    }

    func testModifiedQIsNeverTreatedAsQuit() {
        // ⇧⌘Q is Log Out and ⌃⌘Q is Lock Screen in the Apple menu: never a quit,
        // and never a menu search — they stay plain keys to the lane process.
        XCTAssertEqual(LaneShortcut.plan(key: "q", modifiers: ["cmd", "shift"], appBelongsToLane: true), .keys)
        XCTAssertEqual(LaneShortcut.plan(key: "q", modifiers: ["cmd", "ctrl"], appBelongsToLane: true), .keys)
    }
}
