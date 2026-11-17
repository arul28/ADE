import Foundation
import os

private let cloudAtRestLog = Logger(subsystem: "com.ade.ios", category: "cloud-at-rest")

// What the account server keeps for ADE Cloud lanes while no computer is
// awake (contract.ts, "ADE without a computer"): one project's overview, the
// Git summary of each lane, the copies of its CLI and shell sessions, the
// CTO's account copy, the agent limits, and the Linear and Jira reads. The
// phone reads them with its own account sign-in. A read never wakes a
// computer.
//
// Every route here is new. A 404 from an older server means "use today's
// path": the caller keeps what it showed before, never an empty state.
// Every decode is lenient, so a field a newer server adds or changes drops
// alone.

// MARK: - Shapes

/// One changed file in a lane's Git summary.
struct CloudGitChangedFile: Decodable, Equatable, Hashable {
  let path: String
  /// Git's own letter or word (`M`, `A`, `D`, `R`, `??`, `modified`, …).
  let status: String
  let added: Int
  let removed: Int

  private enum CodingKeys: String, CodingKey { case path, status, added, removed }

  init(path: String, status: String, added: Int, removed: Int) {
    self.path = path
    self.status = status
    self.added = added
    self.removed = removed
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    path = try c.decode(String.self, forKey: .path)
    status = c.lenient(String.self, forKey: .status) ?? "M"
    added = c.lenient(Int.self, forKey: .added) ?? 0
    removed = c.lenient(Int.self, forKey: .removed) ?? 0
  }

  /// The kind of change as a person reads it.
  var kind: Kind {
    let value = status.trimmingCharacters(in: .whitespaces).lowercased()
    if value.hasPrefix("a") || value == "??" || value == "untracked" || value == "added" { return .added }
    if value.hasPrefix("d") || value == "deleted" { return .deleted }
    if value.hasPrefix("r") || value == "renamed" { return .renamed }
    return .modified
  }

  enum Kind { case added, modified, deleted, renamed }
}

/// What a lane's computer read of its Git state before it went to sleep
/// (`GET /cloud/git/:m/:lane`). The overview carries the counts only.
struct CloudGitSummary: Decodable, Equatable {
  let machineKey: String
  let laneId: String
  let branch: String?
  let upstream: String?
  let ahead: Int
  let behind: Int
  let headSha: String?
  let dirty: Bool
  @ADELossyArray var changed: [CloudGitChangedFile]
  let truncated: Bool
  /// When the computer read it (ms).
  let checkedAt: Double

  private enum CodingKeys: String, CodingKey {
    case machineKey, laneId, branch, upstream, ahead, behind, headSha, dirty, changed, truncated, checkedAt
  }

  init(
    machineKey: String, laneId: String, branch: String?, upstream: String?, ahead: Int, behind: Int,
    headSha: String?, dirty: Bool, changed: [CloudGitChangedFile], truncated: Bool, checkedAt: Double
  ) {
    self.machineKey = machineKey
    self.laneId = laneId
    self.branch = branch
    self.upstream = upstream
    self.ahead = ahead
    self.behind = behind
    self.headSha = headSha
    self.dirty = dirty
    self._changed = ADELossyArray(wrappedValue: changed)
    self.truncated = truncated
    self.checkedAt = checkedAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    machineKey = try c.decode(String.self, forKey: .machineKey)
    laneId = try c.decode(String.self, forKey: .laneId)
    branch = c.lenient(String.self, forKey: .branch)
    upstream = c.lenient(String.self, forKey: .upstream)
    ahead = c.lenient(Int.self, forKey: .ahead) ?? 0
    behind = c.lenient(Int.self, forKey: .behind) ?? 0
    headSha = c.lenient(String.self, forKey: .headSha)
    dirty = c.lenient(Bool.self, forKey: .dirty) ?? false
    _changed = c.lenient(ADELossyArray<CloudGitChangedFile>.self, forKey: .changed) ?? ADELossyArray(wrappedValue: [])
    truncated = c.lenient(Bool.self, forKey: .truncated) ?? false
    checkedAt = c.lenient(Double.self, forKey: .checkedAt) ?? 0
  }

  var addedLines: Int { changed.reduce(0) { $0 + $1.added } }
  var removedLines: Int { changed.reduce(0) { $0 + $1.removed } }
  /// The branch holds work GitHub does not have yet.
  var hasUnpushedWork: Bool { dirty || ahead > 0 || !changed.isEmpty }
}

