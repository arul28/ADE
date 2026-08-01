import Foundation

/// Lane ordering and the singleton/headerless rule for the Work session list.
///
/// The iOS port of `apps/desktop/src/renderer/components/terminals/workLaneOrder.ts`
/// plus the `headerlessLaneIds` memo in `SessionListPane.tsx`. Both are pure —
/// callers derive `quiet` / `pinned` / activity and hand over plain data — so the
/// rules are unit-testable without mounting a list, exactly as on desktop.
///
/// iOS has no manual lane drag and no per-lane handoff jobs today, so those two
/// inputs are always at their defaults here. They are modelled anyway: they are
/// the two rules that decide whether a lane KEEPS its header, and leaving them
/// out is how a port silently loses a rule the moment the surface catches up.

// MARK: - Sort mode

/// Mirrors the desktop `WorkLaneSortMode`. iOS exposes no sort-mode picker yet,
/// so every call site passes `.created` — the mode desktop also falls back to.
enum WorkLaneSortMode: String, CaseIterable {
  case activity
  case name
  case created
  case manual
}

func normalizeWorkLaneSortMode(_ value: String?) -> WorkLaneSortMode {
  WorkLaneSortMode(rawValue: value?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "")
    ?? .created
}

// MARK: - Filing tier

/// Pins outrank quietness: a pinned lane stays up top even when every one of its
/// sessions has settled.
enum WorkLaneTier: Int {
  case pinned = 0
  case active = 1
  case quiet = 2
}

func workLaneTier(pinned: Bool, quiet: Bool) -> WorkLaneTier {
  if pinned { return .pinned }
  return quiet ? .quiet : .active
}

/// One lane's ordering inputs. `lastActivityAt` is the most recent session
/// activity in the lane, nil when the lane has none.
struct WorkLaneOrderInput: Equatable {
  let id: String
  let name: String
  let laneType: String
  let createdAt: String
  let lastActivityAt: Date?
  /// Every session in the lane is settled, snoozed, or archived.
  let quiet: Bool
  let pinned: Bool

  init(
    id: String,
    name: String,
    laneType: String,
    createdAt: String,
    lastActivityAt: Date? = nil,
    quiet: Bool = false,
    pinned: Bool = false
  ) {
    self.id = id
    self.name = name
    self.laneType = laneType
    self.createdAt = createdAt
    self.lastActivityAt = lastActivityAt
    self.quiet = quiet
    self.pinned = pinned
  }

  var tier: WorkLaneTier { workLaneTier(pinned: pinned, quiet: quiet) }
}

/// Descending compare that always sorts nil last, in either direction.
private func compareDescNilsLast(_ a: Date?, _ b: Date?) -> Int {
  if a == b { return 0 }
  guard let a else { return 1 }
  guard let b else { return -1 }
  if a == b { return 0 }
  return a > b ? -1 : 1
}

private func compareByMode(
  _ a: WorkLaneOrderInput,
  _ b: WorkLaneOrderInput,
  mode: WorkLaneSortMode,
  manualIndex: [String: Int]
) -> Int {
  switch mode {
  case .activity:
    return compareDescNilsLast(a.lastActivityAt, b.lastActivityAt)
  case .name:
    let result = a.name.compare(
      b.name,
      options: [.caseInsensitive, .numeric, .diacriticInsensitive]
    )
    return result == .orderedSame ? 0 : (result == .orderedAscending ? -1 : 1)
  case .manual:
    // A lane with no recorded position sorts after every placed lane, in the
    // fallback order below, so a newly created lane appears predictably rather
    // than jumping to an arbitrary slot.
    let ai = manualIndex[a.id] ?? Int.max
    let bi = manualIndex[b.id] ?? Int.max
    return ai == bi ? 0 : (ai < bi ? -1 : 1)
  case .created:
    return compareDescNilsLast(
      workLaneOrderParsedDate(a.createdAt),
      workLaneOrderParsedDate(b.createdAt)
    )
  }
}

/// Full ordering key, in priority order:
///
///   1. the primary lane, always first — in every mode
///   2. tier: pinned → active → quiet
///   3. the active sort mode
///   4. createdAt desc, then id — a total, stable tiebreak
///
/// Step 4 exists so the comparator is total: without it, two lanes that tie on
/// the mode key can swap places between renders and the list visibly jitters.
func compareWorkLanes(
  _ a: WorkLaneOrderInput,
  _ b: WorkLaneOrderInput,
  mode: WorkLaneSortMode = .created,
  manualIndex: [String: Int] = [:]
) -> Int {
  let aPrimary = a.laneType == "primary" ? 0 : 1
  let bPrimary = b.laneType == "primary" ? 0 : 1
  if aPrimary != bPrimary { return aPrimary - bPrimary }

  let tierDelta = a.tier.rawValue - b.tier.rawValue
  if tierDelta != 0 { return tierDelta }

  let modeDelta = compareByMode(a, b, mode: mode, manualIndex: manualIndex)
  if modeDelta != 0 { return modeDelta }

  let createdDelta = compareDescNilsLast(
    workLaneOrderParsedDate(a.createdAt),
    workLaneOrderParsedDate(b.createdAt)
  )
  if createdDelta != 0 { return createdDelta }

  let idResult = a.id.compare(b.id)
  return idResult == .orderedSame ? 0 : (idResult == .orderedAscending ? -1 : 1)
}

