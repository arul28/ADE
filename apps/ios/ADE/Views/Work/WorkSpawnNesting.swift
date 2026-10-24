import Foundation

/// Same-lane `spawnKind == .subagent` chats nest under their parent in the
/// by-lane Work list: they leave the list and live only in the parent's Chat
/// Info, while the parent row shows one mark for them. Mirrors
/// `apps/desktop/src/shared/sessionSpawnNesting.ts` so a demote, a
/// quiet-parent pull-up, or a grandchild flatten cannot disagree with desktop.

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

/// Identity of a parent's subagent group. Nested subagents no longer render a
/// drawer, so a stored `chat-subagents:` or `drawer-open:chat-subagents:`
/// collapse marker is inert.
func workSessionSubagentSectionId(parentId: String) -> String {
  "chat-subagents:\(parentId)"
}

/// A chat's shell drawer defaults to COLLAPSED: a busy agent can hang a dozen
/// App Control shells off one chat. Same inverted
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

/// Failed or needs you, from the row each child would paint. Same rule as
/// desktop `nestedSubagentDrawerAttention`: Failed is the red word the row
/// paints, not raw phase `failed`. A usage-limit resume remaps that phase off
/// red, and the parent's mark must follow.
private func workNestedChildAttention(
  _ child: TerminalSessionSummary,
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> WorkNestedDrawerStatus {
  let row = workSessionRowPresentation(
    session: child,
    summary: chatSummaries[child.id],
    now: now
  )
  guard let status = row.status, activityStatusShoutsLabel(glyph: status.glyph, tone: status.tone) else {
    return .none
  }
  return status.tone == .red ? .failed : .needsYou
}

/// One child's contribution: its attention, else running, else nothing.
private func workNestedChildStatus(
  _ child: TerminalSessionSummary,
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> WorkNestedDrawerStatus {
  let attention = workNestedChildAttention(child, chatSummaries: chatSummaries, now: now)
  if attention != .none { return attention }
  switch workCanonicalSessionState(session: child, summary: chatSummaries[child.id], now: now).phase {
  case .running, .starting: return .running
  default: return .none
  }
}

func workNestedSubagentDrawerAttention(
  _ children: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> WorkNestedDrawerStatus {
  children.reduce(WorkNestedDrawerStatus.none) { worst, child in
    max(worst, workNestedChildAttention(child, chatSummaries: chatSummaries, now: now))
  }
}

/// The one state a parent's nested mark shows next to its count: failed, then
/// needs you (both via `workNestedSubagentDrawerAttention`), then running.
/// Ended and done children add nothing. Mirrors desktop `nestedDrawerStatus`.
func workNestedDrawerStatus(
  _ children: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> WorkNestedDrawerStatus {
  workNestedDrawerStatusAndCount(children, chatSummaries: chatSummaries, now: now).status
}

/// The worst child state plus how many children are in it ("1 needs you").
func workNestedDrawerStatusAndCount(
  _ children: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> (status: WorkNestedDrawerStatus, count: Int) {
  var worst = WorkNestedDrawerStatus.none
  var count = 0
  for child in children {
    let status = workNestedChildStatus(child, chatSummaries: chatSummaries, now: now)
    if status > worst {
      worst = status
      count = 1
    } else if status == worst, status != .none {
      count += 1
    }
  }
  return (worst, count)
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

/// Nested status, highest first: failed > needs you > running > nothing.
/// `workNestedSubagentDrawerAttention` yields only failed/needs-you;
/// `workNestedDrawerStatus` adds running. Declared lowest to highest so
/// `Comparable` ranks them.
enum WorkNestedDrawerStatus: Int, Comparable {
  case none
  case running
  case needsYou
  case failed

  static func < (lhs: WorkNestedDrawerStatus, rhs: WorkNestedDrawerStatus) -> Bool {
    lhs.rawValue < rhs.rawValue
  }
}

/// A parent's nested children. Shell groups render as the parent's shell
/// drawer. Subagent groups are never listed: a nested subagent lives only in
/// its parent's Chat Info, and the group feeds the parent row's one mark
/// (count plus the worst child state).
struct WorkSessionChildGroup: Equatable, Identifiable {
  let parentId: String
  let children: [TerminalSessionSummary]
  let collapsedSectionId: String
  let kind: WorkNestedSessionGroupKind
  let status: WorkNestedDrawerStatus
  /// How many children are in `status` (0 when `status` is `.none`).
  var statusCount: Int = 0

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
    let status = workNestedDrawerStatusAndCount(ordered, chatSummaries: chatSummaries, now: now)
    return (
      parentId,
      WorkSessionChildGroup(
        parentId: parentId,
        children: ordered,
        collapsedSectionId: workSessionSubagentSectionId(parentId: parentId),
        kind: .subagents,
        status: status.status,
        statusCount: status.count
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

/// The one mark a parent's Work row shows for its nested subagents: how many,
/// and the worst state among them (failed > needs you > running). The children
/// themselves are listed only in the parent's Chat Info.
struct WorkNestedSubagentMark: Hashable {
  let count: Int
  let status: WorkNestedDrawerStatus
  /// Children in `status`; 0 when `status` is `.none`.
  let statusCount: Int

  init(count: Int, status: WorkNestedDrawerStatus, statusCount: Int) {
    self.count = count
    self.status = status
    self.statusCount = statusCount
  }

  init?(group: WorkSessionChildGroup?) {
    guard let group, group.kind == .subagents, !group.children.isEmpty else { return nil }
    self.init(count: group.children.count, status: group.status, statusCount: group.statusCount)
  }

  /// "2 subagents, 1 needs you".
  var accessibilityLabel: String {
    let base = count == 1 ? "1 subagent" : "\(count) subagents"
    switch status {
    case .failed: return "\(base), \(statusCount) failed"
    case .needsYou: return "\(base), \(statusCount) needs you"
    case .running: return "\(base), \(statusCount) running"
    case .none: return base
    }
  }
}

// MARK: - Child chats in the parent's Chat Info

/// What a chat's Chat Info reads about its child chats, handed down by the
/// Work root from the same rows the list holds. A row from another machine
/// carries that machine's namespaced lane id (`fleet|<machineKey>|<laneId>`),
/// so a child found here opens on its own machine.
struct WorkChatChildRoster: Equatable {
  /// The parent's own lane id as the list holds it.
  var parentLaneId: String?
  /// Rows that name this chat as their orchestration parent, any lane.
  var children: [TerminalSessionSummary]
  var summaries: [String: AgentChatSessionSummary]
  /// Every row's lane id as the list holds it, for opening a child the
  /// parent's transcript names (`chat:<id>`).
  var laneIdBySessionId: [String: String]

  static let empty = WorkChatChildRoster(
    parentLaneId: nil,
    children: [],
    summaries: [:],
    laneIdBySessionId: [:]
  )
}

func workChatChildRoster(
  parentId: String,
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary]
) -> WorkChatChildRoster {
  var parentLaneId: String?
  var children: [TerminalSessionSummary] = []
  var summaries: [String: AgentChatSessionSummary] = [:]
  var laneIdBySessionId: [String: String] = [:]
  for session in sessions {
    laneIdBySessionId[session.id] = session.laneId
    if session.id == parentId {
      parentLaneId = session.laneId
      continue
    }
    guard workOrchestrationParentId(session, summary: chatSummaries[session.id]) == parentId else { continue }
    children.append(session)
    if let summary = chatSummaries[session.id] { summaries[session.id] = summary }
  }
  return WorkChatChildRoster(
    parentLaneId: parentLaneId,
    children: children.sorted(by: workNestedChildSort),
    summaries: summaries,
    laneIdBySessionId: laneIdBySessionId
  )
}

/// The child session id of a spawned child chat's Chat Info row, or nil for a
/// native in-thread subagent.
func workChatInfoChildSessionId(_ snapshot: WorkSubagentSnapshot) -> String? {
  let taskId = snapshot.taskId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard taskId.hasPrefix("chat:") else { return nil }
  let id = String(taskId.dropFirst("chat:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
  return id.isEmpty ? nil : id
}

/// Chat Info's subagent list with the parent's child chats folded in.
///
/// The parent's transcript already names each spawned child (`chat:<id>`).
/// Two gaps remain, and both are filled from the child's own Work row:
/// a nested child (same lane, `spawnKind == .subagent`) the transcript has
/// not named yet is added, and every child row reads "Needs you" while the
/// child waits on the user, even after its spawn result landed.
/// `summary` returns the freshest summary the caller holds for a child.
func workChatInfoSubagentsWithChildChats(
  _ snapshots: [WorkSubagentSnapshot],
  roster: WorkChatChildRoster,
  summary: (String) -> AgentChatSessionSummary?,
  now: Date = Date()
) -> [WorkSubagentSnapshot] {
  guard !roster.children.isEmpty else { return snapshots }
  let childById = Dictionary(roster.children.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
  func phase(_ child: TerminalSessionSummary) -> CanonicalSessionPhase {
    workCanonicalSessionState(session: child, summary: summary(child.id), now: now).phase
  }
  var named: Set<String> = []
  var result = snapshots.map { snapshot -> WorkSubagentSnapshot in
    guard let childId = workChatInfoChildSessionId(snapshot) else { return snapshot }
    named.insert(childId)
    guard let child = childById[childId] else { return snapshot }
    var next = snapshot
    next.needsInput = phase(child) == .needsYou
    return next
  }
  for child in roster.children where !named.contains(child.id) {
    let childSummary = summary(child.id)
    guard workSpawnKind(child, summary: childSummary) == .subagent,
          let parentLaneId = roster.parentLaneId,
          child.laneId == parentLaneId
    else { continue }
    let childPhase = phase(child)
    let status: WorkSubagentSnapshot.Status
    switch childPhase {
    case .starting, .running, .stale, .needsYou: status = .running
    case .failed: status = .failed
    case .stopped: status = .stopped
    case .ready, .idle, .ended, .settled: status = .succeeded
    }
    let title = (childSummary?.title ?? child.title).trimmingCharacters(in: .whitespacesAndNewlines)
    result.append(WorkSubagentSnapshot(
      taskId: "chat:\(child.id)",
      agentId: child.id,
      agentType: nil,
      provider: childSummary?.provider,
      parentToolUseId: nil,
      description: title,
      background: false,
      label: title.isEmpty ? nil : title,
      model: childSummary?.model,
      reasoningEffort: nil,
      status: status,
      lastToolName: nil,
      latestSummary: nil,
      turnId: nil,
      startedAt: child.startedAt.isEmpty ? nil : child.startedAt,
      updatedAt: child.lastActivityAt,
      spawnKind: .subagent,
      needsInput: childPhase == .needsYou
    ))
  }
  return result
}
