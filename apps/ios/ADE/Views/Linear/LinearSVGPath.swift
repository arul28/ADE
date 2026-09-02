import CoreGraphics
import SwiftUI

/// Minimal SVG path-data → `Path` converter, sufficient for the Linear logo
/// glyph and for the mono `brand:*` glyphs a plugin ships (commands M/m L/l
/// H/h V/v C/c S/s Q/q T/t A/a Z/z). Arcs are emitted as cubic bezier segments
/// via the SVG endpoint→center parameterization; an axis-aligned arc
/// (x-rotation 0) is handled exactly.
///
/// Coordinates are produced in the path's own units (the Linear glyph is a
/// 0…24 viewBox); callers scale into their target rect.
///
/// The input is UNTRUSTED. A plugin's `brandIcons` file reaches this parser
/// after the host's sanitizer, which judges the markup and not the path
/// grammar, so this function must terminate on every string. Two rules make
/// that true: every loop pass either consumes input or returns, and the pass
/// count is bounded by ``svgPathMaxCommands`` no matter what. Without them
/// `"M0 0 Z 5"` spun forever on the main actor — the `z` arm consumes nothing
/// and a number after it used to re-run `z` for ever.
func parseSVGPath(_ data: String) -> Path {
  var path = Path()
  let scanner = SVGPathScanner(data)
  var current = CGPoint.zero
  var subpathStart = CGPoint.zero
  var lastCommand: Character = " "
  /// The control point a smooth `S`/`s` reflects, set only by a cubic command.
  var lastCubicControl: CGPoint?
  /// The control point a smooth `T`/`t` reflects, set only by a quadratic one.
  var lastQuadControl: CGPoint?
  var commands = 0

  while let command = scanner.nextCommand(previous: lastCommand) {
    commands += 1
    // The belt to the "always consume" brace. A path long enough to hit this
    // is not a glyph, and drawing a prefix of it beats freezing the surface
    // that drew it.
    if commands > svgPathMaxCommands { return path }
    lastCommand = command
    let isRelative = command.isLowercase
    let letter = command.lowercased().first!
    // Only a cubic keeps a cubic reflection and only a quadratic keeps a
    // quadratic one, exactly as the SVG spec says: any other command makes the
    // next smooth curve reflect the current point instead.
    if letter != "c" && letter != "s" { lastCubicControl = nil }
    if letter != "q" && letter != "t" { lastQuadControl = nil }
    switch letter {
    case "m":
      guard let x = scanner.nextNumber(), let y = scanner.nextNumber() else { return path }
      current = isRelative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      path.move(to: current)
      subpathStart = current
      // Subsequent coordinate pairs after a moveto are implicit linetos.
    case "l":
      guard let x = scanner.nextNumber(), let y = scanner.nextNumber() else { return path }
      current = isRelative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      path.addLine(to: current)
    case "h":
      guard let x = scanner.nextNumber() else { return path }
      current = isRelative ? CGPoint(x: current.x + x, y: current.y) : CGPoint(x: x, y: current.y)
      path.addLine(to: current)
    case "v":
      guard let y = scanner.nextNumber() else { return path }
      current = isRelative ? CGPoint(x: current.x, y: current.y + y) : CGPoint(x: current.x, y: y)
      path.addLine(to: current)
    case "c":
      guard let x1 = scanner.nextNumber(), let y1 = scanner.nextNumber(),
            let x2 = scanner.nextNumber(), let y2 = scanner.nextNumber(),
            let x = scanner.nextNumber(), let y = scanner.nextNumber() else { return path }
      let c1 = isRelative ? CGPoint(x: current.x + x1, y: current.y + y1) : CGPoint(x: x1, y: y1)
      let c2 = isRelative ? CGPoint(x: current.x + x2, y: current.y + y2) : CGPoint(x: x2, y: y2)
      let end = isRelative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      path.addCurve(to: end, control1: c1, control2: c2)
      lastCubicControl = c2
      current = end
    case "s":
      guard let x2 = scanner.nextNumber(), let y2 = scanner.nextNumber(),
            let x = scanner.nextNumber(), let y = scanner.nextNumber() else { return path }
      let c1 = reflect(lastCubicControl, about: current)
      let c2 = isRelative ? CGPoint(x: current.x + x2, y: current.y + y2) : CGPoint(x: x2, y: y2)
      let end = isRelative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      path.addCurve(to: end, control1: c1, control2: c2)
      lastCubicControl = c2
      current = end
    case "q":
      guard let x1 = scanner.nextNumber(), let y1 = scanner.nextNumber(),
            let x = scanner.nextNumber(), let y = scanner.nextNumber() else { return path }
      let control = isRelative ? CGPoint(x: current.x + x1, y: current.y + y1) : CGPoint(x: x1, y: y1)
      let end = isRelative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      path.addQuadCurve(to: end, control: control)
      lastQuadControl = control
      current = end
    case "t":
      guard let x = scanner.nextNumber(), let y = scanner.nextNumber() else { return path }
      let control = reflect(lastQuadControl, about: current)
      let end = isRelative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      path.addQuadCurve(to: end, control: control)
      lastQuadControl = control
      current = end
    case "a":
      guard let rx = scanner.nextNumber(), let ry = scanner.nextNumber(),
            let _ = scanner.nextNumber(), // x-axis rotation (0 for the Linear glyph)
            let large = scanner.nextNumber(), let sweep = scanner.nextNumber(),
            let x = scanner.nextNumber(), let y = scanner.nextNumber() else { return path }
      let end = isRelative ? CGPoint(x: current.x + x, y: current.y + y) : CGPoint(x: x, y: y)
      appendArc(
        to: &path, from: current, to: end,
        rx: rx, ry: ry, largeArc: large != 0, sweep: sweep != 0
      )
      current = end
    case "z":
      path.closeSubpath()
      current = subpathStart
    default:
      return path
    }
  }
  return path
}

