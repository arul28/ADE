import SwiftUI

// The Hub (Home) on the Duo's inner display, and the pieces it shares with
// the phone's Hub.
//
//   Projects (left page / top half)   status filters · agent list · composer
//   ---------------------------------------------------------------------
//   the same project grid             the chats in one status across every
//                                     project; Activity takes this page over
//
// The pages are the components the phone draws — `HubProjectTile`,
// `HubInlineComposer`, `HubToolbar` — so a project or a chat row means the
// same thing in either posture. Nothing here fetches: the agent list reads
// the presentations the Hub already built, and the rail's Machines menu the
// fleet the connection menu already shows.

// MARK: - Needs you

/// One roster row filed under Needs you, with the project and lane it belongs
/// to so a tap can open it the ordinary Hub way.
struct DuoNeedsYouItem: Identifiable, Equatable {
  let project: MobileProjectSummary
  let lane: RemoteRosterLane?
  let row: HubChatRowPresentation
  /// The agent asked for a person while its turn was still its own: the board
  /// keeps it in Working, so the overview marks it itself.
  var handRaised = false

  var id: String { row.id }

  /// The mark and the word the row draws. A hand-raise borrows the Needs you
  /// column's colour and glyph so the section reads as one list.
  var boardState: HubChatBoardState {
    handRaised
      ? HubChatBoardState(column: .needsYou, failed: false, waitingReason: nil)
      : row.boardState
  }

  var stateLabel: String? {
    handRaised ? "Hand-raised" : row.boardState.label
  }
}

/// Every row the board rules already filed under Needs you, plus a chat whose
/// agent raised its hand, newest first with failures ahead of the rest. Pure: it
/// reads the Hub's presentations, so the overview can never claim something the
/// project cards below/left do not show, and it adds no request of its own.
func duoNeedsYouItems(from presentations: [HubProjectPresentation]) -> [DuoNeedsYouItem] {
  var items: [DuoNeedsYouItem] = []
  for presentation in presentations {
    for lane in presentation.lanes {
      for row in lane.rows {
        let isNeedsYou = row.boardState.column == .needsYou
        let handRaised = !isNeedsYou
          && !(row.chat.attentionRequestedAt ?? "").isEmpty
        guard isNeedsYou || handRaised else { continue }
        items.append(
          DuoNeedsYouItem(
            project: presentation.project,
            lane: lane.lane,
            row: row,
            handRaised: handRaised
          )
        )
      }
    }
  }
  return items.sorted { lhs, rhs in
    if lhs.row.boardState.failed != rhs.row.boardState.failed {
      return lhs.row.boardState.failed
    }
    if lhs.handRaised != rhs.handRaised {
      return !lhs.handRaised
    }
    let left = lhs.row.chat.lastActivityAt ?? ""
    let right = rhs.row.chat.lastActivityAt ?? ""
    if left != right { return left > right }
    return lhs.row.title.localizedCaseInsensitiveCompare(rhs.row.title) == .orderedAscending
  }
}

/// The chats the Hub's agent list shows for one status, across every
/// project: Needs you is `duoNeedsYouItems` (hand-raises included); every
/// other status is the rows the board files there (All is every row), most
/// recent first. Pure, over the presentations the Hub already built.
func duoAgentItems(from presentations: [HubProjectPresentation], filter: HubRosterFilter) -> [DuoNeedsYouItem] {
  if filter == .needsYou { return duoNeedsYouItems(from: presentations) }
  var items: [DuoNeedsYouItem] = []
  for presentation in presentations {
    for lane in presentation.lanes {
      for row in lane.rows where hubRosterFilterContains(row.boardState.column, filter) {
        items.append(DuoNeedsYouItem(project: presentation.project, lane: lane.lane, row: row))
      }
    }
  }
  return items.sorted { lhs, rhs in
    let left = lhs.row.chat.lastActivityAt ?? ""
    let right = rhs.row.chat.lastActivityAt ?? ""
    if left != right { return left > right }
    return lhs.row.title.localizedCaseInsensitiveCompare(rhs.row.title) == .orderedAscending
  }
}

// MARK: - Machines

/// One machine in the overview: the focused machine the pill names, then every
/// other paired machine the fleet keeps a roster connection to.
struct DuoHomeMachine: Identifiable, Equatable {
  let id: String
  let name: String
  var statusWord: String
  var tone: ADEKitTone
  var isFocused = false
  var projectCount = 0
  var workingCount = 0
  /// Attached right now: the focused machine connected, a fleet machine live.
  /// What the rail's Machines button counts.
  var isLive = false

  /// "Connected · 3 projects · 2 working"
  var summary: String {
    var clauses = [statusWord]
    if projectCount > 0 {
      clauses.append("\(projectCount) project\(projectCount == 1 ? "" : "s")")
    }
    if workingCount > 0 {
      clauses.append("\(workingCount) working")
    }
    return clauses.joined(separator: " · ")
  }
}

