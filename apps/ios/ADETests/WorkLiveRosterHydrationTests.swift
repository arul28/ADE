import XCTest
@testable import ADE

final class WorkLiveRosterHydrationTests: XCTestCase {
  func testAuthoritativeRosterChatLaneBeatsEarlierStaleLaneAndBranchHints() {
    let project = makeProject(id: "project-1", name: "ADE")
    let stale = makeRosterLane(id: "lane-stale", name: "Stale", branch: "feature/stale")
    let authoritative = makeRosterLane(id: "lane-authoritative", name: "Authoritative", branch: "feature/current")
    let roster = makeRoster(projectId: project.id, name: project.displayName, lanes: [stale, authoritative], chats: [makeRosterChat(id: "chat-1", laneId: authoritative.id)])

    let target = resolveRosterSessionNavigationTarget(projects: [project], rosterProjects: [roster], sessionId: "chat-1", laneId: stale.id, repoOwner: nil, repoName: nil, branch: stale.branchRef)

    XCTAssertEqual(target?.lane?.id, authoritative.id)
    XCTAssertEqual(target?.chat.laneId, authoritative.id)
  }

  func testExpectedProjectHydrationWritesRefuseAfterProjectSwitchWithoutMutatingNewProject() throws {
    let database = DatabaseService(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    try database.executeSqlForTesting("""
      insert into projects (id, root_path, display_name, default_base_ref, created_at, last_opened_at) values
      ('project-a', '/tmp/a', 'A', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'),
      ('project-b', '/tmp/b', 'B', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:01.000Z');
    """)
    database.setActiveProjectId("project-b")
    let baselineLane = makeLane(id: "lane-b", name: "B baseline")
    let baselineSession = makeSession(id: "session-b", laneId: baselineLane.id, laneName: baselineLane.name)
    let baselinePullRequest = makePullRequest(id: "pr-b", laneId: baselineLane.id, projectId: "project-b")
    let baselineDetail = makeLaneDetail(lane: baselineLane, signature: "detail-b")
    let baselineWorkspace = FilesWorkspace(
      id: "workspace-b",
      kind: "primary",
      laneId: nil,
      name: "B",
      rootPath: "/tmp/b",
      isReadOnlyByDefault: false
    )
    try database.replaceLaneSnapshots([baselineLane])
    try database.replaceTerminalSessions([baselineSession])
    try database.replacePullRequestHydration(makePullRequestPayload([baselinePullRequest]))
    try database.replaceLaneDetail(baselineDetail)
    try database.replaceFilesWorkspaces([baselineWorkspace])

    XCTAssertThrowsError(try database.replaceLaneSnapshots([makeLane(id: "lane-a", name: "A stale")], expectedProjectId: "project-a")) { error in
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertThrowsError(try database.replaceTerminalSessions([makeSession(id: "session-a", laneId: "lane-a", laneName: "A stale")], expectedProjectId: "project-a")) { error in
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertThrowsError(try database.replacePullRequestHydration(makePullRequestPayload([]), expectedProjectId: "project-a")) { error in
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertThrowsError(try database.replaceLaneDetail(makeLaneDetail(lane: makeLane(id: "lane-a", name: "A stale")), expectedProjectId: "project-a")) { error in
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertThrowsError(try database.replaceFilesWorkspaces([], expectedProjectId: "project-a")) { error in
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertEqual(database.fetchLanes(includeArchived: false).map(\.id), [baselineLane.id])
    XCTAssertEqual(database.fetchSessions().map(\.id), [baselineSession.id])
    XCTAssertEqual(database.fetchPullRequests().map(\.id), [baselinePullRequest.id])
    XCTAssertEqual(database.fetchLaneDetail(laneId: baselineLane.id), baselineDetail)
    XCTAssertEqual(database.listWorkspaces(), [baselineWorkspace])
  }

  @MainActor
  func testSuspendedLaneDetailRefreshCancelsWithoutOverwritingNewProjectStatusOrCache() async throws {
    let database = DatabaseService(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    try database.executeSqlForTesting("""
      insert into projects (id, root_path, display_name, default_base_ref, created_at, last_opened_at) values
      ('project-a', '/tmp/a', 'A', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'),
      ('project-b', '/tmp/b', 'B', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:01.000Z');
    """)
    let service = SyncService(database: database)
    service.setActiveProjectForTesting(projectId: "project-b", rootPath: "/tmp/b")
    let baselineLane = makeLane(id: "lane-b", name: "B baseline")
    let baselineDetail = makeLaneDetail(lane: baselineLane, signature: "detail-b")
    try database.replaceLaneSnapshots([baselineLane])
    try database.replaceLaneDetail(baselineDetail)

    service.setActiveProjectForTesting(projectId: "project-a", rootPath: "/tmp/a")
    try database.replaceLaneSnapshots([makeLane(id: "lane-a", name: "A baseline")])
    service.configureConnectedTransportForTesting()
    service.beginOutboundEnvelopeCaptureForTesting()
    let previousLaneStatus = service.status(for: .lanes)
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
    }

    let refresh = Task { try await service.refreshLaneDetail(laneId: "lane-a") }
    var requestId: String?
    for _ in 0..<20 where requestId == nil {
      await Task.yield()
      requestId = service.capturedOutboundRequestIdsForTesting(type: "command").first
    }
    let firstRequestId = try XCTUnwrap(requestId)
    service.completeCapturedRequestForTesting(
      requestId: firstRequestId,
      result: ["notModified": true, "signature": "detail-a"]
    )
    var requestIds: [String] = []
    for _ in 0..<20 where requestIds.count < 2 {
      await Task.yield()
      requestIds = service.capturedOutboundRequestIdsForTesting(type: "command")
    }
    guard requestIds.count == 2 else {
      return XCTFail("Expected a full lane-detail retry after an unusable not-modified response.")
    }
    XCTAssertEqual(
      requestIds.map { service.capturedOutboundProjectIdForTesting(requestId: $0) },
      ["project-a", "project-a"]
    )
    service.setActiveProjectForTesting(projectId: "project-b", rootPath: "/tmp/b")
    // Rehydrate B after the project transition. Replacing A's lane snapshot
    // intentionally pruned B's global detail cache earlier in the fixture.
    try database.replaceLaneSnapshots([baselineLane])
    try database.replaceLaneDetail(baselineDetail)
    service.completeCapturedRequestForTesting(
      requestId: requestIds[1],
      result: ["notModified": false]
    )

    do {
      _ = try await refresh.value
      XCTFail("Expected the old-project lane-detail refresh to cancel.")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertEqual(service.status(for: .lanes), previousLaneStatus)
    XCTAssertNotEqual(service.status(for: .lanes).phase, .hydrating)
    XCTAssertEqual(database.fetchLaneDetail(laneId: baselineLane.id), baselineDetail)
  }

  @MainActor
  func testSuspendedWorkspaceRefreshCannotPruneNewProjectWorkspaceCache() async throws {
    let database = DatabaseService(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    try database.executeSqlForTesting("""
      insert into projects (id, root_path, display_name, default_base_ref, created_at, last_opened_at) values
      ('project-a', '/tmp/a', 'A', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'),
      ('project-b', '/tmp/b', 'B', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:01.000Z');
    """)
    let service = SyncService(database: database)
    service.setActiveProjectForTesting(projectId: "project-b", rootPath: "/tmp/b")
    let baselineWorkspace = FilesWorkspace(
      id: "workspace-b",
      kind: "primary",
      laneId: nil,
      name: "B",
      rootPath: "/tmp/b",
      isReadOnlyByDefault: false
    )
    try database.replaceFilesWorkspaces([baselineWorkspace])

    service.setActiveProjectForTesting(projectId: "project-a", rootPath: "/tmp/a")
    service.configureConnectedTransportForTesting()
    service.beginOutboundEnvelopeCaptureForTesting()
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
    }

    let refresh = Task { try await service.listWorkspaces() }
    var requestId: String?
    for _ in 0..<20 where requestId == nil {
      await Task.yield()
      requestId = service.capturedOutboundRequestIdsForTesting(type: "file_request").first
    }
    let capturedRequestId = try XCTUnwrap(requestId)
    XCTAssertEqual(
      service.capturedOutboundProjectIdForTesting(requestId: capturedRequestId),
      "project-a"
    )
    service.setActiveProjectForTesting(projectId: "project-b", rootPath: "/tmp/b")
    service.completeCapturedRequestForTesting(
      requestId: capturedRequestId,
      result: [Any]()
    )

    do {
      _ = try await refresh.value
      XCTFail("Expected the old-project workspace refresh to cancel.")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertEqual(database.listWorkspaces(), [baselineWorkspace])
  }

  @MainActor
  func testProjectSwitchTeardownRetiresOldPendingRequestBeforeItsTimeoutCanProbeNewSocket() async throws {
    let database = DatabaseService(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    let service = SyncService(database: database)
    service.setActiveProjectForTesting(projectId: "project-a", rootPath: "/tmp/a")
    service.configureConnectedTransportForTesting()
    service.beginOutboundEnvelopeCaptureForTesting()
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
    }

    let request = Task { try await service.getModelFavorites() }
    var requestId: String?
    for _ in 0..<20 where requestId == nil {
      await Task.yield()
      requestId = service.capturedOutboundRequestIdsForTesting(type: "command").first
    }
    let capturedRequestId = try XCTUnwrap(requestId)
    let retiredGeneration = try XCTUnwrap(
      service.pendingRequestGenerationForTesting(requestId: capturedRequestId)
    )

    service.teardownSocketForTesting()
    XCTAssertNil(service.pendingRequestGenerationForTesting(requestId: capturedRequestId))
    XCTAssertGreaterThan(service.connectionGenerationForTesting(), retiredGeneration)

    service.configureConnectedTransportForTesting()
    let replacementGeneration = service.connectionGenerationForTesting()
    service.firePendingRequestTimeoutForTesting(requestId: capturedRequestId)
    XCTAssertEqual(service.connectionGenerationForTesting(), replacementGeneration)
    XCTAssertEqual(service.connectionState, .connected)
    XCTAssertFalse(service.hasTransportProbeForTesting())

    do {
      _ = try await request.value
      XCTFail("Expected the retired request to fail with its old connection.")
    } catch {
      XCTAssertEqual(error.localizedDescription, "Test teardown.")
    }
  }

  @MainActor
  func testSuspendedWorkRefreshCancelsAfterProjectSwitchWithoutMutatingNewProject() async throws {
    let database = DatabaseService(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    try database.executeSqlForTesting("""
      insert into projects (id, root_path, display_name, default_base_ref, created_at, last_opened_at) values
      ('project-a', '/tmp/a', 'A', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'),
      ('project-b', '/tmp/b', 'B', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:01.000Z');
    """)
    let service = SyncService(database: database)
    service.setActiveProjectForTesting(projectId: "project-b", rootPath: "/tmp/b")
    let baselineLane = makeLane(id: "lane-b", name: "B baseline")
    let baselineSession = makeSession(id: "session-b", laneId: baselineLane.id, laneName: baselineLane.name)
    try database.replaceLaneSnapshots([baselineLane])
    try database.replaceTerminalSessions([baselineSession])

    service.setActiveProjectForTesting(projectId: "project-a", rootPath: "/tmp/a")
    service.configureConnectedTransportForTesting()
    service.beginOutboundEnvelopeCaptureForTesting()
    let previousWorkStatus = service.status(for: .work)
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
    }
    let refresh = Task { try await service.refreshWorkSessions() }
    var requestId: String?
    for _ in 0..<20 where requestId == nil {
      await Task.yield()
      requestId = service.capturedOutboundRequestIdsForTesting(type: "command").first
    }
    let capturedRequestId = try XCTUnwrap(requestId)
    service.setActiveProjectForTesting(projectId: "project-b", rootPath: "/tmp/b")
    service.completeCapturedRequestForTesting(requestId: capturedRequestId, result: [Any]())

    do {
      try await refresh.value
      XCTFail("Expected refresh to cancel after the active project switched.")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertEqual(service.status(for: .work), previousWorkStatus)
    XCTAssertNotEqual(service.status(for: .work).phase, .hydrating)
    XCTAssertEqual(database.fetchLanes(includeArchived: false).map(\.id), [baselineLane.id])
    XCTAssertEqual(database.fetchSessions().map(\.id), [baselineSession.id])
  }

  @MainActor
  func testMultipleSuspendedWorkRefreshesRestoreOriginalStatusAfterProjectSwitch() async throws {
    let database = DatabaseService(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    try database.executeSqlForTesting("""
      insert into projects (id, root_path, display_name, default_base_ref, created_at, last_opened_at) values
      ('project-a', '/tmp/a', 'A', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'),
      ('project-b', '/tmp/b', 'B', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:01.000Z');
    """)
    let service = SyncService(database: database)
    service.setActiveProjectForTesting(projectId: "project-a", rootPath: "/tmp/a")
    service.configureConnectedTransportForTesting()
    service.beginOutboundEnvelopeCaptureForTesting()
    let previousWorkStatus = service.status(for: .work)
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
    }

    let first = Task { try await service.refreshWorkSessions() }
    await Task.yield()
    let second = Task { try await service.refreshWorkSessions() }
    var requestIds: [String] = []
    for _ in 0..<40 where requestIds.count < 2 {
      await Task.yield()
      requestIds = service.capturedOutboundRequestIdsForTesting(type: "command")
    }
    guard requestIds.count == 2 else {
      return XCTFail("Expected two captured work refresh requests.")
    }
    service.setActiveProjectForTesting(projectId: "project-b", rootPath: "/tmp/b")
    requestIds.forEach { service.completeCapturedRequestForTesting(requestId: $0, result: [Any]()) }

    for refresh in [first, second] {
      do {
        try await refresh.value
        XCTFail("Expected the old-project refresh to cancel.")
      } catch {
        XCTAssertTrue(error is CancellationError)
      }
    }
    XCTAssertEqual(service.status(for: .work), previousWorkStatus)
    XCTAssertNotEqual(service.status(for: .work).phase, .hydrating)
  }

  @MainActor
  func testFailedOldProjectRefreshCancelsAndRestoresOriginalStatus() async throws {
    let database = DatabaseService(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    try database.executeSqlForTesting("""
      insert into projects (id, root_path, display_name, default_base_ref, created_at, last_opened_at) values
      ('project-a', '/tmp/a', 'A', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'),
      ('project-b', '/tmp/b', 'B', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:01.000Z');
    """)
    let service = SyncService(database: database)
    service.setActiveProjectForTesting(projectId: "project-a", rootPath: "/tmp/a")
    service.configureConnectedTransportForTesting()
    service.beginOutboundEnvelopeCaptureForTesting()
    let previousWorkStatus = service.status(for: .work)
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
    }

    let refresh = Task { try await service.refreshWorkSessions() }
    var requestId: String?
    for _ in 0..<20 where requestId == nil {
      await Task.yield()
      requestId = service.capturedOutboundRequestIdsForTesting(type: "command").first
    }
    service.setActiveProjectForTesting(projectId: "project-b", rootPath: "/tmp/b")
    service.failCapturedRequestForTesting(
      requestId: try XCTUnwrap(requestId),
      error: NSError(domain: "ADETests", code: 42, userInfo: nil)
    )

    do {
      try await refresh.value
      XCTFail("Expected the old-project refresh to cancel.")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertEqual(service.status(for: .work), previousWorkStatus)
    XCTAssertNotEqual(service.status(for: .work).phase, .hydrating)
  }

  @MainActor
  func testSuspendedPullRequestRefreshCancelsAfterProjectSwitchWithoutPruningNewProject() async throws {
    let database = DatabaseService(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    try database.executeSqlForTesting("""
      insert into projects (id, root_path, display_name, default_base_ref, created_at, last_opened_at) values
      ('project-a', '/tmp/a', 'A', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:00.000Z'),
      ('project-b', '/tmp/b', 'B', 'main', '2026-07-22T00:00:00.000Z', '2026-07-22T00:00:01.000Z');
    """)
    let service = SyncService(database: database)
    service.setActiveProjectForTesting(projectId: "project-b", rootPath: "/tmp/b")
    let baselineLane = makeLane(id: "lane-b", name: "B baseline")
    let baselinePullRequest = makePullRequest(id: "pr-b", laneId: baselineLane.id, projectId: "project-b")
    try database.replaceLaneSnapshots([baselineLane])
    try database.replacePullRequestHydration(makePullRequestPayload([baselinePullRequest]))

    service.setActiveProjectForTesting(projectId: "project-a", rootPath: "/tmp/a")
    try database.replaceLaneSnapshots([makeLane(id: "lane-a", name: "A baseline")])
    service.configureConnectedTransportForTesting()
    service.beginOutboundEnvelopeCaptureForTesting()
    let previousPrStatus = service.status(for: .prs)
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
    }

    let refresh = Task { try await service.refreshPullRequestSnapshots() }
    var requestId: String?
    for _ in 0..<20 where requestId == nil {
      await Task.yield()
      requestId = service.capturedOutboundRequestIdsForTesting(type: "command").first
    }
    service.setActiveProjectForTesting(projectId: "project-b", rootPath: "/tmp/b")
    let emptyRefresh: [String: Any] = [
      "refreshedCount": 0,
      "prs": [Any](),
      "snapshots": [Any](),
    ]
    service.completeCapturedRequestForTesting(
      requestId: try XCTUnwrap(requestId),
      result: emptyRefresh
    )

    do {
      try await refresh.value
      XCTFail("Expected the old-project PR refresh to cancel.")
    } catch {
      XCTAssertTrue(error is CancellationError)
    }
    XCTAssertEqual(service.status(for: .prs), previousPrStatus)
    XCTAssertNotEqual(service.status(for: .prs).phase, .hydrating)
    XCTAssertEqual(database.fetchPullRequests().map(\.id), [baselinePullRequest.id])
  }

  @MainActor
  func testRosterCacheIsIsolatedByLegacyHostPortWhenProjectIdentityMatches() {
    let database = DatabaseService(baseURL: makeTemporaryDirectory())
    let service = SyncService(database: database)
    service.clearSavedProfilesForTesting()
    let hostA = HostConnectionProfile(
      hostIdentity: nil, hostName: "Legacy Host", port: 8787,
      authKind: "paired", pairedDeviceId: "phone", lastRemoteDbVersion: 0,
      lastHostDeviceId: nil, lastSuccessfulAddress: "192.168.1.10",
      savedAddressCandidates: ["192.168.1.10"], discoveredLanAddresses: ["192.168.1.10"], tailscaleAddress: nil
    )
    let hostB = HostConnectionProfile(
      hostIdentity: nil, hostName: "Legacy Host", port: 8788,
      authKind: "paired", pairedDeviceId: "phone", lastRemoteDbVersion: 0,
      lastHostDeviceId: nil, lastSuccessfulAddress: "192.168.1.10",
      savedAddressCandidates: ["192.168.1.10"], discoveredLanAddresses: ["192.168.1.10"], tailscaleAddress: nil
    )
    var cacheKeys: [String] = []
    defer {
      cacheKeys.forEach(UserDefaults.standard.removeObject(forKey:))
      service.clearSavedProfilesForTesting()
      database.close()
    }

    service.installSavedProfileForTesting(hostA, token: "secret-a", makeActive: true)
    service.setActiveProjectForTesting(projectId: "shared-project", rootPath: "/tmp/shared-project")
    let roster = makeRoster(projectId: "shared-project", name: "Shared", lanes: [makeRosterLane(id: "lane-a", name: "A", branch: "main")], chats: [makeRosterChat(id: "chat-a", laneId: "lane-a")])
    service.applyRosterSnapshot(RemoteRosterSnapshotPayload(seq: 1, projects: [roster]))
    service.persistRosterForTesting()
    cacheKeys.append(service.rosterCacheKeyForTesting())
    XCTAssertTrue(service.rosterSupported)

    service.installSavedProfileForTesting(hostB, token: "secret-b", makeActive: true)
    service.setActiveProjectForTesting(projectId: "shared-project", rootPath: "/tmp/shared-project")
    cacheKeys.append(service.rosterCacheKeyForTesting())
    XCTAssertNotEqual(cacheKeys[0], cacheKeys[1])
    XCTAssertTrue(service.rosterProjects.isEmpty)
    XCTAssertFalse(service.rosterSupported)

    service.installSavedProfileForTesting(hostA, token: "secret-a", makeActive: true)
    // Cached rows render immediately, but protocol support is re-proven by the
    // next live snapshot rather than inherited across a reconnect.
    XCTAssertFalse(service.rosterSupported)
    XCTAssertEqual(service.rosterProjects, [roster])
  }

  func testActiveProjectRosterOverlayKeepsLocalRowsAndAppendsMissingRosterRowsInSourceOrder() {
    let localLane = makeLane(id: "lane-local", name: "Local lane")
    let localSession = makeSession(id: "local-chat", laneId: localLane.id, laneName: localLane.name)
    let roster = makeRoster(projectId: "project-1", name: "Project", lanes: [
      makeRosterLane(id: localLane.id, name: "Stale local", branch: "main"),
      makeRosterLane(id: "lane-roster-1", name: "Roster one", branch: "feature/one"),
      makeRosterLane(id: "lane-roster-2", name: "Roster two", branch: "feature/two"),
    ], chats: [
      makeRosterChat(id: localSession.id, laneId: localLane.id),
      makeRosterChat(id: "roster-chat-1", laneId: "lane-roster-2"),
      makeRosterChat(id: "roster-chat-2", laneId: "lane-roster-1"),
    ])
    let projection = overlayActiveProjectRoster(localSessions: [localSession], localLanes: [localLane], roster: roster)
    XCTAssertEqual(projection.lanes.map(\.id), ["lane-local", "lane-roster-1", "lane-roster-2"])
    XCTAssertEqual(projection.sessions.map(\.id), ["local-chat", "roster-chat-1", "roster-chat-2"])
  }

  func testRosterNavigationUsesChatIdentityBeforeHintsAndScopedRepositoryBeforeBranch() {
    let ade = makeProject(id: "ade", name: "ADE")
    let versic = makeProject(id: "versic", name: "Versic")
    let adeLane = makeRosterLane(id: "ade-main", name: "ADE main", branch: "main")
    let versicLane = makeRosterLane(id: "versic-lane", name: "Versic", branch: "main")
    let rosters = [
      makeRoster(projectId: ade.id, name: ade.displayName, lanes: [adeLane], chats: []),
      makeRoster(projectId: versic.id, name: versic.displayName, lanes: [versicLane], chats: [makeRosterChat(id: "foreign-chat", laneId: versicLane.id)]),
    ]
    let known = resolveRosterSessionNavigationTarget(projects: [ade, versic], rosterProjects: rosters, sessionId: "foreign-chat", laneId: adeLane.id, repoOwner: nil, repoName: nil, branch: adeLane.branchRef)
    XCTAssertEqual(known?.project.id, versic.id)
    XCTAssertEqual(known?.lane?.id, versicLane.id)
    let scoped = resolveRosterSessionNavigationTarget(projects: [ade, versic], rosterProjects: rosters, sessionId: "new-chat", laneId: nil, repoOwner: nil, repoName: versic.displayName, branch: "main")
    XCTAssertEqual(scoped?.project.id, versic.id)
    XCTAssertEqual(scoped?.lane?.id, versicLane.id)
  }

  func testRepositoryScopedNavigationRequiresMatchingVerifiedOwnerAndName() {
    let ownerA = makeProject(id: "owner-a-foo", name: "Foo", owner: "owner-a", repoName: "Foo")
    let ownerB = makeProject(id: "owner-b-foo", name: "Foo", owner: "owner-b", repoName: "Foo")
    let unverified = makeProject(id: "unknown-foo", name: "Foo")
    let laneA = makeRosterLane(id: "lane-a", name: "A", branch: "main")
    let laneB = makeRosterLane(id: "lane-b", name: "B", branch: "main")
    let rosters = [
      makeRoster(projectId: ownerA.id, name: ownerA.displayName, lanes: [laneA], chats: []),
      makeRoster(projectId: ownerB.id, name: ownerB.displayName, lanes: [laneB], chats: []),
      makeRoster(projectId: unverified.id, name: unverified.displayName, lanes: [], chats: []),
    ]

    let target = resolveRosterSessionNavigationTarget(
      projects: [ownerA, ownerB, unverified], rosterProjects: rosters,
      sessionId: "new-chat", laneId: nil, repoOwner: "OWNER-B", repoName: "foo", branch: "main"
    )
    XCTAssertEqual(target?.project.id, ownerB.id)
    XCTAssertEqual(target?.lane?.id, laneB.id)

    let unavailable = resolveRosterSessionNavigationTarget(
      projects: [ownerA, unverified], rosterProjects: rosters,
      sessionId: "new-chat", laneId: nil, repoOwner: "owner-b", repoName: "Foo", branch: "main"
    )
    XCTAssertNil(unavailable)

    let staleLane = makeRosterLane(id: "stale-owner-b-lane", name: "Stale B", branch: "main")
    let staleRoster = makeRoster(
      projectId: "stale-owner-b-project",
      name: "Foo",
      lanes: [staleLane],
      chats: [makeRosterChat(id: "stale-owner-b-chat", laneId: staleLane.id)]
    )
    let ownerScopedTarget = resolveRosterSessionNavigationTarget(
      projects: [ownerA], rosterProjects: [staleRoster],
      sessionId: "stale-owner-b-chat", laneId: staleLane.id,
      repoOwner: "owner-a", repoName: "Foo", branch: "main"
    )
    XCTAssertEqual(ownerScopedTarget?.project.id, ownerA.id)
    XCTAssertNil(ownerScopedTarget?.lane)
    XCTAssertNil(ownerScopedTarget?.chat.toolType)

    var hydratedOwnerA = ownerA
    hydratedOwnerA.repoOwner = nil
    hydratedOwnerA.repoName = nil
    let unresolvedCatalogKey = rosterNavigationCatalogRevisionKey([hydratedOwnerA])
    hydratedOwnerA.repoOwner = ownerA.repoOwner
    hydratedOwnerA.repoName = ownerA.repoName
    XCTAssertNotEqual(
      unresolvedCatalogKey,
      rosterNavigationCatalogRevisionKey([hydratedOwnerA])
    )
  }

  func testRepositoryScopeBeatsCoincidentallyMatchingActiveSessionId() {
    XCTAssertEqual(
      workSessionNavigationDestination(
        hasActiveSession: true,
        targetIsActiveProject: false,
        targetIsKnownChat: true,
        hasRepositoryScope: true
      ),
      .hub
    )
    XCTAssertEqual(
      workSessionNavigationDestination(
        hasActiveSession: true,
        targetIsActiveProject: nil,
        targetIsKnownChat: false,
        hasRepositoryScope: true
      ),
      .hub
    )
  }

  private func makeProject(id: String, name: String, owner: String? = nil, repoName: String? = nil) -> MobileProjectSummary {
    MobileProjectSummary(id: id, displayName: name, rootPath: "/tmp/\(id)", repoOwner: owner, repoName: repoName, laneCount: 1, isAvailable: true, isCached: true)
  }

  private func makeRoster(projectId: String, name: String, lanes: [RemoteRosterLane], chats: [RemoteRosterChat]) -> RemoteRosterProject {
    RemoteRosterProject(projectId: projectId, rootPath: "/tmp/\(name)", displayName: name, iconDataUrl: nil, lastOpenedAt: nil, booted: true, runningCount: 0, attentionCount: 0, lanes: lanes, chats: chats)
  }

  private func makeRosterLane(id: String, name: String, branch: String) -> RemoteRosterLane {
    RemoteRosterLane(id: id, name: name, color: nil, icon: nil, laneType: "worktree", branchRef: branch)
  }

  private func makeRosterChat(id: String, laneId: String) -> RemoteRosterChat {
    RemoteRosterChat(id: id, laneId: laneId, chatSessionId: nil, title: "Chat", provider: "codex", model: nil, toolType: "codex-chat", status: .idle, awaitingInput: nil, pinned: nil, archived: nil, lastActivityAt: nil, preview: nil)
  }

  private func makeLane(id: String, name: String) -> LaneSummary {
    LaneSummary(id: id, name: name, description: nil, laneType: "worktree", baseRef: "main", branchRef: "feature/\(id)", worktreePath: "/tmp/\(id)", attachedRootPath: nil, parentLaneId: nil, childCount: 0, stackDepth: 0, parentStatus: nil, isEditProtected: false, status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false), color: nil, icon: nil, tags: [], folder: nil, linearIssue: nil, linearIssueLinks: nil, createdAt: "", archivedAt: nil, devicesOpen: nil)
  }

  private func makeSession(id: String, laneId: String, laneName: String) -> TerminalSessionSummary {
    TerminalSessionSummary(id: id, laneId: laneId, laneName: laneName, ptyId: nil, tracked: true, pinned: false, manuallyNamed: nil, goal: nil, toolType: "codex-chat", title: "Chat", status: "running", startedAt: "2026-07-22T00:00:00.000Z", endedAt: nil, archivedAt: nil, exitCode: nil, transcriptPath: "", headShaStart: nil, headShaEnd: nil, lastOutputPreview: nil, summary: nil, runtimeState: "running", resumeCommand: nil, resumeMetadata: nil, chatIdleSinceAt: nil, chatSessionId: nil, pendingInputItemId: nil)
  }

  private func makeLaneDetail(
    lane: LaneSummary,
    signature: String? = nil
  ) -> LaneDetailPayload {
    LaneDetailPayload(
      lane: lane,
      runtime: LaneRuntimeSummary(
        bucket: "none",
        runningCount: 0,
        awaitingInputCount: 0,
        endedCount: 0,
        sessionCount: 0
      ),
      stackChain: [],
      children: [],
      stateSnapshot: nil,
      rebaseSuggestion: nil,
      autoRebaseStatus: nil,
      conflictStatus: nil,
      overlaps: [],
      syncStatus: nil,
      conflictState: nil,
      recentCommits: [],
      diffChanges: nil,
      stashes: [],
      envInitProgress: nil,
      sessions: [],
      chatSessions: [],
      signature: signature
    )
  }

  private func makePullRequest(id: String, laneId: String, projectId: String) -> PrSummary {
    PrSummary(
      id: id,
      laneId: laneId,
      projectId: projectId,
      repoOwner: "owner",
      repoName: "repo",
      githubPrNumber: 42,
      githubUrl: "https://github.com/owner/repo/pull/42",
      githubNodeId: nil,
      title: "Baseline PR",
      state: "open",
      baseBranch: "main",
      headBranch: "feature/test",
      checksStatus: "pending",
      reviewStatus: "requested",
      additions: 1,
      deletions: 0,
      lastSyncedAt: "2026-07-22T00:00:01.000Z",
      createdAt: "2026-07-22T00:00:00.000Z",
      updatedAt: "2026-07-22T00:00:01.000Z"
    )
  }

  private func makePullRequestPayload(_ pullRequests: [PrSummary]) -> PullRequestRefreshPayload {
    PullRequestRefreshPayload(
      refreshedCount: pullRequests.count,
      prs: pullRequests,
      snapshots: []
    )
  }

  private func makeTemporaryDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }
}
