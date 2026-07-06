import XCTest
@testable import ADE

/// Table-driven coverage for the Work-tab canonical session vocabulary — the
/// iOS mirror of desktop `sessionCanonicalState.ts`. Locks the precedence chain,
/// the exact 20-minute stale boundary, and the no-badge-for-calm-states rule.
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
        lastActivityAt: silentFor(30 * 60),
        exitCode: nil
      ),
      Case(
        name: "waiting-input beats stale",
        status: "running",
        runtimeState: "waiting-input",
        toolType: "codex",
        pendingInputItemId: nil,
        lastActivityAt: silentFor(30 * 60),
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

  func testStaleBoundaryIsExactlyTwentyMinutes() {
    // Just under 20 minutes of silence → still running (no capsule).
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

  func testCapsuleBadgeNilForFreshRunning() {
    let session = makeSession(status: "running", runtimeState: "running", toolType: "codex", startedAt: iso(now))
    let badge = workSessionCapsuleBadge(session: session, summary: nil, now: now)
    XCTAssertNil(badge)
  }

  // MARK: - Fixtures

  private func makeSession(
    status: String,
    runtimeState: String,
    toolType: String?,
    exitCode: Int? = nil,
    pendingInputItemId: String? = nil,
    lastOutputPreview: String? = nil,
    startedAt: String? = nil
  ) -> TerminalSessionSummary {
    TerminalSessionSummary(
      id: "s-1",
      laneId: "lane-1",
      laneName: "feature/work",
      ptyId: nil,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: nil,
      toolType: toolType,
      title: "Session",
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
}
