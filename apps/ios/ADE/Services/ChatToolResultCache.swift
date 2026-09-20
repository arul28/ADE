import Foundation

/// Bounded, versioned cache for tool results fetched from the host.
///
/// The item id is not a sufficient identity: a retry can reuse an item id for
/// a newer result. The transcript sequence is therefore part of both the
/// cache and in-flight request keys whenever the wire provides one.
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
    eventSequence: Int?
  ) -> String? {
    values[key(sessionId: sessionId, itemId: itemId, eventSequence: eventSequence)]
  }

  func fullToolResult(
    sessionId: String,
    itemId: String,
    eventSequence: Int?,
    fetch: @escaping () async throws -> String
  ) async throws -> String {
    let cacheKey = key(sessionId: sessionId, itemId: itemId, eventSequence: eventSequence)
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

  private func key(sessionId: String, itemId: String, eventSequence: Int?) -> String {
    "\(sessionId)|\(itemId)|\(eventSequence.map(String.init) ?? "latest")"
  }
}
