import CryptoKit
import Foundation

/// The phone's copy of a plugin's page.
///
/// The desktop serves a plugin page straight out of the install directory. A
/// phone has no install directory, so it fetches the tree over the sync file
/// channel and keeps it here. Three properties do all the work:
///
/// 1. **Content-addressed.** Every file is stored under its own SHA-256, so a
///    rebuild that changed one chunk costs one download and a version bump that
///    changed nothing costs none. The manifest maps path → hash; the blobs know
///    nothing about paths.
/// 2. **Versioned entries.** A cache entry is keyed on plugin id + version +
///    revision, and a page is only ever served out of one entry. A half-written
///    entry is never the current one: the manifest is written LAST, and an entry
///    with no manifest is invisible to every reader.
/// 3. **Openable offline.** Resolving an entry touches the network never. A
///    phone with no machine in reach opens the page it already has, which is the
///    whole reason the cache is on disk rather than in memory.
///
/// Bundled official plugins ship their built page inside the app, as
/// `BundledPluginPages/<pluginId>/`. That directory IS a cache entry — the same
/// shape, laid out by path rather than by hash because a build phase copies
/// files, not blobs — and it wins whenever no downloaded entry is newer. It is
/// what makes a fresh install draw a page before it has ever reached a machine.

// MARK: - Wire types

/// One file in a plugin page's asset tree, as the host lists it.
struct PluginPageAssetFile: Codable, Equatable {
    /// Forward-slashed, relative to the asset root. Never absolute.
    var path: String
    var bytes: Int
    var sha256: String
}

/// What `plugin.pageAssets.manifest` answers.
struct PluginPageAssetsManifest: Codable, Equatable {
    var pluginId: String
    var version: String
    /// Moves when the install changed without the version changing.
    var revision: Int
    /// The HTML to load, relative to the asset root.
    var entry: String
    var files: [PluginPageAssetFile]

    func file(at path: String) -> PluginPageAssetFile? {
        files.first { $0.path == path }
    }
}

/// What `plugin.pageAssets.read` answers.
struct PluginPageAssetBlob: Codable, Equatable {
    var path: String
    var bytes: Int
    var sha256: String
    var contentBase64: String
}

/// The transport, as this store needs it.
///
/// A protocol rather than a `SyncService` reference so every cache rule — the
/// manifest diff, the hash refusal, the eviction — is provable against a
/// scripted fetcher with no socket and no waiting.
protocol PluginPageAssetFetching: AnyObject {
    func fetchPluginPageAssetsManifest(pluginId: String) async throws -> PluginPageAssetsManifest
    func fetchPluginPageAsset(pluginId: String, path: String, sha256: String) async throws -> Data
}

// MARK: - Cache entries

/// A page the phone can draw right now.
struct PluginPageCacheEntry: Equatable {
    enum Source: Equatable {
        /// A downloaded entry: files live under `blobs/<sha256>`.
        case cache(URL)
        /// A bundled entry: files live under their own relative paths.
        case bundle(URL)
    }

    var manifest: PluginPageAssetsManifest
    var source: Source

    var pluginId: String { manifest.pluginId }
    var version: String { manifest.version }
    var revision: Int { manifest.revision }
    var entry: String { manifest.entry }

    var isBundled: Bool {
        if case .bundle = source { return true }
        return false
    }
}

enum PluginPageAssetStoreError: Error, Equatable {
    case invalidPluginId
    case notCached
    case hashMismatch(path: String)
    case tooLarge(path: String, bytes: Int)
    case unreadable(path: String)

    var message: String {
        switch self {
        case .invalidPluginId: return "That is not a plugin this phone will serve."
        case .notCached: return "This plugin's page has not been downloaded yet."
        case .hashMismatch(let path): return "\(path) did not match the hash the machine listed."
        case .tooLarge(let path, let bytes): return "\(path) is too large to sync (\(bytes) bytes)."
        case .unreadable(let path): return "Could not read \(path)."
        }
    }
}

// MARK: - The store

final class PluginPageAssetStore {
    /// The per-file ceiling the sync channel enforces. Checked again here
    /// because the cache is also written from the app bundle, which the sync
    /// channel never saw.
    static let maxFileBytes = 8 * 1024 * 1024

