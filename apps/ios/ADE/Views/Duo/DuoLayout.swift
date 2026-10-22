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
          hingeAngle: hingeAngle
        ))
    }
    .modifier(DuoHingeObserver(angle: $hingeAngle))
  }
}

/// Reads the active fold from a geometry proxy. Shared by the root and by
/// panes that need the fold in their own coordinate space.
enum DuoFoldReading {
  static func fold(in proxy: GeometryProxy) -> DuoFold {
    guard #available(iOS 27.1, *) else { return .none }
    let regions = proxy.reservedRegions(kind: .division)
    guard let region = regions.first(where: { $0.isActive }) else { return .none }
    let frame = region.frame
    return frame.width >= frame.height ? .stacked(frame) : .sideBySide(frame)
  }
}

private struct DuoHingeObserver: ViewModifier {
  @Binding var angle: Double?

  func body(content: Content) -> some View {
    if #available(iOS 27.1, *) {
      content.onHingeChange { _, context in
        angle = context.hinge?.angle.degrees
      }
    } else {
      content
    }
  }
}

/// The fold as seen by one pane, in that pane's own coordinates. Use it for a
/// pane that has to keep a control off the fold or draw along it.
struct DuoLocalFoldReader<Content: View>: View {
  @ViewBuilder var content: (DuoFold, CGSize) -> Content

  var body: some View {
    GeometryReader { proxy in
      content(DuoFoldReading.fold(in: proxy), proxy.size)
    }
  }
}
