import XCTest
@testable import ADE

/// The Work list's two structural rules, neither of which had any coverage:
/// the singleton/headerless lane (desktop `SessionListPane.tsx` `headerlessLaneIds`)
/// and lane ordering (desktop `workLaneOrder.ts` `compareWorkLanes`).
///
/// Both are load-bearing for how the column reads and both are pure, so they are
/// asserted here rather than through a rendered list.
final class WorkSessionGroupingTests: XCTestCase {
  private let now = Date(timeIntervalSince1970: 1_780_000_000)

  // MARK: - Headerless: the singleton rule

  func testSingletonLaneDropsItsHeader() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [makeSession(id: "s-1", laneId: lane.id)],
      lanes: [lane]
    )

    XCTAssertEqual(presentation.sessionGroups.map(\.id), ["lane:lane-a"])
    XCTAssertEqual(presentation.sessionGroups.first?.isHeaderless, true)
  }

  func testLaneWithTwoSessionsKeepsItsHeader() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [
        makeSession(id: "s-1", laneId: lane.id),
        makeSession(id: "s-2", laneId: lane.id),
      ],
      lanes: [lane]
    )

    XCTAssertEqual(presentation.sessionGroups.first?.isHeaderless, false)
  }

  /// A chat and the shells it spawned are one unit. Counting them separately
  /// would summon a header for what the user reads as a single row.
  func testChatWithChildShellsStaysHeaderless() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [
        makeSession(id: "chat-1", laneId: lane.id),
        makeSession(id: "shell-1", laneId: lane.id, chatSessionId: "chat-1"),
        makeSession(id: "shell-2", laneId: lane.id, chatSessionId: "chat-1"),
      ],
      lanes: [lane]
    )

    XCTAssertEqual(presentation.sessionGroups.first?.isHeaderless, true)
  }

  func testPinnedLaneKeepsItsHeader() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [makeSession(id: "s-1", laneId: lane.id)],
      lanes: [lane],
      pinnedLaneIds: ["lane-a"]
    )

    XCTAssertEqual(presentation.sessionGroups.first?.isHeaderless, false)
  }

  func testPendingHandoffKeepsTheHeader() {
    let ids = workHeaderlessLaneIds([
      WorkHeaderlessLaneInput(laneId: "lane-a", topLevelSessionCount: 1, hasPendingHandoff: true),
      WorkHeaderlessLaneInput(laneId: "lane-b", topLevelSessionCount: 1),
    ])

    XCTAssertEqual(ids, ["lane-b"])
  }

  func testOfflineMachineLaneKeepsTheHeader() {
    let ids = workHeaderlessLaneIds([
      WorkHeaderlessLaneInput(laneId: "lane-a", topLevelSessionCount: 1, machineOnline: false),
      WorkHeaderlessLaneInput(laneId: "lane-b", topLevelSessionCount: 1),
    ])

    XCTAssertEqual(ids, ["lane-b"])
  }

  func testManualSortModeOptsEveryLaneOutOfTheSingletonForm() {
    let ids = workHeaderlessLaneIds(
      [
        WorkHeaderlessLaneInput(laneId: "lane-a", topLevelSessionCount: 1),
        WorkHeaderlessLaneInput(laneId: "lane-b", topLevelSessionCount: 1),
      ],
      sortMode: .manual
    )

    XCTAssertTrue(ids.isEmpty)
  }

  func testEmptyLaneIsNotHeaderless() {
    XCTAssertTrue(workHeaderlessLaneIds([
      WorkHeaderlessLaneInput(laneId: "lane-a", topLevelSessionCount: 0)
    ]).isEmpty)
  }

  /// Rule 1: the threshold reads the unfiltered roster. Without it a search that
  /// narrows a busy lane to one hit would drop the header mid-keystroke, and
  /// put it back on the next one.
  func testSearchNarrowingALaneToOneRowDoesNotDropTheHeader() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [
        makeSession(id: "s-1", laneId: lane.id, title: "Fix login"),
        makeSession(id: "s-2", laneId: lane.id, title: "Audit sync"),
      ],
      lanes: [lane],
      searchText: "login"
    )

    XCTAssertEqual(presentation.displaySessionIds, ["s-1"])
    XCTAssertEqual(presentation.sessionGroups.first?.isHeaderless, false)
  }

  // MARK: - Quiet lanes stay orthogonal

  /// Quiet ("everything here has settled") and headerless ("there is only one
  /// row") answer different questions, and a lane can be both.
  func testSettledSingletonLaneIsBothQuietAndHeaderless() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let settled = makeSession(id: "s-1", laneId: lane.id, settledAt: iso(now.addingTimeInterval(-60)))
    let presentation = makePresentation(sessions: [settled], lanes: [lane])

    let group = presentation.sessionGroups.first
    XCTAssertEqual(group?.isQuiet, true)
    XCTAssertEqual(group?.isHeaderless, true)
  }

  func testQuietLaneWithTwoSessionsKeepsItsHeader() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [
        makeSession(id: "s-1", laneId: lane.id, settledAt: iso(now.addingTimeInterval(-60))),
        makeSession(id: "s-2", laneId: lane.id, settledAt: iso(now.addingTimeInterval(-90))),
      ],
      lanes: [lane]
    )

    let group = presentation.sessionGroups.first
    XCTAssertEqual(group?.isQuiet, true)
    XCTAssertEqual(group?.isHeaderless, false)
  }

  // MARK: - Ordering tiers

  func testPrimaryLaneLeadsEveryTier() {
    // The primary lane is the oldest and quiet — every other key would sink it.
    let primary = makeLane(id: "lane-primary", name: "Primary", laneType: "primary", createdAt: "2026-01-01T00:00:00.000Z")
    let pinned = makeLane(id: "lane-pinned", name: "Pinned", createdAt: "2026-06-01T00:00:00.000Z")
    let active = makeLane(id: "lane-active", name: "Active", createdAt: "2026-05-01T00:00:00.000Z")

    let ordered = orderWorkLanes(
      [active, pinned, primary],
      inputs: [
        "lane-primary": WorkLaneOrderInput(lane: primary, quiet: true),
        "lane-pinned": WorkLaneOrderInput(lane: pinned, pinned: true),
        "lane-active": WorkLaneOrderInput(lane: active),
      ]
    )

    XCTAssertEqual(ordered.map(\.id), ["lane-primary", "lane-pinned", "lane-active"])
  }

  func testTierOrderIsPinnedThenActiveThenQuiet() {
    let quiet = makeLane(id: "lane-quiet", name: "Quiet", createdAt: "2026-07-01T00:00:00.000Z")
    let active = makeLane(id: "lane-active", name: "Active", createdAt: "2026-06-01T00:00:00.000Z")
    let pinned = makeLane(id: "lane-pinned", name: "Pinned", createdAt: "2026-05-01T00:00:00.000Z")

    let ordered = orderWorkLanes(
      [quiet, active, pinned],
      inputs: [
        "lane-quiet": WorkLaneOrderInput(lane: quiet, quiet: true),
        "lane-active": WorkLaneOrderInput(lane: active),
        // A pin outranks quietness, and it also outranks being the oldest lane.
        "lane-pinned": WorkLaneOrderInput(lane: pinned, pinned: true),
      ]
    )

    XCTAssertEqual(ordered.map(\.id), ["lane-pinned", "lane-active", "lane-quiet"])
  }

  func testPinOutranksQuietness() {
    let pinnedQuiet = makeLane(id: "lane-pinned", name: "Pinned", createdAt: "2026-05-01T00:00:00.000Z")
    let active = makeLane(id: "lane-active", name: "Active", createdAt: "2026-06-01T00:00:00.000Z")

    let ordered = orderWorkLanes(
      [active, pinnedQuiet],
      inputs: [
        "lane-pinned": WorkLaneOrderInput(lane: pinnedQuiet, quiet: true, pinned: true),
        "lane-active": WorkLaneOrderInput(lane: active),
      ]
    )

    XCTAssertEqual(ordered.map(\.id), ["lane-pinned", "lane-active"])
  }

  func testCreatedModeSortsNewestFirstWithinATier() {
    let older = makeLane(id: "lane-older", name: "Older", createdAt: "2026-05-01T00:00:00.000Z")
    let newer = makeLane(id: "lane-newer", name: "Newer", createdAt: "2026-06-01T00:00:00.000Z")

    let ordered = orderWorkLanes(
      [older, newer],
      inputs: [
        "lane-older": WorkLaneOrderInput(lane: older),
        "lane-newer": WorkLaneOrderInput(lane: newer),
      ]
    )

    XCTAssertEqual(ordered.map(\.id), ["lane-newer", "lane-older"])
  }

  func testActivityModeSortsByLatestActivityAndFilesLanesWithNoneLast() {
    let quietest = makeLane(id: "lane-c", name: "C", createdAt: "2026-06-03T00:00:00.000Z")
    let busiest = makeLane(id: "lane-a", name: "A", createdAt: "2026-06-01T00:00:00.000Z")
    let middle = makeLane(id: "lane-b", name: "B", createdAt: "2026-06-02T00:00:00.000Z")

    let ordered = orderWorkLanes(
      [quietest, busiest, middle],
      inputs: [
        "lane-c": WorkLaneOrderInput(lane: quietest, lastActivityAt: nil),
        "lane-a": WorkLaneOrderInput(lane: busiest, lastActivityAt: now),
        "lane-b": WorkLaneOrderInput(lane: middle, lastActivityAt: now.addingTimeInterval(-600)),
      ],
      mode: .activity
    )

    XCTAssertEqual(ordered.map(\.id), ["lane-a", "lane-b", "lane-c"])
  }

  /// The comparator has to be total, or two lanes that tie on every key swap
  /// places between renders and the column visibly jitters.
  func testIdBreaksAnOtherwiseCompleteTie() {
    let left = makeLane(id: "lane-b", name: "Same", createdAt: "2026-06-01T00:00:00.000Z")
    let right = makeLane(id: "lane-a", name: "Same", createdAt: "2026-06-01T00:00:00.000Z")

    let ordered = orderWorkLanes(
      [left, right],
      inputs: [
        "lane-b": WorkLaneOrderInput(lane: left),
        "lane-a": WorkLaneOrderInput(lane: right),
      ]
    )

    XCTAssertEqual(ordered.map(\.id), ["lane-a", "lane-b"])
  }

  func testManualModeFilesUnplacedLanesAfterEveryPlacedOne() {
    let placed = makeLane(id: "lane-placed", name: "Placed", createdAt: "2026-05-01T00:00:00.000Z")
    let unplaced = makeLane(id: "lane-unplaced", name: "Unplaced", createdAt: "2026-07-01T00:00:00.000Z")

    let ordered = orderWorkLanes(
      [unplaced, placed],
      inputs: [
        "lane-placed": WorkLaneOrderInput(lane: placed),
        "lane-unplaced": WorkLaneOrderInput(lane: unplaced),
      ],
      mode: .manual,
      manualOrder: ["lane-placed"]
    )

    XCTAssertEqual(ordered.map(\.id), ["lane-placed", "lane-unplaced"])
  }

  func testPresentationOrdersLanesByTier() {
    let primary = makeLane(id: "lane-primary", name: "Primary", laneType: "primary", createdAt: "2026-01-01T00:00:00.000Z")
    let quiet = makeLane(id: "lane-quiet", name: "Quiet", createdAt: "2026-07-01T00:00:00.000Z")
    let active = makeLane(id: "lane-active", name: "Active", createdAt: "2026-06-01T00:00:00.000Z")

    let presentation = makePresentation(
      sessions: [
        makeSession(id: "s-primary", laneId: primary.id),
        makeSession(id: "s-quiet", laneId: quiet.id, settledAt: iso(now.addingTimeInterval(-60))),
        makeSession(id: "s-active", laneId: active.id),
      ],
      lanes: [quiet, active, primary]
    )

    XCTAssertEqual(
      presentation.sessionGroups.map(\.id),
      ["lane:lane-primary", "lane:lane-active", "lane:lane-quiet"]
    )
  }

  // MARK: - Offline machine banner

  func testOfflineBannerSurfacesOneEntryPerMachineInThisProject() {
    let banners = workOfflineMachineBanners(
      scopes: [
        scope(machineKey: "studio", projectId: "project-1", laneId: "lane-a"),
        scope(machineKey: "studio", projectId: "project-1", laneId: "lane-b"),
        scope(machineKey: "laptop", projectId: "project-1", laneId: "lane-c"),
      ],
      activeProjectId: "project-1",
      now: now
    )

    XCTAssertEqual(banners.map(\.machineName), ["laptop", "studio"])
    XCTAssertEqual(banners.first?.lastSeenLabel, "last seen 2h ago")
  }

  func testOfflineBannerIgnoresOtherProjects() {
    let banners = workOfflineMachineBanners(
      scopes: [scope(machineKey: "studio", projectId: "project-2", laneId: "lane-z")],
      activeProjectId: "project-1",
      now: now
    )

    XCTAssertTrue(banners.isEmpty)
  }

  /// Items published before a project id was carried still match through the
  /// lane they name, so an outage is not silently dropped.
  func testOfflineBannerFallsBackToLaneScope() {
    let banners = workOfflineMachineBanners(
      scopes: [scope(machineKey: "studio", projectId: "", laneId: "lane-a")],
      activeProjectId: "project-1",
      laneIds: ["lane-a"],
      now: now
    )

    XCTAssertEqual(banners.map(\.id), ["studio"])
  }

  // MARK: - Fixtures

  private func makePresentation(
    sessions: [TerminalSessionSummary],
    lanes: [LaneSummary],
    pinnedLaneIds: Set<String> = [],
    searchText: String = ""
  ) -> WorkRootSessionPresentation {
    buildWorkRootSessionPresentation(
      sessions: sessions,
      optimisticSessions: [:],
      chatSummaries: [:],
      archivedSessionIds: [],
      selectedStatus: .all,
      selectedLaneId: "all",
      searchText: searchText,
      organization: .byLane,
      orderedLanes: lanes,
      pinnedLaneIds: pinnedLaneIds,
      now: now
    )
  }

  private func scope(machineKey: String, projectId: String, laneId: String?) -> ActivityOfflineScope {
    ActivityOfflineScope(
      machineKey: machineKey,
      machineName: machineKey,
      lastSeenAt: now.addingTimeInterval(-2 * 60 * 60),
      projectId: projectId,
      laneId: laneId
    )
  }

  private func iso(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }

  private func makeSession(
    id: String,
    laneId: String,
    title: String = "Session",
    status: String = "running",
    runtimeState: String = "running",
    settledAt: String? = nil,
    chatSessionId: String? = nil
  ) -> TerminalSessionSummary {
    TerminalSessionSummary(
      id: id,
      laneId: laneId,
      laneName: laneId,
      ptyId: nil,
      tracked: true,
      pinned: false,
      manuallyNamed: nil,
      goal: nil,
      toolType: "codex-chat",
      title: title,
      status: status,
      startedAt: iso(now.addingTimeInterval(-300)),
      endedAt: nil,
      archivedAt: nil,
      settledAt: settledAt,
      exitCode: nil,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: nil,
      summary: nil,
      runtimeState: settledAt == nil ? runtimeState : "idle",
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: nil,
      chatSessionId: chatSessionId
    )
  }

  private func makeLane(
    id: String,
    name: String,
    laneType: String = "worktree",
    createdAt: String = "2026-06-01T00:00:00.000Z"
  ) -> LaneSummary {
    LaneSummary(
      id: id,
      name: name,
      description: nil,
      laneType: laneType,
      baseRef: "main",
      branchRef: "feature/\(id)",
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
      createdAt: createdAt,
      archivedAt: nil
    )
  }
}
