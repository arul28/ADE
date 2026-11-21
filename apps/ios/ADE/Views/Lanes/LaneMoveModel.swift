import Foundation

// The plain parts of "Move this lane to", the same rules as the desktop
// (`laneMoveModel.ts`, `laneMoveRuns.ts`, `shared/cloudKeptLaneRestore.ts`):
// what a move carries, how much of each chat's history arrives, the records
// the brains answer with, and the check that allows deleting an ADE Cloud
// computer after a move. No view and no network here.

/// Where a lane moves from, which decides how its move runs.
///
/// - `own`: one of the person's computers. Its brain's batch move carries the
///   lane and its chats to the other computer.
/// - `cloud`: an awake ADE Cloud computer. The same batch move runs; once it
///   is done and checked, ADE deletes the cloud computer.
/// - `cloudAsleep`: an ADE Cloud computer at rest. The destination's brain
///   deletes it first and restores the lane from what it saved when it went
///   to sleep, so nothing wakes. When that copy isn't complete, the person
///   wakes it and the move runs like `cloud`.
/// - `cloudGone`: the lane's ADE Cloud computer was deleted. The destination's
///   brain restores the lane from the account's saved copies.
enum LaneMoveSourceKind: String, Codable, Equatable {
  case own, cloud, cloudAsleep, cloudGone
}

/// The files git ignores on an ADE Cloud computer, as it last read them
/// (`CloudIgnoredFiles`). No saved copy holds them.
typealias LaneMoveIgnoredFiles = CloudPhoneAccount.IdleCleanup.IgnoredFiles

/// How much of a chat's history arrives where it moves.
enum LaneMoveHistory: String, Codable, Equatable, Hashable {
  /// All of it (a fork of the provider's own session).
  case full
  /// A written summary of it: the agent can't carry its history.
  case summary
  /// A move from saved copies: the saved transcript is replayed.
  case transcript
  /// A move from saved copies: a CLI starts again.
  case fresh

  var label: String {
    switch self {
    case .full: return "Full history"
    case .summary: return "Summary"
    case .transcript: return "Saved transcript"
    case .fresh: return "Starts fresh"
    }
  }

  /// Less than the whole history arrives: the review names it.
  var reduced: Bool { self == .summary || self == .fresh }
}

/// One part of a move as the review and the progress list it.
struct LaneMoveItem: Identifiable, Equatable, Hashable {
  enum Kind: String, Equatable, Hashable { case chat, cli, lane }
  let id: String
  let title: String
  let kind: Kind
  /// The provider or CLI tool, for its logo. Empty when not known.
  let provider: String
  let history: LaneMoveHistory
}

/// The chat providers whose full history a move carries (desktop
/// `CROSS_MACHINE_HANDOFF_FORK_PROVIDERS`). Every other provider of the 13
/// arrives as a summary.
let laneMoveFullHistoryProviders: Set<String> = ["claude", "codex", "opencode", "droid", "cursor", "muse"]

/// The CLIs whose own conversation file a move carries (desktop
/// `CLI_TOOLS_WITH_FULL_HISTORY`); the rest start again from a summary.
let laneMoveFullHistoryCliTools: Set<String> = ["claude", "codex", "claude-orchestrated", "codex-orchestrated"]

/// The provider of an ADE chat's tool type (`claude-chat` is `claude`). Nil
/// for a session that is not a chat.
func laneMoveChatProvider(toolType: String?) -> String? {
  let raw = toolType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
  guard isWorkChatToolType(raw) else { return nil }
  if raw == "cursor" { return "cursor" }
  return raw.hasSuffix("-chat") ? String(raw.dropLast("-chat".count)) : nil
}

/// A chat whose latest move still continues on another machine belongs to
/// that machine (desktop `crossMachineMoveLock`).
private func laneMoveLockedAway(_ record: AgentChatCrossMachineHandoffRecord?) -> Bool {
  guard let record else { return false }
  return record.state == .continued && !record.resumedHere
}

