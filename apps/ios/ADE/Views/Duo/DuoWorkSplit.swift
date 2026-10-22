import SwiftUI

// The Work tab on the Duo's inner display: desktop's sessions | chat, the
// chat's tools pane beside the thread, the new-chat page and the board.
//
// Two sibling navigation stacks, never one stack around both: iOS lays the
// TRAILING stack's toolbar along the curved edge as the vertical rail, and a
// stack nested inside another hands its title and items to the outer one. So
// inside the detail column's stack nothing declares toolbar items except the
// rail itself (the tools pane draws its own header row instead).

/// Fixed metrics for the wide Work layout. Kept in one place so the sessions
/// column, the chat and the tools pane agree on how much room each takes.
enum DuoWorkMetrics {
  /// The held-portrait overlay's width, and the ceiling for the flat column.
  static let listWidth: CGFloat = 340
  /// A thread narrower than this cannot hold a transcript and a composer.
  static let minChatWidth: CGFloat = 340
  /// Below this the sessions column starts collapsed, so the chat stays
  /// comfortable to read (the open display held upright).
  static let comfortableChatWidth: CGFloat = 430

  /// Column collapse and pane slides.
  static func paneMotion(reduceMotion: Bool) -> Animation? {
    reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)
  }

  /// Chat | pane side by side: one page each on a book fold, half and half
  /// flat. `trailing` is the pane's width; `fold` is the band the seam covers
  /// when the hinge is the divider.
  static func wideSplit(width: CGFloat, fold: DuoFold) -> (trailing: CGFloat, fold: CGRect?) {
    if case .sideBySide(let rect) = fold,
       rect.minX > 240,
       width - rect.maxX > 240 {
      return (width - rect.maxX, rect)
    }
    return (floor(width / 2), nil)
  }

  /// Pane over chat: exactly the top half on a laptop or tent fold, a little
  /// under half flat, so the composer's half keeps the larger share.
  static func tallSplit(height: CGFloat, fold: DuoFold) -> (top: CGFloat, fold: CGRect?) {
    if case .stacked(let rect) = fold,
       rect.minY > 200,
       height - rect.maxY > 240 {
      return (rect.minY, rect)
    }
    return (floor(height * 0.46), nil)
  }

  /// The sessions column. Book: the left page exactly, so the two pages are
  /// the list and the chat, split on the fold. Flat: about a third, so the
  /// chat dominates (Voice Memos' list column).
  static func sessionsColumn(total: CGFloat, fold: DuoFold) -> (width: CGFloat, fold: CGRect?) {
    if case .sideBySide(let rect) = fold,
       rect.minX > 260,
       total - rect.maxX > minChatWidth {
      return (rect.minX, rect)
    }
    return (min(listWidth, max(300, floor(total / 3))), nil)
  }
}

private struct DuoWorkFamilyKey: EnvironmentKey {
  static let defaultValue: DuoFamily = .compact
}

private struct DuoComposerLeadingInsetKey: EnvironmentKey {
  static let defaultValue: CGFloat = 0
}

extension EnvironmentValues {
  /// How far the chat's composer starts from the column's leading edge. Zero
  /// everywhere but a book-folded chat that spans both pages, where the
  /// composer keeps to the trailing page so no control sits on the fold.
  var duoComposerLeadingInset: CGFloat {
    get { self[DuoComposerLeadingInsetKey.self] }
    set { self[DuoComposerLeadingInsetKey.self] = newValue }
  }
}

extension EnvironmentValues {
  /// The family of the whole Work area, set once by the wide Work root. A
  /// column inside it can be narrower than it is tall while the screen is
  /// still held landscape, so columns read this rather than their own size.
  var duoWorkFamily: DuoFamily {
    get { self[DuoWorkFamilyKey.self] }
    set { self[DuoWorkFamilyKey.self] = newValue }
  }
}

/// List or Board, desktop's view switch, in the sessions column's ⋯ menu.
enum DuoWorkViewMode: String, CaseIterable, Identifiable {
  case list
  case board

  var id: String { rawValue }

  var title: String {
    switch self {
    case .list: return "List"
    case .board: return "Board"
    }
  }

  var symbolName: String {
    switch self {
    case .list: return "list.bullet"
    case .board: return "rectangle.split.3x1"
    }
  }
}

/// What the detail column says before a chat is picked: the system's own
/// unavailable view, centered in the column, and one way to start.
struct DuoWorkEmptyDetail: View {
  let canCreate: Bool
  let onNewChat: () -> Void

