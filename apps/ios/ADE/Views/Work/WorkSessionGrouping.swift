import Foundation
import SwiftUI

/// The display-only projection used while the active project is represented by
/// a lightweight remote roster. Local rows always take precedence because they
/// carry the complete, hydrated Work state. Missing roster rows are appended in
/// their source order so repeated projections remain stable.
struct WorkActiveProjectRosterProjection: Equatable {
  let sessions: [TerminalSessionSummary]
  let lanes: [LaneSummary]
}

let workActiveProjectRosterSessionLimit = 200

func overlayActiveProjectRoster(
  localSessions: [TerminalSessionSummary],
  localLanes: [LaneSummary],
  roster: RemoteRosterProject?
) -> WorkActiveProjectRosterProjection {
  // Match `work.listSessions(limit: 200)` and include chat rows only. Roster
  // terminal stubs deliberately lack PTY ids/offsets, so opening one as a
  // terminal would produce an unusable screen until the real local row lands.
  let rosterChats = Array(
    (roster?.chats ?? [])
      .lazy
      .filter { $0.archived != true && $0.isChatTool }
      .prefix(workActiveProjectRosterSessionLimit)
  )

  var sessionIds = Set<String>()
  var sessions: [TerminalSessionSummary] = []
  sessions.reserveCapacity(localSessions.count + rosterChats.count)
  for session in localSessions where sessionIds.insert(session.id).inserted {
    sessions.append(session)
  }

  let projectedRosterLaneIds = Set(rosterChats.map(\.laneId))

  var laneIds = Set<String>()
  var lanes: [LaneSummary] = []
  lanes.reserveCapacity(localLanes.count + projectedRosterLaneIds.count)
  for lane in localLanes where laneIds.insert(lane.id).inserted {
    lanes.append(lane)
  }
  for rosterLane in roster?.lanes ?? []
    where projectedRosterLaneIds.contains(rosterLane.id) && laneIds.insert(rosterLane.id).inserted
  {
    lanes.append(rosterLane.asLaneSummary())
  }

  let laneNamesById = Dictionary(
    lanes.map { ($0.id, $0.name) },
    uniquingKeysWith: { existing, _ in existing }
  )
  for rosterChat in rosterChats {
    guard sessionIds.insert(rosterChat.id).inserted else { continue }
    let laneName = laneNamesById[rosterChat.laneId] ?? rosterChat.laneId
    sessions.append(rosterChat.asTerminalSessionSummary(laneName: laneName))
  }

  return WorkActiveProjectRosterProjection(sessions: sessions, lanes: lanes)
}

/// Mirrors the desktop `WorkSessionListOrganization` union (byLane / byStatus / byTime) so users
/// can reshape the Work session list the same way on mobile. Persisted via `@AppStorage`.
enum WorkSessionOrganization: String, CaseIterable, Identifiable {
  case byLane
  case byStatus
  case byTime

  var id: String { rawValue }

  var title: String {
    switch self {
    case .byLane: return "Lane"
    case .byStatus: return "Status"
    case .byTime: return "Time"
    }
  }
}

/// A rendered section in the Work sidebar session list. Each section has a stable id (for
/// collapse persistence), a display label, a visual icon, a semantic tint, and the sessions that
/// belong in it in display order.
struct WorkSessionGroup: Identifiable, Equatable {
  let id: String
  let label: String
  let icon: Icon
  let tint: Color
  let sessions: [TerminalSessionSummary]
  let laneColor: String?
  let laneIcon: LaneIcon?
  let isOrphaned: Bool
  /// Every session in this lane is settled (snoozed rows are already lifted into
  /// the `status:snoozed` tail, so they can't be here). The section renders as a
  /// single thin row instead of a full header over nothing.
  let isQuiet: Bool
  /// The singleton form: one top-level row, so the group renders with no header
  /// at all and the lone row carries the lane identity instead. Orthogonal to
  /// `isQuiet` — a quiet lane still has a header to fold, and the two rules are
  /// derived independently (see `workHeaderlessLaneIds`).
  let isHeaderless: Bool

  enum Icon: Equatable {
    case statusDot
    case laneBranch
    case warning
    case none
  }

  init(
    id: String,
    label: String,
    icon: Icon,
    tint: Color,
    sessions: [TerminalSessionSummary],
    laneColor: String? = nil,
    laneIcon: LaneIcon? = nil,
    isOrphaned: Bool = false,
    isQuiet: Bool = false,
    isHeaderless: Bool = false
  ) {
    self.id = id
    self.label = label
    self.icon = icon
    self.tint = tint
    self.sessions = sessions
    self.laneColor = laneColor
    self.laneIcon = laneIcon
    self.isOrphaned = isOrphaned
    self.isQuiet = isQuiet
    self.isHeaderless = isHeaderless
  }

  /// Inverted collapse marker: a quiet lane starts collapsed, and only an
  /// explicit expand is recorded, so it re-quiets on its own instead of leaving
  /// a stale "expanded" entry behind. Mirrors the desktop sidebar.
  var quietOpenSectionId: String { "lane-open:\(laneId ?? id)" }

