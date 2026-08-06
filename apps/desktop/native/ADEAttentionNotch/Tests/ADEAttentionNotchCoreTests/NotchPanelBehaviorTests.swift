import XCTest
@testable import ADEAttentionNotchCore
@testable import ADEAttentionNotch

/// The behaviours the redesign added on top of the wire contract: the timed
/// needs-you takeover, the all-clear beat, and the Agents/Events panel with its
/// collapsible sections and clusters.
@MainActor
final class NotchPanelBehaviorTests: XCTestCase {

    /// A card for a row somebody already handled — on the phone, in the web
    /// client, anywhere — is a card about yesterday. It goes away without
    /// waiting out its own timer, and without morphing into a glyph that is no
    /// longer there.
    func testTakeoverDropsWhenTheItemIsAckedFromAnotherDevice() {
        let model = enabledModel()
        model.apply(snapshot(revision: 1, items: [needsYouItem()]))
        model.present(alertToast())
        XCTAssertEqual(model.interaction.presentation, .flash)
        XCTAssertNotNil(model.activeToast)

        model.apply(snapshot(
            revision: 2,
            items: [needsYouItem(seenAt: "2026-08-01T12:05:00Z")]
        ))

        XCTAssertNil(model.activeToast)
        XCTAssertFalse(model.isTakeoverCollapsing)
        XCTAssertEqual(model.interaction.presentation, .compact)
    }

    /// The card also goes away when the row itself drains out of the feed.
    func testTakeoverDropsWhenTheItemLeavesTheFeed() {
        let model = enabledModel()
        model.apply(snapshot(revision: 1, items: [needsYouItem(), workingItem()]))
        model.present(alertToast())
        XCTAssertEqual(model.interaction.presentation, .flash)

        model.apply(snapshot(revision: 2, items: [workingItem()]))

        XCTAssertNil(model.activeToast)
        XCTAssertEqual(model.interaction.presentation, .compact)
    }

    /// Explicit close settles the surface the same way a timeout does.
    func testExplicitCloseEndsTheTakeover() {
        let model = enabledModel()
        model.prefersReducedMotion = { true }
        model.apply(snapshot(revision: 1, items: [needsYouItem()]))
        model.present(alertToast())

        model.dismissTakeover()

        XCTAssertNil(model.activeToast)
        XCTAssertEqual(model.interaction.presentation, .compact)
    }

    /// The all-clear beat is earned: it fires on the falling edge of the amber
    /// count and never as an ambient decoration of an already-quiet account.
    func testAllClearBeatOnlyFollowsAClearedNeedsYouCount() {
        let model = enabledModel()
        model.apply(snapshot(revision: 1, items: [], counts: AttentionCounts(needsYou: 0, total: 0)))
        XCTAssertFalse(model.isAllClear)

        model.apply(snapshot(
            revision: 2,
            items: [needsYouItem()],
            counts: AttentionCounts(needsYou: 1, total: 1)
        ))
        XCTAssertFalse(model.isAllClear)

        model.apply(snapshot(
            revision: 3,
            items: [workingItem()],
            counts: AttentionCounts(needsYou: 0, working: 1, total: 1)
        ))
        XCTAssertTrue(model.isAllClear)
        // In hover mode the strip is dormant, so the beat has to hold it open
        // long enough to be seen at all.
        XCTAssertTrue(model.isHoldingReveal)
    }

    /// #17: a takeover the user clicks through opens the panel *at* what it was
    /// about — the Events tab, that PR's cluster, expanded and focused.
    func testClickingThroughAPullRequestTakeoverOpensTheEventsCluster() {
        let model = enabledModel()
        model.apply(snapshot(revision: 1, items: [
            workingItem(),
            checkItem(id: "check-1", phase: "checks_failing"),
            checkItem(id: "check-2", phase: "checks_failing"),
        ]))
        model.present(AttentionToast(
            itemId: "check-1",
            eventKind: "pr_checks_failing",
            treatment: .alert,
            title: "Checks failing #466"
        ))
        XCTAssertEqual(model.interaction.presentation, .flash)

        model.toggleExpanded()

        XCTAssertEqual(model.interaction.presentation, .expanded)
        XCTAssertEqual(model.selectedTab, .events)
        XCTAssertEqual(model.focusedRowId, "cluster:pr:ade/desktop#466")
        XCTAssertTrue(model.expandedClusterIds.contains("pr:ade/desktop#466"))
        // Expanded, the cluster shows its individual updates under one header.
        XCTAssertEqual(model.panelRows.count, 3)
    }

