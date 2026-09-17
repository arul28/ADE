import XCTest
@testable import ADEDesktopDriverCore

final class OwnershipRegistryTests: XCTestCase {
    func testASingleInstanceAppRefusalNamesTheHoldingLane() {
        let registry = OwnershipRegistry()
        try? registry.park(laneId: "lane-a", windowId: 1, bundleId: "com.apple.dt.Xcode", singleInstance: true)
        XCTAssertThrowsError(
            try registry.park(laneId: "lane-b", windowId: 2, bundleId: "com.apple.dt.Xcode", singleInstance: true)
        ) { error in
            XCTAssertEqual(
                error as? OwnershipError,
                .appOwnedByOtherLane(bundleId: "com.apple.dt.Xcode", holderLaneId: "lane-a")
            )
            let driverError = (error as? OwnershipError)?.driverError
            XCTAssertEqual(driverError?.code, DriverErrorCode.appOwnedByOtherLane)
            // The whole point of the rule: the message says who to go and ask.
            XCTAssertTrue(driverError?.message.contains("lane-a") == true)
        }
    }

    func testTheHoldingLaneCanKeepParkingItsOwnSingleInstanceWindows() {
        let registry = OwnershipRegistry()
        XCTAssertNoThrow(
            try registry.park(laneId: "lane-a", windowId: 1, bundleId: "com.apple.dt.Xcode", singleInstance: true)
        )
        XCTAssertNoThrow(
            try registry.park(laneId: "lane-a", windowId: 2, bundleId: "com.apple.dt.Xcode", singleInstance: true)
        )
        XCTAssertEqual(registry.windows(forLane: "lane-a").count, 2)
    }

    func testMultiInstanceAppsAreNotRefused() {
        let registry = OwnershipRegistry()
        XCTAssertNoThrow(try registry.park(laneId: "lane-a", windowId: 1, bundleId: "com.apple.TextEdit"))
        XCTAssertNoThrow(try registry.park(laneId: "lane-b", windowId: 2, bundleId: "com.apple.TextEdit"))
    }

    func testOneWindowCannotBeParkedByTwoLanes() {
        let registry = OwnershipRegistry()
        try? registry.park(laneId: "lane-a", windowId: 7, bundleId: nil)
        XCTAssertThrowsError(try registry.park(laneId: "lane-b", windowId: 7, bundleId: nil)) { error in
            XCTAssertEqual(error as? OwnershipError, .windowOwnedByOtherLane(windowId: 7, holderLaneId: "lane-a"))
        }
        XCTAssertNoThrow(try registry.park(laneId: "lane-a", windowId: 7, bundleId: nil))
    }

    func testReleasingALaneHandsBackEveryWindowItHeld() {
        let registry = OwnershipRegistry()
        try? registry.park(laneId: "lane-a", windowId: 3, bundleId: nil)
        try? registry.park(laneId: "lane-a", windowId: 1, bundleId: nil)
        try? registry.park(laneId: "lane-b", windowId: 2, bundleId: nil)
        let released = registry.releaseLane("lane-a")
        XCTAssertEqual(released.map(\.windowId), [1, 3])
        XCTAssertNil(registry.owner(ofWindow: 3))
        XCTAssertEqual(registry.owner(ofWindow: 2), "lane-b")
    }

    func testSingleInstanceHolderIsForgottenOnceTheWindowIsUnparked() {
        let registry = OwnershipRegistry()
        try? registry.park(laneId: "lane-a", windowId: 1, bundleId: "com.apple.dt.Xcode", singleInstance: true)
        XCTAssertEqual(registry.singleInstanceHolder(bundleId: "com.apple.dt.Xcode"), "lane-a")
        registry.unpark(windowId: 1)
        XCTAssertNil(registry.singleInstanceHolder(bundleId: "com.apple.dt.Xcode"))
        XCTAssertNoThrow(
            try registry.park(laneId: "lane-b", windowId: 2, bundleId: "com.apple.dt.Xcode", singleInstance: true)
        )
    }
}
