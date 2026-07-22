import XCTest
@testable import ADE

/// Table-driven coverage for the Work-tab canonical session vocabulary — the
/// iOS mirror of desktop `sessionCanonicalState.ts`. Locks the precedence chain,
/// the exact 3-hour stale boundary, and the no-badge-for-calm-states rule.
final class WorkSessionCanonicalStateTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_780_000_000)

  private func iso(_ date: Date) -> String {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: date)
  }

  /// lastActivityAt for a session that has been silent for `seconds`.
  private func silentFor(_ seconds: TimeInterval) -> String {
    iso(now.addingTimeInterval(-seconds))
  }

  // MARK: - Precedence

  func testDeterministicNeedsInputBeatsEverything() {
    struct Case {
      let name: String
      let status: String
      let runtimeState: String?
      let toolType: String?
      let pendingInputItemId: String?
      let lastActivityAt: String?
      let exitCode: Int?
    }

    let cases: [Case] = [
      Case(
        name: "pendingInput beats stale",
        status: "running",
        runtimeState: "running",
        toolType: "codex",
        pendingInputItemId: "item-1",
        lastActivityAt: silentFor(sessionStaleAfterSeconds + 60),
        exitCode: nil
      ),
      Case(
        name: "waiting-input beats stale",
        status: "running",
        runtimeState: "waiting-input",
        toolType: "codex",
        pendingInputItemId: nil,
        lastActivityAt: silentFor(sessionStaleAfterSeconds + 60),
        exitCode: nil
      ),
      Case(
        name: "waiting-input beats calm idle chat preview",
        status: "running",
        runtimeState: "waiting-input",
        toolType: "codex-chat",
        pendingInputItemId: nil,
        lastActivityAt: iso(now),
        exitCode: nil
      ),
      Case(
        name: "pendingInput beats a non-zero exit (deterministic ask still actionable)",
        status: "ended",
        runtimeState: "running",
        toolType: "codex",
        pendingInputItemId: "item-2",
        lastActivityAt: iso(now),
        exitCode: 7
      ),
    ]

    for c in cases {
      let state = workCanonicalSessionState(
        status: c.status,
        runtimeState: c.runtimeState,
        toolType: c.toolType,
        pendingInputItemId: c.pendingInputItemId,
        lastActivityAt: c.lastActivityAt,
        exitCode: c.exitCode,
        now: now
      )
      XCTAssertEqual(state.phase, .needsYou, c.name)
      XCTAssertEqual(state.badge?.kind, .needsYou, c.name)
      XCTAssertEqual(state.badge?.label, "Needs you", c.name)
    }
  }

  func testStoppedDisposedSessionsAreNotFailed() {
    let disposed = workCanonicalSessionState(status: "disposed", runtimeState: "killed", toolType: "codex", exitCode: nil, now: now)
    XCTAssertEqual(disposed.phase, .stopped)
    XCTAssertNil(disposed.badge)

    let userStop = workCanonicalSessionState(status: "disposed", runtimeState: "killed", toolType: "codex", exitCode: 130, now: now)
    XCTAssertEqual(userStop.phase, .stopped)
    XCTAssertNil(userStop.badge)
  }

  func testFailedOnlyForEndedNonCleanExitOrKilled() {
    // Non-zero exit on an ended session → failed.
    let failedExit = workCanonicalSessionState(status: "ended", runtimeState: "exited", toolType: "codex", exitCode: 1, now: now)
    XCTAssertEqual(failedExit.phase, .failed)
    XCTAssertEqual(failedExit.badge?.label, "Failed")

    // Killed runtime → failed even with a nil exit code.
    let killed = workCanonicalSessionState(status: "ended", runtimeState: "killed", toolType: "codex", exitCode: nil, now: now)
    XCTAssertEqual(killed.phase, .failed)

    // Clean exit (0) → calm ended, no badge.
    let clean = workCanonicalSessionState(status: "ended", runtimeState: "exited", toolType: "codex", exitCode: 0, now: now)
    XCTAssertEqual(clean.phase, .ended)
    XCTAssertNil(clean.badge)

    // A non-zero exit while still running is ignored (failure is an ended-only
    // signal); the session stays running.
    let runningWithCode = workCanonicalSessionState(status: "running", runtimeState: "running", toolType: "codex", lastActivityAt: iso(now), exitCode: 5, now: now)
    XCTAssertEqual(runningWithCode.phase, .running)
    XCTAssertNil(runningWithCode.badge)
  }

  func testStaleBoundaryIsExactlyThreeHours() {
    // Just under 3 hours of silence → still running (no capsule).
    let justUnder = workCanonicalSessionState(
      status: "running",
      runtimeState: "running",
      toolType: "codex",
      lastActivityAt: silentFor(sessionStaleAfterSeconds - 1),
      now: now
    )
    XCTAssertEqual(justUnder.phase, .running)
    XCTAssertNil(justUnder.badge)

    // Exactly at the threshold → stale.
    let exactly = workCanonicalSessionState(
      status: "running",
      runtimeState: "running",
      toolType: "codex",
      lastActivityAt: silentFor(sessionStaleAfterSeconds),
      now: now
    )
    XCTAssertEqual(exactly.phase, .stale)
    XCTAssertEqual(exactly.badge?.kind, .stale)
    XCTAssertEqual(exactly.badge?.label, "Stale")
  }

  func testStaleBeatsRunningPreviewHeuristic() {
    // Silent past threshold AND a prompt-like preview → stale wins (heuristic is
    // consulted only for otherwise-plain running sessions).
    let state = workCanonicalSessionState(
      status: "running",
      runtimeState: "running",
      toolType: "codex",
      lastOutputPreview: "Continue? (y/n)",
      lastActivityAt: silentFor(sessionStaleAfterSeconds + 60),
      now: now
    )
    XCTAssertEqual(state.phase, .stale)
  }

  // MARK: - Preview heuristic (running → needs_you, LAST)

  func testPreviewHeuristicUpgradesRunningToNeedsYou() {
    let prompts = ["Continue? (y/n)", "Press enter to proceed", "Allow this action? (Y)es / (N)o"]
    for prompt in prompts {
      let state = workCanonicalSessionState(
        status: "running",
        runtimeState: "running",
        toolType: "codex",
        lastOutputPreview: prompt,
        lastActivityAt: iso(now),
        now: now
      )
      XCTAssertEqual(state.phase, .needsYou, "prompt: \(prompt)")
    }
  }

  func testPreviewHeuristicIgnoredForEndedSessions() {
    // A prompt-like preview never resurrects an ended session — the heuristic
    // only upgrades a live running session.
    let state = workCanonicalSessionState(
      status: "ended",
      runtimeState: "exited",
      toolType: "codex",
      lastOutputPreview: "Continue? (y/n)",
      exitCode: 0,
      now: now
    )
    XCTAssertEqual(state.phase, .ended)
    XCTAssertNil(state.badge)
  }

  func testBenignPreviewLeavesRunningCalm() {
    let state = workCanonicalSessionState(
      status: "running",
      runtimeState: "running",
      toolType: "codex",
      lastOutputPreview: "Compiling module ADE (43 files)",
      lastActivityAt: iso(now),
      now: now
    )
    XCTAssertEqual(state.phase, .running)
    XCTAssertNil(state.badge)
  }

  // MARK: - Active-project roster overlay

  func testActiveProjectRosterOverlayKeepsLocalRowsAndAppendsMissingRosterRowsInSourceOrder() {
    let localLane = makeLane(id: "lane-local", name: "Local lane")
    let localSession = makeSession(id: "local-chat", laneId: localLane.id, laneName: localLane.name, title: "Hydrated local title")
    let roster = RemoteRosterProject(
      projectId: "project-1",
      rootPath: nil,
      displayName: "Project",
      iconDataUrl: nil,
      lastOpenedAt: nil,
      booted: true,
      runningCount: 0,
      attentionCount: 0,
      lanes: [
        RemoteRosterLane(id: "lane-local", name: "Stale remote name", color: nil, icon: nil, laneType: "primary", branchRef: "main"),
        RemoteRosterLane(id: "lane-roster-1", name: "Roster one", color: nil, icon: nil, laneType: "worktree", branchRef: "feature/one"),
        RemoteRosterLane(id: "lane-roster-2", name: "Roster two", color: nil, icon: nil, laneType: "worktree", branchRef: "feature/two"),
      ],
      chats: [
        makeRosterChat(id: "local-chat", laneId: "lane-local", title: "Stale remote title"),
        makeRosterChat(id: "roster-chat-1", laneId: "lane-roster-2", title: "Roster chat one"),
        makeRosterChat(id: "roster-chat-2", laneId: "lane-roster-1", title: "Roster chat two"),
      ]
    )

    let projection = overlayActiveProjectRoster(
      localSessions: [localSession],
      localLanes: [localLane],
      roster: roster
    )

    XCTAssertEqual(projection.lanes.map(\.id), ["lane-local", "lane-roster-1", "lane-roster-2"])
    XCTAssertEqual(projection.sessions.map(\.id), ["local-chat", "roster-chat-1", "roster-chat-2"])
    XCTAssertEqual(projection.sessions.first?.title, "Hydrated local title")
    XCTAssertEqual(projection.sessions[1].laneName, "Roster two")
  }

  func testActiveProjectRosterOverlayExcludesArchivedChatsAndHandlesNoRoster() {
    let localLane = makeLane(id: "lane-local", name: "Local lane")
    let localSession = makeSession(id: "local-chat", laneId: localLane.id, laneName: localLane.name, title: "Local")
    let roster = RemoteRosterProject(
      projectId: "project-1",
      rootPath: nil,
      displayName: "Project",
      iconDataUrl: nil,
      lastOpenedAt: nil,
      booted: false,
      runningCount: 0,
      attentionCount: 0,
      lanes: [RemoteRosterLane(id: "lane-roster", name: "Roster", color: nil, icon: nil, laneType: "worktree", branchRef: "feature")],
      chats: [
        makeRosterChat(id: "archived-chat", laneId: "lane-roster", title: "Archived", archived: true),
        makeRosterChat(id: "cli-session", laneId: "lane-roster", title: "Terminal", toolType: "cli"),
      ]
    )

    let withRoster = overlayActiveProjectRoster(localSessions: [localSession], localLanes: [localLane], roster: roster)
    XCTAssertEqual(withRoster.sessions.map(\.id), ["local-chat"])
    XCTAssertEqual(withRoster.lanes.map(\.id), ["lane-local"])

    let withoutRoster = overlayActiveProjectRoster(localSessions: [localSession], localLanes: [localLane], roster: nil)
    XCTAssertEqual(withoutRoster.sessions, [localSession])
    XCTAssertEqual(withoutRoster.lanes, [localLane])
  }

  func testActiveProjectRosterOverlayBoundsChatStubsAndOmitsUnusedLanes() {
    let chats = (0..<(workActiveProjectRosterSessionLimit + 5)).map { index in
      makeRosterChat(id: "chat-\(index)", laneId: "lane-used", title: "Chat \(index)")
    }
    let roster = RemoteRosterProject(
      projectId: "project-1",
      rootPath: nil,
      displayName: "Project",
      iconDataUrl: nil,
      lastOpenedAt: nil,
      booted: true,
      runningCount: 0,
      attentionCount: 0,
      lanes: [
        RemoteRosterLane(id: "lane-used", name: "Used", color: nil, icon: nil, laneType: "worktree", branchRef: "feature"),
        RemoteRosterLane(id: "lane-empty", name: "Empty", color: nil, icon: nil, laneType: "worktree", branchRef: "empty"),
      ],
      chats: chats
    )

    let projection = overlayActiveProjectRoster(localSessions: [], localLanes: [], roster: roster)

    XCTAssertEqual(projection.sessions.count, workActiveProjectRosterSessionLimit)
    XCTAssertEqual(projection.sessions.first?.id, "chat-0")
    XCTAssertEqual(projection.sessions.last?.id, "chat-\(workActiveProjectRosterSessionLimit - 1)")
    XCTAssertEqual(projection.lanes.map(\.id), ["lane-used"])
  }

  func testRosterSessionStubIsChatOnlyBecauseTerminalMetadataIsIncomplete() {
    let lane = RemoteRosterLane(
      id: "lane-1",
      name: "Feature",
      color: nil,
      icon: nil,
      laneType: "worktree",
      branchRef: "feature"
    )
    XCTAssertNotNil(makeRosterSessionStub(
      chat: makeRosterChat(id: "chat", laneId: lane.id, title: "Chat"),
      lane: lane
    ))
    XCTAssertNil(makeRosterSessionStub(
      chat: makeRosterChat(id: "cli", laneId: lane.id, title: "Terminal", toolType: "cli"),
      lane: lane
    ))
  }

  func testRosterChangedProjectIdsIgnoresUnrelatedStableProjects() {
    func project(_ id: String, title: String) -> RemoteRosterProject {
      RemoteRosterProject(
        projectId: id,
        rootPath: "/tmp/\(id)",
        displayName: id,
        iconDataUrl: nil,
        lastOpenedAt: nil,
        booted: true,
        runningCount: 0,
        attentionCount: 0,
        lanes: [],
        chats: [makeRosterChat(id: "\(id)-chat", laneId: "lane", title: title)]
      )
    }
    let stable = project("stable", title: "Same")
    let previous = [stable, project("changed", title: "Before"), project("removed", title: "Gone")]
    let next = [stable, project("changed", title: "After"), project("added", title: "New")]

    XCTAssertEqual(rosterChangedProjectIds(previous: [stable, next[1]], next: [next[1], stable]), [])
    XCTAssertEqual(
      rosterChangedProjectIds(previous: previous, next: next),
      ["changed", "removed", "added"]
    )
  }

  func testWorkHydrationDetectsOnlyNonemptyMissingLaneIds() {
    let sessions = [
      makeSession(id: "known", laneId: "lane-known"),
      makeSession(id: "new-a", laneId: "lane-new"),
      makeSession(id: "new-b", laneId: "lane-new"),
      makeSession(id: "malformed", laneId: "   "),
    ]

    XCTAssertEqual(
      syncMissingWorkSessionLaneIds(
        sessions: sessions,
        knownLaneIds: ["lane-known"]
      ),
      ["lane-new"]
    )
  }

  func testPendingChatCreationStaysInItsProjectScope() {
    let creation = PendingChatCreation(
      id: "pending-1",
      projectId: "project-a",
      projectRootPath: "/tmp/A/",
      laneId: "lane-1",
      name: "Queued",
      provider: "codex",
      model: "gpt",
      queuedAt: ""
    )

    XCTAssertTrue(workPendingChatCreationMatchesProject(
      creation,
      projectId: "project-a",
      projectRootPath: "/other"
    ))
    XCTAssertTrue(workPendingChatCreationMatchesProject(
      creation,
      projectId: "alias-a",
      projectRootPath: "/tmp/A"
    ))
    XCTAssertFalse(workPendingChatCreationMatchesProject(
      creation,
      projectId: "project-b",
      projectRootPath: "/tmp/B"
    ))
  }

  func testRosterSessionNavigationUsesSessionIdentityAcrossProjects() {
    let ade = MobileProjectSummary(
      id: "project-ade",
      displayName: "ADE",
      rootPath: "/Users/test/ADE",
      laneCount: 1,
      isAvailable: true,
      isCached: true
    )
    let versic = MobileProjectSummary(
      id: "project-versic",
      displayName: "Versic",
      rootPath: "/Users/test/Versic",
      laneCount: 1,
      isAvailable: true,
      isCached: true
    )
    let lane = RemoteRosterLane(
      id: "lane-versic",
      name: "Search hygiene",
      color: nil,
      icon: nil,
      laneType: "worktree",
      branchRef: "ver/search-hygiene"
    )
    let roster = RemoteRosterProject(
      projectId: versic.id,
      rootPath: versic.rootPath,
      displayName: versic.displayName,
      iconDataUrl: nil,
      lastOpenedAt: nil,
      booted: true,
      runningCount: 1,
      attentionCount: 0,
      lanes: [lane],
      chats: [makeRosterChat(id: "foreign-chat", laneId: lane.id, title: "Foreign chat")]
    )

    let target = resolveRosterSessionNavigationTarget(
      projects: [ade, versic],
      rosterProjects: [roster],
      sessionId: "foreign-chat",
      laneId: nil,
      repoName: nil,
      branch: nil
    )

    XCTAssertEqual(target?.project.id, versic.id)
    XCTAssertEqual(target?.lane?.id, lane.id)
    XCTAssertEqual(target?.chat.id, "foreign-chat")
    XCTAssertTrue(target?.chat.isChatTool == true)
  }

  func testRosterSessionNavigationUsesScopedRepoAndBranchBeforeSessionAppears() {
    let project = MobileProjectSummary(
      id: "catalog-versic",
      displayName: "Versic",
      rootPath: "/Users/test/Versic.git",
      laneCount: 1,
      isAvailable: true,
      isCached: true
    )
    let lane = RemoteRosterLane(
      id: "lane-versic",
      name: "Search hygiene",
      color: nil,
      icon: nil,
      laneType: "worktree",
      branchRef: "ver/search-hygiene"
    )
    let roster = RemoteRosterProject(
      projectId: "roster-versic",
      rootPath: nil,
      displayName: "Versic",
      iconDataUrl: nil,
      lastOpenedAt: nil,
      booted: false,
      runningCount: 0,
      attentionCount: 0,
      lanes: [lane],
      chats: []
    )

    let target = resolveRosterSessionNavigationTarget(
      projects: [project],
      rosterProjects: [roster],
      sessionId: "not-in-roster-yet",
      laneId: nil,
      repoName: "Versic",
      branch: lane.branchRef
    )

    XCTAssertEqual(target?.project.id, project.id)
    XCTAssertEqual(target?.lane?.id, lane.id)
    XCTAssertEqual(target?.chat.id, "not-in-roster-yet")
    XCTAssertFalse(target?.chat.isChatTool == true, "unknown rows must activate and hydrate instead of opening a fake chat")
  }

  func testWorkSessionNavigationRecognizesProjectEnvelope() {
    XCTAssertFalse(WorkSessionNavigationRequest(sessionId: "local").hasProjectScope)
    XCTAssertTrue(WorkSessionNavigationRequest(sessionId: "scoped", repoName: "Versic").hasProjectScope)
    XCTAssertTrue(WorkSessionNavigationRequest(sessionId: "scoped", branch: "ver/search").hasProjectScope)
  }

  // MARK: - No badge for calm states

  func testCalmStatesCarryNoBadge() {
    // Fresh running CLI.
    let running = workCanonicalSessionState(status: "running", runtimeState: "running", toolType: "codex", lastActivityAt: iso(now), now: now)
    XCTAssertEqual(running.phase, .running)
    XCTAssertNil(running.badge)

    // Idle chat rests between turns → ready.
    let idleChat = workCanonicalSessionState(status: "running", runtimeState: "idle", toolType: "codex-chat", lastActivityAt: iso(now), now: now)
    XCTAssertEqual(idleChat.phase, .ready)
    XCTAssertNil(idleChat.badge)

    // Idle CLI → idle (calm, no deterministic ask).
    let idleCli = workCanonicalSessionState(status: "running", runtimeState: "idle", toolType: "codex", lastActivityAt: iso(now), now: now)
    XCTAssertEqual(idleCli.phase, .idle)
    XCTAssertNil(idleCli.badge)

    // Ended chat rests, ready for input — never "ended".
    let endedChat = workCanonicalSessionState(status: "ended", runtimeState: "exited", toolType: "codex-chat", exitCode: 0, now: now)
    XCTAssertEqual(endedChat.phase, .ready)
    XCTAssertNil(endedChat.badge)
  }

  // MARK: - Chat-tool predicate

  func testChatToolTypePredicate() {
    for chat in ["codex-chat", "claude-chat", "opencode-chat", "cursor", "droid-chat"] {
      XCTAssertTrue(isWorkChatToolType(chat), chat)
    }
    for cli in ["codex", "claude", "droid", "run-shell", nil, ""] {
      XCTAssertFalse(isWorkChatToolType(cli), cli ?? "nil")
    }
  }

  // MARK: - Row wrapper (iOS field mapping)

  func testCapsuleBadgeMapsChatAwaitingInputToNeedsYou() {
    let session = makeSession(status: "running", runtimeState: "running", toolType: "codex-chat")
    let summary = makeChatSummary(status: "active", awaitingInput: true)
    let badge = workSessionCapsuleBadge(session: session, summary: summary, now: now)
    XCTAssertEqual(badge?.kind, .needsYou)
  }

  func testCapsuleBadgeSurfacesFailedExit() {
    let session = makeSession(status: "ended", runtimeState: "exited", toolType: "codex", exitCode: 130)
    let badge = workSessionCapsuleBadge(session: session, summary: nil, now: now)
    XCTAssertEqual(badge?.kind, .failed)
  }

  func testCapsuleBadgeNilForStoppedDisposedSession() {
    let session = makeSession(status: "disposed", runtimeState: "killed", toolType: "codex", exitCode: 130)
    let badge = workSessionCapsuleBadge(session: session, summary: nil, now: now)
    XCTAssertNil(badge)
  }

  func testCapsuleBadgeNilForFreshRunning() {
    let session = makeSession(status: "running", runtimeState: "running", toolType: "codex", startedAt: iso(now))
    let badge = workSessionCapsuleBadge(session: session, summary: nil, now: now)
    XCTAssertNil(badge)
  }

  // MARK: - Local echo rendering

  func testLocalEchoTimelinePreservesImageAttachments() {
    let attachment = AgentChatFileRef(
      path: "/project/.ade/attachments/mobile-image.jpg",
      type: "image",
      url: nil
    )
    let echo = WorkLocalEchoMessage(
      text: "Attached image.",
      timestamp: iso(now),
      deliveryState: nil,
      attachments: [attachment]
    )

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: [],
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: [echo]
    )
    let message = snapshot.timeline.compactMap { entry -> WorkChatMessage? in
      if case .message(let message) = entry.payload { return message }
      return nil
    }.first

    XCTAssertEqual(message?.markdown, "Attached image.")
    XCTAssertEqual(message?.attachments, [attachment])
    XCTAssertNil(message?.deliveryState)
  }

  func testImageOnlyLocalEchoDedupeIncludesAttachmentIdentity() {
    let first = AgentChatFileRef(path: "/project/.ade/attachments/first.jpg", type: "image", url: nil)
    let second = AgentChatFileRef(path: "/project/.ade/attachments/second.jpg", type: "image", url: nil)
    XCTAssertNotEqual(
      workLocalEchoDedupeKey(text: "Attached image.", attachments: [first]),
      workLocalEchoDedupeKey(text: "Attached image.", attachments: [second])
    )
    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: [
        WorkChatEnvelope(
          sessionId: "chat-1",
          timestamp: iso(now),
          sequence: 1,
          event: .userMessage(
            text: "Attached image.",
            attachments: [first],
            turnId: nil,
            steerId: nil,
            deliveryState: nil,
            processed: nil
          )
        )
      ],
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: [
        WorkLocalEchoMessage(text: "Attached image.", timestamp: iso(now), deliveryState: nil, attachments: [first]),
        WorkLocalEchoMessage(text: "Attached image.", timestamp: iso(now), deliveryState: nil, attachments: [second]),
      ]
    )
    let visibleUserMessages = snapshot.timeline.compactMap { entry -> WorkChatMessage? in
      if case .message(let message) = entry.payload, message.role == "user" { return message }
      return nil
    }

    XCTAssertEqual(visibleUserMessages.count, 2)
    XCTAssertTrue(visibleUserMessages.contains { $0.attachments == [first] })
    XCTAssertTrue(visibleUserMessages.contains { $0.attachments == [second] })
  }

  func testQueuedImageSteerDedupeIncludesAttachmentIdentity() {
    let first = AgentChatFileRef(path: "/project/.ade/attachments/first.jpg", type: "image", url: nil)
    let second = AgentChatFileRef(path: "/project/.ade/attachments/second.jpg", type: "image", url: nil)
    let transcript = [
      WorkChatEnvelope(
        sessionId: "chat-1",
        timestamp: iso(now),
        sequence: 1,
        event: .userMessage(
          text: "Attached image.",
          attachments: [first],
          turnId: nil,
          steerId: "steer-1",
          deliveryState: "queued",
          processed: nil
        )
      )
    ]
    XCTAssertEqual(derivePendingWorkSteers(from: transcript).first?.attachments, [first])

    let snapshot = buildWorkChatTimelineSnapshot(
      transcript: transcript,
      fallbackEntries: [],
      artifacts: [],
      localEchoMessages: [
        WorkLocalEchoMessage(text: "Attached image.", timestamp: iso(now), deliveryState: "queued", attachments: [first]),
        WorkLocalEchoMessage(text: "Attached image.", timestamp: iso(now), deliveryState: "queued", attachments: [second]),
      ]
    )
    let visibleUserMessages = snapshot.timeline.compactMap { entry -> WorkChatMessage? in
      if case .message(let message) = entry.payload, message.role == "user" { return message }
      return nil
    }

    XCTAssertEqual(visibleUserMessages.count, 1)
    XCTAssertEqual(visibleUserMessages.filter { $0.attachments == [first] }.count, 0)
    XCTAssertEqual(visibleUserMessages.filter { $0.attachments == [second] }.count, 1)
  }

  // MARK: - Fixtures

  private func makeSession(
    id: String = "s-1",
    laneId: String = "lane-1",
    laneName: String = "feature/work",
    title: String = "Session",
    status: String = "completed",
    runtimeState: String = "exited",
    toolType: String? = "codex-chat",
    exitCode: Int? = nil,
    pendingInputItemId: String? = nil,
    lastOutputPreview: String? = nil,
    startedAt: String? = nil
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
      startedAt: startedAt ?? iso(now),
      endedAt: nil,
      archivedAt: nil,
      exitCode: exitCode,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: lastOutputPreview,
      summary: nil,
      runtimeState: runtimeState,
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: nil,
      chatSessionId: nil,
      pendingInputItemId: pendingInputItemId
    )
  }

  private func makeLane(id: String, name: String) -> LaneSummary {
    LaneSummary(
      id: id,
      name: name,
      description: nil,
      laneType: "worktree",
      baseRef: "main",
      branchRef: "feature",
      worktreePath: "",
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
      linearIssue: nil,
      linearIssueLinks: nil,
      createdAt: "",
      archivedAt: nil,
      devicesOpen: nil
    )
  }

  private func makeRosterChat(
    id: String,
    laneId: String,
    title: String,
    archived: Bool? = nil,
    toolType: String? = "codex-chat"
  ) -> RemoteRosterChat {
    RemoteRosterChat(
      id: id,
      laneId: laneId,
      chatSessionId: nil,
      title: title,
      provider: "codex",
      model: nil,
      toolType: toolType,
      status: .idle,
      awaitingInput: nil,
      pinned: nil,
      archived: archived,
      lastActivityAt: nil,
      preview: nil
    )
  }

  private func makeChatSummary(status: String, awaitingInput: Bool?) -> AgentChatSessionSummary {
    AgentChatSessionSummary(
      sessionId: "chat-1",
      laneId: "lane-1",
      provider: "codex",
      model: "gpt-5.4",
      modelId: nil,
      sessionProfile: nil,
      title: nil,
      goal: nil,
      reasoningEffort: nil,
      codexFastMode: nil,
      fastMode: nil,
      executionMode: nil,
      permissionMode: nil,
      interactionMode: nil,
      claudePermissionMode: nil,
      codexApprovalPolicy: nil,
      codexSandbox: nil,
      codexConfigSource: nil,
      opencodePermissionMode: nil,
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
      startedAt: iso(now),
      endedAt: nil,
      archivedAt: nil,
      lastActivityAt: iso(now),
      lastOutputPreview: nil,
      summary: nil,
      awaitingInput: awaitingInput,
      pendingInputItemId: nil,
      threadId: nil,
      requestedCwd: nil
    )
  }

  // MARK: - Codex web_search results contract (desktop chat.ts parity)

  /// Newer host emits `results`/`resultsTotal` alongside `actions`; both must
  /// decode and survive onto the event.
  func testWebSearchEventDecodesResultsFromNewerHost() throws {
    let json = """
    {
      "type": "web_search",
      "query": "swift structured concurrency",
      "action": "openPage",
      "actions": [{ "type": "openPage", "url": "https://a.example", "title": "A" }],
      "results": [
        { "url": "https://b.example", "title": "B", "snippet": "hello" },
        { "url": "https://c.example" }
      ],
      "resultsTotal": 2,
      "itemId": "ws-1",
      "logicalItemId": "logical-1",
      "turnId": "turn-1",
      "status": "completed"
    }
    """
    let event = try JSONDecoder().decode(AgentChatEvent.self, from: Data(json.utf8))
    guard case let .webSearch(query, _, actions, results, resultsTotal, itemId, _, _, status) = event else {
      return XCTFail("expected .webSearch, got \(event)")
    }
    XCTAssertEqual(query, "swift structured concurrency")
    XCTAssertEqual(actions?.count, 1)
    XCTAssertEqual(results?.count, 2)
    XCTAssertEqual(results?.first, CodexWebSearchResult(url: "https://b.example", title: "B", snippet: "hello"))
    XCTAssertEqual(results?.last, CodexWebSearchResult(url: "https://c.example", title: nil, snippet: nil))
    XCTAssertEqual(resultsTotal, 2)
    XCTAssertEqual(itemId, "ws-1")
    XCTAssertEqual(status, "completed")
  }

  /// A single malformed entry inside `results` (e.g. a non-object hit from a
  /// future host shape) must be dropped by the ADELossyArray decode WITHOUT
  /// failing the whole event — otherwise the tool card would vanish entirely.
  func testWebSearchEventDropsMalformedResultEntryButKeepsEvent() throws {
    let json = """
    {
      "type": "web_search",
      "query": "q",
      "results": [
        { "url": "https://ok.example", "title": "OK" },
        42,
        "not-an-object"
      ],
      "itemId": "ws-2",
      "status": "running"
    }
    """
    let event = try JSONDecoder().decode(AgentChatEvent.self, from: Data(json.utf8))
    guard case let .webSearch(_, _, _, results, resultsTotal, itemId, _, _, status) = event else {
      return XCTFail("expected .webSearch, got \(event)")
    }
    XCTAssertEqual(results?.count, 1, "malformed entries must be dropped, valid hit retained")
    XCTAssertEqual(results?.first?.url, "https://ok.example")
    XCTAssertNil(resultsTotal)
    XCTAssertEqual(itemId, "ws-2")
    XCTAssertEqual(status, "running")
  }

  /// Older host omits `results`/`resultsTotal` entirely; decode must succeed
  /// with both nil (fields are optional on the wire).
  func testWebSearchEventDecodesFromOlderHostWithoutResults() throws {
    let json = """
    {
      "type": "web_search",
      "query": "q",
      "actions": [{ "type": "openPage", "url": "https://a.example", "title": "A" }],
      "itemId": "ws-3",
      "status": "completed"
    }
    """
    let event = try JSONDecoder().decode(AgentChatEvent.self, from: Data(json.utf8))
    guard case let .webSearch(_, _, actions, results, resultsTotal, _, _, _, _) = event else {
      return XCTFail("expected .webSearch, got \(event)")
    }
    XCTAssertEqual(actions?.count, 1)
    XCTAssertNil(results)
    XCTAssertNil(resultsTotal)
  }

  // MARK: - buildWorkToolCards web_search preservation (/quality regression)

  /// Regression pin for the /quality Medium finding: a later same-itemId
  /// web_search event that omits `results`/`actions` (e.g. a status-only
  /// update) must NOT erase the sources merged from the earlier event.
  func testBuildWorkToolCardsPreservesEarlierWebSearchResults() {
    let action = CodexWebSearchAction(
      type: "openPage", status: nil, query: nil, queries: nil,
      url: "https://a.example", title: "A", snippet: nil
    )
    let result = CodexWebSearchResult(url: "https://b.example", title: "B", snippet: "hello")

    let first = WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: iso(now),
      sequence: 1,
      event: .webSearch(
        query: "q", action: "openPage", actions: [action], results: [result],
        status: .running, itemId: "ws-1", turnId: "turn-1"
      )
    )
    // Later event for the SAME itemId omits actions/results (nil).
    let second = WorkChatEnvelope(
      sessionId: "chat-1",
      timestamp: iso(now.addingTimeInterval(1)),
      sequence: 2,
      event: .webSearch(
        query: "q", action: nil, actions: nil, results: nil,
        status: .completed, itemId: "ws-1", turnId: "turn-1"
      )
    )

    let cards = buildWorkToolCards(from: [first, second])
    XCTAssertEqual(cards.count, 1)
    let card = cards.first
    XCTAssertEqual(card?.status, WorkToolCardStatus.completed, "later status still applies")
    XCTAssertEqual(card?.webSearchActions, [action], "earlier actions preserved through results-less update")
    XCTAssertEqual(card?.webSearchResults, [result], "earlier results preserved through results-less update")
  }

  // MARK: - MobileUsageQuotaSnapshot.spendControlReached (desktop usage.ts parity)

  /// Newer host reports the Codex spend-control flag; decode it as true.
  func testMobileUsageQuotaSnapshotDecodesSpendControlReached() throws {
    let json = """
    { "windows": [], "lastPolledAt": "2026-07-16T00:00:00Z", "errors": [], "spendControlReached": true }
    """
    let snapshot = try JSONDecoder().decode(MobileUsageQuotaSnapshot.self, from: Data(json.utf8))
    XCTAssertEqual(snapshot.spendControlReached, true)
  }

  /// Older host omits the flag (desktop only includes it when boolean); decode
  /// must succeed with the field nil rather than throwing.
  func testMobileUsageQuotaSnapshotDecodesWithoutSpendControlReached() throws {
    let json = """
    { "windows": [], "lastPolledAt": "2026-07-16T00:00:00Z", "errors": [] }
    """
    let snapshot = try JSONDecoder().decode(MobileUsageQuotaSnapshot.self, from: Data(json.utf8))
    XCTAssertNil(snapshot.spendControlReached)
  }
}
