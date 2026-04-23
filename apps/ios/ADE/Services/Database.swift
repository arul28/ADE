import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
private let localDeleteColumnId = "-1"
private let legacyDeleteColumnId = "__ade_deleted"

extension Notification.Name {
  static let adeDatabaseDidChange = Notification.Name("ADE.DatabaseDidChange")
}

final class DatabaseService {
  private struct SyncColumnInfo {
    let name: String
    let declaredType: String
    let notNull: Bool
    let defaultValue: String?
    let pkIndex: Int
  }

  private struct SyncTableInfo {
    let name: String
    let columns: [SyncColumnInfo]

    var primaryKeyColumn: String? {
      primaryKeyColumns.first
    }

    var primaryKeyColumns: [String] {
      columns.filter { $0.pkIndex > 0 }.sorted { $0.pkIndex < $1.pkIndex }.map(\.name)
    }
  }

  private struct AlterTableAddColumnTarget {
    let tableName: String
    let columnName: String
  }

  private struct LaneRow {
    let id: String
    let name: String
    let description: String?
    let laneType: String
    let baseRef: String
    let branchRef: String
    let worktreePath: String
    let attachedRootPath: String?
    let parentLaneId: String?
    let isEditProtected: Bool
    let color: String?
    let icon: LaneIcon?
    let tags: [String]
    let folder: String?
    let createdAt: String
    let archivedAt: String?
    let parentStatus: LaneStatus?
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
    let manuallyNamed: Bool
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
    let runtimeState: String
    let resumeCommand: String?
    let resumeMetadata: TerminalResumeMetadata?
    let chatIdleSinceAt: String?
  }

  private struct ComputerUseArtifactRow {
    let id: String
    let artifactKind: String
    let backendStyle: String
    let backendName: String
    let sourceToolName: String?
    let originalType: String?
    let title: String
    let description: String?
    let uri: String
    let storageKind: String
    let mimeType: String?
    let metadataJson: String?
    let createdAt: String
    let ownerKind: String
    let ownerId: String
    let relation: String
  }

  private struct LaneListSnapshotRow {
    let laneId: String
    let snapshotJson: String
    let updatedAt: String
  }

  private struct LaneDetailSnapshotRow {
    let laneId: String
    let detailJson: String
    let updatedAt: String
  }

  private struct PullRequestSnapshotRow {
    let detailJson: String?
    let statusJson: String?
    let checksJson: String?
    let reviewsJson: String?
    let commentsJson: String?
    let filesJson: String?
    let commitsJson: String?
  }

  private struct PullRequestListItemRow {
    let id: String
    let laneId: String
    let laneName: String?
    let projectId: String
    let repoOwner: String
    let repoName: String
    let githubPrNumber: Int
    let githubUrl: String
    let title: String
    let state: String
    let baseBranch: String
    let headBranch: String
    let checksStatus: String
    let reviewStatus: String
    let additions: Int
    let deletions: Int
    let lastSyncedAt: String?
    let createdAt: String
    let updatedAt: String
    let groupId: String?
    let groupType: String?
    let groupName: String?
    let groupPosition: Int?
    let groupCount: Int
    let workflowDisplayState: String?
    let cleanupState: String?
    let linkedWorkflowGroupId: String?
  }

  private struct PrGroupMemberRow {
    let groupId: String
    let groupType: String
    let groupName: String?
    let targetBranch: String?
    let prId: String
    let laneId: String
    let laneName: String
    let title: String
    let state: String
    let githubPrNumber: Int
    let githubUrl: String
    let baseBranch: String
    let headBranch: String
    let position: Int
  }

  private struct IntegrationProposalRow {
    let proposalId: String
    let sourceLaneIdsJson: String
    let baseBranch: String
    let pairwiseResultsJson: String
    let laneSummariesJson: String
    let stepsJson: String
    let overallOutcome: String
    let createdAt: String
    let title: String?
    let body: String?
    let draft: Bool
    let integrationLaneName: String?
    let status: String
    let integrationLaneId: String?
    let linkedGroupId: String?
    let linkedPrId: String?
    let workflowDisplayState: String?
    let cleanupState: String?
    let closedAt: String?
    let mergedAt: String?
    let completedAt: String?
    let cleanupDeclinedAt: String?
    let cleanupCompletedAt: String?
    let preferredIntegrationLaneId: String?
    let mergeIntoHeadSha: String?
    let resolutionStateJson: String?
  }

  private struct QueueStateRow {
    let queueId: String
    let groupId: String
    let groupName: String?
    let targetBranch: String?
    let state: String
    let entriesJson: String
    let configJson: String
    let currentPosition: Int
    let activePrId: String?
    let activeResolverRunId: String?
    let lastError: String?
    let waitReason: String?
    let startedAt: String
    let completedAt: String?
    let updatedAt: String?
  }

