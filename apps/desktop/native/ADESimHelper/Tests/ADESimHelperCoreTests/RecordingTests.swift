import XCTest
@testable import ADESimHelperCore

/// Protocol parsing for the recording commands, and the overlay timeline maths.
///
/// Deliberately no AVFoundation: everything here runs with no booted device, no
/// Xcode-provided private frameworks and no file system. The pixels are covered
/// by the smoke test against a real simulator; what is covered here is the part
/// that a refactor can break silently.
final class RecordingProtocolTests: XCTestCase {
    private func command(_ line: String, file: StaticString = #filePath, line lineNumber: UInt = #line) throws -> SimHelperCommand {
        switch SimHelperCommandParser.parse(line: line) {
        case let .success(command): return command
        case let .failure(failure):
            XCTFail("Expected a command, got \(failure)", file: file, line: lineNumber)
            throw XCTSkip("unreachable")
        }
    }

    private func failure(_ line: String) -> SimHelperParseFailure? {
        switch SimHelperCommandParser.parse(line: line) {
        case .success: return nil
        case let .failure(failure): return failure
        }
    }

    func testParsesRecordStartWithEveryField() throws {
        let parsed = try command(
            ##"{"type":"record-start","id":"r1","udid":"U","path":"/tmp/a.mp4","overlays":false,"fps":24,"accentColor":"#ff8800"}"##
        )
        XCTAssertEqual(parsed, .recordStart(
            id: "r1", udid: "U", path: "/tmp/a.mp4", overlays: false, fps: 24, accentColor: "#ff8800",
            idleCompression: true
        ))
        XCTAssertEqual(parsed.udid, "U")
        XCTAssertEqual(parsed.id, "r1")
    }

