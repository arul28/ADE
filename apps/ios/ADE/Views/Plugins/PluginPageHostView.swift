import SwiftUI
import UIKit
import WebKit

/// A plugin's own page, drawn in a `WKWebView`.
///
/// The guest is untrusted in the sense that matters: it runs the plugin
/// author's code, in its own origin, behind the same content policy the desktop
/// applies, with no path to the app's own JavaScript context and no file access
/// beyond the cache entry the scheme handler serves. Everything it can ask ADE
/// for goes through `PluginPageBridge`, whose method list is the permission
/// model.
///
/// ## One live guest
///
/// A `WKWebView` is a whole web content process. Keeping several alive so a
/// sheet reopens instantly is how a phone ends up jetsammed while the user is
/// reading a chat, so this view destroys its guest the moment it disappears and
/// `PluginPageGuestRegistry` tears down any earlier one when a new page opens.
/// State survives that, because state lives in the plugin's collections rather
/// than in the guest — which is also why the data store is non-persistent.
///
/// ## Why the context is injected twice
///
/// It rides on the source URL, exactly as the desktop builds it, so a page that
/// reads its own query sees what the desktop shows it. And the host injects its
/// OWN captured copy as `window.adePlugin.context` before any page script runs.
/// The second one is the answer of record: a page that rewrites its query
/// string does not change it.

// MARK: - The live-guest registry

/// Which guest is currently alive.
///
/// A tiny registry rather than a rule written in comments, because the rule is
/// only true if something enforces it: two surfaces can both be told to appear
/// in the same frame (a socket popover over a plugin tab), and without this the
/// second one would simply add a second web content process.
@MainActor
final class PluginPageGuestRegistry {
    static let shared = PluginPageGuestRegistry()

    private weak var live: WKWebView?

    private init() {}

    func attach(_ webView: WKWebView) {
        if let live, live !== webView { PluginPageGuestRegistry.destroy(live) }
        live = webView
    }

    func detach(_ webView: WKWebView) {
        if live === webView { live = nil }
        PluginPageGuestRegistry.destroy(webView)
    }

    /// Stop the guest and let go of everything that holds it.
    ///
    /// `about:blank` first: removing the message handler alone leaves a page
    /// that is still running timers and still painting, and a `WKWebView` that
    /// is merely unreferenced is not torn down until its process notices.
    static func destroy(_ webView: WKWebView) {
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil)
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        controller.removeScriptMessageHandler(forName: PluginPageHostView.messageHandlerName, contentWorld: .page)
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.removeFromSuperview()
    }
}

// MARK: - The view

struct PluginPageHostView: UIViewRepresentable {
    /// The one channel a page reaches the host on.
    static let messageHandlerName = "adePlugin"

    let pluginId: String
    let entry: PluginPageCacheEntry
    let context: PluginPageContext
    let store: PluginPageAssetStore
    let dataSource: PluginPageBridgeDataSource
    /// Weak on the far side: the host is a SwiftUI-owned coordinator, and a
    /// strong reference here would keep a dismissed sheet's state alive behind a
    /// guest that no longer has anywhere to draw.
    weak var host: PluginPageBridgeHosting?
    /// Bumped by the owner when the mirror changes, so the coordinator can push
    /// a `changed` event without owning a database observer of its own.
    var changeRevision: Int
    var colorScheme: ColorScheme

    func makeCoordinator() -> Coordinator {
        let coordinator = Coordinator(pluginId: pluginId, dataSource: dataSource, host: host)
        coordinator.placement = context.placement.flatMap(PluginPagePlacement.init(rawValue:))
        return coordinator
    }

