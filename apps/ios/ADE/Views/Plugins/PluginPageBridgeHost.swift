import Foundation
import UIKit

/// The host side of `window.adePlugin` on the phone.
///
/// One object answers every verb a plugin page may call. It is deliberately
/// free of WebKit: a `WKScriptMessageHandlerWithReply` hands it a decoded
/// request and a plugin id, and it hands back a JSON value. That split is what
/// makes the whole method list testable — every verb below is exercised in
/// `PluginPageBridgeTests` against a scripted data source and a recording host,
/// with no webview, no socket and no waiting.
///
/// ## Two collaborators, on purpose
///
/// `PluginPageBridgeDataSource` is where the plugin's DATA comes from: the
/// local mirror for reads, the sync socket for writes and `invoke`.
/// `PluginPageBridgeHosting` is where ADE's own UI is: the sheet that can close
/// itself, the composer, the toast, the pasteboard. They are separate because a
/// read must work with no machine in reach and a UI verb must work with no
/// data, and folding them into one protocol would make both harder to fake.
///
/// ## What a page can never reach
///
/// The plugin id is passed in by the caller, taken from the guest's own frame
/// origin. Nothing in a message body can change it. That is the single rule
/// that keeps one plugin out of another's collections, and it is enforced one
/// level up rather than here so this object has no way to get it wrong.

// MARK: - Collaborators

/// The plugin's data, as the bridge needs it.
protocol PluginPageBridgeDataSource: AnyObject {
    /// Rows from the LOCAL mirror. Never a fetch: a page that scrolls a list
    /// must not stall on a socket, and the mirror is already the phone's primary
    /// read for every other plugin surface.
    func pluginPageCollectionEntries(
        pluginId: String,
        collection: String,
        keyPrefix: String?,
        limit: Int
    ) -> [PluginCollectionEntry]

    /// A plugin action, over the sync socket. The one verb that can do anything.
    func pluginPageInvoke(pluginId: String, actionId: String, args: [String: Any]) async throws -> PluginInvokeResult

    /// A host verb this build knows the name of but the machine may not offer.
    func pluginPageRemoteAction(_ action: String, args: [String: Any]) async throws -> Any

    /// Whether the attached machine advertised an action. False on every host
    /// that predates it, which is what turns "not supported here" into a
    /// sentence the page can feature-detect instead of a hang.
    func pluginPageSupportsRemoteAction(_ action: String) -> Bool
}

/// ADE's own UI, as the bridge needs it.
///
/// Every method is main-actor: each one either presents something or mutates
/// published state a SwiftUI view is reading.
@MainActor
protocol PluginPageBridgeHosting: AnyObject {
    /// Close the popover, sheet or picker this guest is drawn in. A no-op in a
    /// tab, which is why it returns nothing to report.
    func pluginPageCloseSurface()
    func pluginPageComposerAttach(_ attach: PluginPageComposerAttach)
    func pluginPageComposerInsert(_ text: String)
    /// Returns the toast's id, so `ui.dismissToast` has something to name.
    func pluginPageShowToast(_ toast: PluginPageToast) -> String
    func pluginPageDismissToast(id: String)
    /// The host's own prompt UI. Nil when the user dismissed it.
    func pluginPagePrompt(_ prompt: PluginActionPrompt) async -> String?
    func pluginPageConfirm(_ confirm: PluginPageConfirm) async -> Bool
    func pluginPageOpenSettings(entryId: String?, socketId: String?)
    /// Apply the control-flow half of an `invoke` answer, exactly as a socket
    /// press applies it. See `PluginPageBridge.invoke`.
    func pluginPageApply(_ result: PluginInvokeResult, pluginId: String) async
    func pluginPageOpenDeeplink(_ url: URL)
    func pluginPageTheme() -> PluginPageThemeSnapshot
}

// MARK: - Verb payloads

/// The payload the socket `{composer}` answer already carries.
struct PluginPageComposerAttach: Equatable {
    var provider: String
    var issueId: String
    var identifier: String
    var title: String
    var url: String?
}

