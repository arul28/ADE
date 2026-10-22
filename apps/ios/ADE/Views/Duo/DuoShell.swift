import SwiftUI

// The Duo's app shell.
//
// Compact (the outer display, every other iPhone): the bottom tab bar this app
// has always drawn, tab for tab.
//
// Inner display: no tab bar and no sidebar. The root destinations (Home, the
// five tabs, then Activity and Settings) are toolbar items every screen adds
// to its trailing column with `DuoAppTabsToolbar()`:
//
//   - held landscape, iOS turns that column's toolbar into the vertical bar on
//     the curved right edge, and the tabs are its bottom group;
//   - held portrait, nothing may sit under the content as a bar, so the tabs
//     are one top-bar menu named for the current tab.
//
// `ContentView` owns the selection and configures `DuoAppNavigation`; screens
// only add the toolbar content.

/// Kept for the panes that still write it (a Work chat with its tools open,
/// Files with two editor groups). The inner display has no sidebar any more,
/// so nothing reads it; the writers' contract is unchanged and harmless.
@MainActor
final class DuoShellChrome: ObservableObject {
  static let shared = DuoShellChrome()

  @Published var sidebarPreferredHidden = false

  func setSidebarPreferredHidden(_ hidden: Bool) {
    guard sidebarPreferredHidden != hidden else { return }
    sidebarPreferredHidden = hidden
  }
}

// MARK: - Root tab shell

/// The root tab view for every display. The tab views are passed in untouched,
/// so selection, badges and every tab's own navigation state stay the app's.
///
/// Compact keeps today's tab view exactly. On the inner display it is the same
/// tab view, kept for what it does well (every visited tab stays mounted with
/// its state), with its bar hidden: each tab's content applies
/// `.duoHidesTabBar(_:)`, and the edge bar is how the user moves between tabs.
struct DuoAdaptableTabShell<SelectionValue: Hashable, Content: TabContent>: View
where Content.TabValue == SelectionValue {
  @Binding private var selection: SelectionValue
  private let content: Content

  init(
    selection: Binding<SelectionValue>,
    @TabContentBuilder<SelectionValue> content: () -> Content
  ) {
    _selection = selection
    self.content = content()
  }

  var body: some View {
    TabView(selection: $selection) {
      content
    }
  }
}

extension View {
  /// Hides the root tab bar on the Duo's inner display, where the edge bar
  /// carries the tabs. Apply to each root tab's content; a tab bar's
  /// visibility is set from inside the tab, never on the tab view itself.
  func duoHidesTabBar(_ hidden: Bool) -> some View {
    toolbar(hidden ? .hidden : .automatic, for: .tabBar)
  }

  /// Publishes the window's layout family to `DuoAppNavigation`, which is how
  /// `DuoAppTabsToolbar` knows whether it is an edge-bar group, a top-bar menu,
  /// or nothing (compact). Apply once, below `.duoLayoutRoot()`.
  func duoAppNavigationRoot() -> some View {
    modifier(DuoAppNavigationRootModifier())
  }
}

private struct DuoAppNavigationRootModifier: ViewModifier {
  @Environment(\.duoLayout) private var duo
  @State private var size: CGSize = .zero

  func body(content: Content) -> some View {
    content
      .onGeometryChange(for: CGSize.self) { proxy in
        proxy.size
      } action: { newSize in
        size = newSize
        publish()
      }
      .onChange(of: duo.isWide, initial: true) { _, _ in
        publish()
      }
  }

  private func publish() {
    DuoAppNavigation.shared.setFamily(duo.family(for: size))
  }
}

// MARK: - App tabs

/// One root destination the inner display offers: Home, a tab, or one of the
/// two windows the phone opens from its top bar (Activity, Settings).
struct DuoAppTabItem: Identifiable, Equatable {
  enum Role: Equatable {
    /// Back to the all-projects Hub.
    case home
    /// One of the five root tabs.
    case tab
    /// Activity or Settings: opens a window over the current screen, so it is
    /// never the selection, and it is the first to give way when the edge bar
    /// runs out of room.
    case utility
  }

  let id: String
  let title: String
  /// An SF Symbol, or nil when `assetImage` names the glyph.
  var systemImage: String?
  var assetImage: String?
  var badge: Int = 0
  var role: Role = .tab
  /// False while there is nothing to open: the tabs need an open project.
  var isEnabled = true
  /// Spoken and shown with the badge ("2 need you").
  var badgeNoun: String?

