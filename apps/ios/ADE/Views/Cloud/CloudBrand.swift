import SwiftUI

// ADE Cloud's look on the phone, the desktop's and the website's dusk sky:
// the logo (a violet-to-rose cloud with one lit gold window), the sky behind
// the hero and the current plan, and the palette (`--adec-*` in the
// desktop's `cloudBrand.css`). Everything here is drawn once and holds still:
// no animation, so it costs nothing while the page is open.

enum CloudBrandColor {
  static let violetLight = Color(red: 0.769, green: 0.710, blue: 0.992) // #c4b5fd
  static let violet = Color(red: 0.545, green: 0.361, blue: 0.965) // #8b5cf6
  static let rose = Color(red: 0.859, green: 0.153, blue: 0.467) // #db2777
  static let roseLight = Color(red: 0.957, green: 0.447, blue: 0.714) // #f472b6
  static let lamp = Color(red: 1.0, green: 0.824, blue: 0.478) // #ffd27a
  static let lampHot = Color(red: 1.0, green: 0.945, blue: 0.812) // #fff1cf
  /// Text on the sky, in both themes.
  static let skyText = Color(red: 0.965, green: 0.953, blue: 1.0)
  static let skyText2 = Color(red: 0.886, green: 0.855, blue: 1.0).opacity(0.76)
  static let glass = Color.white.opacity(0.07)
  static let glassEdge = Color.white.opacity(0.12)
  /// The brand tone off the sky: violet that reads on the page in either theme.
  static let mark = Color(light: Color(red: 0.427, green: 0.247, blue: 0.839), dark: Color(red: 0.655, green: 0.545, blue: 0.980))
  /// Gold that reads as text on the page (darker in light).
  static let lampText = Color(light: Color(red: 0.631, green: 0.361, blue: 0.0), dark: lamp)

  static let fill = LinearGradient(colors: [violet, Color(red: 0.882, green: 0.373, blue: 0.639), lamp], startPoint: .leading, endPoint: .trailing)
  static let button = LinearGradient(colors: [Color(red: 0.486, green: 0.302, blue: 0.875), rose], startPoint: .topLeading, endPoint: .bottomTrailing)
}

private extension Color {
  init(light: Color, dark: Color) {
    self.init(UIColor { traits in traits.userInterfaceStyle == .dark ? UIColor(dark) : UIColor(light) })
  }
}

/// The logo's cloud in a 30×20 box (the desktop's `CLOUD_LOGO_PATH`): three
/// round tops over a flat base.
struct CloudLogoShape: Shape {
  func path(in rect: CGRect) -> Path {
    let sx = rect.width / 30
    let sy = rect.height / 20
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: rect.minX + (x - 1) * sx, y: rect.minY + (y - 3) * sy) }
    func circle(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat) -> Path {
      Path(ellipseIn: CGRect(x: rect.minX + (cx - r - 1) * sx, y: rect.minY + (cy - r - 3) * sy, width: 2 * r * sx, height: 2 * r * sy))
    }
    var path = Path()
    path.addPath(circle(9.7, 14.6, 6.4))
    path.addPath(circle(17.2, 11.3, 7.5))
    path.addPath(circle(24.3, 15.5, 5.5))
    path.addRect(CGRect(origin: p(9.7, 14), size: CGSize(width: 14.6 * sx, height: 7 * sy)))
    // The base is flat at y 21.
    return path.intersection(Path(CGRect(origin: p(1, 3), size: CGSize(width: 30 * sx, height: 18 * sy))))
  }
}

/// The ADE Cloud logo: the cloud in violet to rose with one lit gold window.
struct CloudLogo: View {
  var size: CGFloat = 16
  var glow = false

  var body: some View {
    let width = size * 1.5
    let unit = width / 30
    ZStack(alignment: .topLeading) {
      CloudLogoShape()
        .fill(LinearGradient(colors: [CloudBrandColor.violetLight, CloudBrandColor.violet, CloudBrandColor.rose], startPoint: .top, endPoint: .bottom))
      CloudLogoShape()
        .stroke(Color.white.opacity(0.35), lineWidth: max(0.5, unit * 0.6))
      RoundedRectangle(cornerRadius: unit * 0.9, style: .continuous)
        .fill(CloudBrandColor.lamp)
        .frame(width: unit * 4.4, height: unit * 4.4)
        .shadow(color: glow ? CloudBrandColor.lamp.opacity(0.9) : .clear, radius: unit * 2)
        .offset(x: unit * 14, y: unit * 9.2)
    }
    .frame(width: width, height: size)
    .accessibilityHidden(true)
  }
}

/// The dusk sky behind the hero and the current plan: indigo to violet, a
/// rose and gold glow on the horizon, fixed stars, the moon and a bank of
/// clouds along the bottom. Static.
struct CloudSky: View {
  var moon = true
  var bank = true

