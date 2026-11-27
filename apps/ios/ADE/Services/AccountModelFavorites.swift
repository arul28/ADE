import Foundation

// The account's model picker favorites (`GET`/`PUT /account/model-favorites`
// on the account directory): one list for the desktop on every computer, the
// web client and this phone. Shapes mirror `AccountModelFavorites` in
// `apps/account-directory/src/cloud/contract.ts`. Recents stay per machine.

private struct AccountModelFavoritesResponse: Decodable {
  let favorites: [String]
}

struct AccountModelFavoritesClient {
  enum FavoritesError: Error, Equatable {
    /// Signed out, or no account directory in this build: use the machine's list.
    case signedOut
    /// The directory has no favorites route (an older server): use the machine's list.
    case unsupported
    /// The account changed while the call ran: the answer is the old account's. Ignore it.
    case stale
    /// The account refused the change (the list is full): sending it again can't land.
    case refused
    case server(Int)
    /// No answer, an unreadable one, or a sign-in token that would not refresh. Try again later.
    case transport
  }

  var session: URLSession = .adeAccount

  /// The account's list.
  @MainActor
  func fetch() async throws -> [String] {
    try await send(method: "GET", body: nil)
  }

  /// Adds and takes off stars on the account's list; answers the list after it.
  @MainActor
  func change(add: [String], remove: [String]) async throws -> [String] {
    let body = try JSONSerialization.data(withJSONObject: ["add": add, "remove": remove])
    return try await send(method: "PUT", body: body)
  }

  /// One request with the account bearer, retried once with a fresh token after a 401.
  @MainActor
  private func send(method: String, body: Data?) async throws -> [String] {
    let account = AccountService.shared
    guard let baseURL = AccountConfig.directoryBaseURL, account.phase == .signedIn else {
      throw FavoritesError.signedOut
    }
    // Signed in, but Clerk had no token for now: a passing failure, not a sign-out.
    guard let pairing = await account.pairingSession() else { throw FavoritesError.transport }
    let url = baseURL.appendingPathComponent("account/model-favorites")
    let correlationID = UUID().uuidString.lowercased()
    let urlSession = session
    func request(_ accessToken: String) async throws -> (Data, HTTPURLResponse) {
      var request = URLRequest(url: url)
      request.httpMethod = method
      request.httpBody = body
      request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
      request.setValue(correlationID, forHTTPHeaderField: "X-ADE-Correlation-ID")
      request.timeoutInterval = 12
      request.cachePolicy = .reloadIgnoringLocalCacheData
      do {
        let (data, response) = try await urlSession.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw FavoritesError.transport }
        return (data, http)
      } catch let error as FavoritesError {
        throw error
      } catch {
        throw FavoritesError.transport
      }
    }
    var (data, http) = try await request(pairing.token)
    if http.statusCode == 401,
       account.isPairingCommitAuthorized(pairing.authorization),
       let refreshed = try? await account.freshRelaySession(expectedAuthorization: pairing.authorization).token {
      (data, http) = try await request(refreshed)
    }
    guard account.isPairingCommitAuthorized(pairing.authorization) else { throw FavoritesError.stale }
    switch http.statusCode {
    case 200:
      guard let decoded = try? JSONDecoder().decode(AccountModelFavoritesResponse.self, from: data) else {
        throw FavoritesError.transport
      }
      return decoded.favorites
    case 401, 403:
      // Still signed in on this phone: the token would not refresh. Try again later.
      throw FavoritesError.transport
    case 404:
      throw FavoritesError.unsupported
    case 400, 409, 413:
      throw FavoritesError.refused
    default:
      throw FavoritesError.server(http.statusCode)
    }
  }
}
