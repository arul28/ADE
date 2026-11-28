import Foundation

/// Whether this install ran before, read from what an earlier launch left.
///
/// Read it at launch before `SyncService` exists: `SyncService` writes the
/// device id on the first launch, after which every install looks like one
/// that ran before. `ADEApp` seeds its first-launch defaults from this in its
/// first stored property for that reason.
enum InstallHistory {
  /// The device id `SyncService` keeps in defaults (its `legacyDeviceIdKey`).
  private static let deviceIdKey = "ade.sync.deviceId"

  /// True when an earlier launch left a device id: in defaults, or the
  /// Keychain copy, which outlives an uninstall (so a reinstalled app still
  /// counts as one that ran before). Nil when the Keychain refuses the read
  /// (a launch before the first unlock, when defaults read empty as well):
  /// that launch can decide nothing, and a later one does.
  static func ranBefore(_ defaults: UserDefaults = .standard, keychain: KeychainService = KeychainService()) -> Bool? {
    switch keychain.readDeviceId() {
    case .failed: return nil
    case .value: return true
    case .absent: return defaults.string(forKey: deviceIdKey) != nil
    }
  }
}
