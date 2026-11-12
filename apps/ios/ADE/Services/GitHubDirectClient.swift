import Foundation
import os

private let githubDirectLog = Logger(subsystem: "com.ade.ios", category: "github-direct")

// Direct GitHub reads with the ADE account's GitHub App sign-in, with no ADE
// computer in between: the PRs of a project whose computers are all offline,
// and the repository list of Add project. A Swift port of the read paths of
// `apps/desktop/src/shared/github/directClient.ts`, with the same rules:
//
// - ETag per URL, in memory (200 pages, least recently used goes first). Every
//   GET sends `If-None-Match`; a `304` reuses the stored page, and GitHub does
//   not count a `304` against the rate limit.
// - Pages by `Link: rel="next"` on the API origin only: 5 pages for a list,
//   3 for the reviews, comments and checks of one PR.
// - The rate limit from `x-ratelimit-*`. Below 10 % remaining, background reads
//   (the 60 s refresh) stop until the reset. A `403`/`429` rate limit blocks
//   every read until it ends, with no request.
// - One retry after a `401`, with the token the server answers for the
//   rejected one.
// - A `404` on a repository is refined into the state the person sees (the App
//   is not installed on the owner, or the repository is not in it).
//
// Nothing here logs a token or puts one in an answer.

// MARK: - Shapes

struct GitHubDirectRepoRef: Hashable {
  let owner: String
  let name: String

  /// GitHub's rules for a login and a repository name; anything else never
  /// reaches a path.
  init?(owner: String?, name: String?) {
    let owner = (owner ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    let name = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard owner.range(of: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}$", options: .regularExpression) != nil,
          name.range(of: "^[A-Za-z0-9._-]{1,100}$", options: .regularExpression) != nil,
          name != ".", name != ".."
    else { return nil }
    self.owner = owner
    self.name = name
  }

  var fullName: String { "\(owner)/\(name)" }
  var key: String { fullName.lowercased() }
  var webURL: URL? { URL(string: "https://github.com/\(owner)/\(name)") }
}

enum GitHubDirectErrorKind: String, Equatable {
  case notConnected = "not_connected"
  case signInExpired = "sign_in_expired"
  case appNotInstalled = "app_not_installed"
  case rightsNotAccepted = "rights_not_accepted"
  case repoNotReachable = "repo_not_reachable"
  case rateLimited = "rate_limited"
  case githubUnavailable = "github_unavailable"
  case forbidden
  case notFound = "not_found"
  case invalidRequest = "invalid_request"
}

struct GitHubDirectError: Error, Equatable {
  var kind: GitHubDirectErrorKind
  var retryAt: Date? = nil
  var owner: String? = nil
  var name: String? = nil
  /// `signed_out`, `unsupported`, `read_only`, `background_paused`, or nil.
  var reason: String? = nil
  var sso = false
  var manageUrl: String? = nil
  var accountType: String? = nil
}

struct GitHubDirectPull: Identifiable, Equatable, Hashable {
  let number: Int
  let title: String
  let state: String
  let draft: Bool
  let merged: Bool
  let author: String?
  let authorAvatarUrl: String?
  let headRef: String
  let headSha: String
  let baseRef: String
  let labels: [String]
  let createdAt: String?
  let updatedAt: String?
  let htmlUrl: String?
  var id: Int { number }
}

struct GitHubDirectPullDetail: Equatable {
  let pull: GitHubDirectPull
  let body: String
  let mergeable: Bool?
  let mergeableState: String?
  let additions: Int?
  let deletions: Int?
  let changedFiles: Int?
  let commits: Int?
  let requestedReviewers: [String]
}

struct GitHubDirectCheckRun: Equatable, Identifiable {
  let name: String
  let status: String
  let conclusion: String?
  let appName: String?
  let htmlUrl: String?
  var id: String { "\(appName ?? "")/\(name)" }
}

struct GitHubDirectStatusContext: Equatable, Identifiable {
  let context: String
  let state: String
  let description: String?
  let targetUrl: String?
  var id: String { context }
}

struct GitHubDirectChecks: Equatable {
  let runs: [GitHubDirectCheckRun]
  let statuses: [GitHubDirectStatusContext]
  /// `success`, `pending`, `failure`, `error`, or nil with no statuses.
  let combinedState: String?
}

struct GitHubDirectReview: Equatable, Identifiable {
  let id: Int
  let author: String?
  let state: String
  let body: String
  let submittedAt: String?
}

struct GitHubDirectComment: Equatable, Identifiable {
  let id: Int
  /// `issue` (the conversation) or `review` (on a line of the diff).
  let kind: String
  let author: String?
  let body: String
  let createdAt: String?
  let path: String?
  let line: Int?
  let htmlUrl: String?
}

struct GitHubDirectRepository: Equatable, Identifiable {
  let owner: String
  let name: String
  let fullName: String
  let isPrivate: Bool
  let defaultBranch: String?
  let pushedAt: String?
  var id: String { fullName.lowercased() }
}

/// The App on one owner, from `GET /user/installations`.
struct GitHubAppInstallationGrant: Equatable {
  static let requiredPermissions: [String: String] = [
    "metadata": "read",
    "contents": "write",
    "pull_requests": "write",
    "issues": "write",
  ]
  static let notInstalled = GitHubAppInstallationGrant(installed: false, installationId: nil, accountType: nil, permissions: [:], manageUrl: nil)

