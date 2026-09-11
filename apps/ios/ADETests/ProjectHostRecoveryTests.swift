import XCTest
@testable import ADE

final class ProjectHostRecoveryTests: XCTestCase {
  // A repair that restarts the brain and finds the same conflict still there
  // must reopen the conflict card. Holding `.recovering` for any non-ready
  // snapshot stranded the phone on the spinner with no way out.
  func testASurvivingConflictReopensTheCardInsteadOfHoldingTheSpinner() {
    let conflict = SyncHostConflictPublic(
      reason: "lock",
      ownerKind: .development,
      ownerLabel: "Development runtime",
      projectLabel: "improving-browser lane",
      impact: "May interrupt improving-browser lane.",
      recoveryEligible: true,
      technicalDetail: "reason: lock"
    )
    let snapshot = SyncHostReadinessSnapshot(
      state: .conflict,
      headline: "Another ADE is blocking this machine",
      body: "A development runtime is using the connection your phone needs.",
      conflict: conflict,
      recoveryEligible: true
    )
    // What the helper does when the caller has already recognised the conflict.
    XCTAssertEqual(
      nextProjectHostPhase(current: .takeover, snapshot: snapshot),
      .takeover
    )
    // And the trap it still has to hold for a repair genuinely in progress.
    let starting = SyncHostReadinessSnapshot(
      state: .starting,
      headline: "Starting this machine",
      body: "This machine is still starting its project connection.",
      conflict: nil,
      recoveryEligible: true
    )
    XCTAssertEqual(
      nextProjectHostPhase(current: .recovering, snapshot: starting),
      .recovering
    )
  }

  func testParsesConflictSnapshotWithoutPidInBody() {
    let snapshot = parseSyncHostReadinessSnapshot([
      "state": "conflict",
      "headline": "Another ADE is blocking this machine",
      "body": "A development runtime is using the connection your phone needs.",
      "recoveryEligible": true,
      "conflict": [
        "reason": "listener",
        "ownerKind": "development",
        "ownerLabel": "Development runtime",
        "projectLabel": "improving-browser lane",
        "impact": "May interrupt improving-browser lane.",
        "recoveryEligible": true,
        "technicalDetail": "pid: 4242",
      ],
    ])
    XCTAssertEqual(snapshot?.state, .conflict)
    XCTAssertEqual(snapshot?.conflict?.ownerLabel, "Development runtime")
    XCTAssertFalse(snapshot?.body.contains("4242") == true)
    XCTAssertTrue(snapshot?.conflict?.technicalDetail.contains("4242") == true)
    XCTAssertTrue(projectHostShouldTakeOverImmediately(snapshot))
    XCTAssertEqual(
      nextProjectHostPhase(current: .ready, snapshot: snapshot),
      .takeover
    )
  }

  func testGenericStartingRetriesThenTakesOver() {
    let starting = parseSyncHostReadinessSnapshot([
      "state": "starting",
      "headline": "Starting services",
      "body": "This machine is starting its project connection.",
      "conflict": NSNull(),
      "recoveryEligible": false,
    ])
    XCTAssertEqual(nextProjectHostPhase(current: .ready, snapshot: starting), .retrying)
    XCTAssertEqual(
      nextProjectHostPhase(current: .retrying, snapshot: starting, retriesExhausted: true),
      .takeover
    )
  }

  func testUnwrapPreservesHostUnavailableSnapshot() {
    let raw: [String: Any] = [
      "commandId": "cmd-1",
      "ok": false,
      "error": [
        "code": "host_unavailable",
        "message": "A development runtime is using the connection your phone needs.",
        "reason": "conflict",
        "recoveryEligible": true,
        "snapshot": [
          "state": "conflict",
          "headline": "Another ADE is blocking this machine",
          "body": "A development runtime is using the connection your phone needs.",
          "recoveryEligible": true,
          "conflict": [
            "reason": "listener",
            "ownerKind": "development",
            "ownerLabel": "Development runtime",
            "projectLabel": "improving-browser lane",
            "recoveryEligible": true,
            "technicalDetail": "pid: 4242",
          ],
        ],
      ],
    ]
    XCTAssertThrowsError(try unwrapSyncCommandResponse(raw)) { error in
      let nsError = error as NSError
      XCTAssertEqual(nsError.userInfo["ADEErrorCode"] as? String, "host_unavailable")
      XCTAssertEqual(nsError.userInfo["ADEErrorReason"] as? String, "conflict")
      XCTAssertTrue(isSyncHostUnavailableError(error))
      let snapshot = syncHostReadinessSnapshot(from: error)
      XCTAssertEqual(snapshot?.state, .conflict)
      XCTAssertEqual(SyncUserFacingError.message(for: error), snapshot?.body)
      XCTAssertFalse(SyncUserFacingError.message(for: error).localizedCaseInsensitiveContains("project sync host"))
    }
  }

