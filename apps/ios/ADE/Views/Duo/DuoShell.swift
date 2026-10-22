import SwiftUI

// The Duo's app shell: Apple's native sidebar in place of the phone's bottom
// tab bar on the inner display, and the one piece of shared state the panes
// set about it.
//
// ── The signal Track B (Work) sets ─────────────────────────────────────────
//
// `DuoShellChrome.sidebarPreferredHidden` asks the shell to fold the sidebar
// away so a surface that wants the whole inner display is not squeezed by it.
// Work sets it for a chat with its tools pane open; Files for two editor groups.
//
//     DuoShellChrome.shared.setSidebarPreferredHidden(true)   // tools pane open
//     DuoShellChrome.shared.setSidebarPreferredHidden(false)  // pane closed
//
// Set it when the pane opens, clear it when the pane closes, the chat is left,
// or the chat view disappears — a value left `true` keeps every tab in the
// compact presentation. The Files window is the only other writer, under the
// same contract, while it shows two editor groups.
//
// The shell only answers on the inner display (`duo.isWide`). The outer display
// and every other iPhone keep today's bottom bar, tab for tab, exactly as they
// were, and a stale `true` cannot change that: the placement modifier below is
// only applied on the inner display.

/// The shell state a pane can set: whether the sidebar should get out of the
/// way. See the note at the top of this file for the writer's contract.
@MainActor
final class DuoShellChrome: ObservableObject {
  /// The one instance the app and its panes share. `ContentView` also injects
  /// it as an environment object, so a pane can read it either way.
  static let shared = DuoShellChrome()

  /// True while a pane (a Work chat with its tools open) has asked for the
  /// whole inner display. Set it through `setSidebarPreferredHidden(_:)`, which
  /// is the documented path; it is writable directly as well.
  @Published var sidebarPreferredHidden = false

  func setSidebarPreferredHidden(_ hidden: Bool) {
    guard sidebarPreferredHidden != hidden else { return }
    sidebarPreferredHidden = hidden
  }
}

// MARK: - Root tab shell

/// The root tab view for every display.
///
/// Compact (outer display, any other iPhone): the tab view this app has always
/// drawn, bottom bar, the same tabs in the same order.
///
/// Inner display: the same tab view in Apple's adaptable sidebar, with the Hub,
/// Activity and Settings rows in the sidebar's footer, where the bottom bar
/// never had a place for them. The native toolbar toggle hides it; panes can ask
/// for it to fold away through `DuoShellChrome`.
///
/// The tab views themselves are passed in untouched, so selection, badges and
/// every tab's own navigation state are the ones the app already owns.
struct DuoAdaptableTabShell<SelectionValue: Hashable, Content: TabContent>: View
where Content.TabValue == SelectionValue {
  @Binding private var selection: SelectionValue
  @ObservedObject private var chrome = DuoShellChrome.shared
  @Environment(\.duoLayout) private var duo
  /// Held portrait (open tall, laptop, tent): 669pt is not enough for the
  /// sidebar and two columns, so the tabs start as the top glass bar there.
  @State private var isPortrait = false
  private let content: Content

  init(
    selection: Binding<SelectionValue>,
    @TabContentBuilder<SelectionValue> content: () -> Content
  ) {
    _selection = selection
    self.content = content()
  }

  var body: some View {
    // Two shells, not one shell with a swapped style: the compact branch has to
    // stay today's tab view exactly, and only the inner display adopts the
    // sidebar. Folding the device is the only thing that crosses the branch.
    if duo.isWide {
      innerDisplayShell
    } else {
      TabView(selection: $selection) {
        content
      }
    }
  }

  /// The same tab view in Apple's adaptable sidebar. Folding the sidebar away
  /// for a pane changes only the placement argument, so the tab that asked for
  /// the width keeps its identity and scroll position.
  private var innerDisplayShell: some View {
    TabView(selection: $selection) {
      content
    }
    .tabViewStyle(.sidebarAdaptable)
    .duoDefaultTabPlacement(chrome.sidebarPreferredHidden || isPortrait ? .tabBar : .sidebar)
    .onGeometryChange(for: Bool.self) { proxy in
      proxy.size.height >= proxy.size.width
    } action: { portrait in
      isPortrait = portrait
    }
    // When a pane has folded the sidebar away the shell falls back to the bar;
    // this keeps that bar out of the way on scroll, the same Liquid Glass
    // behaviour the bar has everywhere else on iOS 26.
    .tabBarMinimizeBehavior(.onScrollDown)
    .tabViewSidebarFooter {
      DuoSidebarFooter()
    }
  }
}

