import XCTest
@testable import ADE

/// Swift ports of the desktop PR detail rules. Same fixtures as
/// `apps/desktop/src/shared/prDetailRedesign.test.ts`, so both apps say the
/// same thing about the same PR.
final class PrDetailRedesignTests: XCTestCase {
  // MARK: - Bot identity

  func testGraphqlBotLoginsWithoutSuffixAreAgents() {
    XCTAssertEqual(PrAuthorIdentity.classify("coderabbitai").displayName, "CodeRabbit")
    XCTAssertEqual(PrAuthorIdentity.classify("devin-ai-integration").kind, "devin")
    let cursor = PrAuthorIdentity.classify("cursor", accountIsBot: true)
    XCTAssertTrue(cursor.isBot)
    XCTAssertEqual(cursor.role, .agentReviewer)
  }

  func testAPersonWithAProductLoginIsNotABot() {
    XCTAssertFalse(PrAuthorIdentity.classify("cursor").isBot)
    XCTAssertFalse(PrAuthorIdentity.classify("claude").isBot)
    XCTAssertEqual(PrAuthorIdentity.classify("arul28").role, .human)
  }

  func testSeerIsAKnownAgentReviewer() {
    let seer = PrAuthorIdentity.classify("seer-by-sentry[bot]")
    XCTAssertEqual(seer.kind, "seer")
    XCTAssertEqual(seer.displayName, "Seer")
    XCTAssertEqual(seer.role, .agentReviewer)
    // Hyphenated, so it classifies without the account flag on old snapshots.
    XCTAssertTrue(PrAuthorIdentity.classify("seer-by-sentry").isBot)
  }

  func testRestSuffixAndUnknownBots() {
    XCTAssertEqual(PrAuthorIdentity.classify("vercel[bot]").role, .deploy)
    let unknown = PrAuthorIdentity.classify("some-new-app[bot]")
    XCTAssertTrue(unknown.isBot)
    XCTAssertNil(unknown.kind)
  }

  // MARK: - Next step

  private func input(_ edit: (inout PrNextStepInput) -> Void = { _ in }) -> PrNextStepInput {
    var value = PrNextStepInput(
      state: "open",
      mergeStateStatus: .clean,
      mergeConflicts: false,
      behindBaseBy: 0,
      mergeabilityComputing: false,
      checksStatus: "passing",
      failingChecks: 0,
      pendingChecks: 0,
      passingChecks: 5,
      reviewDecision: nil,
      approvalsCount: nil,
      requiredApprovals: nil,
      changesRequestedBy: [],
      unresolvedThreads: 0,
      canBypass: false,
      autoMergeAllowed: false,
      autoMergeEnabled: false,
      autoMergeMethod: nil,
      baseBranch: "main"
    )
    edit(&value)
    return value
  }

  func testConflictsLeadAndBlockMergeAnyway() {
    let step = PrNextStep.resolve(input {
      $0.mergeStateStatus = .dirty
      $0.mergeConflicts = true
      $0.canBypass = true
      $0.unresolvedThreads = 1
    })
    XCTAssertEqual(step.kind, .conflicts)
    XCTAssertEqual(step.primary, .resolveConflicts)
    XCTAssertTrue(step.mergeAnyway.blocked)
    XCTAssertFalse(step.mergeAnyway.bypass)
    XCTAssertEqual(step.chips.map(\.id), ["conflicts", "up_to_date", "checks", "review", "threads"])
  }

  func testAdminBypassListsWhatItSkips() {
    let step = PrNextStep.resolve(input {
      $0.mergeStateStatus = .blocked
      $0.reviewDecision = .reviewRequired
      $0.requiredApprovals = 1
      $0.approvalsCount = 0
      $0.pendingChecks = 1
      $0.passingChecks = 4
      $0.canBypass = true
    })
    XCTAssertTrue(step.mergeAnyway.bypass)
    XCTAssertFalse(step.mergeAnyway.blocked)
    XCTAssertEqual(step.mergeAnyway.skips, ["1 running check", "1 required approval"])
  }

