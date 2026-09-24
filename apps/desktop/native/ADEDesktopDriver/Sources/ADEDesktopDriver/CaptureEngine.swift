/// Pixels: screenshots, the numbered element map, the H.264 live stream, and
/// recordings. The loopback byte server and the VideoToolbox encoder it drives
/// live next door in `StreamByteServer.swift` and `H264Encoder.swift`.
///
/// Every capture is display-scoped or window-scoped, never screen-scoped. That
/// is one of the three rules the whole feature's isolation rests on: a lane
/// looks at its own display, or at one window on it, and can never accidentally
/// be handed a frame of the user's desktop.
///
/// The stream is deliberately the same shape as the iOS simulator's: Annex-B
/// H.264 access units behind the 12-byte `StreamRecord` header, over loopback
/// TCP. The renderer's reader is then one implementation for both surfaces
/// instead of two that drift. This driver serves the raw byte stream on
/// 127.0.0.1 and nothing else; the token-guarded HTTP endpoint in front of it is
/// the Node service's job.

import AVFoundation
import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Foundation
import Network
import ScreenCaptureKit
import VideoToolbox
import ADEDesktopDriverCore

enum CaptureError: Error {
    case noSurface(String)
    case failed(String)
}

// ---------------------------------------------------------------------------
// Frame source
// ---------------------------------------------------------------------------

/// The frame that arrives before a stream's state exists.
///
/// `startCaptureStream` pumps the run loop until ScreenCaptureKit confirms the
/// start, and the first frame often arrives inside that pump — before
/// `streams[laneId]` is assigned. A still, new display sends no second frame,
/// so dropping that one left `lastBuffer` nil for good: the keyframe on reader
/// attach and the 1 s keep-alive had nothing to re-encode, and every viewer got
/// the config record and no picture. Guarded by `CaptureEngine.lock`.
final class EarlyFrameBox {
    var buffer: CVPixelBuffer?
    var presentationTime: CMTime = .zero
}

@available(macOS 12.3, *)
final class CaptureFrameSink: NSObject, SCStreamOutput, SCStreamDelegate {
    private let onFrame: (CMSampleBuffer) -> Void
    private let onError: (Error) -> Void

    init(onFrame: @escaping (CMSampleBuffer) -> Void, onError: @escaping (Error) -> Void) {
        self.onFrame = onFrame
        self.onError = onError
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, CMSampleBufferGetImageBuffer(sampleBuffer) != nil else { return }
        onFrame(sampleBuffer)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        onError(error)
    }
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

final class CaptureEngine {
    struct StreamState {
        var server: StreamByteServer
        var encoder: H264Encoder
        var stream: SCStream
        var sink: AnyObject
        var fps: Int
        var width: Int
        var height: Int
        var codec: String?
        var startedAt: Date
        /// The last frame ScreenCaptureKit delivered, kept so a reader that
        /// attaches to a still screen can be handed a keyframe of it.
        var lastBuffer: CVPixelBuffer?
        var lastPresentationTime: CMTime
        /// When the encoder last produced an access unit, for the keepalive.
        var lastEncodedAt: Date
        var keepAlive: DispatchSourceTimer?
        /// Whether the captured picture includes the system pointer.
        var showsCursor: Bool
    }

    struct RecordingState {
        var writer: AVAssetWriter
        var input: AVAssetWriterInput
        var adaptor: AVAssetWriterInputPixelBufferAdaptor
        var stream: SCStream
        var sink: AnyObject
        var filePath: String
        var startedAt: Date
        /// ScreenCaptureKit's timestamp for the first frame. Every later frame
        /// is placed by its distance from this one.
        var firstPresentationTime: CMTime?
        /// When the first frame arrived, by the wall clock. `record.stop`
        /// measures the recording's real length from here.
        var firstFrameAt: Date?
        /// Where each frame goes in the file, with still stretches cut.
        var idleCut: RecordingIdleCut
        /// The newest frame the idle cut skipped, so a small change during a
        /// final still (a clock tick) is still what the file ends on.
        var pendingBuffer: CVPixelBuffer?
    }

    /// How long a reader may go without a picture on a screen where nothing is
    /// happening.
    ///
    /// ScreenCaptureKit delivers a frame when the content changes and not
    /// otherwise, so an untouched lane desktop is a stream that stops dead
    /// after its first frames — which is exactly the state a viewer opening the
    /// tab arrives in. The engine re-encodes the last captured frame as a
    /// keyframe at this cadence while somebody is reading, so the picture is
    /// never more than a second away and a reconnecting viewer is never
    /// waiting on the desktop to do something.
    private static let keepAliveInterval: TimeInterval = 1.0

    private var streams: [String: StreamState] = [:]
    /// Whether each lane's stream should draw the system pointer.
    ///
    /// Kept per lane rather than only inside `StreamState` because the fact
    /// outlives any one stream: a lane whose user holds control while the view
    /// reconnects must come back with the pointer still visible, and the
    /// service should be able to state the intention whether or not an encoder
    /// happens to be running at that instant.
    private var cursorVisibleByLane: [String: Bool] = [:]
    private var recordings: [String: RecordingState] = [:]
    /// Appended frames per recording lane, so "captured nothing" is a fact this
    /// process can state before `record.stop` decides what to do with a file.
    private var recordedFrameCounts: [String: Int] = [:]
    /// Lanes whose stream or recording is starting. A stop cancels the
    /// start; a second start is refused. See `CaptureStartReservations`.
    private let startingStreams = CaptureStartReservations()
    private let startingRecordings = CaptureStartReservations()
    private let lock = NSRecursiveLock()
    /// Serialises recording appends against the stop path.
    ///
    /// AVFoundation is explicit that `finishWriting` must not run concurrently
    /// with `appendPixelBuffer`, and that every append must have returned before
    /// it is invoked; the sample handler queue and the main thread are exactly
    /// the two threads that made that a race. A recording stop takes this lock
    /// first, so by the time it marks the input finished and asks the writer to
    /// close, no append can be in flight — and a frame that arrives afterwards
    /// waits for the stop and then finds its state gone.
    private let appendLock = NSLock()
    /// Writers whose finalize outlived the stop budget.
    ///
    /// A writer that is still finishing must not be released: AVFoundation
    /// finalises the moov asynchronously, and dropping the last reference
    /// mid-write is how a slow mux turns into a corrupt file. Kept only until
    /// their completion fires, which the completion itself reports.
    private var abandonedWriters: [AVAssetWriter] = []
    private let log: (String) -> Void
    private let emit: (DriverEvent) -> Void

