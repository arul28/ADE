import Foundation

// The account server's ADE Cloud routes, called by the phone with its own
// account sign-in. No connected computer is needed: the phone reads the
// account's cloud lanes, their saved chats and their state here, and asks the
// server to wake a computer or to hold a message for one. The desktop and the
// web call the same routes (`apps/account-directory/src/cloud/contract.ts`,
// `apps/desktop/src/shared/cloudApiClient.ts`).
//
// Every decode is lenient: a field a newer server adds or changes drops alone.
// A new route that an older server does not have answers 404, which the
// caller treats as "use today's path", never as an empty list.

/// ADE Cloud as one machine (`apps/desktop/src/shared/adeCloudMachine.ts`).
/// Every account always has it. The person never sees a cloud computer's
/// own name or instance id; routing still names each lane's own computer.
enum ADECloudMachine {
  /// The reserved machine id the pickers use for "ADE Cloud".
  static let id = "__ade_cloud__"
  static let name = "ADE Cloud"
  static let symbol = "cloud"
  /// Fleet keys of saved chats whose computer left the account.
  static let savedFleetKeyPrefix = "cloud-saved:"
}

/// The refusal codes the server sends with a sentence (`CLOUD_REFUSAL_CODES`
/// in contract.ts). The phone always shows the server's sentence; the code
/// only decides the state (for example "out of hours" keeps reading on).
enum CloudRefusalCode {
  static let all: Set<String> = [
    "account_blocked", "out_of_hours", "over_plan_disk", "too_many_awake",
    "computer_deleting", "computer_deleted", "unavailable", "update_in_progress",
    "update_needed", "computer_busy", "creates_paused", "rate_limited",
    "needs_paid_plan", "disk_limit", "over_plan_limits", "git_credential_missing",
    "github_app_not_installed", "template_unset", "template_unavailable",
    "linear_needs_renewal", "plan_past_due", "too_many_messages", "message_taken",
  ]

  /// Refusals of the Linear, Jira and limits routes (`CLOUD_INTEGRATION_ERROR_CODES`,
  /// `limits_changed`). Each comes with the sentence to show; none is a
  /// reason to stop other ADE Cloud work.
  static let reads: Set<String> = [
    "linear_not_connected", "linear_renewing", "jira_not_connected", "jira_site_unsupported",
    "integration_failed", "limits_changed",
  ]
}

/// One ADE Cloud computer as the account server lists it.
struct CloudServerInstance: Decodable, Equatable {
  let id: String
  let name: String?
  let status: String
  let pastDue: Bool
  /// The computer saves its work for an idle cleanup now: a wake is still
  /// needed even when `status` reads running (`idleSaving`, newer servers).
  let idleSaving: Bool
  let metadata: [String: String]
  /// Its lane's work as it last read it while awake (`laneWork`); nil before
  /// its first report and from older servers.
  let laneWork: CloudPhoneMachine.LaneWork?
  /// `vm` for a full computer; anything else is a standard one.
  let type: String?
  /// Its CPU, memory (GB) and disk (GB); nil when the server doesn't say.
  let resources: Resources?
  /// When it last did work, else when it was last awake (ms); when it was made (s).
  let lastActiveAt: Double?
  let created: Double?
  /// What uses its disk, as it last measured while awake.
  let diskUsage: CloudPhoneMachine.DiskUsage?
  /// The image it runs (`ade@N`), its channel's current image, and `updating`
  /// or `failed` while an update isn't settled. Older servers leave them out.
  let templateVersion: String?
  let targetTemplate: String?
  let updateState: String?

  struct Resources: Decodable, Equatable {
    let cpu: Int
    let memory: Double
    let disk: Double
  }

  private enum CodingKeys: String, CodingKey {
    case id, name, status, pastDue, idleSaving, metadata, laneWork, type, resources, lastActiveAt, created, diskUsage
    case templateVersion, targetTemplate, updateState
  }

  init(id: String, name: String?, status: String, pastDue: Bool, idleSaving: Bool = false, metadata: [String: String], laneWork: CloudPhoneMachine.LaneWork? = nil) {
    self.id = id
    self.name = name
    self.status = status
    self.pastDue = pastDue
    self.idleSaving = idleSaving
    self.metadata = metadata
    self.laneWork = laneWork
    type = nil
    resources = nil
    lastActiveAt = nil
    created = nil
    diskUsage = nil
    templateVersion = nil
    targetTemplate = nil
    updateState = nil
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = c.lenient(String.self, forKey: .name)
    status = c.lenient(String.self, forKey: .status) ?? ""
    pastDue = c.lenient(Bool.self, forKey: .pastDue) ?? false
    idleSaving = c.lenient(Bool.self, forKey: .idleSaving) ?? false
    metadata = c.lenient([String: String].self, forKey: .metadata) ?? [:]
    laneWork = c.lenient(CloudPhoneMachine.LaneWork.self, forKey: .laneWork)
    type = c.lenient(String.self, forKey: .type)
    resources = c.lenient(Resources.self, forKey: .resources)
    lastActiveAt = c.lenient(Double.self, forKey: .lastActiveAt)
    created = c.lenient(Double.self, forKey: .created)
    diskUsage = c.lenient(CloudPhoneMachine.DiskUsage.self, forKey: .diskUsage)
    templateVersion = c.lenient(String.self, forKey: .templateVersion)
    targetTemplate = c.lenient(String.self, forKey: .targetTemplate)
    updateState = c.lenient(String.self, forKey: .updateState)
  }

  /// Its channel has a newer image and no update is under way: Update moves it there.
  var updateBehind: Bool {
    guard let target = targetTemplate.flatMap({ nonEmptyTrimmed($0) }) else { return false }
    return target != templateVersion && updateState != "updating"
  }

  private func fact(_ key: String) -> String? {
    metadata[key].flatMap { nonEmptyTrimmed($0) }
  }

  /// The ADE machine on it (`ade_machine_key`), once that machine joined.
  var machineKey: String? { fact("ade_machine_key") }
  /// The lane it was made for (`ade_lane_id`, `ade_lane_name`), if any.
  var laneId: String? { fact("ade_lane_id") }
  var laneName: String? { fact("ade_lane_name") }
  var laneBranch: String? { fact("ade_lane_branch") }
  /// The lane's project (`github.com/owner/repo`).
  var projectOrigin: String? { fact("ade_project_origin")?.lowercased() }
  var isAwake: Bool { status == "running" && !idleSaving }
  /// Already starting: its ADE answers soon, with no wake of its own.
  var isComingUp: Bool { status == "starting" || status == "waking" }
  var isGone: Bool { status == "deleted" }
  /// Asleep or stopped: not running, not coming up, not deleted.
  var isResting: Bool { status != "running" && !isComingUp && !isGone }
}

/// Whether the computer that saved a chat still exists (`CloudChatComputer`).
struct CloudSavedChatComputer: Decodable, Equatable {
  let state: String
  let deletedAt: Double?
  let reason: String?

  var isDeleted: Bool { state == "deleted" }
}

