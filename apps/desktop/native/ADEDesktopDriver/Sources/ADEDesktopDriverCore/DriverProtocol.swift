/// The NDJSON wire between the ADE runtime (Node) and this helper.
///
/// One JSON object per line, in both directions:
///
///   * request  `{"id":"7","op":"observe","laneId":"…", …}`
///   * reply    `{"id":"7","ok":true,"result":{…}}`
///              `{"id":"7","ok":false,"error":{"code":"…","message":"…"}}`
///   * event    `{"event":"windows-changed","laneId":"…","windows":[…]}`
///
/// The shapes carried inside `result` are the ones written down in
/// `apps/desktop/src/shared/types/macDesktop.ts`. That file is the contract; this
/// one only moves bytes. Nothing here imports AppKit, so the framing is testable
/// without a window server.
///
/// The decoder is deliberately permissive in one direction only: an unknown
/// `op`, or a field the driver does not recognise, must produce an answer rather
/// than a crash, because a newer Node talking to an older helper is a normal
/// state during an update. A line that is not a JSON object at all is a real
/// protocol fault and is reported as one.

import Foundation

// ---------------------------------------------------------------------------
// A JSON value the driver can carry without knowing its shape
// ---------------------------------------------------------------------------

/// Any JSON value.
///
/// `int` and `double` are separate cases on purpose: a window id, a pid and an
/// element index must serialise as `41` and not `41.0`, and a single `Double`
/// case cannot promise that across Foundation versions.
public enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])
}

extension JSONValue: Codable {
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unsupported JSON value"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

extension JSONValue {
    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var intValue: Int? {
        switch self {
        case .int(let value): return value
        case .double(let value): return Int(value)
        default: return nil
        }
    }

