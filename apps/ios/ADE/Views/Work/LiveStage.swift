import SwiftUI
import UIKit

// The live stage: one place on the phone where a live device stream is shown,
// full screen or over the Duo's tools pane, and the one floating button that
// owns its controls.
//
// The stream is drawn by ONE view that lives at the root of the window
// (`liveStageHost()`), never inside the chat. Moving it between the pane and
// the whole display, or folding the phone so the app moves to its front
// screen, only changes where that view is laid out: the socket, the decoder
// and Control all carry on, with no reconnect.

// MARK: - Placement

/// Where the stream sits on a large display.
enum LiveStageArrangement: String, CaseIterable, Identifiable {
  /// Its own column, the chat beside it (the hinge is the divider).
  case beside
  /// The top half, the chat under it.
  case above
  /// The whole display.
  case fullScreen

  var id: String { rawValue }

  var title: String {
    switch self {
    case .beside: return "Beside the chat"
    case .above: return "Above the chat"
    case .fullScreen: return "Full screen"
    }
  }

  var symbolName: String {
    switch self {
    case .beside: return "rectangle.righthalf.filled"
    case .above: return "rectangle.tophalf.filled"
    case .fullScreen: return "rectangle.inset.filled"
    }
  }
}

/// A way the phone is held or folded that remembers its own placement.
enum LiveStageContext: String {
  /// An iPhone, the Duo's front screen (closed or tent): the whole display.
  case compact
  /// A large display wider than tall: the Duo open flat on its side, an
  /// iPad on its side.
  case landscape
  /// The Duo bent like a book: two pages, the crease between them. Nothing
  /// is drawn across the crease, so the stream takes a page.
  case book
  /// A large display held upright: the Duo open flat, an iPad.
  case portrait
  /// The Duo bent with the fold across the screen.
  case laptop

  init(layout: DuoLayout) {
    guard layout.isWide else {
      self = .compact
      return
    }
    switch layout.fold {
    case .stacked where layout.bend > 0:
      self = .laptop
    // Bent past a hand's wobble (about 165°): a Duo held "flat" rarely
    // reads exactly 180°, and the wide picture must not hop off the top.
    case .sideBySide where layout.bend >= 0.15:
      self = .book
    case .sideBySide:
      self = .landscape
    default:
      self = layout.isLandscape ? .landscape : .portrait
    }
  }

  /// What the stream opens as until the person picks something else here.
  var defaultArrangement: LiveStageArrangement {
    switch self {
    case .compact: return .fullScreen
    case .landscape, .book: return .beside
    case .portrait, .laptop: return .above
    }
  }

  /// What the Placement menu offers. Laptop always keeps the stream on the
  /// top half (or the whole screen): its bottom half is the keyboard deck.
  var choices: [LiveStageArrangement] {
    switch self {
    case .compact: return [.fullScreen]
    case .laptop: return [.above, .fullScreen]
    case .book: return [.beside, .fullScreen]
    case .landscape, .portrait: return [.beside, .above, .fullScreen]
    }
  }
}

/// The arrangement picked per context and picture shape, remembered across
/// launches. Apart from `LiveStage` so the split around the chat observes
/// only this, which changes when the person picks, never while a pane moves.
///
/// A tall picture (a phone) and a wide one (a desktop) remember their own
/// picks: beside the chat suits a phone and wastes a desktop's height, so a
/// wide picture opens above the chat on a large display.
@MainActor
final class LiveStagePlacements: ObservableObject {
  static let shared = LiveStagePlacements()

  @Published private(set) var picks: [String: LiveStageArrangement]

  private static let defaultsKey = "ade.liveStage.placement"

  init() {
    var picks: [String: LiveStageArrangement] = [:]
    if let stored = UserDefaults.standard.dictionary(forKey: Self.defaultsKey) as? [String: String] {
      for (key, arrangement) in stored {
        let context = LiveStageContext(rawValue: String(key.split(separator: ".").first ?? ""))
        if let context, let arrangement = LiveStageArrangement(rawValue: arrangement),
           context.choices.contains(arrangement) {
          picks[key] = arrangement
        }
      }
    }
    self.picks = picks
  }