/// The server's saved copy of one chat of an ADE Cloud computer.
struct CloudSavedChatRow: Decodable, Equatable {
  let machineKey: String
  let chatId: String
  let instanceId: String?
  let title: String?
  let laneId: String?
  let laneName: String?
  let status: String?
  let toolType: String?
  let provider: String?
  let model: String?
  /// The repository (`github.com/owner/repo`).
  let projectKey: String?
  /// The computer's own id and folder for the project.
  let projectId: String?
  let projectRoot: String?
  let lastActivityAt: String?
  /// The newest part the server holds.
  let lastSeq: Int
  /// When the computer last saved it (ms).
  let updatedAt: Double
  /// Nil from an older server, or when the server has no row for the computer.
  let computer: CloudSavedChatComputer?
  /// The chat a subagent chat belongs to, and how it was made (newer servers).
  let parentChatId: String?
  let spawnKind: String?

  private enum CodingKeys: String, CodingKey {
    case machineKey, chatId, instanceId, title, laneId, laneName, status, toolType, provider, model
    case projectKey, projectId, projectRoot, lastActivityAt, lastSeq, updatedAt, computer, parentChatId, spawnKind
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    machineKey = try c.decode(String.self, forKey: .machineKey)
    chatId = try c.decode(String.self, forKey: .chatId)
    instanceId = c.lenient(String.self, forKey: .instanceId)
    title = c.lenient(String.self, forKey: .title)
    laneId = c.lenient(String.self, forKey: .laneId)
    laneName = c.lenient(String.self, forKey: .laneName)
    status = c.lenient(String.self, forKey: .status)
    toolType = c.lenient(String.self, forKey: .toolType)
    provider = c.lenient(String.self, forKey: .provider)
    model = c.lenient(String.self, forKey: .model)
    projectKey = c.lenient(String.self, forKey: .projectKey)
    projectId = c.lenient(String.self, forKey: .projectId)
    projectRoot = c.lenient(String.self, forKey: .projectRoot)
    lastActivityAt = c.lenient(String.self, forKey: .lastActivityAt)
    lastSeq = c.lenient(Int.self, forKey: .lastSeq) ?? 0
    updatedAt = c.lenient(Double.self, forKey: .updatedAt) ?? 0
    computer = c.lenient(CloudSavedChatComputer.self, forKey: .computer)
    parentChatId = c.lenient(String.self, forKey: .parentChatId)
    spawnKind = c.lenient(String.self, forKey: .spawnKind)
  }
}

/// One page of a saved chat (`CloudChatTranscriptPage`): newest part first,
/// each part JSON lines of chat events.
struct CloudChatTranscriptPage: Decodable {
  struct Part: Decodable {
    let seq: Int
    let text: String
  }
  let parts: [Part]
  let hasMore: Bool
  let nextBefore: Int?

  private enum CodingKeys: String, CodingKey { case parts, hasMore, nextBefore }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    parts = c.lenient([Part].self, forKey: .parts) ?? []
    hasMore = c.lenient(Bool.self, forKey: .hasMore) ?? false
    nextBefore = c.lenient(Int.self, forKey: .nextBefore)
  }
}

/// A lane whose computer is gone while the lane stays (`CloudLaneWithoutComputer`).
/// One lane backup (`CloudLaneBackup` in contract.ts), as the phone shows and downloads it.
struct CloudLaneBackupRow: Decodable, Equatable, Identifiable {
  let machineKey: String
  let laneId: String
  let laneName: String?
  let branchRef: String?
  let commits: Int
  let files: Int
  let snapshotSha: String?
  let patchParts: Int
  let patchBytes: Int
  let savedAt: Double
  var id: String { "\(machineKey)/\(laneId)" }

  /// The same words as the desktop (`CloudLaneSavedWork.tsx`).
  var sentence: String {
    var parts: [String] = []
    if commits > 0 { parts.append("\(commits) \(commits == 1 ? "commit" : "commits")") }
    if snapshotSha != nil { parts.append(files > 0 ? "\(files) uncommitted \(files == 1 ? "file" : "files")" : "uncommitted changes") }
    let when = Date(timeIntervalSince1970: savedAt / 1000).formatted(date: .abbreviated, time: .shortened)
    return "ADE Cloud saved this lane's work that isn't on GitHub (\(parts.isEmpty ? "its changes" : parts.joined(separator: " and "))) on \(when)."
  }
}

private struct LaneBackupList: Decodable { let backups: [CloudLaneBackupRow] }

struct CloudLaneWithoutComputer: Decodable, Equatable, Identifiable {
  let laneId: String
  let laneName: String
  let projectOrigin: String?
  let branchRef: String?
  /// `freed`, `idle_cleanup`, `plan_limit` or `inactive`.
  let reason: String?
  /// The size the old computer had (`default` or `vm`, CPU, memory).
  let type: String?
  let cpu: Int?
  let memoryGb: Double?
  /// The old computer's machine key: the lane's saved chats are filed under it.
  let formerMachineKey: String?
  /// The old computer's instance id: a launch that made it is over.
  let formerInstanceId: String?
  /// When the computer went (ms).
  let since: Double?

  var id: String { laneId }
  /// The branch without its remote's name (`ade/x`, never `origin/ade/x`).
  var branchName: String? {
    guard let ref = branchRef.flatMap({ nonEmptyTrimmed($0) }) else { return nil }
    return ref.hasPrefix("origin/") ? String(ref.dropFirst("origin/".count)) : ref
  }

  private enum CodingKeys: String, CodingKey { case laneId, laneName, projectOrigin, branchRef, reason, type, cpu, memoryGb, formerMachineKey, formerInstanceId, since }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    laneId = try c.decode(String.self, forKey: .laneId)
    laneName = c.lenient(String.self, forKey: .laneName) ?? "Cloud lane"
    projectOrigin = c.lenient(String.self, forKey: .projectOrigin)?.lowercased()
    branchRef = c.lenient(String.self, forKey: .branchRef)
    reason = c.lenient(String.self, forKey: .reason)
    type = c.lenient(String.self, forKey: .type)
    cpu = c.lenient(Int.self, forKey: .cpu)
    memoryGb = c.lenient(Double.self, forKey: .memoryGb)
    formerMachineKey = c.lenient(String.self, forKey: .formerMachineKey)
    formerInstanceId = c.lenient(String.self, forKey: .formerInstanceId)
    since = c.lenient(Double.self, forKey: .since)
  }
}

/// A message the server holds for an existing cloud chat until its computer
/// is up (`CloudChatQueuedMessage`, contract §3.1).
struct CloudChatQueuedMessage: Decodable, Equatable {
  let messageId: String
  let seq: Int?
  /// `queued`, `sending`, `waiting_for_sign_in`, `delivered`, `failed` or `cancelled`.
  let state: String
  let text: String?
  let signIn: CloudLaunchSignIn?
  let error: String?
  let createdAt: Double?
  let updatedAt: Double?

