import XCTest
@testable import ADECaptureHelperCore

final class ChordDetectorTests: XCTestCase {
    private let left = ModifierMask.leftCommand
    private let right = ModifierMask.rightCommand

    func testFiresOnceWhileBothKeysAreHeld() {
        var detector = ChordDetector()
        XCTAssertFalse(detector.consume(rawFlags: left))
        XCTAssertTrue(detector.consume(rawFlags: left | right))
        // The poll sees the same held keys 25 times a second; only the first
        // sample may be a chord.
        XCTAssertFalse(detector.consume(rawFlags: left | right))
        XCTAssertFalse(detector.consume(rawFlags: left | right))
    }

    func testRearmsAfterEitherKeyIsReleased() {
        var detector = ChordDetector()
        XCTAssertTrue(detector.consume(rawFlags: left | right))
        XCTAssertFalse(detector.consume(rawFlags: right))
        XCTAssertTrue(detector.consume(rawFlags: left | right))
    }

    func testIgnoresASingleCommandKey() {
        var detector = ChordDetector()
        XCTAssertFalse(detector.consume(rawFlags: left))
        XCTAssertFalse(detector.consume(rawFlags: right))
        XCTAssertFalse(detector.consume(rawFlags: 0))
    }

    func testResetDropsTheLatchWithoutFiring() {
        var detector = ChordDetector()
        XCTAssertTrue(detector.consume(rawFlags: left | right))
        detector.reset()
        XCTAssertFalse(detector.isEngaged)
        // Keys still held, but the next sample must not re-fire the gesture the
        // user made while it was switched off.
        XCTAssertTrue(detector.consume(rawFlags: left | right))
    }

    func testParsesKnownCommandsAndIgnoresUnknownOnes() {
        XCTAssertEqual(HelperCommand.parse(line: "{\"type\":\"capture\"}"), .capture)
        XCTAssertEqual(HelperCommand.parse(line: "{\"type\":\"quit\"}"), .quit)
        XCTAssertEqual(
            HelperCommand.parse(line: "{\"type\":\"settings\",\"enabled\":false}"),
            .settings(enabled: false)
        )
        XCTAssertNil(HelperCommand.parse(line: "{\"type\":\"from-a-newer-ade\"}"))
        XCTAssertNil(HelperCommand.parse(line: "not json"))
        XCTAssertNil(HelperCommand.parse(line: ""))
    }

    func testEncodesCapturedEventWithOptionalFieldsOmitted() throws {
        let encoded = try XCTUnwrap(
            HelperEvent.captured(
                path: "/tmp/x.png",
                appName: nil,
                windowTitle: nil,
                ownerPid: nil,
                bounds: nil
            ).encoded()
        )
        XCTAssertEqual(encoded, "{\"path\":\"/tmp/x.png\",\"type\":\"captured\"}\n")
    }
}