struct PluginPageToast: Equatable {
    enum Level: String, Equatable, CaseIterable {
        case info, success, warning, error
    }

    var level: Level
    var message: String
    var actionLabel: String?
    var actionId: String?

    /// Ceilings from `PLUGIN_WEBVIEW_TOAST_MESSAGE_MAX_CHARS` and its label
    /// sibling. A toast is a sentence, not a payload: an uncapped one is a page
    /// drawing over the app's own UI.
    static let messageMaxChars = 240
    static let labelMaxChars = 32
}

struct PluginPageConfirm: Equatable {
    var title: String
    var body: String
    var confirmLabel: String
    var destructive: Bool

    static let titleMaxChars = 120
    static let bodyMaxChars = 600
}

/// The theme a page paints itself with.
///
/// `tokens` are the `--ade-*` custom properties with their leading dashes
/// intact, so a page writes them straight onto its own `:root` and matches ADE
/// without knowing the palette.
struct PluginPageThemeSnapshot: Equatable {
    var scheme: String
    var tokens: [String: String]

    var jsonValue: [String: Any] { ["scheme": scheme, "tokens": tokens] }
}

// MARK: - Errors

struct PluginPageBridgeError: Error, Equatable {
    var code: String
    var message: String

    static func invalidParams(_ message: String) -> PluginPageBridgeError {
        PluginPageBridgeError(code: "invalid_params", message: message)
    }

    /// The machine does not offer the host action this verb needs.
    ///
    /// A named code rather than a generic failure because a page is expected to
    /// degrade on it: an older brain simply cannot write a plugin's config, and
    /// a form that greys out its save button is a better answer than one that
    /// throws every time it is pressed.
    static func unsupported(_ action: String) -> PluginPageBridgeError {
        PluginPageBridgeError(
            code: "unsupported",
            message: "This computer does not support \"\(action)\" yet."
        )
    }

    static func failed(_ message: String) -> PluginPageBridgeError {
        PluginPageBridgeError(code: "failed", message: message)
    }
}

// MARK: - The bridge

@MainActor
final class PluginPageBridge {
    /// The remote action names the host verbs that are not reads map onto.
    ///
    /// Named here rather than inlined so the "does this machine offer it" gate
    /// and the call itself can never disagree. A machine that predates one of
    /// these answers `unsupported`, and the page degrades.
    enum RemoteAction {
        static let putCollection = "plugins.putCollection"
        static let getConfig = "plugins.getConfig"
        static let setConfig = "plugins.setConfig"
    }

    /// `PLUGIN_WEBVIEW_LIST_MAX_ROWS`. A page that wants more paginates.
    static let listMaxRows = 500

    private let dataSource: PluginPageBridgeDataSource
    private weak var host: PluginPageBridgeHosting?
    private let pasteboard: () -> UIPasteboard

    /// The host-event kinds this guest asked for. Empty until `host.subscribe`,
    /// so a page that never subscribes is never woken.
    private(set) var subscribedHostKinds: Set<PluginPageHostKind> = []

    init(
        dataSource: PluginPageBridgeDataSource,
        host: PluginPageBridgeHosting?,
        pasteboard: @escaping () -> UIPasteboard = { UIPasteboard.general }
    ) {
        self.dataSource = dataSource
        self.host = host
        self.pasteboard = pasteboard
    }

