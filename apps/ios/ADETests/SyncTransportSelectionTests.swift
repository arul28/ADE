import XCTest
@testable import ADE

/// Covers the decision logic behind transport selection: which endpoints are
/// raced, in what order, how far apart, and when a healthy connection is
/// allowed to be replaced.
final class SyncTransportSelectionTests: XCTestCase {
  private let relayRoute = "wss://relay.ade.app/connect/machine-key"
  private let secondRelayRoute = "wss://relay.ade.app/connect/other-key"

  private func attempt(_ address: String, port: Int = 4599) -> SyncConnectionEndpointAttempt {
    SyncConnectionEndpointAttempt(address: address, port: port)
  }

  // MARK: - One race

  func testRelayJoinsTheSameRaceBehindTheLeadingDirectCandidate() {
    let plan = syncConnectionRaceCandidatePlan(rankedAttempts: [
      attempt("192.168.1.8"),
      attempt(relayRoute),
      attempt("100.75.20.63"),
    ])

    XCTAssertEqual(plan.map(\.endpoint.address), ["192.168.1.8", relayRoute, "100.75.20.63"])
    XCTAssertEqual(plan[0].delayNanoseconds, 0)
    // Held back briefly rather than waiting out the whole direct race.
    XCTAssertEqual(plan[1].delayNanoseconds, SyncConnectionRaceTiming.relayJoinDelayNanoseconds)
    XCTAssertLessThan(
      plan[1].delayNanoseconds,
      SyncConnectionRaceTiming.overallBudgetNanoseconds
    )
  }

  func testRelayLeadingTheRankingIsDialedImmediately() {
    let plan = syncConnectionRaceCandidatePlan(rankedAttempts: [
      attempt(relayRoute),
      attempt("192.168.1.8"),
    ])

    XCTAssertEqual(plan[0].endpoint.address, relayRoute)
    XCTAssertEqual(plan[0].delayNanoseconds, 0)
  }

  // MARK: - Failure memory

  func testRankingSchedulesRecentlyFailingEndpointsLastWithoutRemovingThem() {
    let now: TimeInterval = 10_000
    let states = [
      HostConnectionEndpointState(
        endpoint: "192.168.1.8",
        lastSucceededAt: now - 30,
        lastFailedAt: now - 5,
        consecutiveFailures: 2
      ),
    ]

    let ranked = syncRankedEndpointAttempts(
      directAttempts: [attempt("192.168.1.8"), attempt("100.75.20.63")],
      relayRoutes: [relayRoute],
      relayPort: 443,
      endpointStates: states,
      now: now
    )

    XCTAssertEqual(ranked.last?.address, "192.168.1.8")
    XCTAssertEqual(ranked.count, 3, "a failing endpoint is demoted, never dropped")
  }

  func testSingleFailureOrAStaleStreakDoesNotDemote() {
    let now: TimeInterval = 10_000
    let oneFailure = HostConnectionEndpointState(
      endpoint: "192.168.1.8",
      lastFailedAt: now - 5,
      consecutiveFailures: 1
    )
    let staleStreak = HostConnectionEndpointState(
      endpoint: "192.168.1.8",
      lastFailedAt: now - (SyncEndpointFailureMemory.recentFailureWindowSeconds + 10),
      consecutiveFailures: 5
    )

    XCTAssertFalse(syncEndpointIsRecentlyFailing(oneFailure, now: now))
    XCTAssertFalse(syncEndpointIsRecentlyFailing(staleStreak, now: now))
  }

  func testFailuresAccumulateAndSuccessResetsThemWhileKeepingReadyV2() {
    let failedOnce = syncEndpointStatesMarkingFailed(
      nil,
      endpoints: [relayRoute],
      at: 100
    )
    let failedTwice = syncEndpointStatesMarkingFailed(
      failedOnce,
      endpoints: [relayRoute],
      at: 200
    )
    XCTAssertEqual(failedTwice.first?.consecutiveFailures, 2)
    XCTAssertTrue(syncEndpointIsRecentlyFailing(failedTwice.first, now: 210))

    var negotiated = failedTwice
    negotiated[0].negotiatedReadyV2 = true
    let succeeded = syncEndpointStatesMarkingSucceeded(
      negotiated,
      endpoint: relayRoute,
      at: 300,
      retaining: [relayRoute]
    )
    XCTAssertNil(succeeded.first?.consecutiveFailures)
    XCTAssertNil(succeeded.first?.lastFailedAt)
    XCTAssertEqual(
      succeeded.first?.negotiatedReadyV2,
      true,
      "ready-v2 is a property of the relay, not of one attempt"
    )
  }

