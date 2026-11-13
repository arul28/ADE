import CryptoKit
import Foundation
import os

private let accountProjectsLog = Logger(subsystem: "com.ade.ios", category: "account-projects")

// The account's project list (`GET /account/projects` on the account
// directory). A project is a GitHub repository on the account, with no
// machine; a copy is one folder of it on one machine. The Hub lists these
// projects, so an account with no computer still sees its projects, and a
// failed connection never hides them. Shapes mirror
// `apps/account-directory/src/accountProjects/contract.ts`.
//
// The list is read on events only (sign-in, the app coming to the
// foreground, the Hub appearing, pull to refresh, a repository the list does
// not know yet). There is no timer. Each read sends the last cursor, so an
// unchanged list answers with no rows.

// MARK: - Wire types

struct AccountProjectCopy: Codable, Equatable, Hashable {
  let projectId: String
  /// The account machine key (`AccountMachine.machineKey`), not the phone's
  /// fleet key. The directory checks it against the account's machines.
  let machineKey: String
  /// The machine's registry id of the folder (`project_<hash>`), the same id
  /// that machine's project catalog sends as `MobileProjectSummary.id`.
  let checkoutId: String
  let rootPath: String
  let isMain: Bool
  /// Epoch ms.
  let lastSeenAt: Double
}

struct AccountProject: Codable, Equatable, Hashable, Identifiable {
  let id: String
  /// Lowercase GitHub host: `github.com`, or a GitHub Enterprise host.
  let host: String
  let repoId: Int?
  /// `repo:<host>/<owner>/<name>`.
  let repoKey: String
  let owner: String
  let name: String
  let defaultBranch: String?
  let addedAt: Double
  let removedAt: Double?
  let mergedInto: String?
  let aliases: [String]
  let copies: [AccountProjectCopy]

  var isLive: Bool { removedAt == nil && mergedInto == nil }

  /// `owner/name` on github.com, `host/owner/name` on another GitHub host.
  var addressLabel: String {
    host == "github.com" ? "\(owner)/\(name)" : "\(host)/\(owner)/\(name)"
  }
}

struct AccountProjectListResponse: Decodable, Equatable {
  let cursor: Int
  let reset: Bool
  let projects: [AccountProject]
}

/// One GitHub repository as `POST /account/projects` names it.
struct AccountProjectIdentity: Encodable, Equatable {
  let host: String
  let owner: String
  let name: String
  /// `repo:<host>/<owner>/<name>`, lower case (the brain's `githubRepoKey`).
  let repoKey: String
  var repoId: Int? = nil
  var defaultBranch: String? = nil

  init(host: String = "github.com", owner: String, name: String, repoId: Int? = nil, defaultBranch: String? = nil) {
    self.host = host.lowercased()
    self.owner = owner
    self.name = name
    self.repoKey = "repo:\(host)/\(owner)/\(name)".lowercased()
    self.repoId = repoId
    self.defaultBranch = defaultBranch
  }

  /// The repository of a machine folder, when it has a GitHub remote the
  /// machine could read. Nil for a folder with no remote or another host.
  init?(folder: MobileProjectSummary) {
    guard let owner = folder.repoOwner?.trimmingCharacters(in: .whitespacesAndNewlines), !owner.isEmpty,
          let name = folder.repoName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty
    else { return nil }
    self.init(owner: owner, name: name, repoId: folder.githubRepoId, defaultBranch: folder.defaultBaseRef)
  }
}

/// An error answer: `{error: {code, message}}`.
struct AccountProjectChangeFailure: Decodable {
  struct Body: Decodable { let message: String? }
  let error: Body?
}

/// The answer of an add: the project, and whether it is new to the account,
/// came back from a removal, or was already there (the folder is a copy).
struct AccountProjectAddResponse: Decodable, Equatable {
  let project: AccountProject
  let created: Bool
  let revived: Bool
  let cursor: Int
}

struct AccountProjectRemoveResponse: Decodable, Equatable {
  let project: AccountProject
  let cursor: Int
}

/// What the Hub remembers about a project from the last machine that showed
/// it: the account row has no icon. (The card's name is the account's.)
struct AccountProjectDisplay: Codable, Equatable {
  var iconDataUrl: String?
}

// MARK: - The list, as the phone holds it

