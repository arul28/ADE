import Foundation

/// The phone's half of the `window.adePlugin` contract.
///
/// A plugin page is HTML the plugin ships. The desktop draws it in an Electron
/// guest and answers its calls over `contextBridge`; the phone draws the same
/// page in a `WKWebView` and answers the same calls over a script message
/// handler. This file is the wire format for that second path, kept apart from
/// the view so every decoding rule is testable without WebKit.
///
/// ## Where the plugin id comes from
///
/// Not from the page. WebKit stamps every `WKScriptMessage` with the frame's
/// own `securityOrigin`, and that origin is `ade-plugin://<pluginId>` because
/// the scheme handler is the only thing that can serve one. A `pluginId` field
/// in a message body would be a CLAIM, and honouring a claim is how one plugin
/// reads another's collections — so this decoder has no field to ignore: it
/// reads the id out of the origin and nowhere else.
///
/// ## Why the version rides on every call
///
/// `PLUGIN_PAGE_BRIDGE_VERSION` mirrors `PLUGIN_WEBVIEW_BRIDGE_VERSION` on the
/// desktop (`apps/desktop/src/shared/plugins/webviewBridge.ts`). A page written
/// against v1 keeps working when the host reaches v2, and a page written
/// against v2 checks `version` before it calls something v1 lacks. The host
/// never refuses a call for being older than itself.

/// The handshake number the injected `window.adePlugin` reports.
///
/// Must equal `PLUGIN_WEBVIEW_BRIDGE_VERSION` on the desktop. A page that sees
/// a smaller number here than the desktop reports is talking to an older phone,
/// which is exactly what the number is for.
let pluginPageBridgeVersion = 2

/// The scheme a plugin page is served from. One origin per plugin, which is
/// what makes WebKit's own same-origin rules do most of the isolation work.
let pluginPageScheme = "ade-plugin"

/// The query parameter the host reads the injected context out of.
///
/// A double-underscore name so it cannot collide with a query a plugin's own
/// page cares about, and read only by the host — the file the scheme handler
/// serves is chosen by the path, never the query.
let pluginPageContextQueryParam = "__adeCtx"

/// The content policy every plugin page runs under.
///
/// Transcribed from `PLUGIN_WEBVIEW_CSP`. Kept as one literal rather than
/// assembled from parts so a diff against the desktop constant is a plain text
/// comparison — `PluginPageBridgeTests` asserts the exact string, which is the
/// only way a drift between the two platforms shows up as a failing test
/// instead of as a page that loads on one and not the other.
let pluginPageContentSecurityPolicy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' https: data: blob:",
    "media-src 'self' https: blob:",
    "font-src 'self' data:",
    "connect-src https:",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
].joined(separator: "; ")

