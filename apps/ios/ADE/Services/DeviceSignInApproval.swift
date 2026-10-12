import Foundation

/// A request to sign another computer in to ADE, read from the link behind the
/// QR code that `ade connect` and the desktop sign-in card show:
/// `https://ade-app.dev/device?user_code=ABCD-EFGH`.
struct DeviceSignInRequest: Equatable, Identifiable {
  let userCode: String

  var id: String { userCode }

  init?(url: URL) {
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
    let scheme = components.scheme?.lowercased()
    let isWebLink = scheme == "https"
      && ADEDeepLinkURLParsing.isADEWebHost(components.host)
      && components.path == "/device"
    // The custom-scheme form is accepted too. Opening the request changes
    // nothing: the person still has to approve it, and then allow it.
    let isCustomLink = scheme == "ade" && url.host?.lowercased() == "device"
    guard isWebLink || isCustomLink,
          let userCode = Self.normalizedUserCode(
            components.queryItems?.first { $0.name == "user_code" }?.value
          ) else { return nil }
    self.userCode = userCode
  }

  /// The directory's code shape: eight characters from an alphabet without
  /// `0`, `1`, `I` or `O`, shown as `ABCD-EFGH`.
  static func normalizedUserCode(_ raw: String?) -> String? {
    guard let raw else { return nil }
    let alphabet = Set("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
    let compact = raw.uppercased().filter { $0.isLetter || $0.isNumber }
    guard compact.count == 8, compact.allSatisfy(alphabet.contains) else { return nil }
    return "\(compact.prefix(4))-\(compact.suffix(4))"
  }
}

/// Where a sign-in stands, as the account directory reports it.
enum DeviceSignInStatus: String, Decodable {
  /// Nobody has confirmed the code yet.
  case pending
  /// Someone confirmed it and the sign-in is open in a browser or a sheet.
  case started
  /// The computer has its session, or can collect it.
  case approved
  case failed
}

struct DeviceSignInPreview: Equatable {
  let status: DeviceSignInStatus
  /// What the computer says it is called. The computer chose it, so it is
  /// shown as a claim, never as proof.
  let machineName: String?
}

enum DeviceSignInApprovalError: Error, Equatable {
  /// This phone has no account session to approve with.
  case signedOut
  case notFound
  case expired
  case alreadyUsed
  /// The directory cannot approve from an app; the browser page still can.
  case unavailable
  case rateLimited
  /// The network, or an answer this build does not understand.
  case failed
}

/// The account directory's `/device/approve` routes: approving a sign-in for
/// another computer from this phone, which already has the account.
struct DeviceSignInApprovalClient {
  let baseURL: URL
  var session: URLSession = .shared

  /// The page a browser uses for the same code. It needs nothing from this
  /// app, so it is where every "cannot do it here" case hands off to.
  func browserPageURL(userCode: String) -> URL {
    var components = URLComponents(
      url: baseURL.appendingPathComponent("device"),
      resolvingAgainstBaseURL: false
    )
    components?.queryItems = [URLQueryItem(name: "user_code", value: userCode)]
    return components?.url ?? baseURL.appendingPathComponent("device")
  }

  func preview(userCode: String, token: String) async throws -> DeviceSignInPreview {
    var components = URLComponents(
      url: baseURL.appendingPathComponent("device/approve"),
      resolvingAgainstBaseURL: false
    )
    components?.queryItems = [URLQueryItem(name: "user_code", value: userCode)]
    guard let url = components?.url else { throw DeviceSignInApprovalError.failed }
    let body = try await send(URLRequest(url: url), token: token, as: PreviewBody.self)
    return DeviceSignInPreview(status: body.status, machineName: body.machineName?.nilIfBlank)
  }

  /// Approves the code and returns the one-time link that finishes it: Clerk
  /// signs this account in with no password, asks to allow the computer, and
  /// hands the session to it.
  func approve(userCode: String, token: String) async throws -> URL {
    var request = URLRequest(url: baseURL.appendingPathComponent("device/approve"))
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: ["user_code": userCode])
    let body = try await send(request, token: token, as: ApproveBody.self)
    guard let url = URL(string: body.url), url.scheme?.lowercased() == "https" else {
      throw DeviceSignInApprovalError.failed
    }
    return url
  }

  private struct PreviewBody: Decodable {
    let status: DeviceSignInStatus
    let machineName: String?

    private enum CodingKeys: String, CodingKey {
      case status
      case machineName = "machine_name"
    }
  }

  private struct ApproveBody: Decodable {
    let url: String
  }

  private func send<Body: Decodable>(
    _ request: URLRequest,
    token: String,
    as type: Body.Type
  ) async throws -> Body {
    var request = request
    request.timeoutInterval = 20
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    let data: Data
    let response: URLResponse
    do {
      (data, response) = try await session.data(for: request)
    } catch {
      throw DeviceSignInApprovalError.failed
    }
    switch (response as? HTTPURLResponse)?.statusCode {
    case 200:
      guard let body = try? JSONDecoder().decode(type, from: data) else {
        throw DeviceSignInApprovalError.failed
      }
      return body
    case 401: throw DeviceSignInApprovalError.signedOut
    case 404: throw DeviceSignInApprovalError.notFound
    case 409: throw DeviceSignInApprovalError.alreadyUsed
    case 410: throw DeviceSignInApprovalError.expired
    case 429: throw DeviceSignInApprovalError.rateLimited
    case 502, 503: throw DeviceSignInApprovalError.unavailable
    default: throw DeviceSignInApprovalError.failed
    }
  }
}

private extension String {
  var nilIfBlank: String? {
    let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? nil : trimmed
  }
}