  /// Lane id for by-lane sections (id is `lane:<laneId>`); nil for status/time
  /// groupings whose headers span multiple lanes and carry no single PR tag.
  var laneId: String? {
    id.hasPrefix("lane:") ? String(id.dropFirst("lane:".count)) : nil
  }

  static func == (lhs: WorkSessionGroup, rhs: WorkSessionGroup) -> Bool {
    lhs.id == rhs.id
      && lhs.label == rhs.label
      && lhs.icon == rhs.icon
      && lhs.tint == rhs.tint
      && lhs.laneColor == rhs.laneColor
      && lhs.laneIcon == rhs.laneIcon
      && lhs.isOrphaned == rhs.isOrphaned
      && lhs.isQuiet == rhs.isQuiet
      && lhs.isHeaderless == rhs.isHeaderless
      && lhs.sessions.map(\.id) == rhs.sessions.map(\.id)
  }
}

struct WorkSessionChildGroup: Equatable {
  let parentId: String
  let children: [TerminalSessionSummary]
  let collapsedSectionId: String

  var label: String {
    children.count == 1 ? "1 shell" : "\(children.count) shells"
  }
}

struct WorkRootSessionPresentation: Equatable {
  let mergedSessions: [TerminalSessionSummary]
  let displaySessions: [TerminalSessionSummary]
  let displaySessionIds: Set<String>
  let topLevelDisplaySessionIds: Set<String>
  let childGroupsByParentId: [String: WorkSessionChildGroup]
  let liveChatSessions: [TerminalSessionSummary]
  let sessionGroups: [WorkSessionGroup]
  let workOrderedLanes: [LaneSummary]
  let laneById: [String: LaneSummary]
  let lanePrTagsByLaneId: [String: LanePrTag]
  let globalNeedsInputCount: Int
  let globalLiveSessionCount: Int
  let firstGlobalAttentionSessionId: String?
  let firstGlobalLiveSessionId: String?
  private let renderSignature: Int

  init(
    mergedSessions: [TerminalSessionSummary],
    displaySessions: [TerminalSessionSummary],
    displaySessionIds: Set<String>,
    topLevelDisplaySessionIds: Set<String>,
    childGroupsByParentId: [String: WorkSessionChildGroup],
    liveChatSessions: [TerminalSessionSummary],
    sessionGroups: [WorkSessionGroup],
    workOrderedLanes: [LaneSummary],
    laneById: [String: LaneSummary],
    lanePrTagsByLaneId: [String: LanePrTag],
    globalNeedsInputCount: Int,
    globalLiveSessionCount: Int,
    firstGlobalAttentionSessionId: String?,
    firstGlobalLiveSessionId: String?,
    renderSignature: Int
  ) {
    self.mergedSessions = mergedSessions
    self.displaySessions = displaySessions
    self.displaySessionIds = displaySessionIds
    self.topLevelDisplaySessionIds = topLevelDisplaySessionIds
    self.childGroupsByParentId = childGroupsByParentId
    self.liveChatSessions = liveChatSessions
    self.sessionGroups = sessionGroups
    self.workOrderedLanes = workOrderedLanes
    self.laneById = laneById
    self.lanePrTagsByLaneId = lanePrTagsByLaneId
    self.globalNeedsInputCount = globalNeedsInputCount
    self.globalLiveSessionCount = globalLiveSessionCount
    self.firstGlobalAttentionSessionId = firstGlobalAttentionSessionId
    self.firstGlobalLiveSessionId = firstGlobalLiveSessionId
    self.renderSignature = renderSignature
  }

  static let empty = WorkRootSessionPresentation(
    mergedSessions: [],
    displaySessions: [],
    displaySessionIds: [],
    topLevelDisplaySessionIds: [],
    childGroupsByParentId: [:],
    liveChatSessions: [],
    sessionGroups: [],
    workOrderedLanes: [],
    laneById: [:],
    lanePrTagsByLaneId: [:],
    globalNeedsInputCount: 0,
    globalLiveSessionCount: 0,
    firstGlobalAttentionSessionId: nil,
    firstGlobalLiveSessionId: nil,
    renderSignature: 0
  )

  static func == (lhs: WorkRootSessionPresentation, rhs: WorkRootSessionPresentation) -> Bool {
    lhs.renderSignature == rhs.renderSignature
  }
}

