import XCTest
import SQLite3
@testable import ADE

final class ADETests: XCTestCase {
  func testUnwrapSyncCommandResponseReturnsResultPayload() throws {
    let raw: [String: Any] = [
      "commandId": "cmd-1",
      "ok": true,
      "result": [
        "refreshedCount": 1,
        "lanes": [["id": "lane-1"]],
      ],
    ]

    let result = try unwrapSyncCommandResponse(raw) as? [String: Any]

    XCTAssertEqual(result?["refreshedCount"] as? Int, 1)
    XCTAssertEqual((result?["lanes"] as? [[String: String]])?.first?["id"], "lane-1")
  }

  func testUnwrapSyncCommandResponseThrowsRemoteErrorMessage() {
    let raw: [String: Any] = [
      "commandId": "cmd-1",
      "ok": false,
      "error": [
        "code": "command_failed",
        "message": "Lane hydration blew up.",
      ],
    ]

    XCTAssertThrowsError(try unwrapSyncCommandResponse(raw)) { error in
      XCTAssertEqual((error as NSError).localizedDescription, "Lane hydration blew up.")
      XCTAssertEqual((error as NSError).userInfo["ADEErrorCode"] as? String, "command_failed")
    }
  }

  func testDecodeHydrationPayloadWrapsMalformedHostData() {
    XCTAssertThrowsError(
      try decodeHydrationPayload(
        ["lanes": []],
        as: DummyHydrationPayload.self,
        domainLabel: "lane",
        decoder: JSONDecoder()
      )
    ) { error in
      XCTAssertEqual((error as NSError).localizedDescription, "The host returned incomplete lane data. Pull to retry or reconnect the host.")
    }
  }

  func testInitialHydrationGateWaitsUntilProjectRowArrives() async throws {
    var projectId: String?
    var sleepCalls: [UInt64] = []

    try await InitialHydrationGate.waitForProjectRow(
      timeoutNanoseconds: 1_000,
      pollIntervalNanoseconds: 200,
      currentProjectId: { projectId },
      sleep: { interval in
        sleepCalls.append(interval)
        if sleepCalls.count == 2 {
          projectId = "project-1"
        }
      }
    )

    XCTAssertEqual(sleepCalls, [200, 200])
  }

  func testInitialHydrationGateTimesOutWithFriendlyMessage() async {
    await XCTAssertThrowsErrorAsync(
      try await InitialHydrationGate.waitForProjectRow(
        timeoutNanoseconds: 600,
        pollIntervalNanoseconds: 200,
        currentProjectId: { nil },
        sleep: { _ in }
      )
    ) { error in
      XCTAssertEqual((error as NSError).localizedDescription, SyncHydrationMessaging.projectDataTimeout)
    }
  }

  func testDatabaseReplaceLaneSnapshotsWithoutProjectRowUsesFriendlyError() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeLaneHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    XCTAssertThrowsError(try database.replaceLaneSnapshots([])) { error in
      XCTAssertEqual((error as NSError).localizedDescription, SyncHydrationMessaging.waitingForProjectData)
    }

