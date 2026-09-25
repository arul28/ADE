import AVFoundation
import CoreMedia
import CoreGraphics
import Foundation

/// The pure half of the live view: Annex-B framing in, AVCC framing out.
///
/// The host pushes H.264 Annex-B access units — start codes in front of every
/// NAL, and SPS/PPS repeated in front of every keyframe. `AVSampleBufferDisplayLayer`
/// wants AVCC: one length prefix per NAL and a parameter-set-bearing
/// `CMVideoFormatDescription`. Everything here is synchronous and testable
/// without a decoder or a socket.
enum MacDesktopAnnexB {
  /// Splits an Annex-B byte stream into NAL units, accepting both 3- and
  /// 4-byte start codes.
  ///
  /// A 4-byte code's leading zero belongs to the code, not to the NAL before
  /// it, so it is trimmed; leaving it on an SPS or PPS is the kind of stray
  /// byte a hardware decoder can reject outright.
  static func nalUnits(in data: Data) -> [[UInt8]] {
    let bytes = [UInt8](data)
    var units: [[UInt8]] = []
    var unitStart: Int?
    var index = 0
    while index + 2 < bytes.count {
      guard bytes[index] == 0, bytes[index + 1] == 0, bytes[index + 2] == 1 else {
        index += 1
        continue
      }
      var codeStart = index
      if codeStart > 0, bytes[codeStart - 1] == 0 {
        codeStart -= 1
      }
      if let start = unitStart, start <= codeStart {
        units.append(Array(bytes[start..<codeStart]))
      }
      unitStart = index + 3
      index += 3
    }
    if let start = unitStart, start < bytes.count {
      units.append(Array(bytes[start...]))
    }
    return units.filter { !$0.isEmpty }
  }

  /// The `nal_unit_type` from a NAL unit's first byte.
  static func nalUnitType(_ unit: [UInt8]) -> UInt8? {
    unit.first.map { $0 & 0x1F }
  }

  /// The first SPS and PPS in an access unit, when the host repeated them in
  /// front of a keyframe.
  static func parameterSets(in units: [[UInt8]]) -> (sps: [UInt8], pps: [UInt8])? {
    guard
      let sps = units.first(where: { nalUnitType($0) == 7 }),
      let pps = units.first(where: { nalUnitType($0) == 8 })
    else { return nil }
    return (sps, pps)
  }

  /// Rewrites an Annex-B access unit as AVCC: every NAL prefixed with its
  /// big-endian 32-bit length.
  ///
  /// Parameter sets are excluded by default because they travel in the format
  /// description; a decoder reading an access unit that repeats them is not
  /// wrong, but republishing the format description per keyframe is wasted
  /// work on a path that runs whenever the picture changes.
  static func avccAccessUnit(
    fromAnnexB data: Data,
    excludingParameterSets: Bool = true
  ) -> Data {
    var output = Data()
    for unit in nalUnits(in: data) {
      if excludingParameterSets, let type = nalUnitType(unit), type == 7 || type == 8 {
        continue
      }
      var length = UInt32(unit.count).bigEndian
      withUnsafeBytes(of: &length) { output.append(contentsOf: $0) }
      output.append(contentsOf: unit)
    }
    return output
  }

  /// Builds the H.264 format description VideoToolbox decodes against.
  static func formatDescription(sps: [UInt8], pps: [UInt8]) -> CMVideoFormatDescription? {
    guard !sps.isEmpty, !pps.isEmpty else { return nil }
    var format: CMVideoFormatDescription?
    sps.withUnsafeBufferPointer { spsBuffer in
      pps.withUnsafeBufferPointer { ppsBuffer in
        guard
          let spsBase = spsBuffer.baseAddress,
          let ppsBase = ppsBuffer.baseAddress
        else { return }
        let pointers: [UnsafePointer<UInt8>] = [spsBase, ppsBase]
        let sizes: [Int] = [spsBuffer.count, ppsBuffer.count]
        let status = CMVideoFormatDescriptionCreateFromH264ParameterSets(
          allocator: kCFAllocatorDefault,
          parameterSetCount: pointers.count,
          parameterSetPointers: pointers,
          parameterSetSizes: sizes,
          nalUnitHeaderLength: 4,
          formatDescriptionOut: &format
        )
        if status != noErr { format = nil }
      }
    }
    return format
  }
}

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
