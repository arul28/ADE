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
      let unit = model.surface == .appControl ? "px" : "pt"
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
    model.surface == .simulator ? min(rect.width, rect.height) * 0.09 : 8
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

// MARK: - Stage plan

/// Where everything goes on the stage, in the stage's own coordinates (the
/// whole window, safe areas included).
struct LiveInspectStagePlan {
  enum Mode {
    /// An iPhone or the Duo's cover: everything floats over the picture.
    case compact
    /// Wide with room: the tools strip and a column (hint, card, toast)
    /// beside the picture.
    case column
    /// Wide but narrow beside a full-height picture (the Duo held upright):
    /// only the strip stands beside it; the card, hint and toast pass over
    /// the picture.
    case strip
  }

  let size: CGSize
  /// The window inside its safe area: what floating chrome stays within.
  let safe: CGRect
  let mode: Mode
  /// The frozen picture (a placeholder of the surface's shape while it loads).
  let picture: CGRect
  /// Wide: the tools strip (with Close and Done when the rail is away).
  let strip: CGRect
  /// Column mode: hint, card and toast, past the strip.
  let content: CGRect

  var isWide: Bool { mode != .compact }

  init(
    size: CGSize,
    insets: EdgeInsets,
    fold: DuoFold,
    pixelSize: CGSize,
    surface: LiveInspectSurface,
    isWide: Bool,
    bentLikeLaptop: Bool = false
  ) {
    self.size = size
    safe = CGRect(
      x: insets.leading,
      y: insets.top,
      width: max(0, size.width - insets.leading - insets.trailing),
      height: max(0, size.height - insets.top - insets.bottom)
    )
    let pixel = pixelSize.width > 0 && pixelSize.height > 0 ? pixelSize : surface.placeholderPixelSize
    guard isWide else {
      // Compact: the picture fills the screen top to bottom, in the middle of
      // the screen (the Duo cover's clock strip only pushes it over when it
      // would reach under it); the chrome over it lines up with it.
      mode = .compact
      var fitted = LiveInspectLayout.fit(pixel, in: CGRect(x: safe.minX, y: 0, width: safe.width, height: size.height))
      fitted.origin.x = min(max((size.width - fitted.width) / 2, safe.minX), max(safe.minX, safe.maxX - fitted.width))
      picture = fitted
      strip = .zero
      content = .zero
      return
    }
    let margin = LiveInspectLayout.pictureMargin
    let gap = LiveInspectLayout.stripGap
    let stripWidth = LiveInspectLayout.stripWidth
    // Full height, top edge to bottom edge; the leading safe area still holds.
    // Bent like a laptop, the bottom half is the deck under the person's
    // hands: everything moves below the crease, where picking and marking up
    // is a short reach, and nothing spans the crease.
    var top = margin
    let bottom = size.height - margin
    var columnTop = safe.minY + margin
    if bentLikeLaptop, case .stacked(let foldRect) = fold, size.height - foldRect.maxY > 200 {
      top = foldRect.maxY + margin
      columnTop = top
    }
    let tall = CGRect(
      x: safe.minX + margin,
      y: top,
      width: max(0, safe.width - margin * 2),
      height: max(0, bottom - top)
    )
    let columnHeight = max(0, min(safe.maxY, bottom) - columnTop)

    func column(from x: CGFloat) -> (CGRect, CGRect) {
      let strip = CGRect(x: x, y: columnTop, width: stripWidth, height: columnHeight)
      let contentX = strip.maxX + gap
      let content = CGRect(
        x: contentX,
        y: columnTop,
        width: min(LiveInspectLayout.contentMaxWidth, max(0, tall.maxX - contentX)),
        height: columnHeight
      )
      return (strip, content)
    }

    if case .sideBySide(let foldRect) = fold,
       foldRect.minX - tall.minX >= 200,
       tall.maxX - foldRect.maxX >= LiveInspectLayout.minColumnWidth {
      // Book: the picture has the leading page, the rest the trailing one.
      let page = CGRect(x: tall.minX, y: tall.minY, width: foldRect.minX - margin - tall.minX, height: tall.height)
      mode = .column
      picture = LiveInspectLayout.fit(pixel, in: page)
      (strip, content) = column(from: foldRect.maxX + gap)
      return
    }

    func leading(_ room: CGRect) -> CGRect {
      var fitted = LiveInspectLayout.fit(pixel, in: room)
      fitted.origin.x = room.minX
      return fitted
    }
    let columnRoom = CGRect(
      x: tall.minX,
      y: tall.minY,
      width: max(120, tall.width - LiveInspectLayout.minColumnWidth - gap),
      height: tall.height
    )
    let stripRoom = CGRect(
      x: tall.minX,
      y: tall.minY,
      width: max(120, tall.width - stripWidth - gap),
      height: tall.height
    )
    let withColumn = leading(columnRoom)
    let withStrip = leading(stripRoom)
    // The column when it costs the picture little; the strip alone when the
    // column would shrink it (a phone screenshot on an upright Duo).
    if withStrip.height <= withColumn.height * 1.12 {
      mode = .column
      picture = withColumn
      (strip, content) = column(from: picture.maxX + gap)
    } else {
      mode = .strip
      picture = withStrip
      strip = CGRect(x: picture.maxX + gap, y: columnTop, width: stripWidth, height: columnHeight)
      content = .zero
    }
  }

