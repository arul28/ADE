import XCTest
@testable import ADE

/// The phone's copy of a plugin's page.
///
/// Every test here builds a real cache on disk, because the whole contract is
/// about the filesystem: what a half-written entry looks like to a reader, which
/// entry wins when three exist, and what happens to bytes that do not hash to
/// what the manifest promised. A mocked file manager would prove none of it.
final class PluginPageAssetStoreTests: XCTestCase {
    private var root: URL!
    private var bundleRoot: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        let base = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("plugin-pages-\(UUID().uuidString)", isDirectory: true)
        root = base.appendingPathComponent("cache", isDirectory: true)
        bundleRoot = base.appendingPathComponent("bundle", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: bundleRoot, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root.deletingLastPathComponent())
        try super.tearDownWithError()
    }

    private func makeStore() -> PluginPageAssetStore {
        PluginPageAssetStore(root: root, bundleRoot: bundleRoot)
    }

    private func manifest(
        pluginId: String = "demo-plugin",
        version: String = "1.0.0",
        revision: Int = 1,
        entry: String = "index.html",
        files: [(String, String)]
    ) -> PluginPageAssetsManifest {
        PluginPageAssetsManifest(
            pluginId: pluginId,
            version: version,
            revision: revision,
            entry: entry,
            files: files.map { path, body in
                let data = Data(body.utf8)
                return PluginPageAssetFile(path: path, bytes: data.count, sha256: PluginPageHashing.sha256Hex(data))
            }
        )
    }

    /// Lay a bundled entry down the way the build phase does: files by PATH.
    private func seedBundle(_ manifest: PluginPageAssetsManifest, bodies: [String: String]) throws {
        let directory = bundleRoot.appendingPathComponent(manifest.pluginId, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        for (path, body) in bodies {
            let url = directory.appendingPathComponent(path)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data(body.utf8).write(to: url)
        }
        let encoder = JSONEncoder()
        try encoder.encode(manifest).write(to: directory.appendingPathComponent("manifest.json"))
    }

    // MARK: The manifest diff

    func testRefreshDownloadsEveryFileTheFirstTime() async throws {
        let store = makeStore()
        let wanted = manifest(files: [("index.html", "<html>a</html>"), ("app.js", "console.log(1)")])
        let fetcher = ScriptedPageAssetFetcher(
            manifest: wanted,
            bodies: ["index.html": "<html>a</html>", "app.js": "console.log(1)"]
        )

        let entry = try await store.refresh(pluginId: "demo-plugin", using: fetcher)

        XCTAssertEqual(entry.manifest, wanted)
        XCTAssertEqual(Set(fetcher.requestedPaths), ["index.html", "app.js"])
        XCTAssertEqual(store.data(for: entry, path: "app.js"), Data("console.log(1)".utf8))
    }

    /// The whole point of hashing: a second refresh at the same version asks for
    /// nothing, and a version bump asks only for what actually changed.
    func testRefreshAsksOnlyForHashesItDoesNotHold() async throws {
        let store = makeStore()
        let first = manifest(files: [("index.html", "<html>a</html>"), ("app.js", "shared")])
        let firstFetcher = ScriptedPageAssetFetcher(
            manifest: first,
            bodies: ["index.html": "<html>a</html>", "app.js": "shared"]
        )
        _ = try await store.refresh(pluginId: "demo-plugin", using: firstFetcher)

        let second = manifest(
            version: "1.1.0",
            revision: 2,
            files: [("index.html", "<html>b</html>"), ("app.js", "shared")]
        )
        let secondFetcher = ScriptedPageAssetFetcher(
            manifest: second,
            bodies: ["index.html": "<html>b</html>", "app.js": "shared"]
        )

        let entry = try await store.refresh(pluginId: "demo-plugin", using: secondFetcher)

        XCTAssertEqual(secondFetcher.requestedPaths, ["index.html"], "the unchanged file must be reused by hash")
        XCTAssertEqual(store.data(for: entry, path: "index.html"), Data("<html>b</html>".utf8))
    }

    func testRefreshOfAnUnchangedPageDownloadsNothing() async throws {
        let store = makeStore()
        let wanted = manifest(files: [("index.html", "<html>a</html>")])
        _ = try await store.refresh(
            pluginId: "demo-plugin",
            using: ScriptedPageAssetFetcher(manifest: wanted, bodies: ["index.html": "<html>a</html>"])
        )

        let again = ScriptedPageAssetFetcher(manifest: wanted, bodies: ["index.html": "<html>a</html>"])
        _ = try await store.refresh(pluginId: "demo-plugin", using: again)

        XCTAssertTrue(again.requestedPaths.isEmpty)
    }

    // MARK: The hash refusal

    func testRefreshRefusesBytesThatDoNotMatchTheManifest() async throws {
        let store = makeStore()
        let wanted = manifest(files: [("index.html", "<html>a</html>")])
        // The host answered with different bytes than it listed. Storing them
        // would file the wrong content under a hash every later manifest still
        // points at, and no future refresh would repair it.
        let fetcher = ScriptedPageAssetFetcher(manifest: wanted, bodies: ["index.html": "<html>TAMPERED</html>"])

        do {
            _ = try await store.refresh(pluginId: "demo-plugin", using: fetcher)
            XCTFail("a hash mismatch must refuse")
        } catch let error as PluginPageAssetStoreError {
            XCTAssertEqual(error, .hashMismatch(path: "index.html"))
        }

        XCTAssertNil(store.resolve(pluginId: "demo-plugin"), "a refused refresh must not publish an entry")
    }

    func testRefreshRefusesAFileAboveTheCeiling() async throws {
        let store = makeStore()
        var wanted = manifest(files: [("index.html", "<html>a</html>")])
        wanted.files[0].bytes = PluginPageAssetStore.maxFileBytes + 1
        let fetcher = ScriptedPageAssetFetcher(manifest: wanted, bodies: ["index.html": "<html>a</html>"])

        do {
            _ = try await store.refresh(pluginId: "demo-plugin", using: fetcher)
            XCTFail("an oversize file must refuse")
        } catch let error as PluginPageAssetStoreError {
            XCTAssertEqual(error, .tooLarge(path: "index.html", bytes: PluginPageAssetStore.maxFileBytes + 1))
        }
    }

    func testRefreshRefusesAnInvalidPluginId() async {
        let store = makeStore()
        let fetcher = ScriptedPageAssetFetcher(manifest: manifest(files: []), bodies: [:])

        do {
            _ = try await store.refresh(pluginId: "../escape", using: fetcher)
            XCTFail("an invalid id must refuse")
        } catch let error as PluginPageAssetStoreError {
            XCTAssertEqual(error, .invalidPluginId)
        } catch {
            XCTFail("unexpected error \(error)")
        }
    }

    // MARK: Eviction

    func testRefreshEvictsEveryOlderVersion() async throws {
        let store = makeStore()
        _ = try await store.refresh(
            pluginId: "demo-plugin",
            using: ScriptedPageAssetFetcher(
                manifest: manifest(version: "1.0.0", revision: 1, files: [("index.html", "one")]),
                bodies: ["index.html": "one"]
            )
        )
        _ = try await store.refresh(
            pluginId: "demo-plugin",
            using: ScriptedPageAssetFetcher(
                manifest: manifest(version: "1.1.0", revision: 2, files: [("index.html", "two")]),
                bodies: ["index.html": "two"]
            )
        )

        let entries = try FileManager.default.contentsOfDirectory(
            at: root.appendingPathComponent("demo-plugin", isDirectory: true),
            includingPropertiesForKeys: nil
        )
        XCTAssertEqual(entries.count, 1, "exactly one downloaded entry survives a refresh")
        let resolved = try XCTUnwrap(store.resolve(pluginId: "demo-plugin"))
        XCTAssertEqual(resolved.version, "1.1.0")
    }

    /// A lexicographic compare picks `1.9.0`, which is how a phone ends up
    /// pinned to an old page forever after a plugin's tenth minor release.
    func testResolvePrefersTheNumericallyNewerVersion() async throws {
        let store = makeStore()
        try seedBundle(
            manifest(version: "1.9.0", revision: 1, files: [("index.html", "bundled")]),
            bodies: ["index.html": "bundled"]
        )
        _ = try await store.refresh(
            pluginId: "demo-plugin",
            using: ScriptedPageAssetFetcher(
                manifest: manifest(version: "1.10.0", revision: 1, files: [("index.html", "downloaded")]),
                bodies: ["index.html": "downloaded"]
            )
        )

        let resolved = try XCTUnwrap(store.resolve(pluginId: "demo-plugin"))
        XCTAssertEqual(resolved.version, "1.10.0")
        XCTAssertFalse(resolved.isBundled)
    }

    // MARK: The bundled seed

    func testBundledPageOpensWithNoMachineAtAll() throws {
        let store = makeStore()
        try seedBundle(
            manifest(version: "1.0.0", revision: 0, files: [("index.html", "<html>bundled</html>")]),
            bodies: ["index.html": "<html>bundled</html>"]
        )

        let resolved = try XCTUnwrap(store.resolve(pluginId: "demo-plugin"))

        XCTAssertTrue(resolved.isBundled)
        XCTAssertEqual(store.data(for: resolved, path: "index.html"), Data("<html>bundled</html>".utf8))
    }

    /// At the same version and revision the signed copy wins: preferring the
    /// download would trade a verified copy for an equivalent unverified one.
    func testBundledEntryWinsAtEqualVersionAndRevision() async throws {
        let store = makeStore()
        let shape = manifest(version: "2.0.0", revision: 7, files: [("index.html", "bundled")])
        try seedBundle(shape, bodies: ["index.html": "bundled"])
        _ = try await store.refresh(
            pluginId: "demo-plugin",
            using: ScriptedPageAssetFetcher(
                manifest: manifest(version: "2.0.0", revision: 7, files: [("index.html", "downloaded")]),
                bodies: ["index.html": "downloaded"]
            )
        )

        let resolved = try XCTUnwrap(store.resolve(pluginId: "demo-plugin"))

        XCTAssertTrue(resolved.isBundled)
        XCTAssertEqual(store.data(for: resolved, path: "index.html"), Data("bundled".utf8))
    }

    func testBundledEntryIsNotEvicted() async throws {
        let store = makeStore()
        try seedBundle(
            manifest(version: "1.0.0", revision: 1, files: [("index.html", "bundled")]),
            bodies: ["index.html": "bundled"]
        )
        _ = try await store.refresh(
            pluginId: "demo-plugin",
            using: ScriptedPageAssetFetcher(
                manifest: manifest(version: "3.0.0", revision: 9, files: [("index.html", "downloaded")]),
                bodies: ["index.html": "downloaded"]
            )
        )
        store.evictAll(pluginId: "demo-plugin")

        let resolved = try XCTUnwrap(store.resolve(pluginId: "demo-plugin"))
        XCTAssertTrue(resolved.isBundled, "the bundle survives eviction; it is not ours to delete")
    }

    // MARK: Containment

    func testABundledEntryRefusesAPathThatLeavesIt() throws {
        let store = makeStore()
        var shape = manifest(version: "1.0.0", revision: 1, files: [("index.html", "ok")])
        // A manifest that names an escape. The store resolves bundled files by
        // PATH, so this is the one place containment has to be checked.
        shape.files.append(PluginPageAssetFile(path: "../../secret.txt", bytes: 6, sha256: String(repeating: "a", count: 64)))
        try seedBundle(shape, bodies: ["index.html": "ok"])
        try Data("secret".utf8).write(to: bundleRoot.appendingPathComponent("secret.txt"))

        let resolved = try XCTUnwrap(store.resolve(pluginId: "demo-plugin"))

        XCTAssertNil(store.data(for: resolved, path: "../../secret.txt"))
    }

    func testAnIncompleteEntryIsInvisible() async throws {
        let store = makeStore()
        _ = try await store.refresh(
            pluginId: "demo-plugin",
            using: ScriptedPageAssetFetcher(
                manifest: manifest(files: [("index.html", "one")]),
                bodies: ["index.html": "one"]
            )
        )
        // Remove the manifest, which is what an interrupted refresh leaves
        // behind: blobs on disk and nothing published.
        let entryDirectory = try XCTUnwrap(
            try FileManager.default.contentsOfDirectory(
                at: root.appendingPathComponent("demo-plugin", isDirectory: true),
                includingPropertiesForKeys: nil
            ).first
        )
        try FileManager.default.removeItem(at: entryDirectory.appendingPathComponent("manifest.json"))

        XCTAssertNil(store.resolve(pluginId: "demo-plugin"))
    }
}

// MARK: - A scripted transport

/// The sync socket, scripted.
///
/// Records what was asked for, which is how the manifest-diff tests prove that
/// a file already on disk is never requested again.
private final class ScriptedPageAssetFetcher: PluginPageAssetFetching {
    private let manifest: PluginPageAssetsManifest
    private let bodies: [String: String]
    private(set) var requestedPaths: [String] = []

    init(manifest: PluginPageAssetsManifest, bodies: [String: String]) {
        self.manifest = manifest
        self.bodies = bodies
    }

    func fetchPluginPageAssetsManifest(pluginId: String) async throws -> PluginPageAssetsManifest {
        manifest
    }

    func fetchPluginPageAsset(pluginId: String, path: String, sha256: String) async throws -> Data {
        requestedPaths.append(path)
        guard let body = bodies[path] else {
            throw PluginPageAssetStoreError.unreadable(path: path)
        }
        return Data(body.utf8)
    }
}
