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

  func testConversationDigestFoldsBotsWithThreadAndCommentCounts() {
    func thread(_ id: String, _ author: String, bot: Bool? = nil, resolved: Bool = true, outdated: Bool = false, at: String) -> PrDigestEntry {
      PrDigestEntry(id: "thread:\(id)", kind: .thread, author: author, authorIsBot: bot, at: at, body: "x", path: "a/B.swift", line: 3, resolved: resolved, outdated: outdated)
    }
    func comment(_ id: String, _ author: String, bot: Bool? = nil, at: String) -> PrDigestEntry {
      PrDigestEntry(id: id, kind: .comment, author: author, authorIsBot: bot, at: at, body: "hi")
    }
    func commit(_ id: String, at: String, force: Bool = false) -> PrDigestCommit {
      PrDigestCommit(id: id, sha: "\(id)sha", shortSha: id, subject: id, at: at, forcePushed: force)
    }
    let t = "2026-01-01T0"
    struct Case {
      let name: String
      var commits: [PrDigestCommit] = []
      let entries: [PrDigestEntry]
      /// Each item: `push:<id>:<commits>`, `bot:<name>:<summary>`, `entry:<id>`.
      let shape: [String]
      let openThreads: [String]
    }
    let devinThreads = (0..<10).map { thread("d\($0)", "devin-ai-integration[bot]", at: "\(t)1:0\($0):00Z") }
    let cases: [Case] = [
      Case(
        name: "all resolved and two comments",
        entries: devinThreads + [comment("dc1", "devin-ai-integration[bot]", at: "\(t)2:00:00Z"), comment("dc2", "devin-ai-integration[bot]", at: "\(t)2:01:00Z")],
        shape: ["bot:Devin:10 threads · all resolved · 2 comments"],
        openThreads: []
      ),
      Case(
        name: "some open",
        entries: [thread("r1", "coderabbitai[bot]", at: "\(t)1:00:00Z"), thread("r2", "coderabbitai[bot]", resolved: false, at: "\(t)1:01:00Z"), thread("r3", "coderabbitai[bot]", at: "\(t)1:02:00Z")],
        shape: ["bot:CodeRabbit:3 threads · 2 resolved"],
        openThreads: ["thread:r2"]
      ),
      Case(
        name: "none resolved",
        entries: [thread("g1", "greptile-apps[bot]", resolved: false, at: "\(t)1:00:00Z"), thread("g2", "greptile-apps[bot]", resolved: false, at: "\(t)1:01:00Z")],
        shape: ["bot:Greptile:2 threads · 2 open"],
        openThreads: ["thread:g2", "thread:g1"]
      ),
      Case(
        name: "an outdated thread is not open",
        entries: [thread("o1", "coderabbitai[bot]", resolved: false, outdated: true, at: "\(t)1:00:00Z")],
        shape: ["bot:CodeRabbit:1 thread · all resolved"],
        openThreads: []
      ),
      Case(
        name: "one comment reads as posted, a deploy bot as an update",
        entries: [comment("v1", "vercel[bot]", at: "\(t)1:00:00Z"), comment("c1", "coderabbitai[bot]", at: "\(t)1:01:00Z")],
        shape: ["bot:Vercel:Deploy update", "bot:CodeRabbit:Comment posted"],
        openThreads: []
      ),
      Case(
        name: "a short login folds only with GitHub's bot flag",
        entries: [comment("k1", "cursor", bot: true, at: "\(t)1:00:00Z"), comment("k2", "cursor", at: "\(t)1:01:00Z")],
        shape: ["bot:Cursor:Comment posted", "entry:k2"],
        openThreads: []
      ),
      Case(
        name: "pushes split on conversation and force-push; people stay rows; people's threads lead",
        commits: [commit("c1", at: "\(t)0:00:00Z"), commit("c2", at: "\(t)1:00:00Z"), commit("c3", at: "\(t)3:00:00Z"), commit("f1", at: "\(t)4:00:00Z", force: true)],
        entries: [
          thread("b1", "coderabbitai[bot]", resolved: false, at: "\(t)2:00:00Z"),
          comment("b2", "coderabbitai[bot]", at: "\(t)2:10:00Z"),
          thread("h1", "octocat", resolved: false, at: "\(t)2:20:00Z"),
        ],
        shape: ["push:c1:2", "bot:CodeRabbit:1 thread · 1 open · 1 comment", "entry:thread:h1", "push:c3:1", "push:f1:1"],
        openThreads: ["thread:h1", "thread:b1"]
      ),
    ]
    for testCase in cases {
      let digest = buildPrConversationDigest(commits: testCase.commits, entries: testCase.entries)
      let shape = digest.items.map { item -> String in
        switch item {
        case .push(let push): return "push:\(push.id):\(push.commitCount)"
        case .bot(let group): return "bot:\(group.identity.displayName):\(prDescribeBotGroup(group))"
        case .entry(let entry, _): return "entry:\(entry.id)"
        case .story(let event): return "story:\(event.id)"
        }
      }
      XCTAssertEqual(shape, testCase.shape, testCase.name)
      XCTAssertEqual(digest.openThreads.map(\.id), testCase.openThreads, testCase.name)
    }
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

  func testBodyCleanerDropsEveryHtmlCommentAndSplitsBotBlocks() {
    struct Case {
      let name: String
      let body: String
      let expected: String
      var sections: [String] = []
    }
    let cases: [Case] = [
      Case(name: "plain markdown passes through", body: "Plain **markdown**", expected: "Plain **markdown**"),
      Case(name: "Devin review JSON", body: "Fixes it.\n<!-- devin-review-comment {\"id\":1,\"file\":\"a.ts\"} -->\nMore.", expected: "Fixes it.\n\nMore."),
      Case(
        name: "Cursor agent markers",
        body: "<!-- CURSOR_AGENT_PR_BODY_BEGIN -->\nBody text\n<!-- CURSOR_AGENT_PR_BODY_END -->",
        expected: "Body text"
      ),
      Case(name: "multi-line comment", body: "A\n<!--\nhidden\nlines\n-->\nB", expected: "A\n\nB"),
      Case(name: "unterminated comment hides the rest", body: "Visible\n<!-- never closed\nsecret", expected: "Visible"),
      Case(name: "runs of blank lines collapse", body: "A\n\n<!-- x -->\n\n\nB", expected: "A\n\nB"),
      Case(
        name: "bot blocks leave, nested comments too",
        body: """
        Summary.
        <!-- This is an auto-generated comment: release notes by coderabbit.ai -->
        ## Summary by CodeRabbit
        <!-- walkthrough_start -->
        - New header
        <!-- end of auto-generated comment: release notes by coderabbit.ai -->
        <!-- devin-review-badge-begin -->
        [Open with Devin](https://app.devin.ai)
        <!-- devin-review-badge-end -->
        """,
        expected: "Summary.",
        sections: ["coderabbit-summary", "devin-review-badge"]
      ),
    ]
    for testCase in cases {
      let cleaned = prCleanBody(testCase.body)
      XCTAssertEqual(cleaned.body, testCase.expected, testCase.name)
      XCTAssertEqual(cleaned.sections.map(\.id), testCase.sections, testCase.name)
      XCTAssertFalse(cleaned.sections.contains { $0.body.contains("<!--") }, testCase.name)
      XCTAssertFalse(prDigestPreview(testCase.body).contains("<!--"), testCase.name)
    }
  }

  // MARK: - Header

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


}
