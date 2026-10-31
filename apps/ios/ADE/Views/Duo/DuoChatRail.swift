import SwiftUI

// MARK: - The chat's rail

/// What the wide chat's toolbar needs to know about the chat: its title, and
/// the same menu model the phone's ⋯ draws, so the two can never offer
/// different things.
struct DuoChatRailModel {
  var title: String
  var subtitle: String?
  var provider: String?
  var menu: WorkChatHeaderMenuModel
  /// The session the chat actions act on.
  var session: TerminalSessionSummary?
  /// A chat (not a CLI session): Chat Info and the chat's actions exist.
  var isChat: Bool
  /// The chat's PR, for the header label when the chat has the room.
  var prBadge: WorkChatPrBadgeModel? = nil
}

/// What the wide chat's buttons fire.
struct DuoChatRailActions {
  var onToggleSidebar: (() -> Void)?
  var onChatInfo: () -> Void
  var onOpenTool: (DuoToolTab) -> Void
  var onCreatePullRequest: () -> Void
  var onOpenLane: () -> Void
  var onRename: () -> Void
  var onRestartAgent: (() -> Void)?
  var onCopySessionId: () -> Void
  var onCopySessionDeepLink: () -> Void
  var onTogglePinned: () -> Void
  var onDelete: () -> Void
  /// The CTO thread: its settings page, beside the thread. Set, the rail is
  /// the CTO's (Chat Info, CTO Settings) rather than a Work chat's.
  var onOpenCtoSettings: (() -> Void)? = nil
}

/// The wide chat's toolbar: the chat's three buckets as buttons, and nothing
/// else.
/// - **Chat Info** (desktop's chat actions drawer) opens in the pane.
/// - **Tools**: a menu of the running tools and the PR; one opens in the pane.
/// - **⋯**: the chat's actions, the Work list row's own menu.
///
/// The chat is the trailing column, so held landscape on the Duo these are the
/// top of the vertical edge bar (the app tabs keep its bottom), and the chat's
/// title is a glass capsule at the column's top-left, its PR a capsule of its
/// own beside it. Held upright and on an iPad the same declarations are the
/// top bar's trailing items, with the app tabs as one menu at the leading end.
///
/// With a pane beside the chat the top of the bar is the pane's Close, then
/// the chat's buttons that still apply as their own capsule: Tools beside
/// Chat Info, Chat Info and Tools beside a tool or the PR. No ⋯ while a pane
/// is open (the PR's actions are in its own header).
struct DuoChatRail: ViewModifier {
  @ObservedObject var pane: DuoWorkPaneModel
  @Environment(\.workCompactEdgeRail) private var compactEdgeRail
  let model: DuoChatRailModel
  /// The sessions column is away, so the chat offers the way back.
  let showsSidebarButton: Bool
  let actions: DuoChatRailActions
  @Environment(\.duoLayout) private var duo
  @Environment(\.duoWorkFamily) private var family
  @Environment(\.duoRailRetired) private var retired
  /// The column's frame (global), so the title capsule can span the chat's
  /// own top and the pane's header can start at the hinge.
  /// Horizontal extent only, in whole points: a value that moved with the
  /// bar's own layout would re-lay the bar out forever.
  @State private var columnSpan = DuoColumnSpan()
  /// The window's right edge (global), past the edge bar: its middle is the
  /// hinge the chat | pane split sits on.
  @State private var windowMaxX: CGFloat = 0
  /// The open surface's status line ("#1852 · Merged · arul28").
  @State private var paneStatus: String?

  private var columnWidth: CGFloat { columnSpan.maxX - columnSpan.minX }

  /// A pane (tool, Chat Info, PR) is open on the chat's right.
  private var paneBesideChat: Bool { pane.isOpen && family != .tall }

  /// The CTO thread: no list to go back to, so the header leads with the way
  /// back to the Hub, and the rail carries the CTO's buttons.
  private var isCto: Bool { actions.onOpenCtoSettings != nil }

