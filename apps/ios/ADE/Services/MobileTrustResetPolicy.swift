import Foundation

enum MobileTrustResetPolicy {
  static let migrationKey = "ade.sync.machineTrustReset.2026-07"

  /// Machine-scoped state that is unsafe or meaningless after pairing secrets
  /// are removed. Account/Clerk keys, device identity, DPoP identity, analytics
  /// preferences, and pairing-PIN state are intentionally absent.
  static let userDefaultsKeys = [
    "ade.sync.connectionDraft",
    "ade.sync.hostProfile",
    "ade.sync.hostProfiles",
    "ade.sync.activeProjectId",
    "ade.sync.activeProjectRootPath",
    "ade.sync.activeProjectHostIdentity",
    "ade.sync.hiddenProjects",
    "ade.sync.pendingOperations",
    "ade.sync.pendingChatCreations.v1",
    "ade.sync.remoteCommandDescriptors",
    "ade.sync.outboundSyncCursors",
    "ade.sync.pendingOutboundChangesets",
    "ade.sync.autoReconnectPausedByUser",
  ]

  @discardableResult
  static func applyIfNeeded(
    defaults: UserDefaults = .standard,
    keychain: KeychainService
  ) -> Bool {
    applyIfNeeded(defaults: defaults, clearConnectionTokens: keychain.clearAllConnectionTokens)
  }

  @discardableResult
  static func applyIfNeeded(
    defaults: UserDefaults,
    clearConnectionTokens: () -> Bool
  ) -> Bool {
    guard !defaults.bool(forKey: migrationKey) else { return false }
    guard clearConnectionTokens() else { return false }
    for key in userDefaultsKeys {
      defaults.removeObject(forKey: key)
    }
    defaults.set(true, forKey: migrationKey)
    return true
  }
}
