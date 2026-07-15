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
    reachableEndpoints = try container.decodeIfPresent([AccountMachineEndpoint].self, forKey: .reachableEndpoints) ?? []
    lastSeenAt = try container.decodeIfPresent(Double.self, forKey: .lastSeenAt)
    createdAt = try container.decodeIfPresent(Double.self, forKey: .createdAt)
    online = try container.decodeIfPresent(Bool.self, forKey: .online) ?? false
  }

  private enum CodingKeys: String, CodingKey {
    case machineKey, deviceId, name, platform, deviceType, reachableEndpoints, lastSeenAt, createdAt, online
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
  /// direct target: a relay-only machine returns `nil` and the UI falls back to
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
  func fetchMachines(baseURL: URL, token: String) async throws -> [AccountMachine] {
    var request = URLRequest(url: baseURL.appendingPathComponent("account/machines"))
    request.httpMethod = "GET"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
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
