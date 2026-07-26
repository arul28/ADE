import Foundation

enum SyncConnectionRaceTiming {
  static let candidateStaggerNanoseconds: UInt64 = 250_000_000
  static let overallBudgetNanoseconds: UInt64 = 10_000_000_000
  static let maximumCandidateCount = 3
  static let relayReadyNegotiationNanoseconds: UInt64 = 350_000_000
}

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

  func negotiationWindowExpired() -> SyncRelayReadyNegotiationDecision {
    acceptedV2 ? .interceptedWaiting : .retryLegacySocket
  }
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

func syncConnectionRaceCandidatePlan(
  rankedAttempts: [SyncConnectionEndpointAttempt],
  maximumConcurrentCandidateCount: Int = SyncConnectionRaceTiming.maximumCandidateCount,
  staggerNanoseconds: UInt64 = SyncConnectionRaceTiming.candidateStaggerNanoseconds
) -> [SyncConnectionRaceScheduledCandidate] {
  let firstWave = syncConnectionRacePlan(
    rankedAttempts: rankedAttempts,
    maximumCandidateCount: maximumConcurrentCandidateCount,
    staggerNanoseconds: staggerNanoseconds
  )
  let firstWaveEndpoints = Set(firstWave.map(\.endpoint))
  let remaining = rankedAttempts.filter { !firstWaveEndpoints.contains($0) }
  return (firstWave.map(\.endpoint) + remaining).enumerated().map { offset, endpoint in
    SyncConnectionRaceScheduledCandidate(
      id: offset,
      endpoint: endpoint,
      delayNanoseconds: offset < firstWave.count ? UInt64(offset) * staggerNanoseconds : 0
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