  /// The picture on stage runs wider than tall. Unknown (no frame yet) is
  /// tall, the simulator's usual shape.
  private var wide: Bool { (LiveStagePicture.shared.aspect ?? 0) > 1.05 }

  private func key(_ context: LiveStageContext) -> String {
    wide ? "\(context.rawValue).wide" : context.rawValue
  }

  private func defaultArrangement(for context: LiveStageContext) -> LiveStageArrangement {
    if wide, context == .landscape { return .above }
    return context.defaultArrangement
  }

  func arrangement(for context: LiveStageContext) -> LiveStageArrangement {
    picks[key(context)] ?? defaultArrangement(for: context)
  }

  /// The Work split stacks a live stream over the chat: always on a laptop
  /// fold, and wherever it is placed above the chat.
  func stacksAbove(layout: DuoLayout, family: DuoFamily) -> Bool {
    family == .tall || arrangement(for: LiveStageContext(layout: layout)) == .above
  }

  /// Remembers a pick for this context and shape. Picking the default
  /// forgets it, so a changed default reaches people who never moved it.
  func setArrangement(_ arrangement: LiveStageArrangement, for context: LiveStageContext) {
    guard context.choices.contains(arrangement) else { return }
    let key = key(context)
    let next: LiveStageArrangement? = arrangement == defaultArrangement(for: context) ? nil : arrangement
    guard picks[key] != next else { return }
    picks[key] = next
    UserDefaults.standard.set(
      Dictionary(uniqueKeysWithValues: picks.map { ($0.key, $0.value.rawValue) }),
      forKey: Self.defaultsKey
    )
  }
}

/// A picture the person turned a quarter turn, remembered per kind of stream
/// and per place it is shown: a desktop turned to fill the Duo's right page
/// stays turned there, and is upright again above the chat on a flat Duo.
///
/// The place is the stage context, and on a phone-sized display which way
/// the display is held. Never the pane's own shape: turning a picture can
/// move its pane (a tall picture goes beside the chat), and a pick keyed on
/// the pane would turn it straight back.
@MainActor
final class LiveStageTurns: ObservableObject {
  static let shared = LiveStageTurns()

  @Published private(set) var turned: Set<String>

  private static let defaultsKey = "ade.liveStage.turned"

  init() {
    turned = Set(UserDefaults.standard.stringArray(forKey: Self.defaultsKey) ?? [])
  }

  static func key(_ kind: String, context: LiveStageContext, layout: DuoLayout) -> String {
    context == .compact && layout.isLandscape ? "\(kind).compact.side" : "\(kind).\(context.rawValue)"
  }

  func isTurned(_ key: String) -> Bool { turned.contains(key) }

  func toggle(_ key: String) {
    if turned.contains(key) { turned.remove(key) } else { turned.insert(key) }
    UserDefaults.standard.set(turned.sorted(), forKey: Self.defaultsKey)
  }
}

/// The picture on stage's shape (width over height, as drawn), so the pane
/// beside the chat can be exactly as wide as the picture: no bars. Apart from
/// `LiveStage` so the split observes only this, which changes when the
/// picture turns, never while a pane moves.
@MainActor
final class LiveStagePicture: ObservableObject {
  static let shared = LiveStagePicture()

  @Published private(set) var aspect: CGFloat?
  private var owner: UUID?

  func report(_ aspect: CGFloat?, session: UUID) {
    owner = session
    // A thousandth is finer than a point at any pane size; a decoder that
    // reports the same size twice must not re-lay out the chat.
    let next = aspect.flatMap { $0.isFinite && $0 > 0 ? ($0 * 1000).rounded() / 1000 : nil }
    if self.aspect != next { self.aspect = next }
  }

  func clear(session: UUID) {
    guard owner == session else { return }
    owner = nil
    if aspect != nil { aspect = nil }
  }
}

// MARK: - Coordinator

/// The stream on stage, if any, and where it goes.
@MainActor
final class LiveStage: ObservableObject {
  static let shared = LiveStage()

