import Foundation
import OSLog
import SwiftUI

private let cloudLaunchLog = Logger(subsystem: "com.ade.ios", category: "cloud-launches")

// A chat on ADE Cloud started from the phone with no computer of the
// person's own: `POST /cloud/launches` on the account server, with the
// account project's id. The server makes the computer, clones the repo, waits
// for the provider sign-in and sends the first message, which it keeps, so
// the app may close. The web app sends the same request
// (`apps/desktop/src/renderer/state/accountCloudLaunches.ts`); the contract
// is `apps/account-directory/src/cloud/contract.ts`.

// MARK: - Contract shapes

struct CloudLaunchStage: Decodable, Equatable {
  let id: String
  let status: String
  let detail: String?
  let error: String?

  private enum CodingKeys: String, CodingKey { case id, status, detail, error }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    status = c.lenient(String.self, forKey: .status) ?? "pending"
    detail = c.lenient(String.self, forKey: .detail)
    error = c.lenient(String.self, forKey: .error)
  }
}

/// A message of a chat launch (`GET /cloud/launches/:id/messages`). Row 1 is
/// the first message; the rest are what the person sent before the chat ran.
struct CloudLaunchMessage: Decodable, Equatable, Identifiable {
  var id: String { messageId }
  let messageId: String
  let seq: Int
  let text: String
  /// `queued`, `sending`, `delivered` or `failed`.
  let state: String
  let error: String?
  /// ms since 1970.
  let createdAt: Double?

  private enum CodingKeys: String, CodingKey { case messageId, seq, text, state, error, createdAt }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    messageId = try c.decode(String.self, forKey: .messageId)
    seq = c.lenient(Int.self, forKey: .seq) ?? 1
    text = c.lenient(String.self, forKey: .text) ?? ""
    state = c.lenient(String.self, forKey: .state) ?? "queued"
    error = c.lenient(String.self, forKey: .error)
    createdAt = c.lenient(Double.self, forKey: .createdAt)
  }
}

/// What a launch waiting on a provider sign-in shows (`waiting_for_sign_in`).
struct CloudLaunchSignIn: Decodable, Equatable {
  let provider: String
  let label: String
  /// `device`, `url_paste`, `api_key` or `desktop`.
  let kind: String
  let jobId: String?
  let url: String?
  let userCode: String?
  let needsPastedCode: Bool
  let signInId: String?
  let reason: String?

  private enum CodingKeys: String, CodingKey {
    case provider, label, kind, jobId, url, userCode, needsPastedCode, signInId, reason
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    provider = c.lenient(String.self, forKey: .provider) ?? ""
    label = c.lenient(String.self, forKey: .label) ?? ""
    kind = c.lenient(String.self, forKey: .kind) ?? "device"
    jobId = c.lenient(String.self, forKey: .jobId)
    url = c.lenient(String.self, forKey: .url)
    userCode = c.lenient(String.self, forKey: .userCode)
    needsPastedCode = c.lenient(Bool.self, forKey: .needsPastedCode) ?? false
    signInId = c.lenient(String.self, forKey: .signInId)
    reason = c.lenient(String.self, forKey: .reason)
  }
}

/// One launch (`CloudLaunchRecord`, or the summary `GET /cloud/launches?active=1` lists).
struct CloudLaunchRecord: Decodable, Equatable {
  let launchId: String
  let state: String
  /// `chat`, `lane` or `machine`; nil from an older server.
  let kind: String?
  let projectOrigin: String?
  let laneId: String?
  let laneName: String?
  let instanceId: String?
  let stages: [CloudLaunchStage]
  let sessionId: String?
  let error: String?
  let signIn: CloudLaunchSignIn?
  /// The chat's provider and model: on a summary, or in the record's request.
  let provider: String?
  let modelId: String?
  let prompt: String?
  /// The start as the server keeps it: a Retry from any device sends it again.
  let request: RemoteJSONValue?
  /// `needs_approval`: the page that confirms the computer's sign-in to the account.
  let approvalUrl: String?
  /// When the server took the start (ms since 1970); nil from an older server.
  let createdAt: Double?

  private enum CodingKeys: String, CodingKey {
    case launchId, state, kind, projectOrigin, laneId, laneName, instanceId, stages, sessionId, error, signIn, provider, modelId, request, approval, createdAt
  }
  private struct Approval: Decodable { let url: String? }
  private struct Request: Decodable {
    struct Chat: Decodable {
      let provider: String?
      let modelId: String?
      let prompt: String?
    }
    let chat: Chat?
  }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    launchId = try c.decode(String.self, forKey: .launchId)
    state = c.lenient(String.self, forKey: .state) ?? "making"
    kind = c.lenient(String.self, forKey: .kind)
    projectOrigin = c.lenient(String.self, forKey: .projectOrigin)
    laneId = c.lenient(String.self, forKey: .laneId)
    laneName = c.lenient(String.self, forKey: .laneName)
    instanceId = c.lenient(String.self, forKey: .instanceId)
    stages = c.lenient([CloudLaunchStage].self, forKey: .stages) ?? []
    sessionId = c.lenient(String.self, forKey: .sessionId)
    error = c.lenient(String.self, forKey: .error)
    signIn = c.lenient(CloudLaunchSignIn.self, forKey: .signIn)
    // `request` twice: its chat fields for the row, and all of it, as sent, for a Retry.
    let chatRequest = c.lenient(Request.self, forKey: .request)
    provider = c.lenient(String.self, forKey: .provider) ?? chatRequest?.chat?.provider
    modelId = c.lenient(String.self, forKey: .modelId) ?? chatRequest?.chat?.modelId
    prompt = chatRequest?.chat?.prompt
    request = c.lenient(RemoteJSONValue.self, forKey: .request)
    approvalUrl = c.lenient(Approval.self, forKey: .approval)?.url
    createdAt = c.lenient(Double.self, forKey: .createdAt)
  }

  /// Still on its way to a running chat.
  var inProgress: Bool {
    ["draft", "making", "joining", "needs_approval", "joined", "waiting_for_sign_in"].contains(state)
  }
  /// Failed, or cancelled from some device.
  var failed: Bool { state == "failed" || state == "cancelled" }
  var cancelled: Bool { state == "cancelled" }
  /// The computer runs it: a chat launch's chat, a lane launch's lane.
  var reachedRunning: Bool { state == "running" || state == "done" }
  /// Waits for the person: the computer's sign-in to confirm, or the provider's.
  var waitsForPerson: Bool { state == "needs_approval" || state == "waiting_for_sign_in" }
  /// The server still keeps messages for its chat (`addLaunchMessage`): no
  /// chat yet, and the launch is open.
  var takesMessages: Bool {
    sessionId == nil && !["draft", "done", "failed", "cancelled", "retrying"].contains(state)
  }
}