  /// Held landscape with the chat alone on the right: the title capsule spans
  /// the chat's top, and the chat's PR capsule sits at its trailing end.
  private var spansColumn: Bool { duo.hasEdgeBar && !paneBesideChat && family != .tall }

  /// The header's width (title capsule, and the PR capsule when it shows):
  /// the chat's own top, leading to trailing margin. Without the edge bar it
  /// also leaves the top bar its buttons.
  private var headerWidth: CGFloat {
    // A top bar (held upright, an iPad) also carries the tabs menu, the
    // chat's buttons and, upright on the Duo, the status column: the title
    // leaves them their room, or the bar folds Tools into its overflow.
    if !duo.hasEdgeBar {
      // Measured upright on the Duo (669pt): at - 400 the bar folded Tools
      // and ⋯ into its own "More". An iPad has no status column beside the
      // bar, so its title keeps more of the width (it cut to "Bump mob…"
      // with 150pt free beside it).
      // A phone (the CTO thread, compact): the closed display's rail takes
      // the chat's buttons, so the title has the row; a plain phone's bar
      // keeps Chat Info and Settings beside it.
      if !duo.isWide {
        return max(150, columnWidth - (compactEdgeRail ? 24 : 136))
      }
      let reserved: CGFloat = duo.hasFold ? 470 : (paneBesideChat ? 330 : 270)
      return max(150, min(420, columnWidth - reserved))
    }
    let chat = paneBesideChat ? columnWidth / 2 : columnWidth
    let trailing: CGFloat = duo.hasEdgeBar || paneBesideChat ? 36 : 250
    let width = max(150, chat - trailing)
    // The bar drops a leading item wider than its slot (the column runs under
    // the rail's inset), so the spanning header keeps clear of the bar's own
    // margins.
    return spansColumn ? max(150, width - 48) : min(480, width)
  }

  func body(content: Content) -> some View {
    let titled = content
      .onGeometryChange(for: DuoColumnSpan.self) { proxy in
        let frame = proxy.frame(in: .global)
        return DuoColumnSpan(minX: frame.minX.rounded(), maxX: frame.maxX.rounded())
      } action: { span in
        if columnSpan != span { columnSpan = span }
      }
      .onPreferenceChange(DuoPaneHeaderStatusKey.self) { next in
        if paneStatus != next { paneStatus = next }
      }
      .background {
        GeometryReader { _ in
          Color.clear
            .onGeometryChange(for: CGFloat.self) { $0.frame(in: .global).maxX.rounded() } action: { maxX in
              if windowMaxX != maxX { windowMaxX = maxX }
            }
        }
        .ignoresSafeArea()
      }
      .navigationTitle(model.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(removing: .title)
    // The pane's controls (the PR's ⋯, a tool's rotate…) arrive as a
    // preference; on the edge bar the header row that shows them is the
    // bar's.
    if retired {
      titled
    } else {
      #if compiler(>=6.4)
      if #available(iOS 27.1, *) {
        titled.backgroundPreferenceValue(DuoPaneHeaderActionsKey.self) { paneActions in
          Color.clear.toolbar { rail27(paneActions: paneActions) }
        }
      } else {
        titled.toolbar { rail26 }
      }
      #else
      titled.toolbar { rail26 }
      #endif
    }
  }

  /// On the edge bar, the open pane's header row, laid from the hinge to the
  /// pane's trailing margin.
  private func paneHeader(_ actions: DuoPaneHeaderActions?) -> DuoChatHeaderCapsules.PaneHeader? {
    guard paneBesideChat, duo.hasEdgeBar, windowMaxX > 0, columnWidth > 0 else { return nil }
    // Book-folded the pane's page starts past the fold band (the root's
    // fold is in window coordinates); flat, at the hinge line.
    var chatMaxX = windowMaxX / 2
    var paneMinX = chatMaxX
    if case .sideBySide(let fold) = duo.fold {
      chatMaxX = fold.minX
      paneMinX = fold.maxX
    }
    return DuoChatHeaderCapsules.PaneHeader(
      title: pane.tab?.title,
      status: paneStatus,
      actions: actions,
      chatMaxX: chatMaxX - 16,
      minX: paneMinX + 16,
      maxX: columnSpan.maxX - 16,
      columnMinX: columnSpan.minX
    )
  }

