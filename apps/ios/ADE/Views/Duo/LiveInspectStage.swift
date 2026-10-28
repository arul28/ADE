import SwiftUI
import UIKit

// MARK: - Stage

/// The frozen inspector: the picture on a quiet stage with a floating markup
/// toolbar, and an inspector list beside it (wide) or under it (compact).
/// Wide splits around the fold: the picture on one page, the inspector on the
/// other.
struct LiveInspectStage: View {
  @ObservedObject var model: LiveInspectMarkupModel
  var onClose: () -> Void

  @Environment(\.duoLayout) private var duo

  var body: some View {
    NavigationStack {
      DuoLocalFoldReader { fold, size, _ in
        if duo.isWide {
          wideLayout(fold: fold, size: size)
        } else {
          compactLayout(size: size)
        }
      }
      .ignoresSafeArea(.container, edges: .bottom)
      .navigationTitle("Inspect")
      .navigationSubtitle(Text(subtitle))
      .toolbarTitleDisplayMode(.inline)
      .toolbar { toolbarContent }
      // One quiet surface for the whole stage: the picture floats on the same
      // grouped background the inspector's sections sit on, so the fold (or
      // the column edge) reads as space, not as a slab.
      .background(Color(uiColor: .systemGroupedBackground).ignoresSafeArea())
    }
    .tint(ADEColor.accent)
    .accessibilityIdentifier("LiveInspect.Stage")
  }

  // MARK: Chrome

