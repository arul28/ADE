import SwiftUI

// Wide Home: the all-projects Hub on the Duo's inner display.
//
// The phone's Hub is one vertical roster of project cards with the composer
// floating at the bottom. The inner display gets two pages instead, laid out
// around the fold or the middle line:
//
//   Projects (left / top half)      Overview (right / bottom half)
//   ---------------------------------------------------------------
//   top bar, roster filter,         Needs you, Machines, and the Hub
//   the same project cards          composer anchored at the bottom
//
// The pages are the same components the phone draws — `HubProjectCard`,
// `HubTopBar`, `HubInlineComposer` — so a project, a chat row or a machine means
// the same thing in either posture. Nothing here fetches: the overview is read
// from the presentations the Hub already built and from the fleet the
// connection pill already shows.
//
// `DuoLocalFoldReader` gives the fold in this view's own coordinates, so the
// pages sit on either side of a book fold (or above/below a laptop fold) rather
// than under it. Controls stay on a page; only the project list may scroll
// across a fold, and it does not have to.

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
      workingCount: syncService.runningChatSessionCount
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
        workingCount: working
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

/// Two pages laid out around the fold: the Hub's project roster, and everything
/// about the machines that is not a project. Held landscape the pages sit side
/// by side (a book fold is the boundary); held portrait the roster is the top
/// page and the overview with its composer the bottom one (a laptop fold is the
/// boundary).
struct DuoHomeWide<Projects: View, Composer: View>: View {
  let machines: [DuoHomeMachine]
  let needsYou: [DuoNeedsYouItem]
  let onOpenNeedsYou: (DuoNeedsYouItem) -> Void
  let onOpenActivity: () -> Void
  let onOpenMachines: () -> Void

  private let projects: Projects
  private let composer: Composer

  @Environment(\.duoLayout) private var duo

  init(
    machines: [DuoHomeMachine],
    needsYou: [DuoNeedsYouItem],
    onOpenNeedsYou: @escaping (DuoNeedsYouItem) -> Void,
    onOpenActivity: @escaping () -> Void,
    onOpenMachines: @escaping () -> Void,
    @ViewBuilder projects: () -> Projects,
    @ViewBuilder composer: () -> Composer
  ) {
    self.machines = machines
    self.needsYou = needsYou
    self.onOpenNeedsYou = onOpenNeedsYou
    self.onOpenActivity = onOpenActivity
    self.onOpenMachines = onOpenMachines
    self.projects = projects()
    self.composer = composer()
  }

  var body: some View {
    DuoTwoPages(fold: .automatic) {
      projectsPage
    } second: {
      overviewPage
    }
  }

  // MARK: Pages

  private var projectsPage: some View {
    projects
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }

