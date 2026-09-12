import Foundation

/// The Work list's status chips, named for — and partitioning the list the same
/// way as — the desktop board's four columns (`WorkBoardColumn` in
/// `apps/desktop/src/shared/types/chat.ts`, whose `WORK_BOARD_COLUMN_LABEL`
/// carries these exact four words): Needs you / Working / Waiting / Done.
///
/// The raw values are PERSISTED (`WorkProjectViewState.statusFilter`, written
/// per project+host by `WorkViewStateStore`), so they are wire values and not
/// display names. The CASE NAMES are board vocabulary, the RAW VALUES are the
/// older wire spelling they shipped with: `needsYou` still writes `needsInput`,
/// `working` writes `running`, `done` writes `ended`. Changing a raw value would
/// silently reset every saved view to `.all`, since the decode is
/// `init(rawValue:) ?? .all`; renaming a case cannot, because a case name is
/// never written anywhere.
enum WorkSessionStatusFilter: String, CaseIterable, Identifiable {
  case all
  case needsYou = "needsInput"
  case working = "running"
  case waiting
  case done = "ended"
  case archived

  var id: String { rawValue }

  /// The chip's word — and, through `workSessionGroupsByStatus`, the word on the
  /// section header the chip's rows land under. The two are read from this one
  /// property so they cannot drift into naming the same four buckets five ways,
  /// which is what "Done" (chip) over an "Ended" header used to do.
  var title: String {
    switch self {
    case .all: return "All"
    // `ActivityBand.title` is already the canonical Swift spelling of the
    // board's columns, shared with the Activity drawer and the widget, so three
    // of the four chips borrow it rather than restating it.
    case .needsYou: return ActivityBand.needsYou.title
    case .working: return ActivityBand.working.title
    // Not a status at all: "blocked on something that is not you and not the
    // agent". Same column name, and same claim, as the desktop board.
    //
    // `ActivityBand` has only three bands — it folds a wait in with work in
    // flight — so this is the one column word it cannot supply, and this is the
    // single place it is spelled.
    case .waiting: return "Waiting"
    case .done: return ActivityBand.done.title
    case .archived: return "Archived"
    }
  }
}

/// Why a session is parked in Waiting instead of Working. Mirrors the desktop
/// `WorkBoardWaitingReason`; the chip only needs the presence of a reason, but
/// deriving the reason itself is what keeps the two surfaces one rule.
enum WorkBoardWaitingReason: Hashable {
  case snoozed
  case ci
  case review
}

/// Does this lane's PR park a running session in Waiting?
///
/// Faithful to desktop `lanePrWaitingReason`. Only live PRs count: a merged or
/// closed PR's last check state is history, and a lane whose PR landed hours ago
/// is not "waiting on CI". `pending` is the only checks value that means work is
/// in flight — `none`/`not_run` mean nobody looked, which is not the same claim
/// (ADE-135), and `failing` is the agent's problem, not a wait.
func workLanePrWaitingReason(_ prs: [PullRequestListItem]) -> WorkBoardWaitingReason? {
  var sawReviewRequest = false
  for pr in prs {
    guard pr.state == "open" || pr.state == "draft" else { continue }
    if pr.checksStatus == "pending" { return .ci }
    if pr.reviewStatus == "requested" { sawReviewRequest = true }
  }
  return sawReviewRequest ? .review : nil
}

/// Lane → the PR-derived wait, from the ADE-mapped PRs the phone already holds
/// locally (the synced `pull_requests` table). No network read is taken for this.
///
/// GitHub-only PRs (`GitHubPrListItem`, from the PRs snapshot) are deliberately
/// absent: that payload carries no checks or review data at all, and desktop
/// projects those rows with `checksStatus: "none"` for exactly that reason, so
/// they can never produce a wait on either surface.
///
/// Detached rows are dropped and the branch match is the shared
/// `lanePrMatchesCurrentBranch`, so this sees the same PRs as the lane's chip.
func workLaneWaitingReasonByLaneId(
  lanes: [LaneSummary],
  pullRequests: [PullRequestListItem]
) -> [String: WorkBoardWaitingReason] {
  guard !pullRequests.isEmpty else { return [:] }
  var result: [String: WorkBoardWaitingReason] = [:]
  for lane in lanes {
    let lanePrs = pullRequests.filter {
      $0.detached == nil && lanePrMatchesCurrentBranch(lane: lane, pr: $0)
    }
    guard let reason = workLanePrWaitingReason(lanePrs) else { continue }
    result[lane.id] = reason
  }
  return result
}

/// Waiting for one row, assembled the way the desktop board assembles the
/// column: snooze first (a deferred row is waiting on a clock, whatever its
/// phase), then the PR wait, which only a running row can carry. Returning nil
/// is what puts the row back in its plain status bucket.
///
/// `phase` is passed in rather than re-derived so the caller's bucket decision
/// and this one can never disagree about the same row.
func workSessionWaitingReason(
  session: TerminalSessionSummary,
  phase: CanonicalSessionPhase,
  laneWaitingReasonByLaneId: [String: WorkBoardWaitingReason],
  now: Date = Date()
) -> WorkBoardWaitingReason? {
  // The shared filing rule, so a raised hand still outranks the snooze overlay:
  // a `needsYou` row is never filed as snoozed and therefore never waits.
  if isSessionFiledAsSnoozed(session.snoozeState, phase: phase, now: now) { return .snoozed }
  guard phase == .starting || phase == .running || phase == .stale else { return nil }
  return laneWaitingReasonByLaneId[session.laneId]
}

