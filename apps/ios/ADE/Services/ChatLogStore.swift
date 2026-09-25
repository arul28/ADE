import Foundation
import os
import SQLite3

// On-disk cache of chat event logs (mobile thread engine, item I1).
//
// A separate SQLite file (`chat-log.sqlite`), never the CRR `ade.db`. One
// connection, owned by the actor. Rows are the host's wire envelopes keyed by
// the durable envelope `sequence`. Unsequenced events are never stored.
//
// Everything here is best-effort: failures are logged and swallowed, reads
// return empty on error, and a corrupt or out-of-date file is deleted and
// recreated.

nonisolated(unsafe) private let chatLogSQLiteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
private let chatLogLog = Logger(subsystem: "com.ade.ios", category: "chat-log")

struct ChatLogKey: Hashable, Sendable {
  let machineKey: String
  let sessionId: String
  /// "project:<id>", "personal", etc.
  let scopeKey: String
}

struct ChatLogSessionMeta: Sendable, Equatable {
  var generation: Int?
  var maxSequence: Int?
  var oldestSequence: Int?
  var hasOlder: Bool
  var olderCursor: Int?
  /// Sum of stored payload bytes. Derived; `updateMeta` cannot change it.
  var bytes: Int
  /// Number of stored events. Derived; `updateMeta` cannot change it.
  var eventCount: Int
  var lastOpenedAt: Date

  init(
    generation: Int? = nil,
    maxSequence: Int? = nil,
    oldestSequence: Int? = nil,
    hasOlder: Bool = false,
    olderCursor: Int? = nil,
    bytes: Int = 0,
    eventCount: Int = 0,
    lastOpenedAt: Date
  ) {
    self.generation = generation
    self.maxSequence = maxSequence
    self.oldestSequence = oldestSequence
    self.hasOlder = hasOlder
    self.olderCursor = olderCursor
    self.bytes = bytes
    self.eventCount = eventCount
    self.lastOpenedAt = lastOpenedAt
  }
}

struct ChatLogStoredEvent: Sendable, Equatable {
  let sequence: Int
  let timestamp: String
  /// Raw wire JSON of one `AgentChatEventEnvelope`.
  let payload: Data
}

