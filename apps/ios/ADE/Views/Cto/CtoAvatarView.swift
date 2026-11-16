import SwiftUI
import UIKit

// The CTO, drawn as a small living character: the iOS port of desktop
// `components/cto/avatar/` (CtoAvatar.tsx, ctoAvatarShapes.ts,
// ctoAvatarLook.ts, ctoAvatarState.ts, ctoAvatar.css). Same 100 × 100
// drawing, same seven bodies, four faces, ten colours and seven states.

// MARK: - Look vocabulary

enum CtoAvatarShape: String, CaseIterable, Identifiable {
  case pebble, bean, spark, chip, drop, cloud, hex
  var id: String { rawValue }
  var label: String { rawValue.capitalized }
}

enum CtoAvatarEyes: String, CaseIterable, Identifiable {
  case caret, round, visor, pixel
  var id: String { rawValue }
  var label: String { rawValue.capitalized }
}

enum CtoAvatarEnergy: String, CaseIterable, Identifiable {
  case calm, lively
  var id: String { rawValue }
  var label: String { rawValue.capitalized }
}

enum CtoPersonality: String, CaseIterable, Identifiable {
  case focused, friendly, playful
  var id: String { rawValue }
  var title: String { rawValue.capitalized }
  /// One line in that voice (desktop `PERSONALITY_COPY`).
  var example: String {
    switch self {
    case .focused: return "Fixed. A race in the login test; fix is on auth-fix."
    case .friendly: return "Good news: the login flake was a race. The fix is ready."
    case .playful: return "Caught it! A sneaky race in the login test. Fix is up."
    }
  }

  init(raw: String?) {
    self = CtoPersonality(rawValue: (raw ?? "").lowercased()) ?? .focused
  }
}

/// What the CTO is doing right now, as its avatar shows it. Derived on the
/// client from the session; never stored.
enum CtoAvatarState: String, CaseIterable, Identifiable {
  case idle, working, thinking, waiting, asleep, happy, error
  var id: String { rawValue }
  var label: String { rawValue.capitalized }
}

struct CtoAvatarSwatch: Identifiable, Hashable {
  let name: String
  let hex: String
  var id: String { hex }
}

/// The ten body colours (desktop `CTO_AVATAR_SWATCHES`). Mid-tone on purpose:
/// each reads as a body on a dark page and a light one, and each becomes the
/// CTO surface's accent.
let ctoAvatarSwatches: [CtoAvatarSwatch] = [
  CtoAvatarSwatch(name: "Periwinkle", hex: "#7c9cff"),
  CtoAvatarSwatch(name: "Glacier", hex: "#46bdf0"),
  CtoAvatarSwatch(name: "Mint", hex: "#3ecf9c"),
  CtoAvatarSwatch(name: "Pear", hex: "#a8d35a"),
  CtoAvatarSwatch(name: "Marigold", hex: "#f4bf4f"),
  CtoAvatarSwatch(name: "Tangerine", hex: "#ff9150"),
  CtoAvatarSwatch(name: "Watermelon", hex: "#ff6b7e"),
  CtoAvatarSwatch(name: "Bubblegum", hex: "#f28ac9"),
  CtoAvatarSwatch(name: "Grape", hex: "#9a72ff"),
  CtoAvatarSwatch(name: "Graphite", hex: "#556079"),
]

/// Dark eyes on a light body.
let ctoAvatarInkHex = "#161a2b"

/// `#rrggbb` (lower case) for a six-digit hex with or without `#`, else nil.
func ctoNormalizedHex(_ value: String?) -> String? {
  let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
  let digits = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
  guard digits.count == 6, digits.allSatisfy(\.isHexDigit) else { return nil }
  return "#" + digits.lowercased()
}

private func ctoRGB(_ hex: String) -> (Double, Double, Double) {
  let digits = (ctoNormalizedHex(hex) ?? "#7c9cff").dropFirst()
  let value = Int(digits, radix: 16) ?? 0x7c9cff
  return (
    Double((value >> 16) & 0xff) / 255,
    Double((value >> 8) & 0xff) / 255,
    Double(value & 0xff) / 255
  )
}

func ctoColor(hex: String) -> Color {
  let (r, g, b) = ctoRGB(hex)
  return Color(red: r, green: g, blue: b)
}

