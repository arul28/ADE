import XCTest
@testable import ADEAttentionNotchCore
@testable import ADEAttentionNotch

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

    /// Two live values, and every retired one lands on the mode that keeps a
    /// strip on screen — an upgrade may not silently hide a surface the user
    /// had pinned.
    func testSettingsDecodeBothRevealModesAndNormalizeRetiredOnes() throws {
        for (raw, expected) in [
            ("always", NotchRevealMode.always),
            ("hover", .hover),
            ("minimal", .always),
            ("click", .always),
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
        XCTAssertEqual(NotchRevealMode.allCases, [.always, .hover])
    }

    func testSettingsRoundTripThroughTheWire() throws {
        let settings = NotchSettings(
            enabled: true,
            revealMode: .always,
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

        let pinned = applyingNotchSettingsMenuAction(.setRevealMode(.always), to: original)
        XCTAssertEqual(pinned.revealMode, .always)
        XCTAssertEqual(pinned.preferredDisplayId, 42)
        XCTAssertFalse(pinned.hideDetails)
        XCTAssertTrue(pinned.soundsEnabled)
        // Choosing a mode may never turn the surface off or resize the panel.
        XCTAssertTrue(pinned.enabled)
        XCTAssertTrue(pinned.expandedPanelEnabled)

        let privateMode = applyingNotchSettingsMenuAction(.toggleHideDetails, to: pinned)
        XCTAssertTrue(privateMode.hideDetails)
        XCTAssertEqual(privateMode.revealMode, .always)

        let celebrating = applyingNotchSettingsMenuAction(.toggleCelebrations, to: privateMode)
        XCTAssertTrue(celebrating.celebrationsEnabled)
        XCTAssertTrue(celebrating.hideDetails)

        let hidden = applyingNotchSettingsMenuAction(.hide, to: celebrating)
        XCTAssertFalse(hidden.enabled)
        XCTAssertEqual(hidden.revealMode, .always)
        XCTAssertTrue(hidden.celebrationsEnabled)
    }

    func testHoverDormancyDoesNotDisableOrHideTheNotchSetting() {
        let hover = NotchSettings(enabled: true, revealMode: .hover)
        XCTAssertTrue(hover.enabled)
        XCTAssertTrue(notchSurfaceIsDormant(
            presentation: .compact,
            revealMode: hover.revealMode,
            pointerInside: false
        ))
        // Under the pointer it is the identical strip the pinned mode draws.
        XCTAssertFalse(notchSurfaceIsDormant(
            presentation: .compact,
            revealMode: hover.revealMode,
            pointerInside: true
        ))

        let hidden = applyingNotchSettingsMenuAction(.hide, to: hover)
        XCTAssertFalse(hidden.enabled)
        XCTAssertEqual(hidden.revealMode, .hover)
    }

    func testSettingsOutputCarriesTheWholeUpdatedSettingsFrame() throws {
        let settings = NotchSettings(
            enabled: false,
            revealMode: .always,
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
        XCTAssertEqual(encodedSettings["revealMode"] as? String, "always")
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
        XCTAssertEqual(status.message, "Nothing needs you.")
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
        XCTAssertEqual(hostAuthored.hint, "Sign in to ADE to restore account Activity.")

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
                expected == .celebration ? .celebration : .flash
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
        XCTAssertEqual(toast.treatment.presentation, .flash)
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
        // A needs-you card is the one actionable surface the notch has, so its
        // default is the ~10s the flash design calls for, not the old 5.
        XCTAssertEqual(toastFixture(durationMs: nil).resolvedDurationMs, 10_000)
        XCTAssertEqual(NotchToastTreatment.celebration.defaultDurationMs, 3_000)
        XCTAssertEqual(NotchToastTreatment.info.defaultDurationMs, 5_000)
    }

    func testToastCommandWithoutAPayloadIsRejected() {
        XCTAssertThrowsError(try NotchInputDecoder.decode(line: #"{"type":"toast"}"#)) { error in
            XCTAssertEqual(error as? NotchProtocolError, .missingPayload("toast"))
        }
    }

    func testUnknownCommandDecodesToIgnoredWithoutThrowing() throws {
        XCTAssertEqual(
            try NotchInputDecoder.decode(
                line: #"{"type":"future_thing","payload":{"version":2}}"#
            ),
            .ignored
        )
    }

    /// Both modes are about where the strip *rests*. An event that needs you is
    /// not a resting state, so it takes over in either one — the old "click
    /// only" mode that swallowed alerts is gone with the sprawl.
    @MainActor
    func testTakeoversInterruptInBothRevealModes() {
        for mode in NotchRevealMode.allCases {
            let model = NotchViewModel()
            model.handle(.settings(NotchSettings(
                enabled: true,
                revealMode: mode,
                soundsEnabled: false
            )))

            model.handle(.toast(toastFixture(durationMs: 3_000)))

            XCTAssertNotNil(model.activeToast, "\(mode) swallowed a takeover")
            XCTAssertEqual(model.interaction.presentation, .flash, "\(mode)")
        }
    }

    /// A merge still honours the opt-out, and nothing else does — an alert is
    /// not a celebration and may not be suppressed by the celebration setting.
    @MainActor
    func testCelebrationOptOutOnlySuppressesCelebrations() {
        let model = NotchViewModel()
        model.handle(.settings(NotchSettings(
            enabled: true,
            revealMode: .always,
            celebrationsEnabled: false
        )))

        model.handle(.toast(AttentionToast(
            itemId: nil,
            eventKind: "pr_merged",
            treatment: .celebration,
            title: "Merged #1030"
        )))
        XCTAssertNil(model.activeToast)
        XCTAssertEqual(model.interaction.presentation, .compact)

        model.handle(.toast(toastFixture(durationMs: 3_000)))
        XCTAssertEqual(model.interaction.presentation, .flash)
    }

    /// The retired keys may still be arriving from a host mid-rollout. They may
    /// not fail the frame, and they may not come back out of the helper as
    /// settings the user never chose.
    func testRetiredPresentationKeysAreIgnoredWithoutCostingTheFrame() throws {
        let legacy = """
        {"type":"settings","settings":{"enabled":true,"revealMode":"minimal",
         "expandedPanelEnabled":true,"hideDetails":false,"celebrationsEnabled":true,
         "soundsEnabled":false,"automaticRevealEnabled":false,"tickerEnabled":false}}
        """
        guard case .settings(let settings) = try NotchInputDecoder.decode(line: legacy) else {
            return XCTFail("expected settings")
        }
        XCTAssertTrue(settings.enabled)
        XCTAssertEqual(settings.revealMode, .always)
        XCTAssertFalse(settings.hideDetails)

        let encoded = try JSONEncoder().encode(NotchOutput(type: "settings", settings: settings))
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let emitted = try XCTUnwrap(object["settings"] as? [String: Any])
        XCTAssertNil(emitted["automaticRevealEnabled"])
        XCTAssertNil(emitted["tickerEnabled"])
        XCTAssertEqual(emitted["revealMode"] as? String, "always")
    }

    // MARK: - Compact strip

    /// Every nonzero group, most urgent first, one hue each. The five-way split
    /// is finer than the host's three counts, which file failed and review rows
    /// inside their own `needsYou` band.
    func testStripGroupsAreNonzeroAndUrgencyOrdered() {
        let items = [
            fixtureItem(id: "done-1", phase: "completed"),
            // Planning is not a phase — the wire vocabulary is frozen — so it
            // rides on `chatActivityMode` and only a running turn can carry it.
            fixtureItem(id: "plan-1", phase: "running", chatActivityMode: .planning),
            fixtureItem(id: "run-1", phase: "running"),
            fixtureItem(id: "run-2", phase: "starting"),
            fixtureItem(id: "review", phase: "review_requested"),
            fixtureItem(id: "checks", phase: "checks_failing"),
            fixtureItem(id: "needs", phase: "needs_you"),
        ]
        let groups = notchStripGroups(items: items)
        XCTAssertEqual(
            groups.map(\.kind),
            [.needsYou, .failed, .planning, .working, .done]
        )
        XCTAssertEqual(groups.map(\.count), [1, 1, 1, 3, 1])
        // Amber is "your move" and nothing else borrows it.
        XCTAssertEqual(groups.first?.tone, .amber)
        XCTAssertEqual(NotchStripGroupKind.working.tone, .blue)
        XCTAssertEqual(NotchStripGroupKind.done.tone, .emerald)

        // Nothing running at all draws no groups rather than a row of zeroes.
        XCTAssertTrue(notchStripGroups(items: []).isEmpty)
    }

    /// The ambient tail is exactly what the host's 48-row projection truncates,
    /// so the account's own `done` total wins when it is larger.
    func testDoneGroupPrefersTheAccountTotalOverTheProjectedRows() {
        let items = [fixtureItem(id: "done-1", phase: "completed")]
        let groups = notchStripGroups(
            items: items,
            counts: AttentionCounts(needsYou: 0, working: 0, done: 54, total: 55)
        )
        XCTAssertEqual(groups.first(where: { $0.kind == .done })?.count, 54)
    }

    /// All five groups are floored, not three: the projection truncates by
    /// priority, so failed and planning rows are exactly the ones it drops, and
    /// counting only what survived is the strip under-reporting the account.
    func testEveryGroupIsFlooredByTheAccountCountsIncludingFailedAndPlanning() {
        let items = [
            fixtureItem(id: "fail-1", phase: "checks_failing"),
            fixtureItem(id: "plan-1", phase: "running", chatActivityMode: .planning),
        ]
        let groups = notchStripGroups(
            items: items,
            counts: AttentionCounts(
                needsYou: 2,
                failed: 6,
                planning: 4,
                working: 9,
                done: 54,
                total: 75
            )
        )
        XCTAssertEqual(groups.map(\.kind), [.needsYou, .failed, .planning, .working, .done])
        XCTAssertEqual(groups.map(\.count), [2, 6, 4, 9, 54])
    }

    /// A host that predates the two new counts must keep exactly the behaviour
    /// it has today: absent is not zero, so those groups stay row-derived.
    func testAbsentFailedAndPlanningCountsLeaveThoseGroupsRowDerived() throws {
        let line = """
        {"type":"snapshot","snapshot":{"contractVersion":1,"revision":1,
         "generatedAt":"2026-08-01T12:00:00Z","items":[],
         "counts":{"needsYou":1,"working":2,"done":3,"total":6}}}
        """
        guard case .snapshot(let snapshot) = try NotchInputDecoder.decode(line: line) else {
            return XCTFail("expected a snapshot")
        }
        let counts = try XCTUnwrap(snapshot.counts)
        XCTAssertNil(counts.failed)
        XCTAssertNil(counts.planning)

        let items = [fixtureItem(id: "fail-1", phase: "failed")]
        let groups = notchStripGroups(items: items, counts: counts)
        XCTAssertEqual(groups.first(where: { $0.kind == .failed })?.count, 1)
        XCTAssertNil(groups.first(where: { $0.kind == .planning }))
    }

    /// And a host that sends them is believed, through the same total decoding
    /// every other advisory block gets.
    func testFailedAndPlanningCountsDecodeFromTheWire() throws {
        let line = """
        {"type":"snapshot","snapshot":{"contractVersion":1,"revision":1,
         "generatedAt":"2026-08-01T12:00:00Z","items":[],
         "counts":{"needsYou":1,"failed":7,"planning":-3,"working":2,"done":3,"total":16}}}
        """
        guard case .snapshot(let snapshot) = try NotchInputDecoder.decode(line: line) else {
            return XCTFail("expected a snapshot")
        }
        let counts = try XCTUnwrap(snapshot.counts)
        XCTAssertEqual(counts.failed, 7)
        // Clamped like every other count: a negative is drift, not a group.
        XCTAssertEqual(counts.planning, 0)
    }

    /// Without a counts block the fallback tallies the rows through the same
    /// five-way table, so the panel and the strip cannot disagree with it.
    func testResolvedCountsFallBackThroughTheFiveWayTable() {
        let snapshot = AttentionSnapshot(
            revision: 1,
            generatedAt: "2026-08-01T12:00:00Z",
            items: [
                fixtureItem(id: "needs", phase: "needs_you"),
                fixtureItem(id: "fail", phase: "changes_requested"),
                fixtureItem(id: "plan", phase: "running", chatActivityMode: .planning),
                fixtureItem(id: "run", phase: "running"),
            ]
        )
        let counts = snapshot.resolvedCounts()
        XCTAssertEqual(counts.needsYou, 1)
        XCTAssertEqual(counts.failed, 1)
        XCTAssertEqual(counts.planning, 1)
        XCTAssertEqual(counts.working, 1)
        XCTAssertEqual(counts.done, 0)
        XCTAssertEqual(counts.total, 4)
    }

    /// The right wing carries real content, and falls back to a quiet summary
    /// rather than to nothing.
    func testTopSignalPrefersRealNewsAndFallsBackQuietly() {
        let merged = AttentionItem(
            id: "pr-1",
            fingerprint: "f",
            kind: "pull_request",
            eventKind: "pr_merged",
            phase: "merged",
            machine: AttentionMachine(machineKey: "m", name: "Studio", online: true, lastSeenAt: nil),
            project: AttentionProject(projectId: "ade", name: "ADE"),
            title: "Merge the notch redesign",
            preview: "",
            privacyPreview: "Pull request update",
            destination: AttentionDestination(
                kind: "pull_request",
                repoOwner: "ade",
                repoName: "desktop",
                number: 1_030
            ),
            occurredAt: "2026-08-01T12:00:00Z",
            updatedAt: "2026-08-01T12:00:00Z"
        )
        let signal = notchTopSignal(
            items: [merged, fixtureItem(id: "run", phase: "running")],
            counts: AttentionCounts(),
            status: nil,
            hideDetails: false
        )
        XCTAssertEqual(signal.text, "Merged #1030")
        XCTAssertTrue(signal.isNotable)
        XCTAssertEqual(signal.itemId, "pr-1")

        // Nothing notable: a quiet machine summary, drawn muted.
        let quiet = notchTopSignal(
            items: [fixtureItem(id: "run", phase: "running")],
            counts: AttentionCounts(machinesOnline: 1, machinesTotal: 3),
            status: nil,
            hideDetails: false
        )
        XCTAssertEqual(quiet.text, "1/3 machines")
        XCTAssertFalse(quiet.isNotable)

        // Privacy mode never leaks a repo, a number, or a title.
        let private_ = notchTopSignal(
            items: [merged],
            counts: AttentionCounts(),
            status: nil,
            hideDetails: true
        )
        XCTAssertEqual(private_.text, "Pull request update")

        // A broken stream outranks any row.
        let degraded = notchTopSignal(
            items: [merged],
            counts: AttentionCounts(),
            status: notchStatusPresentation(
                availability: AttentionAvailability(state: .degraded),
                itemCount: 1
            ),
            hideDetails: false
        )
        XCTAssertEqual(degraded.text, "Reconnecting")
    }

    /// Width follows content: the same strip with less to say has to be
    /// narrower, and a runaway signal may not spread it across the menu bar.
    func testStripWidthIsDerivedFromContentAndCapped() {
        let quiet = notchStripMetrics(
            groups: notchStripGroups(items: [fixtureItem(id: "run", phase: "running")]),
            signal: NotchTopSignal(text: "1/3 machines", tone: .neutral, symbolName: "desktopcomputer", isNotable: false)
        )
        let busy = notchStripMetrics(
            groups: notchStripGroups(items: [
                fixtureItem(id: "needs", phase: "needs_you"),
                fixtureItem(id: "checks", phase: "checks_failing"),
                fixtureItem(id: "review", phase: "review_requested"),
                fixtureItem(id: "run", phase: "running"),
                fixtureItem(id: "done", phase: "completed"),
            ]),
            signal: NotchTopSignal(text: "Checks failing #466", tone: .red, symbolName: "x", isNotable: true)
        )
        XCTAssertLessThan(quiet.leadingWidth, busy.leadingWidth)

        let quietWidth = notchSurfaceSize(
            presentation: .compact,
            physicalNotchWidth: 182,
            safeAreaTop: 34,
            strip: quiet
        ).width
        let busyWidth = notchSurfaceSize(
            presentation: .compact,
            physicalNotchWidth: 182,
            safeAreaTop: 34,
            strip: busy
        ).width
        XCTAssertLessThan(quietWidth, busyWidth)
        // The old fixed strip was 406pt wide no matter what it carried.
        XCTAssertLessThan(quietWidth, 406)

        let runaway = notchStripMetrics(
            groups: [],
            signal: NotchTopSignal(
                text: String(repeating: "very long signal ", count: 12),
                tone: .amber,
                symbolName: "x",
                isNotable: true
            )
        )
        XCTAssertLessThanOrEqual(
            notchSurfaceSize(
                presentation: .compact,
                physicalNotchWidth: 182,
                safeAreaTop: 34,
                strip: runaway
            ).width,
            NotchDisplayGeometry.panelSize.width
        )
    }

    // MARK: - Events tab

    /// Three failing checks on one pull request are one story, not three rows.
    func testEventClustersGroupByPullRequestAndKeepAgentsOut() {
        func check(_ id: String, phase: String, number: Int) -> AttentionItem {
            AttentionItem(
                id: id,
                fingerprint: "f-\(id)",
                kind: "pull_request",
                eventKind: "pr_checks_failing",
                phase: phase,
                machine: AttentionMachine(machineKey: "m", name: "Studio", online: true, lastSeenAt: nil),
                project: AttentionProject(projectId: "ade", name: "ADE"),
                title: "Check \(id)",
                preview: "",
                privacyPreview: "Pull request update",
                destination: AttentionDestination(
                    kind: "pull_request",
                    repoOwner: "ade",
                    repoName: "desktop",
                    number: number
                ),
                occurredAt: "2026-08-01T12:00:00Z",
                updatedAt: "2026-08-01T12:00:00Z"
            )
        }
        let items = [
            fixtureItem(id: "agent", phase: "running"),
            check("c1", phase: "checks_failing", number: 466),
            check("c2", phase: "checks_failing", number: 466),
            check("c3", phase: "open", number: 466),
            check("other", phase: "merged", number: 1_030),
        ]

        let clusters = notchEventClusters(items)
        XCTAssertEqual(clusters.count, 2)
        XCTAssertEqual(clusters.first?.title, "desktop #466")
        XCTAssertEqual(clusters.first?.count, 3)
        XCTAssertEqual(clusters.first?.tone, .red)
        XCTAssertEqual(clusters.last?.count, 1)

        // Tabs partition the feed; an agent is never an event.
        XCTAssertEqual(notchItems(items, in: .agents).map(\.id), ["agent"])
        XCTAssertEqual(notchItems(items, in: .events).count, 4)
        XCTAssertEqual(notchPanelTab(for: items[1]), .events)

        // Privacy mode never names the repository or the number.
        XCTAssertEqual(notchEventClusters(items, hideDetails: true).first?.title, "Pull request")
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
        tier: String? = nil,
        chatActivityMode: AttentionChatActivityMode? = nil
    ) -> AttentionItem {
        AttentionItem(
            id: id,
            fingerprint: "fingerprint-\(id)",
            kind: "agent",
            eventKind: "agent_running",
            phase: phase,
            machine: AttentionMachine(machineKey: "mac-1", name: "Studio", online: true, lastSeenAt: nil),
            project: AttentionProject(projectId: "ade", name: "ADE"),
            chatActivityMode: chatActivityMode,
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