  /// The selected glyph's variant. Filled only where the fill still reads as a
  /// glyph (the house); a filled terminal or document is a solid block, so
  /// those mark selection with the tint alone.
  var selectedSymbolVariant: SymbolVariants {
    systemImage == "house" ? .fill : .none
  }
}

/// The app's root destinations, for the edge bar.
///
/// `ContentView` owns the selection and keeps this in sync; screens only add
/// `DuoAppTabsToolbar()`.
@MainActor
final class DuoAppNavigation: ObservableObject {
  static let shared = DuoAppNavigation()

  @Published private(set) var items: [DuoAppTabItem] = []
  @Published private(set) var selectedId: String?
  /// The window's family, published by `.duoAppNavigationRoot()`.
  @Published private(set) var family: DuoFamily = .compact
  private var onSelect: (String) -> Void = { _ in }

  func configure(items: [DuoAppTabItem], selectedId: String?, onSelect: @escaping (String) -> Void) {
    if self.items != items { self.items = items }
    if self.selectedId != selectedId { self.selectedId = selectedId }
    self.onSelect = onSelect
  }

  func setFamily(_ family: DuoFamily) {
    guard self.family != family else { return }
    self.family = family
  }

  func select(_ id: String) {
    onSelect(id)
  }

  /// Home and the tabs: the items that can be the selection.
  var destinations: [DuoAppTabItem] {
    items.filter { $0.role != .utility }
  }

  var utilities: [DuoAppTabItem] {
    items.filter { $0.role == .utility }
  }

  var selectedItem: DuoAppTabItem? {
    items.first { $0.id == selectedId }
  }
}

/// The app tabs, for the toolbar of every inner-display screen's trailing
/// column. Add it after the screen's own items; it picks its form from the
/// window's family:
///
/// - wide (held landscape): one item per destination at the bottom of the
///   vertical edge bar, Activity and Settings last at low priority so they are
///   the first to overflow;
/// - tall (held portrait): one menu on the leading side of the top bar,
///   labelled with the current tab's symbol and badged with what waits
///   elsewhere — never a bar under content;
/// - compact: nothing (the phone's tab bar is still there).
///
/// `includesUtilities: false` leaves Activity and Settings out, for a screen
/// whose own items already carry them (Home).
struct DuoAppTabsToolbar: ToolbarContent {
  @ObservedObject var navigation = DuoAppNavigation.shared
  var includesUtilities = true

  var body: some ToolbarContent {
    if navigation.family == .wide {
      DuoAppDestinationsToolbarGroup(navigation: navigation)
      if includesUtilities {
        ToolbarSpacer(.fixed, placement: .bottomBar)
        DuoAppUtilitiesToolbarGroup(navigation: navigation)
      }
    } else if navigation.family == .tall {
      DuoAppTabsMenuItem(navigation: navigation, includesUtilities: includesUtilities)
    }
  }
}

/// The tall form's one item. It is how the user leaves the screen, so it is the
/// last thing the bar gives up when it runs out of room.
private struct DuoAppTabsMenuItem: ToolbarContent {
  @ObservedObject var navigation: DuoAppNavigation
  let includesUtilities: Bool

  var body: some ToolbarContent {
    // On the leading side, where navigation lives: a screen's trailing items
    // (its pinned action, its overflow menu) always sort last on the trailing
    // side, so there they would share this item's capsule. The spacer keeps it
    // apart from a leading sidebar toggle or title.
    if #available(iOS 27.0, *) {
      item.visibilityPriority(.high)
    } else {
      item
    }
    ToolbarSpacer(.fixed, placement: .topBarLeading)
  }

  private var item: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      DuoAppTabsMenu(navigation: navigation, includesUtilities: includesUtilities)
    }
  }
}

/// Home and the five tabs at the bottom of the edge bar. They are how the user
/// leaves the screen, so a screen's own actions give way to the overflow menu
/// before any of them does.
private struct DuoAppDestinationsToolbarGroup: ToolbarContent {
  @ObservedObject var navigation: DuoAppNavigation

