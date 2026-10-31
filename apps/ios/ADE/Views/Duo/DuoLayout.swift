import SwiftUI

/// Where the fold of an iPhone Duo's inner display sits right now, in the
/// coordinate space of the view that read it.
///
/// A fold only exists while the device is partly folded. Flat open, closed,
/// and every device without a hinge report `.none`.
enum DuoFold: Equatable {
  case none
  /// Book: the fold is a vertical line, with a page on each side.
  case sideBySide(CGRect)
  /// Laptop or tent: the fold is a horizontal line, with a top and a bottom half.
  case stacked(CGRect)

  var frame: CGRect? {
    switch self {
    case .none: return nil
    case .sideBySide(let rect), .stacked(let rect): return rect
    }
  }

  var isStacked: Bool {
    if case .stacked = self { return true }
    return false
  }
}

/// The large-screen layout facts every Duo-aware view reads from the
/// environment: is there room for desktop-style panes, and is the screen
/// folded. Set once at the root with `.duoLayoutRoot()`.
struct DuoLayout: Equatable {
  /// Regular width: the Duo's inner display (or an iPad). Panes appear only
  /// here; the outer display and every other iPhone keep the phone layout.
  var isWide = false
  /// The fold, in the root view's coordinate space.
  var fold: DuoFold = .none
  /// The hinge angle in degrees, or nil on a device without a hinge.
  var hingeAngle: Double?
  /// The display has a fold at all (the Duo's inner display), folded or flat.
  /// False on an iPad, the outer display and every other iPhone.
  var hasFold = false
  /// The window is wider than tall.
  var isLandscape = false

  /// Something else stands along the curved edge (Activity's column), so
  /// the screen under it does not reach the edge and gets no edge bar.
  var edgeBarYielded = false

  /// iOS draws the trailing column's toolbar as the vertical bar on the
  /// display's curved right edge: the Duo's inner display, held landscape.
  /// Never on an iPad (same size class, no fold), never held upright, and not
  /// for a screen a column beside it has pushed off the edge.
  var hasEdgeBar: Bool { isWide && hasFold && isLandscape && !edgeBarYielded }

  /// How far the hinge is bent away from flat, 0 (flat or closed) to 1
  /// (folded to a right angle). Drives the fold's depth effects.
  var bend: Double {
    guard let hingeAngle, hingeAngle > 0, hingeAngle < 180 else { return 0 }
    return min(1, max(0, (180 - hingeAngle) / 90))
  }
}

private struct DuoLayoutKey: EnvironmentKey {
  static let defaultValue = DuoLayout()
}

extension EnvironmentValues {
  var duoLayout: DuoLayout {
    get { self[DuoLayoutKey.self] }
    set { self[DuoLayoutKey.self] = newValue }
  }
}

extension View {
  /// Publishes `\.duoLayout` to everything below. Apply once, at the root of a
  /// window, so the fold frame is in full-window coordinates.
  func duoLayoutRoot() -> some View {
    modifier(DuoLayoutRootModifier())
  }
}

private struct DuoLayoutRootModifier: ViewModifier {
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass
  @State private var hingeAngle: Double?

  func body(content: Content) -> some View {
    GeometryReader { proxy in
      content
        .environment(\.duoLayout, DuoLayout(
          isWide: horizontalSizeClass == .regular,
          fold: DuoFoldReading.fold(in: proxy),
          hingeAngle: hingeAngle,
          hasFold: DuoFoldReading.hasFold(in: proxy),
          isLandscape: proxy.isLandscapeIgnoringKeyboard
        ))
    }
    .modifier(DuoHingeObserver(angle: $hingeAngle))
  }
}

extension GeometryProxy {
  /// Wider than tall, measured on the view's whole frame, safe areas
  /// included. The keyboard is a safe area: it shrinks `size` (an upright
  /// phone's view goes wider than tall while it is up), and a layout that
  /// changed with it would drop the keyboard, grow back, and loop.
  var isLandscapeIgnoringKeyboard: Bool {
    let insets = safeAreaInsets
    return size.width + insets.leading + insets.trailing > size.height + insets.top + insets.bottom
  }
}

