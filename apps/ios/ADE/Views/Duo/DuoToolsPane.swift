import SwiftUI

// The Work tools pane: the chat's live tools (and its Chat Info, Proof and Pull
// Request pages) beside the thread on the Duo's inner display. See
// DuoWorkSplit.swift for the columns around it.

/// One surface the Work tools pane can show for a chat.
///
/// Two kinds. The four lane **tools** mirror the composer's lane tool chips
/// exactly and are what the pane header's segmented control switches between.
/// The three **pages** are the chat actions the rail opens in the same area
/// (desktop's chat actions drawer), each with a title and Close instead of the
/// tool switcher. A tab exists only while its surface exists (see
/// `DuoWorkPaneModel`), the same availability the chips and menu items use.
///
/// Declaration order is the order the tools appear in the switcher.
enum DuoToolTab: String, CaseIterable, Identifiable, Hashable {
  case simulator
  case macDesktop
  case appControl
  case browser
  case chatInfo
  case proof
  case pr

  var id: String { rawValue }

  var title: String {
    switch self {
    case .simulator: return "Simulator"
    case .macDesktop: return "Desktop"
    case .appControl: return "App Control"
    case .browser: return "Browser"
    case .chatInfo: return "Chat Info"
    case .proof: return "Proof"
    case .pr: return "Pull Request"
    }
  }

  var symbolName: String {
    switch self {
    case .simulator: return "iphone"
    case .macDesktop: return "desktopcomputer"
    case .appControl: return "macwindow"
    case .browser: return "globe"
    case .chatInfo: return "info.circle"
    case .proof: return "photo.on.rectangle.angled"
    case .pr: return "arrow.triangle.pull"
    }
  }

  /// A lane tool, switched in the pane header, as opposed to a chat page.
  var isTool: Bool {
    switch self {
    case .simulator, .macDesktop, .appControl, .browser: return true
    case .chatInfo, .proof, .pr: return false
    }
  }

