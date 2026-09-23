import Foundation

/// The NDJSON control protocol spoken over stdin/stdout, modelled on
/// `native/ADECaptureHelper`'s `Protocol.swift`.
///
/// Two rules carried over from that helper, both load-bearing:
///
/// 1. **An unknown `type` parses to `nil`, not to a failure.** A newer ADE must
///    be able to send a command an older helper has never heard of without
///    wedging it.
/// 2. **Every reply carries the request's `id`.** ADE drives two simulators from
///    one process, so replies interleave; correlating by arrival order is the
///    obvious way to get this wrong.
public enum SimHelperProtocol {
    /// Bumped when a field changes meaning. ADE reads it off `ready` and can
    /// refuse a helper it does not understand rather than mis-parse one.
    public static let version = 1
}

/// Where a touch is in its gesture.
public enum TouchPhase: String, Equatable, Sendable {
    case begin
    case move
    case end

    /// The vendored `HIDInjector` spells these "begin"/"move"/"end" too, so the
    /// mapping is identity — but going through this property means a rename
    /// upstream is a compile error here rather than a silently dropped touch.
    public var hidType: String { rawValue }
}

public enum KeyPhase: String, Equatable, Sendable {
    case down
    case up
}

/// A point in **device points** (what UIKit calls a point), not framebuffer
/// pixels and not a 0..1 fraction. ADE's renderer already works in points, and
/// the pixel size of a simulator framebuffer changes with the device; making the
/// wire unit the stable one keeps the conversion in exactly one place
/// (`DeviceMetrics`).
public struct DevicePoint: Equatable, Sendable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// One NDJSON line from ADE on stdin.
public enum SimHelperCommand: Equatable, Sendable {
    case listDevices(id: String)
    case captureStart(id: String, udid: String, fps: Int, scale: Double, bitrateKbps: Int?)
    case captureStop(id: String, udid: String)
    case touch(id: String, udid: String, phase: TouchPhase, point: DevicePoint)
    case multiTouch(id: String, udid: String, phase: TouchPhase, first: DevicePoint, second: DevicePoint)
    case button(id: String, udid: String, name: String)
    case key(id: String, udid: String, phase: KeyPhase, usage: Int)
    case type(id: String, udid: String, text: String)
    case scroll(id: String, udid: String, deltaX: Double, deltaY: Double, anchor: DevicePoint?)
    case orientation(id: String, udid: String, value: Int)
    case axDescribe(id: String, udid: String)
    case axFrontmost(id: String, udid: String)
    case screenshot(id: String, udid: String, path: String)
    case recordStart(
        id: String,
        udid: String,
        path: String,
        overlays: Bool,
        fps: Int,
        accentColor: String?,
        idleCompression: Bool
    )
    case recordStop(id: String, udid: String)
    case overlayTap(id: String, udid: String, point: DevicePoint)
    case overlayText(id: String, udid: String, text: String, secure: Bool)
    /// Forget everything the helper holds for one device: finish its
    /// recording, stop its capture, drop its HID client. ADE sends it around a
    /// power cycle, because a session built against one boot keeps talking to
    /// that boot — see `SimHelperRuntime.resetDevice`.
    case deviceReset(id: String, udid: String)
    case quit(id: String)

    /// The `id` every reply to this command must echo.
    public var id: String {
        switch self {
        case let .listDevices(id): return id
        case let .captureStart(id, _, _, _, _): return id
        case let .captureStop(id, _): return id
        case let .touch(id, _, _, _): return id
        case let .multiTouch(id, _, _, _, _): return id
        case let .button(id, _, _): return id
        case let .key(id, _, _, _): return id
        case let .type(id, _, _): return id
        case let .scroll(id, _, _, _, _): return id
        case let .orientation(id, _, _): return id
        case let .axDescribe(id, _): return id
        case let .axFrontmost(id, _): return id
        case let .screenshot(id, _, _): return id
        case let .recordStart(id, _, _, _, _, _, _): return id
        case let .recordStop(id, _): return id
        case let .overlayTap(id, _, _): return id
        case let .overlayText(id, _, _, _): return id
        case let .deviceReset(id, _): return id
        case let .quit(id): return id
        }
    }

