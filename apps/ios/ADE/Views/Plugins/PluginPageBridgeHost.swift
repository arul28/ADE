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
    /// Hand a `dialog-picker` guest's chosen issue to the dialog drawing it.
    ///
    /// Returns whether it landed. `false` is the honest report of a form that
    /// cannot take it right now, and the page hears it as a rejected promise
    /// rather than a silent success it would draw as "selected".
    func pluginPageDialogSubmit(_ answer: PluginPageDialogSubmit) -> Bool
    /// This page's own content height, already clamped. A placement that is not
    /// sized to content ignores it.
    func pluginPageResize(height: Int)
}

/// Defaults for the two verbs a surface may legitimately have no answer for.
///
/// A no-op default rather than a required method: only a dialog picker can
/// answer a dialog, and only a size-to-content placement has a height to apply,
/// so every other host would be writing an empty body. The BRIDGE still refuses
/// `dialog.submit` outside `dialog-picker` before it ever reaches a host, so a
/// default that silently returns false is not how the rule is enforced.
extension PluginPageBridgeHosting {
    func pluginPageDialogSubmit(_ answer: PluginPageDialogSubmit) -> Bool { false }
    func pluginPageResize(height: Int) {}
}

/// The answer a page drawn as a `dialog-picker` gives its dialog.
///
/// The SAME issue `PluginPageComposerAttach` carries, deliberately: a page that
/// can fill the composer's chip already builds this record. `issue: nil` is a
/// real answer — the reader cleared the selection — which a dialog must be able
/// to hear or a chosen issue could never be undone from inside the page.
struct PluginPageDialogSubmit: Equatable {
    var issue: IssueRef?
}

// MARK: - Verb payloads

/// One issue a page asked the composer to attach.
///
/// The model is an `IssueRef` — the provider-neutral link ADE stores for every
/// tracker — and not the five loose strings the bridge table lists. The strings
/// are still what a page may send; they are the smallest ref anyone can write,
/// and they are read INTO a ref here so the composer receives one model whether
/// the page sent the short form or a whole ref it already had.
///
/// That matters because of where this ends up. The phone's composer attaches an
/// issue by writing ADE's own session issue link — the same row the Linear
/// attach row writes — and that row is a full legacy Linear projection with the
/// ref embedded beside it (`__issueRef`, `shared/issueRef.ts`). Five strings
/// cannot fill it: the host's parser REQUIRES ten non-empty fields and silently
/// drops an issue that is missing one, which is a chip that never appears with
/// nothing anywhere saying why. {@link laneIssue} fills all ten from the ref,
/// exactly as `issueRefToLinearIssue` does on the machine.
struct PluginPageComposerAttach: Equatable {
    /// The link itself. `pluginId` is the calling page's, stamped by the bridge.
    var issue: IssueRef

    var provider: String { issue.provider }
    var issueId: String { issue.issueId }
    /// The human key — `ADE-123`, `owner/repo#42`. `identifier` is the phone's
    /// existing name for it, kept so composer code reads the same either way.
    var identifier: String { issue.key }
    var title: String { issue.title }
    var url: String? { issue.url }

