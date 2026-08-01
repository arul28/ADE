import XCTest
@testable import ADE

/// The anti-drift test for the iOS half of the status vocabulary. Every
/// expectation here is transcribed from
/// `apps/desktop/src/shared/sessionStatusPresentation.ts` (session phases) and
/// `renderer/components/attention/attentionPresentation.ts`
/// (`NON_SESSION_PRESENTATION` + `NON_SESSION_STATUS_DETAILS`). If a hue or a
/// word moves on desktop and not here, this fails — which is the whole point.
final class ActivityRowPresentationTests: XCTestCase {

    // MARK: - Phase parity table

    func testPhaseTableMatchesDesktopVocabulary() {
        let expectations: [(AccountAttentionPhase, String, ActivityTone, ActivityGlyph?, Bool, Bool)] = [
            (.starting, "Starting", .blue, .working, false, false),
            (.running, "Working", .blue, .working, true, false),
            (.needsYou, "Needs you", .amber, .needsYou, false, true),
            (.completed, "Done", .emerald, .done, false, true),
            (.failed, "Failed", .red, .failed, false, true),
            (.stale, "Stale", .neutral, .stale, true, false),
            (.blocked, "Blocked", .neutral, nil, false, false),
            (.checksFailing, "Checks failing", .red, .failed, false, true),
            (.reviewRequested, "Review requested", .violet, .review, false, true),
            (.changesRequested, "Changes requested", .red, .failed, false, true),
            (.mergeReady, "Ready to merge", .emerald, .done, false, true),
            (.open, "Open", .blue, nil, false, false),
            (.merged, "Merged", .emerald, .merged, false, true),
            (.closed, "Closed", .neutral, nil, false, false),
        ]

        for (phase, label, tone, glyph, showsElapsed, prominent) in expectations {
            let presentation = ActivityPhaseVocabulary.presentation(for: phase)
            XCTAssertEqual(presentation.label, label, "label for \(phase.rawValue)")
            XCTAssertEqual(presentation.tone, tone, "tone for \(phase.rawValue)")
            XCTAssertEqual(presentation.glyph, glyph, "glyph for \(phase.rawValue)")
            XCTAssertEqual(presentation.showsElapsed, showsElapsed, "elapsed for \(phase.rawValue)")
            XCTAssertEqual(presentation.prominent, prominent, "prominence for \(phase.rawValue)")
        }
    }

    func testAmberIsSpentOnExactlyOnePhase() {
        let amber: [AccountAttentionPhase] = [
            .starting, .running, .needsYou, .completed, .failed, .stale, .blocked,
            .checksFailing, .reviewRequested, .changesRequested, .mergeReady,
            .open, .merged, .closed,
        ].filter { ActivityPhaseVocabulary.presentation(for: $0).tone == .amber }

        XCTAssertEqual(amber, [.needsYou])
    }

    func testUnknownPhaseIsNeutralAndSilent() {
        let presentation = ActivityPhaseVocabulary.presentation(for: .unrecognized("teleporting"))

        XCTAssertEqual(presentation.tone, .neutral)
        XCTAssertEqual(presentation.label, "Unknown")
        XCTAssertNil(presentation.glyph)
        XCTAssertFalse(presentation.prominent)
    }

    func testPlanningPhaseKeepsTheDesktopVioletLabel() {
        let presentation = ActivityPhaseVocabulary.presentation(for: .unrecognized("planning"))

        XCTAssertEqual(presentation.label, "Planning")
        XCTAssertEqual(presentation.tone, .violet)
        XCTAssertTrue(presentation.showsElapsed)
    }

    // MARK: - Bands

    func testBandsFileNeedsYouFirstAndOutcomesLast() {
        XCTAssertEqual(ActivityPhaseVocabulary.band(for: .needsYou), .needsYou)
        XCTAssertEqual(ActivityPhaseVocabulary.band(for: .failed), .needsYou)
        XCTAssertEqual(ActivityPhaseVocabulary.band(for: .running), .working)
        XCTAssertEqual(ActivityPhaseVocabulary.band(for: .blocked), .working)
        XCTAssertEqual(ActivityPhaseVocabulary.band(for: .completed), .done)
        XCTAssertEqual(ActivityPhaseVocabulary.band(for: .merged), .done)
    }

    func testIdleTierNeverReachesTheNeedsYouBand() {
        let row = ActivityRowPresentation(
            item: makeItem(phase: .needsYou, activityTier: "idle")
        )

        XCTAssertEqual(row.tier, .idle)
        XCTAssertEqual(row.band, .working, "an idle row must never sit at the top of the drawer")
    }

    func testSignalTierNeedsYouStaysInTheNeedsYouBand() {
        let row = ActivityRowPresentation(item: makeItem(phase: .needsYou))

        XCTAssertEqual(row.tier, .signal)
        XCTAssertEqual(row.band, .needsYou)
    }

    // MARK: - Elapsed

    func testElapsedAnchorsOnStatusSinceWhenPresent() {
        let now = Date()
        let row = ActivityRowPresentation(
            item: makeItem(
                phase: .running,
                statusSince: now.addingTimeInterval(-42),
                occurredAt: now.addingTimeInterval(-9_000)
            )
        )

        XCTAssertEqual(row.elapsedSince, now.addingTimeInterval(-42))
        XCTAssertEqual(row.elapsedLabel(now: now), "42s")
    }