    database.close()
  }

  func testDatabaseReplacePullRequestHydrationWithoutProjectRowUsesFriendlyError() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    XCTAssertThrowsError(
      try database.replacePullRequestHydration(
        PullRequestRefreshPayload(refreshedCount: 0, prs: [], snapshots: [])
      )
    ) { error in
      XCTAssertEqual((error as NSError).localizedDescription, SyncHydrationMessaging.waitingForProjectData)
    }

    database.close()
  }

  func testConnectionDraftRoundTrip() throws {
    let draft = ConnectionDraft(
      host: "127.0.0.1",
      port: 8787,
      authKind: "paired",
      pairedDeviceId: "phone-1",
      lastRemoteDbVersion: 42,
      lastBrainDeviceId: "brain-1"
    )
    let data = try JSONEncoder().encode(draft)
    let decoded = try JSONDecoder().decode(ConnectionDraft.self, from: data)
    XCTAssertEqual(decoded, draft)
  }

  @MainActor
  func testSyncPairingQrPayloadRoundTripFromDesktopLink() throws {
    let payload = """
    {"version":1,"hostIdentity":{"deviceId":"host-1","siteId":"site-1","name":"Mac Studio","platform":"macOS","deviceType":"desktop"},"port":8787,"pairingCode":"ABC123","expiresAt":"2026-03-17T12:00:00.000Z","addressCandidates":[{"host":"192.168.1.8","kind":"lan"},{"host":"100.101.102.103","kind":"tailscale"}]}
    """
    let url = "ade-sync://pair?payload=\(payload.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? payload)"

    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let decoded = try service.decodePairingQrPayload(from: url)

    XCTAssertEqual(decoded.hostIdentity.deviceId, "host-1")
    XCTAssertEqual(decoded.hostIdentity.name, "Mac Studio")
    XCTAssertEqual(decoded.pairingCode, "ABC123")
    XCTAssertEqual(decoded.addressCandidates.map(\.host), ["192.168.1.8", "100.101.102.103"])
  }

  func testDatabasePersistsStableSiteIdAcrossReopen() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)
    let firstSiteId = database.localSiteId()
    database.close()

    let reopened = makeDatabase(baseURL: baseURL)
    XCTAssertNil(reopened.initializationError)
    XCTAssertEqual(reopened.localSiteId(), firstSiteId)
    reopened.close()
  }

  func testDatabaseExportAndApplyChangesRoundTrip() throws {
    let source = makeDatabase(baseURL: makeTemporaryDirectory())
    let target = makeDatabase(baseURL: makeTemporaryDirectory())
    XCTAssertNil(source.initializationError)
    XCTAssertNil(target.initializationError)

    try source.executeSqlForTesting("""
      insert into lanes (
        id, name, description, lane_type, base_ref, branch_ref, worktree_path, parent_lane_id, created_at, archived_at
      ) values (
        'lane-1', 'Inbox', null, 'worktree', 'origin/main', 'feature/inbox', '/tmp/inbox', null, '2026-03-15T00:00:00.000Z', null
      )
    """)

    let changes = source.exportChangesSince(version: 0)
    XCTAssertFalse(changes.isEmpty)

    let result = try target.applyChanges(changes)
    XCTAssertGreaterThan(result.appliedCount, 0)

    let mirrored = target.fetchLanes(includeArchived: true)
    XCTAssertEqual(mirrored.count, 1)
    XCTAssertEqual(mirrored.first?.id, "lane-1")
    XCTAssertEqual(mirrored.first?.name, "Inbox")

    source.close()
    target.close()
  }

  func testDatabaseAppliesPackedTextPrimaryKeysFromDesktopChanges() throws {
    let database = makeDatabase(baseURL: makeTemporaryDirectory())
    XCTAssertNil(database.initializationError)

    let laneId = "c5388add-348f-4266-b78c-d325dd447917"
    let packedPk = packedDesktopTextPrimaryKey(laneId)
    let siteId = "b00e9b92c864a27958669c1595fcb2c3"

    let changes: [CrsqlChangeRow] = [
      CrsqlChangeRow(table: "lanes", pk: packedPk, cid: "name", val: .string("Primary"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 0),
      CrsqlChangeRow(table: "lanes", pk: packedPk, cid: "description", val: .string("Main repository workspace"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 1),
      CrsqlChangeRow(table: "lanes", pk: packedPk, cid: "lane_type", val: .string("primary"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 2),
      CrsqlChangeRow(table: "lanes", pk: packedPk, cid: "base_ref", val: .string("main"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 3),
      CrsqlChangeRow(table: "lanes", pk: packedPk, cid: "branch_ref", val: .string("dev"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 4),
      CrsqlChangeRow(table: "lanes", pk: packedPk, cid: "worktree_path", val: .string("/tmp/ade"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 5),
      CrsqlChangeRow(table: "lanes", pk: packedPk, cid: "created_at", val: .string("2026-03-15T00:00:00.000Z"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 6),
    ]

    let result = try database.applyChanges(changes)
    XCTAssertEqual(result.appliedCount, changes.count)

    let mirrored = database.fetchLanes(includeArchived: true)
    XCTAssertEqual(mirrored.count, 1)
    XCTAssertEqual(mirrored.first?.id, laneId)
    XCTAssertEqual(mirrored.first?.name, "Primary")

    database.close()
  }

  func testDatabaseTreatsCrsqlDeleteSentinelAsRowDelete() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeConflictPredictionsDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try database.executeSqlForTesting("""
      insert into conflict_predictions (
        id, project_id, lane_a_id, lane_b_id, status, predicted_at
      ) values (
        'prediction-1', 'project-1', 'lane-a', null, 'clean', '2026-03-17T00:00:00.000Z'
      )
    """)

    let deleteChange = CrsqlChangeRow(
      table: "conflict_predictions",
      pk: .bytes(SyncScalarBytes(type: "bytes", base64: packedDesktopTextPrimaryKeyData("prediction-1").base64EncodedString())),
      cid: "-1",
      val: .null,
      colVersion: 2,
      dbVersion: 2,
      siteId: "b00e9b92c864a27958669c1595fcb2c3",
      cl: 1,
      seq: 0
    )

    let result = try database.applyChanges([deleteChange])
    XCTAssertEqual(result.appliedCount, 1)

    XCTAssertEqual(try countRows(in: baseURL, table: "conflict_predictions"), 0)
    database.close()
  }

  func testDatabaseSkipsAllNullTombstoneRows() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeConflictPredictionsDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    let pk = packedDesktopTextPrimaryKey("prediction-2")
    let siteId = "b00e9b92c864a27958669c1595fcb2c3"
    let changes: [CrsqlChangeRow] = [
      CrsqlChangeRow(table: "conflict_predictions", pk: pk, cid: "project_id", val: .null, colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 0),
      CrsqlChangeRow(table: "conflict_predictions", pk: pk, cid: "lane_a_id", val: .null, colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 1),
      CrsqlChangeRow(table: "conflict_predictions", pk: pk, cid: "lane_b_id", val: .null, colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 2),
      CrsqlChangeRow(table: "conflict_predictions", pk: pk, cid: "status", val: .null, colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 3),
      CrsqlChangeRow(table: "conflict_predictions", pk: pk, cid: "conflicting_files_json", val: .null, colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 4),
      CrsqlChangeRow(table: "conflict_predictions", pk: pk, cid: "overlap_files_json", val: .null, colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 5),
      CrsqlChangeRow(table: "conflict_predictions", pk: pk, cid: "lane_a_sha", val: .null, colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 6),
      CrsqlChangeRow(table: "conflict_predictions", pk: pk, cid: "lane_b_sha", val: .null, colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 7),
      CrsqlChangeRow(table: "conflict_predictions", pk: pk, cid: "predicted_at", val: .null, colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 8),
      CrsqlChangeRow(table: "conflict_predictions", pk: pk, cid: "expires_at", val: .null, colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 9),
    ]

    let result = try database.applyChanges(changes)
    XCTAssertEqual(result.appliedCount, changes.count)

    XCTAssertEqual(try countRows(in: baseURL, table: "conflict_predictions"), 0)
    database.close()
  }

  func testDatabaseReplaceLaneSnapshotsHydratesProvidedLaneGraph() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeLaneHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values (
        'project-1', '/tmp/project', 'ADE', 'main', '2026-03-17T00:00:00.000Z', '2026-03-17T00:00:00.000Z'
      )
    """)

    try database.replaceLaneSnapshots([
      LaneSummary(
        id: "lane-primary",
        name: "Primary",
        description: "Main workspace",
        laneType: "primary",
        baseRef: "main",
        branchRef: "dev",
        worktreePath: "/tmp/project",
        attachedRootPath: nil,
        parentLaneId: nil,
        childCount: 1,
        stackDepth: 0,
        parentStatus: nil,
        isEditProtected: true,
        status: LaneStatus(dirty: true, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
        color: "violet",
        icon: .shield,
        tags: ["protected"],
        folder: "root",
        createdAt: "2026-03-17T00:00:00.000Z",
        archivedAt: nil
      ),
      LaneSummary(
        id: "lane-child",
        name: "linear test",
        description: nil,
        laneType: "worktree",
        baseRef: "dev",
        branchRef: "ade/linear-test",
        worktreePath: "/tmp/project/.ade/worktrees/linear-test",
        attachedRootPath: "/tmp/project/.ade/worktrees/linear-test",
        parentLaneId: "lane-primary",
        childCount: 0,
        stackDepth: 1,
        parentStatus: LaneStatus(dirty: true, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
        isEditProtected: false,
        status: LaneStatus(dirty: false, ahead: 0, behind: 1, remoteBehind: 0, rebaseInProgress: false),
        color: nil,
        icon: nil,
        tags: ["ios"],
        folder: "worktrees",
        createdAt: "2026-03-17T00:05:00.000Z",
        archivedAt: nil
      ),
    ])

    let mirrored = database.fetchLanes(includeArchived: true)
    XCTAssertEqual(mirrored.map(\.id), ["lane-primary", "lane-child"])
    XCTAssertEqual(mirrored.last?.parentLaneId, "lane-primary")
    XCTAssertEqual(mirrored.last?.status.behind, 1)
    XCTAssertEqual(mirrored.first?.isEditProtected, true)
    XCTAssertEqual(mirrored.first?.color, "violet")
    XCTAssertEqual(mirrored.last?.attachedRootPath, "/tmp/project/.ade/worktrees/linear-test")
    XCTAssertEqual(mirrored.last?.parentStatus?.dirty, true)
    XCTAssertEqual(database.listWorkspaces().first?.isReadOnlyByDefault, true)
    database.close()
  }

  func testDatabaseReplaceLaneSnapshotsPersistsRichLaneListSnapshots() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeLaneHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    let activeLane = LaneSummary(
      id: "lane-child",
      name: "Feature lane",
      description: "iOS lanes parity",
      laneType: "worktree",
      baseRef: "main",
      branchRef: "ade/ios-lanes",
      worktreePath: "/tmp/project/.ade/worktrees/ios-lanes",
      attachedRootPath: nil,
      parentLaneId: "lane-primary",
      childCount: 0,
      stackDepth: 1,
      parentStatus: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
      isEditProtected: false,
      status: LaneStatus(dirty: true, ahead: 2, behind: 1, remoteBehind: 0, rebaseInProgress: false),
      color: "teal",
      icon: .bolt,
      tags: ["mobile"],
      folder: "worktrees",
      createdAt: "2026-03-17T00:05:00.000Z",
      archivedAt: nil
    )
    let archivedLane = LaneSummary(
      id: "lane-archived",
      name: "Old lane",
      description: nil,
      laneType: "worktree",
      baseRef: "main",
      branchRef: "ade/old-lane",
      worktreePath: "/tmp/project/.ade/worktrees/old-lane",
      attachedRootPath: nil,
      parentLaneId: "lane-primary",
      childCount: 0,
      stackDepth: 1,
      parentStatus: nil,
      isEditProtected: false,
      status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
      color: nil,
      icon: nil,
      tags: [],
      folder: "worktrees",
      createdAt: "2026-03-16T00:05:00.000Z",
      archivedAt: "2026-03-18T00:00:00.000Z"
    )

    try database.replaceLaneSnapshots(
      [activeLane, archivedLane],
      snapshots: [
        LaneListSnapshot(
          lane: activeLane,
          runtime: LaneRuntimeSummary(bucket: "running", runningCount: 1, awaitingInputCount: 1, endedCount: 0, sessionCount: 2),
          rebaseSuggestion: RebaseSuggestion(
            laneId: "lane-child",
            parentLaneId: "lane-primary",
            parentHeadSha: "abc123",
            behindCount: 1,
            lastSuggestedAt: "2026-03-18T00:10:00.000Z",
            deferredUntil: nil,
            dismissedAt: nil,
            hasPr: false
          ),
          autoRebaseStatus: AutoRebaseLaneStatus(
            laneId: "lane-child",
            parentLaneId: "lane-primary",
            parentHeadSha: "abc123",
            state: "awaitingManualRebase",
            updatedAt: "2026-03-18T00:12:00.000Z",
            conflictCount: 0,
            message: "Parent advanced."
          ),
          conflictStatus: ConflictStatus(
            laneId: "lane-child",
            status: "conflict-predicted",
            overlappingFileCount: 2,
            peerConflictCount: 1,
            lastPredictedAt: "2026-03-18T00:13:00.000Z"
          ),
          stateSnapshot: LaneStateSnapshotSummary(
            laneId: "lane-child",
            agentSummary: ["summary": .string("Codex running")],
            missionSummary: ["summary": .string("Ship W6")],
            updatedAt: "2026-03-18T00:14:00.000Z"
          ),
          adoptableAttached: false
        ),
        LaneListSnapshot(
          lane: archivedLane,
          runtime: LaneRuntimeSummary(bucket: "ended", runningCount: 0, awaitingInputCount: 0, endedCount: 1, sessionCount: 1),
          rebaseSuggestion: nil,
          autoRebaseStatus: nil,
          conflictStatus: nil,
          stateSnapshot: nil,
          adoptableAttached: false
        ),
      ]
    )

    let activeSnapshots = database.fetchLaneListSnapshots(includeArchived: false)
    XCTAssertEqual(activeSnapshots.map(\.lane.id), ["lane-child"])
    XCTAssertEqual(activeSnapshots.first?.runtime.bucket, "running")
    XCTAssertEqual(activeSnapshots.first?.rebaseSuggestion?.behindCount, 1)
    XCTAssertEqual(activeSnapshots.first?.stateSnapshot?.agentSummary?["summary"], .string("Codex running"))

    let allSnapshots = database.fetchLaneListSnapshots(includeArchived: true)
    XCTAssertEqual(Set(allSnapshots.map(\.lane.id)), Set(["lane-child", "lane-archived"]))
    database.close()
  }

  func testDatabaseReplaceLaneDetailCachesRichLanePayload() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    let detail = LaneDetailPayload(
      lane: LaneSummary(
        id: "lane-primary",
        name: "Primary",
        description: nil,
        laneType: "primary",
        baseRef: "main",
        branchRef: "main",
        worktreePath: "/tmp/project",
        attachedRootPath: nil,
        parentLaneId: nil,
        childCount: 1,
        stackDepth: 0,
        parentStatus: nil,
        isEditProtected: true,
        status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
        color: nil,
        icon: nil,
        tags: [],
        folder: nil,
        createdAt: "2026-03-17T00:00:00.000Z",
        archivedAt: nil
      ),
      runtime: LaneRuntimeSummary(bucket: "awaiting-input", runningCount: 0, awaitingInputCount: 1, endedCount: 0, sessionCount: 1),
      stackChain: [
        StackChainItem(
          laneId: "lane-primary",
          laneName: "Primary",
          branchRef: "main",
          depth: 0,
          parentLaneId: nil,
          status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false)
        ),
      ],
      children: [],
      stateSnapshot: LaneStateSnapshotSummary(
        laneId: "lane-primary",
        agentSummary: ["summary": .string("Awaiting review")],
        missionSummary: nil,
        updatedAt: "2026-03-18T00:20:00.000Z"
      ),
      rebaseSuggestion: nil,
      autoRebaseStatus: AutoRebaseLaneStatus(
        laneId: "lane-primary",
        parentLaneId: nil,
        parentHeadSha: nil,
        state: "rebaseConflict",
        updatedAt: "2026-03-18T00:21:00.000Z",
        conflictCount: 1,
        message: "Manual resolution required."
      ),
      conflictStatus: ConflictStatus(
        laneId: "lane-primary",
        status: "conflict-active",
        overlappingFileCount: 1,
        peerConflictCount: 1,
        lastPredictedAt: "2026-03-18T00:22:00.000Z"
      ),
      overlaps: [
        ConflictOverlap(
          peerId: "lane-peer",
          peerName: "Peer lane",
          files: [ConflictOverlapFile(path: "Sources/App.swift", conflictType: "modified-modified")],
          riskLevel: "high"
        ),
      ],
      syncStatus: GitUpstreamSyncStatus(
        hasUpstream: true,
        upstreamRef: "origin/main",
        ahead: 0,
        behind: 2,
        diverged: false,
        recommendedAction: "pull"
      ),
      conflictState: GitConflictState(
        laneId: "lane-primary",
        kind: "rebase",
        inProgress: true,
        conflictedFiles: ["Sources/App.swift"],
        canContinue: false,
        canAbort: true
      ),
      recentCommits: [
        GitCommitSummary(
          sha: "abc123def456",
          shortSha: "abc123d",
          parents: ["parent-1"],
          authorName: "Arul",
          authoredAt: "2026-03-18T00:23:00.000Z",
          subject: "Ship lane parity",
          pushed: false
        ),
      ],
      diffChanges: DiffChanges(
        unstaged: [FileChange(path: "Sources/App.swift", kind: "modified")],
        staged: []
      ),
      stashes: [GitStashSummary(ref: "stash@{0}", subject: "WIP", createdAt: "2026-03-18T00:24:00.000Z")],
      envInitProgress: nil,
      sessions: [],
      chatSessions: []
    )

    try database.replaceLaneDetail(detail)
    let mirrored = database.fetchLaneDetail(laneId: "lane-primary")
    XCTAssertEqual(mirrored?.runtime.bucket, "awaiting-input")
    XCTAssertEqual(mirrored?.overlaps.first?.files.first?.path, "Sources/App.swift")
    XCTAssertEqual(mirrored?.syncStatus?.behind, 2)
    XCTAssertEqual(mirrored?.recentCommits.first?.shortSha, "abc123d")
    XCTAssertEqual(mirrored?.conflictState?.kind, "rebase")
    database.close()
  }

  func testDatabaseReplaceTerminalSessionsHydratesHostSessionProjection() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    try database.replaceTerminalSessions([
      TerminalSessionSummary(
        id: "session-1",
        laneId: "lane-primary",
        laneName: "Primary",
        ptyId: "pty-1",
        tracked: true,
        pinned: false,
        goal: "Run tests",
        toolType: "run-shell",
        title: "npm test",
        status: "running",
        startedAt: "2026-03-17T00:10:00.000Z",
        endedAt: nil,
        exitCode: nil,
        transcriptPath: "/tmp/session-1.log",
        headShaStart: nil,
        headShaEnd: nil,
        lastOutputPreview: "Tests starting",
        summary: nil,
        runtimeState: "running",
        resumeCommand: "npm test"
      ),
    ])

    let sessions = database.fetchSessions()
    XCTAssertEqual(sessions.count, 1)
    XCTAssertEqual(sessions.first?.id, "session-1")
    XCTAssertEqual(sessions.first?.laneName, "Primary")
    XCTAssertEqual(sessions.first?.lastOutputPreview, "Tests starting")
    database.close()
  }

  func testDatabaseMigratesLegacyTerminalSessionsSchemaToStoreLaneName() throws {
    let baseURL = makeTemporaryDirectory()
    let database = DatabaseService(baseURL: baseURL, bootstrapSQL: """
      create table if not exists projects (
        id text primary key,
        root_path text not null,
        display_name text not null,
        default_base_ref text not null,
        created_at text not null,
        last_opened_at text not null
      );
      create table if not exists lanes (
        id text primary key,
        project_id text not null,
        name text not null,
        description text,
        lane_type text not null,
        base_ref text not null,
        branch_ref text not null,
        worktree_path text not null,
        status text not null,
        created_at text not null,
        archived_at text
      );
      create table if not exists terminal_sessions (
        id text primary key,
        lane_id text not null,
        pty_id text,
        tracked integer not null default 1,
        goal text,
        tool_type text,
        pinned integer not null default 0,
        title text not null,
        started_at text not null,
        ended_at text,
        exit_code integer,
        transcript_path text not null,
        head_sha_start text,
        head_sha_end text,
        status text not null,
        last_output_preview text,
        last_output_at text,
        summary text,
        resume_command text
      );
    """)
    XCTAssertNil(database.initializationError)

    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values (
        'project-1', '/tmp/project', 'ADE', 'main', '2026-03-17T00:00:00.000Z', '2026-03-17T00:00:00.000Z'
      )
    """)
    try database.replaceTerminalSessions([
      TerminalSessionSummary(
        id: "session-1",
        laneId: "lane-primary",
        laneName: "Primary",
        ptyId: nil,
        tracked: true,
        pinned: false,
        goal: nil,
        toolType: nil,
        title: "npm test",
        status: "running",
        startedAt: "2026-03-17T00:10:00.000Z",
        endedAt: nil,
        exitCode: nil,
        transcriptPath: "/tmp/session-1.log",
        headShaStart: nil,
        headShaEnd: nil,
        lastOutputPreview: nil,
        summary: nil,
        runtimeState: "running",
        resumeCommand: nil
      ),
    ])

    XCTAssertEqual(database.fetchSessions().first?.laneName, "Primary")
    database.close()
  }

  func testDatabaseFetchSessionsFallsBackToStoredLaneNameWhenLaneRowIsMissing() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    try database.replaceTerminalSessions([
      TerminalSessionSummary(
        id: "session-1",
        laneId: "lane-primary",
        laneName: "Primary",
        ptyId: "pty-1",
        tracked: true,
        pinned: false,
        goal: nil,
        toolType: "run-shell",
        title: "npm test",
        status: "exited",
        startedAt: "2026-03-17T00:10:00.000Z",
        endedAt: "2026-03-17T00:11:00.000Z",
        exitCode: 0,
        transcriptPath: "/tmp/session-1.log",
        headShaStart: nil,
        headShaEnd: nil,
        lastOutputPreview: "done",
        summary: "done",
        runtimeState: "exited",
        resumeCommand: nil
      ),
    ])
    try database.executeSqlForTesting("delete from lanes where id = 'lane-primary';")

    let sessions = database.fetchSessions()
    XCTAssertEqual(sessions.count, 1)
    XCTAssertEqual(sessions.first?.laneName, "Primary")
    database.close()
  }

  func testDatabaseReplacePullRequestHydrationHydratesSummariesAndSnapshots() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    try database.replacePullRequestHydration(
      PullRequestRefreshPayload(
        refreshedCount: 1,
        prs: [
          PrSummary(
            id: "pr-1",
            laneId: "lane-primary",
            projectId: "project-1",
            repoOwner: "arul",
            repoName: "ade",
            githubPrNumber: 42,
            githubUrl: "https://github.com/arul/ade/pull/42",
            githubNodeId: "node-42",
            title: "Fix mobile hydration",
            state: "open",
            baseBranch: "main",
            headBranch: "ade/mobile-hydration",
            checksStatus: "pending",
            reviewStatus: "requested",
            additions: 12,
            deletions: 4,
            lastSyncedAt: "2026-03-17T00:10:00.000Z",
            createdAt: "2026-03-17T00:10:00.000Z",
            updatedAt: "2026-03-17T00:10:00.000Z"
          ),
        ],
        snapshots: [
          PullRequestSnapshotHydration(
            prId: "pr-1",
            detail: PrDetail(
              prId: "pr-1",
              body: "Hydration fix",
              assignees: [],
              author: PrUser(login: "arul", avatarUrl: nil),
              isDraft: false,
              labels: [],
              requestedReviewers: [],
              milestone: nil,
              linkedIssues: []
            ),
            status: PrStatus(
              prId: "pr-1",
              state: "open",
              checksStatus: "pending",
              reviewStatus: "requested",
              isMergeable: true,
              mergeConflicts: false,
              behindBaseBy: 0
            ),
            checks: [],
            reviews: [],
            comments: [],
            files: [],
            updatedAt: "2026-03-17T00:10:00.000Z"
          ),
        ]
      )
    )

    let prs = database.fetchPullRequests()
    XCTAssertEqual(prs.count, 1)
    XCTAssertEqual(prs.first?.id, "pr-1")
    XCTAssertEqual(prs.first?.title, "Fix mobile hydration")
    XCTAssertEqual(database.fetchPullRequestSnapshot(prId: "pr-1")?.status?.isMergeable, true)
    database.close()
  }

  @MainActor
  func testDisconnectKeepsCachedLaneDataAvailable() async throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)
    try insertHydrationProjectGraph(into: database)
    try database.replaceLaneSnapshots([
      LaneSummary(
        id: "lane-primary",
        name: "Primary",
        description: nil,
        laneType: "primary",
        baseRef: "main",
        branchRef: "main",
        worktreePath: "/tmp/project",
        attachedRootPath: nil,
        parentLaneId: nil,
        childCount: 0,
        stackDepth: 0,
        parentStatus: nil,
        isEditProtected: true,
        status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
        color: nil,
        icon: nil,
        tags: [],
        folder: nil,
        createdAt: "2026-03-17T00:00:00.000Z",
        archivedAt: nil
      ),
    ])

    let service = SyncService(database: database)
    service.disconnect()

    let lanes = try await service.fetchLanes(includeArchived: true)
    XCTAssertEqual(lanes.map(\.id), ["lane-primary"])
    XCTAssertEqual(service.status(for: .lanes).phase, SyncDomainPhase.disconnected)
    XCTAssertTrue(service.hasCachedHostData)
    database.close()
  }

  @MainActor
  func testRemoteCommandPolicyQueuesLaneArchiveButRejectsLiveOnlyLaneDetail() async throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    let descriptors = [
      SyncRemoteCommandDescriptor(
        action: "lanes.archive",
        policy: SyncRemoteCommandPolicy(viewerAllowed: true, requiresApproval: nil, localOnly: nil, queueable: true)
      ),
      SyncRemoteCommandDescriptor(
        action: "lanes.getDetail",
        policy: SyncRemoteCommandPolicy(viewerAllowed: true, requiresApproval: nil, localOnly: nil, queueable: false)
      ),
    ]
    UserDefaults.standard.set(try JSONEncoder().encode(descriptors), forKey: "ade.sync.remoteCommandDescriptors")
    defer {
      UserDefaults.standard.removeObject(forKey: "ade.sync.remoteCommandDescriptors")
      database.close()
    }

    let service = SyncService(database: database)
    try await service.archiveLane("lane-child")
    XCTAssertEqual(service.pendingOperationCount, 1)

    do {
      _ = try await service.refreshLaneDetail(laneId: "lane-child")
      XCTFail("Expected live-only lane detail refresh to fail while offline.")
    } catch {
      XCTAssertEqual((error as NSError).localizedDescription, "This action requires a live connection to the host.")
    }
  }

  func testPrActionAvailabilityMatchesDesktopBaseline() {
    let open = PrActionAvailability(prState: "open")
    XCTAssertTrue(open.showsMerge)
    XCTAssertTrue(open.mergeEnabled)
    XCTAssertTrue(open.showsClose)
    XCTAssertFalse(open.showsReopen)
    XCTAssertTrue(open.showsRequestReviewers)

    let draft = PrActionAvailability(prState: "draft")
    XCTAssertTrue(draft.showsMerge)
    XCTAssertFalse(draft.mergeEnabled)
    XCTAssertFalse(draft.showsClose)
    XCTAssertFalse(draft.showsReopen)
    XCTAssertTrue(draft.showsRequestReviewers)

    let closed = PrActionAvailability(prState: "closed")
    XCTAssertFalse(closed.showsMerge)
    XCTAssertFalse(closed.mergeEnabled)
    XCTAssertFalse(closed.showsClose)
    XCTAssertTrue(closed.showsReopen)
    XCTAssertFalse(closed.showsRequestReviewers)
  }

  func testLegacyCacheDatabaseIsReplacedDuringPhase6Bootstrap() throws {
    let baseURL = makeTemporaryDirectory()
    let appURL = baseURL.appendingPathComponent("ADE", isDirectory: true)
    try FileManager.default.createDirectory(at: appURL, withIntermediateDirectories: true)

    let legacyURL = appURL.appendingPathComponent("ade-ios-local.sqlite")
    var handle: OpaquePointer?
    XCTAssertEqual(sqlite3_open(legacyURL.path, &handle), SQLITE_OK)
    XCTAssertNotNil(handle)
    XCTAssertEqual(
      sqlite3_exec(handle, "create table if not exists cached_json (key text primary key, value text);", nil, nil, nil),
      SQLITE_OK
    )
    sqlite3_close(handle)

    let database = makeDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)
    database.close()

    XCTAssertFalse(FileManager.default.fileExists(atPath: legacyURL.path))
    XCTAssertTrue(FileManager.default.fileExists(atPath: appURL.appendingPathComponent("ade-ios-local.sqlite.phase6-backup").path))
  }

  private func makeTemporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  private func makeDatabase(baseURL: URL) -> DatabaseService {
    DatabaseService(baseURL: baseURL, bootstrapSQL: """
      create table if not exists lanes (
        id text primary key,
        project_id text not null default '',
        name text not null,
        description text,
        lane_type text not null,
        base_ref text not null,
        branch_ref text not null,
        worktree_path text not null,
        attached_root_path text,
        is_edit_protected integer not null default 0,
        parent_lane_id text,
        color text,
        icon text,
        tags_json text,
        folder text,
        status text not null default 'active',
        created_at text not null,
        archived_at text
      );
      create table if not exists lane_state_snapshots (
        lane_id text primary key,
        dirty integer not null default 0,
        ahead integer not null default 0,
        behind integer not null default 0,
        remote_behind integer not null default -1,
        rebase_in_progress integer not null default 0,
        agent_summary_json text,
        mission_summary_json text,
        updated_at text not null default ''
      );
    """)
  }

  private func makeConflictPredictionsDatabase(baseURL: URL) -> DatabaseService {
    DatabaseService(baseURL: baseURL, bootstrapSQL: """
      create table if not exists conflict_predictions (
        id text primary key,
        project_id text not null default '',
        lane_a_id text not null default '',
        lane_b_id text,
        status text not null default '',
        conflicting_files_json text,
        overlap_files_json text,
        lane_a_sha text,
        lane_b_sha text,
        predicted_at text not null default '',
        expires_at text
      );
    """)
  }

  private func makeLaneHydrationDatabase(baseURL: URL) -> DatabaseService {
    DatabaseService(baseURL: baseURL, bootstrapSQL: """
      create table if not exists projects (
        id text primary key,
        root_path text not null,
        display_name text not null,
        default_base_ref text not null,
        created_at text not null,
        last_opened_at text not null
      );
      create table if not exists lanes (
        id text primary key,
        project_id text not null,
        name text not null,
        description text,
        lane_type text not null,
        base_ref text not null,
        branch_ref text not null,
        worktree_path text not null,
        attached_root_path text,
        is_edit_protected integer not null default 0,
        parent_lane_id text,
        color text,
        icon text,
        tags_json text,
        folder text,
        status text not null,
        created_at text not null,
        archived_at text
      );
      create table if not exists lane_state_snapshots (
        lane_id text primary key,
        dirty integer not null default 0,
        ahead integer not null default 0,
        behind integer not null default 0,
        remote_behind integer not null default -1,
        rebase_in_progress integer not null default 0,
        agent_summary_json text,
        mission_summary_json text,
        updated_at text not null
      );
    """)
  }

  private func makeControllerHydrationDatabase(baseURL: URL) -> DatabaseService {
    DatabaseService(baseURL: baseURL, bootstrapSQL: """
      create table if not exists projects (
        id text primary key,
        root_path text not null,
        display_name text not null,
        default_base_ref text not null,
        created_at text not null,
        last_opened_at text not null
      );
      create table if not exists lanes (
        id text primary key,
        project_id text not null,
        name text not null,
        description text,
        lane_type text not null,
        base_ref text not null,
        branch_ref text not null,
        worktree_path text not null,
        attached_root_path text,
        is_edit_protected integer not null default 0,
        parent_lane_id text,
        color text,
        icon text,
        tags_json text,
        folder text,
        status text not null,
        created_at text not null,
        archived_at text
      );
      create table if not exists lane_state_snapshots (
        lane_id text primary key,
        dirty integer not null default 0,
        ahead integer not null default 0,
        behind integer not null default 0,
        remote_behind integer not null default -1,
        rebase_in_progress integer not null default 0,
        agent_summary_json text,
        mission_summary_json text,
        updated_at text not null
      );
      create table if not exists terminal_sessions (
        id text primary key,
        lane_id text not null,
        lane_name text not null default '',
        pty_id text,
        tracked integer not null default 1,
        goal text,
        tool_type text,
        pinned integer not null default 0,
        title text not null,
        started_at text not null,
        ended_at text,
        exit_code integer,
        transcript_path text not null,
        head_sha_start text,
        head_sha_end text,
        status text not null,
        last_output_preview text,
        last_output_at text,
        summary text,
        resume_command text
      );
      create table if not exists session_deltas (
        session_id text primary key,
        project_id text not null,
        lane_id text not null,
        started_at text not null,
        ended_at text,
        head_sha_start text,
        head_sha_end text,
        files_changed integer not null,
        insertions integer not null,
        deletions integer not null,
        touched_files_json text not null,
        failure_lines_json text not null,
        computed_at text not null
      );
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
        updated_at text not null
      );
      create table if not exists pull_request_snapshots (
        pr_id text primary key,
        detail_json text,
        status_json text,
        checks_json text,
        reviews_json text,
        comments_json text,
        files_json text,
        updated_at text not null
      );
    """)
  }

  private func insertHydrationProjectGraph(into database: DatabaseService) throws {
    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values (
        'project-1', '/tmp/project', 'ADE', 'main', '2026-03-17T00:00:00.000Z', '2026-03-17T00:00:00.000Z'
      );
      insert into lanes (
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder,
        status, created_at, archived_at
      ) values (
        'lane-primary', 'project-1', 'Primary', null, 'primary', 'main', 'main', '/tmp/project',
        null, 1, null, null, null, null, null,
        'active', '2026-03-17T00:00:00.000Z', null
      );
      insert into lane_state_snapshots (
        lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress, agent_summary_json, mission_summary_json, updated_at
      ) values (
        'lane-primary', 0, 0, 0, 0, 0, null, null, '2026-03-17T00:00:00.000Z'
      );
    """)
  }

  private func packedDesktopTextPrimaryKey(_ value: String) -> SyncScalarValue {
    .bytes(SyncScalarBytes(type: "bytes", base64: packedDesktopTextPrimaryKeyData(value).base64EncodedString()))
  }

  private func packedDesktopTextPrimaryKeyData(_ value: String) -> Data {
    var bytes = Data([0x01, 0x0b, UInt8(value.utf8.count)])
    bytes.append(contentsOf: value.utf8)
    return bytes
  }

  private func countRows(in baseURL: URL, table: String) throws -> Int {
    let dbURL = baseURL.appendingPathComponent("ADE", isDirectory: true).appendingPathComponent("ade.db")
    var handle: OpaquePointer?
    XCTAssertEqual(sqlite3_open(dbURL.path, &handle), SQLITE_OK)
    defer { sqlite3_close(handle) }

    var statement: OpaquePointer?
    XCTAssertEqual(sqlite3_prepare_v2(handle, "select count(*) from \(table)", -1, &statement, nil), SQLITE_OK)
    defer { sqlite3_finalize(statement) }
    XCTAssertEqual(sqlite3_step(statement), SQLITE_ROW)
    return Int(sqlite3_column_int64(statement, 0))
  }

  private struct DummyHydrationPayload: Decodable {
    let refreshedCount: Int
  }
}

private func XCTAssertThrowsErrorAsync<T>(
  _ expression: @autoclosure () async throws -> T,
  _ errorHandler: (Error) -> Void,
  file: StaticString = #filePath,
  line: UInt = #line
) async {
  do {
    _ = try await expression()
    XCTFail("Expected expression to throw an error", file: file, line: line)
  } catch {
    errorHandler(error)
  }
}