private func ctoRelativeLuminance(_ hex: String) -> Double {
  func channel(_ c: Double) -> Double { c <= 0.03928 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
  let (r, g, b) = ctoRGB(hex)
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

/// Ink or white, whichever stands out more on the body colour.
func ctoAvatarEyeHex(body: String) -> String {
  let bodyL = ctoRelativeLuminance(body)
  let inkL = ctoRelativeLuminance(ctoAvatarInkHex)
  let againstInk = (bodyL + 0.05) / (inkL + 0.05)
  let againstWhite = 1.05 / (bodyL + 0.05)
  return againstInk >= againstWhite ? ctoAvatarInkHex : "#ffffff"
}

/// A stored look with anything unknown or malformed replaced by the default.
struct CtoResolvedLook: Equatable {
  var shape: CtoAvatarShape
  var hex: String
  var eyes: CtoAvatarEyes
  var energy: CtoAvatarEnergy

  init(_ look: CtoAvatarLook?) {
    let fallback = CtoAvatarLook.default
    shape = CtoAvatarShape(rawValue: look?.shape ?? "") ?? CtoAvatarShape(rawValue: fallback.shape)!
    hex = ctoNormalizedHex(look?.color) ?? ctoNormalizedHex(fallback.color)!
    eyes = CtoAvatarEyes(rawValue: look?.eyes ?? "") ?? CtoAvatarEyes(rawValue: fallback.eyes)!
    energy = CtoAvatarEnergy(rawValue: look?.energy ?? "") ?? CtoAvatarEnergy(rawValue: fallback.energy)!
  }

  var color: Color { ctoColor(hex: hex) }
  var inkHex: String { ctoAvatarEyeHex(body: hex) }
  var look: CtoAvatarLook {
    CtoAvatarLook(shape: shape.rawValue, color: hex, eyes: eyes.rawValue, energy: energy.rawValue)
  }
}

extension CtoAvatarLook {
  var resolved: CtoResolvedLook { CtoResolvedLook(self) }
  /// The body colour, which is also the CTO surface's accent.
  var accent: Color { resolved.color }
}

extension Optional where Wrapped == CtoAvatarLook {
  var ctoAccent: Color { CtoResolvedLook(self).color }
}

// MARK: - Geometry

/// One body: its outline, any parts drawn behind it (the chip's pins), and
/// where the face goes (centre of the eye line, eye gap, face scale).
struct CtoAvatarShapeSpec {
  let body: Path
  let extras: Path?
  let eyeX: CGFloat
  let eyeY: CGFloat
  let gap: CGFloat
  let scale: CGFloat
}

enum CtoAvatarGeometry {
  static func spec(_ shape: CtoAvatarShape) -> CtoAvatarShapeSpec { specs[shape] ?? specs[.pebble]! }

  private typealias P = (CGFloat, CGFloat)

  private static let specs: [CtoAvatarShape: CtoAvatarShapeSpec] = {
    var out: [CtoAvatarShape: CtoAvatarShapeSpec] = [:]
    // A river stone: a little fuller on the right, a little lower on the left.
    out[.pebble] = CtoAvatarShapeSpec(
      body: smoothClosed([(50, 17), (69, 20), (83, 33), (87, 53), (81, 73), (64, 85),
                          (43, 86), (24, 79), (14, 61), (16, 39), (29, 24)]),
      extras: nil, eyeX: 51, eyeY: 51, gap: 20, scale: 1
    )
    // Two soft lobes over one round belly.
    out[.bean] = CtoAvatarShapeSpec(
      body: smoothClosed([(14, 57), (18, 38), (31, 27), (47, 29), (58, 26), (72, 20),
                          (85, 29), (88, 49), (82, 70), (64, 84), (41, 86), (22, 78)]),
      extras: nil, eyeX: 52, eyeY: 55, gap: 20, scale: 1
    )
    // A puffy four-point star.
    out[.spark] = CtoAvatarShapeSpec(
      body: smoothClosed([(50, 11), (57.5, 20), (68.5, 33.5), (82, 44.5), (91, 52), (82, 59.5), (68.5, 70.5), (57.5, 84),
                          (50, 93), (42.5, 84), (31.5, 70.5), (18, 59.5), (9, 52), (18, 44.5), (31.5, 33.5), (42.5, 20)]),
      extras: nil, eyeX: 50, eyeY: 52, gap: 18, scale: 0.92
    )
    // The dev nod: a rounded die with two pins on each side.
    var pins = Path()
    for (x, y) in [(11.0, 38.0), (11, 61), (77, 38), (77, 61)] as [(CGFloat, CGFloat)] {
      pins.addPath(rect(x, y, 12, 7, 2.5))
    }
    out[.chip] = CtoAvatarShapeSpec(
      body: rect(20, 23, 60, 60, 15),
      extras: pins, eyeX: 50, eyeY: 52, gap: 20, scale: 1
    )
    out[.drop] = CtoAvatarShapeSpec(
      body: smoothClosed([(50, 9), (60, 23), (74, 41), (83, 60), (77, 77), (63, 86),
                          (50, 88), (37, 86), (23, 77), (17, 60), (26, 41), (40, 23)]),
      extras: nil, eyeX: 50, eyeY: 61, gap: 20, scale: 1
    )
    out[.cloud] = CtoAvatarShapeSpec(body: cloud(), extras: nil, eyeX: 50, eyeY: 60, gap: 20, scale: 1)
    out[.hex] = CtoAvatarShapeSpec(
      body: roundedPolygon((0..<6).map { i in
        let angle = CGFloat.pi / 3 * CGFloat(i)
        return (50 + 38 * cos(angle), 52 + 38 * sin(angle))
      }, radius: 11),
      extras: nil, eyeX: 50, eyeY: 52, gap: 20, scale: 1
    )
    return out
  }()

  /// A smooth closed curve through every point (uniform Catmull-Rom as cubic Béziers).
  private static func smoothClosed(_ points: [P]) -> Path {
    let n = points.count
    func at(_ i: Int) -> CGPoint {
      let p = points[((i % n) + n) % n]
      return CGPoint(x: p.0, y: p.1)
    }
    var path = Path()
    path.move(to: at(0))
    for i in 0..<n {
      let p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2)
      let c1 = CGPoint(x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6)
      let c2 = CGPoint(x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6)
      path.addCurve(to: p2, control1: c1, control2: c2)
    }
    path.closeSubpath()
    return path
  }

  /// A polygon whose corners are rounded with radius `radius`.
  private static func roundedPolygon(_ points: [P], radius r: CGFloat) -> Path {
    let n = points.count
    func at(_ i: Int) -> CGPoint {
      let p = points[((i % n) + n) % n]
      return CGPoint(x: p.0, y: p.1)
    }
    func toward(_ from: CGPoint, _ to: CGPoint, _ distance: CGFloat) -> CGPoint {
      let dx = to.x - from.x, dy = to.y - from.y
      let length = max(0.0001, hypot(dx, dy))
      return CGPoint(x: from.x + dx / length * distance, y: from.y + dy / length * distance)
    }
    var path = Path()
    for i in 0..<n {
      let corner = at(i)
      let enter = toward(corner, at(i - 1), r)
      let leave = toward(corner, at(i + 1), r)
      if i == 0 { path.move(to: enter) } else { path.addLine(to: enter) }
      path.addQuadCurve(to: leave, control: corner)
    }
    path.closeSubpath()
    return path
  }

  private static func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ r: CGFloat) -> Path {
    roundedPolygon([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], radius: r)
  }

  /// `M 26 83 A 15 15 0 0 1 15 59 A 16 16 0 0 1 33 37 A 19 19 0 0 1 68 35
  ///  A 16 16 0 0 1 85 59 A 15 15 0 0 1 74 83 Q 50 88 26 83 Z`
  private static func cloud() -> Path {
    var path = Path()
    var current = CGPoint(x: 26, y: 83)
    path.move(to: current)
    for (r, x, y) in [(15.0, 15.0, 59.0), (16, 33, 37), (19, 68, 35), (16, 85, 59), (15, 74, 83)] as [(CGFloat, CGFloat, CGFloat)] {
      let end = CGPoint(x: x, y: y)
      addSvgArc(&path, from: current, to: end, radius: r, largeArc: false, sweep: true)
      current = end
    }
    path.addQuadCurve(to: CGPoint(x: 26, y: 83), control: CGPoint(x: 50, y: 88))
    path.closeSubpath()
    return path
  }

  /// An SVG circular arc (endpoint form) as cubic Béziers, in the drawing's
  /// y-down coordinates.
  private static func addSvgArc(_ path: inout Path, from p1: CGPoint, to p2: CGPoint, radius: CGFloat, largeArc: Bool, sweep: Bool) {
    var r = radius
    let x1p = (p1.x - p2.x) / 2
    let y1p = (p1.y - p2.y) / 2
    let lambda = (x1p * x1p + y1p * y1p) / (r * r)
    if lambda > 1 { r *= sqrt(lambda) }
    let numerator = max(0, r * r * r * r - r * r * y1p * y1p - r * r * x1p * x1p)
    let denominator = max(0.0001, r * r * y1p * y1p + r * r * x1p * x1p)
    let coef = (largeArc != sweep ? 1 : -1) * sqrt(numerator / denominator)
    let cxp = coef * y1p
    let cyp = -coef * x1p
    let cx = cxp + (p1.x + p2.x) / 2
    let cy = cyp + (p1.y + p2.y) / 2
    let theta1 = atan2((y1p - cyp) / r, (x1p - cxp) / r)
    var delta = atan2((-y1p - cyp) / r, (-x1p - cxp) / r) - theta1
    if !sweep && delta > 0 { delta -= 2 * .pi }
    if sweep && delta < 0 { delta += 2 * .pi }
    let segments = max(1, Int(ceil(abs(delta) / (.pi / 2))))
    let step = delta / CGFloat(segments)
    let k = 4.0 / 3.0 * tan(step / 4)
    var angle = theta1
    for _ in 0..<segments {
      let a1 = angle, a2 = angle + step
      let start = CGPoint(x: cx + r * cos(a1), y: cy + r * sin(a1))
      let end = CGPoint(x: cx + r * cos(a2), y: cy + r * sin(a2))
      let c1 = CGPoint(x: start.x - k * r * sin(a1), y: start.y + k * r * cos(a1))
      let c2 = CGPoint(x: end.x + k * r * sin(a2), y: end.y - k * r * cos(a2))
      path.addCurve(to: end, control1: c1, control2: c2)
      angle = a2
    }
  }
}

