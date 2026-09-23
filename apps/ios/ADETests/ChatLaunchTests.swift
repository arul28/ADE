import XCTest
@testable import ADE

/// Chat launches (instant new-lane chats): wire decoding, merge-by-sequence,
/// wording parity with `apps/desktop/src/shared/chatLaunch.ts`, the list
/// projection, and the chained-flow fallback gate.
@MainActor
final class ChatLaunchTests: XCTestCase {

  // MARK: - Decoding

  func testSnapshotDecodesFullHostPayload() throws {
    let snapshot = try decodeSnapshot("""
    {
      "launchId": "l-1", "kind": "chat", "mode": "foreground", "sessionId": "l-1",
      "laneId": "lane-1", "laneName": "fix-login", "laneNaming": true,
      "branchRef": "ade/fix-login", "baseRef": "origin/main", "worktreePath": "/w/fix-login",
      "templateName": "Node", "title": "Fix login",
      "prompt": {"text": "Fix the login bug", "displayText": null, "attachments": [{"path": "/tmp/a.png", "type": "image"}]},
      "modelId": "claude-sonnet-5", "phase": "running",
      "stages": [
        {"id": "fetch", "status": "done", "startedAt": "2026-09-22T10:00:00.000Z", "endedAt": "2026-09-22T10:00:00.443Z", "percent": null, "detail": "origin/main at 807fb2c", "error": null},
        {"id": "checkout", "status": "running", "startedAt": "2026-09-22T10:00:00.443Z", "endedAt": null, "percent": 62, "detail": null, "error": null},
        {"id": "environment", "status": "pending", "startedAt": null, "endedAt": null, "percent": null, "detail": null, "error": null,
         "steps": [{"kind": "dependencies", "label": "Install dependencies", "status": "pending"}]},
        {"id": "agent", "status": "pending", "startedAt": null, "endedAt": null, "percent": null, "detail": null, "error": null}
      ],
      "error": null, "laneCreated": false, "sessionCreated": false, "agentStarted": false,
      "queuedMessages": [{"id": "q1", "text": "also check logout", "createdAt": "2026-09-22T10:00:01.000Z"}],
      "originClientId": "phone-1", "startedAt": "2026-09-22T10:00:00.000Z", "endedAt": null,
      "updatedAt": "2026-09-22T10:00:01.000Z", "sequence": 7
    }
    """)
    XCTAssertEqual(snapshot.launchId, "l-1")
    XCTAssertEqual(snapshot.kind, .chat)
    XCTAssertEqual(snapshot.laneName, "fix-login")
    XCTAssertTrue(snapshot.laneNaming)
    XCTAssertEqual(snapshot.baseRef, "origin/main")
    XCTAssertEqual(snapshot.prompt.attachments, [AgentChatFileRef(path: "/tmp/a.png", type: "image")])
    XCTAssertEqual(snapshot.stages.map(\.id), [.fetch, .checkout, .environment, .agent])
    XCTAssertEqual(snapshot.stages[1].percent, 62)
    XCTAssertEqual(snapshot.stages[2].steps?.first?.label, "Install dependencies")
    XCTAssertEqual(snapshot.queuedMessages.map(\.text), ["also check logout"])
    XCTAssertEqual(snapshot.sequence, 7)
    XCTAssertEqual(snapshot.chatSessionId, "l-1")
  }

  func testSnapshotDecodingToleratesUnknownValuesAndMissingFields() throws {
    let snapshot = try decodeSnapshot("""
    {
      "launchId": "l-2", "kind": "hologram", "mode": "sideways", "phase": "teleporting",
      "stages": [
        {"id": "warp", "status": "vibing"},
        {"id": "checkout", "status": "running", "percent": 12.5},
        {"status": "done"}
      ],
      "queuedMessages": [{"text": "no id"}, {"id": "ok", "text": "kept"}]
    }
    """)
    XCTAssertEqual(snapshot.kind, .chat)
    XCTAssertEqual(snapshot.mode, .foreground)
    XCTAssertEqual(snapshot.phase, .running)
    // Unknown stage ids survive; a stage with no id is dropped, not the snapshot.
    XCTAssertEqual(snapshot.stages.map(\.id.rawValue), ["warp", "checkout"])
    XCTAssertEqual(snapshot.stages[0].status, .pending)
    XCTAssertEqual(snapshot.queuedMessages.map(\.id), ["ok"])
    XCTAssertEqual(snapshot.laneId, "")
    XCTAssertEqual(snapshot.prompt.text, "")
    XCTAssertFalse(snapshot.agentStarted)
    XCTAssertNil(snapshot.sessionId)
    XCTAssertEqual(snapshot.chatSessionId, "l-2")
    XCTAssertEqual(snapshot.sequence, 0)
    XCTAssertEqual(chatLaunchStatusLine(snapshot), "Checking out files · 12.5%")
    XCTAssertEqual(chatLaunchStageLabel(ChatLaunchStageId(rawValue: "warp_drive"), kind: .chat, templateName: nil), "Warp drive")
  }

