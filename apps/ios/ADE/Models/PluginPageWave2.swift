import Foundation

/// The wire shapes wave 2 added to the plugin page tier on the phone.
///
/// Kept apart from `PluginPageBridge.swift` for the same reason that file is
/// kept apart from the views: every rule below is a CONTRACT with the desktop,
/// and a contract that can only be exercised through WebKit is a contract
/// nothing tests. `PluginPageWave2Tests` asserts each shape here directly.
///
/// The five picker answers, the socket item, the chat header and the error
/// report are all mirrors of `apps/desktop/src/shared/plugins/webviewBridge.ts`.
/// A field spelled differently here is a value that survives the wire and then
/// vanishes on the next read, which is the failure a round trip is least likely
/// to show — so each one names its desktop twin.

// MARK: - The host pickers

/// The five choices a page may ask ADE's own UI to make for it.
///
/// A closed list because it is the permission model, exactly like the bridge's
/// method table: a page asks for one of these five and gets the phone's own
/// picker, or an honest refusal. There is no generic "open a picker" verb a
/// plugin could point at something ADE does not draw.
enum PluginPagePickerKind: String, Equatable, CaseIterable {
    case model
    case lane
    case permissionMode
    case reasoningEffort
    case provider
}

/// One picker request, as the host receives it.
///
/// `Identifiable` on a per-request token rather than on the kind, so two asks
/// for the same picker present twice instead of being folded into one by
/// SwiftUI's item-sheet identity.
///
/// The argument names mirror the desktop's five signatures exactly:
/// `pickModel({value?, availableModelIds?})`, `pickLane({value?})`,
/// `pickPermissionMode({provider, value?})`,
/// `pickReasoningEffort({model, value?})`, `pickProvider({value?})`.
struct PluginPagePickerRequest: Identifiable, Equatable {
    var id: String = UUID().uuidString
    var kind: PluginPagePickerKind
    /// The row to preselect. A page reopening its own launch form passes back
    /// what it already holds, so the picker opens on the reader's last choice
    /// rather than at the top of the list.
    var value: String?
    /// `pickModel` only: narrows the catalogue to what this page can launch.
    /// Nil means ADE's whole catalogue, which is not the same as an empty list.
    var availableModelIds: [String]?
    /// `pickPermissionMode` only, and REQUIRED there: the modes are a provider
    /// fact, and a picker with no provider has no list.
    var provider: String?
    /// `pickReasoningEffort` only, and REQUIRED there: the ladder is per model.
    var model: String?
}

/// What the page hears back, in the SHAPE the desktop answers with.
///
/// `nil` — no answer at all — is the dismissal, and it is a resolved promise
/// carrying null. A refusal is an error instead: "this phone cannot ask that"
/// and "the reader closed the sheet" are different facts, and a page that could
/// not tell them apart would draw a cleared selection for a picker it never
/// managed to open.
enum PluginPagePickerAnswer: Equatable {
    /// `PluginWebviewModelChoice`. The id AND the fast-mode flag, because ADE's
    /// own picker sets both in one gesture — a model row with a fast tier is
    /// chosen fast or standard — and a page receiving only the id would
    /// silently drop half of what the reader did. False for a model with no
    /// fast tier.
    case model(modelId: String, fastMode: Bool)
    /// `PluginWebviewLaneChoice`. `name` is REQUIRED, so a page need not read
    /// the lane collection back just to draw what the reader picked.
    case lane(laneId: String, name: String)
    /// `PluginWebviewPermissionModeChoice`. The triple travels together: `value`
    /// is the NATIVE mode (`acceptEdits`, `auto-high`), and `field` is the
    /// launch argument it belongs in. A page holding its own provider→field
    /// table is holding the table that goes stale when a sixth provider
    /// arrives.
    case permissionMode(provider: String, field: String, value: String)
    /// `PluginWebviewReasoningEffortChoice`. `effort` nil is a REAL answer —
    /// "no reasoning" — and is not the same as the whole answer being null,
    /// which is the reader dismissing the picker.
    case reasoningEffort(modelId: String, effort: String?)
    /// `PluginWebviewProviderChoice`. A model-registry family.
    case provider(String)

    /// The dictionary the page receives. Matches the desktop field for field.
    var jsonValue: [String: Any] {
        switch self {
        case .model(let modelId, let fastMode):
            return ["modelId": modelId, "fastMode": fastMode]
        case .lane(let laneId, let name):
            return ["laneId": laneId, "name": name]
        case .permissionMode(let provider, let field, let value):
            return ["provider": provider, "field": field, "value": value]
        case .reasoningEffort(let modelId, let effort):
            // `NSNull` rather than an absent key: "this model runs without
            // reasoning" is a choice the reader made, and a missing `effort`
            // would read as a host too old to answer it.
            return ["modelId": modelId, "effort": effort ?? NSNull()]
        case .provider(let provider):
            return ["provider": provider]
        }
    }
}

