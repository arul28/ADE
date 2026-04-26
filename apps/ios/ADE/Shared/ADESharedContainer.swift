import Foundation

/// Shared access point for the App Group used by the main app, the Widget
/// extension, and the Notification Service extension.
///
/// The App Group identifier is the single source of truth and is used to
/// derive the shared `UserDefaults` suite and the on-disk container URL.
public enum ADESharedContainer {
    /// App Group identifier shared by the main app + extensions.
    public static let appGroupIdentifier = "group.com.ade.ios"

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

    /// Decodes the most recent snapshot, if any.
    public static func readWorkspaceSnapshot() -> WorkspaceSnapshot? {
        guard let data = defaults.data(forKey: workspaceSnapshotKey) else {
            return nil
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(WorkspaceSnapshot.self, from: data)
    }

    /// Encodes and stores the snapshot. Returns `true` when the write
    /// succeeded — callers can gate a `WidgetCenter.reloadAllTimelines` on it.
    @discardableResult
    public static func writeWorkspaceSnapshot(_ snapshot: WorkspaceSnapshot) -> Bool {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(snapshot) else { return false }
        defaults.set(data, forKey: workspaceSnapshotKey)
        return true
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
