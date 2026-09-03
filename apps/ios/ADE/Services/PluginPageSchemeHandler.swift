import Foundation
import WebKit

/// `ade-plugin://<pluginId>/<path>` on the phone.
///
/// The whole point of a custom scheme here is the ORIGIN. A plugin page could
/// be loaded from a `file:` URL with far less code, and it would then share one
/// origin with every other page on disk: `'self'` in the content policy would
/// mean "the whole filesystem", storage would be shared between plugins, and a
/// page could fetch any file the app can read. One origin per plugin makes
/// WebKit's own same-origin machinery do the isolation, and this handler's only
/// job is to make that origin resolve to exactly one cache entry.
///
/// Three rules it never bends, matching the desktop handler
/// (`apps/desktop/src/main/services/plugins/pluginWebviewProtocol.ts`):
///
/// 1. **The cache entry is the whole world.** A request that names anything the
///    entry's manifest does not list is a 404, and a request whose path tries to
///    leave the entry is a 403 that carries no bytes.
/// 2. **One origin per host view.** A guest opened for plugin A that asks for
///    plugin B's origin is a 403. The webview is built for one plugin, so a
///    cross-origin request here is not a mistake to be helpful about.
/// 3. **Every response carries the policy.** Including the refusals: an error
///    body is still a document WebKit parses, and one served without a policy
///    would be the one document in this origin that could execute anything.

/// What the handler decided, before any WebKit object is involved.
///
/// Split out so every rule above is testable as a pure function of a URL and a
/// cache — a `WKURLSchemeTask` cannot be constructed in a unit test.
enum PluginPageSchemeResponse: Equatable {
    case ok(data: Data, contentType: String)
    /// Not in this entry's manifest. Directories land here, which is deliberate:
    /// a listing of a plugin's tree is a map of the plugin.
    case notFound
    /// Tried to leave the entry, or asked for another plugin's origin.
    case forbidden
}

/// Extension → content type, as a closed map.
///
/// Closed rather than a lookup through a system table because this decides what
/// WebKit will EXECUTE. An unknown extension is `application/octet-stream`
/// which, with `nosniff`, means the browser refuses to guess for us.
///
/// Transcribed from `PLUGIN_WEBVIEW_CONTENT_TYPES` on the desktop. The two lists
/// are asserted equal in `PluginPageSchemeHandlerTests`, because a type the
/// desktop serves and the phone does not is a page that works on one platform.
enum PluginPageContentTypes {
    static let fallback = "application/octet-stream"

    static let map: [String: String] = [
        "html": "text/html; charset=utf-8",
        "htm": "text/html; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "js": "text/javascript; charset=utf-8",
        "mjs": "text/javascript; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "svg": "image/svg+xml",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "gif": "image/gif",
        "webp": "image/webp",
        "avif": "image/avif",
        "ico": "image/x-icon",
        "woff": "font/woff",
        "woff2": "font/woff2",
        "ttf": "font/ttf",
        "otf": "font/otf",
        "mp4": "video/mp4",
        "webm": "video/webm",
        "txt": "text/plain; charset=utf-8",
        "map": "application/json; charset=utf-8",
    ]

    static func contentType(for path: String) -> String {
        let ext = (path as NSString).pathExtension.lowercased()
        return map[ext] ?? fallback
    }
}

/// The `WKURLSchemeHandler` a plugin page's webview is configured with.
///
/// Holds the store and the plugin id the guest was built for. Nothing else: the
/// bridge is a separate object on a separate channel, because a handler that
/// could also answer bridge calls would be a second door into the same origin.
final class PluginPageSchemeHandler: NSObject, WKURLSchemeHandler {
    private let pluginId: String
    private let store: PluginPageAssetStore
    /// Captured at construction, not re-resolved per request: a page must not
    /// change version underneath itself while it is running. A new version
    /// arrives as a fresh guest, which is what the reload event is for.
    private let entry: PluginPageCacheEntry

