import XCTest
@testable import ADEMediaCore

/// The plan's time math: which source time each output frame shows, where the
/// camera looks, and where the pointer is. These decide every pixel of a demo
/// and have no surface of their own to check them through.
final class DemoTimelineTests: XCTestCase {
    private func segment(_ outputStart: Double, _ outputEnd: Double, _ sourceStart: Double, _ sourceEnd: Double) -> DemoSegment {
        DemoSegment(outputStart: outputStart, outputEnd: outputEnd, sourceStart: sourceStart, sourceEnd: sourceEnd)
    }

    func testSourceTimeAcrossCutsSpeedUpsAndZeroLengthSegments() throws {
        // 0-2 s plays 0-2 s; 2-4 s of source is cut; 2-3 s plays 4-12 s at 8×;
        // a zero-length segment at 3 s shows nothing; 3-5 s plays 20-22 s.
        let map = try DemoTimeMap(segments: [
            segment(0, 2, 0, 2),
            segment(2, 3, 4, 12),
            segment(3, 3, 15, 16),
            segment(3, 5, 20, 22),
        ])
        let cases: [(output: Double, source: Double)] = [
            (0, 0),
            (1.5, 1.5),
            (2, 4),
            (2.5, 8),
            (3, 20),
            (4, 21),
            (5, 22),
            // After the end the last picture holds.
            (9, 22),
        ]
        for (output, source) in cases {
            XCTAssertEqual(map.sourceTime(atOutput: output), source, accuracy: 1e-9, "output \(output)")
        }
    }

    func testSourceTimeBeforeFirstSegmentAndInAGap() throws {
        let map = try DemoTimeMap(segments: [segment(1, 2, 5, 6), segment(3, 4, 10, 11)])
        XCTAssertEqual(map.sourceTime(atOutput: 0), 5, "before the first segment: its first picture")
        XCTAssertEqual(map.sourceTime(atOutput: 2.5), 6, "in a gap: the previous segment's last picture")
    }

    func testRefusesPlansThatCannotBeDecodedForward() {
        let bad: [(String, [DemoSegment])] = [
            ("empty", []),
            ("backwards in source", [segment(0, 1, 5, 6), segment(1, 2, 2, 3)]),
            ("overlapping output", [segment(0, 2, 0, 2), segment(1, 3, 2, 4)]),
            ("negative length", [segment(0, 1, 3, 2)]),
            ("not a number", [segment(0, .nan, 0, 1)]),
            ("all zero-length", [segment(1, 1, 0, 1)]),
        ]
        for (name, segments) in bad {
            XCTAssertThrowsError(try DemoTimeMap(segments: segments), name)
        }
        // A millisecond of rounding overlap is not a backwards plan.
        XCTAssertNoThrow(try DemoTimeMap(segments: [segment(0, 1, 0, 1.0004), segment(1, 2, 1.0, 2)]))
    }

    func testFrameClockDoesNotAddAFrameForFloatNoise() throws {
        XCTAssertEqual(try DemoFrameClock(durationSeconds: 0.1 * 3 * 100, fps: 30).frameCount, 900)
        XCTAssertEqual(try DemoFrameClock(durationSeconds: 10.01, fps: 30).frameCount, 301)
        XCTAssertEqual(try DemoFrameClock(durationSeconds: 0.001, fps: 30).frameCount, 1)
        XCTAssertThrowsError(try DemoFrameClock(durationSeconds: 0, fps: 30))
        XCTAssertThrowsError(try DemoFrameClock(durationSeconds: 5, fps: 0))
    }

    func testViewportStaysInsideTheFrame() {
        let cases: [(zoom: Double, cx: Double, cy: Double, expected: DemoViewport)] = [
            (1, 0.9, 0.1, .full),
            (0.5, 0.5, 0.5, .full),
            (.nan, 0.5, 0.5, .full),
            (2, 0.5, 0.5, DemoViewport(x: 0.25, y: 0.25, width: 0.5, height: 0.5)),
            // Pulled in from the corner until it fits.
            (2, 0.95, 0.02, DemoViewport(x: 0.5, y: 0, width: 0.5, height: 0.5)),
            (4, .nan, 0.5, DemoViewport(x: 0.375, y: 0.375, width: 0.25, height: 0.25)),
        ]
        for (zoom, cx, cy, expected) in cases {
            let viewport = DemoViewport(zoom: zoom, cx: cx, cy: cy)
            XCTAssertEqual(viewport.x, expected.x, accuracy: 1e-12, "zoom \(zoom) at \(cx),\(cy)")
            XCTAssertEqual(viewport.y, expected.y, accuracy: 1e-12, "zoom \(zoom) at \(cx),\(cy)")
            XCTAssertEqual(viewport.width, expected.width, accuracy: 1e-12, "zoom \(zoom) at \(cx),\(cy)")
        }
    }

