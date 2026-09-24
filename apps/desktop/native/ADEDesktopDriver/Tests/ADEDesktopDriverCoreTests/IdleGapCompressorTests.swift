import AVFoundation
import CoreVideo
import XCTest
@testable import ADEDesktopDriver
@testable import ADEDesktopDriverCore

/// The idle-cut timeline, driven by a steady tick: a frame every interval,
/// activity noted before the frame that sees it. The same cases as the Apple
/// helper's tests, minus its overlays, so the two ports cannot drift apart.
final class IdleGapCompressorTests: XCTestCase {
    private let tick = 1.0 / 30

    private struct Run {
        var frames: [(input: TimeInterval, output: TimeInterval)] = []
        var end: TimeInterval = 0
    }

    private func run(
        _ compressor: inout IdleGapCompressor,
        activity: [TimeInterval],
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
        let result = run(&compressor, activity: [0, 1, 2, 12, 13, 14], stop: 14)

        XCTAssertEqual(compressor.cut, 10 - IdleGapCompressor.defaultKeptHold, accuracy: 1e-9)
        XCTAssertEqual(result.end, 14 - compressor.cut, accuracy: tick)
        XCTAssertFalse(result.frames.contains { $0.input > 2.76 && $0.input < 12 - 1e-9 })
        let resumed = result.frames.first { $0.input >= 12 - 1e-9 }!
        XCTAssertEqual(resumed.output, 2 + IdleGapCompressor.defaultKeptHold, accuracy: tick + 1e-9)
        assertStrictlyIncreasing(result)
    }

    func testAShortStillIsNotCut() {
        var compressor = IdleGapCompressor()
        let result = run(&compressor, activity: [0, 1, 2.5, 3], stop: 3.5)
        XCTAssertEqual(compressor.cut, 0)
        let resumed = result.frames.first { $0.input >= 2.5 - 1e-9 }!
        XCTAssertEqual(resumed.output, resumed.input, accuracy: 1e-9)
        XCTAssertEqual(result.end, 3.5, accuracy: tick)
        assertStrictlyIncreasing(result)
    }

    func testManyStillsEachKeepTheirHold() {
        var compressor = IdleGapCompressor()
        let activity = (0..<5).flatMap { burst -> [TimeInterval] in
            let start = Double(burst) * 11
            return [start, start + 0.5, start + 1]
        } + [55]
        let result = run(&compressor, activity: activity, stop: 55.5)
        XCTAssertEqual(compressor.cut, 5 * (10 - IdleGapCompressor.defaultKeptHold), accuracy: 1e-9)
        XCTAssertEqual(result.end, 55.5 - compressor.cut, accuracy: tick)
        assertStrictlyIncreasing(result)
    }

    func testAStillAtTheEndKeepsTheHold() {
        var compressor = IdleGapCompressor()
        let result = run(&compressor, activity: [0, 1, 3], stop: 60)
        XCTAssertEqual(result.end, 3 + IdleGapCompressor.defaultKeptHold, accuracy: 1e-9)
        XCTAssertTrue(compressor.isHolding(at: 60))
        assertStrictlyIncreasing(result)
    }