/// The overview's form of a Git summary: counts, no file list.
struct CloudGitSummaryCounts: Decodable, Equatable {
  let machineKey: String
  let laneId: String
  let branch: String?
  let ahead: Int
  let behind: Int
  let dirty: Bool
  let changedCount: Int
  let added: Int
  let removed: Int
  let checkedAt: Double

  private enum CodingKeys: String, CodingKey {
    case machineKey, laneId, branch, ahead, behind, dirty, changedCount, added, removed, checkedAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    machineKey = try c.decode(String.self, forKey: .machineKey)
    laneId = try c.decode(String.self, forKey: .laneId)
    branch = c.lenient(String.self, forKey: .branch)
    ahead = c.lenient(Int.self, forKey: .ahead) ?? 0
    behind = c.lenient(Int.self, forKey: .behind) ?? 0
    dirty = c.lenient(Bool.self, forKey: .dirty) ?? false
    changedCount = c.lenient(Int.self, forKey: .changedCount) ?? 0
    added = c.lenient(Int.self, forKey: .added) ?? 0
    removed = c.lenient(Int.self, forKey: .removed) ?? 0
    checkedAt = c.lenient(Double.self, forKey: .checkedAt) ?? 0
  }
}

/// A cloud computer's state from the server's own rows (`CloudComputerTruth`).
struct CloudComputerTruth: Decodable, Equatable {
  let instanceId: String
  let machineKey: String?
  let laneId: String?
  /// `awake`, `waking`, `asleep`, `stopped`, `updating` or `deleting`.
  let state: String
  let idleSaving: Bool

  private enum CodingKeys: String, CodingKey { case instanceId, machineKey, laneId, state, idleSaving }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    instanceId = try c.decode(String.self, forKey: .instanceId)
    machineKey = c.lenient(String.self, forKey: .machineKey)
    laneId = c.lenient(String.self, forKey: .laneId)
    state = c.lenient(String.self, forKey: .state) ?? "asleep"
    idleSaving = c.lenient(Bool.self, forKey: .idleSaving) ?? false
  }
}

/// One cloud lane in the overview: on a computer, or without one.
struct CloudLaneOverview: Decodable, Equatable {
  let laneId: String
  let laneName: String?
  let branch: String?
  /// The machine key its saved chats are under (the computer's, or the former computer's).
  let machineKey: String?
  let computer: CloudComputerTruth?
  /// Set when the lane has no computer now (`reason`: why it was freed).
  let withoutComputerReason: String?
  let prState: String?

  private enum CodingKeys: String, CodingKey { case laneId, laneName, branch, machineKey, computer, withoutComputer, prState }
  private struct Without: Decodable { let reason: String? }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    laneId = try c.decode(String.self, forKey: .laneId)
    laneName = c.lenient(String.self, forKey: .laneName)
    branch = c.lenient(String.self, forKey: .branch)
    machineKey = c.lenient(String.self, forKey: .machineKey)
    computer = c.lenient(CloudComputerTruth.self, forKey: .computer)
    withoutComputerReason = c.lenient(Without.self, forKey: .withoutComputer).map { $0.reason ?? "other" }
    prState = c.lenient(String.self, forKey: .prState)
  }
}

/// The saved copy of one CLI or shell session of a cloud computer.
struct CloudSessionRow: Decodable, Equatable, Identifiable {
  let machineKey: String
  let sessionId: String
  /// `cli` (a provider's CLI in an ADE terminal) or `shell`.
  let kind: String
  let title: String?
  let laneId: String?
  let laneName: String?
  /// The CLI's tool type (`claude-code`, `codex`, …); nil for a shell.
  let toolType: String?
  let projectKey: String?
  /// The chat that started it, when an agent did.
  let parentChatId: String?
  /// `running` or `exited`, as the computer last saw it.
  let status: String?
  let lastActivityAt: String?
  let lineCount: Int
  /// When the computer last saved it (ms).
  let updatedAt: Double

  var id: String { "\(machineKey)\n\(sessionId)" }
  var isShell: Bool { kind == "shell" }

  private enum CodingKeys: String, CodingKey {
    case machineKey, sessionId, kind, title, laneId, laneName, toolType, projectKey, parentChatId, status, lastActivityAt, lineCount, updatedAt
  }