/// What a live move carries for a lane: its open Work chats and tracked agent
/// CLIs, as the source brain's batch selects them. `sessions` is the lane's
/// session list on its machine, `chats` its chat list there. A chat of
/// another surface (CTO, personal) stays out, so the batch is never refused
/// for one. A chat or CLI that already continues elsewhere stays out too.
func laneMoveItems(sessions: [TerminalSessionSummary], chats: [AgentChatSessionSummary]) -> [LaneMoveItem] {
  let work = Dictionary(
    chats.filter { ($0.surface ?? "work") == "work" }.map { ($0.sessionId, $0) },
    uniquingKeysWith: { first, _ in first }
  )
  var items: [LaneMoveItem] = []
  var seen = Set<String>()
  for row in sessions {
    guard row.archivedAt == nil, !laneMoveLockedAway(row.crossMachineHandoff), seen.insert(row.id).inserted else { continue }
    if isWorkChatToolType(row.toolType) {
      guard let chat = work[row.id], row.settledAt == nil, chat.archivedAt == nil,
            !laneMoveLockedAway(chat.crossMachineHandoff) else { continue }
      let provider = nonEmptyTrimmed(chat.provider)?.lowercased() ?? laneMoveChatProvider(toolType: row.toolType) ?? ""
      items.append(LaneMoveItem(
        id: row.id,
        title: nonEmptyTrimmed(row.title) ?? nonEmptyTrimmed(chat.title) ?? "Untitled chat",
        kind: .chat,
        provider: provider,
        history: laneMoveFullHistoryProviders.contains(provider) ? .full : .summary
      ))
    } else if row.tracked, isWorkAgentToolType(row.toolType) {
      let tool = row.toolType?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
      var logo = tool
      if logo.hasSuffix("-orchestrated") { logo = String(logo.dropLast("-orchestrated".count)) }
      if logo.hasSuffix("-cli") { logo = String(logo.dropLast("-cli".count)) }
      items.append(LaneMoveItem(
        id: row.id,
        title: nonEmptyTrimmed(row.title) ?? "CLI session",
        kind: .cli,
        provider: logo,
        history: laneMoveFullHistoryCliTools.contains(tool) ? .full : .summary
      ))
    }
  }
  // An older brain may list a chat without its session row: it still moves.
  for chat in chats where !seen.contains(chat.sessionId) {
    guard (chat.surface ?? "work") == "work", chat.archivedAt == nil, !laneMoveLockedAway(chat.crossMachineHandoff) else { continue }
    seen.insert(chat.sessionId)
    let provider = chat.provider.lowercased()
    items.append(LaneMoveItem(
      id: chat.sessionId,
      title: nonEmptyTrimmed(chat.title) ?? "Untitled chat",
      kind: .chat,
      provider: provider,
      history: laneMoveFullHistoryProviders.contains(provider) ? .full : .summary
    ))
  }
  return items
}

// MARK: - The batch move record (`chat.getCrossMachineBatchMove`)

/// One lane or chat of a batch move. `id`, `kind` and `state` are required:
/// an item the phone can't read fails the whole record, so it can never be
/// left out of the check that allows a delete.
struct LaneMoveBatchItem: Decodable, Equatable, Identifiable {
  let id: String
  /// `lane` or `chat`.
  let kind: String
  /// `pending`, `sending`, `awaiting_approval`, `continued`, `cancelled`,
  /// `failed`, `unknown` or `blocked`.
  let state: String
  let sourceSessionId: String?
  let sourceChatTitle: String?
  let destinationLaneId: String?
  let destinationSessionId: String?
  /// `fork` or `brief` for a chat.
  let mode: String?
  let error: String?

  init(
    id: String,
    kind: String,
    state: String,
    sourceSessionId: String? = nil,
    sourceChatTitle: String? = nil,
    destinationLaneId: String? = nil,
    destinationSessionId: String? = nil,
    mode: String? = nil,
    error: String? = nil
  ) {
    self.id = id
    self.kind = kind
    self.state = state
    self.sourceSessionId = sourceSessionId
    self.sourceChatTitle = sourceChatTitle
    self.destinationLaneId = destinationLaneId
    self.destinationSessionId = destinationSessionId
    self.mode = mode
    self.error = error
  }

  private enum CodingKeys: String, CodingKey {
    case id, kind, state, sourceSessionId, sourceChatTitle, destinationLaneId, destinationSessionId, mode, error
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    kind = try c.decode(String.self, forKey: .kind)
    state = try c.decode(String.self, forKey: .state)
    sourceSessionId = c.lenient(String.self, forKey: .sourceSessionId)
    sourceChatTitle = c.lenient(String.self, forKey: .sourceChatTitle)
    destinationLaneId = c.lenient(String.self, forKey: .destinationLaneId)
    destinationSessionId = c.lenient(String.self, forKey: .destinationSessionId)
    mode = c.lenient(String.self, forKey: .mode)
    error = c.lenient(String.self, forKey: .error)
  }
}

