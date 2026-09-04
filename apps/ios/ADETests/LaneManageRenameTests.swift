import XCTest
@testable import ADE

final class LaneManageRenameTests: XCTestCase {
  func testPrimaryLaneCannotRename() {
    XCTAssertFalse(LaneManageRename.canRename(laneType: "primary"))
    XCTAssertTrue(LaneManageRename.canRename(laneType: "worktree"))
    XCTAssertFalse(LaneManageRename.showsRenameControl(laneType: "primary", hostSupportsRename: true))
    XCTAssertFalse(LaneManageRename.showsRenameControl(laneType: "worktree", hostSupportsRename: false))
    XCTAssertTrue(LaneManageRename.showsRenameControl(laneType: "worktree", hostSupportsRename: true))
  }

  func testSaveRejectsEmptyUnchangedAndWhitespace() {
    XCTAssertFalse(LaneManageRename.canSave(draft: "", currentName: "Auth"))
    XCTAssertFalse(LaneManageRename.canSave(draft: "   ", currentName: "Auth"))
    XCTAssertFalse(LaneManageRename.canSave(draft: "Auth", currentName: "Auth"))
    XCTAssertFalse(LaneManageRename.canSave(draft: "  Auth  ", currentName: "Auth"))
    XCTAssertTrue(LaneManageRename.canSave(draft: "Auth fallback", currentName: "Auth"))
    XCTAssertTrue(LaneManageRename.canSave(draft: "auth", currentName: "Auth"))
  }

  func testDuplicateNameIgnoresSelfAndArchivedLanes() {
    let current = makeLane(id: "lane-a", name: "Auth")
    let sibling = makeLane(id: "lane-b", name: "Search")
    let archived = makeLane(id: "lane-c", name: "Auth fallback", archivedAt: "2026-01-01T00:00:00.000Z")

    XCTAssertNil(
      LaneManageRename.duplicateName(
        draft: "Auth",
        laneId: current.id,
        among: [current, sibling, archived]
      )
    )
    XCTAssertEqual(
      LaneManageRename.duplicateName(
        draft: "search",
        laneId: current.id,
        among: [current, sibling, archived]
      ),
      "Search"
    )
    XCTAssertNil(
      LaneManageRename.duplicateName(
        draft: "Auth fallback",
        laneId: current.id,
        among: [current, sibling, archived]
      )
    )
  }

  func testMetadataAccessibilityLabelIncludesDirtyStatus() {
    XCTAssertEqual(
      LaneManageRename.metadataAccessibilityLabel(
        noun: "Branch",
        value: "ade/auth",
        dirty: false
      ),
      "Branch, ade/auth"
    )
    XCTAssertEqual(
      LaneManageRename.metadataAccessibilityLabel(
        noun: "Branch",
        value: "ade/auth",
        dirty: true
      ),
      "Branch, ade/auth, dirty"
    )
    XCTAssertEqual(
      LaneManageRename.metadataAccessibilityLabel(
        noun: "Path",
        value: "/tmp/lane",
        dirty: false
      ),
      "Path, /tmp/lane"
    )
  }

  private func makeLane(id: String, name: String, archivedAt: String? = nil) -> LaneSummary {
    LaneSummary(
      id: id,
      name: name,
      description: nil,
      laneType: "worktree",
      baseRef: "main",
      branchRef: "ade/\(id)",
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
      createdAt: "2026-06-01T00:00:00.000Z",
      archivedAt: archivedAt
    )
  }
}