/// Order lanes by the full key. `inputs` supplies the derived quiet/pinned/
/// activity facts a `LaneSummary` does not carry; a lane with no entry is
/// treated as active and unpinned.
func orderWorkLanes(
  _ lanes: [LaneSummary],
  inputs: [String: WorkLaneOrderInput],
  mode: WorkLaneSortMode = .created,
  manualOrder: [String] = []
) -> [LaneSummary] {
  var manualIndex: [String: Int] = [:]
  for (index, id) in manualOrder.enumerated() where manualIndex[id] == nil {
    manualIndex[id] = index
  }
  return lanes.enumerated().sorted { lhs, rhs in
    let a = inputs[lhs.element.id] ?? WorkLaneOrderInput(lane: lhs.element)
    let b = inputs[rhs.element.id] ?? WorkLaneOrderInput(lane: rhs.element)
    let delta = compareWorkLanes(a, b, mode: mode, manualIndex: manualIndex)
    // Enumeration offset keeps the sort stable for genuinely equal lanes, which
    // the total comparator above only leaves for duplicate ids.
    return delta == 0 ? lhs.offset < rhs.offset : delta < 0
  }.map(\.element)
}

extension WorkLaneOrderInput {
  init(lane: LaneSummary, lastActivityAt: Date? = nil, quiet: Bool = false, pinned: Bool = false) {
    self.init(
      id: lane.id,
      name: lane.name,
      laneType: lane.laneType,
      createdAt: lane.createdAt,
      lastActivityAt: lastActivityAt,
      quiet: quiet,
      pinned: pinned
    )
  }
}

// MARK: - Headerless (singleton) lanes

/// One lane's inputs to the singleton rule.
struct WorkHeaderlessLaneInput: Equatable {
  let laneId: String
  /// TOP-LEVEL rows only, from the UNFILTERED roster. A chat with terminal
  /// children is one unit and must not summon a header; reading the unfiltered
  /// roster is what stops the list reshaping while the user types in search.
  let topLevelSessionCount: Int
  /// A pin is an explicit "keep this where I can see it" — the pin glyph lives
  /// on the header, so a pinned lane keeps it.
  let pinned: Bool
  /// A pending handoff placeholder counts as a second row, so a lane does not
  /// lose its header for the second it takes the real session to land. Always
  /// false today: iOS has no handoff-job records.
  let hasPendingHandoff: Bool
  /// A lane whose machine is unreachable keeps its header: the header is the
  /// only thing that can carry the dimmed, folded-shut group treatment, and
  /// "that machine is gone" is precisely when its work should stop occupying a
  /// prime row.
  let machineOnline: Bool

  init(
    laneId: String,
    topLevelSessionCount: Int,
    pinned: Bool = false,
    hasPendingHandoff: Bool = false,
    machineOnline: Bool = true
  ) {
    self.laneId = laneId
    self.topLevelSessionCount = topLevelSessionCount
    self.pinned = pinned
    self.hasPendingHandoff = hasPendingHandoff
    self.machineOnline = machineOnline
  }
}

/// Lanes that render their group WITHOUT a header — the singleton form.
///
/// One chat per lane is the common workflow, and it used to produce
/// header/card/header/card with the lane name usually duplicating the chat
/// title. The lone card carries the lane identity instead
/// (`WorkSessionGroup.isHeaderless` → `showsLaneIdentity` on the row).
///
/// Manual sort opts out entirely: a singleton has no header to grab.
func workHeaderlessLaneIds(
  _ lanes: [WorkHeaderlessLaneInput],
  sortMode: WorkLaneSortMode = .created
) -> Set<String> {
  guard sortMode != .manual else { return [] }
  var ids: Set<String> = []
  for lane in lanes {
    if lane.pinned { continue }
    if lane.hasPendingHandoff { continue }
    if !lane.machineOnline { continue }
    if lane.topLevelSessionCount == 1 { ids.insert(lane.laneId) }
  }
  return ids
}

// MARK: - Shared date parsing

private let workLaneOrderISO8601: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return formatter
}()

private let workLaneOrderISO8601NoFractional: ISO8601DateFormatter = {
  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime]
  return formatter
}()

func workLaneOrderParsedDate(_ value: String?) -> Date? {
  guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
    return nil
  }
  return workLaneOrderISO8601.date(from: trimmed) ?? workLaneOrderISO8601NoFractional.date(from: trimmed)
}