actor ChatLogStore {
  static let shared = ChatLogStore()

  static let schemaVersion: Int32 = 1
  static let fileName = "chat-log.sqlite"
  static let flushDelayNanoseconds: UInt64 = 250_000_000
  static let flushByteThreshold = 256 * 1024

  private struct PendingChat {
    var events: [Int: ChatLogStoredEvent] = [:]
    var bytes = 0
    var generation: Int?
  }

  private let directoryURL: URL
  private let databaseURL: URL
  private let perChatByteBudget: Int
  private let totalByteBudget: Int

  private var db: OpaquePointer?
  private var statements: [String: OpaquePointer] = [:]
  private var needsReset = false
  private var openRetryAfter: Date?
  private var inTransaction = false
  private var statementFailed = false

  private var pending: [ChatLogKey: PendingChat] = [:]
  private var pendingBytes = 0
  private var flushTask: Task<Void, Never>?

  init(directoryURL: URL? = nil, perChatByteBudget: Int = 1_500_000, totalByteBudget: Int = 150_000_000) {
    let resolved = directoryURL
      ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        .appendingPathComponent("ADE", isDirectory: true)
    self.directoryURL = resolved
    self.databaseURL = resolved.appendingPathComponent(Self.fileName)
    self.perChatByteBudget = max(1, perChatByteBudget)
    self.totalByteBudget = max(1, totalByteBudget)
  }

  deinit {
    flushTask?.cancel()
    for statement in statements.values {
      sqlite3_finalize(statement)
    }
    if let db {
      sqlite3_close(db)
    }
  }

  // MARK: - Reads

  /// The newest events for a chat, ascending by sequence. Includes buffered
  /// writes that have not reached disk yet. Always returns at least one event
  /// when any exist, even if it alone exceeds `maxBytes`.
  func loadTail(_ key: ChatLogKey, maxEvents: Int, maxBytes: Int) -> (meta: ChatLogSessionMeta?, events: [ChatLogStoredEvent]) {
    let opened = ensureOpen()
    let storedMeta = opened ? readMeta(key) : nil
    let meta = mergedMeta(key, stored: storedMeta)
    guard maxEvents > 0 else { return (meta, []) }

    var bySequence: [Int: ChatLogStoredEvent] = [:]
    if opened {
      run(
        "select sequence, timestamp, payload from chat_log_events where machine_key = ? and session_id = ? and scope_key = ? order by sequence desc limit ?",
        bind: { stmt in
          self.bindKey(stmt, key)
          sqlite3_bind_int64(stmt, 4, sqlite3_int64(maxEvents))
        },
        row: { stmt in
          let event = self.readEvent(stmt)
          bySequence[event.sequence] = event
          return true
        }
      )
    }
    if let buffered = pending[key] {
      for (sequence, event) in buffered.events {
        bySequence[sequence] = event
      }
    }

    var out: [ChatLogStoredEvent] = []
    var bytes = 0
    for event in bySequence.values.sorted(by: { $0.sequence > $1.sequence }) {
      if out.count >= maxEvents { break }
      if !out.isEmpty && bytes + event.payload.count > maxBytes { break }
      out.append(event)
      bytes += event.payload.count
    }
    return (meta, out.reversed())
  }

  /// Up to `maxEvents` events strictly older than `beforeSequence`, ascending.
  func loadBefore(_ key: ChatLogKey, beforeSequence: Int, maxEvents: Int) -> [ChatLogStoredEvent] {
    guard maxEvents > 0 else { return [] }
    var bySequence: [Int: ChatLogStoredEvent] = [:]
    if ensureOpen() {
      run(
        "select sequence, timestamp, payload from chat_log_events where machine_key = ? and session_id = ? and scope_key = ? and sequence < ? order by sequence desc limit ?",
        bind: { stmt in
          self.bindKey(stmt, key)
          sqlite3_bind_int64(stmt, 4, sqlite3_int64(beforeSequence))
          sqlite3_bind_int64(stmt, 5, sqlite3_int64(maxEvents))
        },
        row: { stmt in
          let event = self.readEvent(stmt)
          bySequence[event.sequence] = event
          return true
        }
      )
    }
    if let buffered = pending[key] {
      for (sequence, event) in buffered.events where sequence < beforeSequence {
        bySequence[sequence] = event
      }
    }
    let newest = bySequence.values.sorted(by: { $0.sequence > $1.sequence }).prefix(maxEvents)
    return newest.reversed()
  }

  /// Most recently opened chats first. Chats that only exist in the write
  /// buffer (never flushed) are not listed.
  func recentKeys(limit: Int) -> [ChatLogKey] {
    guard limit > 0, ensureOpen() else { return [] }
    var keys: [ChatLogKey] = []
    run(
      "select machine_key, session_id, scope_key from chat_log_sessions order by last_opened_at desc limit ?",
      bind: { stmt in sqlite3_bind_int64(stmt, 1, sqlite3_int64(limit)) },
      row: { stmt in
        keys.append(ChatLogKey(
          machineKey: self.columnText(stmt, 0),
          sessionId: self.columnText(stmt, 1),
          scopeKey: self.columnText(stmt, 2)
        ))
        return true
      }
    )
    return keys
  }

  // MARK: - Writes

  /// Upserts events by sequence. Buffered: reaches disk within 250 ms, at
  /// 256 KB of buffered payload, or on `flush()`.
  func append(_ key: ChatLogKey, events: [ChatLogStoredEvent], generation: Int?) {
    guard ensureOpen() else { return }
    applyGeneration(key, generation)
    var chat = pending[key] ?? PendingChat()
    if let generation { chat.generation = generation }
    for event in events {
      if let old = chat.events[event.sequence] {
        chat.bytes -= old.payload.count
        pendingBytes -= old.payload.count
      }
      chat.events[event.sequence] = event
      chat.bytes += event.payload.count
      pendingBytes += event.payload.count
    }
    pending[key] = chat
    if pendingBytes >= Self.flushByteThreshold {
      flushNow()
    } else {
      scheduleFlush()
    }
  }

  /// A snapshot is authoritative for `>= fromSequence`: every stored row in
  /// that range is replaced by `events`. Rows below `fromSequence` stay; call
  /// `dropBelow` when the snapshot follows a gap.
  func replaceRange(
    _ key: ChatLogKey,
    fromSequence: Int,
    with events: [ChatLogStoredEvent],
    generation: Int?,
    hasOlder: Bool,
    olderCursor: Int?
  ) {
    guard ensureOpen() else { return }
    applyGeneration(key, generation)
    flushPending(only: [key])
    guard db != nil else { return }
    transaction("replaceRange") {
      upsertSession(key, generation: generation)
      run(
        "delete from chat_log_events where machine_key = ? and session_id = ? and scope_key = ? and sequence >= ?",
        bind: { stmt in
          self.bindKey(stmt, key)
          sqlite3_bind_int64(stmt, 4, sqlite3_int64(fromSequence))
        }
      )
      insertEvents(key, events)
      run(
        "update chat_log_sessions set has_older = ?, older_cursor = ? where machine_key = ? and session_id = ? and scope_key = ?",
        bind: { stmt in
          sqlite3_bind_int(stmt, 1, hasOlder ? 1 : 0)
          self.bindOptionalInt(stmt, 2, olderCursor)
          self.bindKey(stmt, key, from: 3)
        }
      )
      recomputeAndTrim(key)
      evictForTotalBudget(protecting: [key])
    }
  }

  /// Removes rows older than `sequence` (a gap: never show them out of order).
  func dropBelow(_ key: ChatLogKey, sequence: Int) {
    guard ensureOpen() else { return }
    if var chat = pending[key] {
      for (seq, event) in chat.events where seq < sequence {
        chat.events.removeValue(forKey: seq)
        chat.bytes -= event.payload.count
        pendingBytes -= event.payload.count
      }
      pending[key] = chat
    }
    transaction("dropBelow") {
      run(
        "delete from chat_log_events where machine_key = ? and session_id = ? and scope_key = ? and sequence < ?",
        bind: { stmt in
          self.bindKey(stmt, key)
          sqlite3_bind_int64(stmt, 4, sqlite3_int64(sequence))
        }
      )
      recomputeAndTrim(key)
    }
  }

  /// Edits the stored meta (creating the chat's row if needed). `bytes` and
  /// `eventCount` are derived from the rows and ignored here.
  func updateMeta(_ key: ChatLogKey, _ mutate: @Sendable (inout ChatLogSessionMeta) -> Void) {
    guard ensureOpen() else { return }
    flushPending(only: [key])
    guard db != nil else { return }
    var meta = readMeta(key) ?? ChatLogSessionMeta(lastOpenedAt: Date())
    mutate(&meta)
    transaction("updateMeta") {
      run(
        """
        insert into chat_log_sessions(machine_key, session_id, scope_key, generation, max_sequence, oldest_sequence, has_older, older_cursor, last_opened_at)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
        on conflict(machine_key, session_id, scope_key) do update set
          generation = excluded.generation,
          max_sequence = excluded.max_sequence,
          oldest_sequence = excluded.oldest_sequence,
          has_older = excluded.has_older,
          older_cursor = excluded.older_cursor,
          last_opened_at = excluded.last_opened_at
        """,
        bind: { stmt in
          self.bindKey(stmt, key)
          self.bindOptionalInt(stmt, 4, meta.generation)
          self.bindOptionalInt(stmt, 5, meta.maxSequence)
          self.bindOptionalInt(stmt, 6, meta.oldestSequence)
          sqlite3_bind_int(stmt, 7, meta.hasOlder ? 1 : 0)
          self.bindOptionalInt(stmt, 8, meta.olderCursor)
          sqlite3_bind_double(stmt, 9, meta.lastOpenedAt.timeIntervalSince1970)
        }
      )
    }
  }

  /// Marks the chat as opened now (LRU order for eviction and `recentKeys`).
  func touch(_ key: ChatLogKey) {
    guard ensureOpen() else { return }
    run(
      """
      insert into chat_log_sessions(machine_key, session_id, scope_key, last_opened_at) values (?, ?, ?, ?)
      on conflict(machine_key, session_id, scope_key) do update set last_opened_at = excluded.last_opened_at
      """,
      bind: { stmt in
        self.bindKey(stmt, key)
        sqlite3_bind_double(stmt, 4, Date().timeIntervalSince1970)
      }
    )
  }

  func drop(_ key: ChatLogKey) {
    removePending(key)
    guard ensureOpen() else { return }
    transaction("drop") {
      deleteChat(key)
    }
  }

  /// Forget/unpair: removes every chat cached for that machine.
  func purgeMachine(_ machineKey: String) {
    for key in pending.keys where key.machineKey == machineKey {
      removePending(key)
    }
    guard ensureOpen() else { return }
    transaction("purgeMachine") {
      for table in ["chat_log_events", "chat_log_sessions"] {
        run(
          "delete from \(table) where machine_key = ?",
          bind: { stmt in self.bindText(stmt, 1, machineKey) }
        )
      }
    }
    checkpointTruncate()
  }

  /// Sign-out / account change: deletes the database files outright.
  func purgeAll() {
    flushTask?.cancel()
    flushTask = nil
    pending.removeAll()
    pendingBytes = 0
    closeConnection()
    deleteFiles()
    openRetryAfter = nil
    needsReset = false
  }

  /// Writes buffered events now (call on background transition).
  func flush() {
    flushNow()
  }

  /// Flushes and closes the connection. The next call reopens it.
  func close() {
    flushNow()
    closeConnection()
  }

  // MARK: - Buffering

  private func scheduleFlush() {
    guard flushTask == nil else { return }
    flushTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: Self.flushDelayNanoseconds)
      guard !Task.isCancelled else { return }
      await self?.timerFired()
    }
  }

  private func timerFired() {
    flushTask = nil
    flushPending(only: nil)
  }

  private func flushNow() {
    flushTask?.cancel()
    flushTask = nil
    flushPending(only: nil)
  }

  private func removePending(_ key: ChatLogKey) {
    if let removed = pending.removeValue(forKey: key) {
      pendingBytes -= removed.bytes
    }
  }

  private func flushPending(only keys: Set<ChatLogKey>?) {
    let targets: [(ChatLogKey, PendingChat)]
    if let keys {
      targets = keys.compactMap { key in pending[key].map { (key, $0) } }
    } else {
      targets = Array(pending)
    }
    guard !targets.isEmpty else { return }
    for (key, _) in targets {
      removePending(key)
    }
    guard ensureOpen() else {
      chatLogLog.error("dropping \(targets.count, privacy: .public) buffered chat(s): store unavailable")
      return
    }
    let ok = transaction("flush") {
      for (key, chat) in targets {
        upsertSession(key, generation: chat.generation)
        insertEvents(key, Array(chat.events.values))
        recomputeAndTrim(key)
      }
      evictForTotalBudget(protecting: Set(targets.map { $0.0 }))
    }
    if !ok {
      chatLogLog.error("flush failed; dropped \(targets.count, privacy: .public) buffered chat(s)")
    }
  }

  /// If `generation` differs from the stored one, the chat's rows are
  /// dropped before anything new is stored.
  private func applyGeneration(_ key: ChatLogKey, _ generation: Int?) {
    guard let generation else { return }
    let stored = pending[key]?.generation ?? readMeta(key)?.generation
    guard let stored, stored != generation else { return }
    chatLogLog.info("generation \(stored, privacy: .public) -> \(generation, privacy: .public); dropping cached rows")
    removePending(key)
    transaction("generationReset") {
      run(
        "delete from chat_log_events where machine_key = ? and session_id = ? and scope_key = ?",
        bind: { stmt in self.bindKey(stmt, key) }
      )
      run(
        """
        update chat_log_sessions set generation = ?, max_sequence = null, oldest_sequence = null,
          has_older = 0, older_cursor = null, bytes = 0, event_count = 0
        where machine_key = ? and session_id = ? and scope_key = ?
        """,
        bind: { stmt in
          sqlite3_bind_int64(stmt, 1, sqlite3_int64(generation))
          self.bindKey(stmt, key, from: 2)
        }
      )
    }
  }

  // MARK: - Row helpers (call inside a transaction)

  private func upsertSession(_ key: ChatLogKey, generation: Int?) {
    run(
      """
      insert into chat_log_sessions(machine_key, session_id, scope_key, generation, last_opened_at) values (?, ?, ?, ?, ?)
      on conflict(machine_key, session_id, scope_key) do update set
        generation = coalesce(excluded.generation, chat_log_sessions.generation)
      """,
      bind: { stmt in
        self.bindKey(stmt, key)
        self.bindOptionalInt(stmt, 4, generation)
        sqlite3_bind_double(stmt, 5, Date().timeIntervalSince1970)
      }
    )
  }

  private func insertEvents(_ key: ChatLogKey, _ events: [ChatLogStoredEvent]) {
    for event in events {
      run(
        """
        insert into chat_log_events(machine_key, session_id, scope_key, sequence, timestamp, payload) values (?, ?, ?, ?, ?, ?)
        on conflict(machine_key, session_id, scope_key, sequence) do update set
          timestamp = excluded.timestamp, payload = excluded.payload
        """,
        bind: { stmt in
          self.bindKey(stmt, key)
          sqlite3_bind_int64(stmt, 4, sqlite3_int64(event.sequence))
          self.bindText(stmt, 5, event.timestamp)
          self.bindBlob(stmt, 6, event.payload)
        }
      )
    }
  }

  private struct Aggregate {
    var count = 0
    var bytes = 0
    var oldest: Int?
    var newest: Int?
  }

  private func aggregate(_ key: ChatLogKey) -> Aggregate {
    var result = Aggregate()
    run(
      "select count(*), coalesce(sum(length(payload)), 0), min(sequence), max(sequence) from chat_log_events where machine_key = ? and session_id = ? and scope_key = ?",
      bind: { stmt in self.bindKey(stmt, key) },
      row: { stmt in
        result.count = Int(sqlite3_column_int64(stmt, 0))
        result.bytes = Int(sqlite3_column_int64(stmt, 1))
        result.oldest = self.columnOptionalInt(stmt, 2)
        result.newest = self.columnOptionalInt(stmt, 3)
        return false
      }
    )
    return result
  }

  /// Recomputes derived meta and, over the per-chat budget, deletes the
  /// oldest rows. The newest row is always kept, even if it alone is over.
  private func recomputeAndTrim(_ key: ChatLogKey) {
    var agg = aggregate(key)
    var trimmed = false
    if agg.bytes > perChatByteBudget && agg.count > 1 {
      var remainingBytes = agg.bytes
      var remainingCount = agg.count
      var cutoff: Int?
      run(
        "select sequence, length(payload) from chat_log_events where machine_key = ? and session_id = ? and scope_key = ? order by sequence asc",
        bind: { stmt in self.bindKey(stmt, key) },
        row: { stmt in
          guard remainingBytes > self.perChatByteBudget, remainingCount > 1 else { return false }
          cutoff = Int(sqlite3_column_int64(stmt, 0))
          remainingBytes -= Int(sqlite3_column_int64(stmt, 1))
          remainingCount -= 1
          return true
        }
      )
      if let cutoff {
        run(
          "delete from chat_log_events where machine_key = ? and session_id = ? and scope_key = ? and sequence <= ?",
          bind: { stmt in
            self.bindKey(stmt, key)
            sqlite3_bind_int64(stmt, 4, sqlite3_int64(cutoff))
          }
        )
        trimmed = true
        agg = aggregate(key)
      }
    }
    run(
      """
      update chat_log_sessions set bytes = ?, event_count = ?, oldest_sequence = ?, max_sequence = ?,
        has_older = case when ? then 1 else has_older end,
        older_cursor = case when ? then null else older_cursor end
      where machine_key = ? and session_id = ? and scope_key = ?
      """,
      bind: { stmt in
        sqlite3_bind_int64(stmt, 1, sqlite3_int64(agg.bytes))
        sqlite3_bind_int64(stmt, 2, sqlite3_int64(agg.count))
        self.bindOptionalInt(stmt, 3, agg.oldest)
        self.bindOptionalInt(stmt, 4, agg.newest)
        sqlite3_bind_int(stmt, 5, trimmed ? 1 : 0)
        // A trim invalidates the host's byte cursor: it pointed below rows that
        // are gone now. Older history is then paged by sequence
        // (`chat_history.beforeSequence`, the oldest cached sequence).
        sqlite3_bind_int(stmt, 6, trimmed ? 1 : 0)
        self.bindKey(stmt, key, from: 7)
      }
    )
  }

  /// Evicts whole chats, least recently opened first, until the total is
  /// within budget. Chats just written are never evicted here.
  private func evictForTotalBudget(protecting protected: Set<ChatLogKey>) {
    var total = 0
    run(
      "select coalesce(sum(bytes), 0) from chat_log_sessions",
      row: { stmt in
        total = Int(sqlite3_column_int64(stmt, 0))
        return false
      }
    )
    guard total > totalByteBudget else { return }
    var victims: [ChatLogKey] = []
    run(
      "select machine_key, session_id, scope_key, bytes from chat_log_sessions order by last_opened_at asc",
      row: { stmt in
        guard total > self.totalByteBudget else { return false }
        let key = ChatLogKey(
          machineKey: self.columnText(stmt, 0),
          sessionId: self.columnText(stmt, 1),
          scopeKey: self.columnText(stmt, 2)
        )
        if protected.contains(key) { return true }
        victims.append(key)
        total -= Int(sqlite3_column_int64(stmt, 3))
        return true
      }
    )
    for key in victims {
      removePending(key)
      deleteChat(key)
    }
    if !victims.isEmpty {
      chatLogLog.info("evicted \(victims.count, privacy: .public) chat(s) for total budget")
    }
  }

  private func deleteChat(_ key: ChatLogKey) {
    for table in ["chat_log_events", "chat_log_sessions"] {
      run(
        "delete from \(table) where machine_key = ? and session_id = ? and scope_key = ?",
        bind: { stmt in self.bindKey(stmt, key) }
      )
    }
  }

  private func readMeta(_ key: ChatLogKey) -> ChatLogSessionMeta? {
    guard db != nil else { return nil }
    var meta: ChatLogSessionMeta?
    run(
      """
      select generation, max_sequence, oldest_sequence, has_older, older_cursor, bytes, event_count, last_opened_at
      from chat_log_sessions where machine_key = ? and session_id = ? and scope_key = ?
      """,
      bind: { stmt in self.bindKey(stmt, key) },
      row: { stmt in
        meta = ChatLogSessionMeta(
          generation: self.columnOptionalInt(stmt, 0),
          maxSequence: self.columnOptionalInt(stmt, 1),
          oldestSequence: self.columnOptionalInt(stmt, 2),
          hasOlder: sqlite3_column_int(stmt, 3) != 0,
          olderCursor: self.columnOptionalInt(stmt, 4),
          bytes: Int(sqlite3_column_int64(stmt, 5)),
          eventCount: Int(sqlite3_column_int64(stmt, 6)),
          lastOpenedAt: Date(timeIntervalSince1970: sqlite3_column_double(stmt, 7))
        )
        return false
      }
    )
    return meta
  }

  /// Stored meta with the write buffer folded in. `bytes`/`eventCount` may
  /// double-count a buffered event that replaces a stored one until flush.
  private func mergedMeta(_ key: ChatLogKey, stored: ChatLogSessionMeta?) -> ChatLogSessionMeta? {
    guard let buffered = pending[key] else { return stored }
    var meta = stored ?? ChatLogSessionMeta(lastOpenedAt: Date())
    if let generation = buffered.generation { meta.generation = generation }
    if let newest = buffered.events.keys.max() {
      meta.maxSequence = max(meta.maxSequence ?? newest, newest)
    }
    if let oldest = buffered.events.keys.min() {
      meta.oldestSequence = min(meta.oldestSequence ?? oldest, oldest)
    }
    meta.bytes += buffered.bytes
    meta.eventCount += buffered.events.count
    return meta
  }

  // MARK: - Connection

  private func ensureOpen() -> Bool {
    if needsReset {
      needsReset = false
      chatLogLog.error("resetting chat log store after a corruption error")
      closeConnection()
      deleteFiles()
    }
    if db != nil { return true }
    if let retryAfter = openRetryAfter, Date() < retryAfter { return false }
    if openDatabase() {
      openRetryAfter = nil
      needsReset = false
      return true
    }
    chatLogLog.error("open failed; deleting chat log files and recreating")
    closeConnection()
    deleteFiles()
    if openDatabase() {
      openRetryAfter = nil
      needsReset = false
      return true
    }
    closeConnection()
    openRetryAfter = Date().addingTimeInterval(30)
    chatLogLog.error("chat log store unavailable; retrying in 30 s")
    return false
  }

  private func openDatabase() -> Bool {
    do {
      try FileManager.default.createDirectory(at: directoryURL, withIntermediateDirectories: true)
    } catch {
      chatLogLog.error("create directory failed: \(error.localizedDescription, privacy: .public)")
      return false
    }
    var handle: OpaquePointer?
    let baseFlags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_NOMUTEX
    var rc = sqlite3_open_v2(
      databaseURL.path,
      &handle,
      baseFlags | SQLITE_OPEN_FILEPROTECTION_COMPLETEUNTILFIRSTUSERAUTHENTICATION,
      nil
    )
    if rc != SQLITE_OK {
      // Some file systems (e.g. the simulator host) may reject the protection
      // class; `applyFileAttributes` still sets it on the files afterwards.
      if let failed = handle { sqlite3_close(failed) }
      handle = nil
      rc = sqlite3_open_v2(databaseURL.path, &handle, baseFlags, nil)
    }
    guard rc == SQLITE_OK, let handle else {
      chatLogLog.error("sqlite3_open_v2 failed: \(rc, privacy: .public)")
      if let handle { sqlite3_close(handle) }
      return false
    }
    db = handle
    sqlite3_busy_timeout(handle, 2_000)

    var version: Int32 = -1
    let versionOK = run("pragma user_version", row: { stmt in
      version = sqlite3_column_int(stmt, 0)
      return false
    })
    guard versionOK, version >= 0 else { return false }
    if version != 0 && version != Self.schemaVersion {
      chatLogLog.info("schema version \(version, privacy: .public) != \(Self.schemaVersion, privacy: .public); recreating")
      return false
    }

    guard exec("pragma journal_mode = wal"),
          exec("pragma synchronous = normal") else { return false }

    if version == 0 {
      let schema = """
      create table if not exists chat_log_sessions (
        machine_key text not null,
        session_id text not null,
        scope_key text not null,
        generation integer,
        max_sequence integer,
        oldest_sequence integer,
        has_older integer not null default 0,
        older_cursor integer,
        bytes integer not null default 0,
        event_count integer not null default 0,
        last_opened_at real not null,
        primary key (machine_key, session_id, scope_key)
      );
      create index if not exists chat_log_sessions_lru on chat_log_sessions(last_opened_at);
      create table if not exists chat_log_events (
        machine_key text not null,
        session_id text not null,
        scope_key text not null,
        sequence integer not null,
        timestamp text not null,
        dedupe_key text,
        payload blob not null
      );
      create unique index if not exists chat_log_events_key on chat_log_events(machine_key, session_id, scope_key, sequence);
      pragma user_version = \(Self.schemaVersion);
      """
      guard exec("begin immediate") else { return false }
      guard exec(schema), exec("commit") else {
        exec("rollback")
        return false
      }
    }
    applyFileAttributes()
    return true
  }

  private func closeConnection() {
    for statement in statements.values {
      sqlite3_finalize(statement)
    }
    statements.removeAll()
    if let db {
      sqlite3_close(db)
    }
    db = nil
    inTransaction = false
  }

  private func deleteFiles() {
    let fileManager = FileManager.default
    for suffix in ["", "-wal", "-shm", "-journal"] {
      let path = databaseURL.path + suffix
      guard fileManager.fileExists(atPath: path) else { continue }
      do {
        try fileManager.removeItem(atPath: path)
      } catch {
        chatLogLog.error("delete \(suffix, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
      }
    }
  }

  private func applyFileAttributes() {
    let fileManager = FileManager.default
    for suffix in ["", "-wal", "-shm"] {
      let path = databaseURL.path + suffix
      guard fileManager.fileExists(atPath: path) else { continue }
      do {
        try fileManager.setAttributes(
          [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
          ofItemAtPath: path
        )
        var url = URL(fileURLWithPath: path)
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try url.setResourceValues(values)
      } catch {
        chatLogLog.error("file attributes \(suffix, privacy: .public) failed: \(error.localizedDescription, privacy: .public)")
      }
    }
  }

  private func checkpointTruncate() {
    exec("pragma wal_checkpoint(truncate)")
  }

  // MARK: - SQLite helpers

  @discardableResult
  private func transaction(_ label: String, _ body: () -> Void) -> Bool {
    guard db != nil else { return false }
    if inTransaction {
      body()
      return !statementFailed
    }
    statementFailed = false
    guard exec("begin immediate") else { return false }
    inTransaction = true
    body()
    inTransaction = false
    if !statementFailed, exec("commit") {
      return true
    }
    chatLogLog.error("\(label, privacy: .public) rolled back")
    exec("rollback")
    statementFailed = false
    return false
  }

  @discardableResult
  private func exec(_ sql: String) -> Bool {
    guard let db else { return false }
    var errMsg: UnsafeMutablePointer<CChar>?
    let rc = sqlite3_exec(db, sql, nil, nil, &errMsg)
    if rc != SQLITE_OK {
      let message = errMsg.map { String(cString: $0) } ?? "unknown"
      if let errMsg { sqlite3_free(errMsg) }
      noteFailure(rc, "exec: \(message)")
      return false
    }
    return true
  }

  /// Runs one cached prepared statement. `row` returns false to stop early.
  @discardableResult
  private func run(
    _ sql: String,
    bind: (OpaquePointer) -> Void = { _ in },
    row: ((OpaquePointer) -> Bool)? = nil
  ) -> Bool {
    guard let stmt = prepared(sql) else { return false }
    defer {
      sqlite3_reset(stmt)
      sqlite3_clear_bindings(stmt)
    }
    bind(stmt)
    while true {
      let rc = sqlite3_step(stmt)
      if rc == SQLITE_ROW {
        if let row, row(stmt) { continue }
        if row == nil { continue }
        return true
      }
      if rc == SQLITE_DONE { return true }
      noteFailure(rc, "step")
      return false
    }
  }

  private func prepared(_ sql: String) -> OpaquePointer? {
    if let cached = statements[sql] { return cached }
    guard let db else { return nil }
    var stmt: OpaquePointer?
    let rc = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
    guard rc == SQLITE_OK, let stmt else {
      if let stmt { sqlite3_finalize(stmt) }
      noteFailure(rc, "prepare")
      return nil
    }
    statements[sql] = stmt
    return stmt
  }

  private func noteFailure(_ rc: Int32, _ context: String) {
    statementFailed = true
    let message = db.map { String(cString: sqlite3_errmsg($0)) } ?? "no connection"
    chatLogLog.error("\(context, privacy: .public) failed (\(rc, privacy: .public)): \(message, privacy: .public)")
    let primary = rc & 0xff
    if primary == SQLITE_CORRUPT || primary == SQLITE_NOTADB {
      needsReset = true
    }
  }

  private func bindKey(_ stmt: OpaquePointer, _ key: ChatLogKey, from index: Int32 = 1) {
    bindText(stmt, index, key.machineKey)
    bindText(stmt, index + 1, key.sessionId)
    bindText(stmt, index + 2, key.scopeKey)
  }

  private func bindText(_ stmt: OpaquePointer, _ index: Int32, _ value: String) {
    sqlite3_bind_text(stmt, index, value, -1, chatLogSQLiteTransient)
  }

  private func bindOptionalInt(_ stmt: OpaquePointer, _ index: Int32, _ value: Int?) {
    if let value {
      sqlite3_bind_int64(stmt, index, sqlite3_int64(value))
    } else {
      sqlite3_bind_null(stmt, index)
    }
  }

  private func bindBlob(_ stmt: OpaquePointer, _ index: Int32, _ data: Data) {
    if data.isEmpty {
      sqlite3_bind_zeroblob(stmt, index, 0)
      return
    }
    data.withUnsafeBytes { buffer in
      _ = sqlite3_bind_blob(stmt, index, buffer.baseAddress, Int32(buffer.count), chatLogSQLiteTransient)
    }
  }

  private func columnText(_ stmt: OpaquePointer, _ index: Int32) -> String {
    guard let text = sqlite3_column_text(stmt, index) else { return "" }
    return String(cString: text)
  }

  private func columnOptionalInt(_ stmt: OpaquePointer, _ index: Int32) -> Int? {
    sqlite3_column_type(stmt, index) == SQLITE_NULL ? nil : Int(sqlite3_column_int64(stmt, index))
  }

  private func readEvent(_ stmt: OpaquePointer) -> ChatLogStoredEvent {
    let count = Int(sqlite3_column_bytes(stmt, 2))
    let payload: Data
    if count > 0, let bytes = sqlite3_column_blob(stmt, 2) {
      payload = Data(bytes: bytes, count: count)
    } else {
      payload = Data()
    }
    return ChatLogStoredEvent(
      sequence: Int(sqlite3_column_int64(stmt, 0)),
      timestamp: columnText(stmt, 1),
      payload: payload
    )
  }
}
