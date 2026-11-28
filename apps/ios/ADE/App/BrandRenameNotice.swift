import Foundation

/// Who sees the Hub's "ADE is now DAEX" notice: only an install that ran
/// before the rename. A new install starts with it already seen.
enum BrandRenameNotice {
  static let seenKey = "ade.brand.renameNoticeSeen.v1"

  /// The notice's text: only the name changed, and the old command and links still work.
  static var message: String {
    "\(Brand.introName): only the name changed. Your projects, chats and settings stay as they are, "
      + "the \(Brand.legacyCLI) command still works, and \(Brand.legacyDomain) links still open."
  }

  /// Decides once per install. Call at launch before `SyncService` exists
  /// and before `ADEColorSchemeChoice.seedDefaultIfNeeded`: both write what
  /// this reads as "ran before" on the first launch.
  ///
  /// The install ran before when `InstallHistory` finds a device id, or when
  /// an earlier launch saved a color scheme. A keychain that refuses the read
  /// decides nothing; a later launch does.
  static func seedIfNeeded(_ defaults: UserDefaults = .standard, keychain: KeychainService = KeychainService()) {
    guard defaults.object(forKey: seenKey) == nil else { return }
    guard let hadDeviceId = InstallHistory.ranBefore(defaults, keychain: keychain) else { return }
    let ranBefore = hadDeviceId || defaults.string(forKey: ADEColorSchemeChoice.storageKey) != nil
    defaults.set(!ranBefore, forKey: seenKey)
  }
}
