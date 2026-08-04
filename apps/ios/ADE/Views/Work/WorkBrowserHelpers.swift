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
  searchText: String,
  outputSearchBySessionId: [String: String] = [:]
) -> [TerminalSessionSummary] {
  let chatSessionIds = Set(sessions.filter(isChatSession).map(\.id))
  return sessions
    .filter { workSessionShouldAppearInWorkList($0, parentChatSessionIds: chatSessionIds) }
    .filter { session in
      let isArchived = archivedSessionIds.contains(session.id)
      // Filter with the same canonical lifecycle vocabulary the status
      // grouping uses, so a filter can never admit sessions its sections
      // don't claim (e.g. a settled chat leaking through "Live" via the old
      // idle status). Settled rows appear only under the All filter.
      let phase = workCanonicalSessionState(
        session: session,
        summary: chatSummaries[session.id]
      ).phase
      switch selectedStatus {
      case .all:
        guard !isArchived else { return false }
      case .needsInput:
        guard !isArchived, phase == .needsYou || phase == .ready || phase == .idle else { return false }
      case .running:
        guard !isArchived, phase == .starting || phase == .running || phase == .stale else { return false }
      case .ended:
        guard !isArchived, phase == .failed || phase == .stopped || phase == .ended else { return false }
      case .archived:
        guard isArchived else { return false }
      }

      if selectedLaneId != "all" && session.laneId != selectedLaneId {
        return false
      }

      return workSessionMatchesSearch(
        session: session,
        summary: chatSummaries[session.id],
        query: searchText,
        outputSearchText: outputSearchBySessionId[session.id]
      )
    }
    .sorted { compareWorkSessionSortOrder($0, $1, chatSummaries: chatSummaries) }
}

func workSessionShouldAppearInWorkList(
  _ session: TerminalSessionSummary,
  parentChatSessionIds: Set<String>
) -> Bool {
  if isChatSession(session) { return true }

  let parentId = session.chatSessionId?
    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
  if !parentId.isEmpty, parentId != session.id {
    // Chat-owned PTY row: it rides its parent chat's entry. An orphaned child
    // (parent chat not listed) only surfaces while it is actually live.
    if parentChatSessionIds.contains(parentId) { return true }
    if let ptyId = session.ptyId?.trimmingCharacters(in: .whitespacesAndNewlines),
       !ptyId.isEmpty {
      return true
    }
    let status = session.status.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let runtimeState = session.runtimeState.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    return status == "running"
      || status == "idle"
      || runtimeState == "running"
      || runtimeState == "idle"
      || runtimeState == "waiting-input"
  }

  // Standalone CLI session: always a real entry — ended sessions stay listed
  // (and resumable) exactly like they do on desktop.
  return true
}

func workFilesWorkspace(for laneId: String, in workspaces: [FilesWorkspace]) -> FilesWorkspace? {
  workspaces.first { $0.laneId == laneId }
}

func resolvedWorkNavigationLaneId(for session: TerminalSessionSummary, lanes: [LaneSummary]) -> String {
  if lanes.contains(where: { $0.id == session.laneId }) {
    return session.laneId
  }

  let sessionLaneName = normalizedWorkLaneLookupValue(session.laneName)
  if sessionLaneName == "primary",
    let primaryLane = lanes.first(where: { normalizedWorkLaneLookupValue($0.laneType) == "primary" })
  {
    return primaryLane.id
  }

  if let namedLane = lanes.first(where: { normalizedWorkLaneLookupValue($0.name) == sessionLaneName }) {
    return namedLane.id
  }

  if let branchLane = lanes.first(where: { normalizedWorkLaneLookupValue($0.branchRef) == sessionLaneName }) {
    return branchLane.id
  }

  return session.laneId
}

private func normalizedWorkLaneLookupValue(_ value: String) -> String {
  value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
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
  case "shell", "terminal":
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
  query: String,
  outputSearchText: String? = nil
) -> Bool {
  let tokens = query
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
    .split(whereSeparator: \.isWhitespace)
    .map(String.init)
  guard !tokens.isEmpty else { return true }
  let indexed = workSessionSearchIndex(session: session, summary: summary, outputSearchText: outputSearchText)
  return tokens.allSatisfy(indexed.contains)
}

private func workSessionSearchIndex(
  session: TerminalSessionSummary,
  summary: AgentChatSessionSummary?,
  outputSearchText: String? = nil
) -> String {
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
  fields.append(outputSearchText ?? "")
  return fields.joined(separator: " ").lowercased()
}

private let workSessionOutputSearchMaxCharacters = 20_000

func workSessionOutputSearchIndexBySessionId(buffers: [String: String]) -> [String: String] {
  guard !buffers.isEmpty else { return [:] }
  var result: [String: String] = [:]
  result.reserveCapacity(buffers.count)
  for (sessionId, buffer) in buffers {
    let searchText = workSessionOutputSearchText(buffer)
    if !searchText.isEmpty {
      result[sessionId] = searchText
    }
  }
  return result
}

func workSessionOutputSearchText(_ raw: String) -> String {
  let tail = raw.count > workSessionOutputSearchMaxCharacters
    ? String(raw.suffix(workSessionOutputSearchMaxCharacters))
    : raw
  var output = ""
  output.reserveCapacity(tail.count)
  var index = tail.startIndex
  while index < tail.endIndex {
    let scalar = tail[index].unicodeScalars.first
    if scalar?.value == 0x1B {
      index = workAdvancePastTerminalEscape(in: tail, from: index)
      continue
    }
    if let value = scalar?.value, value < 0x20 || value == 0x7F {
      if tail[index] == "\n" || tail[index] == "\r" || tail[index] == "\t" {
        output.append(" ")
      }
      index = tail.index(after: index)
      continue
    }
    output.append(tail[index])
    index = tail.index(after: index)
  }
  return output.lowercased()
}

private func workAdvancePastTerminalEscape(in text: String, from escapeIndex: String.Index) -> String.Index {
  var index = text.index(after: escapeIndex)
  guard index < text.endIndex else { return index }

  let introducer = text[index]
  if introducer == "]" {
    index = text.index(after: index)
    while index < text.endIndex {
      let scalar = text[index].unicodeScalars.first?.value
      if scalar == 0x07 {
        return text.index(after: index)
      }
      if scalar == 0x1B {
        let next = text.index(after: index)
        if next < text.endIndex && text[next] == "\\" {
          return text.index(after: next)
        }
      }
      index = text.index(after: index)
    }
    return text.endIndex
  }

  if introducer == "[" || introducer == "(" || introducer == ")" || introducer == "P" || introducer == "^" || introducer == "_" {
    index = text.index(after: index)
    while index < text.endIndex {
      if let scalar = text[index].unicodeScalars.first, scalar.value >= 0x40 && scalar.value <= 0x7E {
        return text.index(after: index)
      }
      index = text.index(after: index)
    }
    return text.endIndex
  }

  return text.index(after: index)
}

private func workSessionStatusSortRank(_ status: String) -> Int {
  switch status {
  case "awaiting-input": return 0
  case "active": return 1
  case "idle": return 2
  default: return 3
  }
}
