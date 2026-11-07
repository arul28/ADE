import SwiftUI
import UIKit

// MARK: - Stage

/// The frozen inspector. The picture is the screen: aspect-fit at the full
/// height of the display on a black backdrop, with nothing permanent over it
/// on a large display.
///
/// - Wide (the Duo's inner display, an iPad): the picture stands at the
///   leading side. Beside it a vertical strip carries the markup tools, and
///   the space past the strip carries the first-run hint, the element card
///   (level with the selected element) and the toast. Book-folded, the picture
///   has one page and all of that the other.
/// - Close and Done are the rail's while the Duo's edge bar shows (they are
///   the stage's toolbar). Elsewhere the bar is hidden so it takes no height,
///   and the two sit at the top and bottom of the strip (wide) or float in the
///   top corners (compact).
/// - Compact (an iPhone, the Duo's cover): the picture fills the screen; the
///   buttons, the tools capsule and the card float over it, kept small.
///
/// Tapping an element outlines it and shows its card with one action, "Add to
/// chat", which goes straight into the chat's draft and confirms with a toast
/// that can undo it. Nothing here sends.
struct LiveInspectStage: View {
  @ObservedObject var model: LiveInspectMarkupModel
  var onClose: () -> Void

  @Environment(\.duoLayout) private var duo
  @State private var finishing = false
  @State private var cardSize = CGSize(width: 300, height: 150)

  var body: some View {
    NavigationStack {
      // The reader keeps the safe area so it can report it; the stage itself
      // is laid out over the whole window, in window coordinates.
      GeometryReader { proxy in
        let insets = proxy.safeAreaInsets
        let window = CGSize(
          width: proxy.size.width + insets.leading + insets.trailing,
          height: proxy.size.height + insets.top + insets.bottom
        )
        let plan = LiveInspectStagePlan(
          size: window,
          insets: stageInsets(insets),
          fold: DuoFoldReading.fold(in: proxy).offsetBy(dx: insets.leading, dy: insets.top),
          pixelSize: model.pixelSize,
          surface: model.surface,
          // A phone (or the Duo's front screen) on its side has the room
          // beside a full-height picture that a wide display has.
          isWide: duo.isWide || window.width > window.height * 1.2,
          bentLikeLaptop: LiveStageContext(layout: duo) == .laptop
        )
        ZStack(alignment: .topLeading) {
          pictureLayer(plan)
          if plan.isWide {
            wideChrome(plan)
          } else {
            compactChrome(plan)
          }
          if !model.tool.draws, let anchor = cardAnchor(in: plan.picture) {
            card(anchor: anchor, plan: plan)
          }
        }
        .frame(width: window.width, height: window.height, alignment: .topLeading)
        .offset(x: -insets.leading, y: -insets.top)
        .animation(.snappy(duration: 0.2), value: model.selected?.id)
        .animation(.snappy(duration: 0.2), value: model.pendingTapPoint == nil)
      }
      .background(Color.black.ignoresSafeArea())
      .navigationTitle("Inspect")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(removing: .title)
      .toolbar { railItems }
      // The bar is the Duo's edge bar or nothing: a top bar would take its
      // height from the picture.
      .toolbar(duo.hasEdgeBar ? .visible : .hidden, for: .navigationBar)
    }
    .animation(.snappy(duration: 0.22), value: model.toast)
    .animation(.easeOut(duration: 0.2), value: model.hasInteracted)
    .animation(.easeOut(duration: 0.2), value: model.note)
    .animation(.easeOut(duration: 0.2), value: model.errorText)
    // A black stage reads as dark chrome whatever the app's appearance.
    .environment(\.colorScheme, .dark)
    .tint(ADEColor.accent)
    // The picture runs to the top edge: no clock over it (the Duo's rail
    // keeps its own).
    .statusBarHidden(!duo.hasEdgeBar)
    .accessibilityIdentifier("LiveInspect.Stage")
  }

