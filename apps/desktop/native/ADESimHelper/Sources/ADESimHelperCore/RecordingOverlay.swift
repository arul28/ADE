import Foundation
import CoreGraphics

/// The overlay timeline for a recording, as pure value types.
///
/// Everything here is deliberately free of AVFoundation, CoreVideo and the
/// capture engine: the part of the overlay feature that is easy to get subtly
/// wrong is *when* a decoration is visible and *how big* it is at a given
/// instant, and that part has to be testable without a booted simulator.
/// `RecordingSession` owns the pixels; this file owns the arithmetic.
///
/// Shape borrowed from t3code #12779 ("fix(desktop): align preview recording
/// cursors and show input feedback"): a ring in the theme's primary colour at
/// the press point, plus a key/text badge, composited into the **saved
/// recording only** — never into the live stream a human is watching.
public enum RecordingOverlay {
    /// How long a tap ring lives. ~400 ms is long enough to read in a scrubbed
    /// recording and short enough that a fast tap sequence does not smear into
    /// one blob.
    public static let tapRingDuration: TimeInterval = 0.4
    /// How long a typed-text badge stays up after the last keystroke.
    public static let textBadgeDuration: TimeInterval = 1.5

    /// The ring's radius as a fraction of the frame's smaller side, at both
    /// ends of its life.
    public static let ringMinRadiusFraction: Double = 0.022
    public static let ringMaxRadiusFraction: Double = 0.072

    /// Normalised progress through an effect: 0 at its start, 1 at its end.
    ///
    /// Clamped rather than wrapped — a tap that is already over stays over, and
    /// a negative age (clock skew between the input command and the frame
    /// clock) reads as "just happened" rather than "nearly finished".
    public static func progress(age: TimeInterval, duration: TimeInterval) -> Double {
        guard duration > 0 else { return 1 }
        return min(max(age / duration, 0), 1)
    }

    /// `1 - (1 - p)^3`: fast at first, settling at the end. The ring should read
    /// as an impact, so most of the growth happens in the first third.
    public static func easeOutCubic(_ progress: Double) -> Double {
        let p = min(max(progress, 0), 1)
        let inverse = 1 - p
        return 1 - inverse * inverse * inverse
    }

    /// Ring radius in pixels for a frame of this size.
    public static func ringRadius(progress: Double, frameShortSide: Double) -> Double {
        let minRadius = frameShortSide * ringMinRadiusFraction
        let maxRadius = frameShortSide * ringMaxRadiusFraction
        return minRadius + (maxRadius - minRadius) * easeOutCubic(progress)
    }

    /// Ring alpha. Fades superlinearly so the ring is clearly gone before the
    /// next tap in a double-tap arrives.
    public static func ringOpacity(progress: Double) -> Double {
        let p = min(max(progress, 0), 1)
        let remaining = 1 - p
        return remaining * remaining
    }

    /// Alpha of the solid dot at the ring's centre. Shorter-lived than the ring
    /// so the expanding circle is what the eye follows.
    public static func dotOpacity(progress: Double) -> Double {
        let p = min(max(progress, 0), 1)
        guard p < 0.5 else { return 0 }
        return 1 - (p / 0.5)
    }

    /// Alpha of the typed-text pill: held at full for most of its life, then a
    /// short fade. A badge that fades the whole time reads as a rendering bug.
    public static func badgeOpacity(progress: Double) -> Double {
        let p = min(max(progress, 0), 1)
        let holdUntil = 0.8
        guard p > holdUntil else { return 1 }
        return (1 - p) / (1 - holdUntil)
    }

    /// One tap decoration, in the frame's own pixel coordinates.
    public struct TapRing: Equatable, Sendable {
        /// Fraction of the frame width, 0..1 — resolved to pixels at draw time
        /// so a recording is unaffected by a mid-session resolution change.
        public var x: Double
        public var y: Double
        public var startedAt: TimeInterval

        public init(x: Double, y: Double, startedAt: TimeInterval) {
            self.x = x
            self.y = y
            self.startedAt = startedAt
        }
    }