  init(
    machineKey: String, sessionId: String, kind: String, title: String?, laneId: String?, laneName: String?,
    toolType: String?, projectKey: String?, parentChatId: String?, status: String?, lastActivityAt: String?,
    lineCount: Int, updatedAt: Double
  ) {
    self.machineKey = machineKey
    self.sessionId = sessionId
    self.kind = kind
    self.title = title
    self.laneId = laneId
    self.laneName = laneName
    self.toolType = toolType
    self.projectKey = projectKey
    self.parentChatId = parentChatId
    self.status = status
    self.lastActivityAt = lastActivityAt
    self.lineCount = lineCount
    self.updatedAt = updatedAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    machineKey = try c.decode(String.self, forKey: .machineKey)
    sessionId = try c.decode(String.self, forKey: .sessionId)
    kind = c.lenient(String.self, forKey: .kind) ?? "cli"
    title = c.lenient(String.self, forKey: .title)
    laneId = c.lenient(String.self, forKey: .laneId)
    laneName = c.lenient(String.self, forKey: .laneName)
    toolType = c.lenient(String.self, forKey: .toolType)
    projectKey = c.lenient(String.self, forKey: .projectKey)?.lowercased()
    parentChatId = c.lenient(String.self, forKey: .parentChatId)
    status = c.lenient(String.self, forKey: .status)
    lastActivityAt = c.lenient(String.self, forKey: .lastActivityAt)
    lineCount = c.lenient(Int.self, forKey: .lineCount) ?? 0
    updatedAt = c.lenient(Double.self, forKey: .updatedAt) ?? 0
  }
}

/// `GET /cloud/sessions/:m/:s`: the copy itself.
struct CloudSessionCopy: Decodable, Equatable {
  let session: CloudSessionRow
  /// `text`: the last lines; `xterm`: a serialized screen with escape codes.
  let format: String
  let text: String

  init(session: CloudSessionRow, format: String, text: String) {
    self.session = session
    self.format = format
    self.text = text
  }
}

/// One project's whole ADE Cloud view with no computer awake.
struct CloudProjectOverview: Decodable, Equatable {
  struct DeletingSoon: Decodable, Equatable {
    let instanceId: String
    let laneId: String?
    let deletesAt: Double
  }

  @ADELossyArray var lanes: [CloudLaneOverview]
  @ADELossyArray var sessions: [CloudSessionRow]
  @ADELossyArray var git: [CloudGitSummaryCounts]
  @ADELossyArray var deletingSoon: [DeletingSoon]
  let checkedAt: Double

  private enum CodingKeys: String, CodingKey { case lanes, sessions, git, deletingSoon, checkedAt }

  init(lanes: [CloudLaneOverview] = [], sessions: [CloudSessionRow], checkedAt: Double) {
    _lanes = ADELossyArray(wrappedValue: lanes)
    _sessions = ADELossyArray(wrappedValue: sessions)
    _git = ADELossyArray(wrappedValue: [])
    _deletingSoon = ADELossyArray(wrappedValue: [])
    self.checkedAt = checkedAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    _lanes = c.lenient(ADELossyArray<CloudLaneOverview>.self, forKey: .lanes) ?? ADELossyArray(wrappedValue: [])
    _sessions = c.lenient(ADELossyArray<CloudSessionRow>.self, forKey: .sessions) ?? ADELossyArray(wrappedValue: [])
    _git = c.lenient(ADELossyArray<CloudGitSummaryCounts>.self, forKey: .git) ?? ADELossyArray(wrappedValue: [])
    _deletingSoon = c.lenient(ADELossyArray<DeletingSoon>.self, forKey: .deletingSoon) ?? ADELossyArray(wrappedValue: [])
    checkedAt = c.lenient(Double.self, forKey: .checkedAt) ?? 0
  }
}

/// The CTO's account copy (`GET /cloud/cto?origin=`): what its home saved
/// after its last turn.
struct CloudCtoCopy: Decodable, Equatable {
  struct Routine: Decodable, Equatable {
    let title: String
    let cron: String
    let paused: Bool

    private enum CodingKeys: String, CodingKey { case title, cron, paused }

    init(title: String, cron: String, paused: Bool) {
      self.title = title
      self.cron = cron
      self.paused = paused
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      title = c.lenient(String.self, forKey: .title) ?? "Routine"
      cron = c.lenient(String.self, forKey: .cron) ?? ""
      paused = c.lenient(Bool.self, forKey: .paused) ?? false
    }
  }