    /// Which device this command drives, or nil for process-wide commands.
    public var udid: String? {
        switch self {
        case .listDevices, .quit: return nil
        case let .captureStart(_, udid, _, _, _): return udid
        case let .captureStop(_, udid): return udid
        case let .touch(_, udid, _, _): return udid
        case let .multiTouch(_, udid, _, _, _): return udid
        case let .button(_, udid, _): return udid
        case let .key(_, udid, _, _): return udid
        case let .type(_, udid, _): return udid
        case let .scroll(_, udid, _, _, _): return udid
        case let .orientation(_, udid, _): return udid
        case let .axDescribe(_, udid): return udid
        case let .axFrontmost(_, udid): return udid
        case let .screenshot(_, udid, _): return udid
        case let .recordStart(_, udid, _, _, _, _, _): return udid
        case let .recordStop(_, udid): return udid
        case let .overlayTap(_, udid, _): return udid
        case let .overlayText(_, udid, _, _): return udid
        case let .deviceReset(_, udid): return udid
        }
    }
}

/// Why a line could not be turned into a command.
///
/// This is distinct from "unknown command": a malformed line is ADE's bug and
/// should be reported back, whereas an unknown `type` is a version skew the
/// helper tolerates.
public enum SimHelperParseFailure: Error, Equatable, Sendable {
    /// Not JSON, or not a JSON object — nothing to reply to, so drop it.
    case unusable
    /// Well-formed JSON missing something the command needs.
    case invalid(id: String, message: String)
    /// A `type` this build does not implement.
    case unknownCommand(id: String, type: String)
}

