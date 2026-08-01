import SwiftUI

// Visual building blocks for the all-projects hub: the top bar, project cards
// (collapsible) with their lanes (collapsible) and chat rows, and the
// empty/connecting states. The bottom composer lives in HubComposerDrawer.swift.

// MARK: - Top bar

struct HubTopBar: View {
  @EnvironmentObject private var syncService: SyncService
  let onAdd: () -> Void
  var chatsAvailable: Bool = false
  var chatsAttentionCount: Int = 0
  var onOpenChats: () -> Void = {}

  var body: some View {
    HStack(spacing: 12) {
      Image("BrandMark")
        .resizable()
        .renderingMode(.original)
        .interpolation(.high)
        .aspectRatio(contentMode: .fit)
        .frame(height: 26)
        .frame(maxWidth: 92, alignment: .leading)
        .shadow(color: ADEColor.purpleAccent.opacity(0.35), radius: 10)
        .accessibilityLabel("ADE")

      HubConnectionPill()
        .layoutPriority(1)

      HubCircularButton(systemImage: "plus", tint: ADEColor.accent, action: onAdd)
        .accessibilityLabel("Add project")

      HubCircularButton(systemImage: "gearshape", tint: ADEColor.textSecondary) {
        syncService.settingsPresented = true
      }
      .accessibilityLabel("Settings")

      // Chats live behind a top-bar icon (right of the gear) instead of a large
      // card in the list (M13). A small badge surfaces chats awaiting input.
      HubCircularButton(
        systemImage: "bubble.left.and.bubble.right",
        tint: chatsAvailable ? ADEColor.accent : ADEColor.textMuted,
        badgeCount: chatsAvailable ? chatsAttentionCount : 0,
        action: onOpenChats
      )
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

private struct HubCircularButton: View {
  let systemImage: String
  let tint: Color
  var badgeCount: Int = 0
  let action: () -> Void

  var body: some View {
    Button(action: action) {
      Image(systemName: systemImage)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(tint)
        .frame(width: 38, height: 38)
        .background(ADEColor.cardBackground.opacity(0.72), in: Circle())
        .overlay(Circle().stroke(ADEColor.border.opacity(0.8), lineWidth: 1))
        .overlay(alignment: .topTrailing) {
          if badgeCount > 0 {
            Text("\(badgeCount)")
              .font(.system(size: 10, weight: .bold).monospacedDigit())
              .foregroundStyle(ADEColor.pageBackground)
              .padding(.horizontal, 4)
              .frame(minWidth: 15, minHeight: 15)
              .background(ADEColor.warning, in: Capsule())
              .offset(x: 3, y: -3)
          }
        }
    }
    .buttonStyle(.plain)
  }
}

/// Compact "● Machine" pill — tap opens connection settings.
struct HubConnectionPill: View {
  @EnvironmentObject private var syncService: SyncService
  @ObservedObject private var account = AccountService.shared

  private var tint: Color {
    let health = syncService.connectionHealth
    switch health.transport {
    case .connected: return health.load == .strained ? ADEColor.warning : ADEColor.success
    case .connecting: return ADEColor.warning
    case .unreachable: return ADEColor.danger
    case .disconnected: return ADEColor.textMuted
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
      hostDisplayName: accountMachinePresentationName(
        hostIdentity: syncService.activeHostProfile?.hostIdentity,
        fallback: syncService.hostName,
        machines: account.machines
      )
    )
  }

  private var label: String {
    if let machineName {
      return machineName
    }
    switch syncService.connectionHealth.transport {
    case .connected: return "Connected"
    case .connecting: return "Connecting…"
    case .unreachable: return "Unreachable"
    case .disconnected: return "Offline"
    }
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

  var body: some View {
    Button {
      syncService.settingsPresented = true
    } label: {
      Group {
        if let switching = switchingProjectName {
          // Switch in flight: the chip shows progress and crossfades the
          // opening project's name in (Extras).
          HStack(spacing: 6) {
            ProgressView().controlSize(.mini)
            Text("Opening \(switching)…")
              .font(.system(.caption, design: .rounded).weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
          }
          .id("switching")
          .transition(.opacity)
        } else {
          HStack(spacing: 6) {
            Circle().fill(tint).frame(width: 7, height: 7)
            Text(label)
              .font(.system(.caption, design: .rounded).weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
              .lineLimit(1)
          }
          .id("machine")
          .transition(.opacity)
        }
      }
      .padding(.horizontal, 11)
      .padding(.vertical, 8)
      .background(ADEColor.cardBackground.opacity(0.62), in: Capsule())
      .overlay(Capsule().stroke(ADEColor.border.opacity(0.8), lineWidth: 1))
    }
    .buttonStyle(.plain)
    .animation(.easeInOut(duration: 0.25), value: switchingProjectName)
    .accessibilityLabel(switchingProjectName.map { "Opening \($0)" } ?? connectionAccessibilityLabel)
    .accessibilityHint("Opens connection settings.")
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
  let metaLine: String
  fileprivate let renderSignature: Int

  var id: String { project.id }

  init(
    project: MobileProjectSummary,
    isActive: Bool,
    isSwitching: Bool,
    isLoading: Bool,
    laneCount: Int,
    chatCount: Int,
    lanes: [HubLanePresentation]
  ) {
    self.project = project
    self.isActive = isActive
    self.isSwitching = isSwitching
    self.isLoading = isLoading
    self.laneCount = laneCount
    self.chatCount = chatCount
    self.lanes = lanes
    let lanePart = "\(laneCount) lane\(laneCount == 1 ? "" : "s")"
    let chatPart = "\(chatCount) chat\(chatCount == 1 ? "" : "s")"
    self.metaLine = "\(lanePart) · \(chatPart)"
    self.renderSignature = hubProjectRenderSignature(
      project: project,
      isActive: isActive,
      isSwitching: isSwitching,
      isLoading: isLoading,
      laneCount: laneCount,
      chatCount: chatCount,
      lanes: lanes
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
  let childRows: [HubChatRowPresentation]
  fileprivate let renderSignature: Int

  var id: String { chat.id }
  var childCount: Int { childRows.count }

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
    self.childRows = childRows
    self.renderSignature = hubChatRowRenderSignature(
      chat: chat,
      title: title,
      preview: preview,
      providerKey: providerKey,
      activityLabel: activityLabel,
      statusString: statusString,
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
  lanes: [HubLanePresentation]
) -> Int {
  var hasher = Hasher()
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
  hasher.combine(chat.pinned)
  hasher.combine(chat.archived)
  hasher.combine(chat.lastActivityAt)
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

  let laneById = Dictionary(roster.lanes.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
  let visibleChats = roster.chats.filter { chat in
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

  let lanes = roster.lanes.compactMap { lane -> HubLanePresentation? in
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
    laneCount: roster.lanes.count,
    chatCount: chatCount,
    lanes: lanes
  )
}

struct HubProjectCard: View, Equatable {
  let presentation: HubProjectPresentation
  let isCollapsed: Bool
  let collapsedLaneKeysSnapshot: Set<String>
  @Binding var collapsedLaneKeys: Set<String>
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
    VStack(alignment: .leading, spacing: 0) {
      // Only the project itself carries the card surface + border. Drawn above
      // the expanded rows (zIndex) with an opaque backing so the rows slide out
      // from *behind* the card, never over it.
      header
        .background(ADEColor.pageBackground)
        .background(ADEColor.cardBackground.opacity(0.62), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
          RoundedRectangle(cornerRadius: 14, style: .continuous)
            .stroke(presentation.isActive ? ADEColor.accent.opacity(0.5) : ADEColor.border.opacity(0.8), lineWidth: 1)
        )
        .zIndex(1)

      // Expanded lanes + chats hang below the card, indented and unboundaried.
      if hasExpandableContent && !isCollapsed {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(presentation.lanes) { lanePresentation in
            HubLaneSection(
              project: project,
              presentation: lanePresentation,
              isCollapsed: collapsedLaneKeysSnapshot.contains(laneKey(lanePresentation.lane)),
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
        .padding(.top, 10)
        .padding(.leading, 16)
        .padding(.trailing, 4)
        .zIndex(0)
      }
    }
  }

  private var header: some View {
    HStack(spacing: 11) {
      if hasExpandableContent {
        Button(action: onToggleCollapse) {
          Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
            .font(.system(size: 12, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 22, height: 22)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isCollapsed ? "Expand project" : "Collapse project")
      } else {
        Color.clear
          .frame(width: 22, height: 22)
          .accessibilityHidden(true)
      }

      HubProjectIcon(iconDataUrl: project.iconDataUrl, isActive: presentation.isActive, size: 44)

      // Tapping the title area opens the full project tabs.
      Button(action: onOpenProject) {
        Text(project.displayName)
          .font(.system(.title3, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)

      // Lane/chat counts live to the left of the open arrow now that the name
      // owns the full leading run.
      Text(presentation.metaLine)
        .font(.system(.caption, design: .rounded))
        .foregroundStyle(ADEColor.textMuted)
        .lineLimit(1)
        .fixedSize()

      if presentation.isSwitching {
        ProgressView().controlSize(.small)
      } else {
        Button(action: onOpenProject) {
          Image(systemName: "chevron.right")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(ADEColor.accent.opacity(0.8))
            .frame(width: 30, height: 30)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open \(project.displayName)")
        .accessibilityHint("Opens the full project view.")
      }
    }
    .padding(12)
    .contentShape(Rectangle())
    .contextMenu {
      Button { onOpenProject() } label: { Label("Open project", systemImage: "rectangle.stack") }
      Button(role: .destructive, action: onForget) { Label("Remove from list", systemImage: "trash") }
    }
  }

  private func laneKey(_ lane: RemoteRosterLane) -> String { "\(project.id)/\(lane.id)" }
  private func toggleLane(_ lane: RemoteRosterLane) {
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
      && lhs.collapsedLaneSignature == rhs.collapsedLaneSignature
  }
}

struct HubProjectIcon: View {
  let iconDataUrl: String?
  let isActive: Bool
  // The real project logo art is already a rounded-square glyph, so we render it
  // edge-to-edge (no dark bezel) at this size. Only the folder fallback keeps a
  // recessed backing so the SF Symbol has something to sit on.
  var size: CGFloat = 38

  var body: some View {
    if let image = projectIconImage(from: iconDataUrl) {
      Image(uiImage: image).projectIconStyle(size: size, cornerRadius: size * 0.24)
    } else {
      RoundedRectangle(cornerRadius: size * 0.21, style: .continuous)
        .fill(isActive ? ADEColor.accent.opacity(0.16) : ADEColor.recessedBackground)
        .frame(width: size, height: size)
        .overlay(
          Image(systemName: "folder")
            .font(.system(size: size * 0.4, weight: .semibold))
            .foregroundStyle(isActive ? ADEColor.accent : ADEColor.textSecondary)
        )
    }
  }
}

// MARK: - Lane section

struct HubLaneSection: View, Equatable {
  let project: MobileProjectSummary
  let presentation: HubLanePresentation
  let isCollapsed: Bool
  let onToggle: () -> Void
  let onOpenChat: (RemoteRosterChat) -> Void
  let onViewInWork: () -> Void
  let onViewInLanes: () -> Void
  let onArchiveChat: (RemoteRosterChat) -> Void
  let onDeleteChat: (RemoteRosterChat) -> Void

  private var lane: RemoteRosterLane { presentation.lane }
  private var laneTint: Color { LaneColorPalette.displayColor(forHex: lane.color) }

  private var laneIcon: LaneIcon? { lane.icon.flatMap(LaneIcon.init(rawValue:)) }

  var body: some View {
    // Mirrors the Work tab's lane section header: chevron, lane logo mark, and
    // the lane name in its own color, with a count badge on the trailing edge.
    VStack(alignment: .leading, spacing: 4) {
      Button(action: onToggle) {
        HStack(spacing: 8) {
          Image(systemName: isCollapsed ? "chevron.right" : "chevron.down")
            .font(.system(size: 9, weight: .bold))
            .foregroundStyle(ADEColor.textMuted)
            .frame(width: 10, alignment: .center)
          WorkLaneLogoMark(color: laneTint, laneIcon: laneIcon, size: 11)
            .frame(width: 13, height: 13)
          Text(lane.name)
            .font(.system(.caption, design: .rounded).weight(.semibold))
            .foregroundStyle(laneTint)
            .lineLimit(1)
          Spacer(minLength: 6)
          Text("\(presentation.totalCount)")
            .font(.system(.caption2, design: .rounded).weight(.semibold).monospacedDigit())
            .foregroundStyle(ADEColor.textMuted)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(ADEColor.surfaceBackground.opacity(0.65), in: Capsule())
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .contextMenu {
        Button { onViewInWork() } label: { Label("View in Work tab", systemImage: "terminal") }
        Button { onViewInLanes() } label: { Label("View in Lanes tab", systemImage: "square.stack.3d.up") }
      }
      .zIndex(1)

      if !isCollapsed {
        VStack(alignment: .leading, spacing: 2) {
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
        .padding(.leading, 6)
        .zIndex(0)
      }
    }
  }

  static func == (lhs: HubLaneSection, rhs: HubLaneSection) -> Bool {
    lhs.project.id == rhs.project.id
      && lhs.presentation == rhs.presentation
      && lhs.isCollapsed == rhs.isCollapsed
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
    // Deliberately minimal: provider logo, chat name, and the relative
    // timestamp. Nothing else competes for the eye at the hub's glance level.
    Button(action: onOpen) {
      HStack(spacing: 10) {
        WorkProviderBareLogo(provider: row.providerKey, fallbackSymbol: "terminal.fill", tint: ADEColor.textSecondary, size: compact ? 16 : 20)

        Text(row.title)
          .font(.system(.footnote, design: .rounded).weight(.medium))
          .foregroundStyle(ADEColor.textPrimary)
          .lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)

        if let activity = row.activityLabel {
          Text(activity)
            .font(.system(.caption2, design: .rounded))
            .foregroundStyle(ADEColor.textMuted)
        }
      }
      .padding(.horizontal, 8)
      .padding(.vertical, compact ? 5 : 7)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(row.title)
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

struct HubStatusDot: View {
  let status: String
  var body: some View {
    Circle()
      .fill(workChatStatusTint(status))
      .frame(width: 8, height: 8)
      .accessibilityHidden(true)
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
          .font(.system(.subheadline, design: .rounded))
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
    VStack(spacing: 8) {
      Image(systemName: "folder.badge.plus")
        .font(.system(size: 26))
        .foregroundStyle(ADEColor.textMuted)
      Text("No projects on \(syncService.hostName ?? "this machine")")
        .font(.system(.subheadline, design: .rounded).weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
      Text("Add a project to start vibecoding from your phone.")
        .font(.system(.caption, design: .rounded))
        .foregroundStyle(ADEColor.textMuted)
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
            .frame(maxWidth: 280)
            .frame(height: 142)
            .frame(maxWidth: .infinity)
            .shadow(color: ADEColor.purpleAccent.opacity(0.45), radius: 24)
            .padding(.top, 88)
            .accessibilityLabel("ADE")

          HStack(spacing: 8) {
            Circle().fill(statusDotColor).frame(width: 8, height: 8)
            Image(systemName: "desktopcomputer")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(ADEColor.textSecondary)
            Text(statusText)
              .font(.system(.footnote, design: .rounded).weight(.semibold))
              .foregroundStyle(ADEColor.textPrimary)
          }
          .padding(.horizontal, 14)
          .padding(.vertical, 10)
          .background(ADEColor.cardBackground.opacity(0.62), in: Capsule())
          .overlay(Capsule().stroke(ADEColor.border.opacity(0.8), lineWidth: 1))
          .padding(.top, 30)

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
                primaryButtonLabel(symbol: "arrow.clockwise", title: "Reconnect")
              }
              .buttonStyle(.plain)

              Button {
                syncService.settingsPresented = true
              } label: {
                Text("Connection settings")
                  .font(.system(.footnote, design: .rounded).weight(.semibold))
                  .foregroundStyle(ADEColor.textSecondary)
                  .frame(minHeight: 44)
                  .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
            } else {
              Button {
                syncService.settingsPresented = true
              } label: {
                primaryButtonLabel(symbol: "link", title: "Connect Machine")
              }
              .buttonStyle(.plain)
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

  private var machineDisplayName: String? {
    let name = syncService.hostName ?? syncService.activeHostProfile?.hostName
    let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed?.isEmpty == false ? trimmed : nil
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

  private var statusDotColor: Color {
    syncService.connectionState == .error ? ADEColor.danger : ADEColor.textMuted
  }

  private func primaryButtonLabel(symbol: String, title: String) -> some View {
    HStack(spacing: 10) {
      Image(systemName: symbol)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(ADEColor.accent)
      Text(title)
        .font(.system(.subheadline, design: .rounded).weight(.semibold))
        .foregroundStyle(ADEColor.textPrimary)
    }
    .frame(maxWidth: .infinity)
    .padding(.vertical, 16)
    .background(ADEColor.accent.opacity(0.14), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(ADEColor.accent.opacity(0.4), lineWidth: 1))
  }
}

// MARK: - Created toast (after a drawer send)

struct HubCreatedToast: View {
  let toast: HubCreatedChat
  let onOpen: () -> Void
  let onDismiss: () -> Void

  var body: some View {
    HStack(spacing: 12) {
      Image(systemName: "checkmark.circle.fill")
        .font(.system(size: 18))
        .foregroundStyle(ADEColor.success)
      VStack(alignment: .leading, spacing: 1) {
        Text("\(toast.isCli ? "CLI session" : "Chat") created")
          .font(.system(.footnote, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.textPrimary)
        Text("\(toast.projectName) · \(toast.laneName)")
          .font(.system(.caption2, design: .rounded))
          .foregroundStyle(ADEColor.textMuted)
          .lineLimit(1)
      }
      Spacer(minLength: 8)
      Button(action: onOpen) {
        Text("Open")
          .font(.system(.footnote, design: .rounded).weight(.semibold))
          .foregroundStyle(ADEColor.accent)
          .padding(.horizontal, 12)
          .padding(.vertical, 6)
          .background(ADEColor.accent.opacity(0.14), in: Capsule())
      }
      .buttonStyle(.plain)
      Button(action: onDismiss) {
        Image(systemName: "xmark")
          .font(.system(size: 11, weight: .bold))
          .foregroundStyle(ADEColor.textMuted)
          .frame(width: 26, height: 26)
      }
      .buttonStyle(.plain)
    }
    .padding(.horizontal, 14)
    .padding(.vertical, 10)
    .background(ADEColor.surfaceBackground.opacity(0.96), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(ADEColor.border.opacity(0.8), lineWidth: 1))
    .shadow(color: .black.opacity(0.16), radius: 8, y: 3)
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
  let label = HubTimestampFormatters.relative.localizedString(for: date, relativeTo: Date())
  hubRelativeTimestampCache.setObject(label as NSString, forKey: cacheKey)
  return label
}
