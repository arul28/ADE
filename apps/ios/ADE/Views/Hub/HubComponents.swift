import SwiftUI

// Visual building blocks for the all-projects hub: the toolbar, project cards
// (collapsible) with their lanes (collapsible) and chat rows, and the
// empty/connecting states. The bottom composer lives in HubComposerDrawer.swift.

// MARK: - Toolbar

/// What the Hub's toolbar buttons do and show. One value for every form of
/// the toolbar, so the phone, the outer display and the inner display's edge
/// bar can never disagree about a badge or an action.
struct HubToolbarActions {
  var chatsAvailable = false
  var chatsAttentionCount = 0
  var onAdd: () -> Void = {}
  var onOpenChats: () -> Void = {}
  var onOpenActivity: () -> Void = {}
  var onOpenSettings: () -> Void = {}
}

/// The Hub's controls in the system toolbar, so iOS places them: a top bar on
/// a phone, the vertical bar on the curved edge of the Duo's displays.
///
/// The Hub is above every project, so it never carries the app tabs (Work,
/// Lanes, PRs, Files, CTO only exist inside a project).
///
/// - `.bar`: one stack's top bar (the phone, the outer display, the Duo's
///   inner display folded laptop or tent). Activity and Chats, then the
///   filter (when the layout has no filter row), Add and Settings, then the
///   account.
/// - `.rail`: the inner display's trailing page held landscape, whose bar is
///   the edge bar. The account's picture heads it (it opens Settings), then
///   Activity and Chats; at the bottom, Machines (the machine list, badged
///   with how many are connected) and Settings. Add belongs to the projects
///   list, so that page's header holds it.
/// - `.pageBar`: Activity and Chats alone (Settings too without an account),
///   for the projects page's top bar where there is no edge bar (the inner
///   display held upright, an iPad). Held upright the overview page's bar
///   beside the status bar has room for one item, the account, so the caller
///   puts it there and adds Add after these.
struct HubToolbar: ToolbarContent {
  enum Form { case bar, rail, pageBar }

  let form: Form
  let actions: HubToolbarActions
  /// The roster filter, as a menu in the bar for a layout without the phone's
  /// filter row.
  var filter: Binding<HubRosterFilter>?
  var filterCounts: [HubRosterFilter: Int] = [:]
  /// The signed-in account, shown where there is room for it.
  var account: AccountIdentity?
  /// The machines the rail's Machines menu lists (the connection menu's).
  var machines: [DuoHomeMachine] = []

  var body: some ToolbarContent {
    switch form {
    case .rail:
      if let account {
        // A system label, so it joins the edge bar; no glass behind it, so
        // the picture itself is the circle.
        ToolbarItem(placement: .topBarTrailing) {
          HubRailAccountButton(identity: account, action: actions.onOpenSettings)
        }
        .sharedBackgroundVisibility(.hidden)
        ToolbarSpacer(.fixed, placement: .topBarTrailing)
      }
      activityAndChats
      ToolbarItemGroup(placement: .bottomBar) {
        HubRailMachinesMenu(machines: machines, onOpenSettings: actions.onOpenSettings)
        Button(action: actions.onOpenSettings) {
          Label("Settings", systemImage: "gearshape")
        }
        .tint(ADEColor.textPrimary)
      }
    case .pageBar:
      activityAndChats
    case .bar:
      ToolbarItemGroup(placement: .topBarTrailing) {
        HubActivityToolbarButton(action: actions.onOpenActivity)
        chatsButton
      }
      ToolbarSpacer(.fixed, placement: .topBarTrailing)
      ToolbarItemGroup(placement: .topBarTrailing) {
        if let filter {
          HubFilterMenu(filter: filter, counts: filterCounts)
        }
        addButton
          .tint(ADEColor.textPrimary)
        settingsButton
      }
      if let account {
        ToolbarItem(placement: .topBarTrailing) {
          HubAccountButton(identity: account, action: actions.onOpenSettings)
        }
        .sharedBackgroundVisibility(.hidden)
      }
    }
  }

  private var activityAndChats: some ToolbarContent {
    ToolbarItemGroup(placement: .topBarTrailing) {
      HubActivityToolbarButton(action: actions.onOpenActivity)
      chatsButton
      // Without an account picture to stand for it, Settings joins them.
      if account == nil && form != .rail {
        settingsButton
      }
    }
  }

  private var addButton: some View {
    Button(action: actions.onAdd) {
      Label("Add project", systemImage: "plus")
    }
  }

  private var settingsButton: some View {
    Button(action: actions.onOpenSettings) {
      Label("Settings", systemImage: "gearshape")
    }
    .tint(ADEColor.textPrimary)
  }

  // Chats live behind a toolbar button rather than a card in the list (M13);
  // the badge counts chats awaiting input.
  private var chatsButton: some View {
    Button(action: actions.onOpenChats) {
      Label("Chats", systemImage: "bubble.left.and.bubble.right")
    }
    .badge(actions.chatsAvailable ? actions.chatsAttentionCount : 0)
    .tint(ADEColor.textPrimary)
    .disabled(!actions.chatsAvailable)
    .accessibilityLabel(actions.chatsAttentionCount > 0
      ? "Chats, \(actions.chatsAttentionCount) awaiting input"
      : "Chats")
    .accessibilityHint("Opens conversations that are not linked to a project.")
  }
}

/// Activity, badged with what needs the user. Its own view so the badge
/// follows the drawer without redrawing the screen that hosts it.
struct HubActivityToolbarButton: View {
  @EnvironmentObject private var drawer: ActivityDrawerModel
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Label("Activity", systemImage: "bell")
    }
    // Monochrome, like the rest of the bar; colour is for the badge.
    .tint(ADEColor.textPrimary)
    .badge(drawer.unreadCount)
    .accessibilityLabel(
      drawer.unreadCount > 0
        ? "Activity, \(drawer.unreadCount) \(drawer.unreadCount == 1 ? "item needs" : "items need") you"
        : "Activity"
    )
    .accessibilityHint("Opens the Activity drawer.")
  }
}

/// The roster filter as a toolbar menu: All / Working / Needs you / Finished,
/// with counts. The same filter the phone's chip row sets.
struct HubFilterMenu: View {
  @Binding var filter: HubRosterFilter
  let counts: [HubRosterFilter: Int]

