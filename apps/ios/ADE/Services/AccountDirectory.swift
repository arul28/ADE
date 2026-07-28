import Foundation
import SwiftUI

/// A single reachable route advertised by an account machine, mirroring the
/// directory Worker's `ReachableEndpoint` shape (`apps/account-directory`).
struct AccountMachineEndpoint: Codable, Equatable, Hashable {
  enum Kind: String, Codable, Sendable {
    case lan
    case tailnet
    case relay
  }

  let kind: Kind
  let url: String?
  let host: String?
  let port: Int?
}

/// One machine returned by `GET /account/machines`. Field names and types track
/// the Worker's `MachineRecord` plus the computed `online` flag it appends to
/// the list response. Timestamps are epoch-milliseconds (the Worker stores
/// `Date.now()`), so they're decoded as `Double` and converted lazily.
struct AccountMachine: Codable, Equatable, Identifiable, Hashable {
  let machineKey: String
  let deviceId: String?
  let name: String?
  let platform: String?
  let deviceType: String?
  /// Stable machine identity key advertised by the directory. Newer records
  /// use `ed25519:<base64 raw 32-byte key>`; older rows omit it and remain
  /// eligible only for the legacy Relay adoption path.
  let pubkey: String?
  let reachableEndpoints: [AccountMachineEndpoint]
  let lastSeenAt: Double?
  let createdAt: Double?
  let online: Bool

  var id: String { machineKey }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    machineKey = try container.decode(String.self, forKey: .machineKey)
    deviceId = try container.decodeIfPresent(String.self, forKey: .deviceId)
    name = try container.decodeIfPresent(String.self, forKey: .name)
    platform = try container.decodeIfPresent(String.self, forKey: .platform)
    deviceType = try container.decodeIfPresent(String.self, forKey: .deviceType)
    pubkey = try container.decodeIfPresent(String.self, forKey: .pubkey)
    reachableEndpoints = try container.decodeIfPresent([AccountMachineEndpoint].self, forKey: .reachableEndpoints) ?? []
    lastSeenAt = try container.decodeIfPresent(Double.self, forKey: .lastSeenAt)
    createdAt = try container.decodeIfPresent(Double.self, forKey: .createdAt)
    online = try container.decodeIfPresent(Bool.self, forKey: .online) ?? false
  }

  private enum CodingKeys: String, CodingKey {
    case machineKey, deviceId, name, platform, deviceType, pubkey, reachableEndpoints, lastSeenAt, createdAt, online
  }

  /// Human display name — falls back to the platform or a generic label so a
  /// bare row never renders empty.
  var displayName: String {
    if let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
      return trimmed
    }
    if let platform, !platform.isEmpty {
      return platform.capitalized
    }
    return "ADE machine"
  }

  /// The endpoint we'd prefer to connect through: a direct LAN route first, then
  /// Tailscale, then the cloud relay — matching the connection-runtime ranking.
  var preferredEndpoint: AccountMachineEndpoint? {
    reachableEndpoints.first(where: { $0.kind == .lan })
      ?? reachableEndpoints.first(where: { $0.kind == .tailnet })
      ?? reachableEndpoints.first(where: { $0.kind == .relay })
      ?? reachableEndpoints.first
  }

  /// Transport-free friendly route word for the row's detail line — the same
  /// vocabulary the pairing surfaces use ("lan" / "tailnet" / "relay"), never a
  /// raw IP or port.
  var routeLabel: String? {
    guard let endpoint = preferredEndpoint else { return nil }
    switch endpoint.kind {
    case .lan: return "Local network"
    case .tailnet: return "Tailscale"
    case .relay: return "ADE relay"
    }
  }

  /// A best-effort `host` / `port` pair for one-tap connect, parsed from the
  /// preferred **direct** route only — a LAN or Tailscale endpoint's
  /// `host`+`port` (or the host component of a direct websocket URL). A relay
  /// route is a cloud websocket, not a dialable host, so it never yields a
  /// direct target: a machine advertised only through the account's internet
  /// route returns `nil` and the UI falls back to
  /// the pairing/discovery flow (see `ConnectionSettingsView.connectToAccountMachine`).
  var directConnectTarget: (host: String, port: Int)? {
    guard let endpoint = reachableEndpoints.first(where: { $0.kind == .lan })
      ?? reachableEndpoints.first(where: { $0.kind == .tailnet })
    else { return nil }
    if let host = endpoint.host?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty {
      return (host, endpoint.port ?? SyncDirectHostPorts.defaultPort)
    }
    if let raw = endpoint.url?.trimmingCharacters(in: .whitespacesAndNewlines),
       !raw.isEmpty,
       let components = URLComponents(string: raw),
       let host = components.host,
       !host.isEmpty {
      let port = components.port ?? endpoint.port ?? SyncDirectHostPorts.defaultPort
      return (host, port)
    }
    return nil
  }
}

