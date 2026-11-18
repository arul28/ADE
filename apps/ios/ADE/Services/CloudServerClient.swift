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

  private enum CodingKeys: String, CodingKey { case id, name, status, pastDue, idleSaving, metadata, laneWork }

  init(id: String, name: String?, status: String, pastDue: Bool, idleSaving: Bool = false, metadata: [String: String], laneWork: CloudPhoneMachine.LaneWork? = nil) {
    self.id = id
    self.name = name
    self.status = status
    self.pastDue = pastDue
    self.idleSaving = idleSaving
    self.metadata = metadata
    self.laneWork = laneWork
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

struct CloudLaneWithoutComputer: Decodable, Equatable {
  let laneId: String
  let laneName: String
  let projectOrigin: String?
  let branchRef: String?
  let reason: String?

  private enum CodingKeys: String, CodingKey { case laneId, laneName, projectOrigin, branchRef, reason }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    laneId = try c.decode(String.self, forKey: .laneId)
    laneName = c.lenient(String.self, forKey: .laneName) ?? "Cloud lane"
    projectOrigin = c.lenient(String.self, forKey: .projectOrigin)?.lowercased()
    branchRef = c.lenient(String.self, forKey: .branchRef)
    reason = c.lenient(String.self, forKey: .reason)
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
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(name.prefix(60))-saved-work.patch")
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
  /// (`DELETE /cloud/instances/:id`, a person's delete). Needs no wake.
  func deleteInstance(_ instanceId: String) async throws {
    _ = try await send("DELETE", "cloud/instances/\(segment(instanceId))", body: Data(#"{"reason":"user"}"#.utf8), timeout: 60)
  }

  /// Deletes the saved chats of one lane of a computer (`DELETE /cloud/chats/:m/lanes/:lane`).
  func deleteSavedChats(machineKey: String, laneId: String) async throws {
    _ = try await send("DELETE", "cloud/chats/\(segment(machineKey))/lanes/\(segment(laneId))", timeout: 30)
  }

  func start(instanceId: String) async throws {
    _ = try await send("POST", "cloud/instances/\(segment(instanceId))/start", body: Data("{}".utf8), timeout: 120)
  }

  /// "Keep it": the idle cleanup's clock starts again, with no wake.
  func keep(instanceId: String) async throws {
    _ = try await send("POST", "cloud/instances/\(segment(instanceId))/keep", body: Data("{}".utf8))
  }

  /// Holds a message for an existing cloud chat and wakes its computer. The
  /// same `messageId` again answers the same message (the client's send id).
  func queueMessage(machineKey: String, chatId: String, messageId: String, text: String, attachments: [[String: Any]] = []) async throws -> CloudChatQueueResult {
    var payload: [String: Any] = ["messageId": messageId, "text": text]
    if !attachments.isEmpty { payload["attachments"] = attachments }
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
    timeout: TimeInterval = 12
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
        let (data, response) = try await session.data(for: request)
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
