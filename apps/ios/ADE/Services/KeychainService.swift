import Foundation
import os
import Security

final class KeychainService {
  /// Read-through cache of item values (nil = known absent), shared by every
  /// instance in the process and dropped on any write. Each keychain read is a
  /// round trip to securityd; the machine fleet reads every paired machine's
  /// token on the main thread, and those waits got the app watchdog-killed.
  /// Failed reads (a locked keychain before first unlock) are never cached,
  /// and a read stores its value only if no write landed while it ran.
  private struct Cache {
    var values: [String: String?] = [:]
    var generation = 0
  }
  private static let cache = OSAllocatedUnfairLock(initialState: Cache())

  private static func invalidate(_ cacheKey: String?) {
    cache.withLock { state in
      state.generation &+= 1
      if let cacheKey { state.values[cacheKey] = nil } else { state.values.removeAll() }
    }
  }

  private let service = "com.ade.ios.sync"
  private let tokenAccount = "connection-token"
  private let deviceIdAccount = "device-id"
  private let accountDeviceOwnershipEpochPrefix = "attention-ownership-epoch:"

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

  private func saveString(_ value: String, account: String) {
    let cacheKey = self.cacheKey(account)
    // After the write, so a read racing it cannot cache the old value.
    defer { Self.invalidate(cacheKey) }
    let data = Data(value.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let updateFields: [String: Any] = [kSecValueData as String: data]
    let updateStatus = SecItemUpdate(query as CFDictionary, updateFields as CFDictionary)
    if updateStatus == errSecItemNotFound {
      var addQuery = query
      addQuery[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      addQuery[kSecValueData as String] = data
      SecItemAdd(addQuery as CFDictionary, nil)
    }
  }

  private func cacheKey(_ account: String) -> String {
    "\(service)\u{0}\(account)"
  }

  private func loadString(account: String) -> String? {
    let cacheKey = self.cacheKey(account)
    let (cached, generation) = Self.cache.withLock { ($0.values[cacheKey], $0.generation) }
    if let cached {
      return cached
    }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    let value: String?
    if status == errSecSuccess, let data = item as? Data {
      value = String(data: data, encoding: .utf8)
    } else if status == errSecItemNotFound {
      value = nil
    } else {
      return nil
    }
    Self.cache.withLock { state in
      if state.generation == generation { state.values[cacheKey] = .some(value) }
    }
    return value
  }

  private func clearString(account: String) {
    let cacheKey = self.cacheKey(account)
    defer { Self.invalidate(cacheKey) }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    SecItemDelete(query as CFDictionary)
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
    let newAccount = tokenAccount(for: hostKey)
    if let token = loadString(account: newAccount) {
      return token
    }
    if let legacyAccount = legacyTokenAccount(for: hostKey),
       let migrated = loadString(account: legacyAccount) {
      saveString(migrated, account: newAccount)
      clearString(account: legacyAccount)
      return migrated
    }
    return nil
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

  func saveAccountDeviceOwnershipEpoch(_ epoch: Int, deviceId: String) {
    guard epoch > 0,
          let account = accountDeviceOwnershipEpochAccount(deviceId: deviceId) else {
      return
    }
    saveString(String(epoch), account: account)
  }

  func loadAccountDeviceOwnershipEpoch(deviceId: String) -> Int? {
    guard let account = accountDeviceOwnershipEpochAccount(deviceId: deviceId),
          let raw = loadString(account: account) else {
      return nil
    }
    return Int(raw)
  }

  private func accountDeviceOwnershipEpochAccount(deviceId: String) -> String? {
    let normalized = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else { return nil }
    return "\(accountDeviceOwnershipEpochPrefix)\(normalized)"
  }

  /// Removes every saved machine pairing secret while preserving this
  /// installation's device identity and ownership epoch. Used by the versioned
  /// trust reset: ADE must not accidentally revive a pre-reset machine through
  /// a keyed or legacy token alias.
  @discardableResult
  func clearAllConnectionTokens() -> Bool {
    defer { Self.invalidate(nil) }
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecMatchLimit as String: kSecMatchLimitAll,
      kSecReturnAttributes as String: true,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
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
      let deleteStatus = SecItemDelete(deleteQuery as CFDictionary)
      guard deleteStatus == errSecSuccess || deleteStatus == errSecItemNotFound else {
        return false
      }
    }
    return true
  }
}
