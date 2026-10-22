import SwiftUI

// The Work tools pane (desktop-style tool tabs beside a chat). See DuoWorkSplit.swift.

/// One surface the Work tools pane can show for a chat.
///
/// The four lane tools mirror the composer chips exactly; the rest are the
/// surfaces the chat's own overflow menu and lane chrome already own, shown
/// beside the thread instead of over it. Agents, Proof and Info are desktop's
/// chat actions drawer, split into the tabs that drawer has. A tab exists only
/// while its surface exists (see `DuoWorkPaneModel.availableTabs`), the same
/// availability the chips and menu items use.
///
/// Declaration order is the order the tabs appear in the toolbar.
enum DuoToolTab: String, CaseIterable, Identifiable, Hashable {
  case simulator
  case macDesktop
  case appControl
  case browser
  case git
  case pr
  case issues
  case files
  case proof
  case agents
  case chatInfo

  var id: String { rawValue }

  var title: String {
    switch self {
    case .simulator: return "Simulator"
    case .macDesktop: return "Desktop"
    case .appControl: return "App Control"
    case .browser: return "Browser"
    case .git: return "Git"
    case .pr: return "Pull Request"
    case .issues: return "Issues"
    case .files: return "Files"
    case .proof: return "Proof"
    case .agents: return "Agents"
    case .chatInfo: return "Info"
    }
  }

  var symbolName: String {
    switch self {
    case .simulator: return "iphone"
    case .macDesktop: return "desktopcomputer"
    case .appControl: return "macwindow"
    case .browser: return "globe"
    case .git: return "arrow.triangle.branch"
    case .pr: return "arrow.triangle.pull"
    case .issues: return "checklist"
    case .files: return "folder"
    case .proof: return "photo.on.rectangle.angled"
    case .agents: return "person.2"
    case .chatInfo: return "info.circle"
    }
  }

  /// A live picture of another machine's screen. These draw on a dark stage
  /// and are the only tabs that hold a video stream.
  var isLiveViewer: Bool {
    switch self {
    case .simulator, .macDesktop, .appControl: return true
    default: return false
    }
  }

  /// The tabs desktop's chat actions drawer holds.
  var isChatAction: Bool {
    switch self {
    case .agents, .proof, .chatInfo: return true
    default: return false
    }
  }
}

extension WorkToolChip {
  /// The pane tab this chip opens on a wide display.
  var duoToolTab: DuoToolTab {
    switch kind {
    case .simulator: return .simulator
    case .macDesktop: return .macDesktop
    case .browser: return .browser
    case .appControl: return .appControl
    }
  }
}

/// The lane state a tool tab was opened with, so its viewer has a first frame
/// instead of an empty one. Captured from the chips' own poll: the lane tools
/// model is the only poller, and a viewer opened from the pane continues from
/// here.
struct DuoToolSeed: Equatable {
  var appleStatus: AppleDeviceStatus?
  var macDesktop: WorkToolsMacDesktopState?
  var appControl: WorkToolsAppControlState?
  var appControlStream = false
  var macDesktopStream = false
}

/// Which tool the Work tab's tool column is showing, and whether it is up.
///
/// One model per Work root, shared by the sessions column (it collapses fully
/// while this is open, like the desktop sidebar), the chat (its chips, header
/// and menu open tabs here), and the destination (it lays the pane out beside
/// the thread).
@MainActor
final class DuoWorkPaneModel: ObservableObject {
  @Published private(set) var isOpen = false
  @Published private(set) var tab: DuoToolTab?
  /// The tabs the chat's chips can show, published by the chat's own poll.
  @Published private(set) var toolTabs: [DuoToolTab] = []
  /// The tabs the destination can show (PR, Git, Files, Issues, chat actions).
  @Published private(set) var surfaceTabs: [DuoToolTab] = []
  @Published private(set) var availableTabs: [DuoToolTab] = []
  @Published private(set) var seed = DuoToolSeed()
  /// The last state the chips reported, so a tab opened from the header's
  /// Tools button starts where a chip tap would have. Not published: it only
  /// seeds the next open.
  private var chipSeed = DuoToolSeed()
  /// The tab the pane last showed, for the header's Tools toggle.
  private var lastTab: DuoToolTab?

