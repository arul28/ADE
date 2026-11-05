import SwiftUI
import UIKit

// What the live stage draws around a stream: the aspect-fit rule, a screen
// viewer's frame, the floating menu button and its panel, the passing hint.
// Where the stream goes and when is `LiveStage.swift`.

// MARK: - Fitting a picture

/// The stage's one aspect-fit rule, so the picture, the pane that hugs it,
/// and the button beside it agree to the point.
enum LiveStageFit {
  /// The centred rect a picture of `aspect` (width over height) takes inside
  /// `box`.
  static func rect(aspect: CGFloat, in box: CGSize) -> CGRect {
    let width = min(box.width, box.height * aspect)
    let height = width / aspect
    return CGRect(x: (box.width - width) / 2, y: (box.height - height) / 2, width: width, height: height)
  }

  /// The pane width that holds the picture at `height`, `gap` all round.
  static func paneWidth(aspect: CGFloat, height: CGFloat, gap: CGFloat) -> CGFloat {
    ((height - gap * 2) * aspect + gap * 2).rounded(.up)
  }

  /// The pane height that holds the picture at `width`, `gap` all round.
  static func paneHeight(aspect: CGFloat, width: CGFloat, gap: CGFloat) -> CGFloat {
    ((width - gap * 2) / aspect + gap * 2).rounded(.up)
  }
}

// MARK: - A screen viewer's frame

/// The frame a screen viewer (Mac Desktop, App Control) draws in: the
/// backdrop (a tap on it opens the menu), the picture placed on the stage
/// and turned when the person asked, the passing hint at the foot, and the
/// floating menu button. The simulator draws its own frame: its picture maps
/// touches and holds for Control itself.
struct LiveStageScreenFrame<Picture: View, Panel: View>: View {
  let presentation: LiveStagePresentation
  /// What the menu button keeps clear of; nil reads this view's safe area.
  var chromeInsets: EdgeInsets?
  /// The person's quarter turn (`LiveStageTurns`).
  var turned = false
  var hint: String?
  var symbolName = "ellipsis"
  /// The button's orange ring: this phone holds the screen.
  var alert = false
  @Binding var menuOpen: Bool
  var onBackdropTap: () -> Void
  @ViewBuilder var picture: () -> Picture
  @ViewBuilder var panel: () -> Panel

  @Environment(\.liveStageHidesStatusBar) private var hidesStatusBar

  var body: some View {
    GeometryReader { proxy in
      let insets = chromeInsets ?? proxy.safeAreaInsets
      ZStack(alignment: .topLeading) {
        // A tap around the picture opens the menu too.
        LiveStageBackdrop(presentation: presentation)
          .contentShape(Rectangle())
          .onTapGesture(perform: onBackdropTap)
        placedPicture(size: proxy.size)
        if let hint {
          VStack {
            Spacer(minLength: 0)
            LiveStageHintChip(text: hint)
              .padding(.bottom, insets.bottom + 20)
          }
          .frame(width: proxy.size.width, height: proxy.size.height)
          .allowsHitTesting(false)
        }
        LiveStageMenuButton(
          container: proxy.size,
          insets: insets,
          storageKey: LiveStageButtonSpot.storageKey(presentation: presentation, size: proxy.size),
          symbolName: symbolName,
          alert: alert,
          isOpen: $menuOpen,
          panel: panel
        )
        .frame(width: proxy.size.width, height: proxy.size.height)
      }
      .frame(width: proxy.size.width, height: proxy.size.height)
      .animation(.easeOut(duration: 0.18), value: hint)
    }
    // Over the pane it runs top to bottom but never sideways under the edge
    // bar; full screen it runs edge to edge.
    .ignoresSafeArea(.container, edges: presentation.isPane ? .vertical : .all)
    .environment(\.colorScheme, .dark)
    .statusBarHidden(hidesStatusBar || presentation.isFullScreen)
  }

  /// Over the pane the picture keeps a little room and its own corners;
  /// full screen it runs edge to edge. The page runs under the rest.
  private func placedPicture(size: CGSize) -> some View {
    let gap = presentation.pictureGap
    let container = CGSize(width: max(0, size.width - gap * 2), height: max(0, size.height - gap * 2))
    let inner = turned ? CGSize(width: container.height, height: container.width) : container
    return picture()
      .frame(width: inner.width, height: inner.height)
      .livePictureViewport()
      .liveStageQuarterTurn(turned, in: container)
      .position(x: gap + container.width / 2, y: gap + container.height / 2)
      .frame(width: size.width, height: size.height)
  }
}

