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

  func testSyncReconnectStateUsesHeartbeatReconnectFloor() {
    var state = SyncReconnectState()

    XCTAssertEqual(state.nextDelayNanoseconds(forCloseCodeRawValue: 4001), 1_500_000_000)
    XCTAssertEqual(state.attempts, 1)
    XCTAssertEqual(state.nextDelayNanoseconds(), 2_000_000_000)
  }

  func testSyncRecognizesTailscaleIpv4Addresses() {
    XCTAssertTrue(syncIsTailscaleIPv4Address("100.117.237.95"))
    XCTAssertTrue(syncIsTailscaleIPv4Address("[100.64.0.1]"))
    XCTAssertFalse(syncIsTailscaleIPv4Address("192.168.68.102"))
    XCTAssertFalse(syncIsTailscaleIPv4Address("127.0.0.1"))
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

  @MainActor
  func testSyncServiceMigratesLegacyConnectionDraftProfile() throws {
    let legacyDraftKey = "ade.sync.connectionDraft"
    let profileKey = "ade.sync.hostProfile"
    UserDefaults.standard.removeObject(forKey: legacyDraftKey)
    UserDefaults.standard.removeObject(forKey: profileKey)
    defer {
      UserDefaults.standard.removeObject(forKey: legacyDraftKey)
      UserDefaults.standard.removeObject(forKey: profileKey)
    }

    let draft = ConnectionDraft(
      host: "192.168.1.10",
      port: 8787,
      authKind: "paired",
      pairedDeviceId: "phone-1",
      lastRemoteDbVersion: 42,
      lastBrainDeviceId: "host-1"
    )
    UserDefaults.standard.set(try JSONEncoder().encode(draft), forKey: legacyDraftKey)

    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let profile = try XCTUnwrap(service.loadProfile())

    XCTAssertEqual(profile.lastSuccessfulAddress, "192.168.1.10")
    XCTAssertEqual(profile.savedAddressCandidates, ["192.168.1.10"])
    XCTAssertEqual(profile.lastHostDeviceId, "host-1")
    XCTAssertNil(UserDefaults.standard.data(forKey: legacyDraftKey))
    XCTAssertNotNil(UserDefaults.standard.data(forKey: profileKey))
  }

  func testAgentChatEventEnvelopeDecodesRichEventPayloads() throws {
    let completionJSON = """
    {
      "sessionId": "session-1",
      "timestamp": "2026-03-17T00:00:00.000Z",
      "sequence": 12,
      "provenance": {
        "messageId": "msg-1",
        "threadId": "thread-1",
        "role": "agent",
        "laneId": "lane-1"
      },
      "event": {
        "type": "completion_report",
        "report": {
          "timestamp": "2026-03-17T00:00:00.000Z",
          "summary": "Work completed",
          "status": "completed",
          "artifacts": [
            {
              "type": "file",
              "description": "Updated the transcript",
              "reference": "docs/transcript.md"
            }
          ]
        }
      }
    }
    """

    let completionEnvelope = try JSONDecoder().decode(AgentChatEventEnvelope.self, from: Data(completionJSON.utf8))
    XCTAssertEqual(completionEnvelope.sessionId, "session-1")
    XCTAssertEqual(completionEnvelope.sequence, 12)
    XCTAssertEqual(completionEnvelope.provenance?.messageId, "msg-1")
    guard case .completionReport(let report, _) = completionEnvelope.event else {
      return XCTFail("Expected completion report event.")
    }
    XCTAssertEqual(report.summary, "Work completed")
    XCTAssertEqual(report.artifacts?.first?.reference, "docs/transcript.md")

    let noticeJSON = """
    {
      "sessionId": "session-2",
      "timestamp": "2026-03-17T00:01:00.000Z",
      "event": {
        "type": "system_notice",
        "noticeKind": "rate_limit",
        "message": "Slow down",
        "detail": {
          "summary": "Retry later",
          "metrics": [
            { "label": "Remaining", "value": "2" }
          ]
        }
      }
    }
    """

    let noticeEnvelope = try JSONDecoder().decode(AgentChatEventEnvelope.self, from: Data(noticeJSON.utf8))
    guard case .systemNotice(let noticeKind, let message, let detail, _, _) = noticeEnvelope.event else {
      return XCTFail("Expected system notice event.")
    }
    XCTAssertEqual(noticeKind, .rateLimit)
    XCTAssertEqual(message, "Slow down")
    guard case .object(let detailObject) = detail else {
      return XCTFail("Expected system notice detail object.")
    }
    XCTAssertEqual(detailObject["summary"], .string("Retry later"))

    let resolvedJSON = """
    {
      "sessionId": "session-3",
      "timestamp": "2026-03-17T00:02:00.000Z",
      "event": {
        "type": "pending_input_resolved",
        "itemId": "approval-1",
        "resolution": "accepted",
        "turnId": "turn-1"
      }
    }
    """

    let resolvedEnvelope = try JSONDecoder().decode(AgentChatEventEnvelope.self, from: Data(resolvedJSON.utf8))
    guard case .pendingInputResolved(let itemId, let resolution, let turnId) = resolvedEnvelope.event else {
      return XCTFail("Expected pending input resolution event.")
    }
    XCTAssertEqual(itemId, "approval-1")
    XCTAssertEqual(resolution, "accepted")
    XCTAssertEqual(turnId, "turn-1")
  }

  @MainActor
  func testChatSubscriptionStateSurvivesDisconnectAndReplaysPayloads() async throws {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))

    try await service.subscribeToChatEvents(sessionId: "session-1")
    try await service.subscribeToChatEvents(sessionId: "session-2")
    let subscriptionRevision = service.localStateRevision

    try await service.subscribeToChatEvents(sessionId: "session-1")
    XCTAssertEqual(service.localStateRevision, subscriptionRevision)

    XCTAssertEqual(service.subscribedChatSessionIds, Set(["session-1", "session-2"]))
    XCTAssertEqual(service.chatSubscriptionPayloads().compactMap { $0["sessionId"] as? String }.sorted(), ["session-1", "session-2"])

    service.disconnect(clearCredentials: false)

    XCTAssertEqual(service.subscribedChatSessionIds, Set(["session-1", "session-2"]))
    XCTAssertEqual(service.chatSubscriptionPayloads().compactMap { $0["sessionId"] as? String }.sorted(), ["session-1", "session-2"])

    try await service.unsubscribeFromChatEvents(sessionId: "session-1")
    XCTAssertEqual(service.subscribedChatSessionIds, Set(["session-2"]))

    let unsubscribedRevision = service.localStateRevision
    try await service.unsubscribeFromChatEvents(sessionId: "session-1")
    XCTAssertEqual(service.localStateRevision, unsubscribedRevision)
  }

  @MainActor
  func testChatEventHistoryStoresDecodedEnvelopes() async throws {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let globalRevision = service.localStateRevision
    let envelope = AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-03-17T00:00:00.000Z",
      event: .text(text: "Working...", messageId: "msg-1", turnId: "turn-1", itemId: "item-1"),
      sequence: 1,
      provenance: AgentChatEventProvenance(
        messageId: "msg-1",
        threadId: "thread-1",
        role: "agent",
        targetKind: nil,
        sourceSessionId: nil,
        attemptId: nil,
        stepKey: nil,
        laneId: "lane-1",
        runId: nil
      )
    )

    service.recordChatEventEnvelope(envelope)

    XCTAssertEqual(service.chatEventHistory(sessionId: "session-1"), [envelope])
    XCTAssertEqual(service.localStateRevision, globalRevision)
    XCTAssertEqual(service.chatEventRevision(for: "session-1"), 1)
  }

  func testChatCommandRequestPayloadsEncodeExpectedShapes() throws {
    let subscribe = try jsonDictionary(from: AgentChatSubscriptionRequest(sessionId: "session-1"))
    XCTAssertEqual(subscribe["sessionId"] as? String, "session-1")

    let interrupt = try jsonDictionary(from: AgentChatInterruptRequest(sessionId: "session-1"))
    XCTAssertEqual(interrupt["sessionId"] as? String, "session-1")

    let steer = try jsonDictionary(from: AgentChatSteerRequest(sessionId: "session-1", text: "Keep going"))
    XCTAssertEqual(steer["sessionId"] as? String, "session-1")
    XCTAssertEqual(steer["text"] as? String, "Keep going")

    let resume = try jsonDictionary(from: AgentChatResumeRequest(sessionId: "session-1"))
    XCTAssertEqual(resume["sessionId"] as? String, "session-1")

    let dispose = try jsonDictionary(from: AgentChatDisposeRequest(sessionId: "session-1"))
    XCTAssertEqual(dispose["sessionId"] as? String, "session-1")

    let approve = try jsonDictionary(from: AgentChatApproveRequest(
      sessionId: "session-1",
      itemId: "approval-1",
      decision: .acceptForSession,
      responseText: "Proceed"
    ))
    XCTAssertEqual(approve["sessionId"] as? String, "session-1")
    XCTAssertEqual(approve["itemId"] as? String, "approval-1")
    XCTAssertEqual(approve["decision"] as? String, "accept_for_session")
    XCTAssertEqual(approve["responseText"] as? String, "Proceed")

    let respond = try jsonDictionary(from: AgentChatRespondToInputRequest(
      sessionId: "session-1",
      itemId: "question-1",
      decision: .decline,
      answers: [
        "choice": .string("later"),
        "files": .strings(["Sources/App.swift", "Sources/WorkView.swift"])
      ],
      responseText: "Not yet"
    ))
    XCTAssertEqual(respond["decision"] as? String, "decline")
    let respondAnswers = respond["answers"] as? [String: Any]
    XCTAssertEqual(respondAnswers?["choice"] as? String, "later")
    XCTAssertEqual(respondAnswers?["files"] as? [String], ["Sources/App.swift", "Sources/WorkView.swift"])

    let update = try jsonDictionary(from: AgentChatUpdateSessionRequest(
      sessionId: "session-1",
      title: "Review run",
      modelId: "claude-sonnet-4",
      reasoningEffort: "high",
      permissionMode: "edit",
      interactionMode: "plan",
      claudePermissionMode: "default",
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
      unifiedPermissionMode: "edit",
      computerUse: .object(["enabled": .bool(true)])
    ))
    XCTAssertEqual(update["modelId"] as? String, "claude-sonnet-4")
    XCTAssertEqual(update["permissionMode"] as? String, "edit")
    let computerUse = update["computerUse"] as? [String: Any]
    XCTAssertEqual(computerUse?["enabled"] as? Bool, true)
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

  func testDatabaseFetchPullRequestListItemsCanFilterByLane() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

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
        'lane-a', 'project-1', 'Lane A', null, 'worktree', 'main', 'feature/a', '/tmp/project/a',
        null, 0, null, null, null, null, null,
        'active', '2026-03-17T00:00:00.000Z', null
      );
      insert into lanes (
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder,
        status, created_at, archived_at
      ) values (
        'lane-b', 'project-1', 'Lane B', null, 'worktree', 'main', 'feature/b', '/tmp/project/b',
        null, 0, null, null, null, null, null,
        'active', '2026-03-17T00:00:00.000Z', null
      );
      insert into pull_requests (
        id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
        title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
        last_synced_at, created_at, updated_at
      ) values (
        'pr-a', 'project-1', 'lane-a', 'ade', 'repo', 101, 'https://github.com/ade/repo/pull/101',
        null, 'Lane A PR', 'open', 'main', 'feature/a', 'success', 'approved', 10, 2,
        '2026-03-17T00:10:00.000Z', '2026-03-17T00:00:00.000Z', '2026-03-17T00:10:00.000Z'
      );
      insert into pull_requests (
        id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
        title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
        last_synced_at, created_at, updated_at
      ) values (
        'pr-b', 'project-1', 'lane-b', 'ade', 'repo', 102, 'https://github.com/ade/repo/pull/102',
        null, 'Lane B PR', 'open', 'main', 'feature/b', 'success', 'approved', 4, 1,
        '2026-03-17T00:11:00.000Z', '2026-03-17T00:00:00.000Z', '2026-03-17T00:11:00.000Z'
      );
    """)

    let allPullRequests = database.fetchPullRequestListItems()
    let laneAPullRequests = database.fetchPullRequestListItems(forLane: "lane-a")

    XCTAssertEqual(allPullRequests.map(\.id).sorted(), ["pr-a", "pr-b"])
    XCTAssertEqual(laneAPullRequests.map(\.id), ["pr-a"])
    XCTAssertEqual(laneAPullRequests.first?.laneName, "Lane A")

    database.close()
  }

  func testDatabaseScopesPullRequestReadsByActiveProject() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

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
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values
        ('project-1', '/tmp/project-one', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T01:00:00.000Z'),
        ('project-2', '/tmp/project-two', 'Project Two', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T02:00:00.000Z');
      insert into lanes (
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder,
        status, created_at, archived_at
      ) values
        ('lane-one', 'project-1', 'One', null, 'worktree', 'main', 'feature/one', '/tmp/project-one/.ade/worktrees/one',
         null, 0, null, null, null, null, null, 'active', '2026-04-22T00:10:00.000Z', null),
        ('lane-two', 'project-2', 'Two', null, 'worktree', 'main', 'feature/two', '/tmp/project-two/.ade/worktrees/two',
         null, 0, null, null, null, null, null, 'active', '2026-04-22T00:20:00.000Z', null);
      insert into pull_requests (
        id, project_id, lane_id, repo_owner, repo_name, github_pr_number, github_url, github_node_id,
        title, state, base_branch, head_branch, checks_status, review_status, additions, deletions,
        last_synced_at, created_at, updated_at
      ) values
        ('pr-one', 'project-1', 'lane-one', 'ade', 'repo', 101, 'https://github.com/ade/repo/pull/101',
         null, 'Project one PR', 'open', 'main', 'feature/one', 'success', 'approved', 10, 2,
         '2026-04-22T00:30:00.000Z', '2026-04-22T00:00:00.000Z', '2026-04-22T00:30:00.000Z'),
        ('pr-two', 'project-2', 'lane-two', 'ade', 'repo', 202, 'https://github.com/ade/repo/pull/202',
         null, 'Project two PR', 'open', 'main', 'feature/two', 'pending', 'requested', 4, 1,
         '2026-04-22T00:40:00.000Z', '2026-04-22T00:00:00.000Z', '2026-04-22T00:40:00.000Z');
      insert into pull_request_snapshots(pr_id, updated_at) values
        ('pr-one', '2026-04-22T00:30:00.000Z'),
        ('pr-two', '2026-04-22T00:40:00.000Z');
      insert into pr_groups(id, project_id, group_type, name, target_branch, created_at) values
        ('group-one', 'project-1', 'queue', 'Project one queue', 'main', '2026-04-22T00:30:00.000Z'),
        ('group-two', 'project-2', 'queue', 'Project two queue', 'main', '2026-04-22T00:40:00.000Z');
      insert into pr_group_members(id, group_id, pr_id, lane_id, position, role) values
        ('member-one', 'group-one', 'pr-one', 'lane-one', 0, 'source'),
        ('member-two', 'group-two', 'pr-two', 'lane-two', 0, 'source');
      insert into integration_proposals(
        id, project_id, source_lane_ids_json, base_branch, steps_json, pairwise_results_json,
        lane_summaries_json, overall_outcome, created_at, status, linked_group_id, linked_pr_id
      ) values
        ('proposal-one', 'project-1', '["lane-one"]', 'main', '[]', '[]', '[]', 'pending',
         '2026-04-22T00:30:00.000Z', 'proposed', 'group-one', 'pr-one'),
        ('proposal-two', 'project-2', '["lane-two"]', 'main', '[]', '[]', '[]', 'pending',
         '2026-04-22T00:40:00.000Z', 'proposed', 'group-two', 'pr-two');
    """)

    database.setActiveProjectId("project-1")
    XCTAssertEqual(database.fetchPullRequests().map(\.id), ["pr-one"])
    XCTAssertEqual(database.fetchPullRequestListItems().map(\.id), ["pr-one"])
    XCTAssertEqual(database.fetchPullRequestListItems(forLane: "lane-one").map(\.id), ["pr-one"])
    XCTAssertEqual(database.fetchPullRequestGroupMembers(groupId: "group-one").map(\.prId), ["pr-one"])
    XCTAssertNotNil(database.fetchPullRequestSnapshot(prId: "pr-one"))
    XCTAssertNil(database.fetchPullRequestSnapshot(prId: "pr-two"))
    XCTAssertEqual(database.fetchIntegrationProposals().map(\.proposalId), ["proposal-one"])

    database.setActiveProjectId("project-2")
    XCTAssertEqual(database.fetchPullRequests().map(\.id), ["pr-two"])
    XCTAssertEqual(database.fetchPullRequestListItems().map(\.id), ["pr-two"])
    XCTAssertEqual(database.fetchPullRequestListItems(forLane: "lane-two").map(\.id), ["pr-two"])
    XCTAssertEqual(database.fetchPullRequestGroupMembers(groupId: "group-two").map(\.prId), ["pr-two"])
    XCTAssertEqual(database.fetchPullRequestGroupMembers(groupId: "group-one").map(\.prId), [])
    XCTAssertNil(database.fetchPullRequestSnapshot(prId: "pr-one"))
    XCTAssertNotNil(database.fetchPullRequestSnapshot(prId: "pr-two"))
    XCTAssertEqual(database.fetchIntegrationProposals().map(\.proposalId), ["proposal-two"])

    database.close()
  }

  func testDatabaseListsMobileProjectsAndScopesCachedRuntimeByActiveProject() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values
        ('project-1', '/tmp/project-one', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T01:00:00.000Z'),
        ('project-2', '/tmp/project-two', 'Project Two', 'develop', '2026-04-22T00:00:00.000Z', '2026-04-22T02:00:00.000Z');
      insert into lanes (
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder,
        status, created_at, archived_at
      ) values
        ('lane-one', 'project-1', 'One', null, 'worktree', 'main', 'feature/one', '/tmp/project-one/.ade/worktrees/one',
         null, 0, null, null, null, null, null, 'active', '2026-04-22T00:10:00.000Z', null),
        ('lane-two', 'project-2', 'Two', null, 'worktree', 'develop', 'feature/two', '/tmp/project-two/.ade/worktrees/two',
         null, 0, null, null, null, null, null, 'active', '2026-04-22T00:20:00.000Z', null);
      create table if not exists files_workspaces (
        id text primary key,
        kind text not null,
        lane_id text,
        name text not null,
        root_path text not null,
        is_read_only_by_default integer not null default 1,
        mobile_read_only integer not null default 1,
        updated_at text not null
      );
    """)

    let projects = database.listMobileProjects()
    XCTAssertEqual(projects.map(\.id), ["project-2", "project-1"])
    XCTAssertEqual(projects.first(where: { $0.id == "project-1" })?.laneCount, 1)
    XCTAssertEqual(projects.first(where: { $0.id == "project-2" })?.defaultBaseRef, "develop")
    XCTAssertTrue(projects.allSatisfy(\.isCached))

    database.setActiveProjectId("project-1")
    try database.replaceTerminalSessions([
      makeTerminalSessionSummary(
        id: "session-one",
        laneId: "lane-one",
        laneName: "One",
        toolType: "codex-chat",
        title: "Project one chat"
      ),
    ])
    try database.replaceFilesWorkspaces([
      FilesWorkspace(
        id: "workspace-one",
        kind: "worktree",
        laneId: "lane-one",
        name: "One",
        rootPath: "/tmp/project-one/.ade/worktrees/one",
        isReadOnlyByDefault: false,
        mobileReadOnly: true
      ),
    ])

    database.setActiveProjectId("project-2")
    try database.replaceTerminalSessions([
      makeTerminalSessionSummary(
        id: "session-two",
        laneId: "lane-two",
        laneName: "Two",
        toolType: "claude-chat",
        title: "Project two chat"
      ),
    ])
    try database.replaceFilesWorkspaces([
      FilesWorkspace(
        id: "workspace-two",
        kind: "worktree",
        laneId: "lane-two",
        name: "Two",
        rootPath: "/tmp/project-two/.ade/worktrees/two",
        isReadOnlyByDefault: false,
        mobileReadOnly: true
      ),
    ])

    XCTAssertEqual(database.fetchLanes(includeArchived: true).map(\.id), ["lane-two"])
    XCTAssertEqual(database.fetchSessions().map(\.id), ["session-two"])
    XCTAssertEqual(database.listWorkspaces().map(\.id), ["workspace-two"])

    database.setActiveProjectId("project-1")
    XCTAssertEqual(database.fetchLanes(includeArchived: true).map(\.id), ["lane-one"])
    XCTAssertEqual(database.fetchSessions().map(\.id), ["session-one"])
    XCTAssertEqual(database.listWorkspaces().map(\.id), ["workspace-one"])

    database.close()
  }

  @MainActor
  func testSyncServiceProjectHomeUsesCachedProjectsAndLocalSelection() throws {
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
    UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    defer {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    }

    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)
    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values
        ('project-1', '/tmp/project-one', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T01:00:00.000Z'),
        ('project-2', '/tmp/project-two/', 'Project Two', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T02:00:00.000Z');
    """)

    let service = SyncService(database: database)
    XCTAssertTrue(service.shouldShowProjectHome)
    XCTAssertEqual(service.projects.map(\.id), ["project-2", "project-1"])

    let projectTwo = try XCTUnwrap(service.projects.first(where: { $0.id == "project-2" }))
    service.selectProject(projectTwo)

    XCTAssertEqual(service.activeProjectId, "project-2")
    XCTAssertEqual(service.activeProjectRootPath, "/tmp/project-two")
    XCTAssertEqual(database.currentProjectId(), "project-2")
    XCTAssertFalse(service.shouldShowProjectHome)
    XCTAssertTrue(service.isActiveProject(projectTwo))

    service.showProjectHome()
    XCTAssertTrue(service.shouldShowProjectHome)
    service.closeProjectHome()
    XCTAssertFalse(service.shouldShowProjectHome)

    database.close()
  }

  @MainActor
  func testSyncServiceRejectsUncachedProjectSelectionWithoutCatalogSwitch() throws {
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
    UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    defer {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    }

    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)
    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values
        ('project-1', '/tmp/project-one', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T01:00:00.000Z');
    """)

    let service = SyncService(database: database)
    let projectOne = try XCTUnwrap(service.projects.first(where: { $0.id == "project-1" }))
    service.selectProject(projectOne)
    service.showProjectHome()

    let uncachedProject = MobileProjectSummary(
      id: "project-2",
      displayName: "Project Two",
      rootPath: "/tmp/project-two",
      defaultBaseRef: "main",
      lastOpenedAt: "2026-04-22T02:00:00.000Z",
      laneCount: 0,
      isAvailable: true,
      isCached: false
    )
    service.selectProject(uncachedProject)

    XCTAssertEqual(service.activeProjectId, "project-1")
    XCTAssertEqual(database.currentProjectId(), "project-1")
    XCTAssertTrue(service.shouldShowProjectHome)
    XCTAssertEqual(
      service.lastError,
      "That project has not been cached on this phone yet. Connect to the ADE desktop app before opening it."
    )

    database.close()
  }

  @MainActor
  func testSyncServiceClearsRemoteProjectCatalogWhenHelloOmitsCatalog() throws {
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
    UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    defer {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    }

    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    service.seedRemoteProjectCatalogForTesting([
      MobileProjectSummary(
        id: "remote-only",
        displayName: "Remote Only",
        rootPath: "/tmp/remote-only",
        defaultBaseRef: "main",
        lastOpenedAt: "2026-04-22T02:00:00.000Z",
        laneCount: 1,
        isAvailable: true,
        isCached: false
      ),
    ])
    XCTAssertEqual(service.projects.map(\.id), ["remote-only"])

    try service.applyHelloPayloadForTesting([
      "brain": [
        "deviceId": "host-1",
        "deviceName": "Mac Studio",
      ],
      "features": [
        "projectCatalog": false,
      ],
    ])

    XCTAssertFalse(service.projects.contains { $0.id == "remote-only" })
  }

  @MainActor
  func testSyncServiceRejectsMismatchedHelloBeforeApplyingProjectCatalog() throws {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    service.seedRemoteProjectCatalogForTesting([
      MobileProjectSummary(
        id: "old-host-project",
        displayName: "Old Host",
        rootPath: "/tmp/old-host",
        defaultBaseRef: "main",
        lastOpenedAt: "2026-04-22T01:00:00.000Z",
        laneCount: 1,
        isAvailable: true,
        isCached: false
      ),
    ])
    XCTAssertThrowsError(
      try service.applyHelloPayloadForTesting(
        [
          "brain": [
            "deviceId": "host-b",
            "deviceName": "Other Mac",
          ],
          "features": [
            "projectCatalog": true,
          ],
          "projects": [[
            "id": "wrong-host-project",
            "displayName": "Wrong Host",
            "rootPath": "/tmp/wrong-host",
            "defaultBaseRef": "main",
            "lastOpenedAt": "2026-04-22T02:00:00.000Z",
            "laneCount": 1,
            "isAvailable": true,
            "isCached": false,
          ]],
        ],
        expectedHostIdentity: "host-a"
      )
    )
    XCTAssertFalse(service.projects.contains { $0.id == "wrong-host-project" })
    XCTAssertFalse(service.projects.contains { $0.id == "old-host-project" })
  }

  @MainActor
  func testSyncServicePrefersRemoteCatalogProjectOverStaleCachedSelection() throws {
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    UserDefaults.standard.set("old-project", forKey: activeProjectIdKey)
    UserDefaults.standard.set("/tmp/old-project", forKey: activeProjectRootPathKey)
    defer {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    }

    let database = makeControllerHydrationDatabase(baseURL: makeTemporaryDirectory())
    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values
        ('old-project', '/tmp/old-project', 'Old Project', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T01:00:00.000Z');
    """)
    let service = SyncService(database: database)
    XCTAssertEqual(service.activeProjectId, "old-project")

    try service.applyHelloPayloadForTesting([
      "brain": [
        "deviceId": "host-new",
        "deviceName": "New Mac",
      ],
      "features": [
        "projectCatalog": true,
      ],
      "projects": [[
        "id": "new-project",
        "displayName": "New Project",
        "rootPath": "/tmp/new-project",
        "defaultBaseRef": "main",
        "lastOpenedAt": "2026-04-22T02:00:00.000Z",
        "laneCount": 2,
        "isAvailable": true,
        "isCached": false,
      ]],
    ])

    XCTAssertEqual(service.activeProjectId, "new-project")
    XCTAssertEqual(service.activeProjectRootPath, "/tmp/new-project")
    XCTAssertEqual(database.currentProjectId(), "new-project")

    database.close()
  }

  @MainActor
  func testSyncPairingQrPayloadRoundTripFromDesktopLink() throws {
    let payload = """
    {"version":2,"hostIdentity":{"deviceId":"host-1","siteId":"site-1","name":"Mac Studio","platform":"macOS","deviceType":"desktop"},"port":8787,"addressCandidates":[{"host":"192.168.1.8","kind":"lan"},{"host":"100.101.102.103","kind":"tailscale"}]}
    """
    let url = "ade-sync://pair?payload=\(payload.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? payload)"

    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let decoded = try service.decodePairingQrPayload(from: url)

    XCTAssertEqual(decoded.hostIdentity.deviceId, "host-1")
    XCTAssertEqual(decoded.hostIdentity.name, "Mac Studio")
    XCTAssertEqual(decoded.version, 2)
    XCTAssertEqual(decoded.addressCandidates.map(\.host), ["192.168.1.8", "100.101.102.103"])
  }

  @MainActor
  func testSyncPairingQrPayloadRejectsUnsupportedVersion() throws {
    let payload = """
    {"version":3,"hostIdentity":{"deviceId":"host-1","siteId":"site-1","name":"Mac Studio","platform":"macOS","deviceType":"desktop"},"port":8787,"addressCandidates":[{"host":"192.168.1.8","kind":"lan"}]}
    """
    let url = "ade-sync://pair?payload=\(payload.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? payload)"

    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    XCTAssertThrowsError(try service.decodePairingQrPayload(from: url))
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

  func testDatabaseSuspendsForeignKeysWhileApplyingRemoteChanges() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeProjectLaneForeignKeyDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    let siteId = "b00e9b92c864a27958669c1595fcb2c3"
    let projectId = "project-1"
    let laneId = "lane-1"
    let changes: [CrsqlChangeRow] = [
      CrsqlChangeRow(table: "lanes", pk: .string(laneId), cid: "project_id", val: .string(projectId), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 0),
      CrsqlChangeRow(table: "lanes", pk: .string(laneId), cid: "name", val: .string("Primary"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 1),
      CrsqlChangeRow(table: "lanes", pk: .string(laneId), cid: "lane_type", val: .string("primary"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 2),
      CrsqlChangeRow(table: "lanes", pk: .string(laneId), cid: "base_ref", val: .string("main"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 3),
      CrsqlChangeRow(table: "lanes", pk: .string(laneId), cid: "branch_ref", val: .string("main"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 4),
      CrsqlChangeRow(table: "lanes", pk: .string(laneId), cid: "worktree_path", val: .string("/tmp/project"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 5),
      CrsqlChangeRow(table: "lanes", pk: .string(laneId), cid: "status", val: .string("active"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 6),
      CrsqlChangeRow(table: "lanes", pk: .string(laneId), cid: "created_at", val: .string("2026-03-15T00:00:00.000Z"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 7),
      CrsqlChangeRow(table: "projects", pk: .string(projectId), cid: "root_path", val: .string("/tmp/project"), colVersion: 1, dbVersion: 3, siteId: siteId, cl: 1, seq: 8),
      CrsqlChangeRow(table: "projects", pk: .string(projectId), cid: "display_name", val: .string("ADE"), colVersion: 1, dbVersion: 3, siteId: siteId, cl: 1, seq: 9),
      CrsqlChangeRow(table: "projects", pk: .string(projectId), cid: "default_base_ref", val: .string("main"), colVersion: 1, dbVersion: 3, siteId: siteId, cl: 1, seq: 10),
      CrsqlChangeRow(table: "projects", pk: .string(projectId), cid: "created_at", val: .string("2026-03-15T00:00:00.000Z"), colVersion: 1, dbVersion: 3, siteId: siteId, cl: 1, seq: 11),
      CrsqlChangeRow(table: "projects", pk: .string(projectId), cid: "last_opened_at", val: .string("2026-03-15T00:00:00.000Z"), colVersion: 1, dbVersion: 3, siteId: siteId, cl: 1, seq: 12),
    ]

    let result = try database.applyChanges(changes)

    XCTAssertEqual(result.appliedCount, changes.count)
    XCTAssertEqual(try countRows(in: baseURL, table: "projects"), 1)
    XCTAssertEqual(try countRows(in: baseURL, table: "lanes"), 1)
    database.close()
  }

  func testDatabaseDefersRemoteSessionInsertUntilRequiredColumnsArrive() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeTerminalSessionSyncDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values (
        'project-1', '/tmp/project', 'ADE', 'main', '2026-04-20T00:00:00.000Z', '2026-04-20T00:00:00.000Z'
      );
      insert into lanes (
        id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, status, created_at
      ) values (
        'lane-1', 'project-1', 'Primary', 'primary', 'main', 'main', '/tmp/project', 'active', '2026-04-20T00:00:00.000Z'
      );
    """)

    let siteId = "b00e9b92c864a27958669c1595fcb2c3"
    let sessionPk = packedDesktopTextPrimaryKey("session-1")
    let firstBatch: [CrsqlChangeRow] = [
      CrsqlChangeRow(table: "terminal_sessions", pk: sessionPk, cid: "title", val: .string("Mobile sync test"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 0),
      CrsqlChangeRow(table: "terminal_sessions", pk: sessionPk, cid: "tool_type", val: .string("codex-chat"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 1),
      CrsqlChangeRow(table: "terminal_sessions", pk: sessionPk, cid: "started_at", val: .string("2026-04-20T00:01:00.000Z"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 2),
      CrsqlChangeRow(table: "terminal_sessions", pk: sessionPk, cid: "transcript_path", val: .string(""), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 3),
      CrsqlChangeRow(table: "terminal_sessions", pk: sessionPk, cid: "status", val: .string("running"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 4),
    ]
    let secondBatch = [
      CrsqlChangeRow(table: "terminal_sessions", pk: sessionPk, cid: "lane_id", val: .string("lane-1"), colVersion: 1, dbVersion: 3, siteId: siteId, cl: 1, seq: 0),
    ]

    XCTAssertNoThrow(try database.applyChanges(firstBatch))
    XCTAssertEqual(try countRows(in: baseURL, table: "terminal_sessions"), 0)

    XCTAssertNoThrow(try database.applyChanges(secondBatch))
    let sessions = database.fetchSessions()
    XCTAssertEqual(sessions.count, 1)
    XCTAssertEqual(sessions.first?.id, "session-1")
    XCTAssertEqual(sessions.first?.laneId, "lane-1")
    XCTAssertEqual(sessions.first?.title, "Mobile sync test")
    database.close()
  }

  func testDatabaseRecreatesDeferredRowAfterStoredDeleteMarker() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeTerminalSessionSyncDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values (
        'project-1', '/tmp/project', 'ADE', 'main', '2026-04-20T00:00:00.000Z', '2026-04-20T00:00:00.000Z'
      );
      insert into lanes (
        id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, status, created_at
      ) values (
        'lane-1', 'project-1', 'Primary', 'primary', 'main', 'main', '/tmp/project', 'active', '2026-04-20T00:00:00.000Z'
      );
    """)

    let siteId = "b00e9b92c864a27958669c1595fcb2c3"
    let sessionPk = packedDesktopTextPrimaryKey("session-recreated")
    let staleDelete = CrsqlChangeRow(
      table: "terminal_sessions",
      pk: sessionPk,
      cid: "-1",
      val: .null,
      colVersion: 2,
      dbVersion: 2,
      siteId: siteId,
      cl: 1,
      seq: 0
    )
    let recreate: [CrsqlChangeRow] = [
      CrsqlChangeRow(table: "terminal_sessions", pk: sessionPk, cid: "title", val: .string("Recreated"), colVersion: 3, dbVersion: 3, siteId: siteId, cl: 1, seq: 0),
      CrsqlChangeRow(table: "terminal_sessions", pk: sessionPk, cid: "started_at", val: .string("2026-04-20T00:01:00.000Z"), colVersion: 3, dbVersion: 3, siteId: siteId, cl: 1, seq: 1),
      CrsqlChangeRow(table: "terminal_sessions", pk: sessionPk, cid: "transcript_path", val: .string(""), colVersion: 3, dbVersion: 3, siteId: siteId, cl: 1, seq: 2),
      CrsqlChangeRow(table: "terminal_sessions", pk: sessionPk, cid: "status", val: .string("running"), colVersion: 3, dbVersion: 3, siteId: siteId, cl: 1, seq: 3),
      CrsqlChangeRow(table: "terminal_sessions", pk: sessionPk, cid: "lane_id", val: .string("lane-1"), colVersion: 3, dbVersion: 3, siteId: siteId, cl: 1, seq: 4),
    ]

    XCTAssertNoThrow(try database.applyChanges([staleDelete]))
    XCTAssertEqual(try countRows(in: baseURL, table: "terminal_sessions"), 0)
    XCTAssertNoThrow(try database.applyChanges(recreate))

    let sessions = database.fetchSessions()
    XCTAssertEqual(sessions.count, 1)
    XCTAssertEqual(sessions.first?.id, "session-recreated")
    XCTAssertEqual(sessions.first?.title, "Recreated")
    database.close()
  }

  func testReplaceTerminalSessionsDoesNotBreakCheckpointSessionReferences() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeTerminalSessionSyncDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values (
        'project-1', '/tmp/project', 'ADE', 'main', '2026-04-20T00:00:00.000Z', '2026-04-20T00:00:00.000Z'
      );
      insert into lanes (
        id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, status, created_at
      ) values (
        'lane-1', 'project-1', 'Primary', 'primary', 'main', 'main', '/tmp/project', 'active', '2026-04-20T00:00:00.000Z'
      );
      create table if not exists checkpoints (
        id text primary key,
        project_id text not null,
        lane_id text not null,
        session_id text,
        sha text not null,
        created_at text not null,
        foreign key(project_id) references projects(id),
        foreign key(lane_id) references lanes(id),
        foreign key(session_id) references terminal_sessions(id)
      );
    """)

    let session = makeTerminalSessionSummary(
      id: "session-with-checkpoint",
      laneId: "lane-1",
      laneName: "Primary",
      toolType: "codex-chat",
      title: "Before refresh"
    )
    try database.replaceTerminalSessions([session])
    try database.executeSqlForTesting("""
      insert into checkpoints (
        id, project_id, lane_id, session_id, sha, created_at
      ) values (
        'checkpoint-1', 'project-1', 'lane-1', 'session-with-checkpoint', 'abc123', '2026-04-20T00:01:00.000Z'
      );
    """)

    let updatedSession = makeTerminalSessionSummary(
      id: "session-with-checkpoint",
      laneId: "lane-1",
      laneName: "Primary",
      toolType: "codex-chat",
      title: "After refresh"
    )

    XCTAssertNoThrow(try database.replaceTerminalSessions([updatedSession]))
    XCTAssertEqual(database.fetchSessions().first?.title, "After refresh")
    XCTAssertEqual(try countRows(in: baseURL, table: "checkpoints"), 1)
    XCTAssertEqual(try countRows(in: baseURL, table: "terminal_sessions"), 1)
    database.close()
  }

  func testReplaceTerminalSessionsDetachesCheckpointsBeforeDeletingStaleSessions() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeTerminalSessionSyncDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values (
        'project-1', '/tmp/project', 'ADE', 'main', '2026-04-20T00:00:00.000Z', '2026-04-20T00:00:00.000Z'
      );
      insert into lanes (
        id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, status, created_at
      ) values (
        'lane-1', 'project-1', 'Primary', 'primary', 'main', 'main', '/tmp/project', 'active', '2026-04-20T00:00:00.000Z'
      );
      create table if not exists checkpoints (
        id text primary key,
        project_id text not null,
        lane_id text not null,
        session_id text,
        sha text not null,
        created_at text not null,
        foreign key(project_id) references projects(id),
        foreign key(lane_id) references lanes(id),
        foreign key(session_id) references terminal_sessions(id)
      );
    """)

    let staleSession = makeTerminalSessionSummary(
      id: "stale-session",
      laneId: "lane-1",
      laneName: "Primary",
      toolType: "codex-chat",
      title: "Stale"
    )
    let keptSession = makeTerminalSessionSummary(
      id: "kept-session",
      laneId: "lane-1",
      laneName: "Primary",
      toolType: "codex-chat",
      title: "Kept"
    )
    try database.replaceTerminalSessions([staleSession, keptSession])
    try database.executeSqlForTesting("""
      insert into checkpoints (
        id, project_id, lane_id, session_id, sha, created_at
      ) values (
        'checkpoint-1', 'project-1', 'lane-1', 'stale-session', 'abc123', '2026-04-20T00:01:00.000Z'
      );
    """)

    XCTAssertNoThrow(try database.replaceTerminalSessions([keptSession]))
    XCTAssertEqual(try countRows(in: baseURL, table: "terminal_sessions"), 1)
    XCTAssertEqual(try countRows(in: baseURL, table: "checkpoints"), 1)
    XCTAssertEqual(try countRows(in: baseURL, table: "checkpoints where session_id is null"), 1)
    database.close()
  }

  func testReplaceTerminalSessionsSkipsSessionsForMissingLanes() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeTerminalSessionSyncDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values (
        'project-1', '/tmp/project', 'ADE', 'main', '2026-04-20T00:00:00.000Z', '2026-04-20T00:00:00.000Z'
      );
      insert into lanes (
        id, project_id, name, lane_type, base_ref, branch_ref, worktree_path, status, created_at
      ) values (
        'lane-1', 'project-1', 'Primary', 'primary', 'main', 'main', '/tmp/project', 'active', '2026-04-20T00:00:00.000Z'
      );
    """)

    let validSession = makeTerminalSessionSummary(
      id: "valid-session",
      laneId: "lane-1",
      laneName: "Primary",
      toolType: "codex-chat",
      title: "Valid"
    )
    let missingLaneSession = makeTerminalSessionSummary(
      id: "missing-lane-session",
      laneId: "missing-lane",
      laneName: "Missing",
      toolType: "codex-chat",
      title: "Missing lane"
    )

    XCTAssertNoThrow(try database.replaceTerminalSessions([validSession, missingLaneSession]))
    let sessions = database.fetchSessions()
    XCTAssertEqual(sessions.map(\.id), ["valid-session"])
    XCTAssertEqual(try countRows(in: baseURL, table: "terminal_sessions"), 1)
    database.close()
  }

  func testDatabaseIgnoresHydrationOwnedLaneStateSnapshotChanges() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeLaneHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    let laneSnapshotChanges = [
      CrsqlChangeRow(
        table: "lane_state_snapshots",
        pk: packedDesktopTextPrimaryKey("lane-primary"),
        cid: "dirty",
        val: .number(1),
        colVersion: 1,
        dbVersion: 2,
        siteId: "b00e9b92c864a27958669c1595fcb2c3",
        cl: 1,
        seq: 0
      ),
      CrsqlChangeRow(
        table: "lane_state_snapshots",
        pk: packedDesktopTextPrimaryKey("lane-primary"),
        cid: "ahead",
        val: .number(3),
        colVersion: 1,
        dbVersion: 2,
        siteId: "b00e9b92c864a27958669c1595fcb2c3",
        cl: 1,
        seq: 1
      ),
    ]

    let result = try database.applyChanges(laneSnapshotChanges)

    XCTAssertEqual(result.appliedCount, 0)
    XCTAssertEqual(try countRows(in: baseURL, table: "lane_state_snapshots"), 0)
    database.close()
  }

  func testHydrationOwnedSnapshotTablesDoNotRegisterCrrMetadata() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    XCTAssertTrue(try tableExists(in: baseURL, table: "lanes__crsql_clock"))
    XCTAssertFalse(try tableExists(in: baseURL, table: "lane_state_snapshots__crsql_clock"))
    XCTAssertFalse(try tableExists(in: baseURL, table: "pull_request_snapshots__crsql_clock"))
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

  func testDatabaseTreatsLegacyDeleteSentinelAsRowDelete() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeConflictPredictionsDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try database.executeSqlForTesting("""
      insert into conflict_predictions (
        id, project_id, lane_a_id, lane_b_id, status, predicted_at
      ) values (
        'prediction-legacy', 'project-1', 'lane-a', null, 'clean', '2026-03-17T00:00:00.000Z'
      )
    """)

    let deleteChange = CrsqlChangeRow(
      table: "conflict_predictions",
      pk: .bytes(SyncScalarBytes(type: "bytes", base64: packedDesktopTextPrimaryKeyData("prediction-legacy").base64EncodedString())),
      cid: "__ade_deleted",
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

  func testDatabaseReplaceLaneSnapshotsCanRefreshWithCachedWorkSessions() throws {
    let baseURL = makeTemporaryDirectory()
    let database = DatabaseService(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    let initialLane = LaneSummary(
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
    )

    try database.replaceLaneSnapshots([initialLane])
    try database.replaceTerminalSessions([
      TerminalSessionSummary(
        id: "session-1",
        laneId: "lane-primary",
        laneName: "Primary",
        ptyId: nil,
        tracked: true,
        pinned: false,
        goal: "Keep Work cache",
        toolType: "claude-chat",
        title: "Cached chat",
        status: "running",
        startedAt: "2026-03-17T00:10:00.000Z",
        endedAt: nil,
        exitCode: nil,
        transcriptPath: "/tmp/session-1.log",
        headShaStart: nil,
        headShaEnd: nil,
        lastOutputPreview: "Still visible",
        summary: nil,
        runtimeState: "running"
      ),
    ])

    let refreshedLane = LaneSummary(
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
      status: LaneStatus(dirty: true, ahead: 2, behind: 0, remoteBehind: 0, rebaseInProgress: false),
      color: nil,
      icon: nil,
      tags: [],
      folder: nil,
      createdAt: "2026-03-17T00:00:00.000Z",
      archivedAt: nil
    )

    try database.replaceLaneSnapshots([refreshedLane])

    XCTAssertEqual(database.fetchSessions().map(\.id), ["session-1"])
    XCTAssertEqual(database.fetchLanes(includeArchived: true).first?.status.ahead, 2)
    database.close()
  }

  func testDatabaseReplaceLaneSnapshotsArchivesMissingLanesWithCachedWorkSessions() throws {
    let baseURL = makeTemporaryDirectory()
    let database = DatabaseService(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    let primaryLane = makeLaneListSnapshot(
      id: "lane-primary",
      name: "Primary",
      laneType: "primary",
      baseRef: "main",
      branchRef: "main",
      worktreePath: "/tmp/project",
      description: nil,
      status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
      runtime: LaneRuntimeSummary(bucket: "none", runningCount: 0, awaitingInputCount: 0, endedCount: 0, sessionCount: 0),
      createdAt: "2026-03-17T00:00:00.000Z",
      archivedAt: nil
    ).lane
    let staleLane = makeLaneListSnapshot(
      id: "lane-stale",
      name: "Deleted lane",
      laneType: "worktree",
      baseRef: "main",
      branchRef: "ade/deleted-lane",
      worktreePath: "/tmp/project/.ade/worktrees/deleted-lane",
      description: nil,
      status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
      runtime: LaneRuntimeSummary(bucket: "running", runningCount: 1, awaitingInputCount: 0, endedCount: 0, sessionCount: 1),
      createdAt: "2026-03-17T00:05:00.000Z",
      archivedAt: nil
    ).lane

    try database.replaceLaneSnapshots([primaryLane, staleLane])
    try database.replaceTerminalSessions([
      makeTerminalSessionSummary(
        id: "stale-session",
        laneId: "lane-stale",
        laneName: "Deleted lane",
        toolType: "codex-chat",
        title: "Cached deleted-lane chat"
      ),
    ])

    XCTAssertNoThrow(try database.replaceLaneSnapshots([primaryLane]))

    XCTAssertEqual(database.fetchLaneListSnapshots(includeArchived: true).map(\.lane.id), ["lane-primary"])
    XCTAssertEqual(database.fetchLanes(includeArchived: false).map(\.id), ["lane-primary"])
    XCTAssertNotNil(database.fetchLanes(includeArchived: true).first(where: { $0.id == "lane-stale" })?.archivedAt)
    XCTAssertEqual(database.fetchSessions().map(\.id), ["stale-session"])
    database.close()
  }

  func testDatabaseReplaceLaneSnapshotsHandlesLargeLaneSets() throws {
    let baseURL = makeTemporaryDirectory()
    let database = DatabaseService(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    let lanes = (0..<925).map { index in
      makeLaneListSnapshot(
        id: "lane-\(index)",
        name: "Lane \(index)",
        laneType: index == 0 ? "primary" : "worktree",
        baseRef: "main",
        branchRef: index == 0 ? "main" : "ade/lane-\(index)",
        worktreePath: index == 0 ? "/tmp/project" : "/tmp/project/.ade/worktrees/lane-\(index)",
        description: nil,
        status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
        runtime: LaneRuntimeSummary(bucket: "none", runningCount: 0, awaitingInputCount: 0, endedCount: 0, sessionCount: 0),
        createdAt: String(format: "2026-03-17T00:%02d:00.000Z", index % 60),
        archivedAt: nil
      ).lane
    }

    XCTAssertNoThrow(try database.replaceLaneSnapshots(lanes))
    XCTAssertEqual(database.fetchLaneListSnapshots(includeArchived: true).count, lanes.count)

    let refreshed = Array(lanes.prefix(900))
    XCTAssertNoThrow(try database.replaceLaneSnapshots(refreshed))
    XCTAssertEqual(database.fetchLaneListSnapshots(includeArchived: true).count, refreshed.count)
    XCTAssertEqual(database.fetchLanes(includeArchived: false).count, refreshed.count)
    XCTAssertNotNil(database.fetchLanes(includeArchived: true).first(where: { $0.id == "lane-924" })?.archivedAt)
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

  func testDatabaseReplaceTerminalSessionsPreservesRuntimeAndResumeMetadata() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    try database.replaceTerminalSessions([
      TerminalSessionSummary(
        id: "session-1",
        laneId: "lane-primary",
        laneName: "Primary",
        ptyId: nil,
        tracked: true,
        pinned: true,
        manuallyNamed: true,
        goal: "Resume mobile parity",
        toolType: "codex-chat",
        title: "Named chat",
        status: "running",
        startedAt: "2026-03-17T00:10:00.000Z",
        endedAt: nil,
        exitCode: nil,
        transcriptPath: "/tmp/session-1.log",
        headShaStart: nil,
        headShaEnd: nil,
        lastOutputPreview: "Waiting for approval",
        summary: "Follow-up needed",
        runtimeState: "waiting-input",
        resumeCommand: "codex resume thread-1",
        resumeMetadata: TerminalResumeMetadata(
          provider: "codex",
          targetKind: "thread",
          targetId: "thread-1",
          launch: TerminalResumeLaunchConfig(
            permissionMode: "edit",
            claudePermissionMode: nil,
            codexApprovalPolicy: "on-request",
            codexSandbox: "workspace-write",
            codexConfigSource: "flags"
          ),
          target: nil,
          permissionMode: "edit"
        ),
        chatIdleSinceAt: "2026-03-17T00:11:00.000Z"
      ),
    ])

    let session = try XCTUnwrap(database.fetchSessions().first)
    XCTAssertEqual(session.runtimeState, "waiting-input")
    XCTAssertEqual(session.chatIdleSinceAt, "2026-03-17T00:11:00.000Z")
    XCTAssertEqual(session.resumeMetadata?.provider, "codex")
    XCTAssertEqual(session.resumeMetadata?.targetKind, "thread")
    XCTAssertEqual(session.resumeMetadata?.targetId, "thread-1")
    XCTAssertEqual(session.resumeMetadata?.launch.codexApprovalPolicy, "on-request")
    XCTAssertEqual(session.resumeMetadata?.launch.codexSandbox, "workspace-write")
    XCTAssertEqual(session.resumeMetadata?.launch.codexConfigSource, "flags")
    XCTAssertTrue(session.manuallyNamed ?? false)
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
    try database.executeSqlForTesting("""
      insert into lanes (
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, status, created_at, archived_at
      ) values (
        'lane-primary', 'project-1', 'Primary', null, 'primary', 'main', 'main', '/tmp/project', 'active', '2026-03-17T00:00:00.000Z', null
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

  func testDatabaseFetchSessionsHidesSessionsWhenLaneRowIsMissing() throws {
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
    XCTAssertEqual(sessions.count, 0)
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

  func testLaneRootEmptyStateGuidesUnpairedUsersWhenNoCacheExists() {
    let emptyState = laneRootEmptyState(
      connectionState: .disconnected,
      laneStatus: .disconnected,
      hasHostProfile: false
    )

    XCTAssertEqual(emptyState?.title, "Pair to load lanes")
    XCTAssertEqual(emptyState?.actionTitle, "Pair with host")
    XCTAssertEqual(emptyState?.action, .openSettings)
  }

  func testLaneDetailEmptyStateSurfacesRetryWhenHydrationFailsWithoutCache() {
    let emptyState = laneDetailEmptyState(
      connectionState: .connected,
      laneStatus: SyncDomainStatus(phase: .failed, lastError: "The host stopped before lane detail loaded.", lastHydratedAt: nil),
      hasHostProfile: true
    )

    XCTAssertEqual(emptyState?.title, "Lane detail unavailable")
    XCTAssertEqual(emptyState?.message, "The host stopped before lane detail loaded.")
    XCTAssertEqual(emptyState?.actionTitle, "Retry")
    XCTAssertEqual(emptyState?.action, .retry)
  }

  func testLaneAllowsLiveActionsRequiresConnectedAndReadyState() {
    XCTAssertTrue(
      laneAllowsLiveActions(
        connectionState: .connected,
        laneStatus: SyncDomainStatus(phase: .ready, lastError: nil, lastHydratedAt: nil)
      )
    )
    XCTAssertFalse(
      laneAllowsLiveActions(
        connectionState: .syncing,
        laneStatus: SyncDomainStatus(phase: .ready, lastError: nil, lastHydratedAt: nil)
      )
    )
    XCTAssertFalse(
      laneAllowsLiveActions(
        connectionState: .connected,
        laneStatus: SyncDomainStatus(phase: .hydrating, lastError: nil, lastHydratedAt: nil)
      )
    )
  }

  func testLaneAllowsDiffInspectionKeepsCachedTargetsReadableWhileOfflineOrSyncing() {
    XCTAssertTrue(
      laneAllowsDiffInspection(
        connectionState: .disconnected,
        laneStatus: .disconnected,
        hasCachedTargets: true
      )
    )
    XCTAssertTrue(
      laneAllowsDiffInspection(
        connectionState: .syncing,
        laneStatus: SyncDomainStatus(phase: .ready, lastError: nil, lastHydratedAt: nil),
        hasCachedTargets: true
      )
    )
    XCTAssertFalse(
      laneAllowsDiffInspection(
        connectionState: .disconnected,
        laneStatus: .disconnected,
        hasCachedTargets: false
      )
    )
    XCTAssertTrue(
      laneAllowsDiffInspection(
        connectionState: .connected,
        laneStatus: SyncDomainStatus(phase: .ready, lastError: nil, lastHydratedAt: nil),
        hasCachedTargets: false
      )
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

  func testPrFileDiffDefaultsToCollapsedForLargePatches() {
    let smallFile = PrFile(
      filename: "Sources/App.swift",
      status: "modified",
      additions: 4,
      deletions: 1,
      patch: """
      @@ -1 +1,2 @@
      -print("old")
      +print("new")
      """,
      previousFilename: nil
    )
    XCTAssertTrue(prFileDiffShouldExpandByDefault(smallFile))

    let largePatch = (0..<180).map { index in
      "line \(index)"
    }.joined(separator: "\n")
    let largeFile = PrFile(
      filename: "Sources/Huge.swift",
      status: "modified",
      additions: 180,
      deletions: 180,
      patch: largePatch,
      previousFilename: nil
    )
    XCTAssertFalse(prFileDiffShouldExpandByDefault(largeFile))
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

  func testSyntaxHighlighterRepeatedCallsReturnStableTokensAndHighlights() {
    let source = "import Foundation\nstruct Demo {\n  let title = \"Hello\"\n  // Greets the workspace\n}"

    let firstTokens = SyntaxHighlighter.tokenize(source, as: .swift)
    let secondTokens = SyntaxHighlighter.tokenize(source, as: .swift)
    XCTAssertEqual(secondTokens, firstTokens)

    let firstHighlight = SyntaxHighlighter.highlightedAttributedString(source, as: .swift)
    let secondHighlight = SyntaxHighlighter.highlightedAttributedString(source, as: .swift)
    XCTAssertEqual(secondHighlight, firstHighlight)
  }

  func testMatchedTransitionScopeReturnsNilIdsWithoutNamespace() {
    let scope = ADEMatchedTransitionScope(namespace: nil, stem: "work-session-1")

    XCTAssertNil(scope.id(.container))
    XCTAssertNil(scope.id(.icon))
    XCTAssertNil(scope.id(.title))
    XCTAssertNil(scope.id(.status))
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

  func testFilesWorkspaceDefaultsToMobileReadOnlyWhenHostOmitsFlag() throws {
    let data = try JSONSerialization.data(withJSONObject: [
      "id": "workspace-1",
      "kind": "primary",
      "laneId": NSNull(),
      "name": "Repo",
      "rootPath": "/repo",
      "isReadOnlyByDefault": false,
    ])

    let workspace = try JSONDecoder().decode(FilesWorkspace.self, from: data)

    XCTAssertTrue(workspace.mobileReadOnly)
    XCTAssertTrue(workspace.readOnlyOnMobile)
  }

  func testResolveFilesWorkspaceFallsBackToLaneMatchWhenWorkspaceIdIsStale() {
    let workspaces = [
      FilesWorkspace(
        id: "workspace-primary",
        kind: "primary",
        laneId: nil,
        name: "Repo",
        rootPath: "/repo",
        isReadOnlyByDefault: true
      ),
      FilesWorkspace(
        id: "workspace-lane-2",
        kind: "worktree",
        laneId: "lane-2",
        name: "Release",
        rootPath: "/repo/.ade/worktrees/release",
        isReadOnlyByDefault: true
      ),
    ]

    let request = FilesNavigationRequest(workspaceId: "stale-id", laneId: "lane-2", relativePath: "Sources/App.swift")

    XCTAssertEqual(resolveFilesWorkspace(for: request, in: workspaces)?.id, "workspace-lane-2")
  }

  func testFilesSearchEmptyMessageReflectsLiveAndQueryState() {
    XCTAssertEqual(
      filesSearchEmptyMessage(kind: .quickOpen, isLive: false, needsRepairing: false, query: ""),
      "Quick open needs a live host connection."
    )
    XCTAssertEqual(
      filesSearchEmptyMessage(kind: .textSearch, isLive: true, needsRepairing: false, query: "needle"),
      "No matches found."
    )
  }

  func testFilesBreadcrumbItemsKeepCurrentFileSeparateFromDirectories() {
    let items = filesBreadcrumbItems(relativePath: "Sources/Views/Files.swift", includeCurrentFile: true)

    XCTAssertEqual(
      items,
      [
        FilesBreadcrumbItem(label: "Sources", path: "Sources", isDirectory: true),
        FilesBreadcrumbItem(label: "Views", path: "Sources/Views", isDirectory: true),
        FilesBreadcrumbItem(label: "Files.swift", path: "Sources/Views/Files.swift", isDirectory: false),
      ]
    )
  }

  func testFilesEditorModesKeepDiffAvailableForLaneBackedReadOnlyPreview() {
    XCTAssertEqual(filesEditorModes(laneId: nil), [.preview])
    XCTAssertEqual(filesEditorModes(laneId: "lane-1"), [.preview, .diff])
  }

  func testFilesHistoryFallbackExplainsUnsupportedAndEmptyStates() {
    XCTAssertEqual(
      filesHistoryFallback(laneId: nil, entries: [], errorMessage: nil),
      FilesSectionFallback(
        title: "History unavailable",
        message: "This workspace is not lane-backed, so Files can only show the current preview and metadata on iPhone."
      )
    )

    XCTAssertEqual(
      filesHistoryFallback(laneId: "lane-1", entries: [], errorMessage: nil),
      FilesSectionFallback(
        title: "No recent history",
        message: "The host did not return recent commits for this file yet. Reconnect or refresh to try again."
      )
    )
  }

  func testFilesHistoryFallbackPrefersEntriesAndExplicitErrors() {
    let entries = [
      GitFileHistoryEntry(
        commitSha: "abc123",
        shortSha: "abc123",
        authorName: "Arul",
        authoredAt: "2026-04-11T21:00:00.000Z",
        subject: "Update app",
        path: "Sources/App.swift",
        previousPath: nil,
        changeType: "modified"
      )
    ]

    XCTAssertNil(filesHistoryFallback(laneId: "lane-1", entries: entries, errorMessage: nil))
    XCTAssertEqual(
      filesHistoryFallback(laneId: "lane-1", entries: [], errorMessage: "Cache missing"),
      FilesSectionFallback(
        title: "History unavailable",
        message: "Cache missing"
      )
    )
  }

  func testDatabaseCachesFilesWorkspaceDirectoryBlobDiffAndHistorySnapshots() throws {
    let database = DatabaseService(baseURL: makeTemporaryDirectory())
    XCTAssertNil(database.initializationError)

    try database.replaceFilesWorkspaces([
      FilesWorkspace(
        id: "workspace-lane-1",
        kind: "worktree",
        laneId: "lane-1",
        name: "Feature",
        rootPath: "/repo/.ade/worktrees/feature",
        isReadOnlyByDefault: false,
        mobileReadOnly: true
      )
    ])
    try database.cacheDirectorySnapshot(
      workspaceId: "workspace-lane-1",
      parentPath: "Sources",
      includeHidden: false,
      nodes: [FileTreeNode(name: "App.swift", path: "Sources/App.swift", type: "file", hasChildren: nil, children: nil, changeStatus: "M", size: 321)]
    )
    try database.cacheFileContentSnapshot(
      workspaceId: "workspace-lane-1",
      path: "Sources/App.swift",
      blob: SyncFileBlob(path: "Sources/App.swift", size: 321, mimeType: nil, encoding: "utf-8", isBinary: false, content: "print(\"hi\")", languageId: "swift")
    )
    try database.cacheFileDiffSnapshot(
      workspaceId: "workspace-lane-1",
      path: "Sources/App.swift",
      mode: "unstaged",
      diff: FileDiff(
        path: "Sources/App.swift",
        mode: "unstaged",
        original: DiffSide(exists: true, text: "print(\"old\")"),
        modified: DiffSide(exists: true, text: "print(\"hi\")"),
        isBinary: false,
        language: "swift"
      )
    )
    try database.cacheFileHistorySnapshot(
      workspaceId: "workspace-lane-1",
      path: "Sources/App.swift",
      entries: [
        GitFileHistoryEntry(
          commitSha: "abc123",
          shortSha: "abc123",
          authorName: "Arul",
          authoredAt: "2026-04-11T21:00:00.000Z",
          subject: "Update app",
          path: "Sources/App.swift",
          previousPath: nil,
          changeType: "modified"
        )
      ]
    )

    XCTAssertEqual(database.listWorkspaces().first?.id, "workspace-lane-1")
    XCTAssertTrue(database.listWorkspaces().first?.mobileReadOnly == true)
    XCTAssertEqual(database.fetchDirectorySnapshot(workspaceId: "workspace-lane-1", parentPath: "Sources", includeHidden: false)?.first?.path, "Sources/App.swift")
    XCTAssertEqual(database.fetchFileContentSnapshot(workspaceId: "workspace-lane-1", path: "Sources/App.swift")?.content, "print(\"hi\")")
    XCTAssertEqual(database.fetchFileDiffSnapshot(workspaceId: "workspace-lane-1", path: "Sources/App.swift", mode: "unstaged")?.modified.text, "print(\"hi\")")
    XCTAssertEqual(database.fetchFileHistorySnapshot(workspaceId: "workspace-lane-1", path: "Sources/App.swift")?.first?.subject, "Update app")
    database.close()
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

  func testWorkChatTranscriptPreservesReasoningIdentity() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-04-22T21:11:58.154Z","sequence":6,"event":{"type":"reasoning","text":"The user wants","turnId":"turn-1","itemId":"claude-thinking:turn-1:0","summaryIndex":0}}
    """

    let transcript = parseWorkChatTranscript(raw)

    guard case .reasoning(let text, let turnId, let itemId, let summaryIndex) = transcript.first?.event else {
      return XCTFail("Expected reasoning event.")
    }
    XCTAssertEqual(text, "The user wants")
    XCTAssertEqual(turnId, "turn-1")
    XCTAssertEqual(itemId, "claude-thinking:turn-1:0")
    XCTAssertEqual(summaryIndex, 0)
  }

  func testWorkEventCardsMergeReasoningFragmentsByItemId() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T21:11:58.154Z",
        sequence: 6,
        event: .reasoning(text: "The user wants", turnId: "turn-1", itemId: "claude-thinking:turn-1:0", summaryIndex: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T21:11:58.509Z",
        sequence: 7,
        event: .reasoning(text: "to test computer use", turnId: "turn-1", itemId: "claude-thinking:turn-1:0", summaryIndex: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T21:11:58.843Z",
        sequence: 8,
        event: .reasoning(text: "and proof capture.", turnId: "turn-1", itemId: "claude-thinking:turn-1:0", summaryIndex: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T21:12:00.000Z",
        sequence: 9,
        event: .reasoning(text: "Second thought.", turnId: "turn-1", itemId: "claude-thinking:turn-1:1", summaryIndex: nil)
      ),
    ]

    let cards = buildWorkEventCards(from: transcript).filter { $0.kind == "reasoning" }

    XCTAssertEqual(cards.count, 2)
    XCTAssertEqual(cards.first?.body, "The user wants to test computer use and proof capture.")
    XCTAssertEqual(cards.first?.timestamp, "2026-04-22T21:11:58.843Z")
    XCTAssertEqual(cards.last?.body, "Second thought.")
  }

  func testWorkChatTranscriptHelpersDecodeCommandFileChangeCompletionReportAndUsageEvents() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:00.000Z","sequence":1,"event":{"type":"command","command":"npm test","cwd":"/tmp/work","output":"ok","itemId":"cmd-1","turnId":"turn-1","exitCode":0,"durationMs":1240,"status":"completed"}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:01.000Z","sequence":2,"event":{"type":"file_change","path":"Sources/WorkTabView.swift","diff":"@@ -1 +1 @@","kind":"modify","itemId":"file-1","turnId":"turn-1","status":"completed"}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:02.000Z","sequence":3,"event":{"type":"completion_report","report":{"timestamp":"2026-03-25T00:00:02.000Z","summary":"Finished","status":"completed","artifacts":[{"type":"file","description":"Updated the transcript","reference":"docs/transcript.md"}]}}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:03.000Z","sequence":4,"event":{"type":"done","turnId":"turn-1","status":"completed","model":"claude-sonnet-4","usage":{"inputTokens":120,"outputTokens":45,"cacheReadTokens":12,"cacheCreationTokens":3},"costUsd":1.23}}
    """

    let transcript = parseWorkChatTranscript(raw)

    XCTAssertEqual(transcript.count, 4)

    guard case .command(let command, let cwd, let output, let status, let itemId, let exitCode, let durationMs, let turnId) = transcript[0].event else {
      return XCTFail("Expected command event.")
    }
    XCTAssertEqual(command, "npm test")
    XCTAssertEqual(cwd, "/tmp/work")
    XCTAssertEqual(output, "ok")
    XCTAssertEqual(status, .completed)
    XCTAssertEqual(itemId, "cmd-1")
    XCTAssertEqual(exitCode, 0)
    XCTAssertEqual(durationMs, 1240)
    XCTAssertEqual(turnId, "turn-1")

    guard case .fileChange(let path, let diff, let kind, let fileStatus, let fileItemId, let fileTurnId) = transcript[1].event else {
      return XCTFail("Expected file change event.")
    }
    XCTAssertEqual(path, "Sources/WorkTabView.swift")
    XCTAssertEqual(diff, "@@ -1 +1 @@")
    XCTAssertEqual(kind, "modify")
    XCTAssertEqual(fileStatus, .completed)
    XCTAssertEqual(fileItemId, "file-1")
    XCTAssertEqual(fileTurnId, "turn-1")

    guard case .completionReport(let summary, let reportStatus, let artifacts, let blockerDescription, let reportTurnId) = transcript[2].event else {
      return XCTFail("Expected completion report event.")
    }
    XCTAssertEqual(summary, "Finished")
    XCTAssertEqual(reportStatus, "completed")
    XCTAssertEqual(artifacts.first?.reference, "docs/transcript.md")
    XCTAssertNil(blockerDescription)
    XCTAssertEqual(reportTurnId, nil)

    guard case .done(let doneStatus, let doneSummary, let usage, let doneTurnId, let doneModel, let doneModelId) = transcript[3].event else {
      return XCTFail("Expected done event.")
    }
    XCTAssertEqual(doneStatus, "completed")
    XCTAssertTrue(doneSummary.contains("claude-sonnet-4"))
    XCTAssertEqual(doneModel, "claude-sonnet-4")
    XCTAssertEqual(doneModelId, nil)
    XCTAssertTrue(doneSummary.contains("inputTokens"))
    XCTAssertTrue(doneSummary.contains("$1.2300"))
    XCTAssertEqual(usage?.inputTokens, 120)
    XCTAssertEqual(usage?.outputTokens, 45)
    XCTAssertEqual(usage?.costUsd, 1.23)
    XCTAssertEqual(doneTurnId, "turn-1")

    let sessionUsage = summarizeWorkSessionUsage(from: transcript)
    XCTAssertEqual(sessionUsage?.turnCount, 1)
    XCTAssertEqual(sessionUsage?.inputTokens, 120)
    XCTAssertEqual(sessionUsage?.outputTokens, 45)
    XCTAssertEqual(sessionUsage?.cacheReadTokens, 12)
    XCTAssertEqual(sessionUsage?.cacheCreationTokens, 3)
    XCTAssertEqual(sessionUsage?.costUsd, 1.23)
  }

  func testWorkChatStatusNormalizationPrefersAwaitingInputAndIdle() {
    let waitingSummary = makeAgentChatSessionSummary(status: "active", awaitingInput: true)
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: nil, summary: waitingSummary), "awaiting-input")

    let idleSummary = makeAgentChatSessionSummary(status: "paused", awaitingInput: false)
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: nil, summary: idleSummary), "idle")

    let session = makeTerminalSessionSummary(toolType: "codex-chat", runtimeState: "waiting-input", status: "running")
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: session, summary: nil), "awaiting-input")
  }

  func testWorkChatStatusNormalizationFallsBackToSessionRuntimeStateAndTerminalState() {
    let completedSummary = makeAgentChatSessionSummary(status: "completed", awaitingInput: false)
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: nil, summary: completedSummary), "ended")

    let runningSession = makeTerminalSessionSummary(toolType: "codex-chat", runtimeState: "running", status: "running")
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: runningSession, summary: nil), "active")

    let idleSession = makeTerminalSessionSummary(toolType: "codex-chat", runtimeState: "idle", status: "running")
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: idleSession, summary: nil), "idle")

    let endedSession = makeTerminalSessionSummary(toolType: "codex-chat", runtimeState: "stopped", status: "exited")
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: endedSession, summary: nil), "ended")
  }

  func testWorkChatSessionClassificationMatchesDesktopChatToolTypes() {
    XCTAssertTrue(isChatSession(makeTerminalSessionSummary(toolType: "codex-chat")))
    XCTAssertTrue(isChatSession(makeTerminalSessionSummary(toolType: "cursor")))
    XCTAssertTrue(isChatSession(makeTerminalSessionSummary(toolType: "custom-chat")))
    XCTAssertFalse(isChatSession(makeTerminalSessionSummary(toolType: "run-shell")))
    XCTAssertTrue(isRunOwnedSession(makeTerminalSessionSummary(toolType: "run-shell")))
    XCTAssertTrue(isRunOwnedSession(makeTerminalSessionSummary(toolType: " RUN-SHELL ")))
    XCTAssertFalse(isRunOwnedSession(makeTerminalSessionSummary(toolType: "shell")))
    XCTAssertFalse(isRunOwnedSession(makeTerminalSessionSummary(toolType: "codex-chat")))
  }

  func testWorkChatSessionClassificationTrimsWhitespaceAndRejectsBlankValues() {
    XCTAssertTrue(isChatSession(makeTerminalSessionSummary(toolType: "  claude-chat  ")))
    XCTAssertTrue(isChatSession(makeTerminalSessionSummary(toolType: "\ncustom-chat\t")))
    XCTAssertFalse(isChatSession(makeTerminalSessionSummary(toolType: "   ")))
    XCTAssertFalse(isChatSession(makeTerminalSessionSummary(toolType: nil)))
  }

  func testAgentChatSessionSummaryDecodesCursorAndControlFields() throws {
    let payload: [String: Any] = [
      "sessionId": "chat-1",
      "laneId": "lane-1",
      "provider": "cursor",
      "model": "cursor-agent",
      "modelId": "cursor-agent-1",
      "sessionProfile": "profile-1",
      "title": "Cursor chat",
      "goal": "Land Work tab parity",
      "reasoningEffort": "medium",
      "executionMode": "agent",
      "permissionMode": "edit",
      "interactionMode": "chat",
      "claudePermissionMode": "acceptEdits",
      "codexApprovalPolicy": "on-request",
      "codexSandbox": "workspace-write",
      "codexConfigSource": "host",
      "opencodePermissionMode": "edit",
      "cursorModeSnapshot": [
        "currentModeId": "ask",
        "availableModeIds": ["agent", "ask", "manual"],
      ],
      "cursorModeId": "ask",
      "cursorConfigValues": [
        "voice": true,
        "temperature": 0.5,
        "notes": "mobile",
      ],
      "identityKey": "identity-1",
      "surface": "work",
      "automationId": "automation-1",
      "automationRunId": "run-1",
      "capabilityMode": "full",
      "computerUse": [
        "enabled": true,
      ],
      "completion": [
        "timestamp": "2026-03-25T00:00:02.000Z",
        "summary": "Done",
        "status": "completed",
        "artifacts": [
          [
            "type": "file",
            "description": "Updated transcript",
            "reference": "docs/transcript.md",
          ],
        ],
        "blockerDescription": "None",
      ],
      "status": "running",
      "idleSinceAt": "2026-03-25T00:00:01.000Z",
      "startedAt": "2026-03-25T00:00:00.000Z",
      "endedAt": NSNull(),
      "lastActivityAt": "2026-03-25T00:00:02.000Z",
      "lastOutputPreview": "Working...",
      "summary": "Primary chat session",
      "awaitingInput": true,
      "threadId": "thread-1",
      "requestedCwd": "apps/ios/ADE",
    ]

    let data = try JSONSerialization.data(withJSONObject: payload)
    let summary = try JSONDecoder().decode(AgentChatSessionSummary.self, from: data)

    XCTAssertEqual(summary.sessionId, "chat-1")
    XCTAssertEqual(summary.provider, "cursor")
    XCTAssertEqual(summary.cursorModeId, "ask")
    XCTAssertEqual(summary.cursorModeSnapshot, .object([
      "currentModeId": .string("ask"),
      "availableModeIds": .array([.string("agent"), .string("ask"), .string("manual")]),
    ]))
    XCTAssertEqual(summary.cursorConfigValues?["voice"], .bool(true))
    XCTAssertEqual(summary.cursorConfigValues?["temperature"], .number(0.5))
    XCTAssertEqual(summary.completion?.artifacts?.first?.reference, "docs/transcript.md")
    XCTAssertTrue(summary.awaitingInput ?? false)
    XCTAssertEqual(summary.requestedCwd, "apps/ios/ADE")
  }

  func testCtoRosterDecodesCtoSummaryAndWorkerEntries() throws {
    let ctoSummary: [String: Any] = [
      "sessionId": "cto-session-1",
      "laneId": "lane-cto",
      "provider": "claude",
      "model": "claude-opus-4-6",
      "identityKey": "cto",
      "status": "active",
      "startedAt": "2026-03-25T00:00:00.000Z",
      "lastActivityAt": "2026-03-25T00:00:05.000Z",
    ]

    let workerOneSummary: [String: Any] = [
      "sessionId": "worker-session-1",
      "laneId": "lane-cto",
      "provider": "claude",
      "model": "claude-sonnet-4-6",
      "identityKey": "agent:worker-1",
      "status": "running",
      "startedAt": "2026-03-25T00:01:00.000Z",
      "lastActivityAt": "2026-03-25T00:01:10.000Z",
      "awaitingInput": false,
    ]

    let payload: [String: Any] = [
      "cto": ctoSummary,
      "workers": [
        [
          "agentId": "worker-1",
          "name": "Build Bot",
          "avatarSeed": "build-bot",
          "status": "running",
          "sessionSummary": workerOneSummary,
        ],
        [
          "agentId": "worker-2",
          "name": "Research Bot",
          "avatarSeed": NSNull(),
          "status": "idle",
          "sessionSummary": NSNull(),
        ],
      ],
    ]

    let data = try JSONSerialization.data(withJSONObject: payload)
    let roster = try JSONDecoder().decode(CtoRoster.self, from: data)

    XCTAssertEqual(roster.cto?.sessionId, "cto-session-1")
    XCTAssertEqual(roster.cto?.identityKey, "cto")
    XCTAssertEqual(roster.workers.count, 2)

    let first = roster.workers[0]
    XCTAssertEqual(first.id, "worker-1")
    XCTAssertEqual(first.agentId, "worker-1")
    XCTAssertEqual(first.name, "Build Bot")
    XCTAssertEqual(first.avatarSeed, "build-bot")
    XCTAssertEqual(first.status, "running")
    XCTAssertEqual(first.sessionSummary?.sessionId, "worker-session-1")
    XCTAssertEqual(first.sessionSummary?.identityKey, "agent:worker-1")

    let second = roster.workers[1]
    XCTAssertEqual(second.agentId, "worker-2")
    XCTAssertEqual(second.name, "Research Bot")
    XCTAssertNil(second.avatarSeed)
    XCTAssertEqual(second.status, "idle")
    XCTAssertNil(second.sessionSummary)

    // Round-trip encode + decode to confirm Codable key parity.
    let encoded = try JSONEncoder().encode(roster)
    let roundTripped = try JSONDecoder().decode(CtoRoster.self, from: encoded)
    XCTAssertEqual(roundTripped, roster)
    XCTAssertEqual(roundTripped.workers.map(\.agentId), ["worker-1", "worker-2"])
  }

  func testCtoRosterDecodesNullCtoAndEmptyWorkers() throws {
    let payload: [String: Any] = [
      "cto": NSNull(),
      "workers": [] as [Any],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    let roster = try JSONDecoder().decode(CtoRoster.self, from: data)

    XCTAssertNil(roster.cto)
    XCTAssertTrue(roster.workers.isEmpty)
  }

  func testCtoRosterDecodesMissingCtoKey() throws {
    let payload: [String: Any] = [
      "workers": [] as [Any],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    let roster = try JSONDecoder().decode(CtoRoster.self, from: data)

    XCTAssertNil(roster.cto)
    XCTAssertTrue(roster.workers.isEmpty)
  }

  func testCtoAvatarPaletteIndexIsDeterministic() {
    let inputs = ["build-bot", "Research Bot", "worker-42"]
    let paletteSize = 7
    for input in inputs {
      let first = ctoAvatarPaletteIndex(for: input, paletteSize: paletteSize)
      let second = ctoAvatarPaletteIndex(for: input, paletteSize: paletteSize)
      XCTAssertEqual(first, second, "hash drifted for input '\(input)'")
      XCTAssertGreaterThanOrEqual(first, 0)
      XCTAssertLessThan(first, paletteSize)
    }
    // Zero-size palette degrades to 0 rather than crashing on modulo.
    XCTAssertEqual(ctoAvatarPaletteIndex(for: "anything", paletteSize: 0), 0)
  }

  func testMergeWorkChatTranscriptsReplacesDuplicatesAndSortsByTime() {
    let base = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .assistantText(text: "Second", turnId: "turn-1", itemId: "msg-2")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "First", turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
      ),
    ]
    let live = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "First", turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:03.000Z",
        sequence: 3,
        event: .assistantText(text: "Third", turnId: "turn-1", itemId: "msg-3")
      ),
    ]

    let merged = mergeWorkChatTranscripts(base: base, live: live)

    XCTAssertEqual(merged.count, 3)
    XCTAssertEqual(merged.map(\.timestamp), [
      "2026-03-25T00:00:01.000Z",
      "2026-03-25T00:00:02.000Z",
      "2026-03-25T00:00:03.000Z",
    ])
  }

  /// Regression: hosts occasionally replay the same activity envelope during resume, so the cached
  /// `base` can contain two rows with identical merge keys. The old `Dictionary(uniqueKeysWithValues:)`
  /// crashed on that; the merge must dedupe in place and keep the transcript stable.
  func testMergeWorkChatTranscriptsToleratesDuplicateMergeKeysInBase() {
    let duplicate = WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-04-16T07:34:53.872Z",
      sequence: 1,
      event: .activity(kind: "reading", detail: "app", turnId: "turn-1")
    )
    let base = [
      duplicate,
      duplicate,
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-16T07:34:55.000Z",
        sequence: 2,
        event: .assistantText(text: "hello", turnId: "turn-1", itemId: "msg-1")
      ),
    ]
    let live = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-16T07:34:56.000Z",
        sequence: 3,
        event: .assistantText(text: "world", turnId: "turn-1", itemId: "msg-2")
      ),
    ]

    let merged = mergeWorkChatTranscripts(base: base, live: live)

    XCTAssertEqual(merged.count, 3)
    XCTAssertEqual(merged.map(\.timestamp), [
      "2026-04-16T07:34:53.872Z",
      "2026-04-16T07:34:55.000Z",
      "2026-04-16T07:34:56.000Z",
    ])
  }

  func testPreferredWorkTranscriptReplacesFallbackWhenEventStreamArrives() {
    let fallback = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: nil,
        event: .userMessage(text: "What model are you?", turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: nil,
        event: .assistantText(text: "I'm Codex, based on GPT-5.", turnId: "turn-1", itemId: nil)
      ),
    ]
    let eventTranscript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "What model are you?", turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 2,
        event: .assistantText(text: "I'm Codex, based on GPT-5.", turnId: "turn-1", itemId: "msg-1")
      ),
    ]

    let preferred = preferredWorkTranscript(
      current: fallback,
      fallback: fallback,
      eventTranscript: eventTranscript
    )
    let messages = buildWorkChatMessages(from: preferred)

    XCTAssertEqual(preferred.count, 2)
    XCTAssertEqual(preferred.compactMap(\.sequence), [1, 2])
    XCTAssertEqual(messages.filter { $0.role == "assistant" }.map(\.markdown), ["I'm Codex, based on GPT-5."])
  }

  func testPendingWorkInputItemIdsTracksResolvedApprovalAndQuestionEvents() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .approvalRequest(description: "Run tests?", detail: nil, itemId: "approval-1", turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .structuredQuestion(
          question: "Deploy?",
          options: [
            WorkPendingQuestionOption(label: "Yes", value: "Yes", description: nil),
            WorkPendingQuestionOption(label: "No", value: "No", description: nil),
          ],
          itemId: "question-1",
          turnId: "turn-1"
        )
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:03.000Z",
        sequence: 3,
        event: .pendingInputResolved(itemId: "approval-1", resolution: "accepted", turnId: "turn-1")
      ),
    ]

    XCTAssertEqual(pendingWorkInputItemIds(from: transcript), Set(["question-1"]))
  }

  func testParseWorkChatTranscriptDecodesSteerIdAndDeliveryState() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:01.000Z","sequence":1,"event":{"type":"user_message","text":"ship it","turnId":"turn-1","steerId":"steer-1","deliveryState":"queued"}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:02.000Z","sequence":2,"event":{"type":"system_notice","kind":"steer_cancelled","message":"Cancelled","steerId":"steer-1","turnId":"turn-1"}}
    """

    let transcript = parseWorkChatTranscript(raw)
    XCTAssertEqual(transcript.count, 2)

    guard case .userMessage(let text, _, let steerId, let deliveryState, _) = transcript[0].event else {
      return XCTFail("Expected user_message event.")
    }
    XCTAssertEqual(text, "ship it")
    XCTAssertEqual(steerId, "steer-1")
    XCTAssertEqual(deliveryState, "queued")

    guard case .systemNotice(_, _, _, _, let noticeSteerId) = transcript[1].event else {
      return XCTFail("Expected system_notice event.")
    }
    XCTAssertEqual(noticeSteerId, "steer-1")
  }

  func testDerivePendingWorkInputsReturnsApprovalsAndQuestionsInRequestOrder() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .approvalRequest(description: "Run tests?", detail: nil, itemId: "approval-1", turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .structuredQuestion(
          question: "Deploy?",
          options: [
            WorkPendingQuestionOption(label: "Yes", value: "Yes", description: nil),
            WorkPendingQuestionOption(label: "No", value: "No", description: nil),
          ],
          itemId: "question-1",
          turnId: "turn-1"
        )
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:03.000Z",
        sequence: 3,
        event: .approvalRequest(description: "Push branch?", detail: nil, itemId: "approval-2", turnId: "turn-1")
      ),
    ]

    let items = derivePendingWorkInputs(from: transcript)
    XCTAssertEqual(items.map(\.itemId), ["approval-1", "question-1", "approval-2"])
  }

  func testDerivePendingWorkInputsRemovesResolvedItems() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .approvalRequest(description: "Run tests?", detail: nil, itemId: "approval-1", turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .structuredQuestion(question: "Deploy?", options: [], itemId: "question-1", turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:03.000Z",
        sequence: 3,
        event: .pendingInputResolved(itemId: "approval-1", resolution: "accepted", turnId: "turn-1")
      ),
    ]

    let items = derivePendingWorkInputs(from: transcript)
    XCTAssertEqual(items.map(\.itemId), ["question-1"])
  }

  func testDerivePendingWorkInputsParsesStructuredQuestionApprovalDetail() {
    let detail = """
    {
      "request": {
        "requestId": "0",
        "itemId": "approval-structured",
        "source": "codex",
        "kind": "structured_question",
        "title": "Input requested",
        "description": "Which surface should I inspect first?",
        "questions": [
          {
            "id": "focus_area",
            "header": "Focus",
            "question": "Which surface should I inspect first?",
            "allowsFreeform": true,
            "options": [
              {
                "label": "Mobile Work tab",
                "value": "mobile_work",
                "description": "Inspect the phone chat first."
              },
              {
                "label": "Desktop Work tab",
                "value": "desktop_work"
              }
            ]
          }
        ],
        "allowsFreeform": true,
        "blocking": true,
        "canProceedWithoutAnswer": false,
        "turnId": "turn-1"
      }
    }
    """
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .approvalRequest(
          description: "Which surface should I inspect first?",
          detail: detail,
          itemId: "approval-structured",
          turnId: "turn-1"
        )
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 2,
        event: .done(status: "completed", summary: "", usage: nil, turnId: "turn-1", model: nil, modelId: nil)
      ),
    ]

    XCTAssertEqual(pendingWorkInputItemIds(from: transcript), Set(["approval-structured"]))

    let inputs = derivePendingWorkInputs(from: transcript)
    XCTAssertEqual(inputs.map(\.itemId), ["approval-structured"])
    guard case .question(let question) = inputs.first else {
      return XCTFail("Expected structured question approval to render as a question.")
    }
    XCTAssertEqual(question.questionId, "focus_area")
    XCTAssertEqual(question.question, "Which surface should I inspect first?")
    XCTAssertEqual(question.options.first?.label, "Mobile Work tab")
    XCTAssertEqual(question.options.first?.value, "mobile_work")
    XCTAssertEqual(question.options.first?.description, "Inspect the phone chat first.")
    XCTAssertTrue(question.allowsFreeform)
  }

  func testDerivePendingWorkSteersTracksQueuedEditsAndCancellations() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "ship", turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .userMessage(text: "ship it fast", turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:03.000Z",
        sequence: 3,
        event: .userMessage(text: "also run tests", turnId: "turn-1", steerId: "steer-2", deliveryState: "queued", processed: nil)
      ),
    ]

    let steers = derivePendingWorkSteers(from: transcript)
    XCTAssertEqual(steers.map(\.id), ["steer-1", "steer-2"])
    XCTAssertEqual(steers.first?.text, "ship it fast")
  }

  func testDerivePendingWorkSteersClearsOnSystemNoticeAndDelivery() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "first", turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .userMessage(text: "second", turnId: "turn-1", steerId: "steer-2", deliveryState: "queued", processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:03.000Z",
        sequence: 3,
        event: .systemNotice(kind: "steer_cancelled", message: "Cancelled", detail: nil, turnId: "turn-1", steerId: "steer-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:04.000Z",
        sequence: 4,
        event: .userMessage(text: "second", turnId: "turn-1", steerId: "steer-2", deliveryState: "delivered", processed: nil)
      ),
    ]

    let steers = derivePendingWorkSteers(from: transcript)
    XCTAssertTrue(steers.isEmpty)
  }

  func testMergeWorkChatTranscriptsReplacesQueuedSteerEditInPlace() {
    let base = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "ship", turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
    ]
    let live = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "ship it fast", turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
    ]

    let merged = mergeWorkChatTranscripts(base: base, live: live)
    XCTAssertEqual(merged.count, 1)
    guard case .userMessage(let text, _, _, _, _) = merged[0].event else {
      return XCTFail("Expected user_message event.")
    }
    XCTAssertEqual(text, "ship it fast")
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

  func testParseMarkdownBlocksUsesStableIdsAcrossRepeatedCalls() {
    let markdown = """
    # Heading

    - one
    - one

    ```swift
    let value = 1
    ```
    """

    let first = parseMarkdownBlocks(markdown)
    let second = parseMarkdownBlocks(markdown)

    XCTAssertEqual(first, second)
    XCTAssertEqual(first.map(\.id), second.map(\.id))
  }

  func testParseMarkdownTableRowsPreservesBlankCells() {
    let blocks = parseMarkdownBlocks("""
    | Name | Status | Owner |
    | --- | --- | --- |
    | Build |  | ADE |
    | Ship | done |  |
    """)

    guard case .table(let headers, let rows) = blocks.first?.kind else {
      return XCTFail("Expected markdown table block.")
    }
    XCTAssertEqual(headers, ["Name", "Status", "Owner"])
    XCTAssertEqual(rows, [
      ["Build", "", "ADE"],
      ["Ship", "done", ""],
    ])
  }

  func testParseWorkChatTranscriptUsesDeterministicFallbackItemIds() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:01.000Z","sequence":1,"event":{"type":"tool_call","tool":"functions.Read","args":{"path":"README.md"},"turnId":"turn-1"}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:02.000Z","sequence":2,"event":{"type":"tool_result","tool":"functions.Read","result":{"content":"ADE"},"turnId":"turn-1","status":"completed"}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:03.000Z","sequence":3,"event":{"type":"structured_question","question":"Deploy?","options":[{"label":"Yes"},{"label":"Yes"}],"turnId":"turn-1"}}
    """

    let first = parseWorkChatTranscript(raw)
    let second = parseWorkChatTranscript(raw)

    guard case .toolCall(_, _, let callId, _, _) = first[0].event,
          case .toolCall(_, _, let secondCallId, _, _) = second[0].event,
          case .toolResult(_, _, let resultId, _, _, _) = first[1].event,
          case .toolResult(_, _, let secondResultId, _, _, _) = second[1].event,
          case .structuredQuestion(_, _, let questionId, _) = first[2].event,
          case .structuredQuestion(_, _, let secondQuestionId, _) = second[2].event
    else {
      return XCTFail("Expected fallback item ids to decode.")
    }

    XCTAssertFalse(callId.isEmpty)
    XCTAssertFalse(resultId.isEmpty)
    XCTAssertFalse(questionId.isEmpty)
    XCTAssertEqual(callId, secondCallId)
    XCTAssertEqual(resultId, secondResultId)
    XCTAssertEqual(questionId, secondQuestionId)
  }

  func testWorkModelCatalogInjectsMissingModelIntoMatchingProviderGroup() {
    XCTAssertEqual(
      workModelCatalogGroupKey(for: "opencode/anthropic/claude-sonnet-4-6", currentProvider: "anthropic"),
      "opencode"
    )

    let groups = workModelCatalogGroups(
      currentModelId: "opencode/anthropic/claude-sonnet-4-6",
      currentProvider: "anthropic"
    )

    let opencodeGroup = groups.first(where: { $0.key == "opencode" })
    let anthropicProvider = opencodeGroup?.providers.first(where: { $0.key == "anthropic" })
    XCTAssertEqual(anthropicProvider?.models.first?.id, "opencode/anthropic/claude-sonnet-4-6")
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

  func testNormalizeWorkFileReferenceResolvesRelativePathsFromRequestedCwd() {
    let resolved = normalizeWorkFileReference(
      "Helpers/WorkView.swift",
      workspaceRoot: "/repo/ade",
      requestedCwd: "apps/ios/ADE"
    )

    XCTAssertEqual(resolved, "apps/ios/ADE/Helpers/WorkView.swift")
  }

  func testWorkActivitySourceSessionsReuseFilteredWorkCollection() {
    let lane1Chat = makeTerminalSessionSummary(
      id: "chat-1",
      laneId: "lane-1",
      laneName: "feature/work",
      toolType: "codex-chat",
      title: "Fix Work root"
    )
    let lane2Chat = makeTerminalSessionSummary(
      id: "chat-2",
      laneId: "lane-2",
      laneName: "release",
      toolType: "claude-chat",
      title: "Deploy release"
    )
    let lane2Terminal = makeTerminalSessionSummary(
      id: "terminal-1",
      laneId: "lane-2",
      laneName: "release",
      toolType: "shell",
      runtimeState: "idle",
      title: "Deploy logs",
      lastOutputPreview: "Tail the deploy terminal output"
    )

    let chatSummaries = [
      "chat-1": makeAgentChatSessionSummary(
        sessionId: "chat-1",
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        title: "Fix Work root",
        status: "active"
      ),
      "chat-2": makeAgentChatSessionSummary(
        sessionId: "chat-2",
        laneId: "lane-2",
        provider: "claude",
        model: "sonnet",
        title: "Deploy release",
        status: "active"
      ),
    ]

    let filtered = workFilteredSessions(
      [lane1Chat, lane2Terminal, lane2Chat],
      chatSummaries: chatSummaries,
      archivedSessionIds: [],
      selectedStatus: .running,
      selectedLaneId: "lane-2",
      searchText: "deploy"
    )
    let activitySessions = workActivitySourceSessions(
      filtered,
      chatSummaries: chatSummaries,
      archivedSessionIds: []
    )

    XCTAssertEqual(filtered.map(\.id), ["chat-2", "terminal-1"])
    XCTAssertEqual(activitySessions.map(\.id), ["chat-2"])
  }

  func testWorkRunningBannerCopyDescribesMixedLiveSessions() {
    XCTAssertEqual(
      workRunningBannerTitle(liveChatCount: 1, liveTerminalCount: 1, attentionCount: 1),
      "1 chat needs input, 2 other sessions are live"
    )
    XCTAssertEqual(
      workRunningBannerTitle(liveChatCount: 1, liveTerminalCount: 1, attentionCount: 0),
      "2 live sessions across chat and terminal"
    )
    XCTAssertEqual(
      workRunningBannerMessage(liveTerminalCount: 1, attentionCount: 0),
      "The Work tab badge stays visible while live chats or terminal sessions continue running."
    )
  }

  func testWorkFilesWorkspaceSelectionRequiresMatchingLaneWorkspace() {
    let workspaces = [
      FilesWorkspace(
        id: "workspace-root",
        kind: "project",
        laneId: nil,
        name: "Project",
        rootPath: "/repo/ade",
        isReadOnlyByDefault: true
      ),
      FilesWorkspace(
        id: "workspace-lane-2",
        kind: "lane",
        laneId: "lane-2",
        name: "Release",
        rootPath: "/repo/ade/lane-2",
        isReadOnlyByDefault: true
      ),
    ]

    XCTAssertEqual(workFilesWorkspace(for: "lane-2", in: workspaces)?.id, "workspace-lane-2")
    XCTAssertNil(workFilesWorkspace(for: "lane-1", in: workspaces))
  }

  func testWorkFilteredSessionsIncludesTerminalRowsAndMatchesSearchAndLaneFilters() {
    let chatSession = makeTerminalSessionSummary(
      id: "chat-1",
      laneId: "lane-1",
      laneName: "feature/work",
      toolType: "codex-chat",
      title: "Fix Work root"
    )
    let terminalSession = makeTerminalSessionSummary(
      id: "terminal-1",
      laneId: "lane-2",
      laneName: "release",
      toolType: "shell",
      runtimeState: "idle",
      title: "Deploy logs",
      lastOutputPreview: "Tail the deploy terminal output"
    )
    let chatSummary = makeAgentChatSessionSummary(
      sessionId: "chat-1",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      title: "Fix Work root",
      status: "active"
    )

    let filtered = workFilteredSessions(
      [chatSession, terminalSession],
      chatSummaries: ["chat-1": chatSummary],
      archivedSessionIds: [],
      selectedStatus: .running,
      selectedLaneId: "lane-2",
      searchText: "deploy terminal"
    )

    XCTAssertEqual(filtered.map(\.id), ["terminal-1"])
  }

  func testWorkFilteredSessionsHidesRunOwnedRowsLikeDesktop() {
    let chatSession = makeTerminalSessionSummary(
      id: "chat-1",
      laneId: "lane-1",
      laneName: "feature/work",
      toolType: "codex-chat",
      title: "Fix Work root"
    )
    let runOwnedSession = makeTerminalSessionSummary(
      id: "run-1",
      laneId: "lane-1",
      laneName: "feature/work",
      toolType: "run-shell",
      runtimeState: "running",
      title: "Run inspector",
      lastOutputPreview: "npm test"
    )

    let filtered = workFilteredSessions(
      [runOwnedSession, chatSession],
      chatSummaries: [:],
      archivedSessionIds: [],
      selectedStatus: .all,
      selectedLaneId: "all",
      searchText: ""
    )

    XCTAssertEqual(filtered.map(\.id), ["chat-1"])
  }

  func testWorkFilteredSessionsPrioritizesWaitingBeforeActiveAndEnded() {
    let waitingChat = makeTerminalSessionSummary(
      id: "chat-waiting",
      laneId: "lane-1",
      laneName: "feature/work",
      toolType: "codex-chat",
      title: "Needs approval"
    )
    let activeTerminal = makeTerminalSessionSummary(
      id: "terminal-active",
      laneId: "lane-1",
      laneName: "feature/work",
      toolType: "shell",
      runtimeState: "running",
      title: "Build logs"
    )
    let endedChat = makeTerminalSessionSummary(
      id: "chat-ended",
      laneId: "lane-1",
      laneName: "feature/work",
      toolType: "claude-chat",
      runtimeState: "stopped",
      status: "exited",
      title: "Wrapped up"
    )
    let chatSummaries = [
      "chat-waiting": makeAgentChatSessionSummary(
        sessionId: "chat-waiting",
        laneId: "lane-1",
        provider: "codex",
        model: "gpt-5.4",
        title: "Needs approval",
        status: "active",
        awaitingInput: true,
        lastActivityAt: "2026-03-25T00:00:03.000Z"
      ),
      "chat-ended": makeAgentChatSessionSummary(
        sessionId: "chat-ended",
        laneId: "lane-1",
        provider: "claude",
        model: "sonnet",
        title: "Wrapped up",
        status: "completed",
        lastActivityAt: "2026-03-25T00:00:04.000Z"
      ),
    ]

    let filtered = workFilteredSessions(
      [endedChat, activeTerminal, waitingChat],
      chatSummaries: chatSummaries,
      archivedSessionIds: [],
      selectedStatus: .all,
      selectedLaneId: "all",
      searchText: ""
    )

    XCTAssertEqual(filtered.map(\.id), ["chat-waiting", "terminal-active", "chat-ended"])
  }

  func testWorkTimelineHidesLocalEchoOnceTranscriptContainsSameUserMessage() {
    let prompt = "UI smoke test only. Reply exactly: mobile chat parity check."
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 1,
        event: .userMessage(text: prompt, turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
      ),
    ]
    let timeline = buildWorkTimeline(
      transcript: transcript,
      fallbackEntries: [],
      toolCards: [],
      commandCards: [],
      fileChangeCards: [],
      eventCards: [],
      artifacts: [],
      localEchoMessages: [
        WorkLocalEchoMessage(text: "\n\(prompt)  ", timestamp: "2026-03-25T00:00:01.000Z"),
        WorkLocalEchoMessage(text: "Still waiting for host acknowledgement", timestamp: "2026-03-25T00:00:03.000Z"),
      ]
    )
    let userMessages = timeline.compactMap { entry -> String? in
      guard case .message(let message) = entry.payload, message.role == "user" else { return nil }
      return message.markdown
    }

    XCTAssertEqual(userMessages, [prompt, "Still waiting for host acknowledgement"])
  }

  func testWorkTurnSeparatorsUsePerTurnModelAfterModelSwitch() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "say hi", turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .assistantText(text: "Hi", turnId: "turn-1", itemId: "msg-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:03.000Z",
        sequence: 3,
        event: .done(status: "completed", summary: "Completed\nclaude-sonnet-4-6", usage: nil, turnId: "turn-1", model: "claude-sonnet-4-6", modelId: "anthropic/claude-sonnet-4-6")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:01:01.000Z",
        sequence: 4,
        event: .userMessage(text: "say hi again", turnId: "turn-2", steerId: nil, deliveryState: nil, processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:01:02.000Z",
        sequence: 5,
        event: .assistantText(text: "Hi", turnId: "turn-2", itemId: "msg-2")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:01:03.000Z",
        sequence: 6,
        event: .done(status: "completed", summary: "Completed\ngpt-5.4-mini", usage: nil, turnId: "turn-2", model: "gpt-5.4-mini", modelId: "openai/gpt-5.4-mini-codex")
      ),
    ]
    let timeline = buildWorkTimeline(
      transcript: transcript,
      fallbackEntries: [],
      toolCards: [],
      commandCards: [],
      fileChangeCards: [],
      eventCards: [],
      artifacts: [],
      localEchoMessages: []
    )
    let assistantMessages = timeline.compactMap { entry -> WorkChatMessage? in
      guard case .message(let message) = entry.payload, message.role == "assistant" else { return nil }
      return message
    }
    XCTAssertEqual(assistantMessages.map(\.turnProvider), ["claude", "codex"])
    XCTAssertEqual(assistantMessages.map(\.turnModelId), ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4-mini-codex"])

    let separated = injectWorkTurnSeparators(
      into: timeline,
      chatSummary: makeAgentChatSessionSummary(provider: "codex", model: "gpt-5.4-mini", status: "active"),
      transcript: transcript
    )
    let separators = separated.compactMap { entry -> WorkTurnSeparator? in
      guard case .turnSeparator(let separator) = entry.payload else { return nil }
      return separator
    }

    XCTAssertEqual(separators.map(\.modelLabel), ["Claude Sonnet 4.6", "GPT 5.4 Mini"])
    XCTAssertEqual(separators.map(\.provider), ["claude", "codex"])
  }

  func testWorkEventCardsHideLowSignalLifecycleNoise() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:00.000Z",
        sequence: 0,
        event: .status(turnStatus: "started", message: nil, turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .reasoning(text: "Thinking through the answer", turnId: "turn-1", itemId: "reasoning-1", summaryIndex: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .activity(kind: "thinking", detail: "Thinking through the answer", turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:03.000Z",
        sequence: 3,
        event: .systemNotice(kind: "info", message: "Session ready", detail: nil, turnId: "turn-1", steerId: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:04.000Z",
        sequence: 4,
        event: .status(turnStatus: "completed", message: nil, turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:05.000Z",
        sequence: 5,
        event: .status(turnStatus: "failed", message: "Tool call failed", turnId: "turn-2")
      ),
    ]

    let cards = buildWorkEventCards(from: transcript)

    XCTAssertEqual(cards.map(\.kind), ["status"])
    XCTAssertEqual(cards.first?.body, "Tool call failed")
  }

  func testWorkSessionEmptyStateMessagingExplainsSearchAndArchiveFallbacks() {
    XCTAssertEqual(
      workSessionEmptyStateTitle(status: .all, searchText: "deploy", hasFilters: true),
      "No sessions match"
    )
    XCTAssertEqual(
      workSessionEmptyStateMessage(status: .all, searchText: "deploy", hasFilters: true, isLive: false),
      "Try a different search or clear the current filters."
    )
    XCTAssertEqual(
      workSessionEmptyStateTitle(status: .archived, searchText: "", hasFilters: false),
      "No archived sessions"
    )
    XCTAssertEqual(
      workSessionEmptyStateMessage(status: .archived, searchText: "", hasFilters: false, isLive: true),
      "Archived sessions stay here until you restore them."
    )
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

  func testWorkActivityBufferFingerprintStaysStableForIdenticalBuffers() {
    let bufferA = "hello\nworld\nrunning tool"
    let bufferB = "hello\nworld\nrunning tool"
    XCTAssertEqual(workActivityBufferFingerprint(bufferA), workActivityBufferFingerprint(bufferB))
  }

  func testWorkActivityBufferFingerprintChangesWhenBufferGrowsOrChanges() {
    let base = "hello world"
    let appended = base + " more content appended at the tail"
    let replaced = "HELLO world"

    XCTAssertNotEqual(workActivityBufferFingerprint(base), workActivityBufferFingerprint(appended))
    XCTAssertNotEqual(workActivityBufferFingerprint(base), workActivityBufferFingerprint(replaced))
    XCTAssertEqual(workActivityBufferFingerprint(""), "0:")
  }

  func testWorkActivityBufferFingerprintDistinguishesLongBuffersWithDifferentTails() {
    let head = String(repeating: "a", count: 1024)
    let bufferA = head + "tail-alpha"
    let bufferB = head + "tail-omega"
    // Lengths match, so only the fingerprint's tail-window distinguishes them.
    XCTAssertEqual(bufferA.count, bufferB.count)
    XCTAssertNotEqual(workActivityBufferFingerprint(bufferA), workActivityBufferFingerprint(bufferB))
  }

  func testBuildWorkActivityFeedReusesCachedTerminalTranscript() {
    let session = makeTerminalSessionSummary(toolType: "codex-chat", title: "Main chat")
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:01.000Z","sequence":1,"event":{"type":"subagent_started","taskId":"task-1","description":"Parsed helper"}}
    """
    let cachedTranscript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .subagentStarted(taskId: "task-1", description: "Cached helper", background: false, turnId: nil)
      )
    ]
    let fingerprint = workActivityBufferFingerprint(raw)

    let result = buildWorkActivityFeed(
      sources: [session],
      transcriptCache: [:],
      terminalBuffers: ["chat-1": raw],
      existingCache: ["chat-1": WorkActivityTranscriptCacheEntry(fingerprint: fingerprint, transcript: cachedTranscript)],
      chatSummaries: [:]
    )

    XCTAssertEqual(result.activities.first?.agentName, "Cached helper")
    XCTAssertEqual(result.cache["chat-1"]?.fingerprint, fingerprint)
  }

  // MARK: - Mobile PR snapshot (prs sync contracts)

  func testPrMobileSnapshotDecodesStackCapabilitiesAndWorkflowCards() throws {
    let json = """
    {
      "generatedAt": "2026-04-16T00:00:00Z",
      "prs": [
        {
          "id": "pr-root",
          "laneId": "lane-root",
          "projectId": "proj-1",
          "repoOwner": "owner",
          "repoName": "repo",
          "githubPrNumber": 1,
          "githubUrl": "https://github.com/owner/repo/pull/1",
          "githubNodeId": "PR_1",
          "title": "root",
          "state": "open",
          "baseBranch": "main",
          "headBranch": "feat/root",
          "checksStatus": "passing",
          "reviewStatus": "approved",
          "additions": 5,
          "deletions": 1,
          "lastSyncedAt": "2026-04-16T00:00:00Z",
          "createdAt": "2026-04-16T00:00:00Z",
          "updatedAt": "2026-04-16T00:00:00Z"
        }
      ],
      "stacks": [
        {
          "stackId": "stack:lane-root",
          "rootLaneId": "lane-root",
          "size": 2,
          "prCount": 2,
          "members": [
            {
              "laneId": "lane-root",
              "laneName": "root",
              "parentLaneId": null,
              "depth": 0,
              "role": "root",
              "dirty": false,
              "prId": "pr-root",
              "prNumber": 1,
              "prState": "open",
              "prTitle": "root",
              "baseBranch": "main",
              "headBranch": "feat/root",
              "checksStatus": "passing",
              "reviewStatus": "approved"
            },
            {
              "laneId": "lane-child",
              "laneName": "child",
              "parentLaneId": "lane-root",
              "depth": 1,
              "role": "leaf",
              "dirty": true,
              "prId": "pr-child",
              "prNumber": 2,
              "prState": "draft",
              "prTitle": "child",
              "baseBranch": "feat/root",
              "headBranch": "feat/child",
              "checksStatus": "failing",
              "reviewStatus": "none"
            }
          ]
        }
      ],
      "capabilities": {
        "pr-root": {
          "prId": "pr-root",
          "canOpenInGithub": true,
          "canMerge": true,
          "canClose": true,
          "canReopen": false,
          "canRequestReviewers": true,
          "canRerunChecks": true,
          "canComment": true,
          "canUpdateDescription": true,
          "canDelete": true,
          "mergeBlockedReason": null,
          "requiresLive": true
        },
        "pr-child": {
          "prId": "pr-child",
          "canOpenInGithub": true,
          "canMerge": false,
          "canClose": true,
          "canReopen": false,
          "canRequestReviewers": true,
          "canRerunChecks": true,
          "canComment": true,
          "canUpdateDescription": true,
          "canDelete": true,
          "mergeBlockedReason": "Draft PRs cannot be merged until marked ready for review.",
          "requiresLive": true
        }
      },
      "createCapabilities": {
        "canCreateAny": true,
        "defaultBaseBranch": "main",
        "lanes": [
          {
            "laneId": "lane-new",
            "laneName": "new",
            "parentLaneId": null,
            "repoOwner": null,
            "repoName": null,
            "defaultBaseBranch": "main",
            "defaultTitle": "new",
            "dirty": false,
            "commitsAheadOfBase": 0,
            "hasExistingPr": false,
            "canCreate": true,
            "blockedReason": null
          },
          {
            "laneId": "lane-blocked",
            "laneName": "blocked",
            "parentLaneId": null,
            "repoOwner": null,
            "repoName": null,
            "defaultBaseBranch": "main",
            "defaultTitle": "blocked",
            "dirty": false,
            "commitsAheadOfBase": 2,
            "hasExistingPr": true,
            "canCreate": false,
            "blockedReason": "Lane already has an open PR (#7)."
          }
        ]
      },
      "workflowCards": [
        {
          "kind": "queue",
          "id": "queue:q-1",
          "groupId": "group-1",
          "groupName": null,
          "targetBranch": null,
          "state": "landing",
          "activePrId": "pr-root",
          "currentPosition": 0,
          "totalEntries": 2,
          "waitReason": null,
          "lastError": null,
          "updatedAt": "2026-04-16T00:00:00Z"
        },
        {
          "kind": "integration",
          "id": "integration:prop-1",
          "proposalId": "prop-1",
          "title": "Integration 1",
          "baseBranch": "main",
          "overallOutcome": "clean",
          "status": "proposed",
          "laneCount": 2,
          "conflictLaneCount": 0,
          "workflowDisplayState": "active",
          "cleanupState": "none",
          "linkedPrId": null,
          "integrationLaneId": null,
          "createdAt": "2026-04-16T00:00:00Z"
        },
        {
          "kind": "rebase",
          "id": "rebase:lane-child",
          "laneId": "lane-child",
          "laneName": "child",
          "baseBranch": "main",
          "behindBy": 3,
          "conflictPredicted": false,
          "prId": "pr-child",
          "prNumber": 2,
          "dismissedAt": null,
          "deferredUntil": null
        }
      ],
      "live": true
    }
    """

    let data = Data(json.utf8)
    let decoder = JSONDecoder()
    let snapshot = try decoder.decode(PrMobileSnapshot.self, from: data)

    XCTAssertEqual(snapshot.generatedAt, "2026-04-16T00:00:00Z")
    XCTAssertTrue(snapshot.live)
    XCTAssertEqual(snapshot.prs.count, 1)
    XCTAssertEqual(snapshot.prs.first?.id, "pr-root")

    // Stacks
    XCTAssertEqual(snapshot.stacks.count, 1)
    let stack = snapshot.stacks[0]
    XCTAssertEqual(stack.rootLaneId, "lane-root")
    XCTAssertEqual(stack.members.count, 2)
    XCTAssertEqual(stack.members[0].role, "root")
    XCTAssertEqual(stack.members[0].depth, 0)
    XCTAssertEqual(stack.members[0].prNumber, 1)
    XCTAssertFalse(stack.members[0].dirty)
    XCTAssertEqual(stack.members[1].role, "leaf")
    XCTAssertEqual(stack.members[1].parentLaneId, "lane-root")
    XCTAssertTrue(stack.members[1].dirty)
    XCTAssertEqual(stack.members[1].checksStatus, "failing")

    // Capabilities
    XCTAssertNotNil(snapshot.capabilities["pr-root"])
    XCTAssertTrue(snapshot.capabilities["pr-root"]?.canMerge ?? false)
    XCTAssertNil(snapshot.capabilities["pr-root"]?.mergeBlockedReason ?? nil)
    XCTAssertFalse(snapshot.capabilities["pr-child"]?.canMerge ?? true)
    XCTAssertEqual(
      snapshot.capabilities["pr-child"]?.mergeBlockedReason,
      "Draft PRs cannot be merged until marked ready for review."
    )

    // Create capabilities
    XCTAssertTrue(snapshot.createCapabilities.canCreateAny)
    XCTAssertEqual(snapshot.createCapabilities.defaultBaseBranch, "main")
    XCTAssertEqual(snapshot.createCapabilities.lanes.count, 2)
    let blocked = snapshot.createCapabilities.lanes.first(where: { $0.laneId == "lane-blocked" })
    XCTAssertNotNil(blocked)
    XCTAssertFalse(blocked?.canCreate ?? true)
    XCTAssertTrue(blocked?.hasExistingPr ?? false)
    XCTAssertTrue((blocked?.blockedReason ?? "").contains("#7"))

    // Workflow cards — one of each kind, decoded through the discriminated union.
    XCTAssertEqual(snapshot.workflowCards.count, 3)
    let queueCard = snapshot.workflowCards.first(where: { $0.kind == "queue" })
    XCTAssertEqual(queueCard?.groupId, "group-1")
    XCTAssertEqual(queueCard?.totalEntries, 2)
    XCTAssertEqual(queueCard?.activePrId, "pr-root")

    let integrationCard = snapshot.workflowCards.first(where: { $0.kind == "integration" })
    XCTAssertEqual(integrationCard?.proposalId, "prop-1")
    XCTAssertEqual(integrationCard?.overallOutcome, "clean")
    XCTAssertEqual(integrationCard?.integrationStatus, "proposed")

    let rebaseCard = snapshot.workflowCards.first(where: { $0.kind == "rebase" })
    XCTAssertEqual(rebaseCard?.laneId, "lane-child")
    XCTAssertEqual(rebaseCard?.behindBy, 3)
    XCTAssertEqual(rebaseCard?.prNumber, 2)
    XCTAssertNil(rebaseCard?.dismissedAt ?? nil)
  }

  func testPrMobileSnapshotTolerantOfEmptyHostState() throws {
    let json = """
    {
      "generatedAt": "2026-04-16T00:00:00Z",
      "prs": [],
      "stacks": [],
      "capabilities": {},
      "createCapabilities": {
        "canCreateAny": false,
        "defaultBaseBranch": null,
        "lanes": []
      },
      "workflowCards": [],
      "live": true
    }
    """

    let snapshot = try JSONDecoder().decode(PrMobileSnapshot.self, from: Data(json.utf8))
    XCTAssertTrue(snapshot.prs.isEmpty)
    XCTAssertTrue(snapshot.stacks.isEmpty)
    XCTAssertTrue(snapshot.capabilities.isEmpty)
    XCTAssertTrue(snapshot.workflowCards.isEmpty)
    XCTAssertFalse(snapshot.createCapabilities.canCreateAny)
    XCTAssertNil(snapshot.createCapabilities.defaultBaseBranch)
  }

  func testPrCreateCapabilitiesPreserveUnknownLegacyAheadCount() throws {
    let json = """
    {
      "canCreateAny": true,
      "defaultBaseBranch": "main",
      "lanes": [
        {
          "laneId": "lane-legacy",
          "laneName": "legacy",
          "parentLaneId": null,
          "repoOwner": null,
          "repoName": null,
          "defaultBaseBranch": "main",
          "defaultTitle": "legacy",
          "dirty": false,
          "hasExistingPr": false,
          "canCreate": true,
          "blockedReason": null
        }
      ]
    }
    """

    let capabilities = try JSONDecoder().decode(PrCreateCapabilities.self, from: Data(json.utf8))
    XCTAssertEqual(capabilities.lanes.first?.laneId, "lane-legacy")
    XCTAssertNil(capabilities.lanes.first?.commitsAheadOfBase)
  }

  func testPrActionCapabilitiesGateMergeAndSurfaceBlockedReason() {
    let capabilitiesAllow = PrActionCapabilities(
      prId: "pr-1",
      canOpenInGithub: true,
      canMerge: true,
      canClose: true,
      canReopen: false,
      canRequestReviewers: true,
      canRerunChecks: true,
      canComment: true,
      canUpdateDescription: true,
      canDelete: true,
      mergeBlockedReason: nil,
      requiresLive: true
    )

    let capabilitiesBlock = PrActionCapabilities(
      prId: "pr-1",
      canOpenInGithub: true,
      canMerge: false,
      canClose: true,
      canReopen: false,
      canRequestReviewers: true,
      canRerunChecks: true,
      canComment: true,
      canUpdateDescription: true,
      canDelete: true,
      mergeBlockedReason: "Required checks are failing.",
      requiresLive: true
    )

    XCTAssertTrue(capabilitiesAllow.canMerge)
    XCTAssertNil(capabilitiesAllow.mergeBlockedReason)
    XCTAssertFalse(capabilitiesBlock.canMerge)
    XCTAssertEqual(capabilitiesBlock.mergeBlockedReason, "Required checks are failing.")

    // When capabilities drive the view, canMerge=false must short-circuit
    // regardless of the legacy PrActionAvailability state.
    let availabilityForOpen = PrActionAvailability(prState: "open")
    XCTAssertTrue(availabilityForOpen.showsMerge)
    XCTAssertTrue(availabilityForOpen.mergeEnabled)

    // Emulate the derivation used in PrOverviewTab.
    let mergeable = true
    let effectiveMergeEnabled = capabilitiesBlock.canMerge && mergeable
    XCTAssertFalse(effectiveMergeEnabled)
  }

  func testPrCreateCapabilitiesFilterEligibleLanesAndKeepBlockedVisible() {
    let eligible = PrCreateLaneEligibility(
      laneId: "lane-new",
      laneName: "feat/new",
      parentLaneId: nil,
      repoOwner: nil,
      repoName: nil,
      defaultBaseBranch: "main",
      defaultTitle: "feat/new",
      dirty: false,
      commitsAheadOfBase: 1,
      hasExistingPr: false,
      canCreate: true,
      blockedReason: nil
    )
    let blocked = PrCreateLaneEligibility(
      laneId: "lane-blocked",
      laneName: "feat/blocked",
      parentLaneId: nil,
      repoOwner: nil,
      repoName: nil,
      defaultBaseBranch: "main",
      defaultTitle: "feat/blocked",
      dirty: false,
      commitsAheadOfBase: 0,
      hasExistingPr: true,
      canCreate: false,
      blockedReason: "Lane already has an open PR (#12)."
    )
    let capabilities = PrCreateCapabilities(
      canCreateAny: true,
      defaultBaseBranch: "main",
      lanes: [eligible, blocked]
    )

    XCTAssertTrue(capabilities.canCreateAny)
    let eligibleOnly = capabilities.lanes.filter { $0.canCreate }
    XCTAssertEqual(eligibleOnly.map(\.laneId), ["lane-new"])
    let blockedOnly = capabilities.lanes.filter { !$0.canCreate }
    XCTAssertEqual(blockedOnly.first?.blockedReason, "Lane already has an open PR (#12).")
    XCTAssertEqual(capabilities.defaultBaseBranch, "main")
  }

  func testBuildStackRowsJoinsGroupMembersAndSnapshotDirtyFlags() {
    let members: [PrGroupMemberSummary] = [
      PrGroupMemberSummary(
        groupId: "g1", groupType: "stack", groupName: nil, targetBranch: "main",
        prId: "pr-root", laneId: "lane-root", laneName: "root",
        title: "Root PR", state: "open", githubPrNumber: 1,
        githubUrl: "https://github.com/o/r/pull/1",
        baseBranch: "main", headBranch: "feat/root", position: 0
      ),
      PrGroupMemberSummary(
        groupId: "g1", groupType: "stack", groupName: nil, targetBranch: "main",
        prId: "pr-mid", laneId: "lane-mid", laneName: "middle",
        title: "Middle PR", state: "draft", githubPrNumber: 2,
        githubUrl: "https://github.com/o/r/pull/2",
        baseBranch: "feat/root", headBranch: "feat/mid", position: 1
      ),
      PrGroupMemberSummary(
        groupId: "g1", groupType: "stack", groupName: nil, targetBranch: "main",
        prId: "pr-leaf", laneId: "lane-leaf", laneName: "leaf",
        title: "Leaf PR", state: "open", githubPrNumber: 3,
        githubUrl: "https://github.com/o/r/pull/3",
        baseBranch: "feat/mid", headBranch: "feat/leaf", position: 2
      ),
    ]

    let stack = PrStackInfo(
      stackId: "stack:lane-root",
      rootLaneId: "lane-root",
      members: [
        PrStackMember(laneId: "lane-root", laneName: "root", parentLaneId: nil,
                      depth: 0, role: "root", dirty: false,
                      prId: "pr-root", prNumber: 1, prState: "open",
                      prTitle: "Root PR", baseBranch: "main", headBranch: "feat/root",
                      checksStatus: "passing", reviewStatus: "approved"),
        PrStackMember(laneId: "lane-mid", laneName: "middle", parentLaneId: "lane-root",
                      depth: 1, role: "middle", dirty: true,
                      prId: "pr-mid", prNumber: 2, prState: "draft",
                      prTitle: "Middle PR", baseBranch: "feat/root", headBranch: "feat/mid",
                      checksStatus: "none", reviewStatus: "none"),
        PrStackMember(laneId: "lane-leaf", laneName: "leaf", parentLaneId: "lane-mid",
                      depth: 2, role: "leaf", dirty: false,
                      prId: "pr-leaf", prNumber: 3, prState: "open",
                      prTitle: "Leaf PR", baseBranch: "feat/mid", headBranch: "feat/leaf",
                      checksStatus: "passing", reviewStatus: "none"),
      ],
      size: 3,
      prCount: 3
    )

    let rows = buildStackRows(members: members, stackInfo: stack)
    XCTAssertEqual(rows.map(\.laneId), ["lane-root", "lane-mid", "lane-leaf"])
    XCTAssertEqual(rows[0].role, .base)
    XCTAssertEqual(rows[1].role, .body)
    XCTAssertEqual(rows[2].role, .head)
    XCTAssertEqual(rows[0].depth, 0)
    XCTAssertEqual(rows[1].depth, 1)
    XCTAssertEqual(rows[2].depth, 2)
    XCTAssertFalse(rows[0].dirty)
    XCTAssertTrue(rows[1].dirty)
    XCTAssertFalse(rows[2].dirty)
    XCTAssertEqual(rows[0].prId, "pr-root")
  }

  func testBuildStackRowsFallsBackToPositionDepthWhenSnapshotMissing() {
    let members: [PrGroupMemberSummary] = [
      PrGroupMemberSummary(
        groupId: "g1", groupType: "stack", groupName: nil, targetBranch: "main",
        prId: "pr-1", laneId: "lane-1", laneName: "one",
        title: "One", state: "open", githubPrNumber: 1,
        githubUrl: "https://github.com/o/r/pull/1",
        baseBranch: "main", headBranch: "feat/1", position: 0
      ),
      PrGroupMemberSummary(
        groupId: "g1", groupType: "stack", groupName: nil, targetBranch: "main",
        prId: "pr-2", laneId: "lane-2", laneName: "two",
        title: "Two", state: "open", githubPrNumber: 2,
        githubUrl: "https://github.com/o/r/pull/2",
        baseBranch: "feat/1", headBranch: "feat/2", position: 1
      ),
    ]

    let rows = buildStackRows(members: members, stackInfo: nil)
    XCTAssertEqual(rows.count, 2)
    XCTAssertEqual(rows[0].role, .base)
    XCTAssertEqual(rows[1].role, .head)
    XCTAssertFalse(rows[0].dirty)
    XCTAssertFalse(rows[1].dirty)
    XCTAssertEqual(rows[0].depth, 0)
    XCTAssertEqual(rows[1].depth, 1)
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

  private func makeProjectLaneForeignKeyDatabase(baseURL: URL) -> DatabaseService {
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
        archived_at text,
        foreign key(project_id) references projects(id)
      );
    """)
  }

  private func makeTerminalSessionSyncDatabase(baseURL: URL) -> DatabaseService {
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
        archived_at text,
        foreign key(project_id) references projects(id)
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
        resume_command text,
        resume_metadata_json text,
        manually_named integer not null default 0,
        foreign key(lane_id) references lanes(id)
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

  private func tableExists(in baseURL: URL, table: String) throws -> Bool {
    let dbURL = baseURL.appendingPathComponent("ADE", isDirectory: true).appendingPathComponent("ade.db")
    var handle: OpaquePointer?
    XCTAssertEqual(sqlite3_open(dbURL.path, &handle), SQLITE_OK)
    defer { sqlite3_close(handle) }

    var statement: OpaquePointer?
    XCTAssertEqual(
      sqlite3_prepare_v2(handle, "select 1 from sqlite_master where type = 'table' and name = ? limit 1", -1, &statement, nil),
      SQLITE_OK
    )
    defer { sqlite3_finalize(statement) }
    sqlite3_bind_text(statement, 1, (table as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
    return sqlite3_step(statement) == SQLITE_ROW
  }

  private struct DummyHydrationPayload: Decodable {
    let refreshedCount: Int
  }

  private func makeAgentChatSessionSummary(
    sessionId: String = "chat-1",
    laneId: String = "lane-1",
    provider: String = "codex",
    model: String = "gpt-5.4",
    title: String? = nil,
    status: String,
    awaitingInput: Bool? = nil,
    lastActivityAt: String = "2026-03-25T00:00:00.000Z"
  ) -> AgentChatSessionSummary {
    AgentChatSessionSummary(
      sessionId: sessionId,
      laneId: laneId,
      provider: provider,
      model: model,
      modelId: nil,
      sessionProfile: nil,
      title: title,
      goal: nil,
      reasoningEffort: nil,
      executionMode: nil,
      permissionMode: nil,
      interactionMode: nil,
      claudePermissionMode: nil,
      codexApprovalPolicy: nil,
      codexSandbox: nil,
      codexConfigSource: nil,
      opencodePermissionMode: nil,
      cursorModeSnapshot: nil,
      cursorModeId: nil,
      cursorConfigValues: nil,
      identityKey: nil,
      surface: nil,
      automationId: nil,
      automationRunId: nil,
      capabilityMode: nil,
      computerUse: nil,
      completion: nil,
      status: status,
      idleSinceAt: nil,
      startedAt: "2026-03-25T00:00:00.000Z",
      endedAt: nil,
      lastActivityAt: lastActivityAt,
      lastOutputPreview: nil,
      summary: nil,
      awaitingInput: awaitingInput,
      threadId: nil,
      requestedCwd: nil
    )
  }

  private func makeTerminalSessionSummary(
    id: String = "chat-1",
    laneId: String = "lane-1",
    laneName: String = "feature/work",
    toolType: String?,
    runtimeState: String = "running",
    status: String = "running",
    title: String = "Codex chat",
    lastOutputPreview: String? = nil
  ) -> TerminalSessionSummary {
    TerminalSessionSummary(
      id: id,
      laneId: laneId,
      laneName: laneName,
      ptyId: nil,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: nil,
      toolType: toolType,
      title: title,
      status: status,
      startedAt: "2026-03-25T00:00:00.000Z",
      endedAt: nil,
      exitCode: nil,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: lastOutputPreview,
      summary: nil,
      runtimeState: runtimeState,
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: nil
    )
  }

  private func jsonDictionary<T: Encodable>(from value: T) throws -> [String: Any] {
    let data = try JSONEncoder().encode(value)
    let raw = try JSONSerialization.jsonObject(with: data, options: [])
    guard let dict = raw as? [String: Any] else {
      throw NSError(domain: "ADETests", code: 1, userInfo: [NSLocalizedDescriptionKey: "Expected dictionary JSON payload."])
    }
    return dict
  }

  // MARK: - Chat polish helpers (Task #14)

  func testWorkToolResultPreviewReturnsFirstNonEmptyLine() {
    XCTAssertNil(workToolResultPreview(nil))
    XCTAssertNil(workToolResultPreview(""))
    XCTAssertEqual(workToolResultPreview("   \n\nHello\nWorld"), "Hello")
    XCTAssertEqual(workToolResultPreview("  padded line  "), "padded line")
  }

  func testWorkToolResultTruncateShortTextIsUntouched() {
    let short = String(repeating: "a", count: workToolResultTruncateLimit)
    let (text, didTruncate) = workToolResultTruncate(short, expanded: false)
    XCTAssertEqual(text, short)
    XCTAssertFalse(didTruncate)
  }

  func testWorkToolResultTruncateLongTextIsTrimmedWithEllipsis() {
    let long = String(repeating: "a", count: workToolResultTruncateLimit + 100)
    let (text, didTruncate) = workToolResultTruncate(long, expanded: false)
    XCTAssertTrue(didTruncate)
    XCTAssertEqual(text.count, workToolResultTruncateLimit + 1)  // +1 for the ellipsis
    XCTAssertTrue(text.hasSuffix("…"))
  }

  func testWorkToolResultTruncateExpandedReturnsFullText() {
    let long = String(repeating: "a", count: workToolResultTruncateLimit + 100)
    let (text, didTruncate) = workToolResultTruncate(long, expanded: true)
    XCTAssertEqual(text, long)
    XCTAssertFalse(didTruncate)
  }

  func testWorkToolResultByteLabelFormatsSmallAndLargeCounts() {
    XCTAssertEqual(workToolResultByteLabel(String(repeating: "a", count: 450)), "450 chars")
    XCTAssertEqual(workToolResultByteLabel(String(repeating: "a", count: 1800)), "1.8k chars")
  }

  func testWorkContextCompactSummaryParsesAutoAndTokens() {
    let parsed = WorkContextCompactSummary.parse("auto compact freed ~12,400 tokens")
    XCTAssertEqual(parsed.triggerLabel, "AUTO")
    XCTAssertEqual(parsed.tokensFreedLabel, "~12k tokens freed")
  }

  func testWorkContextCompactSummaryParsesManualTriggerWithoutTokens() {
    let parsed = WorkContextCompactSummary.parse("Manual compaction ran")
    XCTAssertEqual(parsed.triggerLabel, "MANUAL")
    XCTAssertNil(parsed.tokensFreedLabel)
  }

  func testWorkContextCompactSummaryEmptyInputReturnsDefaults() {
    let parsed = WorkContextCompactSummary.parse(nil)
    XCTAssertNil(parsed.triggerLabel)
    XCTAssertNil(parsed.tokensFreedLabel)
  }

  // MARK: - Timeline dedup + ask_user regression tests

  func testBuildWorkToolCardsDedupesDuplicateToolCallsByItemId() {
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .toolCall(tool: "Read", argsText: "{}", itemId: "call-dup", parentItemId: nil, turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 2,
        event: .toolCall(tool: "Read", argsText: "{\"path\":\"README.md\"}", itemId: "call-dup", parentItemId: nil, turnId: "turn-1")
      ),
    ]

    let cards = buildWorkToolCards(from: transcript)
    XCTAssertEqual(cards.count, 1)
    XCTAssertEqual(cards.first?.id, "call-dup")

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    let toolEntries = snapshot.timeline.filter { $0.id.hasPrefix("tool-") }
    XCTAssertEqual(toolEntries.count, 1)
    XCTAssertEqual(toolEntries.first?.id, "tool-call-dup")
  }

  func testWorkChatToolLifecycleUsesLogicalItemIdForStableCards() {
    let call = makeWorkChatEvent(from: .toolCall(
      tool: "functions.exec_command",
      args: .object(["cmd": .string("pwd")]),
      itemId: "tool-start-1",
      logicalItemId: "tool-logical-1",
      parentItemId: nil,
      turnId: "turn-1"
    ))
    let result = makeWorkChatEvent(from: .toolResult(
      tool: "functions.exec_command",
      result: .object(["stdout": .string("/tmp/project")]),
      itemId: "tool-result-1",
      logicalItemId: "tool-logical-1",
      parentItemId: nil,
      turnId: "turn-1",
      status: "completed"
    ))

    let transcript = [
      WorkChatEnvelope(sessionId: "chat-1", timestamp: "2026-04-20T00:00:01.000Z", sequence: 1, event: call),
      WorkChatEnvelope(sessionId: "chat-1", timestamp: "2026-04-20T00:00:02.000Z", sequence: 2, event: result),
    ]
    let cards = buildWorkToolCards(from: transcript)

    XCTAssertEqual(cards.count, 1)
    XCTAssertEqual(cards.first?.id, "tool-logical-1")
    XCTAssertEqual(cards.first?.status, .completed)
    XCTAssertNotNil(cards.first?.argsText)
    XCTAssertNotNil(cards.first?.resultText)
  }

  func testParseWorkChatTranscriptUsesLogicalItemIdForStableToolCards() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-04-20T00:00:01.000Z","sequence":1,"event":{"type":"tool_call","tool":"functions.exec_command","args":{"cmd":"pwd"},"itemId":"tool-start-1","logicalItemId":"tool-logical-1","turnId":"turn-1"}}
    {"sessionId":"chat-1","timestamp":"2026-04-20T00:00:02.000Z","sequence":2,"event":{"type":"tool_result","tool":"functions.exec_command","result":{"stdout":"/tmp/project"},"itemId":"tool-result-1","logicalItemId":"tool-logical-1","turnId":"turn-1","status":"completed"}}
    """
    let transcript = parseWorkChatTranscript(raw)
    let cards = buildWorkToolCards(from: transcript)

    XCTAssertEqual(cards.count, 1)
    XCTAssertEqual(cards.first?.id, "tool-logical-1")
    XCTAssertEqual(cards.first?.status, .completed)
  }

  func testBuildWorkTimelineCollapsesConsecutiveToolCardsIntoLatestGroup() {
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .toolCall(tool: "functions.Read", argsText: "{\"path\":\"README.md\"}", itemId: "tool-1", parentItemId: nil, turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 2,
        event: .toolResult(tool: "functions.Read", resultText: "{\"content\":\"ADE\"}", itemId: "tool-1", parentItemId: nil, turnId: "turn-1", status: .completed)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:03.000Z",
        sequence: 3,
        event: .toolCall(tool: "functions.exec_command", argsText: "{\"cmd\":\"npm test\"}", itemId: "tool-2", parentItemId: nil, turnId: "turn-1")
      ),
    ]
    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )

    let toolGroups = snapshot.timeline.compactMap { entry -> WorkToolGroupModel? in
      guard case .toolGroup(let group) = entry.payload else { return nil }
      return group
    }
    let standaloneToolCards = snapshot.timeline.compactMap { entry -> WorkToolCardModel? in
      guard case .toolCard(let card) = entry.payload else { return nil }
      return card
    }

    XCTAssertEqual(toolGroups.count, 1)
    XCTAssertEqual(toolGroups.first?.members.count, 2)
    XCTAssertTrue(standaloneToolCards.isEmpty)
    guard case .tool(let latest)? = toolGroups.first?.latest else {
      return XCTFail("Expected the latest visible group member to be the newest tool call.")
    }
    XCTAssertEqual(latest.id, "tool-2")
    XCTAssertEqual(latest.status, .running)
  }

  func testBuildWorkCommandCardsDedupesDuplicateCommandEventsByItemId() {
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .command(
          command: "ls",
          cwd: "/tmp",
          output: "",
          status: .running,
          itemId: "cmd-dup",
          exitCode: nil,
          durationMs: nil,
          turnId: "turn-1"
        )
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 2,
        event: .command(
          command: "ls",
          cwd: "/tmp",
          output: "README.md",
          status: .completed,
          itemId: "cmd-dup",
          exitCode: 0,
          durationMs: 12,
          turnId: "turn-1"
        )
      ),
    ]

    let cards = buildWorkCommandCards(from: transcript)
    XCTAssertEqual(cards.count, 1)
    XCTAssertEqual(cards.first?.status, .completed)
  }

  func testPendingWorkQuestionFromApprovalPopulatesNestedStructuredQuestionFields() {
    let detail = """
    {
      "request": {
        "itemId": "approval-rich",
        "kind": "structured_question",
        "title": "Which surface should I inspect?",
        "description": "The transcript has multiple affected surfaces.",
        "impact": "Only the chosen surface is rebuilt.",
        "defaultAssumption": "Desktop",
        "questions": [
          {
            "id": "surface",
            "question": "Pick a surface",
            "allowsFreeform": false,
            "multiSelect": false,
            "isSecret": false,
            "impact": "Rebuild scope",
            "options": [
              {
                "label": "Mobile",
                "value": "mobile",
                "description": "iOS and Android cards.",
                "recommended": true,
                "preview": "## Mobile plan\\n- iOS\\n- Android",
                "previewFormat": "markdown"
              },
              {
                "label": "Desktop",
                "value": "desktop"
              }
            ]
          }
        ]
      }
    }
    """

    let model = pendingWorkQuestionFromApproval(
      description: "Which surface should I inspect?",
      detail: detail,
      itemId: "approval-rich"
    )

    guard let model else {
      return XCTFail("Expected a populated pending question model.")
    }
    XCTAssertEqual(model.id, "approval-rich")
    XCTAssertEqual(model.questionId, "surface")
    XCTAssertEqual(model.title, "Which surface should I inspect?")
    XCTAssertEqual(model.impact, "Rebuild scope")
    XCTAssertEqual(model.defaultAssumption, "Desktop")
    XCTAssertFalse(model.multiSelect)
    XCTAssertFalse(model.isSecret)
    XCTAssertFalse(model.allowsFreeform)
    XCTAssertEqual(model.options.count, 2)

    let first = model.options[0]
    XCTAssertEqual(first.label, "Mobile")
    XCTAssertEqual(first.value, "mobile")
    XCTAssertEqual(first.description, "iOS and Android cards.")
    XCTAssertTrue(first.recommended)
    XCTAssertEqual(first.previewFormat, "markdown")
    XCTAssertEqual(first.preview, "## Mobile plan\n- iOS\n- Android")

    let second = model.options[1]
    XCTAssertEqual(second.label, "Desktop")
    XCTAssertEqual(second.value, "desktop")
    XCTAssertFalse(second.recommended)
    XCTAssertNil(second.preview)
  }

  func testPendingWorkPermissionFromApprovalReturnsCardForGenericTools() {
    let detail = """
    {
      "request": {
        "itemId": "perm-1",
        "kind": "permissions",
        "tool": "functions.GitHub",
        "description": "Allow GitHub MCP to list repos?"
      }
    }
    """
    let permission = pendingWorkPermissionFromApproval(
      description: "Allow GitHub MCP",
      detail: detail,
      itemId: "perm-1"
    )
    XCTAssertEqual(permission?.id, "perm-1")
    XCTAssertEqual(permission?.tool, "functions.GitHub")
  }

  func testPendingWorkPermissionFromApprovalSkipsAskUser() {
    let detail = """
    {
      "request": {
        "itemId": "perm-ask",
        "kind": "permissions",
        "tool": "ask_user",
        "description": "Allow ask_user"
      }
    }
    """
    let permission = pendingWorkPermissionFromApproval(
      description: "Allow ask_user",
      detail: detail,
      itemId: "perm-ask"
    )
    XCTAssertNil(permission)
  }

  func testPendingWorkQuestionFromAskUserToolCallParsesArgsPayload() {
    let argsText = """
    {
      "questions": [
        {
          "id": "focus",
          "question": "Which lane first?",
          "allowsFreeform": false,
          "options": [
            { "label": "Mobile", "value": "mobile", "recommended": true },
            { "label": "Desktop", "value": "desktop" }
          ]
        }
      ]
    }
    """
    let model = pendingWorkQuestionFromAskUserToolCall(argsText: argsText, itemId: "call-1")
    XCTAssertEqual(model?.questionId, "focus")
    XCTAssertEqual(model?.options.count, 2)
    XCTAssertEqual(model?.options.first?.recommended, true)
  }

  func testDerivePendingWorkInputsSurfacesAskUserRawToolCallAsQuestion() {
    let argsText = """
    {"questions":[{"id":"focus","question":"Pick one","options":[{"label":"A","value":"a"}]}]}
    """
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .toolCall(tool: "ask_user", argsText: argsText, itemId: "call-ask", parentItemId: nil, turnId: "turn-1")
      ),
    ]
    let inputs = derivePendingWorkInputs(from: transcript)
    guard case .question(let model) = inputs.first else {
      return XCTFail("Expected ask_user raw tool_call to surface as a pending question.")
    }
    XCTAssertEqual(model.id, "call-ask")
    XCTAssertEqual(model.questionId, "focus")
    XCTAssertEqual(model.options.map(\.value), ["a"])

    // The generic tool card should be suppressed while the question is pending.
    let cards = buildWorkToolCards(from: transcript)
    XCTAssertTrue(cards.isEmpty)
  }

  func testDerivePendingWorkInputsSurfacesRequestUserInputRawToolCallAsQuestion() {
    let argsText = """
    {"questions":[{"id":"scope","question":"Pick scope","options":[{"label":"iOS","value":"ios"}]}]}
    """
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .toolCall(tool: "mcp_ade_request_user_input", argsText: argsText, itemId: "call-request-input", parentItemId: nil, turnId: "turn-1")
      ),
    ]
    let inputs = derivePendingWorkInputs(from: transcript)
    guard case .question(let model) = inputs.first else {
      return XCTFail("Expected request_user_input tool_call to surface as a pending question.")
    }
    XCTAssertEqual(model.id, "call-request-input")
    XCTAssertEqual(model.questionId, "scope")
    XCTAssertEqual(model.options.map(\.value), ["ios"])

    let cards = buildWorkToolCards(from: transcript)
    XCTAssertTrue(cards.isEmpty)
  }

  func testPendingWorkQuestionFromApprovalPreservesAllQuestions() {
    let detail = """
    {
      "request": {
        "itemId": "approval-multi",
        "kind": "structured_question",
        "title": "Mobile App Testing Plan",
        "body": "Claude needs a few answers before it can continue.",
        "questions": [
          {
            "id": "test_focus",
            "header": "Test focus",
            "question": "What are you testing on the mobile app right now?",
            "allowsFreeform": true,
            "options": [
              {"label":"Chat / Messaging","value":"chat","description":"Testing the chat composer, message sending, or conversation flow"},
              {"label":"Lanes / Missions","value":"lanes","description":"Testing lane creation, mission management, or task flow"},
              {"label":"Sync / Connectivity","value":"sync","description":"Testing device sync, WebSocket connection, or host pairing"},
              {"label":"Something else","value":"other","description":"A different part of the app not listed above"}
            ]
          },
          {
            "id": "help_type",
            "header": "Help type",
            "question": "What kind of help do you need from me?",
            "allowsFreeform": true,
            "options": [
              {"label":"Fix a bug I found","value":"fix_bug","description":"I found an issue and want you to diagnose and fix it"},
              {"label":"Review the code","value":"review","description":"Walk me through how a specific feature is implemented"},
              {"label":"Add a feature","value":"add_feature","description":"I want to extend or improve something in the mobile app"},
              {"label":"Just exploring","value":"explore","description":"No specific task yet — I'll share more as I test"}
            ]
          }
        ]
      }
    }
    """

    guard let model = pendingWorkQuestionFromApproval(
      description: "Mobile App Testing Plan",
      detail: detail,
      itemId: "approval-multi"
    ) else {
      return XCTFail("Expected a populated pending question model for a 2-question payload.")
    }
    XCTAssertEqual(model.id, "approval-multi")
    XCTAssertEqual(model.title, "Mobile App Testing Plan")
    XCTAssertEqual(model.questions.count, 2)
    XCTAssertEqual(model.questions[0].questionId, "test_focus")
    XCTAssertEqual(model.questions[0].header, "Test focus")
    XCTAssertEqual(model.questions[0].options.count, 4)
    XCTAssertEqual(model.questions[0].options.map(\.value), ["chat", "lanes", "sync", "other"])
    XCTAssertEqual(model.questions[1].questionId, "help_type")
    XCTAssertEqual(model.questions[1].header, "Help type")
    XCTAssertEqual(model.questions[1].options.count, 4)
    XCTAssertEqual(model.questions[1].options.map(\.value), ["fix_bug", "review", "add_feature", "explore"])
  }

  func testPendingWorkQuestionFromAskUserToolCallPreservesAllQuestions() {
    let argsText = """
    {
      "questions": [
        {"id": "a", "question": "First?", "options": [{"label":"Yes","value":"yes"}]},
        {"id": "b", "question": "Second?", "options": [{"label":"No","value":"no"}]}
      ]
    }
    """
    guard let model = pendingWorkQuestionFromAskUserToolCall(argsText: argsText, itemId: "call-two") else {
      return XCTFail("Expected a populated pending question model for multi-question args.")
    }
    XCTAssertEqual(model.questions.count, 2)
    XCTAssertEqual(model.questions[0].questionId, "a")
    XCTAssertEqual(model.questions[1].questionId, "b")
  }

  func testBuildWorkTimelineEmitsInlinePendingQuestionAndSuppressesGenericApprovalCard() {
    let detail = """
    {"request":{"itemId":"ap-1","kind":"structured_question","title":"T","questions":[{"id":"q","question":"Q","options":[{"label":"A","value":"a"}]}]}}
    """
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .assistantText(text: "Before", turnId: "t-1", itemId: "msg-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 2,
        event: .approvalRequest(description: "Choose", detail: detail, itemId: "ap-1", turnId: "t-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:03.000Z",
        sequence: 3,
        event: .assistantText(text: "After", turnId: "t-1", itemId: "msg-2")
      ),
    ]
    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )

    XCTAssertTrue(snapshot.eventCards.allSatisfy { $0.kind != "approval" }, "Generic approval event card must be suppressed when a pending rich question exists for the same itemId.")

    let pendingEntry = snapshot.timeline.first { entry in
      if case .pendingQuestion(let model) = entry.payload, model.id == "ap-1" { return true }
      return false
    }
    guard let pendingEntry else {
      return XCTFail("Expected a .pendingQuestion timeline entry for itemId ap-1.")
    }
    XCTAssertEqual(pendingEntry.timestamp, "2026-04-20T00:00:02.000Z")

    // Chronological: Before (t=01) → pendingQuestion (t=02) → After (t=03).
    let indices = snapshot.timeline.compactMap { entry -> (String, String)? in
      switch entry.payload {
      case .message(let msg): return (msg.id, entry.timestamp)
      case .pendingQuestion(let m): return ("pending-\(m.id)", entry.timestamp)
      default: return nil
      }
    }
    let timestamps = indices.map(\.1)
    XCTAssertEqual(timestamps, timestamps.sorted(), "Timeline must sort chronologically.")
  }

  func testBuildWorkTimelineEmitsInlinePermissionAndSuppressesGenericEventCard() {
    let detail = """
    {"request":{"itemId":"perm-1","kind":"permissions","tool":"functions.GitHub","description":"Allow GitHub MCP"}}
    """
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .approvalRequest(description: "Allow", detail: detail, itemId: "perm-1", turnId: "t-1")
      ),
    ]
    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    XCTAssertTrue(snapshot.eventCards.allSatisfy { $0.kind != "approval" })
    let hasPendingPermission = snapshot.timeline.contains { entry in
      if case .pendingPermission(let m) = entry.payload, m.id == "perm-1" { return true }
      return false
    }
    XCTAssertTrue(hasPendingPermission, "Expected an inline .pendingPermission timeline entry.")
  }

  func testBuildWorkTimelineSuppressesRawToolCardWhenPermissionRequestIsPending() {
    let detail = """
    {"request":{"itemId":"perm-1","kind":"permissions","tool":"functions.GitHub","description":"Allow GitHub MCP"}}
    """
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .toolCall(tool: "functions.GitHub", argsText: "{\"repo\":\"ade\"}", itemId: "perm-1", parentItemId: nil, turnId: "t-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 2,
        event: .approvalRequest(description: "Allow", detail: detail, itemId: "perm-1", turnId: "t-1")
      ),
    ]
    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )

    XCTAssertTrue(snapshot.toolCards.isEmpty, "Pending permission should suppress duplicate raw tool cards.")
    let hasPendingPermission = snapshot.timeline.contains { entry in
      if case .pendingPermission(let model) = entry.payload, model.id == "perm-1" { return true }
      return false
    }
    XCTAssertTrue(hasPendingPermission)
  }

  func testBuildWorkTimelineSuppressesGenericApprovalEventWhilePending() {
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .approvalRequest(description: "Approve shell command?", detail: nil, itemId: "approval-1", turnId: "t-1")
      ),
    ]

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )

    XCTAssertEqual(snapshot.pendingInputs.count, 1)
    guard case .approval(let approval) = snapshot.pendingInputs[0] else {
      return XCTFail("Expected generic approval to remain in pendingInputs.")
    }
    XCTAssertEqual(approval.id, "approval-1")
    XCTAssertTrue(snapshot.eventCards.allSatisfy { $0.kind != "approval" })
  }

  func testSingleQuestionModelStillExposesLegacyFieldsForUnpagedRender() {
    let detail = """
    {"request":{"itemId":"one","kind":"structured_question","title":"T","questions":[{"id":"only","question":"Q","options":[{"label":"A","value":"a"}]}]}}
    """
    guard let model = pendingWorkQuestionFromApproval(description: "T", detail: detail, itemId: "one") else {
      return XCTFail("Expected a single-question model.")
    }
    XCTAssertEqual(model.questions.count, 1)
    // Legacy single-question consumers still work via computed shims.
    XCTAssertEqual(model.questionId, "only")
    XCTAssertEqual(model.options.count, 1)
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