  /// Opens a tab. The pane appears if it was closed, and switches if it was not.
  func open(_ tab: DuoToolTab, seed: DuoToolSeed? = nil) {
    let next = seed ?? (tab.isLiveViewer || tab == .browser ? chipSeed : DuoToolSeed())
    if self.seed != next { self.seed = next }
    if self.tab != tab { self.tab = tab }
    lastTab = tab
    if !isOpen { isOpen = true }
    refreshAvailableTabs()
  }

  /// Opens the tab a lane tool chip stands for. `tools` is the chat's chip poll,
  /// so the viewer starts from the state the chip was already showing.
  func open(
    chip: WorkToolChip,
    tools: WorkLaneToolsModel,
    macDesktopStream: Bool
  ) {
    open(chip.duoToolTab, seed: DuoToolSeed(
      appleStatus: tools.appleStatus,
      macDesktop: tools.macDesktopState,
      appControl: tools.appControlState,
      appControlStream: tools.appControlStream,
      macDesktopStream: macDesktopStream
    ))
  }

  func select(_ tab: DuoToolTab) {
    guard availableTabs.contains(tab) else { return }
    open(tab)
  }

  /// The chat header's Tools button: closes the pane, or brings back the tab
  /// it last showed (a live tool first, when one is running).
  func toggle() {
    if isOpen {
      close()
      return
    }
    if let lastTab, availableTabs.contains(lastTab) {
      open(lastTab)
    } else if let first = toolTabs.first ?? availableTabs.first {
      open(first)
    }
  }

  func close() {
    if isOpen { isOpen = false }
    if tab != nil { tab = nil }
    if seed != DuoToolSeed() { seed = DuoToolSeed() }
  }

  /// The chat reports what its chips currently offer, and the state they were
  /// drawn from. Chip badges do not live here — only the tab identities, so a
  /// 10 s poll that changes nothing about availability cannot re-render the
  /// pane.
  func setToolTabs(_ tabs: [DuoToolTab], seed: DuoToolSeed) {
    chipSeed = seed
    guard toolTabs != tabs else { return }
    toolTabs = tabs
    refreshAvailableTabs()
  }

  /// The destination reports what its own surfaces currently offer.
  func setSurfaceTabs(_ tabs: [DuoToolTab]) {
    guard surfaceTabs != tabs else { return }
    surfaceTabs = tabs
    refreshAvailableTabs()
  }

  private func refreshAvailableTabs() {
    var offered = Set(toolTabs)
    offered.formUnion(surfaceTabs)
    // A tab the user just opened stays reachable for this presentation even if
    // the surface behind it goes away on the next poll.
    if let tab { offered.insert(tab) }
    let next = DuoToolTab.allCases.filter(offered.contains)
    if next != availableTabs { availableTabs = next }
  }
}

/// The tool column: one tool filling the column, with its controls in the
/// system toolbar.
///
/// It is its own navigation stack, so on the Duo held landscape — where it is
/// the trailing column — its toolbar is the vertical bar along the curved edge:
/// close at the top, the tool tabs as one group of symbols, then whatever the
/// tool adds (Inspect, rotate, speed, Watch/Control). Held portrait the same
/// declarations are an ordinary top and bottom bar. Nothing of the pane's own
/// is drawn over the tool.
///
/// Content is supplied by the destination, which is where the chat's PR,
/// proof artifacts and chat info actually live, so a tab reuses those views
/// with their own data instead of re-fetching anything at the pane level.
struct DuoToolsPane<Content: View>: View {
  @ObservedObject var model: DuoWorkPaneModel
  @ViewBuilder var content: (DuoToolTab, DuoToolSeed) -> Content

  var body: some View {
    NavigationStack {
      paneContent
        .navigationTitle(model.tab?.title ?? "Tools")
        .navigationBarTitleDisplayMode(.inline)
        .modifier(DuoToolsPaneToolbar(model: model))
    }
    // A fresh stack per tab: a file the Git tab pushed must not be what the
    // Files tab opens on.
    .id(model.tab)
    .accessibilityIdentifier("Duo.Work.ToolsPane")
  }

  @ViewBuilder
  private var paneContent: some View {
    if let tab = model.tab {
      content(tab, model.seed)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      ADEEmptyStateView(
        symbol: "square.split.2x1",
        title: "No tool open",
        message: "Pick a tool to keep it beside this chat."
      )
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .adeScreenBackground()
    }
  }
}

