import ActivityKit
import AppIntents
import Foundation
import SwiftUI

/// Shared surface for the **dictation** Live Activity, compiled into BOTH the
/// main ADE app target and the ADEWidgets extension.
///
/// It carries three things that both processes need to agree on:
///   1. `DictationActivityAttributes` — the `ActivityAttributes` /
///      `ContentState` shape the app writes and the widget renders.
///   2. `DictationWaveformBars` — a dependency-light, pure-visual waveform the
///      composer pill and the Dynamic Island both draw, so the island and the
///      in-app pill look identical.
///   3. `DictationDoneIntent` / `DictationCancelIntent` — `LiveActivityIntent`s
///      whose buttons live in the island. They signal the in-process
///      `DictationActivityActionRegistry`, which the `DictationController`
///      installs at launch, so capture can be finalized from the island while
///      ADE continues recording under its background-audio mode.
///
/// Kept free of app-only symbols (e.g. `ADEColor`) so the widget target — which
/// does not link the app — compiles it cleanly. Colors are raw literals that
/// match the recording-red (#EF4444) used elsewhere in the widget views.

// MARK: - Activity attributes

/// Attributes + content for the dictation Dynamic Island Live Activity.
///
/// The activity is an **in-app navigation indicator**: it appears while the
/// user is recording and lets them leave the composer screen, watch the
/// waveform animate in the Dynamic Island, and tap Done from there. ADE keeps
/// the audio session alive under the app's background-audio mode while this
/// activity is visible.
public struct DictationActivityAttributes: ActivityAttributes {
    public struct ContentState: Codable, Hashable {
        /// Stylized waveform sample levels (each 0...1), newest pushed on the
        /// right. A small fixed-length window keeps payloads tiny so we stay
        /// within the ActivityKit update budget even at a few updates/sec.
        public var levels: [Double]
        /// Elapsed recording time in seconds. Rendered as a m:ss timer.
        public var elapsedTime: TimeInterval
        /// True once the user has tapped Done and the analyzer is finalizing —
        /// the island swaps the Done glyph for a spinner.
        public var isFinishing: Bool
        /// Monotonic-ish stamp so the newest activity content wins.
        public var generatedAt: Date

        public init(
            levels: [Double] = DictationActivityAttributes.idleLevels,
            elapsedTime: TimeInterval = 0,
            isFinishing: Bool = false,
            generatedAt: Date = Date()
        ) {
            self.levels = levels
            self.elapsedTime = elapsedTime
            self.isFinishing = isFinishing
            self.generatedAt = generatedAt
        }

        // Tolerant decoding so an older payload (missing a field) still renders.
        private enum CodingKeys: String, CodingKey {
            case levels, elapsedTime, isFinishing, generatedAt
        }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            self.levels = try c.decodeIfPresent([Double].self, forKey: .levels)
                ?? DictationActivityAttributes.idleLevels
            self.elapsedTime = try c.decodeIfPresent(TimeInterval.self, forKey: .elapsedTime) ?? 0
            self.isFinishing = try c.decodeIfPresent(Bool.self, forKey: .isFinishing) ?? false
            self.generatedAt = try c.decodeIfPresent(Date.self, forKey: .generatedAt) ?? Date()
        }

        /// Formatted m:ss timer string used by the island + lock screen.
        public var timeString: String {
            let total = Int(max(0, elapsedTime))
            return String(format: "%d:%02d", total / 60, total % 60)
        }
    }

    /// Stable identifier — only ever one dictation activity exists per device.
    public let sessionId: String

    public init(sessionId: String = "dictation") {
        self.sessionId = sessionId
    }

    /// Number of bars rendered in every waveform surface. Shared so the app's
    /// level buffer and the widget's renderer never disagree on width.
    public static let barCount = 14

    /// A flat resting waveform (used before the first level arrives and on the
    /// lock screen when no audio has been seen yet).
    public static let idleLevels: [Double] = Array(repeating: 0.08, count: barCount)
}