    /// Answer one call.
    ///
    /// - Parameter pluginId: taken from the guest's frame origin by the caller.
    ///   NEVER from `request`.
    func handle(_ request: PluginPageBridgeRequest, pluginId: String) async throws -> Any? {
        switch request.method {
        case .collectionsGet: return try collectionsGet(request, pluginId: pluginId)
        case .collectionsList: return try collectionsList(request, pluginId: pluginId)
        case .collectionsPut: return try await collectionsPut(request, pluginId: pluginId)
        case .configGet: return try await configGet(request, pluginId: pluginId)
        case .configSet: return try await configSet(request, pluginId: pluginId)
        case .invoke: return try await invoke(request, pluginId: pluginId)
        case .openDeeplink: return try openDeeplink(request)
        case .openSettings: return openSettings(request)
        case .surfaceClose:
            host?.pluginPageCloseSurface()
            return nil
        case .composerAttach: return try composerAttach(request)
        case .composerInsert: return try composerInsert(request)
        case .uiToast: return try showToast(request)
        case .uiDismissToast: return try dismissToast(request)
        case .uiPrompt: return await prompt(request)
        case .uiConfirm: return try await confirm(request)
        case .clipboardRead: return pasteboard().string ?? ""
        case .clipboardWrite: return try clipboardWrite(request)
        case .themeGet: return host?.pluginPageTheme().jsonValue ?? PluginPageThemeSnapshot(scheme: "dark", tokens: [:]).jsonValue
        case .hostSubscribe: return hostSubscribe(request)
        case .hostUnsubscribe: return hostUnsubscribe(request)
        }
    }

    // MARK: Collections

    private func collectionsGet(_ request: PluginPageBridgeRequest, pluginId: String) throws -> Any? {
        let collection = try string(request, "collection")
        let key = try string(request, "key")
        // Keyed by exact match rather than prefix: `collections.get` answers for
        // one row, and a prefix read would return `settings` for `setting`.
        let rows = dataSource.pluginPageCollectionEntries(
            pluginId: pluginId,
            collection: collection,
            keyPrefix: key,
            limit: Self.listMaxRows
        )
        guard let row = rows.first(where: { $0.key == key }) else { return nil }
        return row.value
    }

    private func collectionsList(_ request: PluginPageBridgeRequest, pluginId: String) throws -> Any? {
        let collection = try string(request, "collection")
        let keyPrefix = request.params["keyPrefix"]?.stringValue
        let requested = intValue(request.params["limit"]) ?? Self.listMaxRows
        let limit = max(1, min(requested, Self.listMaxRows))
        let rows = dataSource.pluginPageCollectionEntries(
            pluginId: pluginId,
            collection: collection,
            keyPrefix: keyPrefix,
            limit: limit
        )
        return rows.map { row -> [String: Any] in
            var encoded: [String: Any] = ["key": row.key, "updatedAt": row.updatedAt]
            if let value = row.value { encoded["value"] = value }
            return encoded
        }
    }

    private func collectionsPut(_ request: PluginPageBridgeRequest, pluginId: String) async throws -> Any? {
        let collection = try string(request, "collection")
        let key = try string(request, "key")
        let value = request.params["value"]?.foundationValue
        guard dataSource.pluginPageSupportsRemoteAction(RemoteAction.putCollection) else {
            throw PluginPageBridgeError.unsupported(RemoteAction.putCollection)
        }
        var args: [String: Any] = ["pluginId": pluginId, "collection": collection, "key": key]
        if let value { args["value"] = value }
        _ = try await dataSource.pluginPageRemoteAction(RemoteAction.putCollection, args: args)
        return nil
    }

    // MARK: Config

    private func configGet(_ request: PluginPageBridgeRequest, pluginId: String) async throws -> Any? {
        let key = try string(request, "key")
        guard dataSource.pluginPageSupportsRemoteAction(RemoteAction.getConfig) else {
            throw PluginPageBridgeError.unsupported(RemoteAction.getConfig)
        }
        let raw = try await dataSource.pluginPageRemoteAction(
            RemoteAction.getConfig,
            args: ["pluginId": pluginId, "key": key]
        )
        if let object = raw as? [String: Any], let value = object["value"] { return value }
        return raw
    }

    private func configSet(_ request: PluginPageBridgeRequest, pluginId: String) async throws -> Any? {
        let key = try string(request, "key")
        let value = request.params["value"]?.foundationValue
        guard dataSource.pluginPageSupportsRemoteAction(RemoteAction.setConfig) else {
            throw PluginPageBridgeError.unsupported(RemoteAction.setConfig)
        }
        var args: [String: Any] = ["pluginId": pluginId, "key": key]
        if let value { args["value"] = value }
        _ = try await dataSource.pluginPageRemoteAction(RemoteAction.setConfig, args: args)
        return nil
    }

