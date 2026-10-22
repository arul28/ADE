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
/// about the machines that is not a project.
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
    DuoLocalFoldReader { fold, size in
      switch fold {
      case .sideBySide(let rect):
        bookLayout(fold: rect, size: size)
      case .stacked(let rect):
        laptopLayout(fold: rect, size: size)
      case .none:
        flatLayout(size: size)
      }
    }
  }

  // MARK: Postures

  /// Book: the fold is a vertical line, a page on each side of it.
  private func bookLayout(fold rect: CGRect, size: CGSize) -> some View {
    let leftWidth = max(0, min(rect.minX, size.width))
    let gap = max(0, min(rect.width, size.width - leftWidth))
    return HStack(spacing: 0) {
      projectsPage
        .frame(width: leftWidth, alignment: .top)
      hingeGap(axis: .vertical, thickness: gap)
      overviewPage
        .frame(width: max(0, size.width - leftWidth - gap), alignment: .top)
    }
    .frame(width: size.width, height: size.height, alignment: .topLeading)
  }

  /// Laptop or tent: the fold is a horizontal line, projects on top (read from
  /// further away) and the controls below it.
  private func laptopLayout(fold rect: CGRect, size: CGSize) -> some View {
    let topHeight = max(0, min(rect.minY, size.height))
    let gap = max(0, min(rect.height, size.height - topHeight))
    return VStack(spacing: 0) {
      projectsPage
        .frame(height: topHeight, alignment: .top)
      hingeGap(axis: .horizontal, thickness: gap)
      overviewPage
        .frame(height: max(0, size.height - topHeight - gap), alignment: .top)
    }
    .frame(width: size.width, height: size.height, alignment: .topLeading)
  }

  /// Flat, or a device with no hinge: two columns, as close to 50/50 as a
  /// half-point allows, with a hairline where a fold would be.
  private func flatLayout(size: CGSize) -> some View {
    let leftWidth = floor(size.width / 2)
    return HStack(spacing: 0) {
      projectsPage
        .frame(width: leftWidth, alignment: .top)
      Rectangle()
        .fill(ADEKit.rule)
        .frame(width: 0.75)
      overviewPage
        .frame(width: max(0, size.width - leftWidth - 0.75), alignment: .top)
    }
    .frame(width: size.width, height: size.height, alignment: .topLeading)
  }

  // MARK: Pages

  private var projectsPage: some View {
    projects
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }

  private var overviewPage: some View {
    VStack(spacing: 0) {
      overviewHeader
      overviewCards
      composer
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
  }

  /// A quiet page head, the height of the projects page's top bar, so the two
  /// pages start at the same line.
  private var overviewHeader: some View {
    HStack(spacing: 8) {
      Text("Overview")
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(ADEColor.textSecondary)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 16)
    .padding(.top, 6)
    .frame(height: 50)
    .accessibilityAddTraits(.isHeader)
  }

  private var overviewCards: some View {
    ScrollView {
      VStack(spacing: 12) {
        needsYouCard
        machinesCard
      }
      .padding(.horizontal, 14)
      .padding(.top, 2)
      .padding(.bottom, 12)
    }
    .scrollIndicators(.hidden)
    .scrollDismissesKeyboard(.interactively)
  }

  // MARK: Needs you

  private var needsYouCard: some View {
    ADEKitCard(
      title: "Needs you",
      symbol: "hand.raised",
      count: needsYou.isEmpty ? nil : "\(needsYou.count)",
      flush: true,
      action: {
        if !needsYou.isEmpty {
          Button("Activity", action: onOpenActivity)
            .buttonStyle(.plain)
        }
      }
    ) {
      VStack(spacing: 0) {
        if needsYou.isEmpty {
          DuoHomeQuietRow(
            symbol: "checkmark.circle",
            title: "Nothing needs you",
            detail: "Your agents are working on their own."
          )
        } else {
          let shown = Array(needsYou.prefix(5))
          ForEach(shown) { item in
            if item.id != shown.first?.id {
              DuoHomeRule(leadingInset: 44)
            }
            DuoHomeNeedsYouRow(item: item) { onOpenNeedsYou(item) }
          }
          if needsYou.count > 5 {
            DuoHomeRule(leadingInset: 0)
            Button {
              onOpenActivity()
            } label: {
              HStack(spacing: 6) {
                Text("\(needsYou.count - 5) more in Activity")
                  .font(.system(size: 13, weight: .medium))
                  .foregroundStyle(ADEColor.accent)
                Spacer(minLength: 0)
              }
              .padding(.horizontal, 12)
              .frame(height: 36)
              .contentShape(Rectangle())
            }
            .buttonStyle(ADEKitRowButtonStyle())
          }
        }
      }
      .padding(.bottom, 2)
    }
  }

  // MARK: Machines

  private var machinesCard: some View {
    ADEKitCard(
      title: "Machines",
      symbol: "desktopcomputer",
      count: liveMachineCount > 1 ? "\(liveMachineCount) live" : nil,
      flush: true,
      action: {
        Button("Manage", action: onOpenMachines)
          .buttonStyle(.plain)
      }
    ) {
      VStack(spacing: 0) {
        ForEach(machines) { machine in
          if machine.id != machines.first?.id {
            DuoHomeRule(leadingInset: 44)
          }
          DuoHomeMachineRow(machine: machine, action: onOpenMachines)
        }
      }
      .padding(.bottom, 2)
    }
  }

  private var liveMachineCount: Int {
    machines.filter { $0.tone == .ok }.count
  }

  // MARK: The fold

  /// The gap a hinge occupies, with the soft shadow of a page bending away from
  /// the fold. Flat and closed devices never reach it: they report `.none`.
  @ViewBuilder
  private func hingeGap(axis: Axis, thickness: CGFloat) -> some View {
    if thickness > 0.5 {
      ZStack {
        LinearGradient(
          colors: [
            .clear,
            Color.black.opacity(0.035 + 0.075 * duo.bend),
            .clear,
          ],
          startPoint: axis == .vertical ? .leading : .top,
          endPoint: axis == .vertical ? .trailing : .bottom
        )
        Rectangle()
          .fill(ADEKit.rule)
          .frame(
            width: axis == .vertical ? 0.75 : nil,
            height: axis == .horizontal ? 0.75 : nil
          )
      }
      .frame(
        width: axis == .vertical ? thickness : nil,
        height: axis == .horizontal ? thickness : nil
      )
      .accessibilityHidden(true)
    } else {
      Color.clear
        .frame(width: axis == .vertical ? 0 : nil, height: axis == .horizontal ? 0 : nil)
        .accessibilityHidden(true)
    }
  }
}