/// Every row the phone knows (removed and merged rows included), and the
/// cursor to read changes after. Pure: the store owns persistence.
struct AccountProjectListState: Codable, Equatable {
  var cursor: Int?
  var rows: [String: AccountProject] = [:]
  /// The copies a project had before the account removed it (the directory
  /// drops them), kept on this phone only. A folder that matched only by its
  /// copy (a GitHub Enterprise project) then still names the removed project,
  /// so its card hides. Nil in a cache from an older build.
  var removedCopies: [String: [AccountProjectCopy]]?

  /// Projects on the account now, oldest first (a stable order for new cards).
  var liveProjects: [AccountProject] {
    rows.values.filter(\.isLive).sorted { lhs, rhs in
      lhs.addedAt == rhs.addedAt ? lhs.id < rhs.id : lhs.addedAt < rhs.addedAt
    }
  }

  /// Rows that were removed from the account (not merged ones: a merged row's
  /// addresses belong to the project it merged into).
  var removedProjects: [AccountProject] {
    rows.values.filter { $0.removedAt != nil && $0.mergedInto == nil }.sorted { $0.id < $1.id }.map { row in
      guard row.copies.isEmpty, let copies = removedCopies?[row.id] else { return row }
      return AccountProject(
        id: row.id, host: row.host, repoId: row.repoId, repoKey: row.repoKey, owner: row.owner, name: row.name,
        defaultBranch: row.defaultBranch, addedAt: row.addedAt, removedAt: row.removedAt,
        mergedInto: row.mergedInto, aliases: row.aliases, copies: copies
      )
    }
  }

  /// Merged project id -> the live project it now is. A chain of merges is
  /// followed to its end; a merge into a project the phone does not hold, or
  /// into a removed one, is left out.
  var mergedTargets: [String: String] {
    var targets: [String: String] = [:]
    for row in rows.values where row.mergedInto != nil {
      var target = row.mergedInto
      var hops = 0
      while let id = target, let next = rows[id]?.mergedInto, hops < 8 {
        target = next
        hops += 1
      }
      if let id = target, rows[id]?.isLive == true { targets[row.id] = id }
    }
    return targets
  }

  /// A list answer: `reset` replaces everything, otherwise each row replaces
  /// the row with its id.
  func applying(_ response: AccountProjectListResponse) -> AccountProjectListState {
    var next = self
    if response.reset { next.rows = [:] }
    for project in response.projects {
      next.put(project, previous: rows[project.id])
    }
    if response.reset, let kept = next.removedCopies {
      let held = kept.filter { next.rows[$0.key] != nil }
      next.removedCopies = held.isEmpty ? nil : held
    }
    next.cursor = response.cursor
    return next
  }

  /// Puts one row. A row that turns removed keeps the copies it had (see
  /// `removedCopies`); any other row drops what was kept for it.
  mutating func put(_ project: AccountProject, previous: AccountProject?) {
    rows[project.id] = project
    var kept = removedCopies ?? [:]
    if project.removedAt != nil, project.mergedInto == nil, project.copies.isEmpty {
      if let previous, !previous.copies.isEmpty { kept[project.id] = previous.copies }
    } else {
      kept[project.id] = nil
    }
    removedCopies = kept.isEmpty ? nil : kept
  }
}

// MARK: - Client

/// The phone's client for the account project routes. Same shape as
/// `AccountDirectoryClient.fetchMachines`: one bearer, a correlation id, a
/// 12-second timeout, one retry after a 401 with a refreshed token.
struct AccountProjectsClient {
  enum ListError: Error, Equatable {
    /// The directory has no project list (an older server).
    case unsupported
    case unauthorized
    case server(Int)
    case transport
    case unreadable
  }

  var session: URLSession = .shared