/// The pane's own toolbar: close first, then one symbol per tab.
///
/// Every tab is its own item so the system can keep what matters when the
/// vertical edge bar runs out of height: the open tab and the open tool's own
/// actions stay, other tabs move into the bar's overflow first.
private struct DuoToolsPaneToolbar: ViewModifier {
  @ObservedObject var model: DuoWorkPaneModel

  func body(content: Content) -> some View {
    if #available(iOS 27.0, *) {
      content.toolbar {
        closeItem
        ForEach(model.availableTabs) { tab in
          ToolbarItem(placement: .topBarTrailing) { tabToggle(tab) }
            .visibilityPriority(tab == model.tab ? .high : .low)
        }
      }
    } else {
      content.toolbar {
        closeItem
        ForEach(model.availableTabs) { tab in
          ToolbarItem(placement: .topBarTrailing) { tabToggle(tab) }
        }
      }
    }
  }

  private var closeItem: some ToolbarContent {
    ToolbarItem(placement: .cancellationAction) {
      Button("Close tools", systemImage: "xmark") {
        ADEHaptics.light()
        model.close()
      }
      .accessibilityIdentifier("Duo.Work.ToolsPane.Close")
    }
  }

  private func tabToggle(_ tab: DuoToolTab) -> some View {
    Toggle(tab.title, systemImage: tab.symbolName, isOn: Binding(
      get: { model.tab == tab },
      set: { on in
        guard on else { return }
        ADEHaptics.light()
        model.select(tab)
      }
    ))
    .accessibilityIdentifier("Duo.Work.ToolsPane.\(tab.rawValue)")
  }
}

/// The chat column and the tools pane, laid out around the fold.
///
/// Wide (held landscape): the thread and the tool share the width half and
/// half; on a book fold each takes one page, split exactly on the fold. Tall
/// (held portrait): the tool takes the top half and the thread, composer
/// included, the bottom — exactly the halves on a laptop fold, a little under
/// half for the tool when flat. The seam between them is a hairline when flat
/// and the fold itself when folded, so no control lands on the hinge.
struct DuoWorkChatPaneSplit<Chat: View, Tools: View>: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.duoWorkFamily) private var family
  let isOpen: Bool
  let chat: () -> Chat
  let tools: () -> Tools

  init(
    isOpen: Bool,
    @ViewBuilder chat: @escaping () -> Chat,
    @ViewBuilder tools: @escaping () -> Tools
  ) {
    self.isOpen = isOpen
    self.chat = chat
    self.tools = tools
  }

  var body: some View {
    // The reader is always present and the thread always sits in the same slot
    // within a family, so opening a tool beside the chat does not re-create
    // the transcript (which would drop the reader's place).
    DuoLocalFoldReader { fold, size in
      layout(fold: fold, size: size)
    }
    .animation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion), value: isOpen)
  }

  @ViewBuilder
  private func layout(fold: DuoFold, size: CGSize) -> some View {
    if family == .tall {
      let split = DuoWorkMetrics.tallSplit(height: size.height, fold: fold)
      VStack(spacing: 0) {
        if isOpen {
          tools()
            .frame(maxWidth: .infinity)
            .frame(height: split.top)
            .transition(.move(edge: .top).combined(with: .opacity))
          DuoSeam(axis: .horizontal, foldRect: split.fold)
        }
        chat()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else {
      let split = DuoWorkMetrics.wideSplit(width: size.width, fold: fold)
      HStack(spacing: 0) {
        chat()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        if isOpen {
          DuoSeam(axis: .vertical, foldRect: split.fold)
          tools()
            .frame(width: split.trailing)
            // The tool column slides in from the trailing edge while the
            // sessions column slides out; one animation owns both.
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
      }
    }
  }
}

// MARK: - Edge bar pieces shared by the live viewers

extension View {
  /// Toolbar items a tool column must keep in view. When the vertical edge bar
  /// runs out of height the system overflows lower-priority items (the other
  /// tool tabs) before these.
  @ViewBuilder
  func duoKeptToolbar<Items: ToolbarContent>(@ToolbarContentBuilder _ content: () -> Items) -> some View {
    let items = content()
    if #available(iOS 27.0, *) {
      toolbar { items.visibilityPriority(.high) }
    } else {
      toolbar { items }
    }
  }

  /// Adds a custom `item` beside the column's trailing toolbar items, kept in
  /// view. On the Duo held landscape it lays itself out vertically inside the
  /// edge bar; held portrait it is one more item in the top bar.
  @ViewBuilder
  func duoEdgeBarTrailingItem<Item: View>(@ViewBuilder _ item: @escaping () -> Item) -> some View {
    if #available(iOS 27.1, *) {
      toolbar {
        ToolbarItem(placement: .topBarTrailing) { item() }
          .axisBehavior(.verticalPreferred)
          .visibilityPriority(.high)
      }
    } else {
      toolbar {
        ToolbarItem(placement: .topBarTrailing) { item() }
      }
    }
  }
}