private struct AccountMachinesResponse: Codable {
  let machines: [AccountMachine]
}

/// Thin HTTP client for the account-directory Worker. The official Worker URL
/// ships in the app build settings and can be overridden by another build;
/// when it's absent or unreachable, callers degrade to a quiet empty state and
/// the local pairing flow keeps working.
struct AccountDirectoryClient {
  enum DirectoryError: LocalizedError, Equatable {
    case notConfigured
    case unauthorized
    case server(Int)
    case transport(String)

    var errorDescription: String? {
      switch self {
      case .notConfigured:
        return "Machine directory isn't available yet."
      case .unauthorized:
        return "Your session expired. Sign in again."
      case .server(let code):
        return "Directory error (\(code))."
      case .transport(let message):
        return message
      }
    }
  }

  var session: URLSession = .shared

  /// Fetch the caller's machines. `baseURL` is the Worker origin (e.g.
  /// `https://ade-account-directory.example.workers.dev`); `token` is the
  /// ClerkKit session JWT presented as `Authorization: Bearer <jwt>`.
  func fetchMachines(
    baseURL: URL,
    token: String,
    refreshToken: (() async -> String?)? = nil
  ) async throws -> [AccountMachine] {
    let correlationID = UUID().uuidString.lowercased()
    func request(using accessToken: String) async throws -> (Data, HTTPURLResponse) {
      var request = URLRequest(url: baseURL.appendingPathComponent("account/machines"))
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
        throw DirectoryError.transport("Couldn't reach the machine directory.")
      }

      guard let http = response as? HTTPURLResponse else {
        throw DirectoryError.transport("The directory returned an unexpected response.")
      }
      return (data, http)
    }

    var (data, http) = try await request(using: token)
    if http.statusCode == 401,
       let refreshToken,
       let refreshedToken = await refreshToken()?.trimmingCharacters(in: .whitespacesAndNewlines),
       !refreshedToken.isEmpty {
      (data, http) = try await request(using: refreshedToken)
    }

    switch http.statusCode {
    case 200:
      do {
        return try JSONDecoder().decode(AccountMachinesResponse.self, from: data).machines
      } catch {
        throw DirectoryError.transport("The directory returned unreadable data.")
      }
    case 401, 403:
      throw DirectoryError.unauthorized
    default:
      throw DirectoryError.server(http.statusCode)
    }
  }
}

/// Authenticated client for the account-wide Attention API hosted by the push
/// relay. It intentionally shares Clerk session semantics with the account
/// directory but stores the resulting snapshot in the App Group so widgets
/// never need network or authentication access.
struct AccountAttentionRelayClient {
  enum RelayError: LocalizedError, Equatable {
    case unauthorized
    case staleOwnership
    case server(Int)
    case transport
    case invalidSnapshot

