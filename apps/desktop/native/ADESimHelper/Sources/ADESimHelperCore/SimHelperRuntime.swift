import Foundation

/// Routes NDJSON commands to per-device sessions.
///
/// This is the replacement for upstream's `sim-module.swift`. Upstream binds the
/// same capture and HID code into the Node process as an N-API addon; ADE runs
/// it as a child process instead, so that a crash inside CoreSimulator (which is
/// reached through KVC and `objc_msgSend`, against private frameworks, on an OS
/// that moves them between releases) kills a helper ADE restarts rather than the
/// Electron main process.
public actor SimHelperRuntime {
    private var sessions: [String: DeviceSession] = [:]
    private let emit: @Sendable (SimHelperEvent) -> Void
    /// How a new session learns its device's geometry. Injected so a test can
    /// build sessions without CoreSimulator; production always asks it.
    private let metricsLookup: @Sendable (String) -> DeviceMetrics?

    public init(
        emit: @escaping @Sendable (SimHelperEvent) -> Void,
        metricsLookup: @escaping @Sendable (String) -> DeviceMetrics? = { SimDeviceLookup.metrics(udid: $0) }
    ) {
        self.emit = emit
        self.metricsLookup = metricsLookup
    }

    /// Handle one line. Returns false when the helper should exit.
    public func handle(line: String) async -> Bool {
        switch SimHelperCommandParser.parse(line: line) {
        case let .failure(failure):
            switch failure {
            case .unusable:
                // Nothing to correlate a reply to, so there is nobody to tell.
                break
            case let .invalid(id, message):
                emit(.error(id: id, code: "invalid-command", message: message))
            case let .unknownCommand(id, type):
                emit(.error(id: id, code: "unknown-command", message: "This helper does not implement `\(type)`."))
            }
            return true
        case let .success(command):
            if case let .quit(id) = command {
                await shutdown()
                emit(.ok(id: id, payload: [:]))
                return false
            }
            await run(command)
            return true
        }
    }

    public func shutdown() async {
        let all = Array(sessions.values)
        sessions.removeAll()
        for session in all {
            await tearDown(session, announceCapture: false)
        }
    }

    /// Drop everything held for one device, so the next command builds a
    /// fresh session. Returns false when there was nothing to drop.
    ///
    /// Why this exists: a session's HID client (`HIDInjector.setup`, done once
    /// per session) and its capture engine are bound to the boot they were
    /// built against. Proven live on 2026-09-23: a lane simulator was powered
    /// off and booted again under a helper that stayed up, and every tap after
    /// the reboot answered `ok` in ~11 ms while the screen never changed.
    /// Killing only the helper made the same taps land at once. ADE sends
    /// `device-reset` before it powers a device off and after it boots one,
    /// which is the same cure without taking every other device's stream down.
    public func resetDevice(_ udid: String) async -> Bool {
        // Removed before the teardown awaits, so anything that reaches the
        // actor in between gets a new session rather than the dying one.
        guard let session = sessions.removeValue(forKey: udid) else { return false }
        await tearDown(session, announceCapture: true)
        return true
    }

    /// Whether a session exists for this device. For tests and diagnostics.
    public func hasSession(for udid: String) -> Bool {
        sessions[udid] != nil
    }

    /// Finish a session's recording and stop its capture.
    ///
    /// `announceCapture` is false only on process shutdown, where the pipe is
    /// closing and ADE's own supervisor is what reports the stream gone.
    private func tearDown(_ session: DeviceSession, announceCapture: Bool) async {
        // Finish the MP4 before dropping the device: an abandoned
        // AVAssetWriter leaves an unplayable file, which is worse than no
        // file because ADE has already told the user a recording exists.
        if await session.isRecording {
            if let finished = try? await session.stopRecording() {
                emit(.recordStopped(
                    udid: session.udid,
                    path: finished.path,
                    durationMs: finished.durationMs,
                    bytes: finished.bytes
                ))
            }
        }
        let wasCapturing = await session.isCapturing
        await session.stopCapture()
        // Said out loud so a lane still streaming this device stops showing a
        // live view whose socket just closed.
        if announceCapture, wasCapturing {
            emit(.captureStopped(udid: session.udid, reason: "device-reset"))
        }
        // The HID client goes with the session: nothing else holds the
        // `DeviceSession`, and its `HIDInjector` is only reachable through it.
    }

    // MARK: - private

    /// Get or create the session for a device.
    ///
    /// Creating one is cheap (no capture, no HID setup — both are lazy), so
    /// there is no reason to make `capture-start` a precondition for input. A
    /// caller that only wants to tap should not have to stream.
    private func session(for udid: String) throws -> DeviceSession {
        if let existing = sessions[udid] { return existing }
        guard let metrics = metricsLookup(udid) else {
            throw RuntimeError.unknownDevice(udid)
        }
        let session = DeviceSession(udid: udid, metrics: metrics)
        sessions[udid] = session
        return session
    }

    private func run(_ command: SimHelperCommand) async {
        let id = command.id
        do {
            switch command {
            case .listDevices:
                emit(.ok(id: id, payload: ["devices": SimDeviceLookup.list().map(\.payload)]))

            case let .captureStart(_, udid, fps, scale, bitrateKbps):
                let session = try session(for: udid)
                let started = try await session.startCapture(fps: fps, scale: scale, bitrateKbps: bitrateKbps)
                emit(.captureStarted(
                    id: id,
                    udid: udid,
                    url: started.url,
                    token: started.token,
                    pointWidth: started.metrics.pointWidth,
                    pointHeight: started.metrics.pointHeight,
                    pixelWidth: started.metrics.pixelWidth,
                    pixelHeight: started.metrics.pixelHeight,
                    scale: started.metrics.scale
                ))

            case let .captureStop(_, udid):
                var stopped = true
                if let session = sessions[udid] {
                    stopped = await session.stopCaptureUnlessRecording()
                }
                emit(.ok(id: id, payload: ["stopped": stopped]))
                if stopped {
                    emit(.captureStopped(udid: udid, reason: "requested"))
                }

            case let .touch(_, udid, phase, point):
                try await session(for: udid).touch(phase: phase, point: point)
                emit(.ok(id: id, payload: [:]))

            case let .multiTouch(_, udid, phase, first, second):
                try await session(for: udid).multiTouch(phase: phase, first: first, second: second)
                emit(.ok(id: id, payload: [:]))

            case let .button(_, udid, name):
                try await session(for: udid).button(name)
                emit(.ok(id: id, payload: [:]))

            case let .key(_, udid, phase, usage):
                try await session(for: udid).key(phase: phase, usage: usage)
                emit(.ok(id: id, payload: [:]))

            case let .type(_, udid, text):
                let unsupported = try await session(for: udid).type(text: text)
                emit(.ok(id: id, payload: [
                    "typed": text.count - unsupported.count,
                    "unsupported": unsupported.map(String.init),
                ]))

            case let .scroll(_, udid, deltaX, deltaY, anchor):
                try await session(for: udid).scroll(deltaX: deltaX, deltaY: deltaY, anchor: anchor)
                emit(.ok(id: id, payload: [:]))

            case let .orientation(_, udid, value):
                let applied = try await session(for: udid).orientation(value)
                // Reported rather than thrown: the GSEvent path needs
                // Simulator.app running, and "the device did not rotate" is a
                // state ADE should show, not an error it should retry.
                emit(.ok(id: id, payload: ["applied": applied]))

            case let .axDescribe(_, udid):
                let json = try await offMainThread {
                    SimFrameworks.load()
                    return try AccessibilityBridge.shared.describeUI(udid: udid)
                }
                emit(.ok(id: id, payload: ["tree": String(decoding: json, as: UTF8.self)]))

            case let .axFrontmost(_, udid):
                let info = try await offMainThread {
                    SimFrameworks.load()
                    return try AccessibilityBridge.shared.frontmostApp(udid: udid)
                }
                emit(.ok(id: id, payload: ["app": info]))

            case let .screenshot(_, udid, path):
                let size = try await session(for: udid).screenshot(path: path)
                emit(.ok(id: id, payload: [
                    "path": path,
                    "width": size.width,
                    "height": size.height,
                ]))

            case let .recordStart(_, udid, path, overlays, fps, accentColor):
                let session = try session(for: udid)
                try await session.startRecording(
                    path: path,
                    overlays: overlays,
                    fps: fps,
                    accentColor: accentColor
                )
                emit(.ok(id: id, payload: ["path": path]))
                emit(.recordStarted(id: id, udid: udid, path: path))

            case let .recordStop(_, udid):
                guard let session = sessions[udid] else {
                    throw DeviceSession.SessionError.notRecording
                }
                let finished = try await session.stopRecording()
                emit(.ok(id: id, payload: [
                    "path": finished.path,
                    "durationMs": finished.durationMs,
                    "bytes": finished.bytes,
                ]))
                emit(.recordStopped(
                    udid: udid,
                    path: finished.path,
                    durationMs: finished.durationMs,
                    bytes: finished.bytes
                ))

            case let .overlayTap(_, udid, point):
                // No `session(for:)`: an overlay note for a device that is not
                // recording is a no-op, and creating a session to discard the
                // note would resolve a device lookup on every injected tap.
                await sessions[udid]?.overlayTap(point: point)
                emit(.ok(id: id, payload: [:]))

            case let .overlayText(_, udid, text, secure):
                if !secure {
                    await sessions[udid]?.overlayText(text)
                }
                emit(.ok(id: id, payload: ["shown": !secure]))

            case let .deviceReset(_, udid):
                // An absent device is a success, not an error: ADE sends this
                // best effort around every power change, usually for a device
                // this helper has never driven.
                let reset = await resetDevice(udid)
                emit(.ok(id: id, payload: ["reset": reset]))

            case .quit:
                // Intercepted in `handle` so the reply lands after teardown.
                break
            }
        } catch {
            emit(.error(id: id, code: code(for: error), message: message(for: error)))
        }
    }

    /// Run a blocking CoreSimulator call off the cooperative pool.
    ///
    /// `AccessibilityBridge` talks to the device synchronously and can block for
    /// hundreds of milliseconds. On the cooperative pool that starves every
    /// other device's capture; Swift concurrency has no thread to spare.
    private func offMainThread<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    continuation.resume(returning: try body())
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func code(for error: Error) -> String {
        switch error {
        case RuntimeError.unknownDevice: return "unknown-device"
        case DeviceSession.SessionError.notCapturing: return "not-capturing"
        case DeviceSession.SessionError.unsupportedButton: return "unsupported-button"
        case DeviceSession.SessionError.screenshotFailed: return "screenshot-failed"
        case DeviceSession.SessionError.alreadyRecording: return "already-recording"
        case DeviceSession.SessionError.notRecording: return "not-recording"
        case RecordingSession.RecordingError.noFrames: return "record-no-frames"
        case RecordingSession.RecordingError.writerUnavailable: return "record-write-failed"
        default: return "failed"
        }
    }

    private func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? (error as NSError).localizedDescription
    }

    public enum RuntimeError: Error, LocalizedError, Equatable {
        case unknownDevice(String)

        public var errorDescription: String? {
            switch self {
            case let .unknownDevice(udid):
                return "No simulator with UDID \(udid) is in the default device set."
            }
        }
    }
}