  enum Kind: String {
    case simulator
    case macDesktop
    case appControl
  }

  /// What a stream is opened with: its kind and the opener's last snapshot,
  /// so the viewer's first frame is right rather than an empty one.
  enum Seed {
    case simulator(AppleDeviceStatus?)
    case macDesktop(WorkToolsMacDesktopState?)
    case appControl(WorkToolsAppControlState?)

    var kind: Kind {
      switch self {
      case .simulator: return .simulator
      case .macDesktop: return .macDesktop
      case .appControl: return .appControl
      }
    }
  }

  /// One stream someone opened. Equal by id: a new open is a new stream.
  struct Session: Identifiable, Equatable {
    let id = UUID()
    let seed: Seed
    let laneId: String
    let chatSessionId: String?
    /// Opened from the Duo's tools pane, which it then sits over.
    var fromPane: Bool
    #if DEBUG
    /// The viewer's fixture seed (`AppleDeviceViewerPreview`,
    /// `MacDesktopViewerPreview`, `AppControlViewerPreview`).
    var preview: Any?
    #endif

    var kind: Kind { seed.kind }

    static func == (lhs: Session, rhs: Session) -> Bool { lhs.id == rhs.id }

    func isSameStream(kind: Kind, laneId: String, chatSessionId: String?) -> Bool {
      self.kind == kind && self.laneId == laneId && self.chatSessionId == chatSessionId
    }
  }

  @Published private(set) var session: Session?
  /// The tools pane's frame in window coordinates while it holds the stream.
  @Published private(set) var anchor: CGRect?
  /// What inside that frame is the system's (the status bar, the edge bar):
  /// the picture and its button stay clear of it, the black runs under it.
  @Published private(set) var anchorInsets = EdgeInsets()

  /// How the opener puts its own surface away (the pane's Close).
  private var closeOpener: (() -> Void)?
  /// Whether the window was a large display when last laid out: a pane that
  /// goes away on a large display was closed; one that goes because the phone
  /// folded to its front screen was not.
  private var hostIsWide = false
  private var anchorGrace: Task<Void, Never>?
  /// The pane slot whose frame `anchor` is. A re-laid-out pane builds a new
  /// slot before the old one goes, so only the slot that holds the anchor
  /// may give it up.
  private var anchorSlot: UUID?

  // MARK: Sessions

  /// Puts a stream on stage, or keeps the one already there when it is the
  /// same stream for the same chat (a pane re-laid out after a fold).
  func open(
    _ seed: Seed,
    laneId: String,
    chatSessionId: String?,
    fromPane: Bool,
    onClose: (() -> Void)?,
    preview: Any? = nil
  ) {
    anchorGrace?.cancel()
    anchorGrace = nil
    closeOpener = onClose
    if var current = session, current.isSameStream(kind: seed.kind, laneId: laneId, chatSessionId: chatSessionId) {
      if current.fromPane != fromPane {
        current.fromPane = fromPane
        session = current
      }
      return
    }
    var next = Session(seed: seed, laneId: laneId, chatSessionId: chatSessionId, fromPane: fromPane)
    #if DEBUG
    next.preview = preview
    #endif
    anchor = nil
    session = next
  }

  func openSimulator(
    laneId: String,
    chatSessionId: String?,
    status: AppleDeviceStatus?,
    fromPane: Bool,
    onClose: (() -> Void)?,
    preview: Any? = nil
  ) {
    open(.simulator(status), laneId: laneId, chatSessionId: chatSessionId, fromPane: fromPane, onClose: onClose, preview: preview)
  }

  /// The person closed the stream: it leaves the stage and its opener (the
  /// pane) goes too.
  func close() {
    let opener = closeOpener
    end()
    opener?()
  }

  /// The stream leaves the stage; its opener already went.
  func end() {
    anchorGrace?.cancel()
    anchorGrace = nil
    closeOpener = nil
    anchorSlot = nil
    if let id = session?.id { LiveStagePicture.shared.clear(session: id) }
    if anchor != nil { anchor = nil }
    if session != nil { session = nil }
  }

  // MARK: The pane