extension View {
  /// `.defaultTabBarPlacement` is iOS 27.1; below that the adaptable style still
  /// picks its own placement (bar in compact, sidebar in regular width).
  @ViewBuilder
  func duoDefaultTabPlacement(_ placement: AdaptableTabBarPlacement) -> some View {
    if #available(iOS 27.1, *) {
      defaultTabBarPlacement(placement)
    } else {
      self
    }
  }
}

// MARK: - Sidebar footer

/// The bottom of the sidebar: the three surfaces the bottom bar never had a row
/// for. Home returns to the all-projects Hub (the phone's only way back besides
/// a screen's own Back), Activity is the dashboard the bell opens, Settings is
/// the window the gear opens. Drawn at the tab rows' metrics so the sidebar
/// reads as one list.
struct DuoSidebarFooter: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Divider()
        .padding(.leading, 40)
        .padding(.bottom, 6)

      DuoSidebarFooterButton(title: "Home", systemImage: "square.grid.2x2") {
        syncService.showProjectHub()
      }

      DuoSidebarActivityButton(drawer: syncService.attentionDrawer) {
        syncService.attentionDrawerPresented = true
      }

      DuoSidebarFooterButton(title: "Settings", systemImage: "gearshape") {
        syncService.settingsPresented = true
      }
    }
    .padding(.bottom, 10)
  }
}

private struct DuoSidebarFooterButton: View {
  let title: String
  let systemImage: String
  var badge: Int = 0
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      DuoSidebarFooterRow(title: title, systemImage: systemImage, badge: badge)
    }
    .buttonStyle(DuoSidebarRowButtonStyle())
    .accessibilityLabel(badge > 0 ? "\(title), \(badge)" : title)
  }
}

private struct DuoSidebarActivityButton: View {
  @ObservedObject var drawer: ActivityDrawerModel
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      DuoSidebarFooterRow(title: "Activity", systemImage: "bell", badge: drawer.unreadCount)
    }
    .buttonStyle(DuoSidebarRowButtonStyle())
    .accessibilityLabel(
      drawer.unreadCount > 0
        ? "Activity, \(drawer.unreadCount) needing you"
        : "Activity"
    )
  }
}

/// A footer row with the sidebar tab rows' anatomy: tinted symbol, body text,
/// the count in the trailing secondary style the system badges use.
private struct DuoSidebarFooterRow: View {
  let title: String
  let systemImage: String
  var badge: Int = 0

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: systemImage)
        .font(.body)
        .foregroundStyle(.tint)
        .frame(width: 26, alignment: .center)

      Text(title)
        .font(.body)
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)

      Spacer(minLength: 4)

      if badge > 0 {
        Text(badge > 99 ? "99+" : "\(badge)")
          .font(.body.monospacedDigit())
          .foregroundStyle(.secondary)
      }
    }
    .frame(minHeight: 44)
    .contentShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
  }
}

/// The sidebar's pressed state: the same soft capsule the selected tab row
/// draws, briefly.
private struct DuoSidebarRowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(
        RoundedRectangle(cornerRadius: 22, style: .continuous)
          .fill(Color.primary.opacity(configuration.isPressed ? 0.08 : 0))
      )
  }
}

#if DEBUG
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
/// shipping view over in-process data), so the sidebar, its footer, the badges
/// and every tab's toolbar are what the device shows.
private struct DuoShellFixtureScreen: View {
  private enum FixtureTab: String, Hashable {
    case work, lanes, prs, files, cto
  }