  let ownerName: String?
  let savedAt: String?
  let projectNotes: String
  let userNotes: String
  let openWork: String?
  @ADELossyArray var routines: [Routine]
  let tail: String
  let tailTruncated: Bool
  let storySummary: String?

  private enum CodingKeys: String, CodingKey { case ownerName, savedAt, projectNotes, userNotes, openWork, routines, tail, tailTruncated, story }
  private struct Story: Decodable { let summary: String? }

  init(
    ownerName: String?, savedAt: String?, projectNotes: String, userNotes: String, openWork: String?,
    routines: [Routine], tail: String, tailTruncated: Bool, storySummary: String?
  ) {
    self.ownerName = ownerName
    self.savedAt = savedAt
    self.projectNotes = projectNotes
    self.userNotes = userNotes
    self.openWork = openWork
    _routines = ADELossyArray(wrappedValue: routines)
    self.tail = tail
    self.tailTruncated = tailTruncated
    self.storySummary = storySummary
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    ownerName = c.lenient(String.self, forKey: .ownerName)
    savedAt = c.lenient(String.self, forKey: .savedAt)
    projectNotes = c.lenient(String.self, forKey: .projectNotes) ?? ""
    userNotes = c.lenient(String.self, forKey: .userNotes) ?? ""
    openWork = c.lenient(String.self, forKey: .openWork)
    _routines = c.lenient(ADELossyArray<Routine>.self, forKey: .routines) ?? ADELossyArray(wrappedValue: [])
    tail = c.lenient(String.self, forKey: .tail) ?? ""
    tailTruncated = c.lenient(Bool.self, forKey: .tailTruncated) ?? false
    storySummary = c.lenient(Story.self, forKey: .story)?.summary.flatMap { nonEmptyTrimmed($0) }
  }
}

struct CloudCtoCopySummary: Decodable, Equatable {
  /// False: no copy for this repository yet, or one this ADE can't read.
  let available: Bool
  let copy: CloudCtoCopy?

  init(available: Bool, copy: CloudCtoCopy?) {
    self.available = available
    self.copy = copy
  }

  private enum CodingKeys: String, CodingKey { case available, copy }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    copy = c.lenient(CloudCtoCopy.self, forKey: .copy)
    available = (c.lenient(Bool.self, forKey: .available) ?? false) && copy != nil
  }
}

/// What an unattended agent may spend (`GET /cloud/limits`), with the
/// revision a write names in `ifRevision`.
struct CloudAgentLimitsState: Decodable, Equatable {
  struct Limits: Decodable, Equatable {
    let unattendedSpend: Bool
    let machinesPerDay: Int
    let maxShape: String
    let extraDiskMonthCents: Int?

    private enum CodingKeys: String, CodingKey { case unattendedSpend, machinesPerDay, maxShape, extraDiskMonthCents }

    init(unattendedSpend: Bool, machinesPerDay: Int, maxShape: String, extraDiskMonthCents: Int?) {
      self.unattendedSpend = unattendedSpend
      self.machinesPerDay = machinesPerDay
      self.maxShape = maxShape
      self.extraDiskMonthCents = extraDiskMonthCents
    }

    init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      unattendedSpend = c.lenient(Bool.self, forKey: .unattendedSpend) ?? true
      machinesPerDay = c.lenient(Int.self, forKey: .machinesPerDay) ?? 3
      maxShape = c.lenient(String.self, forKey: .maxShape) ?? "4x16"
      extraDiskMonthCents = c.lenient(Int.self, forKey: .extraDiskMonthCents)
    }
  }

  let limits: Limits
  let revision: String?

  private enum CodingKeys: String, CodingKey { case limits, revision }

  init(limits: Limits, revision: String?) {
    self.limits = limits
    self.revision = revision
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    limits = try c.decode(Limits.self, forKey: .limits)
    revision = c.lenient(String.self, forKey: .revision)
  }

  /// The three levels the desktop names (`CLOUD_LIMITS_PRESETS` in `shared/adeCloud.ts`).
  static let presets: [String: Limits] = [
    "ask": Limits(unattendedSpend: false, machinesPerDay: 1, maxShape: "4x8", extraDiskMonthCents: nil),
    "balanced": Limits(unattendedSpend: true, machinesPerDay: 3, maxShape: "4x16", extraDiskMonthCents: nil),
    "hands_off": Limits(unattendedSpend: true, machinesPerDay: 10, maxShape: "4x32", extraDiskMonthCents: nil),
  ]

  /// The level these limits match, or `custom` (`cloudLimitsPresetOf`).
  var preset: String {
    Self.presets.first { $0.value == limits }?.key ?? "custom"
  }

  /// The limits as the Settings screen shows them.
  var phoneLimits: CloudPhoneLimits {
    CloudPhoneLimits(
      unattendedSpend: limits.unattendedSpend,
      machinesPerDay: limits.machinesPerDay,
      maxShape: limits.maxShape,
      preset: preset,
      extraDiskMonthCents: limits.extraDiskMonthCents
    )
  }
}

