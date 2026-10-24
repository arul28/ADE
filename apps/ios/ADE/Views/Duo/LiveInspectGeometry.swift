import SwiftUI
import UIKit

// MARK: - Geometry (port of appleInspectGeometry.ts)

enum LiveInspectGeometry {
  static func frameText(_ frame: LiveInspectFrame) -> String {
    "x=\(Int(frame.x.rounded())), y=\(Int(frame.y.rounded())), w=\(Int(frame.width.rounded())), h=\(Int(frame.height.rounded()))"
  }

  static func contains(_ frame: CGRect, point: CGPoint) -> Bool {
    guard frame.width > 0, frame.height > 0 else { return false }
    return point.x >= frame.minX && point.x <= frame.maxX
      && point.y >= frame.minY && point.y <= frame.maxY
  }

  static func contains(_ outer: CGRect, _ inner: CGRect) -> Bool {
    guard outer.width * outer.height > inner.width * inner.height else { return false }
    return inner.minX >= outer.minX && inner.minY >= outer.minY
      && inner.maxX <= outer.maxX && inner.maxY <= outer.maxY
  }

  /// Smallest-area hit under a point. Equal areas keep the later snapshot
  /// index, so a later sibling painted on top of an equal-size peer wins.
  static func hitTest(_ elements: [LiveInspectElement], point: CGPoint) -> LiveInspectElement? {
    var best: LiveInspectElement?
    var bestArea = CGFloat.infinity
    var bestIndex = -1
    for (index, element) in elements.enumerated() {
      guard contains(element.imageFrame, point: point) else { continue }
      let area = max(0, element.imageFrame.width) * max(0, element.imageFrame.height)
      if area < bestArea || (area == bestArea && index > bestIndex) {
        best = element
        bestArea = area
        bestIndex = index
      }
    }
    return best
  }

  /// Ancestors nearest-first, by containment: the smallest enclosing frame is
  /// the parent. The simulator snapshot carries no parent ids.
  static func ancestors(of element: LiveInspectElement, in elements: [LiveInspectElement]) -> [LiveInspectElement] {
    var chain: [LiveInspectElement] = []
    var seen: Set<String> = [element.id]
    var current = element
    while true {
      var parent: LiveInspectElement?
      var parentArea = CGFloat.infinity
      for candidate in elements where candidate.id != current.id {
        guard contains(candidate.imageFrame, current.imageFrame) else { continue }
        let area = candidate.imageFrame.width * candidate.imageFrame.height
        if area < parentArea {
          parent = candidate
          parentArea = area
        }
      }
      guard let next = parent, !seen.contains(next.id) else { break }
      chain.append(next)
      seen.insert(next.id)
      current = next
    }
    return chain
  }

  static func relation(of other: LiveInspectElement, to element: LiveInspectElement) -> String {
    if contains(other.imageFrame, element.imageFrame) { return "ancestor-or-container" }
    if contains(element.imageFrame, other.imageFrame) { return "descendant" }
    return "nearby"
  }

  static func nearbyByOverlap(_ element: LiveInspectElement, in elements: [LiveInspectElement]) -> [LiveInspectElement] {
    elements
      .filter { $0.id != element.id }
      .sorted { left, right in
        intersection(left.imageFrame, element.imageFrame) > intersection(right.imageFrame, element.imageFrame)
      }
      .prefix(8)
      .map { $0 }
  }

  static func nearbyByDistance(_ element: LiveInspectElement, in elements: [LiveInspectElement]) -> [LiveInspectElement] {
    let center = CGPoint(x: element.imageFrame.midX, y: element.imageFrame.midY)
    return elements
      .filter { $0.id != element.id }
      .sorted { left, right in
        distance(left.imageFrame, center) < distance(right.imageFrame, center)
      }
      .prefix(8)
      .map { $0 }
  }

  private static func distance(_ frame: CGRect, _ point: CGPoint) -> CGFloat {
    hypot(frame.midX - point.x, frame.midY - point.y)
  }

  private static func intersection(_ a: CGRect, _ b: CGRect) -> CGFloat {
    let rect = a.intersection(b)
    guard !rect.isNull else { return 0 }
    return max(0, rect.width) * max(0, rect.height)
  }

  /// The aspect-fit rect a picture of `pixelSize` takes inside `container`.
  static func fit(pixelSize: CGSize, in container: CGSize) -> CGRect {
    guard container.width > 0, container.height > 0,
          pixelSize.width > 0, pixelSize.height > 0 else { return .zero }
    let scale = min(container.width / pixelSize.width, container.height / pixelSize.height)
    let size = CGSize(width: pixelSize.width * scale, height: pixelSize.height * scale)
    return CGRect(
      x: (container.width - size.width) / 2,
      y: (container.height - size.height) / 2,
      width: size.width,
      height: size.height
    )
  }