func buildWorkRootSessionPresentation(
  sessions: [TerminalSessionSummary],
  optimisticSessions: [String: TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  archivedSessionIds: Set<String>,
  selectedStatus: WorkSessionStatusFilter,
  selectedLaneId: String,
  searchText: String,
  outputSearchBySessionId: [String: String] = [:],
  organization: WorkSessionOrganization,
  orderedLanes: [LaneSummary],
  pullRequests: [PullRequestListItem] = [],
  githubPrs: [GitHubPrListItem] = [],
  deletingLaneIds: Set<String> = [],
  pinnedLaneIds: Set<String> = [],
  laneSortMode: WorkLaneSortMode = .created,
  now: Date = Date()
) -> WorkRootSessionPresentation {
  let committedIds = Set(sessions.map(\.id))
  let draftValues = optimisticSessions.values.filter { !committedIds.contains($0.id) }
  let laneById = Dictionary(orderedLanes.map { ($0.id, $0) }, uniquingKeysWith: { _, new in new })
  let lanePrTagsByLaneId = lanePrTagByLaneId(
    lanes: orderedLanes,
    pullRequests: pullRequests,
    githubPrs: githubPrs
  )
  let mergedSessions = (sessions + draftValues)
    .sorted { compareWorkSessionSortOrder($0, $1, chatSummaries: chatSummaries) }
  let statusBySessionId = Dictionary(
    uniqueKeysWithValues: mergedSessions.map { session in
      (session.id, normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id]))
    }
  )

  let displaySessions = workFilteredSessions(
    mergedSessions,
    chatSummaries: chatSummaries,
    archivedSessionIds: archivedSessionIds,
    selectedStatus: selectedStatus,
    selectedLaneId: selectedLaneId,
    searchText: searchText,
    outputSearchBySessionId: outputSearchBySessionId
  )
  let displaySessionIds = Set(displaySessions.map(\.id))
  let childGroupsByParentId = workSessionChildGroupsByParentId(sessions: displaySessions)
  let childSessionIds = Set(childGroupsByParentId.values.flatMap { $0.children.map(\.id) })
  let topLevelDisplaySessionIds = displaySessionIds.subtracting(childSessionIds)

  var liveChatSessions: [TerminalSessionSummary] = []
  liveChatSessions.reserveCapacity(mergedSessions.count)
  var globalNeedsInputCount = 0
  var globalLiveSessionCount = 0
  var firstGlobalAttentionSessionId: String?
  var firstGlobalLiveSessionId: String?

  for session in mergedSessions {
    let isArchived = archivedSessionIds.contains(session.id)
    let status = statusBySessionId[session.id] ?? "ended"

    if isChatSession(session), status != "ended", !isArchived {
      liveChatSessions.append(session)
    }

    guard !isArchived else { continue }
    if status == "awaiting-input" {
      globalNeedsInputCount += 1
      globalLiveSessionCount += 1
      if firstGlobalAttentionSessionId == nil {
        firstGlobalAttentionSessionId = session.id
      }
      if firstGlobalLiveSessionId == nil {
        firstGlobalLiveSessionId = session.id
      }
    } else if status == "active" || status == "idle" {
      globalLiveSessionCount += 1
      if firstGlobalLiveSessionId == nil {
        firstGlobalLiveSessionId = session.id
      }
    }
  }

  // Lane ordering and the singleton rule both read the UNFILTERED roster, so
  // neither the shelf a lane sits on nor whether it has a header changes while
  // the user types in search. Same precedent as the quiet-lane derivation.
  let workOrderedLanes = orderWorkLanes(
    orderedLanes,
    inputs: workLaneOrderInputs(
      lanes: orderedLanes,
      sessions: mergedSessions,
      chatSummaries: chatSummaries,
      archivedSessionIds: archivedSessionIds,
      pinnedLaneIds: pinnedLaneIds,
      now: now
    ),
    mode: laneSortMode
  )
  let headerlessLaneIds = workHeaderlessLaneIds(
    workHeaderlessLaneInputs(
      lanes: orderedLanes,
      sessions: mergedSessions,
      pinnedLaneIds: pinnedLaneIds
    ),
    sortMode: laneSortMode
  )

  let sessionGroups = workSessionGroups(
    organization: organization,
    sessions: displaySessions,
    quietReferenceSessions: mergedSessions,
    chatSummaries: chatSummaries,
    statusBySessionId: statusBySessionId,
    archivedSessionIds: archivedSessionIds,
    orderedLanes: workOrderedLanes,
    deletingLaneIds: deletingLaneIds,
    headerlessLaneIds: headerlessLaneIds,
    now: now
  )

  return WorkRootSessionPresentation(
    mergedSessions: mergedSessions,
    displaySessions: displaySessions,
    displaySessionIds: displaySessionIds,
    topLevelDisplaySessionIds: topLevelDisplaySessionIds,
    childGroupsByParentId: childGroupsByParentId,
    liveChatSessions: liveChatSessions,
    sessionGroups: sessionGroups,
    workOrderedLanes: workOrderedLanes,
    laneById: laneById,
    lanePrTagsByLaneId: lanePrTagsByLaneId,
    globalNeedsInputCount: globalNeedsInputCount,
    globalLiveSessionCount: globalLiveSessionCount,
    firstGlobalAttentionSessionId: firstGlobalAttentionSessionId,
    firstGlobalLiveSessionId: firstGlobalLiveSessionId,
    renderSignature: workRootSessionPresentationRenderSignature(
      mergedSessions: mergedSessions,
      displaySessions: displaySessions,
      topLevelDisplaySessionIds: topLevelDisplaySessionIds,
      childGroupsByParentId: childGroupsByParentId,
      liveChatSessions: liveChatSessions,
      sessionGroups: sessionGroups,
      workOrderedLanes: workOrderedLanes,
      lanePrTagsByLaneId: lanePrTagsByLaneId,
      chatSummaries: chatSummaries,
      statusBySessionId: statusBySessionId,
      globalNeedsInputCount: globalNeedsInputCount,
      globalLiveSessionCount: globalLiveSessionCount,
      firstGlobalAttentionSessionId: firstGlobalAttentionSessionId,
      firstGlobalLiveSessionId: firstGlobalLiveSessionId
    )
  )
}

