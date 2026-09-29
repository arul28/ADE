import XCTest
@testable import ADE

/// Covers the GitHub merge-state parity fields on `PrStatus` /
/// `PrActionCapabilities` and the PR list and detail rules around them. The
/// JSON shapes mirror the three desktop scenarios (merge-ready,
/// review-requested, CI-failing) the mobile snapshot carries over sync.
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

  // MARK: - canAttemptMerge

  // MARK: - Bypass gating

  // MARK: - Default commit message

  // MARK: - Command line

  // MARK: - Mobile GitHub projection reliability

  func testGitHubSnapshotDecodesProjectionHistoryCounts() throws {
    let snapshot = try JSONDecoder().decode(GitHubPrSnapshot.self, from: Data(#"""
    {
      "repo": { "owner": "arul28", "name": "ADE", "defaultBranch": "main" },
      "viewerLogin": "arul28",
      "repoPullRequests": [],
      "externalPullRequests": [],
      "syncedAt": "2026-07-17T12:00:00Z",
      "history": {
        "includeExternalClosed": false,
        "pageLimit": 0,
        "repoPullRequestsLoaded": 2,
        "repoPullRequestsMayHaveMore": false,
        "repoPullRequestCounts": { "open": 2, "closed": 17, "merged": 834 }
      }
    }
    """#.utf8))

    XCTAssertEqual(snapshot.history?.repoPullRequestCounts?.open, 2)
    XCTAssertEqual(snapshot.history?.repoPullRequestCounts?.merged, 834)
    XCTAssertEqual(snapshot.history?.repoPullRequestCounts?.closed, 17)
    XCTAssertNil(snapshot.writeViewerLogin)
  }

  func testGitHubSnapshotDecodesWriteViewerLogin() throws {
    let snapshot = try JSONDecoder().decode(GitHubPrSnapshot.self, from: Data(#"""
    {
      "repo": { "owner": "arul28", "name": "ADE", "defaultBranch": "main" },
      "viewerLogin": "arul28",
      "writeViewerLogin": "ade-bot",
      "repoPullRequests": [],
      "externalPullRequests": [],
      "syncedAt": "2026-08-26T12:00:00Z"
    }
    """#.utf8))

    XCTAssertEqual(snapshot.viewerLogin, "arul28")
    XCTAssertEqual(snapshot.writeViewerLogin, "ade-bot")
  }

  func testPrCommentDecodesReactionSnapshotFields() throws {
    let comment = try JSONDecoder().decode(PrComment.self, from: Data(#"""
    {
      "id": "comment-1",
      "author": "octocat",
      "body": "Looks good",
      "source": "issue",
      "url": "https://github.com/arul28/ADE/pull/1#issuecomment-55",
      "path": null,
      "line": null,
      "createdAt": "2026-08-26T12:00:00Z",
      "updatedAt": "2026-08-26T12:01:00Z",
      "githubId": 55,
      "nodeId": "IC_kwDOComment",
      "reactions": [
        { "id": "roll-up", "content": "+1", "user": "", "count": 3 },
        { "id": "r2", "content": "heart", "user": "arul28" }
      ]
    }
    """#.utf8))

    XCTAssertEqual(comment.githubId, 55)
    XCTAssertEqual(comment.nodeId, "IC_kwDOComment")
    XCTAssertEqual(comment.reactions?.count, 2)
    XCTAssertEqual(comment.reactions?.first?.content, "+1")
    XCTAssertEqual(comment.reactions?.first?.count, 3)
    XCTAssertEqual(comment.reactions?.last?.user, "arul28")
  }

  func testPrCommentDecodesWithoutReactionSnapshotFields() throws {
    let comment = try JSONDecoder().decode(PrComment.self, from: Data(#"""
    {
      "id": "comment-legacy",
      "author": "octocat",
      "body": "Queued",
      "source": "issue",
      "url": null,
      "path": null,
      "line": null,
      "createdAt": "2026-08-26T12:00:00Z",
      "updatedAt": null
    }
    """#.utf8))

    XCTAssertNil(comment.githubId)
    XCTAssertNil(comment.nodeId)
    XCTAssertNil(comment.reactions)
  }

  func testPrDetailDecodesNodeIdAndReactions() throws {
    let detail = try JSONDecoder().decode(PrDetail.self, from: Data(#"""
    {
      "prId": "pr-1",
      "body": "Ship it",
      "nodeId": "PR_kwDOPull",
      "reactions": [
        { "id": "roll-up", "content": "hooray", "user": "", "count": 2 }
      ],
      "assignees": [],
      "author": { "login": "octocat" },
      "isDraft": false,
      "labels": [],
      "requestedReviewers": [],
      "milestone": null,
      "linkedIssues": []
    }
    """#.utf8))

    XCTAssertEqual(detail.nodeId, "PR_kwDOPull")
    XCTAssertEqual(detail.reactions?.first?.content, "hooray")
    XCTAssertEqual(detail.reactions?.first?.count, 2)
  }

  func testPrReviewThreadCommentDecodesReactionSnapshotFields() throws {
    let comment = try JSONDecoder().decode(PrReviewThreadComment.self, from: Data(#"""
    {
      "id": "thread-comment-1",
      "author": "reviewer",
      "authorAvatarUrl": null,
      "body": "nit",
      "url": null,
      "createdAt": "2026-08-26T12:00:00Z",
      "updatedAt": null,
      "githubId": 99,
      "reactions": [
        { "id": "r1", "content": "eyes", "user": "octocat" }
      ]
    }
    """#.utf8))

    XCTAssertEqual(comment.githubId, 99)
    XCTAssertEqual(comment.reactions?.first?.content, "eyes")
    XCTAssertEqual(comment.reactions?.first?.user, "octocat")
  }

  func testReconcileKeepsMappedTerminalPrVisibleWhenProjectionOmitsIt() {
    let mapped = mappedPr(state: "merged")
    let reconciled = prReconcileGitHubPullRequests(snapshotItems: [], mappedPrs: [mapped])

    XCTAssertEqual(reconciled.count, 1)
    XCTAssertEqual(reconciled[0].state, "merged")
    XCTAssertEqual(reconciled[0].linkedPrId, mapped.id)
    XCTAssertEqual(reconciled[0].linkedLaneId, mapped.laneId)
  }

  func testReconcileLetsReplicatedTerminalStateOverrideStaleOpenProjection() {
    let mapped = mappedPr(state: "closed")
    let reconciled = prReconcileGitHubPullRequests(
      snapshotItems: [githubItem(state: "open")],
      mappedPrs: [mapped]
    )

    XCTAssertEqual(reconciled.count, 1)
    XCTAssertEqual(reconciled[0].state, "closed")
    XCTAssertEqual(reconciled[0].linkedPrId, mapped.id)
  }

  func testReconcileLetsNewerReplicatedReopenOverrideStaleClosedProjection() {
    let mapped = mappedPr(state: "open")
    let reconciled = prReconcileGitHubPullRequests(
      snapshotItems: [githubItem(state: "closed")],
      mappedPrs: [mapped]
    )

    XCTAssertEqual(reconciled.count, 1)
    XCTAssertEqual(reconciled[0].state, "open")
    XCTAssertEqual(reconciled[0].updatedAt, mapped.updatedAt)
  }

  /// Another machine's lane fills only a row the focused machine does not
  /// link; the focused link always wins, the first other machine wins over a
  /// later one, and no other machine's PR row id ever becomes `linkedPrId`.
  func testRemoteLaneLinksFillOnlyRowsTheFocusedMachineDoesNotLink() {
    func link(_ machineKey: String, owner: String = "arul28", number: Int = 849) -> PrRemoteLaneLink {
      PrRemoteLaneLink(
        repoOwner: owner, repoName: "ADE", githubPrNumber: number,
        laneId: workRemoteLaneId(machineKey: machineKey, laneId: "lane-\(machineKey)"),
        laneName: "lane on \(machineKey)", machineKey: machineKey, machineName: machineKey
      )
    }
    var focusedLinked = githubItem(state: "open")
    focusedLinked.linkedPrId = "pr-849"
    focusedLinked.linkedLaneId = "lane-849"
    var external = githubItem(state: "open")
    external.scope = "external"

    let cases: [(item: GitHubPrListItem, links: [PrRemoteLaneLink], laneId: String?, laneName: String?)] = [
      (githubItem(state: "open"), [link("mac-b")], workRemoteLaneId(machineKey: "mac-b", laneId: "lane-mac-b"), "lane on mac-b"),
      (githubItem(state: "open"), [link("mac-b", owner: "ARUL28")], workRemoteLaneId(machineKey: "mac-b", laneId: "lane-mac-b"), "lane on mac-b"),
      (githubItem(state: "open"), [link("mac-b"), link("pc-c")], workRemoteLaneId(machineKey: "mac-b", laneId: "lane-mac-b"), "lane on mac-b"),
      (githubItem(state: "open"), [link("mac-b", number: 850)], nil, nil),
      (focusedLinked, [link("mac-b")], "lane-849", nil),
      (external, [link("mac-b")], nil, nil),
    ]
    for (index, testCase) in cases.enumerated() {
      let merged = prApplyRemoteLaneLinks([testCase.item], links: testCase.links)
      XCTAssertEqual(merged.count, 1, "case \(index)")
      XCTAssertEqual(merged[0].linkedLaneId, testCase.laneId, "case \(index)")
      XCTAssertEqual(merged[0].linkedLaneName, testCase.laneName, "case \(index)")
      XCTAssertEqual(merged[0].linkedPrId, testCase.item.linkedPrId, "case \(index)")
    }
  }

  func testSyntheticGitHubRouteRoundTripsCoordinates() {
    let route = prSyntheticGitHubId(repoOwner: "arul28", repoName: "ADE", githubPrNumber: 849)
    let coords = prGitHubCoordinates(fromRouteId: route)

    XCTAssertEqual(route, "gh:arul28/ADE#849")
    XCTAssertEqual(coords?.repoOwner, "arul28")
    XCTAssertEqual(coords?.repoName, "ADE")
    XCTAssertEqual(coords?.githubPrNumber, 849)
  }

  /// The host's `parseSyntheticGithubPrId` is now a strict regex because every
  /// PR mutation resolves through it. The iOS parser decides whether this client
  /// treats a route id as actionable at all, so it has to reject the same ids —
  /// otherwise the detail screen offers Merge and Close for a target the host
  /// will refuse, and a crafted deep link becomes a live-looking action row.
  func testSyntheticGitHubRouteRejectsIdsThatEscapeTheRepoSegment() {
    // The traversal payload the host regex was tightened for: a permissive repo
    // group let this resolve to a caller-chosen API path.
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "gh:x/../../user/repos#999#1"))
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "gh:owner/repo/extra#1"))
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "gh:owner/re#po#1"))
  }

  func testSyntheticGitHubRouteRejectsMalformedSegments() {
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "gh:/repo#1"), "empty owner")
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "gh:owner/#1"), "empty repo")
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "gh:-owner/repo#1"), "leading hyphen owner")
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "gh:own er/repo#1"), "space in owner")
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "gh:owner/repo#0"), "zero PR number")
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "gh:owner/repo#+1"), "signed PR number")
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "gh:owner/repo#-1"), "negative PR number")
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "gh:owner/repo#"), "missing PR number")
    XCTAssertNil(prGitHubCoordinates(fromRouteId: "owner/repo#1"), "missing gh: prefix")
  }

  func testSyntheticGitHubRouteAcceptsRealGitHubNameGrammar() {
    let dotted = prGitHubCoordinates(fromRouteId: "gh:my-org/my.repo_name-2#12")
    XCTAssertEqual(dotted?.repoOwner, "my-org")
    XCTAssertEqual(dotted?.repoName, "my.repo_name-2")
    XCTAssertEqual(dotted?.githubPrNumber, 12)
  }

  /// Merging no longer deletes the head branch (`LandPrArgs.deleteRemoteBranch`
  /// defaults to false) and closing never did, so the confirmation has to say
  /// the branch survives rather than leave the user guessing.
  func testCloseConfirmationCopyPromisesTheBranchIsKept() {
    XCTAssertEqual(prCloseConfirmationTitle(prNumber: 849), "Close pull request #849?")
    XCTAssertEqual(prCloseConfirmationTitle(prNumber: nil), "Close pull request?")
    XCTAssertEqual(prCloseConfirmationTitle(prNumber: 0), "Close pull request?")

    let message = prCloseConfirmationMessage(headBranch: "ade/prs-tab-ux-ledger")
    XCTAssertTrue(message.contains("ade/prs-tab-ux-ledger"))
    XCTAssertTrue(message.contains("kept"))
    XCTAssertTrue(message.contains("reopen"))
    XCTAssertFalse(prCloseConfirmationMessage(headBranch: "   ").contains("The branch  "))
  }

  func testPartialMobileDetailRetainsLastGoodSidecars() {
    let previous = PullRequestSnapshot(
      detail: nil,
      status: nil,
      checks: [check(name: "CI", conclusion: "success")],
      reviews: [],
      comments: [],
      files: [PrFile(filename: "old.swift", status: "modified", additions: 1, deletions: 0, patch: nil, previousFilename: nil)],
      commits: nil
    )
    let incoming = PullRequestSnapshot(
      detail: nil,
      status: nil,
      checks: [],
      reviews: [],
      comments: [],
      files: [PrFile(filename: "new.swift", status: "added", additions: 2, deletions: 0, patch: nil, previousFilename: nil)],
      commits: nil
    )

    let merged = prMergeMobileGithubSnapshot(
      incoming: incoming,
      previous: previous,
      unavailableParts: ["checks"]
    )

    XCTAssertEqual(merged.checks.map(\.name), ["CI"])
    XCTAssertEqual(merged.files.map(\.filename), ["new.swift"])
  }

  // MARK: - Helpers

  private func githubItem(state: String) -> GitHubPrListItem {
    GitHubPrListItem(
      id: "node-849", scope: "repo", repoOwner: "arul28", repoName: "ADE",
      githubPrNumber: 849, githubUrl: "https://github.com/arul28/ADE/pull/849",
      title: "Clean up the PR list", state: state, isDraft: false,
      baseBranch: "main", headBranch: "feature/pr-list", headRepoOwner: "arul28",
      headRepoName: "ADE", author: "arul28", createdAt: "2026-07-17T10:00:00Z",
      updatedAt: "2026-07-17T11:00:00Z", linkedPrId: nil, linkedGroupId: nil,
      linkedLaneId: nil, linkedLaneName: nil, adeKind: nil, workflowDisplayState: nil,
      cleanupState: nil, labels: [], isBot: false, commentCount: 3
    )
  }

  private func mappedPr(state: String) -> PullRequestListItem {
    PullRequestListItem(
      id: "pr-849", laneId: "lane-849", laneName: "PR list", projectId: "project-1",
      repoOwner: "arul28", repoName: "ADE", githubPrNumber: 849,
      githubUrl: "https://github.com/arul28/ADE/pull/849", title: "Clean up the PR list",
      state: state, baseBranch: "main", headBranch: "feature/pr-list",
      checksStatus: "passing", reviewStatus: "approved", additions: 12, deletions: 4,
      lastSyncedAt: "2026-07-17T12:00:00Z", createdAt: "2026-07-17T10:00:00Z",
      updatedAt: "2026-07-17T12:00:00Z", adeKind: "single", linkedGroupId: nil,
      linkedGroupType: nil, linkedGroupName: nil, linkedGroupPosition: nil,
      linkedGroupCount: 0, workflowDisplayState: "complete", cleanupState: "none"
    )
  }

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