  func testDomainFailureCopyDropsHydrationJargon() {
    let status = SyncDomainStatus(phase: .failed, lastError: "Timed out loading fresh data.", lastHydratedAt: nil)
    XCTAssertEqual(status.inlineHydrationFailureNotice(for: .work)?.title, "Couldn't load your chats")
    XCTAssertEqual(status.inlineHydrationFailureNotice(for: .lanes)?.title, "Couldn't load your lanes")
  }

  func testConflictImpactSurvivesParsingSoTheScreenCanShowIt() {
    let snapshot = parseSyncHostReadinessSnapshot([
      "state": "conflict",
      "headline": "Another ADE is blocking this machine",
      "body": "A development runtime is using the connection your phone needs.",
      "recoveryEligible": true,
      "conflict": [
        "reason": "listener",
        "ownerKind": "development",
        "ownerLabel": "Development runtime",
        "projectLabel": "improving-browser lane",
        "impact": "May interrupt improving-browser lane.",
        "recoveryEligible": true,
        "technicalDetail": "pid: 4242",
      ],
    ])
    XCTAssertEqual(snapshot?.conflict?.impact, "May interrupt improving-browser lane.")
    XCTAssertNil(projectHostBlockedReason(snapshot))
    XCTAssertNil(projectHostIneligibleGuidance(snapshot))
  }

  func testStepStatusWordsNeverReachTheUser() {
    XCTAssertEqual(projectHostRecoveryStepMark("done"), .done)
    XCTAssertEqual(projectHostRecoveryStepMark("active"), .active)
    XCTAssertEqual(projectHostRecoveryStepMark("pending"), .pending)
    XCTAssertEqual(projectHostRecoveryStepMark("failed"), .failed)
    XCTAssertNil(projectHostRecoveryStepMark("skipped"))
    for mark in [ProjectHostRecoveryStepMark.done, .active, .pending, .failed] {
      XCTAssertFalse(mark.symbol.isEmpty)
    }
  }

  func testSkippedStepsAreHiddenAndLabelsStayHuman() {
    let rows = projectHostRecoveryStepRows([
      SyncHostRecoveryStep(id: "diagnose", status: "done", detail: nil),
      SyncHostRecoveryStep(id: "stop", status: "done", detail: nil),
      SyncHostRecoveryStep(id: "wait", status: "skipped", detail: nil),
      SyncHostRecoveryStep(id: "restart", status: "active", detail: nil),
      SyncHostRecoveryStep(id: "prove", status: "pending", detail: nil),
    ])
    XCTAssertEqual(rows.map(\.id), ["diagnose", "stop", "restart", "prove"])
    XCTAssertEqual(rows.map(\.mark), [.done, .done, .active, .pending])
    XCTAssertEqual(rows[1].label, "Stopped blocking runtime")
    XCTAssertEqual(rows[2].label, "Restarting this machine")
    XCTAssertEqual(rows[3].label, "Checking chats")
    for row in rows {
      XCTAssertFalse(row.label.contains(row.mark.rawValue))
      XCTAssertNotEqual(row.label, row.id)
    }
  }

