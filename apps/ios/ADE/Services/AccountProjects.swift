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
}

struct AccountProjectListResponse: Decodable, Equatable {
  let cursor: Int
  let reset: Bool
  let projects: [AccountProject]
}

/// What the Hub remembers about a project from the last machine that showed
/// it: the account row has no display name or icon.
struct AccountProjectDisplay: Codable, Equatable {
  var name: String
  var iconDataUrl: String?
}

// MARK: - The list, as the phone holds it

/// Every row the phone knows (removed and merged rows included), and the
/// cursor to read changes after. Pure: the store owns persistence.
struct AccountProjectListState: Codable, Equatable {
  var cursor: Int?
  var rows: [String: AccountProject] = [:]

  /// Projects on the account now, oldest first (a stable order for new cards).
  var liveProjects: [AccountProject] {
    rows.values.filter(\.isLive).sorted { lhs, rhs in
      lhs.addedAt == rhs.addedAt ? lhs.id < rhs.id : lhs.addedAt < rhs.addedAt
    }
  }

  /// Rows that were removed from the account (not merged ones: a merged row's
  /// addresses belong to the project it merged into).
  var removedProjects: [AccountProject] {
    rows.values.filter { $0.removedAt != nil && $0.mergedInto == nil }.sorted { $0.id < $1.id }
  }

  /// A list answer: `reset` replaces everything, otherwise each row replaces
  /// the row with its id.
  func applying(_ response: AccountProjectListResponse) -> AccountProjectListState {
    var next = self
    if response.reset { next.rows = [:] }
    for project in response.projects {
      next.rows[project.id] = project
    }
    next.cursor = response.cursor
    return next
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
  @Published private(set) var display: [String: AccountProjectDisplay] = [:]
  /// When a read last succeeded (from the cache on launch). Nil = never.
  @Published private(set) var lastSuccessAt: Date?
  /// Bumps on every change the Hub must rebuild for.
  @Published private(set) var revision = 0

  private var userId: String?
  private var state = AccountProjectListState()
  private var lastAttemptAt: Date?
  private var failureCount = 0
  private var inFlight: Task<Void, Never>?
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
  func activate(userId: String) {
    guard self.userId != userId else { return }
    inFlight?.cancel()
    inFlight = nil
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
    inFlight?.cancel()
    inFlight = nil
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

  private func refreshIfStale(readyFloor: TimeInterval) {
    guard userId != nil else { return }
    let floor: TimeInterval
    switch phase {
    case .unsupported: floor = Self.unsupportedRetryFloor
    case .offline: floor = Self.failureFloors[min(max(failureCount - 1, 0), Self.failureFloors.count - 1)]
    default: floor = readyFloor
    }
    if let lastAttemptAt, Date().timeIntervalSince(lastAttemptAt) < floor { return }
    Task { await refresh() }
  }

  /// A machine shows GitHub repositories the list does not name. Reads once
  /// per new set of names (a brain may have just published them).
  func noteUnknownRepositories(_ identities: Set<String>) {
    guard phase == .ready, !identities.isEmpty else { return }
    let fresh = identities.subtracting(askedUnknownIdentities)
    guard !fresh.isEmpty else { return }
    askedUnknownIdentities.formUnion(fresh)
    refreshIfStale()
  }

  /// Reads the changes since the cursor now. A read already running is
  /// joined rather than doubled.
  func refresh() async {
    if let inFlight {
      await inFlight.value
      return
    }
    let task = Task { await self.performRefresh() }
    inFlight = task
    await task.value
    if inFlight == task { inFlight = nil }
  }

  /// Remembers names and icons that live machines showed, for when no
  /// machine is reachable. Writes the cache only when something changed.
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
      let next = state.applying(response)
      let changed = next != state || phase != .ready
      publish(state: next, display: display, lastSuccessAt: Date(), phase: .ready)
      if changed {
        accountProjectsLog.info(
          "account_projects.read rows=\(response.projects.count, privacy: .public) reset=\(response.reset, privacy: .public) live=\(self.liveProjects.count, privacy: .public)"
        )
      }
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
    if rowsChanged || liveProjects.isEmpty != next.liveProjects.isEmpty {
      liveProjects = next.liveProjects
      removedProjects = next.removedProjects
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