// MARK: - The menu button

/// Where the floating menu button rests, as fractions of the stage, and on
/// which side. Remembered per stage shape, so it stays where it was put.
struct LiveStageButtonSpot: Equatable {
  /// Where a viewer's button spot is stored: per stage (pane or full screen)
  /// and its shape.
  static func storageKey(presentation: LiveStagePresentation, size: CGSize) -> String {
    "ade.liveStage.button.\(presentation.isPane ? "pane" : "full").\(size.width > size.height ? "wide" : "tall")"
  }

  /// Trailing edge (false: leading).
  var trailing = true
  /// The button's centre, 0 at the top of the stage, 1 at the bottom.
  var y: CGFloat = 0.12
  /// Pushed half off the edge, out of the way.
  var tucked = false

  var stored: String { "\(trailing ? "t" : "l"),\(y),\(tucked ? 1 : 0)" }

  init(trailing: Bool = true, y: CGFloat = 0.12, tucked: Bool = false) {
    self.trailing = trailing
    self.y = y
    self.tucked = tucked
  }

  init?(stored: String) {
    let parts = stored.split(separator: ",")
    guard parts.count == 3, let y = Double(parts[1]) else { return nil }
    trailing = parts[0] == "t"
    self.y = min(max(CGFloat(y), 0), 1)
    tucked = parts[2] == "1"
  }

  /// The picture's frame when it leaves room for the button on both sides of
  /// it (a phone in a wide pane): the button then rests beside the picture,
  /// in the empty space, rather than at the stage's edge over it.
  static func besidePicture(container: CGSize, insets: EdgeInsets, aspect: CGFloat?, gap: CGFloat) -> CGRect? {
    guard let aspect, aspect.isFinite, aspect > 0 else { return nil }
    let box = CGSize(width: container.width - gap * 2, height: container.height - gap * 2)
    guard box.width > 0, box.height > 0 else { return nil }
    let picture = LiveStageFit.rect(aspect: aspect, in: box).offsetBy(dx: gap, dy: gap)
    let room: CGFloat = 46 + 12 * 2
    guard picture.minX - insets.leading >= room,
          container.width - insets.trailing - picture.maxX >= room else { return nil }
    return picture
  }
}

/// The one control drawn over a live stream: a small glass button that opens
/// the stream's menu. It can be dragged anywhere along either side and snaps
/// to the nearest one; pushed past the edge it tucks half away. It fades
/// while nobody touches it. Touches on it never reach the device.
///
/// When the picture leaves empty space on both sides, the button rests in it,
/// against the picture (left of it to begin with), its menu opens away from
/// the picture, and the stream's passing hint sits beside it.
struct LiveStageMenuButton<Panel: View>: View {
  /// The stage's size, the button's own coordinate space.
  let container: CGSize
  /// What the button keeps clear of (the notch, the home indicator).
  let insets: EdgeInsets
  /// Remembers the spot under this key.
  let storageKey: String
  let symbolName: String
  /// Drawn with a warning ring (Control is on).
  var alert = false
  /// The drawn picture's shape and its gap to the stage, to find the empty
  /// space beside it.
  var pictureAspect: CGFloat? = nil
  var pictureGap: CGFloat = 0
  /// A passing line drawn beside the button (only while it rests beside the
  /// picture; otherwise the viewer draws it).
  var note: String? = nil
  @Binding var isOpen: Bool
  @ViewBuilder var panel: () -> Panel

  /// The person's own spot, once they have moved it.
  @State private var stored: LiveStageButtonSpot?
  @State private var dragOffset: CGSize = .zero
  @State private var dragging = false
  @State private var awake = true
  @State private var sleepTask: Task<Void, Never>?
  @State private var panelSize: CGSize = .zero
  @State private var noteSize: CGSize = .zero

  private static var size: CGFloat { 46 }
  private static var margin: CGFloat { 12 }

  private var beside: CGRect? {
    LiveStageButtonSpot.besidePicture(container: container, insets: insets, aspect: pictureAspect, gap: pictureGap)
  }

