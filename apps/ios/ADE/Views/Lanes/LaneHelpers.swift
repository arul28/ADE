import SwiftUI

// MARK: - Utility functions

@ViewBuilder
func lanePriorityBadge(snapshot: LaneListSnapshot) -> some View {
  if snapshot.autoRebaseStatus?.state == "rebaseConflict" {
    LaneTypeBadge(text: "Conflict", tint: ADEColor.danger)
  } else if snapshot.lane.status.dirty {
    LaneTypeBadge(text: "Dirty", tint: ADEColor.warning)
  } else if snapshot.runtime.bucket == "running" {
    LaneTypeBadge(text: "Running", tint: ADEColor.success)
  } else if snapshot.runtime.bucket == "awaiting-input" {
    LaneTypeBadge(text: "Attention", tint: ADEColor.warning)
  } else if snapshot.lane.archivedAt != nil {
    LaneTypeBadge(text: "Archived", tint: ADEColor.textMuted)
  } else if let rebaseSuggestion = snapshot.rebaseSuggestion {
    LaneTypeBadge(text: "\(rebaseSuggestion.behindCount)\u{2193}", tint: ADEColor.warning)
  } else {
    EmptyView()
  }
}

func laneActivitySummary(_ snapshot: LaneListSnapshot) -> String? {
  if let agentText = summarizeState(snapshot.stateSnapshot?.agentSummary) {
    return agentText
  }
  if let missionText = summarizeState(snapshot.stateSnapshot?.missionSummary) {
    return missionText
  }
  return nil
}

func laneListFilteredSnapshots(
  _ snapshots: [LaneListSnapshot],
  scope: LaneListScope,
  runtimeFilter: LaneRuntimeFilter,
  searchText: String,
  pinnedLaneIds: Set<String>
) -> [LaneListSnapshot] {
  snapshots
    .filter { snapshot in
      switch scope {
      case .active:
        return snapshot.lane.archivedAt == nil
      case .archived:
        return snapshot.lane.archivedAt != nil
      case .all:
        return true
      }
    }
    .filter { snapshot in
      runtimeFilter == .all || snapshot.runtime.bucket == runtimeFilter.rawValue
    }
    .filter { snapshot in
      laneMatchesSearch(snapshot: snapshot, isPinned: pinnedLaneIds.contains(snapshot.lane.id), query: searchText)
    }
    .sorted(by: laneListSortSnapshots)
}

func laneListSortSnapshots(_ lhs: LaneListSnapshot, _ rhs: LaneListSnapshot) -> Bool {
  if lhs.lane.laneType == "primary" && rhs.lane.laneType != "primary" { return true }
  if lhs.lane.laneType != "primary" && rhs.lane.laneType == "primary" { return false }
  if lhs.lane.createdAt != rhs.lane.createdAt {
    return lhs.lane.createdAt > rhs.lane.createdAt
  }
  return lhs.lane.name.localizedCaseInsensitiveCompare(rhs.lane.name) == .orderedAscending
}

func laneScopeCount(_ snapshots: [LaneListSnapshot], scope: LaneListScope) -> Int {
  snapshots.filter { snapshot in
    switch scope {
    case .active:
      return snapshot.lane.archivedAt == nil
    case .archived:
      return snapshot.lane.archivedAt != nil
    case .all:
      return true
    }
  }.count
}

func laneRuntimeCount(_ snapshots: [LaneListSnapshot], filter: LaneRuntimeFilter) -> Int {
  if filter == .all {
    return snapshots.count
  }
  return snapshots.filter { $0.runtime.bucket == filter.rawValue }.count
}

func laneListEmptyStateTitle(scope: LaneListScope) -> String {
  switch scope {
  case .active: return "No active lanes"
  case .archived: return "No archived lanes"
  case .all: return "No lanes"
  }
}

func laneListEmptyStateMessage(scope: LaneListScope, searchText: String, hasFilters: Bool) -> String {
  if !searchText.isEmpty {
    return "Try a different search or clear the filter."
  }
  if hasFilters {
    return "Try clearing the current filters."
  }
  switch scope {
  case .active: return "Create a new lane or connect to a host."
  case .archived: return "Archived lanes will appear here."
  case .all: return "No lanes yet. Create a lane or connect to a host."
  }
}

func laneMatchesSearch(snapshot: LaneListSnapshot, isPinned: Bool, query: String) -> Bool {
  let tokens = query
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
    .split(whereSeparator: \.isWhitespace)
    .map(String.init)
  guard !tokens.isEmpty else { return true }
  return tokens.allSatisfy { token in
    matchesLaneToken(snapshot: snapshot, isPinned: isPinned, token: token)
  }
}

