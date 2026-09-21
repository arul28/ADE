import XCTest
@testable import ADE

@MainActor
final class WorkChatToolResultCacheTests: XCTestCase {
  func testSameItemUsesTheTranscriptSequenceAsTheCacheVersion() async throws {
    let cache = WorkChatToolResultCache(limit: 4)
    var fetchCount = 0

    let first = try await cache.fullToolResult(
      sessionId: "session-1",
      itemId: "item-1",
      eventSequence: 10
    ) {
      fetchCount += 1
      return "old result"
    }
    let sameVersion = try await cache.fullToolResult(
      sessionId: "session-1",
      itemId: "item-1",
      eventSequence: 10
    ) {
      fetchCount += 1
      return "should not be fetched"
    }
    let retry = try await cache.fullToolResult(
      sessionId: "session-1",
      itemId: "item-1",
      eventSequence: 11
    ) {
      fetchCount += 1
      return "new result"
    }

    XCTAssertEqual(first, "old result")
    XCTAssertEqual(sameVersion, "old result")
    XCTAssertEqual(retry, "new result")
    XCTAssertEqual(fetchCount, 2)
    XCTAssertEqual(
      cache.cachedFullToolResult(sessionId: "session-1", itemId: "item-1", eventSequence: 10),
      "old result"
    )
    XCTAssertEqual(
      cache.cachedFullToolResult(sessionId: "session-1", itemId: "item-1", eventSequence: 11),
      "new result"
    )
  }

  /// Regression: the request identity gained the envelope timestamp (a legacy
  /// transcript can repeat a sequence across host restarts) but the cache key
  /// did not, so the second generation was served the first one's output
  /// without ever contacting the host.
  func testRepeatedLegacySequencesAreSeparatedByTheirTimestamp() async throws {
    let cache = WorkChatToolResultCache(limit: 4)
    var fetchCount = 0

    let before = try await cache.fullToolResult(
      sessionId: "session-1",
      itemId: "item-1",
      eventSequence: 42,
      eventTimestamp: "2026-09-19T10:00:00.000Z"
    ) {
      fetchCount += 1
      return "before restart"
    }
    let after = try await cache.fullToolResult(
      sessionId: "session-1",
      itemId: "item-1",
      eventSequence: 42,
      eventTimestamp: "2026-09-20T11:00:00.000Z"
    ) {
      fetchCount += 1
      return "after restart"
    }

    XCTAssertEqual(before, "before restart")
    XCTAssertEqual(after, "after restart", "the second generation must not reuse the first's entry")
    XCTAssertEqual(fetchCount, 2, "each generation fetches once")

    XCTAssertEqual(
      cache.cachedFullToolResult(
        sessionId: "session-1",
        itemId: "item-1",
        eventSequence: 42,
        eventTimestamp: "2026-09-19T10:00:00.000Z"
      ),
      "before restart"
    )
    XCTAssertEqual(
      cache.cachedFullToolResult(
        sessionId: "session-1",
        itemId: "item-1",
        eventSequence: 42,
        eventTimestamp: "2026-09-20T11:00:00.000Z"
      ),
      "after restart"
    )
    XCTAssertNil(
      cache.cachedFullToolResult(sessionId: "session-1", itemId: "item-1", eventSequence: 42),
      "a lookup with no timestamp is a different identity, not a wildcard"
    )
  }
}