// MARK: - Motion

/// Which face the avatar wears for a state.
enum CtoAvatarEyeSet: Equatable {
  case base, dots, happy, error, sleep

  init(_ state: CtoAvatarState) {
    switch state {
    case .thinking: self = .dots
    case .happy: self = .happy
    case .error: self = .error
    case .asleep: self = .sleep
    default: self = .base
    }
  }
}

/// Everything that moves, for one moment. Translations are in drawing units
/// (1 = 1% of the avatar box), angles in degrees.
struct CtoAvatarPose {
  var bodyDX: CGFloat = 0, bodyDY: CGFloat = 0
  var bodySX: CGFloat = 1, bodySY: CGFloat = 1
  var bodyRotation: Double = 0
  var gazeDX: CGFloat = 0, gazeDY: CGFloat = 0
  var blinkSY: CGFloat = 1
  var blinkOpacity: Double = 1
  var ringScale: CGFloat = 1, ringOpacity: Double = 0
  var orbitAngle: Double = 0, orbitOpacity: Double = 0
  var zDX: CGFloat = 0, zDY: CGFloat = 0, zScale: CGFloat = 1, zOpacity: Double = 0
  var shadowScale: CGFloat = 1, shadowOpacity: Double = 1
  var dotLift: [CGFloat] = [0, 0, 0]
  var dotOpacity: [Double] = [1, 1, 1]