/// The machines the connection pill's menu lists, as overview rows. Reads the
/// same two sources the pill does (`SyncService`'s primary connection and the
/// fleet) — no separate machine fetch.
@MainActor
func duoHomeMachines(syncService: SyncService, fleet: MachineFleet) -> [DuoHomeMachine] {
  let health = syncService.connectionHealth
  var rows = [
    DuoHomeMachine(
      id: "duo-primary-machine",
      name: syncService.focusedMachineDisplayName,
      statusWord: duoMachineTransportWord(health.transport),
      tone: duoMachineTransportTone(health),
      isFocused: true,
      projectCount: syncService.projects.count,
      workingCount: syncService.runningChatSessionCount,
      isLive: health.transport == .connected
    )
  ]
  for machine in fleet.machines {
    let working = machine.projects.reduce(0) { partial, project in
      partial + project.chats.filter(\.countsTowardRunning).count
    }
    rows.append(
      DuoHomeMachine(
        id: machine.machineKey,
        name: machine.name,
        statusWord: duoMachineFleetStateWord(machine.state),
        tone: duoMachineFleetStateTone(machine.state),
        projectCount: machine.projects.count,
        workingCount: working,
        isLive: machine.state == .live
      )
    )
  }
  return rows
}

private func duoMachineTransportWord(_ transport: SyncTransportHealth) -> String {
  switch transport {
  case .connected: return "Connected"
  case .connecting: return "Connecting…"
  case .unreachable: return "Unreachable"
  case .disconnected: return "Offline"
  }
}

private func duoMachineTransportTone(_ health: SyncConnectionHealth) -> ADEKitTone {
  switch health.transport {
  case .connected: return health.load == .strained ? .warn : .ok
  case .connecting: return .warn
  case .unreachable: return .crit
  case .disconnected: return .neutral
  }
}

private func duoMachineFleetStateWord(_ state: MachineFleet.MachineState) -> String {
  switch state {
  case .live: return "Live"
  case .connecting: return "Connecting"
  case .offline: return "Offline"
  case .paused: return "Paused"
  case .inactive: return "Inactive"
  case .needsUpdate: return "Needs update"
  case .needsAttention: return "Needs attention"
  }
}

private func duoMachineFleetStateTone(_ state: MachineFleet.MachineState) -> ADEKitTone {
  switch state {
  case .live: return .ok
  case .connecting, .needsUpdate: return .warn
  case .offline, .needsAttention: return .crit
  case .paused, .inactive: return .neutral
  }
}

// MARK: - The wide Home

/// The all-projects Hub on the inner display (and an iPad).
///
/// Two pages, each its own navigation stack, whenever the screen is flat or
/// book-folded, held either way: every project on the left, and on the right
/// the agents across all of them — the five status filters (with counts, in
/// each status's colour) over the list of chats in the chosen status, Needs
/// you first, then the composer at the very bottom. The filters choose what
/// the agent list shows; the project list always shows every project.
///
/// - Held landscape the right page's toolbar is the edge bar: the account's
///   picture, Activity and Chats at the top; Machines and Settings at the
///   bottom, beside the composer, whose bottom lines up with the bar's. The
///   projects page's header is the ADE mark and Add.
/// - Held upright, or on an iPad, there is no edge bar: the projects page's
///   top bar holds the connection title (its menu lists the machines),
///   Activity, Chats and Add; the right page's bar holds the account.
/// - Folded laptop or tent it is one stack: the projects on the top half, the
///   agents and the composer on the bottom half.
///
/// The Hub is above every project: it never shows the app tabs. Nothing
/// scrolls the right page (or the bottom half) but the agent list itself.
struct DuoHomeWide<Title: View, Projects: View, Composer: View, ChatsDestination: View>: View {
  let machines: [DuoHomeMachine]
  /// The Hub's project presentations, which the agent list files by status.
  let presentations: [HubProjectPresentation]
  let actions: HubToolbarActions
  let account: AccountIdentity?
  /// Whether there is anything to list yet: the machine is attached, or the
  /// Hub still holds its last roster. Otherwise the page says it is
  /// connecting rather than "nothing needs you".
  var showsOverview = true
  let onOpenAgent: (DuoNeedsYouItem) -> Void
  /// Pushes the Chats list on the projects page.
  @Binding var chatsPresented: Bool
  /// The agent list's status. Needs you until the user picks another.
  var initialAgentFilter: HubRosterFilter = .needsYou

  @ViewBuilder var title: () -> Title
  @ViewBuilder var projects: () -> Projects
  @ViewBuilder var composer: () -> Composer
  @ViewBuilder var chatsDestination: () -> ChatsDestination

  @Environment(\.duoLayout) private var duo
  @EnvironmentObject private var syncService: SyncService
  @State private var agentFilter: HubRosterFilter?
  /// The projects page's width, so its title can make room for Activity,
  /// Chats and Add where they share its bar.
  @State private var projectsPageWidth: CGFloat = 0

  private var filter: HubRosterFilter { agentFilter ?? initialAgentFilter }

  private var filterBinding: Binding<HubRosterFilter> {
    Binding(get: { filter }, set: { agentFilter = $0 })
  }

  var body: some View {
    Group {
      if duo.fold.isStacked {
        stackedLayout
      } else {
        pagesLayout
      }
    }
    .background(ADEColor.pageBackground.ignoresSafeArea())
  }

  // MARK: Two pages

  /// Chats replaces both pages with its own two columns (the list and the
  /// chat, like Work); its Home button comes back here.
  @ViewBuilder
  private var pagesLayout: some View {
    Group {
      if chatsPresented {
        DuoPersonalChatsWindow(onClose: { chatsPresented = false })
      } else {
        projectPages
      }
    }
    // The right page shows Activity itself, so the app-wide Activity column
    // (or sheet) stays away while these pages are up.
    .onAppear { DuoShellChrome.shared.setHubHostsActivity(true) }
    .onDisappear { DuoShellChrome.shared.setHubHostsActivity(false) }
  }

