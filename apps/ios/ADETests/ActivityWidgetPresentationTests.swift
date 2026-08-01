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

    // MARK: - Fixtures

    private func makeItem(
        id: String,
        phase: AccountAttentionPhase,
        sessionId: String,
        updatedAt: Date,
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
}
