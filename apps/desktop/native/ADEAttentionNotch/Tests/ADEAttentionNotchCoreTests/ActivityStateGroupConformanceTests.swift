import XCTest
@testable import ADEAttentionNotchCore

/// The pin that turns a documented mirror into an enforced one.
///
/// The phase → state-group rule is implemented four times over — the renderer
/// (TypeScript), this helper, the iOS app, and the hermetic push-relay Worker —
/// because none of those surfaces can import another's code. Prose alone did
/// not keep them in step. `activityStateGroup.cases.json` is the shared fixture
/// every implementation runs through its own mapper; when the canonical rule in
/// `activityPresentation.ts` changes, these cases change with it and every
/// suite that has not followed fails.
///
/// Read from the repo rather than copied into a SwiftPM resource bundle on
/// purpose: a copy would be a fifth implementation of the table to keep in
/// step, which is the exact failure this file exists to prevent.
final class ActivityStateGroupConformanceTests: XCTestCase {

    private struct CaseFile: Decodable {
        let cases: [Case]
    }

    private struct Case: Decodable {
        let name: String
        let phase: String
        let tier: String?
        let chatActivityMode: String?
        let expected: String
    }

    func testStripGroupKindMatchesTheCanonicalCaseTable() throws {
        let url = try Self.casesURL()
        let decoded = try JSONDecoder().decode(CaseFile.self, from: Data(contentsOf: url))
        XCTAssertFalse(decoded.cases.isEmpty, "the case table decoded empty")

        for testCase in decoded.cases {
            let expected = try XCTUnwrap(
                Self.groupKind(slug: testCase.expected),
                "unknown expected group '\(testCase.expected)' in case '\(testCase.name)'"
            )
            let actual = notchStripGroupKind(for: Self.item(for: testCase))
            XCTAssertEqual(
                actual,
                expected,
                "\(testCase.name): phase=\(testCase.phase) tier=\(testCase.tier ?? "nil") "
                    + "mode=\(testCase.chatActivityMode ?? "nil") "
                    + "expected \(expected.sectionId), got \(actual.sectionId)"
            )
        }
    }

    /// Every group in the table is exercised by at least one case, so a group
    /// can never be added to the Swift enum and left unpinned.
    func testEveryGroupIsCoveredByTheCaseTable() throws {
        let decoded = try JSONDecoder().decode(
            CaseFile.self,
            from: Data(contentsOf: try Self.casesURL())
        )
        let covered = Set(decoded.cases.map(\.expected))
        for kind in NotchStripGroupKind.allCases {
            XCTAssertTrue(
                covered.contains(kind.sectionId),
                "no case pins \(kind.sectionId)"
            )
        }
    }

    // MARK: - Fixture plumbing

    /// The slugs the shared fixture speaks are the host's `ActivitySectionId`
    /// values, which is also what `NotchStripGroupKind.sectionId` promises to
    /// be — so the mapping is that promise, checked.
    private static func groupKind(slug: String) -> NotchStripGroupKind? {
        NotchStripGroupKind.allCases.first { $0.sectionId == slug }
    }

    private static func item(for testCase: Case) -> AttentionItem {
        AttentionItem(
            id: testCase.name,
            fingerprint: "f-\(testCase.name)",
            kind: "agent",
            eventKind: "agent_running",
            phase: testCase.phase,
            machine: AttentionMachine(machineKey: "m", name: "Studio", online: true, lastSeenAt: nil),
            project: AttentionProject(projectId: "ade", name: "ADE"),
            // A mode string this build has never heard of decodes to `.unknown`
            // on the wire, so the fixture's unknown values must reach the mapper
            // the same way rather than as `nil`.
            chatActivityMode: testCase.chatActivityMode.map {
                AttentionChatActivityMode(rawValue: $0) ?? .unknown
            },
            title: "Work",
            preview: "Working",
            privacyPreview: "Agent update",
            destination: AttentionDestination(kind: "session", sessionId: "s"),
            occurredAt: "2026-08-01T12:00:00Z",
            updatedAt: "2026-08-01T12:00:00Z",
            activityTier: testCase.tier
        )
    }

    private static let casesRelativePath =
        "src/shared/attention/activityStateGroup.cases.json"

    /// Walks up from this source file to the `apps/desktop` directory that owns
    /// the fixture. Failing (rather than skipping) when it is missing is the
    /// point: a pin nobody can find is a pin nobody is held to.
    private static func casesURL() throws -> URL {
        var directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<12 {
            let candidate = directory.appendingPathComponent(casesRelativePath)
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            let parent = directory.deletingLastPathComponent()
            if parent.path == directory.path { break }
            directory = parent
        }
        throw NSError(
            domain: "ActivityStateGroupConformanceTests",
            code: 1,
            userInfo: [
                NSLocalizedDescriptionKey:
                    "could not find \(casesRelativePath) above \(#filePath)",
            ]
        )
    }
}
