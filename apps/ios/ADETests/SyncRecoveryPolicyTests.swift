import XCTest
@testable import ADE

final class SyncRecoveryPolicyTests: XCTestCase {
  private let connectionDefaultsKeys = [
    "ade.sync.hostProfile",
    "ade.sync.hostProfiles",
    "ade.sync.connectionDraft",
    "ade.sync.autoReconnectPausedByUser",
    "ade.sync.activeProjectHostIdentity",
    "ade.sync.remoteCommandDescriptors",
  ]

  private func snapshotDefaults(keys: [String]) -> [String: Any] {
    keys.reduce(into: [String: Any]()) { snapshot, key in
      if let value = UserDefaults.standard.object(forKey: key) {
        snapshot[key] = value
      }
    }
  }

  private func restoreDefaults(_ snapshot: [String: Any], keys: [String]) {
    for key in keys {
      UserDefaults.standard.removeObject(forKey: key)
      if let value = snapshot[key] {
        UserDefaults.standard.set(value, forKey: key)
      }
    }
  }

  private func makeReconnectProfile(hostIdentity: String) -> HostConnectionProfile {
    HostConnectionProfile(
      hostIdentity: hostIdentity,
      hostName: "Mac Studio",
      port: 8787,
      authKind: "paired",
      pairedDeviceId: nil,
      lastRemoteDbVersion: 0,
      lastHostDeviceId: hostIdentity,
      lastSuccessfulAddress: "127.0.0.1",
      savedAddressCandidates: ["127.0.0.1"],
      discoveredLanAddresses: ["127.0.0.1"],
      tailscaleAddress: nil
    )
  }

  func testLiveChatCreationTimeoutIsAmbiguousAndNeverReplayedAutomatically() async {
    do {
      let _: AgentChatSessionSummary = try await performLiveChatCreationWithoutReplay {
        throw SyncRequestTimeout.error()
      }
      XCTFail("Expected the timed-out live chat creation to remain ambiguous.")
    } catch let error as AmbiguousChatCreationError {
      XCTAssertTrue(isSyncRequestTimeoutError(error.underlyingError))
    } catch {
      XCTFail("Expected an ambiguous delivery error, got \(error)")
    }
  }

