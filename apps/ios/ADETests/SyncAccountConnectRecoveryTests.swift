import XCTest
@testable import ADE

/// Regressions for the account-connect deadlock and the machine-switch
/// lifecycle. Both were reported from the field: a phone that could reach a Mac
/// perfectly well (socket up, challenge passed, `hello_ok` received) still
/// refused to connect, and choosing a second machine cost the user the machine
/// they were already on.
final class SyncAccountConnectRecoveryTests: XCTestCase {

  // MARK: - syncResolveAccountHelloPairedSecret

  /// The bug: a host that reuses an existing pairing OMITS `accountPairing`
  /// from `hello_ok` rather than reissuing one. iOS treated that as fatal, so a
  /// phone holding a perfectly good secret was told to go remove itself from
  /// the Mac. The web client has always fallen back here.
  func testOmittedAccountPairingFallsBackToStoredSecret() {
    let secret = syncResolveAccountHelloPairedSecret(
      payload: ["brain": ["deviceId": "host-1"]],
      expectedDeviceId: "phone-1",
      storedSecret: "stored-secret"
    )
    XCTAssertEqual(secret, "stored-secret")
  }

  func testOmittedAccountPairingWithNoStoredSecretIsRejected() {
    XCTAssertNil(syncResolveAccountHelloPairedSecret(
      payload: ["brain": ["deviceId": "host-1"]],
      expectedDeviceId: "phone-1",
      storedSecret: nil
    ))
  }

  func testOmittedAccountPairingTreatsBlankStoredSecretAsAbsent() {
    XCTAssertNil(syncResolveAccountHelloPairedSecret(
      payload: [:],
      expectedDeviceId: "phone-1",
      storedSecret: "   "
    ))
  }

  func testPresentAccountPairingWins() {
    let secret = syncResolveAccountHelloPairedSecret(
      payload: ["accountPairing": ["deviceId": "phone-1", "secret": "fresh-secret"]],
      expectedDeviceId: "phone-1",
      storedSecret: "stored-secret"
    )
    XCTAssertEqual(secret, "fresh-secret")
  }

  /// The safety half of the fallback: a host that DID answer, with something
  /// that is not for this device, must never be quietly papered over with a
  /// stored credential.
  func testPresentAccountPairingForAnotherDeviceIsRejectedDespiteStoredSecret() {
    XCTAssertNil(syncResolveAccountHelloPairedSecret(
      payload: ["accountPairing": ["deviceId": "someone-else", "secret": "fresh-secret"]],
      expectedDeviceId: "phone-1",
      storedSecret: "stored-secret"
    ))
  }

  func testPresentAccountPairingWithEmptySecretIsRejected() {
    XCTAssertNil(syncResolveAccountHelloPairedSecret(
      payload: ["accountPairing": ["deviceId": "phone-1", "secret": ""]],
      expectedDeviceId: "phone-1",
      storedSecret: "stored-secret"
    ))
  }

  /// An explicit null is a response, not an omission — only a missing key means
  /// "keep what you have".
  func testExplicitNullAccountPairingIsRejected() {
    XCTAssertNil(syncResolveAccountHelloPairedSecret(
      payload: ["accountPairing": NSNull()],
      expectedDeviceId: "phone-1",
      storedSecret: "stored-secret"
    ))
  }

  func testMalformedAccountPairingIsRejected() {
    XCTAssertNil(syncResolveAccountHelloPairedSecret(
      payload: ["accountPairing": "not-an-object"],
      expectedDeviceId: "phone-1",
      storedSecret: "stored-secret"
    ))
  }

  func testBlankExpectedDeviceIdIsRejected() {
    XCTAssertNil(syncResolveAccountHelloPairedSecret(
      payload: [:],
      expectedDeviceId: "  ",
      storedSecret: "stored-secret"
    ))
  }

  func testDeviceIdComparisonIgnoresSurroundingWhitespace() {
    let secret = syncResolveAccountHelloPairedSecret(
      payload: ["accountPairing": ["deviceId": " phone-1 ", "secret": " fresh-secret "]],
      expectedDeviceId: "phone-1",
      storedSecret: nil
    )
    XCTAssertEqual(secret, "fresh-secret")
  }

  // MARK: - syncConnectReachedTarget

  func testReachedTargetWhenAttachedToTheRequestedMachine() {
    XCTAssertTrue(syncConnectReachedTarget(
      isAttached: true,
      attachedStorageKey: "machine:host-1",
      targetStorageKey: "machine:host-1"
    ))
  }

  func testDidNotReachTargetWhenAttachedElsewhere() {
    XCTAssertFalse(syncConnectReachedTarget(
      isAttached: true,
      attachedStorageKey: "machine:host-2",
      targetStorageKey: "machine:host-1"
    ))
  }

