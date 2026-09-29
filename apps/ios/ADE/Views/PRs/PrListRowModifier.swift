import SwiftUI

enum PrsGlass {
  // Backdrop + ink — route to the adaptive PR surface token so the PRs root
  // matches the detail surface in both themes.
  static var ink: Color { PrGlassPalette.ink }
  static var deepInk: Color { PrGlassPalette.ink }

  // Ambient glows.
  static let glowPurple = Color(red: 0xA7 / 255, green: 0x8B / 255, blue: 0xFA / 255)
  static let glowPink = Color(red: 0xF4 / 255, green: 0x72 / 255, blue: 0xB6 / 255)
  static let glowBlue = Color(red: 0x6B / 255, green: 0x8A / 255, blue: 0xFD / 255)

  // Accent gradient (PRs).
  static let accentTop = Color(red: 0xC4 / 255, green: 0xB1 / 255, blue: 0xFF / 255)
  static let accentBottom = Color(red: 0x8B / 255, green: 0x5C / 255, blue: 0xF6 / 255)

  // Status gradients.
  static let openTop = Color(red: 0x22 / 255, green: 0xC5 / 255, blue: 0x5E / 255)
  static let openBottom = Color(red: 0x16 / 255, green: 0xA3 / 255, blue: 0x4A / 255)
  static let draftTop = Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255)
  static let draftBottom = Color(red: 0xF5 / 255, green: 0x9E / 255, blue: 0x0B / 255)
  static let externalTop = Color(red: 0x6B / 255, green: 0x8A / 255, blue: 0xFD / 255)
  static let externalBottom = Color(red: 0x3B / 255, green: 0x82 / 255, blue: 0xF6 / 255)
  static let mergedTop = Color(red: 0xC4 / 255, green: 0xB1 / 255, blue: 0xFF / 255)
  static let mergedBottom = Color(red: 0x8B / 255, green: 0x5C / 255, blue: 0xF6 / 255)
  static let closedTop = Color(red: 0xF8 / 255, green: 0x71 / 255, blue: 0x71 / 255)
  static let closedBottom = Color(red: 0xDC / 255, green: 0x26 / 255, blue: 0x26 / 255)

  // Text — alias the app-wide adaptive tokens (fixes light mode).
  static var textPrimary: Color { ADEColor.textPrimary }
  static var textSecondary: Color { ADEColor.textSecondary }
  static var textMuted: Color { ADEColor.textMuted }

  static func statusGradient(_ state: String) -> (Color, Color) {
    switch state {
    case "open": return (openTop, openBottom)
    case "draft": return (draftTop, draftBottom)
    case "merged": return (mergedTop, mergedBottom)
    case "closed": return (closedTop, closedBottom)
    case "external": return (externalTop, externalBottom)
    default: return (textSecondary.opacity(0.7), textSecondary.opacity(0.4))
    }
  }

  static func statusTint(_ state: String) -> Color {
    statusGradient(state).0
  }
}

// MARK: - Liquid-glass backdrop for the PRs root.
//
// Stacked radial gradients tuned to give the PRs surface a warm purple
// "stage light" falling in from the top and a cool blue wash climbing from
// the bottom-left, with three offscreen orbs that bloom in from the edges.
// The whole stack is rasterised once via `.drawingGroup()` so scrolling
// doesn't re-composite the gradient graph each frame. Any motion is gated
// behind `accessibilityReduceMotion` — default state is STATIC.

private enum PrsBackdropPalette {
  // Top-center spotlight.
  static let spotlightTop = Color(red: 0x6D / 255, green: 0x3B / 255, blue: 0xC9 / 255)
  static let spotlightMid = Color(red: 0x2A / 255, green: 0x1B / 255, blue: 0x4D / 255)
  static let spotlightInk = Color(red: 0x07 / 255, green: 0x06 / 255, blue: 0x09 / 255)

  // Bottom-left cool wash.
  static let coolTop = Color(red: 0x1E / 255, green: 0x3A / 255, blue: 0x8A / 255)
  static let coolInk = Color(red: 0x0B / 255, green: 0x0D / 255, blue: 0x10 / 255)