// MARK: - Pure-visual waveform (app + widget)

/// Dependency-light waveform shared by the composer pill and the Dynamic
/// Island. Draws a fixed ring of capsule bars whose heights come straight from
/// the passed-in `levels` (already a rolling window). It performs no animation
/// of its own — callers animate by feeding new `levels` — which keeps it cheap
/// enough for ActivityKit's render budget and avoids needing the app's
/// `@Environment(\.accessibilityReduceMotion)` plumbing inside the widget.
public struct DictationWaveformBars: View {
    private let levels: [Double]
    private let color: Color
    private let barSpacing: CGFloat
    private let minBarHeightFraction: Double

    public init(
        levels: [Double],
        color: Color,
        barSpacing: CGFloat = 3,
        minBarHeightFraction: Double = 0.08
    ) {
        self.levels = levels
        self.color = color
        self.barSpacing = barSpacing
        self.minBarHeightFraction = minBarHeightFraction
    }

    public var body: some View {
        GeometryReader { proxy in
            let count = max(levels.count, 1)
            let totalSpacing = barSpacing * CGFloat(count - 1)
            let barWidth = max(2, (proxy.size.width - totalSpacing) / CGFloat(count))
            HStack(alignment: .center, spacing: barSpacing) {
                ForEach(levels.indices, id: \.self) { index in
                    Capsule()
                        .fill(color)
                        .frame(
                            width: barWidth,
                            height: max(3, clampedLevel(levels[index]) * proxy.size.height)
                        )
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
        }
    }

    private func clampedLevel(_ raw: Double) -> CGFloat {
        CGFloat(min(1, max(minBarHeightFraction, raw)))
    }
}

// MARK: - In-process action registry

/// In-process sink the dictation Live Activity buttons signal. The
/// `DictationController` registers itself at launch; the widget process never
/// registers an implementation, so the intents become no-ops there (which is
/// correct — the buttons execute in the app process that owns the mic).
///
/// Deliberately separate from `ADEIntentCommandRegistry` (which forwards to the
/// desktop over sync): dictation finalize is a purely local action that must
/// stay inside the device's audio session.
@MainActor
public protocol DictationActivityActionHandler: AnyObject {
    /// Finalize the active recording (transcribe + insert/clipboard).
    func finishFromLiveActivity()
    /// Cancel the active recording without producing a transcript.
    func cancelFromLiveActivity()
}

@MainActor
public enum DictationActivityActionRegistry {
    public private(set) static weak var handler: DictationActivityActionHandler?

    public static func register(_ handler: DictationActivityActionHandler) {
        self.handler = handler
    }

    static func finish() { handler?.finishFromLiveActivity() }
    static func cancel() { handler?.cancelFromLiveActivity() }
}

// MARK: - Live Activity intents

/// Interactive "Done" button hosted in the Dynamic Island. Runs in the
/// app process and finalizes the recording through the registry.
/// `openAppWhenRun = false` keeps the user where they are — the activity simply
/// disappears once the controller ends it.
@available(iOS 17.0, *)
public struct DictationDoneIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Done"
    public static var description = IntentDescription(
        "Finish the current ADE dictation and insert the transcribed text."
    )
    public static var openAppWhenRun: Bool = false

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult {
        DictationActivityActionRegistry.finish()
        return .result()
    }
}

/// Interactive "Cancel" button hosted in the expanded island, discarding the
/// recording without inserting anything.
@available(iOS 17.0, *)
public struct DictationCancelIntent: LiveActivityIntent {
    public static var title: LocalizedStringResource = "Cancel"
    public static var description = IntentDescription(
        "Cancel the current ADE dictation without inserting any text."
    )
    public static var openAppWhenRun: Bool = false

    public init() {}

    @MainActor
    public func perform() async throws -> some IntentResult {
        DictationActivityActionRegistry.cancel()
        return .result()
    }
}
