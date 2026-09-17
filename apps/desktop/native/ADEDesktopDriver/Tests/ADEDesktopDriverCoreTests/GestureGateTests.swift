import Foundation
import XCTest
@testable import ADEDesktopDriverCore

/// The ordering rules that keep a request from landing inside a held mouse
/// button. No CGEvent is posted here and none needs to be: the gate is pure, so
/// what a nested request would have done is decided without a window server.
final class GestureGateTests: XCTestCase {
    private func request(_ op: String, _ fields: [String: JSONValue] = [:]) -> DriverRequest {
        DriverRequest(id: "req-\(op)", op: op, fields: fields)
    }

    private func gate(activeOn laneId: String? = nil) throws -> GestureGate {
        let gate = GestureGate()
        if let laneId { try gate.begin(laneId: laneId) }
        return gate
    }

    func testEverythingProceedsWhenNoGestureIsInFlight() {
        let gate = GestureGate()
        XCTAssertFalse(gate.isActive)
        for op in ["input", "display.destroy", "window.unpark", "present", "ping"] {
            XCTAssertEqual(gate.decide(request(op, ["laneId": .string("lane-a")])), .proceed)
        }
    }

    func testInputFromAnyLaneIsDeferredDuringAGesture() throws {
        let gate = try gate(activeOn: "lane-a")
        XCTAssertEqual(gate.decide(request("input", ["laneId": .string("lane-a")])), .deferred)
        XCTAssertEqual(gate.decide(request("input", ["laneId": .string("lane-b")])), .deferred)
    }

    func testTeardownIsDeferredOnlyForTheGesturingLane() throws {
        let gate = try gate(activeOn: "lane-a")
        for op in ["display.destroy", "present"] {
            XCTAssertEqual(gate.decide(request(op, ["laneId": .string("lane-a")])), .deferred)
            XCTAssertEqual(gate.decide(request(op, ["laneId": .string("lane-b")])), .proceed)
        }
    }

    func testUnparkIsDeferredRegardlessOfLaneBecauseItNamesOnlyAWindow() throws {
        let gate = try gate(activeOn: "lane-a")
        XCTAssertEqual(gate.decide(request("window.unpark", ["windowId": .int(7)])), .deferred)
    }

    /// `window.park` ends in a `setFrame` exactly like `window.unpark`, and it
    /// names a window rather than a lane, so it is deferred on any lane.
    func testParkIsDeferredRegardlessOfLane() throws {
        let gate = try gate(activeOn: "lane-a")
        for laneId in ["lane-a", "lane-b"] {
            XCTAssertEqual(
                gate.decide(request("window.park", ["laneId": .string(laneId), "windowId": .int(7)])),
                .deferred
            )
        }
    }

    /// A launch can activate an app and raise its window under the moving
    /// pointer, so it waits out the gesture whichever lane asked for it.
    func testLaunchIsDeferredRegardlessOfLane() throws {
        let gate = try gate(activeOn: "lane-a")
        for laneId in ["lane-a", "lane-b"] {
            XCTAssertEqual(
                gate.decide(request("app.launch", ["laneId": .string(laneId), "target": .string("Safari")])),
                .deferred
            )
        }
    }

    /// `input {command:"wait"}` posts no events, and it blocks for up to 120 s.
    /// Parking it would hold everything behind it past the client's timeout for
    /// no safety gain at all.
    func testWaitInputProceedsDuringAGesture() throws {
        let gate = try gate(activeOn: "lane-a")
        XCTAssertEqual(
            gate.decide(request("input", ["laneId": .string("lane-a"), "command": .string("wait")])),
            .proceed
        )
        XCTAssertEqual(
            gate.decide(request("input", ["laneId": .string("lane-b"), "command": .string("wait")])),
            .proceed
        )
        XCTAssertEqual(
            gate.decide(request("input", ["laneId": .string("lane-a"), "command": .string("click")])),
            .deferred
        )
    }

