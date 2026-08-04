import XCTest
@testable import ADE

/// Table-driven coverage for the Work-tab canonical session vocabulary — the
/// iOS mirror of desktop `sessionCanonicalState.ts`. Locks the precedence chain,
/// the exact 3-hour stale boundary, and the single-derivation contract between
/// `workSessionRowPresentation` and its wrappers.
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

  /// The attention third of the vocabulary: the phases something downstream may
  /// reasonably treat as "act on this". `CanonicalSessionState` carries a phase
  /// and nothing else, so "this state is calm" is asserted here rather than
  /// against a presentation field riding along on the state value.
  private func isAttentionPhase(_ phase: CanonicalSessionPhase) -> Bool {
    phase == .needsYou || phase == .failed || phase == .stale
  }

  /// The capsule word a phase wears, read out of the exact table the row renders
  /// from — so a reworded vocabulary entry fails here too.
  private func phaseLabel(_ phase: CanonicalSessionPhase) -> String {
    ActivityPhaseVocabulary.presentation(for: workActivityPhase(for: phase)).label
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
      XCTAssertTrue(isAttentionPhase(state.phase), c.name)
      XCTAssertEqual(phaseLabel(state.phase), "Needs you", c.name)
    }
  }

  func testRuntimeWaitingInputAloneDoesNotRaiseAttention() {
    XCTAssertEqual(
      workCanonicalSessionState(
        status: "running",
        runtimeState: "waiting-input",
        toolType: "codex",
        lastActivityAt: silentFor(sessionStaleAfterSeconds + 60),
        now: now
      ).phase,
      .stale
    )
    XCTAssertEqual(
      workCanonicalSessionState(
        status: "running",
        runtimeState: "waiting-input",
        toolType: "codex-chat",
        lastActivityAt: iso(now),
        now: now
      ).phase,
      .running
    )
  }

  func testStoppedDisposedSessionsAreNotFailed() {
    let disposed = workCanonicalSessionState(status: "disposed", runtimeState: "killed", toolType: "codex", exitCode: nil, now: now)
    XCTAssertEqual(disposed.phase, .stopped)

    let userStop = workCanonicalSessionState(status: "disposed", runtimeState: "killed", toolType: "codex", exitCode: 130, now: now)
    XCTAssertEqual(userStop.phase, .stopped)
  }

  func testFailedOnlyForEndedNonCleanExitOrKilled() {
    // Non-zero exit on an ended session → failed.
    let failedExit = workCanonicalSessionState(status: "ended", runtimeState: "exited", toolType: "codex", exitCode: 1, now: now)
    XCTAssertEqual(failedExit.phase, .failed)
    XCTAssertEqual(phaseLabel(failedExit.phase), "Failed")

    // Killed runtime → failed even with a nil exit code.
    let killed = workCanonicalSessionState(status: "ended", runtimeState: "killed", toolType: "codex", exitCode: nil, now: now)
    XCTAssertEqual(killed.phase, .failed)

    // Clean exit (0) → ended: process completion is not a lifecycle declaration.
    let clean = workCanonicalSessionState(status: "ended", runtimeState: "exited", toolType: "codex", exitCode: 0, now: now)
    XCTAssertEqual(clean.phase, .ended)

    // A non-zero exit while still running is ignored (failure is an ended-only
    // signal); the session stays running.
    let runningWithCode = workCanonicalSessionState(status: "running", runtimeState: "running", toolType: "codex", lastActivityAt: iso(now), exitCode: 5, now: now)
    XCTAssertEqual(runningWithCode.phase, .running)
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

    // Exactly at the threshold → stale.
    let exactly = workCanonicalSessionState(
      status: "running",
      runtimeState: "running",
      toolType: "codex",
      lastActivityAt: silentFor(sessionStaleAfterSeconds),
      now: now
    )
    XCTAssertEqual(exactly.phase, .stale)
    XCTAssertTrue(isAttentionPhase(exactly.phase))
    XCTAssertEqual(phaseLabel(exactly.phase), "Stale")
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

  // MARK: - Prompt previews are observational only

  func testPromptPreviewLeavesRunningCalm() {
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
      XCTAssertEqual(state.phase, .running, "prompt: \(prompt)")
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
  }

  // MARK: - Calm states are not attention states

  func testCalmStatesCarryNoAttention() {
    // Fresh running CLI.
    let running = workCanonicalSessionState(status: "running", runtimeState: "running", toolType: "codex", lastActivityAt: iso(now), now: now)
    XCTAssertEqual(running.phase, .running)

    // Idle chat rests between turns → ready.
    let idleChat = workCanonicalSessionState(status: "running", runtimeState: "idle", toolType: "codex-chat", lastActivityAt: iso(now), now: now)
    XCTAssertEqual(idleChat.phase, .ready)

    // Idle CLI → idle (calm, no deterministic ask).
    let idleCli = workCanonicalSessionState(status: "running", runtimeState: "idle", toolType: "codex", lastActivityAt: iso(now), now: now)
    XCTAssertEqual(idleCli.phase, .idle)

    // Ended chat rests, ready for input — never "ended".
    let endedChat = workCanonicalSessionState(status: "ended", runtimeState: "exited", toolType: "codex-chat", exitCode: 0, now: now)
    XCTAssertEqual(endedChat.phase, .ready)
  }

  // MARK: - Chat-tool predicate

  func testChatToolTypePredicate() {
    for chat in ["codex-chat", "claude-chat", "opencode-chat", "cursor", "droid-chat"] {
      XCTAssertTrue(isWorkChatToolType(chat), chat)
    }
    for cli in ["codex", "claude", "droid", nil, ""] {
      XCTAssertFalse(isWorkChatToolType(cli), cli ?? "nil")
    }
  }

  // MARK: - Row wrapper (iOS field mapping)

  func testStatusBadgeMapsChatAwaitingInputToNeedsYou() {
    let session = makeSession(status: "running", runtimeState: "running", toolType: "codex-chat")
    let summary = makeChatSummary(status: "active", awaitingInput: true)
    let badge = workSessionStatusBadge(session: session, summary: summary, now: now)
    XCTAssertEqual(badge?.kind, .needsYou)
  }

  func testRowWrapperMapsChatSummaryPendingItemToNeedsYou() {
    let session = makeSession(status: "running", runtimeState: "running", toolType: "codex-chat")
    let summary = makeChatSummary(
      status: "active",
      awaitingInput: false,
      pendingInputItemId: "provider-question-1"
    )
    XCTAssertEqual(
      workCanonicalSessionState(session: session, summary: summary, now: now).phase,
      .needsYou
    )
  }

  func testRowWrapperMapsHydratedProviderSourceToNeedsYou() {
    var session = makeSession(status: "running", runtimeState: "waiting-input", toolType: "codex-chat")
    session.attentionSource = "provider_structured"
    XCTAssertEqual(
      workCanonicalSessionState(session: session, summary: nil, now: now).phase,
      .needsYou
    )
  }

  func testStatusBadgeSurfacesFailedExit() {
    let session = makeSession(status: "ended", runtimeState: "exited", toolType: "codex", exitCode: 130)
    let badge = workSessionStatusBadge(session: session, summary: nil, now: now)
    XCTAssertEqual(badge?.kind, .failed)
  }

  func testStatusBadgeNilForStoppedDisposedSession() {
    let session = makeSession(status: "disposed", runtimeState: "killed", toolType: "codex", exitCode: 130)
    let badge = workSessionStatusBadge(session: session, summary: nil, now: now)
    XCTAssertNil(badge)
  }

  /// A fresh running session is calm but not silent: it wears the descriptive
  /// "Working" capsule, never one of the three attention identities.
  func testStatusBadgeIsWorkingNotAttentionForFreshRunning() {
    let session = makeSession(status: "running", runtimeState: "running", toolType: "codex", startedAt: iso(now))
    let badge = workSessionStatusBadge(session: session, summary: nil, now: now)
    XCTAssertEqual(badge?.kind, .working)
  }

  // MARK: - One derivation per row

  /// The contract that keeps the three wrappers honest: they are reads of
  /// `workSessionRowPresentation`, not independent derivations. If any of them
  /// ever grows its own copy of the phase or planning fold this fails, which is
  /// the whole point — four derivations per row also meant four `Date()` calls,
  /// so a row rebuilt across the stale or snooze boundary could paint its
  /// capsule from one instant and its status slot from another.
  func testRowPresentationAgreesWithEveryWrapper() {
    var staleSummary = makeChatSummary(status: "active", awaitingInput: false)
    staleSummary.lastActivityAt = silentFor(sessionStaleAfterSeconds + 60)

    let cases: [(name: String, session: TerminalSessionSummary, summary: AgentChatSessionSummary?)] = [
      (
        "needs-you",
        makeSession(status: "running", runtimeState: "running", toolType: "codex-chat"),
        makeChatSummary(status: "active", awaitingInput: true)
      ),
      (
        "running",
        makeSession(status: "running", runtimeState: "running", toolType: "codex", startedAt: iso(now)),
        nil
      ),
      (
        "running + planning",
        makeSession(status: "running", runtimeState: "running", toolType: "codex-chat", startedAt: iso(now)),
        makeChatSummary(status: "active", awaitingInput: false, interactionMode: "plan")
      ),
      (
        "ready",
        makeSession(status: "ended", runtimeState: "exited", toolType: "codex-chat", exitCode: 0),
        nil
      ),
      (
        "failed",
        makeSession(status: "ended", runtimeState: "exited", toolType: "codex", exitCode: 1),
        nil
      ),
      (
        "stale",
        makeSession(status: "running", runtimeState: "running", toolType: "codex-chat"),
        staleSummary
      ),
      (
        "settled",
        makeSession(status: "running", runtimeState: "idle", toolType: "codex-chat", settledAt: iso(now)),
        nil
      ),
      ("snoozed", snoozedSession(untilOffset: 3_600, atOffset: -60), nil),
    ]

    for testCase in cases {
      let row = workSessionRowPresentation(
        session: testCase.session,
        summary: testCase.summary,
        now: now
      )
      XCTAssertEqual(
        row.phase,
        workCanonicalSessionState(session: testCase.session, summary: testCase.summary, now: now).phase,
        testCase.name
      )
      XCTAssertEqual(
        row.badge,
        workSessionStatusBadge(session: testCase.session, summary: testCase.summary, now: now),
        testCase.name
      )
      XCTAssertEqual(
        row.tone,
        workSessionRowTone(session: testCase.session, summary: testCase.summary, now: now),
        testCase.name
      )
      XCTAssertEqual(
        row.status,
        workSessionStatusPresentation(session: testCase.session, summary: testCase.summary, now: now),
        testCase.name
      )
    }
  }

  /// The two states whose capsule and status slot deliberately disagree, so the
  /// agreement test above cannot be satisfied by a wrapper that simply returns
  /// the same thing for everything.
  func testRowPresentationKeepsCapsuleAndSlotIndependent() {
    let settled = workSessionRowPresentation(
      session: makeSession(status: "running", runtimeState: "idle", toolType: "codex-chat", settledAt: iso(now)),
      summary: nil,
      now: now
    )
    XCTAssertEqual(settled.badge?.kind, .done, "a settled row still reads Done out of context")
    XCTAssertNil(settled.status, "but its status slot belongs to the timestamp")

    let snoozed = workSessionRowPresentation(
      session: snoozedSession(untilOffset: 25 * 60, atOffset: -60),
      summary: nil,
      now: now
    )
    XCTAssertEqual(snoozed.badge?.kind, .working, "the capsule reports the state the row is actually in")
    XCTAssertEqual(snoozed.status?.label, "wakes in 25m", "the slot carries the return ticket instead")
  }

  // MARK: - The full status vocabulary
  //
  // `workSessionStatusBadge` is the whole vocabulary the row renders, not just
  // the attention third, and every word and hue in it comes from the shared
  // `ActivityPhaseVocabulary`, not from a second table here.

  func testStatusBadgeCoversTheDescriptiveStates() {
    struct Case {
      let name: String
      let session: TerminalSessionSummary
      let summary: AgentChatSessionSummary?
      let kind: SessionBadgeKind?
      let label: String?
      let tone: ActivityTone
    }

    let cases: [Case] = [
      Case(
        name: "running agent",
        session: makeSession(status: "running", runtimeState: "running", toolType: "codex", startedAt: iso(now)),
        summary: nil,
        kind: .working,
        label: "Working",
        tone: .blue
      ),
      Case(
        name: "planning chat",
        session: makeSession(status: "running", runtimeState: "running", toolType: "codex-chat", startedAt: iso(now)),
        summary: makeChatSummary(status: "active", awaitingInput: false, interactionMode: "plan"),
        kind: .planning,
        label: "Planning",
        tone: .violet
      ),
      Case(
        name: "settled",
        session: makeSession(status: "running", runtimeState: "idle", toolType: "codex-chat", settledAt: iso(now)),
        summary: nil,
        kind: .done,
        label: "Done",
        tone: .emerald
      ),
      Case(
        name: "blocked on the user",
        session: makeSession(
          status: "running",
          runtimeState: "running",
          toolType: "codex-chat",
          pendingInputItemId: "approval-1"
        ),
        summary: nil,
        kind: .needsYou,
        label: "Needs you",
        tone: .amber
      ),
      Case(
        name: "failed",
        session: makeSession(status: "ended", runtimeState: "exited", toolType: "codex", exitCode: 130),
        summary: nil,
        kind: .failed,
        label: "Failed",
        tone: .red
      ),
      Case(
        name: "stale",
        session: makeSession(
          status: "running",
          runtimeState: "running",
          toolType: "codex-chat",
          startedAt: iso(now)
        ),
        summary: makeChatSummary(status: "active", awaitingInput: false),
        kind: .stale,
        label: "Stale",
        tone: .neutral
      ),
    ]

    for testCase in cases {
      var summary = testCase.summary
      if testCase.name == "stale" {
        summary?.lastActivityAt = silentFor(sessionStaleAfterSeconds + 60)
      }
      let badge = workSessionStatusBadge(session: testCase.session, summary: summary, now: now)
      XCTAssertEqual(badge?.kind, testCase.kind, testCase.name)
      XCTAssertEqual(badge?.label, testCase.label, testCase.name)
      XCTAssertEqual(badge?.tone, testCase.tone, testCase.name)
      XCTAssertEqual(
        workSessionRowTone(session: testCase.session, summary: summary, now: now),
        testCase.tone,
        testCase.name
      )
    }
  }

  /// Stopped and ended earn no capsule: the row must not shift layout to say
  /// that nothing is happening. Ready and idle are NOT in that set — they are
  /// finished outcomes nobody has looked at, so they read emerald "Done".
  func testStatusBadgeStaysNilForStoppedAndEnded() {
    let stopped = makeSession(status: "disposed", runtimeState: "killed", toolType: "codex", exitCode: 130)
    let ended = makeSession(status: "ended", runtimeState: "exited", toolType: "codex", exitCode: 0)

    for session in [stopped, ended] {
      XCTAssertNil(workSessionStatusBadge(session: session, summary: nil, now: now))
      XCTAssertEqual(workSessionRowTone(session: session, summary: nil, now: now), .neutral)
    }
  }

  /// The ready/idle drift correction, at the badge level. Before this, both
  /// resolved to a nil badge and a neutral dot, which left a finished session
  /// indistinguishable from a dead one.
  func testReadyAndIdleReadAsDone() {
    let readyChat = makeSession(status: "ended", runtimeState: "exited", toolType: "codex-chat")
    let idleCli = makeSession(status: "running", runtimeState: "idle", toolType: "codex")

    for session in [readyChat, idleCli] {
      let badge = workSessionStatusBadge(session: session, summary: nil, now: now)
      XCTAssertEqual(badge?.kind, .done)
      XCTAssertEqual(badge?.label, "Done")
      XCTAssertEqual(badge?.tone, .emerald)
      XCTAssertEqual(workSessionRowTone(session: session, summary: nil, now: now), .emerald)
    }
  }

  // MARK: - The status slot (`workSessionStatusPresentation`)
  //
  // The row renders ONE status slot, and it needs the two fields `SessionBadge`
  // drops: `showsElapsed` and `prominent`. Prominence drives the recede rule —
  // non-prominent rows fade to 70% — so getting it wrong is what makes a list
  // read as undifferentiated noise.

  /// The states that pull the eye: something wants a human, or something
  /// finished and nobody has looked.
  func testProminentStatesAreTheOnesWantingAHuman() {
    let prominent: [(String, TerminalSessionSummary)] = [
      (
        "needs you",
        makeSession(status: "running", runtimeState: "running", toolType: "codex-chat", pendingInputItemId: "ask-1")
      ),
      ("failed", makeSession(status: "ended", runtimeState: "exited", toolType: "codex", exitCode: 130)),
      ("ready", makeSession(status: "ended", runtimeState: "exited", toolType: "codex-chat")),
      ("idle", makeSession(status: "running", runtimeState: "idle", toolType: "codex")),
    ]

    for (name, session) in prominent {
      let presentation = workSessionStatusPresentation(session: session, summary: nil, now: now)
      XCTAssertEqual(presentation?.prominent, true, name)
    }
  }

  /// Work in flight is deliberately NOT prominent: an agent mid-turn is not yet
  /// your problem, and a state that is true but not actionable makes no claim.
  func testNonProminentStatesRecede() {
    let stale = makeSession(status: "running", runtimeState: "running", toolType: "codex-chat")
    var staleSummary = makeChatSummary(status: "active", awaitingInput: false)
    staleSummary.lastActivityAt = silentFor(sessionStaleAfterSeconds + 60)

    let notProminent: [(String, TerminalSessionSummary, AgentChatSessionSummary?)] = [
      (
        "running",
        makeSession(status: "running", runtimeState: "running", toolType: "codex", startedAt: iso(now)),
        nil
      ),
      ("stale", stale, staleSummary),
      (
        "stopped",
        makeSession(status: "disposed", runtimeState: "killed", toolType: "codex", exitCode: 130),
        nil
      ),
      ("ended", makeSession(status: "ended", runtimeState: "exited", toolType: "codex", exitCode: 0), nil),
    ]

    for (name, session, summary) in notProminent {
      let presentation = workSessionStatusPresentation(session: session, summary: summary, now: now)
      XCTAssertEqual(presentation?.prominent, false, name)
    }
    // `starting` has no constructible session — `workCanonicalSessionState`
    // never returns it — so its prominence is asserted against the shared table
    // the slot reads from.
    XCTAssertFalse(ActivityPhaseVocabulary.presentation(for: workActivityPhase(for: .starting)).prominent)
  }

  /// Settled is the deliberate hole in the vocabulary: desktop returns `null`
  /// so the row's timestamp owns the slot, because in the collapsed tail the
  /// section itself is already the status.
  func testSettledHasNoStatusPresentation() {
    let settled = makeSession(
      status: "running",
      runtimeState: "idle",
      toolType: "codex-chat",
      settledAt: iso(now.addingTimeInterval(-120))
    )
    XCTAssertNil(workSessionStatusPresentation(session: settled, summary: nil, now: now))
    // The out-of-context capsule is unaffected — only the slot goes quiet.
    XCTAssertEqual(workSessionStatusBadge(session: settled, summary: nil, now: now)?.kind, .done)
  }

  /// Snooze is a visibility overlay and an overlay must YIELD to a raised hand,
  /// matching `isSessionFiledAsSnoozed`. Otherwise an "until I'm asked" window
  /// (~100 years) makes the row say "wakes when asked" while it is blocked on
  /// the user right now.
  func testSnoozeYieldsToNeedsYouInTheStatusSlot() {
    var blocked = snoozedSession(
      untilOffset: TimeInterval(workSnoozeIndefiniteDays) * 86_400,
      atOffset: -60,
      status: "running",
      runtimeState: "waiting-input"
    )
    blocked.pendingInputItemId = "item-1"

    let presentation = workSessionStatusPresentation(session: blocked, summary: nil, now: now)
    XCTAssertEqual(presentation?.kind, .needsYou)
    XCTAssertEqual(presentation?.label, "Needs you")
    XCTAssertEqual(presentation?.tone, .amber)
    XCTAssertEqual(presentation?.prominent, true)
    // The raw column read is untouched — the overlay only lost the slot.
    XCTAssertTrue(blocked.isSnoozed(now: now))
  }

  /// For every calm phase the return ticket IS the status, so the wake label
  /// takes the slot and the row recedes.
  func testSnoozedCalmRowShowsItsWakeLabel() {
    let calm = snoozedSession(untilOffset: 1_800, atOffset: -60)

    let presentation = workSessionStatusPresentation(session: calm, summary: nil, now: now)
    XCTAssertEqual(presentation?.label, "wakes in 30m")
    XCTAssertEqual(presentation?.tone, .neutral)
    XCTAssertEqual(presentation?.prominent, false)
    XCTAssertEqual(presentation?.showsElapsed, false)
    // Snoozed is not a badge identity, so it carries no `SessionBadgeKind`.
    XCTAssertNil(presentation?.kind)
  }

  /// Planning is a presentation fact derived from the chat's interaction mode,
  /// exactly as on desktop — it never becomes a canonical phase.
  func testPlanningNeverBecomesACanonicalPhase() {
    let session = makeSession(status: "running", runtimeState: "running", toolType: "codex-chat", startedAt: iso(now))
    let summary = makeChatSummary(status: "active", awaitingInput: false, interactionMode: "plan")

    XCTAssertEqual(workCanonicalSessionState(session: session, summary: summary, now: now).phase, .running)
    XCTAssertEqual(workSessionStatusBadge(session: session, summary: summary, now: now)?.kind, .planning)
  }

  /// A blocked session is amber whatever mode it is in — planning must never
  /// outvote a raised hand.
  func testNeedsYouOutranksPlanning() {
    let session = makeSession(
      status: "running",
      runtimeState: "running",
      toolType: "codex-chat",
      pendingInputItemId: "approval-1"
    )
    let summary = makeChatSummary(status: "active", awaitingInput: false, interactionMode: "plan")

    XCTAssertEqual(workSessionStatusBadge(session: session, summary: summary, now: now)?.kind, .needsYou)
  }

  func testCanonicalPhasesMapOntoTheSharedVocabulary() {
    XCTAssertEqual(workActivityPhase(for: .running), .running)
    XCTAssertEqual(workActivityPhase(for: .starting), .starting)
    XCTAssertEqual(workActivityPhase(for: .needsYou), .needsYou)
    XCTAssertEqual(workActivityPhase(for: .failed), .failed)
    XCTAssertEqual(workActivityPhase(for: .stale), .stale)
    XCTAssertEqual(workActivityPhase(for: .settled), .completed)
    // Ready and idle are emerald "Done", matching desktop's `PHASE_PRESENTATION`.
    // They used to resolve to the neutral "Ready"/"Idle" entries, which is the
    // drift this corrects: a finished-but-unlooked-at row is an outcome, and
    // outcomes are emerald.
    XCTAssertEqual(workActivityPhase(for: .ready), .completed)
    XCTAssertEqual(workActivityPhase(for: .idle), .completed)
    XCTAssertEqual(workActivityPhase(for: .stopped), .unrecognized("stopped"))
    XCTAssertEqual(workActivityPhase(for: .ended), .unrecognized("ended"))
  }

  /// The one-hue rule, from the other direction: the coarse status string every
  /// roster surface holds must not be able to paint amber for a resting chat.
  func testChatStatusToneSpendsAmberOnlyOnNeedsYou() {
    XCTAssertEqual(workChatStatusTone("awaiting-input"), .amber)
    XCTAssertEqual(workChatStatusTone("active"), .blue)
    XCTAssertEqual(workChatStatusTone("idle"), .neutral)
    XCTAssertEqual(workChatStatusTone("ended"), .neutral)
  }

  func testWorkSessionRowPreviewUsesFreshOutputBeforeSummaryAndGoal() {
    var session = makeSession(
      status: "running",
      runtimeState: "idle",
      toolType: "claude-chat",
      lastOutputPreview: "\u{001B}[32mLegacy output\u{001B}[0m"
    )
    session.goal = "Fallback goal"
    session.summary = "Older session summary"
    var summary = makeChatSummary(status: "paused", awaitingInput: false)
    summary.title = "Session"
    summary.goal = "Older chat goal"
    summary.summary = "Older chat summary"
    summary.lastOutputPreview = "\u{001B}[33mFresh provider output\u{001B}[0m"

    XCTAssertEqual(
      workSessionRowPreviewSource(session: session, chatSummary: summary, isSettled: false)?.text,
      "Fresh provider output"
    )

    summary.lastOutputPreview = nil
    session.lastOutputPreview = nil
    XCTAssertEqual(
      workSessionRowPreviewSource(session: session, chatSummary: summary, isSettled: false)?.text,
      "Older chat summary"
    )

    summary.summary = nil
    session.summary = nil
    XCTAssertEqual(
      workSessionRowPreviewSource(session: session, chatSummary: summary, isSettled: false)?.text,
      "Older chat goal"
    )
  }

  func testWorkSessionRowPreviewKeepsAskAndStatusNoteAboveOutput() {
    var session = makeSession(
      status: "running",
      runtimeState: "idle",
      toolType: "droid-chat",
      lastOutputPreview: "Provider output"
    )
    session.statusNote = "Running focused tests"
    XCTAssertEqual(
      workSessionRowPreviewSource(session: session, chatSummary: nil, isSettled: false)?.text,
      "Running focused tests"
    )
    XCTAssertEqual(
      workSessionRowPreviewSource(session: session, chatSummary: nil, isSettled: true)?.text,
      "Done: Running focused tests"
    )

    session.attentionRequestedAt = iso(now)
    session.attentionMessage = "Choose the release target"
    XCTAssertEqual(
      workSessionRowPreviewSource(session: session, chatSummary: nil, isSettled: true)?.text,
      "Choose the release target"
    )
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
    status: String,
    runtimeState: String,
    toolType: String?,
    exitCode: Int? = nil,
    pendingInputItemId: String? = nil,
    lastOutputPreview: String? = nil,
    startedAt: String? = nil,
    settledAt: String? = nil
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
      settledAt: settledAt,
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

  private func makeChatSummary(
    status: String,
    awaitingInput: Bool?,
    pendingInputItemId: String? = nil,
    interactionMode: String? = nil
  ) -> AgentChatSessionSummary {
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
      interactionMode: interactionMode,
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
      pendingInputItemId: pendingInputItemId,
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

  // MARK: - Settle override tri-state (desktop sessionCanonicalState.ts parity)
  //
  // Mirrors `describe("settle override tri-state")`.

  func testNullOverrideLeavesCleanExitEnded() {
    XCTAssertEqual(
      cleanExitState(settleOverride: nil).phase, .ended,
      "no override: a clean exit remains ended"
    )
    XCTAssertEqual(cleanExitState(settleOverride: "").phase, .ended, "blank override reads as none")
    XCTAssertEqual(
      cleanExitState(settleOverride: "nonsense").phase, .ended,
      "unknown override values must not invent a state"
    )
  }

  func testActiveOverrideKeepsCleanExitEnded() {
    let result = cleanExitState(settleOverride: "active")
    XCTAssertEqual(result.phase, .ended)
  }

  func testActiveOverrideAlsoSuppressesDeclaredSettle() {
    XCTAssertEqual(
      cleanExitState(settledAt: "2026-07-06T11:00:00.000Z", settleOverride: "active").phase,
      .ended
    )
  }

  func testSettledOverrideBehavesLikeDeclaredSettleWithoutSettledAt() {
    XCTAssertEqual(
      workCanonicalSessionState(
        status: "detached", runtimeState: nil, toolType: "codex",
        exitCode: 2, settleOverride: "settled", now: now
      ).phase,
      .settled,
      "a 'settled' override outranks the non-clean exit failure"
    )
    XCTAssertEqual(
      workCanonicalSessionState(
        status: "running", runtimeState: "idle", toolType: "claude-chat",
        settleOverride: "settled", now: now
      ).phase,
      .settled
    )
  }

  func testSettledOverrideIsStillOnlyHonoredAtRest() {
    XCTAssertEqual(
      workCanonicalSessionState(
        status: "running", runtimeState: "running", toolType: "claude-chat",
        lastActivityAt: iso(now), settleOverride: "settled", now: now
      ).phase,
      .running
    )
  }

  func testDeterministicAttentionStillOutranksEveryOverride() {
    XCTAssertEqual(
      workCanonicalSessionState(
        status: "running", runtimeState: "idle", toolType: "codex",
        pendingInputItemId: "i-1", settleOverride: "settled", now: now
      ).phase,
      .needsYou,
      "an escalated ask outranks a 'settled' override"
    )
    XCTAssertEqual(
      workCanonicalSessionState(
        status: "running", runtimeState: "idle", toolType: "codex",
        settleOverride: "active", attentionRequestedAt: iso(now), now: now
      ).phase,
      .needsYou,
      "an escalated ask outranks an 'active' override too"
    )
  }

  /// The desktop `cleanExit` fixture: a detached PTY that exited 0.
  private func cleanExitState(
    settledAt: String? = nil,
    settleOverride: String? = nil
  ) -> CanonicalSessionState {
    workCanonicalSessionState(
      status: "detached",
      runtimeState: "exited",
      toolType: "codex",
      exitCode: 0,
      settledAt: settledAt,
      settleOverride: settleOverride,
      now: now
    )
  }

  // MARK: - Snooze is a visibility overlay, not a phase

  func testSnoozeNeverChangesTheCanonicalPhase() {
    // Snooze columns are deliberately absent from the canonical inputs; this
    // asserts the contract holds for the row a snoozed session represents.
    let session = snoozedSession(
      untilOffset: 60,
      atOffset: -60,
      status: "running",
      runtimeState: "running",
      lastOutputPreview: "compiling..."
    )
    XCTAssertEqual(
      workCanonicalSessionState(session: session, summary: nil, now: now).phase,
      .running
    )
    XCTAssertTrue(session.isSnoozed(now: now))
  }

  func testSnoozeExpiryIsDerivedFromSnoozedUntilWithNoScheduler() {
    let until = now.addingTimeInterval(60)
    let state = SessionSnoozeState(snoozedUntil: iso(until), snoozedAt: iso(now.addingTimeInterval(-60)))
    XCTAssertTrue(isSessionSnoozed(state, now: now))
    XCTAssertFalse(isSessionSnoozeExpired(state, now: now))

    // The deadline itself, and one millisecond past it, flip both — purely
    // from the clock, with no timer anywhere.
    XCTAssertFalse(isSessionSnoozed(state, now: until))
    XCTAssertTrue(isSessionSnoozeExpired(state, now: until))
    XCTAssertFalse(isSessionSnoozed(state, now: until.addingTimeInterval(0.001)))
    XCTAssertTrue(isSessionSnoozeExpired(state, now: until.addingTimeInterval(0.001)))
  }

  func testMissingOrUnparseableDeadlineIsNotSnoozed() {
    XCTAssertFalse(isSessionSnoozed(SessionSnoozeState(), now: now))
    XCTAssertFalse(isSessionSnoozed(SessionSnoozeState(snoozedUntil: nil), now: now))
    XCTAssertFalse(isSessionSnoozed(SessionSnoozeState(snoozedUntil: "   "), now: now))
    XCTAssertFalse(isSessionSnoozed(SessionSnoozeState(snoozedUntil: "not-a-date"), now: now))
    XCTAssertFalse(isSessionSnoozeExpired(SessionSnoozeState(snoozedUntil: "not-a-date"), now: now))
  }

  // MARK: - Snooze filing yields to a raised hand
  //
  // Regression: an "Until I'm asked" snooze (~100 years) hid a needs-you row
  // forever. Every early-wake trigger was chat-only, and a tracked CLI row's
  // needs-input state is explicit or provider-structured, so the filing rule
  // must bring a genuinely blocked row back.

  /// Snoozed "until I'm asked": the deadline that used to bury a blocked row.
  private var indefiniteSnooze: SessionSnoozeState {
    SessionSnoozeState(
      snoozedUntil: iso(now.addingTimeInterval(TimeInterval(workSnoozeIndefiniteDays) * 86_400)),
      snoozedAt: iso(now.addingTimeInterval(-60))
    )
  }

  func testSnoozedNeedsYouRowIsNotFiledAsSnoozed() {
    XCTAssertFalse(isSessionFiledAsSnoozed(indefiniteSnooze, phase: .needsYou, now: now))

    // A tracked CLI row with an explicit pending item is actionable.
    var blocked = snoozedSession(
      untilOffset: TimeInterval(workSnoozeIndefiniteDays) * 86_400,
      atOffset: -60,
      status: "running",
      runtimeState: "waiting-input"
    )
    blocked.pendingInputItemId = "item-1"
    XCTAssertEqual(
      workCanonicalSessionState(session: blocked, summary: nil, now: now).phase,
      .needsYou
    )
    XCTAssertFalse(blocked.isFiledAsSnoozed(summary: nil, now: now))

    // The RAW column read is unchanged — chips, menus, and the wake label still
    // see a snoozed row, independent of where the list files it.
    XCTAssertTrue(blocked.isSnoozed(now: now))
    XCTAssertTrue(isSessionSnoozed(indefiniteSnooze, now: now))
  }

  func testEveryCalmPhaseIsStillFiledAsSnoozed() {
    for phase in [
      CanonicalSessionPhase.starting, .running, .stale, .ready, .idle,
      .failed, .stopped, .ended, .settled
    ] {
      XCTAssertTrue(
        isSessionFiledAsSnoozed(indefiniteSnooze, phase: phase, now: now),
        "phase \(phase) must still be hidden by the overlay"
      )
    }
    // No phase known (callers that only hold the columns) files as snoozed too.
    XCTAssertTrue(isSessionFiledAsSnoozed(indefiniteSnooze, phase: nil, now: now))

    let calm = snoozedSession(untilOffset: 3_600, atOffset: -60)
    XCTAssertTrue(calm.isFiledAsSnoozed(summary: nil, now: now))
  }

  func testARowThatIsNotSnoozedIsNeverFiledAsSnoozed() {
    XCTAssertFalse(isSessionFiledAsSnoozed(SessionSnoozeState(), phase: .running, now: now))
    XCTAssertFalse(isSessionFiledAsSnoozed(SessionSnoozeState(), phase: .needsYou, now: now))
    // A lapsed deadline: expiry is derived, so the row is simply awake.
    let lapsed = SessionSnoozeState(
      snoozedUntil: iso(now.addingTimeInterval(-1)),
      snoozedAt: iso(now.addingTimeInterval(-3_600))
    )
    XCTAssertFalse(isSessionFiledAsSnoozed(lapsed, phase: .running, now: now))
  }

  func testWorkSessionGroupsKeepASnoozedNeedsYouRowInYourMove() {
    var blocked = snoozedSession(
      untilOffset: TimeInterval(workSnoozeIndefiniteDays) * 86_400,
      atOffset: -60,
      status: "running",
      runtimeState: "waiting-input"
    )
    blocked.id = "s-blocked"
    blocked.pendingInputItemId = "item-1"
    var calm = snoozedSession(untilOffset: 3_600, atOffset: -60)
    calm.id = "s-calm"

    let groups = workSessionGroups(
      organization: .byStatus,
      sessions: [blocked, calm],
      chatSummaries: [:],
      archivedSessionIds: [],
      orderedLanes: [],
      now: now
    )

    XCTAssertEqual(groups.map(\.id), ["status:awaiting", workSnoozedSectionId])
    XCTAssertEqual(groups.first?.sessions.map(\.id), ["s-blocked"])
    XCTAssertEqual(groups.last?.sessions.map(\.id), ["s-calm"])
  }

  func testStatusGroupUsesTheSharedWorkingVocabulary() {
    let running = makeSession(status: "running", runtimeState: "running", toolType: "claude-chat")
    let groups = workSessionGroupsByStatus(
      sessions: [running],
      chatSummaries: [:],
      archivedSessionIds: []
    )

    XCTAssertEqual(groups.map(\.id), ["status:running"])
    XCTAssertEqual(groups.first?.label, "Working")
    XCTAssertEqual(groups.first?.sessions.map(\.id), [running.id])
  }

  // MARK: - Re-deriving the groups when a deadline lapses
  //
  // Expiry stays derived from the clock, but `WorkRootScreen` CACHES the
  // grouped output, so it has to be told when to re-derive. These cover the
  // scheduling input for that single wait.

  // MARK: - Quiet lane sections

  func testLaneGroupIsQuietOnlyWhenEverySessionIsSettled() {
    var settled = makeSession(status: "completed", runtimeState: "idle", toolType: "claude-chat")
    settled.id = "s-settled"
    settled.settledAt = iso(now.addingTimeInterval(-120))
    var alsoSettled = makeSession(status: "completed", runtimeState: "idle", toolType: "claude-chat")
    alsoSettled.id = "s-settled-2"
    alsoSettled.settledAt = iso(now.addingTimeInterval(-60))

    let lane = makeLane(id: "lane-1", name: "Lane 1")
    let quietGroups = workSessionGroups(
      organization: .byLane,
      sessions: [settled, alsoSettled],
      chatSummaries: [:],
      archivedSessionIds: [],
      orderedLanes: [lane],
      now: now
    )
    XCTAssertEqual(quietGroups.map(\.id), ["lane:lane-1"])
    XCTAssertTrue(quietGroups[0].isQuiet)
    XCTAssertEqual(quietGroups[0].quietOpenSectionId, "lane-open:lane-1")

    // One live row is enough to keep the whole lane loud.
    var running = makeSession(status: "running", runtimeState: "running", toolType: "claude-chat")
    running.id = "s-running"
    let loudGroups = workSessionGroups(
      organization: .byLane,
      sessions: [settled, running],
      chatSummaries: [:],
      archivedSessionIds: [],
      orderedLanes: [lane],
      now: now
    )
    XCTAssertEqual(loudGroups.map(\.id), ["lane:lane-1"])
    XCTAssertFalse(loudGroups[0].isQuiet)
  }

  func testLaneGroupWithAnAttentionSessionIsNeverQuiet() {
    // A row blocked on the user must never be folded behind a thin header.
    var settled = makeSession(status: "completed", runtimeState: "idle", toolType: "claude-chat")
    settled.id = "s-settled"
    settled.settledAt = iso(now.addingTimeInterval(-120))
    var blocked = makeSession(
      status: "running",
      runtimeState: "running",
      toolType: "claude-chat",
      pendingInputItemId: "ask-1"
    )
    blocked.id = "s-blocked"

    let groups = workSessionGroups(
      organization: .byLane,
      sessions: [settled, blocked],
      chatSummaries: [:],
      archivedSessionIds: [],
      orderedLanes: [makeLane(id: "lane-1", name: "Lane 1")],
      now: now
    )

    XCTAssertEqual(groups.count, 1)
    XCTAssertFalse(groups[0].isQuiet)
  }

  func testFilteredLaneGroupUsesFullRosterForQuietness() {
    var settled = makeSession(status: "completed", runtimeState: "idle", toolType: "claude-chat")
    settled.id = "s-visible-settled"
    settled.settledAt = iso(now.addingTimeInterval(-120))
    var hiddenNeedsYou = makeSession(
      status: "running",
      runtimeState: "running",
      toolType: "claude-chat",
      pendingInputItemId: "approval-1"
    )
    hiddenNeedsYou.id = "s-hidden-needs-you"

    let groups = workSessionGroups(
      organization: .byLane,
      sessions: [settled],
      quietReferenceSessions: [settled, hiddenNeedsYou],
      chatSummaries: [:],
      archivedSessionIds: [],
      orderedLanes: [makeLane(id: "lane-1", name: "Lane 1")],
      now: now
    )

    XCTAssertEqual(groups.count, 1)
    XCTAssertEqual(groups[0].sessions.map(\.id), [settled.id])
    XCTAssertFalse(groups[0].isQuiet)
  }

  func testOnlyTheTrailingShelvesAreQuietInStatusAndTimeGroups() {
    // Quiet used to be a lane-folder affordance only, and this test used to
    // assert that status/time modes produced no quiet group at all. The quiet
    // zone changed that on purpose: those two modes now close with Snoozed and
    // Settled shelves, which ARE quiet so they render the thin collapsed form.
    //
    // The invariant that survives — and the one worth pinning — is narrower:
    // quietness is confined to those trailing shelves. An ordinary section
    // ("Your move", "Working", a time bucket) must never fold itself away.
    var settled = makeSession(status: "completed", runtimeState: "idle", toolType: "claude-chat")
    settled.id = "s-settled"
    settled.settledAt = iso(now.addingTimeInterval(-120))

    var running = makeSession(status: "running", runtimeState: "running", toolType: "claude-chat")
    running.id = "s-running"

    for organization in [WorkSessionOrganization.byStatus, .byTime] {
      let groups = workSessionGroups(
        organization: organization,
        sessions: [settled, running],
        chatSummaries: [:],
        archivedSessionIds: [],
        orderedLanes: [makeLane(id: "lane-1", name: "Lane 1")],
        now: now
      )

      for group in groups where group.isQuiet {
        XCTAssertTrue(
          group.isShelf,
          "\(organization) marked non-shelf section \(group.id) quiet"
        )
      }

      // The settled row is lifted out of its ordinary section onto the shelf.
      let settledShelf = groups.first { $0.isShelf && $0.sessions.contains { $0.id == settled.id } }
      XCTAssertNotNil(settledShelf, "\(organization) did not file the settled row onto a shelf")
      XCTAssertTrue(settledShelf?.isQuiet == true)

      // …and the live row stays in a normal, non-quiet section.
      let runningGroup = groups.first { $0.sessions.contains { $0.id == running.id } }
      XCTAssertNotNil(runningGroup)
      XCTAssertFalse(runningGroup?.isQuiet ?? true, "\(organization) folded a live row into a shelf")
    }
  }

  // MARK: - Scoped Work view state

  func testWorkViewStateScopeKeyIsPerProjectAndHost() {
    XCTAssertNil(WorkViewStateStore.scopeKey(projectId: nil, hostIdentity: "host-a"))
    XCTAssertNil(WorkViewStateStore.scopeKey(projectId: "  ", hostIdentity: "host-a"))
    XCTAssertEqual(WorkViewStateStore.scopeKey(projectId: "proj", hostIdentity: nil), "proj")
    // The same project id on two machines is two different views.
    XCTAssertNotEqual(
      WorkViewStateStore.scopeKey(projectId: "proj", hostIdentity: "host-a"),
      WorkViewStateStore.scopeKey(projectId: "proj", hostIdentity: "host-b")
    )
  }

  func testWorkViewStateRoundTripsPerScopeAndDefaultsWhenAbsent() {
    let scopeA = WorkViewStateStore.scopeKey(projectId: "proj-a", hostIdentity: "host-1")
    let scopeB = WorkViewStateStore.scopeKey(projectId: "proj-b", hostIdentity: "host-1")
    var stateA = WorkProjectViewState.empty
    stateA.laneFilter = "lane-7"
    stateA.collapsedSectionIds = "lane:lane-7,status:settled"
    stateA.organization = WorkSessionOrganization.byStatus.rawValue

    WorkViewStateStore.save(stateA, scope: scopeA)

    XCTAssertEqual(WorkViewStateStore.load(scope: scopeA), stateA)
    // Collapse ids are `lane:<laneId>`, so leaking them across projects could
    // collapse an unrelated project's lane. A untouched scope stays default.
    XCTAssertEqual(WorkViewStateStore.load(scope: scopeB), .empty)
    XCTAssertEqual(WorkViewStateStore.load(scope: nil), .empty)

    // A nil scope must never clobber a real project's record.
    WorkViewStateStore.save(stateA, scope: nil)
    XCTAssertEqual(WorkViewStateStore.load(scope: scopeA), stateA)
  }

  func testEndingDeeplinkFramingRestoresUnrelatedSavedViewState() {
    let saved = WorkProjectViewState(
      searchText: "saved search",
      laneFilter: "lane-7",
      statusFilter: WorkSessionStatusFilter.ended.rawValue,
      organization: WorkSessionOrganization.byStatus.rawValue,
      collapsedSectionIds: "lane:lane-7,status:settled"
    )
    let transient = WorkProjectViewState(
      searchText: "",
      laneFilter: "all",
      statusFilter: WorkSessionStatusFilter.all.rawValue,
      organization: WorkSessionOrganization.byLane.rawValue,
      collapsedSectionIds: ""
    )

    var restored = workViewStateRestoringUserControl(savedBase: saved, current: transient)
    restored.statusFilter = WorkSessionStatusFilter.all.rawValue

    XCTAssertEqual(restored.searchText, saved.searchText)
    XCTAssertEqual(restored.organization, saved.organization)
    XCTAssertEqual(restored.collapsedSectionIds, saved.collapsedSectionIds)
    XCTAssertEqual(restored.statusFilter, WorkSessionStatusFilter.all.rawValue)
  }

  func testLaneDeeplinkFramingExpandsOrdinaryAndQuietLaneGroups() {
    let saved: Set<String> = [
      "lane:lane-7",
      "lane:other",
      "status:settled",
    ]

    let framed = workCollapsedSectionIdsFramingLane(saved, laneId: "lane-7")

    XCTAssertFalse(framed.contains("lane:lane-7"), "ordinary lane group must be expanded")
    XCTAssertTrue(framed.contains("lane-open:lane-7"), "quiet lane group must be expanded")
    XCTAssertTrue(framed.contains("lane:other"), "unrelated lane state must be preserved")
    XCTAssertTrue(framed.contains("status:settled"), "unrelated section state must be preserved")
    XCTAssertTrue(saved.contains("lane:lane-7"), "transient framing must not mutate the saved base")
  }

  func testGroupsRefileASnoozedRowOnceItsDeadlineLapses() {
    var calm = snoozedSession(untilOffset: 3_600, atOffset: -60)
    calm.id = "s-calm"

    func groupIds(now moment: Date) -> [String] {
      workSessionGroups(
        organization: .byStatus,
        sessions: [calm],
        chatSummaries: [:],
        archivedSessionIds: [],
        orderedLanes: [],
        now: moment
      ).map(\.id)
    }

    let deadline = now.addingTimeInterval(3_600)
    XCTAssertEqual(groupIds(now: now), [workSnoozedSectionId])
    // Same session list, only the clock moved: the row leaves the Snoozed tail
    // on its own. This is exactly what the cached presentation misses without a
    // refresh armed at the deadline. The bucket it lands in is the canonical
    // phase's business — all that matters here is that it is no longer parked.
    XCTAssertFalse(groupIds(now: deadline).contains(workSnoozedSectionId))
    XCTAssertFalse(groupIds(now: deadline.addingTimeInterval(1)).contains(workSnoozedSectionId))
    XCTAssertEqual(groupIds(now: deadline).count, 1)

    // The screen targets that deadline; the wait itself is clamped to the tick
    // ceiling and re-armed, and disarms entirely once the row is awake.
    XCTAssertEqual(nextSessionSnoozeDeadline([calm], now: now), deadline)
    XCTAssertEqual(
      workSnoozeRegroupDelay(sessions: [calm], now: now) ?? -1,
      workSnoozeTickMaxDelay,
      accuracy: 0.001
    )
    XCTAssertEqual(
      workSnoozeRegroupDelay(sessions: [calm], now: deadline.addingTimeInterval(-90)) ?? -1,
      90,
      accuracy: 0.001
    )
    XCTAssertNil(nextSessionSnoozeDeadline([calm], now: deadline))
    XCTAssertNil(workSnoozeRegroupDelay(sessions: [calm], now: deadline))
  }

  func testNoSnoozedRowArmsNoRefreshAtAll() {
    let awake = snoozedSession(untilOffset: nil, atOffset: nil)
    let lapsed = snoozedSession(untilOffset: -1, atOffset: -3_600)
    XCTAssertNil(nextSessionSnoozeDeadline([], now: now))
    XCTAssertNil(nextSessionSnoozeDeadline([awake, lapsed], now: now))
    XCTAssertNil(workSnoozeRegroupDelay(sessions: [], now: now))
    XCTAssertNil(workSnoozeRegroupDelay(sessions: [awake, lapsed], now: now))
  }

  func testRefreshIsArmedAtTheSoonestDeadlineOnly() {
    var far = snoozedSession(untilOffset: 900, atOffset: -60)
    far.id = "s-far"
    var near = snoozedSession(untilOffset: 120, atOffset: -60)
    near.id = "s-near"
    var lapsed = snoozedSession(untilOffset: -30, atOffset: -3_600)
    lapsed.id = "s-lapsed"
    var unparseable = snoozedSession(untilOffset: nil, atOffset: nil)
    unparseable.id = "s-bad"
    unparseable.snoozedUntil = "not-a-date"

    let sessions = [far, near, lapsed, unparseable]
    XCTAssertEqual(nextSessionSnoozeDeadline(sessions, now: now), now.addingTimeInterval(120))
    XCTAssertEqual(workSnoozeRegroupDelay(sessions: sessions, now: now) ?? -1, 120, accuracy: 0.001)
  }

  func testIndefiniteSnoozeIsClampedInsteadOfScheduledLiterally() {
    // "Until I'm asked" parks the deadline ~100 years out. Waiting that
    // literally is not a wait — it must clamp to the tick ceiling and re-arm.
    let indefinite = snoozedSession(
      untilOffset: TimeInterval(workSnoozeIndefiniteDays) * 86_400,
      atOffset: -60
    )
    let delay = workSnoozeRegroupDelay(sessions: [indefinite], now: now)
    XCTAssertEqual(delay ?? -1, workSnoozeTickMaxDelay, accuracy: 0.001)
    XCTAssertLessThanOrEqual(delay ?? .infinity, workSnoozeTickMaxDelay)

    // A deadline already sitting on `now` still yields a positive wait rather
    // than a zero-delay spin.
    let boundary = snoozedSession(untilOffset: 0.05, atOffset: -60)
    let boundaryDelay = workSnoozeRegroupDelay(sessions: [boundary], now: now)
    XCTAssertNotNil(boundaryDelay)
    XCTAssertGreaterThan(boundaryDelay ?? 0, 0)
    XCTAssertLessThanOrEqual(boundaryDelay ?? .infinity, workSnoozeTickMaxDelay)
  }

  // MARK: - Early wake: the newer-than-snoozed_at error comparison

  func testDoesNotWakeOnTheErrorTheSnoozeWasTakenOnTopOf() {
    // This is the whole point: an older/equal error must not resurrect the
    // row, otherwise snooze does nothing at all.
    let state = earlyWakeState
    XCTAssertFalse(isWakingSessionError(state, errorAt: "2026-07-06T10:59:59.999Z"))
    XCTAssertFalse(isWakingSessionError(state, errorAt: earlyWakeSnoozedAt))
  }

  func testWakesOnAnErrorStrictlyNewerThanSnoozedAt() {
    XCTAssertTrue(isWakingSessionError(earlyWakeState, errorAt: "2026-07-06T11:00:00.001Z"))
    XCTAssertTrue(isWakingSessionError(earlyWakeState, errorAt: "2026-07-06T12:00:00.000Z"))
  }

  func testEarlyWakeFailsClosedWithoutAUsableTimestampOnEitherSide() {
    XCTAssertFalse(isWakingSessionError(earlyWakeState, errorAt: nil))
    XCTAssertFalse(isWakingSessionError(earlyWakeState, errorAt: "not-a-date"))
    XCTAssertFalse(
      isWakingSessionError(
        SessionSnoozeState(snoozedUntil: earlyWakeSnoozedUntil),
        errorAt: "2026-07-06T12:00:00.000Z"
      ),
      "an unknown baseline must not resurrect every historical error"
    )
    XCTAssertFalse(
      isWakingSessionError(
        SessionSnoozeState(snoozedUntil: earlyWakeSnoozedUntil, snoozedAt: "garbage"),
        errorAt: "2026-07-06T12:00:00.000Z"
      )
    )
  }

  // MARK: - resolveSessionWakeReason

  func testUnsnoozedRowNeverReportsAWake() {
    XCTAssertNil(
      resolveSessionWakeReason(
        SessionSnoozeState(),
        signals: SessionWakeSignals(hasPendingInput: true),
        now: wakeReasonNow
      )
    )
    XCTAssertNil(
      resolveSessionWakeReason(
        SessionSnoozeState(snoozedAt: earlyWakeSnoozedAt),
        signals: SessionWakeSignals(turnCompleted: true),
        now: wakeReasonNow
      )
    )
  }

  func testStaysAsleepWithNoQualifyingSignal() {
    XCTAssertNil(resolveSessionWakeReason(activeSnooze, now: wakeReasonNow))
    XCTAssertNil(
      resolveSessionWakeReason(
        activeSnooze,
        signals: SessionWakeSignals(errorAt: earlyWakeSnoozedAt),
        now: wakeReasonNow
      )
    )
  }

  func testReportsEachHandRaiseAheadOfPlainTimerExpiry() {
    XCTAssertEqual(
      resolveSessionWakeReason(activeSnooze, signals: SessionWakeSignals(hasPendingInput: true), now: wakeReasonNow),
      .needsYou
    )
    XCTAssertEqual(
      resolveSessionWakeReason(
        activeSnooze,
        signals: SessionWakeSignals(errorAt: "2026-07-06T11:45:00.000Z"),
        now: wakeReasonNow
      ),
      .error
    )
    XCTAssertEqual(
      resolveSessionWakeReason(activeSnooze, signals: SessionWakeSignals(turnCompleted: true), now: wakeReasonNow),
      .turnComplete
    )
    XCTAssertEqual(
      resolveSessionWakeReason(expiredSnooze, signals: SessionWakeSignals(turnCompleted: true), now: wakeReasonNow),
      .turnComplete,
      "a hand-raise outranks plain expiry even after the deadline"
    )
  }

  func testFallsBackToDerivedTimerExpiry() {
    XCTAssertEqual(resolveSessionWakeReason(expiredSnooze, now: wakeReasonNow), .timer)
    XCTAssertEqual(
      resolveSessionWakeReason(
        expiredSnooze,
        signals: SessionWakeSignals(errorAt: earlyWakeSnoozedAt),
        now: wakeReasonNow
      ),
      .timer,
      "the snoozed-on error is still not a hand-raise; the timer is the reason"
    )
  }

  // Fixtures mirroring the TS suite's fixed instants exactly.
  private let earlyWakeSnoozedAt = "2026-07-06T11:00:00.000Z"
  private let earlyWakeSnoozedUntil = "2026-07-06T13:00:00.000Z"
  private var earlyWakeState: SessionSnoozeState {
    SessionSnoozeState(snoozedUntil: earlyWakeSnoozedUntil, snoozedAt: earlyWakeSnoozedAt)
  }
  private var activeSnooze: SessionSnoozeState {
    SessionSnoozeState(snoozedUntil: "2026-07-06T13:00:00.000Z", snoozedAt: earlyWakeSnoozedAt)
  }
  private var expiredSnooze: SessionSnoozeState {
    SessionSnoozeState(snoozedUntil: "2026-07-06T11:30:00.000Z", snoozedAt: earlyWakeSnoozedAt)
  }
  /// The TS suite's NOW — 2026-07-06T12:00:00.000Z.
  private var wakeReasonNow: Date {
    ISO8601DateFormatter().date(from: "2026-07-06T12:00:00Z")!
  }

  // MARK: - Woke marker + settle override projection on the row model

  func testWokeMarkerPrefersThePersistedReason() {
    var session = snoozedSession(untilOffset: nil, atOffset: nil)
    session.wokeAt = iso(now)
    session.wokeReason = "turn_complete"
    XCTAssertEqual(session.wokeMarker(now: now), .turnComplete)

    session.wokeReason = "TIMER"
    XCTAssertEqual(session.wokeMarker(now: now), .timer, "persisted reason parse is case-insensitive")

    session.wokeReason = nil
    XCTAssertEqual(session.wokeMarker(now: now), .timer, "a stamped wake with no reason is a lapsed snooze")

    session.wokeReason = "who-knows"
    XCTAssertNil(session.wokeMarker(now: now), "an unknown reason is no marker, not an invented state")

    session.wokeAt = nil
    session.wokeReason = "manual"
    XCTAssertNil(session.wokeMarker(now: now), "a reason without a timestamp is not a marker")
  }

  /// Expiry is derived, so nothing ever writes a marker for a snooze that just
  /// lapsed — the row still has to explain itself.
  func testWokeMarkerFallsBackToTheDerivedTimerWake() {
    let lapsed = snoozedSession(untilOffset: -60, atOffset: -3600)
    XCTAssertEqual(lapsed.wokeMarker(now: now), .timer)

    let stillAsleep = snoozedSession(untilOffset: 3600, atOffset: -60)
    XCTAssertNil(stillAsleep.wokeMarker(now: now), "an open snooze window has not woken")

    var lapsedWithAsk = snoozedSession(untilOffset: -60, atOffset: -3600)
    lapsedWithAsk.pendingInputItemId = "item-1"
    XCTAssertEqual(
      lapsedWithAsk.wokeMarker(now: now), .needsYou,
      "a hand-raise outranks plain expiry in the marker copy too"
    )
  }

  func testResolvedSettleOverrideParsesTolerantly() {
    var session = snoozedSession(untilOffset: nil, atOffset: nil)
    XCTAssertNil(session.resolvedSettleOverride)
    session.settleOverride = "  Active "
    XCTAssertEqual(session.resolvedSettleOverride, .active)
    session.settleOverride = "settled"
    XCTAssertEqual(session.resolvedSettleOverride, .settled)
    session.settleOverride = "paused"
    XCTAssertNil(session.resolvedSettleOverride)
  }

  // MARK: - Snooze duration presets

  func testSnoozeDurationDeadlinesResolveAgainstTheUsersCalendar() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    let morning = calendar.date(from: DateComponents(year: 2026, month: 7, day: 6, hour: 8))!

    XCTAssertEqual(
      WorkSnoozeDuration.oneHour.deadline(from: morning, calendar: calendar),
      morning.addingTimeInterval(3600)
    )

    let evening = XCTUnwrap2(WorkSnoozeDuration.thisEvening.deadline(from: morning, calendar: calendar))
    XCTAssertEqual(calendar.component(.hour, from: evening), 18)
    XCTAssertTrue(calendar.isDate(evening, inSameDayAs: morning))

    let tomorrow = XCTUnwrap2(WorkSnoozeDuration.tomorrowMorning.deadline(from: morning, calendar: calendar))
    XCTAssertEqual(calendar.component(.hour, from: tomorrow), 9)
    XCTAssertEqual(
      calendar.dateComponents([.day], from: calendar.startOfDay(for: morning), to: calendar.startOfDay(for: tomorrow)).day,
      1,
      "tomorrow 9am is the next calendar day in the user's own time zone"
    )

    let nextWeek = XCTUnwrap2(WorkSnoozeDuration.nextWeek.deadline(from: morning, calendar: calendar))
    XCTAssertEqual(calendar.component(.weekday, from: nextWeek), 2, "next week always lands on Monday")
    XCTAssertEqual(calendar.component(.hour, from: nextWeek), 9)
    XCTAssertEqual(
      calendar.dateComponents([.day], from: calendar.startOfDay(for: morning), to: calendar.startOfDay(for: nextWeek)).day,
      7,
      "choosing next week on Monday means the following Monday"
    )
  }

  /// Past 18:00 "this evening" has gone, so it rolls to the next one rather
  /// than resolving to a deadline that has already elapsed. Mirrors the desktop
  /// `snoozeDeadlineIso("evening")`.
  func testThisEveningRollsToTheNextEveningOncePassed() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    let night = calendar.date(from: DateComponents(year: 2026, month: 7, day: 6, hour: 21))!
    let evening = XCTUnwrap2(WorkSnoozeDuration.thisEvening.deadline(from: night, calendar: calendar))
    XCTAssertTrue(evening > night)
    XCTAssertEqual(calendar.component(.hour, from: evening), 18)
    XCTAssertEqual(
      calendar.dateComponents([.day], from: calendar.startOfDay(for: night), to: calendar.startOfDay(for: evening)).day,
      1
    )
  }

  func testSnoozeMenuSuppressesThisEveningOnceItDuplicatesOneHour() {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "America/Los_Angeles")!
    let afternoon = calendar.date(from: DateComponents(year: 2026, month: 7, day: 7, hour: 16, minute: 30))!
    let boundary = calendar.date(from: DateComponents(year: 2026, month: 7, day: 7, hour: 17))!
    let night = calendar.date(from: DateComponents(year: 2026, month: 7, day: 7, hour: 21))!

    XCTAssertEqual(
      workSnoozeOptions(now: afternoon, calendar: calendar).map(\.duration),
      [.oneHour, .thisEvening, .tomorrowMorning, .nextWeek, .untilAsked]
    )
    XCTAssertEqual(
      workSnoozeOptions(now: boundary, calendar: calendar).map(\.duration),
      [.oneHour, .tomorrowMorning, .nextWeek, .untilAsked]
    )
    XCTAssertEqual(
      workSnoozeOptions(now: night, calendar: calendar).map(\.duration),
      [.oneHour, .tomorrowMorning, .nextWeek, .untilAsked]
    )
  }

  /// "Until I'm asked" parks the row far enough out that the row copy reads as
  /// open-ended instead of counting down to a date a century away.
  func testUntilAskedRendersAsOpenEndedRowCopy() {
    let deadline = XCTUnwrap2(WorkSnoozeDuration.untilAsked.deadline(from: now))
    XCTAssertEqual(workSnoozeWakeLabel(iso(deadline), now: now), "wakes when asked")
  }

  /// The wake line mirrors the desktop `snoozeWakeLabel` exactly — same
  /// thresholds, same calendar-day rounding, same words.
  func testSnoozeWakeLabelMatchesDesktopCopy() {
    XCTAssertNil(workSnoozeWakeLabel(nil, now: now))
    XCTAssertNil(workSnoozeWakeLabel("not-a-date", now: now))
    XCTAssertEqual(workSnoozeWakeLabel(iso(now.addingTimeInterval(-1)), now: now), "wakes now")
    XCTAssertEqual(workSnoozeWakeLabel(iso(now.addingTimeInterval(30)), now: now), "wakes in 1m")
    XCTAssertEqual(workSnoozeWakeLabel(iso(now.addingTimeInterval(25 * 60)), now: now), "wakes in 25m")
    XCTAssertEqual(workSnoozeWakeLabel(iso(now.addingTimeInterval(3 * 3600)), now: now), "wakes in 3h")
  }

  private func snoozedSession(
    untilOffset: TimeInterval?,
    atOffset: TimeInterval?,
    status: String = "running",
    runtimeState: String = "running",
    lastOutputPreview: String? = nil
  ) -> TerminalSessionSummary {
    TerminalSessionSummary(
      id: "s-1",
      laneId: "lane-1",
      laneName: "lane",
      ptyId: nil,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: nil,
      toolType: "codex",
      title: "Session",
      status: status,
      startedAt: iso(now),
      endedAt: nil,
      snoozedUntil: untilOffset.map { iso(now.addingTimeInterval($0)) },
      snoozedAt: atOffset.map { iso(now.addingTimeInterval($0)) },
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

  /// Force-unwrap helper so the duration assertions read as one line each.
  private func XCTUnwrap2(_ value: Date?, file: StaticString = #filePath, line: UInt = #line) -> Date {
    guard let value else {
      XCTFail("expected a non-nil date", file: file, line: line)
      return Date()
    }
    return value
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