  /// Beside a picture it starts on the left of it; over one, top right.
  private var spot: LiveStageButtonSpot {
    stored ?? LiveStageButtonSpot(trailing: beside == nil)
  }

  /// The menu opens away from the picture when the button rests beside it,
  /// and inward from the stage's edge otherwise.
  private var opensLeft: Bool { beside == nil ? spot.trailing : !spot.trailing }

  var body: some View {
    let center = restingCenter
    ZStack(alignment: .topLeading) {
      if let note, !isOpen, !dragging {
        noteChip(note, button: center)
      }
      if isOpen {
        // A tap anywhere else puts the menu away, and goes no further: it
        // must not land on the device behind it.
        Color.black.opacity(0.001)
          .frame(width: container.width, height: container.height)
          .contentShape(Rectangle())
          .onTapGesture { setOpen(false) }
          .accessibilityHidden(true)
        panel()
          .onGeometryChange(for: CGSize.self) { $0.size } action: { panelSize = $0 }
          .position(panelCenter(button: center))
          .transition(.scale(scale: 0.85, anchor: opensLeft ? .topTrailing : .topLeading).combined(with: .opacity))
      }
      button
        .position(x: center.x + dragOffset.width, y: center.y + dragOffset.height)
    }
    .frame(width: container.width, height: container.height, alignment: .topLeading)
    .animation(.spring(response: 0.3, dampingFraction: 0.82), value: isOpen)
    .animation(.easeOut(duration: 0.18), value: note)
    .onAppear {
      if let saved = UserDefaults.standard.string(forKey: storageKey),
         let restored = LiveStageButtonSpot(stored: saved) {
        stored = restored
      }
      wake()
    }
    .onChange(of: alert) { _, _ in wake() }
    .onDisappear { sleepTask?.cancel() }
  }

  private var button: some View {
    Image(systemName: symbolName)
      .font(.system(size: 18, weight: .semibold))
      .foregroundStyle(alert ? ADEColor.warning : Color.white)
      .frame(width: Self.size, height: Self.size)
      .background(Color.black.opacity(0.35), in: Circle())
      .glassEffect(.regular.interactive(), in: Circle())
      .overlay {
        Circle()
          .strokeBorder(alert ? ADEColor.warning : Color.white.opacity(0.25), lineWidth: alert ? 2 : 1)
      }
      .shadow(color: .black.opacity(0.35), radius: 8, y: 3)
      .scaleEffect(dragging ? 1.12 : 1)
      .opacity(awake || isOpen || dragging ? 1 : (spot.tucked ? 0.5 : 0.42))
      .contentShape(Circle())
      .gesture(
        DragGesture(minimumDistance: 0)
          .onChanged { value in
            wake()
            if !dragging, hypot(value.translation.width, value.translation.height) > 6 {
              dragging = true
              if isOpen { setOpen(false) }
            }
            if dragging { dragOffset = value.translation }
          }
          .onEnded { value in
            if dragging {
              drop(at: CGPoint(
                x: restingCenter.x + value.translation.width,
                y: restingCenter.y + value.translation.height
              ), finger: value.location)
            } else if spot.tucked {
              // A tap on a tucked button brings it back first.
              var next = spot
              next.tucked = false
              withAnimation(.spring(response: 0.32, dampingFraction: 0.8)) { stored = next }
              save()
            } else {
              ADEHaptics.light()
              setOpen(!isOpen)
            }
          }
      )
      .accessibilityElement()
      .accessibilityLabel("Stream controls")
      .accessibilityHint("Opens the menu: control, keyboard, placement, close. Drag to move it.")
      .accessibilityAddTraits(.isButton)
      .accessibilityAction { setOpen(!isOpen) }
      .accessibilityIdentifier("LiveStage.Menu")
  }

  /// The resting centre for the current spot.
  private var restingCenter: CGPoint {
    let half = Self.size / 2
    let top = insets.top + Self.margin + half
    let bottom = max(top, container.height - insets.bottom - Self.margin - half)
    let y = top + (bottom - top) * spot.y
    let x: CGFloat
    if spot.tucked {
      x = spot.trailing ? container.width - half * 0.35 : half * 0.35
    } else if let beside {
      x = spot.trailing ? beside.maxX + Self.margin + half : beside.minX - Self.margin - half
    } else {
      x = spot.trailing
        ? container.width - insets.trailing - Self.margin - half
        : insets.leading + Self.margin + half
    }
    return CGPoint(x: x, y: y)
  }