  /// Hold the value of the last keyframe at or before `p` (CSS `step-end`).
  private static func step(_ frames: [(Double, [Double])], _ p: Double) -> [Double] {
    var value = frames[0].1
    for frame in frames where frame.0 <= p { value = frame.1 }
    return value
  }

  /// Glide between keyframes with `ease` on each segment.
  private static func tween(_ frames: [(Double, [Double])], _ p: Double, ease: (Double) -> Double) -> [Double] {
    guard let first = frames.first else { return [] }
    if p <= first.0 { return first.1 }
    for index in 1..<frames.count {
      let a = frames[index - 1], b = frames[index]
      if p <= b.0 {
        let span = max(0.0001, b.0 - a.0)
        let x = ease((p - a.0) / span)
        return zip(a.1, b.1).map { $0 + ($1 - $0) * x }
      }
    }
    return frames[frames.count - 1].1
  }

  private static func easeInOut(_ x: Double) -> Double { x * x * (3 - 2 * x) }
  private static func easeOut(_ x: Double) -> Double { 1 - (1 - x) * (1 - x) }
  private static func cycle(_ t: Double, _ period: Double) -> Double {
    let value = t.truncatingRemainder(dividingBy: period) / period
    return value < 0 ? value + 1 : value
  }

  /// Desktop `ctoAvatar.css`, keyframe for keyframe.
  static func at(
    state: CtoAvatarState,
    energy: CtoAvatarEnergy,
    eyes: CtoAvatarEyes,
    live: Bool,
    animated: Bool,
    reduceMotionStill: Bool,
    now t: Double,
    elapsed: Double
  ) -> CtoAvatarPose {
    var pose = CtoAvatarPose()
    let calm = energy == .calm
    // Poses hold in every motion mode.
    if state == .waiting {
      pose.bodyRotation = -6
      pose.gazeDX = 1.5
      pose.gazeDY = -5
    }
    if state == .asleep && reduceMotionStill {
      pose.zOpacity = 0.75
      pose.zDX = 6
      pose.zDY = -8
    }
    guard animated else { return pose }

    switch state {
    case .idle:
      guard live else { break }
      if eyes == .caret {
        pose.blinkOpacity = step([(0, [1]), (0.86, [0]), (0.90, [1]), (0.94, [0]), (0.98, [1])], cycle(t, 6))[0]
      } else {
        pose.blinkSY = CGFloat(step([(0, [1]), (0.95, [0.12]), (0.97, [1])], cycle(t, 5.4))[0])
      }
      let glance = step([(0, [0, 0]), (0.34, [-3.5, 0]), (0.44, [0, 0]), (0.68, [3.5, -1]), (0.77, [0, 0])], cycle(t, 11))
      pose.gazeDX = CGFloat(glance[0])
      pose.gazeDY = CGFloat(glance[1])

    case .working:
      if calm {
        let bob = tween([(0, [0]), (0.5, [-2.5]), (1, [0])], cycle(t, 1.5), ease: easeInOut)
        pose.bodyDY = CGFloat(bob[0])
        let scan = step([(0, [-2.5, 0]), (0.25, [0, 0]), (0.5, [2.5, 0]), (0.75, [2.5, 1])], cycle(t, 2.4))
        pose.gazeDX = CGFloat(scan[0]); pose.gazeDY = CGFloat(scan[1])
      } else {
        let bob = tween([(0, [0, 1.035, 0.965]), (0.5, [-5, 0.985, 1.02]), (1, [0, 1.035, 0.965])], cycle(t, 1.5), ease: easeInOut)
        pose.bodyDY = CGFloat(bob[0]); pose.bodySX = CGFloat(bob[1]); pose.bodySY = CGFloat(bob[2])
        let scan = step([(0, [-4.5, 0]), (0.2, [-1.5, 0]), (0.4, [1.5, 0]), (0.6, [4.5, 0]), (0.8, [4.5, 1.5])], cycle(t, 2.4))
        pose.gazeDX = CGFloat(scan[0]); pose.gazeDY = CGFloat(scan[1])
      }
      pose.orbitOpacity = 1
      pose.orbitAngle = cycle(t, calm ? 3.6 : 2.6) * 360

    case .thinking:
      if !calm {
        let sway = tween([(0, [0, 0]), (0.5, [-2.5, 1.5]), (1, [0, 0])], cycle(t, 1.8), ease: easeInOut)
        pose.bodyDY = CGFloat(sway[0]); pose.bodyRotation = sway[1]
      }
      let lift = calm ? -0.35 : -0.7
      let low = calm ? 0.55 : 0.5
      for index in 0..<3 {
        let p = cycle(t - Double(index) * 0.14, 1.05)
        let value = tween([(0, [0, low]), (0.25, [lift, 1]), (0.55, [0, low]), (1, [0, low])], p, ease: easeInOut)
        // Percent of the dot's own height (two radii of 3.3 units).
        pose.dotLift[index] = CGFloat(value[0] * 6.6)
        pose.dotOpacity[index] = value[1]
      }

    case .waiting:
      let ping = step([(0, [1.05, 0.5]), (0.12, [1.11, 0.32]), (0.24, [1.17, 0.16]), (0.36, [1.17, 0])], cycle(t, 2.8))
      pose.ringScale = CGFloat(ping[0]); pose.ringOpacity = ping[1]

    case .asleep:
      let breathe = calm
        ? step([(0, [1, 1]), (0.5, [1.012, 1.02])], cycle(t, 4.8))
        : step([(0, [1, 1]), (0.25, [1.012, 1.02]), (0.5, [1.024, 1.04]), (0.75, [1.012, 1.02])], cycle(t, 4.8))
      pose.bodySX = CGFloat(breathe[0]); pose.bodySY = CGFloat(breathe[1])
      // The z box is 20 units; its translations are percents of that box.
      let z = step([(0, [0, 0, 0.8, 0]), (0.12, [0, 0, 0.8, 0.9]), (0.37, [7, -11, 1, 0.75]),
                    (0.62, [14, -22, 1.15, 0.45]), (0.8, [14, -22, 1.15, 0])], cycle(t, 3.6))
      pose.zDX = CGFloat(z[0]); pose.zDY = CGFloat(z[1]); pose.zScale = CGFloat(z[2]); pose.zOpacity = z[3]

    case .happy:
      let p = min(1, max(0, elapsed / 1.1))
      if calm {
        let hop = tween([(0, [0]), (0.18, [-8]), (0.36, [0]), (0.5, [-3]), (0.64, [0]), (1, [0])], p, ease: easeOut)
        pose.bodyDY = CGFloat(hop[0])
      } else {
        let hop = tween([(0, [0, 1.08, 0.92]), (0.16, [-16, 0.94, 1.07]), (0.32, [0, 1.08, 0.92]),
                         (0.46, [-6, 0.98, 1.03]), (0.6, [0, 1.02, 0.98]), (0.72, [0, 1, 1]), (1, [0, 1, 1])], p, ease: easeOut)
        pose.bodyDY = CGFloat(hop[0]); pose.bodySX = CGFloat(hop[1]); pose.bodySY = CGFloat(hop[2])
      }
      let shadow = tween([(0, [1, 1]), (0.16, [0.62, 0.5]), (0.32, [1, 1]), (0.46, [0.85, 0.8]), (0.6, [1, 1]), (1, [1, 1])], p, ease: easeOut)
      pose.shadowScale = CGFloat(shadow[0]); pose.shadowOpacity = shadow[1]

    case .error:
      let p = min(1, max(0, elapsed / 0.7))
      if calm {
        let shake = tween([(0, [0]), (0.15, [-2.5]), (0.35, [2.5]), (0.55, [-1.5]), (0.75, [0]), (1, [0])], p, ease: easeInOut)
        pose.bodyDX = CGFloat(shake[0])
      } else {
        let shake = tween([(0, [0, 0]), (0.12, [-5, -4]), (0.26, [5, 4]), (0.4, [-4, -3]), (0.54, [3, 2]),
                           (0.68, [-1.5, -1]), (0.82, [0, 0]), (1, [0, 0])], p, ease: easeInOut)
        pose.bodyDX = CGFloat(shake[0]); pose.bodyRotation = shake[1]
      }
    }
    return pose
  }
}