    /// Collapsing a section removes its rows from what is drawn *and* from what
    /// the keyboard walks — one list, so the two can never disagree.
    func testCollapsingASectionRemovesItsRowsFromDrawAndKeyboardOrder() {
        let model = enabledModel()
        model.apply(snapshot(revision: 1, items: [needsYouItem(), workingItem()]))
        model.toggleExpanded()

        XCTAssertEqual(
            model.panelRows.map(\.id),
            ["section:needs-you", "needs-1", "section:working", "working-1"]
        )

        model.toggleSection("needs-you")
        XCTAssertEqual(
            model.panelRows.map(\.id),
            ["section:needs-you", "section:working", "working-1"]
        )

        model.moveFocus(by: 1)
        XCTAssertEqual(model.focusedRowId, "section:working")
        model.moveFocus(by: 1)
        XCTAssertEqual(model.focusedRowId, "working-1")
        // Focus stops at the ends rather than wrapping into nothing.
        model.moveFocus(by: 5)
        XCTAssertEqual(model.focusedRowId, "working-1")
    }

    /// The panel and the strip file a row under the same name. They used to
    /// disagree: the panel's own three-way split by numeric phase priority put
    /// a failure under "Needs you" and had no Planning section at all, so the
    /// strip could count a red row the panel then drew in amber.
    func testPanelSectionsMatchTheStripGroupsRowForRow() {
        let model = enabledModel()
        let failed = agentItem(id: "failed-1", phase: "checks_failing")
        let planning = agentItem(id: "planning-1", phase: "running", mode: .planning)
        model.apply(snapshot(revision: 1, items: [
            needsYouItem(),
            failed,
            planning,
            workingItem(),
        ]))
        model.toggleExpanded()

        XCTAssertEqual(model.panelRows.map(\.id), [
            "section:needs-you", "needs-1",
            "section:failed", "failed-1",
            "section:planning", "planning-1",
            "section:working", "working-1",
        ])
        XCTAssertEqual(
            model.stripGroups.map(\.kind),
            [.needsYou, .failed, .planning, .working]
        )

        // And opening the panel at a failed row uncollapses the section that
        // row is actually in, rather than the one the old table named.
        model.dismissExpanded()
        model.toggleSection("failed")
        XCTAssertTrue(model.collapsedSectionIds.contains("failed"))
        model.openPanel(revealing: failed)
        XCTAssertFalse(model.collapsedSectionIds.contains("failed"))
        XCTAssertEqual(model.focusedRowId, "failed-1")
    }

    /// Done is the most final and most common state, so the panel opens with it
    /// folded away — reachable in one keystroke, not in your face.
    func testDoneStartsCollapsedAndReopensOnDemand() {
        let model = enabledModel()
        model.apply(snapshot(revision: 1, items: [workingItem(), doneItem()]))
        model.toggleExpanded()
        XCTAssertEqual(
            model.panelRows.map(\.id),
            ["section:working", "working-1", "section:done"]
        )

        model.toggleSection("done")
        XCTAssertEqual(model.panelRows.last?.id, "done-1")
    }

    /// Left and right work the disclosure the focus is on, like every other
    /// list on the system.
    func testArrowKeysCollapseAndExpandWhateverIsFocused() {
        let model = enabledModel()
        model.apply(snapshot(revision: 1, items: [needsYouItem()]))
        model.toggleExpanded()
        XCTAssertEqual(model.focusedRowId, "section:needs-you")

        model.setFocusedRowExpanded(false)
        XCTAssertTrue(model.collapsedSectionIds.contains("needs-you"))
        model.setFocusedRowExpanded(true)
        XCTAssertFalse(model.collapsedSectionIds.contains("needs-you"))

        // Return on a heading is the same gesture.
        model.activateFocusedRow()
        XCTAssertTrue(model.collapsedSectionIds.contains("needs-you"))
    }

    func testTabsPartitionTheFeedAndKeepTheirOwnCounts() {
        let model = enabledModel()
        model.apply(snapshot(revision: 1, items: [
            workingItem(),
            needsYouItem(),
            checkItem(id: "check-1", phase: "checks_failing"),
            checkItem(id: "check-2", phase: "checks_failing"),
        ]))
        model.toggleExpanded()

        XCTAssertEqual(model.selectedTab, .agents)
        XCTAssertEqual(model.agentCount, 2)
        // Two checks on one PR are one story.
        XCTAssertEqual(model.eventCount, 1)

        model.cycleTab()
        XCTAssertEqual(model.selectedTab, .events)
        XCTAssertEqual(model.panelRows.map(\.id), ["cluster:pr:ade/desktop#466"])
    }

    /// A surface that eats clicks and does nothing is the one outcome no mode
    /// may produce: with the tall panel switched off, the click opens ADE.
    func testClickWithThePanelDisabledOpensActivityInADE() {
        let model = enabledModel(expandedPanelEnabled: false)
        var outputs: [NotchOutput] = []
        model.emit = { outputs.append($0) }
        model.apply(snapshot(revision: 1, items: [workingItem()]))

        model.toggleExpanded()

        XCTAssertEqual(model.interaction.presentation, .compact)
        XCTAssertEqual(outputs.map(\.type), ["open_center"])
    }

