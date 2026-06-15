import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

/// The dictation Dynamic Island Live Activity, registered alongside the
/// workspace activity in `ADEWidgetBundle`.
///
/// Design goal: present the capture **horizontally** — a wide pill, never a
/// tall card. The compact leading/trailing regions form the collapsed island
/// pill (mic glyph + scrolling waveform + timer). The expanded presentation
/// keeps the same left-to-right flow across leading/center/trailing so a
/// long-press grows the pill in width and detail rather than stacking a tall
/// column. The bottom region is intentionally left empty.
///
/// The Done button is a `DictationDoneIntent` (a `LiveActivityIntent`) that
/// finalizes the active recording via the shared registry in the ADE app
/// process.
@available(iOS 17.0, *)
public struct DictationLiveActivity: Widget {
    public init() {}

    /// Recording red (#EF4444) — matches the in-app `RecordingPill` and the
    /// danger color used across the widget views.
    private static let recordRed = Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255)

    public var body: some WidgetConfiguration {
        ActivityConfiguration(for: DictationActivityAttributes.self) { ctx in
            DictationLockScreenView(state: ctx.state)
                .activityBackgroundTint(Color.black.opacity(0.55))
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { ctx in
            DynamicIsland {
                // Expanded — kept horizontal: mic on the leading edge, the live
                // waveform fills the wide center, timer + Done on the trailing
                // edge. No tall stacking.
                DynamicIslandExpandedRegion(.leading) {
                    DictationIslandMic()
                        .accessibilityLabel("Recording")
                }
                DynamicIslandExpandedRegion(.center) {
                    DictationIslandWaveform(levels: ctx.state.levels)
                        .frame(height: 24)
                        .accessibilityHidden(true)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    HStack(spacing: 10) {
                        DictationIslandTimer(state: ctx.state)
                        DictationIslandDoneButton(isFinishing: ctx.state.isFinishing)
                    }
                }
            } compactLeading: {
                // Fixed-frame mic so the collapsed pill never relayouts as the
                // content state updates.
                DictationIslandMic()
                    .frame(width: 16, alignment: .center)
                    .accessibilityLabel("Recording")
            } compactTrailing: {
                // A trimmed waveform + timer keeps the collapsed pill readable
                // and horizontal. Both have FIXED frames and the waveform draws
                // static bar heights (no per-update animation) so the island
                // stays a calm, fixed-width pill instead of bouncing at ~4fps.
                HStack(spacing: 6) {
                    DictationIslandWaveform(levels: ctx.state.levels.suffix(7).map { $0 })
                        .frame(width: 34, height: 16)
                        .accessibilityHidden(true)
                    DictationIslandTimer(state: ctx.state)
                        .frame(width: 38, alignment: .leading)
                }
            } minimal: {
                // Steady, fixed-size red record dot. No timer, no waveform, no
                // per-frame animation — when the workspace activity co-exists
                // the island demotes dictation to `minimal`, and anything that
                // resizes here reads as a "bouncing orb".
                DictationIslandRecordDot()
                    .accessibilityLabel("Recording \(ctx.state.timeString)")
            }
            .keylineTint(Self.recordRed)
        }
    }
}

// MARK: - Island pieces

@available(iOS 17.0, *)
private struct DictationIslandMic: View {
    private static let recordRed = Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255)
    var body: some View {
        Image(systemName: "mic.fill")
            .font(.system(size: 14, weight: .bold))
            .foregroundStyle(Self.recordRed)
    }
}

/// A clean, fixed-size filled red dot used in the `minimal` Dynamic Island
/// presentation. Deliberately static: it never resizes or animates so the
/// demoted island reads as a calm recording indicator, not a bouncing orb.
@available(iOS 17.0, *)
private struct DictationIslandRecordDot: View {
    private static let recordRed = Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255)
    var body: some View {
        Circle()
            .fill(Self.recordRed)
            .frame(width: 8, height: 8)
    }
}

@available(iOS 17.0, *)
private struct DictationIslandTimer: View {
    let state: DictationActivityAttributes.ContentState
    var body: some View {
        Text(state.timeString)
            .font(.system(.callout, design: .default).monospacedDigit().weight(.semibold))
            .foregroundStyle(.white)
            .accessibilityLabel("Elapsed \(state.timeString)")
    }
}

@available(iOS 17.0, *)
private struct DictationIslandWaveform: View {
    let levels: [Double]
    private static let recordRed = Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255)
    var body: some View {
        DictationWaveformBars(levels: levels, color: Self.recordRed.opacity(0.9))
    }
}

/// Interactive Done button. `isFinishing` swaps the checkmark for a spinner.
@available(iOS 17.0, *)
private struct DictationIslandDoneButton: View {
    let isFinishing: Bool
    var body: some View {
        Button(intent: DictationDoneIntent()) {
            ZStack {
                if isFinishing {
                    ProgressView()
                        .controlSize(.mini)
                        .tint(.black)
                } else {
                    Image(systemName: "checkmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(.black)
                }
            }
            .frame(width: 30, height: 30)
            .background(Circle().fill(.white))
        }
        .buttonStyle(.plain)
        .disabled(isFinishing)
        .accessibilityLabel(isFinishing ? "Finishing dictation" : "Insert dictated text")
    }
}

// MARK: - Lock screen / banner presentation

/// The banner shown on the Lock Screen and as the island's full presentation
/// fallback. Horizontal by construction: mic · waveform · timer · Done.
@available(iOS 17.0, *)
private struct DictationLockScreenView: View {
    let state: DictationActivityAttributes.ContentState
    private static let recordRed = Color(red: 239 / 255, green: 68 / 255, blue: 68 / 255)

    var body: some View {
        HStack(spacing: 12) {
            DictationIslandMic()
            Text(state.timeString)
                .font(.system(.callout, design: .default).monospacedDigit().weight(.semibold))
                .foregroundStyle(.white)
            DictationWaveformBars(levels: state.levels, color: Self.recordRed.opacity(0.9))
                .frame(maxWidth: .infinity)
                .frame(height: 22)
            DictationIslandDoneButton(isFinishing: state.isFinishing)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Recording, \(state.timeString)")
    }
}