struct CloudCatalogModel: Decodable, Equatable, Hashable {
  let id: String
  let displayName: String
  /// The efforts the model takes (`chat.effort`); empty when it has none.
  let reasoningTiers: [String]
  let defaultReasoningEffort: String?
  /// The model has a fast mode (`chat.fast`).
  let fast: Bool

  private enum CodingKeys: String, CodingKey { case id, displayName, reasoningTiers, defaultReasoningEffort, fast }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    displayName = c.lenient(String.self, forKey: .displayName) ?? id
    reasoningTiers = c.lenient([String].self, forKey: .reasoningTiers) ?? []
    defaultReasoningEffort = c.lenient(String.self, forKey: .defaultReasoningEffort)
    fast = c.lenient(Bool.self, forKey: .fast) ?? false
  }
}

struct CloudCatalogProvider: Decodable, Equatable {
  let provider: String
  let label: String
  /// `device`, `url_paste`, `api_key` or `desktop`.
  let remoteSignIn: String
  let defaultModelId: String?
  let models: [CloudCatalogModel]

  private enum CodingKeys: String, CodingKey { case provider, label, remoteSignIn, defaultModelId, models }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    provider = try c.decode(String.self, forKey: .provider)
    label = c.lenient(String.self, forKey: .label) ?? provider
    remoteSignIn = c.lenient(String.self, forKey: .remoteSignIn) ?? "device"
    defaultModelId = c.lenient(String.self, forKey: .defaultModelId)
    models = c.lenient([CloudCatalogModel].self, forKey: .models) ?? []
  }
}

struct CloudModelCatalog: Decodable, Equatable {
  /// Changes with the list; absent from an older server.
  let version: String?
  let providers: [CloudCatalogProvider]

  /// Not read yet: a picker given this reads ADE Cloud's list itself.
  static let pending = CloudModelCatalog(version: nil, providers: [])
}

/// One sign-in the account vault keeps for ADE Cloud. Never its value.
struct CloudAccountSignIn: Decodable, Equatable, Identifiable {
  let id: String
  let label: String
  let providers: [String]
  let keyName: String
  let keyUrl: String?
  let saved: Bool

  private enum CodingKeys: String, CodingKey { case id, label, providers, keyName, keyUrl, saved }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    label = c.lenient(String.self, forKey: .label) ?? id
    providers = c.lenient([String].self, forKey: .providers) ?? []
    keyName = c.lenient(String.self, forKey: .keyName) ?? "API key"
    keyUrl = c.lenient(String.self, forKey: .keyUrl)
    saved = c.lenient(Bool.self, forKey: .saved) ?? false
  }
}

struct CloudAccountSignIns: Decodable, Equatable {
  let signIns: [CloudAccountSignIn]
  /// The vault didn't answer: `saved` may be wrong.
  let unknown: Bool
  /// Provider sign-ins carried from ADE desktop to ADE Cloud, by provider
  /// (`carried.antigravity`). Empty when the server left it out.
  let carried: [String: Bool]

  private enum CodingKeys: String, CodingKey { case signIns, unknown, carried }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    signIns = c.lenient([CloudAccountSignIn].self, forKey: .signIns) ?? []
    unknown = c.lenient(Bool.self, forKey: .unknown) ?? false
    carried = c.lenient([String: Bool].self, forKey: .carried) ?? [:]
  }
}

private struct CloudSignInCodeStatus: Decodable {
  let state: String?
  let reason: String?
}

// MARK: - Client

extension CloudServerClient {
  private struct LaunchList: Decodable { let launches: [CloudLaunchRecord] }

  func modelCatalog() async throws -> CloudModelCatalog {
    try decode(CloudModelCatalog.self, from: try await send("GET", "cloud/models"))
  }

  /// A file the first message names, sent before the start (raw bytes). The
  /// same `fileId` again replaces it.
  func uploadLaunchFile(launchId: String, fileId: String, data: Data, contentType: String) async throws -> Int {
    struct Uploaded: Decodable { let sizeBytes: Int }
    let answer = try await send(
      "PUT",
      "cloud/launches/\(segment(launchId))/files/\(segment(fileId))",
      body: data,
      contentType: contentType,
      timeout: 120
    )
    return try decode(Uploaded.self, from: answer).sizeBytes
  }