  private var projectPages: some View {
    DuoTwoPages(flatShare: 0.54, sideBySideWhenUpright: true) {
      NavigationStack {
        projects()
          .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
          // The left page ends at the seam; the trailing inset iOS reports
          // here is the edge bar's (and, folded, the hinge's), not this page's.
          .duoLeadingColumnContent()
          .background(ADEColor.pageBackground.ignoresSafeArea())
          .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { projectsPageWidth = $0 }
          .navigationBarTitleDisplayMode(.inline)
          .toolbar {
            if duo.hasEdgeBar {
              // The machines live in the rail now, so the header is just the
              // brand: a mark, not a button.
              ToolbarItem(placement: .topBarLeading) { brandMark }
                .sharedBackgroundVisibility(.hidden)
            } else {
              ToolbarItem(placement: .topBarLeading) {
                title()
                  .environment(\.hubConnectionTitleCompact, projectsPageWidth < 440)
              }
              HubToolbar(form: .pageBar, actions: actions, account: account)
              ToolbarSpacer(.fixed, placement: .topBarTrailing)
            }
            ToolbarItem(placement: .topBarTrailing) { addButton }
          }
      }
    } second: {
      if syncService.attentionDrawerPresented {
        // Activity takes the right page; the projects page stays as it is.
        // Its own stack, so its close and filter are this page's rail.
        ActivityDrawerSheet(onCloseInspector: { syncService.attentionDrawerPresented = false })
          .environmentObject(syncService.attentionDrawer)
      } else {
        agentsStack
      }
    }
  }

  private var agentsStack: some View {
      NavigationStack {
        agentsPage
          .duoEdgeBarAlignedBottom(contentBottomPadding: HubInlineComposer.bottomPadding)
          .background(ADEColor.pageBackground.ignoresSafeArea())
          .toolbar {
            if duo.hasEdgeBar {
              HubToolbar(form: .rail, actions: actions, account: account, machines: machines)
            } else if let account {
              // Held upright this bar sits beside the status bar, with room
              // for one item: the account. Activity and Chats are on the
              // projects page's bar.
              ToolbarItem(placement: .topBarTrailing) {
                HubAccountButton(identity: account, action: actions.onOpenSettings)
              }
              .sharedBackgroundVisibility(.hidden)
            }
          }
      }
  }

  // MARK: Laptop / tent

  private var stackedLayout: some View {
    NavigationStack {
      DuoLocalFoldReader { localFold, localSize in
        let top: CGFloat = {
          if case .stacked(let rect) = localFold { return max(0, min(rect.minY, localSize.height)) }
          return floor(localSize.height * 0.5)
        }()
        VStack(spacing: 0) {
          projects()
            .frame(height: top)
            .frame(maxWidth: .infinity)
          if case .stacked(let rect) = localFold {
            DuoSeam(axis: .horizontal, foldRect: rect)
          } else {
            DuoSeam(axis: .horizontal)
          }
          agentsPage
            .padding(.top, 12)
            .frame(maxHeight: .infinity)
        }
      }
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) { title() }
        HubToolbar(form: .bar, actions: actions, account: account)
      }
      .navigationDestination(isPresented: $chatsPresented) { chatsDestination() }
    }
  }

  // MARK: Pieces

  /// The filters over the agent list over the composer. The filter row is the
  /// page's first thing, level with the projects page's header row.
  private var agentsPage: some View {
    let counts = Dictionary(uniqueKeysWithValues: HubRosterFilter.allCases.map { option in
      (option, duoAgentItems(from: presentations, filter: option).count)
    })
    return VStack(spacing: 0) {
      if showsOverview {
        HubRosterFilterBar(
          counts: counts,
          selection: filterBinding,
          accessibilityTitle: "Agent filters",
          accessibilityHintText: "Shows matching chats from every project in the list below."
        )
        .padding(.horizontal, 16)
        DuoAgentList(
          filter: filter,
          items: duoAgentItems(from: presentations, filter: filter),
          onOpen: onOpenAgent
        )
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 12)
      } else {
        HubConnectingCard()
          .frame(maxHeight: .infinity)
      }
      composer()
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var brandMark: some View {
    Image("BrandMark")
      .resizable()
      .renderingMode(.original)
      .interpolation(.high)
      .aspectRatio(contentMode: .fit)
      .frame(width: 44, height: 24)
      .padding(.horizontal, 4)
      .accessibilityLabel("ADE")
      .accessibilityAddTraits(.isHeader)
  }

  /// Add relates to the project list, so it is that page's one action.
  private var addButton: some View {
    Button(action: actions.onAdd) {
      Label("Add project", systemImage: "plus")
    }
    .tint(ADEColor.textPrimary)
    .accessibilityHint("Adds a project from one of your machines.")
  }
}

// MARK: - Chats window

/// Chats on the inner display (and an iPad): the Work tab's shape for the
/// conversations that belong to no project. The chat list (with search) on
/// the left, the picked chat on the right with its actions on the rail, and
/// "Pick a chat" until one is. Home returns to the Hub. A phone keeps the
/// pushed list it has always had.
struct DuoPersonalChatsWindow: View {
  let onClose: () -> Void

  private struct Selection: Equatable {
    let summary: AgentChatSessionSummary
    let machineKey: String?
    var id: String { "\(machineKey ?? "focused")|\(summary.sessionId)" }
    static func == (lhs: Selection, rhs: Selection) -> Bool { lhs.id == rhs.id }
  }