  var body: some View {
    ContentUnavailableView {
      Label("No Chat Selected", systemImage: "bubble.left.and.bubble.right")
    } description: {
      Text("Pick a chat from the list, or start a new one.")
    } actions: {
      Button("New Chat", action: onNewChat)
        .buttonStyle(.glassProminent)
        .tint(ADEColor.accent)
        .disabled(!canCreate)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(ADEColor.pageBackground.ignoresSafeArea())
    .accessibilityIdentifier("Duo.Work.EmptyDetail")
  }
}

/// The top of the sessions column, under its glass controls: the large title
/// with its count, then the search field (Voice Memos' and Messages' list
/// columns on the Duo).
struct DuoSessionsHeader: View {
  let title: String
  let subtitle: String
  @Binding var searchText: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      VStack(alignment: .leading, spacing: 0) {
        Text(title)
          .font(.largeTitle.weight(.bold))
          .foregroundStyle(ADEColor.textPrimary)
          .accessibilityAddTraits(.isHeader)
        Text(subtitle)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
      }
      .padding(.horizontal, 4)
      WorkInlineSearchField(text: $searchText, prompt: "Search chats, lanes, output")
        .accessibilityIdentifier("Duo.Work.Search")
    }
    .padding(.top, 2)
  }
}

/// "Show chats" at the leading top of a detail column while the sessions
/// column is away, kept horizontal next to the title rather than in the rail.
struct DuoShowSessionsItem: ViewModifier {
  let shown: Bool
  let action: () -> Void

  func body(content: Content) -> some View {
    if !shown {
      content
    } else if #available(iOS 27.1, *) {
      content.toolbar {
        ToolbarItem(placement: .topBarLeading) { button }
          .axisBehavior(.horizontalOnly)
      }
    } else {
      content.toolbar {
        ToolbarItem(placement: .topBarLeading) { button }
      }
    }
  }

  private var button: some View {
    Button("Show chats", systemImage: "sidebar.left") {
      ADEHaptics.light()
      action()
    }
    .accessibilityIdentifier("Duo.Work.SidebarToggle")
  }
}

extension WorkRootListScreen {
  /// Selecting in the column replaces the thread in place instead of pushing:
  /// the list stays where the user left it.
  func duoSelectSession(_ session: TerminalSessionSummary) {
    guard !workIsPendingChatCreationSession(session) else { return }
    if let previous = duoSelectedRoute?.sessionId, previous != session.id {
      WorkSeenStore.stamp([previous])
    }
    if duoPane.isOpen { duoPane.close() }
    duoComposeRoute = nil
    // A card tapped on the board opens the chat in the board's place, and the
    // list is what shows beside it.
    if duoViewMode == .board { duoViewModeRaw = DuoWorkViewMode.list.rawValue }
    // Held portrait, the list is an overlay over the chat; picking a row is
    // what puts it away.
    if duoWorkFamily == .tall { duoShowsSessionList = false }
    // Keeps the route the phone layout will push if the display folds, and the
    // row's selected highlight.
    selectedSessionTransitionId = session.id
    clearWokeMarkerOnVisit(session)
    ChatOpenCloseTiming.openTapped(sessionId: session.id)
    // A row from another machine opens through that machine, exactly as the
    // pushed route does.
    let remoteChat: WorkChatCrossProjectContext? = isWorkRemoteLaneId(session.laneId)
      ? syncService.remoteMachineChat(sessionId: session.id).map { remote in
        WorkChatCrossProjectContext(
          projectId: remote.projectId,
          projectRootPath: remote.rootPath.isEmpty ? nil : remote.rootPath,
          displayName: "",
          machineKey: remote.machineKey
        )
      }
      : nil
    duoSelectedRoute = WorkSessionRoute(sessionId: session.id, remoteChat: remoteChat)
    if remoteChat == nil {
      syncService.persistOpenWorkSessionRoute(sessionId: session.id)
    }
    scheduleSessionPresentationRebuild()
  }

  /// The chat was deleted (or the column was emptied): back to the empty state.
  func duoClearSelection() {
    if let sessionId = duoSelectedRoute?.sessionId {
      WorkSeenStore.stamp([sessionId])
    }
    if duoPane.isOpen { duoPane.close() }
    duoSelectedRoute = nil
    selectedSessionTransitionId = nil
    syncService.clearOpenWorkSessionRoute()
    scheduleSessionPresentationRebuild()
  }

  var duoViewMode: DuoWorkViewMode {
    DuoWorkViewMode(rawValue: duoViewModeRaw) ?? .list
  }