func matchesLaneToken(snapshot: LaneListSnapshot, isPinned: Bool, token: String) -> Bool {
  if token.hasPrefix("is:") {
    switch String(token.dropFirst(3)) {
    case "dirty": return snapshot.lane.status.dirty
    case "clean": return !snapshot.lane.status.dirty
    case "pinned": return isPinned
    case "primary": return snapshot.lane.laneType == "primary"
    case "worktree": return snapshot.lane.laneType == "worktree"
    case "attached": return snapshot.lane.laneType == "attached"
    default: return false
    }
  }
  if token.hasPrefix("type:") {
    return snapshot.lane.laneType.lowercased() == String(token.dropFirst(5))
  }
  let indexed = [
    snapshot.lane.name,
    snapshot.lane.branchRef,
    snapshot.lane.baseRef,
    snapshot.lane.laneType,
    snapshot.lane.description ?? "",
    snapshot.lane.worktreePath,
    snapshot.lane.archivedAt == nil ? "active" : "archived",
    snapshot.lane.status.dirty ? "dirty modified changed" : "clean",
    "ahead \(snapshot.lane.status.ahead)",
    "behind \(snapshot.lane.status.behind)",
    "\(snapshot.lane.status.ahead)",
    "\(snapshot.lane.status.behind)",
    snapshot.runtime.bucket,
    "\(snapshot.runtime.sessionCount)",
    summarizeState(snapshot.stateSnapshot?.agentSummary) ?? "",
    summarizeState(snapshot.stateSnapshot?.missionSummary) ?? "",
    isPinned ? "pinned" : "",
  ].joined(separator: " ").lowercased()
  return indexed.contains(token)
}

func summarizeState(_ summary: [String: RemoteJSONValue]?) -> String? {
  guard let summary else { return nil }
  let preferredKeys = [
    "summary", "status", "state", "label", "title", "objective",
    "stepLabel", "step", "name", "agent", "agentName", "assignee",
  ]
  for key in preferredKeys {
    if let value = flattenedString(summary[key]) {
      return value
    }
  }
  for key in summary.keys.sorted() {
    if let flattened = flattenedString(summary[key]) {
      return flattened
    }
  }
  return nil
}

func flattenedString(_ value: RemoteJSONValue?) -> String? {
  guard let value else { return nil }
  switch value {
  case .string(let string):
    return string
  case .number(let number):
    return String(number)
  case .bool(let bool):
    return bool ? "true" : "false"
  case .array(let values):
    return values.compactMap(flattenedString).first
  case .object(let object):
    return summarizeState(object)
  case .null:
    return nil
  }
}

func runtimeTint(bucket: String) -> Color {
  switch bucket {
  case "running":
    return ADEColor.success
  case "awaiting-input":
    return ADEColor.warning
  case "ended":
    return ADEColor.textMuted
  default:
    return ADEColor.textSecondary
  }
}

func lanePullRequestTint(_ state: String) -> Color {
  switch state {
  case "open":
    return ADEColor.success
  case "draft":
    return ADEColor.warning
  case "closed":
    return ADEColor.danger
  case "merged":
    return ADEColor.accent
  default:
    return ADEColor.textSecondary
  }
}

func runtimeSymbol(_ bucket: String) -> String {
  switch bucket {
  case "running":
    return "waveform.path.ecg"
  case "awaiting-input":
    return "exclamationmark.bubble"
  case "ended":
    return "stop.circle"
  default:
    return "circle"
  }
}

private let cachedISO8601Formatter: ISO8601DateFormatter = {
  let f = ISO8601DateFormatter()
  f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  return f
}()

private let cachedRelativeDateFormatter: RelativeDateTimeFormatter = {
  let f = RelativeDateTimeFormatter()
  f.unitsStyle = .abbreviated
  return f
}()

func relativeTimestamp(_ timestamp: String?) -> String {
  guard let timestamp else { return "Unknown" }
  guard let date = cachedISO8601Formatter.date(from: timestamp)
          ?? ISO8601DateFormatter().date(from: timestamp) else {
    return "Unknown"
  }
  return cachedRelativeDateFormatter.localizedString(for: date, relativeTo: Date())
}

func syncSummary(_ status: GitUpstreamSyncStatus) -> String {
  if !status.hasUpstream {
    return "No upstream. Publish to create a remote branch."
  }
  if status.diverged {
    return "Diverged. Rebase or pull before pushing."
  }
  if status.ahead > 0 && status.behind == 0 {
    return "Ahead by \(status.ahead). Push to publish."
  }
  if status.behind > 0 && status.ahead == 0 {
    return "Behind by \(status.behind). Pull to catch up."
  }
  return "In sync with remote."
}

func conflictSummary(_ status: ConflictStatus) -> String {
  switch status.status {
  case "conflict-active":
    return "\(status.overlappingFileCount) overlapping file(s) in active conflict."
  case "conflict-predicted":
    return "\(status.overlappingFileCount) overlapping file(s) predicted across \(status.peerConflictCount) peer(s)."
  case "behind-base":
    return "Behind base. Rebase before merging."
  case "merge-ready":
    return "Conflict prediction clear. Merge-ready."
  default:
    return "Conflict status available from host."
  }
}
