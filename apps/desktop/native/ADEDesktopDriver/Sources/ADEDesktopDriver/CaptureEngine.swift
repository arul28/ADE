/// Pixels: screenshots, the numbered element map, the H.264 live stream, and
/// recordings.
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
// The loopback byte server
// ---------------------------------------------------------------------------

/// A plain TCP fan-out on 127.0.0.1.
///
/// Loopback-only and unauthenticated by design: the security boundary is the
/// Node service's token-guarded HTTP endpoint in front of it, exactly as it is
/// for `iosVideoStreamServer.ts`. Binding anything but loopback here would move
/// that boundary onto the network, so the host is not configurable.
final class StreamByteServer {
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private let queue = DispatchQueue(label: "com.ade.desktop-driver.stream")
    private let lock = NSLock()
    private var configRecord: Data?

    private(set) var port: UInt16 = 0

    var clientCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return connections.count
    }

    func start() throws -> UInt16 {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        guard let assigned = listener.port?.rawValue, assigned != 0 else {
            listener.cancel()
            throw CaptureError.failed("The stream server never got a loopback port.")
        }
        self.listener = listener
        self.port = assigned
        return assigned
    }

    func setConfig(codec: String) {
        lock.lock()
        configRecord = StreamRecord.configRecord(codec: codec)
        lock.unlock()
    }

    private func accept(_ connection: NWConnection) {
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .cancelled, .failed:
                self?.drop(connection)
            default:
                break
            }
        }
        connection.start(queue: queue)
        lock.lock()
        connections.append(connection)
        let config = configRecord
        lock.unlock()
        // A reader that attaches mid-stream needs the codec string before it can
        // configure its decoder; the next keyframe carries the parameter sets.
        if let config {
            connection.send(content: config, completion: .contentProcessed { _ in })
        }
    }

    private func drop(_ connection: NWConnection) {
        lock.lock()
        connections.removeAll { $0 === connection }
        lock.unlock()
    }

    func broadcast(_ data: Data) {
        lock.lock()
        let targets = connections
        lock.unlock()
        for connection in targets {
            connection.send(content: data, completion: .contentProcessed { _ in })
        }
    }

    func stop() {
        lock.lock()
        let targets = connections
        connections.removeAll()
        lock.unlock()
        for connection in targets {
            connection.cancel()
        }
        listener?.cancel()
        listener = nil
        port = 0
    }
}

// ---------------------------------------------------------------------------
// The encoder
// ---------------------------------------------------------------------------

/// VideoToolbox H.264, emitting Annex-B access units.
///
/// SPS/PPS are re-emitted in front of every keyframe rather than only once. A
/// viewer can attach at any moment, and a decoder that joined after the single
/// copy of the parameter sets went past would sit on a black frame forever.
final class H264Encoder {
    private var session: VTCompressionSession?
    private let width: Int
    private let height: Int
    private var codecString: String?
    private let onAccessUnit: (Data, Bool, String?) -> Void