/// Everything a page may ask for, as one closed list.
///
/// The list IS the permission model: a verb absent here cannot be reached, and
/// a page cannot widen it. Mirrors `PLUGIN_WEBVIEW_METHODS`. Absent on purpose:
/// `secrets` (a page is the one place a plugin's credentials should never be
/// readable), `contributions.publish`, `panels.update`, and
/// `collections.delete`.
enum PluginPageBridgeMethod: String, CaseIterable, Equatable {
    case collectionsGet = "collections.get"
    case collectionsPut = "collections.put"
    case collectionsList = "collections.list"
    case invoke
    case configGet = "config.get"
    case configSet = "config.set"
    case openDeeplink
    // v2. Everything below reaches ADE's own UI or the machine around it.
    case openSettings
    case surfaceClose = "surface.close"
    case composerAttach = "composer.attach"
    case composerInsert = "composer.insert"
    case uiToast = "ui.toast"
    case uiDismissToast = "ui.dismissToast"
    case uiPrompt = "ui.prompt"
    case uiConfirm = "ui.confirm"
    case clipboardRead = "clipboard.read"
    case clipboardWrite = "clipboard.write"
    case themeGet = "theme.get"
    case hostSubscribe = "host.subscribe"
    case hostUnsubscribe = "host.unsubscribe"
    /// Hand the chosen issue to the ADE dialog a `dialog-picker` page is drawn
    /// inside. Refused in every other placement.
    case dialogSubmit = "dialog.submit"
    /// This page's own content height, for a placement sized to its content.
    ///
    /// On desktop this is NOT a bridge method: it rides a dedicated channel
    /// straight to the element hosting the frame, because it is a report rather
    /// than a request. The phone has exactly ONE channel to the host, so the
    /// report rides it and is answered with nothing — the same fact reaching
    /// the same place, by the only road this client has.
    case uiResize = "ui.resize"
    // Wave 2. The host pickers: a page asks ADE's own UI to make one of five
    // choices and hears back the choice, `null` when the reader dismissed it,
    // or a rejection when this client genuinely cannot ask.
    case uiPickModel = "ui.pickModel"
    case uiPickLane = "ui.pickLane"
    case uiPickPermissionMode = "ui.pickPermissionMode"
    case uiPickReasoningEffort = "ui.pickReasoningEffort"
    case uiPickProvider = "ui.pickProvider"
    /// Open a checkout path in the reader's editor.
    ///
    /// Named here rather than omitted so a page hears the phone's REFUSAL —
    /// one sentence saying this device has no editor to open a path in —
    /// instead of an "unknown bridge method" that reads as a version skew the
    /// page could feature-detect its way around. There is nothing to detect:
    /// no build of this app will ever open a Mac's checkout.
    case uiOpenPathInEditor = "ui.openPathInEditor"
    /// Third-party socket contributions a page may draw, and press.
    case socketsList = "sockets.list"
    case socketsInvoke = "sockets.invoke"
    /// Host-engine placement. The phone has no inspector or simulator mirror
    /// to paint, so both verbs refuse by name rather than decoding as unknown.
    case hostEnginePlace = "hostEngine.place"
    case hostEngineRelease = "hostEngine.release"
    /// The guest reporting its own uncaught error or content-policy violation.
    ///
    /// On desktop the page's script reports this on its own channel. The phone
    /// has exactly ONE channel to the host, so the report rides it and is
    /// answered with nothing — the same fact reaching the same place, by the
    /// only road this client has. See `ui.resize`, which is here for the same
    /// reason.
    case pageError = "page.error"
}

/// Tallest a page may ask its own frame to be. `PLUGIN_WEBVIEW_MAX_HEIGHT_PX`.
let pluginPageMaxHeightPx = 2_000

/// The height a host should apply, or nil when the page said nothing usable.
///
/// A value that is not a finite positive number is nil rather than zero: "the
/// page said nothing usable" and "the page wants to be invisible" are different
/// instructions, and collapsing them would hide a broken observer.
func clampPluginPageHeight(_ value: Double?) -> Int? {
    guard let value, value.isFinite, value > 0 else { return nil }
    return min(Int(value.rounded(.up)), pluginPageMaxHeightPx)
}

/// Where the host drew a guest.
///
/// A closed list because it is half of the relay's addressing: `surface.close`
/// means "close the sheet", "close the picker" or "do nothing" depending on
/// this value alone. The phone never draws `pane` or `drawer` — they stay in
/// the enum so a context encoded by a desktop-authored URL still decodes.
enum PluginPagePlacement: String, Equatable {
    case tab
    case pane
    case drawer
    case overlay
    case popover
    case settingsSection = "settings-section"
    case composerPicker = "composer-picker"
    /// A page drawn INSIDE one of ADE's own dialogs, in place of its built-in
    /// issue picker. Like `settings-section` it sits inside a taller surface,
    /// which is why both are sized to their content and neither closes anything
    /// on `surface.close`.
    case dialogPicker = "dialog-picker"
}

