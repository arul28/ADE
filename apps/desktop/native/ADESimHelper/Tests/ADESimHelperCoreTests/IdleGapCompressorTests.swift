import XCTest
@testable import ADESimHelperCore

/// The idle-cut timeline, driven the way `RecordingSession`'s pacer drives it:
/// a tick every frame interval, activity noted before the tick that sees it.
final class IdleGapCompressorTests: XCTestCase {
    private let tick = 1.0 / 30

    private struct Run {
        var frames: [(input: TimeInterval, output: TimeInterval)] = []
        var end: TimeInterval = 0
    }

    /// Ticks from 0 to `stop`. `activity` is the times something happened;
    /// `overlays` are tap rings (alive for `tapRingDuration`), which the
    /// session reports as activity on every tick they are on screen.
    private func run(
        _ compressor: inout IdleGapCompressor,
        activity: [TimeInterval],
        overlays: [TimeInterval] = [],
        stop: TimeInterval
    ) -> Run {
        var result = Run()
        var pending = activity.sorted()
        var time = 0.0
        while time <= stop {
            while let next = pending.first, next <= time {
                compressor.noteActivity(at: next)
                pending.removeFirst()
            }
            if overlays.contains(where: { time >= $0 && time - $0 < RecordingOverlay.tapRingDuration }) {
                compressor.noteActivity(at: time)
            }
            if let output = compressor.presentationTime(at: time) {
                result.frames.append((time, output))
            }
            time += tick
        }
        result.end = compressor.endTime(at: stop)
        return result
    }

    private func assertStrictlyIncreasing(_ run: Run, file: StaticString = #filePath, line: UInt = #line) {
        let step = IdleGapCompressor().minimumStep
        for (previous, next) in zip(run.frames, run.frames.dropFirst()) {
            XCTAssertGreaterThanOrEqual(next.output - previous.output, step - 1e-9, file: file, line: line)
        }
        if let last = run.frames.last {
            XCTAssertGreaterThan(run.end, last.output, "the last frame must have a duration", file: file, line: line)
        }
    }

    func testNoIdleTimeKeepsWallClock() {
        var compressor = IdleGapCompressor()
        let activity = stride(from: 0.0, through: 10, by: 0.5).map { $0 }
        let result = run(&compressor, activity: activity, stop: 10)
        for frame in result.frames {
            XCTAssertEqual(frame.output, frame.input, accuracy: 1e-9)
        }
        XCTAssertEqual(result.end, 10, accuracy: tick)
        XCTAssertEqual(compressor.cut, 0)
        assertStrictlyIncreasing(result)
    }

    func testOneLongStillKeepsOnlyTheHold() {
        var compressor = IdleGapCompressor()
        // Busy until 2 s, frozen until 12 s, busy again until 14 s.
        let activity = [0.0, 1, 2, 12, 13, 14]
        let result = run(&compressor, activity: activity, stop: 14)

        XCTAssertEqual(compressor.cut, 10 - IdleGapCompressor.defaultKeptHold, accuracy: 1e-9)
        XCTAssertEqual(result.end, 14 - compressor.cut, accuracy: tick)
        // Nothing is written while the still is held past 0.75 s.
        XCTAssertFalse(result.frames.contains { $0.input > 2.76 && $0.input < 12 - 1e-9 })
        // The first frame after the still lands right after the kept hold.
        let resumed = result.frames.first { $0.input >= 12 - 1e-9 }!
        XCTAssertEqual(resumed.output, 2 + IdleGapCompressor.defaultKeptHold, accuracy: tick + 1e-9)
        assertStrictlyIncreasing(result)
    }

    func testAShortStillIsNotCut() {
        var compressor = IdleGapCompressor()
        // 1.5 s of stillness is under the threshold.
        let result = run(&compressor, activity: [0, 1, 2.5, 3], stop: 3.5)
        XCTAssertEqual(compressor.cut, 0)
        let resumed = result.frames.first { $0.input >= 2.5 - 1e-9 }!
        XCTAssertEqual(resumed.output, resumed.input, accuracy: 1e-9)
        XCTAssertEqual(result.end, 3.5, accuracy: tick)
        assertStrictlyIncreasing(result)
    }

    func testManyStillsEachKeepTheirHold() {
        var compressor = IdleGapCompressor()
        // Five bursts, each followed by ten seconds of nothing.
        let activity = (0..<5).flatMap { burst -> [TimeInterval] in
            let start = Double(burst) * 11
            return [start, start + 0.5, start + 1]
        } + [55]
        let result = run(&compressor, activity: activity, stop: 55.5)
        XCTAssertEqual(compressor.cut, 5 * (10 - IdleGapCompressor.defaultKeptHold), accuracy: 1e-9)
        XCTAssertEqual(result.end, 55.5 - compressor.cut, accuracy: tick)
        assertStrictlyIncreasing(result)
    }

    func testAnOverlayInsideAStillPlaysInFull() {
        var compressor = IdleGapCompressor()
        // A tap at 5 s on a screen that never changes, then nothing until 20 s.
        let result = run(&compressor, activity: [0], overlays: [5], stop: 20)
        let ring = result.frames.filter { $0.input >= 5 - 1e-9 && $0.input < 5 + RecordingOverlay.tapRingDuration }
        XCTAssertGreaterThanOrEqual(ring.count, 11, "every tick of the ring animation is written")
        for (previous, next) in zip(ring, ring.dropFirst()) {
            // Real-time spacing: the animation is not cut or sped up.
            XCTAssertEqual(next.output - previous.output, next.input - previous.input, accuracy: 1e-9)
        }
        // The still before the tap was cut, and so was the one after it.
        XCTAssertEqual(ring.first!.output, IdleGapCompressor.defaultKeptHold, accuracy: tick + 1e-9)
        let lastRing = ring.last!
        XCTAssertEqual(result.end, lastRing.output + IdleGapCompressor.defaultKeptHold, accuracy: tick + 1e-9)
        assertStrictlyIncreasing(result)
    }

