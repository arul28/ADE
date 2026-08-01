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

    func testSnapshotCursorRejectsLateRevisionsWithinAStream() {
        var cursor = AttentionSnapshotCursor()
        XCTAssertEqual(
            cursor.accept(AttentionSnapshot(
                streamId: "account:user-a",
                revision: 12,
                generatedAt: "2026-07-28T12:00:12Z",
                items: []
            )),
            .accepted(resetPresentationState: false)
        )
        XCTAssertEqual(
            cursor.accept(AttentionSnapshot(
                streamId: "account:user-a",
                revision: 11,
                generatedAt: "2026-07-28T12:00:13Z",
                items: []
            )),
            .rejectedStale
        )
    }

    func testSnapshotCursorAcceptsAccountSwitchAndResetsPresentationState() {
        var cursor = AttentionSnapshotCursor()
        _ = cursor.accept(AttentionSnapshot(
            streamId: "account:user-a",
            revision: 99,
            generatedAt: "2026-07-28T12:00:00Z",
            items: []
        ))

        XCTAssertEqual(
            cursor.accept(AttentionSnapshot(
                streamId: "account:user-b",
                revision: 1,
                generatedAt: "2026-07-28T12:00:01Z",
                items: []
            )),
            .accepted(resetPresentationState: true)
        )
    }

    func testSnapshotCursorRejectsDelayedFrameFromPreviousAccount() {
        var cursor = AttentionSnapshotCursor()
        _ = cursor.accept(AttentionSnapshot(
            streamId: "account:user-a",
            revision: 99,
            generatedAt: "2026-07-28T12:00:00Z",
            items: []
        ))
        _ = cursor.accept(AttentionSnapshot(
            streamId: "account:user-b",
            revision: 1,
            generatedAt: "2026-07-28T12:00:02Z",
            items: []
        ))

        XCTAssertEqual(
            cursor.accept(AttentionSnapshot(
                streamId: "account:user-a",
                revision: 100,
                generatedAt: "2026-07-28T12:00:01Z",
                items: []
            )),
            .rejectedStale
        )
    }

    func testLegacySnapshotCursorUsesGeneratedTimeToRejectLateFrames() {
        var cursor = AttentionSnapshotCursor()
        _ = cursor.accept(AttentionSnapshot(
            revision: 4,
            generatedAt: "2026-07-28T12:00:04Z",
            items: []
        ))

        XCTAssertEqual(
            cursor.accept(AttentionSnapshot(
                revision: 8,
                generatedAt: "2026-07-28T12:00:03Z",
                items: []
            )),
            .rejectedStale
        )
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
        // Presentation defaults are the shipped surface, so enabling the notch
        // without ever touching the new controls behaves exactly as before.
        XCTAssertEqual(settings.revealMode, .hover)
        XCTAssertTrue(settings.expandedPanelEnabled)
    }

    /// A host built before the presentation controls existed sends neither key.
    /// It has to keep the behaviour it was built against, not lose the frame.
    func testSettingsFromAHostWithoutPresentationKeysKeepsShippedBehavior() throws {
        let legacy = """
        {"type":"settings","settings":{"enabled":true,"preferredDisplayId":null,
         "hideDetails":false,"celebrationsEnabled":true,"soundsEnabled":false}}
        """
        guard case .settings(let settings) = try NotchInputDecoder.decode(line: legacy) else {
            return XCTFail("expected settings")
        }
        XCTAssertTrue(settings.enabled)
        XCTAssertEqual(settings.revealMode, .hover)
        XCTAssertTrue(settings.expandedPanelEnabled)
        XCTAssertFalse(settings.hideDetails)
    }

    func testSettingsDecodeEveryRevealModeAndDegradeUnknownOnes() throws {
        for (raw, expected) in [
            ("minimal", NotchRevealMode.minimal),
            ("hover", .hover),
            ("click", .click),
            // A newer host may name a mode this build has never heard of.
            ("telepathy", .hover),
        ] {
            let line = """
            {"type":"settings","settings":{"enabled":true,"revealMode":"\(raw)",
             "expandedPanelEnabled":false,"hideDetails":true,
             "celebrationsEnabled":true,"soundsEnabled":false}}
            """
            guard case .settings(let settings) = try NotchInputDecoder.decode(line: line) else {
                return XCTFail("expected settings for \(raw)")
            }
            XCTAssertEqual(settings.revealMode, expected, "reveal mode \(raw)")
            XCTAssertFalse(settings.expandedPanelEnabled)
        }
    }

    func testSettingsRoundTripThroughTheWire() throws {
        let settings = NotchSettings(
            enabled: true,
            revealMode: .minimal,
            expandedPanelEnabled: false,
            preferredDisplayId: 7,
            hideDetails: false,
            celebrationsEnabled: false,
            soundsEnabled: true
        )
        let encoded = String(decoding: try JSONEncoder().encode(settings), as: UTF8.self)
        let line = """
        {"type":"settings","settings":\(encoded)}
        """
        XCTAssertEqual(try NotchInputDecoder.decode(line: line), .settings(settings))
    }

    func testContextMenuSettingsActionsPreserveUnrelatedChoices() {
        let original = NotchSettings(
            enabled: true,
            revealMode: .hover,
            expandedPanelEnabled: true,
            preferredDisplayId: 42,
            hideDetails: false,
            celebrationsEnabled: false,
            soundsEnabled: true
        )

        let clickOnly = applyingNotchSettingsMenuAction(
            .setRevealMode(.click),
            to: original
        )
        XCTAssertEqual(clickOnly.revealMode, .click)
        XCTAssertEqual(clickOnly.preferredDisplayId, 42)
        XCTAssertFalse(clickOnly.hideDetails)
        XCTAssertTrue(clickOnly.soundsEnabled)

        let compactPanel = applyingNotchSettingsMenuAction(
            .toggleExpandedPanel,
            to: clickOnly
        )
        XCTAssertFalse(compactPanel.expandedPanelEnabled)
        XCTAssertEqual(compactPanel.revealMode, .click)

        let hidden = applyingNotchSettingsMenuAction(.hide, to: compactPanel)
        XCTAssertFalse(hidden.enabled)
        XCTAssertFalse(hidden.expandedPanelEnabled)
        XCTAssertEqual(hidden.revealMode, .click)
    }

    func testHoverDormancyDoesNotDisableOrHideTheNotchSetting() {
        let hover = NotchSettings(enabled: true, revealMode: .hover)
        XCTAssertTrue(hover.enabled)
        XCTAssertTrue(notchSurfaceIsDormant(
            presentation: .compact,
            revealMode: hover.revealMode
        ))

        let hidden = applyingNotchSettingsMenuAction(.hide, to: hover)
        XCTAssertFalse(hidden.enabled)
        XCTAssertEqual(hidden.revealMode, .hover)
    }

    func testSettingsOutputCarriesTheWholeUpdatedSettingsFrame() throws {
        let settings = NotchSettings(
            enabled: false,
            revealMode: .minimal,
            expandedPanelEnabled: false,
            hideDetails: true
        )
        let output = NotchOutput(type: "settings", settings: settings)
        let encoded = try JSONEncoder().encode(output)
        let object = try XCTUnwrap(
            JSONSerialization.jsonObject(with: encoded) as? [String: Any]
        )
        let encodedSettings = try XCTUnwrap(object["settings"] as? [String: Any])

        XCTAssertEqual(object["type"] as? String, "settings")
        XCTAssertEqual(encodedSettings["enabled"] as? Bool, false)
        XCTAssertEqual(encodedSettings["revealMode"] as? String, "minimal")
        XCTAssertEqual(encodedSettings["expandedPanelEnabled"] as? Bool, false)
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

    // MARK: - Availability

    func testSnapshotDecodesAvailabilityAndSurvivesDriftedPayloads() throws {
        let withAvailability = """
        {"contractVersion":1,"revision":3,"generatedAt":"2026-07-28T12:00:00Z","items":[],
         "availability":{"state":"degraded","title":"Reconnecting","message":"Lost the account stream.",
         "recovery":"retry","hostName":"Studio"}}
        """
        guard case .snapshot(let snapshot) = try NotchInputDecoder.decode(line: withAvailability) else {
            return XCTFail("expected a snapshot")
        }
        XCTAssertEqual(snapshot.availability?.state, .degraded)
        XCTAssertEqual(snapshot.availability?.recovery, .retry)
        XCTAssertEqual(snapshot.availability?.hostName, "Studio")

        // A newer host may send codes this build has never heard of, and may
        // omit copy entirely. Neither may cost us the snapshot.
        let drifted = """
        {"contractVersion":1,"revision":4,"generatedAt":"2026-07-28T12:00:00Z","items":[],
         "availability":{"state":"quantum_flux","recovery":"reboot_universe"}}
        """
        guard case .snapshot(let driftedSnapshot) = try NotchInputDecoder.decode(line: drifted) else {
            return XCTFail("expected a snapshot")
        }
        XCTAssertEqual(driftedSnapshot.availability?.state, .unknown)
        XCTAssertEqual(driftedSnapshot.availability?.recovery, .unknown)
        XCTAssertEqual(driftedSnapshot.revision, 4)

        // Availability is advisory chrome; a malformed one must not blind the
        // surface to the items that came with it.
        let malformed = """
        {"contractVersion":1,"revision":5,"generatedAt":"2026-07-28T12:00:00Z","items":[],"availability":"broken"}
        """
        guard case .snapshot(let malformedSnapshot) = try NotchInputDecoder.decode(line: malformed) else {
            return XCTFail("expected a snapshot")
        }
        XCTAssertNil(malformedSnapshot.availability)
        XCTAssertEqual(malformedSnapshot.revision, 5)
    }

    /// Zero items is a state worth showing, not a reason to vanish.
    func testEmptyButHealthyStreamStillHasSomethingToSay() throws {
        let status = try XCTUnwrap(notchStatusPresentation(availability: nil, itemCount: 0))
        XCTAssertFalse(status.isProblem)
        XCTAssertEqual(status.title, "All clear")
        XCTAssertEqual(status.compactLabel, "All clear")
        XCTAssertEqual(status.tone, .emerald)

        // Nothing to report once items are flowing again.
        XCTAssertNil(notchStatusPresentation(availability: nil, itemCount: 2))
        XCTAssertNil(notchStatusPresentation(
            availability: AttentionAvailability(state: .ready, title: "Connected", message: "Live"),
            itemCount: 2
        ))
    }

    /// Host copy wins; the helper only fills in what the host left blank, and
    /// says so even while stale items are still on screen.
    func testUnhealthyStreamReportsHostCopyAndRecovery() throws {
        let hostAuthored = try XCTUnwrap(notchStatusPresentation(
            availability: AttentionAvailability(
                state: .signedOut,
                title: "Signed out",
                message: "Your ADE session expired.",
                recovery: .signIn
            ),
            itemCount: 0
        ))
        XCTAssertTrue(hostAuthored.isProblem)
        XCTAssertEqual(hostAuthored.title, "Signed out")
        XCTAssertEqual(hostAuthored.message, "Your ADE session expired.")
        XCTAssertEqual(hostAuthored.hint, "Sign in to ADE to restore account attention.")

        let blankCopy = try XCTUnwrap(notchStatusPresentation(
            availability: AttentionAvailability(state: .incompatible, recovery: .updateHost, hostName: "Studio"),
            itemCount: 0
        ))
        XCTAssertEqual(blankCopy.title, "ADE needs an update")
        XCTAssertEqual(blankCopy.hint, "Update ADE on Studio.")
        XCTAssertEqual(blankCopy.tone, .red)

        // Stale items stay visible, but the copy admits they may be stale.
        let stale = try XCTUnwrap(notchStatusPresentation(
            availability: AttentionAvailability(state: .degraded),
            itemCount: 3
        ))
        XCTAssertEqual(stale.message, "Showing the last state ADE received.")
        XCTAssertEqual(stale.compactLabel, "Reconnecting")
    }

    func testScopeSummaryPluralizesEveryCount() {
        XCTAssertEqual(
            attentionScopeSummary(itemCount: 3, projectCount: 2, machineCount: 1),
            "3 items · 2 projects · 1 machine"
        )
        XCTAssertEqual(
            attentionScopeSummary(itemCount: 1, projectCount: 1, machineCount: 0),
            "1 item · 1 project · 0 machines"
        )
    }

    /// The expanded footer renders a prominent "Open in ADE" of its own, so a
    /// plain `open` action beside it would be the same button twice.
    func testPlainOpenActionIsLeftToTheProminentButton() {
        let actions = [
            AttentionAction(id: "open", kind: "open", label: "Open"),
            AttentionAction(id: "approve", kind: "approve", label: "Approve"),
            AttentionAction(id: "dismiss", kind: "dismiss", label: "Dismiss"),
        ]
        // "open" renders as "Open in ADE", which the prominent button already
        // is; "dismiss" navigates nowhere.
        XCTAssertEqual(notchSecondaryActions(actions).map(\.id), ["approve"])
        XCTAssertEqual(AttentionAction(id: "open", kind: "open", label: "Open").navigationLabel, "Open in ADE")
    }

    // MARK: - Activity revamp protocol additions

    /// The elapsed anchor and the tier are additive. A publisher that has them
    /// is decoded exactly; one that does not still lands, and the surface falls
    /// back to `occurredAt` rather than to `updatedAt`, which churns on every
    /// cosmetic republish.
    func testItemDecodesStatusSinceAndTierAndDegradesWithoutThem() throws {
        let modern = """
        {"contractVersion":1,"revision":7,"generatedAt":"2026-08-01T12:00:00Z","items":[
         {"contractVersion":1,"id":"a","revision":1,"fingerprint":"f","kind":"agent",
          "eventKind":"agent_running","phase":"running",
          "machine":{"machineKey":"m","name":"Studio","online":true,"lastSeenAt":null},
          "project":{"projectId":"p","name":"ADE"},"title":"T","preview":"P",
          "privacyPreview":"Agent update",
          "destination":{"kind":"session","sessionId":"s"},"actions":[],
          "occurredAt":"2026-08-01T11:00:00Z","updatedAt":"2026-08-01T12:00:00Z",
          "statusSince":"2026-08-01T11:30:00Z","activityTier":"ambient",
          "seenAt":null,"dismissedAt":null,"expiresAt":null}]}
        """
        guard case .snapshot(let snapshot) = try NotchInputDecoder.decode(line: modern) else {
            return XCTFail("expected a snapshot")
        }
        let item = try XCTUnwrap(snapshot.items.first)
        XCTAssertEqual(item.statusSince, "2026-08-01T11:30:00Z")
        XCTAssertEqual(item.tier, "ambient")
        XCTAssertEqual(item.elapsedAnchor, "2026-08-01T11:30:00Z")
        XCTAssertFalse(item.isSignalTier)
        XCTAssertFalse(item.isIdleTier)

        let legacy = fixtureItem()
        XCTAssertNil(legacy.statusSince)
        XCTAssertNil(legacy.tier)
        XCTAssertEqual(legacy.elapsedAnchor, legacy.occurredAt)
        // Without a tier the surface falls back to the phase test it has always
        // used, so a mixed-version fleet still files rows consistently.
        XCTAssertEqual(fixtureItem(phase: "needs_you").isSignalTier, true)
        XCTAssertEqual(legacy.isSignalTier, false)

        // A tier this build has never heard of is not a signal and not idle.
        let drifted = fixtureItem(tier: "telepathic")
        XCTAssertFalse(drifted.isSignalTier)
        XCTAssertFalse(drifted.isIdleTier)
    }

    func testSnapshotDecodesCountsAndSurvivesWithoutThem() throws {
        let withCounts = """
        {"contractVersion":1,"revision":3,"generatedAt":"2026-08-01T12:00:00Z","items":[],
         "counts":{"needsYou":2,"working":5,"done":54,"total":61,
                   "machinesOnline":1,"machinesTotal":3}}
        """
        guard case .snapshot(let snapshot) = try NotchInputDecoder.decode(line: withCounts) else {
            return XCTFail("expected a snapshot")
        }
        let counts = try XCTUnwrap(snapshot.counts)
        XCTAssertEqual(counts.needsYou, 2)
        XCTAssertEqual(counts.working, 5)
        XCTAssertEqual(counts.done, 54)
        XCTAssertEqual(counts.total, 61)
        XCTAssertEqual(counts.machinesOnline, 1)
        XCTAssertEqual(counts.machinesTotal, 3)
        // 61 rows exist; this frame carried 48 of them.
        XCTAssertEqual(counts.overflow(shownItemCount: 48), 13)

        // Partial and malformed count blocks are advisory chrome like
        // availability: they may never cost us the items that came with them.
        let partial = """
        {"contractVersion":1,"revision":4,"generatedAt":"2026-08-01T12:00:00Z","items":[],
         "counts":{"needsYou":1,"unknownFuture":9}}
        """
        guard case .snapshot(let partialSnapshot) = try NotchInputDecoder.decode(line: partial) else {
            return XCTFail("expected a snapshot")
        }
        XCTAssertEqual(partialSnapshot.counts?.needsYou, 1)
        XCTAssertEqual(partialSnapshot.counts?.working, 0)

        let malformed = """
        {"contractVersion":1,"revision":5,"generatedAt":"2026-08-01T12:00:00Z","items":[],"counts":"broken"}
        """
        guard case .snapshot(let malformedSnapshot) = try NotchInputDecoder.decode(line: malformed) else {
            return XCTFail("expected a snapshot")
        }
        XCTAssertNil(malformedSnapshot.counts)
        XCTAssertEqual(malformedSnapshot.revision, 5)
    }

    /// A bare snapshot with none of the new keys is still the whole legacy
    /// contract — this is the regression guard for hosts mid-rollout.
    func testBareLegacySnapshotStillDecodes() throws {
        let bare = """
        {"contractVersion":1,"revision":1,"generatedAt":"2026-08-01T12:00:00Z","items":[]}
        """
        guard case .snapshot(let snapshot) = try NotchInputDecoder.decode(line: bare) else {
            return XCTFail("expected a snapshot")
        }
        XCTAssertNil(snapshot.counts)
        XCTAssertNil(snapshot.availability)
        XCTAssertNil(snapshot.streamId)
        XCTAssertTrue(snapshot.items.isEmpty)
        XCTAssertEqual(snapshot.resolvedCounts(), AttentionCounts())
    }

    func testToastCommandDecodesEveryTreatment() throws {
        for (raw, expected) in [
            ("celebration", NotchToastTreatment.celebration),
            ("success", .success),
            ("alert", .alert),
            ("info", .info),
        ] {
            let line = """
            {"type":"toast","toast":{"itemId":"pr-1","eventKind":"pr_merged",
             "treatment":"\(raw)","title":"Merged #42","subtitle":"ade/desktop",
             "tone":"emerald","durationMs":2000}}
            """
            guard case .toast(let toast) = try NotchInputDecoder.decode(line: line) else {
                return XCTFail("expected a toast for \(raw)")
            }
            XCTAssertEqual(toast.treatment, expected)
            XCTAssertEqual(toast.itemId, "pr-1")
            XCTAssertEqual(toast.title, "Merged #42")
            XCTAssertEqual(toast.subtitle, "ade/desktop")
            XCTAssertEqual(toast.resolvedTone, .emerald)
            XCTAssertEqual(toast.resolvedDurationMs, 2_000)
            // Only a merge earns the confetti.
            XCTAssertEqual(
                toast.treatment.presentation,
                expected == .celebration ? .celebration : .attention
            )
        }
    }

    /// A treatment this build has never heard of reads as ordinary news. It may
    /// not throw: a decode failure is reported to the host as a protocol error
    /// and latches the helper into "needs an update" for the rest of its life.
    func testUnknownToastTreatmentDegradesToInfoInsteadOfFailing() throws {
        let line = """
        {"type":"toast","toast":{"eventKind":"agent_needs_you","treatment":"telepathy",
         "title":"Needs you"}}
        """
        guard case .toast(let toast) = try NotchInputDecoder.decode(line: line) else {
            return XCTFail("expected a toast")
        }
        XCTAssertEqual(toast.treatment, .info)
        XCTAssertEqual(toast.treatment.presentation, .attention)
        XCTAssertNil(toast.itemId)
        XCTAssertEqual(toast.resolvedTone, .blue)
        XCTAssertEqual(toast.resolvedDurationMs, 5_000)
    }

    /// A drifted host may not pin the surface open, or flash it so briefly that
    /// it reads as a glitch.
    func testToastDurationIsClampedToASaneWindow() {
        XCTAssertEqual(toastFixture(durationMs: 0).resolvedDurationMs, 800)
        XCTAssertEqual(toastFixture(durationMs: -5_000).resolvedDurationMs, 800)
        XCTAssertEqual(toastFixture(durationMs: 600_000).resolvedDurationMs, 15_000)
        XCTAssertEqual(toastFixture(durationMs: 3_000).resolvedDurationMs, 3_000)
        XCTAssertEqual(toastFixture(durationMs: nil).resolvedDurationMs, 5_000)
    }

    func testToastCommandWithoutAPayloadIsRejected() {
        XCTAssertThrowsError(try NotchInputDecoder.decode(line: #"{"type":"toast"}"#)) { error in
            XCTAssertEqual(error as? NotchProtocolError, .missingPayload("toast"))
        }
    }

    func testAutomaticRevealAndTickerDefaultOnAndRoundTrip() throws {
        let defaults = NotchSettings()
        XCTAssertTrue(defaults.automaticRevealEnabled)
        XCTAssertTrue(defaults.tickerEnabled)

        // A host built before these keys keeps the shipped behaviour.
        let legacy = """
        {"type":"settings","settings":{"enabled":true,"revealMode":"hover",
         "expandedPanelEnabled":true,"hideDetails":false,
         "celebrationsEnabled":true,"soundsEnabled":false}}
        """
        guard case .settings(let inherited) = try NotchInputDecoder.decode(line: legacy) else {
            return XCTFail("expected settings")
        }
        XCTAssertTrue(inherited.automaticRevealEnabled)
        XCTAssertTrue(inherited.tickerEnabled)

        let off = """
        {"type":"settings","settings":{"enabled":true,"revealMode":"minimal",
         "expandedPanelEnabled":true,"hideDetails":false,"celebrationsEnabled":true,
         "soundsEnabled":false,"automaticRevealEnabled":false,"tickerEnabled":false}}
        """
        guard case .settings(let explicit) = try NotchInputDecoder.decode(line: off) else {
            return XCTFail("expected settings")
        }
        XCTAssertFalse(explicit.automaticRevealEnabled)
        XCTAssertFalse(explicit.tickerEnabled)

        // Both survive the round trip back to the host through the settings
        // output, which is how the context menu's checkmarks are persisted.
        let encoded = try JSONEncoder().encode(NotchOutput(type: "settings", settings: explicit))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let settings = try XCTUnwrap(object["settings"] as? [String: Any])
        XCTAssertEqual(settings["automaticRevealEnabled"] as? Bool, false)
        XCTAssertEqual(settings["tickerEnabled"] as? Bool, false)
    }

    func testContextMenuTogglesForAutomaticRevealAndTickerPreserveEverythingElse() {
        let original = NotchSettings(
            enabled: true,
            revealMode: .minimal,
            expandedPanelEnabled: false,
            preferredDisplayId: 42,
            hideDetails: false,
            celebrationsEnabled: false,
            soundsEnabled: true
        )

        let noReveal = applyingNotchSettingsMenuAction(.toggleAutomaticReveal, to: original)
        XCTAssertFalse(noReveal.automaticRevealEnabled)
        XCTAssertTrue(noReveal.tickerEnabled)
        XCTAssertEqual(noReveal.revealMode, .minimal)
        XCTAssertEqual(noReveal.preferredDisplayId, 42)
        XCTAssertTrue(noReveal.soundsEnabled)

        let noTicker = applyingNotchSettingsMenuAction(.toggleTicker, to: noReveal)
        XCTAssertFalse(noTicker.tickerEnabled)
        XCTAssertFalse(noTicker.automaticRevealEnabled)
        XCTAssertFalse(noTicker.hideDetails)
    }

    private func toastFixture(durationMs: Int?) -> AttentionToast {
        AttentionToast(
            eventKind: "agent_needs_you",
            treatment: .alert,
            title: "Needs you",
            durationMs: durationMs
        )
    }

    private func fixtureItem(
        id: String = "agent-1",
        phase: String = "running",
        updatedAt: String = "2026-07-28T12:00:00Z",
        tier: String? = nil
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
            updatedAt: updatedAt,
            activityTier: tier
        )
    }
}