    /// The row the phone sends to `lane.attachLinearIssueToSession`.
    ///
    /// The Swift twin of `issueRefToStoredLinearIssue`: the legacy projection
    /// with the ref embedded under its reserved key. Every one of the ten fields
    /// the host's parser requires is filled, including for a tracker that has no
    /// such concept — a Jira issue borrows its provider name as the team key.
    /// The mislabel on a build that predates `IssueRef` is the documented price
    /// of never altering a replicated table; a dropped row would not be.
    ///
    /// `branchName` is deliberately absent: the host derives and rewrites it on
    /// every attach (`finalizeLaneLinearIssue`), so a value invented here would
    /// be overwritten, and inventing one that differs would be the phone
    /// disagreeing with the machine about a branch it does not name.
    var laneIssue: LaneLinearIssue {
        let containerKey = trimmedOrNil(issue.container?.key) ?? issue.provider.uppercased()
        let category = issue.state?.category.rawValue
        let stamp = trimmedOrNil(issue.updatedAt)
            ?? trimmedOrNil(issue.createdAt)
            ?? ISO8601DateFormatter().string(from: Date())
        let extra = issue.extra ?? [:]
        return LaneLinearIssue(
            id: issue.issueId,
            identifier: issue.key,
            title: issue.title,
            description: issue.description,
            url: issue.url,
            projectId: extraString(extra["projectId"]) ?? "",
            projectSlug: extraString(extra["projectSlug"]) ?? "",
            projectName: extraString(extra["projectName"]),
            teamId: trimmedOrNil(issue.container?.id) ?? containerKey,
            teamKey: containerKey,
            teamName: issue.container?.name,
            stateId: trimmedOrNil(issue.state?.id) ?? category ?? "unstarted",
            stateName: trimmedOrNil(issue.state?.name) ?? category ?? "unstarted",
            stateType: category ?? "unstarted",
            priority: Int(issue.priority?.rank ?? 0),
            priorityLabel: Self.priorityLabel(issue.priority?.label),
            labels: issue.labels,
            assigneeId: issue.assignee?.id,
            assigneeName: issue.assignee?.name,
            creatorId: extraString(extra["creatorId"]),
            creatorName: extraString(extra["creatorName"]),
            dueDate: extraString(extra["dueDate"]),
            estimate: extraNumber(extra["estimate"]),
            createdAt: trimmedOrNil(issue.createdAt) ?? stamp,
            updatedAt: trimmedOrNil(issue.updatedAt) ?? stamp,
            __issueRef: Self.issueRefJSON(issue)
        )
    }

    /// The five labels `parseLaneLinearIssueValue` accepts. Anything else is
    /// `none` rather than a rejected row, matching `linearPriorityLabel`.
    private static func priorityLabel(_ raw: String?) -> String {
        let value = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        return ["urgent", "high", "normal", "low", "none"].contains(value) ? value : "none"
    }

    /// The ref as JSON, under the same keys `parseIssueRefValue` reads.
    ///
    /// The inverse of that parser and written beside it in spirit: a key spelled
    /// differently here is a field that survives the wire and then vanishes on
    /// the next read, which is the failure a round trip is least likely to show.
    /// Absent keys are omitted rather than sent as null — the parser reads them
    /// the same, and the row is replicated to every peer.
    static func issueRefJSON(_ ref: IssueRef) -> RemoteJSONValue {
        var object: [String: RemoteJSONValue] = [
            "pluginId": .string(ref.pluginId),
            "provider": .string(ref.provider),
            "issueId": .string(ref.issueId),
            "key": .string(ref.key),
            "title": .string(ref.title),
        ]
        if let url = ref.url { object["url"] = .string(url) }
        if let state = ref.state {
            var encoded: [String: RemoteJSONValue] = ["category": .string(state.category.rawValue)]
            if let id = state.id { encoded["id"] = .string(id) }
            if let name = state.name { encoded["name"] = .string(name) }
            object["state"] = .object(encoded)
        }
        if let container = ref.container {
            var encoded: [String: RemoteJSONValue] = [:]
            if let id = container.id { encoded["id"] = .string(id) }
            if let key = container.key { encoded["key"] = .string(key) }
            if let name = container.name { encoded["name"] = .string(name) }
            if !encoded.isEmpty { object["container"] = .object(encoded) }
        }
        if let branchName = ref.branchName { object["branchName"] = .string(branchName) }
        if let assignee = ref.assignee {
            var encoded: [String: RemoteJSONValue] = [:]
            if let id = assignee.id { encoded["id"] = .string(id) }
            if let name = assignee.name { encoded["name"] = .string(name) }
            if !encoded.isEmpty { object["assignee"] = .object(encoded) }
        }
        if let priority = ref.priority {
            var encoded: [String: RemoteJSONValue] = [:]
            if let rank = priority.rank { encoded["rank"] = .number(rank) }
            if let label = priority.label { encoded["label"] = .string(label) }
            if !encoded.isEmpty { object["priority"] = .object(encoded) }
        }
        if !ref.labels.isEmpty { object["labels"] = .array(ref.labels.map { .string($0) }) }
        if let description = ref.description { object["description"] = .string(description) }
        if let createdAt = ref.createdAt { object["createdAt"] = .string(createdAt) }
        if let updatedAt = ref.updatedAt { object["updatedAt"] = .string(updatedAt) }
        // Held opaque, exactly as the parser hands it over: a tracker's own
        // residue is the plugin's to read, and rewriting it here would be this
        // phone deciding what another tracker's fields mean.
        if let extra = ref.extra, !extra.isEmpty { object["extra"] = .object(extra) }
        return .object(object)
    }

