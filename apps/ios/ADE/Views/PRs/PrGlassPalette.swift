import SwiftUI
import UIKit

// MARK: - PR surface style primitives
//
// Shared across the PR Detail surfaces (Screen, Overview, Checks, Merge gate).
// These are pure presentational helpers — they add no state, no behaviour.
//
// Design contract (desktop parity): the PRs tab mirrors the desktop PR detail
// tokens — `--pr-surface` rgb(15,16,16), `--pr-thread-card` rgb(23,23,24),
// `--pr-panel-card` rgb(24,23,43) in dark mode — with light-mode values drawn
// from the app-wide `ADEColor` adaptive system. Cards are FLAT fills with a
// hairline border and a cheap shadow: no live materials, no blend modes, no
// blur layers. Those were the primary scroll-perf cost inside PR detail.

private func prAdaptive(light: UIColor, dark: UIColor) -> Color {
  Color(UIColor { traits in traits.userInterfaceStyle == .dark ? dark : light })
}

private func prRgb(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ alpha: CGFloat = 1) -> UIColor {
  UIColor(red: r / 255, green: g / 255, blue: b / 255, alpha: alpha)
}

/// Canonical adaptive palette for the PRs surfaces. Legacy names (`ink`,
/// `purple*`, …) are kept so existing call sites keep compiling; they now map
/// onto theme-aware tokens instead of fixed dark-mode RGB values.
enum PrGlassPalette {
  /// Page surface behind the PR list/detail. Desktop `--pr-surface`.
  static let ink = prAdaptive(light: prRgb(245, 243, 240), dark: prRgb(15, 16, 16))
  /// Timeline thread cards. Desktop `--pr-thread-card`.
  static let threadCard = prAdaptive(light: prRgb(255, 255, 255), dark: prRgb(23, 23, 24))
  /// Floating rail/metadata panes. Desktop `--pr-panel-card` (faint violet).
  static let panelCard = prAdaptive(light: prRgb(255, 255, 255), dark: prRgb(24, 23, 43))
  /// Hairline border for cards.
  static let cardBorder = prAdaptive(light: prRgb(26, 26, 30, 0.10), dark: prRgb(255, 255, 255, 0.08))
  /// Card drop shadow (cheap, small radius).
  static let cardShadow = prAdaptive(light: prRgb(0, 0, 0, 0.08), dark: prRgb(0, 0, 0, 0.35))

  // Accents route through the app-wide adaptive tokens so light mode stops
  // rendering the fixed dark-mode violet.
  static var purple: Color { ADEColor.accent }
  static var purpleBright: Color { ADEColor.accentBright }
  static var purpleDeep: Color { ADEColor.accentDeep }
  static var blue: Color { ADEColor.info }
  static var success: Color { ADEColor.success }
  static var warning: Color { ADEColor.warning }
  static var danger: Color { ADEColor.danger }

  static var accentGradient: LinearGradient {
    LinearGradient(
      colors: [ADEColor.accentBright, ADEColor.accentDeep],
      startPoint: .topLeading,
      endPoint: .bottomTrailing
    )
  }
}

struct PrGlassCardStyle: ViewModifier {
  var cornerRadius: CGFloat = 18
  var padding: CGFloat? = nil
  var tint: Color? = nil
  var strokeOpacity: Double = 0.10
  var highlightOpacity: Double = 0.14
  var shadow: Bool = true

  func body(content: Content) -> some View {
    content
      .padding(padding ?? 0)
      .background(
        ZStack {
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(PrGlassPalette.threadCard)

          if let tint {
            RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
              .fill(tint.opacity(0.08))
          }
        }
      )
      .overlay(
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(
            tint.map { $0.opacity(max(0.30, strokeOpacity)) } ?? PrGlassPalette.cardBorder,
            lineWidth: 1
          )
      )
      .shadow(
        color: shadow ? PrGlassPalette.cardShadow : .clear,
        radius: shadow ? 6 : 0,
        x: 0,
        y: shadow ? 2 : 0
      )
  }
}

extension View {
  func prGlassCard(
    cornerRadius: CGFloat = 18,
    tint: Color? = nil,
    strokeOpacity: Double = 0.10,
    highlightOpacity: Double = 0.14,
    shadow: Bool = true
  ) -> some View {
    modifier(
      PrGlassCardStyle(
        cornerRadius: cornerRadius,
        tint: tint,
        strokeOpacity: strokeOpacity,
        highlightOpacity: highlightOpacity,
        shadow: shadow
      )
    )
  }
}

/// 10pt uppercase bold eyebrow label.
struct PrEyebrow: View {
  let text: String
  var tint: Color = ADEColor.textSecondary

  var body: some View {
    Text(text.uppercased())
      .font(.system(size: 10, weight: .bold))
      .tracking(1)
      .foregroundStyle(tint)
  }
}

// MARK: - Merge gate types

// MARK: - Liquid-glass merge gate card