/// A batch move as the lane's brain reports it (desktop
/// `AgentChatCrossMachineBatchMoveRecord`). Its items decode strictly.
struct LaneMoveBatchRecord: Decodable, Equatable {
  let batchId: String
  /// `awaiting_approval`, `pending`, `running`, `completed`, `partial` or `cancelled`.
  let state: String
  let machineKey: String?
  let machineName: String?
  let items: [LaneMoveBatchItem]

  init(batchId: String, state: String, machineKey: String? = nil, machineName: String? = nil, items: [LaneMoveBatchItem]) {
    self.batchId = batchId
    self.state = state
    self.machineKey = machineKey
    self.machineName = machineName
    self.items = items
  }

  private enum CodingKeys: String, CodingKey { case batchId, state, machineKey, machineName, items }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    batchId = try c.decode(String.self, forKey: .batchId)
    state = try c.decode(String.self, forKey: .state)
    machineKey = c.lenient(String.self, forKey: .machineKey)
    machineName = c.lenient(String.self, forKey: .machineName)
    items = try c.decode([LaneMoveBatchItem].self, forKey: .items)
  }
}

/// Whether a batch move allows deleting the lane's ADE Cloud computer after
/// it: the batch completed, it carried the lane, and every item arrived with
/// the lane or chat it made on the destination. Anything else (partial,
/// cancelled, still running, an item in any other state, a kind the phone
/// does not know) keeps the computer, so nothing is lost.
func laneMoveBatchAllowsComputerDelete(_ record: LaneMoveBatchRecord) -> Bool {
  guard record.state == "completed",
        !record.items.isEmpty,
        record.items.contains(where: { $0.kind == "lane" })
  else { return false }
  return record.items.allSatisfy(laneMoveBatchItemArrived)
}

/// One part of a batch arrived: it continued, with the lane or chat it made
/// on the destination. The delete gate, the progress and the failure text
/// all count arrivals with this.
func laneMoveBatchItemArrived(_ item: LaneMoveBatchItem) -> Bool {
  guard item.state == "continued" else { return false }
  switch item.kind {
  case "lane": return nonEmptyTrimmed(item.destinationLaneId) != nil
  case "chat": return nonEmptyTrimmed(item.destinationSessionId) != nil
  default: return false
  }
}

/// The batch stopped changing: the brain is done with it.
func laneMoveBatchEnded(_ record: LaneMoveBatchRecord) -> Bool {
  ["completed", "partial", "cancelled"].contains(record.state)
}

/// The chats a batch carried that arrived, by their id on the source: only
/// their saved copies go with the ADE Cloud computer.
func laneMoveBatchMovedChatIds(_ record: LaneMoveBatchRecord) -> [String] {
  record.items.compactMap { item in
    item.kind == "chat" && laneMoveBatchItemArrived(item) ? nonEmptyTrimmed(item.sourceSessionId) : nil
  }
}

/// What went wrong, for a batch that ended without everything arriving.
func laneMoveBatchFailure(_ record: LaneMoveBatchRecord) -> String {
  if record.state == "cancelled" { return "The move was cancelled." }
  let failed = record.items.filter { !laneMoveBatchItemArrived($0) }
  if let first = failed.compactMap({ nonEmptyTrimmed($0.error) }).first { return first }
  return "\(failed.count) of \(record.items.count) parts did not arrive."
}

// MARK: - The kept-lane restore (`cloud.*KeptLaneRestore`)

/// What a move from saved copies brings (desktop `CloudKeptLaneRestorePreview`).
struct CloudKeptLaneRestorePreview: Decodable, Equatable {
  struct Work: Decodable, Equatable {
    let unpushedCommits: Int?
    let changedFiles: Int?
    let bytes: Int?
  }

  struct Chat: Decodable, Equatable {
    let chatId: String
    let title: String?
    let provider: String?
    /// `chat` or `cli`.
    let kind: String
    let history: LaneMoveHistory

    init(chatId: String, title: String?, provider: String?, kind: String, history: LaneMoveHistory) {
      self.chatId = chatId
      self.title = title
      self.provider = provider
      self.kind = kind
      self.history = history
    }