  func list(
    baseURL: URL,
    token: String,
    since: Int?,
    refreshToken: (() async -> String?)? = nil
  ) async throws -> AccountProjectListResponse {
    let correlationID = UUID().uuidString.lowercased()
    var components = URLComponents(
      url: baseURL.appendingPathComponent("account/projects"),
      resolvingAgainstBaseURL: false
    )
    if let since { components?.queryItems = [URLQueryItem(name: "since", value: String(since))] }
    guard let url = components?.url else { throw ListError.transport }

    func send(_ accessToken: String) async throws -> (Data, HTTPURLResponse) {
      var request = URLRequest(url: url)
      request.httpMethod = "GET"
      request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.setValue(correlationID, forHTTPHeaderField: "X-ADE-Correlation-ID")
      request.timeoutInterval = 12
      request.cachePolicy = .reloadIgnoringLocalCacheData
      let data: Data
      let response: URLResponse
      do {
        (data, response) = try await session.data(for: request)
      } catch {
        throw ListError.transport
      }
      guard let http = response as? HTTPURLResponse else { throw ListError.transport }
      return (data, http)
    }

    var (data, http) = try await send(token)
    if http.statusCode == 401,
       let refreshToken,
       let refreshed = await refreshToken()?.trimmingCharacters(in: .whitespacesAndNewlines),
       !refreshed.isEmpty {
      (data, http) = try await send(refreshed)
    }
    switch http.statusCode {
    case 200:
      do {
        return try JSONDecoder().decode(AccountProjectListResponse.self, from: data)
      } catch {
        throw ListError.unreadable
      }
    case 401, 403:
      throw ListError.unauthorized
    case 404:
      // The list route never answers 404 for a signed-in caller; a 404 is a
      // directory from before the account project list.
      throw ListError.unsupported
    default:
      throw ListError.server(http.statusCode)
    }
  }

  /// A change the account refused or could not make, with the server's own
  /// sentence when it sent one.
  struct ChangeError: Error, Equatable {
    let status: Int?
    let message: String
  }

  func add(baseURL: URL, token: String, identity: AccountProjectIdentity,
           refreshToken: (() async -> String?)? = nil) async throws -> AccountProjectAddResponse {
    try await change(
      url: baseURL.appendingPathComponent("account/projects"),
      body: try JSONEncoder().encode(identity),
      token: token,
      refreshToken: refreshToken
    )
  }

  func remove(baseURL: URL, token: String, projectId: String,
              refreshToken: (() async -> String?)? = nil) async throws -> AccountProjectRemoveResponse {
    try await change(
      url: baseURL.appendingPathComponent("account/projects").appendingPathComponent(projectId).appendingPathComponent("remove"),
      body: Data("{}".utf8),
      token: token,
      refreshToken: refreshToken
    )
  }

  private func change<Response: Decodable>(
    url: URL,
    body: Data,
    token: String,
    refreshToken: (() async -> String?)?
  ) async throws -> Response {
    let correlationID = UUID().uuidString.lowercased()
    func send(_ accessToken: String) async throws -> (Data, HTTPURLResponse) {
      var request = URLRequest(url: url)
      request.httpMethod = "POST"
      request.httpBody = body
      request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.setValue(correlationID, forHTTPHeaderField: "X-ADE-Correlation-ID")
      request.timeoutInterval = 12
      do {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
          throw ChangeError(status: nil, message: "ADE can't reach your account right now. Try again.")
        }
        return (data, http)
      } catch let error as ChangeError {
        throw error
      } catch {
        throw ChangeError(status: nil, message: "ADE can't reach your account right now. Try again.")
      }
    }
    var (data, http) = try await send(token)
    if http.statusCode == 401,
       let refreshToken,
       let refreshed = await refreshToken()?.trimmingCharacters(in: .whitespacesAndNewlines),
       !refreshed.isEmpty {
      (data, http) = try await send(refreshed)
    }
    guard (200..<300).contains(http.statusCode) else {
      let message = (try? JSONDecoder().decode(AccountProjectChangeFailure.self, from: data))?.error?.message
      switch http.statusCode {
      case 401, 403:
        throw ChangeError(status: http.statusCode, message: "Sign in to ADE again, then try again.")
      default:
        throw ChangeError(status: http.statusCode, message: message ?? "Your ADE account could not make that change. Try again.")
      }
    }
    do {
      return try JSONDecoder().decode(Response.self, from: data)
    } catch {
      throw ChangeError(status: http.statusCode, message: "Your ADE account sent an answer ADE can't read.")
    }
  }
}

// MARK: - Store

/// The signed-in account's project list, with an offline cache per account.
/// `AccountService` activates it on sign-in and clears it on sign-out; the
/// Hub reads it.
@MainActor
final class AccountProjectStore: ObservableObject {
  static let shared = AccountProjectStore()