  private enum CodingKeys: String, CodingKey { case messageId, seq, state, text, signIn, error, createdAt, updatedAt }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    messageId = try c.decode(String.self, forKey: .messageId)
    seq = c.lenient(Int.self, forKey: .seq)
    state = c.lenient(String.self, forKey: .state) ?? "queued"
    text = c.lenient(String.self, forKey: .text)
    signIn = c.lenient(CloudLaunchSignIn.self, forKey: .signIn)
    error = c.lenient(String.self, forKey: .error)
    createdAt = c.lenient(Double.self, forKey: .createdAt)
    updatedAt = c.lenient(Double.self, forKey: .updatedAt)
  }

  init(messageId: String, state: String, text: String?, signIn: CloudLaunchSignIn? = nil, error: String? = nil) {
    self.messageId = messageId
    seq = nil
    self.state = state
    self.text = text
    self.signIn = signIn
    self.error = error
    createdAt = nil
    updatedAt = nil
  }

  /// Still on its way to the chat.
  var isOpen: Bool { state == "queued" || state == "sending" || state == "waiting_for_sign_in" }
  /// Open and not waiting for the person: the server moves it on its own.
  var isMoving: Bool { state == "queued" || state == "sending" }
}

/// The server's answer to a queued send: the message and what the wake did.
struct CloudChatQueueResult: Decodable {
  struct Wake: Decodable {
    /// `awake`, `waking` or `launching` (the computer was deleted: a new one forks the chat).
    let state: String
    let launchId: String?
  }
  let message: CloudChatQueuedMessage
  let wake: Wake?
}

/// The account server's ADE Cloud routes: one bearer, a 12-second timeout
/// (a wake waits longer), one retry after a 401 with a fresh token.
struct CloudServerClient {
  enum Failure: Error, Equatable {
    /// 404: the account has no ADE Cloud, the row is gone, or (on a new
    /// route) the server is older than this app. A caller of a new route
    /// falls back to today's path on it.
    case noAccess
    case unauthorized
    /// The server refused the action and said why (`account_blocked`,
    /// `out_of_hours`, `too_many_awake`, …). `message` is the sentence to show.
    case refused(code: String, message: String)
    case server(Int, message: String?)
    case transport
    case unreadable
  }

  var baseURL: URL
  var token: String
  var refreshToken: (() async -> String?)?
  var session: URLSession = .adeAccount

  private struct InstanceList: Decodable { let data: [CloudServerInstance] }
  private struct ChatList: Decodable {
    let chats: [CloudSavedChatRow]
    let nextCursor: String?
  }
  private struct LanesWithoutComputer: Decodable { let lanes: [CloudLaneWithoutComputer] }
  private struct QueuedMessageList: Decodable { let messages: [CloudChatQueuedMessage] }

  func instances() async throws -> [CloudServerInstance] {
    try decode(InstanceList.self, from: try await send("GET", "cloud/instances")).data
  }

  /// The saved chats, newest first, one page at a time. `project` narrows
  /// them to one repository (`github.com/owner/repo`).
  func savedChatsPage(project: String? = nil, cursor: String? = nil, limit: Int = 200) async throws -> (chats: [CloudSavedChatRow], nextCursor: String?) {
    var query = [URLQueryItem(name: "limit", value: String(limit))]
    if let project { query.append(URLQueryItem(name: "project", value: project)) }
    if let cursor { query.append(URLQueryItem(name: "cursor", value: cursor)) }
    let page = try decode(ChatList.self, from: try await send("GET", "cloud/chats", query: query))
    return (page.chats, page.nextCursor.flatMap { nonEmptyTrimmed($0) })
  }

  /// The saved chats, page by page, up to `maxPages` pages (so one account
  /// with a very long history can't hold the phone in one read).
  func savedChats(project: String? = nil, maxPages: Int = 5) async throws -> [CloudSavedChatRow] {
    var all: [CloudSavedChatRow] = []
    var cursor: String?
    for _ in 0..<maxPages {
      let page = try await savedChatsPage(project: project, cursor: cursor)
      all += page.chats
      guard let next = page.nextCursor, next != cursor else { break }
      cursor = next
    }
    return all
  }

  /// One page of a saved chat, newest first. `limit` parts (one part can be
  /// megabytes, so the phone asks for one at a time).
  func transcriptPage(machineKey: String, chatId: String, before: Int? = nil, limit: Int = 1) async throws -> CloudChatTranscriptPage {
    var query = [URLQueryItem(name: "limit", value: String(limit))]
    if let before { query.append(URLQueryItem(name: "before", value: String(before))) }
    return try decode(
      CloudChatTranscriptPage.self,
      from: try await send("GET", "cloud/chats/\(segment(machineKey))/\(segment(chatId))", query: query, timeout: 30)
    )
  }

  func account() async throws -> CloudPhoneAccount {
    try decode(CloudPhoneAccount.self, from: try await send("GET", "cloud/account"))
  }

  func lanesWithoutComputer() async throws -> [CloudLaneWithoutComputer] {
    try decode(LanesWithoutComputer.self, from: try await send("GET", "cloud/lanes/without-computer")).lanes
  }

  /// Stops listing a lane kept without a computer and deletes its saved work
  /// (`DELETE /cloud/lanes/without-computer/:lane`). Its chats are deleted on
  /// their own (`deleteSavedChats`); its branch stays on GitHub.
  func forgetLaneWithoutComputer(laneId: String) async throws {
    _ = try await send("DELETE", "cloud/lanes/without-computer/\(segment(laneId))")
  }

  /// The lane's saved work that isn't on GitHub (`laneBackups.ts`), newest first. Reads with no wake and no hours.
  func laneBackups(laneId: String) async throws -> [CloudLaneBackupRow] {
    try decode(LaneBackupList.self, from: try await send("GET", "cloud/backups", query: [URLQueryItem(name: "laneId", value: laneId)], timeout: 30)).backups
  }

  /// The backup's patch, every part, in a file in the app's temporary folder to share or save. The phone never gets the bundle.
  func laneBackupPatchFile(_ backup: CloudLaneBackupRow) async throws -> URL {
    var bytes = Data()
    for part in 1...max(1, backup.patchParts) {
      bytes.append(try await send("GET", "cloud/backups/\(segment(backup.machineKey))/\(segment(backup.laneId))/patch/\(part)", timeout: 120))
    }
    guard bytes.count == backup.patchBytes else { throw Failure.unreadable }
    let name = (backup.laneName ?? backup.branchRef ?? "lane").replacingOccurrences(of: "[^A-Za-z0-9._-]+", with: "-", options: .regularExpression)
    // Its own folder per download: two lanes with one name never share a file.
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent("\(name.prefix(60))-saved-work.patch")
    try bytes.write(to: url, options: [.atomic, .completeFileProtection])
    return url
  }

  /// Every saved lane work the account keeps (`GET /cloud/backups`), newest first.
  func allLaneBackups() async throws -> [CloudLaneBackupRow] {
    try decode(LaneBackupList.self, from: try await send("GET", "cloud/backups", timeout: 30)).backups
  }