  /// Picking Board puts the open chat away so the board has the detail
  /// column, as desktop does; the list stays beside it either way.
  var duoViewModeBinding: Binding<DuoWorkViewMode> {
    Binding(
      get: { duoViewMode },
      set: { mode in
        withAnimation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion)) {
          duoViewModeRaw = mode.rawValue
          if mode == .board {
            duoComposeRoute = nil
            if duoSelectedRoute != nil { duoClearSelection() }
          }
        }
      }
    )
  }
}

// MARK: - Board

/// One column of desktop's kanban board.
struct DuoWorkBoardColumn: Identifiable, Equatable {
  /// `.needsYou`, `.working`, `.waiting` or `.done`.
  let filter: WorkSessionStatusFilter
  let sessions: [TerminalSessionSummary]

  var id: String { filter.rawValue }
  var title: String { filter.title }

  /// One hue, one meaning, as desktop's board: amber is your move only.
  var tint: Color {
    switch filter {
    case .needsYou: return ADEColor.warning
    case .working: return ADEColor.info
    case .done: return ADEColor.success
    default: return ADEColor.textMuted
    }
  }

  var emptyHint: String {
    switch filter {
    case .needsYou: return "Nothing is waiting on you."
    case .working: return "No agent is mid-turn."
    case .waiting: return "Nothing is snoozed, scheduled or waiting on CI."
    default: return "Nothing has finished yet."
    }
  }

  static func == (lhs: DuoWorkBoardColumn, rhs: DuoWorkBoardColumn) -> Bool {
    lhs.filter == rhs.filter && lhs.sessions.map(\.id) == rhs.sessions.map(\.id)
  }
}

/// Files rows into the board's four columns with the list's own filing rules:
/// Waiting is resolved first, then the shared phase partition. Archived rows
/// are not on the board.
func duoWorkBoardColumns(
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  archivedSessionIds: Set<String>,
  laneWaitingReasonByLaneId: [String: WorkBoardWaitingReason],
  busySubagentParentIds: Set<String>,
  now: Date = Date()
) -> (columns: [DuoWorkBoardColumn], waitingReasons: [String: WorkBoardWaitingReason]) {
  var buckets: [WorkSessionStatusFilter: [TerminalSessionSummary]] = [:]
  var reasons: [String: WorkBoardWaitingReason] = [:]
  for session in sessions where !archivedSessionIds.contains(session.id) {
    let phase = workCanonicalSessionState(
      session: session,
      summary: chatSummaries[session.id],
      now: now
    ).phase
    if let reason = workSessionWaitingReason(
      session: session,
      phase: phase,
      laneWaitingReasonByLaneId: laneWaitingReasonByLaneId,
      nextWakeAt: chatSummaries[session.id]?.nextWakeAt,
      busySubagentParentIds: busySubagentParentIds,
      now: now
    ) {
      buckets[.waiting, default: []].append(session)
      reasons[session.id] = reason
    } else {
      buckets[workStatusFilterPartition(phase: phase), default: []].append(session)
    }
  }
  let order: [WorkSessionStatusFilter] = [.needsYou, .working, .waiting, .done]
  return (order.map { DuoWorkBoardColumn(filter: $0, sessions: buckets[$0] ?? []) }, reasons)
}

/// Desktop's kanban board (`WorkKanbanBoard.tsx`): Needs you, Working,
/// Waiting, Done.
///
/// The board draws no session chrome of its own. Every card body is the list's
/// own row, handed in, so a card and a row have the same tap, menu, PR mark and
/// status; the board owns the column, the lane rail down the card and the
/// "why" line on a waiting card.
///
/// Held landscape the four columns run across (two per page on a book fold);
/// held portrait they are a two-by-two grid (one row per half on a laptop).
struct DuoWorkBoard<Card: View>: View {
  let columns: [DuoWorkBoardColumn]
  let waitingReasons: [String: WorkBoardWaitingReason]
  let laneColor: (TerminalSessionSummary) -> Color?
  @ViewBuilder let card: (TerminalSessionSummary) -> Card
  @Environment(\.duoWorkFamily) private var family

  var body: some View {
    DuoLocalFoldReader { fold, size in
      if family == .tall {
        tallGrid(fold: fold, size: size)
      } else {
        wideRow(fold: fold, size: size)
      }
    }
    .background(ADEColor.pageBackground)
    .accessibilityIdentifier("Duo.Work.Board")
  }

