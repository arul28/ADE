import Foundation
import XCTest
@testable import ADE

/// The Proof sheet writes exactly two lines per row, so every word in them
/// comes from `WorkProofRowModel`. These pin the wording: the kind label, the
/// short relative time, the "kind · when" subtitle, and the VoiceOver phrasing.
final class WorkProofRowModelTests: XCTestCase {

    private let now = Date(timeIntervalSince1970: 1_760_000_000)

    private func artifact(
        id: String = "artifact-1",
        kind: String = "screenshot",
        title: String = "Login page",
        mimeType: String? = "image/png",
        createdAt: String
    ) -> ComputerUseArtifactSummary {
        ComputerUseArtifactSummary(
            id: id,
            artifactKind: kind,
            backendStyle: "desktop",
            backendName: "ADE Browser",
            sourceToolName: nil,
            originalType: nil,
            title: title,
            description: nil,
            uri: "file:///tmp/\(id).png",
            storageKind: "file",
            mimeType: mimeType,
            metadataJson: nil,
            createdAt: createdAt,
            ownerKind: "chat",
            ownerId: "chat-1",
            relation: "produced"
        )
    }

    private func iso(minutesAgo: Double) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.string(from: now.addingTimeInterval(-minutesAgo * 60))
    }

    func testSubtitleJoinsKindAndRelativeTime() {
        let model = WorkProofRowModel(artifact: artifact(createdAt: iso(minutesAgo: 2)), now: now)
        XCTAssertEqual(model.kindLabel, "Screenshot")
        XCTAssertEqual(model.relativeTime, "2m ago")
        XCTAssertEqual(model.subtitle, "Screenshot · 2m ago")
    }

    func testAccessibilityLabelReadsKindTitleThenTime() {
        let model = WorkProofRowModel(artifact: artifact(createdAt: iso(minutesAgo: 2)), now: now)
        XCTAssertEqual(model.accessibilityLabel, "Screenshot, Login page, 2m ago")
    }

    func testMultiWordKindsAreTitleCased() {
        let model = WorkProofRowModel(
            artifact: artifact(kind: "browser_verification", mimeType: nil, createdAt: iso(minutesAgo: 5)),
            now: now
        )
        XCTAssertEqual(model.kindLabel, "Browser Verification")
        XCTAssertEqual(model.subtitle, "Browser Verification · 5m ago")
    }

    func testBlankTitleFallsBackToKindLabel() {
        let model = WorkProofRowModel(
            artifact: artifact(title: "   ", createdAt: iso(minutesAgo: 1)),
            now: now
        )
        XCTAssertEqual(model.title, "Screenshot")
        XCTAssertEqual(model.accessibilityLabel, "Screenshot, Screenshot, 1m ago")
    }

    func testVideoKindIsFlaggedForThePlayAffordance() {
        let image = WorkProofRowModel(artifact: artifact(createdAt: iso(minutesAgo: 1)), now: now)
        XCTAssertFalse(image.isVideo)

        let video = WorkProofRowModel(
            artifact: artifact(kind: "video_recording", mimeType: "video/mp4", createdAt: iso(minutesAgo: 1)),
            now: now
        )
        XCTAssertTrue(video.isVideo)
        XCTAssertEqual(video.kindLabel, "Video Recording")
    }

    func testRelativeTimeBuckets() {
        XCTAssertEqual(workProofRelativeTime(iso(minutesAgo: 0.4), now: now), "now")
        XCTAssertEqual(workProofRelativeTime(iso(minutesAgo: 1), now: now), "1m ago")
        XCTAssertEqual(workProofRelativeTime(iso(minutesAgo: 59), now: now), "59m ago")
        XCTAssertEqual(workProofRelativeTime(iso(minutesAgo: 60), now: now), "1h ago")
        XCTAssertEqual(workProofRelativeTime(iso(minutesAgo: 60 * 23), now: now), "23h ago")
        XCTAssertEqual(workProofRelativeTime(iso(minutesAgo: 60 * 24), now: now), "1d ago")
        XCTAssertEqual(workProofRelativeTime(iso(minutesAgo: 60 * 24 * 9), now: now), "9d ago")
    }

    /// A host clock a little ahead of the phone must not print a negative age.
    func testFutureTimestampReadsAsNow() {
        XCTAssertEqual(workProofRelativeTime(iso(minutesAgo: -5), now: now), "now")
    }

    /// Unparseable timestamps fall back to the raw string rather than a wrong age.
    func testUnparseableTimestampFallsBackToRawValue() {
        XCTAssertEqual(workProofRelativeTime("not-a-date", now: now), "not-a-date")
    }
}
