import SwiftUI

extension View {
  /// App-wide gutter applied to every PRs list row so content cards, filter
  /// chips, and notice banners never hug the screen edge. 16pt matches the
  /// horizontal gutter used by the top-bar and the detail-screen scroll
  /// padding, keeping the left edge of every surface aligned.
  func prListRow() -> some View {
    listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
      .listRowBackground(Color.clear)
      .listRowSeparator(.hidden)
  }
}

// MARK: - Liquid-glass palette shared across the PRs root + top bar restyle.
//
// Centralised here so the top-bar controls in `ADEDesignSystem.swift`, the PRs
// surface, and the attention bell can speak the same visual language without
// adding a new file. These are purely visual tokens; no new app state.

enum PrsGlass {
  // Backdrop + ink.
  static let ink = Color(red: 0x07 / 255, green: 0x06 / 255, blue: 0x09 / 255)
  static let deepInk = Color(red: 0x04 / 255, green: 0x03 / 255, blue: 0x07 / 255)

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

  // Text.
  static let textPrimary = Color(red: 0xF0 / 255, green: 0xF0 / 255, blue: 0xF2 / 255)
  static let textSecondary = Color(red: 0xA8 / 255, green: 0xA8 / 255, blue: 0xB4 / 255)
  static let textMuted = Color(red: 0x5E / 255, green: 0x5A / 255, blue: 0x70 / 255)

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

struct PrsLiquidBackdrop: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    GeometryReader { proxy in
      let w = proxy.size.width
      let h = proxy.size.height
      ZStack {
        PrsBackdropPalette.spotlightInk

        // Top-center purple spotlight → mid purple → ink.
        RadialGradient(
          colors: [
            PrsBackdropPalette.spotlightTop,
            PrsBackdropPalette.spotlightMid,
            PrsBackdropPalette.spotlightInk,
          ],
          center: UnitPoint(x: 0.5, y: 0.0),
          startRadius: 0,
          endRadius: h * 0.55
        )

        // Bottom-left cool wash — 35% opacity over the spotlight.
        RadialGradient(
          colors: [PrsBackdropPalette.coolTop, PrsBackdropPalette.coolInk.opacity(0)],
          center: UnitPoint(x: 0.0, y: 1.0),
          startRadius: 0,
          endRadius: max(w, h) * 0.85
        )
        .opacity(0.35)

        // Three offscreen orb ellipses — soft color blooms bleeding in from
        // the edges. Sized in points per spec (not proportional to canvas).
        orb(diameter: 320, color: PrsBackdropPalette.orbPurple, alpha: 0.55,
            center: CGPoint(x: -40, y: h * 0.18))
        orb(diameter: 260, color: PrsBackdropPalette.orbPink, alpha: 0.35,
            center: CGPoint(x: w + 60, y: h * 0.08))
        orb(diameter: 340, color: PrsBackdropPalette.orbBlue, alpha: 0.28,
            center: CGPoint(x: w * 0.35, y: h + 80))
      }
      .drawingGroup()
      .ignoresSafeArea()
    }
    .ignoresSafeArea()
  }

  @ViewBuilder
  private func orb(diameter: CGFloat, color: Color, alpha: Double, center: CGPoint) -> some View {
    Ellipse()
      .fill(
        RadialGradient(
          colors: [color.opacity(alpha), color.opacity(0)],
          center: .center,
          startRadius: 0,
          endRadius: diameter / 2
        )
      )
      .frame(width: diameter, height: diameter)
      .position(x: center.x, y: center.y)
      .blendMode(.screen)
      .allowsHitTesting(false)
  }
}

// MARK: - Liquid-glass surface (card) modifier.

private struct PrsGlassSurfaceModifier: ViewModifier {
  let cornerRadius: CGFloat
  let tint: Color?
  let padding: CGFloat

  func body(content: Content) -> some View {
    content
      .padding(padding)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background {
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .fill(.ultraThinMaterial)
      }
      .background {
        // Status tint bloom in the top-left corner if provided.
        if let tint {
          RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
            .fill(
              RadialGradient(
                colors: [tint.opacity(0.22), .clear],
                center: UnitPoint(x: 0.05, y: 0.05),
                startRadius: 0,
                endRadius: 220
              )
            )
        }
      }
      .overlay {
        // Soft vertical highlight (white 0.08 → 0.00).
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .fill(
            LinearGradient(
              colors: [Color.white.opacity(0.08), .clear],
              startPoint: .top,
              endPoint: .bottom
            )
          )
          .allowsHitTesting(false)
      }
      .overlay {
        // 1pt inner highlight at the top edge.
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .strokeBorder(
            LinearGradient(
              colors: [Color.white.opacity(0.14), Color.white.opacity(0.02)],
              startPoint: .top,
              endPoint: .bottom
            ),
            lineWidth: 1
          )
          .allowsHitTesting(false)
      }
      .overlay {
        // Thin outer hairline (0.10 alpha white).
        RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
          .stroke(Color.white.opacity(0.10), lineWidth: 0.75)
          .allowsHitTesting(false)
      }
      .shadow(color: Color.black.opacity(0.45), radius: 24, x: 0, y: 8)
  }
}

extension View {
  func prsGlassSurface(
    cornerRadius: CGFloat = 18,
    tint: Color? = nil,
    padding: CGFloat = 14
  ) -> some View {
    modifier(PrsGlassSurfaceModifier(cornerRadius: cornerRadius, tint: tint, padding: padding))
  }
}

