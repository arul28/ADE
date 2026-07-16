import XCTest
import Security
@testable import ADE

/// Covers the pairing-QR codec (parity with `apps/desktop/src/shared/pairingQr.ts`)
/// and the DPoP challenge/signature contract (parity with
/// `apps/ade-cli/src/services/sync/syncDpop.ts`).
final class PairingAndDpopTests: XCTestCase {
  // A canonical smart URL produced by the TS `encodePairingQrUrl` (includes an
  // unknown extra field to prove lenient forward-compat parsing).
  private let canonicalPairingUrl = "https://ade-app.dev/pair#eyJ2ZXJzaW9uIjozLCJob3N0SWRlbnRpdHkiOnsiZGV2aWNlSWQiOiJkZXYtYWJjMTIzIiwic2l0ZUlkIjoic2l0ZS14eXoiLCJuYW1lIjoiQXJ1bCBNYWNCb29rIiwicGxhdGZvcm0iOiJtYWNPUyIsImRldmljZVR5cGUiOiJkZXNrdG9wIn0sInBvcnQiOjg3ODcsImFkZHJlc3NDYW5kaWRhdGVzIjpbeyJob3N0IjoiMTkyLjE2OC4xLjQyIiwia2luZCI6ImxhbiJ9LHsiaG9zdCI6IjEwMC4xMDEuMTAyLjEwMyIsImtpbmQiOiJ0YWlsc2NhbGUifSx7Imhvc3QiOiJ3c3M6Ly9yZWxheS5hZGUtYXBwLmRldi9jb25uZWN0L21hY2hpbmVrZXkxMjMiLCJraW5kIjoicmVsYXkifV0sInJlbGF5VXJsIjoid3NzOi8vcmVsYXkuYWRlLWFwcC5kZXYvY29ubmVjdC9tYWNoaW5la2V5MTIzIiwiZXh0cmFGdXR1cmVGaWVsZCI6Imlnbm9yZWQifQ"

  // MARK: - Pairing QR codec

  func testParsesCanonicalSmartUrl() throws {
    let payload = try XCTUnwrap(PairingQrPayload.parse(canonicalPairingUrl))
    XCTAssertEqual(payload.version, 3)
    XCTAssertEqual(payload.hostIdentity.deviceId, "dev-abc123")
    XCTAssertEqual(payload.hostIdentity.siteId, "site-xyz")
    XCTAssertEqual(payload.hostIdentity.name, "Arul MacBook")
    XCTAssertEqual(payload.hostIdentity.platform, "macOS")
    XCTAssertEqual(payload.hostIdentity.deviceType, "desktop")
    XCTAssertEqual(payload.port, 8787)
    XCTAssertEqual(payload.addressCandidates.count, 3)
    XCTAssertEqual(payload.addressCandidates[0], PairingQrAddressCandidate(host: "192.168.1.42", kind: "lan"))
    XCTAssertEqual(payload.addressCandidates[1], PairingQrAddressCandidate(host: "100.101.102.103", kind: "tailscale"))
    // Relay candidate carries a full wss:// URL in `host`.
    XCTAssertEqual(payload.addressCandidates[2], PairingQrAddressCandidate(host: "wss://relay.ade-app.dev/connect/machinekey123", kind: "relay"))
    XCTAssertEqual(payload.relayUrl, "wss://relay.ade-app.dev/connect/machinekey123")
    XCTAssertNil(payload.pinConfigured)
  }

  func testParsesBareFragmentPayload() throws {
    // The base64url payload alone (no URL wrapper) must also parse.
    let fragment = try XCTUnwrap(canonicalPairingUrl.split(separator: "#").last).description
    let payload = try XCTUnwrap(PairingQrPayload.parse(fragment))
    XCTAssertEqual(payload.hostIdentity.deviceId, "dev-abc123")
  }

  func testParsesRawJson() throws {
    let json = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box","platform":"linux","deviceType":"vps"},"port":9000,"addressCandidates":[]}"#
    let payload = try XCTUnwrap(PairingQrPayload.parse(json))
    XCTAssertEqual(payload.hostIdentity.deviceId, "d1")
    XCTAssertEqual(payload.port, 9000)
    XCTAssertNil(payload.relayUrl)
  }