private func workRootSessionPresentationRenderSignature(
  mergedSessions: [TerminalSessionSummary],
  displaySessions: [TerminalSessionSummary],
  topLevelDisplaySessionIds: Set<String>,
  childGroupsByParentId: [String: WorkSessionChildGroup],
  liveChatSessions: [TerminalSessionSummary],
  sessionGroups: [WorkSessionGroup],
  workOrderedLanes: [LaneSummary],
  lanePrTagsByLaneId: [String: LanePrTag],
  chatSummaries: [String: AgentChatSessionSummary],
  statusBySessionId: [String: String],
  globalNeedsInputCount: Int,
  globalLiveSessionCount: Int,
  firstGlobalAttentionSessionId: String?,
  firstGlobalLiveSessionId: String?
) -> Int {
  var hasher = Hasher()
  hasher.combine(mergedSessions.count)
  for session in mergedSessions {
    hasher.combine(session.id)
    hasher.combine(session.title)
    hasher.combine(session.laneId)
    hasher.combine(session.laneName)
    hasher.combine(session.toolType)
    hasher.combine(session.summary)
    hasher.combine(session.lastOutputPreview)
    hasher.combine(session.status)
    hasher.combine(session.runtimeState)
    hasher.combine(session.chatIdleSinceAt)
    hasher.combine(session.pendingInputItemId)
    hasher.combine(session.chatSessionId)
    hasher.combine(session.archivedAt)
    hasher.combine(session.settledAt)
    hasher.combine(session.statusNote)
    hasher.combine(session.attentionRequestedAt)
    hasher.combine(session.attentionMessage)
    hasher.combine(session.lastTurnFailedAt)
    hasher.combine(session.settleOverride)
    hasher.combine(session.snoozedUntil)
    hasher.combine(session.snoozedAt)
    hasher.combine(session.wokeAt)
    hasher.combine(session.wokeReason)
    hasher.combine(session.endedAt)
    hasher.combine(session.pinned)
    hasher.combine(statusBySessionId[session.id])
    if let summary = chatSummaries[session.id] {
      hasher.combine(summary.title)
      hasher.combine(summary.provider)
      hasher.combine(summary.model)
      hasher.combine(summary.summary)
      hasher.combine(summary.lastOutputPreview)
      hasher.combine(summary.status)
      hasher.combine(summary.idleSinceAt)
      hasher.combine(summary.endedAt)
    }
  }
  hasher.combine(displaySessions.map(\.id))
  hasher.combine(topLevelDisplaySessionIds.sorted())
  hasher.combine(liveChatSessions.map(\.id))
  for group in sessionGroups {
    hasher.combine(group.id)
    hasher.combine(group.label)
    hasher.combine(group.isQuiet)
    // Gaining or losing a header reshapes the whole section; without this the
    // equatable short-circuit freezes the old shape on screen.
    hasher.combine(group.isHeaderless)
    hasher.combine(group.sessions.map(\.id))
  }
  for key in childGroupsByParentId.keys.sorted() {
    guard let group = childGroupsByParentId[key] else { continue }
    hasher.combine(key)
    hasher.combine(group.parentId)
    hasher.combine(group.collapsedSectionId)
    hasher.combine(group.children.map(\.id))
  }
  for lane in workOrderedLanes {
    hasher.combine(lane.id)
    hasher.combine(lane.name)
    hasher.combine(lane.color)
    hasher.combine(lane.status.dirty)
    hasher.combine(lane.status.ahead)
    hasher.combine(lane.status.behind)
  }
  for key in lanePrTagsByLaneId.keys.sorted() {
    guard let tag = lanePrTagsByLaneId[key] else { continue }
    hasher.combine(key)
    hasher.combine(tag.githubPrNumber)
    hasher.combine(lanePrStateLabel(tag.state))
  }
  hasher.combine(globalNeedsInputCount)
  hasher.combine(globalLiveSessionCount)
  hasher.combine(firstGlobalAttentionSessionId)
  hasher.combine(firstGlobalLiveSessionId)
  return hasher.finalize()
}