/// A Linear answer the server read with the project's own Linear connection.
struct CloudLinearAnswer {
  /// Linear's own `data` for the op's document.
  let data: [String: Any]
  let authMode: String?
}

// MARK: - Client

extension CloudServerClient {
  private func decodeAtRest<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do { return try JSONDecoder().decode(type, from: data) } catch { throw Failure.unreadable }
  }

  private func jsonObject(_ data: Data) throws -> [String: Any] {
    guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { throw Failure.unreadable }
    return object
  }

  /// One project's ADE Cloud view (`github.com/owner/repo`). Never wakes.
  func projectOverview(origin: String) async throws -> CloudProjectOverview {
    try decodeAtRest(
      CloudProjectOverview.self,
      from: try await send("GET", "cloud/projects/overview", query: [URLQueryItem(name: "origin", value: origin)], timeout: 20)
    )
  }

  /// One lane's Git summary, with its changed files.
  func gitSummary(machineKey: String, laneId: String) async throws -> CloudGitSummary {
    try decodeAtRest(CloudGitSummary.self, from: try await send("GET", "cloud/git/\(segment(machineKey))/\(segment(laneId))"))
  }

  /// The copy of one CLI or shell session.
  func sessionCopy(machineKey: String, sessionId: String) async throws -> CloudSessionCopy {
    try decodeAtRest(
      CloudSessionCopy.self,
      from: try await send("GET", "cloud/sessions/\(segment(machineKey))/\(segment(sessionId))", timeout: 30)
    )
  }

  /// The project's CTO account copy.
  func ctoCopy(origin: String) async throws -> CloudCtoCopySummary {
    try decodeAtRest(CloudCtoCopySummary.self, from: try await send("GET", "cloud/cto", query: [URLQueryItem(name: "origin", value: origin)]))
  }

  func agentLimits() async throws -> CloudAgentLimitsState {
    try decodeAtRest(CloudAgentLimitsState.self, from: try await send("GET", "cloud/limits"))
  }

  /// Changes only the fields sent. A write that names an older revision is
  /// refused with `limits_changed` (409): another device changed them first.
  func setAgentLimits(_ changes: [String: Any], ifRevision: String?) async throws -> CloudAgentLimitsState {
    let body = try JSONSerialization.data(withJSONObject: ["limits": changes, "ifRevision": ifRevision.map { $0 as Any } ?? NSNull()])
    return try decodeAtRest(CloudAgentLimitsState.self, from: try await send("PUT", "cloud/limits", body: body))
  }

  /// One fixed Linear read (`CLOUD_LINEAR_OPS`) with the project's Linear connection.
  func linearQuery(origin: String, op: String, vars: [String: Any] = [:]) async throws -> CloudLinearAnswer {
    let body = try JSONSerialization.data(withJSONObject: ["origin": origin, "op": op, "vars": vars])
    let object = try jsonObject(try await send("POST", "cloud/integrations/linear/query", body: body, timeout: 20))
    guard let data = object["data"] as? [String: Any] else { throw Failure.unreadable }
    return CloudLinearAnswer(data: data, authMode: object["authMode"] as? String)
  }

  /// A Jira search with the project's Jira connection. Jira's own issue objects.
  func jiraSearch(origin: String, jql: String, maxResults: Int = 25, nextPageToken: String? = nil) async throws -> (siteUrl: String, issues: [[String: Any]], nextPageToken: String?) {
    let body = try JSONSerialization.data(withJSONObject: [
      "origin": origin, "jql": jql, "maxResults": maxResults, "nextPageToken": nextPageToken ?? NSNull(),
    ])
    let object = try jsonObject(try await send("POST", "cloud/integrations/jira/search", body: body, timeout: 20))
    return (
      object["siteUrl"] as? String ?? "",
      object["issues"] as? [[String: Any]] ?? [],
      (object["nextPageToken"] as? String).flatMap { nonEmptyTrimmed($0) }
    )
  }

  func jiraIssue(origin: String, key: String) async throws -> (siteUrl: String, issue: [String: Any]) {
    let body = try JSONSerialization.data(withJSONObject: ["origin": origin, "key": key])
    let object = try jsonObject(try await send("POST", "cloud/integrations/jira/issue", body: body, timeout: 20))
    guard let issue = object["issue"] as? [String: Any] else { throw Failure.unreadable }
    return (object["siteUrl"] as? String ?? "", issue)
  }
}

