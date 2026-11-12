import Combine
import Security
import UIKit
import XCTest
@testable import ADE

/// A saved pairing whose credential cannot be read is a fault, not an
/// instruction to pair. Conflating the two is what made a real Keychain failure
/// present as "you have never paired" and silently re-open the connect sheet the
/// user had already completed.
final class PairedHostCredentialStateTests: XCTestCase {
  private func pairedProfile(authKind: String = "paired") -> HostConnectionProfile {
    HostConnectionProfile(
      hostIdentity: "machine-identity",
      hostName: "Arul's Mac Studio",
      siteId: nil,
      port: 8787,
      authKind: authKind,
      pairedDeviceId: "device-1",
      lastRemoteDbVersion: 0,
      lastHostDeviceId: "machine-identity",
      lastSuccessfulAddress: "192.168.1.20",
      savedAddressCandidates: ["192.168.1.20"],
      discoveredLanAddresses: ["192.168.1.20"],
      tailscaleAddress: nil,
      savedRelayCandidates: nil
    )
  }

  func testNoProfileIsNotPaired() {
    XCTAssertEqual(
      syncPairedHostCredentialState(profile: nil) { _ in "secret" },
      .notPaired
    )
  }

  func testReadableCredentialIsReadyAndUsable() {
    let state = syncPairedHostCredentialState(profile: pairedProfile()) { _ in "secret" }
    XCTAssertEqual(state, .ready)
    XCTAssertTrue(state.isUsable)
  }

  /// The shipped failure: a persisted paired profile whose Keychain read fails.
  /// On a real device this is a cleared or unreadable entry; the symptom that
  /// exposed it was `errSecMissingEntitlement` (-34018), where every
  /// `SecItemCopyMatching` returns nothing while the profile persists intact.
  func testPersistedProfileWithFailingKeychainReadIsUnreadableNotUnpaired() {
    var lookups = 0
    let state = syncPairedHostCredentialState(profile: pairedProfile()) { _ in
      lookups += 1
      return nil  // stands in for the -34018 read failure
    }

    XCTAssertEqual(lookups, 1, "the credential must actually be consulted")
    XCTAssertEqual(
      state, .credentialUnreadable,
      "a persisted pairing with an unreadable credential must not report as never-paired"
    )
    XCTAssertNotEqual(state, .notPaired)
    XCTAssertFalse(state.isUsable, "an unusable credential must still gate entry")
  }

  /// `hasPairedHost` is defined as `isUsable`, so both failure modes keep
  /// gating exactly as before — only the words the user sees change.
  func testBothFailureModesRemainUnusable() {
    let unreadable = syncPairedHostCredentialState(profile: pairedProfile()) { _ in nil }
    let unpaired = syncPairedHostCredentialState(profile: nil) { _ in "secret" }
    XCTAssertFalse(unreadable.isUsable)
    XCTAssertFalse(unpaired.isUsable)
  }

  func testAccountAuthKindIsNotTreatedAsAPairing() {
    let state = syncPairedHostCredentialState(profile: pairedProfile(authKind: "account")) { _ in nil }
    XCTAssertEqual(state, .notPaired, "only a paired profile can have an unreadable pairing credential")
  }

  /// The device id every computer knows this phone by. A keychain read that
  /// fails must never write a new id over the real one: that made every
  /// computer answer "unknown device", and the phone then dropped its
  /// pairings. An id made after a failed read is provisional: the phone
  /// neither stores it nor pairs or drops a pairing with it.
  func testDeviceIdSurvivesAFailedKeychainRead() {
    typealias Case = (keychain: KeychainService.StoredRead, saved: String?, id: String, writeKeychain: Bool, writeSaved: Bool, provisional: Bool)
    let cases: [Case] = [
      (.value("kept"), "kept", "kept", false, false, false),
      (.value("kept"), nil, "kept", false, true, false),            // after a reinstall: the saved copy comes back
      (.failed(errSecInteractionNotAllowed), "saved", "saved", false, false, false),  // the keychain may still hold the real id
      (.failed(errSecInteractionNotAllowed), nil, "fresh", false, false, true),       // before the first unlock: read again later
      (.absent, "saved", "saved", true, false, false),
      (.absent, nil, "fresh", true, true, false),
      (.value("  "), "saved", "saved", true, false, false),
    ]
    for (index, item) in cases.enumerated() {
      let result = syncResolveDeviceId(keychain: item.keychain, saved: item.saved, makeFresh: { "fresh" })
      XCTAssertEqual(result.id, item.id, "case \(index)")
      XCTAssertEqual(result.writeKeychain, item.writeKeychain, "case \(index)")
      XCTAssertEqual(result.writeSaved, item.writeSaved, "case \(index)")
      XCTAssertEqual(result.provisional, item.provisional, "case \(index)")
    }
  }