  /// 201 for a new launch; the same `launchId` again answers the same launch.
  func startLaunch(_ body: RemoteJSONValue) async throws -> CloudLaunchRecord {
    let data = try JSONEncoder().encode(body)
    return try decode(CloudLaunchRecord.self, from: try await send("POST", "cloud/launches", body: data, timeout: 48, resendOnLostConnection: true))
  }

  /// Stops a launch before its agent starts; the server refuses once it has (`launch_started`).
  func cancelLaunch(_ launchId: String) async throws -> CloudLaunchRecord {
    try decode(CloudLaunchRecord.self, from: try await send("DELETE", "cloud/launches/\(segment(launchId))"))
  }

  func launch(_ launchId: String) async throws -> CloudLaunchRecord {
    try decode(CloudLaunchRecord.self, from: try await send("GET", "cloud/launches/\(launchId)"))
  }

  /// A chat launch's messages, in order (row 1 is the first message).
  func launchMessages(_ launchId: String) async throws -> [CloudLaunchMessage] {
    struct List: Decodable { let messages: [CloudLaunchMessage] }
    return try decode(List.self, from: try await send("GET", "cloud/launches/\(segment(launchId))/messages")).messages
  }

  /// A message for a chat launch whose chat doesn't run yet. The same
  /// `messageId` again is the same message; once the chat runs the server
  /// refuses with `chat_ready`.
  func addLaunchMessage(_ launchId: String, messageId: String, text: String) async throws -> CloudLaunchMessage {
    let data = try JSONSerialization.data(withJSONObject: ["messageId": messageId, "text": text])
    return try decode(
      CloudLaunchMessage.self,
      from: try await send("POST", "cloud/launches/\(segment(launchId))/messages", body: data, resendOnLostConnection: true)
    )
  }

  /// The account's launches still in progress, and failures of the last day.
  func activeLaunches() async throws -> [CloudLaunchRecord] {
    try decode(LaunchList.self, from: try await send("GET", "cloud/launches", query: [URLQueryItem(name: "active", value: "1")])).launches
  }

  func accountSignIns() async throws -> CloudAccountSignIns {
    try decode(CloudAccountSignIns.self, from: try await send("GET", "cloud/sign-ins"))
  }

  func saveAccountSignIn(_ signInId: String, key: String) async throws -> CloudAccountSignIns {
    let data = try JSONSerialization.data(withJSONObject: ["key": key])
    return try decode(CloudAccountSignIns.self, from: try await send("PUT", "cloud/sign-ins/\(segment(signInId))", body: data))
  }

  func removeAccountSignIn(_ signInId: String) async throws -> CloudAccountSignIns {
    try decode(CloudAccountSignIns.self, from: try await send("DELETE", "cloud/sign-ins/\(segment(signInId))"))
  }

  /// A code pasted from the provider's page, for a sign-in on the computer.
  /// Answers the reason when the code did not work.
  func sendSignInCode(instanceId: String, jobId: String, code: String) async throws -> String? {
    let data = try JSONSerialization.data(withJSONObject: ["code": code])
    let status = try decode(
      CloudSignInCodeStatus.self,
      from: try await send("POST", "cloud/instances/\(segment(instanceId))/sign-ins/\(segment(jobId))/code", body: data, timeout: 100)
    )
    return status.state == "failed" ? (status.reason ?? "The code didn't work. Open the page again for a new one.") : nil
  }

}

/// One plain sentence for a failed account-server call.
func cloudServerFailureMessage(_ error: Error) -> String {
  switch error as? CloudServerClient.Failure {
  case .noAccess: return "ADE Cloud isn't open for this account."
  case .unauthorized: return "Sign in to ADE again, then try again."
  case .refused(_, let message): return message
  case .server(_, let message?): return message
  case .server(let status, nil): return "ADE Cloud answered with an error (\(status)). Try again soon."
  case .transport: return "ADE Cloud didn't answer. Check the connection, then try again."
  case .unreadable: return "ADE Cloud sent an answer this app can't read. Update ADE, then try again."
  case nil: return error.localizedDescription
  }
}

// MARK: - Setup steps

enum CloudSetupStepState: Equatable {
  case todo, running, waiting, done, failed
}

struct CloudSetupStepStates: Equatable {
  var computer: CloudSetupStepState
  var repo: CloudSetupStepState
  var signIn: CloudSetupStepState
  var send: CloudSetupStepState
}

/// Pure: the setup card's four steps from a launch record, the same rules as
/// the web card (`cloudSetupStepStates` in `CloudSetupCard.tsx`).
func cloudSetupStepStates(_ record: CloudLaunchRecord?) -> CloudSetupStepStates {
  guard let record else { return CloudSetupStepStates(computer: .running, repo: .todo, signIn: .todo, send: .todo) }
  func stagesState(_ ids: [String]) -> CloudSetupStepState? {
    let mine = record.stages.filter { ids.contains($0.id) }
    if mine.isEmpty { return nil }
    if mine.contains(where: { $0.status == "failed" }) { return .failed }
    if mine.allSatisfy({ ["done", "skipped", "warning"].contains($0.status) }) { return .done }
    if mine.contains(where: { $0.status == "running" || $0.status == "done" }) { return .running }
    return .todo
  }
  let afterJoin: Set<String> = ["joined", "waiting_for_sign_in", "running", "done"]
  let failed = record.failed
  let computer = stagesState(["computer", "join"])
    ?? (afterJoin.contains(record.state) ? .done : record.state == "needs_approval" ? .waiting : failed ? .failed : .running)
  let agent = record.stages.first { $0.id == "agent" }?.status
  let agentStarted = agent == "running" || agent == "done" || record.state == "running" || record.state == "done"
  let repo = stagesState(["clone", "fetch", "checkout"])
    ?? (agentStarted || record.state == "waiting_for_sign_in" ? .done : computer == .done ? .running : .todo)
  let signIn: CloudSetupStepState = record.state == "waiting_for_sign_in"
    ? .waiting
    : agentStarted ? .done : (failed && repo == .done ? .failed : .todo)
  let send: CloudSetupStepState = record.sessionId != nil || record.state == "done" || agent == "done"
    ? .done
    : agentStarted ? .running : (failed && signIn == .done ? .failed : .todo)
  return CloudSetupStepStates(
    computer: failed && computer != .done ? .failed : computer,
    repo: failed && computer == .done && repo != .done ? .failed : repo,
    signIn: signIn,
    send: send
  )
}

