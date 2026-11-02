import Foundation

public struct ADEAccountDeviceOwnershipState: Codable, Equatable {
    public let ownershipEpoch: Int
    public let ownerId: String?
}

/// Shared access point for the App Group used by the main app and the Widget
/// extension.
///
/// The App Group identifier is the single source of truth and is used to
/// derive the shared `UserDefaults` suite and the on-disk container URL.
public enum ADESharedContainer {
    /// App Group identifier shared by the main app + extensions. The ADE Beta
    /// app (`Beta` build configuration) has its own group, so it never reads
    /// or writes the normal app's data.
    #if ADE_BETA_APP
    public static let appGroupIdentifier = "group.com.ade.ios.beta"
    #else
    public static let appGroupIdentifier = "group.com.ade.ios"
    #endif

    /// Shared `UserDefaults` for cross-process preferences and small snapshots.
    ///
    /// Falls back to `.standard` if the App Group entitlement is missing so
    /// test/dev builds without entitlements still work — widgets will not read
    /// real data in that case, but the app will not crash.
    public static let defaults: UserDefaults = {
        guard FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ) != nil else {
            return .standard
        }
        return UserDefaults(suiteName: appGroupIdentifier) ?? .standard
    }()

    /// Root URL of the shared on-disk container. `nil` when the entitlement is
    /// not configured (e.g. unit tests, previews). Callers must guard against
    /// nil — we deliberately do not fall back to a temporary directory to avoid
    /// silently splitting state between app and extensions.
    public static var containerURL: URL? {
        FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        )
    }

    /// Path to the shared SQLite file used for the roster + PR snapshots
    /// written by the app and read by widgets.
    public static var sharedDatabaseURL: URL? {
        containerURL?.appendingPathComponent("ade-shared.sqlite")
    }

    // MARK: - Snapshot helpers (JSON in UserDefaults)

    /// Key under which the current `WorkspaceSnapshot` JSON blob is stored.
    /// Widgets read it in their `TimelineProvider`; the main app writes it and
    /// calls `WidgetCenter.shared.reloadAllTimelines()` on change.
    public static let workspaceSnapshotKey = "ade.workspaceSnapshot"
    public static let attentionSnapshotKey = "ade.attentionSnapshot.v1"
    /// Unix seconds of the last *successful* account-snapshot write on this
    /// device. Distinct from the snapshot's own `generatedAt`, which is a relay
    /// clock: this one answers "when did this phone last actually hear
    /// anything", which is the question a widget rendering a cache has to be
    /// able to answer out loud.
    public static let attentionSnapshotFetchedAtKey = "ade.attentionSnapshot.fetchedAt.v1"
    public static let attentionPendingAcksKey = "ade.attentionPendingAcks.v1"
    public static let pushPreferencesKey = "ade.push.prefs"
    public static let pendingAccountDeviceRevocationKey =
        "ade.attention.pending-account-device-revocation.v1"
    public static let accountDeviceOwnershipStateKey =
        "ade.attention.account-device-ownership.v1"
    public static let pendingAccountActivityTokenKey =
        "ade.attention.pending-account-activity-token.v1"

    /// Privacy preference shared with Lock Screen widgets and Live Activities.
    /// Decode only the field extensions need so app-side preference evolution
    /// does not couple WidgetKit to the full settings model.
    public static var hideAttentionDetails: Bool {
        guard let data = defaults.data(forKey: pushPreferencesKey) else {
            return false
        }
        return (try? JSONDecoder().decode(SharedPushPrivacyPreferences.self, from: data).hideDetails) ?? false
    }

    /// Decodes the most recent snapshot, if any.
    public static func readWorkspaceSnapshot() -> WorkspaceSnapshot? {
        guard let data = defaults.data(forKey: workspaceSnapshotKey) else {
            return nil
        }
        return workspaceSnapshotMemo.value(for: data) {
            try? attentionJSONDecoder.decode(WorkspaceSnapshot.self, from: data)
        }
    }

    /// Encodes and stores the snapshot. Returns `true` when the write
    /// succeeded — callers can gate a `WidgetCenter.reloadAllTimelines` on it.
    @discardableResult
    public static func writeWorkspaceSnapshot(_ snapshot: WorkspaceSnapshot) -> Bool {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(snapshot) else { return false }
        defaults.set(data, forKey: workspaceSnapshotKey)
        defaults.synchronize()
        return true
    }

    /// Account-wide snapshot written by the signed-in attention transport.
    /// This is additive: callers fall back to `WorkspaceSnapshot` until the
    /// account publisher has produced a revision for this device.
    public static func readAttentionSnapshot() -> AccountAttentionSnapshot? {
        guard let data = defaults.data(forKey: attentionSnapshotKey) else {
            return nil
        }
        guard let snapshot = attentionSnapshotMemo.value(for: data, decode: { decodeAttentionSnapshot(from: data) }),
              snapshot.contractVersion == ADEAttentionContractVersion else {
            return nil
        }
        return snapshot
    }

    public static func decodeAttentionSnapshot(from data: Data) -> AccountAttentionSnapshot? {
        try? attentionJSONDecoder.decode(AccountAttentionSnapshot.self, from: data)
    }

    /// Encode-then-store: the JSON is built before either key is touched, so a
    /// failed encode leaves the previous snapshot and its freshness marker
    /// intact rather than half-updating the pair. `UserDefaults` writes each
    /// key atomically, and a widget that reads the snapshot microseconds before
    /// the marker lands simply reports itself a moment staler than it is —
    /// which is the safe direction to be wrong in.
    @discardableResult
    public static func writeAttentionSnapshot(
        _ snapshot: AccountAttentionSnapshot,
        fetchedAt: Date = Date()
    ) -> Bool {
        guard snapshot.contractVersion == ADEAttentionContractVersion else { return false }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(snapshot) else { return false }
        defaults.set(data, forKey: attentionSnapshotKey)
        defaults.set(fetchedAt.timeIntervalSince1970, forKey: attentionSnapshotFetchedAtKey)
        defaults.synchronize()
        return true
    }

    /// When this device last wrote a snapshot, or `nil` if it never has (or
    /// wrote one before the marker existed).
    public static var attentionSnapshotFetchedAt: Date? {
        guard defaults.object(forKey: attentionSnapshotFetchedAtKey) != nil else { return nil }
        let seconds = defaults.double(forKey: attentionSnapshotFetchedAtKey)
        guard seconds > 0, seconds.isFinite, seconds < 3_200_000_000 else { return nil }
        return Date(timeIntervalSince1970: seconds)
    }

    public static func clearAttentionSnapshot() {
        defaults.removeObject(forKey: attentionSnapshotKey)
        defaults.removeObject(forKey: attentionSnapshotFetchedAtKey)
        defaults.synchronize()
    }

    /// Shared ownership fence used by Live Activity rendering. The widget
    /// extension must be able to reject stale account content before the main
    /// app wakes and ends the ActivityKit instance.
    public static func readAccountDeviceOwnershipState() -> ADEAccountDeviceOwnershipState? {
        guard let data = defaults.data(forKey: accountDeviceOwnershipStateKey),
              let state = try? JSONDecoder().decode(
                  ADEAccountDeviceOwnershipState.self,
                  from: data
              ),
              state.ownershipEpoch > 0,
              state.ownershipEpoch <= 9_007_199_254_740_991 else {
            return nil
        }
        return state
    }

    /// Relay timestamps include fractional seconds while Swift-written widget
    /// snapshots historically did not. Accept both shapes (and unix seconds)
    /// so one malformed timestamp never blanks an otherwise valid snapshot.
    ///
    /// One shared decoder with value-type parse styles: the app re-reads these
    /// snapshots on the main thread whenever sessions change, and building two
    /// ICU-backed `ISO8601DateFormatter`s per date there hung the app.
    /// `JSONDecoder` is `Sendable`, so callers on any thread may share it.
    private static let attentionJSONDecoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            if let seconds = try? container.decode(Double.self) {
                guard seconds.isFinite, abs(seconds) < 3_200_000_000 else {
                    throw DecodingError.dataCorruptedError(
                        in: container,
                        debugDescription: "Attention timestamp is outside the supported range"
                    )
                }
                return Date(timeIntervalSince1970: seconds)
            }
            let raw = try container.decode(String.self)
            if let date = try? fractionalISO8601.parse(raw) {
                return date
            }
            if let date = try? standardISO8601.parse(raw) {
                return date
            }
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Invalid ISO-8601 attention timestamp"
            )
        }
        return decoder
    }()

    private static let fractionalISO8601 = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
    private static let standardISO8601 = Date.ISO8601FormatStyle()

    /// The last decoded snapshot per key, reused while the stored bytes are
    /// unchanged. Several observers re-read the same blob after every session
    /// change; comparing bytes is far cheaper than decoding them again.
    private static let workspaceSnapshotMemo = DecodedBlobMemo<WorkspaceSnapshot>()
    private static let attentionSnapshotMemo = DecodedBlobMemo<AccountAttentionSnapshot>()

    private struct SharedPushPrivacyPreferences: Decodable {
        let hideDetails: Bool

        private enum CodingKeys: String, CodingKey {
            case hideDetails
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            hideDetails = try container.decodeIfPresent(Bool.self, forKey: .hideDetails) ?? false
        }
    }

    /// One-line summary used by the lock-screen inline accessory and the
    /// accessory-rectangular mono line. Picks the "most interesting" open PR
    /// (CI failing > review requested > merge ready > first open) and pairs it
    /// with the active agent count.
    ///
    /// Format: `"ADE · N agents · #NNN ✗"` / `"ADE · N agents"` / `"ADE · idle"`.
    public static func inlineSummary(for snapshot: WorkspaceSnapshot? = nil) -> String {
        let s = snapshot ?? readWorkspaceSnapshot() ?? .empty
        let runningAgents = s.runningAgents.count
        let openPrs = s.prs.filter { $0.state == "open" }
        let focusedPr: PrSnapshot? = openPrs.first(where: { $0.checks == "failing" })
            ?? openPrs.first(where: { $0.review == "changes_requested" || $0.review == "pending" })
            ?? openPrs.first(where: { $0.mergeReady })
            ?? openPrs.first

        if runningAgents == 0 && focusedPr == nil
            && s.awaitingInputCount == 0 && s.idleCount == 0 {
            return "ADE · idle"
        }
        var pieces: [String] = ["ADE"]
        if runningAgents > 0 {
            pieces.append("\(runningAgents) running")
        } else if s.awaitingInputCount > 0 {
            pieces.append("\(s.awaitingInputCount) waiting")
        } else if s.idleCount > 0 {
            pieces.append("\(s.idleCount) idle")
        }
        if let pr = focusedPr {
            let mark: String
            switch pr.checks {
            case "failing": mark = "✗"
            case "passing": mark = pr.mergeReady ? "✓" : "·"
            default:        mark = "·"
            }
            pieces.append("#\(pr.number) \(mark)")
        }
        return pieces.joined(separator: " · ")
    }
}

/// Remembers one decoded value and the bytes it came from. Thread-safe; the
/// decode itself runs outside the lock.
private final class DecodedBlobMemo<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    private var value: Value?

    func value(for data: Data, decode: () -> Value?) -> Value? {
        lock.lock()
        if let cached = value, self.data == data {
            lock.unlock()
            return cached
        }
        lock.unlock()
        let decoded = decode()
        lock.lock()
        self.data = decoded == nil ? nil : data
        value = decoded
        lock.unlock()
        return decoded
    }
}
