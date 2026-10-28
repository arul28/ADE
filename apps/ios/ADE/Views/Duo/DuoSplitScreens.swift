import SwiftUI

// MARK: - The split frame

/// What a split's detail column reads about the split around it, and asks of
/// it: the layout family, whether the list column is folded behind a toggle,
/// and whether the detail wants the whole width for now (a PR's Files tab).
@Observable
final class DuoSplitModel {
  /// The family of the whole split, not of the detail column alone.
  var family: DuoFamily = .wide
  /// The list is folded away and the detail's sidebar toggle brings it back
  /// as an overlay.
  var listCollapsible = false
  /// The folded list is showing beside the detail.
  var listShown = false
  /// The detail asked for every column the screen has.
  var detailWantsFullWidth = false

  func toggleList() {
    listShown.toggle()
  }

  func setDetailWantsFullWidth(_ wants: Bool) {
    guard detailWantsFullWidth != wants else { return }
    detailWantsFullWidth = wants
  }
}

extension EnvironmentValues {
  /// The split the view sits in, or nil outside one (the phone, a sheet).
  @Entry var duoSplit: DuoSplitModel? = nil
}

/// The detail column's sidebar toggle: shown only while the split can fold
/// its list away (held portrait, or a detail that took the width).
struct DuoSplitListToggle: ToolbarContent {
  let split: DuoSplitModel?
  @Environment(\.duoLayout) private var duo

  var body: some ToolbarContent {
    if let split, split.listCollapsible {
      ToolbarItem(placement: .topBarLeading) {
        // A phone has no sidebar: the list is the screen behind this one, so
        // the way to it is Back, as on Files.
        Button(
          duo.isWide ? (split.listShown ? "Hide list" : "Show list") : "Back",
          systemImage: duo.isWide ? "sidebar.left" : "chevron.backward"
        ) {
          withAnimation(.spring(response: 0.35, dampingFraction: 0.86)) { split.toggleList() }
        }
      }
    }
  }
}

/// The list-and-detail frame the Duo's inner display gives the Lanes, PRs and
/// Files tabs: a desktop-style list column on the left, the selected thing on
/// the right. The list keeps its width; the detail column takes the rest.
///
/// Book-folded, the column edge sits on the fold so each page keeps its own
/// pane, and the hinge is the only divider.
///
/// `adaptive` screens (PRs, Lanes) also follow the Duo's families: held
/// portrait the list folds behind the detail's sidebar toggle and comes back
/// beside it; a detail that needs both pages (`detailTakesBothPages`
/// book-folded, or a detail that asks through `DuoSplitModel`) folds it the
/// same way. The detail column keeps its identity through all of it, so its
/// state (the open tab, the scroll) survives a fold.
struct DuoSplitScaffold<ListColumn: View, DetailColumn: View>: View {
  /// The sidebar's width when the screen is not book-folded.
  var preferredListWidth: CGFloat = 320
  /// Below this the detail column stops being readable; the sidebar gives up
  /// the room first.
  var minimumDetailWidth: CGFloat = 360
  var adaptive = false
  /// Book-folded, the detail takes both pages (Lanes: dashboard | git).
  var detailTakesBothPages = false
  /// The selected row. Picking one closes the list's overlay.
  var selection: String? = nil
  /// Held landscape, ask the app shell to fold its sidebar away while this
  /// is true: list, detail and the edge bar need the whole display.
  var wantsWholeDisplay = false
  @ViewBuilder var list: (CGFloat) -> ListColumn
  @ViewBuilder var detail: () -> DetailColumn

  @Environment(\.duoLayout) private var duo
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var model = DuoSplitModel()

  private struct Arrangement: Equatable {
    var family: DuoFamily
    var collapsible: Bool
    var hidesShellSidebar: Bool
  }

