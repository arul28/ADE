import ADEMediaCore
import AVFoundation
import CoreImage
import CoreVideo
import Foundation
import Metal

/// `ade-media render`: executes a `DemoPlan` over a raw recording.
///
/// One pass, decode forward only. For each output frame `n` at `n / fps` the
/// plan's segments give a source time, and the newest decoded frame at or
/// before it is the picture. That frame is cropped to the camera's viewport and
/// scaled to the output on the GPU (CoreImage on Metal), the overlays are drawn
/// on top with CoreGraphics, and the result goes to an H.264 writer at a
/// constant frame rate.
///
/// A frame that would come out identical to the one before it — same source
/// picture, same viewport, no overlays on either — is not rendered again: the
/// previous buffer is appended once more. Screen recordings are mostly still,
/// and ScreenCaptureKit writes a frame only when the screen changes, so for a
/// plain plan almost every output frame takes that path.
final class Renderer {
    private let request: DemoRenderRequest
    private let progress: (Double) -> Void

    init(request: DemoRenderRequest, progress: @escaping (Double) -> Void) {
        self.request = request
        self.progress = progress
    }

    func run() async throws -> DemoRenderResult {
        let plan = request.plan
        let timeMap = try DemoTimeMap(segments: plan.segments)
        let clock = try DemoFrameClock(durationSeconds: plan.durationSeconds, fps: plan.output.fps)
        let camera = DemoCameraTrack(keys: plan.camera)
        let output = try Self.outputSize(plan.output)
        guard plan.output.bitrate.isFinite, plan.output.bitrate > 0 else {
            throw MediaError("The plan's output bitrate must be more than zero.")
        }
        let keyframeSeconds = plan.output.keyframeIntervalSeconds.isFinite && plan.output.keyframeIntervalSeconds > 0
            ? plan.output.keyframeIntervalSeconds
            : 2

        let source = try await MediaSource.open(path: request.input)
        try source.startReading()
        defer { source.cancel() }

        let target = URL(fileURLWithPath: request.output)
        let partial = try Self.prepareTemporaryOutput(for: target)
        PartialOutput.register(partial)
        defer {
            // Whatever happens, no half-written file is left behind.
            PartialOutput.removeIfAny()
            PartialOutput.clear()
        }

        let writer: AVAssetWriter
        do {
            writer = try AVAssetWriter(outputURL: partial, fileType: .mp4)
        } catch {
            throw MediaError.describing(error, context: "Could not create the output file")
        }
        writer.shouldOptimizeForNetworkUse = true
        let settings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: output.width,
            AVVideoHeightKey: output.height,
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: Int(plan.output.bitrate.rounded()),
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC,
                AVVideoExpectedSourceFrameRateKey: plan.output.fps,
                // Both limits: the frame count alone drifts when the rate is
                // fractional, the duration alone is a ceiling some encoders
                // round up.
                AVVideoMaxKeyFrameIntervalKey: max(1, Int((keyframeSeconds * plan.output.fps).rounded())),
                AVVideoMaxKeyFrameIntervalDurationKey: keyframeSeconds,
            ],
        ]
        guard writer.canApply(outputSettings: settings, forMediaType: .video) else {
            throw MediaError("This Mac cannot encode H.264 at \(output.width)×\(output.height).")
        }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        // Not live: the writer may take its time and apply back-pressure.
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: input,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: output.width,
                kCVPixelBufferHeightKey as String: output.height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
                kCVPixelBufferMetalCompatibilityKey as String: true,
            ]
        )
        guard writer.canAdd(input) else { throw MediaError("Could not add a video track to the output file.") }
        writer.add(input)
        guard writer.startWriting() else {
            throw MediaError.describing(writer.error, context: "Could not start writing the output file")
        }
        writer.startSession(atSourceTime: .zero)

        let frames = FrameProducer(
            source: source,
            timeMap: timeMap,
            clock: clock,
            camera: camera,
            overlays: OverlayDrawer(plan: plan, width: output.width, height: output.height),
            outputWidth: output.width,
            outputHeight: output.height,
            adaptor: adaptor,
            progress: progress
        )
        guard try frames.readFirstFrame() else {
            writer.cancelWriting()
            throw MediaError("The input has no decodable video frames: \(source.url.lastPathComponent)")
        }

        let queue = DispatchQueue(label: "ade-media.render")
        do {
            try await appendAllFrames(frames, input: input, queue: queue)
        } catch {
            writer.cancelWriting()
            throw error
        }

        writer.endSession(atSourceTime: Self.presentationTime(frame: clock.frameCount, fps: clock.fps))
        await writer.finishWriting()
        guard writer.status == .completed else {
            throw MediaError.describing(writer.error, context: "Writing the output file failed")
        }
        // `rename` replaces an existing file in one step, so `output` is
        // always either the old file or the whole new one.
        if rename(partial.path, target.path) != 0 {
            throw MediaError("Could not move the finished video to \(target.path): \(String(cString: strerror(errno)))")
        }
        let bytes = (try? FileManager.default.attributesOfItem(atPath: target.path)[.size] as? NSNumber)?.intValue ?? 0
        progress(1)
        return DemoRenderResult(bytes: bytes, durationSeconds: clock.durationSeconds, frames: clock.frameCount)
    }

    /// Feeds the writer until every output frame is in, at the pace it asks for.
    private func appendAllFrames(_ frames: FrameProducer, input: AVAssetWriterInput, queue: DispatchQueue) async throws {
        // Everything the block touches runs on `queue` alone, one call at a
        // time, which is what the writer promises for this callback.
        final class Feed: @unchecked Sendable {
            let input: AVAssetWriterInput
            let frames: FrameProducer
            var settled = false
            init(input: AVAssetWriterInput, frames: FrameProducer) {
                self.input = input
                self.frames = frames
            }
        }
        let feed = Feed(input: input, frames: frames)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            feed.input.requestMediaDataWhenReady(on: queue) {
                guard !feed.settled else { return }
                do {
                    while feed.input.isReadyForMoreMediaData {
                        if try !feed.frames.appendNext() {
                            feed.settled = true
                            feed.input.markAsFinished()
                            continuation.resume()
                            return
                        }
                    }
                } catch {
                    feed.settled = true
                    feed.input.markAsFinished()
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    /// The output size, rounded down to even numbers as H.264 needs.
    static func outputSize(_ output: DemoOutput) throws -> (width: Int, height: Int) {
        let width = output.width & ~1
        let height = output.height & ~1
        guard width >= 2, height >= 2, width <= 8192, height <= 8192 else {
            throw MediaError("The output size \(output.width)×\(output.height) is not usable.")
        }
        return (width, height)
    }

    /// A hidden file beside `target`, so the final move is a rename on one volume.
    static func prepareTemporaryOutput(for target: URL) throws -> URL {
        let directory = target.deletingLastPathComponent()
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            throw MediaError.describing(error, context: "Could not create the output folder \(directory.path)")
        }
        let partial = directory.appendingPathComponent(".\(target.lastPathComponent).\(getpid()).partial.mp4")
        try? FileManager.default.removeItem(at: partial)
        return partial
    }

    /// Frame `n`'s time, exact when the rate is a whole number.
    static func presentationTime(frame: Int, fps: Double) -> CMTime {
        if fps == fps.rounded(), fps >= 1 {
            return CMTime(value: CMTimeValue(frame), timescale: CMTimeScale(fps))
        }
        return CMTime(seconds: Double(frame) / fps, preferredTimescale: 90_000)
    }
}

/// Produces the output frames in order, on the writer's queue.
private final class FrameProducer {
    private let source: MediaSource
    private let timeMap: DemoTimeMap
    private let clock: DemoFrameClock
    private let camera: DemoCameraTrack
    private let overlays: OverlayDrawer
    private let outputWidth: Int
    private let outputHeight: Int
    private let adaptor: AVAssetWriterInputPixelBufferAdaptor
    private let progress: (Double) -> Void
    private let context: CIContext
    private let orientTransform: CGAffineTransform
    private let black: CIImage

    private var current: DecodedFrame?
    private var upcoming: DecodedFrame?
    private var sourceEnded = false
    private var nextFrame = 0

    /// What the last appended buffer shows, to reuse it when nothing changed.
    private var lastBuffer: CVPixelBuffer?
    private var lastSourceIndex = -1
    private var lastViewport: DemoViewport?
    private var lastHadOverlays = true

    init(
        source: MediaSource,
        timeMap: DemoTimeMap,
        clock: DemoFrameClock,
        camera: DemoCameraTrack,
        overlays: OverlayDrawer,
        outputWidth: Int,
        outputHeight: Int,
        adaptor: AVAssetWriterInputPixelBufferAdaptor,
        progress: @escaping (Double) -> Void
    ) {
        self.source = source
        self.timeMap = timeMap
        self.clock = clock
        self.camera = camera
        self.overlays = overlays
        self.outputWidth = outputWidth
        self.outputHeight = outputHeight
        self.adaptor = adaptor
        self.progress = progress
        // No colour management: the decoded BGRA already is what the encoder
        // should see, and matching it through a working space only costs time
        // and shifts greys by a level or two.
        let options: [CIContextOption: Any] = [
            .workingColorSpace: NSNull(),
            .outputColorSpace: NSNull(),
            .cacheIntermediates: false,
        ]
        if let device = MTLCreateSystemDefaultDevice() {
            context = CIContext(mtlDevice: device, options: options)
        } else {
            context = CIContext(options: options)
        }
        orientTransform = Self.orientation(source.orientation, naturalWidth: source.naturalWidth, naturalHeight: source.naturalHeight)
        black = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 1))
            .cropped(to: CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight))
    }

    /// Reads the first frame; false when the file has none.
    func readFirstFrame() throws -> Bool {
        current = try source.nextFrame()
        upcoming = try source.nextFrame()
        sourceEnded = upcoming == nil
        return current != nil
    }

    /// Renders and appends the next output frame; false when all are written.
    func appendNext() throws -> Bool {
        guard nextFrame < clock.frameCount else { return false }
        let index = nextFrame
        let time = clock.time(ofFrame: index)
        let sourceTime = timeMap.sourceTime(atOutput: time)
        try advance(to: sourceTime)
        guard let frame = current else { return false }

        let viewport = camera.viewport(at: time)
        let layout = DemoFrameLayout(
            sourceWidth: Double(source.displayWidth),
            sourceHeight: Double(source.displayHeight),
            outputWidth: Double(outputWidth),
            outputHeight: Double(outputHeight),
            viewport: viewport
        )
        let visible = overlays.visible(at: time, layout: layout)

        let buffer: CVPixelBuffer
        if let lastBuffer, visible == nil, !lastHadOverlays, frame.index == lastSourceIndex, viewport == lastViewport {
            buffer = lastBuffer
        } else {
            buffer = try render(frame, layout: layout)
            if let visible { try overlays.draw(visible, into: buffer, layout: layout) }
        }
        let presentation = Renderer.presentationTime(frame: index, fps: clock.fps)
        guard adaptor.append(buffer, withPresentationTime: presentation) else {
            throw MediaError("The encoder refused frame \(index) of \(clock.frameCount).")
        }
        lastBuffer = buffer
        lastSourceIndex = frame.index
        lastViewport = viewport
        lastHadOverlays = visible != nil
        nextFrame += 1
        progress(Double(nextFrame) / Double(clock.frameCount))
        return true
    }

    /// Decodes forward until `current` is the newest frame at or before
    /// `sourceTime`. A millisecond of slack absorbs timescale rounding, so a
    /// 30 fps source played at speed 1 does not lag a frame behind.
    private func advance(to sourceTime: Double) throws {
        while !sourceEnded, let next = upcoming, next.time <= sourceTime + 0.001 {
            current = next
            upcoming = try source.nextFrame()
            if upcoming == nil { sourceEnded = true }
        }
    }

    /// The source frame cropped to the viewport and scaled into a fresh buffer.
    private func render(_ frame: DecodedFrame, layout: DemoFrameLayout) throws -> CVPixelBuffer {
        guard let pool = adaptor.pixelBufferPool else {
            throw MediaError("The encoder has no frame buffers; it may have failed to start.")
        }
        var created: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &created) == kCVReturnSuccess, let buffer = created else {
            throw MediaError("Could not allocate an output frame.")
        }

        let upright = CIImage(cvPixelBuffer: frame.buffer, options: [.colorSpace: NSNull()])
            .transformed(by: orientTransform)
        let viewport = layout.viewport
        let sourceHeight = layout.sourceHeight
        // CoreImage is y-up: the viewport's bottom edge, in source pixels.
        let viewX = viewport.x * layout.sourceWidth
        let viewBottom = (1 - viewport.y - viewport.height) * sourceHeight
        let pictureBottom = layout.outputHeight - layout.pictureY - layout.pictureHeight
        let pictureRect = CGRect(x: layout.pictureX, y: pictureBottom, width: layout.pictureWidth, height: layout.pictureHeight)

        // Edges are clamped, not transparent, so a filter never pulls black in
        // from outside the frame at the viewport's border.
        let clamped = upright.clampedToExtent()
        var picture: CIImage
        if layout.scaleX < 0.99 || layout.scaleY < 0.99 {
            // Downscaling: Lanczos keeps small text legible where bilinear
            // sampling drops rows and columns. The filter wants a finite
            // input, so the viewport plus a margin for its kernel.
            let margin = 8 / min(layout.scaleX, layout.scaleY)
            let region = CGRect(
                x: viewX - margin,
                y: viewBottom - margin,
                width: viewport.width * layout.sourceWidth + 2 * margin,
                height: viewport.height * sourceHeight + 2 * margin
            )
            let lanczos = CIFilter(name: "CILanczosScaleTransform")!
            lanczos.setValue(clamped.cropped(to: region), forKey: kCIInputImageKey)
            lanczos.setValue(layout.scaleY, forKey: kCIInputScaleKey)
            lanczos.setValue(layout.scaleX / layout.scaleY, forKey: kCIInputAspectRatioKey)
            picture = (lanczos.outputImage ?? clamped).transformed(by: CGAffineTransform(
                translationX: layout.pictureX - viewX * layout.scaleX,
                y: pictureBottom - viewBottom * layout.scaleY
            ))
        } else {
            picture = clamped.transformed(by: CGAffineTransform(translationX: -viewX, y: -viewBottom)
                .concatenating(CGAffineTransform(scaleX: layout.scaleX, y: layout.scaleY))
                .concatenating(CGAffineTransform(translationX: layout.pictureX, y: pictureBottom)))
        }
        picture = picture.cropped(to: pictureRect)
        if !layout.fillsOutput { picture = picture.composited(over: black) }

        let destination = CIRenderDestination(pixelBuffer: buffer)
        destination.colorSpace = nil
        do {
            try context.startTask(toRender: picture, from: CGRect(x: 0, y: 0, width: outputWidth, height: outputHeight), to: destination, at: .zero)
                .waitUntilCompleted()
        } catch {
            throw MediaError.describing(error, context: "Rendering an output frame failed")
        }
        return buffer
    }

    /// The track's `preferredTransform` in CoreImage's y-up space, moved so the
    /// upright picture starts at the origin.
    static func orientation(_ t: (a: Int, b: Int, c: Int, d: Int), naturalWidth: Int, naturalHeight: Int) -> CGAffineTransform {
        if t == (1, 0, 0, 1) { return .identity }
        // A y-down transform [a c; b d] is [a -c; -b d] once y points up.
        let linear = CGAffineTransform(a: CGFloat(t.a), b: CGFloat(-t.b), c: CGFloat(-t.c), d: CGFloat(t.d), tx: 0, ty: 0)
        let extent = CGRect(x: 0, y: 0, width: naturalWidth, height: naturalHeight).applying(linear)
        return linear.concatenating(CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
    }
}

/// The partial output of the render in flight, deleted if the process is told
/// to stop, so a cancelled render leaves nothing behind.
///
/// That includes the writer's own scratch copies: with
/// `shouldOptimizeForNetworkUse` it rewrites the file to move the index to the
/// front, via a sibling named `<partial>.sb-…`, and it can still be on disk
/// when `finishWriting` returns.
enum PartialOutput {
    private static let lock = NSLock()
    private static var path: String?

    static func register(_ url: URL) {
        lock.lock()
        path = url.path
        lock.unlock()
    }

    static func clear() {
        lock.lock()
        path = nil
        lock.unlock()
    }

    static func removeIfAny() {
        lock.lock()
        let current = path
        lock.unlock()
        guard let current else { return }
        unlink(current)
        let directory = (current as NSString).deletingLastPathComponent
        let prefix = (current as NSString).lastPathComponent + "."
        for name in (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? [] where name.hasPrefix(prefix) {
            unlink((directory as NSString).appendingPathComponent(name))
        }
    }
}