  @ViewBuilder
  private func wideRow(fold: DuoFold, size: CGSize) -> some View {
    if case .sideBySide(let rect) = fold, rect.minX > 240, size.width - rect.maxX > 240, columns.count == 4 {
      HStack(spacing: 0) {
        pair(columns[0], columns[1])
          .frame(width: rect.minX)
        DuoSeam(axis: .vertical, foldRect: rect)
        pair(columns[2], columns[3])
          .frame(maxWidth: .infinity)
      }
    } else if (size.width - 32 - 36) / CGFloat(max(1, columns.count)) >= Self.minColumnWidth {
      HStack(alignment: .top, spacing: 12) {
        ForEach(columns) { column in
          boardColumn(column)
        }
      }
      .padding(.horizontal, 16)
    } else {
      // Beside the sessions list the four columns do not fit at a readable
      // width: they keep it and the board scrolls sideways, a column at a time.
      // Two columns and a generous third peeking, so it reads as more to
      // scroll to rather than as a clipped card.
      let peekWidth = max(Self.minColumnWidth, floor((size.width - 16) / 2.3))
      ScrollView(.horizontal) {
        HStack(alignment: .top, spacing: 12) {
          ForEach(columns) { column in
            boardColumn(column)
              .frame(width: peekWidth)
          }
        }
        .scrollTargetLayout()
        .padding(.horizontal, 16)
      }
      .scrollTargetBehavior(.viewAligned)
      .scrollIndicators(.hidden)
      // Columns scrolled past the edge stop at the column, never under the rail.
      .clipped()
    }
  }

  /// A card narrower than this cannot hold a two-line title and its meta line.
  private static var minColumnWidth: CGFloat { 250 }

  @ViewBuilder
  private func tallGrid(fold: DuoFold, size: CGSize) -> some View {
    if columns.count == 4 {
      if case .stacked(let rect) = fold, rect.minY > 200, size.height - rect.maxY > 200 {
        VStack(spacing: 0) {
          pair(columns[0], columns[1])
            .frame(height: rect.minY)
          DuoSeam(axis: .horizontal, foldRect: rect)
          pair(columns[2], columns[3])
            .frame(maxHeight: .infinity)
        }
      } else {
        VStack(spacing: 16) {
          pair(columns[0], columns[1])
          pair(columns[2], columns[3])
        }
      }
    }
  }

  private func pair(_ first: DuoWorkBoardColumn, _ second: DuoWorkBoardColumn) -> some View {
    HStack(alignment: .top, spacing: 12) {
      boardColumn(first)
      boardColumn(second)
    }
    .padding(.horizontal, 16)
  }

  private func boardColumn(_ column: DuoWorkBoardColumn) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 7) {
        Circle()
          .fill(column.tint)
          .frame(width: 8, height: 8)
        Text(column.title)
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("\(column.sessions.count)")
          .font(.subheadline.monospacedDigit())
          .foregroundStyle(ADEColor.textSecondary)
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 4)
      .padding(.top, 8)
      .accessibilityElement(children: .combine)
      .accessibilityAddTraits(.isHeader)

      ScrollView {
        LazyVStack(spacing: 8) {
          if column.sessions.isEmpty {
            Text(column.emptyHint)
              .font(.footnote)
              .foregroundStyle(ADEColor.textMuted)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(.horizontal, 4)
              .padding(.top, 4)
          }
          ForEach(column.sessions) { session in
            boardCard(session, reason: waitingReasons[session.id])
          }
        }
        .padding(.bottom, 20)
      }
      .scrollIndicators(.hidden)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }

  private func boardCard(_ session: TerminalSessionSummary, reason: WorkBoardWaitingReason?) -> some View {
    VStack(alignment: .leading, spacing: 2) {
      if let reason {
        Label(reason.chipText, systemImage: "clock")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(ADEColor.textSecondary)
          .padding(.top, 8)
      }
      card(session)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 2)
    .background(ADEColor.cardBackground, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(alignment: .leading) {
      if let rail = laneColor(session) {
        Capsule()
          .fill(rail.opacity(0.7))
          .frame(width: 3)
          .padding(.vertical, 10)
          .padding(.leading, 4)
          .accessibilityHidden(true)
      }
    }
  }
}

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
  /// A chat (not a CLI session): Chat info and the chat's actions exist.
  var isChat: Bool
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
}