/// The most commands one glyph may spend before the parser gives up.
///
/// A sanitized `brand:*` path is capped at 4,096 characters and the shortest
/// legal command is two, so this cannot refuse a glyph the host accepted; it
/// exists only so a future change that reintroduces a non-consuming arm cannot
/// freeze the main actor again.
private let svgPathMaxCommands = 4_096

/// The smooth-curve reflection: the previous control mirrored through the
/// current point, or the current point itself when there is nothing to mirror.
private func reflect(_ control: CGPoint?, about current: CGPoint) -> CGPoint {
  guard let control else { return current }
  return CGPoint(x: 2 * current.x - control.x, y: 2 * current.y - control.y)
}

/// Endpoint → center parameterization for an axis-aligned elliptical arc,
/// emitted as ≤90° cubic bezier segments.
private func appendArc(
  to path: inout Path,
  from start: CGPoint,
  to end: CGPoint,
  rx rxIn: CGFloat,
  ry ryIn: CGFloat,
  largeArc: Bool,
  sweep: Bool
) {
  var rx = abs(rxIn)
  var ry = abs(ryIn)
  if rx == 0 || ry == 0 {
    path.addLine(to: end)
    return
  }
  let x1p = (start.x - end.x) / 2
  let y1p = (start.y - end.y) / 2

  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
  if lambda > 1 {
    let scale = lambda.squareRoot()
    rx *= scale
    ry *= scale
  }

  let rx2 = rx * rx
  let ry2 = ry * ry
  let num = max(0, rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p)
  let den = rx2 * y1p * y1p + ry2 * x1p * x1p
  var coef = den == 0 ? 0 : (num / den).squareRoot()
  if largeArc == sweep { coef = -coef }

  let cxp = coef * (rx * y1p / ry)
  let cyp = coef * -(ry * x1p / rx)
  let cx = cxp + (start.x + end.x) / 2
  let cy = cyp + (start.y + end.y) / 2

  let theta1 = atan2((y1p - cyp) / ry, (x1p - cxp) / rx)
  var deltaTheta = atan2((-y1p - cyp) / ry, (-x1p - cxp) / rx) - theta1
  if !sweep && deltaTheta > 0 { deltaTheta -= 2 * .pi }
  if sweep && deltaTheta < 0 { deltaTheta += 2 * .pi }

  let segments = max(1, Int(ceil(abs(deltaTheta) / (.pi / 2))))
  let delta = deltaTheta / CGFloat(segments)
  let t = (4.0 / 3.0) * tan(delta / 4)

  var angle = theta1
  for _ in 0..<segments {
    let a = angle
    let b = angle + delta
    let p0 = CGPoint(x: cx + rx * cos(a), y: cy + ry * sin(a))
    let p3 = CGPoint(x: cx + rx * cos(b), y: cy + ry * sin(b))
    let c1 = CGPoint(x: p0.x - t * rx * sin(a), y: p0.y + t * ry * cos(a))
    let c2 = CGPoint(x: p3.x + t * rx * sin(b), y: p3.y - t * ry * cos(b))
    path.addCurve(to: p3, control1: c1, control2: c2)
    angle = b
  }
}

/// Tokenizing cursor over SVG path data. Splits numbers (handling the compact
/// forms SVG allows: leading `.`, no separator before `-`, implicit command
/// repetition).
private final class SVGPathScanner {
  private let chars: [Character]
  private var index = 0

  init(_ data: String) {
    chars = Array(data)
  }

  private func skipSeparators() {
    while index < chars.count {
      let c = chars[index]
      if c == " " || c == "," || c == "\n" || c == "\t" || c == "\r" {
        index += 1
      } else {
        break
      }
    }
  }

  private func peek() -> Character? {
    skipSeparators()
    return index < chars.count ? chars[index] : nil
  }

  /// Returns the next command letter. When the next token is a number, repeats
  /// the previous command (implicit repetition), converting an implicit moveto
  /// repeat into a lineto per the SVG spec.
  ///
  /// Two previous commands refuse to repeat, and both refusals are what keeps
  /// the caller's loop finite. `" "` is "nothing has run yet", so a path that
  /// opens with a number is not a path. `z`/`Z` takes no arguments and consumes
  /// nothing, so repeating it on a trailing number — `"M0 0 Z 5"` — would hand
  /// the caller the same command for ever with the cursor never moving. The
  /// spec has no implicit repetition after a closepath either: a number there
  /// is malformed data, and stopping is what every other malformed arm does.
  func nextCommand(previous: Character) -> Character? {
    guard let c = peek() else { return nil }
    if c.isLetter {
      index += 1
      return c
    }
    // A number here means "repeat previous command".
    switch previous {
    case "M": return "L"
    case "m": return "l"
    case " ", "z", "Z": return nil
    default: return previous
    }
  }

  func nextNumber() -> CGFloat? {
    skipSeparators()
    guard index < chars.count else { return nil }
    let start = index
    var seenDot = false
    var seenDigit = false

    if chars[index] == "+" || chars[index] == "-" {
      index += 1
    }
    while index < chars.count {
      let c = chars[index]
      if c.isNumber {
        seenDigit = true
        index += 1
      } else if c == "." {
        if seenDot { break }
        seenDot = true
        index += 1
      } else if c == "e" || c == "E" {
        index += 1
        if index < chars.count, chars[index] == "+" || chars[index] == "-" {
          index += 1
        }
      } else {
        break
      }
    }
    guard seenDigit else {
      index = start
      return nil
    }
    let token = String(chars[start..<index])
    return Double(token).map { CGFloat($0) }
  }
}