    public var doubleValue: Double? {
        switch self {
        case .int(let value): return Double(value)
        case .double(let value): return value
        default: return nil
        }
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

/// The codes a reply can carry.
///
/// The `MAC_DESKTOP_*` values are copied from `macDesktop.ts` because the
/// service maps them straight onto thrown errors; a code invented here that the
/// service has never heard of degrades to a generic failure in the UI.
public enum DriverErrorCode {
    public static let unsupportedPlatform = "MAC_DESKTOP_UNSUPPORTED_PLATFORM"
    public static let driverUnavailable = "MAC_DESKTOP_DRIVER_UNAVAILABLE"
    public static let permissionRequired = "MAC_DESKTOP_PERMISSION_REQUIRED"
    public static let displayUnavailable = "MAC_DESKTOP_DISPLAY_UNAVAILABLE"
    public static let noDisplay = "MAC_DESKTOP_NO_DISPLAY"
    public static let appOwnedByOtherLane = "MAC_DESKTOP_APP_OWNED_BY_OTHER_LANE"
    public static let windowNotFound = "MAC_DESKTOP_WINDOW_NOT_FOUND"
    public static let handleExpired = "MAC_DESKTOP_HANDLE_EXPIRED"
    public static let inputLeaseRequired = "MAC_DESKTOP_INPUT_LEASE_REQUIRED"
    public static let recordingNotRunning = "MAC_DESKTOP_RECORDING_NOT_RUNNING"

    /// Helper-local faults. The service turns these into `MAC_DESKTOP_DRIVER_*`
    /// messages; they are separate so a bad line and a bad display are not the
    /// same incident in a log.
    /// A window exists but has not published an accessibility element yet.
    /// Deliberately not `permissionRequired`: a readiness race and a missing
    /// grant look identical at the call site and must not read identically to
    /// the user.
    public static let windowNotReady = "window_not_ready"
    /// A request that was parked behind a real gesture waited longer than the
    /// caller could plausibly still be listening for, and was answered instead
    /// of run. Distinct from `internal_error` because nothing went wrong in the
    /// driver: the world simply moved on.
    public static let deferredExpired = "deferred_expired"
    /// A `wait` arrived while a real gesture was holding the mouse button.
    ///
    /// `wait` is deliberately not deferred — it would sit in the queue for up
    /// to two minutes and hold everything parked behind it — but it is also not
    /// safe to run: every request is dispatched on the main thread, nested
    /// inside the drag's own run-loop pump, so a wait that polls would keep the
    /// button held for its whole timeout. Refusing immediately hands the retry
    /// decision to the caller, which is the only side that knows its deadline.
    public static let gestureInFlight = "gesture_in_flight"
    public static let unknownOp = "unknown_op"
    public static let protocolError = "protocol_error"
    public static let invalidArgument = "invalid_argument"
    public static let internalError = "internal_error"
}

/// Anything the driver refuses to do, in the shape a reply carries.
public struct DriverError: Codable, Equatable, Sendable, Error {
    public let code: String
    public let message: String

    public init(code: String, message: String) {
        self.code = code
        self.message = message
    }
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/// Every operation Node can ask for.
///
/// Spelled out rather than left as a bare string so the dispatcher's switch is
/// exhaustive and a typo is a compile error instead of a silent `unknown_op` at
/// three in the morning.
///
/// The raw value *is* the wire name, and the wire name is the grouped spelling
/// the feature doc and the Node client both use (`display.create`,
/// `stream.setRate`, `lease.set`). There was once a second camelCase spelling
/// accepted alongside it; nothing ever sent it, and two names for one op is a
/// contract that drifts. Liveness is `ping` because that is the word a process
/// supervisor reaches for.
///
/// The table, request fields → result shape (result shapes are the types in
/// `apps/desktop/src/shared/types/macDesktop.ts`):
///
/// | op | request fields | result |
/// |---|---|---|
/// | `ping` | — | `{version, permissions, displayMode, virtualDisplay, idleSeconds, pid}` |
/// | `display.create` | `laneId,name,width,height,scale` | `MacDesktopDisplay` |
/// | `display.destroy` | `laneId,reason?` | `{destroyed, releasedWindows}` |
/// | `display.reconcile` | `liveLaneIds` | `{destroyed: string[]}` |
/// | `window.list` | `laneId?`, `pid?` | `{windows: MacDesktopWindow[]}` |
/// | `window.park` | `laneId,windowId` | `MacDesktopWindow` |
/// | `window.unpark` | `windowId` | `{window: MacDesktopWindow?}` |
/// | `app.launch` | `laneId,target,args?` | `MacDesktopOpenResult` |
/// | `present` | `laneId,destination` | `{moved}` |
/// | `observe` | `laneId,windowId?,limit?,map?,screenshotPath?,mapPath?,caption?` | `MacDesktopObservation` |
/// | `input` | `laneId,command,mode,payload,lease?` | `{resolvedIndex}` |
/// | `lease.set` | `laneId,holderId,expiresAt` | `{laneId,holderId,expiresAt}` |
/// | `lease.clear` | `laneId` | `{cleared}` |
/// | `capture.screenshot` | `laneId,windowId?,path` | `MacDesktopScreenshotResult` |
/// | `stream.start` | `laneId,fps?` | `MacDesktopStreamTransport` + `{port}` |
/// | `stream.setRate` | `laneId,fps` | `{fps}` |
/// | `stream.setCursorVisible` | `laneId,visible` | `{visible}` |
/// | `stream.stop` | `laneId` | `{stopped}` |
/// | `record.start` | `laneId,fps?,filePath` | `{startedAt}` |
/// | `record.stop` | `laneId` | `{filePath,durationMs}` |
public enum DriverOp: String, CaseIterable, Sendable {
    case health = "ping"
    case createDisplay = "display.create"
    case destroyDisplay = "display.destroy"
    case reconcileDisplays = "display.reconcile"
    case listWindows = "window.list"
    case parkWindow = "window.park"
    case unparkWindow = "window.unpark"
    case launch = "app.launch"
    case present
    case observe
    case input
    case setLease = "lease.set"
    case clearLease = "lease.clear"
    case screenshot = "capture.screenshot"
    case startStream = "stream.start"
    case setStreamRate = "stream.setRate"
    case setStreamCursorVisible = "stream.setCursorVisible"
    case stopStream = "stream.stop"
    case startRecording = "record.start"
    case stopRecording = "record.stop"
}

/// One decoded request line.
///
/// `fields` keeps the whole object rather than a per-op struct: the ops share
/// almost no fields, and twenty near-empty structs would make adding one
/// optional argument a change in three places.
public struct DriverRequest: Equatable, Sendable {
    public let id: String
    public let op: String
    public let fields: [String: JSONValue]

    public init(id: String, op: String, fields: [String: JSONValue] = [:]) {
        self.id = id
        self.op = op
        self.fields = fields
    }

    /// The known op, or nil when Node is newer than this helper.
    public var knownOp: DriverOp? { DriverOp(rawValue: op) }

    public func string(_ key: String) -> String? { fields[key]?.stringValue }
    public func int(_ key: String) -> Int? { fields[key]?.intValue }
    public func double(_ key: String) -> Double? { fields[key]?.doubleValue }
    public func bool(_ key: String) -> Bool? { fields[key]?.boolValue }
    public func object(_ key: String) -> [String: JSONValue]? { fields[key]?.objectValue }

    public func stringArray(_ key: String) -> [String]? {
        guard let raw = fields[key]?.arrayValue else { return nil }
        return raw.compactMap(\.stringValue)
    }

    public func requireString(_ key: String) throws -> String {
        guard let value = string(key), !value.isEmpty else {
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\(op) needs a non-empty \"\(key)\"."
            )
        }
        return value
    }

    public func requireInt(_ key: String) throws -> Int {
        guard let value = int(key) else {
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\(op) needs a numeric \"\(key)\"."
            )
        }
        return value
    }

    public func requireDouble(_ key: String) throws -> Double {
        guard let value = double(key) else {
            throw DriverError(
                code: DriverErrorCode.invalidArgument,
                message: "\(op) needs a numeric \"\(key)\"."
            )
        }
        return value
    }
}

/// What one input line turned into.
public enum DriverInput: Equatable, Sendable {
    case request(DriverRequest)
    /// A well-formed JSON object that names no operation — a keepalive, or a
    /// field-only ping from a newer Node. Answered with silence, not an error.
    case ignored
}

public enum DriverProtocolError: Error, Equatable {
    case malformedLine(String)
    case missingField(String)
}

public enum DriverInputDecoder {
    public static func decode(line: String, decoder: JSONDecoder = JSONDecoder()) throws -> DriverInput {
        let data = Data(line.utf8)
        guard let decoded = try? decoder.decode(JSONValue.self, from: data),
              let object = decoded.objectValue
        else {
            throw DriverProtocolError.malformedLine("Line is not a JSON object.")
        }
        let id = object["id"]?.stringValue
        let op = object["op"]?.stringValue
        if id == nil && op == nil {
            return .ignored
        }
        guard let id, !id.isEmpty else {
            throw DriverProtocolError.missingField("id")
        }
        guard let op, !op.isEmpty else {
            throw DriverProtocolError.missingField("op")
        }
        var fields = object
        fields.removeValue(forKey: "id")
        fields.removeValue(forKey: "op")
        return .request(DriverRequest(id: id, op: op, fields: fields))
    }