/// Derive the per-lane ordering facts a `LaneSummary` does not carry: the most
/// recent session activity, whether the lane is quiet, and whether it is pinned.
func workLaneOrderInputs(
  lanes: [LaneSummary],
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  archivedSessionIds: Set<String>,
  pinnedLaneIds: Set<String>,
  now: Date = Date()
) -> [String: WorkLaneOrderInput] {
  var latestByLaneId: [String: Date] = [:]
  for session in sessions {
    guard let activity = workParsedDate(
      workSessionActivityTimestamp(session: session, summary: chatSummaries[session.id])
    ) else { continue }
    if let current = latestByLaneId[session.laneId], current >= activity { continue }
    latestByLaneId[session.laneId] = activity
  }

  var inputs: [String: WorkLaneOrderInput] = [:]
  inputs.reserveCapacity(lanes.count)
  for lane in lanes {
    inputs[lane.id] = WorkLaneOrderInput(
      lane: lane,
      lastActivityAt: latestByLaneId[lane.id],
      quiet: workLaneSessionsAreQuiet(
        laneId: lane.id,
        sessions: sessions,
        chatSummaries: chatSummaries,
        archivedSessionIds: archivedSessionIds,
        now: now
      ),
      pinned: pinnedLaneIds.contains(lane.id)
    )
  }
  return inputs
}

/// Per-lane inputs to the singleton rule. Counts TOP-LEVEL rows only — a chat
/// with terminal children is one unit — over the unfiltered roster.
func workHeaderlessLaneInputs(
  lanes: [LaneSummary],
  sessions: [TerminalSessionSummary],
  pinnedLaneIds: Set<String>
) -> [WorkHeaderlessLaneInput] {
  let rosterIds = Set(sessions.map(\.id))
  var topLevelByLaneId: [String: Int] = [:]
  for session in sessions {
    let parentId = session.chatSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let isChild = !parentId.isEmpty && parentId != session.id && rosterIds.contains(parentId)
    guard !isChild else { continue }
    topLevelByLaneId[session.laneId, default: 0] += 1
  }
  return lanes.map { lane in
    WorkHeaderlessLaneInput(
      laneId: lane.id,
      topLevelSessionCount: topLevelByLaneId[lane.id] ?? 0,
      pinned: pinnedLaneIds.contains(lane.id)
    )
  }
}

func workSessionChildGroupsByParentId(sessions: [TerminalSessionSummary]) -> [String: WorkSessionChildGroup] {
  let visibleIds = Set(sessions.map(\.id))
  var childrenByParentId: [String: [TerminalSessionSummary]] = [:]
  for session in sessions {
    guard let parentId = normalizedWorkParentChatSessionId(session.chatSessionId),
      parentId != session.id,
      visibleIds.contains(parentId)
    else {
      continue
    }
    childrenByParentId[parentId, default: []].append(session)
  }

  return Dictionary(uniqueKeysWithValues: childrenByParentId.map { parentId, children in
    let ordered = children.sorted { lhs, rhs in
      let lhsDate = parseWorkSessionTimestamp(lhs.startedAt)
      let rhsDate = parseWorkSessionTimestamp(rhs.startedAt)
      if let lhsDate, let rhsDate, lhsDate != rhsDate {
        return lhsDate < rhsDate
      }
      if lhs.startedAt != rhs.startedAt {
        return lhs.startedAt < rhs.startedAt
      }
      return lhs.id < rhs.id
    }
    return (
      parentId,
      WorkSessionChildGroup(
        parentId: parentId,
        children: ordered,
        collapsedSectionId: workSessionChildSectionId(parentId: parentId)
      )
    )
  })
}

func workSessionChildSectionId(parentId: String) -> String {
  "chat:\(parentId)"
}

private func normalizedWorkParentChatSessionId(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}

private func parseWorkSessionTimestamp(_ rawValue: String) -> Date? {
  workSessionISO8601Formatter.date(from: rawValue) ?? workSessionISO8601FormatterNoFractional.date(from: rawValue)
}

private let workSessionISO8601Formatter: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

private let workSessionISO8601FormatterNoFractional: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  return formatter
}()

/// Group session list by the user's chosen organization. Empty groups are filtered out.
///
/// Snooze is applied here as a visibility overlay on top of whichever
/// organization is active: snoozed rows are lifted out of every other section
/// into a single quiet "Snoozed" tail. Their canonical phase is untouched —
/// this only decides where the list files them. Expiry is derived from the
/// clock (`isSessionSnoozed`), so there is no timer or scheduler on iOS either.
///
/// The one exception is the shared FILING rule (`isFiledAsSnoozed`): a row whose
/// canonical phase is `needsYou` stays in its normal section even while snoozed.
/// Snooze must yield to a session actually blocked on the user, otherwise an
/// "Until I'm asked" snooze (~100 years) hides a tracked CLI row that hit a
/// permission prompt forever — nothing wakes it, because its needs-input state
/// is derived and no early-wake event exists for it.
func workSessionGroups(
  organization: WorkSessionOrganization,
  sessions: [TerminalSessionSummary],
  quietReferenceSessions: [TerminalSessionSummary]? = nil,
  chatSummaries: [String: AgentChatSessionSummary],
  statusBySessionId: [String: String] = [:],
  archivedSessionIds: Set<String>,
  orderedLanes: [LaneSummary],
  deletingLaneIds: Set<String> = [],
  headerlessLaneIds: Set<String> = [],
  now: Date = Date()
) -> [WorkSessionGroup] {
  var snoozed: [TerminalSessionSummary] = []
  var awake: [TerminalSessionSummary] = []
  for session in sessions {
    if session.isFiledAsSnoozed(summary: chatSummaries[session.id], now: now) {
      snoozed.append(session)
    } else {
      awake.append(session)
    }
  }

  var groups: [WorkSessionGroup]
  switch organization {
  case .byStatus:
    groups = workSessionGroupsByStatus(
      sessions: awake,
      chatSummaries: chatSummaries,
      statusBySessionId: statusBySessionId,
      archivedSessionIds: archivedSessionIds
    )
  case .byLane:
    groups = workSessionGroupsByLane(
      sessions: awake,
      orderedLanes: orderedLanes,
      deletingLaneIds: deletingLaneIds,
      headerlessLaneIds: headerlessLaneIds
    ).map { group in
      group.markingQuiet(
        workLaneGroupIsQuiet(
          group,
          referenceSessions: quietReferenceSessions,
          chatSummaries: chatSummaries,
          archivedSessionIds: archivedSessionIds,
          now: now
        )
      )
    }
  case .byTime:
    groups = workSessionGroupsByTime(sessions: awake)
  }

  if !snoozed.isEmpty {
    groups.append(WorkSessionGroup(
      id: workSnoozedSectionId,
      label: "Snoozed",
      icon: .statusDot,
      tint: ADEColor.info,
      sessions: snoozed
    ))
  }
  return groups
}