  private func drop(at point: CGPoint, finger: CGPoint) {
    let half = Self.size / 2
    let top = insets.top + Self.margin + half
    let bottom = max(top + 1, container.height - insets.bottom - Self.margin - half)
    var next = spot
    next.trailing = point.x > (beside?.midX ?? container.width / 2)
    next.y = min(max((point.y - top) / (bottom - top), 0), 1)
    // Thrown at the edge: tuck it away.
    let edge = next.trailing ? container.width - point.x : point.x
    next.tucked = edge < half * 0.9
    withAnimation(.spring(response: 0.34, dampingFraction: 0.8)) {
      stored = next
      dragOffset = .zero
      dragging = false
    }
    ADEHaptics.light()
    save()
    wake()
  }

  private func setOpen(_ open: Bool) {
    withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { isOpen = open }
    wake()
  }

  /// Full strength for a few seconds after anything happens, then faded.
  private func wake() {
    if !awake { withAnimation(.easeOut(duration: 0.2)) { awake = true } }
    sleepTask?.cancel()
    sleepTask = Task { @MainActor in
      try? await Task.sleep(for: .seconds(3))
      guard !Task.isCancelled else { return }
      withAnimation(.easeInOut(duration: 0.6)) { awake = false }
    }
  }

  private func save() {
    UserDefaults.standard.set(spot.stored, forKey: storageKey)
  }

  /// The passing hint, on the button's outer side (under it when that side
  /// is too narrow), so it reads as the button's own line.
  private func noteChip(_ text: String, button: CGPoint) -> some View {
    let half = Self.size / 2
    let gap: CGFloat = 8
    let outerRoom = spot.trailing
      ? container.width - insets.trailing - gap - (button.x + half + gap)
      : button.x - half - gap - (insets.leading + gap)
    // One line beside the button, or under it rather than wrapped.
    let fitsBeside = outerRoom >= 270
    let width = noteSize == .zero ? CGSize(width: 200, height: 34) : noteSize
    var center: CGPoint
    if fitsBeside {
      center = CGPoint(
        x: spot.trailing ? button.x + half + gap + width.width / 2 : button.x - half - gap - width.width / 2,
        y: button.y
      )
    } else {
      center = CGPoint(x: button.x, y: button.y + half + gap + width.height / 2)
      let minX = insets.leading + gap + width.width / 2
      let maxX = container.width - insets.trailing - gap - width.width / 2
      center.x = maxX >= minX ? min(max(center.x, minX), maxX) : container.width / 2
    }
    return LiveStageHintChip(text: text, padded: false)
      .frame(maxWidth: max(140, fitsBeside ? outerRoom : container.width - insets.leading - insets.trailing - gap * 2))
      .fixedSize(horizontal: false, vertical: true)
      .onGeometryChange(for: CGSize.self) { $0.size } action: { noteSize = $0 }
      .position(center)
  }

  /// Beside the button, on the side with room, kept on the stage.
  private func panelCenter(button: CGPoint) -> CGPoint {
    let size = panelSize == .zero ? CGSize(width: 280, height: 320) : panelSize
    let gap: CGFloat = 10
    var x = opensLeft
      ? button.x - Self.size / 2 - gap - size.width / 2
      : button.x + Self.size / 2 + gap + size.width / 2
    // Too narrow beside it (an upright phone): under or over the button,
    // flush with its edge on the side the menu was opening toward.
    var y = button.y - Self.size / 2 + size.height / 2
    if x - size.width / 2 < insets.leading + 4 || x + size.width / 2 > container.width - insets.trailing - 4 {
      x = opensLeft ? button.x + Self.size / 2 - size.width / 2 : button.x - Self.size / 2 + size.width / 2
      y = button.y + Self.size / 2 + gap + size.height / 2
      if y + size.height / 2 > container.height - insets.bottom - 8 {
        y = button.y - Self.size / 2 - gap - size.height / 2
      }
    }
    let minY = insets.top + 8 + size.height / 2
    let maxY = container.height - insets.bottom - 8 - size.height / 2
    y = maxY >= minY ? min(max(y, minY), maxY) : container.height / 2
    let minX = insets.leading + 4 + size.width / 2
    let maxX = container.width - insets.trailing - 4 - size.width / 2
    x = maxX >= minX ? min(max(x, minX), maxX) : container.width / 2
    return CGPoint(x: x, y: y)
  }
}