/// The wide chat's toolbar: the chat's three buckets as three buttons, and
/// nothing else.
/// - **Chat info** (desktop's chat actions drawer) opens in the pane.
/// - **Tools**: a menu of the running tools and the PR; one opens in the pane.
/// - **⋯**: the chat's actions, the Work list row's own menu.
///
/// The chat is the trailing column, so held landscape on the Duo these are the
/// top of the vertical edge bar (the app tabs keep its bottom), and the chat's
/// title is a glass capsule at the column's top-left. Held upright and on an
/// iPad the same declarations are the top bar's trailing items, with the app
/// tabs as one menu at the leading end.
struct DuoChatRail: ViewModifier {
  @ObservedObject var pane: DuoWorkPaneModel
  let model: DuoChatRailModel
  /// The sessions column is away, so the chat offers the way back.
  let showsSidebarButton: Bool
  let actions: DuoChatRailActions
  @Environment(\.duoLayout) private var duo
  @Environment(\.duoWorkFamily) private var family
  /// The column's width, so the title capsule never asks for more than the
  /// chat's share of it (an item too wide for the bar is dropped whole).
  @State private var columnWidth: CGFloat = 0

  /// A pane (tool, Chat Info, PR) is open on the chat's right. The bar's top
  /// belongs to whatever is on the right: the chat's three buttons fold into
  /// one ⋯ on its title capsule, and on the edge bar the pane's controls take
  /// their place.
  private var paneBesideChat: Bool { pane.isOpen && family != .tall }

  /// The title capsule's widest: the thread's own width (half the column
  /// while the pane is beside it), less the bar's margins. Without the edge
  /// bar the top bar also holds the three buttons and the tabs menu.
  private var titleMaxWidth: CGFloat {
    let sidebar: CGFloat = showsSidebarButton ? 52 : 0
    let chat = paneBesideChat ? columnWidth / 2 : columnWidth
    let trailing: CGFloat = duo.hasEdgeBar || paneBesideChat ? 40 : 250
    return min(420, max(150, chat - trailing - sidebar))
  }