  enum Phase: Equatable {
    /// No account is signed in.
    case inactive
    /// No directory URL in this build.
    case unconfigured
    /// The first read for this account is running and nothing is cached.
    case loading
    case ready
    /// The last read failed. The cached list (if any) is still shown.
    case offline
    /// The directory has no project list. The Hub works from the machines.
    case unsupported
  }

  /// Least time between two reads that an event (not the user) starts.
  static let eventRefreshFloor: TimeInterval = 60
  /// Least time between two reads that a return to the foreground starts.
  static let foregroundRefreshFloor: TimeInterval = 10
  /// An older server is asked again at most this often.
  static let unsupportedRetryFloor: TimeInterval = 60 * 60
  private static let failureFloors: [TimeInterval] = [5, 10, 20, 40, 80, 160, 300]
  /// Icons larger than this are not cached: 500 projects must stay small.
  private static let maxCachedIconBytes = 48 * 1024

  @Published private(set) var phase: Phase = .inactive
  @Published private(set) var liveProjects: [AccountProject] = []
  @Published private(set) var removedProjects: [AccountProject] = []
  /// Merged project id -> the live project it now is (`AccountProjectListState.mergedTargets`).
  @Published private(set) var mergedTargets: [String: String] = [:]
  @Published private(set) var display: [String: AccountProjectDisplay] = [:]
  /// When a read last succeeded (from the cache on launch). Nil = never.
  @Published private(set) var lastSuccessAt: Date?
  /// Bumps on every change the Hub must rebuild for.
  @Published private(set) var revision = 0

  private var userId: String?
  /// The account whose list the store holds, also while the phone waits for
  /// Clerk to restore the session (`activate(userId:beforeSession:)`).
  var activeUserId: String? { userId }
  private var state = AccountProjectListState()
  /// Every row the phone holds, removed and merged rows included.
  var listState: AccountProjectListState { state }
  private var lastAttemptAt: Date?
  private var failureCount = 0
  /// Activated from the device owner before Clerk restored the session.
  private var awaitingSession = false
  private var inFlight: Task<Void, Never>?
  /// Rows this phone added or removed, with the list cursor after each
  /// change. A read that answers an older cursor started before the change,
  /// so the row stays as the change left it until a read includes it.
  private var pendingChanges: [String: (row: AccountProject, cursor: Int)] = [:]
  /// Repository identities a "this repository is new" read already asked
  /// about, so one unpublished folder does not cause a read on every rebuild.
  private var askedUnknownIdentities = Set<String>()
  private let client = AccountProjectsClient()
  /// Cache writes and deletes run in order, off the main thread.
  private nonisolated static let cacheQueue = DispatchQueue(label: "com.ade.ios.account-projects-cache", qos: .utility)
  private let fileManager = FileManager.default

  /// The cache holds at least one read, so the Hub has a list to show.
  var hasList: Bool { lastSuccessAt != nil }

  /// The Hub lists the account's projects (signed in, and the server has the list).
  var governsHub: Bool {
    switch phase {
    case .loading, .ready, .offline: return true
    case .inactive, .unconfigured, .unsupported: return false
    }
  }

  /// The account `userId` signed in (a cached session at launch, a sign-in,
  /// or an account switch). Loads that account's cache at once, so a first
  /// frame offline already shows its projects.
  ///
  /// `beforeSession`: the phone's owner, at launch, before Clerk restored the
  /// session. A read cannot run yet, so the first activation with the
  /// session restored reads at once instead of waiting out a failure floor.
  func activate(userId: String, beforeSession: Bool = false) {
    guard self.userId != userId else {
      if awaitingSession, !beforeSession {
        awaitingSession = false
        lastAttemptAt = nil
        refreshIfStale()
      }
      return
    }
    awaitingSession = beforeSession
    inFlight?.cancel()
    inFlight = nil
    pendingChanges = [:]
    self.userId = userId
    lastAttemptAt = nil
    failureCount = 0
    askedUnknownIdentities = []
    guard AccountConfig.directoryBaseURL != nil else {
      publish(state: AccountProjectListState(), display: [:], lastSuccessAt: nil, phase: .unconfigured)
      return
    }
    if let cached = readCache(userId: userId) {
      publish(state: cached.state, display: cached.display, lastSuccessAt: cached.fetchedAt, phase: .ready)
    } else {
      publish(state: AccountProjectListState(), display: [:], lastSuccessAt: nil, phase: .loading)
    }
  }

