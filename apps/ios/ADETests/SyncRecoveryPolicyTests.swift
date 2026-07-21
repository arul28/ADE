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

  func testRelayReadyV2NegotiatesLegacyAndSlowNewWorkersWithoutPrematureHello() {
    XCTAssertEqual(
      syncRelayReadyV2URL("wss://relay.ade.app/connect/mac?region=iad"),
      "wss://relay.ade.app/connect/mac?region=iad&ready=2"
    )

    let legacy = SyncRelayReadyNegotiation()
    XCTAssertEqual(legacy.negotiationWindowExpired(), .sendHello)

    var slowNewWorker = SyncRelayReadyNegotiation()
    XCTAssertEqual(slowNewWorker.receive(.accepted), .interceptedWaiting)
    XCTAssertEqual(slowNewWorker.negotiationWindowExpired(), .interceptedWaiting)
    XCTAssertFalse(slowNewWorker.ready)

    XCTAssertEqual(slowNewWorker.receive(.ready), .sendHello)
    XCTAssertTrue(slowNewWorker.ready)
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
  func testLateAcceptedAndReadyAfterLegacyCutoffRemainTransportControls() throws {
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

    XCTAssertEqual(service.expireRelayTransportNegotiationWindowForTesting(), .sendHello)
    XCTAssertTrue(try service.handleRelayTransportControlForTesting(["t": "accepted", "v": 2]))
    XCTAssertTrue(try service.handleRelayTransportControlForTesting(["t": "ready", "v": 2]))
    XCTAssertEqual(service.relayTransportNegotiationForTesting()?.acceptedV2, true)
    XCTAssertEqual(service.relayTransportNegotiationForTesting()?.ready, true)
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
    XCTAssertEqual(queue.nextSendableItem(reliableAcknowledgements: true)?.inputId, "input-1")
    queue.markSent(inputId: "input-1", generation: 8, sentUptime: 11)
    XCTAssertEqual(queue.acknowledge(inputId: "input-1")?.data, Data("a".utf8))
    XCTAssertEqual(queue.nextSendableItem(reliableAcknowledgements: true)?.inputId, "input-2")
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
