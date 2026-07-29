import Foundation

enum SyncConnectionRaceTiming {
  static let candidateStaggerNanoseconds: UInt64 = 250_000_000
  static let overallBudgetNanoseconds: UInt64 = 10_000_000_000
  static let maximumCandidateCount = 3
  /// Deadline for the relay's `{t:"accepted",v:2}` frame. The Worker sends it
  /// the moment `/connect` is served, before any host signaling, so this window
  /// only has to cover the WebSocket upgrade itself.
  static let relayAcceptedNegotiationNanoseconds: UInt64 = 350_000_000
  /// Deadline for `ready` once `accepted` has arrived. `accepted` already
  /// proves the relay is live and the host is registered, so the remaining wait
  /// covers a cold Durable Object waking, dialing the host pipe and the local
  /// port — 350ms was never realistic for that and forced a second dial.
  static let relayReadyAfterAcceptedNanoseconds: UInt64 = 3_500_000_000
  /// How long a relay candidate holds back once a direct candidate is already
  /// dialing. Direct routes win outright on a LAN, so this is the whole cost of
  /// keeping relay in the same race; on cellular no direct candidate is
  /// plausible and relay is dialed essentially immediately.
  static let relayJoinDelayNanoseconds: UInt64 = 300_000_000
}

/// A route counts as failing when it has failed at least twice in a row and the
/// most recent failure is recent enough to still describe the network we are on.
enum SyncEndpointFailureMemory {
  static let consecutiveFailureThreshold = 2
  static let recentFailureWindowSeconds: TimeInterval = 120
}

/// Most-recently-used cap for the per-network route memory.
let syncNetworkRouteMemoryCapacity = 8

func syncObservedConnectionRouteKind(
  connectedHost: String,
  hostTransport: String?
) -> SyncConnectionRouteKind {
  if hostTransport?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "relay" {
    return .relay
  }
  return syncConnectionRouteKind(connectedHost)
}

struct SyncConnectionAttemptMetadata: Equatable, Sendable {
  var id: String
  var startedAtMilliseconds: Int64

  var payload: [String: Any] {
    ["id": id, "startedAtMs": startedAtMilliseconds]
  }
}

func syncNextConnectionAttemptStartedAtMilliseconds(
  nowMilliseconds: Int64,
  previousMilliseconds: Int64
) -> Int64 {
  max(nowMilliseconds, previousMilliseconds + 1)
}

func syncRelayReadyV2URL(_ rawValue: String) -> String {
  guard var components = URLComponents(string: rawValue) else { return rawValue }
  var queryItems = components.queryItems ?? []
  queryItems.removeAll(where: { $0.name == "ready" })
  queryItems.append(URLQueryItem(name: "ready", value: "2"))
  components.queryItems = queryItems
  return components.string ?? rawValue
}

func syncRelayLegacyURL(_ rawValue: String) -> String {
  guard var components = URLComponents(string: rawValue) else { return rawValue }
  let queryItems = (components.queryItems ?? []).filter { $0.name != "ready" }
  components.queryItems = queryItems.isEmpty ? nil : queryItems
  return components.string ?? rawValue
}

func syncRelayCorrelatedURL(_ rawValue: String, correlationID: String) -> String {
  guard var components = URLComponents(string: rawValue) else { return rawValue }
  var queryItems = components.queryItems ?? []
  queryItems.removeAll(where: { $0.name == "cid" })
  queryItems.append(URLQueryItem(name: "cid", value: correlationID.lowercased()))
  components.queryItems = queryItems
  return components.string ?? rawValue
}

enum SyncRelayTransportControl: Equatable {
  case accepted
  case ready
}

func syncRelayTransportControl(from object: Any) -> SyncRelayTransportControl? {
  guard let payload = object as? [String: Any],
        (payload["v"] as? NSNumber)?.intValue == 2,
        let type = payload["t"] as? String else { return nil }
  switch type {
  case "accepted": return .accepted
  case "ready": return .ready
  default: return nil
  }
}

enum SyncRelayReadyNegotiationDecision: Equatable {
  case interceptedWaiting
  case sendHello
  case retryLegacySocket
  case ignore
}

enum SyncRelayReadyNegotiationError: Error, Equatable {
  case retryLegacySocket
}

struct SyncRelayReadyNegotiation: Equatable {
  private(set) var acceptedV2 = false
  private(set) var ready = false

  mutating func receive(_ control: SyncRelayTransportControl?) -> SyncRelayReadyNegotiationDecision {
    guard let control else { return .ignore }
    switch control {
    case .accepted:
      acceptedV2 = true
      return .interceptedWaiting
    case .ready:
      guard acceptedV2 else { return .ignore }
      ready = true
      return .sendHello
    }
  }