    private enum CodingKeys: String, CodingKey { case chatId, title, provider, kind, history }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      chatId = try c.decode(String.self, forKey: .chatId)
      title = c.lenient(String.self, forKey: .title)
      provider = c.lenient(String.self, forKey: .provider)
      kind = c.lenient(String.self, forKey: .kind) ?? "chat"
      // A value a newer brain added says no more than "starts fresh".
      history = c.lenient(LaneMoveHistory.self, forKey: .history) ?? .fresh
    }
  }

  let laneId: String
  let laneName: String
  let branchRef: String?
  /// This project on the destination is the lane's repository.
  let hasRepository: Bool
  /// The newest saved work that isn't on GitHub; nil when there is none.
  let work: Work?
  let chats: [Chat]
  /// A move off an asleep computer: whether its saved copy holds all of the
  /// lane's work, else why not. Nil for a kept lane and from older brains.
  let fromComputer: FromComputer?
  /// Chats and CLIs whose saved copy is on another computer of the person's
  /// now: they don't come, so the lane stays on ADE Cloud too. Empty from
  /// older brains.
  let blocked: [Blocked]

  struct Blocked: Decodable, Equatable {
    let chatId: String
    let title: String?
    /// `chat` or `cli`.
    let kind: String?
  }

  /// The asleep computer's saved copy, as the destination read it with no wake.
  struct FromComputer: Decodable, Equatable {
    /// The copy holds all of the lane's work. False: the move wakes it instead.
    let saved: Bool
    let reason: String?
    /// The files git ignores on it; nil before its first read.
    let ignored: LaneMoveIgnoredFiles?

    init(saved: Bool, reason: String?, ignored: LaneMoveIgnoredFiles?) {
      self.saved = saved
      self.reason = reason
      self.ignored = ignored
    }

    private enum CodingKeys: String, CodingKey { case saved, reason, ignored }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      // A copy the phone can't read is never taken as complete.
      saved = c.lenient(Bool.self, forKey: .saved) ?? false
      reason = c.lenient(String.self, forKey: .reason)
      ignored = c.lenient(LaneMoveIgnoredFiles.self, forKey: .ignored)
    }
  }

  init(
    laneId: String,
    laneName: String,
    branchRef: String?,
    hasRepository: Bool,
    work: Work?,
    chats: [Chat],
    fromComputer: FromComputer? = nil,
    blocked: [Blocked] = []
  ) {
    self.laneId = laneId
    self.laneName = laneName
    self.branchRef = branchRef
    self.hasRepository = hasRepository
    self.work = work
    self.chats = chats
    self.fromComputer = fromComputer
    self.blocked = blocked
  }

  private enum CodingKeys: String, CodingKey { case laneId, laneName, branchRef, hasRepository, work, chats, fromComputer, blocked }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    laneId = try c.decode(String.self, forKey: .laneId)
    laneName = c.lenient(String.self, forKey: .laneName) ?? "Cloud lane"
    branchRef = c.lenient(String.self, forKey: .branchRef)
    hasRepository = c.lenient(Bool.self, forKey: .hasRepository) ?? false
    work = c.lenient(Work.self, forKey: .work)
    chats = c.lenient([Chat].self, forKey: .chats) ?? []
    fromComputer = c.lenient(FromComputer.self, forKey: .fromComputer)
    blocked = c.lenient([Blocked].self, forKey: .blocked) ?? []
  }

  var items: [LaneMoveItem] {
    chats.map { chat in
      let cli = chat.kind == "cli"
      return LaneMoveItem(
        id: chat.chatId,
        title: nonEmptyTrimmed(chat.title) ?? (cli ? "CLI session" : "Untitled chat"),
        kind: cli ? .cli : .chat,
        provider: chat.provider?.lowercased() ?? "",
        history: chat.history
      )
    }
  }
}

/// A move from saved copies as the destination's brain runs it (desktop
/// `CloudKeptLaneRestoreRecord`). The brain forgets the kept lane itself,
/// and only once every chat came back.
struct CloudKeptLaneRestoreRecord: Decodable, Equatable {
  struct Chat: Decodable, Equatable {
    let chatId: String
    let title: String?
    /// `pending`, `restored` or `failed`.
    let state: String
    let history: LaneMoveHistory?
    let error: String?