  /// The account signed out. An owner's explicit sign-out deletes that
  /// account's cache, with its chat logs; a switch keeps the cache of the
  /// account that left.
  func deactivate(deletingCacheOf ownerId: String?) {
    awaitingSession = false
    inFlight?.cancel()
    inFlight = nil
    pendingChanges = [:]
    if let ownerId { deleteCache(userId: ownerId) }
    userId = nil
    lastAttemptAt = nil
    failureCount = 0
    askedUnknownIdentities = []
    publish(state: AccountProjectListState(), display: [:], lastSuccessAt: nil, phase: .inactive)
  }

  /// Reads the list when an event asks for it and the floor allows: 60 s
  /// after the last read, longer after failures, an hour for an old server.
  func refreshIfStale() {
    refreshIfStale(readyFloor: Self.eventRefreshFloor)
  }

  /// The app came back to the foreground: read the changes since the cursor
  /// (one small request that answers an empty list when nothing changed), so
  /// a project removed or added elsewhere shows at once. A quick switch away
  /// and back within a few seconds does not read twice.
  func refreshOnForeground() {
    refreshIfStale(readyFloor: Self.foregroundRefreshFloor)
  }

  /// True when a read starts.
  @discardableResult
  private func refreshIfStale(readyFloor: TimeInterval) -> Bool {
    guard userId != nil else { return false }
    let floor: TimeInterval
    switch phase {
    case .unsupported: floor = Self.unsupportedRetryFloor
    case .offline: floor = Self.failureFloors[min(max(failureCount - 1, 0), Self.failureFloors.count - 1)]
    default: floor = readyFloor
    }
    if let lastAttemptAt, Date().timeIntervalSince(lastAttemptAt) < floor { return false }
    Task { await refresh() }
    return true
  }

  /// A machine shows GitHub repositories the list does not name. Reads once
  /// per new set of names (a brain may have just published them).
  func noteUnknownRepositories(_ identities: Set<String>) {
    guard phase == .ready, !identities.isEmpty else { return }
    let fresh = identities.subtracting(askedUnknownIdentities)
    guard !fresh.isEmpty else { return }
    // A read held back by the floor asks again on a later Hub pass.
    guard refreshIfStale(readyFloor: Self.eventRefreshFloor) else { return }
    askedUnknownIdentities.formUnion(fresh)
  }

  /// Reads the changes since the cursor now. A read already running is
  /// joined rather than doubled. With `changeCursor` (the cursor after a
  /// change this phone made), a joined read that ends before that cursor
  /// started too early, so one more read follows.
  func refresh(after changeCursor: Int? = nil) async {
    while let running = inFlight {
      await running.value
      if inFlight == running { inFlight = nil }
      guard let changeCursor, (state.cursor ?? Int.min) < changeCursor else { return }
    }
    let task = Task { await self.performRefresh() }
    inFlight = task
    await task.value
    if inFlight == task { inFlight = nil }
  }

  /// Remembers icons that live machines showed, for when no machine is
  /// reachable. Writes the cache only when something changed.
  func recordDisplay(_ entries: [String: AccountProjectDisplay]) {
    guard userId != nil else { return }
    var next = display
    for (id, entry) in entries where state.rows[id] != nil {
      var stored = entry
      if let icon = stored.iconDataUrl, icon.utf8.count > Self.maxCachedIconBytes { stored.iconDataUrl = next[id]?.iconDataUrl }
      next[id] = stored
    }
    guard next != display else { return }
    display = next
    revision &+= 1
#if DEBUG
    if isPreviewSeeded { return }
#endif
    writeCache()
  }

