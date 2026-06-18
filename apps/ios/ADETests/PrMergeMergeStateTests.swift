import XCTest
@testable import ADE

/// Covers the new GitHub merge-state parity fields on `PrStatus` /
/// `PrActionCapabilities` and the pure checklist/merge-attempt/commit-message
/// logic in `PrMergeChecklist`. The JSON shapes mirror the three desktop
/// scenarios (merge-ready, review-requested, CI-failing) the mobile snapshot
/// carries over sync.
final class PrMergeMergeStateTests: XCTestCase {
  private func decodeStatus(_ json: String) throws -> PrStatus {
    try JSONDecoder().decode(PrStatus.self, from: Data(json.utf8))
  }

  // MARK: - PrStatus decoding (new fields)

  func testMergeReadyStatusDecodesCleanApproved() throws {
    let status = try decodeStatus(#"""
    {
      "prId": "pr-401",
      "state": "open",
      "checksStatus": "passing",
      "reviewStatus": "approved",
      "isMergeable": true,
      "mergeConflicts": false,
      "behindBaseBy": 0,
      "mergeStateStatus": "clean",
      "reviewDecision": "approved",
      "approvalsCount": 2,
      "requiredApprovals": 1,
      "mergeabilityComputing": false,
      "canBypass": false,
      "headSha": "abc123"
    }
    """#)

    XCTAssertEqual(status.mergeStateStatus, .clean)
    XCTAssertEqual(status.reviewDecision, .approved)
    XCTAssertEqual(status.approvalsCount, 2)
    XCTAssertEqual(status.requiredApprovals, 1)
    XCTAssertEqual(status.mergeabilityComputing, false)
    XCTAssertEqual(status.canBypass, false)
    XCTAssertEqual(status.headSha, "abc123")
  }

  func testReviewRequestedStatusDecodesBlocked() throws {
    let status = try decodeStatus(#"""
    {
      "prId": "pr-402",
      "state": "open",
      "checksStatus": "passing",
      "reviewStatus": "requested",
      "isMergeable": false,
      "mergeConflicts": false,
      "behindBaseBy": 0,
      "mergeStateStatus": "blocked",
      "reviewDecision": "review_required",
      "approvalsCount": 0,
      "requiredApprovals": 1,
      "canBypass": true,
      "headSha": "def456"
    }
    """#)

    XCTAssertEqual(status.mergeStateStatus, .blocked)
    XCTAssertEqual(status.reviewDecision, .reviewRequired)
    XCTAssertEqual(status.approvalsCount, 0)
    XCTAssertEqual(status.requiredApprovals, 1)
    XCTAssertEqual(status.canBypass, true)
  }

  func testCiFailingStatusDecodesUnstable() throws {
    let status = try decodeStatus(#"""
    {
      "prId": "pr-403",
      "state": "open",
      "checksStatus": "failing",
      "reviewStatus": "approved",
      "isMergeable": false,
      "mergeConflicts": false,
      "behindBaseBy": 0,
      "mergeStateStatus": "unstable",
      "reviewDecision": "approved",
      "approvalsCount": 1,
      "requiredApprovals": 1
    }
    """#)

    XCTAssertEqual(status.mergeStateStatus, .unstable)
    XCTAssertEqual(status.reviewDecision, .approved)
  }

  func testLegacyStatusWithoutNewFieldsStillDecodes() throws {
    // Older hosts omit every new field; decode must succeed with nils.
    let status = try decodeStatus(#"""
    {
      "prId": "pr-legacy",
      "state": "open",
      "checksStatus": "none",
      "reviewStatus": "none",
      "isMergeable": true,
      "mergeConflicts": false,
      "behindBaseBy": 0
    }
    """#)

    XCTAssertNil(status.mergeStateStatus)
    XCTAssertNil(status.reviewDecision)
    XCTAssertNil(status.approvalsCount)
    XCTAssertNil(status.requiredApprovals)
    XCTAssertNil(status.canBypass)
    XCTAssertNil(status.headSha)
  }

  func testUnknownMergeStateAndReviewDecisionDecodeSafely() throws {
    // A new GitHub enum value must not fail the whole snapshot decode:
    // unknown mergeStateStatus → .unknown, unknown reviewDecision → nil.
    let status = try decodeStatus(#"""
    {
      "prId": "pr-future",
      "state": "open",
      "checksStatus": "passing",
      "reviewStatus": "approved",
      "isMergeable": true,
      "mergeConflicts": false,
      "behindBaseBy": 0,
      "mergeStateStatus": "some_new_value",
      "reviewDecision": "some_new_decision"
    }
    """#)

    XCTAssertEqual(status.mergeStateStatus, .unknown)
    XCTAssertNil(status.reviewDecision)
  }

  func testHasHooksMergeStateDecodesFromSnakeCase() throws {
    let status = try decodeStatus(#"""
    {
      "prId": "pr-hooks",
      "state": "open",
      "checksStatus": "passing",
      "reviewStatus": "approved",
      "isMergeable": true,
      "mergeConflicts": false,
      "behindBaseBy": 0,
      "mergeStateStatus": "has_hooks"
    }
    """#)
    XCTAssertEqual(status.mergeStateStatus, .hasHooks)
  }

  // MARK: - PrActionCapabilities decoding (new fields)

  func testCapabilitiesDecodeNewMergeFields() throws {
    let caps = try JSONDecoder().decode(PrActionCapabilities.self, from: Data(#"""
    {
      "prId": "pr-402",
      "canOpenInGithub": true,
      "canMerge": false,
      "canClose": true,
      "canReopen": false,
      "canRequestReviewers": true,
      "canRerunChecks": true,
      "canComment": true,
      "canUpdateDescription": true,
      "canDelete": false,
      "mergeBlockedReason": "Review required",
      "mergeStateStatus": "blocked",
      "canBypass": true,
      "canUpdateBranch": false,
      "requiresLive": true
    }
    """#.utf8))

    XCTAssertEqual(caps.mergeStateStatus, .blocked)
    XCTAssertEqual(caps.canBypass, true)
    XCTAssertEqual(caps.canUpdateBranch, false)
  }

  func testCapabilitiesDecodeWithoutNewFields() throws {
    let caps = try JSONDecoder().decode(PrActionCapabilities.self, from: Data(#"""
    {
      "prId": "pr-legacy",
      "canOpenInGithub": true,
      "canMerge": true,
      "canClose": true,
      "canReopen": false,
      "canRequestReviewers": true,
      "canRerunChecks": true,
      "canComment": true,
      "canUpdateDescription": true,
      "canDelete": false,
      "requiresLive": true
    }
    """#.utf8))

    XCTAssertNil(caps.mergeStateStatus)
    XCTAssertNil(caps.canBypass)
    XCTAssertNil(caps.canUpdateBranch)
  }

  // MARK: - Checklist derivation

  func testChecklistForMergeReadyPr() {
    let status = PrStatus(
      prId: "pr-401", state: "open", checksStatus: "passing", reviewStatus: "approved",
      isMergeable: true, mergeConflicts: false, behindBaseBy: 0,
      mergeStateStatus: .clean, reviewDecision: .approved,
      approvalsCount: 2, requiredApprovals: 1
    )
    let items = PrMergeChecklist.build(
      prState: "open", summaryReviewStatus: "approved", status: status,
      checks: [check(name: "CI", conclusion: "success")], reviews: []
    )

    let review = items.first { $0.id == "review" }
    XCTAssertEqual(review?.state, .pass)
    XCTAssertEqual(review?.detail, "2 of 1 required approval")
    XCTAssertEqual(items.first { $0.id == "checks" }?.state, .pass)
    XCTAssertEqual(items.first { $0.id == "conflicts" }?.state, .pass)
    XCTAssertEqual(items.first { $0.id == "behind" }?.state, .pass)
    XCTAssertNil(items.first { $0.id == "protected" })
  }

  func testChecklistForReviewRequiredBlockedPr() {
    let status = PrStatus(
      prId: "pr-402", state: "open", checksStatus: "passing", reviewStatus: "requested",
      isMergeable: false, mergeConflicts: false, behindBaseBy: 0,
      mergeStateStatus: .blocked, reviewDecision: .reviewRequired,
      approvalsCount: 0, requiredApprovals: 1, canBypass: true
    )
    let items = PrMergeChecklist.build(
      prState: "open", summaryReviewStatus: "requested", status: status,
      checks: [check(name: "CI", conclusion: "success")], reviews: []
    )

    let review = items.first { $0.id == "review" }
    XCTAssertEqual(review?.state, .fail)
    XCTAssertEqual(review?.detail, "0 of 1 required approval")
    let protected = items.first { $0.id == "protected" }
    XCTAssertEqual(protected?.state, .neutral)
    XCTAssertEqual(protected?.detail, "You can bypass as an administrator")
  }

  func testChecklistForCiFailingPr() {
    let status = PrStatus(
      prId: "pr-403", state: "open", checksStatus: "failing", reviewStatus: "approved",
      isMergeable: false, mergeConflicts: false, behindBaseBy: 0,
      mergeStateStatus: .unstable, reviewDecision: .approved,
      approvalsCount: 1, requiredApprovals: 1
    )
    let items = PrMergeChecklist.build(
      prState: "open", summaryReviewStatus: "approved", status: status,
      checks: [
        check(name: "CI", conclusion: "failure"),
        check(name: "Lint", conclusion: "success"),
      ],
      reviews: []
    )

    XCTAssertEqual(items.first { $0.id == "checks" }?.state, .fail)
    XCTAssertEqual(items.first { $0.id == "checks" }?.label, "1 failing check")
    XCTAssertEqual(items.first { $0.id == "review" }?.state, .pass)
  }

  func testChecklistFallsBackToSummaryReviewStatusOnLegacyHost() {
    // No reviewDecision on the wire → fall back to the summary review status.
    let status = PrStatus(
      prId: "pr-legacy", state: "open", checksStatus: "passing", reviewStatus: "requested",
      isMergeable: false, mergeConflicts: false, behindBaseBy: 0
    )
    let items = PrMergeChecklist.build(
      prState: "open", summaryReviewStatus: "requested", status: status,
      checks: [], reviews: []
    )
    XCTAssertEqual(items.first { $0.id == "review" }?.state, .fail)
    XCTAssertEqual(items.first { $0.id == "review" }?.label, "Review required")
  }

  // MARK: - canAttemptMerge

  func testCanAttemptMergePrefersMergeStateStatus() {
    let clean = PrStatus(
      prId: "p", state: "open", checksStatus: "passing", reviewStatus: "approved",
      isMergeable: true, mergeConflicts: false, behindBaseBy: 0, mergeStateStatus: .clean
    )
    XCTAssertTrue(PrMergeChecklist.canAttemptMerge(prState: "open", status: clean, bypassRules: false))

    let blocked = PrStatus(
      prId: "p", state: "open", checksStatus: "passing", reviewStatus: "requested",
      isMergeable: false, mergeConflicts: false, behindBaseBy: 0, mergeStateStatus: .blocked
    )
    XCTAssertFalse(PrMergeChecklist.canAttemptMerge(prState: "open", status: blocked, bypassRules: false))
    // Admin bypass can land a blocked (non-conflicted) PR.
    XCTAssertTrue(PrMergeChecklist.canAttemptMerge(prState: "open", status: blocked, bypassRules: true))

    let dirty = PrStatus(
      prId: "p", state: "open", checksStatus: "passing", reviewStatus: "approved",
      isMergeable: false, mergeConflicts: true, behindBaseBy: 0, mergeStateStatus: .dirty
    )
    // Conflicts are never bypassable.
    XCTAssertFalse(PrMergeChecklist.canAttemptMerge(prState: "open", status: dirty, bypassRules: true))
  }

  func testCanAttemptMergeFallsBackToIsMergeable() {
    let mergeable = PrStatus(
      prId: "p", state: "open", checksStatus: "passing", reviewStatus: "approved",
      isMergeable: true, mergeConflicts: false, behindBaseBy: 0
    )
    XCTAssertTrue(PrMergeChecklist.canAttemptMerge(prState: "open", status: mergeable, bypassRules: false))
  }

  // MARK: - Bypass gating

  func testShowsBypassToggleOnlyWhenCanBypassAndBlocked() {
    let blockedBypassable = PrStatus(
      prId: "p", state: "open", checksStatus: "passing", reviewStatus: "requested",
      isMergeable: false, mergeConflicts: false, behindBaseBy: 0,
      mergeStateStatus: .blocked, canBypass: true
    )
    XCTAssertTrue(PrMergeChecklist.showsBypassToggle(status: blockedBypassable, capabilities: nil))

    let blockedNotBypassable = PrStatus(
      prId: "p", state: "open", checksStatus: "passing", reviewStatus: "requested",
      isMergeable: false, mergeConflicts: false, behindBaseBy: 0,
      mergeStateStatus: .blocked, canBypass: false
    )
    XCTAssertFalse(PrMergeChecklist.showsBypassToggle(status: blockedNotBypassable, capabilities: nil))

    let cleanBypassable = PrStatus(
      prId: "p", state: "open", checksStatus: "passing", reviewStatus: "approved",
      isMergeable: true, mergeConflicts: false, behindBaseBy: 0,
      mergeStateStatus: .clean, canBypass: true
    )
    // Not blocked → no bypass toggle even though canBypass is true.
    XCTAssertFalse(PrMergeChecklist.showsBypassToggle(status: cleanBypassable, capabilities: nil))
  }

  // MARK: - Default commit message

  func testDefaultCommitMessageSquash() {
    let commits = [
      commit(message: "feat: add login"),
      commit(message: "fix: typo"),
    ]
    let result = PrMergeChecklist.defaultCommitMessage(
      method: .squash, prTitle: "Add auth", prNumber: 42,
      headBranch: "feat/auth", repoOwner: "arul28", commits: commits
    )
    XCTAssertEqual(result.title, "Add auth (#42)")
    XCTAssertEqual(result.body, "* feat: add login\n\n* fix: typo")
  }

  func testDefaultCommitMessageMerge() {
    let result = PrMergeChecklist.defaultCommitMessage(
      method: .merge, prTitle: "Add auth", prNumber: 42,
      headBranch: "feat/auth", repoOwner: "arul28", commits: []
    )
    XCTAssertEqual(result.title, "Merge pull request #42 from arul28/feat/auth")
    XCTAssertEqual(result.body, "Add auth")
  }

  func testDefaultCommitMessageRebaseIsEmpty() {
    let result = PrMergeChecklist.defaultCommitMessage(
      method: .rebase, prTitle: "Add auth", prNumber: 42,
      headBranch: "feat/auth", repoOwner: "arul28", commits: [commit(message: "x")]
    )
    XCTAssertEqual(result.title, "")
    XCTAssertEqual(result.body, "")
  }

  // MARK: - Command line

  func testCommandLineAppendsAdminFlagOnBypass() {
    let normal = PrMergeChecklist.commandLine(
      repoOwner: "arul28", repoName: "ADE", prNumber: 42, method: .squash, bypassRules: false
    )
    XCTAssertEqual(normal, "gh pr merge 42 --squash --repo arul28/ADE")

    let admin = PrMergeChecklist.commandLine(
      repoOwner: "arul28", repoName: "ADE", prNumber: 42, method: .squash, bypassRules: true
    )
    XCTAssertEqual(admin, "gh pr merge 42 --squash --admin --repo arul28/ADE")
  }

  // MARK: - Helpers

  private func check(name: String, conclusion: String) -> PrCheck {
    PrCheck(name: name, status: "completed", conclusion: conclusion, detailsUrl: nil, startedAt: nil, completedAt: nil)
  }

  private func commit(message: String) -> PrCommit {
    PrCommit(
      sha: "sha-\(message.hashValue)", shortSha: "abc1234", message: message,
      authorLogin: "arul28", authorName: "Arul", authorEmail: nil,
      committedDate: "2026-06-17T00:00:00Z", checkStatus: nil
    )
  }
}