    var errorDescription: String? {
      switch self {
      case .unauthorized: return "Your session expired. Sign in again."
      case .staleOwnership: return "A newer device owner has already been registered."
      case .server(let status): return "Attention service error (\(status))."
      case .transport: return "Couldn't reach the Attention service."
      case .invalidSnapshot: return "The Attention service returned unreadable data."
      }
    }
  }

  var session: URLSession = .shared

  func fetchSnapshot(
    baseURL: URL,
    token: String,
    since revision: Int,
    streamId: String? = nil,
    refreshToken: (() async -> String?)? = nil
  ) async throws -> AccountAttentionSnapshot {
    var components = URLComponents(
      url: endpoint(baseURL, "snapshot"),
      resolvingAgainstBaseURL: false
    )
    var queryItems = [URLQueryItem(name: "since", value: "\(max(0, revision))")]
    if let streamId = streamId?.trimmingCharacters(in: .whitespacesAndNewlines),
       !streamId.isEmpty {
      queryItems.append(URLQueryItem(name: "streamId", value: streamId))
    }
    components?.queryItems = queryItems
    guard let url = components?.url else { throw RelayError.invalidSnapshot }
    let data = try await perform(
      url: url,
      method: "GET",
      token: token,
      body: nil,
      refreshToken: refreshToken
    )
    guard let snapshot = ADESharedContainer.decodeAttentionSnapshot(from: data),
          snapshot.contractVersion == ADEAttentionContractVersion else {
      throw RelayError.invalidSnapshot
    }
    return snapshot
  }

  func acknowledge(
    baseURL: URL,
    token: String,
    itemIds: [String],
    dismiss: Bool,
    refreshToken: (() async -> String?)? = nil
  ) async throws {
    guard !itemIds.isEmpty else { return }
    let timestamp = ISO8601DateFormatter().string(from: Date())
    var payload: [String: Any] = [
      "itemIds": Array(itemIds.prefix(64)),
      "seenAt": timestamp,
    ]
    if dismiss { payload["dismissedAt"] = timestamp }
    let body = try JSONSerialization.data(withJSONObject: payload)
    _ = try await perform(
      url: endpoint(baseURL, "ack"),
      method: "POST",
      token: token,
      body: body,
      refreshToken: refreshToken
    )
  }

  func updatePresence(
    baseURL: URL,
    token: String,
    deviceId: String,
    deviceName: String,
    foreground: Bool,
    attentionVisible: Bool,
    visibleItemIds: [String],
    refreshToken: (() async -> String?)? = nil
  ) async throws {
    let payload: [String: Any] = [
      "deviceId": deviceId,
      "deviceName": deviceName,
      "platform": "iOS",
      "appForeground": foreground,
      "ambientSurfaceVisible": attentionVisible,
      "visibleItemIds": Array(visibleItemIds.prefix(64)),
      "observedAt": ISO8601DateFormatter().string(from: Date()),
    ]
    let body = try JSONSerialization.data(withJSONObject: payload)
    _ = try await perform(
      url: endpoint(baseURL, "presence"),
      method: "POST",
      token: token,
      body: body,
      refreshToken: refreshToken
    )
  }

  func registerDevice(
    baseURL: URL,
    token: String,
    deviceId: String,
    ownershipEpoch: Int,
    apnsToken: String?,
    pushToStartToken: String?,
    bundleId: String,
    apsEnvironment: String,
    deviceName: String,
    preferences: [String: Any],
    refreshToken: (() async -> String?)? = nil
  ) async throws {
    guard !deviceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          ownershipEpoch > 0,
          ownershipEpoch <= AccountDeviceOwnershipState.maximumSafeEpoch else {
      throw RelayError.transport
    }
    var payload: [String: Any] = [
      "ownershipEpoch": ownershipEpoch,
      "bundleId": bundleId,
      "apsEnvironment": apsEnvironment,
      "platform": "iOS",
      "deviceName": deviceName,
      "preferences": preferences,
    ]
    if let apnsToken, !apnsToken.isEmpty { payload["apnsToken"] = apnsToken }
    if let pushToStartToken, !pushToStartToken.isEmpty {
      payload["pushToStartToken"] = pushToStartToken
    }
    let body = try JSONSerialization.data(withJSONObject: payload)
    _ = try await perform(
      url: endpoint(baseURL, "devices").appendingPathComponent(deviceId),
      method: "PUT",
      token: token,
      body: body,
      refreshToken: refreshToken
    )
  }

