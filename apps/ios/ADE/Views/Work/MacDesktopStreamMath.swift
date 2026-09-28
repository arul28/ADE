import CoreGraphics
import Foundation

/// View pixels to a point on the host's global plane.
///
/// The same letterbox rule as `macDesktopGeometry.ts`: a finger in the black
/// bars is not a click, and the display's origin is added because `CGEvent`
/// posts on the global plane. A missing or zero size returns nil rather than
/// clamping onto the person's real screen.
enum MacDesktopGeometry {
  static func displayPoint(
    localX: Double,
    localY: Double,
    view: MacDesktopViewRect,
    display: MacDesktopDisplayGeometry
  ) -> MacDesktopPoint? {
    guard view.width > 0, view.height > 0, display.width > 0, display.height > 0 else { return nil }
    let scale = min(view.width / display.width, view.height / display.height)
    let drawnWidth = display.width * scale
    let drawnHeight = display.height * scale
    let x = localX - (view.width - drawnWidth) / 2
    let y = localY - (view.height - drawnHeight) / 2
    guard x >= 0, y >= 0, x <= drawnWidth, y <= drawnHeight else { return nil }
    return MacDesktopPoint(x: display.originX + x / scale, y: display.originY + y / scale)
  }
}

/// Watch-mode zoom on the full-screen picture.
///
/// The picture scales about its center, then moves by `offset`. Both are in
/// the picture's own unscaled points, which is also the space the gestures
/// report in. A pan stops where an edge of the zoomed picture meets an edge
/// of the viewport: the screen area the picture may fill. With no viewport
/// that is the picture's own frame, so it always covers the frame.
struct MacDesktopZoom: Equatable {
  static let minScale: CGFloat = 1
  static let maxScale: CGFloat = 4
  static let doubleTapScale: CGFloat = 2.5
  static let identity = MacDesktopZoom(scale: 1, offset: .zero)

  var scale: CGFloat
  var offset: CGSize

  var isZoomed: Bool { scale > Self.minScale + 0.001 }

  static func clampScale(_ scale: CGFloat) -> CGFloat {
    guard scale.isFinite else { return minScale }
    return min(max(scale, minScale), maxScale)
  }

  /// How far the zoomed picture may move from center on each axis: until its
  /// edge meets the viewport's edge. A picture narrower than the viewport at
  /// this scale stays centered on that axis.
  static func offsetLimits(scale: CGFloat, in size: CGSize, viewport: CGSize? = nil) -> CGSize {
    let area = viewport ?? size
    return CGSize(
      width: max(0, (scale * size.width - area.width) / 2),
      height: max(0, (scale * size.height - area.height) / 2)
    )
  }

  /// The largest move that keeps each edge of the zoomed picture on or past
  /// the edge of the viewport (the frame when there is none).
  static func clampOffset(_ offset: CGSize, scale: CGFloat, in size: CGSize, viewport: CGSize? = nil) -> CGSize {
    let limit = offsetLimits(scale: scale, in: size, viewport: viewport)
    return CGSize(
      width: min(max(offset.width, -limit.width), limit.width),
      height: min(max(offset.height, -limit.height), limit.height)
    )
  }

  /// A value past `limit` moves at a fraction of the finger, so an edge or a
  /// scale limit gives a little under the finger instead of stopping dead.
  /// The gesture's end settles the value back inside the limit.
  static func rubberBand(_ value: CGFloat, limit: CGFloat, resistance: CGFloat = 0.35) -> CGFloat {
    let magnitude = abs(value)
    guard magnitude > limit else { return value }
    let eased = limit + (magnitude - limit) * resistance
    return value < 0 ? -eased : eased
  }

  /// Scales by `factor` and keeps the content under `point` where it is,
  /// as far as the clamps allow.
  func magnified(by factor: CGFloat, around point: CGPoint, in size: CGSize, viewport: CGSize? = nil) -> MacDesktopZoom {
    guard factor.isFinite, factor > 0, size.width > 0, size.height > 0 else { return self }
    let next = Self.clampScale(scale * factor)
    let ratio = next / scale
    let dx = point.x - size.width / 2
    let dy = point.y - size.height / 2
    let moved = CGSize(
      width: dx - (dx - offset.width) * ratio,
      height: dy - (dy - offset.height) * ratio
    )
    return MacDesktopZoom(scale: next, offset: Self.clampOffset(moved, scale: next, in: size, viewport: viewport))
  }

  /// Moves a zoomed picture. An unzoomed picture does not move.
  func panned(by delta: CGSize, in size: CGSize, viewport: CGSize? = nil) -> MacDesktopZoom {
    guard isZoomed else { return self }
    let moved = CGSize(width: offset.width + delta.width, height: offset.height + delta.height)
    return MacDesktopZoom(scale: scale, offset: Self.clampOffset(moved, scale: scale, in: size, viewport: viewport))
  }

  /// Double tap: 2.5x at the tapped point from 1x, and back to 1x from any zoom.
  func toggled(at point: CGPoint, in size: CGSize, viewport: CGSize? = nil) -> MacDesktopZoom {
    if isZoomed { return .identity }
    return Self.identity.magnified(by: Self.doubleTapScale, around: point, in: size, viewport: viewport)
  }

  /// The same zoom with its scale and offset back inside their limits.
  func settled(in size: CGSize, viewport: CGSize? = nil) -> MacDesktopZoom {
    let nextScale = Self.clampScale(scale)
    return MacDesktopZoom(
      scale: nextScale,
      offset: Self.clampOffset(offset, scale: nextScale, in: size, viewport: viewport)
    )
  }
}

/// What one finger-up, or Escape, asks the host to do.