  /// The person's delete of one lane's saved work (`POST /cloud/backups/:m/:lane/forget`).
  /// The server refuses it (409 `backup_computer_live`) while the lane's computer exists.
  func forgetLaneBackup(_ backup: CloudLaneBackupRow) async throws {
    _ = try await send("POST", "cloud/backups/\(segment(backup.machineKey))/\(segment(backup.laneId))/forget", body: Data("{}".utf8), timeout: 30)
  }

  /// Deletes a lane's computer, and with it the lane and its saved work
  /// (`DELETE /cloud/instances/:id`, a person's delete: no `who`). Needs no
  /// wake. With `keepLaneBranch` the server keeps the lane as a lane without
  /// a computer on that branch (a free, `reason: "freed"`).
  func deleteInstance(_ instanceId: String, keepLaneBranch: String? = nil) async throws {
    var payload: [String: Any] = ["reason": keepLaneBranch == nil ? "user" : "freed"]
    if let keepLaneBranch { payload["keepLane"] = ["branchRef": keepLaneBranch] }
    let body = try JSONSerialization.data(withJSONObject: payload)
    _ = try await send("DELETE", "cloud/instances/\(segment(instanceId))", body: body, timeout: 60)
  }

  /// One computer of the account (`GET /cloud/instances/:id`); `.noAccess` once it is gone.
  func instance(_ instanceId: String) async throws -> CloudServerInstance {
    try decode(CloudServerInstance.self, from: try await send("GET", "cloud/instances/\(segment(instanceId))"))
  }

  /// `POST /cloud/instances/:id/sleep`: it uses no hours until it wakes. Answers its status.
  @discardableResult
  func sleep(instanceId: String) async throws -> String {
    status(of: try await send("POST", "cloud/instances/\(segment(instanceId))/sleep", body: Data("{}".utf8), timeout: 180), or: "sleeping")
  }

  /// A person's resize (`POST /cloud/instances/:id/resize`): the computer
  /// restarts at that CPU and memory. No CPU or memory keeps the size the
  /// server has (a disk-only grow); `computerIdle` says its work is saved,
  /// which a disk grow of a running computer needs. Answers its status.
  @discardableResult
  func resize(instanceId: String, cpu: Int?, memoryGb: Double?, diskGb: Int? = nil, computerIdle: Bool = false) async throws -> String {
    var payload: [String: Any] = [:]
    if let cpu { payload["cpu"] = cpu }
    if let memoryGb { payload["memory"] = memoryGb.rounded() == memoryGb ? Int(memoryGb) as Any : memoryGb }
    if let diskGb { payload["disk"] = diskGb }
    if computerIdle { payload["computerIdle"] = true }
    let body = try JSONSerialization.data(withJSONObject: payload)
    return status(of: try await send("POST", "cloud/instances/\(segment(instanceId))/resize", body: body, timeout: 180), or: "updating")
  }

  /// Runs a shell command on the computer (`POST /cloud/instances/:id/exec`),
  /// as the desktop does for a lane's push and save. A sleeping computer
  /// wakes for it (that uses hours, and is refused at 0 hours).
  func exec(instanceId: String, command: String, timeoutMs: Int) async throws -> CloudExecResult {
    let body = try JSONSerialization.data(withJSONObject: ["command": command, "timeoutMs": timeoutMs])
    return try decode(
      CloudExecResult.self,
      from: try await send("POST", "cloud/instances/\(segment(instanceId))/exec", body: body, timeout: TimeInterval(timeoutMs) / 1000 + 10)
    )
  }

  /// `{ status }` of a lifecycle answer, or `fallback` when it says none.
  private func status(of data: Data, or fallback: String) -> String {
    struct Answer: Decodable { let status: String? }
    return (try? JSONDecoder().decode(Answer.self, from: data))?.status.flatMap { nonEmptyTrimmed($0) } ?? fallback
  }

  /// Deletes the saved chats of one lane of a computer (`DELETE /cloud/chats/:m/lanes/:lane`).
  func deleteSavedChats(machineKey: String, laneId: String) async throws {
    _ = try await send("DELETE", "cloud/chats/\(segment(machineKey))/lanes/\(segment(laneId))", timeout: 30)
  }

  /// Wakes (or starts) a computer. Answers its status: `running` once up.
  @discardableResult
  func start(instanceId: String) async throws -> String {
    status(of: try await send("POST", "cloud/instances/\(segment(instanceId))/start", body: Data("{}".utf8), timeout: 120), or: "running")
  }

