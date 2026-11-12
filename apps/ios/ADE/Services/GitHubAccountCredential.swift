import AuthenticationServices
import CryptoKit
import Foundation
import os
import UIKit

private let githubAccountLog = Logger(subsystem: "com.ade.ios", category: "github-account")

// The ADE account's GitHub sign-in (the ADE GitHub App), on the phone.
//
// The account directory keeps one GitHub App sign-in per ADE account and
// renews it itself (`apps/account-directory/src/githubApp/contract.ts`). The
// phone gets the access token only, with a relative deadline (`useForSec`),
// and stops using it 30 s before that. It keeps the token in memory and in
// the keychain, bound to the account it belongs to; another account's token
// is never read. Same rules as the desktop's `accountAppTokenClient.ts`:
//
// - No timer. The token is asked for only when a direct GitHub read needs
//   one and the cached one ran out, or after GitHub answered 401 (one retry,
//   with the rejected token's SHA-256).
// - An answer that needs a person (not connected, sign-in ended) or a server
//   with no GitHub App routes is kept for a while, so a screen that reads
//   every minute does not ask the server every minute.
// - Every call carries the account bearer of the account it started under. An
//   account switch while it runs drops the answer.

// MARK: - Wire types

struct GitHubAppStatusAnswer: Decodable, Equatable {
  let connected: Bool
  let state: String?
  let stateReason: String?
  let githubLogin: String?
  let githubUserId: Int?
  let connectedAt: Double?
  let refreshExpiresAt: Double?
}

private struct GitHubAppTokenAnswer: Decodable {
  let accessToken: String
  let useForSec: Double
  let githubLogin: String
  let generation: Int
  let verified: Bool?
}

private struct GitHubAppSignInStartAnswer: Decodable {
  let signInId: String
  let authorizeUrl: String
}

private struct GitHubAppSignInReadAnswer: Decodable {
  let status: String
  let resultCode: String?
  let githubLogin: String?
}

private struct GitHubAppDisconnectAnswer: Decodable {
  let revokeAtGitHubUrl: String?
}

private struct GitHubAppErrorAnswer: Decodable {
  struct Body: Decodable {
    let code: String?
    let message: String?
    let reason: String?
  }
  let error: Body?
  let reason: String?
}

/// What the cached token record holds (keychain, JSON). No refresh token.
struct GitHubAccountTokenRecord: Codable, Equatable {
  var v = 1
  var accountUserId: String
  var accessToken: String
  /// Epoch seconds: `receivedAt + useForSec - 30`.
  var useUntil: Double
  var generation: Int
  var githubLogin: String
}

// MARK: - State

/// The account's GitHub sign-in as the phone sees it (spec states 0, 4, 4b).
enum GitHubAccountState: Equatable {
  /// Not read yet for this account.
  case unknown
  case signedOut
  /// The account directory has no GitHub App routes (an older server, or no
  /// secrets). The phone behaves as before them.
  case unsupported
  case notConnected
  case connected(login: String)
  /// The sign-in ended; a person connects again (state 4).
  case needsReauth(reason: String?)
  /// The server could not renew right now (state 4b).
  case unavailable(retryAt: Date?)

  var login: String? {
    if case .connected(let login) = self { return login }
    return nil
  }

  var isConnected: Bool { login != nil }
}

/// Why no token: the same kinds as a direct read's error.
enum GitHubAccountTokenFailure: Error, Equatable {
  case signedOut
  case unsupported
  case notConnected
  case needsReauth(String?)
  case unavailable(Date?)
  case accountChanged
}

// MARK: - Client

/// The account directory's GitHub App routes, with one bearer and one retry
/// after a 401 with a refreshed token (`AccountProjectsClient`'s shape).
struct GitHubAccountClient {
  struct Answer {
    let status: Int
    let data: Data
    let retryAfter: TimeInterval?
    var errorCode: String? { (try? JSONDecoder().decode(GitHubAppErrorAnswer.self, from: data))?.error?.code }
    var errorReason: String? {
      let decoded = try? JSONDecoder().decode(GitHubAppErrorAnswer.self, from: data)
      return decoded?.error?.reason ?? decoded?.reason
    }
  }