    func testCameraInterpolatesAndHoldsAtTheEnds() {
        let camera = DemoCameraTrack(keys: [
            DemoCameraKey(t: 2, zoom: 3, cx: 0.5, cy: 0.5),
            DemoCameraKey(t: 1, zoom: 1, cx: 0.5, cy: 0.5),
        ])
        XCTAssertEqual(camera.viewport(at: 0), .full)
        XCTAssertEqual(camera.viewport(at: 1.5).width, 0.5, accuracy: 1e-12, "zoom 2 halfway")
        XCTAssertEqual(camera.viewport(at: 9).width, 1.0 / 3, accuracy: 1e-12)
        XCTAssertEqual(DemoCameraTrack(keys: []).viewport(at: 3), .full)
    }

    func testCursorVisibility() {
        let cursor = DemoCursorTrack(keys: [
            DemoCursorKey(t: 1, x: 0, y: 0, visible: true),
            DemoCursorKey(t: 2, x: 1, y: 0.5, visible: true),
            DemoCursorKey(t: 3, x: 0.2, y: 0.2, visible: false),
            DemoCursorKey(t: 4, x: 0.8, y: 0.8, visible: true),
        ])
        XCTAssertNil(cursor.position(at: 0.5), "no pointer before the first key")
        XCTAssertEqual(cursor.position(at: 1.5)?.x ?? -1, 0.5, accuracy: 1e-12)
        XCTAssertEqual(cursor.position(at: 1.5)?.y ?? -1, 0.25, accuracy: 1e-12)
        XCTAssertEqual(cursor.position(at: 2.5)?.x ?? -1, 1, accuracy: 1e-12, "holds before a hidden key")
        XCTAssertNil(cursor.position(at: 3.5))
        XCTAssertEqual(cursor.position(at: 7)?.x ?? -1, 0.8, accuracy: 1e-12)
    }

    func testLayoutMapsSourcePointsThroughTheCamera() {
        // A 2560×1440 source at zoom 2 on its centre, into 1920×1080.
        let layout = DemoFrameLayout(
            sourceWidth: 2560, sourceHeight: 1440, outputWidth: 1920, outputHeight: 1080,
            viewport: DemoViewport(zoom: 2, cx: 0.5, cy: 0.5)
        )
        XCTAssertTrue(layout.fillsOutput)
        let center = layout.outputPoint(x: 0.5, y: 0.5)
        XCTAssertEqual(center.x, 960, accuracy: 1e-9)
        XCTAssertEqual(center.y, 540, accuracy: 1e-9)
        let corner = layout.outputPoint(x: 0.25, y: 0.25)
        XCTAssertEqual(corner.x, 0, accuracy: 1e-9)
        XCTAssertEqual(corner.y, 0, accuracy: 1e-9)

        // A portrait source in a landscape frame is fitted with bars.
        let portrait = DemoFrameLayout(sourceWidth: 1206, sourceHeight: 2622, outputWidth: 1920, outputHeight: 1080, viewport: .full)
        XCTAssertFalse(portrait.fillsOutput)
        XCTAssertEqual(portrait.pictureHeight, 1080, accuracy: 1e-9)
        XCTAssertEqual(portrait.pictureX, (1920 - portrait.pictureWidth) / 2, accuracy: 1e-9)

        // An odd source rounded to an even output is stretched, not barred.
        let odd = DemoFrameLayout(sourceWidth: 1279, sourceHeight: 719, outputWidth: 1278, outputHeight: 718, viewport: .full)
        XCTAssertTrue(odd.fillsOutput)
    }

    func testRingGrowsAndFadesOverItsLife() {
        let style = DemoStyle(
            accent: "#7C5CFF", ringDurationSeconds: 0.5, ringStartRadius: 0.02, ringEndRadius: 0.06,
            ringLineWidth: 0.004, pointerHeight: 0.03, captionFontSize: 0.03, captionMargin: 0.05, badgeFontSize: 0.02
        )
        let layout = DemoFrameLayout(sourceWidth: 1000, sourceHeight: 1000, outputWidth: 1000, outputHeight: 1000, viewport: .full)
        let ring = DemoRing(t: 1, x: 0.5, y: 0.5)
        XCTAssertNil(DemoOverlayGeometry.ring(ring, at: 0.99, style: style, layout: layout))
        XCTAssertNil(DemoOverlayGeometry.ring(ring, at: 1.5, style: style, layout: layout))
        let start = DemoOverlayGeometry.ring(ring, at: 1, style: style, layout: layout)!
        XCTAssertEqual(start.radius, 20, accuracy: 1e-9)
        XCTAssertEqual(start.alpha, 1, accuracy: 1e-9)
        let middle = DemoOverlayGeometry.ring(ring, at: 1.25, style: style, layout: layout)!
        // Ease-out: three quarters of the growth by half its life.
        XCTAssertEqual(middle.radius, 20 + 40 * 0.75, accuracy: 1e-9)
        XCTAssertEqual(middle.alpha, 0.5, accuracy: 1e-9)
    }
}