    /// The strip is the same in both modes; only whether it rests on screen
    /// differs, and the pointer is what decides that.
    func testDormancyFollowsThePointerInHoverModeOnly() {
        let hover = enabledModel(revealMode: .hover)
        hover.apply(snapshot(revision: 1, items: [workingItem()]))
        XCTAssertTrue(hover.isDormantHoverSurface)
        hover.pointerChanged(isInside: true)
        XCTAssertFalse(hover.isDormantHoverSurface)

        let pinned = enabledModel(revealMode: .always)
        pinned.apply(snapshot(revision: 1, items: [workingItem()]))
        XCTAssertFalse(pinned.isDormantHoverSurface)
    }

    /// A takeover that lands while the user is reading the panel waits instead
    /// of replacing what they opened.
    func testATakeoverArrivingOverAnOpenPanelWaitsForIt() {
        let model = enabledModel()
        model.apply(snapshot(revision: 1, items: [needsYouItem()]))
        model.toggleExpanded()
        XCTAssertEqual(model.interaction.presentation, .expanded)

        model.present(alertToast())
        XCTAssertNil(model.activeToast)
        XCTAssertEqual(model.interaction.presentation, .expanded)

        model.dismissExpanded()
        XCTAssertEqual(model.interaction.presentation, .flash)
        XCTAssertNotNil(model.activeToast)
    }

    // MARK: - Fixtures

    private func enabledModel(
        revealMode: NotchRevealMode = .always,
        expandedPanelEnabled: Bool = true
    ) -> NotchViewModel {
        let model = NotchViewModel()
        model.prefersReducedMotion = { false }
        model.handle(.settings(NotchSettings(
            enabled: true,
            revealMode: revealMode,
            expandedPanelEnabled: expandedPanelEnabled,
            hideDetails: false,
            celebrationsEnabled: true,
            soundsEnabled: false
        )))
        return model
    }

    private func alertToast() -> AttentionToast {
        AttentionToast(
            itemId: "needs-1",
            eventKind: "agent_needs_you",
            treatment: .alert,
            title: "Claude needs you",
            subtitle: "PR #1038 green, needs review approval before merge."
        )
    }

    private func snapshot(
        revision: Int,
        items: [AttentionItem],
        counts: AttentionCounts? = nil
    ) -> AttentionSnapshot {
        AttentionSnapshot(
            streamId: "account:test",
            revision: revision,
            generatedAt: "2026-08-01T12:00:0\(min(9, revision))Z",
            items: items,
            counts: counts
        )
    }

    private func needsYouItem(seenAt: String? = nil) -> AttentionItem {
        agentItem(id: "needs-1", phase: "needs_you", seenAt: seenAt)
    }

    private func workingItem() -> AttentionItem {
        agentItem(id: "working-1", phase: "running")
    }

    private func doneItem() -> AttentionItem {
        agentItem(id: "done-1", phase: "completed")
    }

    private func agentItem(
        id: String,
        phase: String,
        seenAt: String? = nil,
        mode: AttentionChatActivityMode? = nil
    ) -> AttentionItem {
        AttentionItem(
            id: id,
            fingerprint: "f-\(id)",
            kind: "agent",
            eventKind: "agent_needs_you",
            phase: phase,
            machine: AttentionMachine(machineKey: "m", name: "Studio", online: true, lastSeenAt: nil),
            project: AttentionProject(projectId: "ade", name: "ADE"),
            laneName: "notch-redesign",
            provider: "claude",
            chatActivityMode: mode,
            title: "Claude needs you",
            preview: "PR #1038 green, needs review approval before merge.",
            privacyPreview: "Agent update",
            destination: AttentionDestination(kind: "session", sessionId: "session-\(id)"),
            occurredAt: "2026-08-01T12:00:00Z",
            updatedAt: "2026-08-01T12:00:00Z",
            seenAt: seenAt
        )
    }

    private func checkItem(id: String, phase: String) -> AttentionItem {
        AttentionItem(
            id: id,
            fingerprint: "f-\(id)",
            kind: "pull_request",
            eventKind: "pr_checks_failing",
            phase: phase,
            machine: AttentionMachine(machineKey: "m", name: "Studio", online: true, lastSeenAt: nil),
            project: AttentionProject(projectId: "ade", name: "ADE"),
            title: "Checks failing",
            preview: "build / lint",
            privacyPreview: "Pull request update",
            destination: AttentionDestination(
                kind: "pull_request",
                repoOwner: "ade",
                repoName: "desktop",
                number: 466
            ),
            occurredAt: "2026-08-01T12:00:00Z",
            updatedAt: "2026-08-01T12:00:00Z"
        )
    }
}
