import SwiftUI

/// Inline recording pill shown in place of the composer's trailing controls
/// while dictation is active. Renders a live timer, a real-amplitude waveform
/// driven by the dictation service's `audioLevel`, and cancel (✕) / done (✓)
/// controls. Sized to occupy the trailing cluster so swapping it in for the
/// idle mic + send buttons does not jump the composer layout.
struct RecordingPill: View {
  /// Elapsed recording time in seconds.
  let elapsedTime: TimeInterval
  /// Current normalized input amplitude (0...1).
  let audioLevel: Float
  /// True while the analyzer is finalizing after the user taps done.
  let isFinishing: Bool
  let onCancel: () -> Void
  let onDone: () -> Void
  var opaque = false

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    HStack(spacing: 10) {
      Text(timeString)
        .font(.callout.monospacedDigit().weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .accessibilityHidden(true)

      DictationWaveform(level: audioLevel, reduceMotion: reduceMotion)
        .frame(maxWidth: .infinity)
        .accessibilityHidden(true)

      Button(action: onCancel) {
        Image(systemName: "xmark")
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 28, height: 28)
          .background(Circle().fill(ADEColor.surfaceBackground.opacity(0.9)))
          .overlay(Circle().stroke(ADEColor.border.opacity(0.35), lineWidth: 0.8))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Cancel dictation")

      Button(action: onDone) {
        ZStack {
          if isFinishing {
            ProgressView()
              .controlSize(.mini)
              .tint(Color(red: 0.12, green: 0.12, blue: 0.14))
          } else {
            Image(systemName: "checkmark")
              .font(.system(size: 14, weight: .bold))
          }
        }
        .frame(width: 28, height: 28)
        .foregroundStyle(Color(red: 0.12, green: 0.12, blue: 0.14))
        .background(Circle().fill(Color.white.opacity(0.9)))
      }
      .buttonStyle(.plain)
      .disabled(isFinishing)
      .accessibilityLabel(isFinishing ? "Finishing dictation" : "Insert dictated text")
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(
      ZStack {
        if opaque {
          Capsule(style: .continuous)
            .fill(ADEColor.surfaceBackground)
        }
        Capsule(style: .continuous)
          .fill(ADEColor.danger.opacity(0.08))
      }
    )
    .overlay(
      Capsule(style: .continuous)
        .stroke(ADEColor.danger.opacity(0.25), lineWidth: 1)
    )
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Recording, \(accessibilityTime)")
  }

  private var timeString: String {
    let total = Int(elapsedTime)
    return String(format: "%d:%02d", total / 60, total % 60)
  }

  private var accessibilityTime: String {
    let total = Int(elapsedTime)
    let minutes = total / 60
    let seconds = total % 60
    if minutes > 0 {
      return "\(minutes) minute\(minutes == 1 ? "" : "s") \(seconds) second\(seconds == 1 ? "" : "s")"
    }
    return "\(seconds) second\(seconds == 1 ? "" : "s")"
  }
}

/// Real-amplitude waveform: a fixed ring of bars whose heights track the live
/// audio level. Unlike the old `onChange(of: level)` version — whose smoothness
/// was bound to how often `audioLevel` happened to change — this drives off a
/// steady `TimelineView(.animation)` tick (matching desktop's
/// requestAnimationFrame loop). On every frame it samples the CURRENT level,
/// shifts the rolling window on a ~30fps cadence, and eases each bar height
/// toward its target, so scrolling stays smooth regardless of the publish rate.
/// Honors Reduce Motion by snapping bar heights and skipping the timeline.
private struct DictationWaveform: View {
  let level: Float
  let reduceMotion: Bool

  private static let barCount = 28
  /// How often a new sample is shifted into the rolling window (~30Hz).
  private static let shiftInterval: TimeInterval = 1.0 / 30.0
  /// Per-frame easing factor for interpolating displayed heights toward target.
  private static let easing: CGFloat = 0.35

  /// Target heights — the rolling window the meter scrolls. Updated on the
  /// shift cadence from the current `level`.
  @State private var targets: [CGFloat] = Array(repeating: 0.08, count: DictationWaveform.barCount)
  /// Displayed heights — eased toward `targets` every frame for smoothness.
  @State private var displayed: [CGFloat] = Array(repeating: 0.08, count: DictationWaveform.barCount)
  @State private var lastShift: TimeInterval = 0

  var body: some View {
    Group {
      if reduceMotion {
        // No timeline: snap displayed bars to the latest level on each change.
        bars(displayed)
          .onChange(of: level) { _, newValue in
            shiftWindow(with: clamp(newValue))
            displayed = targets
          }
      } else {
        TimelineView(.animation) { timeline in
          bars(displayed)
            .onChange(of: timeline.date) { _, date in
              advance(at: date.timeIntervalSinceReferenceDate)
            }
        }
      }
    }
  }

  /// Width-filling bar meter drawn with `Canvas`. Canvas draws into the size it
  /// is OFFERED — it never measures its content and pushes a size back up — so it
  /// fills the space between the timer and the buttons WITHOUT the GeometryReader
  /// measure-feedback loop that made the pill visibly oscillate ("bouncing orb").
  private func bars(_ heights: [CGFloat]) -> some View {
    Canvas { context, size in
      let n = heights.count
      let spacing: CGFloat = 2.5
      let barWidth = max(1.5, (size.width - spacing * CGFloat(n - 1)) / CGFloat(n))
      for index in 0..<n {
        let barHeight = max(2, heights[index] * size.height)
        let x = CGFloat(index) * (barWidth + spacing)
        let rect = CGRect(x: x, y: (size.height - barHeight) / 2, width: barWidth, height: barHeight)
        context.fill(
          Path(roundedRect: rect, cornerRadius: barWidth / 2),
          with: .color(ADEColor.danger.opacity(0.85))
        )
      }
    }
    .frame(height: 22)
  }

  /// One animation frame: on the shift cadence, push the current level into the
  /// rolling window; every frame, ease the displayed heights toward the targets.
  private func advance(at now: TimeInterval) {
    if now - lastShift >= Self.shiftInterval {
      lastShift = now
      shiftWindow(with: clamp(level))
    }
    var next = displayed
    var changed = false
    for index in next.indices {
      let delta = targets[index] - next[index]
      if abs(delta) > 0.001 {
        next[index] += delta * Self.easing
        changed = true
      } else if next[index] != targets[index] {
        next[index] = targets[index]
        changed = true
      }
    }
    if changed { displayed = next }
  }

  private func shiftWindow(with value: CGFloat) {
    var next = targets
    next.removeFirst()
    next.append(value)
    targets = next
  }

  private func clamp(_ value: Float) -> CGFloat {
    CGFloat(max(0.08, min(1, value)))
  }
}