  var body: some View {
    Menu {
      Picker("Show", selection: $filter) {
        ForEach(HubRosterFilter.allCases) { option in
          Text(option.title)
            .badge(counts[option] ?? 0)
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
    // Monochrome until a filter is on, then the accent says the list is
    // narrowed.
    .tint(filter == .all ? ADEColor.textPrimary : ADEColor.accent)
    .accessibilityLabel("Show \(filter.title)")
  }
}

/// The rail's Machines button: the machine list the connection menu has
/// always shown, behind a desktop glyph with how many machines are connected
/// under it.
struct HubRailMachinesMenu: View {
  let machines: [DuoHomeMachine]
  let onOpenSettings: () -> Void

  private var liveCount: Int { machines.filter(\.isLive).count }

  var body: some View {
    Menu {
      HubMachinesMenuContent(machines: machines, onOpenSettings: onOpenSettings)
    } label: {
      Label {
        Text("Machines")
      } icon: {
        HubRailCountGlyph(
          symbol: liveCount == 0
            ? "desktopcomputer.trianglebadge.exclamationmark"
            : liveCount > 1 ? "desktopcomputer.and.macbook" : "desktopcomputer",
          count: liveCount
        )
      }
    }
    .tint(ADEColor.textPrimary)
    .accessibilityLabel("Machines, \(liveCount) connected")
    .accessibilityHint("Shows your machines and connection settings.")
  }
}

/// A glyph with a count under it, rendered once per change into a template
/// image: the edge bar only keeps a system label in its capsules and draws a
/// label's icon as one image, so the count rides inside it rather than as a
/// red badge.
struct HubRailCountGlyph: View {
  let symbol: String
  let count: Int
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    if let image = rendered {
      Image(uiImage: image)
    } else {
      Image(systemName: symbol)
    }
  }

  @MainActor
  private var rendered: UIImage? {
    let renderer = ImageRenderer(content:
      VStack(spacing: 1) {
        Image(systemName: symbol)
          .font(.system(size: 16, weight: .medium))
          .frame(height: 19)
        Text(count > 99 ? "99+" : "\(count)")
          .font(.system(size: 11, weight: .semibold))
          .monospacedDigit()
          .lineLimit(1)
          .fixedSize()
      }
      .foregroundStyle(.black)
      .frame(minWidth: 24)
    )
    renderer.scale = displayScale
    return renderer.uiImage?.withRenderingMode(.alwaysTemplate)
  }
}

/// The account's picture as the edge bar's first item, filling its circle the
/// way an avatar does. The bar only takes a system label into its column and
/// draws a label's icon as an image, so the picture is rendered into one: the
/// photo once it has loaded (the same URL, from the same cache, the Settings
/// avatar reads), the initials until then.
struct HubRailAccountButton: View {
  let identity: AccountIdentity
  let action: () -> Void
  @State private var photo: UIImage?
  @Environment(\.displayScale) private var displayScale

  var body: some View {
    Button(action: action) {
      Label {
        Text("Account")
      } icon: {
        if let image = rendered {
          Image(uiImage: image)
        } else {
          Image(systemName: "person.crop.circle.fill")
        }
      }
    }
    .accessibilityLabel("Account: \(identity.displayName)")
    .accessibilityHint("Opens Settings.")
    .task(id: identity.imageURL) {
      guard let url = identity.imageURL,
            let (data, _) = try? await URLSession.shared.data(from: url),
            let image = UIImage(data: data) else { return }
      photo = image
    }
  }

  private var initials: String {
    let letters = identity.displayName.split(separator: " ").prefix(2).compactMap(\.first)
    let text = String(letters).uppercased()
    return text.isEmpty ? "AD" : text
  }

  @MainActor
  private var rendered: UIImage? {
    let renderer = ImageRenderer(content:
      ZStack {
        Circle().fill(identity.accent.opacity(0.22))
        if let photo {
          Image(uiImage: photo).resizable().aspectRatio(contentMode: .fill)
        } else {
          Text(initials)
            .font(.system(size: 15, weight: .bold, design: .rounded))
            .foregroundStyle(identity.accent)
        }
      }
      .frame(width: 40, height: 40)
      .clipShape(Circle())
      .overlay(Circle().stroke(identity.accent.opacity(0.35), lineWidth: 1))
    )
    renderer.scale = displayScale
    return renderer.uiImage?.withRenderingMode(.alwaysOriginal)
  }
}

/// The signed-in account's picture. Opens Settings, where the account lives.
struct HubAccountButton: View {
  let identity: AccountIdentity
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      AccountAvatar(identity: identity)
        .scaleEffect(34.0 / 44.0)
        .frame(width: 34, height: 34)
    }
    .buttonStyle(.plain)
    .accessibilityLabel("Account: \(identity.displayName)")
    .accessibilityHint("Opens Settings.")
  }
}

// MARK: - Connection

/// What the Hub's title says about the connection: the machine (or how many),
/// its state, and a project switching in.
struct HubConnectionStatus: Equatable {
  var tone: ADEKitTone
  var label: String
  var spokenState: String
  /// A project switching in replaces the label with progress.
  var switchingProjectName: String?

  var accessibilityLabel: String {
    if let switchingProjectName { return "Opening \(switchingProjectName)" }
    return "Machine connection: \(label), \(spokenState)"
  }
}

@MainActor
func hubConnectionStatus(
  syncService: SyncService,
  machineFleet: MachineFleet,
  account: AccountService
) -> HubConnectionStatus {
  let health = syncService.connectionHealth
  let tone: ADEKitTone = switch health.transport {
  case .connected: health.load == .strained ? .warn : .ok
  case .connecting: .warn
  case .unreachable: .crit
  case .disconnected: .neutral
  }
  let transportWord = switch health.transport {
  case .connected: "Connected"
  case .connecting: "Connecting…"
  case .unreachable: "Unreachable"
  case .disconnected: "Offline"
  }
  let spokenState = switch health.transport {
  case .connected: "connected"
  case .connecting: "connecting"
  case .unreachable: "unreachable"
  case .disconnected: "offline"
  }
  // The machine we're attached to, or — while an attempt is in flight or has
  // just failed — the one that attempt targeted.
  let machineName = syncConnectionSubjectMachineName(
    transport: health.transport,
    attemptMachineName: syncService.connectAttemptTarget.flatMap {
      accountMachinePresentationName(
        hostIdentity: $0.machineIdentity,
        fallback: $0.machineName,
        machines: account.machines
      )
    },
    hostDisplayName: syncService.focusedMachineAccountName
  )
  // Above one live machine the title counts them instead of naming one; only
  // while the primary is attached, so a connect in flight or a failure names
  // the machine it is about.
  let liveCount = (health.transport == .connected ? 1 : 0)
    + machineFleet.machines.filter { $0.state == .live }.count
  let label = health.transport == .connected && liveCount > 1
    ? "\(liveCount) machines"
    : machineName ?? transportWord
  let switching = syncService.isProjectSwitching
    ? syncService.projects.first(where: { syncService.isSwitchingProject($0) })?.displayName
    : nil
  return HubConnectionStatus(
    tone: tone,
    label: label,
    spokenState: spokenState,
    switchingProjectName: switching
  )
}

private struct HubConnectionTitleCompactKey: EnvironmentKey {
  static let defaultValue = false
}

extension EnvironmentValues {
  /// The Hub's title drops the machine's name and keeps the brand and the
  /// status dot: a narrow page whose bar also holds Activity, Chats and Add.
  /// The name stays in the title's menu (and the Machines widget).
  var hubConnectionTitleCompact: Bool {
    get { self[HubConnectionTitleCompactKey.self] }
    set { self[HubConnectionTitleCompactKey.self] = newValue }
  }
}

/// The Hub's title: the brand, then the connection, as one toolbar item whose
/// menu lists every machine and opens connection settings.
struct HubConnectionMenu: View {
  let status: HubConnectionStatus
  let machines: [DuoHomeMachine]
  let onOpenSettings: () -> Void
  @Environment(\.hubConnectionTitleCompact) private var compact

  var body: some View {
    Menu {
      HubMachinesMenuContent(machines: machines, onOpenSettings: onOpenSettings)
    } label: {
      HStack(spacing: 8) {
        Image("BrandMark")
          .resizable()
          .renderingMode(.original)
          .interpolation(.high)
          .aspectRatio(contentMode: .fit)
          .frame(width: 38, height: 21)
          .accessibilityHidden(true)
        Group {
          if let switching = status.switchingProjectName {
            HStack(spacing: 6) {
              ProgressView().controlSize(.mini)
              if !compact {
                Text("Opening \(switching)…")
              }
            }
            .id("switching")
          } else {
            HStack(spacing: 6) {
              ADEKitDot(tone: status.tone, size: 7)
              if !compact {
                Text(status.label)
              }
            }
            .id("machine")
          }
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
        .lineLimit(1)
        .transition(.opacity)
      }
      .padding(.horizontal, 6)
      .animation(.easeInOut(duration: 0.25), value: status.switchingProjectName)
    }
    .accessibilityLabel(status.accessibilityLabel)
    .accessibilityHint("Shows your machines and connection settings.")
  }
}

/// The machine list the Hub's connection menu (and the Duo rail's Machines
/// button) shows: each machine with its state, then connection settings.
struct HubMachinesMenuContent: View {
  let machines: [DuoHomeMachine]
  let onOpenSettings: () -> Void