  func testAutoMergeOnlyWhenTheRepoAllowsIt() {
    let running = input {
      $0.mergeStateStatus = .blocked
      $0.pendingChecks = 2
    }
    XCTAssertNil(PrNextStep.resolve(running).primary)
    var allowed = running
    allowed.autoMergeAllowed = true
    XCTAssertEqual(PrNextStep.resolve(allowed).primary, .enableAutoMerge)
  }

  func testReadyMergesDirectlyAndNeverOverABlockedVerdict() {
    XCTAssertEqual(PrNextStep.resolve(input()).primary, .merge)
    XCTAssertFalse(PrNextStep.resolve(input()).mergeAnyway.visible)
    XCTAssertEqual(PrNextStep.resolve(input { $0.mergeStateStatus = .blocked; $0.unresolvedThreads = 2 }).kind, .rulesBlocked)
  }

  func testLatestOpinionPerReviewerWins() {
    let reviews = [
      PrReview(reviewer: "alice", state: "changes_requested", body: nil, submittedAt: "2026-01-01T01:00:00Z"),
      PrReview(reviewer: "alice", state: "commented", body: nil, submittedAt: "2026-01-01T02:00:00Z"),
      PrReview(reviewer: "bob", state: "changes_requested", body: nil, submittedAt: "2026-01-01T01:00:00Z"),
      PrReview(reviewer: "bob", state: "approved", body: nil, submittedAt: "2026-01-01T03:00:00Z"),
    ]
    XCTAssertEqual(prChangesRequestedBy(reviews), ["alice"])
  }

  func testUnknownMergeStateWhileComputingIsNoLiveMergeBox() {
    let step = PrNextStep.resolve(input {
      $0.mergeStateStatus = .unknown
      $0.mergeabilityComputing = true
      $0.behindBaseBy = nil
    })
    XCTAssertEqual(step.kind, .computing)
    XCTAssertFalse(step.chips.map(\.id).contains("conflicts"))
    XCTAssertFalse(step.chips.map(\.id).contains("up_to_date"))
  }

  func testALaterDismissalClearsAnEarlierVerdict() {
    let reviews = [
      PrReview(reviewer: "alice", state: "changes_requested", body: nil, submittedAt: "2026-01-01T01:00:00Z"),
      PrReview(reviewer: "alice", state: "dismissed", body: nil, submittedAt: "2026-01-01T02:00:00Z"),
      PrReview(reviewer: "bob", state: "approved", body: nil, submittedAt: "2026-01-01T01:00:00Z"),
      PrReview(reviewer: "bob", state: "dismissed", body: nil, submittedAt: "2026-01-01T02:00:00Z"),
    ]
    XCTAssertEqual(prChangesRequestedBy(reviews), [])
  }

  func testReviewerLoginsMatchAfterBotNormalization() {
    let reviews = [
      PrReview(reviewer: "Carol[bot]", state: "changes_requested", body: nil, submittedAt: "2026-01-01T01:00:00Z"),
      PrReview(reviewer: "carol", state: "approved", body: nil, submittedAt: "2026-01-01T02:00:00Z"),
      // No time yet: it sorts first, so the later verdict still wins.
      PrReview(reviewer: " CAROL ", state: "changes_requested", body: nil, submittedAt: nil),
    ]
    XCTAssertEqual(prChangesRequestedBy(reviews), [])
    XCTAssertEqual(prChangesRequestedBy(Array(reviews.prefix(1))), ["Carol[bot]"])
  }

  // MARK: - Push folding

  private func event(_ id: String, _ kind: PrTimelineEventKind, author: String? = "dev", at: String) -> PrTimelineEvent {
    PrTimelineEvent(id: id, kind: kind, title: id, author: author, body: nil, timestamp: at, metadata: nil)
  }

