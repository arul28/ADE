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

/// How a machine last said it was powered, mirroring the directory Worker's
/// `MachinePowerState`.
///
/// Every field is independently optional and so is the whole record: a host
/// built before this shipped sends none of it, and a machine with no battery — a
/// Mac Studio, a Linux box — sends a null battery rather than a zero. Rendering
/// "0%" on a desktop would be worse than rendering nothing, so nothing is what
/// the presentation helpers below produce.
struct AccountMachinePower: Codable, Equatable, Hashable {
  let batteryPercent: Int?
  let charging: Bool?
  let onExternalPower: Bool?

  init(batteryPercent: Int?, charging: Bool?, onExternalPower: Bool?) {
    self.batteryPercent = batteryPercent
    self.charging = charging
    self.onExternalPower = onExternalPower
  }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    // Power is decoration on a record whose job is reachability. A nonsense
    // value degrades to "unknown" rather than dropping a working machine off
    // the roster over a cosmetic field.
    let rawPercent = (try? container.decodeIfPresent(Double.self, forKey: .batteryPercent)) ?? nil
    batteryPercent = rawPercent.flatMap { value in
      guard value.isFinite, value >= 0, value <= 100 else { return nil }
      return Int(value.rounded())
    }
    charging = (try? container.decodeIfPresent(Bool.self, forKey: .charging)) ?? nil
    onExternalPower = (try? container.decodeIfPresent(Bool.self, forKey: .onExternalPower)) ?? nil
  }

  private enum CodingKeys: String, CodingKey {
    case batteryPercent, charging, onExternalPower
  }
}

/// What a machine last said about being awake.
///
/// `asleep` is a STATED fact — a host announces its suspend in the beat before
/// the screen goes dark — and that is the only thing that reliably separates a
/// sleeping Mac from an unreachable one, because the directory's own `online`
/// flag is still true for as long as the last heartbeat stays fresh.
enum AccountMachineSleepState: String, Codable, Equatable, Hashable, Sendable {
  case awake
  case asleep
}

/// One machine returned by `GET /account/machines`. Field names and types track
/// the Worker's `MachineRecord` plus the computed `online` flag it appends to
/// the list response. Timestamps are epoch-milliseconds (the Worker stores
/// `Date.now()`), so they're decoded as `Double` and converted lazily.
struct AccountMachine: Codable, Equatable, Identifiable, Hashable {
  let machineKey: String
  let deviceId: String?
  let name: String?
  let customName: String?
  let platform: String?
  let deviceType: String?
  /// Stable machine identity key advertised by the directory. Newer records
  /// use `ed25519:<base64 raw 32-byte key>`; older rows omit it and remain
  /// eligible only for the legacy Relay adoption path.
  let pubkey: String?
  let reachableEndpoints: [AccountMachineEndpoint]
  /// Optional and additive: absent from every host built before power reporting
  /// shipped, and the UI must read exactly the same as it did then when it is.
  let power: AccountMachinePower?
  let sleepState: AccountMachineSleepState?
  /// Epoch-milliseconds at which `sleepState` last changed on the machine.
  let sleepStateAt: Double?
  let lastSeenAt: Double?
  let createdAt: Double?
  let online: Bool

  var id: String { machineKey }

  init(from decoder: Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    machineKey = try container.decode(String.self, forKey: .machineKey)
    deviceId = try container.decodeIfPresent(String.self, forKey: .deviceId)
    name = try container.decodeIfPresent(String.self, forKey: .name)
    customName = try container.decodeIfPresent(String.self, forKey: .customName)
    platform = try container.decodeIfPresent(String.self, forKey: .platform)
    deviceType = try container.decodeIfPresent(String.self, forKey: .deviceType)
    pubkey = try container.decodeIfPresent(String.self, forKey: .pubkey)
    reachableEndpoints = try container.decodeIfPresent([AccountMachineEndpoint].self, forKey: .reachableEndpoints) ?? []
    // Tolerant on purpose. A malformed power block, or a sleep word this build
    // has never heard of, must leave the machine listed and connectable — it
    // degrades to the pre-power behavior instead of failing the whole roster.
    power = (try? container.decodeIfPresent(AccountMachinePower.self, forKey: .power)) ?? nil
    let rawSleepState = (try? container.decodeIfPresent(String.self, forKey: .sleepState)) ?? nil
    sleepState = rawSleepState.flatMap(AccountMachineSleepState.init(rawValue:))
    sleepStateAt = (try? container.decodeIfPresent(Double.self, forKey: .sleepStateAt)) ?? nil
    lastSeenAt = try container.decodeIfPresent(Double.self, forKey: .lastSeenAt)
    createdAt = try container.decodeIfPresent(Double.self, forKey: .createdAt)
    online = try container.decodeIfPresent(Bool.self, forKey: .online) ?? false
  }

  private enum CodingKeys: String, CodingKey {
    case machineKey, deviceId, name, customName, platform, deviceType, pubkey, reachableEndpoints
    case power, sleepState, sleepStateAt, lastSeenAt, createdAt, online
  }