  /// The regression: storage keys are optional and two nils compare equal, so
  /// a direct comparison claimed success for whatever machine happened to be
  /// attached — and suppressed the restore that should have followed.
  func testUncomputableKeysAreNotProofOfReachingTheTarget() {
    XCTAssertFalse(syncConnectReachedTarget(
      isAttached: true,
      attachedStorageKey: nil,
      targetStorageKey: nil
    ))
  }

  func testNotAttachedIsNeverReachingTheTarget() {
    XCTAssertFalse(syncConnectReachedTarget(
      isAttached: false,
      attachedStorageKey: "machine:host-1",
      targetStorageKey: "machine:host-1"
    ))
  }

  // MARK: - syncHubTransitionIsOwed

  /// The regression: every switch path calls `saveProfile(target)` before the
  /// hello lands, and `saveProfile` overwrites `activeProjectHostIdentity` with
  /// the target's identity. Comparing against that field compares B to B, so
  /// the Hub transition never fired and the user was left inside the previous
  /// machine's project while attached to a host that has never heard of it.
  func testTransitionIsOwedWhenTheBaselineMachineDiffersFromTheIncomingOne() {
    XCTAssertTrue(syncHubTransitionIsOwed(
      baselineHostIdentity: "studio",
      incomingHostIdentity: "macbook",
      hasActiveProject: true
    ))
  }

  /// The exact shape of the bug: a stale baseline that already equals the
  /// incoming machine must not be what the decision reads.
  func testTransitionIsNotOwedWhenReconnectingToTheSameMachine() {
    XCTAssertFalse(syncHubTransitionIsOwed(
      baselineHostIdentity: "studio",
      incomingHostIdentity: "studio",
      hasActiveProject: true
    ))
  }

  func testTransitionIsNotOwedWithNoProjectOpen() {
    XCTAssertFalse(syncHubTransitionIsOwed(
      baselineHostIdentity: "studio",
      incomingHostIdentity: "macbook",
      hasActiveProject: false
    ))
  }

  /// A first-ever connection has no baseline; there is no project to strand.
  func testTransitionIsOwedWhenThereIsNoBaselineButAProjectIsOpen() {
    XCTAssertTrue(syncHubTransitionIsOwed(
      baselineHostIdentity: nil,
      incomingHostIdentity: "macbook",
      hasActiveProject: true
    ))
  }

  func testTransitionIsNotOwedWithoutAnIncomingIdentity() {
    XCTAssertFalse(syncHubTransitionIsOwed(
      baselineHostIdentity: "studio",
      incomingHostIdentity: nil,
      hasActiveProject: true
    ))
  }

  // MARK: - syncAccountMachineNavigationIsCurrent

  /// The gate is attachment, not hydration progress. `hello_ok` publishes
  /// `.connected` before initial hydration finishes, so a link tapped during
  /// hydration must read as "already on this machine" — the earlier bug here
  /// re-paired to the machine we were already talking to, tearing down a
  /// healthy connection.
  func testConnectedCountsAsAttachedToTheTargetMachine() {
    XCTAssertTrue(syncAccountMachineNavigationIsCurrent(
      targetDeviceId: "host-1",
      activeHostIdentity: "host-1",
      connectionState: .connected
    ))
  }

  func testAttachedToADifferentMachineIsNotCurrent() {
    XCTAssertFalse(syncAccountMachineNavigationIsCurrent(
      targetDeviceId: "host-2",
      activeHostIdentity: "host-1",
      connectionState: .connected
    ))
  }

  /// Still-connecting is not attached: the navigation must wait for, or force,
  /// a real machine transition rather than assume one.
  func testConnectingIsNotCurrent() {
    XCTAssertFalse(syncAccountMachineNavigationIsCurrent(
      targetDeviceId: "host-1",
      activeHostIdentity: "host-1",
      connectionState: .connecting
    ))
  }

  func testDisconnectedIsNotCurrent() {
    XCTAssertFalse(syncAccountMachineNavigationIsCurrent(
      targetDeviceId: "host-1",
      activeHostIdentity: "host-1",
      connectionState: .disconnected
    ))
  }

  func testMissingIdentitiesAreNotCurrent() {
    XCTAssertFalse(syncAccountMachineNavigationIsCurrent(
      targetDeviceId: nil,
      activeHostIdentity: "host-1",
      connectionState: .connected
    ))
    XCTAssertFalse(syncAccountMachineNavigationIsCurrent(
      targetDeviceId: "host-1",
      activeHostIdentity: "   ",
      connectionState: .connected
    ))
  }
}