  func testCommitsJoinIntoPushesAndBotsFoldPerPush() {
    let items = buildPrDigestDisplayItems([
      event("c1", .commit, at: "2026-01-01T00:00:00Z"),
      event("c2", .commit, at: "2026-01-01T01:00:00Z"),
      event("r1", .review, author: "coderabbitai", at: "2026-01-01T02:00:00Z"),
      event("r2", .comment, author: "coderabbitai", at: "2026-01-01T02:10:00Z"),
      event("h1", .comment, author: "octocat", at: "2026-01-01T02:20:00Z"),
      event("c3", .commit, at: "2026-01-01T03:00:00Z"),
      event("f1", .forcePush, at: "2026-01-01T04:00:00Z"),
    ])
    let shape = items.map { item -> String in
      switch item {
      case .push(_, let events): return "push:\(events.count)"
      case .botGroup(_, let identity, let events): return "bot:\(identity.displayName):\(events.count)"
      case .event(let event): return event.id
      }
    }
    XCTAssertEqual(shape, ["push:2", "bot:CodeRabbit:2", "h1", "push:1", "push:1"])
  }

  // MARK: - Bot blocks in the PR body

  func testBodyBotSectionsSplitOutAndLeaveTheAuthorsText() {
    let body = """
    Fixes the header.

    ---
    <!-- This is an auto-generated comment: release notes by coderabbit.ai -->
    ## Summary by CodeRabbit
    - New header
    <!-- end of auto-generated comment: release notes by coderabbit.ai -->

    <!-- CURSOR_SUMMARY -->
    Cursor says hi
    <!-- /CURSOR_SUMMARY -->
    ***
    """
    let split = prSplitBodyBotSections(body)
    XCTAssertEqual(split.body, "Fixes the header.")
    XCTAssertEqual(split.sections.map(\.id), ["coderabbit-summary", "cursor-summary"])
    XCTAssertEqual(split.sections.map(\.login), ["coderabbitai", "cursor"])
    XCTAssertEqual(split.sections.first?.body, "## Summary by CodeRabbit\n- New header")
  }

  func testUnterminatedBlockRunsToTheEndAndCursorMarkerIsExactCase() {
    let split = prSplitBodyBotSections("Body\n<!-- devin-review-badge-begin -->\n[Devin](x)")
    XCTAssertEqual(split.body, "Body")
    XCTAssertEqual(split.sections.map(\.id), ["devin-review-badge"])
    // Desktop's Cursor regex has no `i` flag: a lower-case marker stays in the body.
    let lower = prSplitBodyBotSections("Body\n<!-- cursor_summary -->\nx\n<!-- /cursor_summary -->")
    XCTAssertTrue(lower.sections.isEmpty)
  }

  func testDescriptionBotEventsCarryThePrefix() {
    let event = PrTimelineEvent(id: "\(prDescriptionBotEventPrefix)cursor-summary", kind: .comment, title: "", author: "cursor", body: "x", timestamp: "2026-01-01T00:00:00Z", metadata: nil)
    XCTAssertTrue(prIsDescriptionBotEvent(event))
    XCTAssertFalse(prIsDescriptionBotEvent(self.event("c-1", .comment, at: "2026-01-01T00:00:00Z")))
  }

  // MARK: - Header

  func testHeaderShowsUpdatedOnlyWhenItDiffersFromOpened() {
    let formatter = ISO8601DateFormatter()
    let opened = formatter.string(from: Date().addingTimeInterval(-10 * 86_400))
    let recent = formatter.string(from: Date().addingTimeInterval(-3_600))
    XCTAssertTrue(prHeaderAgeLabel(createdAt: opened, updatedAt: recent).contains("· updated "))
    XCTAssertFalse(prHeaderAgeLabel(createdAt: opened, updatedAt: opened).contains("updated"))
    XCTAssertFalse(prHeaderAgeLabel(createdAt: opened, updatedAt: nil).contains("updated"))
    XCTAssertTrue(prHeaderAgeLabel(createdAt: opened, updatedAt: nil).hasPrefix("opened "))
  }

  // MARK: - Optional PR actions (prs.setDraft / prs.setAutoMerge)