  /// Human display name — falls back to the platform or a generic label so a
  /// bare row never renders empty.
  var displayName: String {
    if let trimmed = customName?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty {
      return trimmed
    }
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

/// The power half of a machine row's second line, or nil when the machine said
/// nothing usable about power.
///
/// Returning nil is the important case: a Mac Studio has no battery, and a row
/// that renders an empty slot — or "0%" — for it is worse than a row that says
/// only where the machine is. Lowercase so it reads correctly appended after a
/// state word ("Online · plugged in"); `accountMachineDetailLine` sentence-cases
/// it when it leads.
///
/// Battery wins over wall power, following `machinePowerPhrase` in
/// `apps/desktop/src/shared/machinePresence.ts`: "82% battery" tells the reader
/// how long they have, "plugged in" only tells them nothing is running down. A
/// docked MacBook at 82% used to say "plugged in" here and "82% battery" on the
/// desktop, which is two answers to one question. A machine with no battery has
/// no percentage to show and says where its power comes from instead.
///
/// Two deliberate differences from the desktop, both about not stating what was
/// never reported:
/// - The desktop treats a missing `onExternalPower` as "on battery", because
///   its field is a plain boolean. Here it is optional, and a machine that told
///   us nothing about power gets no clause at all rather than a guess. An
///   explicit `false` is a real answer and does say "on battery".
/// - `charging` counts as wall power. It cannot be true off the wall, and it is
///   the only signal left when a battery read fails.
func accountMachinePowerClause(_ power: AccountMachinePower?) -> String? {
  guard let power else { return nil }
  if let percent = power.batteryPercent { return "\(percent)% battery" }
  if power.onExternalPower == true || power.charging == true {
    return "plugged in"
  }
  if power.onExternalPower == false { return "on battery" }
  return nil
}

/// The whole second line of a machine row: what the machine is doing, then how
/// it is powered.
///
/// The state word is dropped for the attached machine because the CONNECTED
/// pill beside its name already says it, and spending the only line on a
/// repeat wastes the one place power can appear. A stale machine keeps its
/// "last seen" line with no power clause at all — a battery level from three
/// days ago is a number, not a fact.
///
/// That freshness rule is applied once, above the branch, on purpose. It used
/// to sit only on the disconnected path, so being ATTACHED exempted a reading
/// from having to be recent — and attachment is not evidence of freshness,
/// because the power figure rides the account directory's heartbeat, not the
/// channel the phone holds. A Mac reachable over the LAN with its internet down
/// stops heartbeating while staying perfectly connected, and the row went on
/// stating an hours-old battery percentage as fact.
func accountMachineDetailLine(
  isConnected: Bool,
  isAsleep: Bool,
  directoryOnline: Bool,
  lastSeenAt: Date?,
  power: AccountMachinePower?,
  now: Date = Date()
) -> String {
  // Freshness, not the sleep word and not the connection, is what makes a power
  // reading a fact. An announced suspend does not refresh the heartbeat that
  // carried the reading, so gating on `isAsleep` kept rendering a charge for a
  // machine that announced a suspend and then lost power days ago.
  let clause = syncMachinePowerReadingIsFresh(
    directoryOnline: directoryOnline,
    lastSeenAt: lastSeenAt,
    now: now
  ) ? accountMachinePowerClause(power) : nil
  if isConnected {
    return clause.map(accountMachineSentenceCased) ?? "Connected"
  }
  let state = isAsleep
    ? "Asleep"
    : machineReachabilityText(
      isConnected: false,
      directoryOnline: directoryOnline,
      lastSeenAt: lastSeenAt,
      now: now
    )
  guard let clause else { return state }
  return "\(state) · \(clause)"
}

func accountMachineSentenceCased(_ value: String) -> String {
  guard let first = value.first else { return value }
  return first.uppercased() + value.dropFirst()
}

func accountMachinePresentationName(
  hostIdentity: String?,
  fallback: String?,
  machines: [AccountMachine]
) -> String? {
  let identity = hostIdentity?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased()
  if let identity, !identity.isEmpty,
     let machine = machines.first(where: {
       $0.machineKey.lowercased() == identity
         || $0.deviceId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == identity
     }) {
    return machine.displayName
  }
  guard let fallback = fallback?.trimmingCharacters(in: .whitespacesAndNewlines),
        !fallback.isEmpty else {
    return nil
  }
  return fallback
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

  func renameMachine(
    baseURL: URL,
    token: String,
    machineKey: String,
    customName: String?,
    refreshToken: (() async -> String?)? = nil
  ) async throws -> AccountMachine {
    let key = machineKey.trimmingCharacters(in: .whitespacesAndNewlines)
    let name = customName?.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty, (name?.count ?? 0) <= 80 else {
      throw DirectoryError.transport("Machine names can be up to 80 characters.")
    }
    let encodedName: Any = name?.isEmpty == false ? (name ?? "") : NSNull()
    let url = baseURL
      .appendingPathComponent("account/machines")
      .appendingPathComponent(key)
    let body = try JSONSerialization.data(
      withJSONObject: ["customName": encodedName]
    )
    let correlationID = UUID().uuidString.lowercased()

    func request(using accessToken: String) async throws -> (Data, HTTPURLResponse) {
      var request = URLRequest(url: url)
      request.httpMethod = "PATCH"
      request.httpBody = body
      request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
      request.setValue("application/json", forHTTPHeaderField: "Accept")
      request.setValue("application/json", forHTTPHeaderField: "Content-Type")
      request.setValue(correlationID, forHTTPHeaderField: "X-ADE-Correlation-ID")
      request.timeoutInterval = 12
      request.cachePolicy = .reloadIgnoringLocalCacheData
      do {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
          throw DirectoryError.transport("The directory returned an unexpected response.")
        }
        return (data, http)
      } catch let error as DirectoryError {
        throw error
      } catch {
        throw DirectoryError.transport("Couldn't reach the machine directory.")
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
    case 200:
      do {
        return try JSONDecoder().decode(AccountMachine.self, from: data)
      } catch {
        throw DirectoryError.transport("The directory returned unreadable data.")
      }
    case 401, 403:
      throw DirectoryError.unauthorized
    default:
      throw DirectoryError.server(response.statusCode)
    }
  }
}

/// Authenticated client for the account-wide Attention API hosted by the push
/// relay. It intentionally shares Clerk session semantics with the account
/// directory but stores the resulting snapshot in the App Group so widgets
/// never need network or authentication access.
struct AccountAttentionAcknowledgmentResult: Equatable, Sendable {
  let applied: [String]
  let stale: [String]
}

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
      case .server(let status): return "Activity service error (\(status))."
      case .transport: return "Couldn't reach the Activity service."
      case .invalidSnapshot: return "The Activity service returned unreadable data."
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
  ) async throws -> AccountAttentionAcknowledgmentResult {
    let now = Date()
    return try await acknowledge(
      baseURL: baseURL,
      token: token,
      itemIds: itemIds,
      seenAt: now,
      dismissedAt: dismiss ? now : nil,
      sourceRevisions: nil,
      expectedAccountOwnerId: nil,
      refreshToken: refreshToken
    )
  }

