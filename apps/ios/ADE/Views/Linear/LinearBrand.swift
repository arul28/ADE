import SwiftUI

// MARK: - Brand tokens

/// Linear brand colors + marks ported 1:1 from the desktop renderer
/// (`apps/desktop/src/renderer/components/lanes/linearBrand.tsx`) so the mobile
/// Linear pane reads with the same visual language as the desktop pane and
/// Linear itself.
enum LinearBrand {
  static let primary = linearColor(0x5E6AD2)
  static let primaryBright = linearColor(0x7B8AF0)
  static let primaryDeep = linearColor(0x4752B5)
  static let text = linearColor(0xC7CDF5)
  static var surface: Color { primary.opacity(0.10) }
  static var surfaceHover: Color { primary.opacity(0.16) }
  static var border: Color { primary.opacity(0.32) }
  static var borderSubtle: Color { primary.opacity(0.20) }
}

func linearColor(_ hex: UInt) -> Color {
  Color(
    red: Double((hex >> 16) & 0xFF) / 255,
    green: Double((hex >> 8) & 0xFF) / 255,
    blue: Double(hex & 0xFF) / 255
  )
}

// MARK: - Linear logo mark

/// The Linear logo, rendered from the exact SVG path the desktop `LinearMark`
/// uses (viewBox 0 0 24 24). Filled with the current foreground style so callers
/// tint it like an SF Symbol.
struct LinearMark: View {
  var size: CGFloat = 14

  var body: some View {
    LinearMarkShape()
      .frame(width: size, height: size)
  }
}

struct LinearMarkShape: Shape, @unchecked Sendable {
  // The four sub-paths of the Linear glyph (absolute + relative commands).
  private static let pathData =
    "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18Z"
    + "M1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65Z"
    + "M.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Z"
    + "M.152 14.025l9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z"

  func path(in rect: CGRect) -> Path {
    let unit = parseSVGPath(Self.pathData)
    let scale = CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24)
      .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY))
    return unit.applying(scale)
  }
}

// MARK: - Linear state icon

/// Workflow-state glyph, ported from the desktop `LinearStateIcon`.
/// `stateType` is Linear's state category: backlog / unstarted / started /
/// completed / canceled / triage.
struct LinearStateIcon: View {
  let stateType: String?
  var size: CGFloat = 14

  var body: some View {
    Canvas { context, canvasSize in
      let s = min(canvasSize.width, canvasSize.height)
      let type = linearNormalizedStateType(stateType)
      let color = linearStateColor(type)
      let stroke = max(1.4, s * 0.12)
      let inset = stroke / 2
      let r = s / 2 - inset
      let center = CGPoint(x: s / 2, y: s / 2)

      func ringPath(radius: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2))
      }

      switch type {
      case "backlog":
        context.stroke(
          ringPath(radius: r),
          with: .color(color),
          style: StrokeStyle(lineWidth: stroke, lineCap: .round, dash: [stroke * 1.7, stroke * 1.4])
        )
      case "started":
        context.stroke(ringPath(radius: r), with: .color(color), style: StrokeStyle(lineWidth: stroke))
        let innerR = r - stroke * 0.6
        var wedge = Path()
        wedge.move(to: center)
        wedge.addLine(to: CGPoint(x: center.x, y: center.y - innerR))
        wedge.addArc(
          center: center, radius: innerR,
          startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false
        )
        wedge.closeSubpath()
        context.fill(wedge, with: .color(color))
      case "completed":
        context.fill(ringPath(radius: r + inset), with: .color(color))
        var check = Path()
        check.move(to: CGPoint(x: center.x - r * 0.45, y: center.y))
        check.addLine(to: CGPoint(x: center.x - r * 0.1, y: center.y + r * 0.38))
        check.addLine(to: CGPoint(x: center.x + r * 0.55, y: center.y - r * 0.35))
        context.stroke(
          check,
          with: .color(linearColor(0x0C0B10)),
          style: StrokeStyle(lineWidth: stroke * 1.1, lineCap: .round, lineJoin: .round)
        )
      case "canceled":
        context.fill(ringPath(radius: r + inset), with: .color(color.opacity(0.9)))
        var x = Path()
        x.move(to: CGPoint(x: center.x - r * 0.45, y: center.y - r * 0.45))
        x.addLine(to: CGPoint(x: center.x + r * 0.45, y: center.y + r * 0.45))
        x.move(to: CGPoint(x: center.x - r * 0.45, y: center.y + r * 0.45))
        x.addLine(to: CGPoint(x: center.x + r * 0.45, y: center.y - r * 0.45))
        context.stroke(x, with: .color(linearColor(0x0C0B10)), style: StrokeStyle(lineWidth: stroke * 1.1, lineCap: .round))
      default: // unstarted / triage
        context.stroke(ringPath(radius: r), with: .color(color), style: StrokeStyle(lineWidth: stroke))
      }
    }
    .frame(width: size, height: size)
  }
}