    func makeUIView(context uiContext: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        // Non-persistent: a plugin page keeps nothing across opens. Everything
        // it wants to remember belongs in its collections, which replicate,
        // rather than in a per-device web store that does not.
        configuration.websiteDataStore = .nonPersistent()
        configuration.suppressesIncrementalRendering = false
        configuration.setURLSchemeHandler(
            PluginPageSchemeHandler(pluginId: pluginId, store: store, entry: entry),
            forURLScheme: pluginPageScheme
        )

        let controller = configuration.userContentController
        controller.addUserScript(WKUserScript(
            source: Self.bridgeScript(pluginId: pluginId, context: self.context),
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))
        controller.addScriptMessageHandler(
            uiContext.coordinator,
            contentWorld: .page,
            name: Self.messageHandlerName
        )

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = uiContext.coordinator
        // Pull to refresh, which is the reason this scroll view bounces at all.
        //
        // It used to be pinned (`bounces = false`) so a plugin page could not
        // rubber-band away from its own chrome. A refresh control cannot exist
        // without the bounce — the gesture IS the overscroll — so the trade is
        // made deliberately: the reader gets the one gesture every other list
        // in this app answers, and pays a little give at the edges for it.
        webView.scrollView.bounces = true
        webView.scrollView.alwaysBounceVertical = true
        let refreshControl = UIRefreshControl()
        refreshControl.addTarget(
            uiContext.coordinator,
            action: #selector(Coordinator.handlePullToRefresh(_:)),
            for: .valueChanged
        )
        webView.scrollView.refreshControl = refreshControl
        uiContext.coordinator.refreshControl = refreshControl
        uiContext.coordinator.attach(webView)
        PluginPageGuestRegistry.shared.attach(webView)

        if let url = PluginPageURLBuilder.url(pluginId: pluginId, path: entry.entry, context: self.context) {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context uiContext: Context) {
        uiContext.coordinator.placement = context.placement.flatMap(PluginPagePlacement.init(rawValue:))
        uiContext.coordinator.host = host
        uiContext.coordinator.deliverChanged(revision: changeRevision)
        uiContext.coordinator.deliverTheme(scheme: colorScheme)
    }

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        coordinator.detach()
        PluginPageGuestRegistry.shared.detach(webView)
    }

    // MARK: The injected bridge

