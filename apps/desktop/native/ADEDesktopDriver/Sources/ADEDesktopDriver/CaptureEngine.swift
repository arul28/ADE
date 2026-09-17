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
    }

    struct RecordingState {
        var writer: AVAssetWriter
        var input: AVAssetWriterInput
        var adaptor: AVAssetWriterInputPixelBufferAdaptor
        var stream: SCStream
        var sink: AnyObject
        var filePath: String
        var startedAt: Date
        var firstPresentationTime: CMTime?
        /// The last timestamp actually handed to the adaptor.
        ///
        /// `endSession(atSourceTime:)` needs it: without an explicit end the
        /// container's duration runs to wherever the writer thinks the session
        /// went, which is seconds past the final frame, and every player shows
        /// a clip that ends in a freeze.
        var lastPresentationTime: CMTime?
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
    private var recordings: [String: RecordingState] = [:]
    private let lock = NSRecursiveLock()
    private let log: (String) -> Void
    private let emit: (DriverEvent) -> Void

    init(log: @escaping (String) -> Void, emit: @escaping (DriverEvent) -> Void) {
        self.log = log
        self.emit = emit
    }

    // -----------------------------------------------------------------------
    // Content lookup
    // -----------------------------------------------------------------------

    @available(macOS 12.3, *)
    private func shareableContent() throws -> SCShareableContent {
        var result: Result<SCShareableContent, Error>?
        SCShareableContent.getExcludingDesktopWindows(true, onScreenWindowsOnly: false) { content, error in
            if let content {
                result = .success(content)
            } else {
                result = .failure(error ?? CaptureError.failed("ScreenCaptureKit returned no content."))
            }
        }
        RunLoopPump.wait(until: { result != nil }, timeout: 10)
        switch result {
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
        let (contentFilter, width, height) = try filter(displayId: displayId, windowId: windowId)
        let configuration = SCStreamConfiguration()
        configuration.width = max(1, width)
        configuration.height = max(1, height)
        configuration.showsCursor = false

        if #available(macOS 14.0, *) {
            var result: Result<CGImage, Error>?
            SCScreenshotManager.captureImage(contentFilter: contentFilter, configuration: configuration) { image, error in
                if let image {
                    result = .success(image)
                } else {
                    result = .failure(error ?? CaptureError.failed("ScreenCaptureKit returned no image."))
                }
            }
            RunLoopPump.wait(until: { result != nil }, timeout: 10)
            switch result {
            case .success(let image): return image
            case .failure(let error): throw error
            case nil: throw CaptureError.failed("The screenshot did not arrive in time.")
            }
        }

        // macOS 13: no screenshot API, so one frame is pulled off a short-lived
        // stream. Same content filter, same permission, more ceremony.
        var captured: CGImage?
        var failure: Error?
        let sink = CaptureFrameSink(
            onFrame: { sampleBuffer in
                guard captured == nil, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
                captured = Self.makeImage(from: buffer)
            },
            onError: { failure = $0 }
        )
        let stream = SCStream(filter: contentFilter, configuration: configuration, delegate: sink)
        try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: .global(qos: .userInitiated))
        var started = false
        stream.startCapture { error in
            failure = error
            started = true
        }
        RunLoopPump.wait(until: { captured != nil || (started && failure != nil) }, timeout: 10)
        stream.stopCapture { _ in }
        if let captured { return captured }
        throw failure ?? CaptureError.failed("No frame arrived from ScreenCaptureKit.")
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

    func startStream(
        laneId: String,
        displayId: CGDirectDisplayID,
        fps: Int
    ) throws -> (port: UInt16, width: Int, height: Int, codec: String?) {
        guard #available(macOS 12.3, *) else {
            throw CaptureError.failed("ScreenCaptureKit needs macOS 12.3 or newer.")
        }
        lock.lock()
        if let existing = streams[laneId] {
            lock.unlock()
            return (existing.server.port, existing.width, existing.height, existing.codec)
        }
        lock.unlock()

        let (contentFilter, width, height) = try filter(displayId: displayId, windowId: nil)
        let configuration = SCStreamConfiguration()
        configuration.width = max(2, width - width % 2)
        configuration.height = max(2, height - height % 2)
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = false
        configuration.queueDepth = 5

        let server = StreamByteServer()
        let port = try server.start()

        let encoder = try H264Encoder(
            width: configuration.width,
            height: configuration.height,
            fps: fps
        ) { [weak self] payload, keyframe, codec in
            guard let self else { return }
            if let codec {
                self.lock.lock()
                if self.streams[laneId]?.codec != codec {
                    self.streams[laneId]?.codec = codec
                    server.setConfig(codec: codec)
                }
                self.lock.unlock()
            }
            self.lock.lock()
            self.streams[laneId]?.lastEncodedAt = Date()
            self.lock.unlock()
            server.broadcast(StreamRecord.accessUnitRecord(payload: payload, keyframe: keyframe))
        }
        // A reader attaching is the one moment a keyframe is owed immediately.
        server.onClientAttached = { [weak self] in
            self?.refreshKeyframe(laneId: laneId)
        }

        let sink = CaptureFrameSink(
            onFrame: { [weak self] sampleBuffer in
                guard let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
                let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                if let self {
                    self.lock.lock()
                    self.streams[laneId]?.lastBuffer = buffer
                    if CMTIME_IS_NUMERIC(time) { self.streams[laneId]?.lastPresentationTime = time }
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
        let stream = SCStream(filter: contentFilter, configuration: configuration, delegate: sink)
        try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: .global(qos: .userInitiated))
        var startError: Error?
        var started = false
        stream.startCapture { error in
            startError = error
            started = true
        }
        RunLoopPump.wait(until: { started }, timeout: 10)
        if let startError {
            server.stop()
            encoder.stop()
            throw startError
        }

        lock.lock()
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
            lastBuffer: nil,
            lastPresentationTime: .zero,
            lastEncodedAt: Date(),
            keepAlive: nil
        )
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
        let configuration = SCStreamConfiguration()
        configuration.width = state.width
        configuration.height = state.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.showsCursor = false
        configuration.queueDepth = 5
        state.stream.updateConfiguration(configuration) { _ in }
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
            lock.unlock()
            return false
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
        filePath: String
    ) throws -> Date {
        guard #available(macOS 12.3, *) else {
            throw CaptureError.failed("ScreenCaptureKit needs macOS 12.3 or newer.")
        }
        lock.lock()
        let alreadyRunning = recordings[laneId] != nil
        lock.unlock()
        guard !alreadyRunning else {
            throw CaptureError.failed("Lane \(laneId) is already recording.")
        }

        let (contentFilter, width, height) = try filter(displayId: displayId, windowId: nil)
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
                let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                self.lock.lock()
                guard var state = self.recordings[laneId] else {
                    self.lock.unlock()
                    return
                }
                if state.firstPresentationTime == nil {
                    state.firstPresentationTime = time
                    self.recordings[laneId] = state
                    writer.startWriting()
                    writer.startSession(atSourceTime: time)
                }
                let willAppend = input.isReadyForMoreMediaData && writer.status == .writing
                if willAppend {
                    state.lastPresentationTime = time
                    self.recordings[laneId] = state
                }
                self.lock.unlock()
                guard willAppend else { return }
                adaptor.append(buffer, withPresentationTime: time)
            },
            onError: { [weak self] error in
                self?.log("recording stream error on lane \(laneId): \(error)")
            }
        )
        let stream = SCStream(filter: contentFilter, configuration: configuration, delegate: sink)
        try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: .global(qos: .userInitiated))
        var startError: Error?
        var started = false
        stream.startCapture { error in
            startError = error
            started = true
        }
        RunLoopPump.wait(until: { started }, timeout: 10)
        if let startError { throw startError }

        let startedAt = Date()
        lock.lock()
        recordings[laneId] = RecordingState(
            writer: writer,
            input: input,
            adaptor: adaptor,
            stream: stream,
            sink: sink,
            filePath: filePath,
            startedAt: startedAt,
            firstPresentationTime: nil,
            lastPresentationTime: nil
        )
        lock.unlock()
        return startedAt
    }

    func stopRecording(laneId: String) throws -> (filePath: String, durationMs: Int) {
        lock.lock()
        guard let state = recordings.removeValue(forKey: laneId) else {
            lock.unlock()
            throw DriverError(
                code: DriverErrorCode.recordingNotRunning,
                message: "Lane \(laneId) is not recording."
            )
        }
        lock.unlock()
        state.stream.stopCapture { _ in }
        state.input.markAsFinished()
        var finished = false
        if state.writer.status == .writing {
            // Close the session at the last frame we appended. AVFoundation
            // otherwise leaves the session open to the writer's own idea of
            // "now", and the mp4 container ends up seconds longer than the
            // pictures in it.
            if let last = state.lastPresentationTime {
                state.writer.endSession(atSourceTime: last)
            }
            state.writer.finishWriting { finished = true }
            RunLoopPump.wait(until: { finished }, timeout: 15)
        }
        // The reported duration is the span of frames when there are frames,
        // so it matches the container the caller is about to open. Wall clock
        // is the fallback for a recording that never received one.
        let durationMs: Int
        if let first = state.firstPresentationTime,
           let last = state.lastPresentationTime,
           CMTimeCompare(last, first) > 0 {
            durationMs = Int(CMTimeGetSeconds(CMTimeSubtract(last, first)) * 1000)
        } else {
            durationMs = Int(Date().timeIntervalSince(state.startedAt) * 1000)
        }
        return (state.filePath, durationMs)
    }

    func isRecording(laneId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return recordings[laneId] != nil
    }

    func dispose() {
        lock.lock()
        let laneIds = Array(streams.keys)
        let recordingLanes = Array(recordings.keys)
        lock.unlock()
        for laneId in laneIds {
            stopStream(laneId: laneId)
        }
        for laneId in recordingLanes {
            _ = try? stopRecording(laneId: laneId)
        }
    }
}