  func testDropsNonWssRelayUrl() throws {
    let json = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[],"relayUrl":"ws://relay.ade-app.dev/x"}"#
    let payload = try XCTUnwrap(PairingQrPayload.parse(json))
    XCTAssertNil(payload.relayUrl)
  }

  func testParsesOptionalLiteralPinConfiguredHint() throws {
    let configured = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[],"pinConfigured":true}"#
    let notConfigured = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[],"pinConfigured":false}"#
    let absent = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[]}"#
    let invalid = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[],"pinConfigured":"false"}"#
    let numeric = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[],"pinConfigured":1}"#

    XCTAssertEqual(try XCTUnwrap(PairingQrPayload.parse(configured)).pinConfigured, true)
    XCTAssertEqual(try XCTUnwrap(PairingQrPayload.parse(notConfigured)).pinConfigured, false)
    XCTAssertNil(try XCTUnwrap(PairingQrPayload.parse(absent)).pinConfigured)
    XCTAssertNil(try XCTUnwrap(PairingQrPayload.parse(invalid)).pinConfigured)
    XCTAssertNil(try XCTUnwrap(PairingQrPayload.parse(numeric)).pinConfigured)
  }

  func testRejectsOlderVersion() {
    let json = #"{"version":2,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":8787,"addressCandidates":[]}"#
    XCTAssertNil(PairingQrPayload.parse(json))
  }

  func testRejectsMissingDeviceId() {
    let json = #"{"version":3,"hostIdentity":{"name":"Box"},"port":8787,"addressCandidates":[]}"#
    XCTAssertNil(PairingQrPayload.parse(json))
  }

  func testRejectsInvalidPort() {
    let json = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box"},"port":0,"addressCandidates":[]}"#
    XCTAssertNil(PairingQrPayload.parse(json))
  }

  func testRejectsGarbage() {
    XCTAssertNil(PairingQrPayload.parse("not a code"))
    XCTAssertNil(PairingQrPayload.parse(""))
    XCTAssertNil(PairingQrPayload.parse("https://ade-app.dev/pair"))
  }

  func testNormalizesUnknownPlatformAndDeviceType() throws {
    let json = #"{"version":3,"hostIdentity":{"deviceId":"d1","name":"Box","platform":"beos","deviceType":"toaster"},"port":8787,"addressCandidates":[]}"#
    let payload = try XCTUnwrap(PairingQrPayload.parse(json))
    XCTAssertEqual(payload.hostIdentity.platform, "unknown")
    XCTAssertEqual(payload.hostIdentity.deviceType, "unknown")
  }

  func testPairingFailureCodesMapPinNotSetToTypedState() {
    XCTAssertEqual(SyncPairingFailureCode(hostCode: "pin_not_set"), .pinNotSet)
    XCTAssertEqual(SyncPairingFailureCode(hostCode: "invalid_pin"), .invalidPin)
    XCTAssertEqual(SyncPairingFailureCode(hostCode: "new_host_code"), .other("new_host_code"))
    XCTAssertNil(SyncPairingFailureCode(hostCode: nil))
    XCTAssertEqual(SyncPairingFailureCode.pinNotSet.hostCode, "pin_not_set")
  }

  // MARK: - DPoP challenge + signature

  func testChallengeBuilderMatchesRuntimeFormat() {
    let secretSha256Hex = "33e29618af5c636e782cfadefb698192ef7b2d8e5567d3c8cf560f61697cc6f5" // gitleaks:allow — test fixture
    let challenge = DpopKeyService.buildChallenge(
      deviceId: "dev-abc123",
      secretSha256Hex: secretSha256Hex,
      timestamp: 1_700_000_000,
      nonce: "nonce-1"
    )
    XCTAssertEqual(
      challenge,
      "ade-dpop-v1\ndev-abc123\n\(secretSha256Hex)\n1700000000\nnonce-1"
    )
  }

  func testSha256HexMatchesRuntime() {
    XCTAssertEqual(
      DpopKeyService.sha256Hex("test-secret-123"),
      "33e29618af5c636e782cfadefb698192ef7b2d8e5567d3c8cf560f61697cc6f5"
    )
  }

  func testProofSignsAndVerifies() throws {
    let deviceId = "dev-roundtrip"
    let secret = "paired-secret-value"
    let proof = try XCTUnwrap(DpopKeyService.shared.buildProof(deviceId: deviceId, secret: secret))

    let publicKeyB64 = try XCTUnwrap(proof["publicKey"] as? String)
    let signatureB64 = try XCTUnwrap(proof["signature"] as? String)
    let timestamp = try XCTUnwrap(proof["timestamp"] as? Int)
    let nonce = try XCTUnwrap(proof["nonce"] as? String)

    // Public key is X9.63 uncompressed P-256 (65 bytes, 0x04 prefix).
    let publicKeyData = try XCTUnwrap(Data(base64Encoded: publicKeyB64))
    XCTAssertEqual(publicKeyData.count, 65)
    XCTAssertEqual(publicKeyData.first, 0x04)

    let signatureData = try XCTUnwrap(Data(base64Encoded: signatureB64))
    let challenge = DpopKeyService.buildChallenge(
      deviceId: deviceId,
      secretSha256Hex: DpopKeyService.sha256Hex(secret),
      timestamp: timestamp,
      nonce: nonce
    )

    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      kSecAttrKeySizeInBits as String: 256,
    ]
    var error: Unmanaged<CFError>?
    let publicKey = try XCTUnwrap(
      SecKeyCreateWithData(publicKeyData as CFData, attributes as CFDictionary, &error)
    )
    let verified = SecKeyVerifySignature(
      publicKey,
      .ecdsaSignatureMessageX962SHA256,
      Data(challenge.utf8) as CFData,
      signatureData as CFData,
      &error
    )
    XCTAssertTrue(verified, "DPoP signature must verify against the advertised public key")

    // A tampered challenge must not verify.
    let tampered = SecKeyVerifySignature(
      publicKey,
      .ecdsaSignatureMessageX962SHA256,
      Data((challenge + "x").utf8) as CFData,
      signatureData as CFData,
      &error
    )
    XCTAssertFalse(tampered)
  }
}
