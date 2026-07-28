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
            preview: "Choose the release target",
            pendingInputItemId: "pending-approval-1",
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
        XCTAssertEqual(awaiting?.itemId, "pending-approval-1")
        XCTAssertEqual(awaiting?.deepLink, URL(string: "ade://session/s-awaiting"))
        XCTAssertEqual(awaiting?.subtitle, "Choose the release target")

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

    func testWorkspaceFallbackBuildsPriorityLiveAndRecentStacks() {
        let model = AttentionDrawerModel(defaults: defaults)
        let now = Date()
        let snapshot = WorkspaceSnapshot(
            generatedAt: now,
            agents: [
                AgentSnapshot(
                    sessionId: "waiting",
                    provider: "claude",
                    laneName: "Primary",
                    title: "Approve release",
                    status: "awaiting_input",
                    awaitingInput: true,
                    lastActivityAt: now,
                    elapsedSeconds: 12,
                    preview: "Approve the push",
                    pendingInputItemId: "approval-1",
                    progress: nil,
                    phase: "validation",
                    toolCalls: 2
                ),
                AgentSnapshot(
                    sessionId: "working",
                    provider: "codex",
                    laneName: "feature/attention",
                    title: "Polish mobile UI",
                    status: "running",
                    awaitingInput: false,
                    lastActivityAt: now.addingTimeInterval(-30),
                    elapsedSeconds: 300,
                    preview: "Rendering the priority stack",
                    progress: 0.7,
                    phase: "development",
                    toolCalls: 8
                ),
                AgentSnapshot(
                    sessionId: "done",
                    provider: "codex",
                    laneName: "feature/attention",
                    title: "Model contract",
                    status: "completed",
                    awaitingInput: false,
                    lastActivityAt: now.addingTimeInterval(-120),
                    elapsedSeconds: 180,
                    preview: "Completed",
                    progress: 1,
                    phase: "validation",
                    toolCalls: 4
                ),
            ],
            prs: [],
            connection: "connected",
            machineId: "studio",
            machineName: "Studio Mac",
            projectId: "ade",
            projectName: "ADE"
        )

        model.rebuild(from: snapshot)

        XCTAssertEqual(model.items.map(\.sessionId), ["waiting"])
        XCTAssertEqual(model.liveItems.map(\.sessionId), ["working"])
        XCTAssertEqual(model.recentItems.map(\.sessionId), ["done"])
        XCTAssertEqual(model.projectLenses.map(\.name), ["ADE"])
        XCTAssertEqual(model.visibleMachineCount, 1)
        XCTAssertEqual(model.liveItems.first?.scopeLabel, "Studio Mac · ADE")
    }

    func testAccountSnapshotSupportsProjectLensAndExactDestinations() {
        let model = AttentionDrawerModel(defaults: defaults)
        let now = Date()
        let studio = AccountAttentionMachine(
            machineKey: "studio",
            accountMachineKey: "account-studio",
            name: "Studio Mac",
            online: true,
            lastSeenAt: now
        )
        let laptop = AccountAttentionMachine(
            machineKey: "laptop",
            name: "MacBook",
            online: false,
            lastSeenAt: now.addingTimeInterval(-120)
        )

        let snapshot = AccountAttentionSnapshot(
            revision: 7,
            generatedAt: now,
            items: [
                AccountAttentionItem(
                    id: "approval",
                    revision: 2,
                    fingerprint: "approval:2",
                    kind: .agent,
                    eventKind: .agentNeedsYou,
                    phase: .needsYou,
                    machine: studio,
                    project: .init(projectId: "ade", name: "ADE"),
                    laneName: "Primary",
                    provider: "claude",
                    title: "Release ADE",
                    preview: "Approve git push",
                    privacyPreview: "Approval required",
                    destination: .session(sessionId: "session-a", itemId: "item-a", eventId: "event-a"),
                    occurredAt: now,
                    updatedAt: now
                ),
                AccountAttentionItem(
                    id: "live",
                    revision: 1,
                    fingerprint: "live:1",
                    kind: .agent,
                    eventKind: .agentCompleted,
                    phase: .running,
                    machine: laptop,
                    project: .init(projectId: "versic", name: "Versic"),
                    provider: "codex",
                    title: "Fix Windows sync",
                    preview: "Running tests",
                    privacyPreview: "Agent working",
                    destination: .session(sessionId: "session-b", itemId: nil, eventId: nil),
                    occurredAt: now,
                    updatedAt: now
                ),
            ]
        )

        model.rebuild(from: snapshot)

        XCTAssertEqual(model.projectLenses.map(\.name).sorted(), ["ADE", "Versic"])
        XCTAssertEqual(
            model.items.first?.deepLink,
            URL(
                string: "ade://session/session-a?item=item-a&event=event-a&accountMachineKey=account-studio"
            )
        )
        XCTAssertEqual(model.items.first?.inlineActionsAllowed, false)
        XCTAssertEqual(model.visibleMachineCount, 2)
        XCTAssertEqual(
            AccountAttentionDestination.pullRequest(
                prId: "pr-42",
                repoOwner: "openai",
                repoName: "ade",
                number: 42,
                tab: "checks",
                eventId: "event-pr"
            ).deepLinkURL(accountMachineKey: studio.accountMachineKey),
            URL(
                string: "ade://pr/openai/ade/42?tab=checks&event=event-pr&accountMachineKey=account-studio"
            )
        )

        model.selectProject("versic")
        XCTAssertTrue(model.visibleItems(in: .needsYou).isEmpty)
        XCTAssertEqual(model.visibleItems(in: .live).map(\.id), ["live"])
        XCTAssertEqual(model.visibleMachineCount, 1)
    }

    func testAccountSnapshotDeltaHonorsItemAndTombstoneRevisions() {
        let now = Date()
        let current = AccountAttentionSnapshot(
            revision: 8,
            generatedAt: now,
            items: [
                makeAccountItem(id: "keep", revision: 5, title: "Newest value", now: now),
                makeAccountItem(id: "remove", revision: 2, title: "Remove me", now: now),
            ]
        )
        let delta = AccountAttentionSnapshot(
            revision: 9,
            generatedAt: now.addingTimeInterval(1),
            items: [
                makeAccountItem(id: "keep", revision: 4, title: "Stale value", now: now),
                makeAccountItem(id: "add", revision: 1, title: "Added", now: now),
            ],
            tombstones: [
                AccountAttentionTombstone(
                    id: "keep",
                    revision: 4,
                    deletedAt: now
                ),
                AccountAttentionTombstone(
                    id: "remove",
                    revision: 3,
                    deletedAt: now
                ),
            ]
        )

        let merged = current.merging(delta)

        XCTAssertEqual(merged.revision, 9)
        XCTAssertEqual(Set(merged.items.map(\.id)), ["keep", "add"])
        XCTAssertEqual(
            merged.items.first(where: { $0.id == "keep" })?.title,
            "Newest value"
        )
    }

    func testOutOfOrderSnapshotCommitCannotRegressRevisionOrDropNewerItems() {
        let now = Date()
        let base = AccountAttentionSnapshot(
            streamId: "account-a",
            revision: 10,
            generatedAt: now,
            items: [
                makeAccountItem(id: "existing", revision: 10, title: "Existing", now: now),
            ]
        )
        let revisionTwelve = AccountAttentionSnapshot(
            streamId: "account-a",
            revision: 12,
            generatedAt: now.addingTimeInterval(2),
            items: [
                makeAccountItem(id: "newer", revision: 12, title: "Newer", now: now),
            ]
        )
        let revisionEleven = AccountAttentionSnapshot(
            streamId: "account-a",
            revision: 11,
            generatedAt: now.addingTimeInterval(1),
            items: [
                makeAccountItem(id: "stale", revision: 11, title: "Stale", now: now),
            ]
        )

        let committedTwelve = accountAttentionSnapshotForCommit(
            current: base,
            incoming: revisionTwelve
        )
        let afterLateEleven = accountAttentionSnapshotForCommit(
            current: committedTwelve,
            incoming: revisionEleven
        )

        XCTAssertEqual(afterLateEleven.revision, 12)
        XCTAssertEqual(
            Set(afterLateEleven.items.map(\.id)),
            ["existing", "newer"]
        )
    }

    func testSnapshotStreamChangeResetsPriorAccountItems() {
        let now = Date()
        let priorAccount = AccountAttentionSnapshot(
            streamId: "account-a",
            revision: 42,
            generatedAt: now,
            items: [
                makeAccountItem(id: "private-a", revision: 42, title: "Private A", now: now),
            ]
        )
        let newAccount = AccountAttentionSnapshot(
            streamId: "account-b",
            revision: 1,
            generatedAt: now.addingTimeInterval(1),
            items: [
                makeAccountItem(id: "private-b", revision: 1, title: "Private B", now: now),
            ]
        )

        let committed = accountAttentionSnapshotForCommit(
            current: priorAccount,
            incoming: newAccount
        )

        XCTAssertEqual(committed.streamId, "account-b")
        XCTAssertEqual(committed.revision, 1)
        XCTAssertEqual(committed.items.map(\.id), ["private-b"])
    }

    func testOpenPullRequestIsRecentAndExpiredItemsAreRemoved() {
        let model = AttentionDrawerModel(defaults: defaults)
        let now = Date()
        let scope = AccountAttentionMachine(
            machineKey: "studio",
            name: "Studio Mac",
            online: true,
            lastSeenAt: now
        )
        let openPullRequest = AccountAttentionItem(
            id: "pr-open",
            revision: 1,
            fingerprint: "pr-open:1",
            kind: .pullRequest,
            eventKind: .prOpened,
            phase: .open,
            machine: scope,
            project: .init(projectId: "ade", name: "ADE"),
            title: "Open pull request",
            preview: "Waiting for activity",
            privacyPreview: "Pull request open",
            destination: .pullRequest(
                prId: "pr-open",
                repoOwner: "ade",
                repoName: "ade",
                number: 42,
                tab: "overview",
                eventId: nil
            ),
            occurredAt: now,
            updatedAt: now
        )
        let expired = AccountAttentionItem(
            id: "expired",
            revision: 1,
            fingerprint: "expired:1",
            kind: .agent,
            eventKind: .agentNeedsYou,
            phase: .needsYou,
            machine: scope,
            project: .init(projectId: "ade", name: "ADE"),
            title: "Old approval",
            preview: "No longer actionable",
            privacyPreview: "Approval required",
            destination: .session(sessionId: "old", itemId: "item-old", eventId: nil),
            occurredAt: now.addingTimeInterval(-120),
            updatedAt: now.addingTimeInterval(-120),
            expiresAt: now.addingTimeInterval(-1)
        )

        model.rebuild(from: .init(
            revision: 1,
            generatedAt: now.addingTimeInterval(-60),
            items: [openPullRequest, expired]
        ))

        XCTAssertFalse(openPullRequest.isLive)
        XCTAssertTrue(model.items.isEmpty)
        XCTAssertTrue(model.liveItems.isEmpty)
        XCTAssertEqual(model.recentItems.map(\.id), ["pr-open"])
        XCTAssertEqual(model.recentItems.first?.kind, .open)
    }

    func testMarkingOneItemSeenDoesNotClearOtherUnreadItems() {
        let model = AttentionDrawerModel(defaults: defaults)
        let now = Date()
        let agents = ["one", "two"].map { id in
            AgentSnapshot(
                sessionId: id,
                provider: "codex",
                title: id,
                status: "awaiting_input",
                awaitingInput: true,
                lastActivityAt: now,
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

        model.markSeen("awaiting:one")

        XCTAssertEqual(model.unreadCount, 1)
        XCTAssertEqual(model.badgeLabel, "1")
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

    func testClearVisibleItemsHidesCurrentCardsAndPersistsDismissal() {
        let model = AttentionDrawerModel(defaults: defaults)
        let now = Date()
        let snapshot = WorkspaceSnapshot(
            generatedAt: now,
            agents: [],
            prs: [
                PrSnapshot(
                    id: "pr-1",
                    number: 9101,
                    title: "Mobile attention CI failing",
                    checks: "failing",
                    review: "approved",
                    state: "open",
                    mergeReady: false
                )
            ],
            connection: "connected"
        )

        model.rebuild(from: snapshot)
        XCTAssertEqual(model.items.map(\.id), ["ci:pr-1"])

        model.clearVisibleItems()

        XCTAssertTrue(model.items.isEmpty)
        XCTAssertEqual(model.unreadCount, 0)
        XCTAssertEqual(
            Set(defaults.stringArray(forKey: AttentionDrawerModel.dismissedItemIDsKey) ?? []),
            ["ci:pr-1"]
        )

        let freshModel = AttentionDrawerModel(defaults: defaults)
        freshModel.rebuild(from: snapshot)
        XCTAssertTrue(freshModel.items.isEmpty, "persisted dismissals should hide the same still-active attention")
    }

    func testClearedItemsReappearAfterBackingStateClears() {
        let model = AttentionDrawerModel(defaults: defaults)
        let now = Date()
        let failing = WorkspaceSnapshot(
            generatedAt: now,
            agents: [],
            prs: [
                PrSnapshot(
                    id: "pr-1",
                    number: 9101,
                    title: "Mobile attention CI failing",
                    checks: "failing",
                    review: "approved",
                    state: "open",
                    mergeReady: false
                )
            ],
            connection: "connected"
        )

        model.rebuild(from: failing)
        model.clearVisibleItems()
        model.rebuild(from: failing)
        XCTAssertTrue(model.items.isEmpty)

        model.rebuild(from: .init(
            generatedAt: now.addingTimeInterval(1),
            agents: [],
            prs: [],
            connection: "connected"
        ))
        model.rebuild(from: .init(
            generatedAt: now.addingTimeInterval(2),
            agents: [],
            prs: failing.prs,
            connection: "connected"
        ))

        XCTAssertEqual(model.items.map(\.id), ["ci:pr-1"])
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

    func testViewedOpenPrDoesNotRebadgeWhenSnapshotRegenerates() {
        let model = AttentionDrawerModel(defaults: defaults)
        let prUpdatedAt = Date().addingTimeInterval(-60)
        let firstSnapshot = WorkspaceSnapshot(
            generatedAt: Date(),
            agents: [],
            prs: [
                PrSnapshot(
                    id: "pr-still-open",
                    number: 83,
                    title: "Still open",
                    checks: "failing",
                    review: "approved",
                    state: "open",
                    mergeReady: false,
                    updatedAt: prUpdatedAt
                )
            ],
            connection: "connected"
        )

        model.rebuild(from: firstSnapshot)
        XCTAssertEqual(model.unreadCount, 1)

        model.markAllSeen()
        model.rebuild(from: WorkspaceSnapshot(
            generatedAt: Date().addingTimeInterval(2),
            agents: [],
            prs: firstSnapshot.prs,
            connection: "connected"
        ))

        XCTAssertEqual(model.items.map(\.id), ["ci:pr-still-open"])
        XCTAssertEqual(model.unreadCount, 0)
        XCTAssertNil(model.badgeLabel)
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

    func testAccountAttentionPhaseLabelsUseUnifiedVocabulary() {
        XCTAssertEqual(AccountAttentionPhase.running.displayLabel, "Running")
        XCTAssertEqual(AccountAttentionPhase.needsYou.displayLabel, "Needs you")
        XCTAssertEqual(AccountAttentionPhase.checksFailing.displayLabel, "Checks failing")
        XCTAssertEqual(AccountAttentionPhase.reviewRequested.displayLabel, "Review requested")
        XCTAssertEqual(AccountAttentionPhase.mergeReady.displayLabel, "Ready to merge")
        XCTAssertEqual(AccountAttentionPhase.completed.displayLabel, "Completed")
    }

    private func makeAccountItem(
        id: String,
        revision: Int,
        title: String,
        now: Date
    ) -> AccountAttentionItem {
        AccountAttentionItem(
            id: id,
            revision: revision,
            fingerprint: "\(id):\(revision)",
            kind: .agent,
            eventKind: .agentRunning,
            phase: .running,
            machine: .init(
                machineKey: "studio",
                name: "Studio Mac",
                online: true,
                lastSeenAt: now
            ),
            project: .init(projectId: "ade", name: "ADE"),
            title: title,
            preview: "Working",
            privacyPreview: "Agent working",
            destination: .session(sessionId: id, itemId: nil, eventId: nil),
            occurredAt: now,
            updatedAt: now
        )
    }
}