/// Reads the active fold from a geometry proxy. Shared by the root and by
/// panes that need the fold in their own coordinate space.
enum DuoFoldReading {
  static func fold(in proxy: GeometryProxy) -> DuoFold {
    #if compiler(>=6.4)
    guard #available(iOS 27.1, *) else { return .none }
    let regions = proxy.reservedRegions(kind: .division)
    guard let region = regions.first(where: { $0.isActive }) else { return .none }
    let frame = region.frame
    return frame.width >= frame.height ? .stacked(frame) : .sideBySide(frame)
    #else
    return .none
    #endif
  }

  /// Whether the display has a fold, active or not: the Duo's inner display
  /// reports its (inactive) division even while flat.
  static func hasFold(in proxy: GeometryProxy) -> Bool {
    #if compiler(>=6.4)
    guard #available(iOS 27.1, *) else { return false }
    return !proxy.reservedRegions(kind: .division, options: .includeInactive).isEmpty
    #else
    return false
    #endif
  }
}

// MARK: - Edge bar alignment

/// The Duo's edge bar, as far as content has to line up with it.
///
/// iOS insets the bar concentrically into the display's bottom-right corner:
/// the bottom of its last capsule sits as far above the window's bottom edge
/// as its right side sits in from the window's right edge. Measured on the
/// inner display, open flat and book-folded: 24pt both ways.
enum DuoEdgeBar {
  /// From the window's bottom edge to the bottom of the bar's last capsule.
  static let bottomInset: CGFloat = 24
}

extension View {
  /// Lines the bottom of a column's last view (its composer) up with the
  /// bottom of the edge bar's last capsule while the edge bar is showing (the
  /// Duo's inner display held landscape); elsewhere it changes nothing.
  ///
  /// Apply it to the column itself — the stack whose last child is the
  /// composer, filling the edge bar's column — not to the composer: the
  /// column then runs to the window's bottom edge (past the home indicator's
  /// safe area, which the bar ignores too) and stops `DuoEdgeBar.bottomInset`
  /// above it, so nothing above the composer loses height.
  ///
  /// `contentBottomPadding` is the padding the composer already draws under
  /// its visible box (`HubInlineComposer.bottomPadding`), so the box, not the
  /// padding, lines up. Identity never changes with the posture, so a draft
  /// survives a rotation. The keyboard still pushes the column up.
  func duoEdgeBarAlignedBottom(contentBottomPadding: CGFloat = 0) -> some View {
    modifier(DuoEdgeBarAlignedBottom(contentBottomPadding: contentBottomPadding))
  }
}

private struct DuoEdgeBarAlignedBottom: ViewModifier {
  let contentBottomPadding: CGFloat
  @Environment(\.duoLayout) private var duo

  func body(content: Content) -> some View {
    let active = duo.hasEdgeBar
    content
      .padding(.bottom, active ? max(0, DuoEdgeBar.bottomInset - contentBottomPadding) : 0)
      // Measured from the window's edge, not the home indicator's safe area.
      .ignoresSafeArea(.container, edges: active ? .bottom : [])
  }
}

private struct DuoHingeObserver: ViewModifier {
  @Binding var angle: Double?
  static let angleStep = 5.0

  func body(content: Content) -> some View {
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      content.onHingeChange { _, context in
        // Only once it has moved `angleStep`. The sensor reports every
        // fraction of a degree, and an open phone in the hand never holds
        // still: each new value changed `\.duoLayout` and re-rendered the
        // whole app (the unfolded Duo felt laggy, the folded one did not).
        // Nothing reads the angle finer (`bend` picks a family and shades
        // the fold).
        guard let raw = context.hinge?.angle.degrees else {
          if angle != nil { angle = nil }
          return
        }
        // On a `angleStep` grid, flat (180) included, so leaving flat moves
        // the angle as soon as the hinge passes the first step. Hysteresis
        // keeps a hinge held on a step's boundary from flipping between two.
        let next = (raw / Self.angleStep).rounded() * Self.angleStep
        if let angle, angle == next || abs(raw - angle) < Self.angleStep * 0.6 { return }
        angle = next
      }
    } else {
      content
    }
    #else
    content
    #endif
  }
}

/// The fold as seen by one pane, in that pane's own coordinates. Use it for a
/// pane that has to keep a control off the fold or draw along it.
struct DuoLocalFoldReader<Content: View>: View {
  /// The fold, the area's size, and whether the area is held landscape.
  /// Decide wide or tall from the flag, not from the size: the keyboard
  /// shortens the size, and an upright area is not landscape while it is up.
  @ViewBuilder var content: (DuoFold, CGSize, Bool) -> Content

