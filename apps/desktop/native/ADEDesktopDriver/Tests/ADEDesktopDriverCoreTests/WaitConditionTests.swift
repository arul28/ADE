import XCTest
@testable import ADEDesktopDriverCore

final class WaitConditionTests: XCTestCase {
    func testRejectsACallWithNoSelector() {
        XCTAssertNil(WaitCondition(text: nil, gone: nil, windowTitle: nil, timeoutMs: 1_000))
        // The service sends all three keys, so blank strings are the shape a
        // "no selector" call actually arrives in.
        XCTAssertNil(WaitCondition(text: "", gone: "   ", windowTitle: "", timeoutMs: nil))
    }

    func testPicksTheMostSpecificSelectorAndClampsTheTimeout() throws {
        let appears = try XCTUnwrap(WaitCondition(text: "Save", gone: "Save", windowTitle: "Doc", timeoutMs: nil))
        XCTAssertEqual(appears.kind, .appears("Save"))
        XCTAssertEqual(appears.timeoutMs, WaitCondition.defaultTimeoutMs)

        let gone = try XCTUnwrap(WaitCondition(text: nil, gone: "Spinner", windowTitle: "Doc", timeoutMs: 10_000_000))
        XCTAssertEqual(gone.kind, .disappears("Spinner"))
        XCTAssertEqual(gone.timeoutMs, WaitCondition.maxTimeoutMs)

        let title = try XCTUnwrap(WaitCondition(text: nil, gone: nil, windowTitle: "Untitled", timeoutMs: -5))
        XCTAssertEqual(title.kind, .windowTitle("Untitled"))
        XCTAssertEqual(title.timeoutMs, 0)
    }

    func testAppearsIsMetOnlyWhenAnElementMatched() throws {
        let condition = try XCTUnwrap(WaitCondition(text: "Save", gone: nil, windowTitle: nil, timeoutMs: 500))
        XCTAssertEqual(condition.elementNeedle, "Save")
        XCTAssertEqual(condition.outcome(matchedIndex: nil, windowTitles: ["Save"]), .pending)
        XCTAssertEqual(condition.outcome(matchedIndex: 12, windowTitles: []), .met(index: 12))
    }

    func testGoneIsMetWithNoElementAndCarriesNoIndex() throws {
        let condition = try XCTUnwrap(WaitCondition(text: nil, gone: "Spinner", windowTitle: nil, timeoutMs: 500))
        XCTAssertEqual(condition.elementNeedle, "Spinner")
        XCTAssertEqual(condition.outcome(matchedIndex: 3, windowTitles: []), .pending)
        XCTAssertEqual(condition.outcome(matchedIndex: nil, windowTitles: []), .met(index: nil))
    }

    func testWindowTitleNeverWalksElementsAndMatchesCaseInsensitively() throws {
        let condition = try XCTUnwrap(WaitCondition(text: nil, gone: nil, windowTitle: "untitled", timeoutMs: 500))
        XCTAssertNil(condition.elementNeedle)
        XCTAssertEqual(condition.outcome(matchedIndex: nil, windowTitles: ["Notes"]), .pending)
        XCTAssertEqual(condition.outcome(matchedIndex: nil, windowTitles: ["Untitled 2"]), .met(index: nil))
    }

    /// The scheduling half of `input {command:"wait"}`. The driver spends this
    /// interval pumping the main run loop rather than sleeping on it, so every
    /// other lane's request and the health `ping` are still answered mid-wait.
    func testPollDelayIsClampedToTheIntervalAndEndsAtTheDeadline() {
        let now = Date(timeIntervalSince1970: 1_700_000_000)
        let interval = Double(WaitCondition.pollIntervalMs) / 1000

        // Plenty of time left: one poll interval, never more.
        XCTAssertEqual(
            WaitCondition.pollDelaySeconds(now: now, deadline: now.addingTimeInterval(120)),
            interval
        )
        // Less than an interval left: the remainder, so the wait never
        // overshoots its own timeout.
        XCTAssertEqual(
            WaitCondition.pollDelaySeconds(now: now, deadline: now.addingTimeInterval(0.05)) ?? -1,
            0.05,
            accuracy: 0.0001
        )
        // At or past the deadline: nil, meaning stop — never a zero-second
        // pump that would spin the main thread.
        XCTAssertNil(WaitCondition.pollDelaySeconds(now: now, deadline: now))
        XCTAssertNil(WaitCondition.pollDelaySeconds(now: now, deadline: now.addingTimeInterval(-5)))
    }
}
