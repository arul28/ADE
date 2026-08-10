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
}
