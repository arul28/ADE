import XCTest
import AVFoundation
import SQLite3
import UIKit
@testable import ADE

/// Default `lastActivityAt`/`startedAt` for fixture sessions. Returns "now"
/// in ISO 8601 so the >7-day staleness guard in
/// `normalizedWorkChatSessionStatus` doesn't reclassify default fixtures as
/// "ended".
private func recentIso8601Fixture() -> String {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f.string(from: Date())
}

private actor LaneBatchDeleteRecorder {
  private var started: [String] = []
  private var active = 0
  private var maxActive = 0
  private var startedWaiters: [(count: Int, continuation: CheckedContinuation<Void, Never>)] = []
  private var releaseWaiters: [CheckedContinuation<Void, Never>] = []
  private var released = false

  func start(_ laneId: String) {
    started.append(laneId)
    active += 1
    maxActive = max(maxActive, active)
    resumeStartedWaiters()
  }

  func finish() {
    active = max(0, active - 1)
  }

  func waitForStartedCount(_ count: Int) async {
    if started.count >= count { return }
    await withCheckedContinuation { continuation in
      startedWaiters.append((count: count, continuation: continuation))
    }
  }

  func waitForRelease() async {
    if released { return }
    await withCheckedContinuation { continuation in
      releaseWaiters.append(continuation)
    }
  }

  func release() {
    released = true
    let waiters = releaseWaiters
    releaseWaiters = []
    for waiter in waiters {
      waiter.resume()
    }
  }

  func startedIds() -> [String] {
    started
  }

  func maxActiveCount() -> Int {
    maxActive
  }

  private func resumeStartedWaiters() {
    let ready = startedWaiters.filter { started.count >= $0.count }
    startedWaiters.removeAll { started.count >= $0.count }
    for waiter in ready {
      waiter.continuation.resume()
    }
  }
}

final class ADETests: XCTestCase {
  func testDictationCleanupCapitalizesAfterLeadingSentencePunctuation() {
    let cleaned = DictationCleanup.clean("hello. \"goodbye\"", glossary: .empty)

    XCTAssertEqual(cleaned, "Hello. \"Goodbye\"")
  }

  func testDictationCleanupAllowsExpandedUppercaseCharacters() {
    let cleaned = DictationCleanup.clean("ßeta", glossary: .empty)

    XCTAssertEqual(cleaned, "SSeta")
  }