  var body: some ToolbarContent {
    if #available(iOS 27.0, *) {
      group.visibilityPriority(.high)
    } else {
      group
    }
  }

  private var group: some ToolbarContent {
    ToolbarItemGroup(placement: .bottomBar) {
      ForEach(navigation.destinations) { item in
        DuoAppTabButton(item: item, isSelected: navigation.selectedId == item.id) {
          navigation.select(item.id)
        }
      }
    }
  }
}

/// Activity and Settings at the very bottom of the edge bar, in their own
/// group so they read apart from the destinations and give way first.
private struct DuoAppUtilitiesToolbarGroup: ToolbarContent {
  @ObservedObject var navigation: DuoAppNavigation

  var body: some ToolbarContent {
    if #available(iOS 27.0, *) {
      group.visibilityPriority(.low)
    } else {
      group
    }
  }

  private var group: some ToolbarContent {
    ToolbarItemGroup(placement: .bottomBar) {
      ForEach(navigation.utilities) { item in
        DuoAppTabButton(item: item, isSelected: false) {
          navigation.select(item.id)
        }
      }
    }
  }
}

private struct DuoAppTabGlyph: View {
  let item: DuoAppTabItem

  var body: some View {
    if let asset = item.assetImage {
      Label(item.title, image: asset)
    } else {
      Label(item.title, systemImage: item.systemImage ?? "circle")
    }
  }
}

private struct DuoAppTabButton: View {
  let item: DuoAppTabItem
  let isSelected: Bool
  let action: () -> Void

  var body: some View {
    Button(action: {
      ADEHaptics.light()
      action()
    }) {
      DuoAppTabGlyph(item: item)
        .symbolVariant(isSelected ? item.selectedSymbolVariant : .none)
        .foregroundStyle(isSelected ? ADEColor.accent : Color.primary)
    }
    // A toolbar item draws its glyph in its tint: the selected destination in
    // the accent, the way a tab bar marks the current tab.
    .tint(isSelected ? ADEColor.accent : Color.primary)
    .badge(item.badge)
    .disabled(!item.isEnabled)
    .accessibilityLabel(duoAppTabSpokenLabel(item))
    .accessibilityAddTraits(isSelected ? .isSelected : [])
    .accessibilityIdentifier("Duo.AppTab.\(item.id)")
  }
}

/// The tall form: one menu, labelled with where you are, listing every
/// destination with its count, then Activity and Settings.
private struct DuoAppTabsMenu: View {
  @ObservedObject var navigation: DuoAppNavigation
  let includesUtilities: Bool

  /// What waits on another destination: the badge on the menu's label, so a
  /// question on Work still shows while you read Files. Activity's count is
  /// its own bell's, wherever the screen shows one, so it is not added here.
  private var elsewhereCount: Int {
    navigation.destinations
      .filter { $0.id != navigation.selectedId }
      .reduce(0) { $0 + $1.badge }
  }

  var body: some View {
    Menu {
      Section {
        ForEach(navigation.destinations) { item in
          menuButton(item, isSelected: item.id == navigation.selectedId)
        }
      }
      if includesUtilities {
        Section {
          ForEach(navigation.utilities) { item in
            menuButton(item, isSelected: false)
          }
        }
      }
    } label: {
      if let current = navigation.selectedItem {
        DuoAppTabGlyph(item: current)
          .symbolVariant(current.selectedSymbolVariant)
      } else {
        Label("Go to", systemImage: "square.grid.2x2")
      }
    }
    .badge(elsewhereCount)
    .accessibilityLabel(menuSpokenLabel)
    .accessibilityIdentifier("Duo.AppTabsMenu")
  }

  private var menuSpokenLabel: String {
    let current = navigation.selectedItem?.title ?? "Go to"
    return elsewhereCount > 0 ? "\(current), \(elsewhereCount) waiting elsewhere" : current
  }

  private func menuButton(_ item: DuoAppTabItem, isSelected: Bool) -> some View {
    Button {
      ADEHaptics.light()
      navigation.select(item.id)
    } label: {
      if isSelected {
        Label(item.title, systemImage: "checkmark")
      } else {
        DuoAppTabGlyph(item: item)
      }
      if item.badge > 0 {
        Text(duoAppTabBadgeText(item))
      }
    }
    .disabled(!item.isEnabled)
    .accessibilityLabel(duoAppTabSpokenLabel(item))
  }
}

