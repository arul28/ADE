import Foundation

/// Same-lane `spawnKind == .subagent` chats nest under their parent in the
/// by-lane Work list. Mirrors `apps/desktop/src/shared/sessionSpawnNesting.ts`
/// so a demote, a quiet-parent pull-up, or a grandchild flatten cannot
/// disagree with desktop.

struct WorkSpawnNestingIndex: Equatable {
  var childrenByRootParentId: [String: [TerminalSessionSummary]]
  var nestedChildIds: Set<String>
  var nestedChildToRootParentId: [String: String]

  static let empty = WorkSpawnNestingIndex(
    childrenByRootParentId: [:],
    nestedChildIds: [],
    nestedChildToRootParentId: [:]
  )
}

/// Root parents whose same-lane nested subagents still keep them busy.
/// Mirrors desktop `parentsWithBusySubagents`; the nesting index owns lineage
/// validation and grandchild flattening, while this predicate owns liveness.
func workBusySubagentParentIds(
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  archivedSessionIds: Set<String> = [],
  now: Date
) -> Set<String> {
  let nesting = workIndexNestedSubagents(
    sessions: sessions,
    chatSummaries: chatSummaries,
    now: now,
    visibleParentIds: Set(sessions.map(\.id))
  )
  var parents: Set<String> = []
  for (rootParentId, children) in nesting.childrenByRootParentId {
    for child in children {
      let archivedAt = child.archivedAt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard archivedAt.isEmpty, !archivedSessionIds.contains(child.id),
        !child.isFiledAsSnoozed(summary: chatSummaries[child.id], now: now)
      else { continue }
      let phase = workCanonicalSessionState(
        session: child,
        summary: chatSummaries[child.id],
        now: now
      ).phase
      switch phase {
      case .starting, .running, .stale:
        parents.insert(rootParentId)
      case .ready, .idle:
        if workScheduledWakeIsPending(chatSummaries[child.id]?.nextWakeAt, now: now) {
          parents.insert(rootParentId)
        }
      case .needsYou, .failed, .stopped, .ended, .settled:
        continue
      }
    }
  }
  return parents
}

/// Desktop keeps an armed wake pending for two minutes after its fire time so
/// small scheduler/delivery delays do not make a row jump to Done.
func workScheduledWakeIsPending(_ nextWakeAt: String?, now: Date) -> Bool {
  guard let wakeAt = workParsedDate(nextWakeAt) else { return false }
  return now < wakeAt.addingTimeInterval(120)
}

func workSessionChildSectionId(parentId: String) -> String {
  "chat:\(parentId)"
}

func workSessionSubagentSectionId(parentId: String) -> String {
  "chat-subagents:\(parentId)"
}

/// A chat's shell and subagent drawers default to COLLAPSED: a busy agent can
/// hang a dozen App Control shells and subagents off one chat. Same inverted
/// shape as the quiet shelves — an explicit open writes `drawer-open:<id>` into
/// `collapsedSectionIds`. A legacy `chat:<id>` entry from the expanded-by-default
/// days is inert. Mirrors desktop `nestedDrawerOpenMarker`.
func workNestedDrawerOpenMarker(sectionId: String) -> String {
  "drawer-open:\(sectionId)"
}

func workIsNestedDrawerCollapsed(sectionId: String, collapsedSectionIds: Set<String>) -> Bool {
  !collapsedSectionIds.contains(workNestedDrawerOpenMarker(sectionId: sectionId))
}

func workIndexNestedSubagents(
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date,
  visibleParentIds: Set<String>
) -> WorkSpawnNestingIndex {
  guard !sessions.isEmpty else { return .empty }
  let byId = Dictionary(uniqueKeysWithValues: sessions.map { ($0.id, $0) })
  var nestUnderImmediate: [String: String] = [:]
  for session in sessions {
    guard let parentId = workImmediateSubagentParentId(
      session: session,
      byId: byId,
      chatSummaries: chatSummaries
    ) else { continue }
    guard let parent = byId[parentId] else { continue }
    if workIsQuietParent(parent, summary: chatSummaries[parent.id], now: now),
       workIsNotDone(session, summary: chatSummaries[session.id], now: now)
    {
      continue
    }
    nestUnderImmediate[session.id] = parentId
  }

  var childrenByRootParentId: [String: [TerminalSessionSummary]] = [:]
  var nestedChildIds: Set<String> = []
  var nestedChildToRootParentId: [String: String] = [:]
  for session in sessions {
    guard let rootParentId = workFlattenToRootParentId(
      sessionId: session.id,
      nestUnderImmediate: nestUnderImmediate
    ) else { continue }
    guard visibleParentIds.contains(rootParentId) else { continue }
    nestedChildIds.insert(session.id)
    nestedChildToRootParentId[session.id] = rootParentId
    childrenByRootParentId[rootParentId, default: []].append(session)
  }
  return WorkSpawnNestingIndex(
    childrenByRootParentId: childrenByRootParentId,
    nestedChildIds: nestedChildIds,
    nestedChildToRootParentId: nestedChildToRootParentId
  )
}

