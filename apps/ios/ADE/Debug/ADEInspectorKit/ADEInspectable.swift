import SwiftUI

struct ADEInspectablePayload: Equatable {
  let componentId: String
  let file: String
  let line: Int
  let key: String?
  let metadata: [String: String]
}

private struct ADEInspectableAnchor: Identifiable {
  let id: String
  let payload: ADEInspectablePayload
  let bounds: Anchor<CGRect>
}

private struct ADEInspectablePreferenceKey: PreferenceKey {
  static var defaultValue: [ADEInspectableAnchor] = []

  static func reduce(value: inout [ADEInspectableAnchor], nextValue: () -> [ADEInspectableAnchor]) {
    value.append(contentsOf: nextValue())
  }
}

private struct ADEInspectorFrameSnapshot: Codable, Equatable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

private struct ADEInspectorScreenSnapshot: Codable, Equatable {
  let width: Double
  let height: Double
  let scale: Double
}

private struct ADEInspectorElementSnapshot: Codable, Equatable {
  let id: String
  let componentId: String
  let sourceFile: String
  let sourceLine: Int
  let frame: ADEInspectorFrameSnapshot
  let pixelFrame: ADEInspectorFrameSnapshot
  let metadata: [String: String]
  let accessibilityIdentifier: String
}

private struct ADEInspectorSnapshot: Codable, Equatable {
  let schemaVersion: Int
  let generatedAt: String
  let screen: ADEInspectorScreenSnapshot
  let elements: [ADEInspectorElementSnapshot]
}

private actor ADEInspectorSnapshotWriter {
  static let shared = ADEInspectorSnapshotWriter()

  private let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return encoder
  }()

  private var lastData: Data?

  func write(_ snapshot: ADEInspectorSnapshot) async {
    guard let data = try? encoder.encode(snapshot) else { return }
    guard data != lastData else { return }
    lastData = data

    let documentsDirectory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    guard let documentsDirectory else { return }
    let url = documentsDirectory.appendingPathComponent("ade-inspector-elements.json")
    try? data.write(to: url, options: [.atomic])
  }
}

private func adeInspectorIsoTimestamp() -> String {
  ISO8601DateFormatter().string(from: Date())
}

private func adeInspectorElementId(payload: ADEInspectablePayload) -> String {
  let metadata = payload.metadata
    .sorted { $0.key < $1.key }
    .map { "\($0.key)=\($0.value)" }
    .joined(separator: "&")
  let keySegment = payload.key.map { "|key=\($0)" } ?? ""
  return "\(payload.componentId)|\(payload.file)|\(payload.line)\(keySegment)|\(metadata)"
}

private struct ADEInspectorSnapshotEmitter: View {
  @Environment(\.displayScale) private var displayScale

  let items: [ADEInspectableAnchor]
  let proxy: GeometryProxy

  private static let minPointArea: CGFloat = 16
  private static let minPointEdge: CGFloat = 4

  private var snapshot: ADEInspectorSnapshot {
    let scale = Double(displayScale)
    let screenBounds = CGRect(origin: .zero, size: proxy.size)
    let elements = items.compactMap { item -> ADEInspectorElementSnapshot? in
      let frame = proxy[item.bounds]
      guard frame.width >= Self.minPointEdge, frame.height >= Self.minPointEdge else { return nil }
      guard frame.width * frame.height >= Self.minPointArea else { return nil }
      guard screenBounds.intersects(frame) else { return nil }
      let pointFrame = ADEInspectorFrameSnapshot(
        x: Double(frame.minX),
        y: Double(frame.minY),
        width: Double(frame.width),
        height: Double(frame.height)
      )
      let pixelFrame = ADEInspectorFrameSnapshot(
        x: Double(frame.minX) * scale,
        y: Double(frame.minY) * scale,
        width: Double(frame.width) * scale,
        height: Double(frame.height) * scale
      )
      return ADEInspectorElementSnapshot(
        id: item.id,
        componentId: item.payload.componentId,
        sourceFile: item.payload.file,
        sourceLine: item.payload.line,
        frame: pointFrame,
        pixelFrame: pixelFrame,
        metadata: item.payload.metadata,
        accessibilityIdentifier: item.payload.componentId
      )
    }

    return ADEInspectorSnapshot(
      schemaVersion: 1,
      generatedAt: adeInspectorIsoTimestamp(),
      screen: ADEInspectorScreenSnapshot(
        width: Double(proxy.size.width),
        height: Double(proxy.size.height),
        scale: scale
      ),
      elements: elements
    )
  }

  private var snapshotIdentity: String {
    snapshot.elements
      .map { element in
        let frame = element.pixelFrame
        return "\(element.id):\(frame.x):\(frame.y):\(frame.width):\(frame.height)"
      }
      .joined(separator: "|")
  }

  var body: some View {
    let currentSnapshot = snapshot
    Color.clear
      .allowsHitTesting(false)
      .task(id: snapshotIdentity) {
        await ADEInspectorSnapshotWriter.shared.write(currentSnapshot)
      }
  }
}

private struct ADEInspectorHostModifier: ViewModifier {
  func body(content: Content) -> some View {
#if DEBUG
    content
      .overlayPreferenceValue(ADEInspectablePreferenceKey.self) { items in
        GeometryReader { proxy in
          ADEInspectorSnapshotEmitter(items: items, proxy: proxy)
        }
        .allowsHitTesting(false)
      }
#else
    content
#endif
  }
}

private struct ADEInspectableModifier: ViewModifier {
  let payload: ADEInspectablePayload

  func body(content: Content) -> some View {
#if DEBUG
    content
      .accessibilityIdentifier(payload.componentId)
      .anchorPreference(
        key: ADEInspectablePreferenceKey.self,
        value: .bounds
      ) { bounds in
        [ADEInspectableAnchor(
          id: adeInspectorElementId(payload: payload),
          payload: payload,
          bounds: bounds
        )]
      }
#else
    content
#endif
  }
}

extension View {
  func adeInspectable(
    _ componentId: String,
    key: String? = nil,
    file: String = #fileID,
    line: Int = #line,
    metadata: [String: String] = [:]
  ) -> some View {
#if DEBUG
    let resolvedMetadata: [String: String] = {
      guard let key, metadata["key"] == nil else { return metadata }
      var merged = metadata
      merged["key"] = key
      return merged
    }()
    return modifier(ADEInspectableModifier(payload: ADEInspectablePayload(
      componentId: componentId,
      file: file,
      line: line,
      key: key,
      metadata: resolvedMetadata
    )))
#else
    return self
#endif
  }

  func adeInspectorHost() -> some View {
    modifier(ADEInspectorHostModifier())
  }
}
