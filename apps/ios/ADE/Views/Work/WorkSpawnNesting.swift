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

func workSessionChildSectionId(parentId: String) -> String {
  "chat:\(parentId)"
}

func workSessionSubagentSectionId(parentId: String) -> String {
  "chat-subagents:\(parentId)"
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
) -> WorkNestedDrawerAttention {
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

enum WorkNestedDrawerAttention: Equatable {
  case none
  case needsYou
  case failed
}

struct WorkSessionChildGroup: Equatable, Identifiable {
  let parentId: String
  let children: [TerminalSessionSummary]
  let collapsedSectionId: String
  let kind: WorkNestedSessionGroupKind
  let attention: WorkNestedDrawerAttention

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

func workAttachedShellGroupsByParentId(
  sessions: [TerminalSessionSummary],
  nestedChildToRootParentId: [String: String]
) -> [String: WorkSessionChildGroup] {
  let visibleIds = Set(sessions.map(\.id))
  var childrenByParentId: [String: [TerminalSessionSummary]] = [:]
  for session in sessions {
    guard let parentId = workAttachedShellNestParentId(
      session: session,
      nestedChildToRootParentId: nestedChildToRootParentId
    ), parentId != session.id, visibleIds.contains(parentId)
    else {
      continue
    }
    childrenByParentId[parentId, default: []].append(session)
  }

  return Dictionary(uniqueKeysWithValues: childrenByParentId.map { parentId, children in
    let ordered = children.sorted(by: workNestedChildSort)
    return (
      parentId,
      WorkSessionChildGroup(
        parentId: parentId,
        children: ordered,
        collapsedSectionId: workSessionChildSectionId(parentId: parentId),
        kind: .shells,
        attention: .none
      )
    )
  })
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
        attention: workNestedSubagentDrawerAttention(
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
