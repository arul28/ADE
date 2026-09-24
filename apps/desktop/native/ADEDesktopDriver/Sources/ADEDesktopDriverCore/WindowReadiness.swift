/// How long to keep asking whether a brand-new window is drivable yet.
///
/// A window exists in `CGWindowListCopyWindowInfo` before its application has
/// finished publishing it to the Accessibility API. The gap is small — a few
/// hundred milliseconds when TextEdit opens a new document — but the pid watcher
/// is looking exactly then, so the naive read is "this window has no AX element"
/// and the naive conclusion is "Accessibility is not granted". Both are wrong,
/// and the second one is the expensive kind of wrong: it sends the user to
/// System Settings to fix a permission that was never the problem.
///
/// So the lookup retries on a backoff before it gives up, and the giving-up
/// answer distinguishes *not trusted* from *not ready yet*. Only the first is a
/// permission fault; the second leaves the window in the watch list for the next
/// poll, because an app that is slow to publish a window will publish it.
///
/// The schedule lives in Core, with no AppKit anywhere near it, so the thing
/// that actually has to be right — that it backs off, that it is bounded, and
/// that the bound is about a second and a half rather than forever — is testable
/// without a window server.

import Foundation

public enum WindowReadiness {
    /// Milliseconds to wait before each retry, after the first failed attempt.
    ///
    /// Doubling from 50 ms: the first retry catches the common case almost
    /// immediately, and the tail is long enough for a heavy app without making a
    /// genuinely un-parkable window block the sweep for a noticeable time.
    public static let backoffMs: [Int] = [50, 100, 200, 400, 800]

    /// Total time spent retrying before the answer is "not ready".
    public static var totalBackoffMs: Int { backoffMs.reduce(0, +) }

    /// Attempts made in total, counting the first one that is not preceded by a
    /// wait.
    public static var attemptCount: Int { backoffMs.count + 1 }

    /// How long to wait before attempt `attempt` (zero-based), or nil when the
    /// schedule is spent and the caller should stop.
    ///
    /// Attempt 0 is immediate: the overwhelming majority of windows are ready
    /// the first time they are looked at, and a sleep before the first try would
    /// tax every single park to pay for the rare one.
    public static func delaySeconds(beforeAttempt attempt: Int) -> TimeInterval? {
        guard attempt >= 0 else { return nil }
        if attempt == 0 { return 0 }
        let index = attempt - 1
        guard index < backoffMs.count else { return nil }
        return TimeInterval(backoffMs[index]) / 1000.0
    }
}

/// Why a window could not be driven, once the retries are spent.
///
/// Two outcomes that look identical at the call site and must not be reported
/// identically: one is a grant the user has to give, the other is time the app
/// has to take.
public enum WindowReadinessFailure: Error, Equatable, Sendable {
    /// The process is not trusted for Accessibility. A real permission fault.
    case notTrusted
    /// Accessibility is granted; this window has simply not published an
    /// element yet. Retried on the next poll, never surfaced as a permission
    /// problem.
    case notReady

    /// Decides between the two from the one fact that separates them.
    public static func classify(isProcessTrusted: Bool) -> WindowReadinessFailure {
        isProcessTrusted ? .notReady : .notTrusted
    }

    public func driverError(windowId: Int) -> DriverError {
        switch self {
        case .notTrusted:
            return DriverError(
                code: DriverErrorCode.permissionRequired,
                message: "ADE is not trusted for Accessibility, so window \(windowId) cannot be moved. "
                    + "Grant Accessibility to ADE in System Settings."
            )
        case .notReady:
            return DriverError(
                code: DriverErrorCode.windowNotReady,
                message: "Window \(windowId) has not published an accessibility element yet. "
                    + "It stays on the watch list and is retried."
            )
        }
    }
}