/// The menu the button opens: a glass card of rows.
struct LiveStageMenuPanel<Content: View>: View {
  @ViewBuilder var content: () -> Content

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      content()
    }
    .padding(10)
    .frame(width: 284)
    .background(Color(white: 0.08).opacity(0.78), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .glassEffect(.regular, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    .overlay {
      RoundedRectangle(cornerRadius: 22, style: .continuous)
        .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)
    }
    .environment(\.colorScheme, .dark)
    .shadow(color: .black.opacity(0.4), radius: 22, y: 10)
  }
}

/// One row of the menu: a symbol, a title, and an optional trailing detail.
struct LiveStageMenuRow: View {
  let title: String
  let systemImage: String
  var detail: String?
  var tint: Color = .white
  var isOn = false
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button {
      ADEHaptics.light()
      action()
    } label: {
      LiveStageMenuRowLabel(title: title, systemImage: systemImage, detail: detail, tint: tint, isOn: isOn)
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.4 : 1)
    .accessibilityAddTraits(isOn ? .isSelected : [])
  }
}

struct LiveStageMenuRowLabel: View {
  let title: String
  let systemImage: String
  var detail: String?
  var tint: Color = .white
  var isOn = false

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: systemImage)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: 22)
      Text(title)
        .font(.subheadline.weight(.medium))
        .foregroundStyle(tint == .white ? Color.white : tint)
        .lineLimit(1)
      Spacer(minLength: 6)
      if let detail {
        Text(detail)
          .font(.footnote)
          .foregroundStyle(.white.opacity(0.55))
          .lineLimit(1)
      }
      if isOn {
        Image(systemName: "checkmark")
          .font(.system(size: 13, weight: .bold))
          .foregroundStyle(ADEColor.accent)
      }
    }
    .padding(.horizontal, 10)
    .frame(minHeight: 42)
    .contentShape(Rectangle())
  }
}

/// A row of small square buttons inside the menu (Home, keyboard…).
struct LiveStageMenuTile: View {
  let title: String
  let systemImage: String
  var isOn = false
  var disabled = false
  let action: () -> Void

  var body: some View {
    Button {
      ADEHaptics.light()
      action()
    } label: {
      LiveStageMenuTileLabel(title: title, systemImage: systemImage, isOn: isOn)
    }
    .buttonStyle(.plain)
    .disabled(disabled)
    .opacity(disabled ? 0.4 : 1)
    .accessibilityLabel(title)
    .accessibilityAddTraits(isOn ? .isSelected : [])
  }
}

struct LiveStageMenuTileLabel: View {
  let title: String
  let systemImage: String
  var isOn = false

  var body: some View {
    VStack(spacing: 4) {
      Image(systemName: systemImage)
        .font(.system(size: 16, weight: .semibold))
        .frame(height: 20)
      Text(title)
        .font(.system(size: 10, weight: .medium))
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
    .foregroundStyle(isOn ? Color.black : Color.white)
    .frame(maxWidth: .infinity)
    .frame(height: 54)
    .background(isOn ? Color.white.opacity(0.9) : Color.white.opacity(0.1), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
  }
}

/// The ring that fills under a finger held on the picture to take control.
struct LiveStageHoldRing: View {
  let progress: CGFloat

  var body: some View {
    ZStack {
      Circle()
        .fill(Color.black.opacity(0.35))
      Circle()
        .stroke(Color.white.opacity(0.25), lineWidth: 4)
      Circle()
        .trim(from: 0, to: progress)
        .stroke(ADEColor.warning, style: StrokeStyle(lineWidth: 4, lineCap: .round))
        .rotationEffect(.degrees(-90))
      Image(systemName: "hand.point.up.left.fill")
        .font(.system(size: 20, weight: .semibold))
        .foregroundStyle(.white)
    }
    .frame(width: 72, height: 72)
    .allowsHitTesting(false)
  }
}

/// One passing line over a live stream ("Controlling…", "Control ended."),
/// near the bottom of the stage. Never takes a touch.
struct LiveStageHintChip: View {
  let text: String
  /// Kept off the stage's sides (false: the caller places it).
  var padded = true

  var body: some View {
    Text(text)
      .font(.caption.weight(.semibold))
      .foregroundStyle(.white)
      .multilineTextAlignment(.center)
      .padding(.horizontal, 14)
      .padding(.vertical, 8)
      .background(Color(white: 0.16).opacity(0.92), in: Capsule())
      .overlay(Capsule().strokeBorder(Color.white.opacity(0.14), lineWidth: 1))
      .padding(.horizontal, padded ? 24 : 0)
      .transition(.opacity)
      .allowsHitTesting(false)
  }
}

/// The menu's first lines: what is on stage and who drives it.
struct LiveStageMenuHeader: View {
  let title: String
  let detail: String
  var recording = false

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 6) {
        Text(title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(.white)
          .lineLimit(1)
        if recording {
          Image(systemName: "record.circle")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(ADEColor.danger)
            .accessibilityLabel("Recording")
        }
      }
      Text(detail)
        .font(.caption)
        .foregroundStyle(.white.opacity(0.6))
        .lineLimit(2)
    }
    .padding(.horizontal, 10)
    .padding(.top, 4)
    .padding(.bottom, 6)
  }
}

