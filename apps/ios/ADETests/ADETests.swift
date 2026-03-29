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

  func testInitialHydrationGateCancelsWhenConnectionGenerationChanges() async {
    var activeGeneration = 1
    var sleepCalls: [UInt64] = []

    await XCTAssertThrowsErrorAsync(
      try await InitialHydrationGate.waitForProjectRow(
        timeoutNanoseconds: 1_000,
        pollIntervalNanoseconds: 200,
        currentProjectId: { nil },
        shouldContinue: { activeGeneration == 1 },
        sleep: { interval in
          sleepCalls.append(interval)
          if sleepCalls.count == 2 {
            activeGeneration = 2
          }
        }
      )
    ) { error in
      XCTAssertTrue(error is CancellationError)
    }

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

  func testSyncRequestTimeoutUsesThirtySecondFriendlyReconnectMessage() {
    XCTAssertEqual(SyncRequestTimeout.defaultTimeoutNanoseconds, 30_000_000_000)
    XCTAssertEqual(SyncRequestTimeout.error().localizedDescription, "The host took too long to respond. Reconnecting now.")
  }

  func testSyncReconnectStateUsesBackoffAndResetsAfterSuccess() {
    var state = SyncReconnectState()

    XCTAssertEqual(state.nextDelayNanoseconds(), 1_000_000_000)
    XCTAssertEqual(state.nextDelayNanoseconds(), 2_000_000_000)
    XCTAssertEqual(state.nextDelayNanoseconds(), 4_000_000_000)
    XCTAssertEqual(state.attempts, 3)

    state.reset()

    XCTAssertEqual(state.attempts, 0)
    XCTAssertEqual(state.nextDelayNanoseconds(), 1_000_000_000)
  }

  func testSyncReconnectStateReconnectsImmediatelyAfterHeartbeatTimeout() {
    var state = SyncReconnectState()

    XCTAssertEqual(state.nextDelayNanoseconds(forCloseCodeRawValue: 4001), 0)
    XCTAssertEqual(state.attempts, 0)
    XCTAssertEqual(state.nextDelayNanoseconds(), 1_000_000_000)
  }

  func testSyncBonjourTimingMatchesReliabilityRequirements() {
    XCTAssertEqual(SyncBonjourTiming.searchRetryNanoseconds, 2_000_000_000)
    XCTAssertEqual(SyncBonjourTiming.resolveRetryNanoseconds, 2_000_000_000)
    XCTAssertEqual(SyncBonjourTiming.periodicRestartNanoseconds, 30_000_000_000)
    XCTAssertEqual(SyncBonjourTiming.resolveTimeout, 10)
  }

  func testSyncUserFacingErrorTranslatesTechnicalSyncMessages() {
    let hydrationError = NSError(
      domain: "ADE",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "Unable to hydrate lanes because no project row is available yet"]
    )
    XCTAssertEqual(SyncUserFacingError.message(for: hydrationError), SyncHydrationMessaging.waitingForProjectData)

    let offlineError = NSError(
      domain: "ADE",
      code: 2,
      userInfo: [NSLocalizedDescriptionKey: "The host is offline."]
    )
    XCTAssertEqual(SyncUserFacingError.message(for: offlineError), "The host is offline. Reconnect, then try again.")

    let authError = NSError(
      domain: "ADE",
      code: 3,
      userInfo: [NSLocalizedDescriptionKey: "Authentication failed.", "ADEErrorCode": "auth_failed"]
    )
    XCTAssertEqual(SyncUserFacingError.message(for: authError), "This phone is no longer paired with the host. Pair again from Settings.")

    let invalidHelloError = NSError(
      domain: "ADE",
      code: 4,
      userInfo: [NSLocalizedDescriptionKey: "Invalid hello response."]
    )
    XCTAssertEqual(SyncUserFacingError.message(for: invalidHelloError), "The host replied with unexpected pairing data. Reconnect and try again.")

    let queuedOperationError = NSError(
      domain: "ADE",
      code: 5,
      userInfo: [NSLocalizedDescriptionKey: "Unknown queued operation type."]
    )
    XCTAssertEqual(SyncUserFacingError.message(for: queuedOperationError), "Queued sync work on this phone became unreadable. Reconnect and try the action again.")

    let compressedPayloadError = NSError(
      domain: "ADE",
      code: 6,
      userInfo: [NSLocalizedDescriptionKey: "Unable to decode compressed sync payload."]
    )
    XCTAssertEqual(SyncUserFacingError.message(for: compressedPayloadError), "The host sent unreadable sync data. Reconnect and try again.")
  }

  func testStaleSendCallbackGuardOnlyHandlesActiveSocket() {
    let url = URL(string: "ws://example.com:8787")!
    let activeSocket = URLSession.shared.webSocketTask(with: url)
    let staleSocket = URLSession.shared.webSocketTask(with: url)

    XCTAssertTrue(shouldHandleSocketSendCompletionError(currentSocket: activeSocket, callbackSocket: activeSocket))
    XCTAssertFalse(shouldHandleSocketSendCompletionError(currentSocket: activeSocket, callbackSocket: staleSocket))
    XCTAssertFalse(shouldHandleSocketSendCompletionError(currentSocket: nil, callbackSocket: staleSocket))
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

  func testFilterPullRequestListItemsMatchesStateAndSearch() {
    let items = [
      PullRequestListItem(
        id: "pr-1",
        laneId: "lane-1",
        laneName: "Inbox",
        projectId: "project-1",
        repoOwner: "arul",
        repoName: "ade",
        githubPrNumber: 11,
        githubUrl: "https://github.com/arul/ade/pull/11",
        title: "Improve review timeline",
        state: "open",
        baseBranch: "main",
        headBranch: "feature/reviews",
        checksStatus: "passing",
        reviewStatus: "approved",
        additions: 12,
        deletions: 2,
        lastSyncedAt: nil,
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
        adeKind: "single",
        linkedGroupId: nil,
        linkedGroupType: nil,
        linkedGroupName: nil,
        linkedGroupPosition: nil,
        linkedGroupCount: 0,
        workflowDisplayState: nil,
        cleanupState: nil
      ),
      PullRequestListItem(
        id: "pr-2",
        laneId: "lane-2",
        laneName: "Queue lane",
        projectId: "project-1",
        repoOwner: "arul",
        repoName: "ade",
        githubPrNumber: 12,
        githubUrl: "https://github.com/arul/ade/pull/12",
        title: "Draft queue workflow",
        state: "draft",
        baseBranch: "main",
        headBranch: "feature/queue",
        checksStatus: "pending",
        reviewStatus: "requested",
        additions: 30,
        deletions: 4,
        lastSyncedAt: nil,
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
        adeKind: "queue",
        linkedGroupId: "group-1",
        linkedGroupType: "queue",
        linkedGroupName: "Queue",
        linkedGroupPosition: 1,
        linkedGroupCount: 2,
        workflowDisplayState: nil,
        cleanupState: nil
      ),
      PullRequestListItem(
        id: "pr-3",
        laneId: "lane-3",
        laneName: "Cleanup",
        projectId: "project-1",
        repoOwner: "arul",
        repoName: "ade",
        githubPrNumber: 13,
        githubUrl: "https://github.com/arul/ade/pull/13",
        title: "Merged cleanup banner",
        state: "merged",
        baseBranch: "main",
        headBranch: "feature/cleanup",
        checksStatus: "passing",
        reviewStatus: "approved",
        additions: 4,
        deletions: 1,
        lastSyncedAt: nil,
        createdAt: "2026-03-20T00:00:00.000Z",
        updatedAt: "2026-03-20T00:00:00.000Z",
        adeKind: "integration",
        linkedGroupId: "group-2",
        linkedGroupType: "integration",
        linkedGroupName: "Integration",
        linkedGroupPosition: 0,
        linkedGroupCount: 1,
        workflowDisplayState: "active",
        cleanupState: "required"
      ),
    ]

    XCTAssertEqual(filterPullRequestListItems(items, query: "review", state: .all).map(\.id), ["pr-1"])
    XCTAssertEqual(filterPullRequestListItems(items, query: "", state: .draft).map(\.id), ["pr-2"])
    XCTAssertEqual(filterPullRequestListItems(items, query: "cleanup", state: .merged).map(\.id), ["pr-3"])
    XCTAssertEqual(filterPullRequestListItems(items, query: "", state: .open).map(\.id), ["pr-1"])
  }

  func testLaneListFilteringMatchesSearchPrefixesAndSortOrder() {
    let snapshots = [
      makeLaneListSnapshot(
        id: "lane-primary",
        name: "main",
        laneType: "primary",
        baseRef: "main",
        branchRef: "main",
        worktreePath: "/project",
        description: "Primary lane",
        status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
        runtime: LaneRuntimeSummary(bucket: "running", runningCount: 2, awaitingInputCount: 0, endedCount: 0, sessionCount: 2),
        createdAt: "2026-03-01T00:00:00.000Z",
        archivedAt: nil
      ),
      makeLaneListSnapshot(
        id: "lane-attached-active",
        name: "docs",
        laneType: "attached",
        baseRef: "main",
        branchRef: "docs/cleanup",
        worktreePath: "/project/docs",
        description: "Docs cleanup lane",
        status: LaneStatus(dirty: true, ahead: 3, behind: 1, remoteBehind: 0, rebaseInProgress: false),
        runtime: LaneRuntimeSummary(bucket: "ended", runningCount: 0, awaitingInputCount: 0, endedCount: 1, sessionCount: 1),
        stateSnapshot: LaneStateSnapshotSummary(
          laneId: "lane-attached-active",
          agentSummary: ["summary": .string("Agent waiting on approval")],
          missionSummary: ["summary": .string("Ship the cleanup")],
          updatedAt: nil
        ),
        createdAt: "2026-03-20T00:00:00.000Z",
        archivedAt: nil,
        adoptableAttached: true
      ),
      makeLaneListSnapshot(
        id: "lane-worktree",
        name: "auth-flow",
        laneType: "worktree",
        baseRef: "main",
        branchRef: "feature/auth",
        worktreePath: "/project/.ade/worktrees/auth",
        description: "OAuth flow",
        status: LaneStatus(dirty: false, ahead: 1, behind: 0, remoteBehind: 0, rebaseInProgress: false),
        runtime: LaneRuntimeSummary(bucket: "awaiting-input", runningCount: 0, awaitingInputCount: 1, endedCount: 0, sessionCount: 1),
        stateSnapshot: LaneStateSnapshotSummary(
          laneId: "lane-worktree",
          agentSummary: ["title": .string("Codex")],
          missionSummary: ["objective": .string("Handle OAuth redirects")],
          updatedAt: nil
        ),
        createdAt: "2026-03-10T00:00:00.000Z",
        archivedAt: nil,
        adoptableAttached: false
      ),
      makeLaneListSnapshot(
        id: "lane-archived",
        name: "legacy",
        laneType: "attached",
        baseRef: "main",
        branchRef: "legacy/refactor",
        worktreePath: "/legacy",
        description: "Legacy lane",
        status: LaneStatus(dirty: false, ahead: 0, behind: 2, remoteBehind: 0, rebaseInProgress: false),
        runtime: LaneRuntimeSummary(bucket: "running", runningCount: 1, awaitingInputCount: 0, endedCount: 0, sessionCount: 4),
        createdAt: "2026-02-01T00:00:00.000Z",
        archivedAt: "2026-03-25T00:00:00.000Z"
      ),
    ]

    XCTAssertEqual(laneScopeCount(snapshots, scope: .active), 3)
    XCTAssertEqual(laneScopeCount(snapshots, scope: .archived), 1)
    XCTAssertEqual(laneRuntimeCount(snapshots, filter: .running), 2)
    XCTAssertEqual(laneRuntimeCount(snapshots, filter: .awaitingInput), 1)

    let activeFiltered = laneListFilteredSnapshots(
      snapshots,
      scope: .active,
      runtimeFilter: .all,
      searchText: "",
      pinnedLaneIds: ["lane-worktree"]
    )
    XCTAssertEqual(activeFiltered.map(\.lane.id), ["lane-primary", "lane-attached-active", "lane-worktree"])

    XCTAssertTrue(laneMatchesSearch(snapshot: snapshots[1], isPinned: false, query: "docs main"))
    XCTAssertTrue(laneMatchesSearch(snapshot: snapshots[1], isPinned: false, query: "is:dirty type:attached"))
    XCTAssertTrue(laneMatchesSearch(snapshot: snapshots[2], isPinned: true, query: "is:pinned awaiting"))
    XCTAssertTrue(laneMatchesSearch(snapshot: snapshots[0], isPinned: false, query: "is:clean is:primary"))
    XCTAssertTrue(laneMatchesSearch(snapshot: snapshots[2], isPinned: true, query: "is:worktree"))
    XCTAssertFalse(laneMatchesSearch(snapshot: snapshots[0], isPinned: false, query: "is:unknown"))
    XCTAssertFalse(laneMatchesSearch(snapshot: snapshots[0], isPinned: false, query: "type:attached"))

    XCTAssertEqual(laneListEmptyStateTitle(scope: .active), "No active lanes")
    XCTAssertEqual(
      laneListEmptyStateMessage(scope: .all, searchText: "auth", hasFilters: true),
      "Try a different search or clear the filter."
    )
  }

  func testBuildPullRequestTimelineOrdersStateReviewsAndComments() {
    let pr = PullRequestListItem(
      id: "pr-9",
      laneId: "lane-9",
      laneName: "Feature",
      projectId: "project-1",
      repoOwner: "arul",
      repoName: "ade",
      githubPrNumber: 99,
      githubUrl: "https://github.com/arul/ade/pull/99",
      title: "Merge timeline",
      state: "merged",
      baseBranch: "main",
      headBranch: "feature/timeline",
      checksStatus: "passing",
      reviewStatus: "approved",
      additions: 10,
      deletions: 3,
      lastSyncedAt: nil,
      createdAt: "2026-03-20T09:00:00.000Z",
      updatedAt: "2026-03-20T12:00:00.000Z",
      adeKind: "single",
      linkedGroupId: nil,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: nil,
      cleanupState: nil
    )

    let timeline = buildPullRequestTimeline(
      pr: pr,
      snapshot: PullRequestSnapshot(
        detail: PrDetail(
          prId: "pr-9",
          body: nil,
          assignees: [],
          author: PrUser(login: "arul", avatarUrl: nil),
          isDraft: false,
          labels: [],
          requestedReviewers: [],
          milestone: nil,
          linkedIssues: []
        ),
        status: PrStatus(
          prId: "pr-9",
          state: "merged",
          checksStatus: "passing",
          reviewStatus: "approved",
          isMergeable: true,
          mergeConflicts: false,
          behindBaseBy: 0
        ),
        checks: [],
        reviews: [
          PrReview(
            reviewer: "reviewer",
            state: "approved",
            body: "Looks good to me",
            submittedAt: "2026-03-20T11:00:00.000Z"
          ),
        ],
        comments: [
          PrComment(
            id: "comment-1",
            author: "bot",
            body: "Queued for merge",
            source: "issue",
            url: nil,
            path: nil,
            line: nil,
            createdAt: "2026-03-20T10:00:00.000Z",
            updatedAt: nil
          ),
        ],
        files: []
      )
    )

    XCTAssertEqual(timeline.map(\.kind), [.stateChange, .review, .comment, .stateChange])
    XCTAssertEqual(timeline.first?.title, "Merged")
    XCTAssertEqual(timeline.last?.title, "Opened")
  }

  func testParsePullRequestPatchBuildsLineNumbers() {
    let lines = parsePullRequestPatch("""
    @@ -1,2 +1,3 @@
     let value = 1
    -let title = \"Old\"
    +let title = \"New\"
    +let subtitle = \"More\"
    """)

    XCTAssertEqual(lines.count, 5)
    XCTAssertEqual(lines[0].kind, .hunk)
    XCTAssertEqual(lines[1].oldLineNumber, 1)
    XCTAssertEqual(lines[1].newLineNumber, 1)
    XCTAssertEqual(lines[2].kind, .removed)
    XCTAssertEqual(lines[2].oldLineNumber, 2)
    XCTAssertNil(lines[2].newLineNumber)
    XCTAssertEqual(lines[3].kind, .added)
    XCTAssertNil(lines[3].oldLineNumber)
    XCTAssertEqual(lines[3].newLineNumber, 2)
    XCTAssertEqual(lines[4].newLineNumber, 3)
  }

  func testDatabaseFetchPullRequestListItemsIncludesWorkflowContext() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    try database.replacePullRequestHydration(
      PullRequestRefreshPayload(
        refreshedCount: 2,
        prs: [
          PrSummary(
            id: "pr-1",
            laneId: "lane-primary",
            projectId: "project-1",
            repoOwner: "arul",
            repoName: "ade",
            githubPrNumber: 42,
            githubUrl: "https://github.com/arul/ade/pull/42",
            githubNodeId: nil,
            title: "Queue entry",
            state: "open",
            baseBranch: "main",
            headBranch: "feature/queue-1",
            checksStatus: "pending",
            reviewStatus: "requested",
            additions: 12,
            deletions: 4,
            lastSyncedAt: nil,
            createdAt: "2026-03-17T00:10:00.000Z",
            updatedAt: "2026-03-17T00:10:00.000Z"
          ),
          PrSummary(
            id: "pr-2",
            laneId: "lane-child",
            projectId: "project-1",
            repoOwner: "arul",
            repoName: "ade",
            githubPrNumber: 43,
            githubUrl: "https://github.com/arul/ade/pull/43",
            githubNodeId: nil,
            title: "Queue entry two",
            state: "open",
            baseBranch: "main",
            headBranch: "feature/queue-2",
            checksStatus: "passing",
            reviewStatus: "approved",
            additions: 5,
            deletions: 1,
            lastSyncedAt: nil,
            createdAt: "2026-03-17T00:12:00.000Z",
            updatedAt: "2026-03-17T00:12:00.000Z"
          ),
        ],
        snapshots: []
      )
    )

    try database.executeSqlForTesting("""
      create table if not exists pr_groups (
        id text primary key,
        project_id text not null,
        group_type text not null,
        name text,
        target_branch text,
        created_at text not null
      );
      create table if not exists pr_group_members (
        id text primary key,
        group_id text not null,
        pr_id text not null,
        lane_id text not null,
        position integer not null,
        role text not null
      );
      create table if not exists integration_proposals (
        id text primary key,
        project_id text not null,
        source_lane_ids_json text not null,
        base_branch text not null,
        steps_json text not null,
        pairwise_results_json text not null,
        lane_summaries_json text not null,
        overall_outcome text not null,
        created_at text not null,
        status text not null,
        linked_group_id text,
        linked_pr_id text,
        workflow_display_state text,
        cleanup_state text
      );
    """)

    try database.executeSqlForTesting("""
      insert into pr_groups(id, project_id, group_type, name, target_branch, created_at)
      values ('group-1', 'project-1', 'queue', 'Queue rollout', 'main', '2026-03-17T00:15:00.000Z');
    """)
    try database.executeSqlForTesting("""
      insert into pr_group_members(id, group_id, pr_id, lane_id, position, role)
      values
        ('member-1', 'group-1', 'pr-1', 'lane-primary', 0, 'source'),
        ('member-2', 'group-1', 'pr-2', 'lane-child', 1, 'source');
    """)
    try database.executeSqlForTesting("""
      insert into integration_proposals(
        id, project_id, source_lane_ids_json, base_branch, steps_json, pairwise_results_json,
        lane_summaries_json, overall_outcome, created_at, status, linked_group_id, linked_pr_id,
        workflow_display_state, cleanup_state
      ) values (
        'proposal-1', 'project-1', '["lane-primary"]', 'main', '[]', '[]', '[]', 'clean',
        '2026-03-17T00:20:00.000Z', 'committed', 'group-1', 'pr-1', 'active', 'required'
      );
    """)

    let items = database.fetchPullRequestListItems()
    let first = try XCTUnwrap(items.first(where: { $0.id == "pr-1" }))
    XCTAssertEqual(first.adeKind, "integration")
    XCTAssertEqual(first.linkedGroupId, "group-1")
    XCTAssertEqual(first.linkedGroupCount, 2)
    XCTAssertEqual(first.cleanupState, "required")
    database.close()
  }

  func testFilesLanguageDetectionCoversDesktopParityLanguages() {
    XCTAssertEqual(FilesLanguage.detect(languageId: "swift", filePath: "App.swift"), .swift)
    XCTAssertEqual(FilesLanguage.detect(languageId: "typescript", filePath: "Button.tsx"), .typescript)
    XCTAssertEqual(FilesLanguage.detect(languageId: "javascript", filePath: "index.js"), .javascript)
    XCTAssertEqual(FilesLanguage.detect(languageId: "python", filePath: "script.py"), .python)
    XCTAssertEqual(FilesLanguage.detect(languageId: nil, filePath: "Cargo.toml"), .plaintext)
    XCTAssertEqual(FilesLanguage.detect(languageId: nil, filePath: "config.yaml"), .yaml)
    XCTAssertEqual(FilesLanguage.detect(languageId: nil, filePath: "README.md"), .markdown)
  }

  func testSyntaxHighlighterTokenizesSwiftKeywordsStringsAndComments() {
    let tokens = SyntaxHighlighter.tokenize(
      "import Foundation\nstruct Demo {\n  let title = \"Hello\"\n  // Greets the workspace\n}",
      as: .swift
    )

    XCTAssertTrue(tokens.contains(where: { $0.role == .keyword && $0.text == "import" }))
    XCTAssertTrue(tokens.contains(where: { $0.role == .keyword && $0.text == "struct" }))
    XCTAssertTrue(tokens.contains(where: { $0.role == .type && $0.text == "Demo" }))
    XCTAssertTrue(tokens.contains(where: { $0.role == .string && $0.text == "\"Hello\"" }))
    XCTAssertTrue(tokens.contains(where: { $0.role == .comment && $0.text.contains("Greets the workspace") }))
  }

  func testSyntaxHighlighterTokenizesTypeScriptKeywordsAndTypes() {
    let tokens = SyntaxHighlighter.tokenize(
      "export async function loadUser(id: string): Promise<User> {\n  return await api.get(\"/users\")\n}",
      as: .typescript
    )

    XCTAssertTrue(tokens.contains(where: { $0.role == .keyword && $0.text == "export" }))
    XCTAssertTrue(tokens.contains(where: { $0.role == .keyword && $0.text == "async" }))
    XCTAssertTrue(tokens.contains(where: { $0.role == .keyword && $0.text == "function" }))
    XCTAssertTrue(tokens.contains(where: { $0.role == .type && $0.text == "Promise" }))
    XCTAssertTrue(tokens.contains(where: { $0.role == .type && $0.text == "User" }))
    XCTAssertTrue(tokens.contains(where: { $0.role == .string && $0.text == "\"/users\"" }))
  }

  func testInlineDiffBuilderMarksAddedAndRemovedLines() {
    let lines = buildInlineDiffLines(
      original: "let value = 1\nprint(value)",
      modified: "let value = 2\nprint(value)\nprint(\"done\")"
    )

    XCTAssertTrue(lines.contains(where: { $0.kind == .removed && $0.text == "let value = 1" }))
    XCTAssertTrue(lines.contains(where: { $0.kind == .added && $0.text == "let value = 2" }))
    XCTAssertTrue(lines.contains(where: { $0.kind == .unchanged && $0.text == "print(value)" }))
    XCTAssertTrue(lines.contains(where: { $0.kind == .added && $0.text == "print(\"done\")" }))
  }

  func testFileIconMapsCommonExtensionsToSfSymbols() {
    XCTAssertEqual(fileIcon(for: "App.swift"), "chevron.left.forwardslash.chevron.right")
    XCTAssertEqual(fileIcon(for: "config.json"), "doc.badge.gearshape")
    XCTAssertEqual(fileIcon(for: "notes.md"), "doc.text")
    XCTAssertEqual(fileIcon(for: "preview.png"), "photo")
    XCTAssertEqual(fileIcon(for: "archive.zip"), "doc.zipper")
    XCTAssertEqual(fileIcon(for: "unknown.bin"), "doc")
  }

  func testFormattedFileSizeUsesReadableUnits() {
    XCTAssertEqual(formattedFileSize(999), "999 B")
    XCTAssertEqual(formattedFileSize(2_048), "2 KB")
    XCTAssertEqual(formattedFileSize(1_572_864), "1.5 MB")
  }

  func testAgentChatTranscriptResponseDecodesEntries() throws {
    let payload: [String: Any] = [
      "sessionId": "chat-1",
      "entries": [
        [
          "role": "user",
          "text": "Ship Work tab parity.",
          "timestamp": "2026-03-25T00:00:00.000Z",
        ],
        [
          "role": "assistant",
          "text": "On it.",
          "timestamp": "2026-03-25T00:00:01.000Z",
          "turnId": "turn-1",
        ],
      ],
      "truncated": false,
      "totalEntries": 2,
    ]

    let data = try JSONSerialization.data(withJSONObject: payload)
    let decoded = try JSONDecoder().decode(AgentChatTranscriptResponse.self, from: data)

    XCTAssertEqual(decoded.sessionId, "chat-1")
    XCTAssertEqual(decoded.entries.count, 2)
    XCTAssertEqual(decoded.entries.last?.turnId, "turn-1")
    XCTAssertFalse(decoded.truncated)
    XCTAssertEqual(decoded.totalEntries, 2)
  }

  func testWorkChatTranscriptHelpersBuildToolCardsAndRunningAgents() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:00.000Z","sequence":1,"event":{"type":"user_message","text":"Inspect README","turnId":"turn-1"}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:01.000Z","sequence":2,"event":{"type":"subagent_started","taskId":"task-1","description":"Docs helper","turnId":"turn-1"}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:02.000Z","sequence":3,"event":{"type":"subagent_progress","taskId":"task-1","summary":"Reading README.md","lastToolName":"functions.Read","turnId":"turn-1"}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:03.000Z","sequence":4,"event":{"type":"tool_call","tool":"functions.Read","args":{"file_path":"README.md"},"itemId":"tool-1","turnId":"turn-1"}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:04.000Z","sequence":5,"event":{"type":"tool_result","tool":"functions.Read","result":{"content":"ADE"},"itemId":"tool-1","turnId":"turn-1","status":"completed"}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:05.000Z","sequence":6,"event":{"type":"text","text":"# Done\n- Read the project overview.","turnId":"turn-1"}}
    """

    let transcript = parseWorkChatTranscript(raw)
    let toolCards = buildWorkToolCards(from: transcript)
    let activeAgents = deriveWorkAgentActivities(
      from: transcript,
      session: WorkAgentActivityContext(
        sessionId: "chat-1",
        title: "Claude chat",
        laneName: "feature/work",
        status: "running",
        startedAt: "2026-03-25T00:00:00.000Z"
      )
    )

    XCTAssertEqual(transcript.count, 6)
    XCTAssertEqual(toolCards.count, 1)
    XCTAssertEqual(toolCards.first?.toolName, "functions.Read")
    XCTAssertEqual(toolCards.first?.status, .completed)
    XCTAssertTrue(toolCards.first?.resultText?.contains("ADE") == true)
    XCTAssertEqual(activeAgents.count, 1)
    XCTAssertEqual(activeAgents.first?.agentName, "Docs helper")
    XCTAssertEqual(activeAgents.first?.toolName, "functions.Read")
  }

  func testVisibleWorkTimelineEntriesKeepsNewestPage() {
    let entries = (1...6).map { index in
      WorkTimelineEntry(
        id: "entry-\(index)",
        timestamp: String(format: "2026-03-25T00:00:%02d.000Z", index),
        rank: index,
        payload: .message(
          WorkChatMessage(
            id: "message-\(index)",
            role: index.isMultiple(of: 2) ? "assistant" : "user",
            markdown: "Message \(index)",
            timestamp: String(format: "2026-03-25T00:00:%02d.000Z", index),
            turnId: nil,
            itemId: nil
          )
        )
      )
    }

    XCTAssertEqual(
      visibleWorkTimelineEntries(from: entries, visibleCount: 3).map(\.id),
      ["entry-4", "entry-5", "entry-6"]
    )
  }

  func testVisibleWorkTimelineEntriesReturnsAllRowsWhenRequestedCountExceedsTranscript() {
    let entries = (1...3).map { index in
      WorkTimelineEntry(
        id: "entry-\(index)",
        timestamp: String(format: "2026-03-25T00:00:%02d.000Z", index),
        rank: index,
        payload: .message(
          WorkChatMessage(
            id: "message-\(index)",
            role: "assistant",
            markdown: "Message \(index)",
            timestamp: String(format: "2026-03-25T00:00:%02d.000Z", index),
            turnId: nil,
            itemId: nil
          )
        )
      )
    }

    XCTAssertEqual(visibleWorkTimelineEntries(from: entries, visibleCount: 10).map(\.id), entries.map(\.id))
  }

  func testExtractWorkNavigationTargetsFindsFilePathsAndPullRequestNumbers() {
    let targets = extractWorkNavigationTargets(
      from: #"Updated apps/ios/ADE/Views/WorkTabView.swift and docs/plan.md before opening PR #145. See src/main.ts too."#
    )

    XCTAssertEqual(targets.filePaths, [
      "apps/ios/ADE/Views/WorkTabView.swift",
      "docs/plan.md",
      "src/main.ts",
    ])
    XCTAssertEqual(targets.pullRequestNumbers, [145])
  }

  func testExtractWorkNavigationTargetsIgnoresMarkdownHeadingsAndShellFlags() {
    let targets = extractWorkNavigationTargets(
      from: #"# Summary\nRun git diff --stat before checking README.md. Avoid --watch and -v flags."#
    )

    XCTAssertEqual(targets.filePaths, ["README.md"])
    XCTAssertTrue(targets.pullRequestNumbers.isEmpty)
  }

  func testADEImageCacheStoresAndRestoresDiskBackedEntries() {
    let directory = makeTemporaryDirectory().appendingPathComponent("image-cache", isDirectory: true)
    let cache = ADEImageCache(cacheDirectory: directory)
    let data = Data([0x89, 0x50, 0x4E, 0x47])

    cache.store(data, for: "artifact-1")

    XCTAssertEqual(cache.cachedData(for: "artifact-1"), data)
    XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent(cache.diskFilename(for: "artifact-1")).path))
  }

  func testParseANSISegmentsTracksForegroundColors() {
    let segments = parseANSISegments("\u{001B}[31mError\u{001B}[0m plain \u{001B}[32mOK\u{001B}[0m")

    XCTAssertEqual(segments.map(\.text), ["Error", " plain ", "OK"])
    XCTAssertEqual(segments[safe: 0]?.foreground, .red)
    XCTAssertNil(segments[safe: 1]?.foreground)
    XCTAssertEqual(segments[safe: 2]?.foreground, .green)
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

  private func makeLaneListSnapshot(
    id: String,
    name: String,
    laneType: String,
    baseRef: String,
    branchRef: String,
    worktreePath: String,
    description: String?,
    status: LaneStatus,
    runtime: LaneRuntimeSummary,
    stateSnapshot: LaneStateSnapshotSummary? = nil,
    createdAt: String,
    archivedAt: String?,
    adoptableAttached: Bool = false
  ) -> LaneListSnapshot {
    LaneListSnapshot(
      lane: LaneSummary(
        id: id,
        name: name,
        description: description,
        laneType: laneType,
        baseRef: baseRef,
        branchRef: branchRef,
        worktreePath: worktreePath,
        attachedRootPath: laneType == "attached" ? worktreePath : nil,
        parentLaneId: nil,
        childCount: 0,
        stackDepth: 0,
        parentStatus: nil,
        isEditProtected: false,
        status: status,
        color: nil,
        icon: nil,
        tags: [],
        folder: nil,
        createdAt: createdAt,
        archivedAt: archivedAt
      ),
      runtime: runtime,
      rebaseSuggestion: nil,
      autoRebaseStatus: nil,
      conflictStatus: nil,
      stateSnapshot: stateSnapshot,
      adoptableAttached: adoptableAttached
    )
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

private extension Collection {
  subscript(safe index: Index) -> Element? {
    indices.contains(index) ? self[index] : nil
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