  @State private var selection: Selection?
  @State private var listShown = true

  var body: some View {
    Group {
      if listShown {
        DuoTwoPages(flatShare: 0.38, sideBySideWhenUpright: true) {
          NavigationStack {
            PersonalChatsScreen(
              onSelect: { summary, machineKey in
                selection = Selection(summary: summary, machineKey: machineKey)
              },
              selectedSessionId: selection?.summary.sessionId
            )
            .duoLeadingColumnContent()
            .toolbar {
              ToolbarItem(placement: .topBarLeading) {
                Button(action: onClose) {
                  Label("Home", systemImage: "chevron.backward")
                }
                .accessibilityHint("Returns to all projects.")
              }
            }
          }
        } second: {
          detail
        }
      } else {
        detail
      }
    }
  }

  private var detail: some View {
    NavigationStack {
      if let selection {
        WorkSessionDestinationView(
          sessionId: selection.summary.sessionId,
          initialOpeningPrompt: nil,
          initialSession: makePersonalChatSessionStub(selection.summary),
          initialChatSummary: selection.summary,
          transitionNamespace: nil,
          isLive: selection.summary.archivedAt == nil,
          navigationChrome: .column,
          showsLaneActions: false,
          navigationTitleOverride: selection.summary.title,
          lanes: [],
          personalChat: true,
          personalChatMachineKey: selection.machineKey,
          duoShowsSidebar: listShown,
          onDuoToggleSidebar: { withAnimation(.snappy(duration: 0.25)) { listShown.toggle() } },
          onDuoBack: { self.selection = nil }
        )
        .id(selection.id)
      } else {
        ContentUnavailableView(
          "Pick a chat",
          systemImage: "bubble.left.and.bubble.right",
          description: Text("Chats here aren’t tied to a project.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(ADEColor.pageBackground.ignoresSafeArea())
      }
    }
  }
}

// MARK: - Agent list

/// The chats in one status across every project, as one card that fills the
/// room it is given and scrolls inside itself (a soft fade at the bottom while
/// more rows wait below). The filter row above names the status and its
/// count, so the card has no header of its own.
struct DuoAgentList: View {
  let filter: HubRosterFilter
  let items: [DuoNeedsYouItem]
  let onOpen: (DuoNeedsYouItem) -> Void

  var body: some View {
    Group {
      if items.isEmpty {
        DuoHomeWidgetEmptyState(
          symbol: filter == .needsYou ? "checkmark.circle" : filter.systemImage,
          title: filter.emptyTitle,
          message: filter.emptyMessage,
          tint: filter == .needsYou ? ADEColor.success : (filter.tone.map(activityToneColor) ?? ADEColor.textMuted)
        )
      } else {
        DuoWidgetList {
          LazyVStack(spacing: 0) {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
              DuoWidgetChatRow(item: item) { onOpen(item) }
              if index < items.count - 1 {
                Divider().padding(.leading, DuoWidgetRowMetrics.textInset)
              }
            }
          }
          .padding(.top, 6)
        }
        // A new status starts at its top.
        .id(filter)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(ADEColor.cardBackground)
    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
  }
}

/// A widget's scrolling body. While rows continue below the card's edge the
/// last visible one fades out instead of being cut mid-line; at the end of
/// the list (or when everything fits) nothing fades.
struct DuoWidgetList<Content: View>: View {
  @ViewBuilder var content: () -> Content
  @State private var hasMoreBelow = false

  var body: some View {
    ScrollView {
      content()
        .padding(.bottom, 6)
    }
    .scrollBounceBehavior(.basedOnSize)
    .scrollIndicators(.hidden)
    .onScrollGeometryChange(for: Bool.self) { geometry in
      geometry.contentOffset.y + geometry.containerSize.height < geometry.contentSize.height - 8
    } action: { _, more in
      hasMoreBelow = more
    }
    .mask {
      VStack(spacing: 0) {
        Rectangle()
        LinearGradient(
          colors: [.black, .black.opacity(hasMoreBelow ? 0 : 1)],
          startPoint: .top,
          endPoint: .bottom
        )
        .frame(height: 36)
      }
    }
  }
}

/// A widget with nothing to list: one calm line, centered in the card.
struct DuoHomeWidgetEmptyState: View {
  let symbol: String
  let title: String
  let message: String
  var tint: Color = ADEColor.success

  var body: some View {
    VStack(spacing: 6) {
      Image(systemName: symbol)
        .font(.title2)
        .foregroundStyle(tint)
      Text(title)
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text(message)
        .font(.footnote)
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
    }
    .padding(.horizontal, 20)
    .padding(.bottom, 20)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Two pages

/// The Duo's page grammar for a screen with two parts: side by side held
/// landscape, stacked held portrait. A fold makes each part exactly one page;
/// flat, the parts split the screen evenly with a hairline seam.
struct DuoTwoPages<First: View, Second: View>: View {
  enum Arrangement {
    /// Side by side when wider than tall, stacked otherwise.
    case automatic
  }

  var fold: Arrangement = .automatic
  /// The share the first part takes when the screen is flat, 0…1.
  var flatShare: CGFloat = 0.5
  /// Keep the parts side by side when the screen is taller than wide, as long
  /// as it is not folded laptop or tent: upright and flat, the inner display
  /// (or an iPad) is the same two columns, just narrower.
  var sideBySideWhenUpright = false
  @ViewBuilder var first: () -> First
  @ViewBuilder var second: () -> Second

  var body: some View {
    DuoLocalFoldReader { fold, size in
      let sideBySide = size.width > size.height || (sideBySideWhenUpright && !fold.isStacked)
      switch fold {
      case .sideBySide(let rect) where sideBySide:
        let lead = max(0, min(rect.minX, size.width))
        HStack(spacing: 0) {
          first().frame(width: lead)
          DuoSeam(axis: .vertical, foldRect: rect)
            .ignoresSafeArea()
          second().frame(maxWidth: .infinity)
        }
      case .stacked(let rect) where !sideBySide:
        let top = max(0, min(rect.minY, size.height))
        VStack(spacing: 0) {
          first().frame(height: top)
          DuoSeam(axis: .horizontal, foldRect: rect)
            .ignoresSafeArea()
          second().frame(maxHeight: .infinity)
        }
      default:
        if sideBySide {
          HStack(spacing: 0) {
            first().frame(width: floor(size.width * flatShare))
            DuoSeam(axis: .vertical)
              .ignoresSafeArea()
            second().frame(maxWidth: .infinity)
          }
        } else {
          VStack(spacing: 0) {
            first().frame(height: floor(size.height * flatShare))
            DuoSeam(axis: .horizontal)
              .ignoresSafeArea()
            second().frame(maxHeight: .infinity)
          }
        }
      }
    }
  }
}

// MARK: - Overview list pieces (the CTO overview uses these too)

/// A section header in the overview's inset-grouped lists: the title, its
/// count, and one trailing text action, the way Apple's own lists do it.
struct DuoOverviewSectionHeader: View {
  let title: String
  var count: Int?
  var actionTitle: String?
  var action: () -> Void = {}

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Text(title)
      if let count {
        Text("\(count)")
          .monospacedDigit()
          .foregroundStyle(.tertiary)
      }
      Spacer(minLength: 8)
      if let actionTitle {
        Button(actionTitle, action: action)
          .font(.subheadline)
          .textCase(nil)
          .buttonStyle(.borderless)
      }
    }
  }
}

struct DuoOverviewQuietRow: View {
  let symbol: String
  let title: String
  let detail: String

  var body: some View {
    Label {
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .foregroundStyle(ADEColor.textPrimary)
        Text(detail)
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
      }
    } icon: {
      Image(systemName: symbol)
        .foregroundStyle(ADEColor.success)
    }
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Widget rows (dense)

enum DuoWidgetRowMetrics {
  /// Where a row's text starts: the divider's leading inset.
  static let textInset: CGFloat = 44
}

/// One chat in the Needs you widget: the state glyph, the title on one line,
/// project · lane under it, and how long ago. The glyph carries the state (a
/// red triangle is a failure); the row speaks the word. Taps open the chat.
struct DuoWidgetChatRow: View {
  let item: DuoNeedsYouItem
  let action: () -> Void

  private var context: String {
    let project = item.project.displayName
    guard let lane = item.lane?.name.trimmingCharacters(in: .whitespacesAndNewlines),
          !lane.isEmpty else { return project }
    return "\(project) · \(lane)"
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 0) {
        HubStateGlyph(state: item.boardState, size: 12)
          .frame(width: DuoWidgetRowMetrics.textInset - 16, alignment: .center)
        VStack(alignment: .leading, spacing: 1) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(item.row.title)
              .font(.subheadline)
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
              .frame(maxWidth: .infinity, alignment: .leading)
            if let activity = item.row.activityLabel {
              Text(activity)
                .font(.caption.monospacedDigit())
                .foregroundStyle(ADEColor.textMuted)
                .lineLimit(1)
                .fixedSize()
            }
          }
          Text(context)
            .font(.caption)
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 6)
      .contentShape(Rectangle())
    }
    .buttonStyle(DuoWidgetRowButtonStyle())
    .accessibilityLabel("\(item.row.title), \(item.stateLabel ?? "Needs you"), \(context)")
    .accessibilityHint("Opens the chat.")
  }
}

/// One machine in the Machines widget, on one line: its glyph and name, then
/// a status dot and either how many agents run there or its state word. This phone's machine
/// carries the checkmark. The full summary (projects too) is spoken.
struct DuoWidgetMachineRow: View {
  let machine: DuoHomeMachine
  let action: () -> Void