    init(pluginId: String, store: PluginPageAssetStore, entry: PluginPageCacheEntry) {
        self.pluginId = pluginId
        self.store = store
        self.entry = entry
        super.init()
    }

    /// The decision, as a pure function. Public so the tests reach it directly.
    func respond(to url: URL) -> PluginPageSchemeResponse {
        guard url.scheme?.lowercased() == pluginPageScheme else { return .forbidden }
        guard let host = url.host?.lowercased(), host == pluginId else { return .forbidden }

        guard let relative = Self.relativePath(from: url) else { return .forbidden }
        // An empty path is the origin's own document, which is the entry HTML.
        // Every OTHER path must name a file the manifest lists, so a directory
        // is a 404 rather than an index nobody asked for.
        let wanted = relative.isEmpty ? entry.entry : relative

        guard entry.manifest.file(at: wanted) != nil else { return .notFound }
        guard let data = store.data(for: entry, path: wanted) else { return .notFound }
        return .ok(data: data, contentType: PluginPageContentTypes.contentType(for: wanted))
    }

    /// The requested path, or nil when the request is an escape attempt.
    ///
    /// Exactly ONE leading slash is stripped before decoding, and that ordering
    /// is the load-bearing part: the URL form contributes that slash, so
    /// anything still absolute after decoding was written as `%2F…` by the page
    /// and is asking for a filesystem root rather than for a file in the plugin.
    /// Decoding first would fold the two cases together.
    static func relativePath(from url: URL) -> String? {
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let raw = components.percentEncodedPath
        let withoutLeadingSlash = raw.hasPrefix("/") ? String(raw.dropFirst()) : raw
        guard let decoded = withoutLeadingSlash.removingPercentEncoding else { return nil }
        // Written as the ESCAPE, never as a literal NUL byte: a source file
        // holding one is binary to git, which stops diffing it.
        if decoded.contains("\u{0000}") { return nil }
        if decoded.isEmpty { return "" }
        if decoded.hasPrefix("/") || decoded.hasPrefix("\\") { return nil }
        if decoded.range(of: "^[A-Za-z]:", options: .regularExpression) != nil { return nil }
        let segments = decoded.split(whereSeparator: { $0 == "/" || $0 == "\\" }).map(String.init)
        if segments.contains("..") { return nil }
        // A trailing slash named a directory. The manifest lists no directories,
        // so rejoining without it would silently answer with a different file.
        if decoded.hasSuffix("/") { return segments.joined(separator: "/") + "/" }
        return segments.joined(separator: "/")
    }

    /// Headers every response carries, refusals included.
    static func headers(contentType: String, length: Int) -> [String: String] {
        [
            "Content-Type": contentType,
            "Content-Length": String(length),
            "Content-Security-Policy": pluginPageContentSecurityPolicy,
            "X-Content-Type-Options": "nosniff",
        ]
    }

    // MARK: WKURLSchemeHandler

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let url = urlSchemeTask.request.url ?? URL(fileURLWithPath: "/")
        let outcome = respond(to: url)

        let status: Int
        let body: Data
        let contentType: String
        switch outcome {
        case .ok(let data, let type):
            status = 200
            body = data
            contentType = type
        case .notFound:
            status = 404
            body = Data("Not found".utf8)
            contentType = "text/plain; charset=utf-8"
        case .forbidden:
            status = 403
            body = Data("Forbidden".utf8)
            contentType = "text/plain; charset=utf-8"
        }

        // An `HTTPURLResponse` rather than a bare `URLResponse` because the
        // content policy has to ride in a header: WebKit applies a CSP header on
        // a custom-scheme response to the document it creates, and there is no
        // script-side way to install one after the fact.
        guard let response = HTTPURLResponse(
            url: url,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: Self.headers(contentType: contentType, length: body.count)
        ) else {
            urlSchemeTask.didFailWithError(URLError(.badServerResponse))
            return
        }
        urlSchemeTask.didReceive(response)
        urlSchemeTask.didReceive(body)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        // Every response is produced synchronously in `start`, so by the time a
        // stop could arrive there is nothing in flight to cancel.
    }
}
