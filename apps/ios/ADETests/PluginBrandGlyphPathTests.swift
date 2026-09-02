import CoreGraphics
import SwiftUI
import XCTest
@testable import ADE

/// `parseSVGPath` against untrusted input.
///
/// It was written for one glyph ADE ships and is now reached by any mono SVG a
/// plugin declares under `brandIcons`. Two classes of failure matter: a path
/// that never terminates, and a path that draws a shorter shape here than it
/// does on the desktop.
final class PluginBrandGlyphPathTests: XCTestCase {

  /// A number after `Z` used to re-run the `z` arm for ever: `nextCommand`
  /// answered "repeat the previous command" and the `z` arm consumes no input,
  /// so the cursor never moved. On the main actor, with a plugin-supplied
  /// glyph, that is a frozen app.
  func testATrailingNumberAfterClosepathTerminates() {
    let finished = expectation(description: "the parser returned")
    Task.detached {
      _ = parseSVGPath("M0 0 L10 0 Z 5")
      _ = parseSVGPath("M0 0 z 1 2 3")
      _ = parseSVGPath("M0 0 Z Z 9")
      finished.fulfill()
    }
    wait(for: [finished], timeout: 5)
  }

  /// The other half of the termination rule: a path that opens with a number
  /// has no command to repeat, and one made only of separators has nothing at
  /// all. Neither may spin.
  func testMalformedPathsTerminateAndDrawNothing() {
    let finished = expectation(description: "the parser returned")
    Task.detached {
      for source in ["5 5 5", "   ", ",,,", "?!", "M", "M0"] {
        _ = parseSVGPath(source)
      }
      finished.fulfill()
    }
    wait(for: [finished], timeout: 5)
  }

  /// A closed subpath still closes, and the shape before the `Z` is kept.
  func testClosepathStillClosesTheSubpath() {
    let parsed = parseSVGPath("M0 0 L10 0 L10 10 Z")
    var expected = Path()
    expected.move(to: CGPoint(x: 0, y: 0))
    expected.addLine(to: CGPoint(x: 10, y: 0))
    expected.addLine(to: CGPoint(x: 10, y: 10))
    expected.closeSubpath()
    XCTAssertEqual(parsed.cgPath.boundingBox, expected.cgPath.boundingBox)
  }

  /// `Q` used to hit the `default:` arm and return the path built so far, so a
  /// glyph with one quadratic drew as far as its last lineto and stopped —
  /// whole on the desktop, cut off on the phone, with nothing saying why.
  func testQuadraticCurvesAreDrawn() {
    let parsed = parseSVGPath("M0 0 Q10 20 20 0")
    var expected = Path()
    expected.move(to: CGPoint(x: 0, y: 0))
    expected.addQuadCurve(to: CGPoint(x: 20, y: 0), control: CGPoint(x: 10, y: 20))
    XCTAssertEqual(parsed.cgPath.boundingBox, expected.cgPath.boundingBox)
    XCTAssertFalse(parsed.isEmpty)
  }

  /// `T` reflects the previous quadratic control point through the current
  /// point. A `T` with no quadratic before it uses the current point itself.
  func testSmoothQuadraticReflectsThePreviousControl() {
    let parsed = parseSVGPath("M0 0 Q10 20 20 0 T40 0")
    var expected = Path()
    expected.move(to: CGPoint(x: 0, y: 0))
    expected.addQuadCurve(to: CGPoint(x: 20, y: 0), control: CGPoint(x: 10, y: 20))
    // (10, 20) mirrored through (20, 0).
    expected.addQuadCurve(to: CGPoint(x: 40, y: 0), control: CGPoint(x: 30, y: -20))
    XCTAssertEqual(parsed.cgPath.boundingBox, expected.cgPath.boundingBox)
  }

  func testSmoothQuadraticWithNothingToReflectUsesTheCurrentPoint() {
    let parsed = parseSVGPath("M0 0 L10 0 T20 0")
    var expected = Path()
    expected.move(to: CGPoint(x: 0, y: 0))
    expected.addLine(to: CGPoint(x: 10, y: 0))
    expected.addQuadCurve(to: CGPoint(x: 20, y: 0), control: CGPoint(x: 10, y: 0))
    XCTAssertEqual(parsed.cgPath.boundingBox, expected.cgPath.boundingBox)
  }

  /// `S` reflects the previous CUBIC control point, and only a cubic sets one.
  func testSmoothCubicReflectsThePreviousControl() {
    let parsed = parseSVGPath("M0 0 C0 10 10 10 10 0 S20 -10 20 0")
    var expected = Path()
    expected.move(to: CGPoint(x: 0, y: 0))
    expected.addCurve(
      to: CGPoint(x: 10, y: 0),
      control1: CGPoint(x: 0, y: 10),
      control2: CGPoint(x: 10, y: 10)
    )
    // (10, 10) mirrored through (10, 0).
    expected.addCurve(
      to: CGPoint(x: 20, y: 0),
      control1: CGPoint(x: 10, y: -10),
      control2: CGPoint(x: 20, y: -10)
    )
    XCTAssertEqual(parsed.cgPath.boundingBox, expected.cgPath.boundingBox)
  }

  /// The relative forms draw the same shape as the absolute ones.
  func testRelativeQuadraticAndSmoothForms() {
    let absolute = parseSVGPath("M0 0 Q10 20 20 0 T40 0")
    let relative = parseSVGPath("m0 0 q10 20 20 0 t20 0")
    XCTAssertEqual(absolute.cgPath.boundingBox, relative.cgPath.boundingBox)
  }

  /// Implicit repetition still works for the curve commands: `Q` twice with one
  /// letter is two quadratics, not one and a stop.
  func testImplicitRepetitionOfAQuadratic() {
    let parsed = parseSVGPath("M0 0 Q10 20 20 0 30 -20 40 0")
    var expected = Path()
    expected.move(to: CGPoint(x: 0, y: 0))
    expected.addQuadCurve(to: CGPoint(x: 20, y: 0), control: CGPoint(x: 10, y: 20))
    expected.addQuadCurve(to: CGPoint(x: 40, y: 0), control: CGPoint(x: 30, y: -20))
    XCTAssertEqual(parsed.cgPath.boundingBox, expected.cgPath.boundingBox)
  }
}
