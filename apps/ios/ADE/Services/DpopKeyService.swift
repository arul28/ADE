import CryptoKit
import Foundation
import Security

/// Device-bound proof-of-possession key for paired sync connections (DPoP).
///
/// The phone holds one P-256 private key — in the Secure Enclave when the
/// hardware allows, otherwise a software key persisted in the keychain (the
/// simulator has no enclave). Pairing registers the public key with the host;
/// every paired `hello` then signs a fresh challenge so a stolen paired secret
/// is useless without the key on this device. The challenge and signature
/// encoding match the runtime verifier in `apps/ade-cli/src/services/sync/syncDpop.ts`:
///
///   ade-dpop-v1 \n deviceId \n sha256(pairedSecret) \n timestamp \n nonce
///
/// signed as DER ECDSA-SHA256 (`.ecdsaSignatureMessageX962SHA256`).
final class DpopKeyService {
  static let shared = DpopKeyService()

  /// Canonical challenge context string. Kept in sync with `SYNC_DPOP_CONTEXT`.
  static let context = "ade-dpop-v1"
  static let relayReauthorizationContext = "ade-relay-reauth-v1"

  /// Keychain application tag identifying the single sync DPoP key.
  private let applicationTag = Data("com.ade.ios.sync.dpop.v1".utf8)

  private let lock = NSLock()
  private var cachedKey: SecKey?

  // MARK: - Public API

  /// Base64 X9.63 uncompressed (0x04 ‖ X ‖ Y, 65 bytes) P-256 public key, or
  /// `nil` when no key can be created (proof is then skipped — legacy path).
  func publicKeyX963Base64() -> String? {
    guard let privateKey = ensureKey(),
          let publicKey = SecKeyCopyPublicKey(privateKey) else {
      return nil
    }
    var error: Unmanaged<CFError>?
    guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
      return nil
    }
    return data.base64EncodedString()
  }

  /// Signs the canonical challenge and returns the base64 DER ECDSA-SHA256
  /// signature the host verifies with the registered public key.
  func signChallenge(
    deviceId: String,
    secretSha256Hex: String,
    timestamp: Int,
    nonce: String
  ) -> String? {
    let challenge = Self.buildChallenge(
      deviceId: deviceId,
      secretSha256Hex: secretSha256Hex,
      timestamp: timestamp,
      nonce: nonce
    )
    return signCanonicalChallenge(challenge)
  }

  /// Builds the whole DPoP proof dict attached to a paired `hello`. A fresh
  /// timestamp + single-use nonce are minted every call (never cache a proof).
  /// The inline `publicKey` is always included so the host can TOFU-upgrade a
  /// legacy pairing record; it is ignored once a key is on record.
  func buildProof(deviceId: String, secret: String) -> [String: Any]? {
    guard let publicKey = publicKeyX963Base64() else { return nil }
    let secretSha256Hex = Self.sha256Hex(secret)
    let timestamp = Int(Date().timeIntervalSince1970)
    let nonce = UUID().uuidString
    guard let signature = signChallenge(
      deviceId: deviceId,
      secretSha256Hex: secretSha256Hex,
      timestamp: timestamp,
      nonce: nonce
    ) else {
      return nil
    }
    return [
      "publicKey": publicKey,
      "timestamp": timestamp,
      "nonce": nonce,
      "signature": signature,
    ]
  }

  /// Builds a fresh proof over the exact host-issued Relay reauthorization
  /// challenge. The bearer token is only returned to callers alongside this
  /// device-key signature; callers must not send it if this method fails.
  func buildRelayReauthorizationProof(
    deviceId: String,
    relayAccountToken: String,
    challenge: String
  ) -> [String: Any]? {
    let timestamp = Int(Date().timeIntervalSince1970)
    let nonce = UUID().uuidString
    let canonical = Self.buildRelayReauthorizationChallenge(
      deviceId: deviceId,
      relayAccountTokenSha256Hex: Self.sha256Hex(relayAccountToken),
      challenge: challenge,
      timestamp: timestamp,
      nonce: nonce
    )
    guard let signature = signCanonicalChallenge(canonical) else { return nil }
    return [
      "timestamp": timestamp,
      "nonce": nonce,
      "signature": signature,
    ]
  }

  // MARK: - Pure helpers (testable)

  static func buildChallenge(
    deviceId: String,
    secretSha256Hex: String,
    timestamp: Int,
    nonce: String
  ) -> String {
    [context, deviceId, secretSha256Hex, String(timestamp), nonce].joined(separator: "\n")
  }

  static func buildRelayReauthorizationChallenge(
    deviceId: String,
    relayAccountTokenSha256Hex: String,
    challenge: String,
    timestamp: Int,
    nonce: String
  ) -> String {
    [
      relayReauthorizationContext,
      deviceId,
      relayAccountTokenSha256Hex,
      challenge,
      String(timestamp),
      nonce,
    ].joined(separator: "\n")
  }

  static func sha256Hex(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8))
      .map { String(format: "%02x", $0) }
      .joined()
  }

  // MARK: - Key material

  private func signCanonicalChallenge(_ challenge: String) -> String? {
    guard let privateKey = ensureKey(),
          let challengeData = challenge.data(using: .utf8) else {
      return nil
    }
    var error: Unmanaged<CFError>?
    guard let signature = SecKeyCreateSignature(
      privateKey,
      .ecdsaSignatureMessageX962SHA256,
      challengeData as CFData,
      &error
    ) as Data? else {
      return nil
    }
    return signature.base64EncodedString()
  }

  private func ensureKey() -> SecKey? {
    lock.lock()
    defer { lock.unlock() }
    if let cachedKey { return cachedKey }
    if let existing = loadPrivateKey() {
      cachedKey = existing
      return existing
    }
    // Prefer the Secure Enclave; fall back to a software key when the hardware
    // is unavailable (simulator) or enclave key creation is refused.
    let created = createPrivateKey(inSecureEnclave: true) ?? createPrivateKey(inSecureEnclave: false)
    cachedKey = created
    return created
  }

  private func loadPrivateKey() -> SecKey? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: applicationTag,
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    // Verify the CF type before casting so an unexpected item fails gracefully
    // instead of trapping (a conditional `as?` to a CF type always "succeeds",
    // so the compiler rejects it — check the CFTypeID explicitly).
    guard status == errSecSuccess, let item, CFGetTypeID(item) == SecKeyGetTypeID() else { return nil }
    return (item as! SecKey)
  }

  private func createPrivateKey(inSecureEnclave: Bool) -> SecKey? {
    var accessError: Unmanaged<CFError>?
    let flags: SecAccessControlCreateFlags = inSecureEnclave ? [.privateKeyUsage] : []
    guard let access = SecAccessControlCreateWithFlags(
      nil,
      kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      flags,
      &accessError
    ) else {
      return nil
    }

    let privateKeyAttributes: [String: Any] = [
      kSecAttrIsPermanent as String: true,
      kSecAttrApplicationTag as String: applicationTag,
      kSecAttrAccessControl as String: access,
    ]
    var attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits as String: 256,
      kSecPrivateKeyAttrs as String: privateKeyAttributes,
    ]
    if inSecureEnclave {
      attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
    }

    var error: Unmanaged<CFError>?
    return SecKeyCreateRandomKey(attributes as CFDictionary, &error)
  }
}