func workAttachedShellNestParentId(
  session: TerminalSessionSummary,
  nestedChildToRootParentId: [String: String]
) -> String? {
  guard let parentId = normalizedWorkParentChatSessionId(session.chatSessionId),
    parentId != session.id
  else { return nil }
  return nestedChildToRootParentId[parentId] ?? parentId
}

func workNestedSubagentDrawerAttention(
  _ children: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> WorkNestedDrawerStatus {
  var needsYou = false
  for child in children {
    let row = workSessionRowPresentation(
      session: child,
      summary: chatSummaries[child.id],
      now: now
    )
    // Same rule as desktop `nestedSubagentDrawerAttention`: Failed is the red
    // word the row paints, not raw phase `failed`. A usage-limit resume remaps
    // that phase off red, and the drawer header must follow.
    if let status = row.status, activityStatusShoutsLabel(glyph: status.glyph, tone: status.tone) {
      if status.tone == .red { return .failed }
      needsYou = true
    }
  }
  return needsYou ? .needsYou : .none
}

/// The one state a COLLAPSED drawer shows next to its count: failed, then needs
/// you (both via `workNestedSubagentDrawerAttention`), then running. Ended and
/// done children add nothing. Mirrors desktop `nestedDrawerStatus`.
func workNestedDrawerStatus(
  _ children: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> WorkNestedDrawerStatus {
  let attention = workNestedSubagentDrawerAttention(children, chatSummaries: chatSummaries, now: now)
  if attention != .none { return attention }
  for child in children {
    switch workCanonicalSessionState(session: child, summary: chatSummaries[child.id], now: now).phase {
    case .running, .starting: return .running
    default: continue
    }
  }
  return .none
}

private func workIsArchivedAttachedShell(_ session: TerminalSessionSummary) -> Bool {
  let archivedAt = session.archivedAt?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return !archivedAt.isEmpty && !isWorkChatToolType(session.toolType)
}

private func workSpawnKind(
  _ session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?
) -> AgentChatSpawnKind? {
  session.spawnKind ?? session.resumeMetadata?.spawnKind ?? summary?.spawnKind
}

private func workOrchestrationParentId(
  _ session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?
) -> String? {
  let fromSession = session.orchestrationParentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !fromSession.isEmpty { return fromSession }
  let fromResume = session.resumeMetadata?.orchestrationParentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !fromResume.isEmpty { return fromResume }
  let fromSummary = summary?.orchestrationParentSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return fromSummary.isEmpty ? nil : fromSummary
}

private func workImmediateSubagentParentId(
  session: TerminalSessionSummary,
  byId: [String: TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary]
) -> String? {
  guard workSpawnKind(session, summary: chatSummaries[session.id]) == .subagent else { return nil }
  guard let parentId = workOrchestrationParentId(session, summary: chatSummaries[session.id]),
    parentId != session.id,
    let parent = byId[parentId],
    parent.laneId == session.laneId
  else { return nil }
  return parent.id
}

private func workFlattenToRootParentId(
  sessionId: String,
  nestUnderImmediate: [String: String]
) -> String? {
  guard var parentId = nestUnderImmediate[sessionId] else { return nil }
  var seen: Set<String> = [sessionId]
  while nestUnderImmediate[parentId] != nil {
    if seen.contains(parentId) { return nil }
    seen.insert(parentId)
    guard let next = nestUnderImmediate[parentId] else { break }
    parentId = next
  }
  return parentId
}

private func workIsQuietParent(
  _ session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?,
  now: Date
) -> Bool {
  if session.isFiledAsSnoozed(summary: summary, now: now) { return true }
  return workCanonicalSessionState(session: session, summary: summary, now: now).phase == .settled
}

private func workIsNotDone(
  _ session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?,
  now: Date
) -> Bool {
  switch workCanonicalSessionState(session: session, summary: summary, now: now).phase {
  case .starting, .running, .needsYou, .failed, .stale: return true
  case .stopped, .ready, .idle, .ended, .settled: return false
  }
}

private func normalizedWorkParentChatSessionId(_ value: String?) -> String? {
  let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  return trimmed.isEmpty ? nil : trimmed
}

func workIsTopLevelWorkSession(
  session: TerminalSessionSummary,
  rosterIds: Set<String>,
  nestedChildIds: Set<String>,
  nestedChildToRootParentId: [String: String]
) -> Bool {
  if nestedChildIds.contains(session.id) { return false }
  guard let shellParent = workAttachedShellNestParentId(
    session: session,
    nestedChildToRootParentId: nestedChildToRootParentId
  ), shellParent != session.id, rosterIds.contains(shellParent) else {
    return true
  }
  return false
}

enum WorkNestedSessionGroupKind: Equatable {
  case shells
  case subagents
}

/// Drawer status, highest first: failed > needs you > running > nothing.
/// `workNestedSubagentDrawerAttention` yields only failed/needs-you;
/// `workNestedDrawerStatus` adds running.
enum WorkNestedDrawerStatus: Equatable {
  case none
  case running
  case needsYou
  case failed
}

struct WorkSessionChildGroup: Equatable, Identifiable {
  let parentId: String
  let children: [TerminalSessionSummary]
  let collapsedSectionId: String
  let kind: WorkNestedSessionGroupKind
  let status: WorkNestedDrawerStatus

  var id: String { collapsedSectionId }

  var label: String {
    switch kind {
    case .shells:
      return children.count == 1 ? "1 shell" : "\(children.count) shells"
    case .subagents:
      return children.count == 1 ? "1 subagent" : "\(children.count) subagents"
    }
  }

  var systemImage: String {
    switch kind {
    case .shells: return "terminal"
    case .subagents: return "person.2"
    }
  }
}

/// Every attached shell whose chat is visible is FILED under that chat, so none
/// surfaces as a top-level row. An archived one is then left out of the drawer:
/// dead agent shells are archived on purpose to keep it quiet. Mirrors desktop
/// `workNestingDrawers`.
struct WorkAttachedShellFiling {
  var groupsByParentId: [String: WorkSessionChildGroup]
  var filedShellIds: Set<String>
}

func workAttachedShellGroupsByParentId(
  sessions: [TerminalSessionSummary],
  nestedChildToRootParentId: [String: String],
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> WorkAttachedShellFiling {
  let visibleIds = Set(sessions.map(\.id))
  var childrenByParentId: [String: [TerminalSessionSummary]] = [:]
  var filedShellIds: Set<String> = []
  for session in sessions {
    guard let parentId = workAttachedShellNestParentId(
      session: session,
      nestedChildToRootParentId: nestedChildToRootParentId
    ), parentId != session.id, visibleIds.contains(parentId)
    else {
      continue
    }
    filedShellIds.insert(session.id)
    if workIsArchivedAttachedShell(session) { continue }
    childrenByParentId[parentId, default: []].append(session)
  }

  let groups = Dictionary(uniqueKeysWithValues: childrenByParentId.map { parentId, children in
    let ordered = children.sorted(by: workNestedChildSort)
    return (
      parentId,
      WorkSessionChildGroup(
        parentId: parentId,
        children: ordered,
        collapsedSectionId: workSessionChildSectionId(parentId: parentId),
        kind: .shells,
        status: workNestedDrawerStatus(ordered, chatSummaries: chatSummaries, now: now)
      )
    )
  })
  return WorkAttachedShellFiling(groupsByParentId: groups, filedShellIds: filedShellIds)
}

func workSessionSubagentGroups(
  from index: WorkSpawnNestingIndex,
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> [String: WorkSessionChildGroup] {
  Dictionary(uniqueKeysWithValues: index.childrenByRootParentId.map { parentId, children in
    let ordered = children.sorted(by: workNestedChildSort)
    return (
      parentId,
      WorkSessionChildGroup(
        parentId: parentId,
        children: ordered,
        collapsedSectionId: workSessionSubagentSectionId(parentId: parentId),
        kind: .subagents,
        status: workNestedDrawerStatus(
          ordered,
          chatSummaries: chatSummaries,
          now: now
        )
      )
    )
  })
}

func workNestedGroupsByParentId(
  subagents: [String: WorkSessionChildGroup],
  shells: [String: WorkSessionChildGroup]
) -> [String: [WorkSessionChildGroup]] {
  var map: [String: [WorkSessionChildGroup]] = [:]
  for parentId in Set(subagents.keys).union(shells.keys) {
    var groups: [WorkSessionChildGroup] = []
    if let sub = subagents[parentId] { groups.append(sub) }
    if let shell = shells[parentId] { groups.append(shell) }
    map[parentId] = groups
  }
  return map
}

private func workNestedChildSort(_ lhs: TerminalSessionSummary, _ rhs: TerminalSessionSummary) -> Bool {
  let lhsDate = workParsedDate(lhs.startedAt)
  let rhsDate = workParsedDate(rhs.startedAt)
  if let lhsDate, let rhsDate, lhsDate != rhsDate {
    return lhsDate < rhsDate
  }
  if lhs.startedAt != rhs.startedAt {
    return lhs.startedAt < rhs.startedAt
  }
  return lhs.id < rhs.id
}