    private func trimmedOrNil(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return trimmed
    }

    private func extraString(_ value: RemoteJSONValue?) -> String? {
        guard case .string(let raw)? = value else { return nil }
        return raw
    }

    private func extraNumber(_ value: RemoteJSONValue?) -> Double? {
        guard case .number(let raw)? = value, raw.isFinite else { return nil }
        return raw
    }
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

    /// The verb exists and this guest may not use it HERE.
    ///
    /// Its own code rather than a generic failure, and the same word the
    /// desktop relay answers with: "not in this placement" is a permanent fact
    /// about where the page is drawn, not something a retry could change.
    static func notPermitted(_ message: String) -> PluginPageBridgeError {
        PluginPageBridgeError(code: "not_permitted", message: message)
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

    /// Told whenever the subscribed set changes, with what was added and what
    /// was dropped.
    ///
    /// The producer needs BOTH halves, not the resulting set: a kind that was
    /// just added has to have its baseline taken without emitting — a page that
    /// has only just subscribed must not immediately hear that every lane
    /// changed — and a kind that was dropped has to have its snapshot released.
    /// Handing over the set alone would leave the producer diffing the two
    /// itself, which is the same bookkeeping twice.
    var onHostSubscriptionChange: ((_ added: Set<PluginPageHostKind>, _ removed: Set<PluginPageHostKind>) -> Void)?

    /// Where the host drew this guest.
    ///
    /// The HOST's own word, captured from the context it encoded into the
    /// source URL, never the page's claim — it is what `dialog.submit` is gated
    /// on, and a page that could name its own placement could answer a dialog
    /// nobody opened.
    var placement: PluginPagePlacement?

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
        case .composerAttach: return try composerAttach(request, pluginId: pluginId)
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
        case .dialogSubmit: return try dialogSubmit(request, pluginId: pluginId)
        case .uiResize: return resize(request)
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

    /// Attach an issue to the chat's composer as a chip, never as text.
    ///
    /// Two shapes are accepted and both become one `IssueRef`. A page that holds
    /// a whole ref — every official tracker plugin does, because that is what
    /// ADE hands it — sends it under `issue` and nothing is lost. A page that
    /// knows only the five strings the bridge table lists sends those, and the
    /// ref is built from them.
    ///
    /// `pluginId` is stamped from the CALLER and never read out of the payload,
    /// the same rule `ade.lanes.linkIssue` follows on the machine: the owner of
    /// a link is what decides who may later remove it, so a ref whose owner the
    /// page could set would be a check against a value the page supplied.
    private func composerAttach(_ request: PluginPageBridgeRequest, pluginId: String) throws -> Any? {
        let ref: IssueRef
        if case .object(let raw)? = request.params["issue"] {
            guard var parsed = parseIssueRefValue(.object(raw.mapValues(Self.remoteJSON))) else {
                throw PluginPageBridgeError.invalidParams(
                    "composer.attach needs an issue with a provider, an issueId, a key and a title."
                )
            }
            parsed.pluginId = pluginId
            ref = parsed
        } else {
            ref = IssueRef(
                pluginId: pluginId,
                // Lowercased like the parser does: `Linear` and `linear` are one
                // tracker, and a ref that disagreed with itself about which
                // would render under a different badge than the rows beside it.
                provider: try string(request, "provider").lowercased(),
                issueId: try string(request, "issueId"),
                key: try string(request, "identifier"),
                title: try string(request, "title"),
                url: request.params["url"]?.stringValue
            )
        }
        host?.pluginPageComposerAttach(PluginPageComposerAttach(issue: ref))
        return nil
    }

    /// Answer the dialog this page is drawn inside.
    ///
    /// Placement first, and it is the host's own word: a tab that could name the
    /// issue for a dialog nobody opened would be writing into a form the reader
    /// is not looking at, which is why the contract refuses it everywhere but
    /// `dialog-picker`.
    private func dialogSubmit(_ request: PluginPageBridgeRequest, pluginId: String) throws -> Any? {
        guard placement == .dialogPicker else {
            throw PluginPageBridgeError.notPermitted("Only a page drawn inside a dialog can answer it.")
        }
        // An explicit null clears the reader's previous choice, and is a real
        // answer rather than a malformed one.
        if case .null? = request.params["issue"] {
            guard host?.pluginPageDialogSubmit(PluginPageDialogSubmit(issue: nil)) == true else {
                throw PluginPageBridgeError.failed("That dialog isn\u{2019}t open any more.")
            }
            return nil
        }
        guard case .object(let raw)? = request.params["issue"],
              var parsed = parseIssueRefValue(.object(raw.mapValues(Self.remoteJSON)))
        else {
            throw PluginPageBridgeError.invalidParams(
                "dialog.submit needs an issue with a provider, an issueId, a key and a title."
            )
        }
        // Stamped with the CALLING page's plugin id, exactly as composer.attach
        // stamps it: a page cannot answer a dialog on another plugin's behalf.
        parsed.pluginId = pluginId
        guard host?.pluginPageDialogSubmit(PluginPageDialogSubmit(issue: parsed)) == true else {
            throw PluginPageBridgeError.failed("The dialog didn\u{2019}t accept that issue.")
        }
        return nil
    }

    /// A content-height report. Answers nothing, by contract.
    private func resize(_ request: PluginPageBridgeRequest) -> Any? {
        guard case .number(let raw)? = request.params["height"],
              let height = clampPluginPageHeight(raw)
        else { return nil }
        host?.pluginPageResize(height: height)
        return nil
    }

    /// One bridge value as the app's own JSON type.
    ///
    /// The two enums are the same six cases: one is what a page speaks, the
    /// other is what every model on this phone is decoded from. Converting is
    /// what lets `parseIssueRefValue` — the one reader of a ref, shared with
    /// every lane and PR surface — validate a page's payload too, rather than
    /// this file growing a second, quietly different idea of what a ref is.
    static func remoteJSON(_ value: PluginPageJSON) -> RemoteJSONValue {
        switch value {
        case .string(let raw): return .string(raw)
        case .number(let raw): return .number(raw)
        case .bool(let raw): return .bool(raw)
        case .object(let raw): return .object(raw.mapValues(remoteJSON))
        case .array(let raw): return .array(raw.map(remoteJSON))
        case .null: return .null
        }
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

    /// Carry a page's existing subscriptions onto a rebuilt bridge.
    ///
    /// Silent on purpose — it does NOT fire `onHostSubscriptionChange`, because
    /// nothing about what the page asked for has changed. Firing it would make
    /// the producer re-baseline and drop a window of real events on the floor.
    func restoreHostSubscriptions(_ kinds: Set<PluginPageHostKind>) {
        subscribedHostKinds.formUnion(kinds)
    }

    private func hostSubscribe(_ request: PluginPageBridgeRequest) -> Any? {
        let kinds = (request.params["kinds"]?.arrayValue ?? [])
            .compactMap { $0.stringValue }
            .compactMap { PluginPageHostKind(rawValue: $0) }
        let added = Set(kinds).subtracting(subscribedHostKinds)
        subscribedHostKinds.formUnion(kinds)
        if !added.isEmpty { onHostSubscriptionChange?(added, []) }
        return ["kinds": subscribedHostKinds.map(\.rawValue).sorted()]
    }

    private func hostUnsubscribe(_ request: PluginPageBridgeRequest) -> Any? {
        let kinds = (request.params["kinds"]?.arrayValue ?? [])
            .compactMap { $0.stringValue }
            .compactMap { PluginPageHostKind(rawValue: $0) }
        // No kinds named means "everything", which is what an unsubscribe with
        // no arguments has to mean for a page tearing itself down.
        let removed = kinds.isEmpty ? subscribedHostKinds : subscribedHostKinds.intersection(kinds)
        if kinds.isEmpty {
            subscribedHostKinds.removeAll()
        } else {
            subscribedHostKinds.subtract(kinds)
        }
        if !removed.isEmpty { onHostSubscriptionChange?([], removed) }
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
