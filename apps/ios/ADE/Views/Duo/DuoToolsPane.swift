import SwiftUI

// The Work tools pane: the chat's live tools (and its Chat Info, Proof and Pull
// Request pages) beside the thread on the Duo's inner display. See
// DuoWorkSplit.swift for the columns around it.

/// One surface the Work tools pane can show for a chat.
///
/// Two kinds. The four lane **tools** mirror the composer's lane tool chips
/// exactly (the Tools menu lists them). The **pages** are Chat info (desktop's
/// chat actions drawer), its Proof, and the chat's Pull Request. A tab exists
/// only while its surface exists, the same availability the pills and menu
/// items use.
///
/// Declaration order is the order the tools appear in the Tools menu.
enum DuoToolTab: String, CaseIterable, Identifiable, Hashable {
  case simulator
  case macDesktop
  case appControl
  case browser
  case chatInfo
  case proof
  case pr
  /// Opening a pull request for the chat's lane (desktop opens it where the
  /// PR shows).
  case createPr
  /// The CTO's settings (identity, model, home machine, memory), beside the
  /// CTO thread: desktop's CTO settings page.
  case ctoSettings

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
    case .createPr: return "New Pull Request"
    case .ctoSettings: return "CTO Settings"
    }
  }

  var symbolName: String {
    switch self {
    case .simulator: return "iphone"
    case .macDesktop: return "desktopcomputer"
    case .appControl: return "macwindow"
    case .browser: return "globe"
    // Desktop's chat actions drawer toggle (Phosphor TreeStructure).
    case .chatInfo: return "flowchart"
    case .proof: return "photo.on.rectangle.angled"
    case .pr: return "arrow.triangle.pull"
    case .createPr: return "plus"
    case .ctoSettings: return "gearshape"
    }
  }

  /// A lane tool, switched in the pane header, as opposed to a chat page.
  var isTool: Bool {
    switch self {
    case .simulator, .macDesktop, .appControl, .browser: return true
    case .chatInfo, .proof, .pr, .createPr, .ctoSettings: return false
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
/// this is open, like the desktop sidebar), the chat's pills and its Tools /
/// Chat info buttons (they open it), and the destination (it lays the pane out
/// beside the thread). The pane shows ONE surface at a time; another tool is
/// one tap away on the Tools button or its pill.
@MainActor
final class DuoWorkPaneModel: ObservableObject {
  @Published private(set) var isOpen = false
  @Published private(set) var tab: DuoToolTab?
  /// The lane tools the chat's chips can show, published by the chat's own poll.
  @Published private(set) var toolTabs: [DuoToolTab] = []
  @Published private(set) var seed = DuoToolSeed()
  /// Where the pane grows from: the corner nearest the pill or button that
  /// opened it, so it reads as coming out of what was tapped.
  @Published private(set) var origin: UnitPoint = .topTrailing
  /// The last state the chips reported, so a tool opened from the Tools menu
  /// starts where a chip tap would have. Not published: it only seeds the
  /// next open.
  private var chipSeed = DuoToolSeed()
  /// Runs just before the pane appears or goes, in the same transaction, so
  /// the Work root can cede (or hand back) the sessions column without a
  /// frame where list, chat and pane all claim their full widths.
  var willChangeOpen: ((Bool) -> Void)?

  /// Opens a tab. The pane appears if it was closed, and switches if it was not.
  func open(_ tab: DuoToolTab, seed: DuoToolSeed? = nil, origin: UnitPoint = .topTrailing) {
    let next = seed ?? (tab.isTool ? chipSeed : DuoToolSeed())
    if self.seed != next { self.seed = next }
    if !isOpen, self.origin != origin { self.origin = origin }
    if self.tab != tab { self.tab = tab }
    if !isOpen {
      willChangeOpen?(true)
      isOpen = true
    }
  }

  /// Opens the tool a lane tool chip stands for, seeded from the chip's poll.
  func open(
    chip: WorkToolChip,
    tools: WorkLaneToolsModel,
    macDesktopStream: Bool,
    origin: UnitPoint = .topTrailing
  ) {
    open(chip.duoToolTab, seed: DuoToolSeed(
      appleStatus: tools.appleStatus,
      macDesktop: tools.macDesktopState,
      appControl: tools.appControlState,
      appControlStream: tools.appControlStream,
      macDesktopStream: macDesktopStream
    ), origin: origin)
  }

  /// True while the pane shows one of the lane tools (not a page).
  var showsTool: Bool { isOpen && (tab?.isTool ?? false) }

  /// A button or pill for one surface: opens it, or puts it away when it is
  /// already up.
  func toggle(_ tab: DuoToolTab, origin: UnitPoint = .topTrailing) {
    if isOpen, self.tab == tab {
      close()
    } else {
      open(tab, origin: origin)
    }
  }

  func close() {
    if isOpen {
      willChangeOpen?(false)
      isOpen = false
    }
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

/// Reads which surface the pane shows, for a view that is not otherwise
/// observing the pane (the chat's pill row draws that pill selected). With no
/// pane (the phone) it reports nil.
struct DuoPaneSelectionReader<Content: View>: View {
  let pane: DuoWorkPaneModel?
  @ViewBuilder var content: (DuoToolTab?) -> Content

  var body: some View {
    if let pane {
      Observed(pane: pane, content: content)
    } else {
      content(nil)
    }
  }

  private struct Observed: View {
    @ObservedObject var pane: DuoWorkPaneModel
    let content: (DuoToolTab?) -> Content

    var body: some View {
      content(pane.isOpen ? pane.tab : nil)
    }
  }
}

// MARK: - Pane header contributions

private struct DuoPaneControlsInBarKey: EnvironmentKey {
  static let defaultValue = false
}

extension EnvironmentValues {
  /// The pane's controls are drawn by the system bar (the Duo's edge bar), not
  /// the pane's own header row: controls drop their own glass, and the
  /// Watch | Control pair stands vertically like the rest of the bar.
  var duoPaneControlsInBar: Bool {
    get { self[DuoPaneControlsInBarKey.self] }
    set { self[DuoPaneControlsInBarKey.self] = newValue }
  }
}

private struct DuoPaneActionsRowKey: EnvironmentKey {
  static let defaultValue = false
}

extension EnvironmentValues {
  /// With the controls on the edge bar, the pane still draws a few of them in
  /// its own top row: the ones that are not a single symbol (Watch | Control,
  /// the PR's watch chip). True for that row's copy of the controls.
  var duoPaneActionsRow: Bool {
    get { self[DuoPaneActionsRowKey.self] }
    set { self[DuoPaneActionsRowKey.self] = newValue }
  }
}

/// A pane control that stays in the pane's own top row when the rest move to
/// the edge bar (a capsule, not a single symbol).
struct DuoPaneRowOnly<Content: View>: View {
  @ViewBuilder let content: () -> Content
  @Environment(\.duoPaneControlsInBar) private var inBar
  @Environment(\.duoPaneActionsRow) private var row

  var body: some View {
    if !inBar || row {
      content()
    }
  }
}

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

struct DuoPaneHeaderActionsKey: PreferenceKey {
  static var defaultValue: DuoPaneHeaderActions?
  static func reduce(value: inout DuoPaneHeaderActions?, nextValue: () -> DuoPaneHeaderActions?) {
    value = value ?? nextValue()
  }
}

struct DuoPaneHeaderStatusKey: PreferenceKey {
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
  @Environment(\.duoPaneControlsInBar) private var inBar
  @Environment(\.duoPaneActionsRow) private var row

  var body: some View {
    if !(inBar && row) {
      buttonBody
    }
  }

  @ViewBuilder
  private var buttonBody: some View {
    let button = Button(role: role) {
      ADEHaptics.light()
      action()
    } label: {
      if inBar {
        // A bar item: the bar draws the glass; the label names it for the
        // bar's overflow menu and VoiceOver.
        Label(title, systemImage: systemImage)
          .symbolVariant(isOn ? .fill : .none)
      } else {
        Image(systemName: systemImage)
          .font(.system(size: 16, weight: .medium))
          .foregroundStyle(isOn ? ADEColor.accent : Color.primary)
          .frame(width: 22, height: 22)
      }
    }
    .accessibilityLabel(title)
    .accessibilityAddTraits(isOn ? .isSelected : [])
    if inBar {
      button
    } else {
      button
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
    }
  }
}

/// A menu among the pane's controls (hardware buttons, the PR's ⋯): a glass
/// circle in the pane header, a plain bar item on the edge bar.
struct DuoPaneActionMenu<Items: View>: View {
  let title: String
  let systemImage: String
  @ViewBuilder let items: () -> Items
  @Environment(\.duoPaneControlsInBar) private var inBar
  @Environment(\.duoPaneActionsRow) private var row

  var body: some View {
    if inBar && row {
      EmptyView()
    } else if inBar {
      Menu {
        items()
      } label: {
        Label(title, systemImage: systemImage)
      }
    } else {
      Menu {
        items()
      } label: {
        Image(systemName: systemImage)
          .font(.system(size: 16, weight: .medium))
          .frame(width: 22, height: 22)
      }
      .buttonStyle(.glass)
      .buttonBorderShape(.circle)
      .accessibilityLabel(title)
    }
  }
}

// MARK: - The pane

/// The tools pane: a header row, then the open tool or page filling the rest.
///
/// Plain content inside the chat column's stack (never a stack of its own: a
/// nested stack would take over the chat's title and rail). Its header is its
/// own row, not toolbar items, for the same reason: the surface's name, its
/// status line, and the open surface's own controls at the trailing end (a
/// tool's rotate and Watch | Control, the PR's ⋯).
///
/// Beside the chat, Close is the chat's toolbar's (the top of the edge bar,
/// or the top bar's trailing end), so the header has none. Stacked over the
/// chat (laptop, tent) the pane is a half of its own and draws its Close.
///
/// Content is supplied by the destination, which is where the chat's PR,
/// proof artifacts and chat info live, so a page reuses those views with
/// their own data instead of re-fetching anything at the pane level.
struct DuoToolsPane<Content: View>: View {
  @ObservedObject var model: DuoWorkPaneModel
  @ViewBuilder var content: (DuoToolTab, DuoToolSeed) -> Content
  @State private var status: String?
  @Environment(\.duoWorkFamily) private var family
  @Environment(\.duoLayout) private var duo

  /// Beside the chat: Close lives on the chat's toolbar.
  private var besideChat: Bool { family != .tall }

  /// On the edge bar the pane's header row is drawn by the chat's bar, on
  /// the title capsule's row (`DuoChatRail`): a row drawn by the pane under
  /// the bar's band could be seen but not tapped. The pane starts under it.
  private var headerInBar: Bool { besideChat && duo.hasEdgeBar }

  private var headerHeight: CGFloat { 52 }
  private var statusHeight: CGFloat { 18 }

  var body: some View {
    let tab = model.tab
    VStack(spacing: 0) {
      Color.clear
        .frame(height: headerInBar ? 0 : headerHeight
          + (status != nil && !besideChat ? statusHeight - 8 : 0))
      Group {
        if let tab {
          content(tab, model.seed)
            // A fresh viewer per tool: two tools never share a stream.
            .id(tab)
            // The surface's controls are drawn in this pane's header row.
            .environment(\.duoPaneControlsInBar, false)
        } else {
          Color.clear
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    // The pane's header floats over its content like the chat's: a soft
    // edge, never the hard band iOS picks under a bar with wide items.
    .scrollEdgeEffectStyle(.soft, for: .top)
    .overlayPreferenceValue(DuoPaneHeaderActionsKey.self, alignment: .top) { actions in
      if !headerInBar {
        header(tab: tab, actions: actions)
      }
    }
    .onPreferenceChange(DuoPaneHeaderStatusKey.self) { next in
      if status != next { status = next }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .accessibilityIdentifier("Duo.Work.ToolsPane")
  }

  @ViewBuilder
  private func header(tab: DuoToolTab?, actions: DuoPaneHeaderActions?) -> some View {
    if besideChat {
      sideHeader(tab: tab, actions: actions)
    } else {
      rowHeader(tab: tab, actions: actions)
    }
  }

  /// Beside the chat: one row, the name and its status side by side, then
  /// the surface's own controls at the trailing end.
  private func sideHeader(tab: DuoToolTab?, actions: DuoPaneHeaderActions?) -> some View {
    DuoPaneHeaderRow(title: tab?.title, status: status, actions: actions)
      .frame(height: headerHeight)
      .padding(.horizontal, 16)
  }

  @ViewBuilder
  private func rowHeader(tab: DuoToolTab?, actions: DuoPaneHeaderActions?) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        if let tab {
          Text(tab.title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
            .accessibilityAddTraits(.isHeader)
          Spacer(minLength: 8)
          if let actions {
            HStack(spacing: 6) { actions.content }
              .fixedSize()
          }
        }
        closeButton
      }
      .frame(height: headerHeight)
      // Tucked up under the name: the two read as one block.
      .padding(.bottom, status != nil ? -8 : 0)
      // The status gets the pane's whole width under the row, so a device
      // name is never squeezed between the controls.
      if let status {
        Text(status)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
          .truncationMode(.tail)
          .frame(height: statusHeight, alignment: .top)
      }
    }
    .padding(.horizontal, 14)
  }

  private var closeButton: some View {
    DuoPaneActionButton(title: "Close", systemImage: "xmark") {
      model.close()
    }
    .accessibilityIdentifier("Duo.Work.ToolsPane.Close")
  }
}

/// The pane's header row beside the chat: the surface's name and its status
/// side by side, then its own controls at the trailing end ("Pull Request
/// #1852 · Merged … ⋯"). Drawn by the pane under a top bar, and by the chat's
/// bar itself on the edge bar.
struct DuoPaneHeaderRow: View {
  let title: String?
  let status: String?
  let actions: DuoPaneHeaderActions?

  var body: some View {
    HStack(spacing: 10) {
      HStack(alignment: .firstTextBaseline, spacing: 10) {
        if let title {
          Text(title)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .accessibilityAddTraits(.isHeader)
            .layoutPriority(1)
        }
        if let status {
          // Whole or not at all: a status cut to "iPh…ing" says nothing.
          ViewThatFits(in: .horizontal) {
            Text(status)
            Color.clear.frame(width: 0, height: 0)
          }
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
        }
      }
      Spacer(minLength: 8)
      if let actions {
        HStack(spacing: 6) { actions.content }
          .fixedSize()
          .environment(\.duoPaneControlsInBar, false)
      }
    }
    .lineLimit(1)
  }
}

/// The chat column and the tools pane, laid out around the fold.
///
/// Side by side (every flat posture, held either way, and an iPad): the
/// thread runs from the column's leading edge to the display's hinge and the
/// pane from the hinge to the edge bar, flat or book-folded alike, so the
/// hinge is always the divider (an iPad, or the open display held upright,
/// splits on the window's middle). The pane grows out of the pill or button
/// that opened it.
///
/// Stacked (laptop and tent: hinge bent, fold across): the top half is always
/// the tool area, the thread with its composer the bottom half. With nothing
/// open the top half offers what can open there (`idle`).
struct DuoWorkChatPaneSplit<Chat: View, Tools: View, Idle: View>: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.duoWorkFamily) private var family
  /// The window's right edge in global coordinates (past the edge bar).
  @State private var windowMaxX: CGFloat = 0
  let isOpen: Bool
  let origin: UnitPoint
  let chat: () -> Chat
  let tools: () -> Tools
  let idle: () -> Idle
  /// Stacked (laptop, upright) with nothing open, the top half shows what can
  /// open there. False for a chat made for the whole screen (the CTO): the
  /// thread takes the height until something opens.
  var showsIdle = true

  init(
    isOpen: Bool,
    origin: UnitPoint = .topTrailing,
    showsIdle: Bool = true,
    @ViewBuilder chat: @escaping () -> Chat,
    @ViewBuilder tools: @escaping () -> Tools,
    @ViewBuilder idle: @escaping () -> Idle
  ) {
    self.isOpen = isOpen
    self.origin = origin
    self.showsIdle = showsIdle
    self.chat = chat
    self.tools = tools
    self.idle = idle
  }

  var body: some View {
    // The reader is always present and the thread always sits in the same slot
    // within a family, so opening a tool beside the chat does not re-create
    // the transcript (which would drop the reader's place).
    GeometryReader { proxy in
      let global = proxy.frame(in: .global)
      // The window's middle in this area's coordinates. The area stops at the
      // edge bar (its trailing safe area), so the window's right edge is read
      // by a reader that ignores it.
      let hingeX = windowMaxX > 0 ? windowMaxX / 2 - global.minX : nil
      layout(fold: DuoFoldReading.fold(in: proxy), hingeX: hingeX, size: proxy.size)
    }
    .background {
      GeometryReader { full in
        Color.clear
          .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxX.rounded() } action: { maxX in
            if windowMaxX != maxX { windowMaxX = maxX }
          }
      }
      .ignoresSafeArea()
    }
    .animation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion), value: isOpen)
  }

  private var paneTransition: AnyTransition {
    reduceMotion
      ? .opacity
      : .asymmetric(
          insertion: .scale(scale: 0.12, anchor: origin).combined(with: .opacity),
          removal: .scale(scale: 0.6, anchor: origin).combined(with: .opacity)
        )
  }

  @ViewBuilder
  private func layout(fold: DuoFold, hingeX: CGFloat?, size: CGSize) -> some View {
    if family == .tall {
      let split = DuoWorkMetrics.tallSplit(height: size.height, fold: fold)
      let topShown = isOpen || showsIdle
      VStack(spacing: 0) {
        ZStack {
          if isOpen {
            tools()
              .transition(.opacity)
          } else {
            idle()
              .transition(.opacity)
          }
        }
        .frame(maxWidth: .infinity)
        .frame(height: topShown ? split.top : 0)
        .clipped()
        DuoSeam(axis: .horizontal, foldRect: split.fold)
          .opacity(topShown ? 1 : 0)
          .frame(height: topShown ? nil : 0)
        chat()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else {
      // `size` is the room left of the edge bar (the bar is this area's
      // trailing safe area); the hinge is where the display folds.
      let split = DuoWorkMetrics.wideSplit(width: size.width, fold: fold, hingeX: hingeX)
      HStack(spacing: 0) {
        chat()
          // Exactly to the hinge: a flexible chat beside a flexible pane
          // would be handed half the room, whatever the hinge says.
          .frame(width: isOpen ? split.chat : nil)
          .frame(maxWidth: isOpen ? nil : .infinity, maxHeight: .infinity)
          // Alone across a book fold the composer sits under the thread it
          // writes to, the same width (it sat on the right page only, under
          // a thread spanning both). Work and CTO lay out the same.
          .environment(\.duoComposerLeadingInset, 0)
        if isOpen {
          DuoSeam(axis: .vertical, foldRect: split.fold)
          tools()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .transition(paneTransition)
        }
      }
    }
  }
}

/// The stacked layout's top half with nothing open: what can open there, as
/// a quiet grid of large tiles (the running tools, Chat info, the PR). A tile
/// opens its surface in the same half.
struct DuoToolTiles: View {
  struct Tile: Identifiable {
    let tab: DuoToolTab
    /// One quiet line under the name ("16 Pro · live", "3 tabs", "#1304").
    let detail: String?
    var id: DuoToolTab { tab }
  }

  let tiles: [Tile]
  let onOpen: (DuoToolTab) -> Void

  var body: some View {
    GeometryReader { proxy in
      // One row when the half allows it: the tiles never run into the fold.
      let columns = max(2, min(max(tiles.count, 2), Int(proxy.size.width / 150)))
      VStack(alignment: .leading, spacing: 12) {
        Text(tiles.contains(where: { $0.tab.isTool }) ? "Open beside the chat" : "No tools are running")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
        LazyVGrid(
          columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: columns),
          spacing: 12
        ) {
          ForEach(tiles) { tile in
            Button {
              ADEHaptics.light()
              onOpen(tile.tab)
            } label: {
              VStack(alignment: .leading, spacing: 10) {
                Image(systemName: tile.tab.symbolName)
                  .font(.system(size: 22, weight: .regular))
                  .foregroundStyle(tile.tab.isTool ? ADEColor.accent : ADEColor.textSecondary)
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: 1) {
                  Text(tile.tab.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(ADEColor.textPrimary)
                  if let detail = tile.detail {
                    Text(detail)
                      .font(.caption)
                      .foregroundStyle(ADEColor.textSecondary)
                  }
                }
                .lineLimit(1)
              }
              .frame(maxWidth: .infinity, minHeight: 96, alignment: .leading)
              .padding(14)
              .background(ADEColor.cardBackground, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
              .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            }
            .buttonStyle(.plain)
            .accessibilityLabel([tile.tab.title, tile.detail].compactMap { $0 }.joined(separator: ", "))
          }
        }
        if !tiles.contains(where: { $0.tab.isTool }) {
          Text("Ask the agent to start a simulator, the browser or a desktop; it shows up here.")
            .font(.footnote)
            .foregroundStyle(ADEColor.textMuted)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 20)
      .padding(.top, 16)
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .accessibilityIdentifier("Duo.Work.ToolTiles")
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
  @Environment(\.duoPaneControlsInBar) private var inBar
  @Environment(\.duoPaneActionsRow) private var row

  var body: some View {
    if inBar && !row {
      // The edge bar's items are single symbols; the switch stays a capsule
      // in the pane's own top row.
      EmptyView()
    } else {
      HStack(spacing: 0) { cells }
        .padding(.horizontal, 2)
        .glassEffect(.regular.interactive(), in: Capsule())
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
