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
      .attemptAuthenticatedReplacement
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

  func testApplicationCloseCodeTableKeepsPrimaryCopyRouteNeutral() {
    let interrupted = "Can’t reach this Mac right now. Reconnecting now."
    let cases: [(code: Int, reason: String, expected: String)] = [
      (4000, "partner closed", interrupted),
      (4001, "heartbeat timed out", interrupted),
      (4002, "sync host handoff buffer exceeded", interrupted),
      (4003, "ADE Relay account proof expired", "This saved connection needs attention. Open Settings and reconnect."),
      (4004, "pairing cooldown", "Connection attempts are paused briefly. Try again shortly."),
      (4008, "inbound connection stale", interrupted),
      (4501, "host offline", interrupted),
      (4502, "relay idle", interrupted),
      (4503, "relay capacity", "This Mac is handling too many connections. Try again shortly."),
      (4505, "replaced by newer host", interrupted),
      (4506, "pre-pipe buffer overflow", interrupted),
      (4507, "bridge rejected", interrupted),
      (4999, "unknown relay pipe failure", interrupted),
    ]
    let forbiddenPrimaryTerms = ["offline", "pipe", "bridge", "relay"]

    for entry in cases {
      let error = syncSocketCloseError(
        closeCodeRawValue: entry.code,
        reason: entry.reason
      )
      XCTAssertEqual(error.localizedDescription, entry.expected, "close code \(entry.code)")
      XCTAssertEqual(error.userInfo["ADESocketCloseCode"] as? Int, entry.code)
      XCTAssertEqual(error.userInfo["ADESocketCloseReason"] as? String, entry.reason)
      XCTAssertNil(error.userInfo["ADEErrorCode"])
      for term in forbiddenPrimaryTerms {
        XCTAssertFalse(
          error.localizedDescription.lowercased().contains(term),
          "Primary close copy for \(entry.code) leaked diagnostic term '\(term)'."
        )
      }
      XCTAssertEqual(
        syncSocketCompletionAction(
          isCurrentSocket: true,
          completedWhileOpening: false,
          canSendLiveRequests: true,
          closeCodeRawValue: entry.code
        ),
        .recoverTransport(closeCodeRawValue: entry.code)
      )
    }
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

  func testAuthenticatedRaceStartsLastGoodThenDifferentTransportsWithinBudget() {
    let lastGood = SyncConnectionEndpointAttempt(address: "192.168.1.20", port: 8787)
    let secondLan = SyncConnectionEndpointAttempt(address: "192.168.1.21", port: 8787)
    let tailnet = SyncConnectionEndpointAttempt(address: "100.90.80.70", port: 8787)
    let relay = SyncConnectionEndpointAttempt(address: "wss://relay.ade.app/connect/mac", port: 8787)
    let plan = syncConnectionRacePlan(
      rankedAttempts: [lastGood, secondLan, tailnet, relay]
    )

    XCTAssertEqual(plan.map(\.endpoint), [lastGood, tailnet, relay])
    XCTAssertEqual(plan.map(\.delayNanoseconds), [0, 250_000_000, 500_000_000])
    XCTAssertEqual(SyncConnectionRaceTiming.overallBudgetNanoseconds, 10_000_000_000)
  }

  func testAuthenticatedRaceAcceptsOneWinnerAndRejectsSlowLoser() {
    var ownership = SyncConnectionRaceOwnership(candidateIds: [0, 1, 2])
    XCTAssertEqual(
      ownership.authenticated(candidateId: 1),
      .acceptWinner(cancelCandidateIds: [0, 2])
    )
    XCTAssertEqual(ownership.authenticated(candidateId: 2), .rejectLateWinner)
    XCTAssertEqual(ownership.failed(candidateId: 0), .ignored)
  }

  func testAuthenticatedRaceBudgetCancelsEveryRemainingCandidate() {
    var ownership = SyncConnectionRaceOwnership(candidateIds: [0, 1, 2])
    XCTAssertEqual(ownership.failed(candidateId: 1), .waiting)
    XCTAssertEqual(
      ownership.expireBudget(),
      .budgetExpired(cancelCandidateIds: [0, 2])
    )
  }

  func testAuthenticatedRaceContinuesWithRankFourSecondLanAndCancelsLosers() throws {
    let lastGood = SyncConnectionEndpointAttempt(address: "192.168.1.20", port: 8787)
    let secondLan = SyncConnectionEndpointAttempt(address: "192.168.1.21", port: 8788)
    let tailnet = SyncConnectionEndpointAttempt(address: "100.90.80.70", port: 8787)
    let relay = SyncConnectionEndpointAttempt(address: "wss://relay.ade.app/connect/mac", port: 8787)
    let plan = syncConnectionRaceCandidatePlan(
      rankedAttempts: [lastGood, secondLan, tailnet, relay]
    )
    XCTAssertEqual(plan.map(\.endpoint), [lastGood, tailnet, relay, secondLan])

    var scheduler = SyncConnectionRaceWaveScheduler(candidates: plan)
    var ownership = SyncConnectionRaceOwnership(candidateIds: Set(plan.map(\.id)))
    let firstWave = scheduler.startInitialCandidates()
    XCTAssertEqual(firstWave.map(\.endpoint), [lastGood, tailnet, relay])
    XCTAssertEqual(scheduler.activeCandidateIds.count, 3)

    XCTAssertEqual(ownership.failed(candidateId: firstWave[0].id), .waiting)
    let rankFour = try XCTUnwrap(scheduler.candidateFinished(firstWave[0].id))
    XCTAssertEqual(rankFour.endpoint, secondLan)
    XCTAssertEqual(scheduler.activeCandidateIds.count, 3)

    XCTAssertEqual(
      ownership.authenticated(candidateId: rankFour.id),
      .acceptWinner(cancelCandidateIds: Set(firstWave.dropFirst().map(\.id)))
    )
    scheduler.cancelAll()
    XCTAssertTrue(scheduler.activeCandidateIds.isEmpty)
  }

  func testConnectionAttemptTimestampStrictlyIncreasesAcrossRaces() {
    XCTAssertEqual(
      syncNextConnectionAttemptStartedAtMilliseconds(
        nowMilliseconds: 1_000,
        previousMilliseconds: 1_500
      ),
      1_501
    )
    XCTAssertEqual(
      syncNextConnectionAttemptStartedAtMilliseconds(
        nowMilliseconds: 2_000,
        previousMilliseconds: 1_500
      ),
      2_000
    )
  }

  func testRelayReadyV2NegotiatesSlowWorkersAndRequiresFreshSocketForLegacyFallback() {
    XCTAssertEqual(
      syncRelayReadyV2URL("wss://relay.ade.app/connect/mac?region=iad"),
      "wss://relay.ade.app/connect/mac?region=iad&ready=2"
    )
    XCTAssertEqual(
      syncRelayLegacyURL("wss://relay.ade.app/connect/mac?region=iad&ready=2"),
      "wss://relay.ade.app/connect/mac?region=iad"
    )

    let legacy = SyncRelayReadyNegotiation()
    XCTAssertEqual(legacy.negotiationWindowExpired(), .retryLegacySocket)

    var slowNewWorker = SyncRelayReadyNegotiation()
    XCTAssertEqual(slowNewWorker.receive(.accepted), .interceptedWaiting)
    XCTAssertEqual(slowNewWorker.negotiationWindowExpired(), .interceptedWaiting)
    XCTAssertFalse(slowNewWorker.ready)

    XCTAssertEqual(slowNewWorker.receive(.ready), .sendHello)
    XCTAssertTrue(slowNewWorker.ready)
  }

  func testHostObservedRelayOverridesAdvertisedTailnetRoute() {
    XCTAssertEqual(
      syncObservedConnectionRouteKind(
        connectedHost: "studio.example.ts.net",
        hostTransport: "relay"
      ),
      .relay
    )
    XCTAssertEqual(
      syncObservedConnectionRouteKind(
        connectedHost: "studio.example.ts.net",
        hostTransport: "direct"
      ),
      .tailnet
    )
  }

  @MainActor
  func testTerminalSnapshotTimeoutIsScopedToRequest() async throws {
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
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let snapshotTask = Task {
      try await service.refreshTerminalSnapshot(sessionId: "terminal-timeout")
    }
    var requestId: String?
    for _ in 0..<20 where requestId == nil {
      await Task.yield()
      requestId = service.capturedOutboundRequestIdsForTesting(type: "terminal_subscribe").first
    }
    let capturedRequestId = try XCTUnwrap(requestId)
    XCTAssertEqual(
      service.pendingRequestDisconnectsOnTimeoutForTesting(requestId: capturedRequestId),
      false
    )
    service.firePendingRequestTimeoutForTesting(requestId: capturedRequestId)
    do {
      try await snapshotTask.value
      XCTFail("Expected the terminal snapshot request to time out.")
    } catch {
      XCTAssertTrue(isSyncRequestTimeoutError(error))
    }
  }

  @MainActor
  func testTerminalSnapshotInstallsSubscriptionBeforeFollowingDataFrame() async throws {
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
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let snapshotTask = Task {
      try await service.refreshTerminalSnapshot(sessionId: "terminal-barrier")
    }
    var requestId: String?
    for _ in 0..<20 where requestId == nil {
      await Task.yield()
      requestId = service.capturedOutboundRequestIdsForTesting(type: "terminal_subscribe").first
    }
    let capturedRequestId = try XCTUnwrap(requestId)

    // Host ordering is snapshot then any PTY data queued behind its capture
    // barrier. Accepting the snapshot must synchronously make that next frame
    // deliverable; waiting for the request continuation can lose one-shot
    // output when the receive loop wins the scheduling race.
    service.completeTerminalSnapshotRequestForTesting(
      requestId: capturedRequestId,
      sessionId: "terminal-barrier",
      transcript: "Mac% ",
      startOffset: 0,
      endOffset: 5
    )
    XCTAssertTrue(service.subscribedTerminalSessionIds.contains("terminal-barrier"))

    service.handleTerminalDataChunkForTesting(
      sessionId: "terminal-barrier",
      chunk: "pwd\r\n",
      endOffset: 10
    )
    XCTAssertEqual(service.terminalBuffers["terminal-barrier"], "Mac% pwd\r\n")
    try await snapshotTask.value
  }

  @MainActor
  func testTerminalSnapshotTimeoutRetriesAndRestoresLiveStreamWithoutSocketTeardown() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.beginOutboundEnvelopeCaptureForTesting()
    service.configureConnectedTransportForTesting()
    service.setTerminalSnapshotRecoveryDelayForTesting(0)
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let generation = service.connectionGenerationForTesting()
    let snapshotTask = Task {
      try await service.refreshTerminalSnapshot(sessionId: "terminal-retry")
    }
    var requestIds: [String] = []
    for _ in 0..<50 where requestIds.isEmpty {
      await Task.yield()
      requestIds = service.capturedOutboundRequestIdsForTesting(type: "terminal_subscribe")
    }
    let initialRequestId = try XCTUnwrap(requestIds.first)
    service.firePendingRequestTimeoutForTesting(requestId: initialRequestId)
    do {
      try await snapshotTask.value
      XCTFail("Expected the explicit snapshot request to preserve its timeout result.")
    } catch {
      XCTAssertTrue(isSyncRequestTimeoutError(error))
    }

    for _ in 0..<100 where requestIds.count < 2 {
      await Task.yield()
      requestIds = service.capturedOutboundRequestIdsForTesting(type: "terminal_subscribe")
    }
    let retryRequestId = try XCTUnwrap(requestIds.dropFirst().first)
    XCTAssertEqual(service.connectionGenerationForTesting(), generation)
    XCTAssertEqual(service.connectionState, .connected)
    XCTAssertTrue(service.hasTerminalSnapshotRecoveryForTesting(sessionId: "terminal-retry"))

    service.completeTerminalSnapshotRequestForTesting(
      requestId: retryRequestId,
      sessionId: "terminal-retry",
      transcript: "Mac% ",
      startOffset: 0,
      endOffset: 5
    )
    for _ in 0..<100 where !service.subscribedTerminalSessionIds.contains("terminal-retry") {
      await Task.yield()
    }
    XCTAssertTrue(service.subscribedTerminalSessionIds.contains("terminal-retry"))
    XCTAssertEqual(service.terminalBuffers["terminal-retry"], "Mac% ")
    XCTAssertFalse(service.hasTerminalSnapshotRecoveryForTesting(sessionId: "terminal-retry"))

    service.handleTerminalDataChunkForTesting(
      sessionId: "terminal-retry",
      chunk: "pwd\r\n",
      endOffset: 10
    )
    XCTAssertEqual(service.terminalBuffers["terminal-retry"], "Mac% pwd\r\n")

    // The original request already left the pending map. A late response from
    // it cannot replace the snapshot accepted by the retry.
    service.completeTerminalSnapshotRequestForTesting(
      requestId: initialRequestId,
      sessionId: "terminal-retry",
      transcript: "stale",
      startOffset: 0,
      endOffset: 5
    )
    XCTAssertEqual(service.terminalBuffers["terminal-retry"], "Mac% pwd\r\n")
    XCTAssertEqual(service.connectionGenerationForTesting(), generation)
    XCTAssertEqual(service.connectionState, .connected)
  }

  @MainActor
  func testTerminalSnapshotRetryIsCancelledWhenSessionUnsubscribes() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.beginOutboundEnvelopeCaptureForTesting()
    service.configureConnectedTransportForTesting()
    service.setTerminalSnapshotRecoveryDelayForTesting(60_000_000_000)
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let snapshotTask = Task {
      try await service.refreshTerminalSnapshot(sessionId: "terminal-cancel")
    }
    var requestId: String?
    for _ in 0..<50 where requestId == nil {
      await Task.yield()
      requestId = service.capturedOutboundRequestIdsForTesting(type: "terminal_subscribe").first
    }
    let capturedRequestId = try XCTUnwrap(requestId)
    service.firePendingRequestTimeoutForTesting(requestId: capturedRequestId)
    do {
      try await snapshotTask.value
      XCTFail("Expected the initial snapshot request to time out.")
    } catch {
      XCTAssertTrue(isSyncRequestTimeoutError(error))
    }
    XCTAssertTrue(service.hasTerminalSnapshotRecoveryForTesting(sessionId: "terminal-cancel"))

    try await service.unsubscribeTerminal(sessionId: "terminal-cancel")
    XCTAssertFalse(service.hasTerminalSnapshotRecoveryForTesting(sessionId: "terminal-cancel"))
    XCTAssertFalse(service.desiredTerminalSessionIdsForTesting().contains("terminal-cancel"))
    for _ in 0..<20 { await Task.yield() }
    XCTAssertEqual(
      service.capturedOutboundEnvelopeCountForTesting(type: "terminal_subscribe"),
      1
    )

    service.completeTerminalSnapshotRequestForTesting(
      requestId: capturedRequestId,
      sessionId: "terminal-cancel",
      transcript: "stale",
      startOffset: 0,
      endOffset: 5
    )
    XCTAssertNil(service.terminalBuffers["terminal-cancel"])
    XCTAssertFalse(service.subscribedTerminalSessionIds.contains("terminal-cancel"))
  }

  @MainActor
  func testProjectScopeResetRestoresDefaultOutboundChangesetRecoveryWindow() throws {
    let defaultsKeys = [
      "ade.sync.activeProjectId",
      "ade.sync.activeProjectRootPath",
      "ade.sync.outboundSyncCursors",
      "ade.sync.pendingOutboundChangesets",
    ]
    let defaultsSnapshot = snapshotDefaults(keys: defaultsKeys)
    for key in defaultsKeys { UserDefaults.standard.removeObject(forKey: key) }
    defer { restoreDefaults(defaultsSnapshot, keys: defaultsKeys) }

    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    service.setActiveProjectForTesting(projectId: "project-one", rootPath: "/tmp/project-one")
    service.scheduleOutboundChangesetRecoveryForTesting(now: 100)
    XCTAssertEqual(service.outboundChangesetRecoveryWindowForTesting().level, 1)

    service.setActiveProjectForTesting(projectId: "project-two", rootPath: "/tmp/project-two")
    let resetWindow = service.outboundChangesetRecoveryWindowForTesting()
    XCTAssertEqual(resetWindow.level, 0)
    XCTAssertEqual(resetWindow.rowLimit, 64)
    XCTAssertEqual(resetWindow.byteLimit, 64 * 1_024)
    XCTAssertEqual(resetWindow.retryAt, 0)
  }

  func testLocalChangesetExportBoundsRowsAndKeepsFinalVersionTransactionWhole() throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    defer {
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }
    let localSiteId = database.localSiteId()
    let remoteSiteId = "ffffffffffffffffffffffffffffffff"
    var statements = ["delete from crsql_changes"]
    for version in 1...8 {
      let localRowCount = version == 3 ? 10 : 2
      for sequence in 0..<localRowCount {
        statements.append("""
          insert into crsql_changes (
            [table], pk, cid, val, col_version, db_version, site_id, cl, seq
          ) values (
            'lanes', 'local-\(version)-\(sequence)', 'name', 'value', 1,
            \(version), x'\(localSiteId)', 0, \(sequence)
          )
        """)
      }
      statements.append("""
        insert into crsql_changes (
          [table], pk, cid, val, col_version, db_version, site_id, cl, seq
        ) values (
          'lanes', 'remote-\(version)', 'name', 'remote', 1,
          \(version), x'\(remoteSiteId)', 0, 100
        )
      """)
    }
    try database.executeSqlForTesting(statements.joined(separator: ";\n"))

    let firstWindow = database.exportLocalChangesSince(version: 0, rowLimit: 5)
    XCTAssertEqual(Set(firstWindow.map(\.dbVersion)), Set([1, 2, 3]))
    XCTAssertEqual(firstWindow.count, 14)
    XCTAssertTrue(firstWindow.allSatisfy { $0.siteId == localSiteId })
    XCTAssertEqual(firstWindow.filter { $0.dbVersion == 3 }.count, 10)

    let secondWindow = database.exportLocalChangesSince(version: 3, rowLimit: 3)
    XCTAssertEqual(Set(secondWindow.map(\.dbVersion)), Set([4, 5]))
    XCTAssertEqual(secondWindow.count, 4)
    XCTAssertTrue(secondWindow.allSatisfy { $0.siteId == localSiteId })
  }

  func testRelayReadyV2ControlsAreInterceptedBeforeEnvelopeDecode() {
    XCTAssertEqual(
      syncRelayTransportControl(from: ["t": "accepted", "v": 2]),
      .accepted
    )
    XCTAssertEqual(
      syncRelayTransportControl(from: ["t": "ready", "v": 2]),
      .ready
    )
    XCTAssertNil(syncRelayTransportControl(from: ["type": "hello_ok", "version": 1]))
  }

  @MainActor
  func testLateAcceptedAfterLegacyCutoffCannotResumeAbandonedV2Socket() throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.configureConnectedTransportForTesting()
    service.beginRelayTransportNegotiationForTesting()
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    XCTAssertEqual(service.expireRelayTransportNegotiationWindowForTesting(), .retryLegacySocket)
    XCTAssertFalse(try service.handleRelayTransportControlForTesting(["t": "accepted", "v": 2]))
    XCTAssertNil(service.relayTransportNegotiationForTesting())
  }

  @MainActor
  func testRelayCandidateNegotiationTimeoutRequiresLegacyRetryInsteadOfHello() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    do {
      try await service.awaitRelayCandidateReadyForTesting(frames: [])
      XCTFail("A ready-v2 timeout must require a fresh legacy socket.")
    } catch let error as SyncRelayReadyNegotiationError {
      XCTAssertEqual(error, .retryLegacySocket)
    }
  }

  @MainActor
  func testRelayCandidateRuntimeIgnoresReadyBeforeAccepted() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    try await service.awaitRelayCandidateReadyForTesting(frames: [
      ["t": "ready", "v": 2],
      ["t": "accepted", "v": 2],
      ["t": "ready", "v": 2],
    ])
  }

  func testRelayReauthorizationScheduleRetryGraceAndForegroundDue() {
    let lease = SyncRelayAuthorizationLease(
      expiresAtMilliseconds: 20_000,
      refreshAfterMilliseconds: 10_000,
      challenge: "challenge-1",
      graceMilliseconds: 5_000
    )
    XCTAssertEqual(
      syncRelayReauthorizationScheduleDelayNanoseconds(
        lease: lease,
        nowMilliseconds: 8_500
      ),
      1_500_000_000
    )
    XCTAssertTrue(syncRelayReauthorizationIsDue(lease: lease, nowMilliseconds: 10_000))
    XCTAssertEqual(
      syncRelayReauthorizationRetryDelayNanoseconds(
        attempt: 0,
        lease: lease,
        nowMilliseconds: 23_000
      ),
      1_000_000_000
    )
    XCTAssertNil(
      syncRelayReauthorizationRetryDelayNanoseconds(
        attempt: 1,
        lease: lease,
        nowMilliseconds: 24_000
      )
    )
  }

  func testRelayReauthorizationRetriesExactAttemptAfterLostSuccessResponse() {
    XCTAssertEqual(
      syncRelayReauthorizationRetryAction(
        receivedHostResult: false,
        errorCode: nil,
        retryable: false
      ),
      .retryExactAttempt
    )
    XCTAssertEqual(
      syncRelayReauthorizationRetryAction(
        receivedHostResult: true,
        errorCode: "verification_failed",
        retryable: true
      ),
      .retryExactAttempt
    )
    for code in ["token_expired", "token_not_advanced", "token_too_short"] {
      XCTAssertEqual(
        syncRelayReauthorizationRetryAction(
          receivedHostResult: true,
          errorCode: code,
          retryable: false
        ),
        .rebuildAttempt
      )
    }
    XCTAssertEqual(
      syncRelayReauthorizationRetryAction(
        receivedHostResult: true,
        errorCode: "relay_account_changed",
        retryable: false
      ),
      .accountChanged
    )
  }

  func testMalformedRelayReauthorizationResultRetriesExactAttempt() {
    XCTAssertThrowsError(try syncRelayReauthorizationLease(from: ["unexpected": true])) { error in
      guard let failure = error as? RelayReauthorizationFailure else {
        return XCTFail("Expected a typed reauthorization protocol failure.")
      }
      XCTAssertEqual(failure.code, "invalid_response")
      XCTAssertFalse(failure.receivedHostResult)
      XCTAssertEqual(
        syncRelayReauthorizationRetryAction(
          receivedHostResult: failure.receivedHostResult,
          errorCode: failure.code,
          retryable: failure.retryable
        ),
        .retryExactAttempt
      )
    }
  }

  @MainActor
  func testShortHelloSessionsPreserveBackoffAndSustainedHealthResetsIt() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.configureConnectedTransportForTesting()
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    XCTAssertEqual(service.nextReconnectDelayForTesting(), 1_000_000_000)
    XCTAssertEqual(service.nextReconnectDelayForTesting(), 2_000_000_000)
    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "backoff-host", "deviceName": "Mac Studio"],
      "features": [:],
    ])
    XCTAssertEqual(service.reconnectAttemptCountForTesting(), 2)

    service.scheduleReconnectStabilityResetForTesting(delayNanoseconds: 50_000_000)
    service.teardownSocketForTesting()
    XCTAssertEqual(service.nextReconnectDelayForTesting(), 4_000_000_000)

    XCTAssertEqual(SyncSocketTiming.reconnectStabilityNanoseconds, 10_000_000_000)
    service.configureConnectedTransportForTesting()
    service.scheduleReconnectStabilityResetForTesting(delayNanoseconds: 1_000_000)
    await service.awaitReconnectStabilityResetForTesting()
    XCTAssertEqual(service.reconnectAttemptCountForTesting(), 0)
    XCTAssertEqual(service.nextReconnectDelayForTesting(), 1_000_000_000)
  }

  @MainActor
  func testStalePostHelloRestorationCannotRepublishConnected() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    let restoration = DeferredRecoveryWork()
    service.configureConnectedTransportForTesting()
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let postHello = Task { @MainActor in
      await service.performPostHelloRestorationForTesting {
        await restoration.wait()
      }
    }
    while !restoration.isWaiting { await Task.yield() }
    service.teardownSocketForTesting()
    restoration.resume()
    await postHello.value

    XCTAssertNotEqual(service.connectionState, .connected)
  }

  func testTerminalInputQueuePreservesOrderAckAndReconnectIds() throws {
    var queue = SyncTerminalInputQueue(maximumItemCount: 3, maximumByteCount: 20)
    let first = try queue.enqueue(data: Data("a".utf8), inputId: "input-1")
    _ = try queue.enqueue(data: Data("b".utf8), inputId: "input-2")
    XCTAssertEqual(queue.nextSendableItem(reliableAcknowledgements: true), first)

    queue.markSent(inputId: "input-1", generation: 7, sentUptime: 10)
    XCTAssertNil(queue.nextSendableItem(reliableAcknowledgements: true))
    queue.prepareForReconnect()
    let restored = try XCTUnwrap(queue.nextSendableItem(reliableAcknowledgements: true))
    XCTAssertEqual(restored.inputId, "input-1")
    XCTAssertEqual(restored.data, Data("a".utf8))
    XCTAssertEqual(restored.delivery, .unsent)
    XCTAssertNil(restored.firstSentUptime)
    XCTAssertNil(restored.lastSentUptime)
    XCTAssertEqual(restored.attemptCount, 0)
    queue.markSent(inputId: "input-1", generation: 8, sentUptime: 11)
    XCTAssertEqual(queue.item(inputId: "input-1")?.firstSentUptime, 11)
    XCTAssertEqual(queue.item(inputId: "input-1")?.lastSentUptime, 11)
    XCTAssertEqual(queue.item(inputId: "input-1")?.attemptCount, 1)
    XCTAssertEqual(queue.acknowledge(inputId: "input-1")?.data, Data("a".utf8))
    XCTAssertEqual(queue.nextSendableItem(reliableAcknowledgements: true)?.inputId, "input-2")
  }

  func testTerminalInputReconnectRestoresFreshRetryBudget() throws {
    var queue = SyncTerminalInputQueue()
    _ = try queue.enqueue(data: Data("x".utf8), inputId: "stable-id")
    for sentAt in [0.0, 1.0, 2.0, 3.0] {
      queue.markSent(inputId: "stable-id", generation: 4, sentUptime: sentAt)
    }
    XCTAssertEqual(
      syncTerminalInputRetryDecision(
        item: try XCTUnwrap(queue.item(inputId: "stable-id")),
        nowUptime: 4,
        retryWindowMilliseconds: 60_000
      ),
      .attemptsExhausted
    )

    queue.prepareForReconnect()
    queue.markSent(inputId: "stable-id", generation: 5, sentUptime: 100)
    let freshAttempt = try XCTUnwrap(queue.item(inputId: "stable-id"))
    XCTAssertEqual(freshAttempt.inputId, "stable-id")
    XCTAssertEqual(freshAttempt.attemptCount, 1)
    XCTAssertEqual(freshAttempt.firstSentUptime, 100)
    XCTAssertEqual(
      syncTerminalInputRetryDecision(
        item: freshAttempt,
        nowUptime: 101,
        retryWindowMilliseconds: 60_000
      ),
      .retry(afterNanoseconds: 500_000_000)
    )
  }

  func testTerminalInputQueueBoundsAreExplicit() throws {
    var queue = SyncTerminalInputQueue(
      maximumItemCount: 1,
      maximumByteCount: 2,
      maximumChunkByteCount: 2
    )
    _ = try queue.enqueue(data: Data("ab".utf8), inputId: "one")
    XCTAssertThrowsError(try queue.enqueue(data: Data("c".utf8), inputId: "two")) { error in
      XCTAssertEqual(error as? SyncTerminalInputQueueError, .overflow(maximumItems: 1, maximumBytes: 2))
    }
  }

  func testTerminalInputAckUnionHandlesSuccessAndTypedSubscriptionFailure() {
    XCTAssertEqual(
      syncTerminalInputAcknowledgement(from: [
        "sessionId": "s1", "inputId": "i1", "ok": true, "duplicate": true,
      ]),
      .success(sessionId: "s1", inputId: "i1", duplicate: true)
    )
    XCTAssertEqual(
      syncTerminalInputAcknowledgement(from: [
        "sessionId": "s1",
        "inputId": "i1",
        "ok": false,
        "duplicate": false,
        "error": ["code": "not_subscribed", "message": "Subscribe first.", "retryable": true],
      ]),
      .failure(
        sessionId: "s1",
        inputId: "i1",
        code: "not_subscribed",
        message: "Subscribe first.",
        retryableSubscription: true
      )
    )
  }

  func testTerminalLostAckRetriesThenSuccessWithoutBreakingFIFO() throws {
    var queue = SyncTerminalInputQueue(acknowledgementTimeout: 1)
    _ = try queue.enqueue(data: Data("exact bytes".utf8), inputId: "same-id")
    queue.markSent(inputId: "same-id", generation: 2, sentUptime: 10)
    let timedOut = try XCTUnwrap(queue.item(inputId: "same-id"))
    XCTAssertEqual(
      syncTerminalInputRetryDecision(
        item: timedOut,
        nowUptime: 11,
        retryWindowMilliseconds: 60_000
      ),
      .retry(afterNanoseconds: 500_000_000)
    )
    queue.markSent(inputId: "same-id", generation: 2, sentUptime: 11.5)
    XCTAssertEqual(queue.item(inputId: "same-id")?.data, Data("exact bytes".utf8))
    XCTAssertNotNil(queue.acknowledge(inputId: "same-id"))
    XCTAssertTrue(queue.items.isEmpty)
  }

  func testTerminalAckRetryStopsAtAttemptBoundAndWindowExpiry() throws {
    var queue = SyncTerminalInputQueue()
    _ = try queue.enqueue(data: Data("x".utf8), inputId: "i")
    for sentAt in [0.0, 1.0, 2.0, 3.0] {
      queue.markSent(inputId: "i", generation: 1, sentUptime: sentAt)
    }
    let exhausted = try XCTUnwrap(queue.item(inputId: "i"))
    XCTAssertEqual(
      syncTerminalInputRetryDecision(
        item: exhausted,
        nowUptime: 4,
        retryWindowMilliseconds: 60_000
      ),
      .attemptsExhausted
    )

    var expiring = SyncTerminalInputQueue()
    _ = try expiring.enqueue(data: Data("x".utf8), inputId: "j")
    expiring.markSent(inputId: "j", generation: 1, sentUptime: 0)
    XCTAssertEqual(
      syncTerminalInputRetryDecision(
        item: try XCTUnwrap(expiring.item(inputId: "j")),
        nowUptime: 1,
        retryWindowMilliseconds: 1_200
      ),
      .retryWindowExpired
    )
  }

  func testTerminalTimeoutUsesInjectedMonotonicUptimeAcrossWallClockBackstep() throws {
    var queue = SyncTerminalInputQueue(acknowledgementTimeout: 8)
    _ = try queue.enqueue(data: Data("x".utf8), inputId: "monotonic-input")
    queue.markSent(inputId: "monotonic-input", generation: 9, sentUptime: 100)

    let wallClockAtSend = Date(timeIntervalSince1970: 2_000_000)
    let wallClockAfterJump = Date(timeIntervalSince1970: 1_000_000)
    XCTAssertLessThan(wallClockAfterJump, wallClockAtSend)
    XCTAssertEqual(
      syncTerminalMonotonicElapsedSeconds(since: 100, nowUptime: 108),
      8
    )
    XCTAssertEqual(
      queue.timedOutInputId(nowUptime: 108, generation: 9),
      "monotonic-input"
    )
  }
}

@MainActor
private final class DeferredRecoveryWork {
  private var continuation: CheckedContinuation<Void, Never>?

  var isWaiting: Bool { continuation != nil }

  func wait() async {
    await withCheckedContinuation { continuation in
      self.continuation = continuation
    }
  }

  func resume() {
    let pending = continuation
    continuation = nil
    pending?.resume()
  }
}