    init(chatId: String, title: String?, state: String, history: LaneMoveHistory?, error: String?) {
      self.chatId = chatId
      self.title = title
      self.state = state
      self.history = history
      self.error = error
    }

    private enum CodingKeys: String, CodingKey { case chatId, title, state, history, error }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      chatId = try c.decode(String.self, forKey: .chatId)
      title = c.lenient(String.self, forKey: .title)
      state = c.lenient(String.self, forKey: .state) ?? "pending"
      history = c.lenient(LaneMoveHistory.self, forKey: .history)
      error = c.lenient(String.self, forKey: .error)
    }
  }

  let restoreId: String
  let laneId: String
  let laneName: String
  /// `running`, `completed` or `failed`.
  let state: String
  let localLaneId: String?
  /// `release` (a move off an asleep computer deletes it and keeps its lane
  /// first), `lane`, `chats`, `cleanup` or `done`.
  let step: String
  let chats: [Chat]
  let error: String?
  /// The release was refused (the saved copy isn't complete, or the computer
  /// woke). Nothing was deleted: wake it and move the lane live.
  let wakeInstead: Bool

  init(
    restoreId: String,
    laneId: String,
    laneName: String,
    state: String,
    localLaneId: String?,
    step: String,
    chats: [Chat],
    error: String?,
    wakeInstead: Bool = false
  ) {
    self.restoreId = restoreId
    self.laneId = laneId
    self.laneName = laneName
    self.state = state
    self.localLaneId = localLaneId
    self.step = step
    self.chats = chats
    self.error = error
    self.wakeInstead = wakeInstead
  }

  private enum CodingKeys: String, CodingKey { case restoreId, laneId, laneName, state, localLaneId, step, chats, error, wakeInstead }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    restoreId = try c.decode(String.self, forKey: .restoreId)
    laneId = try c.decode(String.self, forKey: .laneId)
    laneName = c.lenient(String.self, forKey: .laneName) ?? "Cloud lane"
    state = try c.decode(String.self, forKey: .state)
    localLaneId = c.lenient(String.self, forKey: .localLaneId)
    step = c.lenient(String.self, forKey: .step) ?? "lane"
    chats = c.lenient([Chat].self, forKey: .chats) ?? []
    error = c.lenient(String.self, forKey: .error)
    wakeInstead = c.lenient(Bool.self, forKey: .wakeInstead) ?? false
  }
}

// MARK: - Progress

enum LaneMoveRowState: Equatable {
  case waiting, moving, arrived, failed
}

struct LaneMoveProgressRow: Identifiable, Equatable {
  var id: String { item.id }
  let item: LaneMoveItem
  let state: LaneMoveRowState
  let error: String?
}

private let laneMoveLaneRowTitle = "Branch and work"