    func testAFinalPictureLandsInsideTheHold() {
        var compressor = IdleGapCompressor()
        let result = run(&compressor, activity: [0, 1, 1.9, 3], stop: 30)
        let last = result.frames.last!.output
        let final = compressor.finalFrameTime(at: 30)
        let end = compressor.endTime(at: 30)
        XCTAssertGreaterThan(final, last)
        XCTAssertEqual(final, 3 + IdleGapCompressor.defaultKeptHold, accuracy: 1e-9)
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
                time += random() < 0.2 ? random() * 30 : random() * 1.5
                activity.append(time)
            }
            let result = run(&compressor, activity: activity, stop: 120)
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

/// What counts as a new picture, on thumbnails and on real-size BGRA frames.
final class ScreenChangeTests: XCTestCase {
    private func blank(_ width: Int = 256, _ height: Int = 144, value: UInt8 = 240) -> ScreenChange.Thumbnail {
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

    /// A white BGRA frame, with each rect painted black.
    private func frame(
        width: Int = 1920,
        height: Int = 1080,
        padding: Int = 0,
        black rects: [(x: Range<Int>, y: Range<Int>)] = []
    ) -> (bytes: [UInt8], bytesPerRow: Int) {
        let bytesPerRow = width * 4 + padding
        var bytes = [UInt8](repeating: 255, count: bytesPerRow * height)
        for rect in rects {
            for row in rect.y {
                for column in rect.x {
                    let offset = row * bytesPerRow + column * 4
                    bytes[offset] = 0
                    bytes[offset + 1] = 0
                    bytes[offset + 2] = 0
                }
            }
        }
        return (bytes, bytesPerRow)
    }

    private func thumbnail(_ frame: (bytes: [UInt8], bytesPerRow: Int), width: Int = 1920, height: Int = 1080) -> ScreenChange.Thumbnail? {
        frame.bytes.withUnsafeBytes {
            ScreenChange.thumbnail(bgra: $0, width: width, height: height, bytesPerRow: frame.bytesPerRow)
        }
    }

    func testIdenticalPicturesAreNotAChange() {
        XCTAssertFalse(ScreenChange.isSignificant(reference: blank(), current: blank()))
    }

    func testFaintNoiseIsNotAChange() {
        XCTAssertFalse(ScreenChange.isSignificant(reference: blank(value: 240), current: blank(value: 225)))
    }

    func testANewLabelIsAChange() {
        let label = painting(blank(), x: 10..<60, y: 50..<56, value: 30)
        XCTAssertTrue(ScreenChange.isSignificant(reference: blank(), current: label))
    }

    func testAResizeIsAChange() {
        XCTAssertTrue(ScreenChange.isSignificant(reference: blank(256, 144), current: blank(256, 160)))
    }

    func testSmallChangesAddUpAgainstTheReference() {
        let reference = blank()
        var current = reference
        var counted = false
        // A progress bar growing a pixel column at a time.
        for column in 0..<80 {
            current = painting(current, x: column..<(column + 1), y: 120..<123, value: 20)
            if ScreenChange.isSignificant(reference: reference, current: current) {
                counted = true
                break
            }
        }
        XCTAssertTrue(counted)
    }

    func testAThumbnailKeepsTheAspectAndHonoursRowPadding() throws {
        let white = try XCTUnwrap(thumbnail(frame(padding: 64)))
        XCTAssertEqual(white.width, 256)
        XCTAssertEqual(white.height, 144)
        XCTAssertTrue(white.luma.allSatisfy { $0 == 255 }, "padding bytes must not be read as pixels")

        let black = try XCTUnwrap(thumbnail(frame(black: [(0..<1920, 0..<1080)])))
        XCTAssertTrue(black.luma.allSatisfy { $0 == 0 })
    }

    func testASmallFrameIsNotScaled() throws {
        let small = try XCTUnwrap(thumbnail(frame(width: 64, height: 48), width: 64, height: 48))
        XCTAssertEqual(small.width, 64)
        XCTAssertEqual(small.height, 48)
    }

    func testAShortBufferHasNoThumbnail() {
        let bytes = [UInt8](repeating: 255, count: 100)
        let result = bytes.withUnsafeBytes {
            ScreenChange.thumbnail(bgra: $0, width: 1920, height: 1080, bytesPerRow: 1920 * 4)
        }
        XCTAssertNil(result)
    }

    func testABlinkingCaretOnARealFrameIsNotAChange() throws {
        // A 2-point caret, one line of text tall, in a text field.
        let off = try XCTUnwrap(thumbnail(frame()))
        let on = try XCTUnwrap(thumbnail(frame(black: [(900..<902, 500..<518)])))
        XCTAssertFalse(ScreenChange.isSignificant(reference: off, current: on))
    }

    func testTheMenuBarClockTickingIsNotAChange() throws {
        // The clock's minute digits redraw: two glyphs about 8×12 points each.
        let before = try XCTUnwrap(thumbnail(frame(black: [(1850..<1858, 6..<18), (1860..<1868, 6..<18)])))
        let after = try XCTUnwrap(thumbnail(frame(black: [(1850..<1858, 6..<18), (1862..<1866, 4..<20)])))
        XCTAssertFalse(ScreenChange.isSignificant(reference: before, current: after))
    }

    func testANewWindowIsAChange() throws {
        let before = try XCTUnwrap(thumbnail(frame()))
        let after = try XCTUnwrap(thumbnail(frame(black: [(600..<1000, 300..<600)])))
        XCTAssertTrue(ScreenChange.isSignificant(reference: before, current: after))
    }

    func testALineOfNewTextIsAChange() throws {
        // A 400-point line of 14-point text, drawn as glyph strokes.
        let strokes = stride(from: 200, to: 600, by: 6).map { (x: $0..<($0 + 2), y: 400..<414) }
        let before = try XCTUnwrap(thumbnail(frame()))
        let after = try XCTUnwrap(thumbnail(frame(black: strokes)))
        XCTAssertTrue(ScreenChange.isSignificant(reference: before, current: after))
    }
}

/// The per-frame decision, driven the way ScreenCaptureKit drives it: a frame
/// only when the display was redrawn, nothing while it is still.
final class RecordingIdleCutTests: XCTestCase {
    private let plain = ScreenChange.Thumbnail(width: 64, height: 36, luma: [UInt8](repeating: 240, count: 64 * 36))

