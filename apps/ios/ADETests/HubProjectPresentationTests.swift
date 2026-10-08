import XCTest
@testable import ADE

/// The hub's project card and chat rows carried live counts and a status string
/// that were computed and then never rendered. These lock the presentation seam
/// so the numbers cannot silently go quiet again — including the equatable
/// short-circuit, which is what would freeze them.
final class HubProjectPresentationTests: XCTestCase {

    // MARK: - Status line copy

    func testStatusLineIsSilentWhenNothingIsHappening() {
        XCTAssertNil(hubProjectStatusLine(attentionCount: 0, runningCount: 0))
    }

    func testStatusLineNamesOnlyTheNonZeroClauses() {
        XCTAssertEqual(hubProjectStatusLine(attentionCount: 2, runningCount: 0), "2 need you")
        XCTAssertEqual(hubProjectStatusLine(attentionCount: 0, runningCount: 3), "3 working")
        XCTAssertEqual(hubProjectStatusLine(attentionCount: 2, runningCount: 3), "2 need you · 3 working")
    }

    // MARK: - Counts reach the card

    /// The card counts its own rows by board column, not the roster's
    /// `attentionCount` / `runningCount`: a failure needs you, and a running chat
    /// whose lane PR waits on CI is Waiting, not working.
    func testProjectPresentationCountsRowsByBoardColumn() {
        var ciChat = chat(id: "c-ci", status: .running, awaitingInput: false)
        ciChat.laneId = "lane-ci"
        var roster = roster(attentionCount: 0, runningCount: 9)
        roster.lanes.append(RemoteRosterLane(
            id: "lane-ci", name: "ci", color: nil, icon: nil, laneType: nil, branchRef: nil,
            prWaitingReason: "ci"
        ))
        roster.chats = [
            chat(id: "c-ask", status: .awaiting, awaitingInput: true),
            chat(id: "c-fail", status: .failed, awaitingInput: false),
            chat(id: "c-run-1", status: .running, awaitingInput: false),
            chat(id: "c-run-2", status: .running, awaitingInput: false),
            ciChat,
        ]

        let presentation = buildHubProjectPresentation(
            project: project(),
            roster: roster,
            isActive: false,
            isSwitching: false
        )

        XCTAssertEqual(presentation.attentionCount, 2)
        XCTAssertEqual(presentation.runningCount, 2)
        XCTAssertEqual(presentation.statusLine, "2 need you · 2 working")
        XCTAssertEqual(
            presentation.stateCounts,
            [
                HubStateCount(column: .needsYou, count: 2),
                HubStateCount(column: .working, count: 2),
                HubStateCount(column: .waiting, count: 1),
            ]
        )
    }

    func testEquatableShortCircuitDoesNotFreezeTheCounts() {
        let quiet = buildHubProjectPresentation(
            project: project(),
            roster: roster(attentionCount: 0, runningCount: 0),
            isActive: false,
            isSwitching: false
        )
        var busyRoster = roster(attentionCount: 0, runningCount: 0)
        busyRoster.chats = [chat(id: "c-1", status: .awaiting, awaitingInput: true)]
        let busy = buildHubProjectPresentation(
            project: project(),
            roster: busyRoster,
            isActive: false,
            isSwitching: false
        )

        XCTAssertNotEqual(quiet, busy, "a state change must re-render the card")
    }

    func testMissingRosterReportsNoLiveCounts() {
        let presentation = buildHubProjectPresentation(
            project: project(),
            roster: nil,
            isActive: false,
            isSwitching: false
        )

        XCTAssertEqual(presentation.attentionCount, 0)
        XCTAssertNil(presentation.statusLine)
    }

    func testIdentityChatsAreExcludedFromRowsAndDerivedCounts() {
        var identity = chat(id: "cto-chat", status: .awaiting, awaitingInput: true)
        identity.identityKey = "cto"
        var identityChild = chat(id: "cto-shell", status: .running, awaitingInput: false)
        identityChild.toolType = "shell"
        identityChild.chatSessionId = identity.id
        var roster = roster(attentionCount: 1, runningCount: 2)
        roster.chats = [identity, identityChild, chat(id: "ordinary-chat", status: .running, awaitingInput: false)]

        let presentation = buildHubProjectPresentation(
            project: project(),
            roster: roster,
            isActive: false,
            isSwitching: false
        )

        XCTAssertEqual(presentation.attentionCount, 0)
        XCTAssertEqual(presentation.runningCount, 1)
        XCTAssertEqual(presentation.chatCount, 1)
        XCTAssertEqual(presentation.lanes.flatMap { $0.rows }.map(\.id), ["ordinary-chat"])
    }