    init(width: Int, height: Int, fps: Int, onAccessUnit: @escaping (Data, Bool, String?) -> Void) throws {
        self.width = width
        self.height = height
        self.onAccessUnit = onAccessUnit

        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session
        )
        guard status == noErr, let session else {
            throw CaptureError.failed("VideoToolbox refused an H.264 session (status \(status)).")
        }
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_ProfileLevel,
            value: kVTProfileLevel_H264_High_AutoLevel
        )
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        // A keyframe every two seconds: the cost of a viewer's cold start.
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration,
            value: NSNumber(value: 2.0)
        )
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_ExpectedFrameRate,
            value: NSNumber(value: max(1, fps))
        )
        VTCompressionSessionPrepareToEncodeFrames(session)
        self.session = session
    }

    func setRate(fps: Int) {
        guard let session else { return }
        VTSessionSetProperty(
            session,
            key: kVTCompressionPropertyKey_ExpectedFrameRate,
            value: NSNumber(value: max(1, fps))
        )
    }

    func encode(pixelBuffer: CVPixelBuffer, presentationTime: CMTime) {
        guard let session else { return }
        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: presentationTime,
            duration: .invalid,
            frameProperties: nil,
            infoFlagsOut: nil
        ) { [weak self] status, _, sampleBuffer in
            guard status == noErr, let sampleBuffer, let self else { return }
            self.handle(sampleBuffer)
        }
    }

    private func handle(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }
        let isKeyframe = Self.isKeyframe(sampleBuffer)
        var payload = Data()

        if isKeyframe, let formatDescription = CMSampleBufferGetFormatDescription(sampleBuffer) {
            for index in 0..<2 {
                var parameterSet: UnsafePointer<UInt8>?
                var parameterSetSize = 0
                var parameterSetCount = 0
                var nalUnitHeaderLength: Int32 = 0
                let status = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                    formatDescription,
                    parameterSetIndex: index,
                    parameterSetPointerOut: &parameterSet,
                    parameterSetSizeOut: &parameterSetSize,
                    parameterSetCountOut: &parameterSetCount,
                    nalUnitHeaderLengthOut: &nalUnitHeaderLength
                )
                guard status == noErr, let parameterSet else { continue }
                payload.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
                payload.append(parameterSet, count: parameterSetSize)
                if index == 0, codecString == nil, parameterSetSize >= 4 {
                    codecString = String(
                        format: "avc1.%02X%02X%02X",
                        parameterSet[1],
                        parameterSet[2],
                        parameterSet[3]
                    ).lowercased()
                }
            }
        }

        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        ) == noErr, let dataPointer else { return }

        // AVCC (4-byte big-endian length prefixes) to Annex-B start codes.
        var offset = 0
        while offset + 4 <= totalLength {
            var nalLength: UInt32 = 0
            memcpy(&nalLength, dataPointer + offset, 4)
            nalLength = CFSwapInt32BigToHost(nalLength)
            guard nalLength > 0, offset + 4 + Int(nalLength) <= totalLength else { break }
            payload.append(contentsOf: [0x00, 0x00, 0x00, 0x01])
            payload.append(
                UnsafeBufferPointer(
                    start: UnsafeRawPointer(dataPointer + offset + 4).assumingMemoryBound(to: UInt8.self),
                    count: Int(nalLength)
                )
            )
            offset += 4 + Int(nalLength)
        }
        guard !payload.isEmpty else { return }
        onAccessUnit(payload, isKeyframe, codecString)
    }

    private static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false),
              CFArrayGetCount(attachments) > 0
        else { return true }
        let first = unsafeBitCast(CFArrayGetValueAtIndex(attachments, 0), to: CFDictionary.self)
        guard let dictionary = first as? [CFString: Any] else { return true }
        // "not a sync sample" absent, or false, means this *is* a keyframe.
        return !((dictionary[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
    }

    func stop() {
        guard let session else { return }
        VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
        VTCompressionSessionInvalidate(session)
        self.session = nil
    }
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
    }

    private var streams: [String: StreamState] = [:]
    private var recordings: [String: RecordingState] = [:]
    private var lastFrames: [String: CGImage] = [:]
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
        lock.lock()
        lastFrames[laneId] = image
        lock.unlock()
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

    /// The last frame the stream encoded, as a PNG. Feeds the turn time-lapse.
    func writeLastFrame(laneId: String, path: String) throws -> (width: Int, height: Int) {
        lock.lock()
        let image = lastFrames[laneId]
        lock.unlock()
        guard let image else {
            throw CaptureError.noSurface("No frame has been captured for lane \(laneId) yet.")
        }
        try Self.writePNG(image, to: path)
        return (image.width, image.height)
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
            server.broadcast(StreamRecord.accessUnitRecord(payload: payload, keyframe: keyframe))
        }

        let sink = CaptureFrameSink(
            onFrame: { [weak self] sampleBuffer in
                guard let self, let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
                encoder.encode(
                    pixelBuffer: buffer,
                    presentationTime: CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                )
                if let image = Self.makeImage(from: buffer) {
                    self.lock.lock()
                    self.lastFrames[laneId] = image
                    self.lock.unlock()
                }
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
            startedAt: Date()
        )
        lock.unlock()
        log("stream for lane \(laneId) on 127.0.0.1:\(port) at \(configuration.width)x\(configuration.height)@\(fps)")
        return (port, configuration.width, configuration.height, nil)
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
                self.lock.unlock()
                guard input.isReadyForMoreMediaData, writer.status == .writing else { return }
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
            firstPresentationTime: nil
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
            state.writer.finishWriting { finished = true }
            RunLoopPump.wait(until: { finished }, timeout: 15)
        }
        let durationMs = Int(Date().timeIntervalSince(state.startedAt) * 1000)
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

/// Turning an async framework call back into a straight line.
///
/// The driver is single-threaded by design — one NDJSON request at a time,
/// answered in order — but ScreenCaptureKit and AVFoundation only speak
/// callbacks. Pumping the run loop keeps AppKit, the `AXObserver` sources and
/// the window watcher alive while a capture is in flight; a bare semaphore wait
/// on the main thread would deadlock the very callbacks it waits for.
enum RunLoopPump {
    static func wait(until condition: () -> Bool, timeout: TimeInterval) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition(), Date() < deadline {
            RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
        }
    }
}
