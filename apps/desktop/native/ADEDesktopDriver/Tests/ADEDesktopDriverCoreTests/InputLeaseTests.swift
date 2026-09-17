import XCTest
@testable import ADEDesktopDriverCore
@testable import ADEDesktopDriver

/// The refusal, unit-tested.
///
/// These tests never post a `CGEvent`. They exercise `RealInput.authorize`,
/// which is the check every posting method calls first — testing the post
/// itself would mean moving the pointer of whatever machine ran the suite.
final class InputLeaseTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_700_000_000)

    private func store(expiringIn seconds: TimeInterval, holderId: String = "chat-1") -> InputLeaseStore {
        let store = InputLeaseStore()
        store.set(
            InputLease(
                laneId: "lane-a",
                holderId: holderId,
                expiresAtMs: (now.timeIntervalSince1970 + seconds) * 1000
            )
        )
        return store
    }

    func testRealInputRefusesWhenNoLeaseExists() {
        let input = RealInput(leases: InputLeaseStore(), log: { _ in })
        XCTAssertThrowsError(try input.authorize(laneId: "lane-a", holderId: "chat-1", now: now)) { error in
            XCTAssertEqual((error as? DriverError)?.code, DriverErrorCode.inputLeaseRequired)
        }
    }

    func testRealInputRefusesAnExpiredLease() {
        let input = RealInput(leases: store(expiringIn: -1), log: { _ in })
        XCTAssertThrowsError(try input.authorize(laneId: "lane-a", holderId: "chat-1", now: now)) { error in
            XCTAssertEqual((error as? DriverError)?.code, DriverErrorCode.inputLeaseRequired)
            XCTAssertTrue((error as? DriverError)?.message.contains("lapsed") == true)
        }
    }

    func testRealInputRefusesAHolderTheLeaseIsNotHeldBy() {
        let input = RealInput(leases: store(expiringIn: 60, holderId: "chat-1"), log: { _ in })
        XCTAssertThrowsError(try input.authorize(laneId: "lane-a", holderId: "chat-2", now: now)) { error in
            XCTAssertEqual((error as? DriverError)?.code, DriverErrorCode.inputLeaseRequired)
            XCTAssertTrue((error as? DriverError)?.message.contains("chat-1") == true)
        }
    }

    func testRealInputAllowsTheHolderWhileTheLeaseIsLive() throws {
        let input = RealInput(leases: store(expiringIn: 60), log: { _ in })
        let lease = try input.authorize(laneId: "lane-a", holderId: "chat-1", now: now)
        XCTAssertEqual(lease.holderId, "chat-1")
        // A caller that names no holder is still inside the lease.
        XCTAssertNoThrow(try input.authorize(laneId: "lane-a", holderId: nil, now: now))
    }

    func testALeaseOnAnotherLaneIsNoHelp() {
        let input = RealInput(leases: store(expiringIn: 60), log: { _ in })
        XCTAssertThrowsError(try input.authorize(laneId: "lane-b", holderId: "chat-1", now: now))
    }

    func testClearingALeaseRefusesImmediately() {
        let leases = store(expiringIn: 60)
        let input = RealInput(leases: leases, log: { _ in })
        XCTAssertNoThrow(try input.authorize(laneId: "lane-a", holderId: "chat-1", now: now))
        XCTAssertNotNil(leases.clear(laneId: "lane-a"))
        XCTAssertThrowsError(try input.authorize(laneId: "lane-a", holderId: "chat-1", now: now))
    }

    func testExpiryIsReadFromEpochMillisecondsOrAnISOString() {
        XCTAssertEqual(InputLeaseStore.expiryMilliseconds(.int(1_700_000_000_000)), 1_700_000_000_000)
        XCTAssertEqual(
            InputLeaseStore.expiryMilliseconds(.string("2023-11-14T22:13:20Z")),
            1_700_000_000_000
        )
        XCTAssertEqual(
            InputLeaseStore.expiryMilliseconds(.string("2023-11-14T22:13:20.500Z")),
            1_700_000_000_500
        )
        XCTAssertNil(InputLeaseStore.expiryMilliseconds(.string("whenever")))
        XCTAssertNil(InputLeaseStore.expiryMilliseconds(nil))
    }

    func testAMalformedLeaseObjectGrantsNothing() {
        let request = DriverRequest(
            id: "1",
            op: "input",
            fields: ["lease": .object(["holderId": .string("chat-1")])]
        )
        XCTAssertNil(InputLeaseStore.parse(laneId: "lane-a", from: request))

        let good = DriverRequest(
            id: "1",
            op: "input",
            fields: [
                "lease": .object([
                    "holderId": .string("chat-1"),
                    "expiresAt": .double(1_700_000_060_000),
                ])
            ]
        )
        XCTAssertEqual(InputLeaseStore.parse(laneId: "lane-a", from: good)?.holderId, "chat-1")
    }
}