  /// Each secret the phone keeps, behind a keychain that refuses reads (a
  /// launch before the first unlock): nothing is created or written over it,
  /// and once the keychain answers the phone uses the stored secrets again.
  @MainActor
  func testAFailedKeychainReadWritesNothingAndAGoodReadRestores() async throws {
    let backend = RefusingKeychainBackend()
    let keychain = KeychainService(backend: backend)
    let record = GitHubAccountTokenRecord(
      accountUserId: "user-1", accessToken: "gh-token", useUntil: Date().timeIntervalSince1970 + 3_600,
      generation: 4, githubLogin: "octo"
    )
    backend.items = [
      "device-id": "device-1",
      "connection-token:machine:abc": "secret-abc",
      "connection-token.machine:abc": "older-name-secret",
      "connection-token:route:10.0.0.2:8787": "stale-route-secret",
      "connection-token": "other-computer-secret",
      "attention-ownership-epoch:device-1": "7",
      "attention-device-key:device-1": "device-key",
      "github-account-app.v1": String(decoding: try JSONEncoder().encode(record), as: UTF8.self),
    ]
    let pairingRead = {
      keychain.readPairedSecret(
        key: "machine:abc", legacyKeys: ["route:10.0.0.2:8787"], migrate: true, fallbackToLastPaired: true
      )
    }

    // Only the computer's own slot fails: an older name and the last paired
    // secret still answer, and neither is used or copied over it.
    backend.refusedAccounts = ["connection-token:machine:abc"]
    XCTAssertEqual(pairingRead(), .failed(errSecInteractionNotAllowed), "an older or another computer's secret is never used")
    backend.refusedAccounts = []
    backend.refuseReads = true
    XCTAssertEqual(pairingRead(), .failed(errSecInteractionNotAllowed))
    XCTAssertEqual(keychain.readToken(hostKey: "machine:abc"), .failed(errSecInteractionNotAllowed))
    keychain.saveAccountDeviceOwnershipEpoch(3, deviceId: "device-1")
    XCTAssertEqual(keychain.readAccountDeviceKey(deviceId: "device-1"), .failed(errSecInteractionNotAllowed))
    XCTAssertTrue(syncResolveDeviceId(keychain: keychain.readDeviceId(), saved: nil, makeFresh: { "fresh" }).provisional)
    let github = GitHubAccountConnection(keychain: keychain)
    github.activate(userId: "user-1")
    XCTAssertNil(github.state.login)
    XCTAssertEqual(backend.writes, [], "a failed read creates and overwrites nothing")

    backend.refuseReads = false
    let restored = expectation(description: "the stored GitHub token is used again")
    let watch = github.$state.sink { if $0.login == "octo" { restored.fulfill() } }
    NotificationCenter.default.post(name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
    await fulfillment(of: [restored], timeout: 5)
    watch.cancel()
    XCTAssertEqual(pairingRead(), .value("secret-abc"))
    XCTAssertEqual(keychain.readDeviceId(), .value("device-1"))
    XCTAssertEqual(keychain.readAccountDeviceKey(deviceId: "device-1"), .value("device-key"))
    keychain.saveAccountDeviceOwnershipEpoch(3, deviceId: "device-1")
    XCTAssertEqual(keychain.loadAccountDeviceOwnershipEpoch(deviceId: "device-1"), 7, "the epoch never goes down")
    XCTAssertEqual(backend.writes, [])
    XCTAssertEqual(backend.items["connection-token:machine:abc"], "secret-abc")
  }
}

/// The keychain at the securityd boundary. With `refuseReads` every read
/// answers `errSecInteractionNotAllowed`, as before the first unlock, and a
/// write is recorded and refused; `refusedAccounts` refuses some reads only.
private final class RefusingKeychainBackend: KeychainBackend, @unchecked Sendable {
  var items: [String: String] = [:]
  var refuseReads = false
  var refusedAccounts: Set<String> = []
  private(set) var writes: [String] = []

  func copyMatching(_ query: [String: Any]) -> (status: OSStatus, item: CFTypeRef?) {
    let account = query[kSecAttrAccount as String] as? String
    if refuseReads || account.map(refusedAccounts.contains) == true { return (errSecInteractionNotAllowed, nil) }
    if query[kSecMatchLimit as String] as? String == kSecMatchLimitAll as String {
      let all = items.keys.map { [kSecAttrAccount as String: $0] as [String: Any] }
      return all.isEmpty ? (errSecItemNotFound, nil) : (errSecSuccess, all as CFArray)
    }
    guard let account, let value = items[account] else {
      return (errSecItemNotFound, nil)
    }
    return (errSecSuccess, Data(value.utf8) as CFData)
  }

  func add(_ attributes: [String: Any]) -> OSStatus {
    write("add", attributes, value: attributes[kSecValueData as String] as? Data)
  }

  func update(_ query: [String: Any], fields: [String: Any]) -> OSStatus {
    guard let account = query[kSecAttrAccount as String] as? String else { return errSecParam }
    if !refuseReads, items[account] == nil { return errSecItemNotFound }
    return write("update", query, value: fields[kSecValueData as String] as? Data)
  }

  func delete(_ query: [String: Any]) -> OSStatus {
    write("delete", query, value: nil)
  }

  private func write(_ kind: String, _ query: [String: Any], value: Data?) -> OSStatus {
    let account = query[kSecAttrAccount as String] as? String ?? "?"
    writes.append("\(kind) \(account)")
    if refuseReads { return errSecInteractionNotAllowed }
    if let value { items[account] = String(decoding: value, as: UTF8.self) } else { items.removeValue(forKey: account) }
    return errSecSuccess
  }
}
