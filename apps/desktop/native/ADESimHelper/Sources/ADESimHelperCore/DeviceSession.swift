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
    /// Foldable devices only (the iPhone Duo): CoreDevice input, and the panel
    /// capture and input follow. A yes is kept for the session; a no is asked
    /// again after `foldableRecheckInterval`, because CoreDevice can fail the
    /// question for a Duo that is still coming up, and that path (the legacy
    /// Indigo inner target) can abort `backboardd` on a Duo.
    private var foldable: FoldableInput?
    private var foldableCheckedAt: ContinuousClock.Instant?
    private static let foldableRecheckInterval: Duration = .seconds(10)
    private var activeScreenID: UInt32?
    /// Each panel's metrics, measured from its framebuffer while streaming or
    /// read once from `simctl io enumerate` for input without a stream.
    private var panelMetrics: [UInt32: DeviceMetrics] = [:]
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
        activeScreenID = nil

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
        // The next engine starts on the largest surface; forget the panel so
        // the next posture read applies it to that engine.
        activeScreenID = nil
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

    // MARK: - Foldables

    /// The CoreDevice input path, for a device with a hinge; nil for every other device.
    private func foldableInput() async -> FoldableInput? {
        if let foldable { return foldable }
        let now = ContinuousClock.now
        if let checkedAt = foldableCheckedAt, now - checkedAt < Self.foldableRecheckInterval { return nil }
        foldableCheckedAt = now
        if await CoreDeviceBridge.shared.supportsHingeAngle(udid: udid) {
            foldable = FoldableInput(udid: udid)
        }
        return foldable
    }

    public func isFoldable() async -> Bool {
        await foldableInput() != nil
    }

    /// The panel CoreDevice reports active: capture it, route input to it, and
    /// measure it. Returns the panel's metrics when they changed, else nil.
    public func applyActiveScreen(_ screenID: UInt32?) async -> DeviceMetrics? {
        guard let screenID, screenID != activeScreenID else { return nil }
        activeScreenID = screenID
        guard let engine else { return nil }
        await engine.setPreferredScreen(screenID)
        // The engine measures the panel on its next frame; the switch forces one.
        for _ in 0..<20 {
            try? await Task.sleep(nanoseconds: 25_000_000)
            let size = await engine.screenSize
            if size.width > 0, size.height > 0,
               size.width != metrics.pixelWidth || size.height != metrics.pixelHeight {
                metrics = DeviceMetrics.fromPixels(width: size.width, height: size.height, assumedScale: metrics.scale)
                panelMetrics[screenID] = metrics
                return metrics
            }
        }
        return nil
    }

    /**
     * Input without a stream (a caller that only taps): nothing has told the
     * session which panel is on, or measured it. Ask CoreDevice, and size the
     * panel from the simulator's own screen list, rather than defaulting to
     * the cover while the inner display is showing. Returns the displays it
     * read, so the gesture's other questions reuse them; nil when a running
     * stream already knew.
     */
    private func resolvePanelForInput() async -> [DevicePosture.Display]? {
        if engine != nil, activeScreenID != nil { return nil }
        let displays = await DevicePosture.displays(udid: udid)
        guard let active = displays.first(where: \.active)?.screenID else { return displays }
        activeScreenID = active
        if panelMetrics[active] == nil {
            let udid = self.udid
            let sizes = await Task.detached { DevicePosture.panelPixelSizes(udid: udid) }.value
            for (screen, size) in sizes {
                panelMetrics[screen] = DeviceMetrics.fromPixels(width: size.width, height: size.height, assumedScale: metrics.scale)
            }
        }
        if engine == nil, let measured = panelMetrics[active] { metrics = measured }
        return displays
    }

    /// The live screen's picture, in quarter turns clockwise on its
    /// framebuffer (the pane's `appleScreenRotation`). Read when a
    /// screen-space gesture begins and kept until its end, so a turn or a fold
    /// mid-gesture cannot bend it.
    private var screenTurns = 0

    private func readScreenTurns(_ known: [DevicePosture.Display]?) async -> Int {
        // A frame that already arrives wide has been turned for us.
        if metrics.pointWidth > metrics.pointHeight { return 0 }
        // A foldable marks its live panel; a phone with one screen marks none,
        // and its screen is the main display.
        let displays = if let known { known } else { await DevicePosture.displays(udid: udid) }
        let live = displays.first(where: \.active) ?? displays.first(where: { $0.screenID == 1 })
        switch live?.orientation {
        case "landscape_left": return 1
        case "landscape_right": return 3
        case "portrait_upside_down": return 2
        default: return 0
        }
    }

    /// A point an agent measured on the picture iOS shows, onto the panel's
    /// framebuffer, which is what CoreDevice's digitizer reads. The inverse
    /// of the pane's turn (`appleViewToFrameFraction`), in points: a
    /// sideways picture is the frame's height wide.
    private func toFrame(_ point: DevicePoint) -> DevicePoint {
        guard point.space == .screen else { return point }
        let width = metrics.pointWidth
        let height = metrics.pointHeight
        switch screenTurns {
        case 1: return DevicePoint(x: point.y, y: height - point.x)
        case 2: return DevicePoint(x: width - point.x, y: height - point.y)
        case 3: return DevicePoint(x: width - point.y, y: point.x)
        default: return DevicePoint(x: point.x, y: point.y)
        }
    }

    /// What a gesture needs settled before its first point: a foldable's live
    /// panel (its size is the frame's) and, for screen-space input, how the
    /// picture sits. One display read serves both.
    private func beginGesture(screenSpace: Bool) async {
        let displays = await foldableInput() != nil ? await resolvePanelForInput() : nil
        if screenSpace { screenTurns = await readScreenTurns(displays) }
    }

    /// Onto the frame, settling the gesture at its begin.
    private func framePoints(_ phase: TouchPhase, _ points: [DevicePoint]) async -> [DevicePoint] {
        if phase == .begin { await beginGesture(screenSpace: points.contains(where: { $0.space == .screen })) }
        return points.map(toFrame)
    }

    private func foldableTouch(_ phase: TouchPhase, _ points: [DevicePoint]) async throws -> Bool {
        guard let foldable = await foldableInput() else { return false }
        try await foldable.touch(
            phase: phase,
            screenID: activeScreenID ?? DuoScreen.cover,
            points: points.map { metrics.normalize($0) }
        )
        return true
    }

    // MARK: - Input

    public func touch(phase: TouchPhase, point: DevicePoint) async throws {
        let point = await framePoints(phase, [point])[0]
        if try await foldableTouch(phase, [point]) { return }
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
        let points = await framePoints(phase, [first, second])
        let (first, second) = (points[0], points[1])
        if try await foldableTouch(phase, [first, second]) { return }
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
        if let foldable = await foldableInput() {
            try await foldable.key(usage: UInt32(usage), down: phase == .down)
            return
        }
        try await ensureHID()
        await hid.sendKey(type: phase.rawValue, usage: UInt32(usage))
    }

    /// Type a string as a key sequence.
    ///
    /// Reports the characters it could not map rather than dropping them
    /// silently: a caller that asked for an emoji needs to know it did not
    /// arrive, because the field it is typing into will look almost right.
    public func type(text: String, paceMs: Int = 0) async throws -> [Character] {
        // The keyboard stack needs at least 12 ms between keys; a recording
        // may ask for more.
        let gap = UInt64(max(12, paceMs)) * 1_000_000
        if let foldable = await foldableInput() {
            let (strokes, unsupported) = KeyboardUsage.usages(for: text)
            for stroke in strokes {
                if stroke.shifted { try await foldable.key(usage: KeyboardUsage.leftShift, down: true) }
                try await foldable.key(usage: stroke.usage, down: true)
                try await foldable.key(usage: stroke.usage, down: false)
                if stroke.shifted { try await foldable.key(usage: KeyboardUsage.leftShift, down: false) }
                try? await Task.sleep(nanoseconds: gap)
            }
            return unsupported
        }
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
            try? await Task.sleep(nanoseconds: gap)
        }
        return unsupported
    }

    public func scroll(deltaX: Double, deltaY: Double, anchor: DevicePoint?, space: PointSpace = .frame) async throws {
        // A screen-space scroll is turned onto the frame first, its direction
        // included.
        var deltaX = deltaX
        var deltaY = deltaY
        var anchor = anchor
        await beginGesture(screenSpace: space == .screen)
        if space == .screen {
            anchor = anchor.map(toFrame)
            switch screenTurns {
            case 1: (deltaX, deltaY) = (deltaY, -deltaX)
            case 2: (deltaX, deltaY) = (-deltaX, -deltaY)
            case 3: (deltaX, deltaY) = (-deltaY, deltaX)
            default: break
            }
        }
        if await foldableInput() != nil {
            // CoreDevice's digitizer has no wheel: scroll is a short drag the
            // other way, from the anchor (or the panel's centre).
            let start = anchor ?? DevicePoint(x: metrics.pointWidth / 2, y: metrics.pointHeight / 2)
            let steps = 6
            _ = try await foldableTouch(.begin, [start])
            for step in 1...steps {
                let t = Double(step) / Double(steps)
                try? await Task.sleep(nanoseconds: 16_000_000)
                _ = try await foldableTouch(.move, [DevicePoint(x: start.x - deltaX * t, y: start.y - deltaY * t)])
            }
            _ = try await foldableTouch(.end, [DevicePoint(x: start.x - deltaX, y: start.y - deltaY)])
            return
        }
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

        // A foldable right after a fold: the guest can have lit the other
        // panel before the posture watcher moved the capture to it, and the
        // old panel then sends nothing. Follow the live panel now rather than
        // time out on the dark one (ledger #2).
        if await isFoldable(),
           let live = await DevicePosture.displays(udid: udid).first(where: \.active),
           live.screenID != activeScreenID {
            _ = await applyActiveScreen(live.screenID)
        }

        let jpeg = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            Task {
                let box = OneShot(continuation: continuation)
                let unsubscribe = await engine.addMJPEGConsumer { _, data in
                    await box.deliver(data)
                }
                await box.setUnsubscribe(unsubscribe)
                // The capture layer re-emits at a 5 fps idle floor, so a still
                // screen sends a frame within 200 ms. The rest of the wait is
                // for a panel switch still settling (the capture restarts on
                // the new panel), which used to fail at one second.
                try? await Task.sleep(nanoseconds: Self.firstFrameWaitNanoseconds)
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

    /// How long `screenshot` waits for its frame.
    static let firstFrameWaitNanoseconds: UInt64 = 4_000_000_000

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
            continuation.resume(throwing: SessionError.screenshotFailed(
                "No frame arrived within \(DeviceSession.firstFrameWaitNanoseconds / 1_000_000_000) seconds. If the device just folded or turned, its panel may still be switching; try again, or use screenshot."
            ))
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
