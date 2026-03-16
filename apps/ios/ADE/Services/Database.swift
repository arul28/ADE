import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
private let crsqliteUnsupportedMessage = """
The vendored crsqlite.xcframework is not currently embeddable on iOS in the way ADE needs. \
Direct sqlite3_crsqlite_init(db, &err, nil) crashes because the SQLite API thunk is nil, \
sqlite3_auto_extension(...) is deprecated and rejected on Apple platforms, and the iOS SQLite SDK \
does not expose sqlite3_load_extension(...) as a usable fallback. Replace this xcframework with an \
iOS-safe embeddable crsqlite build, or add a native wrapper library that links crsqlite against SQLite.
"""

extension Notification.Name {
  static let adeDatabaseDidChange = Notification.Name("ADE.DatabaseDidChange")
}

final class DatabaseService {
  private struct LaneRow {
    let id: String
    let name: String
    let description: String?
    let laneType: String
    let baseRef: String
    let branchRef: String
    let worktreePath: String
    let parentLaneId: String?
    let createdAt: String
    let archivedAt: String?
    let dirty: Bool
    let ahead: Int
    let behind: Int
    let remoteBehind: Int
    let rebaseInProgress: Bool
  }

  private struct SessionRow {
    let id: String
    let laneId: String
    let laneName: String
    let ptyId: String?
    let tracked: Bool
    let pinned: Bool
    let goal: String?
    let toolType: String?
    let title: String
    let status: String
    let startedAt: String
    let endedAt: String?
    let exitCode: Int?
    let transcriptPath: String
    let headShaStart: String?
    let headShaEnd: String?
    let lastOutputPreview: String?
    let summary: String?
    let resumeCommand: String?
  }

  private struct PullRequestSnapshotRow {
    let detailJson: String?
    let statusJson: String?
    let checksJson: String?
    let reviewsJson: String?
    let commentsJson: String?
    let filesJson: String?
  }

  private var db: OpaquePointer?
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  private let fileManager: FileManager
  private let appURL: URL
  private let dbURL: URL
  private let siteIdURL: URL
  private let bootstrapSQLOverride: String?
  private(set) var initializationError: NSError?

  var isReady: Bool {
    initializationError == nil && db != nil
  }

  init(baseURL: URL? = nil, bootstrapSQL: String? = nil, fileManager: FileManager = .default) {
    self.fileManager = fileManager
    let resolvedBaseURL = baseURL ?? fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
    appURL = resolvedBaseURL.appendingPathComponent("ADE", isDirectory: true)
    dbURL = appURL.appendingPathComponent("ade.db")
    siteIdURL = appURL.appendingPathComponent("secrets", isDirectory: true).appendingPathComponent("sync-site-id")
    bootstrapSQLOverride = bootstrapSQL

    do {
      try fileManager.createDirectory(at: appURL, withIntermediateDirectories: true)
      try resetLegacyCacheDatabaseIfNeeded()
      try resetDisposableDatabaseIfNeeded(at: dbURL)
      try openConnection(at: dbURL)
      try migrateAndPrepare()
    } catch {
      close()
      initializationError = error as NSError
    }
  }

  deinit {
    close()
  }

  func close() {
    if let db {
      sqlite3_close(db)
      self.db = nil
    }
  }