    private func with(caret: Bool, from base: ScreenChange.Thumbnail) -> ScreenChange.Thumbnail {
        var copy = base
        if caret {
            for row in 10..<16 { copy.luma[row * base.width + 20] = 20 }
        }
        return copy
    }

    private var changed: ScreenChange.Thumbnail {
        var copy = plain
        for index in 0..<(64 * 18) { copy.luma[index] = 10 }
        return copy
    }

    func testCaretBlinksDoNotKeepAStillAlive() {
        var cut = RecordingIdleCut(enabled: true)
        XCTAssertEqual(cut.place(frameAt: 0) { self.plain }, 0)

        // A caret blinks every half second for twenty seconds.
        var written: [TimeInterval] = []
        for blink in 1..<40 {
            let time = Double(blink) * 0.5
            let picture = with(caret: blink % 2 == 1, from: plain)
            if let output = cut.place(frameAt: time, thumbnail: { picture }) { written.append(output) }
        }
        // Only the blink inside the kept hold is written.
        XCTAssertEqual(written, [0.5])

        let resumed = cut.place(frameAt: 20) { self.changed }
        XCTAssertEqual(resumed ?? -1, IdleGapCompressor.defaultKeptHold, accuracy: 1e-9)
        let finish = cut.finish(at: 21, pendingFrame: false)
        XCTAssertNil(finish.finalFrame)
        XCTAssertEqual(finish.end, IdleGapCompressor.defaultKeptHold + 1, accuracy: 1e-9)
    }

    func testAPendingFrameClosesAFinalStill() {
        var cut = RecordingIdleCut(enabled: true)
        _ = cut.place(frameAt: 0) { self.plain }
        let caret = with(caret: true, from: plain)
        XCTAssertNil(cut.place(frameAt: 5) { caret })

        let finish = cut.finish(at: 30, pendingFrame: true)
        XCTAssertEqual(finish.finalFrame ?? -1, IdleGapCompressor.defaultKeptHold, accuracy: 1e-9)
        XCTAssertEqual(finish.end, IdleGapCompressor.defaultKeptHold * 1.5, accuracy: 1e-9)
    }

    func testAFrameWithoutAThumbnailCountsAsActivity() {
        var cut = RecordingIdleCut(enabled: true)
        _ = cut.place(frameAt: 0) { self.plain }
        let output = cut.place(frameAt: 10) { nil }
        XCTAssertEqual(output ?? -1, IdleGapCompressor.defaultKeptHold, accuracy: 1e-9)
    }