    /// How long `record.stop` waits for `finishWriting` before answering.
    ///
    /// The operation the test drive wedged on waited fifteen seconds and still
    /// had not seen the completion. A correct close of a handful of frames is
    /// milliseconds (measured: ~20ms), so two seconds is a generous budget that
    /// still fails fast; a writer that needs longer is registered as abandoned
    /// rather than blocking the driver's single main thread.
    static let recordingFinalizeBudget: TimeInterval = 2.0

    init(log: @escaping (String) -> Void, emit: @escaping (DriverEvent) -> Void) {
        self.log = log
        self.emit = emit
    }

    // -----------------------------------------------------------------------
    // Content lookup
    // -----------------------------------------------------------------------

    @available(macOS 12.3, *)
    private func shareableContent() throws -> SCShareableContent {
        let box = ValueBox<Result<SCShareableContent, Error>>()
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, error in
            if let content {
                box.set(.success(content))
            } else {
                box.set(.failure(error ?? CaptureError.failed("ScreenCaptureKit returned no content.")))
            }
        }
        RunLoopPump.wait(until: { box.value != nil }, timeout: 10)
        switch box.value {
        case .success(let content):
            return content
        case .failure(let error):
            throw error
        case nil:
            throw CaptureError.failed("ScreenCaptureKit did not answer in time. Screen Recording may not be granted.")
        }
    }

    @available(macOS 12.3, *)
    private func filter(displayId: CGDirectDisplayID, windowId: CGWindowID?) throws -> (SCContentFilter, Int, Int) {
        let content = try shareableContent()
        if let windowId, let window = content.windows.first(where: { $0.windowID == windowId }) {
            let filter = SCContentFilter(desktopIndependentWindow: window)
            return (filter, Int(window.frame.width), Int(window.frame.height))
        }
        if displayId != 0, let display = content.displays.first(where: { $0.displayID == displayId }) {
            let filter = SCContentFilter(display: display, excludingWindows: [])
            return (filter, display.width, display.height)
        }
        throw CaptureError.noSurface(
            displayId == 0
                ? "This lane is in offscreen-region mode, which has no display surface to capture. "
                    + "Capture one of its windows instead."
                : "No ScreenCaptureKit content for display \(displayId)."
        )
    }

    /// `filter`, with the same patience as a capture start.
    ///
    /// A display or a window is often missing from `SCShareableContent` for a
    /// beat after it appears — a virtual display that was just created, a
    /// window belonging to an app that was just launched. Sizing a capture is
    /// the first thing every caller does, so without this the retry below never
    /// gets a chance to run: the request has already failed on the measurement.
    @available(macOS 12.3, *)
    private func retryingFilter(
        displayId: CGDirectDisplayID,
        windowId: CGWindowID?,
        label: String
    ) throws -> (SCContentFilter, Int, Int) {
        var attempt = 0
        while true {
            do {
                return try filter(displayId: displayId, windowId: windowId)
            } catch {
                guard displayId != 0,
                      attempt < Self.startBackoffs.count,
                      Self.isRetryableStartFailure(error)
                else { throw error }
                log("\(label) has no capture surface yet (\(Self.describe(error))); retrying in \(Int(Self.startBackoffs[attempt] * 1000))ms")
                RunLoopPump.wait(until: { false }, timeout: Self.startBackoffs[attempt])
                attempt += 1
            }
        }
    }

    // -----------------------------------------------------------------------
    // Starting a capture
    // -----------------------------------------------------------------------

    /// The backoff between attempts to start a ScreenCaptureKit capture.
    ///
    /// An app that launched a moment ago is the case this exists for. Starting
    /// a stream within a few seconds of `app.launch` fails inside
    /// ScreenCaptureKit with `-3805` ("application connection being
    /// interrupted") roughly every time: the window server is still rebuilding
    /// the connection the new process just made, and the capture session is
    /// refused rather than queued. It is a transient state measured in
    /// hundreds of milliseconds, so the fix is to ask again rather than to make
    /// every caller sleep ten seconds before it records. Five seconds of
    /// budget, refreshing `SCShareableContent` each time so an attempt is never
    /// made against a stale content snapshot.
    static let startBackoffs: [TimeInterval] = [0.25, 0.5, 1.0, 2.0]

    /// The `SCStreamError` codes worth trying again.
    ///
    /// Everything here describes the world being momentarily not ready — a
    /// connection being rebuilt, a content list that has not caught up with a
    /// display or a window that exists. The codes deliberately left out are the
    /// permanent ones: `userDeclined` (-3801) and `missingEntitlements`
    /// (-3803) are answers, not races, and retrying them only delays a message
    /// the user needs to read.
    static let retryableStartCodes: Set<Int> = [
        -3802, // failedToStart
        -3804, // failedApplicationConnectionInvalid
        -3805, // failedApplicationConnectionInterrupted
        -3806, // failedNoMatchingApplicationContext
        -3811, // internalError
        -3813, // noWindowList
        -3814, // noDisplayList
        -3815, // noCaptureSource
    ]

    static func isRetryableStartFailure(_ error: Error) -> Bool {
        if let captureError = error as? CaptureError {
            switch captureError {
            case .noSurface:
                // A display ScreenCaptureKit has not published yet. The
                // permanent version of this — a lane with no display surface at
                // all — is refused before any capture is attempted, in `filter`.
                return true
            case .failed:
                // Our own "it never answered": worth one more ask.
                return true
            }
        }
        return Self.retryableStartCodes.contains((error as NSError).code)
    }