    /// The directory a bundled page ships in, relative to the app bundle's
    /// resources. See `apps/ios/ADE/Resources/BundledPluginPages/README.md`.
    static let bundledDirectoryName = "BundledPluginPages"

    /// The manifest inside a cache entry. Written LAST, so its presence is the
    /// signal that the entry is complete — a reader that finds none walks past.
    private static let manifestFileName = "manifest.json"
    private static let blobsDirectoryName = "blobs"

    private let root: URL
    private let bundleRoot: URL?
    private let fileManager: FileManager

    /// - Parameters:
    ///   - root: where downloaded entries live. Caches, not Documents: a page is
    ///     re-downloadable, so it must not consume the user's iCloud backup nor
    ///     survive as garbage the system cannot reclaim under pressure.
    ///   - bundleRoot: the app bundle's `BundledPluginPages`, or nil in a test.
    init(
        root: URL,
        bundleRoot: URL?,
        fileManager: FileManager = .default
    ) {
        self.root = root
        self.bundleRoot = bundleRoot
        self.fileManager = fileManager
    }

    /// The app's one store.
    ///
    /// A singleton because the cache IS shared: two surfaces opening the same
    /// plugin must not race each other into two half-written entries, and the
    /// eviction rule ("keep exactly the newest") only holds if one object owns
    /// the directory.
    static let shared = PluginPageAssetStore()