    // MARK: - Chat row status

    /// The roster's copy of the board rule (`rosterBoardColumn` plus the snooze
    /// overlay in the brain's `attentionItemBuilder.ts`). Every Hub count, chip
    /// and row mark reads this one mapping.
    func testRosterChatFilesIntoTheBoardColumn() {
        let now = ISO8601DateFormatter().date(from: "2026-08-01T00:00:00Z")!
        let snoozedUntil = "2126-07-10T00:00:00Z"
        let ciLane = lane(prWaitingReason: "ci")
        let reviewLane = lane(prWaitingReason: "review")
        struct Case {
            let name: String
            let chat: RemoteRosterChat
            let lane: RemoteRosterLane?
            let column: ActivityBoardColumn
            let failed: Bool
            let label: String?
        }
        func with(_ chat: RemoteRosterChat, _ edit: (inout RemoteRosterChat) -> Void) -> RemoteRosterChat {
            var copy = chat
            edit(&copy)
            return copy
        }
        let cases: [Case] = [
            Case(name: "awaiting is Needs you", chat: chat(id: "a", status: .awaiting, awaitingInput: true),
                 lane: nil, column: .needsYou, failed: false, label: "Needs you"),
            Case(name: "a raised hand on a running row is Needs you", chat: chat(id: "b", status: .running, awaitingInput: true),
                 lane: ciLane, column: .needsYou, failed: false, label: "Needs you"),
            Case(name: "failed is Needs you with the red mark", chat: chat(id: "c", status: .failed, awaitingInput: false),
                 lane: nil, column: .needsYou, failed: true, label: "Failed"),
            Case(name: "a snooze does not hide a failure",
                 chat: with(chat(id: "d", status: .failed, awaitingInput: false)) { $0.snoozedUntil = snoozedUntil },
                 lane: nil, column: .needsYou, failed: true, label: "Failed"),
            Case(name: "running is Working", chat: chat(id: "e", status: .running, awaitingInput: false),
                 lane: lane(prWaitingReason: nil), column: .working, failed: false, label: "Working"),
            Case(name: "running on a lane whose PR runs CI waits", chat: chat(id: "f", status: .running, awaitingInput: false),
                 lane: ciLane, column: .waiting, failed: false, label: "CI running"),
            Case(name: "running on a lane with a review requested waits", chat: chat(id: "g", status: .running, awaitingInput: false),
                 lane: reviewLane, column: .waiting, failed: false, label: "Review requested"),
            Case(name: "a snoozed running chat waits",
                 chat: with(chat(id: "h", status: .running, awaitingInput: false)) { $0.snoozedUntil = snoozedUntil },
                 lane: nil, column: .waiting, failed: false, label: "Snoozed"),
            Case(name: "an idle chat with a wake ahead waits",
                 chat: with(chat(id: "i", status: .idle, awaitingInput: false)) { $0.nextWakeAt = "2026-08-01T01:00:00Z" },
                 lane: nil, column: .waiting, failed: false, label: "Wake scheduled"),
            Case(name: "a lane PR wait does not move an idle chat", chat: chat(id: "j", status: .idle, awaitingInput: false),
                 lane: ciLane, column: .done, failed: false, label: nil),
            Case(name: "ended is Done", chat: chat(id: "k", status: .ended, awaitingInput: false),
                 lane: nil, column: .done, failed: false, label: nil),
        ]

        for testCase in cases {
            let state = hubChatBoardState(testCase.chat, lane: testCase.lane, now: now)
            XCTAssertEqual(state.column, testCase.column, testCase.name)
            XCTAssertEqual(state.failed, testCase.failed, testCase.name)
            XCTAssertEqual(state.label, testCase.label, testCase.name)
            // A silent row still speaks its column to VoiceOver.
            XCTAssertEqual(state.accessibilityLabel, testCase.label ?? testCase.column.label, testCase.name)
        }
    }

    func testChatRowPresentationCarriesTheNormalizedStatus() {
        let row = HubChatRowPresentation.make(
            chat: chat(id: "c-1", status: .running, awaitingInput: true)
        )

        XCTAssertEqual(row.statusString, "awaiting-input")
    }