  var body: some View {
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
  }
}

/// `HubConnectionMenu` over the live connection and fleet.
struct HubLiveConnectionMenu: View {
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var machineFleet: MachineFleet
  @ObservedObject private var account = AccountService.shared

  var body: some View {
    HubConnectionMenu(
      status: hubConnectionStatus(syncService: syncService, machineFleet: machineFleet, account: account),
      machines: duoHomeMachines(syncService: syncService, fleet: machineFleet),
      onOpenSettings: { syncService.settingsPresented = true }
    )
  }
}

// MARK: - Project card

struct HubProjectPresentation: Equatable, Identifiable {
  let project: MobileProjectSummary
  let isActive: Bool
  let isSwitching: Bool
  let isLoading: Bool
  let laneCount: Int
  let chatCount: Int
  let lanes: [HubLanePresentation]
  /// Chats on this project awaiting input, and chats currently producing. Both
  /// were computed by the roster and used only as a sort tiebreak until now.
  let attentionCount: Int
  let runningCount: Int
  /// "6 lanes", and nothing else. The chat clause that used to follow it said
  /// the same thing twice: the header already draws a glyph-and-count per state,
  /// and those sum to the chat count, so "6 lanes · 7 chats" printed a total
  /// beside its own breakdown.
  let metaLine: String
  /// "2 need you · 3 working", or nil when the project is quiet — the same
  /// tally the card header renders, written out.
  ///
  /// No longer what the header draws: it shows `HubStateSummary` (glyph +
  /// count), whose VoiceOver line is composed from the canonical state labels so
  /// the project card and the lane header below it speak identically. This stays
  /// as the sentence form for a caller that wants words, and because the counts
  /// reaching the card at all is a locked contract.
  let statusLine: String?
  fileprivate let renderSignature: Int

  var id: String { project.id }

  /// The card header's glyph-and-count summary: the whole project's chats,
  /// broken down by state.
  ///
  /// Tallied from the lane tree rather than from `attentionCount` /
  /// `runningCount`, which are the only two totals the roster projects — those
  /// two can say how many are waiting or running but never that the rest are
  /// idle, so a project with nothing live rendered no summary and, once the chat
  /// clause left `metaLine`, nothing at all.
  ///
  /// Collapse-safe by construction: the tree is built from the roster in
  /// `buildHubProjectPresentation`, so folding the card away changes what is
  /// drawn and never what is counted. Child rows are counted too — see
  /// `HubChatRowPresentation.accumulateStateTally`.
  var stateCounts: [HubStateCount] {
    var tally: [ActivityBoardColumn: Int] = [:]
    for lane in lanes { lane.accumulateStateTally(into: &tally) }
    return hubTreeStateCounts(tally)
  }

  init(
    project: MobileProjectSummary,
    isActive: Bool,
    isSwitching: Bool,
    isLoading: Bool,
    laneCount: Int,
    chatCount: Int,
    lanes: [HubLanePresentation],
    attentionCount: Int = 0,
    runningCount: Int = 0
  ) {
    self.project = project
    self.isActive = isActive
    self.isSwitching = isSwitching
    self.isLoading = isLoading
    self.laneCount = laneCount
    self.chatCount = chatCount
    self.lanes = lanes
    self.attentionCount = attentionCount
    self.runningCount = runningCount
    self.metaLine = "\(laneCount) lane\(laneCount == 1 ? "" : "s")"
    self.statusLine = hubProjectStatusLine(
      attentionCount: attentionCount,
      runningCount: runningCount
    )
    self.renderSignature = hubProjectRenderSignature(
      project: project,
      isActive: isActive,
      isSwitching: isSwitching,
      isLoading: isLoading,
      laneCount: laneCount,
      chatCount: chatCount,
      lanes: lanes,
      attentionCount: attentionCount,
      runningCount: runningCount
    )
  }

  static func == (lhs: HubProjectPresentation, rhs: HubProjectPresentation) -> Bool {
    lhs.renderSignature == rhs.renderSignature
  }
}

struct HubLanePresentation: Equatable, Identifiable {
  let lane: RemoteRosterLane
  let rows: [HubChatRowPresentation]
  let totalCount: Int
  fileprivate let renderSignature: Int

  var id: String { lane.id }

  /// The lane header's glyph-and-count summary: one clause per state present,
  /// resting bands included.
  ///
  /// Every state, not just the live ones, because this summary is now the only
  /// thing the divider says about its rows — the total that used to sit beside
  /// it is gone. Dropping `done` here would leave a lane of quiet
  /// chats with a blank header instead of the count it used to carry.
  ///
  /// Computed rather than stored, and deliberately outside `renderSignature`:
  /// every input is a row `boardState`, which each row's own signature already
  /// covers, so a stored copy could only ever be a second thing to keep in sync.
  var stateCounts: [HubStateCount] {
    var tally: [ActivityBoardColumn: Int] = [:]
    accumulateStateTally(into: &tally)
    return hubTreeStateCounts(tally)
  }

  /// Adds this lane's whole subtree to a running tally, so the project card can
  /// sum its lanes instead of re-walking the tree with its own rules and
  /// arriving at a number the divider below it contradicts.
  func accumulateStateTally(into tally: inout [ActivityBoardColumn: Int]) {
    for row in rows { row.accumulateStateTally(into: &tally) }
  }

  init(
    lane: RemoteRosterLane,
    rows: [HubChatRowPresentation],
    totalCount: Int
  ) {
    self.lane = lane
    self.rows = rows
    self.totalCount = totalCount
    self.renderSignature = hubLaneRenderSignature(
      lane: lane,
      rows: rows,
      totalCount: totalCount
    )
  }

  static func == (lhs: HubLanePresentation, rhs: HubLanePresentation) -> Bool {
    lhs.renderSignature == rhs.renderSignature
  }
}

struct HubChatRowPresentation: Equatable, Identifiable {
  let chat: RemoteRosterChat
  let title: String
  let preview: String?
  let providerKey: String?
  let activityLabel: String?
  let statusString: String
  /// Which board column this row is in — the four states the Activity drawer,
  /// the widgets and the Live Activity all count by.
  ///
  /// Derived from the chat and its lane, not from `statusString`: that string
  /// files a failed session under the same "ended" bucket as a clean one, and
  /// cannot see the lane's pull request.
  let boardState: HubChatBoardState
  let childRows: [HubChatRowPresentation]
  fileprivate let renderSignature: Int

  var id: String { chat.id }
  var childCount: Int { childRows.count }

  /// Adds this row and everything nested under it to a header's tally.
  ///
  /// Children are counted even though the tree does not draw them: a CLI session
  /// spawned from a chat is folded into its parent row, so counting only the
  /// top level is how a run that needs you goes unreported on both the lane
  /// divider and the project card.
  func accumulateStateTally(into tally: inout [ActivityBoardColumn: Int]) {
    tally[boardState.column, default: 0] += 1
    for child in childRows { child.accumulateStateTally(into: &tally) }
  }

  init(
    chat: RemoteRosterChat,
    lane: RemoteRosterLane?,
    title: String,
    preview: String?,
    providerKey: String?,
    activityLabel: String?,
    statusString: String,
    childRows: [HubChatRowPresentation]
  ) {
    self.chat = chat
    self.title = title
    self.preview = preview
    self.providerKey = providerKey
    self.activityLabel = activityLabel
    self.statusString = statusString
    // Not an init parameter: it is a pure function of the chat and its lane,
    // and a caller that could pass a different one is a caller that could make
    // the mark disagree with the row it sits on.
    let boardState = hubChatBoardState(chat, lane: lane)
    self.boardState = boardState
    self.childRows = childRows
    self.renderSignature = hubChatRowRenderSignature(
      chat: chat,
      title: title,
      preview: preview,
      providerKey: providerKey,
      activityLabel: activityLabel,
      statusString: statusString,
      boardState: boardState,
      childRows: childRows
    )
  }

