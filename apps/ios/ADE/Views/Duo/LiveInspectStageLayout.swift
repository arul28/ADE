import SwiftUI

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

// Internal, not private: the stage calls this from LiveInspectStage.swift.
extension DuoFold {
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
    case .android: return CGSize(width: 1080, height: 2424)
    case .appControl, .macDesktop: return CGSize(width: 1600, height: 1000)
    }
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