  func testLosingTheRaceIsNotRecordedAsAnEndpointFailure() {
    XCTAssertFalse(syncEndpointFailureIsMeaningful(CancellationError()))
    XCTAssertFalse(syncEndpointFailureIsMeaningful(NSError(domain: "ADE", code: 37)))
    XCTAssertTrue(syncEndpointFailureIsMeaningful(NSError(domain: "ADE", code: 25)))
  }

  // MARK: - Interface awareness

  func testLocalLinkCandidatesAreScheduledLastOnACellularOnlyPath() {
    let ranked = syncRankedEndpointAttempts(
      directAttempts: [attempt("192.168.1.8"), attempt("100.75.20.63")],
      relayRoutes: [relayRoute],
      relayPort: 443,
      deprioritizeLocalLinkCandidates: true
    )

    XCTAssertEqual(ranked.last?.address, "192.168.1.8")
    // Tailscale works over cellular, so the tailnet route keeps its place.
    XCTAssertEqual(ranked.first?.address, "100.75.20.63")
  }

  func testLoopbackAndTailnetAreNotTreatedAsLocalLinkOnly() {
    XCTAssertTrue(syncIsLocalLinkOnlyCandidate("192.168.1.8"))
    XCTAssertTrue(syncIsLocalLinkOnlyCandidate("mac.local"))
    XCTAssertFalse(syncIsLocalLinkOnlyCandidate("127.0.0.1"))
    XCTAssertFalse(syncIsLocalLinkOnlyCandidate("100.75.20.63"))
    XCTAssertFalse(syncIsLocalLinkOnlyCandidate(relayRoute))
  }

  // MARK: - Network fingerprint memory

  func testFingerprintDistinguishesNetworksAndSurvivesAMissingAddress() {
    XCTAssertEqual(
      syncNetworkFingerprint(
        usesWiFi: true,
        usesCellular: false,
        usesWiredEthernet: false,
        interfaceAddresses: [
          SyncNetworkInterfaceAddress(interfaceName: "lo0", address: "127.0.0.1"),
          SyncNetworkInterfaceAddress(interfaceName: "en0", address: "192.168.1.42"),
        ]
      ),
      "wifi:192.168.1"
    )
    XCTAssertEqual(
      syncNetworkFingerprint(usesWiFi: true, usesCellular: false, usesWiredEthernet: false),
      "wifi"
    )
    XCTAssertEqual(
      syncNetworkFingerprint(usesWiFi: false, usesCellular: true, usesWiredEthernet: false),
      "cell"
    )
  }

  func testRememberedWinnerForThisNetworkIsHoistedToSlotZero() {
    let memory = syncNetworkRouteMemoryRecording(
      nil,
      fingerprint: "cell",
      endpoint: relayRoute,
      at: 100
    )
    let ranked = [attempt("192.168.1.8"), attempt("100.75.20.63"), attempt(relayRoute, port: 443)]

    let hoisted = syncEndpointAttemptsHoisting(
      ranked,
      preferredAddresses: [syncRememberedEndpoint(in: memory, fingerprint: "cell")].compactMap { $0 }
    )

    XCTAssertEqual(hoisted.first?.address, relayRoute)
    XCTAssertEqual(hoisted.count, ranked.count)
  }

  func testHoistingOnlyReordersTheVettedSet() {
    let vetted = [attempt("192.168.1.8")]

    // A relay URL that address/authorization policy already excluded must not
    // re-enter the race by being the remembered or last-good address.
    let hoisted = syncEndpointAttemptsHoisting(vetted, preferredAddresses: [relayRoute])

    XCTAssertEqual(hoisted.map(\.address), ["192.168.1.8"])
  }