  /// A person's update (`POST /cloud/instances/:id/update`): the computer
  /// moves to its channel's image and restarts on it. It wakes a sleeping one.
  func update(instanceId: String) async throws {
    _ = try await send("POST", "cloud/instances/\(segment(instanceId))/update", body: Data(#"{"reason":"manual"}"#.utf8), timeout: 120)
  }

  /// "Keep it": the idle cleanup's clock starts again, with no wake.
  func keep(instanceId: String) async throws {
    _ = try await send("POST", "cloud/instances/\(segment(instanceId))/keep", body: Data("{}".utf8))
  }

  /// Holds a message for an existing cloud chat and wakes its computer. The
  /// same `messageId` again answers the same message (the client's send id).
  /// `sizeId`: the size picked for the new computer when the chat's computer
  /// was deleted; the server ignores it for a computer that is still there.
  func queueMessage(machineKey: String, chatId: String, messageId: String, text: String, attachments: [[String: Any]] = [], sizeId: String? = nil) async throws -> CloudChatQueueResult {
    var payload: [String: Any] = ["messageId": messageId, "text": text]
    if !attachments.isEmpty { payload["attachments"] = attachments }
    if let sizeId { payload["sizeId"] = sizeId }
    let body = try JSONSerialization.data(withJSONObject: payload)
    return try decode(
      CloudChatQueueResult.self,
      from: try await send("POST", "cloud/chats/\(segment(machineKey))/\(segment(chatId))/messages", body: body, timeout: 30)
    )
  }

  /// The chat's open and recent held messages.
  func queuedMessages(machineKey: String, chatId: String) async throws -> [CloudChatQueuedMessage] {
    try decode(
      QueuedMessageList.self,
      from: try await send("GET", "cloud/chats/\(segment(machineKey))/\(segment(chatId))/messages")
    ).messages
  }

  /// Cancels a held message while it still waits.
  func cancelQueuedMessage(machineKey: String, chatId: String, messageId: String) async throws {
    _ = try await send("DELETE", "cloud/chats/\(segment(machineKey))/\(segment(chatId))/messages/\(segment(messageId))")
  }

  // MARK: Moves to the other kind (standard ↔ full computer)

  private struct MoveList: Decodable { let moves: [CloudServerMove] }

  /// Starts a move the account server runs (`POST /cloud/instances/:id/move`):
  /// a new computer of the other kind, the old one's files copied over, the
  /// old one deleted. The same `moveId` again answers the same move, so a
  /// lost answer is safe to send again. A server older than the route answers
  /// 404 (`.noAccess`): only ADE on a computer can move it then.
  func startMove(instanceId: String, to kind: String, sizeId: String?, moveId: String) async throws -> CloudServerMove {
    var payload: [String: Any] = ["moveId": moveId, "to": kind]
    if let sizeId { payload["sizeId"] = sizeId }
    let body = try JSONSerialization.data(withJSONObject: payload)
    return try decode(
      CloudServerMove.self,
      from: try await send("POST", "cloud/instances/\(segment(instanceId))/move", body: body, timeout: 30, resendOnLostConnection: true)
    )
  }

  /// One move (`GET /cloud/moves/:moveId`); `.noAccess` once the server keeps it no more.
  func move(_ moveId: String) async throws -> CloudServerMove {
    try decode(CloudServerMove.self, from: try await send("GET", "cloud/moves/\(segment(moveId))"))
  }

  /// The account's moves: running ones and those that ended in the last day.
  func moves() async throws -> [CloudServerMove] {
    try decode(MoveList.self, from: try await send("GET", "cloud/moves")).moves
  }

  /// Cancels a move before its copy starts (`DELETE /cloud/moves/:moveId`);
  /// the server refuses it later, with its sentence.
  func cancelMove(_ moveId: String) async throws {
    _ = try await send("DELETE", "cloud/moves/\(segment(moveId))", timeout: 30)
  }

  /// Frees a computer on the account server (`POST /cloud/instances/:id/free`):
  /// it pushes every lane's work, checks it again and deletes the computer,
  /// keeping its lane, with no app open. Followed here until it ends (or 15
  /// minutes). Nil from a server older than the route, so the caller runs it.
  func freeOnServer(instanceId: String) async -> CloudComputerOutcome? {
    var free: CloudServerFree
    do {
      let body = try JSONSerialization.data(withJSONObject: ["freeId": UUID().uuidString.lowercased()])
      free = try decode(CloudServerFree.self, from: try await send("POST", "cloud/instances/\(segment(instanceId))/free", body: body, timeout: 30))
    } catch Failure.noAccess {
      // The computer was read just before: a 404 is a server with no such route.
      return nil
    } catch {
      return CloudComputerOutcome(ok: false, message: cloudServerFailureMessage(error))
    }
    let deadline = Date().addingTimeInterval(15 * 60)
    while !["done", "failed", "cancelled"].contains(free.state) {
      if Date() > deadline || Task.isCancelled {
        return CloudComputerOutcome(ok: false, message: "Freeing the computer is taking a while. ADE Cloud goes on with it; check again in a few minutes.")
      }
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      if let read = try? decode(CloudServerFree.self, from: try await send("GET", "cloud/frees/\(segment(free.freeId))")) { free = read }
    }
    if free.state == "done" { return CloudComputerOutcome(ok: true, message: free.message) }
    return CloudComputerOutcome(ok: false, message: free.error ?? free.message)
  }

  /// One path segment, with `/` encoded too. Every route file uses it.
  func segment(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
  }

  /// An answer's body as `T`; a body this app can't read is `.unreadable`.
  func decode<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do { return try JSONDecoder().decode(type, from: data) } catch { throw Failure.unreadable }
  }

  /// One call to the account server; `AccountCloudLaunches.swift` adds the launch routes.
  func send(
    _ method: String,
    _ path: String,
    query: [URLQueryItem] = [],
    body: Data? = nil,
    contentType: String = "application/json",
    timeout: TimeInterval = 12,
    resendOnLostConnection: Bool = false
  ) async throws -> Data {
    var components = URLComponents(url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
    if !query.isEmpty { components?.queryItems = query }
    guard let url = components?.url else { throw Failure.transport }
    let correlationID = UUID().uuidString.lowercased()
    func once(_ bearer: String) async throws -> (Data, HTTPURLResponse) {
      var request = URLRequest(url: url)
      request.httpMethod = method
      request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.setValue(correlationID, forHTTPHeaderField: "X-ADE-Correlation-ID")
      if let body {
        request.httpBody = body
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
      }
      request.timeoutInterval = timeout
      request.cachePolicy = .reloadIgnoringLocalCacheData
      do {
        let (data, response): (Data, URLResponse)
        do {
          (data, response) = try await session.data(for: request)
        } catch let error as URLError where resendOnLostConnection && error.code == .networkConnectionLost {
          // A kept-alive connection the server already closed fails at once
          // (-1005). A caller whose route is safe to send twice sends it once
          // more, on a new connection.
          (data, response) = try await session.data(for: request)
        }
        guard let http = response as? HTTPURLResponse else { throw Failure.transport }
        return (data, http)
      } catch let failure as Failure {
        throw failure
      } catch {
        throw Failure.transport
      }
    }
    var (data, http) = try await once(token)
    if http.statusCode == 401, let refreshToken,
       let fresh = await refreshToken().flatMap({ nonEmptyTrimmed($0) }) {
      (data, http) = try await once(fresh)
    }
    if (200..<300).contains(http.statusCode) { return data }
    throw cloudServerFailure(status: http.statusCode, body: data)
  }
}

/// The failure for one error answer. A 403 or 402 with a refusal code is the
/// server saying no to the action (blocked, out of hours, over the plan), not
/// a bad sign-in: its sentence is shown as it is. Only a 401, or a 403 with
/// no refusal code, is a sign-in problem.
func cloudServerFailure(status: Int, body: Data) -> CloudServerClient.Failure {
  /// `{ error: { code, message } }` (`cloud/http.ts` `fail`).
  struct ErrorBody: Decodable {
    struct Detail: Decodable {
      let code: String?
      let message: String?
    }
    let error: Detail?
  }
  let detail = (try? JSONDecoder().decode(ErrorBody.self, from: body))?.error
  let code = detail?.code.flatMap { nonEmptyTrimmed($0) }
  let message = detail?.message.flatMap { nonEmptyTrimmed($0) }
  if status == 401 { return .unauthorized }
  if status == 404 { return .noAccess }
  if let code, CloudRefusalCode.all.contains(code) || CloudRefusalCode.reads.contains(code) {
    return .refused(code: code, message: message ?? "ADE Cloud can't do that right now.")
  }
  if status == 403 { return message.map { .refused(code: code ?? "forbidden", message: $0) } ?? .unauthorized }
  return .server(status, message: message)
}

/// A move of a computer to the other kind, as the account server runs it
/// (`CloudMoveRecord`). `message` is the one sentence to show; a state this
/// app doesn't know shows only that sentence and counts as still running.
/// A free the account server runs (`CloudFreeRecord`).
struct CloudServerFree: Decodable, Equatable {
  let freeId: String
  let instanceId: String
  /// `checking`, `pushing`, `deleting`, `done`, `failed`, `cancelled`.
  let state: String
  let message: String
  let error: String?
  let laneKept: Bool?
}

struct CloudServerMove: Decodable, Equatable, Identifiable {
  let moveId: String
  let sourceInstanceId: String
  let sourceName: String?
  let targetInstanceId: String?
  /// `standard` or `full`.
  let to: String
  let sizeId: String?
  let state: String
  let message: String
  let approvalUrl: String?
  let error: String?
  let sourceDeleted: Bool?
  let createdAt: Double?
  let updatedAt: Double?

  var id: String { moveId }

  private enum CodingKeys: String, CodingKey {
    case moveId, sourceInstanceId, sourceName, targetInstanceId, to, sizeId, state, message, approvalUrl, error, sourceDeleted, createdAt, updatedAt
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    moveId = try c.decode(String.self, forKey: .moveId)
    sourceInstanceId = c.lenient(String.self, forKey: .sourceInstanceId) ?? ""
    sourceName = c.lenient(String.self, forKey: .sourceName).flatMap { nonEmptyTrimmed($0) }
    targetInstanceId = c.lenient(String.self, forKey: .targetInstanceId).flatMap { nonEmptyTrimmed($0) }
    to = c.lenient(String.self, forKey: .to) ?? ""
    sizeId = c.lenient(String.self, forKey: .sizeId).flatMap { nonEmptyTrimmed($0) }
    state = c.lenient(String.self, forKey: .state) ?? ""
    message = c.lenient(String.self, forKey: .message).flatMap { nonEmptyTrimmed($0) } ?? ""
    approvalUrl = c.lenient(String.self, forKey: .approvalUrl).flatMap { nonEmptyTrimmed($0) }
    error = c.lenient(String.self, forKey: .error).flatMap { nonEmptyTrimmed($0) }
    sourceDeleted = c.lenient(Bool.self, forKey: .sourceDeleted)
    createdAt = c.lenient(Double.self, forKey: .createdAt)
    updatedAt = c.lenient(Double.self, forKey: .updatedAt)
  }

  /// Done, failed or cancelled: nothing more happens to it.
  var isFinished: Bool { state == "done" || state == "failed" || state == "cancelled" }
  /// The server still lets the person cancel it: its copy hasn't started.
  var canCancel: Bool { state == "making" || state == "joining" || state == "needs_approval" }
  /// The approval page, when the new computer waits for the person.
  var approval: URL? {
    guard state == "needs_approval", let approvalUrl, let url = URL(string: approvalUrl),
          url.scheme?.lowercased() == "https" else { return nil }
    return url
  }
  var toFull: Bool { to == "full" }
  /// "a full computer", "a standard computer".
  var kindWords: String { toFull ? "a full computer" : "a standard computer" }
  /// Whether it moves this computer, from it or onto it.
  func involves(_ instanceId: String) -> Bool { sourceInstanceId == instanceId || targetInstanceId == instanceId }
}

/// What `POST /cloud/instances/:id/exec` answered. An answer missing a part reads as a failed run.
struct CloudExecResult: Decodable {
  let exitCode: Int
  let stdout: String
  let stderr: String

  private enum CodingKeys: String, CodingKey { case exitCode, stdout, stderr }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    exitCode = c.lenient(Int.self, forKey: .exitCode) ?? -1
    stdout = c.lenient(String.self, forKey: .stdout) ?? ""
    stderr = c.lenient(String.self, forKey: .stderr) ?? ""
  }
}

// MARK: - A computer's lane steps, from the phone alone

// The desktop's steps for one ADE Cloud computer (`cloudLaneLife.ts`,
// `cloudMachines.ts`, `cloudDiskUsage.ts`), run with the phone's own sign-in
// through the same account-server routes, so a phone with no computer of the
// person's own frees a lane, changes its size and clears its caches the same
// way, in the same words. Account-level: each names a computer of the
// account by its ADE Cloud id, never a pin.

/// One lane as `ade cloud push-work` left it (`CloudPushWorkLane`). Older computers leave the list out.
struct CloudPushWorkLane: Equatable {
  let laneId: String
  let laneName: String
  let branchRef: String
  let primary: Bool
  let dirty: Bool
  let ahead: Int
  /// `clean`, `pushed`, `failed` or `unpushed` (anything else reads as unpushed).
  let state: String