  func setAnchor(_ rect: CGRect, insets: EdgeInsets, slot: UUID, session id: UUID) {
    guard session?.id == id else { return }
    anchorGrace?.cancel()
    anchorGrace = nil
    anchorSlot = slot
    if anchor != rect { anchor = rect }
    if anchorInsets != insets { anchorInsets = insets }
  }

  /// The pane holding the stream went away. On a large display that is a
  /// closed pane, or the chat left behind: the stream ends after a moment
  /// (unless the pane comes straight back, as it does when re-laid out). A
  /// phone folding to its front screen keeps it, full screen.
  func anchorGone(slot: UUID, session id: UUID) {
    guard session?.id == id, anchorSlot == slot || anchorSlot == nil else { return }
    anchorSlot = nil
    if anchor != nil { anchor = nil }
    anchorGrace?.cancel()
    anchorGrace = Task { @MainActor [weak self] in
      try? await Task.sleep(for: .milliseconds(450))
      guard let self, !Task.isCancelled, self.session?.id == id, self.anchor == nil else { return }
      self.anchorGrace = nil
      if self.hostIsWide { self.end() }
    }
  }

  func hostLayoutChanged(isWide: Bool) {
    hostIsWide = isWide
  }
}

/// What the stage tells the stream view about where it is drawn.
enum LiveStagePresentation: Equatable {
  /// The whole window.
  case fullScreen
  /// Over the tools pane, arranged beside or above the chat.
  case pane(LiveStageArrangement)
  /// Nowhere for a moment (the pane is being re-laid out). Kept alive so the
  /// stream does not reconnect.
  case hidden

  var isFullScreen: Bool { self == .fullScreen }
  var isPane: Bool {
    if case .pane = self { return true }
    return false
  }

  /// Room around the picture: none full screen; over the pane a hairline of
  /// the page, so the device reads as standing beside the chat.
  var pictureGap: CGFloat { isPane ? 6 : 0 }

  /// What shows where the picture does not reach: black full screen, the
  /// page itself over the pane (never black bars beside a chat). Draw it
  /// with `LiveStageBackdrop`, which keeps the page in the app's colours.
  var backdrop: Color { isPane ? ADEColor.pageBackground : .black }

  /// The device's screen corners over the pane; square full screen, where the
  /// display's own corners round it.
  func cornerRadius(for picture: CGSize) -> CGFloat {
    isPane ? min(picture.width, picture.height) * 0.08 : 0
  }
}

private struct LiveStageCloseKey: EnvironmentKey {
  static let defaultValue: (() -> Void)? = nil
}

private struct LiveStageContextKey: EnvironmentKey {
  static let defaultValue: LiveStageContext = .compact
}

private struct LiveStageAspectKey: EnvironmentKey {
  static let defaultValue: ((CGFloat?) -> Void)? = nil
}

private struct LiveStageHidesStatusBarKey: EnvironmentKey {
  static let defaultValue = false
}

private struct LiveStageHostColorSchemeKey: EnvironmentKey {
  static let defaultValue: ColorScheme? = nil
}

private struct LiveStagePictureTurnedKey: EnvironmentKey {
  static let defaultValue = false
}

extension EnvironmentValues {
  /// The picture is drawn a quarter turn round (`liveStageQuarterTurn`), so
  /// the shape it reports is the other way up.
  var liveStagePictureTurned: Bool {
    get { self[LiveStagePictureTurnedKey.self] }
    set { self[LiveStagePictureTurnedKey.self] = newValue }
  }

  /// Closes the stream on stage (and the pane it sits over). Nil outside it.
  var liveStageClose: (() -> Void)? {
    get { self[LiveStageCloseKey.self] }
    set { self[LiveStageCloseKey.self] = newValue }
  }

  /// The context the stage is in, for the Placement menu.
  var liveStageContext: LiveStageContext {
    get { self[LiveStageContextKey.self] }
    set { self[LiveStageContextKey.self] = newValue }
  }

  /// Reports the picture's drawn shape to the stage. Nil outside it.
  var liveStageReportAspect: ((CGFloat?) -> Void)? {
    get { self[LiveStageAspectKey.self] }
    set { self[LiveStageAspectKey.self] = newValue }
  }

