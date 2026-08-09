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

  // MARK: - Roaming

  private func roamInputs(
    interfacesChanged: Bool = false,
    current: SyncConnectionRouteKind? = .relay,
    best: SyncConnectionRouteKind? = .relay,
    ageSeconds: TimeInterval = 600,
    sinceLastRoam: TimeInterval? = nil
  ) -> SyncRoamInputs {
    SyncRoamInputs(
      hasLiveConnection: true,
      isPathSatisfied: true,
      interfacesChanged: interfacesChanged,
      currentRouteKind: current,
      bestAvailableRouteKind: best,
      connectionAgeSeconds: ageSeconds,
      secondsSinceLastRoamAttempt: sinceLastRoam
    )
  }

  func testIdleCellularRelaySessionIsNeverRoamed() {
    // The reported churn: connected over relay on cellular with a saved tailnet
    // route, nothing about the network changing, a full race every path update.
    XCTAssertNil(syncRoamTrigger(roamInputs(current: .relay, best: .relay)))
  }

  func testGenuinePathChangeStillFailsOverImmediately() {
    XCTAssertEqual(
      syncRoamTrigger(roamInputs(interfacesChanged: true, current: .tailnet, best: .relay, ageSeconds: 1)),
      .pathChange,
      "a young connection on a vanished route must still fail over"
    )
  }

  func testUpgradeProbeNeedsABetterClassAndItsOwnInterval() {
    XCTAssertEqual(
      syncRoamTrigger(roamInputs(current: .relay, best: .lan, sinceLastRoam: 400)),
      .upgradeProbe
    )
    XCTAssertNil(
      syncRoamTrigger(roamInputs(current: .relay, best: .lan, sinceLastRoam: 120)),
      "probes wait out the 5-minute interval"
    )
    XCTAssertNil(
      syncRoamTrigger(roamInputs(current: .lan, best: .relay, sinceLastRoam: 400)),
      "relay is not an upgrade over LAN"
    )
    XCTAssertNil(
      syncRoamTrigger(roamInputs(current: .relay, best: .lan, ageSeconds: 3, sinceLastRoam: 400)),
      "a connection younger than the age floor is left alone"
    )
  }

  func testRoamCooldownSuppressesBurstsOfPathUpdatesButNotFailover() {
    // A burst of updates around one physical change collapses to one race.
    XCTAssertNil(syncRoamTrigger(roamInputs(
      interfacesChanged: true,
      current: .relay,
      best: .lan,
      sinceLastRoam: 1
    )))
    // Failover must not have to wait out the upgrade-probe cooldown: the route
    // it is failing away from may already be gone.
    XCTAssertEqual(
      syncRoamTrigger(roamInputs(
        interfacesChanged: true,
        current: .relay,
        best: .lan,
        sinceLastRoam: SyncRoamTiming.pathChangeCooldownSeconds + 1
      )),
      .pathChange
    )
  }

  func testRoamingRequiresALiveConnection() {
    var inputs = roamInputs(interfacesChanged: true)
    inputs.hasLiveConnection = false
    XCTAssertNil(syncRoamTrigger(inputs), "reconnect owns the disconnected case")
  }

  func testALocalLinkOnlyIPv6CandidateIsAlsoDemotedOnCellular() {
    XCTAssertTrue(syncIsLocalLinkOnlyCandidate("fe80::1"))
    XCTAssertTrue(syncIsLocalLinkOnlyCandidate("fd12:3456:789a::1"))
    XCTAssertFalse(syncIsLocalLinkOnlyCandidate("::1"))
  }

  func testInterfaceChangeIgnoresExpensiveAndConstrainedFlapping() {
    let base = SyncNetworkPathSnapshot(
      isSatisfied: true,
      usesWiFi: false,
      usesCellular: true,
      usesWiredEthernet: false,
      isExpensive: true,
      isConstrained: false
    )
    let constrainedFlap = SyncNetworkPathSnapshot(
      isSatisfied: true,
      usesWiFi: false,
      usesCellular: true,
      usesWiredEthernet: false,
      isExpensive: true,
      isConstrained: true
    )
    let wifiReturned = SyncNetworkPathSnapshot(
      isSatisfied: true,
      usesWiFi: true,
      usesCellular: false,
      usesWiredEthernet: false,
      isExpensive: false,
      isConstrained: false
    )

    XCTAssertFalse(syncNetworkPathInterfacesChanged(previous: base, next: constrainedFlap))
    XCTAssertTrue(syncNetworkPathInterfacesChanged(previous: base, next: wifiReturned))
    XCTAssertTrue(syncNetworkPathInterfacesChanged(previous: nil, next: base))
  }

  func testPathHandoffSkipsStaleResetOfNewHealthySocket() {
    XCTAssertEqual(
      syncNetworkPathRecoveryAction(
        roamTrigger: .pathChange,
        isPathSatisfied: true,
        hasLiveConnection: true
      ),
      .attemptAuthenticatedReplacement
    )
    XCTAssertEqual(
      syncNetworkPathRecoveryAction(
        roamTrigger: nil,
        isPathSatisfied: true,
        hasLiveConnection: true
      ),
      .cancelScheduledReconnect
    )
    XCTAssertEqual(
      syncNetworkPathRecoveryAction(
        roamTrigger: nil,
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
    let interrupted = "Can’t reach this computer right now. Reconnecting now."
    let cases: [(code: Int, reason: String, expected: String)] = [
      (4000, "partner closed", interrupted),
      (4001, "heartbeat timed out", interrupted),
      (4002, "sync host handoff buffer exceeded", interrupted),
      (4003, "ADE Relay account proof expired", "This saved connection needs attention. Open Settings and reconnect."),
      (4004, "pairing cooldown", "Connection attempts are paused briefly. Try again shortly."),
      (4008, "inbound connection stale", interrupted),
      (4501, "host offline", interrupted),
      (4502, "relay idle", interrupted),
      (4503, "relay capacity", "This computer is handling too many connections. Try again shortly."),
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

  /// A short hop out and back (glancing at the notification shade) should keep
  /// the live session: replacing it there would cost a reconnect on every
  /// trivial app switch.
  @MainActor
  func testResumeAfterShortBackgroundKeepsTheLiveSession() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.configureConnectedTransportForTesting()
    service.completeCapturedRefreshRequestsForTesting()
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    let generation = service.connectionGenerationForTesting()
    service.setBackgroundedAtForTesting(secondsAgo: 1)
    await service.handleForegroundTransition()

    XCTAssertEqual(service.connectionGenerationForTesting(), generation)
    XCTAssertEqual(service.connectionState, .connected)
  }

  /// The ladder used to run to a terminal `unreachable` state escapable only by
  /// a manual tap, leaving a 30-40s heartbeat as the only retry. Coming to the
  /// foreground is new information — often a different network entirely — so it
  /// reopens the budget.
  @MainActor
  func testForegroundResetsAnExhaustedReconnectLadder() async throws {
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.configureConnectedTransportForTesting()
    service.completeCapturedRefreshRequestsForTesting()
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    service.exhaustReconnectAttemptsForTesting()
    XCTAssertTrue(service.reconnectAttemptsAreExhaustedForTesting())

    await service.handleForegroundTransition()

    XCTAssertFalse(service.reconnectAttemptsAreExhaustedForTesting())
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
    // Snapshot acceptance and retry ownership cleanup are one atomic state
    // transition; this assertion must not need a yield for the retry task's
    // defer to catch up.
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

    // Returning without throwing is not enough: a runtime that wrongly honored
    // the leading `ready` would also return here. Asserting that `accepted` was
    // seen is what distinguishes the two.
    let negotiation = try await service.awaitRelayCandidateReadyForTesting(frames: [
      ["t": "ready", "v": 2],
      ["t": "accepted", "v": 2],
      ["t": "ready", "v": 2],
    ])
    XCTAssertTrue(negotiation.acceptedV2)
    XCTAssertTrue(negotiation.ready)
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

  /// `hello_ok` is the attachment barrier: `.connected` must be published as
  /// soon as the payload is applied, and must still hold once post-hello work
  /// is scheduled — not only after its network round trip. Holding it back
  /// parked the app in a non-attached state for seconds, which the PIN sheet
  /// reported as "Incorrect PIN." on a pair that had actually succeeded.
  @MainActor
  func testSuccessfulPostHelloRestorationPublishesConnectedBeforeRestorationCompletes() async throws {
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

    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "ready-host", "deviceName": "Mac Studio"],
      "features": [:],
    ])
    // Applying the payload is itself the attachment moment.
    XCTAssertEqual(service.connectionState, .connected)
    XCTAssertTrue(service.isAttached)

    let postHello = Task { @MainActor in
      await service.performPostHelloRestorationForTesting {
        await restoration.wait()
      }
    }
    await restoration.waitUntilWaiting()
    XCTAssertEqual(service.connectionState, .connected)
    XCTAssertTrue(service.isAttached)

    restoration.resume()
    let completed = await postHello.value
    XCTAssertTrue(completed)
    XCTAssertEqual(service.connectionState, .connected)
  }

  /// The staleness guard still matters for the generation-scoped completion:
  /// a socket torn down mid-restoration must not run the post-hello completion
  /// (in production, the reconnect-backoff stability reset) for a dead socket.
  @MainActor
  func testStalePostHelloRestorationCannotRunCompletion() async throws {
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
    await restoration.waitUntilWaiting()
    service.teardownSocketForTesting()
    restoration.resume()
    let completed = await postHello.value

    XCTAssertFalse(completed)
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

  // MARK: - Session lifecycle host compatibility (ADE-125)
  //
  // The six `session.*` actions are OPTIONAL in the mobile compatibility
  // contract, so a new phone must keep working against a brain that predates
  // them. These tests pin the two directions that can regress: a legacy host
  // that omits `features.mobileCompatibility` entirely must still complete the
  // handshake, and an unadvertised lifecycle action must be refused locally
  // BEFORE it can be optimistically written or queued for send.

  private func lifecycleActionDescriptors() -> [[String: Any]] {
    [
      "session.settleSessions",
      "session.unsettleSessions",
      "session.setSettleOverride",
      "session.snoozeSession",
      "session.wakeSession",
      "session.clearWokeMarker",
    ].map { action in
      ["action": action, "policy": ["viewerAllowed": true]] as [String: Any]
    }
  }

  @MainActor
  func testLegacyHostWithoutMobileCompatibilityStillConnectsInLimitedMode() throws {
    let defaultsSnapshot = snapshotDefaults(keys: connectionDefaultsKeys)
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.configureConnectedTransportForTesting()
    defer {
      service.disconnect(clearCredentials: false)
      restoreDefaults(defaultsSnapshot, keys: connectionDefaultsKeys)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    // An older brain: it routes commands, but has never heard of the mobile
    // compatibility block or of any `session.*` lifecycle action.
    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "legacy-host", "deviceName": "Mac Studio"],
      "features": [
        "commandRouting": [
          "actions": [
            ["action": "work.listSessions", "policy": ["viewerAllowed": true]],
          ],
        ],
      ],
    ])

    // The handshake must SUCCEED (applyHelloPayload did not throw) and simply
    // degrade — a missing compatibility block is not an authentication failure.
    XCTAssertEqual(
      service.hostCompatibilityMode,
      .limited,
      "A host that omits mobileCompatibility must degrade to limited, not fail the handshake."
    )
    XCTAssertEqual(
      service.hostCompatibilityMissingActions,
      ["mobileCompatibility"],
      "The phone should attribute the degrade to the absent block, not invent missing actions."
    )
    XCTAssertTrue(
      service.supportsRemoteAction("work.listSessions"),
      "Command routing from a legacy host must still be honored."
    )
    XCTAssertFalse(
      service.supportsSessionLifecycleActions,
      "A legacy host advertises no session.* actions, so settle/unsettle must stay hidden."
    )
    XCTAssertFalse(
      service.supportsSessionSnoozeActions,
      "Snooze must stay hidden on a host that never advertised session.snoozeSession."
    )
    XCTAssertFalse(
      service.supportsWorkSessionDeletion,
      "work.deleteSession is not in the REQUIRED contract, so a legacy host that never advertises it must leave the delete affordance hidden rather than offering a control that fails."
    )
  }

  @MainActor
  func testNewHostAdvertisingLifecycleActionsUnlocksTheAffordances() throws {
    let defaultsSnapshot = snapshotDefaults(keys: connectionDefaultsKeys)
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.configureConnectedTransportForTesting()
    defer {
      service.disconnect(clearCredentials: false)
      restoreDefaults(defaultsSnapshot, keys: connectionDefaultsKeys)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "new-host", "deviceName": "Mac Studio"],
      "features": [
        "mobileCompatibility": ["mode": "full", "missingActions": [String]()],
        "commandRouting": ["actions": lifecycleActionDescriptors()],
      ],
    ])

    XCTAssertEqual(service.hostCompatibilityMode, .full)
    XCTAssertTrue(service.supportsSessionLifecycleActions)
    XCTAssertTrue(service.supportsSessionSnoozeActions)
  }

  @MainActor
  func testUnsupportedLifecycleActionIsRefusedBeforeAnyLocalWriteOrSend() async throws {
    let defaultsSnapshot = snapshotDefaults(keys: connectionDefaultsKeys)
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
      restoreDefaults(defaultsSnapshot, keys: connectionDefaultsKeys)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    // A host that advertises settle but NOT snooze — the partial-rollout case.
    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "partial-host", "deviceName": "Mac Studio"],
      "features": [
        "mobileCompatibility": ["mode": "full", "missingActions": [String]()],
        "commandRouting": [
          "actions": [
            ["action": "session.settleSessions", "policy": ["viewerAllowed": true]],
          ],
        ],
      ],
    ])
    XCTAssertFalse(service.supportsSessionSnoozeActions)

    service.resetOutboundEnvelopeCaptureForTesting()
    // `terminal_sessions` is a CRR table: any optimistic write here would be
    // captured by the update trigger and pushed upstream. Pinning the local
    // db_version proves the guard runs BEFORE the write, not after it.
    let dbVersionBefore = database.currentDbVersion()

    do {
      try await service.snoozeSession(
        sessionId: "session-1",
        until: Date().addingTimeInterval(3_600)
      )
      XCTFail("Snoozing against a host that never advertised the action must throw.")
    } catch {
      XCTAssertTrue(
        error.localizedDescription.contains("session.snoozeSession"),
        "The refusal should name the unsupported action so the user can act on it."
      )
    }

    XCTAssertEqual(
      database.currentDbVersion(),
      dbVersionBefore,
      "An unsupported lifecycle action must not leave an optimistic local write behind."
    )
    XCTAssertEqual(
      service.capturedOutboundEnvelopeCountForTesting(type: "command"),
      0,
      "An unsupported lifecycle action must never reach the wire or the durable queue."
    )
  }

  // MARK: - work.deleteSession host compatibility
  //
  // `work.deleteSession` is NOT in MOBILE_SYNC_REQUIRED_REMOTE_COMMAND_ACTIONS
  // (apps/desktop/src/shared/syncMobileCompatibility.ts) — adding it there would
  // flip every shipped phone into limited mode against an older brain. So the
  // phone must feature-detect it from the advertised descriptors, and every
  // branch that cannot prove support has to refuse locally, before the wire.

  @MainActor
  func testWorkSessionDeletionIsGatedOnTheAdvertisedDescriptor() async throws {
    let defaultsSnapshot = snapshotDefaults(keys: connectionDefaultsKeys)
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
      restoreDefaults(defaultsSnapshot, keys: connectionDefaultsKeys)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }

    // A host that satisfies the whole REQUIRED contract — `mode: "full"` — and
    // still has never heard of `work.deleteSession`. This is the shape that
    // matters: full compatibility is NOT permission to assume an optional
    // action exists.
    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "no-delete-host", "deviceName": "Mac Studio"],
      "features": [
        "mobileCompatibility": ["mode": "full", "missingActions": [String]()],
        "commandRouting": [
          "actions": [
            ["action": "work.listSessions", "policy": ["viewerAllowed": true]],
          ],
        ],
      ],
    ])
    XCTAssertEqual(service.hostCompatibilityMode, .full)
    XCTAssertFalse(
      service.supportsWorkSessionDeletion,
      "No descriptor means no capability: the gate must default to false, not to the host's overall mode."
    )

    service.resetOutboundEnvelopeCaptureForTesting()
    do {
      try await service.deleteWorkSession(sessionId: "session-1")
      XCTFail("Deleting against a host that never advertised work.deleteSession must throw.")
    } catch {
      XCTAssertTrue(
        error.localizedDescription.contains("too old"),
        "The refusal should tell the user their desktop is out of date rather than surface a method-not-found."
      )
    }
    XCTAssertEqual(
      service.capturedOutboundEnvelopeCountForTesting(type: "command"),
      0,
      "An unadvertised delete must never reach the wire or the durable queue."
    )

    // A viewer-denied descriptor is the second unsupported shape: the action
    // exists on the host, but this device may not invoke it. `supports` is not
    // the gate — `canInvokeRemoteAction` is — so the affordance must stay hidden.
    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "viewer-host", "deviceName": "Mac Studio"],
      "features": [
        "mobileCompatibility": ["mode": "full", "missingActions": [String]()],
        "commandRouting": [
          "actions": [
            ["action": "work.deleteSession", "policy": ["viewerAllowed": false, "queueable": true]],
          ],
        ],
      ],
    ])
    XCTAssertTrue(service.supportsRemoteAction("work.deleteSession"))
    XCTAssertFalse(
      service.supportsWorkSessionDeletion,
      "A viewer device must not be offered a delete the host will refuse."
    )

    service.resetOutboundEnvelopeCaptureForTesting()
    do {
      try await service.deleteWorkSession(sessionId: "session-1")
      XCTFail("A viewer-denied delete must throw rather than reach the host.")
    } catch {
      // The message is the same "update your desktop" copy: from the phone's
      // side both are "this machine will not let me do it", and the delete
      // affordance is hidden in both cases anyway.
    }
    XCTAssertEqual(
      service.capturedOutboundEnvelopeCountForTesting(type: "command"),
      0,
      "A viewer-denied delete must not reach the wire either."
    )

    // The real host shape: viewer-allowed and queueable, exactly as
    // syncRemoteCommandService registers it.
    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "new-host", "deviceName": "Mac Studio"],
      "features": [
        "mobileCompatibility": ["mode": "full", "missingActions": [String]()],
        "commandRouting": [
          "actions": [
            ["action": "work.deleteSession", "policy": ["viewerAllowed": true, "queueable": true]],
          ],
        ],
      ],
    ])
    XCTAssertTrue(
      service.supportsWorkSessionDeletion,
      "A host advertising the action viewer-allowed and queueable must unlock the delete affordance."
    )
  }

  // MARK: - Lifecycle round-trip fixtures

  private func lifecycleIso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  /// One project + lane + session row, seeded with the snooze columns a MACHINE
  /// would have written. Raw SQL because the hydration writers replace whole
  /// scopes; the point here is a single row whose lifecycle columns are known.
  private func seedLifecycleSession(
    database: DatabaseService,
    sessionId: String,
    snoozedUntil: String?,
    snoozedAt: String?
  ) throws {
    func sqlText(_ value: String?) -> String {
      guard let value else { return "null" }
      return "'" + value.replacingOccurrences(of: "'", with: "''") + "'"
    }
    try database.executeSqlForTesting("""
      insert into projects (id, root_path, display_name, default_base_ref, created_at, last_opened_at)
        values ('project-a', '/tmp/a', 'A', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z');
      insert into lanes (id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, status, created_at)
        values ('lane-a', 'project-a', 'A', 'worktree', 'main', 'ade/a', '/tmp/a/lane-a', 'ready', '2026-07-22T00:00:00.000Z');
      insert into terminal_sessions (
        id, lane_id, title, started_at, transcript_path, status, snoozed_until, snoozed_at, woke_at, woke_reason
      ) values (
        '\(sessionId)', 'lane-a', 'Session', '2026-07-22T00:00:00.000Z', '/tmp/a/t.log', 'running',
        \(sqlText(snoozedUntil)), \(sqlText(snoozedAt)), null, null
      );
    """)
  }

  /// Run `task` and answer its lifecycle command with `response` — the RAW
  /// transport frame, so a test can tell a transport failure apart from a
  /// transport success carrying an action-level refusal.
  ///
  /// A connected service also raises its own reads, and the capture exposes
  /// only request ids, so the reply is offered to every request the phone
  /// raises from here on rather than guessing which one is the lifecycle call.
  @MainActor
  private func answerLifecycleCommand<T>(
    service: SyncService,
    task: Task<T, Error>,
    response: Any
  ) async throws -> T {
    var answered = Set(service.capturedOutboundRequestIdsForTesting(type: "command"))
    let ignored = answered.count
    for _ in 0..<200 {
      await Task.yield()
      for id in service.capturedOutboundRequestIdsForTesting(type: "command") where !answered.contains(id) {
        answered.insert(id)
        service.completeCapturedRequestForTesting(requestId: id, result: response)
      }
    }
    XCTAssertGreaterThan(
      answered.count,
      ignored,
      "The lifecycle command never reached the wire."
    )
    return try await task.value
  }

  // MARK: - The early-wake baseline belongs to the HOST clock
  //
  // `isWakingSessionError` wakes a snoozed row only on an error STRICTLY NEWER
  // than `snoozed_at`, and every error timestamp it compares against is written
  // by the MACHINE. A baseline stamped from the phone's clock is comparable to
  // those only by luck: a phone running ahead of its paired Mac plants a
  // baseline in the host's future, no later error ever clears it, and the row
  // silently never raises its hand again. `terminal_sessions` is a CRR table,
  // so the bad value would also replicate upstream over the host's own.

  @MainActor
  func testSnoozeLeavesTheEarlyWakeBaselineToTheHostClock() async throws {
    let defaultsSnapshot = snapshotDefaults(keys: connectionDefaultsKeys)
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.configureConnectedTransportForTesting()
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
      restoreDefaults(defaultsSnapshot, keys: connectionDefaultsKeys)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }
    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "new-host", "deviceName": "Mac Studio"],
      "features": [
        "mobileCompatibility": ["mode": "full", "missingActions": [String]()],
        "commandRouting": ["actions": lifecycleActionDescriptors()],
      ],
    ])
    service.setActiveProjectForTesting(projectId: "project-a", rootPath: "/tmp/a")

    // This iPhone's clock runs two minutes AHEAD of the computer it is paired to.
    let phoneNow = Date(timeIntervalSince1970: 1_780_000_000)
    let hostNow = phoneNow.addingTimeInterval(-120)
    // The machine's own baseline from an earlier snooze of the same row.
    let hostBaseline = lifecycleIso(hostNow.addingTimeInterval(-600))
    try seedLifecycleSession(
      database: database,
      sessionId: "session-1",
      snoozedUntil: lifecycleIso(hostNow.addingTimeInterval(600)),
      snoozedAt: hostBaseline
    )

    // Capture only from here so a post-hello hydration read cannot be mistaken
    // for the lifecycle command.
    service.beginOutboundEnvelopeCaptureForTesting()
    let deadline = phoneNow.addingTimeInterval(3_600)
    try await answerLifecycleCommand(
      service: service,
      task: Task { try await service.snoozeSession(sessionId: "session-1", until: deadline) },
      response: [
        "ok": true,
        "result": ["ok": true, "sessionId": "session-1", "snoozedUntil": lifecycleIso(deadline)],
      ]
    )

    let row = try XCTUnwrap(database.fetchSession(id: "session-1"))
    XCTAssertEqual(
      row.snoozedAt,
      hostBaseline,
      "The phone must not stamp its own clock into snoozed_at — the baseline is host-authoritative."
    )
    let state = SessionSnoozeState(snoozedUntil: row.snoozedUntil, snoozedAt: row.snoozedAt)
    XCTAssertEqual(
      row.snoozedUntil,
      lifecycleIso(deadline),
      "The deadline IS the phone's to paint optimistically — it is what the UI reads."
    )
    XCTAssertTrue(
      isSessionSnoozed(state, now: phoneNow),
      "Filing the row as snoozed needs snoozed_until alone, so nothing depends on the baseline."
    )
    XCTAssertTrue(
      isWakingSessionError(state, errorAt: lifecycleIso(hostNow)),
      "An error the MACHINE stamps must still wake the row when the phone runs ahead of it."
    )
  }

  // MARK: - A transport success is not a mutation success

  @MainActor
  func testLifecycleResultReportingNoOpRollsBackTheOptimisticWrite() async throws {
    let defaultsSnapshot = snapshotDefaults(keys: connectionDefaultsKeys)
    let baseURL = FileManager.default.temporaryDirectory
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.configureConnectedTransportForTesting()
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
      restoreDefaults(defaultsSnapshot, keys: connectionDefaultsKeys)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }
    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "new-host", "deviceName": "Mac Studio"],
      "features": [
        "mobileCompatibility": ["mode": "full", "missingActions": [String]()],
        "commandRouting": ["actions": lifecycleActionDescriptors()],
      ],
    ])
    service.setActiveProjectForTesting(projectId: "project-a", rootPath: "/tmp/a")

    let hostUntil = "2026-07-27T12:00:00.000Z"
    let hostBaseline = "2026-07-27T11:00:00.000Z"
    try seedLifecycleSession(
      database: database,
      sessionId: "session-1",
      snoozedUntil: hostUntil,
      snoozedAt: hostBaseline
    )

    // Capture only from here so a post-hello hydration read cannot be mistaken
    // for the lifecycle command.
    service.beginOutboundEnvelopeCaptureForTesting()
    do {
      // A successful TRANSPORT frame whose ACTION payload says it changed
      // nothing — `session.wakeSession` answers this for a row the machine did
      // not have snoozed.
      try await answerLifecycleCommand(
        service: service,
        task: Task { try await service.wakeSession(sessionId: "session-1", reason: .manual) },
        response: [
          "ok": true,
          "result": ["ok": false, "sessionId": "session-1", "reason": "manual"],
        ]
      )
      XCTFail("A lifecycle result reporting a no-op must surface as a failure, not a silent success.")
    } catch {
      XCTAssertFalse(
        error.localizedDescription.isEmpty,
        "The refusal needs user-facing copy — the row visibly snapping back must be explained."
      )
    }

    let row = try XCTUnwrap(database.fetchSession(id: "session-1"))
    XCTAssertEqual(row.snoozedUntil, hostUntil, "A no-op wake must not clear the machine's deadline.")
    XCTAssertEqual(row.snoozedAt, hostBaseline, "A no-op wake must not clear the early-wake baseline.")
    XCTAssertNil(row.wokeAt, "A no-op wake must not leave a woke marker the machine never wrote.")
    XCTAssertNil(row.wokeReason, "A no-op wake must not leave a wake reason the machine never wrote.")
  }

  // MARK: - Result-shape normalization (desktop `sessionLifecycleApplied` parity)

  func testSessionLifecycleCommandAppliedMirrorsTheDesktopShapes() {
    // `{ ok }` envelopes collapse to `ok`.
    XCTAssertTrue(sessionLifecycleCommandApplied(
      ["ok": true, "sessionId": "session-1"], shape: .envelope, sessionId: "session-1"
    ))
    XCTAssertFalse(sessionLifecycleCommandApplied(
      ["ok": false, "sessionId": "session-1"], shape: .envelope, sessionId: "session-1"
    ))
    // A bare boolean passes through; anything unrecognized is not applied.
    XCTAssertTrue(sessionLifecycleCommandApplied(true, shape: .envelope, sessionId: "session-1"))
    XCTAssertFalse(sessionLifecycleCommandApplied(false, shape: .envelope, sessionId: "session-1"))
    XCTAssertFalse(sessionLifecycleCommandApplied(NSNull(), shape: .envelope, sessionId: "session-1"))
    // Bulk actions answer with the ids they CHANGED.
    XCTAssertTrue(sessionLifecycleCommandApplied(
      ["session-1", "session-2"], shape: .changedIdList, sessionId: "session-1"
    ))
    XCTAssertFalse(sessionLifecycleCommandApplied(
      [String](), shape: .changedIdList, sessionId: "session-1"
    ))
    XCTAssertFalse(sessionLifecycleCommandApplied(
      ["session-2"], shape: .changedIdList, sessionId: "session-1"
    ))
    // The offline sentinel is not a verdict from the machine at all: the
    // command is durably queued, so the optimistic write must stand.
    XCTAssertTrue(sessionLifecycleCommandApplied(
      ["queued": true], shape: .envelope, sessionId: "session-1"
    ))
    XCTAssertTrue(sessionLifecycleCommandApplied(
      ["queued": true], shape: .changedIdList, sessionId: "session-1"
    ))
  }
}

@MainActor
private final class DeferredRecoveryWork {
  private var continuation: CheckedContinuation<Void, Never>?

  var isWaiting: Bool { continuation != nil }

  /// Bounded readiness wait. If the continuation is never installed (the work
  /// body did not run), spinning on `isWaiting` would hang the whole test
  /// runner; fail loudly instead.
  func waitUntilWaiting(
    timeout: TimeInterval = 5,
    file: StaticString = #filePath,
    line: UInt = #line
  ) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !isWaiting {
      if Date() >= deadline {
        XCTFail(
          "Deferred recovery work never installed its continuation within \(timeout)s.",
          file: file,
          line: line
        )
        return
      }
      await Task.yield()
    }
  }

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