  /// "main checkout", else the lane's name, else its branch (`cloudWorkLaneName`).
  var shownName: String { primary ? "main checkout" : (laneName.isEmpty ? branchRef : laneName) }
  /// Work that is still only on the computer.
  var isLeft: Bool { state == "unpushed" || state == "failed" }
}

/// `ade cloud push-work` / `work-state`'s tally (`CloudPushWorkTally`).
struct CloudPushWorkTally: Equatable {
  let pushed: Int
  let failed: Int
  let skipped: Int
  let lanes: [CloudPushWorkLane]?

  /// The command's JSON (`{ result: … }` or the tally itself), or nil when it isn't JSON (`readPushAllTally`).
  init?(stdout: String) {
    guard let data = stdout.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
          let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    let tally = parsed["result"] as? [String: Any] ?? parsed
    func count(_ key: String) -> Int {
      if let number = tally[key] as? NSNumber { return number.intValue }
      if let text = tally[key] as? String { return Int(text) ?? 0 }
      return 0
    }
    pushed = count("pushed")
    failed = count("failed")
    skipped = count("skipped")
    if let raw = tally["lanes"] as? [Any] {
      let known: Set<String> = ["clean", "pushed", "failed", "unpushed"]
      lanes = raw.compactMap { entry in
        guard let lane = entry as? [String: Any], let laneId = lane["laneId"] as? String else { return nil }
        let state = lane["state"] as? String ?? ""
        return CloudPushWorkLane(
          laneId: laneId,
          laneName: lane["laneName"] as? String ?? "",
          branchRef: lane["branchRef"] as? String ?? "",
          primary: lane["primary"] as? Bool == true,
          dirty: lane["dirty"] as? Bool == true,
          ahead: (lane["ahead"] as? NSNumber)?.intValue ?? 0,
          state: known.contains(state) ? state : "unpushed"
        )
      }
    } else {
      lanes = nil
    }
  }

