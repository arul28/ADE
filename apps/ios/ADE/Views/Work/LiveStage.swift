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

  /// The Work split stacks its halves: always on a laptop fold, and with a
  /// live stream (`live`) wherever it is placed above the chat.
  func stacks(layout: DuoLayout, family: DuoFamily, live: Bool) -> Bool {
    family == .tall || live && arrangement(for: LiveStageContext(layout: layout)) == .above
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

#if DEBUG
/// A fixture's drawn stand-in for a stream (`-adePreviewScreen`), by kind.
enum LiveStagePreview {
  case simulator(AppleDeviceViewerPreview)
  case macDesktop(MacDesktopViewerPreview)
  case appControl(AppControlViewerPreview)
}
#else
/// Release builds have no fixtures, so no preview can be made.
typealias LiveStagePreview = Never
#endif

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
    /// The viewer's fixture stand-in; always nil in a release build.
    var preview: LiveStagePreview?

    var kind: Kind { seed.kind }

    static func == (lhs: Session, rhs: Session) -> Bool { lhs.id == rhs.id }

    func isSameStream(kind: Kind, laneId: String, chatSessionId: String?) -> Bool {
      self.kind == kind && self.laneId == laneId && self.chatSessionId == chatSessionId
    }
  }

  @Published private(set) var session: Session?
  /// The tools pane's frame in window coordinates while it holds the stream.
  @Published private(set) var anchor: CGRect?

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
    preview: LiveStagePreview? = nil
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
    let next = Session(seed: seed, laneId: laneId, chatSessionId: chatSessionId, fromPane: fromPane, preview: preview)
    anchor = nil
    session = next
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

  func setAnchor(_ rect: CGRect, slot: UUID, session id: UUID) {
    guard session?.id == id else { return }
    anchorGrace?.cancel()
    anchorGrace = nil
    anchorSlot = slot
    if anchor != rect { anchor = rect }
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

  /// A screen's corners (a desktop, an app window) over the pane; square
  /// full screen.
  var screenCornerRadius: CGFloat { isPane ? 18 : 0 }
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
                ? paneInsets(frame: frame, size: proxy.size, window: proxy.safeAreaInsets)
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

  /// Over the pane, the menu button keeps clear of the part of the window's
  /// safe area the pane reaches into (the home indicator at its foot, the
  /// status bar at its head); the picture still runs under them.
  private func paneInsets(frame: CGRect, size: CGSize, window: EdgeInsets) -> EdgeInsets {
    EdgeInsets(
      top: max(0, window.top - frame.minY),
      leading: 0,
      bottom: max(0, frame.maxY - (size.height - window.bottom)),
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
      preview: { if case .simulator(let preview)? = session.preview { return preview } else { return nil } }()
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
      preview: { if case .macDesktop(let preview)? = session.preview { return preview } else { return nil } }()
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
      preview: { if case .appControl(let preview)? = session.preview { return preview } else { return nil } }()
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
  /// The viewer's fixture stand-in; see `LiveStage.Session.preview`.
  var preview: LiveStagePreview?

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
        stage.open(seed, laneId: laneId, chatSessionId: chatSessionId, fromPane: true, onClose: onClose, preview: preview)
        report()
      }
      .onDisappear {
        if let id = stage.session?.id { stage.anchorGone(slot: slot, session: id) }
      }
      .accessibilityHidden(true)
  }

  private func report() {
    guard let frame = geometry.frame, let id = stage.session?.id else { return }
    stage.setAnchor(frame, slot: slot, session: id)
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
