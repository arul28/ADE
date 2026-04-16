import Foundation

enum WorkSessionStatusFilter: String, CaseIterable, Identifiable {
  case all
  case needsInput
  case running
  case ended
  case archived

  var id: String { rawValue }

  var title: String {
    switch self {
    case .all: return "All"
    case .needsInput: return "Needs input"
    case .running: return "Live"
    case .ended: return "Ended"
    case .archived: return "Archived"
    }
  }
}

func compareWorkSessionSortOrder(
  _ lhs: TerminalSessionSummary,
  _ rhs: TerminalSessionSummary,
  chatSummaries: [String: AgentChatSessionSummary]
) -> Bool {
  let lhsSummary = chatSummaries[lhs.id]
  let rhsSummary = chatSummaries[rhs.id]
  let lhsRank = workSessionStatusSortRank(normalizedWorkChatSessionStatus(session: lhs, summary: lhsSummary))
  let rhsRank = workSessionStatusSortRank(normalizedWorkChatSessionStatus(session: rhs, summary: rhsSummary))
  if lhsRank != rhsRank {
    return lhsRank < rhsRank
  }

  let lhsActivity = workSessionActivityTimestamp(session: lhs, summary: lhsSummary)
  let rhsActivity = workSessionActivityTimestamp(session: rhs, summary: rhsSummary)
  if lhsActivity != rhsActivity {
    return lhsActivity > rhsActivity
  }

  let titleComparison = workSessionDisplayTitle(session: lhs, summary: lhsSummary)
    .localizedCaseInsensitiveCompare(workSessionDisplayTitle(session: rhs, summary: rhsSummary))
  if titleComparison != .orderedSame {
    return titleComparison == .orderedAscending
  }

  return lhs.id < rhs.id
}

func workFilteredSessions(
  _ sessions: [TerminalSessionSummary],
  chatSummaries: [String: AgentChatSessionSummary],
  archivedSessionIds: Set<String>,
  selectedStatus: WorkSessionStatusFilter,
  selectedLaneId: String,
  searchText: String
) -> [TerminalSessionSummary] {
  sessions
    .filter { session in
      let isArchived = archivedSessionIds.contains(session.id)
      let status = normalizedWorkChatSessionStatus(session: session, summary: chatSummaries[session.id])
      switch selectedStatus {
      case .all:
        break
      case .needsInput:
        guard !isArchived && status == "awaiting-input" else { return false }
      case .running:
        guard !isArchived && (status == "active" || status == "idle") else { return false }
      case .ended:
        guard !isArchived && status == "ended" else { return false }
      case .archived:
        guard isArchived else { return false }
      }

      if selectedLaneId != "all" && session.laneId != selectedLaneId {
        return false
      }

      return workSessionMatchesSearch(session: session, summary: chatSummaries[session.id], query: searchText)
    }
    .sorted { compareWorkSessionSortOrder($0, $1, chatSummaries: chatSummaries) }
}

func workSessionDisplayTitle(session: TerminalSessionSummary, summary: AgentChatSessionSummary?) -> String {
  summary?.title ?? session.title
}

func workSessionActivityTimestamp(session: TerminalSessionSummary, summary: AgentChatSessionSummary?) -> String {
  summary?.lastActivityAt ?? session.chatIdleSinceAt ?? session.startedAt
}

func workSessionRuntimeLabel(session: TerminalSessionSummary) -> String {
  let raw = session.toolType?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased() ?? ""
  guard !raw.isEmpty else {
    return isChatSession(session) ? "Chat" : "Terminal"
  }

  switch raw {
  case "run-shell", "shell", "terminal":
    return "Terminal"
  case "claude-chat":
    return "Claude"
  case "codex-chat":
    return "Codex"
  case "opencode-chat":
    return "OpenCode"
  case "cursor":
    return "Cursor"
  default:
    return raw
      .split(whereSeparator: { $0 == "-" || $0 == "_" || $0 == "/" })
      .map { token in
        let word = String(token)
        return word.prefix(1).uppercased() + word.dropFirst()
      }
      .joined(separator: " ")
  }
}

func workSessionEmptyStateTitle(status: WorkSessionStatusFilter, searchText: String, hasFilters: Bool) -> String {
  if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    return "No sessions match"
  }
  if hasFilters {
    return status == .archived ? "No archived sessions match" : "No sessions match the current filters"
  }
  switch status {
  case .archived:
    return "No archived sessions"
  default:
    return "No work sessions yet"
  }
}

func workSessionEmptyStateMessage(status: WorkSessionStatusFilter, searchText: String, hasFilters: Bool, isLive: Bool) -> String {
  if !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
    return "Try a different search or clear the current filters."
  }
  if hasFilters {
    return "Change the lane or state filters to widen the Work list."
  }
  switch status {
  case .archived:
    return "Archived sessions stay here until you restore them."
  default:
    return isLive
      ? "Start a new chat, then filter by lane or status as activity comes in."
      : "Cached sessions stay visible here. Reconnect to create chats or refresh live agent work."
  }
}

private func workSessionMatchesSearch(
  session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?,
  query: String
) -> Bool {
  let tokens = query
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
    .split(whereSeparator: \.isWhitespace)
    .map(String.init)
  guard !tokens.isEmpty else { return true }
  let indexed = workSessionSearchIndex(session: session, summary: summary)
  return tokens.allSatisfy(indexed.contains)
}

private func workSessionSearchIndex(session: TerminalSessionSummary, summary: AgentChatSessionSummary?) -> String {
  let status = normalizedWorkChatSessionStatus(session: session, summary: summary)
  let statusTokens = status.replacingOccurrences(of: "-", with: " ")
  var fields: [String] = []
  fields.append(workSessionDisplayTitle(session: session, summary: summary))
  fields.append(session.goal ?? "")
  fields.append(summary?.goal ?? "")
  fields.append(session.laneName)
  fields.append(session.toolType ?? "")
  fields.append(workSessionRuntimeLabel(session: session))
  fields.append(session.lastOutputPreview ?? "")
  fields.append(session.summary ?? "")
  fields.append(summary?.lastOutputPreview ?? "")
  fields.append(summary?.summary ?? "")
  fields.append(summary?.provider ?? "")
  fields.append(summary?.model ?? "")
  fields.append(statusTokens)
  fields.append(session.pinned ? "pinned" : "")
  return fields.joined(separator: " ").lowercased()
}

private func workSessionStatusSortRank(_ status: String) -> Int {
  switch status {
  case "awaiting-input": return 0
  case "active": return 1
  case "idle": return 2
  default: return 3
  }
}