  /// The app's own appearance around the stage (a viewer draws itself dark):
  /// the pane's backdrop is the page the chat sits on, in its colours.
  var liveStageHostColorScheme: ColorScheme? {
    get { self[LiveStageHostColorSchemeKey.self] }
    set { self[LiveStageHostColorSchemeKey.self] = newValue }
  }

  /// The clock would sit over the picture: hide it. Only the Duo's edge bar
  /// keeps it, in its own column beside the pane.
  var liveStageHidesStatusBar: Bool {
    get { self[LiveStageHidesStatusBarKey.self] }
    set { self[LiveStageHidesStatusBarKey.self] = newValue }
  }
}

extension View {
  /// Tells the stage (when this is on it) the picture's shape, width over
  /// height as drawn, so the pane can fit it exactly.
  func liveStageReportsAspect(_ aspect: CGFloat?) -> some View {
    modifier(LiveStageAspectReporter(aspect: aspect))
  }
}

private struct LiveStageAspectReporter: ViewModifier {
  let aspect: CGFloat?
  @Environment(\.liveStageReportAspect) private var report
  @Environment(\.liveStagePictureTurned) private var turned

  func body(content: Content) -> some View {
    content.onChange(of: [aspect ?? 0, turned ? 1 : 0], initial: true) { _, _ in
      report?(turned ? aspect.map { 1 / $0 } : aspect)
    }
  }
}

extension View {
  /// Draws a stage's picture a quarter turn clockwise inside `size`: laid
  /// out in the turned size, so a wide desktop fills a tall page or a phone
  /// held upright. Touches land in the picture's own coordinates, so its
  /// gestures and their mapping to the remote screen need no change.
  func liveStageQuarterTurn(_ turned: Bool, in size: CGSize) -> some View {
    self
      .environment(\.liveStagePictureTurned, turned)
      .frame(width: turned ? size.height : size.width, height: turned ? size.width : size.height)
      .rotationEffect(.degrees(turned ? 90 : 0))
      .frame(width: size.width, height: size.height)
  }
}

// MARK: - Host

extension View {
  /// Draws the stream on stage over everything else in the window. Apply once,
  /// inside `.duoLayoutRoot()` so it reads the display's layout.
  func liveStageHost() -> some View {
    modifier(LiveStageHost())
  }
}

private struct LiveStageHost: ViewModifier {
  /// A pane starting this close to the top starts under the bar's band.
  static let barBand: CGFloat = 120
  /// A pane ending this close to the bottom ends at the home indicator.
  static let bottomBand: CGFloat = 60