  /// Every item is declared in every state, and only what an item shows
  /// changes: the edge bar does not take back an item that was removed and
  /// declared again (a pane closing left the rail without the chat's
  /// buttons). The groups' contents may change; the groups never go away.
  #if compiler(>=6.4)
  @available(iOS 27.1, *)
  @ToolbarContentBuilder
  private func rail27(paneActions: DuoPaneHeaderActions?) -> some ToolbarContent {
    // First, so without the edge bar (iPad, held upright) the tabs menu is the
    // screen's top-left item on Work and CTO as on every other tab, ahead of
    // the chat's title. On the edge bar it is the rail's bottom group.
    DuoAppTabsToolbar(includesUtilities: !duo.hasEdgeBar)
    ToolbarItem(placement: .topBarLeading) { header(pane: paneHeader(paneActions)) }
      .sharedBackgroundVisibility(.hidden)
      .axisBehavior(.horizontalOnly)
    ToolbarItemGroup(placement: .topBarTrailing) { closeSlot }
      .visibilityPriority(.high)
    ToolbarSpacer(.fixed, placement: .topBarTrailing)
    ToolbarItemGroup(placement: .topBarTrailing) { chatButtons }
      .visibilityPriority(.high)
  }
  #endif

  /// iOS 26: the same toolbar without the 27.1 axis and priority APIs.
  @ToolbarContentBuilder
  private var rail26: some ToolbarContent {
    DuoAppTabsToolbar()
    ToolbarItem(placement: .topBarLeading) { header(pane: nil) }
      .sharedBackgroundVisibility(.hidden)
    ToolbarItemGroup(placement: .topBarTrailing) { closeSlot }
    ToolbarSpacer(.fixed, placement: .topBarTrailing)
    ToolbarItemGroup(placement: .topBarTrailing) { chatButtons }
  }

  /// The pane's Close, alone at the top while a pane is beside the chat.
  @ViewBuilder
  private var closeSlot: some View {
    if paneBesideChat {
      paneCloseButton
    }
  }

  /// The chat's buttons: Chat Info · Tools · ⋯ with nothing open; Tools
  /// beside Chat Info; Chat Info · Tools beside a tool or the PR.
  @ViewBuilder
  private var chatButtons: some View {
    if isCto {
      ctoButtons
    } else {
      workChatButtons
    }
  }

  /// The CTO's: Chat Info and CTO Settings (each away while it is the pane),
  /// and on the edge bar a ⋯ with Activity and Settings, which the rail's
  /// bottom never carries.
  @ViewBuilder
  private var ctoButtons: some View {
    if !(paneBesideChat && pane.tab == .chatInfo) {
      chatInfoButton
        .disabled(!model.isChat)
    }
    if !(paneBesideChat && pane.tab == .ctoSettings) {
      Button {
        ADEHaptics.light()
        actions.onOpenCtoSettings?()
      } label: {
        Label("CTO Settings", systemImage: DuoToolTab.ctoSettings.symbolName)
      }
      .accessibilityIdentifier("Duo.Cto.Settings")
    }
    if !paneBesideChat && duo.hasEdgeBar {
      Menu {
        DuoAppUtilityMenuItems()
      } label: {
        Label("More", systemImage: "ellipsis")
      }
      .accessibilityIdentifier("Duo.Cto.More")
    }
  }

  @ViewBuilder
  private var workChatButtons: some View {
    // Chat Info stays in its slot while it is the pane (tinted, a second tap
    // puts it away), so the group keeps one shape whatever the pane shows.
    chatInfoButton
      .disabled(!model.isChat)
    toolsMenu
    if !paneBesideChat && model.isChat {
      actionsMenu
    }
  }