  static func make(
    chat: RemoteRosterChat,
    lane: RemoteRosterLane? = nil,
    childRows: [HubChatRowPresentation] = []
  ) -> HubChatRowPresentation {
    let trimmedTitle = chat.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let trimmedPreview = chat.preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return HubChatRowPresentation(
      chat: chat,
      lane: lane,
      title: trimmedTitle.isEmpty ? "Untitled chat" : trimmedTitle,
      preview: trimmedPreview.isEmpty ? nil : trimmedPreview,
      providerKey: chat.providerKey,
      activityLabel: hubRelativeTimestamp(chat.lastActivityAt),
      statusString: chat.normalizedStatusString,
      childRows: childRows
    )
  }

  static func == (lhs: HubChatRowPresentation, rhs: HubChatRowPresentation) -> Bool {
    lhs.renderSignature == rhs.renderSignature
  }
}

private func hubProjectRenderSignature(
  project: MobileProjectSummary,
  isActive: Bool,
  isSwitching: Bool,
  isLoading: Bool,
  laneCount: Int,
  chatCount: Int,
  lanes: [HubLanePresentation],
  attentionCount: Int,
  runningCount: Int
) -> Int {
  var hasher = Hasher()
  hasher.combine(attentionCount)
  hasher.combine(runningCount)
  hasher.combine(project.id)
  hasher.combine(project.displayName)
  hasher.combine(hubProjectIconSignature(project.iconDataUrl))
  hasher.combine(project.laneCount)
  hasher.combine(project.isOpen)
  hasher.combine(isActive)
  hasher.combine(isSwitching)
  hasher.combine(isLoading)
  hasher.combine(laneCount)
  hasher.combine(chatCount)
  hasher.combine(lanes.map(\.renderSignature))
  return hasher.finalize()
}

/// Sentence-case, count-first, and silent when there is nothing to report —
/// "0 need you" is filler that trains people to stop reading the line.
func hubProjectStatusLine(attentionCount: Int, runningCount: Int) -> String? {
  var clauses: [String] = []
  if attentionCount > 0 { clauses.append("\(attentionCount) need you") }
  if runningCount > 0 { clauses.append("\(runningCount) working") }
  return clauses.isEmpty ? nil : clauses.joined(separator: " · ")
}

private func hubProjectIconSignature(_ dataUrl: String?) -> String {
  guard let dataUrl, !dataUrl.isEmpty else { return "" }
  let byteCount = dataUrl.utf8.count
  let prefix = String(dataUrl.prefix(32))
  let suffix = byteCount > 32 ? String(dataUrl.suffix(32)) : ""
  return "\(byteCount)|\(prefix)|\(suffix)"
}

private func hubLaneRenderSignature(
  lane: RemoteRosterLane,
  rows: [HubChatRowPresentation],
  totalCount: Int
) -> Int {
  var hasher = Hasher()
  hasher.combine(lane.id)
  hasher.combine(lane.name)
  hasher.combine(lane.color)
  hasher.combine(lane.icon)
  hasher.combine(lane.emoji)
  hasher.combine(totalCount)
  hasher.combine(rows.map(\.renderSignature))
  return hasher.finalize()
}

private func hubChatRowRenderSignature(
  chat: RemoteRosterChat,
  title: String,
  preview: String?,
  providerKey: String?,
  activityLabel: String?,
  statusString: String,
  boardState: HubChatBoardState,
  childRows: [HubChatRowPresentation]
) -> Int {
  var hasher = Hasher()
  hasher.combine(chat.id)
  hasher.combine(chat.laneId)
  hasher.combine(chat.chatSessionId)
  hasher.combine(title)
  hasher.combine(preview)
  hasher.combine(providerKey)
  hasher.combine(activityLabel)
  hasher.combine(statusString)
  // Hashed on its own even though `statusString` is here: the two states that
  // string cannot tell apart — a clean end and a failed one — are the two whose
  // marks differ most, so a run that crashed under a row that had ended would
  // keep the wrong glyph until some unrelated field moved.
  hasher.combine(boardState)
  hasher.combine(chat.pinned)
  hasher.combine(chat.archived)
  hasher.combine(chat.lastActivityAt)
  hasher.combine(chat.snoozedUntil)
  hasher.combine(chat.snoozedAt)
  hasher.combine(chat.launchRail)
  hasher.combine(childRows.map(\.renderSignature))
  return hasher.finalize()
}

func buildHubProjectPresentation(
  project: MobileProjectSummary,
  roster: RemoteRosterProject?,
  isActive: Bool,
  isSwitching: Bool
) -> HubProjectPresentation {
  guard let roster else {
    return HubProjectPresentation(
      project: project,
      isActive: isActive,
      isSwitching: isSwitching,
      isLoading: isActive,
      laneCount: project.laneCount,
      chatCount: 0,
      lanes: []
    )
  }

  let safeRoster = roster.excludingIdentityChats()
  let laneById = Dictionary(safeRoster.lanes.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
  let visibleChats = safeRoster.chats.filter { chat in
    chat.archived != true && laneById[chat.laneId] != nil
  }
  let chatToolIds = Set(visibleChats.filter(\.isChatTool).map(\.id))
  // A row is a child only when it is a non-chat-tool row whose parent is a
  // visible chat-tool row. Everything else (including standalone CLI rows that
  // have no valid chat parent) must remain a top-level entry so it stays visible.
  func isChildRow(_ chat: RemoteRosterChat) -> Bool {
    guard !chat.isChatTool,
          let parentId = chat.chatSessionId?.trimmingCharacters(in: .whitespacesAndNewlines),
          !parentId.isEmpty,
          parentId != chat.id
    else { return false }
    return chatToolIds.contains(parentId)
  }
  let childRowsByParentId = Dictionary(grouping: visibleChats.filter(isChildRow), by: { $0.chatSessionId ?? "" })
    .mapValues { chats in
      chats
        .sorted { ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "") }
        .map { HubChatRowPresentation.make(chat: $0, lane: laneById[$0.laneId]) }
    }
  let topLevelChats = visibleChats.filter { !isChildRow($0) }
  let topLevelChatsByLane = Dictionary(grouping: topLevelChats, by: \.laneId)

  let lanes = safeRoster.lanes.compactMap { lane -> HubLanePresentation? in
    let laneChats = (topLevelChatsByLane[lane.id] ?? [])
      .sorted { ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "") }
    guard !laneChats.isEmpty else { return nil }
    let rows = laneChats.map { chat in
      HubChatRowPresentation.make(chat: chat, lane: lane, childRows: childRowsByParentId[chat.id] ?? [])
    }
    return HubLanePresentation(
      lane: lane,
      rows: rows,
      totalCount: rows.count
    )
  }
  let chatCount = lanes.reduce(0) { $0 + $1.rows.count }

  return HubProjectPresentation(
    project: project,
    isActive: isActive,
    isSwitching: isSwitching,
    isLoading: false,
    laneCount: safeRoster.lanes.count,
    chatCount: chatCount,
    lanes: lanes,
    attentionCount: hubLaneColumnCount(lanes, .needsYou),
    runningCount: hubLaneColumnCount(lanes, .working)
  )
}

struct HubProjectCard: View, Equatable {
  let presentation: HubProjectPresentation
  let isCollapsed: Bool
  let collapsedLaneKeysSnapshot: Set<String>
  @Binding var collapsedLaneKeys: Set<String>
  var allowsCollapse: Bool = true
  let onToggleCollapse: () -> Void
  let onOpenProject: () -> Void
  let onOpenChat: (RemoteRosterChat, RemoteRosterLane?) -> Void
  let onViewLaneInWork: (RemoteRosterLane) -> Void
  let onViewLaneInLanes: (RemoteRosterLane) -> Void
  let onArchiveChat: (RemoteRosterChat) -> Void
  let onDeleteChat: (RemoteRosterChat) -> Void
  let onForget: () -> Void