    func testAStillAtTheEndKeepsTheHold() {
        var compressor = IdleGapCompressor()
        let result = run(&compressor, activity: [0, 1, 3], stop: 60)
        XCTAssertEqual(result.end, 3 + IdleGapCompressor.defaultKeptHold, accuracy: 1e-9)
        XCTAssertTrue(compressor.isHolding(at: 60))
        XCTAssertEqual(60 - result.end, 60 - 3 - IdleGapCompressor.defaultKeptHold, accuracy: 1e-9, "the cut")
        assertStrictlyIncreasing(result)
    }

    func testAFinalPictureLandsInsideTheHold() {
        var compressor = IdleGapCompressor()
        // Gaps under the threshold, then a still from 3 s to the stop.
        let result = run(&compressor, activity: [0, 1, 1.9, 3], stop: 30)
        let last = result.frames.last!.output
        let final = compressor.finalFrameTime(at: 30)
        let end = compressor.endTime(at: 30)
        XCTAssertGreaterThan(final, last)
        XCTAssertEqual(final, 3 + IdleGapCompressor.defaultKeptHold, accuracy: 1e-9)
        // On screen for half a hold, not a single frame.
        XCTAssertEqual(end - final, IdleGapCompressor.defaultKeptHold / 2, accuracy: 1e-9)
    }

    func testOutputIsStrictlyIncreasingForAnyActivity() {
        var seed: UInt64 = 0x2545_F491_4F6C_DD1D
        func random() -> Double {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Double(seed >> 11) / Double(1 << 53)
        }
        for _ in 0..<20 {
            var compressor = IdleGapCompressor()
            var activity: [TimeInterval] = []
            var time = 0.0
            while time < 120 {
                // Mostly short gaps, sometimes a long one.
                time += random() < 0.2 ? random() * 30 : random() * 1.5
                activity.append(time)
            }
            let taps = activity.filter { _ in random() < 0.1 }
            let result = run(&compressor, activity: activity, overlays: taps, stop: 120)
            assertStrictlyIncreasing(result)
            XCTAssertLessThanOrEqual(result.end, 120 + tick)
        }
    }

    func testDisabledIsWallClock() {
        var compressor = IdleGapCompressor(enabled: false)
        let result = run(&compressor, activity: [0, 1], stop: 30)
        XCTAssertGreaterThanOrEqual(result.frames.count, 900)
        for frame in result.frames {
            XCTAssertEqual(frame.output, frame.input, accuracy: 1e-9)
        }
        XCTAssertFalse(compressor.isHolding(at: 30))
        XCTAssertEqual(result.end, 30, accuracy: tick)
    }

    func testKeptHoldNeverExceedsTheThreshold() {
        let compressor = IdleGapCompressor(threshold: 0.5, keptHold: 2)
        XCTAssertEqual(compressor.keptHold, 0.5)
    }
}

final class ScreenChangeTests: XCTestCase {
    private func blank(_ width: Int = 118, _ height: Int = 256, value: UInt8 = 240) -> ScreenChange.Thumbnail {
        ScreenChange.Thumbnail(width: width, height: height, luma: [UInt8](repeating: value, count: width * height))
    }

    private func painting(
        _ base: ScreenChange.Thumbnail,
        x: Range<Int>,
        y: Range<Int>,
        value: UInt8
    ) -> ScreenChange.Thumbnail {
        var copy = base
        for row in y {
            for column in x { copy.luma[row * base.width + column] = value }
        }
        return copy
    }

    func testIdenticalPicturesAreNotAChange() {
        XCTAssertFalse(ScreenChange.isSignificant(reference: blank(), current: blank()))
    }

    func testABlinkingCaretIsNotAChange() {
        // A caret is about one pixel wide and six tall at thumbnail scale.
        let caret = painting(blank(), x: 40..<41, y: 100..<106, value: 60)
        XCTAssertFalse(ScreenChange.isSignificant(reference: blank(), current: caret))
    }

    func testFaintNoiseIsNotAChange() {
        XCTAssertFalse(ScreenChange.isSignificant(reference: blank(value: 240), current: blank(value: 225)))
    }

    func testANewLabelIsAChange() {
        let label = painting(blank(), x: 10..<60, y: 50..<56, value: 30)
        XCTAssertTrue(ScreenChange.isSignificant(reference: blank(), current: label))
    }

    func testAResizeIsAChange() {
        XCTAssertTrue(ScreenChange.isSignificant(reference: blank(118, 256), current: blank(256, 118)))
    }

    func testSmallChangesAddUpAgainstTheReference() {
        let reference = blank()
        var current = reference
        var counted = false
        // A progress bar growing a pixel column at a time.
        for column in 0..<80 {
            current = painting(current, x: column..<(column + 1), y: 200..<203, value: 20)
            if ScreenChange.isSignificant(reference: reference, current: current) {
                counted = true
                break
            }
        }
        XCTAssertTrue(counted)
    }
}