  @ToolbarContentBuilder
  private var toolbarContent: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) {
      Button(role: .close) {
        ADEHaptics.light()
        onClose()
      }
      .tint(.primary)
      .accessibilityLabel("Stop inspecting")
      .accessibilityIdentifier("LiveInspect.Close")
    }
    ToolbarItem(placement: .primaryAction) {
      Button {
        ADEHaptics.success()
        if model.sendToComposer() { onClose() }
      } label: {
        Label("Send to Chat", systemImage: "paperplane.fill")
          .labelStyle(.titleAndIcon)
      }
      .buttonStyle(.borderedProminent)
      .tint(ADEColor.accent)
      .disabled(!model.canSend)
      .accessibilityHint("Attaches the annotated picture and its element packet to the chat")
      .accessibilityIdentifier("LiveInspect.Send")
    }
  }

  private var subtitle: String {
    switch model.phase {
    case .loading:
      return "Freezing \(model.surface.title)…"
    case .failed:
      return "\(model.surface.title) · couldn't freeze"
    case .ready:
      guard let screen = model.screen else { return "\(model.surface.title) · Frozen" }
      let unit = model.surface == .appControl ? "px" : "pt"
      return "\(model.surface.title) · \(screen.label) \(unit) · Frozen"
    }
  }

  // MARK: Layouts

  @ViewBuilder
  private func compactLayout(size: CGSize) -> some View {
    VStack(spacing: 0) {
      canvas
        .frame(height: max(260, size.height * 0.56))
      Divider()
      inspector
    }
  }

  @ViewBuilder
  private func wideLayout(fold: DuoFold, size: CGSize) -> some View {
    switch fold {
    case .stacked(let rect) where rect.minY > 200 && size.height - rect.maxY > 220:
      // Laptop / tent: the picture stands on the far half, the inspector and
      // its buttons sit on the near half. The fold itself carries nothing.
      VStack(spacing: 0) {
        canvas
          .frame(height: rect.minY)
        Color.clear
          .frame(height: rect.height)
        inspector
      }
    case .sideBySide(let rect) where rect.minX > 260 && size.width - rect.maxX > 280:
      // Book: one page each, the boundary on the hinge.
      HStack(spacing: 0) {
        canvas
          .frame(width: rect.minX)
        Color.clear
          .frame(width: rect.width)
        inspector
      }
    default:
      HStack(spacing: 0) {
        canvas
        Divider()
        inspector
          .frame(width: min(max(340, size.width * 0.36), 420))
      }
    }
  }

  // MARK: Canvas

  private var canvas: some View {
    LiveInspectPicture(model: model)
      .padding(.horizontal, 24)
      .padding(.top, 16)
      .padding(.bottom, 76)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .overlay(alignment: .bottom) {
        markupToolbar
          .padding(.bottom, 16)
      }
      .accessibilityIdentifier("LiveInspect.Canvas")
  }

  private var markupToolbar: some View {
    GlassEffectContainer {
      HStack(spacing: 2) {
        ForEach(LiveInspectTool.allCases) { tool in
          toolButton(tool)
        }
        Divider()
          .frame(height: 20)
          .padding(.horizontal, 4)
        Button {
          model.undo()
        } label: {
          Image(systemName: "arrow.uturn.backward")
            .frame(width: 40, height: 36)
        }
        .disabled(!model.canUndo)
        .accessibilityLabel("Undo")
        Button(role: .destructive) {
          model.clearMarkup()
        } label: {
          Image(systemName: "trash")
            .frame(width: 40, height: 36)
        }
        .disabled(!model.canUndo)
        .accessibilityLabel("Clear markup")
      }
      .font(.body)
      .buttonStyle(.plain)
      .padding(.horizontal, 6)
      .padding(.vertical, 4)
      .glassEffect(.regular, in: .capsule)
    }
  }

  private func toolButton(_ tool: LiveInspectTool) -> some View {
    let selected = model.tool == tool
    return Button {
      ADEHaptics.light()
      model.tool = tool
    } label: {
      Image(systemName: tool.symbolName)
        .symbolVariant(selected ? .fill : .none)
        .foregroundStyle(selected ? Color.white : Color.primary)
        .frame(width: 40, height: 36)
        .background {
          if selected {
            Capsule(style: .continuous).fill(ADEColor.accent)
          }
        }
    }
    .accessibilityLabel(tool.title)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("LiveInspect.Tool.\(tool.rawValue)")
  }

  // MARK: Inspector

  private var inspector: some View {
    List {
      if let errorText = model.errorText {
        Section {
          Label(errorText, systemImage: "exclamationmark.triangle.fill")
            .foregroundStyle(ADEColor.warning)
            .font(.subheadline)
        }
      }
      if let selected = model.selected {
        elementSections(selected)
      } else {
        Section {
          emptySelection
        }
      }
      if !model.staged.isEmpty || !model.strokes.isEmpty {
        Section("In This Message") {
          ForEach(model.staged) { element in
            Label(element.displayTitle, systemImage: "scope")
              .lineLimit(1)
          }
          if !model.strokes.isEmpty {
            Label(
              model.strokes.count == 1 ? "1 mark on the picture" : "\(model.strokes.count) marks on the picture",
              systemImage: "pencil.tip.crop.circle"
            )
          }
        }
      }
      if let note = model.note {
        Section {
          EmptyView()
        } footer: {
          Text(note)
        }
      }
    }
    .listStyle(.insetGrouped)
    .scrollContentBackground(.hidden)
  }

  @ViewBuilder
  private func elementSections(_ element: LiveInspectElement) -> some View {
    let staged = model.isStaged(element)
    Section {
      VStack(alignment: .leading, spacing: 3) {
        Text(element.displayTitle)
          .font(.headline)
          .lineLimit(2)
        if !element.displaySubtitle.isEmpty {
          Text(element.displaySubtitle)
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
      }
      .padding(.vertical, 2)
      let ancestors = LiveInspectGeometry.ancestors(of: element, in: model.elements)
      if !ancestors.isEmpty {
        LabeledContent("Path") {
          Text(ancestors.prefix(3).map(\.displayTitle).reversed().joined(separator: " › "))
            .lineLimit(1)
            .truncationMode(.head)
        }
      }
      if let enabled = element.enabled, enabled == false {
        LabeledContent("State", value: "Disabled")
      }
      Button {
        model.stageSelection()
      } label: {
        Label(
          staged ? "Added to Message" : "Add to Message",
          systemImage: staged ? "checkmark.circle.fill" : "plus.circle"
        )
      }
      .accessibilityIdentifier("LiveInspect.AddToMessage")
    } header: {
      Text("Element")
    }

    Section("Frame") {
      let frame = element.pointFrame ?? element.frame
      frameRow("X", frame.x)
      frameRow("Y", frame.y)
      frameRow("Width", frame.width)
      frameRow("Height", frame.height)
    }

    if let source = element.sourceLabel {
      Section {
        Label {
          Text(source)
            .font(.subheadline.monospaced())
            .lineLimit(1)
            .truncationMode(.middle)
        } icon: {
          Image(systemName: "doc.text")
        }
      } header: {
        Text("Source")
      } footer: {
        if let confidence = element.sourceConfidence, confidence != "exact" {
          Text("Best match (\(confidence)).")
        }
      }
    }
  }

  private func frameRow(_ title: String, _ value: Double) -> some View {
    LabeledContent(title) {
      Text(value.formatted(.number.precision(.fractionLength(0...1))))
        .monospacedDigit()
    }
  }

  @ViewBuilder
  private var emptySelection: some View {
    if case .failed = model.phase {
      ContentUnavailableView {
        Label("Couldn't Freeze the Picture", systemImage: "exclamationmark.triangle")
      } actions: {
        Button("Try Again") { model.reload() }
      }
    } else if model.phase == .loading || model.busy {
      HStack(spacing: 10) {
        ProgressView()
        Text(model.phase == .loading ? "Freezing the picture…" : "Looking up the element…")
          .foregroundStyle(.secondary)
      }
      .frame(maxWidth: .infinity, alignment: .center)
      .padding(.vertical, 18)
    } else {
      ContentUnavailableView(
        "Select an Element",
        systemImage: "cursorarrow.rays",
        description: Text("Tap the picture to inspect it, or draw on it with the markup tools.")
      )
    }
  }
}

