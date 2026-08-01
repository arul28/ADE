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

  func testQueueCapsEachOwnerAtTwoHundredAndEvictsOldestEntries() throws {
    let suiteName = "ActivityAckQueueTests.cap.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = AccountAttentionPendingAckStore(defaults: defaults, key: "pending-acks")
    let start = Date(timeIntervalSince1970: 1_000)
    let entries = (0..<205).map { index in
      AccountAttentionPendingAck(
        itemId: String(format: "item-%03d", index),
        seenAt: start,
        dismissedAt: nil,
        sourceRevision: index,
        queuedAt: start.addingTimeInterval(TimeInterval(index))
      )
    }

    store.enqueue(entries, for: "account-a")
    store.enqueue([entries[0]], for: "account-b")

    let retained = store.entries(for: "account-a")
    XCTAssertEqual(retained.count, 200)
    XCTAssertEqual(retained.first?.itemId, "item-005")
    XCTAssertEqual(retained.last?.itemId, "item-204")
    XCTAssertEqual(store.entries(for: "account-b").map(\.itemId), ["item-000"])
  }

  func testFlushPruningDropsEntriesOlderThanTwentyFourHoursOnlyForThatOwner() throws {
    let suiteName = "ActivityAckQueueTests.expiry.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let store = AccountAttentionPendingAckStore(defaults: defaults, key: "pending-acks")
    let now = Date(timeIntervalSince1970: 200_000)
    let entries = [
      AccountAttentionPendingAck(
        itemId: "expired",
        seenAt: now,
        dismissedAt: nil,
        sourceRevision: 1,
        queuedAt: now.addingTimeInterval(-AccountAttentionPendingAckStore.maximumAge - 1)
      ),
      AccountAttentionPendingAck(
        itemId: "at-cutoff",
        seenAt: now,
        dismissedAt: nil,
        sourceRevision: 2,
        queuedAt: now.addingTimeInterval(-AccountAttentionPendingAckStore.maximumAge)
      ),
      AccountAttentionPendingAck(
        itemId: "fresh",
        seenAt: now,
        dismissedAt: nil,
        sourceRevision: 3,
        queuedAt: now.addingTimeInterval(-60)
      ),
    ]
    store.enqueue(entries, for: "account-a")
    store.enqueue([entries[0]], for: "account-b")

    let retained = store.pruneExpired(for: "account-a", now: now)

    XCTAssertEqual(retained.map(\.itemId), ["at-cutoff", "fresh"])
    XCTAssertEqual(store.entries(for: "account-a"), retained)
    XCTAssertEqual(store.entries(for: "account-b").map(\.itemId), ["expired"])
  }

  func testFailedBatchDoesNotStarveTheNextBatch() async throws {
    let suiteName = "ActivityAckQueueTests.batch.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let ownerId = "account-a"
    let store = AccountAttentionPendingAckStore(defaults: defaults, key: "pending-acks")
    let timestamp = Date(timeIntervalSince1970: 3_000)
    let entries = (0..<65).map { index in
      AccountAttentionPendingAck(
        itemId: String(format: "item-%03d", index),
        seenAt: timestamp,
        dismissedAt: nil,
        sourceRevision: index,
        queuedAt: timestamp.addingTimeInterval(TimeInterval(index))
      )
    }
    store.enqueue(entries, for: ownerId)
    let revisions = Dictionary(uniqueKeysWithValues: entries.map { ($0.itemId, $0.sourceRevision!) })
    var batches: [[String]] = []

    let outcome = await flushAccountAttentionAckEntries(
      store.entries(for: ownerId),
      ownerId: ownerId,
      revisionById: revisions,
      store: store,
      acknowledge: { itemIds, _, _ in
        batches.append(itemIds)
        if batches.count == 1 {
          throw AccountAttentionRelayClient.RelayError.transport
        }
        return AccountAttentionAcknowledgmentResult(applied: itemIds, stale: [])
      }
    )

    XCTAssertEqual(batches.map(\.count), [64, 1])
    XCTAssertEqual(batches.last, ["item-064"])
    XCTAssertEqual(outcome.attemptedItemIds.count, 65)
    XCTAssertNotNil(outcome.failureMessage)
    let remaining = store.entries(for: ownerId)
    XCTAssertEqual(remaining.count, 64)
    XCTAssertTrue(remaining.allSatisfy { $0.attemptCount == 1 })
    XCTAssertFalse(remaining.contains { $0.itemId == "item-064" })
  }

  func testFifthFailedAttemptEvictsTheEntry() async throws {
    let suiteName = "ActivityAckQueueTests.attempts.\(UUID().uuidString)"
    let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
    defer { defaults.removePersistentDomain(forName: suiteName) }
    let ownerId = "account-a"
    let store = AccountAttentionPendingAckStore(defaults: defaults, key: "pending-acks")
    let entry = AccountAttentionPendingAck(
      itemId: "permanent-failure",
      seenAt: Date(timeIntervalSince1970: 4_000),
      dismissedAt: nil,
      sourceRevision: 9,
      queuedAt: Date(timeIntervalSince1970: 4_000),
      attemptCount: AccountAttentionPendingAckStore.maximumFailedAttempts - 1
    )
    store.enqueue([entry], for: ownerId)

    let outcome = await flushAccountAttentionAckEntries(
      store.entries(for: ownerId),
      ownerId: ownerId,
      revisionById: [entry.itemId: 9],
      store: store,
      acknowledge: { _, _, _ in
        throw AccountAttentionRelayClient.RelayError.transport
      }
    )

    XCTAssertEqual(outcome.attemptedItemIds, Set([entry.itemId]))
    XCTAssertNotNil(outcome.failureMessage)
    XCTAssertTrue(store.entries(for: ownerId).isEmpty)
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
