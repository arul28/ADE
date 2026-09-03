import XCTest
@testable import ADE

/// `ade-plugin://<pluginId>/<path>` on the phone.
///
/// The handler's job is to make one origin resolve to exactly one cache entry,
/// so these tests are about the refusals as much as the hits: a directory, a
/// traversal, another plugin's origin, and a file the manifest never listed.
final class PluginPageSchemeHandlerTests: XCTestCase {
    private var root: URL!
    private var store: PluginPageAssetStore!
    private var entry: PluginPageCacheEntry!

    override func setUpWithError() throws {
        try super.setUpWithError()
        root = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("plugin-scheme-\(UUID().uuidString)", isDirectory: true)
        let bundleRoot = root.appendingPathComponent("bundle", isDirectory: true)
        let directory = bundleRoot.appendingPathComponent("demo-plugin", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory.appendingPathComponent("assets", isDirectory: true),
            withIntermediateDirectories: true
        )

        let bodies = [
            "index.html": "<html>page</html>",
            "assets/app.js": "console.log(1)",
            "assets/app.css": "body{}",
            "assets/logo.png": "PNG",
            "assets/font.woff2": "WOFF",
            "assets/data.bin": "BIN",
        ]
        for (path, body) in bodies {
            try Data(body.utf8).write(to: directory.appendingPathComponent(path))
        }
        let manifest = PluginPageAssetsManifest(
            pluginId: "demo-plugin",
            version: "1.0.0",
            revision: 1,
            entry: "index.html",
            files: bodies.map { path, body in
                let data = Data(body.utf8)
                return PluginPageAssetFile(path: path, bytes: data.count, sha256: PluginPageHashing.sha256Hex(data))
            }.sorted { $0.path < $1.path }
        )
        try JSONEncoder().encode(manifest).write(to: directory.appendingPathComponent("manifest.json"))

        store = PluginPageAssetStore(root: root.appendingPathComponent("cache", isDirectory: true), bundleRoot: bundleRoot)
        entry = try XCTUnwrap(store.resolve(pluginId: "demo-plugin"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
        try super.tearDownWithError()
    }

    private func makeHandler() -> PluginPageSchemeHandler {
        PluginPageSchemeHandler(pluginId: "demo-plugin", store: store, entry: entry)
    }

    private func respond(_ urlString: String) throws -> PluginPageSchemeResponse {
        let url = try XCTUnwrap(URL(string: urlString))
        return makeHandler().respond(to: url)
    }

    // MARK: Serving

    func testServesTheEntryForTheOriginItself() throws {
        let outcome = try respond("ade-plugin://demo-plugin/")

        guard case .ok(let data, let contentType) = outcome else {
            return XCTFail("expected the entry, got \(outcome)")
        }
        XCTAssertEqual(data, Data("<html>page</html>".utf8))
        XCTAssertEqual(contentType, "text/html; charset=utf-8")
    }

    func testServesAListedFile() throws {
        let outcome = try respond("ade-plugin://demo-plugin/assets/app.js")

        guard case .ok(let data, let contentType) = outcome else {
            return XCTFail("expected the script, got \(outcome)")
        }
        XCTAssertEqual(data, Data("console.log(1)".utf8))
        XCTAssertEqual(contentType, "text/javascript; charset=utf-8")
    }

    func testIgnoresTheContextQueryWhenResolvingAPath() throws {
        // The file a request names is chosen by the PATH. The host reads the
        // context out of the query and the handler must not.
        let outcome = try respond("ade-plugin://demo-plugin/assets/app.css?__adeCtx=%7B%7D")

        guard case .ok(_, let contentType) = outcome else {
            return XCTFail("expected the stylesheet, got \(outcome)")
        }
        XCTAssertEqual(contentType, "text/css; charset=utf-8")
    }

    // MARK: MIME

    /// A type the desktop serves and the phone does not is a page that works on
    /// one platform. The list is closed on both sides for the same reason: this
    /// decides what WebKit will execute.
    func testContentTypeMapCoversEveryExtensionTheDesktopServes() {
        let expected: Set<String> = [
            "html", "htm", "css", "js", "mjs", "json", "svg", "png", "jpg", "jpeg",
            "gif", "webp", "avif", "ico", "woff", "woff2", "ttf", "otf", "mp4",
            "webm", "txt", "map",
        ]
        XCTAssertEqual(Set(PluginPageContentTypes.map.keys), expected)
        XCTAssertEqual(expected.count, 22)
    }

    func testAnUnknownExtensionIsOctetStream() throws {
        let outcome = try respond("ade-plugin://demo-plugin/assets/data.bin")

        guard case .ok(_, let contentType) = outcome else {
            return XCTFail("expected the blob, got \(outcome)")
        }
        XCTAssertEqual(contentType, PluginPageContentTypes.fallback)
    }

    func testFontsAndImagesCarryTheirOwnTypes() {
        XCTAssertEqual(PluginPageContentTypes.contentType(for: "a/b.woff2"), "font/woff2")
        XCTAssertEqual(PluginPageContentTypes.contentType(for: "a/b.PNG"), "image/png")
        XCTAssertEqual(PluginPageContentTypes.contentType(for: "a/b.map"), "application/json; charset=utf-8")
    }

    // MARK: Refusals

    func testADirectoryIsNotFound() throws {
        // A listing of a plugin's tree is a map of the plugin.
        XCTAssertEqual(try respond("ade-plugin://demo-plugin/assets/"), .notFound)
    }

    func testAnUnlistedFileIsNotFound() throws {
        XCTAssertEqual(try respond("ade-plugin://demo-plugin/assets/missing.js"), .notFound)
    }

    func testATraversalIsForbidden() throws {
        XCTAssertEqual(try respond("ade-plugin://demo-plugin/../manifest.json"), .forbidden)
        XCTAssertEqual(try respond("ade-plugin://demo-plugin/assets/../../secret"), .forbidden)
    }

    func testAnEncodedAbsolutePathIsForbidden() throws {
        // Exactly one leading slash is stripped BEFORE decoding, so a path
        // written as `%2F…` is still absolute when it is checked.
        XCTAssertEqual(try respond("ade-plugin://demo-plugin/%2Fetc%2Fhosts"), .forbidden)
    }

    func testAnotherPluginsOriginIsForbidden() throws {
        XCTAssertEqual(try respond("ade-plugin://other-plugin/index.html"), .forbidden)
    }

    func testAnotherSchemeIsForbidden() throws {
        XCTAssertEqual(try respond("https://demo-plugin/index.html"), .forbidden)
    }

    // MARK: Headers

    func testEveryResponseCarriesThePolicyAndNosniff() {
        let headers = PluginPageSchemeHandler.headers(contentType: "text/plain; charset=utf-8", length: 9)

        XCTAssertEqual(headers["X-Content-Type-Options"], "nosniff")
        XCTAssertEqual(headers["Content-Security-Policy"], pluginPageContentSecurityPolicy)
        XCTAssertEqual(headers["Content-Length"], "9")
    }

    /// The exact string, so a drift from the desktop's `PLUGIN_WEBVIEW_CSP`
    /// shows up as a failing test rather than as a page that loads on one
    /// platform and not the other.
    func testTheContentPolicyMatchesTheDesktopConstant() {
        XCTAssertEqual(
            pluginPageContentSecurityPolicy,
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
                + "img-src 'self' https: data: blob:; media-src 'self' https: blob:; "
                + "font-src 'self' data:; connect-src https:; form-action 'none'; "
                + "frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
        )
    }
}