    func testElapsedFallsBackToOccurredAtWithoutStatusSince() {
        let now = Date()
        let row = ActivityRowPresentation(
            item: makeItem(phase: .running, occurredAt: now.addingTimeInterval(-180))
        )

        XCTAssertEqual(row.elapsedLabel(now: now), "3m")
    }

    func testElapsedIsSuppressedForPhasesWhereAgeIsNoise() {
        let now = Date()
        let row = ActivityRowPresentation(
            item: makeItem(phase: .failed, occurredAt: now.addingTimeInterval(-180))
        )

        XCTAssertNil(row.elapsedLabel(now: now))
    }

    func testDurationFormattingIsLossyAboveTheHour() {
        XCTAssertEqual(ActivityRowPresentation.formatDuration(0), "0s")
        XCTAssertEqual(ActivityRowPresentation.formatDuration(59), "59s")
        XCTAssertEqual(ActivityRowPresentation.formatDuration(60), "1m")
        XCTAssertEqual(ActivityRowPresentation.formatDuration(3_599), "59m")
        XCTAssertEqual(ActivityRowPresentation.formatDuration(3_600), "1h")
        XCTAssertEqual(ActivityRowPresentation.formatDuration(86_400), "1d")
        XCTAssertNil(ActivityRowPresentation.formatDuration(-1))
    }

    // MARK: - Machine presence

    func testOfflineMachineCarriesLastSeenCopyAndStopsPulsing() {
        let now = Date()
        let row = ActivityRowPresentation(
            item: makeItem(
                phase: .running,
                machine: AccountAttentionMachine(
                    machineKey: "studio",
                    name: "Studio Mac",
                    online: false,
                    lastSeenAt: now.addingTimeInterval(-7_200)
                )
            )
        )

        XCTAssertFalse(row.machineOnline)
        XCTAssertFalse(row.isActive, "a row on an unreachable machine must not read as live")
        XCTAssertEqual(row.lastSeenLabel(now: now), "last seen 2h ago")
    }

    func testOnlineMachineHasNoLastSeenCopy() {
        let row = ActivityRowPresentation(item: makeItem(phase: .running))

        XCTAssertTrue(row.machineOnline)
        XCTAssertNil(row.lastSeenLabel())
    }

    // MARK: - Field projection

    func testStatusNoteFallsBackThroughPreviewDetailThenPrivacyPreview() {
        XCTAssertEqual(
            ActivityRowPresentation(item: makeItem(phase: .running, preview: "Editing the router")).statusNote,
            "Editing the router"
        )
        XCTAssertEqual(
            ActivityRowPresentation(item: makeItem(phase: .running, preview: "  ", detail: "Ran 4 tools")).statusNote,
            "Ran 4 tools"
        )
        XCTAssertEqual(
            ActivityRowPresentation(
                item: makeItem(phase: .running, preview: "", detail: nil, privacyPreview: "Agent working")
            ).statusNote,
            "Agent working"
        )
        XCTAssertNil(
            ActivityRowPresentation(
                item: makeItem(phase: .running, preview: "", detail: nil, privacyPreview: "")
            ).statusNote
        )
    }

    func testPullRequestItemsCarryTheirNumberAndNoSession() {
        let row = ActivityRowPresentation(
            item: makeItem(
                phase: .checksFailing,
                kind: .pullRequest,
                destination: .pullRequest(
                    prId: "pr-1",
                    repoOwner: "arul",
                    repoName: "ade",
                    number: 992,
                    tab: "checks",
                    eventId: nil
                )
            )
        )

        XCTAssertTrue(row.isPullRequest)
        XCTAssertEqual(row.prNumber, 992)
        XCTAssertNil(row.sessionId)
    }

    func testModelAndLaneAreProjectedRatherThanDropped() {
        let row = ActivityRowPresentation(
            item: makeItem(phase: .running, laneName: "activity-revamp", model: "claude-fable-5")
        )

        XCTAssertEqual(row.laneName, "activity-revamp")
        XCTAssertEqual(row.modelLabel, "claude-fable-5")
        XCTAssertEqual(row.scopeLabel, "Studio Mac · ADE")
    }

    // MARK: - Fixture

    private func makeItem(
        id: String = "item-1",
        phase: AccountAttentionPhase,
        kind: AccountAttentionItemKind = .agent,
        activityTier: String? = nil,
        statusSince: Date? = nil,
        occurredAt: Date = Date(),
        machine: AccountAttentionMachine? = nil,
        laneName: String? = nil,
        model: String? = nil,
        preview: String = "Working",
        detail: String? = nil,
        privacyPreview: String = "Agent working",
        destination: AccountAttentionDestination? = nil
    ) -> AccountAttentionItem {
        AccountAttentionItem(
            id: id,
            revision: 1,
            fingerprint: "\(id):1",
            kind: kind,
            eventKind: .agentRunning,
            phase: phase,
            activityTier: activityTier,
            statusSince: statusSince,
            machine: machine ?? AccountAttentionMachine(
                machineKey: "studio",
                name: "Studio Mac",
                online: true,
                lastSeenAt: occurredAt
            ),
            project: AccountAttentionProject(projectId: "ade", name: "ADE"),
            laneName: laneName,
            provider: "claude",
            model: model,
            title: "Wire the drawer",
            preview: preview,
            privacyPreview: privacyPreview,
            detail: detail,
            destination: destination ?? .session(sessionId: "s-1", itemId: nil, eventId: nil),
            occurredAt: occurredAt,
            updatedAt: occurredAt
        )
    }
}