  private var db: OpaquePointer?
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  private let fileManager: FileManager
  private let appURL: URL
  private let dbURL: URL
  private let siteIdURL: URL
  private let bootstrapSQLOverride: String?
  private var localDbVersion = 0
  private var cachedSiteIdHex = ""
  private var cachedSiteIdBlob = Data()
  private var shouldCaptureLocalChanges = true
  private var syncTableInfoCache: [String: SyncTableInfo] = [:]
  private var activeProjectIdOverride: String?
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
    cachedSiteIdHex = localSiteId()
    cachedSiteIdBlob = Data(hex: cachedSiteIdHex) ?? Data()

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
    localDbVersion
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
    var acceptedChanges: [CrsqlChangeRow] = []
    let shouldRestoreForeignKeys = (queryInt64("pragma foreign_keys") ?? 0) != 0
    if shouldRestoreForeignKeys {
      try exec("pragma foreign_keys = off")
    }
    defer {
      if shouldRestoreForeignKeys {
        try? exec("pragma foreign_keys = on")
      }
    }
    try exec("begin")
    do {
      let sql = """
        insert or ignore into crsql_changes ([table], pk, cid, val, col_version, db_version, site_id, cl, seq)
        values (?, ?, ?, ?, ?, ?, ?, ?, ?)
      """
      for rawChange in changes {
        let change = normalizeIncomingChange(rawChange)
        // These snapshot tables are fully replaced by explicit hydration after
        // connect, so accepting CRDT deltas for them is redundant and brittle.
        if DatabaseService.hydrationOwnedCrrExcludedTables.contains(change.table) {
          continue
        }
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
        if changed > 0 {
          acceptedChanges.append(change)
          touchedTables.insert(change.table)
          localDbVersion = max(localDbVersion, change.dbVersion)
        }
      }
      try applyAcceptedRemoteChanges(acceptedChanges)
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
      dbVersion: localDbVersion,
      touchedTables: touchedTables.sorted(),
      rebuiltFts: rebuiltFts,
    )
  }

  func fetchLanes(includeArchived: Bool) -> [LaneSummary] {
    let projectId = currentProjectId()
    if projectId == nil && projectCount() > 0 {
      return []
    }
    let projectPredicate = projectId == nil ? "" : "l.project_id = ? and"
    let sql = """
      select l.id, l.name, l.description, l.lane_type, l.base_ref, l.branch_ref, l.worktree_path,
             l.attached_root_path, l.parent_lane_id, l.is_edit_protected, l.color, l.icon, l.tags_json, l.folder,
             l.created_at, l.archived_at,
             coalesce(s.dirty, 0) as dirty,
             coalesce(s.ahead, 0) as ahead,
             coalesce(s.behind, 0) as behind,
             coalesce(s.remote_behind, -1) as remote_behind,
             coalesce(s.rebase_in_progress, 0) as rebase_in_progress,
             ps.dirty,
             ps.ahead,
             ps.behind,
             ps.remote_behind,
             ps.rebase_in_progress
        from lanes l
        left join lane_state_snapshots s on s.lane_id = l.id
        left join lane_state_snapshots ps on ps.lane_id = l.parent_lane_id
       where \(projectPredicate) (? = 1 or l.archived_at is null)
       order by l.created_at asc
    """
    let rows = query(sql, bind: { [self] statement in
      if let projectId {
        try self.bindText(projectId, to: statement, index: 1)
        sqlite3_bind_int(statement, 2, includeArchived ? 1 : 0)
      } else {
        sqlite3_bind_int(statement, 1, includeArchived ? 1 : 0)
      }
    }) { statement in
      LaneRow(
        id: stringValue(statement, index: 0) ?? "",
        name: stringValue(statement, index: 1) ?? "",
        description: stringValue(statement, index: 2),
        laneType: stringValue(statement, index: 3) ?? "worktree",
        baseRef: stringValue(statement, index: 4) ?? "",
        branchRef: stringValue(statement, index: 5) ?? "",
        worktreePath: stringValue(statement, index: 6) ?? "",
        attachedRootPath: stringValue(statement, index: 7),
        parentLaneId: stringValue(statement, index: 8),
        isEditProtected: sqlite3_column_int(statement, 9) == 1,
        color: stringValue(statement, index: 10),
        icon: stringValue(statement, index: 11).flatMap(LaneIcon.init(rawValue:)),
        tags: decodeJson(stringValue(statement, index: 12), as: [String].self) ?? [],
        folder: stringValue(statement, index: 13),
        createdAt: stringValue(statement, index: 14) ?? "",
        archivedAt: stringValue(statement, index: 15),
        parentStatus: columnIsNull(statement, index: 21) ? nil : LaneStatus(
          dirty: sqlite3_column_int(statement, 21) == 1,
          ahead: Int(sqlite3_column_int64(statement, 22)),
          behind: Int(sqlite3_column_int64(statement, 23)),
          remoteBehind: Int(sqlite3_column_int64(statement, 24)),
          rebaseInProgress: sqlite3_column_int(statement, 25) == 1
        ),
        dirty: sqlite3_column_int(statement, 16) == 1,
        ahead: Int(sqlite3_column_int64(statement, 17)),
        behind: Int(sqlite3_column_int64(statement, 18)),
        remoteBehind: Int(sqlite3_column_int64(statement, 19)),
        rebaseInProgress: sqlite3_column_int(statement, 20) == 1
      )
    }

    // Harden against duplicate ids arriving from sync merges: last writer wins.
    var rowOrder: [String] = []
    var rowsById: [String: LaneRow] = [:]
    for row in rows {
      if rowsById[row.id] == nil {
        rowOrder.append(row.id)
      }
      rowsById[row.id] = row
    }
    let dedupedRows = rowOrder.compactMap { rowsById[$0] }

    let childCounts = dedupedRows.reduce(into: [String: Int]()) { partial, row in
      guard let parent = row.parentLaneId, row.archivedAt == nil else { return }
      partial[parent, default: 0] += 1
    }

    func stackDepth(for laneId: String, visited: inout Set<String>) -> Int {
      guard !visited.contains(laneId), let row = rowsById[laneId], let parent = row.parentLaneId else { return 0 }
      visited.insert(laneId)
      defer { visited.remove(laneId) }
      return 1 + stackDepth(for: parent, visited: &visited)
    }

    return dedupedRows
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
          attachedRootPath: row.attachedRootPath,
          parentLaneId: row.parentLaneId,
          childCount: childCounts[row.id, default: 0],
          stackDepth: stackDepth(for: row.id, visited: &visited),
          parentStatus: row.parentStatus,
          isEditProtected: row.isEditProtected,
          status: LaneStatus(
            dirty: row.dirty,
            ahead: row.ahead,
            behind: row.behind,
            remoteBehind: row.remoteBehind,
            rebaseInProgress: row.rebaseInProgress
          ),
          color: row.color,
          icon: row.icon,
          tags: row.tags,
          folder: row.folder,
          createdAt: row.createdAt,
          archivedAt: row.archivedAt
        )
      }
  }

  func replaceLaneSnapshots(_ lanes: [LaneSummary], snapshots: [LaneListSnapshot]? = nil) throws {
    guard db != nil else { return }
    guard let projectId = currentProjectId() else {
      throw sqliteError(SyncHydrationMessaging.waitingForProjectData)
    }

    shouldCaptureLocalChanges = false
    defer { shouldCaptureLocalChanges = true }

    let orderedLanes = lanes.sorted {
      if $0.stackDepth != $1.stackDepth {
        return $0.stackDepth < $1.stackDepth
      }
      return $0.createdAt < $1.createdAt
    }
    let orderedLaneIds = Set(orderedLanes.map(\.id))
    let snapshotUpdatedAt = ISO8601DateFormatter().string(from: Date())
    let hydratedSnapshots = (snapshots ?? orderedLanes.map { lane in
      LaneListSnapshot(
        lane: lane,
        runtime: LaneRuntimeSummary(bucket: "none", runningCount: 0, awaitingInputCount: 0, endedCount: 0, sessionCount: 0),
        rebaseSuggestion: nil,
        autoRebaseStatus: nil,
        conflictStatus: nil,
        stateSnapshot: nil,
        adoptableAttached: lane.laneType == "attached" && lane.archivedAt == nil
      )
    }).filter { orderedLaneIds.contains($0.lane.id) }

    try exec("begin")
    do {
      try exec("pragma defer_foreign_keys = on")
      _ = try execute("""
        delete from lane_state_snapshots
         where lane_id in (select id from lanes where project_id = ?)
      """) { statement in
        try bindText(projectId, to: statement, index: 1)
      }
      _ = try execute("""
        delete from lane_list_snapshots
         where lane_id in (select id from lanes where project_id = ?)
      """) { statement in
        try bindText(projectId, to: statement, index: 1)
      }
      if orderedLaneIds.isEmpty {
        _ = try execute("""
          update lanes
             set status = 'archived',
                 archived_at = coalesce(archived_at, ?)
           where project_id = ?
        """) { statement in
          try bindText(snapshotUpdatedAt, to: statement, index: 1)
          try bindText(projectId, to: statement, index: 2)
        }
      } else {
        try prepareTemporaryIdTable(named: "temp_hydrated_lane_ids", ids: orderedLaneIds.sorted())
        _ = try execute("""
          update lanes
             set status = 'archived',
                 archived_at = coalesce(archived_at, ?)
           where not exists (
             select 1
               from temp_hydrated_lane_ids hydrated
              where hydrated.id = lanes.id
           )
             and project_id = ?
        """) { statement in
          try bindText(snapshotUpdatedAt, to: statement, index: 1)
          try bindText(projectId, to: statement, index: 2)
        }
      }

      for lane in orderedLanes {
        _ = try execute("""
          insert into lanes (
            id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
            attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder,
            status, created_at, archived_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            project_id = excluded.project_id,
            name = excluded.name,
            description = excluded.description,
            lane_type = excluded.lane_type,
            base_ref = excluded.base_ref,
            branch_ref = excluded.branch_ref,
            worktree_path = excluded.worktree_path,
            attached_root_path = excluded.attached_root_path,
            is_edit_protected = excluded.is_edit_protected,
            parent_lane_id = excluded.parent_lane_id,
            color = excluded.color,
            icon = excluded.icon,
            tags_json = excluded.tags_json,
            folder = excluded.folder,
            mission_id = null,
            lane_role = null,
            status = excluded.status,
            created_at = excluded.created_at,
            archived_at = excluded.archived_at
        """) { statement in
          try bindText(lane.id, to: statement, index: 1)
          try bindText(projectId, to: statement, index: 2)
          try bindText(lane.name, to: statement, index: 3)
          if let description = lane.description {
            try bindText(description, to: statement, index: 4)
          } else {
            sqlite3_bind_null(statement, 4)
          }
          try bindText(lane.laneType, to: statement, index: 5)
          try bindText(lane.baseRef, to: statement, index: 6)
          try bindText(lane.branchRef, to: statement, index: 7)
          try bindText(lane.worktreePath, to: statement, index: 8)
          if let attachedRootPath = lane.attachedRootPath {
            try bindText(attachedRootPath, to: statement, index: 9)
          } else {
            sqlite3_bind_null(statement, 9)
          }
          sqlite3_bind_int(statement, 10, lane.isEditProtected ? 1 : 0)
          if let parentLaneId = lane.parentLaneId {
            try bindText(parentLaneId, to: statement, index: 11)
          } else {
            sqlite3_bind_null(statement, 11)
          }
          if let color = lane.color {
            try bindText(color, to: statement, index: 12)
          } else {
            sqlite3_bind_null(statement, 12)
          }
          if let icon = lane.icon?.rawValue {
            try bindText(icon, to: statement, index: 13)
          } else {
            sqlite3_bind_null(statement, 13)
          }
          if lane.tags.isEmpty {
            sqlite3_bind_null(statement, 14)
          } else {
            try bindOptionalJson(lane.tags, to: statement, index: 14)
          }
          if let folder = lane.folder {
            try bindText(folder, to: statement, index: 15)
          } else {
            sqlite3_bind_null(statement, 15)
          }
          try bindText(lane.archivedAt == nil ? "active" : "archived", to: statement, index: 16)
          try bindText(lane.createdAt, to: statement, index: 17)
          if let archivedAt = lane.archivedAt {
            try bindText(archivedAt, to: statement, index: 18)
          } else {
            sqlite3_bind_null(statement, 18)
          }
        }

        _ = try execute("""
          insert into lane_state_snapshots (
            lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress,
            agent_summary_json, mission_summary_json, updated_at
          ) values (?, ?, ?, ?, ?, ?, null, null, ?)
        """) { statement in
          try bindText(lane.id, to: statement, index: 1)
          sqlite3_bind_int(statement, 2, lane.status.dirty ? 1 : 0)
          sqlite3_bind_int64(statement, 3, sqlite3_int64(lane.status.ahead))
          sqlite3_bind_int64(statement, 4, sqlite3_int64(lane.status.behind))
          sqlite3_bind_int64(statement, 5, sqlite3_int64(lane.status.remoteBehind))
          sqlite3_bind_int(statement, 6, lane.status.rebaseInProgress ? 1 : 0)
          try bindText(snapshotUpdatedAt, to: statement, index: 7)
        }
      }

      for snapshot in hydratedSnapshots {
        let encodedSnapshot = try encodeJsonString(snapshot)
        _ = try execute("""
          insert into lane_list_snapshots(
            lane_id, snapshot_json, updated_at
          ) values (?, ?, ?)
          on conflict(lane_id) do update set
            snapshot_json = excluded.snapshot_json,
            updated_at = excluded.updated_at
        """) { statement in
          try bindText(snapshot.lane.id, to: statement, index: 1)
          try bindText(encodedSnapshot, to: statement, index: 2)
          try bindText(snapshotUpdatedAt, to: statement, index: 3)
        }
      }

      let laneIds = orderedLanes.map(\.id)
      if laneIds.isEmpty {
        try exec("delete from lane_detail_snapshots")
      } else {
        try exec("""
          delete from lane_detail_snapshots
           where not exists (
             select 1
               from temp_hydrated_lane_ids hydrated
              where hydrated.id = lane_detail_snapshots.lane_id
           )
        """)
      }
      try exec("drop table if exists temp_hydrated_lane_ids")

      try exec("commit")
      notifyDidChange()
    } catch {
      try? exec("rollback")
      try? exec("drop table if exists temp_hydrated_lane_ids")
      throw error
    }
  }

  func fetchLaneListSnapshots(includeArchived: Bool) -> [LaneListSnapshot] {
    guard let projectId = currentProjectId() else { return [] }
    let sql = """
      select s.lane_id, s.snapshot_json, s.updated_at
        from lane_list_snapshots s
        join lanes l on l.id = s.lane_id
       where l.project_id = ?
         and (? = 1 or l.archived_at is null)
       order by l.created_at desc
    """
    return query(sql, bind: { [self] statement in
      try self.bindText(projectId, to: statement, index: 1)
      sqlite3_bind_int(statement, 2, includeArchived ? 1 : 0)
    }) { statement in
      LaneListSnapshotRow(
        laneId: stringValue(statement, index: 0) ?? "",
        snapshotJson: stringValue(statement, index: 1) ?? "",
        updatedAt: stringValue(statement, index: 2) ?? ""
      )
    }.compactMap { row in
      decodeJson(row.snapshotJson, as: LaneListSnapshot.self)
    }
  }

  func replaceLaneDetail(_ detail: LaneDetailPayload) throws {
    guard db != nil else { return }
    let updatedAt = ISO8601DateFormatter().string(from: Date())
    let encodedDetail = try encodeJsonString(detail)
    _ = try execute("""
      insert into lane_detail_snapshots(
        lane_id, detail_json, updated_at
      ) values (?, ?, ?)
      on conflict(lane_id) do update set
        detail_json = excluded.detail_json,
        updated_at = excluded.updated_at
    """) { statement in
      try bindText(detail.lane.id, to: statement, index: 1)
      try bindText(encodedDetail, to: statement, index: 2)
      try bindText(updatedAt, to: statement, index: 3)
    }
    notifyDidChange()
  }

  func fetchLaneDetail(laneId: String) -> LaneDetailPayload? {
    let sql = """
      select lane_id, detail_json, updated_at
        from lane_detail_snapshots
       where lane_id = ?
       limit 1
    """
    guard let row = querySingle(sql, bind: { [self] statement in
      try self.bindText(laneId, to: statement, index: 1)
    }, map: { statement in
      LaneDetailSnapshotRow(
        laneId: stringValue(statement, index: 0) ?? "",
        detailJson: stringValue(statement, index: 1) ?? "",
        updatedAt: stringValue(statement, index: 2) ?? ""
      )
    }) else {
      return nil
    }
    return decodeJson(row.detailJson, as: LaneDetailPayload.self)
  }

  func replaceTerminalSessions(_ sessions: [TerminalSessionSummary]) throws {
    guard db != nil else { return }
    guard let projectId = currentProjectId() else {
      throw sqliteError(SyncHydrationMessaging.waitingForProjectData)
    }

    shouldCaptureLocalChanges = false
    defer { shouldCaptureLocalChanges = true }

    let laneIds = Set(query("select id from lanes where project_id = ?", bind: { [self] statement in
      try self.bindText(projectId, to: statement, index: 1)
    }) { statement in
      stringValue(statement, index: 0) ?? ""
    })
    let hydratableSessions = sessions.filter { laneIds.contains($0.laneId) }
    let sessionIds = hydratableSessions.map(\.id)

    try exec("begin")
    do {
      try prepareTemporaryIdTable(named: "temp_project_lane_ids", ids: laneIds.sorted())
      if !sessionIds.isEmpty {
        try prepareTemporaryIdTable(named: "temp_hydrated_session_ids", ids: sessionIds)
      }
      if hasTable(named: "session_deltas") {
        _ = try execute("delete from session_deltas where project_id = ?") { statement in
          try bindText(projectId, to: statement, index: 1)
        }
      }
      if hasTable(named: "checkpoints") {
        if sessionIds.isEmpty {
          try exec("""
            update checkpoints
               set session_id = null
             where session_id in (
               select terminal_sessions.id
                 from terminal_sessions
                where exists (
                  select 1
                    from temp_project_lane_ids project_lanes
                   where project_lanes.id = terminal_sessions.lane_id
                )
             )
          """)
        } else {
          try exec("""
            update checkpoints
               set session_id = null
             where session_id is not null
               and session_id in (
                 select terminal_sessions.id
                   from terminal_sessions
                  where exists (
                    select 1
                      from temp_project_lane_ids project_lanes
                     where project_lanes.id = terminal_sessions.lane_id
                  )
               )
               and not exists (
                 select 1
                   from temp_hydrated_session_ids hydrated
                  where hydrated.id = checkpoints.session_id
               )
          """)
        }
      }

      for session in hydratableSessions {
        _ = try execute("""
          insert into terminal_sessions(
            id, lane_id, lane_name, pty_id, tracked, goal, tool_type, pinned, title, started_at, ended_at,
            exit_code, transcript_path, head_sha_start, head_sha_end, status, last_output_preview,
            last_output_at, summary, runtime_state, resume_command, resume_metadata_json, manually_named, chat_idle_since_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            lane_id = excluded.lane_id,
            lane_name = excluded.lane_name,
            pty_id = excluded.pty_id,
            tracked = excluded.tracked,
            goal = excluded.goal,
            tool_type = excluded.tool_type,
            pinned = excluded.pinned,
            title = excluded.title,
            started_at = excluded.started_at,
            ended_at = excluded.ended_at,
            exit_code = excluded.exit_code,
            transcript_path = excluded.transcript_path,
            head_sha_start = excluded.head_sha_start,
            head_sha_end = excluded.head_sha_end,
            status = excluded.status,
            last_output_preview = excluded.last_output_preview,
            last_output_at = excluded.last_output_at,
            summary = excluded.summary,
            runtime_state = excluded.runtime_state,
            resume_command = excluded.resume_command,
            resume_metadata_json = excluded.resume_metadata_json,
            manually_named = excluded.manually_named,
            chat_idle_since_at = excluded.chat_idle_since_at
        """) { statement in
          try bindText(session.id, to: statement, index: 1)
          try bindText(session.laneId, to: statement, index: 2)
          try bindText(session.laneName, to: statement, index: 3)
          if let ptyId = session.ptyId {
            try bindText(ptyId, to: statement, index: 4)
          } else {
            sqlite3_bind_null(statement, 4)
          }
          sqlite3_bind_int(statement, 5, session.tracked ? 1 : 0)
          if let goal = session.goal {
            try bindText(goal, to: statement, index: 6)
          } else {
            sqlite3_bind_null(statement, 6)
          }
          if let toolType = session.toolType {
            try bindText(toolType, to: statement, index: 7)
          } else {
            sqlite3_bind_null(statement, 7)
          }
          sqlite3_bind_int(statement, 8, session.pinned ? 1 : 0)
          try bindText(session.title, to: statement, index: 9)
          try bindText(session.startedAt, to: statement, index: 10)
          if let endedAt = session.endedAt {
            try bindText(endedAt, to: statement, index: 11)
          } else {
            sqlite3_bind_null(statement, 11)
          }
          if let exitCode = session.exitCode {
            sqlite3_bind_int64(statement, 12, sqlite3_int64(exitCode))
          } else {
            sqlite3_bind_null(statement, 12)
          }
          try bindText(session.transcriptPath, to: statement, index: 13)
          if let headShaStart = session.headShaStart {
            try bindText(headShaStart, to: statement, index: 14)
          } else {
            sqlite3_bind_null(statement, 14)
          }
          if let headShaEnd = session.headShaEnd {
            try bindText(headShaEnd, to: statement, index: 15)
          } else {
            sqlite3_bind_null(statement, 15)
          }
          try bindText(session.status, to: statement, index: 16)
          if let preview = session.lastOutputPreview {
            try bindText(preview, to: statement, index: 17)
          } else {
            sqlite3_bind_null(statement, 17)
          }
          try bindText(session.endedAt ?? session.startedAt, to: statement, index: 18)
          if let summary = session.summary {
            try bindText(summary, to: statement, index: 19)
          } else {
            sqlite3_bind_null(statement, 19)
          }
          try bindText(session.runtimeState, to: statement, index: 20)
          if let resumeCommand = session.resumeCommand {
            try bindText(resumeCommand, to: statement, index: 21)
          } else {
            sqlite3_bind_null(statement, 21)
          }
          try bindOptionalJson(session.resumeMetadata, to: statement, index: 22)
          sqlite3_bind_int(statement, 23, session.manuallyNamed == true ? 1 : 0)
          if let chatIdleSinceAt = session.chatIdleSinceAt {
            try bindText(chatIdleSinceAt, to: statement, index: 24)
          } else {
            sqlite3_bind_null(statement, 24)
          }
        }
      }

      if sessionIds.isEmpty {
        try exec("""
          delete from terminal_sessions
           where exists (
             select 1
               from temp_project_lane_ids project_lanes
              where project_lanes.id = terminal_sessions.lane_id
           )
        """)
      } else {
        try exec("""
          delete from terminal_sessions
           where exists (
             select 1
               from temp_project_lane_ids project_lanes
              where project_lanes.id = terminal_sessions.lane_id
           )
             and not exists (
             select 1
               from temp_hydrated_session_ids hydrated
              where hydrated.id = terminal_sessions.id
           )
        """)
      }
      try exec("drop table if exists temp_hydrated_session_ids")
      try exec("drop table if exists temp_project_lane_ids")

      try exec("commit")
      notifyDidChange()
    } catch {
      try? exec("rollback")
      try? exec("drop table if exists temp_hydrated_session_ids")
      try? exec("drop table if exists temp_project_lane_ids")
      throw error
    }
  }

  func replacePullRequestHydration(_ payload: PullRequestRefreshPayload) throws {
    guard db != nil else { return }
    guard let projectId = currentProjectId() else {
      throw sqliteError(SyncHydrationMessaging.waitingForProjectData)
    }

    shouldCaptureLocalChanges = false
    defer { shouldCaptureLocalChanges = true }

    try exec("begin")
    do {
      _ = try execute("""
        delete from pull_request_snapshots
         where pr_id in (select id from pull_requests where project_id = ?)
      """) { statement in
        try bindText(projectId, to: statement, index: 1)
      }

      for pr in payload.prs {
        _ = try execute("""
          insert into pull_requests(
            id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
            title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
            last_synced_at, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            project_id = excluded.project_id,
            lane_id = excluded.lane_id,
            repo_owner = excluded.repo_owner,
            repo_name = excluded.repo_name,
            github_pr_number = excluded.github_pr_number,
            github_url = excluded.github_url,
            github_node_id = excluded.github_node_id,
            title = excluded.title,
            state = excluded.state,
            base_branch = excluded.base_branch,
            head_branch = excluded.head_branch,
            checks_status = excluded.checks_status,
            review_status = excluded.review_status,
            additions = excluded.additions,
            deletions = excluded.deletions,
            last_synced_at = excluded.last_synced_at,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        """) { statement in
          try bindText(pr.id, to: statement, index: 1)
          try bindText(pr.projectId.isEmpty ? projectId : pr.projectId, to: statement, index: 2)
          try bindText(pr.laneId, to: statement, index: 3)
          try bindText(pr.repoOwner, to: statement, index: 4)
          try bindText(pr.repoName, to: statement, index: 5)
          sqlite3_bind_int64(statement, 6, sqlite3_int64(pr.githubPrNumber))
          try bindText(pr.githubUrl, to: statement, index: 7)
          if let githubNodeId = pr.githubNodeId {
            try bindText(githubNodeId, to: statement, index: 8)
          } else {
            sqlite3_bind_null(statement, 8)
          }
          try bindText(pr.title, to: statement, index: 9)
          try bindText(pr.state, to: statement, index: 10)
          try bindText(pr.baseBranch, to: statement, index: 11)
          try bindText(pr.headBranch, to: statement, index: 12)
          try bindText(pr.checksStatus, to: statement, index: 13)
          try bindText(pr.reviewStatus, to: statement, index: 14)
          sqlite3_bind_int64(statement, 15, sqlite3_int64(pr.additions))
          sqlite3_bind_int64(statement, 16, sqlite3_int64(pr.deletions))
          if let lastSyncedAt = pr.lastSyncedAt {
            try bindText(lastSyncedAt, to: statement, index: 17)
          } else {
            sqlite3_bind_null(statement, 17)
          }
          try bindText(pr.createdAt, to: statement, index: 18)
          try bindText(pr.updatedAt, to: statement, index: 19)
        }
      }

      for snapshot in payload.snapshots {
        _ = try execute("""
          insert into pull_request_snapshots(
            pr_id, detail_json, status_json, checks_json, reviews_json, comments_json, files_json, commits_json, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(pr_id) do update set
            detail_json = excluded.detail_json,
            status_json = excluded.status_json,
            checks_json = excluded.checks_json,
            reviews_json = excluded.reviews_json,
            comments_json = excluded.comments_json,
            files_json = excluded.files_json,
            commits_json = excluded.commits_json,
            updated_at = excluded.updated_at
        """) { statement in
          try bindText(snapshot.prId, to: statement, index: 1)
          try bindOptionalJson(snapshot.detail, to: statement, index: 2)
          try bindOptionalJson(snapshot.status, to: statement, index: 3)
          try bindOptionalJson(snapshot.checks, to: statement, index: 4)
          try bindOptionalJson(snapshot.reviews, to: statement, index: 5)
          try bindOptionalJson(snapshot.comments, to: statement, index: 6)
          try bindOptionalJson(snapshot.files, to: statement, index: 7)
          try bindOptionalJson(snapshot.commits, to: statement, index: 8)
          try bindText(snapshot.updatedAt ?? ISO8601DateFormatter().string(from: Date()), to: statement, index: 9)
        }
      }

      try deleteStalePullRequestRows(projectId: projectId, keeping: payload.prs.map(\.id))

      try exec("commit")
      notifyDidChange()
    } catch {
      try? exec("rollback")
      throw error
    }
  }

  func listWorkspaces() -> [FilesWorkspace] {
    let projectId = currentProjectId()
    let hasProjects = projectCount() > 0
    let projectRoot = projectId.flatMap { id in
      queryString("select root_path from projects where id = ? limit 1", bind: { [self] statement in
        try self.bindText(id, to: statement, index: 1)
      })
    }
    let activeLaneIds: Set<String>? = projectId == nil && !hasProjects ? nil : Set(query("select id from lanes where project_id = ?", bind: { [self] statement in
      if let projectId {
        try self.bindText(projectId, to: statement, index: 1)
      } else {
        sqlite3_bind_null(statement, 1)
      }
    }) { statement in
      stringValue(statement, index: 0) ?? ""
    })
    if tableExists("files_workspaces") {
      let cached = query(
        """
        select id, kind, lane_id, name, root_path, is_read_only_by_default, mobile_read_only
          from files_workspaces
         order by case when kind = 'primary' then 0 else 1 end, name collate nocase asc
        """
      ) { statement in
        FilesWorkspace(
          id: stringValue(statement, index: 0) ?? "",
          kind: stringValue(statement, index: 1) ?? "",
          laneId: stringValue(statement, index: 2),
          name: stringValue(statement, index: 3) ?? "",
          rootPath: stringValue(statement, index: 4) ?? "",
          isReadOnlyByDefault: sqlite3_column_int(statement, 5) == 1,
          mobileReadOnly: sqlite3_column_int(statement, 6) != 0
        )
      }
      let scoped = cached.filter { workspace in
        if let laneId = workspace.laneId {
          return activeLaneIds?.contains(laneId) ?? true
        }
        guard workspace.kind == "primary" else { return false }
        guard let projectRoot else { return !hasProjects }
        return workspace.rootPath == projectRoot
      }
      if !scoped.isEmpty {
        return scoped
      }
    }

    return fetchLanes(includeArchived: false).map { lane in
      FilesWorkspace(
        id: lane.id,
        kind: lane.laneType,
        laneId: lane.id,
        name: lane.name,
        rootPath: lane.attachedRootPath ?? lane.worktreePath,
        isReadOnlyByDefault: lane.isEditProtected,
        mobileReadOnly: true
      )
    }
  }

  func replaceFilesWorkspaces(_ workspaces: [FilesWorkspace]) throws {
    guard tableExists("files_workspaces") else { return }
    let projectId = currentProjectId()
    let hasProjects = projectCount() > 0
    let projectRoot = projectId.flatMap { id in
      queryString("select root_path from projects where id = ? limit 1", bind: { [self] statement in
        try self.bindText(id, to: statement, index: 1)
      })
    }
    let activeLaneIds: Set<String>? = projectId == nil && !hasProjects ? nil : Set(query("select id from lanes where project_id = ?", bind: { [self] statement in
      if let projectId {
        try self.bindText(projectId, to: statement, index: 1)
      } else {
        sqlite3_bind_null(statement, 1)
      }
    }) { statement in
      stringValue(statement, index: 0) ?? ""
    })
    try exec("begin immediate")
    do {
      let incomingIds = Set(workspaces.map(\.id))
      let existingIds = query("select id, kind, lane_id, root_path from files_workspaces") { statement in
        (
          id: stringValue(statement, index: 0) ?? "",
          kind: stringValue(statement, index: 1) ?? "",
          laneId: stringValue(statement, index: 2),
          rootPath: stringValue(statement, index: 3) ?? ""
        )
      }
      let scopedExistingIds = existingIds.filter { row in
        if let laneId = row.laneId {
          return activeLaneIds?.contains(laneId) ?? true
        }
        guard row.kind == "primary" else { return false }
        guard let projectRoot else { return !hasProjects }
        return row.rootPath == projectRoot
      }.map(\.id)
      let staleIds = scopedExistingIds.filter { !incomingIds.contains($0) }
      let snapshotTables = [
        "file_directory_snapshots",
        "file_content_snapshots",
        "file_diff_snapshots",
        "file_history_snapshots",
      ]

      for staleId in staleIds {
        for table in snapshotTables where tableExists(table) {
          _ = try execute("delete from \(table) where workspace_id = ?") { statement in
            try bindText(staleId, to: statement, index: 1)
          }
        }
        _ = try execute("delete from files_workspaces where id = ?") { statement in
          try bindText(staleId, to: statement, index: 1)
        }
      }

      let timestamp = ISO8601DateFormatter().string(from: Date())
      for workspace in workspaces {
        _ = try execute(
          """
          insert into files_workspaces(
            id, kind, lane_id, name, root_path, is_read_only_by_default, mobile_read_only, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(id) do update set
            kind = excluded.kind,
            lane_id = excluded.lane_id,
            name = excluded.name,
            root_path = excluded.root_path,
            is_read_only_by_default = excluded.is_read_only_by_default,
            mobile_read_only = excluded.mobile_read_only,
            updated_at = excluded.updated_at
          """
        ) { statement in
          try bindText(workspace.id, to: statement, index: 1)
          try bindText(workspace.kind, to: statement, index: 2)
          if let laneId = workspace.laneId {
            try bindText(laneId, to: statement, index: 3)
          } else {
            sqlite3_bind_null(statement, 3)
          }
          try bindText(workspace.name, to: statement, index: 4)
          try bindText(workspace.rootPath, to: statement, index: 5)
          sqlite3_bind_int(statement, 6, workspace.isReadOnlyByDefault ? 1 : 0)
          sqlite3_bind_int(statement, 7, workspace.mobileReadOnly ? 1 : 0)
          try bindText(timestamp, to: statement, index: 8)
        }
      }
      try exec("commit")
    } catch {
      try? exec("rollback")
      throw error
    }
  }

  func cacheDirectorySnapshot(workspaceId: String, parentPath: String, includeHidden: Bool, nodes: [FileTreeNode]) throws {
    guard tableExists("file_directory_snapshots") else { return }
    let json = try encodeJsonString(nodes)
    _ = try execute(
      """
      insert into file_directory_snapshots(workspace_id, parent_path, include_hidden, nodes_json, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(workspace_id, parent_path, include_hidden) do update set
        nodes_json = excluded.nodes_json,
        updated_at = excluded.updated_at
      """
    ) { statement in
      try bindText(workspaceId, to: statement, index: 1)
      try bindText(parentPath, to: statement, index: 2)
      sqlite3_bind_int(statement, 3, includeHidden ? 1 : 0)
      try bindText(json, to: statement, index: 4)
      try bindText(ISO8601DateFormatter().string(from: Date()), to: statement, index: 5)
    }
  }

  func fetchDirectorySnapshot(workspaceId: String, parentPath: String, includeHidden: Bool) -> [FileTreeNode]? {
    guard tableExists("file_directory_snapshots") else { return nil }
    let sql = """
      select nodes_json
        from file_directory_snapshots
       where workspace_id = ? and parent_path = ? and include_hidden = ?
       limit 1
    """
    let rows = query(sql, bind: { [self] statement in
      try self.bindText(workspaceId, to: statement, index: 1)
      try self.bindText(parentPath, to: statement, index: 2)
      sqlite3_bind_int(statement, 3, includeHidden ? 1 : 0)
    }) { statement in
      return stringValue(statement, index: 0)
    }
    guard let raw = rows.first else { return nil }
    return decodeJson(raw, as: [FileTreeNode].self)
  }

  func cacheFileContentSnapshot(workspaceId: String, path: String, blob: SyncFileBlob) throws {
    guard tableExists("file_content_snapshots") else { return }
    let json = try encodeJsonString(blob)
    _ = try execute(
      """
      insert into file_content_snapshots(workspace_id, relative_path, blob_json, updated_at)
      values (?, ?, ?, ?)
      on conflict(workspace_id, relative_path) do update set
        blob_json = excluded.blob_json,
        updated_at = excluded.updated_at
      """
    ) { statement in
      try bindText(workspaceId, to: statement, index: 1)
      try bindText(path, to: statement, index: 2)
      try bindText(json, to: statement, index: 3)
      try bindText(ISO8601DateFormatter().string(from: Date()), to: statement, index: 4)
    }
  }

  func fetchFileContentSnapshot(workspaceId: String, path: String) -> SyncFileBlob? {
    guard tableExists("file_content_snapshots") else { return nil }
    let sql = """
      select blob_json
        from file_content_snapshots
       where workspace_id = ? and relative_path = ?
       limit 1
    """
    let rows = query(sql, bind: { [self] statement in
      try self.bindText(workspaceId, to: statement, index: 1)
      try self.bindText(path, to: statement, index: 2)
    }) { statement in
      return stringValue(statement, index: 0)
    }
    guard let raw = rows.first else { return nil }
    return decodeJson(raw, as: SyncFileBlob.self)
  }

  func cacheFileDiffSnapshot(workspaceId: String, path: String, mode: String, diff: FileDiff) throws {
    guard tableExists("file_diff_snapshots") else { return }
    let json = try encodeJsonString(diff)
    _ = try execute(
      """
      insert into file_diff_snapshots(workspace_id, relative_path, mode, diff_json, updated_at)
      values (?, ?, ?, ?, ?)
      on conflict(workspace_id, relative_path, mode) do update set
        diff_json = excluded.diff_json,
        updated_at = excluded.updated_at
      """
    ) { statement in
      try bindText(workspaceId, to: statement, index: 1)
      try bindText(path, to: statement, index: 2)
      try bindText(mode, to: statement, index: 3)
      try bindText(json, to: statement, index: 4)
      try bindText(ISO8601DateFormatter().string(from: Date()), to: statement, index: 5)
    }
  }

  func fetchFileDiffSnapshot(workspaceId: String, path: String, mode: String) -> FileDiff? {
    guard tableExists("file_diff_snapshots") else { return nil }
    let sql = """
      select diff_json
        from file_diff_snapshots
       where workspace_id = ? and relative_path = ? and mode = ?
       limit 1
    """
    let rows = query(sql, bind: { [self] statement in
      try self.bindText(workspaceId, to: statement, index: 1)
      try self.bindText(path, to: statement, index: 2)
      try self.bindText(mode, to: statement, index: 3)
    }) { statement in
      return stringValue(statement, index: 0)
    }
    guard let raw = rows.first else { return nil }
    return decodeJson(raw, as: FileDiff.self)
  }

  func cacheFileHistorySnapshot(workspaceId: String, path: String, entries: [GitFileHistoryEntry]) throws {
    guard tableExists("file_history_snapshots") else { return }
    let json = try encodeJsonString(entries)
    _ = try execute(
      """
      insert into file_history_snapshots(workspace_id, relative_path, entries_json, updated_at)
      values (?, ?, ?, ?)
      on conflict(workspace_id, relative_path) do update set
        entries_json = excluded.entries_json,
        updated_at = excluded.updated_at
      """
    ) { statement in
      try bindText(workspaceId, to: statement, index: 1)
      try bindText(path, to: statement, index: 2)
      try bindText(json, to: statement, index: 3)
      try bindText(ISO8601DateFormatter().string(from: Date()), to: statement, index: 4)
    }
  }

  func fetchFileHistorySnapshot(workspaceId: String, path: String) -> [GitFileHistoryEntry]? {
    guard tableExists("file_history_snapshots") else { return nil }
    let sql = """
      select entries_json
        from file_history_snapshots
       where workspace_id = ? and relative_path = ?
       limit 1
    """
    let rows = query(sql, bind: { [self] statement in
      try self.bindText(workspaceId, to: statement, index: 1)
      try self.bindText(path, to: statement, index: 2)
    }) { statement in
      return stringValue(statement, index: 0)
    }
    guard let raw = rows.first else { return nil }
    return decodeJson(raw, as: [GitFileHistoryEntry].self)
  }

  func fetchSessions() -> [TerminalSessionSummary] {
    guard let projectId = currentProjectId() else { return [] }
    let sql = """
      select s.id, s.lane_id, coalesce(nullif(s.lane_name, ''), l.name, s.lane_id), s.pty_id, s.tracked, s.pinned, s.manually_named, s.goal, s.tool_type,
             s.title, s.status, s.started_at, s.ended_at, s.exit_code, s.transcript_path,
             s.head_sha_start, s.head_sha_end, s.last_output_preview, s.summary, s.runtime_state,
             s.resume_command, s.resume_metadata_json, s.chat_idle_since_at
        from terminal_sessions s
        left join lanes l on l.id = s.lane_id
       where l.project_id = ?
       order by s.started_at desc
       limit 200
    """

    return query(sql, bind: { [self] statement in
      try self.bindText(projectId, to: statement, index: 1)
    }) { statement in
      SessionRow(
        id: stringValue(statement, index: 0) ?? "",
        laneId: stringValue(statement, index: 1) ?? "",
        laneName: stringValue(statement, index: 2) ?? "",
        ptyId: stringValue(statement, index: 3),
        tracked: sqlite3_column_int(statement, 4) == 1,
        pinned: sqlite3_column_int(statement, 5) == 1,
        manuallyNamed: sqlite3_column_int(statement, 6) == 1,
        goal: stringValue(statement, index: 7),
        toolType: stringValue(statement, index: 8),
        title: stringValue(statement, index: 9) ?? "",
        status: stringValue(statement, index: 10) ?? "unknown",
        startedAt: stringValue(statement, index: 11) ?? "",
        endedAt: stringValue(statement, index: 12),
        exitCode: columnIsNull(statement, index: 13) ? nil : Int(sqlite3_column_int64(statement, 13)),
        transcriptPath: stringValue(statement, index: 14) ?? "",
        headShaStart: stringValue(statement, index: 15),
        headShaEnd: stringValue(statement, index: 16),
        lastOutputPreview: stringValue(statement, index: 17),
        summary: stringValue(statement, index: 18),
        runtimeState: stringValue(statement, index: 19) ?? runtimeState(for: stringValue(statement, index: 10) ?? "unknown"),
        resumeCommand: stringValue(statement, index: 20),
        resumeMetadata: decodeJson(stringValue(statement, index: 21), as: TerminalResumeMetadata.self),
        chatIdleSinceAt: stringValue(statement, index: 22)
      )
    }.map { row in
      TerminalSessionSummary(
        id: row.id,
        laneId: row.laneId,
        laneName: row.laneName,
        ptyId: row.ptyId,
        tracked: row.tracked,
        pinned: row.pinned,
        manuallyNamed: row.manuallyNamed,
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
        runtimeState: row.runtimeState,
        resumeCommand: row.resumeCommand,
        resumeMetadata: row.resumeMetadata,
        chatIdleSinceAt: row.chatIdleSinceAt
      )
    }
  }

  func updateSessionTitle(sessionId: String, title: String) throws {
    guard db != nil else { return }
    let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    _ = try execute("update terminal_sessions set title = ? where id = ?") { statement in
      try bindText(trimmed, to: statement, index: 1)
      try bindText(sessionId, to: statement, index: 2)
    }
    notifyDidChange()
  }

  func setSessionPinned(sessionId: String, pinned: Bool) throws {
    guard db != nil else { return }
    _ = try execute("update terminal_sessions set pinned = ? where id = ?") { statement in
      sqlite3_bind_int(statement, 1, pinned ? 1 : 0)
      try bindText(sessionId, to: statement, index: 2)
    }
    notifyDidChange()
  }

  func fetchComputerUseArtifacts(ownerKind: String, ownerId: String) -> [ComputerUseArtifactSummary] {
    guard let projectId = currentProjectId() else { return [] }

    let sql = """
      select a.id, a.artifact_kind, a.backend_style, a.backend_name, a.source_tool_name, a.original_type,
             a.title, a.description, a.uri, a.storage_kind, a.mime_type, a.metadata_json, a.created_at,
             l.owner_kind, l.owner_id, l.relation
        from computer_use_artifacts a
        inner join computer_use_artifact_links l on l.artifact_id = a.id
       where a.project_id = ?
         and l.project_id = ?
         and l.owner_kind = ?
         and l.owner_id = ?
       order by a.created_at asc
    """

    return query(sql, bind: { [self] statement in
      try self.bindText(projectId, to: statement, index: 1)
      try self.bindText(projectId, to: statement, index: 2)
      try self.bindText(ownerKind, to: statement, index: 3)
      try self.bindText(ownerId, to: statement, index: 4)
    }, map: { statement in
      ComputerUseArtifactRow(
        id: stringValue(statement, index: 0) ?? "",
        artifactKind: stringValue(statement, index: 1) ?? "",
        backendStyle: stringValue(statement, index: 2) ?? "",
        backendName: stringValue(statement, index: 3) ?? "",
        sourceToolName: stringValue(statement, index: 4),
        originalType: stringValue(statement, index: 5),
        title: stringValue(statement, index: 6) ?? "",
        description: stringValue(statement, index: 7),
        uri: stringValue(statement, index: 8) ?? "",
        storageKind: stringValue(statement, index: 9) ?? "",
        mimeType: stringValue(statement, index: 10),
        metadataJson: stringValue(statement, index: 11),
        createdAt: stringValue(statement, index: 12) ?? "",
        ownerKind: stringValue(statement, index: 13) ?? "",
        ownerId: stringValue(statement, index: 14) ?? "",
        relation: stringValue(statement, index: 15) ?? "attached_to"
      )
    }).map { row in
      let reviewMetadata = decodeJson(row.metadataJson, as: ComputerUseArtifactReviewMetadata.self)
      return ComputerUseArtifactSummary(
        id: row.id,
        artifactKind: row.artifactKind,
        backendStyle: row.backendStyle,
        backendName: row.backendName,
        sourceToolName: row.sourceToolName,
        originalType: row.originalType,
        title: row.title,
        description: row.description,
        uri: row.uri,
        storageKind: row.storageKind,
        mimeType: row.mimeType,
        metadataJson: row.metadataJson,
        createdAt: row.createdAt,
        ownerKind: row.ownerKind,
        ownerId: row.ownerId,
        relation: row.relation,
        reviewState: reviewMetadata?.reviewState,
        workflowState: reviewMetadata?.workflowState,
        reviewNote: reviewMetadata?.reviewNote
      )
    }
  }

  func fetchPullRequests() -> [PrSummary] {
    guard let projectId = currentProjectId() else { return [] }
    let sql = """
      select id, lane_id, project_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
             title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
             last_synced_at, created_at, updated_at
        from pull_requests
       where project_id = ?
       order by updated_at desc
    """
    return query(sql, bind: { [self] statement in
      try self.bindText(projectId, to: statement, index: 1)
    }) { statement in
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

  func fetchPullRequestListItems() -> [PullRequestListItem] {
    fetchPullRequestListItems(forLane: nil)
  }

  func fetchPullRequestListItems(forLane laneId: String?) -> [PullRequestListItem] {
    guard let projectId = currentProjectId() else { return [] }
    let hasPrGroupContext = hasTable(named: "pr_group_members")
      && hasTable(named: "pr_groups")
      && tableHasColumn(tableName: "pr_group_members", columnName: "group_id")
      && tableHasColumn(tableName: "pr_group_members", columnName: "pr_id")
      && tableHasColumn(tableName: "pr_group_members", columnName: "position")
      && tableHasColumn(tableName: "pr_groups", columnName: "id")
      && tableHasColumn(tableName: "pr_groups", columnName: "group_type")
      && tableHasColumn(tableName: "pr_groups", columnName: "name")

    let hasIntegrationWorkflowContext = hasTable(named: "integration_proposals")
      && tableHasColumn(tableName: "integration_proposals", columnName: "linked_pr_id")
      && tableHasColumn(tableName: "integration_proposals", columnName: "workflow_display_state")
      && tableHasColumn(tableName: "integration_proposals", columnName: "cleanup_state")
      && tableHasColumn(tableName: "integration_proposals", columnName: "linked_group_id")

    let prGroupSelect = hasPrGroupContext
      ? """
             gm.group_id,
             g.group_type,
             g.name,
             gm.position,
             coalesce(group_counts.member_count, 0),
      """
      : """
             null as group_id,
             null as group_type,
             null as group_name,
             null as position,
             0 as member_count,
      """

    let integrationSelect = hasIntegrationWorkflowContext
      ? """
             ip.workflow_display_state,
             ip.cleanup_state,
             ip.linked_group_id
      """
      : """
             null as workflow_display_state,
             null as cleanup_state,
             null as linked_group_id
      """

    let prGroupJoins = hasPrGroupContext
      ? """
        left join pr_group_members gm on gm.pr_id = pr.id
        left join pr_groups g on g.id = gm.group_id
        left join (
          select group_id, count(*) as member_count
            from pr_group_members
           group by group_id
        ) group_counts on group_counts.group_id = gm.group_id
      """
      : ""

    let integrationJoin = hasIntegrationWorkflowContext
      ? "left join integration_proposals ip on ip.linked_pr_id = pr.id"
      : ""

    let sql = """
      select pr.id,
             pr.lane_id,
             l.name,
             pr.project_id,
             pr.repo_owner,
             pr.repo_name,
             pr.github_pr_number,
             pr.github_url,
             pr.title,
             pr.state,
             pr.base_branch,
             pr.head_branch,
             pr.checks_status,
             pr.review_status,
             pr.additions,
             pr.deletions,
             pr.last_synced_at,
             pr.created_at,
             pr.updated_at,
    \(prGroupSelect)
    \(integrationSelect)
        from pull_requests pr
        left join lanes l on l.id = pr.lane_id and l.project_id = pr.project_id
    \(prGroupJoins)
    \(integrationJoin)
    """
    let filteredSQL: String
    if laneId == nil {
      filteredSQL = sql + " where pr.project_id = ? order by pr.updated_at desc"
    } else {
      filteredSQL = sql + " where pr.project_id = ? and pr.lane_id = ? order by pr.updated_at desc"
    }

    let bindFn: (OpaquePointer) throws -> Void = { [self] statement in
      try self.bindText(projectId, to: statement, index: 1)
      if let laneId {
        try self.bindText(laneId, to: statement, index: 2)
      }
    }

    return query(filteredSQL, bind: bindFn) { statement in
      let row = PullRequestListItemRow(
        id: stringValue(statement, index: 0) ?? "",
        laneId: stringValue(statement, index: 1) ?? "",
        laneName: stringValue(statement, index: 2),
        projectId: stringValue(statement, index: 3) ?? "",
        repoOwner: stringValue(statement, index: 4) ?? "",
        repoName: stringValue(statement, index: 5) ?? "",
        githubPrNumber: Int(sqlite3_column_int64(statement, 6)),
        githubUrl: stringValue(statement, index: 7) ?? "",
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
        updatedAt: stringValue(statement, index: 18) ?? "",
        groupId: stringValue(statement, index: 19),
        groupType: stringValue(statement, index: 20),
        groupName: stringValue(statement, index: 21),
        groupPosition: columnIsNull(statement, index: 22) ? nil : Int(sqlite3_column_int64(statement, 22)),
        groupCount: Int(sqlite3_column_int64(statement, 23)),
        workflowDisplayState: stringValue(statement, index: 24),
        cleanupState: stringValue(statement, index: 25),
        linkedWorkflowGroupId: stringValue(statement, index: 26)
      )

      let adeKind: String?
      if row.workflowDisplayState != nil || row.cleanupState != nil {
        adeKind = "integration"
      } else if row.groupType == "queue" {
        adeKind = "queue"
      } else if row.groupType == "integration" {
        adeKind = "integration"
      } else {
        adeKind = "single"
      }

      return PullRequestListItem(
        id: row.id,
        laneId: row.laneId,
        laneName: row.laneName,
        projectId: row.projectId,
        repoOwner: row.repoOwner,
        repoName: row.repoName,
        githubPrNumber: row.githubPrNumber,
        githubUrl: row.githubUrl,
        title: row.title,
        state: row.state,
        baseBranch: row.baseBranch,
        headBranch: row.headBranch,
        checksStatus: row.checksStatus,
        reviewStatus: row.reviewStatus,
        additions: row.additions,
        deletions: row.deletions,
        lastSyncedAt: row.lastSyncedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        adeKind: adeKind,
        linkedGroupId: row.linkedWorkflowGroupId ?? row.groupId,
        linkedGroupType: row.groupType,
        linkedGroupName: row.groupName,
        linkedGroupPosition: row.groupPosition,
        linkedGroupCount: row.groupCount,
        workflowDisplayState: row.workflowDisplayState,
        cleanupState: row.cleanupState
      )
    }
  }

  func fetchPullRequestGroupMembers(groupId: String) -> [PrGroupMemberSummary] {
    guard let projectId = currentProjectId() else { return [] }
    let sql = """
      select gm.group_id,
             g.group_type,
             g.name,
             g.target_branch,
             pr.id,
             pr.lane_id,
             coalesce(l.name, pr.lane_id),
             pr.title,
             pr.state,
             pr.github_pr_number,
             pr.github_url,
             pr.base_branch,
             pr.head_branch,
             gm.position
        from pr_group_members gm
        join pr_groups g on g.id = gm.group_id
        join pull_requests pr on pr.id = gm.pr_id
        left join lanes l on l.id = pr.lane_id and l.project_id = pr.project_id
       where gm.group_id = ?
         and g.project_id = ?
         and pr.project_id = ?
       order by gm.position asc, pr.updated_at desc
    """

    return query(sql, bind: { [self] statement in
      try self.bindText(groupId, to: statement, index: 1)
      try self.bindText(projectId, to: statement, index: 2)
      try self.bindText(projectId, to: statement, index: 3)
    }, map: { statement in
      PrGroupMemberSummary(
        groupId: stringValue(statement, index: 0) ?? "",
        groupType: stringValue(statement, index: 1) ?? "single",
        groupName: stringValue(statement, index: 2),
        targetBranch: stringValue(statement, index: 3),
        prId: stringValue(statement, index: 4) ?? "",
        laneId: stringValue(statement, index: 5) ?? "",
        laneName: stringValue(statement, index: 6) ?? "",
        title: stringValue(statement, index: 7) ?? "",
        state: stringValue(statement, index: 8) ?? "open",
        githubPrNumber: Int(sqlite3_column_int64(statement, 9)),
        githubUrl: stringValue(statement, index: 10) ?? "",
        baseBranch: stringValue(statement, index: 11) ?? "",
        headBranch: stringValue(statement, index: 12) ?? "",
        position: Int(sqlite3_column_int64(statement, 13))
      )
    })
  }

  func fetchIntegrationProposals() -> [IntegrationProposal] {
    guard let projectId = currentProjectId() else { return [] }
    let sql = """
      select id,
             source_lane_ids_json,
             base_branch,
             pairwise_results_json,
             lane_summaries_json,
             steps_json,
             overall_outcome,
             created_at,
             title,
             body,
             draft,
             integration_lane_name,
             status,
             integration_lane_id,
             linked_group_id,
             linked_pr_id,
             workflow_display_state,
             cleanup_state,
             closed_at,
             merged_at,
             completed_at,
             cleanup_declined_at,
             cleanup_completed_at,
             preferred_integration_lane_id,
             merge_into_head_sha,
             resolution_state_json
        from integration_proposals
       where project_id = ?
       order by created_at desc
    """

    return query(sql, bind: { [self] statement in
      try self.bindText(projectId, to: statement, index: 1)
    }, map: { statement in
      IntegrationProposalRow(
        proposalId: stringValue(statement, index: 0) ?? "",
        sourceLaneIdsJson: stringValue(statement, index: 1) ?? "[]",
        baseBranch: stringValue(statement, index: 2) ?? "",
        pairwiseResultsJson: stringValue(statement, index: 3) ?? "[]",
        laneSummariesJson: stringValue(statement, index: 4) ?? "[]",
        stepsJson: stringValue(statement, index: 5) ?? "[]",
        overallOutcome: stringValue(statement, index: 6) ?? "pending",
        createdAt: stringValue(statement, index: 7) ?? "",
        title: stringValue(statement, index: 8),
        body: stringValue(statement, index: 9),
        draft: sqlite3_column_int(statement, 10) == 1,
        integrationLaneName: stringValue(statement, index: 11),
        status: stringValue(statement, index: 12) ?? "proposed",
        integrationLaneId: stringValue(statement, index: 13),
        linkedGroupId: stringValue(statement, index: 14),
        linkedPrId: stringValue(statement, index: 15),
        workflowDisplayState: stringValue(statement, index: 16),
        cleanupState: stringValue(statement, index: 17),
        closedAt: stringValue(statement, index: 18),
        mergedAt: stringValue(statement, index: 19),
        completedAt: stringValue(statement, index: 20),
        cleanupDeclinedAt: stringValue(statement, index: 21),
        cleanupCompletedAt: stringValue(statement, index: 22),
        preferredIntegrationLaneId: stringValue(statement, index: 23),
        mergeIntoHeadSha: stringValue(statement, index: 24),
        resolutionStateJson: stringValue(statement, index: 25)
      )
    }).map { row in
      IntegrationProposal(
        proposalId: row.proposalId,
        sourceLaneIds: decodeJson(row.sourceLaneIdsJson, as: [String].self) ?? [],
        baseBranch: row.baseBranch,
        pairwiseResults: decodeJson(row.pairwiseResultsJson, as: [IntegrationPairwiseResult].self) ?? [],
        laneSummaries: decodeJson(row.laneSummariesJson, as: [IntegrationLaneSummary].self) ?? [],
        steps: decodeJson(row.stepsJson, as: [IntegrationProposalStep].self) ?? [],
        overallOutcome: row.overallOutcome,
        createdAt: row.createdAt,
        title: row.title,
        body: row.body,
        draft: row.draft,
        integrationLaneName: row.integrationLaneName,
        status: row.status,
        integrationLaneId: row.integrationLaneId,
        integrationLaneOrigin: integrationLaneOrigin(
          integrationLaneId: row.integrationLaneId,
          preferredIntegrationLaneId: row.preferredIntegrationLaneId
        ),
        linkedGroupId: row.linkedGroupId,
        linkedPrId: row.linkedPrId,
        workflowDisplayState: row.workflowDisplayState,
        cleanupState: row.cleanupState,
        closedAt: row.closedAt,
        mergedAt: row.mergedAt,
        completedAt: row.completedAt,
        cleanupDeclinedAt: row.cleanupDeclinedAt,
        cleanupCompletedAt: row.cleanupCompletedAt,
        preferredIntegrationLaneId: row.preferredIntegrationLaneId,
        mergeIntoHeadSha: row.mergeIntoHeadSha,
        resolutionState: decodeJson(row.resolutionStateJson, as: IntegrationResolutionState.self)
      )
    }
  }

  private func integrationLaneOrigin(
    integrationLaneId: String?,
    preferredIntegrationLaneId: String?
  ) -> String? {
    let integration = integrationLaneId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !integration.isEmpty else { return nil }
    let preferred = preferredIntegrationLaneId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return preferred == integration ? "adopted" : "ade-created"
  }

  func fetchQueueStates() -> [QueueLandingState] {
    let sql = """
      select q.id,
             q.group_id,
             g.name,
             g.target_branch,
             q.state,
             q.entries_json,
             q.config_json,
             q.current_position,
             q.active_pr_id,
             q.active_resolver_run_id,
             q.last_error,
             q.wait_reason,
             q.started_at,
             q.completed_at,
             q.updated_at
        from queue_landing_state q
        left join pr_groups g on g.id = q.group_id
       order by q.updated_at desc, q.started_at desc
    """

    return query(sql) { statement in
      QueueStateRow(
        queueId: stringValue(statement, index: 0) ?? "",
        groupId: stringValue(statement, index: 1) ?? "",
        groupName: stringValue(statement, index: 2),
        targetBranch: stringValue(statement, index: 3),
        state: stringValue(statement, index: 4) ?? "idle",
        entriesJson: stringValue(statement, index: 5) ?? "[]",
        configJson: stringValue(statement, index: 6) ?? "{}",
        currentPosition: Int(sqlite3_column_int64(statement, 7)),
        activePrId: stringValue(statement, index: 8),
        activeResolverRunId: stringValue(statement, index: 9),
        lastError: stringValue(statement, index: 10),
        waitReason: stringValue(statement, index: 11),
        startedAt: stringValue(statement, index: 12) ?? "",
        completedAt: stringValue(statement, index: 13),
        updatedAt: stringValue(statement, index: 14)
      )
    }.map { row in
      QueueLandingState(
        queueId: row.queueId,
        groupId: row.groupId,
        groupName: row.groupName,
        targetBranch: row.targetBranch,
        state: row.state,
        entries: decodeJson(row.entriesJson, as: [QueueLandingEntry].self) ?? [],
        currentPosition: row.currentPosition,
        activePrId: row.activePrId,
        activeResolverRunId: row.activeResolverRunId,
        lastError: row.lastError,
        waitReason: row.waitReason,
        config: decodeJson(row.configJson, as: QueueAutomationConfig.self) ?? QueueAutomationConfig(
          method: "squash",
          archiveLane: false,
          autoResolve: false,
          ciGating: false,
          resolverProvider: nil,
          resolverModel: nil,
          reasoningEffort: nil,
          permissionMode: nil,
          confidenceThreshold: nil,
          originSurface: nil,
          originMissionId: nil,
          originRunId: nil,
          originLabel: nil
        ),
        startedAt: row.startedAt,
        completedAt: row.completedAt,
        updatedAt: row.updatedAt ?? row.startedAt
      )
    }
  }

  func fetchPullRequestSnapshot(prId: String) -> PullRequestSnapshot? {
    guard let projectId = currentProjectId() else { return nil }
    let sql = """
      select s.detail_json, s.status_json, s.checks_json, s.reviews_json, s.comments_json, s.files_json, s.commits_json
        from pull_request_snapshots s
        join pull_requests pr on pr.id = s.pr_id
       where s.pr_id = ?
         and pr.project_id = ?
       limit 1
    """
    guard let row = querySingle(sql, bind: { [self] statement in
      try self.bindText(prId, to: statement, index: 1)
      try self.bindText(projectId, to: statement, index: 2)
    }, map: { statement in
      PullRequestSnapshotRow(
        detailJson: stringValue(statement, index: 0),
        statusJson: stringValue(statement, index: 1),
        checksJson: stringValue(statement, index: 2),
        reviewsJson: stringValue(statement, index: 3),
        commentsJson: stringValue(statement, index: 4),
        filesJson: stringValue(statement, index: 5),
        commitsJson: stringValue(statement, index: 6)
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
      files: decodeJson(row.filesJson, as: [PrFile].self) ?? [],
      commits: decodeJson(row.commitsJson, as: [PrCommit].self)
    )
  }

  func executeSqlForTesting(_ sql: String) throws {
    try exec(sql)
    notifyDidChange()
  }

  func hasHydratedControllerData() -> Bool {
    let laneCount = hasTable(named: "lanes") ? (queryInt64("select count(*) from lanes") ?? 0) : 0
    let sessionCount = hasTable(named: "terminal_sessions") ? (queryInt64("select count(*) from terminal_sessions") ?? 0) : 0
    let pullRequestCount = hasTable(named: "pull_requests") ? (queryInt64("select count(*) from pull_requests") ?? 0) : 0
    return laneCount > 0 || sessionCount > 0 || pullRequestCount > 0
  }

  private func migrateAndPrepare() throws {
    try exec("pragma journal_mode = wal")
    try exec("pragma synchronous = normal")
    try exec("pragma busy_timeout = 5000")

    let bootstrapSQL = try loadBootstrapSQL()
    try executeBootstrapSQL(bootstrapSQL)
    try ensureHydrationProjectionColumns()
    try ensureSyncMetadataTables()
    try ensureCrrTables()
    try repairPullRequestProjectionIntegrity()

    let desiredSiteId = localSiteId()
    cachedSiteIdHex = desiredSiteId
    cachedSiteIdBlob = Data(hex: desiredSiteId) ?? Data()
    try forceSiteId(desiredSiteId)
    if readCurrentSiteId() != desiredSiteId {
      close()
      try openConnection(at: dbURL)
      try exec("pragma journal_mode = wal")
      try exec("pragma synchronous = normal")
      try exec("pragma busy_timeout = 5000")
      try ensureSyncMetadataTables()
      try forceSiteId(desiredSiteId)
    }
    localDbVersion = readMaxDbVersion()
  }

  private func repairPullRequestProjectionIntegrity() throws {
    guard hasTable(named: "pull_requests") else { return }

    let previousCaptureState = shouldCaptureLocalChanges
    shouldCaptureLocalChanges = false
    defer { shouldCaptureLocalChanges = previousCaptureState }

    for tableName in [
      "pull_request_snapshots",
      "pull_request_ai_summaries",
      "pr_group_members",
      "pr_issue_inventory",
      "pr_pipeline_settings",
      "pr_convergence_state",
    ] where hasTable(named: tableName) && tableHasColumn(tableName: tableName, columnName: "pr_id") {
      try exec("""
        delete from \(tableName)
         where pr_id is not null
           and not exists (
             select 1
               from pull_requests
              where pull_requests.id = \(tableName).pr_id
           )
      """)
    }
  }

  private func ensureHydrationProjectionColumns() throws {
    try ensureColumn(
      tableName: "lanes",
      columnName: "attached_root_path",
      definition: "text"
    )
    try ensureColumn(
      tableName: "lanes",
      columnName: "is_edit_protected",
      definition: "integer not null default 0"
    )
    try ensureColumn(
      tableName: "lanes",
      columnName: "color",
      definition: "text"
    )
    try ensureColumn(
      tableName: "lanes",
      columnName: "icon",
      definition: "text"
    )
    try ensureColumn(
      tableName: "lanes",
      columnName: "tags_json",
      definition: "text"
    )
    try ensureColumn(
      tableName: "lanes",
      columnName: "folder",
      definition: "text"
    )
    try ensureColumn(
      tableName: "lanes",
      columnName: "mission_id",
      definition: "text"
    )
    try ensureColumn(
      tableName: "lanes",
      columnName: "lane_role",
      definition: "text"
    )
    try ensureColumn(
      tableName: "terminal_sessions",
      columnName: "lane_name",
      definition: "text not null default ''"
    )
    try ensureColumn(
      tableName: "terminal_sessions",
      columnName: "resume_command",
      definition: "text"
    )
    try ensureColumn(
      tableName: "terminal_sessions",
      columnName: "resume_metadata_json",
      definition: "text"
    )
    try ensureColumn(
      tableName: "terminal_sessions",
      columnName: "manually_named",
      definition: "integer not null default 0"
    )
    try ensureColumn(
      tableName: "terminal_sessions",
      columnName: "runtime_state",
      definition: "text not null default 'running'"
    )
    try ensureColumn(
      tableName: "terminal_sessions",
      columnName: "chat_idle_since_at",
      definition: "text"
    )
    try exec("""
      create table if not exists lane_list_snapshots (
        lane_id text primary key,
        snapshot_json text not null,
        updated_at text not null,
        foreign key(lane_id) references lanes(id)
      )
    """)
    try exec("create index if not exists idx_lane_list_snapshots_updated_at on lane_list_snapshots(updated_at)")
    try exec("""
      create table if not exists lane_detail_snapshots (
        lane_id text primary key,
        detail_json text not null,
        updated_at text not null,
        foreign key(lane_id) references lanes(id)
      )
    """)
    try exec("create index if not exists idx_lane_detail_snapshots_updated_at on lane_detail_snapshots(updated_at)")
    try ensurePullRequestProjectionTables()

    for col in [
      "execution_lane_id", "supervisor_identity_key", "review_ready_reason",
      "pr_state", "pr_checks_status", "pr_review_status",
      "latest_review_note", "route_context_json", "execution_context_json",
    ] {
      try ensureColumn(tableName: "linear_workflow_runs", columnName: col, definition: "text")
    }

    try ensureColumn(tableName: "pr_issue_inventory", columnName: "thread_comment_count", definition: "integer")
    try ensureColumn(tableName: "pr_issue_inventory", columnName: "thread_latest_comment_id", definition: "text")
    try ensureColumn(tableName: "pr_issue_inventory", columnName: "thread_latest_comment_author", definition: "text")
    try ensureColumn(tableName: "pr_issue_inventory", columnName: "thread_latest_comment_at", definition: "text")
    try ensureColumn(tableName: "pr_issue_inventory", columnName: "thread_latest_comment_source", definition: "text")

    try ensureColumn(tableName: "integration_proposals", columnName: "linked_group_id", definition: "text")
    try ensureColumn(tableName: "integration_proposals", columnName: "linked_pr_id", definition: "text")
    try ensureColumn(tableName: "integration_proposals", columnName: "workflow_display_state", definition: "text not null default 'active'")
    try ensureColumn(tableName: "integration_proposals", columnName: "cleanup_state", definition: "text not null default 'none'")
    try ensureColumn(tableName: "integration_proposals", columnName: "closed_at", definition: "text")
    try ensureColumn(tableName: "integration_proposals", columnName: "merged_at", definition: "text")
    try ensureColumn(tableName: "integration_proposals", columnName: "completed_at", definition: "text")
    try ensureColumn(tableName: "integration_proposals", columnName: "cleanup_declined_at", definition: "text")
    try ensureColumn(tableName: "integration_proposals", columnName: "cleanup_completed_at", definition: "text")
    try ensureColumn(tableName: "integration_proposals", columnName: "preferred_integration_lane_id", definition: "text")
    try ensureColumn(tableName: "integration_proposals", columnName: "merge_into_head_sha", definition: "text")

    try ensureColumn(tableName: "queue_landing_state", columnName: "config_json", definition: "text not null default '{}'")
    try ensureColumn(tableName: "queue_landing_state", columnName: "active_pr_id", definition: "text")
    try ensureColumn(tableName: "queue_landing_state", columnName: "active_resolver_run_id", definition: "text")
    try ensureColumn(tableName: "queue_landing_state", columnName: "last_error", definition: "text")
    try ensureColumn(tableName: "queue_landing_state", columnName: "wait_reason", definition: "text")
    try ensureColumn(tableName: "queue_landing_state", columnName: "updated_at", definition: "text")
    try exec("create index if not exists idx_pull_requests_project_updated on pull_requests(project_id, updated_at desc)")
    try exec("create index if not exists idx_queue_landing_state_project_updated on queue_landing_state(project_id, updated_at desc, started_at desc)")

    try ensureColumn(tableName: "missions", columnName: "mission_lane_id", definition: "text")
    try ensureColumn(tableName: "missions", columnName: "result_lane_id", definition: "text")
    try ensureColumn(tableName: "missions", columnName: "queue_claim_token", definition: "text")
    try ensureColumn(tableName: "missions", columnName: "queue_claimed_at", definition: "text")
    try ensureColumn(tableName: "missions", columnName: "archived_at", definition: "text")

    try ensureColumn(tableName: "mission_interventions", columnName: "resolution_kind", definition: "text")
    try ensureColumn(tableName: "unified_memories", columnName: "access_score", definition: "real not null default 0")
    try ensureColumn(tableName: "worker_agents", columnName: "linear_identity_json", definition: "text not null default '{}'")
  }

  private func ensurePullRequestProjectionTables() throws {
    try exec("""
      create table if not exists pull_requests (
        id text primary key,
        project_id text not null,
        lane_id text not null,
        repo_owner text not null,
        repo_name text not null,
        github_pr_number integer not null,
        github_url text not null,
        github_node_id text,
        title text,
        state text not null,
        base_branch text not null,
        head_branch text not null,
        checks_status text,
        review_status text,
        additions integer not null default 0,
        deletions integer not null default 0,
        last_synced_at text,
        created_at text not null,
        updated_at text not null,
        last_polled_at text,
        head_sha text
      )
    """)
    try ensureColumn(tableName: "pull_requests", columnName: "last_polled_at", definition: "text")
    try ensureColumn(tableName: "pull_requests", columnName: "head_sha", definition: "text")
    try ensureColumn(tableName: "pull_requests", columnName: "creation_strategy", definition: "text")
    try exec("""
      create table if not exists pull_request_snapshots (
        pr_id text primary key,
        detail_json text,
        status_json text,
        checks_json text,
        reviews_json text,
        comments_json text,
        files_json text,
        updated_at text not null
      )
    """)
    try exec("create index if not exists idx_pull_request_snapshots_updated_at on pull_request_snapshots(updated_at)")
    try ensureColumn(tableName: "pull_request_snapshots", columnName: "commits_json", definition: "text")
    try exec("""
      create table if not exists pull_request_ai_summaries (
        pr_id text not null,
        head_sha text not null,
        summary_json text not null,
        generated_at text not null,
        primary key(pr_id, head_sha)
      )
    """)
    try exec("create index if not exists idx_pr_ai_summaries_pr_id on pull_request_ai_summaries(pr_id)")
    try exec("""
      create table if not exists pr_groups (
        id text primary key,
        project_id text not null,
        group_type text not null,
        name text,
        auto_rebase integer not null default 0,
        ci_gating integer not null default 0,
        target_branch text,
        created_at text not null
      )
    """)
    try exec("create index if not exists idx_pr_groups_project on pr_groups(project_id)")
    try exec("""
      create table if not exists pr_group_members (
        id text primary key,
        group_id text not null,
        pr_id text not null,
        lane_id text not null,
        position integer not null,
        role text not null
      )
    """)
    try exec("create index if not exists idx_pr_group_members_group on pr_group_members(group_id)")
    try exec("create index if not exists idx_pr_group_members_pr on pr_group_members(pr_id)")
    try exec("""
      create table if not exists integration_proposals (
        id text primary key,
        project_id text not null,
        source_lane_ids_json text not null default '[]',
        base_branch text not null default '',
        steps_json text not null default '[]',
        title text default '',
        body text default '',
        draft integer not null default 0,
        integration_lane_name text default '',
        status text not null default 'proposed',
        integration_lane_id text,
        resolution_state_json text,
        pairwise_results_json text not null default '[]',
        lane_summaries_json text not null default '[]',
        overall_outcome text not null default 'pending',
        created_at text not null default '',
        linked_group_id text,
        linked_pr_id text,
        workflow_display_state text not null default 'active',
        cleanup_state text not null default 'none',
        closed_at text,
        merged_at text,
        completed_at text,
        cleanup_declined_at text,
        cleanup_completed_at text,
        preferred_integration_lane_id text,
        merge_into_head_sha text
      )
    """)
    try exec("create index if not exists idx_integration_proposals_project on integration_proposals(project_id)")
    try exec("""
      create table if not exists queue_landing_state (
        id text primary key,
        group_id text not null,
        project_id text not null,
        state text not null,
        entries_json text not null,
        config_json text not null default '{}',
        current_position integer not null default 0,
        active_pr_id text,
        active_resolver_run_id text,
        last_error text,
        wait_reason text,
        started_at text not null,
        completed_at text,
        updated_at text
      )
    """)
    try exec("create index if not exists idx_queue_landing_state_group on queue_landing_state(group_id)")
  }

  private func ensureColumn(tableName: String, columnName: String, definition: String) throws {
    guard hasTable(named: tableName), !tableHasColumn(tableName: tableName, columnName: columnName) else { return }
    try exec("alter table \(tableName) add column \(columnName) \(definition)")
  }

  private func openConnection(at url: URL) throws {
    var opened: OpaquePointer?
    let flags = SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
    guard sqlite3_open_v2(url.path, &opened, flags, nil) == SQLITE_OK, let opened else {
      let message = sqlite3_errmsg(opened).map { String(cString: $0) } ?? "Unable to open SQLite database."
      sqlite3_close(opened)
      throw sqliteError(message)
    }
    db = opened
    try exec("pragma foreign_keys = on")
    try registerInternalFunctions()
    localDbVersion = readMaxDbVersion()
  }

  private func deleteStalePullRequestRows(projectId: String, keeping prIds: [String]) throws {
    let childTables = [
      "pull_request_ai_summaries",
      "pr_group_members",
      "pr_issue_inventory",
      "pr_pipeline_settings",
      "pr_convergence_state",
    ]

    if prIds.isEmpty {
      for table in childTables where hasTable(named: table) {
        _ = try execute("delete from \(table) where pr_id in (select id from pull_requests where project_id = ?)") { statement in
          try bindText(projectId, to: statement, index: 1)
        }
      }
      _ = try execute("delete from pull_requests where project_id = ?") { statement in
        try bindText(projectId, to: statement, index: 1)
      }
      return
    }

    let placeholders = Array(repeating: "?", count: prIds.count).joined(separator: ", ")
    func bindProjectAndPrIds(_ statement: OpaquePointer) throws {
      try bindText(projectId, to: statement, index: 1)
      for (index, prId) in prIds.enumerated() {
        try bindText(prId, to: statement, index: Int32(index + 2))
      }
    }

    for table in childTables where hasTable(named: table) {
      _ = try execute("""
        delete from \(table)
         where pr_id in (
           select id from pull_requests
            where project_id = ?
              and id not in (\(placeholders))
         )
      """, bind: bindProjectAndPrIds)
    }

    _ = try execute("""
      delete from pull_requests
       where project_id = ?
         and id not in (\(placeholders))
    """, bind: bindProjectAndPrIds)
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
    var currentStatement = ""
    for line in sql.split(omittingEmptySubsequences: false, whereSeparator: \.isNewline) {
      currentStatement.append(contentsOf: line)
      currentStatement.append("\n")

      let trimmed = currentStatement.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { continue }

      let isComplete = trimmed.withCString { sqlite3_complete($0) == 1 }
      guard isComplete else { continue }

      try runBootstrapStatement(trimmed)
      currentStatement.removeAll(keepingCapacity: true)
    }

    let trailing = currentStatement.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trailing.isEmpty {
      throw sqliteError("Database bootstrap SQL ended with an incomplete statement.")
    }
  }

  private func runBootstrapStatement(_ sql: String) throws {
    if let target = parseAlterTableAddColumnTarget(sql),
       hasTable(named: target.tableName),
       tableHasColumn(tableName: target.tableName, columnName: target.columnName) {
      return
    }

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
      // Desktop wraps `alter table ... add column` in try/catch for idempotency;
      // the extracted bootstrap loses that context, so tolerate the re-run here.
      if lowered.contains("alter table"), lowered.contains("add column"),
         message.contains("duplicate column name") {
        return
      }
      throw error
    }
  }

  private func ensureCrrTables() throws {
    // One-time cleanup: excluded cache/snapshot tables should not participate
    // in phone-side CRDT at all. Drop their CRR metadata and pending changes
    // so they only flow through explicit hydration commands.
    for cacheTable in DatabaseService.excludedCrrTables where hasTable(named: "\(cacheTable)__crsql_clock") {
      try dropCrrTriggers(for: cacheTable)
      try exec("drop table if exists \(quoteIdentifier("\(cacheTable)__crsql_clock"))")
      _ = try execute("delete from crsql_master where tbl_name = ?") { statement in
        try bindText(cacheTable, to: statement, index: 1)
      }
      _ = try execute("delete from crsql_changes where [table] = ?") { statement in
        try bindText(cacheTable, to: statement, index: 1)
      }
    }

    for tableName in listEligibleCrrTables() {
      if hasTable(named: "\(tableName)__crsql_clock") {
        continue
      }
      try enableCrr(for: tableName)
    }
  }

  /// Tables that exist on the iOS client only as local read-through caches.
  /// They are populated from sync responses, never edited by the user, and
  /// the host does NOT register them as CRR — so exporting CRDT changes for
  /// them produces "could not find schema information" errors upstream.
  private static let localOnlyCacheTables: Set<String> = [
    "lane_detail_snapshots",
    "lane_list_snapshots",
  ]

  /// Tables the phone replaces from explicit hydration commands after connect.
  /// Treating them as CRDT tables is redundant and can break first-connect
  /// materialization when the incoming delta stream is not row-complete.
  private static let hydrationOwnedCrrExcludedTables: Set<String> = [
    "lane_state_snapshots",
    "pull_request_snapshots",
  ]

  private static let excludedCrrTables = localOnlyCacheTables.union(hydrationOwnedCrrExcludedTables)

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
      !row.sql.lowercased().hasPrefix("create virtual table")
        && !DatabaseService.excludedCrrTables.contains(row.name)
        && tableHasPrimaryKey(row.name)
    }.map(\.name)
  }

  private func tableHasPrimaryKey(_ tableName: String) -> Bool {
    query("pragma table_info('\(tableName.replacingOccurrences(of: "'", with: "''"))')") { statement in
      sqlite3_column_int(statement, 5) > 0
    }.contains(true)
  }

  private func tableHasColumn(tableName: String, columnName: String) -> Bool {
    let normalizedColumnName = columnName.lowercased()
    return query("pragma table_info('\(tableName.replacingOccurrences(of: "'", with: "''"))')") { statement in
      (stringValue(statement, index: 1) ?? "").lowercased()
    }.contains(normalizedColumnName)
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
    queryString("select lower(hex(site_id)) from crsql_site_id where ordinal = 0 limit 1")
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
    let hasMalformedReplicaRows = hasMalformedTextPrimaryKeys(in: scratch)
    guard isLegacyCacheOnly || !hasCrrMetadata || hasMalformedReplicaRows else { return }

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

  private func hasMalformedTextPrimaryKeys(in handle: OpaquePointer?) -> Bool {
    let tableNames = query(with: handle, """
      select name
        from sqlite_master
       where type = 'table'
         and name not like 'sqlite_%'
         and name not like 'crsql_%'
         and name not like '%__crsql_clock'
         and name not like '%__crsql_pks'
    """) { statement in
      stringValue(statement, index: 0) ?? ""
    }

    for tableName in tableNames {
      let columns = query(with: handle, "pragma table_info('\(tableName.replacingOccurrences(of: "'", with: "''"))')") { statement in
        (
          name: stringValue(statement, index: 1) ?? "",
          declaredType: (stringValue(statement, index: 2) ?? "").uppercased(),
          pkIndex: Int(sqlite3_column_int(statement, 5))
        )
      }
      guard let primaryKey = columns.sorted(by: { $0.pkIndex < $1.pkIndex }).first(where: { $0.pkIndex > 0 }) else {
        continue
      }
      let looksText = primaryKey.declaredType.isEmpty
        || primaryKey.declaredType.contains("TEXT")
        || primaryKey.declaredType.contains("CHAR")
        || primaryKey.declaredType.contains("CLOB")
      guard looksText else {
        continue
      }

      let malformed = !query(with: handle, """
        select 1
          from \(quoteIdentifier(tableName))
         where typeof(\(quoteIdentifier(primaryKey.name))) = 'blob'
         limit 1
      """) { _ in true }.isEmpty
      if malformed {
        return true
      }
    }

    return false
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

  func setActiveProjectId(_ projectId: String?) {
    activeProjectIdOverride = projectId
  }

  func hasProject(id: String) -> Bool {
    guard hasTable(named: "projects") else { return false }
    return querySingle(
      "select 1 from projects where id = ? limit 1",
      bind: { [self] statement in
        try self.bindText(id, to: statement, index: 1)
      },
      map: { _ in true }
    ) ?? false
  }

  func listMobileProjects() -> [MobileProjectSummary] {
    guard hasTable(named: "projects") else { return [] }

    return query("""
      select
        p.id,
        p.display_name,
        p.root_path,
        p.default_base_ref,
        p.last_opened_at,
        coalesce((
          select count(*)
            from lanes l
           where l.project_id = p.id
             and l.archived_at is null
        ), 0) as lane_count
        from projects p
       order by p.last_opened_at desc, p.display_name collate nocase asc
    """) { statement in
      let id = stringValue(statement, index: 0) ?? ""
      let rootPath = stringValue(statement, index: 2)
      let fallbackName = rootPath?
        .split(separator: "/")
        .last
        .map(String.init)
      return MobileProjectSummary(
        id: id,
        displayName: stringValue(statement, index: 1) ?? fallbackName ?? "Project",
        rootPath: rootPath,
        defaultBaseRef: stringValue(statement, index: 3),
        lastOpenedAt: stringValue(statement, index: 4),
        laneCount: Int(sqlite3_column_int64(statement, 5)),
        isAvailable: true,
        isCached: true
      )
    }
  }

  func currentProjectId() -> String? {
    if let activeProjectIdOverride {
      return activeProjectIdOverride
    }
    return queryString("select id from projects order by last_opened_at desc, created_at desc limit 1")
  }

  private func projectCount() -> Int {
    Int(queryInt64("select count(*) from projects") ?? 0)
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

  private func prepareTemporaryIdTable(named tableName: String, ids: [String]) throws {
    let quotedName = quoteIdentifier(tableName)
    try exec("create temporary table if not exists \(quotedName) (id text primary key)")
    try exec("delete from \(quotedName)")
    for id in ids {
      _ = try execute("insert or ignore into \(quotedName)(id) values (?)") { statement in
        try bindText(id, to: statement, index: 1)
      }
    }
  }

  private func notifyDidChange() {
    NotificationCenter.default.post(name: .adeDatabaseDidChange, object: nil)
  }

  private func decodeJson<T: Decodable>(_ raw: String?, as type: T.Type) -> T? {
    guard let raw, let data = raw.data(using: .utf8) else { return nil }
    return try? decoder.decode(T.self, from: data)
  }

  private func bindOptionalJson<T: Encodable>(_ value: T?, to statement: OpaquePointer, index: Int32) throws {
    guard let value else {
      sqlite3_bind_null(statement, index)
      return
    }
    let data = try encoder.encode(value)
    guard let json = String(data: data, encoding: .utf8) else {
      throw sqliteError("Unable to encode JSON for local hydration.")
    }
    try bindText(json, to: statement, index: index)
  }

  private func encodeJsonString<T: Encodable>(_ value: T) throws -> String {
    let data = try encoder.encode(value)
    guard let json = String(data: data, encoding: .utf8) else {
      throw sqliteError("Unable to encode JSON for local hydration.")
    }
    return json
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
      try beginCrrAlter(tableName: alterTable)
      do {
        try run(sql)
      } catch {
        throw error
      }
      try commitCrrAlter(tableName: alterTable)
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

  private func tableExists(_ name: String) -> Bool {
    queryInt64("select 1 from sqlite_master where type = 'table' and name = ? limit 1") { [self] statement in
      try self.bindText(name, to: statement, index: 1)
    } != nil
  }

  private func parseAlterTableTarget(_ sql: String) -> String? {
    parseAlterTableAddColumnTarget(sql)?.tableName
  }

  private func parseAlterTableAddColumnTarget(_ sql: String) -> AlterTableAddColumnTarget? {
    var statement = sql.trimmingCharacters(in: .whitespacesAndNewlines)
    if statement.hasSuffix(";") {
      statement.removeLast()
    }

    let tokens = statement.split(whereSeparator: \.isWhitespace).map(String.init)
    guard tokens.count >= 6,
          tokens[0].caseInsensitiveCompare("alter") == .orderedSame,
          tokens[1].caseInsensitiveCompare("table") == .orderedSame,
          tokens[3].caseInsensitiveCompare("add") == .orderedSame,
          tokens[4].caseInsensitiveCompare("column") == .orderedSame else {
      return nil
    }

    return AlterTableAddColumnTarget(
      tableName: unquoteSqlIdentifier(tokens[2]),
      columnName: unquoteSqlIdentifier(tokens[5])
    )
  }

  private func unquoteSqlIdentifier(_ identifier: String) -> String {
    identifier
      .replacingOccurrences(of: "\"", with: "")
      .replacingOccurrences(of: "'", with: "")
      .replacingOccurrences(of: "`", with: "")
      .replacingOccurrences(of: "[", with: "")
      .replacingOccurrences(of: "]", with: "")
  }

  private func ensureSyncMetadataTables() throws {
    try run("""
      create table if not exists crsql_master (
        tbl_name text primary key,
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )
    """)
    try run("""
      create table if not exists crsql_site_id (
        ordinal integer primary key,
        site_id blob not null
      )
    """)
    try run("""
      create table if not exists crsql_changes (
        [table] text not null,
        pk,
        cid text not null,
        val,
        col_version integer not null,
        db_version integer not null,
        site_id blob not null,
        cl integer not null default 0,
        seq integer not null default 0
      )
    """)
    try run("create unique index if not exists idx_crsql_changes_unique on crsql_changes([table], pk, cid, db_version, site_id, cl, seq)")
    try run("create index if not exists idx_crsql_changes_version on crsql_changes(db_version, cl, seq)")
    try run("create index if not exists idx_crsql_changes_table_pk on crsql_changes([table], pk)")
  }

  private func registerInternalFunctions() throws {
    guard let db else { throw sqliteError("Database is not open.") }
    let context = Unmanaged.passUnretained(self).toOpaque()

    guard sqlite3_create_function_v2(
      db,
      "ade_next_db_version",
      0,
      SQLITE_UTF8,
      context,
      { rawContext, _, _ in
        guard let rawContext, let raw = sqlite3_user_data(rawContext) else {
          return
        }
        let service = Unmanaged<DatabaseService>.fromOpaque(raw).takeUnretainedValue()
        sqlite3_result_int64(rawContext, sqlite3_int64(service.nextLocalDbVersion()))
      },
      nil,
      nil,
      nil
    ) == SQLITE_OK else {
      throw sqliteError(sqliteMessage(db))
    }

    guard sqlite3_create_function_v2(
      db,
      "ade_capture_local_changes",
      0,
      SQLITE_UTF8 | SQLITE_DETERMINISTIC,
      context,
      { rawContext, _, _ in
        guard let rawContext, let raw = sqlite3_user_data(rawContext) else {
          return
        }
        let service = Unmanaged<DatabaseService>.fromOpaque(raw).takeUnretainedValue()
        sqlite3_result_int(rawContext, service.shouldCaptureLocalChanges ? 1 : 0)
      },
      nil,
      nil,
      nil
    ) == SQLITE_OK else {
      throw sqliteError(sqliteMessage(db))
    }

    guard sqlite3_create_function_v2(
      db,
      "ade_local_site_id",
      0,
      SQLITE_UTF8 | SQLITE_DETERMINISTIC,
      context,
      { rawContext, _, _ in
        guard let rawContext, let raw = sqlite3_user_data(rawContext) else {
          return
        }
        let service = Unmanaged<DatabaseService>.fromOpaque(raw).takeUnretainedValue()
        service.cachedSiteIdBlob.withUnsafeBytes { rawBuffer in
          let bytes = rawBuffer.baseAddress
          sqlite3_result_blob(rawContext, bytes, Int32(service.cachedSiteIdBlob.count), sqliteTransient)
        }
      },
      nil,
      nil,
      nil
    ) == SQLITE_OK else {
      throw sqliteError(sqliteMessage(db))
    }
  }

  private func nextLocalDbVersion() -> Int {
    localDbVersion += 1
    return localDbVersion
  }

  private func readMaxDbVersion() -> Int {
    Int(queryInt64("select coalesce(max(db_version), 0) from crsql_changes") ?? 0)
  }

  private func enableCrr(for tableName: String) throws {
    try ensureSyncMetadataTables()
    guard let tableInfo = syncTableInfo(for: tableName), let primaryKeyColumn = tableInfo.primaryKeyColumn else { return }

    try run("""
      create table if not exists \(quoteIdentifier("\(tableName)__crsql_clock")) (
        key text primary key,
        col_name text not null,
        col_version integer not null default 0,
        db_version integer not null default 0,
        site_id blob,
        seq integer not null default 0
      )
    """)

    _ = try execute(
      """
      insert into crsql_master(tbl_name) values (?)
      on conflict(tbl_name) do nothing
      """
    ) { statement in
      try bindText(tableName, to: statement, index: 1)
    }

    try dropCrrTriggers(for: tableName)

    let trackedColumns = tableInfo.columns.filter { $0.name != primaryKeyColumn }
    guard !trackedColumns.isEmpty else { return }

    let insertStatements = trackedColumns.map { column in
      """
      insert into crsql_changes([table], pk, cid, val, col_version, db_version, site_id, cl, seq)
      select \(sqlStringLiteral(tableName)), NEW.\(quoteIdentifier(primaryKeyColumn)), \(sqlStringLiteral(column.name)), NEW.\(quoteIdentifier(column.name)), 1, ade_next_db_version(), ade_local_site_id(), 0, 0
      where ade_capture_local_changes() = 1
      """
    }.joined(separator: ";\n")

    let updateStatements = trackedColumns.map { column in
      """
      insert into crsql_changes([table], pk, cid, val, col_version, db_version, site_id, cl, seq)
      select \(sqlStringLiteral(tableName)), NEW.\(quoteIdentifier(primaryKeyColumn)), \(sqlStringLiteral(column.name)), NEW.\(quoteIdentifier(column.name)), 1, ade_next_db_version(), ade_local_site_id(), 0, 0
      where ade_capture_local_changes() = 1 and (OLD.\(quoteIdentifier(column.name)) is not NEW.\(quoteIdentifier(column.name)))
      """
    }.joined(separator: ";\n")

    let deleteStatement = """
      insert into crsql_changes([table], pk, cid, val, col_version, db_version, site_id, cl, seq)
      select \(sqlStringLiteral(tableName)), OLD.\(quoteIdentifier(primaryKeyColumn)), \(sqlStringLiteral(localDeleteColumnId)), null, 1, ade_next_db_version(), ade_local_site_id(), 0, 0
      where ade_capture_local_changes() = 1
      """

    try run("""
      create trigger if not exists \(quoteIdentifier(insertTriggerName(for: tableName)))
      after insert on \(quoteIdentifier(tableName))
      begin
      \(insertStatements);
      end
    """)

    try run("""
      create trigger if not exists \(quoteIdentifier(updateTriggerName(for: tableName)))
      after update on \(quoteIdentifier(tableName))
      begin
      \(updateStatements);
      end
    """)

    try run("""
      create trigger if not exists \(quoteIdentifier(deleteTriggerName(for: tableName)))
      after delete on \(quoteIdentifier(tableName))
      begin
      \(deleteStatement);
      end
    """)
  }

  private func beginCrrAlter(tableName: String) throws {
    try dropCrrTriggers(for: tableName)
  }

  private func commitCrrAlter(tableName: String) throws {
    syncTableInfoCache.removeValue(forKey: tableName)
    try enableCrr(for: tableName)
  }

  private func dropCrrTriggers(for tableName: String) throws {
    try run("drop trigger if exists \(quoteIdentifier(insertTriggerName(for: tableName)))")
    try run("drop trigger if exists \(quoteIdentifier(updateTriggerName(for: tableName)))")
    try run("drop trigger if exists \(quoteIdentifier(deleteTriggerName(for: tableName)))")
  }

  private func insertTriggerName(for tableName: String) -> String {
    "ade_crsql_ai_\(sanitizedIdentifier(tableName))"
  }

  private func updateTriggerName(for tableName: String) -> String {
    "ade_crsql_au_\(sanitizedIdentifier(tableName))"
  }

  private func deleteTriggerName(for tableName: String) -> String {
    "ade_crsql_ad_\(sanitizedIdentifier(tableName))"
  }

  private func sanitizedIdentifier(_ value: String) -> String {
    value.map { $0.isLetter || $0.isNumber ? $0 : "_" }.reduce(into: "") { partialResult, character in
      partialResult.append(character)
    }
  }

  private func quoteIdentifier(_ value: String) -> String {
    "\"\(value.replacingOccurrences(of: "\"", with: "\"\""))\""
  }

  private func sqlStringLiteral(_ value: String) -> String {
    "'\(value.replacingOccurrences(of: "'", with: "''"))'"
  }

  private func syncTableInfo(for tableName: String) -> SyncTableInfo? {
    if let cached = syncTableInfoCache[tableName] {
      return cached
    }
    let rows = query("pragma table_info('\(tableName.replacingOccurrences(of: "'", with: "''"))')") { statement in
      SyncColumnInfo(
        name: stringValue(statement, index: 1) ?? "",
        declaredType: (stringValue(statement, index: 2) ?? "").trimmingCharacters(in: .whitespacesAndNewlines),
        notNull: sqlite3_column_int(statement, 3) == 1,
        defaultValue: stringValue(statement, index: 4),
        pkIndex: Int(sqlite3_column_int(statement, 5))
      )
    }
    guard !rows.isEmpty else { return nil }
    let info = SyncTableInfo(name: tableName, columns: rows)
    syncTableInfoCache[tableName] = info
    return info
  }

  private func applyAcceptedRemoteChanges(_ changes: [CrsqlChangeRow]) throws {
    guard !changes.isEmpty else { return }

    var orderedKeys: [String] = []
    var groups: [String: [CrsqlChangeRow]] = [:]

    for change in changes {
      let key = groupedChangeKey(table: change.table, pk: change.pk)
      if groups[key] == nil {
        orderedKeys.append(key)
        groups[key] = []
      }
      groups[key, default: []].append(change)
    }

    shouldCaptureLocalChanges = false
    defer { shouldCaptureLocalChanges = true }

    for key in orderedKeys {
      guard let rowChanges = groups[key], let first = rowChanges.first,
            let tableInfo = syncTableInfo(for: first.table),
            let primaryKeyColumn = tableInfo.primaryKeyColumn
      else { continue }

      let pkColumns = tableInfo.primaryKeyColumns
      let decodedPkValues: [SyncScalarValue]
      if pkColumns.count == 1 {
        decodedPkValues = [decodeCrsqlPk(first.pk)]
      } else if let multi = decodeCrsqlPkColumns(first.pk), multi.count == pkColumns.count {
        decodedPkValues = multi
      } else if pkColumns.count > 1 {
        // Only a single PK value was recorded (e.g. the sender used a
        // single-column encoding for a composite-key table).  Try to
        // recover the full primary key by:
        //   1. Decode the single value via decodeCrsqlPk.
        //   2. Map it to the column indicated by primaryKeyColumn.
        //   3. Fill the remaining PK columns from rowChanges whose cid
        //      matches the column name.
        let singleVal = decodeCrsqlPk(first.pk)
        guard let knownIdx = pkColumns.firstIndex(of: primaryKeyColumn) else { continue }
        var assembled = [SyncScalarValue](repeating: .null, count: pkColumns.count)
        assembled[knownIdx] = singleVal
        for (i, col) in pkColumns.enumerated() where i != knownIdx {
          if let match = rowChanges.first(where: { $0.cid == col }) {
            assembled[i] = match.val
          } else {
            break
          }
        }
        guard !assembled.contains(.null) else { continue }
        decodedPkValues = assembled
      } else {
        continue // can't decode pk — skip
      }
      let pkPairs = Array(zip(pkColumns, decodedPkValues))

      let existingRow = try fetchRow(in: tableInfo, pkPairs: pkPairs)
      let materializationChanges = existingRow == nil
        ? persistedChangesForRow(table: first.table, pk: first.pk)
        : rowChanges
      let effectiveRowChanges = materializationChanges.isEmpty ? rowChanges : materializationChanges

      if rowChangesRepresentDeletedRow(effectiveRowChanges, in: tableInfo, primaryKeyColumn: primaryKeyColumn) {
        if existingRow != nil {
          try deleteRow(in: tableInfo, pkPairs: pkPairs)
        }
        continue
      }

      var finalRow = existingRow
      var sawDelete = false

      for change in effectiveRowChanges.sorted(by: sortChanges) {
        if isDeleteColumnId(change.cid) {
          finalRow = nil
          sawDelete = true
          continue
        }
        if finalRow == nil {
          var seed: [String: SyncScalarValue] = [:]
          for (col, val) in pkPairs {
            seed[col] = val
          }
          finalRow = seed
        }
        finalRow?[change.cid] = change.val
      }

      if finalRow == nil {
        if existingRow != nil {
          try deleteRow(in: tableInfo, pkPairs: pkPairs)
        }
        continue
      }

      if existingRow == nil || sawDelete {
        if existingRow != nil {
          try deleteRow(in: tableInfo, pkPairs: pkPairs)
        }
        guard rowHasRequiredInsertColumns(finalRow!, in: tableInfo) else {
          continue
        }
        try insertRow(finalRow!, in: tableInfo)
      } else {
        try updateRow(finalRow!, in: tableInfo)
      }
    }
  }

  private func sortChanges(_ lhs: CrsqlChangeRow, _ rhs: CrsqlChangeRow) -> Bool {
    if lhs.dbVersion != rhs.dbVersion {
      return lhs.dbVersion < rhs.dbVersion
    }
    if lhs.cl != rhs.cl {
      return lhs.cl < rhs.cl
    }
    return lhs.seq < rhs.seq
  }

  private func groupedChangeKey(table: String, pk: SyncScalarValue) -> String {
    "\(table)|\(scalarStorageKey(pk))"
  }

  private func persistedChangesForRow(table: String, pk: SyncScalarValue) -> [CrsqlChangeRow] {
    query("""
      select [table], pk, cid, val, col_version, db_version, site_id, cl, seq
        from crsql_changes
       where [table] = ? and pk = ?
       order by db_version asc, cl asc, seq asc
    """, bind: { [self] statement in
      try self.bindText(table, to: statement, index: 1)
      try self.bindScalar(pk, to: statement, index: 2)
    }) { statement in
      CrsqlChangeRow(
        table: stringValue(statement, index: 0) ?? table,
        pk: scalarValue(statement, index: 1),
        cid: stringValue(statement, index: 2) ?? "",
        val: scalarValue(statement, index: 3),
        colVersion: Int(sqlite3_column_int64(statement, 4)),
        dbVersion: Int(sqlite3_column_int64(statement, 5)),
        siteId: blobHexValue(statement, index: 6) ?? "",
        cl: Int(sqlite3_column_int64(statement, 7)),
        seq: Int(sqlite3_column_int64(statement, 8))
      )
    }
  }

  private func rowHasRequiredInsertColumns(_ row: [String: SyncScalarValue], in tableInfo: SyncTableInfo) -> Bool {
    let pkColumns = Set(tableInfo.primaryKeyColumns)
    for column in tableInfo.columns {
      guard column.notNull, column.defaultValue == nil, !pkColumns.contains(column.name) else {
        continue
      }
      guard let value = row[column.name], value != .null else {
        return false
      }
    }
    return true
  }

  private func isDeleteColumnId(_ cid: String) -> Bool {
    cid == localDeleteColumnId || cid == legacyDeleteColumnId
  }

  /// Decode a cr-sqlite packed primary key blob into actual column values.
  /// Format: [num_columns: 1 byte] then per column [type_tag: 1 byte] [data...].
  /// For text (type 0x0b): [0x0b] [length_byte] [utf8_bytes].
  /// For int types: size determined by type tag per SQLite serial type spec.
  /// Returns an array of decoded values, one per pk column.
  private func decodeCrsqlPkColumns(_ pk: SyncScalarValue) -> [SyncScalarValue]? {
    guard case .bytes(let bytesValue) = pk,
          let data = Data(base64Encoded: bytesValue.base64),
          data.count >= 3
    else { return nil }

    let numCols = Int(data[0])
    guard numCols > 0 else { return nil }

    var pos = 1
    var values: [SyncScalarValue] = []

    for _ in 0..<numCols {
      guard pos < data.count else { return nil }
      let typeTag = data[pos]
      pos += 1

      switch typeTag {
      case 0x0b: // text: [length_byte] [utf8_bytes]
        guard pos < data.count else { return nil }
        let length = Int(data[pos])
        pos += 1
        let end = pos + length
        guard end <= data.count else { return nil }
        if let text = String(data: data[pos..<end], encoding: .utf8) {
          values.append(.string(text))
        } else {
          return nil
        }
        pos = end

      case 0x01: // 1-byte signed int
        guard pos < data.count else { return nil }
        values.append(.number(Double(Int8(bitPattern: data[pos]))))
        pos += 1
      case 0x02: // 2-byte BE signed int
        guard pos + 2 <= data.count else { return nil }
        let val = Int16(data[pos]) << 8 | Int16(data[pos + 1])
        values.append(.number(Double(val)))
        pos += 2
      case 0x04: // 4-byte BE signed int
        guard pos + 4 <= data.count else { return nil }
        var val: Int32 = 0
        for i in 0..<4 { val = val << 8 | Int32(data[pos + i]) }
        values.append(.number(Double(val)))
        pos += 4
      case 0x06: // 8-byte BE signed int
        guard pos + 8 <= data.count else { return nil }
        var val: Int64 = 0
        for i in 0..<8 { val = val << 8 | Int64(data[pos + i]) }
        values.append(.number(Double(val)))
        pos += 8
      case 0x08: // integer constant 0
        values.append(.number(0))
      case 0x09: // integer constant 1
        values.append(.number(1))

      default:
        return nil // unknown type — bail
      }
    }

    return values
  }

  /// Convenience: decode single-column pk to a single value.
  private func decodeCrsqlPk(_ pk: SyncScalarValue) -> SyncScalarValue {
    guard let cols = decodeCrsqlPkColumns(pk), cols.count == 1 else { return pk }
    return cols[0]
  }

  private func rowChangesRepresentDeletedRow(
    _ rowChanges: [CrsqlChangeRow],
    in tableInfo: SyncTableInfo,
    primaryKeyColumn: String
  ) -> Bool {
    if let latestChange = rowChanges.sorted(by: sortChanges).last, isDeleteColumnId(latestChange.cid) {
      return true
    }

    let materializedChanges = rowChanges.filter { !isDeleteColumnId($0.cid) }
    guard !materializedChanges.isEmpty else { return false }
    guard materializedChanges.allSatisfy({ $0.val == .null }) else { return false }

    let pkColumnSet = Set(tableInfo.primaryKeyColumns)
    let changedColumns = Set(materializedChanges.map(\.cid))
    let nonPrimaryColumns = Set(tableInfo.columns.map(\.name).filter { !pkColumnSet.contains($0) })
    return changedColumns == nonPrimaryColumns
  }

  private func normalizeIncomingChange(_ change: CrsqlChangeRow) -> CrsqlChangeRow {
    guard let tableInfo = syncTableInfo(for: change.table),
          let primaryKeyColumn = tableInfo.primaryKeyColumn,
          let primaryKeyInfo = tableInfo.columns.first(where: { $0.name == primaryKeyColumn })
    else {
      return change
    }

    let normalizedPk = normalizePrimaryKeyScalar(change.pk, declaredType: primaryKeyInfo.declaredType)
    guard normalizedPk != change.pk else {
      return change
    }

    return CrsqlChangeRow(
      table: change.table,
      pk: normalizedPk,
      cid: change.cid,
      val: change.val,
      colVersion: change.colVersion,
      dbVersion: change.dbVersion,
      siteId: change.siteId,
      cl: change.cl,
      seq: change.seq
    )
  }

  private func normalizePrimaryKeyScalar(_ value: SyncScalarValue, declaredType: String) -> SyncScalarValue {
    guard case .bytes(let bytesValue) = value else { return value }
    guard primaryKeyAffinityLooksText(declaredType) else { return value }
    guard let data = Data(base64Encoded: bytesValue.base64) else { return value }

    if let decodedPackedText = decodePackedTextPrimaryKey(data) {
      return .string(decodedPackedText)
    }
    if let plainText = String(data: data, encoding: .utf8) {
      return .string(plainText)
    }
    return value
  }

  private func primaryKeyAffinityLooksText(_ declaredType: String) -> Bool {
    let normalized = declaredType.uppercased()
    if normalized.isEmpty {
      return true
    }
    return normalized.contains("TEXT") || normalized.contains("CHAR") || normalized.contains("CLOB")
  }

  private func decodePackedTextPrimaryKey(_ data: Data) -> String? {
    let bytes = [UInt8](data)
    guard bytes.count >= 4 else { return nil }
    guard bytes[0] == 0x01, bytes[1] == 0x0b else { return nil }
    let textLength = Int(bytes[2])
    guard bytes.count >= 3 + textLength else { return nil }
    return String(bytes: bytes[3..<(3 + textLength)], encoding: .utf8)
  }

  private func scalarStorageKey(_ value: SyncScalarValue) -> String {
    switch value {
    case .string(let stringValue):
      return "s:\(stringValue)"
    case .number(let numberValue):
      return "n:\(numberValue)"
    case .bytes(let bytesValue):
      return "b:\(bytesValue.base64)"
    case .null:
      return "null"
    }
  }

  private func fetchRow(in tableInfo: SyncTableInfo, pk: SyncScalarValue) throws -> [String: SyncScalarValue]? {
    try fetchRow(in: tableInfo, pkPairs: tableInfo.primaryKeyColumns.map { ($0, pk) }.prefix(1).map { $0 })
  }

  private func fetchRow(in tableInfo: SyncTableInfo, pkPairs: [(String, SyncScalarValue)]) throws -> [String: SyncScalarValue]? {
    guard !pkPairs.isEmpty else { return nil }
    let selectColumns = tableInfo.columns.map { quoteIdentifier($0.name) }.joined(separator: ", ")
    let whereClause = pkPairs.map { "\(quoteIdentifier($0.0)) = ?" }.joined(separator: " and ")
    let sql = """
      select \(selectColumns)
        from \(quoteIdentifier(tableInfo.name))
       where \(whereClause)
       limit 1
    """
    return try querySingleThrowing(sql, bind: { [self] statement in
      for (i, pair) in pkPairs.enumerated() {
        try self.bindScalar(pair.1, to: statement, index: Int32(i + 1))
      }
    }) { statement in
      var row: [String: SyncScalarValue] = [:]
      for (index, column) in tableInfo.columns.enumerated() {
        row[column.name] = scalarValue(statement, index: Int32(index))
      }
      return row
    }
  }

  private func insertRow(_ row: [String: SyncScalarValue], in tableInfo: SyncTableInfo) throws {
    let orderedColumns = tableInfo.columns.map(\.name).filter { row[$0] != nil }
    let placeholders = Array(repeating: "?", count: orderedColumns.count).joined(separator: ", ")
    let sql = """
      insert into \(quoteIdentifier(tableInfo.name)) (\(orderedColumns.map(quoteIdentifier).joined(separator: ", ")))
      values (\(placeholders))
    """
    _ = try execute(sql) { statement in
      for (offset, column) in orderedColumns.enumerated() {
        try bindScalar(row[column] ?? .null, to: statement, index: Int32(offset + 1))
      }
    }
  }

  private func updateRow(_ row: [String: SyncScalarValue], in tableInfo: SyncTableInfo) throws {
    let pkCols = Set(tableInfo.primaryKeyColumns)
    let orderedColumns = tableInfo.columns.map(\.name).filter { !pkCols.contains($0) && row[$0] != nil }
    guard !orderedColumns.isEmpty else { return }
    let assignments = orderedColumns.map { "\(quoteIdentifier($0)) = ?" }.joined(separator: ", ")
    let whereClause = tableInfo.primaryKeyColumns.map { "\(quoteIdentifier($0)) = ?" }.joined(separator: " and ")
    let sql = """
      update \(quoteIdentifier(tableInfo.name))
         set \(assignments)
       where \(whereClause)
    """
    _ = try execute(sql) { statement in
      var idx: Int32 = 1
      for column in orderedColumns {
        try bindScalar(row[column] ?? .null, to: statement, index: idx)
        idx += 1
      }
      for pkCol in tableInfo.primaryKeyColumns {
        try bindScalar(row[pkCol] ?? .null, to: statement, index: idx)
        idx += 1
      }
    }
  }

  private func deleteRow(in tableInfo: SyncTableInfo, pk: SyncScalarValue) throws {
    try deleteRow(in: tableInfo, pkPairs: tableInfo.primaryKeyColumns.map { ($0, pk) }.prefix(1).map { $0 })
  }

  private func deleteRow(in tableInfo: SyncTableInfo, pkPairs: [(String, SyncScalarValue)]) throws {
    guard !pkPairs.isEmpty else { return }
    let whereClause = pkPairs.map { "\(quoteIdentifier($0.0)) = ?" }.joined(separator: " and ")
    let sql = """
      delete from \(quoteIdentifier(tableInfo.name))
       where \(whereClause)
    """
    _ = try execute(sql) { statement in
      for (i, pair) in pkPairs.enumerated() {
        try bindScalar(pair.1, to: statement, index: Int32(i + 1))
      }
    }
  }

  private func querySingleThrowing<T>(_ sql: String, bind: ((OpaquePointer) throws -> Void)? = nil, map: (OpaquePointer) -> T) throws -> T? {
    guard let db else { throw sqliteError("Database is not open.") }
    var statement: OpaquePointer?
    guard sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK, let statement else {
      throw sqliteError(sqliteMessage(db))
    }
    defer { sqlite3_finalize(statement) }
    try bind?(statement)
    let result = sqlite3_step(statement)
    if result == SQLITE_ROW {
      return map(statement)
    }
    if result == SQLITE_DONE {
      return nil
    }
    throw sqliteError(sqliteMessage(db), code: result)
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
