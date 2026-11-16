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

  private enum CodingKeys: String, CodingKey {
    case launchId, state, projectOrigin, laneId, laneName, instanceId, stages, sessionId, error, signIn, provider, modelId, request
  }
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
    projectOrigin = c.lenient(String.self, forKey: .projectOrigin)
    laneId = c.lenient(String.self, forKey: .laneId)
    laneName = c.lenient(String.self, forKey: .laneName)
    instanceId = c.lenient(String.self, forKey: .instanceId)
    stages = c.lenient([CloudLaunchStage].self, forKey: .stages) ?? []
    sessionId = c.lenient(String.self, forKey: .sessionId)
    error = c.lenient(String.self, forKey: .error)
    signIn = c.lenient(CloudLaunchSignIn.self, forKey: .signIn)
    let chatRequest = c.lenient(Request.self, forKey: .request)
    provider = c.lenient(String.self, forKey: .provider) ?? chatRequest?.chat?.provider
    modelId = c.lenient(String.self, forKey: .modelId) ?? chatRequest?.chat?.modelId
    prompt = chatRequest?.chat?.prompt
    request = c.lenient(RemoteJSONValue.self, forKey: .request)
  }

  /// Still on its way to a running chat.
  var inProgress: Bool {
    ["draft", "making", "joining", "needs_approval", "joined", "waiting_for_sign_in"].contains(state)
  }
  var failed: Bool { state == "failed" || state == "cancelled" }
}

struct CloudCatalogModel: Decodable, Equatable, Hashable {
  let id: String
  let displayName: String
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
  let providers: [CloudCatalogProvider]
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

  private enum CodingKeys: String, CodingKey { case signIns, unknown }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    signIns = c.lenient([CloudAccountSignIn].self, forKey: .signIns) ?? []
    unknown = c.lenient(Bool.self, forKey: .unknown) ?? false
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
    try decodeBody(CloudModelCatalog.self, from: try await send("GET", "cloud/models"))
  }

  /// 201 for a new launch; the same `launchId` again answers the same launch.
  func startLaunch(_ body: RemoteJSONValue) async throws -> CloudLaunchRecord {
    let data = try JSONEncoder().encode(body)
    return try decodeBody(CloudLaunchRecord.self, from: try await send("POST", "cloud/launches", body: data, timeout: 48))
  }

  func launch(_ launchId: String) async throws -> CloudLaunchRecord {
    try decodeBody(CloudLaunchRecord.self, from: try await send("GET", "cloud/launches/\(launchId)"))
  }

  /// The account's launches still in progress, and failures of the last day.
  func activeLaunches() async throws -> [CloudLaunchRecord] {
    try decodeBody(LaunchList.self, from: try await send("GET", "cloud/launches", query: [URLQueryItem(name: "active", value: "1")])).launches
  }

  func accountSignIns() async throws -> CloudAccountSignIns {
    try decodeBody(CloudAccountSignIns.self, from: try await send("GET", "cloud/sign-ins"))
  }

  func saveAccountSignIn(_ signInId: String, key: String) async throws -> CloudAccountSignIns {
    let data = try JSONSerialization.data(withJSONObject: ["key": key])
    return try decodeBody(CloudAccountSignIns.self, from: try await send("PUT", "cloud/sign-ins/\(pathSegment(signInId))", body: data))
  }

  func removeAccountSignIn(_ signInId: String) async throws -> CloudAccountSignIns {
    try decodeBody(CloudAccountSignIns.self, from: try await send("DELETE", "cloud/sign-ins/\(pathSegment(signInId))"))
  }

  /// A code pasted from the provider's page, for a sign-in on the computer.
  /// Answers the reason when the code did not work.
  func sendSignInCode(instanceId: String, jobId: String, code: String) async throws -> String? {
    let data = try JSONSerialization.data(withJSONObject: ["code": code])
    let status = try decodeBody(
      CloudSignInCodeStatus.self,
      from: try await send("POST", "cloud/instances/\(pathSegment(instanceId))/sign-ins/\(pathSegment(jobId))/code", body: data, timeout: 100)
    )
    return status.state == "failed" ? (status.reason ?? "The code didn't work. Open the page again for a new one.") : nil
  }

  private func pathSegment(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
  }

  private func decodeBody<T: Decodable>(_ type: T.Type, from data: Data) throws -> T {
    do { return try JSONDecoder().decode(type, from: data) } catch { throw Failure.unreadable }
  }
}