  /// The lanes whose work is still only on the computer (`toWorkLanes`).
  var leftLanes: [CloudPushWorkLane] { (lanes ?? []).filter(\.isLeft) }
}

/// How one of these steps went: whether it did it, and the sentence to show.
struct CloudComputerOutcome {
  let ok: Bool
  let message: String
}

/// Commits and pushes every project's lanes on the computer (`ade cloud
/// push-work`), or only reads what isn't pushed (`ade cloud work-state`,
/// never `push-work --check`: an older ADE ignores the flag and pushes). ADE
/// on a computer that just started answers a few seconds after the start.
func cloudPushWorkCommand(check: Bool) -> String {
  [
    #"export PATH="$ADE_HOME/bin:$PATH""#,
    #"i=0; until ade projects list --json >/dev/null 2>&1 || [ "$i" -ge 25 ]; do sleep 1; i=$((i+1)); done"#,
    check ? "ade cloud work-state --json" : "ade cloud push-work --json",
  ].joined(separator: "\n")
}

/// Stops running turns and agent CLIs and writes the saved chat copy, before a restart (`prepareStopCommand`).
let cloudPrepareStopCommand = #"export PATH="$ADE_HOME/bin:$PATH""# + "\nade cloud prepare-stop --timeout 40"

/// What keeps the computer awake, as its brain wrote it (`KEEP_AWAKE_STATE_COMMAND`).
let cloudKeepAwakeStateCommand = #"cat "$ADE_HOME/cloud/keep-awake.json" 2>/dev/null"#

/// The caches ADE may clear (`CLOUD_CLEARABLE_CACHES`), each inside the home
/// folder, never through a link: package and tool caches and Docker's build
/// cache. Never a repository, a dependency folder, an image or an emulator,
/// and never the browsers and ADE kept in `.cache` (`KEEP_IN_CACHES`). The
/// disk's last measure is dropped, so the computer measures again at its next
/// idle step. Prints the disk's used KB before and after.
let cloudClearCachesCommand = """
home="$HOME"
used() { df -Pk "$home" 2>/dev/null | awk 'NR==2 {print $3}'; }
before=$(used)
for folder in .cache .npm/_cacache .local/share/pnpm/store .pnpm-store .bun/install/cache .yarn/berry/cache .gradle/caches .cargo/registry/cache; do
  full="$home/$folder"
  { [ -d "$full" ] && [ ! -L "$full" ]; } || continue
  for entry in "$full"/* "$full"/.[!.]* "$full"/..?*; do
    { [ -e "$entry" ] || [ -L "$entry" ]; } || continue
    case "${entry##*/}" in ms-playwright|puppeteer|ade) continue ;; esac
    rm -rf -- "$entry"
  done
done
docker builder prune --force >/dev/null 2>&1 || true
rm -f "$ADE_HOME/cloud/disk-usage.json"
after=$(used)
printf '{"beforeKb":%s,"afterKb":%s}\\n' "${before:-null}" "${after:-null}"
"""

extension CloudServerClient {
  /// Bounded so a frozen push can't outlast the short wake it runs in (`PUSH_ALL_WORK_TIMEOUT_MS`).
  static let pushWorkTimeoutMs = 3 * 60_000

  /// Wakes (or starts) a computer, trying again for a few seconds while it is
  /// still changing state (`wakeThroughTransition`). The server's refusals
  /// (out of hours, blocked, too many awake) are not tried again.
  func wakeThroughTransition(instanceId: String) async throws {
    let deadline = Date().addingTimeInterval(15)
    while true {
      do {
        try await start(instanceId: instanceId)
        return
      } catch Failure.server(let status, _) where (status == 409 || status >= 500) && Date() < deadline {
        try await Task.sleep(for: .milliseconds(500))
      }
    }
  }

  /// Runs push-work on the computer (`runPushWork`): it wakes a resting
  /// computer, which uses hours. Its tally, or nil with why.
  func runPushWork(instanceId: String, check: Bool) async -> (tally: CloudPushWorkTally?, error: String?) {
    do {
      try await wakeThroughTransition(instanceId: instanceId)
      let ran = try await exec(instanceId: instanceId, command: cloudPushWorkCommand(check: check), timeoutMs: Self.pushWorkTimeoutMs)
      if ran.exitCode == 0, let tally = CloudPushWorkTally(stdout: ran.stdout) { return (tally, nil) }
      let unknown = "\(ran.stderr)\n\(ran.stdout)".range(of: #"unknown (cloud )?command|method not found|can't read this computer's work"#, options: [.regularExpression, .caseInsensitive]) != nil
      if check, ran.exitCode != 0, unknown { return (nil, "This computer's ADE is too old to say what isn't pushed.") }
      return (nil, "ADE couldn't read this computer's work.")
    } catch {
      return (nil, cloudServerFailureMessage(error))
    }
  }

  /// Whether any lane's work is only on the computer (`workState`): nil when it can't say.
  func workState(instanceId: String) async -> (unpushed: Bool?, unpushedLanes: [CloudPushWorkLane], message: String?) {
    let ran = await runPushWork(instanceId: instanceId, check: true)
    guard let tally = ran.tally else { return (nil, [], ran.error ?? "ADE couldn't read this computer's work.") }
    guard tally.lanes != nil else { return (nil, [], "This computer's ADE is too old to say what isn't pushed.") }
    let left = tally.leftLanes
    if tally.failed > 0 { return (nil, left, "ADE couldn't read every project on this computer.") }
    return (!left.isEmpty, left, nil)
  }

  enum AgentWork { case idle, busy, setup, unknown }

  /// Whether the agent's work keeps the computer busy, from its keep-awake
  /// facts (`agentWork`): asleep counts as idle; facts it can't read are unknown.
  func agentWork(instanceId: String) async throws -> AgentWork {
    guard try await instance(instanceId).status == "running" else { return .idle }
    guard let read = try? await exec(instanceId: instanceId, command: cloudKeepAwakeStateCommand, timeoutMs: 30_000),
          let data = read.stdout.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
          let state = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return .unknown }
    // A person watching a tool, or a timer due soon, is not the agent's work.
    let reasons = (state["reasons"] as? [Any] ?? []).compactMap { $0 as? String }
    let working = reasons.filter { $0 != "in_use" && $0 != "schedule" }
    guard state["busy"] as? Bool == true, !working.isEmpty else { return .idle }
    // Only the lane's setup (a launch still cloning, or waiting for a provider sign-in) is not an agent's work.
    let setup: Set<String> = ["setup", "lane_setup", "first_clone", "lane_launch"]
    return working.allSatisfy { setup.contains($0) } ? .setup : .busy
  }

  /// Deletes a computer and waits until the server confirms it is gone (a 404
  /// or `deleted`), as `cloudMachines.run("delete")` does. A repeat delete's
  /// 404 is what a delete wants. False when the delete was taken but isn't
  /// finished yet.
  func deleteInstanceConfirmed(_ instanceId: String, keepLaneBranch: String? = nil) async throws -> Bool {
    do {
      try await deleteInstance(instanceId, keepLaneBranch: keepLaneBranch)
    } catch Failure.noAccess {
      // Already gone.
    }
    for attempt in 0..<15 {
      do {
        if try await instance(instanceId).isGone { return true }
      } catch Failure.noAccess {
        return true
      } catch {
        // Read again on the next round.
      }
      if attempt < 14 { try? await Task.sleep(for: .seconds(2)) }
    }
    return false
  }