    /// `window.adePlugin`, as the page sees it.
    ///
    /// Every method is one `postMessage` that resolves to the host's answer —
    /// `WKScriptMessageHandlerWithReply` makes the round trip a real promise, so
    /// the page needs no correlation table of its own and the host needs no
    /// second channel to answer on.
    ///
    /// The three literals are interpolated by the HOST: the version, the plugin
    /// id, and the captured context. A page can read them and cannot change what
    /// the host answers against.
    static func bridgeScript(pluginId: String, context: PluginPageContext) -> String {
        let contextJSON = PluginPageURLBuilder.encodeContext(context) ?? "null"
        let pluginJSON = jsonString(pluginId)
        return """
        (function () {
          if (window.adePlugin) return;
          var VERSION = \(pluginPageBridgeVersion);
          var seq = 0;
          var listeners = { changed: [], theme: [], host: [], refresh: [] };
          function call(method, params) {
            seq += 1;
            return window.webkit.messageHandlers.\(messageHandlerName).postMessage({
              id: "r" + seq,
              bridgeVersion: VERSION,
              method: method,
              params: params || {}
            });
          }
          function on(name, handler) {
            var list = listeners[name];
            if (!list || typeof handler !== "function") { return function () {}; }
            list.push(handler);
            return function () {
              var at = list.indexOf(handler);
              if (at >= 0) { list.splice(at, 1); }
            };
          }
          // Returns how many of the page's own handlers ran, which is the ONE
          // acknowledgement the host can observe: `evaluateJavaScript` hands
          // the count back, and the pull-to-refresh control ends on it. A page
          // with no listener for an event answers 0, which is not a failure —
          // it is "nothing here cares", and the host stops waiting.
          window.__adePluginEmit = function (name, payload) {
            var list = listeners[name];
            if (!list) { return 0; }
            var ran = 0;
            for (var i = 0; i < list.length; i += 1) {
              try { list[i](payload); ran += 1; } catch (error) { /* a page's own handler */ }
            }
            return ran;
          };
          // The page's own failures, reported to the host so it can draw the
          // error card. Deliberately NOT routed through `call`: a rejected
          // report would itself be an unhandled rejection, and the listener
          // below would report that, and so on.
          var reporting = false;
          function report(message, kind, uri) {
            if (reporting) { return; }
            reporting = true;
            try {
              var params = { kind: kind || "error", message: String(message || "") };
              if (uri) { params.source = String(uri); }
              var sent = window.webkit.messageHandlers.\(messageHandlerName).postMessage({
                id: "e" + (seq += 1),
                bridgeVersion: VERSION,
                method: "page.error",
                params: params
              });
              // Swallowed rather than left to float: an unhandled rejection
              // here would be caught by the listener above, which would report
              // it, which would reject again.
              if (sent && sent.then) { sent.then(null, function () {}); }
            } catch (error) { /* the host is gone; nothing left to tell */ }
            reporting = false;
          }
          window.addEventListener("error", function (event) {
            report((event && (event.message || event.error)) || "", "error", event && event.filename);
          });
          window.addEventListener("unhandledrejection", function (event) {
            report((event && event.reason && (event.reason.message || event.reason)) || "", "error");
          });
          // The guest's own view of a CSP refusal. The host cannot see one —
          // WebKit blocks the load inside the content process and the
          // navigation delegate is never told — so the page is the only party
          // that can say a script or a style was refused.
          document.addEventListener("securitypolicyviolation", function (event) {
            report(
              "This page tried to load " +
                ((event && event.blockedURI) || "something") +
                ", which a plugin page is not allowed to load.",
              "csp",
              event && event.blockedURI
            );
          });
          window.adePlugin = Object.freeze({
            version: VERSION,
            pluginId: \(pluginJSON),
            context: \(contextJSON),
            collections: Object.freeze({
              get: function (collection, key) { return call("collections.get", { collection: collection, key: key }); },
              put: function (collection, key, value) { return call("collections.put", { collection: collection, key: key, value: value }); },
              list: function (collection, options) {
                var params = { collection: collection };
                if (options && options.keyPrefix) { params.keyPrefix = options.keyPrefix; }
                if (options && options.limit) { params.limit = options.limit; }
                return call("collections.list", params);
              }
            }),
            config: Object.freeze({
              get: function (key) { return call("config.get", { key: key }); },
              set: function (key, value) { return call("config.set", { key: key, value: value }); }
            }),
            invoke: function (actionId, args) { return call("invoke", { actionId: actionId, args: args || {} }); },
            openDeeplink: function (url) { return call("openDeeplink", { url: url }); },
            openSettings: function (target) { return call("openSettings", target || {}); },
            surface: Object.freeze({
              close: function () { return call("surface.close", {}); }
            }),
            composer: Object.freeze({
              attach: function (payload) { return call("composer.attach", payload || {}); },
              insert: function (text) { return call("composer.insert", { text: text }); }
            }),
            ui: Object.freeze({
              toast: function (toast) { return call("ui.toast", toast || {}); },
              dismissToast: function (id) { return call("ui.dismissToast", { id: id }); },
              prompt: function (prompt) { return call("ui.prompt", prompt || {}); },
              confirm: function (confirm) { return call("ui.confirm", confirm || {}); },
              resize: function (height) { call("ui.resize", { height: height }); },
              // The five host pickers. Each resolves to the choice, to null
              // when the reader dismissed it, or REJECTS when this client
              // cannot ask — a page must not read a rejection as a dismissal.
              pickModel: function (request) { return call("ui.pickModel", request || {}); },
              pickLane: function (request) { return call("ui.pickLane", request || {}); },
              pickPermissionMode: function (options) { return call("ui.pickPermissionMode", options || {}); },
              pickReasoningEffort: function (options) { return call("ui.pickReasoningEffort", options || {}); },
              pickProvider: function (request) { return call("ui.pickProvider", request || {}); },
              // Present so a page hears the phone's refusal by name rather than
              // an "unknown method" it would treat as a version skew.
              openPathInEditor: function (request) { return call("ui.openPathInEditor", request || {}); }
            }),
            sockets: Object.freeze({
              list: function (socket) { return call("sockets.list", { socket: socket }); },
              invoke: function (socketId, args) {
                return call("sockets.invoke", { socketId: socketId, args: args || {} });
              }
            }),
            hostEngine: Object.freeze({
              place: function (request) { return call("hostEngine.place", request || {}); },
              release: function () { return call("hostEngine.release", {}); }
            }),
            dialog: Object.freeze({
              submit: function (answer) { return call("dialog.submit", answer || {}); }
            }),
            clipboard: Object.freeze({
              read: function () { return call("clipboard.read", {}); },
              write: function (text) { return call("clipboard.write", { text: text }); }
            }),
            theme: Object.freeze({
              get: function () { return call("theme.get", {}); }
            }),
            host: Object.freeze({
              subscribe: function (options) {
                var kinds = (options && options.kinds) || [];
                return call("host.subscribe", { kinds: kinds }).then(function () {
                  return function () { return call("host.unsubscribe", { kinds: kinds }); };
                });
              }
            }),
            events: Object.freeze({ on: on })
          });
        })();
        """
    }

