import Foundation
import Security

final class KeychainService {
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

  private func loadString(account: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    guard status == errSecSuccess, let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  private func clearString(account: String) {
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