// MARK: - Overview rows

private struct DuoHomeRule: View {
  var leadingInset: CGFloat = 0

  var body: some View {
    Rectangle()
      .fill(ADEKit.rule)
      .frame(height: 0.75)
      .padding(.leading, leadingInset)
  }
}

private struct DuoHomeQuietRow: View {
  let symbol: String
  let title: String
  let detail: String

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 15, weight: .regular))
        .foregroundStyle(ADEColor.success)
        .frame(width: 26)
      VStack(alignment: .leading, spacing: 2) {
        Text(title)
          .font(.system(size: 14, weight: .medium))
          .foregroundStyle(ADEColor.textPrimary)
        Text(detail)
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textSecondary)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 12)
    .accessibilityElement(children: .combine)
  }
}

private struct DuoHomeNeedsYouRow: View {
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
      HStack(spacing: 9) {
        HubStateGlyph(state: item.boardState, size: 11)

        VStack(alignment: .leading, spacing: 2) {
          Text(item.row.title)
            .font(.system(size: 14, weight: .medium))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text(context)
            .font(.system(size: 12))
            .foregroundStyle(ADEColor.textSecondary)
            .lineLimit(1)
        }

        Spacer(minLength: 6)

        HStack(spacing: 5) {
          if let label = item.stateLabel {
            Text(label)
              .font(.system(size: 11, weight: .medium))
              .foregroundStyle(activityToneColor(item.boardState.tone))
              .lineLimit(1)
          }
          if let activity = item.row.activityLabel {
            Text(activity)
              .font(.adeMono(10.5))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .fixedSize()

        ADESettingsChevron()
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .contentShape(Rectangle())
    }
    .buttonStyle(ADEKitRowButtonStyle())
    .accessibilityLabel("\(item.row.title), \(item.stateLabel ?? "Needs you"), \(context)")
    .accessibilityHint("Opens the chat.")
  }
}

private struct DuoHomeMachineRow: View {
  let machine: DuoHomeMachine
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      HStack(spacing: 10) {
        ZStack {
          RoundedRectangle(cornerRadius: 9, style: .continuous)
            .fill(ADEKit.track)
            .frame(width: 30, height: 30)
          Image(systemName: "desktopcomputer")
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(ADEColor.textSecondary)
        }

        VStack(alignment: .leading, spacing: 3) {
          HStack(spacing: 6) {
            Text(machine.name)
              .font(.system(size: 14, weight: .semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
            if machine.isFocused {
              ADEKitTag(text: "This machine", keepsCase: true)
            }
          }
          HStack(spacing: 5) {
            ADEKitDot(tone: machine.tone, size: 6)
            Text(machine.summary)
              .font(.system(size: 12))
              .foregroundStyle(ADEColor.textSecondary)
              .lineLimit(1)
          }
        }

        Spacer(minLength: 6)
        ADESettingsChevron()
      }
      .padding(.horizontal, 12)
      .padding(.vertical, 10)
      .contentShape(Rectangle())
    }
    .buttonStyle(ADEKitRowButtonStyle())
    .accessibilityLabel("\(machine.name), \(machine.summary)")
    .accessibilityHint("Opens connection settings.")
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
    DuoHomeWide(
      machines: DuoHomeFixture.machines,
      needsYou: DuoHomeFixture.needsYou,
      onOpenNeedsYou: { _ in },
      onOpenActivity: { syncService.attentionDrawerPresented = true },
      onOpenMachines: { syncService.settingsPresented = true },
      projects: {
        VStack(spacing: 0) {
          HubTopBar(onAdd: {}, chatsAvailable: true, chatsAttentionCount: 1)
          HubRosterFilterBar(counts: filterCounts, selection: $rosterFilter)
            .padding(.horizontal, 16)
            .padding(.bottom, 8)
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
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 16)
          }
          .scrollIndicators(.hidden)
        }
      },
      composer: {
        HubInlineComposer(expanded: $composerExpanded, onCreated: { _ in })
      }
    )
    .background(ADEColor.pageBackground.ignoresSafeArea())
    // The top bar's bell reads the drawer; the app injects this instance at the
    // root, and the fixture has to stand in for that root.
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
