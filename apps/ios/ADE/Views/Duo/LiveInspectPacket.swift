import UIKit

extension LiveInspectMarkupModel {
  // MARK: Export

  /// The still with every stroke drawn on it, at the picture's own pixel size.
  func exportedImage() -> UIImage? {
    guard let image, pixelSize.width > 0, pixelSize.height > 0 else { return nil }
    guard !strokes.isEmpty else { return image }
    let format = UIGraphicsImageRendererFormat.default()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: pixelSize, format: format)
    return renderer.image { context in
      image.draw(in: CGRect(origin: .zero, size: pixelSize))
      let cg = context.cgContext
      for stroke in strokes {
        LiveInspectDrawing.stroke(stroke, in: cg, imageSize: pixelSize)
      }
    }
  }

  /// One add's text block, in `visualContextFormatting.ts`'s shape: the
  /// surface preamble (first add of a session only), then the numbered row and
  /// its pretty JSON packet.
  func elementBlock(_ element: LiveInspectElement, number: Int, preamble: Bool) -> String {
    var lines: [String] = []
    if preamble {
      lines.append(packetPreamble)
      lines.append("")
    }
    lines.append("\(number). \(element.displayTitle) (\(sourceText(element)), frame=\(element.frameLabel))")
    lines.append("Packet:")
    lines.append(LiveInspectPacket.json(packet(for: element)))
    return lines.joined(separator: "\n")
  }

  /// The text that goes with a marked-up picture attached at Done when no
  /// element was added.
  var markupBlock: String {
    [
      surface.packetName,
      "The attached picture is the frozen \(surface.title) screen with the user's markup drawn on it.",
    ].joined(separator: "\n")
  }

  private var packetPreamble: String {
    switch surface {
    case .simulator:
      return [
        surface.packetName,
        "Each packet came from the user clicking a UI element in the real iOS Simulator. Image attachments are visual evidence for the same packet and use the same screenshot coordinate space.",
        "Use exactSource when sourceConfidence is exact. Treat sourceCandidates as ranked best guesses, not proof; prefer nearbyElements and the screenshot when the source is missing or only candidate quality.",
        "The attached picture is the frozen screen; any marks drawn on it are the user's markup.",
      ].joined(separator: "\n")
    case .android:
      return [
        surface.packetName,
        "Each packet came from the user clicking a UI element on the lane's real Android emulator. Frames are the emulator's screen pixels, the same space as the attached picture.",
        "The element's identifier is its resource id; ref is the id `ade android tap-element --ref` takes. Android views carry no source file: search the app's layouts and Compose code for the resource id or the text.",
        "The attached picture is the frozen screen; any marks drawn on it are the user's markup.",
      ].joined(separator: "\n")
    case .appControl:
      return [
        surface.packetName,
        "Each packet came from a developer-owned app session, usually Electron launched or connected through ADE CLI with a local CDP port. Image attachments are visual evidence for the same packet and use the frozen frame's pixel space.",
        "Use exactSource when sourceConfidence is exact. Treat sourceCandidates as ranked guesses from DOM text/test ids/selectors and source search, not proof. Prefer the screenshot, DOM selector, and exact source when available.",
        "The attached picture is the frozen frame; any marks drawn on it are the user's markup.",
      ].joined(separator: "\n")
    case .macDesktop:
      return [
        surface.packetName,
        "Each packet came from the user clicking an accessibility element on the lane's private macOS screen while the picture was frozen. Image attachments use the same screen-pixel space as the element frames.",
        "Accessibility elements carry no source file. Prefer the picture and the element's role, title, and frame; a truncated walk means the element under the finger may be missing.",
        "The attached picture is the frozen screen; any marks drawn on it are the user's markup.",
      ].joined(separator: "\n")
    }
  }

  private func sourceText(_ element: LiveInspectElement) -> String {
    if let source = element.sourceLabel { return source }
    return element.sourceConfidence == "candidate"
      ? "no exact source; ranked candidates below"
      : "no source match"
  }

  private func packet(for element: LiveInspectElement) -> [String: Any] {
    var packet: [String: Any] = [:]
    packet["contextId"] = "\(surface.rawValue):\(element.id)"
    packet["surface"] = surface.rawValue
    packet["visualAttachmentPath"] = NSNull()
    packet["selectedAt"] = LiveInspectPacket.now
    packet["screen"] = screen?.packet ?? [:]
    packet["sourceConfidence"] = element.sourceConfidence ?? (element.sourceFile != nil ? "exact" : "none")
    if let source = element.sourceLabel {
      var exact: [String: Any] = ["sourceFile": element.sourceFile ?? source]
      if let line = element.sourceLine { exact["sourceLine"] = line }
      packet["exactSource"] = exact
    } else {
      packet["exactSource"] = NSNull()
    }
    packet["sourceCandidates"] = []
    packet["nearbyElements"] = nearbyElements(for: element)
    switch surface {
    case .simulator:
      var selected: [String: Any] = [
        "componentId": element.componentId ?? element.id,
        "accessibilityIdentifier": element.identifier ?? NSNull(),
      ]
      selected["label"] = element.label ?? NSNull()
      selected["value"] = element.value ?? NSNull()
      selected["role"] = element.role ?? NSNull()
      selected["elementType"] = element.elementType ?? NSNull()
      selected["screenshotFrame"] = packetFrame(element.frame)
      packet["selectedElement"] = selected
    case .android:
      var selected: [String: Any] = [
        "ref": element.id,
        "resourceId": element.componentId ?? NSNull(),
        "identifier": element.identifier ?? NSNull(),
      ]
      selected["label"] = element.label ?? NSNull()
      selected["text"] = element.value ?? NSNull()
      selected["role"] = element.role ?? NSNull()
      selected["className"] = element.elementType ?? NSNull()
      selected["screenshotFrame"] = packetFrame(element.frame)
      packet["selectedElement"] = selected
    case .appControl:
      packet["appKind"] = "electron"
      packet["provider"] = element.role ?? "cdp"
      packet["url"] = NSNull()
      packet["title"] = NSNull()
      var selected: [String: Any] = [
        "componentId": element.componentId ?? element.id,
        "tagName": element.elementType ?? NSNull(),
      ]
      selected["label"] = element.label ?? NSNull()
      selected["value"] = element.value ?? NSNull()
      selected["role"] = element.role ?? NSNull()
      selected["screenshotFrame"] = packetFrame(element.frame)
      packet["selectedElement"] = selected
    case .macDesktop:
      var selected: [String: Any] = [
        "role": element.role ?? NSNull(),
        "subrole": element.subrole ?? NSNull(),
        "label": element.label ?? NSNull(),
        "value": element.value ?? NSNull(),
        "identifier": element.identifier ?? NSNull(),
      ]
      if let enabled = element.enabled { selected["enabled"] = enabled }
      selected["screenshotFrame"] = packetFrame(element.frame)
      packet["selectedElement"] = selected
    }
    return packet
  }

  private func packetFrame(_ frame: LiveInspectFrame) -> [String: Any] {
    [
      "x": frame.x,
      "y": frame.y,
      "width": frame.width,
      "height": frame.height,
    ]
  }

  private func nearbyElements(for element: LiveInspectElement) -> [[String: Any]] {
    let nearby: [LiveInspectElement]
    switch surface {
    case .simulator, .android:
      nearby = LiveInspectGeometry.nearbyByOverlap(element, in: elements)
    case .appControl, .macDesktop:
      nearby = LiveInspectGeometry.nearbyByDistance(element, in: elements)
    }
    return nearby.prefix(8).map { other in
      var row: [String: Any] = [
        "label": other.label ?? NSNull(),
        "value": other.value ?? NSNull(),
        "role": other.role ?? NSNull(),
        "elementType": other.elementType ?? NSNull(),
        "identifier": other.identifier ?? NSNull(),
        "componentId": other.componentId ?? NSNull(),
        "source": other.sourceLabel ?? NSNull(),
        "screenshotFrame": packetFrame(other.frame),
      ]
      if surface.isPhoneScreen {
        row["relation"] = LiveInspectGeometry.relation(of: other, to: element)
      }
      return row
    }
  }
}