// MARK: - Picture

/// The frozen picture with its element highlight, its markup, and the one
/// gesture that draws or selects.
struct LiveInspectPicture: View {
  @ObservedObject var model: LiveInspectMarkupModel

  var body: some View {
    GeometryReader { proxy in
      let rect = LiveInspectGeometry.fit(pixelSize: model.pixelSize, in: proxy.size)
      ZStack(alignment: .topLeading) {
        if let image = model.image {
          Image(uiImage: image)
            .resizable()
            .interpolation(.high)
            .frame(width: rect.width, height: rect.height)
            .clipShape(RoundedRectangle(cornerRadius: cornerRadius(for: rect), style: .continuous))
            .shadow(color: .black.opacity(0.18), radius: 18, y: 8)
            .position(x: rect.midX, y: rect.midY)
          if let selected = model.selected {
            selectionBox(selected, in: rect)
          }
          LiveInspectMarkupLayer(model: model, imageRect: rect)
        } else if case .failed = model.phase {
          VStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle")
              .font(.title3)
              .foregroundStyle(ADEColor.warning)
            Text("The picture couldn't be frozen.")
              .font(.footnote)
              .foregroundStyle(.secondary)
          }
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
          ProgressView()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
      .contentShape(Rectangle())
      .gesture(gesture(rect: rect))
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("The frozen \(model.surface.title) screen")
      .accessibilityHint("Tap to inspect an element, or draw with a markup tool.")
      .accessibilityIdentifier("LiveInspect.Picture")
    }
  }

  /// A phone's screen gets a phone's corners; a window or a desktop keeps a
  /// small radius.
  private func cornerRadius(for rect: CGRect) -> CGFloat {
    model.surface == .simulator ? rect.width * 0.1 : 8
  }

  private func selectionBox(_ element: LiveInspectElement, in rect: CGRect) -> some View {
    let scale = CGSize(
      width: rect.width / max(1, model.pixelSize.width),
      height: rect.height / max(1, model.pixelSize.height)
    )
    let frame = CGRect(
      x: rect.minX + element.imageFrame.minX * scale.width,
      y: rect.minY + element.imageFrame.minY * scale.height,
      width: element.imageFrame.width * scale.width,
      height: element.imageFrame.height * scale.height
    )
    return ZStack(alignment: .topLeading) {
      RoundedRectangle(cornerRadius: 4, style: .continuous)
        .fill(ADEColor.accent.opacity(0.14))
      RoundedRectangle(cornerRadius: 4, style: .continuous)
        .strokeBorder(ADEColor.accent, lineWidth: 1.5)
      Circle()
        .fill(ADEColor.accent)
        .frame(width: 7, height: 7)
        .offset(x: -3.5, y: -3.5)
    }
    .frame(width: max(1, frame.width), height: max(1, frame.height))
    .position(x: frame.midX, y: frame.midY)
    .allowsHitTesting(false)
  }

  private func gesture(rect: CGRect) -> some Gesture {
    DragGesture(minimumDistance: 0, coordinateSpace: .local)
      .onChanged { value in
        guard model.tool.draws,
              let point = LiveInspectGeometry.imagePoint(
                value.location,
                in: rect,
                pixelSize: model.pixelSize
              ) else { return }
        if model.draft == nil {
          model.beginStroke(at: point)
        } else {
          model.extendStroke(to: point)
        }
      }
      .onEnded { value in
        if model.tool.draws {
          model.endStroke()
          return
        }
        guard let point = LiveInspectGeometry.imagePoint(
          value.location,
          in: rect,
          pixelSize: model.pixelSize
        ) else { return }
        model.select(atImagePoint: point)
      }
  }
}

/// The in-progress and finished marks over the picture.
struct LiveInspectMarkupLayer: View {
  @ObservedObject var model: LiveInspectMarkupModel
  let imageRect: CGRect