/// The events a page may listen for. Mirrors `PLUGIN_WEBVIEW_EVENTS`.
enum PluginPageBridgeEvent: String, Equatable {
    case changed
    case theme
    case host
    /// The reader pulled the page down.
    ///
    /// An EVENT rather than a method, and it rides the one event channel the
    /// others do, because it is the host telling the page something rather
    /// than the page asking. The payload is empty: "refresh yourself" carries
    /// no argument, and a page that needed one would be asking the host to
    /// decide what it should redraw.
    case refresh
    /// The host moved this page's SUBJECT.
    ///
    /// Desktop-only today, and listed here anyway. A rail tab on the desktop is
    /// opened once and outlives many lane selections, so its subject moves; the
    /// phone presents a page as a sheet whose subject is fixed by the press that
    /// opened it, so nothing here publishes one. What the phone must not do is
    /// REFUSE the name: one page runs in both hosts, and a page that subscribes
    /// here should hear nothing rather than fail to subscribe at all.
    ///
    /// Payload is `{ subject }` — the whole subject, never a delta, and null is
    /// a real answer.
    case context
}

/// The host-side entity kinds `host.subscribe` accepts.
enum PluginPageHostKind: String, Equatable, CaseIterable {
    case lane
    case session
    case pr
    /// Not an entity family, and the one kind that carries more than identity:
    /// a `chat` frame reports where a session's TURN is. A page that launched
    /// an agent cannot re-derive "that turn failed" from the session's
    /// existence — the session exists either way. See `PluginPageChatTurn`.
    case chat
    // Wave 2. Three more families a page may follow, accepted and forwarded on
    // exactly the terms the four above are: a subscription is taken, a
    // baseline is read without emitting, and a frame carries identity only.
    /// A long-running host operation — a rebase, a clone, a push.
    case operation
    /// A merge or rebase conflict the reader has to resolve.
    case conflict
    /// A code review run.
    case review
}

/// Where a chat session's current turn is, as a page hears it.
///
/// Three states rather than the five the app tracks: a page draws a launched
/// issue as running, done or broken, and `interrupted` is a `failed` the reader
/// caused on purpose — which is still not "Ready". `message` is the host's own
/// failure sentence and is present only on `failed`.
struct PluginPageChatTurn: Equatable {
    enum State: String, Equatable {
        case started
        case completed
        case failed
    }

    var sessionId: String
    var state: State
    var turnId: String?
    var message: String?

    /// Ceiling on a failure sentence handed to a page.
    static let messageMaxChars = 400

    /// What one coalesced `chat` frame may carry before it says `overflow`.
    static let turnsMax = 100

    var jsonValue: [String: Any] {
        var encoded: [String: Any] = ["sessionId": sessionId, "state": state.rawValue]
        if let turnId, !turnId.isEmpty { encoded["turnId"] = turnId }
        // Only on a failure, exactly as `sanitizePluginWebviewChatTurn` rules:
        // a sentence on a completed turn would be a second, unspecified channel
        // a page would learn to read.
        if state == .failed, let message, !message.isEmpty {
            encoded["message"] = String(message.prefix(Self.messageMaxChars))
        }
        return encoded
    }
}

/// The project a plugin page is running against.
///
/// `binding` is the fact a page cannot derive: `remote` means the checkout
/// lives on another machine and `root` is that machine's path, so a page must
/// not present it as something the user can open here.
struct PluginPageProjectContext: Codable, Equatable {
    var projectId: String?
    var root: String?
    var binding: String

    static let localBinding = "local"
    static let remoteBinding = "remote"
}

/// What the host attached this page to.
///
/// INJECTED, in the same sense the desktop means it: every field is set by the
/// host from what it already knows, encoded into the source URL before the page
/// runs a line of script, and captured back out at attach. A page that rewrites
/// its own query string does not change what the host reports.
struct PluginPageContext: Codable, Equatable {
    var subject: [String: PluginPageJSON]?
    var pointer: [String: PluginPageJSON]?
    var surfaceId: String?
    var placement: String?
    var project: PluginPageProjectContext?

    init(
        subject: [String: PluginPageJSON]? = nil,
        pointer: [String: PluginPageJSON]? = nil,
        surfaceId: String? = nil,
        placement: PluginPagePlacement? = nil,
        project: PluginPageProjectContext? = nil
    ) {
        self.subject = subject
        self.pointer = pointer
        self.surfaceId = surfaceId
        self.placement = placement?.rawValue
        self.project = project
    }
}