    private static func describe(_ error: Error) -> String {
        if let captureError = error as? CaptureError {
            switch captureError {
            case .noSurface(let message), .failed(let message): return message
            }
        }
        let nsError = error as NSError
        return "\(nsError.localizedDescription) (\(nsError.domain) \(nsError.code))"
    }

    /// Builds a stream against a freshly resolved content filter and starts it,
    /// retrying the transient refusals above.
    ///
    /// Every exit is a value or a throw, and every attempt that got as far as
    /// an `SCStream` tears that stream down before the next one: a half-started
    /// stream left holding a capture session is the thing that makes the
    /// *second* attempt fail too.
    @available(macOS 12.3, *)
    private func startCaptureStream(
        displayId: CGDirectDisplayID,
        windowId: CGWindowID?,
        configuration: SCStreamConfiguration,
        sink: CaptureFrameSink,
        label: String
    ) throws -> SCStream {
        var attempt = 0
        var lastError: Error = CaptureError.failed("\(label) never started.")
        while true {
            do {
                let (contentFilter, _, _) = try filter(displayId: displayId, windowId: windowId)
                let stream = SCStream(filter: contentFilter, configuration: configuration, delegate: sink)
                do {
                    try stream.addStreamOutput(
                        sink,
                        type: .screen,
                        sampleHandlerQueue: .global(qos: .userInitiated)
                    )
                } catch {
                    stream.stopCapture { _ in }
                    throw error
                }
                let settled = SettledFlag()
                let failure = ValueBox<Error>()
                stream.startCapture { error in
                    failure.set(error)
                    settled.set()
                }
                RunLoopPump.wait(until: { settled.isSet }, timeout: 10)
                guard settled.isSet else {
                    // A completion that never came. Treated as a failure and
                    // never as a success: the old code carried on here, which
                    // handed back a stream that was not capturing and a reply
                    // that said it was.
                    stream.stopCapture { _ in }
                    throw CaptureError.failed("ScreenCaptureKit did not answer the \(label) start request.")
                }
                if let error = failure.value {
                    stream.stopCapture { _ in }
                    throw error
                }
                if attempt > 0 {
                    log("\(label) started on attempt \(attempt + 1)")
                }
                return stream
            } catch {
                lastError = error
                guard attempt < Self.startBackoffs.count, Self.isRetryableStartFailure(error) else { break }
                let delay = Self.startBackoffs[attempt]
                log("\(label) start failed (\(Self.describe(error))); retrying in \(Int(delay * 1000))ms")
                // Pumped, not slept: the main thread is still answering every
                // other lane's requests while this one backs off.
                RunLoopPump.wait(until: { false }, timeout: delay)
                attempt += 1
            }
        }
        if case CaptureError.noSurface(let message) = lastError {
            throw CaptureError.noSurface(message)
        }
        throw CaptureError.failed(
            "\(label) could not start after \(attempt + 1) attempts: \(Self.describe(lastError))"
        )
    }

    // -----------------------------------------------------------------------
    // Screenshots
    // -----------------------------------------------------------------------

