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

  // MARK: - syncNavigationMachineKey

  /// The field report: a lock-screen tap opened a MacBook chat while the phone
  /// was attached to a Mac Studio, and the UI said "Connected" over the top of
  /// it. The widget's machine-local path minted `ade://session/<id>` with no
  /// machine key, and the guard read "no key" as "the attached machine is
  /// fine". These four cases pin the replacement rule.

  func testLinkThatNamesAMachineIsTakenAtItsWord() {
    // Even when the session's owner is known to be elsewhere, an explicit key
    // wins: the link is the more specific statement.
    XCTAssertEqual(
      syncNavigationMachineKey(
        rawMachineKey: "studio",
        sessionId: "session-1",
        attentionItems: [Self.attentionItem(sessionId: "session-1", accountMachineKey: "macbook")],
        workspaceSnapshot: nil
      ),
      "studio"
    )
  }

  func testLegacyLinkResolvesItsOwnerFromTheAccountFeed() {
    // The account feed spans every signed-in machine, so it is the only source
    // that can name a machine this phone is NOT attached to.
    XCTAssertEqual(
      syncNavigationMachineKey(
        rawMachineKey: nil,
        sessionId: "session-1",
        attentionItems: [
          Self.attentionItem(sessionId: "session-other", accountMachineKey: "studio"),
          Self.attentionItem(sessionId: "session-1", accountMachineKey: "macbook"),
        ],
        workspaceSnapshot: Self.workspaceSnapshot(machineId: "studio", sessionIds: [])
      ),
      "macbook"
    )
  }

  /// Backward compatibility, and it is a hard requirement: links minted by
  /// builds already installed carry no key at all. When nothing local knows who
  /// owns the session, nil means "the attached machine is fine" and the tap
  /// keeps working exactly as it did.
  func testLegacyLinkWithAnUnknownOwnerFallsBackToTheAttachedMachine() {
    XCTAssertNil(syncNavigationMachineKey(
      rawMachineKey: nil,
      sessionId: "session-unknown",
      attentionItems: [Self.attentionItem(sessionId: "session-1", accountMachineKey: "macbook")],
      workspaceSnapshot: Self.workspaceSnapshot(machineId: "studio", sessionIds: ["session-1"])
    ))
    // No session id at all — a workspace or PR link — is unchanged too.
    XCTAssertNil(syncNavigationMachineKey(
      rawMachineKey: nil,
      sessionId: nil,
      attentionItems: [Self.attentionItem(sessionId: "session-1", accountMachineKey: "macbook")],
      workspaceSnapshot: Self.workspaceSnapshot(machineId: "studio", sessionIds: ["session-1"])
    ))
  }

  /// The machine-local snapshot is the fallback source and can only ever
  /// confirm the machine it was written for — which is the right answer for a
  /// legacy link that really is local.
  func testLegacyLinkForALocalSessionResolvesToTheSnapshotMachine() {
    XCTAssertEqual(
      syncNavigationMachineKey(
        rawMachineKey: nil,
        sessionId: "session-1",
        attentionItems: [],
        workspaceSnapshot: Self.workspaceSnapshot(machineId: "studio", sessionIds: ["session-1"])
      ),
      "studio"
    )
  }

  func testBlankMachineKeyIsTreatedAsAbsent() {
    XCTAssertEqual(
      syncNavigationMachineKey(
        rawMachineKey: "   ",
        sessionId: "session-1",
        attentionItems: [Self.attentionItem(sessionId: "session-1", accountMachineKey: "macbook")],
        workspaceSnapshot: nil
      ),
      "macbook"
    )
  }

  /// An account row that has no canonical key yet must not shadow the local
  /// snapshot, which may still know the answer.
  func testAttentionRowWithoutAKeyFallsThroughToTheSnapshot() {
    XCTAssertEqual(
      syncNavigationMachineKey(
        rawMachineKey: nil,
        sessionId: "session-1",
        attentionItems: [Self.attentionItem(sessionId: "session-1", accountMachineKey: nil)],
        workspaceSnapshot: Self.workspaceSnapshot(machineId: "studio", sessionIds: ["session-1"])
      ),
      "studio"
    )
  }

  // MARK: - Machine-scoped session links

  /// The contract the widget's machine-local path now depends on. It used to
  /// hand-roll `ade://session/<id>` itself, which is how it missed the query
  /// item the account path had gained; it goes through this builder now, so
  /// this is where the shape is pinned.
  ///
  /// `LockScreenPriorityStatus` itself is compiled only into the widget target,
  /// so this covers the builder rather than the caller.
  func testSessionLinkCarriesItsOwningMachine() {
    let url = AccountAttentionDestination
      .session(sessionId: "session-1", itemId: nil, eventId: nil)
      .deepLinkURL(accountMachineKey: "studio")
    XCTAssertEqual(
      url?.absoluteString,
      "ade://session/session-1?accountMachineKey=studio"
    )
  }

  func testSessionLinkWithoutAnOwnerStaysLegacyShaped() {
    let url = AccountAttentionDestination
      .session(sessionId: "session-1", itemId: nil, eventId: nil)
      .deepLinkURL(accountMachineKey: nil)
    XCTAssertEqual(url?.absoluteString, "ade://session/session-1")
  }

  /// The snapshot path builds compact PR links (`ade://pr/<n>`) with no repo
  /// slug; scoping them must not change that shape.
  func testCompactPrLinkCarriesItsOwningMachine() {
    let url = AccountAttentionDestination
      .pullRequest(
        prId: nil,
        repoOwner: nil,
        repoName: nil,
        number: 97,
        tab: "overview",
        eventId: nil
      )
      .deepLinkURL(accountMachineKey: "studio")
    XCTAssertEqual(url?.absoluteString, "ade://pr/97?accountMachineKey=studio")
  }

  // MARK: - syncMachineWakeNeed

  func testOnlineMachineNeedsNoWakeConfirmation() {
    XCTAssertNil(syncMachineWakeNeed(online: true, lastSeenAt: Date()))
  }

  /// Offline but seen recently is a Mac with its lid shut, not a Mac that is
  /// gone. That distinction is the whole difference between "Wake & open" being
  /// an honest button and being a wish.
  func testRecentlySeenOfflineMachineReadsAsAsleep() {
    let now = Date()
    XCTAssertEqual(
      syncMachineWakeNeed(
        online: false,
        lastSeenAt: now.addingTimeInterval(-30 * 60),
        now: now
      ),
      .asleep
    )
  }

  func testLongSilentMachineReadsAsUnreachable() {
    let now = Date()
    XCTAssertEqual(
      syncMachineWakeNeed(
        online: false,
        lastSeenAt: now.addingTimeInterval(-(syncMachineRecentlySeenWindow + 60)),
        now: now
      ),
      .unreachable
    )
    XCTAssertEqual(
      syncMachineWakeNeed(online: false, lastSeenAt: nil, now: now),
      .unreachable
    )
  }

  /// A last-seen stamp from the future is clock skew, not freshness — it must
  /// not manufacture an "asleep" reading for a machine that is actually gone.
  func testFutureLastSeenIsNotTreatedAsFreshness() {
    let now = Date()
    XCTAssertEqual(
      syncMachineWakeNeed(
        online: false,
        lastSeenAt: now.addingTimeInterval(600),
        now: now
      ),
      .unreachable
    )
  }

  /// Status lines are scanned, not read: keep them short enough to stay one
  /// glance on a sheet.
  func testWakeStatusLabelsStayShort() {
    for need in [SyncMachineWakeNeed.asleep, .unreachable] {
      XCTAssertLessThanOrEqual(
        need.statusLabel.split(separator: " ").count,
        6,
        "\(need) status line is too long to scan"
      )
    }
  }

  // MARK: - Announced sleep state

  /// The incident: a Mac whose lid had just shut was still `online` in the
  /// directory, because `online` is heartbeat freshness and the last heartbeat
  /// was seconds old. The machine list offered "Connect" and the failure that
  /// followed got blamed on the relay. A stated sleep has to outrank presence.
  func testAnnouncedSleepBeatsAFreshHeartbeat() {
    XCTAssertEqual(
      syncMachineWakeNeed(
        online: true,
        lastSeenAt: Date(),
        sleepState: .asleep,
        sleepStateAt: Date()
      ),
      .asleep
    )
  }

  func testAnnouncedSleepBeatsALongSilence() {
    let now = Date()
    XCTAssertEqual(
      syncMachineWakeNeed(
        online: false,
        lastSeenAt: now.addingTimeInterval(-(syncMachineRecentlySeenWindow + 600)),
        sleepState: .asleep,
        sleepStateAt: now,
        now: now
      ),
      .asleep
    )
  }

  /// The directory's upsert coalesces `sleep_state`, so it can never write the
  /// column back to NULL. A machine whose resume announcement was lost — or that
  /// was downgraded to a build omitting the field — would otherwise be pinned
  /// "Asleep" forever, and asleep outranks connected, so there is no way back.
  func testAgedSleepAnnouncementStopsBeingAFact() {
    let now = Date()
    let stale = now.addingTimeInterval(-(syncMachineSleepInferenceWindow + 60))
    XCTAssertNil(syncMachineWakeNeed(
      online: true,
      lastSeenAt: now,
      sleepState: .asleep,
      sleepStateAt: stale,
      now: now
    ))
    XCTAssertEqual(
      syncMachinePresence(
        connected: true,
        online: true,
        sleepState: .asleep,
        sleepStateAt: stale,
        lastSeenAt: now,
        now: now
      ),
      .connected
    )
  }

  func testSleepAnnouncementInsideTheWindowIsStillTrusted() {
    let now = Date()
    let fresh = now.addingTimeInterval(-(syncMachineSleepInferenceWindow - 60))
    XCTAssertEqual(
      syncMachinePresence(
        connected: true,
        online: true,
        sleepState: .asleep,
        sleepStateAt: fresh,
        lastSeenAt: now,
        now: now
      ),
      .asleep
    )
  }

  /// A stamp from the future is clock skew, not age.
  func testFutureDatedSleepAnnouncementReadsAsSkewNotStaleness() {
    let now = Date()
    XCTAssertFalse(syncSleepAnnouncementIsStale(
      sleepStateAt: now.addingTimeInterval(3600),
      now: now
    ))
  }

  /// An announcement we cannot date is not evidence.
  func testUndatedSleepAnnouncementIsTreatedAsStale() {
    XCTAssertTrue(syncSleepAnnouncementIsStale(sleepStateAt: nil))
    XCTAssertNil(syncMachineWakeNeed(
      online: true,
      lastSeenAt: Date(),
      sleepState: .asleep,
      sleepStateAt: nil
    ))
  }

  /// The Swift window must not drift from the TypeScript one it mirrors.
  func testSleepAnnouncementWindowMatchesTheSharedContract() {
    XCTAssertEqual(syncMachineSleepInferenceWindow, 10 * 60)
  }

  /// The third edge of the shared rule, alongside the missing and future stamps
  /// pinned above: an announcement exactly one window old has aged out. Pinned
  /// because the boundary is the only part of `sleepAnnouncementIsStale` that a
  /// `>` on one platform and a `>=` on the other would hide.
  func testSleepAnnouncementExactlyOneWindowOldIsStale() {
    let now = Date()
    XCTAssertTrue(syncSleepAnnouncementIsStale(
      sleepStateAt: now.addingTimeInterval(-syncMachineSleepInferenceWindow),
      now: now
    ))
    XCTAssertFalse(syncSleepAnnouncementIsStale(
      sleepStateAt: now.addingTimeInterval(-syncMachineSleepInferenceWindow + 1),
      now: now
    ))
  }

  // MARK: - What a failed wake retry says

  /// The bug: the retry loop read `lastError`, which the restore of the machine
  /// the user was already on has already cleared — twice. A phone attached to
  /// one Mac, opening a link for a sleeping second Mac whose 25s wake budget ran
  /// out, was told "Couldn't reach it." instead of what actually happened.
  func testWakeRetryMessagePrefersTheFailureThatSurvivesTheRestore() {
    // Built by the same helper the failing attempt uses, so the card and the
    // producer cannot drift apart into two different wake messages.
    let wakeTimedOut = syncConnectFailureMessage(
      wasWakingMachine: true,
      transportMessage: "The ADE relay closed the connection."
    )
    XCTAssertEqual(
      syncWakeRetryFailureMessage(
        attemptFailure: SyncConnectAttemptFailure(
          message: wakeTimedOut,
          machineName: "MacBook Pro",
          machineIdentity: "device-b",
          machineWasAsleep: true
        ),
        // Cleared by `restorePreviousConnection` before the loop gets here.
        lastError: nil
      ),
      "It didn\u{2019}t wake up in time."
    )
  }

  /// The authorization and account-mismatch guards in `pairWithAccountMachine`
  /// return without recording an attempt failure, so their message is the only
  /// thing left worth saying.
  func testWakeRetryMessageFallsBackToLastErrorThenToAGenericLine() {
    XCTAssertEqual(
      syncWakeRetryFailureMessage(
        attemptFailure: nil,
        lastError: "Sign in again, then try connecting."
      ),
      "Sign in again, then try connecting."
    )
    XCTAssertEqual(
      syncWakeRetryFailureMessage(attemptFailure: nil, lastError: "   "),
      "Couldn\u{2019}t reach it."
    )
    XCTAssertEqual(
      syncWakeRetryFailureMessage(attemptFailure: nil, lastError: nil),
      "Couldn\u{2019}t reach it."
    )
  }

  /// "awake" says nothing `online` does not, so a host that announced it and
  /// then went quiet still falls back to the presence inference — a machine
  /// that lost power mid-beat is asleep, not a special case.
  func testAnnouncedAwakeFallsBackToInference() {
    let now = Date()
    XCTAssertNil(syncMachineWakeNeed(online: true, lastSeenAt: now, sleepState: .awake))
    XCTAssertEqual(
      syncMachineWakeNeed(
        online: false,
        lastSeenAt: now.addingTimeInterval(-120),
        sleepState: .awake,
        now: now
      ),
      .asleep
    )
    XCTAssertEqual(
      syncMachineWakeNeed(
        online: false,
        lastSeenAt: now.addingTimeInterval(-(syncMachineRecentlySeenWindow + 600)),
        sleepState: .awake,
        now: now
      ),
      .unreachable
    )
  }

  /// A host that never announces must read exactly as it did before any of
  /// this shipped.
  func testAbsentSleepStateKeepsTheOldInference() {
    let now = Date()
    XCTAssertNil(syncMachineWakeNeed(online: true, lastSeenAt: now, sleepState: nil))
    XCTAssertEqual(
      syncMachineWakeNeed(
        online: false,
        lastSeenAt: now.addingTimeInterval(-600),
        sleepState: nil,
        now: now
      ),
      .asleep
    )
  }

  // MARK: - Power decoding and row copy

  func testDirectoryPowerFieldsDecode() throws {
    let machine = try Self.decodeMachine("""
    {
      "machineKey": "mbp",
      "name": "MacBook Pro (97)",
      "power": {"batteryPercent": 82, "charging": false, "onExternalPower": false},
      "sleepState": "asleep",
      "sleepStateAt": 1750000000000,
      "online": true
    }
    """)
    XCTAssertEqual(machine.power?.batteryPercent, 82)
    XCTAssertEqual(machine.sleepState, .asleep)
    XCTAssertEqual(machine.sleepStateAt, 1_750_000_000_000)
  }

  /// Older hosts send none of it, and a sleep word this build has never heard
  /// of must not fail the roster and take a working machine off the list.
  func testMachineWithoutPowerFieldsStillDecodes() throws {
    let machine = try Self.decodeMachine("""
    {"machineKey": "old", "name": "windows", "online": true, "sleepState": "hibernating"}
    """)
    XCTAssertNil(machine.power)
    XCTAssertNil(machine.sleepState)
    XCTAssertNil(machine.sleepStateAt)
  }

  /// A Mac Studio has no battery. Reading "0%" off it — or leaving an empty
  /// slot where a percentage goes — is worse than saying nothing.
  func testMachineWithNoBatteryRendersNoBatteryText() {
    let deskside = AccountMachinePower(batteryPercent: nil, charging: nil, onExternalPower: true)
    XCTAssertEqual(accountMachinePowerClause(deskside), "plugged in")
    XCTAssertNil(accountMachinePowerClause(nil))
    XCTAssertNil(
      accountMachinePowerClause(
        AccountMachinePower(batteryPercent: nil, charging: nil, onExternalPower: nil)
      )
    )
    XCTAssertEqual(
      accountMachineDetailLine(
        isConnected: true,
        isAsleep: false,
        directoryOnline: true,
        lastSeenAt: Date(),
        power: nil
      ),
      "Connected"
    )
  }

  func testMachineRowDetailLines() {
    let now = Date()
    XCTAssertEqual(
      accountMachineDetailLine(
        isConnected: true,
        isAsleep: false,
        directoryOnline: true,
        lastSeenAt: now,
        power: AccountMachinePower(batteryPercent: nil, charging: nil, onExternalPower: true),
        now: now
      ),
      "Plugged in"
    )
    XCTAssertEqual(
      accountMachineDetailLine(
        isConnected: false,
        isAsleep: true,
        directoryOnline: false,
        lastSeenAt: now.addingTimeInterval(-180),
        power: AccountMachinePower(batteryPercent: 82, charging: false, onExternalPower: false),
        now: now
      ),
      "Asleep · 82% battery"
    )
    // No battery, so wall power is all there is to say.
    XCTAssertEqual(
      accountMachineDetailLine(
        isConnected: false,
        isAsleep: false,
        directoryOnline: true,
        lastSeenAt: now,
        power: AccountMachinePower(batteryPercent: nil, charging: nil, onExternalPower: true),
        now: now
      ),
      "Online · plugged in"
    )
    // A battery level from three days ago is a number, not a fact.
    XCTAssertEqual(
      accountMachineDetailLine(
        isConnected: false,
        isAsleep: false,
        directoryOnline: false,
        lastSeenAt: now.addingTimeInterval(-3 * 86_400),
        power: AccountMachinePower(batteryPercent: 61, charging: false, onExternalPower: false),
        now: now
      ),
      "Last seen 3d ago"
    )
  }

  /// The desktop rule, which iOS contradicted: a docked MacBook at 82% said
  /// "plugged in" here and "82% battery" over there. Battery wins — the
  /// percentage is the number the reader actually wants — and "plugged in" is
  /// reserved for a machine that has no battery to report.
  func testBatteryWinsOverWallPower() {
    XCTAssertEqual(
      accountMachinePowerClause(
        AccountMachinePower(batteryPercent: 82, charging: true, onExternalPower: true)
      ),
      "82% battery"
    )
    XCTAssertEqual(
      accountMachinePowerClause(
        AccountMachinePower(batteryPercent: nil, charging: nil, onExternalPower: true)
      ),
      "plugged in"
    )
    XCTAssertEqual(
      accountMachineDetailLine(
        isConnected: false,
        isAsleep: true,
        directoryOnline: false,
        lastSeenAt: Date(),
        power: AccountMachinePower(batteryPercent: 82, charging: true, onExternalPower: true)
      ),
      "Asleep · 82% battery"
    )
  }

  /// The function's own comment — "a battery level from three days ago is a
  /// number, not a fact" — was defeated by `isAsleep`, which does not refresh
  /// the heartbeat that carried the reading. A machine that announced a suspend
  /// and then lost power kept reporting a charge it no longer has.
  func testAnnouncedSleepDoesNotReviveAStalePowerReading() {
    let now = Date()
    let power = AccountMachinePower(batteryPercent: 61, charging: false, onExternalPower: false)
    XCTAssertEqual(
      accountMachineDetailLine(
        isConnected: false,
        isAsleep: true,
        directoryOnline: false,
        lastSeenAt: now.addingTimeInterval(-3 * 86_400),
        power: power,
        now: now
      ),
      "Asleep"
    )
    // Inside the freshness window the reading still stands.
    XCTAssertEqual(
      accountMachineDetailLine(
        isConnected: false,
        isAsleep: true,
        directoryOnline: false,
        lastSeenAt: now.addingTimeInterval(-60),
        power: power,
        now: now
      ),
      "Asleep · 61% battery"
    )
  }

  /// The same rule, defeated the other way: the freshness gate sat below the
  /// connected branch, so being attached exempted a reading from having to be
  /// recent. A Mac reachable over the LAN with its internet down keeps the
  /// channel and stops heartbeating, and its row went on stating an hours-old
  /// battery percentage as fact.
  func testConnectedMachineDoesNotRenderAStalePowerReading() {
    let now = Date()
    let power = AccountMachinePower(batteryPercent: 82, charging: false, onExternalPower: false)
    XCTAssertEqual(
      accountMachineDetailLine(
        isConnected: true,
        isAsleep: false,
        directoryOnline: false,
        lastSeenAt: now.addingTimeInterval(-4 * 3_600),
        power: power,
        now: now
      ),
      "Connected"
    )
    // A heartbeat inside the window still makes the reading a fact.
    XCTAssertEqual(
      accountMachineDetailLine(
        isConnected: true,
        isAsleep: false,
        directoryOnline: false,
        lastSeenAt: now.addingTimeInterval(-60),
        power: power,
        now: now
      ),
      "82% battery"
    )
  }

  // MARK: - Presence word vs wake need

  /// The two windows are different lengths on purpose. A Mac powered off six
  /// hours ago is inside the 24h wake window — tapping its link may still
  /// offer to wake it — but nothing may RENDER it as "Asleep" beside a Wake
  /// button, because past ten minutes the honest answer is "we don't know".
  func testPresenceWordUsesTheTenMinuteWindowNotTheWakeWindow() {
    let now = Date()
    let sixHoursAgo = now.addingTimeInterval(-6 * 3_600)
    XCTAssertEqual(
      syncMachineWakeNeed(online: false, lastSeenAt: sixHoursAgo, now: now),
      .asleep
    )
    XCTAssertEqual(
      syncMachinePresence(
        connected: false,
        online: false,
        sleepState: nil,
        lastSeenAt: sixHoursAgo,
        now: now
      ),
      .offline
    )
    XCTAssertEqual(
      syncMachinePresence(
        connected: false,
        online: false,
        sleepState: nil,
        lastSeenAt: now.addingTimeInterval(-120),
        now: now
      ),
      .asleep
    )
  }

  /// Mirrors `MACHINE_SLEEP_INFERENCE_WINDOW_MS` in
  /// apps/desktop/src/shared/types/power.ts. If that constant moves this fails,
  /// which is the point: three clients disagreeing about "asleep" is the bug.
  func testSleepInferenceWindowMatchesTheSharedContract() {
    XCTAssertEqual(syncMachineSleepInferenceWindow, 10 * 60)
    XCTAssertLessThan(syncMachineSleepInferenceWindow, syncMachineRecentlySeenWindow)
  }

  /// The ordering the shared contract calls the bug fix, and which iOS had
  /// backwards: a phone said "Connected" to a Mac that had been asleep for
  /// three minutes, because the socket to a sleeping machine does not report
  /// itself closed.
  func testAnnouncedSleepOutranksAttached() {
    XCTAssertEqual(
      syncMachinePresence(
        connected: true,
        online: true,
        sleepState: .asleep,
        sleepStateAt: Date(),
        lastSeenAt: Date()
      ),
      .asleep
    )
    XCTAssertEqual(
      syncMachinePresence(
        connected: true,
        online: true,
        sleepState: .awake,
        lastSeenAt: Date()
      ),
      .connected
    )
    XCTAssertEqual(
      syncMachinePresence(
        connected: false,
        online: true,
        sleepState: nil,
        lastSeenAt: Date()
      ),
      .online
    )
    XCTAssertEqual(
      syncMachinePresence(
        connected: false,
        online: false,
        sleepState: nil,
        lastSeenAt: nil
      ),
      .offline
    )
  }

  // MARK: - Outcome-first connection card

  /// The bug in the screenshots: "Connecting to MacBook Pro (97)…" over
  /// "Reaching Arul's Mac Studio…" on one card. Whatever the state, the card
  /// can only ever be about one machine.
  func testCardNeverNamesTwoMachinesAtOnce() {
    let outcome = settingsConnectionOutcome(
      transport: .connected,
      asleepMachineName: "MacBook Pro (97)",
      attachedMachineName: "Arul's Mac Studio"
    )
    XCTAssertEqual(
      settingsConnectionOutcomeTitle(outcome),
      "MacBook Pro (97) is asleep"
    )
    XCTAssertEqual(
      settingsConnectionOutcomeDetail(outcome),
      "You\u{2019}re still on Arul's Mac Studio"
    )
    // The subject line names the target; the detail names where you actually
    // are. Neither is a stale label left over from the other.
    XCTAssertNotEqual(
      settingsConnectionOutcomeTitle(outcome),
      settingsConnectionOutcomeDetail(outcome)
    )
  }

  func testWakingCardLeadsWithTheOutcome() {
    let outcome = settingsConnectionOutcome(
      transport: .connecting,
      asleepMachineName: "MacBook Pro (97)",
      attachedMachineName: "Arul's Mac Studio"
    )
    XCTAssertEqual(outcome, .waking(machine: "MacBook Pro (97)"))
    XCTAssertEqual(
      settingsConnectionOutcomeTitle(outcome),
      "MacBook Pro (97) is waking up"
    )
  }

  /// With nowhere to fall back to, claiming a machine we are not on would be
  /// the same lie in the other direction.
  func testAsleepCardWithNothingToFallBackToNamesNoMachine() {
    let outcome = settingsConnectionOutcome(
      transport: .unreachable,
      asleepMachineName: "MacBook Pro (97)",
      attachedMachineName: "Arul's Mac Studio"
    )
    XCTAssertEqual(outcome, .asleep(machine: "MacBook Pro (97)", attachedTo: nil))
    XCTAssertEqual(settingsConnectionOutcomeDetail(outcome), "Not connected right now")
  }

  func testAwakeMachineKeepsTheStandardCard() {
    for transport in [SyncTransportHealth.connected, .connecting, .unreachable, .disconnected] {
      XCTAssertEqual(
        settingsConnectionOutcome(
          transport: transport,
          asleepMachineName: nil,
          attachedMachineName: "Arul's Mac Studio"
        ),
        .standard
      )
    }
    XCTAssertNil(settingsConnectionOutcomeTitle(.standard))
    XCTAssertNil(settingsConnectionOutcomeDetail(.standard))
  }

  func testOutcomeStatusLinesStayShort() {
    let outcomes: [SettingsConnectionOutcome] = [
      .waking(machine: "MacBook Pro (97)"),
      .asleep(machine: "MacBook Pro (97)", attachedTo: "Arul's Mac Studio"),
      .asleep(machine: "MacBook Pro (97)", attachedTo: nil),
    ]
    for outcome in outcomes {
      XCTAssertLessThanOrEqual(
        settingsConnectionOutcomeDetail(outcome)?.split(separator: " ").count ?? 0,
        6,
        "\(outcome) detail line is too long to scan"
      )
    }
  }

  // MARK: - Honest failure cause

  /// "Relay accepted the connection but its secure bridge was not ready in
  /// time" is true and useless: the bridge was not ready because the machine
  /// was still waking. It sent the user looking at ADE's cloud for a closed lid.
  func testASleepingMachineIsNeverBlamedOnTheRelay() {
    let relayMessage = "Relay accepted the connection but its secure bridge was not ready in time."
    XCTAssertEqual(
      syncConnectFailureMessage(wasWakingMachine: true, transportMessage: relayMessage),
      "It didn\u{2019}t wake up in time."
    )
    XCTAssertEqual(
      syncConnectFailureMessage(wasWakingMachine: false, transportMessage: relayMessage),
      relayMessage
    )
  }

  /// The inverse mistake: the wake blame was applied to EVERY error in the
  /// adoption catch, so a wrong PIN on a sleeping Mac read "It didn't wake up
  /// in time." while the same block offered the PIN sheet.
  func testHostNamedFailuresAreNeverReportedAsAFailedWake() {
    for code in [SyncPairingFailureCode.invalidPin, .pinNotSet, .other("account_mismatch")] {
      XCTAssertEqual(
        syncConnectFailureMessage(
          wasWakingMachine: true,
          transportMessage: "Incorrect PIN.",
          pairingFailure: code
        ),
        "Incorrect PIN."
      )
      // And it must not leave the card saying the machine is asleep either.
      XCTAssertFalse(
        syncConnectFailureBlamesSleep(wasWakingMachine: true, pairingFailure: code)
      )
    }
    XCTAssertTrue(
      syncConnectFailureBlamesSleep(wasWakingMachine: true, pairingFailure: nil)
    )
    XCTAssertFalse(
      syncConnectFailureBlamesSleep(wasWakingMachine: false, pairingFailure: nil)
    )
  }

  /// The failure has to carry the machine and its sleep, because the restore
  /// that follows clears the attempt target and the card would otherwise have
  /// nothing left to name.
  func testFailureRemembersTheSleepingMachineAfterTheRestore() {
    let failure = SyncConnectAttemptFailure(
      message: "It\u{2019}s asleep.",
      machineName: "MacBook Pro (97)",
      machineWasAsleep: true
    )
    XCTAssertEqual(failure.machineName, "MacBook Pro (97)")
    XCTAssertTrue(failure.machineWasAsleep)
    // Failures that know neither still read exactly as before.
    let plain = SyncConnectAttemptFailure(message: "Couldn't connect.")
    XCTAssertNil(plain.machineName)
    XCTAssertNil(plain.machineIdentity)
    XCTAssertFalse(plain.machineWasAsleep)
  }

  // MARK: - The card names, and wakes, one machine

  /// The bug: `restorePreviousConnection` repoints the attempt at the fallback
  /// and clears the wake flag, but leaves `lastConnectAttemptFailure` standing
  /// — so the card read "MacBook Pro is waking up" while it dialled the Studio.
  func testRestoreIsNeverReportedAsTheFailedMachineWakingUp() {
    let failure = SyncConnectAttemptFailure(
      message: "It\u{2019}s asleep.",
      machineName: "MacBook Pro (97)",
      machineIdentity: "device-macbook",
      machineWasAsleep: true
    )
    XCTAssertNil(syncAsleepCardSubject(
      transport: .connecting,
      attemptIsWakingMachine: false,
      attemptMachineName: "Arul's Mac Studio",
      attemptMachineIdentity: "device-studio",
      failure: failure
    ))
    // A genuine wake in flight still owns the card, and names its own target.
    let waking = syncAsleepCardSubject(
      transport: .connecting,
      attemptIsWakingMachine: true,
      attemptMachineName: "MacBook Pro (97)",
      attemptMachineIdentity: "device-macbook",
      failure: nil
    )
    XCTAssertEqual(waking?.name, "MacBook Pro (97)")
    XCTAssertEqual(waking?.identity, "device-macbook")
  }

  /// "Wake it" used to resolve its target through the live attempt, which the
  /// restore had already repointed — so the button under "MacBook Pro is
  /// asleep" dialled the Mac Studio.
  func testWakeTargetsTheMachineTheCardNames() {
    let failure = SyncConnectAttemptFailure(
      message: "It\u{2019}s asleep.",
      machineName: "MacBook Pro (97)",
      machineIdentity: "device-macbook",
      machineWasAsleep: true
    )
    let subject = syncAsleepCardSubject(
      transport: .connected,
      attemptIsWakingMachine: false,
      attemptMachineName: "Arul's Mac Studio",
      attemptMachineIdentity: "device-studio",
      failure: failure
    )
    XCTAssertEqual(subject?.name, "MacBook Pro (97)")
    XCTAssertEqual(subject?.identity, "device-macbook")
    // A plain transport failure never puts the sleep card up at all.
    XCTAssertNil(syncAsleepCardSubject(
      transport: .unreachable,
      attemptIsWakingMachine: false,
      attemptMachineName: nil,
      attemptMachineIdentity: nil,
      failure: SyncConnectAttemptFailure(message: "Couldn't connect.")
    ))
  }

  /// The card names the sleeping machine from the failure record, but the key
  /// "Wake it" dials is resolved against the account directory — which can be
  /// empty, stale, or simply not list that machine. The button used to render
  /// off the name alone, so in that case it appeared and did nothing. The
  /// affordance is now bound to the key: no key, no button.
  func testWakeActionNeedsAResolvedMachineOrItDoesNotRender() {
    let asleep = SettingsConnectionOutcome.asleep(
      machine: "MacBook Pro (97)",
      attachedTo: "Arul's Mac Studio"
    )
    XCTAssertEqual(
      settingsWakeMachineKey(outcome: asleep, wakeMachineKey: "machine-macbook"),
      "machine-macbook"
    )
    // Directory could not resolve the named machine: copy still stands, action
    // does not.
    XCTAssertNil(settingsWakeMachineKey(outcome: asleep, wakeMachineKey: nil))
    XCTAssertNil(settingsWakeMachineKey(outcome: asleep, wakeMachineKey: "   "))
    // A wake already in flight has nothing to offer either — the attempt IS
    // the action.
    XCTAssertNil(settingsWakeMachineKey(
      outcome: .waking(machine: "MacBook Pro (97)"),
      wakeMachineKey: "machine-macbook"
    ))
    XCTAssertNil(settingsWakeMachineKey(outcome: .standard, wakeMachineKey: "machine-macbook"))
  }

  /// Identity beats name, because two Macs in one account can share a name.
  func testFailureResolvesItsMachineByIdentityFirst() throws {
    let macbook = try Self.decodeMachine("""
    {"machineKey": "mbp", "name": "MacBook Pro", "deviceId": "device-macbook", "online": false}
    """)
    let twin = try Self.decodeMachine("""
    {"machineKey": "mbp-2", "name": "MacBook Pro", "deviceId": "device-twin", "online": true}
    """)
    let failure = SyncConnectAttemptFailure(
      message: "It\u{2019}s asleep.",
      machineName: "MacBook Pro",
      machineIdentity: "device-macbook",
      machineWasAsleep: true
    )
    XCTAssertEqual(
      syncConnectAttemptFailureMachine(failure, in: [twin, macbook])?.machineKey,
      "mbp"
    )
    // With no identity the name is all there is, and the first match stands.
    let nameOnly = SyncConnectAttemptFailure(
      message: "It\u{2019}s asleep.",
      machineName: "MacBook Pro",
      machineWasAsleep: true
    )
    XCTAssertEqual(
      syncConnectAttemptFailureMachine(nameOnly, in: [twin, macbook])?.machineKey,
      "mbp-2"
    )
  }

  /// The sticky card: cleared only by the next user-initiated attempt, so a
  /// failed wake followed by a successful restore left the settings card amber
  /// — still offering to wake a machine that woke ten minutes ago — for the
  /// rest of the session.
  func testSleepCardRetiresOnceTheDirectorySaysTheMachineWoke() throws {
    // The directory never sends `sleepState` without `sleepStateAt` — the Worker
    // stamps it on write — so a fixture without one is not a shape the wire can
    // produce, and an undated announcement is deliberately treated as stale.
    let freshStamp = Int(Date().timeIntervalSince1970 * 1000)
    let asleep = try Self.decodeMachine("""
    {"machineKey": "mbp", "name": "MacBook Pro", "deviceId": "device-macbook",
     "online": false, "sleepState": "asleep", "sleepStateAt": \(freshStamp)}
    """)
    let awake = try Self.decodeMachine("""
    {"machineKey": "mbp", "name": "MacBook Pro", "deviceId": "device-macbook",
     "online": true, "sleepState": "awake"}
    """)
    let failure = SyncConnectAttemptFailure(
      message: "It\u{2019}s asleep.",
      machineName: "MacBook Pro",
      machineIdentity: "device-macbook",
      machineWasAsleep: true
    )
    XCTAssertFalse(syncSleepFailureIsStale(failure: failure, machines: [asleep]))
    XCTAssertTrue(syncSleepFailureIsStale(failure: failure, machines: [awake]))
    // An announcement the directory can never clear must not pin the card
    // either: once it ages past the inference window it stops being evidence.
    let stale = try Self.decodeMachine("""
    {"machineKey": "mbp", "name": "MacBook Pro", "deviceId": "device-macbook",
     "online": false, "sleepState": "asleep",
     "sleepStateAt": \(freshStamp - Int((syncMachineSleepInferenceWindow + 60) * 1000))}
    """)
    XCTAssertTrue(syncSleepFailureIsStale(failure: failure, machines: [stale]))
    // A plain transport failure is still the newest thing that happened.
    XCTAssertFalse(syncSleepFailureIsStale(
      failure: SyncConnectAttemptFailure(message: "Couldn't connect."),
      machines: [awake]
    ))
    // A machine the directory no longer lists cannot be checked; silence is not
    // evidence it woke.
    XCTAssertFalse(syncSleepFailureIsStale(failure: failure, machines: []))
    XCTAssertFalse(syncSleepFailureIsStale(failure: nil, machines: [awake]))
  }

  // MARK: - Cold-launch restore is not a machine transition

  /// The bug: `.task(id:)` fires for the request `SyncService.init` mints for
  /// session restore, which names no machine — so owner resolution ran on every
  /// cold launch and turned a plain relaunch into a machine transition, before
  /// Clerk had restored and before the launch reconnect had started.
  func testColdLaunchRestoreDoesNotResolveAnOwningMachine() {
    let restored = WorkSessionNavigationRequest(sessionId: "session-1")
    XCTAssertEqual(restored.origin, .inApp)
    XCTAssertNil(restored.ownerResolutionSessionId)
  }

  /// The half that must keep working: a widget or notification link carries no
  /// machine key and depends entirely on the session-id lookup.
  func testExternalLinksStillResolveTheirOwningMachine() {
    let link = WorkSessionNavigationRequest(sessionId: "session-1", origin: .external)
    XCTAssertEqual(link.ownerResolutionSessionId, "session-1")
    // An explicit key is unaffected either way — it is taken at its word.
    let keyed = WorkSessionNavigationRequest(
      sessionId: "session-1",
      accountMachineKey: "studio",
      origin: .external
    )
    XCTAssertEqual(keyed.accountMachineKey, "studio")
  }

  // MARK: - Wake budget

  /// A MacBook waking from clamshell sleep was measured at 16s from the first
  /// dial to a usable relay bridge. Under the standard 10s budget a sleeping
  /// Mac could never be reached on the first tap.
  func testWakeBudgetCoversAMeasuredSixteenSecondWake() {
    let measuredWakeNanoseconds: UInt64 = 16_000_000_000
    XCTAssertGreaterThan(
      SyncConnectionRaceBudget.wakingMachine.overallNanoseconds,
      measuredWakeNanoseconds
    )
    XCTAssertGreaterThan(
      SyncConnectionRaceBudget.wakingMachine.relayReadyAfterAcceptedNanoseconds,
      measuredWakeNanoseconds
    )
    XCTAssertLessThan(
      SyncConnectionRaceBudget.standard.overallNanoseconds,
      measuredWakeNanoseconds
    )
  }

  /// Every waiting state is bounded, and the relay window has to expire inside
  /// the race so the endpoint records its own failure.
  func testEveryWakeDeadlineIsBoundedAndOrdered() {
    for budget in [SyncConnectionRaceBudget.standard, .wakingMachine] {
      XCTAssertGreaterThan(budget.overallNanoseconds, 0)
      XCTAssertLessThan(
        budget.relayReadyAfterAcceptedNanoseconds,
        budget.overallNanoseconds,
        "a relay that never bridges has to fail inside the race"
      )
    }
    XCTAssertEqual(SyncConnectionRaceBudget.forAttempt(wakingMachine: true), .wakingMachine)
    XCTAssertEqual(SyncConnectionRaceBudget.forAttempt(wakingMachine: false), .standard)
  }

  func testRelayNegotiationUsesTheAttemptBudget() {
    var waking = SyncRelayReadyNegotiation(budget: .wakingMachine)
    // Before `accepted` the window is the same either way: it only covers the
    // WebSocket upgrade, which a sleeping machine plays no part in.
    XCTAssertEqual(
      waking.phaseBudgetNanoseconds,
      SyncConnectionRaceTiming.relayAcceptedNegotiationNanoseconds
    )
    XCTAssertEqual(waking.receive(.accepted), .interceptedWaiting)
    XCTAssertEqual(
      waking.phaseBudgetNanoseconds,
      SyncConnectionRaceTiming.wakeRelayReadyAfterAcceptedNanoseconds
    )

    var standard = SyncRelayReadyNegotiation()
    XCTAssertEqual(standard.receive(.accepted), .interceptedWaiting)
    XCTAssertEqual(
      standard.phaseBudgetNanoseconds,
      SyncConnectionRaceTiming.relayReadyAfterAcceptedNanoseconds
    )
  }

  // MARK: - Stage label handoff

  /// The exact defect in the screenshots. The attempt against the MacBook
  /// published "Connecting to MacBook Pro (97)…", then failed and handed off to
  /// the restore, which repointed the attempt at the Mac Studio. The stage
  /// label was only cleared at the very end of the attempt, so for the whole
  /// restore the card carried one machine's title over another machine's line.
  @MainActor
  func testStageLabelIsRetiredWhenTheAttemptIsRepointed() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      // `suspendAutoReconnect: false` — this teardown is not the user asking to
      // stop connecting, and that flag persists across relaunches.
      service.disconnect(clearCredentials: false, suspendAutoReconnect: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    service.setConnectAttemptTargetForTesting(
      machineName: "MacBook Pro (97)",
      machineIdentity: "mbp"
    )
    service.publishAccountConnectStageForTesting("Connecting to MacBook Pro (97)…")
    XCTAssertEqual(service.accountConnectStageLabel, "Connecting to MacBook Pro (97)…")

    // The handoff the fallback path performs.
    service.setConnectAttemptTargetForTesting(
      machineName: "Arul's Mac Studio",
      machineIdentity: "studio"
    )
    XCTAssertEqual(service.connectAttemptTarget?.machineName, "Arul's Mac Studio")
    XCTAssertNil(
      service.accountConnectStageLabel,
      "the failed attempt's title must not outlive its target"
    )
  }

  /// Repointing at the SAME machine is not a handoff, so it must not throw away
  /// live progress copy mid-attempt.
  @MainActor
  func testStageLabelSurvivesARepointToTheSameMachine() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      // `suspendAutoReconnect: false` — this teardown is not the user asking to
      // stop connecting, and that flag persists across relaunches.
      service.disconnect(clearCredentials: false, suspendAutoReconnect: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    service.setConnectAttemptTargetForTesting(machineName: "MacBook Pro (97)", machineIdentity: "mbp")
    service.publishAccountConnectStageForTesting("Verifying it's really MacBook Pro (97)…")
    service.setConnectAttemptTargetForTesting(machineName: "MacBook Pro (97)", machineIdentity: "mbp")
    XCTAssertEqual(
      service.accountConnectStageLabel,
      "Verifying it's really MacBook Pro (97)…"
    )
  }

  /// The comment claimed word-for-word parity with the desktop's
  /// `machinePowerPhrase` and did not have it: a machine that said it was NOT
  /// on external power got "on battery" over there and nothing here. The two
  /// remaining differences are the documented ones, and both are about not
  /// inventing an answer the machine never gave.
  func testPowerClauseMatchesTheDesktopPhraseItDocuments() {
    // The case that was silently missing.
    XCTAssertEqual(
      accountMachinePowerClause(
        AccountMachinePower(batteryPercent: nil, charging: nil, onExternalPower: false)
      ),
      "on battery"
    )
    XCTAssertEqual(
      accountMachinePowerClause(
        AccountMachinePower(batteryPercent: nil, charging: false, onExternalPower: false)
      ),
      "on battery"
    )
    // Documented difference 1: unknown stays unknown. The desktop's field is a
    // plain boolean, so it cannot tell these apart; this one can.
    XCTAssertNil(
      accountMachinePowerClause(
        AccountMachinePower(batteryPercent: nil, charging: nil, onExternalPower: nil)
      )
    )
    // Documented difference 2: charging is wall power by another name, and the
    // only signal left when the battery read fails.
    XCTAssertEqual(
      accountMachinePowerClause(
        AccountMachinePower(batteryPercent: nil, charging: true, onExternalPower: nil)
      ),
      "plugged in"
    )
    // And the shared rules still hold in both directions.
    XCTAssertEqual(
      accountMachinePowerClause(
        AccountMachinePower(batteryPercent: 82, charging: false, onExternalPower: false)
      ),
      "82% battery"
    )
    XCTAssertEqual(
      accountMachinePowerClause(
        AccountMachinePower(batteryPercent: nil, charging: nil, onExternalPower: true)
      ),
      "plugged in"
    )
    XCTAssertEqual(
      accountMachineDetailLine(
        isConnected: false,
        isAsleep: false,
        directoryOnline: true,
        lastSeenAt: Date(),
        power: AccountMachinePower(batteryPercent: nil, charging: nil, onExternalPower: false)
      ),
      "Online · on battery"
    )
  }

  /// Both wake decisions read `lastSeenAt` off a directory record, and both
  /// hand-rolled the millisecond conversion — skipping the finite/non-negative
  /// guard the shared helper exists to apply. A nonsense stamp has to read as
  /// no stamp, not as a Date built from NaN.
  func testDirectoryEpochStampsGoThroughTheGuardedHelper() throws {
    XCTAssertNil(machineLastSeenDate(epochMilliseconds: nil))
    XCTAssertNil(machineLastSeenDate(epochMilliseconds: -1))
    XCTAssertNil(machineLastSeenDate(epochMilliseconds: .nan))
    XCTAssertNil(machineLastSeenDate(epochMilliseconds: .infinity))
    XCTAssertEqual(
      machineLastSeenDate(epochMilliseconds: 1_700_000_000_000),
      Date(timeIntervalSince1970: 1_700_000_000)
    )
    // A guarded stamp reads exactly as an absent one, which is the property the
    // two wake call sites now inherit.
    XCTAssertEqual(
      syncMachineWakeNeed(
        online: false,
        lastSeenAt: machineLastSeenDate(epochMilliseconds: .nan),
        sleepState: nil
      ),
      syncMachineWakeNeed(online: false, lastSeenAt: nil, sleepState: nil)
    )
    let service = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()
      .deletingLastPathComponent()
      .appendingPathComponent("ADE/Services/SyncService.swift")
    let text = try String(contentsOf: service, encoding: .utf8)
    XCTAssertFalse(
      text.contains("Date(timeIntervalSince1970: $0 / 1000)"),
      "millisecond stamps belong to machineLastSeenDate(epochMilliseconds:)"
    )
  }

  // MARK: - Owner resolution has exactly one rule, applied everywhere

  /// The property test above proves the RULE. This proves every CALLER obeys
  /// it, which is the half that actually regressed: `ContentView` was corrected
  /// and Work's own handler was not, so the cold-launch restore still resolved
  /// an owner on a plain relaunch. A source scan is the only thing that fails
  /// when a third screen reintroduces it.
  func testEveryNavigationRequestConsumerRespectsTheOriginRule() throws {
    let sources = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent()  // ADETests
      .deletingLastPathComponent()  // apps/ios
      .appendingPathComponent("ADE", isDirectory: true)
    let enumerated = try XCTUnwrap(
      FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil),
      "the app sources must be readable for this guard to mean anything"
    )
    var callSites = 0
    for case let url as URL in enumerated where url.pathExtension == "swift" {
      guard let text = try? String(contentsOf: url, encoding: .utf8) else { continue }
      var searchRange = text.startIndex..<text.endIndex
      while let found = text.range(
        of: "ensureAccountMachineForNavigation(",
        range: searchRange
      ) {
        callSites += 1
        let window = text[found.upperBound...].prefix(200)
        // `request.ownerResolutionSessionId` contains no ".sessionId", so this
        // catches exactly the mistake: a session id read straight off a
        // request and handed to owner resolution.
        XCTAssertFalse(
          window.contains(".sessionId"),
          """
          \(url.lastPathComponent) passes a request's raw sessionId to owner \
          resolution. Use ensureAccountMachineForNavigation(for:) — an in-app \
          request, including the cold-launch restore, must not resolve an owner.
          """
        )
        searchRange = found.upperBound..<text.endIndex
      }
    }
    XCTAssertGreaterThanOrEqual(
      callSites,
      3,
      "the scan found almost nothing — it is no longer looking at the app sources"
    )
  }

  // MARK: - A machine waking up is not the work opening

  /// The bug: retirement cleared the whole failure. The common wake is one
  /// where the Mac woke but the bridge was not ready inside the budget, so the
  /// directory reports it awake seconds later — and "It didn't wake up in
  /// time." vanished with no user action, making the tap look like it did
  /// nothing.
  @MainActor
  func testRetiringAStaleSleepClaimKeepsTheFailureTheUserIsReading() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false, suspendAutoReconnect: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let awake = try Self.decodeMachine("""
    {"machineKey": "mbp", "name": "MacBook Pro", "deviceId": "device-macbook",
     "online": true, "sleepState": "awake"}
    """)
    service.setLastConnectAttemptFailureForTesting(SyncConnectAttemptFailure(
      message: "It didn\u{2019}t wake up in time.",
      machineName: "MacBook Pro",
      machineIdentity: "device-macbook",
      machineWasAsleep: true
    ))
    service.retireStaleSleepFailure(machines: [awake])

    XCTAssertEqual(
      service.lastConnectAttemptFailure?.message,
      "It didn\u{2019}t wake up in time.",
      "the attempt still failed, and the user has not acted on it yet"
    )
    XCTAssertEqual(service.lastConnectAttemptFailure?.machineName, "MacBook Pro")
    XCTAssertFalse(
      service.lastConnectAttemptFailure?.machineWasAsleep ?? true,
      "the directory disproved the sleep claim, so the card must stop making it"
    )
    // Which is exactly what retires the sleep card and its "Wake it".
    XCTAssertNil(syncAsleepCardSubject(
      transport: .connected,
      attemptIsWakingMachine: false,
      attemptMachineName: nil,
      attemptMachineIdentity: nil,
      failure: service.lastConnectAttemptFailure
    ))
    // And the row still has something to say when the user looks.
    XCTAssertEqual(
      settingsMachineRowErrorMessage(
        attemptFailure: service.lastConnectAttemptFailure,
        lastError: nil,
        fallback: "ADE could not connect to that computer. Try again."
      ),
      "It didn\u{2019}t wake up in time."
    )
  }

  /// A machine that is still asleep keeps its claim: retirement is evidence
  /// driven, not a timer.
  @MainActor
  func testSleepClaimSurvivesWhileTheMachineIsStillAsleep() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false, suspendAutoReconnect: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let freshStamp = Int(Date().timeIntervalSince1970 * 1000)
    let asleep = try Self.decodeMachine("""
    {"machineKey": "mbp", "name": "MacBook Pro", "deviceId": "device-macbook",
     "online": false, "sleepState": "asleep", "sleepStateAt": \(freshStamp)}
    """)
    service.setLastConnectAttemptFailureForTesting(SyncConnectAttemptFailure(
      message: "It didn\u{2019}t wake up in time.",
      machineName: "MacBook Pro",
      machineIdentity: "device-macbook",
      machineWasAsleep: true
    ))
    service.retireStaleSleepFailure(machines: [asleep])
    XCTAssertTrue(service.lastConnectAttemptFailure?.machineWasAsleep ?? false)
  }

  // MARK: - The prompt survives the dismissal it causes

  /// Closing a competing sheet and presenting the wake card in the same
  /// MainActor turn asks one presenter for a fourth sheet while a sibling's
  /// dismissal is still animating, and SwiftUI may simply drop it — leaving
  /// the navigation parked for the full prompt timeout with nothing on screen.
  /// By the time the prompt exists the sheet that would have hidden it must
  /// already be gone.
  @MainActor
  func testWakePromptIsPresentedOnlyAfterTheCompetingSheetIsGone() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false, suspendAutoReconnect: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    service.settingsPresented = true
    let prompt = Task { @MainActor in
      _ = await service.awaitMachineWakeDecision(
        machineName: "MacBook Pro",
        need: .asleep,
        stage: .confirm
      )
    }
    while service.pendingMachineWake == nil {
      await Task.yield()
    }
    XCTAssertFalse(
      service.settingsPresented,
      "the dismissal has to commit before the presenter is asked for the card"
    )
    // The hop must not cost the prompt: it still arrives, naming its machine.
    XCTAssertEqual(service.pendingMachineWake?.machineName, "MacBook Pro")
    service.cancelPendingMachineWake()
    _ = await prompt.value
  }

  // MARK: - The prompt is never left waiting on a continuation nobody holds

  /// The bug: a second prompt overwrote `machineWakeDecision` and the displaced
  /// continuation was never resumed, so the first navigation's task hung
  /// forever and `accountNavigationInFlight` was never cleared.
  @MainActor
  func testASecondWakePromptReleasesTheFirstOnesWaiter() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false, suspendAutoReconnect: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let displaced = expectation(description: "the first prompt's waiter returns")
    let first = Task { @MainActor in
      let answered = await service.awaitMachineWakeDecision(
        machineName: "MacBook Pro",
        need: .asleep,
        stage: .confirm
      )
      // A prompt the user never saw the end of is a "Not now", never a wake.
      XCTAssertFalse(answered)
      displaced.fulfill()
    }
    while service.machineWakeDecision == nil {
      await Task.yield()
    }

    let second = Task { @MainActor in
      _ = await service.awaitMachineWakeDecision(
        machineName: "Mac Studio",
        need: .asleep,
        stage: .confirm
      )
    }
    await fulfillment(of: [displaced], timeout: 5)
    _ = await first.value

    service.cancelPendingMachineWake()
    _ = await second.value
  }

  // MARK: - Fixtures

  /// The wake card is the fourth sheet chained onto the root's single
  /// presenter. With Settings, Activity or Linear already up it never appeared
  /// at all, and the navigation awaiting the tap parked for the full 90s prompt
  /// timeout with nothing on screen to answer it.
  @MainActor
  func testWakePromptClosesTheSheetsThatWouldHideIt() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false, suspendAutoReconnect: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    service.settingsPresented = true
    service.attentionDrawerPresented = true
    service.linearPanePresented = true
    XCTAssertTrue(service.dismissSheetsCompetingWithMachineWake())
    XCTAssertFalse(service.settingsPresented)
    XCTAssertFalse(service.attentionDrawerPresented)
    XCTAssertFalse(service.linearPanePresented)
  }

  private static func decodeMachine(_ json: String) throws -> AccountMachine {
    try JSONDecoder().decode(AccountMachine.self, from: Data(json.utf8))
  }

  private static func attentionItem(
    sessionId: String,
    accountMachineKey: String?
  ) -> AccountAttentionItem {
    AccountAttentionItem(
      id: "item-\(sessionId)",
      revision: 1,
      fingerprint: "fingerprint-\(sessionId)",
      kind: .agent,
      eventKind: .agentRunning,
      phase: .running,
      machine: AccountAttentionMachine(
        machineKey: "publisher-\(accountMachineKey ?? "unknown")",
        accountMachineKey: accountMachineKey,
        name: "Machine",
        online: true,
        lastSeenAt: nil
      ),
      project: AccountAttentionProject(projectId: "project-1", name: "Project"),
      title: "Chat",
      preview: "preview",
      privacyPreview: "private",
      destination: .session(sessionId: sessionId, itemId: nil, eventId: nil),
      occurredAt: Date(),
      updatedAt: Date()
    )
  }

  private static func workspaceSnapshot(
    machineId: String?,
    sessionIds: [String]
  ) -> WorkspaceSnapshot {
    WorkspaceSnapshot(
      generatedAt: Date(),
      agents: sessionIds.map { sessionId in
        AgentSnapshot(
          sessionId: sessionId,
          provider: "claude",
          title: "Chat",
          status: "running",
          awaitingInput: false,
          lastActivityAt: Date(),
          elapsedSeconds: 1,
          preview: nil,
          progress: nil,
          phase: nil,
          toolCalls: 0
        )
      },
      prs: [],
      connection: "connected",
      machineId: machineId
    )
  }
}
