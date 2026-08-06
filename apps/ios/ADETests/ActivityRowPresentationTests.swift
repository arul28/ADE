import SwiftUI
import UIKit
import XCTest
@testable import ADE

/// The anti-drift test for the iOS half of the status vocabulary. Every
/// expectation here is transcribed from
/// `apps/desktop/src/shared/sessionStatusPresentation.ts` (session phases) and
/// `renderer/components/activity/activityPresentation.ts`
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

    // MARK: - The one table

    /// The tone tokens are only worth anything if they resolve to the desktop's
    /// actual hex values. Pinning the enum alone let the *colours* drift while
    /// every table test stayed green.
    func testTonesResolveToTheDesktopHexPalette() {
        let expectations: [(ActivityTone, String)] = [
            (.blue, "#60A5FA"),
            (.violet, "#A78BFA"),
            (.amber, "#FBBF24"),
            (.emerald, "#34D399"),
            (.red, "#F87171"),
            (.neutral, "#71717A"),
        ]

        for (tone, hex) in expectations {
            XCTAssertEqual(Self.hex(activityToneColor(tone)), hex, "hue for \(tone.rawValue)")
        }
    }

    /// The locked glyph language: one shape per state, and no two states
    /// sharing one. Shape has to carry as much as hue does — these are read at
    /// 9pt on a lock screen, and by people who cannot tell amber from emerald.
    func testStateGlyphsMatchTheLockedDesign() {
        XCTAssertEqual(ActivityGlyph.needsYou.systemImage, "circle.fill", "needs you is a filled dot")
        XCTAssertEqual(ActivityGlyph.planning.systemImage, "note.text", "planning is a notepad")
        XCTAssertEqual(ActivityGlyph.working.systemImage, "circle.dotted", "working is an open circle")
        XCTAssertEqual(ActivityGlyph.done.systemImage, "checkmark.circle.fill", "done is a checkmark")
        XCTAssertEqual(ActivityGlyph.failed.systemImage, "exclamationmark.triangle.fill", "failed is a triangle")

        let shapes = ActivityStateGroup.allCases.map(\.glyph.systemImage)
        XCTAssertEqual(Set(shapes).count, shapes.count, "no two state groups may share a glyph")
    }

    /// The labels are the contract the desktop's `ACTIVITY_STATE_GLYPHS` sets;
    /// the SF Symbol each maps to is this surface's choice (see the note on
    /// `ActivityGlyph`). A word or hue moving on desktop must move here.
    func testStateGroupLabelsAndTonesMatchTheDesktopTable() {
        let expectations: [(ActivityStateGroup, String, ActivityTone)] = [
            (.needsYou, "Needs you", .amber),
            (.failed, "Failed", .red),
            (.planning, "Planning", .violet),
            (.working, "Working", .blue),
            (.done, "Done", .emerald),
        ]

        for (group, label, tone) in expectations {
            XCTAssertEqual(group.label, label, "label for \(group.rawValue)")
            XCTAssertEqual(group.tone, tone, "tone for \(group.rawValue)")
        }
    }

    /// A glyph name with a typo renders as nothing at all, and a widget cannot
    /// report its own missing icon.
    func testEveryGlyphIsARealSFSymbol() {
        let glyphs: [ActivityGlyph] = [
            .working, .planning, .waiting, .needsYou, .done, .stale, .failed, .review, .merged,
        ]
        for glyph in glyphs {
            XCTAssertNotNil(
                UIImage(systemName: glyph.systemImage),
                "\(glyph.rawValue) → \(glyph.systemImage) is not an SF Symbol on this OS"
            )
        }
    }

    func testStateGroupsRankYourMoveFirstAndOutcomesLast() {
        XCTAssertEqual(
            ActivityStateGroup.allCases.sorted { $0.rank < $1.rank },
            [.needsYou, .failed, .planning, .working, .done]
        )
        XCTAssertEqual(ActivityPhaseVocabulary.stateGroup(for: .needsYou), .needsYou)
        // Failure splits out of the needs-you *band* here: "2 failed" and
        // "2 waiting on you" are different sentences.
        XCTAssertEqual(ActivityPhaseVocabulary.band(for: .failed), .needsYou)
        XCTAssertEqual(ActivityPhaseVocabulary.stateGroup(for: .failed), .failed)
        XCTAssertEqual(ActivityPhaseVocabulary.stateGroup(for: .checksFailing), .failed)
        XCTAssertEqual(ActivityPhaseVocabulary.stateGroup(for: .running), .working)
        XCTAssertEqual(
            ActivityPhaseVocabulary.stateGroup(for: .running, chatActivityMode: .planning),
            .planning
        )
        // Planning has exactly one derivation, and it is not a phase string:
        // the wire phase vocabulary is frozen and no publisher emits `planning`.
        XCTAssertEqual(ActivityPhaseVocabulary.stateGroup(for: .unrecognized("planning")), .done)
        XCTAssertEqual(ActivityPhaseVocabulary.stateGroup(for: .completed), .done)
        XCTAssertEqual(ActivityPhaseVocabulary.stateGroup(for: .unrecognized("teleporting")), .done)
    }

    func testStateGroupWireSlugsRoundTrip() {
        for group in ActivityStateGroup.allCases {
            XCTAssertEqual(ActivityStateGroup(wireValue: group.wireValue), group)
        }
        XCTAssertEqual(ActivityStateGroup(wireValue: "needs_you"), .needsYou)
        XCTAssertNil(ActivityStateGroup(wireValue: "teleporting"))
    }

    /// Idle-tier rows are quiet roster history whatever phase they preserved,
    /// so they all land in `done` — the canonical rule, which runs before the
    /// phase switch rather than demoting one phase by one step.
    func testIdleTierSendsEveryRowToDone() {
        for phase: AccountAttentionPhase in [.needsYou, .failed, .running, .checksFailing] {
            let row = ActivityRowPresentation(item: makeItem(phase: phase, activityTier: "idle"))
            XCTAssertEqual(row.stateGroup, .done, "idle \(phase.rawValue)")
        }
        XCTAssertEqual(ActivityRowPresentation(item: makeItem(phase: .needsYou)).stateGroup, .needsYou)
        XCTAssertEqual(ActivityRowPresentation(item: makeItem(phase: .failed)).stateGroup, .failed)
    }

    /// The violet notepad has to be reachable from a real row. It is carried on
    /// the additive `chatActivityMode` field, never on a phase.
    func testPlanningIsDerivedFromChatActivityMode() {
        let planning = ActivityRowPresentation(
            item: makeItem(phase: .running, chatActivityMode: .planning)
        )

        XCTAssertEqual(planning.stateGroup, .planning)
        XCTAssertEqual(planning.phaseLabel, "Planning")
        XCTAssertEqual(planning.tone, .violet)
        XCTAssertEqual(planning.glyph, .planning)

        let working = ActivityRowPresentation(item: makeItem(phase: .running))
        XCTAssertEqual(working.stateGroup, .working)
        XCTAssertEqual(working.phaseLabel, "Working")
    }

    /// An older publisher omits the field and a newer one may send a value this
    /// build has never heard of. Neither may throw: a throw is caught upstream
    /// by `FailableDecodable` and silently drops the whole row.
    func testChatActivityModeDecodesLeniently() throws {
        XCTAssertEqual(try decodeMode("\"planning\""), .planning)
        XCTAssertEqual(try decodeMode("\"telepathy\""), .unrecognized("telepathy"))
        // A non-string is still not a decode failure.
        XCTAssertEqual(try decodeMode("42"), .unrecognized(""))
        XCTAssertFalse(try XCTUnwrap(decodeMode("42")).isPlanning)
    }

    private struct ChatModeEnvelope: Decodable {
        let chatActivityMode: AccountChatActivityMode?
    }

    private func decodeMode(_ json: String) throws -> AccountChatActivityMode? {
        let data = Data("{\"chatActivityMode\":\(json)}".utf8)
        return try JSONDecoder().decode(ChatModeEnvelope.self, from: data).chatActivityMode
    }

    func testChatActivityModeIsAbsentWhenTheKeyIsMissingOrNull() throws {
        XCTAssertNil(
            try JSONDecoder()
                .decode(ChatModeEnvelope.self, from: Data("{}".utf8))
                .chatActivityMode
        )
        XCTAssertNil(
            try JSONDecoder()
                .decode(ChatModeEnvelope.self, from: Data("{\"chatActivityMode\":null}".utf8))
                .chatActivityMode
        )
    }

    // MARK: - Cross-language conformance

    /// The pin. `apps/desktop/src/shared/attention/activityStateGroup.cases.json`
    /// encodes the canonical rule from `activityStateGroup` in
    /// `renderer/components/activity/activityPresentation.ts`, and all four
    /// mirrors — renderer, notch, relay, and this one — run the same cases
    /// through their own mapper. Documentation alone did not keep them in step:
    /// this copy drifted on `merge_ready`, on idle-tier demotion, and on how
    /// `planning` is derived, in the commit that created it.
    private struct ConformanceCase: Decodable {
        let name: String
        let phase: String
        let tier: String
        let chatActivityMode: String?
        let expected: String
    }

    private struct ConformanceFixture: Decodable {
        let cases: [ConformanceCase]
    }

    func testStateGroupMatchesTheSharedConformanceFixture() throws {
        let data = try Data(contentsOf: Self.conformanceFixtureURL)
        let fixture = try JSONDecoder().decode(ConformanceFixture.self, from: data)
        XCTAssertFalse(fixture.cases.isEmpty)

        for testCase in fixture.cases {
            let item = makeItem(
                phase: AccountAttentionPhase(rawValue: testCase.phase)
                    ?? .unrecognized(testCase.phase),
                activityTier: testCase.tier,
                chatActivityMode: testCase.chatActivityMode.map {
                    $0 == "planning" ? .planning : .unrecognized($0)
                }
            )
            let expected = try XCTUnwrap(
                Self.stateGroup(fixtureSlug: testCase.expected),
                "unknown group slug \(testCase.expected)"
            )

            XCTAssertEqual(
                ActivityRowPresentation(item: item).stateGroup,
                expected,
                testCase.name
            )
        }
    }

    /// The fixture is shared source, not a bundle resource — resolving it from
    /// `#filePath` keeps it out of the pbxproj and guarantees the test reads the
    /// same file the other three suites do rather than a stale copy.
    private static let conformanceFixtureURL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // ADETests
        .deletingLastPathComponent()   // ios
        .deletingLastPathComponent()   // apps
        .appendingPathComponent("desktop/src/shared/attention/activityStateGroup.cases.json")

    /// The fixture speaks the renderer's kebab-case group slugs.
    private static func stateGroup(fixtureSlug: String) -> ActivityStateGroup? {
        switch fixtureSlug {
        case "needs-you": return .needsYou
        case "failed": return .failed
        case "planning": return .planning
        case "working": return .working
        case "done": return .done
        default: return nil
        }
    }

    // MARK: - Cross-surface parity

    /// The Live Activity used to carry its own copy of the hue/glyph/word
    /// table, which is how the island came to draw an octagon for a failure the
    /// rest of the app drew as a triangle. Both wire enums now project onto
    /// `ActivityPhaseVocabulary`; this is the test that keeps them there.
    func testLiveActivityAgentPhasesReadFromTheSharedVocabulary() {
        let expectations: [(AgentRunPhase, AccountAttentionPhase)] = [
            (.starting, .starting),
            (.running, .running),
            (.waitingForApproval, .needsYou),
            (.waitingForInput, .needsYou),
            (.completed, .completed),
            (.failed, .failed),
            (.stale, .stale),
        ]

        for (wire, phase) in expectations {
            let shared = ActivityPhaseVocabulary.presentation(for: phase)
            XCTAssertEqual(wire.attentionPhase, phase, "projection for \(wire.rawValue)")
            XCTAssertEqual(wire.label, shared.label, "label for \(wire.rawValue)")
            XCTAssertEqual(wire.tone, shared.tone, "tone for \(wire.rawValue)")
            XCTAssertEqual(wire.glyph, shared.glyph, "glyph for \(wire.rawValue)")
            XCTAssertEqual(wire.symbol, shared.glyph?.systemImage, "symbol for \(wire.rawValue)")
            XCTAssertEqual(wire.isProminent, shared.prominent, "prominence for \(wire.rawValue)")
            XCTAssertEqual(
                Self.hex(wire.tint),
                Self.hex(activityToneColor(shared.tone)),
                "hue for \(wire.rawValue)"
            )
        }
    }

    func testLiveActivityPullRequestPhasesReadFromTheSharedVocabulary() {
        let expectations: [(PullRequestPhase, AccountAttentionPhase)] = [
            (.opened, .open),
            (.reopened, .open),
            (.closed, .closed),
            (.merged, .merged),
            (.checksFailing, .checksFailing),
            (.reviewRequested, .reviewRequested),
            (.changesRequested, .changesRequested),
            (.mergeReady, .mergeReady),
        ]

        for (wire, phase) in expectations {
            let shared = ActivityPhaseVocabulary.presentation(for: phase)
            XCTAssertEqual(wire.attentionPhase, phase, "projection for \(wire.rawValue)")
            XCTAssertEqual(wire.tone, shared.tone, "tone for \(wire.rawValue)")
            XCTAssertEqual(
                Self.hex(wire.tint),
                Self.hex(activityToneColor(shared.tone)),
                "hue for \(wire.rawValue)"
            )
            // Opened / reopened are the only two words the shared table has no
            // room for: they collapse to one session phase, `open`.
            if wire != .opened, wire != .reopened {
                XCTAssertEqual(wire.label, shared.label, "label for \(wire.rawValue)")
                XCTAssertEqual(wire.glyph, shared.glyph, "glyph for \(wire.rawValue)")
            }
            XCTAssertNotNil(
                UIImage(systemName: wire.symbol),
                "\(wire.rawValue) → \(wire.symbol) is not an SF Symbol"
            )
        }
    }

    /// The rule the whole file exists to protect, applied across every table
    /// any surface reads — not just the session one.
    func testAmberIsSpentOnExactlyOneStateInEveryTable() {
        let amberGroups = ActivityStateGroup.allCases.filter { $0.tone == .amber }
        XCTAssertEqual(amberGroups, [.needsYou])

        let amberRuns = AgentRunPhase.allCases.filter { $0.tone == .amber }
        XCTAssertEqual(amberRuns, [.waitingForApproval, .waitingForInput])

        let amberPrs = PullRequestPhase.allCases.filter { $0.tone == .amber }
        XCTAssertTrue(amberPrs.isEmpty, "no pull-request state is ever the reader's move")
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

    /// The band applies the same idle rule the state group does: quiet history
    /// files in the tail, not one step above it. Demoting `needsYou` to
    /// `working` used to sort a roster row above live finished work and print
    /// it under a "Working" heading that was not true of it.
    func testIdleTierFilesInTheDoneBand() {
        for phase: AccountAttentionPhase in [.needsYou, .failed, .running] {
            let row = ActivityRowPresentation(item: makeItem(phase: phase, activityTier: "idle"))
            XCTAssertEqual(row.tier, .idle)
            XCTAssertEqual(row.band, .done, "an idle \(phase.rawValue) row is quiet history")
        }
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

    func testExtremeElapsedAndLastSeenValuesAreRejectedWithoutIntegerConversion() {
        let now = Date(timeIntervalSince1970: 1_754_046_000)
        let extremePast = Date(timeIntervalSince1970: -1e300)
        let elapsed = ActivityRowPresentation(
            item: makeItem(phase: .running, occurredAt: extremePast)
        )
        let offline = ActivityRowPresentation(
            item: makeItem(
                phase: .running,
                occurredAt: now,
                machine: AccountAttentionMachine(
                    machineKey: "corrupt",
                    name: "Corrupt timestamp",
                    online: false,
                    lastSeenAt: extremePast
                )
            )
        )

        XCTAssertNil(ActivityRowPresentation.formatDuration(1e300))
        XCTAssertNil(ActivityRowPresentation.formatDuration(-1e300))
        XCTAssertNil(elapsed.elapsedLabel(now: now))
        XCTAssertNil(offline.lastSeenLabel(now: now))
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

    /// `#RRGGBB` for a SwiftUI colour, so a hue can be pinned to the desktop's
    /// literal value rather than to "whatever the token resolves to today".
    private static func hex(_ color: Color) -> String {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        guard UIColor(color).getRed(&red, green: &green, blue: &blue, alpha: &alpha) else {
            return "unresolvable"
        }
        return String(
            format: "#%02X%02X%02X",
            Int((red * 255).rounded()),
            Int((green * 255).rounded()),
            Int((blue * 255).rounded())
        )
    }

    private func makeItem(
        id: String = "item-1",
        phase: AccountAttentionPhase,
        kind: AccountAttentionItemKind = .agent,
        activityTier: String? = nil,
        chatActivityMode: AccountChatActivityMode? = nil,
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
            chatActivityMode: chatActivityMode,
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