public enum SimHelperCommandParser {
    /// Parse one NDJSON line.
    ///
    /// Returns `.success` for a command this build implements, `.failure` with
    /// enough context to answer otherwise.
    public static func parse(line: String) -> Result<SimHelperCommand, SimHelperParseFailure> {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let data = trimmed.data(using: .utf8) else {
            return .failure(.unusable)
        }
        guard
            let object = try? JSONSerialization.jsonObject(with: data),
            let dictionary = object as? [String: Any],
            let type = dictionary["type"] as? String
        else {
            return .failure(.unusable)
        }

        // A missing id is tolerated rather than rejected: a hand-typed command
        // during debugging should still work, and "" is a correlation key like
        // any other.
        let id = (dictionary["id"] as? String) ?? ""

        func requireUdid() throws -> String {
            guard let udid = dictionary["udid"] as? String, !udid.isEmpty else {
                throw Invalid.message("`udid` is required for \(type).")
            }
            return udid
        }
        func number(_ key: String) -> Double? {
            (dictionary[key] as? NSNumber)?.doubleValue
        }
        func requireNumber(_ key: String) throws -> Double {
            guard let value = number(key), value.isFinite else {
                throw Invalid.message("`\(key)` is required for \(type) and must be a finite number.")
            }
            return value
        }
        func requirePoint(_ xKey: String, _ yKey: String) throws -> DevicePoint {
            DevicePoint(x: try requireNumber(xKey), y: try requireNumber(yKey))
        }

        do {
            switch type {
            case "list-devices":
                return .success(.listDevices(id: id))

            case "capture-start":
                let udid = try requireUdid()
                // fps and scale are hints, not requirements: the framebuffer
                // decides the real rate, and a caller that omits them wants
                // whatever the device gives.
                let fps = Int(number("fps") ?? 60)
                let scale = number("scale") ?? 1
                guard fps > 0, fps <= 240 else {
                    throw Invalid.message("`fps` must be between 1 and 240.")
                }
                guard scale > 0, scale <= 1 else {
                    throw Invalid.message("`scale` must be greater than 0 and at most 1.")
                }
                // Optional. A remote viewer's cap arrives here; the encoder
                // applies it. Values outside the sane range are refused rather
                // than silently clamped, so a caller learns it sent nonsense.
                var bitrateKbps: Int?
                if let raw = number("bitrateKbps") {
                    guard raw >= 100, raw <= 20_000 else {
                        throw Invalid.message("`bitrateKbps` must be between 100 and 20000.")
                    }
                    bitrateKbps = Int(raw)
                }
                return .success(.captureStart(id: id, udid: udid, fps: fps, scale: scale, bitrateKbps: bitrateKbps))

            case "capture-stop":
                return .success(.captureStop(id: id, udid: try requireUdid()))

            case "touch":
                let udid = try requireUdid()
                guard let phase = TouchPhase(rawValue: (dictionary["phase"] as? String) ?? "") else {
                    throw Invalid.message("`phase` must be begin, move or end.")
                }
                return .success(.touch(id: id, udid: udid, phase: phase, point: try requirePoint("x", "y")))

            case "multi-touch":
                let udid = try requireUdid()
                guard let phase = TouchPhase(rawValue: (dictionary["phase"] as? String) ?? "") else {
                    throw Invalid.message("`phase` must be begin, move or end.")
                }
                return .success(.multiTouch(
                    id: id,
                    udid: udid,
                    phase: phase,
                    first: try requirePoint("x1", "y1"),
                    second: try requirePoint("x2", "y2")
                ))

            case "button":
                let udid = try requireUdid()
                guard let name = dictionary["name"] as? String, !name.isEmpty else {
                    throw Invalid.message("`name` is required for button.")
                }
                return .success(.button(id: id, udid: udid, name: name))

            case "key":
                let udid = try requireUdid()
                guard let phase = KeyPhase(rawValue: (dictionary["phase"] as? String) ?? "") else {
                    throw Invalid.message("`phase` must be down or up.")
                }
                let usage = Int(try requireNumber("usage"))
                guard usage > 0, usage <= 0xFFFF else {
                    throw Invalid.message("`usage` must be a HID usage between 1 and 65535.")
                }
                return .success(.key(id: id, udid: udid, phase: phase, usage: usage))

            case "type":
                let udid = try requireUdid()
                guard let text = dictionary["text"] as? String else {
                    throw Invalid.message("`text` is required for type.")
                }
                return .success(.type(id: id, udid: udid, text: text))

            case "scroll":
                let udid = try requireUdid()
                let anchorX = number("anchorX")
                let anchorY = number("anchorY")
                // Half an anchor is a caller bug, not a centre request.
                if (anchorX == nil) != (anchorY == nil) {
                    throw Invalid.message("`anchorX` and `anchorY` must be given together.")
                }
                let anchor = anchorX.flatMap { x in anchorY.map { DevicePoint(x: x, y: $0) } }
                return .success(.scroll(
                    id: id,
                    udid: udid,
                    deltaX: try requireNumber("deltaX"),
                    deltaY: try requireNumber("deltaY"),
                    anchor: anchor
                ))

            case "orientation":
                let udid = try requireUdid()
                let value = Int(try requireNumber("value"))
                guard (1...4).contains(value) else {
                    throw Invalid.message("`value` must be a UIDeviceOrientation between 1 and 4.")
                }
                return .success(.orientation(id: id, udid: udid, value: value))

            case "ax-describe":
                return .success(.axDescribe(id: id, udid: try requireUdid()))

            case "ax-frontmost":
                return .success(.axFrontmost(id: id, udid: try requireUdid()))

            case "screenshot":
                let udid = try requireUdid()
                guard let path = dictionary["path"] as? String, !path.isEmpty else {
                    throw Invalid.message("`path` is required for screenshot.")
                }
                return .success(.screenshot(id: id, udid: udid, path: path))

            case "record-start":
                let udid = try requireUdid()
                guard let path = dictionary["path"] as? String, !path.isEmpty else {
                    throw Invalid.message("`path` is required for record-start.")
                }
                // Overlays default ON to match the Settings default. A caller
                // that means "no decorations" has to say so, because the
                // failure mode of the other default — an agent silently
                // producing undecorated proof — is invisible.
                let overlays = (dictionary["overlays"] as? NSNumber)?.boolValue ?? true
                let fps = Int(number("fps") ?? 30)
                guard fps > 0, fps <= 60 else {
                    throw Invalid.message("`fps` must be between 1 and 60.")
                }
                let accent = (dictionary["accentColor"] as? String).flatMap { $0.isEmpty ? nil : $0 }
                // Idle cutting defaults ON: a recording of an agent thinking is
                // mostly a frozen screen. `false` keeps wall-clock time.
                let idleCompression = (dictionary["idleCompression"] as? NSNumber)?.boolValue ?? true
                return .success(.recordStart(
                    id: id,
                    udid: udid,
                    path: path,
                    overlays: overlays,
                    fps: fps,
                    accentColor: accent,
                    idleCompression: idleCompression
                ))

            case "record-stop":
                return .success(.recordStop(id: id, udid: try requireUdid()))

            case "overlay-tap":
                let udid = try requireUdid()
                return .success(.overlayTap(id: id, udid: udid, point: try requirePoint("x", "y")))

            case "overlay-text":
                let udid = try requireUdid()
                guard let text = dictionary["text"] as? String else {
                    throw Invalid.message("`text` is required for overlay-text.")
                }
                // Belt and braces. ADE is the one that knows a field is secure
                // and is expected not to send the characters at all, but a
                // helper that would happily burn a password into an MP4 if ADE
                // slipped is a helper with the wrong default.
                let secure = (dictionary["secure"] as? NSNumber)?.boolValue ?? false
                return .success(.overlayText(id: id, udid: udid, text: text, secure: secure))

            case "device-reset":
                return .success(.deviceReset(id: id, udid: try requireUdid()))

            case "quit":
                return .success(.quit(id: id))

            default:
                return .failure(.unknownCommand(id: id, type: type))
            }
        } catch let Invalid.message(message) {
            return .failure(.invalid(id: id, message: message))
        } catch {
            return .failure(.invalid(id: id, message: String(describing: error)))
        }
    }