  let installed: Bool
  let installationId: Int?
  let accountType: String?
  let permissions: [String: String]
  let manageUrl: String?

  /// The required rights the installation does not grant yet.
  var missingPermissions: [String] {
    guard installed else { return [] }
    return Self.requiredPermissions.keys.sorted().filter { permission in
      let granted = permissions[permission]
      return Self.requiredPermissions[permission] == "read" ? (granted != "read" && granted != "write") : granted != "write"
    }
  }

  var needsApproval: Bool { !missingPermissions.isEmpty }

  /// The installation on `owner` (case-insensitive). Pure.
  static func forOwner(_ json: Any?, owner: String) -> GitHubAppInstallationGrant {
    guard let installations = (json as? [String: Any])?["installations"] as? [Any] else { return .notInstalled }
    let wanted = owner.lowercased()
    for entry in installations {
      guard let installation = entry as? [String: Any],
            let account = installation["account"] as? [String: Any],
            let login = account["login"] as? String,
            login.lowercased() == wanted else { continue }
      let id = (installation["id"] as? NSNumber)?.intValue
      var permissions: [String: String] = [:]
      for (permission, level) in installation["permissions"] as? [String: Any] ?? [:] {
        guard let level = level as? String else { continue }
        if level == "read" || level == "write" { permissions[permission] = level }
        // GitHub says "admin" for some rights; it includes write.
        else if level == "admin" { permissions[permission] = "write" }
      }
      let type = account["type"] as? String
      let manageUrl = id.map { id in
        type == "Organization"
          ? "https://github.com/organizations/\(login.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? login)/settings/installations/\(id)"
          : "https://github.com/settings/installations/\(id)"
      }
      return GitHubAppInstallationGrant(installed: true, installationId: id, accountType: type, permissions: permissions, manageUrl: manageUrl)
    }
    return .notInstalled
  }
}

/// Which state a repository is in for the person (spec section 5). Pure.
/// Order: no installation (or a public repository read without one), then a
/// repository that does not answer, then rights not accepted.
func githubDiagnoseRepositoryAccess(
  repo: GitHubDirectRepoRef,
  grant: GitHubAppInstallationGrant,
  repoStatus: Int,
  repoIsPrivate: Bool?,
  sso: Bool
) -> GitHubDirectError? {
  let answered = (200..<300).contains(repoStatus)
  if !grant.installed {
    if answered && repoIsPrivate == false {
      return GitHubDirectError(kind: .appNotInstalled, owner: repo.owner, name: repo.name, reason: "read_only")
    }
    return GitHubDirectError(kind: .appNotInstalled, owner: repo.owner, name: repo.name)
  }
  if !answered {
    return GitHubDirectError(kind: .repoNotReachable, owner: repo.owner, name: repo.name, sso: sso, manageUrl: grant.manageUrl, accountType: grant.accountType)
  }
  if grant.needsApproval {
    return GitHubDirectError(kind: .rightsNotAccepted, owner: repo.owner, name: repo.name, manageUrl: grant.manageUrl, accountType: grant.accountType)
  }
  return nil
}

/// What a GitHub answer means, or nil for a success (2xx or 304). Pure.
func githubClassifyDirectResponse(
  status: Int,
  header: (String) -> String?,
  message: String,
  now: Date,
  repo: GitHubDirectRepoRef?
) -> GitHubDirectError? {
  if (200..<300).contains(status) || status == 304 { return nil }
  func int(_ name: String) -> Int? { header(name).flatMap { Int($0.trimmingCharacters(in: .whitespaces)) } }
  var error = GitHubDirectError(kind: .forbidden, owner: repo?.owner, name: repo?.name)
  switch status {
  case 401:
    error.kind = .signInExpired
  case 403, 429:
    if let retryAfter = int("retry-after") {
      error.kind = .rateLimited
      error.retryAt = now.addingTimeInterval(TimeInterval(retryAfter))
    } else if int("x-ratelimit-remaining") == 0 {
      error.kind = .rateLimited
      error.retryAt = int("x-ratelimit-reset").map { Date(timeIntervalSince1970: TimeInterval($0)) }
    } else if status == 429 || message.range(of: "secondary rate limit|abuse", options: [.regularExpression, .caseInsensitive]) != nil {
      error.kind = .rateLimited
      error.retryAt = now.addingTimeInterval(60)
    } else if header("x-github-sso") != nil {
      error.kind = .repoNotReachable
      error.sso = true
    } else if message.range(of: "resource not accessible by integration", options: .caseInsensitive) != nil {
      error.kind = .rightsNotAccepted
    }
  case 404, 410:
    error.kind = .notFound
  case 400, 422:
    error.kind = .invalidRequest
  case 500...:
    error.kind = .githubUnavailable
    error.retryAt = int("retry-after").map { now.addingTimeInterval(TimeInterval($0)) }
  default:
    break
  }
  return error
}

/// The next page's URL from a `Link` header, only on the API origin. Pure.
func githubNextPageURL(_ link: String?, apiHost: String) -> URL? {
  guard let link else { return nil }
  for part in link.split(separator: ",") {
    let text = part.trimmingCharacters(in: .whitespaces)
    guard text.range(of: #"rel="?next"?"#, options: .regularExpression) != nil,
          let open = text.firstIndex(of: "<"), let close = text.firstIndex(of: ">"), open < close else { continue }
    let url = URL(string: String(text[text.index(after: open)..<close]))
    return url?.scheme == "https" && url?.host == apiHost ? url : nil
  }
  return nil
}

// MARK: - Client

@MainActor
final class GitHubDirectClient {
  static let shared = GitHubDirectClient()

  static let apiBase = URL(string: "https://api.github.com")!
  private static let apiVersion = "2022-11-28"
  private static let etagCacheMax = 200
  private static let listMaxPages = 5
  private static let sublistMaxPages = 3
  private static let lowRateLimitShare = 0.1
  private static let diagnosisTTL: TimeInterval = 5 * 60

  private struct CachedPage {
    let etag: String
    let body: Data
    let next: URL?
  }

  private struct Page {
    let status: Int
    let body: Data
    let next: URL?
    let notModified: Bool
    let headers: [String: String]
  }

  private struct Rejected: Error { let token: String }

  private var pages: [String: CachedPage] = [:]
  private var pageOrder: [String] = []
  private var inFlight: [String: Task<Result<Page, GitHubDirectError>, Never>] = [:]
  /// Bumps on `clear()`: a read started under the sign-in that ended neither
  /// joins a new read nor fills the cache.
  private var signInEpoch = 0
  private var diagnoses: [String: (at: Date, error: GitHubDirectError?)] = [:]
  private var rateLimit: (limit: Int, remaining: Int, resetAt: Date?)?
  private var blockedUntil: Date?
  private let session: URLSession
#if DEBUG
  /// Fixture screens: canned answers instead of requests
  /// (`GitHubDirectPreviewAnswers`, `HubAccountPreviews.swift`).
  var preview: GitHubDirectPreviewAnswers?
#endif

  init() {
    let configuration = URLSessionConfiguration.ephemeral
    // The client keeps its own ETags; a URL cache would turn a 304 into a 200.
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
    configuration.timeoutIntervalForRequest = 20
    configuration.httpMaximumConnectionsPerHost = 6
    session = URLSession(configuration: configuration)
  }

  /// Drops every stored page and diagnosis (sign-out, account switch, a new sign-in).
  func clear() {
    signInEpoch &+= 1
    for task in inFlight.values { task.cancel() }
    inFlight = [:]
    pages = [:]
    pageOrder = []
    diagnoses = [:]
    blockedUntil = nil
    // The rate limit belongs to the GitHub user of the sign-in that ends here.
    rateLimit = nil
  }

  /// The person changed the App's installations on GitHub.
  func forgetInstallations() {
    diagnoses = [:]
  }

  /// When background reads may run again, or nil when they may run now.
  var backgroundPausedUntil: Date? {
    guard let rateLimit, rateLimit.limit > 0 else { return nil }
    if let reset = rateLimit.resetAt, reset <= Date() { return nil }
    return Double(rateLimit.remaining) < Double(rateLimit.limit) * Self.lowRateLimitShare ? rateLimit.resetAt : nil
  }

  // MARK: Reads

  func listPulls(_ repo: GitHubDirectRepoRef, background: Bool = false) async -> Result<(pulls: [GitHubDirectPull], truncated: Bool), GitHubDirectError> {
    #if DEBUG
    if let preview { return preview.listPulls() }
    #endif
    return await read(repo: repo, background: background) { token, scope in
      let items = try await self.list(path: "/repos/\(repo.owner)/\(repo.name)/pulls", query: ["state": "open", "per_page": "50"], maxPages: Self.listMaxPages, token: token, scope: scope, repo: repo)
      return .success((items.items.compactMap(Self.pull), items.truncated))
    }
  }

  func getPull(_ repo: GitHubDirectRepoRef, number: Int) async -> Result<GitHubDirectPullDetail, GitHubDirectError> {
    #if DEBUG
    if let preview { return preview.getPull(number) }
    #endif
    return await read(repo: repo, background: false) { token, scope in
      let body = try await self.single(path: "/repos/\(repo.owner)/\(repo.name)/pulls/\(number)", token: token, scope: scope, repo: repo)
      guard let detail = Self.pullDetail(body) else { return .failure(GitHubDirectError(kind: .notFound)) }
      return .success(detail)
    }
  }

  func listChecks(_ repo: GitHubDirectRepoRef, sha: String) async -> Result<GitHubDirectChecks, GitHubDirectError> {
    #if DEBUG
    if let preview { return .success(preview.checks) }
    #endif
    guard sha.range(of: "^[0-9a-fA-F]{7,40}$", options: .regularExpression) != nil else {
      return .failure(GitHubDirectError(kind: .invalidRequest))
    }
    let base = "/repos/\(repo.owner)/\(repo.name)/commits/\(sha.lowercased())"
    return await read(repo: repo, background: false) { token, scope in
      let runs = try await self.list(path: "\(base)/check-runs", query: ["per_page": "100"], maxPages: Self.sublistMaxPages, token: token, scope: scope, repo: repo)
      let status = try await self.single(path: "\(base)/status", query: ["per_page": "100"], token: token, scope: scope, repo: repo)
      let statusObject = status as? [String: Any] ?? [:]
      let contexts = (statusObject["statuses"] as? [Any] ?? []).compactMap { entry -> GitHubDirectStatusContext? in
        guard let entry = entry as? [String: Any] else { return nil }
        return GitHubDirectStatusContext(
          context: entry["context"] as? String ?? "",
          state: entry["state"] as? String ?? "",
          description: entry["description"] as? String,
          targetUrl: entry["target_url"] as? String
        )
      }
      return .success(GitHubDirectChecks(
        runs: runs.items.compactMap(Self.checkRun),
        statuses: contexts,
        combinedState: contexts.isEmpty ? nil : statusObject["state"] as? String
      ))
    }
  }

  func listReviews(_ repo: GitHubDirectRepoRef, number: Int) async -> Result<[GitHubDirectReview], GitHubDirectError> {
    #if DEBUG
    if let preview { return .success(preview.reviews) }
    #endif
    return await read(repo: repo, background: false) { token, scope in
      let items = try await self.list(path: "/repos/\(repo.owner)/\(repo.name)/pulls/\(number)/reviews", query: ["per_page": "100"], maxPages: Self.sublistMaxPages, token: token, scope: scope, repo: repo)
      return .success(items.items.compactMap(Self.review))
    }
  }

  func listComments(_ repo: GitHubDirectRepoRef, number: Int) async -> Result<[GitHubDirectComment], GitHubDirectError> {
    #if DEBUG
    if let preview { return .success(preview.comments) }
    #endif
    return await read(repo: repo, background: false) { token, scope in
      let issue = try await self.list(path: "/repos/\(repo.owner)/\(repo.name)/issues/\(number)/comments", query: ["per_page": "100"], maxPages: Self.sublistMaxPages, token: token, scope: scope, repo: repo)
      let review = try await self.list(path: "/repos/\(repo.owner)/\(repo.name)/pulls/\(number)/comments", query: ["per_page": "100"], maxPages: Self.sublistMaxPages, token: token, scope: scope, repo: repo)
      let comments = issue.items.compactMap { Self.comment($0, kind: "issue") } + review.items.compactMap { Self.comment($0, kind: "review") }
      return .success(comments.sorted { ($0.createdAt ?? "") < ($1.createdAt ?? "") })
    }
  }

  /// The repositories the GitHub sign-in can see, most recently pushed first.
  func listRepositories() async -> Result<[GitHubDirectRepository], GitHubDirectError> {
    await read(repo: nil, background: false) { token, scope in
      let items = try await self.list(path: "/user/repos", query: ["per_page": "100", "sort": "pushed"], maxPages: Self.listMaxPages, token: token, scope: scope, repo: nil)
      return .success(items.items.compactMap(Self.repository))
    }
  }

  // MARK: Engine

  private func read<T>(
    repo: GitHubDirectRepoRef?,
    background: Bool,
    _ work: @escaping (String, String) async throws -> Result<T, GitHubDirectError>
  ) async -> Result<T, GitHubDirectError> {
    if let blockedUntil, blockedUntil > Date() {
      return .failure(GitHubDirectError(kind: .rateLimited, retryAt: blockedUntil))
    }
    blockedUntil = nil
    if background, let until = backgroundPausedUntil {
      return .failure(GitHubDirectError(kind: .rateLimited, retryAt: until, reason: "background_paused"))
    }
    let connection = GitHubAccountConnection.shared
    // The account this read belongs to, taken before the token: a switch
    // while it runs drops the answer.
    guard let scope = connection.accountUserId else {
      return .failure(GitHubDirectError(kind: .notConnected, reason: "signed_out"))
    }
    let changed = GitHubDirectError(kind: .githubUnavailable)
    let token: String
    switch await connection.token() {
    case .success(let value): token = value
    case .failure(let failure): return .failure(Self.error(for: failure))
    }
    guard connection.accountUserId == scope else { return .failure(changed) }

    func attempt(_ token: String) async throws -> Result<T, GitHubDirectError> {
      do {
        return try await work(token, scope)
      } catch let error as GitHubDirectError {
        var refined = error
        if error.kind == .notFound, let repo {
          // A missing repository and a hidden one look the same; ask which.
          if let diagnosis = try await diagnose(repo, token: token, scope: scope) { refined = diagnosis }
        }
        if refined.kind == .rateLimited {
          blockedUntil = max(blockedUntil ?? .distantPast, refined.retryAt ?? Date().addingTimeInterval(60))
        }
        return .failure(refined)
      }
    }

    do {
      let result = try await attempt(token)
      return connection.accountUserId == scope ? result : .failure(changed)
    } catch let rejected as Rejected {
      guard connection.accountUserId == scope else { return .failure(changed) }
      guard case .success(let replacement) = await connection.token(afterRejected: rejected.token),
            replacement != rejected.token else {
        return .failure(GitHubDirectError(kind: .signInExpired))
      }
      do {
        let result = try await attempt(replacement)
        return connection.accountUserId == scope ? result : .failure(changed)
      } catch is Rejected {
        return .failure(GitHubDirectError(kind: .signInExpired))
      } catch {
        return .failure(GitHubDirectError(kind: .githubUnavailable))
      }
    } catch {
      return .failure(GitHubDirectError(kind: .githubUnavailable))
    }
  }

  /// The state behind a `404` on a repository, cached for five minutes.
  /// Nil when the repository is fine (a real "not found" inside it).
  private func diagnose(_ repo: GitHubDirectRepoRef, token: String, scope: String) async throws -> GitHubDirectError? {
    let key = "\(scope)\n\(repo.key)"
    if let cached = diagnoses[key], Date().timeIntervalSince(cached.at) < Self.diagnosisTTL { return cached.error }
    let installations = try await single(path: "/user/installations", query: ["per_page": "100"], token: token, scope: scope, repo: nil)
    let grant = GitHubAppInstallationGrant.forOwner(installations, owner: repo.owner)
    var status = 200
    var isPrivate: Bool?
    var sso = false
    do {
      let body = try await single(path: "/repos/\(repo.owner)/\(repo.name)", token: token, scope: scope, repo: repo)
      isPrivate = (body as? [String: Any])?["private"] as? Bool
    } catch let error as GitHubDirectError where error.kind == .notFound || error.kind == .forbidden || error.kind == .repoNotReachable {
      status = error.kind == .notFound ? 404 : 403
      sso = error.sso
    }
    let diagnosis = githubDiagnoseRepositoryAccess(repo: repo, grant: grant, repoStatus: status, repoIsPrivate: isPrivate, sso: sso)
    diagnoses[key] = (Date(), diagnosis)
    return diagnosis
  }

  private func list(
    path: String,
    query: [String: String],
    maxPages: Int,
    token: String,
    scope: String,
    repo: GitHubDirectRepoRef?
  ) async throws -> (items: [Any], truncated: Bool) {
    var url: URL? = Self.url(path: path, query: query)
    var items: [Any] = []
    var read = 0
    var unchanged = 0
    defer {
      githubDirectLog.info("github_direct.list pages=\(read, privacy: .public) not_modified=\(unchanged, privacy: .public)")
    }
    while let current = url, read < maxPages {
      let page = try await fetch(current, token: token, scope: scope, repo: repo)
      read += 1
      if page.notModified { unchanged += 1 }
      let json = try? JSONSerialization.jsonObject(with: page.body)
      if let array = json as? [Any] {
        items.append(contentsOf: array)
      } else if let runs = (json as? [String: Any])?["check_runs"] as? [Any] {
        items.append(contentsOf: runs)
      }
      url = page.next
    }
    return (items, url != nil)
  }

  private func single(path: String, query: [String: String] = [:], token: String, scope: String, repo: GitHubDirectRepoRef?) async throws -> Any? {
    guard let url = Self.url(path: path, query: query) else { throw GitHubDirectError(kind: .invalidRequest) }
    let page = try await fetch(url, token: token, scope: scope, repo: repo)
    return try? JSONSerialization.jsonObject(with: page.body)
  }

  /// One GET, joined with an identical one in flight. Throws `Rejected` on a
  /// 401 and a `GitHubDirectError` on any other failure.
  private func fetch(_ url: URL, token: String, scope: String, repo: GitHubDirectRepoRef?) async throws -> Page {
    let key = "\(scope)\n\(url.absoluteString)"
    let epoch = signInEpoch
    let task: Task<Result<Page, GitHubDirectError>, Never>
    if let joined = inFlight[key] {
      task = joined
    } else {
      let cached = pages[key]
      task = Task { @MainActor [session] in
        var request = URLRequest(url: url)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue(Self.apiVersion, forHTTPHeaderField: "X-GitHub-Api-Version")
        if let cached { request.setValue(cached.etag, forHTTPHeaderField: "If-None-Match") }
        do {
          let (data, response) = try await session.data(for: request)
          guard let http = response as? HTTPURLResponse else { return .failure(GitHubDirectError(kind: .githubUnavailable)) }
          var headers: [String: String] = [:]
          for (name, value) in http.allHeaderFields {
            if let name = name as? String, let value = value as? String { headers[name.lowercased()] = value }
          }
          if http.statusCode == 304, let cached {
            return .success(Page(status: 304, body: cached.body, next: cached.next, notModified: true, headers: headers))
          }
          let next = githubNextPageURL(headers["link"], apiHost: Self.apiBase.host ?? "api.github.com")
          return .success(Page(status: http.statusCode, body: data, next: next, notModified: false, headers: headers))
        } catch {
          return .failure(GitHubDirectError(kind: .githubUnavailable))
        }
      }
      inFlight[key] = task
    }
    let result = await task.value
    if inFlight[key] == task { inFlight[key] = nil }
    // The sign-in ended while the read ran: its page belongs to another grant.
    guard epoch == signInEpoch else { throw CancellationError() }
    let page: Page
    switch result {
    case .failure(let error): throw error
    case .success(let value): page = value
    }
    noteRateLimit(page.headers)
    if page.notModified {
      if let cached = pages[key] { remember(key, cached) }
      return page
    }
    if page.status == 401 { throw Rejected(token: token) }
    if (200..<300).contains(page.status) {
      if let etag = page.headers["etag"] { remember(key, CachedPage(etag: etag, body: page.body, next: page.next)) }
      return page
    }
    let message = ((try? JSONSerialization.jsonObject(with: page.body)) as? [String: Any])?["message"] as? String ?? ""
    throw githubClassifyDirectResponse(status: page.status, header: { page.headers[$0] }, message: message, now: Date(), repo: repo)
      ?? GitHubDirectError(kind: .forbidden)
  }

  private func remember(_ key: String, _ page: CachedPage) {
    pages[key] = page
    pageOrder.removeAll { $0 == key }
    pageOrder.append(key)
    while pageOrder.count > Self.etagCacheMax {
      pages[pageOrder.removeFirst()] = nil
    }
  }

  private func noteRateLimit(_ headers: [String: String]) {
    guard let limit = headers["x-ratelimit-limit"].flatMap(Int.init),
          let remaining = headers["x-ratelimit-remaining"].flatMap(Int.init) else { return }
    let reset = headers["x-ratelimit-reset"].flatMap(Double.init).map { Date(timeIntervalSince1970: $0) }
    rateLimit = (limit, remaining, reset)
    if Double(remaining) < Double(limit) * Self.lowRateLimitShare {
      githubDirectLog.notice("github_direct.rate_limit_low remaining=\(remaining, privacy: .public) limit=\(limit, privacy: .public)")
    }
  }

  private static func url(path: String, query: [String: String]) -> URL? {
    var components = URLComponents(url: apiBase, resolvingAgainstBaseURL: false)
    components?.percentEncodedPath = path
    if !query.isEmpty {
      components?.queryItems = query.keys.sorted().map { URLQueryItem(name: $0, value: query[$0]) }
    }
    return components?.url
  }

  private static func error(for failure: GitHubAccountTokenFailure) -> GitHubDirectError {
    switch failure {
    case .signedOut: return GitHubDirectError(kind: .notConnected, reason: "signed_out")
    case .unsupported: return GitHubDirectError(kind: .notConnected, reason: "unsupported")
    case .notConnected: return GitHubDirectError(kind: .notConnected)
    case .needsReauth: return GitHubDirectError(kind: .signInExpired)
    case .unavailable(let retryAt): return GitHubDirectError(kind: .githubUnavailable, retryAt: retryAt)
    case .accountChanged: return GitHubDirectError(kind: .githubUnavailable)
    }
  }

  // MARK: Mapping

  private static func login(_ value: Any?) -> String? { (value as? [String: Any])?["login"] as? String }

  private static func labels(_ value: Any?) -> [String] {
    (value as? [Any] ?? []).compactMap { ($0 as? [String: Any])?["name"] as? String ?? $0 as? String }
  }

  static func pull(_ value: Any) -> GitHubDirectPull? {
    guard let object = value as? [String: Any], let number = (object["number"] as? NSNumber)?.intValue else { return nil }
    let head = object["head"] as? [String: Any] ?? [:]
    let base = object["base"] as? [String: Any] ?? [:]
    return GitHubDirectPull(
      number: number,
      title: object["title"] as? String ?? "",
      state: object["state"] as? String == "closed" ? "closed" : "open",
      draft: object["draft"] as? Bool == true,
      merged: object["merged"] as? Bool == true || object["merged_at"] is String,
      author: login(object["user"]),
      authorAvatarUrl: (object["user"] as? [String: Any])?["avatar_url"] as? String,
      headRef: head["ref"] as? String ?? "",
      headSha: head["sha"] as? String ?? "",
      baseRef: base["ref"] as? String ?? "",
      labels: labels(object["labels"]),
      createdAt: object["created_at"] as? String,
      updatedAt: object["updated_at"] as? String,
      htmlUrl: object["html_url"] as? String
    )
  }

  private static func pullDetail(_ value: Any?) -> GitHubDirectPullDetail? {
    guard let value, let pull = pull(value), let object = value as? [String: Any] else { return nil }
    return GitHubDirectPullDetail(
      pull: pull,
      body: object["body"] as? String ?? "",
      mergeable: object["mergeable"] as? Bool,
      mergeableState: object["mergeable_state"] as? String,
      additions: (object["additions"] as? NSNumber)?.intValue,
      deletions: (object["deletions"] as? NSNumber)?.intValue,
      changedFiles: (object["changed_files"] as? NSNumber)?.intValue,
      commits: (object["commits"] as? NSNumber)?.intValue,
      requestedReviewers: (object["requested_reviewers"] as? [Any] ?? []).compactMap(login)
    )
  }

  private static func checkRun(_ value: Any) -> GitHubDirectCheckRun? {
    guard let object = value as? [String: Any], let name = object["name"] as? String else { return nil }
    return GitHubDirectCheckRun(
      name: name,
      status: object["status"] as? String ?? "unknown",
      conclusion: object["conclusion"] as? String,
      appName: (object["app"] as? [String: Any])?["name"] as? String,
      htmlUrl: object["html_url"] as? String
    )
  }

  private static func review(_ value: Any) -> GitHubDirectReview? {
    guard let object = value as? [String: Any], let id = (object["id"] as? NSNumber)?.intValue else { return nil }
    return GitHubDirectReview(
      id: id,
      author: login(object["user"]),
      state: object["state"] as? String ?? "",
      body: object["body"] as? String ?? "",
      submittedAt: object["submitted_at"] as? String
    )
  }

  private static func comment(_ value: Any, kind: String) -> GitHubDirectComment? {
    guard let object = value as? [String: Any], let id = (object["id"] as? NSNumber)?.intValue else { return nil }
    return GitHubDirectComment(
      id: id,
      kind: kind,
      author: login(object["user"]),
      body: object["body"] as? String ?? "",
      createdAt: object["created_at"] as? String,
      path: kind == "review" ? object["path"] as? String : nil,
      line: kind == "review" ? ((object["line"] as? NSNumber) ?? (object["original_line"] as? NSNumber))?.intValue : nil,
      htmlUrl: object["html_url"] as? String
    )
  }

  private static func repository(_ value: Any) -> GitHubDirectRepository? {
    guard let object = value as? [String: Any],
          let owner = login(object["owner"]),
          let name = object["name"] as? String else { return nil }
    return GitHubDirectRepository(
      owner: owner,
      name: name,
      fullName: object["full_name"] as? String ?? "\(owner)/\(name)",
      isPrivate: object["private"] as? Bool == true,
      defaultBranch: object["default_branch"] as? String,
      pushedAt: object["pushed_at"] as? String
    )
  }
}