// MARK: - Third-party sockets, as a page draws them

/// One socket contribution a page may draw and press.
///
/// The answer to `sockets.list({socket})`, which is how a page ports a surface
/// that used to be ADE's own: the Work rail's plugin buttons, a chat header's
/// plugin entries. `socketId` is the handle `sockets.invoke` takes, and it is
/// the ONLY handle — a page cannot name a plugin and an action directly, which
/// is what keeps `sockets.invoke` scoped to what `sockets.list` showed it.
struct PluginPageSocketItem: Equatable {
    var socketId: String
    var pluginId: String
    /// The socket KIND, as the manifest spells it (`toolbar-action`, …).
    var socket: String
    var label: String
    var icon: String?
    /// The contribution's own payload, as this build parsed it.
    ///
    /// Rebuilt from the typed payload rather than passed through raw, because
    /// the phone only holds contributions it could parse in the first place —
    /// `PluginContributionParser` drops a row whose payload does not match its
    /// kind, so there is no un-parsed row here to hand on.
    var payload: [String: PluginPageJSON]

    /// The action a press runs, when the payload names one.
    var actionId: String? {
        payload["actionId"]?.stringValue
    }

    var jsonValue: [String: Any] {
        var encoded: [String: Any] = [
            "socketId": socketId,
            "pluginId": pluginId,
            "socket": socket,
            "label": label,
            "payload": payload.compactMapValues(\.foundationValue),
        ]
        if let icon, !icon.isEmpty { encoded["icon"] = icon }
        return encoded
    }

    /// One mirrored contribution, as a page sees it.
    ///
    /// The payload is rebuilt from the TYPED payload rather than carried raw,
    /// and the fields it names are exactly the ones this build parsed — so a
    /// page reads the same values a native ADE row draws, and no more. A
    /// contribution whose kind carries nothing a page could press or label
    /// still appears: a page listing a socket kind is drawing a rail, and a
    /// silently missing row is worse than one with an empty payload.
    init(contribution: PluginContribution) {
        socketId = contribution.socketId
        pluginId = contribution.pluginId
        socket = contribution.socketRaw
        var fields: [String: PluginPageJSON] = [:]
        var resolvedLabel = ""
        var resolvedIcon: String?

        func put(_ key: String, _ value: String?) {
            guard let value, !value.isEmpty else { return }
            fields[key] = .string(value)
        }

        switch contribution.payload {
        case .toolbarAction(let payload), .composerAction(let payload), .chatHeaderAction(let payload):
            resolvedLabel = payload.label
            resolvedIcon = payload.icon
            put("label", payload.label)
            put("icon", payload.icon)
            put("actionId", payload.actionId)
            put("color", payload.color)
            fields["disabled"] = .bool(payload.disabled)
            fields["ownsSend"] = .bool(payload.ownsSend)
        case .rowBadge(let payload):
            resolvedLabel = payload.text
            resolvedIcon = payload.icon
            put("text", payload.text)
            put("tone", payload.tone.rawValue)
            put("icon", payload.icon)
            put("tooltip", payload.tooltip)
        case .rowMenuItem(let payload):
            resolvedLabel = payload.label
            resolvedIcon = payload.icon
            put("label", payload.label)
            put("icon", payload.icon)
            put("actionId", payload.actionId)
            fields["danger"] = .bool(payload.danger)
        case .detailSection(let payload):
            resolvedLabel = payload.title ?? payload.panelId
            put("title", payload.title)
            put("panelId", payload.panelId)
        case .emptyState(let payload):
            resolvedLabel = payload.title
            put("title", payload.title)
            put("body", payload.body)
            put("actionId", payload.actionId)
            put("actionLabel", payload.actionLabel)
        case .filterChip(let payload):
            resolvedLabel = payload.label
            put("label", payload.label)
            put("filterKey", payload.filterKey)
            if let count = payload.count { fields["count"] = .number(Double(count)) }
        case .fileViewer(let payload):
            resolvedLabel = payload.panelId
            put("panelId", payload.panelId)
            fields["extensions"] = .array(payload.extensions.map { .string($0) })
        case .chatCard(let payload):
            resolvedLabel = payload.title ?? payload.panelId
            resolvedIcon = payload.icon
            put("title", payload.title)
            put("panelId", payload.panelId)
            put("icon", payload.icon)
        case .activityEntry(let payload):
            resolvedLabel = payload.title
            put("title", payload.title)
            put("body", payload.body)
            put("tone", payload.tone.rawValue)
            put("actionId", payload.actionId)
            put("actionLabel", payload.actionLabel)
        }

        // A row that named itself nothing is drawn under its socket id rather
        // than as a blank button: the reader can still tell two of them apart,
        // and a page cannot end up rendering an unpressable empty pill.
        label = resolvedLabel.isEmpty ? contribution.socketId : resolvedLabel
        icon = resolvedIcon
        payload = fields
    }
}

