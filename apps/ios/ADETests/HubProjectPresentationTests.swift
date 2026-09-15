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

    func testProjectPresentationCarriesRosterCounts() {
        let presentation = buildHubProjectPresentation(
            project: project(),
            roster: roster(attentionCount: 1, runningCount: 2),
            isActive: false,
            isSwitching: false
        )

        XCTAssertEqual(presentation.attentionCount, 1)
        XCTAssertEqual(presentation.runningCount, 2)
        XCTAssertEqual(presentation.statusLine, "1 need you · 2 working")
    }

    func testEquatableShortCircuitDoesNotFreezeTheCounts() {
        let quiet = buildHubProjectPresentation(
            project: project(),
            roster: roster(attentionCount: 0, runningCount: 0),
            isActive: false,
            isSwitching: false
        )
        let busy = buildHubProjectPresentation(
            project: project(),
            roster: roster(attentionCount: 1, runningCount: 0),
            isActive: false,
            isSwitching: false
        )

        XCTAssertNotEqual(quiet, busy, "a count change must re-render the card")
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

    func testChatRowStatusLabelSpeaksOnlyWhenItHasSomethingToSay() {
        XCTAssertEqual(hubChatStatusLabel("awaiting-input"), "Needs you")
        XCTAssertEqual(hubChatStatusLabel("active"), "Working")
        XCTAssertNil(hubChatStatusLabel("idle"))
        XCTAssertNil(hubChatStatusLabel("ended"))
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

    func testSnoozedRunningChatFilesAsIdle() {
        var row = chat(id: "c-snooze", status: .running, awaitingInput: false)
        row.snoozedUntil = "2126-07-10T00:00:00Z"
        row.snoozedAt = "2026-07-27T00:00:00Z"
        let presentation = HubChatRowPresentation.make(chat: row)

        XCTAssertEqual(presentation.stateGroup, .idle)
        XCTAssertNil(hubChatStateLabel(presentation.stateGroup))
    }

    func testSnoozedFailedChatStaysFailed() {
        var row = chat(id: "c-failed", status: .failed, awaitingInput: false)
        row.snoozedUntil = "2126-07-10T00:00:00Z"
        let presentation = HubChatRowPresentation.make(chat: row)

        XCTAssertEqual(presentation.stateGroup, .failed)
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
        XCTAssertEqual(hubChatStateGroup(merged), .idle)
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
        XCTAssertEqual(hubChatStateGroup(merged), .idle)
    }

    // MARK: - Roster filter cards

    func testRosterFilterMapsPlanningIntoWorkingAndFailedIntoFinished() {
        XCTAssertTrue(hubRosterFilterContains(.working, .working))
        XCTAssertTrue(hubRosterFilterContains(.planning, .working))
        XCTAssertFalse(hubRosterFilterContains(.needsYou, .working))
        XCTAssertTrue(hubRosterFilterContains(.needsYou, .needsYou))
        XCTAssertTrue(hubRosterFilterContains(.done, .finished))
        XCTAssertTrue(hubRosterFilterContains(.failed, .finished))
        XCTAssertFalse(hubRosterFilterContains(.idle, .finished))
        XCTAssertTrue(hubRosterFilterContains(.idle, .all))
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
        let presentation = HubProjectPresentation(
            project: project(),
            isActive: false,
            isSwitching: false,
            isLoading: false,
            laneCount: 1,
            chatCount: 3,
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
                    rows: [working, waiting, failed],
                    totalCount: 3
                ),
            ],
            attentionCount: 1,
            runningCount: 1
        )

        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .all), 3)
        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .working), 1)
        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .needsYou), 1)
        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .finished), 1)

        XCTAssertEqual(
            hubProjectPresentation(presentation, matching: .working)?.lanes.first?.rows.map(\.id),
            ["c-run"]
        )
        XCTAssertEqual(hubProjectPresentation(presentation, matching: .working)?.runningCount, 1)
        XCTAssertEqual(hubProjectPresentation(presentation, matching: .working)?.attentionCount, 0)
        XCTAssertEqual(
            hubProjectPresentation(presentation, matching: .needsYou)?.lanes.first?.rows.map(\.id),
            ["c-wait"]
        )
        XCTAssertEqual(hubProjectPresentation(presentation, matching: .needsYou)?.attentionCount, 1)
        XCTAssertEqual(hubProjectPresentation(presentation, matching: .needsYou)?.runningCount, 0)
        XCTAssertEqual(
            hubProjectPresentation(presentation, matching: .finished)?.lanes.first?.rows.map(\.id),
            ["c-fail"]
        )
        XCTAssertEqual(hubProjectPresentation(presentation, matching: .finished)?.runningCount, 0)
        XCTAssertEqual(hubProjectPresentation(presentation, matching: .finished)?.attentionCount, 0)
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
        XCTAssertEqual(hubRosterFilterCount([presentation], filter: .finished), 0)
        XCTAssertNil(hubProjectPresentation(presentation, matching: .finished))
        XCTAssertEqual(
            hubProjectPresentation(presentation, matching: .working)?.lanes.first?.rows.map(\.id),
            ["c-parent"]
        )
    }

    func testFinishedFilterUsesDoneGlyphNotFailed() {
        XCTAssertEqual(HubRosterFilter.finished.systemImage, ActivityStateGroup.done.glyph.systemImage)
        XCTAssertEqual(HubRosterFilter.working.systemImage, ActivityStateGroup.working.glyph.systemImage)
        XCTAssertEqual(HubRosterFilter.needsYou.systemImage, ActivityStateGroup.needsYou.glyph.systemImage)
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