  /// Budget for the next frame, measured from the moment the current phase
  /// began. `accepted` moves the socket into the long phase: it has proven the
  /// relay accepted us and the host is registered, so waiting is no longer a
  /// gamble on a dead endpoint.
  var phaseDeadlineNanoseconds: UInt64 {
    acceptedV2
      ? SyncConnectionRaceTiming.relayReadyAfterAcceptedNanoseconds
      : SyncConnectionRaceTiming.relayAcceptedNegotiationNanoseconds
  }

  func negotiationWindowExpired() -> SyncRelayReadyNegotiationDecision {
    acceptedV2 ? .interceptedWaiting : .retryLegacySocket
  }
}

/// A missing `accepted` is only evidence of a pre-v2 relay the first time we
/// meet an endpoint. Once an endpoint has completed a `?ready=2` handshake, a
/// silent window means the relay or the host is unwell, and redialing without
/// `ready=2` just burns a second tunnel slot against the Durable Object's cap.
func syncRelayLegacyRedialAllowed(
  acceptedV2Observed: Bool,
  endpointNegotiatedReadyV2Before: Bool
) -> Bool {
  !acceptedV2Observed && !endpointNegotiatedReadyV2Before
}

/// `wss://host/connect/<machineKey>` → `host/<machineKey>`. Two in-flight dials
/// for the same value would open two tunnels on the same Durable Object, whose
/// 16-tunnel cap is only swept every 5-10 minutes; the orphans surface later as
/// an unexplained 4503.
func syncRelayMachineKey(from rawValue: String) -> String? {
  guard let components = URLComponents(string: rawValue.trimmingCharacters(in: .whitespacesAndNewlines)),
        let host = components.host?.lowercased(),
        !host.isEmpty else { return nil }
  let key = components.path
    .split(separator: "/")
    .last
    .map(String.init)?
    .trimmingCharacters(in: .whitespacesAndNewlines)
  guard let key, !key.isEmpty else { return nil }
  return "\(host)/\(key)"
}

/// Single-flight guard over relay `/connect` dials, keyed by machine.
struct SyncRelayDialRegistry: Equatable {
  private(set) var inFlightKeys: Set<String> = []

  mutating func acquire(_ key: String) -> Bool {
    inFlightKeys.insert(key).inserted
  }

  mutating func release(_ key: String) {
    inFlightKeys.remove(key)
  }
}

/// Coarse identity for the network the phone is on right now. Wi-Fi carries the
/// phone's own IPv4 /24 so home, office and hotspot are distinguishable; an SSID
/// would need an entitlement the app does not hold, and the /24 separates the
/// same networks for the purpose of "which route worked here".
func syncNetworkFingerprint(
  usesWiFi: Bool,
  usesCellular: Bool,
  usesWiredEthernet: Bool,
  interfaceAddresses: [SyncNetworkInterfaceAddress] = []
) -> String {
  if usesWiredEthernet { return "wired" }
  if usesWiFi {
    guard let prefix = syncLocalIPv4SubnetPrefix(interfaceAddresses) else { return "wifi" }
    return "wifi:\(prefix)"
  }
  if usesCellular { return "cell" }
  return "none"
}

/// The `a.b.c` prefix of this device's own LAN IPv4, taken from a wired/Wi-Fi
/// interface. Tunnels (Tailscale) and loopback are skipped — they do not
/// identify the underlying network.
func syncLocalIPv4SubnetPrefix(_ interfaceAddresses: [SyncNetworkInterfaceAddress]) -> String? {
  for entry in interfaceAddresses {
    guard entry.interfaceName.hasPrefix("en") else { continue }
    let octets = entry.address.split(separator: ".")
    guard octets.count == 4, octets.allSatisfy({ UInt8($0) != nil }) else { continue }
    if octets[0] == "127" { continue }
    if entry.address.hasPrefix("169.254.") { continue }
    return octets.prefix(3).joined(separator: ".")
  }
  return nil
}

func syncRememberedEndpoint(
  in memory: [HostConnectionNetworkRouteMemory]?,
  fingerprint: String
) -> String? {
  guard fingerprint != "none" else { return nil }
  return memory?.first(where: { $0.fingerprint == fingerprint })?.endpoint
}