  @State private var selection: FixtureTab = .files

  var body: some View {
    DuoAdaptableTabShell(selection: $selection) {
      Tab(value: FixtureTab.work) {
        DuoPreviewRouter.view(named: "duo-work")
      } label: {
        Label("Work", systemImage: "terminal")
      }
      .badge(2)

      Tab(value: FixtureTab.lanes) {
        DuoPreviewRouter.view(named: "duo-lanes")
      } label: {
        Label("Lanes", systemImage: "square.stack.3d.up")
      }

      Tab(value: FixtureTab.prs) {
        DuoPreviewRouter.view(named: "duo-prs")
      } label: {
        Label("PRs", systemImage: "arrow.triangle.pull")
      }

      Tab(value: FixtureTab.files) {
        DuoPreviewRouter.view(named: "duo-files")
      } label: {
        Label("Files", systemImage: "doc.text")
      }

      Tab(value: FixtureTab.cto) {
        DuoPreviewRouter.view(named: "duo-cto")
      } label: {
        Label("CTO", image: "CtoMark")
      }
      .badge(1)
      .accessibilityLabel("CTO, waiting on you")
    }
    .tint(ADEColor.accent)
    .adeScreenBackground()
  }
}
#endif

// MARK: - App tabs on the edge bar

/// One root destination the inner display's edge bar offers: a tab, or Home.
struct DuoAppTabItem: Identifiable, Equatable {
  let id: String
  let title: String
  /// An SF Symbol, or nil when `assetImage` names the glyph.
  var systemImage: String?
  var assetImage: String?
  var badge: Int = 0
}

/// The app's root destinations, for the bottom of the edge bar.
///
/// On the Duo's inner display there is no tab bar and no sidebar: every
/// screen's trailing column ends its toolbar with `DuoAppTabsToolbar`, so the
/// same tab buttons sit at the bottom of the curved edge on every screen
/// (DESIGN.md §2). `ContentView` owns the selection and keeps this in sync;
/// screens only read it.
@MainActor
final class DuoAppNavigation: ObservableObject {
  static let shared = DuoAppNavigation()

  @Published private(set) var items: [DuoAppTabItem] = []
  @Published private(set) var selectedId: String?
  private var onSelect: (String) -> Void = { _ in }

  func configure(items: [DuoAppTabItem], selectedId: String?, onSelect: @escaping (String) -> Void) {
    if self.items != items { self.items = items }
    if self.selectedId != selectedId { self.selectedId = selectedId }
    self.onSelect = onSelect
  }

  func select(_ id: String) {
    onSelect(id)
  }
}

/// The app tabs as the bottom group of a trailing column's toolbar. Held
/// landscape on the inner display that is the bottom of the vertical edge bar;
/// held portrait it is the bottom toolbar. Add it to the trailing column of
/// every inner-display screen, after the screen's own items.
struct DuoAppTabsToolbar: ToolbarContent {
  @ObservedObject var navigation = DuoAppNavigation.shared

  var body: some ToolbarContent {
    ToolbarItemGroup(placement: .bottomBar) {
      ForEach(navigation.items) { item in
        DuoAppTabButton(item: item, isSelected: navigation.selectedId == item.id) {
          navigation.select(item.id)
        }
      }
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
      Group {
        if let asset = item.assetImage {
          Label(item.title, image: asset)
        } else {
          Label(item.title, systemImage: item.systemImage ?? "circle")
        }
      }
      .symbolVariant(isSelected ? .fill : .none)
      .foregroundStyle(isSelected ? ADEColor.accent : Color.primary)
    }
    .badge(item.badge)
    .accessibilityLabel(item.badge > 0 ? "\(item.title), \(item.badge)" : item.title)
    .accessibilityAddTraits(isSelected ? .isSelected : [])
    .accessibilityIdentifier("Duo.AppTab.\(item.id)")
  }
}
