import SwiftUI

/// Animated gradient border mirroring the desktop `BorderBeam` component.
///
/// Paints a rotating conic gradient around the stroke of a rounded rectangle.
/// Respects reduce-motion by freezing the rotation at a neutral angle and
/// dims the stroke instead.
enum ADEBorderBeamVariant {
  /// Two-stop purple glow — for dialogs/sheets, the "mono" desktop preset.
  case mono
  /// Blue → purple → teal sweep — used on the composer during an active turn.
  case ocean
  /// Rainbow sweep (purple, blue, green, pink, amber) — idle composer / welcome state.
  case colorful
  /// Provider-branded sweep: the provider's brand color blended with complements.
  case provider(String)

  func colors() -> [Color] {
    switch self {
    case .mono:
      return [
        ADEColor.purpleAccent.opacity(0.0),
        ADEColor.purpleAccent.opacity(0.9),
        ADEColor.purpleAccent.opacity(0.35),
        ADEColor.purpleAccent.opacity(0.0),
      ]
    case .ocean:
      return [
        Color(red: 0.16, green: 0.55, blue: 0.98).opacity(0.0),
        Color(red: 0.16, green: 0.55, blue: 0.98).opacity(0.9),
        Color(red: 0.46, green: 0.29, blue: 0.95).opacity(0.85),
        Color(red: 0.09, green: 0.78, blue: 0.75).opacity(0.85),
        Color(red: 0.16, green: 0.55, blue: 0.98).opacity(0.0),
      ]
    case .colorful:
      return [
        Color(red: 0.65, green: 0.33, blue: 0.97).opacity(0.0),
        Color(red: 0.65, green: 0.33, blue: 0.97).opacity(0.95),
        Color(red: 0.24, green: 0.60, blue: 0.98).opacity(0.9),
        Color(red: 0.20, green: 0.83, blue: 0.60).opacity(0.9),
        Color(red: 0.97, green: 0.42, blue: 0.64).opacity(0.9),
        Color(red: 0.98, green: 0.72, blue: 0.20).opacity(0.95),
        Color(red: 0.65, green: 0.33, blue: 0.97).opacity(0.0),
      ]
    case .provider(let name):
      let base = ADEColor.providerBrand(for: name)
      return [
        base.opacity(0.0),
        base.opacity(0.95),
        base.opacity(0.55),
        ADEColor.purpleAccent.opacity(0.55),
        base.opacity(0.0),
      ]
    }
  }
}

/// Wraps content in an animated gradient border. Pass `active: false` to
/// render the stroke without the rotating animation (still visible, just
/// static) — useful for a subtle resting state.
struct ADEBorderBeam<Content: View>: View {
  let cornerRadius: CGFloat
  let duration: Double
  let strength: Double
  let lineWidth: CGFloat
  let variant: ADEBorderBeamVariant
  let active: Bool
  let content: () -> Content

  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  init(
    cornerRadius: CGFloat = 20,
    duration: Double = 14,
    strength: Double = 0.55,
    lineWidth: CGFloat = 1.25,
    variant: ADEBorderBeamVariant = .colorful,
    active: Bool = true,
    @ViewBuilder content: @escaping () -> Content
  ) {
    self.cornerRadius = cornerRadius
    self.duration = duration
    self.strength = strength
    self.lineWidth = lineWidth
    self.variant = variant
    self.active = active
    self.content = content
  }

  var body: some View {
    content()
      .overlay(borderOverlay)
      .allowsHitTesting(true)
  }

  @ViewBuilder
  private var borderOverlay: some View {
    let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
    if active && !reduceMotion {
      // 30fps is perceptually smooth for a rotating gradient and halves the
      // CPU work vs 60fps. TimelineView pauses automatically when the host
      // view is off-screen, so scrolled-away beams don't keep ticking.
      TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: false)) { ctx in
        let angle = rotationAngle(at: ctx.date)
        shape
          .strokeBorder(
            AngularGradient(
              gradient: Gradient(colors: variant.colors()),
              center: .center,
              angle: .degrees(angle)
            ),
            lineWidth: lineWidth
          )
          .opacity(strength + 0.25)
          .blendMode(.plusLighter)
          .allowsHitTesting(false)
      }
    } else {
      shape
        .strokeBorder(
          AngularGradient(
            gradient: Gradient(colors: variant.colors()),
            center: .center,
            angle: .degrees(0)
          ),
          lineWidth: lineWidth
        )
        .opacity(strength * 0.7)
        .allowsHitTesting(false)
    }
  }

  private func rotationAngle(at date: Date) -> Double {
    let seconds = date.timeIntervalSinceReferenceDate
    let period = max(duration, 1)
    let fraction = seconds.truncatingRemainder(dividingBy: period) / period
    return fraction * 360
  }
}

extension View {
  func adeBorderBeam(
    cornerRadius: CGFloat = 20,
    duration: Double = 14,
    strength: Double = 0.55,
    lineWidth: CGFloat = 1.25,
    variant: ADEBorderBeamVariant = .colorful,
    active: Bool = true
  ) -> some View {
    ADEBorderBeam(
      cornerRadius: cornerRadius,
      duration: duration,
      strength: strength,
      lineWidth: lineWidth,
      variant: variant,
      active: active
    ) {
      self
    }
  }
}