  var body: some View {
    GeometryReader { proxy in
      content(DuoFoldReading.fold(in: proxy), proxy.size, proxy.isLandscapeIgnoringKeyboard)
    }
  }
}

// MARK: - Families and the seam

/// The three layout families every Duo-aware screen designs for. See
/// `.ade/cache/duo/briefs/DESIGN.md` §0.
enum DuoFamily: Equatable {
  /// The outer display and every other iPhone: today's phone layout.
  case compact
  /// The inner display held landscape (open wide, or book-folded).
  case wide
  /// The inner display held portrait (open tall, laptop, or tent).
  case tall
}

extension DuoLayout {
  /// The family for the area a caller lays out (not the screen), from
  /// whether that area is landscape (`isLandscapeIgnoringKeyboard`).
  func family(landscape: Bool) -> DuoFamily {
    guard isWide else { return .compact }
    return landscape ? .wide : .tall
  }
}

/// The boundary between two columns or two halves. Flat, it is a hairline;
/// folded, it is empty space exactly the fold's size, so the hinge itself is
/// the divider. A bend-scaled shadow gives the fold its depth. Never a control
/// surface.
struct DuoSeam: View {
  enum Axis {
    /// Between two side-by-side columns.
    case vertical
    /// Between a top half and a bottom half.
    case horizontal
  }

  let axis: Axis
  /// The fold this seam stands on, or nil when the screen is flat.
  var foldRect: CGRect?

  @Environment(\.duoLayout) private var duo

  var body: some View {
    Group {
      if let foldRect {
        let thickness = axis == .vertical ? foldRect.width : foldRect.height
        Color.clear
          .frame(
            width: axis == .vertical ? max(thickness, 1) : nil,
            height: axis == .horizontal ? max(thickness, 1) : nil
          )
          .overlay {
            // Only a hint of depth, in the middle third of the fold: the hinge
            // itself is the divider, and a wider or darker band reads as a slab.
            LinearGradient(
              stops: [
                .init(color: .black.opacity(0), location: 0.35),
                .init(color: .black.opacity(0.04 * duo.bend), location: 0.5),
                .init(color: .black.opacity(0), location: 0.65),
              ],
              startPoint: axis == .vertical ? .leading : .top,
              endPoint: axis == .vertical ? .trailing : .bottom
            )
          }
      } else if axis == .vertical {
        Divider()
      } else {
        Divider()
      }
    }
    .accessibilityHidden(true)
    .allowsHitTesting(false)
  }
}

// MARK: - Leading columns

extension View {
  /// For the content of a NavigationStack that is NOT the right-most column.
  /// Held landscape on the Duo, iOS gives every stack's content a trailing
  /// safe-area inset the width of the vertical edge bar, even a left column
  /// that never touches it, so a list stopped well short of its divider.
  /// (Turning the vertical bar off on that stack instead switches the whole
  /// window to a bottom bar.) Only call this inside a column that ends at a
  /// divider, never on the right-most column.
  func duoLeadingColumnContent() -> some View {
    ignoresSafeArea(.container, edges: .trailing)
  }
}

// MARK: - Inset-grouped detail lists

extension View {
  /// The sides an inset-grouped list in a detail column shares with the
  /// header above it, `side` on each side, and on the trailing side the
  /// window's trailing safe area on top: a list's own content margins
  /// replace the safe area, so held landscape on the Duo its rows ran under
  /// the edge bar. Apply it in place of `.contentMargins(.horizontal, …)`.
  func duoInsetGroupedMargins(_ side: CGFloat = 16) -> some View {
    modifier(DuoInsetGroupedMargins(side: side))
  }
}

private struct DuoInsetGroupedMargins: ViewModifier {
  let side: CGFloat
  @State private var insets = EdgeInsets()

  func body(content: Content) -> some View {
    content
      .contentMargins(.leading, side + insets.leading, for: .scrollContent)
      .contentMargins(.trailing, side + insets.trailing, for: .scrollContent)
      .onGeometryChange(for: EdgeInsets.self) { proxy in
        proxy.safeAreaInsets
      } action: { next in
        insets = next
      }
  }
}