  /// Fixed stars (x, y as shares, size): the same sky every time.
  private static let stars: [(CGFloat, CGFloat, CGFloat)] = [
    (0.06, 0.10, 1), (0.14, 0.32, 1.4), (0.22, 0.06, 1), (0.31, 0.22, 1), (0.39, 0.12, 1.6), (0.47, 0.30, 1),
    (0.55, 0.05, 1), (0.61, 0.20, 1.2), (0.70, 0.36, 1), (0.78, 0.09, 1.4), (0.86, 0.26, 1), (0.94, 0.14, 1),
    (0.10, 0.48, 1), (0.52, 0.44, 1), (0.66, 0.52, 1),
  ]

  var body: some View {
    GeometryReader { geo in
      let w = geo.size.width
      let h = geo.size.height
      ZStack {
        LinearGradient(
          colors: [Color(red: 0.027, green: 0.024, blue: 0.102), Color(red: 0.059, green: 0.047, blue: 0.165), Color(red: 0.102, green: 0.071, blue: 0.251), Color(red: 0.165, green: 0.098, blue: 0.318)],
          startPoint: .top,
          endPoint: .bottom
        )
        RadialGradient(colors: [CloudBrandColor.violet.opacity(0.42), .clear], center: UnitPoint(x: 0.5, y: 1.05), startRadius: 0, endRadius: max(w, h) * 0.7)
        RadialGradient(colors: [CloudBrandColor.rose.opacity(0.22), .clear], center: UnitPoint(x: 0.2, y: 0.95), startRadius: 0, endRadius: w * 0.4)
        RadialGradient(colors: [CloudBrandColor.lamp.opacity(0.10), .clear], center: UnitPoint(x: 0.82, y: 0.9), startRadius: 0, endRadius: w * 0.35)
        Canvas { context, size in
          for (x, y, s) in Self.stars {
            let rect = CGRect(x: x * size.width, y: y * size.height, width: s, height: s)
            context.fill(Path(ellipseIn: rect), with: .color(.white.opacity(0.55)))
          }
        }
        if moon {
          Circle()
            .fill(RadialGradient(colors: [CloudBrandColor.lampHot, CloudBrandColor.lamp], center: UnitPoint(x: 0.36, y: 0.34), startRadius: 0, endRadius: 18))
            .frame(width: 30, height: 30)
            .shadow(color: CloudBrandColor.lamp.opacity(0.35), radius: 16)
            .position(x: w - 40, y: min(h * 0.32, 104))
        }
        if bank {
          let bankFill = LinearGradient(colors: [Color(red: 0.29, green: 0.20, blue: 0.57), Color(red: 0.14, green: 0.094, blue: 0.31), Color(red: 0.07, green: 0.055, blue: 0.165)], startPoint: .top, endPoint: .bottom)
          let backFill = LinearGradient(colors: [Color(red: 0.42, green: 0.18, blue: 0.49), Color(red: 0.17, green: 0.086, blue: 0.31)], startPoint: .top, endPoint: .bottom)
          ForEach(Array([(-0.08, 0.30), (0.20, 0.26), (0.50, 0.32), (0.78, 0.28)].enumerated()), id: \.offset) { _, cloud in
            CloudLogoShape().fill(backFill).opacity(0.75)
              .frame(width: w * cloud.1, height: w * cloud.1 * 0.62)
              .position(x: w * (cloud.0 + cloud.1 / 2), y: h - w * cloud.1 * 0.12)
          }
          ForEach(Array([(-0.12, 0.36), (0.30, 0.30), (0.62, 0.40)].enumerated()), id: \.offset) { _, cloud in
            CloudLogoShape().fill(bankFill)
              .overlay(CloudLogoShape().stroke(Color.white.opacity(0.16), lineWidth: 0.75))
              .frame(width: w * cloud.1, height: w * cloud.1 * 0.62)
              .position(x: w * (cloud.0 + cloud.1 / 2), y: h + w * cloud.1 * 0.04)
          }
        }
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

/// A small frosted pill on the sky ("Renews Dec 13", "Extra hours on").
struct CloudSkyChip: View {
  let text: String
  var tone: Tone = .plain

  enum Tone { case plain, lamp, warn, crit }

  var body: some View {
    let color: Color = switch tone {
    case .plain: CloudBrandColor.skyText2
    case .lamp: CloudBrandColor.lamp
    case .warn: Color(red: 0.988, green: 0.827, blue: 0.302)
    case .crit: Color(red: 0.988, green: 0.647, blue: 0.647)
    }
    Text(text)
      .font(.system(size: 11.5, weight: .medium))
      .foregroundStyle(color)
      .lineLimit(1)
      .padding(.horizontal, 9)
      .frame(height: 22)
      .background(tone == .plain ? CloudBrandColor.glass : color.opacity(0.12), in: Capsule())
      .overlay(Capsule().strokeBorder(tone == .plain ? CloudBrandColor.glassEdge : color.opacity(0.4), lineWidth: 0.75))
  }
}

/// The plan's name beside "ADE Cloud": a serif italic in gold.
struct CloudPlanWord: View {
  let text: String
  var size: CGFloat = 20
  var onSky = true

  var body: some View {
    Text(text)
      .font(.system(size: size, weight: .medium, design: .serif).italic())
      .foregroundStyle(onSky ? CloudBrandColor.lamp : CloudBrandColor.lampText)
      .shadow(color: onSky ? CloudBrandColor.lamp.opacity(0.3) : .clear, radius: 10)
  }
}