  func body(content: Content) -> some View {
    let titled = content
      .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
        if abs(columnWidth - width) > 1 { columnWidth = width }
      }
      .navigationTitle(model.title)
      .navigationBarTitleDisplayMode(.inline)
      .toolbar(removing: .title)
    if #available(iOS 27.1, *) {
      titled
        .toolbar { rail27 }
        // The pane's controls, read from what the open tool hands its header,
        // declared as this stack's items so they land on the edge bar.
        .backgroundPreferenceValue(DuoPaneHeaderActionsKey.self) { actions in
          Color.clear.backgroundPreferenceValue(DuoPaneOverflowKey.self) { overflow in
            Color.clear.toolbar { paneBarItems(actions, overflow: overflow) }
          }
        }
    } else {
      titled.toolbar { rail26 }
    }
  }

  @available(iOS 27.1, *)
  @ToolbarContentBuilder
  private func paneBarItems(_ actions: DuoPaneHeaderActions?, overflow: DuoPaneHeaderActions?) -> some ToolbarContent {
    if paneBesideChat && duo.paneControlsInBar {
      // The tool's own controls give way to the bar's ⋯ before an app tab
      // does: the tabs are how the user leaves, and all of them stay.
      ToolbarItemGroup(placement: .topBarTrailing) {
        if let actions {
          actions.content
            .environment(\.duoPaneControlsInBar, true)
        }
      }
      ToolbarSpacer(.fixed, placement: .topBarTrailing)
      ToolbarItem(placement: .topBarTrailing) {
        Button("Close \(pane.tab?.title ?? "pane")", systemImage: "xmark") {
          ADEHaptics.light()
          pane.close()
        }
        .accessibilityIdentifier("Duo.Work.ToolsPane.Close")
      }
      .visibilityPriority(.high)
      // The bar's one ⋯: the surface's own actions, and whatever the bar
      // cannot fit joins them.
      ToolbarOverflowMenu {
        if let overflow {
          overflow.content
        }
        // Only while the sessions column (whose ⋯ has them) is away.
        if showsSidebarButton {
          DuoAppUtilityMenuItems()
        }
      }
    }
  }

  @available(iOS 27.1, *)
  @ToolbarContentBuilder
  private var rail27: some ToolbarContent {
    if showsSidebarButton {
      ToolbarItem(placement: .topBarLeading) { sidebarButton }
        .axisBehavior(.horizontalOnly)
    }
    ToolbarItem(placement: .topBarLeading) { titleCapsule }
      .axisBehavior(.horizontalOnly)
    // Without the edge bar the tabs menu also sits leading: a gap keeps it its
    // own capsule instead of joining the chat's title.
    if !duo.hasEdgeBar {
      ToolbarSpacer(.fixed, placement: .topBarLeading)
    }
    if !paneBesideChat {
      if model.isChat {
        ToolbarItem(placement: .topBarTrailing) { chatInfoButton }
          .visibilityPriority(.high)
      }
      ToolbarItem(placement: .topBarTrailing) { toolsMenu }
        .visibilityPriority(.high)
      // The chat's actions ARE the bar's overflow menu: whatever the bar
      // cannot fit (Activity and Settings on a short rail) joins them at the
      // bottom of the same ⋯, instead of the system adding a second ⋯.
      ToolbarOverflowMenu {
        if model.isChat {
          WorkChatRailActionsItems(model: model.menu, session: model.session, actions: actions)
            .equatable()
        }
        // Only while the sessions column (whose ⋯ has them) is away.
        if showsSidebarButton {
          DuoAppUtilityMenuItems()
        }
      }
    }
    // On the edge bar, Activity and Settings live in the bar's one ⋯ (below
    // the screen's own items) rather than appearing or vanishing at its bottom
    // as room allows; elsewhere the tabs menu holds them.
    DuoAppTabsToolbar(includesUtilities: !duo.hasEdgeBar)
  }

  /// The chat's title, and, while a pane holds the right side, the chat's
  /// whole phone menu (Chat Info · Tools ▸ · its actions) as a ⋯ on it.
  private var titleCapsule: some View {
    DuoChatTitleCapsule(model: model, maxWidth: titleMaxWidth - (paneBesideChat ? 36 : 0)) {
      if paneBesideChat && model.isChat {
        Menu {
          Section {
            Button {
              ADEHaptics.light()
              if chatInfoShown { pane.close() } else { actions.onChatInfo() }
            } label: {
              Label(chatInfoShown ? "Hide Chat Info" : "Chat Info", systemImage: "info.circle")
            }
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
          }
          WorkChatRailActionsItems(model: model.menu, session: model.session, actions: actions)
            .equatable()
        } label: {
          Image(systemName: "ellipsis")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(ADEColor.textPrimary)
            .frame(width: 32, height: 32)
            .background(ADEColor.textPrimary.opacity(0.06), in: Circle())
            .contentShape(Circle())
        }
        .accessibilityLabel("Chat actions")
        .accessibilityIdentifier("Duo.Work.ChatMenu")
      }
    }
  }

  /// iOS 26: the same toolbar without the 27.1 axis and priority APIs.
  @ToolbarContentBuilder
  private var rail26: some ToolbarContent {
    if showsSidebarButton {
      ToolbarItem(placement: .topBarLeading) { sidebarButton }
    }
    ToolbarItem(placement: .topBarLeading) { titleCapsule }
    ToolbarSpacer(.fixed, placement: .topBarLeading)
    ToolbarItemGroup(placement: .topBarTrailing) {
      if !paneBesideChat {
        if model.isChat { chatInfoButton }
        toolsMenu
        if model.isChat { actionsMenu }
      }
    }
    DuoAppTabsToolbar()
  }

  private var sidebarButton: some View {
    Button("Show chats", systemImage: "sidebar.left") {
      ADEHaptics.light()
      actions.onToggleSidebar?()
    }
    .accessibilityIdentifier("Duo.Work.SidebarToggle")
  }

  private var chatInfoShown: Bool { pane.isOpen && pane.tab == .chatInfo }

  /// Chat info: Agents, background work, proof and sources, beside the thread.
  private var chatInfoButton: some View {
    Button {
      ADEHaptics.light()
      if chatInfoShown { pane.close() } else { actions.onChatInfo() }
    } label: {
      Label(chatInfoShown ? "Hide Chat Info" : "Chat Info", systemImage: "info.circle")
        .symbolVariant(chatInfoShown ? .fill : .none)
    }
    .badge(model.menu.chatInfoCount)
    .accessibilityIdentifier("Duo.Work.ChatInfo")
  }

  /// Tools: the running tools and the PR, one of which opens beside the
  /// thread. The glyph fills while the pane shows a tool or the PR.
  private var toolsMenu: some View {
    let shown = pane.isOpen && (pane.tab?.isTool == true || pane.tab == .pr)
    return Menu {
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
      if shown {
        Section {
          Button("Close \(pane.tab?.title ?? "tool")", systemImage: "xmark") {
            ADEHaptics.light()
            pane.close()
          }
        }
      }
    } label: {
      Label("Tools", systemImage: "wrench.and.screwdriver")
        .symbolVariant(shown ? .fill : .none)
    }
    .accessibilityIdentifier("Duo.Work.Tools")
  }

  /// ⋯ (iOS 26): the chat's actions, exactly the Work list row's menu
  /// (Select aside).
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

