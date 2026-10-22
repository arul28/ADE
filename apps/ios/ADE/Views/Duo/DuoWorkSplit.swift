import SwiftUI

// The Work tab on the Duo's inner display (DESIGN.md §3): desktop's
// sessions | chat | tools and its kanban board.
//
// Every column is its own navigation stack, side by side, never one stack
// around all of them: the trailing column's toolbar is what iOS lays along the
// curved edge as the vertical bar, and a stack nested inside another would
// hand its toolbar to the outer one.

/// Fixed metrics for the wide Work layout. Kept in one place so the sessions
/// column, the chat and the tools pane agree on how much room each takes.
enum DuoWorkMetrics {
  /// The sessions column on a flat display.
  static let listWidth: CGFloat = 320
  /// A thread narrower than this cannot hold a transcript and a composer.
  static let minChatWidth: CGFloat = 340

  /// Column collapse and pane slides (DESIGN.md §1).
  static func paneMotion(reduceMotion: Bool) -> Animation? {
    reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)
  }

  /// Chat | tool side by side: one page each on a book fold, half and half
  /// flat. `trailing` is the tool column's width; `fold` is the band the seam
  /// covers when the hinge is the divider.
  static func wideSplit(width: CGFloat, fold: DuoFold) -> (trailing: CGFloat, fold: CGRect?) {
    if case .sideBySide(let rect) = fold,
       rect.minX > 240,
       width - rect.maxX > 240 {
      return (width - rect.maxX, rect)
    }
    return (floor(width / 2), nil)
  }

  /// Tool over chat: exactly the top half on a laptop or tent fold, a little
  /// under half flat, so the composer's half keeps the larger share.
  static func tallSplit(height: CGFloat, fold: DuoFold) -> (top: CGFloat, fold: CGRect?) {
    if case .stacked(let rect) = fold,
       rect.minY > 200,
       height - rect.maxY > 240 {
      return (rect.minY, rect)
    }
    return (floor(height * 0.46), nil)
  }

  /// The sessions column: the leading page on a book fold, so nothing (the
  /// composer included) sits on the fold; 320 otherwise.
  static func sessionsColumn(total: CGFloat, fold: DuoFold) -> (width: CGFloat, fold: CGRect?) {
    if case .sideBySide(let rect) = fold,
       rect.minX > 260,
       total - rect.maxX > minChatWidth {
      return (rect.minX, rect)
    }
    return (min(listWidth, max(260, total * 0.36)), nil)
  }
}

