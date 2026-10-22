import SwiftUI

// The Duo's app shell: Apple's native sidebar in place of the phone's bottom
// tab bar on the inner display, and the one piece of shared state the panes
// set about it.
//
// ── The signal Track B (Work) sets ─────────────────────────────────────────
//
// `DuoShellChrome.sidebarPreferredHidden` asks the shell to fold the sidebar
// away so a surface that wants the whole inner display is not squeezed by it.
// Work owns the only reason to set it: a chat with its tools pane open.
//
//     DuoShellChrome.shared.setSidebarPreferredHidden(true)   // tools pane open
//     DuoShellChrome.shared.setSidebarPreferredHidden(false)  // pane closed
//
// Set it when the pane opens, clear it when the pane closes, the chat is left,
// or the chat view disappears — a value left `true` keeps every tab in the
// compact presentation. Nothing else writes it.
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
    .duoDefaultTabPlacement(chrome.sidebarPreferredHidden ? .tabBar : .sidebar)
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
/// the sheet the gear opens.
struct DuoSidebarFooter: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Rectangle()
        .fill(ADEKit.rule)
        .frame(height: 0.75)
        .padding(.horizontal, 8)
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
    .padding(.horizontal, 10)
    .padding(.bottom, 10)
  }
}

private struct DuoSidebarFooterButton: View {
  let title: String
  let systemImage: String
  var badge: String?
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      DuoSidebarFooterRow(title: title, systemImage: systemImage, badge: badge)
    }
    .buttonStyle(ADEKitRowButtonStyle())
    .accessibilityLabel(accessibilityText)
  }

  private var accessibilityText: String {
    guard let badge else { return title }
    return "\(title), \(badge)"
  }
}

private struct DuoSidebarActivityButton: View {
  @ObservedObject var drawer: ActivityDrawerModel
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      DuoSidebarFooterRow(title: "Activity", systemImage: "bell", badge: drawer.badgeLabel)
    }
    .buttonStyle(ADEKitRowButtonStyle())
    .accessibilityLabel(
      drawer.unreadCount > 0
        ? "Activity, \(drawer.unreadCount) needing you"
        : "Activity"
    )
  }
}

private struct DuoSidebarFooterRow: View {
  let title: String
  let systemImage: String
  var badge: String?

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: systemImage)
        .font(.system(size: 13, weight: .medium))
        .foregroundStyle(ADEColor.textSecondary)
        .frame(width: 20, alignment: .center)

      Text(title)
        .font(.system(size: 14, weight: .medium))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)

      Spacer(minLength: 4)

      if let badge {
        Text(badge)
          .font(.system(size: 10, weight: .bold).monospacedDigit())
          .foregroundStyle(ADEColor.pageBackground)
          .padding(.horizontal, 5)
          .frame(minWidth: 16, minHeight: 16)
          .background(ADEColor.warning, in: Capsule())
      }
    }
    .padding(.horizontal, 8)
    .frame(height: 34)
    .contentShape(Rectangle())
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

/// The five root tabs, mirrored for the fixture only. The shipping shell reads
/// the same five from `ContentView`'s own tab builders.
private enum DuoShellFixtureTab: String, Hashable, Identifiable {
  case work, lanes, prs, files, cto

  var id: Self { self }

  var title: String {
    switch self {
    case .work: return "Work"
    case .lanes: return "Lanes"
    case .prs: return "PRs"
    case .files: return "Files"
    case .cto: return "CTO"
    }
  }

  var symbol: String {
    switch self {
    case .work: return "terminal"
    case .lanes: return "square.stack.3d.up"
    case .prs: return "arrow.triangle.pull"
    case .files: return "doc.text"
    case .cto: return "brain"
    }
  }

  var blurb: String {
    switch self {
    case .work: return "Every chat, CLI and shell on every connected machine."
    case .lanes: return "Lanes across your machines, with their branches and pull requests."
    case .prs: return "Open pull requests, checks and review threads."
    case .files: return "The workspace on the machine that owns the lane."
    case .cto: return "The project's chief-of-staff chat."
    }
  }
}

/// The real shell with fixture panes, launched with
/// `-adePreviewScreen duo-shell`. The tab views are stand-ins (Work, Lanes, PRs
/// and Files need a live brain), but the shell around them is the shipping one:
/// the same `DuoAdaptableTabShell`, sidebar footer and badges. Open it on the
/// inner display to see the sidebar; in compact it is today's bottom bar.
private struct DuoShellFixtureScreen: View {
  @State private var selection: DuoShellFixtureTab = .work

  var body: some View {
    DuoAdaptableTabShell(selection: $selection) {
      Tab(value: DuoShellFixtureTab.work) {
        DuoShellFixturePane(tab: .work)
      } label: {
        Label("Work", systemImage: "terminal")
      }
      .badge(3)

      Tab(value: DuoShellFixtureTab.lanes) {
        DuoShellFixturePane(tab: .lanes)
      } label: {
        Label("Lanes", systemImage: "square.stack.3d.up")
      }

      Tab(value: DuoShellFixtureTab.prs) {
        DuoShellFixturePane(tab: .prs)
      } label: {
        Label("PRs", systemImage: "arrow.triangle.pull")
      }

      Tab(value: DuoShellFixtureTab.files) {
        DuoShellFixturePane(tab: .files)
      } label: {
        Label("Files", systemImage: "doc.text")
      }

      Tab(value: DuoShellFixtureTab.cto) {
        DuoShellFixturePane(tab: .cto)
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

/// One fixture pane: a native navigation bar over the rows a real tab would
/// list, drawn as quiet placeholders so the shell is what the screen shows.
private struct DuoShellFixturePane: View {
  let tab: DuoShellFixtureTab

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          VStack(alignment: .leading, spacing: 6) {
            Text(tab.title)
              .font(.system(size: 28, weight: .bold))
              .foregroundStyle(ADEColor.textPrimary)
            Text(tab.blurb)
              .font(.system(size: 14))
              .foregroundStyle(ADEColor.textSecondary)
              .fixedSize(horizontal: false, vertical: true)
          }

          VStack(spacing: 10) {
            ForEach(0..<4, id: \.self) { index in
              ADESkeletonView(height: index == 0 ? 58 : 46, cornerRadius: ADEKit.radius)
            }
          }
        }
        .padding(20)
        .frame(maxWidth: 640, alignment: .leading)
        .frame(maxWidth: .infinity)
      }
      .scrollIndicators(.hidden)
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationTitle(tab.title)
      .navigationBarTitleDisplayMode(.inline)
    }
  }
}
#endif
