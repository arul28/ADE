import SwiftUI
import UIKit

// MARK: - Wire models

/// A rect on the wire. Kept as doubles so one type fits every surface: the
/// simulator sends pixels, App Control screenshot pixels, Mac Desktop global
/// display points.
struct LiveInspectFrame: Codable, Equatable {
  var x: Double
  var y: Double
  var width: Double
  var height: Double

  var rect: CGRect { CGRect(x: x, y: y, width: width, height: height) }

  init(x: Double, y: Double, width: Double, height: Double) {
    self.x = x
    self.y = y
    self.width = width
    self.height = height
  }

  init(_ rect: CGRect) {
    self.init(
      x: Double(rect.origin.x),
      y: Double(rect.origin.y),
      width: Double(rect.width),
      height: Double(rect.height)
    )
  }

  /// The same rect scaled into another pixel space.
  func scaled(by factor: CGSize) -> CGRect {
    CGRect(
      x: x * Double(factor.width),
      y: y * Double(factor.height),
      width: width * Double(factor.width),
      height: height * Double(factor.height)
    )
  }
}

/// The screen the element frames are in. `viewport` is App Control's CSS
/// viewport; nil for the other surfaces.
struct LiveInspectScreen: Equatable {
  var width: Double
  var height: Double
  var scale: Double
  var viewportWidth: Double?
  var viewportHeight: Double?

  var size: CGSize { CGSize(width: width, height: height) }

  var label: String {
    let w = Int(width.rounded())
    let h = Int(height.rounded())
    return "\(w) × \(h)"
  }

  var packet: [String: Any] {
    var out: [String: Any] = ["width": width, "height": height, "scale": scale]
    if let viewportWidth { out["viewportWidth"] = viewportWidth }
    if let viewportHeight { out["viewportHeight"] = viewportHeight }
    return out
  }
}

/// One element on the frozen picture.
///
/// `frame` is the surface's own frame (what the desktop packet reports as
/// `screenshotFrame`), `pointFrame` the device-point frame the simulator
/// inspector also carries, and `imageFrame` the rect on the frozen image the
/// overlay and hit-test use. They differ whenever the frozen image is not the
/// host's full-fidelity screenshot, which is always true for App Control.
struct LiveInspectElement: Identifiable, Equatable {
  var id: String
  var label: String?
  var value: String?
  var role: String?
  var elementType: String?
  var subrole: String?
  var identifier: String?
  var componentId: String?
  var sourceFile: String?
  var sourceLine: Int?
  var sourceConfidence: String?
  var enabled: Bool?
  var focused: Bool?
  var frame: LiveInspectFrame
  var pointFrame: LiveInspectFrame?
  var imageFrame: CGRect

  var sourceLabel: String? {
    guard let file = sourceFile?.liveInspectTrimmed else { return nil }
    if let sourceLine { return "\(file):\(sourceLine)" }
    return file
  }

  /// The strongest name this element has, matching `describeElement`.
  var displayTitle: String {
    for candidate in [label, identifier, componentId, value, elementType, role] {
      if let text = candidate?.liveInspectTrimmed { return text }
    }
    return id
  }

  var displaySubtitle: String {
    var parts: [String] = []
    if let role = (role ?? elementType)?.liveInspectTrimmed {
      parts.append(role)
    }
    if let subrole = subrole?.liveInspectTrimmed {
      parts.append(subrole)
    }
    if let identifier = identifier?.liveInspectTrimmed, identifier != displayTitle {
      parts.append("#\(identifier)")
    }
    return parts.joined(separator: " · ")
  }

  var frameLabel: String {
    LiveInspectGeometry.frameText(pointFrame ?? frame)
  }

  var hasIdentity: Bool {
    identifier?.liveInspectTrimmed != nil || componentId?.liveInspectTrimmed != nil
  }
}

/// The `ios_simulator.getScreenSnapshot` reply, only the fields the frozen
/// inspector draws. Everything else on the wire is ignored by Codable.
struct LiveInspectIosSnapshot: Decodable {
  struct Screenshot: Decodable {
    var dataUrl: String
    var width: Double?
    var height: Double?
  }

  struct Screen: Decodable {
    var width: Double?
    var height: Double?
    var scale: Double?
  }

  struct Element: Decodable {
    var id: String
    var label: String?
    var value: String?
    var role: String?
    var elementType: String?
    var identifier: String?
    var componentId: String?
    var sourceFile: String?
    var sourceLine: Int?
    var frame: LiveInspectFrame
    var pixelFrame: LiveInspectFrame?
  }

  var screenshot: Screenshot
  var screen: Screen?
  var elements: [Element]
}

