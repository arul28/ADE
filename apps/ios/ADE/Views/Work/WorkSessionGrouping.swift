import Foundation
import SwiftUI

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

  enum Icon: Equatable {
    case statusDot
    case laneBranch
    case none
  }

  static func == (lhs: WorkSessionGroup, rhs: WorkSessionGroup) -> Bool {
    lhs.id == rhs.id
      && lhs.label == rhs.label
      && lhs.icon == rhs.icon
      && lhs.tint == rhs.tint
      && lhs.sessions.map(\.id) == rhs.sessions.map(\.id)
  }
}

/// Group session list by the user's chosen organization. Empty groups are filtered out.
func workSessionGroups(
  organization: WorkSessionOrganization,
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  archivedSessionIds: Set<String>,
  orderedLanes: [LaneSummary]
) -> [WorkSessionGroup] {
  switch organization {
  case .byStatus:
    return workSessionGroupsByStatus(
      sessions: sessions,
      chatSummaries: chatSummaries,
      archivedSessionIds: archivedSessionIds
    )
  case .byLane:
    return workSessionGroupsByLane(
      sessions: sessions,
      orderedLanes: orderedLanes
    )
  case .byTime:
    return workSessionGroupsByTime(sessions: sessions)
  }
}

func workSessionGroupsByStatus(
  sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  archivedSessionIds: Set<String>
) -> [WorkSessionGroup] {
  var needsInput: [TerminalSessionSummary] = []
  var pinned: [TerminalSessionSummary] = []
  var running: [TerminalSessionSummary] = []
  var ended: [TerminalSessionSummary] = []
  var archived: [TerminalSessionSummary] = []

  for session in sessions {
    if archivedSessionIds.contains(session.id) {
      archived.append(session)
      continue
    }
    let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
    if status == "awaiting-input" {
      needsInput.append(session)
    } else if session.pinned {
      pinned.append(session)
    } else if status == "active" || status == "idle" {
      running.append(session)
    } else {
      ended.append(session)
    }
  }

  var groups: [WorkSessionGroup] = []
  if !needsInput.isEmpty {
    groups.append(WorkSessionGroup(id: "status:awaiting", label: "Needs input", icon: .statusDot, tint: ADEColor.warning, sessions: needsInput))
  }
  if !pinned.isEmpty {
    groups.append(WorkSessionGroup(id: "status:pinned", label: "Pinned", icon: .statusDot, tint: ADEColor.accent, sessions: pinned))
  }
  if !running.isEmpty {
    groups.append(WorkSessionGroup(id: "status:running", label: "Running", icon: .statusDot, tint: ADEColor.success, sessions: running))
  }
  if !ended.isEmpty {
    groups.append(WorkSessionGroup(id: "status:ended", label: "Ended", icon: .statusDot, tint: ADEColor.textMuted, sessions: ended))
  }
  if !archived.isEmpty {
    groups.append(WorkSessionGroup(id: "status:archived", label: "Archived", icon: .statusDot, tint: ADEColor.warning, sessions: archived))
  }
  return groups
}

func workSessionGroupsByLane(
  sessions: [TerminalSessionSummary],
  orderedLanes: [LaneSummary]
) -> [WorkSessionGroup] {
  var byLaneId: [String: [TerminalSessionSummary]] = [:]
  for session in sessions {
    byLaneId[session.laneId, default: []].append(session)
  }

  var groups: [WorkSessionGroup] = []
  let knownLaneIds = Set(orderedLanes.map(\.id))
  for lane in orderedLanes {
    guard let list = byLaneId[lane.id], !list.isEmpty else { continue }
    groups.append(WorkSessionGroup(id: "lane:\(lane.id)", label: lane.name, icon: .laneBranch, tint: ADEColor.textSecondary, sessions: list))
  }
  // Surface any sessions whose lane isn't in the ordered list (e.g., soft-deleted lanes)
  // as their own per-lane groups so users still recognize which branch each belongs to.
  let iso = ISO8601DateFormatter()
  iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let isoFallback = ISO8601DateFormatter()
  isoFallback.formatOptions = [.withInternetDateTime]
  func latestStartedAt(_ list: [TerminalSessionSummary]) -> Date {
    list.reduce(.distantPast) { acc, session in
      let parsed = iso.date(from: session.startedAt) ?? isoFallback.date(from: session.startedAt) ?? .distantPast
      return parsed > acc ? parsed : acc
    }
  }
  let orphanEntries = byLaneId
    .filter { laneId, list in !knownLaneIds.contains(laneId) && !list.isEmpty }
    .sorted { left, right in
      let leftLatest = latestStartedAt(left.value)
      let rightLatest = latestStartedAt(right.value)
      if leftLatest != rightLatest { return leftLatest > rightLatest }
      let leftName = left.value.first?.laneName ?? left.key
      let rightName = right.value.first?.laneName ?? right.key
      return leftName.localizedCaseInsensitiveCompare(rightName) == .orderedAscending
    }
  for (laneId, list) in orphanEntries {
    let label = list.first?.laneName ?? laneId
    groups.append(WorkSessionGroup(id: "lane:\(laneId)", label: label, icon: .laneBranch, tint: ADEColor.textMuted, sessions: list))
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

  let formatter = ISO8601DateFormatter()
  formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  let fallbackFormatter = ISO8601DateFormatter()
  fallbackFormatter.formatOptions = [.withInternetDateTime]

  for session in sessions {
    let parsed = formatter.date(from: session.startedAt) ?? fallbackFormatter.date(from: session.startedAt)
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

/// Persistence helper for the comma-separated collapsed-section-ids string stored in AppStorage.
func workParseCollapsedSectionIds(_ raw: String) -> Set<String> {
  Set(raw.split(separator: ",").map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty })
}

func workSerializeCollapsedSectionIds(_ ids: Set<String>) -> String {
  ids.sorted().joined(separator: ",")
}