  func testEventEnvelopeDecodesBareWrappedAndRemoved() throws {
    let updated = try decodeEnvelope(#"{"type":"launch-updated","launch":{"launchId":"a","sequence":2}}"#)
    guard case .launchUpdated(let snapshot)? = updated.event else { return XCTFail("expected update") }
    XCTAssertEqual(snapshot.launchId, "a")

    let wrapped = try decodeEnvelope(#"{"type":"chat_launch_event","projectId":"p1","event":{"type":"launch-removed","launchId":"b"}}"#)
    XCTAssertEqual(wrapped.event, .launchRemoved(launchId: "b"))
    XCTAssertEqual(wrapped.projectId, "p1")

    let unknown = try decodeEnvelope(#"{"type":"launch-exploded","launchId":"c"}"#)
    XCTAssertNil(unknown.event)
  }

  // MARK: - Merge by sequence

  func testMergeKeepsNewerAndAcceptsEqualSequence() {
    let held = ChatLaunchSnapshot(launchId: "x", title: "held", sequence: 5)
    XCTAssertEqual(mergeChatLaunchSnapshot(held, ChatLaunchSnapshot(launchId: "x", title: "old", sequence: 4)).title, "held")
    XCTAssertEqual(mergeChatLaunchSnapshot(held, ChatLaunchSnapshot(launchId: "x", title: "same", sequence: 5)).title, "same")
    XCTAssertEqual(mergeChatLaunchSnapshot(held, ChatLaunchSnapshot(launchId: "x", title: "new", sequence: 6)).title, "new")
    XCTAssertEqual(mergeChatLaunchSnapshot(nil, held).title, "held")
    XCTAssertEqual(mergeChatLaunchSnapshot(held, ChatLaunchSnapshot(launchId: "y", title: "other", sequence: 0)).title, "other")
  }

  func testStoreDropsStaleSnapshotsAndHostBeatsOptimistic() {
    let store = ChatLaunchStore()
    let request = makeRequest()
    let optimistic = chatLaunchOptimisticSnapshot(request: request)
    store.insertOptimistic(optimistic, projectId: "p1", projectRootPath: "/repo", provider: "claude")
    XCTAssertEqual(store.entry(launchId: request.launchId)?.hostAccepted, false)
    XCTAssertEqual(optimistic.sequence, -1)

    XCTAssertTrue(store.apply(ChatLaunchSnapshot(launchId: request.launchId, laneName: "host-name", sequence: 0)))
    XCTAssertEqual(store.snapshot(launchId: request.launchId)?.laneName, "host-name")
    XCTAssertEqual(store.entry(launchId: request.launchId)?.hostAccepted, true)
    // Project + provider recorded locally survive host snapshots.
    XCTAssertEqual(store.entry(launchId: request.launchId)?.projectId, "p1")
    XCTAssertEqual(store.entry(launchId: request.launchId)?.provider, "claude")

    store.apply(ChatLaunchSnapshot(launchId: request.launchId, laneName: "v3", sequence: 3))
    XCTAssertFalse(store.apply(ChatLaunchSnapshot(launchId: request.launchId, laneName: "v2", sequence: 2)))
    XCTAssertEqual(store.snapshot(launchId: request.launchId)?.laneName, "v3")
    XCTAssertNotNil(store.entry(sessionId: request.launchId))
  }

  func testReplaceProjectDropsAcceptedLaunchesTheHostForgotButKeepsLocalOnes() {
    let store = ChatLaunchStore()
    store.apply(ChatLaunchSnapshot(launchId: "gone", sequence: 1), projectId: "p1")
    store.apply(ChatLaunchSnapshot(launchId: "other-project", sequence: 1), projectId: "p2")
    store.insertOptimistic(ChatLaunchSnapshot(launchId: "local", sequence: -1), projectId: "p1", projectRootPath: nil, provider: nil)
    store.replaceProject(projectId: "p1", projectRootPath: nil, with: [ChatLaunchSnapshot(launchId: "fresh", sequence: 1)])
    XCTAssertNil(store.entry(launchId: "gone"))
    XCTAssertNotNil(store.entry(launchId: "other-project"))
    XCTAssertNotNil(store.entry(launchId: "local"))
    XCTAssertEqual(store.entry(launchId: "fresh")?.projectId, "p1")
    XCTAssertEqual(
      Set(store.entries(projectId: "p1", projectRootPath: nil, isActiveProject: true).map(\.launchId)),
      ["local", "fresh"]
    )
  }

  // MARK: - Wording parity with chatLaunch.ts

  func testStageLabelsMatchDesktop() {
    XCTAssertEqual(chatLaunchStageLabel(.fetch, kind: .chat, templateName: nil), "Fetch base branch")
    XCTAssertEqual(chatLaunchStageLabel(.checkout, kind: .chat, templateName: nil), "Check out files")
    XCTAssertEqual(chatLaunchStageLabel(.environment, kind: .chat, templateName: nil), "Set up environment")
    XCTAssertEqual(chatLaunchStageLabel(.environment, kind: .chat, templateName: ""), "Set up environment")
    XCTAssertEqual(chatLaunchStageLabel(.environment, kind: .chat, templateName: "Node"), "Apply lane template")
    XCTAssertEqual(chatLaunchStageLabel(.agent, kind: .chat, templateName: nil), "Start agent")
    XCTAssertEqual(chatLaunchStageLabel(.agent, kind: .cli, templateName: nil), "Start CLI session")
    XCTAssertEqual(chatLaunchStageActiveLabel(.fetch, kind: .chat, templateName: nil), "Fetching base branch")
    XCTAssertEqual(chatLaunchStageActiveLabel(.checkout, kind: .chat, templateName: nil), "Checking out files")
    XCTAssertEqual(chatLaunchStageActiveLabel(.environment, kind: .chat, templateName: "Node"), "Applying lane template")
    XCTAssertEqual(chatLaunchStageActiveLabel(.environment, kind: .chat, templateName: nil), "Setting up environment")
    XCTAssertEqual(chatLaunchStageActiveLabel(.agent, kind: .chat, templateName: nil), "Starting agent")
    XCTAssertEqual(chatLaunchStageActiveLabel(.agent, kind: .cli, templateName: nil), "Starting CLI session")
    XCTAssertEqual(chatLaunchStageOrder, [.fetch, .checkout, .environment, .agent])
  }

  func testStatusLineMatchesDesktopCases() {
    // The examples in chatLaunch.ts's doc comment, plus every branch.
    XCTAssertEqual(chatLaunchStatusLine(launch(stages: [
      stage(.fetch, .done), stage(.checkout, .running, percent: 62), stage(.agent, .pending),
    ])), "Checking out files · 62%")
    XCTAssertEqual(chatLaunchStatusLine(launch(templateName: "Node", stages: [
      stage(.checkout, .done),
      stage(.environment, .running, steps: [
        LaneEnvInitStep(kind: "env-files", label: "Copy env files", status: "completed"),
        LaneEnvInitStep(kind: "dependencies", label: "Install dependencies", status: "running"),
      ]),
    ])), "Applying lane template · Install dependencies")
    XCTAssertEqual(chatLaunchStatusLine(launch(stages: [
      stage(.environment, .running, steps: [LaneEnvInitStep(kind: "docker", label: "Start Docker", status: "pending")]),
    ])), "Setting up environment")
    XCTAssertEqual(chatLaunchStatusLine(launch(stages: [stage(.checkout, .running)])), "Checking out files")
    XCTAssertEqual(chatLaunchStatusLine(launch(stages: [stage(.checkout, .running, percent: 0)])), "Checking out files · 0%")
    XCTAssertEqual(chatLaunchStatusLine(launch(stages: [stage(.fetch, .done), stage(.agent, .pending)])), "Starting agent")
    XCTAssertEqual(chatLaunchStatusLine(launch(stages: [])), "Setting up lane")
    XCTAssertEqual(chatLaunchStatusLine(launch(stages: [stage(.fetch, .done)])), "Setting up lane")
    XCTAssertEqual(chatLaunchStatusLine(launch(phase: .failed, stages: [
      stage(.fetch, .done), stage(.checkout, .failed),
    ])), "Check out files failed")
    XCTAssertEqual(chatLaunchStatusLine(launch(phase: .failed, templateName: "Node", stages: [
      stage(.environment, .failed),
    ])), "Apply lane template failed")
    XCTAssertEqual(chatLaunchStatusLine(launch(phase: .failed, stages: [stage(.fetch, .done)])), "Setup failed")
    XCTAssertEqual(chatLaunchStatusLine(launch(phase: .completed, stages: [])), "Agent started")
    XCTAssertEqual(chatLaunchStatusLine(launch(kind: .cli, phase: .completed, stages: [])), "CLI session started")
    XCTAssertEqual(chatLaunchStatusLine(launch(phase: .cancelled, stages: [stage(.fetch, .running)])), "Cancelled")
    XCTAssertEqual(chatLaunchStatusLine(launch(kind: .cli, phase: .awaitingClient, stages: [
      stage(.checkout, .done), stage(.agent, .running),
    ])), "Starting CLI session")
    // Running wins over failed, failed over pending.
    XCTAssertEqual(chatLaunchActiveStage([stage(.fetch, .failed), stage(.checkout, .running)])?.id, .checkout)
    XCTAssertEqual(chatLaunchActiveStage([stage(.fetch, .pending), stage(.checkout, .failed)])?.id, .checkout)
  }

  func testPendingProgressAndTerminalPredicates() {
    XCTAssertTrue(isChatLaunchPending(phase: .running, agentStarted: false))
    XCTAssertTrue(isChatLaunchPending(phase: .failed, agentStarted: false))
    XCTAssertTrue(isChatLaunchPending(phase: .awaitingClient, agentStarted: false))
    XCTAssertFalse(isChatLaunchPending(phase: .running, agentStarted: true))
    XCTAssertFalse(isChatLaunchPending(phase: .completed, agentStarted: false))
    XCTAssertFalse(isChatLaunchPending(phase: .cancelled, agentStarted: false))
    XCTAssertTrue(isChatLaunchTerminal(.completed))
    XCTAssertTrue(isChatLaunchTerminal(.cancelled))
    XCTAssertFalse(isChatLaunchTerminal(.failed))
  }

  func testDurationFormattingMatchesDesktop() {
    XCTAssertEqual(formatChatLaunchDuration(nil), "")
    XCTAssertEqual(formatChatLaunchDuration(0), "0ms")
    XCTAssertEqual(formatChatLaunchDuration(443), "443ms")
    XCTAssertEqual(formatChatLaunchDuration(999.4), "999ms")
    XCTAssertEqual(formatChatLaunchDuration(1_000), "1.0s")
    XCTAssertEqual(formatChatLaunchDuration(2_340), "2.3s")
    XCTAssertEqual(formatChatLaunchDuration(12_600), "13s")
    XCTAssertEqual(formatChatLaunchDuration(59_400), "59s")
    XCTAssertEqual(formatChatLaunchDuration(60_000), "1m 0s")
    XCTAssertEqual(formatChatLaunchDuration(125_000), "2m 5s")

    XCTAssertEqual(chatLaunchStageDurationMs(startedAt: nil, endedAt: nil, nowMs: 5), nil)
    XCTAssertEqual(chatLaunchStageDurationMs(startedAt: "not a date", endedAt: nil, nowMs: 5), nil)
    XCTAssertEqual(
      chatLaunchStageDurationMs(startedAt: "2026-09-22T10:00:00.000Z", endedAt: "2026-09-22T10:00:00.443Z"),
      443
    )
    let start = chatLaunchParseTimestampMs("2026-09-22T10:00:00Z") ?? 0
    XCTAssertEqual(chatLaunchStageDurationMs(startedAt: "2026-09-22T10:00:00Z", endedAt: nil, nowMs: start + 1_500), 1_500)
    // A clock skew never yields a negative duration.
    XCTAssertEqual(chatLaunchStageDurationMs(startedAt: "2026-09-22T10:00:00Z", endedAt: nil, nowMs: start - 10), 0)
  }

  // MARK: - Setup card presentation

  func testCardTitleMatchesDesktopWording() {
    XCTAssertEqual(chatLaunchCardTitle(launch(stages: [stage(.checkout, .running)])), "Setting up lane…")
    XCTAssertEqual(chatLaunchCardTitle(launch(phase: .failed, stages: [stage(.checkout, .failed)])), "Lane setup failed")
    XCTAssertEqual(chatLaunchCardTitle(launch(phase: .cancelled, stages: [])), "Lane setup cancelled")
    XCTAssertEqual(chatLaunchCardTitle(launch(kind: .cli, phase: .awaitingClient, stages: [])), "Starting CLI session…")
    var done = launch(phase: .completed, stages: [])
    done.endedAt = "2026-09-22T10:00:04.200Z"
    XCTAssertEqual(chatLaunchCardTitle(done), "Lane set up in 4.2s")
    let ready = launch(laneCreated: true, stages: [stage(.fetch, .done), stage(.checkout, .done), stage(.agent, .running)])
    XCTAssertTrue(chatLaunchLaneIsReady(ready))
    // Desktop `laneSetupTitle` has no "Lane ready" beat: still setting up until the agent runs.
    XCTAssertEqual(chatLaunchCardTitle(ready), "Setting up lane…")
    XCTAssertFalse(chatLaunchLaneIsReady(launch(phase: .failed, laneCreated: true, stages: [])))
  }

  func testRailSegmentsMirrorDesktopFillScale() {
    let segments = chatLaunchRailSegments([
      stage(.fetch, .done),
      stage(.checkout, .running, percent: 62),
      stage(.environment, .pending),
      stage(.agent, .failed),
    ])
    XCTAssertEqual(segments.map(\.id), ["fetch", "checkout", "environment", "agent"])
    XCTAssertEqual(segments.map(\.fill), [1, 0.62, 0, 1])
    XCTAssertEqual(chatLaunchRailFill(status: .running, percent: 1), 0.04)
    XCTAssertEqual(chatLaunchRailFill(status: .running, percent: 250), 1)
    XCTAssertEqual(chatLaunchRailFill(status: .running, percent: nil), 0)
    XCTAssertEqual(chatLaunchRailFill(status: .skipped, percent: nil), 1)
    XCTAssertEqual(chatLaunchRailFill(status: .warning, percent: nil), 1)
    // Only checkout reports a real percent; a stray one elsewhere is ignored.
    XCTAssertEqual(chatLaunchRailSegments([stage(.environment, .running, percent: 50)]).first?.fill, 0)
  }

  func testStageSymbolsBaseLabelAndLiveDuration() {
    XCTAssertEqual(chatLaunchStageSymbol(.fetch, kind: .chat, templateName: nil), "icloud.and.arrow.down")
    XCTAssertEqual(chatLaunchStageSymbol(.checkout, kind: .chat, templateName: nil), "doc.on.doc")
    XCTAssertEqual(chatLaunchStageSymbol(.environment, kind: .chat, templateName: "Node"), "square.stack.3d.up")
    XCTAssertEqual(chatLaunchStageSymbol(.environment, kind: .chat, templateName: ""), "wrench.and.screwdriver")
    XCTAssertEqual(chatLaunchStageSymbol(.agent, kind: .chat, templateName: nil), "sparkles")
    XCTAssertEqual(chatLaunchStageSymbol(.agent, kind: .cli, templateName: nil), "terminal")
    XCTAssertEqual(chatLaunchEnvStepSymbol("docker"), "shippingbox")
    XCTAssertEqual(chatLaunchEnvStepSymbol("mystery"), "wrench.and.screwdriver")

    var withBase = launch(stages: [])
    withBase.baseRef = "origin/main"
    withBase.branchRef = "refs/heads/ade/fix-login"
    XCTAssertEqual(chatLaunchBaseLabel(withBase), "origin/main")
    withBase.baseRef = "  "
    XCTAssertEqual(chatLaunchBaseLabel(withBase), "ade/fix-login")
    withBase.branchRef = nil
    XCTAssertNil(chatLaunchBaseLabel(withBase))

    XCTAssertEqual(formatChatLaunchLiveDuration(nil), "")
    XCTAssertEqual(formatChatLaunchLiveDuration(400), "0s")
    XCTAssertEqual(formatChatLaunchLiveDuration(2_900), "2s")
    XCTAssertEqual(formatChatLaunchLiveDuration(59_999), "59s")
    XCTAssertEqual(formatChatLaunchLiveDuration(125_000), "2m 5s")
  }

  // MARK: - Card actions

  func testCardActionsFollowPhaseAndStage() {
    XCTAssertEqual(workChatLaunchCardActions(launch(stages: [stage(.checkout, .running)])), [.cancel])
    XCTAssertEqual(
      workChatLaunchCardActions(launch(laneCreated: true, stages: [stage(.checkout, .done), stage(.environment, .running)])),
      [.startNow, .cancel]
    )
    XCTAssertEqual(
      workChatLaunchCardActions(launch(phase: .failed, laneCreated: true, stages: [stage(.environment, .failed)])),
      [.retry, .startAnyway, .delete]
    )
    XCTAssertEqual(
      workChatLaunchCardActions(launch(phase: .failed, laneCreated: false, stages: [stage(.checkout, .failed)])),
      [.retry, .delete]
    )
    XCTAssertEqual(workChatLaunchCardActions(launch(phase: .completed, stages: [])), [])
  }

  // MARK: - Wire args

  func testCommandArgsStripLaneAndSessionFromCreateAndCarryLaneName() throws {
    let request = makeRequest()
    let args = chatLaunchCommandArgs(
      request: request,
      createArgs: ["laneId": "old-lane", "sessionId": "old", "provider": "claude", "model": "claude-sonnet-5"],
      attachments: [AgentChatFileRef(path: "/tmp/a.png", type: "image")]
    )
    XCTAssertEqual(args["kind"] as? String, "chat")
    XCTAssertEqual(args["mode"] as? String, "foreground")
    XCTAssertEqual(args["launchId"] as? String, request.launchId)
    XCTAssertEqual(args["laneId"] as? String, request.laneId)
    XCTAssertEqual(args["laneName"] as? String, "fix-login-bug")
    XCTAssertEqual(args["prompt"] as? String, "Fix the login bug")
    XCTAssertEqual(args["modelId"] as? String, "claude-sonnet-5")
    XCTAssertEqual(args["provider"] as? String, "claude")
    XCTAssertEqual(args["originClientId"] as? String, "phone-1")
    XCTAssertNil(args["title"])
    let chat = try XCTUnwrap(args["chat"] as? [String: Any])
    let create = try XCTUnwrap(chat["create"] as? [String: Any])
    XCTAssertNil(create["laneId"])
    XCTAssertNil(create["sessionId"])
    XCTAssertEqual(create["provider"] as? String, "claude")
    let message = try XCTUnwrap(chat["message"] as? [String: Any])
    XCTAssertEqual(message["text"] as? String, "Fix the login bug")
    XCTAssertNil(message["sessionId"])
    XCTAssertEqual((message["attachments"] as? [[String: Any]])?.first?["path"] as? String, "/tmp/a.png")
    XCTAssertTrue(JSONSerialization.isValidJSONObject(args))
  }

  // MARK: - Fallback to the chained flow

  func testFallbackGateUsesChainedFlowForOlderOrOfflineHosts() {
    XCTAssertTrue(syncShouldUseChatLaunch(hostAdvertisesStartLaunch: true, knownUnsupported: false, canSendLiveRequests: true))
    XCTAssertFalse(syncShouldUseChatLaunch(hostAdvertisesStartLaunch: false, knownUnsupported: false, canSendLiveRequests: true))
    XCTAssertFalse(syncShouldUseChatLaunch(hostAdvertisesStartLaunch: true, knownUnsupported: true, canSendLiveRequests: true))
    XCTAssertFalse(syncShouldUseChatLaunch(hostAdvertisesStartLaunch: true, knownUnsupported: false, canSendLiveRequests: false))
  }

  func testUnsupportedCommandErrorsAreRecognized() {
    let hostReject = NSError(domain: "ADE", code: 6, userInfo: [NSLocalizedDescriptionKey: "Unsupported remote command: chat.startLaunch."])
    XCTAssertTrue(syncChatLaunchErrorIsUnsupportedCommand(hostReject))
    let typed = NSError(domain: "ADE", code: 17, userInfo: [NSLocalizedDescriptionKey: "nope", "ADEErrorCode": "unsupported_action"])
    XCTAssertTrue(syncChatLaunchErrorIsUnsupportedCommand(typed))
    let other = NSError(domain: "ADE", code: 17, userInfo: [NSLocalizedDescriptionKey: "Lane create failed", "ADEErrorCode": "command_failed"])
    XCTAssertFalse(syncChatLaunchErrorIsUnsupportedCommand(other))
  }

  // MARK: - Host compatibility (live SyncService)
  //
  // `chat.*Launch` actions are OPTIONAL in the mobile compatibility contract
  // (MOBILE_SYNC_OPTIONAL_REMOTE_COMMAND_ACTIONS), so a new phone must keep the
  // chained lanes.create → chat.create → chat.send flow against an older brain,
  // decide that locally before anything is sent, and never fail the handshake
  // over a missing `features.mobileCompatibility` block.

  private let compatDefaultsKeys = [
    "ade.sync.hostProfile",
    "ade.sync.hostProfiles",
    "ade.sync.connectionDraft",
    "ade.sync.autoReconnectPausedByUser",
    "ade.sync.activeProjectHostIdentity",
    "ade.sync.remoteCommandDescriptors",
  ]

  private func withConnectedService(_ body: (SyncService) async throws -> Void) async throws {
    let defaults = compatDefaultsKeys.reduce(into: [String: Any]()) { snapshot, key in
      if let value = UserDefaults.standard.object(forKey: key) { snapshot[key] = value }
    }
    let baseURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    service.beginOutboundEnvelopeCaptureForTesting()
    service.configureConnectedTransportForTesting()
    defer {
      service.endOutboundEnvelopeCaptureForTesting()
      service.disconnect(clearCredentials: false)
      for key in compatDefaultsKeys {
        UserDefaults.standard.removeObject(forKey: key)
        if let value = defaults[key] { UserDefaults.standard.set(value, forKey: key) }
      }
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }
    try await body(service)
  }

  private func composerRequest(hostCanStartLaunch: Bool) -> ChatLaunchRequest? {
    ChatLaunchRequest(
      composerOpener: "Fix the login bug",
      laneName: "fix-login-bug",
      provider: "claude",
      modelId: "claude-sonnet-5",
      reasoningEffort: "",
      codexFastMode: nil,
      piMetadata: nil,
      wire: WorkRuntimeWireFields(),
      projectId: nil,
      projectRootPath: nil,
      originClientId: nil,
      isAutoCreateLane: true,
      isChatSession: true,
      cursorCloudMode: false,
      hostCanStartLaunch: hostCanStartLaunch
    )
  }

  func testLegacyHostWithoutLaunchActionsConnectsAndKeepsTheChainedFlow() async throws {
    try await withConnectedService { service in
      // An older brain: routes the chained-flow commands, no launch actions,
      // no mobileCompatibility block.
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "legacy-host", "deviceName": "Mac Studio"],
        "features": [
          "commandRouting": [
            "actions": ["lanes.create", "chat.create", "chat.send"].map {
              ["action": $0, "policy": ["viewerAllowed": true]] as [String: Any]
            },
          ],
        ],
      ])
      XCTAssertEqual(service.connectionState, .connected, "a missing mobileCompatibility block must not fail the handshake")
      XCTAssertEqual(service.hostCompatibilityMode, .limited)
      XCTAssertEqual(service.hostCompatibilityMissingActions, ["mobileCompatibility"])
      XCTAssertTrue(service.supportsRemoteAction("chat.create"))
      XCTAssertFalse(service.canStartChatLaunch)
      XCTAssertNil(composerRequest(hostCanStartLaunch: service.canStartChatLaunch), "composers must take the chained flow")
      XCTAssertTrue(service.chatLaunchStore.activeProjectHydrated, "nothing to list on a host without chat.listLaunches")

      // A launch action the host never advertised is refused locally, before the wire.
      service.resetOutboundEnvelopeCaptureForTesting()
      do {
        try await service.startChatLaunchNow(launchId: "launch-1")
        XCTFail("chat.startLaunchNow must be refused on a host that never advertised it")
      } catch {
        XCTAssertEqual((error as NSError).code, 15)
      }
      XCTAssertEqual(service.capturedOutboundEnvelopeCountForTesting(type: "command"), 0)
    }
  }