  private func performRefresh() async {
#if DEBUG
    // A fixture screen keeps its seeded list and never reaches Clerk.
    if isPreviewSeeded { return }
#endif
    guard let requestedUserId = userId else { return }
    guard let baseURL = AccountConfig.directoryBaseURL else {
      phase = .unconfigured
      return
    }
    lastAttemptAt = Date()
    let account = AccountService.shared
    guard let session = await account.pairingSession(),
          session.authorization.ownerId == requestedUserId,
          userId == requestedUserId else {
      if userId == requestedUserId { recordFailure() }
      return
    }
    do {
      let response = try await client.list(
        baseURL: baseURL,
        token: session.token,
        since: state.cursor,
        refreshToken: {
          guard account.isPairingCommitAuthorized(session.authorization) else { return nil }
          return try? await account.freshRelaySession(expectedAuthorization: session.authorization).token
        }
      )
      // An account switch while the read ran: the answer is the old account's.
      guard userId == requestedUserId, account.isPairingCommitAuthorized(session.authorization) else { return }
      failureCount = 0
      var next = state.applying(response)
      for (id, change) in pendingChanges {
        if response.cursor < change.cursor {
          next.put(change.row, previous: next.rows[id])
        } else {
          pendingChanges[id] = nil
        }
      }
      let changed = next != state || phase != .ready
      publish(state: next, display: display, lastSuccessAt: Date(), phase: .ready)
      // An unchanged list (most foreground reads) writes nothing: the cache
      // only needs a time to say it holds a list.
      guard changed else { return }
      accountProjectsLog.info(
        "account_projects.read rows=\(response.projects.count, privacy: .public) reset=\(response.reset, privacy: .public) live=\(self.liveProjects.count, privacy: .public)"
      )
      writeCache()
    } catch let error as AccountProjectsClient.ListError {
      guard userId == requestedUserId else { return }
      if error == .unsupported {
        accountProjectsLog.notice("account_projects.unsupported")
        publish(state: state, display: display, lastSuccessAt: lastSuccessAt, phase: .unsupported)
        return
      }
      accountProjectsLog.notice("account_projects.read_failed error=\(String(describing: error), privacy: .public)")
      if case .server(let status) = error, status >= 500 {
        CrashReporting.breadcrumb("account-projects", message: "list read failed", data: ["status": String(status)])
      }
      if error == .unreadable {
        CrashReporting.capture(error, context: ["area": "account-projects-list"])
      }
      recordFailure()
    } catch {
      guard userId == requestedUserId else { return }
      recordFailure()
    }
  }

  /// Adds a repository to the account (or finds it there) and shows the
  /// answer at once, before the next read; then reads the changes since the
  /// cursor, so the rest of the list catches up. The cursor itself moves only
  /// with a read, so no other change is skipped.
  func add(_ identity: AccountProjectIdentity) async throws -> AccountProjectAddResponse {
    let response = try await performChange { client, baseURL, token, refresh in
      try await client.add(baseURL: baseURL, token: token, identity: identity, refreshToken: refresh)
    }
    applyChanged(response.project, cursor: response.cursor)
    accountProjectsLog.info("account_projects.added created=\(response.created, privacy: .public) revived=\(response.revived, privacy: .public)")
    Task { await refresh(after: response.cursor) }
    return response
  }

  /// Removes a project from the account. The Hub hides it at once; the
  /// folders on the computers stay.
  func remove(projectId: String) async throws {
    let response = try await performChange { client, baseURL, token, refresh in
      try await client.remove(baseURL: baseURL, token: token, projectId: projectId, refreshToken: refresh)
    }
    applyChanged(response.project, cursor: response.cursor)
    accountProjectsLog.info("account_projects.removed")
    Task { await refresh(after: response.cursor) }
  }

  private func performChange<Response>(
    _ call: (AccountProjectsClient, URL, String, @escaping () async -> String?) async throws -> Response
  ) async throws -> Response {
    guard let requestedUserId = userId, let baseURL = AccountConfig.directoryBaseURL else {
      throw AccountProjectsClient.ChangeError(status: nil, message: "Sign in to ADE to change your projects.")
    }
    let account = AccountService.shared
    guard let session = await account.pairingSession(),
          session.authorization.ownerId == requestedUserId,
          userId == requestedUserId else {
      throw AccountProjectsClient.ChangeError(status: nil, message: "Sign in to ADE again, then try again.")
    }
    let response = try await call(client, baseURL, session.token) {
      guard account.isPairingCommitAuthorized(session.authorization) else { return nil }
      return try? await account.freshRelaySession(expectedAuthorization: session.authorization).token
    }
    // An account switch while the call ran: the answer is the old account's.
    guard userId == requestedUserId, account.isPairingCommitAuthorized(session.authorization) else {
      throw AccountProjectsClient.ChangeError(status: nil, message: "You switched accounts. Try again.")
    }
    return response
  }