  /// The chat's title capsule (with the way back to the list at its leading
  /// end while the list is away) and, held landscape with the room, the
  /// chat's PR as a capsule of its own to its right. One item drawing its
  /// own glass, so the bar never has a leading item to add or drop.
  private func header(pane paneHeader: DuoChatHeaderCapsules.PaneHeader?) -> some View {
    DuoChatHeaderCapsules(
      model: model,
      width: headerWidth,
      fills: spansColumn,
      pane: paneHeader,
      showsSidebarButton: showsSidebarButton,
      showsHubBack: isCto,
      showsPrBadge: spansColumn,
      onToggleSidebar: {
        ADEHaptics.light()
        actions.onToggleSidebar?()
      },
      onOpenPr: {
        ADEHaptics.light()
        actions.onOpenTool(.pr)
      }
    )
  }

  private var paneCloseButton: some View {
    Button("Close \(pane.tab?.title ?? "pane")", systemImage: "xmark") {
      ADEHaptics.light()
      pane.close()
    }
    .accessibilityIdentifier("Duo.Work.ToolsPane.Close")
  }

  /// Chat info: Agents, background work, proof and sources, beside the thread.
  private var chatInfoButton: some View {
    let showing = paneBesideChat && pane.tab == .chatInfo
    return Button {
      ADEHaptics.light()
      if showing { pane.close() } else { actions.onChatInfo() }
    } label: {
      Label("Chat Info", systemImage: DuoToolTab.chatInfo.symbolName)
    }
    .tint(showing ? ADEColor.accent : nil)
    .badge(model.menu.chatInfoCount)
    .accessibilityIdentifier("Duo.Work.ChatInfo")
  }

  /// Tools: the running tools and the PR, one of which opens beside the
  /// thread.
  private var toolsMenu: some View {
    Menu {
      WorkChatToolsMenuItems(
        tools: model.menu.tools,
        hasPullRequest: model.menu.hasPullRequest,
        canCreatePullRequest: model.menu.canCreatePullRequest,
        selected: pane.isOpen ? pane.tab : nil,
        onOpen: { tab in
          if pane.isOpen, pane.tab == tab { pane.close() } else { actions.onOpenTool(tab) }
        },
        onCreatePullRequest: actions.onCreatePullRequest
      )
    } label: {
      Label("Tools", systemImage: "wrench.and.screwdriver")
    }
    .accessibilityIdentifier("Duo.Work.Tools")
  }

  /// ⋯: the chat's actions, exactly the Work list row's menu (Select aside).
  private var actionsMenu: some View {
    Menu {
      WorkChatRailActionsItems(model: model.menu, session: model.session, actions: actions)
        .equatable()
    } label: {
      Label("Chat actions", systemImage: "ellipsis")
    }
    .accessibilityIdentifier("Duo.Work.ChatActions")
  }
}

/// A column's horizontal extent in global coordinates.
struct DuoColumnSpan: Equatable {
  var minX: CGFloat = 0
  var maxX: CGFloat = 0
}

/// The wide chat's header: the title capsule, and the PR capsule beside it.
/// Each is its own glass capsule, the same height as the bar's.
struct DuoChatHeaderCapsules: View {
  /// The pane's header row, drawn on the bar's row from the hinge on.
  struct PaneHeader {
    var title: String?
    var status: String?
    var actions: DuoPaneHeaderActions?
    /// Where the chat's title capsule must end, in global coordinates.
    var chatMaxX: CGFloat
    /// Where the row starts and ends, in global coordinates.
    var minX: CGFloat
    var maxX: CGFloat
    /// The chat column's leading edge (global).
    var columnMinX: CGFloat
  }

  let model: DuoChatRailModel
  /// The whole header's width: its widest when compact, its exact width when
  /// it `fills` the column's top.
  let width: CGFloat
  let fills: Bool
  var pane: PaneHeader?
  let showsSidebarButton: Bool
  /// The ‹ project logo at the capsule's leading end: the way back to the
  /// Hub for a screen with no list column (the CTO).
  var showsHubBack = false
  let showsPrBadge: Bool
  let onToggleSidebar: () -> Void
  let onOpenPr: () -> Void