// MARK: - Store

/// The phone's ADE Cloud chat launches: the ones it started, and the
/// account's active ones from any device (`GET /cloud/launches?active=1`), so
/// a launch started on the web shows here too. While a launch is in
/// progress and the app is in front, each is read again with a backoff from
/// 3 s to 10 s; nothing is read while none is in progress.
@MainActor
final class AccountCloudLaunchStore: ObservableObject {
  static let shared = AccountCloudLaunchStore()

  struct Entry: Identifiable, Equatable {
    var id: String { launchId }
    let launchId: String
    /// `github.com/owner/repo`, lowercased.
    var origin: String?
    var prompt: String
    var provider: String?
    var modelId: String?
    var record: CloudLaunchRecord?
    /// The start itself failed (the server refused, or no answer).
    var startError: String?
    /// The start surely did not reach ADE Cloud as a launch (signed out, a
    /// file upload failed, or the server refused it), so nothing runs under
    /// this id. With no answer at all it may have: the launch stays, with Retry.
    var startNeverReached = false
    /// The start this phone sent; a launch found from another device uses its record's `request`.
    var body: RemoteJSONValue?
    /// `chat` (a chat and its first message) or `lane` (a lane alone, as "New
    /// computer" for a lane kept without one starts it).
    var kind: String = "chat"
    var laneId: String?
    var laneName: String?
    /// When this phone first knew the launch: its message's time on the launch's chat page.
    var startedAt = Date()
    /// This phone started it (not read from the account's list): its new
    /// computer connects on its own once it runs (`connectWhenReady`).
    var startedHere = false

    var isLane: Bool { kind == "lane" }
    var inProgress: Bool { startError == nil && (record?.inProgress ?? true) }
    /// The start failed, the launch failed, or it was cancelled.
    var failed: Bool { startError != nil || record?.failed == true }
    var cancelled: Bool { record?.cancelled == true }
    /// The launch's page can queue a message now.
    var canQueueMessages: Bool { !isLane && startError == nil && record?.takesMessages == true }
    /// Still worth reading again: in progress, a lane launch whose computer
    /// runs its checkout and setup (it ends `done` or `failed`), or a chat
    /// launch running before the server has named its chat (the card's Open
    /// chat needs that id).
    var awaitsChat: Bool {
      guard startError == nil, let record else { return false }
      return record.inProgress || (record.state == "running" && (isLane || record.sessionId == nil))
    }
  }

  /// A file the first message carries: uploaded to the launch before its start.
  struct LaunchFile: Equatable {
    let fileId: String
    let name: String
    let contentType: String
    let data: Data
  }

  @Published private(set) var entries: [Entry] = []
  /// Files not yet on the server, per launch: a retried start sends the rest.
  private var pendingFiles: [String: [LaunchFile]] = [:]
  /// Launches whose start (uploads, then the start call) is running.
  private var startingLaunchIds: Set<String> = []
  /// Finished or failed launches the person hid on this phone (until the account changes).
  @Published private var hiddenIds: Set<String> = []
  /// Launches this app run already connected on its own (`connectWhenReady`).
  private var autoConnectedLaunchIds: Set<String> = []
  /// The connect of a launch's new computer still out: the automatic one and
  /// the launch page's share it (`connectComputer`).
  private var connectTasks: [String: Task<Bool, Never>] = [:]
  /// A message whose send got no clear answer, per launch: sending the same
  /// text again reuses its id, so a send that did reach ADE Cloud is not kept twice.
  private var unconfirmedMessages: [String: (text: String, messageId: String)] = [:]
  /// Each chat launch's messages after the first, as the server last listed
  /// them: the launch's page shows them as queued bubbles.
  @Published private(set) var laterMessages: [String: [CloudLaunchMessage]] = [:]
  /// Launches whose last message read got no answer: the page says so, with Try again.
  @Published private(set) var messageReadFailed: Set<String> = []
  /// Sends that went through, per launch: a message read out during one may
  /// predate it and is dropped, so it can't hide the message just sent.
  private var messageSends: [String: Int] = [:]
  @Published private(set) var catalog: CloudModelCatalog?
  @Published private(set) var catalogError: String?
  /// Provider sign-ins ADE desktop carried to ADE Cloud (`carried` of
  /// `GET /cloud/sign-ins`), read with the catalog. Empty until read.
  @Published private(set) var carriedSignIns: [String: Bool] = [:]

  private var pollTask: Task<Void, Never>?
  /// Bumped for each poll loop and by `reset`: a loop clears the handle only while it is still the current one.
  private var pollGeneration = 0
  /// Bumped by `reset`: an answer to a read the last account made lands nowhere.
  private var accountGeneration = 0
  private var activeReadAt: Date?
  private static let lastModelKey = "ade.cloudChat.lastModel.v1"

  func entries(forOrigin origin: String) -> [Entry] {
    let key = origin.lowercased()
    return entries.filter { $0.origin == key && $0.record?.state != "cancelled" && !hiddenIds.contains($0.launchId) }
  }