// MARK: - Step schedule

/// The instants a stepped state shows a new pose, and none in between: each
/// loop's keyframe fractions of its period, on the reference-date clock that
/// `CtoAvatarPose.at` reads. Desktop's step clock does the same for its CSS
/// loops. An idle avatar that blinks every 5.4 s draws a few frames a minute
/// instead of 12 a second. Right after the face changes it runs at 30 fps for
/// the crossfade, then goes back to the steps.
struct CtoAvatarStepSchedule: TimelineSchedule {
  struct Loop { let period: Double; let fractions: [Double] }
  let loops: [Loop]
  let denseUntil: Date

  static func loops(state: CtoAvatarState, eyes: CtoAvatarEyes, energy: CtoAvatarEnergy, live: Bool) -> [Loop] {
    switch state {
    case .idle:
      guard live else { return [] }
      let blink = eyes == .caret
        ? Loop(period: 6, fractions: [0, 0.86, 0.90, 0.94, 0.98])
        : Loop(period: 5.4, fractions: [0, 0.95, 0.97])
      return [blink, Loop(period: 11, fractions: [0, 0.34, 0.44, 0.68, 0.77])]
    case .waiting:
      return [Loop(period: 2.8, fractions: [0, 0.12, 0.24, 0.36])]
    case .asleep:
      let breathe = energy == .calm
        ? Loop(period: 4.8, fractions: [0, 0.5])
        : Loop(period: 4.8, fractions: [0, 0.25, 0.5, 0.75])
      return [breathe, Loop(period: 3.6, fractions: [0, 0.12, 0.37, 0.62, 0.8])]
    default:
      return []
    }
  }

  /// The first change strictly after `t` (reference-date seconds).
  private func nextChange(after t: Double) -> Double? {
    var best: Double? = nil
    for loop in loops where loop.period > 0 {
      let base = (t / loop.period).rounded(.down) * loop.period
      for cycle in 0...1 {
        for fraction in loop.fractions {
          let at = base + Double(cycle) * loop.period + fraction * loop.period
          if at > t + 0.0005, best.map({ at < $0 }) ?? true { best = at }
        }
      }
    }
    return best
  }

  func entries(from startDate: Date, mode: TimelineScheduleMode) -> AnyIterator<Date> {
    var current: Date? = startDate
    let dense = denseUntil
    return AnyIterator {
      guard let date = current else { return nil }
      let t = date.timeIntervalSinceReferenceDate
      if date < dense {
        current = date.addingTimeInterval(1.0 / 30)
      } else if let next = nextChange(after: t) {
        current = Date(timeIntervalSinceReferenceDate: next)
      } else {
        current = nil
      }
      return date
    }
  }
}

