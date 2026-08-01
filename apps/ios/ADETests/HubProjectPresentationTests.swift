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