private func duoAppTabBadgeText(_ item: DuoAppTabItem) -> String {
  let count = item.badge > 99 ? "99+" : "\(item.badge)"
  guard let noun = item.badgeNoun else { return count }
  return "\(count) \(noun)"
}

private func duoAppTabSpokenLabel(_ item: DuoAppTabItem) -> String {
  item.badge > 0 ? "\(item.title), \(duoAppTabBadgeText(item))" : item.title
}

#if DEBUG
// MARK: - Fixtures

extension DuoAppNavigation {
  /// The items the real root configures, with fixture badges, so a fixture
  /// screen's edge bar shows the same tabs the app does. Selecting only moves
  /// the selection mark.
  func configureForFixture(selectedId: String) {
    let items = [
      DuoAppTabItem(id: "home", title: "Home", systemImage: "house", role: .home),
      DuoAppTabItem(id: "work", title: "Work", systemImage: "terminal", badge: 3, badgeNoun: "need you"),
      DuoAppTabItem(id: "lanes", title: "Lanes", systemImage: "square.stack.3d.up"),
      DuoAppTabItem(id: "prs", title: "PRs", systemImage: "arrow.triangle.pull"),
      DuoAppTabItem(id: "files", title: "Files", systemImage: "doc.text"),
      DuoAppTabItem(id: "cto", title: "CTO", assetImage: "CtoMark", badge: 1, badgeNoun: "waiting"),
      DuoAppTabItem(id: "activity", title: "Activity", systemImage: "bell", badge: 4, role: .utility, badgeNoun: "new"),
      DuoAppTabItem(id: "settings", title: "Settings", systemImage: "gearshape", role: .utility),
    ]
    configure(items: items, selectedId: selectedId) { [weak self] id in
      guard let self, let item = self.items.first(where: { $0.id == id }), item.role != .utility else { return }
      self.configure(items: self.items, selectedId: id, onSelect: self.onSelect)
    }
  }

  /// The destination a fixture name shows: `duo-lanes-…` is Lanes.
  static func fixtureSelection(for name: String) -> String {
    for id in ["work", "lanes", "prs", "files", "cto"] where name.hasPrefix("duo-\(id)") {
      return id
    }
    if name.hasPrefix("duo-pr") { return "prs" }
    if name.hasPrefix("duo-lane") { return "lanes" }
    return "home"
  }
}

/// Fixture screens for this area, routed by `DuoPreviewRouter`.
enum DuoShellPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-shell": return AnyView(DuoShellFixtureScreen())
    default: return nil
    }
  }
}

/// The real shell around the real tab screens, launched with
/// `-adePreviewScreen duo-shell`. Each tab hosts that area's own fixture (the
/// shipping view over in-process data); the edge bar's tabs switch between
/// them through `DuoAppNavigation`, the way `ContentView` wires it.
private struct DuoShellFixtureScreen: View {
  @Environment(\.duoLayout) private var duo
  @State private var selection = "files"

  var body: some View {
    DuoAdaptableTabShell(selection: $selection) {
      tab("work", "Work", "terminal")
      tab("lanes", "Lanes", "square.stack.3d.up")
      tab("prs", "PRs", "arrow.triangle.pull")
      tab("files", "Files", "doc.text")
      Tab(value: "cto") {
        DuoPreviewRouter.view(named: "duo-cto").duoHidesTabBar(duo.isWide)
      } label: {
        Label("CTO", image: "CtoMark")
      }
    }
    .tint(ADEColor.accent)
    .adeScreenBackground()
    .onAppear { configure() }
    .onChange(of: selection) { _, _ in configure() }
  }

  private func tab(_ id: String, _ title: String, _ symbol: String) -> some TabContent<String> {
    Tab(value: id) {
      DuoPreviewRouter.view(named: "duo-\(id)").duoHidesTabBar(duo.isWide)
    } label: {
      Label(title, systemImage: symbol)
    }
  }

  private func configure() {
    let navigation = DuoAppNavigation.shared
    navigation.configureForFixture(selectedId: selection)
    navigation.configure(items: navigation.items, selectedId: selection) { id in
      guard id != "home", id != "activity", id != "settings" else { return }
      selection = id
    }
  }
}
#endif
