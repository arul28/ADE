import XCTest
@testable import ADE

@MainActor
final class ActivityDrawerModelTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "ade.activity-drawer.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        defaults.removePersistentDomain(forName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    // MARK: - Two buckets

    func testAgentRowsFileUnderSessionsAndPullRequestsUnderInbox() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(from: snapshot(items: [
            item(id: "agent-live", phase: .running, now: now),
            item(id: "agent-needs", phase: .needsYou, now: now),
            pullRequest(id: "pr-ci", phase: .checksFailing, number: 992, now: now),
        ]))

        XCTAssertEqual(Set(model.sessions.map(\.id)), ["agent-live", "agent-needs"])
        XCTAssertEqual(model.inbox.map(\.id), ["pr-ci"])
    }

    func testSessionsAreGroupedNeedsYouThenWorkingThenDone() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(from: snapshot(items: [
            item(id: "done", phase: .completed, now: now),
            item(id: "working", phase: .running, now: now),
            item(id: "needs", phase: .needsYou, now: now),
        ]))

        XCTAssertEqual(model.sessionSections.map(\.band), [.needsYou, .working, .done])
        XCTAssertEqual(model.sessionSections.map { $0.rows.map(\.id) }, [["needs"], ["working"], ["done"]])
    }

    func testFinishedButUnseenAgentRowsAlsoLandInTheInbox() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(from: snapshot(items: [
            item(id: "done-unseen", phase: .completed, now: now),
            item(id: "done-seen", phase: .completed, now: now, seenAt: now),
        ]))

        XCTAssertEqual(model.inbox.map(\.id), ["done-unseen"])
        XCTAssertEqual(Set(model.sessions.map(\.id)), ["done-unseen", "done-seen"])
    }

    func testIdleTierNeedsYouNeverReachesTheNeedsYouSection() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(from: snapshot(items: [
            item(id: "roster-row", phase: .needsYou, now: now, activityTier: "idle"),
        ]))

        XCTAssertTrue(model.sessionSections.filter { $0.band == .needsYou }.isEmpty)
        XCTAssertEqual(model.unreadCount, 0, "a roster-derived row must never badge the bell")
    }

    func testDismissedAndExpiredItemsAreFilteredOut() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(from: snapshot(items: [
            item(id: "alive", phase: .running, now: now),
            item(id: "server-dismissed", phase: .running, now: now, dismissedAt: now),
            item(id: "expired", phase: .running, now: now, expiresAt: now.addingTimeInterval(-1)),
        ]))

        XCTAssertEqual(model.sessions.map(\.id), ["alive"])
    }

    // MARK: - Per-item acknowledgement

    func testDismissRemovesOneRowAndPersistsIt() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()
        model.rebuild(from: snapshot(items: [
            item(id: "a", phase: .needsYou, now: now),
            item(id: "b", phase: .needsYou, now: now),
        ]))

        model.dismiss("a")

        XCTAssertEqual(model.sessions.map(\.id), ["b"])
        XCTAssertEqual(defaults.stringArray(forKey: ActivityDrawerModel.dismissedItemIDsKey), ["a"])
    }

    func testDismissedRowStaysDismissedAcrossRebuilds() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()
        let items = [item(id: "a", phase: .needsYou, now: now)]
        model.rebuild(from: snapshot(items: items))

        model.dismiss("a")
        model.rebuild(from: snapshot(items: items, revision: 2))

        XCTAssertTrue(model.sessions.isEmpty)
    }

    func testDismissalIsPrunedOnceTheBackingRowDisappears() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()
        model.rebuild(from: snapshot(items: [item(id: "a", phase: .needsYou, now: now)]))
        model.dismiss("a")

        model.rebuild(from: snapshot(items: [item(id: "other", phase: .running, now: now)], revision: 2))
        model.rebuild(from: snapshot(items: [item(id: "a", phase: .needsYou, now: now)], revision: 3))

        XCTAssertEqual(model.sessions.map(\.id), ["a"], "a later regression must resurface")
    }

    func testBulkDismissIsScopedToOneBucket() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()
        model.rebuild(from: snapshot(items: [
            item(id: "agent", phase: .needsYou, now: now),
            pullRequest(id: "pr", phase: .checksFailing, number: 1, now: now),
        ]))

        model.dismissVisible(in: .inbox)

        XCTAssertEqual(model.sessions.map(\.id), ["agent"])
        XCTAssertTrue(model.inbox.isEmpty)
    }

    // MARK: - Badge

    func testBadgeCountsOnlySignalTierNeedsYou() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(from: snapshot(items: [
            item(id: "needs", phase: .needsYou, now: now),
            item(id: "failed", phase: .failed, now: now),
            item(id: "working", phase: .running, now: now),
            pullRequest(id: "pr", phase: .checksFailing, number: 3, now: now),
        ]))

        XCTAssertEqual(model.unreadCount, 2)
        XCTAssertEqual(model.badgeLabel, "2")
    }

    func testBadgeCapsAtNinePlus() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()
        let items = (0..<12).map { item(id: "needs-\($0)", phase: .needsYou, now: now) }

        model.rebuild(from: snapshot(items: items))

        XCTAssertEqual(model.unreadCount, 12)
        XCTAssertEqual(model.badgeLabel, "9+")
    }

    func testMarkAllSeenSilencesTheBellWithoutRemovingRows() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()
        model.rebuild(from: snapshot(items: [item(id: "needs", phase: .needsYou, now: now)]))
        XCTAssertEqual(model.unreadCount, 1)

        model.markAllSeen()

        XCTAssertEqual(model.unreadCount, 0)
        XCTAssertNil(model.badgeLabel)
        XCTAssertEqual(model.sessions.map(\.id), ["needs"], "seen is not dismissed")
    }

    func testMarkSeenIsPersistedPerItem() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()
        model.rebuild(from: snapshot(items: [
            item(id: "a", phase: .needsYou, now: now),
            item(id: "b", phase: .needsYou, now: now),
        ]))

        model.markSeen("a")

        XCTAssertEqual(model.unreadCount, 1)
        XCTAssertEqual(defaults.stringArray(forKey: ActivityDrawerModel.seenItemIDsKey), ["a"])
    }

    // MARK: - Offline machines

    func testOfflineRowsSitBehindABannerForTheirMachine() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()
        let offline = AccountAttentionMachine(
            machineKey: "laptop",
            name: "MacBook",
            online: false,
            lastSeenAt: now.addingTimeInterval(-3_600)
        )

        model.rebuild(from: snapshot(items: [
            item(id: "online", phase: .running, now: now),
            item(id: "offline", phase: .running, now: now, machine: offline),
        ]))

        let entries = model.sessionSections.first { $0.band == .working }?.entries ?? []
        XCTAssertEqual(entries.map(\.id), ["online", "offline:laptop", "offline"])
        if case .offlineMachine(_, let name, let lastSeen) = entries[1] {
            XCTAssertEqual(name, "MacBook")
            XCTAssertEqual(lastSeen, "last seen 1h ago")
        } else {
            XCTFail("expected an offline banner before the offline row")
        }
    }

    // MARK: - Source, for honest empty states

    func testAccountSnapshotReportsAnAccountSource() {
        let model = ActivityDrawerModel(defaults: defaults)

        model.rebuild(from: snapshot(items: []))

        XCTAssertEqual(model.source, .account)
        XCTAssertTrue(model.isEmpty, "empty-and-reachable is 'all clear', not 'unreachable'")
    }

    func testClearAllReportsNoSourceSoTheDrawerCanSaySo() {
        let model = ActivityDrawerModel(defaults: defaults)
        model.rebuild(from: snapshot(items: [item(id: "a", phase: .running, now: Date())]))

        model.clearAll()

        XCTAssertEqual(model.source, .none)
        XCTAssertTrue(model.isEmpty)
    }

    func testTruncationFlagRidesTheSnapshot() {
        let model = ActivityDrawerModel(defaults: defaults)

        model.rebuild(from: snapshot(items: [], truncated: true))

        XCTAssertTrue(model.itemsTruncated)
    }

    // MARK: - Live-now strip

    func testLiveNowExcludesFinishedAndIdleTierRows() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(from: snapshot(items: [
            item(id: "running", phase: .running, now: now),
            item(id: "needs", phase: .needsYou, now: now),
            item(id: "done", phase: .completed, now: now),
            item(id: "roster", phase: .running, now: now, activityTier: "idle"),
        ]))

        XCTAssertEqual(Set(model.liveNow.map(\.id)), ["running", "needs"])
    }

    // MARK: - Machine-local fallback

    func testWorkspaceFallbackProducesTheSameRowShape() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(from: WorkspaceSnapshot(
            generatedAt: now,
            agents: [
                agent(sessionId: "s-awaiting", status: "running", awaitingInput: true, at: now),
                agent(sessionId: "s-running", status: "running", awaitingInput: false, at: now),
            ],
            prs: [
                PrSnapshot(
                    id: "pr-1",
                    number: 7,
                    title: "Activity revamp",
                    checks: "failing",
                    review: "pending",
                    state: "open",
                    mergeReady: false,
                    updatedAt: now
                ),
            ],
            connection: "connected",
            machineName: "This Mac",
            projectName: "ADE"
        ))

        XCTAssertEqual(model.source, .machineFallback)
        XCTAssertEqual(model.sessions.map(\.id), ["awaiting:s-awaiting", "live:s-running"])
        XCTAssertEqual(model.inbox.map(\.id), ["ci:pr-1"])
        let failingPR = model.inbox.first
        XCTAssertEqual(failingPR?.tier, .signal)
        XCTAssertEqual(failingPR?.band, .needsYou)
        XCTAssertTrue(failingPR?.needsInbox == true)
        XCTAssertEqual(model.sessions.first?.phaseLabel, "Needs you")
        XCTAssertEqual(model.sessions.first?.machineName, "This Mac")
        XCTAssertTrue(
            model.sessions.first?.inlineActionsAllowed == true,
            "rows from the paired host may run inline intents"
        )
    }

    func testDisconnectedMachineDowngradesLiveWorkToStale() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(from: WorkspaceSnapshot(
            generatedAt: now,
            agents: [agent(sessionId: "s", status: "running", awaitingInput: false, at: now)],
            prs: [],
            connection: "disconnected"
        ))

        XCTAssertEqual(model.sessions.first?.phaseLabel, "Stale")
    }

    // MARK: - Fixtures

    private func snapshot(
        items: [AccountAttentionItem],
        revision: Int = 1,
        truncated: Bool = false
    ) -> AccountAttentionSnapshot {
        AccountAttentionSnapshot(
            revision: revision,
            generatedAt: Date(),
            machines: nil,
            items: items,
            tombstones: nil,
            itemsTruncated: truncated
        )
    }

    private func item(
        id: String,
        phase: AccountAttentionPhase,
        now: Date,
        activityTier: String? = nil,
        machine: AccountAttentionMachine? = nil,
        seenAt: Date? = nil,
        dismissedAt: Date? = nil,
        expiresAt: Date? = nil
    ) -> AccountAttentionItem {
        AccountAttentionItem(
            id: id,
            revision: 1,
            fingerprint: "\(id):1",
            kind: .agent,
            eventKind: .agentRunning,
            phase: phase,
            activityTier: activityTier,
            machine: machine ?? AccountAttentionMachine(
                machineKey: "studio",
                name: "Studio Mac",
                online: true,
                lastSeenAt: now
            ),
            project: AccountAttentionProject(projectId: "ade", name: "ADE"),
            title: id,
            preview: "Working",
            privacyPreview: "Agent working",
            destination: .session(sessionId: id, itemId: nil, eventId: nil),
            occurredAt: now,
            updatedAt: now,
            seenAt: seenAt,
            dismissedAt: dismissedAt,
            expiresAt: expiresAt
        )
    }

    private func pullRequest(
        id: String,
        phase: AccountAttentionPhase,
        number: Int,
        now: Date
    ) -> AccountAttentionItem {
        AccountAttentionItem(
            id: id,
            revision: 1,
            fingerprint: "\(id):1",
            kind: .pullRequest,
            eventKind: .prChecksFailing,
            phase: phase,
            machine: AccountAttentionMachine(
                machineKey: "studio",
                name: "Studio Mac",
                online: true,
                lastSeenAt: now
            ),
            project: AccountAttentionProject(projectId: "ade", name: "ADE"),
            title: "PR #\(number)",
            preview: "Checks failing",
            privacyPreview: "Checks failing",
            destination: .pullRequest(
                prId: id,
                repoOwner: nil,
                repoName: nil,
                number: number,
                tab: "overview",
                eventId: nil
            ),
            occurredAt: now,
            updatedAt: now
        )
    }

    private func agent(
        sessionId: String,
        status: String,
        awaitingInput: Bool,
        at: Date
    ) -> AgentSnapshot {
        AgentSnapshot(
            sessionId: sessionId,
            provider: "claude",
            title: "Session \(sessionId)",
            status: status,
            awaitingInput: awaitingInput,
            lastActivityAt: at,
            elapsedSeconds: 12,
            preview: "Working",
            progress: nil,
            phase: nil,
            toolCalls: 0
        )
    }
}