  /// "Keep the lane, free its computer" (`freeLane`): refused while the agent
  /// works; the work (archived lanes too) is pushed and checked again, and
  /// anything left keeps the computer. Then the computer goes and the server
  /// keeps the lane, with its chats, as a lane without a computer: the next
  /// message makes a new computer on the same branch.
  func freeLane(instanceId: String) async -> CloudComputerOutcome {
    func fail(_ message: String) -> CloudComputerOutcome { CloudComputerOutcome(ok: false, message: message) }
    let box: CloudServerInstance
    do {
      box = try await instance(instanceId)
    } catch Failure.noAccess {
      return fail("ADE Cloud has no such computer.")
    } catch {
      return fail(cloudServerFailureMessage(error))
    }
    guard let laneId = box.laneId, box.laneName != nil else {
      return fail("This computer wasn't made for one lane, so there is no lane to keep. Delete it, or keep it.")
    }
    // ADE's server runs the free itself (it goes on with the app closed); an older server runs it from here.
    if let onServer = await freeOnServer(instanceId: instanceId) { return onServer }
    // A running agent could write again after its lane was pushed.
    let work: AgentWork
    do {
      work = try await agentWork(instanceId: instanceId)
    } catch {
      return fail(cloudServerFailureMessage(error))
    }
    if work == .setup { return fail("This lane is still being set up. Finish signing in, or cancel the setup, then free the computer.") }
    if work == .busy { return fail("The agent is still working. Stop it or wait, then free the computer.") }
    if work == .unknown { return fail("ADE couldn't tell whether the agent is still working, so the computer stays. Try again in a moment.") }
    let ran = await runPushWork(instanceId: instanceId, check: false)
    guard let tally = ran.tally else {
      return fail("ADE couldn't push this lane's work, so the computer stays: \(cloudWithoutStop(ran.error ?? "no answer")).")
    }
    let left = tally.leftLanes
    if tally.failed > 0 || !left.isEmpty || (tally.lanes == nil && tally.skipped > 0) {
      let names = left.map(\.shownName).filter { !$0.isEmpty }
      return fail("ADE couldn't push all work on this computer\(names.isEmpty ? "" : " (\(names.joined(separator: ", ")))"), so it stays. Open the lane to see why, then try again.")
    }
    // Read once more after the push: anything new or unknown keeps the computer.
    let after = await workState(instanceId: instanceId)
    if after.unpushed != false {
      let names = after.unpushedLanes.map(\.shownName).filter { !$0.isEmpty }
      return fail(after.unpushed == true
        ? "Work changed on this computer while ADE pushed it\(names.isEmpty ? "" : " (\(names.joined(separator: ", ")))"), so it stays. Try again."
        : "ADE couldn't confirm all work is on GitHub, so the computer stays: \(cloudWithoutStop(after.message ?? "no answer")).")
    }
    let ownLane = tally.lanes?.first { $0.laneId == laneId } ?? tally.lanes?.first { !$0.primary }
    guard let branchRef = nonEmptyTrimmed(ownLane?.branchRef) ?? box.laneBranch else {
      return fail("ADE couldn't tell which branch this lane is on, so the computer stays.")
    }
    // A refusal (the server couldn't read the lane, or knows none) deleted
    // nothing: its sentence is shown as it is, and the lane is not freed.
    do {
      guard try await deleteInstanceConfirmed(instanceId, keepLaneBranch: branchRef) else {
        return fail("ADE Cloud took the delete but hasn't finished it yet. Check again in a minute; if the computer is still there, delete it again.")
      }
    } catch {
      return fail(cloudServerFailureMessage(error))
    }
    let kept = (try? await lanesWithoutComputer())?.contains { $0.laneId == laneId } == true
    // The computer is gone but an older server didn't keep the lane.
    return CloudComputerOutcome(ok: true, message: kept
      ? "The work is on GitHub and the computer is removed. The next message makes a new computer on the same branch."
      : "The work is on GitHub and the computer is removed. Start a new lane on its branch to go on.")
  }

  /// A size change in place, now (`changeTier` with `timing: "now"`, kind
  /// `resize`): running turns stop and the chats' saved copy is written, then
  /// the computer restarts at the new CPU and memory. A computer that was
  /// awake and comes back asleep is woken, as the desktop's wait does. A
  /// change to the other kind (standard ↔ full) is a move to a new computer
  /// (`startMove`), never this.
  func changeSize(instanceId: String, to tier: CloudPhoneTier) async -> CloudComputerOutcome {
    func fail(_ message: String) -> CloudComputerOutcome { CloudComputerOutcome(ok: false, message: message) }
    let box: CloudServerInstance
    do {
      box = try await instance(instanceId)
    } catch Failure.noAccess {
      return fail("ADE Cloud has no such computer.")
    } catch {
      return fail(cloudServerFailureMessage(error))
    }
    guard (box.type == "vm" ? "vm" : "default") == tier.type else {
      return fail(cloudPhoneKindChangeReason(to: tier))
    }
    guard let current = box.resources, current.cpu > 0, current.memory > 0 else {
      return fail("ADE Cloud didn't say how big this computer is, so ADE can't resize it.")
    }
    if current.cpu == tier.cpu && current.memory == tier.memoryGb { return fail("It's already \(tier.label).") }
    let wasAwake = box.status == "running"
    if wasAwake {
      // Stops what still runs and writes the saved chat copy, so the chats
      // read the same while the computer restarts. A save that fails goes on:
      // the person chose to restart now.
      _ = try? await exec(instanceId: instanceId, command: cloudPrepareStopCommand, timeoutMs: 90_000)
    }
    do {
      var status = try await resize(instanceId: instanceId, cpu: tier.cpu, memoryGb: tier.memoryGb)
      // A resize leaves it asleep on some sizes: wake it, as a send would.
      if wasAwake, status == "sleeping" || status == "stopped" {
        status = (try? await start(instanceId: instanceId)) ?? status
      }
      return CloudComputerOutcome(ok: true, message: status == "running"
        ? "Resized to \(tier.label). ADE on it is starting again."
        : "Resizing to \(tier.label). It is back in a few minutes.")
    } catch {
      return fail(cloudServerFailureMessage(error))
    }
  }

  /// Clears a computer's caches (`clearCloudDiskCaches`). It wakes a resting
  /// computer, which uses hours. Answers how much it freed.
  func clearCaches(instanceId: String) async -> CloudComputerOutcome {
    do {
      try await wakeThroughTransition(instanceId: instanceId)
      let ran = try await exec(instanceId: instanceId, command: cloudClearCachesCommand, timeoutMs: 5 * 60_000)
      guard ran.exitCode == 0 else { return CloudComputerOutcome(ok: false, message: "ADE couldn't clear this computer's caches. Try again.") }
      let line = ran.stdout.split(separator: "\n").last.map(String.init) ?? ""
      let sizes = (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
      let before = (sizes?["beforeKb"] as? NSNumber)?.doubleValue
      let after = (sizes?["afterKb"] as? NSNumber)?.doubleValue
      let freedGb = before.flatMap { b in after.map { max(0, (b - $0) / (1024 * 1024)) } } ?? 0
      return CloudComputerOutcome(ok: true, message: "Freed \(cloudGb(freedGb)).")
    } catch {
      return CloudComputerOutcome(ok: false, message: cloudServerFailureMessage(error))
    }
  }
}

/// A sentence without its last full stop, to go inside another one.
private func cloudWithoutStop(_ text: String) -> String {
  text.hasSuffix(".") ? String(text.dropLast()) : text
}

/// Why the phone can't move a computer to the other kind on an account
/// server older than the move route (its POST answers 404): there only ADE
/// on a computer makes the new computer and copies the files (`moveCloudMachine`).
func cloudPhoneKindChangeReason(to tier: CloudPhoneTier) -> String {
  tier.full
    ? "Moving to a full computer makes a new computer; start it from ADE on a computer."
    : "Moving to a standard computer makes a new computer; start it from ADE on a computer."
}
