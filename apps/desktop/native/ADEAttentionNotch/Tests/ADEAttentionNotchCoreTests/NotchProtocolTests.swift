import XCTest
@testable import ADEAttentionNotchCore

final class NotchProtocolTests: XCTestCase {
    func testDecodesRawSnapshotAndEnvelope() throws {
        let item = fixtureItem()
        let snapshot = AttentionSnapshot(
            revision: 2,
            generatedAt: "2026-07-28T12:00:00Z",
            items: [item]
        )
        let encoder = JSONEncoder()
        let raw = String(decoding: try encoder.encode(snapshot), as: UTF8.self)
        XCTAssertEqual(try NotchInputDecoder.decode(line: raw), .snapshot(snapshot))

        let envelope = """
        {"type":"snapshot","snapshot":\(raw)}
        """
        XCTAssertEqual(try NotchInputDecoder.decode(line: envelope), .snapshot(snapshot))
    }

    func testDestinationBuildsExactDeepLink() {
        let destination = AttentionDestination(
            kind: "pull_request",
            repoOwner: "ade",
            repoName: "desktop",
            number: 42,
            tab: "checks"
        )
        XCTAssertEqual(destination.deepLink, "ade://pr/ade/desktop/42?tab=checks")
    }

    func testAttentionSortingIsPriorityThenRecency() {
        let running = fixtureItem(id: "running", phase: "running", updatedAt: "2026-07-28T12:10:00Z")
        let failed = fixtureItem(id: "failed", phase: "failed", updatedAt: "2026-07-28T12:00:00Z")
        let needsYou = fixtureItem(id: "needs", phase: "needs_you", updatedAt: "2026-07-28T11:00:00Z")
        XCTAssertEqual(sortedAttentionItems([running, failed, needsYou]).map(\.id), ["needs", "failed", "running"])
    }

    func testDateParserAcceptsFractionalAndWholeSeconds() {
        XCTAssertNotNil(parseAttentionDate("2026-07-28T12:00:00.123Z"))
        XCTAssertNotNil(parseAttentionDate("2026-07-28T12:00:00Z"))
    }

    func testFreshElapsedTimeReadsNow() throws {
        let now = try XCTUnwrap(parseAttentionDate("2026-07-28T12:00:03Z"))
        XCTAssertEqual(
            attentionElapsedLabel(since: "2026-07-28T12:00:00.000Z", now: now),
            "now"
        )
    }

    func testNativeSettingsFailClosedWithPrivateSilentDefaults() {
        let settings = NotchSettings()
        XCTAssertFalse(settings.enabled)
        XCTAssertTrue(settings.hideDetails)
        XCTAssertFalse(settings.soundsEnabled)
    }

    func testPrivacyPresentationRedactsEverySensitiveSurfaceAndAccessibilitySummary() {
        let item = AttentionItem(
            id: "private-agent",
            fingerprint: "private-fingerprint",
            kind: "agent",
            eventKind: "agent_running",
            phase: "running",
            machine: AttentionMachine(
                machineKey: "secret-machine-key",
                name: "Arul’s Mac Studio",
                online: true,
                lastSeenAt: nil
            ),
            project: AttentionProject(
                projectId: "secret-project-id",
                name: "Stealth Project",
                rootPath: "/Users/arul/Stealth"
            ),
            laneId: "secret-lane",
            laneName: "launch-secret-feature",
            provider: "codex",
            model: "secret-model",
            title: "Implement unreleased billing",
            preview: "Editing SecretBilling.swift",
            privacyPreview: "Agent is working",
            detail: "Customer Alpha requires a private migration",
            recentActivity: ["Read SecretBilling.swift", "Changed CustomerAlpha.swift"],
            planProgress: AttentionPlanProgress(
                completed: 2,
                total: 4,
                current: "Migrate Customer Alpha"
            ),
            destination: AttentionDestination(kind: "session", sessionId: "session-private"),
            occurredAt: "2026-07-28T12:00:00Z",
            updatedAt: "2026-07-28T12:00:00Z"
        )

        let presentation = item.presentation(hideDetails: true)

        XCTAssertEqual(presentation.title, "Agent update")
        XCTAssertEqual(presentation.preview, "Agent is working")
        XCTAssertEqual(presentation.compactIdentity, "ADE")
        XCTAssertEqual(presentation.scopeLabel, "Private details hidden")
        XCTAssertTrue(presentation.recentActivity.isEmpty)
        XCTAssertNil(presentation.planProgress)
        XCTAssertEqual(presentation.celebrationTitle, "Agent update")
        for secret in [
            "Implement unreleased billing",
            "Arul’s Mac Studio",
            "Stealth Project",
            "launch-secret-feature",
            "SecretBilling.swift",
            "Customer Alpha",
        ] {
            XCTAssertFalse(presentation.accessibilitySummary.contains(secret))
        }
    }

    func testInlineActionLabelsDescribeNavigationInsteadOfExecution() {
        let approve = AttentionAction(id: "approve", kind: "approve", label: "Approve")
        let deny = AttentionAction(id: "deny", kind: "deny", label: "Deny")
        let rerun = AttentionAction(id: "rerun", kind: "rerun_checks", label: "Rerun")
        let dismiss = AttentionAction(id: "dismiss", kind: "dismiss", label: "Dismiss")

        XCTAssertEqual(approve.navigationLabel, "Open to approve")
        XCTAssertEqual(deny.navigationLabel, "Open to deny")
        XCTAssertEqual(rerun.navigationLabel, "Open to rerun checks")
        XCTAssertTrue(approve.navigationAccessibilityHint.contains("Open to approve"))
        XCTAssertTrue(approve.opensDestination)
        XCTAssertFalse(dismiss.opensDestination)
    }

    func testPhaseVocabularyAndToneMatchAttentionSurfaces() {
        let running = fixtureItem(id: "running", phase: "running")
        let mergeReady = fixtureItem(id: "merge-ready", phase: "merge_ready")

        XCTAssertEqual(running.statusLabel, "Working")
        XCTAssertEqual(notchStatusTone(for: "starting"), .blue)
        XCTAssertEqual(notchStatusTone(for: "running"), .blue)
        XCTAssertEqual(notchStatusTone(for: "changes_requested"), .red)
        XCTAssertTrue(mergeReady.isAttention)
        XCTAssertEqual(mergeReady.statusLabel, "Ready to merge")
    }

    private func fixtureItem(
        id: String = "agent-1",
        phase: String = "running",
        updatedAt: String = "2026-07-28T12:00:00Z"
    ) -> AttentionItem {
        AttentionItem(
            id: id,
            fingerprint: "fingerprint-\(id)",
            kind: "agent",
            eventKind: "agent_running",
            phase: phase,
            machine: AttentionMachine(machineKey: "mac-1", name: "Studio", online: true, lastSeenAt: nil),
            project: AttentionProject(projectId: "ade", name: "ADE"),
            title: "Implement attention",
            preview: "Running tests",
            privacyPreview: "Agent update",
            destination: AttentionDestination(kind: "session", sessionId: "session-1"),
            occurredAt: updatedAt,
            updatedAt: updatedAt
        )
    }
}
