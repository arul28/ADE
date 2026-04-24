import XCTest
@testable import ADE

@available(iOS 17.0, *)
@MainActor
final class AttentionDrawerModelTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "ade.attention-drawer.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    // MARK: - Empty snapshot

    func testEmptySnapshotProducesNoItems() {
        let model = AttentionDrawerModel(defaults: defaults)

        model.rebuild(from: .empty)

        XCTAssertTrue(model.items.isEmpty)
        XCTAssertEqual(model.unreadCount, 0)
        XCTAssertNil(model.badgeLabel)
    }

    // MARK: - Mixed attention

    func testMixedSnapshotBuildsAwaitingFailedCiAndMergeItems() {
        let model = AttentionDrawerModel(defaults: defaults)
        let now = Date()

        let awaitingAgent = AgentSnapshot(
            sessionId: "s-awaiting",
            provider: "claude",
            title: "Approve import",
            status: "running",
            awaitingInput: true,
            lastActivityAt: now,
            elapsedSeconds: 30,
            preview: nil,
            progress: nil,
            phase: nil,
            toolCalls: 0
        )
        let failedAgent = AgentSnapshot(
            sessionId: "s-failed",
            provider: "codex",
            title: "Broken test run",
            status: "failed",
            awaitingInput: false,
            lastActivityAt: now.addingTimeInterval(-120),
            elapsedSeconds: 80,
            preview: nil,
            progress: nil,
            phase: nil,
            toolCalls: 0
        )
        let healthyAgent = AgentSnapshot(
            sessionId: "s-healthy",
            provider: "cursor",
            title: "Idle",
            status: "running",
            awaitingInput: false,
            lastActivityAt: now.addingTimeInterval(-60),
            elapsedSeconds: 60,
            preview: nil,
            progress: nil,
            phase: nil,
            toolCalls: 0
        )

        let ciFailingPr = PrSnapshot(
            id: "pr-1",
            number: 412,
            title: "Migrate auth",
            checks: "failing",
            review: "pending",
            state: "open",
            mergeReady: false
        )
        let mergeReadyPr = PrSnapshot(
            id: "pr-2",
            number: 401,
            title: "Tidy logs",
            checks: "passing",
            review: "approved",
            state: "open",
            mergeReady: true
        )
        let reviewPr = PrSnapshot(
            id: "pr-3",
            number: 408,
            title: "Add caching",
            checks: "passing",
            review: "pending",
            state: "open",
            mergeReady: false
        )
        let mergedPr = PrSnapshot(
            id: "pr-4",
            number: 390,
            title: "Closed already",
            checks: "failing",
            review: "approved",
            state: "merged",
            mergeReady: false
        )

        let snapshot = WorkspaceSnapshot(
            generatedAt: now,
            agents: [awaitingAgent, failedAgent, healthyAgent],
            prs: [ciFailingPr, mergeReadyPr, reviewPr, mergedPr],
            connection: "connected"
        )

        model.rebuild(from: snapshot)

        XCTAssertEqual(model.items.count, 5, "healthy agent + merged PR should be filtered out")

        // Priority order: awaiting, failed, ci, review, merge.
        XCTAssertEqual(model.items.map(\.kind), [
            .awaitingInput,
            .failed,
            .ciFailing,
            .reviewRequested,
            .mergeReady,
        ])

        let awaiting = try? XCTUnwrap(model.items.first)
        XCTAssertEqual(awaiting?.sessionId, "s-awaiting")
        XCTAssertEqual(awaiting?.deepLink, URL(string: "ade://session/s-awaiting"))
        XCTAssertEqual(awaiting?.subtitle, "Approval needed")

        let ci = model.items.first(where: { $0.kind == .ciFailing })
        XCTAssertEqual(ci?.prNumber, 412)
        XCTAssertEqual(ci?.deepLink, URL(string: "ade://pr/412"))
    }

    func testItemsOfSameKindAreSortedNewestFirst() {
        let model = AttentionDrawerModel(defaults: defaults)
        let now = Date()

        let older = AgentSnapshot(
            sessionId: "older",
            provider: "claude",
            title: "A",
            status: "failed",
            awaitingInput: false,
            lastActivityAt: now.addingTimeInterval(-500),
            elapsedSeconds: 0,
            preview: nil,
            progress: nil,
            phase: nil,
            toolCalls: 0
        )
        let newer = AgentSnapshot(
            sessionId: "newer",
            provider: "claude",
            title: "B",
            status: "failed",
            awaitingInput: false,
            lastActivityAt: now,
            elapsedSeconds: 0,
            preview: nil,
            progress: nil,
            phase: nil,
            toolCalls: 0
        )

        model.rebuild(from: .init(
            generatedAt: now,
            agents: [older, newer],
            prs: [],
            connection: "connected"
        ))

        XCTAssertEqual(model.items.map(\.sessionId), ["newer", "older"])
    }

    // MARK: - markAllSeen

    func testMarkAllSeenZeroesUnreadCount() {
        let model = AttentionDrawerModel(defaults: defaults)
        let now = Date()

        let awaiting = AgentSnapshot(
            sessionId: "s1",
            provider: "claude",
            title: "Do thing",
            status: "running",
            awaitingInput: true,
            lastActivityAt: now,
            elapsedSeconds: 10,
            preview: nil,
            progress: nil,
            phase: nil,
            toolCalls: 0
        )
        model.rebuild(from: .init(
            generatedAt: now,
            agents: [awaiting],
            prs: [],
            connection: "connected"
        ))

        XCTAssertEqual(model.unreadCount, 1)
        XCTAssertEqual(model.badgeLabel, "1")

        model.markAllSeen()

        XCTAssertEqual(model.unreadCount, 0)
        XCTAssertNil(model.badgeLabel)
        XCTAssertEqual(model.items.count, 1, "items stay; only unread count clears")

        let stored = defaults.double(forKey: AttentionDrawerModel.lastSeenAtKey)
        XCTAssertGreaterThan(stored, 0, "markAllSeen should persist the new lastSeenAt")
    }

    func testBadgeCapsAtNinePlus() {
        let model = AttentionDrawerModel(defaults: defaults)
        let now = Date()

        let agents = (0..<12).map { idx in
            AgentSnapshot(
                sessionId: "s-\(idx)",
                provider: "claude",
                title: "T\(idx)",
                status: "running",
                awaitingInput: true,
                lastActivityAt: now.addingTimeInterval(TimeInterval(idx)),
                elapsedSeconds: 0,
                preview: nil,
                progress: nil,
                phase: nil,
                toolCalls: 0
            )
        }
        model.rebuild(from: .init(
            generatedAt: now,
            agents: agents,
            prs: [],
            connection: "connected"
        ))

        XCTAssertEqual(model.unreadCount, 12)
        XCTAssertEqual(model.badgeLabel, "9+")
    }

    func testUnreadCountOnlyCountsItemsNewerThanLastSeenAt() {
        // Seed a lastSeenAt in the future so nothing qualifies as unread.
        defaults.set(
            Date().addingTimeInterval(3_600).timeIntervalSince1970,
            forKey: AttentionDrawerModel.lastSeenAtKey
        )

        let model = AttentionDrawerModel(defaults: defaults)
        let now = Date()

        let awaiting = AgentSnapshot(
            sessionId: "s1",
            provider: "claude",
            title: "Do thing",
            status: "running",
            awaitingInput: true,
            lastActivityAt: now,
            elapsedSeconds: 0,
            preview: nil,
            progress: nil,
            phase: nil,
            toolCalls: 0
        )
        model.rebuild(from: .init(
            generatedAt: now,
            agents: [awaiting],
            prs: [],
            connection: "connected"
        ))

        XCTAssertEqual(model.items.count, 1)
        XCTAssertEqual(model.unreadCount, 0, "all items are older than a future lastSeenAt")
    }

    // MARK: - Inline summary

    func testInlineSummaryIgnoresClosedPrsWhenPickingFocus() {
        let now = Date()
        let snapshot = WorkspaceSnapshot(
            generatedAt: now,
            agents: [],
            prs: [
                PrSnapshot(
                    id: "closed-failing",
                    number: 14,
                    title: "Already merged",
                    checks: "failing",
                    review: "approved",
                    state: "merged",
                    mergeReady: false
                ),
                PrSnapshot(
                    id: "open-review",
                    number: 42,
                    title: "Needs review",
                    checks: "passing",
                    review: "pending",
                    state: "open",
                    mergeReady: false
                ),
            ],
            connection: "connected"
        )

        XCTAssertEqual(ADESharedContainer.inlineSummary(for: snapshot), "ADE · #42 ·")
    }

    func testInlineSummaryReturnsIdleWhenOnlyClosedPrsExist() {
        let snapshot = WorkspaceSnapshot(
            generatedAt: Date(),
            agents: [],
            prs: [
                PrSnapshot(
                    id: "closed",
                    number: 9,
                    title: "Merged",
                    checks: "failing",
                    review: "approved",
                    state: "closed",
                    mergeReady: false
                ),
            ],
            connection: "connected"
        )

        XCTAssertEqual(ADESharedContainer.inlineSummary(for: snapshot), "ADE · idle")
    }
}
