import Foundation

// Codable mirrors of the all-projects chat roster wire types defined in
// `apps/desktop/src/shared/types/sync.ts` (search `SyncRoster`). The roster is a
// lightweight, machine-wide projection of every project's lanes + chat sessions
// so the mobile hub can render all projects' chats-grouped-by-lane at once
// without activating each project. Transcripts are NOT included — they load on
// demand when a chat is opened. Pushed over `roster_snapshot` / `roster_delta`
// envelopes; see SyncService+Roster.swift for the store + subscribe handshake.

/// Status of a roster chat row. For an un-booted project (no live runtime) the
/// truthful states are `idle` / `ended` / `awaiting` (last persisted to disk);
/// `running` and live `awaiting` are only emitted for a booted scope.
enum RemoteRosterChatStatus: String, Codable, Equatable {
  case running
  case awaiting
  case idle
  case ended
  case failed

  /// Tolerate unknown future status strings by collapsing to `.idle`.
  init(from decoder: Decoder) throws {
    let raw = try decoder.singleValueContainer().decode(String.self)
    self = RemoteRosterChatStatus(rawValue: raw) ?? .idle
  }
}

struct RemoteRosterChat: Codable, Equatable, Identifiable {
  var id: String // sessionId
  var laneId: String
  var chatSessionId: String?
  var title: String?
  var provider: String?
  var model: String?
  var toolType: String?
  var status: RemoteRosterChatStatus
  var awaitingInput: Bool?
  var pinned: Bool?
  var archived: Bool?
  var lastActivityAt: String?
  var preview: String?
}

struct RemoteRosterLane: Codable, Equatable, Identifiable {
  var id: String
  var name: String
  var color: String?
  var icon: String?
  var laneType: String?
  var branchRef: String?
}

struct RemoteRosterProject: Codable, Equatable, Identifiable {
  var projectId: String
  var rootPath: String?
  var displayName: String
  var iconDataUrl: String?
  var lastOpenedAt: String?
  var booted: Bool
  var runningCount: Int
  var attentionCount: Int
  var lanes: [RemoteRosterLane]
  var chats: [RemoteRosterChat]

  var id: String { projectId }
}

/// Full roster snapshot — `roster_snapshot` envelope payload.
struct RemoteRosterSnapshotPayload: Codable, Equatable {
  var seq: Int
  var projects: [RemoteRosterProject]
}

/// Incremental roster update — `roster_delta` envelope payload.
struct RemoteRosterDeltaPayload: Codable, Equatable {
  var seq: Int
  var changed: [RemoteRosterProject]?
  var removed: [String]?
}

/// Result of applying a `roster_delta` against the current store. Kept as a pure
/// value (no SyncService dependency) so the resync-correctness logic is unit
/// testable — see `RosterDeltaTests`.
enum RosterDeltaOutcome: Equatable {
  /// Apply these projects and advance the watermark to `seq`.
  case applied(projects: [RemoteRosterProject], seq: Int)
  /// Duplicate / out-of-order replay — ignore.
  case dropped
  /// No baseline or a seq gap — must request a fresh snapshot before applying.
  case needsSnapshot
}

/// Pure delta-merge with the same sinceSeq discipline as chat_event: never apply
/// onto an unknown baseline or across a gap (request a snapshot instead), drop
/// duplicates, and upsert `changed` / drop `removed` only for `currentSeq + 1`.
func rosterApplyDelta(
  current: [RemoteRosterProject],
  currentSeq: Int?,
  delta: RemoteRosterDeltaPayload
) -> RosterDeltaOutcome {
  guard let currentSeq else { return .needsSnapshot }
  if delta.seq <= currentSeq { return .dropped }
  if delta.seq > currentSeq + 1 { return .needsSnapshot }
  var byId = [String: RemoteRosterProject]()
  for project in current {
    byId[project.projectId] = project
  }
  for projectId in delta.removed ?? [] { byId.removeValue(forKey: projectId) }
  for project in delta.changed ?? [] { byId[project.projectId] = project }
  return .applied(projects: Array(byId.values), seq: delta.seq)
}

// MARK: - Convenience

extension RemoteRosterChat {
  /// Only explicit chat tool types stream the chat-event surface. An unknown or
  /// missing toolType must NOT read as a chat: routing a CLI (terminal) session
  /// through the chat transcript path yields a permanently blank screen (CLI
  /// sessions have no chat JSONL). The activation/terminal path handles both
  /// kinds, so it is the safe default.
  var isChatTool: Bool {
    let raw = toolType?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased() ?? ""
    guard !raw.isEmpty else { return false }
    return raw == "cursor"
      || raw.hasSuffix("-chat")
      || raw == "chat"
  }

