import Foundation
import CoreVideo
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// Everything ADE owns for ONE simulator: its capture engine, its HID client,
/// its stream server and its geometry.
///
/// One session per device, and nothing shared between them beyond the vendored
/// framework load. That is what lets a single helper process drive two booted
/// simulators at once: a stall on one device's encoder cannot reach the other's,
/// because they share no queue, no socket and no encoder state.
public actor DeviceSession {
    public let udid: String
    public private(set) var metrics: DeviceMetrics

    private let hid = HIDInjector()
    private var hidReady = false
    private var engine: CaptureEngine?
    private var server: FrameStreamServer?
    private var unsubscribeAVCC: (@Sendable () async -> Void)?
    private var parameterSets: AnnexB.ParameterSets?
    /// The encoder bitrate the live stream asked for, in kbps, if any. Kept so
    /// an encoder rebuild keeps the same cap rather than silently reverting to
    /// the default.
    private var streamBitrateKbps: Int?
    private var recording: RecordingSession?
    /// True when capture exists only because a recording asked for it, so
    /// `record-stop` can put the device back the way it found it.
    private var captureOwnedByRecording = false

    public init(udid: String, metrics: DeviceMetrics) {
        self.udid = udid
        self.metrics = metrics
    }

    /// Bring up HID lazily, and only once.
    ///
    /// `setup` dlsyms the Indigo entry points and resolves the SimDevice, which
    /// is wasted work for a session that only ever streams. Doing it on first
    /// input also means a device that cannot accept input still streams fine.
    private func ensureHID() async throws {
        guard !hidReady else { return }
        try await hid.setup(deviceUDID: udid)
        hidReady = true
    }

    // MARK: - Capture

    public struct StartedCapture: Sendable {
        public let url: String
        public let token: String
        public let metrics: DeviceMetrics
    }

    public func startCapture(fps: Int, scale: Double, bitrateKbps: Int? = nil) async throws -> StartedCapture {
        if let server, engine != nil {
            // Idempotent: a second `capture-start` for a live device returns the
            // endpoint it already has rather than orphaning a listener. Every
            // reader stays attached: a phone that joins the Mac's own view must
            // not end the Mac's stream (the owner's 2026-09-23 report).
            //
            // A new cap still applies. A remote viewer joins with a cap and the
            // Mac's own view has none; rebuilding the encoder (not the server)
            // applies it, and the rebuild starts with a keyframe every reader
            // can decode. No cap means "keep what runs", so a local viewer never
            // lifts a remote viewer's cap. A cap of 0 lifts it: ADE sends that
            // when the last remote viewer leaves.
            if let bitrateKbps {
                let cap = Self.streamCap(bitrateKbps)
                if cap != streamBitrateKbps {
                    streamBitrateKbps = cap
                    await rebuildEncoder()
                }
            }
            return StartedCapture(url: server.url, token: server.token, metrics: metrics)
        }
        streamBitrateKbps = bitrateKbps.flatMap(Self.streamCap)

        if let existing = engine {
            // Capture is running for a recording, with no stream server: the
            // last viewer left and `stopCaptureUnlessRecording` dropped the
            // H.264 fan-out. Building a second `CaptureEngine` here would
            // orphan this one *and* the recording's frame subscription with
            // it, so re-attach a server to the engine that already exists.
            let server = try FrameStreamServer()
            _ = try server.start()
            self.server = server
            server.onReaderAttached = { [weak self] in
                guard let self else { return }
                Task { await self.rebuildEncoder() }
            }
            await subscribe(engine: existing, server: server)
            captureOwnedByRecording = false
            return StartedCapture(url: server.url, token: server.token, metrics: metrics)
        }

        let engine = CaptureEngine(deviceUDID: udid)
        try await engine.start()
        self.engine = engine

        let server = try FrameStreamServer()
        _ = try server.start()
        self.server = server
        server.onReaderAttached = { [weak self] in
            guard let self else { return }
            Task { await self.rebuildEncoder() }
        }

        await subscribe(engine: engine, server: server)

        // The framebuffer is authoritative about pixels; CoreSimulator is
        // authoritative about points. Prefer the device type's answer and fall
        // back to the framebuffer only when it had none.
        let size = await engine.screenSize
        if size.width > 0, size.height > 0, metrics.pointWidth <= 0 {
            metrics = DeviceMetrics.fromPixels(
                width: size.width,
                height: size.height,
                assumedScale: metrics.scale
            )
        }
        _ = fps
        _ = scale

        return StartedCapture(url: server.url, token: server.token, metrics: metrics)
    }

    /// 0 on the wire means "no cap": the encoder's own default.
    private static func streamCap(_ bitrateKbps: Int) -> Int? {
        bitrateKbps == 0 ? nil : bitrateKbps
    }

    private func subscribe(engine: CaptureEngine, server: FrameStreamServer) async {
        unsubscribeAVCC = await engine.addAVCCConsumer(
            onFrame: { [weak self] _, data, flags in
                await self?.handleEncoded(data: data, flags: flags, server: server)
            },
            bitrateKbps: streamBitrateKbps,
        )
    }

    /// Build a new encoder, which starts with a keyframe. A reader that just
    /// attached needs that keyframe; a new bitrate cap needs the new encoder.
    ///
    /// The vendored `AVCCEncoder` forces a keyframe exactly once, when it is
    /// constructed, and then relies on `MaxKeyFrameInterval` (fps × 5 frames).
    /// On an idle simulator the capture layer runs at its 5 fps floor, so the
    /// "5 second" interval is really a minute — far too long for a reader that
    /// just attached and has nothing to decode. Dropping the consumer and adding
    /// a new one builds a new encoder, which starts with `forceKeyframe = true`.
    ///
    /// Done this way because `CaptureEngine.addConsumer` is private, so there is
    /// no supported way to ask the existing encoder for an IDR without editing
    /// vendored code.
    private func rebuildEncoder() async {
        guard let engine, let server else { return }
        await unsubscribeAVCC?()
        unsubscribeAVCC = nil
        parameterSets = nil
        await subscribe(engine: engine, server: server)
    }

    private func handleEncoded(data: Data, flags: Int32, server: FrameStreamServer) {
        let flagDescription: Int32 = 1 << 0
        let flagKeyframe: Int32 = 1 << 1

        guard let payload = AnnexB.unwrapEnvelope(data) else { return }

        if flags & flagDescription != 0 {
            guard let sets = AnnexB.parseAVCC(payload) else { return }
            parameterSets = sets
            server.setConfiguration(
                codec: sets.codec,
                width: metrics.pixelWidth,
                height: metrics.pixelHeight
            )
            return
        }

        let keyframe = flags & flagKeyframe != 0
        guard var unit = AnnexB.fromAVCC(payload) else { return }
        if keyframe, let sets = parameterSets {
            // VideoToolbox keeps SPS/PPS in the format description, not inline,
            // so an IDR on its own is undecodable by a decoder configured
            // without a `description` — which is exactly how ADE's renderer
            // configures. Prefixing them to every keyframe also means a reader
            // that reconnects mid-stream needs nothing replayed.
            unit = sets.annexB + unit
        }
        server.broadcast(accessUnit: unit, keyframe: keyframe)
    }

    /// Tear capture down, unless a recording still needs the frames.
    ///
    /// `capture-stop` means "the last viewer went away", and a recording is not
    /// a viewer. Honouring it literally would end every auto recording the
    /// moment the user closed the Apple column — which is the exact moment an
    /// agent is most likely to still be driving the device.
    public func stopCaptureUnlessRecording() async -> Bool {
        if recording != nil {
            captureOwnedByRecording = true
            // Drop the H.264 fan-out so an unwatched device is not paying for
            // a stream nobody reads; the recorder's MJPEG consumer stays.
            await unsubscribeAVCC?()
            unsubscribeAVCC = nil
            parameterSets = nil
            server?.stop()
            server = nil
            return false
        }
        await stopCapture()
        return true
    }

    public func stopCapture() async {
        await unsubscribeAVCC?()
        unsubscribeAVCC = nil
        parameterSets = nil
        server?.stop()
        server = nil
        await engine?.stop()
        engine = nil
    }

    public var isCapturing: Bool { engine != nil }

    public var readerCount: Int { server?.readerCount ?? 0 }

    // MARK: - Recording

    /// Start writing an MP4 of this device.
    ///
    /// Starts capture if nothing else has: a recording must not depend on
    /// somebody having the live view open, because the agent case — drive the
    /// device headlessly, hand the user a video afterwards — has no viewer by
    /// definition.
    public func startRecording(
        path: String,
        overlays: Bool,
        fps: Int,
        accentColor: String?,
        idleCompression: Bool = true
    ) async throws {
        guard recording == nil else { throw SessionError.alreadyRecording }

        if engine == nil {
            _ = try await startCapture(fps: fps, scale: 1, bitrateKbps: nil)
            captureOwnedByRecording = true
        }
        guard let engine else { throw SessionError.notCapturing }

        let session = RecordingSession(
            path: path,
            fps: fps,
            overlays: overlays,
            accent: RecordingOverlay.parseColour(accentColor) ?? RecordingOverlay.defaultAccent,
            metrics: metrics,
            idleCompression: idleCompression
        )
        do {
            try await session.start(engine: engine)
        } catch {
            if captureOwnedByRecording {
                await stopCapture()
                captureOwnedByRecording = false
            }
            throw error
        }
        recording = session
    }

    public func stopRecording() async throws -> FinishedRecording {
        guard let session = recording else { throw SessionError.notRecording }
        recording = nil
        do {
            let finished = try await session.stop()
            await releaseRecordingCapture()
            return finished
        } catch {
            await releaseRecordingCapture()
            throw error
        }
    }

    /// Give back the capture the recording borrowed, unless a viewer arrived
    /// while it ran.
    private func releaseRecordingCapture() async {
        guard captureOwnedByRecording else { return }
        captureOwnedByRecording = false
        // A viewer may have attached while the recording ran; tearing capture
        // down under it would blank the live column for no reason.
        guard recording == nil, (server?.readerCount ?? 0) == 0 else { return }
        await stopCapture()
    }

    public var isRecording: Bool { recording != nil }

    /// Note a tap for the recording's overlay. Silently ignored when nothing is
    /// recording — ADE sends these alongside every injected input and should
    /// not have to track whether a recording is live.
    public func overlayTap(point: DevicePoint) async {
        await recording?.noteTap(point: point)
    }

    public func overlayText(_ text: String) async {
        await recording?.noteText(text)
    }

    // MARK: - Input

    public func touch(phase: TouchPhase, point: DevicePoint) async throws {
        try await ensureHID()
        let normalized = metrics.normalize(point)
        await hid.sendTouch(
            type: phase.hidType,
            x: normalized.x,
            y: normalized.y,
            screenWidth: metrics.pixelWidth,
            screenHeight: metrics.pixelHeight
        )
    }

    public func multiTouch(phase: TouchPhase, first: DevicePoint, second: DevicePoint) async throws {
        try await ensureHID()
        let a = metrics.normalize(first)
        let b = metrics.normalize(second)
        await hid.sendMultiTouch(
            type: phase.hidType,
            x1: a.x, y1: a.y, x2: b.x, y2: b.y,
            screenWidth: metrics.pixelWidth,
            screenHeight: metrics.pixelHeight
        )
    }

    public func button(_ name: String) async throws {
        try await ensureHID()
        guard let button = SimButton.resolve(name) else {
            throw SessionError.unsupportedButton(name)
        }
        switch button {
        case let .named(value):
            await hid.sendButton(button: value, deviceUDID: udid)
        case let .hid(page, usage):
            await hid.sendButtonHID(page: page, usage: usage, phase: "press")
        }
    }

    public func key(phase: KeyPhase, usage: Int) async throws {
        try await ensureHID()
        await hid.sendKey(type: phase.rawValue, usage: UInt32(usage))
    }

    /// Type a string as a key sequence.
    ///
    /// Reports the characters it could not map rather than dropping them
    /// silently: a caller that asked for an emoji needs to know it did not
    /// arrive, because the field it is typing into will look almost right.
    public func type(text: String) async throws -> [Character] {
        try await ensureHID()
        let (strokes, unsupported) = KeyboardUsage.usages(for: text)
        for stroke in strokes {
            if stroke.shifted {
                await hid.sendKey(type: "down", usage: KeyboardUsage.leftShift)
            }
            await hid.sendKey(type: "down", usage: stroke.usage)
            await hid.sendKey(type: "up", usage: stroke.usage)
            if stroke.shifted {
                await hid.sendKey(type: "up", usage: KeyboardUsage.leftShift)
            }
            // The simulator's keyboard stack drops keys delivered faster than
            // it processes them; a short gap is the difference between the
            // typed string and a truncated one.
            try? await Task.sleep(nanoseconds: 12_000_000)
        }
        return unsupported
    }

    public func scroll(deltaX: Double, deltaY: Double, anchor: DevicePoint?) async throws {
        try await ensureHID()
        let normalized = anchor.map { metrics.normalize($0) }
        await hid.sendScroll(
            dx: deltaX,
            dy: deltaY,
            anchorX: normalized.map { Double($0.x) },
            anchorY: normalized.map { Double($0.y) },
            screenWidth: metrics.pixelWidth,
            screenHeight: metrics.pixelHeight
        )
    }

    public func orientation(_ value: Int) async throws -> Bool {
        try await ensureHID()
        return await hid.sendOrientation(orientation: UInt32(value))
    }

    // MARK: - Screenshot

    /// Write a PNG of the current framebuffer.
    ///
    /// No `simctl io screenshot`: that spawns a process, takes its own capture
    /// path and can take hundreds of milliseconds. This reads the frame the
    /// helper is already receiving.
    ///
    /// The transcode through JPEG is a wart, and a deliberate one. The only
    /// consumer API the vendored `CaptureEngine` exposes for raw-ish frames is
    /// `addMJPEGConsumer`; registering a PNG encoder would mean editing vendored
    /// code, and paying one JPEG encode per screenshot is cheaper than a fork.
    public func screenshot(path: String) async throws -> (width: Int, height: Int) {
        guard let engine else { throw SessionError.notCapturing }

        let jpeg = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            Task {
                let box = OneShot(continuation: continuation)
                let unsubscribe = await engine.addMJPEGConsumer { _, data in
                    await box.deliver(data)
                }
                await box.setUnsubscribe(unsubscribe)
                // The capture layer re-emits at a 5 fps idle floor, so a frame
                // always arrives on a still screen; a second is generous.
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                await box.timeout()
            }
        }

        guard
            let source = CGImageSourceCreateWithData(jpeg as CFData, nil),
            let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
        else { throw SessionError.screenshotFailed("The captured frame could not be decoded.") }

        let url = URL(fileURLWithPath: path)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        guard let destination = CGImageDestinationCreateWithURL(
            url as CFURL, UTType.png.identifier as CFString, 1, nil
        ) else { throw SessionError.screenshotFailed("The screenshot path could not be opened for writing.") }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw SessionError.screenshotFailed("The screenshot could not be written.")
        }
        return (image.width, image.height)
    }

    /// Resumes a continuation exactly once, whichever of the frame or the
    /// timeout gets there first, and unsubscribes either way.
    private actor OneShot {
        private var continuation: CheckedContinuation<Data, Error>?
        private var unsubscribe: (@Sendable () async -> Void)?

        init(continuation: CheckedContinuation<Data, Error>) {
            self.continuation = continuation
        }

        func setUnsubscribe(_ value: @escaping @Sendable () async -> Void) async {
            // The frame can beat the assignment; if it already fired, release
            // the subscription now rather than leaking it for the session's life.
            if continuation == nil {
                await value()
                return
            }
            unsubscribe = value
        }

        func deliver(_ data: Data) async {
            guard let continuation else { return }
            self.continuation = nil
            continuation.resume(returning: data)
            await unsubscribe?()
            unsubscribe = nil
        }

        func timeout() async {
            guard let continuation else { return }
            self.continuation = nil
            continuation.resume(throwing: SessionError.screenshotFailed("No frame arrived within a second."))
            await unsubscribe?()
            unsubscribe = nil
        }
    }

    public enum SessionError: Error, LocalizedError {
        case notCapturing
        case unsupportedButton(String)
        case screenshotFailed(String)
        case alreadyRecording
        case notRecording

        public var errorDescription: String? {
            switch self {
            case .alreadyRecording:
                return "This device is already recording."
            case .notRecording:
                return "This device is not recording."
            case .notCapturing:
                return "Start capture on this device before taking a screenshot."
            case let .unsupportedButton(name):
                return "`\(name)` is not a button this helper can press."
            case let .screenshotFailed(message):
                return message
            }
        }
    }
}