  func testDictationBufferConverterRecreatesWhenInputFormatChanges() throws {
    let converter = DictationBufferConverter()
    let outputFormat = try XCTUnwrap(AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 16_000,
      channels: 1,
      interleaved: false
    ))
    let firstInput = try XCTUnwrap(AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 44_100,
      channels: 1,
      interleaved: false
    ))
    let secondInput = try XCTUnwrap(AVAudioFormat(
      commonFormat: .pcmFormatFloat32,
      sampleRate: 48_000,
      channels: 1,
      interleaved: false
    ))
    let firstBuffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: firstInput, frameCapacity: 441))
    firstBuffer.frameLength = 441
    let secondBuffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: secondInput, frameCapacity: 480))
    secondBuffer.frameLength = 480

    XCTAssertNoThrow(try converter.convert(firstBuffer, to: outputFormat))
    XCTAssertNoThrow(try converter.convert(secondBuffer, to: outputFormat))
  }

  func testTerminalDisplayReplaysCarriageReturnProgressUpdates() {
    let output = sanitizeTerminalOutputForDisplay("Downloading 10%\rDownloading 80%\rDownloading 100%\nDone")

    XCTAssertEqual(output, "Downloading 100%\nDone")
  }

  func testTerminalDisplayHandlesEraseLineSpinners() {
    let output = sanitizeTerminalOutputForDisplay("Working -\r\u{001B}[KWorking \\\r\u{001B}[KComplete\n")

    XCTAssertEqual(output, "Complete")
  }

  func testTerminalDisplayAppliesCursorAddressingAndClearScreen() {
    let output = sanitizeTerminalOutputForDisplay("old screen\u{001B}[2J\u{001B}[Htop\nbottom\u{001B}[1A\u{001B}[Gmiddle")

    XCTAssertEqual(output, "middle\nbottom")
  }

  func testTerminalDisplayErasesFromCursorToEndOfScreen() {
    let absentParam = sanitizeTerminalOutputForDisplay("alpha\nbravo\ncharlie\u{001B}[2A\u{001B}[3G\u{001B}[JZ")
    let zeroParam = sanitizeTerminalOutputForDisplay("alpha\nbravo\ncharlie\u{001B}[2A\u{001B}[3G\u{001B}[0JZ")

    XCTAssertEqual(absentParam, "alZ")
    XCTAssertEqual(zeroParam, "alZ")
  }

  func testTerminalDisplayHandlesLineAndCharacterEditing() {
    XCTAssertEqual(
      sanitizeTerminalOutputForDisplay("one\ntwo\nthree\u{001B}[2A\u{001B}[G\u{001B}[M"),
      "two\nthree"
    )
    XCTAssertEqual(
      sanitizeTerminalOutputForDisplay("one\nthree\u{001B}[1A\u{001B}[G\u{001B}[Ltwo"),
      "two\none\nthree"
    )
    XCTAssertEqual(
      sanitizeTerminalOutputForDisplay("abcdef\u{001B}[1G\u{001B}[2P"),
      "cdef"
    )
  }

  func testTerminalDisplayStripsAnsiColorAndBackspaces() {
    let output = sanitizeTerminalOutputForDisplay("\u{001B}[31merr\u{001B}[0mor\u{0008}k")

    XCTAssertEqual(output, "errok")
  }

  @MainActor
  func testDeepLinkRouterRequestsWorkSessionNavigation() throws {
    let previousShared = SyncService.shared
    defer { SyncService.shared = previousShared }

    let database = makeDatabase(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    let service = SyncService(database: database)
    // Bind explicitly so the deep-link router routes through our test instance instead
    // of relying on initializer side effects to update SyncService.shared.
    SyncService.shared = service
    service.requestedWorkSessionNavigation = nil

    DeepLinkRouter.shared.handle(try XCTUnwrap(URL(string: "ade://session/session-123")))

    XCTAssertEqual(service.requestedWorkSessionNavigation?.sessionId, "session-123")
  }

  @MainActor
  func testDeepLinkRouterRequestsPrNavigationByNumberWhenSnapshotMisses() throws {
    let previousShared = SyncService.shared
    let previousSnapshotData = ADESharedContainer.defaults.data(forKey: ADESharedContainer.workspaceSnapshotKey)
    defer {
      SyncService.shared = previousShared
      if let previousSnapshotData {
        ADESharedContainer.defaults.set(previousSnapshotData, forKey: ADESharedContainer.workspaceSnapshotKey)
      } else {
        ADESharedContainer.defaults.removeObject(forKey: ADESharedContainer.workspaceSnapshotKey)
      }
    }

    ADESharedContainer.defaults.removeObject(forKey: ADESharedContainer.workspaceSnapshotKey)
    let database = makeDatabase(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    let service = SyncService(database: database)
    SyncService.shared = service

    DeepLinkRouter.shared.handleNotificationUserInfo(["prNumber": 9876])

    XCTAssertEqual(service.requestedPrNavigation?.prNumber, 9876)
    XCTAssertEqual(service.requestedPrNavigation?.prId, "github-pr-number:9876")
  }

  @MainActor
  func testPrIntentPayloadRequestsLocalPrNavigation() throws {
    let previousShared = SyncService.shared
    defer { SyncService.shared = previousShared }

    let database = makeDatabase(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    let service = SyncService(database: database)
    SyncService.shared = service

    requestPrNavigationFromIntentPayload([
      "prId": "pr_123",
      "prNumber": "42",
    ])

    XCTAssertEqual(service.requestedPrNavigation?.prId, "pr_123")
    XCTAssertEqual(service.requestedPrNavigation?.prNumber, 42)
  }

  @MainActor
  func testDeepLinkRouterSendsHttpsAdePrLinksToMac() throws {
    let expected = "https://ade-app.dev/open?type=pr&repo=arul/ADE&number=42"
    let received = expectation(description: "send to Mac request posted")
    var postedURL: String?
    let token = NotificationCenter.default.addObserver(
      forName: .adeSendToMacRequested,
      object: nil,
      queue: nil
    ) { note in
      postedURL = note.userInfo?["url"] as? String
      received.fulfill()
    }
    defer { NotificationCenter.default.removeObserver(token) }

    DeepLinkRouter.shared.handle(try XCTUnwrap(URL(string: expected)))

    wait(for: [received], timeout: 1)
    XCTAssertEqual(postedURL, expected)
  }

  func testSendToMacTargetParsesHttpsAdePrLinks() throws {
    let target = SendToMacTarget(
      url: try XCTUnwrap(URL(string: "https://ade-app.dev/open?type=pr&repo=arul/ADE&number=42"))
    )

    guard case .pr(let owner, let repo, let number) = target.kind else {
      return XCTFail("Expected PR Send-to-Mac target")
    }
    XCTAssertEqual(owner, "arul")
    XCTAssertEqual(repo, "ADE")
    XCTAssertEqual(number, 42)
    XCTAssertEqual(target.headline, "Pull request shared with you")
    XCTAssertEqual(target.detail, "#42 in arul/ADE")
  }

  @MainActor
  func testDeepLinkRouterStillAcceptsLegacyHttpsAdeLinks() throws {
    let expected = "https://ade.app/open?type=pr&repo=arul/ADE&number=42"
    let received = expectation(description: "legacy send to Mac request posted")
    var postedURL: String?
    let token = NotificationCenter.default.addObserver(
      forName: .adeSendToMacRequested,
      object: nil,
      queue: nil
    ) { note in
      postedURL = note.userInfo?["url"] as? String
      received.fulfill()
    }
    defer { NotificationCenter.default.removeObserver(token) }

    DeepLinkRouter.shared.handle(try XCTUnwrap(URL(string: expected)))

    wait(for: [received], timeout: 1)
    XCTAssertEqual(postedURL, expected)
  }

  func testDeepLinkRepoParserRejectsMalformedRepoValues() throws {
    let valid = try XCTUnwrap(ADEDeepLinkURLParsing.splitRepo("arul/ADE"))

    XCTAssertEqual(valid.owner, "arul")
    XCTAssertEqual(valid.repo, "ADE")
    XCTAssertNil(ADEDeepLinkURLParsing.splitRepo("arul/ADE/extra"))
    XCTAssertNil(ADEDeepLinkURLParsing.splitRepo("arul/"))
    XCTAssertNil(ADEDeepLinkURLParsing.splitRepo("/ADE"))
  }

  @MainActor
  func testTerminalEmulatorSkipsDuplicateRevisionRenders() {
    let view = ADETerminalTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 300))
    let coordinator = WorkTerminalEmulatorView.Coordinator { _ in }

    XCTAssertTrue(coordinator.render(rawText: "bash-3.2$ echo ok\nok\n", revision: 1, in: view))
    XCTAssertFalse(coordinator.render(rawText: "bash-3.2$ echo ok\nok\n", revision: 2, in: view))
    XCTAssertTrue(coordinator.render(rawText: "bash-3.2$ echo ok\nok\nbash-3.2$ ", revision: 3, in: view))
  }

  @MainActor
  func testTerminalViewportRevisionOnlyUpdateDoesNotRerender() {
    let view = ADETerminalTextView(frame: CGRect(x: 0, y: 0, width: 320, height: 300))
    let coordinator = WorkTerminalEmulatorView.Coordinator { _ in }

    XCTAssertTrue(
      coordinator.updateViewport(
        WorkTerminalViewport(cols: 48, rows: 12),
        rawText: "one\n",
        revision: 1,
        view: view
      )
    )
    XCTAssertFalse(
      coordinator.updateViewport(
        WorkTerminalViewport(cols: 48, rows: 13),
        rawText: "one\n",
        revision: 2,
        view: view
      )
    )
  }

  func testShellCliPermissionModeDoesNotInheritRuntimeMode() {
    XCTAssertNil(workCliPermissionMode(provider: "shell", runtimeMode: "plan"))
    XCTAssertEqual(workCliPermissionMode(provider: "codex", runtimeMode: "plan"), "plan")
    XCTAssertEqual(workCliPermissionMode(provider: "claude", runtimeMode: "auto"), "auto")
  }

  func testMobileRuntimeModeOptionsMirrorDesktopAndTuiProviders() {
    XCTAssertEqual(workRuntimeModeOptions(provider: "claude").map(\.id), ["default", "auto", "edit", "plan", "full-auto"])
    XCTAssertEqual(workRuntimeModeOptions(provider: "codex").map(\.id), ["default", "edit", "plan", "full-auto", "config-toml"])
    XCTAssertEqual(workRuntimeModeOptions(provider: "opencode").map(\.id), ["plan", "edit", "full-auto", "config-toml"])
    XCTAssertEqual(workRuntimeModeOptions(provider: "cursor").map(\.id), ["default", "plan", "edit", "full-auto"])
    XCTAssertEqual(workRuntimeModeOptions(provider: "droid").map(\.id), ["read-only", "auto-low", "auto-medium", "auto-high", "agi"])

    let claudeAuto = workRuntimeWireFields(provider: "claude", mode: "auto")
    XCTAssertEqual(claudeAuto.permissionMode, "auto")
    XCTAssertEqual(claudeAuto.claudePermissionMode, "auto")
    XCTAssertEqual(claudeAuto.interactionMode, "default")

    let codexEdit = workRuntimeWireFields(provider: "codex", mode: "edit")
    XCTAssertEqual(codexEdit.permissionMode, "edit")
    XCTAssertEqual(codexEdit.codexApprovalPolicy, "untrusted")
    XCTAssertEqual(codexEdit.codexSandbox, "workspace-write")

    let cursorAsk = workRuntimeWireFields(provider: "cursor", mode: "edit")
    XCTAssertEqual(cursorAsk.permissionMode, "edit")
    XCTAssertEqual(cursorAsk.cursorModeId, "ask")

    let opencodeLegacyDefault = workRuntimeWireFields(provider: "opencode", mode: "default")
    XCTAssertEqual(opencodeLegacyDefault.permissionMode, "edit")
    XCTAssertEqual(opencodeLegacyDefault.opencodePermissionMode, "edit")
    XCTAssertEqual(workInitialRuntimeMode(makeAgentChatSessionSummary(
      provider: "opencode",
      status: "active",
      permissionMode: "default"
    )), "edit")

    let droidHigh = workRuntimeWireFields(provider: "droid", mode: "auto-high")
    XCTAssertEqual(droidHigh.permissionMode, "full-auto")
    XCTAssertEqual(droidHigh.droidPermissionMode, "auto-high")

    let droidAgi = workRuntimeWireFields(provider: "droid", mode: "agi")
    XCTAssertEqual(droidAgi.permissionMode, "plan")
    XCTAssertEqual(droidAgi.droidPermissionMode, "agi")
    XCTAssertEqual(workDroidRuntimeMode(droidPermissionMode: "agi", permissionMode: "plan"), "agi")
    XCTAssertEqual(workDroidModeFromPermissionMode("edit"), "auto-low")
  }

  func testResolvedWorkArchivedSessionIdsKeepsLocalOverrideForKnownChat() {
    let summary = makeAgentChatSessionSummary(
      sessionId: "chat-known",
      status: "idle",
      archivedAt: nil
    )

    let archived = resolvedWorkArchivedSessionIds(
      localStorage: "chat-known\nchat-local",
      chatSummaries: ["chat-known": summary]
    )

    XCTAssertEqual(archived, ["chat-known", "chat-local"])
  }

  func testResolvedWorkArchivedSessionIdsReadsHydratedTerminalArchiveState() {
    let session = makeTerminalSessionSummary(
      id: "chat-hydrated",
      toolType: "codex-chat",
      archivedAt: "2026-05-18T13:04:31.483Z"
    )

    let archived = resolvedWorkArchivedSessionIds(
      localStorage: "",
      chatSummaries: [:],
      sessions: [session]
    )

    XCTAssertEqual(archived, ["chat-hydrated"])
  }

  func testResolvedWorkNavigationLaneIdKeepsKnownLaneId() {
    let session = makeTerminalSessionSummary(laneId: "lane-active", laneName: "Active", toolType: "codex-chat")
    let lanes = [makeLaneSummary(id: "lane-active", name: "Active", laneType: "worktree", branchRef: "ade/active")]

    XCTAssertEqual(resolvedWorkNavigationLaneId(for: session, lanes: lanes), "lane-active")
  }

  func testResolvedWorkNavigationLaneIdMapsStalePrimarySessionToActivePrimary() {
    let session = makeTerminalSessionSummary(laneId: "lane-stale-primary", laneName: "Primary", toolType: "codex-chat")
    let lanes = [
      makeLaneSummary(id: "lane-active-primary", name: "Primary", laneType: "primary", branchRef: "main"),
      makeLaneSummary(id: "lane-feature", name: "Feature", laneType: "worktree", branchRef: "ade/feature")
    ]

    XCTAssertEqual(resolvedWorkNavigationLaneId(for: session, lanes: lanes), "lane-active-primary")
  }

  func testResolvedWorkNavigationLaneIdFallsBackToMatchingNameOrBranch() {
    let renamedSession = makeTerminalSessionSummary(laneId: "lane-stale", laneName: "Feature Lane", toolType: "codex-chat")
    let branchSession = makeTerminalSessionSummary(laneId: "lane-stale-branch", laneName: "ade/feature-lane", toolType: "codex-chat")
    let lanes = [
      makeLaneSummary(id: "lane-by-name", name: "Feature Lane", laneType: "worktree", branchRef: "ade/other"),
      makeLaneSummary(id: "lane-by-branch", name: "Other Lane", laneType: "worktree", branchRef: "ade/feature-lane")
    ]

    XCTAssertEqual(resolvedWorkNavigationLaneId(for: renamedSession, lanes: lanes), "lane-by-name")
    XCTAssertEqual(resolvedWorkNavigationLaneId(for: branchSession, lanes: lanes), "lane-by-branch")
  }

  func testWorkSessionDeepLinkMatchesDesktopSessionFormat() {
    XCTAssertEqual(
      workSessionDeepLink(sessionId: "session 1/2", laneId: "lane&active"),
      "ade://session/session%201%2F2?lane=lane%26active"
    )
    XCTAssertEqual(
      workSessionDeepLink(sessionId: "session-plain", laneId: "   "),
      "ade://session/session-plain"
    )
  }

  func testLaneTreeDisplayDepthUsesPersistedStackDepth() {
    var directChild = makeLaneSummary(id: "lane-child", name: "Child", laneType: "worktree", branchRef: "ade/child")
    directChild.parentLaneId = "lane-primary"
    directChild.stackDepth = 1
    var grandchild = makeLaneSummary(id: "lane-grandchild", name: "Grandchild", laneType: "worktree", branchRef: "ade/grandchild")
    grandchild.parentLaneId = directChild.id
    grandchild.stackDepth = 2
    var invalidDepth = directChild
    invalidDepth.stackDepth = -1

    XCTAssertEqual(laneTreeDisplayDepth(for: directChild), 1)
    XCTAssertEqual(laneTreeDisplayDepth(for: grandchild), 2)
    XCTAssertEqual(laneTreeDisplayDepth(for: invalidDepth), 0)
  }

  func testTerminalDisplayPreservesAnsiRunsForRendering() {
    let display = workTerminalDisplay(
      raw: "\u{001B}[31mError\u{001B}[0m plain \u{001B}[32;1mOK\u{001B}[0m",
      fallback: nil
    )

    XCTAssertEqual(display.text, "Error plain OK")
    XCTAssertEqual(String(display.attributedText.characters), "Error plain OK")
    XCTAssertGreaterThan(Array(display.attributedText.runs).count, 1)
  }

  func testTerminalDisplayPreservesIndentedOutput() {
    let output = sanitizeTerminalOutputForDisplay("if true {\n    print(\"ok\")\n}\n")

    XCTAssertEqual(output, "if true {\n    print(\"ok\")\n}")
  }

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

  func testCommandEnvelopePayloadIncludesProjectScope() throws {
    let payload = syncCommandEnvelopePayload(
      commandId: "cmd-1",
      action: "lanes.create",
      args: ["name": "Feature lane"],
      projectId: " project-1 ",
      projectRootPath: " /tmp/project-one/ "
    )

    XCTAssertEqual(payload["commandId"] as? String, "cmd-1")
    XCTAssertEqual(payload["action"] as? String, "lanes.create")
    XCTAssertEqual(payload["projectId"] as? String, "project-1")
    XCTAssertEqual(payload["projectRootPath"] as? String, "/tmp/project-one")
    let args = try XCTUnwrap(payload["args"] as? [String: Any])
    XCTAssertEqual(args["name"] as? String, "Feature lane")
  }

  func testCommandEnvelopePayloadOmitsBlankProjectScope() {
    let payload = syncCommandEnvelopePayload(
      commandId: "cmd-1",
      action: "lanes.list",
      args: [:],
      projectId: "  ",
      projectRootPath: "  "
    )

    XCTAssertNil(payload["projectId"])
    XCTAssertNil(payload["projectRootPath"])
  }

  func testMakeLanesReparentArgsUsesTrimmedParentLaneIdAndOmitsBaseOverride() throws {
    let args = makeLanesReparentArgs(
      laneId: "lane-1",
      newParentLaneId: "  lane-primary  ",
      stackBaseBranchRef: nil
    )

    XCTAssertEqual(args["laneId"] as? String, "lane-1")
    XCTAssertEqual(args["newParentLaneId"] as? String, "lane-primary")
    // No stackBaseBranchRef in the payload -- host falls back to the parent's current branch.
    XCTAssertNil(args["stackBaseBranchRef"])
  }

  func testMakeLanesReparentArgsIncludesTrimmedStackBaseBranchOverride() throws {
    let args = makeLanesReparentArgs(
      laneId: "lane-1",
      newParentLaneId: "lane-parent",
      stackBaseBranchRef: "  feature/integration  "
    )

    XCTAssertEqual(args["newParentLaneId"] as? String, "lane-parent")
    XCTAssertEqual(args["stackBaseBranchRef"] as? String, "feature/integration")
  }

  func testMakeLanesReparentArgsOmitsWhitespaceOnlyStackBaseBranchOverride() throws {
    let args = makeLanesReparentArgs(
      laneId: "lane-1",
      newParentLaneId: "lane-parent",
      stackBaseBranchRef: "   "
    )

    XCTAssertEqual(args["newParentLaneId"] as? String, "lane-parent")
    XCTAssertNil(args["stackBaseBranchRef"])
  }

  func testMakePrGithubSnapshotArgsIncludesExternalClosedOnlyWhenRequested() throws {
    let defaultArgs = makePrGithubSnapshotArgs(force: false, includeExternalClosed: false)
    XCTAssertEqual(defaultArgs["force"] as? Bool, false)
    XCTAssertNil(defaultArgs["includeExternalClosed"])

    let historyArgs = makePrGithubSnapshotArgs(force: true, includeExternalClosed: true)
    XCTAssertEqual(historyArgs["force"] as? Bool, true)
    XCTAssertEqual(historyArgs["includeExternalClosed"] as? Bool, true)
  }

  func testProjectScopedOutboundEnvelopeTypesIncludeActiveProjectId() {
    let projectScopedTypes = [
      "changeset_batch",
      "changeset_ack",
      "command",
      "file_request",
      "terminal_subscribe",
      "terminal_unsubscribe",
      "terminal_input",
      "terminal_resize",
      "chat_subscribe",
      "chat_unsubscribe",
    ]

    for type in projectScopedTypes {
      XCTAssertEqual(
        syncOutboundEnvelopeProjectId(type: type, activeProjectId: " project-1 "),
        "project-1",
        "\(type) should carry the active project id"
      )
    }
  }

  func testRuntimeScopedOutboundEnvelopeTypesRemainProjectless() {
    let runtimeScopedTypes = [
      "hello",
      "pairing_request",
      "project_catalog_request",
      "project_switch_request",
      "project_browse_request",
      "project_default_parent_dir_request",
      "project_open_request",
      "project_create_request",
      "project_clone_request",
      "project_list_my_github_repos_request",
      "heartbeat",
    ]

    for type in runtimeScopedTypes {
      XCTAssertNil(
        syncOutboundEnvelopeProjectId(type: type, activeProjectId: "project-1"),
        "\(type) should not inherit the active project id"
      )
    }
    XCTAssertNil(syncOutboundEnvelopeProjectId(type: "file_request", activeProjectId: "  "))
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
      XCTAssertEqual((error as NSError).localizedDescription, "The machine returned incomplete lane data. Pull to retry or reconnect the machine.")
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
    XCTAssertEqual(SyncRequestTimeout.chatSendTimeoutNanoseconds, 120_000_000_000)
    XCTAssertEqual(SyncRequestTimeout.commandTimeoutNanoseconds(for: "lanes.delete"), 240_000_000_000)
    XCTAssertEqual(SyncRequestTimeout.commandTimeoutNanoseconds(for: "lanes.rename"), 30_000_000_000)
    XCTAssertEqual(SyncRequestTimeout.error().localizedDescription, "The machine took too long to respond. Reconnecting now.")
    XCTAssertEqual(
      SyncRequestTimeout.error(message: SyncRequestTimeout.chatSendMessage).localizedDescription,
      "The machine is still starting this chat turn. Live updates will keep syncing."
    )
  }

  func testSyncRequestTimeoutOnlyReconnectsAfterSocketSilence() {
    XCTAssertFalse(
      syncShouldReconnectAfterRequestTimeout(
        now: 100,
        lastInboundMessageAt: 94,
        silenceThreshold: 12
      )
    )
    XCTAssertTrue(
      syncShouldReconnectAfterRequestTimeout(
        now: 100,
        lastInboundMessageAt: 80,
        silenceThreshold: 12
      )
    )
    XCTAssertTrue(
      syncShouldReconnectAfterRequestTimeout(
        now: 100,
        lastInboundMessageAt: nil,
        silenceThreshold: 12
      )
    )
  }

  func testCommandSendFailureQueuePolicyPreservesQueueableTimeoutsOnly() {
    XCTAssertTrue(
      syncShouldQueueCommandAfterSendFailure(
        error: SyncRequestTimeout.error(),
        canSendLiveRequests: true,
        queueable: true
      )
    )
    XCTAssertTrue(
      syncShouldQueueCommandAfterSendFailure(
        error: NSError(domain: NSURLErrorDomain, code: NSURLErrorTimedOut),
        canSendLiveRequests: false,
        queueable: true
      )
    )

    let error = NSError(
      domain: "ADE",
      code: 17,
      userInfo: [
        NSLocalizedDescriptionKey: "Remote command failed.",
        "ADEErrorCode": "command_failed",
      ]
    )

    XCTAssertFalse(
      syncShouldQueueCommandAfterSendFailure(
        error: error,
        canSendLiveRequests: false,
        queueable: true
      )
    )
    XCTAssertFalse(
      syncShouldQueueCommandAfterSendFailure(
        error: SyncRequestTimeout.error(),
        canSendLiveRequests: true,
        queueable: false
      )
    )
  }

  func testSyncConnectionHealthTreatsSyncingAsConnectedTransport() {
    let health = syncConnectionHealth(
      connectionState: .syncing,
      prefersReducedSyncLoad: false,
      lastError: "Transient sync work"
    )

    XCTAssertEqual(health.transport, .connected)
    XCTAssertEqual(health.load, .normal)
    XCTAssertNil(health.lastFailureMessage)
  }

  func testSyncConnectionHealthSeparatesLoadStrainFromTransportFailure() {
    let health = syncConnectionHealth(
      connectionState: .connected,
      prefersReducedSyncLoad: true,
      lastError: "The host took too long to respond."
    )

    XCTAssertEqual(health.transport, .connected)
    XCTAssertEqual(health.load, .strained)
    XCTAssertNil(health.lastFailureMessage)
  }

  func testSyncConnectionHealthSurfacesFailureOnlyWhenUnreachable() {
    let health = syncConnectionHealth(
      connectionState: .error,
      prefersReducedSyncLoad: true,
      lastError: "Heartbeat timed out."
    )

    XCTAssertEqual(health.transport, .unreachable)
    XCTAssertEqual(health.load, .normal)
    XCTAssertEqual(health.lastFailureMessage, "Heartbeat timed out.")
  }

  func testSyncConnectionHealthHidesStaleFailureWhenDisconnected() {
    let health = syncConnectionHealth(
      connectionState: .disconnected,
      prefersReducedSyncLoad: true,
      lastError: "Previous socket failed."
    )

    XCTAssertEqual(health.transport, .disconnected)
    XCTAssertEqual(health.load, .normal)
    XCTAssertNil(health.lastFailureMessage)
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

  func testSyncRecognizesTailscaleRoutes() {
    XCTAssertTrue(syncIsTailscaleRoute("100.117.237.95"))
    XCTAssertTrue(syncIsTailscaleRoute("ws://100.117.237.95:8787"))
    XCTAssertTrue(syncIsTailscaleRoute("HTTPS://ADE-SYNC:8787/sync?source=settings"))
    XCTAssertTrue(syncIsTailscaleRoute("ade-sync"))
    XCTAssertTrue(syncIsTailscaleRoute("macbook.tailnet.ts.net"))
    XCTAssertEqual(syncNormalizedRouteHost("ws://MACBOOK.tailnet.ts.net:8787/sync"), "macbook.tailnet.ts.net")
    XCTAssertFalse(syncIsTailscaleRoute("192.168.68.102"))
    XCTAssertFalse(syncIsTailscaleRoute("mac.local"))
    XCTAssertFalse(syncIsTailscaleRoute("not-ts.net.example.com"))
  }

  func testBonjourHostParsesHeadlessRuntimeProjectTxtFields() {
    let host = syncDiscoveredHostFromBonjour(
      serviceKey: "local|_ade-sync._tcp.|ADE Sync studio",
      serviceName: "ADE Sync studio",
      serviceHostName: "studio.local.",
      servicePort: 0,
      txtRecord: [
        "host": "192.168.1.240",
        "addresses": "127.0.0.1, 100.75.20.63",
        "deviceName": "studio",
        "deviceId": "device-1",
        "runtimeKind": "headless",
        "runtimeVersion": "0.0.0",
        "projects": "project-a, project-b",
        "projectNames": "ADE, Website",
        "projectCount": "2",
        "tailscaleDnsName": "macbook.tailnet.ts.net",
        "tailscaleIp": "100.75.20.63",
        "port": "8787",
      ],
      resolvedAddresses: ["127.0.0.1", "192.168.1.240"],
      lastResolvedAt: "2026-05-10T10:00:00.000Z"
    )

    XCTAssertEqual(host.id, "device-1")
    XCTAssertEqual(host.hostName, "studio")
    XCTAssertEqual(host.hostIdentity, "device-1")
    XCTAssertEqual(host.port, 8787)
    XCTAssertEqual(host.runtimeKind, "headless")
    XCTAssertEqual(host.runtimeVersion, "0.0.0")
    XCTAssertEqual(host.projectIds, ["project-a", "project-b"])
    XCTAssertEqual(host.projectNames, ["ADE", "Website"])
    XCTAssertEqual(host.projectCount, 2)
    XCTAssertEqual(host.tailscaleAddress, "macbook.tailnet.ts.net")
    XCTAssertEqual(host.addresses, ["192.168.1.240", "100.75.20.63", "127.0.0.1"])
  }

  func testBonjourHostFallsBackForOlderDesktopTxtRecords() {
    let host = syncDiscoveredHostFromBonjour(
      serviceKey: "local|_ade-sync._tcp.|ADE Sync legacy",
      serviceName: "ADE Sync legacy",
      serviceHostName: nil,
      servicePort: 0,
      txtRecord: [
        "deviceName": "  ",
        "deviceId": "  ",
        "runtimeKind": "  ",
        "runtimeVersion": "  ",
        "projects": "  ",
        "projectNames": "  ",
        "projectCount": "unknown",
        "addresses": "  ",
      ],
      resolvedAddresses: [],
      lastResolvedAt: "2026-05-10T10:00:00.000Z"
    )

    XCTAssertEqual(host.id, "local|_ade-sync._tcp.|ADE Sync legacy")
    XCTAssertEqual(host.hostName, "ADE Sync legacy")
    XCTAssertEqual(host.port, 8787)
    XCTAssertNil(host.hostIdentity)
    XCTAssertNil(host.runtimeKind)
    XCTAssertNil(host.runtimeVersion)
    XCTAssertTrue(host.projectIds.isEmpty)
    XCTAssertTrue(host.projectNames.isEmpty)
    XCTAssertNil(host.projectCount)
    XCTAssertTrue(host.addresses.isEmpty)
  }

  func testBonjourHostUsesServiceHostnameWhenTxtAndResolvedAddressesLag() {
    let host = syncDiscoveredHostFromBonjour(
      serviceKey: "local|_ade-sync._tcp.|ADE Sync studio 8787",
      serviceName: "ADE Sync studio 8787",
      serviceHostName: "studio.local.",
      servicePort: -1,
      txtRecord: [:],
      resolvedAddresses: [],
      lastResolvedAt: "2026-05-10T10:00:00.000Z"
    )

    XCTAssertEqual(host.hostName, "studio.local.")
    XCTAssertEqual(host.port, 8787)
    XCTAssertEqual(host.addresses, ["studio.local"])
  }

  func testSavedDiscoveredHostsDisplayLiveRuntimeMetadata() {
    let savedHost = DiscoveredSyncHost(
      id: "saved-device-1",
      serviceName: "Saved ADE",
      hostName: "Mac Studio",
      hostIdentity: "device-1",
      port: 8787,
      addresses: ["192.168.1.240"],
      tailscaleAddress: nil,
      lastResolvedAt: "2026-05-10T09:59:00.000Z"
    )
    let liveHost = DiscoveredSyncHost(
      id: "device-1",
      serviceName: "ADE Sync studio",
      hostName: "Mac Studio",
      hostIdentity: "device-1",
      port: 8787,
      addresses: ["192.168.1.240", "127.0.0.1"],
      tailscaleAddress: "macbook.tailnet.ts.net",
      runtimeKind: "headless",
      runtimeVersion: "0.0.0",
      projectIds: ["project-a", "project-b"],
      projectNames: ["ADE", "Website"],
      projectCount: 2,
      lastResolvedAt: "2026-05-10T10:00:00.000Z"
    )

    let displayed = syncDiscoveredHostsForDisplay(savedHosts: [savedHost], liveHosts: [liveHost])

    XCTAssertTrue(displayed.liveHosts.isEmpty)
    XCTAssertEqual(displayed.savedHosts.count, 1)
    XCTAssertEqual(displayed.savedHosts[0].runtimeKind, "headless")
    XCTAssertEqual(displayed.savedHosts[0].runtimeVersion, "0.0.0")
    XCTAssertEqual(displayed.savedHosts[0].projectIds, ["project-a", "project-b"])
    XCTAssertEqual(displayed.savedHosts[0].projectNames, ["ADE", "Website"])
    XCTAssertEqual(displayed.savedHosts[0].projectCount, 2)
    XCTAssertEqual(displayed.savedHosts[0].tailscaleAddress, "macbook.tailnet.ts.net")
    XCTAssertEqual(
      syncDiscoveredHostDetailText(host: displayed.savedHosts[0], detailPrefix: "Saved"),
      "ADE brain 0.0.0 · Saved"
    )
  }

  func testDiscoveredHostsDisplayCoalescesDuplicateLiveRoutes() {
    let staleName = DiscoveredSyncHost(
      id: "stale-device",
      serviceName: "ADE Sync stale",
      hostName: "MacBook-Pro-567.local",
      hostIdentity: "machine-1",
      port: 8787,
      addresses: ["MacBook-Pro-567.local", "192.168.1.249"],
      tailscaleAddress: "100.75.21.10",
      runtimeKind: "daemon",
      runtimeVersion: "1.0.0-beta.1",
      projectIds: ["project-a"],
      projectNames: ["ADE"],
      projectCount: 1,
      lastResolvedAt: "2026-05-10T10:00:00.000Z"
    )
    let friendlyName = DiscoveredSyncHost(
      id: "fresh-device",
      serviceName: "ADE Sync fresh",
      hostName: "lappy",
      hostIdentity: "machine-1",
      port: 8787,
      addresses: ["192.168.1.249"],
      tailscaleAddress: "100.75.21.10",
      runtimeKind: "daemon",
      runtimeVersion: "1.0.0-beta.1",
      projectIds: ["project-b", "project-a"],
      projectNames: ["Versic", "ADE"],
      projectCount: 2,
      lastResolvedAt: "2026-05-10T10:00:01.000Z"
    )

    let displayed = syncDiscoveredHostsForDisplay(savedHosts: [], liveHosts: [staleName, friendlyName])

    XCTAssertEqual(displayed.savedHosts.count, 0)
    XCTAssertEqual(displayed.liveHosts.count, 1)
    XCTAssertEqual(displayed.liveHosts[0].hostName, "lappy")
    XCTAssertEqual(displayed.liveHosts[0].addresses, ["192.168.1.249", "MacBook-Pro-567.local"])
    XCTAssertEqual(displayed.liveHosts[0].projectNames, ["Versic", "ADE"])
    XCTAssertEqual(displayed.liveHosts[0].projectCount, 2)
  }

  func testDiscoveredHostsDisplayCoalescesDuplicateLiveRoutesAcrossPorts() {
    let pairService = DiscoveredSyncHost(
      id: "pair-service",
      serviceName: "ADE Pair",
      hostName: "MacBook-Pro-567.local",
      hostIdentity: "machine-1",
      port: 8787,
      addresses: ["192.168.1.249"],
      tailscaleAddress: nil,
      runtimeKind: "daemon",
      runtimeVersion: "1.0.0-beta.1",
      projectIds: ["project-a"],
      projectNames: ["ADE"],
      projectCount: 1,
      lastResolvedAt: "2026-05-10T10:00:00.000Z"
    )
    let runtimeService = DiscoveredSyncHost(
      id: "runtime-service",
      serviceName: "ADE Runtime",
      hostName: "lappy",
      hostIdentity: "machine-1",
      port: 8790,
      addresses: ["192.168.1.249"],
      tailscaleAddress: nil,
      runtimeKind: "daemon",
      runtimeVersion: "1.0.0-beta.1",
      projectIds: ["project-b", "project-a"],
      projectNames: ["Versic", "ADE"],
      projectCount: 2,
      lastResolvedAt: "2026-05-10T10:00:01.000Z"
    )

    let displayed = syncDiscoveredHostsForDisplay(savedHosts: [], liveHosts: [pairService, runtimeService])

    XCTAssertEqual(displayed.liveHosts.count, 1)
    XCTAssertEqual(displayed.liveHosts[0].hostName, "lappy")
    XCTAssertEqual(displayed.liveHosts[0].port, 8790)
    XCTAssertEqual(displayed.liveHosts[0].addresses, ["192.168.1.249"])
    XCTAssertEqual(displayed.liveHosts[0].projectNames, ["Versic", "ADE"])
  }

  func testDiscoveredHostsDisplayKeepsDistinctLanHostsWithSharedTailnetMetadata() {
    let currentMachine = DiscoveredSyncHost(
      id: "current-machine",
      serviceName: "ADE Runtime current",
      hostName: "Mac.lan",
      hostIdentity: "current-machine",
      port: 8787,
      addresses: ["192.168.1.240", "192.168.1.249"],
      tailscaleAddress: "100.75.20.63",
      runtimeKind: "daemon",
      runtimeVersion: "1.0.0-beta.1",
      projectIds: ["project-a"],
      projectNames: ["ADE"],
      projectCount: 1,
      lastResolvedAt: "2026-05-10T10:00:00.000Z"
    )
    let otherMachine = DiscoveredSyncHost(
      id: "other-machine",
      serviceName: "ADE Runtime other",
      hostName: "lappy",
      hostIdentity: "other-machine",
      port: 8790,
      addresses: ["192.168.1.249"],
      tailscaleAddress: "100.75.20.63",
      runtimeKind: "daemon",
      runtimeVersion: "1.0.0-beta.1",
      projectIds: ["project-b"],
      projectNames: ["Versic"],
      projectCount: 1,
      lastResolvedAt: "2026-05-10T10:00:01.000Z"
    )

    let displayed = syncDiscoveredHostsForDisplay(savedHosts: [], liveHosts: [currentMachine, otherMachine])

    XCTAssertEqual(displayed.liveHosts.map(\.hostName), ["Mac.lan", "lappy"])
  }

  @MainActor
  func testSyncMergesDuplicateBonjourHostsByDeviceIdentityWithProjectMetadata() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let olderHost = DiscoveredSyncHost(
      id: "device-1::local|_ade-sync._tcp.|ADE Sync studio 8787",
      serviceName: "ADE Sync studio 8787",
      hostName: "Studio",
      hostIdentity: "device-1",
      port: 8787,
      addresses: ["192.168.1.240"],
      tailscaleAddress: nil,
      runtimeKind: "daemon",
      runtimeVersion: "1.0.0",
      projectIds: ["project-a"],
      projectNames: ["ADE"],
      projectCount: 1,
      lastResolvedAt: "2026-05-10T10:00:00.000Z"
    )
    let newerHost = DiscoveredSyncHost(
      id: "device-1::local|_ade-sync._tcp.|ADE Sync studio 8788",
      serviceName: "ADE Sync studio 8788",
      hostName: "Studio",
      hostIdentity: "device-1",
      port: 8788,
      addresses: ["10.0.0.8", "192.168.1.240"],
      tailscaleAddress: "macbook.tailnet.ts.net",
      runtimeKind: "headless",
      runtimeVersion: "2.0.0",
      projectIds: ["project-b", "project-a"],
      projectNames: ["Website", "ADE"],
      projectCount: 2,
      lastResolvedAt: "2026-05-10T10:00:01.000Z"
    )

    service.applyDiscoveredHostsForTesting([olderHost, newerHost])

    XCTAssertEqual(service.discoveredHosts.count, 1)
    let merged = service.discoveredHosts[0]
    XCTAssertEqual(merged.id, "device-1")
    XCTAssertEqual(merged.hostIdentity, "device-1")
    XCTAssertEqual(merged.port, 8788)
    XCTAssertEqual(merged.addresses, ["10.0.0.8", "192.168.1.240"])
    XCTAssertEqual(merged.tailscaleAddress, "macbook.tailnet.ts.net")
    XCTAssertEqual(merged.runtimeKind, "headless")
    XCTAssertEqual(merged.runtimeVersion, "2.0.0")
    XCTAssertEqual(merged.projectIds, ["project-b", "project-a"])
    XCTAssertEqual(merged.projectNames, ["Website", "ADE"])
    XCTAssertEqual(merged.projectCount, 2)
    XCTAssertEqual(merged.lastResolvedAt, "2026-05-10T10:00:01.000Z")
  }

  func testSyncParsesManualRouteEndpointInputs() throws {
    XCTAssertEqual(
      syncParseRouteEndpoint("100.75.20.63:8788"),
      SyncRouteEndpoint(host: "100.75.20.63", port: 8788)
    )
    XCTAssertEqual(
      syncParseRouteEndpoint("ws://100.75.20.63:8788/sync"),
      SyncRouteEndpoint(host: "100.75.20.63", port: 8788)
    )
    XCTAssertEqual(
      syncParseRouteEndpoint("wss://sync.ade.example:443/sync"),
      SyncRouteEndpoint(scheme: "wss", host: "sync.ade.example", port: 443)
    )
    XCTAssertEqual(
      syncParseRouteEndpoint("aruls-mac-studio.tail7497a6.ts.net:8788"),
      SyncRouteEndpoint(host: "aruls-mac-studio.tail7497a6.ts.net", port: 8788)
    )
    XCTAssertEqual(
      syncParseRouteEndpoint("[fd7a:115c:a1e0::1]:8788"),
      SyncRouteEndpoint(host: "fd7a:115c:a1e0::1", port: 8788)
    )
    XCTAssertEqual(
      syncParseRouteEndpoint("fd7a:115c:a1e0::1"),
      SyncRouteEndpoint(host: "fd7a:115c:a1e0::1", port: nil)
    )
  }

  func testSyncBuildsWebSocketURLFromHostPortInput() {
    XCTAssertEqual(
      syncWebSocketURLString(host: "100.75.20.63:8788", port: 8787),
      "ws://100.75.20.63:8788"
    )
    XCTAssertEqual(
      syncWebSocketURLString(host: "[fd7a:115c:a1e0::1]:8788", port: 8787),
      "ws://[fd7a:115c:a1e0::1]:8788"
    )
    XCTAssertEqual(
      syncWebSocketURLString(host: "wss://sync.ade.example:443/sync", port: 8787),
      "wss://sync.ade.example:443"
    )
  }

  func testSyncConnectPortCandidatesFallbackBetweenAdeDefaultPorts() {
    XCTAssertEqual(
      syncConnectPortCandidates(primaryPort: 8787, addresses: ["100.75.20.63"]),
      SyncDirectHostPorts.portCandidates
    )
    XCTAssertEqual(
      syncConnectPortCandidates(primaryPort: 8788, addresses: ["192.168.1.10"]),
      [8788] + SyncDirectHostPorts.portCandidates.filter { $0 != 8788 }
    )
    XCTAssertEqual(
      syncConnectPortCandidates(primaryPort: 9000, addresses: ["100.75.20.63"]),
      [9000] + SyncDirectHostPorts.portCandidates
    )
    XCTAssertEqual(
      syncConnectPortCandidates(primaryPort: 9000, addresses: ["192.168.1.10"]),
      [9000]
    )
    XCTAssertTrue(
      syncConnectPortCandidates(primaryPort: 8790, addresses: ["100.75.20.63"]).contains(8803)
    )
    XCTAssertTrue(
      syncConnectPortCandidates(primaryPort: 8790, addresses: ["100.75.20.63"]).contains(SyncDirectHostPorts.fallbackMaxPort)
    )
    XCTAssertEqual(SyncTailnetDiscovery.portCandidates, SyncDirectHostPorts.portCandidates)
  }

  func testSyncRoamDecisionUsesSavedTailnetWhenWifiDrops() {
    XCTAssertTrue(
      syncShouldRoamToTailnet(
        currentAddress: "192.168.1.8",
        hasTailnetRoute: true,
        usesWiFi: false,
        usesCellular: false,
        usesWiredEthernet: false
      )
    )
    XCTAssertTrue(
      syncShouldRoamToTailnet(
        currentAddress: "192.168.1.8",
        hasTailnetRoute: true,
        usesWiFi: false,
        usesCellular: true,
        usesWiredEthernet: false
      )
    )
    XCTAssertFalse(
      syncShouldRoamToTailnet(
        currentAddress: "100.75.20.63",
        hasTailnetRoute: true,
        usesWiFi: false,
        usesCellular: true,
        usesWiredEthernet: false
      )
    )
    XCTAssertFalse(
      syncShouldRoamToTailnet(
        currentAddress: "192.168.1.8",
        hasTailnetRoute: false,
        usesWiFi: false,
        usesCellular: true,
        usesWiredEthernet: false
      )
    )
  }

  func testSyncReducedLoadStartsConservativeThenPromotesOnHealthySamples() {
    XCTAssertTrue(
      syncPrefersReducedNetworkLoad(
        currentAddress: "100.75.20.63",
        usesWiFi: true,
        usesCellular: false,
        usesWiredEthernet: false,
        isExpensive: false,
        isConstrained: false
      )
    )

    XCTAssertFalse(
      syncShouldUseReducedNetworkLoad(
        initialPreference: true,
        isConstrained: false,
        forcedReduced: false,
        healthySampleCount: 3,
        poorSampleCount: 0
      )
    )
  }

  func testSyncReducedLoadStaysOnForConstrainedOrStrainedLinks() {
    XCTAssertTrue(
      syncShouldUseReducedNetworkLoad(
        initialPreference: false,
        isConstrained: true,
        forcedReduced: false,
        healthySampleCount: 5,
        poorSampleCount: 0
      )
    )
    XCTAssertTrue(
      syncShouldUseReducedNetworkLoad(
        initialPreference: false,
        isConstrained: false,
        forcedReduced: false,
        healthySampleCount: 5,
        poorSampleCount: 1
      )
    )
  }

  func testSyncLoadSampleDoesNotTreatBacklogAsWeakConnection() {
    let catchUp = syncConnectionLoadSample(latencyMs: 1, syncLag: 250_000)
    XCTAssertFalse(catchUp.isPoor)
    XCTAssertFalse(catchUp.isHealthy)

    let slowTransport = syncConnectionLoadSample(latencyMs: 950, syncLag: 0)
    XCTAssertTrue(slowTransport.isPoor)
    XCTAssertFalse(slowTransport.isHealthy)

    let caughtUp = syncConnectionLoadSample(latencyMs: 1, syncLag: 0)
    XCTAssertFalse(caughtUp.isPoor)
    XCTAssertTrue(caughtUp.isHealthy)
  }

  @MainActor
  func testSyncAutomaticReconnectPrefersSavedTailnetDuringRoam() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let profile = HostConnectionProfile(
      hostIdentity: "host-1",
      hostName: "Mac Studio",
      port: 8787,
      authKind: "paired",
      pairedDeviceId: "phone-1",
      lastRemoteDbVersion: 0,
      lastHostDeviceId: "host-1",
      lastSuccessfulAddress: "192.168.1.8",
      savedAddressCandidates: ["192.168.1.8", "100.75.20.63"],
      discoveredLanAddresses: ["192.168.1.8"],
      tailscaleAddress: "100.75.20.63"
    )
    service.applyDiscoveredHostsForTesting([
      DiscoveredSyncHost(
        id: "bonjour-host",
        serviceName: "ADE Sync Mac 8787",
        hostName: "Mac Studio",
        hostIdentity: "host-1",
        port: 8787,
        addresses: ["192.168.1.8"],
        tailscaleAddress: nil,
        lastResolvedAt: "2026-04-23T00:00:00.000Z"
      ),
    ])

    service.preferTailnetReconnectForTesting()

    XCTAssertEqual(
      service.automaticReconnectAddressesForTesting(profile),
      ["100.75.20.63", "192.168.1.8"]
    )
  }

  @MainActor
  func testSyncAutomaticReconnectPrefersTailnetOnCellularWithoutManualRoamFlag() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let profile = HostConnectionProfile(
      hostIdentity: "host-1",
      hostName: "Mac Studio",
      port: 8790,
      authKind: "paired",
      pairedDeviceId: "phone-1",
      lastRemoteDbVersion: 0,
      lastHostDeviceId: "host-1",
      lastSuccessfulAddress: "192.168.1.8",
      savedAddressCandidates: ["192.168.1.8", "100.75.20.63"],
      discoveredLanAddresses: ["192.168.1.8"],
      tailscaleAddress: "100.75.20.63"
    )
    service.setNetworkPathForTesting(
      usesWiFi: false,
      usesCellular: true,
      usesWiredEthernet: false
    )
    service.applyDiscoveredHostsForTesting([
      DiscoveredSyncHost(
        id: "bonjour-host",
        serviceName: "ADE Sync Mac 8800",
        hostName: "Mac Studio",
        hostIdentity: "host-1",
        port: 8800,
        addresses: ["192.168.1.8"],
        tailscaleAddress: "100.75.20.63",
        lastResolvedAt: "2026-04-23T00:00:00.000Z"
      ),
    ])

    XCTAssertEqual(
      service.automaticReconnectAddressesForTesting(profile),
      ["100.75.20.63", "192.168.1.8"]
    )
    XCTAssertTrue(
      syncConnectPortCandidates(primaryPort: profile.port, addresses: service.automaticReconnectAddressesForTesting(profile)).contains(8800)
    )
  }

  func testSyncConnectPortCandidatesDoNotScanBonjourHostnameFallbackWindow() {
    XCTAssertEqual(
      syncConnectPortCandidates(primaryPort: 8787, addresses: ["Aruls-Mac-Studio.local."]),
      [8787]
    )
    XCTAssertEqual(
      syncConnectPortCandidates(primaryPort: 8787, addresses: ["192.168.1.8"]).prefix(3),
      [8787, 8788, 8789]
    )
  }

  @MainActor
  func testSyncDiscoveredHostIgnoresTimestampOnlyRefreshForPublishedList() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    service.applyDiscoveredHostsForTesting([
      DiscoveredSyncHost(
        id: "bonjour-host",
        serviceName: "ADE Sync Mac 8787",
        hostName: "Mac Studio",
        hostIdentity: "host-1",
        port: 8787,
        addresses: ["Aruls-Mac-Studio.local"],
        tailscaleAddress: nil,
        lastResolvedAt: "2026-04-23T00:00:00.000Z"
      ),
    ])
    let firstPublished = service.discoveredHosts

    service.applyDiscoveredHostsForTesting([
      DiscoveredSyncHost(
        id: "bonjour-host",
        serviceName: "ADE Sync Mac 8787",
        hostName: "Mac Studio",
        hostIdentity: "host-1",
        port: 8787,
        addresses: ["Aruls-Mac-Studio.local"],
        tailscaleAddress: nil,
        lastResolvedAt: "2026-04-23T00:00:01.000Z"
      ),
    ])

    XCTAssertEqual(service.discoveredHosts, firstPublished)
  }

  @MainActor
  func testSyncDiscoveredHostsCoalescesDuplicateAnonymousLanRows() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))

    service.applyDiscoveredHostsForTesting([
      DiscoveredSyncHost(
        id: "anonymous-8787-a",
        serviceName: "ADE Sync MacBook A",
        hostName: "MacBook-Pro-567.local",
        hostIdentity: nil,
        port: 8787,
        addresses: ["192.168.1.249"],
        tailscaleAddress: "100.80.20.10",
        runtimeKind: "daemon",
        runtimeVersion: "1.0.0-beta.1",
        projectIds: ["project-a"],
        projectNames: ["ADE"],
        projectCount: 1,
        lastResolvedAt: "2026-04-23T00:00:00.000Z"
      ),
      DiscoveredSyncHost(
        id: "anonymous-8787-b",
        serviceName: "ADE Sync MacBook B",
        hostName: "MacBook-Pro-567.local",
        hostIdentity: nil,
        port: 8787,
        addresses: ["192.168.1.249"],
        tailscaleAddress: "100.80.20.10",
        runtimeKind: "daemon",
        runtimeVersion: "1.0.0-beta.1",
        projectIds: ["project-b", "project-a"],
        projectNames: ["Versic", "ADE"],
        projectCount: 2,
        lastResolvedAt: "2026-04-23T00:00:01.000Z"
      ),
    ])

    XCTAssertEqual(service.discoveredHosts.count, 1)
    XCTAssertEqual(service.discoveredHosts[0].hostName, "MacBook-Pro-567.local")
    XCTAssertEqual(service.discoveredHosts[0].addresses, ["192.168.1.249"])
    XCTAssertEqual(service.discoveredHosts[0].projectIds, ["project-b", "project-a"])
    XCTAssertEqual(service.discoveredHosts[0].projectNames, ["Versic", "ADE"])
  }

  @MainActor
  func testSyncUserReconnectCanPreferSavedTailnetOverStaleLanDiscovery() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let profile = HostConnectionProfile(
      hostIdentity: "host-1",
      hostName: "Mac Studio",
      port: 8788,
      authKind: "paired",
      pairedDeviceId: "phone-1",
      lastRemoteDbVersion: 0,
      lastHostDeviceId: "host-1",
      lastSuccessfulAddress: "192.168.1.8",
      savedAddressCandidates: ["192.168.1.8", "100.75.20.63"],
      discoveredLanAddresses: ["192.168.1.8"],
      tailscaleAddress: "100.75.20.63"
    )
    service.applyDiscoveredHostsForTesting([
      DiscoveredSyncHost(
        id: "bonjour-host",
        serviceName: "ADE Sync Mac 8788",
        hostName: "Mac Studio",
        hostIdentity: "host-1",
        port: 8788,
        addresses: ["192.168.1.8"],
        tailscaleAddress: nil,
        lastResolvedAt: "2026-04-23T00:00:00.000Z"
      ),
    ])

    service.preferTailnetReconnectForTesting()

    XCTAssertEqual(
      service.prioritizedReconnectAddressesForTesting(profile),
      ["100.75.20.63", "192.168.1.8"]
    )
  }

  @MainActor
  func testSyncAuthFailureOnAmbiguousSavedLanRouteKeepsPairing() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))

    XCTAssertFalse(service.shouldInvalidateSavedPairingAfterAuthFailureForTesting(address: "192.168.1.8"))
    XCTAssertFalse(service.shouldInvalidateSavedPairingAfterAuthFailureForTesting(address: "mac.local"))
    XCTAssertFalse(service.shouldInvalidateSavedPairingAfterAuthFailureForTesting(address: "ade-sync"))
    XCTAssertTrue(service.shouldInvalidateSavedPairingAfterAuthFailureForTesting(address: "macbook.tailnet.ts.net"))
  }

  @MainActor
  func testSyncAutomaticReconnectDoesNotTreatGenericTailnetShortcutAsEverySavedHost() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let profile = HostConnectionProfile(
      hostIdentity: "host-1",
      hostName: "Mac Studio",
      port: 8787,
      authKind: "paired",
      pairedDeviceId: "phone-1",
      lastRemoteDbVersion: 0,
      lastHostDeviceId: "host-1",
      lastSuccessfulAddress: "192.168.1.8",
      savedAddressCandidates: ["192.168.1.8", "100.75.20.63"],
      discoveredLanAddresses: ["192.168.1.8"],
      tailscaleAddress: "100.75.20.63"
    )
    service.applyDiscoveredHostsForTesting([
      DiscoveredSyncHost(
        id: "tailnet-ade-sync:8787",
        serviceName: "ADE Tailnet ade-sync",
        hostName: "ade-sync",
        hostIdentity: nil,
        port: 8787,
        addresses: [],
        tailscaleAddress: "ade-sync",
        // Use a fresh `lastResolvedAt` so the discovery row is not coalesced
        // away by the same-bucket dedup that other tests' static 2026-04-23
        // fixtures rely on. We need this row live in `discoveredHosts` to
        // exercise the shortcut-vs-saved-host matching logic this test
        // regresses against.
        lastResolvedAt: recentIso8601Fixture()
      ),
    ])

    XCTAssertEqual(
      service.automaticReconnectAddressesForTesting(profile),
      ["100.75.20.63"]
    )
  }

  @MainActor
  func testSyncAutomaticReconnectWaitsForLiveLanDiscoveryWithoutTailnet() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let profile = HostConnectionProfile(
      hostIdentity: "host-1",
      hostName: "Mac Studio",
      port: 8787,
      authKind: "paired",
      pairedDeviceId: "phone-1",
      lastRemoteDbVersion: 0,
      lastHostDeviceId: "host-1",
      lastSuccessfulAddress: "192.168.1.8",
      savedAddressCandidates: ["192.168.1.8"],
      discoveredLanAddresses: ["192.168.1.8"],
      tailscaleAddress: nil
    )

    XCTAssertEqual(service.automaticReconnectAddressesForTesting(profile), [])
  }

  func testSyncForegroundReconnectStartRequiresAutomaticRoute() {
    XCTAssertTrue(
      syncShouldPublishForegroundReconnectStarted(
        allowAutoReconnect: true,
        autoReconnectPausedByUser: false,
        hasToken: true,
        connectionState: .disconnected,
        automaticAddresses: ["100.75.20.63"]
      )
    )
    XCTAssertFalse(
      syncShouldPublishForegroundReconnectStarted(
        allowAutoReconnect: true,
        autoReconnectPausedByUser: false,
        hasToken: true,
        connectionState: .disconnected,
        automaticAddresses: []
      )
    )
    XCTAssertFalse(
      syncShouldPublishForegroundReconnectStarted(
        allowAutoReconnect: true,
        autoReconnectPausedByUser: false,
        hasToken: true,
        connectionState: .connected,
        automaticAddresses: ["100.75.20.63"]
      )
    )
  }

  func testSyncMessageTooLongTransportFailureForcesErrorState() {
    let fatalError = NSError(
      domain: "ADE",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: "WebSocket message too long."]
    )
    let transientError = NSError(
      domain: "ADE",
      code: 2,
      userInfo: [NSLocalizedDescriptionKey: "The host stopped responding. Reconnecting now."]
    )

    XCTAssertEqual(syncConnectionStateAfterTransportFailure(error: fatalError, fallback: .connecting), .error)
    XCTAssertEqual(syncConnectionStateAfterTransportFailure(error: transientError, fallback: .connecting), .connecting)
  }

  func testSyncRequestTimeoutWithoutInboundTrafficPublishesReconnectingState() {
    XCTAssertEqual(
      syncConnectionStateAfterRequestTimeout(lastInboundMessageAt: nil, fallback: .error),
      .connecting
    )
    XCTAssertEqual(
      syncConnectionStateAfterRequestTimeout(lastInboundMessageAt: 42, fallback: .error),
      .error
    )
  }

  func testSyncClientHeartbeatUsesHalfServerIntervalWithBounds() {
    XCTAssertEqual(
      syncClientHeartbeatIntervalNanoseconds(serverIntervalMs: 30_000),
      15_000_000_000
    )
    XCTAssertEqual(
      syncClientHeartbeatIntervalNanoseconds(serverIntervalMs: 4_000),
      5_000_000_000
    )
    XCTAssertEqual(
      syncClientHeartbeatIntervalNanoseconds(serverIntervalMs: 120_000),
      25_000_000_000
    )
  }

  @MainActor
  func testSyncWebSocketAllowlistIncludesTrustedPlaintextAndSecureRoutes() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))

    XCTAssertTrue(service.syncCanAttemptPlaintextWebSocket("100.117.237.95"))
    XCTAssertTrue(service.syncCanAttemptPlaintextWebSocket("ws://100.117.237.95:8787"))
    XCTAssertTrue(service.syncCanAttemptPlaintextWebSocket("wss://sync.ade.example"))
    XCTAssertTrue(service.syncCanAttemptPlaintextWebSocket("ade-sync"))
    XCTAssertTrue(service.syncCanAttemptPlaintextWebSocket("macbook.tailnet.ts.net"))
    XCTAssertTrue(service.syncCanAttemptPlaintextWebSocket("192.168.68.102"))
    XCTAssertTrue(service.syncCanAttemptPlaintextWebSocket("mac.local"))
    XCTAssertFalse(service.syncCanAttemptPlaintextWebSocket("8.8.8.8"))
    XCTAssertFalse(service.syncCanAttemptPlaintextWebSocket("example.com"))
    XCTAssertFalse(service.syncCanAttemptPlaintextWebSocket("https://example.com"))
  }

  func testAppTransportSecurityIncludesTailscaleCidrs() {
    let ats = Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any]
    let domains = ats?["NSExceptionDomains"] as? [String: Any]

    XCTAssertNotNil(domains?["100.64.0.0/10"])
    XCTAssertNotNil(domains?["fd7a:115c:a1e0::/48"])
    XCTAssertNil(ats?["NSAllowsArbitraryLoads"])
  }

  @MainActor
  func testSyncSuppressesAnonymousTailnetShortcutWhenIdentifiedHostHasTailnetRoute() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let identified = DiscoveredSyncHost(
      id: "bonjour-host",
      serviceName: "ADE Sync Mac 8787",
      hostName: "Mac",
      hostIdentity: "host-1",
      port: 8787,
      addresses: ["192.168.1.8"],
      tailscaleAddress: "100.100.12.4",
      lastResolvedAt: "2026-04-23T00:00:00.000Z"
    )
    let anonymousTailnet = DiscoveredSyncHost(
      id: "tailnet-ade-sync:8787",
      serviceName: "ADE Tailnet ade-sync",
      hostName: "ade-sync",
      hostIdentity: nil,
      port: 8787,
      addresses: [],
      tailscaleAddress: "ade-sync",
      lastResolvedAt: "2026-04-23T00:00:01.000Z"
    )

    service.applyDiscoveredHostsForTesting([identified, anonymousTailnet])

    XCTAssertEqual(service.discoveredHosts.count, 1)
    XCTAssertEqual(service.discoveredHosts.first?.hostIdentity, "host-1")
  }

  @MainActor
  func testSyncKeepsAnonymousTailnetShortcutWithoutIdentifiedTailnetHost() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let anonymousTailnet = DiscoveredSyncHost(
      id: "tailnet-ade-sync:8787",
      serviceName: "ADE Tailnet ade-sync",
      hostName: "ade-sync",
      hostIdentity: nil,
      port: 8787,
      addresses: [],
      tailscaleAddress: "ade-sync",
      lastResolvedAt: "2026-04-23T00:00:01.000Z"
    )

    service.applyDiscoveredHostsForTesting([anonymousTailnet])

    XCTAssertEqual(service.discoveredHosts.count, 1)
    XCTAssertEqual(service.discoveredHosts.first?.hostName, "ade-sync")
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
    XCTAssertEqual(SyncUserFacingError.message(for: offlineError), "The machine is offline. Reconnect, then try again.")

    let authError = NSError(
      domain: "ADE",
      code: 3,
      userInfo: [NSLocalizedDescriptionKey: "Authentication failed.", "ADEErrorCode": "auth_failed"]
    )
    XCTAssertEqual(SyncUserFacingError.message(for: authError), "This phone is no longer paired with this machine. Pair again from Settings.")

    let ambiguousTailnetAuthError = NSError(
      domain: "ADE",
      code: 3,
      userInfo: [
        NSLocalizedDescriptionKey: "Authentication failed.",
        "ADEErrorCode": "auth_failed",
        "ADEAmbiguousRouteAuthFailure": true,
      ]
    )
    XCTAssertEqual(
      SyncUserFacingError.message(for: ambiguousTailnetAuthError),
      "Reached a different ADE machine on this route. ADE kept the saved pairing and will keep trying other routes."
    )

    let invalidHelloError = NSError(
      domain: "ADE",
      code: 4,
      userInfo: [NSLocalizedDescriptionKey: "Invalid hello response."]
    )
    XCTAssertEqual(SyncUserFacingError.message(for: invalidHelloError), "The machine replied with unexpected pairing data. Reconnect and try again.")

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
    XCTAssertEqual(SyncUserFacingError.message(for: compressedPayloadError), "The machine sent unreadable sync data. Reconnect and try again.")
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

    let userMessageJSON = """
    {
      "sessionId": "session-3",
      "timestamp": "2026-03-17T00:02:00.000Z",
      "event": {
        "type": "user_message",
        "text": "INTERNAL_RUNTIME_PROMPT",
        "displayText": "ADE coordinator tick: review agent state and route the next action.",
        "turnId": "turn-1"
      }
    }
    """

    let userMessageEnvelope = try JSONDecoder().decode(AgentChatEventEnvelope.self, from: Data(userMessageJSON.utf8))
    guard case .userMessage(let userText, _, let userTurnId, _, _, _) = userMessageEnvelope.event else {
      return XCTFail("Expected user message event.")
    }
    XCTAssertEqual(userText, "ADE coordinator tick: review agent state and route the next action.")
    XCTAssertEqual(userTurnId, "turn-1")

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

  func testAgentChatEventEnvelopeDecodesTokenUsageEvent() throws {
    let json = """
    {
      "sessionId": "session-usage",
      "timestamp": "2026-03-17T00:00:00.000Z",
      "sequence": 14,
      "event": {
        "type": "tokens",
        "turnId": "turn-usage",
        "itemId": "tokens-1",
        "inputTokens": 169600,
        "outputTokens": 701,
        "cacheReadTokens": 168300,
        "cacheWriteTokens": 1200,
        "contextWindow": 258400
      }
    }
    """

    let envelope = try JSONDecoder().decode(AgentChatEventEnvelope.self, from: Data(json.utf8))

    guard case .tokens(let turnId, let itemId, let inputTokens, let outputTokens, let cacheReadTokens, let cacheWriteTokens, let contextWindow) = envelope.event else {
      return XCTFail("Expected tokens event.")
    }
    XCTAssertEqual(turnId, "turn-usage")
    XCTAssertEqual(itemId, "tokens-1")
    XCTAssertEqual(inputTokens, 169600)
    XCTAssertEqual(outputTokens, 701)
    XCTAssertEqual(cacheReadTokens, 168300)
    XCTAssertEqual(cacheWriteTokens, 1200)
    XCTAssertEqual(contextWindow, 258400)
  }

  func testAgentChatEventEnvelopeMapsCodexTokenUsageToContextUsage() throws {
    let json = """
    {
      "sessionId": "session-usage",
      "timestamp": "2026-03-17T00:00:00.000Z",
      "sequence": 15,
      "event": {
        "type": "codex_token_usage",
        "turnId": "turn-usage",
        "usage": {
          "threadId": "thread-usage",
          "turnId": "turn-usage",
          "modelContextWindow": 258400,
          "last": {
            "inputTokens": 169600,
            "outputTokens": 701,
            "cacheReadTokens": 168300,
            "cacheWriteTokens": 1200,
            "reasoningTokens": 15
          },
          "total": {
            "totalTokens": 170301
          }
        }
      }
    }
    """

    let envelope = try JSONDecoder().decode(AgentChatEventEnvelope.self, from: Data(json.utf8))
    let event = makeWorkChatEvent(from: envelope.event)

    guard case .tokens(let usage, let turnId, let itemId) = event else {
      return XCTFail("Expected codex token usage to normalize to a tokens event.")
    }
    XCTAssertEqual(turnId, "turn-usage")
    XCTAssertNil(itemId)
    XCTAssertEqual(usage.inputTokens, 169600)
    XCTAssertEqual(usage.outputTokens, 701)
    XCTAssertEqual(usage.cacheReadTokens, 168300)
    XCTAssertEqual(usage.cacheCreationTokens, 1200)
    XCTAssertEqual(usage.reasoningTokens, 15)
    XCTAssertEqual(usage.totalTokens, 170301)
    XCTAssertEqual(usage.contextWindow, 258400)

    let viewModel = workContextUsageViewModel(
      transcript: [
        WorkChatEnvelope(
          sessionId: envelope.sessionId,
          timestamp: envelope.timestamp,
          sequence: envelope.sequence,
          event: event
        )
      ],
      summary: makeAgentChatSessionSummary(provider: "codex", model: "GPT-5.5", status: "active")
    )
    XCTAssertEqual(viewModel?.usedTokens, 169600)
    XCTAssertEqual(viewModel?.contextWindow, 258400)
    XCTAssertEqual(viewModel?.ratio ?? 0, Double(169600) / Double(258400), accuracy: 0.0001)
  }

  @MainActor
  func testChatSubscriptionStateSurvivesDisconnectAndReplaysPayloads() async throws {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))

    try await service.subscribeToChatEvents(sessionId: "session-1")
    try await service.subscribeToChatEvents(sessionId: "session-2")
    let subscriptionRevision = service.localStateRevision

    try await service.subscribeToChatEvents(sessionId: "session-1")
    XCTAssertEqual(service.localStateRevision, subscriptionRevision)

    try await service.subscribeToChatEvents(sessionId: "session-1", requestSnapshot: true)
    XCTAssertEqual(service.localStateRevision, subscriptionRevision)

    XCTAssertEqual(service.subscribedChatSessionIds, Set(["session-1", "session-2"]))
    XCTAssertEqual(service.chatSubscriptionPayloads().compactMap { $0["sessionId"] as? String }.sorted(), ["session-1", "session-2"])
    XCTAssertEqual(service.chatSubscriptionPayloads().compactMap { $0["maxBytes"] as? Int }, [2_000_000, 2_000_000])

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
  func testTerminalBufferSurvivesCredentialClearingDisconnect() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))

    service.seedTerminalBufferForTesting(sessionId: "terminal-1", transcript: "full terminal history")
    service.disconnect(clearCredentials: true)

    XCTAssertEqual(service.terminalBuffers["terminal-1"], "full terminal history")
    XCTAssertEqual(service.subscribedTerminalSessionIds, Set(["terminal-1"]))
  }

  @MainActor
  func testTerminalFallbackFingerprintUsesPerSessionRevision() {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))

    service.seedTerminalBufferForTesting(sessionId: "terminal-1", transcript: "first history")
    let firstFingerprint = workRootLiveTranscriptFingerprint(
      chatEventRevision: 0,
      streamedEventCount: 0,
      terminalBufferRevision: service.terminalBufferRevisionsBySessionId["terminal-1"],
      terminalTail: service.terminalBuffers["terminal-1"]
    )

    service.seedTerminalBufferForTesting(sessionId: "terminal-2", transcript: "second history")
    let unchangedFingerprint = workRootLiveTranscriptFingerprint(
      chatEventRevision: 0,
      streamedEventCount: 0,
      terminalBufferRevision: service.terminalBufferRevisionsBySessionId["terminal-1"],
      terminalTail: service.terminalBuffers["terminal-1"]
    )

    XCTAssertEqual(unchangedFingerprint, firstFingerprint)
    XCTAssertEqual(service.terminalBufferRevisionsBySessionId["terminal-2"], 1)
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

  @MainActor
  func testTruncatedChatSubscribeSnapshotMergesWithExistingHistory() async throws {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let original = AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-03-17T00:00:00.000Z",
      event: .userMessage(text: "Start here", attachments: [], turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil),
      sequence: 1,
      provenance: nil
    )
    let tail = AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-03-17T00:00:01.000Z",
      event: .text(text: "Still working", messageId: "msg-1", turnId: "turn-1", itemId: "item-1"),
      sequence: 2,
      provenance: nil
    )

    service.recordChatEventEnvelope(original)
    service.mergeChatEventHistory(sessionId: "session-1", events: [original, tail])

    XCTAssertEqual(service.chatEventHistory(sessionId: "session-1"), [original, tail])
  }

  @MainActor
  func testDuplicateChatSubscribeSnapshotDoesNotAdvanceRevision() async throws {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let event = AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-03-17T00:00:00.000Z",
      event: .userMessage(text: "Start here", attachments: [], turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil),
      sequence: 1,
      provenance: nil
    )

    service.recordChatEventEnvelope(event)
    XCTAssertEqual(service.chatEventRevision(for: "session-1"), 1)

    service.mergeChatEventHistory(sessionId: "session-1", events: [event])
    service.replaceChatEventHistory(sessionId: "session-1", events: [event])

    XCTAssertEqual(service.chatEventHistory(sessionId: "session-1"), [event])
    XCTAssertEqual(service.chatEventRevision(for: "session-1"), 1)
  }

  @MainActor
  func testCompleteChatSubscribeSnapshotMergesWithExistingLiveHistory() async throws {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let live = AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-03-17T00:00:00.000Z",
      event: .userMessage(text: "Live event", attachments: [], turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil),
      sequence: 1,
      provenance: nil
    )
    let fresh = AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-03-17T00:00:01.000Z",
      event: .text(text: "Fresh snapshot", messageId: "msg-1", turnId: "turn-1", itemId: "item-1"),
      sequence: 2,
      provenance: nil
    )

    service.recordChatEventEnvelope(live)
    service.mergeChatEventHistory(sessionId: "session-1", events: [fresh])

    XCTAssertEqual(service.chatEventHistory(sessionId: "session-1"), [live, fresh])
  }

  @MainActor
  func testChatEventHistoryOrdersByParsedTimestampAcrossMixedFractionalVariants() async throws {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    // Lexicographic compare misorders these: "…56Z" > "…56.500Z" because
    // "Z" (0x5A) > "." (0x2E) in ASCII. Chronologically "…56Z" comes first.
    let noFractional = AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-03-17T00:00:56Z",
      event: .userMessage(text: "first", attachments: [], turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil),
      sequence: 1,
      provenance: nil
    )
    let withFractional = AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-03-17T00:00:56.500Z",
      event: .text(text: "second", messageId: "msg-1", turnId: "turn-1", itemId: "item-1"),
      sequence: 2,
      provenance: nil
    )

    service.replaceChatEventHistory(sessionId: "session-1", events: [withFractional, noFractional])

    let history = service.chatEventHistory(sessionId: "session-1")
    XCTAssertEqual(history.map(\.id), [noFractional.id, withFractional.id])
  }

  @MainActor
  func testRecordChatEventEnvelopeSortsWhenLiveEventArrivesOutOfOrder() async throws {
    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let earlier = AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-03-17T00:00:01.000Z",
      event: .userMessage(text: "first", attachments: [], turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil),
      sequence: 1,
      provenance: nil
    )
    let later = AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-03-17T00:00:02.000Z",
      event: .text(text: "second", messageId: "msg-1", turnId: "turn-1", itemId: "item-1"),
      sequence: 2,
      provenance: nil
    )

    service.mergeChatEventHistory(sessionId: "session-1", events: [earlier, later])
    // Live envelope arrives out of order (delayed tool_result that predates the
    // already-merged later envelope). Must be inserted in chronological order
    // rather than appended to the end.
    let delayedInsert = AgentChatEventEnvelope(
      sessionId: "session-1",
      timestamp: "2026-03-17T00:00:01.500Z",
      event: .toolResult(tool: "fs_read", result: .string("ok"), itemId: "tool-1", logicalItemId: "tool-1", parentItemId: nil, turnId: "turn-1", status: "completed"),
      sequence: 3,
      provenance: nil
    )
    service.recordChatEventEnvelope(delayedInsert)

    let history = service.chatEventHistory(sessionId: "session-1")
    XCTAssertEqual(history.map(\.id), [earlier.id, delayedInsert.id, later.id])
  }

  func testChatCommandRequestPayloadsEncodeExpectedShapes() throws {
    let subscribe = try jsonDictionary(from: AgentChatSubscriptionRequest(sessionId: "session-1"))
    XCTAssertEqual(subscribe["sessionId"] as? String, "session-1")

    let interrupt = try jsonDictionary(from: AgentChatInterruptRequest(sessionId: "session-1"))
    XCTAssertEqual(interrupt["sessionId"] as? String, "session-1")

    let steer = try jsonDictionary(from: AgentChatSteerRequest(sessionId: "session-1", text: "Keep going"))
    XCTAssertEqual(steer["sessionId"] as? String, "session-1")
    XCTAssertEqual(steer["text"] as? String, "Keep going")

    let sessionId = try jsonDictionary(from: AgentChatSessionIdRequest(sessionId: "session-1"))
    XCTAssertEqual(sessionId["sessionId"] as? String, "session-1")

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
      codexFastMode: true,
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
    XCTAssertEqual(update["codexFastMode"] as? Bool, true)
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
    let hiddenProjectsKey = "ade.sync.hiddenProjects"
    UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
    UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    UserDefaults.standard.removeObject(forKey: hiddenProjectsKey)
    defer {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
      UserDefaults.standard.removeObject(forKey: hiddenProjectsKey)
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
  func testSyncServiceForgetProjectHidesCachedAndRemoteRowsByRoot() throws {
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    let activeProjectHostIdentityKey = "ade.sync.activeProjectHostIdentity"
    let profileKey = "ade.sync.hostProfile"
    let profilesKey = "ade.sync.hostProfiles"
    let hiddenProjectsKey = "ade.sync.hiddenProjects"
    let hostHiddenProjectsKey = "\(hiddenProjectsKey).host-1"
    UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
    UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    UserDefaults.standard.removeObject(forKey: activeProjectHostIdentityKey)
    UserDefaults.standard.removeObject(forKey: profileKey)
    UserDefaults.standard.removeObject(forKey: profilesKey)
    UserDefaults.standard.removeObject(forKey: hiddenProjectsKey)
    UserDefaults.standard.removeObject(forKey: hostHiddenProjectsKey)
    defer {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
      UserDefaults.standard.removeObject(forKey: activeProjectHostIdentityKey)
      UserDefaults.standard.removeObject(forKey: profileKey)
      UserDefaults.standard.removeObject(forKey: profilesKey)
      UserDefaults.standard.removeObject(forKey: hiddenProjectsKey)
      UserDefaults.standard.removeObject(forKey: hostHiddenProjectsKey)
    }

    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)
    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values
        ('db-project', '/tmp/project-one', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T01:00:00.000Z');
    """)

    let service = SyncService(database: database)
    try service.applyHelloPayloadForTesting([
      "brain": [
        "deviceId": "host-1",
        "deviceName": "Mac Studio",
      ],
      "features": [
        "projectCatalog": true,
      ],
      "projects": [],
    ])
    let cachedProject = try XCTUnwrap(service.projects.first(where: { $0.id == "db-project" }))
    service.setActiveProjectForTesting(projectId: cachedProject.id, rootPath: cachedProject.rootPath)
    XCTAssertEqual(service.activeProjectId, "db-project")

    let registryProject = MobileProjectSummary(
      id: "registry-project",
      displayName: "Project One",
      rootPath: "/tmp/project-one/",
      defaultBaseRef: "main",
      lastOpenedAt: "2026-04-22T02:00:00.000Z",
      laneCount: 2,
      isAvailable: true,
      isCached: false
    )
    service.seedRemoteProjectCatalogForTesting([registryProject])
    XCTAssertTrue(service.projects.contains { $0.id == "db-project" || $0.id == "registry-project" })

    service.forgetProject(cachedProject)

    XCTAssertNil(service.activeProjectId)
    XCTAssertNil(service.activeProjectRootPath)
    XCTAssertTrue(service.shouldShowProjectHome)
    XCTAssertFalse(service.projects.contains { $0.id == "db-project" })
    XCTAssertFalse(service.projects.contains { $0.id == "registry-project" })
    XCTAssertNil(UserDefaults.standard.stringArray(forKey: hiddenProjectsKey))
    XCTAssertEqual(
      UserDefaults.standard.stringArray(forKey: hostHiddenProjectsKey),
      ["id:db-project", "root:/tmp/project-one"]
    )

    service.seedRemoteProjectCatalogForTesting([
      MobileProjectSummary(
        id: "registry-project",
        displayName: "Project One",
        rootPath: "/tmp/project-one/",
        defaultBaseRef: "main",
        lastOpenedAt: "2026-04-22T03:00:00.000Z",
        laneCount: 3,
        isAvailable: true,
        isCached: false
      ),
    ])
    XCTAssertFalse(service.projects.contains { $0.id == "db-project" })
    XCTAssertFalse(service.projects.contains { $0.id == "registry-project" })

    service.disconnect(clearCredentials: false, suspendAutoReconnect: true)
    service.selectProject(registryProject)
    XCTAssertNil(UserDefaults.standard.stringArray(forKey: hostHiddenProjectsKey))

    database.close()
  }

  @MainActor
  func testSyncServiceProjectHomeDeduplicatesCachedRowsByRootAndKeepsActive() throws {
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    UserDefaults.standard.set("project-active", forKey: activeProjectIdKey)
    UserDefaults.standard.set("/tmp/project-one", forKey: activeProjectRootPathKey)
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
        ('project-stale', '/tmp/project-one', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T02:00:00.000Z'),
        ('project-active', '/tmp/project-one/', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T01:00:00.000Z');
      insert into lanes (
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder,
        status, created_at, archived_at
      ) values
        ('lane-one', 'project-active', 'One', null, 'worktree', 'main', 'feature/one', '/tmp/project-one/.ade/worktrees/one',
         null, 0, null, null, null, null, null, 'active', '2026-04-22T00:10:00.000Z', null);
    """)

    let service = SyncService(database: database)

    XCTAssertEqual(service.projects.map(\.id), ["project-active"])
    XCTAssertEqual(service.projects.first?.laneCount, 1)
    XCTAssertEqual(service.activeProjectId, "project-active")

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
      "That project has not been cached on this phone yet. Connect to the ADE machine before opening it."
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
  func testSyncServiceClearsStaleCachedSelectionUntilUserChoosesRemoteProject() throws {
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    let activeProjectHostIdentityKey = "ade.sync.activeProjectHostIdentity"
    UserDefaults.standard.set("old-project", forKey: activeProjectIdKey)
    UserDefaults.standard.set("/tmp/old-project", forKey: activeProjectRootPathKey)
    UserDefaults.standard.set("host-old", forKey: activeProjectHostIdentityKey)
    defer {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
      UserDefaults.standard.removeObject(forKey: activeProjectHostIdentityKey)
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

    XCTAssertNil(service.activeProjectId)
    XCTAssertNil(service.activeProjectRootPath)
    XCTAssertNotEqual(database.currentProjectId(), "new-project")
    XCTAssertTrue(service.shouldShowProjectHome)
    XCTAssertTrue(service.projects.contains { $0.id == "new-project" })

    database.close()
  }

  @MainActor
  func testSyncServiceClearsMatchingProjectIdWhenMachineIdentityChanges() throws {
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    let activeProjectHostIdentityKey = "ade.sync.activeProjectHostIdentity"
    UserDefaults.standard.set("project-1", forKey: activeProjectIdKey)
    UserDefaults.standard.set("/tmp/project-one", forKey: activeProjectRootPathKey)
    UserDefaults.standard.set("host-old", forKey: activeProjectHostIdentityKey)
    defer {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
      UserDefaults.standard.removeObject(forKey: activeProjectHostIdentityKey)
    }

    let database = makeControllerHydrationDatabase(baseURL: makeTemporaryDirectory())
    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values
        ('project-1', '/tmp/project-one', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T01:00:00.000Z');
    """)
    let service = SyncService(database: database)
    XCTAssertEqual(service.activeProjectId, "project-1")

    try service.applyHelloPayloadForTesting([
      "brain": [
        "deviceId": "host-new",
        "deviceName": "New Mac",
      ],
      "features": [
        "projectCatalog": true,
      ],
      "projects": [[
        "id": "project-1",
        "displayName": "Project One",
        "rootPath": "/tmp/project-one",
        "defaultBaseRef": "main",
        "lastOpenedAt": "2026-04-22T02:00:00.000Z",
        "laneCount": 2,
        "isAvailable": true,
        "isCached": false,
      ]],
    ])

    XCTAssertNil(service.activeProjectId)
    XCTAssertNil(service.activeProjectRootPath)
    XCTAssertTrue(service.shouldShowProjectHome)
    XCTAssertTrue(service.projects.contains { $0.id == "project-1" })

    database.close()
  }

  @MainActor
  func testSyncServiceAdoptsRuntimeProjectIdForCachedRootOnSameMachine() throws {
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    let activeProjectHostIdentityKey = "ade.sync.activeProjectHostIdentity"
    UserDefaults.standard.set("old-project", forKey: activeProjectIdKey)
    UserDefaults.standard.set("/tmp/project-one", forKey: activeProjectRootPathKey)
    UserDefaults.standard.set("host-1", forKey: activeProjectHostIdentityKey)
    defer {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
      UserDefaults.standard.removeObject(forKey: activeProjectHostIdentityKey)
    }

    let database = makeControllerHydrationDatabase(baseURL: makeTemporaryDirectory())
    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values
        ('old-project', '/tmp/project-one', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T01:00:00.000Z');
    """)
    let service = SyncService(database: database)
    XCTAssertEqual(service.activeProjectId, "old-project")

    try service.applyHelloPayloadForTesting([
      "brain": [
        "deviceId": "host-1",
        "deviceName": "Mac Studio",
      ],
      "features": [
        "projectCatalog": true,
      ],
      "projects": [[
        "id": "runtime-project",
        "displayName": "Project One",
        "rootPath": "/tmp/project-one/",
        "defaultBaseRef": "main",
        "lastOpenedAt": "2026-04-22T02:00:00.000Z",
        "laneCount": 2,
        "isAvailable": true,
        "isCached": false,
      ]],
    ])

    XCTAssertEqual(service.activeProjectId, "runtime-project")
    XCTAssertEqual(service.activeProjectRootPath, "/tmp/project-one")
    XCTAssertEqual(database.currentProjectId(), "runtime-project")
    XCTAssertEqual(service.projects.map(\.id), ["runtime-project"])
    XCTAssertFalse(service.shouldShowProjectHome)

    database.close()
  }

  @MainActor
  func testSyncServiceAdoptsRemoteProjectIdWhenStaleCachedDuplicateStillExists() throws {
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    let activeProjectHostIdentityKey = "ade.sync.activeProjectHostIdentity"
    UserDefaults.standard.set("stale-project", forKey: activeProjectIdKey)
    UserDefaults.standard.set("/tmp/project-one", forKey: activeProjectRootPathKey)
    UserDefaults.standard.set("host-1", forKey: activeProjectHostIdentityKey)
    defer {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
      UserDefaults.standard.removeObject(forKey: activeProjectHostIdentityKey)
    }

    let database = makeControllerHydrationDatabase(baseURL: makeTemporaryDirectory())
    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values
        ('runtime-project', '/tmp/project-one', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T02:00:00.000Z'),
        ('stale-project', '/tmp/project-one', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T01:00:00.000Z');
    """)
    let service = SyncService(database: database)
    XCTAssertEqual(service.activeProjectId, "stale-project")

    service.seedRemoteProjectCatalogForTesting([
      MobileProjectSummary(
        id: "runtime-project",
        displayName: "Project One",
        rootPath: "/tmp/project-one/",
        defaultBaseRef: "main",
        lastOpenedAt: "2026-04-22T02:00:00.000Z",
        laneCount: 2,
        isAvailable: true,
        isCached: true
      ),
    ])

    XCTAssertEqual(service.activeProjectId, "runtime-project")
    XCTAssertEqual(service.activeProjectRootPath, "/tmp/project-one")
    XCTAssertEqual(database.currentProjectId(), "runtime-project")

    database.close()
  }

  @MainActor
  func testSyncServiceSeedsRuntimeProjectRowBeforeHydration() throws {
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
    UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    defer {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    }

    let database = makeControllerHydrationDatabase(baseURL: makeTemporaryDirectory())
    XCTAssertNil(database.initializationError)
    let service = SyncService(database: database)
    service.setActiveProjectForTesting(projectId: "runtime-project", rootPath: "/tmp/project-one/")
    service.seedRemoteProjectCatalogForTesting([
      MobileProjectSummary(
        id: "runtime-project",
        displayName: "Project One",
        rootPath: "/tmp/project-one/",
        defaultBaseRef: "main",
        lastOpenedAt: "2026-04-22T02:00:00.000Z",
        laneCount: 2,
        isAvailable: true,
        isCached: false
      ),
    ])

    XCTAssertFalse(database.hasProject(id: "runtime-project"))
    XCTAssertEqual(database.currentDbVersion(), 0)

    try service.ensureActiveProjectCacheRowForTesting()

    XCTAssertTrue(database.hasProject(id: "runtime-project"))
    XCTAssertEqual(database.currentDbVersion(), 0)
    XCTAssertEqual(database.listMobileProjects().first?.rootPath, "/tmp/project-one")
    XCTAssertEqual(service.projects.first?.id, "runtime-project")
    XCTAssertTrue(service.projects.first?.isCached == true)

    database.close()
  }

  func testDatabaseFindsProofArtifactsAcrossDuplicateProjectRootIds() throws {
    let database = makeControllerHydrationDatabase(baseURL: makeTemporaryDirectory())
    XCTAssertNil(database.initializationError)
    try database.executeSqlForTesting("""
      create table if not exists computer_use_artifacts (
        id text primary key,
        project_id text not null,
        artifact_kind text not null,
        backend_style text not null,
        backend_name text not null,
        source_tool_name text,
        original_type text,
        title text not null,
        description text,
        uri text not null,
        storage_kind text not null,
        mime_type text,
        metadata_json text not null default '{}',
        created_at text not null
      );
      create table if not exists computer_use_artifact_links (
        id text primary key,
        artifact_id text not null,
        project_id text not null,
        owner_kind text not null,
        owner_id text not null,
        relation text not null default 'attached_to',
        metadata_json text,
        created_at text not null
      );
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values
        ('cached-project', '/tmp/project-one', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T01:00:00.000Z'),
        ('runtime-project', '/tmp/project-one/', 'Project One', 'main', '2026-04-22T00:00:00.000Z', '2026-04-22T02:00:00.000Z');
      insert into computer_use_artifacts (
        id, project_id, artifact_kind, backend_style, backend_name, source_tool_name, original_type,
        title, description, uri, storage_kind, mime_type, metadata_json, created_at
      ) values (
        'artifact-1', 'runtime-project', 'screenshot', 'manual', 'ade-cli', 'proof attach', 'screenshot',
        'Runtime proof', 'Attached while the runtime project id was canonical', 'ade-artifact://project/proof.png',
        'file', 'image/png', '{}', '2026-04-22T02:05:00.000Z'
      );
      insert into computer_use_artifact_links (
        id, artifact_id, project_id, owner_kind, owner_id, relation, metadata_json, created_at
      ) values (
        'link-1', 'artifact-1', 'runtime-project', 'chat_session', 'chat-1', 'attached_to', null, '2026-04-22T02:05:00.000Z'
      );
    """)
    database.setActiveProjectId("cached-project")

    let artifacts = database.fetchComputerUseArtifacts(ownerKind: "chat_session", ownerId: "chat-1")

    XCTAssertEqual(artifacts.map(\.id), ["artifact-1"])
    XCTAssertEqual(artifacts.first?.title, "Runtime proof")

    database.close()
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

  @MainActor
  func testSyncServicePersistsOutboundCursorAcrossRestart() throws {
    let outboundCursorKey = "ade.sync.outboundSyncCursors"
    let pendingOutboundChangesetsKey = "ade.sync.pendingOutboundChangesets"
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    UserDefaults.standard.removeObject(forKey: outboundCursorKey)
    UserDefaults.standard.removeObject(forKey: pendingOutboundChangesetsKey)
    UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
    UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    defer {
      UserDefaults.standard.removeObject(forKey: outboundCursorKey)
      UserDefaults.standard.removeObject(forKey: pendingOutboundChangesetsKey)
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    }

    let baseURL = makeTemporaryDirectory()
    let database = makeProjectLaneForeignKeyDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)
    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values (
        'project-1', '/tmp/project-one', 'Project One', 'main', '2026-03-15T00:00:00.000Z', '2026-03-15T00:00:00.000Z'
      )
    """)

    let service = SyncService(database: database)
    service.setActiveProjectForTesting(projectId: "project-1", rootPath: "/tmp/project-one")
    let initialCursor = service.outboundLocalDbVersionForTesting()

    try database.executeSqlForTesting("""
      insert into lanes (
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, parent_lane_id, status, created_at, archived_at
      ) values (
        'lane-restart', 'project-1', 'Restart proof', null, 'worktree', 'origin/main', 'feature/restart', '/tmp/restart', null, 'active', '2026-03-15T00:00:00.000Z', null
      )
    """)
    let pendingLocalVersion = database.currentDbVersion()
    XCTAssertGreaterThan(pendingLocalVersion, initialCursor)

    database.close()
    let databaseBeforeAck = makeProjectLaneForeignKeyDatabase(baseURL: baseURL)
    let restartedBeforeAck = SyncService(database: databaseBeforeAck)
    restartedBeforeAck.setActiveProjectForTesting(projectId: "project-1", rootPath: "/tmp/project-one")
    XCTAssertEqual(restartedBeforeAck.outboundLocalDbVersionForTesting(), initialCursor)

    restartedBeforeAck.advanceOutboundCursorForTesting(to: pendingLocalVersion)
    databaseBeforeAck.close()
    let databaseAfterAck = makeProjectLaneForeignKeyDatabase(baseURL: baseURL)
    let restartedAfterAck = SyncService(database: databaseAfterAck)
    restartedAfterAck.setActiveProjectForTesting(projectId: "project-1", rootPath: "/tmp/project-one")
    XCTAssertEqual(restartedAfterAck.outboundLocalDbVersionForTesting(), pendingLocalVersion)

    databaseAfterAck.close()
  }

  @MainActor
  func testSyncServiceDoesNotAdvertiseUnackedPhoneChangesAsRemoteDbVersion() throws {
    let outboundCursorKey = "ade.sync.outboundSyncCursors"
    let pendingOutboundChangesetsKey = "ade.sync.pendingOutboundChangesets"
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    UserDefaults.standard.removeObject(forKey: outboundCursorKey)
    UserDefaults.standard.removeObject(forKey: pendingOutboundChangesetsKey)
    UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
    UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    defer {
      UserDefaults.standard.removeObject(forKey: outboundCursorKey)
      UserDefaults.standard.removeObject(forKey: pendingOutboundChangesetsKey)
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    }

    let baseURL = makeTemporaryDirectory()
    let database = makeProjectLaneForeignKeyDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)
    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values (
        'project-1', '/tmp/project-one', 'Project One', 'main', '2026-03-15T00:00:00.000Z', '2026-03-15T00:00:00.000Z'
      )
    """)

    let service = SyncService(database: database)
    service.setActiveProjectForTesting(projectId: "project-1", rootPath: "/tmp/project-one")
    service.setLatestRemoteDbVersionForTesting(0)
    let initialCursor = service.outboundLocalDbVersionForTesting()

    try database.executeSqlForTesting("""
      insert into lanes (
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, parent_lane_id, status, created_at, archived_at
      ) values (
        'lane-unacked', 'project-1', 'Unacked proof', null, 'worktree', 'origin/main', 'feature/unacked', '/tmp/unacked', null, 'active', '2026-03-15T00:00:00.000Z', null
      )
    """)

    let pending = try XCTUnwrap(service.stageNextOutboundChangesetForTesting())
    XCTAssertGreaterThan(pending.toDbVersion, initialCursor)
    XCTAssertEqual(service.outboundLocalDbVersionForTesting(), initialCursor)
    XCTAssertEqual(service.latestRemoteDbVersionForTesting(), 0)
    XCTAssertEqual(service.currentPeerDbVersionForTesting(), 0)

    database.close()
  }

  @MainActor
  func testSyncServicePreservesPendingOutboundChangesetAcrossProjectSwitch() throws {
    let outboundCursorKey = "ade.sync.outboundSyncCursors"
    let pendingOutboundChangesetsKey = "ade.sync.pendingOutboundChangesets"
    let activeProjectIdKey = "ade.sync.activeProjectId"
    let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
    UserDefaults.standard.removeObject(forKey: outboundCursorKey)
    UserDefaults.standard.removeObject(forKey: pendingOutboundChangesetsKey)
    UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
    UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    defer {
      UserDefaults.standard.removeObject(forKey: outboundCursorKey)
      UserDefaults.standard.removeObject(forKey: pendingOutboundChangesetsKey)
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    }

    let baseURL = makeTemporaryDirectory()
    let database = makeProjectLaneForeignKeyDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)
    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values
        ('project-1', '/tmp/project-one', 'Project One', 'main', '2026-03-15T00:00:00.000Z', '2026-03-15T00:00:00.000Z'),
        ('project-2', '/tmp/project-two', 'Project Two', 'main', '2026-03-15T00:00:00.000Z', '2026-03-15T00:00:00.000Z')
    """)

    let service = SyncService(database: database)
    service.setActiveProjectForTesting(projectId: "project-1", rootPath: "/tmp/project-one")
    let initialCursor = service.outboundLocalDbVersionForTesting()

    try database.executeSqlForTesting("""
      insert into lanes (
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path, parent_lane_id, status, created_at, archived_at
      ) values (
        'lane-switch', 'project-1', 'Switch proof', null, 'worktree', 'origin/main', 'feature/switch', '/tmp/switch', null, 'active', '2026-03-15T00:00:00.000Z', null
      )
    """)
    let pendingLocalVersion = database.currentDbVersion()
    XCTAssertGreaterThan(pendingLocalVersion, initialCursor)

    service.setActiveProjectForTesting(projectId: "project-2", rootPath: "/tmp/project-two")
    XCTAssertEqual(service.outboundLocalDbVersionForTesting(), pendingLocalVersion)

    service.setActiveProjectForTesting(projectId: "project-1", rootPath: "/tmp/project-one")
    XCTAssertEqual(service.outboundLocalDbVersionForTesting(), initialCursor)

    service.advanceOutboundCursorForTesting(to: pendingLocalVersion)
    database.close()
    let databaseAfterAck = makeProjectLaneForeignKeyDatabase(baseURL: baseURL)
    let restartedAfterAck = SyncService(database: databaseAfterAck)
    restartedAfterAck.setActiveProjectForTesting(projectId: "project-1", rootPath: "/tmp/project-one")
    XCTAssertEqual(restartedAfterAck.outboundLocalDbVersionForTesting(), pendingLocalVersion)

    databaseAfterAck.close()
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
    let lanePrimaryKeys = changes.filter { $0.table == "lanes" }.map(\.pk)
    XCTAssertFalse(lanePrimaryKeys.isEmpty)
    XCTAssertTrue(lanePrimaryKeys.allSatisfy { $0 == packedDesktopTextPrimaryKey("lane-1") })

    let result = try target.applyChanges(changes)
    XCTAssertGreaterThan(result.appliedCount, 0)

    let mirrored = target.fetchLanes(includeArchived: true)
    XCTAssertEqual(mirrored.count, 1)
    XCTAssertEqual(mirrored.first?.id, "lane-1")
    XCTAssertEqual(mirrored.first?.name, "Inbox")

    source.close()
    target.close()
  }

  func testSyncChangesetBatchPayloadDecodesLegacyBatchWithoutBatchId() throws {
    let data = """
    {
      "reason": "relay",
      "fromDbVersion": 12,
      "toDbVersion": 14,
      "changes": []
    }
    """.data(using: .utf8)!

    let decoded = try JSONDecoder().decode(SyncChangesetBatchPayload.self, from: data)

    XCTAssertEqual(decoded.batchId, "legacy:12:14:0:empty")
    XCTAssertEqual(decoded.reason, "relay")
    XCTAssertEqual(decoded.fromDbVersion, 12)
    XCTAssertEqual(decoded.toDbVersion, 14)
    XCTAssertTrue(decoded.changes.isEmpty)
  }

  func testDatabaseIgnoresDroppedIncomingSyncTables() throws {
    let database = makeDatabase(baseURL: makeTemporaryDirectory())
    XCTAssertNil(database.initializationError)

    let initialVersion = database.currentDbVersion()
    let siteId = "b00e9b92c864a27958669c1595fcb2c3"
    let changes: [CrsqlChangeRow] = [
      CrsqlChangeRow(table: "unified_memories", pk: .string("memory-1"), cid: "content", val: .string("legacy"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 0),
      CrsqlChangeRow(table: "unified_memories_fts", pk: .string("memory-1"), cid: "content", val: .string("legacy"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 1),
    ]

    let result = try database.applyChanges(changes)

    XCTAssertEqual(result.appliedCount, 0)
    XCTAssertEqual(result.dbVersion, initialVersion)
    XCTAssertTrue(result.touchedTables.isEmpty)
    XCTAssertTrue(database.exportChangesSince(version: initialVersion).isEmpty)
    database.close()
  }

  func testDatabaseTreatsQueueWipeMarkerAsLocalOnlySyncState() throws {
    let baseURL = makeTemporaryDirectory()
    let database = DatabaseService(baseURL: baseURL, bootstrapSQL: """
      create table if not exists kv (key text primary key, value text not null);
    """)
    XCTAssertNil(database.initializationError)

    let marker = "queue_landing_state.wiped_for_stacked_overhaul.v1"
    let initialVersion = database.currentDbVersion()
    try database.executeSqlForTesting("""
      update kv set value = 'locally-updated' where key = '\(marker)'
    """)

    let exported = database.exportChangesSince(version: initialVersion)
    XCTAssertFalse(exported.contains {
      $0.table == "kv" && ($0.pk == packedDesktopTextPrimaryKey(marker) || $0.pk == .string(marker))
    })

    let markerValueBeforeApply = try kvValue(in: baseURL, key: marker)
    let versionBeforeApply = database.currentDbVersion()
    let result = try database.applyChanges([
      CrsqlChangeRow(
        table: "kv",
        pk: packedDesktopTextPrimaryKey(marker),
        cid: "value",
        val: .string("remote-marker-should-not-apply"),
        colVersion: 999,
        dbVersion: versionBeforeApply + 1,
        siteId: "ffffffffffffffffffffffffffffffff",
        cl: 1,
        seq: 0
      )
    ])

    XCTAssertEqual(result.appliedCount, 0)
    XCTAssertTrue(result.touchedTables.isEmpty)
    XCTAssertEqual(database.currentDbVersion(), versionBeforeApply)
    XCTAssertEqual(try kvValue(in: baseURL, key: marker), markerValueBeforeApply)
    database.close()
  }

  func testDatabaseIgnoresUnknownIncomingSyncTable() throws {
    let database = makeDatabase(baseURL: makeTemporaryDirectory())
    XCTAssertNil(database.initializationError)

    let initialVersion = database.currentDbVersion()
    let siteId = "b00e9b92c864a27958669c1595fcb2c3"
    let change = CrsqlChangeRow(table: "missing_future_table", pk: .string("row-1"), cid: "name", val: .string("future"), colVersion: 1, dbVersion: 2, siteId: siteId, cl: 1, seq: 0)

    let result = try database.applyChanges([change])
    XCTAssertEqual(result.appliedCount, 0)
    XCTAssertTrue(result.touchedTables.isEmpty)
    XCTAssertEqual(database.currentDbVersion(), initialVersion)
    database.close()
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

  func testDatabaseReplaceLaneSnapshotsSkipsNoOpNotifications() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeLaneHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)
    defer { database.close() }

    try insertHydrationProjectGraph(into: database)
    var notificationCount = 0
    let token = NotificationCenter.default.addObserver(
      forName: .adeDatabaseDidChange,
      object: nil,
      queue: nil
    ) { _ in
      notificationCount += 1
    }
    defer { NotificationCenter.default.removeObserver(token) }

    let snapshot = makeLaneListSnapshot(
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
    )

    try database.replaceLaneSnapshots([snapshot.lane], snapshots: [snapshot])
    XCTAssertEqual(notificationCount, 1)
    try database.replaceLaneSnapshots([snapshot.lane], snapshots: [snapshot])
    XCTAssertEqual(notificationCount, 1)
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

  func testDatabaseReplaceLaneDetailSkipsNoOpNotifications() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)
    defer { database.close() }

    try insertHydrationProjectGraph(into: database)
    var notificationCount = 0
    let token = NotificationCenter.default.addObserver(
      forName: .adeDatabaseDidChange,
      object: nil,
      queue: nil
    ) { _ in
      notificationCount += 1
    }
    defer { NotificationCenter.default.removeObserver(token) }

    let snapshot = makeLaneListSnapshot(
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
    )
    let detail = LaneDetailPayload(
      lane: snapshot.lane,
      runtime: snapshot.runtime,
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
      chatSessions: []
    )

    try database.replaceLaneDetail(detail)
    XCTAssertEqual(notificationCount, 1)
    try database.replaceLaneDetail(detail)
    XCTAssertEqual(notificationCount, 1)
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

  func testDatabaseUpdateSessionMetaPersistsRenamePinnedAndManualName() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    try database.replaceTerminalSessions([
      TerminalSessionSummary(
        id: "session-rename",
        laneId: "lane-primary",
        laneName: "Primary",
        ptyId: nil,
        tracked: true,
        pinned: false,
        manuallyNamed: false,
        goal: nil,
        toolType: "codex-chat",
        title: "Original title",
        status: "running",
        startedAt: "2026-03-17T00:10:00.000Z",
        endedAt: nil,
        exitCode: nil,
        transcriptPath: "/tmp/session-rename.log",
        headShaStart: nil,
        headShaEnd: nil,
        lastOutputPreview: nil,
        summary: nil,
        runtimeState: "running",
        resumeCommand: "codex",
        resumeMetadata: nil,
        chatIdleSinceAt: nil
      ),
    ])

    try database.updateSessionMeta(
      sessionId: "session-rename",
      title: "Renamed from phone",
      pinned: true,
      manuallyNamed: true
    )

    let session = try XCTUnwrap(database.fetchSessions().first)
    XCTAssertEqual(session.title, "Renamed from phone")
    XCTAssertTrue(session.pinned)
    XCTAssertTrue(session.manuallyNamed ?? false)
    database.close()
  }

  func testDatabaseReplaceTerminalSessionsPersistsChatSessionId() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    var session = TerminalSessionSummary(
      id: "session-chat-owned",
      laneId: "lane-primary",
      laneName: "Primary",
      ptyId: "pty-1",
      tracked: true,
      pinned: false,
      goal: nil,
      toolType: "run-shell",
      title: "App Control terminal",
      status: "running",
      startedAt: "2026-03-17T00:10:00.000Z",
      endedAt: nil,
      exitCode: nil,
      transcriptPath: "/tmp/session-chat-owned.log",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: nil,
      summary: nil,
      runtimeState: "running",
      resumeCommand: nil
    )
    session.chatSessionId = "chat-abc"
    try database.replaceTerminalSessions([session])

    let stored = try XCTUnwrap(database.fetchSessions().first)
    XCTAssertEqual(stored.chatSessionId, "chat-abc")

    // Round-trip via JSON to confirm the wire-format Codable layer preserves the field too.
    let encoded = try JSONEncoder().encode(stored)
    let decoded = try JSONDecoder().decode(TerminalSessionSummary.self, from: encoded)
    XCTAssertEqual(decoded.chatSessionId, "chat-abc")

    // Decoding a payload that omits the new field (older desktop builds) still succeeds.
    let legacyJson = """
    {
      "id": "legacy-session",
      "laneId": "lane-primary",
      "laneName": "Primary",
      "tracked": true,
      "pinned": false,
      "title": "Legacy",
      "status": "running",
      "startedAt": "2026-03-17T00:10:00.000Z",
      "transcriptPath": "/tmp/legacy.log",
      "runtimeState": "running"
    }
    """
    let legacy = try JSONDecoder().decode(TerminalSessionSummary.self, from: Data(legacyJson.utf8))
    XCTAssertNil(legacy.chatSessionId)

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

  func testDatabaseReplacePullRequestHydrationSkipsPrsUntilLaneRowsArrive() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try database.executeSqlForTesting("""
      insert into projects (
        id, root_path, display_name, default_base_ref, created_at, last_opened_at
      ) values (
        'project-1', '/tmp/project', 'ADE', 'main', '2026-03-17T00:00:00.000Z', '2026-03-17T00:00:00.000Z'
      );
    """)

    let payload = PullRequestRefreshPayload(
      refreshedCount: 1,
      prs: [
        PrSummary(
          id: "pr-before-lane",
          laneId: "lane-primary",
          projectId: "project-1",
          repoOwner: "arul",
          repoName: "ade",
          githubPrNumber: 43,
          githubUrl: "https://github.com/arul/ade/pull/43",
          githubNodeId: nil,
          title: "Arrives before lane",
          state: "open",
          baseBranch: "main",
          headBranch: "ade/mobile-pr-before-lane",
          checksStatus: "pending",
          reviewStatus: "requested",
          additions: 5,
          deletions: 1,
          lastSyncedAt: "2026-03-17T00:10:00.000Z",
          createdAt: "2026-03-17T00:10:00.000Z",
          updatedAt: "2026-03-17T00:10:00.000Z"
        ),
      ],
      snapshots: [
        PullRequestSnapshotHydration(
          prId: "pr-before-lane",
          detail: nil,
          status: PrStatus(
            prId: "pr-before-lane",
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

    XCTAssertNoThrow(try database.replacePullRequestHydration(payload))
    XCTAssertTrue(database.fetchPullRequests().isEmpty)
    XCTAssertNil(database.fetchPullRequestSnapshot(prId: "pr-before-lane"))

    try database.executeSqlForTesting("""
      insert into lanes (
        id, project_id, name, description, lane_type, base_ref, branch_ref, worktree_path,
        attached_root_path, is_edit_protected, parent_lane_id, color, icon, tags_json, folder,
        status, created_at, archived_at
      ) values (
        'lane-primary', 'project-1', 'Primary', null, 'primary', 'main', 'main', '/tmp/project',
        null, 1, null, null, null, null, null,
        'active', '2026-03-17T00:00:00.000Z', null
      );
    """)

    try database.replacePullRequestHydration(payload)
    XCTAssertEqual(database.fetchPullRequests().map(\.id), ["pr-before-lane"])
    XCTAssertEqual(database.fetchPullRequestSnapshot(prId: "pr-before-lane")?.status?.isMergeable, true)
    database.close()
  }

  func testDatabaseReplacePullRequestHydrationTargetedRefreshDoesNotPruneOtherPullRequests() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)

    func summary(id: String, number: Int, title: String, updatedAt: String) -> PrSummary {
      PrSummary(
        id: id,
        laneId: "lane-primary",
        projectId: "project-1",
        repoOwner: "arul",
        repoName: "ade",
        githubPrNumber: number,
        githubUrl: "https://github.com/arul/ade/pull/\(number)",
        githubNodeId: nil,
        title: title,
        state: "open",
        baseBranch: "main",
        headBranch: "ade/\(id)",
        checksStatus: "pending",
        reviewStatus: "requested",
        additions: 5,
        deletions: 1,
        lastSyncedAt: updatedAt,
        createdAt: "2026-03-17T00:10:00.000Z",
        updatedAt: updatedAt
      )
    }

    func snapshot(prId: String, isMergeable: Bool, updatedAt: String) -> PullRequestSnapshotHydration {
      PullRequestSnapshotHydration(
        prId: prId,
        detail: nil,
        status: PrStatus(
          prId: prId,
          state: "open",
          checksStatus: "pending",
          reviewStatus: "requested",
          isMergeable: isMergeable,
          mergeConflicts: false,
          behindBaseBy: 0
        ),
        checks: [],
        reviews: [],
        comments: [],
        files: [],
        updatedAt: updatedAt
      )
    }

    try database.replacePullRequestHydration(
      PullRequestRefreshPayload(
        refreshedCount: 2,
        prs: [
          summary(id: "pr-one", number: 41, title: "One", updatedAt: "2026-03-17T00:10:00.000Z"),
          summary(id: "pr-two", number: 42, title: "Two", updatedAt: "2026-03-17T00:11:00.000Z"),
        ],
        snapshots: [
          snapshot(prId: "pr-one", isMergeable: true, updatedAt: "2026-03-17T00:10:00.000Z"),
          snapshot(prId: "pr-two", isMergeable: true, updatedAt: "2026-03-17T00:11:00.000Z"),
        ]
      )
    )

    try database.replacePullRequestHydration(
      PullRequestRefreshPayload(
        refreshedCount: 1,
        prs: [
          summary(id: "pr-one", number: 41, title: "One updated", updatedAt: "2026-03-17T00:12:00.000Z"),
        ],
        snapshots: [
          snapshot(prId: "pr-one", isMergeable: false, updatedAt: "2026-03-17T00:12:00.000Z"),
        ]
      ),
      pruneStale: false
    )

    let prs = database.fetchPullRequests()
    XCTAssertEqual(Set(prs.map(\.id)), Set(["pr-one", "pr-two"]))
    XCTAssertEqual(prs.first(where: { $0.id == "pr-one" })?.title, "One updated")
    XCTAssertEqual(database.fetchPullRequestSnapshot(prId: "pr-one")?.status?.isMergeable, false)
    XCTAssertEqual(database.fetchPullRequestSnapshot(prId: "pr-two")?.status?.isMergeable, true)
    database.close()
  }

  func testDatabaseReplacePullRequestHydrationScopesPayloadToActiveProject() throws {
    let baseURL = makeTemporaryDirectory()
    let database = makeControllerHydrationDatabase(baseURL: baseURL)
    XCTAssertNil(database.initializationError)

    try insertHydrationProjectGraph(into: database)
    try database.replacePullRequestHydration(
      PullRequestRefreshPayload(
        refreshedCount: 1,
        prs: [
          PrSummary(
            id: "pr-host-project",
            laneId: "lane-primary",
            projectId: "host-db-project",
            repoOwner: "arul",
            repoName: "ade",
            githubPrNumber: 99,
            githubUrl: "https://github.com/arul/ade/pull/99",
            githubNodeId: nil,
            title: "Scope to mobile active project",
            state: "open",
            baseBranch: "main",
            headBranch: "ade/scope-pr",
            checksStatus: "failing",
            reviewStatus: "pending",
            additions: 1,
            deletions: 0,
            lastSyncedAt: nil,
            createdAt: "2026-03-17T00:10:00.000Z",
            updatedAt: "2026-03-17T00:10:00.000Z"
          ),
        ],
        snapshots: []
      )
    )

    let prs = database.fetchPullRequests()
    XCTAssertEqual(prs.map(\.id), ["pr-host-project"])
    XCTAssertEqual(prs.first?.projectId, "project-1")

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
      XCTAssertEqual((error as NSError).localizedDescription, "This action requires a live connection to the machine.")
    }
  }

  @MainActor
  func testRemoteCommandPolicyQueuesChatSendWhenOffline() async throws {
    let remoteCommandDescriptorsKey = "ade.sync.remoteCommandDescriptors"
    let pendingOperationsKey = "ade.sync.pendingOperations"
    UserDefaults.standard.removeObject(forKey: remoteCommandDescriptorsKey)
    UserDefaults.standard.removeObject(forKey: pendingOperationsKey)
    defer {
      UserDefaults.standard.removeObject(forKey: remoteCommandDescriptorsKey)
      UserDefaults.standard.removeObject(forKey: pendingOperationsKey)
    }

    let descriptors = [
      SyncRemoteCommandDescriptor(
        action: "chat.send",
        policy: SyncRemoteCommandPolicy(viewerAllowed: true, requiresApproval: nil, localOnly: nil, queueable: true)
      ),
    ]
    UserDefaults.standard.set(try JSONEncoder().encode(descriptors), forKey: remoteCommandDescriptorsKey)

    let database = makeDatabase(baseURL: makeTemporaryDirectory())
    defer { database.close() }
    let service = SyncService(database: database)
    service.disconnect()

    let delivery = try await service.sendChatMessage(sessionId: "chat-1", text: "keep this draft moving")

    XCTAssertEqual(delivery, .queued(steerId: nil))
    let queued = service.pendingOperationsForTesting()
    XCTAssertEqual(service.pendingOperationCount, 1)
    XCTAssertEqual(queued.count, 1)
    XCTAssertEqual(queued.first?.kind, "command")
    XCTAssertEqual(queued.first?.action, "chat.send")
  }

  @MainActor
  func testFireAndForgetRemoteCommandQueuesWithStableCommandIdWhenOffline() async throws {
    let remoteCommandDescriptorsKey = "ade.sync.remoteCommandDescriptors"
    let pendingOperationsKey = "ade.sync.pendingOperations"
    UserDefaults.standard.removeObject(forKey: remoteCommandDescriptorsKey)
    UserDefaults.standard.removeObject(forKey: pendingOperationsKey)
    defer {
      UserDefaults.standard.removeObject(forKey: remoteCommandDescriptorsKey)
      UserDefaults.standard.removeObject(forKey: pendingOperationsKey)
    }

    let descriptors = [
      SyncRemoteCommandDescriptor(
        action: "chat.approve",
        policy: SyncRemoteCommandPolicy(viewerAllowed: true, requiresApproval: nil, localOnly: nil, queueable: true)
      ),
    ]
    UserDefaults.standard.set(try JSONEncoder().encode(descriptors), forKey: remoteCommandDescriptorsKey)

    let service = SyncService(database: makeDatabase(baseURL: makeTemporaryDirectory()))
    let delivery = await service.sendRemoteCommand(.approveSession, payload: [
      "sessionId": "session-1",
      "itemId": "approval-1",
    ])

    XCTAssertEqual(delivery, .queued)
    let queued = service.pendingOperationsForTesting()
    XCTAssertEqual(service.pendingOperationCount, 1)
    XCTAssertEqual(queued.count, 1)
    XCTAssertEqual(queued.first?.kind, "command")
    XCTAssertEqual(queued.first?.action, "chat.approve")
    XCTAssertTrue(queued.first?.id.hasPrefix("ios-") == true)
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

  func testRepoScopedGitHubPullRequestsIgnoreLegacyExternalHistory() {
    func githubItem(id: String, scope: String, owner: String, repo: String, number: Int) -> GitHubPrListItem {
      GitHubPrListItem(
        id: id,
        scope: scope,
        repoOwner: owner,
        repoName: repo,
        githubPrNumber: number,
        githubUrl: "https://github.com/\(owner)/\(repo)/pull/\(number)",
        title: "PR \(number)",
        state: "open",
        isDraft: false,
        baseBranch: "main",
        headBranch: "feature/\(number)",
        author: "octocat",
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        linkedPrId: nil,
        linkedGroupId: nil,
        linkedLaneId: nil,
        linkedLaneName: nil,
        adeKind: nil,
        workflowDisplayState: nil,
        cleanupState: nil,
        labels: [],
        isBot: false,
        commentCount: 0
      )
    }

    let snapshot = GitHubPrSnapshot(
      repo: GitHubRepoRef(owner: "arul", name: "ADE", defaultBranch: "main"),
      viewerLogin: "octocat",
      repoPullRequests: [
        githubItem(id: "repo-pr", scope: "repo", owner: "arul", repo: "ADE", number: 10),
      ],
      externalPullRequests: [
        githubItem(id: "external-pr", scope: "external", owner: "elsewhere", repo: "other", number: 20),
      ],
      syncedAt: "2026-05-14T00:00:00.000Z"
    )

    XCTAssertEqual(repoScopedGitHubPullRequests(from: snapshot).map(\.id), ["repo-pr"])
  }

  func testPrDetailRouteListItemUsesRepoContextForDuplicatePrNumbers() {
    func item(id: String, owner: String, repo: String, laneId: String) -> PullRequestListItem {
      PullRequestListItem(
        id: id,
        laneId: laneId,
        laneName: nil,
        projectId: "project-1",
        repoOwner: owner,
        repoName: repo,
        githubPrNumber: 42,
        githubUrl: "https://github.com/\(owner)/\(repo)/pull/42",
        title: "PR 42",
        state: "open",
        baseBranch: "main",
        headBranch: "feature/42",
        checksStatus: "pending",
        reviewStatus: "requested",
        additions: 1,
        deletions: 0,
        lastSyncedAt: nil,
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        adeKind: nil,
        linkedGroupId: nil,
        linkedGroupType: nil,
        linkedGroupName: nil,
        linkedGroupPosition: nil,
        linkedGroupCount: 0,
        workflowDisplayState: nil,
        cleanupState: nil
      )
    }

    let githubItem = GitHubPrListItem(
      id: "repo-pr",
      scope: "repo",
      repoOwner: "arul",
      repoName: "ADE",
      githubPrNumber: 42,
      githubUrl: "https://github.com/arul/ADE/pull/42",
      title: "Repo PR",
      state: "open",
      isDraft: false,
      baseBranch: "main",
      headBranch: "feature/42",
      author: "octocat",
      createdAt: "2026-05-14T00:00:00.000Z",
      updatedAt: "2026-05-14T00:00:00.000Z",
      linkedPrId: nil,
      linkedGroupId: nil,
      linkedLaneId: nil,
      linkedLaneName: nil,
      adeKind: nil,
      workflowDisplayState: nil,
      cleanupState: nil,
      labels: [],
      isBot: false,
      commentCount: 0
    )

    let match = prDetailRouteListItem(
      from: [
        item(id: "wrong-repo", owner: "elsewhere", repo: "other", laneId: "lane-other"),
        item(id: "right-repo", owner: "ARUL", repo: "ade", laneId: "lane-ade"),
      ],
      prId: "github-pr-number:42",
      requestedPrNumber: 42,
      githubItem: githubItem
    )

    XCTAssertEqual(match?.id, "right-repo")
  }

  func testPrDetailRouteListItemRejectsAmbiguousNumberRouteWithoutContext() {
    func item(id: String, owner: String, repo: String) -> PullRequestListItem {
      PullRequestListItem(
        id: id,
        laneId: "lane-\(id)",
        laneName: nil,
        projectId: "project-1",
        repoOwner: owner,
        repoName: repo,
        githubPrNumber: 42,
        githubUrl: "https://github.com/\(owner)/\(repo)/pull/42",
        title: "PR 42",
        state: "open",
        baseBranch: "main",
        headBranch: "feature/42",
        checksStatus: "pending",
        reviewStatus: "requested",
        additions: 1,
        deletions: 0,
        lastSyncedAt: nil,
        createdAt: "2026-05-14T00:00:00.000Z",
        updatedAt: "2026-05-14T00:00:00.000Z",
        adeKind: nil,
        linkedGroupId: nil,
        linkedGroupType: nil,
        linkedGroupName: nil,
        linkedGroupPosition: nil,
        linkedGroupCount: 0,
        workflowDisplayState: nil,
        cleanupState: nil
      )
    }

    let match = prDetailRouteListItem(
      from: [
        item(id: "first", owner: "arul", repo: "ade"),
        item(id: "second", owner: "elsewhere", repo: "other"),
      ],
      prId: "github-pr-number:42",
      requestedPrNumber: 42,
      githubItem: nil
    )

    XCTAssertNil(match)
  }

  func testPrParsedDateHandlesFractionalAndFallbackIsoDates() {
    let fractional = prParsedDate("2026-05-14T00:00:00.123Z")
    let fallback = prParsedDate("2026-05-14T00:00:00Z")

    XCTAssertNotNil(fractional)
    XCTAssertNotNil(fallback)
    XCTAssertEqual(fallback, prParsedDate("2026-05-14T00:00:00Z"))
  }

  func testPrDetailSidecarFetchPolicySkipsLocalRevisionAfterInitialLoad() {
    XCTAssertTrue(shouldFetchPrDetailLiveSidecars(hasLoadedLiveSidecars: false, refreshRemote: false))
    XCTAssertFalse(shouldFetchPrDetailLiveSidecars(hasLoadedLiveSidecars: true, refreshRemote: false))
    XCTAssertTrue(shouldFetchPrDetailLiveSidecars(hasLoadedLiveSidecars: true, refreshRemote: true))
  }

  func testPrChecksSummaryFallsBackToOverallFailingStatus() {
    let stats = prChecksSummaryStats(checks: [], overallChecksStatus: "failing")

    XCTAssertEqual(stats, PrChecksSummaryStats(fail: 1, pending: 0, pass: 0, total: 1))
    XCTAssertTrue(prChecksHasFailedSignal(checks: [], overallChecksStatus: "failing"))
    XCTAssertEqual(prChecksEmptyStateCopy(overallChecksStatus: "failing").title, "Checks failing")
  }

  func testPrChecksSummaryPrefersSyncedCheckRuns() {
    let checks = [
      PrCheck(
        name: "unit",
        status: "completed",
        conclusion: "success",
        detailsUrl: nil,
        startedAt: nil,
        completedAt: nil
      ),
    ]
    let stats = prChecksSummaryStats(checks: checks, overallChecksStatus: "failing")

    XCTAssertEqual(stats, PrChecksSummaryStats(fail: 0, pending: 0, pass: 1, total: 1))
    XCTAssertFalse(prChecksHasFailedSignal(checks: checks, overallChecksStatus: "failing"))
  }

  func testPrMergeGateDoesNotShowGreenWhenStatusIsMissing() {
    let gate = prComputeMergeGate(
      status: nil,
      checks: [],
      summaryChecksStatus: nil,
      reviewThreadsUnresolved: 0,
      reviewsNeeded: 0,
      reviewsHave: 0,
      capabilities: nil
    )

    XCTAssertEqual(gate.tone, .amber)
    XCTAssertEqual(gate.subline, "Waiting for synced PR status")
  }

  func testPrMergeGateUsesSummaryFailingStatusBeforeCheckRowsSync() {
    let gate = prComputeMergeGate(
      status: nil,
      checks: [],
      summaryChecksStatus: "failing",
      reviewThreadsUnresolved: 0,
      reviewsNeeded: 0,
      reviewsHave: 0,
      capabilities: nil
    )

    XCTAssertEqual(gate.tone, .red)
    XCTAssertEqual(gate.subline, "checks failing")
    XCTAssertEqual(gate.target, .checks)
  }

  func testPrMergeGatePrefersSyncedCheckRowsOverStaleSummaryStatus() {
    let checks = [
      PrCheck(
        name: "unit",
        status: "completed",
        conclusion: "success",
        detailsUrl: nil,
        startedAt: nil,
        completedAt: nil
      ),
    ]
    let status = PrStatus(
      prId: "pr-1",
      state: "open",
      checksStatus: "failing",
      reviewStatus: "approved",
      isMergeable: true,
      mergeConflicts: false,
      behindBaseBy: 0
    )

    let gate = prComputeMergeGate(
      status: status,
      checks: checks,
      summaryChecksStatus: "failing",
      reviewThreadsUnresolved: 0,
      reviewsNeeded: 1,
      reviewsHave: 1,
      capabilities: nil
    )

    XCTAssertEqual(gate.tone, .green)
    XCTAssertEqual(gate.target, .overview)
  }

  func testPrLinkLanePreselectionRequiresExactBranchMatch() {
    func lane(id: String, name: String, branchRef: String) -> LaneSummary {
      LaneSummary(
        id: id,
        name: name,
        description: nil,
        laneType: "feature",
        baseRef: "main",
        branchRef: branchRef,
        worktreePath: "/tmp/\(id)",
        attachedRootPath: nil,
        parentLaneId: nil,
        childCount: 0,
        stackDepth: 0,
        parentStatus: nil,
        isEditProtected: false,
        status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
        color: nil,
        icon: nil,
        tags: [],
        folder: nil,
        createdAt: "2026-03-20T00:00:00.000Z",
        archivedAt: nil
      )
    }

    let lanes = [
      lane(id: "lane-name-collision", name: "cursor/windows-port-foundations-ede6", branchRef: "automations-overhaul"),
      lane(id: "lane-branch-match", name: "Windows port", branchRef: "cursor/windows-port-foundations-ede6"),
    ]

    XCTAssertEqual(matchedLaneForExactBranch("cursor/windows-port-foundations-ede6", lanes: lanes)?.id, "lane-branch-match")
    XCTAssertEqual(matchedLaneForExactBranch("refs/heads/cursor/windows-port-foundations-ede6", lanes: lanes)?.id, "lane-branch-match")
    XCTAssertEqual(matchedLaneForExactBranch("origin/cursor/windows-port-foundations-ede6", lanes: lanes)?.id, "lane-branch-match")
    XCTAssertNil(matchedLaneForExactBranch("automations overhaul", lanes: lanes))
    XCTAssertNil(matchedLaneForExactBranch("   ", lanes: lanes))
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
          agentSummary: ["title": .string("Codex"), "objective": .string("Handle OAuth redirects")],
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

  func testLaneDeleteDependencyBatchesKeepAncestorsAfterSelectedDescendants() {
    let status = LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false)
    let runtime = LaneRuntimeSummary(bucket: "ended", runningCount: 0, awaitingInputCount: 0, endedCount: 1, sessionCount: 1)

    func snapshot(_ id: String, parentLaneId: String? = nil) -> LaneListSnapshot {
      var snapshot = makeLaneListSnapshot(
        id: id,
        name: id,
        laneType: "worktree",
        baseRef: "main",
        branchRef: "ade/\(id)",
        worktreePath: "/project/.ade/worktrees/\(id)",
        description: nil,
        status: status,
        runtime: runtime,
        createdAt: "2026-03-20T00:00:00.000Z",
        archivedAt: nil
      )
      snapshot.lane.parentLaneId = parentLaneId
      return snapshot
    }

    let batches = laneDeleteDependencyBatches(snapshots: [
      snapshot("lane-parent"),
      snapshot("lane-child-b", parentLaneId: "lane-parent"),
      snapshot("lane-grandchild", parentLaneId: "lane-child-a"),
      snapshot("lane-child-a", parentLaneId: "lane-parent"),
      snapshot("lane-sibling"),
    ])

    XCTAssertEqual(batches, [
      ["lane-child-b", "lane-grandchild", "lane-sibling"],
      ["lane-child-a"],
      ["lane-parent"],
    ])
  }

  @MainActor
  func testLaneDeleteBatchRunnerStartsTwoDeletesAtOnceAndPreservesOrder() async {
    enum DeleteError: Error {
      case expected
    }

    let recorder = LaneBatchDeleteRecorder()

    let task = Task { @MainActor in
      await runLaneDeleteBatchWithConcurrency(laneIds: ["lane-a", "lane-b", "lane-c"]) { laneId -> String in
        await recorder.start(laneId)
        if laneId != "lane-c" {
          await recorder.waitForRelease()
        }
        await recorder.finish()
        if laneId == "lane-b" {
          throw DeleteError.expected
        }
        return "\(laneId)-done"
      }
    }

    await recorder.waitForStartedCount(2)
    let firstStartedIds = await recorder.startedIds()
    let firstMaxActiveCount = await recorder.maxActiveCount()
    XCTAssertEqual(firstStartedIds, ["lane-a", "lane-b"])
    XCTAssertEqual(firstMaxActiveCount, 2)

    await recorder.release()
    let results = await task.value

    let finalMaxActiveCount = await recorder.maxActiveCount()
    XCTAssertEqual(results.map(\.laneId), ["lane-a", "lane-b", "lane-c"])
    XCTAssertEqual(finalMaxActiveCount, 2)
    XCTAssertEqual(try? results[0].result.get(), "lane-a-done")
    XCTAssertThrowsError(try results[1].result.get())
    XCTAssertEqual(try? results[2].result.get(), "lane-c-done")
  }

  func testLaneCardRebaseWarningPrefersAutoRebaseStatusOverSuggestion() {
    var snapshot = makeLaneListSnapshot(
      id: "lane-rebase",
      name: "iOS simulator",
      laneType: "worktree",
      baseRef: "main",
      branchRef: "ade/ios-sim",
      worktreePath: "/project/.ade/worktrees/ios-sim",
      description: nil,
      status: LaneStatus(dirty: false, ahead: 0, behind: 2, remoteBehind: 0, rebaseInProgress: false),
      runtime: LaneRuntimeSummary(bucket: "ended", runningCount: 0, awaitingInputCount: 0, endedCount: 1, sessionCount: 1),
      createdAt: "2026-03-20T00:00:00.000Z",
      archivedAt: nil
    )
    snapshot.rebaseSuggestion = RebaseSuggestion(
      laneId: "lane-rebase",
      parentLaneId: "lane-main",
      parentHeadSha: "parent-sha",
      behindCount: 2,
      lastSuggestedAt: "2026-03-20T00:01:00.000Z",
      deferredUntil: nil,
      dismissedAt: nil,
      hasPr: true
    )
    snapshot.autoRebaseStatus = AutoRebaseLaneStatus(
      laneId: "lane-rebase",
      parentLaneId: "lane-main",
      parentHeadSha: "parent-sha",
      state: "rebaseConflict",
      updatedAt: "2026-03-20T00:02:00.000Z",
      conflictCount: 3,
      message: "Resolve conflicts in the Rebase/Merge tab."
    )

    let warning = laneCardRebaseWarningPresentation(for: snapshot)

    XCTAssertEqual(warning, .autoRebase(state: "rebaseConflict", message: "Resolve conflicts in the Rebase/Merge tab."))
    XCTAssertEqual(warning?.accessibilitySummary, "Auto-rebase conflict. Resolve conflicts in the Rebase/Merge tab.")
  }

  func testSelectLanePrTagPrefersOpenPrOnMatchingBranch() {
    let lane = LaneSummary(
      id: "lane-audit",
      name: "mobile audit",
      description: nil,
      laneType: "worktree",
      baseRef: "main",
      branchRef: "ade/mobile-audit-34b23435",
      worktreePath: "/tmp/mobile-audit",
      attachedRootPath: nil,
      parentLaneId: "lane-primary",
      childCount: 0,
      stackDepth: 1,
      parentStatus: nil,
      isEditProtected: false,
      status: LaneStatus(dirty: true, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
      color: "#a78bfa",
      icon: nil,
      tags: [],
      folder: nil,
      createdAt: "2026-03-20T00:00:00.000Z",
      archivedAt: nil
    )
    let openPr = PullRequestListItem(
      id: "pr-open",
      laneId: "lane-audit",
      laneName: "mobile audit",
      projectId: "project-1",
      repoOwner: "ade",
      repoName: "ADE",
      githubPrNumber: 561,
      githubUrl: "https://github.com/ade/ADE/pull/561",
      title: "Mobile audit",
      state: "open",
      baseBranch: "main",
      headBranch: "ade/mobile-audit-34b23435",
      checksStatus: "passing",
      reviewStatus: "approved",
      additions: 12,
      deletions: 4,
      lastSyncedAt: nil,
      createdAt: "2026-03-20T00:00:00.000Z",
      updatedAt: "2026-03-21T00:00:00.000Z",
      adeKind: nil,
      linkedGroupId: nil,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: nil,
      cleanupState: nil
    )
    let mergedPr = PullRequestListItem(
      id: "pr-merged",
      laneId: "lane-audit",
      laneName: "mobile audit",
      projectId: "project-1",
      repoOwner: "ade",
      repoName: "ADE",
      githubPrNumber: 400,
      githubUrl: "https://github.com/ade/ADE/pull/400",
      title: "Old audit",
      state: "merged",
      baseBranch: "main",
      headBranch: "ade/mobile-audit-34b23435",
      checksStatus: "passing",
      reviewStatus: "approved",
      additions: 1,
      deletions: 1,
      lastSyncedAt: nil,
      createdAt: "2026-03-10T00:00:00.000Z",
      updatedAt: "2026-03-11T00:00:00.000Z",
      adeKind: nil,
      linkedGroupId: nil,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: nil,
      cleanupState: nil
    )

    XCTAssertEqual(selectLanePrTag(lane: lane, pullRequests: [mergedPr, openPr])?.id, "pr-open")
    XCTAssertEqual(formatLanePrBadgeLabel(openPr), "PR #561")
  }

  func testLaneStackCardAccessibilityLabelIncludesRebaseWarningSummary() {
    var snapshot = makeLaneListSnapshot(
      id: "lane-warning",
      name: "Sync polish",
      laneType: "worktree",
      baseRef: "main",
      branchRef: "ade/sync-polish",
      worktreePath: "/project/.ade/worktrees/sync-polish",
      description: nil,
      status: LaneStatus(dirty: false, ahead: 1, behind: 4, remoteBehind: 0, rebaseInProgress: false),
      runtime: LaneRuntimeSummary(bucket: "ended", runningCount: 0, awaitingInputCount: 0, endedCount: 1, sessionCount: 1),
      createdAt: "2026-03-20T00:00:00.000Z",
      archivedAt: nil
    )
    snapshot.rebaseSuggestion = RebaseSuggestion(
      laneId: "lane-warning",
      parentLaneId: "lane-main",
      parentHeadSha: "parent-sha",
      behindCount: 4,
      lastSuggestedAt: "2026-03-20T00:01:00.000Z",
      deferredUntil: nil,
      dismissedAt: nil,
      hasPr: true
    )
    let warning = laneCardRebaseWarningPresentation(for: snapshot)

    let label = laneStackCardAccessibilityLabel(
      snapshot: snapshot,
      isPinned: false,
      isOpen: true,
      rebaseWarning: warning
    )

    XCTAssertTrue(label.contains("Rebase suggested"))
    XCTAssertTrue(label.contains("4 commits behind"))
    XCTAssertTrue(label.contains("PR open"))
  }

  func testLaneDetailRebaseBannerAccessibilityLabelIncludesVisibleBadges() {
    XCTAssertEqual(
      laneDetailRebaseBannerAccessibilityLabel(behindCount: 1, parentLabel: "main", hasPr: true),
      "Rebase suggested. 1 commit behind. PR open. Rebase this lane onto main to pick up new commits."
    )
  }

  func testCompactSyncSummaryUsesRemoteUpstreamState() {
    XCTAssertEqual(compactSyncSummary(nil), "Checking remote")
    XCTAssertEqual(
      compactSyncSummary(
        GitUpstreamSyncStatus(
          hasUpstream: true,
          upstreamRef: "origin/feature",
          ahead: 0,
          behind: 0,
          diverged: false,
          recommendedAction: "none"
        )
      ),
      "In sync with remote"
    )
    XCTAssertEqual(
      compactSyncSummary(
        GitUpstreamSyncStatus(
          hasUpstream: true,
          upstreamRef: "origin/feature",
          ahead: 2,
          behind: 0,
          diverged: false,
          recommendedAction: "push"
        )
      ),
      "2 ahead remote"
    )
    XCTAssertEqual(
      compactSyncSummary(
        GitUpstreamSyncStatus(
          hasUpstream: false,
          upstreamRef: nil,
          ahead: 0,
          behind: 0,
          diverged: false,
          recommendedAction: "publish"
        )
      ),
      "No upstream"
    )
  }

  func testLaneRootEmptyStateGuidesUnpairedUsersWhenNoCacheExists() {
    let emptyState = laneRootEmptyState(
      connectionState: .disconnected,
      laneStatus: .disconnected,
      hasHostProfile: false
    )

    XCTAssertEqual(emptyState?.title, "Pair to load lanes")
    XCTAssertEqual(emptyState?.actionTitle, "Pair with machine")
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

  func testLaneDiscardAllUsesExplicitDestructiveConfirmationCopy() {
    let confirmation = LaneFileConfirmation.discardAllUnstaged([
      FileChange(path: "Sources/App.swift", kind: "modified"),
      FileChange(path: "Tests/AppTests.swift", kind: "modified"),
    ])

    XCTAssertEqual(confirmation.title, "Discard all unstaged changes?")
    XCTAssertEqual(confirmation.confirmTitle, "Discard all")
    XCTAssertEqual(confirmation.actionLabel, "discard all")
    XCTAssertTrue(confirmation.message.contains("2 files"))
    XCTAssertNil(confirmation.file)
  }

  func testLaneDiscardAllSingularizesMessageForOneFile() {
    let single = LaneFileConfirmation.discardAllUnstaged([
      FileChange(path: "Sources/App.swift", kind: "modified")
    ])
    XCTAssertTrue(single.message.contains("1 file "), "expected singular 'file' in: \(single.message)")
    XCTAssertFalse(single.message.contains("1 files"))
  }

  func testLaneFileConfirmationSingleFileCasesExposeCorrectCopyAndSource() {
    let file = FileChange(path: "Sources/App.swift", kind: "modified")
    let discard = LaneFileConfirmation.discardUnstaged(file)
    XCTAssertEqual(discard.title, "Discard changes?")
    XCTAssertEqual(discard.confirmTitle, "Discard")
    XCTAssertEqual(discard.actionLabel, "discard file")
    XCTAssertEqual(discard.file?.path, file.path)
    XCTAssertTrue(discard.id.hasPrefix("discard:"))

    let restore = LaneFileConfirmation.restoreStaged(file)
    XCTAssertEqual(restore.title, "Discard staged changes?")
    XCTAssertEqual(restore.confirmTitle, "Discard staged")
    XCTAssertEqual(restore.actionLabel, "discard staged file")
    XCTAssertEqual(restore.file?.path, file.path)
    XCTAssertTrue(restore.id.hasPrefix("restore:"))
  }

  func testLaneGitConfirmationCoversRebaseLaneAndDescendantsCopy() {
    let lane = LaneGitConfirmation.rebaseLane
    XCTAssertEqual(lane.title, "Rebase this lane?")
    XCTAssertEqual(lane.confirmTitle, "Rebase lane")
    XCTAssertEqual(lane.actionLabel, "rebase lane")
    XCTAssertEqual(lane.id, "rebase-lane")
    XCTAssertTrue(lane.message.contains("parent"))

    let descendants = LaneGitConfirmation.rebaseDescendants
    XCTAssertEqual(descendants.title, "Rebase lane and descendants?")
    XCTAssertEqual(descendants.confirmTitle, "Rebase all")
    XCTAssertEqual(descendants.actionLabel, "rebase descendants")
    XCTAssertEqual(descendants.id, "rebase-descendants")
    XCTAssertTrue(descendants.message.contains("child lanes"))
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

  func testWorkChatQueuedSendRequiresLiveSession() {
    XCTAssertTrue(
      workChatCanSendMessages(
        isLive: true,
        hostReachable: false,
        chatSendQueueable: true
      )
    )
    XCTAssertTrue(
      workChatSendWillQueueMessage(
        isLive: true,
        hostReachable: false,
        chatSendQueueable: true
      )
    )
    XCTAssertFalse(
      workChatCanSendMessages(
        isLive: false,
        hostReachable: false,
        chatSendQueueable: true
      )
    )
    XCTAssertFalse(
      workChatSendWillQueueMessage(
        isLive: false,
        hostReachable: false,
        chatSendQueueable: true
      )
    )
    XCTAssertTrue(
      workChatCanSendMessages(
        isLive: true,
        hostReachable: true,
        chatSendQueueable: false
      )
    )
  }

  func testWorkChatActiveTurnUsesSteerAndClaudeOnlyManualDispatch() {
    let activeSummary = makeAgentChatSessionSummary(provider: "codex", status: "active")
    XCTAssertTrue(workChatShouldSteerActiveTurn(session: nil, summary: activeSummary))

    let idleSummary = makeAgentChatSessionSummary(provider: "codex", status: "idle")
    XCTAssertFalse(workChatShouldSteerActiveTurn(session: nil, summary: idleSummary))

    let runningTerminal = makeTerminalSessionSummary(toolType: "codex-chat", runtimeState: "running", status: "running")
    XCTAssertTrue(workChatShouldSteerActiveTurn(session: runningTerminal, summary: nil))

    let claudeSummary = makeAgentChatSessionSummary(provider: "claude", status: "active")
    XCTAssertTrue(workChatSupportsManualSteerDispatch(session: nil, summary: claudeSummary))
    XCTAssertTrue(workChatSupportsManualSteerDispatch(session: makeTerminalSessionSummary(toolType: "claude-chat"), summary: nil))
    XCTAssertFalse(workChatSupportsManualSteerDispatch(session: nil, summary: activeSummary))
    XCTAssertFalse(workChatSupportsManualSteerDispatch(session: makeTerminalSessionSummary(toolType: "cursor"), summary: nil))
  }

  func testSyncChatMessageDeliveryParsesQueuedSteerResult() {
    XCTAssertEqual(syncChatMessageDelivery(from: ["ok": true, "steerId": "steer-1", "queued": true]), .queued(steerId: "steer-1"))
    XCTAssertEqual(syncChatMessageDelivery(from: ["ok": true, "steerId": "steer-1", "queued": false]), .sent)
    XCTAssertEqual(syncChatMessageDelivery(from: NSNull()), .sent)
  }

  func testWorkChatLiveObservationKeyUsesCoalescedNotificationRevision() {
    XCTAssertEqual(
      workChatLiveObservationKey(sessionId: "chat-1", chatEventNotificationRevision: 7),
      "chat-1-7"
    )
  }

  func testWorkSessionEdgeSwipeDismissRequiresLeadingHorizontalDrag() {
    XCTAssertTrue(
      workSessionShouldDismissForEdgeSwipe(
        startX: 12,
        containerWidth: 390,
        layoutDirection: .leftToRight,
        translation: CGSize(width: 96, height: 12),
        predictedEndTranslation: CGSize(width: 120, height: 12)
      )
    )
    XCTAssertFalse(
      workSessionShouldDismissForEdgeSwipe(
        startX: 60,
        containerWidth: 390,
        layoutDirection: .leftToRight,
        translation: CGSize(width: 160, height: 0),
        predictedEndTranslation: CGSize(width: 180, height: 0)
      )
    )
    XCTAssertFalse(
      workSessionShouldDismissForEdgeSwipe(
        startX: 12,
        containerWidth: 390,
        layoutDirection: .leftToRight,
        translation: CGSize(width: 80, height: 90),
        predictedEndTranslation: CGSize(width: 180, height: 120)
      )
    )
    XCTAssertTrue(
      workSessionShouldDismissForEdgeSwipe(
        startX: 378,
        containerWidth: 390,
        layoutDirection: .rightToLeft,
        translation: CGSize(width: -96, height: 8),
        predictedEndTranslation: CGSize(width: -132, height: 8)
      )
    )
    XCTAssertFalse(
      workSessionShouldDismissForEdgeSwipe(
        startX: 12,
        containerWidth: 390,
        layoutDirection: .rightToLeft,
        translation: CGSize(width: -160, height: 0),
        predictedEndTranslation: CGSize(width: -180, height: 0)
      )
    )
  }

  func testWorkSessionEdgeSwipeAllowsFastFlickBeforeDistanceThreshold() {
    XCTAssertTrue(
      workSessionShouldDismissForEdgeSwipe(
        startX: 8,
        containerWidth: 390,
        layoutDirection: .leftToRight,
        translation: CGSize(width: 52, height: 4),
        predictedEndTranslation: CGSize(width: 160, height: 8)
      )
    )
  }

  func testWorkRootLiveTranscriptFingerprintIgnoresTerminalTailWhenEventsExist() {
    let firstTail = String(repeating: "A", count: 200_000)
    let secondTail = String(repeating: "B", count: 200_000)

    XCTAssertEqual(
      workRootLiveTranscriptFingerprint(
        chatEventRevision: 12,
        streamedEventCount: 42,
        terminalBufferRevision: 1,
        terminalTail: firstTail
      ),
      workRootLiveTranscriptFingerprint(
        chatEventRevision: 12,
        streamedEventCount: 42,
        terminalBufferRevision: 2,
        terminalTail: secondTail
      )
    )

    XCTAssertNotEqual(
      workRootLiveTranscriptFingerprint(
        chatEventRevision: 12,
        streamedEventCount: 0,
        terminalBufferRevision: 1,
        terminalTail: firstTail
      ),
      workRootLiveTranscriptFingerprint(
        chatEventRevision: 12,
        streamedEventCount: 0,
        terminalBufferRevision: 2,
        terminalTail: firstTail
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
      "Quick open needs a live machine connection."
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
        message: "The machine did not return recent commits for this file yet. Reconnect or refresh to try again."
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

  func testFilesDetailRefreshDelayOnlyThrottlesWarmContent() throws {
    XCTAssertNil(filesDetailRefreshDelay(hasLoadedBlob: false, elapsedSinceLastLoad: 0.1))
    XCTAssertNil(filesDetailRefreshDelay(hasLoadedBlob: true, elapsedSinceLastLoad: 0.9, minimumInterval: 0.75))
    let delayed = try XCTUnwrap(filesDetailRefreshDelay(hasLoadedBlob: true, elapsedSinceLastLoad: 0.2, minimumInterval: 0.75))
    XCTAssertEqual(
      delayed,
      0.55,
      accuracy: 0.001
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

    XCTAssertEqual(transcript.count, 6)
    XCTAssertEqual(toolCards.count, 1)
    XCTAssertEqual(toolCards.first?.toolName, "functions.Read")
    XCTAssertEqual(toolCards.first?.status, .completed)
    XCTAssertTrue(toolCards.first?.resultText?.contains("ADE") == true)
  }

  func testWorkChatTranscriptUsesMessageIdToSplitAssistantMessages() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-04-22T22:10:00.000Z","sequence":1,"event":{"type":"user_message","text":"Rebase Windows Port","turnId":"turn-1"}}
    {"sessionId":"chat-1","timestamp":"2026-04-22T22:10:01.000Z","sequence":2,"event":{"type":"text","text":"I will check the branch.","messageId":"msg-progress","turnId":"turn-1"}}
    {"sessionId":"chat-1","timestamp":"2026-04-22T22:10:02.000Z","sequence":3,"event":{"type":"tool_call","tool":"Bash","args":{"command":"git status"},"itemId":"tool-1","turnId":"turn-1"}}
    {"sessionId":"chat-1","timestamp":"2026-04-22T22:10:03.000Z","sequence":4,"event":{"type":"text","text":"Merge complete.","messageId":"msg-final","turnId":"turn-1"}}
    {"sessionId":"chat-1","timestamp":"2026-04-22T22:10:03.500Z","sequence":5,"event":{"type":"text","text":" I did not push.","messageId":"msg-final","turnId":"turn-1"}}
    {"sessionId":"chat-1","timestamp":"2026-04-22T22:10:03.500Z","sequence":6,"event":{"type":"tool_result","tool":"Bash","result":{"synthetic":true,"source":"claude_turn_finalization"},"itemId":"tool-1","turnId":"turn-1","status":"completed"}}
    """

    let transcript = parseWorkChatTranscript(raw)
    let messages = buildWorkChatMessages(from: transcript)
    let assistantMessages = messages.filter { $0.role == "assistant" }

    XCTAssertEqual(assistantMessages.count, 2)
    XCTAssertEqual(assistantMessages.map(\.itemId), ["msg-progress", "msg-final"])
    XCTAssertEqual(assistantMessages.map(\.markdown), [
      "I will check the branch.",
      "Merge complete. I did not push.",
    ])

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    let visibleKinds = snapshot.timeline.compactMap { entry -> String? in
      switch entry.payload {
      case .message(let message) where message.role == "user":
        return "user"
      case .message(let message) where message.role == "assistant":
        return "assistant:\(message.itemId ?? "")"
      case .toolCard(let card):
        return "tool:\(card.id)"
      case .toolGroup(let group):
        // Single tool calls now wrap in a one-member toolGroup payload.
        if case .tool(let card) = group.members.first {
          return "tool:\(card.id)"
        }
        return nil
      default:
        return nil
      }
    }

    XCTAssertEqual(visibleKinds, [
      "user",
      "assistant:msg-progress",
      "tool:tool-1",
      "assistant:msg-final",
    ])
  }

  func testWorkChatMessagesDoNotMergeUnidentifiedAssistantTextAcrossTools() {
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T22:10:01.000Z",
        sequence: 1,
        event: .assistantText(text: "Before tools.", turnId: "turn-1", itemId: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T22:10:02.000Z",
        sequence: 2,
        event: .toolCall(tool: "Bash", argsText: "{}", itemId: "tool-1", parentItemId: nil, turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T22:10:03.000Z",
        sequence: 3,
        event: .assistantText(text: "After tools.", turnId: "turn-1", itemId: nil)
      ),
    ]

    let assistantMessages = buildWorkChatMessages(from: transcript)
      .filter { $0.role == "assistant" }

    XCTAssertEqual(assistantMessages.map(\.markdown), [
      "Before tools.",
      "After tools.",
    ])
  }

  func testWorkChatMessagesSuppressDuplicateAssistantSuffixAcrossTools() {
    let fullText = "Got it, I’ll include the top-left back button in this pass too and shrink its hit chrome without disturbing the title layout."
    let duplicateTail = "-left back button in this pass too and shrink its hit chrome without disturbing the title layout."
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T22:10:01.000Z",
        sequence: 1,
        event: .assistantText(text: fullText, turnId: "turn-1", itemId: "msg-full")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T22:10:02.000Z",
        sequence: 2,
        event: .toolCall(tool: "shell", argsText: "{}", itemId: "tool-1", parentItemId: nil, turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T22:10:03.000Z",
        sequence: 3,
        event: .assistantText(text: duplicateTail, turnId: "turn-1", itemId: "msg-tail")
      ),
    ]

    let assistantMessages = buildWorkChatMessages(from: transcript)
      .filter { $0.role == "assistant" }

    XCTAssertEqual(assistantMessages.map(\.markdown), [fullText])
  }

  func testWorkChatMessagesKeepRepeatedAssistantSubstringAcrossTools() {
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T22:10:01.000Z",
        sequence: 1,
        event: .assistantText(text: "The cache entry is already present.", turnId: "turn-1", itemId: "msg-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T22:10:02.000Z",
        sequence: 2,
        event: .toolCall(tool: "shell", argsText: "{}", itemId: "tool-1", parentItemId: nil, turnId: "turn-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-22T22:10:03.000Z",
        sequence: 3,
        event: .assistantText(text: "cache", turnId: "turn-1", itemId: "msg-2")
      ),
    ]

    let assistantMessages = buildWorkChatMessages(from: transcript)
      .filter { $0.role == "assistant" }

    XCTAssertEqual(assistantMessages.map(\.markdown), [
      "The cache entry is already present.",
      "cache",
    ])
  }

  func testWorkSessionGroupsByLaneSurfacesOrphanLanesPerLaneId() {
    let knownLane = LaneSummary(
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
    let primarySession = makeTerminalSessionSummary(
      id: "session-primary",
      laneId: "lane-primary",
      laneName: "Primary",
      toolType: "codex-chat",
      startedAt: "2026-03-25T12:00:00.000Z"
    )
    // Two distinct soft-deleted lanes — each should render as its own group.
    // `lane-deleted-a` wins the orphan sort because its latest session started
    // more recently than the latest on `lane-deleted-b`.
    let orphanOldSession = makeTerminalSessionSummary(
      id: "session-orphan-old",
      laneId: "lane-deleted-a",
      laneName: "feature/cleanup",
      toolType: "codex-chat",
      startedAt: "2026-03-25T11:30:00.000Z"
    )
    let orphanNewSession = makeTerminalSessionSummary(
      id: "session-orphan-new",
      laneId: "lane-deleted-b",
      laneName: "feature/recent",
      toolType: "codex-chat",
      startedAt: "2026-03-25T10:45:00.000Z"
    )
    // Same orphan lane appearing twice — must merge into the same group.
    // This sibling is older than `orphanOldSession` so the ordering assertion
    // below exercises the latest-startedAt-per-lane comparison.
    let orphanNewSessionSibling = makeTerminalSessionSummary(
      id: "session-orphan-new-sibling",
      laneId: "lane-deleted-b",
      laneName: "feature/recent",
      toolType: "codex-chat",
      startedAt: "2026-03-25T10:30:00.000Z"
    )

    let groups = workSessionGroupsByLane(
      sessions: [primarySession, orphanOldSession, orphanNewSession, orphanNewSessionSibling],
      orderedLanes: [knownLane]
    )

    XCTAssertEqual(groups.map(\.id), ["lane:lane-primary", "lane:lane-deleted-a", "lane:lane-deleted-b"])
    XCTAssertEqual(groups.map(\.label), ["Primary", "feature/cleanup", "feature/recent"])
    XCTAssertEqual(groups.last?.sessions.count, 2)
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
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:03.000Z","sequence":4,"event":{"type":"done","turnId":"turn-1","status":"completed","model":"claude-sonnet-4","usage":{"inputTokens":120,"outputTokens":45,"cacheReadTokens":12,"cacheCreationTokens":3,"reasoningTokens":7,"contextWindow":200000},"costUsd":1.23}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:04.000Z","sequence":5,"event":{"type":"tokens","turnId":"turn-1","itemId":"tok-1","inputTokens":169600,"outputTokens":701,"cacheReadTokens":168300,"cacheWriteTokens":1200,"contextWindow":258400}}
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:05.000Z","sequence":6,"event":{"type":"codex_token_usage","turnId":"turn-2","usage":{"threadId":"thread-1","turnId":"turn-2","modelContextWindow":258400,"last":{"inputTokens":170000,"outputTokens":800,"cacheReadTokens":168500,"cacheWriteTokens":1300,"reasoningTokens":21},"total":{"totalTokens":170800}}}}
    """

    let transcript = parseWorkChatTranscript(raw)

    XCTAssertEqual(transcript.count, 6)

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
    XCTAssertEqual(usage?.reasoningTokens, 7)
    XCTAssertEqual(usage?.contextWindow, 200000)
    XCTAssertEqual(usage?.costUsd, 1.23)
    XCTAssertEqual(doneTurnId, "turn-1")

    guard case .tokens(let tokenUsage, let tokenTurnId, let tokenItemId) = transcript[4].event else {
      return XCTFail("Expected tokens event.")
    }
    XCTAssertEqual(tokenUsage.inputTokens, 169600)
    XCTAssertEqual(tokenUsage.outputTokens, 701)
    XCTAssertEqual(tokenUsage.cacheReadTokens, 168300)
    XCTAssertEqual(tokenUsage.cacheCreationTokens, 1200)
    XCTAssertEqual(tokenUsage.contextWindow, 258400)
    XCTAssertEqual(tokenTurnId, "turn-1")
    XCTAssertEqual(tokenItemId, "tok-1")

    guard case .tokens(let codexUsage, let codexTurnId, let codexItemId) = transcript[5].event else {
      return XCTFail("Expected codex token usage to normalize to a tokens event.")
    }
    XCTAssertEqual(codexUsage.inputTokens, 170000)
    XCTAssertEqual(codexUsage.outputTokens, 800)
    XCTAssertEqual(codexUsage.cacheReadTokens, 168500)
    XCTAssertEqual(codexUsage.cacheCreationTokens, 1300)
    XCTAssertEqual(codexUsage.reasoningTokens, 21)
    XCTAssertEqual(codexUsage.totalTokens, 170800)
    XCTAssertEqual(codexUsage.contextWindow, 258400)
    XCTAssertEqual(codexTurnId, "turn-2")
    XCTAssertEqual(codexItemId, nil)

    let sessionUsage = summarizeWorkSessionUsage(from: transcript)
    XCTAssertEqual(sessionUsage?.turnCount, 1)
    XCTAssertEqual(sessionUsage?.inputTokens, 120)
    XCTAssertEqual(sessionUsage?.outputTokens, 45)
    XCTAssertEqual(sessionUsage?.cacheReadTokens, 12)
    XCTAssertEqual(sessionUsage?.cacheCreationTokens, 3)
    XCTAssertEqual(sessionUsage?.reasoningTokens, 7)
    XCTAssertEqual(sessionUsage?.contextWindow, 200000)
    XCTAssertEqual(sessionUsage?.costUsd, 1.23)
  }

  func testWorkContextUsageViewModelUsesCodexInputAsOccupancy() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:04.000Z",
        sequence: 5,
        event: .tokens(
          usage: WorkUsageSummary(
            turnCount: 1,
            inputTokens: 169600,
            outputTokens: 701,
            cacheReadTokens: 168300,
            cacheCreationTokens: 1200,
            contextWindow: 258400,
            costUsd: 0
          ),
          turnId: "turn-1",
          itemId: "tok-1"
        )
      )
    ]

    let viewModel = workContextUsageViewModel(
      transcript: transcript,
      summary: makeAgentChatSessionSummary(provider: "codex", model: "GPT-5.5", status: "active")
    )

    XCTAssertEqual(viewModel?.usedTokens, 169600)
    XCTAssertEqual(viewModel?.cacheReadTokens, 168300)
    XCTAssertEqual(viewModel?.cacheWriteTokens, 1200)
    XCTAssertEqual(viewModel?.contextWindow, 258400)
    XCTAssertEqual(viewModel?.windowSource, .runtime)
    XCTAssertEqual(viewModel?.ratio ?? 0, Double(169600) / Double(258400), accuracy: 0.0001)
  }

  func testWorkContextUsageViewModelFallsBackForGpt5Models() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:04.000Z",
        sequence: 5,
        event: .tokens(
          usage: WorkUsageSummary(
            turnCount: 1,
            inputTokens: 129200,
            outputTokens: 100,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            contextWindow: nil,
            costUsd: 0
          ),
          turnId: "turn-1",
          itemId: "tok-1"
        )
      )
    ]

    let viewModel = workContextUsageViewModel(
      transcript: transcript,
      summary: makeAgentChatSessionSummary(provider: "codex", model: "openai/gpt-5.5-codex", status: "active")
    )

    XCTAssertEqual(viewModel?.usedTokens, 129200)
    XCTAssertEqual(viewModel?.contextWindow, 258400)
    XCTAssertEqual(viewModel?.windowSource, .registry)
    XCTAssertEqual(viewModel?.ratio ?? 0, 0.5, accuracy: 0.0001)
  }

  func testWorkContextUsageViewModelSumsGenericInputAndCache() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:04.000Z",
        sequence: 5,
        event: .done(
          status: "completed",
          summary: "Completed",
          usage: WorkUsageSummary(
            turnCount: 1,
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 20,
            cacheCreationTokens: 5,
            contextWindow: 100,
            costUsd: 0
          ),
          turnId: "turn-1",
          model: "Droid model",
          modelId: nil
        )
      )
    ]

    let viewModel = workContextUsageViewModel(
      transcript: transcript,
      summary: makeAgentChatSessionSummary(provider: "droid", model: "droid-model", status: "active")
    )

    XCTAssertEqual(viewModel?.usedTokens, 35)
    XCTAssertEqual(viewModel?.inputTokens, 10)
    XCTAssertEqual(viewModel?.cacheReadTokens, 20)
    XCTAssertEqual(viewModel?.cacheWriteTokens, 5)
    XCTAssertEqual(viewModel?.contextWindow, 100)
    XCTAssertEqual(viewModel?.ratio ?? 0, 0.35, accuracy: 0.0001)
  }

  func testWorkChatStatusNormalizationPrefersAwaitingInputAndIdle() {
    let waitingSummary = makeAgentChatSessionSummary(status: "active", awaitingInput: true)
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: nil, summary: waitingSummary), "awaiting-input")

    let idleSummary = makeAgentChatSessionSummary(status: "paused", awaitingInput: false)
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: nil, summary: idleSummary), "idle")

    let session = makeTerminalSessionSummary(toolType: "codex-chat", runtimeState: "waiting-input", status: "running")
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: session, summary: nil), "awaiting-input")

    let crdtOnlySession = makeTerminalSessionSummary(toolType: "codex-chat", runtimeState: "exited", status: "awaiting_input")
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: crdtOnlySession, summary: nil), "awaiting-input")

    let staleCompletedSummary = makeAgentChatSessionSummary(status: "completed", awaitingInput: false)
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: crdtOnlySession, summary: staleCompletedSummary), "awaiting-input")
  }

  func testWorkChatComposerPlaceholderDistinguishesMissingPromptDetails() {
    XCTAssertTrue(workChatComposerBlocksFreeformInput(pendingInputCount: 0, sessionStatus: "awaiting-input"))
    XCTAssertTrue(workChatAwaitingPromptDetailsMissing(pendingInputCount: 0, sessionStatus: "awaiting-input"))
    XCTAssertEqual(
      workChatComposerPlaceholder(pendingInputCount: 0, sessionStatus: "awaiting-input"),
      "Waiting for prompt details..."
    )
    XCTAssertEqual(
      workChatComposerPlaceholder(pendingInputCount: 1, sessionStatus: "awaiting-input"),
      "Answer the prompt above..."
    )
    XCTAssertEqual(
      workChatComposerPlaceholder(pendingInputCount: 0, sessionStatus: "idle"),
      "Type to vibecode..."
    )
  }

  func testWorkChatStatusNormalizationFallsBackToSessionRuntimeStateAndTerminalState() {
    let completedSummary = makeAgentChatSessionSummary(status: "completed", awaitingInput: false)
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: nil, summary: completedSummary), "ended")

    let runningSession = makeTerminalSessionSummary(toolType: "codex-chat", runtimeState: "running", status: "running")
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: runningSession, summary: nil), "active")

    let idleSession = makeTerminalSessionSummary(toolType: "codex-chat", runtimeState: "idle", status: "running")
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: idleSession, summary: nil), "idle")

    let staleActiveSummary = makeAgentChatSessionSummary(status: "active", awaitingInput: false)
    XCTAssertEqual(normalizedWorkChatSessionStatus(session: idleSession, summary: staleActiveSummary), "idle")

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

  @MainActor
  func testSyncActiveSessionsKeepsFailedChatsForAttentionDrawer() throws {
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

    try database.replaceTerminalSessions([
      makeTerminalSessionSummary(
        id: "failed-chat",
        laneId: "lane-1",
        laneName: "Primary",
        toolType: "codex-chat",
        runtimeState: "exited",
        status: "failed",
        title: "Mobile failed chat",
        lastOutputPreview: "Tool call failed",
        startedAt: "2026-04-20T00:01:00.000Z"
      ),
      makeTerminalSessionSummary(
        id: "completed-chat",
        laneId: "lane-1",
        laneName: "Primary",
        toolType: "codex-chat",
        runtimeState: "exited",
        status: "completed",
        title: "Completed chat",
        startedAt: "2026-04-20T00:02:00.000Z"
      ),
      makeTerminalSessionSummary(
        id: "awaiting-chat",
        laneId: "lane-1",
        laneName: "Primary",
        toolType: "codex-chat",
        runtimeState: "exited",
        status: "awaiting_input",
        title: "Mobile awaiting chat",
        lastOutputPreview: "Approval needed",
        startedAt: "2026-04-20T00:02:30.000Z"
      ),
      makeTerminalSessionSummary(
        id: "failed-shell",
        laneId: "lane-1",
        laneName: "Primary",
        toolType: "shell",
        runtimeState: "exited",
        status: "failed",
        title: "Failed shell",
        startedAt: "2026-04-20T00:03:00.000Z"
      ),
    ])

    let service = SyncService(database: database)
    service.refreshActiveSessionsAndSnapshot()

    let failed = try XCTUnwrap(service.activeSessions.first(where: { $0.sessionId == "failed-chat" }))
    XCTAssertEqual(failed.status, "failed")
    XCTAssertEqual(failed.title, "Mobile failed chat")
    XCTAssertEqual(failed.preview, "Tool call failed")
    XCTAssertFalse(failed.awaitingInput)
    let awaiting = try XCTUnwrap(service.activeSessions.first(where: { $0.sessionId == "awaiting-chat" }))
    XCTAssertEqual(awaiting.status, "awaiting_input")
    XCTAssertEqual(awaiting.title, "Mobile awaiting chat")
    XCTAssertTrue(awaiting.awaitingInput)
    XCTAssertEqual(service.awaitingInputSessionsCount, 1)
    XCTAssertFalse(service.activeSessions.contains(where: { $0.sessionId == "completed-chat" }))
    XCTAssertFalse(service.activeSessions.contains(where: { $0.sessionId == "failed-shell" }))
    database.close()
  }

  func testTerminalResumeTargetDetectionMatchesDesktopResumeAvailability() {
    XCTAssertFalse(terminalSessionHasResumeTarget(makeTerminalSessionSummary(
      toolType: "shell",
      resumeCommand: nil,
      resumeMetadata: nil
    )))
    XCTAssertFalse(terminalSessionHasResumeTarget(makeTerminalSessionSummary(
      toolType: "run-shell",
      resumeCommand: "   ",
      resumeMetadata: nil
    )))
    XCTAssertTrue(terminalSessionHasResumeTarget(makeTerminalSessionSummary(
      toolType: "codex",
      resumeCommand: "codex resume thread-1",
      resumeMetadata: nil
    )))
    XCTAssertTrue(terminalSessionHasResumeTarget(makeTerminalSessionSummary(
      toolType: "codex",
      resumeCommand: nil,
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
      )
    )))
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
      "droidPermissionMode": "auto-low",
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
      "pendingInputItemId": "pending-item-1",
      "threadId": "thread-1",
      "requestedCwd": "apps/ios/ADE",
    ]

    let data = try JSONSerialization.data(withJSONObject: payload)
    let summary = try JSONDecoder().decode(AgentChatSessionSummary.self, from: data)

    XCTAssertEqual(summary.sessionId, "chat-1")
    XCTAssertEqual(summary.provider, "cursor")
    XCTAssertEqual(summary.droidPermissionMode, "auto-low")
    XCTAssertEqual(summary.cursorModeId, "ask")
    XCTAssertEqual(summary.cursorModeSnapshot, .object([
      "currentModeId": .string("ask"),
      "availableModeIds": .array([.string("agent"), .string("ask"), .string("manual")]),
    ]))
    XCTAssertEqual(summary.cursorConfigValues?["voice"], .bool(true))
    XCTAssertEqual(summary.cursorConfigValues?["temperature"], .number(0.5))
    XCTAssertEqual(summary.completion?.artifacts?.first?.reference, "docs/transcript.md")
    XCTAssertTrue(summary.awaitingInput ?? false)
    XCTAssertEqual(summary.pendingInputItemId, "pending-item-1")
    XCTAssertEqual(summary.requestedCwd, "apps/ios/ADE")
  }

  func testAgentChatSessionDecodesCodexFastModeFlag() throws {
    let payload: [String: Any] = [
      "sessionId": "chat-fast",
      "laneId": "lane-1",
      "provider": "codex",
      "model": "gpt-5.4",
      "reasoningEffort": "high",
      "codexFastMode": true,
      "fastMode": true,
      "status": "active",
      "createdAt": "2026-03-25T00:00:00.000Z",
      "lastActivityAt": "2026-03-25T00:00:01.000Z",
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    let session = try JSONDecoder().decode(AgentChatSession.self, from: data)
    XCTAssertEqual(session.codexFastMode, true)
    XCTAssertEqual(session.fastMode, true)
    XCTAssertEqual(session.effectiveFastMode, true)

    let summaryPayload: [String: Any] = [
      "sessionId": "chat-fast",
      "laneId": "lane-1",
      "provider": "codex",
      "model": "gpt-5.4",
      "codexFastMode": false,
      "fastMode": true,
      "status": "active",
      "startedAt": "2026-03-25T00:00:00.000Z",
      "lastActivityAt": "2026-03-25T00:00:01.000Z",
    ]
    let summaryData = try JSONSerialization.data(withJSONObject: summaryPayload)
    let summary = try JSONDecoder().decode(AgentChatSessionSummary.self, from: summaryData)
    XCTAssertEqual(summary.codexFastMode, false)
    XCTAssertEqual(summary.fastMode, true)
    XCTAssertEqual(summary.effectiveFastMode, true)

    // Missing key keeps the flag nil so older app servers continue to decode.
    let legacyPayload: [String: Any] = [
      "sessionId": "chat-legacy",
      "laneId": "lane-1",
      "provider": "claude",
      "model": "claude-sonnet-4-6",
      "status": "active",
      "startedAt": "2026-03-25T00:00:00.000Z",
      "lastActivityAt": "2026-03-25T00:00:01.000Z",
    ]
    let legacyData = try JSONSerialization.data(withJSONObject: legacyPayload)
    let legacy = try JSONDecoder().decode(AgentChatSessionSummary.self, from: legacyData)
    XCTAssertNil(legacy.codexFastMode)
    XCTAssertNil(legacy.fastMode)
    XCTAssertEqual(legacy.effectiveFastMode, false)
  }

  func testWorkModelSelectionChoiceDecodesCanonicalFastMode() throws {
    let canonical = try XCTUnwrap(workModelSelectionChoice(from: [
      "provider": "codex",
      "modelId": "gpt-5.5",
      "reasoningEffort": "high",
      "codexFastMode": false,
      "fastMode": true,
    ]))
    XCTAssertEqual(canonical.provider, "codex")
    XCTAssertEqual(canonical.modelId, "gpt-5.5")
    XCTAssertEqual(canonical.reasoningEffort, "high")
    XCTAssertEqual(canonical.fastMode, true)
    XCTAssertEqual(canonical.codexFastMode, true)

    let encodedData = try JSONEncoder().encode(canonical)
    let encoded = try XCTUnwrap(JSONSerialization.jsonObject(with: encodedData) as? [String: Any])
    XCTAssertEqual(encoded["fastMode"] as? Bool, true)
    XCTAssertNil(encoded["codexFastMode"])

    let legacy = try XCTUnwrap(workModelSelectionChoice(from: [
      "provider": "codex",
      "modelId": "gpt-5.4",
      "codexFastMode": true,
    ]))
    XCTAssertEqual(legacy.fastMode, true)
    XCTAssertEqual(legacy.codexFastMode, true)
  }

  func testWorkReasoningChipLabelMatchesDesktopAbbreviations() {
    XCTAssertNil(workReasoningChipLabel(nil))
    XCTAssertNil(workReasoningChipLabel(" "))
    XCTAssertEqual(workReasoningChipLabel("minimal"), "MIN")
    XCTAssertEqual(workReasoningChipLabel("low"), "LOW")
    XCTAssertEqual(workReasoningChipLabel("medium"), "MED")
    XCTAssertEqual(workReasoningChipLabel("high"), "HI")
    XCTAssertEqual(workReasoningChipLabel("xhigh"), "XH")
    XCTAssertEqual(workReasoningChipLabel("extra-high"), "XH")
    XCTAssertEqual(workReasoningChipLabel("max"), "MAX")
    XCTAssertEqual(workReasoningChipLabel("ultracode"), "ULTRA")
    XCTAssertEqual(workReasoningChipLabel("custom-effort"), "CUS")
  }

  func testWorkChatComposerShowsFastModeForCodexSessionsWithoutPersistedFlag() {
    let codex = makeAgentChatSessionSummary(
      provider: "codex",
      model: "gpt-5.5",
      status: "idle"
    )
    let codexMini = makeAgentChatSessionSummary(
      provider: "codex",
      model: "gpt-5.4-mini",
      status: "idle"
    )
    let claudeOpus = makeAgentChatSessionSummary(
      provider: "claude",
      model: "opus",
      status: "idle"
    )
    let claude = makeAgentChatSessionSummary(
      provider: "claude",
      model: "sonnet",
      status: "idle"
    )
    let openCode = makeAgentChatSessionSummary(
      provider: "opencode",
      model: "opencode/openai/gpt-5.4",
      status: "idle"
    )

    XCTAssertTrue(workChatComposerSupportsFastMode(codex))
    XCTAssertFalse(workChatComposerSupportsFastMode(codexMini))
    XCTAssertTrue(workChatComposerSupportsFastMode(claudeOpus))
    XCTAssertFalse(workChatComposerSupportsFastMode(claude))
    XCTAssertTrue(workChatComposerSupportsFastMode(openCode))
  }

  func testAgentChatModelInfoDetectsFastServiceTier() throws {
    let payload: [String: Any] = [
      "id": "gpt-5.5",
      "displayName": "GPT-5.5",
      "isDefault": true,
      "serviceTiers": ["fast"],
      "aliases": ["gpt-5.5-fast"],
      "cursorAvailability": ["cli": true, "sdk": false],
      "reasoningEfforts": [
        ["effort": "medium", "description": "balanced"],
      ],
    ]
    let data = try JSONSerialization.data(withJSONObject: payload)
    let info = try JSONDecoder().decode(AgentChatModelInfo.self, from: data)
    XCTAssertTrue(info.supportsCodexFastMode)
    XCTAssertTrue(info.supportsServiceTier("FAST"))
    XCTAssertFalse(info.supportsServiceTier("priority"))
    XCTAssertEqual(info.aliases, ["gpt-5.5-fast"])
    XCTAssertEqual(info.cursorAvailability, CursorModelAvailability(cli: true, sdk: false))

    let plainData = try JSONSerialization.data(withJSONObject: [
      "id": "claude-sonnet-4-6",
      "displayName": "Sonnet 4.6",
      "isDefault": false,
    ])
    let plain = try JSONDecoder().decode(AgentChatModelInfo.self, from: plainData)
    XCTAssertFalse(plain.supportsCodexFastMode)
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
        event: .userMessage(text: "First", attachments: nil, turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
      ),
    ]
    let live = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "First", attachments: nil, turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
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
        event: .userMessage(text: "What model are you?", attachments: nil, turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
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
        event: .userMessage(text: "What model are you?", attachments: nil, turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
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

  func testPreferredWorkTranscriptSkipsFallbackAssistantDuplicateWhenTurnIdIsMissing() {
    let paragraph = "The context summary is already present in the live event stream."
    let fallback = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: nil,
        event: .assistantText(text: paragraph, turnId: nil, itemId: nil)
      ),
    ]
    let live = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 42,
        event: .assistantText(text: paragraph, turnId: "turn-1", itemId: "msg-1")
      ),
    ]

    let preferred = preferredWorkTranscript(
      current: live,
      fallback: fallback,
      eventTranscript: live
    )
    let messages = buildWorkChatMessages(from: preferred)

    XCTAssertEqual(preferred.count, 1)
    XCTAssertEqual(preferred.compactMap(\.sequence), [42])
    XCTAssertEqual(messages.filter { $0.role == "assistant" }.map(\.markdown), [paragraph])
    XCTAssertEqual(messages.filter { $0.role == "assistant" }.map(\.turnId), ["turn-1"])
  }

  func testPreferredWorkTranscriptKeepsRepeatedTextWhenTurnIdIsMissing() {
    let live = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "ok", attachments: nil, turnId: nil, steerId: nil, deliveryState: nil, processed: nil)
      ),
    ]
    let fallback = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: nil,
        event: .userMessage(text: "ok", attachments: nil, turnId: nil, steerId: nil, deliveryState: nil, processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:05.000Z",
        sequence: nil,
        event: .userMessage(text: "ok", attachments: nil, turnId: nil, steerId: nil, deliveryState: nil, processed: nil)
      ),
    ]

    let preferred = preferredWorkTranscript(
      current: live,
      fallback: fallback,
      eventTranscript: live
    )

    XCTAssertEqual(buildWorkChatMessages(from: preferred).map(\.markdown), ["ok", "ok"])
    XCTAssertEqual(preferred.map(\.timestamp), [
      "2026-04-20T00:00:01.000Z",
      "2026-04-20T00:00:05.000Z",
    ])
  }

  func testWorkChatMessagesKeepRepeatedAssistantTextWhenTurnIdIsMissing() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .assistantText(text: "Done", turnId: nil, itemId: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 2,
        event: .userMessage(text: "again", attachments: nil, turnId: nil, steerId: nil, deliveryState: nil, processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:03.000Z",
        sequence: 3,
        event: .assistantText(text: "Done", turnId: nil, itemId: nil)
      ),
    ]

    let messages = buildWorkChatMessages(from: transcript)

    XCTAssertEqual(messages.map(\.role), ["assistant", "user", "assistant"])
    XCTAssertEqual(messages.map(\.markdown), ["Done", "again", "Done"])
  }

  func testPreferredWorkTranscriptReplacesTrimmedLiveTailWithFullFallbackText() {
    let fullText = (1...200).map(String.init).joined(separator: "\n")
    let tailText = (121...200).map(String.init).joined(separator: "\n")
    let fallback = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: nil,
        event: .assistantText(text: fullText, turnId: "turn-1", itemId: nil)
      ),
    ]
    let liveTail = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 98,
        event: .assistantText(text: tailText, turnId: "turn-1", itemId: "msg-1")
      ),
    ]

    let preferred = preferredWorkTranscript(
      current: liveTail,
      fallback: fallback,
      eventTranscript: liveTail
    )
    let messages = buildWorkChatMessages(from: preferred)

    XCTAssertEqual(preferred.count, 1)
    XCTAssertEqual(messages.filter { $0.role == "assistant" }.map(\.markdown), [fullText])
  }

  func testPreferredWorkTranscriptDoesNotBackfillQueuedSteerAsPlainUserMessage() {
    let fallback = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: nil,
        event: .userMessage(text: "ship it", attachments: nil, turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
      ),
    ]
    let live = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "ship it", attachments: nil, turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
    ]

    let preferred = preferredWorkTranscript(
      current: live,
      fallback: fallback,
      eventTranscript: live
    )

    XCTAssertEqual(buildWorkChatMessages(from: preferred).map(\.markdown), [])
    XCTAssertEqual(derivePendingWorkSteers(from: preferred).map(\.id), ["steer-1"])
  }

  func testLiveActiveTranscriptPreventsFallbackFromMaskingQueuedSteers() {
    let fallback = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: nil,
        event: .assistantText(text: "old canonical reply", turnId: "turn-old", itemId: nil)
      ),
    ]
    let live = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 2,
        event: .status(turnStatus: "started", message: nil, turnId: "turn-active")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:03.000Z",
        sequence: 3,
        event: .userMessage(text: "keep this staged", attachments: nil, turnId: "turn-active", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:04.000Z",
        sequence: 4,
        event: .systemNotice(kind: "info", message: "Message queued (#1) — will be sent after the current turn.", detail: nil, turnId: "turn-active", steerId: "steer-1")
      ),
    ]

    XCTAssertFalse(workChatShouldPreferFallbackTranscript(
      fallbackTranscript: fallback,
      sessionStatus: "idle",
      liveTranscript: live
    ))

    let preferred = preferredWorkTranscript(
      current: [],
      fallback: fallback,
      eventTranscript: live
    )
    XCTAssertEqual(derivePendingWorkSteers(from: preferred).map(\.id), ["steer-1"])
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

    guard case .userMessage(let text, _, _, let steerId, let deliveryState, _) = transcript[0].event else {
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

  func testParseWorkChatTranscriptPrefersUserMessageDisplayText() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-03-25T00:00:01.000Z","sequence":1,"event":{"type":"user_message","text":"INTERNAL_RUNTIME_PROMPT","displayText":"ADE coordinator start: initialize the session.","turnId":"turn-1"}}
    """

    let transcript = parseWorkChatTranscript(raw)
    XCTAssertEqual(transcript.count, 1)

    guard case .userMessage(let text, _, let turnId, _, _, _) = transcript[0].event else {
      return XCTFail("Expected user_message event.")
    }
    XCTAssertEqual(text, "ADE coordinator start: initialize the session.")
    XCTAssertEqual(turnId, "turn-1")
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
        event: .userMessage(text: "ship", attachments: nil, turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .userMessage(text: "ship it fast", attachments: nil, turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:03.000Z",
        sequence: 3,
        event: .systemNotice(kind: "info", message: "Message queued (#1) — will be sent after the current turn.", detail: nil, turnId: "turn-1", steerId: "steer-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:04.000Z",
        sequence: 4,
        event: .userMessage(text: "also run tests", attachments: nil, turnId: "turn-1", steerId: "steer-2", deliveryState: "queued", processed: nil)
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
        event: .userMessage(text: "first", attachments: nil, turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .userMessage(text: "second", attachments: nil, turnId: "turn-1", steerId: "steer-2", deliveryState: "queued", processed: nil)
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
        event: .userMessage(text: "second", attachments: nil, turnId: "turn-1", steerId: "steer-2", deliveryState: "delivered", processed: nil)
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
        event: .userMessage(text: "ship", attachments: nil, turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
    ]
    let live = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "ship it fast", attachments: nil, turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
    ]

    let merged = mergeWorkChatTranscripts(base: base, live: live)
    XCTAssertEqual(merged.count, 1)
    guard case .userMessage(let text, _, _, _, _, _) = merged[0].event else {
      return XCTFail("Expected user_message event.")
    }
    XCTAssertEqual(text, "ship it fast")
  }

  func testPruneResolvedQueuedSteerEnvelopesDropsStaleQueuedRow() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "ship it", attachments: nil, turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .userMessage(text: "ship it", attachments: nil, turnId: "turn-1", steerId: "steer-1", deliveryState: "delivered", processed: nil)
      ),
    ]

    let pruned = pruneResolvedQueuedSteerEnvelopes(transcript)
    XCTAssertEqual(pruned.count, 1)
    guard case .userMessage(_, _, _, let steerId, let deliveryState, _) = pruned[0].event else {
      return XCTFail("Expected delivered user_message event.")
    }
    XCTAssertEqual(steerId, "steer-1")
    XCTAssertEqual(deliveryState, "delivered")
    XCTAssertTrue(derivePendingWorkSteers(from: pruned).isEmpty)
  }

  func testPreferredWorkTranscriptPreservesQueuedSteerAfterPlainFallbackBackfill() {
    let fallback = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: nil,
        event: .userMessage(text: "ship it", attachments: nil, turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
      ),
    ]
    let live = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "ship it", attachments: nil, turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
      ),
    ]

    let preferred = preferredWorkTranscript(
      current: [],
      fallback: fallback,
      eventTranscript: live
    )

    XCTAssertEqual(buildWorkChatMessages(from: preferred).map(\.markdown), [])
    XCTAssertEqual(derivePendingWorkSteers(from: preferred).map(\.id), ["steer-1"])
  }

  func testWorkTimelineHidesLocalEchoWhenQueuedSteerCoversSameText() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 1,
        event: .userMessage(text: "Stage me", attachments: nil, turnId: "turn-1", steerId: "steer-1", deliveryState: "queued", processed: nil)
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
        WorkLocalEchoMessage(text: "Stage me", timestamp: "2026-03-25T00:00:01.000Z", deliveryState: "queued"),
      ]
    )
    let userMessages = timeline.compactMap { entry -> String? in
      guard case .message(let message) = entry.payload, message.role == "user" else { return nil }
      return message.markdown
    }

    XCTAssertTrue(userMessages.isEmpty)
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

  func testAssistantMessagePreviewBoundsHugeResponses() {
    let markdown = (1...5000).map { "\($0). Line \($0)" }.joined(separator: "\n")

    let firstPage = workAssistantMessagePreview(
      markdown,
      lineBudget: workAssistantMessageInitialLineBudget,
      characterBudget: workAssistantMessageCharacterBudget(forLineBudget: workAssistantMessageInitialLineBudget)
    )

    XCTAssertTrue(firstPage.isTruncated)
    XCTAssertEqual(firstPage.visibleLineCount, 48)
    XCTAssertEqual(firstPage.totalLineCount, 5000)
    XCTAssertTrue(firstPage.text.contains("48. Line 48"))
    XCTAssertFalse(firstPage.text.contains("49. Line 49"))

    let secondPageBudget = workAssistantMessageInitialLineBudget + workAssistantMessageLineBudgetStep
    let secondPage = workAssistantMessagePreview(
      markdown,
      lineBudget: secondPageBudget,
      characterBudget: workAssistantMessageCharacterBudget(forLineBudget: secondPageBudget)
    )

    XCTAssertEqual(secondPage.visibleLineCount, 96)
    XCTAssertTrue(secondPage.text.contains("96. Line 96"))
    XCTAssertFalse(secondPage.text.contains("97. Line 97"))
  }

  func testAssistantPreviewCacheHydratesBuiltChatMessages() {
    let markdown = (1...5000).map { "\($0). Line \($0)" }.joined(separator: "\n")
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .assistantText(text: markdown, turnId: "turn-1", itemId: "msg-1")
      )
    ]

    let message = buildWorkChatMessages(from: transcript).first
    let preview = message.map { WorkAssistantPreviewCache().preview(for: $0) }

    XCTAssertNil(message?.assistantPreview)
    XCTAssertTrue(preview?.isTruncated == true)
    XCTAssertEqual(preview?.visibleLineCount, workAssistantMessageInitialLineBudget)
    XCTAssertEqual(preview?.totalLineCount, 5000)
  }

  func testAssistantPreviewCacheHydratesAfterStreamingMerge() {
    let firstChunk = (1...2500).map { "\($0). Line \($0)" }.joined(separator: "\n")
    let secondChunk = "\n" + (2501...5000).map { "\($0). Line \($0)" }.joined(separator: "\n")
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .assistantText(text: firstChunk, turnId: "turn-1", itemId: "msg-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .assistantText(text: secondChunk, turnId: "turn-1", itemId: "msg-1")
      )
    ]

    let message = buildWorkChatMessages(from: transcript).first
    let preview = message.map { WorkAssistantPreviewCache().preview(for: $0) }

    XCTAssertEqual(message?.markdown, firstChunk + secondChunk)
    XCTAssertNil(message?.assistantPreview)
    XCTAssertTrue(preview?.isTruncated == true)
    XCTAssertEqual(preview?.visibleLineCount, workAssistantMessageInitialLineBudget)
    XCTAssertEqual(preview?.totalLineCount, 5000)
  }

  func testWorkChatAccessibilityPreviewCapsHugeMessages() {
    let text = String(repeating: "x", count: workChatAccessibilityPreviewLimit + 50)
    let preview = workChatAccessibilityPreview(text)

    XCTAssertEqual(preview.count, workChatAccessibilityPreviewLimit + 3)
    XCTAssertTrue(preview.hasSuffix("..."))
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
    XCTAssertEqual(
      anthropicProvider?.models.filter { $0.id == "opencode/anthropic/claude-sonnet-4-6" }.count,
      1
    )
  }

  func testWorkModelCatalogIncludesFlagshipModelMetadata() {
    let groups = workModelCatalogGroups(currentModelId: "", currentProvider: "codex")
    let claudeGroup = groups.first(where: { $0.key == "claude" })
    let anthropicProvider = claudeGroup?.providers.first(where: { $0.key == "anthropic" })
    let fable = anthropicProvider?.models.first(where: { $0.id == "claude-fable-5" })
    let opus48 = anthropicProvider?.models.first(where: { $0.id == "claude-opus-4-8" })
    let codexGroup = groups.first(where: { $0.key == "codex" })
    let openAIProvider = codexGroup?.providers.first(where: { $0.key == "openai" })
    let gpt55 = openAIProvider?.models.first(where: { $0.id == "gpt-5.5" })

    XCTAssertEqual(anthropicProvider?.models.first?.id, "claude-fable-5")
    XCTAssertEqual(fable?.displayName, "Claude Fable 5")
    XCTAssertEqual(fable?.tier, .flagship)
    XCTAssertEqual(fable?.tagline, "Flagship · 1M context")
    XCTAssertNotNil(ADEColor.modelBrand(for: "claude-fable-5"))
    XCTAssertEqual(opus48?.displayName, "Claude Opus 4.8 1M")
    XCTAssertEqual(opus48?.tier, .flagship)
    XCTAssertEqual(opus48?.tagline, "Flagship · 1M context")
    XCTAssertNotNil(ADEColor.modelBrand(for: "claude-opus-4-8"))
    XCTAssertEqual(gpt55?.displayName, "GPT-5.5")
    XCTAssertEqual(gpt55?.tier, .flagship)
    XCTAssertNotNil(ADEColor.modelBrand(for: "gpt-5.5"))
    XCTAssertEqual(ADEColor.reasoningTiers(for: "gpt-5.5"), ["low", "medium", "high", "xhigh"])
  }

  func testMobileComposerReasoningTiersMirrorDesktopRegistry() {
    XCTAssertEqual(ADEColor.reasoningTiers(for: "anthropic/claude-fable-5"), ["low", "medium", "high", "xhigh", "max", "ultracode"])
    XCTAssertEqual(ADEColor.reasoningTiers(for: "anthropic/claude-fable-5-api"), ["low", "medium", "high", "xhigh", "max", "ultracode"])
    XCTAssertEqual(ADEColor.reasoningTiers(for: "claude-fable-5"), ["low", "medium", "high", "xhigh", "max", "ultracode"])
    XCTAssertEqual(ADEColor.reasoningTiers(for: "fable"), ["low", "medium", "high", "xhigh", "max", "ultracode"])
    XCTAssertEqual(ADEColor.reasoningTiers(for: "anthropic/claude-opus-4-8"), ["low", "medium", "high", "xhigh", "max", "ultracode"])
    XCTAssertEqual(ADEColor.reasoningTiers(for: "claude-opus-4-8"), ["low", "medium", "high", "xhigh", "max", "ultracode"])
    XCTAssertEqual(ADEColor.reasoningTiers(for: "anthropic/claude-opus-4-7"), ["low", "medium", "high", "xhigh", "max"])
    XCTAssertEqual(ADEColor.reasoningTiers(for: "claude-opus-4-7"), ["low", "medium", "high", "xhigh", "max"])
    XCTAssertEqual(ADEColor.reasoningTiers(for: "opus"), ["low", "medium", "high", "xhigh", "max"])
    XCTAssertEqual(ADEColor.reasoningTiers(for: "anthropic/claude-sonnet-4-6"), ["low", "medium", "high", "max"])
    XCTAssertNil(ADEColor.reasoningTiers(for: "claude-haiku-4-5"))
    XCTAssertEqual(ADEColor.reasoningTiers(for: "openai/gpt-5.3-codex-spark"), ["low", "medium", "high", "xhigh"])
    XCTAssertEqual(ADEColor.reasoningTiers(for: "gpt-5.2"), ["low", "medium", "high", "xhigh"])
  }

  func testDynamicWorkModelCatalogBuildsFromLiveHostModels() {
    let groups = workModelCatalogGroups(
      availableModelsByProvider: [
        "codex": [
          AgentChatModelInfo(
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            description: "Latest Codex model",
            isDefault: true,
            reasoningEfforts: nil,
            serviceTiers: nil,
            maxThinkingTokens: nil,
            modelId: "openai/gpt-5.5",
            family: "openai",
            supportsReasoning: true,
            supportsTools: true,
            color: nil
          ),
          AgentChatModelInfo(
            id: "gpt-5.4",
            displayName: "GPT-5.4",
            description: nil,
            isDefault: false,
            reasoningEfforts: nil,
            serviceTiers: nil,
            maxThinkingTokens: nil,
            modelId: "openai/gpt-5.4",
            family: "openai",
            supportsReasoning: true,
            supportsTools: true,
            color: nil
          ),
        ],
        "cursor": [
          AgentChatModelInfo(
            id: "claude-4.6-sonnet",
            displayName: "Sonnet 4.6",
            description: nil,
            isDefault: false,
            reasoningEfforts: nil,
            serviceTiers: nil,
            maxThinkingTokens: nil,
            modelId: nil,
            family: "anthropic",
            supportsReasoning: true,
            supportsTools: true,
            color: nil
          ),
          AgentChatModelInfo(
            id: "auto",
            displayName: "Auto",
            description: nil,
            isDefault: true,
            reasoningEfforts: nil,
            serviceTiers: nil,
            maxThinkingTokens: nil,
            modelId: nil,
            family: "cursor",
            supportsReasoning: false,
            supportsTools: true,
            color: nil
          ),
        ],
      ],
      currentModelId: "",
      currentProvider: "codex"
    )

    let codexGroup = groups.first(where: { $0.key == "codex" })
    let codexOpenAI = codexGroup?.providers.first(where: { $0.key == "openai" })
    XCTAssertEqual(codexOpenAI?.models.map(\.id), ["gpt-5.5", "gpt-5.4"])
    XCTAssertEqual(codexOpenAI?.models.first?.tagline, "Flagship · 1M context")
    XCTAssertEqual(codexOpenAI?.models.first?.displayName, "GPT-5.5")

    let cursorGroup = groups.first(where: { $0.key == "cursor" })
    XCTAssertEqual(cursorGroup?.providers.map(\.key), ["anthropic", "cursor"])
    XCTAssertEqual(cursorGroup?.providers.first?.models.first?.provider, "claude")
  }

  func testWorkModelCatalogFiltersCursorModelsByChatAndCliAvailability() {
    let groups = [
      WorkModelCatalogGroup(
        key: "cursor",
        displayName: "Cursor",
        providers: [
          WorkModelProvider(
            key: "cursor",
            displayName: "Cursor",
            models: [
              WorkModelOption(
                id: "composer-cli",
                displayName: "Composer CLI",
                tier: .balanced,
                tagline: "CLI only",
                provider: "cursor",
                cursorAvailability: CursorModelAvailability(cli: true, sdk: false)
              ),
              WorkModelOption(
                id: "composer-sdk",
                displayName: "Composer SDK",
                tier: .balanced,
                tagline: "SDK only",
                provider: "cursor",
                cursorAvailability: CursorModelAvailability(cli: false, sdk: true)
              ),
              WorkModelOption(
                id: "composer-both",
                displayName: "Composer Both",
                tier: .balanced,
                tagline: "Both",
                provider: "cursor",
                cursorAvailability: CursorModelAvailability(cli: true, sdk: true)
              ),
              WorkModelOption(
                id: "legacy-cursor",
                displayName: "Legacy Cursor",
                tier: .balanced,
                tagline: "No availability metadata",
                provider: "cursor"
              ),
            ]
          ),
        ]
      ),
      WorkModelCatalogGroup(
        key: "claude",
        displayName: "Claude",
        providers: [
          WorkModelProvider(
            key: "anthropic",
            displayName: "Anthropic",
            models: [
              WorkModelOption(
                id: "claude-sonnet-4-6",
                displayName: "Claude Sonnet 4.6",
                tier: .balanced,
                tagline: "Claude",
                provider: "claude"
              ),
            ]
          ),
        ]
      ),
    ]

    let chatCursorModels = workFilterCatalogForCursorAvailability(groups, mode: .chat)
      .first(where: { $0.key == "cursor" })?
      .providers
      .first?
      .models
      .map(\.id)
    let cliCursorModels = workFilterCatalogForCursorAvailability(groups, mode: .cli)
      .first(where: { $0.key == "cursor" })?
      .providers
      .first?
      .models
      .map(\.id)

    XCTAssertEqual(chatCursorModels, ["composer-sdk", "composer-both", "legacy-cursor"])
    XCTAssertEqual(cliCursorModels, ["composer-cli", "composer-both", "legacy-cursor"])
    XCTAssertEqual(
      workFilterCatalogForCursorAvailability(groups, mode: .cli)
        .first(where: { $0.key == "claude" })?
        .providers
        .first?
        .models
        .map(\.id),
      ["claude-sonnet-4-6"]
    )
  }

  func testWorkResolveCliProviderMapsModelFamiliesLikeDesktop() {
    XCTAssertEqual(workResolveCliProvider(for: "claude-sonnet-4-6", provider: "claude"), "claude")
    XCTAssertEqual(workResolveCliProvider(for: "gpt-5.5", provider: "codex"), "codex")
    XCTAssertEqual(workResolveCliProvider(for: "auto", provider: "cursor"), "cursor")
    XCTAssertEqual(workResolveCliProvider(for: "opencode/anthropic/claude-sonnet-4-6", provider: "opencode"), "opencode")
  }

  func testWorkModelCatalogTreatsCodexRuntimeAndRegistryIdsAsSameModel() {
    let groups = workModelCatalogGroups(
      availableModelsByProvider: [
        "codex": [
          AgentChatModelInfo(
            id: "gpt-5.5",
            displayName: "GPT-5.5",
            description: nil,
            isDefault: true,
            reasoningEfforts: nil,
            serviceTiers: nil,
            maxThinkingTokens: nil,
            modelId: "openai/gpt-5.5",
            family: "openai",
            supportsReasoning: true,
            supportsTools: true,
            color: nil
          ),
        ],
      ],
      currentModelId: "openai/gpt-5.5",
      currentProvider: "codex"
    )

    let codexOpenAI = groups
      .first(where: { $0.key == "codex" })?
      .providers
      .first(where: { $0.key == "openai" })

    XCTAssertEqual(codexOpenAI?.models.map(\.id), ["gpt-5.5"])
    XCTAssertTrue(workModelIdsEquivalent("gpt-5.5", "openai/gpt-5.5"))
    XCTAssertTrue(workModelIdsEquivalent("openai/gpt-5.5", "gpt-5.5"))
    XCTAssertEqual(workKnownModelDisplayName("openai/gpt-5.5"), "GPT-5.5")
    XCTAssertEqual(prettyWorkChatModelName("openai/gpt-5.5"), "GPT-5.5")
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

  func testWorkFilteredSessionsMatchesLiveTerminalOutputTail() {
    let terminalSession = makeTerminalSessionSummary(
      id: "terminal-live",
      laneId: "lane-1",
      laneName: "release",
      toolType: "codex-chat",
      runtimeState: "idle",
      title: "Phone terminal"
    )
    let outputSearch = workSessionOutputSearchIndexBySessionId(buffers: [
      "terminal-live": "\u{001B}[2m• \u{001B}[0mMOBILE_OK\r\n\u{001B}[1m›\u{001B}[0m",
    ])

    let filtered = workFilteredSessions(
      [terminalSession],
      chatSummaries: [:],
      archivedSessionIds: [],
      selectedStatus: .running,
      selectedLaneId: "all",
      searchText: "mobile_ok",
      outputSearchBySessionId: outputSearch
    )

    XCTAssertEqual(filtered.map(\.id), ["terminal-live"])
  }

  func testCtoLiveReloadThrottleSkipsBurstySyncRevisions() {
    let baseline = Date(timeIntervalSince1970: 1_800_000_000)

    XCTAssertTrue(shouldRunCtoLiveReload(lastReloadAt: nil, now: baseline))
    XCTAssertFalse(shouldRunCtoLiveReload(lastReloadAt: baseline, now: baseline.addingTimeInterval(0.5)))
    XCTAssertTrue(shouldRunCtoLiveReload(lastReloadAt: baseline, now: baseline.addingTimeInterval(2.0)))
  }

  func testStoppableRuntimeSessionIncludesLiveAndIdleTerminalRows() {
    XCTAssertTrue(isStoppableRuntimeSession(makeTerminalSessionSummary(toolType: "shell", runtimeState: "running", status: "running")))
    XCTAssertTrue(isStoppableRuntimeSession(makeTerminalSessionSummary(toolType: "shell", runtimeState: "idle", status: "running")))
    XCTAssertTrue(isStoppableRuntimeSession(makeTerminalSessionSummary(toolType: "shell", runtimeState: "waiting-input", status: "running")))
    XCTAssertFalse(isStoppableRuntimeSession(makeTerminalSessionSummary(toolType: "shell", runtimeState: "stopped", status: "exited")))
    XCTAssertFalse(isStoppableRuntimeSession(makeTerminalSessionSummary(toolType: "codex-chat", runtimeState: "running", status: "running")))
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
        event: .userMessage(text: prompt, attachments: nil, turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
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

  func testWorkTimelineCarriesQueuedLocalEchoDeliveryState() {
    let timeline = buildWorkTimeline(
      transcript: [],
      fallbackEntries: [],
      toolCards: [],
      commandCards: [],
      fileChangeCards: [],
      eventCards: [],
      artifacts: [],
      localEchoMessages: [
        WorkLocalEchoMessage(
          text: "Send once the desktop is back",
          timestamp: "2026-03-25T00:00:03.000Z",
          deliveryState: "queued"
        ),
      ]
    )
    let message = timeline.compactMap { entry -> WorkChatMessage? in
      guard case .message(let message) = entry.payload else { return nil }
      return message
    }.first

    XCTAssertEqual(message?.markdown, "Send once the desktop is back")
    XCTAssertEqual(message?.deliveryState, "queued")
  }

  func testWorkTurnSeparatorsUsePerTurnModelAfterModelSwitch() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .userMessage(text: "say hi", attachments: nil, turnId: "turn-1", steerId: nil, deliveryState: nil, processed: nil)
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
        event: .userMessage(text: "say hi again", attachments: nil, turnId: "turn-2", steerId: nil, deliveryState: nil, processed: nil)
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
        event: .done(status: "completed", summary: "Completed\ngpt-5.4-mini", usage: nil, turnId: "turn-2", model: "gpt-5.4-mini", modelId: "openai/gpt-5.4-mini")
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
    XCTAssertEqual(assistantMessages.map(\.turnModelId), ["anthropic/claude-sonnet-4-6", "openai/gpt-5.4-mini"])

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

    let endMarkers = separated.compactMap { entry -> WorkTurnEndMarker? in
      guard case .turnEndMarker(let marker) = entry.payload else { return nil }
      return marker
    }
    XCTAssertEqual(endMarkers.map(\.turnId), ["turn-1", "turn-2"])
    XCTAssertEqual(endMarkers.map(\.workedDurationLabel), ["2s", "2s"])

    let turnOrder = separated.compactMap { entry -> String? in
      switch entry.payload {
      case .message(let message): return "\(message.role):\(message.turnId ?? "")"
      case .turnEndMarker(let marker): return "ended:\(marker.turnId)"
      default: return nil
      }
    }
    XCTAssertEqual(turnOrder, [
      "user:turn-1",
      "assistant:turn-1",
      "ended:turn-1",
      "user:turn-2",
      "assistant:turn-2",
      "ended:turn-2",
    ])
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

  func testWorkTimelineSnapshotCachesTranscriptActiveTurnState() {
    let started = WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-03-25T00:00:00.000Z",
      sequence: 0,
      event: .status(turnStatus: "started", message: nil, turnId: "turn-1")
    )
    let completed = WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-03-25T00:00:01.000Z",
      sequence: 1,
      event: .status(turnStatus: "completed", message: nil, turnId: "turn-1")
    )
    let nextUserTurn = WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: "2026-03-25T00:00:02.000Z",
      sequence: 2,
      event: .userMessage(text: "next", attachments: nil, turnId: "turn-2", steerId: nil, deliveryState: nil, processed: nil)
    )

    let activeSnapshot = buildWorkChatTimelineSnapshot(
      transcript: [started],
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    let completedSnapshot = buildWorkChatTimelineSnapshot(
      transcript: [started, completed],
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )

    XCTAssertTrue(activeSnapshot.transcriptIndicatesActiveTurn)
    XCTAssertFalse(completedSnapshot.transcriptIndicatesActiveTurn)
    XCTAssertFalse(workTranscriptLatestTurnEnded([started]))
    XCTAssertTrue(workTranscriptLatestTurnEnded([started, completed]))
    XCTAssertFalse(workTranscriptLatestTurnEnded([started, completed, nextUserTurn]))
  }

  func testWorkChatStreamingRequiresLiveConnectionForTranscriptActiveTurn() {
    XCTAssertFalse(
      workChatIsStreaming(
        sessionStatus: "idle",
        isLive: false,
        transcriptIndicatesActiveTurn: true
      )
    )
    XCTAssertTrue(
      workChatIsStreaming(
        sessionStatus: "idle",
        isLive: true,
        transcriptIndicatesActiveTurn: true
      )
    )
    XCTAssertTrue(
      workChatIsStreaming(
        sessionStatus: "active",
        isLive: true,
        transcriptIndicatesActiveTurn: false
      )
    )
    XCTAssertTrue(
      workChatIsStreaming(
        sessionStatus: "idle",
        isLive: true,
        transcriptIndicatesActiveTurn: false,
        liveTurnActiveHint: true,
        transcriptLatestTurnEnded: false
      )
    )
    XCTAssertFalse(
      workChatIsStreaming(
        sessionStatus: "active",
        isLive: true,
        transcriptIndicatesActiveTurn: false,
        liveTurnActiveHint: false,
        transcriptLatestTurnEnded: true
      )
    )
    XCTAssertTrue(
      workChatIsStreaming(
        sessionStatus: "idle",
        isLive: true,
        transcriptIndicatesActiveTurn: false,
        liveTurnActiveHint: true,
        transcriptLatestTurnEnded: true
      )
    )
    XCTAssertFalse(
      workChatIsStreaming(
        sessionStatus: "idle",
        isLive: true,
        transcriptIndicatesActiveTurn: false,
        liveTurnActiveHint: true,
        transcriptLatestTurnEnded: false,
        rowEndedAfterLatestTranscript: true
      )
    )
  }

  func testWorkActivityIndicatorDoesNotReuseCommandAfterDone() {
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
        event: .command(
          command: "/bin/zsh -lc 'npm test'",
          cwd: "",
          output: "",
          status: .running,
          itemId: "cmd-1",
          exitCode: nil,
          durationMs: nil,
          turnId: "turn-1"
        )
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .done(status: "completed", summary: "", usage: nil, turnId: "turn-1", model: nil, modelId: nil)
      ),
    ]

    XCTAssertNil(WorkActivityIndicator.derivePresentation(from: transcript))
  }

  func testWorkInterruptControlHidesAfterCompletedTranscriptTail() {
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
        event: .assistantText(text: "Done.", turnId: "turn-1", itemId: "msg-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:02.000Z",
        sequence: 2,
        event: .done(status: "completed", summary: "", usage: nil, turnId: "turn-1", model: nil, modelId: nil)
      ),
    ]

    XCTAssertFalse(workChatShouldShowInterruptControl(isStreamingTurn: true, transcript: transcript))
  }

  func testWorkInterruptControlShowsForFreshAssistantTextAfterDone() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:00.000Z",
        sequence: 0,
        event: .done(status: "completed", summary: "", usage: nil, turnId: "turn-1", model: nil, modelId: nil)
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-03-25T00:00:01.000Z",
        sequence: 1,
        event: .assistantText(text: "New streamed text", turnId: "turn-2", itemId: "msg-2")
      ),
    ]

    XCTAssertTrue(workChatShouldShowInterruptControl(isStreamingTurn: true, transcript: transcript))
  }

  /// Regression: the chat_subscribe ack now carries live turn state so a
  /// phone that subscribes mid-turn (desktop-started chat, byte-capped
  /// snapshot tail without the `status: started` event) still renders the
  /// stop button and working indicator. Older hosts omit the field — it
  /// must decode as nil, not fail or default to a fabricated state.
  func testChatSubscribeSnapshotPayloadDecodesLiveTurnState() throws {
    let modernJSON = """
    {
      "sessionId": "chat-1",
      "capturedAt": "2026-06-12T00:00:00.000Z",
      "truncated": true,
      "events": [],
      "turnActive": true
    }
    """
    let modern = try JSONDecoder().decode(SyncChatSubscribeSnapshotPayload.self, from: Data(modernJSON.utf8))
    XCTAssertEqual(modern.turnActive, true)

    let legacyJSON = """
    {
      "sessionId": "chat-1",
      "capturedAt": "2026-06-12T00:00:00.000Z",
      "truncated": false,
      "events": []
    }
    """
    let legacy = try JSONDecoder().decode(SyncChatSubscribeSnapshotPayload.self, from: Data(legacyJSON.utf8))
    XCTAssertNil(legacy.turnActive)
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

  func testWorkArtifactVideoTempCleanupRemovesLocalPreviewFile() throws {
    let url = FileManager.default.temporaryDirectory
      .appendingPathComponent("ade-work-artifact-\(UUID().uuidString)")
      .appendingPathExtension("mp4")
    try Data([0x00, 0x00, 0x00, 0x18]).write(to: url)

    workRemoveLoadedArtifactTempFile(.video(url))

    XCTAssertFalse(FileManager.default.fileExists(atPath: url.path))
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

  func testFilesDiffHasChangesDetectsTextAndExistenceEdits() {
    let empty = DiffSide(exists: false, text: "")
    let same = FileDiff(
      path: "App.swift",
      mode: "modified",
      original: DiffSide(exists: true, text: "let a = 1\n"),
      modified: DiffSide(exists: true, text: "let a = 1\n"),
      isBinary: false,
      language: "swift"
    )
    XCTAssertFalse(filesDiffHasChanges(same))

    let textChanged = FileDiff(
      path: "App.swift",
      mode: "modified",
      original: DiffSide(exists: true, text: "let a = 1\n"),
      modified: DiffSide(exists: true, text: "let a = 2\n"),
      isBinary: false,
      language: "swift"
    )
    XCTAssertTrue(filesDiffHasChanges(textChanged))

    let created = FileDiff(
      path: "New.swift",
      mode: "added",
      original: empty,
      modified: DiffSide(exists: true, text: "// new\n"),
      isBinary: false,
      language: "swift"
    )
    XCTAssertTrue(filesDiffHasChanges(created))

    let deleted = FileDiff(
      path: "Gone.swift",
      mode: "deleted",
      original: DiffSide(exists: true, text: "let gone = true\n"),
      modified: empty,
      isBinary: false,
      language: "swift"
    )
    XCTAssertTrue(filesDiffHasChanges(deleted))
  }

  func testFilesDiffTreatsTruncatedSidesAsUnsafeToMarkClean() {
    let truncated = FileDiff(
      path: "large.txt",
      mode: "modified",
      original: DiffSide(exists: true, text: "same visible prefix", size: 196_690, isTruncated: true),
      modified: DiffSide(exists: true, text: "same visible prefix", size: 762_000, isTruncated: true),
      isBinary: false,
      language: "text"
    )

    XCTAssertTrue(filesDiffHasChanges(truncated))
    XCTAssertEqual(
      filesDiffPreviewLimit(diff: truncated),
      FilesPreviewLimit(
        title: "Diff preview paused",
        message: "This diff is too large to compare fully on iPhone. Open the file from ADE on your machine or inspect a smaller diff before rendering it on iPhone."
      )
    )
  }

  func testFilesStripYamlFrontmatterRemovesLeadingBlock() {
    let input = """
    ---
    name: ade-autoresearch
    description: perf skill
    ---
    # Heading

    Body text
    """
    XCTAssertEqual(filesStripYamlFrontmatter(input), "# Heading\n\nBody text")
    XCTAssertEqual(filesStripYamlFrontmatter("# No frontmatter"), "# No frontmatter")
  }

  func testFilesIsImagePreviewableUsesPathAndPreviewKind() {
    let blob = SyncFileBlob(
      path: "proof/screenshot.png",
      size: 1200,
      encoding: "base64",
      isBinary: true,
      content: "",
      previewKind: "image"
    )
    XCTAssertTrue(filesIsImagePreviewable(path: "proof/screenshot.png", blob: blob))
    XCTAssertFalse(filesIsImagePreviewable(path: "README.md", blob: SyncFileBlob(path: "README.md", size: 10, encoding: "utf8", isBinary: false, content: "# hi")))
  }

  func testFilesImageDataPrefersDataUrl() {
    let tinyPngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
    let blob = SyncFileBlob(
      path: "a.png",
      size: 68,
      encoding: "base64",
      isBinary: true,
      content: "",
      dataUrl: "data:image/png;base64,\(tinyPngBase64)"
    )
    XCTAssertNotNil(filesImageData(from: blob))
  }

  func testWorkDisplayLeavesCleanRepeatedLettersAloneEvenWithManyDoubles() {
    // Real text with many legitimate double letters must NOT get collapsed.
    let natural = "Committee will assess the bookkeeping across all accounts, noting success, progress, commitment."
    XCTAssertEqual(sanitizeTerminalOutputForDisplay(natural), natural)
    XCTAssertEqual(workSessionPreviewText(natural), natural)
  }

  func testWorkSessionPreviewTextTrimsAndReturnsNilForEmptyInput() {
    XCTAssertNil(workSessionPreviewText(nil))
    XCTAssertNil(workSessionPreviewText("   \n\t  "))
    XCTAssertEqual(workSessionPreviewText("  hello world  "), "hello world")
  }

  func testWorkDisplayCollapsesDuplicatedStreamingCharacters() {
    XCTAssertEqual(
      workSessionPreviewText("WWoorrkkiinngg oonn ppaassss tthhrroouugghh"),
      "Working on pass through"
    )
    XCTAssertEqual(
      sanitizeTerminalOutputForDisplay("WWoorrkkiinngg\n\u{001B}[31mDDoonnee\u{001B}[0m"),
      "Working\nDone"
    )
    XCTAssertEqual(
      sanitizeTerminalOutputForDisplay("Everything is green. WWoorrkkiinngg 200 WWoorrkkiinngg."),
      "Everything is green. Working 200 Working."
    )
    XCTAssertEqual(
      sanitizeTerminalOutputForDisplay("Success: queued job still running with a class FooController"),
      "Success: queued job still running with a class FooController"
    )
    XCTAssertEqual(
      sanitizeTerminalOutputForDisplay("TThhee bbuuiilldd ppaasssseedd,, rruunnnniinngg ffiinnaall cchheecckkss"),
      "The build passed, running final checks"
    )
    XCTAssertEqual(workSessionPreviewText("Still visible"), "Still visible")
  }

  func testWorkDisplayPreservesEllipsisWhenCollapsingStreamingDuplicates() {
    XCTAssertEqual(
      sanitizeTerminalOutputForDisplay("WWoorrkkiinngg..."),
      "Working..."
    )
    XCTAssertEqual(
      workSessionPreviewText("WWoorrkkiinngg..."),
      "Working..."
    )
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
        lane_id, dirty, ahead, behind, remote_behind, rebase_in_progress, agent_summary_json, updated_at
      ) values (
        'lane-primary', 0, 0, 0, 0, 0, null, '2026-03-17T00:00:00.000Z'
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

  private func kvValue(in baseURL: URL, key: String) throws -> String? {
    let dbURL = baseURL.appendingPathComponent("ADE", isDirectory: true).appendingPathComponent("ade.db")
    var handle: OpaquePointer?
    XCTAssertEqual(sqlite3_open(dbURL.path, &handle), SQLITE_OK)
    defer { sqlite3_close(handle) }

    var statement: OpaquePointer?
    XCTAssertEqual(sqlite3_prepare_v2(handle, "select value from kv where key = ? limit 1", -1, &statement, nil), SQLITE_OK)
    defer { sqlite3_finalize(statement) }
    sqlite3_bind_text(statement, 1, (key as NSString).utf8String, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self))
    guard sqlite3_step(statement) == SQLITE_ROW else { return nil }
    guard let raw = sqlite3_column_text(statement, 0) else { return nil }
    return String(cString: raw)
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
    archivedAt: String? = nil,
    lastActivityAt: String = recentIso8601Fixture(),
    pendingInputItemId: String? = nil,
    permissionMode: String? = nil,
    opencodePermissionMode: String? = nil
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
      codexFastMode: nil,
      fastMode: nil,
      executionMode: nil,
      permissionMode: permissionMode,
      interactionMode: nil,
      claudePermissionMode: nil,
      codexApprovalPolicy: nil,
      codexSandbox: nil,
      codexConfigSource: nil,
      opencodePermissionMode: opencodePermissionMode,
      droidPermissionMode: nil,
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
      archivedAt: archivedAt,
      lastActivityAt: lastActivityAt,
      lastOutputPreview: nil,
      summary: nil,
      awaitingInput: awaitingInput,
      pendingInputItemId: pendingInputItemId,
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
    lastOutputPreview: String? = nil,
    startedAt: String = recentIso8601Fixture(),
    resumeCommand: String? = nil,
    resumeMetadata: TerminalResumeMetadata? = nil,
    archivedAt: String? = nil
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
      startedAt: startedAt,
      endedAt: nil,
      archivedAt: archivedAt,
      exitCode: nil,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: lastOutputPreview,
      summary: nil,
      runtimeState: runtimeState,
      resumeCommand: resumeCommand,
      resumeMetadata: resumeMetadata,
      chatIdleSinceAt: nil
    )
  }

  private func makeLaneSummary(
    id: String,
    name: String,
    laneType: String,
    branchRef: String
  ) -> LaneSummary {
    LaneSummary(
      id: id,
      name: name,
      description: nil,
      laneType: laneType,
      baseRef: "main",
      branchRef: branchRef,
      worktreePath: "/tmp/\(id)",
      attachedRootPath: nil,
      parentLaneId: nil,
      childCount: 0,
      stackDepth: 0,
      parentStatus: nil,
      isEditProtected: false,
      status: LaneStatus(
        dirty: false,
        ahead: 0,
        behind: 0,
        remoteBehind: 0,
        rebaseInProgress: false
      ),
      color: nil,
      icon: nil,
      tags: [],
      folder: nil,
      createdAt: "2026-03-25T00:00:00.000Z",
      archivedAt: nil
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

  func testMakeWorkChatEventPreservesUserMessageAttachments() {
    let attachments = [AgentChatFileRef(path: ".ade/attachments/screenshot.png", type: "image")]
    let mapped = makeWorkChatEvent(
      from: .userMessage(
        text: "see attached",
        attachments: attachments,
        turnId: "turn-1",
        steerId: nil,
        deliveryState: "delivered",
        processed: true
      )
    )
    guard case .userMessage(_, let preserved, _, _, _, _) = mapped else {
      return XCTFail("Expected mapped user message event")
    }
    XCTAssertEqual(preserved, attachments)
  }

  func testBuildWorkChatMessagesIncludesAttachmentMetadata() {
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-06-12T00:00:00.000Z",
        sequence: 1,
        event: .userMessage(
          text: "screenshots attached",
          attachments: [AgentChatFileRef(path: ".ade/attachments/a.png", type: "image")],
          turnId: "turn-1",
          steerId: nil,
          deliveryState: "delivered",
          processed: true
        )
      ),
    ]
    let messages = buildWorkChatMessages(from: transcript)
    XCTAssertEqual(messages.count, 1)
    XCTAssertEqual(messages.first?.attachments?.count, 1)
    XCTAssertEqual(messages.first?.attachments?.first?.path, ".ade/attachments/a.png")
  }

  func testWorkToolArgPreviewExtractsPathInsteadOfRawJSONBrace() {
    XCTAssertEqual(
      workToolArgPreview(
        toolName: "Read",
        argsText: """
        {
          "path": "apps/ios/ADE/Views/Work/WorkReasoningCard.swift"
        }
        """
      ),
      "apps/ios/ADE/Views/Work/WorkReasoningCard.swift"
    )
    XCTAssertEqual(
      workToolArgPreview(toolName: "Bash", argsText: #"{"command":"ade help ios-sim"}"#),
      "ade help ios-sim"
    )
    XCTAssertNil(workToolArgPreview(toolName: "Read", argsText: "{}"))
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

  func testWorkContextCompactLifecycleMergesStartedAndCompletedCard() {
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-06-15T00:00:01.000Z",
        sequence: 1,
        event: .contextCompact(summary: "Manual", isInProgress: true, turnId: "turn-compact")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-06-15T00:00:02.000Z",
        sequence: 2,
        event: .contextCompact(summary: "Manual\nPre-compact tokens: 12000", isInProgress: false, turnId: "turn-compact")
      ),
    ]

    let cards = buildWorkEventCards(from: transcript).filter { $0.kind == "contextCompact" }

    XCTAssertEqual(cards.count, 1)
    XCTAssertEqual(cards.first?.id, "context-compact:chat-1:turn:turn-compact")
    XCTAssertEqual(cards.first?.title, "Context compacted")
    XCTAssertEqual(cards.first?.body, "Manual\nPre-compact tokens: 12000")
    XCTAssertEqual(cards.first?.isInProgress, false)
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
    XCTAssertEqual(toolEntries.first?.id, "tool-group:tool-call-dup")
    guard case .toolGroup(let group)? = toolEntries.first?.payload else {
      return XCTFail("Expected duplicate tool calls to collapse into one tool group.")
    }
    XCTAssertEqual(group.members.count, 1)
    guard case .tool(let groupedCard)? = group.members.first else {
      return XCTFail("Expected the collapsed group to retain the deduped tool card.")
    }
    XCTAssertEqual(groupedCard.id, "call-dup")
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

  /// Regression test: file_change events with a shared `logicalItemId` but
  /// distinct raw `itemId` (OpenCode's patch emitter) must stay separate —
  /// one card per file, not collapsed to a single entry.
  func testBuildWorkFileChangeCardsKeepsDistinctFilesUnderSharedLogicalItemId() {
    let firstFile = makeWorkChatEvent(from: .fileChange(
      path: "Sources/First.swift",
      diff: "diff-1",
      kind: .modify,
      itemId: "patch-1:Sources/First.swift",
      logicalItemId: "patch-1",
      turnId: "turn-1",
      status: "completed"
    ))
    let secondFile = makeWorkChatEvent(from: .fileChange(
      path: "Sources/Second.swift",
      diff: "diff-2",
      kind: .modify,
      itemId: "patch-1:Sources/Second.swift",
      logicalItemId: "patch-1",
      turnId: "turn-1",
      status: "completed"
    ))

    let transcript = [
      WorkChatEnvelope(sessionId: "chat-1", timestamp: "2026-04-22T00:00:01.000Z", sequence: 1, event: firstFile),
      WorkChatEnvelope(sessionId: "chat-1", timestamp: "2026-04-22T00:00:02.000Z", sequence: 2, event: secondFile),
    ]
    let cards = buildWorkFileChangeCards(from: transcript)

    XCTAssertEqual(cards.count, 2)
    XCTAssertEqual(Set(cards.map(\.path)), ["Sources/First.swift", "Sources/Second.swift"])
    XCTAssertEqual(Set(cards.map(\.id)), [
      "patch-1:Sources/First.swift",
      "patch-1:Sources/Second.swift",
    ])
  }

  /// Same regression, but driven through the transcript parser path so the
  /// JSON-in / cards-out pipeline also preserves per-file identity.
  func testParseWorkChatTranscriptKeepsDistinctFileChangesUnderSharedLogicalItemId() {
    let raw = """
    {"sessionId":"chat-1","timestamp":"2026-04-22T00:00:01.000Z","sequence":1,"event":{"type":"file_change","path":"Sources/First.swift","diff":"diff-1","kind":"modify","itemId":"patch-1:Sources/First.swift","logicalItemId":"patch-1","turnId":"turn-1","status":"completed"}}
    {"sessionId":"chat-1","timestamp":"2026-04-22T00:00:02.000Z","sequence":2,"event":{"type":"file_change","path":"Sources/Second.swift","diff":"diff-2","kind":"modify","itemId":"patch-1:Sources/Second.swift","logicalItemId":"patch-1","turnId":"turn-1","status":"completed"}}
    """
    let transcript = parseWorkChatTranscript(raw)
    let cards = buildWorkFileChangeCards(from: transcript)

    XCTAssertEqual(cards.count, 2)
    XCTAssertEqual(Set(cards.map(\.path)), ["Sources/First.swift", "Sources/Second.swift"])
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

  func testBuildWorkTimelineWrapsSingleCommandInToolGroup() {
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .command(
          command: "/bin/zsh -lc 'rg WorkDiffOutputBlock'",
          cwd: "/tmp/project",
          output: "apps/ios/ADE/Views/Work/WorkChatRichCardViews.swift:823:struct WorkDiffOutputBlock",
          status: .completed,
          itemId: "cmd-1",
          exitCode: 0,
          durationMs: 42,
          turnId: "turn-1"
        )
      ),
    ]

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )

    XCTAssertEqual(snapshot.timeline.count, 1)
    guard case .toolGroup(let group) = snapshot.timeline.first?.payload else {
      return XCTFail("Expected a single command to render through the compact tool group panel.")
    }
    XCTAssertEqual(group.members.count, 1)
    XCTAssertFalse(snapshot.timeline.contains { entry in
      if case .commandCard = entry.payload { return true }
      return false
    })
  }

  func testBuildWorkTimelineWrapsSingleFileChangeInChangedFilesGroup() {
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .fileChange(
          path: "apps/ios/ADE/Views/Work/WorkChatRichCardViews.swift",
          diff: "@@ -1 +1 @@\n-old\n+new",
          kind: "modify",
          status: .completed,
          itemId: "file-1",
          turnId: "turn-1"
        )
      ),
    ]

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )

    XCTAssertEqual(snapshot.timeline.count, 1)
    guard case .changedFiles(let group) = snapshot.timeline.first?.payload else {
      return XCTFail("Expected a single file change to render through the compact files changed panel.")
    }
    XCTAssertEqual(group.files.count, 1)
    XCTAssertEqual(group.files.first?.additions, 1)
    XCTAssertEqual(group.files.first?.deletions, 1)
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
              {"label":"Lanes","value":"lanes","description":"Testing lane creation, branch management, or task flow"},
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

  func testBuildWorkTimelineKeepsResolvedStructuredQuestionReadable() {
    let detail = """
    {
      "request": {
        "itemId": "ap-1",
        "kind": "structured_question",
        "title": "Mobile question fixture",
        "body": "Pick a mobile verification path.",
        "questions": [
          {
            "id": "flow",
            "header": "Flow",
            "question": "Which Work prompt flow should continue?",
            "options": [
              {"label":"Question flow","value":"question_flow"},
              {"label":"Approval flow","value":"approval_flow"}
            ]
          },
          {
            "id": "notes",
            "header": "Notes",
            "question": "Add an optional note for the mobile audit."
          }
        ]
      }
    }
    """
    let transcript: [WorkChatEnvelope] = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:01.000Z",
        sequence: 1,
        event: .approvalRequest(description: "Mobile question fixture", detail: detail, itemId: "ap-1", turnId: "t-1")
      ),
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 2,
        event: .pendingInputResolved(itemId: "ap-1", resolution: "accepted", turnId: "t-1")
      ),
    ]

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    let questionCard = snapshot.eventCards.first { $0.kind == "question" }
    XCTAssertEqual(questionCard?.title, "Question asked")
    XCTAssertEqual(questionCard?.body, "Mobile question fixture\nPick a mobile verification path.")
    XCTAssertEqual(questionCard?.bullets.first, "Flow: Which Work prompt flow should continue? Options: Question flow, Approval flow")
    XCTAssertEqual(questionCard?.bullets.last, "Notes: Add an optional note for the mobile audit. Freeform response allowed.")
    XCTAssertFalse(snapshot.eventCards.contains { $0.kind == "approval" })
    XCTAssertFalse(snapshot.eventCards.flatMap { [$0.body ?? ""] + $0.bullets }.contains { $0.contains("{") || $0.contains("\"request\"") })
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

  func testBuildWorkTimelineKeepsResolvedPermissionReadable() {
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
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: "2026-04-20T00:00:02.000Z",
        sequence: 2,
        event: .pendingInputResolved(itemId: "perm-1", resolution: "declined", turnId: "t-1")
      ),
    ]

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: []
    )
    let permissionCard = snapshot.eventCards.first { $0.kind == "permission" }
    XCTAssertEqual(permissionCard?.title, "Permission requested")
    XCTAssertEqual(permissionCard?.body, "Allow\nAllow GitHub MCP")
    XCTAssertEqual(permissionCard?.metadata, ["functions.GitHub"])
    XCTAssertFalse(snapshot.eventCards.flatMap { [$0.body ?? ""] + $0.bullets }.contains { $0.contains("{") || $0.contains("\"request\"") })
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

  // MARK: - LinearConnectionStatus contract parity

  func testLinearConnectionStatusDecodesNewOrganizationFields() throws {
    let json = """
    {
      "connected": true,
      "viewerId": "vw_1",
      "viewerName": "Ada",
      "organizationId": "org_1",
      "organizationName": "Acme",
      "organizationUrlKey": "acme",
      "organizationLogoUrl": "https://example.invalid/logo.png",
      "projectCount": 3,
      "checkedAt": "2026-05-10T00:00:00Z",
      "authMode": "oauth"
    }
    """.data(using: .utf8)!

    let status = try JSONDecoder().decode(LinearConnectionStatus.self, from: json)

    XCTAssertTrue(status.connected)
    XCTAssertEqual(status.viewerName, "Ada")
    XCTAssertEqual(status.organizationId, "org_1")
    XCTAssertEqual(status.organizationName, "Acme")
    XCTAssertEqual(status.organizationUrlKey, "acme")
    XCTAssertEqual(status.organizationLogoUrl, "https://example.invalid/logo.png")
  }

  /// Older hosts won't return the organization fields. The mirror must still
  /// decode without throwing, leaving them nil.
  func testLinearConnectionStatusDecodesWithoutOrganizationFields() throws {
    let json = """
    {
      "connected": false,
      "checkedAt": null
    }
    """.data(using: .utf8)!

    let status = try JSONDecoder().decode(LinearConnectionStatus.self, from: json)

    XCTAssertFalse(status.connected)
    XCTAssertNil(status.organizationId)
    XCTAssertNil(status.organizationName)
    XCTAssertNil(status.organizationUrlKey)
    XCTAssertNil(status.organizationLogoUrl)
  }

  func testWorkTranscriptEntryMergePrependsOlderPagesWithoutDuplicatingTailOverlap() {
    let oldest = AgentChatTranscriptEntry(
      role: "user",
      text: "oldest",
      timestamp: "2026-06-11T10:00:00.000Z",
      turnId: "turn-1"
    )
    let overlap = AgentChatTranscriptEntry(
      role: "assistant",
      text: "middle",
      timestamp: "2026-06-11T10:01:00.000Z",
      turnId: "turn-1"
    )
    let newest = AgentChatTranscriptEntry(
      role: "assistant",
      text: "newest",
      timestamp: "2026-06-11T10:02:00.000Z",
      turnId: "turn-2"
    )

    let merged = mergeWorkTranscriptEntries(
      older: [oldest, overlap],
      newer: [overlap, newest]
    )

    XCTAssertEqual(merged, [oldest, overlap, newest])
  }

  // MARK: - Orchestration session fields forward-compat

  func testAgentChatSessionSummaryDecodesOrchestrationFields() throws {
    let json = """
    {
      "sessionId": "sess-orch-1",
      "laneId": "lane-1",
      "provider": "claude",
      "model": "claude-sonnet-4-6",
      "status": "running",
      "startedAt": "2026-05-25T00:00:00.000Z",
      "lastActivityAt": "2026-05-25T00:01:00.000Z",
      "orchestrationRunId": "run-abc",
      "orchestrationRole": "worker",
      "orchestrationParentSessionId": "sess-lead-1",
      "orchestrationTag": "impl-auth",
      "orchestrationStepId": "step-2",
      "orchestrationBundlePath": "/tmp/.ade/orchestration/run-abc"
    }
    """.data(using: .utf8)!
    let summary = try JSONDecoder().decode(AgentChatSessionSummary.self, from: json)
    XCTAssertEqual(summary.orchestrationRunId, "run-abc")
    XCTAssertEqual(summary.orchestrationRole, "worker")
    XCTAssertEqual(summary.orchestrationParentSessionId, "sess-lead-1")
    XCTAssertEqual(summary.orchestrationTag, "impl-auth")
    XCTAssertEqual(summary.orchestrationStepId, "step-2")
    XCTAssertEqual(summary.orchestrationBundlePath, "/tmp/.ade/orchestration/run-abc")
  }

  func testAgentChatSessionSummaryDecodesWithoutOrchestrationFields() throws {
    let json = """
    {
      "sessionId": "sess-plain-1",
      "laneId": "lane-1",
      "provider": "codex",
      "model": "gpt-5.4",
      "status": "completed",
      "startedAt": "2026-05-25T00:00:00.000Z",
      "lastActivityAt": "2026-05-25T00:05:00.000Z"
    }
    """.data(using: .utf8)!
    let summary = try JSONDecoder().decode(AgentChatSessionSummary.self, from: json)
    XCTAssertNil(summary.orchestrationRunId)
    XCTAssertNil(summary.orchestrationRole)
    XCTAssertNil(summary.orchestrationParentSessionId)
    XCTAssertNil(summary.orchestrationTag)
    XCTAssertNil(summary.orchestrationStepId)
    XCTAssertNil(summary.orchestrationBundlePath)
  }

  func testTerminalSessionSummaryDecodesOrchestrationFields() throws {
    let json = """
    {
      "id": "term-orch-1",
      "laneId": "lane-1",
      "laneName": "Feature",
      "tracked": true,
      "pinned": false,
      "title": "Worker: auth impl",
      "status": "running",
      "startedAt": "2026-05-25T00:00:00.000Z",
      "transcriptPath": "/tmp/transcript.jsonl",
      "runtimeState": "running",
      "orchestrationRunId": "run-xyz",
      "orchestrationRole": "validator",
      "orchestrationTag": "test-coverage"
    }
    """.data(using: .utf8)!
    let session = try JSONDecoder().decode(TerminalSessionSummary.self, from: json)
    XCTAssertEqual(session.orchestrationRunId, "run-xyz")
    XCTAssertEqual(session.orchestrationRole, "validator")
    XCTAssertEqual(session.orchestrationTag, "test-coverage")
  }

  func testAgentChatSessionDecodesOrchestrationFields() throws {
    let json = """
    {
      "sessionId": "sess-full-orch",
      "laneId": "lane-2",
      "provider": "claude",
      "model": "claude-sonnet-4-6",
      "status": "running",
      "createdAt": "2026-05-25T00:00:00.000Z",
      "lastActivityAt": "2026-05-25T00:02:00.000Z",
      "orchestrationRunId": "run-full",
      "orchestrationRole": "lead",
      "orchestrationTag": "coordinator"
    }
    """.data(using: .utf8)!
    let session = try JSONDecoder().decode(AgentChatSession.self, from: json)
    XCTAssertEqual(session.orchestrationRunId, "run-full")
    XCTAssertEqual(session.orchestrationRole, "lead")
    XCTAssertEqual(session.orchestrationTag, "coordinator")
    XCTAssertNil(session.orchestrationParentSessionId)
    XCTAssertNil(session.orchestrationStepId)
    XCTAssertNil(session.orchestrationBundlePath)
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