// MARK: - The header a plugin writes onto a chat

/// One chip in a plugin-written chat header.
///
/// `tone` is open on the wire and mapped to the phone's palette at draw time:
/// a tone this build does not know is drawn neutral rather than dropped, which
/// is what lets the desktop add one without blanking a chip on the phone.
struct PluginChatHeaderChip: Codable, Equatable {
    var label: String
    var tone: String?

    init(label: String, tone: String? = nil) {
        self.label = label
        self.tone = tone
    }

    /// Tolerant per field, like every other plugin wire type: a chip that
    /// arrives without a label decodes to an empty one, and
    /// ``PluginChatHeader`` drops it a moment later — one set of rules, in one
    /// place.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        label = ((try? container.decodeIfPresent(String.self, forKey: .label)) ?? nil) ?? ""
        tone = (try? container.decodeIfPresent(String.self, forKey: .tone)) ?? nil
    }
}

/// What `chat.setHeader` wrote onto a chat session.
///
/// NOT a page bridge method: it is a child-SDK write that lands on the session
/// record as `pluginHeader`, so the phone's job is to decode it and draw it
/// wherever it already draws a session header. A header with neither a label
/// nor a chip is `nil` rather than an empty bar — a plugin clearing its header
/// must leave the chat's own title alone.
struct PluginChatHeader: Codable, Equatable {
    var label: String?
    var chips: [PluginChatHeaderChip]

    /// Chips one header may carry before the rest are dropped.
    ///
    /// A header is a line of context, not a payload. Unbounded, one plugin
    /// could push a chat's own title off the bar on every phone in the account.
    static let chipsMax = 6

    init(label: String? = nil, chips: [PluginChatHeaderChip] = []) {
        self.label = label
        self.chips = Array(chips.prefix(Self.chipsMax))
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let rawLabel = ((try? container.decodeIfPresent(String.self, forKey: .label)) ?? nil)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        label = (rawLabel?.isEmpty == false) ? rawLabel : nil
        let rawChips = ((try? container.decodeIfPresent([PluginChatHeaderChip].self, forKey: .chips)) ?? nil) ?? []
        chips = Array(
            rawChips
                .filter { !$0.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
                .prefix(Self.chipsMax)
        )
    }

    /// True when there is genuinely nothing to draw.
    var isEmpty: Bool { label == nil && chips.isEmpty }
}

// MARK: - A page that did not open

/// Why a plugin page is not on screen.
///
/// One sentence, never a WebKit error code: the reader is being told that a
/// plugin's page is broken, and `NSURLErrorDomain -1100` is not that sentence.
/// The code is still carried so a log can say which failure produced it.
struct PluginPageErrorReport: Equatable {
    /// What went wrong, in the words the card shows.
    var message: String
    /// The page's own report (`page.error`), a navigation failure, or the web
    /// content process going away. Diagnostic only.
    var source: Source

    enum Source: String, Equatable {
        /// The guest's own `error`/`unhandledrejection` listener.
        case script
        /// The guest's `securitypolicyviolation` listener.
        case contentPolicy
        /// A `WKNavigationDelegate` failure.
        case navigation
        /// The web content process terminated.
        case terminated
    }

    /// The card's title, on every client. Matches the desktop card's words.
    static let title = "This page didn\u{2019}t open"

    /// Ceiling on a sentence a guest supplied. A page cannot fill ADE's chrome
    /// with its own stack trace.
    static let messageMaxChars = 240

    /// The report a page's own script produced, trimmed to what may be drawn.
    ///
    /// An empty or unusable message becomes the host's own sentence rather than
    /// an empty card: "something happened and we will not say what" is the one
    /// outcome an error card must never produce.
    static func fromPage(message: String?, source: Source) -> PluginPageErrorReport {
        let trimmed = (message ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let sentence = trimmed.isEmpty
            ? "The plugin\u{2019}s page stopped before it finished loading."
            : String(trimmed.prefix(messageMaxChars))
        return PluginPageErrorReport(message: sentence, source: source)
    }
}
