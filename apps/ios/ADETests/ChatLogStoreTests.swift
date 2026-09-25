import SQLite3
import XCTest
@testable import ADE

/// The on-disk chat log cache (mobile thread engine I1): ordering, buffered
/// reads, snapshot replacement, generation drops, budgets, purges, and
/// recovery from a stale schema.
final class ChatLogStoreTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("ChatLogStoreTests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  private let chatA = ChatLogKey(machineKey: "mac-1", sessionId: "chat-a", scopeKey: "project:p1")
  private let chatB = ChatLogKey(machineKey: "mac-1", sessionId: "chat-b", scopeKey: "project:p1")
  private let chatC = ChatLogKey(machineKey: "mac-2", sessionId: "chat-c", scopeKey: "personal")
  private let chatD = ChatLogKey(machineKey: "mac-2", sessionId: "chat-d", scopeKey: "personal")

  private func makeStore(perChat: Int = 1_500_000, total: Int = 150_000_000) -> ChatLogStore {
    ChatLogStore(directoryURL: directory, perChatByteBudget: perChat, totalByteBudget: total)
  }

  private func event(_ sequence: Int, bytes: Int? = nil, tag: String = "") -> ChatLogStoredEvent {
    let payload: Data
    if let bytes {
      payload = Data(repeating: UInt8(ascii: "x"), count: bytes)
    } else {
      payload = Data("{\"sequence\":\(sequence),\"tag\":\"\(tag)\"}".utf8)
    }
    return ChatLogStoredEvent(sequence: sequence, timestamp: "2026-09-23T00:00:\(String(format: "%02d", sequence % 60)).000Z", payload: payload)
  }

  private func sequences(_ events: [ChatLogStoredEvent]) -> [Int] {
    events.map(\.sequence)
  }

  func testLoadTailReturnsNewestEventsAscendingWithinLimits() async {
    let store = makeStore()
    await store.append(chatA, events: [event(3), event(1), event(5), event(2), event(4)], generation: 1)
    await store.flush()

    let all = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(all.events), [1, 2, 3, 4, 5])
    XCTAssertEqual(all.meta?.generation, 1)
    XCTAssertEqual(all.meta?.maxSequence, 5)
    XCTAssertEqual(all.meta?.oldestSequence, 1)
    XCTAssertEqual(all.meta?.eventCount, 5)

    let lastTwo = await store.loadTail(chatA, maxEvents: 2, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(lastTwo.events), [4, 5])

    let oneByBytes = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1)
    XCTAssertEqual(sequences(oneByBytes.events), [5], "at least the newest event is returned even over maxBytes")

    let older = await store.loadBefore(chatA, beforeSequence: 4, maxEvents: 2)
    XCTAssertEqual(sequences(older), [2, 3])

    let other = await store.loadTail(chatB, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertNil(other.meta)
    XCTAssertTrue(other.events.isEmpty)
  }

  func testReadsSeeBufferedEventsBeforeFlush() async {
    let store = makeStore()
    await store.append(chatA, events: [event(1), event(2)], generation: 1)
    await store.flush()
    await store.append(chatA, events: [event(3)], generation: 1)

    let tail = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(tail.events), [1, 2, 3])
    XCTAssertEqual(tail.meta?.maxSequence, 3)

    let before = await store.loadBefore(chatA, beforeSequence: 4, maxEvents: 10)
    XCTAssertEqual(sequences(before), [1, 2, 3])

    await store.append(chatB, events: [event(7)], generation: nil)
    let neverFlushed = await store.loadTail(chatB, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(neverFlushed.events), [7])
    XCTAssertEqual(neverFlushed.meta?.maxSequence, 7)
  }

  func testBufferedWritesReachDiskWithoutAnExplicitFlush() async throws {
    let store = makeStore()
    await store.append(chatA, events: [event(1)], generation: 1)
    try await Task.sleep(nanoseconds: 800_000_000)

    let reopened = makeStore()
    let tail = await reopened.loadTail(chatA, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(tail.events), [1])
    _ = store
  }

  func testAppendUpsertsDuplicateSequences() async {
    let store = makeStore()
    await store.append(chatA, events: [event(1, tag: "old"), event(2)], generation: 1)
    await store.flush()
    await store.append(chatA, events: [event(1, tag: "new")], generation: 1)

    let buffered = await store.loadTail(chatA, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertEqual(buffered.events.first, event(1, tag: "new"))

    await store.flush()
    let flushed = await store.loadTail(chatA, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertEqual(flushed.events, [event(1, tag: "new"), event(2)])
    XCTAssertEqual(flushed.meta?.eventCount, 2)
  }

  func testReplaceRangeIsAuthoritativeFromItsFirstSequence() async {
    let store = makeStore()
    await store.append(chatA, events: (1...6).map { event($0, tag: "cached") }, generation: 1)
    await store.flush()

    await store.replaceRange(
      chatA,
      fromSequence: 4,
      with: [event(4, tag: "snap"), event(6, tag: "snap"), event(7, tag: "snap")],
      generation: 1,
      hasOlder: true,
      olderCursor: 4
    )

    let tail = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(tail.events), [1, 2, 3, 4, 6, 7], "cached 5 was not in the snapshot, so it is gone")
    XCTAssertEqual(tail.events[3], event(4, tag: "snap"))
    XCTAssertEqual(tail.meta?.hasOlder, true)
    XCTAssertEqual(tail.meta?.olderCursor, 4)
    XCTAssertEqual(tail.meta?.maxSequence, 7)
  }

  func testReplaceRangeWinsOverBufferedEventsInItsRange() async {
    let store = makeStore()
    await store.append(chatA, events: [event(1), event(2, tag: "buffered"), event(3, tag: "buffered")], generation: 1)
    await store.replaceRange(chatA, fromSequence: 2, with: [event(2, tag: "snap")], generation: 1, hasOlder: false, olderCursor: nil)

    let tail = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(tail.events, [event(1), event(2, tag: "snap")])
  }

  func testDropBelowRemovesOlderRowsOnDiskAndInTheBuffer() async {
    let store = makeStore()
    await store.append(chatA, events: (1...4).map { event($0) }, generation: 1)
    await store.flush()
    await store.append(chatA, events: [event(5)], generation: 1)
    await store.append(chatB, events: [event(1)], generation: 1)

    await store.replaceRange(chatA, fromSequence: 10, with: [event(10), event(11)], generation: 1, hasOlder: true, olderCursor: 10)
    await store.dropBelow(chatA, sequence: 10)

    let tail = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(tail.events), [10, 11])
    XCTAssertEqual(tail.meta?.oldestSequence, 10)
    XCTAssertEqual(tail.meta?.eventCount, 2)
    let other = await store.loadTail(chatB, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(other.events), [1])
  }

  func testGenerationChangeDropsCachedRows() async {
    let store = makeStore()
    await store.append(chatA, events: (1...3).map { event($0) }, generation: 1)
    await store.flush()
    await store.append(chatA, events: [event(4)], generation: 1)

    await store.append(chatA, events: [event(2, tag: "rewritten")], generation: 2)
    let tail = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(tail.events, [event(2, tag: "rewritten")])
    XCTAssertEqual(tail.meta?.generation, 2)

    await store.flush()
    let flushed = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(flushed.events, [event(2, tag: "rewritten")])
    XCTAssertEqual(flushed.meta?.generation, 2)

    await store.replaceRange(chatA, fromSequence: 1, with: [event(1, tag: "g3")], generation: 3, hasOlder: false, olderCursor: nil)
    let replaced = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(replaced.events, [event(1, tag: "g3")])
    XCTAssertEqual(replaced.meta?.generation, 3)
  }

  func testPerChatBudgetTrimsOldestAndSetsHasOlder() async {
    let store = makeStore(perChat: 1_000)
    await store.append(chatA, events: (1...5).map { event($0, bytes: 300) }, generation: 1)
    await store.flush()

    let tail = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(tail.events), [3, 4, 5])
    XCTAssertEqual(tail.meta?.bytes, 900)
    XCTAssertEqual(tail.meta?.hasOlder, true)
    XCTAssertEqual(tail.meta?.oldestSequence, 3)
    // The host byte cursor is invalid after a trim; paging switches to sequence.
    XCTAssertNil(tail.meta?.olderCursor)
  }

  func testOversizedSingleEventIsKeptAlone() async {
    let store = makeStore(perChat: 1_000)
    await store.append(chatA, events: [event(1, bytes: 100), event(2, bytes: 100)], generation: 1)
    await store.flush()
    await store.append(chatA, events: [event(3, bytes: 5_000)], generation: 1)
    await store.flush()

    let tail = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(tail.events), [3])
    XCTAssertEqual(tail.events.first?.payload.count, 5_000)
    XCTAssertEqual(tail.meta?.hasOlder, true)

    await store.append(chatA, events: [event(4, bytes: 10)], generation: 1)
    await store.flush()
    let after = await store.loadTail(chatA, maxEvents: 100, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(after.events), [4], "the oversized event is trimmed once something newer arrives")
  }

  func testTotalBudgetEvictsLeastRecentlyOpenedChats() async {
    let store = makeStore(perChat: 1_000, total: 3_000)
    let opened: [(ChatLogKey, TimeInterval)] = [(chatA, 100), (chatB, 200), (chatC, 300)]
    for (key, openedAt) in opened {
      await store.append(key, events: [event(1, bytes: 900)], generation: 1)
      await store.flush()
      await store.updateMeta(key) { $0.lastOpenedAt = Date(timeIntervalSince1970: openedAt) }
    }

    await store.append(chatD, events: [event(1, bytes: 900)], generation: 1)
    await store.flush()

    let a = await store.loadTail(chatA, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertNil(a.meta, "least recently opened chat is evicted")
    XCTAssertTrue(a.events.isEmpty)
    for key in [chatB, chatC, chatD] {
      let tail = await store.loadTail(key, maxEvents: 10, maxBytes: 1_000_000)
      XCTAssertEqual(sequences(tail.events), [1], "\(key.sessionId) should survive")
    }
    let recent = await store.recentKeys(limit: 10)
    XCTAssertEqual(recent, [chatD, chatC, chatB])
  }

  func testTouchAndRecentKeysOrder() async {
    let store = makeStore()
    for key in [chatA, chatB, chatC] {
      await store.append(key, events: [event(1)], generation: 1)
    }
    await store.flush()
    await store.updateMeta(chatA) { $0.lastOpenedAt = Date(timeIntervalSince1970: 1) }
    await store.updateMeta(chatB) { $0.lastOpenedAt = Date(timeIntervalSince1970: 2) }
    await store.updateMeta(chatC) { $0.lastOpenedAt = Date(timeIntervalSince1970: 3) }
    await store.touch(chatA)

    let recent = await store.recentKeys(limit: 2)
    XCTAssertEqual(recent, [chatA, chatC])
  }

  func testPurgeMachineAndPurgeAll() async {
    let store = makeStore()
    for key in [chatA, chatB, chatC] {
      await store.append(key, events: [event(1)], generation: 1)
    }
    await store.flush()
    await store.append(chatA, events: [event(2)], generation: 1)

    await store.purgeMachine("mac-1")
    for key in [chatA, chatB] {
      let tail = await store.loadTail(key, maxEvents: 10, maxBytes: 1_000_000)
      XCTAssertNil(tail.meta)
      XCTAssertTrue(tail.events.isEmpty)
    }
    let survivor = await store.loadTail(chatC, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(survivor.events), [1])

    await store.append(chatD, events: [event(9)], generation: 1)
    await store.purgeAll()
    for key in [chatC, chatD] {
      let tail = await store.loadTail(key, maxEvents: 10, maxBytes: 1_000_000)
      XCTAssertTrue(tail.events.isEmpty)
    }
    let recent = await store.recentKeys(limit: 10)
    XCTAssertTrue(recent.isEmpty)

    await store.append(chatA, events: [event(1)], generation: 1)
    await store.flush()
    let reused = await store.loadTail(chatA, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(reused.events), [1], "the store keeps working after purgeAll")
  }

  func testDropRemovesOneChat() async {
    let store = makeStore()
    await store.append(chatA, events: [event(1)], generation: 1)
    await store.append(chatB, events: [event(1)], generation: 1)
    await store.flush()
    await store.drop(chatA)

    let a = await store.loadTail(chatA, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertNil(a.meta)
    let b = await store.loadTail(chatB, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(b.events), [1])
  }

  func testSchemaVersionMismatchRecreatesTheFile() async throws {
    let store = makeStore()
    await store.append(chatA, events: [event(1)], generation: 1)
    await store.close()

    let path = directory.appendingPathComponent(ChatLogStore.fileName).path
    var raw: OpaquePointer?
    XCTAssertEqual(sqlite3_open(path, &raw), SQLITE_OK)
    XCTAssertEqual(sqlite3_exec(raw, "pragma user_version = 99", nil, nil, nil), SQLITE_OK)
    sqlite3_close(raw)

    let reopened = makeStore()
    let tail = await reopened.loadTail(chatA, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertNil(tail.meta)
    XCTAssertTrue(tail.events.isEmpty)

    await reopened.append(chatA, events: [event(2)], generation: 1)
    await reopened.flush()
    let fresh = await reopened.loadTail(chatA, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(fresh.events), [2])
  }

  func testGarbageFileIsReplacedAndReadsReturnEmpty() async throws {
    let path = directory.appendingPathComponent(ChatLogStore.fileName)
    try Data(repeating: 0xAB, count: 8_192).write(to: path)

    let store = makeStore()
    let tail = await store.loadTail(chatA, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertTrue(tail.events.isEmpty)

    await store.append(chatA, events: [event(1)], generation: 1)
    await store.flush()
    let after = await store.loadTail(chatA, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertEqual(sequences(after.events), [1])
  }

  func testFlushedEventsPersistAcrossStoreInstances() async {
    let store = makeStore()
    await store.append(chatA, events: (1...3).map { event($0) }, generation: 4)
    await store.updateMeta(chatA) { meta in
      meta.hasOlder = true
      meta.olderCursor = 1
    }
    await store.flush()

    let reopened = makeStore()
    let tail = await reopened.loadTail(chatA, maxEvents: 10, maxBytes: 1_000_000)
    XCTAssertEqual(tail.events, (1...3).map { event($0) })
    XCTAssertEqual(tail.meta?.generation, 4)
    XCTAssertEqual(tail.meta?.hasOlder, true)
    XCTAssertEqual(tail.meta?.olderCursor, 1)
    _ = store
  }

  func testDatabaseFileIsExcludedFromBackup() async throws {
    let store = makeStore()
    await store.append(chatA, events: [event(1)], generation: 1)
    await store.flush()

    let url = directory.appendingPathComponent(ChatLogStore.fileName)
    let values = try url.resourceValues(forKeys: [.isExcludedFromBackupKey])
    XCTAssertEqual(values.isExcludedFromBackup, true)
  }
}