/// The phone-sized projection of `appControl.inspectPoint`.
struct LiveInspectAppControlReply: Decodable {
  struct Item: Decodable {
    var id: String?
    var provider: String?
    var componentId: String?
    var sourceFile: String?
    var sourceLine: Int?
    var frame: LiveInspectFrame?
    var selectedAt: String?
    var label: String?
    var value: String?
    var role: String?
    var tagName: String?
    var selector: String?
    var testId: String?
    var sourceConfidence: String?
  }

  struct Screen: Decodable {
    var width: Double?
    var height: Double?
    var scale: Double?
    var viewportWidth: Double?
    var viewportHeight: Double?
    var scaleX: Double?
    var scaleY: Double?
  }

  struct Snapshot: Decodable {
    var screen: Screen?
    var url: String?
    var title: String?
  }

  var source: String?
  var item: Item?
  var snapshot: Snapshot?
}

/// The phone-sized projection of `macDesktop.observe`.
struct LiveInspectMacDesktopReply: Decodable {
  struct Display: Decodable {
    var width: Double
    var height: Double
    var scale: Double?
    var originX: Double?
    var originY: Double?
  }

  struct Element: Decodable {
    var index: Int?
    var role: String?
    var subrole: String?
    var title: String?
    var label: String?
    var value: String?
    var identifier: String?
    var enabled: Bool?
    var focused: Bool?
    var frame: LiveInspectFrame
  }

  struct Observation: Decodable {
    var id: String?
    var capturedAt: String?
    var screenshotPath: String
    var display: Display
    var elements: [Element]
    var elementCount: Int?
    var truncated: Bool?
    var truncatedReason: String?
    var caption: String?
  }

  var observation: Observation
}

// MARK: - Sync commands

extension SyncService {
  /// One still plus every element the lane's simulator can name, for the frozen
  /// inspect view.
  ///
  /// `getScreenSnapshot` and not `inspectPoint`: the latter is ownership-guarded
  /// and opens the inspector drawer on the Mac that owns the device, which a
  /// phone that is only looking should not do. `proof: false` keeps an inspect
  /// from filing a proof row nobody asked for.
  func fetchLiveInspectSimulatorSnapshot(laneId: String) async throws -> LiveInspectIosSnapshot {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard supportsAppleDeviceControl(laneId: trimmed) else {
      throw NSError(
        domain: "ADE",
        code: 17,
        userInfo: [
          NSLocalizedDescriptionKey: "Update ADE on your Mac to inspect its simulator from here.",
          "ADEErrorCode": "unsupported_action",
        ]
      )
    }
    return try decode(
      try await sendCommand(
        action: "apple.invoke",
        args: [
          "method": "getScreenSnapshot",
          "laneId": trimmed,
          "args": ["proof": false],
        ],
        disconnectOnTimeout: false,
        timeoutNanoseconds: 20_000_000_000
      ),
      as: LiveInspectIosSnapshot.self
    )
  }

  /// One host-side hit-test on the lane's App Control frame.
  func appControlInspectPoint(laneId: String, x: Double, y: Double) async throws -> LiveInspectAppControlReply {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard supportsViewerRemoteAction("appControl.inspectPoint") else {
      throw NSError(
        domain: "ADE",
        code: 17,
        userInfo: [
          NSLocalizedDescriptionKey: "Update ADE on your Mac to inspect its app from here.",
          "ADEErrorCode": "unsupported_action",
        ]
      )
    }
    return try decode(
      try await sendCommand(
        action: "appControl.inspectPoint",
        args: [
          "laneId": trimmed,
          "x": x,
          "y": y,
          "coordinateSpace": "viewport",
        ],
        disconnectOnTimeout: false,
        timeoutNanoseconds: 20_000_000_000
      ),
      as: LiveInspectAppControlReply.self
    )
  }

  /// One accessibility observation of the lane's desktop, for the frozen
  /// inspect view. The picture follows through `readWorkToolsObservationPreview`
  /// with the path in the reply.
  func macDesktopObserve(laneId: String, limit: Int = 200) async throws -> LiveInspectMacDesktopReply {
    let trimmed = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard supportsViewerRemoteAction("macDesktop.observe") else {
      throw NSError(
        domain: "ADE",
        code: 17,
        userInfo: [
          NSLocalizedDescriptionKey: "Update ADE on your Mac to inspect its desktop from here.",
          "ADEErrorCode": "unsupported_action",
        ]
      )
    }
    return try decode(
      try await sendCommand(
        action: "macDesktop.observe",
        args: ["laneId": trimmed, "limit": limit],
        disconnectOnTimeout: false,
        timeoutNanoseconds: 25_000_000_000
      ),
      as: LiveInspectMacDesktopReply.self
    )
  }
}