/// The whole context envelope, as bytes on the source URL, is capped here.
///
/// It is a pointer, not a payload — the page reads the plugin's collections for
/// everything else. An oversize context is DROPPED rather than truncated: a
/// page opens with no subject rather than with half of one.
let pluginPageContextMaxBytes = 4 * 1024

/// A JSON value that survives a round trip through the context query.
///
/// `Any` cannot be `Codable` and a plugin's pointer is arbitrary JSON, so the
/// two meet here. Deliberately total: every JSON shape decodes, and anything
/// that does not is `null` rather than a thrown error that would lose the whole
/// context over one unexpected field.
indirect enum PluginPageJSON: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: PluginPageJSON])
    case array([PluginPageJSON])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([PluginPageJSON].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: PluginPageJSON].self) {
            self = .object(value)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    /// The Foundation value this wraps, for the `[String: Any]` dictionaries
    /// every existing plugin RPC on this phone already speaks.
    var foundationValue: Any? {
        switch self {
        case .string(let value): return value
        case .number(let value): return value == value.rounded() && abs(value) < 9_007_199_254_740_992 ? Int(value) : value
        case .bool(let value): return value
        case .object(let value): return value.compactMapValues(\.foundationValue)
        case .array(let value): return value.compactMap(\.foundationValue)
        case .null: return nil
        }
    }

    /// The reverse, for building a context out of what the app already holds.
    static func from(_ value: Any?) -> PluginPageJSON {
        switch value {
        case nil, is NSNull: return .null
        case let value as String: return .string(value)
        case let value as Bool: return .bool(value)
        case let value as Int: return .number(Double(value))
        case let value as Double: return .number(value)
        case let value as [String: Any]: return .object(value.mapValues { PluginPageJSON.from($0) })
        case let value as [Any]: return .array(value.map { PluginPageJSON.from($0) })
        default: return .null
        }
    }

    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    var objectValue: [String: PluginPageJSON]? {
        if case .object(let value) = self { return value }
        return nil
    }

    var arrayValue: [PluginPageJSON]? {
        if case .array(let value) = self { return value }
        return nil
    }
}

/// One call from a page, after decoding.
///
/// Note the absence of a plugin id: see the file header. `pluginId` is filled in
/// by the caller from the message's own frame origin, never from `body`.
struct PluginPageBridgeRequest: Equatable {
    var id: String
    var bridgeVersion: Int
    var method: PluginPageBridgeMethod
    var params: [String: PluginPageJSON]
}

/// Why a decode failed, in the words the page is handed back.
enum PluginPageBridgeDecodeError: Error, Equatable {
    case malformedBody
    case missingRequestId
    case unknownMethod(String)

    var message: String {
        switch self {
        case .malformedBody: return "Bridge message must be an object."
        case .missingRequestId: return "Bridge message requires an id."
        case .unknownMethod(let method): return "Unknown bridge method \"\(method)\"."
        }
    }
}

enum PluginPageBridgeDecoder {
    /// The plugin id an origin names, or nil.
    ///
    /// `ade-plugin://<pluginId>` and nothing else. A different scheme, an empty
    /// host, or a host that is not a valid plugin id all answer nil, and a nil
    /// answer means the message is dropped without being interpreted — an
    /// unrecognised origin is not a plugin asking politely, it is a frame that
    /// should not be able to reach this handler at all.
    static func pluginId(fromOriginScheme scheme: String, host: String) -> String? {
        guard scheme.lowercased() == pluginPageScheme else { return nil }
        let candidate = host.lowercased()
        guard isValidPluginPageId(candidate) else { return nil }
        return candidate
    }

