import Foundation
import os
import Security

/// The Security framework calls `KeychainService` makes: the process boundary
/// to securityd. The app uses `SecurityKeychainBackend`.
protocol KeychainBackend: AnyObject, Sendable {
  func copyMatching(_ query: [String: Any]) -> (status: OSStatus, item: CFTypeRef?)
  func add(_ attributes: [String: Any]) -> OSStatus
  func update(_ query: [String: Any], fields: [String: Any]) -> OSStatus
  func delete(_ query: [String: Any]) -> OSStatus
}

final class SecurityKeychainBackend: KeychainBackend {
  static let shared = SecurityKeychainBackend()

  func copyMatching(_ query: [String: Any]) -> (status: OSStatus, item: CFTypeRef?) {
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    return (status, item)
  }

  func add(_ attributes: [String: Any]) -> OSStatus {
    SecItemAdd(attributes as CFDictionary, nil)
  }

  func update(_ query: [String: Any], fields: [String: Any]) -> OSStatus {
    SecItemUpdate(query as CFDictionary, fields as CFDictionary)
  }

  func delete(_ query: [String: Any]) -> OSStatus {
    SecItemDelete(query as CFDictionary)
  }
}

final class KeychainService {
  /// Read-through cache of item values (nil = known absent), shared by every
  /// instance on the same backend and dropped on any write. Each keychain read
  /// is a round trip to securityd; the machine fleet reads every paired
  /// machine's token on the main thread, and those waits got the app
  /// watchdog-killed. Failed reads (a locked keychain before first unlock) are
  /// never cached, and a read stores its value only if no write landed while
  /// it ran.
  private struct Cache {
    var values: [String: String?] = [:]
    var generation = 0
  }
  private static let systemCache = OSAllocatedUnfairLock(initialState: Cache())

  private let backend: KeychainBackend
  private let cache: OSAllocatedUnfairLock<Cache>

  /// The app's keychain. Another backend gets a cache of its own.
  init(backend: KeychainBackend = SecurityKeychainBackend.shared) {
    self.backend = backend
    self.cache = backend === SecurityKeychainBackend.shared
      ? Self.systemCache
      : OSAllocatedUnfairLock(initialState: Cache())
  }

  private func invalidate(_ cacheKey: String?) {
    cache.withLock { state in
      state.generation &+= 1
      // Forget the key (unknown), unlike `.some(nil)`, which means "known absent".
      if let cacheKey { state.values.removeValue(forKey: cacheKey) } else { state.values.removeAll() }
    }
  }

  private let service = "com.ade.ios.sync"
  private let tokenAccount = "connection-token"
  private let deviceIdAccount = "device-id"
  private let accountDeviceOwnershipEpochPrefix = "attention-ownership-epoch:"
  private let accountDeviceKeyPrefix = "attention-device-key:"

