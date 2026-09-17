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
        XCTAssertEqual(gate.dequeue(), first)
        XCTAssertEqual(gate.dequeue(), second)
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
