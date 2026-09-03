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
        Coordinator(pluginId: pluginId, dataSource: dataSource, host: host)
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
        // A plugin page draws its own affordances; a rubber-band bounce past
        // them reads as the sheet coming apart.
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = uiContext.coordinator
        uiContext.coordinator.attach(webView)
        PluginPageGuestRegistry.shared.attach(webView)

        if let url = PluginPageURLBuilder.url(pluginId: pluginId, path: entry.entry, context: self.context) {
            webView.load(URLRequest(url: url))
        }
        return webView
    }

    func updateUIView(_ webView: WKWebView, context uiContext: Context) {
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
          var listeners = { changed: [], theme: [], host: [] };
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
          window.__adePluginEmit = function (name, payload) {
            var list = listeners[name];
            if (!list) { return; }
            for (var i = 0; i < list.length; i += 1) {
              try { list[i](payload); } catch (error) { /* a page's own handler */ }
            }
          };
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
              confirm: function (confirm) { return call("ui.confirm", confirm || {}); }
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
        var host: PluginPageBridgeHosting? {
            didSet { bridge = PluginPageBridge(dataSource: dataSource, host: host) }
        }

        private let dataSource: PluginPageBridgeDataSource
        private var bridge: PluginPageBridge
        private weak var webView: WKWebView?
        private var deliveredChangeRevision: Int?
        private var deliveredScheme: ColorScheme?

        init(pluginId: String, dataSource: PluginPageBridgeDataSource, host: PluginPageBridgeHosting?) {
            self.pluginId = pluginId
            self.dataSource = dataSource
            self.host = host
            self.bridge = PluginPageBridge(dataSource: dataSource, host: host)
            super.init()
        }

        func attach(_ webView: WKWebView) {
            self.webView = webView
        }

        func detach() {
            webView = nil
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
        func deliverHostEvent(kind: PluginPageHostKind, ids: [String], overflow: Bool) {
            guard bridge.subscribedHostKinds.contains(kind) else { return }
            emit(event: .host, payload: [
                "kind": kind.rawValue,
                "ids": Array(ids.prefix(PluginPageHostEventLimits.maxIds)),
                "overflow": overflow || ids.count > PluginPageHostEventLimits.maxIds,
            ])
        }

        private func emit(event: PluginPageBridgeEvent, payload: [String: Any]) {
            guard let webView else { return }
            guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
                  let json = String(data: data, encoding: .utf8)
            else { return }
            let script = "window.__adePluginEmit && window.__adePluginEmit(\(PluginPageHostView.jsonString(event.rawValue)), \(json));"
            webView.evaluateJavaScript(script, completionHandler: nil)
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