  private var project: MobileProjectSummary { presentation.project }
  private var hasExpandableContent: Bool { !presentation.lanes.isEmpty }

  var body: some View {
    // One quiet kit card per project: the project row on top, its lanes and
    // chats indented beneath a hairline when expanded.
    VStack(alignment: .leading, spacing: 0) {
      header

      if hasExpandableContent && !isCollapsed {
        Rectangle()
          .fill(ADEKit.rule)
          .frame(height: 0.75)
          .padding(.horizontal, 12)
        VStack(alignment: .leading, spacing: 6) {
          ForEach(presentation.lanes) { lanePresentation in
            HubLaneSection(
              project: project,
              presentation: lanePresentation,
              isCollapsed: collapsedLaneKeysSnapshot.contains(laneKey(lanePresentation.lane)),
              allowsCollapse: allowsCollapse,
              onToggle: { toggleLane(lanePresentation.lane) },
              onOpenChat: { chat in onOpenChat(chat, lanePresentation.lane) },
              onViewInWork: { onViewLaneInWork(lanePresentation.lane) },
              onViewInLanes: { onViewLaneInLanes(lanePresentation.lane) },
              onArchiveChat: onArchiveChat,
              onDeleteChat: onDeleteChat
            )
            .equatable()
          }
        }
        .padding(.leading, 18)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
      }
    }
    .adeKitCard(padding: nil)
    .overlay {
      // The accent marks the one selected thing: the project open on the phone.
      if presentation.isActive {
        RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous)
          .strokeBorder(ADEColor.accent.opacity(0.45), lineWidth: 1)
      }
    }
  }

  private var header: some View {
    HStack(spacing: 10) {
      if hasExpandableContent {
        Button(action: onToggleCollapse) {
          Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 18, height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!allowsCollapse)
        .accessibilityHidden(!allowsCollapse)
        .accessibilityLabel(isCollapsed ? "Expand project" : "Collapse project")
      } else {
        Color.clear
          .frame(width: 18, height: 28)
          .accessibilityHidden(true)
      }

      HubProjectIcon(iconDataUrl: project.iconDataUrl, isActive: presentation.isActive, size: 28)

      // Tapping the title area opens the full project tabs.
      Button(action: onOpenProject) {
        Text(project.displayName)
          .font(.system(size: 15.5, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      // The state breakdown stacked over the lane count, on the trailing edge.
      VStack(alignment: .trailing, spacing: 2) {
        // Gated: a stack applies its spacing around an empty child. Bound to a
        // local because `stateCounts` walks the whole lane tree on each ask.
        let stateCounts = presentation.stateCounts
        if !stateCounts.isEmpty {
          HubStateSummary(counts: stateCounts)
        }

        Text(presentation.metaLine)
          .font(.system(size: 11))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
          .fixedSize()
      }

      if presentation.isSwitching {
        ProgressView().controlSize(.small)
          .frame(width: 24, height: 28)
      } else {
        Button(action: onOpenProject) {
          ADESettingsChevron()
            .frame(width: 24, height: 28)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(project.displayName)")
        .accessibilityHint("Opens the full project view.")
      }
    }
    .padding(.leading, 6)
    .padding(.trailing, 8)
    .padding(.vertical, 10)
    .contentShape(Rectangle())
    .contextMenu {
      Button { onOpenProject() } label: { Label("Open project", systemImage: "rectangle.stack") }
      Button(role: .destructive, action: onForget) { Label("Remove from list", systemImage: "trash") }
    }
  }

  private func laneKey(_ lane: RemoteRosterLane) -> String { "\(project.id)/\(lane.id)" }
  private func toggleLane(_ lane: RemoteRosterLane) {
    guard allowsCollapse else { return }
    let key = laneKey(lane)
    withAnimation(.easeOut(duration: 0.16)) {
      if collapsedLaneKeys.contains(key) { collapsedLaneKeys.remove(key) } else { collapsedLaneKeys.insert(key) }
    }
  }

  private var collapsedLaneSignature: [String] {
    let relevantKeys = presentation.lanes.map { laneKey($0.lane) }
    return relevantKeys.filter { collapsedLaneKeysSnapshot.contains($0) }.sorted()
  }

  static func == (lhs: HubProjectCard, rhs: HubProjectCard) -> Bool {
    lhs.presentation == rhs.presentation
      && lhs.isCollapsed == rhs.isCollapsed
      && lhs.allowsCollapse == rhs.allowsCollapse
      && lhs.collapsedLaneSignature == rhs.collapsedLaneSignature
  }
}

// MARK: - Project grid

/// The Hub's projects as a grid of square-ish tiles: two across on a phone and
/// the closed Duo, three (or more, as width allows) on the Duo's projects page
/// and an iPad. Each tile is the row's data and actions in a card: tapping it
/// opens the project, its corner button lists the project's lanes and chats.
enum HubProjectGridMetrics {
  /// The narrowest a tile gets before the grid drops a column.
  static let minTileWidth: CGFloat = 128
  static let spacing: CGFloat = 12
  static let tileHeight: CGFloat = 138

  static var columns: [GridItem] {
    [GridItem(.adaptive(minimum: minTileWidth), spacing: spacing, alignment: .top)]
  }
}

/// One project as a grid tile: its icon, name (two lines at most), how its
/// agents stand (the coloured per-state counts), its lane count, and the open
/// chevron. The whole tile opens the project; the corner button shows its
/// chats.
struct HubProjectTile: View, Equatable {
  let presentation: HubProjectPresentation
  let collapsedLaneKeysSnapshot: Set<String>
  @Binding var collapsedLaneKeys: Set<String>
  var allowsCollapse: Bool = true
  let onOpenProject: () -> Void
  let onOpenChat: (RemoteRosterChat, RemoteRosterLane?) -> Void
  let onViewLaneInWork: (RemoteRosterLane) -> Void
  let onViewLaneInLanes: (RemoteRosterLane) -> Void
  let onArchiveChat: (RemoteRosterChat) -> Void
  let onDeleteChat: (RemoteRosterChat) -> Void
  let onForget: () -> Void

  @State private var chatsShown = false

  private var project: MobileProjectSummary { presentation.project }
  private var hasChats: Bool { !presentation.lanes.isEmpty }

  var body: some View {
    Button(action: onOpenProject) {
      VStack(alignment: .leading, spacing: 0) {
        HubProjectIcon(iconDataUrl: project.iconDataUrl, isActive: presentation.isActive, size: 34)
        Spacer(minLength: 8)
        Text(project.displayName)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(2)
          .multilineTextAlignment(.leading)
          .frame(maxWidth: .infinity, alignment: .leading)
        Spacer(minLength: 6)
        // Bound to a local because `stateCounts` walks the whole lane tree.
        let stateCounts = presentation.stateCounts
        HStack(alignment: .lastTextBaseline, spacing: 6) {
          VStack(alignment: .leading, spacing: 3) {
            if stateCounts.isEmpty {
              Text("No agents")
                .font(.caption2.weight(.medium))
                .foregroundStyle(ADEColor.textMuted)
            } else {
              HubStateSummary(counts: stateCounts)
            }
            Text(presentation.metaLine)
              .font(.system(size: 11))
              .foregroundStyle(ADEColor.textMuted)
              .lineLimit(1)
          }
          Spacer(minLength: 4)
          if presentation.isSwitching {
            ProgressView().controlSize(.small)
          } else {
            ADESettingsChevron()
          }
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, minHeight: HubProjectGridMetrics.tileHeight,
             maxHeight: HubProjectGridMetrics.tileHeight, alignment: .topLeading)
      .adeKitCard(padding: nil)
      .overlay {
        // The accent marks the one selected thing: the project open on the phone.
        if presentation.isActive {
          RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous)
            .strokeBorder(ADEColor.accent.opacity(0.45), lineWidth: 1)
        }
      }
      .contentShape(RoundedRectangle(cornerRadius: ADEKit.radius, style: .continuous))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(tileSpokenLabel)
    .accessibilityHint("Opens the full project view.")
    // Outside the open button, so a tap on it never also opens the project.
    .overlay(alignment: .topTrailing) {
      if hasChats {
        Button {
          chatsShown = true
        } label: {
          Image(systemName: "list.bullet")
            .font(.system(size: 13, weight: .semibold))
            .frame(width: 30, height: 30)
        }
        .buttonStyle(.glass)
        .buttonBorderShape(.circle)
        .tint(ADEColor.textPrimary)
        .padding(8)
        .accessibilityLabel("Show chats in \(project.displayName)")
        .popover(isPresented: $chatsShown, arrowEdge: .bottom) {
          HubProjectChatsPanel(
            presentation: presentation,
            collapsedLaneKeysSnapshot: collapsedLaneKeysSnapshot,
            collapsedLaneKeys: $collapsedLaneKeys,
            allowsCollapse: allowsCollapse,
            onOpenProject: { chatsShown = false; onOpenProject() },
            onOpenChat: { chat, lane in chatsShown = false; onOpenChat(chat, lane) },
            onViewLaneInWork: { lane in chatsShown = false; onViewLaneInWork(lane) },
            onViewLaneInLanes: { lane in chatsShown = false; onViewLaneInLanes(lane) },
            onArchiveChat: onArchiveChat,
            onDeleteChat: onDeleteChat
          )
          .frame(minWidth: 340, idealWidth: 400, minHeight: 280, idealHeight: 460)
          .presentationCompactAdaptation(.sheet)
          .presentationDetents([.medium, .large])
        }
      }
    }
    .contextMenu {
      Button { onOpenProject() } label: { Label("Open project", systemImage: "rectangle.stack") }
      if hasChats {
        Button { chatsShown = true } label: { Label("Show chats", systemImage: "list.bullet") }
      }
      Button(role: .destructive, action: onForget) { Label("Remove from list", systemImage: "trash") }
    }
  }

  private var tileSpokenLabel: String {
    var parts = [project.displayName]
    if !presentation.stateCounts.isEmpty { parts.append(hubStateSummaryLabel(presentation.stateCounts)) }
    parts.append(presentation.metaLine)
    return parts.joined(separator: ", ")
  }

  private var collapsedLaneSignature: [String] {
    presentation.lanes.map { "\(project.id)/\($0.lane.id)" }
      .filter { collapsedLaneKeysSnapshot.contains($0) }
      .sorted()
  }

  static func == (lhs: HubProjectTile, rhs: HubProjectTile) -> Bool {
    lhs.presentation == rhs.presentation
      && lhs.allowsCollapse == rhs.allowsCollapse
      && lhs.collapsedLaneSignature == rhs.collapsedLaneSignature
  }
}

/// A project's lanes and chats, from its tile's corner button: the same lane
/// sections the project row expanded to, under the project's name and Open.
/// A popover beside the tile on a wide screen, a sheet on a phone.
struct HubProjectChatsPanel: View {
  let presentation: HubProjectPresentation
  let collapsedLaneKeysSnapshot: Set<String>
  @Binding var collapsedLaneKeys: Set<String>
  let allowsCollapse: Bool
  let onOpenProject: () -> Void
  let onOpenChat: (RemoteRosterChat, RemoteRosterLane?) -> Void
  let onViewLaneInWork: (RemoteRosterLane) -> Void
  let onViewLaneInLanes: (RemoteRosterLane) -> Void
  let onArchiveChat: (RemoteRosterChat) -> Void
  let onDeleteChat: (RemoteRosterChat) -> Void

  private var project: MobileProjectSummary { presentation.project }

  var body: some View {
    VStack(spacing: 0) {
      HStack(spacing: 10) {
        HubProjectIcon(iconDataUrl: project.iconDataUrl, isActive: presentation.isActive, size: 28)
        VStack(alignment: .leading, spacing: 1) {
          Text(project.displayName)
            .font(.headline)
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          Text(presentation.metaLine)
            .font(.caption)
            .foregroundStyle(ADEColor.textMuted)
        }
        Spacer(minLength: 8)
        Button("Open", action: onOpenProject)
          .buttonStyle(.borderedProminent)
          .buttonBorderShape(.capsule)
          .tint(ADEColor.accent)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 12)
      Divider()
      ScrollView {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(presentation.lanes) { lanePresentation in
            let key = "\(project.id)/\(lanePresentation.lane.id)"
            HubLaneSection(
              project: project,
              presentation: lanePresentation,
              isCollapsed: collapsedLaneKeysSnapshot.contains(key),
              allowsCollapse: allowsCollapse,
              onToggle: {
                guard allowsCollapse else { return }
                withAnimation(.easeOut(duration: 0.16)) {
                  if collapsedLaneKeys.contains(key) { collapsedLaneKeys.remove(key) } else { collapsedLaneKeys.insert(key) }
                }
              },
              onOpenChat: { chat in onOpenChat(chat, lanePresentation.lane) },
              onViewInWork: { onViewLaneInWork(lanePresentation.lane) },
              onViewInLanes: { onViewLaneInLanes(lanePresentation.lane) },
              onArchiveChat: onArchiveChat,
              onDeleteChat: onDeleteChat
            )
            .equatable()
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
      }
    }
    .background(ADEColor.pageBackground)
  }
}

struct HubProjectIcon: View {
  let iconDataUrl: String?
  let isActive: Bool
  // The real project logo art is already a rounded-square glyph, so we render it
  // edge-to-edge at this size. Without one, a quiet neutral tile with a folder
  // glyph stands in (accent only on the active project).
  var size: CGFloat = 22

  var body: some View {
    if let image = projectIconImage(from: iconDataUrl) {
      Image(uiImage: image).projectIconStyle(size: size, cornerRadius: size * 0.24)
    } else {
      RoundedRectangle(cornerRadius: size * 0.24, style: .continuous)
        .fill(ADEKit.track)
        .frame(width: size, height: size)
        .overlay(
          Image(systemName: "folder")
            .font(.system(size: size * 0.46, weight: .regular))
            .foregroundStyle(isActive ? ADEColor.accent : ADEColor.textMuted)
        )
    }
  }
}

// MARK: - Lane section

struct HubLaneSection: View, Equatable {
  let project: MobileProjectSummary
  let presentation: HubLanePresentation
  let isCollapsed: Bool
  var allowsCollapse: Bool = true
  let onToggle: () -> Void
  let onOpenChat: (RemoteRosterChat) -> Void
  let onViewInWork: () -> Void
  let onViewInLanes: () -> Void
  let onArchiveChat: (RemoteRosterChat) -> Void
  let onDeleteChat: (RemoteRosterChat) -> Void

  private var lane: RemoteRosterLane { presentation.lane }
  private var laneTint: Color { LaneColorPalette.displayColor(forHex: lane.color) }

  private var laneIcon: LaneIcon? { lane.icon.flatMap(LaneIcon.init(rawValue:)) }

  private var stateCounts: [HubStateCount] { presentation.stateCounts }

  var body: some View {
    // Mirrors the Work tab's lane section header: chevron, lane logo mark, and
    // the lane name in its own color, with the state breakdown on the trailing
    // edge.
    VStack(alignment: .leading, spacing: 4) {
      Button(action: onToggle) {
        HStack(spacing: 7) {
          Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 10, alignment: .center)
          WorkLaneLogoMark(color: laneTint, laneIcon: laneIcon, emoji: lane.emoji, size: 11)
            .frame(width: 13, height: 13)
          Text(lane.name)
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(laneTint)
            .lineLimit(1)
          if isWorkRemoteLaneId(lane.id) {
            WorkRemoteLaneGlyph()
          }
          Spacer(minLength: 6)
          // The whole trailing edge, in the same glyph+count language as the
          // project header above it. It replaced a live summary followed by a
          // grey total capsule, which printed a breakdown and then its own sum
          // side by side and read as two competing numbers. Gated so a lane with
          // no rows does not pay the HStack's 8pt for an empty child.
          if !stateCounts.isEmpty {
            HubStateSummary(counts: stateCounts)
          }
        }
        .padding(.vertical, 5)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(!allowsCollapse)
      .contextMenu {
        Button { onViewInWork() } label: { Label("View in Work tab", systemImage: "terminal") }
        Button { onViewInLanes() } label: { Label("View in Lanes tab", systemImage: "square.stack.3d.up") }
      }
      .zIndex(1)

      if !isCollapsed {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(presentation.rows) { row in
            HubChatRow(
              row: row,
              laneTint: laneTint,
              onOpen: { onOpenChat(row.chat) },
              onArchive: { onArchiveChat(row.chat) },
              onDelete: { onDeleteChat(row.chat) }
            )
            .equatable()
          }
        }
        .padding(.leading, 10)
        .zIndex(0)
      }
    }
  }

  static func == (lhs: HubLaneSection, rhs: HubLaneSection) -> Bool {
    lhs.project.id == rhs.project.id
      && lhs.presentation == rhs.presentation
      && lhs.isCollapsed == rhs.isCollapsed
      && lhs.allowsCollapse == rhs.allowsCollapse
  }
}

// MARK: - Chat row

struct HubChatRow: View, Equatable {
  let row: HubChatRowPresentation
  let laneTint: Color
  var compact = false
  let onOpen: () -> Void
  let onArchive: () -> Void
  let onDelete: () -> Void
  /// A phone-width column (every iPhone, the Duo's outer display): the state
  /// shows as its glyph alone, so the chat's name gets the room. The word is
  /// still spoken (see the row's accessibility label).
  @Environment(\.horizontalSizeClass) private var horizontalSizeClass

  var body: some View {
    // Provider logo and chat name on the leading edge; state and time together
    // on the trailing edge.
    //
    // The state mark used to sit immediately after the provider logo, which put
    // two glyphs side by side saying different things and left the state
    // separated from the word and the timestamp it belongs with. All three
    // status facts now live in one trailing cluster, so the row reads
    // "who · what" then "how it is going".
    Button(action: onOpen) {
      HStack(spacing: 10) {
        WorkProviderBareLogo(provider: row.providerKey, fallbackSymbol: "terminal", tint: ADEColor.textSecondary, size: compact ? 15 : 17)

        VStack(alignment: .leading, spacing: 4) {
          Text(row.title)
            .font(.system(size: 14))
            .foregroundStyle(ADEColor.textPrimary)
            .lineLimit(1)
          // A chat still being launched into a new lane: the shared setup rail.
          if let rail = row.chat.launchRail, !rail.isEmpty {
            WorkChatLaunchRowRail(segments: rail)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)

        // One cluster, tight spacing: word, mark, time. `.fixedSize()` on the
        // whole group is what stops a long chat name from eating the state —
        // the title's flexible frame above is the only child allowed to give.
        HStack(spacing: 5) {
          if horizontalSizeClass != .compact, let status = row.boardState.label {
            Text(status)
              .font(.system(size: 11, weight: .medium))
              .foregroundStyle(activityToneColor(row.boardState.tone))
              .lineLimit(1)
          }

          HubStateGlyph(state: row.boardState)

          if let activity = row.activityLabel {
            Text(activity)
              .font(.adeMono(10.5))
              .foregroundStyle(ADEColor.textMuted)
          }
        }
        .fixedSize()
      }
      .padding(.horizontal, 6)
      .padding(.vertical, compact ? 5 : 7)
      .contentShape(Rectangle())
    }
    .buttonStyle(ADEKitRowButtonStyle())
    // Always the state word, including the resting ones the row shows as a glyph
    // alone. The button overrides its children's labels, so a mark with no word
    // beside it is silent unless the word is stated here.
    .accessibilityLabel("\(row.title), \(row.boardState.accessibilityLabel)")
    .accessibilityHint(row.chat.isChatTool ? "Opens chat." : "Opens session.")
    // The hub uses a scrolling LazyVStack (not a List), where SwiftUI
    // `.swipeActions` are unavailable — so pin/archive/close are offered through
    // a long-press context menu instead, routed to the chat's project.
    .contextMenu {
      if row.chat.isChatTool {
        Button { onOpen() } label: { Label("Open chat", systemImage: "bubble.left.and.bubble.right") }
        Button { onArchive() } label: { Label("Archive", systemImage: "archivebox") }
        Button(role: .destructive) { onDelete() } label: { Label("Close chat", systemImage: "xmark.circle") }
      } else {
        // CLI (terminal) sessions: `chat.archive` / `chat.delete` reject
        // non-chat sessions on the host, so only offer Open here.
        Button { onOpen() } label: { Label("Open session", systemImage: "terminal") }
      }
    }
  }

  static func == (lhs: HubChatRow, rhs: HubChatRow) -> Bool {
    lhs.row == rhs.row && lhs.compact == rhs.compact
  }
}

// MARK: - State cards

struct HubConnectingCard: View {
  @EnvironmentObject private var syncService: SyncService

  var body: some View {
    VStack(spacing: 16) {
      HStack(spacing: 10) {
        ProgressView().controlSize(.small)
        Text("Connecting to your machine…")
          .font(.system(size: 14))
          .foregroundStyle(ADEColor.textSecondary)
      }
      if syncService.tailscaleOffHintVisible {
        ADETailscaleOffHintCard()
      }
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 28)
  }
}

struct HubEmptyProjectsCard: View {
  @EnvironmentObject private var syncService: SyncService
  var body: some View {
    VStack(spacing: 6) {
      Image(systemName: "folder.badge.plus")
        .font(.system(size: 22, weight: .regular))
        .foregroundStyle(ADEColor.textMuted)
      Text("No projects on \(syncService.hostName ?? "this machine")")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text("Add a project to start vibecoding from your phone.")
        .font(.system(size: 12.5))
        .foregroundStyle(ADEColor.textSecondary)
        .multilineTextAlignment(.center)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 28)
    .padding(.horizontal, 16)
  }
}

// MARK: - Centered page

/// A page whose content is centered on the whole screen, not the safe area.
/// The Duo's status and camera column sits on one side only, so centering
/// inside the safe area pushed everything off to the other side; symmetric
/// margins as wide as the larger inset keep content clear of both edges. The
/// content gets at least the page's height, so `Spacer`s inside it center it
/// vertically, and it scrolls when it does not fit.
struct HubCenteredPage<Content: View>: View {
  var maxWidth: CGFloat = 480
  @ViewBuilder var content: () -> Content

  var body: some View {
    GeometryReader { geometry in
      let sideInset = max(geometry.safeAreaInsets.leading, geometry.safeAreaInsets.trailing)
      ScrollView {
        content()
          .frame(maxWidth: maxWidth)
          .frame(maxWidth: .infinity, minHeight: geometry.size.height)
          .padding(.horizontal, 22 + sideInset)
      }
      .scrollIndicators(.hidden)
      .scrollBounceBehavior(.basedOnSize)
      .ignoresSafeArea(.container, edges: .horizontal)
    }
  }
}

/// A landing page in two parts, the hero (brand, headline) and the actions,
/// laid out so neither sits on the Duo's fold: book-folded the hero is the
/// left page and the actions the right one, laptop-folded the hero is the top
/// half and the actions the bottom half, each centered in its page. Flat (and
/// on every other iPhone) it is one column centered on the whole screen, the
/// actions toward the bottom.
struct HubFoldAwarePage<Hero: View, Actions: View>: View {
  var maxWidth: CGFloat = 480
  @ViewBuilder var hero: () -> Hero
  @ViewBuilder var actions: () -> Actions

  var body: some View {
    DuoLocalFoldReader { fold, size in
      switch fold {
      case .sideBySide(let rect):
        let lead = max(0, min(rect.minX, size.width))
        HStack(spacing: 0) {
          page { hero() }
            .frame(width: lead)
          Color.clear
            .frame(width: min(rect.width, max(0, size.width - lead)))
          page { actions() }
            .frame(maxWidth: .infinity)
        }
      case .stacked(let rect):
        let top = max(0, min(rect.minY, size.height))
        VStack(spacing: 0) {
          page { hero() }
            .frame(height: top)
          Color.clear
            .frame(height: min(rect.height, max(0, size.height - top)))
          page { actions() }
            .frame(maxHeight: .infinity)
        }
      case .none:
        HubCenteredPage(maxWidth: maxWidth) {
          VStack(spacing: 0) {
            Spacer(minLength: 24)
            hero()
            Spacer(minLength: 32)
            actions()
              .padding(.bottom, 40)
          }
        }
      }
    }
  }

  /// One page of a folded layout: its part centered in it, scrolling when it
  /// does not fit.
  private func page<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
    let content = content()
    return GeometryReader { geometry in
      ScrollView {
        content
          .frame(maxWidth: min(maxWidth, 400))
          .padding(.horizontal, 24)
          .frame(maxWidth: .infinity, minHeight: geometry.size.height)
      }
      .scrollIndicators(.hidden)
      .scrollBounceBehavior(.basedOnSize)
    }
  }
}

// MARK: - No-machine state (preserves the old project hub landing)

struct HubNoMachineState: View {
  @EnvironmentObject private var syncService: SyncService
  @ObservedObject private var account = AccountService.shared
  var onConnectSuccess: () -> Void = {}

  var body: some View {
    HubFoldAwarePage {
      VStack(spacing: 0) {
        Image("BrandMark")
          .resizable()
          .renderingMode(.original)
          .interpolation(.high)
          .aspectRatio(contentMode: .fit)
          .frame(maxWidth: 200)
          .frame(height: 96)
          .accessibilityLabel("ADE")

        Text(headline)
          .font(.title3.weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .multilineTextAlignment(.center)
          .padding(.top, 28)

        Text(message)
          .font(.subheadline)
          .foregroundStyle(ADEColor.textSecondary)
          .multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
          .frame(maxWidth: 360)
          .padding(.top, 6)

        if syncService.tailscaleOffHintVisible {
          ADETailscaleOffHintCard()
            .padding(.top, 22)
        }
      }
    } actions: {
      VStack(spacing: 24) {
        // One-tap cards for machines that are online right now — on your
        // account or previously paired — so a phone can jump back in
        // without opening Settings.
        HubQuickConnectSection(onConnectSuccess: onConnectSuccess)

        VStack(spacing: 4) {
          if hasSavedMachine {
            Button {
              Task { await syncService.reconnectIfPossible(userInitiated: true) }
            } label: {
              Label("Reconnect", systemImage: "arrow.clockwise")
            }
            .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))

            Button("Connection Settings") {
              syncService.settingsPresented = true
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(ADEColor.textSecondary)
            .frame(minHeight: 44)
          } else {
            Button {
              syncService.settingsPresented = true
            } label: {
              Label("Connect a Computer", systemImage: "link")
            }
            .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
          }
        }
        .frame(maxWidth: 360)
      }
    }
    .toolbar {
      if let identity = account.identity {
        ToolbarItem(placement: .topBarTrailing) {
          HubAccountButton(identity: identity) {
            syncService.settingsPresented = true
          }
        }
        .sharedBackgroundVisibility(.hidden)
      }
    }
  }

  private var headline: String {
    switch syncService.connectionState {
    case .error:
      return statusText
    default:
      return hasSavedMachine ? statusText : "Connect a computer"
    }
  }

  private var message: String {
    if syncService.connectionState == .error {
      return "Check that ADE is running on it and that both are online."
    }
    if hasSavedMachine {
      return "Reconnect to pick up your projects, lanes and chats where you left them."
    }
    return "ADE runs your agents on your computer. Pair this phone to follow and steer them from anywhere."
  }

  /// A machine is "saved" when a pairing credential still exists for it —
  /// plain `.disconnected` with a saved machine must not read as unpaired.
  private var hasSavedMachine: Bool {
    syncService.canReconnectToSavedHost
  }

  /// The account's name for the machine when it has one ("windows"), as the
  /// hub pill names it. `account` is observed so a rename shows at once.
  private var machineDisplayName: String? {
    syncService.focusedMachineAccountName
  }

  private var statusText: String {
    if syncService.connectionState == .error {
      let subject = syncConnectionSubjectMachineName(
        transport: .unreachable,
        attemptMachineName: syncService.connectAttemptTarget?.machineName,
        hostDisplayName: machineDisplayName
      )
      return "Cannot reach \(subject ?? "machine")"
    }
    if hasSavedMachine {
      return "Disconnected from \(machineDisplayName ?? "saved machine")"
    }
    return "No machine attached"
  }
}

// MARK: - Created toast (after a drawer send)

struct HubCreatedToast: View {
  let toast: HubCreatedChat
  let onOpen: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    HStack(spacing: 10) {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 16))
        .foregroundStyle(ADEColor.success)
      VStack(alignment: .leading, spacing: 1) {
        Text("\(toast.isCli ? "CLI session" : "Chat") created")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("\(toast.projectName) · \(toast.laneName)")
          .font(.system(size: 12))
          .foregroundStyle(ADEColor.textSecondary)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      Button("Open", action: onOpen)
        .buttonStyle(ADEKitButtonStyle())
      Button(action: onDismiss) {
        Image(systemName: "xmark")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 28, height: 28)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Dismiss")
    }
    .padding(.leading, 14)
    .padding(.trailing, 8)
    .padding(.vertical, 10)
    .adeKitCard(padding: nil)
    // Floats over the list, so one soft shadow lifts it off the rows.
    .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
  }
}

// MARK: - Helpers

private enum HubTimestampFormatters {
  static let fractional: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  static let plain = ISO8601DateFormatter()

  static let relative: RelativeDateTimeFormatter = {
    let formatter = RelativeDateTimeFormatter()
    formatter.unitsStyle = .abbreviated
    return formatter
  }()
}

private let hubRelativeTimestampCache: NSCache<NSString, NSString> = {
  let cache = NSCache<NSString, NSString>()
  cache.countLimit = 1_024
  return cache
}()

func hubRelativeTimestamp(_ value: String?) -> String? {
  guard let value, !value.isEmpty else { return nil }
  let minuteBucket = Int(Date().timeIntervalSince1970 / 60)
  let cacheKey = "\(minuteBucket)|\(value)" as NSString
  if let cached = hubRelativeTimestampCache.object(forKey: cacheKey) {
    return cached as String
  }
  guard let date = HubTimestampFormatters.fractional.date(from: value)
    ?? HubTimestampFormatters.plain.date(from: value)
  else { return nil }
  // Clamped to the past. The host stamps `lastActivityAt` from its own clock,
  // so a phone running a second or two behind gets a future date and
  // `RelativeDateTimeFormatter` renders it "in 0s" — a live session reading as
  // though it starts in the future. Anything at or ahead of now is "now".
  let now = Date()
  let label = date >= now.addingTimeInterval(-1)
    ? "now"
    : HubTimestampFormatters.relative.localizedString(for: date, relativeTo: now)
  hubRelativeTimestampCache.setObject(label as NSString, forKey: cacheKey)
  return label
}