  // Offscreen orbs.
  static let orbPurple = Color(red: 0xA7 / 255, green: 0x8B / 255, blue: 0xFA / 255)
  static let orbPink = Color(red: 0xF4 / 255, green: 0x72 / 255, blue: 0xB6 / 255)
  static let orbBlue = Color(red: 0x6B / 255, green: 0x8A / 255, blue: 0xFD / 255)
}

struct PrsGlassDisc<Content: View>: View {
  let tint: Color
  let isAlive: Bool
  let size: CGFloat
  let content: Content

  init(tint: Color, isAlive: Bool, size: CGFloat = 34, @ViewBuilder content: () -> Content) {
    self.tint = tint
    self.isAlive = isAlive
    self.size = size
    self.content = content()
  }

  var body: some View {
    ZStack {
      // Outer soft coloured glow (only when "alive").
      if isAlive {
        Circle()
          .fill(tint.opacity(0.55))
          .frame(width: size + 6, height: size + 6)
          .blur(radius: 10)
          .opacity(0.85)
      }

      // Base glass.
      Circle()
        .fill(.ultraThinMaterial)
        .frame(width: size, height: size)

      // Tinted bloom (top-left).
      Circle()
        .fill(
          RadialGradient(
            colors: [tint.opacity(isAlive ? 0.35 : 0.18), .clear],
            center: UnitPoint(x: 0.25, y: 0.2),
            startRadius: 0,
            endRadius: size
          )
        )
        .frame(width: size, height: size)

      // Soft vertical highlight.
      Circle()
        .fill(
          LinearGradient(
            colors: [Color.white.opacity(0.18), .clear],
            startPoint: .top,
            endPoint: .bottom
          )
        )
        .frame(width: size, height: size)

      // 1pt inner highlight.
      Circle()
        .strokeBorder(
          LinearGradient(
            colors: [Color.white.opacity(0.35), Color.white.opacity(0.04)],
            startPoint: .top,
            endPoint: .bottom
          ),
          lineWidth: 1
        )
        .frame(width: size, height: size)

      // Outer hairline.
      Circle()
        .stroke(Color.white.opacity(0.12), lineWidth: 0.75)
        .frame(width: size, height: size)

      content
    }
    .compositingGroup()
    .shadow(color: Color.black.opacity(0.45), radius: 10, x: 0, y: 4)
  }
}

// MARK: - Primary accent gradient used on the "+" button and CTAs.

struct PrsLivePulse: View {
  let isLive: Bool
  let syncedLabel: String?

  @State private var pulse = false

  var body: some View {
    HStack(spacing: 6) {
      ZStack {
        Circle()
          .fill(isLive ? PrsGlass.openTop : PrsGlass.textMuted)
          .frame(width: 6, height: 6)
          .shadow(color: (isLive ? PrsGlass.openTop : .clear).opacity(0.8), radius: pulse ? 6 : 3)
      }
      .onAppear {
        guard isLive else { return }
        withAnimation(.easeInOut(duration: 1.1).repeatForever(autoreverses: true)) {
          pulse.toggle()
        }
      }

      Text(isLive ? "LIVE" : "CACHED")
        .font(.system(size: 10, weight: .bold, design: .rounded))
        .tracking(1.2)
        .foregroundStyle(isLive ? PrsGlass.textPrimary : PrsGlass.textMuted)

      if let syncedLabel, !syncedLabel.isEmpty {
        Text("· \(syncedLabel)")
          .font(.system(size: 10, weight: .medium))
          .foregroundStyle(PrsGlass.textMuted)
          .lineLimit(1)
      }
    }
  }
}

// MARK: - Eyebrow section label.

struct PrsEyebrowLabel: View {
  let text: String
  var tint: Color = PrsGlass.textSecondary

  var body: some View {
    Text(text.uppercased())
      .font(.system(size: 10, weight: .bold))
      .tracking(1.0)
      .foregroundStyle(tint)
      .lineLimit(1)
  }
}