  func testHostAdvertisingStartLaunchUsesItUntilItRejectsTheCommand() async throws {
    try await withConnectedService { service in
      let launchActions = [
        "chat.startLaunch", "chat.getLaunch", "chat.listLaunches", "chat.cancelLaunch",
        "chat.retryLaunch", "chat.startLaunchNow", "chat.queueLaunchMessage",
      ]
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "new-host", "deviceName": "Mac Studio"],
        "features": [
          "mobileCompatibility": ["mode": "full", "missingActions": [String]()],
          "commandRouting": [
            "actions": (["lanes.create", "chat.create", "chat.send"] + launchActions).map {
              ["action": $0, "policy": ["viewerAllowed": true]] as [String: Any]
            },
          ],
        ],
      ])
      XCTAssertEqual(service.hostCompatibilityMode, .full)
      XCTAssertTrue(service.canStartChatLaunch)
      XCTAssertNotNil(composerRequest(hostCanStartLaunch: service.canStartChatLaunch))

      // The host advertised it but answered "Unsupported remote command":
      // later sends fall back until the next hello resets the mark.
      service.chatLaunchKnownUnsupported = true
      XCTAssertFalse(service.canStartChatLaunch)
      XCTAssertNil(composerRequest(hostCanStartLaunch: service.canStartChatLaunch))
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "new-host", "deviceName": "Mac Studio"],
        "features": [
          "mobileCompatibility": ["mode": "full", "missingActions": [String]()],
          "commandRouting": [
            "actions": launchActions.map { ["action": $0, "policy": ["viewerAllowed": true]] as [String: Any] },
          ],
        ],
      ])
      XCTAssertTrue(service.canStartChatLaunch, "a reconnect re-reads the host's capabilities")
    }
  }

  // MARK: - List projection

  func testWorkOverlayAddsPendingRowThenDefersToRealRow() {
    let entry = ChatLaunchEntry(
      snapshot: launch(stages: [stage(.checkout, .running, percent: 40)]),
      projectId: "p1",
      projectRootPath: nil,
      provider: "codex",
      hostAccepted: true
    )
    let synthesized = workOverlayChatLaunches(sessions: [], lanes: [], launches: [entry])
    XCTAssertEqual(synthesized.sessions.map(\.id), ["launch-1"])
    XCTAssertEqual(synthesized.sessions.first?.laneId, "lane-1")
    XCTAssertEqual(synthesized.sessions.first?.toolType, "codex-chat")
    XCTAssertEqual(synthesized.sessions.first?.statusNote, "Checking out files · 40%")
    XCTAssertEqual(synthesized.sessions.first?.launchRail?.map(\.fill), [0.4])
    XCTAssertEqual(synthesized.lanes.map(\.id), ["lane-1"])
    XCTAssertEqual(synthesized.lanes.first?.name, "fix-login")

    var real = workChatLaunchOptimisticSession(entry)
    real.title = "Real title"
    real.statusNote = nil
    real.launchRail = nil
    let merged = workOverlayChatLaunches(sessions: [real], lanes: [], launches: [entry])
    XCTAssertEqual(merged.sessions.count, 1)
    XCTAssertEqual(merged.sessions.first?.title, "Real title")
    XCTAssertEqual(merged.sessions.first?.statusNote, "Checking out files · 40%")
    XCTAssertEqual(merged.sessions.first?.launchRail?.map(\.id), ["checkout"])

    var started = entry
    started.snapshot.agentStarted = true
    let afterStart = workOverlayChatLaunches(sessions: [real], lanes: [], launches: [started])
    XCTAssertNil(afterStart.sessions.first?.statusNote)
    XCTAssertNil(afterStart.sessions.first?.launchRail)
  }

  // MARK: - Transcript card (lane_setup ade_card)

  func testLaneSetupCardRowsMatchByKeyOnly() throws {
    let payload = try JSONDecoder().decode(AgentChatAdeCardPayload.self, from: Data("""
    {
      "cardId": "lane-setup:launch-1", "variant": "lane_setup", "state": "terminal",
      "title": "", "subtitle": "fix-login from origin/main · Node", "durationMs": 4200,
      "metrics": [{"label": "Template", "value": " Node "}],
      "rows": [
        {"key": "fetch", "icon": "pass", "text": "Fetch base branch", "detail": "origin/main", "tone": "warning"},
        {"key": "checkout", "icon": "pass", "text": "Renamed checkout label"},
        {"key": 42, "icon": "pass", "text": "Apply lane template"},
        {"key": "warp", "icon": "running", "text": "Start CLI session"},
        {"icon": "info", "text": "Start agent", "tone": "warning"}
      ],
      "fallbackText": "Lane fix-login set up."
    }
    """.utf8))
    // A mistyped key drops only that field, not the row (or the rows array).
    XCTAssertEqual(payload.rows?.map(\.key), ["fetch", "checkout", nil, "warp", nil])
    let card = makeWorkAdeCardModel(from: payload)
    XCTAssertEqual(card.rows.map(\.key), ["fetch", "checkout", nil, "warp", nil])
    XCTAssertEqual(workLaneSetupTemplateName(card), "Node")

    // A relabelled row still resolves to its stage by key; the label is never read.
    XCTAssertEqual(chatLaunchStageIdForCardRow(key: "checkout"), .checkout)
    XCTAssertEqual(chatLaunchStageIdForCardRow(key: " agent "), .agent)
    XCTAssertNil(chatLaunchStageIdForCardRow(key: "warp"))
    XCTAssertNil(chatLaunchStageIdForCardRow(key: nil))
    XCTAssertNil(chatLaunchStageIdForCardRow(key: ""))

    let rows = workLaneSetupPayloadRows(card)
    // Unknown or missing keys get the generic glyph even when the label names a stage.
    XCTAssertEqual(rows.map(\.symbol), ["icloud.and.arrow.down", "doc.on.doc", "wrench.and.screwdriver", "wrench.and.screwdriver", "wrench.and.screwdriver"])
    // The Template metric drives the environment glyph.
    let envCard = makeWorkAdeCardModel(from: try JSONDecoder().decode(AgentChatAdeCardPayload.self, from: Data(#"{"cardId":"lane-setup:l","variant":"lane_setup","metrics":[{"label":"Template","value":"Node"}],"rows":[{"key":"environment","icon":"pass","text":"Set up environment"},{"key":"agent","icon":"pass","text":"Start agent"}]}"#.utf8)))
    XCTAssertEqual(workLaneSetupPayloadRows(envCard).map(\.symbol), ["square.stack.3d.up", "sparkles"])
    // pass + warning tone is the host's warning stage; old transcripts used info + warning.
    XCTAssertEqual(rows.map(\.status), [.warning, .done, .done, .running, .warning])
    XCTAssertEqual(rows.map(\.label)[1], "Renamed checkout label")

    // Empty host title → desktop fallback from the card's duration.
    XCTAssertEqual(chatLaunchCardPayloadTitle(title: workLaneSetupHostTitle(card), failed: false, durationMs: card.durationMs), "Lane set up in 4.2s")
    XCTAssertEqual(chatLaunchCardPayloadTitle(title: "", failed: true, durationMs: 4200), "Lane setup failed")
    XCTAssertEqual(chatLaunchCardPayloadTitle(title: "Lane set up in 3s", failed: false, durationMs: nil), "Lane set up in 3s")
  }

  func testLaneSetupCardMatchesLiveSnapshotByKeys() {
    func card(_ rows: [AgentChatAdeCardRow]) -> WorkAdeCardModel {
      var payload = AgentChatAdeCardPayload()
      payload.cardId = "lane-setup:launch-1"
      payload.variant = "lane_setup"
      payload.rows = rows
      return makeWorkAdeCardModel(from: payload)
    }
    let live = launch(stages: [stage(.fetch, .done), stage(.checkout, .running)])
    let keyed = [
      AgentChatAdeCardRow(key: "fetch", icon: "pass", text: "Fetch base branch"),
      AgentChatAdeCardRow(key: "checkout", icon: "running", text: "Check out files"),
    ]
    XCTAssertTrue(workLaneSetupCardMatchesSnapshot(card(keyed), live))
    XCTAssertFalse(workLaneSetupCardMatchesSnapshot(card([keyed[1], keyed[0]]), live))
    // Rows without keys never match: lane_setup rows always carry their stage id.
    let unkeyed = keyed.map { AgentChatAdeCardRow(icon: $0.icon, text: $0.text) }
    XCTAssertFalse(workLaneSetupCardMatchesSnapshot(card(unkeyed), live))
    XCTAssertTrue(workLaneSetupCardMatchesSnapshot(card([]), live))
    XCTAssertFalse(workLaneSetupCardMatchesSnapshot(card(keyed), launch(stages: [])))
  }

  // MARK: - Queued-message delivery failures

  func testQueuedMessageDecodesDeliveryErrorAndSurvivesCompletion() throws {
    let snapshot = try decodeSnapshot("""
    {
      "launchId": "l-3", "phase": "completed", "agentStarted": true, "sequence": 1000004,
      "queuedMessages": [
        {"id": "q1", "text": "also this", "createdAt": "2026-09-22T10:00:02.000Z", "deliveryError": " Agent is busy "},
        {"id": "q2", "text": "then this", "createdAt": "2026-09-22T10:00:03.000Z", "deliveryError": null},
        {"id": "q3", "text": "and this", "createdAt": "2026-09-22T10:00:04.000Z", "deliveryError": ""},
        {"id": "q4", "text": "old host"},
        {"id": "q5", "text": "odd", "deliveryError": 7}
      ]
    }
    """)
    XCTAssertEqual(snapshot.queuedMessages.map(\.id), ["q1", "q2", "q3", "q4", "q5"])
    XCTAssertEqual(snapshot.queuedMessages.map(\.deliveryError), ["Agent is busy", nil, nil, nil, nil])
    XCTAssertEqual(snapshot.queuedMessages.filter(\.deliveryFailed).map(\.id), ["q1"])
    XCTAssertEqual(chatLaunchDeliveryFailureTitle, "Couldn't send — retrying")
    // Still pending on the launch even though the agent started.
    XCTAssertFalse(isChatLaunchPending(snapshot))
  }

  func testReloadedSequenceJumpStillMergesByOrder() {
    let store = ChatLaunchStore()
    store.apply(ChatLaunchSnapshot(launchId: "x", title: "before reload", sequence: 12))
    XCTAssertTrue(store.apply(ChatLaunchSnapshot(launchId: "x", title: "after reload", sequence: 1_000_000)))
    XCTAssertFalse(store.apply(ChatLaunchSnapshot(launchId: "x", title: "late pre-reload push", sequence: 13)))
    XCTAssertEqual(store.snapshot(launchId: "x")?.title, "after reload")
  }

  // MARK: - Local state

  func testLocalStateDropsEmptyEntriesAndForgetKeepsInFlight() {
    let store = ChatLaunchStore()
    XCTAssertTrue(store.localState(launchId: "a").isEmpty)
    store.updateLocal(launchId: "a") { $0.deferredMessages.append(ChatLaunchQueuedMessage(id: "m", text: "hi", createdAt: "")) }
    store.updateLocal(launchId: "a") { $0.startInFlight = true }
    XCTAssertEqual(store.localState(launchId: "a").deferredMessages.map(\.id), ["m"])
    store.forgetLocalRequest(launchId: "a")
    XCTAssertTrue(store.localState(launchId: "a").deferredMessages.isEmpty)
    XCTAssertTrue(store.localState(launchId: "a").startInFlight)
    store.updateLocal(launchId: "a") { $0.startInFlight = false }
    XCTAssertNil(store.localStates["a"])
  }

  // MARK: - Composer request builder

  func testComposerRequestBuilderGateNeverLaunchesCursorCloud() {
    var laneNameEvaluations = 0
    func build(
      auto: Bool = true,
      chat: Bool = true,
      cloud: Bool = false,
      host: Bool = true
    ) -> ChatLaunchRequest? {
      var wire = WorkRuntimeWireFields()
      wire.cursorModeId = "agent"
      wire.permissionMode = "edit"
      return ChatLaunchRequest(
        composerOpener: "Fix the login bug",
        laneName: { laneNameEvaluations += 1; return "fix-login-bug" }(),
        provider: "cursor",
        modelId: "cursor/gpt-5",
        reasoningEffort: "  high ",
        codexFastMode: false,
        piMetadata: nil,
        wire: wire,
        projectId: "p1",
        projectRootPath: "/repo",
        originClientId: "phone-1",
        isAutoCreateLane: auto,
        isChatSession: chat,
        cursorCloudMode: cloud,
        hostCanStartLaunch: host
      )
    }
    XCTAssertNil(build(cloud: true), "Cursor Cloud launches must not use chat.startLaunch")
    XCTAssertNil(build(auto: false))
    XCTAssertNil(build(chat: false))
    XCTAssertNil(build(host: false))
    XCTAssertEqual(laneNameEvaluations, 0, "the lane name is only derived for a launch")
    XCTAssertFalse(chatLaunchComposerShouldUseLaunch(isAutoCreateLane: true, isChatSession: true, cursorCloudMode: true, hostCanStartLaunch: true))
    XCTAssertTrue(chatLaunchComposerShouldUseLaunch(isAutoCreateLane: true, isChatSession: true, cursorCloudMode: false, hostCanStartLaunch: true))

    guard let request = build() else { return XCTFail("an eligible plain chat must launch") }
    XCTAssertEqual(laneNameEvaluations, 1)
    XCTAssertEqual(request.laneName, "fix-login-bug")
    XCTAssertEqual(request.prompt, "Fix the login bug")
    XCTAssertEqual(request.chat.provider, "cursor")
    XCTAssertEqual(request.chat.model, "cursor/gpt-5")
    XCTAssertEqual(request.chat.reasoningEffort, "high")
    XCTAssertEqual(request.chat.cursorModeId, "agent")
    XCTAssertEqual(request.chat.permissionMode, "edit")
    XCTAssertEqual(request.projectId, "p1")
    XCTAssertEqual(request.originClientId, "phone-1")
    XCTAssertEqual(request.launchId.count, 36)
    XCTAssertNotEqual(request.launchId, request.laneId)
    XCTAssertEqual(request.launchId, request.launchId.lowercased())
  }

  func testChatAttachmentArgsOmitsEmptyUrl() throws {
    let args = chatAttachmentArgs([
      AgentChatFileRef(path: "/tmp/a.png", type: "image"),
      AgentChatFileRef(path: "/tmp/b.png", type: "image", url: ""),
      AgentChatFileRef(path: "/tmp/c.png", type: "image", url: "https://x/c.png"),
    ])
    XCTAssertEqual(args.map { $0["path"] as? String }, ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"])
    XCTAssertEqual(args.map { $0["type"] as? String }, ["image", "image", "image"])
    XCTAssertEqual(args.map { $0["url"] as? String }, [nil, nil, "https://x/c.png"])
    XCTAssertEqual(args.map(\.count), [2, 2, 3])
  }

  // MARK: - Round-2 regressions

  /// Launches in a non-active project get no pushes; only those projects with
  /// a launch still moving are pulled, once each, and nothing when idle.
  func testForeignRefreshScopesPickOnlyMovingLaunchesOutsideTheActiveProject() {
    func entry(
      _ id: String,
      project: String?,
      root: String? = nil,
      phase: ChatLaunchPhase = .running,
      accepted: Bool = true
    ) -> ChatLaunchEntry {
      ChatLaunchEntry(
        snapshot: ChatLaunchSnapshot(launchId: id, phase: phase, sequence: 1),
        projectId: project,
        projectRootPath: root,
        provider: nil,
        hostAccepted: accepted
      )
    }
    let isActive: (String?, String?) -> Bool = { id, _ in id == "active" }
    XCTAssertEqual(chatLaunchForeignRefreshScopes([], isActiveProject: isActive), [])
    let scopes = chatLaunchForeignRefreshScopes([
      entry("a1", project: "active"),                       // active project: pushes cover it
      entry("b1", project: "p2"),
      entry("b2", project: "p2", phase: .awaitingClient),   // same project, pulled once
      entry("c1", project: "p3", phase: .failed),           // waits on the user
      entry("d1", project: "p4", phase: .completed),        // nothing left to report
      entry("e1", project: "p5", accepted: false),          // host never saw it
      entry("f1", project: nil),                            // unscoped = active project
      entry("g1", project: nil, root: "/other"),            // root-only scope
    ], isActiveProject: isActive)
    XCTAssertEqual(scopes, [
      ChatLaunchProjectScope(projectId: "p2", rootPath: nil),
      ChatLaunchProjectScope(projectId: nil, rootPath: "/other"),
    ])
    XCTAssertEqual(
      chatLaunchForeignRefreshScopes([entry("c1", project: "p3", phase: .failed), entry("a1", project: "active")], isActiveProject: isActive),
      [],
      "no refresh when nothing outside the active project is pending"
    )
  }

  func testCancelLaunchGetsTheLaneDeleteTimeout() {
    XCTAssertEqual(
      SyncRequestTimeout.commandTimeoutNanoseconds(for: "chat.cancelLaunch"),
      SyncRequestTimeout.commandTimeoutNanoseconds(for: "lanes.delete")
    )
    XCTAssertGreaterThan(
      SyncRequestTimeout.commandTimeoutNanoseconds(for: "chat.cancelLaunch"),
      SyncRequestTimeout.defaultTimeoutNanoseconds
    )
  }

  /// A message typed before the host acknowledged it stays on the launch
  /// through host snapshots that do not carry it yet, then gives way to the
  /// host's copy once acknowledged.
  func testUnacknowledgedMessagesSurviveHostSnapshotsUntilAcknowledged() {
    let store = ChatLaunchStore()
    let request = makeRequest()
    store.insertOptimistic(chatLaunchOptimisticSnapshot(request: request), projectId: "p1", projectRootPath: nil, provider: "claude")
    let typed = ChatLaunchQueuedMessage(id: "\(chatLaunchLocalMessageIdPrefix)1", text: "also logout", createdAt: "t1")
    store.updateLocal(launchId: request.launchId) { $0.deferredMessages.append(typed) }
    XCTAssertEqual(store.snapshot(launchId: request.launchId)?.queuedMessages.map(\.id), [typed.id])

    // The host's first snapshots know nothing of it; it must not vanish.
    store.apply(ChatLaunchSnapshot(launchId: request.launchId, sequence: 0))
    store.replaceProject(projectId: "p1", projectRootPath: nil, with: [ChatLaunchSnapshot(launchId: request.launchId, sequence: 1)])
    XCTAssertEqual(store.snapshot(launchId: request.launchId)?.queuedMessages.map(\.text), ["also logout"])

    // On the wire: still shown exactly once, in typing order.
    let second = ChatLaunchQueuedMessage(id: "\(chatLaunchLocalMessageIdPrefix)2", text: "and signup", createdAt: "t2")
    store.updateLocal(launchId: request.launchId) { state in
      state.deferredMessages.removeAll { $0.id == typed.id }
      state.inFlightMessages.append(typed)
      state.deferredMessages.append(second)
    }
    XCTAssertEqual(store.snapshot(launchId: request.launchId)?.queuedMessages.map(\.text), ["also logout", "and signup"])

    // Acknowledged: the host's copy replaces the local one.
    store.apply(ChatLaunchSnapshot(
      launchId: request.launchId,
      queuedMessages: [ChatLaunchQueuedMessage(id: "host-q1", text: "also logout", createdAt: "t1")],
      sequence: 2
    ))
    store.updateLocal(launchId: request.launchId) { $0.inFlightMessages.removeAll { $0.id == typed.id } }
    XCTAssertEqual(store.snapshot(launchId: request.launchId)?.queuedMessages.map(\.id), ["host-q1", second.id])

    // Overlaying is idempotent.
    let held = store.snapshot(launchId: request.launchId)!
    XCTAssertEqual(chatLaunchOverlayUnacknowledged(held, [second]).queuedMessages.map(\.id), ["host-q1", second.id])
  }

  /// A deferred send the host refused is never silent: it waits in the store
  /// until the pending screen puts it back in the composer.
  func testSendFailuresAccumulateUntilTaken() {
    let store = ChatLaunchStore()
    XCTAssertNil(store.takeSendFailure(launchId: "l"))
    store.recordSendFailure(launchId: "l", texts: ["first", "  "], message: "Couldn't send — nope")
    store.recordSendFailure(launchId: "l", texts: ["second"], message: "Couldn't send — later")
    XCTAssertEqual(store.sendFailures["l"], ChatLaunchSendFailure(texts: ["first", "second"], message: "Couldn't send — later"))
    XCTAssertEqual(store.takeSendFailure(launchId: "l")?.texts, ["first", "second"])
    XCTAssertNil(store.takeSendFailure(launchId: "l"))
    store.recordSendFailure(launchId: "l", texts: [" "], message: "x")
    XCTAssertNil(store.sendFailures["l"], "nothing to restore, nothing recorded")
  }

  /// A chat route re-opened mid-setup (store still empty) must not lock onto
  /// the plain chat before the launches were listed.
  func testGateHandsOverOnlyOnceTheLaunchStartedOrLaunchesWereListed() {
    XCTAssertFalse(workChatLaunchGateCanHandOver(launch: nil, launchesHydrated: false))
    XCTAssertTrue(workChatLaunchGateCanHandOver(launch: nil, launchesHydrated: true))
    let setup = launch(stages: [stage(.checkout, .running)])
    XCTAssertFalse(workChatLaunchGateCanHandOver(launch: setup, launchesHydrated: true))
    XCTAssertFalse(workChatLaunchGateCanHandOver(launch: launch(phase: .failed, stages: []), launchesHydrated: true))
    XCTAssertFalse(workChatLaunchGateCanHandOver(launch: launch(phase: .cancelled, stages: []), launchesHydrated: true))
    var started = setup
    started.agentStarted = true
    XCTAssertTrue(workChatLaunchGateCanHandOver(launch: started, launchesHydrated: false))
    XCTAssertTrue(workChatLaunchGateCanHandOver(launch: launch(phase: .completed, stages: []), launchesHydrated: false))

    let store = ChatLaunchStore()
    var notified = 0
    store.onChange = { notified += 1 }
    XCTAssertFalse(store.activeProjectHydrated)
    store.setActiveProjectHydrated(true)
    store.setActiveProjectHydrated(true)
    XCTAssertTrue(store.activeProjectHydrated)
    XCTAssertEqual(notified, 1, "gates observe SyncService, which mirrors store changes")
  }

  /// A pushed event that names its project files the launch there, replacing
  /// an earlier guess (the active project); one without scope keeps the guess.
  func testEventScopeFromHostWinsOverTheActiveProjectGuess() throws {
    let wrapped = try decodeEnvelope(#"{"type":"chat_launch_event","event":{"type":"launch-updated","launch":{"launchId":"x","sequence":1},"projectId":" p2 ","projectRootPath":"/repo2"}}"#)
    XCTAssertEqual(wrapped.projectId, "p2")
    XCTAssertEqual(wrapped.projectRootPath, "/repo2")
    let outerWins = try decodeEnvelope(#"{"type":"chat_launch_event","projectId":"p3","event":{"type":"launch-removed","launchId":"x","projectId":"p2"}}"#)
    XCTAssertEqual(outerWins.projectId, "p3")
    let bare = try decodeEnvelope(#"{"type":"launch-updated","launch":{"launchId":"x"},"projectId":""}"#)
    XCTAssertNil(bare.projectId)

    let store = ChatLaunchStore()
    // Filed under the active project by a push from an older host.
    store.apply(ChatLaunchSnapshot(launchId: "x", sequence: 1), projectId: "active", projectRootPath: "/active")
    // An unscoped push keeps the recorded project.
    store.apply(ChatLaunchSnapshot(launchId: "x", sequence: 2), projectId: "active-now", projectRootPath: nil)
    XCTAssertEqual(store.entry(launchId: "x")?.projectId, "active")
    // The host names the real project: it wins.
    store.apply(ChatLaunchSnapshot(launchId: "x", sequence: 3), projectId: "p2", projectRootPath: "/repo2", scopeFromHost: true)
    XCTAssertEqual(store.entry(launchId: "x")?.projectId, "p2")
    XCTAssertEqual(store.entry(launchId: "x")?.projectRootPath, "/repo2")
    XCTAssertEqual(store.entries(projectId: "active", projectRootPath: "/active", isActiveProject: true).map(\.launchId), [])
    XCTAssertEqual(store.entries(projectId: "p2", projectRootPath: nil, isActiveProject: false).map(\.launchId), ["x"])
    // scopeFromHost with no scope at all changes nothing.
    store.apply(ChatLaunchSnapshot(launchId: "x", sequence: 4), projectId: nil, projectRootPath: nil, scopeFromHost: true)
    XCTAssertEqual(store.entry(launchId: "x")?.projectId, "p2")
  }

  // MARK: - Helpers

  private func decodeSnapshot(_ json: String) throws -> ChatLaunchSnapshot {
    try JSONDecoder().decode(ChatLaunchSnapshot.self, from: Data(json.utf8))
  }

  private func decodeEnvelope(_ json: String) throws -> ChatLaunchEventEnvelope {
    try JSONDecoder().decode(ChatLaunchEventEnvelope.self, from: Data(json.utf8))
  }

  private func makeRequest() -> ChatLaunchRequest {
    ChatLaunchRequest(
      launchId: "launch-1",
      laneId: "lane-1",
      laneName: "fix-login-bug",
      prompt: "Fix the login bug",
      displayPrompt: nil,
      title: nil,
      chat: ChatLaunchChatConfig(provider: "claude", model: "claude-sonnet-5"),
      projectId: "p1",
      projectRootPath: "/repo",
      originClientId: "phone-1"
    )
  }

  private func stage(
    _ id: ChatLaunchStageId,
    _ status: ChatLaunchStageStatus,
    percent: Double? = nil,
    steps: [LaneEnvInitStep]? = nil
  ) -> ChatLaunchStage {
    ChatLaunchStage(id: id, status: status, percent: percent, steps: steps)
  }

  private func launch(
    kind: ChatLaunchKind = .chat,
    phase: ChatLaunchPhase = .running,
    templateName: String? = nil,
    laneCreated: Bool = false,
    stages: [ChatLaunchStage]
  ) -> ChatLaunchSnapshot {
    ChatLaunchSnapshot(
      launchId: "launch-1",
      kind: kind,
      sessionId: "launch-1",
      laneId: "lane-1",
      laneName: "fix-login",
      templateName: templateName,
      title: "Fix login",
      prompt: ChatLaunchPrompt(text: "Fix the login bug"),
      phase: phase,
      stages: stages,
      laneCreated: laneCreated,
      startedAt: "2026-09-22T10:00:00.000Z",
      updatedAt: "2026-09-22T10:00:01.000Z",
      sequence: 1
    )
  }
}
