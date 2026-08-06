import XCTest
@testable import ADE

/// The lock-screen widget's two decisions, as pure functions: which rows the
/// rectangular family lists, and where a tap goes.
///
/// The deep link is the one that mattered — the widget used to follow whatever
/// sorted first, which on a busy account is usually PR traffic, so the single
/// glance-and-tap surface could not reliably reach the session blocked on you.
final class ActivityWidgetPresentationTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_780_000_000)

    // MARK: - Deep link ranking

    func testDeepLinkPrefersTheTopNeedsYouRow() {
        let url = ActivityWidgetPresentation.deepLink(
            for: [
                makeItem(id: "pr", phase: .checksFailing, sessionId: "pr-session", updatedAt: now),
                makeItem(id: "live", phase: .running, sessionId: "live-session", updatedAt: now),
                makeItem(id: "asked", phase: .needsYou, sessionId: "asked-session", updatedAt: now.addingTimeInterval(-600)),
            ],
            now: now
        )

        XCTAssertEqual(url.absoluteString.contains("asked-session"), true)
    }

    func testDeepLinkFallsBackToTheTopLiveRow() {
        let url = ActivityWidgetPresentation.deepLink(
            for: [
                makeItem(id: "done", phase: .completed, sessionId: "done-session", updatedAt: now),
                makeItem(id: "older-live", phase: .running, sessionId: "older-session", updatedAt: now.addingTimeInterval(-900)),
                makeItem(id: "live", phase: .running, sessionId: "live-session", updatedAt: now),
            ],
            now: now
        )

        XCTAssertEqual(url.absoluteString.contains("live-session"), true)
    }

    func testDeepLinkFallsBackToActivityWhenNothingIsActionable() {
        let url = ActivityWidgetPresentation.deepLink(
            for: [makeItem(id: "done", phase: .completed, sessionId: "done-session", updatedAt: now)],
            now: now
        )

        XCTAssertEqual(url, ActivityWidgetPresentation.activityURL)
    }

    func testDeepLinkIgnoresDismissedAndExpiredRows() {
        let url = ActivityWidgetPresentation.deepLink(
            for: [
                makeItem(
                    id: "dismissed",
                    phase: .needsYou,
                    sessionId: "dismissed-session",
                    updatedAt: now,
                    dismissedAt: now
                ),
                makeItem(
                    id: "expired",
                    phase: .needsYou,
                    sessionId: "expired-session",
                    updatedAt: now,
                    expiresAt: now.addingTimeInterval(-1)
                ),
            ],
            now: now
        )

        XCTAssertEqual(url, ActivityWidgetPresentation.activityURL)
    }

    // MARK: - Compact lines

    func testCompactLinesTakeTheTopTwoInBandOrder() {
        let lines = ActivityWidgetPresentation.compactLines(
            for: [
                makeItem(id: "done", phase: .completed, sessionId: "s-done", updatedAt: now),
                makeItem(id: "live", phase: .running, sessionId: "s-live", updatedAt: now),
                makeItem(id: "asked", phase: .needsYou, sessionId: "s-asked", updatedAt: now.addingTimeInterval(-600)),
            ],
            now: now
        )

        XCTAssertEqual(lines.map(\.id), ["asked", "live"])
        XCTAssertEqual(lines.map(\.phaseLabel), ["Needs you", "Working"])
        XCTAssertEqual(lines.map(\.tone), [.amber, .blue])
    }

    func testOverflowCountsTheRowsTheLinesLeftOff() {
        let items = (0..<5).map { index in
            makeItem(id: "item-\(index)", phase: .running, sessionId: "s-\(index)", updatedAt: now)
        }

        XCTAssertEqual(ActivityWidgetPresentation.overflowCount(for: items, now: now), 3)
        XCTAssertEqual(ActivityWidgetPresentation.overflowCount(for: Array(items.prefix(2)), now: now), 0)
    }

    /// A lock screen is readable by anyone holding the phone, which is the whole
    /// point of the setting — the title has to be the publisher's redacted one.
    func testHideDetailsSwapsInThePrivacyPreview() {
        let lines = ActivityWidgetPresentation.compactLines(
            for: [makeItem(id: "asked", phase: .needsYou, sessionId: "s-asked", updatedAt: now)],
            hideDetails: true,
            now: now
        )

        XCTAssertEqual(lines.first?.title, "Agent needs you")
    }

    func testRankingIsStableForRowsThatTieOnEveryKey() {
        let first = makeItem(id: "b", phase: .running, sessionId: "s-b", updatedAt: now)
        let second = makeItem(id: "a", phase: .running, sessionId: "s-a", updatedAt: now)

        XCTAssertEqual(ActivityWidgetPresentation.ranked([first, second]).map(\.id), ["a", "b"])
        XCTAssertEqual(ActivityWidgetPresentation.ranked([second, first]).map(\.id), ["a", "b"])
    }

    // MARK: - Per-row deep links (#20)

    /// Every rendered row carries its own destination, so a tap lands on the
    /// chat the reader actually pointed at rather than on whatever the widget
    /// as a whole decided was most important.
    func testEveryRowCarriesItsOwnDeepLink() {
        let lines = ActivityWidgetPresentation.compactLines(
            for: [
                makeItem(id: "asked", phase: .needsYou, sessionId: "s-asked", updatedAt: now),
                makeItem(id: "live", phase: .running, sessionId: "s-live", updatedAt: now),
            ],
            limit: 3,
            now: now
        )

        XCTAssertEqual(
            lines.map { $0.url?.absoluteString },
            ["ade://session/s-asked", "ade://session/s-live"]
        )
        XCTAssertEqual(lines.map(\.scope), ["Studio Mac · ADE", "Studio Mac · ADE"])
    }

    /// A lock screen is readable by anyone holding the phone — the scope line
    /// names a machine and a project, so it goes with the title.
    func testHideDetailsAlsoDropsTheScopeLine() {
        let lines = ActivityWidgetPresentation.compactLines(
            for: [makeItem(id: "asked", phase: .needsYou, sessionId: "s-asked", updatedAt: now)],
            hideDetails: true,
            now: now
        )

        XCTAssertNil(lines.first?.scope)
    }

    // MARK: - Agents / events split (#11, #21)

    /// Rows are agents only. A PR mixed into the roster is how "3 agents" came
    /// to mean "1 agent and 2 pull requests".
    func testRowsAndOverflowCountAgentsOnly() {
        let items = [
            makeItem(id: "live", phase: .running, sessionId: "s-live", updatedAt: now),
            makeItem(id: "asked", phase: .needsYou, sessionId: "s-asked", updatedAt: now),
            makeItem(id: "done", phase: .completed, sessionId: "s-done", updatedAt: now),
            makePrItem(id: "pr-1", number: 1038, phase: .checksFailing, updatedAt: now),
            makePrItem(id: "pr-2", number: 1039, phase: .reviewRequested, updatedAt: now),
        ]

        let lines = ActivityWidgetPresentation.compactLines(for: items, limit: 2, now: now)
        XCTAssertEqual(lines.map(\.id), ["asked", "live"])
        XCTAssertEqual(
            ActivityWidgetPresentation.overflowCount(for: items, limit: 2, now: now),
            1,
            "only the third agent is 'more' — the two PRs are the signal line"
        )
    }

    /// A kind this build has never heard of is far likelier to be a new agent
    /// shape than a new flavour of pull request, and silently dropping it is
    /// the one failure mode a status surface must not have.
    func testUnknownItemKindsAreTreatedAsAgentWork() {
        let items = [makeItem(id: "x", phase: .running, sessionId: "s-x", updatedAt: now, kind: .unrecognized("workflow"))]

        XCTAssertEqual(ActivityWidgetPresentation.compactLines(for: items, now: now).map(\.id), ["x"])
        XCTAssertNil(ActivityWidgetPresentation.eventSignal(for: items, now: now))
    }

    func testEventSignalCompressesPrTrafficIntoOneLine() {
        let signal = ActivityWidgetPresentation.eventSignal(
            for: [
                makeItem(id: "live", phase: .running, sessionId: "s-live", updatedAt: now),
                makePrItem(id: "pr-open", number: 1000, phase: .open, updatedAt: now),
                makePrItem(id: "pr-fail", number: 1038, phase: .checksFailing, updatedAt: now),
            ],
            now: now
        )

        XCTAssertEqual(signal?.id, "pr-fail", "the loudest event leads")
        XCTAssertEqual(signal?.label, "#1038 checks failing")
        XCTAssertEqual(signal?.tone, .red)
        XCTAssertEqual(signal?.moreCount, 1)
        XCTAssertEqual(signal?.url?.absoluteString, "ade://pr/arul/ade/1038?tab=checks")
    }

    func testEventSignalRedactsTheNumberWhenDetailsAreHidden() {
        let signal = ActivityWidgetPresentation.eventSignal(
            for: [makePrItem(id: "pr-fail", number: 1038, phase: .checksFailing, updatedAt: now)],
            hideDetails: true,
            now: now
        )

        XCTAssertEqual(signal?.label, "Checks failing")
    }

    func testEventSignalIsAbsentWithoutEvents() {
        XCTAssertNil(
            ActivityWidgetPresentation.eventSignal(
                for: [makeItem(id: "live", phase: .running, sessionId: "s-live", updatedAt: now)],
                now: now
            )
        )
    }

    // MARK: - State groups

    func testGroupCountsTallyAgentsByStateInDisplayOrder() {
        let groups = ActivityWidgetPresentation.groupCounts(
            for: [
                makeItem(id: "done", phase: .completed, sessionId: "s1", updatedAt: now),
                makeItem(id: "live-1", phase: .running, sessionId: "s2", updatedAt: now),
                makeItem(id: "live-2", phase: .starting, sessionId: "s3", updatedAt: now),
                makeItem(id: "asked", phase: .needsYou, sessionId: "s4", updatedAt: now),
                makeItem(id: "broke", phase: .failed, sessionId: "s5", updatedAt: now),
                // Planning is carried on `chatActivityMode`, not on a phase —
                // the wire phase vocabulary has no `planning` member and no
                // publisher emits one.
                makeItem(
                    id: "plan",
                    phase: .running,
                    sessionId: "s6",
                    updatedAt: now,
                    chatActivityMode: .planning
                ),
                // Events never enter the agent tally.
                makePrItem(id: "pr", number: 7, phase: .checksFailing, updatedAt: now),
            ],
            now: now
        )

        XCTAssertEqual(groups.map(\.group), [.needsYou, .failed, .planning, .working, .done])
        XCTAssertEqual(groups.map(\.count), [1, 1, 1, 2, 1])
    }

    func testGroupCountsSkipDismissedAndExpiredRows() {
        let groups = ActivityWidgetPresentation.groupCounts(
            for: [
                makeItem(id: "gone", phase: .needsYou, sessionId: "s1", updatedAt: now, dismissedAt: now),
                makeItem(id: "old", phase: .needsYou, sessionId: "s2", updatedAt: now, expiresAt: now.addingTimeInterval(-1)),
                makeItem(id: "live", phase: .running, sessionId: "s3", updatedAt: now),
            ],
            now: now
        )

        XCTAssertEqual(groups.map(\.group), [.working])
    }

    // MARK: - Freshness (#22)

    /// The widget renders a cached snapshot. Stating hours-old counts as
    /// current is worse than stating fewer facts, so past the thresholds it
    /// says how far behind it is.
    func testFreshnessCrossesFromFreshToAgingToUntrusted() {
        func confidence(_ secondsAgo: TimeInterval) -> ActivityWidgetPresentation.Confidence {
            ActivityWidgetPresentation.freshness(
                generatedAt: now.addingTimeInterval(-secondsAgo),
                now: now
            ).confidence
        }

        XCTAssertEqual(confidence(0), .fresh)
        XCTAssertEqual(confidence(ActivityWidgetPresentation.agingThreshold - 1), .fresh)
        XCTAssertEqual(confidence(ActivityWidgetPresentation.agingThreshold), .aging)
        XCTAssertEqual(confidence(ActivityWidgetPresentation.untrustedThreshold - 1), .aging)
        XCTAssertEqual(confidence(ActivityWidgetPresentation.untrustedThreshold), .untrusted)
    }

    func testFreshLabelsAreSilentAndStaleOnesAreNot() {
        XCTAssertNil(
            ActivityWidgetPresentation.freshness(generatedAt: now, now: now).label,
            "a timestamp on a current reading is noise"
        )
        XCTAssertEqual(
            ActivityWidgetPresentation.freshness(
                generatedAt: now.addingTimeInterval(-14 * 60),
                now: now
            ).label,
            "Updated 14m ago"
        )
        XCTAssertEqual(
            ActivityWidgetPresentation.freshness(
                generatedAt: now.addingTimeInterval(-3 * 3600),
                now: now
            ).label,
            "Last synced 3h ago"
        )
    }

    /// `generatedAt` is a relay clock and `fetchedAt` is this device's. The
    /// stronger honest claim is whichever is newer — a skewed relay clock must
    /// not read as fresher than the fetch that actually happened, and a fetch
    /// that returned an old snapshot must not read as fresh either.
    func testFreshnessAnchorsOnWhicheverTimestampIsNewer() {
        let old = now.addingTimeInterval(-3 * 3600)

        XCTAssertEqual(
            ActivityWidgetPresentation.freshness(generatedAt: old, fetchedAt: now, now: now).confidence,
            .fresh
        )
        XCTAssertEqual(
            ActivityWidgetPresentation.freshness(generatedAt: now, fetchedAt: old, now: now).confidence,
            .fresh
        )
        XCTAssertEqual(
            ActivityWidgetPresentation.freshness(generatedAt: old, fetchedAt: old, now: now).confidence,
            .untrusted
        )
    }

    /// A clock that has run backwards must not report a negative age.
    func testFutureTimestampsClampToFresh() {
        let freshness = ActivityWidgetPresentation.freshness(
            generatedAt: now.addingTimeInterval(600),
            now: now
        )

        XCTAssertEqual(freshness.age, 0)
        XCTAssertEqual(freshness.confidence, .fresh)
        XCTAssertFalse(freshness.isStale)
    }

    // MARK: - Live Activity content state (#23)

    func testContentStateDecodesOptionalGroupTallies() throws {
        let json = Data("""
        {
          "updatedAt": 1720000000,
          "activeCount": 9,
          "runs": [],
          "groups": [
            { "group": "working", "count": 5 },
            { "group": "needs_you", "count": 2 },
            { "group": "teleporting", "count": 4 },
            { "group": "done", "count": 0 }
          ],
          "moreCount": 6
        }
        """.utf8)

        let state = try JSONDecoder().decode(ADEAgentRunsAttributes.ContentState.self, from: json)
        let groups = try XCTUnwrap(state.resolvedGroups)

        XCTAssertEqual(groups.map(\.group), [.needsYou, .working], "unknown and zero buckets drop out")
        XCTAssertEqual(groups.map(\.count), [2, 5])
        XCTAssertEqual(state.moreCount, 6)
    }

    /// Absence has to stay absence: a payload with no tally must not decode to
    /// an empty one, or the island renders a confident "0" over a roster that
    /// plainly has rows.
    func testContentStateWithoutGroupsResolvesToNilNotZero() throws {
        let json = Data("""
        { "updatedAt": 1720000000, "activeCount": 2, "runs": [], "groups": [] }
        """.utf8)

        let state = try JSONDecoder().decode(ADEAgentRunsAttributes.ContentState.self, from: json)

        XCTAssertNil(state.groups)
        XCTAssertNil(state.resolvedGroups)
        XCTAssertNil(state.moreCount)
    }

    // MARK: - Fixtures

    private func makeItem(
        id: String,
        phase: AccountAttentionPhase,
        sessionId: String,
        updatedAt: Date,
        dismissedAt: Date? = nil,
        expiresAt: Date? = nil,
        chatActivityMode: AccountChatActivityMode? = nil,
        kind: AccountAttentionItemKind = .agent
    ) -> AccountAttentionItem {
        AccountAttentionItem(
            id: id,
            revision: 1,
            fingerprint: "\(id):1",
            kind: kind,
            eventKind: .agentRunning,
            phase: phase,
            chatActivityMode: chatActivityMode,
            machine: AccountAttentionMachine(
                machineKey: "studio",
                name: "Studio Mac",
                online: true,
                lastSeenAt: updatedAt
            ),
            project: AccountAttentionProject(projectId: "ade", name: "ADE"),
            provider: "claude",
            title: "Wire the widget",
            preview: "Working",
            privacyPreview: "Agent needs you",
            destination: .session(sessionId: sessionId, itemId: nil, eventId: nil),
            occurredAt: updatedAt,
            updatedAt: updatedAt,
            dismissedAt: dismissedAt,
            expiresAt: expiresAt
        )
    }

    private func makePrItem(
        id: String,
        number: Int,
        phase: AccountAttentionPhase,
        updatedAt: Date
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
                lastSeenAt: updatedAt
            ),
            project: AccountAttentionProject(projectId: "ade", name: "ADE"),
            title: "Widget freshness",
            preview: "",
            privacyPreview: "Pull request update",
            destination: .pullRequest(
                prId: id,
                repoOwner: "arul",
                repoName: "ade",
                number: number,
                tab: "checks",
                eventId: nil
            ),
            occurredAt: updatedAt,
            updatedAt: updatedAt
        )
    }
}
