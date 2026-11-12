import Security
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
}