/// Which of the three phase-derived chips a row answers to, once Waiting has
/// already been ruled out.
///
/// THE partition, in one place: `workFilteredSessions` reads it to decide which
/// chip admits a row, and `workSessionGroupsByStatus` reads it to decide which
/// section header that row then lands under. Those used to be two separate
/// switches over the same ten phases, and they disagreed — a "Done" chip split
/// its own rows across headers called "Done" and "Ended", while the "Done"
/// header additionally held `.ready`/`.idle` rows the chip never selected.
///
/// The filing follows the shared vocabulary, not a fourth opinion about it:
///
/// - `.ready`/`.idle` file under **Done**, because that is what the rest of the
///   app already calls them. `workActivityPhase` maps both to `.completed` and
///   `workSessionBadgeKind` to `.done`, so the row itself wears an emerald
///   "Done" capsule — a resting chat is a finished outcome nobody has looked at
///   yet. The Needs-you chip used to select them anyway, which is precisely the
///   "finished, go look" / "blocked, go act" conflation the emerald/amber split
///   exists to kill.
/// - `.failed` files under **Done** rather than with the amber band. It is an
///   outcome, and both the chip and the old "Ended" header already read it that
///   way; `ActivityBand` folds breakage in with needs-you for drawer *sorting*,
///   which is a different question from which column a finished run belongs to.
/// - `.stale` stays in **Working**: the process is still alive, and "how long
///   has it been quiet" is a fact about work in flight.
func workStatusFilterPartition(phase: CanonicalSessionPhase) -> WorkSessionStatusFilter {
  switch phase {
  case .needsYou: return .needsYou
  case .starting, .running, .stale: return .working
  case .ready, .idle, .failed, .stopped, .ended, .settled: return .done
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
  outputSearchBySessionId: [String: String] = [:],
  /// Lane → PR-derived wait, from `workLaneWaitingReasonByLaneId`. Empty is a
  /// valid input (no PRs loaded yet): Waiting then means snoozed-only, and every
  /// running row stays in Working rather than being guessed at.
  laneWaitingReasonByLaneId: [String: WorkBoardWaitingReason] = [:],
  now: Date = Date()
) -> [TerminalSessionSummary] {
  let chatSessionIds = Set(sessions.filter(isChatSession).map(\.id))
  return sessions
    .filter { workSessionShouldAppearInWorkList($0, parentChatSessionIds: chatSessionIds) }
    .filter { session in
      let isArchived = archivedSessionIds.contains(session.id)
      // Filter with the same canonical lifecycle vocabulary the status
      // grouping uses, so a filter can never admit sessions its sections
      // don't claim (e.g. a settled chat leaking through "Working" via the old
      // idle status).
      let phase = workCanonicalSessionState(
        session: session,
        summary: chatSummaries[session.id],
        now: now
      ).phase
      // Waiting is resolved FIRST and every other chip then excludes it, which
      // is what makes the four chips a partition by construction rather than by
      // four predicates that have to agree — the same assembly order, and the
      // same reason for it, as `buildWorkBoardModel` on desktop.
      let waitingReason = workSessionWaitingReason(
        session: session,
        phase: phase,
        laneWaitingReasonByLaneId: laneWaitingReasonByLaneId,
        now: now
      )
      switch selectedStatus {
      case .all:
        guard !isArchived else { return false }
      case .needsYou:
        guard !isArchived, waitingReason == nil,
          workStatusFilterPartition(phase: phase) == .needsYou
        else { return false }
      case .working:
        guard !isArchived, waitingReason == nil,
          workStatusFilterPartition(phase: phase) == .working
        else { return false }
      case .waiting:
        guard !isArchived, waitingReason != nil else { return false }
      case .done:
        // Done is ended PLUS settled, matching the desktop column. Settled rows
        // used to surface only under All; the chip now says "Done", and a
        // declared-finished session is the clearest thing that word can mean.
        guard !isArchived, waitingReason == nil,
          workStatusFilterPartition(phase: phase) == .done
        else { return false }
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
  case "pi-chat":
    return "Pi"
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
  // Selecting any chip but All makes `hasFilters` true, so this is the branch a
  // chosen chip actually lands on — it names the empty chip rather than the
  // filters in general, in the chip's own words.
  if hasFilters {
    switch status {
    case .archived: return "No archived sessions match"
    case .needsYou: return "Nothing needs you"
    case .working: return "Nothing is working"
    case .waiting: return "Nothing is waiting"
    case .done: return "Nothing is done"
    case .all: return "No sessions match the current filters"
    }
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
    // Waiting is the one chip whose contents are not obvious from its name, so
    // an empty Waiting says what would have been in it.
    if status == .waiting {
      return "Nothing is snoozed, and no lane PR is sitting on CI or waiting for a review."
    }
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
