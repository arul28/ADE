import Foundation

/// The pure half of the `input {command:"wait"}` op.
///
/// Waiting is the one input command that is not an action: it polls until the
/// screen says something, or until it gives up. The polling itself needs the
/// Accessibility API and a real clock, but *what counts as satisfied* does not,
/// so it lives here where it can be tested without a display.
///
/// The service sends all three selectors on every call with the unused ones as
/// `null` (`apps/desktop/src/main/services/macDesktop/macDesktopService.ts`,
/// `wait`), so the decoder has to pick one rather than reject the shape. The
/// order below is the order of specificity, not of preference: `text` names an
/// element that must appear, `gone` names one that must go, and `windowTitle`
/// is the coarse fallback for a window that has not been walked yet.
public struct WaitCondition: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        /// An element matching this text must exist.
        case appears(String)
        /// No element matching this text may exist.
        case disappears(String)
        /// A parked window whose title contains this text must exist.
        case windowTitle(String)
    }

    /// Matches `DEFAULT_WAIT_TIMEOUT_MS` in `macDesktopService.ts`.
    public static let defaultTimeoutMs = 10_000
    /// Matches `MAX_WAIT_TIMEOUT_MS` in `macDesktopService.ts`.
    public static let maxTimeoutMs = 120_000
    /// How often the driver re-reads the tree. Cheap enough to be responsive,
    /// slow enough that a 2-minute wait is not 24,000 accessibility walks.
    public static let pollIntervalMs = 250

    public let kind: Kind
    public let timeoutMs: Int

    /// Nil when no selector was given — the caller turns that into an
    /// `invalid_argument` rather than waiting forever on nothing.
    public init?(text: String?, gone: String?, windowTitle: String?, timeoutMs: Int?) {
        let clamped = max(0, min(WaitCondition.maxTimeoutMs, timeoutMs ?? WaitCondition.defaultTimeoutMs))
        self.timeoutMs = clamped
        if let value = WaitCondition.trimmed(text) {
            self.kind = .appears(value)
        } else if let value = WaitCondition.trimmed(gone) {
            self.kind = .disappears(value)
        } else if let value = WaitCondition.trimmed(windowTitle) {
            self.kind = .windowTitle(value)
        } else {
            return nil
        }
    }

    /// The needle an element walk should test against, or nil when this
    /// condition never looks at elements.
    public var elementNeedle: String? {
        switch kind {
        case let .appears(value): return value
        case let .disappears(value): return value
        case .windowTitle: return nil
        }
    }

    /// One poll's verdict.
    ///
    /// `matchedIndex` is the index of the first element matching
    /// `elementNeedle`, or nil when none did. `windowTitles` is every parked
    /// window's title this tick.
    public func outcome(matchedIndex: Int?, windowTitles: [String]) -> WaitOutcome {
        switch kind {
        case .appears:
            guard let matchedIndex else { return .pending }
            return .met(index: matchedIndex)
        case .disappears:
            return matchedIndex == nil ? .met(index: nil) : .pending
        case let .windowTitle(needle):
            let lowered = needle.lowercased()
            let hit = windowTitles.contains { $0.lowercased().contains(lowered) }
            return hit ? .met(index: nil) : .pending
        }
    }

    /// How long the next poll should pause for, or nil when the wait is over.
    ///
    /// Pulled out of the polling loop because it is the one part of waiting that
    /// is arithmetic rather than accessibility, and because the driver does not
    /// *sleep* this interval — it pumps the main run loop for it, so every other
    /// lane's request and the health `ping` are still answered while one lane
    /// waits two minutes for a button. A sleep on the main thread would starve
    /// them, and a negative or over-long pause would either spin or overshoot
    /// the deadline, so the clamp lives here where it can be tested.
    public static func pollDelaySeconds(now: Date, deadline: Date) -> Double? {
        let remaining = deadline.timeIntervalSince(now)
        guard remaining > 0 else { return nil }
        return min(Double(pollIntervalMs) / 1000, remaining)
    }

    private static func trimmed(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}

public enum WaitOutcome: Equatable, Sendable {
    case pending
    /// Satisfied. `index` is the matched element when there was one — a `gone`
    /// or `windowTitle` wait succeeds with no element, which is why `ok` and
    /// "there is an index" are two different answers on the wire.
    case met(index: Int?)
}