/// Where the stream sits on this display: beside the chat, above it, or the
/// whole screen, remembered for the way the phone is held or folded. Shown
/// only on the stage, and only where there is more than one choice.
struct LiveStagePlacementMenu: View {
  let context: LiveStageContext
  let onPick: () -> Void
  @ObservedObject private var placements = LiveStagePlacements.shared

  var body: some View {
    let current = placements.arrangement(for: context)
    Menu {
      ForEach(context.choices) { choice in
        Button {
          onPick()
          withAnimation(.spring(response: 0.42, dampingFraction: 0.86)) {
            placements.setArrangement(choice, for: context)
          }
        } label: {
          if choice == current {
            Label(choice.title, systemImage: "checkmark")
          } else {
            Label(choice.title, systemImage: choice.symbolName)
          }
        }
      }
    } label: {
      LiveStageMenuRowLabel(title: "Placement", systemImage: current.symbolName, detail: current.title)
    }
    .accessibilityIdentifier("LiveStage.Placement")
  }
}

/// The stage's backdrop in the app's own colours (the viewer above it is
/// drawn dark).
struct LiveStageBackdrop: View {
  let presentation: LiveStagePresentation
  @Environment(\.liveStageHostColorScheme) private var hostScheme
  @Environment(\.colorScheme) private var scheme

  var body: some View {
    presentation.backdrop
      .environment(\.colorScheme, presentation.isPane ? (hostScheme ?? scheme) : scheme)
  }
}

// MARK: - A device viewer's finger

/// What a device viewer's touch rules need of its model: the simulator's and
/// the emulator's both fit.
@MainActor
protocol LiveStageControlModel: AnyObject {
  var mode: AppleDeviceViewerMode { get }
  /// Why Control cannot be offered, or nil when it can.
  var controlBlocker: String? { get }
  func beginControl()
  func clearNotice()
}

extension AppleDeviceViewerModel: LiveStageControlModel {}
extension AndroidDeviceViewerModel: LiveStageControlModel {}

/// Where a finger touched the picture, drawn for a moment so the person sees
/// the touch land before the device's frame comes back.
struct AppleTouchMark: Identifiable, Equatable {
  let id = UUID()
  let location: CGPoint
}

enum LiveStageHintHaptic { case warning }

/// A device viewer's finger bookkeeping that nothing draws. A reference held
/// in `@State`, so a finger moving over the picture never re-runs the body.
final class LiveStageTouchTracker {
  var hintTask: Task<Void, Never>?
  var holdTask: Task<Void, Never>?
  /// The hold took control: the finger's lift is not a touch on the device.
  var holdFired = false
  var holdCancelled = false
  /// The gesture on the device while controlling.
  var gesture: AppleDeviceGesture?
  /// A touch that started off the picture: ignored until it lifts.
  var gestureIgnored = false

  func cancelTasks() {
    hintTask?.cancel()
    holdTask?.cancel()
  }
}