  func testLiveChatCreationPreservesDefinitiveHostRejection() async {
    let rejection = NSError(
      domain: "ADE",
      code: 17,
      userInfo: [
        NSLocalizedDescriptionKey: "Model unavailable.",
        "ADEErrorCode": "model_unavailable",
      ]
    )

    do {
      let _: AgentChatSessionSummary = try await performLiveChatCreationWithoutReplay {
        throw rejection
      }
      XCTFail("Expected the host rejection to be preserved.")
    } catch is AmbiguousChatCreationError {
      XCTFail("A definitive host rejection must not be marked ambiguous.")
    } catch {
      XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "model_unavailable")
    }
  }

  func testRequestTimeoutRecoveryProbesOnlyAfterSilence() {
    XCTAssertEqual(
      syncRequestTimeoutRecoveryAction(
        disconnectOnTimeout: true,
        now: 100,
        lastInboundMessageAt: 94,
        silenceThreshold: 12
      ),
      .failRequestOnly
    )
    XCTAssertEqual(
      syncRequestTimeoutRecoveryAction(
        disconnectOnTimeout: true,
        now: 100,
        lastInboundMessageAt: 80,
        silenceThreshold: 12
      ),
      .probeTransport
    )
    XCTAssertEqual(
      syncRequestTimeoutRecoveryAction(
        disconnectOnTimeout: false,
        now: 100,
        lastInboundMessageAt: nil,
        silenceThreshold: 12
      ),
      .failRequestOnly
    )
  }

  func testTransportProbeAllowsMoreTimeOnExpensiveAndConstrainedPaths() {
    XCTAssertEqual(syncTransportProbeTimeoutNanoseconds(isExpensive: false, isConstrained: false), 5_000_000_000)
    XCTAssertEqual(syncTransportProbeTimeoutNanoseconds(isExpensive: true, isConstrained: false), 8_000_000_000)
    XCTAssertEqual(syncTransportProbeTimeoutNanoseconds(isExpensive: true, isConstrained: true), 12_000_000_000)
  }

  func testHeartbeatSilenceProbeIsTolerantOfExpensiveAndConstrainedPaths() {
    XCTAssertEqual(
      syncHeartbeatSilenceThresholdSeconds(
        heartbeatIntervalNanoseconds: 15_000_000_000,
        isExpensive: false,
        isConstrained: false
      ),
      30
    )
    XCTAssertEqual(
      syncHeartbeatSilenceThresholdSeconds(
        heartbeatIntervalNanoseconds: 15_000_000_000,
        isExpensive: true,
        isConstrained: false
      ),
      45
    )
    XCTAssertEqual(
      syncHeartbeatSilenceThresholdSeconds(
        heartbeatIntervalNanoseconds: 25_000_000_000,
        isExpensive: true,
        isConstrained: true
      ),
      100
    )
    XCTAssertFalse(
      syncShouldProbeTransportAfterHeartbeatSilence(
        now: 159,
        lastInboundMessageAt: 100,
        heartbeatIntervalNanoseconds: 15_000_000_000,
        isExpensive: true,
        isConstrained: true
      )
    )
    XCTAssertTrue(
      syncShouldProbeTransportAfterHeartbeatSilence(
        now: 160,
        lastInboundMessageAt: 100,
        heartbeatIntervalNanoseconds: 15_000_000_000,
        isExpensive: true,
        isConstrained: true
      )
    )
  }

  func testReconnectStateExhaustionOpensOneQuietHeartbeatAttempt() {
    var state = SyncReconnectState()

    for _ in 0..<SyncReconnectState.maxAutomaticAttempts {
      _ = state.nextDelayNanoseconds()
    }
    XCTAssertTrue(state.isExhausted)

    state.allowOneSlowAttempt()
    XCTAssertFalse(state.isExhausted)
    _ = state.nextDelayNanoseconds()
    XCTAssertTrue(state.isExhausted)
  }

  func testReconnectJitterStaysBoundedAndDeterministic() {
    XCTAssertEqual(syncJitteredReconnectDelayNanoseconds(base: 10_000, sample: 0), 8_000)
    XCTAssertEqual(syncJitteredReconnectDelayNanoseconds(base: 10_000, sample: 0.5), 10_000)
    XCTAssertEqual(syncJitteredReconnectDelayNanoseconds(base: 10_000, sample: 1), 12_000)
    XCTAssertEqual(syncJitteredReconnectDelayNanoseconds(base: 10_000, sample: -1), 8_000)
    XCTAssertEqual(syncJitteredReconnectDelayNanoseconds(base: 10_000, sample: 2), 12_000)
  }

  func testPathHandoffSkipsStaleResetOfNewHealthySocket() {
    XCTAssertEqual(
      syncNetworkPathRecoveryAction(
        shouldRoamToTailnet: true,
        isPathSatisfied: true,
        hasLiveConnection: true
      ),
      .scheduleForcedReset
    )
    XCTAssertEqual(
      syncNetworkPathRecoveryAction(
        shouldRoamToTailnet: false,
        isPathSatisfied: true,
        hasLiveConnection: true
      ),
      .cancelScheduledReconnect
    )
    XCTAssertEqual(
      syncNetworkPathRecoveryAction(
        shouldRoamToTailnet: false,
        isPathSatisfied: true,
        hasLiveConnection: false
      ),
      .scheduleReconnect
    )
    XCTAssertEqual(
      syncScheduledPathReconnectAction(
        forceSocketReset: true,
        scheduledConnectionGeneration: 4,
        currentConnectionGeneration: 4,
        hasLiveConnection: true
      ),
      .resetAndReconnect
    )
    XCTAssertEqual(
      syncScheduledPathReconnectAction(
        forceSocketReset: true,
        scheduledConnectionGeneration: 4,
        currentConnectionGeneration: 5,
        hasLiveConnection: true
      ),
      .skip
    )
    XCTAssertEqual(
      syncScheduledPathReconnectAction(
        forceSocketReset: true,
        scheduledConnectionGeneration: 4,
        currentConnectionGeneration: 5,
        hasLiveConnection: false
      ),
      .reconnect
    )
  }

  func testEstablishedSocketCompletionUsesRecoveryOwnerWithoutRacingOpenOrHandshake() {
    XCTAssertEqual(
      syncSocketCompletionAction(
        isCurrentSocket: true,
        completedWhileOpening: false,
        canSendLiveRequests: true,
        closeCodeRawValue: 4001
      ),
      .recoverTransport(closeCodeRawValue: 4001)
    )
    XCTAssertEqual(
      syncSocketCompletionAction(
        isCurrentSocket: true,
        completedWhileOpening: true,
        canSendLiveRequests: false,
        closeCodeRawValue: 4001
      ),
      .failOpening
    )
    XCTAssertEqual(
      syncSocketCompletionAction(
        isCurrentSocket: true,
        completedWhileOpening: false,
        canSendLiveRequests: false,
        closeCodeRawValue: nil
      ),
      .failHandshake
    )
    XCTAssertEqual(
      syncSocketCompletionAction(
        isCurrentSocket: false,
        completedWhileOpening: false,
        canSendLiveRequests: true,
        closeCodeRawValue: 4001
      ),
      .ignore
    )
  }

  func testRelayApplicationCloseCodesRemainTransportFailures() {
    let byteCapped = syncSocketCloseError(
      closeCodeRawValue: 4506,
      reason: "pre-pipe buffer overflow"
    )
    XCTAssertEqual(
      byteCapped.localizedDescription,
      "The relay connection was interrupted. Reconnecting now."
    )
    XCTAssertNil(byteCapped.userInfo["ADEErrorCode"])

    let bridgeRejected = syncSocketCloseError(
      closeCodeRawValue: 4507,
      reason: "bridge rejected"
    )
    XCTAssertEqual(
      bridgeRejected.localizedDescription,
      "The machine couldn't accept the relay connection. Reconnecting now."
    )
    XCTAssertNil(bridgeRejected.userInfo["ADEErrorCode"])
    XCTAssertNotEqual(
      SyncUserFacingError.message(for: bridgeRejected),
      "This phone is no longer paired with this machine. Pair again from Settings."
    )
    XCTAssertEqual(
      syncSocketCompletionAction(
        isCurrentSocket: true,
        completedWhileOpening: false,
        canSendLiveRequests: true,
        closeCodeRawValue: 4507
      ),
      .recoverTransport(closeCodeRawValue: 4507)
    )
  }

  func testUnknownApplicationCloseCodeDegradesToGenericTransportRecovery() {
    let error = syncSocketCloseError(closeCodeRawValue: 4999, reason: nil)
    XCTAssertEqual(
      error.localizedDescription,
      "The connection to the machine was interrupted. Reconnecting now."
    )
    XCTAssertNil(error.userInfo["ADEErrorCode"])
    XCTAssertEqual(
      syncSocketCompletionAction(
        isCurrentSocket: true,
        completedWhileOpening: false,
        canSendLiveRequests: true,
        closeCodeRawValue: 4999
      ),
      .recoverTransport(closeCodeRawValue: 4999)
    )
  }

  @MainActor
  func testAttemptedLiveChatSendTimeoutNeverEntersDurableQueue() async throws {
    let pendingOperationsKey = "ade.sync.pendingOperations"
    let pendingSnapshot = snapshotDefaults(keys: [pendingOperationsKey])
    UserDefaults.standard.removeObject(forKey: pendingOperationsKey)
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.beginOutboundEnvelopeCaptureForTesting()
    service.configureConnectedTransportForTesting()
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
      restoreDefaults(pendingSnapshot, keys: [pendingOperationsKey])
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let sendTask = Task {
      try await service.sendChatMessage(sessionId: "chat-timeout", text: "Do this once")
    }
    var requestId: String?
    for _ in 0..<10 where requestId == nil {
      await Task.yield()
      requestId = service.capturedOutboundRequestIdsForTesting(type: "command").first
    }
    service.firePendingRequestTimeoutForTesting(requestId: try XCTUnwrap(requestId))

    do {
      _ = try await sendTask.value
      XCTFail("Expected the attempted live chat send to time out ambiguously.")
    } catch {
      XCTAssertTrue(isSyncRequestTimeoutError(error))
    }
    XCTAssertTrue(service.pendingOperationsForTesting().isEmpty)
    XCTAssertEqual(service.pendingOperationCount, 0)
  }

  @MainActor
  func testTransportProbeSuccessKeepsSocketWhileFailureSchedulesSingleRecoveryOwner() throws {
    let defaultsSnapshot = snapshotDefaults(keys: connectionDefaultsKeys)
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    let profile = makeReconnectProfile(hostIdentity: "probe-owner-host")
    service.beginOutboundEnvelopeCaptureForTesting()
    service.configureConnectedTransportForTesting()
    service.configureReconnectProfileForTesting(profile, token: "probe-owner-token")
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
      service.clearReconnectProfileForTesting(profile)
      restoreDefaults(defaultsSnapshot, keys: connectionDefaultsKeys)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let healthyGeneration = service.connectionGenerationForTesting()
    service.completeTransportProbeForTesting(heardInboundTraffic: true)
    XCTAssertEqual(service.connectionState, .connected)
    XCTAssertEqual(service.connectionGenerationForTesting(), healthyGeneration)
    XCTAssertFalse(service.hasScheduledReconnectWorkForTesting())

    service.completeTransportProbeForTesting(heardInboundTraffic: false)
    XCTAssertEqual(service.connectionState, .connecting)
    XCTAssertGreaterThan(service.connectionGenerationForTesting(), healthyGeneration)
    XCTAssertTrue(service.hasScheduledReconnectWorkForTesting())
  }

  @MainActor
  func testFastBudgetExhaustionPublishesUnreachableAndArmsQuietHeartbeat() throws {
    let defaultsSnapshot = snapshotDefaults(keys: connectionDefaultsKeys)
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    let profile = makeReconnectProfile(hostIdentity: "slow-heartbeat-host")
    service.configureReconnectProfileForTesting(profile, token: "slow-heartbeat-token")
    defer {
      service.disconnect(clearCredentials: false)
      service.clearReconnectProfileForTesting(profile)
      restoreDefaults(defaultsSnapshot, keys: connectionDefaultsKeys)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    service.exhaustFastReconnectBudgetForTesting(
      NSError(
        domain: NSURLErrorDomain,
        code: NSURLErrorCannotConnectToHost,
        userInfo: [NSLocalizedDescriptionKey: "Host unavailable."]
      )
    )

    XCTAssertEqual(service.connectionState, .error)
    XCTAssertEqual(service.connectionHealth.transport, .unreachable)
    XCTAssertTrue(service.hasScheduledReconnectWorkForTesting())
  }

  @MainActor
  func testHealthyForegroundDoesNotRebuildSocketOrReplayChatSubscriptions() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.beginOutboundEnvelopeCaptureForTesting()
    service.configureConnectedTransportForTesting()
    service.completeCapturedRefreshRequestsForTesting()
    service.resetOutboundEnvelopeCaptureForTesting()
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let generation = service.connectionGenerationForTesting()
    await service.handleForegroundTransition()

    XCTAssertEqual(service.connectionState, .connected)
    XCTAssertEqual(service.connectionGenerationForTesting(), generation)
    XCTAssertFalse(service.hasScheduledReconnectWorkForTesting())
    XCTAssertEqual(service.capturedOutboundEnvelopeCountForTesting(type: "chat_subscribe"), 0)
  }

  @MainActor
  func testHelloReducedLoadTransitionRestoresEachChatSubscriptionOnce() async throws {
    let defaultsSnapshot = snapshotDefaults(keys: connectionDefaultsKeys)
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    let testProfile = makeReconnectProfile(hostIdentity: "host-subscribe-once")
    service.beginOutboundEnvelopeCaptureForTesting()
    service.configureConnectedTransportForTesting()
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
      service.clearReconnectProfileForTesting(testProfile)
      restoreDefaults(defaultsSnapshot, keys: connectionDefaultsKeys)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    service.setNetworkPathForTesting(
      usesWiFi: true,
      usesCellular: false,
      usesWiredEthernet: false
    )
    let helloPayload: [String: Any] = [
      "brain": [
        "deviceId": "host-subscribe-once",
        "deviceName": "Mac Studio",
      ],
      "features": [
        "chatStreaming": true,
      ],
    ]
    try service.applyHelloPayloadForTesting(helloPayload)
    try await service.subscribeToChatEvents(sessionId: "chat-1")

    service.resetOutboundEnvelopeCaptureForTesting()
    service.setNetworkPathForTesting(
      usesWiFi: false,
      usesCellular: true,
      usesWiredEthernet: false,
      isExpensive: true,
      isConstrained: true
    )
    try service.applyHelloPayloadForTesting(helloPayload)

    XCTAssertEqual(
      service.capturedOutboundEnvelopeCountForTesting(type: "chat_subscribe"),
      1,
      "Hello must own one subscription replay even when route load mode changes."
    )
  }
}