/// Stable id for the snoozed tail so its collapse state persists like any other
/// section, independent of the active organization.
let workSnoozedSectionId = "status:snoozed"

extension WorkSessionGroup {
  func markingQuiet(_ quiet: Bool) -> WorkSessionGroup {
    guard quiet != isQuiet else { return self }
    return WorkSessionGroup(
      id: id,
      label: label,
      icon: icon,
      tint: tint,
      sessions: sessions,
      laneColor: laneColor,
      laneIcon: laneIcon,
      isOrphaned: isOrphaned,
      isQuiet: quiet,
      isHeaderless: isHeaderless
    )
  }

  func markingHeaderless(_ headerless: Bool) -> WorkSessionGroup {
    guard headerless != isHeaderless else { return self }
    return WorkSessionGroup(
      id: id,
      label: label,
      icon: icon,
      tint: tint,
      sessions: sessions,
      laneColor: laneColor,
      laneIcon: laneIcon,
      isOrphaned: isOrphaned,
      isQuiet: isQuiet,
      isHeaderless: headerless
    )
  }
}

/// A lane section holding nothing but settled work.
///
/// Archived rows count as quiet too — they are equally "not what you're working
/// on". A lane with anything running, ended-but-unsettled, or waiting on the
/// user is never quiet, which is what keeps an attention row from being folded
/// away behind a thin header.
func workLaneGroupIsQuiet(
  _ group: WorkSessionGroup,
  referenceSessions: [TerminalSessionSummary]? = nil,
  chatSummaries: [String: AgentChatSessionSummary],
  archivedSessionIds: Set<String>,
  now: Date
) -> Bool {
  guard let laneId = group.laneId else { return false }
  return workLaneSessionsAreQuiet(
    laneId: laneId,
    sessions: referenceSessions ?? group.sessions,
    chatSummaries: chatSummaries,
    archivedSessionIds: archivedSessionIds,
    now: now
  )
}

func workLaneSessionsAreQuiet(
  laneId: String,
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  archivedSessionIds: Set<String>,
  now: Date
) -> Bool {
  let laneSessions = sessions.filter { $0.laneId == laneId }
  guard !laneSessions.isEmpty else { return false }
  return laneSessions.allSatisfy { session in
    if archivedSessionIds.contains(session.id) { return true }
    if session.isFiledAsSnoozed(summary: chatSummaries[session.id], now: now) {
      return true
    }
    let canonical = workCanonicalSessionState(
      session: session,
      summary: chatSummaries[session.id],
      now: now
    )
    return canonical.phase == .settled
  }
}

func workSessionGroupsByStatus(
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  statusBySessionId: [String: String] = [:],
  archivedSessionIds: Set<String>
) -> [WorkSessionGroup] {
  var needsInput: [TerminalSessionSummary] = []
  var pinned: [TerminalSessionSummary] = []
  var running: [TerminalSessionSummary] = []
  var ended: [TerminalSessionSummary] = []
  var settled: [TerminalSessionSummary] = []
  var archived: [TerminalSessionSummary] = []

  for session in sessions {
    if archivedSessionIds.contains(session.id) {
      archived.append(session)
      continue
    }
    let canonical = workCanonicalSessionState(
      session: session,
      summary: chatSummaries[session.id]
    )
    switch canonical.phase {
    case .needsYou, .ready, .idle:
      needsInput.append(session)
    case .settled:
      settled.append(session)
    case .starting, .running, .stale:
      if session.pinned {
        pinned.append(session)
      } else {
        running.append(session)
      }
    case .failed, .stopped, .ended:
      if session.pinned {
        pinned.append(session)
      } else {
        ended.append(session)
      }
    }
  }

  var groups: [WorkSessionGroup] = []
  if !needsInput.isEmpty {
    groups.append(WorkSessionGroup(id: "status:awaiting", label: "Your move", icon: .statusDot, tint: ADEColor.warning, sessions: needsInput))
  }
  if !pinned.isEmpty {
    groups.append(WorkSessionGroup(id: "status:pinned", label: "Pinned", icon: .statusDot, tint: ADEColor.accent, sessions: pinned))
  }
  if !running.isEmpty {
    groups.append(WorkSessionGroup(id: "status:running", label: "Working", icon: .statusDot, tint: ADEColor.info, sessions: running))
  }
  if !ended.isEmpty {
    groups.append(WorkSessionGroup(id: "status:ended", label: "Ended", icon: .statusDot, tint: ADEColor.textMuted, sessions: ended))
  }
  if !settled.isEmpty {
    groups.append(WorkSessionGroup(id: "status:settled", label: "Settled", icon: .statusDot, tint: ADEColor.textMuted, sessions: settled))
  }
  if !archived.isEmpty {
    groups.append(WorkSessionGroup(id: "status:archived", label: "Archived", icon: .statusDot, tint: ADEColor.warning, sessions: archived))
  }
  return groups
}