  enum Failure: Error { case transport }

  var session: URLSession = .shared

  func send(
    _ method: String,
    path: String,
    body: [String: Any]? = nil,
    baseURL: URL,
    token: String,
    refreshToken: (() async -> String?)?
  ) async throws -> Answer {
    let url = baseURL.appendingPathComponent(path)
    let correlationID = UUID().uuidString.lowercased()
    let payload = try body.map { try JSONSerialization.data(withJSONObject: $0) }
    func once(_ bearer: String) async throws -> Answer {
      var request = URLRequest(url: url)
      request.httpMethod = method
      request.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.setValue(correlationID, forHTTPHeaderField: "X-ADE-Correlation-ID")
      if let payload {
        request.httpBody = payload
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      }
      request.timeoutInterval = 15
      request.cachePolicy = .reloadIgnoringLocalCacheData
      let data: Data
      let response: URLResponse
      do {
        (data, response) = try await session.data(for: request)
      } catch {
        throw Failure.transport
      }
      guard let http = response as? HTTPURLResponse else { throw Failure.transport }
      let retryAfter = http.value(forHTTPHeaderField: "Retry-After").flatMap(TimeInterval.init)
      return Answer(status: http.statusCode, data: data, retryAfter: retryAfter)
    }
    var answer = try await once(token)
    if answer.status == 401,
       let refreshToken,
       let refreshed = await refreshToken()?.trimmingCharacters(in: .whitespacesAndNewlines),
       !refreshed.isEmpty {
      answer = try await once(refreshed)
    }
    return answer
  }
}

/// What a token answer means. Pure: the status, the error code and the clock.
func githubAccountTokenFailure(status: Int, code: String?, reason: String?, retryAfter: TimeInterval?, now: Date) -> GitHubAccountTokenFailure {
  switch (status, code) {
  case (404, "not_connected"): return .notConnected
  case (409, "needs_reauth"): return .needsReauth(reason)
  case (503, "github_app_not_configured"): return .unsupported
  case (404, _), (405, _): return .unsupported
  case (401, _), (403, _): return .signedOut
  default: return .unavailable(retryAfter.map { now.addingTimeInterval($0) })
  }
}

// MARK: - The account's connection

@MainActor
final class GitHubAccountConnection: ObservableObject {
  static let shared = GitHubAccountConnection()

  /// A person fixes these on GitHub or in ADE: ask the server again after this long.
  static let personStateRetry: TimeInterval = 5 * 60
  /// A server with no GitHub App routes is asked again after this long.
  static let unsupportedRetry: TimeInterval = 60 * 60
  static let unavailableDefaultRetry: TimeInterval = 60
  /// Least time between two status reads that a screen (not the person) starts.
  static let statusFloor: TimeInterval = 60
  static let revokeURL = URL(string: "https://github.com/settings/apps/authorizations")!

  @Published private(set) var state: GitHubAccountState = .unknown
  /// A sign-in is open in the web sheet.
  @Published private(set) var connecting = false
  /// The last connect or disconnect failure, in one sentence.
  @Published private(set) var problem: String?
  /// Bumps when the App's installations may have changed (the person came
  /// back from GitHub's install page): direct reads drop what they know.
  @Published private(set) var installationsRevision = 0