/// Each part of a batch move, the lane first, as the brain lists them.
func laneMoveProgressRows(batch: LaneMoveBatchRecord?, review: [LaneMoveItem]) -> [LaneMoveProgressRow] {
  let byId = Dictionary(review.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
  let ended = batch.map(laneMoveBatchEnded) ?? false
  return (batch?.items ?? []).map { item in
    let state: LaneMoveRowState
    switch item.state {
    // Continued with nothing made there yet: not arrived, as the delete gate counts it.
    case "continued": state = laneMoveBatchItemArrived(item) ? .arrived : (ended ? .failed : .moving)
    case "failed", "cancelled", "blocked", "unknown": state = .failed
    case "sending": state = .moving
    default: state = .waiting
    }
    if item.kind == "lane" {
      return LaneMoveProgressRow(
        item: LaneMoveItem(id: item.id, title: laneMoveLaneRowTitle, kind: .lane, provider: "", history: .full),
        state: state,
        error: item.error
      )
    }
    let sessionId = item.sourceSessionId ?? item.id
    let known = byId[sessionId] ?? LaneMoveItem(
      id: sessionId,
      title: nonEmptyTrimmed(item.sourceChatTitle) ?? "Chat",
      kind: .chat,
      provider: "",
      history: item.mode == "fork" ? .full : .summary
    )
    return LaneMoveProgressRow(item: known, state: state, error: item.error)
  }
}

/// Each part of a move from saved copies: the branch and work first, then each chat.
func laneMoveProgressRows(restore: CloudKeptLaneRestoreRecord?, review: [LaneMoveItem]) -> [LaneMoveProgressRow] {
  let byId = Dictionary(review.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
  let laneState: LaneMoveRowState
  if let restore {
    switch restore.step {
    // While the asleep computer is released, the lane waits; a refused release touched nothing.
    case "release": laneState = .waiting
    case "lane": laneState = restore.state == "failed" ? .failed : .moving
    default: laneState = .arrived
    }
  } else {
    laneState = .moving
  }
  let lane = LaneMoveProgressRow(
    item: LaneMoveItem(id: "lane", title: laneMoveLaneRowTitle, kind: .lane, provider: "", history: .full),
    state: laneState,
    error: nil
  )
  let chats = (restore?.chats ?? []).map { chat in
    let state: LaneMoveRowState = chat.state == "restored" ? .arrived
      : chat.state == "failed" ? .failed
      : restore?.step == "chats" ? .moving : .waiting
    let item = byId[chat.chatId] ?? LaneMoveItem(
      id: chat.chatId,
      title: nonEmptyTrimmed(chat.title) ?? "Chat",
      kind: .chat,
      provider: "",
      history: chat.history ?? .full
    )
    return LaneMoveProgressRow(item: item, state: state, error: chat.error)
  }
  return [lane] + chats
}

// MARK: - Words

private func laneMovePlural(_ count: Int, _ one: String, _ many: String? = nil) -> String {
  "\(count) \(count == 1 ? one : (many ?? one + "s"))"
}

/// "2 commits not on GitHub and 3 changed files"; nil when nothing travels.
func laneMoveWorkPhrase(commits: Int, files: Int) -> String? {
  var parts: [String] = []
  if commits > 0 { parts.append("\(laneMovePlural(commits, "commit")) not on GitHub") }
  if files > 0 { parts.append(laneMovePlural(files, "changed file")) }
  return parts.isEmpty ? nil : parts.joined(separator: " and ")
}

/// The branch line of the review.
func laneMoveBranchSentence(workPhrase: String?) -> String {
  if let workPhrase { return "The branch comes with \(workPhrase). Nothing is pushed." }
  return "The branch comes with it. Nothing is pushed."
}

/// The note under the list that names each chat arriving with less than its
/// whole history. Nil when every chat arrives whole.
func laneMoveSummaryNote(items: [LaneMoveItem], sourceMachineName: String, deletesComputer: Bool, restores: Bool) -> String? {
  let reduced = items.filter { $0.history.reduced }
  guard !reduced.isEmpty else { return nil }
  let names = reduced.map { "“\($0.title)”" }.joined(separator: ", ")
  let one = reduced.count == 1
  // A move from saved copies has only what was saved: a CLI starts again,
  // and its earlier session isn't kept anywhere to read.
  if restores {
    return "\(names) \(one ? "starts" : "start") fresh there. \(one ? "Its earlier session doesn't" : "Their earlier sessions don't") come back."
  }
  let start = "\(names) \(one ? "arrives" : "arrive") as a summary. \(one ? "Its agent can't" : "Their agents can't") carry \(one ? "its" : "their") full history to another machine."
  if deletesComputer { return "\(start) The full history is deleted with the \(ADECloudMachine.name) computer." }
  return "\(start) The full history stays on \(sourceMachineName)."
}

/// The files git ignores on an ADE Cloud computer, which no move carries and
/// which go with the computer (desktop `ignoredFilesNote`). Named when the
/// computer said which; nil when it found none.
func laneMoveIgnoredFilesNote(_ ignored: LaneMoveIgnoredFiles?, asleep: Bool) -> String? {
  let after = asleep
    ? " To copy them first, wake the computer and move the lane from there."
    : " Copy them yourself first if you need them."
  guard let ignored else {
    return "Files git ignores (such as .env) don't move, and they go with the computer.\(after)"
  }
  let list: String
  if ignored.paths.isEmpty {
    // None found: say nothing only when the scan finished.
    guard ignored.more > 0 else {
      return ignored.incomplete == true ? "Files git ignores (such as .env) don't move, and they go with the computer.\(after)" : nil
    }
    list = laneMovePlural(ignored.more, "file")
  } else {
    let shown = ignored.paths.joined(separator: ", ")
    list = ignored.more > 0 ? "\(shown) and \(ignored.more) more" : shown
  }
  let more = ignored.incomplete == true ? " There may be more." : ""
  return "Files git ignores don't move, and they go with the computer: \(list).\(more)\(after)"
}