// MARK: - Linear priority icon

/// Priority glyph, ported from the desktop `LinearPriorityIcon`.
/// Linear priority: 0=none, 1=urgent, 2=high, 3=medium, 4=low.
struct LinearPriorityIcon: View {
  let priority: Int?
  var size: CGFloat = 14

  var body: some View {
    Canvas { context, canvasSize in
      let s = min(canvasSize.width, canvasSize.height)
      let dim = linearColor(0x94A3B8).opacity(0.4)
      let strong = linearColor(0xC7CDF5)
      let p = priority ?? 0

      func roundedRect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ radius: CGFloat) -> Path {
        Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: radius)
      }

      if p == 1 {
        context.fill(roundedRect(s * 0.12, s * 0.12, s * 0.76, s * 0.76, s * 0.18), with: .color(linearColor(0xEB5757)))
        context.fill(roundedRect(s * 0.45, s * 0.28, s * 0.10, s * 0.32, s * 0.05), with: .color(.white))
        context.fill(roundedRect(s * 0.45, s * 0.65, s * 0.10, s * 0.10, s * 0.05), with: .color(.white))
        return
      }
      if p == 0 {
        context.fill(roundedRect(s * 0.18, s * 0.46, s * 0.64, s * 0.10, s * 0.05), with: .color(dim))
        return
      }
      // 2 = high (3 bars), 3 = medium (2 bars), 4 = low (1 bar)
      let filledBars = p == 2 ? 3 : (p == 3 ? 2 : 1)
      let barWidth = s * 0.18
      let barGap = s * 0.10
      let totalWidth = barWidth * 3 + barGap * 2
      let startX = (s - totalWidth) / 2
      let heights = [s * 0.32, s * 0.55, s * 0.78]
      for i in 0..<3 {
        let h = heights[i]
        let filled = i < filledBars
        context.fill(
          roundedRect(startX + CGFloat(i) * (barWidth + barGap), s - h - s * 0.12, barWidth, h, s * 0.04),
          with: .color(filled ? strong : dim)
        )
      }
    }
    .frame(width: size, height: size)
  }
}

// MARK: - Display helpers

func linearNormalizedStateType(_ raw: String?) -> String {
  let value = raw?.lowercased() ?? ""
  switch value {
  case "backlog", "unstarted", "started", "completed", "canceled", "triage":
    return value
  default:
    return "unstarted"
  }
}

/// Solid state color used for badges/dots (ported STATE_COLORS).
func linearStateColor(_ stateType: String?) -> Color {
  switch linearNormalizedStateType(stateType) {
  case "started": return linearColor(0xF2C94C)
  case "completed": return linearColor(0x5E6AD2)
  case "triage": return linearColor(0xF2994A)
  default: return linearColor(0x94A3B8) // backlog / unstarted / canceled
  }
}

/// "Urgent" / "High" / … label for a Linear priority int.
func linearPriorityLabel(_ priority: Int?) -> String? {
  switch priority {
  case 1: return "Urgent"
  case 2: return "High"
  case 3: return "Medium"
  case 4: return "Low"
  default: return nil
  }
}