func workSessionGroupsByLane(
  sessions: [TerminalSessionSummary],
  orderedLanes: [LaneSummary],
  deletingLaneIds: Set<String> = [],
  headerlessLaneIds: Set<String> = []
) -> [WorkSessionGroup] {
  var byLaneId: [String: [TerminalSessionSummary]] = [:]
  for session in sessions {
    byLaneId[session.laneId, default: []].append(session)
  }

  var groups: [WorkSessionGroup] = []
  let knownLaneIds = Set(orderedLanes.map(\.id))
  for lane in orderedLanes {
    guard let list = byLaneId[lane.id], !list.isEmpty else { continue }
    groups.append(WorkSessionGroup(
      id: "lane:\(lane.id)",
      label: lane.name,
      icon: .laneBranch,
      tint: LaneColorPalette.displayColor(forHex: lane.color),
      sessions: list,
      laneColor: lane.color,
      laneIcon: lane.icon,
      // Derived from the unfiltered roster, so a search that narrows a busy
      // lane to one hit never collapses its header mid-keystroke. `list` may
      // still hold that row's terminal children — they render nested under it.
      isHeaderless: headerlessLaneIds.contains(lane.id)
    ))
  }
  // Surface any sessions whose lane isn't in the ordered list (e.g., soft-deleted lanes)
  // as their own per-lane groups so users still recognize which branch each belongs to.
  func latestStartedAt(_ list: [TerminalSessionSummary]) -> Date {
    list.reduce(.distantPast) { acc, session in
      let parsed = parseWorkSessionTimestamp(session.startedAt) ?? .distantPast
      return parsed > acc ? parsed : acc
    }
  }
  func orphanLabel(_ name: String?, fallback: String) -> String {
    let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return trimmed.isEmpty ? fallback : trimmed
  }
  let orphanEntries = byLaneId
    .filter { laneId, list in !knownLaneIds.contains(laneId) && !list.isEmpty }
    .sorted { left, right in
      let leftLatest = latestStartedAt(left.value)
      let rightLatest = latestStartedAt(right.value)
      if leftLatest != rightLatest { return leftLatest > rightLatest }
      let leftName = orphanLabel(left.value.first?.laneName, fallback: left.key)
      let rightName = orphanLabel(right.value.first?.laneName, fallback: right.key)
      return leftName.localizedCaseInsensitiveCompare(rightName) == .orderedAscending
    }
  for (laneId, list) in orphanEntries {
    let label = deletingLaneIds.contains(laneId)
      ? "Updating lane…"
      : orphanLabel(list.first?.laneName, fallback: laneId)
    groups.append(WorkSessionGroup(
      id: "lane:\(laneId)",
      label: label,
      icon: .warning,
      tint: ADEColor.warning,
      sessions: list,
      isOrphaned: true
    ))
  }
  return groups
}

func workSessionGroupsByTime(sessions: [TerminalSessionSummary]) -> [WorkSessionGroup] {
  let calendar = Calendar.current
  let now = Date()
  let todayStart = calendar.startOfDay(for: now)
  let yesterdayStart = calendar.date(byAdding: .day, value: -1, to: todayStart) ?? todayStart

  var today: [TerminalSessionSummary] = []
  var yesterday: [TerminalSessionSummary] = []
  var older: [TerminalSessionSummary] = []

  for session in sessions {
    let parsed = parseWorkSessionTimestamp(session.startedAt)
    guard let started = parsed else {
      older.append(session)
      continue
    }
    if started >= todayStart {
      today.append(session)
    } else if started >= yesterdayStart {
      yesterday.append(session)
    } else {
      older.append(session)
    }
  }

  var groups: [WorkSessionGroup] = []
  if !today.isEmpty {
    groups.append(WorkSessionGroup(id: "time:today", label: "Today", icon: .none, tint: ADEColor.textSecondary, sessions: today))
  }
  if !yesterday.isEmpty {
    groups.append(WorkSessionGroup(id: "time:yesterday", label: "Yesterday", icon: .none, tint: ADEColor.textSecondary, sessions: yesterday))
  }
  if !older.isEmpty {
    groups.append(WorkSessionGroup(id: "time:older", label: "Older", icon: .none, tint: ADEColor.textMuted, sessions: older))
  }
  return groups
}