    func testChatRowEquatableTracksAStatusChange() {
        let waiting = HubChatRowPresentation.make(
            chat: chat(id: "c-1", status: .running, awaitingInput: true)
        )
        let working = HubChatRowPresentation.make(
            chat: chat(id: "c-1", status: .running, awaitingInput: false)
        )

        XCTAssertNotEqual(waiting, working, "the status dot must not stick on a stale value")
    }

    func testSnoozedRunningChatDoesNotCountTowardRunning() {
        var snoozed = chat(id: "c-snooze", status: .running, awaitingInput: false)
        snoozed.snoozedUntil = "2126-07-10T00:00:00Z"
        snoozed.snoozedAt = "2026-07-27T00:00:00Z"
        let awaiting = chat(id: "c-wait", status: .awaiting, awaitingInput: true)
        let working = chat(id: "c-run", status: .running, awaitingInput: false)

        XCTAssertFalse(snoozed.countsTowardRunning)
        XCTAssertFalse(awaiting.countsTowardRunning)
        XCTAssertTrue(working.countsTowardRunning)
    }

    func testLocalSnoozeOverlayWinsOverRemoteRunning() {
        let remote = chat(id: "c-1", status: .running, awaitingInput: false)
        var local = remote
        local.snoozedUntil = "2126-07-10T00:00:00Z"
        local.snoozedAt = "2026-07-27T00:00:00Z"
        var merged = remote
        merged.applyLocalSnoozeOverlay(local)

        XCTAssertFalse(merged.countsTowardRunning)
        XCTAssertEqual(hubChatBoardState(merged, lane: nil).waitingReason, .snoozed)
    }

    func testRemoteSnoozeOverlaySurvivesLocalRowWithoutOverlay() {
        var remote = chat(id: "c-1", status: .running, awaitingInput: false)
        remote.snoozedUntil = "2126-07-10T00:00:00Z"
        remote.snoozedAt = "2026-07-27T00:00:00Z"
        let local = chat(id: "c-1", status: .running, awaitingInput: false)
        var merged = remote
        merged.applyLocalSnoozeOverlay(local)

        XCTAssertEqual(merged.snoozedUntil, remote.snoozedUntil)
        XCTAssertFalse(merged.countsTowardRunning)
        XCTAssertEqual(hubChatBoardState(merged, lane: nil).waitingReason, .snoozed)
    }

    // MARK: - Roster filter cards

    func testEachColumnChipAdmitsOnlyItsColumnAndAllAdmitsEvery() {
        for filter in HubRosterFilter.allCases {
            for column in ActivityBoardColumn.allCases {
                XCTAssertEqual(
                    hubRosterFilterContains(column, filter),
                    filter == .all || filter.column == column,
                    "\(filter) vs \(column)"
                )
            }
        }
        XCTAssertEqual(HubRosterFilter.allCases.compactMap(\.column), ActivityBoardColumn.allCases)
    }