    static func jsonString(_ value: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [value], options: [])) ?? Data("[\"\"]".utf8)
        let text = String(data: data, encoding: .utf8) ?? "[\"\"]"
        return String(text.dropFirst().dropLast())
    }

    // MARK: - Coordinator

    @MainActor
    final class Coordinator: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate {
        let pluginId: String
        /// Where the host drew this guest, captured from the context the host
        /// itself encoded. Re-applied whenever the bridge is rebuilt, because a
        /// bridge that forgot its placement would refuse `dialog.submit` from
        /// the one page allowed to make it.
        var placement: PluginPagePlacement? {
            didSet { bridge.placement = placement }
        }
        var host: PluginPageBridgeHosting? {
            didSet {
                // The subscribed kinds move with the bridge. A page that
                // subscribed before its surface handed over a new host must not
                // stop hearing from the host because SwiftUI rebuilt a struct
                // behind it.
                let carried = bridge.subscribedHostKinds
                bridge = PluginPageBridge(dataSource: dataSource, host: host)
                bridge.placement = placement
                bridge.restoreHostSubscriptions(carried)
                wireHostEvents()
            }
        }

        private let dataSource: PluginPageBridgeDataSource
        private var bridge: PluginPageBridge
        private weak var webView: WKWebView?
        private var deliveredChangeRevision: Int?
        private var deliveredScheme: ColorScheme?
        /// Watches the phone's change streams while this guest is alive.
        ///
        /// Built only when the data source can also answer for the world, and
        /// torn down with the guest: a closed page keeps no observers and no
        /// entity snapshots.
        private var hostEvents: PluginPageHostEventSource?
        /// The control the reader pulls. Held so the host can END it, which is
        /// the only half of pull-to-refresh the page cannot do for itself.
        weak var refreshControl: UIRefreshControl?

        init(pluginId: String, dataSource: PluginPageBridgeDataSource, host: PluginPageBridgeHosting?) {
            self.pluginId = pluginId
            self.dataSource = dataSource
            self.host = host
            self.bridge = PluginPageBridge(dataSource: dataSource, host: host)
            super.init()
            wireHostEvents()
        }

        /// Connect `host.subscribe` to the producer.
        ///
        /// The subscription callback carries what was ADDED and what was
        /// DROPPED, and the added half is what takes a baseline WITHOUT
        /// emitting: a page that has only just subscribed already read the world
        /// on its first render, so telling it every lane changed would make that
        /// render happen twice.
        private func wireHostEvents() {
            guard let world = dataSource as? PluginPageHostWorldReading else { return }
            let source = PluginPageHostEventSource(world: world) { [weak self] frame in
                self?.deliverHostEvent(
                    kind: frame.kind,
                    ids: frame.ids,
                    overflow: frame.overflow,
                    turns: frame.turns
                )
            }
            if let sync = dataSource as? SyncService { source.observe(sync) }
            hostEvents = source
            bridge.onHostSubscriptionChange = { [weak source] added, removed in
                if !added.isEmpty { source?.subscribe(to: added) }
                if !removed.isEmpty { source?.unsubscribe(from: removed) }
            }
        }

        func attach(_ webView: WKWebView) {
            self.webView = webView
        }

        func detach() {
            webView = nil
            hostEvents?.cancel()
            hostEvents = nil
        }

        // MARK: Messages

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage,
            replyHandler: @escaping (Any?, String?) -> Void
        ) {
            // The plugin id comes from the FRAME, never from the body. WebKit
            // stamps every message with the sending frame's own origin, and the
            // scheme handler is the only thing that can produce one — so an
            // origin that is not this guest's plugin is a frame that should not
            // be able to reach this handler at all, and is dropped rather than
            // answered.
            let origin = message.frameInfo.securityOrigin
            guard let messagePluginId = PluginPageBridgeDecoder.pluginId(
                fromOriginScheme: origin.protocol,
                host: origin.host
            ), messagePluginId == pluginId else {
                replyHandler(nil, "Unrecognised plugin origin.")
                return
            }

            let request: PluginPageBridgeRequest
            do {
                request = try PluginPageBridgeDecoder.decode(body: message.body)
            } catch let error as PluginPageBridgeDecodeError {
                replyHandler(nil, error.message)
                return
            } catch {
                replyHandler(nil, error.localizedDescription)
                return
            }

            let bridge = self.bridge
            Task { @MainActor in
                do {
                    let answer = try await bridge.handle(request, pluginId: messagePluginId)
                    replyHandler(answer, nil)
                } catch let error as PluginPageBridgeError {
                    replyHandler(nil, error.message)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }
        }

        // MARK: Events

        /// The `changed` event, from the mirror.
        ///
        /// Coalesced on the revision the owner passes in rather than on a timer:
        /// one bump of `pluginsProjectionRevision` is one changeset applied, and
        /// a page that refetches once per changeset is doing the right amount of
        /// work. Skipping the first delivery matters — a page that has just
        /// loaded already read the mirror.
        func deliverChanged(revision: Int) {
            guard deliveredChangeRevision != revision else { return }
            let isFirst = deliveredChangeRevision == nil
            deliveredChangeRevision = revision
            guard !isFirst else { return }
            emit(event: .changed, payload: ["kind": "collections"])
        }

        func deliverTheme(scheme: ColorScheme) {
            guard deliveredScheme != scheme else { return }
            let isFirst = deliveredScheme == nil
            deliveredScheme = scheme
            guard !isFirst, let snapshot = host?.pluginPageTheme() else { return }
            emit(event: .theme, payload: snapshot.jsonValue)
        }

        /// A host entity moved. Delivered only to a page that subscribed to that
        /// kind, which is what `host.subscribe` is for.
        func deliverHostEvent(
            kind: PluginPageHostKind,
            ids: [String],
            overflow: Bool,
            turns: [PluginPageChatTurn] = []
        ) {
            guard bridge.subscribedHostKinds.contains(kind) else { return }
            var payload: [String: Any] = [
                "kind": kind.rawValue,
                "ids": Array(ids.prefix(PluginPageHostEventLimits.maxIds)),
                "overflow": overflow
                    || ids.count > PluginPageHostEventLimits.maxIds
                    || turns.count > PluginPageChatTurn.turnsMax,
            ]
            // Only on a `chat` frame, and only when there is something to say.
            // An entity frame carries identity and nothing else — the rule the
            // entity bus itself keeps — so it must not grow an empty field a
            // page would learn to read.
            if kind == .chat, !turns.isEmpty {
                payload["turns"] = turns.prefix(PluginPageChatTurn.turnsMax).map(\.jsonValue)
            }
            emit(event: .host, payload: payload)
        }

        private func emit(
            event: PluginPageBridgeEvent,
            payload: [String: Any],
            completion: ((Int) -> Void)? = nil
        ) {
            guard let webView else {
                completion?(0)
                return
            }
            guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
                  let json = String(data: data, encoding: .utf8)
            else {
                completion?(0)
                return
            }
            let script = "window.__adePluginEmit && window.__adePluginEmit(\(PluginPageHostView.jsonString(event.rawValue)), \(json));"
            guard let completion else {
                webView.evaluateJavaScript(script, completionHandler: nil)
                return
            }
            webView.evaluateJavaScript(script) { value, _ in
                completion((value as? NSNumber)?.intValue ?? 0)
            }
        }

        // MARK: Pull to refresh

        /// The reader pulled the page down.
        ///
        /// Sent as an EVENT on the one channel the others use — name `refresh`,
        /// empty payload — because it is the host telling the page something.
        ///
        /// The control ends when the page ACKNOWLEDGES: `__adePluginEmit`
        /// answers with the number of the page's own refresh handlers that ran,
        /// and `evaluateJavaScript` hands that number back. Zero is an
        /// acknowledgement too — a page with no refresh listener has nothing to
        /// wait for, and spinning against it forever would be the worse lie. It
        /// also ends on the page's next load; see `didFinish`. There is no
        /// timer: a spinner that stops because time passed says the page
        /// finished when nobody knows whether it did.
        @objc func handlePullToRefresh(_ control: UIRefreshControl) {
            emit(event: .refresh, payload: [:]) { [weak self] _ in
                self?.endRefreshing()
            }
        }

        private func endRefreshing() {
            guard let control = refreshControl, control.isRefreshing else { return }
            control.endRefreshing()
        }

        // MARK: Navigation

        /// The guest navigates within its own origin, and nowhere else.
        ///
        /// A link to `https://linear.app` opens in the phone's browser rather
        /// than replacing the plugin's page: a guest that can navigate away is a
        /// guest that can render a login form under ADE's own chrome.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if url.scheme?.lowercased() == pluginPageScheme, url.host?.lowercased() == pluginId {
                decisionHandler(.allow)
                return
            }
            if url.scheme?.lowercased() == "about" {
                decisionHandler(.allow)
                return
            }
            if navigationAction.navigationType == .linkActivated, let scheme = url.scheme?.lowercased(), scheme == "https" {
                host?.pluginPageOpenDeeplink(url)
            }
            decisionHandler(.cancel)
        }

        /// A load that finished is also the end of a pull.
        ///
        /// The second of the two things the host can actually observe: a page
        /// that answered a refresh by navigating has finished refreshing, and
        /// its own handler count would never have come back.
        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            endRefreshing()
        }

        /// The page did not load. One sentence, never a WebKit code.
        ///
        /// `NSURLErrorCancelled` is skipped: it is what a guest being torn down
        /// reports, and drawing "this page didn't open" over a sheet the reader
        /// just dismissed would be the app blaming a plugin for the reader's
        /// own tap.
        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            endRefreshing()
            reportNavigationFailure(error)
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            endRefreshing()
            reportNavigationFailure(error)
        }

        /// The web content process went away — usually memory pressure.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            endRefreshing()
            host?.pluginPageReportError(PluginPageErrorReport(
                message: "This page stopped because the phone ran low on memory.",
                source: .terminated
            ))
        }

        private func reportNavigationFailure(_ error: Error) {
            let nsError = error as NSError
            if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled { return }
            host?.pluginPageReportError(PluginPageErrorReport(
                message: "ADE couldn\u{2019}t load this plugin\u{2019}s page from its cached files.",
                source: .navigation
            ))
        }
    }
}