    /// One PNG on disk. Returns its pixel size.
    func screenshot(
        laneId: String,
        displayId: CGDirectDisplayID,
        windowId: CGWindowID?,
        path: String
    ) throws -> (width: Int, height: Int) {
        guard #available(macOS 12.3, *) else {
            throw CaptureError.failed("ScreenCaptureKit needs macOS 12.3 or newer.")
        }
        let image = try captureImage(displayId: displayId, windowId: windowId)
        try Self.writePNG(image, to: path)
        return (image.width, image.height)
    }

    @available(macOS 12.3, *)
    private func captureImage(displayId: CGDirectDisplayID, windowId: CGWindowID?) throws -> CGImage {
        let (contentFilter, width, height) = try retryingFilter(
            displayId: displayId,
            windowId: windowId,
            label: "screenshot"
        )
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, width)
        configuration.height = max(1, height)
        configuration.showsCursor = false

        if #available(macOS 14.0, *) {
            var attempt = 0
            var lastError: Error = CaptureError.failed("The screenshot never ran.")
            while true {
                // Re-resolved every attempt: a screenshot that failed because
                // the content list was stale must not be retried against the
                // same stale list.
                let attemptFilter = attempt == 0
                    ? contentFilter
                    : (try filter(displayId: displayId, windowId: windowId)).0
                let box = ValueBox<Result<CGImage, Error>>()
                SCScreenshotManager.captureImage(
                    contentFilter: attemptFilter,
                    configuration: configuration
                ) { image, error in
                    if let image {
                        box.set(.success(image))
                    } else {
                        box.set(.failure(error ?? CaptureError.failed("ScreenCaptureKit returned no image.")))
                    }
                }
                RunLoopPump.wait(until: { box.value != nil }, timeout: 10)
                switch box.value {
                case .success(let image):
                    if attempt > 0 { log("screenshot succeeded on attempt \(attempt + 1)") }
                    return image
                case .failure(let error):
                    lastError = error
                case nil:
                    lastError = CaptureError.failed("The screenshot did not arrive in time.")
                }
                guard attempt < Self.startBackoffs.count, Self.isRetryableStartFailure(lastError) else {
                    throw CaptureError.failed(
                        "The screenshot failed after \(attempt + 1) attempts: \(Self.describe(lastError))"
                    )
                }
                log("screenshot failed (\(Self.describe(lastError))); retrying in \(Int(Self.startBackoffs[attempt] * 1000))ms")
                RunLoopPump.wait(until: { false }, timeout: Self.startBackoffs[attempt])
                attempt += 1
            }
        }

        // macOS 13: no screenshot API, so one frame is pulled off a short-lived
        // stream. Same content filter, same permission, more ceremony.
        let captured = ValueBox<CGImage>()
        let streamFailure = ValueBox<Error>()
        let sink = CaptureFrameSink(
            onFrame: { sampleBuffer in
                guard captured.value == nil, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
                captured.set(Self.makeImage(from: buffer))
            },
            onError: { streamFailure.set($0) }
        )
        let stream = try startCaptureStream(
            displayId: displayId,
            windowId: windowId,
            configuration: configuration,
            sink: sink,
            label: "screenshot"
        )
        RunLoopPump.wait(until: { captured.value != nil || streamFailure.value != nil }, timeout: 10)
        stream.stopCapture { _ in }
        if let image = captured.value { return image }
        if let error = streamFailure.value { throw error }
        throw CaptureError.failed("No frame arrived from ScreenCaptureKit.")
    }

    static func makeImage(from buffer: CVPixelBuffer) -> CGImage? {
        var image: CGImage?
        VTCreateCGImageFromCVPixelBuffer(buffer, options: nil, imageOut: &image)
        return image
    }

    static func writePNG(_ image: CGImage, to path: String) throws {
        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        guard let destination = CGImageDestinationCreateWithURL(
            url as CFURL,
            "public.png" as CFString,
            1,
            nil
        ) else {
            throw CaptureError.failed("Could not open \(path) for writing.")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw CaptureError.failed("Could not write \(path).")
        }
    }

    /// The `--map` image: the screenshot with a numbered badge on each element.
    ///
    /// Drawn here rather than in the renderer because the numbers have to line
    /// up with the element list in the same observation, and the only place both
    /// exist at the same instant is this process.
    func writeElementMap(
        laneId: String,
        screenshotPath: String,
        mapPath: String,
        display: DisplayPlacement,
        elements: [ObservedElement]
    ) throws {
        guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: screenshotPath) as CFURL, nil),
              let base = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else {
            throw CaptureError.failed("Could not read \(screenshotPath) back to draw the element map.")
        }
        let width = base.width
        let height = base.height
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            throw CaptureError.failed("Could not build a drawing context for the element map.")
        }
        context.draw(base, in: CGRect(x: 0, y: 0, width: width, height: height))

        let pixelScale = CGFloat(width) / max(1, display.width)
        for element in elements {
            // Global points → display-local points → capture pixels, then flip:
            // CoreGraphics bitmap contexts are bottom-left origin and the rest of
            // this driver is top-left.
            let local = Geometry.toLocal(point: CGPoint(x: element.frame.midX, y: element.frame.midY), display: display)
            let x = local.x * pixelScale
            let y = CGFloat(height) - local.y * pixelScale
            guard x >= 0, y >= 0, x <= CGFloat(width), y <= CGFloat(height) else { continue }
            let badge = CGRect(x: x - 14, y: y - 11, width: 28, height: 22)
            context.setFillColor(CGColor(red: 0.05, green: 0.05, blue: 0.08, alpha: 0.85))
            context.setStrokeColor(CGColor(red: 1, green: 0.85, blue: 0.2, alpha: 1))
            context.setLineWidth(1.5)
            context.addPath(CGPath(roundedRect: badge, cornerWidth: 6, cornerHeight: 6, transform: nil))
            context.drawPath(using: .fillStroke)

            let text = "\(element.index)" as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 13, weight: .bold),
                .foregroundColor: NSColor.white,
            ]
            let graphicsContext = NSGraphicsContext(cgContext: context, flipped: false)
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = graphicsContext
            let size = text.size(withAttributes: attributes)
            text.draw(
                at: NSPoint(x: badge.midX - size.width / 2, y: badge.midY - size.height / 2),
                withAttributes: attributes
            )
            NSGraphicsContext.restoreGraphicsState()
        }
        guard let output = context.makeImage() else {
            throw CaptureError.failed("The element map context produced no image.")
        }
        try Self.writePNG(output, to: mapPath)
    }

    // -----------------------------------------------------------------------
    // Live stream
    // -----------------------------------------------------------------------

    /// The one place a live-stream configuration is built.
    ///
    /// Written twice before — once for `startStream` and once for
    /// `setStreamRate` — which is how a stream reconfigured for a new frame
    /// rate silently lost every other setting it had been given.
    @available(macOS 12.3, *)
    private static func streamConfiguration(
        width: Int,
        height: Int,
        fps: Int,
        showsCursor: Bool
    ) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = width
        configuration.height = height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = showsCursor
        configuration.queueDepth = 5
        return configuration
    }

    /// Whether this lane's stream draws the system pointer, from now on.
    ///
    /// Stored even when no stream is running, and applied to the running one in
    /// place: `updateConfiguration` keeps the same encoder, the same loopback
    /// port and the same reader, so a takeover does not blink the picture. It
    /// deliberately does not throw for a lane with no stream — the caller is
    /// stating an intention about the lane, not about an encoder, and the
    /// lease transition that calls it must not fail because the viewer happened
    /// to be closed.
    func setStreamCursorVisible(laneId: String, visible: Bool) throws {
        lock.lock()
        cursorVisibleByLane[laneId] = visible
        guard var state = streams[laneId], state.showsCursor != visible else {
            lock.unlock()
            return
        }
        state.showsCursor = visible
        streams[laneId] = state
        lock.unlock()
        guard #available(macOS 12.3, *) else { return }
        state.stream.updateConfiguration(
            Self.streamConfiguration(
                width: state.width,
                height: state.height,
                fps: state.fps,
                showsCursor: visible
            )
        ) { [weak self] error in
            if let error { self?.log("cursor visibility for lane \(laneId) failed: \(error)") }
        }
        // The pointer is not "content", so a still desktop produces no new
        // frame when it appears or goes. Without this the user takes control
        // and sees nothing until something else on the screen moves.
        refreshKeyframe(laneId: laneId)
    }

    func startStream(
        laneId: String,
        displayId: CGDirectDisplayID,
        fps: Int,
        showsCursor: Bool? = nil
    ) throws -> (port: UInt16, width: Int, height: Int, codec: String?) {
        guard #available(macOS 12.3, *) else {
            throw CaptureError.failed("ScreenCaptureKit needs macOS 12.3 or newer.")
        }
        lock.lock()
        if let existing = streams[laneId] {
            lock.unlock()
            return (existing.server.port, existing.width, existing.height, existing.codec)
        }
        // Reserved before the first wait: a `stream.stop` inside it cancels
        // this start instead of finding nothing to stop.
        guard let reservation = startingStreams.reserve(laneId) else {
            lock.unlock()
            throw CaptureStartReservations.alreadyStarting(laneId: laneId, what: "live stream")
        }
        lock.unlock()
        // Every exit that does not install a stream ends the reservation.
        var reservationEnded = false
        defer { if !reservationEnded { startingStreams.finish(reservation) } }
        let cancelled = {
            CaptureError.failed("Lane \(laneId)'s live stream was stopped while it was starting.")
        }

        let (_, width, height) = try retryingFilter(displayId: displayId, windowId: nil, label: "stream.start")
        guard !startingStreams.isCancelled(reservation) else { throw cancelled() }
        lock.lock()
        let cursorVisible = showsCursor ?? cursorVisibleByLane[laneId] ?? false
        cursorVisibleByLane[laneId] = cursorVisible
        lock.unlock()
        let configuration = Self.streamConfiguration(
            width: max(2, width - width % 2),
            height: max(2, height - height % 2),
            fps: fps,
            showsCursor: cursorVisible
        )

        let server = StreamByteServer()
        let port = try server.start()

        // Every callback below checks that the lane's stream is still THIS
        // one: a start that was cancelled keeps delivering for a beat after
        // its capture is told to stop, and must not write into the state of
        // the stream that replaced it.
        let encoder: H264Encoder
        do {
            encoder = try H264Encoder(
                width: configuration.width,
                height: configuration.height,
                fps: fps
            ) { [weak self] payload, keyframe, codec in
                guard let self else { return }
                self.lock.lock()
                let isCurrent = self.streams[laneId]?.server === server
                if isCurrent, let codec, self.streams[laneId]?.codec != codec {
                    self.streams[laneId]?.codec = codec
                    server.setConfig(codec: codec)
                }
                if isCurrent { self.streams[laneId]?.lastEncodedAt = Date() }
                self.lock.unlock()
                server.broadcast(StreamRecord.accessUnitRecord(payload: payload, keyframe: keyframe))
            }
        } catch {
            // The listener is already open, and a failed start must not leave
            // it listening.
            server.stop()
            throw error
        }
        // A reader attaching is the one moment a keyframe is owed immediately.
        server.onClientAttached = { [weak self] in
            self?.refreshKeyframe(laneId: laneId)
        }

        let early = EarlyFrameBox()
        let sink = CaptureFrameSink(
            onFrame: { [weak self] sampleBuffer in
                guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
                let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                if let self {
                    self.lock.lock()
                    if let current = self.streams[laneId] {
                        if current.server === server {
                            self.streams[laneId]?.lastBuffer = buffer
                            if CMTIME_IS_NUMERIC(time) { self.streams[laneId]?.lastPresentationTime = time }
                        }
                    } else {
                        early.buffer = buffer
                        if CMTIME_IS_NUMERIC(time) { early.presentationTime = time }
                    }
                    self.lock.unlock()
                }
                encoder.encode(pixelBuffer: buffer, presentationTime: time)
            },
            onError: { [weak self] error in
                self?.emit(
                    DriverEvent(
                        event: "stream-error",
                        fields: ["laneId": .string(laneId), "message": .string("\(error)")]
                    )
                )
            }
        )
        // Every resource this request opened is released before a throw, so
        // a retry from the caller starts from the same state as the first
        // attempt rather than from a leaked listener and encoder.
        let release = {
            server.onClientAttached = nil
            server.stop()
            encoder.stop()
        }
        guard !startingStreams.isCancelled(reservation) else {
            release()
            throw cancelled()
        }
        let stream: SCStream
        do {
            stream = try startCaptureStream(
                displayId: displayId,
                windowId: nil,
                configuration: configuration,
                sink: sink,
                label: "stream.start"
            )
        } catch {
            release()
            throw error
        }

        lock.lock()
        // The start waited with the run loop pumping. A stop inside that wait
        // cancelled it; what it built goes, rather than streaming a lane
        // nobody is showing any more.
        guard startingStreams.finish(reservation), streams[laneId] == nil else {
            lock.unlock()
            reservationEnded = true
            stream.stopCapture { _ in }
            release()
            log("stream for lane \(laneId) was stopped while it was starting; discarded it")
            throw cancelled()
        }
        reservationEnded = true
        streams[laneId] = StreamState(
            server: server,
            encoder: encoder,
            stream: stream,
            sink: sink,
            fps: fps,
            width: configuration.width,
            height: configuration.height,
            codec: nil,
            startedAt: Date(),
            // A frame that landed during the start is kept, not lost.
            lastBuffer: early.buffer,
            lastPresentationTime: early.presentationTime,
            lastEncodedAt: Date(),
            keepAlive: nil,
            showsCursor: cursorVisible
        )
        early.buffer = nil
        lock.unlock()
        startKeepAlive(laneId: laneId, server: server)
        log("stream for lane \(laneId) on 127.0.0.1:\(port) at \(configuration.width)x\(configuration.height)@\(fps)")
        return (port, configuration.width, configuration.height, nil)
    }

    /// Re-encodes the lane's last captured frame as a keyframe.
    ///
    /// Everything about a still desktop's stream depends on this: the frame is
    /// the one ScreenCaptureKit last handed over, re-submitted with a forced
    /// IDR and a presentation time one frame later than the previous one, so
    /// the encoder accepts it and every reader — the one that just attached and
    /// the ones already watching — gets parameter sets and a whole picture.
    private func refreshKeyframe(laneId: String) {
        lock.lock()
        guard var state = streams[laneId], let buffer = state.lastBuffer else {
            lock.unlock()
            return
        }
        let step = CMTime(value: 1, timescale: CMTimeScale(max(1, state.fps)))
        let next = CMTimeAdd(state.lastPresentationTime, step)
        state.lastPresentationTime = next
        streams[laneId] = state
        let encoder = state.encoder
        lock.unlock()
        encoder.encode(pixelBuffer: buffer, presentationTime: next, forceKeyframe: true)
    }

    /// The idle heartbeat: one keyframe a second while somebody is reading and
    /// the screen has produced nothing. It stops costing anything the moment
    /// the desktop is busy, because a real frame resets the clock, and it does
    /// no work at all while no reader is attached.
    private func startKeepAlive(laneId: String, server: StreamByteServer) {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue.global(qos: .utility))
        timer.schedule(deadline: .now() + Self.keepAliveInterval, repeating: Self.keepAliveInterval)
        timer.setEventHandler { [weak self] in
            guard let self, server.clientCount > 0 else { return }
            self.lock.lock()
            let due = self.streams[laneId].map {
                Date().timeIntervalSince($0.lastEncodedAt) >= Self.keepAliveInterval
            } ?? false
            self.lock.unlock()
            guard due else { return }
            self.refreshKeyframe(laneId: laneId)
        }
        timer.resume()
        lock.lock()
        streams[laneId]?.keepAlive = timer
        lock.unlock()
    }

    func setStreamRate(laneId: String, fps: Int) throws {
        lock.lock()
        guard var state = streams[laneId] else {
            lock.unlock()
            throw CaptureError.noSurface("Lane \(laneId) has no running stream.")
        }
        state.fps = fps
        streams[laneId] = state
        lock.unlock()
        state.encoder.setRate(fps: fps)
        guard #available(macOS 12.3, *) else { return }
        state.stream.updateConfiguration(
            Self.streamConfiguration(
                width: state.width,
                height: state.height,
                fps: fps,
                // Carried over rather than re-defaulted: a rate change during a
                // takeover used to hide the pointer the user was driving with.
                showsCursor: state.showsCursor
            )
        ) { _ in }
    }

    func streamStatus(laneId: String) -> (running: Bool, fps: Int, port: UInt16, clients: Int, codec: String?, width: Int, height: Int) {
        lock.lock()
        defer { lock.unlock() }
        guard let state = streams[laneId] else {
            return (false, 0, 0, 0, nil, 0, 0)
        }
        return (true, state.fps, state.server.port, state.server.clientCount, state.codec, state.width, state.height)
    }

    @discardableResult
    func stopStream(laneId: String) -> Bool {
        lock.lock()
        guard let state = streams.removeValue(forKey: laneId) else {
            // A start still waiting on ScreenCaptureKit is cancelled: it tears
            // down what it built when it resumes.
            let cancelled = startingStreams.cancel(laneId)
            lock.unlock()
            return cancelled
        }
        lock.unlock()
        state.keepAlive?.cancel()
        state.server.onClientAttached = nil
        state.stream.stopCapture { _ in }
        state.encoder.stop()
        state.server.stop()
        return true
    }

    // -----------------------------------------------------------------------
    // Recording
    // -----------------------------------------------------------------------

    func startRecording(
        laneId: String,
        displayId: CGDirectDisplayID,
        fps: Int,
        filePath: String,
        keepIdle: Bool = false
    ) throws -> Date {
        guard #available(macOS 12.3, *) else {
            throw CaptureError.failed("ScreenCaptureKit needs macOS 12.3 or newer.")
        }
        lock.lock()
        let alreadyRunning = recordings[laneId] != nil
        // Reserved before the first wait, the same as a stream start: a
        // `record.stop` inside it cancels this start, and a second
        // `record.start` is refused rather than racing it for the same lane.
        let reservation = alreadyRunning ? nil : startingRecordings.reserve(laneId)
        lock.unlock()
        guard !alreadyRunning else {
            throw CaptureError.failed("Lane \(laneId) is already recording.")
        }
        guard let reservation else {
            throw CaptureStartReservations.alreadyStarting(laneId: laneId, what: "recording")
        }
        var reservationEnded = false
        defer { if !reservationEnded { startingRecordings.finish(reservation) } }
        let cancelled = {
            CaptureError.failed("Lane \(laneId)'s recording was stopped while it was starting.")
        }

        let (_, width, height) = try retryingFilter(displayId: displayId, windowId: nil, label: "record.start")
        guard !startingRecordings.isCancelled(reservation) else { throw cancelled() }
        let evenWidth = max(2, width - width % 2)
        let evenHeight = max(2, height - height % 2)
        let url = URL(fileURLWithPath: filePath)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? FileManager.default.removeItem(at: url)

        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(
            mediaType: .video,
            outputSettings: [
                AVVideoCodecKey: AVVideoCodecType.h264,
                AVVideoWidthKey: evenWidth,
                AVVideoHeightKey: evenHeight,
            ]
        )
        input.expectsMediaDataInRealTime = true
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
                kCVPixelBufferWidthKey as String: evenWidth,
                kCVPixelBufferHeightKey as String: evenHeight,
            ]
        )
        guard writer.canAdd(input) else {
            throw CaptureError.failed("AVAssetWriter refused the video input.")
        }
        writer.add(input)

        let configuration = SCStreamConfiguration()
        configuration.width = evenWidth
        configuration.height = evenHeight
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = false
        configuration.queueDepth = 5

        let sink = CaptureFrameSink(
            onFrame: { [weak self] sampleBuffer in
                guard let self, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
                // Held across the state check and the append so a stop that
                // removed the recording can never overlap an append the sample
                // handler was already committed to. It also makes this handler
                // the state's only writer until a stop takes it, so the
                // thumbnail below can be made without holding `lock`.
                self.appendLock.lock()
                defer { self.appendLock.unlock() }
                let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                self.lock.lock()
                guard var state = self.recordings[laneId] else {
                    self.lock.unlock()
                    return
                }
                self.lock.unlock()
                if state.firstPresentationTime == nil {
                    state.firstPresentationTime = time
                    state.firstFrameAt = Date()
                    if writer.startWriting() {
                        // The file's clock starts at zero: the idle cut places
                        // each frame by its distance from the first, minus
                        // whatever still time it has cut before it.
                        writer.startSession(atSourceTime: .zero)
                    } else {
                        // Nothing can be appended after this, and `record.stop`
                        // is the request that has to say so; it reads the
                        // writer's status. Logged here because this is the
                        // moment the reason exists.
                        self.log(
                            "recording writer on lane \(laneId) refused to start: "
                                + "\(writer.error.map { "\($0)" } ?? "no reason given")"
                        )
                    }
                }
                let first = state.firstPresentationTime ?? time
                let elapsed = max(0, CMTimeGetSeconds(CMTimeSubtract(time, first)))
                // ScreenCaptureKit sends a frame only when the display was
                // redrawn, so each one is classified: a real change is
                // activity, a caret blink or a clock tick is not.
                let placed = state.idleCut.place(frameAt: elapsed) { Self.idleThumbnail(of: buffer) }
                let willAppend = placed != nil && input.isReadyForMoreMediaData && writer.status == .writing
                state.pendingBuffer = willAppend ? nil : buffer
                self.lock.lock()
                self.recordings[laneId] = state
                if willAppend {
                    self.recordedFrameCounts[laneId] = (self.recordedFrameCounts[laneId] ?? 0) + 1
                }
                self.lock.unlock()
                guard willAppend, let placed else { return }
                adaptor.append(buffer, withPresentationTime: CMTime(seconds: placed, preferredTimescale: 600))
            },
            onError: { [weak self] error in
                self?.log("recording stream error on lane \(laneId): \(error)")
            }
        )
        let stream: SCStream
        do {
            stream = try startCaptureStream(
                displayId: displayId,
                windowId: nil,
                configuration: configuration,
                sink: sink,
                label: "record.start"
            )
        } catch {
            // The writer never received a frame, so there is no moov atom to
            // finalise and nothing to salvage: cancel it and take the empty
            // file with it, or the next `record.start` inherits a stale path.
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: url)
            throw error
        }

        let startedAt = Date()
        lock.lock()
        // A stop inside the capture wait cancelled this start. The writer has
        // not been handed a frame (the sink finds no state), so it is
        // cancelled with its empty file.
        guard startingRecordings.finish(reservation), recordings[laneId] == nil else {
            lock.unlock()
            reservationEnded = true
            stream.stopCapture { _ in }
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: url)
            log("recording for lane \(laneId) was stopped while it was starting; discarded it")
            throw cancelled()
        }
        reservationEnded = true
        recordings[laneId] = RecordingState(
            writer: writer,
            input: input,
            adaptor: adaptor,
            stream: stream,
            sink: sink,
            filePath: filePath,
            startedAt: startedAt,
            firstPresentationTime: nil,
            firstFrameAt: nil,
            idleCut: RecordingIdleCut(enabled: !keepIdle),
            pendingBuffer: nil
        )
        lock.unlock()
        return startedAt
    }

    /// A finished recording. `durationMs` is the file's length, after idle
    /// cutting; `wallDurationMs` the real time from the first frame to the
    /// stop; `idleCutMs` the difference, cut as dead time.
    struct FinishedRecording {
        var filePath: String
        var durationMs: Int
        var wallDurationMs: Int
        var idleCutMs: Int
    }

    /// `finalizeBudget` bounds the wait for `finishWriting`; shutdown passes
    /// what is left of its own deadline.
    func stopRecording(
        laneId: String,
        finalizeBudget: TimeInterval = CaptureEngine.recordingFinalizeBudget
    ) throws -> FinishedRecording {
        // Taken before the state is removed and held through the finalize:
        // every append either finished before this line or will find its
        // recording gone and return without touching the adaptor.
        appendLock.lock()
        defer { appendLock.unlock() }
        lock.lock()
        guard let state = recordings.removeValue(forKey: laneId) else {
            let cancelledStart = startingRecordings.cancel(laneId)
            lock.unlock()
            throw DriverError(
                code: DriverErrorCode.recordingNotRunning,
                message: cancelledStart
                    ? "Lane \(laneId)'s recording was still starting; the start was cancelled and there is no file."
                    : "Lane \(laneId) is not recording."
            )
        }
        lock.unlock()
        state.stream.stopCapture { _ in }
        lock.lock()
        recordedFrameCounts.removeValue(forKey: laneId)
        lock.unlock()

        // A recording that never received a frame has no moov and no pictures:
        // it is not a short video, and answering `ok` with its path filed a
        // zero-byte file as proof. Refused with a reason the caller can act on.
        guard state.firstPresentationTime != nil else {
            state.writer.cancelWriting()
            try? FileManager.default.removeItem(at: URL(fileURLWithPath: state.filePath))
            throw DriverError(
                code: DriverErrorCode.internalError,
                message: "The recording for lane \(laneId) captured no frames; "
                    + "the display produced no picture while it was running."
            )
        }

        // The real length runs from the first frame to now. The file keeps
        // what the idle cut leaves of it, and a still that runs to the stop is
        // cut like any other.
        var idleCut = state.idleCut
        let wallSeconds = max(0, Date().timeIntervalSince(state.firstFrameAt ?? state.startedAt))
        let finish = idleCut.finish(at: wallSeconds, pendingFrame: state.pendingBuffer != nil)
        if let finalFrame = finish.finalFrame,
           let buffer = state.pendingBuffer,
           state.writer.status == .writing,
           state.input.isReadyForMoreMediaData {
            state.adaptor.append(buffer, withPresentationTime: CMTime(seconds: finalFrame, preferredTimescale: 600))
        }

        if state.writer.status == .writing {
            // Close the session where the idle cut says the file ends.
            // AVFoundation otherwise leaves the session open to the writer's
            // own idea of "now", and the mp4 container's length matches
            // neither the pictures nor the report below.
            let writer = state.writer
            let settled = Self.finalizeRecordingWriter(
                writer: writer,
                input: state.input,
                endTime: CMTime(seconds: finish.end, preferredTimescale: 600),
                timeout: finalizeBudget,
                onCompletion: { [weak self] in self?.releaseAbandonedWriter(writer) }
            )
            if !settled {
                // The mux is still running — usually a long recording, or a
                // writer that hit an AVFoundation stall. Answering `ok` here
                // would hand the caller a file whose moov may not exist yet,
                // and waiting is what wedged the driver's single main thread
                // for the test drive. Keep the writer alive so the completion
                // can still finish the file, and report the partial path.
                abandonWriter(writer)
                throw DriverError(
                    code: DriverErrorCode.internalError,
                    message: "The recording for lane \(laneId) did not finalise within "
                        + "\(String(format: "%.1f", finalizeBudget))s; \(state.filePath) may be unplayable, "
                        + "and its finalisation is still running."
                )
            }
        }
        if state.writer.status == .failed {
            // An mp4 that never got its moov atom is not a short video, it is
            // not a video, and answering `ok` with its path would send the
            // caller to a file no player can open.
            throw DriverError(
                code: DriverErrorCode.internalError,
                message: "The recording for lane \(laneId) failed: "
                    + "\(state.writer.error.map { "\($0)" } ?? "AVAssetWriter gave no reason")."
            )
        }
        // The reported duration is the session's end, so it matches the
        // container the caller is about to open.
        let durationMs = Int((finish.end * 1000).rounded())
        let wallDurationMs = Int((wallSeconds * 1000).rounded())
        return FinishedRecording(
            filePath: state.filePath,
            durationMs: durationMs,
            wallDurationMs: wallDurationMs,
            idleCutMs: max(wallDurationMs - durationMs, 0)
        )
    }

    /// A greyscale thumbnail of a captured BGRA frame, for the idle cut.
    static func idleThumbnail(of buffer: CVPixelBuffer) -> ScreenChange.Thumbnail? {
        guard
            CVPixelBufferGetPixelFormatType(buffer) == kCVPixelFormatType_32BGRA,
            CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess
        else { return nil }
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let height = CVPixelBufferGetHeight(buffer)
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        return ScreenChange.thumbnail(
            bgra: UnsafeRawBufferPointer(start: base, count: bytesPerRow * height),
            width: CVPixelBufferGetWidth(buffer),
            height: height,
            bytesPerRow: bytesPerRow
        )
    }

    /// The one finalize sequence `stopRecording` runs.
    ///
    /// Extracted so a test can hold a real `AVAssetWriter` to the same budget
    /// without a window server: the bug this replaces was a stop that waited
    /// fifteen seconds on a writer that had nothing left to say, and the
    /// completion never arrived in that window. `onCompletion` fires on the
    /// writer's own queue exactly once, late or on time.
    @discardableResult
    static func finalizeRecordingWriter(
        writer: AVAssetWriter,
        input: AVAssetWriterInput,
        endTime: CMTime?,
        timeout: TimeInterval = CaptureEngine.recordingFinalizeBudget,
        onCompletion: (() -> Void)? = nil
    ) -> Bool {
        // Status first: `markAsFinished` raises an ObjC exception on a writer
        // that never started (`status == .unknown`), which is a legal state —
        // it is what a display that produced no frame leaves behind — and an
        // exception here is a crash, not a refusal. `finishWriting` marks every
        // unfinished input finished itself, so there is nothing to do for a
        // writer that never began.
        guard writer.status == .writing else { return writer.status == .completed }
        input.markAsFinished()
        if let endTime {
            writer.endSession(atSourceTime: endTime)
        }
        let finished = SettledFlag()
        writer.finishWriting {
            onCompletion?()
            finished.set()
        }
        RunLoopPump.wait(until: { finished.isSet }, timeout: timeout)
        return finished.isSet
    }

    /// Keeps a late-finalising writer alive until its own completion runs.
    private func abandonWriter(_ writer: AVAssetWriter) {
        guard writer.status == .writing else { return }
        lock.lock()
        if !abandonedWriters.contains(where: { $0 === writer }) {
            abandonedWriters.append(writer)
        }
        lock.unlock()
    }

    private func releaseAbandonedWriter(_ writer: AVAssetWriter) {
        lock.lock()
        abandonedWriters.removeAll { $0 === writer }
        let remaining = abandonedWriters.count
        lock.unlock()
        log("recording writer finished late (status \(writer.status.rawValue)); \(remaining) still pending")
    }

    func isRecording(laneId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return recordings[laneId] != nil
    }

    /// How many frames the lane's recording has appended so far.
    ///
    /// Read by the live test to wait for a picture before stopping, and by
    /// nobody else: the stop path decides "captured nothing" from the state it
    /// removed, not from this counter.
    func recordedFrameCount(laneId: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        return recordedFrameCounts[laneId] ?? 0
    }

    /// Stops everything. `finalizeBudget` is shared by all recordings, so a
    /// driver that is exiting finishes inside the client's kill window
    /// however many lanes were recording.
    func dispose(finalizeBudget: TimeInterval = CaptureEngine.recordingFinalizeBudget) {
        lock.lock()
        startingStreams.cancelAll()
        startingRecordings.cancelAll()
        let laneIds = Array(streams.keys)
        let recordingLanes = Array(recordings.keys)
        lock.unlock()
        for laneId in laneIds {
            stopStream(laneId: laneId)
        }
        let deadline = Date().addingTimeInterval(finalizeBudget)
        for laneId in recordingLanes {
            _ = try? stopRecording(
                laneId: laneId,
                finalizeBudget: max(0.05, deadline.timeIntervalSinceNow)
            )
        }
    }
}
