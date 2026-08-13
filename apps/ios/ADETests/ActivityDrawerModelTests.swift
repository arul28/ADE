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

    func testSessionsAreGroupedByStateInPriorityOrder() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(from: snapshot(items: [
            item(id: "done", phase: .completed, now: now),
            item(id: "working", phase: .running, now: now),
            item(id: "needs", phase: .needsYou, now: now),
        ]))

        // `done` is a resting band, so it is behind the summary line until the
        // reader asks for it — the sheet leads with live work.
        XCTAssertEqual(model.sessionSections.map(\.group), [.needsYou, .working])
        XCTAssertEqual(model.restingSummary?.map(\.group), [.done])
        model.restingExpanded = true
        XCTAssertEqual(model.sessionSections.map(\.group), [.needsYou, .working, .done])
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

        // Files under `idle`, not `needsYou` and not `done`: a roster row is
        // quiet history whatever phase it froze at, and `done` is reserved for
        // work that actually finished.
        XCTAssertTrue(model.sessionSections.filter { $0.group == .needsYou }.isEmpty)
        model.restingExpanded = true
        XCTAssertEqual(model.sessionSections.map(\.group), [.idle])
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

        let entries = model.sessionSections.first { $0.group == .working }?.entries ?? []
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

    // MARK: - Live-wins-per-machine merge

    /// The bug this whole surface was rebuilt around.
    ///
    /// The drawer used to return early on ANY account snapshot fetched within
    /// 24 hours. `generatedAt` is the relay's clock at fetch time and the app
    /// polls every 20 seconds, so that condition is always true while online —
    /// which made the live paired-host snapshot unreachable whenever the user
    /// was signed in. The observable symptom: the home dropdown showed a
    /// working Claude session while this sheet, at the same instant, showed
    /// only that machine's week-old idle rows.
    func testLiveMachineRowsReplaceTheRelaysCopyForThatMachine() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()
        let studio = AccountAttentionMachine(
            machineKey: "studio",
            name: "Studio Mac",
            online: true,
            lastSeenAt: now
        )

        model.rebuild(
            from: snapshot(items: [
                item(id: "stale-roster", phase: .stale, now: now, activityTier: "idle"),
            ]),
            live: WorkspaceSnapshot(
                generatedAt: now,
                agents: [liveAgent(sessionId: "live-run", status: "running", now: now)],
                prs: [],
                connection: "connected",
                machineId: "studio",
                machineName: "Studio Mac"
            )
        )

        let ids = model.sessions.map(\.id)
        XCTAssertTrue(
            ids.contains { $0.contains("live-run") },
            "the live session must appear; it is the one the user can see working"
        )
        XCTAssertFalse(
            ids.contains("stale-roster"),
            "the relay's stale copy of the same machine must not survive alongside it"
        )
        _ = studio
    }

    /// The merge is scoped to the connected machine only. Replacing every
    /// machine's rows with one machine's view would turn an account-wide feed
    /// into a single-machine one precisely when the user is working.
    func testOtherMachinesKeepTheirRelayRowsThroughTheMerge() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()
        let laptop = AccountAttentionMachine(
            machineKey: "laptop",
            name: "MacBook",
            online: false,
            lastSeenAt: now.addingTimeInterval(-3_600)
        )

        model.rebuild(
            from: snapshot(items: [
                item(id: "laptop-row", phase: .running, now: now, machine: laptop),
            ]),
            live: WorkspaceSnapshot(
                generatedAt: now,
                agents: [liveAgent(sessionId: "live-run", status: "running", now: now)],
                prs: [],
                connection: "connected",
                machineId: "studio",
                machineName: "Studio Mac"
            )
        )

        XCTAssertTrue(model.sessions.map(\.id).contains("laptop-row"))
    }

    func testLivePullRequestsReplaceTheRelayCopyOfTheSamePR() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(
            from: snapshot(items: [
                pullRequest(id: "pr-99", phase: .checksFailing, number: 99, now: now),
            ]),
            live: WorkspaceSnapshot(
                generatedAt: now,
                agents: [],
                prs: [
                    PrSnapshot(
                        id: "pr-99",
                        number: 99,
                        title: "Fix the island",
                        checks: "failing",
                        review: "pending",
                        state: "open",
                        mergeReady: false,
                        updatedAt: now
                    ),
                ],
                connection: "connected",
                machineId: "studio",
                machineName: "Studio Mac"
            )
        )

        let inboxIds = model.inbox.map(\.id)
        XCTAssertEqual(inboxIds.filter { $0.contains("pr-99") }.count, 1)
    }

    /// The regression that shipped.
    ///
    /// This test previously asserted the OPPOSITE — that a live snapshot with
    /// no machine identity is ignored — and that assertion was the bug, not the
    /// guard against it. Nothing populated `machineId`, so the drawer discarded
    /// the live rows on every refresh and rendered the relay's stale copy: the
    /// Hub showed four agents working while this sheet showed none, on the same
    /// phone at the same moment. An unscopeable merge must narrow, never fall
    /// back to data known to be older.
    func testAnUnidentifiedLiveSnapshotStillMergesBySessionIdentity() {
        let model = ActivityDrawerModel(defaults: defaults)
        let now = Date()

        model.rebuild(
            from: snapshot(items: [
                // The relay's stale copy of the very session that is live.
                item(id: "live-run", phase: .stale, now: now, activityTier: "idle"),
                item(id: "other-machine-row", phase: .running, now: now),
            ]),
            live: WorkspaceSnapshot(
                generatedAt: now,
                agents: [liveAgent(sessionId: "live-run", status: "running", now: now)],
                prs: [],
                connection: "connected"
            )
        )

        let groups = Dictionary(grouping: model.sessions, by: \.stateGroup)
            .mapValues(\.count)
        XCTAssertEqual(
            groups[.idle] ?? 0,
            0,
            "the relay's stale copy of a live session must not survive the merge"
        )
        XCTAssertTrue(
            model.sessions.contains { $0.stateGroup == .working },
            "the live session must be rendered as working"
        )
        XCTAssertTrue(
            model.sessions.contains { $0.id == "other-machine-row" },
            "an unscopeable merge must not disturb other machines' rows"
        )
    }

    private func liveAgent(
        sessionId: String,
        status: String,
        now: Date
    ) -> AgentSnapshot {
        AgentSnapshot(
            sessionId: sessionId,
            provider: "claude",
            laneName: "Primary",
            title: sessionId,
            status: status,
            awaitingInput: false,
            lastActivityAt: now,
            elapsedSeconds: 12,
            preview: "Exploring innovative features",
            progress: nil,
            phase: nil,
            toolCalls: 3
        )
    }

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