  /// Where the bar puts a leading item, from the column's leading edge
  /// (measured on the inner display). Fixed rather than read back from the
  /// item: an item sized from its own position re-laid the bar out forever.
  static let barLeadingInset: CGFloat = 20

  /// A thin floating pill: room for the title over its one-line subtitle
  /// and no more, so it reads as a label over the thread, not a bar.
  static let height: CGFloat = 38

  var body: some View {
    if let pane {
      withPaneHeader(pane)
    } else {
      capsules
    }
  }

  /// The chat's capsule on the left page, the pane's header row on the right
  /// one, as one item: the bar's row is the only place a control at this
  /// height can be tapped.
  private func withPaneHeader(_ pane: PaneHeader) -> some View {
    let origin = pane.columnMinX + Self.barLeadingInset
    let paneStart = max(0, pane.minX - origin)
    let total = max(paneStart, pane.maxX - origin)
    return HStack(spacing: 0) {
      titleCapsule
        .frame(maxWidth: max(120, pane.chatMaxX - origin), alignment: .leading)
      Spacer(minLength: 0)
      DuoPaneHeaderRow(title: pane.title, status: pane.status, actions: pane.actions)
        .frame(width: max(0, total - paneStart), height: Self.height)
    }
    .frame(width: total, alignment: .leading)
  }

  private var capsules: some View {
    GlassEffectContainer(spacing: 8) {
      // The PR capsule sits right beside the title's, never pushed to the
      // far end: the title gives way (truncates) first.
      HStack(spacing: 8) {
        titleCapsule
          .frame(maxWidth: fills ? nil : width, alignment: .leading)
        if showsPrBadge, let badge = model.prBadge {
          DuoChatPrHeaderLabel(badge: badge, action: onOpenPr)
            .layoutPriority(1)
        }
        if fills {
          Spacer(minLength: 0)
        }
      }
    }
    // A toolbar item is laid out at its ideal size: without a definite width
    // the system squeezes the title to nothing and keeps only the mark.
    .frame(width: fills ? width : nil, alignment: .leading)
    .fixedSize(horizontal: !fills, vertical: false)
  }