  func testUnauthorizedDeviceGetsItsOwnDeadEndCopy() {
    let snapshot = parseSyncHostReadinessSnapshot([
      "state": "conflict",
      "headline": "Another ADE is blocking this machine",
      "body": "Another ADE runtime is using the connection your phone needs.",
      "recoveryEligible": false,
      "conflict": [
        "reason": "listener",
        "ownerKind": "unknown",
        "ownerLabel": "Another ADE runtime",
        "recoveryEligible": false,
        "technicalDetail": projectHostRedactedConflictDetail,
      ],
    ])
    XCTAssertEqual(projectHostBlockedReason(snapshot), .unauthorized)
    let copy = projectHostIneligibleGuidance(snapshot)
    XCTAssertEqual(copy, "This iPhone can't stop the other runtime — retry, switch machines, or stop it on that computer.")
    XCTAssertFalse(copy?.localizedCaseInsensitiveContains("pid") == true)
  }

  func testUnidentifiedRuntimeGetsDifferentDeadEndCopy() {
    let snapshot = parseSyncHostReadinessSnapshot([
      "state": "conflict",
      "headline": "Another ADE is blocking this machine",
      "body": "Another ADE runtime is using the connection your phone needs.",
      "recoveryEligible": false,
      "conflict": [
        "reason": "listener",
        "ownerKind": "installed",
        "ownerLabel": "Another ADE runtime",
        "recoveryEligible": false,
        "technicalDetail": "reason: listener\npid: 4242",
      ],
    ])
    XCTAssertEqual(projectHostBlockedReason(snapshot), .unidentified)
    XCTAssertEqual(
      projectHostIneligibleGuidance(snapshot),
      "ADE can't safely stop the other runtime from here, so stop it on that computer."
    )
    XCTAssertNotEqual(
      projectHostIneligibleGuidance(snapshot),
      "This iPhone can't stop the other runtime — retry, switch machines, or stop it on that computer."
    )
  }

  func testInlineHydrationFailureKeepsRawTextOutOfTheBody() {
    let raw = "sync.listLanes failed: ECONNRESET at 127.0.0.1:8787"
    let status = SyncDomainStatus(phase: .failed, lastError: raw, lastHydratedAt: nil)
    let notice = status.inlineHydrationFailureNotice(for: .lanes)
    XCTAssertEqual(notice?.title, "Couldn't load your lanes")
    XCTAssertEqual(notice?.technicalDetail, raw)
    XCTAssertFalse(notice?.message.contains("ECONNRESET") == true)
    XCTAssertEqual(
      notice?.message,
      "ADE couldn't get fresh lanes from your machine. You're seeing the ones it loaded last."
    )
    XCTAssertEqual(adeWhatToDoSteps(notice?.nextAction).count, 2)
  }

  func testBlankHydrationErrorLeavesNoEmptyTechnicalFold() {
    let status = SyncDomainStatus(phase: .failed, lastError: "  \n ", lastHydratedAt: nil)
    let notice = status.inlineHydrationFailureNotice(for: .prs)
    XCTAssertNil(notice?.technicalDetail)
    XCTAssertEqual(
      notice?.message,
      "ADE couldn't get fresh pull requests from your machine. You're seeing the ones it loaded last."
    )
  }

  func testWhatToDoListIsCappedAtTwoLines() {
    XCTAssertEqual(adeWhatToDoSteps(nil), [])
    XCTAssertEqual(adeWhatToDoSteps("   "), [])
    XCTAssertEqual(adeWhatToDoSteps("Tap Retry."), ["Tap Retry."])
    XCTAssertEqual(adeWhatToDoSteps("One\n\nTwo\nThree"), ["One", "Two"])
  }

  func testFailedTurnDefaultTitleIsNotError() {
    XCTAssertEqual(errorPresentation(for: "unknown").title, "Couldn't start this turn")
    XCTAssertFalse(errorPresentation(for: "unknown").title.localizedCaseInsensitiveContains("error"))
  }

  func testWorkPresentedChatFailureReadsHostPresentation() {
    let presented = workPresentedChatFailure(
      message: "Local SDK sandboxing was requested",
      detail: nil,
      errorInfo: .object([
        "category": .string("unknown"),
        "presentation": .object([
          "title": .string("Couldn't start this turn"),
          "body": .string("This ADE runtime can't use Cursor's sandbox. ADE still blocks writes through its own hooks."),
          "nextAction": .string("Retry the turn."),
          "technicalDetail": .string("sandboxing is not supported"),
        ]),
      ])
    )
    XCTAssertEqual(presented.title, "Couldn't start this turn")
    XCTAssertTrue(presented.body.contains("can't use Cursor's sandbox"))
    XCTAssertEqual(presented.technicalDetail, "sandboxing is not supported")
  }