  /// The safe area, widened on the trailing side by the edge bar while it
  /// shows: the bar stands over the screen's content, not beside it.
  private func stageInsets(_ insets: EdgeInsets) -> EdgeInsets {
    guard duo.hasEdgeBar else { return insets }
    var next = insets
    next.trailing = max(insets.trailing, LiveInspectLayout.edgeBarReserve)
    return next
  }

  /// Close and Done sit in the screen itself wherever the edge bar does not
  /// carry them.
  private var inlineButtons: Bool { !duo.hasEdgeBar }

  // MARK: Rail

  /// The edge bar's items. Declared in every state (the bar does not take
  /// back an item that was removed and declared again), plain buttons so the
  /// bar draws them as its own.
  @ToolbarContentBuilder
  private var railItems: some ToolbarContent {
    ToolbarItem(placement: .topBarTrailing) {
      Button(action: close) {
        Label("Close Inspect", systemImage: "xmark")
      }
      .accessibilityIdentifier("LiveInspect.Rail.Close")
    }
    ToolbarSpacer(.fixed, placement: .topBarTrailing)
    ToolbarItem(placement: .topBarTrailing) {
      Button(action: done) {
        Label("Done", systemImage: "checkmark")
      }
      .disabled(finishing || model.handingOff)
      .accessibilityIdentifier("LiveInspect.Rail.Done")
    }
  }

  private func close() {
    ADEHaptics.light()
    onClose()
  }

  private func done() {
    guard !finishing else { return }
    finishing = true
    Task {
      let outcome = await model.finish()
      switch outcome {
      case .unchanged:
        ADEHaptics.light()
        onClose()
      case .attached:
        // Long enough to read "Attached to chat" before the stage goes.
        try? await Task.sleep(for: .milliseconds(700))
        onClose()
      case .failed:
        break
      }
      finishing = false
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
      let unit = model.surface == .appControl || model.surface == .android ? "px" : "pt"
      return "\(model.surface.title) · \(screen.label) \(unit) · Frozen"
    }
  }

  // MARK: Chrome

  /// Beside the picture: the strip (Close, the tools, Done) and, with room,
  /// the column (hint, toast; the card is placed on its own, level with the
  /// element). Without the column the hint and toast pass over the picture.
  private func wideChrome(_ plan: LiveInspectStagePlan) -> some View {
    let strip = plan.strip
    let messages = plan.mode == .column ? plan.content : plan.overlayRect.insetBy(dx: 12, dy: 8)
    // A phone on its side is short: smaller buttons and cells so Close,
    // the tools and Done all fit the strip's height.
    let tight = strip.height < 470
    return ZStack(alignment: .topLeading) {
      VStack(spacing: tight ? 8 : 12) {
        if inlineButtons {
          closeButton(compact: tight)
        }
        Spacer(minLength: 0)
        markupTools(vertical: true, tight: tight)
        Spacer(minLength: 0)
        if inlineButtons {
          doneButton(compact: false, small: tight)
        }
      }
      .frame(width: strip.width, height: strip.height)
      .offset(x: strip.minX, y: strip.minY)

      VStack(alignment: plan.mode == .column ? .leading : .center, spacing: 10) {
        topChip
          .allowsHitTesting(false)
        Spacer(minLength: 0)
        toast
      }
      .frame(
        width: max(0, messages.width),
        height: max(0, messages.height),
        alignment: plan.mode == .column ? .leading : .center
      )
      .offset(x: messages.minX, y: messages.minY)
    }
  }

  /// Over the picture, as small as it goes: Close and Done in the top
  /// corners, the hint under them, the toast and the tools capsule at the
  /// bottom.
  private func compactChrome(_ plan: LiveInspectStagePlan) -> some View {
    let safe = plan.compactChrome
    return VStack(spacing: 8) {
      HStack(alignment: .center) {
        closeButton(compact: true)
        Spacer(minLength: 0)
        doneButton(compact: true)
      }
      topChip
        .allowsHitTesting(false)
      Spacer(minLength: 0)
      toast
      markupTools(vertical: false)
    }
    .padding(.horizontal, 12)
    .padding(.top, 4)
    .padding(.bottom, 6)
    .frame(width: safe.width, height: safe.height)
    .offset(x: safe.minX, y: safe.minY)
  }