func syncNetworkRouteMemoryRecording(
  _ memory: [HostConnectionNetworkRouteMemory]?,
  fingerprint: String,
  endpoint: String,
  at updatedAt: TimeInterval,
  capacity: Int = syncNetworkRouteMemoryCapacity
) -> [HostConnectionNetworkRouteMemory] {
  let trimmedEndpoint = endpoint.trimmingCharacters(in: .whitespacesAndNewlines)
  guard fingerprint != "none", !trimmedEndpoint.isEmpty else { return memory ?? [] }
  let entry = HostConnectionNetworkRouteMemory(
    fingerprint: fingerprint,
    endpoint: trimmedEndpoint,
    updatedAt: updatedAt
  )
  let retained = (memory ?? []).filter { $0.fingerprint != fingerprint }
  return Array(([entry] + retained).prefix(max(1, capacity)))
}

struct SyncConnectionRaceScheduledCandidate: Equatable {
  var id: Int
  var endpoint: SyncConnectionEndpointAttempt
  var delayNanoseconds: UInt64
}

func syncConnectionRacePlan(
  rankedAttempts: [SyncConnectionEndpointAttempt],
  maximumCandidateCount: Int = SyncConnectionRaceTiming.maximumCandidateCount,
  staggerNanoseconds: UInt64 = SyncConnectionRaceTiming.candidateStaggerNanoseconds
) -> [SyncConnectionRaceScheduledCandidate] {
  guard maximumCandidateCount > 0, !rankedAttempts.isEmpty else { return [] }

  let first = rankedAttempts[0]
  var selected = [first]
  var selectedSet = Set(selected)
  if let differentTransport = rankedAttempts.dropFirst().first(where: {
    syncConnectionRouteKind($0.address) != syncConnectionRouteKind(first.address)
  }) {
    selected.append(differentTransport)
    selectedSet.insert(differentTransport)
  }
  for attempt in rankedAttempts where selected.count < maximumCandidateCount {
    let kind = syncConnectionRouteKind(attempt.address)
    let selectedKinds = Set(selected.map { syncConnectionRouteKind($0.address) })
    if !selectedKinds.contains(kind), selectedSet.insert(attempt).inserted {
      selected.append(attempt)
    }
  }
  for attempt in rankedAttempts where selected.count < maximumCandidateCount {
    if selectedSet.insert(attempt).inserted {
      selected.append(attempt)
    }
  }

  return selected.prefix(maximumCandidateCount).enumerated().map { offset, endpoint in
    SyncConnectionRaceScheduledCandidate(
      id: offset,
      endpoint: endpoint,
      delayNanoseconds: UInt64(offset) * staggerNanoseconds
    )
  }
}

/// The whole connect plan: direct and relay candidates in ONE race, happy-eyeballs
/// style. Relay used to be raced only after the direct race exhausted its 10s
/// budget, which is a 10-20s stall on cellular where no direct candidate can
/// ever succeed. Here relay is scheduled behind the leading direct candidate by
/// `relayJoinDelayNanoseconds` — unless it leads the ranking itself (proven
/// last-good or the remembered winner for this network), in which case it is
/// dialed at t=0 and cellular reconnects are as fast as LAN ones.
func syncConnectionRaceCandidatePlan(
  rankedAttempts: [SyncConnectionEndpointAttempt],
  maximumConcurrentCandidateCount: Int = SyncConnectionRaceTiming.maximumCandidateCount,
  staggerNanoseconds: UInt64 = SyncConnectionRaceTiming.candidateStaggerNanoseconds,
  relayJoinDelayNanoseconds: UInt64 = SyncConnectionRaceTiming.relayJoinDelayNanoseconds
) -> [SyncConnectionRaceScheduledCandidate] {
  let firstWave = syncConnectionRacePlan(
    rankedAttempts: rankedAttempts,
    maximumCandidateCount: maximumConcurrentCandidateCount,
    staggerNanoseconds: staggerNanoseconds
  )
  let firstWaveEndpoints = Set(firstWave.map(\.endpoint))
  let remaining = rankedAttempts.filter { !firstWaveEndpoints.contains($0) }
  return (firstWave.map(\.endpoint) + remaining).enumerated().map { offset, endpoint in
    var delayNanoseconds = offset < firstWave.count ? UInt64(offset) * staggerNanoseconds : 0
    // Stragglers already wait for a free slot; only the opening wave staggers.
    if offset > 0, offset < firstWave.count, syncConnectionRouteKind(endpoint.address) == .relay {
      delayNanoseconds = max(delayNanoseconds, relayJoinDelayNanoseconds)
    }
    return SyncConnectionRaceScheduledCandidate(
      id: offset,
      endpoint: endpoint,
      delayNanoseconds: delayNanoseconds
    )
  }
}