    /// The `id` of a line that failed to decode, when it had one.
    ///
    /// A line whose `op` is missing or blank still carries a request id, and the
    /// caller is owed a reply on it: without this, the only thing that ever
    /// settles that promise is the client's 20-second timeout. A line with no
    /// parsable id has nobody to answer and becomes a `protocol_error` event
    /// instead.
    public static func requestId(inLine line: String, decoder: JSONDecoder = JSONDecoder()) -> String? {
        guard let decoded = try? decoder.decode(JSONValue.self, from: Data(line.utf8)),
              let id = decoded.objectValue?["id"]?.stringValue,
              !id.isEmpty
        else { return nil }
        return id
    }
}

// ---------------------------------------------------------------------------
// Replies and events
// ---------------------------------------------------------------------------

public struct DriverReply: Encodable, Equatable, Sendable {
    public let id: String
    public let ok: Bool
    public let result: JSONValue?
    public let error: DriverError?

    private enum CodingKeys: String, CodingKey {
        case id, ok, result, error
    }

    public init(id: String, ok: Bool, result: JSONValue?, error: DriverError?) {
        self.id = id
        self.ok = ok
        self.result = result
        self.error = error
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        try container.encode(ok, forKey: .ok)
        try container.encodeIfPresent(result, forKey: .result)
        try container.encodeIfPresent(error, forKey: .error)
    }

    public static func success(id: String, result: [String: JSONValue] = [:]) -> DriverReply {
        DriverReply(id: id, ok: true, result: .object(result), error: nil)
    }

    public static func failure(id: String, code: String, message: String) -> DriverReply {
        DriverReply(id: id, ok: false, result: nil, error: DriverError(code: code, message: message))
    }