  /// Whether this row should drive an attention bubble on the hub. Only chat
  /// rows (and shells attached to a chat) count — attention feeds the hub's
  /// attention-first project sort, and a standalone CLI session that exited
  /// non-zero long ago must not pin its project to the top forever (CLI rows
  /// have no mobile archive/clear affordance). Mirrors the host rosterBuilder.
  var needsAttention: Bool {
    guard awaitingInput == true || status == .awaiting || status == .failed else { return false }
    if isChatTool { return true }
    let parentId = chatSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return !parentId.isEmpty && parentId != id
  }

  var isRunning: Bool {
    status == .running || status == .awaiting
  }

  /// Provider key for the glyph: prefer the sidecar provider, else derive from
  /// the tool type (e.g. `claude-chat` → `claude`).
  var providerKey: String? {
    if let provider, !provider.isEmpty { return provider }
    guard let toolType, !toolType.isEmpty else { return nil }
    if toolType.hasSuffix("-chat") { return String(toolType.dropLast("-chat".count)) }
    return toolType
  }

  /// Normalized status string consumed by `workChatStatusTint` / `workChatStatusIcon`.
  var normalizedStatusString: String {
    if awaitingInput == true || status == .awaiting { return "awaiting-input" }
    switch status {
    case .running: return "active"
    case .idle: return "idle"
    case .ended: return "ended"
    case .failed: return "ended"
    case .awaiting: return "awaiting-input"
    }
  }
}

extension RemoteRosterProject {
  /// Chats for one lane, freshest first. Archived rows are filtered out for the
  /// hub's at-a-glance view.
  func chats(forLaneId laneId: String) -> [RemoteRosterChat] {
    chats
      .filter { $0.laneId == laneId && $0.archived != true }
      .sorted { ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "") }
  }

  /// Lanes that actually have at least one non-archived chat, preserving the
  /// brain-provided order (primary lane first).
  var lanesWithChats: [RemoteRosterLane] {
    lanes.filter { lane in chats.contains { $0.laneId == lane.id && $0.archived != true } }
  }
}

// MARK: - Conversions to existing Work types
//
// Lets the hub reuse the Work tab's lane picker + session rows without a
// bespoke renderer. These are display-only synthesizations — the real synced
// LaneSummary / session is used once the user opens the project or chat.

extension RemoteRosterLane {
  func asLaneSummary() -> LaneSummary {
    LaneSummary(
      id: id,
      name: name,
      description: nil,
      laneType: laneType ?? "primary",
      baseRef: "",
      branchRef: branchRef ?? "",
      worktreePath: "",
      attachedRootPath: nil,
      parentLaneId: nil,
      childCount: 0,
      stackDepth: 0,
      parentStatus: nil,
      isEditProtected: false,
      status: LaneStatus(dirty: false, ahead: 0, behind: 0, remoteBehind: 0, rebaseInProgress: false),
      color: color,
      icon: icon.flatMap(LaneIcon.init(rawValue:)),
      tags: [],
      folder: nil,
      linearIssue: nil,
      linearIssueLinks: nil,
      createdAt: "",
      archivedAt: nil,
      devicesOpen: nil
    )
  }
}

extension RemoteRosterChat {
  /// (session.status, session.runtimeState) pair that drives the Work row's
  /// status dot via `rawWorkChatSessionStatus`.
  private var sessionStatusStrings: (status: String, runtimeState: String) {
    switch status {
    case .running: return ("running", "running")
    case .awaiting: return ("awaiting-input", "running")
    case .idle: return ("idle", "idle")
    case .ended: return ("completed", "exited")
    case .failed: return ("failed", "failed")
    }
  }

  func asTerminalSessionSummary(laneName: String) -> TerminalSessionSummary {
    let strings = sessionStatusStrings
    return TerminalSessionSummary(
      id: id,
      laneId: laneId,
      laneName: laneName,
      ptyId: nil,
      tracked: false,
      pinned: pinned ?? false,
      manuallyNamed: nil,
      goal: nil,
      toolType: toolType,
      title: (title?.isEmpty == false ? title! : "Untitled chat"),
      status: strings.status,
      startedAt: lastActivityAt ?? "",
      endedAt: status == .ended ? lastActivityAt : nil,
      archivedAt: archived == true ? (lastActivityAt ?? "") : nil,
      exitCode: nil,
      transcriptPath: "",
      headShaStart: nil,
      headShaEnd: nil,
      lastOutputPreview: preview,
      summary: nil,
      runtimeState: strings.runtimeState,
      resumeCommand: nil,
      resumeMetadata: nil,
      chatIdleSinceAt: nil,
      chatSessionId: chatSessionId,
      pendingInputItemId: nil
    )
  }
}