  private func closeButton(compact: Bool) -> some View {
    Button(action: close) {
      Image(systemName: "xmark")
        .font((compact ? Font.subheadline : .body).weight(.semibold))
        .foregroundStyle(.white)
        .frame(width: compact ? 18 : 22, height: compact ? 18 : 22)
    }
    .buttonStyle(.glass)
    .buttonBorderShape(.circle)
    .controlSize(compact ? .regular : .large)
    .accessibilityLabel("Close Inspect")
    .accessibilityIdentifier("LiveInspect.Close")
  }

  /// A small "Done" capsule over a compact picture; a checkmark circle at the
  /// foot of the wide strip, matching the rail's.
  /// `small`: the strip's checkmark at regular size (a phone on its side).
  private func doneButton(compact: Bool, small: Bool = false) -> some View {
    Button(action: done) {
      ZStack {
        Group {
          if compact {
            Text("Done")
              .font(.subheadline.weight(.semibold))
          } else {
            Image(systemName: "checkmark")
              .font(.body.weight(.bold))
              .frame(width: 22, height: 22)
          }
        }
        .opacity(finishing ? 0 : 1)
        if finishing {
          ProgressView()
            .controlSize(.small)
        }
      }
    }
    .buttonStyle(.glassProminent)
    .buttonBorderShape(compact ? .capsule : .circle)
    .controlSize(compact || small ? .regular : .large)
    .disabled(finishing || model.handingOff)
    .accessibilityLabel("Done")
    .accessibilityHint("Leaves Inspect. Markup you drew goes into the chat's picture first.")
    .accessibilityIdentifier("LiveInspect.Done")
  }

  @ViewBuilder
  private var topChip: some View {
    if model.phase == .ready {
      if let errorText = model.errorText {
        chip(errorText, systemImage: "exclamationmark.triangle.fill", tint: ADEColor.warning)
      } else if !model.hasInteracted {
        chip(
          "Tap an element to add it to the chat, or draw on it",
          systemImage: "hand.tap",
          tint: .primary
        )
        .accessibilityIdentifier("LiveInspect.Hint")
      } else if let note = model.note, model.selected == nil, !model.busy {
        chip(note, systemImage: "info.circle", tint: .secondary)
      }
    }
  }

  private func chip(_ text: String, systemImage: String, tint: Color) -> some View {
    Label {
      Text(text)
        .foregroundStyle(.primary)
        .multilineTextAlignment(.leading)
        .fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: systemImage)
        .foregroundStyle(tint)
    }
    .font(.footnote)
    .padding(.horizontal, 14)
    .padding(.vertical, 9)
    .glassEffect(LiveInspectLayout.overlayGlass, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .frame(maxWidth: 520)
    .transition(.opacity)
  }