// MARK: - Offline machine banner

/// One "this machine is gone" banner for the Work list. Presentation only: the
/// rows themselves keep working, they just stop pretending they can be acted on.
struct WorkOfflineMachineBanner: Identifiable, Equatable {
  let id: String
  let machineName: String
  let lastSeenLabel: String?
}

/// Which offline machines own work in the project the Work list is showing.
///
/// The connected host is online by definition — that is what "connected" means —
/// so anything this returns is a foreign machine whose lanes are visible through
/// the account feed. Scope match is by project id, falling back to lane id for
/// items published before a project id was carried.
func workOfflineMachineBanners(
  scopes: [ActivityOfflineScope],
  activeProjectId: String?,
  laneIds: Set<String> = [],
  now: Date = Date()
) -> [WorkOfflineMachineBanner] {
  let project = activeProjectId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  var seen: Set<String> = []
  var banners: [WorkOfflineMachineBanner] = []
  for scope in scopes {
    let matchesProject = !project.isEmpty && scope.projectId == project
    let matchesLane = scope.laneId.map(laneIds.contains) ?? false
    guard matchesProject || matchesLane else { continue }
    guard seen.insert(scope.machineKey).inserted else { continue }
    banners.append(WorkOfflineMachineBanner(
      id: scope.machineKey,
      machineName: scope.machineName,
      lastSeenLabel: scope.lastSeenLabel(now: now)
    ))
  }
  return banners.sorted { $0.machineName.localizedCaseInsensitiveCompare($1.machineName) == .orderedAscending }
}

/// Persistence helper for the comma-separated collapsed-section-ids string stored in AppStorage.
func workParseCollapsedSectionIds(_ raw: String) -> Set<String> {
  Set(raw.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })
}

func workSerializeCollapsedSectionIds(_ ids: Set<String>) -> String {
  ids.sorted().joined(separator: ",")
}

/// Frames a lane deeplink for both collapse conventions: ordinary lane groups
/// open when their `lane:` marker is absent, while quiet lane groups open only
/// when their inverted `lane-open:` marker is present.
func workCollapsedSectionIdsFramingLane(_ ids: Set<String>, laneId: String) -> Set<String> {
  var framed = ids
  framed.remove("lane:\(laneId)")
  framed.insert("lane-open:\(laneId)")
  return framed
}

// MARK: - Scoped Work view state

/// The Work tab's per-project view state.
///
/// These used to be flat global `@AppStorage` keys, which meant one shared set
/// of filters and collapsed sections across every project *and* every host:
/// switching projects carried the previous project's filters over, and because
/// section ids are `lane:<laneId>`, one project's collapse state could silently
/// apply to another's lanes. Scoping fixes both, and makes the state survive a
/// project or machine switch instead of reading as "reset".
struct WorkProjectViewState: Codable, Equatable {
  var searchText: String = ""
  var laneFilter: String = "all"
  var statusFilter: String = WorkSessionStatusFilter.all.rawValue
  var organization: String = WorkSessionOrganization.byLane.rawValue
  var collapsedSectionIds: String = ""

  static let empty = WorkProjectViewState()
}

/// Returns the persisted base when a user takes control back from transient
/// deeplink framing. Falling back to the current state keeps ordinary,
/// non-deeplink edits unchanged.
func workViewStateRestoringUserControl(
  savedBase: WorkProjectViewState?,
  current: WorkProjectViewState
) -> WorkProjectViewState {
  savedBase ?? current
}

/// Versioned `scopeKey → WorkProjectViewState` store in the shared app group.
///
/// Scoped by host identity as well as project id: the same project id can exist
/// on two paired machines, and the user's view of each is their own. Mirrors the
/// host-scoping already used for hidden projects in `SyncService`.
enum WorkViewStateStore {
  private static let storageKey = "ade.work.viewStateByScope.v1"
  private static var defaults: UserDefaults { ADESharedContainer.defaults }

  /// `nil` when the project is unknown — callers then keep the in-memory state
  /// rather than writing it somewhere it could clobber a real project's record.
  static func scopeKey(projectId: String?, hostIdentity: String?) -> String? {
    let project = (projectId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !project.isEmpty else { return nil }
    let host = (hostIdentity ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return host.isEmpty ? project : "\(host)::\(project)"
  }

  static func load(scope: String?) -> WorkProjectViewState {
    guard let scope else { return .empty }
    guard
      let map = defaults.dictionary(forKey: storageKey) as? [String: Data],
      let raw = map[scope],
      let decoded = try? JSONDecoder().decode(WorkProjectViewState.self, from: raw)
    else { return .empty }
    return decoded
  }

  static func save(_ state: WorkProjectViewState, scope: String?) {
    guard let scope, let encoded = try? JSONEncoder().encode(state) else { return }
    var map = (defaults.dictionary(forKey: storageKey) as? [String: Data]) ?? [:]
    map[scope] = encoded
    defaults.set(map, forKey: storageKey)
  }
}