  func localSiteId() -> String {
    if let cached = try? String(contentsOf: siteIdURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
       cached.range(of: "^[0-9a-f]{32}$", options: .regularExpression) != nil {
      return cached
    }
    let fresh = Data((0..<16).map { _ in UInt8.random(in: .min ... .max) }).map { String(format: "%02x", $0) }.joined()
    try? fileManager.createDirectory(at: siteIdURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    try? fresh.write(to: siteIdURL, atomically: true, encoding: .utf8)
    return fresh
  }

  func currentDbVersion() -> Int {
    Int(queryInt64("select crsql_db_version()") ?? 0)
  }

  func exportChangesSince(version: Int) -> [CrsqlChangeRow] {
    guard let db else { return [] }
    let sql = """
      select [table], pk, cid, val, col_version, db_version, site_id, cl, seq
        from crsql_changes
       where db_version > ?
       order by db_version asc, cl asc, seq asc
    """
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else { return [] }
    defer { sqlite3_finalize(statement) }
    sqlite3_bind_int64(statement, 1, sqlite3_int64(version))

    var rows: [CrsqlChangeRow] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      rows.append(
        CrsqlChangeRow(
          table: stringValue(statement, index: 0) ?? "",
          pk: scalarValue(statement, index: 1),
          cid: stringValue(statement, index: 2) ?? "",
          val: scalarValue(statement, index: 3),
          colVersion: Int(sqlite3_column_int64(statement, 4)),
          dbVersion: Int(sqlite3_column_int64(statement, 5)),
          siteId: blobHexValue(statement, index: 6) ?? "",
          cl: Int(sqlite3_column_int64(statement, 7)),
          seq: Int(sqlite3_column_int64(statement, 8)),
        )
      )
    }
    return rows
  }

  func applyChanges(_ changes: [CrsqlChangeRow]) throws -> ApplyRemoteChangesResult {
    guard db != nil else {
      return ApplyRemoteChangesResult(appliedCount: 0, dbVersion: 0, touchedTables: [], rebuiltFts: false)
    }
    var appliedCount = 0
    var touchedTables = Set<String>()
    try exec("begin")
    do {
      let sql = """
        insert or ignore into crsql_changes ([table], pk, cid, val, col_version, db_version, site_id, cl, seq)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      """
      for change in changes {
        let changed = try execute(sql) { statement in
          try bindText(change.table, to: statement, index: 1)
          try bindScalar(change.pk, to: statement, index: 2)
          try bindText(change.cid, to: statement, index: 3)
          try bindScalar(change.val, to: statement, index: 4)
          sqlite3_bind_int64(statement, 5, sqlite3_int64(change.colVersion))
          sqlite3_bind_int64(statement, 6, sqlite3_int64(change.dbVersion))
          try bindHexBlob(change.siteId, to: statement, index: 7)
          sqlite3_bind_int64(statement, 8, sqlite3_int64(change.cl))
          sqlite3_bind_int64(statement, 9, sqlite3_int64(change.seq))
        }
        appliedCount += changed
        touchedTables.insert(change.table)
      }
      try exec("commit")
    } catch {
      try? exec("rollback")
      throw error
    }

    var rebuiltFts = false
    if touchedTables.contains("unified_memories") {
      try rebuildUnifiedMemoriesFts()
      rebuiltFts = true
    }

    if appliedCount > 0 {
      notifyDidChange()
    }

    return ApplyRemoteChangesResult(
      appliedCount: appliedCount,
      dbVersion: currentDbVersion(),
      touchedTables: touchedTables.sorted(),
      rebuiltFts: rebuiltFts,
    )
  }

  func fetchLanes(includeArchived: Bool) -> [LaneSummary] {
    let sql = """
      select l.id, l.name, l.description, l.lane_type, l.base_ref, l.branch_ref, l.worktree_path,
             l.parent_lane_id, l.created_at, l.archived_at,
             coalesce(s.dirty, 0) as dirty,
             coalesce(s.ahead, 0) as ahead,
             coalesce(s.behind, 0) as behind,
             coalesce(s.remote_behind, -1) as remote_behind,
             coalesce(s.rebase_in_progress, 0) as rebase_in_progress
        from lanes l
        left join lane_state_snapshots s on s.lane_id = l.id
       where (? = 1 or l.archived_at is null)
       order by l.created_at asc
    """
    let rows = query(sql, bind: { statement in
      sqlite3_bind_int(statement, 1, includeArchived ? 1 : 0)
    }) { statement in
      LaneRow(
        id: stringValue(statement, index: 0) ?? "",
        name: stringValue(statement, index: 1) ?? "",
        description: stringValue(statement, index: 2),
        laneType: stringValue(statement, index: 3) ?? "worktree",
        baseRef: stringValue(statement, index: 4) ?? "",
        branchRef: stringValue(statement, index: 5) ?? "",
        worktreePath: stringValue(statement, index: 6) ?? "",
        parentLaneId: stringValue(statement, index: 7),
        createdAt: stringValue(statement, index: 8) ?? "",
        archivedAt: stringValue(statement, index: 9),
        dirty: sqlite3_column_int(statement, 10) == 1,
        ahead: Int(sqlite3_column_int64(statement, 11)),
        behind: Int(sqlite3_column_int64(statement, 12)),
        remoteBehind: Int(sqlite3_column_int64(statement, 13)),
        rebaseInProgress: sqlite3_column_int(statement, 14) == 1
      )
    }

    let rowsById = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })
    let childCounts = rows.reduce(into: [String: Int]()) { partial, row in
      guard let parent = row.parentLaneId, row.archivedAt == nil else { return }
      partial[parent, default: 0] += 1
    }