/// Ceilings on one `host` event, mirroring `PLUGIN_WEBVIEW_HOST_IDS_MAX`.
enum PluginPageHostEventLimits {
    static let maxIds = 200
}

// MARK: - Theme

enum PluginPageTheme {
    /// The `--ade-*` tokens a plugin page paints itself with.
    ///
    /// Resolved against an explicit trait collection rather than the ambient
    /// one: this is called to build a snapshot for a guest that has not been
    /// drawn yet, and an unresolved dynamic colour would answer with whatever
    /// the last drawn view happened to be.
    static func snapshot(scheme: ColorScheme) -> PluginPageThemeSnapshot {
        let traits = UITraitCollection(userInterfaceStyle: scheme == .dark ? .dark : .light)
        let tokens: [(String, Color)] = [
            ("--ade-bg", ADEColor.pageBackground),
            ("--ade-surface", ADEColor.surfaceBackground),
            ("--ade-card", ADEColor.cardBackground),
            ("--ade-border", ADEColor.border),
            ("--ade-text", ADEColor.textPrimary),
            ("--ade-text-secondary", ADEColor.textSecondary),
            ("--ade-text-muted", ADEColor.textMuted),
            ("--ade-accent", ADEColor.accent),
            ("--ade-accent-bright", ADEColor.accentBright),
            ("--ade-success", ADEColor.success),
            ("--ade-warning", ADEColor.warning),
            ("--ade-danger", ADEColor.danger),
            ("--ade-info", ADEColor.info),
        ]
        var resolved: [String: String] = [:]
        for (name, color) in tokens {
            resolved[name] = hexString(UIColor(color).resolvedColor(with: traits))
        }
        return PluginPageThemeSnapshot(scheme: scheme == .dark ? "dark" : "light", tokens: resolved)
    }

    static func hexString(_ color: UIColor) -> String {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return "#000000" }
        let clamp: (CGFloat) -> Int = { Int((max(0, min(1, $0)) * 255).rounded()) }
        return String(format: "#%02x%02x%02x", clamp(red), clamp(green), clamp(blue))
    }
}