  /// The lists end above the composer: it is the page's footer, not a layer
  /// over the rows.
  private var overviewPage: some View {
    VStack(spacing: 0) {
      List {
        needsYouSection
        machinesSection
      }
      .listStyle(.insetGrouped)
      .scrollContentBackground(.hidden)
      .scrollDismissesKeyboard(.interactively)
      .contentMargins(.top, 4, for: .scrollContent)
      composer
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }

  // MARK: Needs you

  private var needsYouSection: some View {
    Section {
      if needsYou.isEmpty {
        DuoOverviewQuietRow(
          symbol: "checkmark.circle",
          title: "Nothing needs you",
          detail: "Your agents are working on their own."
        )
      } else {
        ForEach(needsYou.prefix(5)) { item in
          DuoOverviewChatRow(item: item) { onOpenNeedsYou(item) }
        }
        if needsYou.count > 5 {
          Button("\(needsYou.count - 5) more in Activity", action: onOpenActivity)
            .font(.subheadline)
        }
      }
    } header: {
      DuoOverviewSectionHeader(
        title: "Needs you",
        count: needsYou.isEmpty ? nil : needsYou.count,
        actionTitle: needsYou.isEmpty ? nil : "Activity",
        action: onOpenActivity
      )
    }
  }

  // MARK: Machines

  private var machinesSection: some View {
    Section {
      ForEach(machines) { machine in
        DuoOverviewMachineRow(machine: machine, action: onOpenMachines)
      }
    } header: {
      DuoOverviewSectionHeader(
        title: "Machines",
        count: nil,
        actionTitle: "Manage",
        action: onOpenMachines
      )
    }
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
  @ViewBuilder var first: () -> First
  @ViewBuilder var second: () -> Second

  var body: some View {
    DuoLocalFoldReader { fold, size in
      let sideBySide = size.width > size.height
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

// MARK: - Overview rows

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

/// One chat in an overview list: the board mark, title, project and lane, the
/// state word and how long ago. Taps open the chat.
struct DuoOverviewChatRow: View {
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
      HStack(spacing: 10) {
        HubStateGlyph(state: item.boardState, size: 12)
          .frame(width: 22)

        VStack(alignment: .leading, spacing: 2) {
          Text(item.row.title)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          HStack(spacing: 5) {
            if let lane = item.lane {
              Circle()
                .fill(LaneColorPalette.displayColor(forHex: lane.color))
                .frame(width: 6, height: 6)
            }
            Text(context)
              .lineLimit(1)
          }
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 6)

        VStack(alignment: .trailing, spacing: 2) {
          if let label = item.stateLabel {
            Text(label)
              .font(.footnote.weight(.medium))
              .foregroundStyle(activityToneColor(item.boardState.tone))
          }
          if let activity = item.row.activityLabel {
            Text(activity)
              .font(.caption.monospacedDigit())
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .lineLimit(1)
        .fixedSize()
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(item.row.title), \(item.stateLabel ?? "Needs you"), \(context)")
    .accessibilityHint("Opens the chat.")
  }
}

/// One machine in an overview list.
struct DuoOverviewMachineRow: View {
  let machine: DuoHomeMachine
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        Image(systemName: machineSymbol(machineKey: machine.isFocused ? nil : machine.id, name: machine.name))
          .font(.body)
          .foregroundStyle(ADEColor.textSecondary)
          .frame(width: 22)

        VStack(alignment: .leading, spacing: 2) {
          HStack(spacing: 6) {
            Text(machine.name)
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            if machine.isFocused {
              Text("This machine")
                .font(.caption2.weight(.medium))
                .foregroundStyle(ADEColor.textSecondary)
                .padding(.horizontal, 6)
                .padding(.vertical, 1)
                .background(ADEKit.track, in: Capsule())
            }
          }
          HStack(spacing: 5) {
            ADEKitDot(tone: machine.tone, size: 6)
            Text(machine.summary)
              .lineLimit(1)
          }
          .font(.footnote)
          .foregroundStyle(ADEColor.textSecondary)
        }

        Spacer(minLength: 6)
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel("\(machine.name), \(machine.summary)")
    .accessibilityHint("Opens connection settings.")
  }
}

// MARK: - Toolbar

/// The wide Home's controls, in the system toolbar so the Duo's edge bar holds
/// them held landscape and the top bar holds them held portrait: the machine
/// connection as a plain status label (its menu lists every machine), the
/// roster filter, then Activity, Add project, Settings and Chats.
struct DuoHomeToolbar: ToolbarContent {
  let onAdd: () -> Void
  let chatsAvailable: Bool
  let chatsAttentionCount: Int
  let onOpenChats: () -> Void
  @Binding var filter: HubRosterFilter
  let filterCounts: [HubRosterFilter: Int]
  let machines: [DuoHomeMachine]
  let onOpenSettings: () -> Void
  let onOpenActivity: () -> Void

  var body: some ToolbarContent {
    ToolbarItem(placement: .topBarLeading) {
      DuoHomeConnectionMenu(machines: machines, onOpenSettings: onOpenSettings)
    }
    .sharedBackgroundVisibility(.hidden)

    ToolbarItem(placement: .primaryAction) {
      DuoActivityToolbarButton(action: onOpenActivity)
    }

    ToolbarItem(placement: .primaryAction) {
      Menu {
        Picker("Show", selection: $filter) {
          ForEach(HubRosterFilter.allCases) { option in
            Text("\(option.title)  \(filterCounts[option] ?? 0)")
              .tag(option)
          }
        }
        .pickerStyle(.inline)
      } label: {
        Label(
          filter == .all ? "Filter" : filter.title,
          systemImage: filter == .all
            ? "line.3.horizontal.decrease"
            : "line.3.horizontal.decrease.circle.fill"
        )
      }
      .accessibilityLabel("Show \(filter.title)")
    }

    ToolbarItem(placement: .primaryAction) {
      Button(action: onAdd) {
        Label("Add project", systemImage: "plus")
      }
    }

    ToolbarItem(placement: .primaryAction) {
      Button(action: onOpenChats) {
        Label("Chats", systemImage: "bubble.left.and.bubble.right")
      }
      .badge(chatsAvailable ? chatsAttentionCount : 0)
      .disabled(!chatsAvailable)
      .accessibilityLabel(chatsAttentionCount > 0 ? "Chats, \(chatsAttentionCount) awaiting input" : "Chats")
    }

    ToolbarItem(placement: .primaryAction) {
      Button(action: onOpenSettings) {
        Label("Settings", systemImage: "gearshape")
      }
    }
  }
}

/// Activity as a toolbar item, badged with what needs the user. Its own view so
/// the badge follows the drawer without redrawing the screen that hosts it.
struct DuoActivityToolbarButton: View {
  @EnvironmentObject private var drawer: ActivityDrawerModel
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label("Activity", systemImage: "bell")
    }
    .badge(drawer.unreadCount)
    .accessibilityLabel(drawer.unreadCount > 0 ? "Activity, \(drawer.unreadCount) needing you" : "Activity")
  }
}

/// The brand and the connection, as text rather than a pill button. The menu
/// is the one the phone's machines chip opens.
struct DuoHomeConnectionMenu: View {
  let machines: [DuoHomeMachine]
  let onOpenSettings: () -> Void

  private var focused: DuoHomeMachine? { machines.first(where: \.isFocused) ?? machines.first }

  var body: some View {
    Menu {
      Section("Machines") {
        ForEach(machines) { machine in
          Button(action: onOpenSettings) {
            Text(machine.name)
            Text(machine.summary)
            Image(systemName: machineSymbol(machineKey: machine.isFocused ? nil : machine.id, name: machine.name))
          }
        }
      }
      Button(action: onOpenSettings) {
        Label("Connection settings", systemImage: "gearshape")
      }
    } label: {
      HStack(spacing: 8) {
        Image("BrandMark")
          .resizable()
          .renderingMode(.original)
          .interpolation(.high)
          .aspectRatio(contentMode: .fit)
          .frame(width: 40, height: 22)
          .accessibilityHidden(true)
        if let focused {
          HStack(spacing: 5) {
            ADEKitDot(tone: focused.tone, size: 7)
            Text(focused.statusWord)
              .font(.subheadline.weight(.medium))
              .foregroundStyle(ADEColor.textSecondary)
          }
        }
      }
    }
    .accessibilityLabel("ADE, \(focused?.statusWord ?? "Offline")")
    .accessibilityHint("Lists your machines.")
  }
}

#if DEBUG
/// Fixture screens for this area, routed by `DuoPreviewRouter`.
enum DuoHomePreviews {
  @MainActor
  static func view(_ name: String) -> AnyView? {
    switch name {
    case "duo-home": return AnyView(DuoHomeFixtureScreen())
    default: return nil
    }
  }
}

/// The wide Home with in-process fixture data: three projects with lanes and
/// chats, two machines and three rows that need the user. Launched with
/// `-adePreviewScreen duo-home`; no pairing, socket or network is touched.
private struct DuoHomeFixtureScreen: View {
  @EnvironmentObject private var syncService: SyncService
  @State private var composerExpanded = false
  @State private var collapsedLaneKeys: Set<String> = []
  @State private var rosterFilter: HubRosterFilter = .all

  private var filterCounts: [HubRosterFilter: Int] {
    Dictionary(uniqueKeysWithValues: HubRosterFilter.allCases.map { filter in
      (filter, hubRosterFilterCount(DuoHomeFixture.presentations, filter: filter))
    })
  }

  private var filteredPresentations: [HubProjectPresentation] {
    DuoHomeFixture.presentations.compactMap {
      hubProjectPresentation($0, matching: rosterFilter)
    }
  }

  var body: some View {
    NavigationStack {
      DuoHomeWide(
        machines: DuoHomeFixture.machines,
        needsYou: DuoHomeFixture.needsYou,
        onOpenNeedsYou: { _ in },
        onOpenActivity: { syncService.attentionDrawerPresented = true },
        onOpenMachines: { syncService.settingsPresented = true },
        projects: {
          ScrollView {
            LazyVStack(spacing: 8) {
              ForEach(filteredPresentations) { presentation in
                HubProjectCard(
                  presentation: presentation,
                  isCollapsed: false,
                  collapsedLaneKeysSnapshot: [],
                  collapsedLaneKeys: $collapsedLaneKeys,
                  onToggleCollapse: {},
                  onOpenProject: {},
                  onOpenChat: { _, _ in },
                  onViewLaneInWork: { _ in },
                  onViewLaneInLanes: { _ in },
                  onArchiveChat: { _ in },
                  onDeleteChat: { _ in },
                  onForget: {}
                )
                .equatable()
              }
            }
            .frame(maxWidth: 640)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 16)
          }
          .scrollIndicators(.hidden)
        },
        composer: {
          HubInlineComposer(expanded: $composerExpanded, onCreated: { _ in })
        }
      )
      .background(ADEColor.pageBackground.ignoresSafeArea())
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        DuoHomeToolbar(
          onAdd: {},
          chatsAvailable: true,
          chatsAttentionCount: 1,
          onOpenChats: {},
          filter: $rosterFilter,
          filterCounts: filterCounts,
          machines: DuoHomeFixture.machines,
          onOpenSettings: { syncService.settingsPresented = true },
          onOpenActivity: { syncService.attentionDrawerPresented = true }
        )
      }
    }
    // The toolbar's Activity item reads the drawer; the app injects this
    // instance at the root, and the fixture has to stand in for that root.
    .environmentObject(syncService.attentionDrawer)
  }
}

/// In-process fixture data for the wide Home. Everything is synthesised here so
/// the screen renders on a bare simulator.
@MainActor
private enum DuoHomeFixture {
  static func stamp(minutesAgo: Int) -> String {
    ISO8601DateFormatter().string(
      from: Date().addingTimeInterval(-Double(minutesAgo) * 60)
    )
  }

  // MARK: Projects

  static let adeProject = MobileProjectSummary(
    id: "fixture-project-ade",
    displayName: "ADE",
    rootPath: "/Users/arul/ADE",
    repoOwner: "arul",
    repoName: "ADE",
    laneCount: 3,
    isAvailable: true,
    isCached: true,
    isOpen: true
  )

  static let siteProject = MobileProjectSummary(
    id: "fixture-project-site",
    displayName: "Website",
    rootPath: "/Users/arul/website",
    repoOwner: "arul",
    repoName: "website",
    laneCount: 1,
    isAvailable: true,
    isCached: true,
    isOpen: false
  )

  static let mobileProject = MobileProjectSummary(
    id: "fixture-project-mobile",
    displayName: "Versic Mobile",
    rootPath: "/Users/arul/versic",
    repoOwner: "arul",
    repoName: "versic",
    laneCount: 2,
    isAvailable: true,
    isCached: false,
    isOpen: false
  )

  // MARK: Lanes

  private static let adePrimary = RemoteRosterLane(
    id: "fixture-lane-ade-primary",
    name: "main",
    color: "#a78bfa",
    icon: nil,
    laneType: "primary",
    branchRef: "main"
  )
  private static let adeDuo = RemoteRosterLane(
    id: "fixture-lane-ade-duo",
    name: "iPhone Duo",
    color: "#60a5fa",
    icon: nil,
    laneType: "worktree",
    branchRef: "ade/iphone-duo"
  )
  private static let adeRelease = RemoteRosterLane(
    id: "fixture-lane-ade-release",
    name: "Release",
    color: "#34d399",
    icon: nil,
    laneType: "worktree",
    branchRef: "ade/release"
  )
  private static let sitePrimary = RemoteRosterLane(
    id: "fixture-lane-site-primary",
    name: "main",
    color: "#fbbf24",
    icon: nil,
    laneType: "primary",
    branchRef: "main"
  )
  private static let mobilePrimary = RemoteRosterLane(
    id: "fixture-lane-mobile-primary",
    name: "main",
    color: "#f472b6",
    icon: nil,
    laneType: "primary",
    branchRef: "main"
  )
  private static let mobileSync = RemoteRosterLane(
    id: "fixture-lane-mobile-sync",
    name: "Sync",
    color: "#2dd4bf",
    icon: nil,
    laneType: "worktree",
    branchRef: "ade/sync"
  )

  // MARK: Chats

  private static func chat(
    id: String,
    lane: RemoteRosterLane,
    title: String,
    status: RemoteRosterChatStatus,
    awaitingInput: Bool = false,
    handRaised: Bool = false,
    minutesAgo: Int,
    preview: String?,
    provider: String = "claude"
  ) -> RemoteRosterChat {
    RemoteRosterChat(
      id: id,
      laneId: lane.id,
      chatSessionId: nil,
      title: title,
      provider: provider,
      model: "claude-sonnet-5",
      toolType: "claude-chat",
      status: status,
      awaitingInput: awaitingInput,
      pinned: false,
      archived: false,
      lastActivityAt: stamp(minutesAgo: minutesAgo),
      preview: preview,
      attentionRequestedAt: handRaised ? stamp(minutesAgo: minutesAgo) : nil
    )
  }

  private static let adeChats: [RemoteRosterChat] = [
    chat(
      id: "fixture-chat-duo-shell",
      lane: adeDuo,
      title: "Duo shell and wide Home",
      status: .awaiting,
      awaitingInput: true,
      minutesAgo: 3,
      preview: "Which sidebar placement should the folded posture use?"
    ),
    chat(
      id: "fixture-chat-release",
      lane: adeRelease,
      title: "Release notes for 1.2.116",
      status: .running,
      minutesAgo: 9,
      preview: "Drafting the changelog from the merged pull requests."
    ),
    chat(
      id: "fixture-chat-rebase",
      lane: adePrimary,
      title: "Fix the lanes rebase guard",
      status: .failed,
      minutesAgo: 24,
      preview: "The rebase aborted: lane worktree has uncommitted changes."
    ),
  ]

  private static let siteChats: [RemoteRosterChat] = [
    chat(
      id: "fixture-chat-site",
      lane: sitePrimary,
      title: "Pricing page copy",
      status: .running,
      handRaised: true,
      minutesAgo: 12,
      preview: "Tightening the annual-plan paragraph.",
      provider: "codex"
    )
  ]

  private static let mobileChats: [RemoteRosterChat] = [
    chat(
      id: "fixture-chat-mobile",
      lane: mobileSync,
      title: "Sync retry backoff",
      status: .running,
      minutesAgo: 6,
      preview: "Reading SyncService+Retry.swift before the change.",
      provider: "cursor"
    ),
    chat(
      id: "fixture-chat-mobile-idle",
      lane: mobilePrimary,
      title: "Two-machine pairing check",
      status: .idle,
      minutesAgo: 68,
      preview: "Pairing held for a full day.",
      provider: "codex"
    ),
  ]

  // MARK: Rosters

  private static func roster(
    project: MobileProjectSummary,
    lanes: [RemoteRosterLane],
    chats: [RemoteRosterChat]
  ) -> RemoteRosterProject {
    RemoteRosterProject(
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
  }

  static let presentations: [HubProjectPresentation] = [
    buildHubProjectPresentation(
      project: adeProject,
      roster: roster(project: adeProject, lanes: [adePrimary, adeDuo, adeRelease], chats: adeChats),
      isActive: true,
      isSwitching: false
    ),
    buildHubProjectPresentation(
      project: siteProject,
      roster: roster(project: siteProject, lanes: [sitePrimary], chats: siteChats),
      isActive: false,
      isSwitching: false
    ),
    buildHubProjectPresentation(
      project: mobileProject,
      roster: roster(project: mobileProject, lanes: [mobilePrimary, mobileSync], chats: mobileChats),
      isActive: false,
      isSwitching: false
    ),
  ]

  static var needsYou: [DuoNeedsYouItem] {
    duoNeedsYouItems(from: presentations)
  }

  static let machines: [DuoHomeMachine] = [
    DuoHomeMachine(
      id: "fixture-machine-primary",
      name: "Arul's MacBook Pro",
      statusWord: "Connected",
      tone: .ok,
      isFocused: true,
      projectCount: 3,
      workingCount: 2
    ),
    DuoHomeMachine(
      id: "fixture-machine-studio",
      name: "Mac Studio",
      statusWord: "Live",
      tone: .ok,
      projectCount: 2,
      workingCount: 1
    ),
  ]
}
#endif
