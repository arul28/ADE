/// How long since a human last touched this Mac.
///
/// The service uses it for two decisions that both need the same number: the
/// stream's idle rate, and whether it is safe to assume the user is not at the
/// keyboard. `.combinedSessionState` counts real HID input *and* synthetic
/// events posted into the session, which is what makes this a measure of "is
/// anything happening" rather than only "is a hand on the trackpad".

import CoreGraphics
import Foundation

enum PhysicalInput {
    /// Seconds since the last input event of any kind.
    static func secondsSinceLastEvent() -> Double {
        let types: [CGEventType] = [
            .mouseMoved,
            .leftMouseDown,
            .rightMouseDown,
            .keyDown,
            .scrollWheel,
            .flagsChanged,
        ]
        return types
            .map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }
            .min() ?? 0
    }
}