  private var titleCapsule: some View {
    HStack(spacing: 0) {
      if showsSidebarButton {
        Button(action: onToggleSidebar) {
          Image(systemName: "sidebar.left")
            .font(.system(size: 17, weight: .regular))
            .foregroundStyle(ADEColor.textPrimary)
            .frame(width: 44, height: Self.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show chats")
        .accessibilityIdentifier("Duo.Work.SidebarToggle")
      }
      if showsHubBack {
        DuoHubBackInCapsule()
      }
      DuoChatTitleBlock(model: model)
        .padding(.leading, showsSidebarButton || showsHubBack ? 0 : 12)
        .padding(.trailing, 14)
    }
    .frame(height: Self.height)
    .glassEffect(.regular, in: Capsule())
  }
}

/// ‹ and the project's logo inside a header capsule's leading end: back to
/// the Hub.
private struct DuoHubBackInCapsule: View {
  @ObservedObject private var syncPublishes = SyncMenuSafePublisher.shared
  private var syncService: SyncService { syncPublishes.service }

  var body: some View {
    Button {
      ADEHaptics.light()
      syncService.showProjectHub()
    } label: {
      HStack(spacing: 4) {
        Image(systemName: "chevron.left")
          .font(.system(size: 14, weight: .bold))
          .foregroundStyle(ADEColor.textSecondary)
        if let icon = projectIconImage(from: syncService.activeProject?.iconDataUrl) {
          Image(uiImage: icon).projectIconStyle(size: 22, cornerRadius: 6)
        } else {
          Image(systemName: "folder")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(width: 22, height: 22)
        }
      }
      .padding(.leading, 12)
      .padding(.trailing, 10)
      .frame(height: DuoChatHeaderCapsules.height)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Back to all projects")
    .accessibilityIdentifier("Duo.Cto.HubBack")
  }
}

/// The chat's PR in its header (desktop's header PR tag): "#1871 Open" in
/// the state's colour, with the checks glyph, as a glass capsule of its own
/// beside the title capsule. Opens the PR beside the chat.
struct DuoChatPrHeaderLabel: View {
  let badge: WorkChatPrBadgeModel
  let action: () -> Void

  private var tint: Color { lanePullRequestTint(badge.state) }

  /// "#1871" out of the badge's "MERGED #1871": the state is its own word.
  private var number: String {
    if let range = badge.label.range(of: #"#\d+"#, options: .regularExpression) {
      return String(badge.label[range])
    }
    return badge.label
  }

  private var checksGlyph: (symbol: String, color: Color)? {
    switch badge.checksStatus {
    case "passing": return ("checkmark.circle.fill", ADEColor.success)
    case "failing": return ("xmark.circle.fill", ADEColor.danger)
    case "pending": return ("clock.fill", ADEColor.warning)
    default: return nil
    }
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 6) {
        Image(systemName: "arrow.triangle.pull")
          .font(.footnote.weight(.semibold))
        Text(number)
          .font(.subheadline.weight(.semibold).monospacedDigit())
        Text(lanePrStateLabel(badge.state))
          .font(.subheadline.weight(.medium))
        if let checksGlyph {
          Image(systemName: checksGlyph.symbol)
            .font(.footnote.weight(.bold))
            .foregroundStyle(checksGlyph.color)
        }
      }
      .lineLimit(1)
      .foregroundStyle(tint)
      .padding(.horizontal, 14)
      .frame(height: DuoChatHeaderCapsules.height)
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .glassEffect(.regular.tint(tint.opacity(0.14)).interactive(), in: Capsule())
    .fixedSize()
    .accessibilityLabel("Pull request \(number), \(lanePrStateLabel(badge.state)). Opens it beside the chat.")
    .accessibilityIdentifier("Duo.Work.HeaderPr")
  }
}

/// Activity and Settings as a section of the edge bar's ⋯.
struct DuoAppUtilityMenuItems: View {
  @ObservedObject private var navigation = DuoAppNavigation.shared

  var body: some View {
    if !navigation.utilities.isEmpty {
      Section {
        ForEach(navigation.utilities) { item in
          Button {
            navigation.select(item.id)
          } label: {
            if let symbol = item.systemImage {
              Label(item.title, systemImage: symbol)
            } else {
              Label { Text(item.title) } icon: { Image(item.assetImage ?? "") }
            }
          }
          .badge(item.badge)
        }
      }
    }
  }
}

/// The rail's ⋯ items, gated on the menu model like the phone's (see
/// `WorkChatHeaderMenu`): a streaming chat re-renders constantly, and an open
/// menu rebuilt on every pass flickers and drops its submenus.
private struct WorkChatRailActionsItems: View, Equatable {
  let model: WorkChatHeaderMenuModel
  let session: TerminalSessionSummary?
  let actions: DuoChatRailActions

  static func == (lhs: Self, rhs: Self) -> Bool { lhs.model == rhs.model }

  var body: some View {
      WorkChatActionsMenuItems(
        session: session,
        model: model,
        onOpenLane: actions.onOpenLane,
        onRename: actions.onRename,
        onDelete: actions.onDelete,
        onCopySessionId: actions.onCopySessionId,
        onCopySessionDeepLink: actions.onCopySessionDeepLink,
        onTogglePinned: actions.onTogglePinned,
        onRestartAgent: actions.onRestartAgent
      )
  }
}

/// The chat's name in its header: provider mark, title, and "lane · model ·
/// machine" under it.
struct DuoChatTitleBlock: View {
  let model: DuoChatRailModel

  var body: some View {
    HStack(spacing: 10) {
      WorkProviderBareLogo(
        provider: model.provider,
        fallbackSymbol: "bubble.left.and.text.bubble.right",
        tint: providerTint(model.provider),
        size: 22
      )
      VStack(alignment: .leading, spacing: 0) {
        Text(model.title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        if let subtitle = model.subtitle, !subtitle.isEmpty {
          Text(subtitle)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
      }
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}