  private func tokenAccount(for hostKey: String?) -> String {
    guard let hostKey, !hostKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
      return tokenAccount
    }
    return "\(tokenAccount):\(hostKey.trimmingCharacters(in: .whitespacesAndNewlines))"
  }

  private func legacyTokenAccount(for hostKey: String?) -> String? {
    guard let hostKey else { return nil }
    let trimmed = hostKey.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    return "\(tokenAccount).\(trimmed)"
  }

  /// Returns whether the Keychain stored the value. `accessible` applies when
  /// the item is new.
  @discardableResult
  private func saveString(
    _ value: String,
    account: String,
    accessible: CFString = kSecAttrAccessibleAfterFirstUnlock
  ) -> Bool {
    let cacheKey = self.cacheKey(account)
    // After the write, so a read racing it cannot cache the old value.
    defer { invalidate(cacheKey) }
    let data = Data(value.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let updateFields: [String: Any] = [kSecValueData as String: data]
    let updateStatus = backend.update(query, fields: updateFields)
    if updateStatus == errSecItemNotFound {
      var addQuery = query
      addQuery[kSecAttrAccessible as String] = accessible
      addQuery[kSecValueData as String] = data
      return backend.add(addQuery) == errSecSuccess
    }
    return updateStatus == errSecSuccess
  }

  private func cacheKey(_ account: String) -> String {
    "\(service)\u{0}\(account)"
  }

  /// A read that tells "not there" apart from "could not read". The keychain
  /// can refuse a read for a moment (before first unlock, or while securityd
  /// restarts); treating that as "not there" made the phone invent a new
  /// device id, and every computer then refused it as an unknown device.
  enum StoredRead: Equatable {
    case value(String)
    case absent
    case failed(OSStatus)
  }

  private func readString(account: String) -> StoredRead {
    let cacheKey = self.cacheKey(account)
    let (cached, generation) = cache.withLock { ($0.values[cacheKey], $0.generation) }
    if let cached {
      return cached.map(StoredRead.value) ?? .absent
    }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    let (status, item) = backend.copyMatching(query)
    let value: String?
    if status == errSecSuccess, let data = item as? Data {
      value = String(data: data, encoding: .utf8)
    } else if status == errSecItemNotFound {
      value = nil
    } else {
      return .failed(status)
    }
    cache.withLock { state in
      if state.generation == generation { state.values[cacheKey] = .some(value) }
    }
    return value.map(StoredRead.value) ?? .absent
  }

  /// The value, or nil when it is not there or could not be read. A caller
  /// that writes after a nil uses `readString` instead.
  private func loadString(account: String) -> String? {
    if case .value(let value) = readString(account: account) { return value }
    return nil
  }

  private func clearString(account: String) {
    let cacheKey = self.cacheKey(account)
    defer { invalidate(cacheKey) }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    _ = backend.delete(query)
  }

  func saveToken(_ token: String) {
    saveString(token, account: tokenAccount)
  }

  func saveToken(_ token: String, hostKey: String?) {
    saveString(token, account: tokenAccount(for: hostKey))
  }

  func loadToken() -> String? {
    loadString(account: tokenAccount)
  }

  func loadToken(hostKey: String?) -> String? {
    if case .value(let token) = readToken(hostKey: hostKey) { return token }
    return nil
  }

  /// The pairing secret of one computer. A legacy item moves to the new name
  /// only when the new one is not there: a failed read never writes.
  func readToken(hostKey: String?) -> StoredRead {
    let newAccount = tokenAccount(for: hostKey)
    let current = readString(account: newAccount)
    guard case .absent = current else { return current }
    if let legacyAccount = legacyTokenAccount(for: hostKey),
       case .value(let migrated) = readString(account: legacyAccount) {
      saveString(migrated, account: newAccount)
      clearString(account: legacyAccount)
      return .value(migrated)
    }
    return .absent
  }

  /// One computer's pairing secret: its own slot (`key`), then its older
  /// names, then (when asked) the last paired secret. A failed read stops the
  /// search: an older name may hold a stale secret, a computer refuses a stale
  /// one as an unknown device, and the phone would then drop the pairing.
  /// `migrate` moves a secret found under an older name into the slot.
  func readPairedSecret(
    key: String?,
    legacyKeys: [String],
    migrate: Bool,
    fallbackToLastPaired: Bool
  ) -> StoredRead {
    if let key {
      let current = readToken(hostKey: key)
      guard case .absent = current else { return current }
    }
    for legacyKey in legacyKeys {
      switch readToken(hostKey: legacyKey) {
      case .value(let token):
        if migrate, let key {
          saveToken(token, hostKey: key)
          clearToken(hostKey: legacyKey)
        }
        return .value(token)
      case .failed(let status):
        return .failed(status)
      case .absent:
        continue
      }
    }
    return fallbackToLastPaired ? readString(account: tokenAccount) : .absent
  }

  func clearToken() {
    clearString(account: tokenAccount)
  }

  func clearToken(hostKey: String?) {
    clearString(account: tokenAccount(for: hostKey))
  }

  func saveDeviceId(_ deviceId: String) {
    saveString(deviceId, account: deviceIdAccount)
  }

  func loadDeviceId() -> String? {
    loadString(account: deviceIdAccount)
  }

  /// The ADE account's GitHub App token record (`GitHubAccountTokenRecord`,
  /// JSON). One record; it names the account it belongs to.
  private let githubAccountTokenAccount = "github-account-app.v1"

  /// This device only: a backup restored on another phone does not carry it.
  func saveGitHubAccountToken(_ json: String) {
    saveString(json, account: githubAccountTokenAccount, accessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly)
  }

  func readGitHubAccountToken() -> StoredRead {
    readString(account: githubAccountTokenAccount)
  }

  func clearGitHubAccountToken() {
    clearString(account: githubAccountTokenAccount)
  }

  /// The device id with the reason when there is none (see `StoredRead`).
  func readDeviceId() -> StoredRead {
    readString(account: deviceIdAccount)
  }

  func saveAccountDeviceOwnershipEpoch(_ epoch: Int, deviceId: String) {
    guard epoch > 0,
          let account = accountDeviceOwnershipEpochAccount(deviceId: deviceId) else {
      return
    }
    // The epoch only moves up. After a failed read the stored one may be
    // higher than the caller knows: write nothing.
    switch readString(account: account) {
    case .failed: return
    case .value(let raw): if let stored = Int(raw), stored >= epoch { return }
    case .absent: break
    }
    saveString(String(epoch), account: account)
  }

  func loadAccountDeviceOwnershipEpoch(deviceId: String) -> Int? {
    guard case .value(let raw) = readAccountDeviceOwnershipEpoch(deviceId: deviceId) else { return nil }
    return Int(raw)
  }

  func readAccountDeviceOwnershipEpoch(deviceId: String) -> StoredRead {
    guard let account = accountDeviceOwnershipEpochAccount(deviceId: deviceId) else { return .absent }
    return readString(account: account)
  }

  private func accountDeviceOwnershipEpochAccount(deviceId: String) -> String? {
    let normalized = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return nil }
    return "\(accountDeviceOwnershipEpochPrefix)\(normalized)"
  }

  /// The secret Relay issued to this installation's device id. It proves to
  /// Relay that a later account on this phone is the same install, so it lives
  /// exactly as long as the device id and its ownership epoch.
  /// Returns whether the key was stored.
  @discardableResult
  func saveAccountDeviceKey(_ key: String, deviceId: String) -> Bool {
    guard !key.isEmpty, let account = accountDeviceKeyAccount(deviceId: deviceId) else {
      return false
    }
    return saveString(key, account: account)
  }

  /// A failed read is not "no key": registering without the key would make
  /// Relay issue a new one over it.
  func readAccountDeviceKey(deviceId: String) -> StoredRead {
    guard let account = accountDeviceKeyAccount(deviceId: deviceId) else { return .absent }
    return readString(account: account)
  }

  private func accountDeviceKeyAccount(deviceId: String) -> String? {
    let normalized = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return nil }
    return "\(accountDeviceKeyPrefix)\(normalized)"
  }

  /// Removes every saved machine pairing secret while preserving this
  /// installation's device identity, ownership epoch and device key. Used by the versioned
  /// trust reset: ADE must not accidentally revive a pre-reset machine through
  /// a keyed or legacy token alias.
  @discardableResult
  func clearAllConnectionTokens() -> Bool {
    defer { invalidate(nil) }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnAttributes as String: true,
    ]
    let (status, result) = backend.copyMatching(query)
    if status == errSecItemNotFound { return true }
    guard status == errSecSuccess else { return false }
    let items: [[String: Any]]
    if let allItems = result as? [[String: Any]] {
      items = allItems
    } else if let item = result as? [String: Any] {
      items = [item]
    } else {
      return false
    }
    for item in items {
      guard let account = item[kSecAttrAccount as String] as? String,
            account == tokenAccount || account.hasPrefix("\(tokenAccount):") || account.hasPrefix("\(tokenAccount).") else {
        continue
      }
      let deleteQuery: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: service,
        kSecAttrAccount as String: account,
      ]
      let deleteStatus = backend.delete(deleteQuery)
      guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
        return false
      }
    }
    return true
  }
}