    private enum Invalid: Error {
        case message(String)
    }
}

/// One NDJSON line from the helper to ADE.
///
/// `@unchecked Sendable` because `ok`'s payload is `[String: Any]` — the natural
/// shape for "whatever this command answers with", and what `JSONSerialization`
/// consumes. It is safe in practice: a payload is built at the emit site, handed
/// straight to the writer, and never mutated or read again.
public enum SimHelperEvent: @unchecked Sendable {
    /// Sent once, unprompted, when the helper is ready for commands.
    case ready(pid: Int32)
    /// A command succeeded. `payload` is merged into the line.
    case ok(id: String, payload: [String: Any])
    /// A command failed. `code` is stable and machine-readable; `message` is not.
    case error(id: String, code: String, message: String)
    /// Capture is live and the frame endpoint is accepting readers.
    case captureStarted(
        id: String,
        udid: String,
        url: String,
        token: String,
        pointWidth: Double,
        pointHeight: Double,
        pixelWidth: Int,
        pixelHeight: Int,
        scale: Double
    )
    /// Capture ended, whether because ADE asked or because it broke.
    case captureStopped(udid: String, reason: String)
    /// A recording is running and the file at `path` is being written.
    case recordStarted(id: String, udid: String, path: String)
    /// A recording finished. `bytes` is the file as it landed on disk, so ADE
    /// can size the storage warning without stat-ing it again. `durationMs` is
    /// the video's length; `wallDurationMs` the real time it covers, and
    /// `idleCutMs` the difference cut as dead time.
    case recordStopped(udid: String, path: String, durationMs: Int, wallDurationMs: Int, idleCutMs: Int, bytes: Int)

    public var payload: [String: Any] {
        switch self {
        case let .ready(pid):
            return ["type": "ready", "protocol": SimHelperProtocol.version, "pid": Int(pid)]
        case let .ok(id, payload):
            var line: [String: Any] = ["type": "ok", "id": id]
            for (key, value) in payload { line[key] = value }
            return line
        case let .error(id, code, message):
            return ["type": "error", "id": id, "code": code, "message": message]
        case let .captureStarted(id, udid, url, token, pointWidth, pointHeight, pixelWidth, pixelHeight, scale):
            return [
                "type": "capture-started",
                "id": id,
                "udid": udid,
                "url": url,
                "token": token,
                "pointWidth": pointWidth,
                "pointHeight": pointHeight,
                "pixelWidth": pixelWidth,
                "pixelHeight": pixelHeight,
                "scale": scale,
            ]
        case let .captureStopped(udid, reason):
            return ["type": "capture-stopped", "udid": udid, "reason": reason]
        case let .recordStarted(id, udid, path):
            return ["type": "record-started", "id": id, "udid": udid, "path": path]
        case let .recordStopped(udid, path, durationMs, wallDurationMs, idleCutMs, bytes):
            return [
                "type": "record-stopped",
                "udid": udid,
                "path": path,
                "durationMs": durationMs,
                "wallDurationMs": wallDurationMs,
                "idleCutMs": idleCutMs,
                "bytes": bytes,
            ]
        }
    }

    /// The exact bytes written to stdout, newline included.
    ///
    /// Serialisation failure is handled rather than force-unwrapped for the same
    /// reason the capture helper handles it: a crash here would take every other
    /// device down with it.
    public func encoded() -> String? {
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
            let text = String(data: data, encoding: .utf8)
        else { return nil }
        return text + "\n"
    }
}