    /// A parked request that outlived the caller is answered, not replayed.
    func testStaleDeferredRequestsExpireInsteadOfRunning() throws {
        let clock = MutableClock()
        let gate = GestureGate(now: { clock.value })
        try gate.begin(laneId: "lane-a")
        let stale = request("input", ["laneId": .string("lane-a"), "command": .string("click")])
        gate.enqueue(stale)
        clock.advance(by: GestureGate.deferredTTL + 1)
        let fresh = DriverRequest(id: "fresh", op: "input", fields: ["laneId": .string("lane-a")])
        gate.enqueue(fresh)
        gate.end()

        guard case .expired(let expiredRequest, let error) = gate.dequeue() else {
            return XCTFail("a request parked longer than the TTL must not be replayed")
        }
        XCTAssertEqual(expiredRequest, stale)
        XCTAssertEqual(error.code, DriverErrorCode.deferredExpired)
        XCTAssertTrue(error.message.contains(stale.id), "the caller has to be answerable on its own id")
        // The one enqueued after the clock moved is still inside its window.
        XCTAssertEqual(gate.dequeue(), .run(fresh))
        XCTAssertNil(gate.dequeue())
    }

    func testReconcileIsDeferredOnlyWhenItWouldDestroyTheGesturingLane() throws {
        let gate = try gate(activeOn: "lane-a")
        XCTAssertEqual(
            gate.decide(request("display.reconcile", ["liveLaneIds": .array([.string("lane-a")])])),
            .proceed
        )
        XCTAssertEqual(
            gate.decide(request("display.reconcile", ["liveLaneIds": .array([.string("lane-b")])])),
            .deferred
        )
    }

    func testHealthAndObservationKeepAnsweringDuringAGesture() throws {
        let gate = try gate(activeOn: "lane-a")
        for op in ["ping", "observe", "window.list", "capture.screenshot", "lease.set"] {
            XCTAssertEqual(
                gate.decide(request(op, ["laneId": .string("lane-a")])),
                .proceed,
                "\(op) must not be held behind a gesture"
            )
        }
    }

    func testUnknownOpsAreNeverDeferred() throws {
        let gate = try gate(activeOn: "lane-a")
        XCTAssertEqual(gate.decide(request("some.future.op", ["laneId": .string("lane-a")])), .proceed)
    }

    func testDeferredRequestsDrainInArrivalOrderAfterTheGestureEnds() throws {
        let gate = try gate(activeOn: "lane-a")
        let first = request("input", ["laneId": .string("lane-b")])
        let second = DriverRequest(id: "second", op: "display.destroy", fields: ["laneId": .string("lane-a")])
        gate.enqueue(first)
        gate.enqueue(second)
        XCTAssertEqual(gate.deferredCount, 2)
        gate.end()
        XCTAssertFalse(gate.isActive)
        XCTAssertEqual(gate.dequeue(), .run(first))
        XCTAssertEqual(gate.dequeue(), .run(second))
        XCTAssertNil(gate.dequeue())
    }

    func testAFullQueueRejectsInsteadOfGrowing() throws {
        let gate = try gate(activeOn: "lane-a")
        for index in 0..<GestureGate.maxDeferred {
            let line = DriverRequest(id: "r\(index)", op: "input", fields: ["laneId": .string("lane-a")])
            XCTAssertEqual(gate.decide(line), .deferred)
            gate.enqueue(line)
        }
        guard case .rejected(let error) = gate.decide(request("input", ["laneId": .string("lane-a")])) else {
            return XCTFail("a full gesture queue must refuse rather than grow")
        }
        XCTAssertEqual(error.code, DriverErrorCode.internalError)
    }

    func testOverlappingGesturesAreRefused() throws {
        let gate = try gate(activeOn: "lane-a")
        XCTAssertThrowsError(try gate.begin(laneId: "lane-b")) { error in
            XCTAssertEqual((error as? DriverError)?.code, DriverErrorCode.internalError)
        }
        gate.end()
        XCTAssertNoThrow(try gate.begin(laneId: "lane-b"))
        XCTAssertEqual(gate.activeLaneId, "lane-b")
    }

    func testEndIsIdempotent() throws {
        let gate = try gate(activeOn: "lane-a")
        gate.end()
        gate.end()
        XCTAssertFalse(gate.isActive)
    }
}

/// A clock the expiry test can move without sleeping.
private final class MutableClock: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = Date(timeIntervalSince1970: 1_700_000_000)

    var value: Date {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }

    func advance(by interval: TimeInterval) {
        lock.lock()
        stored = stored.addingTimeInterval(interval)
        lock.unlock()
    }
}