    // MARK: Invoke

    /// A plugin action, and the control-flow answer it may come back with.
    ///
    /// This is the verb the desktop bridge got wrong first: it returned the raw
    /// result and the renderer ignored `navigate`, `openUrl` and the rest, so a
    /// page could not do anything a socket press could. Here the answer is
    /// applied by the host — the same six behaviours a socket press applies on
    /// this phone today — and the page is told what happened so it can stop
    /// drawing a spinner.
    private func invoke(_ request: PluginPageBridgeRequest, pluginId: String) async throws -> Any? {
        let actionId = try string(request, "actionId")
        let args = request.params["args"]?.foundationValue as? [String: Any] ?? [:]
        let result: PluginInvokeResult
        do {
            result = try await dataSource.pluginPageInvoke(pluginId: pluginId, actionId: actionId, args: args)
        } catch {
            throw PluginPageBridgeError.failed(error.localizedDescription)
        }
        await host?.pluginPageApply(result, pluginId: pluginId)

        var encoded: [String: Any] = ["ok": result.ok]
        if let message = result.message { encoded["message"] = message }
        if result.navigate != nil { encoded["navigated"] = true }
        if result.openURL != nil { encoded["openedUrl"] = true }
        if result.openSettings != nil || result.openSettingsSectionId != nil { encoded["openedSettings"] = true }
        if result.prompt != nil { encoded["prompted"] = true }
        if result.authSession != nil { encoded["authSession"] = true }
        if let composer = result.composer {
            switch composer {
            case .insert(let text): encoded["composer"] = ["insert": text]
            case .replace(let text): encoded["composer"] = ["replace": text]
            }
        }
        return encoded
    }

    // MARK: Navigation and settings

    private func openDeeplink(_ request: PluginPageBridgeRequest) throws -> Any? {
        let raw = try string(request, "url")
        guard let url = URL(string: raw) else {
            throw PluginPageBridgeError.invalidParams("openDeeplink requires a URL.")
        }
        // `ade:` is ours to route; `https:` opens outside. Everything else is
        // refused, because a page naming `tel:` or a third-party app's scheme is
        // reaching past ADE at the operating system.
        let scheme = url.scheme?.lowercased()
        guard scheme == "ade" || scheme == "https" else {
            throw PluginPageBridgeError.invalidParams("openDeeplink accepts only ade: and https: URLs.")
        }
        host?.pluginPageOpenDeeplink(url)
        return nil
    }

    private func openSettings(_ request: PluginPageBridgeRequest) -> Any? {
        let entryId = request.params["entryId"]?.stringValue
        let socketId = request.params["socketId"]?.stringValue
        host?.pluginPageOpenSettings(entryId: entryId, socketId: socketId)
        return nil
    }

    // MARK: Composer

    private func composerAttach(_ request: PluginPageBridgeRequest) throws -> Any? {
        let attach = PluginPageComposerAttach(
            provider: try string(request, "provider"),
            issueId: try string(request, "issueId"),
            identifier: try string(request, "identifier"),
            title: try string(request, "title"),
            url: request.params["url"]?.stringValue
        )
        host?.pluginPageComposerAttach(attach)
        return nil
    }

    private func composerInsert(_ request: PluginPageBridgeRequest) throws -> Any? {
        let text = try string(request, "text")
        // The same ceiling `PluginInvokeComposerEdit` applies to a socket
        // answer. A page has no more right to fill the composer than an action.
        guard text.utf8.count <= 32 * 1024 else {
            throw PluginPageBridgeError.invalidParams("composer.insert text is too long.")
        }
        host?.pluginPageComposerInsert(text)
        return nil
    }

    // MARK: UI