  /// The dot's colour already says the machine is up, so a machine with
  /// agents running says how many; otherwise its state word.
  private var shortStatus: String {
    machine.workingCount > 0 ? "\(machine.workingCount) working" : machine.statusWord
  }

  var body: some View {
    Button(action: action) {
      HStack(spacing: 0) {
        Image(systemName: machineSymbol(machineKey: machine.isFocused ? nil : machine.id, name: machine.name))
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: DuoWidgetRowMetrics.textInset - 16, alignment: .center)
        Text(machine.name)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
        Spacer(minLength: 10)
        // A few words at most: it keeps its width and the name gives way.
        HStack(spacing: 5) {
          ADEKitDot(tone: machine.tone, size: 6)
          Text(shortStatus)
            .lineLimit(1)
        }
        .fixedSize()
        .font(.caption)
        .foregroundStyle(ADEColor.textSecondary)
        Image(systemName: "checkmark")
          .font(.caption.weight(.bold))
          .foregroundStyle(ADEColor.accent)
          .frame(width: 22, alignment: .trailing)
          .opacity(machine.isFocused ? 1 : 0)
          .accessibilityHidden(true)
      }
      .padding(.horizontal, 16)
      .frame(minHeight: 40)
      .contentShape(Rectangle())
    }
    .buttonStyle(DuoWidgetRowButtonStyle())
    .accessibilityLabel(
      machine.isFocused
        ? "\(machine.name), this phone's machine, \(machine.summary)"
        : "\(machine.name), \(machine.summary)"
    )
    .accessibilityHint("Opens connection settings.")
  }
}