    func testRosterFilterHidesProjectsWithNoMatchingChats() {
        let working = HubChatRowPresentation.make(
            chat: chat(id: "c-run", status: .running, awaitingInput: false)
        )
        let waiting = HubChatRowPresentation.make(
            chat: chat(id: "c-wait", status: .awaiting, awaitingInput: true)
        )
        let failed = HubChatRowPresentation.make(
            chat: chat(id: "c-fail", status: .failed, awaitingInput: false)
        )
        let idle = HubChatRowPresentation.make(
            chat: chat(id: "c-idle", status: .idle, awaitingInput: false)
        )
        let presentation = HubProjectPresentation(
            project: project(),
            isActive: false,
            isSwitching: false,
            isLoading: false,
            laneCount: 1,
            chatCount: 4,
            lanes: [
                HubLanePresentation(
                    lane: lane(prWaitingReason: nil),
                    rows: [working, waiting, failed, idle],
                    totalCount: 4
                ),
            ],
            attentionCount: 2,
            runningCount: 1
        )

        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .all), 4)
        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .needsYou), 2)
        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .working), 1)
        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .waiting), 0)
        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .done), 1)

        XCTAssertNil(hubProjectPresentation(presentation, matching: .waiting))
        let needsYou = hubProjectPresentation(presentation, matching: .needsYou)
        XCTAssertEqual(needsYou?.lanes.first?.rows.map(\.id), ["c-wait", "c-fail"])
        XCTAssertEqual(needsYou?.attentionCount, 2)
        XCTAssertEqual(needsYou?.runningCount, 0)
        let workingOnly = hubProjectPresentation(presentation, matching: .working)
        XCTAssertEqual(workingOnly?.lanes.first?.rows.map(\.id), ["c-run"])
        XCTAssertEqual(workingOnly?.runningCount, 1)
        XCTAssertEqual(workingOnly?.attentionCount, 0)
        // Resting chats are not All-only any more: Done is a chip of its own.
        XCTAssertEqual(
            hubProjectPresentation(presentation, matching: .done)?.lanes.first?.rows.map(\.id),
            ["c-idle"]
        )
    }

    func testFilterDoesNotPromoteAParentForAnUndrawnChild() {
        let parent = HubChatRowPresentation.make(
            chat: chat(id: "c-parent", status: .running, awaitingInput: false),
            childRows: [
                HubChatRowPresentation.make(
                    chat: {
                        var child = chat(id: "c-cli", status: .failed, awaitingInput: false)
                        child.toolType = "shell"
                        child.chatSessionId = "c-parent"
                        return child
                    }()
                ),
            ]
        )
        let presentation = HubProjectPresentation(
            project: project(),
            isActive: false,
            isSwitching: false,
            isLoading: false,
            laneCount: 1,
            chatCount: 1,
            lanes: [
                HubLanePresentation(
                    lane: RemoteRosterLane(
                        id: "lane-1",
                        name: "activity-revamp",
                        color: nil,
                        icon: nil,
                        laneType: nil,
                        branchRef: nil
                    ),
                    rows: [parent],
                    totalCount: 1
                ),
            ]
        )

        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .working), 1)
        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .needsYou), 0)
        XCTAssertNil(hubProjectPresentation(presentation, matching: .needsYou))
        XCTAssertEqual(
            hubProjectPresentation(presentation, matching: .working)?.lanes.first?.rows.map(\.id),
            ["c-parent"]
        )
    }

    func testAbandonOnlyCancelsUncommittedSwitches() {
        XCTAssertTrue(
            hubChatShouldAbandonActivationOnDismiss(
                isSwitchingTargetProject: true,
                targetAlreadyActive: false
            )
        )
        XCTAssertFalse(
            hubChatShouldAbandonActivationOnDismiss(
                isSwitchingTargetProject: true,
                targetAlreadyActive: true
            )
        )
        XCTAssertFalse(
            hubChatShouldAbandonActivationOnDismiss(
                isSwitchingTargetProject: false,
                targetAlreadyActive: false
            )
        )
    }

    // MARK: - Fixtures

    private func project() -> MobileProjectSummary {
        MobileProjectSummary(
            id: "p-1",
            displayName: "ADE",
            laneCount: 2,
            isAvailable: true,
            isCached: true
        )
    }

    private func roster(attentionCount: Int, runningCount: Int) -> RemoteRosterProject {
        RemoteRosterProject(
            projectId: "p-1",
            rootPath: nil,
            displayName: "ADE",
            iconDataUrl: nil,
            lastOpenedAt: nil,
            booted: true,
            runningCount: runningCount,
            attentionCount: attentionCount,
            lanes: [
                RemoteRosterLane(
                    id: "lane-1",
                    name: "activity-revamp",
                    color: nil,
                    icon: nil,
                    laneType: nil,
                    branchRef: nil
                ),
            ],
            chats: [chat(id: "c-1", status: .running, awaitingInput: false)]
        )
    }

    private func lane(prWaitingReason: String?) -> RemoteRosterLane {
        RemoteRosterLane(
            id: "lane-1",
            name: "activity-revamp",
            color: nil,
            icon: nil,
            laneType: nil,
            branchRef: nil,
            prWaitingReason: prWaitingReason
        )
    }

    private func chat(
        id: String,
        status: RemoteRosterChatStatus,
        awaitingInput: Bool
    ) -> RemoteRosterChat {
        RemoteRosterChat(
            id: id,
            laneId: "lane-1",
            chatSessionId: nil,
            title: "Wire the drawer",
            provider: "claude",
            model: nil,
            toolType: "chat",
            status: status,
            awaitingInput: awaitingInput,
            pinned: nil,
            archived: nil,
            lastActivityAt: "2026-08-01T00:00:00Z",
            preview: nil
        )
    }
}