  private func applyChanged(_ project: AccountProject, cursor: Int) {
    // A list read or an earlier change already holds this change or a later
    // one: an older answer must not undo it.
    if let applied = state.cursor, applied >= cursor { return }
    if let pending = pendingChanges[project.id], pending.cursor >= cursor { return }
    pendingChanges[project.id] = (project, cursor)
    var next = state
    next.put(project, previous: state.rows[project.id])
    publish(state: next, display: display, lastSuccessAt: lastSuccessAt, phase: phase == .loading ? .ready : phase)
#if DEBUG
    if isPreviewSeeded { return }
#endif
    writeCache()
  }

  private func recordFailure() {
    failureCount += 1
    publish(state: state, display: display, lastSuccessAt: lastSuccessAt, phase: .offline)
  }

  private func publish(
    state next: AccountProjectListState,
    display nextDisplay: [String: AccountProjectDisplay],
    lastSuccessAt nextSuccess: Date?,
    phase nextPhase: Phase
  ) {
    let rowsChanged = next.rows != state.rows
    state = next
    if rowsChanged {
      liveProjects = next.liveProjects
      removedProjects = next.removedProjects
      mergedTargets = next.mergedTargets
    }
    if nextDisplay != display { display = nextDisplay }
    if nextSuccess != lastSuccessAt { lastSuccessAt = nextSuccess }
    let phaseChanged = phase != nextPhase
    if phaseChanged { phase = nextPhase }
    if rowsChanged || phaseChanged { revision &+= 1 }
  }

  // MARK: Cache file

  private struct CacheFile: Codable {
    var version: Int
    var userId: String
    var fetchedAt: Date?
    var state: AccountProjectListState
    var display: [String: AccountProjectDisplay]
  }

  private func cacheURL(userId: String) -> URL? {
    guard let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else { return nil }
    let digest = SHA256.hash(data: Data(userId.utf8)).map { String(format: "%02x", $0) }.joined()
    return support
      .appendingPathComponent("ADE", isDirectory: true)
      .appendingPathComponent("account-projects", isDirectory: true)
      .appendingPathComponent("\(digest.prefix(16)).json")
  }

  private func readCache(userId: String) -> (state: AccountProjectListState, display: [String: AccountProjectDisplay], fetchedAt: Date?)? {
    guard let url = cacheURL(userId: userId),
          let data = try? Data(contentsOf: url) else { return nil }
    guard let file = try? JSONDecoder().decode(CacheFile.self, from: data),
          file.version == 1, file.userId == userId else {
      accountProjectsLog.notice("account_projects.cache_unreadable")
      try? fileManager.removeItem(at: url)
      return nil
    }
    return (file.state, file.display, file.fetchedAt)
  }

  private func writeCache() {
    guard let userId, let url = cacheURL(userId: userId) else { return }
    let file = CacheFile(version: 1, userId: userId, fetchedAt: lastSuccessAt, state: state, display: display)
    Self.cacheQueue.async {
      do {
        let data = try JSONEncoder().encode(file)
        try FileManager.default.createDirectory(
          at: url.deletingLastPathComponent(),
          withIntermediateDirectories: true
        )
        try data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
      } catch {
        accountProjectsLog.error("account_projects.cache_write_failed")
      }
    }
  }

  private func deleteCache(userId: String) {
    guard let url = cacheURL(userId: userId) else { return }
    // On the write queue, so a write already queued cannot bring it back.
    Self.cacheQueue.async { try? FileManager.default.removeItem(at: url) }
  }

#if DEBUG
  private var isPreviewSeeded = false

  /// A fixture screen's list. Nothing is read or written.
  func seedPreview(projects: [AccountProject], display: [String: AccountProjectDisplay], phase: Phase, lastSuccessAt: Date?) {
    isPreviewSeeded = true
    userId = "preview"
    var seeded = AccountProjectListState(cursor: 1)
    for project in projects { seeded.rows[project.id] = project }
    publish(state: seeded, display: display, lastSuccessAt: lastSuccessAt, phase: phase)
  }
#endif
}