    private func showToast(_ request: PluginPageBridgeRequest) throws -> Any? {
        let message = try string(request, "message")
        let rawLevel = request.params["level"]?.stringValue ?? PluginPageToast.Level.info.rawValue
        guard let level = PluginPageToast.Level(rawValue: rawLevel) else {
            throw PluginPageBridgeError.invalidParams("ui.toast level must be info, success, warning or error.")
        }
        let toast = PluginPageToast(
            level: level,
            message: String(message.prefix(PluginPageToast.messageMaxChars)),
            actionLabel: request.params["actionLabel"]?.stringValue.map { String($0.prefix(PluginPageToast.labelMaxChars)) },
            actionId: request.params["actionId"]?.stringValue
        )
        guard let id = host?.pluginPageShowToast(toast) else { return nil }
        return ["id": id]
    }

    private func dismissToast(_ request: PluginPageBridgeRequest) throws -> Any? {
        let id = try string(request, "id")
        host?.pluginPageDismissToast(id: id)
        return nil
    }

    private func prompt(_ request: PluginPageBridgeRequest) async -> Any? {
        // Decoded through the SAME `PluginActionPrompt` a socket answer carries,
        // so a page's prompt and an action's prompt are the same UI with the
        // same option rules. A shape this build cannot read yields nil, which
        // the page reads as "the user did not answer".
        guard let data = try? JSONSerialization.data(withJSONObject: request.params.compactMapValues(\.foundationValue)),
              let decoded = try? JSONDecoder().decode(PluginActionPrompt.self, from: data),
              let host
        else { return nil }
        guard let answer = await host.pluginPagePrompt(decoded) else { return nil }
        return ["id": decoded.id, "text": answer]
    }

    private func confirm(_ request: PluginPageBridgeRequest) async throws -> Any? {
        let title = try string(request, "title")
        let body = request.params["body"]?.stringValue ?? ""
        let confirm = PluginPageConfirm(
            title: String(title.prefix(PluginPageConfirm.titleMaxChars)),
            body: String(body.prefix(PluginPageConfirm.bodyMaxChars)),
            confirmLabel: request.params["confirmLabel"]?.stringValue ?? "Confirm",
            destructive: request.params["destructive"]?.boolValue ?? false
        )
        guard let host else { return false }
        return await host.pluginPageConfirm(confirm)
    }

    private func clipboardWrite(_ request: PluginPageBridgeRequest) throws -> Any? {
        let text = try string(request, "text")
        pasteboard().string = text
        return nil
    }

    // MARK: Host events

    private func hostSubscribe(_ request: PluginPageBridgeRequest) -> Any? {
        let kinds = (request.params["kinds"]?.arrayValue ?? [])
            .compactMap { $0.stringValue }
            .compactMap { PluginPageHostKind(rawValue: $0) }
        subscribedHostKinds.formUnion(kinds)
        return ["kinds": subscribedHostKinds.map(\.rawValue).sorted()]
    }

    private func hostUnsubscribe(_ request: PluginPageBridgeRequest) -> Any? {
        let kinds = (request.params["kinds"]?.arrayValue ?? [])
            .compactMap { $0.stringValue }
            .compactMap { PluginPageHostKind(rawValue: $0) }
        // No kinds named means "everything", which is what an unsubscribe with
        // no arguments has to mean for a page tearing itself down.
        if kinds.isEmpty {
            subscribedHostKinds.removeAll()
        } else {
            subscribedHostKinds.subtract(kinds)
        }
        return ["kinds": subscribedHostKinds.map(\.rawValue).sorted()]
    }

    // MARK: Parameter reading

    private func string(_ request: PluginPageBridgeRequest, _ key: String) throws -> String {
        guard let value = request.params[key]?.stringValue, !value.isEmpty else {
            throw PluginPageBridgeError.invalidParams("\(request.method.rawValue) requires \"\(key)\".")
        }
        return value
    }

    private func intValue(_ json: PluginPageJSON?) -> Int? {
        guard case .number(let value) = json else { return nil }
        return Int(value)
    }
}
