import XCTest
@testable import ADE

final class WorkChatPrScopeTests: XCTestCase {

  func testSelectPrefersExplicitEdgesAndKeepsCrossLaneStackMembers() {
    let catalog = [
      item(id: "legacy", number: 10, laneId: "lane-a", head: "feat/a"),
      item(id: "child", number: 11, laneId: "lane-child", sessions: ["chat-child"]),
      item(id: "parent", number: 12, laneId: "lane-parent", sessions: ["chat-child"]),
    ]

    XCTAssertEqual(
      workChatSelectPrsForChat(catalog, sessionId: "chat-child", currentBranch: "feat/a").map(\.id),
      ["child", "parent"]
    )
  }

  func testSelectNeverShowsAnotherChatsClaimOrADismissedUnlink() {
    let catalog = [
      item(id: "claimed", number: 20, sessions: ["chat-a"]),
      item(id: "unlinked", number: 21, head: "feat/c", dismissed: ["chat-c"]),
      item(id: "open", number: 22, head: "feat/c"),
    ]

    XCTAssertEqual(
      workChatSelectPrsForChat(catalog, sessionId: "chat-c", currentBranch: "feat/c").map(\.id),
      ["open"]
    )
  }

  func testStackOfferSkipsAlreadyLinkedAndClaimedSiblings() {
    let selected = item(
      id: "bottom",
      number: 30,
      sessions: ["chat-1"],
      stack: GitHubPrStackMembership(id: "s3", number: 3, size: 3, position: 1, baseBranch: "main")
    )
    let catalog = [
      selected,
      item(
        id: "linked",
        number: 31,
        sessions: ["chat-1"],
        stack: GitHubPrStackMembership(id: "s3", number: 3, size: 3, position: 2, baseBranch: "main")
      ),
      item(
        id: "claimed",
        number: 32,
        sessions: ["chat-other"],
        stack: GitHubPrStackMembership(id: "s3", number: 3, size: 3, position: 3, baseBranch: "main")
      ),
      item(
        id: "offer",
        number: 33,
        stack: GitHubPrStackMembership(id: "s3", number: 3, size: 4, position: 4, baseBranch: "main")
      ),
    ]

    let offer = workChatStackOffer(selected: selected, catalog: catalog, sessionId: "chat-1")
    XCTAssertEqual(offer?.stackNumber, 3)
    XCTAssertEqual(offer?.siblings.map(\.id), ["offer"])
  }

  func testRankFilesByChurnReturnsTheTopThree() {
    let ranked = workChatRankPrFilesByChurn([
      PrFile(filename: "a.ts", status: "modified", additions: 1, deletions: 1, patch: nil, previousFilename: nil),
      PrFile(filename: "b.ts", status: "modified", additions: 40, deletions: 2, patch: nil, previousFilename: nil),
      PrFile(filename: "c.ts", status: "modified", additions: 8, deletions: 8, patch: nil, previousFilename: nil),
      PrFile(filename: "d.ts", status: "added", additions: 3, deletions: 0, patch: nil, previousFilename: nil),
    ], limit: 3)
    XCTAssertEqual(ranked.files.map(\.filename), ["b.ts", "c.ts", "d.ts"])
    XCTAssertEqual(ranked.remaining, 1)
  }

  private func item(
    id: String,
    number: Int,
    laneId: String = "lane-1",
    head: String = "feat/a",
    sessions: [String]? = nil,
    dismissed: [String]? = nil,
    stack: GitHubPrStackMembership? = nil
  ) -> PullRequestListItem {
    PullRequestListItem(
      id: id,
      laneId: laneId,
      laneName: laneId,
      projectId: "project-1",
      repoOwner: "ade",
      repoName: "desktop",
      githubPrNumber: number,
      githubUrl: "https://github.com/ade/desktop/pull/\(number)",
      title: id,
      state: "open",
      baseBranch: "main",
      headBranch: head,
      checksStatus: "none",
      reviewStatus: "none",
      additions: 0,
      deletions: 0,
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
      cleanupState: nil,
      stack: stack,
      chatSessionIds: sessions,
      dismissedChatSessionIds: dismissed
    )
  }
}