  @MainActor
  func testLegacyHostWithoutMobileCompatibilityRefusesDraftAndAutoMergeBeforeTransport() async throws {
    try await withServiceAsync { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "legacy-host", "deviceName": "Old Mac"],
        "features": [
          "commandRouting": ["actions": [Self.descriptor("prs.reopen")]] as [String: Any],
        ] as [String: Any],
      ])
      XCTAssertEqual(service.connectionState, .connected)
      XCTAssertEqual(service.hostCompatibilityMode, .limited)
      try await assertDraftAndAutoMergeRefused(service)
    }
  }

  @MainActor
  func testFullHostThatDoesNotAdvertiseTheActionsRefusesThemLocally() async throws {
    // Both are OPTIONAL in syncMobileCompatibility.ts: a host can report
    // `full` and still not register them.
    try await withServiceAsync { service in
      try service.applyHelloPayloadForTesting([
        "brain": ["deviceId": "host", "deviceName": "Mac"],
        "features": [
          "commandRouting": ["actions": [Self.descriptor("prs.reopen")]] as [String: Any],
          "mobileCompatibility": ["mode": "full", "missingActions": [String]()] as [String: Any],
        ] as [String: Any],
      ])
      XCTAssertEqual(service.hostCompatibilityMode, .full)
      try await assertDraftAndAutoMergeRefused(service)
    }
  }

  @MainActor
  func testHostAdvertisingTheActionsUnlocksThem() throws {
    let baseURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }
    try service.applyHelloPayloadForTesting([
      "brain": ["deviceId": "host", "deviceName": "Mac"],
      "features": [
        "commandRouting": ["actions": [Self.descriptor("prs.setDraft"), Self.descriptor("prs.setAutoMerge")]] as [String: Any],
        "mobileCompatibility": ["mode": "full", "missingActions": [String]()] as [String: Any],
      ] as [String: Any],
    ])
    XCTAssertEqual(service.hostCompatibilityMode, .full)
    XCTAssertTrue(service.supportsRemoteAction("prs.setDraft"))
    XCTAssertTrue(service.supportsRemoteAction("prs.setAutoMerge"))
  }

  @MainActor
  private func assertDraftAndAutoMergeRefused(_ service: SyncService) async throws {
    XCTAssertFalse(service.supportsRemoteAction("prs.setDraft"))
    XCTAssertFalse(service.supportsRemoteAction("prs.setAutoMerge"))
    do {
      try await service.setPullRequestDraft(prId: "pr-1", draft: false)
      XCTFail("An unadvertised prs.setDraft must not be sent or queued.")
    } catch {
      XCTAssertEqual((error as NSError).code, 15)
    }
    do {
      try await service.setPullRequestAutoMerge(prId: "pr-1", enabled: true, method: "squash")
      XCTFail("An unadvertised prs.setAutoMerge must not be sent or queued.")
    } catch {
      XCTAssertEqual((error as NSError).code, 15)
    }
    XCTAssertEqual(service.pendingOperationCount, 0)
  }

  private static func descriptor(_ action: String) -> [String: Any] {
    ["action": action, "policy": ["viewerAllowed": true, "queueable": true] as [String: Any]]
  }

  @MainActor
  private func withServiceAsync(_ body: (SyncService) async throws -> Void) async throws {
    let baseURL = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: baseURL, withIntermediateDirectories: true)
    let database = DatabaseService(baseURL: baseURL)
    let service = SyncService(database: database)
    defer {
      service.disconnect(clearCredentials: false)
      database.close()
      try? FileManager.default.removeItem(at: baseURL)
    }
    try await body(service)
  }

  func testAccountFlagFoldsAShortLoginBot() {
    let items = buildPrDigestDisplayItems(
      [event("r1", .review, author: "cursor", at: "2026-01-01T02:00:00Z")],
      botFlags: ["cursor": true]
    )
    guard case .botGroup(_, let identity, _) = items.first else {
      return XCTFail("expected a folded bot row")
    }
    XCTAssertEqual(identity.displayName, "Cursor")
  }
}