  /// Compact: the chrome floats over the picture, so it spans the picture's
  /// width (inside the safe area), not the screen's.
  var compactChrome: CGRect {
    let minX = max(safe.minX, picture.minX)
    let maxX = min(safe.maxX, picture.maxX)
    guard maxX - minX >= 240 else { return safe }
    return CGRect(x: minX, y: safe.minY, width: maxX - minX, height: safe.height)
  }

  /// Where floating chrome (hint, toast, card) goes when it passes over the
  /// picture: the safe area, less the strip in strip mode.
  var overlayRect: CGRect {
    if mode == .compact { return compactChrome }
    guard mode == .strip else { return safe }
    return CGRect(x: safe.minX, y: safe.minY, width: max(0, strip.minX - safe.minX), height: safe.height)
  }

  /// The card's frame. Column: level with the element, clear of the toast at
  /// the column's foot. Otherwise: beside the element over the picture, clear
  /// of the chrome above and below.
  func cardFrame(anchor: CGRect, height: CGFloat) -> CGRect {
    if mode == .column {
      let lowest = max(content.minY, content.maxY - LiveInspectLayout.toastReserve - height)
      let y = min(max(anchor.midY - height / 2, content.minY), lowest)
      return CGRect(x: content.minX, y: y, width: content.width, height: height)
    }
    let area = overlayRect
    let top = mode == .compact ? LiveInspectLayout.compactTopReserve : LiveInspectLayout.cardMargin
    let bottom = mode == .compact ? LiveInspectLayout.compactBottomReserve : LiveInspectLayout.toastReserve
    let bounds = CGRect(x: area.minX, y: area.minY + top, width: area.width, height: max(0, area.height - top - bottom))
    let width = max(200, min(320, bounds.width - LiveInspectLayout.cardMargin * 2))
    let origin = LiveInspectLayout.cardOrigin(
      anchor: anchor,
      card: CGSize(width: width, height: height),
      bounds: bounds
    )
    return CGRect(origin: origin, size: CGSize(width: width, height: height))
  }
}

private extension DuoFold {
  func offsetBy(dx: CGFloat, dy: CGFloat) -> DuoFold {
    switch self {
    case .none: return .none
    case .sideBySide(let rect): return .sideBySide(rect.offsetBy(dx: dx, dy: dy))
    case .stacked(let rect): return .stacked(rect.offsetBy(dx: dx, dy: dy))
    }
  }
}

private extension LiveInspectSurface {
  /// The shape the picture is laid out in while it loads.
  var placeholderPixelSize: CGSize {
    switch self {
    case .simulator: return CGSize(width: 1206, height: 2622)
    case .appControl, .macDesktop: return CGSize(width: 1600, height: 1000)
    }
  }
}

// MARK: - Element card

/// The small card beside a selected element: its name, role and source, one
/// "Add to chat", and the details behind "More".
struct LiveInspectElementCard: View {
  @ObservedObject var model: LiveInspectMarkupModel
  let element: LiveInspectElement

  @State private var showsMore = false

