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

/// A chat's shell drawer defaults to COLLAPSED: a busy agent can hang a dozen
/// App Control shells off one chat. Same inverted shape as the quiet shelves:
/// an explicit open writes `drawer-open:<id>` into `collapsedSectionIds`, so a
/// plain `chat:<id>` entry is inert. Desktop has no drawer (it lists attached
/// shells in the chat's actions pane), so this marker is iOS's own.
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
  // Filing order, oldest first, as desktop's `sortNestedChildren`: Chat Info
  // appends missing children in this order.
  for parentId in childrenByRootParentId.keys {
    childrenByRootParentId[parentId]?.sort(by: workNestedChildSort)
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

/// One child's contribution to a nested mark: failed or needs you from the
/// row the child would paint, else running, else nothing. Same rule as desktop
/// `nestedSubagentStatus`: Failed is the red word the row paints, not raw
/// phase `failed`, so a usage-limit resume that remaps that phase off red
/// counts as nothing. One row presentation per child; its phase answers
/// running.
private func workNestedChildStatus(
  _ child: TerminalSessionSummary,
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> WorkNestedStatus {
  let row = workSessionRowPresentation(
    session: child,
    summary: chatSummaries[child.id],
    now: now
  )
  if let status = row.status, activityStatusShoutsLabel(glyph: status.glyph, tone: status.tone) {
    return status.tone == .red ? .failed : .needsYou
  }
  switch row.phase {
  case .running, .starting: return .running
  default: return .none
  }
}

/// The worst child state plus how many children are in it ("1 needs you").
/// One `workNestedChildStatus` per child.
private func workNestedStatusAndCount(
  _ children: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> (status: WorkNestedStatus, count: Int) {
  var worst = WorkNestedStatus.none
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
    parent.laneId == session.laneId,
    // Only a chat lists its subagents (Chat Info). A child of a tracked CLI or
    // a shell stays a top-level row, or nothing would show it.
    isWorkChatToolType(parent.toolType)
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

/// Nested status, highest first: failed > needs you > running > nothing.
/// Declared lowest to highest so `Comparable` ranks them.
enum WorkNestedStatus: Int, Comparable {
  case none
  case running
  case needsYou
  case failed

  static func < (lhs: WorkNestedStatus, rhs: WorkNestedStatus) -> Bool {
    lhs.rawValue < rhs.rawValue
  }
}

/// A chat's shell drawer: the attached shells rendered under its Work row.
struct WorkShellDrawer: Equatable, Identifiable {
  let children: [TerminalSessionSummary]
  let collapsedSectionId: String
  let status: WorkNestedStatus

  var id: String { collapsedSectionId }

  var label: String {
    children.count == 1 ? "1 shell" : "\(children.count) shells"
  }
}

/// Every attached shell whose chat is visible is FILED under that chat, so none
/// surfaces as a top-level row. An archived one is then left out of the drawer:
/// dead agent shells are archived on purpose to keep it quiet. Filing mirrors
/// desktop `groupAttachedShellsByParentId`.
struct WorkAttachedShellFiling {
  var groupsByParentId: [String: WorkShellDrawer]
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
      WorkShellDrawer(
        children: ordered,
        collapsedSectionId: workSessionChildSectionId(parentId: parentId),
        status: workNestedStatusAndCount(ordered, chatSummaries: chatSummaries, now: now).status
      )
    )
  })
  return WorkAttachedShellFiling(groupsByParentId: groups, filedShellIds: filedShellIds)
}

/// Each root parent's one mark for the subagents the index files under it.
/// Mirrors desktop `nestedSubagentMark`.
func workNestedSubagentMarks(
  from index: WorkSpawnNestingIndex,
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> [String: WorkNestedSubagentMark] {
  var marks: [String: WorkNestedSubagentMark] = [:]
  for (parentId, children) in index.childrenByRootParentId where !children.isEmpty {
    let status = workNestedStatusAndCount(children, chatSummaries: chatSummaries, now: now)
    marks[parentId] = WorkNestedSubagentMark(
      count: children.count,
      status: status.status,
      statusCount: status.count
    )
  }
  return marks
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
  let status: WorkNestedStatus
  /// Children in `status`; 0 when `status` is `.none`.
  let statusCount: Int

  /// "2 subagents, 1 needs you". Mirrors desktop `nestedSubagentMarkLabel`.
  var accessibilityLabel: String {
    let base = count == 1 ? "1 subagent" : "\(count) subagents"
    guard statusCount > 0 else { return base }
    switch status {
    case .failed: return "\(base), \(statusCount) failed"
    case .needsYou: return "\(base), \(statusCount) \(statusCount == 1 ? "needs you" : "need you")"
    case .running: return "\(base), \(statusCount) running"
    case .none: return base
    }
  }
}

// MARK: - Child chats in the parent's Chat Info

/// What a chat's Chat Info reads about its child chats, handed down by the
/// Work root from the same rows the list holds. A row from another machine
/// carries that machine's namespaced lane id (`fleet|<machineKey>|<laneId>`),
/// so a child found here opens on its own machine. Holds only this chat's
/// children, so churn elsewhere in the list leaves it equal.
struct WorkChatChildRoster: Equatable {
  /// Every session the nesting index files under this chat (grandchildren
  /// included), in filing order. The Work list leaves them out, so Chat Info
  /// is where they are reached. Mirrors desktop `filedSubagentsOf`.
  var filed: [TerminalSessionSummary]
  /// The filed children plus every row on the chat's machine that names it as
  /// its parent (any lane, any spawn kind), for the rows the transcript names.
  var childrenById: [String: TerminalSessionSummary]
  var summaries: [String: AgentChatSessionSummary]

  static let empty = WorkChatChildRoster(filed: [], childrenById: [:], summaries: [:])
}

func workChatChildRoster(
  parentId: String,
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  now: Date
) -> WorkChatChildRoster {
  guard let parent = sessions.first(where: { $0.id == parentId }) else { return .empty }
  // The chat's machine only: its children live there, and an id on another
  // machine is a different session.
  let machineKey = workParseRemoteLaneId(parent.laneId)?.machineKey
  let machineSessions = sessions.filter { workParseRemoteLaneId($0.laneId)?.machineKey == machineKey }
  let filed = workIndexNestedSubagents(
    sessions: machineSessions,
    chatSummaries: chatSummaries,
    now: now,
    visibleParentIds: Set(machineSessions.map(\.id))
  ).childrenByRootParentId[parentId] ?? []
  var childrenById = Dictionary(filed.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
  for session in machineSessions where session.id != parentId && childrenById[session.id] == nil {
    let launchedBy = session.launchedBySessionId?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard workOrchestrationParentId(session, summary: chatSummaries[session.id]) == parentId
      || launchedBy == parentId
    else { continue }
    childrenById[session.id] = session
  }
  var summaries: [String: AgentChatSessionSummary] = [:]
  for id in childrenById.keys {
    if let summary = chatSummaries[id] { summaries[id] = summary }
  }
  return WorkChatChildRoster(filed: filed, childrenById: childrenById, summaries: summaries)
}

/// The child session id a Chat Info row's `taskId` names (`chat:<id>`), or nil
/// for a native in-thread subagent.
func workChatInfoChildSessionId(_ snapshot: WorkSubagentSnapshot) -> String? {
  let taskId = snapshot.taskId.trimmingCharacters(in: .whitespacesAndNewlines)
  guard taskId.hasPrefix("chat:") else { return nil }
  return workDroppingChatPrefix(taskId)
}

/// `raw` trimmed, with one leading `chat:` dropped; nil when nothing is left.
private func workDroppingChatPrefix(_ raw: String) -> String? {
  var id = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  if id.hasPrefix("chat:") {
    id = String(id.dropFirst("chat:".count)).trimmingCharacters(in: .whitespacesAndNewlines)
  }
  return id.isEmpty ? nil : id
}

/// The ids a Chat Info row may name a child chat by: its `taskId`, then its
/// `agentId`, each with a leading `chat:` dropped (desktop
/// `orphanRowChildSessionCandidate`).
private func workChatInfoRowCandidateIds(_ snapshot: WorkSubagentSnapshot) -> [String] {
  [snapshot.taskId, snapshot.agentId ?? ""].compactMap(workDroppingChatPrefix)
}

/// The child chat behind a Chat Info row, when the row names one of this
/// chat's children on its machine.
func workChatInfoRosterChildId(_ snapshot: WorkSubagentSnapshot, roster: WorkChatChildRoster) -> String? {
  workChatInfoRowCandidateIds(snapshot).first { roster.childrenById[$0] != nil }
}

/// The Chat Info status of a child chat with this canonical phase. Mirrors
/// desktop `childChatPaneStatus`.
func workChildChatInfoStatus(_ phase: CanonicalSessionPhase) -> WorkSubagentSnapshot.Status {
  switch phase {
  case .starting, .running, .stale, .needsYou: return .running
  case .failed: return .failed
  case .stopped: return .stopped
  case .ready, .idle, .ended, .settled: return .succeeded
  }
}

/// Chat Info's subagent list with the parent's child chats folded in.
///
/// The parent's transcript names each child it spawned. Two gaps remain, and
/// both are filled from the children's own Work rows: a filed child the
/// transcript has no row for (a grandchild, a peer turned subagent, a spawn
/// windowed out of the transcript) is appended in filing order, and any row
/// whose child chat waits on the user reads "Needs you", even after its spawn
/// result landed. `summary` returns the freshest summary the caller holds.
func workChatInfoSubagentsWithChildChats(
  _ snapshots: [WorkSubagentSnapshot],
  roster: WorkChatChildRoster,
  summary: (String) -> AgentChatSessionSummary?,
  now: Date = Date()
) -> [WorkSubagentSnapshot] {
  guard !roster.childrenById.isEmpty else { return snapshots }
  func phase(_ child: TerminalSessionSummary) -> CanonicalSessionPhase {
    workCanonicalSessionState(session: child, summary: summary(child.id), now: now).phase
  }
  var named: Set<String> = []
  var result = snapshots.map { snapshot -> WorkSubagentSnapshot in
    named.formUnion(workChatInfoRowCandidateIds(snapshot))
    guard let childId = workChatInfoRosterChildId(snapshot, roster: roster),
          let child = roster.childrenById[childId]
    else { return snapshot }
    var next = snapshot
    next.needsInput = phase(child) == .needsYou
    return next
  }
  for child in roster.filed where !named.contains(child.id) {
    let childSummary = summary(child.id)
    let childPhase = phase(child)
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
      status: workChildChatInfoStatus(childPhase),
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