  func unregisterDevice(
    baseURL: URL,
    token: String,
    deviceId: String,
    ownershipEpoch: Int,
    timeoutInterval: TimeInterval = 2
  ) async throws {
    let normalizedDeviceId = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedDeviceId.isEmpty,
          ownershipEpoch > 0,
          ownershipEpoch <= AccountDeviceOwnershipState.maximumSafeEpoch else {
      throw RelayError.transport
    }
    let body = try JSONSerialization.data(
      withJSONObject: ["ownershipEpoch": ownershipEpoch]
    )
    _ = try await perform(
      url: endpoint(baseURL, "devices").appendingPathComponent(normalizedDeviceId),
      method: "DELETE",
      token: token,
      body: body,
      refreshToken: nil,
      timeoutInterval: timeoutInterval
    )
  }

  func reportActivityToken(
    baseURL: URL,
    token accessToken: String,
    deviceId: String,
    activityId: String,
    activityToken: String,
    refreshToken: (() async -> String?)? = nil
  ) async throws {
    let normalizedDeviceId = deviceId.trimmingCharacters(in: .whitespacesAndNewlines)
    let normalizedActivityId = activityId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedDeviceId.isEmpty, !normalizedActivityId.isEmpty else {
      throw RelayError.transport
    }
    let url = endpoint(baseURL, "devices")
      .appendingPathComponent(normalizedDeviceId)
      .appendingPathComponent("activities")
      .appendingPathComponent(normalizedActivityId)
    let normalized = activityToken.trimmingCharacters(in: .whitespacesAndNewlines)
    let body = normalized.isEmpty
      ? nil
      : try JSONSerialization.data(withJSONObject: ["token": normalized])
    _ = try await perform(
      url: url,
      method: normalized.isEmpty ? "DELETE" : "PUT",
      token: accessToken,
      body: body,
      refreshToken: refreshToken
    )
  }

  private func endpoint(_ baseURL: URL, _ leaf: String) -> URL {
    baseURL
      .appendingPathComponent("attention")
      .appendingPathComponent("account")
      .appendingPathComponent(leaf)
  }

  private func perform(
    url: URL,
    method: String,
    token: String,
    body: Data?,
    refreshToken: (() async -> String?)?,
    timeoutInterval: TimeInterval = 12
  ) async throws -> Data {
    func request(using accessToken: String) async throws -> (Data, HTTPURLResponse) {
      var request = URLRequest(url: url)
      request.httpMethod = method
      request.httpBody = body
      request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      if body != nil {
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      }
      request.setValue(UUID().uuidString.lowercased(), forHTTPHeaderField: "X-ADE-Correlation-ID")
      request.timeoutInterval = timeoutInterval
      request.cachePolicy = .reloadIgnoringLocalCacheData
      do {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
          throw RelayError.transport
        }
        return (data, http)
      } catch let error as RelayError {
        throw error
      } catch {
        throw RelayError.transport
      }
    }

    var (data, response) = try await request(using: token)
    if response.statusCode == 401,
       let refreshToken,
       let refreshed = await refreshToken()?.trimmingCharacters(in: .whitespacesAndNewlines),
       !refreshed.isEmpty {
      (data, response) = try await request(using: refreshed)
    }
    switch response.statusCode {
    case 200..<300: return data
    case 401, 403: throw RelayError.unauthorized
    case 409: throw RelayError.staleOwnership
    default: throw RelayError.server(response.statusCode)
    }
  }
}