/// A device viewer's touch rules while watching, shared by the simulator and
/// the emulator: a tap opens the menu, holding the picture fills a ring and
/// takes control, a moved finger is nothing. Also the passing hint and the
/// touch marks.
///
/// Built per use from the viewer's own `@State` (each value its own state,
/// so each change keeps its own animation) and its tracker.
@MainActor
struct LiveStageTouch {
  @Binding var hint: String?
  /// A finger held on the picture while watching, filling toward Control.
  @Binding var holdLocation: CGPoint?
  @Binding var holdProgress: CGFloat
  @Binding var touchMarks: [AppleTouchMark]
  @Binding var menuOpen: Bool
  let tracker: LiveStageTouchTracker
  let model: any LiveStageControlModel

  /// Long enough that a thumb resting on the picture does not take control.
  static let holdToControl: Double = 0.6
  /// How long a finger rests before the ring shows: a tap never flashes it.
  static let holdRingDelay: Double = 0.15

  /// A finger on the picture while watching: held still, it takes control
  /// after `holdToControl`; moved, it is nothing.
  func watchingChanged(_ value: DragGesture.Value) {
    let travel = hypot(value.translation.width, value.translation.height)
    if tracker.holdTask == nil, !tracker.holdCancelled {
      guard model.controlBlocker == nil else {
        tracker.holdCancelled = true
        return
      }
      let location = value.startLocation
      tracker.holdTask = Task { @MainActor in
        try? await Task.sleep(for: .seconds(Self.holdRingDelay))
        guard !Task.isCancelled else { return }
        ADEHaptics.light()
        holdProgress = 0
        withAnimation(.easeOut(duration: 0.12)) { holdLocation = location }
        withAnimation(.linear(duration: Self.holdToControl - Self.holdRingDelay)) { holdProgress = 1 }
        try? await Task.sleep(for: .seconds(Self.holdToControl - Self.holdRingDelay))
        guard !Task.isCancelled else { return }
        tracker.holdFired = true
        withAnimation(.easeOut(duration: 0.15)) { holdLocation = nil }
        takeControl()
      }
    } else if travel > 20, !tracker.holdCancelled {
      cancelHold()
    }
  }

  func watchingEnded(_ value: DragGesture.Value) {
    let travel = hypot(value.translation.width, value.translation.height)
    let wasCancelled = tracker.holdCancelled
    let ringShown = holdLocation != nil
    cancelHold()
    tracker.holdCancelled = false
    guard travel < 12, !wasCancelled || model.controlBlocker != nil else { return }
    // Let go while the ring was filling: they meant to take control.
    if ringShown {
      flashHint("Hold a little longer to take control", haptic: nil)
      return
    }
    // A tap: the menu, which also says why Control is unavailable.
    ADEHaptics.light()
    withAnimation(.spring(response: 0.3, dampingFraction: 0.82)) { menuOpen.toggle() }
  }

  /// The finger that took control lifts: true when this lift was it, which
  /// is not a touch on the device.
  func liftAfterHold() -> Bool {
    guard tracker.holdFired else { return false }
    tracker.holdFired = false
    tracker.holdCancelled = false
    return true
  }

  func cancelHold() {
    tracker.holdTask?.cancel()
    tracker.holdTask = nil
    tracker.holdCancelled = true
    if holdLocation != nil {
      withAnimation(.easeOut(duration: 0.15)) {
        holdLocation = nil
        holdProgress = 0
      }
    }
  }

  func takeControl() {
    guard model.mode != .controlling else { return }
    if let blocker = model.controlBlocker {
      flashHint(blocker, haptic: .warning)
      return
    }
    ADEHaptics.success()
    model.beginControl()
    if model.mode == .controlling {
      menuOpen = false
      flashHint("Controlling. The orange button hands it back.", haptic: nil)
    }
  }

  func addTouchMark(at location: CGPoint) {
    let mark = AppleTouchMark(location: location)
    withAnimation(.easeOut(duration: 0.12)) { touchMarks.append(mark) }
    Task { @MainActor in
      try? await Task.sleep(for: .milliseconds(380))
      withAnimation(.easeOut(duration: 0.2)) { touchMarks.removeAll { $0.id == mark.id } }
    }
  }

  /// One line at a time, restarted on each call rather than queued, so
  /// hammering the screen does not stack timers.
  func flashHint(_ text: String, haptic: LiveStageHintHaptic?, seconds: Double = 2) {
    if haptic == .warning { ADEHaptics.warning() }
    hint = text
    tracker.hintTask?.cancel()
    tracker.hintTask = Task { @MainActor in
      try? await Task.sleep(for: .seconds(seconds))
      guard !Task.isCancelled else { return }
      hint = nil
      model.clearNotice()
    }
  }
}

