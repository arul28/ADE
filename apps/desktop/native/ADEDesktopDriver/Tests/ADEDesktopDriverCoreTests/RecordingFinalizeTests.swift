import AVFoundation
import CoreVideo
import XCTest
@testable import ADEDesktopDriver

/// The recording finalize path, held to the budget the test drive needed.
///
/// The wedge in the test drive was `finishWriting`'s completion not arriving
/// within fifteen seconds — the stop request was answered by the watchdog
/// instead, the driver's single main thread sat parked in the wait, and the
/// recording could be stopped exactly once. These tests run the one piece of
/// that path that needs no window server — `finalizeRecordingWriter` — against
/// real `AVAssetWriter`s: one with a frame, one with a started session and no
/// frames (a perfectly still display), and one that never started at all.
final class RecordingFinalizeTests: XCTestCase {
    private func makeWriter(
        width: Int = 64,
        height: Int = 48
    ) throws -> (writer: AVAssetWriter, input: AVAssetWriterInput, adaptor: AVAssetWriterInputPixelBufferAdaptor, url: URL) {
        let url = URL(
            fileURLWithPath: NSTemporaryDirectory()
                + "ade-recording-finalize-\(UUID().uuidString).mp4"
        )
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: width,
                AVVideoHeightKey: height,
            ]
        )
        input.expectsMediaDataInRealTime = true
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ]
        )
        XCTAssertTrue(writer.canAdd(input))
        writer.add(input)
        return (writer, input, adaptor, url)
    }

    private func makePixelBuffer(width: Int = 64, height: Int = 48) throws -> CVPixelBuffer {
        var pool: CVPixelBufferPool?
        CVPixelBufferPoolCreate(
            nil,
            nil,
            [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
            ] as CFDictionary,
            &pool
        )
        var buffer: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(nil, try XCTUnwrap(pool), &buffer)
        return try XCTUnwrap(buffer)
    }

    private var sampleTime: CMTime {
        CMTimeAdd(
            CMClockGetTime(CMClockGetHostTimeClock()),
            CMTime(value: 100, timescale: 1000)
        )
    }

    func testFinalizeCompletesForAWriterWithOneFrame() throws {
        let (writer, input, adaptor, url) = try makeWriter()
        let first = sampleTime
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: first)
        XCTAssertTrue(adaptor.append(try makePixelBuffer(), withPresentationTime: first))

        let start = Date()
        let settled = CaptureEngine.finalizeRecordingWriter(
            writer: writer,
            input: input,
            endTime: first
        )
        let elapsed = Date().timeIntervalSince(start)

        XCTAssertTrue(settled, "finishWriting did not settle for a single-frame recording")
        XCTAssertEqual(writer.status, .completed)
        XCTAssertLessThan(elapsed, CaptureEngine.recordingFinalizeBudget)
        let size = (try FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue ?? 0
        XCTAssertGreaterThan(size, 0, "the container should hold a moov and a frame")
        try? FileManager.default.removeItem(at: url)
    }

    func testFinalizeCompletesForAStartedSessionWithNoFrames() throws {
        // The still-display shape: ScreenCaptureKit delivered no frame after
        // the stream started, so the writer has an open session and not one
        // appended sample. The old stop path waited 15s here; the fix closes
        // the session with the frames written — none — and answers.
        let (writer, input, _, url) = try makeWriter()
        let first = sampleTime
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: first)

        let start = Date()
        let settled = CaptureEngine.finalizeRecordingWriter(
            writer: writer,
            input: input,
            endTime: nil
        )
        let elapsed = Date().timeIntervalSince(start)

        XCTAssertTrue(settled)
        XCTAssertLessThan(elapsed, CaptureEngine.recordingFinalizeBudget)
        try? FileManager.default.removeItem(at: url)
    }

    func testFinalizeReportsFalseForAWriterThatNeverStarted() throws {
        let (writer, input, _, url) = try makeWriter()
        let settled = CaptureEngine.finalizeRecordingWriter(
            writer: writer,
            input: input,
            endTime: nil
        )
        XCTAssertFalse(settled, "an unstarted writer is not a completed recording")
        XCTAssertEqual(writer.status, .unknown)
        try? FileManager.default.removeItem(at: url)
    }

    func testFinalizeBudgetIsUnderThreeSeconds() {
        // The number the CLI and the pane rely on when they say a stop
        // finalises "within ~2s".
        XCTAssertLessThanOrEqual(CaptureEngine.recordingFinalizeBudget, 3)
    }
}
