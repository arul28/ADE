import Combine
import Foundation
import Network
import SwiftUI
import UIKit
import WidgetKit
import os
import zlib

/// Small indirection so tests can stub widget reloads without linking WidgetKit.
enum WidgetReloadBridge {
  static var reloadAction: () -> Void = {
    WidgetCenter.shared.reloadAllTimelines()
  }
  static func reloadAllTimelines() {
    reloadAction()
  }
}

private let syncConnectLog = Logger(subsystem: "com.ade.sync", category: "connect")
private let syncChatLog = Logger(subsystem: "com.ade.ios", category: "WorkChatSync")

enum RemoteConnectionState: String {
  case disconnected
  case connecting
  case connected
  case syncing
  case error

  /// True when the host is not reachable — either we never connected
  /// (or gave up) or the last socket turned over into an error state.
  /// UI uses this to suppress per-screen "failed to load" banners whose
  /// underlying cause is simply "not connected"; visible connection affordances
  /// should use `SyncConnectionHealth` so transport, sync work, and load strain
  /// stay distinct.
  var isHostUnreachable: Bool {
    self == .disconnected || self == .error
  }
}

enum SyncTransportHealth: String, Equatable {
  case disconnected
  case connecting
  case connected
  case unreachable

  var isConnected: Bool {
    self == .connected
  }

  var isHostUnreachable: Bool {
    self == .disconnected || self == .unreachable
  }
}

enum SyncLoadHealth: String, Equatable {
  case normal
  case strained
}

struct SyncConnectionHealth: Equatable {
  let transport: SyncTransportHealth
  let load: SyncLoadHealth
  let lastFailureMessage: String?
}

func syncConnectionHealth(
  connectionState: RemoteConnectionState,
  prefersReducedSyncLoad: Bool,
  lastError: String?
) -> SyncConnectionHealth {
  let transport: SyncTransportHealth = {
    switch connectionState {
    case .disconnected:
      return .disconnected
    case .connecting:
      return .connecting
    case .connected, .syncing:
      return .connected
    case .error:
      return .unreachable
    }
  }()
  return SyncConnectionHealth(
    transport: transport,
    load: transport.isConnected && prefersReducedSyncLoad ? .strained : .normal,
    lastFailureMessage: transport == .unreachable ? lastError : nil
  )
}

enum SyncChatMessageDelivery: Equatable {
  case sent
  case queued(steerId: String?)
}

func syncChatMessageDelivery(from response: Any) -> SyncChatMessageDelivery {
  if let response = response as? [String: Any], response["queued"] as? Bool == true {
    return .queued(steerId: response["steerId"] as? String)
  }
  return .sent
}

func unwrapSyncCommandResponse(_ raw: Any) throws -> Any {
  guard let response = raw as? [String: Any], let ok = response["ok"] as? Bool else {
    return raw
  }

  if ok {
    return response["result"] ?? NSNull()
  }

  let error = response["error"] as? [String: Any]
  let message = error?["message"] as? String ?? "Remote command failed."
  let code = error?["code"] as? String ?? "command_failed"
  throw NSError(
    domain: "ADE",
    code: 17,
    userInfo: [
      NSLocalizedDescriptionKey: message,
      "ADEErrorCode": code,
    ]
  )
}

func isRemoteCommandApplicationError(_ error: Error) -> Bool {
  let nsError = error as NSError
  return nsError.domain == "ADE"
    && nsError.code == 17
    && nsError.userInfo["ADEErrorCode"] != nil
}

func isSyncRequestTimeoutError(_ error: Error) -> Bool {
  let nsError = error as NSError
  return nsError.domain == "ADE" && nsError.code == 23
}

func syncShouldQueueCommandAfterSendFailure(error: Error, canSendLiveRequests: Bool, queueable: Bool) -> Bool {
  guard queueable else { return false }
  guard !isRemoteCommandApplicationError(error) else { return false }
  return !canSendLiveRequests || isSyncRequestTimeoutError(error)
}

func decodeHydrationPayload<T: Decodable>(_ raw: Any, as type: T.Type, domainLabel: String, decoder: JSONDecoder) throws -> T {
  do {
    let data = try adeJSONData(withJSONObject: raw)
    return try decoder.decode(T.self, from: data)
  } catch {
    throw NSError(
      domain: "ADE",
      code: 18,
      userInfo: [
        NSLocalizedDescriptionKey: "The machine returned incomplete \(domainLabel) data. Pull to retry or reconnect the machine.",
        NSUnderlyingErrorKey: error,
      ]
    )
  }
}

func adeJSONData(withJSONObject object: Any, options: JSONSerialization.WritingOptions = []) throws -> Data {
  let writingOptions = options.union(.fragmentsAllowed)
  guard JSONSerialization.isValidJSONObject(object) || adeIsValidJSONFragment(object) else {
    throw NSError(domain: "ADE", code: 30, userInfo: [NSLocalizedDescriptionKey: "Invalid JSON payload."])
  }
  return try JSONSerialization.data(withJSONObject: object, options: writingOptions)
}

private func adeIsValidJSONFragment(_ object: Any) -> Bool {
  if object is String || object is NSNumber || object is NSNull {
    return true
  }

  let mirror = Mirror(reflecting: object)
  guard mirror.displayStyle == .optional else {
    return false
  }

  guard let child = mirror.children.first else {
    return true
  }
  return JSONSerialization.isValidJSONObject(child.value) || adeIsValidJSONFragment(child.value)
}

private func syncFoundationObject(from value: RemoteJSONValue) -> Any {
  switch value {
  case .string(let string):
    return string
  case .number(let number):
    return number
  case .bool(let bool):
    return bool
  case .object(let object):
    return object.mapValues(syncFoundationObject(from:))
  case .array(let array):
    return array.map(syncFoundationObject(from:))
  case .null:
    return NSNull()
  }
}

enum InitialHydrationGate {
  static let defaultTimeoutNanoseconds: UInt64 = 15_000_000_000
  static let defaultPollIntervalNanoseconds: UInt64 = 200_000_000

  @MainActor
  static func waitForProjectRow(
    timeoutNanoseconds: UInt64 = defaultTimeoutNanoseconds,
    pollIntervalNanoseconds: UInt64 = defaultPollIntervalNanoseconds,
    currentProjectId: () -> String?,
    shouldContinue: () -> Bool = { true },
    sleep: @escaping (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) }
  ) async throws {
    guard shouldContinue() else {
      throw CancellationError()
    }
    guard currentProjectId() == nil else { return }

    var waited: UInt64 = 0
    while waited < timeoutNanoseconds {
      try await sleep(pollIntervalNanoseconds)
      guard shouldContinue() else {
        throw CancellationError()
      }
      waited += pollIntervalNanoseconds
      if currentProjectId() != nil {
        return
      }
    }

    throw NSError(
      domain: "ADE",
      code: 22,
      userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for the machine to sync project data. Try reconnecting."]
    )
  }
}

enum SyncRequestTimeout {
  static let defaultTimeoutNanoseconds: UInt64 = 30_000_000_000
  static let modelCatalogTimeoutNanoseconds: UInt64 = 6_000_000_000
  static let chatSendTimeoutNanoseconds: UInt64 = 120_000_000_000
  static let laneDeleteTimeoutNanoseconds: UInt64 = 240_000_000_000
  static let message = "The machine took too long to respond. Reconnecting now."
  static let chatSendMessage = "The machine is still starting this chat turn. Live updates will keep syncing."

  static func commandTimeoutNanoseconds(for action: String) -> UInt64 {
    switch action {
    case "lanes.delete":
      return laneDeleteTimeoutNanoseconds
    case "prs.refresh", "prs.getGitHubSnapshot":
      // These fan out to the GitHub API on the host and routinely take
      // longer than the default budget; a short timeout here surfaced as
      // a permanently "cached" PRs tab.
      return 120_000_000_000
    default:
      return defaultTimeoutNanoseconds
    }
  }

  static func error(message: String = Self.message, underlyingError: Error? = nil) -> NSError {
    var userInfo: [String: Any] = [NSLocalizedDescriptionKey: message]
    if let underlyingError {
      userInfo[NSUnderlyingErrorKey] = underlyingError
    }
    return NSError(domain: "ADE", code: 23, userInfo: userInfo)
  }
}

private let syncTerminalSubscriptionMaxBytes = 240_000
/// Snapshot budget for the full-screen SwiftTerm session view, which renders
/// real scrollback instead of a trimmed preview string.
private let syncTerminalStreamMaxBytes = 512_000
private let syncTerminalHistoryMaxBytes = 262_144
private let syncChatSubscriptionMaxBytes = 2_000_000
private let syncChatHistoryTailPageProbeOffset = 1_000_000_000
private let syncChatHistoryTailPageMaxBytes = 600_000
// 512KB, up from 160KB: the old budget silently truncated reasoning-heavy
// turns on cellular/Tailscale routes. Chunked envelopes plus off-main decode
// make the larger snapshot cheap to receive.
private let syncReducedLoadChatSubscriptionMaxBytes = 512_000
private let syncTerminalBufferMaxCharacters = 240_000
private let chatEventHistoryMaxEvents = 1_000
/// Coalescing window for chat-event UI notifications. The coalescer fires on
/// the leading edge (first event after a quiet period surfaces immediately)
/// and then at most once per window during a sustained burst. Was a 420 ms
/// trailing-only debounce, which stacked with the 100 ms timeline rebuild
/// debounce into ~640 ms delta-to-screen — streaming read as laggy next to
/// the desktop's immediate render.
private let chatEventNotificationCoalesceSeconds: TimeInterval = 0.15
private let chatEventNotificationCoalesceNanoseconds = UInt64((chatEventNotificationCoalesceSeconds * 1_000_000_000).rounded())

enum SyncBonjourTiming {
  static let searchRetryNanoseconds: UInt64 = 2_000_000_000
  static let resolveRetryNanoseconds: UInt64 = 2_000_000_000
  static let periodicRestartNanoseconds: UInt64 = 30_000_000_000
  static let resolveTimeout: TimeInterval = 10
}

enum SyncSocketTiming {
  static let openTimeoutNanoseconds: UInt64 = 5_000_000_000
  static let lanePresenceHeartbeatNanoseconds: UInt64 = 30_000_000_000
  static let requestTimeoutReconnectSilenceSeconds: TimeInterval = 12
}

enum SyncTailnetDiscoveryTiming {
  static let probeIntervalNanoseconds: UInt64 = 45_000_000_000
  static let probeTimeoutNanoseconds: UInt64 = 2_000_000_000
}

enum SyncTailnetDiscovery {
  static let hostCandidates = [
    "ade-sync",
  ]
  static let portCandidates = SyncDirectHostPorts.portCandidates
}

enum SyncDirectHostPorts {
  static let defaultPort = 8787
  static let fallbackMaxPort = 8999
  static let portCandidates = Array(defaultPort...fallbackMaxPort)
}

struct SyncRouteEndpoint: Equatable {
  var scheme: String? = nil
  var host: String
  var port: Int?
}

func syncParseRouteEndpoint(_ rawValue: String) -> SyncRouteEndpoint? {
  let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty else { return nil }

  if trimmed.range(of: "://") != nil,
     let components = URLComponents(string: trimmed),
     let host = components.host?.trimmingCharacters(in: .whitespacesAndNewlines),
     !host.isEmpty {
    let scheme = components.scheme?.lowercased() == "wss" ? "wss" : nil
    return SyncRouteEndpoint(scheme: scheme, host: host, port: syncValidRoutePort(components.port))
  }

  let authority = syncRouteAuthority(from: trimmed)
  guard !authority.isEmpty else { return nil }

  if authority.hasPrefix("["),
     let bracketEnd = authority.firstIndex(of: "]") {
    let host = String(authority[authority.index(after: authority.startIndex)..<bracketEnd])
      .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !host.isEmpty else { return nil }
    let remainder = authority[authority.index(after: bracketEnd)...]
    if remainder.isEmpty {
      return SyncRouteEndpoint(host: host, port: nil)
    }
    guard remainder.first == ":" else {
      return SyncRouteEndpoint(host: host, port: nil)
    }
    return SyncRouteEndpoint(host: host, port: syncValidRoutePort(String(remainder.dropFirst())))
  }

  let colonCount = authority.reduce(0) { $1 == ":" ? $0 + 1 : $0 }
  if colonCount == 1, let colon = authority.lastIndex(of: ":") {
    let host = String(authority[..<colon]).trimmingCharacters(in: .whitespacesAndNewlines)
    let portText = String(authority[authority.index(after: colon)...])
    guard !host.isEmpty else { return nil }
    if let port = syncValidRoutePort(portText) {
      return SyncRouteEndpoint(host: host, port: port)
    }
    return SyncRouteEndpoint(host: authority, port: nil)
  }

  return SyncRouteEndpoint(
    host: authority.trimmingCharacters(in: CharacterSet(charactersIn: "[]")),
    port: nil
  )
}

private func syncRouteAuthority(from rawValue: String) -> String {
  let endIndex = rawValue.firstIndex { $0 == "/" || $0 == "?" || $0 == "#" } ?? rawValue.endIndex
  return String(rawValue[..<endIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
}

private func syncValidRoutePort(_ port: Int?) -> Int? {
  guard let port, (1...65_535).contains(port) else { return nil }
  return port
}

private func syncValidRoutePort(_ rawValue: String) -> Int? {
  let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !trimmed.isEmpty,
        trimmed.allSatisfy(\.isNumber),
        let port = Int(trimmed) else {
    return nil
  }
  return syncValidRoutePort(port)
}

func syncEndpointHost(_ rawValue: String) -> String? {
  syncParseRouteEndpoint(rawValue)?.host
}

func syncConnectPortCandidates(
  primaryPort: Int,
  addresses: [String],
  allowFallbackSweep: Bool = true
) -> [Int] {
  let normalizedHosts = addresses
    .map(syncNormalizedRouteHost)
    .map { $0.trimmingCharacters(in: CharacterSet(charactersIn: ".")) }
  let hasBonjourRoute = normalizedHosts.contains { $0.hasSuffix(".local") }
  let hasTailnetRoute = addresses.contains(where: syncIsTailscaleRoute)
  let shouldTryDefaultPair = allowFallbackSweep
    && ((SyncDirectHostPorts.portCandidates.contains(primaryPort) && !hasBonjourRoute)
      || hasTailnetRoute)
  let fallbackPorts = shouldTryDefaultPair ? SyncDirectHostPorts.portCandidates : []
  var seen = Set<Int>()
  return ([primaryPort] + fallbackPorts)
    .compactMap(syncValidRoutePort)
    .filter { seen.insert($0).inserted }
}

struct SyncConnectionEndpointAttempt: Equatable {
  var address: String
  var port: Int
}

func syncConnectionEndpointAttempts(
  addresses: [String],
  ports: [Int]
) -> [SyncConnectionEndpointAttempt] {
  guard let primaryPort = ports.first else { return [] }
  let primaryAttempts = addresses.map { address in
    SyncConnectionEndpointAttempt(address: address, port: primaryPort)
  }
  let fallbackAttempts = ports.dropFirst().flatMap { port in
    addresses.map { address in
      SyncConnectionEndpointAttempt(address: address, port: port)
    }
  }
  return primaryAttempts + fallbackAttempts
}

func syncWebSocketURLString(host rawHost: String, port defaultPort: Int) -> String? {
  guard let endpoint = syncParseRouteEndpoint(rawHost) else { return nil }
  let port = endpoint.port ?? defaultPort
  guard syncValidRoutePort(port) != nil else { return nil }
  let host = endpoint.host.trimmingCharacters(in: .whitespacesAndNewlines)
  guard !host.isEmpty else { return nil }
  let urlHost = host.contains(":") && !host.hasPrefix("[") ? "[\(host)]" : host
  return "\(endpoint.scheme ?? "ws")://\(urlHost):\(port)"
}

func syncIsTailnetDiscoveryHost(_ host: String) -> Bool {
  SyncTailnetDiscovery.hostCandidates.contains(
    host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  )
}

func syncIsTailscaleIPv4Address(_ host: String) -> Bool {
  let normalized = host
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
  let octets = normalized.split(separator: ".")
  guard octets.count == 4,
        let first = octets.first.flatMap({ Int($0) }),
        let second = octets.dropFirst().first.flatMap({ Int($0) }) else {
    return false
  }
  return first == 100 && (64...127).contains(second)
}

func syncNormalizedRouteHost(_ address: String) -> String {
  syncEndpointHost(address)?
    .trimmingCharacters(in: .whitespacesAndNewlines)
    .lowercased() ?? ""
}

func syncIsTailscaleRoute(_ address: String) -> Bool {
  let host = syncNormalizedRouteHost(address)
  if host.isEmpty { return false }
  return syncIsTailscaleIPv4Address(host)
    || syncIsTailnetDiscoveryHost(host)
    || host.hasSuffix(".ts.net")
}

/// Inbound frame after the CPU-heavy stages (envelope JSON parse, gunzip,
/// payload JSON parse) have run OFF the main actor. The main actor only does
/// state mutation with the pre-decoded payload — multi-megabyte frames used
/// to freeze the UI (and get the app killed by the watchdog) while decoding
/// inline on the main thread.
struct SyncPreprocessedEnvelope {
  let type: String
  let requestId: String?
  let payload: Any
}

private let maxUncompressedSyncEnvelopeBytes = 25 * 1024 * 1024

func syncPreprocessIncoming(
  _ text: String,
  maxUncompressedBytes: Int = maxUncompressedSyncEnvelopeBytes
) throws -> SyncPreprocessedEnvelope? {
  guard let data = text.data(using: .utf8) else { return nil }
  guard let envelope = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
  let type = envelope["type"] as? String ?? ""
  let requestId = envelope["requestId"] as? String
  let payload: Any
  let compression = envelope["compression"] as? String ?? "none"
  if compression == "gzip", let base64 = envelope["payload"] as? String, let compressed = Data(base64Encoded: base64) {
    let inflated = try gunzip(compressed, maxOutputBytes: maxUncompressedBytes)
    payload = try JSONSerialization.jsonObject(with: inflated, options: [])
  } else {
    payload = envelope["payload"] ?? NSNull()
  }
  return SyncPreprocessedEnvelope(type: type, requestId: requestId, payload: payload)
}

func syncDecodeChangesetBatch(_ payload: Any) throws -> SyncChangesetBatchPayload {
  let data = try adeJSONData(withJSONObject: payload)
  return try JSONDecoder().decode(SyncChangesetBatchPayload.self, from: data)
}

private let syncAddressProbeQueue = DispatchQueue(label: "ade.sync.address-probe", qos: .userInitiated)

/// Raw TCP reachability probe used to race address candidates before the
/// (single-socket) websocket connect. Cheap, concurrent, and cancel-safe.
func syncTcpProbe(host: String, port: Int, timeoutNanoseconds: UInt64) async -> Bool {
  guard let endpointPort = NWEndpoint.Port(rawValue: UInt16(clamping: port)) else { return false }
  return await withCheckedContinuation { continuation in
    let connection = NWConnection(host: NWEndpoint.Host(host), port: endpointPort, using: .tcp)
    var completed = false
    let complete: (Bool) -> Void = { result in
      guard !completed else { return }
      completed = true
      connection.cancel()
      continuation.resume(returning: result)
    }
    connection.stateUpdateHandler = { state in
      switch state {
      case .ready: complete(true)
      case .failed, .cancelled: complete(false)
      default: break
      }
    }
    connection.start(queue: syncAddressProbeQueue)
    syncAddressProbeQueue.asyncAfter(deadline: .now() + .nanoseconds(Int(timeoutNanoseconds))) {
      complete(false)
    }
  }
}

/// Happy-eyeballs ordering for reconnect: TCP-probe every candidate address
/// concurrently and put reachable ones first, in completion order (fastest
/// route wins). Unreachable candidates keep their original relative order as
/// a fallback tail — a probe can be blocked on networks where the websocket
/// still works. Sequential attempts over a dead LAN IP used to burn the full
/// open timeout before the live Tailscale route was even tried.
func syncRaceAddressCandidates(
  addresses: [String],
  port: Int,
  timeoutNanoseconds: UInt64 = 1_500_000_000
) async -> [String] {
  guard addresses.count > 1 else { return addresses }
  return await withTaskGroup(of: (Int, Bool).self) { group in
    for (index, address) in addresses.enumerated() {
      group.addTask {
        (index, await syncTcpProbe(host: address, port: port, timeoutNanoseconds: timeoutNanoseconds))
      }
    }
    var reachable: [Int] = []
    var unreachable: [Int] = []
    for await (index, ok) in group {
      if ok { reachable.append(index) } else { unreachable.append(index) }
    }
    unreachable.sort()
    return (reachable + unreachable).map { addresses[$0] }
  }
}

/// Reassembles `envelope_chunk` frames back into the full encoded envelope.
/// The host slices any oversized envelope into base64 parts so no single
/// websocket message can exceed the socket's receive budget; parts concatenate
/// in `index` order into the original envelope JSON. Bounded so a broken host
/// cannot grow the buffer without limit.
struct SyncEnvelopeChunkAssembler {
  private struct PartialChunk {
    let total: Int
    var parts: [Int: String] = [:]
  }

  private var buffers: [String: PartialChunk] = [:]
  private var arrivalOrder: [String] = []
  private let maxConcurrentChunks = 8
  private let maxTotalParts = 512

  mutating func add(chunkId: String, index: Int, total: Int, part: String) -> String? {
    guard total > 0, index >= 0, index < total, total <= maxTotalParts, !chunkId.isEmpty else { return nil }
    if buffers[chunkId] == nil {
      while arrivalOrder.count >= maxConcurrentChunks, let oldest = arrivalOrder.first {
        arrivalOrder.removeFirst()
        buffers.removeValue(forKey: oldest)
      }
      buffers[chunkId] = PartialChunk(total: total)
      arrivalOrder.append(chunkId)
    }
    guard var buffer = buffers[chunkId], buffer.total == total else {
      buffers.removeValue(forKey: chunkId)
      arrivalOrder.removeAll { $0 == chunkId }
      return nil
    }
    buffer.parts[index] = part
    guard buffer.parts.count == buffer.total else {
      buffers[chunkId] = buffer
      return nil
    }
    buffers.removeValue(forKey: chunkId)
    arrivalOrder.removeAll { $0 == chunkId }
    var data = Data()
    for partIndex in 0..<buffer.total {
      guard let encoded = buffer.parts[partIndex], let decoded = Data(base64Encoded: encoded) else { return nil }
      data.append(decoded)
    }
    return String(data: data, encoding: .utf8)
  }

  mutating func reset() {
    buffers.removeAll()
    arrivalOrder.removeAll()
  }
}

struct SyncReconnectState {
  private(set) var attempts = 0

  /// Maximum number of automatic reconnect attempts before the loop gives up and
  /// the UI flips to a terminal "can't reach this machine" state. With the 1s→16s
  /// exponential backoff this is roughly a minute of trying, which is enough to
  /// ride out a brief network blip but short enough that a genuinely-offline
  /// machine resolves to a clear failure instead of looping silently forever.
  static let maxAutomaticAttempts = 7

  /// True once the automatic reconnect loop has burned through its attempt budget.
  /// Callers stop rescheduling and surface a terminal error instead.
  var isExhausted: Bool {
    attempts >= Self.maxAutomaticAttempts
  }

  mutating func nextDelayNanoseconds() -> UInt64 {
    let exponent = min(attempts, 4)
    let seconds = UInt64(1 << exponent)
    attempts += 1
    return seconds * 1_000_000_000
  }

  mutating func nextDelayNanoseconds(forCloseCodeRawValue closeCodeRawValue: Int?) -> UInt64 {
    let base = nextDelayNanoseconds()
    // Close 4001 is used for heartbeat / idle disconnect on the host. A zero delay caused
    // immediate reconnect storms (many TCP opens per second) and UI lag.
    if closeCodeRawValue == 4001 {
      return max(1_500_000_000, base)
    }
    return base
  }

  mutating func reset() {
    attempts = 0
  }

  /// Re-open the budget for exactly one attempt from the slow heartbeat loop.
  /// The counter stays at its ceiling so a failed attempt re-exhausts
  /// immediately and the caller schedules the next heartbeat instead of
  /// re-entering the fast 1s→16s burst.
  mutating func allowOneSlowAttempt() {
    attempts = Self.maxAutomaticAttempts - 1
  }
}

private struct SyncNetworkPathSnapshot: Equatable, Sendable {
  let isSatisfied: Bool
  let usesWiFi: Bool
  let usesCellular: Bool
  let usesWiredEthernet: Bool
  let isExpensive: Bool
  let isConstrained: Bool
}

private func syncLogAddressList(_ addresses: [String]) -> String {
  addresses.isEmpty ? "[]" : addresses.joined(separator: ",")
}

private func syncLogErrorSummary(_ error: Error) -> String {
  let nsError = error as NSError
  let message = nsError.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
  return "\(nsError.domain)#\(nsError.code):\(message)"
}

private func syncLogPathSummary(_ snapshot: SyncNetworkPathSnapshot?) -> String {
  guard let snapshot else { return "unknown" }
  let interfaces = [
    snapshot.usesWiFi ? "wifi" : nil,
    snapshot.usesCellular ? "cellular" : nil,
    snapshot.usesWiredEthernet ? "wired" : nil,
  ].compactMap { $0 }
  return "satisfied=\(snapshot.isSatisfied) interfaces=\(interfaces.isEmpty ? "none" : interfaces.joined(separator: "+")) expensive=\(snapshot.isExpensive) constrained=\(snapshot.isConstrained)"
}

private let syncAmbiguousRouteAuthFailureKey = "ADEAmbiguousRouteAuthFailure"

private func syncLogProfileSummary(_ profile: HostConnectionProfile) -> String {
  [
    "host=\(profile.hostName ?? "unknown")",
    "port=\(profile.port)",
    "last=\(profile.lastSuccessfulAddress ?? "none")",
    "tailscale=\(profile.tailscaleAddress ?? "none")",
    "saved=[\(syncLogAddressList(profile.savedAddressCandidates))]",
    "lan=[\(syncLogAddressList(profile.discoveredLanAddresses))]",
  ].joined(separator: " ")
}

private func syncIsMessageTooLongError(_ error: Error) -> Bool {
  let message = (error as NSError).localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  return message.contains("message too long")
}

func syncConnectionStateAfterTransportFailure(error: Error, fallback: RemoteConnectionState) -> RemoteConnectionState {
  syncIsMessageTooLongError(error) ? .error : fallback
}

func syncConnectionStateAfterRequestTimeout(
  lastInboundMessageAt: TimeInterval?,
  fallback: RemoteConnectionState
) -> RemoteConnectionState {
  lastInboundMessageAt == nil ? .connecting : fallback
}

func syncShouldPublishForegroundReconnectStarted(
  allowAutoReconnect: Bool,
  autoReconnectPausedByUser: Bool,
  hasToken: Bool,
  connectionState: RemoteConnectionState,
  automaticAddresses: [String]
) -> Bool {
  guard allowAutoReconnect, !autoReconnectPausedByUser, hasToken else { return false }
  guard connectionState == .disconnected || connectionState == .error else { return false }
  return !automaticAddresses.isEmpty
}

func syncDiscoveredHostsEqualForPresentation(
  _ left: DiscoveredSyncHost,
  _ right: DiscoveredSyncHost
) -> Bool {
  left.id == right.id
    && left.serviceName == right.serviceName
    && left.hostName == right.hostName
    && left.hostIdentity == right.hostIdentity
    && left.siteId == right.siteId
    && left.runtimeName == right.runtimeName
    && left.port == right.port
    && left.addresses == right.addresses
    && left.tailscaleAddress == right.tailscaleAddress
    && left.runtimeKind == right.runtimeKind
    && left.runtimeVersion == right.runtimeVersion
    && left.projectIds == right.projectIds
    && left.projectNames == right.projectNames
    && left.projectCount == right.projectCount
    && left.pairingPinConfigured == right.pairingPinConfigured
}

func syncDiscoveredHostListsEqualForPresentation(
  _ left: [DiscoveredSyncHost],
  _ right: [DiscoveredSyncHost]
) -> Bool {
  guard left.count == right.count else { return false }
  return zip(left, right).allSatisfy(syncDiscoveredHostsEqualForPresentation)
}

func syncClientHeartbeatIntervalNanoseconds(serverIntervalMs rawValue: Any?) -> UInt64 {
  let parsedMs: Double? = {
    if let number = rawValue as? NSNumber {
      return number.doubleValue
    }
    if let value = rawValue as? Double {
      return value
    }
    if let value = rawValue as? Int {
      return Double(value)
    }
    return nil
  }()
  let serverMs = min(120_000, max(5_000, parsedMs ?? 30_000))
  let clientMs = min(25_000, max(5_000, serverMs / 2))
  return UInt64(clientMs) * 1_000_000
}

func syncShouldReconnectAfterRequestTimeout(
  now: TimeInterval,
  lastInboundMessageAt: TimeInterval?,
  silenceThreshold: TimeInterval = SyncSocketTiming.requestTimeoutReconnectSilenceSeconds
) -> Bool {
  guard let lastInboundMessageAt else { return true }
  return now - lastInboundMessageAt >= silenceThreshold
}

func syncShouldRoamToTailnet(
  currentAddress: String?,
  hasTailnetRoute: Bool,
  usesWiFi: Bool,
  usesCellular: Bool,
  usesWiredEthernet: Bool
) -> Bool {
  guard hasTailnetRoute else { return false }
  let connectedOverTailnet = currentAddress.map(syncIsTailscaleRoute) ?? false
  guard !connectedOverTailnet else { return false }
  return usesCellular || (!usesWiFi && !usesWiredEthernet)
}

func syncPrefersReducedNetworkLoad(
  currentAddress: String?,
  usesWiFi: Bool,
  usesCellular: Bool,
  usesWiredEthernet: Bool,
  isExpensive: Bool,
  isConstrained: Bool
) -> Bool {
  if currentAddress.map(syncIsTailscaleRoute) == true { return true }
  if isConstrained || isExpensive || usesCellular { return true }
  return !usesWiFi && !usesWiredEthernet
}

func syncShouldUseReducedNetworkLoad(
  initialPreference: Bool,
  isConstrained: Bool,
  forcedReduced: Bool,
  healthySampleCount: Int,
  poorSampleCount: Int
) -> Bool {
  if isConstrained || forcedReduced { return true }
  if poorSampleCount > 0 { return true }
  if healthySampleCount >= 3 { return false }
  return initialPreference
}

struct SyncConnectionLoadSample: Equatable {
  let isPoor: Bool
  let isHealthy: Bool
}

func syncConnectionLoadSample(
  latencyMs: Int? = nil,
  syncLag: Int? = nil,
  roundTripSeconds: TimeInterval? = nil
) -> SyncConnectionLoadSample {
  let latencyPoor = latencyMs.map { $0 >= 900 } ?? false
  let latencyHealthy = latencyMs.map { $0 <= 250 } ?? false
  let lagHealthy = syncLag.map { $0 <= 10 } ?? true
  let roundTripPoor = roundTripSeconds.map { $0 >= 5.0 } ?? false
  let roundTripHealthy = roundTripSeconds.map { $0 <= 0.9 } ?? false

  // A high server sync lag usually means the phone is catching up on a large
  // CRDT backlog. That is sync work, not proof that the transport is weak.
  return SyncConnectionLoadSample(
    isPoor: latencyPoor || roundTripPoor,
    isHealthy: (latencyHealthy || roundTripHealthy) && lagHealthy
  )
}

enum SyncUserFacingError {
  static func message(for error: Error) -> String {
    let nsError = error as NSError
    if nsError.userInfo[syncAmbiguousRouteAuthFailureKey] as? Bool == true {
      return "Reached a different ADE machine on this route. ADE kept the saved pairing and will keep trying other routes."
    }
    if let code = nsError.userInfo["ADEErrorCode"] as? String, code == "auth_failed" {
      return "This phone is no longer paired with this machine. Pair again from Settings."
    }

    let rawMessage = nsError.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !rawMessage.isEmpty else {
      return "Something interrupted sync. Reconnect to the machine and try again."
    }

    let lowered = rawMessage.lowercased()
    if lowered.contains("timed out waiting for host to sync project data") {
      return "Timed out waiting for the machine to sync project data. Try reconnecting."
    }
    if lowered.contains("no project row") || lowered.contains("project data") {
      return "Waiting for the machine to sync project data..."
    }
    if lowered.contains("host took too long to respond") {
      return SyncRequestTimeout.message
    }
    if lowered.contains("heartbeat") && lowered.contains("reconnect") {
      return "The machine stopped responding. Reconnecting now."
    }
    if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorAppTransportSecurityRequiresSecureConnection ||
        lowered.contains("app transport security") ||
        lowered.contains("requires the use of a secure connection") {
      return "iOS blocked this route before ADE could connect. Try the LAN route, or use a current ADE build with Tailscale sync enabled."
    }
    if lowered == "connection closed." ||
        lowered.contains("socket is not connected") ||
        lowered.contains("network connection was lost") ||
        lowered.contains("cancelled") {
      return "The connection to the machine was interrupted. Reconnecting now."
    }
    if lowered.contains("unable to reach the saved ade host") ||
        lowered.contains("could not connect to the server") ||
        lowered.contains("network is unreachable") ||
        lowered.contains("cannot connect to host") {
      return "Can't reach the saved machine right now. Make sure ADE is running there, then retry. Away from the LAN, connect both devices through Tailscale or your VPN."
    }
    if lowered.contains("no saved address is available for this host") {
      return "This phone no longer has a saved address for this machine. Open Settings to rediscover it or pair again."
    }
    if lowered.contains("the host is offline") || lowered.contains("requires a live connection to the host") {
      return "The machine is offline. Reconnect, then try again."
    }
    if lowered.contains("the host returned incomplete") {
      return "The machine sent incomplete sync data. Retry the affected area or reconnect the machine."
    }
    if lowered.contains("pairing secret missing from response") || lowered.contains("invalid hello response") {
      return "The machine replied with unexpected pairing data. Reconnect and try again."
    }
    if lowered.contains("authentication failed") {
      return "This phone is no longer paired with this machine. Pair again from Settings."
    }
    if lowered.contains("invalid host address") {
      return "The machine address looks invalid. Check it and try again."
    }
    if lowered.contains("invalid queued operation payload") ||
        lowered.contains("queued operation payload is invalid") ||
        lowered.contains("unknown queued operation type") {
      return "Queued sync work on this phone became unreadable. Reconnect and try the action again."
    }
    if lowered.contains("remote command rejected") {
      return "The machine couldn't accept that request right now. Try again in a moment."
    }
    if lowered.contains("file request failed") {
      return "The machine couldn't finish that file request. Try again."
    }
    if lowered.contains("unable to start gzip decoder") || lowered.contains("unable to decode compressed sync payload") {
      return "The machine sent unreadable sync data. Reconnect and try again."
    }
    if lowered.contains("message too long") {
      return "The machine sent too much sync data in one message. Update ADE on the machine, then reconnect."
    }

    return rawMessage
  }

  static func error(from error: Error) -> NSError {
    let nsError = error as NSError
    let friendlyMessage = message(for: error)
    guard nsError.localizedDescription != friendlyMessage else { return nsError }

    var userInfo = nsError.userInfo
    userInfo[NSLocalizedDescriptionKey] = friendlyMessage
    userInfo[NSUnderlyingErrorKey] = userInfo[NSUnderlyingErrorKey] ?? error
    return NSError(domain: nsError.domain, code: nsError.code, userInfo: userInfo)
  }
}

func shouldHandleSocketSendCompletionError(
  currentSocket: URLSessionWebSocketTask?,
  callbackSocket: URLSessionWebSocketTask
) -> Bool {
  currentSocket === callbackSocket
}

private final class SyncSocketSessionDelegate: NSObject, URLSessionWebSocketDelegate, URLSessionTaskDelegate {
  weak var service: SyncService?

  func urlSession(
    _ session: URLSession,
    webSocketTask: URLSessionWebSocketTask,
    didOpenWithProtocol protocol: String?
  ) {
    Task { @MainActor [weak service] in
      service?.handleSocketDidOpen(webSocketTask)
    }
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didCompleteWithError error: Error?
  ) {
    guard let webSocketTask = task as? URLSessionWebSocketTask, let error else { return }
    Task { @MainActor [weak service] in
      service?.handleSocketDidComplete(webSocketTask, error: error)
    }
  }
}

struct FilesNavigationRequest: Equatable, Identifiable {
  let id: String
  let workspaceId: String
  let laneId: String?
  let relativePath: String?
  let focusLine: Int?

  init(workspaceId: String, laneId: String? = nil, relativePath: String?, focusLine: Int? = nil) {
    self.id = UUID().uuidString
    self.workspaceId = workspaceId
    self.laneId = laneId
    self.relativePath = relativePath
    self.focusLine = focusLine
  }
}

struct LaneNavigationRequest: Equatable, Identifiable {
  let id: String
  let laneId: String

  init(laneId: String) {
    self.id = UUID().uuidString
    self.laneId = laneId
  }
}

struct WorkSessionNavigationRequest: Equatable, Identifiable {
  let id: String
  let sessionId: String

  init(sessionId: String) {
    self.id = UUID().uuidString
    self.sessionId = sessionId
  }
}

struct PrNavigationRequest: Equatable, Identifiable {
  let id: String
  let prId: String
  let prNumber: Int?
  let laneId: String?

  init(prId: String, prNumber: Int? = nil, laneId: String? = nil) {
    self.id = UUID().uuidString
    self.prId = prId
    self.prNumber = prNumber
    self.laneId = laneId
  }

  init(prNumber: Int) {
    self.id = UUID().uuidString
    self.prId = "github-pr-number:\(prNumber)"
    self.prNumber = prNumber
    self.laneId = nil
  }
}

enum SyncRemoteCommandDelivery: Equatable {
  case dispatched
  case queued
  case dropped(String)

  init(commandResult: [String: Any]) {
    if commandResult["queued"] as? Bool == true {
      self = .queued
    } else {
      self = .dispatched
    }
  }
}

struct QueuedRemoteCommandError: LocalizedError {
  let action: String

  var errorDescription: String? {
    "That action is queued for this project and will run when the machine reconnects."
  }
}

private func syncNormalizedCommandScopeValue(_ value: String?) -> String? {
  guard let normalized = value?.trimmingCharacters(in: .whitespacesAndNewlines),
        !normalized.isEmpty
  else { return nil }
  return normalized
}

func syncNormalizedProjectRootScope(_ rootPath: String?) -> String? {
  guard var root = syncNormalizedCommandScopeValue(rootPath) else { return nil }
  while root.count > 1, root.hasSuffix("/") {
    root.removeLast()
  }
  return root
}

func syncCommandEnvelopePayload(
  commandId: String,
  action: String,
  args: [String: Any],
  projectId: String?,
  projectRootPath: String?
) -> [String: Any] {
  var payload: [String: Any] = [
    "commandId": commandId,
    "action": action,
    "args": args,
  ]
  if let projectId = syncNormalizedCommandScopeValue(projectId) {
    payload["projectId"] = projectId
  }
  if let projectRootPath = syncNormalizedProjectRootScope(projectRootPath) {
    payload["projectRootPath"] = projectRootPath
  }
  return payload
}

/// Builds the args dictionary for the `lanes.reparent` sync command.
///
/// Behavior mirrors the host contract in `apps/desktop/src/main/services/lanes/laneService.ts`:
/// - `newParentLaneId` is always emitted. Use the primary lane id when moving a lane to
///   the root of the stack.
/// - `stackBaseBranchRef` is only emitted when non-empty after trimming, so the host falls
///   back to the new parent lane's current branch when the caller leaves it blank.
func makeLanesReparentArgs(
  laneId: String,
  newParentLaneId: String,
  stackBaseBranchRef: String?
) -> [String: Any] {
  var args: [String: Any] = ["laneId": laneId]
  args["newParentLaneId"] = newParentLaneId.trimmingCharacters(in: .whitespacesAndNewlines)
  if let trimmed = stackBaseBranchRef?.trimmingCharacters(in: .whitespacesAndNewlines),
     !trimmed.isEmpty {
    args["stackBaseBranchRef"] = trimmed
  }
  return args
}

func makePrGithubSnapshotArgs(force: Bool = false, includeExternalClosed: Bool = false) -> [String: Any] {
  var args: [String: Any] = ["force": force]
  if includeExternalClosed {
    args["includeExternalClosed"] = true
  }
  return args
}

func syncOutboundEnvelopeProjectId(type: String, activeProjectId: String?) -> String? {
  let projectScopedTypes: Set<String> = [
    "changeset_batch",
    "changeset_ack",
    "command",
    "file_request",
    "terminal_subscribe",
    "terminal_unsubscribe",
    "terminal_input",
    "terminal_resize",
    "terminal_history",
    "chat_subscribe",
    "chat_unsubscribe",
  ]
  guard projectScopedTypes.contains(type) else { return nil }
  return syncNormalizedCommandScopeValue(activeProjectId)
}

/// Delivery events for the full-screen terminal. The active screen attaches a
/// handler per session id and receives hydration snapshots, ordered live
/// chunks, and process exit without polling `terminalBuffers`.
enum TerminalStreamEvent {
  /// Snapshot payload from `terminal_subscribe`. `replacing == false` means a
  /// delta resume (bytes from the requested `sinceOffset` to the end) that
  /// must be appended, not re-rendered from scratch.
  case hydrate(text: String, replacing: Bool, startOffset: Int?, endOffset: Int?)
  case chunk(text: String, endOffset: Int?)
  case exit(code: Int?)
}

@MainActor
final class SyncService: ObservableObject {
  @Published private(set) var connectionState: RemoteConnectionState = .disconnected
  @Published private(set) var hostName: String?
  @Published private(set) var activeHostProfile: HostConnectionProfile?
  @Published private(set) var projects: [MobileProjectSummary] = []
  @Published private(set) var activeProjectId: String?
  @Published private(set) var activeProjectRootPath: String?
  private var activeProjectHostIdentity: String?
  @Published private(set) var projectSwitchInFlightRootPath: String?
  @Published private(set) var discoveredHosts: [DiscoveredSyncHost] = []
  @Published private(set) var domainStatuses: [SyncDomain: SyncDomainStatus] = Dictionary(
    uniqueKeysWithValues: SyncDomain.allCases.map { ($0, .disconnected) }
  )
  @Published private(set) var lastSyncAt: Date?
  @Published private(set) var currentAddress: String?
  @Published private(set) var lastError: String?
  /// Host error CODE from the most recent pairing attempt (e.g. `pin_not_set`),
  /// preserved alongside the friendly `lastError` string so the PIN flow can
  /// branch on the code — routing a no-PIN machine to the "Set a PIN" screen —
  /// rather than parsing a localized message. Cleared whenever a fresh pairing
  /// attempt begins or a connection succeeds.
  @Published private(set) var lastPairingErrorCode: String?
  @Published private(set) var prefersReducedSyncLoad = false
  @Published private(set) var terminalBufferRevision = 0
  @Published private(set) var chatEventNotificationRevision = 0
  @Published private(set) var subscribedTerminalSessionIds: Set<String> = []
  @Published private(set) var subscribedChatSessionIds: Set<String> = []
  @Published private(set) var pendingOperationCount = 0
  @Published private(set) var localStateRevision = 0
  @Published private(set) var lanesProjectionRevision = 0
  @Published private(set) var laneDetailProjectionRevision = 0
  @Published private(set) var workProjectionRevision = 0
  @Published private(set) var filesProjectionRevision = 0
  @Published private(set) var prsProjectionRevision = 0
  @Published private(set) var proofArtifactsProjectionRevision = 0

  private let iso8601WithFractionalSecondsFormatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()
  private let iso8601Formatter: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]
    return formatter
  }()
  @Published private(set) var workspaceSnapshotRevision = 0
  // All-projects chat roster (mobile hub). `rosterProjects` is the machine-wide
  // projection of every project's lanes + chats; the hub reads it overlaid on
  // `projects` (the catalog). Mutated only by the roster apply path below.
  @Published private(set) var rosterProjects: [RemoteRosterProject] = []
  @Published private(set) var rosterRevision = 0
  /// Last applied roster `seq`; gates delta-vs-resnapshot. nil ⇒ no baseline.
  var rosterSeq: Int?
  /// Whether `roster_subscribe` has been sent on the current connection.
  var rosterSubscribed = false
  /// True once the host has answered at least one roster push this launch, so
  /// the hub knows the feed is supported (older hosts never answer → fallback).
  @Published private(set) var rosterSupported = false
  /// Debounces persistence of the roster snapshot to the App Group cache.
  var rosterPersistTask: Task<Void, Never>?
  @Published var settingsPresented = false
  @Published var projectHomePresented = true
  @Published var attentionDrawerPresented = false
  @Published var requestedWorkSessionNavigation: WorkSessionNavigationRequest?
  @Published var requestedFilesNavigation: FilesNavigationRequest?
  @Published var requestedLaneNavigation: LaneNavigationRequest?
  @Published var requestedPrNavigation: PrNavigationRequest?

  // MARK: - Durable PR action / detail state
  //
  // PR list, detail, and in-flight-action state used to live entirely in the
  // PRs views as `@State`. That had two fatal flaws: (1) switching tabs tore
  // the views down, cancelling in-flight action Tasks and dropping their
  // success/error feedback, and (2) re-entering the tab re-ran every reload
  // cold. SyncService is a `@MainActor ObservableObject` that outlives every
  // tab, so durable PR-action + detail-cache state lives here. Views READ from
  // these published values; the service OWNS the Task lifecycle.

  /// In-flight PR actions keyed by a stable string (prId, or
  /// `"<scope>:<id>"` for queue/integration/root actions). The views read this
  /// to render per-row / per-control spinners that survive a tab switch +
  /// remount. Owned exclusively by `beginPrAction`/`endPrAction`.
  @Published private(set) var prActionsInFlight: [String: PrInFlightAction] = [:]

  /// Warm cache of fully-loaded PR detail snapshots keyed by prId. Lets the
  /// detail screen render INSTANTLY on re-open / tab re-entry while a freshness
  /// gated background refresh runs. Bumped via `localStateRevision` on the
  /// view side; the entry's `loadedAt` gates whether the refresh actually
  /// re-fetches the sidecar fan-out.
  @Published private(set) var prDetailCache: [String: PrDetailWarmEntry] = [:]

  /// Repo-scoped GitHub PR list shared by the Lanes and Work tabs so a lane (a
  /// branch) can surface a PR opened directly on GitHub — not only PRs mapped
  /// into the synced `pull_requests` table. Populated best-effort by
  /// `refreshLaneGithubPrItems()`; empty when offline or not yet fetched, in
  /// which case the lane-PR chip falls back to the ADE-mapped rows alone.
  @Published private(set) var laneGithubPrItems: [GitHubPrListItem] = []
  private var laneGithubPrItemsFetchedAt: Date?

  var connectionHealth: SyncConnectionHealth {
    syncConnectionHealth(
      connectionState: connectionState,
      prefersReducedSyncLoad: prefersReducedSyncLoad,
      lastError: lastError
    )
  }

  private(set) var terminalBuffers: [String: String] = [:]
  private(set) var terminalBufferUpdatedAt: [String: Date] = [:]
  private(set) var terminalBufferRevisionsBySessionId: [String: Int] = [:]
  /// Transcript END byte offset (UTF-8) confirmed per terminal session, fed by
  /// `terminal_data.offset` and snapshot `endOffset`. Nil for hosts that do not
  /// emit offsets; all gap/dedupe logic disables itself in that case.
  private(set) var terminalEndOffsets: [String: Int] = [:]
  private var terminalStreamHandlers: [String: (TerminalStreamEvent) -> Void] = [:]
  private var terminalGapRecoveryInFlight: Set<String> = []
  private(set) var chatEventEnvelopesBySession: [String: [AgentChatEventEnvelope]] = [:]
  private(set) var chatEventRevisionsBySession: [String: Int] = [:]
  /// Highest host-assigned `seq` applied per chat session. Sent back as
  /// `sinceSeq` on re-subscribe so the host can replay exactly the missed
  /// events instead of a full snapshot, and used to drop duplicate/old
  /// events after a replay. Events without `seq` (older hosts) bypass this
  /// entirely, preserving today's behavior.
  private(set) var chatEventLastSeqBySession: [String: Int] = [:]
  /// Live "a turn is running right now" hint per chat session. Seeded from
  /// the chat_subscribe ack's `turnActive` field (authoritative host state at
  /// subscribe time) and kept current by live `status` / `done` chat events.
  /// Bridges two gaps the synced session row can't cover: the changeset pump
  /// lagging behind the chat event stream, and byte-capped snapshot tails
  /// that dropped the active turn's `status: started` event.
  private(set) var chatTurnActiveHintBySession: [String: Bool] = [:]
  /// Latest known chat summary keyed by session id. Populated by the Work
  /// list and chat detail screens so the LA reconcile can read `modelId`
  /// + a real `lastActivityAt` without round-tripping for each running chat.
  private(set) var chatSummaryCache: [String: AgentChatSessionSummary] = [:]
  private struct ChatModelsCacheEntry {
    var models: [AgentChatModelInfo]
    var fetchedAt: Date
  }
  private let chatModelsCacheTTL: TimeInterval = 300
  private var chatModelsCache: [String: ChatModelsCacheEntry] = [:]
  private var chatModelsInFlight: [String: Task<[AgentChatModelInfo], Error>] = [:]
  private struct ChatModelCatalogCacheEntry {
    var catalog: AgentChatModelCatalog
    var fetchedAt: Date
  }
  private var chatModelCatalogCache: [String: ChatModelCatalogCacheEntry] = [:]
  private var chatModelCatalogInFlight: [String: Task<AgentChatModelCatalog, Error>] = [:]

  private let legacyDraftKey = "ade.sync.connectionDraft"
  private let profileKey = "ade.sync.hostProfile"
  private let profilesKey = "ade.sync.hostProfiles"
  private let legacyDeviceIdKey = "ade.sync.deviceId"
  private let autoReconnectPausedKey = "ade.sync.autoReconnectPausedByUser"
  private let activeProjectIdKey = "ade.sync.activeProjectId"
  private let activeProjectRootPathKey = "ade.sync.activeProjectRootPath"
  private let activeProjectHostIdentityKey = "ade.sync.activeProjectHostIdentity"
  private let hiddenProjectsKey = "ade.sync.hiddenProjects"
  private let pendingOperationsKey = "ade.sync.pendingOperations"
  private let remoteCommandDescriptorsKey = "ade.sync.remoteCommandDescriptors"
  private let outboundSyncCursorsKey = "ade.sync.outboundSyncCursors"
  private let pendingOutboundChangesetsKey = "ade.sync.pendingOutboundChangesets"
  private let outboundSyncStateMaxEntries = 128
  private let maxChangesetAckRetries = 6
  private let keychain = KeychainService()
  private let database: DatabaseService
  private let socketSessionDelegate: SyncSocketSessionDelegate
  private let socketSession: URLSession
  private let pathMonitor = NWPathMonitor()
  private let pathMonitorQueue = DispatchQueue(label: "com.ade.sync.network-path")
  private let tailnetDiscovery = SyncTailnetProbe()
  private var socket: URLSessionWebSocketTask?
  private struct PendingRequest {
    let completion: (Result<Any, Error>) -> Void
    let timeoutTask: Task<Void, Never>
    /// Monotonic timestamp captured via `ProcessInfo.processInfo.systemUptime`
    /// — RTT calculations must not be skewed by user-initiated wall-clock
    /// adjustments (DST, NTP step, manual time changes).
    let startedAt: TimeInterval
  }

  private struct PendingOutboundChangeset {
    var payload: SyncChangesetBatchPayload
    var sentAt: TimeInterval
    var retryCount: Int
  }

  private struct OutboundSyncCursor: Codable, Equatable {
    var projectId: String?
    var projectRootPath: String?
    var hostId: String?
    var siteId: String
    var lastAckedDbVersion: Int
    var updatedAt: String
  }

  private struct PersistedOutboundChangeset: Codable, Equatable {
    var projectId: String?
    var projectRootPath: String?
    var hostId: String?
    var siteId: String
    var payload: SyncChangesetBatchPayload
    var retryCount: Int
    var updatedAt: String
  }

  private var pending: [String: PendingRequest] = [:]
  private var pendingOutboundChangeset: PendingOutboundChangeset?
  private var pendingSocketOpen: [Int: CheckedContinuation<Void, Error>] = [:]
  private var pendingSocketOpenTimeoutTasks: [Int: Task<Void, Never>] = [:]
  private let decoder = JSONDecoder()
  private let encoder = JSONEncoder()
  private let syncDateFormatter = ISO8601DateFormatter()
  private let compressionThresholdBytes = 4 * 1024
  private var relayTask: Task<Void, Never>?
  private var clientHeartbeatTask: Task<Void, Never>?
  private var hydrationTask: Task<Void, Never>?
  private var reconnectTask: Task<Void, Never>?
  private var networkPathReconnectTask: Task<Void, Never>?
  private var pendingOperationFlushTask: Task<Void, Never>?
  private var pendingOperationFlushInFlight = false
  private var lanePresenceHeartbeatTask: Task<Void, Never>?
  private var openLaneReferenceCounts: [String: Int] = [:]
  private var terminalBufferRevisionTask: Task<Void, Never>?
  private var chatEventRevisionTask: Task<Void, Never>?
  /// When the chat-event revision last fired; drives the coalescer's
  /// leading-edge check in `markChatEventsChanged`.
  private var lastChatEventRevisionBumpAt = Date.distantPast
  private var databaseObserver: NSObjectProtocol?
  /// Coalesces bursty `adeDatabaseDidChange` notifications so SwiftUI projection
  /// reloads do not fire on every CRDT row during host sync.
  private var databaseRevisionDebounceTask: Task<Void, Never>?
  private var pendingDatabaseTouchedTables: Set<String> = []
  private var pendingDatabaseChangeAffectsAll = false
  private var latestRemoteDbVersion = 0
  private var outboundLocalDbVersion = 0
  private var outboundCursorPersistTask: Task<Void, Never>?
  private var pendingOutboundCursorPersistVersion: Int?
  private var remoteCursorProfilePersistTask: Task<Void, Never>?
  private var pendingRemoteProfileDbVersion: Int?
  private var pendingRemoteProfileDbVersionBySite: [String: Int] = [:]
  private let discoveryBrowser = SyncBonjourBrowser()
  private var reconnectState = SyncReconnectState()
  private var envelopeChunkAssembler = SyncEnvelopeChunkAssembler()
  private var transportProbeTask: Task<Void, Never>?
  /// cr-sqlite site id of the project DB the connected host currently serves
  /// (lowercased), from hello_ok's serverDbSiteId. Nil for older hosts.
  private var activeRemoteDbSiteId: String?
  private var connectionGeneration: UInt64 = 0
  private var connectAttemptGeneration: UInt64 = 0
  private var lastInboundMessageAt: TimeInterval?
  private var allowAutoReconnect = true
  /// User-initiated disconnects should stay disconnected until the user explicitly reconnects or pairs again.
  private var autoReconnectPausedByUser = false
  /// When a saved pairing exists but discovery has not resolved the host yet, wait
  /// for live Bonjour data instead of dialing stale cached IPs on launch.
  private var autoReconnectAwaitingLiveDiscovery = false
  /// Prevents overlapping `reconnectIfPossible` runs from stacking TCP/WebSocket attempts.
  private var reconnectConnectInFlight = false
  private var bonjourDiscoveredHosts: [DiscoveredSyncHost] = []
  private var tailnetDiscoveredHosts: [DiscoveredSyncHost] = []
  private var lastNetworkPathSnapshot: SyncNetworkPathSnapshot?
  private var preferTailnetReconnectUntil: Date?
  private(set) var deviceId: String
  private var remoteCommandDescriptors: [SyncRemoteCommandDescriptor] = []
  private var remoteProjectCatalog: [MobileProjectSummary] = []
  private var hiddenProjectKeys: Set<String> = []
  private var pendingProjectCatalogChunks: [String: [Int: [MobileProjectSummary]]] = [:]
  private var supportsProjectCatalog = false
  private var supportsProjectActions = false
  private var supportsChatStreaming = false
  private var supportsChangesetAck = false
  private var projectSelectionTask: Task<Void, Never>?
  private var projectSelectionGeneration: UInt64 = 0
  private var healthyConnectionSampleCount = 0
  private var poorConnectionSampleCount = 0
  /// Monotonic deadline (seconds since boot, sourced from
  /// `ProcessInfo.processInfo.systemUptime`) for the forced reduced-load
  /// window. Wall-clock independent so daylight savings / NTP steps cannot
  /// abruptly extend or skip the window.
  private var forceReducedSyncLoadUntil: TimeInterval?

  /// Process-wide singleton populated by the first `init` and consumed by
  /// App Intent bridges plus the `@EnvironmentObject` propagated by `ADEApp`.
  /// Optional so tests / previews that spin up a secondary instance do not
  /// clobber the primary one.
  static var shared: SyncService?

  /// Sessions currently eligible for glance surfaces. Rebuilt from
  /// `localStateRevision` changes and written into the App Group snapshot for
  /// the lock-screen widget and in-app Attention Drawer.
  @Published private(set) var activeSessions: [AgentSnapshot] = []

  /// Chat sessions currently waiting on user input. Surfaced as a count chip
  /// instead of a roster row so old "awaiting" zombies don't pile up visually.
  @Published private(set) var awaitingInputSessionsCount: Int = 0

  /// Chat sessions currently reported as running. Kept as published state so
  /// SwiftUI tab rendering never synchronously enters SQLite from `body`.
  @Published private(set) var runningChatSessionCount: Int = 0

  /// Chat sessions paused / idle (connected but not producing output). Counted
  /// for context but never listed.
  @Published private(set) var idleSessionsCount: Int = 0

  /// 2s debounce task shared by all writers of the App Group workspace
  /// snapshot. Coalesces bursty state changes into a single widget reload.
  private var snapshotDebouncerTask: Task<Void, Never>?

  /// Tracks `activeSessions` derivation so we do not rebuild on every
  /// unrelated `localStateRevision` bump.
  private var activeSessionsObservationTask: Task<Void, Never>?
  private var activeSessionsSnapshotSignature = 0

  /// Backing storage for `attentionDrawer` + the Combine subscriptions it
  /// uses to observe `activeSessions` / workspace snapshot writes. Lazily
  /// initialised on first access so tests + previews that never touch the
  /// drawer don't allocate an extra `ObservableObject`.
  private var attentionDrawerStorage: AttentionDrawerModel?
  private var attentionDrawerCancellables: Set<AnyCancellable> = []

  /// Drawer surface injected into the root view via `.environmentObject`.
  /// Rebuilt from the App Group `WorkspaceSnapshot` each time the host
  /// state changes — no independent transport.
  @available(iOS 17.0, *)
  var attentionDrawer: AttentionDrawerModel {
    if let existing = attentionDrawerStorage { return existing }
    let fresh = AttentionDrawerModel()
    attentionDrawerCancellables = fresh.bind(to: self)
    attentionDrawerStorage = fresh
    return fresh
  }

  var hasCachedHostData: Bool {
    database.hasHydratedControllerData()
  }

  var shouldShowProjectHome: Bool {
    projectHomePresented || activeProjectId == nil
  }

  var activeProject: MobileProjectSummary? {
    guard activeProjectId != nil else { return nil }
    return projects.first { isActiveProject($0) }
  }

  func isActiveProject(_ project: MobileProjectSummary) -> Bool {
    if let activeProjectId {
      if project.id == activeProjectId {
        return true
      }
      if projects.contains(where: { $0.id == activeProjectId }) {
        return false
      }
    }
    guard let activeProjectRootPath,
          let projectRoot = normalizedProjectRoot(project.rootPath)
    else { return false }
    return projectRoot == activeProjectRootPath
  }

  var isProjectSwitching: Bool {
    projectSwitchInFlightRootPath != nil
  }

  func isSwitchingProject(_ project: MobileProjectSummary) -> Bool {
    guard let switchingRoot = projectSwitchInFlightRootPath else { return false }
    return normalizedProjectRoot(project.rootPath) == switchingRoot
  }

  func showProjectHome() {
    refreshProjectCatalog()
    projectHomePresented = true
    if supportsProjectCatalog, canSendLiveRequests() {
      Task { @MainActor [weak self] in
        await self?.refreshRemoteProjectCatalog()
      }
    }
  }

  func closeProjectHome() {
    guard activeProjectId != nil else { return }
    projectHomePresented = false
  }

  func selectProject(_ project: MobileProjectSummary) {
    let selectionGeneration = beginProjectSelection()
    unhideProject(project)

    if isActiveProject(project) {
      projectHomePresented = false
      return
    }

    if supportsProjectCatalog,
       canSendLiveRequests(),
       let rootPath = project.rootPath?.trimmingCharacters(in: .whitespacesAndNewlines),
       !rootPath.isEmpty {
      let normalizedSwitchRoot = normalizedProjectRoot(rootPath) ?? rootPath
      projectSwitchInFlightRootPath = normalizedSwitchRoot
      projectSelectionTask = Task { @MainActor [weak self] in
        guard let self else { return }
        do {
          try await self.switchToDesktopProject(project, rootPath: rootPath, selectionGeneration: selectionGeneration)
        } catch {
          guard self.isCurrentProjectSelection(selectionGeneration) else { return }
          self.lastError = SyncUserFacingError.message(for: error)
          self.setDomainStatus(SyncDomain.allCases, phase: .failed, error: self.lastError)
        }
        guard self.isCurrentProjectSelection(selectionGeneration) else { return }
        self.projectSwitchInFlightRootPath = nil
        self.projectSelectionTask = nil
      }
      return
    }

    guard project.isCached || database.hasProject(id: project.id) else {
      lastError = "That project has not been cached on this phone yet. Connect to the ADE machine before opening it."
      setDomainStatus(SyncDomain.allCases, phase: .failed, error: lastError)
      return
    }

    guard connectionState != .connected && connectionState != .syncing else {
      lastError = "This machine connection does not support project switching. Reconnect to a current ADE machine before opening another project."
      setDomainStatus(SyncDomain.allCases, phase: .failed, error: lastError)
      return
    }

    setActiveProjectId(project.id, rootPath: project.rootPath)
    projectHomePresented = false
    localStateRevision += 1
    refreshActiveSessionsAndSnapshot()
    scheduleWorkspaceSnapshotWrite()
    if connectionState == .connected || connectionState == .syncing {
      startInitialHydrationTask(for: connectionGeneration)
    }
  }

  /// Activate a project so a chat opened FROM THE HUB can stream its transcript,
  /// without leaving the hub (the chat is presented over it; Back returns to the
  /// hub). No-op when the project is already active. Returns once the project is
  /// active enough for the chat surface to load (or immediately on the local
  /// fallback path). Errors are surfaced via `lastError`, not thrown — the chat
  /// cover shows a loading/retry state.
  func openProjectForHubChat(_ project: MobileProjectSummary) async {
    if isActiveProject(project) { return }
    unhideProject(project)

    guard supportsProjectCatalog,
          canSendLiveRequests(),
          let rootPath = project.rootPath?.trimmingCharacters(in: .whitespacesAndNewlines),
          !rootPath.isEmpty else {
      // Cached/offline fallback: point reads at the project locally without
      // tearing down the hub. Transcript streaming resumes when live.
      if project.isCached || database.hasProject(id: project.id) {
        setActiveProjectId(project.id, rootPath: project.rootPath)
        localStateRevision += 1
        refreshActiveSessionsAndSnapshot()
      }
      return
    }

    let selectionGeneration = beginProjectSelection()
    let normalizedSwitchRoot = normalizedProjectRoot(rootPath) ?? rootPath
    projectSwitchInFlightRootPath = normalizedSwitchRoot
    do {
      try await switchToDesktopProject(project, rootPath: rootPath, selectionGeneration: selectionGeneration, dismissHome: false)
    } catch {
      if isCurrentProjectSelection(selectionGeneration) {
        lastError = SyncUserFacingError.message(for: error)
      }
    }
    if isCurrentProjectSelection(selectionGeneration) {
      projectSwitchInFlightRootPath = nil
    }
  }

  func forgetProject(_ project: MobileProjectSummary) {
    let wasActive = isActiveProject(project)
    rememberHiddenProject(project)
    remoteProjectCatalog.removeAll { existing in
      existing.id == project.id
        || (normalizedProjectRoot(existing.rootPath) != nil
          && normalizedProjectRoot(existing.rootPath) == normalizedProjectRoot(project.rootPath))
    }
    refreshProjectCatalog()
    if wasActive {
      _ = beginProjectSelection()
      resetChatEventState(clearHistory: false)
      resetTerminalSubscriptionState(clearHistory: true)
      setActiveProjectId(nil)
      latestRemoteDbVersion = 0
      resetOutboundCursorStateForActiveProject()
      projectHomePresented = true
      localStateRevision += 1
      refreshActiveSessionsAndSnapshot()
      scheduleWorkspaceSnapshotWrite()
    }

    guard canSendLiveRequests() else { return }
    let requestId = makeRequestId()
    var payload: [String: Any] = ["projectId": project.id]
    if let rootPath = project.rootPath?.trimmingCharacters(in: .whitespacesAndNewlines), !rootPath.isEmpty {
      payload["rootPath"] = rootPath
    }
    Task { @MainActor [weak self] in
      guard let self else { return }
      do {
        let raw = try await awaitResponse(
          requestId: requestId,
          disconnectOnTimeout: false,
          timeoutMessage: "Timed out removing that project.",
          timeoutNanoseconds: 8_000_000_000
        ) {
          self.sendEnvelope(type: "project_forget_request", requestId: requestId, payload: payload)
        }
        let result = try decode(raw, as: MobileProjectForgetResultPayload.self)
        if !result.ok {
          syncConnectLog.info("project forget failed message=\((result.message ?? "unknown"), privacy: .public)")
        }
      } catch {
        syncConnectLog.info("project forget request failed error=\(String(describing: error), privacy: .public)")
      }
    }
  }

  func refreshProjectCatalog(preferRemoteSelection: Bool = false) {
    let cachedProjects = database.listMobileProjects().filter { !isProjectHidden($0) }
    let remoteCatalog = deduplicatedRemoteProjectCatalog()
    let hasRemoteCatalog = !remoteCatalog.isEmpty
    var mergedById = Dictionary(uniqueKeysWithValues: remoteCatalog.map { ($0.id, $0) })
    for cachedProject in cachedProjects {
      if var existing = mergedById[cachedProject.id] {
        existing.displayName = cachedProject.displayName
        existing.rootPath = cachedProject.rootPath ?? existing.rootPath
        existing.defaultBaseRef = cachedProject.defaultBaseRef ?? existing.defaultBaseRef
        existing.lastOpenedAt = cachedProject.lastOpenedAt ?? existing.lastOpenedAt
        existing.iconDataUrl = cachedProject.iconDataUrl ?? existing.iconDataUrl
        existing.laneCount = cachedProject.laneCount
        existing.isCached = true
        existing.isAvailable = existing.isAvailable || cachedProject.isAvailable
        mergedById[cachedProject.id] = existing
      } else if let match = mergedById.first(where: { entry in
        let remote = entry.value
        guard let left = remote.rootPath, let right = cachedProject.rootPath else { return false }
        return normalizedProjectRoot(left) == normalizedProjectRoot(right)
      }) {
        var existing = match.value
        let keepRemoteIdentity = preferRemoteSelection
          && activeProjectId != nil
          && activeProjectRootPath != nil
          && normalizedProjectRoot(existing.rootPath) == activeProjectRootPath
        if !keepRemoteIdentity {
          mergedById.removeValue(forKey: match.key)
          existing.id = cachedProject.id
        }
        existing.displayName = keepRemoteIdentity ? existing.displayName : cachedProject.displayName
        existing.defaultBaseRef = cachedProject.defaultBaseRef ?? existing.defaultBaseRef
        existing.lastOpenedAt = cachedProject.lastOpenedAt ?? existing.lastOpenedAt
        existing.iconDataUrl = cachedProject.iconDataUrl ?? existing.iconDataUrl
        existing.laneCount = keepRemoteIdentity ? existing.laneCount : cachedProject.laneCount
        existing.isCached = keepRemoteIdentity ? (existing.isCached || database.hasProject(id: existing.id)) : true
        existing.isAvailable = existing.isAvailable || cachedProject.isAvailable
        mergedById[existing.id] = existing
      } else if !hasRemoteCatalog {
        mergedById[cachedProject.id] = cachedProject
      }
    }
    if let activeProjectId,
       mergedById[activeProjectId] == nil,
       let activeProjectRootPath,
       let match = mergedById.first(where: { entry in
         normalizedProjectRoot(entry.value.rootPath) == activeProjectRootPath
       }) {
      if preferRemoteSelection {
        setActiveProjectId(match.value.id, rootPath: match.value.rootPath)
      } else if match.value.isCached {
        setActiveProjectId(match.value.id, rootPath: match.value.rootPath)
      } else {
        var existing = match.value
        mergedById.removeValue(forKey: match.key)
        existing.id = activeProjectId
        mergedById[activeProjectId] = existing
      }
    }
    let sortedProjects = sortedProjectList(Array(mergedById.values))
    projects = deduplicateProjectListByRoot(sortedProjects)
    if preferRemoteSelection {
      preferActiveProjectFromRemoteCatalogIfNeeded()
    }
    normalizeActiveProjectSelection(allowSingleProjectFallback: false)
  }

  private func preferActiveProjectFromRemoteCatalogIfNeeded() {
    guard activeProjectId != nil else { return }
    let remoteProjects = deduplicatedRemoteProjectCatalog()
    guard !remoteProjects.isEmpty else { return }
    if let activeProjectId,
       remoteProjects.contains(where: { $0.id == activeProjectId }) {
      return
    }
    if let activeProjectRootPath,
       let matchingProject = remoteProjects.first(where: { normalizedProjectRoot($0.rootPath) == activeProjectRootPath }) {
      setActiveProjectId(matchingProject.id, rootPath: matchingProject.rootPath)
      return
    }
  }

  private func deduplicatedRemoteProjectCatalog() -> [MobileProjectSummary] {
    var byId: [String: MobileProjectSummary] = [:]
    var idByRoot: [String: String] = [:]

    for project in remoteProjectCatalog {
      if isProjectHidden(project) {
        continue
      }
      let rootKey = normalizedProjectRoot(project.rootPath)
      if let rootKey, let existingId = idByRoot[rootKey], let existing = byId[existingId] {
        if shouldPreferProject(project, over: existing) {
          byId.removeValue(forKey: existingId)
          byId[project.id] = project
          idByRoot[rootKey] = project.id
        }
        continue
      }

      if let existing = byId[project.id] {
        byId[project.id] = shouldPreferProject(project, over: existing) ? project : existing
      } else {
        byId[project.id] = project
      }

      if let rootKey {
        idByRoot[rootKey] = byId[project.id]?.id ?? project.id
      }
    }

    return Array(byId.values)
  }

  private func shouldPreferProject(_ candidate: MobileProjectSummary, over existing: MobileProjectSummary) -> Bool {
    if candidate.isAvailable != existing.isAvailable {
      return candidate.isAvailable
    }
    if candidate.isCached != existing.isCached {
      return candidate.isCached
    }
    return (candidate.lastOpenedAt ?? "") > (existing.lastOpenedAt ?? "")
  }

  private func deduplicateProjectListByRoot(_ candidates: [MobileProjectSummary]) -> [MobileProjectSummary] {
    var seenRoots = Set<String>()
    return candidates.filter { project in
      guard let root = normalizedProjectRoot(project.rootPath) else { return true }
      return seenRoots.insert(root).inserted
    }
  }

  private func sortedProjectList(_ candidates: [MobileProjectSummary]) -> [MobileProjectSummary] {
    candidates.sorted { left, right in
      let leftActive = activeProjectId != nil && left.id == activeProjectId
      let rightActive = activeProjectId != nil && right.id == activeProjectId
      if leftActive != rightActive { return leftActive }
      let leftOpen = left.isOpen ?? true
      let rightOpen = right.isOpen ?? true
      if leftOpen != rightOpen { return leftOpen }
      return (left.lastOpenedAt ?? "") > (right.lastOpenedAt ?? "")
    }
  }

  private func activeProjectCatalogEntryForHydration() -> MobileProjectSummary? {
    guard let activeProjectId else { return nil }
    let candidates = projects + remoteProjectCatalog
    if let match = candidates.first(where: { $0.id == activeProjectId }) {
      return match
    }
    guard let activeProjectRootPath else { return nil }
    return candidates.first { normalizedProjectRoot($0.rootPath) == activeProjectRootPath }
  }

  private func ensureActiveProjectCacheRowForHydration() throws {
    guard let activeProjectId else { return }
    if database.hasProject(id: activeProjectId) {
      return
    }
    guard let project = activeProjectCatalogEntryForHydration() else {
      return
    }
    try database.upsertMobileProjectCache(project)
    refreshProjectCatalog(preferRemoteSelection: true)
  }

  private func applyRemoteProjectCatalog(
    _ catalog: MobileProjectCatalogPayload,
    preferRemoteSelection: Bool = true
  ) {
    remoteProjectCatalog = catalog.projects.filter { !isProjectHidden($0) }
    refreshProjectCatalog(preferRemoteSelection: preferRemoteSelection)
  }

  private func applyRemoteProjectCatalogChunk(
    _ chunk: MobileProjectCatalogChunkPayload,
    requestId: String?
  ) {
    guard chunk.index >= 0, chunk.total > 0, chunk.index < chunk.total else { return }
    var chunks = pendingProjectCatalogChunks[chunk.catalogId] ?? [:]
    chunks[chunk.index] = chunk.projects
    pendingProjectCatalogChunks[chunk.catalogId] = chunks

    guard chunks.count == chunk.total else { return }
    let projects = (0..<chunk.total).flatMap { chunks[$0] ?? [] }
    pendingProjectCatalogChunks.removeValue(forKey: chunk.catalogId)
    let payload = MobileProjectCatalogPayload(projects: projects)
    applyRemoteProjectCatalog(payload)
    resolve(requestId: requestId, result: .success(["projects": projects.map { project in
      (try? JSONSerialization.jsonObject(with: encoder.encode(project))) ?? [:]
    }]))
  }

  private func refreshRemoteProjectCatalog() async {
    guard supportsProjectCatalog, canSendLiveRequests() else { return }
    let requestId = makeRequestId()
    do {
      let raw = try await awaitResponse(
        requestId: requestId,
        disconnectOnTimeout: false,
        timeoutMessage: "Timed out waiting for the machine project list."
      ) {
        self.sendEnvelope(type: "project_catalog_request", requestId: requestId, payload: [:])
      }
      let catalog = try decode(raw, as: MobileProjectCatalogPayload.self)
      applyRemoteProjectCatalog(catalog)
    } catch {
      syncConnectLog.info("project catalog refresh failed error=\(String(describing: error), privacy: .public)")
    }
  }

  var canRunRemoteProjectActions: Bool {
    supportsProjectActions && canSendLiveRequests()
  }

  private func requireRemoteProjectActionsAvailable() throws {
    guard supportsProjectActions else {
      throw NSError(domain: "ADE", code: 31, userInfo: [
        NSLocalizedDescriptionKey: "This machine does not support mobile project management. Update ADE on the machine and reconnect."
      ])
    }
    guard canSendLiveRequests() else {
      throw NSError(domain: "ADE", code: 14, userInfo: [
        NSLocalizedDescriptionKey: "The machine is offline."
      ])
    }
  }

  private func requestMachineProjectPayload<T: Decodable>(
    type: String,
    payload: [String: Any],
    responseType: T.Type,
    timeoutMessage: String,
    timeoutNanoseconds: UInt64 = SyncRequestTimeout.defaultTimeoutNanoseconds
  ) async throws -> T {
    try requireRemoteProjectActionsAvailable()
    let requestId = makeRequestId()
    let raw = try await awaitResponse(
      requestId: requestId,
      disconnectOnTimeout: false,
      timeoutMessage: timeoutMessage,
      timeoutNanoseconds: timeoutNanoseconds
    ) {
      self.sendEnvelope(type: type, requestId: requestId, payload: payload)
    }
    return try decode(raw, as: responseType)
  }

  func browseMachineProjectDirectories(
    partialPath: String,
    cwd: String? = nil,
    limit: Int = 80
  ) async throws -> MobileProjectBrowseResult {
    let boundedLimit = max(1, min(limit, 500))
    var payload: [String: Any] = [
      "partialPath": partialPath,
      "limit": boundedLimit,
    ]
    if let cwd, !cwd.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      payload["cwd"] = cwd
    }
    let response = try await requestMachineProjectPayload(
      type: "project_browse_request",
      payload: payload,
      responseType: MobileProjectBrowseResultPayload.self,
      timeoutMessage: "Timed out browsing project folders."
    )
    guard response.ok, let result = response.result else {
      throw NSError(domain: "ADE", code: 32, userInfo: [
        NSLocalizedDescriptionKey: response.message ?? "The machine could not browse that folder."
      ])
    }
    return result
  }

  func machineProjectDefaultParentDir() async throws -> String {
    let response = try await requestMachineProjectPayload(
      type: "project_default_parent_dir_request",
      payload: [:],
      responseType: MobileProjectDefaultParentDirPayload.self,
      timeoutMessage: "Timed out reading the default project folder."
    )
    guard response.ok, let parentDir = response.parentDir, !parentDir.isEmpty else {
      throw NSError(domain: "ADE", code: 33, userInfo: [
        NSLocalizedDescriptionKey: response.message ?? "The machine did not provide a project folder."
      ])
    }
    return parentDir
  }

  private func applyMachineProjectActionResponse(
    _ response: MobileProjectActionResultPayload,
    fallbackMessage: String
  ) throws -> MobileProjectSummary {
    guard response.ok, let project = response.project else {
      throw NSError(domain: "ADE", code: 34, userInfo: [
        NSLocalizedDescriptionKey: response.message ?? fallbackMessage
      ])
    }
    unhideProject(project)
    remoteProjectCatalog.removeAll { existing in
      existing.id == project.id
        || (normalizedProjectRoot(existing.rootPath) != nil
          && normalizedProjectRoot(existing.rootPath) == normalizedProjectRoot(project.rootPath))
    }
    remoteProjectCatalog.append(project)
    refreshProjectCatalog(preferRemoteSelection: true)
    return project
  }

  func openMachineProject(rootPath: String) async throws -> MobileProjectSummary {
    let response = try await requestMachineProjectPayload(
      type: "project_open_request",
      payload: ["rootPath": rootPath],
      responseType: MobileProjectActionResultPayload.self,
      timeoutMessage: "Timed out opening that project.",
      timeoutNanoseconds: 120_000_000_000
    )
    return try applyMachineProjectActionResponse(response, fallbackMessage: "The machine could not open that project.")
  }

  func createMachineProject(name: String, parentDir: String) async throws -> MobileProjectSummary {
    let response = try await requestMachineProjectPayload(
      type: "project_create_request",
      payload: ["name": name, "parentDir": parentDir],
      responseType: MobileProjectActionResultPayload.self,
      timeoutMessage: "Timed out creating that project.",
      timeoutNanoseconds: 120_000_000_000
    )
    return try applyMachineProjectActionResponse(response, fallbackMessage: "The machine could not create that project.")
  }

  func cloneMachineProject(url: String, name: String, parentDir: String) async throws -> MobileProjectSummary {
    var payload: [String: Any] = [
      "url": url,
      "parentDir": parentDir,
    ]
    let trimmedName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmedName.isEmpty {
      payload["name"] = trimmedName
    }
    let response = try await requestMachineProjectPayload(
      type: "project_clone_request",
      payload: payload,
      responseType: MobileProjectActionResultPayload.self,
      timeoutMessage: "The machine is still cloning that project. Try again in a moment.",
      timeoutNanoseconds: 300_000_000_000
    )
    return try applyMachineProjectActionResponse(response, fallbackMessage: "The machine could not clone that project.")
  }

  func listMachineGitHubRepos(search: String = "") async throws -> [MobileGitHubRepoSummary] {
    var payload: [String: Any] = [:]
    let trimmedSearch = search.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmedSearch.isEmpty {
      payload["search"] = trimmedSearch
    }
    let response = try await requestMachineProjectPayload(
      type: "project_list_my_github_repos_request",
      payload: payload,
      responseType: MobileProjectListMyGitHubReposResultPayload.self,
      timeoutMessage: "Timed out loading GitHub repositories."
    )
    guard response.ok, let result = response.result else {
      throw NSError(domain: "ADE", code: 35, userInfo: [
        NSLocalizedDescriptionKey: response.message ?? "The machine could not load GitHub repositories."
      ])
    }
    return result.repos
  }

  private func switchToDesktopProject(
    _ project: MobileProjectSummary,
    rootPath: String,
    selectionGeneration: UInt64,
    dismissHome: Bool = true
  ) async throws {
    let requestId = makeRequestId()
    let raw = try await awaitResponse(requestId: requestId) {
      self.sendEnvelope(type: "project_switch_request", requestId: requestId, payload: [
        "projectId": project.id,
        "rootPath": rootPath,
      ])
    }
    let result = try decode(raw, as: MobileProjectSwitchResultPayload.self)
    guard result.ok else {
      throw NSError(domain: "ADE", code: 24, userInfo: [
        NSLocalizedDescriptionKey: result.message ?? "The machine could not open that project for phone sync."
      ])
    }
    guard isCurrentProjectSelection(selectionGeneration) else {
      throw CancellationError()
    }

    let targetProject = result.project ?? project
    let previousActiveProjectId = activeProjectId
    let previousActiveProjectRootPath = activeProjectRootPath
    let previousProfile = loadProfile()
    let previousToken = tokenForProfile(previousProfile)
    let previousLatestRemoteDbVersion = latestRemoteDbVersion
    let previousRemoteProjectCatalog = remoteProjectCatalog
    remoteProjectCatalog.removeAll { existing in
      existing.id == targetProject.id
        || (normalizedProjectRoot(existing.rootPath) != nil
          && normalizedProjectRoot(existing.rootPath) == normalizedProjectRoot(targetProject.rootPath))
    }
    remoteProjectCatalog.append(targetProject)
    setActiveProjectId(targetProject.id, rootPath: targetProject.rootPath ?? project.rootPath)
    refreshProjectCatalog()
    latestRemoteDbVersion = 0
    resetOutboundCursorStateForActiveProject()

    guard let connection = result.connection else {
      // Desktop's success path for project_switch_request intentionally returns
      // no connection bundle — the phone keeps its existing pairing creds and
      // reconnects via the WebSocket. Treat this as a successful switch:
      // preserve the new active project, tear down any live socket, and let
      // reconnectIfPossible re-establish streaming for the new project.
      if dismissHome { projectHomePresented = false }
      localStateRevision += 1
      refreshActiveSessionsAndSnapshot()
      scheduleWorkspaceSnapshotWrite()
      // Clear stale failure state from the prior project so the reconnect gap
      // shows active handoff progress instead of a leftover failure banner.
      lastError = nil
      let hadLiveSocket = connectionState == .connected || connectionState == .syncing
      if hadLiveSocket {
        teardownSocket(reason: "Switching project.")
      }
      // Drop chat/terminal subscriptions tied to the previous project so we do
      // not resubscribe to stale session ids after reconnecting to the new
      // project. Stale subs cause foreign chat events to leak into the new
      // project's view and may collide with new session ids on the host.
      resetChatEventState(clearHistory: false)
      resetTerminalSubscriptionState(clearHistory: true)
      connectionState = .connecting
      setDomainStatus(SyncDomain.allCases, phase: .syncingInitialData)
      Task { @MainActor [weak self] in
        await self?.reconnectIfPossible(userInitiated: true)
      }
      return
    }

    let addressCandidates = deduplicatedAddresses(
      connection.addressCandidates.map(\.host)
        + (currentAddress.map { [$0] } ?? [])
        + (activeHostProfile?.savedAddressCandidates ?? [])
    )
    guard !addressCandidates.isEmpty else {
      throw NSError(domain: "ADE", code: 25, userInfo: [
        NSLocalizedDescriptionKey: "The machine did not provide an address for that project."
      ])
    }

    let bundledToken = connection.token?.trimmingCharacters(in: .whitespacesAndNewlines)
    let hasBundledToken = bundledToken?.isEmpty == false
    let resolvedToken = hasBundledToken ? bundledToken : previousToken
    guard let resolvedToken else {
      throw NSError(domain: "ADE", code: 26, userInfo: [
        NSLocalizedDescriptionKey: "The machine did not provide credentials for that project, and this phone has no saved pairing for that machine."
      ])
    }
    let resolvedAuthKind = hasBundledToken ? connection.authKind : (previousProfile?.authKind ?? connection.authKind)
    let resolvedPairedDeviceId =
      connection.pairedDeviceId
        ?? previousProfile?.pairedDeviceId
        ?? (resolvedAuthKind == "paired" ? deviceId : nil)

    let profile = HostConnectionProfile(
      hostIdentity: connection.hostIdentity.deviceId,
      hostName: connection.hostIdentity.name,
      siteId: syncNonEmpty(connection.hostIdentity.siteId),
      port: connection.port,
      authKind: resolvedAuthKind,
      pairedDeviceId: resolvedPairedDeviceId,
      lastRemoteDbVersion: 0,
      lastHostDeviceId: connection.hostIdentity.deviceId,
      lastSuccessfulAddress: addressCandidates.first,
      savedAddressCandidates: addressCandidates,
      discoveredLanAddresses: addressCandidates.filter { host in
        guard !host.contains(":") else { return false }
        guard host != "127.0.0.1" else { return false }
        return !syncIsTailscaleRoute(host)
      },
      tailscaleAddress: addressCandidates.first(where: syncIsTailscaleRoute)
    )

    let connectAttemptGeneration = beginConnectAttempt()
    do {
      keychain.saveToken(resolvedToken)
      keychain.saveToken(resolvedToken, hostKey: profileStorageKey(profile))
      saveProfile(profile)
      teardownSocket(reason: "Switching project.")
      // Drop chat/terminal subscriptions tied to the previous project so we do
      // not resubscribe to stale session ids after reconnecting to the new
      // project. Stale subs cause foreign chat events to leak into the new
      // project's view and may collide with new session ids on the host.
      resetChatEventState(clearHistory: false)
      resetTerminalSubscriptionState(clearHistory: true)
      let connectedEndpoint = try await connectUsingProfile(
        profile,
        token: resolvedToken,
        connectAttemptGeneration: connectAttemptGeneration,
        preferLiveCandidatesOnly: false,
        publishConnecting: true
      )
      guard isCurrentConnectAttempt(connectAttemptGeneration), isCurrentProjectSelection(selectionGeneration) else { return }
      currentAddress = connectedEndpoint.host
      if dismissHome { projectHomePresented = false }
      localStateRevision += 1
      refreshActiveSessionsAndSnapshot()
      scheduleWorkspaceSnapshotWrite()
    } catch {
      guard isCurrentProjectSelection(selectionGeneration) else {
        throw error
      }
      setActiveProjectId(previousActiveProjectId, rootPath: previousActiveProjectRootPath)
      latestRemoteDbVersion = previousLatestRemoteDbVersion
      resetOutboundCursorStateForActiveProject()
      remoteProjectCatalog = previousRemoteProjectCatalog
      if let previousToken {
        keychain.saveToken(previousToken)
        keychain.saveToken(previousToken, hostKey: previousProfile.flatMap { profileStorageKey($0) })
      } else {
        keychain.clearToken()
      }
      saveProfile(previousProfile)
      refreshProjectCatalog()
      localStateRevision += 1
      refreshActiveSessionsAndSnapshot()
      scheduleWorkspaceSnapshotWrite()
      connectionState = .disconnected
      currentAddress = nil
      if previousProfile != nil, previousToken != nil {
        Task { @MainActor [weak self] in
          await self?.reconnectIfPossible(userInitiated: true)
        }
      }
      throw error
    }
  }

  private func beginProjectSelection() -> UInt64 {
    projectSelectionTask?.cancel()
    projectSelectionTask = nil
    projectSwitchInFlightRootPath = nil
    projectSelectionGeneration &+= 1
    return projectSelectionGeneration
  }

  private func isCurrentProjectSelection(_ generation: UInt64) -> Bool {
    !Task.isCancelled && projectSelectionGeneration == generation
  }

  private func setActiveProjectId(_ projectId: String?, rootPath: String? = nil) {
    let previousProjectId = normalizedProjectId(activeProjectId)
    let previousRootPath = normalizedProjectRoot(activeProjectRootPath)
    let nextProjectId = normalizedProjectId(projectId)
    let nextRootPath = projectId == nil
      ? nil
      : normalizedProjectRoot(rootPath)
        ?? projectId.flatMap { id in
          projects.first { $0.id == id }.flatMap { normalizedProjectRoot($0.rootPath) }
        }
    let scopeChanged = previousProjectId != nextProjectId || previousRootPath != nextRootPath
    if scopeChanged {
      prepareOutboundStateForProjectScopeChange()
    }
    activeProjectId = projectId
    activeProjectRootPath = nextRootPath
    database.setActiveProjectId(projectId)
    if scopeChanged {
      bumpProjectionRevisions(for: Set())
    }
    if let projectId {
      UserDefaults.standard.set(projectId, forKey: activeProjectIdKey)
    } else {
      UserDefaults.standard.removeObject(forKey: activeProjectIdKey)
    }
    if let activeProjectRootPath {
      UserDefaults.standard.set(activeProjectRootPath, forKey: activeProjectRootPathKey)
    } else {
      UserDefaults.standard.removeObject(forKey: activeProjectRootPathKey)
    }
    if projectId != nil {
      let hostIdentity = syncNormalizedCommandScopeValue(activeHostProfile?.hostIdentity)
        ?? syncNormalizedCommandScopeValue(activeHostProfile?.lastHostDeviceId)
      activeProjectHostIdentity = hostIdentity
      if let hostIdentity {
        UserDefaults.standard.set(hostIdentity, forKey: activeProjectHostIdentityKey)
      } else {
        UserDefaults.standard.removeObject(forKey: activeProjectHostIdentityKey)
      }
    } else {
      activeProjectHostIdentity = nil
      UserDefaults.standard.removeObject(forKey: activeProjectHostIdentityKey)
    }
    if scopeChanged {
      resetOutboundCursorStateForActiveProject()
    }
  }

  private func normalizeActiveProjectSelection(allowSingleProjectFallback: Bool) {
    let projectIds = Set(projects.map(\.id))

    // Keep a still-valid active project before considering any remote-catalog
    // remap. If the cached row is in `projects`, we must not override it with
    // a different id from `remoteProjectCatalog` — `refreshProjectCatalog`
    // intentionally preserves the existing selection when it keeps a cached
    // row for the same root.
    if let activeProjectId, projectIds.contains(activeProjectId) {
      database.setActiveProjectId(activeProjectId)
      return
    }

    if let activeProjectId,
       let activeProjectRootPath,
       let remoteProject = deduplicatedRemoteProjectCatalog().first(where: { project in
         project.id != activeProjectId
           && normalizedProjectRoot(project.rootPath) == activeProjectRootPath
       }),
       projectIds.contains(remoteProject.id) {
      setActiveProjectId(remoteProject.id, rootPath: remoteProject.rootPath)
      return
    }

    if let activeProjectId,
       let activeProjectRootPath,
       let matchingProject = projects.first(where: { normalizedProjectRoot($0.rootPath) == activeProjectRootPath }) {
      if matchingProject.isCached || database.hasProject(id: matchingProject.id) {
        setActiveProjectId(matchingProject.id, rootPath: matchingProject.rootPath)
      } else {
        database.setActiveProjectId(activeProjectId)
      }
      return
    }

    if activeProjectId != nil {
      setActiveProjectId(nil)
    }

    if allowSingleProjectFallback, projects.count == 1, let onlyProject = projects.first {
      setActiveProjectId(onlyProject.id, rootPath: onlyProject.rootPath)
      projectHomePresented = false
    }
  }

  private func normalizedProjectRoot(_ rootPath: String?) -> String? {
    syncNormalizedProjectRootScope(rootPath)
  }

  private func hiddenKeys(for project: MobileProjectSummary) -> Set<String> {
    var keys = Set<String>()
    if let id = normalizedProjectId(project.id) {
      keys.insert("id:\(id)")
    }
    if let root = normalizedProjectRoot(project.rootPath) {
      keys.insert("root:\(root)")
    }
    return keys
  }

  private func isProjectHidden(_ project: MobileProjectSummary) -> Bool {
    !hiddenProjectKeys.isDisjoint(with: hiddenKeys(for: project))
  }

  private func hiddenProjectsStorageKey() -> String {
    if let hostKey = activeHostStorageKey() {
      return "\(hiddenProjectsKey).\(hostKey)"
    }
    return hiddenProjectsKey
  }

  private func loadHiddenProjectKeys() -> Set<String> {
    let key = hiddenProjectsStorageKey()
    if key != hiddenProjectsKey,
       UserDefaults.standard.stringArray(forKey: key) == nil,
       let legacyKeys = UserDefaults.standard.stringArray(forKey: hiddenProjectsKey),
       !legacyKeys.isEmpty {
      UserDefaults.standard.set(legacyKeys, forKey: key)
      UserDefaults.standard.removeObject(forKey: hiddenProjectsKey)
      return Set(legacyKeys)
    }
    return Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
  }

  private func saveHiddenProjectKeys() {
    let key = hiddenProjectsStorageKey()
    if hiddenProjectKeys.isEmpty {
      UserDefaults.standard.removeObject(forKey: key)
    } else {
      UserDefaults.standard.set(hiddenProjectKeys.sorted(), forKey: key)
    }
    if key != hiddenProjectsKey {
      UserDefaults.standard.removeObject(forKey: hiddenProjectsKey)
    }
  }

  private func rememberHiddenProject(_ project: MobileProjectSummary) {
    let keys = hiddenKeys(for: project)
    guard !keys.isEmpty else { return }
    let previous = hiddenProjectKeys
    hiddenProjectKeys.formUnion(keys)
    guard hiddenProjectKeys != previous else { return }
    saveHiddenProjectKeys()
  }

  private func unhideProject(_ project: MobileProjectSummary) {
    var keys = hiddenKeys(for: project)
    if let root = normalizedProjectRoot(project.rootPath) {
      let aliases = projects + remoteProjectCatalog + database.listMobileProjects()
      for alias in aliases where normalizedProjectRoot(alias.rootPath) == root {
        keys.formUnion(hiddenKeys(for: alias))
      }
    }
    guard !keys.isEmpty, !hiddenProjectKeys.isDisjoint(with: keys) else { return }
    hiddenProjectKeys.subtract(keys)
    saveHiddenProjectKeys()
  }

  private let queueableFileActions: Set<String> = [
    "writeText",
    "createFile",
    "createDirectory",
    "rename",
    "deletePath",
  ]

  private struct PendingOperation: Codable, Identifiable {
    let id: String
    let kind: String
    let action: String
    let payload: Data
    let queuedAt: String
    let hostId: String?
    let projectId: String?
    let projectRootPath: String?
  }

  init(database: DatabaseService = DatabaseService()) {
    let socketSessionDelegate = SyncSocketSessionDelegate()
    let socketSessionConfiguration = URLSessionConfiguration.default
    socketSessionConfiguration.waitsForConnectivity = false
    let socketSession = URLSession(
      configuration: socketSessionConfiguration,
      delegate: socketSessionDelegate,
      delegateQueue: nil
    )
    self.socketSessionDelegate = socketSessionDelegate
    self.socketSession = socketSession
    self.database = database
    // One-time migration: builds before the chunked-envelope transport set
    // this flag on "message too long" transport errors and it survives app
    // updates, silently blocking auto-reconnect forever. Current builds only
    // set it for a real user pause, so clear the stale value once.
    let pausedFlagMigrationKey = "ade.sync.autoReconnectPausedMigratedV2"
    if !UserDefaults.standard.bool(forKey: pausedFlagMigrationKey) {
      UserDefaults.standard.removeObject(forKey: autoReconnectPausedKey)
      UserDefaults.standard.set(true, forKey: pausedFlagMigrationKey)
    }
    self.autoReconnectPausedByUser = UserDefaults.standard.bool(forKey: autoReconnectPausedKey)
    if let existing = keychain.loadDeviceId() {
      deviceId = existing
    } else if let existing = UserDefaults.standard.string(forKey: legacyDeviceIdKey) {
      deviceId = existing
      keychain.saveDeviceId(existing)
    } else {
      let fresh = UUID().uuidString.lowercased()
      UserDefaults.standard.set(fresh, forKey: legacyDeviceIdKey)
      keychain.saveDeviceId(fresh)
      deviceId = fresh
    }
    activeProjectId = UserDefaults.standard.string(forKey: activeProjectIdKey)
    activeProjectRootPath = normalizedProjectRoot(UserDefaults.standard.string(forKey: activeProjectRootPathKey))
    activeProjectHostIdentity = UserDefaults.standard.string(forKey: activeProjectHostIdentityKey)
    activeHostProfile = loadProfile()
    hostName = activeHostProfile?.hostName
    database.setActiveProjectId(activeProjectId)
    hiddenProjectKeys = loadHiddenProjectKeys()
    projects = deduplicateProjectListByRoot(
      sortedProjectList(database.listMobileProjects().filter { !isProjectHidden($0) })
    )
    rosterProjects = loadCachedRoster()
    outboundLocalDbVersion = loadOutboundCursorVersionForActiveProject(defaultVersion: database.currentDbVersion())
    normalizeActiveProjectSelection(allowSingleProjectFallback: false)
    // The hub (all-projects ProjectHomeView) is the launch surface: always land
    // there, even when a project was previously active. Opening a project from
    // the hub (`selectProject`) dismisses it into that project's tabs; Back
    // returns here. `activeProjectId` stays set so the roster's live overlay and
    // on-tap chat opening have a synced project to work with.
    pendingOperationCount = loadPendingOperations().count
    resetOutboundCursorStateForActiveProject()
    latestRemoteDbVersion = activeHostProfile?.lastRemoteDbVersion ?? 0
    remoteCommandDescriptors = loadRemoteCommandDescriptors()
    refreshReducedSyncLoad()
    if let initializationError = database.initializationError {
      lastError = initializationError.localizedDescription
      connectionState = .error
    }

    discoveryBrowser.onHostsChanged = { [weak self] hosts in
      Task { @MainActor in
        self?.bonjourDiscoveredHosts = hosts
        self?.publishMergedDiscoveredHosts()
      }
    }
    discoveryBrowser.start()
    tailnetDiscovery.onHostsChanged = { [weak self] hosts in
      Task { @MainActor in
        self?.tailnetDiscoveredHosts = hosts
        self?.publishMergedDiscoveredHosts()
      }
    }
    tailnetDiscovery.start()
    pathMonitor.pathUpdateHandler = { [weak self] path in
      let snapshot = SyncNetworkPathSnapshot(
        isSatisfied: path.status == .satisfied,
        usesWiFi: path.usesInterfaceType(.wifi),
        usesCellular: path.usesInterfaceType(.cellular),
        usesWiredEthernet: path.usesInterfaceType(.wiredEthernet),
        isExpensive: path.isExpensive,
        isConstrained: path.isConstrained
      )
      Task { @MainActor in
        self?.handleNetworkPathChange(snapshot)
      }
    }
    pathMonitor.start(queue: pathMonitorQueue)

    databaseObserver = NotificationCenter.default.addObserver(
      forName: .adeDatabaseDidChange,
      object: nil,
      queue: .main
    ) { [weak self] notification in
      guard let self else { return }
      let touchedTables = Set(
        (notification.userInfo?[ADEDatabaseChangeNotification.touchedTablesUserInfoKey] as? [String] ?? [])
          .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
          .filter { !$0.isEmpty }
      )
      Task { @MainActor in
        self.scheduleProjectionRevisionBumpAfterDatabaseChange(touchedTables: touchedTables)
      }
    }
    socketSessionDelegate.service = self

    // Publish this instance as the singleton consumed by AppDelegate and the
    // attention action intent bridge. Tests that need an isolated instance may
    // overwrite it after init.
    Self.shared = self

    refreshActiveSessionsAndSnapshot()
  }

  deinit {
    databaseRevisionDebounceTask?.cancel()
    relayTask?.cancel()
    clientHeartbeatTask?.cancel()
    hydrationTask?.cancel()
    projectSelectionTask?.cancel()
    reconnectTask?.cancel()
    networkPathReconnectTask?.cancel()
    pendingOperationFlushTask?.cancel()
    outboundCursorPersistTask?.cancel()
    remoteCursorProfilePersistTask?.cancel()
    lanePresenceHeartbeatTask?.cancel()
    terminalBufferRevisionTask?.cancel()
    chatEventRevisionTask?.cancel()
    snapshotDebouncerTask?.cancel()
    activeSessionsObservationTask?.cancel()
    discoveryBrowser.stop()
    tailnetDiscovery.stop()
    pathMonitor.cancel()
    socketSession.invalidateAndCancel()
    if let databaseObserver {
      NotificationCenter.default.removeObserver(databaseObserver)
    }
  }

  private func scheduleProjectionRevisionBumpAfterDatabaseChange(touchedTables: Set<String>) {
    if touchedTables.isEmpty {
      pendingDatabaseChangeAffectsAll = true
      pendingDatabaseTouchedTables.removeAll()
    } else if !pendingDatabaseChangeAffectsAll {
      pendingDatabaseTouchedTables.formUnion(touchedTables)
    }
    databaseRevisionDebounceTask?.cancel()
    databaseRevisionDebounceTask = Task { @MainActor [weak self] in
      guard let self else { return }
      try? await Task.sleep(nanoseconds: 280_000_000)
      guard !Task.isCancelled else { return }
      let touchedTables = self.pendingDatabaseChangeAffectsAll ? Set<String>() : self.pendingDatabaseTouchedTables
      self.pendingDatabaseTouchedTables.removeAll()
      self.pendingDatabaseChangeAffectsAll = false

      let affectsAll = touchedTables.isEmpty
      let affectsProjectCatalog = affectsAll || touchedTables.contains(where: Self.tableAffectsProjectCatalog)
      let affectsAnyProjection = affectsAll
        || touchedTables.contains(where: Self.tableAffectsLanesProjection)
        || touchedTables.contains(where: Self.tableAffectsLaneDetailProjection)
        || touchedTables.contains(where: Self.tableAffectsWorkProjection)
        || touchedTables.contains(where: Self.tableAffectsFilesProjection)
        || touchedTables.contains(where: Self.tableAffectsPrsProjection)
        || touchedTables.contains(where: Self.tableAffectsProofArtifactsProjection)
      let affectsActiveSessions = affectsAll || touchedTables.contains(where: Self.tableAffectsActiveSessionsSnapshot)

      if affectsProjectCatalog {
        self.refreshProjectCatalog()
      }
      if affectsAnyProjection {
        localStateRevision += 1
        self.bumpProjectionRevisions(for: touchedTables)
      }
      if affectsActiveSessions {
        self.refreshActiveSessionsAndSnapshot()
      }
    }
  }

  private static func tableAffectsProjectCatalog(_ table: String) -> Bool {
    [
      "projects",
      "lanes",
      "lane_list_snapshots",
    ].contains(table)
  }

  private static func tableAffectsActiveSessionsSnapshot(_ table: String) -> Bool {
    [
      "terminal_sessions",
      "session_deltas",
      "checkpoints",
    ].contains(table)
  }

  private func bumpProjectionRevisions(for touchedTables: Set<String>) {
    let affectsAll = touchedTables.isEmpty
    if affectsAll || touchedTables.contains(where: Self.tableAffectsLanesProjection) {
      lanesProjectionRevision += 1
    }
    if affectsAll || touchedTables.contains(where: Self.tableAffectsLaneDetailProjection) {
      laneDetailProjectionRevision += 1
    }
    if affectsAll || touchedTables.contains(where: Self.tableAffectsWorkProjection) {
      workProjectionRevision += 1
    }
    if affectsAll || touchedTables.contains(where: Self.tableAffectsFilesProjection) {
      filesProjectionRevision += 1
    }
    if affectsAll || touchedTables.contains(where: Self.tableAffectsPrsProjection) {
      prsProjectionRevision += 1
    }
    if affectsAll || touchedTables.contains(where: Self.tableAffectsProofArtifactsProjection) {
      proofArtifactsProjectionRevision += 1
    }
  }

  private static func tableAffectsLanesProjection(_ table: String) -> Bool {
    if table == "projects" { return true }
    return [
      "lanes",
      "lane_list_snapshots",
      "lane_state_snapshots",
      "pull_requests",
      "pull_request_snapshots",
      "terminal_sessions",
      "lane_linear_issues",
      "lane_linear_issue_links",
    ].contains(table)
  }

  private static func tableAffectsLaneDetailProjection(_ table: String) -> Bool {
    if table == "projects" { return true }
    return [
      "lanes",
      "lane_detail_snapshots",
      "pull_requests",
      "pull_request_snapshots",
      "lane_linear_issues",
      "lane_linear_issue_links",
    ].contains(table)
  }

  private static func tableAffectsWorkProjection(_ table: String) -> Bool {
    if table == "projects" { return true }
    return [
      "terminal_sessions",
      "session_deltas",
      "checkpoints",
      "lanes",
      "lane_list_snapshots",
      "pull_requests",
      "pull_request_snapshots",
      "computer_use_artifacts",
      "computer_use_artifact_links",
    ].contains(table)
  }

  private static func tableAffectsFilesProjection(_ table: String) -> Bool {
    if table == "projects" { return true }
    return [
      "files_workspaces",
      "file_directory_snapshots",
      "file_content_snapshots",
      "file_diff_snapshots",
      "file_history_snapshots",
      "lanes",
    ].contains(table)
  }

  private static func tableAffectsPrsProjection(_ table: String) -> Bool {
    if table == "projects" { return true }
    return [
      "pull_requests",
      "pull_request_snapshots",
      "pr_groups",
      "pr_group_members",
      "integration_proposals",
      "queue_landing_state",
      "lanes",
      "lane_list_snapshots",
    ].contains(table)
  }

  private static func tableAffectsProofArtifactsProjection(_ table: String) -> Bool {
    if table == "projects" { return true }
    return [
      "computer_use_artifacts",
      "computer_use_artifact_links",
    ].contains(table)
  }

  func announceLaneOpen(laneId: String) {
    guard let normalizedLaneId = normalizeOpenLaneId(laneId) else { return }
    let nextCount = (openLaneReferenceCounts[normalizedLaneId] ?? 0) + 1
    openLaneReferenceCounts[normalizedLaneId] = nextCount
    scheduleLanePresenceHeartbeatIfNeeded()
    guard nextCount == 1 else { return }

    Task { @MainActor [weak self] in
      await self?.sendLanePresenceCommand(
        action: "lanes.presence.announce",
        laneId: normalizedLaneId,
        refreshSnapshots: true
      )
    }
  }

  func releaseLaneOpen(laneId: String) {
    guard let normalizedLaneId = normalizeOpenLaneId(laneId) else { return }
    let currentCount = openLaneReferenceCounts[normalizedLaneId] ?? 0
    guard currentCount > 0 else { return }
    if currentCount == 1 {
      openLaneReferenceCounts.removeValue(forKey: normalizedLaneId)
      scheduleLanePresenceHeartbeatIfNeeded()
      Task { @MainActor [weak self] in
        await self?.sendLanePresenceCommand(
          action: "lanes.presence.release",
          laneId: normalizedLaneId,
          refreshSnapshots: true
        )
      }
    } else {
      openLaneReferenceCounts[normalizedLaneId] = currentCount - 1
    }
  }

  func loadProfile() -> HostConnectionProfile? {
    if let data = UserDefaults.standard.data(forKey: profileKey),
       let profile = try? decoder.decode(HostConnectionProfile.self, from: data) {
      migrateTokenIfNeeded(for: profile)
      return profile
    }
    if let data = UserDefaults.standard.data(forKey: legacyDraftKey),
       let draft = try? decoder.decode(ConnectionDraft.self, from: data) {
      let migrated = HostConnectionProfile(legacy: draft)
      saveProfile(migrated)
      UserDefaults.standard.removeObject(forKey: legacyDraftKey)
      return migrated
    }

    if let fallback = mostRecentSavedProfileWithCredentials() {
      saveProfile(fallback)
      syncConnectLog.info("Selected most recent saved ADE machine for automatic reconnect: \(syncLogProfileSummary(fallback), privacy: .public)")
      return fallback
    }
    return nil
  }

  private func profileStorageKey(_ profile: HostConnectionProfile) -> String? {
    // Key saved machines by machine identity, not by the per-project/per-DB
    // runtime `siteId` when a stable device identity exists. For older hosts that
    // do not advertise identity yet, include route-specific data so two machines
    // with the same display name do not collapse into one token entry.
    if let identity = syncNonEmpty(profile.hostIdentity) ?? syncNonEmpty(profile.lastHostDeviceId) {
      return "machine:\(identity.lowercased())"
    }
    if let address = syncNonEmpty(profile.lastSuccessfulAddress) {
      return "machine:addr:\(address.lowercased()):\(profile.port)"
    }
    if let siteId = syncNonEmpty(profile.siteId) {
      return "machine:site:\(siteId.lowercased())"
    }
    if let hostName = syncNonEmpty(profile.hostName) {
      return "machine:name:\(hostName.lowercased()):\(profile.port)"
    }
    return nil
  }

  private func legacyProfileStorageKeys(_ profile: HostConnectionProfile) -> [String] {
    let current = profileStorageKey(profile)
    var keys: [String] = []
    func appendLegacyKey(_ value: String?) {
      guard let trimmed = syncNonEmpty(value) else { return }
      keys.append(trimmed)
      let lowered = trimmed.lowercased()
      if lowered != trimmed {
        keys.append(lowered)
      }
    }
    if let siteId = syncNonEmpty(profile.siteId) {
      keys.append("site:\(siteId.lowercased())")
      keys.append("machine:\(siteId.lowercased())")
      appendLegacyKey(siteId)
    }
    if let hostName = syncNonEmpty(profile.hostName) {
      keys.append("name:\(hostName.lowercased()):\(profile.port)")
      keys.append("machine:\(hostName.lowercased())")
      appendLegacyKey("\(hostName):\(profile.port)")
    }
    if let last = syncNonEmpty(profile.lastSuccessfulAddress) {
      keys.append("addr:\(last):\(profile.port)")
      keys.append("machine:\(last.lowercased())")
      appendLegacyKey("\(last):\(profile.port)")
    }
    appendLegacyKey(profile.hostIdentity)
    appendLegacyKey(profile.lastHostDeviceId)
    var seen = Set<String>()
    return keys.filter { key in
      key != current && seen.insert(key).inserted
    }
  }

  private func profileHasTailnetRoute(_ profile: HostConnectionProfile) -> Bool {
    if profile.tailscaleAddress != nil { return true }
    if let last = profile.lastSuccessfulAddress, syncIsTailscaleRoute(last) { return true }
    return profile.savedAddressCandidates.contains(where: syncIsTailscaleRoute)
  }

  private func shouldPreferProfile(_ candidate: HostConnectionProfile, over existing: HostConnectionProfile) -> Bool {
    if candidate.updatedAt != existing.updatedAt {
      return candidate.updatedAt > existing.updatedAt
    }
    let candidateTailnet = profileHasTailnetRoute(candidate)
    let existingTailnet = profileHasTailnetRoute(existing)
    if candidateTailnet != existingTailnet {
      return candidateTailnet
    }
    return candidate.lastSuccessfulAddress != nil && existing.lastSuccessfulAddress == nil
  }

  private func loadSavedProfilesRaw() -> [String: HostConnectionProfile] {
    guard let data = UserDefaults.standard.data(forKey: profilesKey) else {
      return [:]
    }
    if let decoded = try? decoder.decode([String: HostConnectionProfile].self, from: data) {
      return decoded
    }
    if let legacyArray = try? decoder.decode([HostConnectionProfile].self, from: data) {
      var migrated: [String: HostConnectionProfile] = [:]
      for profile in legacyArray {
        guard let key = profileStorageKey(profile) else { continue }
        if let existing = migrated[key], !shouldPreferProfile(profile, over: existing) {
          continue
        }
        migrated[key] = profile
      }
      syncConnectLog.warning("Migrated \(legacyArray.count, privacy: .public) legacy array-format host profiles to dict format (\(migrated.count, privacy: .public) keyed)")
      saveSavedProfiles(migrated)
      return migrated
    }
    return [:]
  }

  private func loadSavedProfiles() -> [String: HostConnectionProfile] {
    var profiles = loadSavedProfilesRaw()
    if let active = loadProfile(), let key = profileStorageKey(active), profiles[key] == nil {
      profiles[key] = active
      saveSavedProfiles(profiles)
    }
    return profiles
  }

  private func saveSavedProfiles(_ profiles: [String: HostConnectionProfile]) {
    let normalized = deduplicatedProfiles(profiles)
    if normalized.isEmpty {
      UserDefaults.standard.removeObject(forKey: profilesKey)
      return
    }
    if let data = try? encoder.encode(normalized) {
      UserDefaults.standard.set(data, forKey: profilesKey)
    }
  }

  private func profileIdentityKeys(_ profile: HostConnectionProfile) -> [String] {
    var keys: [String] = []
    if let id = profile.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines), !id.isEmpty {
      keys.append("identity:\(id)")
    }
    if let device = profile.lastHostDeviceId?.trimmingCharacters(in: .whitespacesAndNewlines), !device.isEmpty {
      keys.append("device:\(device)")
    }
    if let name = profile.hostName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty {
      keys.append("name:\(name.lowercased()):\(profile.port)")
    }
    if let last = profile.lastSuccessfulAddress?.trimmingCharacters(in: .whitespacesAndNewlines), !last.isEmpty {
      keys.append("addr:\(last):\(profile.port)")
    }
    return keys
  }

  private func deduplicatedProfiles(_ profiles: [String: HostConnectionProfile]) -> [String: HostConnectionProfile] {
    var canonicalProfiles: [HostConnectionProfile] = []
    var keyToIndex: [String: Int] = [:]
    for profile in profiles.values {
      let identityKeys = profileIdentityKeys(profile)
      let matchedIndex = identityKeys.lazy.compactMap { keyToIndex[$0] }.first
      if let index = matchedIndex {
        if shouldPreferProfile(profile, over: canonicalProfiles[index]) {
          canonicalProfiles[index] = profile
        }
        for key in identityKeys { keyToIndex[key] = index }
      } else {
        let index = canonicalProfiles.count
        canonicalProfiles.append(profile)
        for key in identityKeys { keyToIndex[key] = index }
      }
    }
    var byKey: [String: HostConnectionProfile] = [:]
    byKey.reserveCapacity(canonicalProfiles.count)
    for profile in canonicalProfiles {
      guard let key = profileStorageKey(profile) else { continue }
      byKey[key] = profile
    }
    return byKey
  }

  private func migrateTokenIfNeeded(for profile: HostConnectionProfile) {
    guard let key = profileStorageKey(profile),
          keychain.loadToken(hostKey: key) == nil else {
      return
    }
    for legacyKey in legacyProfileStorageKeys(profile) {
      if let legacyToken = keychain.loadToken(hostKey: legacyKey) {
        keychain.saveToken(legacyToken, hostKey: key)
        keychain.clearToken(hostKey: legacyKey)
        return
      }
    }
    if let legacyToken = keychain.loadToken() {
      keychain.saveToken(legacyToken, hostKey: key)
    }
  }

  private func storedTokenForSavedProfile(_ profile: HostConnectionProfile) -> String? {
    if let key = profileStorageKey(profile), let token = keychain.loadToken(hostKey: key) {
      return token
    }
    for legacyKey in legacyProfileStorageKeys(profile) {
      if let token = keychain.loadToken(hostKey: legacyKey) {
        return token
      }
    }
    return nil
  }

  private func mostRecentSavedProfileWithCredentials() -> HostConnectionProfile? {
    loadSavedProfilesRaw().values
      .filter { storedTokenForSavedProfile($0) != nil }
      .sorted { shouldPreferProfile($0, over: $1) }
      .first
  }

  private func tokenForProfile(_ profile: HostConnectionProfile?) -> String? {
    guard let profile else { return nil }
    if let key = profileStorageKey(profile), let token = keychain.loadToken(hostKey: key) {
      return token
    }
    for legacyKey in legacyProfileStorageKeys(profile) {
      if let token = keychain.loadToken(hostKey: legacyKey) {
        if let key = profileStorageKey(profile) {
          keychain.saveToken(token, hostKey: key)
          keychain.clearToken(hostKey: legacyKey)
        }
        return token
      }
    }
    if activeHostProfile == profile {
      return keychain.loadToken()
    }
    return nil
  }

  private func publishMergedDiscoveredHosts() {
    applyDiscoveredHosts(bonjourDiscoveredHosts + tailnetDiscoveredHosts)
  }

  var canReconnectToSavedHost: Bool {
    tokenForProfile(activeHostProfile) != nil
  }

  var savedReconnectHost: DiscoveredSyncHost? {
    guard let profile = activeHostProfile ?? loadProfile(),
          tokenForProfile(profile) != nil else {
      return nil
    }
    return discoveredHost(fromSavedProfile: profile)
  }

  var savedReconnectHosts: [DiscoveredSyncHost] {
    let profiles = loadSavedProfiles().values
      .filter { tokenForProfile($0) != nil }
      .sorted { lhs, rhs in lhs.updatedAt > rhs.updatedAt }
    return profiles.compactMap(discoveredHost(fromSavedProfile:))
  }

  private func discoveredHost(fromSavedProfile profile: HostConnectionProfile) -> DiscoveredSyncHost? {
    let tailscaleAddress =
      profile.tailscaleAddress
      ?? profile.savedAddressCandidates.first(where: syncIsTailscaleRoute)
      ?? profile.lastSuccessfulAddress.flatMap { syncIsTailscaleRoute($0) ? $0 : nil }
    let lanAddresses = profile.discoveredLanAddresses.filter { !syncIsTailscaleRoute($0) }
    let savedLanAddresses = profile.savedAddressCandidates.filter { !syncIsTailscaleRoute($0) }
    let addresses = deduplicatedAddresses(
      lanAddresses
      + savedLanAddresses
      + (profile.lastSuccessfulAddress.flatMap { syncIsTailscaleRoute($0) ? nil : $0 }.map { [$0] } ?? [])
    )
    guard tailscaleAddress != nil || !addresses.isEmpty else { return nil }
    let identity = profile.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines)
    let displayName = profile.hostName?.trimmingCharacters(in: .whitespacesAndNewlines)
    let routeId = tailscaleAddress ?? addresses.first ?? "saved"
    // ONE machine = ONE saved row. The id keys off `profileStorageKey`, which
    // prefers the machine identity/device name and retains older site/route
    // keys only as migration aliases. A machine reachable over LAN and
    // Tailscale still collapses to one row; `reconnect(toSavedHost:)` resolves
    // the profile back by matching `"saved-\(key)"`.
    let stableKey = profileStorageKey(profile) ?? (identity?.isEmpty == false ? identity! : routeId)
    return DiscoveredSyncHost(
      id: "saved-\(stableKey)",
      serviceName: "Saved ADE machine",
      hostName: displayName?.isEmpty == false ? displayName! : routeId,
      hostIdentity: identity?.isEmpty == false ? identity : nil,
      siteId: syncNonEmpty(profile.siteId),
      port: profile.port,
      addresses: addresses,
      tailscaleAddress: tailscaleAddress,
      runtimeKind: nil,
      runtimeVersion: nil,
      projectIds: [],
      projectNames: [],
      projectCount: nil,
      lastResolvedAt: profile.updatedAt
    )
  }

  func reconnect(toSavedHost host: DiscoveredSyncHost, preferTailnet: Bool = false) async {
    let profiles = loadSavedProfiles()
    let candidates = profiles.values.filter { profile in
      if let identity = host.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines), !identity.isEmpty {
        return profile.hostIdentity == identity || profile.lastHostDeviceId == identity
      }
      if host.id.hasPrefix("saved-"), let key = profileStorageKey(profile) {
        return host.id == "saved-\(key)"
      }
      return matchesDiscoveredHost(host, profile: profile)
    }
    guard let profile = candidates.sorted(by: { $0.updatedAt > $1.updatedAt }).first,
          tokenForProfile(profile) != nil else {
      lastError = "This saved machine no longer has pairing credentials. Pair again from Settings."
      connectionState = .error
      return
    }
    saveProfile(profile)
    await reconnectIfPossible(userInitiated: true, preferTailnet: preferTailnet)
  }

  func reconnectIfPossible(userInitiated: Bool = false, preferTailnet: Bool = false) async {
    do {
      try ensureDatabaseReady()
    } catch {
      lastError = SyncUserFacingError.message(for: error)
      connectionState = .error
      return
    }
    if userInitiated {
      setAutoReconnectPausedByUser(false)
      autoReconnectAwaitingLiveDiscovery = false
      reconnectTask?.cancel()
      networkPathReconnectTask?.cancel()
      reconnectState.reset()
      if reconnectConnectInFlight {
        syncConnectLog.info("ADE_SYNC_TRACE reconnect user override cancels in-flight attempt")
        beginConnectAttempt()
        teardownSocket(reason: "Reconnect restarted.")
        reconnectConnectInFlight = false
      }
    }
    // Background retries (slow heartbeat, network-path task, discovery
    // callbacks) must never reach openSocket while a healthy connection is
    // up — openSocket starts with teardownSocket, so a stray retry would
    // kill a live session. Only an explicit user reconnect may rebuild one.
    guard userInitiated || !canSendLiveRequests() else {
      syncConnectLog.info("reconnect skipped: already connected")
      return
    }
    guard userInitiated || allowAutoReconnect else {
      syncConnectLog.info("reconnect skipped: automatic reconnect disabled")
      return
    }
    guard userInitiated || !autoReconnectPausedByUser else {
      syncConnectLog.info("reconnect skipped: paused by user")
      return
    }
    allowAutoReconnect = true
    guard let profile = loadProfile(), let token = tokenForProfile(profile) else { return }
    if preferTailnet || (userInitiated && shouldPreferTailnetForUserReconnect(profile)) {
      preferTailnetForUpcomingReconnect()
    }
    let automaticAddresses = automaticReconnectAddresses(for: profile)
    syncConnectLog.info(
      "ADE_SYNC_TRACE reconnect start userInitiated=\(userInitiated) state=\(self.connectionState.rawValue, privacy: .public) path=\(syncLogPathSummary(self.lastNetworkPathSnapshot), privacy: .public) profile=\(syncLogProfileSummary(profile), privacy: .public) automatic=[\(syncLogAddressList(automaticAddresses), privacy: .public)]"
    )
    if !userInitiated && automaticAddresses.isEmpty {
      if !autoReconnectAwaitingLiveDiscovery {
        syncConnectLog.info("reconnect skipped: waiting for a saved or live route")
      }
      autoReconnectAwaitingLiveDiscovery = true
      return
    }
    autoReconnectAwaitingLiveDiscovery = false
    guard !reconnectConnectInFlight else {
      syncConnectLog.info("reconnect skipped: connect already in flight")
      return
    }
    reconnectConnectInFlight = true
    let connectAttemptGeneration = beginConnectAttempt()
    defer {
      if self.connectAttemptGeneration == connectAttemptGeneration {
        reconnectConnectInFlight = false
      }
    }
    publishReconnectStarted(profile: profile)
    do {
      let connectedEndpoint = try await connectUsingProfile(
        profile,
        token: token,
        connectAttemptGeneration: connectAttemptGeneration,
        preferLiveCandidatesOnly: !userInitiated,
        publishConnecting: true
      )
      guard isCurrentConnectAttempt(connectAttemptGeneration) else { return }
      currentAddress = connectedEndpoint.host
    } catch {
      guard isCurrentConnectAttempt(connectAttemptGeneration) else { return }
      handleReconnectFailure(
        error,
        shouldScheduleRetry: !userInitiated,
        phase: userInitiated ? .failed : .disconnected,
        connectionState: userInitiated ? .error : .disconnected
      )
    }
  }

  private func publishReconnectStarted(profile: HostConnectionProfile) {
    connectionState = .connecting
    hostName = profile.hostName
    lastError = nil
  }

  private func shouldPreferTailnetForUserReconnect(_ profile: HostConnectionProfile) -> Bool {
    guard let snapshot = lastNetworkPathSnapshot else { return false }
    return syncShouldRoamToTailnet(
      currentAddress: currentAddress,
      hasTailnetRoute: profileHasTailnetRoute(profile),
      usesWiFi: snapshot.usesWiFi,
      usesCellular: snapshot.usesCellular,
      usesWiredEthernet: snapshot.usesWiredEthernet
    )
  }

  private func refreshReducedSyncLoad() {
    let route = currentAddress
      ?? activeHostProfile?.lastSuccessfulAddress
      ?? activeHostProfile?.tailscaleAddress
    let nowMonotonic = ProcessInfo.processInfo.systemUptime
    let forcedReduced = forceReducedSyncLoadUntil.map { $0 > nowMonotonic } ?? false
    if forceReducedSyncLoadUntil != nil && !forcedReduced {
      forceReducedSyncLoadUntil = nil
      poorConnectionSampleCount = 0
    }
    let next: Bool
    if let snapshot = lastNetworkPathSnapshot {
      let initialPreference = syncPrefersReducedNetworkLoad(
        currentAddress: route,
        usesWiFi: snapshot.usesWiFi,
        usesCellular: snapshot.usesCellular,
        usesWiredEthernet: snapshot.usesWiredEthernet,
        isExpensive: snapshot.isExpensive,
        isConstrained: snapshot.isConstrained
      )
      next = syncShouldUseReducedNetworkLoad(
        initialPreference: initialPreference,
        isConstrained: snapshot.isConstrained,
        forcedReduced: forcedReduced,
        healthySampleCount: healthyConnectionSampleCount,
        poorSampleCount: poorConnectionSampleCount
      )
    } else {
      next = syncShouldUseReducedNetworkLoad(
        initialPreference: route.map(syncIsTailscaleRoute) ?? false,
        isConstrained: false,
        forcedReduced: forcedReduced,
        healthySampleCount: healthyConnectionSampleCount,
        poorSampleCount: poorConnectionSampleCount
      )
    }
    if prefersReducedSyncLoad != next {
      prefersReducedSyncLoad = next
      syncChatLog.notice(
        "reduced_load_changed enabled=\(next, privacy: .public) route=\(route ?? "none", privacy: .public) poorSamples=\(self.poorConnectionSampleCount, privacy: .public) healthySamples=\(self.healthyConnectionSampleCount, privacy: .public) forced=\(forcedReduced, privacy: .public) path=\(syncLogPathSummary(self.lastNetworkPathSnapshot), privacy: .public)"
      )
      restoreChatEventSubscriptions()
    }
  }

  private func recordConnectionLoadSample(latencyMs: Int? = nil, syncLag: Int? = nil, roundTripSeconds: TimeInterval? = nil) {
    let sample = syncConnectionLoadSample(latencyMs: latencyMs, syncLag: syncLag, roundTripSeconds: roundTripSeconds)

    if sample.isPoor {
      poorConnectionSampleCount = min(poorConnectionSampleCount + 1, 3)
      healthyConnectionSampleCount = 0
      refreshReducedSyncLoad()
      return
    }

    if sample.isHealthy {
      healthyConnectionSampleCount = min(healthyConnectionSampleCount + 1, 5)
      if healthyConnectionSampleCount >= 2 {
        poorConnectionSampleCount = 0
      }
      refreshReducedSyncLoad()
    }
  }

  private func markConnectionLoadStrained(duration: TimeInterval = 60) {
    forceReducedSyncLoadUntil = ProcessInfo.processInfo.systemUptime + duration
    poorConnectionSampleCount = max(poorConnectionSampleCount, 1)
    healthyConnectionSampleCount = 0
    syncChatLog.notice(
      "connection_load_strained duration=\(duration, privacy: .public) state=\(self.connectionState.rawValue, privacy: .public) generation=\(self.connectionGeneration, privacy: .public) lastInbound=\(self.lastInboundMessageAt ?? -1, privacy: .public)"
    )
    refreshReducedSyncLoad()
  }

  private func handleNetworkPathChange(_ snapshot: SyncNetworkPathSnapshot) {
    let previous = lastNetworkPathSnapshot
    lastNetworkPathSnapshot = snapshot
    refreshReducedSyncLoad()
    guard previous != nil else { return }
    guard canReconnectToSavedHost,
          allowAutoReconnect,
          !autoReconnectPausedByUser,
          let profile = activeHostProfile ?? loadProfile() else {
      return
    }

    let connectedOverTailnet = currentAddress.map(syncIsTailscaleRoute) ?? false
    let hasTailnetRoute = profileHasTailnetRoute(profile)
    let shouldRoamToTailnet = syncShouldRoamToTailnet(
      currentAddress: currentAddress,
      hasTailnetRoute: hasTailnetRoute,
      usesWiFi: snapshot.usesWiFi,
      usesCellular: snapshot.usesCellular,
      usesWiredEthernet: snapshot.usesWiredEthernet
    )

    syncConnectLog.info(
      "ADE_SYNC_TRACE path changed path=\(syncLogPathSummary(snapshot), privacy: .public) connectedOverTailnet=\(connectedOverTailnet) hasTailnet=\(hasTailnetRoute) shouldRoamToTailnet=\(shouldRoamToTailnet) current=\(self.currentAddress ?? "none", privacy: .public)"
    )
    syncChatLog.notice(
      "path_changed state=\(self.connectionState.rawValue, privacy: .public) path=\(syncLogPathSummary(snapshot), privacy: .public) current=\(self.currentAddress ?? "none", privacy: .public) roamToTailnet=\(shouldRoamToTailnet, privacy: .public) liveRequests=\(self.canSendLiveRequests(), privacy: .public)"
    )

    if shouldRoamToTailnet {
      preferTailnetForUpcomingReconnect()
      scheduleNetworkPathReconnect(
        forceSocketReset: true,
        delayNanoseconds: snapshot.isSatisfied ? 250_000_000 : 750_000_000
      )
      return
    }

    guard snapshot.isSatisfied else { return }

    if !canSendLiveRequests() {
      scheduleNetworkPathReconnect(forceSocketReset: false)
    }
  }

  private func scheduleNetworkPathReconnect(
    forceSocketReset: Bool,
    delayNanoseconds: UInt64 = 250_000_000
  ) {
    syncChatLog.notice(
      "network_path_reconnect_scheduled forceReset=\(forceSocketReset, privacy: .public) delayNs=\(delayNanoseconds, privacy: .public) state=\(self.connectionState.rawValue, privacy: .public) generation=\(self.connectionGeneration, privacy: .public) current=\(self.currentAddress ?? "none", privacy: .public)"
    )
    networkPathReconnectTask?.cancel()
    networkPathReconnectTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: delayNanoseconds)
      guard let self, !Task.isCancelled else { return }
      if forceSocketReset {
        syncChatLog.notice(
          "network_path_reconnect_forcing_reset state=\(self.connectionState.rawValue, privacy: .public) generation=\(self.connectionGeneration, privacy: .public) current=\(self.currentAddress ?? "none", privacy: .public)"
        )
        self.teardownSocket(reason: "Network route changed.")
      }
      await self.reconnectIfPossible()
    }
  }

  func handleForegroundTransition() async {
    guard !reconnectConnectInFlight else { return }
    if canSendLiveRequests() {
      lastError = nil
      await restoreTrackedOpenLanesAfterReconnect()
      restoreChatEventSubscriptions()
      await refreshRemoteProjectCatalog()
      try? await refreshLaneSnapshots()
      try? await refreshWorkSessions()
      try? await refreshPullRequestSnapshots()
      flushPendingOperationsAndScheduleRetry()
      return
    }

    if let profile = loadProfile() {
      let shouldPublishReconnectStart = syncShouldPublishForegroundReconnectStarted(
        allowAutoReconnect: allowAutoReconnect,
        autoReconnectPausedByUser: autoReconnectPausedByUser,
        hasToken: tokenForProfile(profile) != nil,
        connectionState: connectionState,
        automaticAddresses: automaticReconnectAddresses(for: profile)
      )
      if shouldPublishReconnectStart {
        publishReconnectStarted(profile: profile)
      }
    }
    await reconnectIfPossible()
  }

  func pairAndConnect(
    host: String,
    port: Int,
    code: String,
    hostIdentity: String? = nil,
    hostName: String? = nil,
    siteId: String? = nil,
    candidateAddresses: [String] = [],
    tailscaleAddress: String? = nil
  ) async {
    do {
      try ensureDatabaseReady()
    } catch {
      lastError = SyncUserFacingError.message(for: error)
      connectionState = .error
      return
    }
    lastPairingErrorCode = nil
    let connectAttemptGeneration: UInt64
    do {
      cancelReconnectLoop()
      allowAutoReconnect = false
      setAutoReconnectPausedByUser(false)
      disconnect(clearCredentials: false, suspendAutoReconnect: false)
      connectAttemptGeneration = beginConnectAttempt()
      resetChatEventState(clearHistory: true)
      let endpoint = syncParseRouteEndpoint(host)
      let requestedRoute = endpoint?.scheme == "wss"
        ? host.trimmingCharacters(in: .whitespacesAndNewlines)
        : nil
      let requestedHost = requestedRoute ?? endpoint?.host ?? host.trimmingCharacters(in: .whitespacesAndNewlines)
      let requestedPort = endpoint?.port ?? port
      let normalizedCandidateAddresses = candidateAddresses.compactMap { syncEndpointHost($0) }
      let normalizedTailscaleAddress = tailscaleAddress.flatMap(syncEndpointHost)
      let matchingDiscovery = discoveredHosts.filter { discovered in
        if let hostIdentity, !hostIdentity.isEmpty {
          return discovered.hostIdentity == hostIdentity
        }
        if let hostName, !hostName.isEmpty {
          return discovered.hostName.localizedCaseInsensitiveCompare(hostName) == .orderedSame
            || discovered.serviceName.localizedCaseInsensitiveCompare(hostName) == .orderedSame
        }
        return false
      }
      let discoveryAddresses = matchingDiscovery.flatMap(\.addresses)
      let discoveryTailscaleAddresses = matchingDiscovery.compactMap(\.tailscaleAddress)
      let explicitTailscaleAddresses = normalizedTailscaleAddress.map { [$0] } ?? []
      let lastSuccessfulAddress = preferredPairedAddress(
        host: requestedHost,
        hostIdentity: hostIdentity,
        hostName: hostName,
        candidateAddresses: discoveryAddresses
          + discoveryTailscaleAddresses
          + [requestedHost]
          + explicitTailscaleAddresses
          + normalizedCandidateAddresses
      )
      let addressCandidates = connectableAddresses(from: deduplicatedAddresses(
        lastSuccessfulAddress +
        [requestedHost] +
        discoveryAddresses +
        discoveryTailscaleAddresses +
        explicitTailscaleAddresses +
        normalizedCandidateAddresses
      ))
      let portCandidates = syncConnectPortCandidates(primaryPort: requestedPort, addresses: addressCandidates)
      syncConnectLog.info(
        "ADE_SYNC_TRACE pair candidates host=\(requestedHost, privacy: .public) ports=[\(portCandidates.map(String.init).joined(separator: ","), privacy: .public)] discoveryLan=[\(syncLogAddressList(discoveryAddresses), privacy: .public)] discoveryTailnet=[\(syncLogAddressList(discoveryTailscaleAddresses), privacy: .public)] explicitTailnet=[\(syncLogAddressList(explicitTailscaleAddresses), privacy: .public)] provided=[\(syncLogAddressList(normalizedCandidateAddresses), privacy: .public)] connectable=[\(syncLogAddressList(addressCandidates), privacy: .public)]"
      )
      // If we have multiple candidates (e.g. discovered LAN + loopback + tailscale),
      // walk them in order and only fail if every one fails to open a socket.
      // A single-address manual entry retains short-circuit behavior since the
      // loop will still surface that sole failure.
      var openedAddress: String?
      var openedPort: Int?
      var lastOpenError: Error?
      guard !addressCandidates.isEmpty else {
        throw noConnectableAddressError()
      }
      for attempt in syncConnectionEndpointAttempts(addresses: addressCandidates, ports: portCandidates) {
        guard isCurrentConnectAttempt(connectAttemptGeneration) else {
          throw CancellationError()
        }
        let kind = addressCandidateKind(attempt.address, profile: nil, explicitTailscaleAddress: normalizedTailscaleAddress)
        syncConnectLog.info("ADE_SYNC_TRACE pair attempt host=\(attempt.address, privacy: .public) port=\(attempt.port) kind=\(kind, privacy: .public)")
        do {
          try await openSocket(
            host: attempt.address,
            port: attempt.port,
            connectAttemptGeneration: connectAttemptGeneration
          )
          syncConnectLog.info("ADE_SYNC_TRACE pair success host=\(attempt.address, privacy: .public) port=\(attempt.port)")
          openedAddress = attempt.address
          openedPort = attempt.port
          break
        } catch {
          syncConnectLog.info("ADE_SYNC_TRACE pair failure host=\(attempt.address, privacy: .public) port=\(attempt.port) error=\(syncLogErrorSummary(error), privacy: .public)")
          lastOpenError = error
          teardownSocket()
          continue
        }
      }
      guard let preferredAddress = openedAddress, let preferredPort = openedPort else {
        throw lastOpenError ?? NSError(domain: "ADE", code: 19, userInfo: [NSLocalizedDescriptionKey: "Unable to reach the machine. Check LAN, Tailscale, or VPN, then try again."])
      }
      let requestId = makeRequestId()
      let raw = try await awaitResponse(requestId: requestId) {
        self.sendEnvelope(type: "pairing_request", requestId: requestId, payload: [
          "code": code.trimmingCharacters(in: .whitespacesAndNewlines).uppercased(),
          "peer": self.currentPeerMetadata(),
        ])
      }
      guard isCurrentConnectAttempt(connectAttemptGeneration) else {
        throw CancellationError()
      }
      guard let payload = raw as? [String: Any], (payload["ok"] as? Bool) == true else {
        let failure = friendlyPairingFailure(raw)
        var userInfo: [String: Any] = [NSLocalizedDescriptionKey: failure.message]
        // Preserve the host's error CODE (e.g. `pin_not_set`, `invalid_pin`)
        // on the NSError — mirroring how `hello_error` carries `ADEErrorCode`
        // — so the PIN sheet can branch on the code (route to the "Set a PIN"
        // screen) rather than parsing a localized red string.
        if let code = failure.code {
          userInfo["ADEErrorCode"] = code
        }
        throw NSError(domain: "ADE", code: 2, userInfo: userInfo)
      }
      guard let secret = payload["secret"] as? String else {
        throw NSError(domain: "ADE", code: 3, userInfo: [NSLocalizedDescriptionKey: "Pairing secret missing from response."])
      }
      let pairedDeviceId = payload["deviceId"] as? String ?? deviceId
      let profile = HostConnectionProfile(
        hostIdentity: hostIdentity,
        hostName: hostName,
        siteId: syncNonEmpty(siteId),
        port: preferredPort,
        authKind: "paired",
        pairedDeviceId: pairedDeviceId,
        lastRemoteDbVersion: 0,
        lastHostDeviceId: nil,
        lastSuccessfulAddress: preferredAddress,
        savedAddressCandidates: addressCandidates,
        discoveredLanAddresses: addressCandidates.filter { host in
          guard !host.contains(":") else { return false }
          if host == "127.0.0.1" { return false }
          return !syncIsTailscaleRoute(host)
        },
        tailscaleAddress: normalizedTailscaleAddress ?? addressCandidates.first(where: syncIsTailscaleRoute)
      )
      currentAddress = preferredAddress
      try await hello(
        host: preferredAddress,
        port: preferredPort,
        token: secret,
        authKind: "paired",
        pairedDeviceId: pairedDeviceId,
        expectedHostIdentity: hostIdentity,
        connectAttemptGeneration: connectAttemptGeneration
      )
      keychain.saveToken(secret)
      keychain.saveToken(secret, hostKey: profileStorageKey(activeHostProfile ?? profile))
    } catch {
      guard isCurrentConnectAttempt(connectAttemptGeneration) else { return }
      let friendlyMessage = SyncUserFacingError.message(for: error)
      cancelReconnectLoop()
      allowAutoReconnect = false
      setAutoReconnectPausedByUser(true)
      teardownSocket(reason: friendlyMessage)
      lastError = friendlyMessage
      lastPairingErrorCode = (error as NSError).userInfo["ADEErrorCode"] as? String
      connectionState = .error
      setDomainStatus(SyncDomain.allCases, phase: .failed, error: friendlyMessage)
    }
  }

  /// Stable host pairing error code surfaced when a machine has no PIN set yet.
  /// The PIN sheet branches on this (via `ADEErrorCode`) to route the user to the
  /// friendly "Set a PIN" screen instead of showing a dead-end red string.
  static let pairingPinNotSetCode = "pin_not_set"

  private func friendlyPairingFailure(_ raw: Any) -> (message: String, code: String?) {
    let error = (raw as? [String: Any])?["error"] as? [String: Any]
    let code = error?["code"] as? String
    let message = error?["message"] as? String

    switch code {
    case "invalid_pin":
      return ("Incorrect PIN.", code)
    case "pin_not_set":
      return ("No PIN set on that machine yet.", code)
    default:
      return (message ?? "Pairing failed.", code)
    }
  }

  func disconnect(clearCredentials: Bool = false, suspendAutoReconnect: Bool = true) {
    beginConnectAttempt()
    autoReconnectAwaitingLiveDiscovery = false
    if suspendAutoReconnect {
      setAutoReconnectPausedByUser(true)
    }
    allowAutoReconnect = false
    reconnectConnectInFlight = false
    cancelReconnectLoop()
    teardownSocket(closeCode: .normalClosure)
    connectionState = .disconnected
    hostName = activeHostProfile?.hostName
    latestRemoteDbVersion = 0
    resetOutboundCursorStateForActiveProject()
    setDomainStatus(SyncDomain.allCases, phase: .disconnected)
    if clearCredentials {
      let profileToClear = activeHostProfile ?? loadProfile()
      if let key = profileToClear.flatMap({ profileStorageKey($0) }) {
        keychain.clearToken(hostKey: key)
        if let profileToClear {
          for legacyKey in legacyProfileStorageKeys(profileToClear) {
            keychain.clearToken(hostKey: legacyKey)
          }
        }
        var profiles = loadSavedProfilesRaw()
        profiles.removeValue(forKey: key)
        saveSavedProfiles(profiles)
      }
      keychain.clearToken()
      saveProfile(nil)
      saveRemoteCommandDescriptors([])
      resetChatEventState(clearHistory: true)
      resetTerminalSubscriptionState(clearHistory: false)
      activeHostProfile = nil
      hostName = nil
    }
    failPendingRequests(with: NSError(domain: "ADE", code: 21, userInfo: [NSLocalizedDescriptionKey: "Connection closed."]))
  }

  func forgetHost() {
    disconnect(clearCredentials: true)
    remoteProjectCatalog = []
    refreshProjectCatalog()
    lastError = nil
    setDomainStatus(SyncDomain.allCases, phase: .disconnected)
    settingsPresented = true
  }

  /// Remove a saved machine from the recents list: drop its keyed profile from
  /// the saved-profiles store and clear its keychain pairing token. Mirrors the
  /// `clearCredentials` branch of `disconnect`, but for an arbitrary saved row
  /// rather than the active connection. If the removed row IS the active /
  /// last-used profile, this also tears down the live connection and clears the
  /// active pairing so the header drops to "no paired machine".
  func removeSavedHost(_ host: DiscoveredSyncHost) {
    let profiles = loadSavedProfilesRaw()
    let matchedKey = profiles.first { _, profile in
      savedProfileMatchesDiscoveredHost(host, profile: profile)
    }?.key
    guard let key = matchedKey else { return }

    let removedWasActive: Bool = {
      guard let activeKey = (activeHostProfile ?? loadProfile()).flatMap({ profileStorageKey($0) }) else {
        return false
      }
      return activeKey == key
    }()

    if removedWasActive {
      // Tear down the live socket and clear the active pairing before pruning the
      // store entry so we don't leave a dangling active profile pointing at a
      // removed machine.
      disconnect(clearCredentials: true)
      remoteProjectCatalog = []
      refreshProjectCatalog()
      lastError = nil
      setDomainStatus(SyncDomain.allCases, phase: .disconnected)
    }

    keychain.clearToken(hostKey: key)
    if let removedProfile = profiles[key] {
      for legacyKey in legacyProfileStorageKeys(removedProfile) {
        keychain.clearToken(hostKey: legacyKey)
      }
    }
    var remaining = loadSavedProfilesRaw()
    remaining.removeValue(forKey: key)
    saveSavedProfiles(remaining)
    objectWillChange.send()
  }

  /// Match a saved `HostConnectionProfile` to a `DiscoveredSyncHost` row using the
  /// same precedence the reconnect path uses: device identity first, then the
  /// `"saved-<storageKey>"` row id, then address / name overlap.
  private func savedProfileMatchesDiscoveredHost(
    _ host: DiscoveredSyncHost,
    profile: HostConnectionProfile
  ) -> Bool {
    if let identity = host.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines), !identity.isEmpty {
      return profile.hostIdentity == identity || profile.lastHostDeviceId == identity
    }
    if host.id.hasPrefix("saved-"), let key = profileStorageKey(profile) {
      return host.id == "saved-\(key)"
    }
    return matchesDiscoveredHost(host, profile: profile)
  }

  func refreshLaneSnapshots(includeStatus: Bool = true, includeDecorations: Bool = true) async throws {
    setDomainStatus([.lanes, .files], phase: .hydrating)
    do {
      let raw = try await sendCommand(action: "lanes.refreshSnapshots", args: [
        "includeArchived": true,
        "includeStatus": includeStatus,
        "includeConflictStatus": includeDecorations,
        "includeRebaseSuggestions": includeDecorations,
        "includeAutoRebaseStatus": includeDecorations,
      ])
      let payload = try decodeHydrationPayload(raw, as: LaneRefreshPayload.self, domainLabel: "lane", decoder: decoder)
      let lanes = includeStatus
        ? payload.lanes
        : lanesPreservingStatus(payload.lanes)
      let decoratedSnapshots = includeDecorations
        ? payload.snapshots
        : laneSnapshotsPreservingDecorations(payload.snapshots)
      let snapshots = includeStatus
        ? decoratedSnapshots
        : laneSnapshotsPreservingStatus(decoratedSnapshots)
      try database.replaceLaneSnapshots(lanes, snapshots: snapshots)
      setDomainStatus([.lanes, .files], phase: .ready)
    } catch {
      let friendlyMessage = SyncUserFacingError.message(for: error)
      if connectionState == .disconnected || connectionState == .error {
        setDomainStatus([.lanes, .files], phase: .disconnected)
      } else {
        setDomainStatus([.lanes, .files], phase: .failed, error: friendlyMessage)
      }
      throw error
    }
  }

  private func lanesPreservingStatus(_ lanes: [LaneSummary]) -> [LaneSummary] {
    let existingByLaneId = Dictionary(
      uniqueKeysWithValues: database.fetchLanes(includeArchived: true)
        .map { ($0.id, $0) }
    )
    return lanes.map { lane in
      guard let existing = existingByLaneId[lane.id] else { return lane }
      var merged = lane
      merged.status = existing.status
      merged.parentStatus = existing.parentStatus
      return merged
    }
  }

  private func laneSnapshotsPreservingStatus(_ snapshots: [LaneListSnapshot]?) -> [LaneListSnapshot]? {
    guard let snapshots else { return nil }
    let existingByLaneId = Dictionary(
      uniqueKeysWithValues: database.fetchLanes(includeArchived: true)
        .map { ($0.id, $0) }
    )
    return snapshots.map { snapshot in
      guard let existing = existingByLaneId[snapshot.lane.id] else { return snapshot }
      var merged = snapshot
      merged.lane.status = existing.status
      merged.lane.parentStatus = existing.parentStatus
      return merged
    }
  }

  private func laneSnapshotsPreservingDecorations(_ snapshots: [LaneListSnapshot]?) -> [LaneListSnapshot]? {
    guard let snapshots else { return nil }
    let existingByLaneId = Dictionary(
      uniqueKeysWithValues: database.fetchLaneListSnapshots(includeArchived: true)
        .map { ($0.lane.id, $0) }
    )
    return snapshots.map { snapshot in
      guard let existing = existingByLaneId[snapshot.lane.id] else { return snapshot }
      var merged = snapshot
      merged.rebaseSuggestion = existing.rebaseSuggestion
      merged.autoRebaseStatus = existing.autoRebaseStatus
      merged.conflictStatus = existing.conflictStatus
      return merged
    }
  }

  func refreshWorkSessions() async throws {
    setDomainStatus([.work], phase: .hydrating)
    do {
      let raw = try await sendCommand(action: "work.listSessions", args: ["limit": 200])
      let sessions = try decodeHydrationPayload(raw, as: [TerminalSessionSummary].self, domainLabel: "work session", decoder: decoder)
      try database.replaceTerminalSessions(sessions)
      setDomainStatus([.work], phase: .ready)
    } catch {
      let friendlyMessage = SyncUserFacingError.message(for: error)
      if connectionState == .disconnected || connectionState == .error {
        setDomainStatus([.work], phase: .disconnected)
      } else {
        setDomainStatus([.work], phase: .failed, error: friendlyMessage)
      }
      throw error
    }
  }

  func fetchCtoRoster() async throws -> CtoRoster {
    try await sendDecodableCommand(action: "cto.getRoster", as: CtoRoster.self)
  }

  func ensureCtoSession() async throws -> AgentChatSessionSummary {
    try await sendDecodableCommand(action: "cto.ensureSession", as: AgentChatSessionSummary.self)
  }

  func ensureCtoAgentSession(agentId: String) async throws -> AgentChatSessionSummary {
    try await sendDecodableCommand(
      action: "cto.ensureAgentSession",
      args: ["agentId": agentId],
      as: AgentChatSessionSummary.self
    )
  }

  // MARK: - CTO org / worker management

  func fetchCtoState(recentLimit: Int? = nil) async throws -> CtoSnapshot {
    var args: [String: Any] = [:]
    if let recentLimit { args["recentLimit"] = recentLimit }
    return try await sendDecodableCommand(action: "cto.getState", args: args, as: CtoSnapshot.self)
  }

  func fetchCtoAgents(includeDeleted: Bool = false) async throws -> [AgentIdentity] {
    try await sendDecodableCommand(
      action: "cto.listAgents",
      args: ["includeDeleted": includeDeleted],
      as: [AgentIdentity].self
    )
  }

  func fetchCtoBudget() async throws -> AgentBudgetSnapshot {
    try await sendDecodableCommand(action: "cto.getBudgetSnapshot", as: AgentBudgetSnapshot.self)
  }

  func listAgentRuns(agentId: String, limit: Int? = nil) async throws -> [WorkerAgentRun] {
    var args: [String: Any] = ["agentId": agentId]
    if let limit { args["limit"] = limit }
    return try await sendDecodableCommand(action: "cto.listAgentRuns", args: args, as: [WorkerAgentRun].self)
  }

  func listAgentSessionLogs(agentId: String, limit: Int? = nil) async throws -> [AgentSessionLogEntry] {
    var args: [String: Any] = ["agentId": agentId]
    if let limit { args["limit"] = limit }
    return try await sendDecodableCommand(
      action: "cto.listAgentSessionLogs",
      args: args,
      as: [AgentSessionLogEntry].self
    )
  }

  func listAgentRevisions(agentId: String, limit: Int? = nil) async throws -> [AgentConfigRevision] {
    var args: [String: Any] = ["agentId": agentId]
    if let limit { args["limit"] = limit }
    return try await sendDecodableCommand(
      action: "cto.listAgentRevisions",
      args: args,
      as: [AgentConfigRevision].self
    )
  }

  func fetchFlowPolicy() async throws -> LinearWorkflowConfig {
    try await sendDecodableCommand(action: "cto.getFlowPolicy", as: LinearWorkflowConfig.self)
  }

  func fetchLinearConnectionStatus() async throws -> LinearConnectionStatus {
    try await sendDecodableCommand(action: "cto.getLinearConnectionStatus", as: LinearConnectionStatus.self)
  }

  func fetchLinearQuickView() async throws -> LinearQuickView {
    try await sendDecodableCommand(action: "cto.getLinearQuickView", as: LinearQuickView.self)
  }

  func fetchLinearIssuePickerData() async throws -> LinearIssuePickerData {
    try await sendDecodableCommand(action: "cto.getLinearIssuePickerData", as: LinearIssuePickerData.self)
  }

  func searchLinearIssues(_ args: LinearIssueSearchArgs = LinearIssueSearchArgs()) async throws -> LinearIssueSearchResult {
    try await sendDecodableCommand(
      action: "cto.searchLinearIssues",
      args: try encodedCommandArgs(from: args),
      as: LinearIssueSearchResult.self
    )
  }

  func fetchLinearIssueComments(issueId: String) async throws -> [LinearIssueComment] {
    try await sendDecodableCommand(
      action: "cto.getLinearIssueComments",
      args: ["issueId": issueId],
      as: [LinearIssueComment].self
    )
  }

  func fetchLinearSyncDashboard() async throws -> LinearSyncDashboard {
    try await sendDecodableCommand(action: "cto.getLinearSyncDashboard", as: LinearSyncDashboard.self)
  }

  func runLinearSyncNow() async throws -> LinearSyncDashboard {
    try await sendDecodableCommand(action: "cto.runLinearSyncNow", as: LinearSyncDashboard.self)
  }

  func removeAgent(agentId: String) async throws {
    _ = try await sendCommand(action: "cto.removeAgent", args: ["agentId": agentId])
  }

  func saveAgent(_ agent: AgentUpsertInput, actor: String = "mobile") async throws -> AgentIdentity {
    let payload = CtoSaveAgentPayload(agent: agent, actor: actor)
    return try await sendDecodableCommand(
      action: "cto.saveAgent",
      args: try encodedCommandArgs(from: payload),
      as: AgentIdentity.self
    )
  }

  func listLinearSyncQueue() async throws -> [LinearSyncQueueItem] {
    try await sendDecodableCommand(action: "cto.listLinearSyncQueue", as: [LinearSyncQueueItem].self)
  }

  func listLinearIngressEvents(limit: Int? = nil) async throws -> [LinearIngressEventRecord] {
    var args: [String: Any] = [:]
    if let limit { args["limit"] = limit }
    return try await sendDecodableCommand(
      action: "cto.listLinearIngressEvents",
      args: args,
      as: [LinearIngressEventRecord].self
    )
  }

  func updateCtoIdentity(patch: CtoIdentityPatch) async throws -> CtoSnapshot {
    let patchArgs = try encodedCommandArgs(from: patch)
    return try await sendDecodableCommand(
      action: "cto.updateIdentity",
      args: ["patch": patchArgs],
      as: CtoSnapshot.self
    )
  }

  func setAgentStatus(agentId: String, status: String) async throws {
    _ = try await sendCommand(
      action: "cto.setAgentStatus",
      args: ["agentId": agentId, "status": status]
    )
  }

  func triggerAgentWakeup(agentId: String, reason: String? = nil) async throws -> CtoTriggerAgentWakeupResult {
    var args: [String: Any] = ["agentId": agentId]
    if let reason { args["reason"] = reason }
    return try await sendDecodableCommand(
      action: "cto.triggerAgentWakeup",
      args: args,
      as: CtoTriggerAgentWakeupResult.self
    )
  }

  func rollbackAgentRevision(agentId: String, revisionId: String) async throws {
    _ = try await sendCommand(
      action: "cto.rollbackAgentRevision",
      args: ["agentId": agentId, "revisionId": revisionId]
    )
  }

  func refreshPullRequestSnapshots(prId: String? = nil) async throws {
    setDomainStatus([.prs], phase: .hydrating)
    var args: [String: Any] = [:]
    if let prId {
      args["prId"] = prId
    }
    do {
      let raw = try await sendCommand(action: "prs.refresh", args: args)
      let payload = try decodeHydrationPayload(raw, as: PullRequestRefreshPayload.self, domainLabel: "pull request", decoder: decoder)
      try database.replacePullRequestHydration(payload, pruneStale: prId == nil)
      scheduleWorkspaceSnapshotWrite()
      setDomainStatus([.prs], phase: .ready)
    } catch {
      let friendlyMessage = SyncUserFacingError.message(for: error)
      if connectionState == .disconnected || connectionState == .error {
        setDomainStatus([.prs], phase: .disconnected)
      } else {
        setDomainStatus([.prs], phase: .failed, error: friendlyMessage)
      }
      throw error
    }
  }

  func fetchLanes(includeArchived: Bool = false) async throws -> [LaneSummary] {
    database.fetchLanes(includeArchived: includeArchived)
  }

  func fetchLaneListSnapshots(includeArchived: Bool = true) async throws -> [LaneListSnapshot] {
    database.fetchLaneListSnapshots(includeArchived: includeArchived)
  }

  func refreshLaneDetail(laneId: String) async throws -> LaneDetailPayload {
    let laneStatus = status(for: .lanes)
    if laneStatus.phase != .ready {
      setDomainStatus([.lanes], phase: .hydrating)
    }
    do {
      let detail = try await sendDecodableCommand(action: "lanes.getDetail", args: ["laneId": laneId], as: LaneDetailPayload.self)
      try database.replaceLaneDetail(detail)
      setDomainStatus([.lanes], phase: .ready)
      return detail
    } catch {
      let friendlyMessage = SyncUserFacingError.message(for: error)
      if connectionState == .disconnected || connectionState == .error {
        setDomainStatus([.lanes], phase: .disconnected)
      } else {
        setDomainStatus([.lanes], phase: .failed, error: friendlyMessage)
      }
      throw error
    }
  }

  func fetchLaneDetail(laneId: String) async throws -> LaneDetailPayload? {
    database.fetchLaneDetail(laneId: laneId)
  }

  func listWorkspaces() async throws -> [FilesWorkspace] {
    if canSendLiveRequests() {
      do {
        let live = try decode(
          try await performFileRequest(action: "listWorkspaces", args: [:]),
          as: [FilesWorkspace].self
        )
        try? database.replaceFilesWorkspaces(live)
        return database.listWorkspaces()
      } catch {
        let cached = database.listWorkspaces()
        if !cached.isEmpty {
          return cached
        }
        throw error
      }
    }
    return database.listWorkspaces()
  }

  func fetchSessions() async throws -> [TerminalSessionSummary] {
    database.fetchSessions()
  }

  func fetchSession(id sessionId: String) async throws -> TerminalSessionSummary? {
    database.fetchSession(id: sessionId)
  }

  func listProcessDefinitions() async throws -> [ProcessDefinition] {
    try await sendDecodableCommand(action: "processes.listDefinitions", as: [ProcessDefinition].self)
  }

  func listProcessRuntime(laneId: String) async throws -> [ProcessRuntime] {
    try await sendDecodableCommand(action: "processes.listRuntime", args: ["laneId": laneId], as: [ProcessRuntime].self)
  }

  func startProcess(laneId: String, processId: String) async throws -> ProcessRuntime {
    try await sendDecodableCommand(
      action: "processes.start",
      args: ["laneId": laneId, "processId": processId],
      as: ProcessRuntime.self
    )
  }

  func stopProcess(laneId: String, processId: String) async throws {
    _ = try await sendCommand(action: "processes.stop", args: ["laneId": laneId, "processId": processId])
  }

  func fetchComputerUseArtifacts(ownerKind: String, ownerId: String) async throws -> [ComputerUseArtifactSummary] {
    database.fetchComputerUseArtifacts(ownerKind: ownerKind, ownerId: ownerId)
  }

  func renameSession(sessionId: String, title: String) async throws {
    try database.updateSessionTitle(sessionId: sessionId, title: title)
  }

  func setSessionPinned(sessionId: String, pinned: Bool) async throws {
    try database.setSessionPinned(sessionId: sessionId, pinned: pinned)
    if supportsRemoteAction("work.updateSessionMeta") {
      do {
        _ = try await sendCommand(action: "work.updateSessionMeta", args: [
          "sessionId": sessionId,
          "pinned": pinned,
        ])
      } catch {
        syncConnectLog.info(
          "work setSessionPinned deferred session=\(sessionId, privacy: .public) error=\(String(describing: error), privacy: .public)"
        )
      }
    }
  }

  func updateSessionMeta(
    sessionId: String,
    title: String? = nil,
    pinned: Bool? = nil,
    manuallyNamed: Bool? = nil
  ) async throws {
    var args: [String: Any] = ["sessionId": sessionId]
    if let title {
      args["title"] = title
    }
    if let pinned {
      args["pinned"] = pinned
    }
    if let manuallyNamed {
      args["manuallyNamed"] = manuallyNamed
    }
    try database.updateSessionMeta(
      sessionId: sessionId,
      title: title,
      pinned: pinned,
      manuallyNamed: manuallyNamed
    )
    if supportsRemoteAction("work.updateSessionMeta") {
      do {
        _ = try await sendCommand(action: "work.updateSessionMeta", args: args)
      } catch {
        syncConnectLog.info(
          "work updateSessionMeta deferred session=\(sessionId, privacy: .public) error=\(String(describing: error), privacy: .public)"
        )
      }
    }
  }

  func fetchPullRequests() async throws -> [PrSummary] {
    database.fetchPullRequests()
  }

  func fetchPullRequestListItems() async throws -> [PullRequestListItem] {
    database.fetchPullRequestListItems()
  }

  func fetchPullRequestListItems(laneId: String) async throws -> [PullRequestListItem] {
    database.fetchPullRequestListItems(forLane: laneId)
  }

  func fetchPullRequestGroupMembers(groupId: String) async throws -> [PrGroupMemberSummary] {
    database.fetchPullRequestGroupMembers(groupId: groupId)
  }

  func fetchIntegrationProposals() async throws -> [IntegrationProposal] {
    database.fetchIntegrationProposals()
  }

  func fetchQueueStates() async throws -> [QueueLandingState] {
    database.fetchQueueStates()
  }

  func fetchPullRequestSnapshot(prId: String) async throws -> PullRequestSnapshot? {
    database.fetchPullRequestSnapshot(prId: prId)
  }

  /// Fetches the aggregated mobile PR snapshot from the paired host. This
  /// payload drives the iOS PRs surface: stack visibility, create-PR
  /// eligibility, workflow cards, and per-PR capability gates. Live-only;
  /// callers should fall back to cached list/snapshots when offline.
  func fetchPrMobileSnapshot() async throws -> PrMobileSnapshot {
    try await sendDecodableCommand(action: "prs.getMobileSnapshot", as: PrMobileSnapshot.self)
  }

  func fetchGitHubPullRequestSnapshot(force: Bool = false, includeExternalClosed: Bool = false) async throws -> GitHubPrSnapshot {
    try await sendDecodableCommand(
      action: "prs.getGitHubSnapshot",
      args: makePrGithubSnapshotArgs(force: force, includeExternalClosed: includeExternalClosed),
      as: GitHubPrSnapshot.self
    )
  }

  /// Best-effort refresh of the shared `laneGithubPrItems` cache used by the
  /// Lanes and Work tabs to tag lanes with GitHub PRs opened outside ADE.
  /// Throttled (skips when refreshed within `minInterval` unless `force`), a
  /// no-op when the transport is down, and never throws — a missing GitHub
  /// snapshot just leaves the ADE-mapped fallback in place.
  func refreshLaneGithubPrItems(force: Bool = false, minInterval: TimeInterval = 20) async {
    guard connectionState == .connected || connectionState == .syncing else { return }
    if !force, let fetchedAt = laneGithubPrItemsFetchedAt,
      Date().timeIntervalSince(fetchedAt) < minInterval
    {
      return
    }
    // Scope the write to the project in effect when the fetch starts. A project
    // switch (which calls resetChatEventState and clears this cache) can land
    // while the snapshot request is in flight; without this guard a late
    // response from the prior project would repopulate the cache with another
    // repo's PRs.
    let requestedProjectId = activeProjectId
    do {
      let snapshot = try await fetchGitHubPullRequestSnapshot(force: force)
      guard connectionState == .connected || connectionState == .syncing,
        activeProjectId == requestedProjectId
      else { return }
      laneGithubPrItems = snapshot.repoPullRequests.filter { $0.scope == "repo" }
      laneGithubPrItemsFetchedAt = Date()
    } catch {
      // Leave the previous cache (and the ADE-mapped fallback) in place.
    }
  }

  func fetchPullRequestReviewThreads(prId: String) async throws -> [PrReviewThread] {
    try await sendDecodableCommand(action: "prs.getReviewThreads", args: ["prId": prId], as: [PrReviewThread].self)
  }

  func fetchPullRequestActionRuns(prId: String) async throws -> [PrActionRun] {
    try await sendDecodableCommand(action: "prs.getActionRuns", args: ["prId": prId], as: [PrActionRun].self)
  }

  func fetchPullRequestActivity(prId: String) async throws -> [PrActivityEvent] {
    try await sendDecodableCommand(action: "prs.getActivity", args: ["prId": prId], as: [PrActivityEvent].self)
  }

  func fetchPullRequestDeployments(prId: String) async throws -> [PrDeployment] {
    try await sendDecodableCommand(action: "prs.getDeployments", args: ["prId": prId], as: [PrDeployment].self)
  }

  func fetchPullRequestAiSummary(prId: String, model: String? = nil) async throws -> AiReviewSummary {
    var args: [String: Any] = ["prId": prId]
    if let model, !model.isEmpty {
      args["model"] = model
    }
    return try await sendDecodableCommand(action: "prs.aiReviewSummary", args: args, as: AiReviewSummary.self)
  }

  // MARK: - Durable PR in-flight action registry

  /// Register an in-flight PR action. Returns an opaque token that must be
  /// passed back to ``endPrAction(key:token:)`` to clear the entry. If another
  /// action is already registered under `key` it is replaced — the latest
  /// label wins, which matches the "one decisive action per control" model.
  ///
  /// The registry only tracks presentation state (label + start time); the
  /// caller still owns running the async work. Use
  /// ``runDurablePrAction(key:label:operation:onSuccess:onFailure:)`` to get the
  /// service to also own the Task so it COMPLETES regardless of view lifecycle.
  @discardableResult
  func beginPrAction(key: String, label: String) -> UUID {
    let token = UUID()
    prActionsInFlight[key] = PrInFlightAction(token: token, key: key, label: label, startedAt: Date())
    return token
  }

  /// Clear an in-flight entry. No-ops unless the stored token matches `token`,
  /// so a stale completion can't wipe a newer action that reused the same key.
  func endPrAction(key: String, token: UUID) {
    guard prActionsInFlight[key]?.token == token else { return }
    prActionsInFlight[key] = nil
  }

  /// True while any action is registered under `key`.
  func isPrActionInFlight(key: String) -> Bool {
    prActionsInFlight[key] != nil
  }

  /// Label of the action registered under `key`, if any.
  func prActionLabel(forKey key: String) -> String? {
    prActionsInFlight[key]?.label
  }

  /// Run a PR action whose lifecycle is owned by the service, not the view.
  ///
  /// This is the heart of the durable-loading fix: the underlying `operation`
  /// runs inside a detached-from-the-view `Task` that the service spawns, so a
  /// tab switch (which tears the view down) can NEVER cancel it. The in-flight
  /// entry is registered before the await and cleared in `defer`, so the
  /// spinner the views read from `prActionsInFlight[key]` survives remounts and
  /// disappears exactly when the work finishes.
  ///
  /// - Parameters:
  ///   - key: stable registry key (prId, or `"<scope>:<id>"`).
  ///   - label: human-readable in-flight label (e.g. "Merging pull request").
  ///   - operation: the async work to perform.
  ///   - onSuccess: invoked on the main actor after `operation` succeeds.
  ///   - onFailure: invoked on the main actor with the thrown error.
  func runDurablePrAction(
    key: String,
    label: String,
    operation: @escaping () async throws -> Void,
    onSuccess: @escaping @MainActor () -> Void = {},
    onFailure: @escaping @MainActor (Error) -> Void = { _ in }
  ) {
    // Replacing the entry under `key` (begin) implicitly supersedes any prior
    // label for the same control. We do NOT cancel the prior Task — letting
    // both complete is safer than orphaning half-applied remote work.
    let token = beginPrAction(key: key, label: label)
    Task { @MainActor in
      defer { endPrAction(key: key, token: token) }
      do {
        try await operation()
        onSuccess()
      } catch {
        onFailure(error)
      }
    }
  }

  // MARK: - PR detail warm cache

  /// Store a fully-loaded detail entry for `prId`. Stamps `loadedAt` so the
  /// freshness gate can decide whether a later revision bump should refetch.
  func storePrDetailWarmEntry(_ entry: PrDetailWarmEntry, for prId: String) {
    prDetailCache[prId] = entry
  }

  /// Cached detail entry for `prId`, if any.
  func prDetailWarmEntry(for prId: String) -> PrDetailWarmEntry? {
    prDetailCache[prId]
  }

  /// True when the cached entry for `prId` is younger than `window` seconds, so
  /// a revision-driven reload can skip the cold sidecar fan-out.
  func prDetailWarmEntryIsFresh(for prId: String, within window: TimeInterval) -> Bool {
    guard let entry = prDetailCache[prId] else { return false }
    return Date().timeIntervalSince(entry.loadedAt) < window
  }

  func status(for domain: SyncDomain) -> SyncDomainStatus {
    domainStatuses[domain] ?? .disconnected
  }

  var hasFailedDomainStatuses: Bool {
    SyncDomain.allCases.contains { status(for: $0).phase == .failed }
  }

  func retry(domain: SyncDomain) async {
    lastError = nil
    do {
      switch domain {
      case .lanes, .files:
        try await refreshLaneSnapshots()
      case .work:
        try await refreshWorkSessions()
      case .prs:
        try await refreshPullRequestSnapshots()
      }
    } catch {
      lastError = SyncUserFacingError.message(for: error)
    }
  }

  func retryFailedDomains() async {
    let failedDomains = SyncDomain.allCases.filter { status(for: $0).phase == .failed }
    guard !failedDomains.isEmpty else { return }

    if failedDomains.contains(.lanes) || failedDomains.contains(.files) {
      await retry(domain: .lanes)
    }
    if failedDomains.contains(.work) {
      await retry(domain: .work)
    }
    if failedDomains.contains(.prs) {
      await retry(domain: .prs)
    }
  }

  private func ensureMobileFileMutationsAllowed(workspaceId: String) throws {
    let workspace = database.listWorkspaces().first { $0.id == workspaceId }
    guard let workspace else {
      throw NSError(domain: "ADE", code: 118, userInfo: [NSLocalizedDescriptionKey: "The selected Files workspace is no longer available on this phone."])
    }
    guard !workspace.readOnlyOnMobile else {
      throw NSError(domain: "ADE", code: 119, userInfo: [NSLocalizedDescriptionKey: "Files stays read-only on iPhone for this workspace."])
    }
  }

  private func shouldUseCachedFileSnapshot(for error: Error) -> Bool {
    if error is CancellationError {
      return false
    }

    let nsError = error as NSError
    if nsError.domain == "ADE" {
      return nsError.code == 16
    }

    if nsError.domain == NSURLErrorDomain {
      return [
        NSURLErrorCannotConnectToHost,
        NSURLErrorCannotFindHost,
        NSURLErrorDNSLookupFailed,
        NSURLErrorDataNotAllowed,
        NSURLErrorInternationalRoamingOff,
        NSURLErrorNetworkConnectionLost,
        NSURLErrorNotConnectedToInternet,
        NSURLErrorTimedOut,
      ].contains(nsError.code)
    }

    return false
  }

  func readFile(workspaceId: String, path: String) async throws -> SyncFileBlob {
    do {
      let blob = try decode(
        try await performFileRequest(action: "readFile", args: [
          "workspaceId": workspaceId,
          "path": path,
        ]),
        as: SyncFileBlob.self
      )
      try? database.cacheFileContentSnapshot(workspaceId: workspaceId, path: path, blob: blob)
      return blob
    } catch {
      if shouldUseCachedFileSnapshot(for: error), let cached = database.fetchFileContentSnapshot(workspaceId: workspaceId, path: path) {
        return cached
      }
      throw error
    }
  }

  func writeText(workspaceId: String, path: String, text: String) async throws {
    try ensureMobileFileMutationsAllowed(workspaceId: workspaceId)
    _ = try await sendFileRequest(action: "writeText", args: [
      "workspaceId": workspaceId,
      "path": path,
      "text": text,
    ])
  }

  func createFile(workspaceId: String, path: String, content: String = "") async throws {
    try ensureMobileFileMutationsAllowed(workspaceId: workspaceId)
    _ = try await sendFileRequest(action: "createFile", args: [
      "workspaceId": workspaceId,
      "path": path,
      "content": content,
    ])
  }

  func createDirectory(workspaceId: String, path: String) async throws {
    try ensureMobileFileMutationsAllowed(workspaceId: workspaceId)
    _ = try await sendFileRequest(action: "createDirectory", args: [
      "workspaceId": workspaceId,
      "path": path,
    ])
  }

  func renamePath(workspaceId: String, oldPath: String, newPath: String) async throws {
    try ensureMobileFileMutationsAllowed(workspaceId: workspaceId)
    _ = try await sendFileRequest(action: "rename", args: [
      "workspaceId": workspaceId,
      "oldPath": oldPath,
      "newPath": newPath,
    ])
  }

  func deletePath(workspaceId: String, path: String) async throws {
    try ensureMobileFileMutationsAllowed(workspaceId: workspaceId)
    _ = try await sendFileRequest(action: "deletePath", args: [
      "workspaceId": workspaceId,
      "path": path,
    ])
  }

  func quickOpen(
    workspaceId: String,
    query: String,
    limit: Int = 30,
    includeIgnored: Bool = true
  ) async throws -> [FilesQuickOpenItem] {
    let boundedLimit = min(max(limit, 1), 1000)
    return try decode(
      try await sendFileRequest(action: "quickOpen", args: [
        "workspaceId": workspaceId,
        "query": query,
        "limit": boundedLimit,
        "includeIgnored": includeIgnored,
      ]),
      as: [FilesQuickOpenItem].self
    )
  }

  func searchText(
    workspaceId: String,
    query: String,
    limit: Int = 300,
    includeIgnored: Bool = true
  ) async throws -> [FilesSearchTextMatch] {
    let boundedLimit = min(max(limit, 1), 1000)
    return try decode(
      try await sendFileRequest(action: "searchText", args: [
        "workspaceId": workspaceId,
        "query": query,
        "limit": boundedLimit,
        "includeIgnored": includeIgnored,
      ]),
      as: [FilesSearchTextMatch].self
    )
  }

  func listTree(workspaceId: String, parentPath: String = "", includeIgnored: Bool = false) async throws -> [FileTreeNode] {
    do {
      let nodes = try decode(
        try await performFileRequest(action: "listTree", args: [
          "workspaceId": workspaceId,
          "parentPath": parentPath,
          "depth": 1,
          "includeIgnored": includeIgnored,
        ]),
        as: [FileTreeNode].self
      )
      try? database.cacheDirectorySnapshot(workspaceId: workspaceId, parentPath: parentPath, includeHidden: includeIgnored, nodes: nodes)
      return nodes
    } catch {
      if shouldUseCachedFileSnapshot(for: error), let cached = database.fetchDirectorySnapshot(workspaceId: workspaceId, parentPath: parentPath, includeHidden: includeIgnored) {
        return cached
      }
      throw error
    }
  }

  func subscribeTerminal(sessionId: String) async throws {
    let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSessionId.isEmpty else { return }
    if subscribedTerminalSessionIds.contains(trimmedSessionId), terminalBuffers[trimmedSessionId] != nil {
      return
    }
    subscribedTerminalSessionIds.insert(trimmedSessionId)
    try await refreshTerminalSnapshot(sessionId: trimmedSessionId)
  }

  func refreshTerminalSnapshot(sessionId: String, maxBytes: Int = syncTerminalSubscriptionMaxBytes, sinceOffset: Int? = nil) async throws {
    let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSessionId.isEmpty else { return }
    subscribedTerminalSessionIds.insert(trimmedSessionId)
    let requestId = makeRequestId()
    var payload: [String: Any] = [
      "sessionId": trimmedSessionId,
      "maxBytes": max(1_024, min(syncTerminalStreamMaxBytes, maxBytes)),
    ]
    if let sinceOffset, sinceOffset >= 0 {
      payload["sinceOffset"] = sinceOffset
    }
    let raw = try await awaitResponse(requestId: requestId) {
      self.sendEnvelope(type: "terminal_subscribe", requestId: requestId, payload: payload)
    }
    let snapshot = try decode(raw, as: TerminalSnapshot.self)
    guard subscribedTerminalSessionIds.contains(trimmedSessionId) else { return }
    applyTerminalSnapshot(snapshot, sessionId: trimmedSessionId)
  }

  /// Full-screen terminal subscribe: attaches at the 512K budget and resumes
  /// exactly after `sinceOffset` when the caller still holds earlier bytes.
  func subscribeTerminalStream(sessionId: String, sinceOffset: Int? = nil) async throws {
    try await refreshTerminalSnapshot(sessionId: sessionId, maxBytes: syncTerminalStreamMaxBytes, sinceOffset: sinceOffset)
  }

  /// Registers the active full-screen terminal as the live delivery target for
  /// `sessionId`. One handler per session; the screen detaches on disappear.
  func attachTerminalStream(sessionId: String, handler: @escaping (TerminalStreamEvent) -> Void) {
    let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSessionId.isEmpty else { return }
    terminalStreamHandlers[trimmedSessionId] = handler
  }

  func detachTerminalStream(sessionId: String) {
    let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSessionId.isEmpty else { return }
    terminalStreamHandlers.removeValue(forKey: trimmedSessionId)
  }

  /// Fetches transcript bytes ending at/before `beforeOffset` for on-demand
  /// scrollback paging. Requires an active `terminal_subscribe` on the host.
  func fetchTerminalHistory(sessionId: String, beforeOffset: Int, maxBytes: Int = syncTerminalHistoryMaxBytes) async throws -> TerminalHistorySlice {
    let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSessionId.isEmpty else {
      throw NSError(domain: "ADE", code: 6, userInfo: [NSLocalizedDescriptionKey: "Missing terminal session id."])
    }
    guard subscribedTerminalSessionIds.contains(trimmedSessionId) else {
      throw NSError(domain: "ADE", code: 7, userInfo: [NSLocalizedDescriptionKey: "Terminal stream is not subscribed."])
    }
    let requestId = makeRequestId()
    // Older hosts never answer terminal_history; let the request time out
    // without tearing the socket down.
    let raw = try await awaitResponse(requestId: requestId, disconnectOnTimeout: false) {
      self.sendEnvelope(type: "terminal_history", requestId: requestId, payload: [
        "sessionId": trimmedSessionId,
        "beforeOffset": beforeOffset,
        "maxBytes": max(1_024, min(syncTerminalHistoryMaxBytes, maxBytes)),
      ])
    }
    return try decode(raw, as: TerminalHistorySlice.self)
  }

  /// Applies a live `terminal_data` chunk with offset-based ordering. `endOffset`
  /// is the transcript END byte offset after this chunk (nil on older hosts).
  private func handleTerminalDataChunk(sessionId: String, chunk: String, endOffset: Int?) {
    var deliverableChunk: String? = chunk
    if let endOffset {
      if let lastEnd = terminalEndOffsets[sessionId] {
        let chunkStart = endOffset - chunk.utf8.count
        if endOffset <= lastEnd {
          // Replay of bytes a snapshot/delta already covered — drop entirely.
          deliverableChunk = nil
        } else if chunkStart > lastEnd {
          // Missed bytes between lastEnd and this chunk. Drop the chunk and
          // let a delta resubscribe (sinceOffset = lastEnd) deliver the full
          // contiguous range; feeding it now would render out of order.
          deliverableChunk = nil
          recoverTerminalGap(sessionId: sessionId, sinceOffset: lastEnd)
        } else {
          if chunkStart < lastEnd {
            // Partial overlap: trim the already-applied UTF-8 prefix.
            let bytes = Array(chunk.utf8)
            var overlap = min(max(0, lastEnd - chunkStart), bytes.count)
            while overlap < bytes.count, bytes[overlap] & 0xC0 == 0x80 {
              overlap += 1
            }
            deliverableChunk = String(decoding: bytes.dropFirst(overlap), as: UTF8.self)
          }
          terminalEndOffsets[sessionId] = endOffset
        }
      } else {
        terminalEndOffsets[sessionId] = endOffset
      }
    }
    guard let deliverableChunk, !deliverableChunk.isEmpty else {
      terminalBufferUpdatedAt[sessionId] = Date()
      return
    }
    terminalBuffers[sessionId] = trimmedTerminalBuffer((terminalBuffers[sessionId] ?? "") + deliverableChunk)
    terminalBufferUpdatedAt[sessionId] = Date()
    markTerminalBufferChanged(sessionId: sessionId)
    terminalStreamHandlers[sessionId]?(.chunk(text: deliverableChunk, endOffset: endOffset))
  }

  private func recoverTerminalGap(sessionId: String, sinceOffset: Int) {
    guard !terminalGapRecoveryInFlight.contains(sessionId) else { return }
    terminalGapRecoveryInFlight.insert(sessionId)
    Task { @MainActor [weak self] in
      guard let self else { return }
      defer { self.terminalGapRecoveryInFlight.remove(sessionId) }
      try? await self.refreshTerminalSnapshot(
        sessionId: sessionId,
        maxBytes: syncTerminalStreamMaxBytes,
        sinceOffset: sinceOffset
      )
    }
  }

  private func applyTerminalSnapshot(_ snapshot: TerminalSnapshot, sessionId: String) {
    if let endOffset = snapshot.endOffset {
      terminalEndOffsets[sessionId] = endOffset
    }
    if snapshot.delta == true {
      // Delta resume: payload covers exactly [sinceOffset, end). Append —
      // replacing would drop everything the screen already rendered.
      if !snapshot.transcript.isEmpty {
        terminalBuffers[sessionId] = trimmedTerminalBuffer((terminalBuffers[sessionId] ?? "") + snapshot.transcript)
        markTerminalBufferChanged(sessionId: sessionId, immediate: true)
        terminalStreamHandlers[sessionId]?(.hydrate(
          text: snapshot.transcript,
          replacing: false,
          startOffset: snapshot.startOffset,
          endOffset: snapshot.endOffset
        ))
      }
      terminalBufferUpdatedAt[sessionId] = Date()
    } else {
      updateTerminalBuffer(sessionId: sessionId, transcript: snapshot.transcript, immediate: true)
      terminalStreamHandlers[sessionId]?(.hydrate(
        text: snapshot.transcript,
        replacing: true,
        startOffset: snapshot.startOffset,
        endOffset: snapshot.endOffset
      ))
    }
    if snapshot.live == false {
      // No PTY behind the session (ended, or orphaned by a brain restart even
      // though status still says running) — typing would go nowhere. Surface
      // the exited/resume state instead of a live prompt.
      terminalStreamHandlers[sessionId]?(.exit(code: nil))
    }
  }

  /// Whether a full-screen terminal currently owns the live stream for
  /// `sessionId`. Used to skip detach-unsubscribes that would race a remount.
  func hasTerminalStream(sessionId: String) -> Bool {
    let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSessionId.isEmpty else { return false }
    return terminalStreamHandlers[trimmedSessionId] != nil
  }

  /// Relaunches an ended/orphaned agent CLI session's runtime on the host
  /// (same sessionId, provider resume metadata) — the phone mirror of the
  /// desktop resume affordance.
  func resumeCliSession(sessionId: String, cols: Int? = nil, rows: Int? = nil) async throws -> StartCliSessionResult {
    var args: [String: Any] = ["sessionId": sessionId]
    if let cols { args["cols"] = cols }
    if let rows { args["rows"] = rows }
    return try await sendDecodableCommand(action: "work.resumeCliSession", args: args, as: StartCliSessionResult.self)
  }

  func unsubscribeTerminal(sessionId: String) async throws {
    let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSessionId.isEmpty else { return }
    guard subscribedTerminalSessionIds.contains(trimmedSessionId) else { return }
    subscribedTerminalSessionIds.remove(trimmedSessionId)
    if canSendLiveRequests() {
      sendEnvelope(type: "terminal_unsubscribe", requestId: nil, payload: [
        "sessionId": trimmedSessionId,
      ])
    }
  }

  /// Forward keystrokes (or pasted text, or control sequences) from the
  /// mobile UI into the live PTY for `sessionId`. Fire-and-forget — the
  /// host echoes accepted bytes back as `terminal_data` so the user sees
  /// confirmation by re-reading the buffer rather than waiting on an ack.
  ///
  /// Caller must have already issued `subscribeTerminal(sessionId:)` —
  /// the host enforces the same gate to prevent unauthorized writes.
  func sendTerminalInput(sessionId: String, data: String) {
    guard !sessionId.isEmpty else { return }
    guard canSendLiveRequests() else { return }
    sendEnvelope(type: "terminal_input", requestId: nil, payload: [
      "sessionId": sessionId,
      "data": data,
    ])
  }

  /// Tell the host to reshape the active PTY for `sessionId` to a new
  /// `cols x rows`. Use this when the visible viewport changes (rotation,
  /// split view, font-size). Cheap and idempotent; the host clamps to a
  /// sane dimension range internally.
  func sendTerminalResize(sessionId: String, cols: Int, rows: Int) {
    guard !sessionId.isEmpty else { return }
    guard cols > 0, rows > 0 else { return }
    guard canSendLiveRequests() else { return }
    sendEnvelope(type: "terminal_resize", requestId: nil, payload: [
      "sessionId": sessionId,
      "cols": cols,
      "rows": rows,
    ])
  }

  func subscribeToChatEvents(sessionId: String, requestSnapshot: Bool = false, maxBytes: Int? = nil) async throws {
    let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSessionId.isEmpty else { return }
    let wasSubscribed = subscribedChatSessionIds.contains(trimmedSessionId)
    if !wasSubscribed {
      subscribedChatSessionIds.insert(trimmedSessionId)
      localStateRevision += 1
    }
    if canSendLiveRequests() && supportsChatStreaming && (!wasSubscribed || requestSnapshot) {
      // Explicit snapshot requests must not advertise a resume point — the
      // caller wants the full history, not a delta replay.
      let payload = chatSubscriptionPayload(sessionId: trimmedSessionId, maxBytes: maxBytes, includeSinceSeq: !requestSnapshot)
      syncChatLog.notice(
        "chat_subscribe_send session=\(trimmedSessionId, privacy: .public) requestSnapshot=\(requestSnapshot, privacy: .public) wasSubscribed=\(wasSubscribed, privacy: .public) maxBytes=\((payload["maxBytes"] as? Int) ?? -1, privacy: .public) sinceSeq=\((payload["sinceSeq"] as? Int) ?? -1, privacy: .public) reducedLoad=\(self.prefersReducedSyncLoad, privacy: .public) state=\(self.connectionState.rawValue, privacy: .public)"
      )
      sendEnvelope(
        type: "chat_subscribe",
        requestId: nil,
        payload: payload
      )
    }
  }

  func requestFullChatEventSnapshot(sessionId: String) async throws {
    try await subscribeToChatEvents(sessionId: sessionId, requestSnapshot: true, maxBytes: syncChatSubscriptionMaxBytes)
  }

  func unsubscribeFromChatEvents(sessionId: String) async throws {
    let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSessionId.isEmpty else { return }
    guard subscribedChatSessionIds.contains(trimmedSessionId) else { return }
    subscribedChatSessionIds.remove(trimmedSessionId)
    localStateRevision += 1
    if canSendLiveRequests() && supportsChatStreaming {
      sendEnvelope(type: "chat_unsubscribe", requestId: nil, payload: chatSubscriptionPayload(sessionId: trimmedSessionId))
    }
  }

  func chatEventHistory(sessionId: String) -> [AgentChatEventEnvelope] {
    chatEventEnvelopesBySession[sessionId] ?? []
  }

  @discardableResult
  func pruneChatEventHistory(sessionId: String, keepingTail limit: Int) -> [AgentChatEventEnvelope] {
    let trimmedSessionId = sessionId.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmedSessionId.isEmpty,
          let events = chatEventEnvelopesBySession[trimmedSessionId]
    else { return [] }
    let clampedLimit = max(0, limit)
    guard events.count > clampedLimit else { return events }
    let next = Array(events.suffix(clampedLimit))
    chatEventEnvelopesBySession[trimmedSessionId] = next
    return next
  }

  func chatEventRevision(for sessionId: String) -> Int {
    chatEventRevisionsBySession[sessionId] ?? 0
  }

  /// True/false when the host has told us whether a turn is currently running
  /// for this session (subscribe ack or live status/done events); nil when no
  /// signal has arrived yet (e.g. older hosts without `turnActive`).
  func chatTurnActiveHint(sessionId: String) -> Bool? {
    chatTurnActiveHintBySession[sessionId]
  }

  func updateChatTurnActiveHint(sessionId: String, turnActive: Bool) {
    guard chatTurnActiveHintBySession[sessionId] != turnActive else { return }
    chatTurnActiveHintBySession[sessionId] = turnActive
    // Streaming-state flips drive the stop button and activity indicator —
    // surface them immediately rather than waiting out the event coalescer.
    markChatEventsChanged(immediate: true)
  }

  /// Drop the hint so streaming state falls back to transcript-derived
  /// signals. Used when a full subscribe ack carries no `turnActive` (older
  /// host, or no live summary) — keeping a stale `true` would pin the stop
  /// button and the active-poll loop on a session the host no longer runs.
  private func clearChatTurnActiveHint(sessionId: String) {
    guard chatTurnActiveHintBySession.removeValue(forKey: sessionId) != nil else { return }
    markChatEventsChanged(immediate: true)
  }

  private func updateChatTurnActiveHintFromEvent(_ envelope: AgentChatEventEnvelope) {
    switch envelope.event {
    case .status(let turnStatus, _, _):
      updateChatTurnActiveHint(sessionId: envelope.sessionId, turnActive: turnStatus == .started)
    case .done:
      updateChatTurnActiveHint(sessionId: envelope.sessionId, turnActive: false)
    default:
      break
    }
  }

  func chatSubscriptionPayloads() -> [[String: Any]] {
    subscribedChatSessionIds.sorted().map { chatSubscriptionPayload(sessionId: $0, includeSinceSeq: true) }
  }

  func runQuickCommand(
    laneId: String,
    title: String,
    startupCommand: String? = nil,
    toolType: String? = nil,
    tracked: Bool = true
  ) async throws {
    var args: [String: Any] = [
      "laneId": laneId,
      "title": title,
      "tracked": tracked,
    ]
    if let startupCommand, !startupCommand.isEmpty {
      args["startupCommand"] = startupCommand
    }
    if let toolType, !toolType.isEmpty {
      args["toolType"] = toolType
    }
    _ = try await sendCommand(action: "work.runQuickCommand", args: args)
  }

  func startCliSession(
    laneId: String,
    provider: String,
    permissionMode: String? = nil,
    title: String? = nil,
    initialInput: String? = nil,
    modelId: String? = nil,
    reasoningEffort: String? = nil,
    cols: Int? = nil,
    rows: Int? = nil,
    targetProjectId: String? = nil,
    targetProjectRootPath: String? = nil
  ) async throws -> StartCliSessionResult {
    var args: [String: Any] = [
      "laneId": laneId,
      "provider": provider,
    ]
    if let permissionMode, !permissionMode.isEmpty {
      args["permissionMode"] = permissionMode
    }
    if let title, !title.isEmpty {
      args["title"] = title
    }
    if let initialInput, !initialInput.isEmpty {
      args["initialInput"] = initialInput
    }
    if let modelId, !modelId.isEmpty {
      args["modelId"] = modelId
    }
    if let reasoningEffort, !reasoningEffort.isEmpty {
      args["reasoningEffort"] = reasoningEffort
    }
    if let cols, cols > 0 {
      args["cols"] = cols
    }
    if let rows, rows > 0 {
      args["rows"] = rows
    }
    return try await sendDecodableCommand(
      action: "work.startCliSession",
      args: args,
      targetProjectId: targetProjectId,
      targetProjectRootPath: targetProjectRootPath,
      as: StartCliSessionResult.self
    )
  }

  func stopWorkRuntime(sessionId: String) async throws {
    _ = try await sendCommand(action: "work.stopRuntime", args: ["sessionId": sessionId])
  }

  func createLane(
    name: String,
    description: String,
    parentLaneId: String? = nil,
    baseBranch: String? = nil,
    branchName: String? = nil,
    startPoint: String? = nil,
    linearIssue: LaneLinearIssue? = nil,
    targetProjectId: String? = nil,
    targetProjectRootPath: String? = nil
  ) async throws -> LaneSummary {
    var args: [String: Any] = [
      "name": name,
      "description": description,
    ]
    if let parentLaneId, !parentLaneId.isEmpty {
      args["parentLaneId"] = parentLaneId
    }
    if let baseBranch, !baseBranch.isEmpty {
      args["baseBranch"] = baseBranch
    }
    if let branchName, !branchName.isEmpty {
      args["branchName"] = branchName
    }
    if let startPoint, !startPoint.isEmpty {
      args["startPoint"] = startPoint
    }
    if let linearIssue {
      args["linearIssue"] = try jsonObject(from: linearIssue)
      if args["branchName"] == nil, let branchName = linearIssue.branchName, !branchName.isEmpty {
        args["branchName"] = branchName
      }
    }
    return try await sendDecodableCommand(
      action: "lanes.create",
      args: args,
      targetProjectId: targetProjectId,
      targetProjectRootPath: targetProjectRootPath,
      as: LaneSummary.self
    )
  }

  private struct SuggestLaneNameResult: Decodable { let name: String }

  /// Asks the host's small naming model for a lane name (desktop parity with
  /// `agentChatService.suggestLaneNameFromPrompt`). The host honors its own
  /// `titleGenerationEnabled` setting and clamps the name; it returns a
  /// deterministic fallback when naming is disabled/unavailable. This command is
  /// NOT queueable, so an offline phone throws here rather than queueing — the
  /// caller is expected to catch and fall back to its own deterministic name.
  ///
  /// The request is short (10s) and non-disconnecting: it's a best-effort lookup
  /// that the caller races against its own 10s UI deadline, so a slow/stuck host
  /// must not strain the connection or trigger a probe/reconnect that could
  /// disrupt the chat/CLI session started right after the lane is created.
  func suggestLaneName(
    laneId: String,
    prompt: String,
    modelId: String,
    fallbackName: String
  ) async throws -> String {
    let args: [String: Any] = [
      "laneId": laneId,
      "prompt": prompt,
      "modelId": modelId,
      "fallbackName": fallbackName,
    ]
    let result = try await sendDecodableCommand(
      action: "lanes.suggestName",
      args: args,
      disconnectOnTimeout: false,
      timeoutNanoseconds: 10_000_000_000,
      as: SuggestLaneNameResult.self
    )
    let trimmed = result.name.trimmingCharacters(in: .whitespacesAndNewlines)
    return trimmed.isEmpty ? fallbackName : trimmed
  }

  func createFromUnstaged(sourceLaneId: String, name: String, description: String = "") async throws -> LaneSummary {
    var args: [String: Any] = [
      "sourceLaneId": sourceLaneId,
      "name": name,
    ]
    if !description.isEmpty {
      args["description"] = description
    }
    return try await sendDecodableCommand(action: "lanes.createFromUnstaged", args: args, as: LaneSummary.self)
  }

  func importBranch(
    branchRef: String,
    name: String? = nil,
    description: String? = nil,
    parentLaneId: String? = nil,
    baseBranch: String? = nil
  ) async throws -> LaneSummary {
    var args: [String: Any] = ["branchRef": branchRef]
    if let name, !name.isEmpty {
      args["name"] = name
    }
    if let description, !description.isEmpty {
      args["description"] = description
    }
    if let parentLaneId, !parentLaneId.isEmpty {
      args["parentLaneId"] = parentLaneId
    }
    if let baseBranch, !baseBranch.isEmpty {
      args["baseBranch"] = baseBranch
    }
    return try await sendDecodableCommand(action: "lanes.importBranch", args: args, as: LaneSummary.self)
  }

  func createChildLane(
    name: String,
    parentLaneId: String,
    description: String = "",
    folder: String? = nil,
    baseBranchRef: String? = nil,
    branchName: String? = nil,
    linearIssue: LaneLinearIssue? = nil
  ) async throws -> LaneSummary {
    var args: [String: Any] = [
      "name": name,
      "parentLaneId": parentLaneId,
      "description": description,
    ]
    if let folder, !folder.isEmpty {
      args["folder"] = folder
    }
    if let baseBranchRef, !baseBranchRef.isEmpty {
      args["baseBranchRef"] = baseBranchRef
    }
    if let branchName, !branchName.isEmpty {
      args["branchName"] = branchName
    }
    if let linearIssue {
      args["linearIssue"] = try jsonObject(from: linearIssue)
      if args["branchName"] == nil, let branchName = linearIssue.branchName, !branchName.isEmpty {
        args["branchName"] = branchName
      }
    }
    return try await sendDecodableCommand(action: "lanes.createChild", args: args, as: LaneSummary.self)
  }

  func attachLane(name: String, attachedPath: String, description: String = "") async throws -> LaneSummary {
    try await sendDecodableCommand(action: "lanes.attach", args: [
      "name": name,
      "attachedPath": attachedPath,
      "description": description,
    ], as: LaneSummary.self)
  }

  func adoptAttachedLane(_ laneId: String) async throws -> LaneSummary {
    try await sendDecodableCommand(action: "lanes.adoptAttached", args: ["laneId": laneId], as: LaneSummary.self)
  }

  func listUnregisteredWorktrees() async throws -> [UnregisteredLaneCandidate] {
    try await sendDecodableCommand(action: "lanes.listUnregisteredWorktrees", as: [UnregisteredLaneCandidate].self)
  }

  func renameLane(_ laneId: String, name: String) async throws {
    _ = try await sendCommand(action: "lanes.rename", args: ["laneId": laneId, "name": name])
  }

  func reparentLane(
    _ laneId: String,
    newParentLaneId: String,
    stackBaseBranchRef: String? = nil
  ) async throws {
    let args = makeLanesReparentArgs(
      laneId: laneId,
      newParentLaneId: newParentLaneId,
      stackBaseBranchRef: stackBaseBranchRef
    )
    _ = try await sendCommand(action: "lanes.reparent", args: args)
  }

  func updateLaneAppearance(_ laneId: String, color: String? = nil, icon: String? = nil, tags: [String]? = nil) async throws {
    var args: [String: Any] = ["laneId": laneId]
    if let color {
      args["color"] = color
    }
    if let icon {
      args["icon"] = icon
    }
    if let tags {
      args["tags"] = tags
    }
    _ = try await sendCommand(action: "lanes.updateAppearance", args: args)
  }

  func archiveLane(_ laneId: String) async throws {
    _ = try await sendCommand(action: "lanes.archive", args: ["laneId": laneId])
  }

  func unarchiveLane(_ laneId: String) async throws {
    _ = try await sendCommand(action: "lanes.unarchive", args: ["laneId": laneId])
  }

  func deleteLane(
    _ laneId: String,
    deleteBranch: Bool = true,
    deleteRemoteBranch: Bool = false,
    remoteName: String = "origin",
    force: Bool = false
  ) async throws {
    _ = try await sendCommand(action: "lanes.delete", args: [
      "laneId": laneId,
      "deleteBranch": deleteBranch,
      "deleteRemoteBranch": deleteRemoteBranch,
      "remoteName": remoteName,
      "force": force,
    ])
  }

  func fetchLaneTemplates() async throws -> [LaneTemplate] {
    try await sendDecodableCommand(action: "lanes.listTemplates", as: [LaneTemplate].self)
  }

  func fetchDefaultLaneTemplateId() async throws -> String? {
    let raw = try await sendCommand(action: "lanes.getDefaultTemplate", args: [:])
    if raw is NSNull { return nil }
    return raw as? String
  }

  func fetchLaneEnvStatus(laneId: String) async throws -> LaneEnvInitProgress? {
    let raw = try await sendCommand(action: "lanes.getEnvStatus", args: ["laneId": laneId])
    if raw is NSNull { return nil }
    return try decode(raw, as: LaneEnvInitProgress.self)
  }

  func initializeLaneEnvironment(laneId: String) async throws -> LaneEnvInitProgress {
    try await sendDecodableCommand(action: "lanes.initEnv", args: ["laneId": laneId], as: LaneEnvInitProgress.self)
  }

  func applyLaneTemplate(laneId: String, templateId: String) async throws -> LaneEnvInitProgress {
    try await sendDecodableCommand(
      action: "lanes.applyTemplate",
      args: ["laneId": laneId, "templateId": templateId],
      as: LaneEnvInitProgress.self
    )
  }

  func startLaneRebase(
    laneId: String,
    scope: String = "lane_only",
    pushMode: String = "none",
    aiAssisted: Bool = false
  ) async throws {
    _ = try await sendCommand(action: "lanes.rebaseStart", args: [
      "laneId": laneId,
      "scope": scope,
      "pushMode": pushMode,
      "aiAssisted": aiAssisted,
    ])
  }

  func pushLaneRebase(runId: String, laneIds: [String]) async throws {
    _ = try await sendCommand(action: "lanes.rebasePush", args: ["runId": runId, "laneIds": laneIds])
  }

  func rollbackLaneRebase(runId: String) async throws {
    _ = try await sendCommand(action: "lanes.rebaseRollback", args: ["runId": runId])
  }

  func abortLaneRebase(runId: String) async throws {
    _ = try await sendCommand(action: "lanes.rebaseAbort", args: ["runId": runId])
  }

  func dismissRebaseSuggestion(laneId: String) async throws {
    _ = try await sendCommand(action: "lanes.dismissRebaseSuggestion", args: ["laneId": laneId])
  }

  func deferRebaseSuggestion(laneId: String, minutes: Int = 60) async throws {
    _ = try await sendCommand(action: "lanes.deferRebaseSuggestion", args: ["laneId": laneId, "minutes": minutes])
  }

  func listBranches(laneId: String) async throws -> [GitBranchSummary] {
    try await sendDecodableCommand(action: "git.listBranches", args: ["laneId": laneId], as: [GitBranchSummary].self)
  }

  func previewBranchSwitch(
    laneId: String,
    branchName: String,
    mode: String = "existing",
    startPoint: String? = nil,
    baseRef: String? = nil
  ) async throws -> LaneBranchSwitchPreview {
    var args: [String: Any] = [
      "laneId": laneId,
      "branchName": branchName,
      "mode": mode
    ]
    if let startPoint, !startPoint.isEmpty { args["startPoint"] = startPoint }
    if let baseRef, !baseRef.isEmpty { args["baseRef"] = baseRef }
    return try await sendDecodableCommand(action: "lanes.previewBranchSwitch", args: args, as: LaneBranchSwitchPreview.self)
  }

  /// Switch a lane to a different branch (or create one). Callers must
  /// explicitly choose `mode` and `acknowledgeActiveWork` so dirty/active-work
  /// safeguards aren't silently bypassed when this wrapper is reused beyond
  /// the primary-branch picker.
  func checkoutPrimaryBranch(
    laneId: String,
    branchName: String,
    mode: String,
    startPoint: String?,
    baseRef: String?,
    acknowledgeActiveWork: Bool
  ) async throws {
    var args: [String: Any] = [
      "laneId": laneId,
      "branchName": branchName,
      "mode": mode,
      "acknowledgeActiveWork": acknowledgeActiveWork
    ]
    if let startPoint, !startPoint.isEmpty { args["startPoint"] = startPoint }
    if let baseRef, !baseRef.isEmpty { args["baseRef"] = baseRef }
    _ = try await sendCommand(action: "git.checkoutBranch", args: args)
  }

  func fetchLaneChanges(laneId: String) async throws -> DiffChanges {
    try await sendDecodableCommand(action: "git.getChanges", args: ["laneId": laneId], as: DiffChanges.self)
  }

  func fetchFileDiff(workspaceId: String? = nil, laneId: String, path: String, mode: String, compareRef: String? = nil, compareTo: String? = nil) async throws -> FileDiff {
    var args: [String: Any] = [
      "laneId": laneId,
      "path": path,
      "mode": mode,
    ]
    if let compareRef, !compareRef.isEmpty {
      args["compareRef"] = compareRef
    }
    if let compareTo, !compareTo.isEmpty {
      args["compareTo"] = compareTo
    }
    do {
      let diff = try await sendDecodableCommand(action: "git.getFile", args: args, as: FileDiff.self)
      if let workspaceId {
        try? database.cacheFileDiffSnapshot(workspaceId: workspaceId, path: path, mode: mode, diff: diff)
      }
      return diff
    } catch {
      if let workspaceId, let cached = database.fetchFileDiffSnapshot(workspaceId: workspaceId, path: path, mode: mode) {
        return cached
      }
      throw error
    }
  }

  func fetchFileHistory(workspaceId: String, laneId: String, path: String, limit: Int = 20) async throws -> [GitFileHistoryEntry] {
    do {
      let entries = try await sendDecodableCommand(
        action: "git.getFileHistory",
        args: ["laneId": laneId, "path": path, "limit": limit],
        as: [GitFileHistoryEntry].self
      )
      try? database.cacheFileHistorySnapshot(workspaceId: workspaceId, path: path, entries: entries)
      return entries
    } catch {
      if let cached = database.fetchFileHistorySnapshot(workspaceId: workspaceId, path: path) {
        return cached
      }
      throw error
    }
  }

  func writeLaneFileText(laneId: String, path: String, text: String) async throws {
    _ = try await sendCommand(action: "files.writeTextAtomic", args: [
      "laneId": laneId,
      "path": path,
      "text": text,
    ])
  }

  func stageFile(laneId: String, path: String) async throws { _ = try await sendCommand(action: "git.stageFile", args: ["laneId": laneId, "path": path]) }
  func stageAll(laneId: String, paths: [String]) async throws { _ = try await sendCommand(action: "git.stageAll", args: ["laneId": laneId, "paths": paths]) }
  func unstageFile(laneId: String, path: String) async throws { _ = try await sendCommand(action: "git.unstageFile", args: ["laneId": laneId, "path": path]) }
  func unstageAll(laneId: String, paths: [String]) async throws { _ = try await sendCommand(action: "git.unstageAll", args: ["laneId": laneId, "paths": paths]) }
  func discardFile(laneId: String, path: String) async throws { _ = try await sendCommand(action: "git.discardFile", args: ["laneId": laneId, "path": path]) }
  func restoreStagedFile(laneId: String, path: String) async throws { _ = try await sendCommand(action: "git.restoreStagedFile", args: ["laneId": laneId, "path": path]) }

  func commitLane(laneId: String, message: String, amend: Bool = false) async throws {
    _ = try await sendCommand(action: "git.commit", args: ["laneId": laneId, "message": message, "amend": amend])
  }

  func generateCommitMessage(laneId: String, amend: Bool = false) async throws -> String {
    let result = try await sendDecodableCommand(
      action: "git.generateCommitMessage",
      args: ["laneId": laneId, "amend": amend],
      as: GitGenerateCommitMessageResult.self
    )
    return result.message
  }

  func listRecentCommits(laneId: String) async throws -> [GitCommitSummary] {
    try await sendDecodableCommand(action: "git.listRecentCommits", args: ["laneId": laneId], as: [GitCommitSummary].self)
  }

  func listCommitFiles(laneId: String, commitSha: String) async throws -> [String] {
    try await sendDecodableCommand(action: "git.listCommitFiles", args: ["laneId": laneId, "commitSha": commitSha], as: [String].self)
  }

  func getCommitMessage(laneId: String, commitSha: String) async throws -> String {
    let raw = try await sendCommand(action: "git.getCommitMessage", args: ["laneId": laneId, "commitSha": commitSha])
    return raw as? String ?? ""
  }

  func revertCommit(laneId: String, commitSha: String) async throws { _ = try await sendCommand(action: "git.revertCommit", args: ["laneId": laneId, "commitSha": commitSha]) }
  func cherryPickCommit(laneId: String, commitSha: String) async throws { _ = try await sendCommand(action: "git.cherryPickCommit", args: ["laneId": laneId, "commitSha": commitSha]) }
  func stashPush(laneId: String, message: String = "", includeUntracked: Bool = false) async throws { _ = try await sendCommand(action: "git.stashPush", args: ["laneId": laneId, "message": message, "includeUntracked": includeUntracked]) }
  func listStashes(laneId: String) async throws -> [GitStashSummary] { try await sendDecodableCommand(action: "git.stashList", args: ["laneId": laneId], as: [GitStashSummary].self) }
  func stashApply(laneId: String, stashRef: String) async throws { _ = try await sendCommand(action: "git.stashApply", args: ["laneId": laneId, "stashRef": stashRef]) }
  func stashPop(laneId: String, stashRef: String) async throws { _ = try await sendCommand(action: "git.stashPop", args: ["laneId": laneId, "stashRef": stashRef]) }
  func stashDrop(laneId: String, stashRef: String) async throws { _ = try await sendCommand(action: "git.stashDrop", args: ["laneId": laneId, "stashRef": stashRef]) }
  func fetchGit(laneId: String) async throws { _ = try await sendCommand(action: "git.fetch", args: ["laneId": laneId]) }
  func pullGit(laneId: String) async throws { _ = try await sendCommand(action: "git.pull", args: ["laneId": laneId]) }
  func fetchSyncStatus(laneId: String) async throws -> GitUpstreamSyncStatus { try await sendDecodableCommand(action: "git.getSyncStatus", args: ["laneId": laneId], as: GitUpstreamSyncStatus.self) }
  func syncGit(laneId: String, mode: String = "merge", baseRef: String? = nil) async throws {
    var args: [String: Any] = ["laneId": laneId, "mode": mode]
    if let baseRef, !baseRef.isEmpty { args["baseRef"] = baseRef }
    _ = try await sendCommand(action: "git.sync", args: args)
  }
  func pushGit(laneId: String, forceWithLease: Bool = false) async throws { _ = try await sendCommand(action: "git.push", args: ["laneId": laneId, "forceWithLease": forceWithLease]) }
  func fetchGitConflictState(laneId: String) async throws -> GitConflictState { try await sendDecodableCommand(action: "git.getConflictState", args: ["laneId": laneId], as: GitConflictState.self) }
  func rebaseContinueGit(laneId: String) async throws { _ = try await sendCommand(action: "git.rebaseContinue", args: ["laneId": laneId]) }
  func rebaseAbortGit(laneId: String) async throws { _ = try await sendCommand(action: "git.rebaseAbort", args: ["laneId": laneId]) }
  func mergeContinueGit(laneId: String) async throws { _ = try await sendCommand(action: "git.mergeContinue", args: ["laneId": laneId]) }
  func mergeAbortGit(laneId: String) async throws { _ = try await sendCommand(action: "git.mergeAbort", args: ["laneId": laneId]) }

  @MainActor
  func listChatModels(provider: String) async throws -> [AgentChatModelInfo] {
    let normalizedProvider = provider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let cacheKey = chatModelsCacheKey(provider: normalizedProvider)
    let now = Date()

    if let cached = chatModelsCache[cacheKey],
       now.timeIntervalSince(cached.fetchedAt) < chatModelsCacheTTL {
      return cached.models
    }

    if let task = chatModelsInFlight[cacheKey] {
      return try await task.value
    }

    let task = Task { @MainActor [weak self] in
      guard let self else { throw CancellationError() }
      // Cursor/droid model lists are discovered dynamically on the host;
      // activate the runtime so a fresh key surfaces models on first fetch
      // instead of returning an empty passive cache (mirrors the TUI). Mobile
      // chats run cursor models through the SDK, so only that source is
      // probed synchronously — the CLI flavor revalidates in the background.
      var args: [String: Any] = ["provider": normalizedProvider]
      if normalizedProvider == "cursor" || normalizedProvider == "droid" {
        args["activateRuntime"] = true
      }
      if normalizedProvider == "cursor" {
        args["cursorSource"] = "sdk"
      }
      let response = try await self.sendCommand(
        action: "chat.models",
        args: args,
        disconnectOnTimeout: false,
        timeoutMessage: "Model list is still loading from the machine.",
        timeoutNanoseconds: SyncRequestTimeout.modelCatalogTimeoutNanoseconds
      )
      return try self.decode(response, as: [AgentChatModelInfo].self)
    }
    chatModelsInFlight[cacheKey] = task

    do {
      let models = try await task.value
      chatModelsCache[cacheKey] = ChatModelsCacheEntry(models: models, fetchedAt: now)
      chatModelsInFlight[cacheKey] = nil
      return models
    } catch {
      chatModelsInFlight[cacheKey] = nil
      if let cached = chatModelsCache[cacheKey] {
        return cached.models
      }
      throw error
    }
  }

  @MainActor
  func cachedChatModelCatalog() -> AgentChatModelCatalog? {
    // Scope the fallback lookup to the current host/project. `chatModelsCacheKey`
    // mixes host + project root into every key it writes, so returning the newest
    // entry from *any* cache row could leak a different host's catalog into the
    // active session. Match the key prefix instead and only consider entries that
    // belong to the same host/project scope.
    let scopePrefix = chatModelsCacheKey(provider: "")
    let scopedEntries = chatModelCatalogCache
      .filter { key, _ in
        // Strip the provider component from the stored key and compare scopes.
        // Both `scopePrefix` and the stored key use `\u{1f}` separators between
        // provider, host, and project root; everything after the first separator
        // is the host+project portion we care about.
        guard let sepIndex = scopePrefix.firstIndex(of: "\u{1f}"),
              let storedSepIndex = key.firstIndex(of: "\u{1f}")
        else { return false }
        return scopePrefix[sepIndex...] == key[storedSepIndex...]
      }
      .values
    guard let cached = scopedEntries.sorted(by: { $0.fetchedAt > $1.fetchedAt }).first else { return nil }
    guard Date().timeIntervalSince(cached.fetchedAt) < chatModelsCacheTTL else { return nil }
    return cached.catalog
  }

  @MainActor
  func getChatModelCatalog(
    mode: String = "refresh-stale",
    refreshProvider: String? = nil
  ) async throws -> AgentChatModelCatalog {
    let cacheKey = chatModelsCacheKey(provider: "catalog:\(mode):\(refreshProvider ?? "")")
    let now = Date()

    if mode != "force",
       let cached = chatModelCatalogCache[cacheKey],
       now.timeIntervalSince(cached.fetchedAt) < chatModelsCacheTTL {
      return cached.catalog
    }

    if mode == "cached" {
      if let cached = chatModelCatalogCache[cacheKey],
         now.timeIntervalSince(cached.fetchedAt) < chatModelsCacheTTL {
        return cached.catalog
      }
      if let cached = cachedChatModelCatalog() {
        return cached
      }
    }

    if let task = chatModelCatalogInFlight[cacheKey] {
      return try await task.value
    }

    let task = Task { @MainActor [weak self] in
      guard let self else { throw CancellationError() }
      var args: [String: Any] = ["mode": mode]
      if let refreshProvider {
        args["refreshProvider"] = refreshProvider
      }
      let response = try await self.sendCommand(
        action: "chat.modelCatalog",
        args: args,
        disconnectOnTimeout: false,
        timeoutMessage: "Model catalog is still loading from the machine.",
        timeoutNanoseconds: SyncRequestTimeout.modelCatalogTimeoutNanoseconds
      )
      return try self.decode(response, as: AgentChatModelCatalog.self)
    }
    chatModelCatalogInFlight[cacheKey] = task

    do {
      let catalog = try await task.value
      chatModelCatalogCache[cacheKey] = ChatModelCatalogCacheEntry(catalog: catalog, fetchedAt: now)
      if mode == "force", let refreshProvider {
        let refreshStaleKey = chatModelsCacheKey(provider: "catalog:refresh-stale:\(refreshProvider)")
        chatModelCatalogCache[refreshStaleKey] = ChatModelCatalogCacheEntry(catalog: catalog, fetchedAt: now)
      }
      chatModelCatalogInFlight[cacheKey] = nil
      return catalog
    } catch {
      chatModelCatalogInFlight[cacheKey] = nil
      if let cached = chatModelCatalogCache[cacheKey] {
        return cached.catalog
      }
      if let cached = cachedChatModelCatalog() {
        return cached
      }
      throw error
    }
  }

  private func chatModelsCacheKey(provider: String) -> String {
    let profile = activeHostProfile
    let hostKey = profile?.hostIdentity
      ?? profile?.lastHostDeviceId
      ?? profile?.lastSuccessfulAddress
      ?? currentAddress
      ?? hostName
      ?? "unpaired-host"
    return [
      provider.isEmpty ? "default" : provider,
      hostKey,
      activeProjectRootPath ?? activeProjectId ?? "no-project",
    ].joined(separator: "\u{1f}")
  }

  // MARK: - Cross-surface model picker (favorites + recents)
  //
  // Mirrors the desktop `useModelFavorites` / `useModelRecents` hooks and the
  // TUI implementation. Backed by the per-project cr-sqlite DB on the ade-cli
  // host so favorites and recents converge across desktop, TUI, and iOS via
  // sync. Recents are capped at 10 server-side — the client should not pre-trim.

  func getModelFavorites() async throws -> [String] {
    let payload = try await sendDecodableCommand(
      action: "modelPicker.getFavorites",
      args: [:],
      as: ModelPickerFavorites.self
    )
    return payload.favorites
  }

  func setModelFavorites(_ favorites: [String]) async throws -> [String] {
    let payload = try await sendDecodableCommand(
      action: "modelPicker.setFavorites",
      args: ["favorites": favorites],
      as: ModelPickerFavorites.self
    )
    return payload.favorites
  }

  @discardableResult
  func toggleModelFavorite(_ modelId: String) async throws -> ModelPickerToggleFavoriteResult {
    try await sendDecodableCommand(
      action: "modelPicker.toggleFavorite",
      args: ["modelId": modelId],
      as: ModelPickerToggleFavoriteResult.self
    )
  }

  func getModelRecents() async throws -> [String] {
    let payload = try await sendDecodableCommand(
      action: "modelPicker.getRecents",
      args: [:],
      as: ModelPickerRecents.self
    )
    return payload.recents
  }

  @discardableResult
  func pushModelRecent(_ modelId: String) async throws -> [String] {
    let payload = try await sendDecodableCommand(
      action: "modelPicker.pushRecent",
      args: ["modelId": modelId],
      as: ModelPickerRecents.self
    )
    return payload.recents
  }

  func listChatSessions(laneId: String) async throws -> [AgentChatSessionSummary] {
    try await sendDecodableCommand(
      action: "chat.listSessions",
      args: ["laneId": laneId, "includeAutomation": true, "includeArchived": true],
      as: [AgentChatSessionSummary].self
    )
  }

  func createChatSession(
    laneId: String,
    provider: String,
    model: String = "",
    reasoningEffort: String? = nil,
    codexFastMode: Bool? = nil,
    sessionProfile: String? = nil,
    permissionMode: String? = nil,
    interactionMode: String? = nil,
    claudePermissionMode: String? = nil,
    codexApprovalPolicy: String? = nil,
    codexSandbox: String? = nil,
    codexConfigSource: String? = nil,
    opencodePermissionMode: String? = nil,
    droidPermissionMode: String? = nil,
    cursorModeId: String? = nil,
    cursorConfigValues: [String: RemoteJSONValue]? = nil,
    computerUse: RemoteJSONValue? = nil,
    requestedCwd: String? = nil,
    targetProjectId: String? = nil,
    targetProjectRootPath: String? = nil
  ) async throws -> AgentChatSessionSummary {
    let trimmedModel = model.trimmingCharacters(in: .whitespacesAndNewlines)
    var args: [String: Any] = [
      "laneId": laneId,
      "provider": provider,
      "model": model,
    ]
    if !trimmedModel.isEmpty {
      args["modelId"] = trimmedModel
    }
    if let reasoningEffort, !reasoningEffort.isEmpty {
      args["reasoningEffort"] = reasoningEffort
    }
    if let codexFastMode {
      args["codexFastMode"] = codexFastMode
    }
    if let sessionProfile, !sessionProfile.isEmpty {
      args["sessionProfile"] = sessionProfile
    }
    if let permissionMode, !permissionMode.isEmpty {
      args["permissionMode"] = permissionMode
    }
    if let interactionMode, !interactionMode.isEmpty {
      args["interactionMode"] = interactionMode
    }
    if let claudePermissionMode, !claudePermissionMode.isEmpty {
      args["claudePermissionMode"] = claudePermissionMode
    }
    if let codexApprovalPolicy, !codexApprovalPolicy.isEmpty {
      args["codexApprovalPolicy"] = codexApprovalPolicy
    }
    if let codexSandbox, !codexSandbox.isEmpty {
      args["codexSandbox"] = codexSandbox
    }
    if let codexConfigSource, !codexConfigSource.isEmpty {
      args["codexConfigSource"] = codexConfigSource
    }
    if let opencodePermissionMode, !opencodePermissionMode.isEmpty {
      args["opencodePermissionMode"] = opencodePermissionMode
    }
    if let droidPermissionMode, !droidPermissionMode.isEmpty {
      args["droidPermissionMode"] = droidPermissionMode
    }
    if let cursorModeId, !cursorModeId.isEmpty {
      args["cursorModeId"] = cursorModeId
    }
    if let cursorConfigValues, !cursorConfigValues.isEmpty {
      args["cursorConfigValues"] = cursorConfigValues.mapValues(syncFoundationObject(from:))
    }
    if let computerUse {
      args["computerUse"] = syncFoundationObject(from: computerUse)
    }
    if let requestedCwd, !requestedCwd.isEmpty {
      args["requestedCwd"] = requestedCwd
    }
    return try await sendDecodableCommand(
      action: "chat.create",
      args: args,
      targetProjectId: targetProjectId,
      targetProjectRootPath: targetProjectRootPath,
      as: AgentChatSessionSummary.self
    )
  }

  func fetchChatSummary(sessionId: String) async throws -> AgentChatSessionSummary {
    try await sendDecodableCommand(action: "chat.getSummary", args: ["sessionId": sessionId], as: AgentChatSessionSummary.self)
  }

  func fetchChatEventHistorySnapshot(sessionId: String, maxEvents: Int = chatEventHistoryMaxEvents) async throws -> AgentChatEventHistorySnapshot {
    try await sendDecodableCommand(
      action: "chat.getChatEventHistory",
      args: ["sessionId": sessionId, "maxEvents": max(1, min(chatEventHistoryMaxEvents, maxEvents))],
      as: AgentChatEventHistorySnapshot.self
    )
  }

  @discardableResult
  func hydrateChatEventHistorySnapshot(sessionId: String, maxEvents: Int = chatEventHistoryMaxEvents) async throws -> AgentChatEventHistorySnapshot {
    let snapshot = try await fetchChatEventHistorySnapshot(sessionId: sessionId, maxEvents: maxEvents)
    guard snapshot.sessionFound != false else { return snapshot }
    mergeChatEventHistory(sessionId: snapshot.sessionId, events: snapshot.events)
    return snapshot
  }

  @discardableResult
  func hydrateChatEventHistoryTailPage(sessionId: String) async throws -> AgentChatEventHistoryPage {
    let page = try await fetchChatEventHistoryPage(
      sessionId: sessionId,
      beforeOffset: syncChatHistoryTailPageProbeOffset,
      maxBytes: syncChatHistoryTailPageMaxBytes
    )
    guard page.sessionFound != false else { return page }
    mergeChatEventHistory(sessionId: page.sessionId, events: page.events)
    return page
  }

  func fetchChatEventHistoryPage(
    sessionId: String,
    beforeOffset: Int,
    maxBytes: Int? = nil
  ) async throws -> AgentChatEventHistoryPage {
    var args: [String: Any] = ["sessionId": sessionId, "beforeOffset": beforeOffset]
    if let maxBytes, maxBytes > 0 {
      args["maxBytes"] = maxBytes
    }
    return try await sendDecodableCommand(
      action: "chat.getChatEventHistoryPage",
      args: args,
      as: AgentChatEventHistoryPage.self
    )
  }

  func fetchChatTranscriptResponse(sessionId: String, limit: Int = 500, maxChars: Int = 600_000) async throws -> AgentChatTranscriptResponse {
    try await sendDecodableCommand(
      action: "chat.getTranscript",
      args: ["sessionId": sessionId, "limit": limit, "maxChars": maxChars],
      as: AgentChatTranscriptResponse.self
    )
  }

  func fetchChatTranscript(sessionId: String, limit: Int = 500, maxChars: Int = 600_000) async throws -> [AgentChatTranscriptEntry] {
    let response = try await fetchChatTranscriptResponse(sessionId: sessionId, limit: limit, maxChars: maxChars)
    return response.entries
  }

  /// One page of a paginated chat transcript walk. `nextCursor` is the
  /// host-side index of the oldest entry returned (the transcript is
  /// append-only, so indices are stable); pass it back via
  /// `fetchChatTranscriptPage(cursor:)` to load the previous (older) page.
  /// `nil` means the start of the transcript was reached.
  struct AgentChatTranscriptPage: Equatable {
    var sessionId: String
    var entries: [AgentChatTranscriptEntry]
    var truncated: Bool
    var totalEntries: Int
    var nextCursor: Int?
  }

  struct AgentChatSubagentTranscriptMessage: Codable, Equatable {
    var type: String
    var uuid: String?
    var sessionId: String
    var parentToolUseId: String?
    var message: RemoteJSONValue?
    var text: String?
    var subagentMetadata: RemoteJSONValue?
  }

  struct AgentChatSubagentSnapshot: Codable, Equatable {
    var taskId: String
    var agentId: String?
    var agentType: String?
    var parentToolUseId: String?
    var description: String
    var status: String
    var turnId: String?
    var startTimestamp: String?
    var endTimestamp: String?
    var summary: String?
    var finalSummary: String?
    var lastToolName: String?
    var background: Bool?
    var usage: AgentChatSubagentUsage?
  }

  /// Fetch a transcript page. Without `cursor` this returns the newest
  /// entries (same data as `fetchChatTranscriptResponse`) plus a cursor for
  /// walking backwards; with `cursor` it returns the page strictly BEFORE
  /// that index. Older hosts that predate pagination simply omit
  /// `nextCursor`, which surfaces here as `nil` (no more pages).
  func fetchChatTranscriptPage(
    sessionId: String,
    cursor: Int? = nil,
    limit: Int = 200,
    maxChars: Int = 600_000
  ) async throws -> AgentChatTranscriptPage {
    var args: [String: Any] = ["sessionId": sessionId, "limit": limit, "maxChars": maxChars]
    if let cursor, cursor > 0 {
      args["cursor"] = String(cursor)
    }
    let response = try await sendCommand(action: "chat.getTranscript", args: args)
    if let payload = response as? [String: Any], payload["queued"] as? Bool == true {
      throw QueuedRemoteCommandError(action: "chat.getTranscript")
    }
    let transcript = try decode(response, as: AgentChatTranscriptResponse.self)
    var nextCursor: Int?
    if let dict = response as? [String: Any], let rawCursor = dict["nextCursor"] {
      if let text = rawCursor as? String {
        nextCursor = Int(text)
      } else if let number = rawCursor as? NSNumber, !(rawCursor is Bool) {
        nextCursor = number.intValue
      }
    }
    return AgentChatTranscriptPage(
      sessionId: transcript.sessionId,
      entries: transcript.entries,
      truncated: transcript.truncated,
      totalEntries: transcript.totalEntries,
      nextCursor: nextCursor
    )
  }

  func fetchSubagentTranscript(
    sessionId: String,
    agentId: String,
    taskId: String? = nil,
    laneId: String? = nil,
    limit: Int? = nil,
    offset: Int? = nil
  ) async throws -> [AgentChatSubagentTranscriptMessage]? {
    var args: [String: Any] = [
      "sessionId": sessionId,
      "agentId": agentId,
    ]
    if let taskId, !taskId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      args["taskId"] = taskId
    }
    if let laneId, !laneId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
      args["laneId"] = laneId
    }
    if let limit {
      args["limit"] = limit
    }
    if let offset {
      args["offset"] = offset
    }
    let response = try await sendCommand(action: "chat.getSubagentTranscript", args: args)
    if response is NSNull {
      return nil
    }
    if let payload = response as? [String: Any], payload["queued"] as? Bool == true {
      throw QueuedRemoteCommandError(action: "chat.getSubagentTranscript")
    }
    return try decode(response, as: [AgentChatSubagentTranscriptMessage].self)
  }

  func fetchSubagents(sessionId: String) async throws -> [AgentChatSubagentSnapshot] {
    let response = try await sendCommand(
      action: "chat.listSubagents",
      args: ["sessionId": sessionId]
    )
    if let payload = response as? [String: Any], payload["queued"] as? Bool == true {
      throw QueuedRemoteCommandError(action: "chat.listSubagents")
    }
    return try decode(response, as: [AgentChatSubagentSnapshot].self)
  }

  @discardableResult
  func sendChatMessage(sessionId: String, text: String) async throws -> SyncChatMessageDelivery {
    let response = try await sendCommand(
      action: "chat.send",
      args: ["sessionId": sessionId, "text": text],
      disconnectOnTimeout: false,
      timeoutMessage: SyncRequestTimeout.chatSendMessage,
      timeoutNanoseconds: SyncRequestTimeout.chatSendTimeoutNanoseconds
    )
    return syncChatMessageDelivery(from: response)
  }

  func interruptChatSession(sessionId: String) async throws {
    _ = try await sendChatCommand(action: "chat.interrupt", payload: AgentChatInterruptRequest(sessionId: sessionId))
  }

  @discardableResult
  func steerChatSession(sessionId: String, text: String) async throws -> SyncChatMessageDelivery {
    let response = try await sendChatCommand(action: "chat.steer", payload: AgentChatSteerRequest(sessionId: sessionId, text: text))
    return syncChatMessageDelivery(from: response)
  }

  func cancelChatSteer(sessionId: String, steerId: String) async throws {
    _ = try await sendChatCommand(
      action: "chat.cancelSteer",
      payload: AgentChatCancelSteerRequest(sessionId: sessionId, steerId: steerId)
    )
  }

  func editChatSteer(sessionId: String, steerId: String, text: String) async throws {
    _ = try await sendChatCommand(
      action: "chat.editSteer",
      payload: AgentChatEditSteerRequest(sessionId: sessionId, steerId: steerId, text: text)
    )
  }

  func dispatchChatSteer(sessionId: String, steerId: String, mode: String) async throws {
    _ = try await sendChatCommand(
      action: "chat.dispatchSteer",
      payload: AgentChatDispatchSteerRequest(sessionId: sessionId, steerId: steerId, mode: mode)
    )
  }

  func cancelDispatchedChatSteer(sessionId: String, steerId: String) async throws {
    _ = try await sendChatCommand(
      action: "chat.cancelDispatchedSteer",
      payload: AgentChatCancelDispatchedSteerRequest(sessionId: sessionId, steerId: steerId)
    )
  }

  func approveChatSession(
    sessionId: String,
    itemId: String,
    decision: AgentChatApprovalDecision,
    responseText: String? = nil
  ) async throws {
    _ = try await sendChatCommand(
      action: "chat.approve",
      payload: AgentChatApproveRequest(sessionId: sessionId, itemId: itemId, decision: decision, responseText: responseText)
    )
  }

  func respondToChatInput(
    sessionId: String,
    itemId: String,
    decision: AgentChatApprovalDecision? = nil,
    answers: [String: AgentChatInputAnswerValue]? = nil,
    responseText: String? = nil
  ) async throws {
    _ = try await sendChatCommand(
      action: "chat.respondToInput",
      payload: AgentChatRespondToInputRequest(
        sessionId: sessionId,
        itemId: itemId,
        decision: decision,
        answers: answers,
        responseText: responseText
      )
    )
  }

  func updateChatSession(
    sessionId: String,
    title: String? = nil,
    modelId: String? = nil,
    reasoningEffort: String? = nil,
    codexFastMode: Bool? = nil,
    permissionMode: String? = nil,
    interactionMode: String? = nil,
    claudePermissionMode: String? = nil,
    codexApprovalPolicy: String? = nil,
    codexSandbox: String? = nil,
    codexConfigSource: String? = nil,
    opencodePermissionMode: String? = nil,
    droidPermissionMode: String? = nil,
    cursorModeId: String? = nil,
    cursorConfigValues: [String: RemoteJSONValue]? = nil,
    unifiedPermissionMode: String? = nil,
    computerUse: RemoteJSONValue? = nil,
    manuallyNamed: Bool? = nil
  ) async throws -> AgentChatSession {
    try await sendDecodableChatCommand(
      action: "chat.updateSession",
      payload: AgentChatUpdateSessionRequest(
        sessionId: sessionId,
        title: title,
        modelId: modelId,
        reasoningEffort: reasoningEffort,
        codexFastMode: codexFastMode,
        permissionMode: permissionMode,
        interactionMode: interactionMode,
        claudePermissionMode: claudePermissionMode,
        codexApprovalPolicy: codexApprovalPolicy,
        codexSandbox: codexSandbox,
        codexConfigSource: codexConfigSource,
        opencodePermissionMode: opencodePermissionMode,
        droidPermissionMode: droidPermissionMode,
        cursorModeId: cursorModeId,
        cursorConfigValues: cursorConfigValues,
        unifiedPermissionMode: unifiedPermissionMode,
        computerUse: computerUse,
        manuallyNamed: manuallyNamed
      ),
      as: AgentChatSession.self
    )
  }

  func archiveChatSession(sessionId: String) async throws {
    _ = try await sendChatCommand(action: "chat.archive", payload: AgentChatSessionIdRequest(sessionId: sessionId))
  }

  func unarchiveChatSession(sessionId: String) async throws {
    _ = try await sendChatCommand(action: "chat.unarchive", payload: AgentChatSessionIdRequest(sessionId: sessionId))
  }

  func deleteChatSession(sessionId: String) async throws {
    _ = try await sendChatCommand(action: "chat.delete", payload: AgentChatSessionIdRequest(sessionId: sessionId))
  }

  func readArtifact(artifactId: String? = nil, uri: String? = nil, path: String? = nil) async throws -> SyncFileBlob {
    var args: [String: Any] = [:]
    if let artifactId, !artifactId.isEmpty {
      args["artifactId"] = artifactId
    }
    if let uri, !uri.isEmpty {
      args["uri"] = uri
    }
    if let path, !path.isEmpty {
      args["path"] = path
    }
    return try decode(try await performFileRequest(action: "readArtifact", args: args), as: SyncFileBlob.self)
  }

  func createPullRequest(
    laneId: String,
    title: String,
    body: String,
    draft: Bool = false,
    baseBranch: String? = nil,
    labels: [String] = [],
    reviewers: [String],
    strategy: String? = nil
  ) async throws {
    var args: [String: Any] = [
      "laneId": laneId,
      "title": title,
      "body": body,
      "draft": draft,
    ]
    if !reviewers.isEmpty {
      args["reviewers"] = reviewers
    }
    if let baseBranch, !baseBranch.isEmpty {
      args["baseBranch"] = baseBranch
    }
    if !labels.isEmpty {
      args["labels"] = labels
    }
    if let strategy, !strategy.isEmpty {
      args["strategy"] = strategy
    }
    _ = try await sendCommand(action: "prs.createFromLane", args: args)
  }

  func mergePullRequest(
    prId: String,
    method: String,
    bypassRules: Bool = false,
    commitTitle: String? = nil,
    commitBody: String? = nil,
    expectedHeadSha: String? = nil
  ) async throws {
    var args: [String: Any] = [
      "prId": prId,
      "method": method,
    ]
    if bypassRules { args["bypassRules"] = true }
    // Commit title/body are ignored by the host for the `rebase` method; only
    // forward non-empty values so squash/merge get GitHub-fidelity messages.
    if let commitTitle, !commitTitle.isEmpty { args["commitTitle"] = commitTitle }
    if let commitBody, !commitBody.isEmpty { args["commitBody"] = commitBody }
    if let expectedHeadSha, !expectedHeadSha.isEmpty { args["expectedHeadSha"] = expectedHeadSha }
    _ = try await sendCommand(action: "prs.land", args: args)
  }

  func closePullRequest(prId: String) async throws {
    _ = try await sendCommand(action: "prs.close", args: ["prId": prId])
  }

  func reopenPullRequest(prId: String) async throws {
    _ = try await sendCommand(action: "prs.reopen", args: ["prId": prId])
  }

  func requestReviewers(prId: String, reviewers: [String]) async throws {
    _ = try await sendCommand(action: "prs.requestReviewers", args: [
      "prId": prId,
      "reviewers": reviewers,
    ])
  }

  func draftPullRequestDescription(laneId: String) async throws -> PullRequestDraftSuggestion {
    try await sendDecodableCommand(action: "prs.draftDescription", args: ["laneId": laneId], as: PullRequestDraftSuggestion.self)
  }

  func rerunPullRequestChecks(prId: String, checkRunIds: [Int]? = nil) async throws {
    var args: [String: Any] = ["prId": prId]
    if let checkRunIds, !checkRunIds.isEmpty {
      args["checkRunIds"] = checkRunIds
    }
    _ = try await sendCommand(action: "prs.rerunChecks", args: args)
  }

  func addPullRequestComment(prId: String, body: String, inReplyToCommentId: String? = nil) async throws {
    var args: [String: Any] = [
      "prId": prId,
      "body": body,
    ]
    if let inReplyToCommentId, !inReplyToCommentId.isEmpty {
      args["inReplyToCommentId"] = inReplyToCommentId
    }
    _ = try await sendCommand(action: "prs.addComment", args: args)
  }

  func updatePullRequestTitle(prId: String, title: String) async throws {
    _ = try await sendCommand(action: "prs.updateTitle", args: [
      "prId": prId,
      "title": title,
    ])
  }

  func linkPullRequestToLane(laneId: String, prUrlOrNumber: String) async throws {
    _ = try await sendCommand(action: "prs.linkToLane", args: [
      "laneId": laneId,
      "prUrlOrNumber": prUrlOrNumber,
    ])
  }

  /// Dry-run the create-lane-from-PR-branch (auto-map) flow. Resolves the PR's
  /// head branch and reports whether a lane can be created, or what conflict is
  /// blocking it, without mutating any state. ``lane``/``pr`` are null in the
  /// preflight payload, so only ``preflight`` is decoded.
  func preflightCreateLaneFromPrBranch(
    repoOwner: String,
    repoName: String,
    githubPrNumber: Int
  ) async throws -> PrAutoMapPreflightResult {
    try await sendDecodableCommand(
      action: "prs.preflightCreateLaneFromPrBranch",
      args: [
        "repoOwner": repoOwner,
        "repoName": repoName,
        "githubPrNumber": githubPrNumber,
      ],
      as: PrAutoMapPreflightResult.self
    )
  }

  /// Create a lane from a PR's head branch (auto-map). Returns the resolved
  /// preflight plus the newly created ``lane``. The UI should refresh the PR
  /// list afterward to pick up the new mapping.
  @discardableResult
  func createLaneFromPrBranch(
    repoOwner: String,
    repoName: String,
    githubPrNumber: Int
  ) async throws -> PrAutoMapCreateResult {
    try await sendDecodableCommand(
      action: "prs.createLaneFromPrBranch",
      args: [
        "repoOwner": repoOwner,
        "repoName": repoName,
        "githubPrNumber": githubPrNumber,
      ],
      as: PrAutoMapCreateResult.self
    )
  }

  func updatePullRequestBody(prId: String, body: String) async throws {
    _ = try await sendCommand(action: "prs.updateBody", args: [
      "prId": prId,
      "body": body,
    ])
  }

  func setPullRequestLabels(prId: String, labels: [String]) async throws {
    _ = try await sendCommand(action: "prs.setLabels", args: [
      "prId": prId,
      "labels": labels,
    ])
  }

  func submitPullRequestReview(prId: String, event: String, body: String? = nil) async throws {
    var args: [String: Any] = [
      "prId": prId,
      "event": event,
    ]
    if let body {
      args["body"] = body
    }
    _ = try await sendCommand(action: "prs.submitReview", args: args)
  }

  func replyToPullRequestReviewThread(prId: String, threadId: String, body: String) async throws {
    _ = try await sendCommand(action: "prs.replyToReviewThread", args: [
      "prId": prId,
      "threadId": threadId,
      "body": body,
    ])
  }

  func setPullRequestReviewThreadResolved(prId: String, threadId: String, resolved: Bool) async throws {
    _ = try await sendCommand(action: "prs.setReviewThreadResolved", args: [
      "prId": prId,
      "threadId": threadId,
      "resolved": resolved,
    ])
  }

  func resolveReviewThread(prId: String, threadId: String, resolved: Bool) async throws {
    _ = try await sendCommand(action: "prs.resolveReviewThread", args: [
      "prId": prId,
      "threadId": threadId,
      "resolved": resolved,
    ])
  }

  func landQueueNext(groupId: String, method: String, archiveLane: Bool = true, autoResolve: Bool = true) async throws {
    _ = try await sendCommand(action: "prs.landQueueNext", args: [
      "groupId": groupId,
      "method": method,
      "archiveLane": archiveLane,
      "autoResolve": autoResolve,
    ])
  }

  func pauseQueueAutomation(queueId: String) async throws {
    _ = try await sendCommand(action: "prs.pauseQueueAutomation", args: ["queueId": queueId])
  }

  func resumeQueueAutomation(queueId: String, method: String? = nil) async throws {
    var args: [String: Any] = ["queueId": queueId]
    if let method, !method.isEmpty {
      args["method"] = method
    }
    _ = try await sendCommand(action: "prs.resumeQueueAutomation", args: args)
  }

  func cancelQueueAutomation(queueId: String) async throws {
    _ = try await sendCommand(action: "prs.cancelQueueAutomation", args: ["queueId": queueId])
  }

  func reorderQueue(groupId: String, prIds: [String]) async throws {
    _ = try await sendCommand(action: "prs.reorderQueue", args: [
      "groupId": groupId,
      "prIds": prIds,
    ])
  }

  @discardableResult
  func createIntegrationLaneForProposal(proposalId: String) async throws -> CreateIntegrationLaneForProposalResult {
    try await sendDecodableCommand(action: "prs.createIntegrationLaneForProposal", args: ["proposalId": proposalId], as: CreateIntegrationLaneForProposalResult.self)
  }

  @discardableResult
  func startIntegrationResolution(proposalId: String, laneId: String) async throws -> StartIntegrationResolutionResult {
    try await sendDecodableCommand(action: "prs.startIntegrationResolution", args: [
      "proposalId": proposalId,
      "laneId": laneId,
    ], as: StartIntegrationResolutionResult.self)
  }

  @discardableResult
  func recheckIntegrationStep(proposalId: String, laneId: String) async throws -> RecheckIntegrationStepResult {
    try await sendDecodableCommand(action: "prs.recheckIntegrationStep", args: [
      "proposalId": proposalId,
      "laneId": laneId,
    ], as: RecheckIntegrationStepResult.self)
  }

  @discardableResult
  func deleteIntegrationProposal(proposalId: String, deleteIntegrationLane: Bool = false) async throws -> DeleteIntegrationProposalResult {
    try await sendDecodableCommand(action: "prs.deleteIntegrationProposal", args: [
      "proposalId": proposalId,
      "deleteIntegrationLane": deleteIntegrationLane,
    ], as: DeleteIntegrationProposalResult.self)
  }

  func dismissIntegrationCleanup(proposalId: String) async throws {
    _ = try await sendCommand(action: "prs.dismissIntegrationCleanup", args: ["proposalId": proposalId])
  }

  func cleanupIntegrationWorkflow(proposalId: String, archiveIntegrationLane: Bool = true, archiveSourceLaneIds: [String] = []) async throws {
    _ = try await sendCommand(action: "prs.cleanupIntegrationWorkflow", args: [
      "proposalId": proposalId,
      "archiveIntegrationLane": archiveIntegrationLane,
      "archiveSourceLaneIds": archiveSourceLaneIds,
    ])
  }

  func updateIntegrationProposal(
    proposalId: String,
    title: String? = nil,
    body: String? = nil,
    draft: Bool? = nil,
    integrationLaneName: String? = nil,
    preferredIntegrationLaneId: String? = nil,
    mergeIntoHeadSha: String? = nil
  ) async throws {
    var args: [String: Any] = ["proposalId": proposalId]
    if let title { args["title"] = title }
    if let body { args["body"] = body }
    if let draft { args["draft"] = draft }
    if let integrationLaneName { args["integrationLaneName"] = integrationLaneName }
    if let preferredIntegrationLaneId { args["preferredIntegrationLaneId"] = preferredIntegrationLaneId }
    if let mergeIntoHeadSha { args["mergeIntoHeadSha"] = mergeIntoHeadSha }
    _ = try await sendCommand(action: "prs.updateIntegrationProposal", args: args)
  }

  @discardableResult
  func createQueuePrs(
    laneIds: [String],
    targetBranch: String? = nil,
    titles: [String: String]? = nil,
    draft: Bool? = nil,
    autoRebase: Bool? = nil,
    ciGating: Bool? = nil,
    queueName: String? = nil,
    allowDirtyWorktree: Bool? = nil
  ) async throws -> CreateQueuePrsResult {
    var args: [String: Any] = ["laneIds": laneIds]
    if let targetBranch, !targetBranch.isEmpty { args["targetBranch"] = targetBranch }
    if let titles, !titles.isEmpty { args["titles"] = titles }
    if let draft { args["draft"] = draft }
    if let autoRebase { args["autoRebase"] = autoRebase }
    if let ciGating { args["ciGating"] = ciGating }
    if let queueName, !queueName.isEmpty { args["queueName"] = queueName }
    if let allowDirtyWorktree { args["allowDirtyWorktree"] = allowDirtyWorktree }
    return try await sendDecodableCommand(action: "prs.createQueue", args: args, as: CreateQueuePrsResult.self)
  }

  func startQueueAutomation(
    groupId: String,
    method: String,
    archiveLane: Bool? = nil,
    autoResolve: Bool? = nil,
    ciGating: Bool? = nil,
    resolverProvider: String? = nil,
    resolverModel: String? = nil
  ) async throws {
    var args: [String: Any] = [
      "groupId": groupId,
      "method": method,
    ]
    if let archiveLane { args["archiveLane"] = archiveLane }
    if let autoResolve { args["autoResolve"] = autoResolve }
    if let ciGating { args["ciGating"] = ciGating }
    if let resolverProvider, !resolverProvider.isEmpty { args["resolverProvider"] = resolverProvider }
    if let resolverModel, !resolverModel.isEmpty { args["resolverModel"] = resolverModel }
    _ = try await sendCommand(action: "prs.startQueueAutomation", args: args)
  }

  func simulateIntegration(
    sourceLaneIds: [String],
    baseBranch: String? = nil,
    persist: Bool? = nil,
    mergeIntoLaneId: String? = nil
  ) async throws -> IntegrationProposal {
    var args: [String: Any] = ["sourceLaneIds": sourceLaneIds]
    if let baseBranch, !baseBranch.isEmpty { args["baseBranch"] = baseBranch }
    if let persist { args["persist"] = persist }
    if let mergeIntoLaneId, !mergeIntoLaneId.isEmpty { args["mergeIntoLaneId"] = mergeIntoLaneId }
    return try await sendDecodableCommand(action: "prs.simulateIntegration", args: args, as: IntegrationProposal.self)
  }

  @discardableResult
  func commitIntegration(
    proposalId: String,
    integrationLaneName: String? = nil,
    title: String? = nil,
    body: String? = nil,
    draft: Bool? = nil,
    pauseOnConflict: Bool? = nil,
    allowDirtyWorktree: Bool? = nil,
    preferredIntegrationLaneId: String? = nil
  ) async throws -> CreateIntegrationPrResult {
    var args: [String: Any] = ["proposalId": proposalId]
    if let integrationLaneName, !integrationLaneName.isEmpty { args["integrationLaneName"] = integrationLaneName }
    if let title, !title.isEmpty { args["title"] = title }
    if let body { args["body"] = body }
    if let draft { args["draft"] = draft }
    if let pauseOnConflict { args["pauseOnConflict"] = pauseOnConflict }
    if let allowDirtyWorktree { args["allowDirtyWorktree"] = allowDirtyWorktree }
    if let preferredIntegrationLaneId, !preferredIntegrationLaneId.isEmpty {
      args["preferredIntegrationLaneId"] = preferredIntegrationLaneId
    }
    return try await sendDecodableCommand(action: "prs.commitIntegration", args: args, as: CreateIntegrationPrResult.self)
  }

  func listIntegrationWorkflows(view: String? = nil) async throws -> [IntegrationProposal] {
    var args: [String: Any] = [:]
    if let view, !view.isEmpty { args["view"] = view }
    return try await sendDecodableCommand(action: "prs.listIntegrationWorkflows", args: args, as: [IntegrationProposal].self)
  }

  func landStackEnhanced(rootLaneId: String, method: String, mode: String) async throws -> [LandResult] {
    try await sendDecodableCommand(action: "prs.landStackEnhanced", args: [
      "rootLaneId": rootLaneId,
      "method": method,
      "mode": mode,
    ], as: [LandResult].self)
  }

  private func saveProfile(_ profile: HostConnectionProfile?) {
    if let profile, let data = try? encoder.encode(profile) {
      UserDefaults.standard.set(data, forKey: profileKey)
      if let key = profileStorageKey(profile) {
        var profiles = loadSavedProfilesRaw()
        profiles[key] = profile
        saveSavedProfiles(profiles)
        migrateTokenIfNeeded(for: profile)
      }
      if activeHostProfile.map({ !syncProfilesEquivalentForPublishedState($0, profile) }) ?? true {
        activeHostProfile = profile
      }
      if hostName != profile.hostName {
        hostName = profile.hostName
      }
      hiddenProjectKeys = loadHiddenProjectKeys()
      if activeProjectId != nil {
        let hostIdentity = syncNormalizedCommandScopeValue(profile.hostIdentity)
          ?? syncNormalizedCommandScopeValue(profile.lastHostDeviceId)
        activeProjectHostIdentity = hostIdentity
        if let hostIdentity {
          UserDefaults.standard.set(hostIdentity, forKey: activeProjectHostIdentityKey)
        } else {
          UserDefaults.standard.removeObject(forKey: activeProjectHostIdentityKey)
        }
      }
    } else {
      UserDefaults.standard.removeObject(forKey: profileKey)
      UserDefaults.standard.removeObject(forKey: legacyDraftKey)
      activeHostProfile = nil
      hostName = nil
      hiddenProjectKeys = loadHiddenProjectKeys()
      activeProjectHostIdentity = nil
      UserDefaults.standard.removeObject(forKey: activeProjectHostIdentityKey)
    }
  }

  private func updateProfile(_ transform: (inout HostConnectionProfile) -> Void) {
    guard var profile = activeHostProfile ?? loadProfile() else { return }
    let previous = profile
    transform(&profile)
    guard !syncProfilesEquivalentIgnoringUpdatedAt(previous, profile) else { return }
    profile.updatedAt = syncDateFormatter.string(from: Date())
    saveProfile(profile)
  }

  private func syncProfilesEquivalentIgnoringUpdatedAt(
    _ lhs: HostConnectionProfile,
    _ rhs: HostConnectionProfile
  ) -> Bool {
    var left = lhs
    var right = rhs
    left.updatedAt = ""
    right.updatedAt = ""
    return left == right
  }

  private func syncProfilesEquivalentForPublishedState(
    _ lhs: HostConnectionProfile,
    _ rhs: HostConnectionProfile
  ) -> Bool {
    lhs.hostIdentity == rhs.hostIdentity
      && lhs.hostName == rhs.hostName
      && lhs.siteId == rhs.siteId
      && lhs.port == rhs.port
      && lhs.authKind == rhs.authKind
      && lhs.pairedDeviceId == rhs.pairedDeviceId
      && lhs.lastHostDeviceId == rhs.lastHostDeviceId
      && lhs.lastSuccessfulAddress == rhs.lastSuccessfulAddress
      && lhs.savedAddressCandidates == rhs.savedAddressCandidates
      && lhs.discoveredLanAddresses == rhs.discoveredLanAddresses
      && lhs.tailscaleAddress == rhs.tailscaleAddress
  }

  private func markSyncActivity(force: Bool = false) {
    let now = Date()
    if !force, let lastSyncAt, now.timeIntervalSince(lastSyncAt) < 2 {
      return
    }
    lastSyncAt = now
  }

  private func scheduleRemoteDbCursorProfilePersist(dbVersion: Int, cursorSite: String?) {
    pendingRemoteProfileDbVersion = max(pendingRemoteProfileDbVersion ?? 0, dbVersion)
    if let cursorSite {
      pendingRemoteProfileDbVersionBySite[cursorSite] = max(
        pendingRemoteProfileDbVersionBySite[cursorSite] ?? 0,
        dbVersion
      )
    }
    remoteCursorProfilePersistTask?.cancel()
    remoteCursorProfilePersistTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      guard let self, !Task.isCancelled else { return }
      self.persistPendingRemoteDbCursorProfile()
    }
  }

  private func persistPendingRemoteDbCursorProfile() {
    guard let dbVersion = pendingRemoteProfileDbVersion else { return }
    let dbVersionBySite = pendingRemoteProfileDbVersionBySite
    pendingRemoteProfileDbVersion = nil
    pendingRemoteProfileDbVersionBySite = [:]
    remoteCursorProfilePersistTask = nil

    updateProfile { profile in
      profile.lastRemoteDbVersion = max(profile.lastRemoteDbVersion, dbVersion)
      if !dbVersionBySite.isEmpty {
        var bySite = profile.remoteDbVersionBySite ?? [:]
        for (siteId, version) in dbVersionBySite {
          bySite[siteId] = max(bySite[siteId] ?? 0, version)
        }
        profile.remoteDbVersionBySite = bySite
      }
    }
  }

  private func loadRemoteCommandDescriptors() -> [SyncRemoteCommandDescriptor] {
    guard let data = UserDefaults.standard.data(forKey: remoteCommandDescriptorsKey),
          let descriptors = try? decoder.decode([SyncRemoteCommandDescriptor].self, from: data) else {
      return []
    }
    return descriptors
  }

  private func saveRemoteCommandDescriptors(_ descriptors: [SyncRemoteCommandDescriptor]) {
    remoteCommandDescriptors = descriptors
    if descriptors.isEmpty {
      UserDefaults.standard.removeObject(forKey: remoteCommandDescriptorsKey)
    } else if let data = try? encoder.encode(descriptors) {
      UserDefaults.standard.set(data, forKey: remoteCommandDescriptorsKey)
    }
  }

  private func normalizedProjectId(_ projectId: String?) -> String? {
    guard let value = projectId?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
      return nil
    }
    return value
  }

  private func normalizedHostStorageKey(_ hostId: String?) -> String? {
    guard let value = hostId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !value.isEmpty else {
      return nil
    }
    return value
  }

  private func activeHostStorageKey() -> String? {
    let profile = activeHostProfile
    return normalizedHostStorageKey(profile?.hostIdentity)
      ?? normalizedHostStorageKey(profile?.lastHostDeviceId)
      ?? normalizedHostStorageKey(profile?.lastSuccessfulAddress)
      ?? normalizedHostStorageKey(currentAddress)
      ?? normalizedHostStorageKey(hostName)
  }

  private func outboundStateMatchesActiveHost(_ hostId: String?) -> Bool {
    let currentHostId = activeHostStorageKey()
    let storedHostId = normalizedHostStorageKey(hostId)
    if let currentHostId {
      return storedHostId == currentHostId
    }
    return storedHostId == nil
  }

  private func outboundCursorStorageKey(projectId: String?, rootPath: String?, siteId: String, hostId: String?) -> String? {
    let normalizedSiteId = siteId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    guard !normalizedSiteId.isEmpty else { return nil }
    let normalizedId = normalizedProjectId(projectId)
    let normalizedRoot = normalizedProjectRoot(rootPath)
    guard normalizedId != nil || normalizedRoot != nil else { return nil }
    var parts = [
      "site=\(normalizedSiteId)",
      "project=\(normalizedId ?? "")",
      "root=\(normalizedRoot ?? "")",
    ]
    if let hostId = normalizedHostStorageKey(hostId) {
      parts.append("host=\(hostId)")
    }
    return parts.joined(separator: "|")
  }

  private func activeOutboundCursorStorageKey() -> String? {
    outboundCursorStorageKey(
      projectId: activeProjectId,
      rootPath: activeProjectRootPath,
      siteId: database.localSiteId(),
      hostId: activeHostStorageKey()
    )
  }

  private func loadOutboundSyncCursors() -> [String: OutboundSyncCursor] {
    guard let data = UserDefaults.standard.data(forKey: outboundSyncCursorsKey) else {
      return [:]
    }
    guard let decoded = try? decoder.decode([String: OutboundSyncCursor].self, from: data) else {
      UserDefaults.standard.removeObject(forKey: outboundSyncCursorsKey)
      return [:]
    }
    return decoded.filter { _, cursor in
      !cursor.siteId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        && cursor.lastAckedDbVersion >= 0
        && (cursor.hostId == nil || normalizedHostStorageKey(cursor.hostId) != nil)
        && (normalizedProjectId(cursor.projectId) != nil || normalizedProjectRoot(cursor.projectRootPath) != nil)
    }
  }

  private func saveOutboundSyncCursors(_ cursors: [String: OutboundSyncCursor]) {
    let capped = cappedOutboundSyncState(cursors) { $0.updatedAt }
    if capped.isEmpty {
      UserDefaults.standard.removeObject(forKey: outboundSyncCursorsKey)
    } else if let data = try? encoder.encode(capped) {
      UserDefaults.standard.set(data, forKey: outboundSyncCursorsKey)
    }
  }

  private func loadPendingOutboundChangesets() -> [String: PersistedOutboundChangeset] {
    guard let data = UserDefaults.standard.data(forKey: pendingOutboundChangesetsKey) else {
      return [:]
    }
    guard let decoded = try? decoder.decode([String: PersistedOutboundChangeset].self, from: data) else {
      UserDefaults.standard.removeObject(forKey: pendingOutboundChangesetsKey)
      return [:]
    }
    return decoded.filter { _, pending in
      let siteId = pending.siteId.trimmingCharacters(in: .whitespacesAndNewlines)
      let batchId = pending.payload.batchId.trimmingCharacters(in: .whitespacesAndNewlines)
      return !siteId.isEmpty
        && !batchId.isEmpty
        && (pending.hostId == nil || normalizedHostStorageKey(pending.hostId) != nil)
        && pending.payload.fromDbVersion >= 0
        && pending.payload.toDbVersion >= pending.payload.fromDbVersion
        && !pending.payload.changes.isEmpty
        && (normalizedProjectId(pending.projectId) != nil || normalizedProjectRoot(pending.projectRootPath) != nil)
    }
  }

  private func savePendingOutboundChangesets(_ changesets: [String: PersistedOutboundChangeset]) {
    let capped = cappedOutboundSyncState(changesets) { $0.updatedAt }
    if capped.isEmpty {
      UserDefaults.standard.removeObject(forKey: pendingOutboundChangesetsKey)
    } else if let data = try? encoder.encode(capped) {
      UserDefaults.standard.set(data, forKey: pendingOutboundChangesetsKey)
    }
  }

  private func cappedOutboundSyncState<Value>(
    _ entries: [String: Value],
    updatedAt: (Value) -> String
  ) -> [String: Value] {
    guard entries.count > outboundSyncStateMaxEntries else { return entries }
    return Dictionary(
      uniqueKeysWithValues: entries
        .sorted { left, right in
          let leftDate = updatedAt(left.value)
          let rightDate = updatedAt(right.value)
          if leftDate != rightDate {
            return leftDate > rightDate
          }
          return left.key < right.key
        }
        .prefix(outboundSyncStateMaxEntries)
        .map { ($0.key, $0.value) }
    )
  }

  private func matchingOutboundCursor(in cursors: [String: OutboundSyncCursor]) -> OutboundSyncCursor? {
    let siteId = database.localSiteId().trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let projectId = normalizedProjectId(activeProjectId)
    let rootPath = normalizedProjectRoot(activeProjectRootPath)
    guard !siteId.isEmpty, projectId != nil || rootPath != nil else { return nil }

    if let key = activeOutboundCursorStorageKey(), let exact = cursors[key] {
      return exact
    }

    return cursors.values
      .filter { cursor in
        cursor.siteId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == siteId
          && outboundStateMatchesActiveHost(cursor.hostId)
          && (
            (rootPath != nil && normalizedProjectRoot(cursor.projectRootPath) == rootPath)
              || (projectId != nil && normalizedProjectId(cursor.projectId) == projectId)
          )
      }
      .max { left, right in
        if left.updatedAt != right.updatedAt {
          return left.updatedAt < right.updatedAt
        }
        return left.lastAckedDbVersion < right.lastAckedDbVersion
      }
  }

  private func matchingPendingOutboundChangeset(in changesets: [String: PersistedOutboundChangeset]) -> PersistedOutboundChangeset? {
    let siteId = database.localSiteId().trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let projectId = normalizedProjectId(activeProjectId)
    let rootPath = normalizedProjectRoot(activeProjectRootPath)
    guard !siteId.isEmpty, projectId != nil || rootPath != nil else { return nil }

    if let key = activeOutboundCursorStorageKey(), let exact = changesets[key] {
      return exact
    }

    return changesets.values
      .filter { pending in
        pending.siteId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == siteId
          && outboundStateMatchesActiveHost(pending.hostId)
          && (
            (rootPath != nil && normalizedProjectRoot(pending.projectRootPath) == rootPath)
              || (projectId != nil && normalizedProjectId(pending.projectId) == projectId)
          )
      }
      .max { left, right in
        if left.updatedAt != right.updatedAt {
          return left.updatedAt < right.updatedAt
        }
        return left.payload.toDbVersion < right.payload.toDbVersion
      }
  }

  private func persistOutboundCursorForActiveProject(_ dbVersion: Int) {
    guard let key = activeOutboundCursorStorageKey() else { return }
    var cursors = loadOutboundSyncCursors()
    cursors[key] = OutboundSyncCursor(
      projectId: normalizedProjectId(activeProjectId),
      projectRootPath: normalizedProjectRoot(activeProjectRootPath),
      hostId: activeHostStorageKey(),
      siteId: database.localSiteId().trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
      lastAckedDbVersion: max(0, dbVersion),
      updatedAt: syncDateFormatter.string(from: Date())
    )
    saveOutboundSyncCursors(cursors)
  }

  private func persistPendingOutboundChangesetForActiveProject(_ pending: PendingOutboundChangeset) {
    guard let key = activeOutboundCursorStorageKey() else { return }
    var changesets = loadPendingOutboundChangesets()
    changesets[key] = PersistedOutboundChangeset(
      projectId: normalizedProjectId(activeProjectId),
      projectRootPath: normalizedProjectRoot(activeProjectRootPath),
      hostId: activeHostStorageKey(),
      siteId: database.localSiteId().trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
      payload: pending.payload,
      retryCount: pending.retryCount,
      updatedAt: syncDateFormatter.string(from: Date())
    )
    savePendingOutboundChangesets(changesets)
  }

  private func clearPendingOutboundChangesetForActiveProject() {
    let siteId = database.localSiteId().trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    let projectId = normalizedProjectId(activeProjectId)
    let rootPath = normalizedProjectRoot(activeProjectRootPath)
    guard !siteId.isEmpty, projectId != nil || rootPath != nil else { return }
    var changesets = loadPendingOutboundChangesets()
    if let key = activeOutboundCursorStorageKey() {
      changesets.removeValue(forKey: key)
    }
    changesets = changesets.filter { _, pending in
      let sameSite = pending.siteId.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == siteId
      let sameHost = outboundStateMatchesActiveHost(pending.hostId)
      let sameProject = projectId != nil && normalizedProjectId(pending.projectId) == projectId
      let sameRoot = rootPath != nil && normalizedProjectRoot(pending.projectRootPath) == rootPath
      return !(sameHost && sameSite && (sameProject || sameRoot))
    }
    savePendingOutboundChangesets(changesets)
  }

  private func loadOutboundCursorVersionForActiveProject(defaultVersion: Int) -> Int {
    let currentDbVersion = max(0, database.currentDbVersion())
    guard activeOutboundCursorStorageKey() != nil else {
      return min(max(0, defaultVersion), currentDbVersion)
    }
    guard let cursor = matchingOutboundCursor(in: loadOutboundSyncCursors()) else {
      let initialVersion = min(max(0, defaultVersion), currentDbVersion)
      persistOutboundCursorForActiveProject(initialVersion)
      return initialVersion
    }
    let persistedVersion = max(0, cursor.lastAckedDbVersion)
    if persistedVersion > currentDbVersion {
      persistOutboundCursorForActiveProject(currentDbVersion)
      return currentDbVersion
    }
    return persistedVersion
  }

  private func resetOutboundCursorStateForActiveProject(defaultVersion: Int? = nil) {
    let currentDbVersion = max(0, database.currentDbVersion())
    outboundLocalDbVersion = loadOutboundCursorVersionForActiveProject(
      defaultVersion: defaultVersion ?? currentDbVersion
    )
    guard let persisted = matchingPendingOutboundChangeset(in: loadPendingOutboundChangesets()) else {
      pendingOutboundChangeset = nil
      return
    }
    guard persisted.payload.toDbVersion <= currentDbVersion else {
      clearPendingOutboundChangesetForActiveProject()
      pendingOutboundChangeset = nil
      return
    }
    pendingOutboundChangeset = PendingOutboundChangeset(
      payload: persisted.payload,
      sentAt: 0,
      retryCount: max(0, persisted.retryCount)
    )
    outboundLocalDbVersion = min(outboundLocalDbVersion, persisted.payload.fromDbVersion)
  }

  private func advanceOutboundCursorForActiveProject(
    to dbVersion: Int,
    persistImmediately: Bool = true
  ) {
    outboundLocalDbVersion = max(outboundLocalDbVersion, max(0, dbVersion))
    if persistImmediately {
      outboundCursorPersistTask?.cancel()
      outboundCursorPersistTask = nil
      pendingOutboundCursorPersistVersion = nil
      persistOutboundCursorForActiveProject(outboundLocalDbVersion)
    } else {
      scheduleDeferredOutboundCursorPersist(outboundLocalDbVersion)
    }
  }

  private func scheduleDeferredOutboundCursorPersist(_ dbVersion: Int) {
    pendingOutboundCursorPersistVersion = max(pendingOutboundCursorPersistVersion ?? 0, dbVersion)
    outboundCursorPersistTask?.cancel()
    outboundCursorPersistTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      guard let self, !Task.isCancelled else { return }
      let dbVersion = self.pendingOutboundCursorPersistVersion
      self.pendingOutboundCursorPersistVersion = nil
      self.outboundCursorPersistTask = nil
      if let dbVersion {
        self.persistOutboundCursorForActiveProject(dbVersion)
      }
    }
  }

  private func prepareOutboundStateForProjectScopeChange() {
    guard activeOutboundCursorStorageKey() != nil else {
      pendingOutboundChangeset = nil
      return
    }
    if let pending = pendingOutboundChangeset {
      persistPendingOutboundChangesetForActiveProject(pending)
      pendingOutboundChangeset = nil
      return
    }

    let currentDbVersion = database.currentDbVersion()
    guard currentDbVersion > outboundLocalDbVersion else {
      pendingOutboundChangeset = nil
      return
    }
    let localSiteId = database.localSiteId()
    let changes = database.exportChangesSince(version: outboundLocalDbVersion).filter { $0.siteId == localSiteId }
    guard !changes.isEmpty else {
      advanceOutboundCursorForActiveProject(to: currentDbVersion)
      pendingOutboundChangeset = nil
      return
    }

    let pending = PendingOutboundChangeset(
      payload: SyncChangesetBatchPayload(
        batchId: makeRequestId(),
        reason: "relay",
        fromDbVersion: outboundLocalDbVersion,
        toDbVersion: currentDbVersion,
        changes: changes
      ),
      sentAt: 0,
      retryCount: 0
    )
    persistPendingOutboundChangesetForActiveProject(pending)
    pendingOutboundChangeset = nil
  }

  private func commandDescriptor(for action: String) -> SyncRemoteCommandDescriptor? {
    remoteCommandDescriptors.first(where: { $0.action == action })
  }

  private func commandPolicy(for action: String) -> SyncRemoteCommandPolicy? {
    commandDescriptor(for: action)?.policy
  }

  func supportsRemoteAction(_ action: String) -> Bool {
    commandDescriptor(for: action) != nil
  }

  func isRemoteActionQueueable(_ action: String) -> Bool {
    commandPolicy(for: action)?.queueable == true
  }

  private func normalizeOpenLaneId(_ laneId: String) -> String? {
    let normalized = laneId.trimmingCharacters(in: .whitespacesAndNewlines)
    return normalized.isEmpty ? nil : normalized
  }

  private func setAutoReconnectPausedByUser(_ paused: Bool) {
    autoReconnectPausedByUser = paused
    UserDefaults.standard.set(paused, forKey: autoReconnectPausedKey)
  }

  @discardableResult
  private func beginConnectAttempt() -> UInt64 {
    connectAttemptGeneration &+= 1
    return connectAttemptGeneration
  }

  private func isCurrentConnectAttempt(_ generation: UInt64) -> Bool {
    connectAttemptGeneration == generation
  }

  private func trackedOpenLaneIds() -> [String] {
    openLaneReferenceCounts
      .filter { $0.value > 0 }
      .map(\.key)
      .sorted()
  }

  private func scheduleLanePresenceHeartbeatIfNeeded() {
    lanePresenceHeartbeatTask?.cancel()
    lanePresenceHeartbeatTask = nil
    guard canSendLiveRequests(),
          supportsRemoteAction("lanes.presence.announce"),
          !trackedOpenLaneIds().isEmpty else { return }
    lanePresenceHeartbeatTask = Task { @MainActor [weak self] in
      while let self, !Task.isCancelled {
        try? await Task.sleep(nanoseconds: SyncSocketTiming.lanePresenceHeartbeatNanoseconds)
        guard !Task.isCancelled else { return }
        await self.reannounceTrackedOpenLanes()
      }
    }
  }

  private func restoreTrackedOpenLanesAfterReconnect() async {
    scheduleLanePresenceHeartbeatIfNeeded()
    guard canSendLiveRequests(),
          supportsRemoteAction("lanes.presence.announce") else { return }
    let laneIds = trackedOpenLaneIds()
    guard !laneIds.isEmpty else { return }
    await reannounceTrackedOpenLanes()
  }

  private func reannounceTrackedOpenLanes() async {
    guard canSendLiveRequests(),
          supportsRemoteAction("lanes.presence.announce") else {
      scheduleLanePresenceHeartbeatIfNeeded()
      return
    }
    for laneId in trackedOpenLaneIds() {
      await sendLanePresenceCommand(
        action: "lanes.presence.announce",
        laneId: laneId,
        refreshSnapshots: false
      )
    }
  }

  private func sendLanePresenceCommand(
    action: String,
    laneId: String,
    refreshSnapshots: Bool
  ) async {
    guard canSendLiveRequests(), supportsRemoteAction(action) else {
      scheduleLanePresenceHeartbeatIfNeeded()
      return
    }
    do {
      _ = try await performCommandRequest(
        action: action,
        args: ["laneId": laneId],
        disconnectOnTimeout: false,
        timeoutMessage: "The machine did not acknowledge lane presence in time."
      )
      if refreshSnapshots {
        try? await refreshLaneSnapshots()
      }
    } catch {
      syncConnectLog.info(
        "lane presence action=\(action, privacy: .public) lane=\(laneId, privacy: .public) error=\(String(describing: error), privacy: .public)"
      )
    }
    scheduleLanePresenceHeartbeatIfNeeded()
  }

  private func deduplicatedAddresses(_ addresses: [String]) -> [String] {
    deduplicatedStrings(addresses)
  }

  private func deduplicatedStrings(_ values: [String]) -> [String] {
    var seen = Set<String>()
    return values
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .filter { seen.insert($0).inserted }
  }

  private func connectableAddresses(from addresses: [String]) -> [String] {
    // The pairing secret is sent over ws:// (plaintext) immediately after
    // `openSocket`, so only allow addresses we can trust on an unencrypted
    // transport — loopback, RFC1918 LAN ranges, link-local, and Tailscale CGNAT.
    addresses.filter { syncCanAttemptPlaintextWebSocket($0) }
  }

  func syncCanAttemptPlaintextWebSocket(_ address: String) -> Bool {
    let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty { return false }
    if let schemeRange = trimmed.range(of: "://") {
      let scheme = trimmed[..<schemeRange.lowerBound].lowercased()
      // wss:// is end-to-end encrypted; anything non-ws beyond that we don't know
      // how to speak, so treat it conservatively.
      if scheme == "wss" { return true }
      if scheme != "ws" && scheme != "http" { return false }
    }

    let host = syncNormalizedRouteHost(trimmed)
    if host.isEmpty { return false }

    if host == "localhost" || host.hasSuffix(".localhost") { return true }
    if host.hasSuffix(".local") { return true } // Bonjour / mDNS
    if syncIsTailscaleRoute(host) { return true } // Tailscale IP, MagicDNS, or Serve aliases

    if let v4 = IPv4Address(host) {
      let bytes = v4.rawValue
      guard bytes.count == 4 else { return false }
      let a = bytes[0], b = bytes[1]
      if a == 127 { return true } // loopback
      if a == 10 { return true } // 10.0.0.0/8
      if a == 172 && (16...31).contains(b) { return true } // 172.16.0.0/12
      if a == 192 && b == 168 { return true } // 192.168.0.0/16
      if a == 169 && b == 254 { return true } // link-local
      if a == 100 && (64...127).contains(b) { return true } // Tailscale CGNAT 100.64.0.0/10
      return false
    }

    if let v6 = IPv6Address(host) {
      let bytes = v6.rawValue
      guard bytes.count == 16 else { return false }
      // ::1 loopback
      if bytes == Data([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) { return true }
      // fc00::/7 unique-local
      if (bytes[0] & 0xfe) == 0xfc { return true }
      // fe80::/10 link-local
      if bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80 { return true }
      return false
    }

    return false
  }

  private func noConnectableAddressError() -> NSError {
    NSError(
      domain: "ADE",
      code: 24,
      userInfo: [
        NSLocalizedDescriptionKey: "No ADE machine address is available. Choose a discovered machine or enter the address manually.",
      ]
    )
  }

  private func addressCandidateKind(
    _ address: String,
    profile: HostConnectionProfile?,
    explicitTailscaleAddress: String?
  ) -> String {
    let normalized = address.trimmingCharacters(in: .whitespacesAndNewlines)
    if normalized == "127.0.0.1" || normalized == "::1" {
      return "loopback"
    }
    if syncIsTailscaleRoute(normalized) ||
        explicitTailscaleAddress == normalized ||
        profile?.tailscaleAddress == normalized {
      return "tailscale"
    }
    if profile?.lastSuccessfulAddress == normalized ||
        profile?.savedAddressCandidates.contains(normalized) == true {
      return "saved"
    }
    if profile?.discoveredLanAddresses.contains(normalized) == true {
      return "lan"
    }
    let octets = normalized.split(separator: ".")
    if octets.count == 4,
       let first = octets.first.flatMap({ Int($0) }),
       let second = octets.dropFirst().first.flatMap({ Int($0) }),
       first == 10 || (first == 192 && second == 168) || (first == 172 && (16...31).contains(second)) {
      return "lan"
    }
    return "manual"
  }

  private func preferredPairedAddress(
    host: String,
    hostIdentity: String?,
    hostName: String?,
    candidateAddresses: [String]
  ) -> [String] {
    guard let profile = activeHostProfile,
          let lastSuccessfulAddress = profile.lastSuccessfulAddress?.trimmingCharacters(in: .whitespacesAndNewlines),
          !lastSuccessfulAddress.isEmpty else {
      return []
    }

    let identityMatches = hostIdentity.flatMap { identity in
      let trimmed = identity.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return nil }
      return profile.hostIdentity == trimmed
    } ?? false
    let nameMatches = hostName.flatMap { name in
      let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty else { return nil }
      return profile.hostName?.localizedCaseInsensitiveCompare(trimmed) == .orderedSame
    } ?? false
    guard identityMatches || nameMatches else { return [] }

    let candidates = Set(deduplicatedAddresses(
      candidateAddresses
      + profile.savedAddressCandidates
      + profile.discoveredLanAddresses
      + [host]
      + (profile.tailscaleAddress.map { [$0] } ?? [])
    ))
    return candidates.contains(lastSuccessfulAddress) ? [lastSuccessfulAddress] : []
  }

  private func matchesDiscoveredHost(_ discovered: DiscoveredSyncHost, profile: HostConnectionProfile) -> Bool {
    let knownAddresses = Set(
      profile.savedAddressCandidates
      + profile.discoveredLanAddresses
      + (profile.lastSuccessfulAddress.map { [$0] } ?? [])
      + (profile.tailscaleAddress.map { [$0] } ?? [])
    )
    let discoveredAddresses = Set(
      discovered.addresses
      + (discovered.tailscaleAddress.map { [$0] } ?? [])
    )
    if !knownAddresses.isDisjoint(with: discoveredAddresses) {
      return true
    }

    if let hostIdentity = profile.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines),
       !hostIdentity.isEmpty {
      let discoveredIdentity = discovered.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard !discoveredIdentity.isEmpty else {
        // Older / partial Bonjour rows can briefly miss TXT identity fields.
        // Fall back to host name only for that case rather than matching every
        // anonymous row on the subnet.
        if let hostName = profile.hostName?.trimmingCharacters(in: .whitespacesAndNewlines),
           !hostName.isEmpty {
          return discovered.hostName.localizedCaseInsensitiveCompare(hostName) == .orderedSame
        }
        return false
      }
      return discoveredIdentity == hostIdentity
    }

    if let hostName = profile.hostName?.trimmingCharacters(in: .whitespacesAndNewlines),
       !hostName.isEmpty {
      return discovered.hostName.localizedCaseInsensitiveCompare(hostName) == .orderedSame
    }

    return false
  }

  private func preferTailnetForUpcomingReconnect() {
    preferTailnetReconnectUntil = Date().addingTimeInterval(20)
  }

  private func shouldPreferTailnetReconnect() -> Bool {
    guard let until = preferTailnetReconnectUntil else { return false }
    if until > Date() { return true }
    preferTailnetReconnectUntil = nil
    return false
  }

  private func prioritizedAddresses(for profile: HostConnectionProfile) -> [String] {
    let preferTailnet = shouldPreferTailnetReconnect()
    let matchingDiscovery = discoveredHosts.filter { host in
      matchesDiscoveredHost(host, profile: profile)
    }

    let liveLan = matchingDiscovery.flatMap(\.addresses)
    let liveTailscale = matchingDiscovery.compactMap(\.tailscaleAddress)
    let liveSet = Set(liveLan + liveTailscale)
    let liveLastSuccessful = profile.lastSuccessfulAddress.flatMap { address in
      liveSet.contains(address) ? [address] : nil
    } ?? []
    let liveLastSuccessfulTailnet = liveLastSuccessful.filter(syncIsTailscaleRoute)
    let liveLastSuccessfulLan = liveLastSuccessful.filter { !syncIsTailscaleRoute($0) }
    let savedProfileTailnet = profile.tailscaleAddress.map { [$0] } ?? []
    let savedTailnet = profile.savedAddressCandidates.filter(syncIsTailscaleRoute)
    let savedLastSuccessfulTailnet = profile.lastSuccessfulAddress.flatMap { address in
      syncIsTailscaleRoute(address) ? [address] : nil
    } ?? []
    let savedTailnetFallback = savedProfileTailnet + savedTailnet + savedLastSuccessfulTailnet
    // Prefer addresses we see RIGHT NOW on the network over anything we have
    // cached from previous sessions. If the user changed subnets, stale
    // entries would otherwise consume the first few attempts (each with its
    // own timeout) before we finally try the correct current IP. Only fall
    // back to cached saved candidates if no live discovery is available.
    let prioritizedLive = preferTailnet
      ? liveLastSuccessfulTailnet + liveTailscale + savedTailnetFallback + liveLastSuccessfulLan + liveLan
      : liveLastSuccessful + liveLan + liveTailscale
    let savedLan = profile.savedAddressCandidates.filter { !syncIsTailscaleRoute($0) }
    let fallbackLastSuccessful = liveLastSuccessful.isEmpty ? (profile.lastSuccessfulAddress.map { [$0] } ?? []) : []
    let fallbackSaved: [String]
    if preferTailnet {
      fallbackSaved = savedTailnetFallback
        + fallbackLastSuccessful
        + savedLan
        + profile.discoveredLanAddresses
    } else {
      fallbackSaved = fallbackLastSuccessful
        + savedLan
        + profile.discoveredLanAddresses
        + savedProfileTailnet
        + savedTailnet
    }
    return deduplicatedAddresses(prioritizedLive + fallbackSaved)
  }

  private func automaticReconnectAddresses(for profile: HostConnectionProfile) -> [String] {
    let preferTailnet = shouldPreferTailnetReconnect() || shouldPreferTailnetForUserReconnect(profile)
    let matchingDiscovery = discoveredHosts.filter { host in
      matchesDiscoveredHost(host, profile: profile)
    }
    guard !matchingDiscovery.isEmpty else {
      let savedTailnet = profile.savedAddressCandidates.filter(syncIsTailscaleRoute)
      let lastSuccessfulTailnet = profile.lastSuccessfulAddress.flatMap { address in
        syncIsTailscaleRoute(address) ? [address] : nil
      } ?? []
      return deduplicatedAddresses(
        (preferTailnet ? [] : lastSuccessfulTailnet)
        + (profile.tailscaleAddress.map { [$0] } ?? [])
        + savedTailnet
        + (preferTailnet ? lastSuccessfulTailnet : [])
      )
    }

    let liveLan = matchingDiscovery.flatMap(\.addresses)
    let liveTailscale = matchingDiscovery.compactMap(\.tailscaleAddress)
    let liveSet = Set(liveLan + liveTailscale)
    let liveLastSuccessful = profile.lastSuccessfulAddress.flatMap { address in
      liveSet.contains(address) ? [address] : nil
    } ?? []
    let liveLastSuccessfulTailnet = liveLastSuccessful.filter(syncIsTailscaleRoute)
    let liveLastSuccessfulLan = liveLastSuccessful.filter { !syncIsTailscaleRoute($0) }
    let savedProfileTailnet = profile.tailscaleAddress.map { [$0] } ?? []
    let savedTailnet = profile.savedAddressCandidates.filter(syncIsTailscaleRoute)
    let savedLastSuccessfulTailnet = profile.lastSuccessfulAddress.flatMap { address in
      syncIsTailscaleRoute(address) ? [address] : nil
    } ?? []
    let savedTailnetFallback = savedProfileTailnet + savedTailnet + savedLastSuccessfulTailnet

    let prioritizedLive = preferTailnet
      ? liveLastSuccessfulTailnet + liveTailscale + savedTailnetFallback + liveLastSuccessfulLan + liveLan
      : liveLastSuccessful + liveLan + liveTailscale + savedTailnetFallback
    return deduplicatedAddresses(prioritizedLive)
  }

  private func connectUsingProfile(
    _ profile: HostConnectionProfile,
    token: String,
    connectAttemptGeneration: UInt64,
    preferLiveCandidatesOnly: Bool,
    publishConnecting: Bool
  ) async throws -> (host: String, port: Int) {
    var lastFailure: Error?
    let rawAddresses = preferLiveCandidatesOnly
      ? automaticReconnectAddresses(for: profile)
      : prioritizedAddresses(for: profile)
    let addresses = connectableAddresses(from: rawAddresses)
    let portCandidates = syncConnectPortCandidates(
      primaryPort: profile.port,
      addresses: addresses,
      allowFallbackSweep: !preferLiveCandidatesOnly
    )
    syncConnectLog.info(
      "ADE_SYNC_TRACE reconnect candidates preferLiveOnly=\(preferLiveCandidatesOnly) path=\(syncLogPathSummary(self.lastNetworkPathSnapshot), privacy: .public) profile=\(syncLogProfileSummary(profile), privacy: .public) raw=[\(syncLogAddressList(rawAddresses), privacy: .public)] ports=[\(portCandidates.map(String.init).joined(separator: ","), privacy: .public)] connectable=[\(syncLogAddressList(addresses), privacy: .public)]"
    )
    guard !addresses.isEmpty else {
      if rawAddresses.isEmpty {
        throw NSError(domain: "ADE", code: 18, userInfo: [NSLocalizedDescriptionKey: "No saved address is available for this machine."])
      }
      throw noConnectableAddressError()
    }

    let racedAddresses = await syncRaceAddressCandidates(
      addresses: addresses,
      port: portCandidates.first ?? profile.port
    )
    if racedAddresses != addresses {
      syncConnectLog.info(
        "ADE_SYNC_TRACE reconnect probe reorder raced=[\(syncLogAddressList(racedAddresses), privacy: .public)]"
      )
    }

    for attempt in syncConnectionEndpointAttempts(addresses: racedAddresses, ports: portCandidates) {
      guard isCurrentConnectAttempt(connectAttemptGeneration) else {
        throw CancellationError()
      }
      let kind = addressCandidateKind(attempt.address, profile: profile, explicitTailscaleAddress: nil)
      syncConnectLog.info("ADE_SYNC_TRACE reconnect attempt host=\(attempt.address, privacy: .public) port=\(attempt.port) kind=\(kind, privacy: .public)")
      do {
        try await openSocket(
          host: attempt.address,
          port: attempt.port,
          connectAttemptGeneration: connectAttemptGeneration,
          publishConnecting: publishConnecting
        )
        try await hello(
          host: attempt.address,
          port: attempt.port,
          token: token,
          authKind: profile.authKind,
          pairedDeviceId: profile.pairedDeviceId,
          expectedHostIdentity: profile.hostIdentity,
          connectAttemptGeneration: connectAttemptGeneration
        )
        guard isCurrentConnectAttempt(connectAttemptGeneration) else {
          throw CancellationError()
        }
        syncConnectLog.info("ADE_SYNC_TRACE reconnect success host=\(attempt.address, privacy: .public) port=\(attempt.port)")
        return (host: attempt.address, port: attempt.port)
      } catch {
        let reconnectError = errorByMarkingAmbiguousRouteAuthFailure(error, attemptedAddress: attempt.address)
        syncConnectLog.info("ADE_SYNC_TRACE reconnect failure host=\(attempt.address, privacy: .public) port=\(attempt.port) error=\(syncLogErrorSummary(reconnectError), privacy: .public)")
        lastFailure = reconnectError
        if shouldInvalidateSavedPairing(for: reconnectError) {
          forgetHost()
          throw reconnectError
        }
        // Tear down this attempt's socket and keep iterating through the
        // remaining ports and addresses. Only surface an error if every
        // candidate fails.
        teardownSocket()
        continue
      }
    }

    throw lastFailure ?? NSError(domain: "ADE", code: 19, userInfo: [NSLocalizedDescriptionKey: "Unable to reach the saved ADE machine."])
  }

  private func handleReconnectFailure(
    _ error: Error,
    shouldScheduleRetry: Bool,
    phase: SyncDomainPhase,
    connectionState: RemoteConnectionState
  ) {
    if shouldInvalidateSavedPairing(for: error) {
      forgetHost()
      return
    }
    let friendlyMessage = SyncUserFacingError.message(for: error)
    lastError = friendlyMessage
    self.connectionState = connectionState
    if phase == .failed {
      setDomainStatus(SyncDomain.allCases, phase: .failed, error: friendlyMessage)
    } else {
      setDomainStatus(SyncDomain.allCases, phase: .disconnected)
    }
    if shouldScheduleRetry {
      scheduleReconnectIfNeeded(after: reconnectDelay())
    } else {
      cancelReconnectLoop()
    }
  }

  private func reconnectDelay() -> UInt64 {
    reconnectState.nextDelayNanoseconds()
  }

  private func scheduleReconnectIfNeeded(after delayNanoseconds: UInt64) {
    let profile = loadProfile()
    guard allowAutoReconnect, !autoReconnectPausedByUser, profile != nil, tokenForProfile(profile) != nil else { return }
    // Once the fast attempt budget is spent, surface the "can't reach this
    // machine" state but keep a quiet slow heartbeat trying in the background.
    // A paired machine routinely comes back well after the first minute — a
    // WiFi→cellular handoff settling, the brain restarting after an update, a
    // Tailscale route appearing — and the phone must reconnect on its own
    // without the user babysitting a reconnect button.
    if reconnectState.isExhausted {
      enterUnreachableTerminalState(for: profile)
      scheduleSlowReconnectHeartbeat()
      return
    }
    reconnectTask?.cancel()
    reconnectTask = Task { @MainActor in
      try? await Task.sleep(nanoseconds: delayNanoseconds)
      guard !Task.isCancelled else { return }
      await reconnectIfPossible()
    }
  }

  /// Slow background retry (~30-40s cadence with jitter) that outlives the
  /// fast 1s→16s burst. Each beat opens the budget for exactly one attempt;
  /// a failed attempt re-exhausts and reschedules through
  /// scheduleReconnectIfNeeded, while an attempt that found no route yet
  /// (waiting on live discovery) reschedules itself here.
  private func scheduleSlowReconnectHeartbeat() {
    reconnectTask?.cancel()
    reconnectTask = Task { @MainActor in
      let jitter = UInt64.random(in: 0...10_000_000_000)
      try? await Task.sleep(nanoseconds: 30_000_000_000 + jitter)
      guard !Task.isCancelled else { return }
      reconnectState.allowOneSlowAttempt()
      await reconnectIfPossible()
      guard !Task.isCancelled else { return }
      if autoReconnectAwaitingLiveDiscovery {
        scheduleSlowReconnectHeartbeat()
      }
    }
  }

  /// Flip to the terminal unreachable state: stop the reconnect loop, clear the
  /// in-flight / awaiting flags so nothing silently re-arms, and surface a
  /// friendly `connectionState = .error` (which maps to
  /// `SyncTransportHealth.unreachable` and lights the header error banner).
  private func enterUnreachableTerminalState(for profile: HostConnectionProfile?) {
    reconnectTask?.cancel()
    reconnectTask = nil
    networkPathReconnectTask?.cancel()
    networkPathReconnectTask = nil
    reconnectConnectInFlight = false
    autoReconnectAwaitingLiveDiscovery = false
    let machineName = syncTrimmedNonEmptyName(profile?.hostName)
      ?? syncTrimmedNonEmptyName(hostName)
      ?? "this machine"
    lastError = "Can't reach \(machineName)."
    connectionState = .error
    setDomainStatus(SyncDomain.allCases, phase: .failed, error: lastError)
  }

  private func syncTrimmedNonEmptyName(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
      return nil
    }
    return trimmed
  }

  private func cancelReconnectLoop() {
    reconnectState.reset()
    reconnectTask?.cancel()
    reconnectTask = nil
    networkPathReconnectTask?.cancel()
    networkPathReconnectTask = nil
  }

  private func shouldInvalidateSavedPairing(for error: Error) -> Bool {
    let nsError = error as NSError
    if nsError.userInfo[syncAmbiguousRouteAuthFailureKey] as? Bool == true {
      return false
    }
    return nsError.userInfo["ADEErrorCode"] as? String == "auth_failed"
  }

  private func isAmbiguousSavedRoute(_ attemptedAddress: String) -> Bool {
    let host = syncNormalizedRouteHost(attemptedAddress)
    if host.isEmpty { return false }
    if syncIsTailnetDiscoveryHost(host) { return true }
    if host == "localhost" || host.hasSuffix(".localhost") || host.hasSuffix(".local") { return true }
    if let v4 = IPv4Address(host) {
      let bytes = v4.rawValue
      guard bytes.count == 4 else { return false }
      let a = bytes[0], b = bytes[1]
      return a == 127
        || a == 10
        || (a == 172 && (16...31).contains(b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254)
    }
    if let v6 = IPv6Address(host) {
      let bytes = v6.rawValue
      guard bytes.count == 16 else { return false }
      if bytes == Data([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]) { return true }
      if (bytes[0] & 0xfe) == 0xfc { return true }
      if bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80 { return true }
    }
    return false
  }

  private func errorByMarkingAmbiguousRouteAuthFailure(_ error: Error, attemptedAddress: String) -> Error {
    let nsError = error as NSError
    guard nsError.userInfo["ADEErrorCode"] as? String == "auth_failed",
          isAmbiguousSavedRoute(attemptedAddress) else {
      return error
    }
    var userInfo = nsError.userInfo
    userInfo[syncAmbiguousRouteAuthFailureKey] = true
    return NSError(domain: nsError.domain, code: nsError.code, userInfo: userInfo)
  }

  private func profileByApplyingDiscoveredRoutes(
    _ profile: HostConnectionProfile,
    matching: [DiscoveredSyncHost]
  ) -> HostConnectionProfile {
    var next = profile
    let liveLanAddresses = deduplicatedAddresses(matching.flatMap(\.addresses))
    let liveTailscaleAddress = matching.compactMap(\.tailscaleAddress).first ?? profile.tailscaleAddress
    next.discoveredLanAddresses = liveLanAddresses
    next.tailscaleAddress = liveTailscaleAddress
    if let livePort = matching.map(\.port).first(where: { $0 > 0 }) {
      next.port = livePort
    }
    next.savedAddressCandidates = Array(
      deduplicatedAddresses(
        (profile.lastSuccessfulAddress.map { [$0] } ?? [])
        + liveLanAddresses
        + (liveTailscaleAddress.map { [$0] } ?? [])
        + profile.savedAddressCandidates
      ).prefix(6)
    )
    if next.hostIdentity == nil {
      next.hostIdentity = matching.compactMap(\.hostIdentity).first
    }
    if next.hostName == nil {
      next.hostName = matching.first?.hostName
    }
    return next
  }

  /// The stable machine key used to group discovered hosts into one visible row.
  /// `siteId` is intentionally not part of this key: it is a per-connection
  /// database/runtime detail, while the phone pairs with a computer.
  private func syncMachineIdentityKey(_ host: DiscoveredSyncHost) -> String? {
    if let identity = syncNonEmpty(host.hostIdentity) {
      return "machine:\(identity.lowercased())"
    }
    return nil
  }

  private func syncLooksLikeIpAddress(_ value: String) -> Bool {
    let host = syncNormalizedRouteHost(value)
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
    if host.contains(":") { return true }
    let parts = host.split(separator: ".")
    return parts.count == 4 && parts.allSatisfy { UInt8(String($0)) != nil }
  }

  private func syncDiscoveredHostWithMachineId(_ host: DiscoveredSyncHost) -> DiscoveredSyncHost {
    guard let identity = syncNonEmpty(host.hostIdentity), host.id != identity else { return host }
    var next = host
    next.id = identity
    return next
  }

  private func syncNonEmpty(_ value: String?) -> String? {
    guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
      return nil
    }
    return trimmed
  }

  private func applyDiscoveredHosts(_ hosts: [DiscoveredSyncHost]) {
    // Group by computer, not by per-project/per-DB runtime identity. The same
    // machine may advertise multiple project ports or transports; the phone
    // should show and save one machine row with all usable routes.
    var mergedByMachine: [String: DiscoveredSyncHost] = [:]
    var orderedMachineKeys: [String] = []
    var noMachineKey: [DiscoveredSyncHost] = []
    for host in hosts {
      guard let machineKey = syncMachineIdentityKey(host) else {
        noMachineKey.append(host)
        continue
      }
      if let existing = mergedByMachine[machineKey] {
        let preferred = host.lastResolvedAt >= existing.lastResolvedAt ? host : existing
        let fallback = host.lastResolvedAt >= existing.lastResolvedAt ? existing : host
        let mergedIdentity = syncNonEmpty(preferred.hostIdentity) ?? syncNonEmpty(fallback.hostIdentity)
        let addresses = deduplicatedAddresses(preferred.addresses + fallback.addresses)
        let tailscale = preferred.tailscaleAddress ?? fallback.tailscaleAddress
        let port = preferred.port > 0 ? preferred.port : fallback.port
        let mergedName = preferred.hostName.isEmpty ? fallback.hostName : preferred.hostName
        mergedByMachine[machineKey] = DiscoveredSyncHost(
          id: mergedIdentity ?? existing.id,
          serviceName: existing.serviceName,
          hostName: mergedName,
          hostIdentity: mergedIdentity,
          siteId: syncNonEmpty(preferred.siteId) ?? syncNonEmpty(fallback.siteId),
          port: port,
          addresses: addresses,
          tailscaleAddress: tailscale,
          runtimeName: syncNonEmpty(preferred.runtimeName) ?? syncNonEmpty(fallback.runtimeName),
          runtimeKind: preferred.runtimeKind ?? fallback.runtimeKind,
          runtimeVersion: preferred.runtimeVersion ?? fallback.runtimeVersion,
          projectIds: deduplicatedStrings(preferred.projectIds + fallback.projectIds),
          projectNames: deduplicatedStrings(preferred.projectNames + fallback.projectNames),
          projectCount: preferred.projectCount ?? fallback.projectCount,
          pairingPinConfigured: preferred.pairingPinConfigured ?? fallback.pairingPinConfigured,
          lastResolvedAt: host.lastResolvedAt > existing.lastResolvedAt ? host.lastResolvedAt : existing.lastResolvedAt
        )
      } else {
        mergedByMachine[machineKey] = syncDiscoveredHostWithMachineId(host)
        orderedMachineKeys.append(machineKey)
      }
    }
    let identifiedHosts = orderedMachineKeys.compactMap { mergedByMachine[$0] }
    let anonymousHosts = mergeAnonymousDiscoveredHosts(noMachineKey)
    let filteredNoIdentity = anonymousHosts.filter { host in
      !shouldSuppressAnonymousTailnetHost(host, identifiedHosts: identifiedHosts)
    }
    let merged = identifiedHosts + filteredNoIdentity
    let nextDiscoveredHosts = merged.sorted { $0.hostName.localizedCaseInsensitiveCompare($1.hostName) == .orderedAscending }
    if !syncDiscoveredHostListsEqualForPresentation(discoveredHosts, nextDiscoveredHosts) {
      discoveredHosts = nextDiscoveredHosts
    }
    refreshSavedProfilesFromDiscovery()
    guard let profile = activeHostProfile else { return }
    let matching = discoveredHosts.filter { discovered in
      matchesDiscoveredHost(discovered, profile: profile)
    }
    guard !matching.isEmpty else { return }
    updateProfile { profile in
      profile = profileByApplyingDiscoveredRoutes(profile, matching: matching)
    }
    guard autoReconnectAwaitingLiveDiscovery,
          allowAutoReconnect,
          !autoReconnectPausedByUser,
          !reconnectConnectInFlight,
          !canSendLiveRequests(),
          let refreshedProfile = activeHostProfile,
          tokenForProfile(refreshedProfile) != nil,
          !automaticReconnectAddresses(for: refreshedProfile).isEmpty else {
      return
    }
    autoReconnectAwaitingLiveDiscovery = false
    Task { @MainActor [weak self] in
      await self?.reconnectIfPossible()
    }
  }

  private func mergeAnonymousDiscoveredHosts(_ hosts: [DiscoveredSyncHost]) -> [DiscoveredSyncHost] {
    var mergedByKey: [String: DiscoveredSyncHost] = [:]
    var orderedKeys: [String] = []

    for host in hosts {
      let key = anonymousDiscoveryKey(for: host)
      if let existing = mergedByKey[key] {
        mergedByKey[key] = mergeAnonymousDiscoveredHost(existing, with: host)
      } else {
        mergedByKey[key] = host
        orderedKeys.append(key)
      }
    }

    return orderedKeys.compactMap { mergedByKey[$0] }
  }

  private func anonymousDiscoveryKey(for host: DiscoveredSyncHost) -> String {
    let routes = host.addresses + (host.tailscaleAddress.map { [$0] } ?? [])
    if let route = routes
      .map(syncNormalizedRouteHost)
      .map({ $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() })
      .first(where: { !$0.isEmpty }) {
      return "route:\(route):\(host.port)"
    }

    let hostName = host.hostName.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    if !hostName.isEmpty {
      return "name:\(hostName):\(host.port)"
    }

    return "id:\(host.id)"
  }

  private func mergeAnonymousDiscoveredHost(
    _ left: DiscoveredSyncHost,
    with right: DiscoveredSyncHost
  ) -> DiscoveredSyncHost {
    let preferred = right.lastResolvedAt >= left.lastResolvedAt ? right : left
    let fallback = right.lastResolvedAt >= left.lastResolvedAt ? left : right
    // Preserve the device identity only when both sides agree (or one is
    // absent). These rows are keyed by address+port, so two genuinely different
    // machines momentarily sharing a transient route must NOT inherit a single
    // identity — drop it in that (rare) case rather than pick a wrong one.
    let leftIdentity = syncNonEmpty(left.hostIdentity)
    let rightIdentity = syncNonEmpty(right.hostIdentity)
    let mergedIdentity: String?
    if let leftIdentity, let rightIdentity {
      mergedIdentity = leftIdentity == rightIdentity ? leftIdentity : nil
    } else {
      mergedIdentity = leftIdentity ?? rightIdentity
    }
    return DiscoveredSyncHost(
      id: preferred.id,
      serviceName: preferred.serviceName.isEmpty ? fallback.serviceName : preferred.serviceName,
      hostName: preferred.hostName.isEmpty ? fallback.hostName : preferred.hostName,
      hostIdentity: mergedIdentity,
      siteId: syncNonEmpty(preferred.siteId) ?? syncNonEmpty(fallback.siteId),
      port: preferred.port > 0 ? preferred.port : fallback.port,
      addresses: deduplicatedAddresses(preferred.addresses + fallback.addresses),
      tailscaleAddress: preferred.tailscaleAddress ?? fallback.tailscaleAddress,
      runtimeName: syncNonEmpty(preferred.runtimeName) ?? syncNonEmpty(fallback.runtimeName),
      runtimeKind: preferred.runtimeKind ?? fallback.runtimeKind,
      runtimeVersion: preferred.runtimeVersion ?? fallback.runtimeVersion,
      projectIds: deduplicatedStrings(preferred.projectIds + fallback.projectIds),
      projectNames: deduplicatedStrings(preferred.projectNames + fallback.projectNames),
      projectCount: preferred.projectCount ?? fallback.projectCount,
      pairingPinConfigured: preferred.pairingPinConfigured ?? fallback.pairingPinConfigured,
      lastResolvedAt: max(preferred.lastResolvedAt, fallback.lastResolvedAt)
    )
  }

  private func refreshSavedProfilesFromDiscovery() {
    var profiles = loadSavedProfilesRaw()
    guard !profiles.isEmpty, !discoveredHosts.isEmpty else { return }
    var changed = false
    for (key, profile) in profiles {
      let matching = discoveredHosts.filter { discovered in
        matchesDiscoveredHost(discovered, profile: profile)
      }
      guard !matching.isEmpty else { continue }
      let updated = profileByApplyingDiscoveredRoutes(profile, matching: matching)
      guard updated != profile else { continue }
      let token = storedTokenForSavedProfile(profile)
      profiles.removeValue(forKey: key)
      let updatedKey = profileStorageKey(updated) ?? key
      profiles[updatedKey] = updated
      if let token, updatedKey != key {
        // Move the valid token to the new key, overwriting any stale token that
        // may already be stored there (e.g. an older copy of the same machine);
        // otherwise the stale token survives and the valid one is discarded.
        keychain.saveToken(token, hostKey: updatedKey)
        // The profile was re-keyed; drop the token stored under the old key so
        // it is not orphaned in the keychain indefinitely.
        keychain.clearToken(hostKey: key)
        for legacyKey in legacyProfileStorageKeys(updated) {
          keychain.clearToken(hostKey: legacyKey)
        }
      }
      changed = true
    }
    if changed {
      saveSavedProfiles(profiles)
    }
  }

  private func shouldSuppressAnonymousTailnetHost(
    _ host: DiscoveredSyncHost,
    identifiedHosts: [DiscoveredSyncHost]
  ) -> Bool {
    let identity = host.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard identity.isEmpty else { return false }
    guard let tailnetRoute = host.tailscaleAddress,
          syncIsTailscaleRoute(tailnetRoute) else {
      return false
    }
    return identifiedHosts.contains { identified in
      let identifiedIdentity = identified.hostIdentity?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard !identifiedIdentity.isEmpty else { return false }
      if identified.tailscaleAddress.map(syncIsTailscaleRoute) == true { return true }
      return identified.addresses.contains(where: syncIsTailscaleRoute)
    }
  }

  private func currentPeerMetadata() -> [String: Any] {
    var metadata: [String: Any] = [
      "deviceId": deviceId,
      "deviceName": UIDevice.current.name,
      "platform": "iOS",
      "deviceType": "phone",
      "siteId": database.localSiteId(),
      "dbVersion": latestRemoteDbVersion,
      "capabilities": ["changesetAck", "chunkedEnvelopes"],
    ]
    // Per-project-DB cursors: the host picks the entry for the DB it serves,
    // so a brain that switched hosted projects pumps the right backlog
    // instead of trusting the single legacy cursor from a different DB.
    if let bySite = loadProfile()?.remoteDbVersionBySite, !bySite.isEmpty {
      metadata["dbVersionBySite"] = bySite
    }
    return metadata
  }

  private func openSocket(
    host: String,
    port: Int,
    connectAttemptGeneration: UInt64,
    publishConnecting: Bool = true
  ) async throws {
    teardownSocket(closeCode: .goingAway)
    let endpoint = syncParseRouteEndpoint(host)
    let socketHost = endpoint?.host ?? host.trimmingCharacters(in: .whitespacesAndNewlines)
    let socketPort = endpoint?.port ?? port
    if publishConnecting {
      connectionState = .connecting
      hostName = activeHostProfile?.hostName
      currentAddress = socketHost
      refreshReducedSyncLoad()
    }

    let urlHost = endpoint?.scheme == nil ? socketHost : host
    guard let urlString = syncWebSocketURLString(host: urlHost, port: socketPort),
          let url = URL(string: urlString) else {
      throw NSError(domain: "ADE", code: 1, userInfo: [NSLocalizedDescriptionKey: "Invalid machine address."])
    }
    let task = socketSession.webSocketTask(with: url)
    // URLSession's default receive budget is ~1 MiB and exceeding it kills the
    // connection with "Message too long". Current hosts chunk large envelopes
    // (chunkedEnvelopes capability); the raised ceiling protects against older
    // hosts and any future unchunked path.
    task.maximumMessageSize = 32 * 1024 * 1024
    socket = task
    try await awaitSocketOpen(task)
    guard isCurrentConnectAttempt(connectAttemptGeneration) else {
      teardownSocket(reason: "Connection superseded.")
      throw CancellationError()
    }
    receiveLoop(for: task)
  }

  private func hello(
    host: String,
    port: Int,
    token: String,
    authKind: String,
    pairedDeviceId: String?,
    expectedHostIdentity: String?,
    connectAttemptGeneration: UInt64
  ) async throws {
    let requestId = makeRequestId()
    let auth: [String: Any]
    if authKind == "paired", let pairedDeviceId {
      auth = [
        "kind": "paired",
        "deviceId": pairedDeviceId,
        "secret": token,
      ]
    } else {
      auth = [
        "kind": "bootstrap",
        "token": token,
      ]
    }

    let raw = try await awaitResponse(requestId: requestId) {
      self.sendEnvelope(type: "hello", requestId: requestId, payload: [
        "peer": self.currentPeerMetadata(),
        "auth": auth,
      ])
    }
    guard isCurrentConnectAttempt(connectAttemptGeneration) else {
      throw CancellationError()
    }
    guard let payload = raw as? [String: Any] else {
      throw NSError(domain: "ADE", code: 4, userInfo: [NSLocalizedDescriptionKey: "Invalid hello response."])
    }
    try applyHelloPayload(
      payload,
      connectedHost: host,
      port: port,
      authKind: authKind,
      pairedDeviceId: pairedDeviceId,
      expectedHostIdentity: expectedHostIdentity,
      connectAttemptGeneration: connectAttemptGeneration
    )
    await restoreTrackedOpenLanesAfterReconnect()
    await refreshRemoteProjectCatalog()
  }

  #if DEBUG
  func seedRemoteProjectCatalogForTesting(_ catalog: [MobileProjectSummary]) {
    remoteProjectCatalog = catalog
    refreshProjectCatalog(preferRemoteSelection: true)
  }

  func applyHelloPayloadForTesting(
    _ payload: [String: Any],
    expectedHostIdentity: String? = nil
  ) throws {
    try applyHelloPayload(
      payload,
      connectedHost: "127.0.0.1",
      port: 8787,
      authKind: "paired",
      pairedDeviceId: nil,
      expectedHostIdentity: expectedHostIdentity,
      connectAttemptGeneration: connectAttemptGeneration
    )
  }

  func applyDiscoveredHostsForTesting(_ hosts: [DiscoveredSyncHost]) {
    applyDiscoveredHosts(hosts)
  }

  func preferTailnetReconnectForTesting() {
    preferTailnetForUpcomingReconnect()
  }

  func automaticReconnectAddressesForTesting(_ profile: HostConnectionProfile) -> [String] {
    automaticReconnectAddresses(for: profile)
  }

  func prioritizedReconnectAddressesForTesting(_ profile: HostConnectionProfile) -> [String] {
    prioritizedAddresses(for: profile)
  }

  func setNetworkPathForTesting(
    usesWiFi: Bool,
    usesCellular: Bool,
    usesWiredEthernet: Bool,
    isExpensive: Bool = false,
    isConstrained: Bool = false
  ) {
    lastNetworkPathSnapshot = SyncNetworkPathSnapshot(
      isSatisfied: true,
      usesWiFi: usesWiFi,
      usesCellular: usesCellular,
      usesWiredEthernet: usesWiredEthernet,
      isExpensive: isExpensive,
      isConstrained: isConstrained
    )
  }

  func scheduleNetworkPathReconnectForTesting(delayNanoseconds: UInt64) {
    scheduleNetworkPathReconnect(forceSocketReset: false, delayNanoseconds: delayNanoseconds)
  }

  func hasScheduledReconnectWorkForTesting() -> Bool {
    reconnectTask != nil || networkPathReconnectTask != nil
  }

  func setActiveProjectForTesting(projectId: String?, rootPath: String?) {
    setActiveProjectId(projectId, rootPath: rootPath)
    resetOutboundCursorStateForActiveProject()
  }

  func ensureActiveProjectCacheRowForTesting() throws {
    try ensureActiveProjectCacheRowForHydration()
  }

  func outboundLocalDbVersionForTesting() -> Int {
    outboundLocalDbVersion
  }

  func latestRemoteDbVersionForTesting() -> Int {
    latestRemoteDbVersion
  }

  func setLatestRemoteDbVersionForTesting(_ dbVersion: Int) {
    latestRemoteDbVersion = max(0, dbVersion)
  }

  func currentPeerDbVersionForTesting() -> Int {
    currentPeerMetadata()["dbVersion"] as? Int ?? -1
  }

  func shouldInvalidateSavedPairingAfterAuthFailureForTesting(address: String) -> Bool {
    let error = NSError(
      domain: "ADE",
      code: 3,
      userInfo: [
        NSLocalizedDescriptionKey: "Authentication failed.",
        "ADEErrorCode": "auth_failed",
      ]
    )
    return shouldInvalidateSavedPairing(
      for: errorByMarkingAmbiguousRouteAuthFailure(error, attemptedAddress: address)
    )
  }

  func stageNextOutboundChangesetForTesting() -> SyncChangesetBatchPayload? {
    guard let pending = makeNextOutboundChangeset(sentAt: 0) else { return nil }
    pendingOutboundChangeset = pending
    persistPendingOutboundChangesetForActiveProject(pending)
    return pending.payload
  }

  func advanceOutboundCursorForTesting(to dbVersion: Int) {
    pendingOutboundChangeset = nil
    clearPendingOutboundChangesetForActiveProject()
    advanceOutboundCursorForActiveProject(to: dbVersion)
  }

  func seedTerminalBufferForTesting(sessionId: String, transcript: String) {
    subscribedTerminalSessionIds.insert(sessionId)
    terminalBuffers[sessionId] = transcript
    terminalBufferUpdatedAt[sessionId] = Date()
    terminalBufferRevisionsBySessionId[sessionId, default: 0] += 1
    terminalBufferRevision += 1
  }

  func pendingOperationsForTesting() -> [(id: String, kind: String, action: String, projectId: String?, projectRootPath: String?)] {
    loadPendingOperations().map { operation in
      (
        id: operation.id,
        kind: operation.kind,
        action: operation.action,
        projectId: operation.projectId,
        projectRootPath: operation.projectRootPath
      )
    }
  }
  #endif

  private func applyHelloPayload(
    _ payload: [String: Any],
    connectedHost: String,
    port: Int,
    authKind: String,
    pairedDeviceId: String?,
    expectedHostIdentity: String?,
    connectAttemptGeneration: UInt64
  ) throws {
    guard isCurrentConnectAttempt(connectAttemptGeneration) else {
      throw CancellationError()
    }
    let brain = payload["brain"] as? [String: Any]
    let remoteHostIdentity = brain?["deviceId"] as? String
    let remoteHostName = brain?["deviceName"] as? String
    let remoteHostSiteId = brain?["siteId"] as? String
    let incomingHostIdentity = syncNormalizedCommandScopeValue(remoteHostIdentity)
      ?? syncNormalizedCommandScopeValue(expectedHostIdentity)
    if activeProjectId != nil,
       let incomingHostIdentity,
       (
         syncNormalizedCommandScopeValue(activeProjectHostIdentity)
           ?? syncNormalizedCommandScopeValue(activeHostProfile?.hostIdentity)
           ?? syncNormalizedCommandScopeValue(activeHostProfile?.lastHostDeviceId)
       ) != incomingHostIdentity {
      setActiveProjectId(nil)
      projectHomePresented = true
    }
    if let expectedHostIdentity, let remoteHostIdentity, expectedHostIdentity != remoteHostIdentity {
      disconnect(clearCredentials: false, suspendAutoReconnect: false)
      remoteProjectCatalog = []
      refreshProjectCatalog()
      throw NSError(
        domain: "ADE",
        code: 20,
        userInfo: [NSLocalizedDescriptionKey: "The saved pairing belongs to a different ADE machine. Pair again with the current machine."]
      )
    }

    // Key the inbound changeset cursor to the project DB this host serves.
    // The same brain hosts different project DBs over time, each with its own
    // db_version sequence; reusing a cursor across DBs silently skips the
    // entire backlog (host sees "caught up") or replays from zero.
    if let serverDbSiteId = syncNonEmpty(payload["serverDbSiteId"] as? String) {
      let normalizedSite = serverDbSiteId.lowercased()
      if activeRemoteDbSiteId != normalizedSite {
        activeRemoteDbSiteId = normalizedSite
        latestRemoteDbVersion = loadProfile()?.remoteDbVersionBySite?[normalizedSite] ?? 0
        updateProfile { profile in
          profile.lastRemoteDbVersion = latestRemoteDbVersion
        }
      }
    } else {
      activeRemoteDbSiteId = nil
    }

    let features = payload["features"] as? [String: Any]
    func featureEnabled(_ keys: String...) -> Bool {
      for key in keys {
        if let feature = features?[key] as? [String: Any],
           let enabled = feature["enabled"] as? Bool {
          return enabled
        }
        if let value = features?[key] as? Bool {
          return value
        }
      }
      return false
    }
    supportsChatStreaming = featureEnabled("chatStreaming", "chat_streaming")
    supportsProjectCatalog = featureEnabled("projectCatalog", "project_catalog")
    supportsProjectActions = featureEnabled("projectActions", "project_actions")
    supportsChangesetAck = featureEnabled("changesetAck", "changeset_ack")
    remoteProjectCatalog = []
    pendingProjectCatalogChunks.removeAll()
    let commandDescriptors: [SyncRemoteCommandDescriptor] = {
      guard
        let commandRouting = features?["commandRouting"],
        let actions = (commandRouting as? [String: Any])?["actions"]
      else {
        return []
      }
      return (try? decode(actions, as: [SyncRemoteCommandDescriptor].self)) ?? []
    }()
    if supportsProjectCatalog,
       let projects = payload["projects"],
       let catalog = try? decode(["projects": projects], as: MobileProjectCatalogPayload.self) {
      applyRemoteProjectCatalog(catalog)
    } else {
      refreshProjectCatalog()
    }
    if activeProjectId != nil, let incomingHostIdentity {
      activeProjectHostIdentity = incomingHostIdentity
      UserDefaults.standard.set(incomingHostIdentity, forKey: activeProjectHostIdentityKey)
    }
    // Connecting must not navigate. Forcing `projectHomePresented = false`
    // here yanked the user out of the machine's project list into the
    // remembered project on every (re)connect — and with background reconnect
    // cycles it re-fired while they sat on the main page. Entering a project
    // is only ever a user action (selectProject / closeProjectHome).

    reconnectState.reset()
    allowAutoReconnect = true
    setAutoReconnectPausedByUser(false)
    // Do NOT set latestRemoteDbVersion to the server's version here.
    // The mobile should only claim a dbVersion it actually received via
    // changeset_batch. Setting it prematurely causes the desktop to skip
    // the full initial sync on reconnect (it thinks we already have the data).
    hostName = remoteHostName ?? activeHostProfile?.hostName
    connectionState = .connected
    currentAddress = connectedHost
    refreshReducedSyncLoad()
    lastError = nil
    lastPairingErrorCode = nil
    markSyncActivity(force: true)
    saveRemoteCommandDescriptors(commandDescriptors)

    let matchingDiscovery = discoveredHosts.first { discovered in
      discovered.hostIdentity == remoteHostIdentity
        || discovered.addresses.contains(connectedHost)
        || discovered.tailscaleAddress == connectedHost
    }
    // Cap saved candidates to avoid unbounded growth when the user moves
    // between networks. Put the currently-connected host first, then any
    // live-discovered addresses, then older saved entries. Old stale IPs
    // from previous subnets fall off the tail once the cap is reached.
    let savedCandidatesUncapped = deduplicatedAddresses(
      [connectedHost] +
      (matchingDiscovery?.addresses ?? []) +
      (matchingDiscovery?.tailscaleAddress.map { [$0] } ?? []) +
      (activeHostProfile?.savedAddressCandidates ?? [])
    )
    let savedCandidates = Array(savedCandidatesUncapped.prefix(6))
    let discoveredLan = deduplicatedAddresses(
      matchingDiscovery?.addresses ?? activeHostProfile?.discoveredLanAddresses ?? []
    )

    let profile = HostConnectionProfile(
      hostIdentity: remoteHostIdentity ?? activeHostProfile?.hostIdentity ?? expectedHostIdentity,
      hostName: remoteHostName ?? activeHostProfile?.hostName,
      siteId: syncNormalizedCommandScopeValue(remoteHostSiteId) ?? activeHostProfile?.siteId,
      port: port,
      authKind: authKind,
      pairedDeviceId: pairedDeviceId ?? activeHostProfile?.pairedDeviceId,
      lastRemoteDbVersion: latestRemoteDbVersion,
      lastHostDeviceId: remoteHostIdentity ?? activeHostProfile?.lastHostDeviceId,
      lastSuccessfulAddress: connectedHost,
      savedAddressCandidates: savedCandidates,
      discoveredLanAddresses: discoveredLan,
      tailscaleAddress: matchingDiscovery?.tailscaleAddress
        ?? (syncIsTailscaleRoute(connectedHost) ? connectedHost : nil)
        ?? activeHostProfile?.tailscaleAddress
    )
    saveProfile(profile)
    resetOutboundCursorStateForActiveProject()
    if !supportsChangesetAck {
      pendingOutboundChangeset = nil
      clearPendingOutboundChangesetForActiveProject()
    }
    startClientHeartbeatTask(
      intervalNanoseconds: syncClientHeartbeatIntervalNanoseconds(serverIntervalMs: payload["heartbeatIntervalMs"]),
      for: connectionGeneration
    )
    startRelayLoop()
    startInitialHydrationTask(for: connectionGeneration)
    restoreTerminalSubscriptions()
    restoreChatEventSubscriptions()
    subscribeRosterIfNeeded()
  }

  private func failPendingRequests(with error: Error) {
    let friendlyError = SyncUserFacingError.error(from: error)
    let completions = pending
    pending.removeAll()
    pendingProjectCatalogChunks.removeAll()
    for request in completions.values {
      request.timeoutTask.cancel()
      request.completion(.failure(friendlyError))
    }
  }

  private func canSendLiveRequests() -> Bool {
    socket != nil && (connectionState == .connected || connectionState == .syncing)
  }

  private func receiveLoop(for task: URLSessionWebSocketTask) {
    Task { @MainActor in
      while self.socket === task {
        do {
          let message = try await task.receive()
          let text: String
          switch message {
          case .string(let value):
            text = value
          case .data(let data):
            text = String(decoding: data, as: UTF8.self)
          @unknown default:
            text = ""
          }
          do {
            // CPU-heavy decode (envelope JSON, gunzip, payload JSON) runs off
            // the main actor; ordering is preserved because each frame is
            // awaited in sequence. The main actor only mutates state.
            let preprocessed = try await Task.detached(priority: .userInitiated) {
              try syncPreprocessIncoming(text)
            }.value
            // The detached decode is a suspension point: the socket can be
            // torn down (and a new connection brought up) while it runs. A
            // stale frame must not mutate the new connection's state.
            guard self.socket === task else { break }
            if let preprocessed {
              try await self.handleIncoming(preprocessed)
            }
          } catch {
            if self.socket === task {
              self.handleIncomingFailure(error, text: text)
            }
            break
          }
        } catch {
          if self.socket === task {
            let closeCodeRawValue = Int(task.closeCode.rawValue)
            let reconnectDelay = self.reconnectState.nextDelayNanoseconds(forCloseCodeRawValue: closeCodeRawValue)
            let failure: Error
            if closeCodeRawValue == 4001 {
              failure = NSError(
                domain: "ADE",
                code: 24,
                userInfo: [NSLocalizedDescriptionKey: "The machine stopped responding. Reconnecting now."]
              )
            } else {
              failure = error
            }
            self.handleTransportFailure(
              failure,
              phase: .disconnected,
              connectionState: .connecting,
              reconnectDelayNanoseconds: reconnectDelay
            )
          }
          break
        }
      }
    }
  }

  private func handleIncomingFailure(_ error: Error, text: String) {
    let type: String = {
      guard let data = text.data(using: .utf8),
            let envelope = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return "unknown"
      }
      return (envelope["type"] as? String) ?? "unknown"
    }()
    syncConnectLog.error(
      "incoming message failed type=\(type, privacy: .public) error=\(String(describing: error), privacy: .public)"
    )
    let friendlyError = SyncUserFacingError.error(from: error)
    // Tear the socket down before flipping reduced-load preferences. The
    // restoreChatEventSubscriptions() side-effect inside refreshReducedSyncLoad
    // would otherwise enqueue chat_subscribe frames on a socket that is about
    // to be cancelled, surfacing as send-on-closed errors and orphaned subs.
    teardownSocket(reason: friendlyError.localizedDescription)
    markConnectionLoadStrained()
    lastError = friendlyError.localizedDescription
    connectionState = syncConnectionStateAfterTransportFailure(error: error, fallback: .disconnected)
    setDomainStatus(SyncDomain.allCases, phase: .failed, error: friendlyError.localizedDescription)
    failPendingRequests(with: friendlyError)
    // "Message too long" used to pause auto-reconnect permanently. With the
    // raised socket receive budget and hosts chunking oversized envelopes it
    // is an ordinary transport failure now — reconnect like any other drop.
    scheduleReconnectIfNeeded(after: reconnectDelay())
  }

  private func handleIncoming(_ pre: SyncPreprocessedEnvelope) async throws {
    let type = pre.type
    let requestId = pre.requestId
    let payload = pre.payload
    // The detached decode/apply stages below are suspension points; a
    // teardown + reconnect can complete while they run. Guard every
    // post-await state mutation on the generation captured here so a stale
    // frame can't advance the NEW connection's cursors (applyHelloPayload may
    // have re-keyed activeRemoteDbSiteId to a different project DB).
    let generation = connectionGeneration
    lastInboundMessageAt = ProcessInfo.processInfo.systemUptime

    switch type {
    case "envelope_chunk":
      guard let dict = payload as? [String: Any],
            let chunkId = dict["chunkId"] as? String,
            let index = dict["index"] as? Int,
            let total = dict["total"] as? Int,
            let part = dict["part"] as? String else { return }
      if let reassembled = envelopeChunkAssembler.add(chunkId: chunkId, index: index, total: total, part: part) {
        // The reassembled envelope can be tens of megabytes — decode it off
        // the main actor like any first-class frame.
        let nested = try await Task.detached(priority: .userInitiated) {
          try syncPreprocessIncoming(reassembled)
        }.value
        guard isCurrentConnectionGeneration(generation) else { return }
        if let nested {
          try await handleIncoming(nested)
        }
      }
    case "hello_ok":
      reconnectState.reset()
      resolve(requestId: requestId, result: .success(payload))
    case "project_catalog":
      let catalog = try decode(payload, as: MobileProjectCatalogPayload.self)
      applyRemoteProjectCatalog(catalog)
      resolve(requestId: requestId, result: .success(payload))
    case "project_catalog_chunk":
      let chunk = try decode(payload, as: MobileProjectCatalogChunkPayload.self)
      applyRemoteProjectCatalogChunk(chunk, requestId: requestId)
    case "project_switch_result":
      resolve(requestId: requestId, result: .success(payload))
    case "project_browse_result",
         "project_default_parent_dir",
         "project_open_result",
         "project_create_result",
         "project_clone_result",
         "project_forget_result",
         "project_list_my_github_repos_result":
      resolve(requestId: requestId, result: .success(payload))
    case "hello_error":
      let code = ((payload as? [String: Any])?["code"] as? String) ?? "auth_failed"
      let message = ((payload as? [String: Any])?["message"] as? String) ?? "Authentication failed."
      connectionState = .error
      resolve(requestId: requestId, result: .failure(NSError(
        domain: "ADE",
        code: 5,
        userInfo: [
          NSLocalizedDescriptionKey: message,
          "ADEErrorCode": code,
        ]
      )))
    case "pairing_result":
      resolve(requestId: requestId, result: .success(payload))
    case "changeset_batch":
      var batchPayload = payload
      if let requestId = requestId?.trimmingCharacters(in: .whitespacesAndNewlines),
         !requestId.isEmpty,
         var payloadObject = payload as? [String: Any] {
        let payloadBatchId = (payloadObject["batchId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if payloadBatchId.isEmpty {
          payloadObject["batchId"] = requestId
          batchPayload = payloadObject
        }
      }
      // Decode and apply off the main actor: a 250-row batch can carry
      // megabytes and the SQLite connection is FULLMUTEX (serialized), so
      // cross-thread application is safe. The receive loop awaits each frame
      // in order, so batches still apply sequentially.
      let batch = try await Task.detached(priority: .userInitiated) {
        try syncDecodeChangesetBatch(batchPayload)
      }.value
      guard isCurrentConnectionGeneration(generation) else { return }
      do {
        let database = self.database
        let result = try await Task.detached(priority: .userInitiated) {
          try database.applyChanges(batch.changes)
        }.value
        // Stale apply after a reconnect: the rows are already committed
        // (insert-or-ignore makes the resend idempotent), but the cursor and
        // ack belong to the dead connection — advancing the new site's cursor
        // here would make the host skip the new project DB's backlog.
        guard isCurrentConnectionGeneration(generation) else { return }
        latestRemoteDbVersion = max(latestRemoteDbVersion, batch.toDbVersion, result.dbVersion)
        markSyncActivity()
        let advancedVersion = latestRemoteDbVersion
        let cursorSite = activeRemoteDbSiteId
        scheduleRemoteDbCursorProfilePersist(dbVersion: advancedVersion, cursorSite: cursorSite)
        sendChangesetAck(
          batch: batch,
          ok: true,
          appliedDbVersion: result.dbVersion,
          appliedCount: result.appliedCount
        )
        resolve(requestId: requestId, result: .success(payload))
      } catch {
        guard isCurrentConnectionGeneration(generation) else { return }
        sendChangesetAck(
          batch: batch,
          ok: false,
          appliedDbVersion: database.currentDbVersion(),
          appliedCount: 0,
          error: error
        )
        lastError = SyncUserFacingError.message(for: error)
        resolve(requestId: requestId, result: .success(payload))
      }
    case "changeset_ack":
      let ack = try decode(payload, as: SyncChangesetAckPayload.self)
      handleChangesetAck(ack)
    case "brain_status":
      if let dict = payload as? [String: Any], let brain = dict["brain"] as? [String: Any] {
        hostName = brain["deviceName"] as? String
        updateProfile { profile in
          profile.hostName = brain["deviceName"] as? String
          profile.lastHostDeviceId = brain["deviceId"] as? String
        }
        if let peer = (dict["connectedPeers"] as? [[String: Any]])?.first(where: { $0["deviceId"] as? String == deviceId }) {
          let latencyMs = (peer["latencyMs"] as? NSNumber)?.intValue
          let syncLag = (peer["syncLag"] as? NSNumber)?.intValue
          recordConnectionLoadSample(latencyMs: latencyMs, syncLag: syncLag)
        }
      }
      resolve(requestId: requestId, result: .success(payload))
    case "heartbeat":
      if let dict = payload as? [String: Any], (dict["kind"] as? String) == "ping" {
        sendEnvelope(type: "heartbeat", requestId: requestId, payload: [
          "kind": "pong",
          "sentAt": dict["sentAt"] as? String ?? ISO8601DateFormatter().string(from: Date()),
          "dbVersion": database.currentDbVersion(),
        ])
      }
    case "command_ack":
      if let dict = payload as? [String: Any], let accepted = dict["accepted"] as? Bool, !accepted {
        let message = dict["message"] as? String ?? "Remote command rejected."
        resolve(requestId: requestId, result: .failure(NSError(domain: "ADE", code: 6, userInfo: [NSLocalizedDescriptionKey: message])))
      }
    case "command_result", "file_response", "terminal_snapshot", "terminal_history":
      resolve(requestId: requestId, result: .success(payload))
    case "chat_subscribe":
      if supportsChatStreaming,
         let dict = payload as? [String: Any],
         let snapshot = try? decode(dict, as: SyncChatSubscribeSnapshotPayload.self),
         subscribedChatSessionIds.contains(snapshot.sessionId) {
        let resumed = (dict["resumed"] as? Bool) == true
        let previousLastSeq = chatEventLastSeqBySession[snapshot.sessionId]
        if !resumed {
          // Full snapshot: the host did not (or could not) resume from our
          // sinceSeq, so its seq stream may have restarted (host reboot,
          // replay buffer eviction). Drop the stale watermark and re-track
          // from the next live event — otherwise we would discard the first
          // events of the new stream as "old".
          chatEventLastSeqBySession.removeValue(forKey: snapshot.sessionId)
        }
        if resumed {
          mergeChatEventHistory(sessionId: snapshot.sessionId, events: snapshot.events)
        } else {
          replaceChatEventHistory(sessionId: snapshot.sessionId, events: snapshot.events)
        }
        if let turnActive = snapshot.turnActive {
          updateChatTurnActiveHint(sessionId: snapshot.sessionId, turnActive: turnActive)
        } else if (dict["resumed"] as? Bool) != true {
          // Full snapshot with no live turn state (older host, or the host
          // has no summary for this session): a previously latched hint can
          // never be corrected by this host, so drop it and fall back to
          // transcript-derived streaming state.
          clearChatTurnActiveHint(sessionId: snapshot.sessionId)
        }
        syncChatLog.notice(
          "chat_subscribe_ack session=\(snapshot.sessionId, privacy: .public) resumed=\(resumed, privacy: .public) events=\(snapshot.events.count, privacy: .public) firstSeq=\(snapshot.events.compactMap(\.sequence).first ?? -1, privacy: .public) lastSeq=\(snapshot.events.compactMap(\.sequence).last ?? -1, privacy: .public) previousLastSeq=\(previousLastSeq ?? -1, privacy: .public) currentLastSeq=\(self.chatEventLastSeqBySession[snapshot.sessionId] ?? -1, privacy: .public) turnActive=\(snapshot.turnActive.map(String.init) ?? "nil", privacy: .public) truncated=\(snapshot.truncated, privacy: .public)"
        )
      }
    case "chat_event":
      if supportsChatStreaming,
         let dict = payload as? [String: Any],
         let envelope = try? decode(dict, as: AgentChatEventEnvelope.self),
         subscribedChatSessionIds.contains(envelope.sessionId) {
        // Gate chat events on the current subscription set so events from a
        // previous project (still streaming on the host) do not leak into the
        // newly-active project's view after a quick switch.
        if let seq = (dict["seq"] as? NSNumber)?.intValue {
          // Resumable stream: drop duplicates/old replays and advance the
          // per-session watermark used as sinceSeq on re-subscribe. Events
          // without seq (older hosts) keep today's behavior unchanged.
          if let lastSeq = chatEventLastSeqBySession[envelope.sessionId], seq <= lastSeq {
            syncChatLog.debug(
              "chat_event_dropped_old session=\(envelope.sessionId, privacy: .public) seq=\(seq, privacy: .public) lastSeq=\(lastSeq, privacy: .public) type=\(envelope.event.typeName, privacy: .public)"
            )
            break
          }
          chatEventLastSeqBySession[envelope.sessionId] = seq
        }
        recordChatEventEnvelope(envelope)
        syncChatLog.debug(
          "chat_event_applied session=\(envelope.sessionId, privacy: .public) seq=\(envelope.sequence ?? -1, privacy: .public) type=\(envelope.event.typeName, privacy: .public) history=\(self.chatEventEnvelopesBySession[envelope.sessionId]?.count ?? 0, privacy: .public) revision=\(self.chatEventRevisionsBySession[envelope.sessionId] ?? 0, privacy: .public)"
        )
      }
    case "terminal_data":
      if let dict = payload as? [String: Any], let sessionId = dict["sessionId"] as? String, let chunk = dict["data"] as? String {
        guard subscribedTerminalSessionIds.contains(sessionId) else { break }
        handleTerminalDataChunk(sessionId: sessionId, chunk: chunk, endOffset: (dict["offset"] as? NSNumber)?.intValue)
      }
    case "terminal_exit":
      if let dict = payload as? [String: Any], let sessionId = dict["sessionId"] as? String {
        guard subscribedTerminalSessionIds.contains(sessionId) else { break }
        let exitCode = dict["exitCode"] as? Int
        terminalBuffers[sessionId] = trimmedTerminalBuffer((terminalBuffers[sessionId] ?? "") + "\n\n[process exited\(exitCode.map { " with \($0)" } ?? "")]")
        terminalBufferUpdatedAt[sessionId] = Date()
        markTerminalBufferChanged(sessionId: sessionId, immediate: true)
        terminalStreamHandlers[sessionId]?(.exit(code: exitCode))
      }
    case "roster_snapshot":
      if let snapshot = try? decode(payload, as: RemoteRosterSnapshotPayload.self) {
        applyRosterSnapshot(snapshot)
      }
    case "roster_delta":
      if let delta = try? decode(payload, as: RemoteRosterDeltaPayload.self) {
        applyRosterDelta(delta)
      }
    default:
      break
    }
  }

  private func startRelayLoop() {
    cancelReconnectLoop()
    relayTask?.cancel()
    relayTask = Task { @MainActor in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: 400_000_000)
        sendLocalChanges()
      }
    }
  }

  private func startClientHeartbeatTask(intervalNanoseconds: UInt64, for connectionGeneration: UInt64) {
    clientHeartbeatTask?.cancel()
    clientHeartbeatTask = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(nanoseconds: intervalNanoseconds)
        guard let self, !Task.isCancelled else { return }
        guard self.isCurrentConnectionGeneration(connectionGeneration), self.canSendLiveRequests() else { return }
        self.sendEnvelope(type: "heartbeat", requestId: nil, payload: [
          "kind": "ping",
          "sentAt": ISO8601DateFormatter().string(from: Date()),
          "dbVersion": self.database.currentDbVersion(),
        ])
      }
    }
  }

  private func startInitialHydrationTask(for connectionGeneration: UInt64) {
    hydrationTask?.cancel()
    hydrationTask = Task { @MainActor [weak self] in
      guard let self else { return }
      await self.performInitialHydration(for: connectionGeneration)
      guard self.isCurrentConnectionGeneration(connectionGeneration) else { return }
      self.flushPendingOperationsAndScheduleRetry()
    }
  }

  private func isCurrentConnectionGeneration(_ generation: UInt64) -> Bool {
    !Task.isCancelled && connectionGeneration == generation
  }

  private func sendChangesetAck(
    batch: SyncChangesetBatchPayload,
    ok: Bool,
    appliedDbVersion: Int,
    appliedCount: Int,
    error: Error? = nil
  ) {
    let ack = SyncChangesetAckPayload(
      batchId: batch.batchId,
      fromDbVersion: batch.fromDbVersion,
      toDbVersion: batch.toDbVersion,
      appliedDbVersion: appliedDbVersion,
      appliedCount: appliedCount,
      ok: ok,
      error: error.map {
        SyncChangesetAckPayload.AckError(
          code: "changeset_apply_failed",
          message: SyncUserFacingError.message(for: $0)
        )
      }
    )
    guard let payloadObject = try? jsonObject(from: ack) else { return }
    sendEnvelope(type: "changeset_ack", requestId: batch.batchId, payload: payloadObject)
  }

  private func handleChangesetAck(_ ack: SyncChangesetAckPayload) {
    guard var pending = pendingOutboundChangeset else { return }
    guard ack.batchId == pending.payload.batchId else {
      syncConnectLog.info("changeset ack ignored batch=\(ack.batchId, privacy: .public)")
      return
    }
    guard ack.toDbVersion >= pending.payload.toDbVersion else { return }
    if ack.ok {
      pendingOutboundChangeset = nil
      clearPendingOutboundChangesetForActiveProject()
      advanceOutboundCursorForActiveProject(to: pending.payload.toDbVersion)
      markSyncActivity(force: true)
      lastError = nil
      return
    }
    guard pending.retryCount < maxChangesetAckRetries else {
      failPendingOutboundChangeset("The machine stopped accepting phone changes. Reconnecting now.")
      return
    }
    pending.retryCount += 1
    pending.sentAt = ProcessInfo.processInfo.systemUptime
    pendingOutboundChangeset = pending
    persistPendingOutboundChangesetForActiveProject(pending)
    lastError = ack.error?.message ?? "The machine could not apply the latest phone changes."
  }

  private func sendOutboundChangeset(_ pending: PendingOutboundChangeset) {
    guard let payloadObject = try? jsonObject(from: pending.payload) else { return }
    sendEnvelope(type: "changeset_batch", requestId: pending.payload.batchId, payload: payloadObject)
  }

  private func sendLocalChanges() {
    guard canSendLiveRequests() else { return }
    let now = ProcessInfo.processInfo.systemUptime
    if var pending = pendingOutboundChangeset {
      if !supportsChangesetAck {
        sendOutboundChangeset(pending)
        pendingOutboundChangeset = nil
        clearPendingOutboundChangesetForActiveProject()
        advanceOutboundCursorForActiveProject(to: pending.payload.toDbVersion)
        markSyncActivity(force: true)
        return
      }
      if now - pending.sentAt >= 10 {
        guard pending.retryCount < maxChangesetAckRetries else {
          failPendingOutboundChangeset("The machine did not acknowledge phone changes in time. Reconnecting now.")
          return
        }
        pending.sentAt = now
        pending.retryCount += 1
        pendingOutboundChangeset = pending
        persistPendingOutboundChangesetForActiveProject(pending)
        sendOutboundChangeset(pending)
      }
      return
    }
    guard let pending = makeNextOutboundChangeset(sentAt: now) else { return }
    sendOutboundChangeset(pending)
    if supportsChangesetAck {
      pendingOutboundChangeset = pending
      persistPendingOutboundChangesetForActiveProject(pending)
    } else {
      advanceOutboundCursorForActiveProject(to: pending.payload.toDbVersion)
      markSyncActivity(force: true)
    }
  }

  private func makeNextOutboundChangeset(sentAt: TimeInterval) -> PendingOutboundChangeset? {
    let currentDbVersion = database.currentDbVersion()
    guard currentDbVersion > outboundLocalDbVersion else { return nil }
    let localSiteId = database.localSiteId()
    let changes = database.exportChangesSince(version: outboundLocalDbVersion).filter { $0.siteId == localSiteId }
    let previousDbVersion = outboundLocalDbVersion
    guard !changes.isEmpty else {
      advanceOutboundCursorForActiveProject(to: currentDbVersion, persistImmediately: false)
      return nil
    }

    let payload = SyncChangesetBatchPayload(
      batchId: makeRequestId(),
      reason: "relay",
      fromDbVersion: previousDbVersion,
      toDbVersion: currentDbVersion,
      changes: changes
    )
    return PendingOutboundChangeset(payload: payload, sentAt: sentAt, retryCount: 0)
  }

  private func failPendingOutboundChangeset(_ message: String) {
    pendingOutboundChangeset = nil
    clearPendingOutboundChangesetForActiveProject()
    handleTransportFailure(
      NSError(
        domain: "ADE",
        code: 27,
        userInfo: [NSLocalizedDescriptionKey: message]
      ),
      phase: .disconnected,
      connectionState: .disconnected
    )
  }

  private func resolve(requestId: String?, result: Result<Any, Error>) {
    guard let requestId, let request = pending.removeValue(forKey: requestId) else { return }
    request.timeoutTask.cancel()
    switch result {
    case .success(let payload):
      recordConnectionLoadSample(roundTripSeconds: ProcessInfo.processInfo.systemUptime - request.startedAt)
      request.completion(.success(payload))
    case .failure(let error):
      request.completion(.failure(SyncUserFacingError.error(from: error)))
    }
  }

  private func awaitResponse(
    requestId: String,
    disconnectOnTimeout: Bool = true,
    timeoutMessage: String = SyncRequestTimeout.message,
    timeoutNanoseconds: UInt64 = SyncRequestTimeout.defaultTimeoutNanoseconds,
    send: () -> Void
  ) async throws -> Any {
    try await withCheckedThrowingContinuation { continuation in
      let timeoutTask = Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: timeoutNanoseconds)
        guard !Task.isCancelled else { return }
        self?.handlePendingRequestTimeout(
          requestId: requestId,
          disconnectOnTimeout: disconnectOnTimeout,
          timeoutError: SyncRequestTimeout.error(message: timeoutMessage)
        )
      }
      pending[requestId] = PendingRequest(
        completion: { result in
          continuation.resume(with: result)
        },
        timeoutTask: timeoutTask,
        startedAt: ProcessInfo.processInfo.systemUptime
      )
      send()
    }
  }

  private func sendEnvelope(type: String, requestId: String?, payload: Any) {
    guard let socket else { return }
    let sendSocket = socket
    guard let payloadData = try? adeJSONData(withJSONObject: payload) else { return }

    var envelope: [String: Any]
    if payloadData.count >= compressionThresholdBytes {
      envelope = [
        "version": 1,
        "type": type,
        "compression": "gzip",
        "payloadEncoding": "base64",
        "payload": gzip(payloadData).base64EncodedString(),
        "uncompressedBytes": payloadData.count,
      ]
    } else {
      envelope = [
        "version": 1,
        "type": type,
        "compression": "none",
        "payloadEncoding": "json",
        "payload": payload,
      ]
    }
    if let requestId, !requestId.isEmpty {
      envelope["requestId"] = requestId
    }
    if let projectId = syncOutboundEnvelopeProjectId(type: type, activeProjectId: activeProjectId) {
      envelope["projectId"] = projectId
    }

    guard let data = try? adeJSONData(withJSONObject: envelope),
          let text = String(data: data, encoding: .utf8)
    else { return }

    sendSocket.send(.string(text)) { error in
      if let error {
        Task { @MainActor in
          guard shouldHandleSocketSendCompletionError(currentSocket: self.socket, callbackSocket: sendSocket) else {
            return
          }
          self.handleTransportFailure(error)
        }
      }
    }
  }

  private func awaitSocketOpen(_ task: URLSessionWebSocketTask) async throws {
    try await withCheckedThrowingContinuation { continuation in
      let taskIdentifier = task.taskIdentifier
      pendingSocketOpen[taskIdentifier] = continuation
      pendingSocketOpenTimeoutTasks[taskIdentifier]?.cancel()
      pendingSocketOpenTimeoutTasks[taskIdentifier] = Task { @MainActor [weak self] in
        try? await Task.sleep(nanoseconds: SyncSocketTiming.openTimeoutNanoseconds)
        guard !Task.isCancelled else { return }
        self?.resolveSocketOpen(
          task,
          result: .failure(
            NSError(
              domain: "ADE",
              code: 25,
              userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for the machine connection to open."]
            )
          )
        )
      }
      task.resume()
    }
  }

  private func resolveSocketOpen(_ task: URLSessionWebSocketTask, result: Result<Void, Error>) {
    let taskIdentifier = task.taskIdentifier
    pendingSocketOpenTimeoutTasks.removeValue(forKey: taskIdentifier)?.cancel()
    guard let continuation = pendingSocketOpen.removeValue(forKey: taskIdentifier) else { return }
    continuation.resume(with: result)
  }

  fileprivate func handleSocketDidOpen(_ task: URLSessionWebSocketTask) {
    guard socket === task else { return }
    resolveSocketOpen(task, result: .success(()))
  }

  fileprivate func handleSocketDidComplete(_ task: URLSessionWebSocketTask, error: Error) {
    resolveSocketOpen(task, result: .failure(error))
  }

  private func teardownSocket(closeCode: URLSessionWebSocketTask.CloseCode = .goingAway, reason: String? = nil) {
    // The roster subscription is bound to the live socket; a reconnect must
    // re-subscribe. Keep `rosterProjects` for offline render, but drop the
    // seq baseline so the next subscribe asks for (and applies) a fresh snapshot.
    rosterSubscribed = false
    rosterSeq = nil
    rosterPersistTask?.cancel()
    rosterPersistTask = nil
    transportProbeTask?.cancel()
    transportProbeTask = nil
    relayTask?.cancel()
    relayTask = nil
    clientHeartbeatTask?.cancel()
    clientHeartbeatTask = nil
    hydrationTask?.cancel()
    hydrationTask = nil
    pendingOperationFlushTask?.cancel()
    pendingOperationFlushTask = nil
    pendingOperationFlushInFlight = false
    lanePresenceHeartbeatTask?.cancel()
    lanePresenceHeartbeatTask = nil
    if let socket {
      resolveSocketOpen(
        socket,
        result: .failure(
          NSError(
            domain: "ADE",
            code: 26,
            userInfo: [NSLocalizedDescriptionKey: reason ?? "Connection closed."]
          )
        )
      )
    }
    socket?.cancel(with: closeCode, reason: reason?.data(using: .utf8))
    socket = nil
    currentAddress = nil
    lastInboundMessageAt = nil
    refreshReducedSyncLoad()
    pendingProjectCatalogChunks.removeAll()
    envelopeChunkAssembler.reset()
    connectionGeneration &+= 1
  }

  private func handleTransportFailure(
    _ error: Error,
    phase: SyncDomainPhase = .failed,
    connectionState: RemoteConnectionState = .error,
    reconnectDelayNanoseconds: UInt64? = nil
  ) {
    let friendlyError = SyncUserFacingError.error(from: error)
    // Tear down before marking load strained — see handleIncomingFailure.
    teardownSocket(reason: friendlyError.localizedDescription)
    markConnectionLoadStrained()
    lastError = friendlyError.localizedDescription
    self.connectionState = syncConnectionStateAfterTransportFailure(error: error, fallback: connectionState)
    if phase == .failed || syncIsMessageTooLongError(error) {
      setDomainStatus(SyncDomain.allCases, phase: .failed, error: friendlyError.localizedDescription)
    } else {
      setDomainStatus(SyncDomain.allCases, phase: .disconnected)
    }
    failPendingRequests(with: friendlyError)
    // Oversized-message errors no longer pause reconnect permanently — see
    // handleIncomingFailure.
    scheduleReconnectIfNeeded(after: reconnectDelayNanoseconds ?? reconnectDelay())
  }

  private func handlePendingRequestTimeout(
    requestId: String,
    disconnectOnTimeout: Bool = true,
    timeoutError: NSError = SyncRequestTimeout.error()
  ) {
    guard pending[requestId] != nil else { return }
    let shouldReconnect = disconnectOnTimeout
      && syncShouldReconnectAfterRequestTimeout(
        now: ProcessInfo.processInfo.systemUptime,
        lastInboundMessageAt: lastInboundMessageAt
      )
    if disconnectOnTimeout,
       shouldReconnect {
      // A timed-out request plus a quiet inbound window does NOT prove the
      // socket is dead — the host may just be slow (catalog/PR refreshes can
      // take 30s+) while nothing else streams. Tearing down here put cellular
      // sessions into a perpetual timeout→reconnect→re-request loop. Fail the
      // request, then actively probe the transport; only a probe that hears
      // nothing back tears the socket down.
      markConnectionLoadStrained()
      resolve(requestId: requestId, result: .failure(SyncUserFacingError.error(from: SyncRequestTimeout.error(
        message: "The machine took too long to respond. Try again."
      ))))
      syncChatLog.notice(
        "request_timeout_probe_scheduled requestId=\(requestId, privacy: .public) state=\(self.connectionState.rawValue, privacy: .public) generation=\(self.connectionGeneration, privacy: .public) lastInbound=\(self.lastInboundMessageAt ?? -1, privacy: .public)"
      )
      verifyTransportAliveAfterRequestTimeout(timeoutError)
    } else {
      // The default `timeoutError` is `SyncRequestTimeout.error()`, whose
      // message says "Reconnecting now." That copy is only honest in the
      // reconnect branch above. When we explicitly do *not* tear the socket
      // down (either disconnectOnTimeout was false, or the socket has been
      // hearing inbound traffic recently and we don't want to reconnect),
      // surfacing that message lies to the user. Fall back to a non-reconnect
      // timeout message in that branch.
      let resolvedError: NSError
      if disconnectOnTimeout {
        resolvedError = SyncRequestTimeout.error(
          message: "The machine took too long to respond. Try again."
        )
      } else {
        resolvedError = timeoutError
      }
      markConnectionLoadStrained()
      syncChatLog.notice(
        "request_timeout_resolved_without_reconnect requestId=\(requestId, privacy: .public) disconnectOnTimeout=\(disconnectOnTimeout, privacy: .public) state=\(self.connectionState.rawValue, privacy: .public) generation=\(self.connectionGeneration, privacy: .public) lastInbound=\(self.lastInboundMessageAt ?? -1, privacy: .public)"
      )
      resolve(requestId: requestId, result: .failure(resolvedError))
    }
  }

  /// Active liveness check after a request timeout: ping the host and give it
  /// a short window to send anything back. Inbound traffic (the pong, a
  /// changeset, a status ping) proves the transport works and the socket is
  /// kept; total silence means the connection is actually dead and the normal
  /// transport-failure teardown runs. One probe at a time.
  private func verifyTransportAliveAfterRequestTimeout(_ timeoutError: NSError) {
    guard transportProbeTask == nil, canSendLiveRequests() else {
      syncChatLog.notice(
        "request_timeout_probe_skipped probeInFlight=\((self.transportProbeTask != nil), privacy: .public) liveRequests=\(self.canSendLiveRequests(), privacy: .public) state=\(self.connectionState.rawValue, privacy: .public) generation=\(self.connectionGeneration, privacy: .public)"
      )
      return
    }
    let generation = connectionGeneration
    let probeStartedAt = ProcessInfo.processInfo.systemUptime
    syncChatLog.notice(
      "request_timeout_probe_sent generation=\(generation, privacy: .public) state=\(self.connectionState.rawValue, privacy: .public) lastInbound=\(self.lastInboundMessageAt ?? -1, privacy: .public)"
    )
    sendEnvelope(type: "heartbeat", requestId: nil, payload: [
      "kind": "ping",
      "sentAt": ISO8601DateFormatter().string(from: Date()),
      "dbVersion": database.currentDbVersion(),
    ])
    transportProbeTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      guard let self else { return }
      self.transportProbeTask = nil
      guard !Task.isCancelled, self.connectionGeneration == generation else { return }
      if let lastInbound = self.lastInboundMessageAt, lastInbound > probeStartedAt {
        syncChatLog.notice(
          "request_timeout_probe_succeeded generation=\(generation, privacy: .public) lastInbound=\(lastInbound, privacy: .public) probeStartedAt=\(probeStartedAt, privacy: .public)"
        )
        return
      }
      syncChatLog.notice(
        "request_timeout_probe_failed generation=\(generation, privacy: .public) lastInbound=\(self.lastInboundMessageAt ?? -1, privacy: .public) probeStartedAt=\(probeStartedAt, privacy: .public)"
      )
      self.handleTransportFailure(
        timeoutError,
        connectionState: syncConnectionStateAfterRequestTimeout(
          lastInboundMessageAt: self.lastInboundMessageAt,
          fallback: .error
        )
      )
    }
  }

  private func decodeEnvelopePayload(_ envelope: [String: Any]) throws -> Any {
    let compression = envelope["compression"] as? String ?? "none"
    if compression == "gzip", let base64 = envelope["payload"] as? String, let compressed = Data(base64Encoded: base64) {
      let data = try gunzip(compressed, maxOutputBytes: maxUncompressedSyncEnvelopeBytes)
      return try JSONSerialization.jsonObject(with: data, options: [])
    }
    return envelope["payload"] ?? NSNull()
  }

  private func makeRequestId() -> String {
    "ios-\(UUID().uuidString.lowercased())"
  }

  private func ensureDatabaseReady() throws {
    if let initializationError = database.initializationError {
      throw initializationError
    }
  }

  private func decode<T: Decodable>(_ object: Any, as type: T.Type) throws -> T {
    let data = try adeJSONData(withJSONObject: object)
    return try decoder.decode(T.self, from: data)
  }

  private func sendDecodableCommand<T: Decodable>(
    action: String,
    args: [String: Any] = [:],
    disconnectOnTimeout: Bool = true,
    timeoutNanoseconds: UInt64? = nil,
    targetProjectId: String? = nil,
    targetProjectRootPath: String? = nil,
    as type: T.Type
  ) async throws -> T {
    let response = try await sendCommand(
      action: action,
      args: args,
      disconnectOnTimeout: disconnectOnTimeout,
      timeoutNanoseconds: timeoutNanoseconds,
      targetProjectId: targetProjectId,
      targetProjectRootPath: targetProjectRootPath
    )
    if let payload = response as? [String: Any], payload["queued"] as? Bool == true {
      throw QueuedRemoteCommandError(action: action)
    }
    return try decode(response, as: type)
  }

  private func encodedCommandArgs<T: Encodable>(from payload: T) throws -> [String: Any] {
    guard let args = try jsonObject(from: payload) as? [String: Any] else {
      throw NSError(domain: "ADE", code: 24, userInfo: [NSLocalizedDescriptionKey: "Invalid chat command payload."])
    }
    return args
  }

  private func sendChatCommand<T: Encodable>(action: String, payload: T) async throws -> Any {
    try await sendCommand(action: action, args: try encodedCommandArgs(from: payload))
  }

  private func sendDecodableChatCommand<T: Encodable, U: Decodable>(action: String, payload: T, as type: U.Type) async throws -> U {
    try decode(try await sendChatCommand(action: action, payload: payload), as: type)
  }

  private func jsonObject<T: Encodable>(from value: T) throws -> Any {
    let data = try encoder.encode(value)
    return try JSONSerialization.jsonObject(with: data, options: [])
  }

  private func loadPendingOperations() -> [PendingOperation] {
    guard let data = UserDefaults.standard.data(forKey: pendingOperationsKey) else { return [] }
    return (try? decoder.decode([PendingOperation].self, from: data)) ?? []
  }

  private func savePendingOperations(_ operations: [PendingOperation]) {
    if operations.isEmpty {
      UserDefaults.standard.removeObject(forKey: pendingOperationsKey)
    } else if let data = try? encoder.encode(operations) {
      UserDefaults.standard.set(data, forKey: pendingOperationsKey)
    }
    pendingOperationCount = operations.count
  }

  private func schedulePendingOperationFlush(delayNanoseconds: UInt64 = 2_000_000_000) {
    guard pendingOperationFlushTask == nil else { return }
    pendingOperationFlushTask = Task { @MainActor [weak self] in
      var nextDelay = delayNanoseconds
      while !Task.isCancelled {
        if nextDelay > 0 {
          try? await Task.sleep(nanoseconds: nextDelay)
        }
        guard let self, !Task.isCancelled else { return }
        self.pendingOperationFlushInFlight = true
        let shouldRetry = await self.flushPendingOperations()
        self.pendingOperationFlushInFlight = false
        if !shouldRetry || !self.canSendLiveRequests() {
          self.pendingOperationFlushTask = nil
          return
        }
        nextDelay = 15_000_000_000
      }
    }
  }

  private func enqueueOperation(
    kind: String,
    action: String,
    args: [String: Any],
    id: String? = nil,
    targetProjectId: String? = nil,
    targetProjectRootPath: String? = nil
  ) throws {
    guard JSONSerialization.isValidJSONObject(args) else {
      throw NSError(domain: "ADE", code: 11, userInfo: [NSLocalizedDescriptionKey: "Invalid queued operation payload."])
    }
    let payload = try adeJSONData(withJSONObject: args)
    var queued = loadPendingOperations()
    queued.append(PendingOperation(
      id: id ?? makeRequestId(),
      kind: kind,
      action: action,
      payload: payload,
      queuedAt: syncDateFormatter.string(from: Date()),
      hostId: activeHostStorageKey(),
      projectId: targetProjectId ?? activeProjectId,
      projectRootPath: targetProjectRootPath ?? activeProjectRootPath
    ))
    savePendingOperations(queued)
    if canSendLiveRequests() {
      schedulePendingOperationFlush()
    }
  }

  private func pendingOperationMatchesActiveProject(_ operation: PendingOperation) -> Bool {
    let currentHostId = activeHostStorageKey()
    let operationHostId = normalizedHostStorageKey(operation.hostId)
    if let currentHostId {
      guard operationHostId == currentHostId else { return false }
    } else if operationHostId != nil {
      return false
    }

    if operation.projectId == nil && operation.projectRootPath == nil {
      return true
    }
    if let projectId = operation.projectId, projectId == activeProjectId {
      return true
    }
    if let operationRoot = normalizedProjectRoot(operation.projectRootPath),
       let activeRoot = normalizedProjectRoot(activeProjectRootPath),
       operationRoot == activeRoot {
      return true
    }
    return false
  }

  private func decodeQueuedArgs(_ operation: PendingOperation) throws -> [String: Any] {
    let raw = try JSONSerialization.jsonObject(with: operation.payload, options: [])
    guard let dict = raw as? [String: Any] else {
      throw NSError(domain: "ADE", code: 12, userInfo: [NSLocalizedDescriptionKey: "Queued operation payload is invalid."])
    }
    return dict
  }

  private func pendingOperationMatches(_ lhs: PendingOperation, _ rhs: PendingOperation) -> Bool {
    lhs.id == rhs.id
      && lhs.kind == rhs.kind
      && lhs.action == rhs.action
      && lhs.payload == rhs.payload
  }

  private func removePendingOperation(_ operation: PendingOperation) {
    var queued = loadPendingOperations()
    if let index = queued.firstIndex(where: { pendingOperationMatches($0, operation) }) {
      queued.remove(at: index)
      savePendingOperations(queued)
    } else {
      pendingOperationCount = queued.count
    }
  }

  private func flushPendingOperationsAndScheduleRetry() {
    if pendingOperationFlushTask != nil {
      guard !pendingOperationFlushInFlight else { return }
      pendingOperationFlushTask?.cancel()
      pendingOperationFlushTask = nil
    }
    schedulePendingOperationFlush(delayNanoseconds: 0)
  }

  @discardableResult
  private func flushPendingOperations() async -> Bool {
    guard canSendLiveRequests() else { return false }
    var queued = loadPendingOperations()
    guard !queued.isEmpty else {
      pendingOperationCount = 0
      return false
    }

    while let operation = queued.first(where: pendingOperationMatchesActiveProject) {
      do {
        let args = try decodeQueuedArgs(operation)
        switch operation.kind {
        case "command":
          guard commandPolicy(for: operation.action) != nil else {
            throw NSError(domain: "ADE", code: 16, userInfo: [NSLocalizedDescriptionKey: "Queued action \(operation.action) is no longer available on this machine."])
          }
          _ = try await performCommandRequest(action: operation.action, args: args, commandId: operation.id)
        case "file":
          guard queueableFileActions.contains(operation.action) else {
            throw NSError(domain: "ADE", code: 17, userInfo: [NSLocalizedDescriptionKey: "Queued file action \(operation.action) is no longer supported."])
          }
          _ = try await performFileRequest(action: operation.action, args: args)
        default:
          throw NSError(domain: "ADE", code: 13, userInfo: [NSLocalizedDescriptionKey: "Unknown queued operation type."])
        }
        removePendingOperation(operation)
      } catch {
        lastError = SyncUserFacingError.message(for: error)
        let stillLive = canSendLiveRequests()
        if isRemoteCommandApplicationError(error) || (stillLive && !isSyncRequestTimeoutError(error)) {
          removePendingOperation(operation)
          queued = loadPendingOperations()
          continue
        }
        if !stillLive {
          connectionState = .error
        }
        if isSyncRequestTimeoutError(error) {
          verifyTransportAliveAfterRequestTimeout(error as NSError)
          return stillLive
        }
        return false
      }
      queued = loadPendingOperations()
    }
    pendingOperationCount = loadPendingOperations().count
    return false
  }

  private func performCommandRequest(
    action: String,
    args: [String: Any],
    commandId: String? = nil,
    disconnectOnTimeout: Bool = true,
    timeoutMessage: String = SyncRequestTimeout.message,
    timeoutNanoseconds: UInt64? = nil,
    targetProjectId: String? = nil,
    targetProjectRootPath: String? = nil
  ) async throws -> Any {
    guard canSendLiveRequests() else {
      throw NSError(domain: "ADE", code: 14, userInfo: [NSLocalizedDescriptionKey: "The machine is offline."])
    }
    let requestId = commandId ?? makeRequestId()
    let effectiveTimeoutNanoseconds = timeoutNanoseconds ?? SyncRequestTimeout.commandTimeoutNanoseconds(for: action)
    // `targetProjectId` lets a command create-in-place in a NON-active project
    // (mobile hub composer): the host routes the command to that project's scope
    // via the command-payload projectId without switching the phone's active
    // sync project. Defaults to the active project for every existing caller.
    let resolvedProjectId = targetProjectId ?? self.activeProjectId
    let resolvedProjectRootPath = targetProjectRootPath ?? self.activeProjectRootPath
    let raw = try await awaitResponse(
      requestId: requestId,
      disconnectOnTimeout: disconnectOnTimeout,
      timeoutMessage: timeoutMessage,
      timeoutNanoseconds: effectiveTimeoutNanoseconds
    ) {
      self.sendEnvelope(
        type: "command",
        requestId: requestId,
        payload: syncCommandEnvelopePayload(
          commandId: requestId,
          action: action,
          args: args,
          projectId: resolvedProjectId,
          projectRootPath: resolvedProjectRootPath
        )
      )
    }
    return try unwrapSyncCommandResponse(raw)
  }

  private func sendCommand(
    action: String,
    args: [String: Any],
    disconnectOnTimeout: Bool = true,
    timeoutMessage: String = SyncRequestTimeout.message,
    timeoutNanoseconds: UInt64? = nil,
    targetProjectId: String? = nil,
    targetProjectRootPath: String? = nil
  ) async throws -> Any {
    let commandId = makeRequestId()
    if canSendLiveRequests() {
      do {
        return try await performCommandRequest(
          action: action,
          args: args,
          commandId: commandId,
          disconnectOnTimeout: disconnectOnTimeout,
          timeoutMessage: timeoutMessage,
          timeoutNanoseconds: timeoutNanoseconds,
          targetProjectId: targetProjectId,
          targetProjectRootPath: targetProjectRootPath
        )
      } catch {
        let stillLive = canSendLiveRequests()
        if syncShouldQueueCommandAfterSendFailure(
          error: error,
          canSendLiveRequests: stillLive,
          queueable: commandPolicy(for: action)?.queueable == true
        ) {
          try enqueueOperation(
            kind: "command",
            action: action,
            args: args,
            id: commandId,
            targetProjectId: targetProjectId,
            targetProjectRootPath: targetProjectRootPath
          )
          if stillLive, isSyncRequestTimeoutError(error) {
            verifyTransportAliveAfterRequestTimeout(error as NSError)
          }
          return ["queued": true]
        }
        throw error
      }
    }
    guard let policy = commandPolicy(for: action) else {
      throw NSError(domain: "ADE", code: 15, userInfo: [NSLocalizedDescriptionKey: "This action is not available for the current machine. Reconnect to refresh lane capabilities."])
    }
    guard policy.queueable == true else {
      throw NSError(domain: "ADE", code: 15, userInfo: [NSLocalizedDescriptionKey: "This action requires a live connection to the machine."])
    }
    try enqueueOperation(
      kind: "command",
      action: action,
      args: args,
      targetProjectId: targetProjectId,
      targetProjectRootPath: targetProjectRootPath
    )
    return ["queued": true]
  }

  private func chatSubscriptionPayload(
    sessionId: String,
    maxBytes requestedMaxBytes: Int? = nil,
    includeSinceSeq: Bool = false
  ) -> [String: Any] {
    let defaultMaxBytes = canSendLiveRequests() && prefersReducedSyncLoad
      ? syncReducedLoadChatSubscriptionMaxBytes
      : syncChatSubscriptionMaxBytes
    let maxBytes = max(1_024, min(syncChatSubscriptionMaxBytes, requestedMaxBytes ?? defaultMaxBytes))
    var payload: [String: Any] = [
      "sessionId": sessionId,
      "maxBytes": maxBytes,
    ]
    if includeSinceSeq, let lastSeq = chatEventLastSeqBySession[sessionId] {
      payload["sinceSeq"] = lastSeq
    }
    return payload
  }

  private func restoreChatEventSubscriptions() {
    guard canSendLiveRequests(), supportsChatStreaming else { return }
    for sessionId in subscribedChatSessionIds.sorted() {
      // Pass the last applied seq so the host can replay only the missed
      // events; it falls back to a full snapshot when the gap is too old.
      let payload = chatSubscriptionPayload(sessionId: sessionId, includeSinceSeq: true)
      syncChatLog.notice(
        "chat_subscribe_restore session=\(sessionId, privacy: .public) sinceSeq=\((payload["sinceSeq"] as? Int) ?? -1, privacy: .public) maxBytes=\((payload["maxBytes"] as? Int) ?? -1, privacy: .public) reducedLoad=\(self.prefersReducedSyncLoad, privacy: .public) state=\(self.connectionState.rawValue, privacy: .public)"
      )
      sendEnvelope(
        type: "chat_subscribe",
        requestId: nil,
        payload: payload
      )
    }
  }

  private func restoreTerminalSubscriptions() {
    guard canSendLiveRequests() else { return }
    let sessionIds = subscribedTerminalSessionIds.sorted()
    guard !sessionIds.isEmpty else { return }
    Task { @MainActor [weak self] in
      guard let self else { return }
      for sessionId in sessionIds {
        self.subscribedTerminalSessionIds.remove(sessionId)
        if self.terminalStreamHandlers[sessionId] != nil {
          // Active full-screen terminal: resume exactly after the last byte we
          // applied so the reconnect back-fills as an append, not a re-render.
          try? await self.subscribeTerminalStream(
            sessionId: sessionId,
            sinceOffset: self.terminalEndOffsets[sessionId]
          )
        } else {
          try? await self.subscribeTerminal(sessionId: sessionId)
        }
      }
    }
  }

  func recordChatEventEnvelope(_ envelope: AgentChatEventEnvelope) {
    var events = chatEventEnvelopesBySession[envelope.sessionId] ?? []
    if let last = events.last {
      if canAppendChatEvent(envelope, after: last) {
        events.append(envelope)
        events = trimChatEventHistory(events)
      } else {
        guard !chatEventHistoryContainsDuplicate(envelope, in: events) else { return }
        events = insertChatEventEnvelope(envelope, into: events)
      }
    } else {
      events.append(envelope)
    }
    chatEventEnvelopesBySession[envelope.sessionId] = events
    chatEventRevisionsBySession[envelope.sessionId, default: 0] += 1
    markSyncActivity()
    updateChatTurnActiveHintFromEvent(envelope)
    markChatEventsChanged()
  }

  func replaceChatEventHistory(sessionId: String, events: [AgentChatEventEnvelope]) {
    let next = deduplicatedChatEventHistory(events)
    guard chatEventEnvelopesBySession[sessionId] != next else { return }
    chatEventEnvelopesBySession[sessionId] = next
    chatEventRevisionsBySession[sessionId, default: 0] += 1
    markSyncActivity()
    markChatEventsChanged(immediate: true)
  }

  func mergeChatEventHistory(sessionId: String, events: [AgentChatEventEnvelope]) {
    let current = chatEventEnvelopesBySession[sessionId] ?? []
    let next = deduplicatedChatEventHistory(current + events)
    guard current != next else { return }
    chatEventEnvelopesBySession[sessionId] = next
    chatEventRevisionsBySession[sessionId, default: 0] += 1
    markSyncActivity()
    markChatEventsChanged(immediate: true)
  }

  private func deduplicatedChatEventHistory(_ events: [AgentChatEventEnvelope]) -> [AgentChatEventEnvelope] {
    var seen = Set<String>()
    var unique: [AgentChatEventEnvelope] = []
    unique.reserveCapacity(events.count)
    for event in events {
      let key = chatEventHistoryDedupeKey(event)
      guard seen.insert(key).inserted else { continue }
      unique.append(event)
    }
    let sorted = unique
      .map { ChatEventSortRecord(event: $0, timestampKey: chatEventTimestampSortKey($0.timestamp)) }
      .sorted { lhs, rhs in
        compareChatEventSortRecords(lhs, rhs) == .orderedAscending
      }
      .map(\.event)
    return trimChatEventHistory(sorted)
  }

  private func chatEventHistoryContainsDuplicate(
    _ envelope: AgentChatEventEnvelope,
    in events: [AgentChatEventEnvelope]
  ) -> Bool {
    if events.contains(where: { $0.id == envelope.id }) {
      return true
    }
    guard let key = chatEventContentDedupeKey(envelope) else {
      return false
    }
    return events.contains { chatEventContentDedupeKey($0) == key }
  }

  private func insertChatEventEnvelope(
    _ envelope: AgentChatEventEnvelope,
    into events: [AgentChatEventEnvelope]
  ) -> [AgentChatEventEnvelope] {
    var next = events
    let index = chatEventInsertionIndex(for: envelope, in: next)
    next.insert(envelope, at: index)
    return trimChatEventHistory(next)
  }

  private func chatEventInsertionIndex(
    for envelope: AgentChatEventEnvelope,
    in events: [AgentChatEventEnvelope]
  ) -> Int {
    var low = events.startIndex
    var high = events.endIndex
    while low < high {
      let mid = low + (high - low) / 2
      if compareChatEvents(events[mid], envelope) == .orderedDescending {
        high = mid
      } else {
        low = mid + 1
      }
    }
    return low
  }

  private func chatEventHistoryDedupeKey(_ envelope: AgentChatEventEnvelope) -> String {
    if let contentKey = chatEventContentDedupeKey(envelope) {
      return contentKey
    }
    return envelope.id
  }

  private func chatEventContentDedupeKey(_ envelope: AgentChatEventEnvelope) -> String? {
    switch envelope.event {
    case .text(let text, let messageId, let turnId, let itemId):
      let normalizedText = text.trimmingCharacters(in: .whitespacesAndNewlines)
      guard normalizedText.count >= 24 else { return nil }
      let normalizedTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let normalizedItemId = itemId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let normalizedMessageId = messageId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let stableMessageId = normalizedItemId.isEmpty ? normalizedMessageId : normalizedItemId
      guard !normalizedTurnId.isEmpty || !stableMessageId.isEmpty else { return nil }
      return [
        envelope.sessionId,
        "text",
        normalizedTurnId,
        stableMessageId,
        normalizedText
      ].joined(separator: "|")
    case .userMessage(let text, _, let turnId, let steerId, let deliveryState, let processed):
      let normalizedTurnId = turnId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      let normalizedSteerId = steerId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard !normalizedTurnId.isEmpty || !normalizedSteerId.isEmpty else { return nil }
      return [
        envelope.sessionId,
        "user_message",
        normalizedTurnId,
        normalizedSteerId,
        deliveryState ?? "",
        processed.map { $0 ? "1" : "0" } ?? "",
        text.trimmingCharacters(in: .whitespacesAndNewlines)
      ].joined(separator: "|")
    default:
      return nil
    }
  }

  private struct ChatEventSortRecord {
    let event: AgentChatEventEnvelope
    let timestampKey: String
  }

  private func compareChatEventSortRecords(
    _ lhs: ChatEventSortRecord,
    _ rhs: ChatEventSortRecord
  ) -> ComparisonResult {
    if lhs.event.timestamp == rhs.event.timestamp {
      return compareChatEventSequence(lhs.event.sequence, rhs.event.sequence)
    }
    let timestampOrder = lhs.timestampKey.compare(rhs.timestampKey)
    if timestampOrder != .orderedSame { return timestampOrder }
    return compareChatEventSequence(lhs.event.sequence, rhs.event.sequence)
  }

  private func canAppendChatEvent(_ envelope: AgentChatEventEnvelope, after last: AgentChatEventEnvelope) -> Bool {
    if let lastSequence = last.sequence,
       let envelopeSequence = envelope.sequence,
       envelopeSequence <= lastSequence {
      return false
    }

    if envelope.timestamp > last.timestamp {
      return true
    }
    if envelope.timestamp == last.timestamp {
      return (envelope.sequence ?? 0) >= (last.sequence ?? 0)
    }

    return compareChatEvents(last, envelope) != .orderedDescending
  }

  private func compareChatEvents(
    _ lhs: AgentChatEventEnvelope,
    _ rhs: AgentChatEventEnvelope
  ) -> ComparisonResult {
    if lhs.timestamp == rhs.timestamp {
      return compareChatEventSequence(lhs.sequence, rhs.sequence)
    }
    let timestampOrder = chatEventTimestampSortKey(lhs.timestamp).compare(chatEventTimestampSortKey(rhs.timestamp))
    if timestampOrder != .orderedSame { return timestampOrder }
    return compareChatEventSequence(lhs.sequence, rhs.sequence)
  }

  private func chatEventTimestampSortKey(_ raw: String) -> String {
    guard raw.hasSuffix("Z") else { return raw }
    let withoutZone = raw.dropLast()
    guard let dotIndex = withoutZone.lastIndex(of: ".") else {
      return "\(withoutZone).000000000Z"
    }
    let prefix = withoutZone[..<dotIndex]
    let fractionStart = withoutZone.index(after: dotIndex)
    let fraction = String(withoutZone[fractionStart...].prefix(9))
    let paddedFraction = fraction + String(repeating: "0", count: max(0, 9 - fraction.count))
    return "\(prefix).\(paddedFraction)Z"
  }

  private func compareChatEventSequence(_ lhs: Int?, _ rhs: Int?) -> ComparisonResult {
    let left = lhs ?? 0
    let right = rhs ?? 0
    if left == right { return .orderedSame }
    return left < right ? .orderedAscending : .orderedDescending
  }

  private func trimChatEventHistory(_ events: [AgentChatEventEnvelope]) -> [AgentChatEventEnvelope] {
    guard events.count > chatEventHistoryMaxEvents else { return events }
    return Array(events.suffix(chatEventHistoryMaxEvents))
  }

  private func trimmedTerminalBuffer(_ buffer: String) -> String {
    guard buffer.count > syncTerminalBufferMaxCharacters else { return buffer }
    return String(buffer.suffix(syncTerminalBufferMaxCharacters))
  }

  private func updateTerminalBuffer(sessionId: String, transcript: String, immediate: Bool = false) {
    let nextBuffer = trimmedTerminalBuffer(transcript)
    guard terminalBuffers[sessionId] != nextBuffer else {
      terminalBufferUpdatedAt[sessionId] = Date()
      return
    }
    terminalBuffers[sessionId] = nextBuffer
    terminalBufferUpdatedAt[sessionId] = Date()
    markTerminalBufferChanged(sessionId: sessionId, immediate: immediate)
  }

  private func markTerminalBufferChanged(sessionId: String, immediate: Bool = false) {
    terminalBufferRevisionsBySessionId[sessionId, default: 0] += 1
    markTerminalBufferChanged(immediate: immediate)
  }

  private func markTerminalBufferChanged(immediate: Bool = false) {
    if immediate {
      terminalBufferRevisionTask?.cancel()
      terminalBufferRevisionTask = nil
      terminalBufferRevision += 1
      return
    }

    guard terminalBufferRevisionTask == nil else { return }
    terminalBufferRevisionTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 120_000_000)
      guard let self, !Task.isCancelled else { return }
      self.terminalBufferRevision += 1
      self.terminalBufferRevisionTask = nil
    }
  }

  /// The single place the chat-event revision advances — keeps the
  /// leading-edge timestamp and the published counter in lockstep.
  private func bumpChatEventRevision() {
    lastChatEventRevisionBumpAt = Date()
    chatEventNotificationRevision += 1
  }

  private func markChatEventsChanged(immediate: Bool = false) {
    if immediate {
      chatEventRevisionTask?.cancel()
      chatEventRevisionTask = nil
      bumpChatEventRevision()
      return
    }

    guard chatEventRevisionTask == nil else { return }
    // Leading edge: the first event after a quiet period surfaces now instead
    // of waiting out the coalescing window — streaming starts rendering the
    // moment the first delta lands.
    if Date().timeIntervalSince(lastChatEventRevisionBumpAt) >= chatEventNotificationCoalesceSeconds {
      bumpChatEventRevision()
      return
    }
    chatEventRevisionTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: chatEventNotificationCoalesceNanoseconds)
      guard let self, !Task.isCancelled else { return }
      self.bumpChatEventRevision()
      self.chatEventRevisionTask = nil
    }
  }

  private func resetChatEventState(clearHistory: Bool) {
    // GitHub PR items are repo-scoped to the active project; drop them so a
    // project switch / reconnect re-fetches against the new repo instead of
    // tagging lanes with another project's PRs.
    laneGithubPrItems = []
    laneGithubPrItemsFetchedAt = nil
    subscribedChatSessionIds.removeAll()
    // Turn-active hints are scoped to the live connection's event stream —
    // a stale "running" hint must not survive a project switch or reconnect.
    chatTurnActiveHintBySession.removeAll()
    if clearHistory {
      chatEventEnvelopesBySession.removeAll()
      chatEventRevisionsBySession.removeAll()
      // Watermarks are only meaningful while the applied history is retained;
      // resuming from a seq after dropping history would skip those events.
      chatEventLastSeqBySession.removeAll()
    }
    markChatEventsChanged(immediate: true)
    localStateRevision += 1
  }

  private func resetTerminalSubscriptionState(clearHistory: Bool) {
    if clearHistory {
      subscribedTerminalSessionIds.removeAll()
      terminalBuffers.removeAll()
      terminalBufferUpdatedAt.removeAll()
      terminalBufferRevisionsBySessionId.removeAll()
      terminalEndOffsets.removeAll()
      terminalGapRecoveryInFlight.removeAll()
    }
    terminalBufferRevision += 1
  }

  private func performInitialHydration(for connectionGeneration: UInt64) async {
    guard isCurrentConnectionGeneration(connectionGeneration),
          connectionState == .connected || connectionState == .syncing
    else { return }

    if activeProjectId == nil {
      refreshProjectCatalog()
    }

    setDomainStatus(SyncDomain.allCases, phase: .syncingInitialData)

    do {
      try ensureActiveProjectCacheRowForHydration()
      try await InitialHydrationGate.waitForProjectRow(
        currentProjectId: {
          guard let activeProjectId = self.activeProjectId else {
            let cachedProjects = self.database.listMobileProjects().filter { !self.isProjectHidden($0) }
            guard cachedProjects.count == 1, let onlyProject = cachedProjects.first else {
              return nil
            }
            if self.supportsProjectCatalog {
              guard self.remoteProjectCatalog.count == 1,
                    self.remoteProjectCatalog.first?.id == onlyProject.id else {
                return nil
              }
            }
            return onlyProject.id
          }
          return self.database.hasProject(id: activeProjectId) ? activeProjectId : nil
        },
        shouldContinue: { self.isCurrentConnectionGeneration(connectionGeneration) }
      )
    } catch is CancellationError {
      return
    } catch {
      guard isCurrentConnectionGeneration(connectionGeneration) else { return }
      let friendlyMessage = SyncUserFacingError.message(for: error)
      lastError = friendlyMessage
      if connectionState == .disconnected || connectionState == .error {
        setDomainStatus(SyncDomain.allCases, phase: .disconnected)
      } else {
        setDomainStatus(SyncDomain.allCases, phase: .failed, error: friendlyMessage)
      }
      return
    }

    guard isCurrentConnectionGeneration(connectionGeneration) else { return }
    if activeProjectId == nil {
      let cachedProjects = database.listMobileProjects().filter { !isProjectHidden($0) }
      if cachedProjects.count == 1, let onlyProject = cachedProjects.first {
        if supportsProjectCatalog {
          guard remoteProjectCatalog.count == 1,
                remoteProjectCatalog.first?.id == onlyProject.id else {
            refreshProjectCatalog()
            return
          }
        }
        setActiveProjectId(onlyProject.id, rootPath: onlyProject.rootPath)
      } else {
        refreshProjectCatalog()
        return
      }
    }
    refreshProjectCatalog()
    do {
      try await refreshLaneSnapshots()
    } catch {
      guard isCurrentConnectionGeneration(connectionGeneration) else { return }
      lastError = SyncUserFacingError.message(for: error)
    }

    guard isCurrentConnectionGeneration(connectionGeneration) else { return }
    do {
      try await refreshWorkSessions()
    } catch {
      guard isCurrentConnectionGeneration(connectionGeneration) else { return }
      lastError = SyncUserFacingError.message(for: error)
    }

    guard isCurrentConnectionGeneration(connectionGeneration) else { return }
    do {
      try await refreshPullRequestSnapshots()
    } catch {
      guard isCurrentConnectionGeneration(connectionGeneration) else { return }
      lastError = SyncUserFacingError.message(for: error)
    }
  }

  private func setDomainStatus(_ domains: [SyncDomain], phase: SyncDomainPhase, error: String? = nil) {
    let hydratedAt = phase == .ready ? Date() : nil
    for domain in domains {
      var next = domainStatuses[domain] ?? .disconnected
      next.phase = phase
      next.lastError = error
      if let hydratedAt {
        next.lastHydratedAt = hydratedAt
      }
      domainStatuses[domain] = next
    }
  }

  private func performFileRequest(action: String, args: [String: Any]) async throws -> Any {
    guard canSendLiveRequests() else {
      throw NSError(domain: "ADE", code: 16, userInfo: [NSLocalizedDescriptionKey: "The machine is offline."])
    }
    let requestId = makeRequestId()
    let raw = try await awaitResponse(requestId: requestId) {
      self.sendEnvelope(type: "file_request", requestId: requestId, payload: [
        "action": action,
        "args": args,
      ])
    }
    if let response = raw as? [String: Any], let ok = response["ok"] as? Bool, ok == false {
      let message = (response["error"] as? [String: Any])?["message"] as? String ?? "File request failed."
      throw NSError(domain: "ADE", code: 8, userInfo: [NSLocalizedDescriptionKey: message])
    }
    if let response = raw as? [String: Any], let result = response["result"] {
      return result
    }
    return raw
  }

  private func sendFileRequest(action: String, args: [String: Any]) async throws -> Any {
    if canSendLiveRequests() {
      return try await performFileRequest(action: action, args: args)
    }
    guard queueableFileActions.contains(action) else {
      throw NSError(domain: "ADE", code: 17, userInfo: [NSLocalizedDescriptionKey: "This file action requires a live connection to the machine."])
    }
    try enqueueOperation(kind: "file", action: action, args: args)
    return ["queued": true]
  }
}

// MARK: - Remote commands (WS6)

/// Kinds of remote commands the iOS client sends to the ADE brain.
///
/// Each case maps to a verb on the desktop `syncRemoteCommandService` and the
/// action switch inside `SyncService.sendRemoteCommand(_:payload:)`.
enum RemoteCommandKind: String, Sendable {
  case approveSession
  case denySession
  case restartSession
  case retryPrChecks
  /// Ask the paired desktop to open an `ade://...` deep link locally.
  /// Used when iOS encounters a link it can't render itself (lane, repo
  /// branch, owner/repo PR) and the user wants to bounce it to their Mac.
  case openDeeplink
}

extension SyncService {

  /// Dispatch a remote command over the existing sync WebSocket. Used by:
  ///   • in-app Attention Drawer App Intents
  ///   • "Send to Mac" deep-link handoff
  ///
  /// The caller supplies a loosely-typed payload so action-specific fields
  /// (sessionId, prNumber, url, ...) can be forwarded without defining one
  /// envelope per variant.
  @discardableResult
  func sendRemoteCommand(_ kind: RemoteCommandKind, payload: [String: Any]) async -> SyncRemoteCommandDelivery {
    let action: String
    switch kind {
    case .approveSession: action = "chat.approve"
    case .denySession: action = "chat.approve"
    case .restartSession: action = "chat.restart"
    case .retryPrChecks: action = "prs.rerunChecks"
    case .openDeeplink: action = "deeplinks.open"
    }

    var args: [String: Any] = [:]
    switch kind {
    case .approveSession:
      if let sessionId = payload["sessionId"] as? String { args["sessionId"] = sessionId }
      if let itemId = payload["itemId"] as? String { args["itemId"] = itemId }
      // Matches `AgentChatApprovalDecision` = "accept" | "accept_for_session" | "decline" | "cancel".
      args["decision"] = "accept"
    case .denySession:
      if let sessionId = payload["sessionId"] as? String { args["sessionId"] = sessionId }
      if let itemId = payload["itemId"] as? String { args["itemId"] = itemId }
      args["decision"] = "decline"
    case .restartSession:
      if let sessionId = payload["sessionId"] as? String { args["sessionId"] = sessionId }
    case .retryPrChecks:
      // The desktop `prs.rerunChecks` handler requires a `prId` string (the
      // internal ADE PR id). We also forward `prNumber` for logs/telemetry.
      if let prId = payload["prId"] as? String, !prId.isEmpty {
        args["prId"] = prId
      }
      if let prNumber = payload["prNumber"] as? Int {
        args["prNumber"] = prNumber
      } else if let prString = payload["prNumber"] as? String, let pr = Int(prString) {
        args["prNumber"] = pr
      }
    case .openDeeplink:
      // Desktop `deeplinks.open` expects a `url` arg — the same `ade://...`
      // string the user tapped on iOS. We pass it through verbatim so the
      // host can reuse its own router.
      guard let url = (payload["url"] as? String)?
        .trimmingCharacters(in: .whitespacesAndNewlines),
        !url.isEmpty,
        let components = URLComponents(string: url),
        let scheme = components.scheme?.lowercased(),
        scheme == "ade" ||
          (
            scheme == "https" &&
            ADEDeepLinkURLParsing.isADEWebHost(components.host) &&
            components.path == "/open"
          ) else {
        return .dropped("This ADE link is not valid.")
      }
      args["url"] = url
    }

    // For now we send via the opaque command envelope — the desktop's
    // `syncRemoteCommandService` dispatches on `action`.
    do {
      let result = try await performCommandRequestSafe(action: action, args: args)
      if let result = result as? [String: Any] {
        return SyncRemoteCommandDelivery(commandResult: result)
      }
      return .dispatched
    } catch {
      return .dropped(remoteCommandDroppedMessage(for: kind, error: error))
    }
  }

  private func remoteCommandDroppedMessage(for kind: RemoteCommandKind, error: Error) -> String {
    if error is CancellationError {
      return "This command was canceled."
    }

    let nsError = error as NSError
    if isRemoteCommandApplicationError(error) {
      let message = nsError.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
      return message.isEmpty ? "This command could not be sent." : message
    }

    if connectionState.isHostUnreachable || nsError.domain == NSURLErrorDomain {
      return "Reconnect to your Mac and try again."
    }

    if nsError.domain == "ADE", nsError.code == 15 {
      return "Reconnect to your Mac and try again."
    }

    switch kind {
    case .openDeeplink:
      return "This ADE link could not be sent. Try again."
    default:
      return "This command could not be sent. Try again."
    }
  }

  private func performCommandRequestSafe(action: String, args: [String: Any]) async throws -> Any {
    let commandId = makeRequestId()
    if canSendLiveRequests() {
      do {
        return try await performCommandRequest(action: action, args: args, commandId: commandId)
      } catch {
        let stillLive = canSendLiveRequests()
        if syncShouldQueueCommandAfterSendFailure(
          error: error,
          canSendLiveRequests: stillLive,
          queueable: commandPolicy(for: action)?.queueable == true
        ) {
          try enqueueOperation(kind: "command", action: action, args: args, id: commandId)
          if stillLive, isSyncRequestTimeoutError(error) {
            verifyTransportAliveAfterRequestTimeout(error as NSError)
          }
          return ["queued": true]
        }
        throw error
      }
    }
    guard let policy = commandPolicy(for: action), policy.queueable == true else {
      throw NSError(domain: "ADE", code: 15, userInfo: [NSLocalizedDescriptionKey: "Offline — command dropped."])
    }
    try enqueueOperation(kind: "command", action: action, args: args, id: commandId)
    return ["queued": true]
  }

  // MARK: - Workspace snapshot debounce

  /// Push the latest chat-summary set into the LA-reconcile cache. Callers
  /// (Work list refresh, chat detail load) hand off the summaries they
  /// already have so the LA can read `modelId` and a real `lastActivityAt`
  /// without re-fetching per running session.
  func cacheChatSummaries(_ summaries: [String: AgentChatSessionSummary]) {
    chatSummaryCache = summaries
    // Chat summaries feed `lastActivityAt` / `modelId` into the LA roster, so
    // a refreshed cache must trigger a snapshot recompute. Otherwise widgets
    // and live activities keep showing the stale model id / elapsed timer
    // until the next session-list refresh.
    refreshActiveSessionsAndSnapshot()
  }

  func cacheChatSummary(_ summary: AgentChatSessionSummary) {
    chatSummaryCache[summary.sessionId] = summary
    refreshActiveSessionsAndSnapshot()
  }

  /// Recompute `activeSessions` from the local `TerminalSessionSummary` roster
  /// and schedule a debounced snapshot write so widgets + live activities pick
  /// up the delta.
  func refreshActiveSessionsAndSnapshot() {
    let sessions = database.fetchSessions()
    let now = Date()

    // `activeSessions` holds every relevant chat session — running,
    // awaiting-input, idle, and failed. The widget reads the running subset
    // while the in-app Attention Drawer still gets the full set. Non-chat
    // (shell / CLI) sessions are excluded entirely.
    // Completed / ended sessions are dropped since they're terminal.
    var allAgents: [AgentSnapshot] = []
    var runningAgents: [AgentSnapshot] = []
    var runningChatCount = 0
    var awaitingInputCount = 0
    var idleCount = 0

    // The lock-screen widget should only surface chats actively streaming
    // output right now. Anything older than this gate is dropped from the
    // running roster, but can still appear in the in-app Attention Drawer via
    // `allAgents`.
    let runningRecencyCutoff = now.addingTimeInterval(-120)

    for session in sessions {
      let isChat = (session.toolType?.contains("chat") == true)
      guard isChat else { continue }
      guard session.archivedAt == nil else { continue }

      let status = session.status.lowercased()
      let isFailedStatus = status == "failed" || status == "error"
      guard status != "completed" && status != "ended" || isFailedStatus else {
        continue
      }

      let runtime = session.runtimeState.lowercased()
      let isAwaiting = runtime == "waiting-input" || status == "awaiting_input"
      let isRunningRuntime = runtime == "running"
      let isIdleRuntime = runtime == "idle"
      let isEndedRuntime = runtime == "exited" || runtime == "killed" || runtime == "stopped"

      if isEndedRuntime && !isFailedStatus && !isAwaiting { continue }
      if isRunningRuntime && !isFailedStatus { runningChatCount += 1 }

      let started = parseIso8601(session.startedAt) ?? now
      // For active sessions there is no `endedAt`. Use the chat summary's
      // `lastActivityAt` when available; fall back to `chatIdleSinceAt`. If
      // neither is set yet, treat a running session as fresh by falling back
      // to `now` — otherwise the recency gate below (`>= runningRecencyCutoff`)
      // would drop long-lived chats whose `startedAt` was hours/days ago even
      // while they're still streaming output. Idle / awaiting sessions still
      // get filtered out by their runtime state, so this fallback only
      // affects the running roster when activity timestamps are missing.
      let summary = chatSummaryCache[session.id]
      let lastActivity =
        parseIso8601(summary?.lastActivityAt ?? "")
        ?? parseIso8601(session.endedAt ?? "")
        ?? parseIso8601(session.chatIdleSinceAt ?? "")
        ?? (isRunningRuntime ? now : started)
      let elapsed = Int(max(0, lastActivity.timeIntervalSince(started)))

      let resolvedModelId: String? = {
        if let id = summary?.modelId, !id.isEmpty { return id }
        if let m = summary?.model, !m.isEmpty { return m }
        return nil
      }()
      let snap = AgentSnapshot(
        sessionId: session.id,
        provider: session.toolType ?? "claude",
        modelId: resolvedModelId,
        laneName: session.laneName.isEmpty ? nil : session.laneName,
        title: session.title.isEmpty ? session.goal : session.title,
        status: isFailedStatus ? "failed" : (isRunningRuntime ? "running" : (isIdleRuntime ? "idle" : status)),
        awaitingInput: isAwaiting,
        lastActivityAt: lastActivity,
        elapsedSeconds: elapsed,
        preview: session.lastOutputPreview,
        pendingInputItemId: isAwaiting ? (session.pendingInputItemId ?? pendingInputItemIdForSnapshot(sessionId: session.id)) : nil,
        progress: nil,
        phase: nil,
        toolCalls: 0
      )

      allAgents.append(snap)

      if isFailedStatus {
        continue
      }

      // LA roster: ONLY truly streaming chats (runtime == running and seen
      // recently). Idle / awaiting / stale-running drop out entirely so the
      // lock screen never shows a session that isn't producing output now.
      if isRunningRuntime && lastActivity >= runningRecencyCutoff {
        runningAgents.append(snap)
      } else if isAwaiting {
        awaitingInputCount += 1
      } else if isIdleRuntime {
        idleCount += 1
      }
    }

    let nextSignature = activeSessionsSignature(
      agents: allAgents,
      awaitingInputCount: awaitingInputCount,
      runningChatCount: runningChatCount,
      idleCount: idleCount
    )
    guard nextSignature != activeSessionsSnapshotSignature else { return }
    activeSessionsSnapshotSignature = nextSignature

    activeSessions = allAgents
    awaitingInputSessionsCount = awaitingInputCount
    runningChatSessionCount = runningChatCount
    idleSessionsCount = idleCount

    scheduleWorkspaceSnapshotWrite()
  }

  private func activeSessionsSignature(
    agents: [AgentSnapshot],
    awaitingInputCount: Int,
    runningChatCount: Int,
    idleCount: Int
  ) -> Int {
    var hasher = Hasher()
    hasher.combine(agents.count)
    hasher.combine(awaitingInputCount)
    hasher.combine(runningChatCount)
    hasher.combine(idleCount)
    for agent in agents {
      hasher.combine(agent.sessionId)
      hasher.combine(agent.provider)
      hasher.combine(agent.modelId)
      hasher.combine(agent.laneName)
      hasher.combine(agent.title)
      hasher.combine(agent.status)
      hasher.combine(agent.awaitingInput)
      hasher.combine(agent.lastActivityAt.timeIntervalSince1970)
      hasher.combine(agent.elapsedSeconds)
      hasher.combine(agent.preview)
      hasher.combine(agent.pendingInputItemId)
      hasher.combine(agent.progress)
      hasher.combine(agent.phase)
      hasher.combine(agent.toolCalls)
    }
    return hasher.finalize()
  }

  private func pendingInputItemIdForSnapshot(sessionId: String) -> String? {
    let events = chatEventEnvelopesBySession[sessionId] ?? []
    guard !events.isEmpty else { return nil }
    let transcript = makeWorkChatTranscript(from: events)
    return derivePendingWorkInputs(from: transcript).last?.itemId
  }

  /// Debounced writer for the App Group `WorkspaceSnapshot`. Bounces for 2s
  /// so bursty sync traffic collapses into a single widget-timeline reload.
  private func scheduleWorkspaceSnapshotWrite() {
    snapshotDebouncerTask?.cancel()
    snapshotDebouncerTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 2_000_000_000)
      guard let self, !Task.isCancelled else { return }
      self.writeWorkspaceSnapshotNow()
    }
  }

  private func writeWorkspaceSnapshotNow() {
    let prs: [PrSnapshot] = database.fetchPullRequestListItems().prefix(12).map { item in
      PrSnapshot(
        id: item.id,
        number: item.githubPrNumber,
        title: item.title,
        checks: item.checksStatus,
        review: item.reviewStatus,
        state: item.state,
        mergeReady: (item.reviewStatus == "approved") && (item.checksStatus == "passing") && item.state == "open",
        branch: item.headBranch.isEmpty ? nil : item.headBranch,
        updatedAt: parseIso8601(item.updatedAt)
      )
    }

    let connection: String
    switch connectionState {
    case .connected: connection = "connected"
    case .syncing, .connecting: connection = "syncing"
    default: connection = "disconnected"
    }

    let snapshot = WorkspaceSnapshot(
      generatedAt: Date(),
      agents: activeSessions,
      prs: prs,
      connection: connection,
      awaitingInputCount: awaitingInputSessionsCount,
      idleCount: idleSessionsCount
    )

    if ADESharedContainer.writeWorkspaceSnapshot(snapshot) {
      workspaceSnapshotRevision += 1
      WidgetReloadBridge.reloadAllTimelines()
    }
  }

  private func parseIso8601(_ raw: String) -> Date? {
    guard !raw.isEmpty else { return nil }
    if let date = iso8601WithFractionalSecondsFormatter.date(from: raw) { return date }
    return iso8601Formatter.date(from: raw)
  }
}

private final class SyncTailnetProbe {
  var onHostsChanged: (([DiscoveredSyncHost]) -> Void)?

  private let connectionQueue = DispatchQueue(label: "com.ade.sync.tailnet-probe")
  private var probeTask: Task<Void, Never>?

  func start() {
    guard probeTask == nil else { return }
    probeTask = Task { [weak self] in
      while !Task.isCancelled {
        await self?.refresh()
        try? await Task.sleep(nanoseconds: SyncTailnetDiscoveryTiming.probeIntervalNanoseconds)
      }
    }
  }

  func stop() {
    probeTask?.cancel()
    probeTask = nil
    onHostsChanged?([])
  }

  private func refresh() async {
    var nextHosts: [String: DiscoveredSyncHost] = [:]
    for host in SyncTailnetDiscovery.hostCandidates {
      for port in SyncTailnetDiscovery.portCandidates {
        guard !Task.isCancelled else { return }
        let result = await probe(host: host, port: port)
        guard result != .unresolvedHost else { break }
        guard result == .reachable else { continue }
        let key = "\(host):\(port)"
        let routeHost = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let isTailnetRoute = syncIsTailnetDiscoveryHost(routeHost)
        nextHosts[key] = DiscoveredSyncHost(
          id: "tailnet-\(key)",
          serviceName: "ADE Tailnet \(host)",
          hostName: routeHost,
          hostIdentity: nil,
          port: port,
          addresses: isTailnetRoute ? [] : [routeHost],
          tailscaleAddress: isTailnetRoute ? routeHost : nil,
          runtimeKind: nil,
          runtimeVersion: nil,
          projectIds: [],
          projectNames: [],
          projectCount: nil,
          lastResolvedAt: ISO8601DateFormatter().string(from: Date())
        )
        break
      }
    }
    onHostsChanged?(Array(nextHosts.values))
  }

  private enum ProbeResult: Equatable {
    case reachable
    case unreachable
    case unresolvedHost
  }

  private func probe(host: String, port: Int) async -> ProbeResult {
    guard let endpointPort = NWEndpoint.Port(rawValue: UInt16(port)) else { return .unreachable }
    return await withCheckedContinuation { continuation in
      let connection = NWConnection(
        host: NWEndpoint.Host(host),
        port: endpointPort,
        using: .tcp
      )
      var completed = false
      let complete: (ProbeResult) -> Void = { result in
        guard !completed else { return }
        completed = true
        connection.stateUpdateHandler = nil
        connection.cancel()
        continuation.resume(returning: result)
      }
      connection.stateUpdateHandler = { state in
        switch state {
        case .ready:
          complete(.reachable)
        case .waiting(let error):
          if Self.probeResult(for: error) == .unresolvedHost {
            complete(.unresolvedHost)
          }
        case .failed(let error):
          complete(Self.probeResult(for: error))
        case .cancelled:
          complete(.unreachable)
        default:
          break
        }
      }
      connection.start(queue: connectionQueue)
      connectionQueue.asyncAfter(
        deadline: .now() + .nanoseconds(Int(SyncTailnetDiscoveryTiming.probeTimeoutNanoseconds))
      ) {
        complete(.unreachable)
      }
    }
  }

  private static func probeResult(for error: NWError) -> ProbeResult {
    switch error {
    case .dns:
      return .unresolvedHost
    default:
      return .unreachable
    }
  }
}

func syncDiscoveredHostFromBonjour(
  serviceKey: String,
  serviceName: String,
  serviceHostName: String?,
  servicePort: Int,
  txtRecord: [String: String],
  resolvedAddresses: [String],
  lastResolvedAt: String = ISO8601DateFormatter().string(from: Date())
) -> DiscoveredSyncHost {
  let preferredHost = txtRecord["host"]?
    .trimmingCharacters(in: .whitespacesAndNewlines)
  let fallbackServiceHost = serviceHostName
    .flatMap(syncEndpointHost)?
    .trimmingCharacters(in: CharacterSet(charactersIn: ".").union(.whitespacesAndNewlines))
  let announcedAddresses = txtRecord["addresses"]?
    .split(separator: ",")
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty } ?? []
  let announcedRouteAddresses = ([preferredHost]
    .compactMap { $0 }
    .filter { !$0.isEmpty })
    + resolvedAddresses.filter { !$0.isEmpty }
    + announcedAddresses
  let addresses = announcedRouteAddresses.isEmpty
    ? ([fallbackServiceHost].compactMap { $0 }.filter { !$0.isEmpty })
    : announcedRouteAddresses
  let port = servicePort > 0 ? servicePort : Int(txtRecord["port"] ?? "") ?? 8787
  let hostName = [txtRecord["deviceName"], serviceHostName, serviceName]
    .compactMap(syncNormalizedCommandScopeValue)
    .first ?? serviceName
  let hostIdentity = syncNormalizedCommandScopeValue(txtRecord["deviceId"])
  // Internal per-connection database/runtime identity. The discovered-host
  // list is grouped by `deviceId`/machine name instead; `siteId` is retained so
  // the selected connection can migrate older pairings and reconnect to the
  // current project port.
  let siteId = syncNormalizedCommandScopeValue(txtRecord["siteId"])
  // Optional brain/runtime label (empty string when unset on the host).
  let runtimeName = txtRecord["runtimeName"]?.trimmingCharacters(in: .whitespacesAndNewlines)
  let runtimeKind = txtRecord["runtimeKind"]?.trimmingCharacters(in: .whitespacesAndNewlines)
  let runtimeVersion = txtRecord["runtimeVersion"]?.trimmingCharacters(in: .whitespacesAndNewlines)
  let projectIds = txtRecord["projects"]?
    .split(separator: ",")
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty } ?? []
  let projectNames = txtRecord["projectNames"]?
    .split(separator: ",")
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
    .filter { !$0.isEmpty } ?? []
  let projectCount = txtRecord["projectCount"].flatMap { Int($0.trimmingCharacters(in: .whitespacesAndNewlines)) }
  let pairingPinConfigured: Bool? = txtRecord["pairingPinConfigured"]
    .map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
    .flatMap { value in
      switch value {
      case "true", "1", "yes": return true
      case "false", "0", "no": return false
      default: return nil
      }
    }
  let tailscaleDnsName = txtRecord["tailscaleDnsName"]?.trimmingCharacters(in: .whitespacesAndNewlines)
  let tailscaleIp = txtRecord["tailscaleIp"]?.trimmingCharacters(in: .whitespacesAndNewlines)
  let tailscaleAddress = [tailscaleDnsName, tailscaleIp]
    .compactMap { value -> String? in
      guard let value, !value.isEmpty, syncIsTailscaleRoute(value) else { return nil }
      return value
    }
    .first
  // Identify the visible row by the machine. The Bonjour service key remains a
  // fallback for legacy rows that do not advertise a device identity.
  let id: String
  if let hostIdentity, !hostIdentity.isEmpty {
    id = hostIdentity
  } else {
    id = serviceKey
  }
  var seen = Set<String>()
  var ordered: [String] = []
  for host in addresses where seen.insert(host).inserted {
    ordered.append(host)
  }
  let isLoopback = { (host: String) -> Bool in host == "127.0.0.1" || host == "::1" }
  let nonLoopback = ordered.filter { !isLoopback($0) }
  let loopback = ordered.filter(isLoopback)
  return DiscoveredSyncHost(
    id: id,
    serviceName: serviceName,
    hostName: hostName,
    hostIdentity: hostIdentity,
    siteId: siteId?.isEmpty == false ? siteId : nil,
    port: port,
    addresses: nonLoopback + loopback,
    tailscaleAddress: tailscaleAddress,
    runtimeName: runtimeName?.isEmpty == false ? runtimeName : nil,
    runtimeKind: runtimeKind?.isEmpty == false ? runtimeKind : nil,
    runtimeVersion: runtimeVersion?.isEmpty == false ? runtimeVersion : nil,
    projectIds: projectIds,
    projectNames: projectNames,
    projectCount: projectCount,
    pairingPinConfigured: pairingPinConfigured,
    lastResolvedAt: lastResolvedAt
  )
}

private final class SyncBonjourBrowser: NSObject, NetServiceBrowserDelegate, NetServiceDelegate {
  var onHostsChanged: (([DiscoveredSyncHost]) -> Void)?

  private let browser = NetServiceBrowser()
  private var services: [String: NetService] = [:]
  private var hosts: [String: DiscoveredSyncHost] = [:]
  private var isSearching = false
  private var shouldMaintainBrowsing = false
  private var intentionalStop = false
  private var browseRetryWorkItem: DispatchWorkItem?
  private var periodicRestartWorkItem: DispatchWorkItem?
  private var resolveRetryWorkItems: [String: DispatchWorkItem] = [:]
  private let restartAfterIntentionalStopNanoseconds: UInt64 = 250_000_000

  override init() {
    super.init()
    browser.delegate = self
    browser.includesPeerToPeer = true
  }

  func start() {
    shouldMaintainBrowsing = true
    scheduleBrowseStart(after: 0)
  }

  func stop() {
    shouldMaintainBrowsing = false
    cancelBrowseScheduling()
    cancelResolveRetries()
    intentionalStop = true
    browser.stop()
    services.values.forEach { $0.stop() }
    services.removeAll()
    hosts.removeAll()
    isSearching = false
    publish()
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
    let key = serviceKey(for: service)
    cancelResolveRetry(forKey: key)
    services[key]?.stop()
    services[key] = service
    service.delegate = self
    service.resolve(withTimeout: SyncBonjourTiming.resolveTimeout)
    service.startMonitoring()
    schedulePeriodicRestart()
    if !moreComing {
      publish()
    }
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didRemove service: NetService, moreComing: Bool) {
    let key = serviceKey(for: service)
    cancelResolveRetry(forKey: key)
    services.removeValue(forKey: key)
    hosts.removeValue(forKey: key)
    if !moreComing {
      publish()
    }
  }

  func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String : NSNumber]) {
    isSearching = false
    cancelPeriodicRestart()
    if intentionalStop {
      intentionalStop = false
      return
    }
    scheduleBrowseStart(after: SyncBonjourTiming.searchRetryNanoseconds)
  }

  func netServiceBrowserDidStopSearch(_ browser: NetServiceBrowser) {
    isSearching = false
    cancelPeriodicRestart()
    if intentionalStop {
      intentionalStop = false
      guard shouldMaintainBrowsing else { return }
      scheduleBrowseStart(after: restartAfterIntentionalStopNanoseconds)
      return
    }
    scheduleBrowseStart(after: SyncBonjourTiming.searchRetryNanoseconds)
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    cancelResolveRetry(forKey: serviceKey(for: sender))
    updateHost(from: sender)
  }

  func netService(_ sender: NetService, didUpdateTXTRecord data: Data) {
    cancelResolveRetry(forKey: serviceKey(for: sender))
    updateHost(from: sender)
  }

  func netService(_ sender: NetService, didNotResolve errorDict: [String : NSNumber]) {
    hosts.removeValue(forKey: serviceKey(for: sender))
    publish()
    scheduleResolveRetry(for: sender)
  }

  private func scheduleBrowseStart(after delayNanoseconds: UInt64) {
    cancelBrowseRetry()
    guard shouldMaintainBrowsing else { return }

    let workItem = DispatchWorkItem { [weak self] in
      self?.beginBrowsing()
    }
    browseRetryWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + .nanoseconds(Int(delayNanoseconds)), execute: workItem)
  }

  private func beginBrowsing() {
    guard shouldMaintainBrowsing, !isSearching else { return }
    intentionalStop = false
    isSearching = true
    browser.searchForServices(ofType: "_ade-sync._tcp.", inDomain: "local.")
    schedulePeriodicRestart()
  }

  private func restartBrowsing() {
    guard shouldMaintainBrowsing else { return }
    cancelResolveRetries()
    services.values.forEach { $0.stop() }
    services.removeAll()

    guard isSearching else {
      scheduleBrowseStart(after: 0)
      return
    }

    intentionalStop = true
    browser.stop()
  }

  private func schedulePeriodicRestart() {
    cancelPeriodicRestart()
    guard shouldMaintainBrowsing else { return }

    let workItem = DispatchWorkItem { [weak self] in
      self?.restartBrowsing()
    }
    periodicRestartWorkItem = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + .nanoseconds(Int(SyncBonjourTiming.periodicRestartNanoseconds)), execute: workItem)
  }

  private func cancelBrowseRetry() {
    browseRetryWorkItem?.cancel()
    browseRetryWorkItem = nil
  }

  private func cancelPeriodicRestart() {
    periodicRestartWorkItem?.cancel()
    periodicRestartWorkItem = nil
  }

  private func cancelBrowseScheduling() {
    cancelBrowseRetry()
    cancelPeriodicRestart()
  }

  private func scheduleResolveRetry(for service: NetService) {
    let key = serviceKey(for: service)
    cancelResolveRetry(forKey: key)
    guard shouldMaintainBrowsing, services[key] != nil else { return }

    let workItem = DispatchWorkItem { [weak self, weak service] in
      guard let self, let service, self.shouldMaintainBrowsing, self.services[key] === service else { return }
      service.delegate = self
      service.resolve(withTimeout: SyncBonjourTiming.resolveTimeout)
    }
    resolveRetryWorkItems[key] = workItem
    DispatchQueue.main.asyncAfter(deadline: .now() + .nanoseconds(Int(SyncBonjourTiming.resolveRetryNanoseconds)), execute: workItem)
  }

  private func cancelResolveRetry(forKey key: String) {
    resolveRetryWorkItems[key]?.cancel()
    resolveRetryWorkItems.removeValue(forKey: key)
  }

  private func cancelResolveRetries() {
    resolveRetryWorkItems.values.forEach { $0.cancel() }
    resolveRetryWorkItems.removeAll()
  }

  private func updateHost(from service: NetService) {
    let key = serviceKey(for: service)
    guard let host = makeHost(from: service) else { return }
    hosts[key] = host
    if host.addresses.isEmpty && host.tailscaleAddress == nil {
      scheduleResolveRetry(for: service)
    }
    publish()
  }

  private func publish() {
    onHostsChanged?(Array(hosts.values))
  }

  private func serviceKey(for service: NetService) -> String {
    "\(service.domain)|\(service.type)|\(service.name)"
  }

  private func makeHost(from service: NetService) -> DiscoveredSyncHost? {
    let txtRecord = decodedTxtRecord(from: service)
    let resolvedAddresses = service.addresses?
      .compactMap(parseHost(from:))
      .filter { !$0.isEmpty } ?? []
    let sk = serviceKey(for: service)
    return syncDiscoveredHostFromBonjour(
      serviceKey: sk,
      serviceName: service.name,
      serviceHostName: service.hostName,
      servicePort: service.port,
      txtRecord: txtRecord,
      resolvedAddresses: resolvedAddresses
    )
  }

  private func decodedTxtRecord(from service: NetService) -> [String: String] {
    guard let data = service.txtRecordData() else { return [:] }
    let raw = NetService.dictionary(fromTXTRecord: data)
    return raw.reduce(into: [:]) { partialResult, entry in
      partialResult[entry.key] = String(data: entry.value, encoding: .utf8)
    }
  }

  private func parseHost(from addressData: Data) -> String? {
    var hostBuffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
    let result = addressData.withUnsafeBytes { rawBuffer -> Int32 in
      guard let sockaddrPointer = rawBuffer.baseAddress?.assumingMemoryBound(to: sockaddr.self) else {
        return EAI_FAIL
      }
      return getnameinfo(
        sockaddrPointer,
        socklen_t(addressData.count),
        &hostBuffer,
        socklen_t(hostBuffer.count),
        nil,
        0,
        NI_NUMERICHOST
      )
    }
    guard result == 0 else { return nil }
    let host = String(cString: hostBuffer)
    if host.hasPrefix("fe80:") || host == "::1" {
      return nil
    }
    return host
  }
}

private func gzip(_ data: Data) -> Data {
  guard !data.isEmpty else { return data }

  var stream = z_stream()
  let chunkSize = 16_384
  var output = Data()
  var status: Int32 = Z_OK

  let initStatus = deflateInit2_(
    &stream,
    Z_DEFAULT_COMPRESSION,
    Z_DEFLATED,
    MAX_WBITS + 16,
    8,
    Z_DEFAULT_STRATEGY,
    ZLIB_VERSION,
    Int32(MemoryLayout<z_stream>.size)
  )
  guard initStatus == Z_OK else { return data }
  defer { deflateEnd(&stream) }

  data.withUnsafeBytes { rawBuffer in
    stream.next_in = UnsafeMutablePointer<Bytef>(mutating: rawBuffer.bindMemory(to: Bytef.self).baseAddress)
    stream.avail_in = uint(data.count)

    repeat {
      var chunk = [UInt8](repeating: 0, count: chunkSize)
      chunk.withUnsafeMutableBytes { chunkBuffer in
        stream.next_out = chunkBuffer.bindMemory(to: Bytef.self).baseAddress
        stream.avail_out = uint(chunkSize)
        status = deflate(&stream, Z_FINISH)
        let produced = chunkSize - Int(stream.avail_out)
        if produced > 0, let baseAddress = chunkBuffer.bindMemory(to: UInt8.self).baseAddress {
          output.append(baseAddress, count: produced)
        }
      }
    } while status == Z_OK
  }

  return status == Z_STREAM_END ? output : data
}

private func gunzip(_ data: Data, maxOutputBytes: Int = maxUncompressedSyncEnvelopeBytes) throws -> Data {
  guard !data.isEmpty else { return data }

  var stream = z_stream()
  var status: Int32 = Z_OK
  var output = Data()
  let chunkSize = 16_384

  data.withUnsafeBytes { rawBuffer in
    stream.next_in = UnsafeMutablePointer<Bytef>(mutating: rawBuffer.bindMemory(to: Bytef.self).baseAddress)
    stream.avail_in = uint(data.count)
  }

  status = inflateInit2_(&stream, MAX_WBITS + 32, ZLIB_VERSION, Int32(MemoryLayout<z_stream>.size))
  guard status == Z_OK else {
    throw NSError(domain: "ADE", code: 9, userInfo: [NSLocalizedDescriptionKey: "Unable to start gzip decoder."])
  }
  defer { inflateEnd(&stream) }

  repeat {
    var chunk = [UInt8](repeating: 0, count: chunkSize)
    chunk.withUnsafeMutableBytes { chunkBuffer in
      stream.next_out = chunkBuffer.bindMemory(to: Bytef.self).baseAddress
      stream.avail_out = uint(chunkSize)
      status = inflate(&stream, Z_SYNC_FLUSH)
      let produced = chunkSize - Int(stream.avail_out)
      if produced > 0, let baseAddress = chunkBuffer.bindMemory(to: UInt8.self).baseAddress {
        if output.count + produced > maxOutputBytes {
          status = Z_MEM_ERROR
          return
        }
        output.append(baseAddress, count: produced)
      }
    }
  } while status == Z_OK

  guard status == Z_STREAM_END else {
    let message: String
    if status == Z_MEM_ERROR {
      message = "Decoded sync envelope exceeds \(maxOutputBytes) bytes."
    } else {
      message = "Unable to decode compressed sync payload."
    }
    throw NSError(domain: "ADE", code: 10, userInfo: [NSLocalizedDescriptionKey: message])
  }
  return output
}

// MARK: - PR auto-map (create lane from PR branch)

/// A conflict that blocks creating a lane from a PR's head branch (e.g. the
/// branch is already checked out in an existing lane/worktree). Mirrors the
/// desktop `CreateLaneFromPrBranchPreflight.blockingConflict` shape. All
/// detail fields beyond ``code``/``message`` are optional for lenient decoding.
struct PrAutoMapBlock: Decodable, Equatable {
  let code: String
  let message: String
  let laneId: String?
  let laneName: String?
  let worktreePath: String?
}

/// Resolved preflight for the create-lane-from-PR-branch (auto-map) flow.
/// Mirrors desktop `CreateLaneFromPrBranchPreflight`. Every field beyond the
/// request identity is optional so a slightly different host payload (or a
/// blocked status with missing branch info) won't throw on decode.
struct PrAutoMapPreflight: Decodable, Equatable {
  let repoOwner: String
  let repoName: String
  let githubPrNumber: Int
  let githubUrl: String
  let title: String?
  let headBranch: String?
  let headSha: String?
  let headRepoOwner: String?
  let headRepoName: String?
  let remoteBranch: String?
  let importBranchRef: String?
  let targetLaneName: String?
  let baseBranch: String?
  let canCreate: Bool
  /// "ready" | "blocked"
  let status: String
  let blockingConflict: PrAutoMapBlock?
  let blockingConflicts: [PrAutoMapBlock]?
}

/// Result of `prs.preflightCreateLaneFromPrBranch`. The host also returns
/// `lane`/`pr` (both null in preflight); only ``preflight`` is decoded.
struct PrAutoMapPreflightResult: Decodable, Equatable {
  let preflight: PrAutoMapPreflight
}

/// Result of `prs.createLaneFromPrBranch`. Decodes the resolved ``preflight``
/// and the newly created ``lane``. The host's `pr` field is intentionally not
/// decoded to avoid coupling to PrSummary; the UI refreshes the PR list after.
struct PrAutoMapCreateResult: Decodable, Equatable {
  let preflight: PrAutoMapPreflight
  let lane: LaneSummary
}

// MARK: - All-projects chat roster (mobile hub)
//
// A machine-wide projection of every project's lanes + chat sessions, pushed by
// the brain over `roster_snapshot` / `roster_delta` envelopes so the hub can
// render all projects' chats-grouped-by-lane at once without activating each
// project. This extension lives in the same file as the `rosterProjects`
// declaration so it can write the `private(set)` store. See the contract in
// `apps/desktop/src/shared/types/sync.ts` (search `SyncRoster`).
extension SyncService {
  private static let rosterCacheKey = "ade.roster.cache.v1"

  /// Subscribe to the all-projects roster once per live connection. Older hosts
  /// that don't implement the feed simply never answer, leaving `rosterSupported`
  /// false so the hub falls back to the per-project catalog (lane counts only).
  func subscribeRosterIfNeeded() {
    guard canSendLiveRequests(), !rosterSubscribed else { return }
    rosterSubscribed = true
    var payload: [String: Any] = [:]
    if let rosterSeq {
      payload["sinceSeq"] = rosterSeq
    }
    sendEnvelope(type: "roster_subscribe", requestId: nil, payload: payload)
  }

  /// Force a fresh full snapshot (used after a detected seq gap).
  func requestRosterSnapshot() {
    guard canSendLiveRequests() else { return }
    rosterSubscribed = true
    sendEnvelope(type: "roster_subscribe", requestId: nil, payload: [:])
  }

  func unsubscribeRoster() {
    guard canSendLiveRequests() else { return }
    rosterSubscribed = false
    sendEnvelope(type: "roster_unsubscribe", requestId: nil, payload: [:])
  }

  func applyRosterSnapshot(_ snapshot: RemoteRosterSnapshotPayload) {
    rosterProjects = sortRosterProjects(snapshot.projects)
    rosterSeq = snapshot.seq
    rosterSupported = true
    rosterRevision &+= 1
    schedulePersistRoster()
  }

  func applyRosterDelta(_ delta: RemoteRosterDeltaPayload) {
    rosterSupported = true
    switch rosterApplyDelta(current: rosterProjects, currentSeq: rosterSeq, delta: delta) {
    case .needsSnapshot:
      // No baseline or a seq gap — re-request a full snapshot rather than apply
      // onto an unknown baseline (mirrors the chat_event sinceSeq discipline).
      requestRosterSnapshot()
    case .dropped:
      break // duplicate / out-of-order replay
    case let .applied(projects, seq):
      rosterProjects = sortRosterProjects(projects)
      rosterSeq = seq
      rosterRevision &+= 1
      schedulePersistRoster()
    }
  }

  /// Roster entry for a catalog project, matched by id then normalized root path
  /// (the brain derives both ids from the root, but match on root as a fallback).
  func rosterProject(for project: MobileProjectSummary) -> RemoteRosterProject? {
    if let direct = rosterProjects.first(where: { $0.projectId == project.id }) {
      return direct
    }
    guard let root = normalizedProjectRoot(project.rootPath) else { return nil }
    return rosterProjects.first { normalizedProjectRoot($0.rootPath) == root }
  }

  private func sortRosterProjects(_ projects: [RemoteRosterProject]) -> [RemoteRosterProject] {
    // Attention first, then most-recently-active, then name — so the projects
    // that need the user float to the top of the hub.
    projects.sorted { lhs, rhs in
      if (lhs.attentionCount > 0) != (rhs.attentionCount > 0) {
        return lhs.attentionCount > 0
      }
      let lhsActivity = lhs.chats.compactMap { $0.lastActivityAt }.max() ?? lhs.lastOpenedAt ?? ""
      let rhsActivity = rhs.chats.compactMap { $0.lastActivityAt }.max() ?? rhs.lastOpenedAt ?? ""
      if lhsActivity != rhsActivity {
        return lhsActivity > rhsActivity
      }
      return lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
    }
  }

  // MARK: Persistence (App Group UserDefaults — instant offline hub render)

  private func schedulePersistRoster() {
    rosterPersistTask?.cancel()
    let snapshot = rosterProjects
    rosterPersistTask = Task { @MainActor [weak self] in
      try? await Task.sleep(nanoseconds: 600_000_000)
      guard let self, !Task.isCancelled else { return }
      self.persistRoster(snapshot)
    }
  }

  private func persistRoster(_ projects: [RemoteRosterProject]) {
    guard let data = try? JSONEncoder().encode(projects) else { return }
    ADESharedContainer.defaults.set(data, forKey: Self.rosterCacheKey)
  }

  func loadCachedRoster() -> [RemoteRosterProject] {
    guard let data = ADESharedContainer.defaults.data(forKey: Self.rosterCacheKey),
          let projects = try? JSONDecoder().decode([RemoteRosterProject].self, from: data)
    else { return [] }
    return projects
  }

  /// Build the active project's roster entry from the phone's local DB (its
  /// lanes + chat/CLI sessions are already synced and authoritative). This makes
  /// the active project's hub card show real chats instantly, without depending
  /// on the cross-project roster feed (which only the active brain build serves,
  /// and which only the brain can populate for NON-active projects).
  func buildActiveProjectLocalRoster() -> RemoteRosterProject? {
    guard let projectId = activeProjectId else { return nil }
    let lanes = database.fetchLanes(includeArchived: false)
    let visibleLaneIds = Set(lanes.map(\.id))
    let scopedSessions = database.fetchSessions().filter { session in
      session.archivedAt == nil && visibleLaneIds.contains(session.laneId)
    }
    let topLevelIds = Set(scopedSessions.filter { isRosterTopLevelToolType($0.toolType) }.map(\.id))
    let visibleSessions = scopedSessions.filter { session in
      if isRosterTopLevelToolType(session.toolType) { return true }
      guard let parentId = normalizedRosterParentSessionId(session),
            topLevelIds.contains(parentId) else {
        return false
      }
      return true
    }
    let chats: [RemoteRosterChat] = visibleSessions.map { session in
      let status = rosterStatus(forSession: session)
      return RemoteRosterChat(
        id: session.id,
        laneId: session.laneId,
        chatSessionId: session.chatSessionId,
        title: session.title,
        provider: session.toolType,
        model: nil,
        toolType: session.toolType,
        status: status,
        awaitingInput: status == .awaiting,
        pinned: session.pinned,
        archived: false,
        lastActivityAt: session.endedAt ?? session.startedAt,
        preview: session.lastOutputPreview
      )
    }
    let rosterLanes: [RemoteRosterLane] = lanes.map { lane in
      RemoteRosterLane(
        id: lane.id,
        name: lane.name,
        color: lane.color,
        icon: lane.icon?.rawValue,
        laneType: lane.laneType,
        branchRef: lane.branchRef
      )
    }
    let active = activeProject
    let roster = RemoteRosterProject(
      projectId: projectId,
      rootPath: activeProjectRootPath ?? active?.rootPath,
      displayName: active?.displayName ?? "Project",
      iconDataUrl: active?.iconDataUrl,
      lastOpenedAt: active?.lastOpenedAt,
      booted: true,
      runningCount: chats.filter(\.isRunning).count,
      attentionCount: chats.filter(\.needsAttention).count,
      lanes: rosterLanes,
      chats: chats
    )
    upsertLocalRosterProject(roster)
    return roster
  }

  private func upsertLocalRosterProject(_ local: RemoteRosterProject) {
    var next = rosterProjects
    let localRoot = normalizedProjectRoot(local.rootPath)
    let existingIndex = next.firstIndex { project in
      project.projectId == local.projectId
        || (localRoot != nil && normalizedProjectRoot(project.rootPath) == localRoot)
    }

    if let existingIndex {
      let merged = mergedRosterProject(remote: next[existingIndex], local: local)
      guard next[existingIndex] != merged else { return }
      next[existingIndex] = merged
    } else {
      next.append(local)
    }

    rosterProjects = sortRosterProjects(next)
    rosterRevision &+= 1
    schedulePersistRoster()
  }

  private func mergedRosterProject(remote: RemoteRosterProject, local: RemoteRosterProject) -> RemoteRosterProject {
    var merged = remote

    var laneIds = Set(merged.lanes.map(\.id))
    for lane in local.lanes where laneIds.insert(lane.id).inserted {
      merged.lanes.append(lane)
    }

    var chatIndexById = Dictionary(uniqueKeysWithValues: merged.chats.enumerated().map { ($0.element.id, $0.offset) })
    for localChat in local.chats {
      if let index = chatIndexById[localChat.id] {
        merged.chats[index] = mergedRosterChat(remote: merged.chats[index], local: localChat)
      } else {
        chatIndexById[localChat.id] = merged.chats.count
        merged.chats.append(localChat)
      }
    }

    merged.booted = remote.booted || local.booted
    merged.runningCount = merged.chats.filter(\.isRunning).count
    merged.attentionCount = merged.chats.filter(\.needsAttention).count
    merged.chats.sort { ($0.lastActivityAt ?? "") > ($1.lastActivityAt ?? "") }
    return merged
  }

  private func mergedRosterChat(remote: RemoteRosterChat, local: RemoteRosterChat) -> RemoteRosterChat {
    var merged = remote
    let localIsAtLeastAsFresh = (local.lastActivityAt ?? "") >= (remote.lastActivityAt ?? "")

    if localIsAtLeastAsFresh {
      merged.status = local.status
      merged.awaitingInput = local.awaitingInput ?? remote.awaitingInput
      merged.pinned = local.pinned ?? remote.pinned
      merged.archived = local.archived ?? remote.archived
      merged.lastActivityAt = nonEmptyRosterString(local.lastActivityAt) ?? remote.lastActivityAt
      merged.title = nonEmptyRosterString(local.title) ?? remote.title
      merged.preview = nonEmptyRosterString(local.preview) ?? remote.preview
    }

    merged.provider = nonEmptyRosterString(remote.provider) ?? local.provider
    merged.model = nonEmptyRosterString(remote.model) ?? local.model
    merged.toolType = nonEmptyRosterString(remote.toolType) ?? local.toolType
    merged.chatSessionId = nonEmptyRosterString(remote.chatSessionId) ?? local.chatSessionId
    return merged
  }

  private func nonEmptyRosterString(_ value: String?) -> String? {
    guard let value = value?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else { return nil }
    return value
  }

  private func isRosterTopLevelToolType(_ toolType: String?) -> Bool {
    let raw = toolType?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased() ?? ""
    guard !raw.isEmpty else { return false }
    if raw == "codex-chat" || raw == "claude-chat" || raw == "opencode-chat" || raw == "cursor" {
      return true
    }
    return raw.hasSuffix("-chat")
  }

  private func normalizedRosterParentSessionId(_ session: TerminalSessionSummary) -> String? {
    let parentId = session.chatSessionId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard !parentId.isEmpty, parentId != session.id else { return nil }
    return parentId
  }

  private func rosterStatus(forSession session: TerminalSessionSummary) -> RemoteRosterChatStatus {
    let runtimeState = session.runtimeState.lowercased()
    let status = session.status.lowercased()
    if status == "awaiting-input" || status == "awaiting_input" || runtimeState == "waiting-input" {
      return .awaiting
    }
    switch runtimeState {
    case "running": return .running
    case "idle": return .idle
    case "stopped", "exited", "completed", "interrupted": return .ended
    case "failed": return .failed
    default: break
    }
    switch status {
    case "running", "active": return .running
    case "idle", "paused": return .idle
    case "failed": return .failed
    case "ended", "completed", "interrupted", "exited": return .ended
    default: return .ended
    }
  }

  /// Run a chat lifecycle action (`chat.archive` / `chat.unarchive` /
  /// `chat.delete`) on a roster chat, routing to its project — which may not be
  /// the active one — without switching the active sync project. Refreshes the
  /// roster so the row updates promptly.
  func performRosterChatAction(_ action: String, sessionId: String, project: MobileProjectSummary) async throws {
    let foreign = !isActiveProject(project)
    _ = try await sendCommand(
      action: action,
      args: ["sessionId": sessionId],
      targetProjectId: foreign ? project.id : nil,
      targetProjectRootPath: foreign ? project.rootPath : nil
    )
    requestRosterSnapshot()
  }
}