// MARK: - A device viewer's overlays

/// The speed readout's one line: frames, bitrate, round trip, tap to screen.
struct LiveStageSpeedReadout: View {
  let speed: AppleViewerSpeed

  var body: some View {
    HStack(spacing: 12) {
      speedCell("fps", speed.fps.map { "\($0)" })
      speedCell("video", speed.kbps.map { appleStreamBitrateLabel(kbps: $0) })
      speedCell("round trip", speed.rttMs.map { "\(Int($0.rounded())) ms" })
      speedCell("tap → screen", speed.tapToFrameMs.map { "\(Int($0.rounded())) ms" })
      if let skipped = speed.skipped, skipped > 0 {
        speedCell("skipped", "\(skipped)")
      }
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 6)
    .background(.black.opacity(0.6), in: Capsule())
    .allowsHitTesting(false)
    .accessibilityElement(children: .combine)
  }

  private func speedCell(_ label: String, _ value: String?) -> some View {
    VStack(spacing: 1) {
      Text(value ?? "–")
        .font(.caption.monospacedDigit().weight(.semibold))
        .foregroundStyle(.white)
      Text(label)
        .font(.system(size: 9))
        .foregroundStyle(.white.opacity(0.6))
    }
  }
}

/// The stream's status while it is not live, with Reconnect when that can
/// help. `detail` goes under the sentence.
struct LiveStageStatusCard<Detail: View>: View {
  let message: String
  let health: AppleStreamHealth
  let onReconnect: () -> Void
  @ViewBuilder var detail: () -> Detail

  var body: some View {
    VStack(spacing: 12) {
      if health.phase == .connecting || health.phase == .requestingTicket
        || health.phase == .reconnecting {
        ProgressView().tint(.white)
      }
      Text(message)
        .font(.footnote)
        .foregroundStyle(.white.opacity(0.85))
        .multilineTextAlignment(.center)
        .padding(.horizontal, 32)
      detail()
      if health.offersReconnect {
        Button {
          ADEHaptics.light()
          onReconnect()
        } label: {
          Text("Reconnect")
            .font(.footnote.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 9)
            .background(Color.white.opacity(0.16), in: Capsule())
        }
        .buttonStyle(.plain)
      }
    }
    .padding(.vertical, 18)
    .background(.black.opacity(0.55), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    .padding(.horizontal, 24)
  }
}

/// The bar a device viewer types through while controlling: the field, then
/// Return and Hide.
struct LiveStageKeyboardBar: View {
  let placeholder: LocalizedStringKey
  @Binding var text: String
  /// The bar is up (the viewer's own switch).
  @Binding var shown: Bool
  let focused: FocusState<Bool>.Binding
  let onType: (String) -> Void

  var body: some View {
    HStack(spacing: 8) {
      TextField(placeholder, text: $text)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .focused(focused)
        .submitLabel(.send)
        .onSubmit {
          onType(text)
          text = ""
          focused.wrappedValue = true
        }
        .padding(.horizontal, 14)
        .frame(minHeight: 42)
        .background(Color.white.opacity(0.12), in: Capsule())
        .foregroundStyle(.white)
      LiveStageRoundButton(systemName: "return", label: "Return") {
        onType("\n")
      }
      LiveStageRoundButton(systemName: "keyboard.chevron.compact.down", label: "Hide keyboard") {
        hide()
      }
    }
    .padding(.horizontal, 14)
    .frame(maxWidth: 560)
    .frame(maxWidth: .infinity)
    .toolbar {
      ToolbarItemGroup(placement: .keyboard) {
        Spacer()
        Button("Done") { hide() }
      }
    }
  }

  private func hide() {
    focused.wrappedValue = false
    shown = false
  }
}

/// A round glass button on the keyboard bar.
struct LiveStageRoundButton: View {
  let systemName: String
  let label: String
  let action: () -> Void

  var body: some View {
    Button {
      ADEHaptics.light()
      action()
    } label: {
      Image(systemName: systemName)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(.white)
        .frame(width: 42, height: 42)
        .background(Color.white.opacity(0.12), in: Circle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(label)
  }
}
