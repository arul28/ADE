import CryptoKit
import Foundation
import LocalAuthentication
import Security

struct SSHStoredCredential: Codable, Equatable {
  let privateKey: String
  let passphrase: String
}

final class SSHCredentialStore {
  private let service = "com.ade.ios.ssh"

  func save(_ credential: SSHStoredCredential, host: String, port: Int, username: String) throws {
    guard let data = try? JSONEncoder().encode(credential) else {
      throw SSHBootstrapError.invalidPrivateKey
    }
    let account = account(host: host, port: port, username: username)
    let baseQuery: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    var accessError: Unmanaged<CFError>?
    guard let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      .biometryCurrentSet,
      &accessError
    ) else {
      if let accessError {
        throw accessError.takeRetainedValue()
      }
      throw SSHBootstrapError.invalidPrivateKey
    }
    let protectedValues: [String: Any] = [
      kSecAttrAccessControl as String: access,
      kSecValueData as String: data,
    ]
    var add = baseQuery
    protectedValues.forEach { add[$0.key] = $0.value }
    let addStatus = SecItemAdd(add as CFDictionary, nil)
    if addStatus == errSecDuplicateItem {
      let updateStatus = SecItemUpdate(baseQuery as CFDictionary, protectedValues as CFDictionary)
      guard updateStatus == errSecSuccess else {
        throw NSError(domain: NSOSStatusErrorDomain, code: Int(updateStatus))
      }
    } else if addStatus != errSecSuccess {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(addStatus))
    }
  }

  func load(host: String, port: Int, username: String) throws -> SSHStoredCredential? {
    let context = LAContext()
    context.localizedReason = "Use your saved SSH key to pair this ADE machine."
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account(host: host, port: port, username: username),
      kSecReturnData as String: true,
      kSecUseAuthenticationContext as String: context,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let data = result as? Data else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
    return try JSONDecoder().decode(SSHStoredCredential.self, from: data)
  }

  func remove(host: String, port: Int, username: String) {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account(host: host, port: port, username: username),
    ]
    SecItemDelete(query as CFDictionary)
  }

  private func account(host: String, port: Int, username: String) -> String {
    let canonical = "\(username.lowercased())@\(host.lowercased()):\(port)"
    let digest = SHA256.hash(data: Data(canonical.utf8))
    return digest.map { byte in
      let value = String(byte, radix: 16)
      return value.count == 1 ? "0\(value)" : value
    }.joined()
  }
}