/// One plain sentence for a failed account-server call.
func cloudServerFailureMessage(_ error: Error) -> String {
  switch error as? CloudServerClient.Failure {
  case .noAccess: return "ADE Cloud isn't open for this account."
  case .unauthorized: return "Sign in to ADE again, then try again."
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
    /// The start this phone sent; a launch found from another device uses its record's `request`.
    var body: RemoteJSONValue?

    var inProgress: Bool { startError == nil && (record?.inProgress ?? true) }
  }

  @Published private(set) var entries: [Entry] = []
  @Published private(set) var catalog: CloudModelCatalog?
  @Published private(set) var catalogError: String?

  private var pollTask: Task<Void, Never>?
  /// Bumped for each poll loop and by `reset`: a loop clears the handle only while it is still the current one.
  private var pollGeneration = 0
  private var activeReadAt: Date?
  private static let lastModelKey = "ade.cloudChat.lastModel.v1"

  func entries(forOrigin origin: String) -> [Entry] {
    let key = origin.lowercased()
    return entries.filter { $0.origin == key && $0.record?.state != "cancelled" }
  }

  func loadCatalogIfNeeded(using sync: SyncService) async {
    guard catalog == nil else { return }
    guard let client = await sync.cloudServerClient() else { return }
    do {
      catalog = try await client.modelCatalog()
      catalogError = nil
    } catch {
      catalogError = cloudServerFailureMessage(error)
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
    guard let client = await sync.cloudServerClient() else { return }
    let list: [CloudLaunchRecord]
    do {
      list = try await client.activeLaunches()
    } catch {
      // The next look (a page that opens, or 20 s later) tries again.
      activeReadAt = nil
      Self.noteReadFailed("active", error)
      return
    }
    for record in list where !entries.contains(where: { $0.launchId == record.launchId }) {
      entries.append(Entry(
        launchId: record.launchId,
        origin: record.projectOrigin?.lowercased(),
        prompt: record.prompt ?? "",
        provider: record.provider,
        modelId: record.modelId,
        record: record
      ))
    }
    poll(using: sync)
  }

  /// Starts a chat on ADE Cloud for one of the account's projects.
  func start(accountProjectId: String, origin: String, prompt: String, provider: String, modelId: String, using sync: SyncService) async {
    UserDefaults.standard.set(["provider": provider, "modelId": modelId], forKey: Self.lastModelKey)
    let launchId = UUID().uuidString.lowercased()
    let messageId = "msg_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased().prefix(24)
    let body: RemoteJSONValue = .object([
      "launchId": .string(launchId),
      "kind": .string("chat"),
      // The server reads the origin from the account's project.
      "project": .object(["accountProjectId": .string(accountProjectId)]),
      "chat": .object([
        "provider": .string(provider),
        "modelId": .string(modelId),
        "permissions": .string("default"),
        "prompt": .string(prompt),
        "messageId": .string(String(messageId)),
      ]),
      "madeBy": .object(["kind": .string("person")]),
    ])
    entries.insert(Entry(
      launchId: launchId,
      origin: origin.lowercased(),
      prompt: prompt,
      provider: provider,
      modelId: modelId,
      body: body
    ), at: 0)
    await runStart(launchId, body: body, using: sync)
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
    guard let client = await sync.cloudServerClient() else {
      patch(launchId) { $0.startError = "Sign in to ADE to start a chat on ADE Cloud." }
      return
    }
    do {
      let record = try await client.startLaunch(body)
      patch(launchId) {
        $0.record = record
        $0.startError = nil
      }
      poll(using: sync)
    } catch {
      let message = cloudServerFailureMessage(error)
      patch(launchId) { $0.startError = message }
    }
  }

  /// Reads one launch again now (after a sign-in step).
  func refresh(_ launchId: String, using sync: SyncService) async {
    guard let client = await sync.cloudServerClient() else { return }
    let record: CloudLaunchRecord
    do {
      record = try await client.launch(launchId)
    } catch {
      Self.noteReadFailed("status", error)
      return
    }
    patch(launchId) { $0.record = record }
    poll(using: sync)
  }

  private func patch(_ launchId: String, _ change: (inout Entry) -> Void) {
    guard let index = entries.firstIndex(where: { $0.launchId == launchId }) else { return }
    change(&entries[index])
  }

  /// One loop for every launch in progress; it ends when none is left.
  private func poll(using sync: SyncService) {
    guard pollTask == nil, entries.contains(where: { $0.inProgress && $0.record != nil }) else { return }
    pollGeneration += 1
    let generation = pollGeneration
    pollTask = Task { @MainActor [weak self] in
      var delay: UInt64 = 3
      while let self, !Task.isCancelled {
        try? await Task.sleep(nanoseconds: delay * 1_000_000_000)
        if Task.isCancelled { break }
        // Paused while the app is in the background.
        if UIApplication.shared.applicationState != .active { delay = 10; continue }
        let open = self.entries.filter { $0.inProgress && $0.record != nil }
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
          if record != entry.record {
            changed = true
            self.patch(entry.launchId) { $0.record = record }
          }
        }
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
  func reset() {
    pollTask?.cancel()
    pollTask = nil
    pollGeneration += 1
    entries = []
    activeReadAt = nil
  }
}