  @ObservedObject private var stage = LiveStage.shared
  @ObservedObject private var placements = LiveStagePlacements.shared
  /// The picture's shape picks its placement's default.
  @ObservedObject private var picture = LiveStagePicture.shared
  @Environment(\.duoLayout) private var duo
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorScheme) private var colorScheme

  func body(content: Content) -> some View {
    content
      .overlay {
        if let session = stage.session {
          GeometryReader { proxy in
            let window = proxy.frame(in: .global)
            let presentation = presentation(for: session)
            let frame = frame(for: presentation, window: window, size: proxy.size)
            LiveStageSessionView(
              session: session,
              presentation: presentation,
              chromeInsets: presentation.isPane
                ? paneInsets(window: proxy.safeAreaInsets)
                : proxy.safeAreaInsets
            )
              .id(session.id)
              .frame(width: frame.width, height: frame.height)
              .position(x: frame.midX, y: frame.midY)
              .opacity(presentation == .hidden ? 0 : 1)
              .allowsHitTesting(presentation != .hidden)
              .animation(reduceMotion ? nil : .spring(response: 0.42, dampingFraction: 0.86), value: presentation)
              .animation(reduceMotion ? nil : .spring(response: 0.42, dampingFraction: 0.86), value: stage.anchor)
              .environment(\.liveStageClose, { stage.close() })
              .environment(\.liveStageContext, LiveStageContext(layout: duo))
              .environment(\.liveStageReportAspect, { [id = session.id] aspect in
                LiveStagePicture.shared.report(aspect, session: id)
              })
              .environment(\.liveStageHidesStatusBar, presentation.isFullScreen || !duo.hasEdgeBar)
              .environment(\.liveStageHostColorScheme, colorScheme)
          }
          .ignoresSafeArea(.container)
          .transition(.opacity)
        }
      }
      .onChange(of: duo.isWide, initial: true) { _, isWide in
        stage.hostLayoutChanged(isWide: isWide)
      }
  }

  /// Over the pane, the picture keeps clear of the status bar and the home
  /// indicator, not of the chat's bar band (which has nothing over the pane).
  private func paneInsets(window: EdgeInsets) -> EdgeInsets {
    EdgeInsets(
      top: min(stage.anchorInsets.top, window.top),
      leading: 0,
      bottom: min(stage.anchorInsets.bottom, window.bottom),
      trailing: 0
    )
  }

  private func presentation(for session: LiveStage.Session) -> LiveStagePresentation {
    guard duo.isWide else { return .fullScreen }
    let arrangement = placements.arrangement(for: LiveStageContext(layout: duo))
    if arrangement == .fullScreen { return .fullScreen }
    if stage.anchor != nil { return .pane(arrangement) }
    // Opened on the front screen and unfolded: there is no pane to go to.
    return session.fromPane ? .hidden : .fullScreen
  }

  private func frame(for presentation: LiveStagePresentation, window: CGRect, size: CGSize) -> CGRect {
    switch presentation {
    case .pane:
      if let anchor = stage.anchor {
        var local = anchor.offsetBy(dx: -window.minX, dy: -window.minY)
        // Beside the edge bar nothing of the app's sits over the pane's
        // column: it runs from the screen's top edge (past the empty band
        // under the bar) to its bottom edge (past the home indicator). The
        // pane cannot claim those itself; they are not safe areas it owns.
        // Without the edge bar (an iPad) the top bar's buttons stay above it,
        // but nothing sits under its foot: it still runs to the bottom edge.
        if duo.hasEdgeBar, local.minY < Self.barBand {
          local = CGRect(x: local.minX, y: 0, width: local.width, height: local.maxY)
        }
        if size.height - local.maxY < Self.bottomBand {
          local.size.height = size.height - local.minY
        }
        return local.intersection(CGRect(origin: .zero, size: size))
      }
      return CGRect(origin: .zero, size: size)
    case .fullScreen, .hidden:
      return CGRect(origin: .zero, size: size)
    }
  }
}

/// The stream view for one session.
private struct LiveStageSessionView: View {
  let session: LiveStage.Session
  let presentation: LiveStagePresentation
  /// Full screen, the window's safe area: the picture runs edge to edge but
  /// the menu button stays clear of the notch and the home indicator. Over the
  /// pane, the system's part of the pane (status bar, edge bar).
  let chromeInsets: EdgeInsets

  var body: some View {
    switch session.seed {
    case .simulator(let status):
      simulator(status)
    case .macDesktop(let state):
      macDesktop(state)
    case .appControl(let state):
      appControl(state)
    }
  }

  @ViewBuilder
  private func simulator(_ status: AppleDeviceStatus?) -> some View {
    #if DEBUG
    AppleDeviceViewer(
      laneId: session.laneId,
      chatSessionId: session.chatSessionId,
      initialStatus: status,
      presentation: presentation,
      chromeInsets: chromeInsets,
      preview: session.preview as? AppleDeviceViewerPreview
    )
    #else
    AppleDeviceViewer(
      laneId: session.laneId,
      chatSessionId: session.chatSessionId,
      initialStatus: status,
      presentation: presentation,
      chromeInsets: chromeInsets
    )
    #endif
  }

  @ViewBuilder
  private func macDesktop(_ state: WorkToolsMacDesktopState?) -> some View {
    #if DEBUG
    MacDesktopViewer(
      laneId: session.laneId,
      initialState: state,
      chatSessionId: session.chatSessionId,
      presentation: presentation,
      chromeInsets: chromeInsets,
      preview: session.preview as? MacDesktopViewerPreview
    )
    #else
    MacDesktopViewer(
      laneId: session.laneId,
      initialState: state,
      chatSessionId: session.chatSessionId,
      presentation: presentation,
      chromeInsets: chromeInsets
    )
    #endif
  }

