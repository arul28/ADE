import XCTest
@testable import ADE

@MainActor
final class ActivityAckQueueTests: XCTestCase {
  func testFailedAcknowledgmentPersistsUntilRefreshFlushesAppliedItem() throws {
    let suiteName = "ActivityAckQueueTests.flush.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let key = "pending-acks"
    let ownerId = "account-a"
    let store = AccountAttentionPendingAckStore(defaults: defaults, key: key)
    let pending = AccountAttentionPendingAck(
      itemId: "agent:machine-a:session-a",
      seenAt: Date(timeIntervalSince1970: 100),
      dismissedAt: Date(timeIntervalSince1970: 101),
      sourceRevision: 7
    )

    // A failed relay send leaves the optimistic mutation durable. Recreating
    // the store models the next foreground refresh after process suspension.
    store.enqueue([pending], for: ownerId)
    let restored = AccountAttentionPendingAckStore(defaults: defaults, key: key)
    XCTAssertEqual(restored.entries(for: ownerId), [pending])

    // The refresh queue drain removes only ids the relay reports as applied.
    restored.remove(itemIds: [pending.itemId], for: ownerId)
    XCTAssertTrue(restored.entries(for: ownerId).isEmpty)
  }

  func testDedupeKeepsNewestAcknowledgmentStatePerItem() throws {
    let suiteName = "ActivityAckQueueTests.dedupe.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = AccountAttentionPendingAckStore(defaults: defaults, key: "pending-acks")
    let older = AccountAttentionPendingAck(
      itemId: " item-a ",
      seenAt: Date(timeIntervalSince1970: 100),
      dismissedAt: nil,
      sourceRevision: 2
    )
    let newer = AccountAttentionPendingAck(
      itemId: "item-a",
      seenAt: Date(timeIntervalSince1970: 200),
      dismissedAt: Date(timeIntervalSince1970: 201),
      sourceRevision: 3
    )

    store.enqueue([newer, older], for: "account-a")

    XCTAssertEqual(store.entries(for: "account-a"), [newer])
    XCTAssertTrue(store.entries(for: "account-b").isEmpty)
  }

  func testStaleAcknowledgmentsRefreshAndRetryExactlyOnce() async {
    var refreshCount = 0
    var retryCount = 0
    let staleIds: Set<String> = ["item-a", "item-b"]

    let retriedIds = await retryAccountAttentionAcknowledgmentsOnce(
      itemIds: staleIds,
      refresh: { refreshCount += 1 },
      retry: { itemIds in
        retryCount += 1
        return itemIds
      }
    )

    XCTAssertEqual(refreshCount, 1)
    XCTAssertEqual(retryCount, 1)
    XCTAssertEqual(retriedIds, staleIds)
  }

  func testHardOwnerMismatchClearsOnlyRejectedOwnerQueue() throws {
    let suiteName = "ActivityAckQueueTests.owner.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = AccountAttentionPendingAckStore(defaults: defaults, key: "pending-acks")
    let entry = AccountAttentionPendingAck(
      itemId: "item-a",
      seenAt: Date(timeIntervalSince1970: 100),
      dismissedAt: nil,
      sourceRevision: 1
    )
    store.enqueue([entry], for: "account-a")
    store.enqueue([entry], for: "account-b")

    store.clear(for: "account-a")

    XCTAssertTrue(store.entries(for: "account-a").isEmpty)
    XCTAssertEqual(store.entries(for: "account-b"), [entry])
  }
}
