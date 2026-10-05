import Foundation

// Lane focus for the Work list: one status per lane, and the "Fold busy lanes"
// rule that files a lane under the Working shelf while nothing in it is waiting
// on the user. Same rules as desktop
// `apps/desktop/src/renderer/components/terminals/workLaneFocus.ts`. Two inputs
// differ only in where they come from: a row is seen once the user has left it
// (`WorkSeenStore`, stamped by the screen), and a launch with no session
// row yet is already a row here, because iOS merges launches into the roster.

/// A lane's rolled-up status, in the desktop board's column vocabulary and
/// priority order: Needs you > Working > Waiting > Done.
enum WorkLaneFocusStatus: Int, Comparable, Hashable {
  case needsYou = 0
  case working
  case waiting
  case done

  static func < (lhs: WorkLaneFocusStatus, rhs: WorkLaneFocusStatus) -> Bool {
    lhs.rawValue < rhs.rawValue
  }

  /// The board column word and accent, read from the status chips so the lane
  /// dot and the chips can never name or colour the same state differently.
  var statusFilter: WorkSessionStatusFilter {
    switch self {
    case .needsYou: return .needsYou
    case .working: return .working
    case .waiting: return .waiting
    case .done: return .done
    }
  }
}

struct WorkRowFocus: Equatable {
  let status: WorkLaneFocusStatus
  /// True when this row alone keeps its lane out of the Working shelf.
  let holdsOut: Bool
}

/// Has the user left this row since it last finished?
func workIsRowSeen(session: TerminalSessionSummary, seenAt: Date?) -> Bool {
  guard let seenAt else { return false }
  var finished = workParsedDate(session.startedAt) ?? .distantPast
  for value in [session.lastActivityAt, session.endedAt, session.activityStatusChangedAt] {
    if let parsed = value.flatMap(workParsedDate), parsed > finished { finished = parsed }
  }
  return seenAt >= finished
}

/// One row's place in its lane's focus, or nil for a snoozed, settled or
/// archived row (those have their own shelves).
func workRowFocus(
  session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?,
  archived: Bool,
  laneWaiting: Bool,
  seen: Bool,
  now: Date
) -> WorkRowFocus? {
  if archived { return nil }
  if session.isFiledAsSnoozed(summary: summary, now: now) { return nil }
  let phase = workCanonicalSessionState(session: session, summary: summary, now: now).phase
  switch phase {
  case .needsYou:
    return WorkRowFocus(status: .needsYou, holdsOut: true)
  case .starting, .running:
    return WorkRowFocus(status: laneWaiting ? .waiting : .working, holdsOut: false)
  case .stale:
    // Still filed as running, but it may be stuck: never hide it.
    return WorkRowFocus(status: .working, holdsOut: true)
  case .settled:
    return nil
  case .ready, .idle, .failed, .stopped, .ended:
    return WorkRowFocus(status: .done, holdsOut: !seen)
  }
}

func workRollUpLaneFocus(_ rows: [WorkRowFocus?]) -> WorkLaneFocusStatus? {
  rows.compactMap { $0?.status }.min()
}

/// Every live row busy or already-seen Done, and at least one actually busy.
func workLaneFoldsIntoWorking(_ rows: [WorkRowFocus?]) -> Bool {
  var busy = 0
  for row in rows {
    guard let row else { continue }
    if row.holdsOut { return false }
    if row.status == .working || row.status == .waiting { busy += 1 }
  }
  return busy > 0
}

/// Lanes that came back out of the Working shelf, and when this phone saw it.
/// The first observation only records a baseline, so opening the list never
/// reshuffles it.
struct WorkLaneReturnState: Equatable {
  var folded: Set<String> = []
  var returnedAt: [String: Date] = [:]
  var initialized = false

  static let empty = WorkLaneReturnState()
}

func workNextLaneReturnState(
  _ previous: WorkLaneReturnState,
  foldedNow: Set<String>,
  presentLaneIds: Set<String>,
  now: Date
) -> WorkLaneReturnState {
  guard previous.initialized else {
    return WorkLaneReturnState(folded: foldedNow, returnedAt: [:], initialized: true)
  }
  var next = previous
  for laneId in previous.folded where !foldedNow.contains(laneId) && presentLaneIds.contains(laneId) {
    next.returnedAt[laneId] = now
  }
  for laneId in foldedNow { next.returnedAt.removeValue(forKey: laneId) }
  next.returnedAt = next.returnedAt.filter { presentLaneIds.contains($0.key) }
  next.folded = foldedNow
  return next
}

/// Float returned lanes to the front of the floatable run, newest first; every
/// other item keeps its order. Pins and the primary lane are never floatable.
func workFloatReturnedLanes<Item>(
  _ ordered: [Item],
  laneId: (Item) -> String?,
  returnedAt: [String: Date],
  canFloat: (Item) -> Bool
) -> [Item] {
  guard !returnedAt.isEmpty else { return ordered }
  func returnTime(_ item: Item) -> Date? { laneId(item).flatMap { returnedAt[$0] } }
  let returnedIndices = ordered.indices
    .filter { canFloat(ordered[$0]) && returnTime(ordered[$0]) != nil }
    .sorted { (returnTime(ordered[$0]) ?? .distantPast) > (returnTime(ordered[$1]) ?? .distantPast) }
  guard !returnedIndices.isEmpty else { return ordered }
  let returnedSet = Set(returnedIndices)
  var rest = ordered.indices.filter { !returnedSet.contains($0) }.map { ordered[$0] }
  let insertAt = rest.firstIndex(where: canFloat) ?? rest.count
  rest.insert(contentsOf: returnedIndices.map { ordered[$0] }, at: insertAt)
  return rest
}

/// When the user last left each session, keyed by session id. Session ids are
/// globally unique, so one store serves every project. Bounded to the newest
/// `limit` entries.
enum WorkSeenStore {
  static let key = "ade.work.seenAtBySessionId.v1"
  static let limit = 400

  static func load(_ defaults: UserDefaults = .standard) -> [String: Date] {
    guard let raw = defaults.dictionary(forKey: key) as? [String: Double] else { return [:] }
    return raw.mapValues { Date(timeIntervalSince1970: $0) }
  }

  static func stamp(_ sessionIds: [String], at date: Date = Date(), defaults: UserDefaults = .standard) {
    guard !sessionIds.isEmpty else { return }
    var raw = (defaults.dictionary(forKey: key) as? [String: Double]) ?? [:]
    for id in sessionIds where !id.isEmpty { raw[id] = date.timeIntervalSince1970 }
    if raw.count > limit {
      raw = Dictionary(uniqueKeysWithValues: raw.sorted { $0.value > $1.value }.prefix(limit).map { ($0.key, $0.value) })
    }
    defaults.set(raw, forKey: key)
  }
}
