import Foundation

/// Bounded, versioned cache for tool results fetched from the host.
///
/// The item id is not a sufficient identity: a retry can reuse an item id for
/// a newer result. The transcript sequence AND its timestamp are therefore part
/// of both the cache and in-flight request keys whenever the wire provides
/// them — the same pair the host matches on. The sequence alone is not enough
/// either: older hosts restarted `eventSequence` at 1 on every rehydration, so
/// one legacy transcript can hold two generations under the same number, and a
/// sequence-only key would hand the second expansion the first one's output
/// without ever contacting the host.
@MainActor
final class WorkChatToolResultCache {
  private let limit: Int
  private var values: [String: String] = [:]
  private var order: [String] = []
  private var inFlight: [String: Task<String, Error>] = [:]

  init(limit: Int = 32) {
    self.limit = max(1, limit)
  }

  func cachedFullToolResult(
    sessionId: String,
    itemId: String,
    eventSequence: Int?,
    eventTimestamp: String? = nil
  ) -> String? {
    values[key(
      sessionId: sessionId,
      itemId: itemId,
      eventSequence: eventSequence,
      eventTimestamp: eventTimestamp
    )]
  }

  func fullToolResult(
    sessionId: String,
    itemId: String,
    eventSequence: Int?,
    eventTimestamp: String? = nil,
    fetch: @escaping () async throws -> String
  ) async throws -> String {
    let cacheKey = key(
      sessionId: sessionId,
      itemId: itemId,
      eventSequence: eventSequence,
      eventTimestamp: eventTimestamp
    )
    if let cached = values[cacheKey] { return cached }
    if let task = inFlight[cacheKey] { return try await task.value }

    let task = Task<String, Error> {
      try await fetch()
    }
    inFlight[cacheKey] = task
    defer { inFlight[cacheKey] = nil }

    let value = try await task.value
    values[cacheKey] = value
    order.append(cacheKey)
    while order.count > limit {
      let evicted = order.removeFirst()
      values[evicted] = nil
    }
    return value
  }

  private func key(
    sessionId: String,
    itemId: String,
    eventSequence: Int?,
    eventTimestamp: String?
  ) -> String {
    let sequence = eventSequence.map(String.init) ?? "latest"
    let timestamp = eventTimestamp.flatMap { $0.isEmpty ? nil : $0 } ?? "-"
    return "\(sessionId)|\(itemId)|\(sequence)|\(timestamp)"
  }
}