  private var userId: String?
  private var record: GitHubAccountTokenRecord?
  /// A token answer that needs no new request before `until`.
  private var negative: (failure: GitHubAccountTokenFailure, until: Date)?
  private var tokenTask: Task<Result<String, GitHubAccountTokenFailure>, Never>?
  /// Bumps when the sign-in changes (account switch, connect, disconnect): a
  /// token answer asked for before it is dropped.
  private var grantGeneration = 0
  private var lastStatusAt: Date?
  private var statusTask: Task<Void, Never>?
  private var webSession: ASWebAuthenticationSession?
  private let anchor = GitHubWebAuthAnchor()
  private let client = GitHubAccountClient()
  private let keychain = KeychainService()

  var accountUserId: String? { userId }

  // MARK: Account

  /// The account `userId` signed in. Another account's cached token is
  /// deleted, never read.
  func activate(userId: String) {
    guard self.userId != userId else { return }
    resetMemory()
    self.userId = userId
    if let stored = keychain.loadGitHubAccountToken(),
       let decoded = try? JSONDecoder().decode(GitHubAccountTokenRecord.self, from: Data(stored.utf8)) {
      if decoded.accountUserId == userId {
        record = decoded
        state = .connected(login: decoded.githubLogin)
      } else {
        keychain.clearGitHubAccountToken()
      }
    }
  }

  /// The account signed out (or the app left the account). The token goes
  /// with it.
  func deactivate() {
    resetMemory()
    userId = nil
    keychain.clearGitHubAccountToken()
    state = .signedOut
  }

  private func resetMemory() {
    grantGeneration &+= 1
    tokenTask?.cancel()
    tokenTask = nil
    statusTask?.cancel()
    statusTask = nil
    record = nil
    negative = nil
    lastStatusAt = nil
    problem = nil
    state = .unknown
    GitHubDirectClient.shared.clear()
  }

  // MARK: Status