  var body: some View {
    DuoLocalFoldReader { fold, size, landscape in
      let metrics = DuoSplitMetrics(
        fold: fold,
        size: size,
        preferredListWidth: preferredListWidth,
        minimumDetailWidth: minimumDetailWidth
      )
      let family = adaptive ? duo.family(landscape: landscape) : .wide
      let bookFolded: Bool = {
        if case .sideBySide = fold { return true }
        return false
      }()
      // A compact width (a phone, a narrow window) has room for one column:
      // the list folds behind the detail as it does held portrait.
      let collapsible = adaptive
        && (family != .wide || model.detailWantsFullWidth || (detailTakesBothPages && bookFolded))
      let arrangement = Arrangement(
        family: family,
        collapsible: collapsible,
        hidesShellSidebar: adaptive && wantsWholeDisplay && family == .wide
      )
      let foldedListWidth: CGFloat = {
        switch family {
        case .tall: return min(preferredListWidth, size.width * 0.45)
        case .compact: return size.width
        case .wide: return metrics.listWidth
        }
      }()

      HStack(spacing: 0) {
        // A folded list comes back beside the detail, pushing it over, the
        // way an iPad sidebar does held portrait. The detail stays in the
        // same slot either way, so it keeps its state.
        if !collapsible || model.listShown {
          let width = collapsible ? foldedListWidth : metrics.listWidth
          list(width)
            .frame(width: width)
            .frame(maxHeight: .infinity, alignment: .top)
            .transition(.move(edge: .leading))
          DuoSeam(
            axis: .vertical,
            foldRect: metrics.showsDividerRule ? nil : CGRect(x: 0, y: 0, width: metrics.gutterWidth, height: size.height)
          )
          // The columns scroll to the screen's bottom edge; the rule between
          // them runs there too instead of stopping at the home-indicator inset.
          .ignoresSafeArea(.container, edges: .bottom)
        }
        detail()
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .background(ADEColor.pageBackground)
      .onChange(of: arrangement, initial: true) { _, next in
        model.family = next.family
        if model.listCollapsible != next.collapsible {
          model.listCollapsible = next.collapsible
          // Held portrait with nothing open, the list is the screen.
          model.listShown = next.collapsible && next.family != .wide && selection == nil
        }
        if adaptive {
          DuoShellChrome.shared.setSidebarPreferredHidden(next.hidesShellSidebar)
        }
      }
    }
    .environment(\.duoSplit, model)
    .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86), value: model.listShown)
    .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86), value: model.detailWantsFullWidth)
    .onChange(of: selection) { _, _ in hideList() }
    .onDisappear {
      if adaptive { DuoShellChrome.shared.setSidebarPreferredHidden(false) }
    }
  }

  private func hideList() {
    guard model.listShown else { return }
    model.listShown = false
  }
}

/// How wide each column is for one fold. A book fold hands the left page to
/// the sidebar and starts the detail at the hinge; every other posture keeps a
/// normal sidebar width.
struct DuoSplitMetrics: Equatable {
  var listWidth: CGFloat
  /// The space between the columns: the hinge's own width when book-folded, so
  /// nothing is drawn across it.
  var gutterWidth: CGFloat
  /// A hairline between two columns that share one continuous screen. Book-
  /// folded, the hinge is the divider and no line is drawn.
  var showsDividerRule: Bool

  init(
    fold: DuoFold,
    size: CGSize,
    preferredListWidth: CGFloat = 320,
    minimumDetailWidth: CGFloat = 360
  ) {
    let available = max(0, size.width)
    var width = preferredListWidth
    var gutter: CGFloat = 1
    var showsRule = true
    var detailFloor = minimumDetailWidth
    if case .sideBySide(let rect) = fold, rect.minX > 0 {
      width = rect.minX
      gutter = min(max(rect.width, 1), 48)
      showsRule = false
      // Book-folded the hinge decides: the list is the whole left page and
      // the detail the right one, even when that page is narrower than the
      // detail would like (a detail across the hinge is worse).
      detailFloor = min(minimumDetailWidth, 240)
    }
    // A folded page is the sidebar, but never squeeze the detail below
    // something readable and never let the sidebar take the whole screen.
    let ceiling = max(200, available - detailFloor - gutter)
    let floor: CGFloat = 220
    width = min(max(width, floor), ceiling)
    self.listWidth = min(max(width, 0), available)
    self.gutterWidth = min(gutter, available)
    self.showsDividerRule = showsRule
  }
}

/// What a detail column says before anything is selected. Calm on purpose: it
/// is a resting place, not an error. Its own stack, so the trailing column
/// still carries the edge bar and its app tabs.
struct DuoSplitPlaceholder: View {
  let symbol: String
  let title: String
  let message: String
  /// Activity and Settings with the tabs; a screen whose list column's ⋯
  /// carries them leaves them off the rail.
  var includesUtilities = true

  var body: some View {
    NavigationStack {
      ContentUnavailableView {
        Label(title, systemImage: symbol)
      } description: {
        Text(message)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .background(ADEColor.pageBackground)
      .toolbar { DuoAppTabsToolbar(includesUtilities: includesUtilities) }
    }
  }
}