  // Reopening a chat replays the persisted rows. Reading `errorInfo` there the
  // way the live mapper does is what keeps one failed turn from showing the
  // host's copy while live and generic local copy after a reload.
  func testReplayedErrorKeepsTheHostPresentation() throws {
    let transcript = parseWorkChatTranscript("""
    {
      "sessionId": "chat-1",
      "timestamp": "2026-09-11T00:00:00.000Z",
      "sequence": 1,
      "event": {
        "type": "error",
        "turnId": "turn-1",
        "message": "Local SDK sandboxing was requested",
        "errorInfo": {
          "category": "configuration",
          "provider": "Cursor",
          "presentation": {
            "title": "Couldn't start this turn",
            "body": "This ADE runtime can't use Cursor's sandbox.",
            "nextAction": "Retry the turn.",
            "technicalDetail": "sandboxing is not supported"
          }
        }
      }
    }
    """)
    let replayed = try XCTUnwrap(transcript.last)
    guard case .error(let message, let detail, let category, _, let title, let nextAction) = replayed.event else {
      return XCTFail("the persisted row has to decode as an error")
    }
    XCTAssertEqual(title, "Couldn't start this turn")
    XCTAssertEqual(message, "This ADE runtime can't use Cursor's sandbox.")
    XCTAssertEqual(nextAction, "Retry the turn.")
    XCTAssertEqual(detail, "sandboxing is not supported")
    XCTAssertEqual(category, "configuration")
  }

  // An older host sends `errorInfo` with no presentation and no `detail`. Its
  // provider codes have to stay recoverable from the transcript.
  func testLegacyErrorInfoStillFillsTheTechnicalFold() throws {
    let presented = workPresentedChatFailure(
      message: "Request failed",
      detail: nil,
      errorInfo: .object([
        "category": .string("network"),
        "provider": .string("Cursor"),
        "code": .string("ECONNRESET"),
      ])
    )
    let technical = try XCTUnwrap(presented.technicalDetail)
    XCTAssertTrue(technical.contains("ECONNRESET"))
    XCTAssertEqual(presented.body, "Request failed")
    XCTAssertFalse(presented.body.contains("ECONNRESET"))

    // The same payload replayed from a persisted row.
    let transcript = parseWorkChatTranscript("""
    {
      "sessionId": "chat-1",
      "timestamp": "2026-09-11T00:00:00.000Z",
      "sequence": 1,
      "event": {
        "type": "error",
        "turnId": "turn-1",
        "message": "Request failed",
        "errorInfo": { "category": "network", "provider": "Cursor", "code": "ECONNRESET" }
      }
    }
    """)
    guard case .error(let message, let detail, _, _, _, _) = try XCTUnwrap(transcript.last).event else {
      return XCTFail("the persisted row has to decode as an error")
    }
    XCTAssertEqual(message, "Request failed")
    XCTAssertTrue(try XCTUnwrap(detail).contains("ECONNRESET"))
  }

  // The fold never repeats the body, and an empty `detail` must not shadow the
  // legacy `errorInfo` payload behind it.
  func testTechnicalFoldNeitherRepeatsTheBodyNorSwallowsErrorInfo() throws {
    let repeated = workPresentedChatFailure(
      message: "Request failed",
      detail: "Request failed",
      errorInfo: nil
    )
    XCTAssertNil(repeated.technicalDetail)

    let blankDetail = workPresentedChatFailure(
      message: "Request failed",
      detail: "   ",
      errorInfo: .object(["code": .string("ECONNRESET")])
    )
    XCTAssertTrue(try XCTUnwrap(blankDetail.technicalDetail).contains("ECONNRESET"))
  }