  /// A point on the displayed picture, back to frozen-image pixels.
  static func imagePoint(_ point: CGPoint, in rect: CGRect, pixelSize: CGSize) -> CGPoint? {
    guard rect.width > 0, rect.height > 0, pixelSize.width > 0, pixelSize.height > 0 else { return nil }
    guard rect.insetBy(dx: -1, dy: -1).contains(point) else { return nil }
    return CGPoint(
      x: (point.x - rect.minX) / rect.width * pixelSize.width,
      y: (point.y - rect.minY) / rect.height * pixelSize.height
    )
  }
}

// MARK: - Drawing

enum LiveInspectDrawing {
  static func lineWidth(for imageSize: CGSize) -> CGFloat {
    max(3, imageSize.width * 0.006)
  }

  /// The path of one stroke, in image pixels.
  static func path(for stroke: LiveInspectStroke, imageSize: CGSize) -> Path {
    var path = Path()
    guard let first = stroke.points.first else { return path }
    switch stroke.tool {
    case .pen:
      if stroke.points.count == 1 {
        let radius = lineWidth(for: imageSize) / 2
        path.addEllipse(in: CGRect(x: first.x - radius, y: first.y - radius, width: radius * 2, height: radius * 2))
        return path
      }
      path.move(to: first)
      for point in stroke.points.dropFirst() {
        path.addLine(to: point)
      }
    case .arrow:
      guard let last = stroke.points.last else { return path }
      path.move(to: first)
      path.addLine(to: last)
      let angle = atan2(last.y - first.y, last.x - first.x)
      let length = max(18, lineWidth(for: imageSize) * 3.4)
      for offset in [CGFloat.pi * 0.78, -CGFloat.pi * 0.78] {
        path.move(to: last)
        path.addLine(to: CGPoint(
          x: last.x + cos(angle + offset) * length,
          y: last.y + sin(angle + offset) * length
        ))
      }
    case .circle:
      guard let last = stroke.points.last else { return path }
      let rect = CGRect(
        x: min(first.x, last.x),
        y: min(first.y, last.y),
        width: abs(last.x - first.x),
        height: abs(last.y - first.y)
      )
      path.addEllipse(in: rect)
    case .select:
      break
    }
    return path
  }

  /// Draws one stroke into a UIKit context, in the context's own pixels.
  static func stroke(_ stroke: LiveInspectStroke, in context: CGContext, imageSize: CGSize) {
    let path = path(for: stroke, imageSize: imageSize)
    guard !path.isEmpty else { return }
    let width = lineWidth(for: imageSize)
    let cgPath = path.cgPath
    context.saveGState()
    context.setLineCap(.round)
    context.setLineJoin(.round)
    // A pale halo under the ink so a mark reads on a white Settings screen and
    // on a dark editor alike.
    context.setStrokeColor(UIColor.white.withAlphaComponent(0.9).cgColor)
    context.setLineWidth(width + max(2, width * 0.5))
    context.addPath(cgPath)
    context.strokePath()
    context.setStrokeColor(LiveInspectInk.uiColor.cgColor)
    context.setLineWidth(width)
    context.addPath(cgPath)
    context.strokePath()
    context.restoreGState()
  }
}

enum LiveInspectImage {
  static func image(fromDataURL dataUrl: String) -> UIImage? {
    let base64: String
    if let comma = dataUrl.firstIndex(of: ",") {
      base64 = String(dataUrl[dataUrl.index(after: comma)...])
    } else {
      base64 = dataUrl
    }
    guard let data = Data(base64Encoded: base64), !data.isEmpty else { return nil }
    return UIImage(data: data)
  }

  static func pixelSize(of image: UIImage) -> CGSize {
    if let cgImage = image.cgImage {
      return CGSize(width: cgImage.width, height: cgImage.height)
    }
    return CGSize(width: image.size.width * image.scale, height: image.size.height * image.scale)
  }
}

enum LiveInspectPacket {
  static var now: String {
    ISO8601DateFormatter().string(from: Date())
  }

  /// `JSON.stringify(packet, null, 2)`'s shape: sorted keys keep two sends of
  /// the same element identical, which is what makes a packet diffable.
  static func json(_ packet: [String: Any]) -> String {
    guard JSONSerialization.isValidJSONObject(packet),
          let data = try? JSONSerialization.data(
            withJSONObject: packet,
            options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
          ),
          let text = String(data: data, encoding: .utf8) else {
      return "{}"
    }
    return text
  }
}