    convenience init(fileManager: FileManager = .default, bundle: Bundle = .main) {
        let caches = (try? fileManager.url(for: .cachesDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
            ?? URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        self.init(
            root: caches.appendingPathComponent("PluginPages", isDirectory: true),
            bundleRoot: bundle.resourceURL?.appendingPathComponent(Self.bundledDirectoryName, isDirectory: true),
            fileManager: fileManager
        )
    }

    // MARK: Reading

    /// The best page this phone can draw for a plugin, without any network.
    ///
    /// Precedence is by (version, revision), newest first, with ONE tie-break
    /// that matters: at equal version and revision the bundled entry wins. Its
    /// bytes shipped with the binary and were signed with it, so preferring the
    /// download would trade a verified copy for an equivalent unverified one and
    /// gain nothing.
    func resolve(pluginId: String) -> PluginPageCacheEntry? {
        guard PluginPageBridgeDecoder.isValidPluginPageId(pluginId) else { return nil }
        let candidates = cachedEntries(pluginId: pluginId) + bundledEntries(pluginId: pluginId)
        return candidates.max { left, right in
            if left.version != right.version {
                return compareVersions(left.version, right.version) == .orderedAscending
            }
            if left.revision != right.revision { return left.revision < right.revision }
            // Equal on both: the bundled copy sorts higher, so `max` returns it.
            return !right.isBundled ? false : !left.isBundled
        }
    }

    /// One file's bytes out of an entry, or nil.
    ///
    /// Nil is the only failure shape on purpose: the caller is a URL scheme
    /// handler, and every reason a file is unavailable — not listed, missing
    /// blob, a path that tried to leave the entry — is the same 404 or 403 to
    /// the page. Telling them apart would let a page map the phone's disk.
    func data(for entry: PluginPageCacheEntry, path: String) -> Data? {
        guard let listed = entry.manifest.file(at: path) else { return nil }
        switch entry.source {
        case .cache(let directory):
            let blob = directory
                .appendingPathComponent(Self.blobsDirectoryName, isDirectory: true)
                .appendingPathComponent(listed.sha256, isDirectory: false)
            return fileManager.contents(atPath: blob.path)
        case .bundle(let directory):
            // The one place a path from the manifest becomes a filesystem path,
            // so the one place containment is checked. A bundled manifest is
            // ours, but it is still a file on disk that a future build step
            // writes, and "we wrote it" is not a containment guarantee.
            guard let resolved = resolveWithin(root: directory, relative: path) else { return nil }
            return fileManager.contents(atPath: resolved.path)
        }
    }

    // MARK: Refreshing

    /// Bring a plugin's page up to what the machine currently serves.
    ///
    /// The diff is the point: the manifest arrives, every hash already on disk
    /// is skipped, and only what is genuinely new crosses the socket. A file
    /// whose bytes do not hash to what the manifest promised is REFUSED rather
    /// than stored — the cache is content-addressed, so storing it would file
    /// the wrong bytes under a hash every later manifest still points at, and no
    /// future refresh would ever repair it.
    ///
    /// Returns the entry to draw. When the machine already matches what is on
    /// disk this writes nothing and returns the existing entry.
    @discardableResult
    func refresh(pluginId: String, using fetcher: PluginPageAssetFetching) async throws -> PluginPageCacheEntry {
        guard PluginPageBridgeDecoder.isValidPluginPageId(pluginId) else {
            throw PluginPageAssetStoreError.invalidPluginId
        }
        let manifest = try await fetcher.fetchPluginPageAssetsManifest(pluginId: pluginId)
        let directory = entryDirectory(pluginId: pluginId, version: manifest.version, revision: manifest.revision)
        let blobs = directory.appendingPathComponent(Self.blobsDirectoryName, isDirectory: true)

        // A complete entry for exactly this version and revision is already the
        // answer. Re-verifying every blob would be a full re-read of the tree on
        // every open, and the manifest is only written once the blobs are there.
        if let existing = readEntry(at: directory), existing.manifest == manifest {
            evictOtherVersions(pluginId: pluginId, keeping: directory)
            return existing
        }

        try fileManager.createDirectory(at: blobs, withIntermediateDirectories: true)

        // Seed from anything already on disk before asking for a single byte: a
        // version bump that only moved the entry HTML re-downloads one file.
        let known = knownBlobHashes(pluginId: pluginId)
        for file in manifest.files {
            guard file.bytes <= Self.maxFileBytes else {
                throw PluginPageAssetStoreError.tooLarge(path: file.path, bytes: file.bytes)
            }
            let destination = blobs.appendingPathComponent(file.sha256, isDirectory: false)
            if fileManager.fileExists(atPath: destination.path) { continue }
            if let source = known[file.sha256], source != destination {
                try? fileManager.copyItem(at: source, to: destination)
                if fileManager.fileExists(atPath: destination.path) { continue }
            }
            let data = try await fetcher.fetchPluginPageAsset(pluginId: pluginId, path: file.path, sha256: file.sha256)
            guard PluginPageHashing.sha256Hex(data) == file.sha256.lowercased() else {
                throw PluginPageAssetStoreError.hashMismatch(path: file.path)
            }
            try data.write(to: destination, options: .atomic)
        }

        // LAST. Everything above can be interrupted and simply leaves blobs a
        // later refresh reuses; writing this first would publish an entry whose
        // files are not all there yet.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(manifest).write(to: directory.appendingPathComponent(Self.manifestFileName), options: .atomic)

        evictOtherVersions(pluginId: pluginId, keeping: directory)
        return PluginPageCacheEntry(manifest: manifest, source: .cache(directory))
    }

    // MARK: Eviction

    /// Drop every downloaded entry for a plugin except the one named.
    ///
    /// Eviction is per plugin and runs after a successful refresh, never on a
    /// timer: the only moment the phone knows an old version is dead is the
    /// moment a new one is complete. A bundled entry is never evicted — it is
    /// not ours to delete, it lives in the signed bundle.
    func evictOtherVersions(pluginId: String, keeping keep: URL?) {
        let pluginRoot = root.appendingPathComponent(pluginId, isDirectory: true)
        guard let children = try? fileManager.contentsOfDirectory(
            at: pluginRoot,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return }
        for child in children where child.standardizedFileURL != keep?.standardizedFileURL {
            try? fileManager.removeItem(at: child)
        }
    }

    /// Remove everything this plugin has cached. Used when a plugin is
    /// uninstalled or disabled, so a page cannot be opened out of a cache that
    /// outlived the install that justified it.
    func evictAll(pluginId: String) {
        guard PluginPageBridgeDecoder.isValidPluginPageId(pluginId) else { return }
        try? fileManager.removeItem(at: root.appendingPathComponent(pluginId, isDirectory: true))
    }

    // MARK: Internals

    private func entryDirectory(pluginId: String, version: String, revision: Int) -> URL {
        root
            .appendingPathComponent(pluginId, isDirectory: true)
            .appendingPathComponent("\(sanitize(version))__\(revision)", isDirectory: true)
    }

    /// Version strings reach disk as directory names, so anything that is not
    /// plainly a version character becomes an underscore. A host is supposed to
    /// have validated the version already; this is the second wall.
    private func sanitize(_ version: String) -> String {
        let allowed = Set("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-+")
        let mapped = version.map { allowed.contains($0) ? $0 : "_" }
        return String(mapped.prefix(64))
    }

    private func cachedEntries(pluginId: String) -> [PluginPageCacheEntry] {
        let pluginRoot = root.appendingPathComponent(pluginId, isDirectory: true)
        guard let children = try? fileManager.contentsOfDirectory(
            at: pluginRoot,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return [] }
        return children.compactMap { readEntry(at: $0) }
    }

    private func bundledEntries(pluginId: String) -> [PluginPageCacheEntry] {
        guard let bundleRoot else { return [] }
        let directory = bundleRoot.appendingPathComponent(pluginId, isDirectory: true)
        guard let manifest = readManifest(at: directory), manifest.pluginId == pluginId else { return [] }
        return [PluginPageCacheEntry(manifest: manifest, source: .bundle(directory))]
    }

    private func readEntry(at directory: URL) -> PluginPageCacheEntry? {
        guard let manifest = readManifest(at: directory) else { return nil }
        return PluginPageCacheEntry(manifest: manifest, source: .cache(directory))
    }

    private func readManifest(at directory: URL) -> PluginPageAssetsManifest? {
        let url = directory.appendingPathComponent(Self.manifestFileName)
        guard let data = fileManager.contents(atPath: url.path) else { return nil }
        return try? JSONDecoder().decode(PluginPageAssetsManifest.self, from: data)
    }

    /// Every blob this plugin already holds, by hash, across all its entries.
    private func knownBlobHashes(pluginId: String) -> [String: URL] {
        var known: [String: URL] = [:]
        let pluginRoot = root.appendingPathComponent(pluginId, isDirectory: true)
        guard let entries = try? fileManager.contentsOfDirectory(
            at: pluginRoot,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return known }
        for entry in entries {
            let blobs = entry.appendingPathComponent(Self.blobsDirectoryName, isDirectory: true)
            guard let files = try? fileManager.contentsOfDirectory(
                at: blobs,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
            ) else { continue }
            for file in files where known[file.lastPathComponent] == nil {
                known[file.lastPathComponent] = file
            }
        }
        return known
    }

    /// Resolve a relative path inside a root, or nil when it leaves.
    ///
    /// Symlinks are resolved before the comparison, which is the check a name
    /// test cannot make: `assets/link.css` looks contained right up until the
    /// link points at `/etc`.
    private func resolveWithin(root: URL, relative: String) -> URL? {
        guard !relative.isEmpty, !relative.hasPrefix("/"), !relative.contains("\u{0000}") else { return nil }
        let segments = relative.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
        guard !segments.isEmpty, !segments.contains("..") else { return nil }
        let candidate = segments.reduce(root) { $0.appendingPathComponent($1) }
        let rootReal = URL(fileURLWithPath: root.path).resolvingSymlinksInPath().standardizedFileURL.path
        let candidateReal = URL(fileURLWithPath: candidate.path).resolvingSymlinksInPath().standardizedFileURL.path
        guard candidateReal == rootReal || candidateReal.hasPrefix(rootReal + "/") else { return nil }
        return URL(fileURLWithPath: candidateReal)
    }

    /// Numeric-segment comparison, so `1.10.0` sorts above `1.9.0`.
    ///
    /// A lexicographic compare would pick `1.9.0`, which is how a phone ends up
    /// pinned to an old page forever after a plugin's tenth minor release.
    private func compareVersions(_ left: String, _ right: String) -> ComparisonResult {
        let leftParts = left.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 }
        let rightParts = right.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 }
        for index in 0..<max(leftParts.count, rightParts.count) {
            let lhs = index < leftParts.count ? leftParts[index] : 0
            let rhs = index < rightParts.count ? rightParts[index] : 0
            if lhs != rhs { return lhs < rhs ? .orderedAscending : .orderedDescending }
        }
        if left == right { return .orderedSame }
        return left < right ? .orderedAscending : .orderedDescending
    }
}

/// SHA-256, in the one spelling every part of this feature agrees on.
///
/// Lowercase hex, because that is what the host's `crypto.createHash(...).digest("hex")`
/// produces and what the manifest therefore carries. A comparison that had to
/// normalise case at each call site would eventually miss one.
enum PluginPageHashing {
    static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