private struct DuoWorkFamilyKey: EnvironmentKey {
  static let defaultValue: DuoFamily = .compact
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

/// List or Board, desktop's view switch for the sessions area.
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

/// What the chat column says before a chat is picked.
struct DuoWorkEmptyDetail: View {
  var body: some View {
    ADEEmptyStateView(
      symbol: "bubble.left.and.bubble.right",
      title: "Choose a chat",
      message: "Pick a chat from the list. Its thread opens here, and its tools open beside it."
    )
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .adeScreenBackground()
    .toolbar(.hidden, for: .navigationBar)
    .accessibilityIdentifier("Duo.Work.EmptyDetail")
  }
}

extension WorkRootListScreen {
  /// Selecting in the column replaces the thread in place instead of pushing:
  /// the list stays where the user left it, and the split's sidebar toggle
  /// hides the list rather than popping a stack.
  func duoSelectSession(_ session: TerminalSessionSummary) {
    guard !workIsPendingChatCreationSession(session) else { return }
    if let previous = duoSelectedRoute?.sessionId, previous != session.id {
      WorkSeenStore.stamp([previous])
    }
    if duoPane.isOpen { duoPane.close() }
    // A card tapped on the board opens the chat beside the list, desktop's
    // board-to-list hand-off.
    if duoViewMode == .board { duoViewModeRaw = DuoWorkViewMode.list.rawValue }
    // Held portrait, the list is an overlay over the chat; picking a row is
    // what puts it away.
    if duoWorkFamily == .tall { duoShowsSessionList = false }
    // Keeps the route the phone layout will push if the display folds, and the
    // matched-geometry transition's source id.
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

  /// The chat was deleted (or the column was emptied): back to the list.
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

  /// Picking Board puts the chat away so the board has the area, as desktop
  /// does; picking List brings the list back.
  var duoViewModeBinding: Binding<DuoWorkViewMode> {
    Binding(
      get: { duoViewMode },
      set: { mode in
        withAnimation(DuoWorkMetrics.paneMotion(reduceMotion: reduceMotion)) {
          duoViewModeRaw = mode.rawValue
          if mode == .board {
            if duoSelectedRoute != nil { duoClearSelection() }
          } else {
            duoShowsSessionList = true
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
    } else {
      HStack(alignment: .top, spacing: 12) {
        ForEach(columns) { column in
          boardColumn(column)
        }
      }
      .padding(.horizontal, 16)
    }
  }

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

#if DEBUG
/// What a `duo-*` fixture asks the wide Work layout to show. Only the fixture
/// host writes it; nothing in the product reads these outside `#if DEBUG`.
@MainActor
enum DuoWorkPreviewState {
  static var sessionId: String?
  static var tab: DuoToolTab?
  static var pr: DuoWorkPrPreview?
  /// The fixture chat's lane tools, so its chips (and the pane's live tabs)
  /// show without a machine.
  static var laneTools: WorkLaneToolsPreview?
  /// Chats whose preview tab has already been opened, so closing the pane
  /// during a screenshot session does not immediately re-open it.
  static var openedSessions: Set<String> = []
  /// The board fixture: no chat is opened for it.
  static var board = false
}

struct DuoWorkPrPreview {
  var tag: LanePrTag
  var pr: PullRequestListItem
}

/// Fixture screens for this area, routed by `DuoPreviewRouter`:
///
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-work
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-work-board
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-work-tools
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-work-pr
///     xcrun simctl launch <udid> com.ade.ios -adePreviewScreen duo-work-agents
enum DuoWorkPreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-work":
      return AnyView(DuoWorkPreviewHost(preset: .chat))
    case "duo-work-board":
      return AnyView(DuoWorkPreviewHost(preset: .board))
    case "duo-work-tools":
      return AnyView(DuoWorkPreviewHost(preset: .tools))
    case "duo-work-pr":
      return AnyView(DuoWorkPreviewHost(preset: .pr))
    case "duo-work-agents":
      return AnyView(DuoWorkPreviewHost(preset: .agents))
    default:
      return nil
    }
  }
}

private enum DuoWorkPreviewPreset {
  case chat
  case board
  case tools
  case pr
  case agents
}

/// Mounts the real Work root over the Work list fixtures, so the screenshot is
/// the real wide layout: the real sessions column, the real chat destination
/// (with a seeded transcript) and the real tools pane.
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
    WorkRootPreviewFixture.active = WorkListPreviewData.fixture()
    WorkSeenStore.stamp(WorkListPreviewData.seenSessionIds)
    DuoWorkPreviewState.sessionId = WorkListPreviewData.parentChatId
    DuoWorkPreviewState.board = false
    DuoWorkPreviewState.laneTools = WorkLaneToolsPreview(
      state: WorkProofPreviewData.toolChipsState,
      appleStatus: WorkProofPreviewData.toolChipsAppleStatus
    )
    UserDefaults.standard.set(DuoWorkViewMode.list.rawValue, forKey: "ade.work.duo.viewMode")
    switch preset {
    case .chat:
      DuoWorkPreviewState.tab = nil
    case .board:
      DuoWorkPreviewState.tab = nil
      DuoWorkPreviewState.sessionId = nil
      DuoWorkPreviewState.board = true
      UserDefaults.standard.set(DuoWorkViewMode.board.rawValue, forKey: "ade.work.duo.viewMode")
    case .tools:
      DuoWorkPreviewState.tab = .simulator
    case .pr:
      DuoWorkPreviewState.tab = .pr
      DuoWorkPreviewState.pr = DuoWorkPreviewFixtures.chatPr
    case .agents:
      DuoWorkPreviewState.tab = .agents
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
