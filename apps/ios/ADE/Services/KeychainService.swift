import Foundation
import Security

final class KeychainService {
  private let service = "com.ade.ios.sync"
  private let tokenAccount = "connection-token"
  private let deviceIdAccount = "device-id"

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
}
