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
}