  var body: some View {
    let scale = imageRect.width / max(1, model.pixelSize.width)
    Canvas { context, _ in
      var all = model.strokes
      if let draft = model.draft { all.append(draft) }
      guard scale > 0 else { return }
      for stroke in all {
        let path = LiveInspectDrawing.path(for: stroke, imageSize: model.pixelSize)
          .applying(CGAffineTransform(scaleX: scale, y: scale))
        guard !path.isEmpty else { continue }
        let width = LiveInspectDrawing.lineWidth(for: model.pixelSize) * scale
        context.stroke(
          path,
          with: .color(.white.opacity(0.9)),
          style: StrokeStyle(lineWidth: width + max(1.5, width * 0.5), lineCap: .round, lineJoin: .round)
        )
        context.stroke(
          path,
          with: .color(LiveInspectInk.color),
          style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)
        )
      }
    }
    .frame(width: imageRect.width, height: imageRect.height)
    .offset(x: imageRect.minX, y: imageRect.minY)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

// MARK: - Small helpers

extension String {
  var liveInspectTrimmed: String? {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}

// MARK: - Fixtures

#if DEBUG
/// Fixture screens for this area, routed by `DuoPreviewRouter`.
enum LiveInspectMarkupPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-inspect-sim":
      return AnyView(LiveInspectFixtureScreen())
    default:
      return nil
    }
  }
}

/// The wide showcase: a frozen simulator still with a selected row and two
/// marks. The stage itself adapts by width, so folding the device closed shows
/// the same state in the compact layout.
@MainActor
private struct LiveInspectFixtureScreen: View {
  @StateObject private var model: LiveInspectMarkupModel

  init() {
    _model = StateObject(wrappedValue: LiveInspectFixtureData.model())
  }

  var body: some View {
    LiveInspectStage(model: model, onClose: {})
  }
}

@MainActor
private enum LiveInspectFixtureData {
  /// The drawn simulator stand-in from the Apple viewer fixture, rendered at
  /// the iPhone's pixel size so the frames and strokes are in real pixels.
  static func picture() -> UIImage {
    let renderer = ImageRenderer(
      content: AppleViewerPreviewPicture()
        .frame(width: 402, height: 874)
    )
    renderer.scale = 3
    return renderer.uiImage ?? UIImage()
  }

  static func model() -> LiveInspectMarkupModel {
    let model = LiveInspectMarkupModel(surface: .simulator, laneId: "fixture-lane", chatSessionId: nil)
    let image = picture()
    let elements = rows()
    let selected = elements.first { $0.identifier == "settings.accessibility" }
    model.installPreview(
      image: image,
      elements: elements,
      selected: selected,
      strokes: [
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
    )
    return model
  }

  /// The six rows `AppleViewerPreviewPicture` draws, in its own point space
  /// (16 pt inset, 44 pt rows, 10 pt apart from y=121), scaled to pixels.
  private static func rows() -> [LiveInspectElement] {
    let labels = ["General", "Accessibility", "Appearance", "Camera", "Control Center", "Display"]
    let identifiers = [
      "settings.general",
      "settings.accessibility",
      "settings.appearance",
      "settings.camera",
      "settings.control-center",
      "settings.display",
    ]
    var elements: [LiveInspectElement] = []
    for (index, label) in labels.enumerated() {
      let pointFrame = LiveInspectFrame(x: 16, y: 121 + Double(index) * 54, width: 370, height: 44)
      elements.append(
        LiveInspectElement(
          id: "fixture-\(index)",
          label: label,
          value: nil,
          role: "Button",
          elementType: "UITableViewCell",
          subrole: nil,
          identifier: identifiers[index],
          componentId: "SettingsRow",
          sourceFile: "Views/SettingsView.swift",
          sourceLine: 40 + index * 8,
          sourceConfidence: "exact",
          enabled: true,
          focused: false,
          frame: LiveInspectFrame(
            x: pointFrame.x * 3,
            y: pointFrame.y * 3,
            width: pointFrame.width * 3,
            height: pointFrame.height * 3
          ),
          pointFrame: pointFrame,
          imageFrame: CGRect(
            x: pointFrame.x * 3,
            y: pointFrame.y * 3,
            width: pointFrame.width * 3,
            height: pointFrame.height * 3
          )
        )
      )
    }
    return elements
  }
}
#endif