    /// One typed-text decoration.
    public struct TextBadge: Equatable, Sendable {
        public var text: String
        public var startedAt: TimeInterval

        public init(text: String, startedAt: TimeInterval) {
            self.text = text
            self.startedAt = startedAt
        }
    }

    /// The set of decorations alive at a given instant.
    ///
    /// A struct, not an actor: the session mutates it under its own isolation,
    /// and tests drive it directly.
    public struct Timeline: Equatable, Sendable {
        public private(set) var rings: [TapRing] = []
        public private(set) var badge: TextBadge?

        /// A ring sequence longer than this is a drag that arrived as taps;
        /// keeping every one of them would paint the whole screen.
        public static let maxRings = 12

        public init() {}

        public mutating func addTap(x: Double, y: Double, at time: TimeInterval) {
            rings.append(TapRing(x: x, y: y, startedAt: time))
            if rings.count > Self.maxRings {
                rings.removeFirst(rings.count - Self.maxRings)
            }
        }

        /// Replace the badge. Empty text clears it — that is how a caller says
        /// "the field was cleared" without inventing a second command.
        public mutating func setText(_ text: String, at time: TimeInterval) {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else {
                badge = nil
                return
            }
            badge = TextBadge(text: trimmed, startedAt: time)
        }

        /// Drop everything whose life is over. Called once per composited frame
        /// so the drawing loop never walks a list of dead decorations.
        public mutating func prune(at time: TimeInterval) {
            rings.removeAll { time - $0.startedAt >= RecordingOverlay.tapRingDuration }
            if let badge, time - badge.startedAt >= RecordingOverlay.textBadgeDuration {
                self.badge = nil
            }
        }

        public var isEmpty: Bool { rings.isEmpty && badge == nil }
    }

    /// A colour for the ring, parsed from what ADE passes on `record-start`.
    public struct Colour: Equatable, Sendable {
        public var red: Double
        public var green: Double
        public var blue: Double

        public init(red: Double, green: Double, blue: Double) {
            self.red = red
            self.green = green
            self.blue = blue
        }
    }

    /// ADE's default accent, used when `record-start` omits `accentColor` or
    /// sends something unparseable. Deliberately a real colour rather than a
    /// failure: a recording with the wrong ring tint is useful, one that
    /// refuses to start is not.
    public static let defaultAccent = Colour(red: 0.35, green: 0.56, blue: 0.98)

    /// Parse `#RGB`, `#RRGGBB` or `#RRGGBBAA` (alpha ignored — the timeline
    /// owns alpha). Returns nil rather than a default so the caller can log
    /// that it substituted one.
    public static func parseColour(_ raw: String?) -> Colour? {
        guard var text = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !text.isEmpty else {
            return nil
        }
        if text.hasPrefix("#") { text.removeFirst() }
        guard text.allSatisfy({ $0.isHexDigit }) else { return nil }

        func component(_ slice: Substring) -> Double? {
            guard let value = UInt8(slice, radix: 16) else { return nil }
            return Double(value) / 255
        }

        switch text.count {
        case 3:
            // #abc expands to #aabbcc, as in CSS.
            let chars = Array(text)
            let expanded = String([chars[0], chars[0], chars[1], chars[1], chars[2], chars[2]])
            return parseColour("#" + expanded)
        case 6, 8:
            let chars = Array(text)
            guard
                let r = component(Substring(String(chars[0...1]))),
                let g = component(Substring(String(chars[2...3]))),
                let b = component(Substring(String(chars[4...5])))
            else { return nil }
            return Colour(red: r, green: g, blue: b)
        default:
            return nil
        }
    }

    /// What the badge shows for a typed string.
    ///
    /// Truncation is from the **front**: the interesting part of a long typed
    /// value is what was typed most recently, which is what a reviewer is
    /// watching the cursor produce.
    public static func badgeText(for text: String, limit: Int = 48) -> String {
        let collapsed = text
            .replacingOccurrences(of: "\n", with: "⏎")
            .replacingOccurrences(of: "\t", with: "⇥")
        guard collapsed.count > limit else { return collapsed }
        return "…" + String(collapsed.suffix(limit))
    }
}
