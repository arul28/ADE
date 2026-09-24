import Foundation
import XCTest
@testable import ADESimHelperCore

/// `device-reset` at the runtime level, with no CoreSimulator in the loop.
///
/// A session is made by any device command; `screenshot` is used because it
/// fails with `not-capturing` before it reaches CoreSimulator, so the test
/// never touches a real simulator. The injected metrics lookup counts how many
/// sessions were BUILT, which is the thing a reset has to change: the live bug
/// (2026-09-23) was a session built against the previous boot being reused.
final class SimHelperRuntimeTests: XCTestCase {
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var events: [[String: Any]] = []
        private var lookups = 0

        func record(_ event: SimHelperEvent) {
            lock.lock(); defer { lock.unlock() }
            events.append(event.payload)
        }

        func noteLookup() {
            lock.lock(); defer { lock.unlock() }
            lookups += 1
        }

        var lookupCount: Int {
            lock.lock(); defer { lock.unlock() }
            return lookups
        }

        func reply(to id: String) -> [String: Any]? {
            lock.lock(); defer { lock.unlock() }
            return events.last { ($0["id"] as? String) == id }
        }

        var types: [String] {
            lock.lock(); defer { lock.unlock() }
            return events.compactMap { $0["type"] as? String }
        }
    }

    private func makeRuntime() -> (SimHelperRuntime, Recorder) {
        let recorder = Recorder()
        let runtime = SimHelperRuntime(
            emit: { event in recorder.record(event) },
            metricsLookup: { _ in
                recorder.noteLookup()
                return DeviceMetrics(pointWidth: 393, pointHeight: 852, scale: 3)
            }
        )
        return (runtime, recorder)
    }

    func testDeviceResetDropsTheSessionSoTheNextCommandBuildsAFreshOne() async {
        let (runtime, recorder) = makeRuntime()

        _ = await runtime.handle(line: #"{"type":"screenshot","id":"s1","udid":"U","path":"/tmp/x.png"}"#)
        _ = await runtime.handle(line: #"{"type":"screenshot","id":"s2","udid":"U","path":"/tmp/x.png"}"#)
        XCTAssertEqual(recorder.lookupCount, 1, "a live session is reused between commands")
        let hasSessionBeforeReset = await runtime.hasSession(for: "U")
        XCTAssertTrue(hasSessionBeforeReset)

        let keepGoing = await runtime.handle(line: #"{"type":"device-reset","id":"r1","udid":"U"}"#)
        XCTAssertTrue(keepGoing)
        let reply = recorder.reply(to: "r1")
        XCTAssertEqual(reply?["type"] as? String, "ok")
        XCTAssertEqual(reply?["reset"] as? Bool, true)
        let hasSessionAfterReset = await runtime.hasSession(for: "U")
        XCTAssertFalse(hasSessionAfterReset)
        // Nothing was capturing, so nothing is announced as stopped.
        XCTAssertFalse(recorder.types.contains("capture-stopped"))

        _ = await runtime.handle(line: #"{"type":"screenshot","id":"s3","udid":"U","path":"/tmp/x.png"}"#)
        XCTAssertEqual(recorder.lookupCount, 2, "the command after a reset builds a new session")
    }

    func testDeviceResetForAnUnknownDeviceIsANoOpSuccess() async {
        let (runtime, recorder) = makeRuntime()

        _ = await runtime.handle(line: #"{"type":"device-reset","id":"r1","udid":"NEVER-SEEN"}"#)

        let reply = recorder.reply(to: "r1")
        XCTAssertEqual(reply?["type"] as? String, "ok")
        XCTAssertEqual(reply?["reset"] as? Bool, false)
        // A reset must not create the session it was asked to drop.
        XCTAssertEqual(recorder.lookupCount, 0)
    }

    func testDeviceResetLeavesOtherDevicesAlone() async {
        let (runtime, _) = makeRuntime()
        _ = await runtime.handle(line: #"{"type":"screenshot","id":"a","udid":"A","path":"/tmp/x.png"}"#)
        _ = await runtime.handle(line: #"{"type":"screenshot","id":"b","udid":"B","path":"/tmp/x.png"}"#)

        _ = await runtime.handle(line: #"{"type":"device-reset","id":"r","udid":"A"}"#)

        let aSession = await runtime.hasSession(for: "A")
        let bSession = await runtime.hasSession(for: "B")
        XCTAssertFalse(aSession)
        XCTAssertTrue(bSession)
    }
}