  @ViewBuilder
  private func appControl(_ state: WorkToolsAppControlState?) -> some View {
    #if DEBUG
    AppControlViewer(
      laneId: session.laneId,
      initialState: state,
      chatSessionId: session.chatSessionId,
      presentation: presentation,
      chromeInsets: chromeInsets,
      preview: session.preview as? AppControlViewerPreview
    )
    #else
    AppControlViewer(
      laneId: session.laneId,
      initialState: state,
      chatSessionId: session.chatSessionId,
      presentation: presentation,
      chromeInsets: chromeInsets
    )
    #endif
  }
}

// MARK: - The pane's slot

/// What the tools pane shows for a live stream: nothing of its own. It puts
/// the stream on stage and reports where it is, and the stage draws the
/// stream over it.
struct LiveStagePaneSlot: View {
  let laneId: String
  let chatSessionId: String?
  /// Which stream, seeded with the chip's last snapshot.
  let seed: LiveStage.Seed
  let onClose: () -> Void
  #if DEBUG
  /// The viewer's fixture seed; see `LiveStage.Session.preview`.
  var preview: Any?
  #endif

  @ObservedObject private var stage = LiveStage.shared
  @State private var slot = UUID()
  /// The last frames read, for a stream put on stage after the first layout.
  @State private var geometry = LiveStagePaneGeometry()

  var body: some View {
    // Up under the bar and down to the screen's edge (the full frame's
    // height), but never under the edge bar beside it, which keeps its own
    // items (the safe frame's width).
    Color.clear
      .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { rect in
        geometry.safe = rect
        report()
      }
      .background {
        ADEColor.pageBackground
          .ignoresSafeArea(.container, edges: .vertical)
          .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { rect in
            geometry.full = rect
            report()
          }
      }
      .preference(key: DuoPaneHidesHeaderKey.self, value: true)
      .onAppear {
        #if DEBUG
        stage.open(seed, laneId: laneId, chatSessionId: chatSessionId, fromPane: true, onClose: onClose, preview: preview)
        #else
        stage.open(seed, laneId: laneId, chatSessionId: chatSessionId, fromPane: true, onClose: onClose)
        #endif
        report()
      }
      .onDisappear {
        if let id = stage.session?.id { stage.anchorGone(slot: slot, session: id) }
      }
      .accessibilityHidden(true)
  }

  private func report() {
    guard let frame = geometry.frame, let id = stage.session?.id else { return }
    stage.setAnchor(frame, insets: EdgeInsets(), slot: slot, session: id)
  }
}

private struct LiveStagePaneGeometry: Equatable {
  var safe: CGRect?
  var full: CGRect?

  /// The safe frame's width, the full frame's height.
  var frame: CGRect? {
    guard let safe, let full, safe.width > 0, full.height > 0 else { return nil }
    return CGRect(x: safe.minX, y: full.minY, width: safe.width, height: full.height)
  }
}

/// A pane surface that draws its own controls (the live stage) asks the pane
/// for its whole height, with no header row.
struct DuoPaneHidesHeaderKey: PreferenceKey {
  static var defaultValue = false
  static func reduce(value: inout Bool, nextValue: () -> Bool) {
    value = value || nextValue()
  }
}

// MARK: - The menu button

/// Where the floating menu button rests, as fractions of the stage, and on
/// which side. Remembered per stage shape, so it stays where it was put.
struct LiveStageButtonSpot: Equatable {
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
    let width = container.width - gap * 2
    let height = container.height - gap * 2
    guard width > 0, height > 0 else { return nil }
    let fitWidth = min(width, height * aspect)
    let picture = CGRect(
      x: (container.width - fitWidth) / 2,
      y: (container.height - fitWidth / aspect) / 2,
      width: fitWidth,
      height: fitWidth / aspect
    )
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