  /// Reads `GET /github/app/status`. A screen calls it on appear; `force`
  /// is for the person's own act (pull to refresh, back from GitHub).
  func refreshStatus(force: Bool = false) async {
    if let joined = statusTask {
      await joined.value
      // A forced read wants an answer from after the person's act (a
      // finished sign-in): the joined read may have started before it.
      guard force else { return }
      if let newer = statusTask, newer != joined {
        await newer.value
        return
      }
    }
    if !force, let lastStatusAt, Date().timeIntervalSince(lastStatusAt) < Self.statusFloor { return }
    let task = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.performStatusRead()
    }
    statusTask = task
    await task.value
    // An account switch may have started the next account's read meanwhile.
    if statusTask == task { statusTask = nil }
  }

  private func performStatusRead() async {
    lastStatusAt = Date()
    let answer: GitHubAccountClient.Answer
    switch await call("GET", path: "github/app/status") {
    case .failure(let failure):
      if failure != .accountChanged { applyStatusFailure(failure) }
      return
    case .success(let value):
      answer = value
    }
    guard answer.status == 200,
          let status = try? JSONDecoder().decode(GitHubAppStatusAnswer.self, from: answer.data) else {
      applyStatusFailure(githubAccountTokenFailure(
        status: answer.status, code: answer.errorCode, reason: answer.errorReason, retryAfter: answer.retryAfter, now: Date()
      ))
      return
    }
    if !status.connected {
      dropToken()
      negative = (.notConnected, Date().addingTimeInterval(Self.personStateRetry))
      state = .notConnected
    } else if status.state == "needs_reauth" {
      dropToken()
      negative = (.needsReauth(status.stateReason), Date().addingTimeInterval(Self.personStateRetry))
      state = .needsReauth(reason: status.stateReason)
    } else {
      // A connected grant clears an old "not connected" answer at once.
      negative = nil
      state = .connected(login: status.githubLogin ?? record?.githubLogin ?? "GitHub")
    }
  }

  private func applyStatusFailure(_ failure: GitHubAccountTokenFailure) {
    switch failure {
    case .signedOut: state = .signedOut
    case .unsupported: state = .unsupported
    case .notConnected: state = .notConnected
    case .needsReauth(let reason): state = .needsReauth(reason: reason)
    case .unavailable(let retryAt):
      // A status read that failed keeps a known connected state: the token
      // may still work. Otherwise say GitHub is not answering.
      if !state.isConnected { state = .unavailable(retryAt: retryAt) }
    case .accountChanged: break
    }
  }

  // MARK: Token

  /// A current access token for direct GitHub reads. `afterRejected` is a
  /// token GitHub answered 401 to: the server then checks it and answers a
  /// renewed one, or says the sign-in ended.
  func token(afterRejected rejected: String? = nil) async -> Result<String, GitHubAccountTokenFailure> {
    guard userId != nil else { return .failure(.signedOut) }
    let now = Date()
    if rejected == nil, let record, record.useUntil > now.timeIntervalSince1970 {
      return .success(record.accessToken)
    }
    if rejected == nil, let negative, negative.until > now {
      return .failure(negative.failure)
    }
    if let tokenTask { return await tokenTask.value }
    let task = Task { @MainActor [weak self] () -> Result<String, GitHubAccountTokenFailure> in
      guard let self else { return .failure(.signedOut) }
      return await self.requestToken(rejected: rejected)
    }
    tokenTask = task
    let result = await task.value
    if tokenTask == task { tokenTask = nil }
    return result
  }

  private func requestToken(rejected: String?) async -> Result<String, GitHubAccountTokenFailure> {
    var body: [String: Any] = ["reason": rejected == nil ? "expired" : "rejected"]
    if let rejected { body["rejectedTokenSha256"] = Self.sha256Hex(rejected) }
    let requestedUserId = userId
    let requestedGeneration = grantGeneration
    let receivedAt = Date()
    let answer: GitHubAccountClient.Answer
    switch await call("POST", path: "github/app/token", body: body) {
    case .failure(let failure): return .failure(failure)
    case .success(let value): answer = value
    }
    guard userId == requestedUserId, let requestedUserId, grantGeneration == requestedGeneration else {
      return .failure(.accountChanged)
    }
    if answer.status == 200, let token = try? JSONDecoder().decode(GitHubAppTokenAnswer.self, from: answer.data) {
      let next = GitHubAccountTokenRecord(
        accountUserId: requestedUserId,
        accessToken: token.accessToken,
        useUntil: receivedAt.timeIntervalSince1970 + token.useForSec - 30,
        generation: token.generation,
        githubLogin: token.githubLogin
      )
      record = next
      negative = nil
      if let data = try? JSONEncoder().encode(next), let text = String(data: data, encoding: .utf8) {
        keychain.saveGitHubAccountToken(text)
      }
      if state.login != token.githubLogin { state = .connected(login: token.githubLogin) }
      githubAccountLog.info("github_account.token_served generation=\(token.generation, privacy: .public) rejected=\(rejected != nil, privacy: .public)")
      return .success(token.accessToken)
    }
    let failure = githubAccountTokenFailure(
      status: answer.status, code: answer.errorCode, reason: answer.errorReason, retryAfter: answer.retryAfter, now: Date()
    )
    let wait: TimeInterval
    switch failure {
    case .notConnected, .needsReauth: wait = Self.personStateRetry
    case .unsupported: wait = Self.unsupportedRetry
    case .unavailable(let retryAt): wait = max(Self.unavailableDefaultRetry, retryAt?.timeIntervalSinceNow ?? 0)
    case .signedOut, .accountChanged: wait = 0
    }
    if wait > 0 { negative = (failure, Date().addingTimeInterval(wait)) }
    if case .notConnected = failure { dropToken() }
    if case .needsReauth = failure { dropToken() }
    applyStatusFailure(failure)
    githubAccountLog.notice("github_account.token_failed status=\(answer.status, privacy: .public) code=\(answer.errorCode ?? "none", privacy: .public)")
    return .failure(failure)
  }

  /// Drops the token, and any token answer still on its way.
  private func dropToken() {
    grantGeneration &+= 1
    tokenTask?.cancel()
    tokenTask = nil
    record = nil
    keychain.clearGitHubAccountToken()
  }

  static func sha256Hex(_ value: String) -> String {
    SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
  }

  // MARK: Connect and disconnect

  /// Starts the GitHub sign-in in the web sheet and waits for its end.
  func connect() async {
    guard !connecting else { return }
    connecting = true
    problem = nil
    defer { connecting = false }
    let requestedUserId = userId
    let authorizeURL: URL
    let startSignInId: String
    switch await call("POST", path: "github/app/sign-in", body: ["client": "ios"]) {
    case .failure(.accountChanged):
      return
    case .failure(let failure):
      problem = failure == .unsupported
        ? "Your ADE account can't connect GitHub yet."
        : "ADE can't reach your account right now. Try again."
      return
    case .success(let answer):
      guard answer.status == 200 || answer.status == 201,
            let decoded = try? JSONDecoder().decode(GitHubAppSignInStartAnswer.self, from: answer.data),
            let url = URL(string: decoded.authorizeUrl),
            url.scheme == "https" else {
        problem = answer.status == 429
          ? "Too many GitHub sign-ins in a short time. Try again in a few minutes."
          : (answer.status == 404 || answer.errorCode == "github_app_not_configured")
            ? "Your ADE account can't connect GitHub yet."
            : "ADE could not start the GitHub sign-in. Try again."
        return
      }
      authorizeURL = url
      startSignInId = decoded.signInId
    }
    let callback = await presentWebSheet(url: authorizeURL)
    guard userId == requestedUserId else { return }
    let parsed = callback.flatMap(GitHubConnectCallback.init(url:))
    // The sheet closed. Read the sign-in once: the person may have finished
    // even when the callback did not arrive (a closed sheet after approval).
    await finishSignIn(id: parsed?.signInId ?? startSignInId, callbackStatus: parsed?.status)
  }

  /// `ade://github/connected?signIn=…&status=…` reached the app outside the
  /// web sheet (a sign-in started on this phone and finished in Safari).
  func handleConnectedLink(signInId: String?, status: String?) async {
    guard let signInId, !connecting else {
      await refreshStatus(force: true)
      return
    }
    await finishSignIn(id: signInId, callbackStatus: status)
  }

  /// `ade://github/installed`: the person installed or updated the App on
  /// GitHub. Reads drop what they knew about installations.
  func handleInstalledLink() async {
    installationsRevision &+= 1
    GitHubDirectClient.shared.forgetInstallations()
    await refreshStatus(force: true)
  }

  private func finishSignIn(id: String, callbackStatus: String?) async {
    guard GitHubConnectCallback.isSignInId(id) else {
      await refreshStatus(force: true)
      return
    }
    switch await call("GET", path: "github/app/sign-in/\(id)") {
    case .failure:
      await refreshStatus(force: true)
    case .success(let answer):
      let read = answer.status == 200 ? try? JSONDecoder().decode(GitHubAppSignInReadAnswer.self, from: answer.data) : nil
      switch read?.status {
      case "done":
        negative = nil
        dropToken()
        GitHubDirectClient.shared.clear()
        githubAccountLog.info("github_account.connected")
        ProductAnalytics.shared.captureFeature(.githubConnect, outcome: .completed)
        await refreshStatus(force: true)
      case "failed":
        problem = read?.resultCode == "denied" ? nil : "GitHub did not finish the sign-in. Try again."
        ProductAnalytics.shared.captureFeature(.githubConnect, outcome: read?.resultCode == "denied" ? .cancelled : .failed)
      case "expired":
        problem = "The GitHub sign-in ran out of time. Try again."
      default:
        // Pending: the sheet closed before GitHub sent the person back.
        if callbackStatus != nil { problem = "GitHub did not finish the sign-in. Try again." }
        await refreshStatus(force: true)
      }
    }
  }

  /// Signs the account's GitHub App out. Answers the page where the person
  /// can also revoke the App on GitHub (which ends every old machine token).
  @discardableResult
  func disconnect() async -> URL? {
    problem = nil
    switch await call("DELETE", path: "github/app/grant") {
    case .failure:
      problem = "ADE can't reach your account right now. Try again."
      return nil
    case .success(let answer):
      guard (200..<300).contains(answer.status) else {
        problem = "ADE could not disconnect GitHub. Try again."
        return nil
      }
      dropToken()
      GitHubDirectClient.shared.clear()
      negative = (.notConnected, Date().addingTimeInterval(Self.personStateRetry))
      state = .notConnected
      githubAccountLog.info("github_account.disconnected")
      let decoded = try? JSONDecoder().decode(GitHubAppDisconnectAnswer.self, from: answer.data)
      return decoded?.revokeAtGitHubUrl.flatMap(URL.init(string:)) ?? Self.revokeURL
    }
  }

  // MARK: Plumbing

  /// One call with the account bearer of the account signed in now.
  private func call(_ method: String, path: String, body: [String: Any]? = nil) async -> Result<GitHubAccountClient.Answer, GitHubAccountTokenFailure> {
    guard let requestedUserId = userId else { return .failure(.signedOut) }
    guard let baseURL = AccountConfig.directoryBaseURL else { return .failure(.unsupported) }
    let account = AccountService.shared
    guard let session = await account.pairingSession(),
          session.authorization.ownerId == requestedUserId,
          userId == requestedUserId else {
      return .failure(userId == requestedUserId ? .signedOut : .accountChanged)
    }
    do {
      let answer = try await client.send(method, path: path, body: body, baseURL: baseURL, token: session.token) {
        guard account.isPairingCommitAuthorized(session.authorization) else { return nil }
        return try? await account.freshRelaySession(expectedAuthorization: session.authorization).token
      }
      guard userId == requestedUserId, account.isPairingCommitAuthorized(session.authorization) else {
        return .failure(.accountChanged)
      }
      return .success(answer)
    } catch {
      // A switch cancels the call: that is the old account's answer, not "GitHub is down".
      return .failure(userId == requestedUserId ? .unavailable(nil) : .accountChanged)
    }
  }

  private func presentWebSheet(url: URL) async -> URL? {
    await withCheckedContinuation { (continuation: CheckedContinuation<URL?, Never>) in
      let once = WebAuthResumeOnce(continuation)
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "ade") { callbackURL, _ in
        once.resume(with: .success(callbackURL))
      }
      // The person is usually signed in to GitHub in Safari already: reuse it.
      session.prefersEphemeralWebBrowserSession = false
      session.presentationContextProvider = anchor
      webSession = session
      if !session.start() {
        webSession = nil
        once.resume(with: .success(nil))
      }
    }
  }

#if DEBUG
  /// Fixture screens: a fixed state, no request.
  func seedPreview(state: GitHubAccountState) {
    userId = "preview"
    self.state = state
  }
#endif
}

/// `ade://github/connected?signIn=gs_…&status=ok|denied|error|expired`.
struct GitHubConnectCallback: Equatable {
  let signInId: String?
  let status: String?

  init?(url: URL) {
    guard url.scheme?.lowercased() == "ade", url.host?.lowercased() == "github" else { return nil }
    let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
    let id = value("signIn")
    signInId = id.flatMap { Self.isSignInId($0) ? $0 : nil }
    status = value("status")
  }

  /// The server's sign-in ids: `gs_` and 32 hex characters.
  static func isSignInId(_ value: String) -> Bool {
    value.range(of: "^gs_[0-9a-f]{32}$", options: .regularExpression) != nil
  }
}

private final class GitHubWebAuthAnchor: NSObject, ASWebAuthenticationPresentationContextProviding {
  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated { adeWebAuthPresentationAnchor() }
  }
}
