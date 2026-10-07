import SwiftUI

// Visual building blocks for the all-projects hub: the top bar, project cards
// (collapsible) with their lanes (collapsible) and chat rows, and the
// empty/connecting states. The bottom composer lives in HubComposerDrawer.swift.

// MARK: - Top bar

/// The hub's calm top bar, like desktop's: the brand mark, the machines chip
/// (with a menu), then quiet round icon buttons that all share
/// `ADEKitCircleIcon` with the Activity bell. Neutral glyphs; colour only on
/// the attention badges.
struct HubTopBar: View {
  @EnvironmentObject private var syncService: SyncService
  let onAdd: () -> Void
  var chatsAvailable: Bool = false
  var chatsAttentionCount: Int = 0
  var onOpenChats: () -> Void = {}

  var body: some View {
    HStack(spacing: 6) {
      // A fixed frame: left flexible, the HStack squeezed the wordmark to a
      // speck beside the chip.
      Image("BrandMark")
        .resizable()
        .renderingMode(.original)
        .interpolation(.high)
        .aspectRatio(contentMode: .fit)
        .frame(width: 44, height: 24)
        .accessibilityLabel("ADE")

      HubConnectionPill()
        .layoutPriority(1)

      Spacer(minLength: 0)

      // The hub was the one root without a bell, which made the phone's home
      // screen the only place you could not see that something needed you.
      ActivityBellButton()

      Button(action: onAdd) {
        ADEKitCircleIcon(systemImage: "plus")
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Add project")

      Button {
        syncService.settingsPresented = true
      } label: {
        ADEKitCircleIcon(systemImage: "gearshape")
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Settings")

      // Chats live behind a top-bar icon (right of the gear) instead of a large
      // card in the list (M13). A small badge surfaces chats awaiting input.
      Button(action: onOpenChats) {
        ADEKitCircleIcon(
          systemImage: "bubble.left.and.bubble.right",
          emphasized: chatsAttentionCount > 0,
          badge: chatsAvailable && chatsAttentionCount > 0 ? "\(chatsAttentionCount)" : nil
        )
        .opacity(chatsAvailable ? 1 : 0.45)
      }
      .buttonStyle(.plain)
      .disabled(!chatsAvailable)
      .accessibilityLabel(chatsAttentionCount > 0
        ? "Chats, \(chatsAttentionCount) awaiting input"
        : "Chats")
      .accessibilityHint("Opens conversations that are not linked to a project.")
    }
    .padding(.horizontal, 16)
    .padding(.top, 6)
    .padding(.bottom, 10)
  }
}

/// The machines chip: a status dot and the machine name (or "N machines"),
/// with a plain menu that lists every machine and opens connection settings.
struct HubConnectionPill: View {
  @EnvironmentObject private var syncService: SyncService
  @EnvironmentObject private var machineFleet: MachineFleet
  @ObservedObject private var account = AccountService.shared

  /// Machines with a live link right now: the primary one plus the fleet's.
  /// Above one, the pill counts them instead of naming just the primary.
  private var liveMachineCount: Int {
    let primary = syncService.connectionHealth.transport == .connected ? 1 : 0
    return primary + machineFleet.machines.filter { $0.state == .live }.count
  }

  private var tone: ADEKitTone {
    let health = syncService.connectionHealth
    switch health.transport {
    case .connected: return health.load == .strained ? .warn : .ok
    case .connecting: return .warn
    case .unreachable: return .crit
    case .disconnected: return .neutral
    }
  }

  /// The machine this pill should name: the one we're attached to, or — while
  /// an attempt is in flight or has just failed — the one that attempt targeted.
  private var machineName: String? {
    syncConnectionSubjectMachineName(
      transport: syncService.connectionHealth.transport,
      attemptMachineName: syncService.connectAttemptTarget.flatMap {
        accountMachinePresentationName(
          hostIdentity: $0.machineIdentity,
          fallback: $0.machineName,
          machines: account.machines
        )
      },
      hostDisplayName: syncService.focusedMachineAccountName
    )
  }

  private var transportWord: String {
    switch syncService.connectionHealth.transport {
    case .connected: return "Connected"
    case .connecting: return "Connecting…"
    case .unreachable: return "Unreachable"
    case .disconnected: return "Offline"
    }
  }

  private var label: String {
    // Only while the primary is attached: a connect in flight or a failure
    // names the machine it is about.
    if syncService.connectionHealth.transport == .connected, liveMachineCount > 1 {
      return "\(liveMachineCount) machines"
    }
    return machineName ?? transportWord
  }

  private var connectionAccessibilityLabel: String {
    let state = switch syncService.connectionHealth.transport {
    case .connected: "connected"
    case .connecting: "connecting"
    case .unreachable: "unreachable"
    case .disconnected: "offline"
    }
    return "Machine connection: \(label), \(state)"
  }

  /// Name of the project currently switching in, if any — drives the progress
  /// crossfade in the chip during a switch.
  private var switchingProjectName: String? {
    guard syncService.isProjectSwitching else { return nil }
    return syncService.projects.first(where: { syncService.isSwitchingProject($0) })?.displayName
  }

  private func fleetStateWord(_ state: MachineFleet.MachineState) -> String {
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

  var body: some View {
    Menu {
      Section("Machines") {
        Button {
          syncService.settingsPresented = true
        } label: {
          Text(syncService.focusedMachineDisplayName)
          Text(transportWord)
          Image(systemName: machineSymbol(machineKey: nil, name: syncService.focusedMachineDisplayName))
        }
        ForEach(machineFleet.machines) { machine in
          Button {
            syncService.settingsPresented = true
          } label: {
            Text(machine.name)
            Text(fleetStateWord(machine.state))
            Image(systemName: machineSymbol(machineKey: machine.machineKey, name: machine.name))
          }
        }
      }
      Button {
        syncService.settingsPresented = true
      } label: {
        Label("Connection settings", systemImage: "gearshape")
      }
    } label: {
      Group {
        if let switching = switchingProjectName {
          // Switch in flight: the chip shows progress and crossfades the
          // opening project's name in (Extras).
          HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text("Opening \(switching)…")
              .lineLimit(1)
          }
          .id("switching")
          .transition(.opacity)
        } else {
          HStack(spacing: 6) {
            ADEKitDot(tone: tone, size: 7)
            Text(label)
              .lineLimit(1)
          }
          .id("machine")
          .transition(.opacity)
        }
      }
      .font(.system(size: 13, weight: .semibold))
      .foregroundStyle(ADEColor.textPrimary)
      .padding(.horizontal, 9)
      .frame(height: 34)
      .adeKitChrome(in: Capsule())
      .contentShape(Capsule())
    }
    .buttonStyle(.plain)
    .animation(.easeInOut(duration: 0.25), value: switchingProjectName)
    .accessibilityLabel(switchingProjectName.map { "Opening \($0)" } ?? connectionAccessibilityLabel)
    .accessibilityHint("Shows your machines and connection settings.")
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
    var tally: [ActivityStateGroup: Int] = [:]
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
  /// it is gone. Dropping `idle` and `done` here would leave a lane of quiet
  /// chats with a blank header instead of the count it used to carry.
  ///
  /// Computed rather than stored, and deliberately outside `renderSignature`:
  /// every input is a row `stateGroup`, which each row's own signature already
  /// covers, so a stored copy could only ever be a second thing to keep in sync.
  var stateCounts: [HubStateCount] {
    var tally: [ActivityStateGroup: Int] = [:]
    accumulateStateTally(into: &tally)
    return hubTreeStateCounts(tally)
  }

  /// Adds this lane's whole subtree to a running tally, so the project card can
  /// sum its lanes instead of re-walking the tree with its own rules and
  /// arriving at a number the divider below it contradicts.
  func accumulateStateTally(into tally: inout [ActivityStateGroup: Int]) {
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
  /// Which of the six canonical states this row is in — the vocabulary the notch,
  /// the Activity sheet and the widget header all count by.
  ///
  /// Derived from the chat, not from `statusString`: that string files a failed
  /// session under the same "ended" bucket as a clean one, so the tree drew the
  /// identical neutral mark on a run that crashed and a run that finished.
  let stateGroup: ActivityStateGroup
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
  func accumulateStateTally(into tally: inout [ActivityStateGroup: Int]) {
    tally[stateGroup, default: 0] += 1
    for child in childRows { child.accumulateStateTally(into: &tally) }
  }

  init(
    chat: RemoteRosterChat,
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
    // Not an init parameter: it is a pure function of `chat`, and a caller that
    // could pass a different one is a caller that could make the mark disagree
    // with the row it sits on.
    let stateGroup = hubChatStateGroup(chat)
    self.stateGroup = stateGroup
    self.childRows = childRows
    self.renderSignature = hubChatRowRenderSignature(
      chat: chat,
      title: title,
      preview: preview,
      providerKey: providerKey,
      activityLabel: activityLabel,
      statusString: statusString,
      stateGroup: stateGroup,
      childRows: childRows
    )
  }

  static func make(chat: RemoteRosterChat, childRows: [HubChatRowPresentation] = []) -> HubChatRowPresentation {
    let trimmedTitle = chat.title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let trimmedPreview = chat.preview?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return HubChatRowPresentation(
      chat: chat,
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
  stateGroup: ActivityStateGroup,
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
  hasher.combine(stateGroup)
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
        .map { HubChatRowPresentation.make(chat: $0) }
    }
  let topLevelChats = visibleChats.filter { !isChildRow($0) }
  let topLevelChatsByLane = Dictionary(grouping: topLevelChats, by: \.laneId)

  let lanes = safeRoster.lanes.compactMap { lane -> HubLanePresentation? in
    let laneChats = (topLevelChatsByLane[lane.id] ?? [])
      .sorted { ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "") }
    guard !laneChats.isEmpty else { return nil }
    let rows = laneChats.map { chat in
      HubChatRowPresentation.make(chat: chat, childRows: childRowsByParentId[chat.id] ?? [])
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
    attentionCount: safeRoster.attentionCount,
    runningCount: safeRoster.runningCount
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
          WorkLaneLogoMark(color: laneTint, laneIcon: laneIcon, size: 11)
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
          if let status = hubChatStateLabel(row.stateGroup) {
            Text(status)
              .font(.system(size: 11, weight: .medium))
              .foregroundStyle(activityToneColor(row.stateGroup.tone))
              .lineLimit(1)
          }

          HubStateGlyph(group: row.stateGroup)

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
    .accessibilityLabel("\(row.title), \(row.stateGroup.label)")
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

// MARK: - No-machine state (preserves the old project hub landing)

struct HubNoMachineState: View {
  @EnvironmentObject private var syncService: SyncService
  @ObservedObject private var account = AccountService.shared
  var onConnectSuccess: () -> Void = {}

  var body: some View {
    GeometryReader { geometry in
      ScrollView {
        VStack(spacing: 0) {
          Image("BrandMark")
            .resizable()
            .renderingMode(.original)
            .interpolation(.high)
            .aspectRatio(contentMode: .fit)
            .frame(maxWidth: 220)
            .frame(height: 108)
            .frame(maxWidth: .infinity)
            .padding(.top, 88)
            .accessibilityLabel("ADE")

          HStack(spacing: 7) {
            ADEKitDot(tone: syncService.connectionState == .error ? .crit : .neutral, size: 7)
            Text(statusText)
              .font(.system(size: 13, weight: .medium))
              .foregroundStyle(ADEColor.textSecondary)
          }
          .padding(.horizontal, 12)
          .frame(height: 30)
          .background(ADEKit.track, in: Capsule())
          .padding(.top, 24)

          if syncService.tailscaleOffHintVisible {
            ADETailscaleOffHintCard()
              .padding(.top, 22)
          }

          // Between the no-machine badge and the Connect button: one-tap cards for
          // machines that are online right now — on your account or previously
          // paired — so a phone can jump back in without opening Settings (M4).
          HubQuickConnectSection(onConnectSuccess: onConnectSuccess)
            .padding(.top, 22)

          Spacer(minLength: 40)

          VStack(spacing: 12) {
            if hasSavedMachine {
              Button {
                Task { await syncService.reconnectIfPossible(userInitiated: true) }
              } label: {
                Label("Reconnect", systemImage: "arrow.clockwise")
              }
              .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))

              Button {
                syncService.settingsPresented = true
              } label: {
                Text("Connection settings")
                  .font(.system(size: 14, weight: .medium))
                  .foregroundStyle(ADEColor.textSecondary)
                  .frame(minHeight: 44)
                  .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
            } else {
              Button {
                syncService.settingsPresented = true
              } label: {
                Label("Connect Machine", systemImage: "link")
              }
              .buttonStyle(ADEKitButtonStyle(prominent: true, wide: true))
            }
          }
          .padding(.bottom, 56)
        }
        .frame(maxWidth: 520)
        .frame(maxWidth: .infinity, minHeight: geometry.size.height, alignment: .top)
        .padding(.horizontal, 22)
      }
      .scrollIndicators(.hidden)
    }
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