/// The chat's name in the rail: provider mark, title, and "lane · model ·
/// machine" under it, as one glass capsule at the top-left of the column.
struct DuoChatTitleCapsule<Trailing: View>: View {
  let model: DuoChatRailModel
  var maxWidth: CGFloat = 360
  @ViewBuilder var trailing: () -> Trailing

  var body: some View {
    HStack(spacing: 2) {
      titleBlock
      trailing()
    }
    .fixedSize()
  }

  private var titleBlock: some View {
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
    .padding(.leading, 6)
    .padding(.trailing, 10)
    // A toolbar item is laid out at its ideal size: without this the system
    // squeezes the title to nothing and keeps only the mark.
    .frame(maxWidth: maxWidth, alignment: .leading)
    .fixedSize()
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
  }
}

#if DEBUG
/// What a `duo-*` fixture asks the wide Work layout to show. Only the fixture
/// host writes it; nothing in the product reads these outside `#if DEBUG`.
@MainActor
enum DuoWorkPreviewState {
  static var sessionId: String?
  static var tab: DuoToolTab?
  static var pr: DuoWorkPrPreview?
  /// The fixture chat's lane tools, so the pane's tools show without a machine.
  static var laneTools: WorkLaneToolsPreview?
  /// Chats whose preview tab has already been opened, so closing the pane
  /// during a screenshot session does not immediately re-open it.
  static var openedSessions: Set<String> = []
  /// Opens the new-chat page in the detail column.
  static var compose = false
  /// Starts with the sessions column collapsed.
  static var collapsed = false
  /// A quiet chat: a short transcript, no tools, no PR (no pills at all).
  static var plain = false
  /// The phone layout pushed the fixture chat already.
  static var pushedCompact = false
  /// Lays the Work area out stacked (laptop/tent) whatever the posture, for a
  /// simulator that cannot be folded that way.
  static var forceStacked = false
}

struct DuoWorkPrPreview {
  var tag: LanePrTag
  var pr: PullRequestListItem
}

/// Fixture screens for this area, routed by `DuoPreviewRouter`:
///
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-work
///
/// `duo-work` (sessions | chat), `duo-work-empty`, `duo-work-new` (new chat in
/// the column), `duo-work-board`, `duo-work-tools` (Simulator in the pane),
/// `duo-work-info` (Chat Info page in the pane), `duo-work-pr` (Pull Request
/// page), `duo-work-collapsed` (sessions collapsed, chat full width).
enum DuoWorkPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    let preset: DuoWorkPreviewPreset
    switch name {
    case "duo-work": preset = .chat
    case "duo-work-empty": preset = .empty
    case "duo-work-new": preset = .compose
    case "duo-work-board": preset = .board
    case "duo-work-tools": preset = .tools
    case "duo-work-info": preset = .info
    case "duo-work-pr": preset = .pr
    case "duo-work-collapsed": preset = .collapsed
    case "duo-work-plain": preset = .plain
    case "duo-work-stacked": preset = .stacked
    case "duo-work-stacked-tools": preset = .stackedTools
    default: return nil
    }
    return AnyView(DuoWorkPreviewHost(preset: preset))
  }
}

private enum DuoWorkPreviewPreset {
  case chat
  case empty
  case compose
  case board
  case tools
  case info
  case pr
  case collapsed
  case plain
  case stacked
  case stackedTools
}

/// Mounts the real Work root over the Work list fixtures (about three dozen
/// chats across nine lanes), so the screenshot is the real wide layout: the
/// real sessions column, the real chat destination (with a seeded transcript),
/// the real tools pane and the real rail.
private struct DuoWorkPreviewHost: View {
  @EnvironmentObject private var syncService: SyncService
  let preset: DuoWorkPreviewPreset
  @State private var seeded = false

  var body: some View {
    Group {
      if seeded {
        WorkRootScreen(isTabActive: true)
      } else {
        Color.clear
      }
    }
    .onAppear(perform: seed)
  }

