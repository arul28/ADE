import SwiftUI
import UIKit

// MARK: - Fixtures

#if DEBUG
/// Fixture screens for this area, routed by `DuoPreviewRouter`:
///
///     -adePreviewScreen duo-inspect-sim           first run, the hint showing
///     -adePreviewScreen duo-inspect-sim-selected  a row selected, its card open
///     -adePreviewScreen duo-inspect-sim-markup    two marks, the Pen tool
///
/// A stand-in composer answers every handoff, so "Add to chat", its toast,
/// Undo and Done all run with no chat and no sync.
enum LiveInspectMarkupPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-inspect-sim":
      return AnyView(LiveInspectFixtureScreen(state: .fresh))
    case "duo-inspect-sim-selected":
      return AnyView(LiveInspectFixtureScreen(state: .selected))
    case "duo-inspect-sim-markup":
      return AnyView(LiveInspectFixtureScreen(state: .markup))
    default:
      return nil
    }
  }
}

@MainActor
private struct LiveInspectFixtureScreen: View {
  enum State {
    case fresh
    case selected
    case markup
  }

  @StateObject private var model: LiveInspectMarkupModel
  @SwiftUI.State private var closed = false

  init(state: State) {
    _model = StateObject(wrappedValue: LiveInspectFixtureData.model(state))
  }

  var body: some View {
    Group {
      if closed {
        VStack(spacing: 12) {
          Text("Inspect closed")
            .font(.headline)
          Text("\(model.attachedCount) added to the chat")
            .foregroundStyle(.secondary)
          Button("Reopen") { closed = false }
            .buttonStyle(.glass)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
      } else {
        LiveInspectStage(model: model, onClose: { closed = true })
      }
    }
    // The stand-in composer: takes every request, as a chat's would.
    .onReceive(NotificationCenter.default.publisher(for: .liveInspectComposerHandoff)) { notification in
      guard let handoff = notification.object as? LiveInspectComposerHandoff, handoff.claim() else { return }
      switch handoff.request {
      case .insert, .replaceImage:
        handoff.reply(.attached)
      case .remove:
        handoff.reply(.removed)
      }
    }
  }
}

@MainActor
private enum LiveInspectFixtureData {
  static let labels = ["General", "Accessibility", "Appearance", "Camera", "Control Center", "Display"]

  /// A drawn Settings screen at the iPhone's pixel size, so the frames and
  /// strokes are in real pixels.
  static func picture() -> UIImage {
    let renderer = ImageRenderer(
      content: LiveInspectFixturePicture(labels: labels)
        .frame(width: 402, height: 874)
    )
    renderer.scale = 3
    return renderer.uiImage ?? UIImage()
  }

  static func model(_ state: LiveInspectFixtureScreen.State) -> LiveInspectMarkupModel {
    let model = LiveInspectMarkupModel(surface: .simulator, laneId: "fixture-lane", chatSessionId: "fixture-chat")
    let elements = rows()
    let selected = state == .selected ? elements.first { $0.identifier == "settings.accessibility" } : nil
    let strokes: [LiveInspectStroke] = state == .markup
      ? [
        LiveInspectStroke(tool: .pen, points: [
          CGPoint(x: 150, y: 352),
          CGPoint(x: 430, y: 342),
          CGPoint(x: 720, y: 356),
          CGPoint(x: 1010, y: 344),
        ]),
        LiveInspectStroke(tool: .circle, points: [
          CGPoint(x: 40, y: 520),
          CGPoint(x: 1166, y: 668),
        ]),
      ]
      : []
    model.installPreview(image: picture(), elements: elements, selected: selected, strokes: strokes)
    if state == .markup { model.tool = .pen }
    return model
  }

  /// The rows `LiveInspectFixturePicture` draws, in its own point space
  /// (16 pt inset, 44 pt rows, 10 pt apart from y=121), scaled to pixels.
  private static func rows() -> [LiveInspectElement] {
    var elements: [LiveInspectElement] = []
    for (index, label) in labels.enumerated() {
      let pointFrame = LiveInspectFrame(x: 16, y: 121 + Double(index) * 54, width: 370, height: 44)
      let pixel = LiveInspectFrame(
        x: pointFrame.x * 3,
        y: pointFrame.y * 3,
        width: pointFrame.width * 3,
        height: pointFrame.height * 3
      )
      elements.append(
        LiveInspectElement(
          id: "fixture-\(index)",
          label: label,
          value: nil,
          role: "Button",
          elementType: "UITableViewCell",
          subrole: nil,
          identifier: "settings.\(label.lowercased().replacingOccurrences(of: " ", with: "-"))",
          componentId: "SettingsRow",
          sourceFile: "Views/SettingsView.swift",
          sourceLine: 40 + index * 8,
          sourceConfidence: "exact",
          enabled: true,
          focused: false,
          frame: pixel,
          pointFrame: pointFrame,
          imageFrame: CGRect(x: pixel.x, y: pixel.y, width: pixel.width, height: pixel.height)
        )
      )
    }
    return elements
  }
}

/// A plain Settings screen: a large title and six 44pt rows from y=121.
private struct LiveInspectFixturePicture: View {
  let labels: [String]
  private let symbols = ["gear", "accessibility", "sun.max", "camera", "switch.2", "textformat.size"]
  private let colors: [Color] = [.gray, .blue, .indigo, .gray, .gray, .blue]

  var body: some View {
    ZStack(alignment: .topLeading) {
      Color(white: 0.95)
      Text("Settings")
        .font(.system(size: 34, weight: .bold))
        .foregroundStyle(.black)
        .offset(x: 20, y: 62)
      ForEach(Array(labels.enumerated()), id: \.offset) { index, label in
        HStack(spacing: 12) {
          RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(colors[index % colors.count])
            .frame(width: 29, height: 29)
            .overlay {
              Image(systemName: symbols[index % symbols.count])
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.white)
            }
          Text(label)
            .font(.system(size: 17))
            .foregroundStyle(.black)
          Spacer()
          Image(systemName: "chevron.right")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.gray)
        }
        .padding(.horizontal, 14)
        .frame(width: 370, height: 44)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(.white))
        .offset(x: 16, y: 121 + CGFloat(index) * 54)
      }
    }
  }
}
#endif