/// A widget row's pressed state: the row's own band, briefly tinted.
private struct DuoWidgetRowButtonStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .background(Color.primary.opacity(configuration.isPressed ? 0.06 : 0))
  }
}

#if DEBUG
/// Fixture screens for this area, routed by `DuoPreviewRouter`.
///
///     duo-home        the Hub at real volume (16 projects, 19 need you, 5 machines)
///     duo-home-quiet  the same Hub with nothing needing you
///     duo-home-filtered  the Hub with the Working filter on
///     duo-home-chats  Chats open (the two-column chats window on the inner display)
///     duo-activity    (DuoWindows) the Hub with Activity open in its right page
enum DuoHomePreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-home", "duo-home-outer": return AnyView(DuoHomeFixtureScreen())
    case "duo-home-quiet": return AnyView(DuoHomeFixtureScreen(quiet: true))
    case "duo-home-filtered": return AnyView(DuoHomeFixtureScreen(initialFilter: .working))
    case "duo-home-chats": return AnyView(DuoHomeFixtureScreen(opensChats: true))
    case "duo-nomachine": return AnyView(DuoConnectFixtures.noMachine)
    case "duo-signin": return AnyView(DuoConnectFixtures.gate)
    case "duo-signin-sheet": return AnyView(DuoConnectFixtures.gate(sheet: .signIn))
    case "duo-nearby": return AnyView(DuoConnectFixtures.gate(sheet: .nearby))
    case "duo-nearby-empty": return AnyView(DuoConnectFixtures.gate(sheet: .nearbyEmpty))
    case "duo-pin": return AnyView(DuoConnectFixtures.gate(sheet: .pin))
    case "duo-ssh": return AnyView(DuoConnectFixtures.gate(sheet: .ssh))
    case "duo-connect": return AnyView(DuoConnectFixtures.gate(sheet: .connect))
    case "duo-settings-machines": return AnyView(SettingsMachinesPreviewHost())
    default: return nil
    }
  }
}

/// The sign-in and connect screens over in-process data: the access gate,
/// the no-machine Hub, and each sheet the connect flow opens, presented the
/// way the app presents it.
@MainActor
private enum DuoConnectFixtures {
  enum Sheet: String, Identifiable {
    case signIn, nearby, nearbyEmpty, pin, ssh, connect
    var id: String { rawValue }
  }

  static var noMachine: some View {
    NavigationStack {
      ZStack {
        ADEColor.pageBackground.ignoresSafeArea()
        HubNoMachineState()
      }
    }
    .tint(ADEColor.accent)
  }

  static var gate: some View { gate(sheet: nil) }

  static func gate(sheet: Sheet?) -> some View {
    DuoConnectGateFixture(sheet: sheet)
      .tint(ADEColor.accent)
  }

  static let hosts: [DiscoveredSyncHost] = [
    DiscoveredSyncHost(
      id: "fixture-host-studio", serviceName: "studio", hostName: "Arul’s Mac Studio", hostIdentity: "studio",
      port: 8787, addresses: ["192.168.1.20"], tailscaleAddress: nil, runtimeName: "ADE brain 1.2.116",
      lastResolvedAt: "2026-10-22T07:00:00Z"
    ),
    DiscoveredSyncHost(
      id: "fixture-host-mbp", serviceName: "mbp", hostName: "Arul’s MacBook Pro", hostIdentity: "mbp",
      port: 8787, addresses: ["192.168.1.31"], tailscaleAddress: nil, runtimeKind: "desktop", runtimeVersion: "1.2.116",
      lastResolvedAt: "2026-10-22T07:00:00Z"
    ),
    DiscoveredSyncHost(
      id: "fixture-host-win", serviceName: "windows", hostName: "windows", hostIdentity: "windows",
      port: 8787, addresses: ["192.168.1.44"], tailscaleAddress: nil, runtimeKind: "daemon",
      lastResolvedAt: "2026-10-22T07:00:00Z"
    ),
  ]
}

private struct DuoConnectGateFixture: View {
  let sheet: DuoConnectFixtures.Sheet?
  @EnvironmentObject private var syncService: SyncService
  @State private var presented: DuoConnectFixtures.Sheet?

  var body: some View {
    MobileAccessGateView(
      accountConfigured: true,
      accountLoading: false,
      accountSignedIn: false,
      hasPairedHost: true,
      onContinue: {}
    )
    .onAppear { presented = sheet }
    .sheet(item: $presented) { sheet in
      switch sheet {
      case .signIn:
        AccountSignInView()
      case .nearby, .nearbyEmpty:
        DiscoverHostsList(
          savedHosts: sheet == .nearby ? [DuoConnectFixtures.hosts[0]] : [],
          liveHosts: sheet == .nearby ? Array(DuoConnectFixtures.hosts.dropFirst()) : [],
          onReconnect: { _ in },
          onPick: { _ in },
          onCancel: { presented = nil }
        )
      case .pin:
        SettingsPinSheet(preset: .discover(DuoConnectFixtures.hosts[1]), syncService: syncService)
          .presentationDetents([.large])
      case .ssh:
        SSHPairingView(syncService: syncService)
          .presentationDetents([.large])
      case .connect:
        ConnectionSettingsView(syncService: syncService, pairingOnly: true)
      }
    }
  }
}