  private func seed() {
    guard !seeded else { return }
    syncService.setActiveProjectForTesting(projectId: WorkListPreviewData.projectId, rootPath: nil)
    WorkRootPreviewFixture.active = WorkListPreviewData.duoFixture()
    WorkSeenStore.stamp(WorkListPreviewData.seenSessionIds)
    // The second row of the first lane, so its selected highlight is on screen.
    DuoWorkPreviewState.sessionId = "wl-primary-running"
    DuoWorkPreviewState.tab = nil
    DuoWorkPreviewState.compose = false
    DuoWorkPreviewState.collapsed = false
    DuoWorkPreviewState.plain = false
    DuoWorkPreviewState.pushedCompact = false
    DuoWorkPreviewState.forceStacked = false
    DuoWorkPreviewState.laneTools = WorkLaneToolsPreview(
      state: WorkProofPreviewData.toolChipsState,
      appleStatus: WorkProofPreviewData.toolChipsAppleStatus
    )
    DuoWorkPreviewState.pr = DuoWorkPreviewFixtures.chatPr
    // The chat's PR view is the PRs tab's own detail: give it the PRs fixture
    // as its warm cache, as if the PRs tab had loaded it.
    syncService.storePrDetailWarmEntry(PrDetailWarmEntry(
      pr: DuoWorkPreviewFixtures.chatPr.pr,
      githubItem: nil,
      snapshot: PrFlatPreviewData.snapshot(),
      reviewThreads: PrFlatPreviewData.threads,
      actionRuns: PrFlatPreviewData.actionRuns,
      activityEvents: PrFlatPreviewData.activity,
      deployments: [],
      groupMembers: [],
      capabilities: nil,
      unavailableParts: [],
      loadedAt: Date()
    ), for: DuoWorkPreviewFixtures.chatPr.pr.id)
    UserDefaults.standard.set(DuoWorkViewMode.list.rawValue, forKey: "ade.work.duo.viewMode")
    switch preset {
    case .chat:
      break
    case .empty:
      DuoWorkPreviewState.sessionId = nil
    case .compose:
      DuoWorkPreviewState.sessionId = nil
      DuoWorkPreviewState.compose = true
    case .board:
      DuoWorkPreviewState.sessionId = nil
      UserDefaults.standard.set(DuoWorkViewMode.board.rawValue, forKey: "ade.work.duo.viewMode")
    case .tools:
      DuoWorkPreviewState.tab = .simulator
    case .info:
      DuoWorkPreviewState.tab = .chatInfo
    case .pr:
      DuoWorkPreviewState.tab = .pr
    case .collapsed:
      DuoWorkPreviewState.collapsed = true
    case .stacked:
      DuoWorkPreviewState.forceStacked = true
    case .stackedTools:
      DuoWorkPreviewState.forceStacked = true
      DuoWorkPreviewState.tab = .simulator
    case .plain:
      DuoWorkPreviewState.plain = true
      DuoWorkPreviewState.laneTools = nil
      DuoWorkPreviewState.pr = nil
    }
    seeded = true
  }
}

@MainActor
private enum DuoWorkPreviewFixtures {
  private static func iso(minutesAgo: Int) -> String {
    ISO8601DateFormatter().string(from: Date().addingTimeInterval(-Double(minutesAgo) * 60))
  }

  /// The hub lane's fixture PR, shaped the way the chat's own resolver hands
  /// one to `WorkChatPrDetailsSheet`.
  static let chatPr = DuoWorkPrPreview(
    tag: LanePrTag(
      source: .ade,
      prId: "wl-pr-hub",
      githubPrNumber: 1304,
      githubUrl: "https://github.com/arul/ade/pull/1304",
      title: "Work tab header in one row",
      state: "open",
      headBranch: "ade/mobile-work-hub",
      updatedAt: iso(minutesAgo: 10)
    ),
    pr: PullRequestListItem(
      id: "wl-pr-hub",
      laneId: WorkListPreviewData.hub.id,
      laneName: WorkListPreviewData.hub.name,
      projectId: WorkListPreviewData.projectId,
      repoOwner: "arul",
      repoName: "ade",
      githubPrNumber: 1304,
      githubUrl: "https://github.com/arul/ade/pull/1304",
      title: "Work tab header in one row",
      state: "open",
      baseBranch: "main",
      headBranch: "ade/mobile-work-hub",
      checksStatus: "pending",
      reviewStatus: "none",
      additions: 212,
      deletions: 64,
      lastSyncedAt: nil,
      createdAt: iso(minutesAgo: 60 * 24),
      updatedAt: iso(minutesAgo: 10),
      adeKind: "single",
      linkedGroupId: nil,
      linkedGroupType: nil,
      linkedGroupName: nil,
      linkedGroupPosition: nil,
      linkedGroupCount: 0,
      workflowDisplayState: nil,
      cleanupState: nil
    )
  )
}
#endif
