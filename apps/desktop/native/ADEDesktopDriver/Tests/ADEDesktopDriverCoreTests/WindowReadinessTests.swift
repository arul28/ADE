import XCTest
@testable import ADEDesktopDriverCore

/// The readiness race, unit-tested.
///
/// The bug these cover: a window that exists in the CoreGraphics list before its
/// app has published an accessibility element was reported as
/// `MAC_DESKTOP_PERMISSION_REQUIRED`, sending the user to System Settings to fix
/// a grant that was never missing.
final class WindowReadinessTests: XCTestCase {
    func testFirstAttemptIsImmediate() {
        // Every park pays this schedule; a wait before the first try would tax
        // the common case to pay for the rare one.
        XCTAssertEqual(WindowReadiness.delaySeconds(beforeAttempt: 0), 0)
    }

    func testScheduleBacksOffAndIsBounded() {
        let delays = (0..<WindowReadiness.attemptCount).compactMap {
            WindowReadiness.delaySeconds(beforeAttempt: $0)
        }
        XCTAssertEqual(delays.count, WindowReadiness.attemptCount)
        let expected: [TimeInterval] = [0, 0.05, 0.1, 0.2, 0.4, 0.8]
        XCTAssertEqual(delays, expected)
        for (earlier, later) in zip(delays.dropFirst(), delays.dropFirst(2)) {
            XCTAssertGreaterThan(later, earlier, "The schedule must back off, not repeat")
        }
    }

    func testScheduleEndsSoTheSweepCannotBlockForever() {
        XCTAssertNil(WindowReadiness.delaySeconds(beforeAttempt: WindowReadiness.attemptCount))
        XCTAssertNil(WindowReadiness.delaySeconds(beforeAttempt: 99))
        XCTAssertNil(WindowReadiness.delaySeconds(beforeAttempt: -1))
    }

    func testTotalBackoffIsAboutASecondAndAHalf() {
        XCTAssertEqual(WindowReadiness.totalBackoffMs, 1_550)
        XCTAssertGreaterThanOrEqual(WindowReadiness.totalBackoffMs, 1_000)
        XCTAssertLessThanOrEqual(WindowReadiness.totalBackoffMs, 3_000)
    }

    func testATrustedProcessMeansNotReadyRatherThanNotPermitted() {
        XCTAssertEqual(WindowReadinessFailure.classify(isProcessTrusted: true), .notReady)
        let error = WindowReadinessFailure.notReady.driverError(windowId: 27_254)
        XCTAssertEqual(error.code, DriverErrorCode.windowNotReady)
        XCTAssertNotEqual(error.code, DriverErrorCode.permissionRequired)
        XCTAssertTrue(error.message.contains("27254"))
        XCTAssertTrue(error.message.contains("retried"))
        // The message must not send anybody to System Settings.
        XCTAssertFalse(error.message.contains("System Settings"))
    }

    func testAnUntrustedProcessIsStillARealPermissionFault() {
        XCTAssertEqual(WindowReadinessFailure.classify(isProcessTrusted: false), .notTrusted)
        let error = WindowReadinessFailure.notTrusted.driverError(windowId: 12)
        XCTAssertEqual(error.code, DriverErrorCode.permissionRequired)
        XCTAssertTrue(error.message.contains("System Settings"))
    }

    func testTheTwoFailuresNeverShareACode() {
        XCTAssertNotEqual(
            WindowReadinessFailure.notReady.driverError(windowId: 1).code,
            WindowReadinessFailure.notTrusted.driverError(windowId: 1).code
        )
    }
}