  @ViewBuilder
  private var toast: some View {
    if let toast = model.toast {
      HStack(spacing: 10) {
        Image(systemName: toast.kind == .attached ? "checkmark.circle.fill" : "exclamationmark.triangle.fill")
          .foregroundStyle(toast.kind == .attached ? ADEColor.success : ADEColor.warning)
        Text(toast.message)
          .font(.subheadline.weight(.medium))
          .lineLimit(2)
          .fixedSize(horizontal: false, vertical: true)
        if let undo = toast.undoAddId {
          Button {
            model.undoAdd(undo)
          } label: {
            Text("Undo")
              .font(.subheadline.weight(.semibold))
              .foregroundStyle(ADEColor.accentBright)
              .padding(.horizontal, 8)
              .frame(minHeight: 36)
              .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .disabled(model.handingOff)
          .accessibilityHint("Takes this element back out of the chat's draft")
          .accessibilityIdentifier("LiveInspect.Toast.Undo")
        }
      }
      .padding(.leading, 14)
      .padding(.trailing, toast.undoAddId == nil ? 16 : 8)
      .padding(.vertical, toast.undoAddId == nil ? 11 : 2)
      .glassEffect(LiveInspectLayout.overlayGlass, in: .capsule)
      .accessibilityElement(children: .contain)
      .accessibilityIdentifier("LiveInspect.Toast")
      .transition(.move(edge: .bottom).combined(with: .opacity))
      .id(toast.id)
    }
  }

  // MARK: Markup tools

  /// Select, Pen, Arrow, Circle | Undo, Clear: a vertical column beside a
  /// wide picture, a capsule under a compact one.
  private func markupTools(vertical: Bool, tight: Bool = false) -> some View {
    let stack = vertical ? AnyLayout(VStackLayout(spacing: 2)) : AnyLayout(HStackLayout(spacing: 2))
    let cell = vertical ? CGSize(width: 42, height: tight ? 32 : 40) : CGSize(width: 40, height: 34)
    return GlassEffectContainer {
      stack {
        ForEach(LiveInspectTool.allCases) { tool in
          toolButton(tool, cell: cell)
        }
        Rectangle()
          .fill(.white.opacity(0.18))
          .frame(width: vertical ? 22 : 1, height: vertical ? 1 : 22)
          .padding(vertical ? .vertical : .horizontal, 6)
        Button {
          model.undo()
        } label: {
          Image(systemName: "arrow.uturn.backward")
            .frame(width: cell.width, height: cell.height)
        }
        .disabled(!model.canUndo)
        .accessibilityLabel("Undo last mark")
        .accessibilityIdentifier("LiveInspect.Markup.Undo")
        Button {
          model.clearMarkup()
        } label: {
          Image(systemName: "trash")
            .frame(width: cell.width, height: cell.height)
        }
        .disabled(!model.canUndo)
        .accessibilityLabel("Clear markup")
        .accessibilityIdentifier("LiveInspect.Markup.Clear")
      }
      .font(.body)
      .buttonStyle(.plain)
      .padding(.horizontal, vertical ? 4 : 5)
      .padding(.vertical, vertical ? 6 : 4)
      // Over a compact picture the tools need the dark tint to read.
      .glassEffect(vertical ? .regular : LiveInspectLayout.overlayGlass, in: .capsule)
    }
    .disabled(model.phase != .ready)
  }

  private func toolButton(_ tool: LiveInspectTool, cell: CGSize) -> some View {
    let selected = model.tool == tool
    return Button {
      ADEHaptics.light()
      model.tool = tool
    } label: {
      Image(systemName: tool.symbolName)
        .symbolVariant(selected ? .fill : .none)
        .foregroundStyle(selected ? Color.black : Color.primary)
        .frame(width: cell.width, height: cell.height)
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

  // MARK: Picture

  /// The frozen still, the selection outline, the markup, and the one gesture
  /// that selects or draws. The gesture covers the whole stage: a tap off the
  /// picture puts the card away.
  private func pictureLayer(_ plan: LiveInspectStagePlan) -> some View {
    let rect = plan.picture
    return ZStack(alignment: .topLeading) {
      if let image = model.image {
        Image(uiImage: image)
          .resizable()
          .interpolation(.high)
          .frame(width: rect.width, height: rect.height)
          .clipShape(RoundedRectangle(cornerRadius: cornerRadius(for: rect), style: .continuous))
          .overlay {
            RoundedRectangle(cornerRadius: cornerRadius(for: rect), style: .continuous)
              .strokeBorder(.white.opacity(0.12), lineWidth: 1)
          }
          .position(x: rect.midX, y: rect.midY)
        if !model.tool.draws, let selected = model.selected {
          selectionBox(LiveInspectLayout.viewRect(selected.imageFrame, picture: rect, pixelSize: model.pixelSize))
        }
        LiveInspectMarkupLayer(model: model, imageRect: rect)
      } else if case .failed(let message) = model.phase {
        VStack(spacing: 12) {
          Image(systemName: "exclamationmark.triangle")
            .font(.title2)
            .foregroundStyle(ADEColor.warning)
          Text("Couldn't freeze the picture")
            .font(.headline)
          Text(message)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
          Button("Try Again") { model.reload() }
            .buttonStyle(.glass)
            .padding(.top, 4)
        }
        .padding(24)
        .frame(width: rect.width, height: rect.height)
        .offset(x: rect.minX, y: rect.minY)
      } else {
        VStack(spacing: 12) {
          ProgressView()
          Text("Freezing \(model.surface.title)…")
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .frame(width: rect.width, height: rect.height)
        .offset(x: rect.minX, y: rect.minY)
      }
    }
    .frame(width: plan.size.width, height: plan.size.height, alignment: .topLeading)
    .contentShape(Rectangle())
    .gesture(gesture(rect: rect))
    .accessibilityElement(children: model.image == nil ? .contain : .ignore)
    .accessibilityLabel(model.image == nil ? "" : "The frozen \(model.surface.title) screen, \(subtitle)")
    .accessibilityHint(model.tool.draws ? "Draw to mark up the picture." : "Tap an element to inspect it.")
    .accessibilityIdentifier("LiveInspect.Picture")
  }

  /// A phone's screen gets a phone's corners; a window or a desktop keeps a
  /// small radius.
  private func cornerRadius(for rect: CGRect) -> CGFloat {
    model.surface.isPhoneScreen ? min(rect.width, rect.height) * 0.09 : 8
  }

  private func selectionBox(_ frame: CGRect) -> some View {
    RoundedRectangle(cornerRadius: 5, style: .continuous)
      .fill(ADEColor.accent.opacity(0.16))
      .overlay {
        RoundedRectangle(cornerRadius: 5, style: .continuous)
          .strokeBorder(ADEColor.accent, lineWidth: 2)
      }
      .shadow(color: ADEColor.accent.opacity(0.45), radius: 6)
      .frame(width: max(2, frame.width), height: max(2, frame.height))
      .position(x: frame.midX, y: frame.midY)
      .allowsHitTesting(false)
      .transition(.opacity)
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
        ) else {
          // Off the picture: put the card away.
          model.clearSelection()
          return
        }
        model.select(atImagePoint: point)
      }
  }

  // MARK: Card

  /// What the card belongs to, in stage coordinates: the selection, or the
  /// tap point while App Control looks the element up.
  private func cardAnchor(in rect: CGRect) -> CGRect? {
    if let selected = model.selected {
      return LiveInspectLayout.viewRect(selected.imageFrame, picture: rect, pixelSize: model.pixelSize)
    }
    if model.busy, let point = model.pendingTapPoint {
      let view = LiveInspectLayout.viewRect(
        CGRect(origin: point, size: .zero),
        picture: rect,
        pixelSize: model.pixelSize
      )
      return view.insetBy(dx: -14, dy: -14)
    }
    return nil
  }

  private func card(anchor: CGRect, plan: LiveInspectStagePlan) -> some View {
    let frame = plan.cardFrame(anchor: anchor, height: cardSize.height)
    return cardContent
      .frame(width: frame.width)
      .fixedSize(horizontal: false, vertical: true)
      .onGeometryChange(for: CGSize.self) { $0.size } action: { cardSize = $0 }
      .offset(x: frame.minX, y: frame.minY)
      .transition(.opacity.combined(with: .scale(scale: 0.96)))
  }

  @ViewBuilder
  private var cardContent: some View {
    if let element = model.selected {
      LiveInspectElementCard(model: model, element: element)
        .id(element.id)
    } else {
      HStack(spacing: 10) {
        ProgressView()
          .controlSize(.small)
        Text("Looking up the element…")
          .font(.subheadline)
          .foregroundStyle(.secondary)
        Spacer(minLength: 0)
      }
      .padding(16)
      .glassEffect(LiveInspectLayout.overlayGlass, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
  }
}

// MARK: - Small helpers

extension String {
  var liveInspectTrimmed: String? {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
