import CryptoKit
import XCTest
import Security
@testable import ADE

private func pairingTestData(hex: String) -> Data {
  var data = Data()
  var index = hex.startIndex
  while index < hex.endIndex {
    let next = hex.index(index, offsetBy: 2)
    data.append(UInt8(hex[index..<next], radix: 16)!)
    index = next
  }
  return data
}

private final class AccountDirectoryURLProtocolStub: URLProtocol {
  private static let lock = NSLock()
  private static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

  static func install(_ nextHandler: @escaping (URLRequest) throws -> (HTTPURLResponse, Data)) {
    lock.lock()
    handler = nextHandler
    lock.unlock()
  }

  static func reset() {
    lock.lock()
    handler = nil
    lock.unlock()
  }

  override class func canInit(with request: URLRequest) -> Bool { true }

  override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

  override func startLoading() {
    Self.lock.lock()
    let handler = Self.handler
    Self.lock.unlock()

    guard let handler else {
      client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
      return
    }
    do {
      let (response, data) = try handler(request)
      client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
      client?.urlProtocol(self, didLoad: data)
      client?.urlProtocolDidFinishLoading(self)
    } catch {
      client?.urlProtocol(self, didFailWithError: error)
    }
  }

  override func stopLoading() {}
}

private final class AccountDirectoryRequestRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var authorizationValues: [String] = []

  func append(_ value: String) -> Int {
    lock.lock()
    defer { lock.unlock() }
    authorizationValues.append(value)
    return authorizationValues.count
  }

  func snapshot() -> [String] {
    lock.lock()
    defer { lock.unlock() }
    return authorizationValues
  }
}

private actor AccountDirectoryRefreshRecorder {
  private(set) var count = 0

  func refresh() -> String {
    count += 1
    return "fresh-token"
  }
}

/// Covers the pairing-QR codec (parity with `apps/desktop/src/shared/pairingQr.ts`)
/// and the DPoP challenge/signature contract (parity with
/// `apps/ade-cli/src/services/sync/syncDpop.ts`).
final class PairingAndDpopTests: XCTestCase {
  // A canonical smart URL produced by the TS `encodePairingQrUrl` (includes an
  // unknown extra field to prove lenient forward-compat parsing).
  private let canonicalPairingUrl = "https://ade-app.dev/pair#eyJ2ZXJzaW9uIjozLCJob3N0SWRlbnRpdHkiOnsiZGV2aWNlSWQiOiJkZXYtYWJjMTIzIiwic2l0ZUlkIjoic2l0ZS14eXoiLCJuYW1lIjoiQXJ1bCBNYWNCb29rIiwicGxhdGZvcm0iOiJtYWNPUyIsImRldmljZVR5cGUiOiJkZXNrdG9wIn0sInBvcnQiOjg3ODcsImFkZHJlc3NDYW5kaWRhdGVzIjpbeyJob3N0IjoiMTkyLjE2OC4xLjQyIiwia2luZCI6ImxhbiJ9LHsiaG9zdCI6IjEwMC4xMDEuMTAyLjEwMyIsImtpbmQiOiJ0YWlsc2NhbGUifSx7Imhvc3QiOiJ3c3M6Ly9yZWxheS5hZGUtYXBwLmRldi9jb25uZWN0L21hY2hpbmVrZXkxMjMiLCJraW5kIjoicmVsYXkifV0sInJlbGF5VXJsIjoid3NzOi8vcmVsYXkuYWRlLWFwcC5kZXYvY29ubmVjdC9tYWNoaW5la2V5MTIzIiwiZXh0cmFGdXR1cmVGaWVsZCI6Imlnbm9yZWQifQ"

  // MARK: - Account directory