/// Watch | Control for a live viewer in the tools pane, as a toolbar item: two
/// symbols, stacked when the toolbar is the vertical edge bar and side by side
/// in an ordinary bar. Watching is the default and the selected half; Control
/// fills as it is held and takes over only after the full hold, the same 0.6 s
/// rule the full-screen viewer has. While controlling, the eye hands the
/// device back.
struct DuoWatchControlSwitch: View {
  let controlling: Bool
  /// Why Control cannot be taken right now (an agent holds the device, the
  /// host cannot take input…), or nil when it can.
  let controlBlocker: String?
  let holdDuration: Double
  @Binding var holdProgress: CGFloat
  let onBeginControl: () -> Void
  let onEndControl: () -> Void
  let onBlocked: () -> Void
  let onEarlyRelease: () -> Void

  var body: some View {
    if #available(iOS 27.1, *) {
      DuoEdgeAwareStack { cells }
    } else {
      HStack(spacing: 0) { cells }
    }
  }

  private var controlEnabled: Bool { controlBlocker == nil }

  @ViewBuilder
  private var cells: some View {
    Button {
      ADEHaptics.light()
      if controlling { onEndControl() }
    } label: {
      Image(systemName: controlling ? "eye" : "eye.fill")
        .font(.system(size: 17, weight: .semibold))
        .foregroundStyle(controlling ? Color.primary : ADEColor.accent)
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(controlling ? "Stop controlling" : "Watching")
    .accessibilityAddTraits(controlling ? [] : .isSelected)

    controlCell
  }

  private var controlCell: some View {
    Image(systemName: controlling ? "hand.point.up.left.fill" : "hand.point.up.left")
      .font(.system(size: 17, weight: .semibold))
      .foregroundStyle(controlling ? ADEColor.warning : (controlEnabled ? Color.primary : Color.secondary))
      .frame(width: 44, height: 44)
      .background {
        // The hold fills a ring around the hand, so the wait is visible.
        Circle()
          .trim(from: 0, to: holdProgress)
          .stroke(ADEColor.warning, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
          .rotationEffect(.degrees(-90))
          .frame(width: 34, height: 34)
      }
      .contentShape(Rectangle())
      .onLongPressGesture(
        minimumDuration: holdDuration,
        maximumDistance: 24,
        perform: {
          guard controlEnabled, !controlling else { return }
          holdProgress = 0
          ADEHaptics.success()
          onBeginControl()
        },
        onPressingChanged: { pressing in
          guard !controlling else { return }
          guard controlEnabled else {
            if pressing { onBlocked() }
            return
          }
          if pressing {
            ADEHaptics.light()
            withAnimation(.linear(duration: holdDuration)) { holdProgress = 1 }
          } else {
            onEarlyRelease()
            withAnimation(.easeOut(duration: 0.15)) { holdProgress = 0 }
          }
        }
      )
      .accessibilityElement()
      .accessibilityLabel(controlling ? "Controlling" : "Control")
      .accessibilityHint(controlBlocker.map { "Control is unavailable: \($0)" }
        ?? "Touch and hold to drive it with your touches.")
      .accessibilityAddTraits(controlling ? .isSelected : [])
      .accessibilityAction(named: "Take control") {
        guard controlEnabled, !controlling else { return }
        onBeginControl()
      }
  }
}

/// Stacks its children vertically when they sit in the vertical edge bar, and
/// side by side in an ordinary toolbar.
@available(iOS 27.1, *)
private struct DuoEdgeAwareStack<Content: View>: View {
  @Environment(\.toolbarVerticalEdge) private var verticalEdge
  @ViewBuilder var content: () -> Content

  var body: some View {
    let layout = verticalEdge == nil
      ? AnyLayout(HStackLayout(spacing: 0))
      : AnyLayout(VStackLayout(spacing: 0))
    layout { content() }
  }
}