// MARK: - Store

/// The phone's copies of the at-rest reads, per account. Reads ride the
/// existing triggers (the account server read on sign-in and on the app's
/// return to the front, a screen that opens). No timer.
@MainActor
final class CloudAtRestStore: ObservableObject {
  static let shared = CloudAtRestStore()

  /// A read of a route an older server does not have, or one that failed.
  enum Read<T: Equatable>: Equatable {
    case loaded(T)
    /// 404: an older server, or nothing saved. The screen shows what it showed before.
    case missing
    case failed(String)
  }

  private static let overviewFloor: TimeInterval = 15
  private static let summaryFloor: TimeInterval = 15

  /// The overview of each project the phone read, by origin.
  @Published private(set) var overviews: [String: CloudProjectOverview] = [:]
  /// Lane Git summaries by `machineKey|laneId`.
  @Published private(set) var summaries: [String: Read<CloudGitSummary>] = [:]
  private var overviewReadAt: [String: Date] = [:]
  private var summaryReadAt: [String: Date] = [:]
  /// Bumped on an account change: an answer for the last account drops.
  private var generation = 0

  private init() {}

  func reset() {
    generation += 1
    overviews = [:]
    summaries = [:]
    overviewReadAt = [:]
    summaryReadAt = [:]
  }

  static func summaryKey(machineKey: String, laneId: String) -> String {
    "\(machineKey.lowercased())|\(laneId)"
  }

  /// Every saved CLI and shell copy of one computer, newest first.
  func sessions(machineKey: String) -> [CloudSessionRow] {
    let key = machineKey.lowercased()
    return overviews.values
      .flatMap(\.sessions)
      .filter { $0.machineKey.lowercased() == key }
      .sorted { $0.updatedAt > $1.updatedAt }
  }

  /// The machine keys with saved CLI or shell copies.
  var sessionMachineKeys: Set<String> {
    Set(overviews.values.flatMap(\.sessions).map(\.machineKey))
  }

  /// The saved copy behind a Work row id (`cloudSessionCopyRowId`).
  func session(rowId: String) -> CloudSessionRow? {
    guard let ref = cloudSessionCopyRef(rowId: rowId) else { return nil }
    return sessions(machineKey: ref.machineKey).first { $0.sessionId == ref.sessionId }
  }

  /// The overview's lane row, when the project was read.
  func lane(machineKey: String?, laneId: String) -> CloudLaneOverview? {
    for overview in overviews.values {
      if let lane = overview.lanes.first(where: {
        $0.laneId == laneId && (machineKey == nil || $0.machineKey?.lowercased() == machineKey?.lowercased())
      }) { return lane }
    }
    return nil
  }

  /// Reads one project's overview, unless it was read in the last 15 s. A
  /// 404 (an older server) keeps the last answer and today's reads.
  func refreshOverview(origin: String, client: CloudServerClient, force: Bool = false) async {
    let origin = origin.lowercased()
    if !force, let at = overviewReadAt[origin], Date().timeIntervalSince(at) < Self.overviewFloor { return }
    overviewReadAt[origin] = Date()
    let started = generation
    do {
      let overview = try await client.projectOverview(origin: origin)
      guard started == generation else { return }
      overviews[origin] = overview
    } catch CloudServerClient.Failure.noAccess {
      // An older server: nothing new to show, and nothing taken away.
    } catch {
      cloudAtRestLog.error("cloud_at_rest read=overview failed error=\(String(describing: error), privacy: .public)")
    }
  }