  func testMachineDirectoryRetriesOnceWithFreshTokenAfterUnauthorized() async throws {
    let requests = AccountDirectoryRequestRecorder()
    let refreshes = AccountDirectoryRefreshRecorder()
    AccountDirectoryURLProtocolStub.install { request in
      let attempt = requests.append(request.value(forHTTPHeaderField: "Authorization") ?? "")
      let status = attempt == 1 ? 401 : 200
      let response = try XCTUnwrap(HTTPURLResponse(
        url: request.url ?? URL(string: "https://directory.example")!,
        statusCode: status,
        httpVersion: nil,
        headerFields: ["Content-Type": "application/json"]
      ))
      let data = status == 200 ? Data(#"{"machines":[]}"#.utf8) : Data()
      return (response, data)
    }
    defer { AccountDirectoryURLProtocolStub.reset() }

    let configuration = URLSessionConfiguration.ephemeral
    configuration.protocolClasses = [AccountDirectoryURLProtocolStub.self]
    let directory = AccountDirectoryClient(session: URLSession(configuration: configuration))

    let machines = try await directory.fetchMachines(
      baseURL: try XCTUnwrap(URL(string: "https://directory.example")),
      token: "stale-token",
      refreshToken: { await refreshes.refresh() }
    )

    let refreshCount = await refreshes.count
    XCTAssertTrue(machines.isEmpty)
    XCTAssertEqual(requests.snapshot(), ["Bearer stale-token", "Bearer fresh-token"])
    XCTAssertEqual(refreshCount, 1)
  }

  // MARK: - Sealed account adoption

  func testAdoptChannelMatchesTypeScriptChaChaPolyVector() throws {
    // Fixed vector from
    // apps/desktop/src/shared/sync/adoptChannelCrypto.test.ts.
    let clientPrivateKey = try Curve25519.KeyAgreement.PrivateKey(
      rawRepresentation: pairingTestData(
        hex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
      )
    )
    XCTAssertEqual(
      clientPrivateKey.publicKey.rawRepresentation,
      pairingTestData(
        hex: "8f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f"
      )
    )
    let hostPublicKey = pairingTestData(
      hex: "358072d6365880d1aeea329adf9121383851ed21a28e3b75e965d0d2cd166254"
    )
    let nonce = pairingTestData(
      hex: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
    )
    let sessionKey = try AdoptChannelCrypto.deriveSessionKey(
      clientPrivateKey: clientPrivateKey,
      hostPublicKeyRaw: hostPublicKey,
      nonce: nonce
    )
    let sessionKeyData = sessionKey.withUnsafeBytes { Data($0) }
    XCTAssertEqual(
      sessionKeyData,
      pairingTestData(
        hex: "73dd8c3462d2bd6af30580cd4147d5049e6b96d6e0caad0abb512e47ea9c056e"
      )
    )

    let sealed =
      "AAECAwQFBgcICQoL2ZbKNSOix6tRlgt6GSfO7OGy0Pp8/04VMGCtmGI+2K5fKpJv27j0R8un/fPj0v1aEAizUH3l7uZ6nwS6WM8f+GJfCvAcH6bo1KfPq04vbY2jLUSXuYo="
    let plaintext = try AdoptChannelCrypto.unseal(
      sealed,
      key: sessionKey,
      aad: Data("ade-adopt-v1|host-vector|client-vector".utf8)
    )
    XCTAssertEqual(
      String(decoding: plaintext, as: UTF8.self),
      #"{"deviceId":"client-vector","accountToken":"token-vector","dpop":null}"#
    )

    XCTAssertEqual(
      AdoptChannelCrypto.challengeSignatureInput(
        hostDeviceId: "host-device",
        nonce: "bm9uY2U=",
        clientEphemeralPublicKey: "Y2xpZW50",
        hostEphemeralPublicKey: "aG9zdA==",
        timestampMilliseconds: 1_783_500_123_456
      ),
      "ade-adopt-v1|host-device|bm9uY2U=|Y2xpZW50|aG9zdA==|1783500123456"
    )
  }

  func testAdoptChannelRejectsPresentMalformedDirectorySigningKey() throws {
    XCTAssertNil(
      try AdoptChannelCrypto.signingPublicKey(fromOptionalDirectoryValue: nil)
    )
    XCTAssertThrowsError(
      try AdoptChannelCrypto.signingPublicKey(fromOptionalDirectoryValue: "")
    )
    XCTAssertThrowsError(
      try AdoptChannelCrypto.signingPublicKey(fromOptionalDirectoryValue: "   ")
    )
    XCTAssertThrowsError(
      try AdoptChannelCrypto.signingPublicKey(
        fromOptionalDirectoryValue: "ed25519:not-canonical-base64"
      )
    )
  }

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

  func testRelayReauthorizationChallengeMatchesSharedCanonicalContext() {
    let tokenHash = DpopKeyService.sha256Hex("exact-token-bytes")
    XCTAssertEqual(
      DpopKeyService.buildRelayReauthorizationChallenge(
        deviceId: "phone-1",
        relayAccountTokenSha256Hex: tokenHash,
        challenge: "connection-challenge",
        timestamp: 1_700_000_001,
        nonce: "nonce-reauth"
      ),
      "ade-relay-reauth-v1\nphone-1\n\(tokenHash)\nconnection-challenge\n1700000001\nnonce-reauth"
    )
  }

  func testRelayReauthorizationProofUsesFreshCryptographicallyBoundAttempt() throws {
    let deviceId = "phone-1"
    let token = "token-1"
    let relayChallenge = "challenge-1"
    let first = try XCTUnwrap(DpopKeyService.shared.buildRelayReauthorizationProof(
      deviceId: deviceId,
      relayAccountToken: token,
      challenge: relayChallenge
    ))
    let second = try XCTUnwrap(DpopKeyService.shared.buildRelayReauthorizationProof(
      deviceId: deviceId,
      relayAccountToken: token,
      challenge: relayChallenge
    ))
    XCTAssertNotEqual(first["nonce"] as? String, second["nonce"] as? String)
    XCTAssertNotEqual(first["signature"] as? String, second["signature"] as? String)

    let publicKeyBase64 = try XCTUnwrap(DpopKeyService.shared.publicKeyX963Base64())
    let publicKeyData = try XCTUnwrap(Data(base64Encoded: publicKeyBase64))
    let attributes: [String: Any] = [
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
      kSecAttrKeySizeInBits as String: 256,
    ]
    var keyError: Unmanaged<CFError>?
    let publicKey = try XCTUnwrap(
      SecKeyCreateWithData(publicKeyData as CFData, attributes as CFDictionary, &keyError)
    )

    for proof in [first, second] {
      let timestamp = try XCTUnwrap(proof["timestamp"] as? Int)
      let nonce = try XCTUnwrap(proof["nonce"] as? String)
      let signature = try XCTUnwrap(
        Data(base64Encoded: try XCTUnwrap(proof["signature"] as? String))
      )
      let canonical = DpopKeyService.buildRelayReauthorizationChallenge(
        deviceId: deviceId,
        relayAccountTokenSha256Hex: DpopKeyService.sha256Hex(token),
        challenge: relayChallenge,
        timestamp: timestamp,
        nonce: nonce
      )
      func verifies(_ canonicalChallenge: String) -> Bool {
        var verificationError: Unmanaged<CFError>?
        return SecKeyVerifySignature(
          publicKey,
          .ecdsaSignatureMessageX962SHA256,
          Data(canonicalChallenge.utf8) as CFData,
          signature as CFData,
          &verificationError
        )
      }
      XCTAssertTrue(verifies(canonical))

      let wrongTokenCanonical = DpopKeyService.buildRelayReauthorizationChallenge(
        deviceId: deviceId,
        relayAccountTokenSha256Hex: DpopKeyService.sha256Hex("different-token"),
        challenge: relayChallenge,
        timestamp: timestamp,
        nonce: nonce
      )
      XCTAssertFalse(verifies(wrongTokenCanonical))

      let wrongChallengeCanonical = DpopKeyService.buildRelayReauthorizationChallenge(
        deviceId: deviceId,
        relayAccountTokenSha256Hex: DpopKeyService.sha256Hex(token),
        challenge: "different-challenge",
        timestamp: timestamp,
        nonce: nonce
      )
      XCTAssertFalse(verifies(wrongChallengeCanonical))
    }
  }
}
