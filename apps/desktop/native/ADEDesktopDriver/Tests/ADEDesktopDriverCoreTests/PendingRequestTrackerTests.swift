import XCTest
@testable import ADEDesktopDriverCore

/// The watchdog's rule, tested against an injected clock rather than a real
/// one: "every request line gets exactly one reply" is a property, not a
/// fifteen-second wait.
final class PendingRequestTrackerTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)

    func testAHandlerThatAnswersInTimeKeepsItsReply() {
        let tracker = PendingRequestTracker(timeout: 15)
        tracker.begin(id: "1", op: "record.start", at: start)
        XCTAssertEqual(tracker.takeOverdue(at: start.addingTimeInterval(14.9)), [])
        XCTAssertTrue(tracker.claim(id: "1"))
        tracker.finish(id: "1")
        XCTAssertEqual(tracker.inFlightCount, 0)
    }

    func testTheWatchdogAnswersARequestThatOutlivesItsBudget() {
        let tracker = PendingRequestTracker(timeout: 15)
        tracker.begin(id: "7", op: "record.start", at: start)
        let overdue = tracker.takeOverdue(at: start.addingTimeInterval(15))
        XCTAssertEqual(overdue.map(\.id), ["7"])
        XCTAssertEqual(overdue.first?.op, "record.start")
        XCTAssertEqual(overdue.first?.driverError.code, DriverErrorCode.internalError)
        XCTAssertTrue(overdue.first?.driverError.message.hasPrefix("record.start did not complete") == true)
    }

    func testAHandlerThatFinishesAfterTheWatchdogStaysSilent() {
        let tracker = PendingRequestTracker(timeout: 15)
        tracker.begin(id: "7", op: "stream.start", at: start)
        XCTAssertEqual(tracker.takeOverdue(at: start.addingTimeInterval(20)).count, 1)
        // The late handler asks for the right to reply and is refused: two
        // lines with one id would desynchronise the client's promise map.
        XCTAssertFalse(tracker.claim(id: "7"))
        tracker.finish(id: "7")
    }

    func testAnOverdueRequestIsOnlyReportedOnce() {
        let tracker = PendingRequestTracker(timeout: 15)
        tracker.begin(id: "7", op: "capture.screenshot", at: start)
        XCTAssertEqual(tracker.takeOverdue(at: start.addingTimeInterval(16)).count, 1)
        XCTAssertEqual(tracker.takeOverdue(at: start.addingTimeInterval(60)), [])
        // Still genuinely running, and still tracked, until the handler returns.
        XCTAssertTrue(tracker.isPending(id: "7"))
    }

    func testAReplyWrittenOffTheDispatchPathIsNeverSuppressed() {
        let tracker = PendingRequestTracker(timeout: 15)
        // A malformed line and a gesture rejection answer ids the tracker has
        // never seen; those must always be allowed through.
        XCTAssertTrue(tracker.claim(id: "never-registered"))
        XCTAssertTrue(tracker.claim(id: "never-registered"))
    }

    func testALongInputWaitKeepsItsOwnBudget() {
        let tracker = PendingRequestTracker(timeout: 15)
        tracker.begin(id: "9", op: "input", budget: 15 + 120, at: start)
        XCTAssertEqual(tracker.takeOverdue(at: start.addingTimeInterval(100)), [])
        XCTAssertEqual(tracker.takeOverdue(at: start.addingTimeInterval(136)).map(\.id), ["9"])
    }

    func testABudgetShorterThanTheDefaultDoesNotShortenTheDeadline() {
        let tracker = PendingRequestTracker(timeout: 15)
        tracker.begin(id: "9", op: "input", budget: 1, at: start)
        XCTAssertEqual(tracker.takeOverdue(at: start.addingTimeInterval(5)), [])
        XCTAssertEqual(tracker.takeOverdue(at: start.addingTimeInterval(15)).map(\.id), ["9"])
    }

    func testReusingAnIdAfterItsRequestFinishedStartsACleanRequest() {
        let tracker = PendingRequestTracker(timeout: 15)
        tracker.begin(id: "1", op: "ping", at: start)
        XCTAssertEqual(tracker.takeOverdue(at: start.addingTimeInterval(30)).count, 1)
        tracker.finish(id: "1")
        tracker.begin(id: "1", op: "ping", at: start.addingTimeInterval(31))
        XCTAssertTrue(tracker.claim(id: "1"), "a new request with a recycled id owns its own reply")
    }

    func testOverdueRequestsComeBackInAStableOrder() {
        let tracker = PendingRequestTracker(timeout: 15)
        for id in ["c", "a", "b"] {
            tracker.begin(id: id, op: "observe", at: start)
        }
        XCTAssertEqual(tracker.takeOverdue(at: start.addingTimeInterval(16)).map(\.id), ["a", "b", "c"])
    }

    func testConcurrentClaimsHandOutExactlyOneReply() {
        let tracker = PendingRequestTracker(timeout: 15)
        tracker.begin(id: "race", op: "record.start", at: start)
        let winners = NSCounter()
        DispatchQueue.concurrentPerform(iterations: 64) { _ in
            if tracker.claim(id: "race") { winners.increment() }
        }
        XCTAssertEqual(winners.value, 1)
    }
}

/// A counter the concurrency test can increment from many queues at once.
private final class NSCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    func increment() {
        lock.lock()
        count += 1
        lock.unlock()
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return count
    }
}