  /// A live picture of another machine's screen. These are the only tabs that
  /// hold a video stream.
  var isLiveViewer: Bool {
    switch self {
    case .simulator, .macDesktop, .appControl: return true
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

/// What the Work tab's tools pane is showing, and whether it is up.
///
/// One model per Work root, shared by the sessions column (it collapses while
/// this is open, like the desktop sidebar), the chat's rail (Tools, Chat Info,
/// Proof, Pull Request open it), and the destination (it lays the pane out
/// beside the thread).
@MainActor
final class DuoWorkPaneModel: ObservableObject {
  @Published private(set) var isOpen = false
  @Published private(set) var tab: DuoToolTab?
  /// The lane tools the chat's chips can show, published by the chat's own poll.
  @Published private(set) var toolTabs: [DuoToolTab] = []
  @Published private(set) var seed = DuoToolSeed()
  /// The last state the chips reported, so a tool opened from the rail's Tools
  /// button starts where a chip tap would have. Not published: it only seeds
  /// the next open.
  private var chipSeed = DuoToolSeed()
  /// The tool the pane last showed, for the rail's Tools button.
  private var lastTool: DuoToolTab?

  /// The tools the header switches between: what the chips offer, plus the
  /// open tool if its chip has just gone (it stays reachable for this
  /// presentation rather than vanishing under the reader).
  var switcherTabs: [DuoToolTab] {
    var offered = Set(toolTabs)
    if let tab, tab.isTool { offered.insert(tab) }
    return DuoToolTab.allCases.filter { $0.isTool && offered.contains($0) }
  }

  /// Opens a tab. The pane appears if it was closed, and switches if it was not.
  func open(_ tab: DuoToolTab, seed: DuoToolSeed? = nil) {
    let next = seed ?? (tab.isTool ? chipSeed : DuoToolSeed())
    if self.seed != next { self.seed = next }
    if self.tab != tab { self.tab = tab }
    if tab.isTool { lastTool = tab }
    if !isOpen { isOpen = true }
  }

  /// Opens the tool a lane tool chip stands for, seeded from the chip's poll.
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

  /// True while the pane shows one of the lane tools (not a page).
  var showsTool: Bool { isOpen && (tab?.isTool ?? false) }

  /// The rail's Tools button: puts a showing tool away, or brings back the
  /// tool the pane last showed (else the first one the lane has).
  func toggleTools() {
    if showsTool {
      close()
      return
    }
    if let lastTool, toolTabs.contains(lastTool) {
      open(lastTool)
    } else if let first = toolTabs.first {
      open(first)
    }
  }

  /// A rail page button: opens its page, or closes it when it is already up.
  func togglePage(_ page: DuoToolTab) {
    if isOpen, tab == page {
      close()
    } else {
      open(page)
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
  }
}

// MARK: - Pane header contributions

/// What the open tool adds to the pane header: its actions (Inspect, Rotate,
/// Speed, Watch | Control…) and a one-line status ("iPhone 16 Pro · Watching").
///
/// The pane sits inside the chat column's navigation stack, so a toolbar item
/// declared by a viewer would land in the chat's rail. Viewers hand their
/// controls to the pane through these preferences instead; the pane draws them
/// in its own header row.
struct DuoPaneHeaderActions {
  let content: AnyView
}

private struct DuoPaneHeaderActionsKey: PreferenceKey {
  static var defaultValue: DuoPaneHeaderActions?
  static func reduce(value: inout DuoPaneHeaderActions?, nextValue: () -> DuoPaneHeaderActions?) {
    value = value ?? nextValue()
  }
}

private struct DuoPaneHeaderStatusKey: PreferenceKey {
  static var defaultValue: String?
  static func reduce(value: inout String?, nextValue: () -> String?) {
    value = value ?? nextValue()
  }
}

extension View {
  /// Hands this tool's controls and status line to the tools pane header.
  /// Inert outside the pane: nothing else reads these preferences.
  func duoPaneHeader<Actions: View>(
    status: String?,
    @ViewBuilder actions: () -> Actions
  ) -> some View {
    preference(key: DuoPaneHeaderActionsKey.self, value: DuoPaneHeaderActions(content: AnyView(actions())))
      .preference(key: DuoPaneHeaderStatusKey.self, value: status)
  }
}

/// One of the pane header's tool actions: a symbol on a small glass circle,
/// the same control the system draws for a toolbar item.
struct DuoPaneActionButton: View {
  let title: String
  let systemImage: String
  var isOn = false
  var role: ButtonRole?
  let action: () -> Void

  var body: some View {
    Button(role: role) {
      ADEHaptics.light()
      action()
    } label: {
      Image(systemName: systemImage)
        .font(.system(size: 16, weight: .medium))
        .foregroundStyle(isOn ? ADEColor.accent : Color.primary)
        .frame(width: 22, height: 22)
    }
    .buttonStyle(.glass)
    .buttonBorderShape(.circle)
    .accessibilityLabel(title)
    .accessibilityAddTraits(isOn ? .isSelected : [])
  }
}

// MARK: - The pane

/// The tools pane: a header row, then the open tool or page filling the rest.
///
/// Plain content inside the chat column's stack (never a stack of its own: a
/// nested stack would take over the chat's title and rail). Its header is its
/// own row, not toolbar items, for the same reason:
/// - a tool: the lane's tools as a segmented control, the open tool's actions
///   as glass buttons, then Close;
/// - a page (Chat Info, Proof, Pull Request): the page title, then Close.
///
/// Content is supplied by the destination, which is where the chat's PR,
/// proof artifacts and chat info live, so a page reuses those views with
/// their own data instead of re-fetching anything at the pane level.
struct DuoToolsPane<Content: View>: View {
  @ObservedObject var model: DuoWorkPaneModel
  @ViewBuilder var content: (DuoToolTab, DuoToolSeed) -> Content
  @State private var status: String?

  private var headerHeight: CGFloat { 52 }
  private var statusHeight: CGFloat { 20 }

  var body: some View {
    let tab = model.tab
    VStack(spacing: 0) {
      Color.clear
        .frame(height: headerHeight + (status != nil && tab?.isTool == true ? statusHeight : 0))
      Group {
        if let tab {
          content(tab, model.seed)
            // A fresh viewer per tool: two tools never share a stream.
            .id(tab)
        } else {
          Color.clear
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    .overlayPreferenceValue(DuoPaneHeaderActionsKey.self, alignment: .top) { actions in
      header(tab: tab, actions: actions)
    }
    .onPreferenceChange(DuoPaneHeaderStatusKey.self) { next in
      if status != next { status = next }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .accessibilityIdentifier("Duo.Work.ToolsPane")
  }

  @ViewBuilder
  private func header(tab: DuoToolTab?, actions: DuoPaneHeaderActions?) -> some View {
    VStack(spacing: 0) {
      HStack(spacing: 8) {
        if let tab, tab.isTool {
          toolSwitcher(actions: actions)
        } else if let tab {
          // A page: its title, and its status line under it.
          VStack(alignment: .leading, spacing: 0) {
            Text(tab.title)
              .font(.headline)
              .foregroundStyle(ADEColor.textPrimary)
            if let status {
              Text(status)
                .font(.footnote)
                .foregroundStyle(ADEColor.textSecondary)
            }
          }
          .lineLimit(1)
          .accessibilityElement(children: .combine)
          .accessibilityAddTraits(.isHeader)
          Spacer(minLength: 8)
          if let actions {
            HStack(spacing: 6) { actions.content }
              .fixedSize()
          }
        }
        closeButton
      }
      .padding(.horizontal, 14)
      .frame(height: headerHeight)

      if let status, tab?.isTool == true {
        Text(status)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.middle)
          .frame(height: statusHeight)
          .padding(.horizontal, 14)
      }
    }
  }

  /// The tools as a segmented control, then the open tool's actions. Titles
  /// when they fit, symbols when they do not, a pull-down menu when even the
  /// symbols would crowd the actions.
  @ViewBuilder
  private func toolSwitcher(actions: DuoPaneHeaderActions?) -> some View {
    let tabs = model.switcherTabs
    ViewThatFits(in: .horizontal) {
      switcherRow(tabs: tabs, style: .titles, actions: actions)
      switcherRow(tabs: tabs, style: .symbols, actions: actions)
      switcherRow(tabs: tabs, style: .menu, actions: actions)
    }
  }

  private enum SwitcherStyle { case titles, symbols, menu }

  @ViewBuilder
  private func switcherRow(tabs: [DuoToolTab], style: SwitcherStyle, actions: DuoPaneHeaderActions?) -> some View {
    HStack(spacing: 8) {
      switcher(tabs: tabs, style: style)
        .fixedSize()
      Spacer(minLength: 8)
      if let actions {
        HStack(spacing: 6) {
          actions.content
        }
        .fixedSize()
      }
    }
  }

  @ViewBuilder
  private func switcher(tabs: [DuoToolTab], style: SwitcherStyle) -> some View {
    let selection = Binding<DuoToolTab>(
      get: { model.tab ?? tabs.first ?? .simulator },
      set: { next in
        ADEHaptics.light()
        model.open(next)
      }
    )
    if tabs.count <= 1, let only = tabs.first {
      Label(only.title, systemImage: only.symbolName)
        .font(.headline)
        .foregroundStyle(ADEColor.textPrimary)
        .labelStyle(.titleOnly)
        .accessibilityAddTraits(.isHeader)
    } else {
      switch style {
      case .titles:
        Picker("Tool", selection: selection) {
          ForEach(tabs) { tab in
            Text(tab.title).tag(tab)
          }
        }
        .pickerStyle(.segmented)
        .accessibilityIdentifier("Duo.Work.ToolsPane.Switcher")
      case .symbols:
        Picker("Tool", selection: selection) {
          ForEach(tabs) { tab in
            Image(systemName: tab.symbolName)
              .accessibilityLabel(tab.title)
              .tag(tab)
          }
        }
        .pickerStyle(.segmented)
        .frame(width: CGFloat(tabs.count) * 52)
        .accessibilityIdentifier("Duo.Work.ToolsPane.Switcher")
      case .menu:
        // The open tool's name as the pane's title, with the other tools a
        // tap away in a menu.
        Menu {
          Picker("Tool", selection: selection) {
            ForEach(tabs) { tab in
              Label(tab.title, systemImage: tab.symbolName).tag(tab)
            }
          }
        } label: {
          HStack(spacing: 4) {
            Text((model.tab ?? tabs.first ?? .simulator).title)
              .font(.headline)
            Image(systemName: "chevron.up.chevron.down")
              .font(.caption.weight(.semibold))
              .foregroundStyle(ADEColor.textSecondary)
          }
          .foregroundStyle(ADEColor.textPrimary)
          .contentShape(Rectangle())
        }
        .accessibilityLabel("Tool, \((model.tab ?? tabs.first ?? .simulator).title)")
        .accessibilityIdentifier("Duo.Work.ToolsPane.Switcher")
      }
    }
  }

  private var closeButton: some View {
    DuoPaneActionButton(title: "Close", systemImage: "xmark") {
      model.close()
    }
    .accessibilityIdentifier("Duo.Work.ToolsPane.Close")
  }
}

/// The chat column and the tools pane, laid out around the fold.
///
/// Wide (held landscape): the thread and the pane share the width half and
/// half; on a book fold each takes one page, split exactly on the fold. Tall
/// (held portrait): the pane takes the top half and the thread, composer
/// included, the bottom — exactly the halves on a laptop fold, a little under
/// half for the pane when flat. The seam between them is a hairline when flat
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
          // Alone across a book fold, the thread may span both pages but the
          // composer keeps to the trailing one.
          .environment(\.duoComposerLeadingInset, isOpen ? 0 : composerInset(fold: fold, width: size.width))
        if isOpen {
          DuoSeam(axis: .vertical, foldRect: split.fold)
          tools()
            .frame(width: split.trailing)
            // The pane slides in from the trailing edge while the sessions
            // column slides out; one animation owns both.
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
      }
    }
  }
}

extension DuoWorkChatPaneSplit {
  /// The fold's trailing edge, when a book fold runs through the chat.
  fileprivate func composerInset(fold: DuoFold, width: CGFloat) -> CGFloat {
    guard case .sideBySide(let rect) = fold,
          rect.minX > 200,
          width - rect.maxX > 280 else { return 0 }
    return rect.maxX
  }
}

/// Watch | Control for a live viewer in the tools pane header: two symbols in
/// one glass capsule. Watching is the default and the selected half; Control
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
    HStack(spacing: 0) { cells }
      .padding(.horizontal, 2)
      .glassEffect(.regular.interactive(), in: Capsule())
  }

  private var controlEnabled: Bool { controlBlocker == nil }

  @ViewBuilder
  private var cells: some View {
    Button {
      ADEHaptics.light()
      if controlling { onEndControl() }
    } label: {
      Image(systemName: controlling ? "eye" : "eye.fill")
        .font(.system(size: 16, weight: .medium))
        .foregroundStyle(controlling ? Color.primary : ADEColor.accent)
        .frame(width: 40, height: 40)
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(controlling ? "Stop controlling" : "Watching")
    .accessibilityAddTraits(controlling ? [] : .isSelected)

    controlCell
  }

  private var controlCell: some View {
    Image(systemName: controlling ? "hand.point.up.left.fill" : "hand.point.up.left")
      .font(.system(size: 16, weight: .medium))
      .foregroundStyle(controlling ? ADEColor.warning : (controlEnabled ? Color.primary : Color.secondary))
      .frame(width: 40, height: 40)
      .background {
        // The hold fills a ring around the hand, so the wait is visible.
        Circle()
          .trim(from: 0, to: holdProgress)
          .stroke(ADEColor.warning, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
          .rotationEffect(.degrees(-90))
          .frame(width: 32, height: 32)
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
