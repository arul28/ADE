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

  // MARK: - The quiet zone

  /// Every list closes the same way: Snoozed above Settled. Snoozed work is
  /// dated and will re-enter the live rows, settled work is finished, so the
  /// shelf nearer the live rows is the one that comes back.
  func testByStatusClosesWithSnoozedAboveSettled() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [
        makeSession(id: "s-live", laneId: lane.id),
        makeSession(id: "s-settled", laneId: lane.id, settledAt: iso(now.addingTimeInterval(-60))),
        makeSession(
          id: "s-snoozed",
          laneId: lane.id,
          snoozedUntil: iso(now.addingTimeInterval(3600)),
          snoozedAt: iso(now.addingTimeInterval(-60))
        ),
      ],
      lanes: [lane],
      organization: .byStatus
    )

    XCTAssertEqual(
      presentation.sessionGroups.map(\.id),
      ["status:running", workSnoozedSectionId, workSettledSectionId]
    )
    XCTAssertEqual(presentation.sessionGroups.last?.sessions.map(\.id), ["s-settled"])
  }

  func testByTimeClosesWithSnoozedAboveSettled() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [
        makeSession(id: "s-live", laneId: lane.id),
        makeSession(id: "s-settled", laneId: lane.id, settledAt: iso(now.addingTimeInterval(-60))),
        makeSession(
          id: "s-snoozed",
          laneId: lane.id,
          snoozedUntil: iso(now.addingTimeInterval(3600)),
          snoozedAt: iso(now.addingTimeInterval(-60))
        ),
      ],
      lanes: [lane],
      organization: .byTime
    )

    XCTAssertEqual(
      Array(presentation.sessionGroups.map(\.id).suffix(2)),
      [workSnoozedSectionId, workSettledSectionId]
    )
    XCTAssertFalse(
      presentation.sessionGroups.dropLast(2).contains { $0.sessions.contains { $0.id == "s-settled" } },
      "a lifted settled row must not also remain in its time bucket"
    )
  }

  /// By-lane has no global settled shelf on purpose: a settled row still belongs
  /// to its lane, and lifting settled rows out globally would leave lanes empty
  /// and make the per-lane quiet fold unreachable.
  func testByLaneKeepsSettledRowsInsideTheirLane() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [
        makeSession(id: "s-live", laneId: lane.id),
        makeSession(id: "s-settled", laneId: lane.id, settledAt: iso(now.addingTimeInterval(-60))),
      ],
      lanes: [lane],
      organization: .byLane
    )

    XCTAssertEqual(presentation.sessionGroups.map(\.id), ["lane:lane-a"])
    XCTAssertEqual(presentation.sessionGroups.first?.sessions.map(\.id), ["s-live", "s-settled"])
    XCTAssertFalse(presentation.sessionGroups.contains { $0.isShelf })
  }

  /// The fold this exemption exists to protect.
  func testByLaneStillFoldsAnAllQuietLane() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [
        makeSession(id: "s-1", laneId: lane.id, settledAt: iso(now.addingTimeInterval(-60))),
        makeSession(id: "s-2", laneId: lane.id, settledAt: iso(now.addingTimeInterval(-90))),
      ],
      lanes: [lane],
      organization: .byLane
    )

    XCTAssertEqual(presentation.sessionGroups.map(\.id), ["lane:lane-a"])
    XCTAssertEqual(presentation.sessionGroups.first?.isQuiet, true)
    XCTAssertEqual(presentation.sessionGroups.first?.isShelf, false)
  }

  /// `collapsedSectionIds` lists what IS collapsed, so it cannot express
  /// "collapsed by default". Both shelves therefore record the opposite fact
  /// under a `shelf-open:` marker, and stay collapsed while it is absent.
  func testQuietShelvesAreCollapsedUntilTheirOpenMarkerIsPresent() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [
        makeSession(id: "s-settled", laneId: lane.id, settledAt: iso(now.addingTimeInterval(-60))),
        makeSession(
          id: "s-snoozed",
          laneId: lane.id,
          snoozedUntil: iso(now.addingTimeInterval(3600)),
          snoozedAt: iso(now.addingTimeInterval(-60))
        ),
      ],
      lanes: [lane],
      organization: .byStatus
    )

    let shelves = presentation.sessionGroups.filter(\.isShelf)
    XCTAssertEqual(shelves.map(\.id), [workSnoozedSectionId, workSettledSectionId])
    XCTAssertEqual(
      shelves.map(\.quietOpenSectionId),
      ["shelf-open:status:snoozed", "shelf-open:status:settled"]
    )
    // A shelf renders through the quiet-header form, which is what makes the
    // inverted marker the one the toggle writes.
    XCTAssertTrue(shelves.allSatisfy(\.isQuiet))

    // Untouched: no marker, so both are collapsed. Explicitly opened: marker
    // present, and it survives a relaunch because it is what gets persisted.
    var collapsed = workParseCollapsedSectionIds("")
    XCTAssertTrue(shelves.allSatisfy { !collapsed.contains($0.quietOpenSectionId) })
    collapsed.insert("shelf-open:status:settled")
    XCTAssertEqual(
      shelves.filter { collapsed.contains($0.quietOpenSectionId) }.map(\.id),
      [workSettledSectionId]
    )

    // The shelf namespace must stay clear of the per-lane sweep, which only
    // scans `lane-open:` and would otherwise treat a shelf as a stale lane.
    XCTAssertFalse(shelves.contains { $0.quietOpenSectionId.hasPrefix("lane-open:") })
  }

  // MARK: - One clock per grouping pass

  /// By-status used to read the wall clock while every sibling filing path (the
  /// shelf lift, `workLaneGroupIsQuiet`, `isFiledAsSnoozed`) threaded the
  /// caller's. This row is calm at `now` and silent past the stale threshold a
  /// few hours later, so the two clocks file it under different headers — which
  /// is exactly what a single threaded clock has to prevent.
  func testByStatusFilesAgainstTheInjectedClock() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let calm = makeSession(
      id: "s-1",
      laneId: lane.id,
      runtimeState: "idle",
      chatIdleSinceAt: iso(now.addingTimeInterval(-60))
    )

    XCTAssertEqual(
      workSessionGroups(
        organization: .byStatus,
        sessions: [calm],
        chatSummaries: [:],
        archivedSessionIds: [],
        orderedLanes: [lane],
        now: now
      ).map(\.id),
      ["status:done"]
    )

    XCTAssertEqual(
      workSessionGroups(
        organization: .byStatus,
        sessions: [calm],
        chatSummaries: [:],
        archivedSessionIds: [],
        orderedLanes: [lane],
        now: now.addingTimeInterval(sessionStaleAfterSeconds + 60)
      ).map(\.id),
      ["status:running"]
    )
  }

  /// The contract the shared clock exists for: one session, one instant, the
  /// same verdict on both paths. Settled here, so by-status lifts it onto the
  /// quiet shelf and by-lane folds its lane into the quiet form — two shapes,
  /// one reading of the row.
  func testByStatusAndByLaneAgreeOnTheSameSessionAtTheSameInstant() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let settled = makeSession(
      id: "s-1",
      laneId: lane.id,
      settledAt: iso(now.addingTimeInterval(-60))
    )

    let byStatus = workSessionGroups(
      organization: .byStatus,
      sessions: [settled],
      chatSummaries: [:],
      archivedSessionIds: [],
      orderedLanes: [lane],
      now: now
    )
    XCTAssertEqual(byStatus.map(\.id), [workSettledSectionId])
    XCTAssertEqual(byStatus.first?.isQuiet, true)
    XCTAssertEqual(byStatus.first?.sessions.map(\.id), ["s-1"])

    let byLane = workSessionGroups(
      organization: .byLane,
      sessions: [settled],
      chatSummaries: [:],
      archivedSessionIds: [],
      orderedLanes: [lane],
      now: now
    )
    XCTAssertEqual(byLane.map(\.id), ["lane:lane-a"])
    XCTAssertEqual(byLane.first?.isQuiet, true)
    XCTAssertEqual(byLane.first?.sessions.map(\.id), ["s-1"])
  }

  // MARK: - Finished is not "Needs you"

  /// Ready and idle are emerald "Done" — finished, unseen. Filing them under
  /// the amber "Needs you" header is the exact confusion the shared vocabulary
  /// exists to kill: amber must mean a session blocked on the user, nothing else.
  func testReadyAndIdleLandInDoneAndNeedsYouHoldsOnlyARaisedHand() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let presentation = makePresentation(
      sessions: [
        makeSession(id: "s-needs-you", laneId: lane.id, pendingInputItemId: "item-1"),
        // A chat resting between turns is `.ready`.
        makeSession(id: "s-ready", laneId: lane.id, runtimeState: "idle"),
        // The same shape on a non-chat tool is `.idle`.
        makeSession(id: "s-idle", laneId: lane.id, toolType: "codex", runtimeState: "idle"),
      ],
      lanes: [lane],
      organization: .byStatus
    )

    let sessionIdsBySectionId = Dictionary(
      uniqueKeysWithValues: presentation.sessionGroups.map { ($0.id, $0.sessions.map(\.id)) }
    )
    XCTAssertEqual(sessionIdsBySectionId["status:awaiting"], ["s-needs-you"])
    XCTAssertEqual(sessionIdsBySectionId["status:done"]?.sorted(), ["s-idle", "s-ready"])
  }

  /// The section order is the chip order: what wants you, what is working, what
  /// is blocked on neither, then what is over. `status:ended` is gone — it was
  /// merged into `status:done`, which now holds every outcome, so a "Done" chip
  /// no longer scatters its rows across two headers.
  func testSectionsAreOrderedAndNamedLikeTheChips() {
    let lane = makeLane(id: "lane-a", name: "feature/one")
    let ciLane = makeLane(id: "lane-ci", name: "ci")
    let presentation = makePresentation(
      sessions: [
        makeSession(id: "s-needs-you", laneId: lane.id, pendingInputItemId: "item-1"),
        makeSession(id: "s-working", laneId: lane.id),
        makeSession(id: "s-ci-blocked", laneId: ciLane.id),
        makeSession(id: "s-ready", laneId: lane.id, runtimeState: "idle"),
        makeSession(id: "s-ended", laneId: lane.id, toolType: "codex", status: "detached", runtimeState: "exited"),
      ],
      lanes: [lane, ciLane],
      pullRequests: [makePr(id: "pr-ci", lane: ciLane, checksStatus: "pending")],
      organization: .byStatus
    )

    XCTAssertEqual(
      presentation.sessionGroups.map(\.id),
      ["status:awaiting", "status:running", workWaitingSectionId, "status:done"]
    )
    XCTAssertEqual(
      presentation.sessionGroups.map(\.label),
      ["Needs you", "Working", "Waiting", "Done"]
    )
    XCTAssertEqual(
      presentation.sessionGroups.last?.sessions.map(\.id).sorted(),
      ["s-ended", "s-ready"],
      "the merged Done section holds both what finished and what is over"
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

  // MARK: - Status chips: the board's four columns

  /// The contract the chips inherit from the desktop board: Needs you /
  /// Working / Waiting / Done are a PARTITION of the non-archived list. No row
  /// may answer to two chips, and none may fall through all four.
  func testStatusChipsPartitionTheWorkList() {
    let plainLane = makeLane(id: "lane-plain", name: "plain")
    let ciLane = makeLane(id: "lane-ci", name: "ci")
    let sessions = [
      makeSession(id: "s-needs-you", laneId: plainLane.id, pendingInputItemId: "input-1"),
      makeSession(id: "s-working", laneId: plainLane.id),
      makeSession(id: "s-ci-blocked", laneId: ciLane.id),
      makeSession(
        id: "s-snoozed",
        laneId: plainLane.id,
        snoozedUntil: iso(now.addingTimeInterval(3600)),
        snoozedAt: iso(now.addingTimeInterval(-60))
      ),
      makeSession(
        id: "s-snoozed-needs-you",
        laneId: plainLane.id,
        snoozedUntil: iso(now.addingTimeInterval(3600)),
        snoozedAt: iso(now.addingTimeInterval(-60)),
        pendingInputItemId: "input-2"
      ),
      makeSession(id: "s-ended", laneId: plainLane.id, toolType: "shell", status: "ended", runtimeState: "exited"),
      makeSession(id: "s-settled", laneId: plainLane.id, settledAt: iso(now.addingTimeInterval(-60))),
    ]
    let reasons = workLaneWaitingReasonByLaneId(
      lanes: [plainLane, ciLane],
      pullRequests: [makePr(id: "pr-ci", lane: ciLane, checksStatus: "pending")]
    )

    let buckets = [
      WorkSessionStatusFilter.needsYou,
      .working,
      .waiting,
      .done,
    ].map { status in
      Set(filteredIds(sessions, status: status, laneWaitingReasons: reasons))
    }

    for (index, bucket) in buckets.enumerated() {
      for other in buckets[(index + 1)...] {
        XCTAssertTrue(
          bucket.isDisjoint(with: other),
          "A session answered to two chips: \(bucket.intersection(other))"
        )
      }
    }
    XCTAssertEqual(
      buckets.reduce(into: Set<String>()) { $0.formUnion($1) },
      Set(sessions.map(\.id)),
      "Every non-archived session belongs to exactly one chip"
    )
  }

  /// Waiting is assembled first, from the two things that block a row on
  /// neither you nor the agent: a snooze, and a live lane PR still on CI.
  func testWaitingChipHoldsSnoozedAndPrBlockedSessions() {
    let plainLane = makeLane(id: "lane-plain", name: "plain")
    let ciLane = makeLane(id: "lane-ci", name: "ci")
    let sessions = [
      makeSession(id: "s-working", laneId: plainLane.id),
      makeSession(id: "s-ci-blocked", laneId: ciLane.id),
      makeSession(
        id: "s-snoozed",
        laneId: plainLane.id,
        snoozedUntil: iso(now.addingTimeInterval(3600)),
        snoozedAt: iso(now.addingTimeInterval(-60))
      ),
    ]
    let reasons = workLaneWaitingReasonByLaneId(
      lanes: [plainLane, ciLane],
      pullRequests: [makePr(id: "pr-ci", lane: ciLane, checksStatus: "pending")]
    )

    XCTAssertEqual(
      Set(filteredIds(sessions, status: .waiting, laneWaitingReasons: reasons)),
      ["s-snoozed", "s-ci-blocked"]
    )
    XCTAssertEqual(
      filteredIds(sessions, status: .working, laneWaitingReasons: reasons),
      ["s-working"],
      "Working is what is LEFT of the running set once Waiting is taken out"
    )
  }

  /// With no PRs loaded the lane map is empty, which must read as "no PR wait
  /// known" and leave every running row in Working — never as a wait.
  func testWaitingChipFallsBackToSnoozeOnlyWithoutPrs() {
    let lane = makeLane(id: "lane-plain", name: "plain")
    let sessions = [
      makeSession(id: "s-working", laneId: lane.id),
      makeSession(
        id: "s-snoozed",
        laneId: lane.id,
        snoozedUntil: iso(now.addingTimeInterval(3600)),
        snoozedAt: iso(now.addingTimeInterval(-60))
      ),
    ]

    XCTAssertEqual(filteredIds(sessions, status: .waiting), ["s-snoozed"])
    XCTAssertEqual(filteredIds(sessions, status: .working), ["s-working"])
  }

  /// The snooze overlay yields to a raised hand, exactly as the filing rule
  /// does — otherwise an "until I'm asked" snooze buries the row asking.
  func testNeedsYouOutranksSnoozeInTheChips() {
    let lane = makeLane(id: "lane-plain", name: "plain")
    let sessions = [
      makeSession(
        id: "s-snoozed-needs-you",
        laneId: lane.id,
        snoozedUntil: iso(now.addingTimeInterval(3600)),
        snoozedAt: iso(now.addingTimeInterval(-60)),
        pendingInputItemId: "input-1"
      ),
    ]

    XCTAssertEqual(filteredIds(sessions, status: .needsYou), ["s-snoozed-needs-you"])
    XCTAssertTrue(filteredIds(sessions, status: .waiting).isEmpty)
  }

  /// Done is ended PLUS settled, the same pair the desktop column holds.
  func testDoneChipHoldsEndedAndSettledSessions() {
    let lane = makeLane(id: "lane-plain", name: "plain")
    let sessions = [
      // A chat that merely stopped rests at `ready`; a standalone shell is the
      // row that actually reaches the ended phase.
      makeSession(id: "s-ended", laneId: lane.id, toolType: "shell", status: "ended", runtimeState: "exited"),
      makeSession(id: "s-settled", laneId: lane.id, settledAt: iso(now.addingTimeInterval(-60))),
      makeSession(id: "s-working", laneId: lane.id),
    ]

    XCTAssertEqual(Set(filteredIds(sessions, status: .done)), ["s-ended", "s-settled"])
  }

  /// `workLanePrWaitingReason` against the desktop rules verbatim: only a live
  /// PR waits, `pending` outranks a review request, and `none`/`not_run`/
  /// `failing` are not waits at all.
  func testLanePrWaitingReasonMirrorsDesktopRules() {
    let lane = makeLane(id: "lane-ci", name: "ci")
    func reason(
      state: String = "open",
      checks: String = "none",
      review: String = "none"
    ) -> WorkBoardWaitingReason? {
      workLanePrWaitingReason([
        makePr(id: "pr-1", lane: lane, state: state, checksStatus: checks, reviewStatus: review)
      ])
    }

    XCTAssertNil(workLanePrWaitingReason([]))
    XCTAssertEqual(reason(checks: "pending"), .ci)
    XCTAssertEqual(reason(review: "requested"), .review)
    XCTAssertEqual(reason(checks: "pending", review: "requested"), .ci, "CI outranks a review request")
    XCTAssertEqual(reason(state: "draft", checks: "pending"), .ci, "A draft PR is still live")
    XCTAssertNil(reason(state: "merged", checks: "pending"), "A merged PR's checks are history")
    XCTAssertNil(reason(state: "closed", review: "requested"))
    XCTAssertNil(reason(checks: "none"))
    XCTAssertNil(reason(checks: "not_run"))
    XCTAssertNil(reason(checks: "failing"), "Failing is the agent's problem, not a wait")
  }

  /// The lane map matches PRs the way the lane's own chip does: same branch,
  /// same lane, and never a row detached from its deleted lane.
  func testLaneWaitingReasonIgnoresForeignAndDetachedPrs() {
    let lane = makeLane(id: "lane-ci", name: "ci")
    let otherLane = makeLane(id: "lane-other", name: "other")

    XCTAssertEqual(
      workLaneWaitingReasonByLaneId(
        lanes: [lane, otherLane],
        pullRequests: [makePr(id: "pr-1", lane: otherLane, checksStatus: "pending")]
      ),
      [otherLane.id: .ci]
    )
    XCTAssertTrue(
      workLaneWaitingReasonByLaneId(
        lanes: [lane],
        pullRequests: [
          makePr(
            id: "pr-detached",
            lane: lane,
            checksStatus: "pending",
            detached: PrDetachedLane(at: iso(now), laneName: lane.name, laneColor: nil, chats: 0, artifacts: 0, checkpoints: 0)
          )
        ]
      ).isEmpty
    )
  }

  /// The chip raw values are persisted per project+host, so they are wire
  /// values, and the case names are not. `needsYou`/`working`/`done` are board
  /// vocabulary on cases whose raw values must still be byte-identical to the
  /// `needsInput`/`running`/`ended` already sitting in every saved view state —
  /// a changed raw value would decode as nil and silently reset the view.
  func testPersistedStatusFilterRawValuesSurviveTheRename() {
    XCTAssertEqual(
      WorkSessionStatusFilter.allCases.map(\.rawValue),
      ["all", "needsInput", "running", "waiting", "ended", "archived"]
    )
    XCTAssertEqual(WorkSessionStatusFilter.needsYou.rawValue, "needsInput")
    XCTAssertEqual(WorkSessionStatusFilter.working.rawValue, "running")
    XCTAssertEqual(WorkSessionStatusFilter.done.rawValue, "ended")

    XCTAssertEqual(WorkSessionStatusFilter(rawValue: "needsInput"), .needsYou)
    XCTAssertEqual(WorkSessionStatusFilter(rawValue: "needsInput")?.title, "Needs you")
    XCTAssertEqual(WorkSessionStatusFilter(rawValue: "running"), .working)
    XCTAssertEqual(WorkSessionStatusFilter(rawValue: "running")?.title, "Working")
    XCTAssertEqual(WorkSessionStatusFilter(rawValue: "ended"), .done)
    XCTAssertEqual(WorkSessionStatusFilter(rawValue: "ended")?.title, "Done")
    XCTAssertEqual(WorkSessionStatusFilter(rawValue: "waiting"), .waiting)

    // The decode WorkRootScreen performs on the stored view state.
    XCTAssertNil(WorkSessionStatusFilter(rawValue: "live"))
    XCTAssertEqual(WorkSessionStatusFilter(rawValue: "live") ?? .all, .all)
    // Every case name is also a non-value on the wire: a build that wrote the
    // Swift spelling instead of the raw value must not decode.
    for caseName in ["needsYou", "working", "done"] {
      XCTAssertNil(
        WorkSessionStatusFilter(rawValue: caseName),
        "\(caseName) is a case name, never a persisted value"
      )
      XCTAssertEqual(WorkSessionStatusFilter(rawValue: caseName) ?? .all, .all)
    }
    XCTAssertEqual(WorkSessionStatusFilter(rawValue: WorkProjectViewState.empty.statusFilter), .all)
  }

  func testWaitingEmptyStateNamesWhatWouldHaveBeenThere() {
    XCTAssertEqual(
      workSessionEmptyStateTitle(status: .waiting, searchText: "", hasFilters: true),
      "Nothing is waiting"
    )
    XCTAssertEqual(
      workSessionEmptyStateMessage(status: .waiting, searchText: "", hasFilters: true, isLive: true),
      "Nothing is snoozed, and no lane PR is sitting on CI or waiting for a review."
    )
    XCTAssertEqual(
      workSessionEmptyStateTitle(status: .working, searchText: "", hasFilters: true),
      "Nothing is working"
    )
  }

  // MARK: - The chips and the section headers are ONE partition

  /// The chip you tap and the header its rows land under must be the same four
  /// buckets with the same four words.
  ///
  /// They were not. The "Done" chip selected `failed|stopped|ended|settled`
  /// while the sections it filed into were a different split — a header called
  /// "Done" holding `ready|idle|settled` and one called "Ended" holding
  /// `failed|stopped|ended` — so tapping Done scattered its own rows across two
  /// differently-named headers, and the "Done" header additionally held resting
  /// rows the Done chip never selected.
  func testStatusSectionsAndChipsNameTheSameFourThings() {
    let plainLane = makeLane(id: "lane-plain", name: "plain")
    let ciLane = makeLane(id: "lane-ci", name: "ci")
    let sessions = [
      makeSession(id: "s-needs-you", laneId: plainLane.id, pendingInputItemId: "input-1"),
      makeSession(id: "s-working", laneId: plainLane.id),
      makeSession(id: "s-ci-blocked", laneId: ciLane.id),
      makeSession(
        id: "s-snoozed",
        laneId: plainLane.id,
        snoozedUntil: iso(now.addingTimeInterval(3600)),
        snoozedAt: iso(now.addingTimeInterval(-60))
      ),
      // The two resting phases, which is where the chip and the header used to
      // disagree: a chat between turns is `ready`, an idle CLI is `idle`.
      makeSession(id: "s-ready", laneId: plainLane.id, toolType: "claude-chat", status: "completed", runtimeState: "idle"),
      makeSession(id: "s-idle", laneId: plainLane.id, toolType: "shell", status: "running", runtimeState: "idle"),
      makeSession(id: "s-ended", laneId: plainLane.id, toolType: "shell", status: "ended", runtimeState: "exited"),
      makeSession(id: "s-settled", laneId: plainLane.id, settledAt: iso(now.addingTimeInterval(-60))),
    ]
    let reasons = workLaneWaitingReasonByLaneId(
      lanes: [plainLane, ciLane],
      pullRequests: [makePr(id: "pr-ci", lane: ciLane, checksStatus: "pending")]
    )

    // Called directly rather than through `workSessionGroups`, which lifts
    // snoozed and settled rows onto the quiet shelves ahead of every
    // organization. This is the by-status partition itself.
    let groups = workSessionGroupsByStatus(
      sessions: sessions,
      chatSummaries: [:],
      archivedSessionIds: [],
      laneWaitingReasonByLaneId: reasons,
      now: now
    )

    XCTAssertEqual(
      groups.map(\.label),
      ["Needs you", "Working", "Waiting", "Done"],
      "Four sections, in the chips' order and in the chips' words — no 'Ended', no 'Your move'"
    )

    let chips: [WorkSessionStatusFilter] = [.needsYou, .working, .waiting, .done]
    for chip in chips {
      let section = groups.first { $0.label == chip.title }
      XCTAssertEqual(
        section?.sessions.map(\.id).sorted(),
        filteredIds(sessions, status: chip, laneWaitingReasons: reasons).sorted(),
        "The \(chip.title) header must hold exactly what the \(chip.title) chip selects"
      )
    }

    // The specific rows the two sides used to file differently.
    XCTAssertEqual(
      Set(groups.first { $0.label == "Done" }?.sessions.map(\.id) ?? []),
      ["s-ready", "s-idle", "s-ended", "s-settled"],
      "A resting chat is a finished outcome — the same emerald Done the row badge shows"
    )
    XCTAssertEqual(
      groups.first { $0.label == "Needs you" }?.sessions.map(\.id),
      ["s-needs-you"],
      "Amber stays reserved for a row actually blocked on the user"
    )
  }

  /// The four words come from one place each, so a chip and its header cannot
  /// drift apart again: three borrow `ActivityBand.title`, the shared Swift
  /// spelling of the board columns, and Waiting — the one column that band has
  /// no case for — is spelled exactly once.
  func testStatusChipTitlesComeFromTheSharedBandVocabulary() {
    XCTAssertEqual(WorkSessionStatusFilter.needsYou.title, ActivityBand.needsYou.title)
    XCTAssertEqual(WorkSessionStatusFilter.working.title, ActivityBand.working.title)
    XCTAssertEqual(WorkSessionStatusFilter.done.title, ActivityBand.done.title)
    XCTAssertEqual(WorkSessionStatusFilter.waiting.title, "Waiting")
    XCTAssertEqual(
      Set([
        WorkSessionStatusFilter.needsYou.title,
        WorkSessionStatusFilter.working.title,
        WorkSessionStatusFilter.waiting.title,
        WorkSessionStatusFilter.done.title,
      ]).count,
      4,
      "four distinct words for four distinct buckets"
    )
  }

  /// Every canonical phase answers to exactly one of the three phase-derived
  /// chips — the totality the two old switches each had to maintain separately.
  func testEveryPhaseFilesUnderExactlyOnePhaseDerivedChip() {
    let phases: [CanonicalSessionPhase] = [
      .starting, .running, .needsYou, .failed, .stale, .ready, .idle, .stopped, .ended, .settled,
    ]
    let phaseDerivedChips: [WorkSessionStatusFilter] = [.needsYou, .working, .done]
    for phase in phases {
      let chip = workStatusFilterPartition(phase: phase)
      XCTAssertTrue(
        phaseDerivedChips.contains(chip),
        "\(phase) filed under \(chip.title), which is not a phase-derived chip"
      )
    }
    XCTAssertEqual(workStatusFilterPartition(phase: .needsYou), .needsYou)
    XCTAssertEqual(workStatusFilterPartition(phase: .stale), .working)
    XCTAssertEqual(workStatusFilterPartition(phase: .ready), .done)
    XCTAssertEqual(workStatusFilterPartition(phase: .idle), .done)
    XCTAssertEqual(workStatusFilterPartition(phase: .failed), .done)
  }

  // MARK: - Fixtures
  private func filteredIds(
    _ sessions: [TerminalSessionSummary],
    status: WorkSessionStatusFilter,
    laneWaitingReasons: [String: WorkBoardWaitingReason] = [:]
  ) -> [String] {
    workFilteredSessions(
      sessions,
      chatSummaries: [:],
      archivedSessionIds: [],
      selectedStatus: status,
      selectedLaneId: "all",
      searchText: "",
      laneWaitingReasonByLaneId: laneWaitingReasons,
      now: now
    ).map(\.id)
  }

  private func makePr(
    id: String,
    lane: LaneSummary,
    state: String = "open",
    checksStatus: String = "none",
    reviewStatus: String = "none",
    detached: PrDetachedLane? = nil
  ) -> PullRequestListItem {
    PullRequestListItem(
      id: id,
      laneId: lane.id,
      laneName: lane.name,
      projectId: "project-1",
      repoOwner: "arul",
      repoName: "ade",
      githubPrNumber: 1,
      githubUrl: "https://github.com/arul/ade/pull/1",
      title: "PR",
      state: state,
      baseBranch: lane.baseRef,
      headBranch: lane.branchRef,
      checksStatus: checksStatus,
      reviewStatus: reviewStatus,
      additions: 0,
      deletions: 0,
      lastSyncedAt: nil,
      createdAt: iso(now.addingTimeInterval(-600)),
      updatedAt: iso(now.addingTimeInterval(-60)),
      adeKind: "single",
      linkedGroupId: nil,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: nil,
      cleanupState: nil,
      detached: detached
    )
  }


  private func makePresentation(
    sessions: [TerminalSessionSummary],
    lanes: [LaneSummary],
    pinnedLaneIds: Set<String> = [],
    searchText: String = "",
    pullRequests: [PullRequestListItem] = [],
    organization: WorkSessionOrganization = .byLane
  ) -> WorkRootSessionPresentation {
    buildWorkRootSessionPresentation(
      sessions: sessions,
      optimisticSessions: [:],
      chatSummaries: [:],
      archivedSessionIds: [],
      selectedStatus: .all,
      selectedLaneId: "all",
      searchText: searchText,
      organization: organization,
      orderedLanes: lanes,
      pullRequests: pullRequests,
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
    toolType: String = "codex-chat",
    status: String = "running",
    runtimeState: String = "running",
    settledAt: String? = nil,
    snoozedUntil: String? = nil,
    snoozedAt: String? = nil,
    chatSessionId: String? = nil,
    pendingInputItemId: String? = nil,
    chatIdleSinceAt: String? = nil
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
      toolType: toolType,
      title: title,
      status: status,
      startedAt: iso(now.addingTimeInterval(-300)),
      endedAt: nil,
      archivedAt: nil,
      settledAt: settledAt,
      snoozedUntil: snoozedUntil,
      snoozedAt: snoozedAt,
      exitCode: nil,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: nil,
      summary: nil,
      runtimeState: settledAt == nil ? runtimeState : "idle",
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: chatIdleSinceAt,
      chatSessionId: chatSessionId,
      pendingInputItemId: pendingInputItemId
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