  /// One lane's Git summary, read at most every 15 s.
  func refreshSummary(machineKey: String, laneId: String, using sync: SyncService, force: Bool = false) async {
    let key = Self.summaryKey(machineKey: machineKey, laneId: laneId)
    if !force, let at = summaryReadAt[key], Date().timeIntervalSince(at) < Self.summaryFloor, summaries[key] != nil { return }
    #if DEBUG
    if isFixture { return }
    #endif
    summaryReadAt[key] = Date()
    let started = generation
    guard let client = await sync.cloudServerClient() else {
      summaries[key] = .failed("Sign in to ADE to read this lane's saved Git state.")
      return
    }
    do {
      let summary = try await client.gitSummary(machineKey: machineKey, laneId: laneId)
      guard started == generation else { return }
      summaries[key] = .loaded(summary)
    } catch CloudServerClient.Failure.noAccess {
      guard started == generation else { return }
      summaries[key] = .missing
    } catch {
      guard started == generation else { return }
      cloudAtRestLog.error("cloud_at_rest read=git_summary failed error=\(String(describing: error), privacy: .public)")
      if case .loaded = summaries[key] { return }
      summaries[key] = .failed(cloudServerFailureMessage(error))
    }
  }

  func summary(machineKey: String, laneId: String) -> Read<CloudGitSummary>? {
    summaries[Self.summaryKey(machineKey: machineKey, laneId: laneId)]
  }

  #if DEBUG
  private(set) var isFixture = false
  /// Fixture screens hold their data and read nothing.
  func seedPreview(origin: String, overview: CloudProjectOverview, summaries: [CloudGitSummary]) {
    isFixture = true
    overviews[origin.lowercased()] = overview
    for summary in summaries {
      self.summaries[Self.summaryKey(machineKey: summary.machineKey, laneId: summary.laneId)] = .loaded(summary)
    }
  }
  #endif
}

// MARK: - Work row ids of saved copies

private let cloudSessionCopyRowPrefix = "cloud-copy:"

/// The Work row id of a saved CLI or shell copy. Never a live session id,
/// so a tap opens the copy and never a terminal.
func cloudSessionCopyRowId(machineKey: String, sessionId: String) -> String {
  "\(cloudSessionCopyRowPrefix)\(machineKey)|\(sessionId)"
}

func cloudSessionCopyRef(rowId: String) -> (machineKey: String, sessionId: String)? {
  guard rowId.hasPrefix(cloudSessionCopyRowPrefix) else { return nil }
  let rest = rowId.dropFirst(cloudSessionCopyRowPrefix.count)
  guard let bar = rest.firstIndex(of: "|") else { return nil }
  let machineKey = String(rest[..<bar])
  let sessionId = String(rest[rest.index(after: bar)...])
  guard !machineKey.isEmpty, !sessionId.isEmpty else { return nil }
  return (machineKey, sessionId)
}

// MARK: - The project's address on the account server

extension SyncService {
  /// The open project as the account server names it (`github.com/owner/repo`,
  /// lower case): the account project's, else the folder's own repository.
  /// Nil when the project has no GitHub repository.
  var cloudProjectOrigin: String? {
    if let project = activeAccountProjectForCloud {
      return "\(project.host)/\(project.owner)/\(project.name)".lowercased()
    }
    guard let owner = nonEmptyTrimmed(activeProject?.repoOwner), let name = nonEmptyTrimmed(activeProject?.repoName) else { return nil }
    return "github.com/\(owner)/\(name)".lowercased()
  }

  /// The fleet key of an ADE Cloud computer by its account machine key: the
  /// account's machine, else the saved key of one that left the account.
  func cloudFleetKey(accountMachineKey: String) -> String {
    if let machine = AccountService.shared.machines.first(where: { $0.machineKey.lowercased() == accountMachineKey.lowercased() }),
       let deviceId = nonEmptyTrimmed(machine.deviceId) {
      return HiddenMachineStore.fleetKey(deviceId: deviceId)
    }
    return cloudSavedFleetKey(accountMachineKey: accountMachineKey)
  }

  /// Settings › ADE Cloud shows: a connected computer runs the page, or the
  /// phone reads the account server itself with its own sign-in.
  var cloudSettingsOffered: Bool {
    if cloudAvailable && cloudSupported { return true }
    return CloudPaneStore.readsDirect(self) && AccountService.shared.isSignedIn
  }

  /// The open project's GitHub repository, for direct GitHub reads.
  var cloudProjectRepo: GitHubDirectRepoRef? {
    if let project = activeAccountProjectForCloud, project.host == "github.com" {
      return GitHubDirectRepoRef(owner: project.owner, name: project.name)
    }
    return GitHubDirectRepoRef(owner: activeProject?.repoOwner, name: activeProject?.repoName)
  }
}