    func testRecordStartDefaultsOverlaysOnFpsTo30AndIdleCuttingOn() throws {
        let parsed = try command(#"{"type":"record-start","id":"r","udid":"U","path":"/tmp/a.mp4"}"#)
        XCTAssertEqual(parsed, .recordStart(
            id: "r", udid: "U", path: "/tmp/a.mp4", overlays: true, fps: 30, accentColor: nil,
            idleCompression: true
        ))
    }

    /// `record-start --keep-idle` in ADE arrives as `idleCompression: false`.
    func testRecordStartCanKeepIdleTime() throws {
        let parsed = try command(
            #"{"type":"record-start","id":"r","udid":"U","path":"/tmp/a.mp4","idleCompression":false}"#
        )
        guard case let .recordStart(_, _, _, _, _, _, idleCompression) = parsed else {
            return XCTFail("Expected record-start, got \(parsed)")
        }
        XCTAssertFalse(idleCompression)
    }

    func testRecordStartRejectsMissingPathAndSillyFps() {
        guard case let .invalid(id, message)? = failure(#"{"type":"record-start","id":"r","udid":"U"}"#) else {
            return XCTFail("A record-start with no path must be reported, not accepted.")
        }
        XCTAssertEqual(id, "r")
        XCTAssertTrue(message.contains("path"), message)

        guard case .invalid? = failure(
            #"{"type":"record-start","id":"r","udid":"U","path":"/tmp/a.mp4","fps":240}"#
        ) else {
            return XCTFail("240 fps is not a recording rate this helper offers.")
        }
    }

    func testParsesRecordStopAndOverlayCommands() throws {
        XCTAssertEqual(
            try command(#"{"type":"record-stop","id":"s","udid":"U"}"#),
            .recordStop(id: "s", udid: "U")
        )
        XCTAssertEqual(
            try command(#"{"type":"overlay-tap","id":"t","udid":"U","x":42,"y":99.5}"#),
            .overlayTap(id: "t", udid: "U", point: DevicePoint(x: 42, y: 99.5))
        )
        XCTAssertEqual(
            try command(#"{"type":"overlay-text","id":"x","udid":"U","text":"hello"}"#),
            .overlayText(id: "x", udid: "U", text: "hello", secure: false)
        )
    }

    /// ADE is expected not to send secure text at all. If it does anyway, the
    /// flag has to survive parsing — this is the last place that can stop a
    /// password being burned into an MP4.
    func testOverlayTextCarriesTheSecureFlag() throws {
        XCTAssertEqual(
            try command(#"{"type":"overlay-text","id":"x","udid":"U","text":"hunter2","secure":true}"#),
            .overlayText(id: "x", udid: "U", text: "hunter2", secure: true)
        )
    }

    func testOverlayCommandsRequireADevice() {
        for line in [
            #"{"type":"record-stop","id":"a"}"#,
            #"{"type":"overlay-tap","id":"a","x":1,"y":2}"#,
            #"{"type":"overlay-text","id":"a","text":"t"}"#,
        ] {
            guard case .invalid? = failure(line) else {
                return XCTFail("\(line) has no udid and must be refused.")
            }
        }
    }

    func testRecordEventsEncodeTheContractedShape() throws {
        let started = SimHelperEvent.recordStarted(id: "r", udid: "U", path: "/tmp/a.mp4")
        XCTAssertEqual(started.payload["type"] as? String, "record-started")
        XCTAssertEqual(started.payload["path"] as? String, "/tmp/a.mp4")

        let stopped = SimHelperEvent.recordStopped(
            udid: "U",
            finished: FinishedRecording(path: "/tmp/a.mp4", durationMs: 1234, wallDurationMs: 5000, bytes: 99)
        )
        XCTAssertEqual(stopped.payload["type"] as? String, "record-stopped")
        XCTAssertEqual(stopped.payload["udid"] as? String, "U")
        XCTAssertEqual(stopped.payload["durationMs"] as? Int, 1234)
        XCTAssertEqual(stopped.payload["wallDurationMs"] as? Int, 5000)
        XCTAssertEqual(stopped.payload["idleCutMs"] as? Int, 3766)
        XCTAssertEqual(stopped.payload["bytes"] as? Int, 99)
        XCTAssertNotNil(stopped.encoded())
    }
}

final class RecordingOverlayTests: XCTestCase {
    func testProgressClampsBothEnds() {
        XCTAssertEqual(RecordingOverlay.progress(age: -1, duration: 0.4), 0)
        XCTAssertEqual(RecordingOverlay.progress(age: 0.2, duration: 0.4), 0.5, accuracy: 1e-9)
        XCTAssertEqual(RecordingOverlay.progress(age: 9, duration: 0.4), 1)
        // A zero-length effect is over, not halfway through a division by zero.
        XCTAssertEqual(RecordingOverlay.progress(age: 0, duration: 0), 1)
    }

    func testRingGrowsMonotonicallyAndFadesToNothing() {
        let short = 1000.0
        var previous = -1.0
        for step in 0...10 {
            let p = Double(step) / 10
            let radius = RecordingOverlay.ringRadius(progress: p, frameShortSide: short)
            XCTAssertGreaterThan(radius, previous, "radius must never shrink (p=\(p))")
            previous = radius
        }
        XCTAssertEqual(
            RecordingOverlay.ringRadius(progress: 0, frameShortSide: short),
            short * RecordingOverlay.ringMinRadiusFraction,
            accuracy: 1e-9
        )
        XCTAssertEqual(
            RecordingOverlay.ringRadius(progress: 1, frameShortSide: short),
            short * RecordingOverlay.ringMaxRadiusFraction,
            accuracy: 1e-9
        )

        XCTAssertEqual(RecordingOverlay.ringOpacity(progress: 0), 1, accuracy: 1e-9)
        XCTAssertEqual(RecordingOverlay.ringOpacity(progress: 1), 0, accuracy: 1e-9)
        // Most of the growth is early, so the ring reads as an impact.
        XCTAssertGreaterThan(RecordingOverlay.easeOutCubic(0.33), 0.6)
    }

    func testDotOutlivesLessThanHalfTheRing() {
        XCTAssertEqual(RecordingOverlay.dotOpacity(progress: 0), 1, accuracy: 1e-9)
        XCTAssertEqual(RecordingOverlay.dotOpacity(progress: 0.25), 0.5, accuracy: 1e-9)
        XCTAssertEqual(RecordingOverlay.dotOpacity(progress: 0.5), 0)
        XCTAssertEqual(RecordingOverlay.dotOpacity(progress: 0.9), 0)
    }

    func testBadgeHoldsThenFades() {
        XCTAssertEqual(RecordingOverlay.badgeOpacity(progress: 0), 1, accuracy: 1e-9)
        XCTAssertEqual(RecordingOverlay.badgeOpacity(progress: 0.79), 1, accuracy: 1e-9)
        XCTAssertEqual(RecordingOverlay.badgeOpacity(progress: 0.9), 0.5, accuracy: 1e-9)
        XCTAssertEqual(RecordingOverlay.badgeOpacity(progress: 1), 0, accuracy: 1e-9)
    }

    func testTimelinePrunesByEffectDuration() {
        var timeline = RecordingOverlay.Timeline()
        XCTAssertTrue(timeline.isEmpty)

        timeline.addTap(x: 0.5, y: 0.5, at: 100)
        timeline.setText("hello", at: 100)
        XCTAssertEqual(timeline.rings.count, 1)
        XCTAssertEqual(timeline.badge?.text, "hello")

        // Just before the ring expires: both alive.
        timeline.prune(at: 100 + RecordingOverlay.tapRingDuration - 0.01)
        XCTAssertEqual(timeline.rings.count, 1)
        XCTAssertNotNil(timeline.badge)

        // Ring gone, badge still up — the two clocks are independent.
        timeline.prune(at: 100 + RecordingOverlay.tapRingDuration)
        XCTAssertTrue(timeline.rings.isEmpty)
        XCTAssertNotNil(timeline.badge)

        timeline.prune(at: 100 + RecordingOverlay.textBadgeDuration)
        XCTAssertNil(timeline.badge)
        XCTAssertTrue(timeline.isEmpty)
    }

    func testTimelineCapsRingsSoADragCannotPaintTheScreen() {
        var timeline = RecordingOverlay.Timeline()
        for step in 0..<40 {
            timeline.addTap(x: Double(step) / 40, y: 0.5, at: 200 + Double(step) * 0.001)
        }
        XCTAssertEqual(timeline.rings.count, RecordingOverlay.Timeline.maxRings)
        // The survivors are the newest, not the oldest.
        XCTAssertEqual(timeline.rings.last?.x ?? 0, 39.0 / 40, accuracy: 1e-9)
    }

    func testEmptyTextClearsTheBadge() {
        var timeline = RecordingOverlay.Timeline()
        timeline.setText("typed", at: 1)
        timeline.setText("   ", at: 2)
        XCTAssertNil(timeline.badge)
    }

    func testColourParsing() {
        XCTAssertEqual(RecordingOverlay.parseColour("#ffffff"), RecordingOverlay.Colour(red: 1, green: 1, blue: 1))
        XCTAssertEqual(RecordingOverlay.parseColour("000000"), RecordingOverlay.Colour(red: 0, green: 0, blue: 0))
        XCTAssertEqual(RecordingOverlay.parseColour("#F00"), RecordingOverlay.Colour(red: 1, green: 0, blue: 0))
        // Alpha is accepted on the wire and ignored: the timeline owns alpha.
        XCTAssertEqual(
            RecordingOverlay.parseColour("#00ff0080"),
            RecordingOverlay.Colour(red: 0, green: 1, blue: 0)
        )
        for bad in ["", "   ", "#12", "rgb(1,2,3)", "#gggggg", "#1234567"] {
            XCTAssertNil(RecordingOverlay.parseColour(bad), "\(bad) must not parse")
        }
        XCTAssertNil(RecordingOverlay.parseColour(nil))
    }

    func testBadgeTextKeepsTheTailAndTamesWhitespace() {
        XCTAssertEqual(RecordingOverlay.badgeText(for: "abc"), "abc")
        XCTAssertEqual(RecordingOverlay.badgeText(for: "a\nb\tc"), "a⏎b⇥c")
        let long = String(repeating: "x", count: 10) + String(repeating: "y", count: 60)
        let shown = RecordingOverlay.badgeText(for: long, limit: 12)
        XCTAssertEqual(shown, "…" + String(repeating: "y", count: 12))
    }
}