    func stackDepth(for laneId: String, visited: inout Set<String>) -> Int {
      guard !visited.contains(laneId), let row = rowsById[laneId], let parent = row.parentLaneId else { return 0 }
      visited.insert(laneId)
      defer { visited.remove(laneId) }
      return 1 + stackDepth(for: parent, visited: &visited)
    }

    return rows
      .filter { includeArchived || $0.archivedAt == nil }
      .map { row in
        var visited = Set<String>()
        return LaneSummary(
          id: row.id,
          name: row.name,
          description: row.description,
          laneType: row.laneType,
          baseRef: row.baseRef,
          branchRef: row.branchRef,
          worktreePath: row.worktreePath,
          parentLaneId: row.parentLaneId,
          childCount: childCounts[row.id, default: 0],
          stackDepth: stackDepth(for: row.id, visited: &visited),
          status: LaneStatus(
            dirty: row.dirty,
            ahead: row.ahead,
            behind: row.behind,
            remoteBehind: row.remoteBehind,
            rebaseInProgress: row.rebaseInProgress
          ),
          createdAt: row.createdAt,
          archivedAt: row.archivedAt
        )
      }
  }

  func listWorkspaces() -> [FilesWorkspace] {
    fetchLanes(includeArchived: false).map { lane in
      FilesWorkspace(
        id: lane.id,
        kind: lane.laneType,
        laneId: lane.id,
        name: lane.name,
        rootPath: lane.worktreePath,
        isReadOnlyByDefault: false
      )
    }
  }

  func fetchSessions() -> [TerminalSessionSummary] {
    let sql = """
      select s.id, s.lane_id, l.name, s.pty_id, s.tracked, s.pinned, s.goal, s.tool_type,
             s.title, s.status, s.started_at, s.ended_at, s.exit_code, s.transcript_path,
             s.head_sha_start, s.head_sha_end, s.last_output_preview, s.summary, s.resume_command
        from terminal_sessions s
        join lanes l on l.id = s.lane_id
       order by s.started_at desc
       limit 200
    """

    return query(sql) { statement in
      SessionRow(
        id: stringValue(statement, index: 0) ?? "",
        laneId: stringValue(statement, index: 1) ?? "",
        laneName: stringValue(statement, index: 2) ?? "",
        ptyId: stringValue(statement, index: 3),
        tracked: sqlite3_column_int(statement, 4) == 1,
        pinned: sqlite3_column_int(statement, 5) == 1,
        goal: stringValue(statement, index: 6),
        toolType: stringValue(statement, index: 7),
        title: stringValue(statement, index: 8) ?? "",
        status: stringValue(statement, index: 9) ?? "unknown",
        startedAt: stringValue(statement, index: 10) ?? "",
        endedAt: stringValue(statement, index: 11),
        exitCode: columnIsNull(statement, index: 12) ? nil : Int(sqlite3_column_int64(statement, 12)),
        transcriptPath: stringValue(statement, index: 13) ?? "",
        headShaStart: stringValue(statement, index: 14),
        headShaEnd: stringValue(statement, index: 15),
        lastOutputPreview: stringValue(statement, index: 16),
        summary: stringValue(statement, index: 17),
        resumeCommand: stringValue(statement, index: 18)
      )
    }.map { row in
      TerminalSessionSummary(
        id: row.id,
        laneId: row.laneId,
        laneName: row.laneName,
        ptyId: row.ptyId,
        tracked: row.tracked,
        pinned: row.pinned,
        goal: row.goal,
        toolType: row.toolType,
        title: row.title,
        status: row.status,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        exitCode: row.exitCode,
        transcriptPath: row.transcriptPath,
        headShaStart: row.headShaStart,
        headShaEnd: row.headShaEnd,
        lastOutputPreview: row.lastOutputPreview,
        summary: row.summary,
        runtimeState: runtimeState(for: row.status),
        resumeCommand: row.resumeCommand
      )
    }
  }

  func fetchPullRequests() -> [PrSummary] {
    let sql = """
      select id, lane_id, project_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
             title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
             last_synced_at, created_at, updated_at
        from pull_requests
       order by updated_at desc
    """
    return query(sql) { statement in
      PrSummary(
        id: stringValue(statement, index: 0) ?? "",
        laneId: stringValue(statement, index: 1) ?? "",
        projectId: stringValue(statement, index: 2) ?? "",
        repoOwner: stringValue(statement, index: 3) ?? "",
        repoName: stringValue(statement, index: 4) ?? "",
        githubPrNumber: Int(sqlite3_column_int64(statement, 5)),
        githubUrl: stringValue(statement, index: 6) ?? "",
        githubNodeId: stringValue(statement, index: 7),
        title: stringValue(statement, index: 8) ?? "",
        state: stringValue(statement, index: 9) ?? "open",
        baseBranch: stringValue(statement, index: 10) ?? "",
        headBranch: stringValue(statement, index: 11) ?? "",
        checksStatus: stringValue(statement, index: 12) ?? "none",
        reviewStatus: stringValue(statement, index: 13) ?? "none",
        additions: Int(sqlite3_column_int64(statement, 14)),
        deletions: Int(sqlite3_column_int64(statement, 15)),
        lastSyncedAt: stringValue(statement, index: 16),
        createdAt: stringValue(statement, index: 17) ?? "",
        updatedAt: stringValue(statement, index: 18) ?? ""
      )
    }
  }

  func fetchPullRequestSnapshot(prId: String) -> PullRequestSnapshot? {
    let sql = """
      select detail_json, status_json, checks_json, reviews_json, comments_json, files_json
        from pull_request_snapshots
       where pr_id = ?
       limit 1
    """
    guard let row = querySingle(sql, bind: { [self] statement in
      try self.bindText(prId, to: statement, index: 1)
    }, map: { statement in
      PullRequestSnapshotRow(
        detailJson: stringValue(statement, index: 0),
        statusJson: stringValue(statement, index: 1),
        checksJson: stringValue(statement, index: 2),
        reviewsJson: stringValue(statement, index: 3),
        commentsJson: stringValue(statement, index: 4),
        filesJson: stringValue(statement, index: 5)
      )
    }) else {
      return nil
    }

    return PullRequestSnapshot(
      detail: decodeJson(row.detailJson, as: PrDetail.self),
      status: decodeJson(row.statusJson, as: PrStatus.self),
      checks: decodeJson(row.checksJson, as: [PrCheck].self) ?? [],
      reviews: decodeJson(row.reviewsJson, as: [PrReview].self) ?? [],
      comments: decodeJson(row.commentsJson, as: [PrComment].self) ?? [],
      files: decodeJson(row.filesJson, as: [PrFile].self) ?? []
    )
  }

  func executeSqlForTesting(_ sql: String) throws {
    try exec(sql)
    notifyDidChange()
  }

  private func migrateAndPrepare() throws {
    try exec("pragma journal_mode = wal")
    try exec("pragma synchronous = normal")
    try exec("pragma busy_timeout = 5000")

    let bootstrapSQL = try loadBootstrapSQL()
    try executeBootstrapSQL(bootstrapSQL)
    try ensureCrrTables()

    let desiredSiteId = localSiteId()
    try forceSiteId(desiredSiteId)
    if readCurrentSiteId() != desiredSiteId {
      close()
      try openConnection(at: dbURL)
      try exec("pragma journal_mode = wal")
      try exec("pragma synchronous = normal")
      try exec("pragma busy_timeout = 5000")
      try forceSiteId(desiredSiteId)
    }
  }

  private func openConnection(at url: URL) throws {
    throw sqliteError(crsqliteUnsupportedMessage)
  }

  private func loadBootstrapSQL() throws -> String {
    if let bootstrapSQLOverride {
      return bootstrapSQLOverride
    }
    let bundles = [Bundle.main, Bundle(for: DatabaseService.self)]
    for bundle in bundles {
      if let url = bundle.url(forResource: "DatabaseBootstrap", withExtension: "sql"),
         let sql = try? String(contentsOf: url, encoding: .utf8),
         !sql.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
        return sql
      }
    }
    throw sqliteError("Database bootstrap SQL resource is missing.")
  }

  private func executeBootstrapSQL(_ sql: String) throws {
    for rawStatement in sql.split(separator: ";") {
      let trimmed = rawStatement.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { continue }
      let statement = "\(trimmed);"
      do {
        try runMigratingStatement(statement)
      } catch {
        throw error
      }
    }
  }

  private func runMigratingStatement(_ sql: String) throws {
    do {
      try run(sql)
    } catch {
      let lowered = sql.lowercased()
      let message = (error as NSError).localizedDescription.lowercased()
      if lowered.contains("create virtual table if not exists unified_memories_fts"),
         message.contains("no such module: fts") {
        try run("""
          create table if not exists unified_memories_fts (
            rowid integer primary key,
            content text not null
          )
        """)
        return
      }
      if lowered.hasPrefix("alter table"), message.contains("duplicate column name") {
        return
      }
      throw error
    }
  }

  private func ensureCrrTables() throws {
    for tableName in listEligibleCrrTables() {
      if hasTable(named: "\(tableName)__crsql_clock") {
        continue
      }
      _ = queryInt64("select crsql_as_crr(?)", bind: { [self] statement in
        try self.bindText(tableName, to: statement, index: 1)
      })
    }
  }

  private func listEligibleCrrTables() -> [String] {
    let sql = """
      select name, sql
        from sqlite_master
       where type = 'table'
         and sql is not null
         and name not like 'sqlite_%'
         and name not like 'crsql_%'
         and name not like '%__crsql_clock'
         and name not like '%__crsql_pks'
         and name not like 'unified_memories_fts%'
    """
    return query(sql) { statement in
      (
        name: stringValue(statement, index: 0) ?? "",
        sql: stringValue(statement, index: 1) ?? ""
      )
    }.filter { row in
      !row.sql.lowercased().hasPrefix("create virtual table") && tableHasPrimaryKey(row.name)
    }.map(\.name)
  }

  private func tableHasPrimaryKey(_ tableName: String) -> Bool {
    query("pragma table_info('\(tableName.replacingOccurrences(of: "'", with: "''"))')") { statement in
      sqlite3_column_int(statement, 5) > 0
    }.contains(true)
  }

  private func forceSiteId(_ siteId: String) throws {
    guard hasTable(named: "crsql_site_id") else { return }
    let sql = """
      insert into crsql_site_id(site_id, ordinal) values (?, 0)
      on conflict(ordinal) do update set site_id = excluded.site_id
    """
    _ = try execute(sql) { statement in
      try bindHexBlob(siteId, to: statement, index: 1)
    }
  }

  private func readCurrentSiteId() -> String? {
    queryString("select lower(hex(crsql_site_id()))")
  }

  private func rebuildUnifiedMemoriesFts() throws {
    guard hasTable(named: "unified_memories"), hasTable(named: "unified_memories_fts") else { return }
    do {
      try exec("insert into unified_memories_fts(unified_memories_fts) values ('rebuild')")
    } catch {
      try exec("delete from unified_memories_fts")
      try exec("insert into unified_memories_fts(rowid, content) select rowid, content from unified_memories")
    }
  }

  private func resetLegacyCacheDatabaseIfNeeded() throws {
    let legacyURL = appURL.appendingPathComponent("ade-ios-local.sqlite")
    guard fileManager.fileExists(atPath: legacyURL.path) else { return }
    let backupURL = appURL.appendingPathComponent("ade-ios-local.sqlite.phase6-backup")
    if !fileManager.fileExists(atPath: backupURL.path) {
      try? fileManager.copyItem(at: legacyURL, to: backupURL)
    }
    try? fileManager.removeItem(at: legacyURL)
    try? fileManager.removeItem(at: URL(fileURLWithPath: "\(legacyURL.path)-shm"))
    try? fileManager.removeItem(at: URL(fileURLWithPath: "\(legacyURL.path)-wal"))
  }

  private func resetDisposableDatabaseIfNeeded(at url: URL) throws {
    guard fileManager.fileExists(atPath: url.path) else { return }
    var scratch: OpaquePointer?
    guard sqlite3_open_v2(url.path, &scratch, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK else {
      sqlite3_close(scratch)
      return
    }
    defer {
      if let scratch {
        sqlite3_close(scratch)
      }
    }

    let tableNames = query(with: scratch, "select name from sqlite_master where type = 'table'") { statement in
      stringValue(statement, index: 0) ?? ""
    }
    let hasCrrMetadata = tableNames.contains(where: { $0 == "crsql_master" || $0 == "crsql_site_id" || $0.hasSuffix("__crsql_clock") })
    let isLegacyCacheOnly = Set(tableNames).isSubset(of: ["cached_json", "sync_metadata", "sqlite_sequence"])
    guard isLegacyCacheOnly || !hasCrrMetadata else { return }

    let backupURL = url.appendingPathExtension("phase6-backup")
    if !fileManager.fileExists(atPath: backupURL.path) {
      try? fileManager.copyItem(at: url, to: backupURL)
    }
    sqlite3_close(scratch)
    scratch = nil
    try? fileManager.removeItem(at: url)
    try? fileManager.removeItem(at: URL(fileURLWithPath: "\(url.path)-shm"))
    try? fileManager.removeItem(at: URL(fileURLWithPath: "\(url.path)-wal"))
  }

  private func runtimeState(for status: String) -> String {
    switch status {
    case "running":
      return "running"
    case "disposed":
      return "killed"
    default:
      return "exited"
    }
  }

  private func hasTable(named tableName: String) -> Bool {
    querySingle(
      "select 1 from sqlite_master where type = 'table' and name = ? limit 1",
      bind: { [self] statement in
        try self.bindText(tableName, to: statement, index: 1)
      },
      map: { _ in true }
    ) ?? false
  }

  private func notifyDidChange() {
    NotificationCenter.default.post(name: .adeDatabaseDidChange, object: nil)
  }

  private func decodeJson<T: Decodable>(_ raw: String?, as type: T.Type) -> T? {
    guard let raw, let data = raw.data(using: .utf8) else { return nil }
    return try? decoder.decode(T.self, from: data)
  }

  private func run(_ sql: String) throws {
    guard let db else { throw sqliteError("Database is not open.") }
    var errMsg: UnsafeMutablePointer<Int8>?
    if sqlite3_exec(db, sql, nil, nil, &errMsg) != SQLITE_OK {
      let message = errMsg.map { String(cString: $0) } ?? "SQLite exec failed."
      if let errMsg {
        sqlite3_free(errMsg)
      }
      throw sqliteError(message)
    }
  }

  private func exec(_ sql: String) throws {
    let alterTable = parseAlterTableTarget(sql)
    if let alterTable, hasTable(named: "\(alterTable)__crsql_clock") {
      _ = queryInt64("select crsql_begin_alter(?)", bind: { [self] statement in
        try self.bindText(alterTable, to: statement, index: 1)
      })
      do {
        try run(sql)
      } catch {
        throw error
      }
      _ = queryInt64("select crsql_commit_alter(?)", bind: { [self] statement in
        try self.bindText(alterTable, to: statement, index: 1)
      })
      return
    }
    try run(sql)
  }

  private func execute(_ sql: String, bind: (OpaquePointer) throws -> Void) throws -> Int {
    guard let db else { throw sqliteError("Database is not open.") }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      throw sqliteError(sqliteMessage(db))
    }
    defer { sqlite3_finalize(statement) }
    try bind(statement)
    let result = sqlite3_step(statement)
    guard result == SQLITE_DONE || result == SQLITE_ROW else {
      throw sqliteError(sqliteMessage(db), code: result)
    }
    return Int(sqlite3_changes(db))
  }

  private func query<T>(_ sql: String, bind: ((OpaquePointer) throws -> Void)? = nil, map: (OpaquePointer) -> T) -> [T] {
    query(with: db, sql, bind: bind, map: map)
  }

  private func query<T>(with handle: OpaquePointer?, _ sql: String, bind: ((OpaquePointer) throws -> Void)? = nil, map: (OpaquePointer) -> T) -> [T] {
    guard let handle else { return [] }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      return []
    }
    defer { sqlite3_finalize(statement) }
    do {
      try bind?(statement)
    } catch {
      return []
    }
    var rows: [T] = []
    while sqlite3_step(statement) == SQLITE_ROW {
      rows.append(map(statement))
    }
    return rows
  }

  private func querySingle<T>(_ sql: String, bind: ((OpaquePointer) throws -> Void)? = nil, map: (OpaquePointer) -> T) -> T? {
    query(sql, bind: bind, map: map).first
  }

  private func queryInt64(_ sql: String, bind: ((OpaquePointer) throws -> Void)? = nil) -> Int64? {
    querySingle(sql, bind: bind) { statement in
      sqlite3_column_int64(statement, 0)
    }
  }

  private func queryString(_ sql: String, bind: ((OpaquePointer) throws -> Void)? = nil) -> String? {
    querySingle(sql, bind: bind) { statement in
      stringValue(statement, index: 0) ?? ""
    }
  }

  private func bindText(_ value: String, to statement: OpaquePointer, index: Int32) throws {
    if sqlite3_bind_text(statement, index, (value as NSString).utf8String, -1, sqliteTransient) != SQLITE_OK {
      throw sqliteError(sqliteMessage(db))
    }
  }

  private func bindHexBlob(_ value: String, to statement: OpaquePointer, index: Int32) throws {
    guard let data = Data(hex: value) else {
      throw sqliteError("Invalid hex string for blob binding.")
    }
    try data.withUnsafeBytes { rawBuffer in
      let bytes = rawBuffer.baseAddress
      if sqlite3_bind_blob(statement, index, bytes, Int32(data.count), sqliteTransient) != SQLITE_OK {
        throw sqliteError(sqliteMessage(db))
      }
    }
  }

  private func bindScalar(_ value: SyncScalarValue, to statement: OpaquePointer, index: Int32) throws {
    switch value {
    case .string(let stringValue):
      try bindText(stringValue, to: statement, index: index)
    case .number(let numberValue):
      if numberValue.rounded(.towardZero) == numberValue {
        sqlite3_bind_int64(statement, index, sqlite3_int64(numberValue))
      } else {
        sqlite3_bind_double(statement, index, numberValue)
      }
    case .bytes(let bytesValue):
      let data = Data(base64Encoded: bytesValue.base64) ?? Data()
      try data.withUnsafeBytes { rawBuffer in
        let bytes = rawBuffer.baseAddress
        if sqlite3_bind_blob(statement, index, bytes, Int32(data.count), sqliteTransient) != SQLITE_OK {
          throw sqliteError(sqliteMessage(db))
        }
      }
    case .null:
      sqlite3_bind_null(statement, index)
    }
  }

  private func scalarValue(_ statement: OpaquePointer, index: Int32) -> SyncScalarValue {
    switch sqlite3_column_type(statement, index) {
    case SQLITE_INTEGER:
      return .number(Double(sqlite3_column_int64(statement, index)))
    case SQLITE_FLOAT:
      return .number(sqlite3_column_double(statement, index))
    case SQLITE_BLOB:
      return .bytes(SyncScalarBytes(type: "bytes", base64: blobBase64Value(statement, index: index) ?? ""))
    case SQLITE_TEXT:
      return .string(stringValue(statement, index: index) ?? "")
    default:
      return .null
    }
  }

  private func blobBase64Value(_ statement: OpaquePointer, index: Int32) -> String? {
    guard let bytes = sqlite3_column_blob(statement, index) else { return nil }
    let count = Int(sqlite3_column_bytes(statement, index))
    return Data(bytes: bytes, count: count).base64EncodedString()
  }

  private func blobHexValue(_ statement: OpaquePointer, index: Int32) -> String? {
    guard let bytes = sqlite3_column_blob(statement, index) else { return nil }
    let count = Int(sqlite3_column_bytes(statement, index))
    return Data(bytes: bytes, count: count).map { String(format: "%02x", $0) }.joined()
  }

  private func stringValue(_ statement: OpaquePointer, index: Int32) -> String? {
    guard let raw = sqlite3_column_text(statement, index) else { return nil }
    return String(cString: raw)
  }

  private func columnIsNull(_ statement: OpaquePointer, index: Int32) -> Bool {
    sqlite3_column_type(statement, index) == SQLITE_NULL
  }

  private func sqliteError(_ message: String, code: Int32 = SQLITE_ERROR) -> NSError {
    NSError(domain: "ADE.Database", code: Int(code), userInfo: [NSLocalizedDescriptionKey: message])
  }

  private func sqliteMessage(_ db: OpaquePointer?) -> String {
    guard let db, let message = sqlite3_errmsg(db) else {
      return "SQLite operation failed."
    }
    return String(cString: message)
  }

  private func parseAlterTableTarget(_ sql: String) -> String? {
    guard let regex = try? NSRegularExpression(pattern: #"^\s*alter\s+table\s+([`"'[\]A-Za-z0-9_]+)\s+add\s+column\s+"#, options: [.caseInsensitive]) else {
      return nil
    }
    let range = NSRange(location: 0, length: sql.utf16.count)
    guard let match = regex.firstMatch(in: sql, options: [], range: range), match.numberOfRanges > 1,
          let resultRange = Range(match.range(at: 1), in: sql) else {
      return nil
    }
    return sql[resultRange].replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "'", with: "").replacingOccurrences(of: "`", with: "").replacingOccurrences(of: "[", with: "").replacingOccurrences(of: "]", with: "")
  }
}

private extension Data {
  init?(hex: String) {
    let value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
    guard value.count % 2 == 0 else { return nil }
    var data = Data(capacity: value.count / 2)
    var index = value.startIndex
    while index < value.endIndex {
      let next = value.index(index, offsetBy: 2)
      guard let byte = UInt8(value[index..<next], radix: 16) else { return nil }
      data.append(byte)
      index = next
    }
    self = data
  }
}