struct SyncConnectionRaceWaveScheduler: Equatable {
  private var pending: [SyncConnectionRaceScheduledCandidate]
  private(set) var activeCandidateIds: Set<Int> = []
  let maximumConcurrentCandidateCount: Int

  init(
    candidates: [SyncConnectionRaceScheduledCandidate],
    maximumConcurrentCandidateCount: Int = SyncConnectionRaceTiming.maximumCandidateCount
  ) {
    pending = candidates
    self.maximumConcurrentCandidateCount = max(1, maximumConcurrentCandidateCount)
  }

  mutating func startInitialCandidates() -> [SyncConnectionRaceScheduledCandidate] {
    var started: [SyncConnectionRaceScheduledCandidate] = []
    while activeCandidateIds.count < maximumConcurrentCandidateCount, !pending.isEmpty {
      let candidate = pending.removeFirst()
      activeCandidateIds.insert(candidate.id)
      started.append(candidate)
    }
    return started
  }

  mutating func candidateFinished(_ candidateId: Int) -> SyncConnectionRaceScheduledCandidate? {
    guard activeCandidateIds.remove(candidateId) != nil, !pending.isEmpty else { return nil }
    let candidate = pending.removeFirst()
    activeCandidateIds.insert(candidate.id)
    return candidate
  }

  mutating func cancelAll() {
    pending.removeAll()
    activeCandidateIds.removeAll()
  }
}

enum SyncConnectionRaceOwnershipDecision: Equatable {
  case waiting
  case acceptWinner(cancelCandidateIds: Set<Int>)
  case rejectLateWinner
  case exhausted
  case budgetExpired(cancelCandidateIds: Set<Int>)
  case ignored
}

struct SyncConnectionRaceOwnership: Equatable {
  private(set) var activeCandidateIds: Set<Int>
  private(set) var winnerCandidateId: Int?
  private(set) var budgetExpired = false

  init(candidateIds: Set<Int>) {
    activeCandidateIds = candidateIds
  }

  mutating func authenticated(candidateId: Int) -> SyncConnectionRaceOwnershipDecision {
    guard activeCandidateIds.remove(candidateId) != nil else {
      return winnerCandidateId == nil ? .ignored : .rejectLateWinner
    }
    guard winnerCandidateId == nil, !budgetExpired else { return .rejectLateWinner }
    winnerCandidateId = candidateId
    let losers = activeCandidateIds
    activeCandidateIds.removeAll()
    return .acceptWinner(cancelCandidateIds: losers)
  }

  mutating func failed(candidateId: Int) -> SyncConnectionRaceOwnershipDecision {
    guard activeCandidateIds.remove(candidateId) != nil else { return .ignored }
    if activeCandidateIds.isEmpty, winnerCandidateId == nil { return .exhausted }
    return .waiting
  }

  mutating func expireBudget() -> SyncConnectionRaceOwnershipDecision {
    guard winnerCandidateId == nil, !budgetExpired else { return .ignored }
    budgetExpired = true
    let remaining = activeCandidateIds
    activeCandidateIds.removeAll()
    return .budgetExpired(cancelCandidateIds: remaining)
  }
}

enum SyncConnectionRaceMailboxError: Error, LocalizedError {
  case closed(String)

  var errorDescription: String? {
    switch self {
    case .closed(let message): return message
    }
  }
}

actor SyncConnectionRaceTextMailbox {
  private var buffered: [String] = []
  private var waiters: [UUID: CheckedContinuation<String, Error>] = [:]
  private var terminalError: SyncConnectionRaceMailboxError?

  func deliver(_ text: String) {
    guard terminalError == nil else { return }
    if let waiterId = waiters.keys.first,
       let waiter = waiters.removeValue(forKey: waiterId) {
      waiter.resume(returning: text)
    } else {
      buffered.append(text)
    }
  }

  func finish(message: String) {
    guard terminalError == nil else { return }
    let error = SyncConnectionRaceMailboxError.closed(message)
    terminalError = error
    let pending = waiters.values
    waiters.removeAll()
    for waiter in pending { waiter.resume(throwing: error) }
  }

  func next() async throws -> String {
    if !buffered.isEmpty { return buffered.removeFirst() }
    if let terminalError { throw terminalError }
    let waiterId = UUID()
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        waiters[waiterId] = continuation
      }
    } onCancel: {
      Task { await self.cancel(waiterId: waiterId) }
    }
  }

  private func cancel(waiterId: UUID) {
    waiters.removeValue(forKey: waiterId)?.resume(throwing: CancellationError())
  }
}