// MARK: - Status accent rail used on PR cards.

struct PrsStatusRail: View {
  let state: String

  var body: some View {
    let (top, bottom) = PrsGlass.statusGradient(state)
    RoundedRectangle(cornerRadius: 2.5, style: .continuous)
      .fill(
        LinearGradient(
          colors: [top, bottom],
          startPoint: .top,
          endPoint: .bottom
        )
      )
      .frame(width: 4)
      .shadow(color: top.opacity(0.55), radius: 8, x: 0, y: 0)
      .shadow(color: top.opacity(0.35), radius: 2, x: 0, y: 0)
  }
}

// MARK: - Liquid-glass disc (used for top-bar icon buttons).
//
// 30pt circular glass with a subtle fill, 1pt inner highlight, outer hairline,
// and an optional coloured glow when the control is "alive".

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

struct PrsAccentCapsule<Content: View>: View {
  let content: Content
  var isEnabled: Bool

  init(isEnabled: Bool = true, @ViewBuilder content: () -> Content) {
    self.isEnabled = isEnabled
    self.content = content()
  }

  var body: some View {
    ZStack {
      if isEnabled {
        Circle()
          .fill(PrsGlass.glowPurple.opacity(0.55))
          .frame(width: 44, height: 44)
          .blur(radius: 16)
      }

      Circle()
        .fill(
          LinearGradient(
            colors: [PrsGlass.accentTop, PrsGlass.accentBottom],
            startPoint: UnitPoint(x: 0.15, y: 0.0),
            endPoint: UnitPoint(x: 0.85, y: 1.0)
          )
        )
        .frame(width: 34, height: 34)
        .opacity(isEnabled ? 1.0 : 0.35)

      // Inner white highlight at top.
      Circle()
        .strokeBorder(
          LinearGradient(
            colors: [Color.white.opacity(0.55), .clear],
            startPoint: .top,
            endPoint: .center
          ),
          lineWidth: 1
        )
        .frame(width: 34, height: 34)

      Circle()
        .stroke(Color.white.opacity(0.22), lineWidth: 0.75)
        .frame(width: 34, height: 34)

      content
        .opacity(isEnabled ? 1.0 : 0.5)
    }
    .compositingGroup()
    .shadow(color: PrsGlass.glowPurple.opacity(isEnabled ? 0.45 : 0.0), radius: 14, x: 0, y: 4)
    .shadow(color: Color.black.opacity(0.35), radius: 6, x: 0, y: 3)
  }
}

// MARK: - LIVE pulse indicator.

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

// MARK: - Section header used to group external (un-mapped) PRs in the root list.
//
// Used between ADE-linked rows and external rows so the list still reads as
// two pools without a wrapper card. The root screen decides when to show it.
struct PrsExternalSectionHeader: View {
  let unmappedCount: Int

  var body: some View {
    HStack(spacing: 8) {
      PrsEyebrowLabel(
        text: "External · \(unmappedCount) unmapped",
        tint: PrsGlass.externalTop
      )
      Rectangle()
        .fill(Color.white.opacity(0.06))
        .frame(height: 0.5)
    }
    .padding(.horizontal, 4)
    .padding(.top, 12)
    .padding(.bottom, 4)
  }
}

// MARK: - LaunchPad-style floating search pill.
//
// 14pt rounded capsule, ultraThinMaterial + white α0.06 wash, white α0.12
// hairline, a soft top-down inner highlight, leading magnifying-glass,
// centered TextField, and a muted trailing chip (e.g. "⌘K"). Used at the top
// of the PRs root between the title and the filter chips. This is chrome,
// not a row, so `.ultraThinMaterial` is appropriate here per the performance
// guidance — materials belong on sheets / sticky bars, not inside list cells.
struct PrsGlassSearchPill: View {
  @Binding var text: String
  let placeholder: String
  var trailingChip: String? = "⌘K"

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(PrsGlass.textMuted)

      TextField(
        "",
        text: $text,
        prompt: Text(placeholder).foregroundColor(PrsGlass.textMuted)
      )
      .font(.system(size: 14))
      .foregroundStyle(PrsGlass.textPrimary)
      .textInputAutocapitalization(.never)
      .autocorrectionDisabled(true)
      .submitLabel(.search)

      if !text.isEmpty {
        Button {
          text = ""
        } label: {
          Image(systemName: "xmark.circle.fill")
            .font(.system(size: 14))
            .foregroundStyle(PrsGlass.textMuted)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear search")
      } else if let trailingChip {
        Text(trailingChip)
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .foregroundStyle(PrsGlass.textMuted)
          .padding(.horizontal, 7)
          .padding(.vertical, 3)
          .background(
            Capsule(style: .continuous)
              .fill(Color.white.opacity(0.06))
          )
          .overlay(
            Capsule(style: .continuous)
              .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.5)
          )
      }
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 11)
    .background {
      ZStack {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(.ultraThinMaterial)
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(Color.white.opacity(0.06))
        RoundedRectangle(cornerRadius: 14, style: .continuous)
          .fill(
            LinearGradient(
              colors: [Color.white.opacity(0.10), Color.white.opacity(0)],
              startPoint: .top,
              endPoint: .center
            )
          )
      }
    }
    .overlay(
      RoundedRectangle(cornerRadius: 14, style: .continuous)
        .strokeBorder(Color.white.opacity(0.12), lineWidth: 0.75)
    )
  }
}
