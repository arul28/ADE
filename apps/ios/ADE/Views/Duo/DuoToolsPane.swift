import SwiftUI

// The Work tools pane (desktop-style tool tabs beside a chat). See DuoWorkSplit.swift.

/// One surface the Work tools pane can show for a chat.
///
/// The four lane tools mirror the composer chips exactly; the rest are the
/// surfaces the chat's own overflow menu and lane chrome already own, shown
/// beside the thread instead of over it. A tab exists only while its surface
/// exists (see `DuoWorkPaneModel.availableTabs`), the same availability the
/// chips and menu items use.
enum DuoToolTab: String, CaseIterable, Identifiable, Hashable {
  case simulator
  case macDesktop
  case appControl
  case browser
  case pr
  case git
  case files
  case issues
  case proof
  case chatInfo

  var id: String { rawValue }

  /// Short enough that several tabs fit the strip on a folded half-page.
  var title: String {
    switch self {
    case .simulator: return "Simulator"
    case .macDesktop: return "Desktop"
    case .appControl: return "App"
    case .browser: return "Browser"
    case .pr: return "PR"
    case .git: return "Git"
    case .files: return "Files"
    case .issues: return "Issues"
    case .proof: return "Proof"
    case .chatInfo: return "Info"
    }
  }

  var symbolName: String {
    switch self {
    case .simulator: return "iphone"
    case .macDesktop: return "desktopcomputer"
    case .appControl: return "macwindow"
    case .browser: return "globe"
    case .pr: return "arrow.triangle.pull"
    case .git: return "arrow.triangle.branch"
    case .files: return "folder"
    case .issues: return "list.bullet.rectangle"
    case .proof: return "cube.transparent"
    case .chatInfo: return "info.circle"
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
/// instead of an empty one. Captured once, at the tap: the lane tools model is
/// the only poller, and a viewer opened from the pane continues from here.
struct DuoToolSeed: Equatable {
  var appleStatus: AppleDeviceStatus?
  var macDesktop: WorkToolsMacDesktopState?
  var appControl: WorkToolsAppControlState?
  var appControlStream = false
  var macDesktopStream = false
}

/// Which tool the Work tab's third column is showing, and whether it is up.
///
/// One model per Work root, shared by the sessions column (it collapses fully
/// while this is open, like the desktop sidebar), the chat (its chips and menu
/// open tabs here), and the destination (it lays the pane out beside the
/// thread).
@MainActor
final class DuoWorkPaneModel: ObservableObject {
  @Published private(set) var isOpen = false
  @Published private(set) var tab: DuoToolTab?
  /// The tabs the chat's chips can show, published by the chat's own poll.
  @Published private(set) var toolTabs: [DuoToolTab] = []
  /// The tabs the destination can show (PR, Git, Files, Issues, proof, chat
  /// info).
  @Published private(set) var surfaceTabs: [DuoToolTab] = []
  @Published private(set) var availableTabs: [DuoToolTab] = []
  @Published private(set) var seed = DuoToolSeed()

  /// Opens a tab. The pane appears if it was closed, and switches if it was not.
  func open(_ tab: DuoToolTab, seed: DuoToolSeed = DuoToolSeed()) {
    self.seed = seed
    if self.tab != tab { self.tab = tab }
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
    if self.tab != tab { self.tab = tab }
    if !isOpen { isOpen = true }
  }

  func close() {
    if isOpen { isOpen = false }
    if tab != nil { tab = nil }
    if seed != DuoToolSeed() { seed = DuoToolSeed() }
  }

  /// The chat reports what its chips currently offer. Chip badges do not live
  /// here — only the tab identities, so a 10 s poll that changes nothing about
  /// availability cannot re-render the pane.
  func setToolTabs(_ tabs: [DuoToolTab]) {
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

/// The third column: a native tab strip of the chat's tools over one tool.
///
/// Content is supplied by the destination, which is where the chat's PR,
/// proof artifacts and chat info actually live, so a tab reuses those views
/// with their own data instead of re-fetching anything at the pane level.
struct DuoToolsPane<Content: View>: View {
  @ObservedObject var model: DuoWorkPaneModel
  @ViewBuilder var content: (DuoToolTab, DuoToolSeed) -> Content

  var body: some View {
    VStack(spacing: 0) {
      strip
      Rectangle()
        .fill(ADEColor.glassBorder)
        .frame(height: 0.5)
        .accessibilityHidden(true)
      paneContent
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ADEColor.pageBackground)
    .accessibilityIdentifier("Duo.Work.ToolsPane")
  }

  private var strip: some View {
    HStack(spacing: 8) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(model.availableTabs) { tab in
            tabButton(tab)
          }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
      }
      .scrollBounceBehavior(.basedOnSize, axes: .horizontal)

      Button {
        ADEHaptics.light()
        model.close()
      } label: {
        WorkChatGlassCircleLabel(systemName: "xmark", size: 32, glyphSize: 12)
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Close tools")
      .accessibilityIdentifier("Duo.Work.ToolsPane.Close")
      .padding(.trailing, 10)
    }
    .frame(height: 46)
    .background(ADEColor.surfaceBackground)
  }

  private func tabButton(_ tab: DuoToolTab) -> some View {
    let selected = model.tab == tab
    return Button {
      ADEHaptics.light()
      model.select(tab)
    } label: {
      HStack(spacing: 5) {
        Image(systemName: tab.symbolName)
          .font(.system(size: 11, weight: .semibold))
        Text(tab.title)
          .font(.caption.weight(.semibold))
          .lineLimit(1)
      }
      .foregroundStyle(selected ? Color.white : ADEColor.textSecondary)
      .padding(.horizontal, 10)
      .padding(.vertical, 6)
      .background(selected ? ADEColor.accent : ADEColor.cardBackground, in: Capsule(style: .continuous))
      .overlay {
        if !selected {
          Capsule(style: .continuous)
            .strokeBorder(ADEColor.glassBorder, lineWidth: 0.5)
        }
      }
    }
    .buttonStyle(.plain)
    .accessibilityLabel(tab.title)
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("Duo.Work.ToolsPane.\(tab.rawValue)")
  }

  @ViewBuilder
  private var paneContent: some View {
    if let tab = model.tab {
      content(tab, model.seed)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    } else {
      ADEEmptyStateView(
        symbol: "sidebar.trailing",
        title: "No tool open",
        message: "Pick a tool above to keep it beside this chat."
      )
      .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
  }
}

/// The chat column and the tools pane, laid out around the fold.
///
/// Book fold: the thread takes one page and the tool the other, split on the
/// fold. Laptop/tent: the tool takes the top half and the thread (composer
/// included) the bottom. Flat: the thread keeps the width it needs and the tool
/// takes the rest. Either way the hinge gutter is its own band, so no control
/// lands on the fold.
struct DuoWorkChatPaneSplit<Chat: View, Tools: View>: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
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
    // The reader is always present and the thread always sits in the same slot,
    // so opening a tool beside the chat does not re-create the transcript (which
    // would drop the reader's place and rebuild the collection view).
    DuoLocalFoldReader { fold, size in
      layout(fold: fold, size: size)
    }
    .animation(ADEMotion.quick(reduceMotion: reduceMotion), value: isOpen)
  }

  @ViewBuilder
  private func layout(fold: DuoFold, size: CGSize) -> some View {
    if isOpen,
       case .stacked(let rect) = fold,
       rect.minY > 200,
       size.height - rect.minY > 260 {
      VStack(spacing: 0) {
        tools()
          .frame(maxWidth: .infinity)
          .frame(height: max(200, rect.minY - DuoWorkMetrics.hingeGutter / 2))
          .transition(.move(edge: .top).combined(with: .opacity))
        DuoHingeGutter(axis: .horizontal)
        chat()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
      }
    } else {
      HStack(spacing: 0) {
        chat()
          .frame(maxWidth: .infinity, maxHeight: .infinity)
        if isOpen {
          DuoHingeGutter(axis: .vertical)
          tools()
            .frame(width: DuoWorkMetrics.paneWidth(available: size.width, fold: fold))
            // The tool column slides in from the trailing edge while the
            // sessions column slides out; one animation owns both.
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
      }
    }
  }

}

/// The hinge band between two panes: a quiet gutter, never a control surface.
struct DuoHingeGutter: View {
  enum Axis {
    case vertical
    case horizontal
  }

  let axis: Axis

  var body: some View {
    ZStack {
      Rectangle()
        .fill(ADEColor.recessedBackground)
      Rectangle()
        .fill(ADEColor.glassBorder)
        .frame(
          width: axis == .vertical ? 0.5 : nil,
          height: axis == .horizontal ? 0.5 : nil
        )
    }
    .frame(
      width: axis == .vertical ? DuoWorkMetrics.hingeGutter : nil,
      height: axis == .horizontal ? DuoWorkMetrics.hingeGutter : nil
    )
    .accessibilityHidden(true)
    .allowsHitTesting(false)
  }
}