/// The Hub's real layouts (`DuoHomeWide` on the inner display, `HubPhoneLayout`
/// on the outer display and every other iPhone) over in-process fixture data.
/// No pairing, socket or network is touched.
private struct DuoHomeFixtureScreen: View {
  var quiet = false
  /// The filter a fixture opens on; nil is each layout's default.
  var initialFilter: HubRosterFilter?
  var opensChats = false
  @EnvironmentObject private var syncService: SyncService
  @Environment(\.duoLayout) private var duo
  @State private var composerExpanded = false
  @State private var rosterFilter: HubRosterFilter = .all
  @State private var chatsPresented = false

  private var presentations: [HubProjectPresentation] {
    quiet ? DuoHomeFixture.quietPresentations : DuoHomeFixture.presentations
  }

  private var filterCounts: [HubRosterFilter: Int] {
    Dictionary(uniqueKeysWithValues: HubRosterFilter.allCases.map { filter in
      (filter, hubRosterFilterCount(presentations, filter: filter))
    })
  }

  private var actions: HubToolbarActions {
    HubToolbarActions(
      chatsAvailable: true,
      chatsAttentionCount: 2,
      onAdd: {},
      onOpenChats: { chatsPresented = true },
      onOpenActivity: { syncService.attentionDrawerPresented = true },
      onOpenSettings: { syncService.settingsPresented = true }
    )
  }

  var body: some View {
    Group {
      if duo.isWide {
        DuoHomeWide(
          machines: DuoHomeFixture.machines,
          presentations: presentations,
          actions: actions,
          account: DuoHomeFixture.account,
          onOpenAgent: { _ in },
          chatsPresented: $chatsPresented,
          initialAgentFilter: initialFilter ?? .needsYou,
          title: { title },
          projects: { roster },
          composer: { HubInlineComposer(expanded: $composerExpanded, onCreated: { _ in }) },
          chatsDestination: { PersonalChatsScreen() }
        )
      } else {
        NavigationStack {
          HubPhoneLayout(
            composerExpanded: $composerExpanded,
            actions: actions,
            title: { title },
            filterBar: {
              HubRosterFilterBar(counts: filterCounts, selection: $rosterFilter)
                .padding(.horizontal, 16)
                .padding(.bottom, 8)
            },
            roster: { roster },
            composer: { HubInlineComposer(expanded: $composerExpanded, onCreated: { _ in }) }
          )
          .background(ADEColor.pageBackground.ignoresSafeArea())
        }
      }
    }
    .onAppear {
      if !duo.isWide { rosterFilter = initialFilter ?? .all }
      if opensChats { chatsPresented = true }
    }
    // The toolbar's Activity item reads the drawer, and every control the
    // app's tint; the app sets both at the root, which the fixture stands in for.
    .environmentObject(syncService.attentionDrawer)
    .tint(ADEColor.accent)
  }

  private var title: some View {
    HubConnectionMenu(
      status: HubConnectionStatus(tone: .ok, label: "Arul’s Mac Studio", spokenState: "connected"),
      machines: DuoHomeFixture.machines,
      onOpenSettings: {}
    )
  }

  private var roster: some View {
    ScrollView {
      // On the inner display the filters choose the agent list, not the
      // projects: the project list always shows every project there.
      LazyVGrid(columns: HubProjectGridMetrics.columns, spacing: HubProjectGridMetrics.spacing) {
        ForEach(presentations.compactMap { hubProjectPresentation($0, matching: duo.isWide ? .all : rosterFilter) }) { presentation in
          HubProjectTile(
            presentation: presentation,
            machineLabel: DuoHomeFixture.machineLabel(for: presentation.project),
            canChangeIcon: true,
            onOpenProject: {},
            onChangeIcon: { _ in },
            onMoveToTop: {},
            onForget: {}
          )
          .equatable()
        }
      }
      .frame(maxWidth: .infinity)
      .padding(.horizontal, 16)
      .padding(.top, 8)
      .padding(.bottom, 16)
    }
    .scrollIndicators(.hidden)
  }
}

/// In-process fixture data at the volume a real account has: 16 projects with
/// their lanes and chats (19 of them need the user), five machines.
@MainActor
private enum DuoHomeFixture {
  static let account = AccountIdentity(
    userId: "fixture-user",
    displayName: "Arul Sharma",
    email: "arul@example.com",
    imageURL: nil,
    providerLabel: "GitHub",
    providerId: "github"
  )

  static let machines: [DuoHomeMachine] = [
    DuoHomeMachine(id: "fixture-machine-studio", name: "Arul’s Mac Studio", statusWord: "Connected", tone: .ok,
                   isFocused: true, projectCount: 11, workingCount: 7, isLive: true),
    DuoHomeMachine(id: "fixture-machine-mbp", name: "Arul’s MacBook Pro", statusWord: "Live", tone: .ok,
                   projectCount: 4, workingCount: 2, isLive: true),
    DuoHomeMachine(id: "fixture-machine-win", name: "windows", statusWord: "Live", tone: .ok,
                   projectCount: 1, workingCount: 0, isLive: true),
    DuoHomeMachine(id: "fixture-machine-mini", name: "Build Mac mini", statusWord: "Paused", tone: .neutral),
    DuoHomeMachine(id: "fixture-machine-linux", name: "linux-gpu-box", statusWord: "Offline", tone: .crit),
  ]