// MARK: - View

/// The CTO's avatar. `still` is a picture (the state still shows in the
/// eyes); `lazy` holds still at idle and moves in every other state; `live`
/// also blinks and glances around at idle. At 24pt and under, and with Reduce
/// Motion, it never moves. It stops redrawing while off screen or while the
/// app is in the background, and long-lived states redraw only at the instants
/// their pose changes.
struct CtoAvatarView: View {
  enum Motion { case still, lazy, live }

  let look: CtoAvatarLook?
  let state: CtoAvatarState
  var size: CGFloat
  var motion: Motion = .lazy
  /// VoiceOver label. Without it the avatar is decoration.
  var label: String? = nil
  /// Busy → idle plays a 1.4 s happy hop, as on desktop.
  var blips = true

  static let stillMaxSize: CGFloat = 24
  private static let blipSeconds: Double = 1.4
  private static let crossfadeSeconds: Double = 0.14

  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.scenePhase) private var scenePhase
  @Environment(\.colorScheme) private var colorScheme

  @State private var shown: CtoAvatarState
  @State private var lastBase: CtoAvatarState
  @State private var since = Date()
  @State private var previousEyes: CtoAvatarEyeSet? = nil
  @State private var eyesChangedAt = Date.distantPast
  @State private var blipToken = 0
  @State private var onScreen = false

  init(look: CtoAvatarLook?, state: CtoAvatarState, size: CGFloat, motion: Motion = .lazy, label: String? = nil, blips: Bool = true) {
    self.look = look
    self.state = state
    self.size = size
    self.motion = motion
    self.label = label
    self.blips = blips
    _shown = State(initialValue: state)
    _lastBase = State(initialValue: state)
  }

  private var animates: Bool { motion != .still && size > Self.stillMaxSize && !reduceMotion }

  /// Whether this state moves at all (idle only moves when `live`).
  private func moves(_ state: CtoAvatarState) -> Bool {
    guard animates else { return false }
    return state != .idle || motion == .live
  }

  /// Idle, waiting and asleep move in steps; working, thinking and the blips glide.
  private func stepped(_ state: CtoAvatarState) -> Bool {
    state == .idle || state == .waiting || state == .asleep
  }

  /// The glides (working, thinking): 24 fps, 12 in Low Power Mode. Desktop
  /// steps the same loops about 20 times a second.
  private func frameInterval(_ state: CtoAvatarState) -> Double {
    ProcessInfo.processInfo.isLowPowerModeEnabled ? 1.0 / 12 : 1.0 / 24
  }

  var body: some View {
    let resolved = CtoResolvedLook(look)
    let current = shown
    Group {
      if moves(current) {
        let paused = !onScreen || scenePhase != .active
        if stepped(current) && !paused {
          // Only at the instants the pose changes (see CtoAvatarStepSchedule).
          TimelineView(CtoAvatarStepSchedule(
            loops: CtoAvatarStepSchedule.loops(state: current, eyes: resolved.eyes, energy: resolved.energy, live: motion == .live),
            denseUntil: eyesChangedAt.addingTimeInterval(Self.crossfadeSeconds)
          )) { context in
            canvas(resolved: resolved, state: current, date: context.date)
          }
        } else {
          // Never the display's full rate: a ProMotion screen would otherwise
          // redraw this canvas 120 times a second.
          TimelineView(.animation(minimumInterval: frameInterval(current), paused: paused)) { context in
            canvas(resolved: resolved, state: current, date: context.date)
          }
        }
      } else {
        canvas(resolved: resolved, state: current, date: nil)
      }
    }
    .frame(width: size, height: size)
    .onAppear { onScreen = true }
    .onDisappear { onScreen = false }
    .onChange(of: state) { _, next in apply(next) }
    .task(id: blipToken) {
      guard blipToken > 0 else { return }
      try? await Task.sleep(nanoseconds: UInt64(Self.blipSeconds * 1_000_000_000))
      guard !Task.isCancelled else { return }
      let settled: CtoAvatarState = (lastBase == .happy || lastBase == .error) ? .idle : lastBase
      if shown == .happy || shown == .error { show(settled) }
    }
    .accessibilityElement()
    .accessibilityLabel(label ?? "")
    .accessibilityHidden(label == nil)
    .accessibilityAddTraits(.isImage)
  }

  private func show(_ next: CtoAvatarState) {
    guard next != shown else { return }
    if CtoAvatarEyeSet(next) != CtoAvatarEyeSet(shown) {
      previousEyes = CtoAvatarEyeSet(shown)
      eyesChangedAt = Date()
    }
    shown = next
    since = Date()
  }

  /// Desktop `useCtoAvatarState`: a turn landing is a moment, not a mood.
  private func apply(_ next: CtoAvatarState) {
    let previous = lastBase
    lastBase = next
    guard blips else { show(next); return }
    let busy: (CtoAvatarState) -> Bool = { $0 == .working || $0 == .thinking }
    let blip: (CtoAvatarState) -> Bool = { $0 == .happy || $0 == .error }
    if blip(next) {
      show(next)
      blipToken += 1
    } else if next == .idle && busy(previous) {
      show(.happy)
      blipToken += 1
    } else if next == .idle && blip(previous) {
      return
    } else {
      show(next)
    }
  }

  private func canvas(resolved: CtoResolvedLook, state: CtoAvatarState, date: Date?) -> some View {
    let spec = CtoAvatarGeometry.spec(resolved.shape)
    let now = (date ?? since).timeIntervalSinceReferenceDate
    let elapsed = (date ?? since).timeIntervalSince(since)
    let pose = CtoAvatarPose.at(
      state: state,
      energy: resolved.energy,
      eyes: resolved.eyes,
      live: motion == .live,
      animated: date != nil,
      reduceMotionStill: state == .asleep && motion != .still && size > Self.stillMaxSize && reduceMotion,
      now: now,
      elapsed: elapsed
    )
    let fade: Double = {
      guard date != nil, previousEyes != nil else { return 1 }
      return min(1, max(0, (date ?? since).timeIntervalSince(eyesChangedAt) / Self.crossfadeSeconds))
    }()
    let body = resolved.color
    let ink = ctoColor(hex: resolved.inkHex)
    let glint = resolved.inkHex == "#ffffff" ? body : Color.white
    let shadowColor = (colorScheme == .dark ? Color.white : Color.black).opacity(0.14)
    let showsShadow = size >= 40
    let showsOrbit = date != nil && state == .working
    let previous = previousEyes
    let eyesKind = resolved.eyes
    // The z, the ping ring and the orbit leave the 100-unit box, as on
    // desktop (overflow visible): the canvas carries a margin around it.
    let margin = Self.canvasMargin
    return Canvas { context, canvasSize in
      let u = canvasSize.width / (100 + 2 * margin)
      let unit = CGAffineTransform(translationX: margin, y: margin).concatenating(CGAffineTransform(scaleX: u, y: u))

      if showsShadow {
        var shadow = context
        let center = CGPoint(x: 50, y: 91)
        shadow.transform = CGAffineTransform(translationX: center.x, y: center.y)
          .scaledBy(x: pose.shadowScale, y: pose.shadowScale)
          .translatedBy(x: -center.x, y: -center.y)
          .concatenating(unit)
        shadow.opacity = pose.shadowOpacity
        shadow.fill(Path(ellipseIn: CGRect(x: 27, y: 88.5, width: 46, height: 5)), with: .color(shadowColor))
      }

      // The body: origin 50% 86%, translate, then rotate and scale about it.
      var bodyContext = context
      let origin = CGPoint(x: 50, y: 86)
      let bodyTransform = CGAffineTransform(translationX: origin.x + pose.bodyDX, y: origin.y + pose.bodyDY)
        .rotated(by: pose.bodyRotation * .pi / 180)
        .scaledBy(x: pose.bodySX, y: pose.bodySY)
        .translatedBy(x: -origin.x, y: -origin.y)
      bodyContext.transform = bodyTransform.concatenating(unit)

      if pose.ringOpacity > 0 {
        var ring = bodyContext
        let c = CGPoint(x: 50, y: 52)
        ring.transform = CGAffineTransform(translationX: c.x, y: c.y)
          .scaledBy(x: pose.ringScale, y: pose.ringScale)
          .translatedBy(x: -c.x, y: -c.y)
          .concatenating(bodyTransform).concatenating(unit)
        ring.opacity = pose.ringOpacity
        ring.stroke(spec.body, with: .color(body), lineWidth: 3)
      }

      if let extras = spec.extras {
        bodyContext.fill(extras, with: .color(body))
        bodyContext.fill(extras, with: .color(.black.opacity(0.2)))
      }
      bodyContext.fill(spec.body, with: .color(body))
      var lit = bodyContext
      lit.clip(to: spec.body)
      lit.fill(Path(ellipseIn: CGRect(x: 62 - 54, y: 102 - 30, width: 108, height: 60)), with: .color(.black.opacity(0.13)))
      var shine = lit
      shine.transform = CGAffineTransform(translationX: 34, y: 25).rotated(by: -26 * .pi / 180)
        .concatenating(bodyTransform).concatenating(unit)
      shine.fill(Path(ellipseIn: CGRect(x: -19, y: -10, width: 38, height: 20)), with: .color(.white.opacity(0.2)))

      // The face, moved by the gaze.
      var face = context
      let gazeTransform = CGAffineTransform(translationX: pose.gazeDX, y: pose.gazeDY).concatenating(bodyTransform)
      face.transform = gazeTransform.concatenating(unit)
      let current = CtoAvatarEyeSet(state)
      if let previous, previous != current, fade < 1 {
        var old = face
        old.opacity = 1 - fade
        Self.drawEyes(previous, kind: eyesKind, spec: spec, pose: pose, ink: ink, glint: glint, in: &old, gaze: gazeTransform, unit: unit)
      }
      var fresh = face
      fresh.opacity = fade
      Self.drawEyes(current, kind: eyesKind, spec: spec, pose: pose, ink: ink, glint: glint, in: &fresh, gaze: gazeTransform, unit: unit)

      if showsOrbit {
        var orbit = bodyContext
        let c = CGPoint(x: 50, y: 52)
        orbit.transform = CGAffineTransform(translationX: c.x, y: c.y)
          .rotated(by: pose.orbitAngle * .pi / 180)
          .translatedBy(x: -c.x, y: -c.y)
          .concatenating(bodyTransform).concatenating(unit)
        orbit.fill(Path(ellipseIn: CGRect(x: 46.5, y: -1.5, width: 7, height: 7)), with: .color(body))
      }

      if pose.zOpacity > 0 {
        var z = context
        let c = CGPoint(x: 76, y: 12)
        z.transform = CGAffineTransform(translationX: c.x + pose.zDX, y: c.y + pose.zDY)
          .scaledBy(x: pose.zScale, y: pose.zScale)
          .translatedBy(x: -c.x, y: -c.y)
          .concatenating(unit)
        z.opacity = pose.zOpacity
        z.draw(
          Text("z").font(.system(size: 20, weight: .bold, design: .monospaced)).foregroundStyle(body),
          at: CGPoint(x: 70, y: 2),
          anchor: .topLeading
        )
      }
    }
    .frame(width: size * (100 + 2 * margin) / 100, height: size * (100 + 2 * margin) / 100)
    .frame(width: size, height: size)
    .allowsHitTesting(false)
  }

  /// Drawing units of room around the box.
  private static let canvasMargin: CGFloat = 30

  private static func drawEyes(
    _ set: CtoAvatarEyeSet,
    kind: CtoAvatarEyes,
    spec: CtoAvatarShapeSpec,
    pose: CtoAvatarPose,
    ink: Color,
    glint: Color,
    in context: inout GraphicsContext,
    gaze: CGAffineTransform,
    unit: CGAffineTransform
  ) {
    let s = spec.scale
    let y = spec.eyeY
    let xs = [spec.eyeX - spec.gap / 2, spec.eyeX + spec.gap / 2]
    switch set {
    case .base:
      var blink = context
      blink.transform = CGAffineTransform(translationX: 0, y: y).scaledBy(x: 1, y: pose.blinkSY).translatedBy(x: 0, y: -y)
        .concatenating(gaze).concatenating(unit)
      blink.opacity = pose.blinkOpacity
      switch kind {
      case .round:
        for cx in xs {
          blink.fill(Path(ellipseIn: CGRect(x: cx - 4.8 * s, y: y - 6 * s, width: 9.6 * s, height: 12 * s)), with: .color(ink))
          var spark = blink
          spark.opacity = pose.blinkOpacity * 0.9
          spark.fill(Path(ellipseIn: CGRect(x: cx + 1.6 * s - 1.5 * s, y: y - 2.1 * s - 1.5 * s, width: 3 * s, height: 3 * s)), with: .color(glint))
        }
      case .visor:
        let width = spec.gap + 13 * s
        let height = 7.6 * s
        blink.fill(Path(roundedRect: CGRect(x: spec.eyeX - width / 2, y: y - height / 2, width: width, height: height), cornerRadius: height / 2), with: .color(ink))
      case .pixel:
        let cell = 4.2 * s
        let stepSize = cell + 1.1 * s
        for cx in xs {
          for row in 0..<2 {
            for col in 0..<2 {
              let rect = CGRect(
                x: cx - stepSize / 2 - cell / 2 + CGFloat(col) * stepSize,
                y: y - stepSize / 2 - cell / 2 + CGFloat(row) * stepSize,
                width: cell, height: cell
              )
              blink.fill(Path(roundedRect: rect, cornerRadius: 0.6 * s), with: .color(ink))
            }
          }
        }
      case .caret:
        let width = 5.6 * s
        let height = 16 * s
        for cx in xs {
          blink.fill(Path(roundedRect: CGRect(x: cx - width / 2, y: y - height / 2, width: width, height: height), cornerRadius: width / 2), with: .color(ink))
        }
      }
    case .dots:
      let r = 3.3 * s
      let spread = 9.5 * s
      for (index, dx) in [-spread, 0, spread].enumerated() {
        var dot = context
        dot.opacity = pose.dotOpacity[index]
        let lift = pose.dotLift[index] * s
        dot.fill(Path(ellipseIn: CGRect(x: spec.eyeX + dx - r, y: y - r + lift, width: 2 * r, height: 2 * r)), with: .color(ink))
      }
    case .happy, .error, .sleep:
      var path = Path()
      for cx in xs {
        switch set {
        case .happy:
          path.move(to: CGPoint(x: cx - 5 * s, y: y + 2.6 * s))
          path.addLine(to: CGPoint(x: cx, y: y - 3 * s))
          path.addLine(to: CGPoint(x: cx + 5 * s, y: y + 2.6 * s))
        case .error:
          let r = 4 * s
          path.move(to: CGPoint(x: cx - r, y: y - r))
          path.addLine(to: CGPoint(x: cx + r, y: y + r))
          path.move(to: CGPoint(x: cx + r, y: y - r))
          path.addLine(to: CGPoint(x: cx - r, y: y + r))
        default:
          path.move(to: CGPoint(x: cx - 5 * s, y: y - 0.5 * s))
          path.addQuadCurve(to: CGPoint(x: cx + 5 * s, y: y - 0.5 * s), control: CGPoint(x: cx, y: y + 4.5 * s))
        }
      }
      context.stroke(
        path,
        with: .color(ink),
        style: StrokeStyle(lineWidth: (set == .sleep ? 3 : 3.6) * s, lineCap: .round, lineJoin: .round)
      )
    }
  }
}

/// A soft wash of the CTO's colour behind a big avatar (the desktop halo).
struct CtoAvatarHalo: View {
  let color: Color
  var diameter: CGFloat

  var body: some View {
    Circle()
      .fill(RadialGradient(colors: [color.opacity(0.26), color.opacity(0)], center: .center, startRadius: 0, endRadius: diameter / 2))
      .frame(width: diameter, height: diameter)
      .accessibilityHidden(true)
  }
}
