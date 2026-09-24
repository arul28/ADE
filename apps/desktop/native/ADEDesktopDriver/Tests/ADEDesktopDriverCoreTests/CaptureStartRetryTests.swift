import XCTest
@testable import ADEDesktopDriverCore
@testable import ADEDesktopDriver

/// Which ScreenCaptureKit refusals are worth asking again about.
///
/// The case this exists for: a `record.start` issued within a few seconds of
/// `app.launch` is refused with `-3805`, "application connection being
/// interrupted", every time — the window server is still rebuilding the
/// connection the new process made. It is transient, so it is retried; a
/// declined permission is not, so it is not.
final class CaptureStartRetryTests: XCTestCase {
    private func scError(_ code: Int) -> Error {
        NSError(domain: "com.apple.ScreenCaptureKit.SCStreamErrorDomain", code: code)
    }

    func testAnInterruptedApplicationConnectionIsRetried() {
        XCTAssertTrue(CaptureEngine.isRetryableStartFailure(scError(-3805)))
    }

    func testUnavailableContentIsRetried() {
        for code in [-3802, -3804, -3806, -3813, -3814, -3815] {
            XCTAssertTrue(
                CaptureEngine.isRetryableStartFailure(scError(code)),
                "SCStreamError \(code) describes a world that is not ready yet"
            )
        }
    }

    func testAPermanentRefusalIsNotRetried() {
        // userDeclined and missingEntitlements are answers, not races: retrying
        // them only delays a message the user has to read.
        XCTAssertFalse(CaptureEngine.isRetryableStartFailure(scError(-3801)))
        XCTAssertFalse(CaptureEngine.isRetryableStartFailure(scError(-3803)))
    }

    func testTheDriversOwnTimeoutIsRetried() {
        XCTAssertTrue(
            CaptureEngine.isRetryableStartFailure(
                CaptureError.failed("ScreenCaptureKit did not answer the record.start start request.")
            )
        )
    }

    func testAMissingCaptureSurfaceIsRetried() {
        // A virtual display is often absent from SCShareableContent for a beat
        // after it is created.
        XCTAssertTrue(CaptureEngine.isRetryableStartFailure(CaptureError.noSurface("No content for display 7.")))
    }

    func testTheBackoffScheduleStaysInsideItsBudget() {
        XCTAssertEqual(CaptureEngine.startBackoffs, [0.25, 0.5, 1.0, 2.0])
        XCTAssertEqual(CaptureEngine.startBackoffs.reduce(0, +), 3.75, accuracy: 0.001)
    }
}