  /// Realistic machine chips: most projects on the Mac Studio, some on two
  /// machines, a few only on the MacBook Pro.
  static func machineLabel(for project: MobileProjectSummary) -> String? {
    let index = Int(project.id.split(separator: "-").last ?? "") ?? 0
    switch index % 5 {
    case 1: return "2 machines"
    case 3: return "Arul’s MacBook Pro"
    default: return "Arul’s Mac Studio"
    }
  }

  static func stamp(minutesAgo: Int) -> String {
    ISO8601DateFormatter().string(from: Date().addingTimeInterval(-Double(minutesAgo) * 60))
  }

  private static let projectNames = [
    "ADE", "Website", "Versic Mobile", "Billing Service", "Docs", "Infra", "Design System",
    "Analytics Pipeline", "CLI", "Desktop Shell", "Marketing Site", "iOS Widgets", "Payments SDK",
    "Search Indexer", "Onboarding Flow", "Data Warehouse",
  ]
  private static let laneNames = ["main", "iPhone Duo", "Release", "Sync retry", "Perf pass", "Auth refresh"]
  private static let laneColors = ["#a78bfa", "#60a5fa", "#34d399", "#fbbf24", "#f472b6", "#2dd4bf"]
  private static let titles = [
    "Fix the lanes rebase guard when the worktree has uncommitted changes",
    "Duo shell and wide Home",
    "Pricing page copy for the annual plan",
    "Release notes for 1.2.116",
    "Sync retry backoff after a dropped socket",
    "Two-machine pairing check",
    "Move the Activity drawer into the edge bar",
    "Investigate the brain wedge on large SQLite pages",
    "Stripe webhook signature failures in staging",
    "Translate onboarding to Japanese",
    "Speed up cold launch on older iPhones",
    "Search index rebuild is stuck at 62%",
  ]
  private static let providers = ["claude", "codex", "claude", "claude", "codex", "claude"]

  /// Deterministic project rosters; `needsYouBudget` is how many chats are
  /// filed under Needs you across the whole Hub.
  private static func build(needsYouBudget: Int) -> [HubProjectPresentation] {
    var remaining = needsYouBudget
    var minutes = 2
    return projectNames.enumerated().map { index, name in
      let project = MobileProjectSummary(
        id: "fixture-project-\(index)",
        displayName: name,
        rootPath: "/Users/arul/\(name.lowercased().replacingOccurrences(of: " ", with: "-"))",
        repoOwner: "arul",
        repoName: name.lowercased(),
        laneCount: 1 + index % 4,
        isAvailable: true,
        isCached: true,
        isOpen: index == 0
      )
      let lanes = (0..<(1 + index % 4)).map { laneIndex in
        RemoteRosterLane(
          id: "fixture-lane-\(index)-\(laneIndex)",
          name: laneNames[laneIndex % laneNames.count],
          color: laneColors[(index + laneIndex) % laneColors.count],
          icon: nil,
          laneType: laneIndex == 0 ? "primary" : "worktree",
          branchRef: laneIndex == 0 ? "main" : "ade/\(laneNames[laneIndex].lowercased().replacingOccurrences(of: " ", with: "-"))"
        )
      }
      let chatCount = index < 6 ? 5 - index % 3 : 1 + index % 3
      let chats = (0..<chatCount).map { chatIndex -> RemoteRosterChat in
        minutes += 3 + (index * 7 + chatIndex * 5) % 17
        var status: RemoteRosterChatStatus = chatIndex % 3 == 2 ? .idle : .running
        var awaiting = false
        var handRaised = false
        if remaining > 0, (index + chatIndex) % 2 == 0 {
          remaining -= 1
          switch remaining % 5 {
          case 0: status = .failed
          case 1: handRaised = true
          default:
            status = .awaiting
            awaiting = true
          }
        }
        return RemoteRosterChat(
          id: "fixture-chat-\(index)-\(chatIndex)",
          laneId: lanes[chatIndex % lanes.count].id,
          chatSessionId: nil,
          title: titles[(index * 3 + chatIndex) % titles.count],
          provider: providers[(index + chatIndex) % providers.count],
          model: "claude-sonnet-5",
          toolType: "claude-chat",
          status: status,
          awaitingInput: awaiting,
          pinned: false,
          archived: false,
          lastActivityAt: stamp(minutesAgo: minutes),
          preview: "Reading the code before the change.",
          attentionRequestedAt: handRaised ? stamp(minutesAgo: minutes) : nil
        )
      }
      let roster = RemoteRosterProject(
        projectId: project.id,
        rootPath: project.rootPath,
        displayName: project.displayName,
        iconDataUrl: nil,
        lastOpenedAt: project.lastOpenedAt,
        booted: true,
        runningCount: chats.filter(\.countsTowardRunning).count,
        attentionCount: chats.filter(\.needsAttention).count,
        lanes: lanes,
        chats: chats
      )
      return buildHubProjectPresentation(project: project, roster: roster, isActive: index == 0, isSwitching: false)
    }
  }

  static let presentations = build(needsYouBudget: 19)
  static let quietPresentations = build(needsYouBudget: 0)
}
#endif
