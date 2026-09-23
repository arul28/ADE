import Foundation
import AVFoundation
import CoreMedia
import CoreVideo
import CoreGraphics
import CoreText
import ImageIO

/// Writes an H.264 MP4 of one device, with input decorations composited into
/// the file and nowhere else.
///
/// Three properties are load-bearing and easy to lose in a refactor:
///
/// 1. **The recording is a second consumer of the same capture, not a second
///    capture.** It attaches to the `CaptureEngine` the live stream already
///    uses, so recording while somebody watches costs one extra encode, not a
///    second framebuffer subscription — and recording with *nobody* watching
///    works, because `DeviceSession` starts capture on its behalf.
/// 2. **Frames are pulled at a fixed cadence, not pushed.** A simulator that
///    renders nothing emits nothing beyond the capture layer's 5 fps idle
///    floor, and a stalled one emits nothing at all. A pacer that re-writes the
///    last decoded frame at the target rate keeps the timeline honest in both
///    cases: the MP4's duration always matches wall-clock, and an overlay
///    animates smoothly over a static screen.
/// 3. **Overlays never touch the live stream.** They are drawn here, into the
///    pixel buffer handed to `AVAssetWriter`, and the bytes the renderer is
///    decoding never pass through this file. (t3code #12779 calls this a
///    "detached compositor"; the reason is the same — a human driving the
///    device must not see decorations for the agent's benefit.)
///
/// ## Why JPEG is in the path
///
/// `CaptureEngine.addConsumer` is private upstream, so ADE cannot register an
/// encoder of its own (see `Vendor/serve-sim/VENDORED.md`, "How ADE stays out
/// of the vendored code"). The only consumer API that yields pixels rather than
/// an H.264 bitstream is `addMJPEGConsumer`, so each recorded frame is decoded
/// from the JPEG the engine already produced. `MJPEGEncoder` caches by frame
/// id, so a live MJPEG viewer and this recorder share one encode; the decode is
/// paid once per *written* frame, not once per captured frame, because the
/// pacer decodes lazily and caches by payload identity. Widening the upstream
/// API is the real fix, and is where this should go if the cost ever matters.
actor RecordingSession {
    /// Encoding on the cooperative pool would starve the other device's
    /// capture, exactly as `VideoEncoder` and `FrameCapture` avoid.
    private let queue = DispatchSerialQueue(label: "com.ade.sim-helper.recorder", qos: .userInitiated)
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    struct Finished: Sendable {
        let path: String
        let durationMs: Int
        let bytes: Int
    }

    enum RecordingError: Error, LocalizedError {
        case alreadyRecording
        case writerUnavailable(String)
        case noFrames

        var errorDescription: String? {
            switch self {
            case .alreadyRecording:
                return "This device is already recording."
            case let .writerUnavailable(message):
                return message
            case .noFrames:
                return "No frame arrived before the recording was stopped."
            }
        }
    }

    let path: String
    private let fps: Int
    private let overlaysEnabled: Bool
    private let accent: RecordingOverlay.Colour
    private let metrics: DeviceMetrics

    private var unsubscribe: (@Sendable () async -> Void)?
    private var pacer: Task<Void, Never>?

    private var latestJPEG: Data?
    private var decoded: (payload: Data, image: CGImage)?
    private var timeline = RecordingOverlay.Timeline()

    private var writer: AVAssetWriter?
    private var input: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var sessionStartedAt: TimeInterval?
    private var lastPresentationSeconds: Double = -1
    private var writtenFrames = 0
    private var stopped = false

    /// Monotonic seconds. Wall clock would let an NTP step rewrite the
    /// timeline mid-recording, which `AVAssetWriter` answers by refusing every
    /// subsequent frame.
    private static func now() -> TimeInterval { ProcessInfo.processInfo.systemUptime }

    init(
        path: String,
        fps: Int,
        overlays: Bool,
        accent: RecordingOverlay.Colour,
        metrics: DeviceMetrics
    ) {
        self.path = path
        self.fps = min(max(fps, 1), 60)
        self.overlaysEnabled = overlays
        self.accent = accent
        self.metrics = metrics
    }

    // MARK: - Lifecycle

    func start(engine: CaptureEngine) async throws {
        guard unsubscribe == nil, !stopped else { throw RecordingError.alreadyRecording }

        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        // AVAssetWriter refuses to open a path that already exists, and a
        // caller re-using an id is a caller that wants the newer take.
        try? FileManager.default.removeItem(at: url)

        unsubscribe = await engine.addMJPEGConsumer { [weak self] _, data in
            await self?.ingest(data)
        }

        let interval = UInt64(1_000_000_000 / UInt64(fps))
        pacer = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.tick()
                try? await Task.sleep(nanoseconds: interval)
            }
        }
    }

    func stop() async throws -> Finished {
        guard !stopped else { throw RecordingError.alreadyRecording }
        stopped = true

        pacer?.cancel()
        pacer = nil
        await unsubscribe?()
        unsubscribe = nil

        guard let writer, let input, let startedAt = sessionStartedAt else {
            try? FileManager.default.removeItem(atPath: path)
            throw RecordingError.noFrames
        }

        let durationSeconds = max(Self.now() - startedAt, lastPresentationSeconds)
        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(seconds: durationSeconds, preferredTimescale: 600))
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            writer.finishWriting { continuation.resume() }
        }

        if writer.status == .failed {
            throw RecordingError.writerUnavailable(
                writer.error?.localizedDescription ?? "The recording could not be finished."
            )
        }

        let bytes = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)??.intValue ?? 0
        return Finished(
            path: path,
            durationMs: Int((durationSeconds * 1000).rounded()),
            bytes: bytes
        )
    }

    /// True while the pacer is running — used by `DeviceSession` to answer
    /// "is this device recording" without a second piece of state.
    var isRunning: Bool { !stopped && unsubscribe != nil }

    // MARK: - Overlay input

    func noteTap(point: DevicePoint) {
        guard overlaysEnabled else { return }
        let normalized = metrics.normalize(point)
        timeline.addTap(x: Double(normalized.x), y: Double(normalized.y), at: Self.now())
    }

    func noteText(_ text: String) {
        guard overlaysEnabled else { return }
        timeline.setText(RecordingOverlay.badgeText(for: text), at: Self.now())
    }

    // MARK: - Frame pipeline

    private func ingest(_ jpeg: Data) {
        latestJPEG = jpeg
    }

    private func tick() async {
        guard !stopped, let jpeg = latestJPEG else { return }

        let image: CGImage
        if let decoded, decoded.payload == jpeg {
            // The simulator is idle, or is producing frames faster than the
            // pacer writes them. Either way the decode is already paid for.
            image = decoded.image
        } else {
            guard
                let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
                let fresh = CGImageSourceCreateImageAtIndex(source, 0, nil)
            else { return }
            decoded = (jpeg, fresh)
            image = fresh
        }

        let now = Self.now()
        if writer == nil {
            guard prepareWriter(width: image.width, height: image.height) else { return }
            sessionStartedAt = now
        }
        guard
            let input,
            let adaptor,
            let startedAt = sessionStartedAt,
            input.isReadyForMoreMediaData
        else { return }

        timeline.prune(at: now)
        guard let buffer = composite(image: image, adaptor: adaptor, at: now) else { return }

        // Strictly increasing, even if two ticks land inside one timescale unit.
        var seconds = now - startedAt
        if seconds <= lastPresentationSeconds {
            seconds = lastPresentationSeconds + (1.0 / Double(fps))
        }
        lastPresentationSeconds = seconds

        if adaptor.append(buffer, withPresentationTime: CMTime(seconds: seconds, preferredTimescale: 600)) {
            writtenFrames += 1
        }
    }

    private func prepareWriter(width: Int, height: Int) -> Bool {
        guard width > 0, height > 0 else { return false }
        guard let writer = try? AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: .mp4) else {
            return false
        }

        // Scale the bitrate with the real frame area rather than pinning a
        // number: an iPad framebuffer is four times an iPhone's, and one
        // constant makes one of them look bad.
        let pixels = Double(width * height)
        let bitrate = Int(min(max(pixels * Double(fps) * 0.07, 1_500_000), 12_000_000))

        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: bitrate,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                // A keyframe every two seconds keeps scrubbing usable without
                // paying for an all-intra file.
                AVVideoMaxKeyFrameIntervalKey: fps * 2,
                AVVideoAllowFrameReorderingKey: false,
            ],
        ]
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        // The frames arrive live; without this the writer buffers aggressively
        // and a `stop` right after a `start` produces an empty file.
        input.expectsMediaDataInRealTime = true
        guard writer.canAdd(input) else { return false }
        writer.add(input)

        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [:],
            ]
        )

        guard writer.startWriting() else { return false }
        writer.startSession(atSourceTime: .zero)

        self.writer = writer
        self.input = input
        self.adaptor = adaptor
        return true
    }

    /// Draw one frame — the device picture, then whatever decorations are alive.
    private func composite(
        image: CGImage,
        adaptor: AVAssetWriterInputPixelBufferAdaptor,
        at time: TimeInterval
    ) -> CVPixelBuffer? {
        guard let pool = adaptor.pixelBufferPool else { return nil }
        var out: CVPixelBuffer?
        guard
            CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out) == kCVReturnSuccess,
            let buffer = out
        else { return nil }

        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }

        let width = CVPixelBufferGetWidth(buffer)
        let height = CVPixelBufferGetHeight(buffer)
        guard
            let base = CVPixelBufferGetBaseAddress(buffer),
            let context = CGContext(
                data: base,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
            )
        else { return nil }

        // NO flip. A `CGBitmapContext` over a CVPixelBuffer already treats
        // memory row 0 as the top of the picture, so drawing the decoded frame
        // into the full rect reproduces it the right way up — an extra flip
        // here mirrors the whole device screen while leaving text upright,
        // which is exactly what it looked like before this comment existed.
        //
        // The cost is that CoreGraphics y grows upward while the wire's y
        // grows downward, so every overlay converts once, at the call site,
        // through `flipY`.
        context.interpolationQuality = .none
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

        guard overlaysEnabled, !timeline.isEmpty else { return buffer }
        drawRings(in: context, width: width, height: height, at: time)
        drawBadge(in: context, width: width, height: height, at: time)
        return buffer
    }

    private func drawRings(in context: CGContext, width: Int, height: Int, at time: TimeInterval) {
        let shortSide = Double(min(width, height))
        for ring in timeline.rings {
            let progress = RecordingOverlay.progress(
                age: time - ring.startedAt,
                duration: RecordingOverlay.tapRingDuration
            )
            let radius = RecordingOverlay.ringRadius(progress: progress, frameShortSide: shortSide)
            // `ring.y` is a top-down fraction, CoreGraphics is bottom-up.
            let centre = CGPoint(
                x: ring.x * Double(width),
                y: (1 - ring.y) * Double(height)
            )

            let ringAlpha = RecordingOverlay.ringOpacity(progress: progress)
            if ringAlpha > 0.01 {
                context.setStrokeColor(
                    red: accent.red, green: accent.green, blue: accent.blue, alpha: ringAlpha
                )
                context.setLineWidth(max(shortSide * 0.006, 2))
                context.strokeEllipse(in: CGRect(
                    x: centre.x - radius, y: centre.y - radius,
                    width: radius * 2, height: radius * 2
                ))
            }

            let dotAlpha = RecordingOverlay.dotOpacity(progress: progress)
            if dotAlpha > 0.01 {
                let dot = shortSide * RecordingOverlay.ringMinRadiusFraction * 0.7
                context.setFillColor(
                    red: accent.red, green: accent.green, blue: accent.blue, alpha: dotAlpha * 0.55
                )
                context.fillEllipse(in: CGRect(
                    x: centre.x - dot, y: centre.y - dot, width: dot * 2, height: dot * 2
                ))
            }
        }
    }

    private func drawBadge(in context: CGContext, width: Int, height: Int, at time: TimeInterval) {
        guard let badge = timeline.badge else { return }
        let progress = RecordingOverlay.progress(
            age: time - badge.startedAt,
            duration: RecordingOverlay.textBadgeDuration
        )
        let alpha = RecordingOverlay.badgeOpacity(progress: progress)
        guard alpha > 0.01 else { return }

        let shortSide = Double(min(width, height))
        let fontSize = max(shortSide * 0.032, 12)
        let font = CTFontCreateWithName("Menlo-Bold" as CFString, fontSize, nil)
        let attributes: [CFString: Any] = [
            kCTFontAttributeName: font,
            kCTForegroundColorAttributeName: CGColor(red: 1, green: 1, blue: 1, alpha: alpha),
        ]
        let attributed = CFAttributedStringCreate(
            kCFAllocatorDefault,
            badge.text as CFString,
            attributes as CFDictionary
        )
        guard let attributed else { return }
        let line = CTLineCreateWithAttributedString(attributed)
        let textWidth = CTLineGetTypographicBounds(line, nil, nil, nil)

        let padX = fontSize * 0.7
        let pillWidth = min(textWidth + padX * 2, Double(width) * 0.92)
        let pillHeight = fontSize * 1.75
        // Above the home indicator, not on it: a badge that sits on the gesture
        // bar is unreadable on every modern device. CoreGraphics y is measured
        // from the bottom, so this inset is the pill's distance from it.
        let pillY = Double(height) * 0.10
        let pillX = (Double(width) - pillWidth) / 2
        let pill = CGRect(x: pillX, y: pillY, width: pillWidth, height: pillHeight)

        context.setFillColor(red: 0.04, green: 0.05, blue: 0.07, alpha: alpha * 0.82)
        let rounded = CGPath(
            roundedRect: pill,
            cornerWidth: pillHeight / 2,
            cornerHeight: pillHeight / 2,
            transform: nil
        )
        context.addPath(rounded)
        context.fillPath()
        context.setStrokeColor(red: accent.red, green: accent.green, blue: accent.blue, alpha: alpha * 0.85)
        context.setLineWidth(max(shortSide * 0.003, 1))
        context.addPath(rounded)
        context.strokePath()

        context.saveGState()
        context.textMatrix = .identity
        // Descender-aware centring: `midY - 0.36em` puts the cap height, not
        // the line box, on the pill's axis.
        context.textPosition = CGPoint(x: pill.minX + padX, y: pill.midY - fontSize * 0.36)
        CTLineDraw(line, context)
        context.restoreGState()
    }
}