    public static func failure(id: String, error: DriverError) -> DriverReply {
        DriverReply(id: id, ok: false, result: nil, error: error)
    }

    /// The answer to an op this build has never heard of. Never a crash, and
    /// never silence: a request that carried an `id` is owed a reply or the
    /// caller's promise never settles.
    public static func unknownOp(id: String, op: String) -> DriverReply {
        failure(
            id: id,
            code: DriverErrorCode.unknownOp,
            message: "This ade-desktop-driver build does not implement \"\(op)\"."
        )
    }
}

/// An unsolicited line. Carries `event` and its own fields, never an `id`.
public struct DriverEvent: Encodable, Equatable, Sendable {
    public let event: String
    public let fields: [String: JSONValue]

    public init(event: String, fields: [String: JSONValue] = [:]) {
        self.event = event
        self.fields = fields
    }

    private struct DynamicKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init(_ stringValue: String) { self.stringValue = stringValue }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: DynamicKey.self)
        try container.encode(event, forKey: DynamicKey("event"))
        for (key, value) in fields where key != "event" {
            try container.encode(value, forKey: DynamicKey(key))
        }
    }

    public static func protocolError(_ message: String) -> DriverEvent {
        DriverEvent(event: DriverErrorCode.protocolError, fields: ["message": .string(message)])
    }
}

/// Either kind of line the driver writes.
public enum DriverOutput: Encodable, Equatable, Sendable {
    case reply(DriverReply)
    case event(DriverEvent)

    public func encode(to encoder: Encoder) throws {
        switch self {
        case .reply(let reply): try reply.encode(to: encoder)
        case .event(let event): try event.encode(to: encoder)
        }
    }
}

// ---------------------------------------------------------------------------
// Stream framing
// ---------------------------------------------------------------------------

/// The 12-byte record header the iOS simulator video server already uses.
///
/// Reused rather than reinvented: the renderer's reader is the same code for
/// both surfaces, and two independent copies of a binary contract desynchronise
/// at runtime instead of failing to compile. The constants are mirrored from
/// `IOS_VIDEO_RECORD_*` in `apps/desktop/src/shared/types/iosSimulator.ts`.
///
/// Layout, big-endian: u32 magic, u8 type, u8 flags, u16 reserved (0), u32
/// payload length.
public enum StreamRecord {
    public static let magic: UInt32 = 0xade1_f00d
    public static let headerBytes = 12
    public static let typeConfig: UInt8 = 1
    public static let typeAccessUnit: UInt8 = 2
    public static let flagKeyframe: UInt8 = 1

    public static func header(type: UInt8, flags: UInt8, payloadLength: Int) -> Data {
        var data = Data(capacity: headerBytes)
        appendBigEndian(&data, UInt32(truncatingIfNeeded: magic))
        data.append(type)
        data.append(flags)
        appendBigEndian(&data, UInt16(0))
        appendBigEndian(&data, UInt32(truncatingIfNeeded: payloadLength))
        return data
    }

    public static func encode(type: UInt8, flags: UInt8, payload: Data) -> Data {
        var data = header(type: type, flags: flags, payloadLength: payload.count)
        data.append(payload)
        return data
    }

    /// The `config` record: the payload is the UTF-8 codec string, e.g.
    /// `avc1.640032`.
    public static func configRecord(codec: String) -> Data {
        encode(type: typeConfig, flags: 0, payload: Data(codec.utf8))
    }

    /// One Annex-B access unit.
    public static func accessUnitRecord(payload: Data, keyframe: Bool) -> Data {
        encode(type: typeAccessUnit, flags: keyframe ? flagKeyframe : 0, payload: payload)
    }

    private static func appendBigEndian(_ data: inout Data, _ value: UInt32) {
        data.append(UInt8(truncatingIfNeeded: value >> 24))
        data.append(UInt8(truncatingIfNeeded: value >> 16))
        data.append(UInt8(truncatingIfNeeded: value >> 8))
        data.append(UInt8(truncatingIfNeeded: value))
    }

    private static func appendBigEndian(_ data: inout Data, _ value: UInt16) {
        data.append(UInt8(truncatingIfNeeded: value >> 8))
        data.append(UInt8(truncatingIfNeeded: value))
    }
}