  var body: some View {
    let added = model.isAdded(element)
    VStack(alignment: .leading, spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(element.displayTitle)
          .font(.headline)
          .lineLimit(2)
        if !element.displaySubtitle.isEmpty {
          Text(element.displaySubtitle)
            .font(.subheadline)
            .foregroundStyle(.secondary)
            .lineLimit(1)
        }
        if let source = element.sourceLabel {
          Label {
            Text(source)
              .lineLimit(1)
              .truncationMode(.middle)
          } icon: {
            Image(systemName: "chevron.left.forwardslash.chevron.right")
          }
          .font(.caption.monospaced())
          .foregroundStyle(ADEColor.accentBright)
          .padding(.top, 3)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .accessibilityElement(children: .combine)

      if showsMore {
        details
          .transition(.opacity)
      }

      HStack(spacing: 8) {
        Button {
          model.addSelectionToChat()
        } label: {
          ZStack {
            Label(added ? "Added" : "Add to chat", systemImage: added ? "checkmark" : "plus.bubble")
              .fontWeight(.semibold)
              .opacity(model.handingOff && !added ? 0 : 1)
            if model.handingOff && !added {
              ProgressView()
                .controlSize(.small)
            }
          }
          .frame(maxWidth: .infinity)
        }
        .buttonStyle(.glassProminent)
        .disabled(added || model.handingOff)
        .accessibilityHint(added ? "" : "Puts this element and the picture into the chat's draft")
        .accessibilityIdentifier("LiveInspect.AddToChat")

        Button {
          withAnimation(.snappy(duration: 0.2)) { showsMore.toggle() }
        } label: {
          Image(systemName: "chevron.down")
            .rotationEffect(.degrees(showsMore ? 180 : 0))
            .frame(width: 18, height: 18)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .accessibilityLabel(showsMore ? "Fewer details" : "More details")
        .accessibilityIdentifier("LiveInspect.More")
      }
    }
    .padding(14)
    .glassEffect(LiveInspectLayout.overlayGlass, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier("LiveInspect.Card")
  }

  private var details: some View {
    Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 12, verticalSpacing: 6) {
      let frame = element.pointFrame ?? element.frame
      detailRow("Frame", "\(number(frame.x)), \(number(frame.y)) · \(number(frame.width)) × \(number(frame.height))")
      let ancestors = LiveInspectGeometry.ancestors(of: element, in: model.elements)
      if !ancestors.isEmpty {
        detailRow("Path", ancestors.prefix(3).map(\.displayTitle).reversed().joined(separator: " › "))
      }
      if let identifier = element.identifier?.liveInspectTrimmed {
        detailRow("ID", identifier)
      }
      if let component = element.componentId?.liveInspectTrimmed, component != element.identifier {
        detailRow("Component", component)
      }
      if element.sourceLabel != nil || element.sourceConfidence != nil {
        detailRow("Source", sourceConfidenceText)
      }
      if element.enabled == false {
        detailRow("State", "Disabled")
      }
    }
    .font(.caption)
  }

  private var sourceConfidenceText: String {
    switch element.sourceConfidence {
    case "exact": return "Exact match"
    case "candidate": return "Best guess"
    case .some(let other) where other != "none": return other.capitalized
    default: return element.sourceLabel == nil ? "No source match" : "Exact match"
    }
  }

  private func detailRow(_ title: String, _ value: String) -> some View {
    GridRow {
      Text(title)
        .foregroundStyle(.secondary)
        .gridColumnAlignment(.leading)
      Text(value)
        .monospacedDigit()
        .lineLimit(2)
        .truncationMode(.head)
    }
  }

  private func number(_ value: Double) -> String {
    value.formatted(.number.precision(.fractionLength(0...1)))
  }
}

// MARK: - Layout

/// Sizes and placement rules shared by the stage plan.
enum LiveInspectLayout {
  static let pictureMargin: CGFloat = 8
  /// The Duo's edge bar, measured flat and book-folded (76pt), and a margin.
  static let edgeBarReserve: CGFloat = 84
  static let stripWidth: CGFloat = 52
  static let stripGap: CGFloat = 12
  /// The least room beside a wide picture: the strip plus a usable card.
  static let minColumnWidth: CGFloat = 320
  static let contentMaxWidth: CGFloat = 360
  static let cardMargin: CGFloat = 12
  static let cardGap: CGFloat = 10
  /// Kept free at the foot of the wide column for the toast.
  static let toastReserve: CGFloat = 60
  /// Compact: under Close and Done, and over the tools capsule and toast.
  static let compactTopReserve: CGFloat = 48
  static let compactBottomReserve: CGFloat = 52
  /// Glass for what floats over the picture (card, chips, toast): tinted
  /// dark, so it reads the same over a white Settings screen and a dark editor.
  static let overlayGlass = Glass.regular.tint(Color.black.opacity(0.6))

  /// The aspect-fit rect of a picture in `page`, centred.
  static func fit(_ pixelSize: CGSize, in page: CGRect) -> CGRect {
    guard page.width > 0, page.height > 0 else { return .zero }
    let local = LiveInspectGeometry.fit(pixelSize: pixelSize, in: page.size)
    return local.offsetBy(dx: page.minX, dy: page.minY)
  }

  /// An image-pixel rect on the displayed picture.
  static func viewRect(_ imageRect: CGRect, picture: CGRect, pixelSize: CGSize) -> CGRect {
    let sx = picture.width / max(1, pixelSize.width)
    let sy = picture.height / max(1, pixelSize.height)
    return CGRect(
      x: picture.minX + imageRect.minX * sx,
      y: picture.minY + imageRect.minY * sy,
      width: imageRect.width * sx,
      height: imageRect.height * sy
    )
  }

  /// A floating card's top-left within `bounds`: centred on the element,
  /// above or below it (the side with room, preferring the one away from the
  /// nearer edge). It covers the element only when neither side has room.
  static func cardOrigin(anchor: CGRect, card: CGSize, bounds: CGRect) -> CGPoint {
    let minX = bounds.minX + cardMargin
    let maxX = max(minX, bounds.maxX - cardMargin - card.width)
    let minY = bounds.minY
    let maxY = max(minY, bounds.maxY - card.height)
    let x = min(max(anchor.midX - card.width / 2, minX), maxX)

    let below = anchor.maxY + cardGap
    let above = anchor.minY - cardGap - card.height
    let fitsBelow = below <= maxY
    let fitsAbove = above >= minY
    let preferBelow = anchor.midY < bounds.midY
    if preferBelow ? fitsBelow : fitsAbove {
      return CGPoint(x: x, y: preferBelow ? below : above)
    }
    if preferBelow ? fitsAbove : fitsBelow {
      return CGPoint(x: x, y: preferBelow ? above : below)
    }
    // No room on either side: sit at the edge farther from the element.
    let roomAbove = anchor.minY - bounds.minY
    let roomBelow = bounds.maxY - anchor.maxY
    return CGPoint(x: x, y: roomBelow >= roomAbove ? maxY : minY)
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