    /// `PLUGIN_ID_PATTERN` from the desktop manifest parser, character for
    /// character: `^[a-z][a-z0-9-]{0,63}$`.
    ///
    /// Written to be neither stricter nor looser than the host. A phone that
    /// refused an id the Mac installed — a trailing dash, a double dash — would
    /// show a page that never loads, with nothing anywhere saying why; and one
    /// that accepted more than the host would give an origin to a directory
    /// name no installer could have produced.
    static func isValidPluginPageId(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 64 else { return false }
        var isFirst = true
        for character in value {
            guard character.isASCII else { return false }
            let isLowerAlpha = character.isLetter && character.isLowercase
            if isFirst {
                guard isLowerAlpha else { return false }
                isFirst = false
                continue
            }
            guard isLowerAlpha || character.isNumber || character == "-" else { return false }
        }
        return true
    }

    /// Decode one `WKScriptMessage` body.
    ///
    /// Total on the failure side: every rejection names itself, because the page
    /// author sees nothing else. A body carrying a `pluginId` is not an error —
    /// the field is simply never read, which is what "there is no field to
    /// ignore" means in practice.
    static func decode(body: Any) throws -> PluginPageBridgeRequest {
        guard let object = body as? [String: Any] else {
            throw PluginPageBridgeDecodeError.malformedBody
        }
        guard let id = (object["id"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty else {
            throw PluginPageBridgeDecodeError.missingRequestId
        }
        guard let rawMethod = object["method"] as? String else {
            throw PluginPageBridgeDecodeError.unknownMethod("")
        }
        guard let method = PluginPageBridgeMethod(rawValue: rawMethod) else {
            throw PluginPageBridgeDecodeError.unknownMethod(rawMethod)
        }
        // A missing version reads as v1, not as an error: the number exists so a
        // page can feature-detect the HOST, never so the host can refuse a page.
        let bridgeVersion = (object["bridgeVersion"] as? Int) ?? 1
        let params = (object["params"] as? [String: Any]).map { raw in
            raw.mapValues { PluginPageJSON.from($0) }
        } ?? [:]
        return PluginPageBridgeRequest(id: id, bridgeVersion: bridgeVersion, method: method, params: params)
    }
}

/// The URL a guest loads for one of the plugin's files.
///
/// The context rides as a query parameter, which the host reads at attach and
/// the scheme handler ignores when it resolves the path.
enum PluginPageURLBuilder {
    static func origin(pluginId: String) -> String {
        "\(pluginPageScheme)://\(pluginId)"
    }

    /// Nil when the plugin id is not one this build will serve — the same
    /// refusal the scheme handler makes, moved to the moment the URL is built so
    /// a bad id never becomes a live origin.
    static func url(pluginId: String, path: String, context: PluginPageContext?) -> URL? {
        guard PluginPageBridgeDecoder.isValidPluginPageId(pluginId) else { return nil }
        let trimmed = path.drop(while: { $0 == "/" })
        var components = URLComponents()
        components.scheme = pluginPageScheme
        components.host = pluginId
        components.path = "/" + trimmed
        if let encoded = encodeContext(context) {
            components.queryItems = [URLQueryItem(name: pluginPageContextQueryParam, value: encoded)]
        }
        return components.url
    }

    /// The context as one opaque query token, or nil when it will not fit.
    ///
    /// Over the ceiling, or unencodable, yields nil and the caller loads the page
    /// with no context — half a subject is worse than none, because a page
    /// cannot tell the difference between a field the host omitted and a field
    /// the host truncated away.
    static func encodeContext(_ context: PluginPageContext?) -> String? {
        guard let context else { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(context) else { return nil }
        guard data.count <= pluginPageContextMaxBytes else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// The host's own read of the context it encoded, taken from the URL at
    /// attach — before the page runs — and stored on the host's guest record.
    static func decodeContext(from url: URL) -> PluginPageContext? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        guard let raw = components.queryItems?.first(where: { $0.name == pluginPageContextQueryParam })?.value else {
            return nil
        }
        guard let data = raw.data(using: .utf8), data.count <= pluginPageContextMaxBytes else { return nil }
        return try? JSONDecoder().decode(PluginPageContext.self, from: data)
    }
}