  /// Hide: a finished or failed launch's card leaves this phone's project page.
  func hide(_ launchId: String) {
    hiddenIds.insert(launchId)
  }

  func isHidden(_ launchId: String) -> Bool {
    hiddenIds.contains(launchId)
  }

  /// A start that failed before ADE Cloud kept it: the new-chat page keeps
  /// the message and says why, so the launch leaves this phone.
  func discardFailedStart(_ launchId: String) {
    guard let entry = entries.first(where: { $0.launchId == launchId }),
          entry.startNeverReached, entry.record == nil else { return }
    entries.removeAll { $0.launchId == launchId }
    pendingFiles[launchId] = nil
  }

  func loadCatalogIfNeeded(using sync: SyncService) async {
    guard catalog == nil else { return }
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient() else { return }
    do {
      let read = try await client.modelCatalog()
      guard generation == accountGeneration else { return }
      catalog = read
      catalogError = nil
    } catch {
      guard generation == accountGeneration else { return }
      catalogError = cloudServerFailureMessage(error)
    }
    // Whether a desktop-only sign-in (Antigravity) already reached ADE Cloud.
    do {
      let signIns = try await client.accountSignIns()
      guard generation == accountGeneration else { return }
      carriedSignIns = signIns.carried
    } catch {
      cloudLaunchLog.notice("cloud_launches read=sign_ins failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
    }
  }

  /// The model the picker starts on: the last one used, when the list still
  /// has it, else the first provider that signs in on the computer.
  func defaultModel() -> (provider: String, modelId: String)? {
    guard let catalog else { return nil }
    if let saved = UserDefaults.standard.dictionary(forKey: Self.lastModelKey) as? [String: String],
       let provider = saved["provider"], let modelId = saved["modelId"],
       catalog.providers.first(where: { $0.provider == provider })?.models.contains(where: { $0.id == modelId }) == true {
      return (provider, modelId)
    }
    let first = catalog.providers.first { $0.remoteSignIn == "device" || $0.remoteSignIn == "url_paste" } ?? catalog.providers.first
    guard let first else { return nil }
    let modelId = first.models.contains(where: { $0.id == first.defaultModelId }) ? first.defaultModelId : first.models.first?.id
    return modelId.map { (first.provider, $0) }
  }

  /// Reads the account's active launches, at most every 20 s unless forced.
  func refreshActive(using sync: SyncService, force: Bool = false) async {
    if !force, let at = activeReadAt, Date().timeIntervalSince(at) < 20 { return }
    activeReadAt = Date()
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient() else { return }
    // Each known launch's state before the read: a Retry or a poll that moves it meanwhile is newer than this list.
    let statesBefore = Dictionary(entries.map { ($0.launchId, $0.record?.state) }, uniquingKeysWith: { first, _ in first })
    let list: [CloudLaunchRecord]
    do {
      list = try await client.activeLaunches()
    } catch {
      guard generation == accountGeneration else { return }
      // The next look (a page that opens, or 20 s later) tries again.
      activeReadAt = nil
      Self.noteReadFailed("active", error)
      return
    }
    guard generation == accountGeneration else { return }
    for summary in list {
      if let index = entries.firstIndex(where: { $0.launchId == summary.launchId }) {
        // A launch this phone knows: another device may have retried it. The
        // full record (with its request) stays while the state is the same.
        if entries[index].record?.state != summary.state,
           statesBefore[summary.launchId].map({ $0 == entries[index].record?.state }) ?? true {
          entries[index].record = summary
        }
        continue
      }
      entries.append(Entry(
        launchId: summary.launchId,
        origin: summary.projectOrigin?.lowercased(),
        prompt: summary.prompt ?? "",
        provider: summary.provider,
        modelId: summary.modelId,
        record: summary,
        kind: summary.kind ?? "chat",
        laneId: summary.laneId,
        laneName: summary.laneName
      ))
    }
    // The list's summaries carry no request: read each failed launch in full, so Retry has it.
    for entry in entries where entry.record?.state == "failed" && entry.body == nil && entry.record?.request == nil {
      guard let record = try? await client.launch(entry.launchId), generation == accountGeneration else { continue }
      patch(entry.launchId) { $0.record = record }
    }
    guard generation == accountGeneration else { return }
    connectWhenReady(using: sync)
    poll(using: sync)
  }

  /// Starts a chat on ADE Cloud for one of the account's projects: on a new
  /// cloud lane named from the prompt, or on an existing cloud lane
  /// (`existingLane`, its lane id and name), with or without a computer.
  /// Answers the launch id.
  @discardableResult
  func start(
    accountProjectId: String,
    origin: String,
    prompt: String,
    provider: String,
    modelId: String,
    effort: String? = nil,
    fast: Bool = false,
    files: [(name: String, contentType: String, data: Data)] = [],
    existingLane: (id: String, name: String)? = nil,
    newLaneName: String? = nil,
    using sync: SyncService
  ) async -> String {
    UserDefaults.standard.set(["provider": provider, "modelId": modelId], forKey: Self.lastModelKey)
    let launchId = UUID().uuidString.lowercased()
    let messageId = Self.newMessageId()
    var chat: [String: RemoteJSONValue] = [
      "provider": .string(provider),
      "modelId": .string(modelId),
      "permissions": .string("default"),
      "prompt": .string(prompt),
      "messageId": .string(messageId),
    ]
    if let effort = effort.flatMap({ nonEmptyTrimmed($0) }) { chat["effort"] = .string(effort) }
    if fast { chat["fast"] = .bool(true) }
    // The server takes the files first, then a start that names each by id and size.
    let launchFiles = files.enumerated().map { index, file in
      LaunchFile(fileId: "f\(index)-\(launchId.prefix(8))", name: file.name, contentType: file.contentType, data: file.data)
    }
    if !launchFiles.isEmpty {
      chat["attachments"] = .array(launchFiles.map { file in
        .object([
          "fileId": .string(file.fileId),
          "name": .string(file.name),
          "contentType": .string(file.contentType),
          "sizeBytes": .number(Double(file.data.count)),
        ])
      })
      pendingFiles[launchId] = launchFiles
    }
    var fields: [String: RemoteJSONValue] = [
      "launchId": .string(launchId),
      "kind": .string("chat"),
      // The server reads the origin from the account's project.
      "project": .object(["accountProjectId": .string(accountProjectId)]),
      "chat": .object(chat),
      "madeBy": .object(["kind": .string("person")]),
    ]
    if let existingLane {
      fields["lane"] = .object(["id": .string(existingLane.id), "name": .string(existingLane.name)])
    } else if let newLaneName = newLaneName.flatMap({ nonEmptyTrimmed($0) }) {
      // The computer's brain renames the lane and its branch with the AI name.
      fields["lane"] = .object(["name": .string(newLaneName), "autoName": .bool(true)])
    }
    let body: RemoteJSONValue = .object(fields)
    entries.insert(Entry(
      launchId: launchId,
      origin: origin.lowercased(),
      prompt: prompt,
      provider: provider,
      modelId: modelId,
      body: body,
      startedHere: true
    ), at: 0)
    await runStart(launchId, body: body, using: sync)
    return launchId
  }

  /// "New computer" for a lane ADE kept without one, as the desktop's
  /// (`useStartLaneOnNewComputer`): a lane launch for the same lane id, on its
  /// branch on GitHub, at the old computer's size when today's sizes still
  /// have it (else ADE Cloud's default). No chat and no first message; the
  /// computer brings back the lane's saved chats. Answers the launch id.
  @discardableResult
  func startLaneOnNewComputer(_ lane: CloudLaneWithoutComputer, sizeId: String?, using sync: SyncService) async -> String? {
    guard let origin = lane.projectOrigin.flatMap({ nonEmptyTrimmed($0) }), let branch = lane.branchName else { return nil }
    let launchId = UUID().uuidString.lowercased()
    var fields: [String: RemoteJSONValue] = [
      "launchId": .string(launchId),
      "kind": .string("lane"),
      "project": .object(["origin": .string(origin)]),
      // The desktop's `cloudLaneRestartBranchRef`: the branch as GitHub has it.
      "lane": .object([
        "id": .string(lane.laneId),
        "name": .string(lane.laneName),
        "existingBranch": .string("origin/\(branch)"),
      ]),
      "madeBy": .object(["kind": .string("person")]),
    ]
    if let sizeId { fields["sizeId"] = .string(sizeId) }
    let body: RemoteJSONValue = .object(fields)
    entries.insert(Entry(
      launchId: launchId,
      origin: origin.lowercased(),
      prompt: "",
      body: body,
      kind: "lane",
      laneId: lane.laneId,
      laneName: lane.laneName,
      startedHere: true
    ), at: 0)
    await runStart(launchId, body: body, using: sync)
    return launchId
  }

  /// The newest lane launch for a lane that this phone shows (not hidden).
  /// This kept lane's launch from "New computer", while the phone shows it.
  /// One that made the lane's former computer is over: that computer was
  /// freed since, and the lane may get another.
  ///
  /// Only the newest launch for the lane counts: when it made the former
  /// computer, every older one is over too. A hidden one that is still on its
  /// way keeps holding New computer, so a second computer can't start.
  func laneLaunch(for lane: CloudLaneWithoutComputer) -> Entry? {
    guard let newest = entries.first(where: { $0.isLane && $0.laneId == lane.laneId && $0.record?.state != "cancelled" }) else { return nil }
    if let former = lane.formerInstanceId, newest.record?.instanceId == former { return nil }
    if hiddenIds.contains(newest.launchId) && !newest.awaitsChat { return nil }
    return newest
  }

  /// Lane launches still on their way, or failed and not hidden: `origin`'s, or every project's.
  func openLaneLaunches(origin: String?) -> [Entry] {
    let key = origin?.lowercased()
    return entries.filter { entry in
      entry.isLane && (key == nil || entry.origin == key) && entry.record?.state != "cancelled"
        && !hiddenIds.contains(entry.launchId)
    }
  }

  /// Starts again a launch whose start failed, or whose computer failed
  /// before its agent started (the same id, `retry`).
  func retry(_ launchId: String, using sync: SyncService) async {
    guard let index = entries.firstIndex(where: { $0.launchId == launchId }),
          case .object(var fields)? = entries[index].body ?? entries[index].record?.request else { return }
    if entries[index].record != nil { fields["retry"] = .bool(true) }
    entries[index].startError = nil
    await runStart(launchId, body: .object(fields), using: sync)
  }

  private func runStart(_ launchId: String, body: RemoteJSONValue, using sync: SyncService) async {
    // One start per launch at a time: two cards retrying it would upload and
    // drop each other's files.
    guard !startingLaunchIds.contains(launchId) else { return }
    startingLaunchIds.insert(launchId)
    defer { startingLaunchIds.remove(launchId) }
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient() else {
      patch(launchId) {
        $0.startError = "Sign in to ADE to start a chat on ADE Cloud."
        $0.startNeverReached = true
      }
      return
    }
    // Each file goes once; a failed upload stops here and Retry sends the rest.
    while let file = pendingFiles[launchId]?.first {
      do {
        _ = try await client.uploadLaunchFile(launchId: launchId, fileId: file.fileId, data: file.data, contentType: file.contentType)
        // Signed out or another account meanwhile: start nothing for it.
        guard generation == accountGeneration else { return }
        pendingFiles[launchId]?.removeAll { $0.fileId == file.fileId }
      } catch {
        guard generation == accountGeneration else { return }
        let reason = cloudServerFailureMessage(error)
        patch(launchId) {
          $0.startError = "ADE couldn't send \(file.name) to ADE Cloud. \(reason)"
          // The start goes after the files: it was not sent.
          $0.startNeverReached = true
        }
        return
      }
    }
    pendingFiles[launchId] = nil
    do {
      let record = try await client.startLaunch(body)
      guard generation == accountGeneration else { return }
      patch(launchId) {
        $0.record = record
        $0.startError = nil
        $0.startNeverReached = false
      }
      poll(using: sync)
    } catch {
      guard generation == accountGeneration else { return }
      let message = cloudServerFailureMessage(error)
      // A 409 (`create_in_progress`) means a start under this id is still
      // making the computer: the launch exists, so its page stays and Retry
      // sends the same id. A new id would make a second computer.
      let conflict: Bool = {
        if case .server(409, _)? = error as? CloudServerClient.Failure { return true }
        return false
      }()
      let refused = Self.isClearRefusal(error) && !conflict
      patch(launchId) {
        $0.startError = message
        $0.startNeverReached = refused
      }
    }
  }

  /// The server answered no, so it kept nothing under the id. Not a lost
  /// answer, an unreadable one or a server error: those may have gone through.
  private static func isClearRefusal(_ error: Error) -> Bool {
    switch error as? CloudServerClient.Failure {
    case .refused?, .noAccess?, .unauthorized?: return true
    case .server(let status, _)?: return (400..<500).contains(status)
    default: return false
    }
  }

  /// Cancels a launch still on its way. Answers the server's reason when it refused.
  func cancel(_ launchId: String, using sync: SyncService) async -> String? {
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient() else { return "Sign in to ADE to cancel this chat." }
    do {
      let record = try await client.cancelLaunch(launchId)
      if generation == accountGeneration { patch(launchId) { $0.record = record } }
      return nil
    } catch {
      return cloudServerFailureMessage(error)
    }
  }

  /// Reads one launch again now (after a sign-in step).
  func refresh(_ launchId: String, using sync: SyncService) async {
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient() else { return }
    let record: CloudLaunchRecord
    do {
      record = try await client.launch(launchId)
    } catch {
      Self.noteReadFailed("status", error)
      return
    }
    guard generation == accountGeneration else { return }
    patch(launchId) { $0.record = record }
    connectWhenReady(using: sync)
    poll(using: sync)
  }

  private func patch(_ launchId: String, _ change: (inout Entry) -> Void) {
    guard let index = entries.firstIndex(where: { $0.launchId == launchId }) else { return }
    change(&entries[index])
  }

  /// Reads a chat launch's messages again (its page shows the later ones).
  func loadMessages(_ launchId: String, using sync: SyncService) async {
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient() else { return }
    let sendsBefore = messageSends[launchId, default: 0]
    let messages: [CloudLaunchMessage]
    do {
      messages = try await client.launchMessages(launchId)
    } catch {
      Self.noteReadFailed("messages", error)
      if generation == accountGeneration { messageReadFailed.insert(launchId) }
      return
    }
    guard generation == accountGeneration else { return }
    messageReadFailed.remove(launchId)
    // A launch from another device lists with no message: the first one is row 1.
    if let first = messages.first(where: { $0.seq == 1 }),
       entries.first(where: { $0.launchId == launchId })?.prompt.isEmpty == true {
      patch(launchId) { $0.prompt = first.text }
    }
    guard messageSends[launchId, default: 0] == sendsBefore else { return }
    let later = messages.filter { $0.seq > 1 }.sorted { $0.seq < $1.seq }
    if laterMessages[launchId] != later { laterMessages[launchId] = later }
  }

  /// Sends a message to a chat launch whose chat doesn't run yet: ADE Cloud
  /// keeps it and the computer sends it after the first one. Answers the
  /// sentence to show when the server refused it.
  func addMessage(_ launchId: String, text: String, using sync: SyncService) async -> String? {
    let generation = accountGeneration
    guard let client = await sync.cloudServerClient() else { return "Sign in to ADE to send this message." }
    let messageId = unconfirmedMessages[launchId].flatMap { $0.text == text ? $0.messageId : nil } ?? Self.newMessageId()
    unconfirmedMessages[launchId] = (text, messageId)
    do {
      let message = try await client.addLaunchMessage(launchId, messageId: messageId, text: text)
      guard generation == accountGeneration else { return nil }
      unconfirmedMessages[launchId] = nil
      messageSends[launchId, default: 0] += 1
      var later = laterMessages[launchId] ?? []
      if !later.contains(where: { $0.messageId == message.messageId }) {
        later.append(message)
        laterMessages[launchId] = later.sorted { $0.seq < $1.seq }
      }
      return nil
    } catch {
      cloudLaunchLog.warning("cloud_launch message=add failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
      CrashReporting.breadcrumb("cloud_launch", message: "message_add_failed", data: [:])
      guard generation == accountGeneration else { return cloudServerFailureMessage(error) }
      let failure = error as? CloudServerClient.Failure
      // A clear answer: the server kept nothing under this id.
      if Self.isClearRefusal(error) { unconfirmedMessages[launchId] = nil }
      // `chat_ready` or `launch_closed`: the launch moved on. Read it now, so
      // the page opens the chat (with this message as its draft) or shows
      // why, without waiting for the next poll.
      if case .server(409, _)? = failure {
        await refresh(launchId, using: sync)
      }
      return cloudServerFailureMessage(error)
    }
  }

  /// A launch message id the server takes (`^[A-Za-z0-9_-]{1,64}$`).
  private static func newMessageId() -> String {
    "msg_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(24)
  }

  /// Connects a launch's new computer, with no wake, so its chat or lane
  /// lists in Work (`connectLaunchedCloudComputer`). One connect at a time
  /// per launch: the automatic one and the page's Open chat share it. True
  /// when the computer has a live link.
  @discardableResult
  func connectComputer(_ launchId: String, using sync: SyncService) async -> Bool {
    if let running = connectTasks[launchId] { return await running.value }
    guard let instanceId = entries.first(where: { $0.launchId == launchId })?.record?.instanceId
      .flatMap({ nonEmptyTrimmed($0) }) else { return false }
    let generation = accountGeneration
    let task = Task { @MainActor in await sync.connectLaunchedCloudComputer(instanceId: instanceId) }
    connectTasks[launchId] = task
    let live = await task.value
    if generation == accountGeneration { connectTasks[launchId] = nil }
    if !live {
      cloudLaunchLog.notice("cloud_launch connect=launched_computer live=false")
      CrashReporting.breadcrumb("cloud_launch", message: "connect_not_live", data: [:])
    }
    return live
  }

  /// Once a launch this phone started runs (its chat exists, or a lane
  /// launch's computer has the lane), the phone connects that new computer,
  /// so the chat lists in Work while the app stays open. One try, and one
  /// more 10 s later; after that the launch page's Open chat tries again. A
  /// launch from another device connects only when its page opens: a
  /// connect keeps the computer live, and that is the person's choice.
  private func connectWhenReady(using sync: SyncService) {
    for entry in entries where entry.startedHere
      && !autoConnectedLaunchIds.contains(entry.launchId)
      && !hiddenIds.contains(entry.launchId) {
      guard entry.startError == nil, let record = entry.record, record.instanceId != nil else { continue }
      let ready = entry.isLane ? record.reachedRunning : record.sessionId != nil
      guard ready else { continue }
      autoConnectedLaunchIds.insert(entry.launchId)
      let launchId = entry.launchId
      let generation = accountGeneration
      Task { @MainActor [weak self] in
        for attempt in 0..<2 {
          guard let self, generation == self.accountGeneration else { return }
          if await self.connectComputer(launchId, using: sync) { return }
          if attempt == 0 { try? await Task.sleep(for: .seconds(10)) }
        }
      }
    }
  }

  /// One loop for every launch in progress; it ends when none is left.
  private func poll(using sync: SyncService) {
    guard pollTask == nil, entries.contains(where: { $0.awaitsChat && !hiddenIds.contains($0.launchId) }) else { return }
    pollGeneration += 1
    let generation = pollGeneration
    pollTask = Task { @MainActor [weak self] in
      var delay: UInt64 = 3
      while let self, !Task.isCancelled {
        try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
        if Task.isCancelled { break }
        // Paused while the app is in the background.
        if UIApplication.shared.applicationState != .active { delay = 10; continue }
        let open = self.entries.filter { $0.awaitsChat && !self.hiddenIds.contains($0.launchId) }
        if open.isEmpty { break }
        guard let client = await sync.cloudServerClient() else { break }
        var changed = false
        for entry in open {
          let record: CloudLaunchRecord
          do {
            record = try await client.launch(entry.launchId)
          } catch {
            // The last record stays; the next tick reads it again.
            Self.noteReadFailed("status", error)
            continue
          }
          // A reset while this read was out: the loop is cancelled, and its answer is the last account's.
          if Task.isCancelled || self.pollGeneration != generation { break }
          if record != entry.record {
            changed = true
            self.patch(entry.launchId) { $0.record = record }
          }
        }
        if changed { self.connectWhenReady(using: sync) }
        delay = changed ? 3 : min(delay + 2, 10)
      }
      // After a reset a newer loop may own the handle: clear only this one's.
      if let self, self.pollGeneration == generation { self.pollTask = nil }
    }
  }

  /// A read failed; the last record stays and the next read tries again.
  private static func noteReadFailed(_ read: String, _ error: Error) {
    cloudLaunchLog.warning("cloud_launch read=\(read, privacy: .public) failed error=\(CrashReporting.redactedErrorDescription(error), privacy: .public)")
    CrashReporting.breadcrumb("cloud_launch", message: "read_failed", data: ["read": read])
  }

  /// An account change: the last account's launches go.
  #if DEBUG
  /// Fixture screens only: a model list (or a failed read) and launches, with no account server.
  func seedPreview(catalog: CloudModelCatalog?, catalogError: String?, entries: [Entry]) {
    self.catalog = catalog
    self.catalogError = catalogError
    self.entries = entries
    activeReadAt = Date.distantFuture
  }
  #endif

  func reset() {
    pollTask?.cancel()
    pollTask = nil
    pollGeneration += 1
    carriedSignIns = [:]
    accountGeneration += 1
    entries = []
    pendingFiles = [:]
    hiddenIds = []
    autoConnectedLaunchIds = []
    connectTasks = [:]
    unconfirmedMessages = [:]
    messageSends = [:]
    messageReadFailed = []
    laterMessages = [:]
    activeReadAt = nil
  }
}