  func testRouteMemoryIsMostRecentlyUsedAndCapped() {
    var memory: [HostConnectionNetworkRouteMemory] = []
    for index in 0..<(syncNetworkRouteMemoryCapacity + 3) {
      memory = syncNetworkRouteMemoryRecording(
        memory,
        fingerprint: "wifi:10.0.\(index)",
        endpoint: "10.0.\(index).5",
        at: TimeInterval(index)
      )
    }

    XCTAssertEqual(memory.count, syncNetworkRouteMemoryCapacity)
    XCTAssertEqual(memory.first?.fingerprint, "wifi:10.0.\(syncNetworkRouteMemoryCapacity + 2)")

    let updated = syncNetworkRouteMemoryRecording(
      memory,
      fingerprint: memory[2].fingerprint,
      endpoint: "10.0.99.1",
      at: 500
    )
    XCTAssertEqual(updated.first?.endpoint, "10.0.99.1")
    XCTAssertEqual(
      updated.filter { $0.fingerprint == memory[2].fingerprint }.count,
      1,
      "re-recording a network replaces its entry instead of duplicating it"
    )
  }

  // MARK: - Relay dial single-flight

  func testSingleFlightGuardBlocksASecondDialForTheSameMachine() {
    var registry = SyncRelayDialRegistry()
    let key = syncRelayMachineKey(from: relayRoute + "?ready=2")

    XCTAssertEqual(key, "relay.ade.app/machine-key")
    XCTAssertTrue(registry.acquire(key!))
    XCTAssertFalse(registry.acquire(key!), "a second dial for the same machine is refused")
    XCTAssertTrue(
      registry.acquire(syncRelayMachineKey(from: secondRelayRoute)!),
      "a different machine on the same relay is unaffected"
    )

    registry.release(key!)
    XCTAssertTrue(registry.acquire(key!), "the key is reusable once the dial finishes")
  }

  func testTheReadyV2AndLegacyURLsForOneEndpointShareADialKey() {
    XCTAssertEqual(
      syncRelayMachineKey(from: syncRelayReadyV2URL(relayRoute)),
      syncRelayMachineKey(from: syncRelayLegacyURL(relayRoute))
    )
  }

  // MARK: - Ready negotiation deadlines

  func testAcceptedExtendsTheReadyDeadline() {
    var negotiation = SyncRelayReadyNegotiation()
    XCTAssertEqual(
      negotiation.phaseDeadlineNanoseconds,
      SyncConnectionRaceTiming.relayAcceptedNegotiationNanoseconds
    )

    XCTAssertEqual(negotiation.receive(.accepted), .interceptedWaiting)
    XCTAssertEqual(
      negotiation.phaseDeadlineNanoseconds,
      SyncConnectionRaceTiming.relayReadyAfterAcceptedNanoseconds
    )
    XCTAssertGreaterThan(
      SyncConnectionRaceTiming.relayReadyAfterAcceptedNanoseconds,
      SyncConnectionRaceTiming.relayAcceptedNegotiationNanoseconds
    )

    XCTAssertEqual(negotiation.receive(.ready), .sendHello)
    XCTAssertTrue(negotiation.ready)
  }

  func testReadyBeforeAcceptedIsNotAuthoritative() {
    var negotiation = SyncRelayReadyNegotiation()
    XCTAssertEqual(negotiation.receive(.ready), .ignore)
    XCTAssertFalse(negotiation.ready)
    XCTAssertEqual(negotiation.negotiationWindowExpired(), .retryLegacySocket)
  }

  func testLegacyRedialOnlyHappensForAnEndpointThatNeverSpokeReadyV2() {
    XCTAssertTrue(syncRelayLegacyRedialAllowed(
      acceptedV2Observed: false,
      endpointNegotiatedReadyV2Before: false
    ))
    XCTAssertFalse(
      syncRelayLegacyRedialAllowed(
        acceptedV2Observed: false,
        endpointNegotiatedReadyV2Before: true
      ),
      "a known v2 relay going silent is a fault, not a protocol mismatch"
    )
    XCTAssertFalse(syncRelayLegacyRedialAllowed(
      acceptedV2Observed: true,
      endpointNegotiatedReadyV2Before: false
    ))
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

  func testRoamCooldownSuppressesBurstsOfPathUpdates() {
    XCTAssertNil(syncRoamTrigger(roamInputs(
      interfacesChanged: true,
      current: .relay,
      best: .lan,
      sinceLastRoam: 5
    )))
  }

  func testRoamingRequiresALiveConnection() {
    var inputs = roamInputs(interfacesChanged: true)
    inputs.hasLiveConnection = false
    XCTAssertNil(syncRoamTrigger(inputs), "reconnect owns the disconnected case")
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

  func testRecoveryActionRoutesARoamTriggerToTheReplacementRace() {
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
  }
}