  // `as? Bool` also matches the numbers 0 and 1, so a replayed flag would turn
  // into a number without the CoreFoundation check.
  func testRemoteJSONValueConversionKeepsBoolsAndNumbersApart() {
    XCTAssertEqual(remoteJSONValue(from: ["retryable": true]), .object(["retryable": .bool(true)]))
    XCTAssertEqual(remoteJSONValue(from: ["attempts": 1]), .object(["attempts": .number(1)]))
    XCTAssertEqual(remoteJSONValue(from: ["codes": ["a", NSNull()]]), .object(["codes": .array([.string("a"), .null])]))
    XCTAssertNil(remoteJSONValue(from: nil))
    XCTAssertNil(remoteJSONValue(from: NSNull()))
  }

  // The repair restarts the machine, so the command's own socket usually dies
  // before `command_result` comes back. Reading that as failure made the phone
  // report the restart it asked for as the end of the repair.
  func testRestartInducedSocketDropIsNotAFailedRepair() {
    let dropped = NSError(
      domain: "ADE",
      code: 26,
      userInfo: [NSLocalizedDescriptionKey: "Connection closed."]
    )
    XCTAssertTrue(
      syncProjectHostRecoveryLostTransport(
        error: dropped,
        sentAtConnectionGeneration: 7,
        currentConnectionGeneration: 8
      )
    )
    // A timeout does not always tear the socket down, so the generation alone
    // would miss it.
    XCTAssertTrue(
      syncProjectHostRecoveryLostTransport(
        error: SyncRequestTimeout.error(),
        sentAtConnectionGeneration: 7,
        currentConnectionGeneration: 7
      )
    )
    // Same socket, no timeout: nothing was lost.
    XCTAssertFalse(
      syncProjectHostRecoveryLostTransport(
        error: dropped,
        sentAtConnectionGeneration: 7,
        currentConnectionGeneration: 7
      )
    )
  }

  func testAnsweredRejectionStillEndsTheRepair() {
    let rejected = NSError(
      domain: "ADE",
      code: 17,
      userInfo: [
        "ADEErrorCode": "not_allowed",
        NSLocalizedDescriptionKey: "This device can't manage runtimes on that machine.",
      ]
    )
    XCTAssertTrue(isRemoteCommandApplicationError(rejected))
    // Even a reconnect in the same moment must not turn an answer into a hold.
    XCTAssertFalse(
      syncProjectHostRecoveryLostTransport(
        error: rejected,
        sentAtConnectionGeneration: 7,
        currentConnectionGeneration: 9
      )
    )
    let unavailable = NSError(
      domain: "ADE",
      code: 17,
      userInfo: [
        "ADEErrorCode": "host_unavailable",
        "ADEErrorReason": "conflict",
        NSLocalizedDescriptionKey: "A development runtime is using the connection your phone needs.",
      ]
    )
    XCTAssertFalse(
      syncProjectHostRecoveryLostTransport(
        error: unavailable,
        sentAtConnectionGeneration: 7,
        currentConnectionGeneration: 9
      )
    )
  }

  // The ramp is a budget for a slow host. A repair in progress has none: the
  // phone asked for the restart and must keep checking until the machine is
  // ready or the user acts.
  func testSilentRetryKeepsCheckingWhileARepairIsRunning() {
    XCTAssertEqual(projectHostSilentRetryStep(phase: .retrying, completedAttempts: 0), .check(afterSeconds: 2))
    XCTAssertEqual(projectHostSilentRetryStep(phase: .retrying, completedAttempts: 2), .check(afterSeconds: 8))
    XCTAssertEqual(projectHostSilentRetryStep(phase: .retrying, completedAttempts: 3), .exhausted)

    XCTAssertEqual(projectHostSilentRetryStep(phase: .recovering, completedAttempts: 0), .check(afterSeconds: 2))
    XCTAssertEqual(projectHostSilentRetryStep(phase: .recovering, completedAttempts: 3), .check(afterSeconds: 8))
    XCTAssertEqual(projectHostSilentRetryStep(phase: .recovering, completedAttempts: 40), .check(afterSeconds: 8))

    XCTAssertEqual(projectHostSilentRetryStep(phase: .takeover, completedAttempts: 0), .stop)
    XCTAssertEqual(projectHostSilentRetryStep(phase: .ready, completedAttempts: 0), .stop)
  }
}