    func testKeepIdleWritesEveryFrameAtWallClock() {
        var cut = RecordingIdleCut(enabled: false)
        var asked = false
        for time in [0.0, 0.5, 10, 30] {
            let output = cut.place(frameAt: time) {
                asked = true
                return self.plain
            }
            XCTAssertEqual(output ?? -1, time, accuracy: 1e-9)
        }
        XCTAssertFalse(asked, "no thumbnail is made with the cut off")
        let finish = cut.finish(at: 45, pendingFrame: false)
        XCTAssertNil(finish.finalFrame)
        XCTAssertEqual(finish.end, 45, accuracy: 1e-9)
    }
}

/// The idle cut through a real `AVAssetWriter`, the way `CaptureEngine` uses
/// it: session at zero, frames at the cut's times, the session ended where the
/// cut says. The file must play for exactly the reported length, with sample
/// times that only go forward.
final class IdleCutWriterTests: XCTestCase {
    private let width = 64
    private let height = 48

    private func buffer(fill: UInt8, caret: Bool = false) throws -> CVPixelBuffer {
        var made: CVPixelBuffer?
        CVPixelBufferCreate(
            nil,
            width,
            height,
            kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary,
            &made
        )
        let buffer = try XCTUnwrap(made)
        CVPixelBufferLockBaseAddress(buffer, [])
        let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(buffer))
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        memset(base, Int32(fill), bytesPerRow * height)
        if caret {
            for row in 10..<16 {
                memset(base + row * bytesPerRow + 20 * 4, 0, 4)
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        return buffer
    }

    func testACutRecordingPlaysForItsReportedLength() async throws {
        let url = URL(fileURLWithPath: NSTemporaryDirectory() + "ade-idle-cut-\(UUID().uuidString).mp4")
        defer { try? FileManager.default.removeItem(at: url) }
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height]
        )
        input.expectsMediaDataInRealTime = true
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)

        // White, a caret blinking for ten seconds, then a half-black screen.
        var frames: [(time: TimeInterval, buffer: CVPixelBuffer)] = [(0, try buffer(fill: 255))]
        for blink in 1..<20 {
            frames.append((Double(blink) * 0.5, try buffer(fill: 255, caret: blink % 2 == 1)))
        }
        frames.append((10, try buffer(fill: 0)))

        var cut = RecordingIdleCut(enabled: true)
        var written: [TimeInterval] = []
        for frame in frames {
            guard let output = cut.place(frameAt: frame.time, thumbnail: { CaptureEngine.idleThumbnail(of: frame.buffer) })
            else { continue }
            XCTAssertTrue(adaptor.append(frame.buffer, withPresentationTime: CMTime(seconds: output, preferredTimescale: 600)))
            written.append(output)
        }
        XCTAssertEqual(written, [0, 0.5, IdleGapCompressor.defaultKeptHold])

        let finish = cut.finish(at: 11, pendingFrame: false)
        let settled = CaptureEngine.finalizeRecordingWriter(
            writer: writer,
            input: input,
            endTime: CMTime(seconds: finish.end, preferredTimescale: 600)
        )
        XCTAssertTrue(settled)
        XCTAssertEqual(writer.status, .completed)

        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        XCTAssertEqual(CMTimeGetSeconds(duration), finish.end, accuracy: 1.0 / 600)
        XCTAssertEqual(finish.end, IdleGapCompressor.defaultKeptHold + 1, accuracy: 1e-9)

        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        // Decoded, so the samples come back in display order with their
        // presentation times rather than as the encoder's packets.
        let output = AVAssetReaderTrackOutput(
            track: track,
            outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA)]
        )
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var times: [Double] = []
        while let sample = output.copyNextSampleBuffer() {
            times.append(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)))
        }
        XCTAssertEqual(times.count, 3)
        for (index, time) in times.enumerated() {
            XCTAssertEqual(time, written[index], accuracy: 1.0 / 600)
        }
    }
}