  func acknowledge(
    baseURL: URL,
    token: String,
    itemIds: [String],
    seenAt: Date,
    dismissedAt: Date?,
    sourceRevisions: [String: Int]?,
    expectedAccountOwnerId: String?,
    refreshToken: (() async -> String?)? = nil
  ) async throws -> AccountAttentionAcknowledgmentResult {
    let ids = Array(itemIds.prefix(64))
    guard !ids.isEmpty else {
      return AccountAttentionAcknowledgmentResult(applied: [], stale: [])
    }
    let formatter = ISO8601DateFormatter()
    var payload: [String: Any] = [
      "itemIds": ids,
      "seenAt": formatter.string(from: seenAt),
    ]
    if let dismissedAt {
      payload["dismissedAt"] = formatter.string(from: dismissedAt)
    }
    if let sourceRevisions {
      payload["sourceRevisions"] = sourceRevisions
    }
    if let expectedAccountOwnerId {
      payload["expectedAccountOwnerId"] = expectedAccountOwnerId
    }
    let body = try JSONSerialization.data(withJSONObject: payload)
    let data = try await perform(
      url: endpoint(baseURL, "ack"),
      method: "POST",
      token: token,
      body: body,
      refreshToken: refreshToken
    )
    // Older relays returned no applied/stale arrays. Treat a successful legacy
    // response as applying every requested id so this additive client remains
    // compatible during a staggered rollout.
    guard !data.isEmpty else {
      return AccountAttentionAcknowledgmentResult(applied: ids, stale: [])
    }
    struct Response: Decodable {
      let applied: [String]?
      let stale: [String]?
    }
    guard let response = try? JSONDecoder().decode(Response.self, from: data) else {
      throw RelayError.invalidSnapshot
    }
    return AccountAttentionAcknowledgmentResult(
      applied: response.applied ?? ids,
      stale: response.stale ?? []
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

  func updateDevicePreferences(
    baseURL: URL,
    token: String,
    deviceId: String,
    devicePreferences: [String: Any],
    refreshToken: (() async -> String?)? = nil
  ) async throws {
    guard !deviceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          JSONSerialization.isValidJSONObject(devicePreferences) else {
      throw RelayError.transport
    }
    let body = try JSONSerialization.data(withJSONObject: devicePreferences)
    let url = endpoint(baseURL, "preferences")
      .appendingPathComponent("devices")
      .appendingPathComponent(deviceId)
    _ = try await perform(
      url: url,
      method: "PATCH",
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
    clearPushToStartToken: Bool = false,
    bundleId: String,
    apsEnvironment: String,
    deviceName: String,
    preferences: [String: Any],
    refreshToken: (() async -> String?)? = nil
  ) async throws {
    guard !deviceId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          ownershipEpoch > 0,
          ownershipEpoch <= AccountDeviceOwnershipState.maximumSafeEpoch,
          !(clearPushToStartToken && pushToStartToken != nil) else {
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
    if clearPushToStartToken {
      payload["clearPushToStartToken"] = true
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
